'use strict';

const { planRecordSql } = require('./request-specs');

// One work state per request and per change (5 Nov 2026, step 3 of one bot
// per thread: docs/plans/bot-one-model.md).
//
// Seven pieces of code used to decide where a request stood, one per surface
// (the bot tab's standing, the drawer's outcomes, a request page's track, a
// project chat card's stage, the bell's moments, ...), each from the same
// records with rules of its own, and they disagreed: one request read Decide
// on the bot tab, sat in History in the drawer and said Reading in its
// project's chat. This module decides it once:
//
//   derive(facts)        the stage of a request, from one facts row (the
//                        bot's records, read by REQUEST_FACTS_SQL: the same
//                        per-request query the bot page and the track read)
//   deriveChange(facts)  the stage of a change with no request of its own
//   placeFor(state, you) where an item goes for one viewer: Needs you, In
//                        progress, Waiting, Live, or not listed
//   bellOf(prev, next)   the moment a change of stage rings, if any
//   refresh(db, items)   derives the items again and stores each that
//                        changed (work_states), returning them
//   afterTransition      the workflow's hook: after every accepted event of
//                        a machine that moves a request or a change, in its
//                        own transaction, refresh the items it is about and
//                        push each change (`work_state`)
//
// Ten stages, the same words everywhere: reading, planning, waiting_for_you
// (always with a why), building, checking, up_for_vote, going_live, live,
// stopped (with a reason), closed. The second line (`line`) carries queue and
// hold reasons and detail.

const progress = require('./homeroom-bot-progress');
// #6807: whether a change waits on a fix for a check that is not its own.
const flaky = require('./homeroom-bot-flaky-checks');
const { syncWaits, syncStand } = require('./vote-ready');
const checksEstimate = require('./checks-estimate');
const { firstVersionSql } = require('./first-version-rule');
const { heldUntil } = require('../workflow/rules/bot-readiness.ts');
const { currentVotePredicateSql } = require('../workflow/rules/vote-predicate.ts');

const STAGES = Object.freeze([
  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
  'up_for_vote', 'going_live', 'live', 'stopped', 'closed',
]);
const WHYS = Object.freeze(['question', 'plan', 'decide', 'already_works', 'needs_detail']);
const REASONS = Object.freeze(['build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled']);
// A live item is listed for a week, as the bot tab always did.
const LIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// The bot reads a claim this long (homeroom-bot.js CLAIM_TTL_DAYS).
const CLAIM_DAYS = 7;

const iso = (at) => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// #6306: the bot's first whole sentence, cut at `max` with "…" when it does
// not fit. A row says what it found in one sentence; the page keeps all.
function firstSentence(text, max = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0];
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// ── Reasons a later release made out of date ──────────────────────────────

// A read handed a request back for a limit Homeroom has since lifted: the
// reason is no longer true, so the request's card offers to read it again
// (homeroom-bot-dm.js askBotToBuild `readAgain`). Each entry names a code the
// client words (`request.status.note.outdated*`), the release that lifted it,
// and a pattern for the reasons it explains; a later fix adds a line here.
// The first: the bot could not read a plan a person posted (6 Nov 2026,
// 13:05 UTC, #6384).
const LIFTED_LIMITS = Object.freeze([
  Object.freeze({
    code: 'posted_plan',
    liftedAt: '2026-11-06T13:05:00Z',
    pattern: /\bplan\b[^.]*\b(cannot|can't|could not|couldn't|unable to)\b[^.]*\bread|\b(cannot|can't|could not|couldn't|unable to)\b[^.]*\bread\b[^.]*\bplan\b/i,
  }),
]);

/**
 * Pure: the code of the lifted limit that explains a request's hand-back
 * reason ('posted_plan'), else null. Only a `reason` line written before
 * that limit was lifted counts (`work.since`), never one given after.
 */
function outdatedReason(work) {
  if (!work || work.stage !== 'waiting_for_you') return null;
  if (!work.line || work.line.code !== 'reason') return null;
  const text = String(work.line.text || '');
  const since = Date.parse(work.since || '');
  if (!text || !Number.isFinite(since)) return null;
  for (const limit of LIFTED_LIMITS) {
    const at = Date.parse(limit.liftedAt);
    if (Number.isFinite(at) && since < at && limit.pattern.test(text)) return limit.code;
  }
  return null;
}

// ── Deciding ──────────────────────────────────────────────────────────────

const state = (stage, extra = {}) => {
  const out = { stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra };
  if (out.whoseMove == null) {
    out.whoseMove = stage === 'waiting_for_you' || stage === 'stopped' ? 'requester'
      : stage === 'up_for_vote' ? 'group'
        : stage === 'reading' || stage === 'planning' || stage === 'building' || stage === 'checking' ? 'bot'
          : null;
  }
  out.since = iso(out.since);
  return out;
};

/**
 * Pure: the checks estimate's second line while a run is in flight (#6402).
 * `About N min left`, from the same estimate the Testing card draws: the
 * median build plus checks time, less how long this run has been going. No
 * line when there is no estimate, the run has passed it, or it waits for a
 * free checks slot (`queued`: no time can be estimated yet).
 */
function checksLine(row, now) {
  if (!row || row.check_phase === 'queued') return null;
  const running = ['building', 'testing'].includes(row.check_phase)
    || (row.check_phase == null && (row.check_state === 'pending' || row.check_state === 'running'));
  if (!running) return null;
  const estimate = row.checks_estimate;
  const buildMs = Number(estimate && estimate.buildMs);
  const checksMs = Number(estimate && estimate.checksMs);
  if (!Number.isFinite(buildMs) || !Number.isFinite(checksMs)) return null;
  const at = row.checks_at || row.checks_checked_at;
  if (!at) return null;
  const elapsed = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(elapsed)) return null;
  const remaining = buildMs + checksMs - elapsed;
  if (remaining <= 0) return null;
  return { code: 'checks_running', minutes: Math.max(1, Math.ceil(remaining / 60000)) };
}

/**
 * Pure (#6616): whether a change's votes are in. The one predicate every
 * reader of `votes_in` shares — services/work-state.js's stages and the
 * Needs you feed's `authorGateMet` — so the list that leaves a vote to the
 * feed and the feed that keeps the row can never disagree. A missing answer
 * (a failed gate read) is false: the row stays a Vote.
 */
function votesIn(row) {
  return row?.votes_in === true;
}

/**
 * Pure (#6531, 11 Nov 2026): a change that conflicts with main where only a
 * yes can move it (syncStand 'vote'). It is up for a vote, and so open for
 * votes, only while it could take one, as voteReadySql reads it: its checks
 * passed (or had nothing to test) on the head up for a vote, it is not its
 * project's first version, and its before & after shots are not still being
 * taken. Until then it is checking: its failing checks when they fail, else
 * what a yes will do once it can be given. `onHead` and `held` are the
 * caller's (a request's facts row and a change's name their columns
 * differently).
 */
function yesOnlyState(row, since, { onHead, held }) {
  const passed = row.check_state === 'passing' || row.check_state === 'skipped';
  if (passed && onHead && row.first_version !== true && !held) {
    return state('up_for_vote', { since, line: { code: 'conflict_on_yes' } });
  }
  if (row.check_state === 'failing' || row.check_state === 'error') {
    const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
    return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
  }
  return state('checking', { since, line: { code: 'conflict_on_yes' } });
}

/** Pure: whether a request's facts row's shots still hold its change's vote (stageOf's own reading). */
function requestShotsHeld(row, now) {
  if (!row || !row.shots_detail) return false;
  const head = (row.proposal_source === 'imported' ? row.imported_pr_head_sha : row.reviewed_head_sha) || row.checks_sha;
  return heldUntil({
    shots_state: row.shots_state, shots_run_id: row.shots_run_id, shots_detail: row.shots_detail,
    shots_updated_at: row.shots_updated_at, checks_checked_at: row.checks_at,
  }, head, now.getTime()) != null;
}

/** Pure: a request's facts row whose change waits only for a yes on a conflict (yesOnlyState). */
function requestOnYes(row, since, now) {
  return yesOnlyState(row, since, { onHead: progress.checksOnHead(row), held: requestShotsHeld(row, now) });
}

/** The stage word plus the two lines a checking change can carry (#6402). */
function checkingState(row, since, now, onYes = requestOnYes) {
  // #6531: what a conflicting change waits on decides where it shows and
  // what it says. A yes-only conflict is up for a vote once it could take
  // one (yesOnlyState); one the lane is resolving says "Syncing with main";
  // one only its author can move keeps the old wording.
  const stand = syncStand(row);
  if (stand === 'vote') return onYes(row, since, now);
  if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
  if (stand === 'author') return state('checking', { since, line: { code: 'sync_wait' } });
  // #6594: its votes are in, so its checks are what it waits on now, not a
  // vote it no longer needs.
  if (votesIn(row)) return state('checking', { since, line: { code: 'approved_checking' } });
  const line = checksLine(row, now);
  return state('checking', { since, ...(line ? { line } : {}) });
}

/**
 * Pure (#6594): a change still asking for a vote, with the line that says
 * why one is needed again when a push retired earlier yes votes.
 */
function upForVote(row, since) {
  const earlier = Number(row.earlier_yes) || 0;
  return state('up_for_vote', { since, ...(earlier > 0 ? { line: { code: 'earlier_yes', count: earlier } } : {}) });
}

/**
 * Pure (#6546): an approved change whose merge GitHub is holding, from the
 * proposal machine's mergeHeld reasons, or null. Only an approved (or
 * forced) change is ever handed to GitHub to merge, so one GitHub held is
 * going live, and its line says on what: GitHub's required checks (still
 * running, or being run again on today's main), or GitHub itself. One whose
 * required checks failed again after that is its author's (or the bot's).
 */
function githubHold(row) {
  const reasons = (Array.isArray(row?.integration_block_reasons) ? row.integration_block_reasons : []).map(String);
  if (reasons.includes('github_checks_failing')) return { stage: 'checking', code: 'github_checks_failing' };
  if (reasons.includes('github_checks')) return { stage: 'going_live', code: 'github_checks' };
  if (reasons.includes('github_refused') || reasons.includes('github_busy')) return { stage: 'going_live', code: 'github_wait' };
  return null;
}

/**
 * Pure: a request's work state from one stage of homeroom-bot-progress.js
 * stageOf (the bot's own step), mapped to the ten (the plan's table).
 */
function fromStage(s, row, now = new Date()) {
  const since = s.since || null;
  switch (s.stage) {
    case 'reading':
      // #6228: reading a reply now, or about to (`soon`: its read is queued),
      // which a thread's reply line reads (homeroom-bot-reply-status.js).
      return state('reading', { since, ...(s.reply ? { line: { code: 'reply', ...(s.waiting ? { soon: true } : {}) } } : {}) });
    case 'queued':
      return s.retry === 'plan'
        ? state('planning', { since, line: { code: 'retry_plan' } })
        : state('reading', {
          since,
          line: {
            code: 'queued',
            ...(row.queue_place ? { place: Number(row.queue_place) } : {}),
            // B8: somebody asked the bot for it (its page, their chat), so
            // it is the bot's already, waiting for a free builder.
            ...(row.queue_priority != null && Number(row.queue_priority) === 0 ? { asked: true } : {}),
          },
        });
    case 'on_hold':
      // #6357: a day's pause after its look threw again and again is not
      // the week's building time (homeroom-bot-progress.js holdOf). Its
      // line says until when, so a request's track reads it off the row.
      return state('reading', {
        since, line: { code: s.hold === 'cooldown' ? 'cooldown' : 'on_hold', ...(iso(s.until) ? { until: iso(s.until) } : {}) },
      });
    case 'held':
      // Its place among the project's requests held at the same limit
      // (REQUEST_FACTS_SQL held_place), as a request's track draws it.
      return state('building', {
        since,
        line: {
          code: row.cap_suppressed === 'builds_per_app' ? 'held_builds' : 'held_waiting',
          ...(Number(row.held_place) > 0 ? { position: Number(row.held_place) } : {}),
        },
      });
    case 'build_queued':
      // #5323: its place among the project's builds waiting to start, so it
      // never says a bare "waiting its turn".
      return state('building', { since, line: { code: 'queued', ...(row.build_place ? { place: Number(row.build_place) } : {}) } });
    case 'starting':
      return state('building', { since, line: { code: 'starting' } });
    case 'stalled':
      return state('stopped', { since, reason: 'stalled' });
    case 'planning':
      return state('planning', { since });
    case 'reviewing': {
      const of = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.max(1, Math.min(Number(row.review_round) || 1, of));
      return state('building', { since, line: { code: 'reviewing', round, of } });
    }
    case 'proposing':
      return state('building', { since, line: { code: 'proposing' } });
    case 'building':
      return state('building', { since });
    case 'plan':
      return state('waiting_for_you', { since, why: 'plan' });
    case 'question':
      return state('waiting_for_you', { since, why: 'question' });
    case 'fixing':
      return state('building', { since, line: { code: 'fixing' } });
    case 'revising':
      return state('building', { since, line: { code: 'revising' } });
    case 'fix_queued': {
      // #6545: a fix waiting its turn is its checks still failing, not a
      // change ready to vote on.
      const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
    }
    case 'followup_queued':
      // 11 Nov 2026: an update on its way asks nobody for a vote (vote_open
      // is false), so it is not up for one: the bot has it, waiting its turn.
      return state('building', { since, line: { code: 'update_queued' } });
    case 'checks': {
      // An approved change GitHub holds is going live, never checking again
      // (#6546), whatever its own checks' verdict says meanwhile.
      const hold = githubHold(row);
      if (hold) return state(hold.stage, { since, line: { code: hold.code } });
      // #6528: its tests passed on its head, and its before & after shots
      // are still being taken (stageOf's hold): it says so.
      if (row.check_state === 'passing' || row.check_state === 'skipped') {
        if (progress.checksOnHead(row) && !syncStand(row)) return state('checking', { since, line: { code: 'shots' } });
      }
      return checkingState(row, since, now);
    }
    case 'checks_failed': {
      // #6531: a conflicting head the lane is catching up (or that only a yes
      // can move) is not yet its author's failing verdict.
      const stand = syncStand(row);
      if (stand === 'vote') return requestOnYes(row, since, now);
      if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
      const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
    }
    case 'fix_stopped':
      return state('stopped', { since, reason: 'fix_stopped' });
    case 'flake_fixing':
      // #6807: its failing check is not its own, and Homeroom bot is getting
      // that check fixed: the bot is still working.
      return state('checking', { since, line: { code: 'fixing_check' } });
    case 'vote':
      if (row.first_version === true) return state('going_live', { since, line: { code: 'first_version' } });
      // #6402: a passing change that has since stopped merging cleanly waits
      // to sync with main, rather than asking for a vote it would throw away.
      // #6531: unless it conflicts and only a yes can move it.
      {
        const stand = syncStand(row);
        if (stand === 'vote') return requestOnYes(row, since, now);
        if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
        if (stand === 'author') return state('checking', { since, line: { code: 'sync_wait' } });
      }
      {
        // #6546: approved, and GitHub is holding its merge.
        const hold = githubHold(row);
        if (hold) return state(hold.stage, { since, line: { code: hold.code } });
      }
      // #6594: its votes are in; it is being merged, not voted on.
      if (votesIn(row)) return state('going_live', { since });
      return upForVote(row, since);
    case 'merging':
      return state('going_live', { since: row.merged_at || since });
    default:
      return null;
  }
}

