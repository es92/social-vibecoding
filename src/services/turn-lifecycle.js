'use strict';

// Durable lifecycle for one logical coding turn.
//
// `chat_sessions.active_turn` remains the compatibility storage location for
// this release, but callers no longer mutate it ad hoc. Every new record has a
// stable `turnId`, every transition is compare-and-set against that identity,
// and recovery behavior is derived from the persisted phase rather than from
// an in-memory retry closure.

const crypto = require('crypto');

const PHASE_DISPATCH_PENDING = 'dispatch_pending';
const PHASE_EXECUTING = 'executing';
const PHASE_TAIL_PENDING = 'tail_pending';
const PHASE_CLEANUP_PENDING = 'cleanup_pending';
const PHASE_QUARANTINED = 'quarantined';

const RECOVERABLE_PHASES = new Set([
  PHASE_DISPATCH_PENDING,
  PHASE_EXECUTING,
  PHASE_TAIL_PENDING,
  // Rolling-deploy compatibility with records created before the lifecycle
  // consolidation. New code does not create these phases.
  'tail',
  'retry_pending',
  'retry_dispatch_pending',
]);

function parseActiveTurn(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function newTurnId() {
  return crypto.randomUUID();
}

function journalPathForAttempt(attemptId) {
  if (!attemptId || !/^[A-Za-z0-9-]+$/.test(String(attemptId))) {
    throw new Error('turn-lifecycle: safe attempt id required for journal path');
  }
  return `/home/node/.claude/turn-${attemptId}.log`;
}

function turnIdentity(activeTurn) {
  const turn = parseActiveTurn(activeTurn);
  if (!turn) return null;
  return turn.turnId || turn.logicalTurnId || turn.turnUuid || null;
}

function cleanupArgs(activeTurn) {
  const turn = parseActiveTurn(activeTurn);
  if (!turn) return {};
  return turn.turnId
    ? { turnId: turn.turnId, journal: turn.journal || null }
    : { journal: turn.journal || null };
}

function phaseOf(activeTurn) {
  const turn = parseActiveTurn(activeTurn);
  if (!turn) return null;
  // Legacy records without a phase represented an executing detached turn.
  return turn.phase || PHASE_EXECUTING;
}

function withLifecycle(turn, { turnId = null, phase = null } = {}) {
  const parsed = parseActiveTurn(turn) || {};
  const id = turnId || turnIdentity(parsed) || newTurnId();
  return {
    ...parsed,
    turnId: id,
    phase: phase || phaseOf(parsed) || PHASE_DISPATCH_PENDING,
    lifecycleUpdatedAt: new Date().toISOString(),
  };
}

function recoveryAction(activeTurn) {
  const phase = phaseOf(activeTurn);
  if (!phase) return 'none';
  if (phase === PHASE_CLEANUP_PENDING) return 'cleanup';
  if (phase === PHASE_QUARANTINED) return 'quarantine';
  if (RECOVERABLE_PHASES.has(phase)) return 'resume';
  return 'quarantine';
}

async function loadActiveTurn(db, sessionId, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    `SELECT active_turn FROM chat_sessions WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [sessionId],
  );
  return parseActiveTurn(rows[0]?.active_turn);
}

function identitySql(turnId, journal, startIndex = 2) {
  if (turnId) {
    return {
      sql: `active_turn->>'turnId' = $${startIndex}`,
      value: String(turnId),
    };
  }
  if (journal) {
    return {
      sql: `active_turn->>'journal' = $${startIndex}`,
      value: String(journal),
    };
  }
  throw new Error('turn-lifecycle: turnId or journal required');
}

async function persistNewTurn(db, sessionId, turn, {
  allowReplace = false,
  expectedTurnId = null,
  expectedJournal = null,
} = {}) {
  const record = withLifecycle(turn, {
    turnId: turn?.turnId || turn?.logicalTurnId || turn?.turnUuid || null,
    phase: turn?.phase || PHASE_DISPATCH_PENDING,
  });
  const params = [sessionId, JSON.stringify(record)];
  let predicate = 'active_turn IS NULL';
  if (allowReplace) {
    const ident = identitySql(expectedTurnId, expectedJournal, 3);
    predicate = `active_turn IS NOT NULL AND ${ident.sql}`;
    params.push(ident.value);
  }
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = $2::jsonb
      WHERE id = $1 AND ${predicate}
      RETURNING active_turn`,
    params,
  );
  if ((rowCount ?? rows?.length ?? 0) !== 1) {
    const err = new Error('turn-lifecycle: session already owns a different turn');
    err.code = 'session_busy';
    throw err;
  }
  return parseActiveTurn(rows[0]?.active_turn) || record;
}

