'use strict';

// The reviewed, closed Social inbox -> mobile-push policy. Every current
// notification kind appears exactly once. An absent future kind is therefore
// push-ineligible until this mapping, the database seed, and their tests are
// deliberately updated together.
const CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'direct_interactions',
    label: 'Direct interactions',
    description: 'Mentions, replies to your messages, and friend requests.',
    defaultEnabled: true,
    // #2387: a reply in an app-chat reply thread you started or joined is a
    // reply to your message in all but name. #2386: a friend request and its
    // acceptance are one person reaching you directly — this category's
    // promise — so they join it rather than getting a switch of their own.
    // #3952: being named with @ in a request somebody filed is a mention
    // like a chat one, so it rides the same switch, beside it.
    // #4535: a message in a request's discussion you posted in or filed is a
    // reply in the same sense, so it rides it too, beside `thread_reply`.
    // Kept in lockstep with the seed in db/schema.sql.
    kinds: Object.freeze(['mention', 'issue_mention', 'reply', 'thread_reply', 'issue_thread_reply', 'friend_request', 'friend_accept']),
  }),
  Object.freeze({
    key: 'invitations',
    label: 'Invitations',
    description: 'Collaboration and approver invitations, including when yours are accepted.',
    defaultEnabled: true,
    kinds: Object.freeze([
      'collab_invite',
      'collab_invite_accepted',
      'approver_invite',
      'approver_invite_accepted',
    ]),
  }),
  Object.freeze({
    key: 'shared_work',
    label: 'Shared work',
    description: 'Plans that someone privately shares with you.',
    defaultEnabled: true,
    kinds: Object.freeze(['spec_shared']),
  }),
  Object.freeze({
    key: 'developer_sessions',
    label: 'Agent sessions',
    description: 'Agent sessions and unattended runs that finish while you are away.',
    defaultEnabled: true,
    // #1405's two join this category rather than getting one of their own:
    // both are "a coding session did something while you were away", which is
    // exactly what this category's own description already promises. A
    // connector user who wants session pushes wants these; one who turned them
    // off does not, and should not have to find a second switch.
    // #3181: session_stalled is the other half of session_done (the turn
    // stopped before finishing), so it rides the same switch, beside it.
    // Kept in lockstep with the seed in db/schema.sql.
    kinds: Object.freeze([
      'session_done', 'session_stalled', 'auto_solve_done', 'connector_submitted',
      'agent_awaiting_input', 'test_alert',
    ]),
  }),
  Object.freeze({
    key: 'proposal_alerts',
    label: 'Change alerts',
    description: 'Changes that need your attention or your vote, votes on yours, and changes you made or voted on going live.',
    defaultEnabled: true,
    // #1374 adds three: a vote on your proposal, your proposal merging, and
    // the daily "what needs your vote" summary. All three are proposal
    // lifecycle, which is exactly what this category's description already
    // promises, so they join it rather than getting one of their own —
    // somebody who turned proposal pushes off does not want these either.
    // #1688 adds two more of the same kind: the re-confirm ask after a
    // proposal you backed gets a new version, and the weekly "this week"
    // card. Kept in lockstep with the seed in db/schema.sql.
    // #4787: the change a person voted on going live is proposal lifecycle
    // the same way, even though the per-app switch that gates the
    // notification itself is its own voted_changes_live.
    kinds: Object.freeze([
      'stale_pr', 'check_failed', 'pr_proposed', 'proposal_vote', 'pr_merged', 'vote_digest',
      'revision_recheck', 'weekly_digest',
      // B7: a change you can approve is ready to try.
      'change_ready',
      'voted_change_merged',
    ]),
  }),
  Object.freeze({
    key: 'app_alerts',
    label: 'App alerts',
    description: 'New issues filed on your apps, and apps that stop working.',
    defaultEnabled: true,
    // #1374's two that are NOT proposal lifecycle. They share a category
    // because they share an audience and a moment: both are "something
    // happened to an app you look after". Splitting them would be two
    // switches where nobody has a reason to set them differently.
    //
    // NOTE the second gate. `issue_opened` defaults OFF in
    // services/notification-preferences.js, so this being on by default
    // does not make it noisy: no notification is created in the first
    // place unless somebody opted the app in.
    //
    // 'platform_limit' is the same moment one level up, for full admins
    // only: the SERVER is nearing a cap that stops apps being created or
    // sessions starting (services/platform-limit-alerts.js). Only full
    // admins ever receive one, so nobody else's switch is affected.
    // 'platform_incident' (#4296) is its sibling: errors that should not
    // happen, as a daily digest or one kind past its hourly line
    // (services/platform-incident-alerts.js), for the same admins.
    kinds: Object.freeze(['issue_opened', 'app_health', 'platform_limit', 'platform_incident']),
  }),
  Object.freeze({
    key: 'lightweight_activity',
    label: 'Lightweight activity',
    description: 'Reactions and kudos on your work.',
    defaultEnabled: false,
    kinds: Object.freeze(['reaction', 'kudos']),
  }),
  Object.freeze({
    key: 'messages',
    label: 'Messages',
    description: 'Conversation invitations, messages, mentions, replies, and reactions.',
    defaultEnabled: true,
    kinds: Object.freeze([
      'conversation_invite',
      'conversation_message',
      'conversation_mention',
      'conversation_reply',
      'conversation_reaction',
      // #2387: a reply in a thread you started or replied in. "Replies" in
      // the description already covers it, so the copy does not change.
      'conversation_thread_reply',
      // A person's message in a small private group's discussion
      // (services/group-channel-notify.js): that discussion is the group's
      // chat, so it is a message like any other, and turning Messages off
      // silences it on the phone too. Kept in lockstep with the seed in
      // db/schema.sql.
      'channel_message',
    ]),
  }),
  Object.freeze({
    // WP-E: what the Homeroom bot says about something you asked it for, at
    // the moments its messages ring (homeroom-bot-notify-copy.js MOMENT_KINDS:
    // needs you, ready to try, stopped or on hold, live). They used to ride
    // Messages, so turning Messages off silenced "it's ready to try" too. Its
    // answers to what you wrote stay messages. The settings screen says the
    // same words (frontend/locales/en/settings.json alerts.push.*).
    key: 'builds',
    label: 'Your builds',
    description: 'What Homeroom bot tells you about something you asked for: when it needs you, is ready to try, stops, or goes live.',
    defaultEnabled: true,
    kinds: Object.freeze(['build_ready', 'build_needs_you', 'build_stopped', 'build_live']),
  }),
  Object.freeze({
    // WP-E: the people your invite links bring, told to whoever made the
    // link (services/invite-activity.js). Opens are a count, never a name;
    // a join or a first hello names a signed-in person who came by your link.
    key: 'invite_activity',
    label: 'Your invites',
    description: 'When someone opens your invite link, joins through it, or says hi for the first time.',
    defaultEnabled: true,
    kinds: Object.freeze(['invite_opened', 'member_joined', 'first_message']),
  }),
]);

