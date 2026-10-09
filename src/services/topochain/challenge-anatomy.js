// How a rule scores, step by step — for the admin's rule detail.
//
// An operator choosing how often a rule should run needs to know what a run
// of it DOES: which tables it reads, whether a model is called, what stops it
// paying twice. That used to be knowable only by reading the scorer, and the
// difference matters — ten of the twelve measures are two SQL reads, and two
// of them can spend most of a minute on model calls.
//
// Everything printed here is taken from the thing that runs, not retyped
// beside it: the statement is the scorer's own constant (MEASURE_SQL), the
// rubric is the grader's own function called with the rule's ceiling, and the
// model, the input limits and the run budgets are the constants those modules
// execute with. tests/challenge-scoring.test.js holds each of them to that,
// so a panel that has drifted from the behaviour is a failing test rather
// than a wrong sentence on a screen somebody trusts.
//
// Pure: no pool, no I/O. The route hands it a measure and the two numbers.
'use strict';

const rules = require('./challenge-rules');
const grader = require('./challenge-grader');
const scorer = require('./challenge-scorer');

const { MEASURES, TRY_APPS_MIN_SECONDS } = rules;

// What each measure reads, in the words an operator would use, and how a
// credit names the thing it was paid for. `key` is the source key's fixed
// part: the test runs every measure and checks the keys it really produces
// start with it.
const READS = {
  TRY_APPS: {
    tables: ['app_activity', 'apps'],
    key: 'app:',
    keyLabel: 'app:<app id>',
    text: () => 'One row per person and app: apps they opened inside the window and spent at least '
      + `${TRY_APPS_MIN_SECONDS} seconds in, added up across days. Apps they made themselves are left out, except on a First `
      + 'challenge (the one-time Getting started list), where they count.',
  },
  USE_APPS_MINUTES: {
    tables: ['app_activity', 'apps'],
    key: 'window:',
    keyLabel: 'window:<first day of the window>',
    text: ({ target }) => 'One row per person: their time in apps inside the window, added up, once it reaches '
      + `${target == null ? 'the target' : `${fmt(target)} minutes`}. Apps they made themselves are left out. `
      + 'On a weekly challenge each week is a window of its own.',
  },
  PROPOSAL_SENT: {
    tables: ['chat_sessions', 'apps'],
    key: 'session:',
    keyLabel: 'session:<session id>',
    text: () => 'Proposals put to the group vote inside the window. Only the promote button writes '
      + '`promoted_at`, so the platform\'s own maintenance proposals never count.',
  },
  PROPOSAL_ACCEPTED: {
    tables: ['events', 'chat_sessions', 'apps'],
    key: 'merged:',
    keyLabel: 'merged:<event id>',
    text: () => 'Merges inside the window, credited to the proposal\'s author. A merge an admin forced is '
      + 'left out: it is not a change the group accepted.',
  },
  USEFUL_FEEDBACK: {
    tables: ['feedback_reports', 'apps', 'community_members', 'app_collaborators'],
    key: 'feedback:',
    keyLabel: 'feedback:<report id>',
    text: () => 'Reports sent inside the window that reached GitHub as an issue. One whose issue call '
      + 'failed helped nobody, and is left out. So is a report on a project they made, or on a "Just you" '
      + 'project (the audience rule the Workshop labels them by): there is nobody else to tell. '
      + 'On a First challenge (the one-time Getting started list) they count.',
  },
  CONNECT_ACCOUNTS: {
    tables: ['user_social_identities'],
    key: 'provider:',
    keyLabel: 'provider:<x or github>',
    text: () => 'Every linked account, one row per person and provider. No window: an account linked '
      + 'before the season counts.',
  },
  BLOCK_PRODUCTION_ON: {
    tables: ['users', 'epoch_stats'],
    key: 'block-production',
    keyLabel: 'block-production',
    text: () => 'Everyone who asked for block production access, was released, or has already won a '
      + 'slot. No window: state from before the season counts.',
  },
  COMMUNITY_JOINED: {
    tables: ['community_members', 'apps', 'app_collaborators'],
    key: 'community',
    keyLabel: 'community',
    text: () => 'Everyone in a public or private community: the audience rule the Workshop labels them by. '
      + 'The platform\'s own project and "Just you" projects are left out. No window: a membership from '
      + 'before the season counts.',
  },
  COMMUNITY_APP_CREATED: {
    tables: ['apps', 'community_members', 'app_collaborators'],
    key: 'community-app',
    keyLabel: 'community-app',
    text: () => 'Everyone who made a project whose community is public or private, by the same audience '
      + 'rule. One credit however many they made. No window: a project from before the season counts.',
  },
  INVITES_JOINED: {
    tables: ['community_invite_redemptions', 'community_invites', 'app_collaborators', 'users'],
    key: 'invitee:',
    keyLabel: 'invitee:<user id>',
    text: () => 'One row per person who joined inside the window through an invite link or an accepted '
      + 'invite, credited to whoever made the invite. Each person counts once, for the first invite '
      + 'they ever took.',
  },
  VOTE_CAST: {
    tables: ['pr_votes', 'chat_sessions', 'homeroom_bot_requesters', 'issue_votes', 'issues', 'users', 'apps',
      'community_members', 'app_collaborators'],
    key: 'vote:',
    keyLabel: 'vote:<pr, issue or workshop>:<id>',
    text: () => 'One row per person: their earliest vote inside the window, on a proposal or a request, '
      + 'or their look at the Workshop when nothing was up for a vote, whichever came first. A vote on '
      + 'their own proposal or request is left out, and so are a vote on what the Homeroom bot built '
      + 'from a request they made and any vote in a "Just you" project. The look is the Getting started '
      + 'card\'s Vote step: when nothing that would count is waiting for their vote in any community they '
      + 'are in, its button opens a Workshop, and the server records the visit (users.getting_started_seen, '
      + 'keyed vote:workshop:<user id>) only if nothing was waiting then. A vote that is cast again is dated by '
      + 'the last time, so a vote from before the window counts once it is cast again inside it.',
  },
  FEEDBACK_SENT: {
    tables: ['feedback_reports', 'apps', 'community_members', 'app_collaborators'],
    key: 'feedback:',
    keyLabel: 'feedback:<report id>',
    text: () => 'The same reports as "Sent useful feedback": sent inside the window, reached GitHub '
      + 'as an issue, and not about a project they made or a "Just you" one. Nothing is graded; the first '
      + 'one that gets past the junk filter is the credit. On a First challenge (the one-time Getting '
      + 'started list) a report on their own project counts too.',
  },
};

