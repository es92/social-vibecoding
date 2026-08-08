'use strict';

// #907 — local coding agents.
//
// A user runs `social-vibecoding agent run --session <id>` on their own
// machine. That process takes a LEASE on one of their dev sessions and then
// long-polls for coding turns. When the Mayor decides to dispatch a build for
// a leased session, the platform writes a TURN row instead of starting a
// worker container, hands it to the waiting laptop, and then waits for the
// result — after which the ordinary commit-upload → staging → checks →
// visuals → PR pipeline runs exactly as it does for a platform worker.
//
// Two invariants carry the whole design:
//
//   1. At most one live lease per session, and at most one live turn per
//      session. Both are enforced by unique partial indexes in the schema,
//      not by application-level checking, so two laptops racing to attach
//      can never both win.
//
//   2. A lease is only as alive as its last heartbeat. There is no
//      "disconnect" event on the internet; a laptop that sleeps mid-turn is
//      indistinguishable from one that is thinking hard. So the lease has a
//      short hard TTL that the CLI refreshes, and everything that reads a
//      lease reads it through `WHERE released_at IS NULL AND expires_at >
//      NOW()`. A lapsed lease needs no cleanup to stop being authoritative;
//      the sweeper below only tidies the rows.
//
// The platform never sees the user's Anthropic credentials. The local
// runtime authenticates to its provider itself, out of band — the platform
// sends it a prompt and gets back a commit SHA and a summary. This is the
// whole point of the feature and is not an implementation detail to be
// optimized away later.

const { EventEmitter } = require('node:events');
const log = require('./logger');
const events = require('./events');

// A lease must be refreshed every HEARTBEAT_MS; it dies LEASE_TTL_MS after
// the last successful refresh. The 4× ratio means three consecutive lost
// heartbeats (flaky cafe Wi-Fi) do not drop a session mid-turn.
const HEARTBEAT_MS = 30 * 1000;
const LEASE_TTL_MS = 120 * 1000;

// How long `GET /api/cli/agent/turns/next` holds a request open before
// answering "nothing yet". Kept under the 60s most reverse proxies use as
// their idle timeout, and under the CLI's own request deadline.
const LONG_POLL_MS = 30 * 1000;

// How long the platform waits for a laptop to pick up a queued turn before
// giving up on it. A machine that is attached but not polling (suspended,
// killed with -9 before it could detach) must not hang the user's chat.
const OFFER_TIMEOUT_MS = 90 * 1000;

// The outer bound on a single local turn. Generous — a real local build can
// legitimately take a long time — but finite, so a wedged local agent
// eventually returns the session to the user rather than pinning it busy
// forever. The watchdog in routes/sessions.js uses the same number.
const TURN_TIMEOUT_MS = 60 * 60 * 1000;

const MAX_PROGRESS_LINES = 500;
const MAX_PROGRESS_LINE_CHARS = 2000;
const MAX_LABEL_CHARS = 64;
// A scout turn's product is a whole spec document, so it gets the prompt's
// bound rather than the summary's. Matches the column's CHECK.
const MAX_SPEC_CHARS = 262144;
const RUNTIMES = Object.freeze(['claude-code']);
// 'build' writes code and hands back a commit; 'scout' is read-only and hands
// back the session's spec document. Everything downstream — the runtime's
// permission mode on the user's machine, whether a commit upload is even
// accepted, whether the staging/checks tail runs — keys off this one value.
const TURN_MODES = Object.freeze(['build', 'scout']);
const LIVE_TURN_STATUSES = Object.freeze(['queued', 'offered', 'accepted', 'running']);
const TERMINAL_TURN_STATUSES = Object.freeze([
  'declined', 'completed', 'failed', 'stopped', 'abandoned',
]);

// In-process notifier. Long-polling with a held Postgres client would burn a
// pool connection per attached laptop, which is exactly the kind of quiet
// resource leak that only shows up under load — so the poll waits on an
// EventEmitter instead and re-reads the row when woken. Deployments run one
// platform process (same assumption staging.js already makes); a second
// process would simply fall back to the poll's timeout, which is correct,
// just slower.
const bus = new EventEmitter();
// Every attached laptop parks one listener here, and a busy session can wake
// them repeatedly. The default limit of 10 would emit spurious leak warnings.
bus.setMaxListeners(0);

function turnChannel(sessionId) {
  return `turn:${Number(sessionId)}`;
}

function leaseChannel(leaseId) {
  return `lease:${String(leaseId)}`;
}

