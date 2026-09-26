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
// Five measures score ACTIONS and count only what happened inside the
// challenge's own window. Without that rule, opening a season would
// retroactively pay everyone who had ever promoted a proposal, and the first
// tick would hand the onboarding points to people who never saw the
// challenge.
//
// Two score a STATE instead — "is your GitHub linked", "is block production
// on" — and deliberately do NOT filter by window. A state has no date to
// compare: somebody who linked their account last month still has it linked,
// and a persistent challenge that refused to see that would be telling them
// to do something they have already done.
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
const MEASURES = {
  TRY_APPS: {
    label: 'Tried different apps',
    phrase: 'opens {target} different apps',
    summary: 'Opened this many different apps and spent at least half a minute in each. Apps they made themselves do not count.',
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
    summary: 'Filed a report through the feedback dialog inside the window. Each one is graded on how easy it is to act on.',
    unit: 'report',
    targetUnit: 'reports',
    counted: true,
    payout: 'graded',
    windowed: true,
    graded: true,
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
};

const MEASURE_KEYS = Object.keys(MEASURES);

// A day's worth of app use is one row per (user, app, day), so the
// "did they actually open it" floor is in seconds.
const TRY_APPS_MIN_SECONDS = 30;

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
  if (spec.counted && !(effectiveTarget(rule, row) > 1)) {
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
// person has. Both are what make the scorer safe to run every ten minutes —
// the plan for a person already fully credited is empty.
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
  if (spec.counted && !(target > 1)) return [];

  const window = resolveWindow(row, { now });
  const out = [];
  // How many credits each person will have once this run's own plan is
  // applied — without it, two candidates in the same run would both be
  // "the second account" and the challenge would overpay.
  const running = new Map();

  for (const c of candidates) {
    const userId = Number(c.userId);
    if (!Number.isFinite(userId)) continue;
    const state = credited.get(userId) || { keys: new Set(), count: 0 };
    if (state.keys.has(c.sourceKey)) continue;
    const already = state.count + (running.get(userId) || 0);
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
      completion: !spec.counted,
      needsGrade: spec.graded === true,
      gradeInput: c.gradeInput || null,
    });
    running.set(userId, (running.get(userId) || 0) + 1);
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
  WINDOW_GRACE_MS,
  parseRewardPoints,
  resolveWindow,
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
  runOrder,
};