// What the interval is for, on a measure an action also runs on the spot
// (scorer.ON_THE_SPOT; #3564, #3568, #3569, #3570). Said where the operator
// picks the interval, because for these measures it is only the backstop.
// Keyed by the scorer's own door names; a test holds the two together.
const ON_THE_SPOT_TEXT = {
  join: ' A join also runs it on the spot, so the interval only paces memberships that arrive without '
    + 'one: a queued invite whose person is let in, or the dapp.json reconcile. A Home pin that joins '
      + 'runs it too.',
  vote: ' Casting a vote, or the Getting started card\'s look at the Workshop, also runs it on the '
    + 'spot, so the interval only paces what that pass missed.',
  feedback: ' Sending a report also runs it on the spot, so the interval only paces what that pass '
    + 'missed.',
  appTime: ` Using an app also runs it on the spot, the moment somebody's time in an app `
    + `first reaches ${TRY_APPS_MIN_SECONDS} seconds, so the interval only paces time that crosses the `
    + 'line another way: added up over days, or partly from before the window.',
};

function onTheSpot(measureKey) {
  const door = Object.keys(scorer.ON_THE_SPOT).find((d) => scorer.ON_THE_SPOT[d].includes(measureKey));
  return door ? ON_THE_SPOT_TEXT[door] : '';
}

// The statements are template literals indented to sit inside their module,
// so printed as they are the first line hangs left of all the others. Take
// off the indentation every line shares; what is left is the statement the
// scorer runs, laid out the way somebody would type it.
function dedent(sql) {
  const lines = String(sql).replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n);
}

// The cap a person reaches, which is what "already paid" stops at. A target
// of one reads in the singular ("Try an app" is TRY_APPS with a target of 1,
// #3570, and "stops at 1 apps" is not a sentence).
function capSentence(spec, target) {
  if (!spec.counted) return 'One credit a person, so a second pass finds nothing left to pay.';
  const n = target == null ? 'the target' : fmt(target);
  const unit = Number(target) === 1 ? spec.unit : spec.targetUnit;
  return spec.windowed
    ? `A person stops at ${n} ${unit} per window.`
    : `A person stops at ${n} ${unit}.`;
}

