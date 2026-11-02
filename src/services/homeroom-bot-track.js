'use strict';

// One track per request (16 Oct 2026).
//
// Six parts of the platform each worked out where a request the Homeroom bot
// had was, from their own reading of its runs, its queue row and its change:
// the activity cards, the tray and its strip, the progress answer, the chat's
// news lines, a project's chat cards and the request page. They disagreed:
// a request closed elsewhere stayed in Needs you, work held at a limit read
// as finished, a build's clock counted from its first try, "See progress"
// opened the whole chat. This module is the one place the PEOPLE-FACING
// state of a request is decided, from the same records those readers use:
// progress.stageOf for work in hand and the tray's outcome for work that
// ended. Every surface draws what it says.
//
// A track is a loop, not a line. The normal path is
//
//     queued → planning → building → checks → vote → going_live → live
//
// and it goes back: a question sends it to `waiting` (on the person) and
// back; failing checks, or voters asking for changes, send it back to
// `building` as its next try (`try` counts them); a change behind main is
// synced and its checks run again. From any step it can end up `held` at a
// limit (which limit, what frees it, its place in line), `stopped` (why),
// or `done_elsewhere` (somebody else's change shipped it) or `closed`.
//
// What a track carries is codes, never words: the client words them
// (frontend/locales/en/messages.json bot.track.*), so every surface says the
// same thing the same way.

const log = require('./logger');
const repoRef = require('./repo-ref');

const STATES = Object.freeze([
  'queued', 'planning', 'waiting', 'building', 'checks', 'vote', 'going_live', 'live',
  'held', 'stopped', 'done_elsewhere', 'closed',
]);

// The five steps a track's bar draws, in order. A state lights one.
const STEPS = Object.freeze(['plan', 'build', 'checks', 'vote', 'live']);

// The states that are over: the bell rings once on reaching one, and the
// chat folds them into "finished today".
const ENDED = new Set(['live', 'stopped', 'done_elsewhere', 'closed']);

// The limits a request can be held at. `slots`: the project's
// PROPOSALS_PER_APP_CAP; `bot_wide`: the bot's ceiling across projects;
// `questions`: the daily allowance of questions on the project;
// `allowance`: whoever pays for it is out of building time this week.
const CAP_LIMITS = Object.freeze({
  proposals_per_app: 'slots',
  proposals_total: 'bot_wide',
  question_tripwire: 'questions',
});

/**
 * Pure: a progress stage (homeroom-bot-progress.js stageOf, as a tray job
 * or progress entry carries it) as a track's state, step and why. Null for
 * a stage this module does not know, which the caller then reads from the
 * request's outcome instead.
 */
function fromStage(stage, { waitingFor = null } = {}) {
  switch (stage) {
    case 'setting_up': return { state: 'planning', step: 'plan', why: 'setting_up', busy: true };
    case 'queued': return { state: 'queued', step: null, why: waitingFor?.reason || 'turn' };
    case 'reading': return { state: 'planning', step: 'plan', why: 'reading', busy: true };
    case 'question': return { state: 'waiting', step: 'plan', why: 'question', waitingOn: 'you' };
    case 'plan': return { state: 'waiting', step: 'plan', why: 'plan', waitingOn: 'you' };
    case 'held': return { state: 'held', step: 'build', why: 'slots' };
    case 'on_hold': return { state: 'held', step: null, why: 'allowance' };
    case 'build_queued': return { state: 'queued', step: 'build', why: waitingFor?.reason || 'build_turn' };
    case 'starting': case 'planning': return { state: 'planning', step: 'plan', why: 'planning', busy: true };
    case 'stalled': return { state: 'building', step: 'build', why: 'stalled' };
    case 'building': return { state: 'building', step: 'build', why: null, busy: true };
    case 'reviewing': return { state: 'building', step: 'build', why: 'reviewing', busy: true };
    case 'proposing': return { state: 'building', step: 'build', why: 'proposing', busy: true };
    case 'fix_queued': return { state: 'building', step: 'build', why: 'fix_queued', loop: true };
    case 'fixing': return { state: 'building', step: 'build', why: 'fixing', busy: true, loop: true };
    case 'followup_queued': return { state: 'building', step: 'build', why: 'changes_queued', loop: true };
    case 'revising': return { state: 'building', step: 'build', why: 'revising', busy: true, loop: true };
    case 'checks': return { state: 'checks', step: 'checks', why: null };
    case 'checks_failed': return { state: 'checks', step: 'checks', why: 'failed' };
    case 'vote': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    case 'merging': return { state: 'going_live', step: 'live', why: null, busy: true };
    default: return null;
  }
}

/**
 * Pure: why a build that did not succeed stopped, as a code, from its run's
 * build_error (the same reading homeroom-bot-dm.js buildFailedCause makes
 * for the DM) and, for a build that changed nothing, what its turns said of
 * it (noChangeWhy). Never the agent's words themselves.
 */
function buildStopWhy(buildError, noChange = null) {
  const r = String(buildError || '').split(/; (?:last activity|it last said):/)[0];
  if (/restarted in the middle of each of its last/.test(r)) return 'restarts';
  if (/ran past its time limit/.test(r)) return 'time';
  if (/restarted|by a restart/.test(r)) return 'restart';
  if (/built but could not be proposed/.test(r)) return 'unproposed';
  if (/couldn't push the build's commit/.test(r)) return 'not_pushed';
  if (/produced no change/.test(r)) return noChangeWhy(noChange);
  if (/could not start|would not start|could not open a session|could not create its branch/.test(r)) return 'no_start';
  return 'build_failed';
}

/**
 * Pure (H2): why a build changed nothing, as a code, from what its last
 * turn said (`said`, the agent's last message, which is never shown to
 * anybody but admins) and whether it was asked once more (`nudged`).
 * 'no_change_already' when it says the change is already there,
 * 'no_change_unclear' when it was not sure what to change,
 * 'no_change_could_not' when it says it could not, else 'no_change'.
 */
