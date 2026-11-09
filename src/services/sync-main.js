'use strict';

// "Sync with main": the worker merges the app's main into a proposal's
// branch (Claude resolves a conflict), pushes, and the proposal takes the
// pushed head as its revision.
//
// Every sync is the proposal machine's `branch.sync` work
// (src/workflow/proposal/), whoever asks for it: a person ("Sync with main",
// the connector's sync_change, the CLI), a resume of a session behind main,
// the merge queue's conflict lane, a preview that will not start because
// main moved (boot-failure-sync.js) and a check main has fixed since
// (fixed-check-sync.js, the Homeroom bot). The machine decides whether it may
// run (never while the proposal is merged or being merged, never two at
// once, the platform's own syncs once per head), and writes the record of
// having tried in the same transaction as the work; this file only does it.
//
// The worker turn is a durable step over the work item's checkpoint
// (services/durable-turn.js): a restart follows the turn the worker still
// runs, and then does what comes after it, so nothing a sync owes is lost to
// a release (merge trace bug 10). What comes after is run once
// (steps.once): the drift and conflict snapshots, the system-token spend, the
// protected-settings re-stamp, the hand-off's pins, the timeline's last line,
// and, for a proposal in review, its new head installed as the reviewed
// revision with its checks started.

const log = require('./logger');
const worker = require('./worker');
const limits = require('./limits');
const events = require('./events');
const repoRef = require('./repo-ref');

// The worker's "[sync_*]" phase markers, as the timeline's progress lines
// and as the banner's coarse phases (merging → resolving → pushing).
const SYNC_PROGRESS_LABELS = new Map([
  ['sync_fetch_main', 'Fetching main…'],
  ['sync_merge', 'Merging origin/main…'],
  ['sync_conflict_cc', 'Resolving conflicts with Claude…'],
  ['sync_push', 'Pushing…'],
]);
const SYNC_PHASE_MAP = new Map([
  ['sync_fetch_main', 'merging'],
  ['sync_merge', 'merging'],
  ['sync_conflict_cc', 'resolving'],
  ['sync_push', 'pushing'],
]);

// A sync turn's clock: a mechanical merge takes seconds, a resolution a few
// minutes.
const SYNC_BUDGET_MS = 20 * 60 * 1000;

// #8: persist the latest behind-origin/main count for a session and
// broadcast a session_update so the dev-chat banner refreshes live. A count
// for display: nothing decides on it (the merge reads the mirror's
// measurement, services/integration.js). Best-effort.
async function persistBehindMain(pool, session, behind) {
  try {
    const n = Number.isFinite(behind) ? Math.max(0, behind) : 0;
    await pool.query(
      'UPDATE chat_sessions SET behind_main = $1 WHERE id = $2',
      [n, session.id]
    );
    try {
      const { pushSessionUpdate } = require('./ws');
      pushSessionUpdate({
        action: 'behind_main',
        sessionId: session.id,
        appSlug: session.app_slug || null,
        behindMain: n,
      });
    } catch (_) { /* ws failures are non-fatal */ }
  } catch (err) {
    log.warn('sync-main', 'persistBehindMain failed', { sessionId: session?.id, err: err.message });
  }
}

// #361: the merge-conflict snapshot proposal cards show (merge_conflict_state
// + conflict_files + conflict_checked_at). state ∈ clean | conflict | failed.
// Best-effort, for display.
async function persistConflictState(pool, session, { state, files }) {
  try {
    await pool.query(
      `UPDATE chat_sessions
         SET merge_conflict_state = $1,
             conflict_files = $2::jsonb,
             conflict_checked_at = NOW()
       WHERE id = $3`,
      [state || null, JSON.stringify(Array.isArray(files) ? files : []), session.id]
    );
  } catch (err) {
    log.warn('sync-main', 'persistConflictState failed', { sessionId: session?.id, err: err.message });
  }
}

// A platform sync's wait for the session to be free (the old boot-failure
// sync's waitForIdle): somebody's turn, a local agent's, or a live operation
// on the session, read as the proposal machine reads them.
const IDLE_POLL_MS = 3000;
const IDLE_WAIT_MS = 10 * 60 * 1000;
async function sessionBusy(pool, sessionId) {
  const { botLookingSql, buildHoldSql, operationsLiveSql, shotsRunningSql } = require('../workflow/session-work.ts');
  const { rows: [r] } = await pool.query(
    `SELECT cs.active_turn IS NOT NULL
            OR EXISTS (SELECT 1 FROM local_agent_turns t
                        WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running'))
            OR ${operationsLiveSql('cs.id')}
            OR ${shotsRunningSql('cs.id')}
            OR ${buildHoldSql('cs')}
            OR ${botLookingSql('cs.id')} AS busy
       FROM chat_sessions cs WHERE cs.id = $1`, [sessionId]);
  return !!r?.busy;
}

