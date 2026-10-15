'use strict';

// A promoted proposal stuck on a check that MAIN failed, after main has been
// fixed.
//
// A preview builds the proposal's own code, fixtures and seeds included, so
// a check broken on main fails on every proposal whose branch has main's
// broken copy, and a fix landing on main changes none of their verdicts.
// On 9 Oct 2026 the Custom domain check (#4405) failed on every proposal
// because its staging fixture made the wrong account the project's manager.
// The fix (#4576) merged, and about fifteen proposals, several of them
// approved, stayed red on it: a re-run builds the same branch, and the
// "Sync with main" that would have fixed each is its owner's button, which
// nobody presses on the Homeroom bot's. They waited until somebody noticed.
//
// The merge queue does not bring a clean proposal up to date, on purpose
// (services/merge-queue.js): a proposal is judged on its own head, and a
// sync plus a full re-run per open proposal per merge is the herd #2100
// removed. services/boot-failure-sync.js is the first exception, for a
// preview that will not start because main moved. This is the second, and
// it is as narrow:
//
//   - the proposal is promoted, the platform's to push to (not imported),
//     and its checks settled 'failing' on its current head;
//   - every check that blocks it, the unit-suite row aside, passed on the
//     last merged proposal that ran it (main passes it now), and fails on at
//     least MIN_FAILING open proposals (so it is main's failure, not this
//     change's). The unit-suite row is one row for thousands of tests, so it
//     says nothing about which; a failure in it neither counts as fixed nor
//     stops the sync, whose new run re-tests it on a head containing main;
//   - or the unit-suite row is all that blocks it, and main watch (the same
//     suite on main itself) has passed SINCE that proposal's run: main moved
//     on and is green, so a failure the proposal's older branch carried may
//     well be main's (10 Oct 2026: five challenge tests failed every weekend
//     until #4648; two approved Homeroom bot proposals cut before it stayed
//     red on them, with nobody able to sync them), or has passed on main's
//     tip as it stands, which the proposal is behind (mainGreenAtTip). Once
//     per main tip, and at most MAX_UNIT_SYNCS times: a suite that still
//     fails on a head containing main fails on the proposal's own code AS
//     OF THAT MAIN, and a later main may fix the very test (11 Oct 2026: the
//     translation proposal #4764 was synced onto a main without #4767, the
//     fix of the one test it failed, and stayed red with two yes votes after
//     #4767 merged, its one sync spent and nobody able to press Sync);
//   - it is behind main and merges with it cleanly (services/integration.js);
//   - at most once per head, and at most once per named check: a check it
//     was synced for that still fails once it contains main is its own
//     failure (fixed_check_sync_keys), and waits for a person.
//
// A clean sync is a mechanical merge, so the approval epoch does not move
// and the votes the proposal has keep counting (services/pr-vote-revision.js).
//
// It runs as a leader-only sweep every INTERVAL_MS, rather than from each
// path a merge can take, so a proposal that was stuck before it existed is
// found on its first pass.
//
// The Homeroom bot asks for one more, syncBeforeHandOff below: before it
// hands a red check on one of its proposals to a person, the proposal is
// brought up to date with main once, without waiting for main watch. Its fix
// turn has read the failure and found it is not the change's own; what it
// cannot tell is whether main has fixed it since. PR #4851 sat red from
// 12 Oct on a test #4843 had fixed on main, 182 commits behind and merging
// cleanly, its 18 yes votes waiting, because main watch never read green.
// The same claim, so the sweep and the bot never both sync one head.

const appManifest = require('./app-manifest');
const { isUnitSuiteRow, UNIT_CHECK_NAME, UNIT_CHECK_PATH } = require('./unit-suite-row');
const log = require('./logger');

const INTERVAL_MS = 5 * 60 * 1000;
// The first pass waits for the new leader to settle: it dispatches worker
// turns, and the release that made this process the leader is still rolling.
const FIRST_PASS_DELAY_MS = 60 * 1000;
// What main passes is read off the final runs of the last few merged
// proposals: the newest of them that ran a check decides it.
const RECENT_MERGES = 5;
// Two proposals failing the same check is the least that says the check,
// not one change, is what broke. One alone is that change's to fix.
const MIN_FAILING = 2;
// A sync dispatches a worker and its new head takes a checks slot, so one
// pass starts no more than the checks queue runs at once.
const MAX_SYNCS_PER_PASS = 4;
// A proposal failing only the unit suite is synced at most this many times
// in all, each with a main that moved on and is green: one whose own change
// breaks a test costs at most two runs more than it did when it was once.
const MAX_UNIT_SYNCS = 3;