function noChangeWhy(noChange) {
  const said = String(noChange?.said || '');
  if (/\balready\b[^.]{0,60}\b(?:exists?|there|implemented|in place|done|works?|does|has|handles|shows|supports)\b|\bno (?:code )?changes? (?:is |are |were )?(?:needed|required|necessary)\b|\bnothing (?:needs|needed) to change\b/i.test(said)) {
    return 'no_change_already';
  }
  if (/\b(?:unclear|ambiguous|not sure|unsure|clarif\w*|which (?:one|of)|need(?:s)? more detail)\b/i.test(said)) return 'no_change_unclear';
  if (/\b(?:can'?t|cannot|could ?n[o']t|unable|not possible|impossible|no access|not allowed|permission)\b/i.test(said)) {
    return 'no_change_could_not';
  }
  return 'no_change';
}

/**
 * Pure: an outcome of the tray's (homeroom-bot-tray.js outcomeOf, on a
 * request's lead run) as a track's state, step and why. `lead` is the run
 * the outcome was read from, for a stop's reason and a hold's limit.
 */
function fromOutcome(outcome, lead = null) {
  switch (outcome) {
    case 'live': return { state: 'live', step: 'live', why: null };
    case 'going_live': return { state: 'going_live', step: 'live', why: null };
    case 'proposed': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    case 'checking': return { state: 'checks', step: 'checks', why: null };
    case 'needs_look': return { state: 'waiting', step: 'checks', why: 'look', waitingOn: 'you' };
    case 'question': return { state: 'waiting', step: 'plan', why: 'question', waitingOn: 'you' };
    case 'blocked': return { state: 'waiting', step: 'plan', why: 'detail', waitingOn: 'you' };
    case 'empty': return { state: 'stopped', step: 'plan', why: 'nothing_to_build' };
    case 'person': return { state: 'stopped', step: lead?.proposal_session_id ? 'checks' : 'plan', why: 'needs_person' };
    case 'build_failed': return { state: 'stopped', step: 'build', why: buildStopWhy(lead?.build_error, { said: lead?.no_change_said }) };
    case 'failed': return { state: 'stopped', step: null, why: 'failed' };
    case 'held': return { state: 'held', step: 'build', why: CAP_LIMITS[lead?.cap_suppressed] || 'slots' };
    case 'closed': return { state: 'stopped', step: 'vote', why: 'withdrawn' };
    case 'stopped': return { state: 'stopped', step: null, why: 'skipped' };
    // A reply the bot answered on its own change: the change is the news.
    case 'answer': case 'revise': return { state: 'vote', step: 'vote', why: null, waitingOn: 'group' };
    default: return null;
  }
}

/**
 * Pure: how many tries a request's work has had, from its live runs (the
 * tray's pastRuns rows, newest first): every build of it that was not held
 * or only a plan, and every update of its change (a revision, or one that
 * failed), plus the one `under way` now when no run records it yet. At
 * least 1.
 */
function isTry(run) {
  if (run.verdict === 'ready') return !run.cap_suppressed && run.plan_only !== true && !run.awaiting_go_at;
  if (run.verdict === 'revise') return !!run.proposal_session_id;
  return run.verdict === 'failed' && /^revise:/.test(String(run.error || ''));
}

/** Pure (B23): whether a run's change of the bot's is merged and live (pastRuns' proposal_status). */
function wentLive(run) {
  return run.verdict === 'ready' && !!run.proposal_session_id && run.proposal_status === 'merged';
}

function triesOf(runs = [], { underWay = false } = {}) {
  const tries = runs.filter(isTry).length;
  return Math.max(1, tries + (underWay ? 1 : 0));
}

/**
 * Pure: when each of a request's tries began, oldest first (the runs that
 * triesOf counts, and the try under way when no run records it yet): where
 * a thread marks "Try 2". Empty for a request with one try.
 */