// Read by GET /api/sessions/:id/status for reload recovery and the client's
// poll fallback: the proposal machine's sync under way, or null.
async function getSyncState(pool, sessionId) {
  try {
    const { rows: [i] } = await pool.query(
      `SELECT data->'sync' AS sync FROM wf_instances WHERE machine = 'proposal' AND key = $1`, [`session:${Number(sessionId)}`]);
    const sync = i && i.sync && typeof i.sync === 'object' ? i.sync : null;
    // The live phase travels by push (broadcastSyncStatus); a poll knows only
    // that a sync runs ('starting'), which the client never lets overwrite
    // a phase it heard.
    return sync ? { phase: 'starting', startedAt: sync.at ? Date.parse(sync.at) : null, reason: sync.reason || null } : null;
  } catch {
    return null;
  }
}

// #252: lifecycle broadcast for the dev-chat sync banner. Same
// session_update channel as behind_main; clients key on
// action='sync_status'. state ∈ starting | merging | resolving |
// pushing | done | failed; terminal events carry syncResult/message.
function broadcastSyncStatus(session, state, extra = {}) {
  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'sync_status',
      sessionId: session.id,
      appSlug: session.app_slug || null,
      state,
      ...extra,
    });
  } catch (_) { /* ws failures are non-fatal */ }
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

const TRIGGERS = new Map([
  ['person', 'manual'], ['resume', 'resume_autosync'], ['conflict', 'merge_queue'], ['boot_failure', 'boot_failure'],
  ['fixed_check', 'fixed_on_main'], ['bot_fix', 'bot_fix'], ['bot_handoff', 'bot_handoff'],
  // #6546: an approved change GitHub refused over failed required checks.
  ['github_checks', 'github_checks'],
  // A stacked import whose parent landed, moved onto main (rules/pr-base.ts).
  ['parent_merged', 'parent_merged'],
]);

/**
 * The proposal machine's `branch.sync` work. `steps` is the work item's
 * durable context (services/durable-steps.js durable()). Resolves one
 * outcome for the machine:
 *   gone | unmeasured | level | conflict_skipped (a platform sync whose
 *   proposal no longer is behind and clean: nothing ran) | clean_now (the
 *   conflict lane's head merges cleanly by now: nothing ran) | over_budget
 *   (the system token budget is spent: nothing ran) |
 *   clean | resolved | already_synced (synced) | not_pushed |
 *   unresolvable (Claude could not resolve it: the branch is unchanged)
 * with { sha, behind, pushOk, conflictFiles, message, headBefore, mainSha }.
 * Throws when the machinery under it failed (the worker, the budget, the
 * push of a hand-off's revision), which the machine backs off from.
 */