function notifyTurn(sessionId) {
  bus.emit(turnChannel(sessionId));
}

function notifyLease(leaseId) {
  bus.emit(leaseChannel(leaseId));
}

// Wait for `channel` to fire, or for `timeoutMs` to elapse, whichever comes
// first. Resolves true when woken by an event and false on timeout, so the
// caller can distinguish "something changed, re-read" from "still nothing".
function waitForSignal(channel, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (woken) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bus.removeListener(channel, onEvent);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(woken);
    };
    const onEvent = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    bus.on(channel, onEvent);
    if (signal) {
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isValidLabel(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_LABEL_CHARS
    // Display-only text that lands in a chat status line and a Settings row.
    // Control characters would let a label smuggle newlines into either.
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.trim() === value;
}

function isValidRuntime(value) {
  return RUNTIMES.includes(value);
}

function isValidMode(value) {
  return TURN_MODES.includes(value);
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// Normalize progress lines coming off the wire. The route validates types;
// this bounds sizes so a chatty runtime cannot grow the row without limit.
function normalizeProgress(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => typeof line === 'string' && line.length > 0)
    .slice(0, MAX_PROGRESS_LINES)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, MAX_PROGRESS_LINE_CHARS));
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

// The one authoritative "is a machine attached to this session right now"
// query. Everything else in the platform — the Mayor's routing decision, the
// dev-chat chip, the status endpoint — goes through this so the definition of
// "live" can never drift between surfaces.
async function activeLease(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM session_agent_leases
      WHERE session_id = $1 AND released_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function activeLeasesForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT l.*, cs.session_title, cs.branch_name, a.slug AS app_slug, a.name AS app_name
       FROM session_agent_leases l
       JOIN chat_sessions cs ON cs.id = l.session_id
       JOIN apps a ON a.id = cs.app_id
      WHERE l.user_id = $1 AND l.released_at IS NULL AND l.expires_at > NOW()
      ORDER BY l.created_at DESC
      LIMIT 50`,
    [userId]
  );
  return rows;
}

class LeaseConflictError extends Error {
  constructor(message, existing) {
    super(message);
    this.code = 'lease_held';
    this.existing = existing;
  }
}

// Attach a machine to a session.
//
// Re-attaching the SAME machine (same label + runtime) to a session it
// already holds is a refresh, not a conflict: `agent run` is expected to be
// restarted after a crash or a `Ctrl-C`, and forcing the user to wait out a
// two-minute TTL for their own laptop would be gratuitous. A DIFFERENT label
// is a genuine conflict and is refused.
async function attach(pool, { sessionId, userId, label, runtime, accessTokenId }) {
  const existing = await activeLease(pool, sessionId);
  if (existing) {
    if (existing.user_id !== userId
        || existing.label !== label
        || existing.runtime !== runtime) {
      throw new LeaseConflictError(
        'Another machine is already attached to this session.',
        existing
      );
    }
    const { rows } = await pool.query(
      `UPDATE session_agent_leases
          SET last_seen_at = NOW(),
              expires_at = NOW() + ($2 || ' milliseconds')::INTERVAL,
              access_token_id = $3
        WHERE id = $1 AND released_at IS NULL
        RETURNING *`,
      [existing.id, String(LEASE_TTL_MS), accessTokenId ?? null]
    );
    return { lease: rows[0] || existing, reattached: true };
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO session_agent_leases
         (session_id, user_id, access_token_id, label, runtime, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::INTERVAL)
       RETURNING *`,
      [sessionId, userId, accessTokenId ?? null, label, runtime, String(LEASE_TTL_MS)]
    );
    return { lease: rows[0], reattached: false };
  } catch (err) {
    // 23505 = the unique partial index fired: another machine attached in
    // the window between the SELECT above and this INSERT. Report it as the
    // conflict it is rather than as a 500.
    if (err.code === '23505') {
      throw new LeaseConflictError(
        'Another machine is already attached to this session.',
        await activeLease(pool, sessionId)
      );
    }
    throw err;
  }
}

async function heartbeat(pool, { leaseId, userId }) {
  const { rows } = await pool.query(
    `UPDATE session_agent_leases
        SET last_seen_at = NOW(),
            expires_at = NOW() + ($3 || ' milliseconds')::INTERVAL
      WHERE id = $1 AND user_id = $2
        AND released_at IS NULL AND expires_at > NOW()
      RETURNING *`,
    [leaseId, userId, String(LEASE_TTL_MS)]
  );
  return rows[0] || null;
}