async function transitionTurn(db, {
  sessionId,
  turnId = null,
  journal = null,
  turnUuid = null,
  from = null,
  to,
  patch = {},
}) {
  if (!to) throw new Error('turn-lifecycle: target phase required');
  const ident = identitySql(turnId, journal, 2);
  const phases = from == null ? null : (Array.isArray(from) ? from : [from]);
  const lifecyclePatch = {
    ...patch,
    phase: to,
    lifecycleUpdatedAt: new Date().toISOString(),
  };
  const params = [sessionId, ident.value, JSON.stringify(lifecyclePatch)];
  let physicalPredicate = '';
  if (turnUuid) {
    params.push(String(turnUuid));
    physicalPredicate = `
        AND active_turn->>'turnUuid' = $${params.length}`;
  }
  let phasePredicate = '';
  if (phases?.length) {
    params.push(phases);
    phasePredicate = `
        AND COALESCE(active_turn->>'phase', '${PHASE_EXECUTING}') = ANY($${params.length}::text[])`;
  }
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = active_turn || $3::jsonb
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND ${ident.sql}${physicalPredicate}${phasePredicate}
      RETURNING active_turn`,
    params,
  );
  if ((rowCount ?? rows?.length ?? 0) === 1) {
    return { transitioned: true, activeTurn: parseActiveTurn(rows[0]?.active_turn) };
  }

  const current = await loadActiveTurn(db, sessionId);
  if (!current) return { transitioned: false, alreadyCleared: true, activeTurn: null };
  const currentId = turnIdentity(current);
  const sameIdentity = turnId
    ? String(current.turnId || '') === String(turnId)
    : String(current.journal || '') === String(journal || '');
  if (!sameIdentity) {
    const err = new Error('turn-lifecycle: stale turn owner');
    err.code = 'stale_turn_owner';
    err.currentTurnId = currentId;
    throw err;
  }
  if (turnUuid && String(current.turnUuid || '') !== String(turnUuid)) {
    const err = new Error('turn-lifecycle: stale physical attempt owner');
    err.code = 'stale_turn_owner';
    err.currentTurnId = currentId;
    throw err;
  }
  if (phaseOf(current) === to) {
    return { transitioned: false, alreadyInPhase: true, activeTurn: current };
  }
  const err = new Error(`turn-lifecycle: invalid transition ${phaseOf(current)} -> ${to}`);
  err.code = 'invalid_turn_transition';
  throw err;
}

async function markExecuting(db, args) {
  return transitionTurn(db, {
    ...args,
    from: [PHASE_DISPATCH_PENDING],
    to: PHASE_EXECUTING,
    patch: { executionStartedAt: new Date().toISOString(), ...(args.patch || {}) },
  });
}

async function markTailPending(db, args) {
  return transitionTurn(db, {
    ...args,
    from: [
      PHASE_DISPATCH_PENDING,
      PHASE_EXECUTING,
      PHASE_TAIL_PENDING,
      'tail',
      'retry_pending',
      'retry_dispatch_pending',
    ],
    to: PHASE_TAIL_PENDING,
    patch: { tailStartedAt: new Date().toISOString(), ...(args.patch || {}) },
  });
}

async function markCleanupPending(db, args) {
  return transitionTurn(db, {
    ...args,
    from: [
      PHASE_DISPATCH_PENDING,
      PHASE_EXECUTING,
      PHASE_TAIL_PENDING,
      PHASE_CLEANUP_PENDING,
      'tail',
      'retry_pending',
      'retry_dispatch_pending',
    ],
    to: PHASE_CLEANUP_PENDING,
    patch: { cleanupPendingAt: new Date().toISOString(), ...(args.patch || {}) },
  });
}

// Closed sessions can retain records from older deployments. The watchdog
// has already checked age, ownership, execution and any attempt ledger. Clear
// only the exact snapshot while the session is still closed: a concurrent
// resume, phase transition or replacement turn must win over housekeeping.
async function clearClosedSessionTurn(db, { sessionId, activeTurn }) {
  const turn = parseActiveTurn(activeTurn);
  if (!turn || phaseOf(turn) === PHASE_QUARANTINED) return false;
  const { rowCount } = await db.query(
    `UPDATE chat_sessions SET active_turn = NULL
     WHERE id = $1 AND status IN ('archived', 'merged')
       AND active_turn = $2::jsonb`,
    [sessionId, JSON.stringify(turn)],
  );
  return rowCount === 1;
}

// A durable-state contradiction cannot be healed by repeatedly replaying the
// journal (for example, active_turn points at a ledger attempt that no longer
// exists). Preserve the exact owner and make the state explicit for operators
// instead of letting a watchdog clear the only forensic/recovery pointer.
async function markQuarantined(db, {
  sessionId,
  turnId = null,
  journal = null,
  code = 'recovery_state_invalid',
  patch = {},
}) {
  return transitionTurn(db, {
    sessionId,
    turnId,
    journal,
    from: [
      PHASE_DISPATCH_PENDING,
      PHASE_EXECUTING,
      PHASE_TAIL_PENDING,
      PHASE_CLEANUP_PENDING,
      'tail',
      'retry_pending',
      'retry_dispatch_pending',
    ],
    to: PHASE_QUARANTINED,
    patch: {
      ...patch,
      quarantineCode: String(code || 'recovery_state_invalid').slice(0, 100),
      quarantinedAt: new Date().toISOString(),
    },
  });
}

async function mergeTailMilestones(db, {
  sessionId,
  turnId = null,
  journal = null,
  milestones,
}) {
  if (!milestones || typeof milestones !== 'object' || Array.isArray(milestones)) {
    throw new Error('turn-lifecycle: milestone object required');
  }
  const ident = identitySql(turnId, journal, 3);
  const phases = [PHASE_TAIL_PENDING, 'tail'];
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = jsonb_set(
              active_turn, '{tail}',
              COALESCE(active_turn->'tail', '{}'::jsonb) || $2::jsonb, true)
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND ${ident.sql}
        AND COALESCE(active_turn->>'phase', '${PHASE_EXECUTING}') = ANY($4::text[])
      RETURNING active_turn`,
    [sessionId, JSON.stringify(milestones), ident.value, phases],
  );
  if ((rowCount ?? rows?.length ?? 0) === 1) {
    return { updated: true, activeTurn: parseActiveTurn(rows[0]?.active_turn) };
  }

  const current = await loadActiveTurn(db, sessionId);
  if (!current) return { updated: false, alreadyCleared: true, activeTurn: null };
  const sameIdentity = turnId
    ? String(current.turnId || '') === String(turnId)
    : String(current.journal || '') === String(journal || '');
  const err = new Error(sameIdentity
    ? `turn-lifecycle: milestone attempted from ${phaseOf(current)}`
    : 'turn-lifecycle: stale milestone owner');
  err.code = sameIdentity ? 'invalid_turn_transition' : 'stale_turn_owner';
  err.currentTurnId = turnIdentity(current);
  throw err;
}

