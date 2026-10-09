// Automatic challenge scoring — the pure half.
//
// Everything here is a function over plain data: no pool, no I/O, no clock
// except the `now` each caller passes in. The DB-facing orchestration lives
// in ./challenge-scorer.js. Same split as ./scoring.js vs
// ./snapshot-builder.js, and for the same reason: the arithmetic that
// decides what somebody is paid should be testable without a database.
//
// ── What a rule is ─────────────────────────────────────────────────────
//
// A row in `challenge_scoring_rules`, created and edited by an admin on the
// programme console's Challenge scoring screen. It says three things:
//
//   measure   which of the MEASURES below to take
//   binding   the challenge template (every instance, this week's and next
//             week's) or one specific challenge, that the credits pay into
//   numbers   target and points, each optional — left blank they come from
//             the challenge's own `metric_target` and `reward`
//
// What an admin composes is the CONFIGURATION of a measure, never its body.
// That is the deliberate difference from the Laravel agents this replaces,
// where a run was an LLM session or a JSON step-DAG an admin had authored:
// those could not be reviewed, tested, or reasoned about before a season,
// and two runs of the same agent could pay differently. A measure here is
// ordinary code with ordinary tests, and the admin decides where it points.
//
// ── Windowed measures vs state measures ────────────────────────────────
//
// Eight measures score ACTIONS and count only what happened inside the
// challenge's own window. Without that rule, opening a season would
// retroactively pay everyone who had ever promoted a proposal, and the first
// tick would hand the onboarding points to people who never saw the
// challenge.
//
// Four score a STATE instead — "is your GitHub linked", "is block production
// on", "are you in a community", "have you made an app for one" — and
// deliberately do NOT filter by window. A state has no date to
// compare: somebody who linked their account last month still has it linked,
// and a persistent challenge that refused to see that would be telling them
// to do something they have already done.
//
// A vote and a report are actions, not states (#3569, #3568). The test that
// sorts a measure into one pile or the other is "are you still in it": you
// are still in a community you joined last month, but a vote cast last month
// is something you did then, exactly like an app you tried then — and
// counting all time would pay every existing voter the whole reward on the
// first pass after the rule is created, which is the retroactive payout this
// rule exists to prevent. So VOTE_CAST and FEEDBACK_SENT are windowed, the
// way TRY_APPS and PROPOSAL_SENT always were.
'use strict';