/**
 * Pure: where a request stands, from its facts row (REQUEST_FACTS_SQL: the
 * bot's records for it, its change, its claim, a private thread holding it).
 * Never null: a request nothing is happening to waits to be read.
 */
function derive(row, opts = {}) {
  const out = deriveFacts(row, opts);
  // 5 Oct 2026 (Page Turners), kept: a request filed or queued while its
  // project's first version is not live waits for it, and says so
  // (`held_first_version`, the bot's own rule: homeroom-bot.js
  // heldForFirstVersion, read by refresh).
  if (row.held_first_version === true && out.stage === 'reading' && NOT_STARTED.has(out.line?.code)) {
    return { ...out, line: { code: 'first_version_wait' } };
  }
  return out;
}

function deriveFacts(row, { now = new Date() } = {}) {
  const status = row.proposal_status || null;
  // Its change is live (REQUEST_RECORD_COLUMNS reads a merged change that is
  // not live yet as 'merging').
  if (status === 'merged') return state('live', { since: row.merged_at || row.proposal_at });
  // The bot's own step for it, when it has one.
  const step = progress.stageOf(row, { now });
  let out = step ? fromStage(step, row, now) : null;
  // An update on its way holds the vote it would otherwise ask for (#6282),
  // or says the bot is fixing its failing checks (#6600).
  if (status === 'promoted' && out) out = withUpdate(out, { coming: row.update_coming, failed: row.update_failed });
  // A private thread of the requester's holds it for their plan: nothing
  // queued overtakes that until a change is up (1 Nov 2026).
  const planHeld = row.awaiting_plan === true && !status;
  const planning = (line = {}) => state('planning', {
    since: row.request_at || row.run_at, line: { code: 'planning_with_you', ...line }, whoseMove: 'requester',
  });
  if (planHeld && (!out || out.stage === 'reading')) return planning();
  // 16 Oct 2026: ready, but a person has the request now (a claim, or a
  // change of their own under way): the bot leaves it alone, so it is
  // theirs, not a wait for a slot.
  // #4190: a claim made once the bot was already on it is a person working
  // ALONGSIDE the bot, not a hold, so only an earlier claim counts here.
  const personBuilding = row.lc_by && (row.lc_status === 'active' || row.lc_status === 'paused') ? row.lc_by : null;
  const claimFirst = row.claimed_by && (!row.run_at || new Date(row.claimed_at) <= new Date(row.run_at)) ? row.claimed_by : null;
  if (out && out.stage === 'building' && READY.has(out.line?.code) && (personBuilding || claimFirst)) {
    return state('building', {
      since: personBuilding ? row.lc_last_activity_at || out.since : row.claimed_at || out.since,
      line: { code: 'claimed', by: personBuilding || claimFirst }, whoseMove: 'builder',
    });
  }
  // 13 Nov 2026: the same hold on a request that had already reached the
  // build line (its build waits its turn, or one of the project's limits
  // holds it). The lane starts no build and takes no held verdict back up
  // while the thread holds it (rules/bot-loop.ts BUILD_CANDIDATES_SQL,
  // READ_CANDIDATES_SQL), so it waits for its requester, not for a slot: it
  // read "Ready to build · Number 1 in line" beside Let the bot build it
  // now. `ready` says a build is waiting behind the hold (botWorkOf).
  if (planHeld && out && out.stage === 'building' && READY.has(out.line?.code)) return planning({ ready: true });
  if (out) return out;

  // A change somebody made for it, when Homeroom bot has none of its own:
  // that is where it stands, whatever an older look of the bot's said.
  if (!status && row.lc_status) {
    // The change's own facts when refresh read them (CHANGE_FACTS_SQL: its
    // checks' head, its shots, an update on its way), so the request and
    // the change's own row read one stage; else the columns of the facts row.
    const change = deriveChange(row.lc_facts || {
      status: row.lc_status, check_state: row.lc_check_state, checks_at: row.lc_checks_at,
      check_phase: row.lc_check_phase, merge_conflict_state: row.lc_merge_conflict_state,
      integration_merges_clean: row.lc_integration_merges_clean,
      integration_block_reasons: row.lc_integration_block_reasons,
      checks_estimate: row.checks_estimate,
      votes_in: row.lc_votes_in === true, earlier_yes: row.lc_earlier_yes,
      promoted_at: row.lc_promoted_at, merged_at: row.lc_merged_at, live_at: row.lc_live_at,
      last_activity_at: row.lc_last_activity_at, created_at: row.lc_created_at,
      // #6282: an update on its way holds its vote too. #6600: and a
      // takeover whose last attempt failed says so.
      update_coming: row.lc_update_coming, update_failed: row.lc_update_failed,
      // #6807: it waits on a fix for a check that is not its own.
      flake_fixing: row.lc_flake_fixing === true,
    }, { now });
    // Somebody is building it: who, as a claim says it.
    if ((row.lc_status === 'active' || row.lc_status === 'paused') && row.lc_by) {
      return state('building', { since: change.since, line: { code: 'claimed', by: row.lc_by }, whoseMove: 'builder' });
    }
    // deriveChange read an update on its way and a failed takeover already
    // (withUpdate, #6282, #6600).
    return change;
  }

  // Nothing in progress: what its newest look came to.
  const back = progress.handedBack(row);
  const reason = row.run_reason ? firstSentence(row.run_reason, 140) : null;
  const said = reason ? { line: { code: 'reason', text: reason } } : {};
  // Somebody took a hand-back up since (a claim): it is being built.
  if (back && row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  if (back === 'already_works') return state('waiting_for_you', { since: row.run_at, why: 'already_works', ...said });
  if (back === 'decide') return state('waiting_for_you', { since: row.run_at, why: 'decide', ...said });
  if (back === 'build_stopped') return state('stopped', { since: row.run_at, reason: 'build_failed' });
  if (row.request_closed === true) return state('closed', { since: row.closed_at || row.run_at });
  if (status === 'closed') return state('stopped', { since: row.proposal_at, reason: 'change_closed' });
  if (row.mode === 'live' && (row.verdict === 'empty' || /^blocked:/.test(String(row.build_error || '')))) {
    return state('waiting_for_you', { since: row.run_at, why: 'needs_detail', ...said });
  }
  if (row.mode === 'live' && row.verdict === 'failed') return state('stopped', { since: row.run_at, reason: 'look_failed' });
  // Its newest look asked a question (in the request's thread, or a DM
  // question since closed), and nothing has answered it: still theirs.
  if (row.mode === 'live' && row.verdict === 'question') return state('waiting_for_you', { since: row.run_at, why: 'question' });
  if (row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  // Not read yet, or read and nothing came of it (a skip): it waits to be read.
  return state('reading', { since: row.request_at || row.run_at, line: { code: 'waiting' } });
}

/**
 * Pure (#6282, #6545, #6600): how an update on its way, or a takeover whose
 * last attempt failed, changes a change's state. `coming` is 'running' |
 * 'queued' | null (homeroom-bot-progress.js updateComingSql) and `failed`
 * is why its newest takeover look failed, if it did (updateFailedSql).
 *
 * A running update holds a vote and a checking change as Building: a
 * takeover on a change whose checks failed says "Fixing what its tests
 * found", the words a fix of the bot's own already uses, and any other
 * says it is being updated. A queued one holds only a vote (it waits its
 * turn, the bot's to start), and a change still checking (a fix waiting its
 * turn) stays Checking until the update starts. 11 Nov 2026: never up for a
 * vote while it comes, so a stage of up_for_vote is always a change open
 * for votes (vote_open). A takeover whose last attempt failed leaves its
 * change Checking, its line saying Homeroom bot could not fix it.
 */
function withUpdate(change, { coming = null, failed = null } = {}) {
  if (!change) return change;
  const failing = change.stage === 'checking'
    && (change.line?.code === 'checks_failing' || change.line?.code === 'github_checks_failing');
  if (coming === 'running') {
    if (change.stage === 'checking' || change.stage === 'up_for_vote') {
      return state('building', { since: change.since, line: { code: failing ? 'fixing' : 'revising' } });
    }
    return change;
  }
  if (coming === 'queued' && change.stage === 'up_for_vote') {
    return state('building', { since: change.since, line: { code: 'update_queued' } });
  }
  if (!coming && failed && failing) return { ...change, line: { code: 'bot_fix_failed' } };
  return change;
}

/** Pure: the head a change's votes and checks are about (progress.checksOnHead's reading). */
function changeHead(row) {
  return (row?.source === 'imported' ? row?.imported_pr_head_sha : row?.reviewed_head_sha) || row?.checks_commit_sha || null;
}

/**
 * Pure (#6528): whether a change's before & after shots still hold its
 * vote, by the bot's own readiness rule (bot-readiness.ts heldUntil, with
 * its 45-minute lapse when no settle ever comes).
 */
function shotsHeld(row, now = new Date()) {
  if (!row || !row.shots_detail) return false;
  return heldUntil({
    shots_state: row.shots_state, shots_run_id: row.shots_run_id, shots_detail: row.shots_detail,
    shots_updated_at: row.shots_updated_at, checks_checked_at: row.checks_at,
  }, changeHead(row), now.getTime()) != null;
}

/** Pure: whether a change's check verdict is about the head up for a vote (progress.checksOnHead). */
function changeChecksOnHead(row) {
  return progress.checksOnHead({
    proposal_source: row?.source, imported_pr_head_sha: row?.imported_pr_head_sha,
    reviewed_head_sha: row?.reviewed_head_sha, checks_sha: row?.checks_commit_sha,
  });
}

/**
 * Pure: where a change stands, from its own facts (CHANGE_FACTS_SQL; a
 * request's change, or one with no request of its own). Up for a vote only
 * when it is open for votes (voteOpen): its checks passed on its head, it
 * merges cleanly (or only a yes can move it), GitHub is not holding an
 * approved merge, it is not its project's first version, no update is on
 * its way, and its before & after shots are not still being taken.
 */
function deriveChange(row, { now = new Date() } = {}) {
  const status = row.status || null;
  if (status === 'merged') {
    return row.live_at ? state('live', { since: row.live_at }) : state('going_live', { since: row.merged_at });
  }
  if (status === 'merging') return state('going_live', { since: row.promoted_at });
  if (status === 'closed' || status === 'archived') return state('closed', { since: row.last_activity_at || row.promoted_at });
  if (status === 'promoted') return withUpdate(promotedChange(row, now), { coming: row.update_coming, failed: row.update_failed });
  void now;
  return state('building', { since: row.last_activity_at || row.created_at, whoseMove: 'builder' });
}

/** Pure: a change's own facts row that waits only for a yes on a conflict (yesOnlyState). */
function changeOnYes(row, since, now) {
  return yesOnlyState(row, since, { onHead: changeChecksOnHead(row), held: shotsHeld(row, now) });
}

function promotedChange(row, now) {
  const since = row.checks_at || row.promoted_at;
  // #6531: a conflicting change is where its conflict stand puts it, before
  // its stale verdict is read as final: only a yes can move it (vote, once
  // it could take one: yesOnlyState), the lane is catching it up (syncing),
  // or it is its author's (author).
  const stand = syncStand(row);
  if (stand === 'vote') return changeOnYes(row, since, now);
  if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
  if (stand === 'author') {
    const failed = row.check_state === 'failing' || row.check_state === 'error';
    return state('checking', { since, line: { code: failed ? 'checks_failing' : 'sync_wait' } });
  }
  // #6546: approved, and GitHub is holding its merge: going live (or its
  // author's again, when GitHub's own checks fail), never up for a vote.
  const hold = githubHold(row);
  if (hold) return state(hold.stage, { since: row.promoted_at, line: { code: hold.code } });
  if (row.check_state !== 'passing' && row.check_state !== 'skipped') {
    const failing = row.check_state === 'failing' || row.check_state === 'error';
    if (failing && row.flake_fixing === true) {
      // #6807: it fails a check that is not its own, and the fix for that
      // check is under way: the bot is working, not the change's author.
      return state('checking', { since, line: { code: 'fixing_check' } });
    }
    if (failing) {
      const count = Number(row.failed_checks) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(count ? { failing: count } : {}) } });
    }
    // #6402: deferred or conflicting heads wait to sync with main; a run in
    // flight says about how long it has left.
    return checkingState(row, since, now, changeOnYes);
  }
  // N5: a verdict about another commit than the one up for a vote says
  // nothing about it: its own checks are still to come. #6594: with its
  // votes in, it is approved and those checks are what it waits on.
  if (!changeChecksOnHead(row)) {
    return state('checking', { since, ...(votesIn(row) ? { line: { code: 'approved_checking' } } : {}) });
  }
  // A passing change that has since stopped merging cleanly moves back to
  // Waiting to sync with main: its verdict no longer describes what lands.
  if (syncWaits(row)) return state('checking', { since, line: { code: 'sync_wait' } });
  // D1: a project's first version goes live without a vote.
  if (row.first_version === true) return state('going_live', { since: row.promoted_at, line: { code: 'first_version' } });
  // #6528: its before & after shots are still being taken.
  if (shotsHeld(row, now)) return state('checking', { since, line: { code: 'shots' } });
  // #6594: its votes are in (the project's rule would let it merge now): it
  // is being merged, not voted on, so it is not open for votes either.
  if (votesIn(row)) return state('going_live', { since: row.promoted_at });
  return upForVote(row, row.promoted_at);
}