function isEnabled() {
  const v = String(process.env.FIXED_CHECK_SYNC_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function keyOf(r) {
  return appManifest.checkKey(r.name, r.path);
}

// Required lazily: a sync needs the worker and the merge queue loaded, and
// the pure selection below needs neither.
function defaultDeps() {
  return {
    get integration() { return require('./integration'); },
    get syncMain() { return require('./sync-main'); },
    get activeWorkers() { return require('./active-workers'); },
    get mergeQueue() { return require('./merge-queue'); },
    votes: () => require('../routes/votes'),
  };
}

// The checks main passes now, as keys: for each check, the newest result
// among the final runs of the app's last RECENT_MERGES merged proposals.
async function mainPasses(pool, appId) {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT test_results, merged_at
         FROM chat_sessions
        WHERE app_id = $1 AND status = 'merged' AND merged_at IS NOT NULL
          AND jsonb_typeof(test_results) = 'array' AND jsonb_array_length(test_results) > 0
        ORDER BY merged_at DESC
        LIMIT $2
     )
     SELECT DISTINCT ON (t->>'name', COALESCE(t->>'path', ''))
            t->>'name' AS name, t->>'path' AS path, t->>'status' AS status
       FROM recent r CROSS JOIN LATERAL jsonb_array_elements(r.test_results) t
      ORDER BY t->>'name', COALESCE(t->>'path', ''), r.merged_at DESC`,
    [appId, RECENT_MERGES]
  );
  const out = new Set();
  for (const r of rows) if (r.status === 'pass') out.add(keyOf(r));
  return out;
}

// Every promoted proposal of the app with the checks its current verdict
// failed (blocking or advisory), and what the selection needs to know about
// it. The JSON is unpacked here so a sweep never loads whole verdicts.
async function openVerdicts(pool, appId) {
  const { rows } = await pool.query(
    `SELECT cs.id, cs.source, cs.check_state, cs.checks_commit_sha, cs.reviewed_head_sha,
            cs.checks_checked_at, cs.fixed_check_sync_head, cs.fixed_check_sync_keys,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                       'name', t->>'name', 'path', t->>'path', 'index', t->'index',
                       'advisory', COALESCE(t->>'advisory', 'false') = 'true'))
                FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(cs.test_results) = 'array' THEN cs.test_results ELSE '[]'::jsonb END) t
               WHERE t->>'status' IS DISTINCT FROM 'pass'
            ), '[]'::jsonb) AS failing
       FROM chat_sessions cs
      WHERE cs.app_id = $1 AND cs.status = 'promoted'
      ORDER BY cs.id`,
    [appId]
  );
  return rows;
}

// Main watch's latest verdict for the app (services/main-watch.js): whether
// the unit suite last passed on main, when, on which commit, and main's tip
// now. { passing, at, sha, tip } or null.
async function mainWatchVerdict(pool, appId) {
  const { rows } = await pool.query(
    'SELECT main_check_state, main_check_at, main_check_sha, main_sha FROM apps WHERE id = $1',
    [appId]
  );
  const row = rows[0];
  if (!row) return null;
  const at = row.main_check_at ? Date.parse(row.main_check_at) : NaN;
  return {
    passing: row.main_check_state === 'passing',
    at: Number.isFinite(at) ? at : null,
    sha: row.main_check_sha || null,
    tip: row.main_sha || null,
  };
}

// The unit suite's own key, as fixed_check_sync_keys records it.
const UNIT_KEY = appManifest.checkKey(UNIT_CHECK_NAME, UNIT_CHECK_PATH);

// A sync for the unit suite is recorded with main's tip as main watch knew it
// when the sync was chosen, `<UNIT_KEY>@<tip>`, so one main is never a reason
// twice and the syncs can be counted. A bare UNIT_KEY was recorded before
// this (or with no tip known): it counts, and names no main.
function unitSyncKey(tip) {
  return tip ? `${UNIT_KEY}@${String(tip).toLowerCase()}` : UNIT_KEY;
}

function unitSyncCount(tried) {
  let n = 0;
  for (const k of tried) if (k === UNIT_KEY || String(k).startsWith(`${UNIT_KEY}@`)) n += 1;
  return n;
}

// Main watch passed after this proposal's checks ran: main has moved on since
// the run and is green.
function mainGreenSince(row, mainWatch) {
  if (!mainWatch || !mainWatch.passing || !mainWatch.at) return false;
  const ran = row.checks_checked_at ? Date.parse(row.checks_checked_at) : NaN;
  return Number.isFinite(ran) && mainWatch.at > ran;
}

// Main watch passed on main's tip as it stands. A proposal behind that tip
// (syncOne measures it, and leaves one level with main alone) lacks commits
// of a main that is green, whenever its own run was: the other way a
// failure its older branch carried may be main's. On 10 Oct 2026 five
// approved proposals failed one unit test that #4720 had fixed on main. Main
// watch passed on the fix's release at 21:32 and their re-runs ended at
// 21:43, with nothing ready to merge after them, so the rule above alone
// left them red until somebody synced each by hand.
function mainGreenAtTip(mainWatch) {
  return !!mainWatch && mainWatch.passing && sameSha(mainWatch.sha, mainWatch.tip);
}

/**
 * Which of an app's promoted proposals are stuck on checks main has fixed.
 * Pure: `rows` from openVerdicts, `passes` from mainPasses, `mainWatch`
 * from mainWatchVerdict.
 *
 * @returns {{ candidates: Array<{ id: number, head: string, keys: string[] }>,
 *             skipped: Record<number, string> }}
 */
function select(rows, passes, mainWatch = null) {
  const failingOn = new Map();
  for (const row of rows || []) {
    for (const f of row.failing || []) {
      if (isUnitSuiteRow(f)) continue;
      const key = keyOf(f);
      failingOn.set(key, (failingOn.get(key) || 0) + 1);
    }
  }
  const candidates = [];
  const skipped = {};
  for (const row of rows || []) {
    const id = Number(row.id);
    if (row.check_state !== 'failing') continue;
    const head = row.checks_commit_sha ? String(row.checks_commit_sha).toLowerCase() : null;
    const why = (() => {
      if (row.source === 'imported') return 'imported';
      if (!head) return 'no_verdict';
      // The verdict is about an older commit: the current head has its own.
      if (row.reviewed_head_sha && !sameSha(row.reviewed_head_sha, head)) return 'head_moved';
      if (sameSha(row.fixed_check_sync_head, head)) return 'already_tried';
      return null;
    })();
    if (why) { skipped[id] = why; continue; }
    const blocking = (row.failing || []).filter((f) => !f.advisory && !isUnitSuiteRow(f));
    const tried = new Set(row.fixed_check_sync_keys || []);
    if (!blocking.length) {
      const unitBlocks = (row.failing || []).some((f) => !f.advisory && isUnitSuiteRow(f));
      if (!unitBlocks) { skipped[id] = 'nothing_fixed'; continue; }
      // Synced as often as it gets, with this main already, or before with a
      // main nobody can tell this one from: it waits for main to move on.
      const synced = unitSyncCount(tried);
      const tip = mainWatch && mainWatch.tip ? String(mainWatch.tip).toLowerCase() : null;
      if (synced >= MAX_UNIT_SYNCS || tried.has(unitSyncKey(tip)) || (synced && !tip)) {
        skipped[id] = 'already_tried';
        continue;
      }
      if (!mainGreenSince(row, mainWatch) && !mainGreenAtTip(mainWatch)) { skipped[id] = 'unit_suite_only'; continue; }
      candidates.push({ id, head, keys: [unitSyncKey(tip)] });
      continue;
    }
    const keys = [];
    let reason = null;
    for (const f of blocking) {
      const key = keyOf(f);
      if (!passes.has(key)) { reason = 'main_fails'; break; }
      if ((failingOn.get(key) || 0) < MIN_FAILING) { reason = 'own_failure'; break; }
      if (tried.has(key)) { reason = 'already_tried'; break; }
      keys.push(key);
    }
    if (reason) { skipped[id] = reason; continue; }
    candidates.push({ id, head, keys });
  }
  return { candidates, skipped };
}

async function loadRow(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// The one write that makes this once per head and once per check.
// Conditional on the row still describing the failing commit, so a push that
// landed meanwhile, or a second process, finds nothing to claim.
async function claim(pool, sessionId, head, keys) {
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET fixed_check_sync_head = $2,
            fixed_check_sync_keys = ARRAY(
              SELECT DISTINCT k FROM unnest(COALESCE(fixed_check_sync_keys, '{}'::text[]) || $3::text[]) AS k ORDER BY k)
      WHERE id = $1 AND status = 'promoted' AND check_state = 'failing'
        AND LOWER(checks_commit_sha) = $2
        AND fixed_check_sync_head IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, head, keys]
  );
  return rows.length > 0;
}

/**
 * Bring one stuck proposal up to date with main and start the run for its
 * new head. Skips rather than waits when its session is busy: the next pass
 * finds it again. Never throws; resolves to what happened.
 */
async function syncOne({ config, pool, candidate }, deps = defaultDeps()) {
  const id = Number(candidate.id);
  try {
    if (deps.activeWorkers.isSessionBusy(id)) return { synced: false, why: 'busy' };
    if (deps.mergeQueue.isIntegratingSession(id)) return { synced: false, why: 'integrating' };
    const row = await loadRow(pool, id);
    if (!row || row.status !== 'promoted') return { synced: false, why: 'gone' };
    if (!sameSha(row.checks_commit_sha, candidate.head)) return { synced: false, why: 'head_moved' };
    const measured = await deps.integration.measure({ pool, session: row }, { force: true });
    if (!measured || measured.error || measured.skipped) return { synced: false, why: 'unmeasured' };
    if (!sameSha(measured.headSha, candidate.head)) return { synced: false, why: 'head_moved' };
    const behindBy = Number.isFinite(measured.behindBy) ? measured.behindBy : null;
    if (behindBy == null) return { synced: false, why: 'unmeasured' };
    // It already contains main and still fails: the failure is its own.
    if (behindBy === 0) return { synced: false, why: 'level' };
    if (measured.mergesClean !== true) return { synced: false, why: 'conflict' };
    if (!(await claim(pool, id, candidate.head, candidate.keys))) return { synced: false, why: 'claimed' };

    const trigger = candidate.trigger || 'fixed_on_main';
    log.info('fixed-check-sync', trigger === BOT_HANDOFF_TRIGGER
      ? 'The Homeroom bot would hand a proposal\'s red checks to a person; syncing it with main first'
      : 'A proposal fails only checks main now passes; syncing it', {
      sessionId: id, headSha: candidate.head, behindBy, checks: candidate.keys.length, trigger,
    });
    const result = await deps.syncMain.runSyncMain(config, pool, id, {
      // As boot-failure-sync: behind_main is a turn's count, which a
      // proposal untouched since promotion may never have had, so the sync
      // is told the measured one and says what it is doing.
      sessionRow: { ...row, behind_main: behindBy },
      trigger,
    });
    const pushed = !!result && result.pushOk
      && (result.syncResult === 'clean' || result.syncResult === 'resolved');
    if (!pushed) {
      log.info('fixed-check-sync', 'Sync for a check main fixed pushed nothing', {
        sessionId: id, syncResult: result ? result.syncResult : null,
      });
      return { synced: false, why: (result && result.syncResult) || 'not_pushed' };
    }
    // What the merge queue does after its own sync: measure the pushed head
    // so the columns describe it, then install it as the reviewed revision
    // and start its run. A mechanical merge keeps the approvals.
    try {
      const fresh = await loadRow(pool, id);
      if (fresh && fresh.status === 'promoted') {
        await deps.integration.measure({ pool, session: fresh }, { force: true }).catch(() => {});
        await deps.votes().reconcileNativeReviewedHead({
          config, pool, session: fresh, fresh: true, notify: false,
        });
      }
    } catch (err) {
      log.warn('fixed-check-sync', 'Synced, but could not start the new head\'s run', {
        sessionId: id, err: err.message,
      });
    }
    return { synced: true, why: null, sha: result.sha || null };
  } catch (err) {
    log.warn('fixed-check-sync', 'Sync for a check main fixed failed', { sessionId: id, err: err.message });
    return { synced: false, why: 'threw' };
  }
}

// The Homeroom bot's own sync (homeroom-bot.js runChecksFix): recorded beside
// the sweep's keys, so it is once per proposal, and claimed on the head the
// same way.
const BOT_HANDOFF_KEY = 'homeroom_bot:handoff';
const BOT_HANDOFF_TRIGGER = 'bot_handoff';

/**
 * Before the Homeroom bot hands the red checks on its proposal `sessionId`
 * to a person: bring the proposal up to date with main once, if it is behind
 * main and merges with it cleanly, and start the run for its new head
 * (syncOne). `head` is the failing head its fix turn looked at. Never twice
 * for one proposal: a check that still fails once it contains main is handed
 * over as before. Never throws; resolves { synced, why }.
 */
async function syncBeforeHandOff({ config, pool, sessionId, head }, deps = defaultDeps()) {
  const id = Number(sessionId);
  if (!isEnabled()) return { synced: false, why: 'disabled' };
  if (!(id > 0) || !head) return { synced: false, why: 'no_verdict' };
  try {
    const { rows } = await pool.query('SELECT fixed_check_sync_keys FROM chat_sessions WHERE id = $1', [id]);
    if (!rows[0]) return { synced: false, why: 'gone' };
    if ((rows[0].fixed_check_sync_keys || []).includes(BOT_HANDOFF_KEY)) return { synced: false, why: 'already_tried' };
  } catch (err) {
    log.warn('fixed-check-sync', 'Could not read a proposal\'s syncs before a hand-off', { sessionId: id, err: err.message });
    return { synced: false, why: 'threw' };
  }
  return syncOne({
    config, pool,
    candidate: { id, head: String(head).toLowerCase(), keys: [BOT_HANDOFF_KEY], trigger: BOT_HANDOFF_TRIGGER },
  }, deps);
}

/**
 * One pass over every app with a promoted proposal whose checks are
 * failing. Syncs at most MAX_SYNCS_PER_PASS, one at a time. Never throws.
 */
async function sweep({ config, pool, shouldStop = () => false }, deps = defaultDeps()) {
  const result = { apps: 0, candidates: 0, synced: [], skipped: {} };
  let apps;
  try {
    ({ rows: apps } = await pool.query(
      `SELECT DISTINCT app_id FROM chat_sessions
        WHERE status = 'promoted' AND check_state = 'failing'
        ORDER BY app_id`
    ));
  } catch (err) {
    log.warn('fixed-check-sync', 'Could not list proposals with failing checks', { err: err.message });
    return result;
  }
  for (const { app_id: appId } of apps) {
    if (shouldStop() || result.synced.length >= MAX_SYNCS_PER_PASS) break;
    result.apps += 1;
    let picked;
    try {
      picked = select(await openVerdicts(pool, appId), await mainPasses(pool, appId),
        await mainWatchVerdict(pool, appId));
    } catch (err) {
      log.warn('fixed-check-sync', 'Could not read an app\'s verdicts', { appId, err: err.message });
      continue;
    }
    Object.assign(result.skipped, picked.skipped);
    result.candidates += picked.candidates.length;
    for (const candidate of picked.candidates) {
      if (shouldStop() || result.synced.length >= MAX_SYNCS_PER_PASS) break;
      const done = await syncOne({ config, pool, candidate }, deps);
      if (done.synced) result.synced.push(candidate.id);
      else result.skipped[candidate.id] = done.why;
    }
  }
  return result;
}

let timer = null;
let firstPass = null;
let inFlight = null;
function start(config, pool) {
  if (timer || !isEnabled() || !pool) return;
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = sweep({ config, pool, shouldStop: () => timer === null })
      .then((result) => {
        if (result.candidates) log.info('fixed-check-sync', 'Fixed-on-main sweep', result);
      })
      .catch((err) => log.warn('fixed-check-sync', 'Fixed-on-main sweep stopped', { err: err.message }))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  firstPass = setTimeout(run, FIRST_PASS_DELAY_MS);
  firstPass.unref();
}

async function stop() {
  clearInterval(timer);
  clearTimeout(firstPass);
  timer = null;
  firstPass = null;
  await inFlight;
}

module.exports = {
  select,
  sweep,
  syncOne,
  syncBeforeHandOff,
  BOT_HANDOFF_KEY,
  mainPasses,
  openVerdicts,
  mainWatchVerdict,
  UNIT_KEY,
  unitSyncKey,
  start,
  stop,
  isEnabled,
  INTERVAL_MS,
  RECENT_MERGES,
  MIN_FAILING,
  MAX_SYNCS_PER_PASS,
  MAX_UNIT_SYNCS,
};