function anatomy(measureKey, { points = null, target = null } = {}) {
  const spec = MEASURES[measureKey];
  const reads = READS[measureKey];
  if (!spec || !reads) return null;

  const pts = Number(points);
  const tgt = Number(target);
  const hasPoints = Number.isFinite(pts) && pts > 0;
  const hasTarget = Number.isFinite(tgt) && tgt > 0;
  // The ceiling the grader is given for one unit — the scorer's own
  // arithmetic, so the rubric printed is the rubric sent.
  const ceiling = spec.graded && hasPoints && hasTarget
    ? rules.unitPoints({ payout: 'graded', points: pts, target: tgt, index: 0 })
    : null;

  const steps = [{
    kind: 'read',
    title: 'Read the candidates',
    text: reads.text({ target: hasTarget ? tgt : null }),
    tables: reads.tables,
    sql: dedent(scorer.MEASURE_SQL[measureKey]),
    note: `At most ${fmt(scorer.CANDIDATE_LIMIT)} rows a run.`,
  }];

  // Every measure the scorer screens (both feedback measures since #3568),
  // keyed on the same flag the scorer reads.
  if (spec.screened) {
    steps.push({
      kind: 'filter',
      title: 'Drop the junk',
      text: `No model call: a report under ${grader.MIN_FEEDBACK_CHARS} characters, or the same text this `
        + 'person already sent, is dropped here. It runs before the cap, so junk never holds one of a '
        + 'person\'s slots.',
    });
  }

  steps.push({
    kind: 'paid',
    title: 'Drop what is already paid',
    text: `Reads this challenge's ledger rows and drops every candidate whose source key (${reads.keyLabel}) `
      + `is already there. ${capSentence(spec, hasTarget ? tgt : null)}`,
    tables: ['user_activities'],
    sql: dedent(scorer.CREDITED_SQL),
  });

  if (spec.graded) {
    steps.push({
      kind: 'grade',
      title: 'Grade each new one',
      text: `One call to ${grader.GRADE_MODEL} (${grader.GRADE_FALLBACK_MODEL} when it does not answer in time) `
        + `for each new ${spec.unit}, one at a time, at most `
        + `${scorer.MAX_GRADES_PER_RUN} in a run across every graded rule. It is sent the app name, the first `
        + `${fmt(grader.GRADE_TITLE_CHARS)} characters of the title and the first ${fmt(grader.GRADE_TEXT_CHARS)} of the text, `
        + `and returns a score from 1 to ${ceiling == null ? 'the ceiling' : fmt(ceiling)} with a reason. Both are kept on the `
        + 'ledger row. A call that fails pays nothing, and the unit waits for this rule\'s next run. '
        + `Already graded is already paid, so each ${spec.unit} is sent once in its life.`,
      model: grader.GRADE_MODEL,
      rubric: ceiling == null ? null : grader.RUBRICS[measureKey].system(ceiling),
    });
  }

  steps.push({
    kind: 'write',
    title: 'Write the credits',
    text: 'One `user_activities` row per credit, dated when the thing happened, source '
      + '`challenge_scorer`. A unique index on challenge, person and source key refuses a second row, so '
      + `running the rule again pays nothing twice. At most ${fmt(scorer.MAX_CREDITS_PER_RUN)} credits in one run `
      + 'across every rule; a rule cut short by that goes first on the next beat.',
    tables: ['user_activities'],
  });

  return {
    measure: measureKey,
    lane: spec.graded ? 'sql_model' : 'sql',
    // What the interval actually buys, said where the interval is chosen.
    cost: (spec.graded
      ? `SQL, then one model call for each new ${spec.unit}. A ${spec.unit} is graded once in its life, so a `
        + 'shorter interval does not spend more. It only marks sooner.'
      : 'SQL only: two small reads a run, so a short interval costs nothing you would notice.')
      // A measure an action also runs on the spot (scorer.scoreOn) has the
      // interval as its backstop, and an operator choosing it should know.
      + onTheSpot(measureKey),
    steps,
  };
}

module.exports = { anatomy, dedent, READS, ON_THE_SPOT_TEXT };