// Mirror proxy-observed BYOK spend onto the exact executing turn so restart
// settlement sees the same split as the live process. This update is
// best-effort at its caller, but never session-wide: a delayed proxy response
// cannot charge a replacement turn.
async function incrementByokCents(db, { sessionId, turnId, cents }) {
  if (!turnId) throw new Error('turn-lifecycle: turnId required for BYOK spend');
  const amount = Number(cents);
  if (!Number.isFinite(amount) || amount <= 0) return { updated: false };
  const phases = [PHASE_DISPATCH_PENDING, PHASE_EXECUTING, PHASE_TAIL_PENDING];
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = jsonb_set(
              active_turn, '{byokCents}',
              to_jsonb(COALESCE((active_turn->>'byokCents')::numeric, 0) + $1::numeric),
              true)
      WHERE id = $2
        AND active_turn IS NOT NULL
        AND active_turn->>'turnId' = $3
        AND COALESCE(active_turn->>'phase', '${PHASE_EXECUTING}') = ANY($4::text[])
      RETURNING active_turn`,
    [amount, sessionId, String(turnId), phases],
  );
  return {
    updated: (rowCount ?? rows?.length ?? 0) === 1,
    activeTurn: parseActiveTurn(rows?.[0]?.active_turn),
  };
}

// One more platform restart reached this turn (server.js, when restart
// recovery takes a bot's or a benchmark trial's turn): counted on the turn's
// own record so every later recovery reads the same total, which the bot's
// clock gives back time for (homeroom-bot.js RESTART_ALLOWANCE_MS). Keyed on
// the exact turn, so a count never carries to the next one. Resolves the new
// count, or null when the session holds no such turn.
async function noteRestart(db, { sessionId, turnId }) {
  if (!turnId) return null;
  const { rows } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = jsonb_set(
              active_turn, '{restarts}',
              to_jsonb(COALESCE((active_turn->>'restarts')::int, 0) + 1),
              true)
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND active_turn->>'turnId' = $2
      RETURNING (active_turn->>'restarts')::int AS restarts`,
    [sessionId, String(turnId)],
  );
  return rows.length ? Number(rows[0].restarts) : null;
}