/** Pure: whether a change is open for votes now (work_states.vote_open): its stage is up for a vote. */
function voteOpenOf(changeState) {
  return !!changeState && changeState.stage === 'up_for_vote';
}

/**
 * Pure: where an item goes for one viewer, or null when it is not theirs to
 * see in these lists. `viewer` says how they stand to it: `requester` (it is
 * theirs, or they decide on its project), `voteOwed` (they still owe a vote,
 * which the Needs you feed lists as Vote), `own` (they asked for it, built it
 * or follow it).
 */
function placeFor(item, viewer = {}) {
  if (!item) return null;
  const mine = !!viewer.requester;
  const own = mine || !!viewer.own;
  switch (item.stage) {
    case 'waiting_for_you':
    case 'stopped':
      return mine ? 'needs' : own ? 'waiting' : null;
    case 'up_for_vote':
      if (viewer.voteOwed) return null; // the feed's Vote row
      return own ? 'waiting' : null;
    case 'live': {
      const at = item.since ? new Date(item.since).getTime() : 0;
      return own && (!at || Date.now() - at <= LIVE_DAYS * DAY_MS) ? 'live' : null;
    }
    case 'closed':
      return null;
    case 'going_live':
      return own ? 'next' : null;
    default: {
      if (!own) return null;
      // Waiting its turn, or held: Waiting. Under way: In progress.
      const code = item.line && item.line.code;
      const waiting = code === 'queued' || code === 'held_builds' || code === 'held_waiting' || code === 'on_hold' || code === 'cooldown'
        || code === 'waiting' || code === 'update_queued' || code === 'planning_with_you' || code === 'retry_plan'
        || item.stage === 'checking';
      return waiting ? 'waiting' : 'next';
    }
  }
}

/**
 * Pure: the moment a change of stage rings the requester's bell, or null.
 * Into waiting_for_you: needs you; up_for_vote: ready to vote; stopped:
 * stopped; live: live. A row that only moved its line rings nothing.
 */
const queuedUpdate = (item) => !!item && item.stage === 'building' && item.line?.code === 'update_queued';

function bellOf(prev, next) {
  if (!next) return null;
  const same = prev && prev.stage === next.stage && (prev.why || null) === (next.why || null)
    && (prev.reason || null) === (next.reason || null);
  if (same) return null;
  if (next.stage === 'waiting_for_you') return 'needs_you';
  // An update that was only queued and never started took nothing back:
  // its "ready to try" still stands (withdrawReady), so it rings no other.
  if (next.stage === 'up_for_vote') return prev && (prev.stage === 'up_for_vote' || queuedUpdate(prev)) ? null : 'ready';
  if (next.stage === 'stopped') return 'stopped';
  if (next.stage === 'live') return 'live';
  return null;
}

// ── Words ────────────────────────────────────────────────────────────────

// 11 Nov 2026: the stage, why, reason and line of an item map to the phrase
// ids of frontend/locales/en/core.json's work.* entries here, once. The map
// ships with every row (`words`: fromRow, the push, a request's standing),
// so every screen draws the same words and no client keeps a table of its
// own; the server's own English (Homeroom bot's answers, the bell) reads
// the same catalog through push-text.js.

// A request in the reading stage nobody has started on yet, and one ready to
// build that waits its turn, are said so (the same stages, in plainer words).
const NOT_STARTED = new Set(['queued', 'waiting', 'on_hold', 'cooldown', 'first_version_wait']);
const READY = new Set(['queued', 'held_builds', 'held_waiting']);
// The second lines that need no value, by code (work.line.<camel>).
const PLAIN_LINES = new Set([
  'queued', 'first_version_wait', 'held_builds', 'held_waiting', 'on_hold', 'cooldown', 'reply', 'retry_plan',
  'starting', 'proposing', 'fixing', 'revising', 'update_queued', 'checks_failing', 'sync_wait', 'conflict_on_yes',
  'github_checks', 'github_checks_failing', 'github_wait', 'first_version', 'planning_with_you', 'waiting', 'shots',
  'approved_checking',
  // #6600: Homeroom bot took over its failing tests, and its last attempt could not fix them.
  'bot_fix_failed',
  // #6807: Homeroom bot is getting the check it fails on fixed.
  'fixing_check',
]);

const camel = (s) => String(s).replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

/** Pure: the stage's phrase, as its requester reads it (`yours`) or as anyone else does. */
function stagePhrase(item, yours) {
  if (item.stage === 'waiting_for_you' && item.why && WHYS.includes(item.why)) {
    return { id: `core:work.${yours ? 'why' : 'whyOthers'}.${camel(item.why)}` };
  }
  if (item.stage === 'stopped' && item.reason && REASONS.includes(item.reason)) return { id: `core:work.reason.${camel(item.reason)}` };
  const code = item.line && item.line.code;
  // #6531: a conflicting change the lane is catching up says so in the stage
  // word itself ("Syncing with main", not "Checking"), and carries no line.
  if (item.stage === 'checking' && code === 'syncing') return { id: 'core:work.stage.syncing' };
  // #6594: its votes are in, so nothing asks for a vote any more. #6695: its
  // own tests are still running, so the word says what is happening
  // (Checking), not Approved: Approved waits only on GitHub's required
  // checks now (below).
  if (item.stage === 'checking' && code === 'approved_checking') return { id: 'core:work.stage.checking' };
  // Its tests passed and only its before & after screenshots are left: the
  // stage word says that ("Taking screenshots"), not "Checking", which read
  // as tests that might still fail.
  if (item.stage === 'checking' && code === 'shots') return { id: 'core:work.stage.shots' };
  // #6807: its failing check is not its own and the bot is getting it fixed:
  // the stage word says the bot is working ("Fixing"), not "Checking".
  if (item.stage === 'checking' && code === 'fixing_check') return { id: 'core:work.stage.fixing' };
  // #6563: an approved change whose merge GitHub holds is not going live yet;
  // its word says so, and its second line says on what. #6594: waiting on
  // GitHub's checks is still approved; only GitHub itself holding it back
  // reads "Waiting to merge".
  if (item.stage === 'going_live' && code === 'github_checks') return { id: 'core:work.stage.approved' };
  if (item.stage === 'going_live' && code === 'github_wait') return { id: 'core:work.stage.waitingToMerge' };
  if (item.stage === 'reading' && NOT_STARTED.has(code)) return { id: 'core:work.stage.notStarted' };
  if (item.stage === 'building' && READY.has(code)) return { id: 'core:work.stage.readyToBuild' };
  return { id: `core:work.stage.${camel(STAGES.includes(item.stage) ? item.stage : 'reading')}` };
}

/** Pure: the second line's phrase, or null when it has none. */
function linePhrase(item) {
  const line = item && item.line;
  if (!line || !line.code) return null;
  switch (line.code) {
    case 'queued':
      return line.place ? { id: 'core:work.line.queuedAt', values: { place: Number(line.place) } } : { id: 'core:work.line.queued' };
    case 'reviewing':
      return { id: 'core:work.line.reviewing', values: { round: Number(line.round) || 1, of: Number(line.of) || 1 } };
    case 'checks_failing':
      return line.failing
        ? { id: 'core:work.line.checksFailingCount', values: { count: Number(line.failing) } }
        : { id: 'core:work.line.checksFailing' };
    case 'checks_running':
      return line.minutes ? { id: 'core:work.line.checksRunning', values: { count: Number(line.minutes) } } : null;
    // #6594: a push retired earlier yes votes; it says why a new yes is needed.
    case 'earlier_yes':
      return line.count ? { id: 'core:work.line.earlierYes', values: { count: Number(line.count) } } : null;
    case 'claimed': return line.by ? { id: 'core:work.line.claimed', values: { username: String(line.by) } } : null;
    case 'reason': return line.text ? { id: 'core:work.line.said', values: { reason: String(line.text) } } : null;
    default: return PLAIN_LINES.has(line.code) ? { id: `core:work.line.${camel(line.code)}` } : null;
  }
}

/**
 * Pure: an item's words, as phrase ids of the core catalog: its stage as
 * its requester reads it (`stage`) and as anyone else does (`stageOthers`),
 * and its second line (`line`, or null).
 */
function phrasesOf(item) {
  if (!item || !item.stage) return null;
  return { stage: stagePhrase(item, true), stageOthers: stagePhrase(item, false), line: linePhrase(item) };
}

let englishCatalog = null;
/** Pure: a phrase in English, from the core catalog (push-text.js reads it in a checkout and in the image). */
function english(phrase) {
  if (!phrase || !phrase.id) return '';
  if (!englishCatalog) {
    const pushText = require('./push-text');
    englishCatalog = pushText.englishFrom(pushText.englishTexts(null, 'core'));
  }
  return englishCatalog(phrase.id, phrase.values);
}

/** Pure: the stage's words in English, as the screens say them (phrasesOf). */
function stageSays(item, { yours = true } = {}) {
  const words = phrasesOf(item);
  return words ? english(yours ? words.stage : words.stageOthers) : '';
}

/** Pure: the second line in English, or null. */
function lineSays(item) {
  const line = linePhrase(item);
  return line ? english(line) || null : null;
}

// The second lines of the bot's stages that say it waits rather than works.
const WAITING_LINES = new Set([...NOT_STARTED, ...READY, 'update_queued', 'retry_plan', 'planning_with_you', 'claimed']);

/**
 * Pure: whether Homeroom bot is at an item this minute: reading it,
 * planning it or building it, not waiting its turn, a hold, or a person.
 */
function busyNow(item) {
  if (!item || item.whoseMove !== 'bot') return false;
  if (!['reading', 'planning', 'building'].includes(item.stage)) return false;
  const code = item.line && item.line.code;
  if (code === 'reply' && item.line.soon) return false;
  return !WAITING_LINES.has(code);
}