const CATEGORY_BY_KEY = new Map(CATEGORY_DEFINITIONS.map((category) => (
  [category.key, category]
)));
const KIND_TO_CATEGORY = new Map();
for (const category of CATEGORY_DEFINITIONS) {
  for (const kind of category.kinds) {
    if (KIND_TO_CATEGORY.has(kind)) {
      throw new Error(`duplicate_mobile_push_kind:${kind}`);
    }
    KIND_TO_CATEGORY.set(kind, category.key);
  }
}

const ALLOWED_KINDS = new Set(KIND_TO_CATEGORY.keys());

function isKindEnabled(kind, overrides = {}) {
  const categoryKey = KIND_TO_CATEGORY.get(kind);
  if (!categoryKey) return false;
  const category = CATEGORY_BY_KEY.get(categoryKey);
  return typeof overrides[categoryKey] === 'boolean'
    ? overrides[categoryKey]
    : category.defaultEnabled;
}

function serializePreferences(overrides = {}) {
  return CATEGORY_DEFINITIONS.map((category) => ({
    key: category.key,
    label: category.label,
    description: category.description,
    defaultEnabled: category.defaultEnabled,
    enabled: typeof overrides[category.key] === 'boolean'
      ? overrides[category.key]
      : category.defaultEnabled,
  }));
}

async function readPreferences(pool, userId) {
  const { rows } = await pool.query(
    `SELECT category, enabled
       FROM mobile_push_preferences
      WHERE user_id = $1`,
    [userId]
  );
  const overrides = Object.fromEntries(rows.map((row) => [row.category, row.enabled]));
  return serializePreferences(overrides);
}

function validatePreferencePatch(body) {
  const details = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !Object.prototype.hasOwnProperty.call(body, 'preferences')) {
    details.preferences = ['The request must contain only a preferences object.'];
    return { details, values: null };
  }
  const preferences = body.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    details.preferences = ['The preferences field must be an object.'];
    return { details, values: null };
  }

  const entries = Object.entries(preferences);
  if (!entries.length) {
    details.preferences = ['At least one preference category is required.'];
  }
  for (const [key, value] of entries) {
    if (!CATEGORY_BY_KEY.has(key)) {
      details[key] = ['This push notification category is not recognized.'];
    } else if (typeof value !== 'boolean') {
      details[key] = ['The category value must be true or false.'];
    }
  }
  return {
    details,
    values: Object.keys(details).length ? null : Object.fromEntries(entries),
  };
}

async function writePreferences(pool, userId, values) {
  const entries = Object.entries(values);
  await pool.query(
    `INSERT INTO mobile_push_preferences (user_id, category, enabled)
     SELECT $1, input.category, input.enabled
       FROM UNNEST($2::text[], $3::boolean[]) AS input(category, enabled)
     ON CONFLICT (user_id, category) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           updated_at = NOW()`,
    [userId, entries.map(([key]) => key), entries.map(([, enabled]) => enabled)]
  );
  return readPreferences(pool, userId);
}

module.exports = {
  CATEGORY_DEFINITIONS,
  CATEGORY_BY_KEY,
  KIND_TO_CATEGORY,
  ALLOWED_KINDS,
  isKindEnabled,
  serializePreferences,
  readPreferences,
  validatePreferencePatch,
  writePreferences,
};