// The lifecycle's own fields, which only the helpers above write.
const RESERVED_TURN_KEYS = new Set([
  'turnId', 'phase', 'journal', 'turnUuid', 'logicalTurnId', 'attemptNumber', 'backend', 'harness',
  'mode', 'model', 'startedAt', 'tail', 'restarts', 'byok', 'byokCents', 'stopRequestedAt',
  'stopRequestedBy', 'lifecycleUpdatedAt', 'executionStartedAt', 'cleanupPendingAt', 'quarantineCode',
]);

// #4533: the turn's owner keeps a note of its own on the record, under one
// key of its own (the Homeroom bot's follow-up keeps its deadline and what
// it was doing there, homeroom-bot-followup.js TURN_MARK, so restart
// recovery stops it on time and records it as the bot would). Compare-and-
// set on the exact turn, like every write here, and never the phase or any
// field the lifecycle owns. Resolves whether the turn still held the session.
async function stampTurn(db, { sessionId, turnId, key, value }) {
  if (!turnId) throw new Error('turn-lifecycle: turnId required to stamp a turn');
  if (!/^[a-z][A-Za-z0-9]{2,63}$/.test(String(key || '')) || RESERVED_TURN_KEYS.has(key)) {
    throw new Error(`turn-lifecycle: ${key} is not a key a turn's owner may stamp`);
  }
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = jsonb_set(active_turn, ARRAY[$3::text], $4::jsonb, true)
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND active_turn->>'turnId' = $2
      RETURNING id`,
    [sessionId, String(turnId), key, JSON.stringify(value ?? null)],
  );
  return (rowCount ?? rows?.length ?? 0) === 1;
}

async function clearCleanupPending(db, {
  sessionId,
  turnId = null,
  journal = null,
}) {
  const ident = identitySql(turnId, journal, 2);
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = NULL
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND ${ident.sql}
        AND active_turn->>'phase' = '${PHASE_CLEANUP_PENDING}'
      RETURNING id`,
    [sessionId, ident.value],
  );
  if ((rowCount ?? rows?.length ?? 0) === 1) return { cleared: true };

  const current = await loadActiveTurn(db, sessionId);
  if (!current) return { cleared: true, alreadyCleared: true };
  const sameIdentity = turnId
    ? String(current.turnId || '') === String(turnId)
    : String(current.journal || '') === String(journal || '');
  if (!sameIdentity) {
    const err = new Error('turn-lifecycle: stale cleanup owner');
    err.code = 'stale_turn_owner';
    err.currentTurnId = turnIdentity(current);
    throw err;
  }
  const err = new Error(`turn-lifecycle: cleanup attempted from ${phaseOf(current)}`);
  err.code = 'invalid_turn_transition';
  throw err;
}