async function runSyncWork(config, pool, {
  sessionId, reason, measureFirst = false, waitForIdle = false, githubConflict = false, last = true, steps,
  // The proposal machine's branch.sync item that runs this (turn-lifecycle
  // turnOwner): on the turn's record, so the turn is that item's in every
  // process, and a Stop is an event to the proposal machine.
  owner = null,
}, injected = {}) {
  const deps = {
    worker, limits, events, integration: require('./integration'), durableTurn: require('./durable-turn'),
    votes: () => require('../routes/votes'), prImportSync: () => require('./pr-import-sync'),
    codeMissing: require('./code-missing'),
    sessionBusy, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    ...injected,
  };
  const id = Number(sessionId);
  // A platform sync for a head (a boot failure, a failing check) waits for
  // whoever is working on the session, up to IDLE_WAIT_MS, as the old one
  // did; still busy, it did nothing (the machine gives the once-record back).
  if (waitForIdle && !steps.has('started')) {
    const until = deps.now() + IDLE_WAIT_MS;
    while (await deps.sessionBusy(pool, id)) {
      if (steps.stopped) throw Object.assign(new Error('stopped'), { code: 'steps_stopped' });
      if (deps.now() >= until) return { outcome: 'busy' };
      await deps.sleep(IDLE_POLL_MS);
    }
  }
  let session = await loadSession(pool, id);
  if (!session) return { outcome: 'gone' };
  if (!session.repo_url || !session.branch_name) return { outcome: 'gone' };
  const m = repoRef.ownerRepo(session.repo_url);
  if (!m) return { outcome: 'gone' };
  const { owner: repoOwner, repo: repoName } = m;
  // Its branch did not come across when Homeroom moved off GitHub
  // (code-missing.js branchGone, read live): there is nothing to merge main
  // into, so nothing runs and nothing is recorded about conflicts. Asked
  // only before the turn starts; a sync a restart picks up goes on.
  if (!steps.has('started') && await deps.codeMissing.branchGone(pool, session) === true) {
    return { outcome: deps.codeMissing.CODE, message: deps.codeMissing.BRANCH_GONE };
  }

  // The platform's own syncs for a failure main may have caused: only a head
  // behind main that merges with it cleanly is synced (boot-failure-sync.js,
  // fixed-check-sync.js), measured from the mirror now.
  let measured = steps.get('measured') || null;
  if (!measured) {
    const now = await deps.integration.measure({ pool, session }, { force: true }).catch(() => null);
    measured = now && !now.error && !now.skipped
      ? { behindBy: Number.isFinite(now.behindBy) ? now.behindBy : null, mergesClean: now.mergesClean ?? null,
        headSha: now.headSha || null, mainSha: now.mainSha || null }
      : { behindBy: null, mergesClean: null, headSha: null, mainSha: null };
    await steps.set('measured', measured);
  }
  if (measureFirst) {
    if (measured.behindBy == null) return { outcome: 'unmeasured' };
    if (measured.behindBy === 0) return { outcome: 'level' };
    if (measured.mergesClean !== true) return { outcome: 'conflict_skipped' };
  }
  // The merge queue's conflict lane: a head that merges cleanly by now is
  // the direct lane's (a sibling's merge moved main), not a resolution's.
  // (Unless GitHub refused it as a conflict the mirror does not see: then
  // the turn merges main all the same.)
  if (reason === 'conflict' && measured.mergesClean === true && !githubConflict && !steps.has('started')) return { outcome: 'clean_now' };
  // #361: housekeeping is billed to the system budget; an exhausted one is
  // an answer (the card says so), not a failure to back off from.
  if (!steps.has('started')) {
    const budget = await deps.limits.checkSystemBudget(pool);
    if (budget.error) return { outcome: 'over_budget', message: budget.error };
  }
  const headBefore = measured.headSha || session.integration_head_sha || null;
  const mainSha = measured.mainSha || session.integration_main_sha || null;
  // The visible activity is only for a real merge: an already-synced sync
  // leaves no "Syncing with main…" row in the timeline.
  const behind = measured.behindBy != null ? measured.behindBy : (Number(session.behind_main) || 0);
  const emitActivity = behind > 0;

  const send = (type, data) => {
    try {
      const { broadcastGlobal } = require('./ws');
      const sessionBus = require('./session-bus');
      const event = { type, _seq: `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...data };
      broadcastGlobal({ ...event, type: 'session_event', sessionId: session.id, event: type });
      sessionBus.publish(session.id, event);
    } catch (_) { /* ws/bus failures are non-fatal */ }
  };
  const sendStatus = async (text, metadata) => {
    send('status', { text, ...(metadata || {}) });
    try {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', $2, $3)`,
        [session.id, text, JSON.stringify(metadata || {})]
      );
    } catch (_) { /* persistence failure is non-fatal */ }
  };
  let progressMsgId = steps.get('progressRow') || null;
  // A restart follows the turn from its journal's start: a line already in
  // the row is not added twice.
  const seen = new Set(steps.get('progressSeen') || []);
  const appendProgress = async (text) => {
    if (!emitActivity) return;
    if (seen.has(text)) return;
    seen.add(text);
    await steps.set('progressSeen', [...seen]).catch(() => {});
    send('cc_progress', { text });
    try {
      if (progressMsgId == null) {
        const { rows } = await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
          [session.id, JSON.stringify({ progressLog: [] })]
        );
        progressMsgId = rows[0].id;
        await steps.set('progressRow', progressMsgId).catch(() => {});
      }
      await pool.query(
        `UPDATE chat_session_messages SET metadata = jsonb_set(
          metadata, '{progressLog}',
          (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
        ) WHERE id = $2`,
        [JSON.stringify([text]), progressMsgId]
      );
    } catch (_) { /* progress persistence is best-effort */ }
  };
  let phase = 'starting';
  const onProgress = (line) => {
    if (typeof line !== 'string') return;
    const pm = line.match(/^\[(sync_[a-z_]+)\]$/);
    if (!pm) return;
    const label = SYNC_PROGRESS_LABELS.get(pm[1]);
    if (label) appendProgress(label);
    const next = SYNC_PHASE_MAP.get(pm[1]);
    if (!next || next === phase) return;
    phase = next;
    broadcastSyncStatus(session, phase);
  };

  // A sync is somebody working on the session for every machine that asks
  // (src/workflow/session-work.ts syncWorkingSql): its own work item, while
  // outstanding, and its turn's record names it.
  try {
    if (!steps.has('started')) {
      broadcastSyncStatus(session, 'starting');
      if (emitActivity) await sendStatus('Syncing with main…');
      await steps.set('started', true);
    }

    const turn = await deps.durableTurn.runTurn(steps, 'sync', {
      pool, session, mode: 'sync', budgetMs: SYNC_BUDGET_MS, onProgress, owner,
      // Its own clock ends only its own turn (by its record), and says
      // nobody stopped it.
      stop: () => deps.durableTurn.clockStop(deps.worker, pool, id, owner),
      dispatch: async (extra, { budgetMs } = {}) => {
        // Always on the platform key.
        await deps.worker.ensureWorkerImage();
        await deps.worker.ensureWorker(id, { repoOwner, repoName, branchName: session.branch_name, onProgress });
        const result = await deps.worker.execInWorker(id, {
          mode: 'sync',
          prompt: '(sync turn — see MODE=sync block in run-cc.sh)',
          model: 'claude-sonnet-5-5',
          commitMsg: '',
          resumeSessionId: null,
          branchName: session.branch_name,
          anthropicApiKey: null,
          onProgress,
          ...(budgetMs ? { timeoutMs: budgetMs } : {}),
          ...(extra.owner ? { owner: extra.owner } : {}),
          ...(extra.holdTurnRecord ? { holdTurnRecord: true } : {}),
          ...(typeof extra.onTurnRecord === 'function' ? { onTurnRecord: extra.onTurnRecord } : {}),
        });
        return { result };
      },
    });
    const routed = turn.routed || {};
    // A person's Stop never gets here: the proposal machine ends the sync
    // as stopped by them and cancels this work (its next checkpoint throws),
    // so what the stopped turn left is never read as a conflict.
    if (typeof routed.error === 'string') throw new Error(routed.error.replace(/^dispatch: /, ''));
    const result = routed.result || {};
    // A conflict is the runner's own verdict: run-cc.sh writes
    // sync_result=conflict with the files git could not merge. A turn that
    // ended without one (a fatal worker error such as "branch missing
    // upstream", a worker that died) merged nothing and decided nothing: it
    // failed, and is never recorded as a conflict with no files. What it
    // spent is still billed, once.
    if (!result.syncResult && (result.fatalError || (result.exitCode != null && result.exitCode !== 0))) {
      await steps.once('after:spend', () => deps.limits.recordSystemSpend(pool, Math.round((result.costUsd || 0) * 100)));
      throw Object.assign(new Error(result.fatalError
        ? `The sync could not run: ${String(result.fatalError).slice(0, 200)}`
        : `The sync turn ended without a result (exit ${result.exitCode}).`), { code: 'sync_turn_failed' });
    }

    return await steps.once('after', async () => {
      session = (await loadSession(pool, id)) || session;
      await persistBehindMain(pool, session, result.behind || 0);
      // Each effect that must not happen twice is its own step: an after-block
      // run again (a retry, a lost lease) bills and says it once.
      await steps.once('after:spend', () => deps.limits.recordSystemSpend(pool, Math.round((result.costUsd || 0) * 100)));
      const syncResult = result.syncResult || (result.exitCode === 0 ? 'clean' : 'conflict');
      const message = syncResult === 'already_synced'
        ? 'Already up to date with main, so there is nothing to merge.'
        : ['clean', 'resolved'].includes(syncResult) && !result.pushOk
          ? 'Merged main locally, but publication failed. The commit is kept in this session.'
        : syncResult === 'clean'
          ? `Merged main cleanly. Pushed ${result.sha ? result.sha.slice(0, 7) : 'merge commit'}.`
          : syncResult === 'resolved'
            ? `Claude resolved merge conflicts with main and pushed ${result.sha ? result.sha.slice(0, 7) : 'the merge commit'}.`
            : 'Tried to sync with main but Claude couldn\'t resolve the conflicts. The branch is unchanged; try again or resolve locally.';
      const pushed = (syncResult === 'clean' || syncResult === 'resolved') && !!result.pushOk;
      // The card's snapshot: an unresolved conflict leaves the branch broken
      // ('failed', with the files git could not merge); a merge that did not
      // reach the branch says nothing new; anything else merges cleanly now.
      if (syncResult === 'conflict') {
        await persistConflictState(pool, session, { state: 'failed', files: result.conflictFiles || [] });
      } else if (pushed || syncResult === 'already_synced') {
        await persistConflictState(pool, session, { state: 'clean', files: [] });
      }
      // #788: a push changed the branch's contents, so the protected-settings
      // classification is read again (a sync never resets votes).
      if (pushed && session.status === 'promoted') {
        await require('./app-admins').refreshExplicitApproval(pool, session, session);
      }
      // A CLI hand-off's own pins own its preview and verdict: adopted for
      // every settled outcome.
      let managedRevision = null;
      if (session.source === 'cli_handoff' && (pushed || syncResult === 'already_synced')) {
        managedRevision = await require('./cli-handoff-sync').reconcileCliHandoffSync({
          config, pool, session, newHead: result.sha || null,
        });
        if (!managedRevision.ok) {
          const err = new Error(`The branch synced, but Homeroom could not adopt its new proposal revision (${managedRevision.reason}).`);
          err.code = 'SYNC_REVISION_NOT_ADOPTED';
          throw err;
        }
      } else if (pushed && session.status === 'promoted') {
        // In review: the pushed head is measured (it contains main, so it
        // measures clean), installed as the reviewed revision (a mechanical
        // or resolved move keeps the approvals) and its checks start.
        await deps.integration.measure({ pool, session }, { force: true, blockReasons: [] }).catch(() => {});
        if (session.source === 'imported') {
          await deps.prImportSync().reconcileImportedHead({ config, pool, session, checks: 'background', notify: false });
        } else {
          await deps.votes().reconcileNativeReviewedHead({ config, pool, session, fresh: true, notify: false });
        }
      }
      if (emitActivity) {
        await steps.once('after:said', async () => {
          await sendStatus(message, { syncMain: { syncResult, behind: result.behind || 0, sha: result.sha || null, pushOk: !!result.pushOk } });
          events.record(pool, {
            type: events.EVENT_TYPES.SYNC_MAIN,
            userId: session.user_id, appId: session.app_id, sessionId: session.id,
            metadata: { syncResult, behind: result.behind || 0, sha: result.sha || null, pushOk: !!result.pushOk, trigger: TRIGGERS.get(reason) || reason },
          });
          return true;
        });
      }
      broadcastSyncStatus(session, syncResult === 'conflict' ? 'failed' : 'done', { syncResult, message });
      return {
        outcome: syncResult === 'conflict' ? 'unresolvable'
          : (syncResult === 'clean' || syncResult === 'resolved') && !result.pushOk ? 'not_pushed' : syncResult,
        sha: result.sha || null, behind: result.behind || 0, pushOk: !!result.pushOk,
        conflictFiles: result.conflictFiles || [], message, headBefore, mainSha,
        ...(managedRevision ? { managedRevision } : {}),
      };
    });
  } catch (err) {
    if (err && (err.stopped === true || err.code === 'steps_stopped')) throw err;
    // Said only when no attempt follows: a retry may still succeed.
    if (emitActivity && last) {
      await sendStatus(`Sync with main failed: ${err.message}`,
        { syncMain: { syncResult: 'error', behind, sha: null, pushOk: false } }).catch(() => {});
    }
    if (last) broadcastSyncStatus(session, 'failed', { message: err.message });
    log.warn('sync-main', 'Sync with main failed', { sessionId: id, reason, err: err.message });
    throw err;
  }
}

module.exports = {
  runSyncWork,
  persistBehindMain,
  persistConflictState,
  getSyncState,
  sessionBusy,
  SYNC_BUDGET_MS,
  IDLE_WAIT_MS,
};