// Release a lease and terminate whatever it was running.
//
// A live turn owned by a released lease is marked 'abandoned', not 'failed':
// the distinction matters because the waiting platform side re-routes an
// abandoned turn to a worker container, whereas a failed one is reported to
// the user as a failed build.
async function release(pool, { leaseId, userId, reason }) {
  const { rows } = await pool.query(
    `UPDATE session_agent_leases
        SET released_at = NOW(), release_reason = $3
      WHERE id = $1 AND ($2::INTEGER IS NULL OR user_id = $2)
        AND released_at IS NULL
      RETURNING *`,
    [leaseId, userId ?? null, reason]
  );
  const lease = rows[0] || null;
  if (!lease) return null;
  const { rows: turnRows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = 'abandoned', finished_at = NOW(), updated_at = NOW(),
            error_detail = $2
      WHERE lease_id = $1 AND status = ANY($3::TEXT[])
      RETURNING session_id`,
    [
      leaseId,
      `The local coding agent detached before finishing (${reason}).`,
      LIVE_TURN_STATUSES,
    ]
  );
  for (const row of turnRows) notifyTurn(row.session_id);
  notifyLease(leaseId);
  notifyTurn(lease.session_id);
  return lease;
}

// Revoking the credential a machine attached with takes its attachments with
// it, immediately, rather than leaving them to lapse on their own TTL.
//
// The lease is not itself a credential — every protocol request re-checks the
// bearer token, so a revoked machine could not have done anything anyway — but
// "I revoked that laptop" should mean the session visibly stops saying it is
// running there, and the next turn should go straight to a worker instead of
// waiting out an offer timeout first.
//
// Takes a client rather than the pool so it joins the caller's revocation
// transaction: a lease released against a revocation that then rolls back
// would strand a machine that is still perfectly authorized.
async function releaseLeasesForTokens(client, tokenIds) {
  const ids = (Array.isArray(tokenIds) ? tokenIds : [tokenIds]).filter((id) => id != null);
  if (!ids.length) return { released: 0, sessionIds: [] };
  const { rows } = await client.query(
    `UPDATE session_agent_leases
        SET released_at = NOW(), release_reason = 'revoked'
      WHERE access_token_id = ANY($1::BIGINT[]) AND released_at IS NULL
      RETURNING id, session_id`,
    [ids.map((id) => String(id))]
  );
  if (!rows.length) return { released: 0, sessionIds: [] };
  const { rows: turnRows } = await client.query(
    `UPDATE local_agent_turns
        SET status = 'abandoned', finished_at = NOW(), updated_at = NOW(),
            error_detail = 'The credential this machine attached with was revoked.'
      WHERE lease_id = ANY($1::BIGINT[]) AND status = ANY($2::TEXT[])
      RETURNING session_id`,
    [rows.map((r) => String(r.id)), LIVE_TURN_STATUSES]
  );
  // Notify after the caller's transaction commits — see the callers, which
  // invoke notifyReleased() outside withTransaction. Collected here so the
  // caller does not have to know the shape of the bus.
  const sessionIds = [...new Set([
    ...rows.map((r) => r.session_id),
    ...turnRows.map((r) => r.session_id),
  ])];
  return { released: rows.length, sessionIds };
}

// Wake anything waiting on the sessions a revocation just detached. Split out
// of releaseLeasesForTokens so it runs after COMMIT.
function notifyReleased(result) {
  if (!result || !result.sessionIds) return;
  for (const sessionId of result.sessionIds) notifyTurn(sessionId);
}

// Reap leases whose heartbeat lapsed. Purely hygienic — a lapsed lease has
// already stopped counting as live everywhere that matters — but it keeps the
// unique partial index free so the same laptop can re-attach cleanly, and it
// gives the abandoned-turn transition somewhere to happen.
async function sweepExpiredLeases(pool) {
  const { rows } = await pool.query(
    `UPDATE session_agent_leases
        SET released_at = NOW(), release_reason = 'expired'
      WHERE released_at IS NULL AND expires_at <= NOW()
      RETURNING id, session_id`
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const { rows: turnRows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = 'abandoned', finished_at = NOW(), updated_at = NOW(),
            error_detail = 'The local coding agent stopped responding.'
      WHERE lease_id = ANY($1::BIGINT[]) AND status = ANY($2::TEXT[])
      RETURNING session_id`,
    [ids, LIVE_TURN_STATUSES]
  );
  for (const row of rows) notifyTurn(row.session_id);
  for (const row of turnRows) notifyTurn(row.session_id);
  log.info('local-agent', 'Reaped expired agent leases', {
    leases: rows.length, abandonedTurns: turnRows.length,
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

async function getTurn(pool, turnId) {
  const { rows } = await pool.query(
    `SELECT * FROM local_agent_turns WHERE id = $1`,
    [turnId]
  );
  return rows[0] || null;
}

async function liveTurnForSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM local_agent_turns
      WHERE session_id = $1 AND status = ANY($2::TEXT[])
      ORDER BY id DESC LIMIT 1`,
    [sessionId, LIVE_TURN_STATUSES]
  );
  return rows[0] || null;
}

// Queue a turn for the machine holding this session's lease.
// Returns null when the lease lapsed between the routing decision and here —
// the caller falls back to a platform worker, which is always safe because
// nothing has been dispatched yet.
//
// `mode` is 'build' (write code, produce a commit) or 'scout' (read-only,
// produce the spec). Both travel the identical lease → offer → confirm →
// progress → result path; only the shape of the answer differs.
async function enqueueTurn(pool, {
  sessionId, userId, prompt, baseSha, branchName, mode = 'build',
}) {
  if (!isValidMode(mode)) throw new Error(`Unsupported turn mode: ${mode}`);
  const lease = await activeLease(pool, sessionId);
  if (!lease || lease.user_id !== userId) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO local_agent_turns
         (session_id, lease_id, user_id, prompt, base_sha, branch_name, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [sessionId, lease.id, userId, prompt, baseSha || null, branchName || null, mode]
    );
    notifyTurn(sessionId);
    return { turn: rows[0], lease };
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

// Long-poll: hand the next queued turn to the machine that owns the lease.
//
// The claim itself is a single conditional UPDATE, so two concurrent polls
// from the same lease (a restarted CLI overlapping its predecessor) cannot
// both receive the same turn.
async function claimNextTurn(pool, { lease, timeoutMs = LONG_POLL_MS, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `UPDATE local_agent_turns
          SET status = 'offered', offered_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM local_agent_turns
           WHERE lease_id = $1 AND status = 'queued'
           ORDER BY id ASC LIMIT 1
        )
        RETURNING *`,
      [lease.id]
    );
    if (rows[0]) return rows[0];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await waitForSignal(turnChannel(lease.session_id), Math.min(remaining, 5000), signal);
  }
}

async function acceptTurn(pool, { turnId, leaseId }) {
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND lease_id = $2 AND status = 'offered'
      RETURNING *`,
    [turnId, leaseId]
  );
  if (rows[0]) notifyTurn(rows[0].session_id);
  return rows[0] || null;
}