// What the Homeroom bot is reading or building on a request (`bot`: { what,
// since, plan?, held?, turn? }, or null), as a request's page and Ask
// Homeroom bot to build this read it before they read the standing: read
// off the same row, so the two never disagree.
const BOT_NOT_STARTED = new Set(['waiting', 'on_hold', 'cooldown', 'first_version_wait']);
function botWorkOf(item) {
  if (!item) return null;
  const code = item.line?.code || null;
  const since = item.since || null;
  switch (item.stage) {
    case 'reading':
      if (code === 'queued') return item.line.asked ? { what: 'queued', since } : null;
      if (BOT_NOT_STARTED.has(code) || (code === 'reply' && item.line.soon)) return null;
      return { what: 'reading', since };
    case 'planning':
      // Held for its requester's plan: nothing of the bot's is under way.
      // One whose build already waits behind the hold (`ready`) is still the
      // bot's, in its queue, so asking it to build it again is refused.
      if (code === 'planning_with_you') return item.line.ready ? { what: 'queued', since } : null;
      return { what: 'building', since };
    case 'building':
      if (code === 'held_builds' || code === 'held_waiting') {
        return { what: 'queued', since, held: true, ...(code === 'held_builds' ? { turn: true } : {}) };
      }
      if (code === 'claimed' || code === 'update_queued' || item.whoseMove === 'builder') return null;
      return { what: 'building', since };
    case 'waiting_for_you':
      return item.why === 'plan' ? { what: 'queued', since, plan: true } : null;
    default:
      return null;
  }
}

/** Pure: the stage and its second line in one English phrase ("Building · Starting"). */
function says(item, opts) {
  const line = lineSays(item);
  return line ? `${stageSays(item, opts)} · ${line}` : stageSays(item, opts);
}

// ── Reading the facts ─────────────────────────────────────────────────────

/**
 * One row per request named by ($1 app ids, $2 numbers), with every record
 * derive reads: the same per-request record the bot page and a request's
 * track read (homeroom-bot-progress.js requestRecordJoinsSql), its request's
 * own state, its requester, a claim on it, a private thread holding it for
 * the requester's plan, an update on its way, and its place in the bot's
 * line on its project.
 */
const REQUEST_FACTS_SQL = `
  WITH it AS (
    SELECT DISTINCT x.app_id, x.issue_number
      FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
  )
  SELECT it.app_id, it.issue_number,
         (SELECT a.slug FROM apps a WHERE a.id = it.app_id) AS app_slug,
         rq.user_id AS requester_id,
         COALESCE(rq.first_version, FALSE) AS first_version,
         iss.created_at AS request_at,
         (SELECT cr.closed_at FROM homeroom_bot_closed_requests cr
           WHERE cr.app_id = it.app_id AND cr.issue_number = it.issue_number) AS closed_at,
         ${progress.REQUEST_RECORD_COLUMNS},
         ${progress.requestClosedSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })} AS request_closed,
         cl.username AS claimed_by, cl.claimed_at,
         ${require('../workflow/rules/bot-loop.ts').planHoldSql('it.app_id', 'it.issue_number', 'NULL::int')} AS awaiting_plan,
         CASE WHEN cs.id IS NULL THEN NULL ELSE ${progress.updateComingSql('cs')} END AS update_coming,
         lc.id AS lc_id, lc.status AS lc_status, lc.check_state AS lc_check_state, lc.checks_checked_at AS lc_checks_at,
         lc.check_phase AS lc_check_phase, lc.merge_conflict_state AS lc_merge_conflict_state,
         lc.integration_merges_clean AS lc_integration_merges_clean, lc.integration_block_reasons AS lc_integration_block_reasons,
         lc.promoted_at AS lc_promoted_at, lc.merged_at AS lc_merged_at, lc.live_at AS lc_live_at,
         lc.last_activity_at AS lc_last_activity_at, lc.created_at AS lc_created_at, lc.update_coming AS lc_update_coming,
         lc.update_failed AS lc_update_failed,
         -- #6807: the lead change's open wait on a fix for a check that is not its own.
         ${flaky.flakeFixingSql('lc.id')} AS lc_flake_fixing,
         lc.username AS lc_by, q.priority AS queue_priority,
         -- #5323: a ready request's place among the project's builds waiting to start.
         CASE WHEN run.live_build_waiting_at IS NOT NULL AND run.build_session_id IS NULL THEN (
           SELECT COUNT(*)::int FROM homeroom_bot_runs b
            WHERE b.app_id = it.app_id AND b.mode = 'live' AND b.live_build_waiting_at IS NOT NULL
              AND b.build_session_id IS NULL AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
              AND b.live_build_waiting_at <= run.live_build_waiting_at
              AND b.id = (SELECT MAX(b2.id) FROM homeroom_bot_runs b2
                           WHERE b2.app_id = b.app_id AND b2.issue_number = b.issue_number AND b2.mode = 'live')
         ) END AS build_place,
         CASE WHEN q.id IS NOT NULL AND q.started_at IS NULL THEN (
           SELECT COUNT(*)::int FROM homeroom_bot_queue q2
            WHERE q2.app_id = it.app_id AND q2.started_at IS NULL AND q2.enqueued_at <= q.enqueued_at
         ) END AS queue_place,
         -- A held request's place among the project's requests held at the
         -- same limit, in the order the bot takes them back up (oldest hold
         -- first), counting only open ones: its track's "3rd in line".
         CASE WHEN run.cap_suppressed IS NOT NULL THEN (
           SELECT COUNT(*)::int FROM (
             SELECT DISTINCT ON (h.issue_number) h.issue_number, h.cap_suppressed, h.created_at
               FROM homeroom_bot_runs h
              WHERE h.app_id = it.app_id AND h.mode = 'live'
              ORDER BY h.issue_number, h.id DESC
           ) hq
            WHERE hq.cap_suppressed = run.cap_suppressed
              AND (hq.created_at < run.created_at OR (hq.created_at = run.created_at AND hq.issue_number <= it.issue_number))
              AND NOT ${progress.requestClosedSql({ appId: 'it.app_id', issueNumber: 'hq.issue_number' })}
         ) END AS held_place
    FROM it
    LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = it.app_id AND rq.issue_number = it.issue_number
    LEFT JOIN LATERAL (
      SELECT i.created_at FROM issues i
       WHERE i.app_id = it.app_id AND i.github_issue_number = it.issue_number
       ORDER BY i.id DESC LIMIT 1
    ) iss ON TRUE
    ${progress.requestRecordJoinsSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })}
    LEFT JOIN LATERAL (
      SELECT u.username, ic.claimed_at
        FROM issue_claims ic JOIN users u ON u.id = ic.user_id
       WHERE ic.app_id = it.app_id AND ic.github_issue_number = it.issue_number
         AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
         AND u.is_synthetic IS NOT TRUE
       ORDER BY ic.claimed_at DESC
       LIMIT 1
    ) cl ON TRUE
    -- The change somebody made for it (it says it closes it): what it
    -- stands at when Homeroom bot has no change of its own for it, and a
    -- person's under way holds the bot off as the bot itself reads it
    -- (homeroom-bot.js issueHolders). A posted plan is no change.
    LEFT JOIN LATERAL (
      SELECT c.id, c.status, c.check_state, c.checks_checked_at, c.check_phase,
             c.merge_conflict_state, c.integration_merges_clean, c.integration_block_reasons, c.promoted_at, c.merged_at, c.live_at,
             c.last_activity_at, c.created_at,
             (SELECT u.username FROM users u WHERE u.id = c.user_id AND u.is_synthetic IS NOT TRUE) AS username,
             CASE WHEN c.status = 'promoted' THEN ${progress.updateComingSql('c')} END AS update_coming,
             CASE WHEN c.status = 'promoted' THEN ${progress.updateFailedSql('c')} END AS update_failed
        FROM chat_sessions c
       WHERE c.app_id = it.app_id AND it.issue_number = ANY(c.linked_issues)
         AND c.is_headless = FALSE
         AND NOT ${planRecordSql('c')}
         AND c.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       ORDER BY CASE c.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END, c.id DESC
       LIMIT 1
    ) lc ON TRUE`;

// The checks of a change's newest verdict that did not pass (progress.js
// failedCount, in SQL).
const FAILED_CHECKS_SQL = (cs) => `(SELECT COUNT(*)::int
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${cs}.test_results) = 'array' THEN ${cs}.test_results ELSE '[]'::jsonb END) t
    WHERE COALESCE(t->>'status', '') NOT IN ('', 'pass'))`;

/**
 * One row per change named by $1 (session ids): what its stage and its
 * standing read (its checks and their head, what holds its vote or its
 * merge, an update on its way, its votes this round), and whether it is
 * about requests of its own (`has_requests`).
 */
const CHANGE_FACTS_SQL = `
  SELECT cs.id, cs.app_id, (SELECT a.slug FROM apps a WHERE a.id = cs.app_id) AS app_slug, cs.user_id, cs.status,
         cs.pr_number, cs.is_headless, cs.check_state, cs.checks_checked_at AS checks_at,
         cs.check_phase, cs.merge_conflict_state, cs.integration_merges_clean, cs.integration_block_reasons,
         cs.promoted_at, cs.merged_at, cs.live_at, cs.created_at, cs.last_activity_at,
         cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.checks_commit_sha,
         cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at,
         CASE WHEN cs.check_state IN ('failing', 'error') THEN ${FAILED_CHECKS_SQL('cs')} END AS failed_checks,
         ${firstVersionSql('cs')} AS first_version,
         CASE WHEN cs.status = 'promoted' THEN ${progress.updateComingSql('cs')} END AS update_coming,
         -- #6600: why a takeover's last attempt failed, when it did.
         CASE WHEN cs.status = 'promoted' THEN ${progress.updateFailedSql('cs')} END AS update_failed,
         -- #6807: an open wait on a fix for a check that is not this change's.
         ${flaky.flakeFixingSql('cs.id')} AS flake_fixing,
         (SELECT COUNT(*) FILTER (WHERE pv.vote = 'yes') FROM pr_votes pv
           WHERE pv.session_id = cs.id AND ${currentVotePredicateSql('pv', 'cs')})::int AS votes_yes,
         (SELECT COUNT(*) FILTER (WHERE pv.vote = 'no') FROM pr_votes pv
           WHERE pv.session_id = cs.id AND ${currentVotePredicateSql('pv', 'cs')})::int AS votes_no,
         -- Each run column on its own index (one OR would read every run).
         (cardinality(COALESCE(cs.linked_issues, '{}'::int[])) > 0
          OR EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.proposal_session_id = cs.id)
          OR EXISTS (SELECT 1 FROM homeroom_bot_runs r WHERE r.build_session_id = cs.id)) AS has_requests,
         -- Its open cards (one of Homeroom bot's offers on it).
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'expiresAt', c.expires_at) ORDER BY c.id)
                     FROM bot_cards c
                    WHERE c.status = 'open' AND c.expires_at > NOW()
                      AND (c.session_id = cs.id OR (c.args->>'sessionId') = cs.id::text)), '[]'::jsonb) AS offers
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[])`;

/**
 * What is asked of each request's requester and what Homeroom bot last said
 * about it, one row per request named by ($1 app ids, $2 numbers): the
 * bot's open question, its newest plan, an open vote to close it, a private
 * thread holding it for its requester's plan, its open cards (and a
 * thread's offers from before the card store), the reports filed from it,
 * and the bot's newest post about it.
 */