function tryStartsOf(runs = [], { underWay = null } = {}) {
  const starts = runs.filter(isTry).map((run) => iso(run.created_at)).filter(Boolean);
  if (underWay) starts.push(iso(underWay));
  const sorted = [...new Set(starts.filter(Boolean))].sort();
  return sorted.length > 1 ? sorted : [];
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pure: one request's track, from what the tray knows of it.
 *
 *   job      the tray's entry for it (Now, Needs you or History)
 *   entry    progress.progressFor's entry for it, when it has one: the
 *            stage of work in hand, including a change up for a vote
 *   runs     its live runs, newest first (tray pastRuns rows)
 *   held     its place among the project's held requests ({ position }),
 *            or who has the request when a person does ({ limit: 'taken',
 *            by }): the bot leaves a request somebody claimed alone
 *   doneBy   who shipped it, when somebody else's change closed it
 *            ({ username, prNumber, sessionId })
 *   until    when an allowance hold lifts (limits.weeklyResetAt)
 */
function trackOf({ job, entry = null, runs = [], held = null, doneBy = null, until = null }) {
  const stage = job.stage || entry?.stage || null;
  const lead = runs.find((run) => Number(run.id) === Number(job.id)) || runs[0] || null;
  let base = stage ? fromStage(stage, { waitingFor: entry?.waitingFor || job.waitingFor || null }) : null;
  // A stage that says nothing waits (a change up for a vote) is read off the
  // outcome when the work ended in something sharper.
  if (!base) base = fromOutcome(job.outcome, lead);
  // 16 Oct 2026: held, but a person has the request now (a claim, their own
  // change): it waits on them, not on a slot (heldQueue's `takenBy`).
  if (base?.state === 'held' && held?.limit === 'taken') base = { ...base, why: 'taken' };
  if (!base) {
    base = job.inHand
      ? { state: 'building', step: 'build', why: null }
      : { state: 'stopped', step: null, why: 'unknown' };
  }
  // A question its person answered waits on the bot again, not on them.
  if (base.state === 'waiting' && job.answered && !job.ask) {
    base = { ...base, state: 'planning', waitingOn: null, why: 'answered' };
  }
  // A hand-off of failing checks: the change waits on a person now.
  if (base.state === 'checks' && base.why === 'failed' && job.outcome === 'person') {
    base = { ...base, why: 'handed_over' };
  }
  // The request itself was closed: whatever was still waiting on somebody,
  // or stopped, is over, shipped by somebody else's change or just closed.
  const closed = job.requestClosed === true;
  if (closed && !['vote', 'checks', 'going_live', 'live', 'building'].includes(base.state)) {
    // B23 (audit 2 Nov 2026): a request its own change made live, and that
    // closed when it merged, is live, whatever a later look at it said: a
    // first version that went live read "Closed".
    base = runs.some(wentLive)
      ? { state: 'live', step: 'live', why: null }
      : doneBy
      ? { state: 'done_elsewhere', step: 'live', why: null }
      : { state: 'closed', step: null, why: null };
  }
  const underWay = !!base.loop && !runs.some((run) => run.verdict === 'revise' && Date.parse(run.created_at) >= Date.parse(entry?.since || job.since || 0));
  const tries = triesOf(runs, { underWay });
  const since = iso(job.since) || iso(entry?.since) || iso(job.at);
  const lastBuild = runs.find((run) => Number(run.build_session_id) > 0);
  const track = {
    key: job.key,
    appSlug: job.appSlug || null,
    appName: job.appName || null,
    iconUrl: job.iconUrl || null,
    iconEmoji: job.iconEmoji || null,
    issueNumber: Number(job.issueNumber) || null,
    title: job.title || null,
    firstVersion: !!job.firstVersion,
    state: base.state,
    step: base.step,
    why: base.why || null,
    waitingOn: base.waitingOn || null,
    busy: !!base.busy,
    try: tries,
    // This try's clock: when the work under way began, never the wait
    // before it nor an earlier try (#5210 read "16h 31m so far" on a build
    // fifteen minutes old).
    tryStartedAt: ['building', 'planning'].includes(base.state) ? since : null,
    since,
    rootId: Number(job.cardId) || Number(job.ask?.messageId) || null,
    askId: Number(job.ask?.messageId) || null,
    // The private thread that message is in, when it is not Main (tray threadsOf).
    askThreadId: Number(job.ask?.threadRootId) || null,
    proposalId: Number(job.proposalId) || Number(entry?.proposal?.proposal) || null,
    // The session its plan and change live in: the change, else its build.
    sessionId: Number(job.proposalId) || Number(entry?.proposal?.proposal) || Number(lastBuild?.build_session_id) || null,
    tryStarts: tryStartsOf(runs, { underWay: underWay ? since : null }),
    links: job.links || null,
    ...(job.release ? { release: job.release } : {}),
  };
  if (base.state === 'held') {
    track.held = {
      limit: base.why,
      position: held?.position || null,
      until: base.why === 'allowance' ? iso(until) : null,
      ...(base.why === 'taken' ? { by: held?.by || null } : {}),
    };
  }
  if (base.state === 'queued' && entry?.waitingFor?.ahead != null) {
    track.queue = { ahead: Number(entry.waitingFor.ahead) || 0 };
  }
  if (base.state === 'done_elsewhere' && doneBy) {
    track.doneBy = { username: doneBy.username || null, prNumber: Number(doneBy.prNumber) || null };
  }
  return track;
}

// ── Reads ──────────────────────────────────────────────────────

// Each project's held requests, in the order the bot takes them back up
// (homeroom-bot.js refreshApp: oldest hold first, each limit apart): the
// newest live run of each request, held by a limit, on a request still
// open. `$1` the projects.
const HELD_QUEUE_SQL = `
  SELECT h.app_id, h.issue_number, h.cap_suppressed, h.created_at
    FROM (
      SELECT DISTINCT ON (r.app_id, r.issue_number) r.app_id, r.issue_number, r.cap_suppressed, r.created_at
        FROM homeroom_bot_runs r
       WHERE r.app_id = ANY($1::int[]) AND r.mode = 'live'
       ORDER BY r.app_id, r.issue_number, r.id DESC
    ) h
   WHERE h.cap_suppressed IS NOT NULL
     AND COALESCE((SELECT i.status <> 'closed' FROM issues i
                    WHERE i.app_id = h.app_id AND i.github_issue_number = h.issue_number
                    ORDER BY i.id DESC LIMIT 1), TRUE)
     -- 16 Oct 2026: nor one the bot has recorded closed, which a request
     -- with no row of ours can only be (homeroom-bot-closed-requests.js).
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_closed_requests c
                      WHERE c.app_id = h.app_id AND c.issue_number = h.issue_number
                        AND c.closed_at IS NOT NULL)
   ORDER BY h.app_id, h.cap_suppressed, h.created_at, h.issue_number`;

/**
 * Each held request's place in its project's line: Map `${appId}#${n}` →
 * { position, limit, since } (`since`: when it was held). 16 Oct 2026: the
 * line counts only what really waits for the bot. `open` (Map appId → Set of open numbers, from a whole
 * fresh list where the caller has one) drops a request that closed since it
 * was held; `takenBy` (Map appId → issueHolders' Map) answers a request a
 * person has now as { limit: 'taken', by } with no place, since the bot
 * leaves it alone (homeroom-bot.js classifyIssue: in_progress). On 16
 * October the platform's slots page listed 25 held requests "waiting for a
 * slot" with no slot in use: all but one had closed, and that one was
 * claimed.
 */
async function heldQueue(pool, appIds, { open = null, takenBy = null } = {}) {
  const ids = [...new Set((appIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await pool.query(HELD_QUEUE_SQL, [ids]);
  const counts = new Map();
  for (const row of rows) {
    const appId = Number(row.app_id);
    const n = Number(row.issue_number);
    const openHere = open?.get(appId);
    if (openHere && !openHere.has(n)) continue;
    const base = { since: iso(row.created_at), appId, issueNumber: n };
    const holds = takenBy?.get(appId)?.get(n);
    if (holds && holds.length) {
      // `since`, for one a person has: when they took it.
      const who = holds.find((h) => h.username) || holds[0];
      out.set(`${appId}#${n}`, { ...base, since: iso(who.since) || base.since, position: null, limit: 'taken', by: who.username || null });
      continue;
    }
    const line = `${appId}:${row.cap_suppressed}`;
    const position = (counts.get(line) || 0) + 1;
    counts.set(line, position);
    out.set(`${appId}#${n}`, { ...base, position, limit: CAP_LIMITS[row.cap_suppressed] || 'slots' });
  }
  return out;
}

/**
 * Pure: one line of what a request asks, from its body, for a row that has
 * room for little more than its title: the first line that is the person's
 * own words, not the lines Homeroom writes around them (**Source:**, the
 * screenshot, where a comment pin was made). Null when there is none.
 */
function requestExcerpt(body, max = 140) {
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(\*\*[^*]+:\*\*|!\[|<|---|Pinned with |```)/.test(line)) continue;
    const plain = line.replace(/^#+\s*|^[-*>]\s+/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    if (!plain) continue;
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}\u2026` : plain;
  }
  return null;
}

// Who shipped a closed request: the newest merged change linked to it that
// is not the bot's. `$1`/`$2` the requests as parallel arrays of project
// and number, `$3` the bot's username.
const DONE_BY_SQL = `
  SELECT DISTINCT ON (w.app_id, w.n) w.app_id, w.n, cs.id AS session_id, cs.pr_number, u.username
    FROM UNNEST($1::int[], $2::int[]) AS w(app_id, n)
    JOIN chat_sessions cs ON cs.app_id = w.app_id AND cs.status = 'merged'
         AND (w.n = ANY(cs.linked_issues) OR cs.created_from_issue_number = w.n)
    JOIN users u ON u.id = cs.user_id
   WHERE u.username <> $3
   ORDER BY w.app_id, w.n, cs.merged_at DESC NULLS LAST, cs.id DESC`;

async function doneByFor(pool, pairs) {
  const out = new Map();
  if (!pairs.length) return out;
  const { rows } = await pool.query(DONE_BY_SQL, [pairs.map((p) => p.appId), pairs.map((p) => p.n), 'homeroom_bot']);
  for (const row of rows) {
    out.set(`${row.app_id}#${row.n}`, { username: row.username, prNumber: row.pr_number, sessionId: row.session_id });
  }
  return out;
}

/**
 * Every request in the tray's `work` as a track (trackOf), in the order
 * the tray has them: Now, Needs you, History. `entries` are progressFor's
 * (by key), `rows` the person's live runs (pastRuns). Adds `work.tracks`
 * and returns it. Never throws: a read that fails leaves the tracks without
 * a hold's place or a closer's name.
 */
async function withTracks(pool, work, { entries = [], rows = [], keyOf, deps = {} } = {}) {
  const jobs = [...(work.now || []), ...(work.needsYou || []), ...(work.history || [])];
  const runsByKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.slug, row.issue_number);
    if (!runsByKey.has(key)) runsByKey.set(key, []);
    runsByKey.get(key).push(row);
  }
  // B02 (audit 2 Nov 2026): an entry is found by the key its job has. A
  // first version once filed has its request's number on both (tray
  // jobOfEntry), so keying it 'first' lost its stage: a plan waiting for its
  // creator read "Stopped". One being set up has no number, and stays 'first'.
  const entryByKey = new Map();
  for (const e of entries) {
    if (!e || !e.project) continue;
    const key = keyOf(e.project, e.number);
    if (!entryByKey.has(key)) entryByKey.set(key, e);
  }
  const appIdOf = new Map(rows.map((row) => [row.slug, Number(row.app_id)]).filter(([, id]) => id > 0));
  let held = new Map();
  let doneBy = new Map();
  let until = null;
  try {
    const heldApps = [...new Set(jobs.filter((job) => job.outcome === 'held' || job.stage === 'held')
      .map((job) => appIdOf.get(job.appSlug)).filter(Boolean))];
    if (heldApps.length) {
      // Who has a held request now, so it reads as theirs, not as a wait.
      const botSvc = deps.botSvc || require('./homeroom-bot');
      const takenBy = typeof botSvc.issueHolders === 'function'
        ? new Map(await Promise.all(heldApps.map(async (appId) => [appId, await botSvc.issueHolders(pool, appId)])))
        : null;
      held = await heldQueue(pool, heldApps, { takenBy });
    }
    const closed = jobs.filter((job) => job.requestClosed === true && appIdOf.get(job.appSlug) && job.issueNumber)
      .map((job) => ({ appId: appIdOf.get(job.appSlug), n: Number(job.issueNumber) }));
    if (closed.length) doneBy = await doneByFor(pool, closed);
    if (jobs.some((job) => job.stage === 'on_hold' || entryByKey.get(job.key)?.stage === 'on_hold')) {
      until = (deps.limits || require('./limits')).weeklyResetAt();
    }
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read holds or closers for the tracks', { err: err.message });
  }
  const at = (job) => `${appIdOf.get(job.appSlug)}#${job.issueNumber}`;
  work.tracks = jobs.map((job) => trackOf({
    job,
    entry: entryByKey.get(job.key) || null,
    runs: runsByKey.get(job.key) || [],
    held: held.get(at(job)) || null,
    doneBy: doneBy.get(at(job)) || null,
    until,
  }));
  return work;
}

// ── One project's requests, whoever asked (the request page, the slots) ──

// Of `$2`, the requests of project `$1` the bot has a live run or a queue
// entry for: the only ones with a track (tracksForRequests). 16 Oct 2026: a
// run in the background (mode 'shadow', the bot's trial before it went on
// for everyone) is not one: nobody saw it, and a trial build read as a
// change up for a vote on the request's own page.
const TOUCHED_SQL = `
  SELECT w.n FROM UNNEST($2::int[]) AS w(n)
   WHERE EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.app_id = $1 AND r.issue_number = w.n AND r.mode = 'live')
      OR EXISTS (SELECT 1 FROM homeroom_bot_queue q WHERE q.app_id = $1 AND q.issue_number = w.n)`;

// The records progress.stageOf reads, as homeroom-bot-progress.js
// requestRows reads them for one person, for any requests of one project:
// `$1` the project, `$2` the request numbers. An open question is anybody's.
const REQUEST_ROWS_SQL = `
  SELECT a.id AS app_id, a.slug, a.name, w.n AS issue_number,
         (SELECT i.title FROM issues i WHERE i.app_id = a.id AND i.github_issue_number = w.n
           ORDER BY i.id DESC LIMIT 1) AS issue_title,
         FALSE AS first_version,
         q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason, q.held_until,
         run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
         run.cap_suppressed, run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
         run.live_build_waiting_at AS build_waiting_at, run.awaiting_go_at AS plan_waiting_at,
         run.review_state, run.review_started_at, run.review_round, run.review_max_rounds, run.review_minutes,
         run.no_change_said,
         bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
         bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
         spec.created_at AS spec_at,
         prop.proposal_session_id,
         CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS proposal_status,
         cs.pr_number AS proposal_pr_number,
         cs.check_state, cs.check_phase, cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
         cs.checks_commit_sha AS checks_sha, cs.reviewed_head_sha, cs.imported_pr_head_sha,
         cs.source AS proposal_source,
         COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.live_at AS merged_at,
         (COALESCE((SELECT ri.status = 'closed' FROM issues ri
                      WHERE ri.app_id = a.id AND ri.github_issue_number = w.n
                      ORDER BY ri.id DESC LIMIT 1), FALSE)
             OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                         WHERE cr.app_id = a.id AND cr.issue_number = w.n AND cr.closed_at IS NOT NULL)) AS request_closed,
         oq.created_at AS question_at
    FROM UNNEST($2::int[]) AS w(n)
    JOIN apps a ON a.id = $1
    LEFT JOIN homeroom_bot_queue q ON q.app_id = a.id AND q.issue_number = w.n
    LEFT JOIN LATERAL (
      SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
             proposal_session_id, live_build_waiting_at, awaiting_go_at,
             review->>'state' AS review_state, review->>'startedAt' AS review_started_at,
             jsonb_array_length(COALESCE(review->'rounds', '[]'::jsonb)) AS review_round,
             (review->'reviewer'->>'maxRounds')::int AS review_max_rounds,
             (review->'reviewer'->>'budgetMinutes')::int AS review_minutes,
             build_no_change->'turns'->-1->>'said' AS no_change_said
        FROM homeroom_bot_runs
       WHERE app_id = a.id AND issue_number = w.n AND mode = 'live'
       ORDER BY id DESC LIMIT 1
    ) run ON TRUE
    LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
    LEFT JOIN LATERAL (
      SELECT created_at FROM homeroom_bot_posts
       WHERE run_id = run.id AND kind = 'spec'
       ORDER BY id DESC LIMIT 1
    ) spec ON TRUE
    LEFT JOIN LATERAL (
      SELECT proposal_session_id FROM homeroom_bot_runs
       WHERE app_id = a.id AND issue_number = w.n AND proposal_session_id IS NOT NULL
       ORDER BY id DESC LIMIT 1
    ) prop ON TRUE
    LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
    LEFT JOIN LATERAL (
      SELECT created_at FROM homeroom_bot_dm_messages
       WHERE app_id = a.id AND issue_number = w.n AND question_status = 'open'
       ORDER BY created_at DESC LIMIT 1
    ) oq ON TRUE`;

// Every live run of those requests, newest first, for their tries.
const REQUEST_RUNS_SQL = `
  SELECT r.id, r.app_id, r.issue_number, r.verdict, r.cap_suppressed, r.awaiting_go_at, r.proposal_session_id,
         r.build_ok, r.build_error, r.build_session_id, r.error, r.created_at,
         (r.plan IS NOT NULL AND r.plan->'chosen' IS NULL AND r.build_ok IS FALSE
           AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL) AS plan_only
    FROM homeroom_bot_runs r
   WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[]) AND r.mode = 'live'
   ORDER BY r.id DESC`;

/**
 * Pure: one row of REQUEST_ROWS_SQL as the tray's entry for it would be,
 * so trackOf reads it the same way: its stage (progress.stageOf), and when
 * nothing about it is in hand, what its newest run came to (the tray's
 * outcomeOf).
 */
function jobOfRow(row, { now = new Date(), stageOf, outcomeOf, linksFor = null } = {}) {
  const live = row.mode === 'live' || !row.run_id;
  const state = live ? stageOf(row, { now }) : null;
  const outcome = state || !row.run_id ? null : outcomeOf({
    ...row,
    proposal_session_id: row.run_proposal,
    proposal_status: row.run_proposal && Number(row.run_proposal) === Number(row.proposal_session_id) ? row.proposal_status : null,
  });
  const n = Number(row.issue_number);
  const open = ['promoted', 'merging'].includes(row.proposal_status) ? Number(row.proposal_session_id) || null : null;
  return {
    key: `${row.slug}#${n}`,
    id: Number(row.run_id) || null,
    appSlug: row.slug,
    appName: row.name || row.slug,
    issueNumber: n,
    title: row.issue_title || null,
    firstVersion: false,
    stage: state ? state.stage : null,
    since: state ? iso(state.since) : null,
    at: iso(row.run_at),
    outcome,
    requestClosed: row.request_closed === true,
    proposalId: open,
    links: linksFor ? linksFor(row.slug, n, open, row.proposal_pr_number || null) : null,
  };
}

/**
 * The tracks of one project's requests `numbers`, whoever asked for them:
 * Map n → track, only for requests the bot has had anything to do with.
 * What the request page and the slots view draw. Never throws. `people`:
 * issueHolders' Map for the project, when the caller has read it already.
 */
async function tracksForRequests(pool, { appId, numbers, now = new Date(), deps = {}, people = null }) {
  const out = new Map();
  const asked = [...new Set((numbers || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!appId || !asked.length) return out;
  try {
    // A board's whole list comes through here: only the requests the bot has
    // read or queued are worth the full read below.
    const wanted = asked.length > 1
      ? (await pool.query(TOUCHED_SQL, [Number(appId), asked])).rows.map((row) => Number(row.n))
      : asked;
    if (!wanted.length) return out;
    const progress = deps.progress || require('./homeroom-bot-progress');
    const tray = deps.tray || require('./homeroom-bot-tray');
    const [{ rows }, { rows: runs }] = await Promise.all([
      pool.query(REQUEST_ROWS_SQL, [Number(appId), wanted]),
      pool.query(REQUEST_RUNS_SQL, [Number(appId), wanted]),
    ]);
    const bot = rows.filter((row) => row.run_id || row.queue_id);
    if (!bot.length) return out;
    const runsOf = new Map();
    for (const run of runs) {
      const n = Number(run.issue_number);
      if (!runsOf.has(n)) runsOf.set(n, []);
      runsOf.get(n).push(run);
    }
    const jobs = bot.map((row) => [row, jobOfRow(row, { now, stageOf: progress.stageOf, outcomeOf: tray.outcomeOf, linksFor: tray.linksFor })]);
    // 16 Oct 2026: what a build waiting its turn waits for, as its
    // requester's chat says it (homeroom-bot-progress.js buildWait): the
    // project's other builds, or nothing, so it starts next. Without it,
    // #5323 read "waiting its turn" on the slots page with every builder free.
    const queuedBuilds = jobs.filter(([, job]) => job.stage === 'build_queued');
    if (queuedBuilds.length && typeof progress.buildWait === 'function') {
      const busy = await progress.projectsBusy(pool, queuedBuilds.map(([row]) => row));
      for (const [row, job] of queuedBuilds) job.waitingFor = progress.buildWait(row, { busy, now }).waitingFor || null;
    }
    let held = new Map();
    if (jobs.some(([, job]) => job.outcome === 'held' || job.stage === 'held')) {
      // A held request a person has taken since reads as theirs (heldQueue).
      const holders = people || await (deps.botSvc || require('./homeroom-bot')).issueHolders(pool, appId);
      held = await heldQueue(pool, [appId], { takenBy: new Map([[Number(appId), holders]]) });
    }
    const closed = jobs.filter(([, job]) => job.requestClosed).map(([, job]) => ({ appId: Number(appId), n: job.issueNumber }));
    const doneBy = closed.length ? await doneByFor(pool, closed) : new Map();
    const until = jobs.some(([, job]) => job.stage === 'on_hold') ? (deps.limits || require('./limits')).weeklyResetAt() : null;
    for (const [row, job] of jobs) {
      const runsHere = (runsOf.get(job.issueNumber) || []).map((run) => (Number(run.id) === Number(row.run_id)
        ? { ...run, no_change_said: row.no_change_said } : run));
      out.set(job.issueNumber, trackOf({
        job,
        entry: null,
        runs: runsHere,
        held: held.get(`${appId}#${job.issueNumber}`) || null,
        doneBy: doneBy.get(`${appId}#${job.issueNumber}`) || null,
        until,
      }));
    }
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read a project\'s request tracks', { appId, err: err.message });
  }
  return out;
}

/**
 * Papote #3 (18 Oct 2026): a track as `viewerId` reads it on a page anyone
 * can open (the request's page). A track waiting on "you" waits on the
 * person who asked for it (`asker`: { userId, username }), so for anybody
 * else it names them (`waitingFor`): the page said "Waiting on you: Its plan
 * is ready for you to say Build it" to every member, beside a button that
 * said it waited for somebody else. Pure.
 */
function forViewer(track, asker, viewerId) {
  if (!track || track.waitingOn !== 'you' || !asker?.username) return track;
  if (Number(asker.userId) === Number(viewerId)) return track;
  return { ...track, waitingFor: asker.username };
}

// Who asked for each of `$2` on project `$1`, and the title the bot kept
// when it was filed (a request with no row of ours has no other).
const ASKERS_SQL = `
  SELECT q.issue_number, q.issue_title, u.username
    FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
   WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[])`;

async function askersFor(pool, appId, numbers) {
  const out = new Map();
  const list = [...new Set(numbers.map(Number).filter((n) => n > 0))];
  if (!list.length) return out;
  try {
    const { rows } = await pool.query(ASKERS_SQL, [Number(appId), list]);
    for (const row of rows) out.set(Number(row.issue_number), { username: row.username || null, title: row.issue_title || null });
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read who asked for the slots page', { appId, err: err.message });
  }
  return out;
}

/**
 * A project's open requests as GitHub lists them, from the shared cache
 * (services/github.js fetchPublicIssues): by number, and whether the list
 * is whole and fresh, the only kind that may say a request is not open.
 * Never throws; a project with no repository has none.
 */
async function openRequestsOf(app, deps = {}) {
  const repo = repoRef.ownerRepo(app?.repo_url);
  if (!repo) return { byNumber: new Map(), whole: false };
  try {
    const fetched = await (deps.github || require('./github')).fetchPublicIssues(repo.owner, repo.repo);
    const issues = Array.isArray(fetched?.issues) ? fetched.issues : [];
    return {
      byNumber: new Map(issues.map((issue) => [Number(issue.number), issue])),
      whole: !fetched?.note && !fetched?.stale && !fetched?.truncatedList,
    };
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not read the open requests for the slots page', { app: app?.slug, err: err.message });
    return { byNumber: new Map(), whole: false };
  }
}

/**
 * One project's bot slots, for the slots page under its Workshop: what
 * holds each of its PROPOSALS_PER_APP_CAP slots (homeroom-bot.js
 * slotHolders), the requests waiting for one in the order the bot takes
 * them up (heldQueue), the ones on hold until the week resets, how many
 * wait to be read, and the viewer's own building time this week. Every
 * request is carried with its track.
 */
async function slotsView(pool, { app, user = null, settings = null, deps = {} }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const live = deps.liveSvc || require('./homeroom-bot-live');
  const s = settings || await botSvc.readSettings(pool);
  const { rows: [bot] = [] } = await pool.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  const view = {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: !!s && s.mode !== 'off',
    acts: !!s && live.isLiveFor(s, app),
    paused: Array.isArray(s?.pausedApps) && s.pausedApps.includes(app.slug),
    cap: botSvc.PROPOSALS_PER_APP_CAP,
    buildsAtOnce: botSvc.BUILDS_PER_PROJECT || null,
    slots: [],
    waiting: [],
    taken: [],
    onHold: [],
    // 16 Oct 2026: every other open request, by where the bot is on it.
    waitingOn: [],
    upNext: [],
    stopped: [],
    leftToPeople: [],
    withPeople: 0,
    reading: 0,
    week: null,
  };
  if (!bot) return view;
  // The project's open requests as GitHub lists them (cached, as the board
  // reads them): each row's title and a line of what it asks, and, from a
  // whole fresh list, which held requests are still open at all.
  const open = await openRequestsOf(app, deps);
  const [holders, people, { rows: queue }] = await Promise.all([
    botSvc.slotHolders(pool, bot, app.id),
    botSvc.issueHolders(pool, app.id),
    pool.query(QUEUE_SQL, [app.id]),
  ]);
  const held = await heldQueue(pool, [app.id], {
    open: open.whole ? new Map([[Number(app.id), new Set(open.byNumber.keys())]]) : null,
    takenBy: new Map([[Number(app.id), people]]),
  });
  const mine = [...held.values()].filter((h) => h.appId === Number(app.id));
  const waiting = mine.filter((h) => h.position).sort((a, b) => a.position - b.position
    || Date.parse(a.since || 0) - Date.parse(b.since || 0));
  const taken = mine.filter((h) => h.limit === 'taken').sort((a, b) => Date.parse(a.since || 0) - Date.parse(b.since || 0));
  const onHold = queue.filter((q) => q.held_until && Date.parse(q.held_until) > Date.now());
  const numbers = [...holders.map((h) => Number(h.issue_number)), ...waiting.map((w) => w.issueNumber),
    ...taken.map((w) => w.issueNumber), ...onHold.map((q) => Number(q.issue_number))].filter((n) => n > 0);
  const [tracks, asked] = await Promise.all([
    tracksForRequests(pool, { appId: app.id, numbers, deps, people }),
    askersFor(pool, app.id, numbers),
  ]);
  // Who asked, its title and a line of it: GitHub's list first, then what
  // the bot kept when it was filed, then Homeroom's own row.
  const about = (n) => {
    const issue = open.byNumber.get(n);
    return {
      title: (issue?.title || asked.get(n)?.title || tracks.get(n)?.title || null),
      askedBy: asked.get(n)?.username || null,
      excerpt: requestExcerpt(issue?.body),
    };
  };
  view.slots = holders.map((h) => ({
    kind: h.kind,
    issueNumber: Number(h.issue_number) || null,
    ...about(Number(h.issue_number)),
    since: iso(h.since),
    track: tracks.get(Number(h.issue_number)) || null,
  }));
  view.waiting = waiting.map((w) => ({
    issueNumber: w.issueNumber, ...about(w.issueNumber), position: w.position, limit: w.limit, since: w.since,
    track: tracks.get(w.issueNumber) || null,
  }));
  view.taken = taken.map((w) => ({
    issueNumber: w.issueNumber, ...about(w.issueNumber), by: w.by, since: w.since,
    track: tracks.get(w.issueNumber) || null,
  }));
  view.onHold = onHold.map((q) => ({
    issueNumber: Number(q.issue_number), ...about(Number(q.issue_number)), until: iso(q.held_until),
    track: tracks.get(Number(q.issue_number)) || null,
  }));
  view.reading = queue.filter((q) => !q.started_at && !(q.held_until && Date.parse(q.held_until) > Date.now())).length;
  await placeTheRest(pool, view, { app, open, queue, people, tracks, asked, settings: s, deps, about, placed: new Set(numbers) });
  if (user?.id) {
    view.week = await (deps.buildingTime || require('./building-time')).weekFor(pool, Number(user.id), { settings: s })
      .then((w) => ({ limited: !!w.limited, usedShare: w.usedShare, usedUp: !!w.usedUp, resetsAt: w.resetsAt }))
      .catch(() => null);
  }
  return view;
}

// Where a track that is not in a slot or a line puts its request on the
// slots page: waiting on a person (a question, a plan's Build it, more
// detail, a look), stopped after trying, or left to people.
const LEFT_TO_PEOPLE = new Set(['needs_person', 'nothing_to_build']);
function restSection(track) {
  if (!track) return null;
  if (track.state === 'waiting') return 'waitingOn';
  if (track.state === 'queued' || track.state === 'planning') return 'upNext';
  if (track.state === 'stopped') return LEFT_TO_PEOPLE.has(track.why) ? 'leftToPeople' : 'stopped';
  return null;
}

// The most rows one of those sections carries.
const REST_LIMIT = 100;

/**
 * 16 Oct 2026: the slots page's other sections, filled into `view`: every
 * open request (the project's whole list from GitHub) that holds no slot
 * and waits in no line, by where the bot is on it. Up next is what the bot
 * reads next: what waits in its queue, then its older requests in the
 * order it takes them (homeroom-bot.js backlogFor), each with its place and
 * what its trial run made of it. A request a person holds is theirs, and
 * counted only (`withPeople`). Never throws; on a failure the page keeps
 * the sections above.
 */
async function placeTheRest(pool, view, { app, open, queue, people, tracks, asked, settings, deps, about, placed }) {
  try {
    const botSvc = deps.botSvc || require('./homeroom-bot');
    const openNumbers = [...open.byNumber.keys()].filter((n) => !placed.has(n));
    if (!openNumbers.length) return;
    const rest = openNumbers.filter((n) => !people.has(n));
    const isRest = new Set(rest);
    view.withPeople = openNumbers.length - rest.length;
    const more = await tracksForRequests(pool, { appId: app.id, numbers: rest.filter((n) => !tracks.has(n)), deps, people });
    const trackOfN = (n) => tracks.get(n) || more.get(n) || null;
    // Titles for the ones the first read did not ask about.
    const missing = rest.filter((n) => !asked.has(n));
    if (missing.length) for (const [n, a] of await askersFor(pool, app.id, missing)) asked.set(n, a);
    const row = (n, extra = {}) => ({ issueNumber: n, ...about(n), track: trackOfN(n), ...extra });
    const queued = new Set();
    // What waits in the bot's queue to be read, in its order.
    for (const q of queue) {
      const n = Number(q.issue_number);
      if (!isRest.has(n) || q.started_at || (q.held_until && Date.parse(q.held_until) > Date.now())) continue;
      queued.add(n);
      view.upNext.push(row(n, { kind: 'queued', since: iso(q.enqueued_at) }));
    }
    for (const n of rest) {
      if (queued.has(n)) continue;
      const section = restSection(trackOfN(n));
      if (section && section !== 'upNext') view[section].push(row(n, { since: trackOfN(n)?.since || null }));
    }
    // Then the older requests, where the bot acts.
    if (view.acts) {
      const issues = [...open.byNumber.values()];
      const older = await botSvc.backlogFor(pool, app, { issues, settings, holders: people });
      let position = 0;
      for (const p of older) {
        if (!isRest.has(p.n) || queued.has(p.n) || trackOfN(p.n)) continue;
        position += 1;
        view.upNext.push(row(p.n, { kind: 'older', position, trial: p.trial || null, since: iso(open.byNumber.get(p.n)?.createdAt) }));
      }
    }
    for (const key of ['waitingOn', 'upNext', 'stopped', 'leftToPeople']) view[key] = view[key].slice(0, REST_LIMIT);
  } catch (err) {
    log.warn('homeroom-bot-track', 'Could not place the rest of a project\'s requests', { app: app?.slug, err: err.message });
  }
}

// The project's rows in the bot's queue: being read, waiting to be, or on
// hold until its payer's week resets.
const QUEUE_SQL = `
  SELECT q.issue_number, q.started_at, q.enqueued_at, q.held_until
    FROM homeroom_bot_queue q
   WHERE q.app_id = $1
   ORDER BY q.enqueued_at, q.id`;

const BOT_USERNAME = 'homeroom_bot';

/**
 * Staging's demo slots, for `?demo=1`: a staging copy never runs the bot,
 * so the page could not be seen there. Obviously fake, written nowhere,
 * drawn with real tracks (trackOf) so it reads as the real page does. Its
 * rows are staging's own mock requests (`mocks`, routes/issues.js
 * stagingMockIssues), so a tap opens a request that is there; without them
 * the rows keep their numbers and titles.
 */
function demoSlots(app, now = Date.now(), mocks = []) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const mock = new Map((mocks || []).map((issue) => [Number(issue.number), issue]));
  const about = (n, fallback, askedBy) => ({
    title: mock.get(n)?.title || fallback, askedBy, excerpt: requestExcerpt(mock.get(n)?.body) || null,
  });
  const job = (n, title, fields) => ({ key: `demo#${n}`, appSlug: app.slug, appName: app.name || app.slug, issueNumber: n, title, ...fields });
  const track = (n, title, fields, extra = {}) => trackOf({ job: job(n, title, fields), ...extra });
  const slot = (kind, n, title, askedBy, fields, extra) => {
    const a = about(n, title, askedBy);
    return { kind, issueNumber: n, ...a, since: ago(60), track: track(n, a.title, fields, extra) };
  };
  const wait = (n, title, askedBy, position, minutes) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, position, limit: 'slots', since: ago(minutes),
      track: track(n, a.title, { outcome: 'held' }, { held: { position, limit: 'slots' } }) };
  };
  // Any other request: its track when the bot has one (`fields` null: none).
  const other = (n, title, askedBy, fields, extra = {}) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, since: fields?.since || null, track: fields ? track(n, a.title, fields, extra) : null };
  };
  const taken = (n, title, askedBy, by, minutes) => {
    const a = about(n, title, askedBy);
    return { issueNumber: n, ...a, by, since: ago(minutes),
      track: track(n, a.title, { outcome: 'held' }, { held: { position: null, limit: 'taken', by } }) };
  };
  return {
    app: { slug: app.slug, name: app.name || app.slug },
    botOn: true,
    acts: true,
    paused: false,
    cap: 5,
    buildsAtOnce: 3,
    slots: [
      slot('build', 900001, 'Staging demo: a total under the list', 'staging-demo-ana', { stage: 'building', since: ago(15) }),
      slot('build', 900003, 'Staging demo: darker buttons', 'staging-demo-ben', { stage: 'fixing', since: ago(4) }, {
        runs: [{ verdict: 'ready', created_at: ago(120) }],
      }),
      slot('proposal', 900006, 'Staging demo: a name for the bot', 'staging-demo-ana', { stage: 'vote', since: ago(300) }),
      slot('proposal', 900002, 'Staging demo: smaller app names', 'staging-demo-cy', { stage: 'checks', since: ago(20) }),
      slot('proposal', 900015, 'Staging demo: keep the vote history', 'staging-demo-ben', { stage: 'question', since: ago(10) }),
    ],
    waiting: [
      wait(900009, 'Staging demo: rethink challenges', 'staging-demo-cy', 1, 200),
      wait(900010, 'Staging demo: a screenshot in the request', 'staging-demo-ana', 2, 90),
    ],
    taken: [
      taken(900014, 'Staging demo: somebody started this', 'staging-demo-ben', 'maya-builder', 60 * 26),
    ],
    onHold: [],
    // 16 Oct 2026: the other open requests, by where the bot is on them.
    waitingOn: [
      other(900016, 'Staging demo: a plan to build', 'staging-demo-cy', { stage: 'plan', since: ago(60 * 20) }),
      other(900008, 'Staging demo: which page?', 'staging-demo-ana', { stage: 'question', since: ago(45) }),
    ],
    upNext: [
      { ...other(900032, 'Staging demo: just filed', 'staging-demo-ben', { stage: 'queued', since: ago(3) }), kind: 'queued' },
      { ...other(900004, 'Staging demo: an older request', null, null), kind: 'older', position: 1, trial: 'ready', since: ago(60 * 24 * 12) },
      { ...other(900005, 'Staging demo: another older one', null, null), kind: 'older', position: 2, trial: null, since: ago(60 * 24 * 15) },
    ],
    stopped: [
      other(900007, 'Staging demo: built nothing', 'staging-demo-cy', { outcome: 'build_failed' }, {
        runs: [{ verdict: 'ready', created_at: ago(60 * 30), build_ok: false, build_error: 'the build produced no change to propose' }],
      }),
    ],
    leftToPeople: [
      other(900013, 'Staging demo: needs a decision', 'staging-demo-ana', { outcome: 'person' }),
    ],
    withPeople: 3,
    reading: 1,
    week: { limited: true, usedShare: 0.62, usedUp: false, resetsAt: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString() },
  };
}