// The local agent looked at the turn and refused it — almost always because
// its checkout is dirty, or is not sitting on the base commit the turn needs.
// The reason is shown to the user verbatim (bounded and control-stripped by
// the route), because "your checkout has uncommitted changes" is exactly the
// kind of thing they can fix in five seconds if we tell them.
async function declineTurn(pool, { turnId, leaseId, reason }) {
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = 'declined', finished_at = NOW(), updated_at = NOW(),
            error_detail = $3
      WHERE id = $1 AND lease_id = $2 AND status IN ('offered', 'accepted')
      RETURNING *`,
    [turnId, leaseId, reason || 'The local coding agent declined the turn.']
  );
  if (rows[0]) notifyTurn(rows[0].session_id);
  return rows[0] || null;
}

async function appendProgress(pool, { turnId, leaseId, lines }) {
  const normalized = normalizeProgress(lines);
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = CASE WHEN status = 'accepted' THEN 'running' ELSE status END,
            progress = (
              SELECT COALESCE(jsonb_agg(value), '[]'::JSONB) FROM (
                SELECT value FROM jsonb_array_elements(progress || $3::JSONB)
                OFFSET GREATEST(
                  0,
                  jsonb_array_length(progress || $3::JSONB) - $4::INT
                )
              ) trimmed
            ),
            updated_at = NOW()
      WHERE id = $1 AND lease_id = $2 AND status IN ('accepted', 'running')
      RETURNING *`,
    [turnId, leaseId, JSON.stringify(normalized), MAX_PROGRESS_LINES]
  );
  if (rows[0]) notifyTurn(rows[0].session_id);
  return rows[0] || null;
}