const STANDING_SQL = `
  WITH it AS (
    SELECT DISTINCT x.app_id, x.issue_number
      FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
  )
  SELECT it.app_id, it.issue_number,
         oq.message_id AS question_id, oq.created_at AS question_at,
         pl.session_id AS plan_session_id, pl.version AS plan_version, pl.created_at AS plan_at,
         cv.id AS close_id, cv.yes AS close_yes, cv.no AS close_no,
         dr.id AS draft_id,
         COALESCE((SELECT jsonb_agg(o ORDER BY o->>'id') FROM (
             SELECT jsonb_build_object('id', c.id, 'kind', c.kind, 'expiresAt', c.expires_at) AS o
               FROM bot_cards c
              WHERE c.app_id = it.app_id AND c.status = 'open' AND c.expires_at > NOW()
                AND COALESCE(c.issue_number, c.source_issue_number,
                             CASE WHEN (c.args->>'issueNumber') ~ '^[0-9]{1,9}$' THEN (c.args->>'issueNumber')::int END) = it.issue_number
             UNION ALL
             SELECT jsonb_build_object('id', v.id, 'kind', v.kind, 'expiresAt', v.created_at + INTERVAL '14 days')
               FROM homeroom_bot_voice_offers v
              WHERE v.app_id = it.app_id AND v.status = 'open' AND v.created_at > NOW() - INTERVAL '14 days'
                AND (v.args->>'issueNumber') = it.issue_number::text
           ) offered), '[]'::jsonb) AS offers,
         (SELECT COUNT(*)::int FROM feedback_reports fr
           WHERE fr.app_id = it.app_id AND fr.issue_number = it.issue_number) AS reports,
         sd.message_id AS said_id, sd.kind AS said_kind, sd.created_at AS said_at, sd.text AS said_text
    FROM it
    LEFT JOIN LATERAL (
      SELECT d.message_id, d.created_at FROM homeroom_bot_dm_messages d
       WHERE d.app_id = it.app_id AND d.issue_number = it.issue_number AND d.question_status = 'open'
       ORDER BY d.created_at DESC LIMIT 1
    ) oq ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.session_id, s.version, s.created_at
        FROM chat_session_specs s
        JOIN chat_sessions c ON c.id = s.session_id
       WHERE c.app_id = it.app_id
         AND (c.created_from_issue_number = it.issue_number OR it.issue_number = ANY(c.linked_issues))
         AND (s.shared_to_group_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM homeroom_bot_runs r
                          WHERE r.app_id = it.app_id AND r.issue_number = it.issue_number AND r.build_session_id = c.id))
       ORDER BY s.created_at DESC, s.version DESC LIMIT 1
    ) pl ON TRUE
    LEFT JOIN LATERAL (
      SELECT i.id,
             (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id AND v.vote = 'yes')::int AS yes,
             (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id AND v.vote = 'no')::int AS no
        FROM issues i
       WHERE i.app_id = it.app_id AND i.kind = 'close_issue' AND i.status = 'open'
         AND (i.payload->>'issueNumber') = it.issue_number::text
       ORDER BY i.id DESC LIMIT 1
    ) cv ON TRUE
    LEFT JOIN LATERAL (
      SELECT ph.id FROM private_threads ph
       WHERE ph.app_id = it.app_id AND ph.about_number = it.issue_number
         AND ${require('../workflow/rules/bot-loop.ts').planHoldActiveSql('ph')}
       ORDER BY ph.id DESC LIMIT 1
    ) dr ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.thread_message_id AS message_id, p.kind, p.created_at, LEFT(m.content, 200) AS text
        FROM homeroom_bot_posts p
        JOIN chat_messages m ON m.id = p.thread_message_id
       WHERE p.app_id = it.app_id AND p.issue_number = it.issue_number AND p.pending IS NOT TRUE
         AND m.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) sd ON TRUE`;

// The live runs of each request named by ($1 app ids, $2 numbers), newest
// first, at most 200 of each: what their tries count, and why a build
// stopped. The limit is per request, so one request with many runs never
// takes another's out of a batch (its tries and its cause read from its own
// newest runs, whatever else is refreshed with it).
const STANDING_RUNS_SQL = `
  SELECT r.*
    FROM (SELECT DISTINCT x.app_id, x.issue_number FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)) it
    CROSS JOIN LATERAL (
      SELECT r.id, r.app_id, r.issue_number, r.verdict, r.cap_suppressed, r.awaiting_go_at, r.proposal_session_id,
             r.build_ok, r.build_error, r.build_session_id, r.error, r.created_at,
             r.build_no_change->'turns'->-1->>'said' AS no_change_said,
             (r.plan IS NOT NULL AND r.plan->'chosen' IS NULL AND r.build_ok IS FALSE
               AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL) AS plan_only
        FROM homeroom_bot_runs r
       WHERE r.app_id = it.app_id AND r.issue_number = it.issue_number AND r.mode = 'live'
       ORDER BY r.id DESC
       LIMIT 200
    ) r
   ORDER BY r.id DESC`;

// Who shipped a closed request: the newest merged change linked to it that
// is not the bot's. `$1`/`$2` the requests as parallel arrays of project
// and number.
const DONE_BY_SQL = `
  SELECT DISTINCT ON (w.app_id, w.n) w.app_id, w.n, cs.id AS session_id, cs.pr_number, u.username
    FROM UNNEST($1::int[], $2::int[]) AS w(app_id, n)
    JOIN chat_sessions cs ON cs.app_id = w.app_id AND cs.status = 'merged'
         AND (w.n = ANY(cs.linked_issues) OR cs.created_from_issue_number = w.n)
    JOIN users u ON u.id = cs.user_id
   WHERE u.username <> 'homeroom_bot'
   ORDER BY w.app_id, w.n, cs.merged_at DESC NULLS LAST, cs.id DESC`;

/**
 * The requests a session is about: the requests whose bot run built or
 * proposed it, then the ones it says it closes. Empty for a change with no
 * request, which is its own item.
 */