// Atomically publish a recovered headless terminal state and hand the turn to
// cleanup. This closes the crash window where headless_status became terminal
// while active_turn still said tail_pending, a combination the boot query
// could neither resume nor clear safely.
async function markHeadlessTerminal(db, {
  sessionId,
  turnId = null,
  journal = null,
  status,
  outcome = null,
}) {
  if (!['ready', 'failed'].includes(status)) {
    throw new Error('turn-lifecycle: invalid headless terminal status');
  }
  const ident = identitySql(turnId, journal, 2);
  const patch = {
    phase: PHASE_CLEANUP_PENDING,
    cleanupPendingAt: new Date().toISOString(),
    lifecycleUpdatedAt: new Date().toISOString(),
  };
  const phases = [
    PHASE_DISPATCH_PENDING,
    PHASE_EXECUTING,
    PHASE_TAIL_PENDING,
    PHASE_CLEANUP_PENDING,
    'tail',
    'retry_pending',
    'retry_dispatch_pending',
  ];
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET headless_status = $4,
            headless_outcome = COALESCE($5, headless_outcome),
            headless_step = NULL,
            headless_turn_id = NULL,
            last_activity_at = NOW(),
            active_turn = active_turn || $3::jsonb
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND ${ident.sql}
        AND COALESCE(active_turn->>'phase', '${PHASE_EXECUTING}') = ANY($6::text[])
      RETURNING active_turn`,
    [sessionId, ident.value, JSON.stringify(patch), status, outcome, phases],
  );
  if ((rowCount ?? rows?.length ?? 0) === 1) {
    return parseActiveTurn(rows[0]?.active_turn) || patch;
  }

  const current = await loadActiveTurn(db, sessionId);
  if (!current) {
    const err = new Error('turn-lifecycle: headless terminal turn is missing');
    err.code = 'stale_turn_owner';
    throw err;
  }
  const sameIdentity = turnId
    ? String(current.turnId || '') === String(turnId)
    : String(current.journal || '') === String(journal || '');
  if (!sameIdentity) {
    const err = new Error('turn-lifecycle: stale headless terminal owner');
    err.code = 'stale_turn_owner';
    err.currentTurnId = turnIdentity(current);
    throw err;
  }
  const err = new Error(`turn-lifecycle: invalid headless terminal transition from ${phaseOf(current)}`);
  err.code = 'invalid_turn_transition';
  throw err;
}

// #1378: durable record that the user asked THIS turn to stop.
//
// The in-memory stop handle (services/stop-registry) is the fast path, but
// it dies with the process. A stop clicked seconds before a blue-green
// cutover, or on a turn whose handle is cleared while the tail is still
// unwinding, has to survive into the next process — otherwise recovery
// re-adopts the turn, narrates "[interrupted]" and can even retry it, which
// is the opposite of what was asked. Stamping the intent onto the
// active_turn JSONB gives POST /stop, GET /status and the recovery path one
// answer they all agree on.
//
// Compare-and-set on turn identity, exactly like markQuarantined: a stamp
// must never land on a REPLACEMENT turn that happens to share the session.
// Unlike the transition helpers this does NOT move the phase — stopping is
// an intent recorded against whatever phase the turn is in, and the phase
// machine keeps running until the turn actually unwinds. It also never
// throws on a miss: a stop for a turn that already finished is a no-op, not
// an error the route should surface.
async function markStopRequested(db, { sessionId, turnId = null, journal = null, by = null }) {
  const ident = identitySql(turnId, journal, 2);
  const patch = {
    stopRequestedAt: new Date().toISOString(),
    stopRequestedBy: by ? String(by).slice(0, 100) : null,
  };
  const { rows, rowCount } = await db.query(
    `UPDATE chat_sessions
        SET active_turn = active_turn || $3::jsonb
      WHERE id = $1
        AND active_turn IS NOT NULL
        AND ${ident.sql}
        AND active_turn->>'stopRequestedAt' IS NULL
      RETURNING active_turn`,
    [sessionId, ident.value, JSON.stringify(patch)],
  );
  if ((rowCount ?? rows?.length ?? 0) === 1) {
    return { updated: true, activeTurn: parseActiveTurn(rows[0]?.active_turn) };
  }
  // Either the turn is gone, a different turn owns the session now, or an
  // earlier stop already stamped it. The first request wins — repeat stops
  // must not rewrite the timestamp the client's escalation ladder is
  // measuring against.
  const current = await loadActiveTurn(db, sessionId);
  return { updated: false, activeTurn: current || null };
}

// Read the durable stop intent back off a parsed active_turn record.
// Returns null when the turn carries no stamp, so callers can treat
// "no durable stop" and "no turn at all" the same way.
function stopRequestOf(activeTurn) {
  if (!activeTurn || typeof activeTurn !== 'object') return null;
  const at = activeTurn.stopRequestedAt;
  if (!at) return null;
  const ms = Date.parse(at);
  return {
    at,
    atMs: Number.isFinite(ms) ? ms : null,
    by: activeTurn.stopRequestedBy || null,
  };
}

module.exports = {
  PHASE_DISPATCH_PENDING,
  PHASE_EXECUTING,
  PHASE_TAIL_PENDING,
  PHASE_CLEANUP_PENDING,
  PHASE_QUARANTINED,
  parseActiveTurn,
  newTurnId,
  journalPathForAttempt,
  turnIdentity,
  cleanupArgs,
  phaseOf,
  withLifecycle,
  recoveryAction,
  loadActiveTurn,
  persistNewTurn,
  transitionTurn,
  markExecuting,
  markTailPending,
  markCleanupPending,
  clearClosedSessionTurn,
  markQuarantined,
  mergeTailMilestones,
  incrementByokCents,
  noteRestart,
  stampTurn,
  clearCleanupPending,
  markHeadlessTerminal,
  markStopRequested,
  stopRequestOf,
  RECOVERABLE_PHASES,
};
