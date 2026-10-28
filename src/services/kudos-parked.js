'use strict';

// Kudos is parked (#5249), server side.
//
// The client's switch is frontend/src/features/leaderboard/kudos-parked.ts.
// This is its twin for the server, and the two move together: while both are
// true nobody gives, retracts or pledges kudos, no kudos notification is
// listed or counted, no bounty line is drawn in a thread, and a bounty
// pledged before parking is still paid when a merged change closes its
// request, quietly. Nothing is deleted: the tables, their rows, the scoring
// and the read routes all stay as they are, so setting both back to false
// brings the feature back as it was.
//
// One constant, read three ways:
//   * KUDOS_PARKED, for code that only needs to know.
//   * kudosParked(config), for a route factory: a test that exercises the
//     dormant feature passes `{ kudosParked: false }` in the route's config.
//   * PARKED_NOTIFICATION_KINDS and parkedSystemLineSql(), the SQL the
//     notification and thread readers filter with.
//
// The constant itself is src/workflow/rules/kudos-parked.ts, so the
// merge-followups machine reads the same switch without reaching in here.
const { KUDOS_PARKED } = require('../workflow/rules/kudos-parked.ts');

// Notification kinds whose feature is parked. Their rows stay in the table;
// listForUser (the feed and its Saved section), getForUser and countUnread
// (services/notifications.js) skip them, so the bell, its badge and the badge
// on the phone's icon all agree.
// mobile-push-policy.js wakes no phone for one either.
const PARKED_NOTIFICATION_KINDS = Object.freeze(KUDOS_PARKED ? ['kudos'] : []);

// The answer a parked write route gives: 410 Gone, in the shape a client's
// generic error path already reads (an `error` code and a `message`).
const PARKED_BODY = Object.freeze({ error: 'kudos_parked', message: 'Kudos are paused.' });

function kudosParked(config) {
  if (config && typeof config.kudosParked === 'boolean') return config.kudosParked;
  return KUDOS_PARKED;
}

function refuseParked(res) {
  return res.status(410).json({ ...PARKED_BODY });
}

// The two system lines a bounty wrote into a thread, which are not drawn
// while kudos is parked. Neither line carries a marker of its own (the pledge
// line has no metadata; the award line only the workflow's `wfEvent`), so
// they are matched by their exact sentence shapes, both anchored:
//
//   "<username> placed a bounty (kudos) on issue #<n>"
//       services/bounties.js placeBounty, in the request's thread.
//   "Bounty on issue #<n> (<k> kudos) awarded to <who> for PR #<m>"
//       the merge-followups machine's writeBounties (and, before it, the
//       old merge path in routes/votes.js), in the proposal's thread. <who>
//       is a "<@id>" mention or "the author".
//
// Only rows with msg_type 'system' are matched: a person who typed either
// sentence keeps their message. Usernames carry no spaces, hence [^ ]+.
const BOUNTY_LINE_PATTERNS = Object.freeze([
  '^[^ ]+ placed a bounty \\(kudos\\) on issue #[0-9]+$',
  '^Bounty on issue #[0-9]+ \\([0-9]+ kudos\\) awarded to .+ for PR #[0-9]+$',
]);

// A SQL predicate over a chat_messages alias that is TRUE for a row to keep.
// Static text: the patterns are the constants above, never request input.
function parkedSystemLineSql(alias = 'm') {
  if (!KUDOS_PARKED) return 'TRUE';
  const patterns = BOUNTY_LINE_PATTERNS.map((p) => `${alias}.content ~ '${p}'`);
  return `NOT (${alias}.msg_type = 'system' AND (${patterns.join(' OR ')}))`;
}

// The same rule in JS, for a reader that holds rows rather than SQL.
const BOUNTY_LINE_RES = BOUNTY_LINE_PATTERNS.map((p) => new RegExp(p));
function isParkedSystemLine(row) {
  if (!KUDOS_PARKED || !row || row.msg_type !== 'system') return false;
  const content = String(row.content || '');
  return BOUNTY_LINE_RES.some((re) => re.test(content));
}

module.exports = {
  KUDOS_PARKED,
  PARKED_NOTIFICATION_KINDS,
  PARKED_BODY,
  BOUNTY_LINE_PATTERNS,
  kudosParked,
  refuseParked,
  parkedSystemLineSql,
  isParkedSystemLine,
};