// ── Rewards ────────────────────────────────────────────────────────────
//
// Rewards are prose on the template ("500 pts", "Up to 2,000 pts"), so the
// scorer has to read them the same way the home panel does — this function
// IS the home panel's, moved here so there is one parser rather than two
// that drift. src/routes/home-panels.js imports and re-exports it.
//
// Deliberately conservative: anything that isn't confidently one number
// ("Up to 500 pts / issue", "½ of your final credits") returns null. A rule
// whose challenge reward will not parse is skipped with that as the reason,
// and the admin fixes it by typing the number into the rule's own Points
// field rather than by the scorer guessing.
function parseRewardPoints(reward) {
  if (reward == null) return null;
  const cleaned = String(reward)
    .trim()
    .replace(/^up\s+to\s+/i, '')
    .replace(/\s*(?:pts?|points?)\s*$/i, '')
    .replace(/,/g, '')
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── The floor for having tried an app ──────────────────────────────────
//
// A day's worth of app use is one row per (user, app, day), so the
// "did they actually open it" floor is in seconds.
//
// 10, down from 30 (#3570). "Try an app" is the first thing a newcomer is
// asked to do with an app, and half a minute was long enough that somebody
// who opened one, looked around and came back to Home found it still "Not
// started". Ten seconds is still more than an accidental tap; and since the
// heartbeat now scores the moment a person crosses it
// (./challenge-scorer.js scoreOnAppTime), the card ticks while they are
// still in the app. Lowering it pays nobody twice and takes nothing back: on
// the first pass after it ships, an app somebody spent 10–29 seconds in
// inside a live TRY_APPS window becomes a credit it was not before, which
// can complete an existing member's count and pay its reward then.
const TRY_APPS_MIN_SECONDS = 10;

// ── The measures ───────────────────────────────────────────────────────
//
// `payout` is the one thing that genuinely differs between counted measures,
// and each comes from a challenge's own scoring sentence:
//
//   on_target  "500 pts after the third app."       → 0, 0, then the lot
//   per_unit   "250 pts per account, 500 for both." → an equal share each
//   graded     "…up to 250 pts. 4 a week."          → a share each, but the
//                                                     grader sets how much
//   full       a single completion, the whole reward
//
// `targetUnit` is what the rule's Target field counts, and it is shown in
// the admin form beside the input — "10" means ten minutes for one measure
// and ten apps for another, and an operator should never have to guess.
//
// `phrase` is how the measure reads in a sentence, with {target} filled in.
// It exists so the admin form can say the rule back to whoever is writing it
// — "Credits 500 pts on Try 3 apps when someone opens 3 different apps" — and
// so that sentence comes from the same place as the behaviour rather than
// being retyped in the UI, where it could drift from what the scorer does.
//
// `needsTarget` is a separate question from having a unit, and conflating the
// two was a real bug: "Sent a proposal" is one proposal and done, so asking
// an operator to type a target it never reads made the rule report itself as
// misconfigured. A counted measure always needs one (it is the cap); beyond
// that, only a measure whose own query reads the number says so here.
//
// `phraseOne` is the phrase for a target of exactly one, where it has one.
// "Try an app" is TRY_APPS with a target of 1 (#3570), and "opens 1
// different apps" is not something a person would write.
//
// `screened` puts the measure's candidates through the deterministic junk
// filter (./challenge-grader.js preFilter) before anything is planned: too
// short to act on, or a copy of what the same person already sent. It is
// its own flag, not "graded", because FEEDBACK_SENT is screened and never
// sent to a model.
const MEASURES = {
  TRY_APPS: {
    label: 'Tried different apps',
    phrase: 'opens {target} different apps',
    phraseOne: 'opens an app they did not make',
    summary: `Opened this many different apps and spent at least ${TRY_APPS_MIN_SECONDS} seconds in each. Apps they made themselves do not count, except on a First challenge, which is paid once.`,
    unit: 'app',
    targetUnit: 'apps',
    counted: true,
    payout: 'on_target',
    windowed: true,
    graded: false,
  },
  USE_APPS_MINUTES: {
    label: 'Minutes spent using apps',
    phrase: 'spends {target} minutes using apps',
    summary: 'Spent this many minutes actively using apps inside the window. Apps they made themselves do not count.',
    unit: 'window',
    targetUnit: 'minutes',
    needsTarget: true,
    counted: false,
    payout: 'full',
    windowed: true,
    graded: false,
  },
  PROPOSAL_SENT: {
    label: 'Sent a proposal',
    phrase: 'sends a proposal',
    summary: 'Put a change to an app to the group vote inside the window. One is enough, so this needs no target.',
    unit: 'proposal',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: true,
    graded: false,
  },
  PROPOSAL_ACCEPTED: {
    label: 'Got a proposal accepted',
    phrase: 'gets a proposal accepted',
    summary: 'Had a proposal voted through and merged inside the window. Each one is graded on how useful the change is.',
    unit: 'proposal',
    targetUnit: 'accepted proposals',
    counted: true,
    payout: 'graded',
    windowed: true,
    graded: true,
  },
  USEFUL_FEEDBACK: {
    label: 'Sent useful feedback',
    phrase: 'sends a report worth acting on',
    summary: 'Filed a report through the feedback dialog inside the window, about the platform or somebody else\'s project. A report on a project they made, or one only they can see, does not count, except on a First challenge, which is paid once. Each one is graded on how easy it is to act on.',
    unit: 'report',
    targetUnit: 'reports',
    counted: true,
    payout: 'graded',
    windowed: true,
    graded: true,
    screened: true,
  },
  CONNECT_ACCOUNTS: {
    label: 'Connected accounts',
    phrase: 'connects {target} accounts',
    summary: 'Linked this many accounts they already own (X, GitHub). Counts accounts linked before the season too.',
    unit: 'account',
    targetUnit: 'accounts',
    counted: true,
    payout: 'per_unit',
    windowed: false,
    graded: false,
  },
  BLOCK_PRODUCTION_ON: {
    label: 'Turned on block production',
    phrase: 'turns on block production',
    summary: 'Block production is on, access has been asked for, or the account has already produced. Counts state from before the season too.',
    unit: 'state',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: false,
    graded: false,
  },
  // The three community measures (Season 2's "Find people to build with",
  // "Build for your community" and "Invite 3 people"). "In a community"
  // means what the Workshop labels Public or Private community — the
  // audience rule in services/communities.js — never "Just you", and never
  // the platform's own project, which every account is put in without
  // choosing it.
  COMMUNITY_JOINED: {
    label: 'Joined a community',
    phrase: 'joins a community',
    summary: 'Is in a public or private community: joined one, took an invite, or started one. The platform\'s own project and a project only they can see do not count. Counts memberships from before the season too.',
    unit: 'state',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: false,
    graded: false,
  },
  COMMUNITY_APP_CREATED: {
    label: 'Created an app for a community',
    phrase: 'creates an app for a community',
    summary: 'Made a project whose community is public or private, not "Just you". A private project counts once somebody else is in it or invited. Counts projects from before the season too.',
    unit: 'state',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: false,
    graded: false,
  },
  INVITES_JOINED: {
    label: 'People who joined by their invite',
    phrase: 'brings in {target} people by invite',
    summary: 'People who joined through their invite link, or accepted their invite by username or email, inside the window. Each person counts once, for the first invite they took, so a ring of accounts cannot pay each other.',
    unit: 'person',
    targetUnit: 'people',
    counted: true,
    payout: 'per_unit',
    windowed: true,
    graded: false,
  },
  // Two of the First challenges, as single completions the moment the thing
  // is done (#3569 "Vote on a change", #3568 "Suggest an improvement").
  // Both are actions, so both are windowed (see the top of this file).
  //
  // A vote on your OWN proposal or request does not count. Every measure
  // here that could pay for self-dealing leaves it out — apps you made are
  // not apps you tried, an invite you took yourself is not somebody you
  // brought in — and "Vote on a change" is about judging somebody else's
  // change: an author voting Yes on what they just put up has not done that.
  // It also keeps the demo partner (which votes on its own demo proposal)
  // out of the measure without a special case.
  //
  // Nor does a vote on what the Homeroom bot built from your own request, or
  // any vote in a project only you are in ("Just you"), and a report on a
  // project you made, or one only you are in, is not feedback to anybody
  // (first-session test, 2026-10-03). The bot is the author of the proposal
  // it writes for a request, so "not your own proposal" let the requester's
  // vote on their own app's first version through, and the in-app "Ask for
  // a change" on that app paid both feedback measures.
  //
  // THE ONE EXCEPTION (evan, #4602 and #4603, 9 Oct 2026): on the First
  // challenges, which are paid once in a life, time in an app you made
  // counts for "Try an app" and a report on your own project counts for
  // "Send feedback". A newcomer's first app is usually the one they just
  // made, and the list is there to show them how each thing works. Every
  // repeatable and weekly challenge keeps leaving your own projects out, so
  // they cannot be farmed (challenge-scorer.js RULE_CHALLENGES_SQL's
  // `first_challenge`). Join and Vote are unchanged.
  //
  // OR A LOOK AT THE WORKSHOP WHEN NOTHING WAS UP FOR A VOTE (evan,
  // 2026-10-01): a newcomer whose communities have nothing waiting cannot
  // vote, so the Getting started card's Vote step sends them to the Workshop
  // instead, and the server records that visit only when nothing was waiting
  // (services/onboarding.js markWorkshopVisit). It counts like a vote, the
  // same window and the same one credit, so the First challenge needs no
  // second rule; a visit while a vote was waiting is never recorded.
  VOTE_CAST: {
    label: 'Voted on a change, or looked at the Workshop when nothing was up for a vote',
    phrase: 'votes on somebody else\'s change, or looks at the Workshop when nothing is up for a vote',
    summary: 'Voted on a proposal or a request inside the window, or, when nothing was up for a vote in any community they are in, opened a Workshop from the Getting started card. Votes on their own proposals and requests do not count, nor do votes on what the Homeroom bot built from their own request or votes in a project only they can see, and neither does a look while a vote was waiting. One is enough, so this needs no target.',
    unit: 'vote',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: true,
    graded: false,
  },
  // The same reports USEFUL_FEEDBACK reads, through the same junk filter,
  // but one is enough and nothing is graded: the First challenge is about
  // sending feedback at all, and a model's opinion of a newcomer's first
  // report is not something they should wait on or be marked down by. The
  // weekly graded challenge stays on USEFUL_FEEDBACK.
  FEEDBACK_SENT: {
    label: 'Sent feedback',
    phrase: 'sends a report',
    summary: 'Sent a report through the feedback dialog inside the window, and it reached GitHub. A report too short to act on, a copy of one they already sent, or a report on a project they made or one only they can see does not count, except on a First challenge, which is paid once. One is enough, and it is not graded.',
    unit: 'report',
    targetUnit: null,
    counted: false,
    payout: 'full',
    windowed: true,
    graded: false,
    screened: true,
  },
};

const MEASURE_KEYS = Object.keys(MEASURES);

// Whether one heartbeat took somebody's time in an app across the floor:
// below it before the heartbeat, at or past it after. The heartbeat route
// asks this so that it runs a scoring pass on the crossing, once in a
// person's life per app, and never on the heartbeats either side of it.
function crossedTryAppsFloor({ before, after }) {
  const was = Number(before);
  const now = Number(after);
  return Number.isFinite(was) && Number.isFinite(now)
    && was < TRY_APPS_MIN_SECONDS && now >= TRY_APPS_MIN_SECONDS;
}

// Grace after a window closes. A weekly challenge ending Sunday 23:59 must
// still pay for something done at 23:55, and the tick that would have caught
// it runs minutes later. Not open-ended: a week later the window is gone.
const WINDOW_GRACE_MS = 24 * 60 * 60 * 1000;

// ── Window ─────────────────────────────────────────────────────────────
//
// COALESCE(challenge, template, event), the same precedence every other
// reader of these rows uses. A challenge with no dates anywhere inherits its
// event's, which is what makes a persistent challenge "open all season"
// without anybody typing a date twice.
function resolveWindow(row, { now = Date.now(), graceMs = WINDOW_GRACE_MS } = {}) {
  const pick = (...vals) => {
    for (const v of vals) {
      if (v == null || v === '') continue;
      const ms = v instanceof Date ? v.getTime() : Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  };
  const startMs = pick(row.schedule_start, row.t_schedule_start, row.event_starts_at);
  const endMs = pick(row.schedule_end, row.t_schedule_end, row.event_ends_at);
  const started = startMs == null || startMs <= now;
  const ended = endMs != null && endMs + graceMs < now;
  return { startMs, endMs, open: started && !ended };
}

// ── Weekly challenges ──────────────────────────────────────────────────
//
// A challenge in the WEEKLY category says "up to 2 count each week", and the
// cap is per week, not per challenge row. Season 2 runs each weekly challenge
// as ONE row for the whole season (22 Sep to 31 Dec), so a cap counted over
// the row meant "up to 2 this season", and the pre-season test week's credits
// blocked people for the rest of it. A week is Monday 00:00 to Sunday 23:59
// UTC, the same for everyone whatever their time zone.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isWeekly(row) {
  const category = (row && (row.category || row.t_category)) || '';
  return String(category).trim().toUpperCase() === 'WEEKLY';
}

// The Monday 00:00 UTC that starts the week `ms` falls in.
function weekStartMs(ms) {
  const d = new Date(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

// The weeks a run scores a weekly challenge over: this week, and last week
// too for WINDOW_GRACE_MS after it closed, so a Sunday-night action is still
// paid by the run that comes after midnight. Each is clipped to the
// challenge's own window; a week wholly outside it is left out.
function weeklyWindows(window, { now = Date.now(), graceMs = WINDOW_GRACE_MS } = {}) {
  const current = weekStartMs(now);
  const starts = now - current < graceMs ? [current - WEEK_MS, current] : [current];
  const out = [];
  for (const start of starts) {
    const end = start + WEEK_MS - 1;
    const from = window.startMs == null ? start : Math.max(start, window.startMs);
    const to = window.endMs == null ? end : Math.min(end, window.endMs);
    if (from <= to) out.push({ startMs: from, endMs: to, open: window.open, weekStartMs: start });
  }
  return out;
}

// The effective target and points for one rule over one challenge. The rule's
// own values win; blank falls back to what the card already says, so the
// numbers a participant reads are the numbers they are paid by.
function effectiveTarget(rule, row) {
  const fromRule = Number(rule && rule.target);
  if (Number.isFinite(fromRule) && fromRule > 0) return fromRule;
  const raw = row.metric_target != null ? row.metric_target : row.t_metric_target;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function effectivePoints(rule, row) {
  const fromRule = Number(rule && rule.points);
  if (Number.isFinite(fromRule) && fromRule > 0) return fromRule;
  return parseRewardPoints(row.reward != null ? row.reward : row.t_reward);
}

// The ledger's `activity_type`. Challenges have always been credited under
// their template's category (ONBOARDING / WEEKLY / PERSISTENT) — that is what
// the admin importer validates against and what the ZKPassport route writes,
// so the scorer must not invent a type of its own.
function activityTypeFor(row) {
  const category = row.category || row.t_category || '';
  return String(category).trim() || 'challenge';
}

// ── Eligibility ────────────────────────────────────────────────────────
//
// Why a rule is or is not scoreable right now, as a reason string rather than
// a boolean: every skip shows up in the run summary and on the admin screen,
// and "window has not started" and "reward is not a plain number of points"
// need completely different things from the operator. null means "score it".
function skipReason(rule, row, { now = Date.now() } = {}) {
  if (!rule || rule.enabled === false) return 'rule is switched off';
  const spec = MEASURES[rule.measure];
  if (!spec) return `unknown measure ${rule && rule.measure}`;
  if (row.enabled === false) return 'challenge is switched off';
  if (row.completed === true) return 'challenge is closed';
  const window = resolveWindow(row, { now });
  if (!window.open) {
    return window.startMs != null && window.startMs > now
      ? 'window has not started'
      : 'window has closed';
  }
  if (effectivePoints(rule, row) == null) {
    return 'no points: the reward is not a plain number, so set Points on the rule';
  }
  // A count of one is a real target: "Try an app" is TRY_APPS with a target
  // of 1 (#3570), and it used to be refused here as "no target" — the rule
  // would have reported itself misconfigured and paid nobody. What a counted
  // measure cannot do without is A target, blank or zero being the mistake.
  if (spec.counted && !(effectiveTarget(rule, row) >= 1)) {
    return 'no target: this measure counts, so set Target on the rule';
  }
  if (spec.needsTarget && !(effectiveTarget(rule, row) > 0)) {
    return 'no target: this measure reads the number, so set Target on the rule';
  }
  return null;
}

// ── Payout ─────────────────────────────────────────────────────────────
//
// What ONE credit is worth. `index` is how many credits this person already
// has on this challenge, counting the ones about to be written in the same
// run, so `on_target` can tell the third app from the first two.
//
// Rounded to whole points: a 1,000 pt challenge over 3 units would otherwise
// pay 333.33, and the ledger's NUMERIC(10,2) would carry a rounding tail into
// every total on the leaderboard. The remainder rides on the last unit, so
// the full reward is still paid out exactly.
function unitPoints({ payout, points, target, index }) {
  switch (payout) {
    case 'full':
      return points;
    case 'on_target':
      return index + 1 >= target ? points : 0;
    case 'per_unit': {
      const share = Math.floor(points / target);
      return index + 1 >= target ? points - share * (target - 1) : share;
    }
    case 'graded':
      // The grader decides; this is the ceiling it is given.
      return Math.floor(points / target);
    default:
      return 0;
  }
}

// ── Planning one rule ──────────────────────────────────────────────────
//
// Turns candidate units into the credits to write.
//
// `candidates` are in arrival order per person (oldest first) and each names
// itself with a `sourceKey`. `credited` says what the ledger already holds
// for this challenge: the keys already paid for, and how many credits each
// person has, in all and per week (`weeks`, keyed by weekStartMs). Both are
// what make the scorer safe to run every ten minutes — the plan for a person
// already fully credited is empty.
//
// On a WEEKLY challenge the cap is counted inside the candidate's own week,
// and a single-completion measure is not marked as THE completion: the
// database allows one completion per person per challenge, and a weekly
// challenge is completed again every week.
//
// A graded measure returns credits marked `needsGrade`, with `points` as the
// ceiling; the caller grades them and drops any the grader could not score.
// Grading happens after planning rather than inside it so that a run with no
// API key still writes every ungraded credit it planned.
function planCredits(rule, row, { candidates = [], credited = new Map(), now = Date.now() } = {}) {
  const spec = MEASURES[rule && rule.measure];
  if (!spec) return [];
  const points = effectivePoints(rule, row);
  if (points == null) return [];
  const target = spec.counted ? effectiveTarget(rule, row) : 1;
  if (spec.counted && !(target >= 1)) return [];

  const window = resolveWindow(row, { now });
  const weekly = isWeekly(row);
  const out = [];
  // How many credits each person will have once this run's own plan is
  // applied — without it, two candidates in the same run would both be
  // "the second account" and the challenge would overpay. On a weekly
  // challenge the tally is per person per week.
  const running = new Map();

  for (const c of candidates) {
    const userId = Number(c.userId);
    if (!Number.isFinite(userId)) continue;
    const state = credited.get(userId) || { keys: new Set(), count: 0, weeks: new Map() };
    if (state.keys.has(c.sourceKey)) continue;
    let slot = userId;
    let held = state.count;
    if (weekly) {
      const at = c.activityAt != null ? Date.parse(c.activityAt) : NaN;
      const week = weekStartMs(Number.isFinite(at) ? at : now);
      slot = `${userId}:${week}`;
      held = (state.weeks && state.weeks.get(week)) || 0;
    }
    const already = held + (running.get(slot) || 0);
    if (already >= target) continue;
    // A windowed measure's SQL already filters by window; this is the belt to
    // that braces, and the only guard for a candidate list handed in by a
    // test or a future caller.
    if (spec.windowed && window.startMs != null && c.activityAt != null
      && Date.parse(c.activityAt) < window.startMs) continue;

    out.push({
      userId,
      sourceKey: c.sourceKey,
      points: unitPoints({ payout: spec.payout, points, target, index: already }),
      activityAt: c.activityAt,
      description: c.description || null,
      completion: !spec.counted && !weekly,
      needsGrade: spec.graded === true,
      gradeInput: c.gradeInput || null,
    });
    running.set(slot, (running.get(slot) || 0) + 1);
  }
  return out;
}

// ── Cadence ────────────────────────────────────────────────────────────
//
// Each rule runs on its own interval. The scheduler is still ONE timer, at
// FLOOR_MINUTES: on every beat it asks which rules are due and runs only
// those. "Different intervals" never means different timers — those would be
// overlapping runs, one contended lock and a separate budget per timer, for
// the sake of something a comparison does.
//
// An interval is one of INTERVAL_CHOICES, or blank. A fixed list rather than
// a free number because every choice is a whole number of beats, so a rule
// can never say one interval and run on another. Blank follows the
// deployment's default (CHALLENGE_SCORER_INTERVAL_MINUTES) — a rule nobody
// has touched runs exactly as often as the whole service did before rules
// had intervals of their own.
const FLOOR_MINUTES = 1;
const INTERVAL_CHOICES = [1, 2, 5, 10, 15, 30, 60];
// How early counts as on time: a quarter of a beat. The beat is a timer and
// timers drift by milliseconds, so a strict comparison would find 119.998 s
// "not yet" and make a two-minute rule wait a third minute. A quarter rather
// than a half for two reasons the first live run showed: the kick a deploy
// gives the scorer lands exactly half a beat before the first real beat,
// which put every rule on a knife-edge at every release; and with several
// instances beating out of phase, the wider the slack the more often the
// EARLIEST of them wins and the faster than asked a rule ends up running.
const DUE_SLACK_MS = (FLOOR_MINUTES * 60000) / 4;

const toMs = (v) => {
  if (v == null || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

// The interval a rule actually runs on, in minutes. null means the schedule
// does not run it at all: the deployment's default is 0, which switches
// automatic scoring off whatever a rule asks for.
function effectiveInterval(rule, defaultMinutes) {
  const fallback = Number(defaultMinutes);
  if (!(Number.isFinite(fallback) && fallback > 0)) return null;
  const own = Number(rule && rule.intervalMinutes);
  return INTERVAL_CHOICES.includes(own) ? own : fallback;
}

// Due once a whole interval has passed since the last complete pass, less
// DUE_SLACK_MS. A rule that has never been scored is due now.
function isDue(rule, { now = Date.now(), defaultMinutes } = {}) {
  const minutes = effectiveInterval(rule, defaultMinutes);
  if (minutes == null) return false;
  const last = toMs(rule && rule.lastScoredAt);
  if (last == null) return true;
  return now - last >= minutes * 60000 - DUE_SLACK_MS;
}

// When the rule is next looked at, for the screens that say so. null when
// the schedule does not run it, or when it has never run (it is due now, and
// "now" is not a time worth printing).
function nextDueAt(rule, { defaultMinutes } = {}) {
  const minutes = effectiveInterval(rule, defaultMinutes);
  const last = toMs(rule && rule.lastScoredAt);
  if (minutes == null || last == null) return null;
  return last + minutes * 60000;
}

// What a participant's card says about the schedule (#3185): how often this
// challenge is counted, and when it last was. Progress on a scored challenge
// moves only when a run writes credits, so without this a card can sit on
// "1/3" for a whole interval and read as broken.
//
// `ruleList` is every enabled rule bound to the challenge or its template,
// each shaped like the rule the scorer builds, plus its cadence fields. Only
// a rule that would score the challenge right now counts — skipReason null,
// and a schedule that runs it — so a card never promises an update the
// scorer is not going to make. Two rules can pay into one challenge (one on
// its template, one on the challenge), and progress moves whenever either
// runs: the shorter interval and the more recent complete pass.
//
// null when nothing counts it, and when nothing has yet: a rule that has
// never run is due on the next beat, and has no time worth printing.
function cadenceOf(ruleList, row, { now = Date.now(), defaultMinutes } = {}) {
  let minutes = null;
  let last = null;
  for (const rule of ruleList || []) {
    if (skipReason(rule, row, { now })) continue;
    const every = effectiveInterval(rule, defaultMinutes);
    if (every == null) continue;
    minutes = minutes == null ? every : Math.min(minutes, every);
    const at = toMs(rule.lastScoredAt);
    if (at != null) last = last == null ? at : Math.max(last, at);
  }
  if (minutes == null || last == null) return null;
  return { intervalMinutes: minutes, lastScoredAt: last };
}

// What a participant's page says about how a challenge is counted (#3253,
// #3248): the measure of the rule that scores it right now, and, for a
// measure that counts, the target past which nothing more is credited (the
// `already >= target` cap in planCredits). Unlike cadenceOf it does not wait
// for a first run: what counts is known before anything has been counted.
// Only a rule the scheduler would run (skipReason null, a schedule) speaks,
// so a page never explains a rule that is not going to score it. The first
// such rule wins; `measure` is always a MEASURES key, never free text.
//
// null when nothing scores it.
function countedByOf(ruleList, row, { now = Date.now(), defaultMinutes } = {}) {
  for (const rule of ruleList || []) {
    if (skipReason(rule, row, { now })) continue;
    if (effectiveInterval(rule, defaultMinutes) == null) continue;
    const spec = MEASURES[rule.measure];
    return { measure: rule.measure, target: spec.counted ? effectiveTarget(rule, row) : null };
  }
  return null;
}

// The order one run takes its rules in. Two things ride on it:
//
//   Cheap before expensive. A graded rule can spend most of a minute on
//   model calls, one after another; a rule that is a single SQL read should
//   never sit behind that, or somebody's connected account waits on a
//   stranger's bug report being marked.
//
//   Longest-waiting first, inside each lane. The run's budget is shared, and
//   a rule cut short by it is not stamped as scored — so next beat it is the
//   one that has waited longest and goes first. Starvation costs a beat, not
//   a whole interval, and nothing needs a budget of its own.
function runOrder(a, b) {
  const lane = (r) => (MEASURES[r.measure] && MEASURES[r.measure].graded ? 1 : 0);
  if (lane(a) !== lane(b)) return lane(a) - lane(b);
  const at = (r) => { const ms = toMs(r.lastScoredAt); return ms == null ? -Infinity : ms; };
  if (at(a) !== at(b)) return at(a) - at(b);
  return Number(a.id) - Number(b.id);
}

module.exports = {
  MEASURES,
  MEASURE_KEYS,
  TRY_APPS_MIN_SECONDS,
  crossedTryAppsFloor,
  WINDOW_GRACE_MS,
  parseRewardPoints,
  resolveWindow,
  WEEK_MS,
  isWeekly,
  weekStartMs,
  weeklyWindows,
  skipReason,
  effectiveTarget,
  effectivePoints,
  activityTypeFor,
  unitPoints,
  planCredits,
  FLOOR_MINUTES,
  INTERVAL_CHOICES,
  DUE_SLACK_MS,
  effectiveInterval,
  isDue,
  nextDueAt,
  cadenceOf,
  countedByOf,
  runOrder,
};