/**
 * Staging's demo request track, for the mock request the bot is building
 * (routes/issues.js, #900018): its second try, fifteen minutes in. Pure.
 */
function demoRequestTrack(app, number, title, now = Date.now()) {
  return trackOf({
    job: {
      key: `${app.slug}#${number}`, appSlug: app.slug, appName: app.name || app.slug,
      issueNumber: number, title: title || null, stage: 'building', since: new Date(now - 15 * 60 * 1000).toISOString(),
    },
    runs: [{ verdict: 'ready', created_at: new Date(now - 26 * 60 * 60 * 1000).toISOString() },
      { verdict: 'ready', created_at: new Date(now - 16 * 60 * 1000).toISOString() }],
  });
}

module.exports = {
  STATES,
  STEPS,
  ENDED,
  CAP_LIMITS,
  fromStage,
  fromOutcome,
  buildStopWhy,
  noChangeWhy,
  triesOf,
  tryStartsOf,
  trackOf,
  HELD_QUEUE_SQL,
  heldQueue,
  DONE_BY_SQL,
  doneByFor,
  withTracks,
  TOUCHED_SQL,
  REQUEST_ROWS_SQL,
  REQUEST_RUNS_SQL,
  QUEUE_SQL,
  jobOfRow,
  tracksForRequests,
  forViewer,
  slotsView,
  demoSlots,
  requestExcerpt,
  openRequestsOf,
  restSection,
  placeTheRest,
  ASKERS_SQL,
  demoRequestTrack,
};