// Record a bot-owned commit the platform just reconstructed for this turn.
// Stored as it goes rather than only at the end so that a turn which uploads
// three commits and then dies still leaves the platform pointing at the last
// one it actually created on the branch.
async function recordTurnHead(pool, { turnId, leaseId, headSha }) {
  if (!isSha(headSha)) throw new Error('recordTurnHead requires a commit SHA');
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET head_sha = $3,
            status = CASE WHEN status = 'accepted' THEN 'running' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND lease_id = $2 AND status IN ('accepted', 'running')
        -- A scout turn is read-only. The route refuses the upload before it
        -- ever reaches GitHub; this is the second lock, so no future caller
        -- can advance a read-only turn's head by going around it.
        AND mode = 'build'
      RETURNING *`,
    [turnId, leaseId, String(headSha).toLowerCase()]
  );
  if (rows[0]) notifyTurn(rows[0].session_id);
  return rows[0] || null;
}

// Terminal transition reported by the local agent. A build turn's `completed`
// carries the head SHA the platform minted for it (a run that changed nothing
// reports 'completed' with a null head, and the tail renders that as an honest
// "no changes" turn rather than building a preview of nothing). A scout turn's
// `completed` carries `specMd` instead and can never carry a head — the
// `mode = 'build'` guard on head_sha below is the same rule the column's own
// CHECK enforces, applied here so a mismatched pair is a silent no-write
// rather than a constraint violation surfacing as a 500.
async function finishTurn(pool, {
  turnId, leaseId, status, headSha, summary, errorDetail, specMd,
}) {
  if (!TERMINAL_TURN_STATUSES.includes(status)) {
    throw new Error(`Unsupported terminal status: ${status}`);
  }
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = $3,
            head_sha = CASE WHEN mode = 'build' THEN $4 ELSE NULL END,
            summary = $5, error_detail = $6,
            spec_md = CASE WHEN mode = 'scout' THEN $8 ELSE NULL END,
            finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND lease_id = $2 AND status = ANY($7::TEXT[])
      RETURNING *`,
    [
      turnId, leaseId, status,
      isSha(headSha) ? String(headSha).toLowerCase() : null,
      summary || null, errorDetail || null,
      LIVE_TURN_STATUSES,
      typeof specMd === 'string' && specMd.trim()
        ? specMd.slice(0, MAX_SPEC_CHARS)
        : null,
    ]
  );
  if (rows[0]) notifyTurn(rows[0].session_id);
  return rows[0] || null;
}

// The platform side of the turn: block until the local agent reports a
// terminal state, the offer times out unclaimed, or the whole turn exceeds
// its outer bound.
//
// `onProgress` is called with the turn row whenever anything changes, which
// is what lets dev chat stream a local run's progress lines the same way it
// streams a worker's.
async function awaitTurnResult(pool, turnId, {
  onProgress,
  offerTimeoutMs = OFFER_TIMEOUT_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  signal,
} = {}) {
  const started = Date.now();
  let lastSeenUpdate = null;
  for (;;) {
    const turn = await getTurn(pool, turnId);
    if (!turn) {
      return { outcome: 'missing', turn: null };
    }
    if (TERMINAL_TURN_STATUSES.includes(turn.status)) {
      return { outcome: turn.status, turn };
    }
    if (onProgress && String(turn.updated_at) !== lastSeenUpdate) {
      lastSeenUpdate = String(turn.updated_at);
      try { await onProgress(turn); } catch { /* presentation only */ }
    }
    // A queued/offered turn nobody picked up. Abandon it here rather than
    // waiting out the full turn timeout: an attached-but-not-listening
    // machine is a common, boring failure (laptop asleep) and the user
    // should get their platform-worker fallback in seconds, not an hour.
    if (turn.status === 'queued' || turn.status === 'offered') {
      if (Date.now() - started > offerTimeoutMs) {
        const abandoned = await pool.query(
          `UPDATE local_agent_turns
              SET status = 'abandoned', finished_at = NOW(), updated_at = NOW(),
                  error_detail = 'The local coding agent did not pick up the turn.'
            WHERE id = $1 AND status = ANY($2::TEXT[])
            RETURNING *`,
          [turnId, ['queued', 'offered']]
        );
        return { outcome: 'abandoned', turn: abandoned.rows[0] || turn };
      }
    } else if (Date.now() - started > turnTimeoutMs) {
      const timedOut = await pool.query(
        `UPDATE local_agent_turns
            SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
                error_detail = 'The local coding agent did not finish in time.'
          WHERE id = $1 AND status = ANY($2::TEXT[])
          RETURNING *`,
        [turnId, LIVE_TURN_STATUSES]
      );
      return { outcome: 'failed', turn: timedOut.rows[0] || turn };
    }
    if (signal?.aborted) return { outcome: 'aborted', turn };
    await waitForSignal(turnChannel(turn.session_id), 2000, signal);
  }
}

