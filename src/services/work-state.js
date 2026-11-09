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
const { syncWaits, syncStand } = require('./vote-ready');
const checksEstimate = require('./checks-estimate');

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

/** The stage word plus the two lines a checking change can carry (#6402). */
function checkingState(row, since, now) {
  // #6531: what a conflicting change waits on decides where it shows and
  // what it says. A yes-only conflict is up for a vote; one the lane is
  // resolving says "Syncing with main"; one only its author can move keeps
  // the old wording.
  const stand = syncStand(row);
  if (stand === 'vote') return state('up_for_vote', { since, line: { code: 'conflict_on_yes' } });
  if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
  if (stand === 'author') return state('checking', { since, line: { code: 'sync_wait' } });
  const line = checksLine(row, now);
  return state('checking', { since, ...(line ? { line } : {}) });
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
      return state('reading', { since, ...(s.reply ? { line: { code: 'reply' } } : {}) });
    case 'queued':
      return s.retry === 'plan'
        ? state('planning', { since, line: { code: 'retry_plan' } })
        : state('reading', { since, line: { code: 'queued', ...(row.queue_place ? { place: Number(row.queue_place) } : {}) } });
    case 'on_hold':
      // #6357: a day's pause after its look threw again and again is not
      // the week's building time (homeroom-bot-progress.js holdOf).
      return state('reading', { since, line: { code: s.hold === 'cooldown' ? 'cooldown' : 'on_hold' } });
    case 'held':
      return state('building', { since, line: { code: row.cap_suppressed === 'builds_per_app' ? 'held_builds' : 'held_waiting' } });
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
      return state('up_for_vote', { since, line: { code: 'update_queued' } });
    case 'checks':
      return checkingState(row, since, now);
    case 'checks_failed': {
      // #6531: a conflicting head the lane is catching up (or that only a yes
      // can move) is not yet its author's failing verdict.
      const stand = syncStand(row);
      if (stand === 'vote') return state('up_for_vote', { since, line: { code: 'conflict_on_yes' } });
      if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
      const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
    }
    case 'fix_stopped':
      return state('stopped', { since, reason: 'fix_stopped' });
    case 'vote':
      if (row.first_version === true) return state('going_live', { since, line: { code: 'first_version' } });
      // #6402: a passing change that has since stopped merging cleanly waits
      // to sync with main, rather than asking for a vote it would throw away.
      // #6531: unless it conflicts and only a yes can move it.
      {
        const stand = syncStand(row);
        if (stand === 'vote') return state('up_for_vote', { since, line: { code: 'conflict_on_yes' } });
        if (stand === 'syncing') return state('checking', { since, line: { code: 'syncing' } });
        if (stand === 'author') return state('checking', { since, line: { code: 'sync_wait' } });
      }
      {
        // #6546: approved, and GitHub is holding its merge.
        const hold = githubHold(row);
        if (hold) return state(hold.stage, { since, line: { code: hold.code } });
      }
      return state('up_for_vote', { since });
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
  // An update on its way holds the vote it would otherwise ask for (#6282).
  // #6545: a queued one holds only a vote; a change still checking (a fix
  // waiting its turn) stays Checking until the update starts.
  if (status === 'promoted' && row.update_coming && out && (out.stage === 'up_for_vote' || out.stage === 'checking')) {
    if (row.update_coming === 'running') {
      out = state('building', { since: out.since, line: { code: 'revising' } });
    } else if (out.stage === 'up_for_vote') {
      out = state('up_for_vote', { since: out.since, line: { code: 'update_queued' } });
    }
  }
  // A private thread of the requester's holds it for their plan: nothing
  // queued overtakes that until a change is up (1 Nov 2026).
  if (row.awaiting_plan === true && !status && (!out || out.stage === 'reading')) {
    return state('planning', { since: row.request_at || row.run_at, line: { code: 'planning_with_you' }, whoseMove: 'requester' });
  }
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
  if (out) return out;

  // A change somebody made for it, when Homeroom bot has none of its own:
  // that is where it stands, whatever an older look of the bot's said.
  if (!status && row.lc_status) {
    const change = deriveChange({
      status: row.lc_status, check_state: row.lc_check_state, checks_at: row.lc_checks_at,
      check_phase: row.lc_check_phase, merge_conflict_state: row.lc_merge_conflict_state,
      integration_merges_clean: row.lc_integration_merges_clean,
      integration_block_reasons: row.lc_integration_block_reasons,
      checks_estimate: row.checks_estimate,
      promoted_at: row.lc_promoted_at, merged_at: row.lc_merged_at, live_at: row.lc_live_at,
      last_activity_at: row.lc_last_activity_at, created_at: row.lc_created_at,
    }, { now });
    // Somebody is building it: who, as a claim says it.
    if (change.stage === 'building' && row.lc_by) {
      return state('building', { since: change.since, line: { code: 'claimed', by: row.lc_by }, whoseMove: 'builder' });
    }
    // #6282: an update on its way holds its vote too. #6545: a queued one
    // holds only a vote; a change still checking stays Checking.
    if (row.lc_update_coming && (change.stage === 'up_for_vote' || change.stage === 'checking')) {
      if (row.lc_update_coming === 'running') {
        return state('building', { since: change.since, line: { code: 'revising' } });
      }
      if (change.stage === 'up_for_vote') {
        return state('up_for_vote', { since: change.since, line: { code: 'update_queued' } });
      }
    }
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

/** Pure: where a change with no request of its own stands. */
function deriveChange(row, { now = new Date() } = {}) {
  const status = row.status || null;
  if (status === 'merged') {
    return row.live_at ? state('live', { since: row.live_at }) : state('going_live', { since: row.merged_at });
  }
  if (status === 'merging') return state('going_live', { since: row.promoted_at });
  if (status === 'closed' || status === 'archived') return state('closed', { since: row.last_activity_at || row.promoted_at });
  if (status === 'promoted') {
    // #6531: a conflicting change is where its conflict stand puts it, before
    // its stale verdict is read as final: only a yes can move it (vote), the
    // lane is catching it up (syncing), or it is its author's (author).
    const stand = syncStand(row);
    if (stand === 'vote') return state('up_for_vote', { since: row.checks_at || row.promoted_at, line: { code: 'conflict_on_yes' } });
    if (stand === 'syncing') return state('checking', { since: row.checks_at || row.promoted_at, line: { code: 'syncing' } });
    if (stand === 'author') {
      const failed = row.check_state === 'failing' || row.check_state === 'error';
      return state('checking', { since: row.checks_at || row.promoted_at, line: { code: failed ? 'checks_failing' : 'sync_wait' } });
    }
    if (row.check_state !== 'passing' && row.check_state !== 'skipped') {
      const failing = row.check_state === 'failing' || row.check_state === 'error';
      if (failing) return state('checking', { since: row.checks_at || row.promoted_at, line: { code: 'checks_failing' } });
      // #6402: deferred or conflicting heads wait to sync with main; a run in
      // flight says about how long it has left.
      return checkingState(row, row.checks_at || row.promoted_at, now);
    }
    // A passing change that has since stopped merging cleanly moves back to
    // Waiting to sync with main: its verdict no longer describes what lands.
    if (syncWaits(row)) return state('checking', { since: row.checks_at || row.promoted_at, line: { code: 'sync_wait' } });
    // #6546: approved, and GitHub is holding its merge.
    const hold = githubHold(row);
    if (hold) return state(hold.stage, { since: row.promoted_at, line: { code: hold.code } });
    return state('up_for_vote', { since: row.promoted_at });
  }
  void now;
  return state('building', { since: row.last_activity_at || row.created_at, whoseMove: 'builder' });
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
function bellOf(prev, next) {
  if (!next) return null;
  const same = prev && prev.stage === next.stage && (prev.why || null) === (next.why || null)
    && (prev.reason || null) === (next.reason || null);
  if (same) return null;
  if (next.stage === 'waiting_for_you') return 'needs_you';
  if (next.stage === 'up_for_vote') return prev && prev.stage === 'up_for_vote' ? null : 'ready';
  if (next.stage === 'stopped') return 'stopped';
  if (next.stage === 'live') return 'live';
  return null;
}

// ── Words ────────────────────────────────────────────────────────────────

// The English words of frontend/locales/en/core.json's work.* entries, for
// what the server words itself (Homeroom bot's answers, the bell). Keyed by
// those entries' keys; tests/work-state.test.js holds the two together.
const WORDS = Object.freeze({
  'work.stage.reading': 'Reading it',
  'work.stage.notStarted': 'Not started yet',
  'work.stage.readyToBuild': 'Ready to build',
  'work.stage.planning': 'Planning',
  'work.stage.waitingForYou': 'Waiting for you',
  'work.stage.building': 'Building',
  'work.stage.checking': 'Checking',
  'work.stage.syncing': 'Syncing with main',
  'work.stage.upForVote': 'Up for a vote',
  'work.stage.goingLive': 'Going live',
  'work.stage.live': 'Live',
  'work.stage.stopped': 'Stopped',
  'work.stage.closed': 'Closed',
  'work.why.question': 'Waiting for your answer',
  'work.why.plan': 'Waiting for you to OK the plan',
  'work.why.decide': 'Waiting for you to decide',
  'work.why.alreadyWorks': 'It may already work: close it?',
  'work.why.needsDetail': 'Waiting for more detail from you',
  'work.whyOthers.question': 'Waiting for an answer',
  'work.whyOthers.plan': "Waiting for the plan to be OK'd",
  'work.whyOthers.decide': 'Waiting for a decision',
  'work.whyOthers.alreadyWorks': 'It may already work',
  'work.whyOthers.needsDetail': 'Waiting for more detail',
  'work.reason.buildFailed': "Stopped: the build didn't finish",
  'work.reason.fixStopped': 'Stopped: its tests still fail',
  'work.reason.lookFailed': "Stopped: it couldn't be read",
  'work.reason.changeClosed': 'Stopped: its change was closed',
  'work.reason.stalled': "Stopped: the build didn't start",
  'work.line.queued': 'Waiting its turn',
  'work.line.firstVersionWait': 'Waiting for the first version to go live',
  'work.line.queuedAt': 'Number {{place}} in line',
  'work.line.heldBuilds': "Waiting for one of the project's builds to finish",
  'work.line.heldWaiting': 'Waiting for changes up for a vote to be decided',
  'work.line.onHold': "On hold until Monday: this week's building time is used up",
  'work.line.cooldown': 'Paused after repeated errors: Homeroom bot tries again later',
  'work.line.reply': 'Reading your reply',
  'work.line.retryPlan': 'Trying the plan again',
  'work.line.reviewing': 'Reviewing, round {{round}} of {{of}}',
  'work.line.starting': 'Starting',
  'work.line.proposing': 'Putting it up for a vote',
  'work.line.fixing': 'Fixing what its tests found',
  'work.line.revising': 'Updating the change',
  'work.line.updateQueued': 'An update is on its way',
  'work.line.checksFailing': 'Tests are failing',
  'work.line.checksFailingCount_one': '{{count}} test failing',
  'work.line.checksFailingCount_other': '{{count}} tests failing',
  'work.line.checksRunning_one': 'About {{count}} min left',
  'work.line.checksRunning_other': 'About {{count}} min left',
  'work.line.syncWait': 'Waiting to sync with main',
  'work.line.conflictOnYes': 'Conflicts with main: Homeroom resolves it once you approve',
  'work.line.githubChecks': "Waiting for GitHub's checks",
  'work.line.githubChecksFailing': "GitHub's checks are failing",
  'work.line.githubWait': 'Waiting on GitHub',
  'work.line.firstVersion': 'First version: it goes live without a vote',
  'work.line.claimed': '{{username}} is building it',
  'work.line.planningWithYou': 'Planning it with you in a private thread',
  'work.line.waiting': 'Waiting to be read',
  'work.line.said': 'Homeroom bot: {{reason}}',
});

// A request in the reading stage nobody has started on yet, and one ready to
// build that waits its turn, are said so (the same stages, in plainer words).
const NOT_STARTED = new Set(['queued', 'waiting', 'on_hold', 'cooldown', 'first_version_wait']);
const READY = new Set(['queued', 'held_builds', 'held_waiting']);

const camel = (s) => String(s).replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const fill = (key, values = {}) => WORDS[key].replace(/\{\{(\w+)\}\}/g, (_m, k) => String(values[k] ?? ''));

/** Pure: the stage's words in English, as the screens say them (lib/work-state.ts stageWords). */
function stageSays(item, { yours = true } = {}) {
  if (!item) return '';
  if (item.stage === 'waiting_for_you' && item.why && WORDS[`work.why.${camel(item.why)}`]) {
    return fill(`work.${yours ? 'why' : 'whyOthers'}.${camel(item.why)}`);
  }
  if (item.stage === 'stopped' && item.reason && WORDS[`work.reason.${camel(item.reason)}`]) return fill(`work.reason.${camel(item.reason)}`);
  const code = item.line && item.line.code;
  // #6531: a conflicting change the lane is catching up says so in the stage
  // word itself ("Syncing with main", not "Checking"), and carries no line.
  if (item.stage === 'checking' && code === 'syncing') return fill('work.stage.syncing');
  if (item.stage === 'reading' && NOT_STARTED.has(code)) return fill('work.stage.notStarted');
  if (item.stage === 'building' && READY.has(code)) return fill('work.stage.readyToBuild');
  return fill(`work.stage.${camel(item.stage)}`) || '';
}

/** Pure: the second line in English (lib/work-state.ts lineWords), or null. */
function lineSays(item) {
  const line = item && item.line;
  if (!line || !line.code) return null;
  switch (line.code) {
    case 'queued': return line.place ? fill('work.line.queuedAt', { place: line.place }) : fill('work.line.queued');
    case 'reviewing': return fill('work.line.reviewing', { round: line.round || 1, of: line.of || 1 });
    case 'checks_failing':
      return line.failing
        ? fill(line.failing === 1 ? 'work.line.checksFailingCount_one' : 'work.line.checksFailingCount_other', { count: line.failing })
        : fill('work.line.checksFailing');
    case 'checks_running':
      return line.minutes
        ? fill(line.minutes === 1 ? 'work.line.checksRunning_one' : 'work.line.checksRunning_other', { count: line.minutes })
        : null;
    case 'claimed': return line.by ? fill('work.line.claimed', { username: line.by }) : null;
    case 'reason': return line.text ? fill('work.line.said', { reason: line.text }) : null;
    default: return WORDS[`work.line.${camel(line.code)}`] ? fill(`work.line.${camel(line.code)}`) : null;
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
         lc.username AS lc_by,
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
         ) END AS queue_place
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
             CASE WHEN c.status = 'promoted' THEN ${progress.updateComingSql('c')} END AS update_coming
        FROM chat_sessions c
       WHERE c.app_id = it.app_id AND it.issue_number = ANY(c.linked_issues)
         AND c.is_headless = FALSE
         AND NOT ${planRecordSql('c')}
         AND c.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       ORDER BY CASE c.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END, c.id DESC
       LIMIT 1
    ) lc ON TRUE`;

/** One row per change named by $1 (session ids) that has no request of its own. */
const CHANGE_FACTS_SQL = `
  SELECT cs.id, cs.app_id, (SELECT a.slug FROM apps a WHERE a.id = cs.app_id) AS app_slug, cs.user_id, cs.status, cs.check_state, cs.checks_checked_at AS checks_at,
         cs.check_phase, cs.merge_conflict_state, cs.integration_merges_clean, cs.integration_block_reasons,
         cs.promoted_at, cs.merged_at, cs.live_at, cs.created_at, cs.last_activity_at
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[])`;

/**
 * The requests a session is about: the requests whose bot run built or
 * proposed it, then the ones it says it closes. Empty for a change with no
 * request, which is its own item.
 */
async function requestsOfSession(db, sessionId) {
  const { rows } = await db.query(
    `SELECT DISTINCT r.app_id, r.issue_number FROM homeroom_bot_runs r
      WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
     UNION
     SELECT cs.app_id, n AS issue_number FROM chat_sessions cs, unnest(cs.linked_issues) AS n
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
}

// ── Storing ──────────────────────────────────────────────────────────────

const sameLine = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

async function upsert(db, key, next, { touch = false } = {}) {
  const { rows: [prev] } = await db.query(
    `SELECT stage, why, reason, line, whose_move, requester_id, since FROM work_states
      WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3`,
    [key.appId, key.kind, key.ref],
  );
  if (prev && prev.stage === next.stage && (prev.why || null) === next.why && (prev.reason || null) === next.reason
    && sameLine(prev.line, next.line) && (prev.whose_move || null) === next.whoseMove
    && (prev.requester_id == null ? null : Number(prev.requester_id)) === (next.requesterId ?? null)) {
    // Unchanged. The sweep still marks it checked, so it moves on to others.
    if (touch) {
      await db.query('UPDATE work_states SET checked_at = NOW() WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3',
        [key.appId, key.kind, key.ref]);
    }
    return null;
  }
  await db.query(
    `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, session_id, stage, why, reason, line,
                              whose_move, requester_id, since, updated_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, NOW(), NOW())
     ON CONFLICT (app_id, item_kind, item_ref) DO UPDATE
       SET issue_number = EXCLUDED.issue_number, session_id = EXCLUDED.session_id, stage = EXCLUDED.stage,
           why = EXCLUDED.why, reason = EXCLUDED.reason, line = EXCLUDED.line, whose_move = EXCLUDED.whose_move,
           requester_id = EXCLUDED.requester_id, since = EXCLUDED.since, updated_at = NOW(), checked_at = NOW()`,
    [key.appId, key.kind, key.ref, key.issueNumber ?? null, key.sessionId ?? null, next.stage, next.why, next.reason,
      next.line ? JSON.stringify(next.line) : null, next.whoseMove, next.requesterId ?? null, next.since],
  );
  return { prev: prev ? { stage: prev.stage, why: prev.why || null, reason: prev.reason || null } : null };
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

/**
 * Derive the items again and store each that changed. `items` are
 * { appId, issueNumber } (a request) or { sessionId } (a change, which
 * resolves to its requests when it has any). Resolves the changed rows:
 * { appId, kind, ref, issueNumber, sessionId, state, prev, bell }.
 */
async function refresh(db, items, { now = new Date(), touch = false } = {}) {
  const requests = new Map();
  const changes = new Set();
  for (const it of items || []) {
    if (it && Number(it.appId) > 0 && Number(it.issueNumber) > 0) {
      requests.set(`${Number(it.appId)}:${Number(it.issueNumber)}`, { appId: Number(it.appId), issueNumber: Number(it.issueNumber) });
    } else if (it && Number(it.sessionId) > 0) {
      const of = await requestsOfSession(db, Number(it.sessionId));
      if (of.length) for (const r of of) requests.set(`${r.appId}:${r.issueNumber}`, r);
      else changes.add(Number(it.sessionId));
    }
  }
  const changed = [];
  // Stored in one order everywhere (by project and number, then by change),
  // so two refreshes of the same rows never wait on each other in a circle.
  if (requests.size) {
    const list = [...requests.values()];
    const { rows } = await db.query(REQUEST_FACTS_SQL, [list.map((r) => r.appId), list.map((r) => r.issueNumber)]);
    rows.sort((a, b) => Number(a.app_id) - Number(b.app_id) || Number(a.issue_number) - Number(b.issue_number));
    await attachChecksEstimate(db, rows, (r) => (r.proposal_status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state))
      || (r.lc_status === 'promoted' && IN_FLIGHT_CHECKS(r.lc_check_state)));
    // Which of them wait for their project's first version, by the bot's
    // own rule (as its read lane and a project chat's card read it).
    const bot = require('./homeroom-bot');
    const holds = await bot.firstVersionHolds(db, [...new Set(rows.map((r) => Number(r.app_id)))]).catch(() => new Map());
    for (const row of rows) {
      row.held_first_version = bot.heldForFirstVersion(holds, {
        appId: row.app_id, issueNumber: row.issue_number, firstVersion: row.first_version === true, reason: row.queue_reason || null,
      });
    }
    for (const row of rows) {
      const next = { ...derive(row, { now }), requesterId: row.requester_id == null ? null : Number(row.requester_id) };
      const sessionId = Number(row.proposal_session_id || row.build_session_id || row.lc_id) || null;
      const key = { appId: Number(row.app_id), kind: 'request', ref: Number(row.issue_number), issueNumber: Number(row.issue_number), sessionId };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, appSlug: row.app_slug || null, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
    }
  }
  if (changes.size) {
    const { rows } = await db.query(CHANGE_FACTS_SQL, [[...changes]]);
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    await attachChecksEstimate(db, rows, (r) => r.status === 'promoted' && IN_FLIGHT_CHECKS(r.check_state));
    for (const row of rows) {
      const next = { ...deriveChange(row, { now }), requesterId: row.user_id == null ? null : Number(row.user_id) };
      const key = { appId: Number(row.app_id), kind: 'change', ref: Number(row.id), issueNumber: null, sessionId: Number(row.id) };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, appSlug: row.app_slug || null, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
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

/** The push a changed row is carried by, to everyone who may view its app. */
function pushOf(row) {
  return {
    kind: 'scoped',
    routing: { appId: row.appId, appSlug: row.appSlug || null },
    data: {
      type: 'work_state',
      appId: row.appId,
      appSlug: row.appSlug || null,
      item: { kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId },
      state: {
        stage: row.state.stage, why: row.state.why, reason: row.state.reason, line: row.state.line,
        whoseMove: row.state.whoseMove, since: row.state.since,
      },
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
 * stage leaves for building (an update asked for, or a fix), the
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
    if (!sessionId || row.state?.stage !== 'building') continue;
    if (!row.prev || row.prev.stage === 'building') continue;
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

/** The pushes changed rows are carried by: their work_state, the bell of each that rang, and each ready one withdrawn. */
async function pushesOf(db, changed) {
  return [...changed.map(pushOf), ...(await bellPushes(db, changed)), ...(await withdrawReady(db, changed))];
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

/** Pure: a stored row as the readers take it. */
function fromRow(r) {
  return {
    appId: Number(r.app_id),
    app: r.slug ? { slug: r.slug, name: r.app_name || r.slug } : null,
    kind: r.item_kind,
    ref: Number(r.item_ref),
    issueNumber: r.issue_number == null ? null : Number(r.issue_number),
    sessionId: r.session_id == null ? null : Number(r.session_id),
    stage: r.stage,
    why: r.why || null,
    reason: r.reason || null,
    line: r.line || null,
    whoseMove: r.whose_move || null,
    requesterId: r.requester_id == null ? null : Number(r.requester_id),
    since: iso(r.since),
    updatedAt: iso(r.updated_at),
  };
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
  const { rows } = await db.query(
    `SELECT app_id, item_kind, item_ref FROM work_states
      WHERE stage <> 'closed' AND checked_at < NOW() - make_interval(secs => $1)
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
  const items = [
    ...rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) })),
    ...missing.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })),
  ];
  if (!items.length) return { checked: 0, seeded: 0, changed: [], pushes: [] };
  const changed = await refresh(db, items, { touch: true });
  return { checked: rows.length, seeded: missing.length, changed, pushes: await pushesOf(db, changed) };
}

/**
 * Derive again what the triggers marked (work_state_dirty: a write to what
 * a work state is derived from, wherever it was made), at most `limit` at a
 * time, and resolve the changed rows. The marks are taken and the items
 * refreshed in one transaction, so a mark made meanwhile waits for it and
 * stays for the next run; a failure leaves them marked. `db` is a pool.
 */
async function drainDirty(pool, { limit = 200 } = {}) {
  const client = await pool.connect();
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
    const pushes = await pushesOf(client, changed);
    await client.query('COMMIT');
    return { taken: rows.length, changed, pushes };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

module.exports = {
  STAGES,
  WHYS,
  REASONS,
  LIFTED_LIMITS,
  outdatedReason,
  LIVE_DAYS,
  WORDS,
  stageSays,
  lineSays,
  says,
  fromStage,
  derive,
  deriveChange,
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