async function requestsOfSession(db, sessionId) {
  // One branch per run column, so each reads its own index (an OR of the
  // two would read every run); UNION drops the repeats.
  const { rows } = await db.query(
    `SELECT r.app_id, r.issue_number FROM homeroom_bot_runs r WHERE r.proposal_session_id = $1
     UNION
     SELECT r.app_id, r.issue_number FROM homeroom_bot_runs r WHERE r.build_session_id = $1
     UNION
     SELECT cs.app_id, n AS issue_number FROM chat_sessions cs, unnest(cs.linked_issues) AS n
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
}

// ── Storing ──────────────────────────────────────────────────────────────

// jsonb hands keys back in its own order, so two values are compared with
// their keys sorted, never as written.
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canon(value[k])]));
  }
  return value instanceof Date ? value.toISOString() : value;
}
const sameJson = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

async function upsert(db, key, next, { touch = false } = {}) {
  const { rows: [prev] } = await db.query(
    `SELECT stage, why, reason, line, whose_move, requester_id, since, standing, vote_open, lead_change_id FROM work_states
      WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3`,
    [key.appId, key.kind, key.ref],
  );
  const standing = next.standing || {};
  if (prev && prev.stage === next.stage && (prev.why || null) === next.why && (prev.reason || null) === next.reason
    && sameJson(prev.line, next.line) && (prev.whose_move || null) === next.whoseMove
    && (prev.requester_id == null ? null : Number(prev.requester_id)) === (next.requesterId ?? null)
    && prev.vote_open === !!next.voteOpen
    && (prev.lead_change_id == null ? null : Number(prev.lead_change_id)) === (next.leadChangeId ?? null)
    && sameJson(prev.standing || {}, standing)) {
    // Unchanged. The sweep still marks it checked, so it moves on to others.
    if (touch) {
      await db.query('UPDATE work_states SET checked_at = NOW() WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3',
        [key.appId, key.kind, key.ref]);
    }
    return null;
  }
  await db.query(
    `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, session_id, stage, why, reason, line,
                              whose_move, requester_id, since, standing, vote_open, lead_change_id, updated_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, NOW(), NOW())
     ON CONFLICT (app_id, item_kind, item_ref) DO UPDATE
       SET issue_number = EXCLUDED.issue_number, session_id = EXCLUDED.session_id, stage = EXCLUDED.stage,
           why = EXCLUDED.why, reason = EXCLUDED.reason, line = EXCLUDED.line, whose_move = EXCLUDED.whose_move,
           requester_id = EXCLUDED.requester_id, since = EXCLUDED.since, standing = EXCLUDED.standing,
           vote_open = EXCLUDED.vote_open, lead_change_id = EXCLUDED.lead_change_id,
           updated_at = NOW(), checked_at = NOW()`,
    [key.appId, key.kind, key.ref, key.issueNumber ?? null, key.sessionId ?? null, next.stage, next.why, next.reason,
      next.line ? JSON.stringify(next.line) : null, next.whoseMove, next.requesterId ?? null, next.since,
      JSON.stringify(standing), !!next.voteOpen, next.leadChangeId ?? null],
  );
  return {
    prev: prev ? {
      stage: prev.stage, why: prev.why || null, reason: prev.reason || null, line: prev.line || null,
      // Whether a vote on closing it was open: one opening retires its
      // Propose to close buttons (bot-cards.js retireFor).
      closeVote: !!prev.standing?.asks?.closeVote,
    } : null,
  };
}

const IN_FLIGHT_CHECKS = (s) => s === 'pending' || s === 'running';

/**
 * Attach `checks_estimate` (the Testing card's own estimate, cached a minute
 * per app) to facts rows whose change is promoted and still checking, so a
 * run in flight can say "About N min left" (#6402). Best-effort: a failed
 * read is no estimate, and no estimate is no line.
 */
async function attachChecksEstimate(db, rows, wants) {
  const byApp = new Map();
  for (const row of rows) {
    if (!wants(row)) continue;
    const id = Number(row.app_id);
    if (!byApp.has(id)) byApp.set(id, await checksEstimate.forApp(db, id).catch(() => null));
    row.checks_estimate = byApp.get(id);
  }
}

// #6594: the predicate over a work_states row (`w`) that says its votes are
// in: it is going live, or it is approved and waiting on checks.
const APPROVED_SQL = (alias) => `(${alias}.stage = 'going_live' OR ${alias}.line->>'code' IN ('approved_checking', 'github_checks'))`;

const VOTES_IN_SQL = `
  SELECT cs.id, cs.app_id, cs.user_id, cs.promoted_at, cs.created_at,
         cs.requires_explicit_approval, cs.explicit_approval_reason,
         ${require('./first-version-rule').firstVersionSql('cs')} AS first_version,
         -- #6594: yes voters a push retired: they voted on an earlier
         -- version, their yes no longer counts, and they have not confirmed
         -- it on this one. The vote prompt says why a new yes is needed.
         (SELECT COUNT(DISTINCT pv.user_id)::int
            FROM pr_votes pv
           WHERE pv.session_id = cs.id AND pv.vote = 'yes'
             AND pv.approval_epoch < cs.approval_epoch
             AND counts_toward_session_outcome(pv.user_id, cs.id)
             AND pv.user_id IS DISTINCT FROM cs.user_id
             AND NOT EXISTS (SELECT 1 FROM pr_votes cur
                              WHERE cur.session_id = cs.id AND cur.user_id = pv.user_id
                                AND cur.approval_epoch = cs.approval_epoch)) AS earlier_yes
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[]) AND cs.status = 'promoted'`;

/**
 * #6594: attach `votes_in` (the project's rule would let this change merge
 * now) and `earlier_yes` to facts rows whose change is promoted, so a change
 * whose votes are in never reads "Up for a vote". The gate is the same one
 * every merge decision takes, so its count can never disagree with the
 * Votes card's: current-epoch yes votes, the member floor and explicit
 * approval. Best-effort: a failed read leaves `votes_in` false, which is
 * today's wording.
 */
async function attachVotes(db, rows, keyOf, now) {
  const bySession = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const id = key ? Number(key.id) : 0;
    if (!(id > 0)) continue;
    if (!bySession.has(id)) bySession.set(id, { prefix: key.prefix || '', rows: [] });
    bySession.get(id).rows.push(row);
  }
  if (!bySession.size) return;
  try {
    const { rows: facts } = await db.query(VOTES_IN_SQL, [[...bySession.keys()]]);
    const governance = require('./governance');
    for (const f of facts) {
      const id = Number(f.id);
      const { prefix, rows: of } = bySession.get(id);
      let votesIn = false;
      if (f.first_version !== true) {
        const gate = await governance.governedGate(db, Number(f.app_id), {
          kind: 'pr', id, openedAt: f.promoted_at || f.created_at, now,
          explicitApproval: f.requires_explicit_approval === true,
          explicitReason: f.explicit_approval_reason || null,
          authorId: f.user_id == null ? null : Number(f.user_id),
          firstVersion: false,
        }).catch(() => null);
        votesIn = gate?.mergeable === true;
      }
      for (const row of of) {
        row[`${prefix}votes_in`] = votesIn;
        row[`${prefix}earlier_yes`] = Number(f.earlier_yes) || 0;
      }
    }
  } catch (err) {
    require('./logger').warn('work-state', 'votes read failed', { message: err.message });
  }
}

/**
 * Pure: a change's facts as its standing carries them (the contract every
 * reader draws: services/work-state.js fromRow `change`), with whether it is
 * open for votes from its own stage. Null for no change.
 */
function changeStandingOf(f, changeState, now = new Date()) {
  if (!f) return null;
  const promoted = f.status === 'promoted';
  return {
    id: Number(f.id),
    number: f.pr_number == null ? null : Number(f.pr_number),
    status: f.status || null,
    checks: {
      state: f.check_state || null,
      phase: f.check_phase || null,
      failing: f.failed_checks == null ? null : Number(f.failed_checks),
    },
    votes: { yes: Number(f.votes_yes) || 0, no: Number(f.votes_no) || 0 },
    voteOpen: voteOpenOf(changeState),
    firstVersion: f.first_version === true,
    githubHold: promoted && !!githubHold(f),
    shotsHeld: promoted && shotsHeld(f, now),
    conflict: promoted && (f.merge_conflict_state === 'conflict' || f.merge_conflict_state === 'failed' || f.integration_merges_clean === false),
    update: promoted && (f.update_coming === 'queued' || f.update_coming === 'running') ? f.update_coming : null,
  };
}

const NO_ASKS = Object.freeze({ question: null, plan: null, closeVote: null, draft: null, offers: [], reports: 0 });

/**
 * Pure: what a request's standing says beside its stage, from its facts row
 * (REQUEST_FACTS_SQL), its STANDING_SQL row, its live runs (newest first),
 * its derived state and its lead change: the change, what is asked of its
 * requester, the bot's newest post about it, its tries (a request's track's
 * "Try 2"), why a build stopped, and who shipped it.
 */
function requestStandingOf({ row, extra = null, runs = [], next, change = null, doneBy = null }) {
  const iso2 = (v) => iso(v);
  const waitingGo = next.stage === 'waiting_for_you' && next.why === 'plan';
  const plan = extra && extra.plan_version != null
    ? { version: Number(extra.plan_version), sessionId: Number(extra.plan_session_id) || null, at: iso2(extra.plan_at), waitingGo }
    : waitingGo
      ? { version: null, sessionId: Number(row.build_session_id) || null, at: iso2(row.plan_waiting_at), waitingGo }
      : null;
  const asks = extra ? {
    question: extra.question_id ? { messageId: Number(extra.question_id), at: iso2(extra.question_at) } : null,
    plan,
    closeVote: extra.close_id ? { issueId: Number(extra.close_id), yes: Number(extra.close_yes) || 0, no: Number(extra.close_no) || 0 } : null,
    draft: extra.draft_id ? { threadId: Number(extra.draft_id) } : null,
    offers: (Array.isArray(extra.offers) ? extra.offers : []).map((o) => ({ id: Number(o.id), kind: String(o.kind), expiresAt: iso2(o.expiresAt) })),
    reports: Number(extra.reports) || 0,
  } : { ...NO_ASKS, plan };
  const said = extra && extra.said_id
    ? { messageId: Number(extra.said_id), kind: extra.said_kind || null, at: iso2(extra.said_at), text: String(extra.said_text || '').slice(0, 200) }
    : null;
  // Its tries, as its track counts them: a change being fixed or updated is
  // its next try until a run records it (homeroom-bot-track.js triesOf).
  const track = require('./homeroom-bot-track');
  const code = next.line && next.line.code;
  const since = next.since || iso2(row.run_at);
  const underWay = (code === 'fixing' || code === 'revising')
    && !runs.some((run) => run.verdict === 'revise' && Date.parse(run.created_at) >= Date.parse(since || 0));
  const lead = runs[0] || null;
  return {
    change,
    asks,
    said,
    tries: track.triesOf(runs, { underWay }),
    tryStarts: track.tryStartsOf(runs, { underWay: underWay ? since : null }),
    cause: next.stage === 'stopped' && next.reason === 'build_failed' && lead
      ? track.buildStopWhy(lead.build_error, lead.no_change_said ? { said: lead.no_change_said } : null)
      : null,
    doneBy: next.stage === 'closed' && doneBy
      ? { username: doneBy.username || null, prNumber: Number(doneBy.pr_number) || null, sessionId: Number(doneBy.session_id) || null }
      : null,
  };
}

// A change built for a request has a row of its own once it is up for a
// vote or past it (Needs you reads whether it is open for votes); before
// that its request's row is where it stands.
const CHANGE_ROW_STATUSES = new Set(['promoted', 'merging', 'merged', 'closed', 'archived']);

/**
 * Derive the items again and store each that changed. `items` are
 * { appId, issueNumber } (a request) or { sessionId } (a change: its own
 * row, and the rows of the requests it is about). Resolves the changed
 * rows: { appId, kind, ref, issueNumber, sessionId, state, prev, bell },
 * `state` carrying the whole stored row (stage, why, reason, line, whose
 * move, since, requesterId, voteOpen, leadChangeId, standing).
 */
async function refresh(db, items, { now = new Date(), touch = false } = {}) {
  const requests = new Map();
  const changes = new Set();
  for (const it of items || []) {
    if (it && Number(it.appId) > 0 && Number(it.issueNumber) > 0) {
      requests.set(`${Number(it.appId)}:${Number(it.issueNumber)}`, { appId: Number(it.appId), issueNumber: Number(it.issueNumber) });
    } else if (it && Number(it.sessionId) > 0) {
      for (const r of await requestsOfSession(db, Number(it.sessionId))) requests.set(`${r.appId}:${r.issueNumber}`, r);
      changes.add(Number(it.sessionId));
    }
  }
  const changed = [];
  let rows = [];
  if (requests.size) {
    const list = [...requests.values()];
    ({ rows } = await db.query(REQUEST_FACTS_SQL, [list.map((r) => r.appId), list.map((r) => r.issueNumber)]));
    // Stored in one order everywhere (by project and number, then by
    // change), so two refreshes of the same rows never wait on each other.
    rows.sort((a, b) => Number(a.app_id) - Number(b.app_id) || Number(a.issue_number) - Number(b.issue_number));
  }
  // The change each request draws: the bot's newest proposal of it, else a
  // person's change for it. Its facts are read with the changes named.
  const leads = new Set();
  for (const row of rows) {
    row.lead_change_id = Number(row.proposal_session_id) || Number(row.lc_id) || null;
    if (row.lead_change_id) leads.add(row.lead_change_id);
    if (Number(row.lc_id)) leads.add(Number(row.lc_id));
  }
  const ids = [...new Set([...changes, ...leads])];
  const facts = new Map();
  if (ids.length) {
    const { rows: found } = await db.query(CHANGE_FACTS_SQL, [ids]);
    await attachChecksEstimate(db, found, (r) => r.status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state));
    // #6594: whether each promoted change's votes are in, which decides
    // whether it asks for a vote at all. Read once per change, here, and
    // handed to the requests that draw it below.
    await attachVotes(db, found, (r) => (r.status === 'promoted' ? { id: Number(r.id), prefix: '' } : null), now);
    for (const f of found) facts.set(Number(f.id), f);
  }
  const changeStates = new Map([...facts.values()].map((f) => [Number(f.id), deriveChange(f, { now })]));

  if (rows.length) {
    await attachChecksEstimate(db, rows, (r) => (r.proposal_status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state))
      || (r.lc_status === 'promoted' && IN_FLIGHT_CHECKS(r.lc_check_state)));
    // #6594: a request reads its change's votes from that change's facts
    // (the bot's own proposal of it, or a person's change for it).
    for (const row of rows) {
      const own = row.proposal_status === 'promoted' ? facts.get(Number(row.proposal_session_id)) : null;
      if (own) Object.assign(row, { votes_in: own.votes_in === true, earlier_yes: Number(own.earlier_yes) || 0 });
      const theirs = row.lc_status === 'promoted' ? facts.get(Number(row.lc_id)) : null;
      if (theirs) Object.assign(row, { lc_votes_in: theirs.votes_in === true, lc_earlier_yes: Number(theirs.earlier_yes) || 0 });
    }
    // Which of them wait for their project's first version, by the bot's
    // own rule (as its read lane and a project chat's card read it).
    const bot = require('./homeroom-bot');
    const holds = await bot.firstVersionHolds(db, [...new Set(rows.map((r) => Number(r.app_id)))]).catch(() => new Map());
    for (const row of rows) {
      row.held_first_version = bot.heldForFirstVersion(holds, {
        appId: row.app_id, issueNumber: row.issue_number, firstVersion: row.first_version === true, reason: row.queue_reason || null,
      });
      // A person's change for it reads the change's own facts (deriveFacts).
      if (Number(row.lc_id) && facts.has(Number(row.lc_id))) row.lc_facts = facts.get(Number(row.lc_id));
    }
    const pairs = [rows.map((r) => Number(r.app_id)), rows.map((r) => Number(r.issue_number))];
    const [{ rows: extras }, { rows: runs }] = await Promise.all([
      db.query(STANDING_SQL, pairs),
      db.query(STANDING_RUNS_SQL, pairs),
    ]);
    const extraOf = new Map(extras.map((e) => [`${e.app_id}:${e.issue_number}`, e]));
    const runsOf = new Map();
    for (const run of runs) {
      const k = `${run.app_id}:${run.issue_number}`;
      if (!runsOf.has(k)) runsOf.set(k, []);
      runsOf.get(k).push(run);
    }
    const derived = rows.map((row) => {
      let next = derive(row, { now });
      const lead = row.lead_change_id ? facts.get(row.lead_change_id) || null : null;
      const leadState = lead ? changeStates.get(Number(lead.id)) : null;
      const voteOpen = !!lead && voteOpenOf(leadState);
      // 11 Nov 2026: a request is up for a vote only while its change is
      // open for votes; otherwise it is where its change is.
      if (next.stage === 'up_for_vote' && lead && !voteOpen && leadState) next = { ...leadState };
      return { row, next, lead, leadState, voteOpen };
    });
    const closed = derived.filter((d) => d.next.stage === 'closed');
    const doneBy = new Map();
    if (closed.length) {
      const { rows: shipped } = await db.query(DONE_BY_SQL, [closed.map((d) => Number(d.row.app_id)), closed.map((d) => Number(d.row.issue_number))]);
      for (const r of shipped) doneBy.set(`${r.app_id}:${r.n}`, r);
    }
    for (const { row, next: derivedState, lead, leadState, voteOpen } of derived) {
      const k = `${row.app_id}:${row.issue_number}`;
      const next = {
        ...derivedState,
        requesterId: row.requester_id == null ? null : Number(row.requester_id),
        voteOpen,
        leadChangeId: row.lead_change_id || null,
      };
      next.standing = requestStandingOf({
        row, extra: extraOf.get(k) || null, runs: runsOf.get(k) || [], next,
        change: changeStandingOf(lead, leadState, now), doneBy: doneBy.get(k) || null,
      });
      const sessionId = Number(row.proposal_session_id || row.build_session_id || row.lc_id) || null;
      const key = { appId: Number(row.app_id), kind: 'request', ref: Number(row.issue_number), issueNumber: Number(row.issue_number), sessionId };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, appSlug: row.app_slug || null, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
    }
  }

  // The changes' own rows: every change named, and each request's change
  // once it is up for a vote or past it. Never a headless session's. A row
  // a change already has is always derived again (a change built for a
  // request that went back to Underway, or was closed, must not keep saying
  // it is open for votes, and the sweep must find it checked), and one whose
  // change is gone or headless is removed.
  const existing = new Set();
  if (ids.length) {
    // A change's row carries its own id as its session (work_states_session_idx).
    const { rows: had } = await db.query(
      `SELECT item_ref FROM work_states WHERE session_id = ANY($1::int[]) AND item_kind = 'change'`, [ids]);
    for (const r of had) existing.add(Number(r.item_ref));
  }
  const gone = [...existing].filter((id) => !facts.has(id) || facts.get(id).is_headless === true);
  if (gone.length) {
    await db.query(`DELETE FROM work_states WHERE session_id = ANY($1::int[]) AND item_kind = 'change'`, [gone]);
  }
  const own = [...facts.values()]
    .filter((f) => f.is_headless !== true && (changes.has(Number(f.id)) || leads.has(Number(f.id))))
    .filter((f) => existing.has(Number(f.id)) || f.has_requests !== true || CHANGE_ROW_STATUSES.has(f.status))
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const f of own) {
    const st = changeStates.get(Number(f.id));
    const next = {
      ...st,
      requesterId: f.user_id == null ? null : Number(f.user_id),
      voteOpen: voteOpenOf(st),
      leadChangeId: null,
      standing: {
        change: changeStandingOf(f, st, now),
        asks: { ...NO_ASKS, offers: (Array.isArray(f.offers) ? f.offers : []).map((o) => ({ id: Number(o.id), kind: String(o.kind), expiresAt: iso(o.expiresAt) })) },
        said: null,
      },
    };
    const key = { appId: Number(f.app_id), kind: 'change', ref: Number(f.id), issueNumber: null, sessionId: Number(f.id) };
    const wrote = await upsert(db, key, next, { touch });
    // A change with requests never rings: its requests' rows do.
    if (wrote) {
      changed.push({
        ...key, appSlug: f.app_slug || null, state: next, prev: wrote.prev,
        bell: f.has_requests === true ? null : bellOf(wrote.prev, next),
      });
    }
  }
  return changed;
}

// ── The workflow's hook ──────────────────────────────────────────────────

// The machines whose transitions move a request or a change, and how an
// instance's key names what it is about.
const WATCHED = new Set([
  'bot-request', 'bot-build', 'bot-change', 'proposal', 'preview', 'merge-followups', 'app-delivery', 'governance-proposal',
]);

// A vote decides a request only when it closes or reopens one, as it applies.
const DECIDING_KINDS = new Set(['close_issue', 'reopen_issue']);

/**
 * Pure: whether an accepted event may move a request or change (the
 * kernel's afterAccepted `wants`, asked before any query): a watched
 * machine's, and of a governance vote only the one that applies a close or
 * a reopen.
 */
function wants({ machine, state, data } = {}) {
  if (!WATCHED.has(machine)) return false;
  if (machine === 'governance-proposal') return state === 'applied' && DECIDING_KINDS.has(data?.kind);
  return true;
}

/** The items one instance of a watched machine is about. */
async function itemsOf(db, { machine, key, appId }) {
  if (!WATCHED.has(machine) || typeof key !== 'string') return [];
  let m = /^request:(\d+):(\d+)$/.exec(key);
  if (m) return [{ appId: Number(m[1]), issueNumber: Number(m[2]) }];
  m = /^run:(\d+)(?:@.*)?$/.exec(key);
  if (m) {
    const { rows } = await db.query('SELECT app_id, issue_number FROM homeroom_bot_runs WHERE id = $1', [Number(m[1])]);
    return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
  }
  m = /^session:(\d+)$/.exec(key);
  if (m) return [{ sessionId: Number(m[1]) }];
  // A vote to close or reopen a request (governance-proposal): the request
  // it names, and the ones open in its thread that close with it.
  m = machine === 'governance-proposal' && /^issue:(\d+)$/.exec(key);
  if (m) {
    const { rows } = await db.query(
      `SELECT p.app_id, (p.payload->>'issueNumber')::int AS issue_number, p.thread_id
         FROM issues p
        WHERE p.id = $1 AND p.kind IN ('close_issue', 'reopen_issue')
          AND (p.payload->>'issueNumber') ~ '^[0-9]+$'`,
      [Number(m[1])],
    );
    if (!rows.length) return [];
    const { rows: thread } = rows[0].thread_id ? await db.query(
      `SELECT r.app_id, r.number AS issue_number FROM requests r WHERE r.thread_id = $1 AND r.app_id = $2`,
      [rows[0].thread_id, rows[0].app_id],
    ) : { rows: [] };
    const out = new Map();
    for (const r of [...rows, ...thread]) out.set(`${r.app_id}:${r.issue_number}`, { appId: Number(r.app_id), issueNumber: Number(r.issue_number) });
    return [...out.values()];
  }
  m = /^app:(\d+)$/.exec(key);
  if (m) {
    // An app's delivery: whatever of it is going live may be live now.
    const { rows } = await db.query(
      `SELECT app_id, item_kind, item_ref, session_id FROM work_states WHERE app_id = $1 AND stage = 'going_live'`,
      [Number(m[1])],
    );
    return rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) }));
  }
  void appId;
  return [];
}

/**
 * Pure: a work state as every reader takes it (fromRow, the push, a
 * request's `standing` on its page): the stored row, its words (phrasesOf)
 * and its standing (its change, what is asked, what the bot last said). The
 * per-viewer facts (`mine`, `voteOwed`) are the reader's to add.
 */
function shapeOf(item) {
  const standing = item.standing && typeof item.standing === 'object' ? item.standing : {};
  const out = {
    appId: Number(item.appId),
    app: item.app || null,
    kind: item.kind,
    ref: Number(item.ref),
    issueNumber: item.issueNumber == null ? null : Number(item.issueNumber),
    sessionId: item.sessionId == null ? null : Number(item.sessionId),
    stage: item.stage,
    why: item.why || null,
    reason: item.reason || null,
    line: item.line || null,
    whoseMove: item.whoseMove || null,
    requesterId: item.requesterId == null ? null : Number(item.requesterId),
    since: iso(item.since),
    updatedAt: iso(item.updatedAt),
    voteOpen: !!item.voteOpen,
    leadChangeId: item.leadChangeId == null ? null : Number(item.leadChangeId),
    words: phrasesOf(item),
    change: standing.change || null,
    asks: standing.asks || { ...NO_ASKS },
    said: standing.said || null,
  };
  if (item.kind === 'request') {
    out.tries = Number(standing.tries) || 1;
    out.tryStarts = Array.isArray(standing.tryStarts) ? standing.tryStarts : [];
    out.cause = standing.cause || null;
    out.doneBy = standing.doneBy || null;
  }
  return out;
}

/**
 * The push a changed row is carried by, to everyone who may view its app:
 * the whole row (shapeOf) as anybody but its requester reads it (publicOf).
 */
function pushOf(row) {
  const state = publicOf(shapeOf({
    ...row.state,
    appId: row.appId, kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId,
    app: row.appSlug ? { slug: row.appSlug, name: row.appName || row.appSlug } : null,
    updatedAt: row.updatedAt || new Date(),
  }));
  return {
    kind: 'scoped',
    routing: { appId: row.appId, appSlug: row.appSlug || null },
    data: {
      type: 'work_state',
      appId: row.appId,
      appSlug: row.appSlug || null,
      item: { kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId },
      state,
    },
  };
}

/**
 * Publish pushes from outside a transition (a route, the sweep): the same
 * bus envelope a transition's pushes use, so every process delivers them.
 * Inside a transaction they go out when it commits.
 */
async function publish(db, pushes) {
  if (!pushes || !pushes.length) return;
  const bus = require('./ws-bus');
  await db.query(
    'SELECT pg_notify($1, body) FROM unnest($2::text[]) WITH ORDINALITY AS t(body, n) ORDER BY n',
    [bus.CHANNEL, pushes.map((p) => bus.workflowBody(p.kind, p.routing ?? null, p.data))],
  );
}

/**
 * Refresh items a route changed outside any machine (a close, a reopen, a
 * claim, a vote) and publish what changed. Never throws: the route's own
 * write stands, and the sweep corrects a row this missed.
 */
async function touched(db, items) {
  try {
    const changed = await refresh(db, items);
    await publish(db, await pushesOf(db, changed));
    return changed;
  } catch (err) {
    require('./logger').warn('work-state', 'refresh after a route write failed', { message: err.message });
    return [];
  }
}

// ── The bell ─────────────────────────────────────────────────────────────

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): a request's requester
// hears four moments, rung from its stage alone: into waiting_for_you
// (needs you), up_for_vote (ready to vote), stopped, and live. The bell row
// is written with the stage, in the same transaction, and its words come
// from homeroom-bot-notify-copy.js as the bot's own moments' do; it opens
// the request. A first version's news is still the bot's own messages,
// which ring themselves (homeroom-bot-dm.js sendDm), so it is not rung here.
const BELL_KINDS = Object.freeze({ needs_you: 'build_needs_you', ready: 'build_ready', stopped: 'build_stopped', live: 'build_live' });
const WHY_SAID = Object.freeze({ question: 'question', plan: 'plan', decide: 'decide', already_works: 'done', needs_detail: 'empty' });
const REASON_SAID = Object.freeze({
  build_failed: 'build_other', fix_stopped: 'checks', look_failed: 'build_other', change_closed: 'build_other', stalled: 'build_no_start',
});

/** Pure: which of a moment's words a change of stage says (homeroom-bot-notify-copy.js `said`). */
function bellSaid(bell, item, { group = false } = {}) {
  if (bell === 'needs_you') return WHY_SAID[item.why] || 'question';
  if (bell === 'ready') return group ? 'ready_group' : 'ready';
  if (bell === 'stopped') return REASON_SAID[item.reason] || 'build_other';
  return 'live';
}

// The request's name falls back to Homeroom's own copy of it when the
// requester row has none (requests, then issues), never to the project alone.
const BELL_FACTS_SQL = `
  SELECT rq.first_version,
         COALESCE(NULLIF(rq.issue_title, ''),
                  (SELECT NULLIF(r.title, '') FROM requests r WHERE r.app_id = rq.app_id AND r.number = rq.issue_number),
                  (SELECT NULLIF(i.title, '') FROM issues i
                    WHERE i.app_id = rq.app_id AND i.github_issue_number = rq.issue_number
                    ORDER BY i.id DESC LIMIT 1)) AS issue_title,
         a.slug, a.name,
         (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members,
         bot.id AS bot_id,
         lr.read_reason, lr.builder
    FROM homeroom_bot_requesters rq
    LEFT JOIN LATERAL (
      SELECT r.read_reason, r.builder FROM homeroom_bot_runs r
       WHERE r.app_id = rq.app_id AND r.issue_number = rq.issue_number AND r.mode = 'live'
       ORDER BY r.id DESC LIMIT 1
    ) lr ON TRUE
    JOIN apps a ON a.id = rq.app_id
    LEFT JOIN users bot ON bot.username = 'homeroom_bot' AND bot.is_synthetic = TRUE
   WHERE rq.app_id = $1 AND rq.issue_number = $2 AND rq.user_id = $3`;

/**
 * Ring each changed row's requester at its moment (bellOf), in `db`'s
 * transaction, and resolve the pushes that tell their open tabs their bell
 * moved. Rows with no moment, of no requester, of a change or a first
 * version ring nothing.
 */
/**
 * Pure (16 Oct 2026, kept): a moment that asks nothing new of its requester
 * rings nobody, though its stage still shows where it waits. An older
 * request's first read (`read_reason` 'backlog') rings only when its change
 * is ready, and a hand-off that names who builds it (`builder`) asks the
 * requester nothing.
 */
function quietBell(bell, facts) {
  if (bell !== 'needs_you') return false;
  return facts?.read_reason === 'backlog' || !!(facts?.builder && String(facts.builder).trim());
}

async function bellPushes(db, changed) {
  const pushes = [];
  for (const row of changed || []) {
    const userId = Number(row.state?.requesterId) || 0;
    if (!row.bell || row.kind !== 'request' || !userId || !BELL_KINDS[row.bell]) continue;
    const { rows: [f] } = await db.query(BELL_FACTS_SQL, [row.appId, row.issueNumber, userId]);
    if (!f || f.first_version === true || !f.bot_id) continue;
    if (quietBell(row.bell, f)) continue;
    const said = bellSaid(row.bell, row.state, { group: Number(f.members) > 1 });
    const reason = row.state.line?.code === 'reason' ? row.state.line.text : null;
    const detail = require('./homeroom-bot-notify-copy').botNotificationDetail({
      moment: row.bell, said, appName: f.name || f.slug, appSlug: f.slug, issueNumber: row.issueNumber,
      requestTitle: f.issue_title || null, ...(reason ? { reason } : {}),
    });
    // Its push goes out from the row (notifications_enqueue_mobile_push_
    // deliveries); "ready to try" also owes the email that stands in for the
    // push when no phone can take it (activity-mail.js noticeMailTargets).
    // No chat is its home (notifications.js STAGE_BELL_SQL): its change, by
    // which a merge settles it (change-notifications.ts settleDecidedChange).
    const { rows: rang } = await db.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, detail, app_id, session_id, mailed_at)
       SELECT $1, $2, $3::text, $4, $5, $6, CASE WHEN $3::text = 'build_ready' THEN NULL ELSE NOW() END
        WHERE NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_user_id = $2)
       RETURNING id`,
      [userId, f.bot_id, BELL_KINDS[row.bell], detail, row.appId, Number(row.sessionId) || null],
    );
    if (rang.length) pushes.push({ kind: 'user', routing: { userId }, data: { type: 'notifications_changed' } });
  }
  return pushes;
}