// Ask the local agent to stop. There is no way to reach into someone's
// laptop and kill a process, so this is cooperative: the flag is the turn's
// status, the CLI notices it on its next progress post (which is rejected)
// and terminates its child. A machine that ignores the request simply finds
// its eventual result rejected by finishTurn's status guard.
async function requestStop(pool, { sessionId, userId }) {
  const { rows } = await pool.query(
    `UPDATE local_agent_turns
        SET status = 'stopped', finished_at = NOW(), updated_at = NOW(),
            error_detail = 'Stopped from the Usernode dev chat.'
      WHERE session_id = $1 AND ($2::INTEGER IS NULL OR user_id = $2)
        AND status = ANY($3::TEXT[])
      RETURNING *`,
    [sessionId, userId ?? null, LIVE_TURN_STATUSES]
  );
  if (rows[0]) notifyTurn(sessionId);
  return rows[0] || null;
}

// Record where a session's last coding turn ran, for the dev-chat chip.
async function recordTurnRunner(pool, sessionId, runner, label) {
  await pool.query(
    `UPDATE chat_sessions SET last_turn_runner = $2, local_agent_label = $3 WHERE id = $1`,
    [sessionId, runner, runner === 'local' ? (label || null) : null]
  ).catch((err) => log.warn('local-agent', 'Failed to record turn runner', {
    sessionId, err: err.message,
  }));
}

// `mode` is carried into the analytics row so a local scout turn is
// distinguishable from a local build turn: they are different amounts of
// work, and only one of them can produce a commit.
function recordTurnEvent(pool, {
  userId, appId, sessionId, outcome, runtime, durationMs, mode = 'build',
}) {
  return events.record(pool, {
    type: events.EVENT_TYPES.LOCAL_AGENT_TURN,
    userId, appId, sessionId,
    metadata: { outcome, runtime, durationMs, mode },
  });
}

// Public shape of a lease for the browser and the CLI. Deliberately omits
// access_token_id: the Settings screen has no use for it and it is a pointer
// into a staging:private credential table.
function publicLease(lease) {
  if (!lease) return null;
  return {
    leaseId: String(lease.id),
    sessionId: Number(lease.session_id),
    label: lease.label,
    runtime: lease.runtime,
    createdAt: lease.created_at,
    lastSeenAt: lease.last_seen_at,
    expiresAt: lease.expires_at,
    heartbeatSeconds: Math.round(HEARTBEAT_MS / 1000),
  };
}

function publicTurn(turn) {
  if (!turn) return null;
  return {
    turnId: String(turn.id),
    sessionId: Number(turn.session_id),
    status: turn.status,
    // The CLI branches on this: a 'scout' turn runs the local runtime in
    // read-only mode and posts a spec back instead of uploading commits.
    mode: turn.mode || 'build',
    prompt: turn.prompt,
    baseSha: turn.base_sha,
    branch: turn.branch_name,
    headSha: turn.head_sha,
    summary: turn.summary,
    error: turn.error_detail,
    createdAt: turn.created_at,
    finishedAt: turn.finished_at,
  };
}

module.exports = {
  HEARTBEAT_MS,
  LEASE_TTL_MS,
  LONG_POLL_MS,
  OFFER_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  MAX_PROGRESS_LINES,
  MAX_LABEL_CHARS,
  MAX_SPEC_CHARS,
  RUNTIMES,
  TURN_MODES,
  LIVE_TURN_STATUSES,
  TERMINAL_TURN_STATUSES,
  LeaseConflictError,
  isValidLabel,
  isValidRuntime,
  isValidMode,
  isSha,
  normalizeProgress,
  activeLease,
  activeLeasesForUser,
  attach,
  heartbeat,
  release,
  releaseLeasesForTokens,
  notifyReleased,
  sweepExpiredLeases,
  getTurn,
  liveTurnForSession,
  enqueueTurn,
  claimNextTurn,
  acceptTurn,
  declineTurn,
  appendProgress,
  recordTurnHead,
  finishTurn,
  awaitTurnResult,
  requestStop,
  recordTurnRunner,
  recordTurnEvent,
  publicLease,
  publicTurn,
  // Exposed for tests and for the routes' own notifications.
  _bus: bus,
  notifyTurn,
  notifyLease,
};