/**
 * #6441: "Ready to try" outlives the change being ready. When a request's
 * stage leaves for building (an update or a fix under way), the
 * "ready to try" it rang is no longer true, so its unread row is withdrawn:
 * marked read and mailed, never deleted (the row stays in All, and no email
 * goes out for it). The move back to up_for_vote rings a fresh one through
 * bellOf. A stage move that does not rebuild (up_for_vote to checking) is
 * not a withdraw. A request row only: a change with no request is not rung
 * by its stage.
 */
async function withdrawReady(db, changed) {
  const pushes = [];
  const told = new Set();
  for (const row of changed || []) {
    if (row.kind !== 'request') continue;
    const sessionId = Number(row.sessionId) || 0;
    // Only an update or a fix under way rebuilds it: one that is only queued
    // takes nothing back yet (11 Nov 2026: building, update_queued).
    if (!sessionId || row.state?.stage !== 'building' || queuedUpdate(row.state)) continue;
    if (!row.prev || (row.prev.stage === 'building' && !queuedUpdate(row.prev))) continue;
    const { rows } = await db.query(
      `UPDATE notifications
          SET read_at = NOW(), mailed_at = COALESCE(mailed_at, NOW())
        WHERE session_id = $1 AND kind = 'build_ready' AND read_at IS NULL
        RETURNING user_id`,
      [sessionId],
    );
    for (const r of rows) {
      const userId = Number(r.user_id) || 0;
      if (!userId || told.has(userId)) continue;
      told.add(userId);
      pushes.push({ kind: 'user', routing: { userId }, data: { type: 'notifications_changed' } });
    }
  }
  return pushes;
}

/**
 * Step 3 (11 Nov 2026): the buttons of Homeroom bot's cards about rows that
 * moved, which their new standings no longer keep (bot-cards.js
 * retireOnMove, the one table), retired; and each item whose cards went
 * derived again at once, so its standing no longer lists them among its
 * open cards (a retire marks nothing: migration
 * work-state-backfill-and-indexes). Resolves the pushes of the messages
 * they were under and of the rows derived again. Inside a transition this
 * is its transaction's; the drain runs it after its own commits
 * (drainDirty).
 */
async function settleCards(db, changed, depth = 0) {
  const cards = require('./bot-cards');
  const pushes = [];
  const again = [];
  for (const row of changed || []) {
    // Buttons are judged on a move only (bot-cards.js moved).
    if (!cards.moved(row.prev, row.state)) continue;
    const item = row.kind === 'request' ? { appId: row.appId, issueNumber: row.issueNumber } : { sessionId: row.sessionId };
    const out = await cards.inTransaction(db, (tx) => cards.retireOnMove(tx, { ...item, standing: row.state, prev: row.prev }));
    pushes.push(...out.pushes);
    if (out.retired) again.push(item);
  }
  if (again.length) {
    // Its open cards changed and nothing else did, unless a write landed
    // meanwhile: a move found here rings and retires like any other, once
    // more at most.
    const moved = await refresh(db, again);
    pushes.push(...await pushesOf(db, moved, { cards: false }));
    if (depth < 1) pushes.push(...await settleCards(db, moved, depth + 1));
  }
  return pushes;
}

/**
 * The pushes changed rows are carried by: their work_state, the bell of each
 * that rang, each ready one withdrawn, and the cards their move retired
 * (settleCards; `cards: false` leaves those to the caller).
 */
async function pushesOf(db, changed, { cards = true } = {}) {
  const pushes = [...changed.map(pushOf), ...(await bellPushes(db, changed)), ...(await withdrawReady(db, changed))];
  return cards ? [...pushes, ...(await settleCards(db, changed))] : pushes;
}

/**
 * The workflow's afterAccepted hook (kernel/pipeline.ts): refresh what an
 * accepted event's instance is about, in its own transaction, and resolve
 * the pushes of what changed, each moment's bell rung with it (bellPushes).
 */
async function afterTransition(db, info) {
  const items = await itemsOf(db, info);
  if (!items.length) return [];
  return pushesOf(db, await refresh(db, items));
}

// ── Reading the store ────────────────────────────────────────────────────

/** A person's own items (their requests' rows and their changes'), newest first. */
async function forRequester(db, userId, { limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.requester_id = $1
      ORDER BY ws.updated_at DESC
      LIMIT $2`,
    [Number(userId), Math.max(1, Math.min(Number(limit) || 200, 500))],
  );
  return rows.map(fromRow);
}

/** The stored rows of named requests on one app, by number. */
async function forRequests(db, appId, numbers) {
  const list = [...new Set((numbers || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return new Map();
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.app_id = $1 AND ws.item_kind = 'request' AND ws.item_ref = ANY($2::int[])`,
    [Number(appId), list],
  );
  return new Map(rows.map((r) => [Number(r.item_ref), fromRow(r)]));
}

/**
 * The stored rows of named requests ({ appId, issueNumber }) on any project,
 * made first for any that has none yet, in the order named.
 */
async function forItems(db, items) {
  const list = (items || []).filter((it) => Number(it.appId) > 0 && Number(it.issueNumber) > 0);
  if (!list.length) return [];
  await ensure(db, list);
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.item_kind = 'request'
        AND (ws.app_id, ws.item_ref) IN (SELECT * FROM unnest($1::int[], $2::int[]))`,
    [list.map((it) => Number(it.appId)), list.map((it) => Number(it.issueNumber))],
  );
  const byKey = new Map(rows.map((r) => [`${r.app_id}:${r.item_ref}`, fromRow(r)]));
  return list.map((it) => byKey.get(`${Number(it.appId)}:${Number(it.issueNumber)}`)).filter(Boolean);
}

/** The stored rows of named changes, by session id, made first for any that has none yet. */
async function forChanges(db, sessionIds, { ensure: make = true } = {}) {
  const list = [...new Set((sessionIds || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return new Map();
  if (make) await ensureChanges(db, list);
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.item_kind = 'change' AND ws.item_ref = ANY($1::int[])`,
    [list],
  );
  return new Map(rows.map((r) => [Number(r.item_ref), fromRow(r)]));
}

/** Pure: a stored row as the readers take it (shapeOf). */
function fromRow(r) {
  return shapeOf({
    appId: r.app_id,
    app: r.slug ? { slug: r.slug, name: r.app_name || r.slug } : null,
    kind: r.item_kind,
    ref: r.item_ref,
    issueNumber: r.issue_number,
    sessionId: r.session_id,
    stage: r.stage,
    why: r.why,
    reason: r.reason,
    line: r.line,
    whoseMove: r.whose_move,
    requesterId: r.requester_id,
    since: r.since,
    updatedAt: r.updated_at,
    voteOpen: r.vote_open === true,
    leadChangeId: r.lead_change_id,
    standing: r.standing,
  });
}

/**
 * Pure (11 Nov 2026): a row as anybody but its requester may read it. What
 * is asked of its requester is said as whether it is, never with what is
 * theirs alone: no message of their chat with Homeroom bot (its open
 * question), no private thread of theirs (a plan they are drafting), none of
 * its cards (one in their chat is theirs; `openOffers` counts them), and
 * nobody's id. The scoped push carries this shape to every viewer of the
 * project (pushOf); a reader hands the whole row to its requester only
 * (forViewer).
 */
function publicOf(row) {
  if (!row) return null;
  const asks = row.asks && typeof row.asks === 'object' ? row.asks : NO_ASKS;
  const offers = Array.isArray(asks.offers) ? asks.offers : [];
  return {
    ...row,
    requesterId: null,
    asks: {
      question: asks.question ? { messageId: null, at: asks.question.at || null } : null,
      plan: asks.plan || null,
      closeVote: asks.closeVote || null,
      draft: asks.draft ? { threadId: null } : null,
      offers: [],
      openOffers: offers.length,
      reports: Number(asks.reports) || 0,
    },
  };
}

/**
 * Pure: a row as one viewer reads it, with the per-viewer facts the store
 * never holds: `mine` (they asked for it, or decide on its project) and
 * `voteOwed` (its change is open for votes, and they still owe a vote).
 * Anybody but its requester (`viewerId`) reads it as publicOf says.
 */
function forViewer(row, { mine = false, voteOwed = false, viewerId = null } = {}) {
  if (!row) return null;
  const theirs = viewerId != null && row.requesterId != null && Number(row.requesterId) === Number(viewerId);
  return { ...(theirs ? row : publicOf(row)), mine: !!mine, voteOwed: !!voteOwed };
}

// ── The sweep ────────────────────────────────────────────────────────────

// Some stages move on by time alone: a build that never started stalls
// (progress.START_GRACE_MS), a reply's "about to read" lapses
// (progress.REPLY_WAIT_MS), a hold until Monday ends, a week-old live item
// leaves the lists. And a fact written where no machine or route refreshes
// its item is caught here. The sweep refreshes the rows still moving, the
// longest unchecked first, and seeds a row for each request the bot knows
// that has none yet (its first run after the table exists).
async function sweep(db, { olderThanMs = 2 * 60 * 1000, limit = 100, seed = 100 } = {}) {
  // A request nobody has started on (reading, waiting to be read) is left
  // out: it moves only when one of its records is written, which marks it
  // (work_state_dirty), and a list makes one of those for every request it
  // shows. The same test as work_states_sweep_moving_idx's, word for word.
  const { rows } = await db.query(
    `SELECT app_id, item_kind, item_ref FROM work_states
      WHERE stage <> 'closed'
        AND NOT (item_kind = 'request' AND stage = 'reading' AND COALESCE(line->>'code', '') = 'waiting')
        AND checked_at < NOW() - make_interval(secs => $1)
        AND NOT (stage = 'live' AND since < NOW() - make_interval(days => $3))
      ORDER BY checked_at ASC LIMIT $2`,
    [Math.round(olderThanMs / 1000), limit, LIVE_DAYS + 1],
  );
  const { rows: missing } = seed > 0 ? await db.query(
    `SELECT k.app_id, k.issue_number FROM (
       SELECT app_id, issue_number, MAX(at) AS at FROM (
         SELECT app_id, issue_number, created_at AS at FROM homeroom_bot_requesters
         UNION ALL SELECT app_id, issue_number, created_at FROM homeroom_bot_runs WHERE mode = 'live'
         UNION ALL SELECT app_id, issue_number, enqueued_at FROM homeroom_bot_queue
       ) x GROUP BY app_id, issue_number
     ) k
     WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                        WHERE ws.app_id = k.app_id AND ws.item_kind = 'request' AND ws.item_ref = k.issue_number)
       AND EXISTS (SELECT 1 FROM apps a WHERE a.id = k.app_id)
     ORDER BY k.at DESC LIMIT $1`,
    [seed],
  ) : { rows: [] };
  // 11 Nov 2026: and a row for each change up for a vote or going live that
  // has none yet (a change built for a request had none before), so Needs
  // you finds every change open for votes.
  const { rows: missingChanges } = seed > 0 ? await db.query(
    `SELECT cs.id FROM chat_sessions cs
      WHERE cs.status IN ('promoted', 'merging') AND cs.is_headless = FALSE
        AND NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.item_ref = cs.id)
      ORDER BY cs.id DESC LIMIT $1`,
    [seed],
  ) : { rows: [] };
  const items = [
    ...rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) })),
    ...missing.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })),
    ...missingChanges.map((r) => ({ sessionId: Number(r.id) })),
  ];
  if (!items.length) return { checked: 0, seeded: 0, changed: [], pushes: [] };
  const changed = await refresh(db, items, { touch: true });
  return { checked: rows.length, seeded: missing.length + missingChanges.length, changed, pushes: await pushesOf(db, changed) };
}

/**
 * Derive again what the triggers marked (work_state_dirty: a write to what
 * a work state is derived from, wherever it was made), at most `limit` at a
 * time, and resolve the changed rows. The marks are taken and the items
 * refreshed in one transaction, so a mark made meanwhile waits for it and
 * stays for the next run; a failure leaves them marked. The cards their
 * moves retire go after that commit (settleCards). `db` is a pool.
 */
async function drainDirty(pool, { limit = 200 } = {}) {
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM work_state_dirty
        WHERE id IN (SELECT id FROM work_state_dirty ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING app_id, issue_number, session_id`,
      [limit],
    );
    const changed = rows.length ? await refresh(client, rows.map((r) => (r.session_id != null
      ? { sessionId: Number(r.session_id) }
      : { appId: Number(r.app_id), issueNumber: Number(r.issue_number) }))) : [];
    // Each moment's bell is rung with the stage, in this transaction.
    const pushes = await pushesOf(client, changed, { cards: false });
    await client.query('COMMIT');
    out = { taken: rows.length, changed, pushes };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // The cards their moves retired, once the taken marks are let go: a tap
  // on one of them holds its card and then marks its request, so a drain
  // still holding the marks and reaching for the card would wait on the
  // tap while the tap waits on it. A failure here leaves the rows stored.
  if (out.changed.length) {
    try {
      out.pushes.push(...await settleCards(pool, out.changed));
    } catch (err) {
      require('./logger').warn('work-state', 'Retiring the cards of moved rows failed', { message: err.message });
    }
  }
  return out;
}

/**
 * The rows of requests that have none yet, made now (a reader listing
 * requests from before the table, or one the sweep has not reached).
 * Resolves nothing; read the rows after.
 */
async function ensure(db, items) {
  const list = (items || []).filter((it) => Number(it.appId) > 0 && Number(it.issueNumber) > 0);
  if (!list.length) return;
  const { rows } = await db.query(
    `SELECT x.app_id, x.issue_number FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
      WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                         WHERE ws.app_id = x.app_id AND ws.item_kind = 'request' AND ws.item_ref = x.issue_number)`,
    [list.map((it) => Number(it.appId)), list.map((it) => Number(it.issueNumber))],
  );
  if (rows.length) await refresh(db, rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })));
}

/** The rows of changes that have none yet, made now (ensure, for changes). Resolves nothing. */
async function ensureChanges(db, sessionIds) {
  const list = [...new Set((sessionIds || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return;
  const { rows } = await db.query(
    `SELECT x.id FROM unnest($1::int[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM work_states ws WHERE ws.item_kind = 'change' AND ws.item_ref = x.id)`,
    [list],
  );
  if (rows.length) await refresh(db, rows.map((r) => ({ sessionId: Number(r.id) })));
}

module.exports = {
  STAGES,
  WHYS,
  REASONS,
  LIFTED_LIMITS,
  outdatedReason,
  LIVE_DAYS,
  phrasesOf,
  english,
  APPROVED_SQL,
  votesIn,
  stageSays,
  lineSays,
  says,
  busyNow,
  botWorkOf,
  forItems,
  fromStage,
  derive,
  deriveChange,
  withUpdate,
  voteOpenOf,
  shotsHeld,
  changeStandingOf,
  requestStandingOf,
  shapeOf,
  publicOf,
  forViewer,
  forChanges,
  ensureChanges,
  STANDING_SQL,
  STANDING_RUNS_SQL,
  DONE_BY_SQL,
  placeFor,
  bellOf,
  REQUEST_FACTS_SQL,
  CHANGE_FACTS_SQL,
  requestsOfSession,
  refresh,
  WATCHED,
  wants,
  itemsOf,
  pushOf,
  bellSaid,
  bellPushes,
  pushesOf,
  settleCards,
  quietBell,
  publish,
  touched,
  afterTransition,
  forRequester,
  forRequests,
  fromRow,
  sweep,
  drainDirty,
  ensure,
};
