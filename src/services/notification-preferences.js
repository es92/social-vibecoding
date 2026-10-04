'use strict';

/**
 * Per-app notification preferences (#1374).
 *
 * ── What this gates, and why it is not the push-preferences table ───────
 *
 * `mobile-push-preferences.js` answers "may this ping my phone". It runs
 * AFTER a notification exists, so turning a category off there still leaves
 * the bell lit and the drawer row in place.
 *
 * This answers a different question: "do I get this at all, for this app".
 * The requester asked for one switch governing the phone push and the
 * on-platform notification together, and the mechanism makes that nearly
 * free — `mobile_push_deliveries` joins `notifications` by id, so gating at
 * CREATION suppresses both in lockstep and they cannot drift. Filtering push
 * downstream would have meant two things kept in agreement forever.
 *
 * The two layers compose: this decides whether a notification is created at
 * all, and the push preferences then decide whether the one that WAS created
 * reaches a phone. Nothing about the existing table changes.
 *
 * On the objection that suppressing the row is destructive (raised on the
 * issue, and fair): what is suppressed is the ping, not the record. A muted
 * new issue is still on the app's Dev board, a muted proposal is still on
 * the board awaiting votes, a muted vote is still on the proposal. Nothing
 * becomes unreachable; you are simply not interrupted. That is a weaker
 * claim than "nothing is lost", and it is the true one.
 *
 * ── Two axes, three layers ─────────────────────────────────────────────
 *
 * A stored row is keyed (user, app, category), and `app_id` is NULLABLE:
 *
 *   per-app row  →  account-wide row (app_id IS NULL)  →  defaultEnabled
 *
 * The middle layer is the idea from the issue thread, kept because it comes
 * free with the nullable column and makes the settings roll-up far more
 * useful: "quiet by default, except these two apps" is one row plus two,
 * rather than a row for every app the user will ever open.
 */

/**
 * The app-scoped categories, in the order the dialog renders them.
 *
 * `kinds` is what each category gates. A kind appearing here does NOT have
 * to be push-eligible — these are different vocabularies on purpose (this
 * one is app ACTIVITY, the push one is notification TYPE), which is why the
 * account-wide push answer cannot simply be seeded into these.
 *
 * `adminOnly` categories are hidden from people who are neither an admin nor
 * the app's creator, because the events behind them are only ever sent to
 * those people in the first place. Offering the switch to everybody else
 * would be offering to mute something they were never going to receive.
 */
const APP_CATEGORY_DEFINITIONS = Object.freeze([
  // B7: a change Homeroom bot built is ready to try and needs your Yes. ON:
  // it is asked of the few whose approval it needs (on a public community,
  // only the approvers a project names), so it is no broadcast; and it is
  // how they hear at all, since new_proposals below is off.
  Object.freeze({
    key: 'changes_ready',
    label: 'Changes ready for you to try',
    description: 'A change on this app needs your approval and is ready for you to try.',
    defaultEnabled: true,
    kinds: Object.freeze(['change_ready']),
  }),
  Object.freeze({
    key: 'new_proposals',
    label: 'New proposals to vote on',
    description: 'Someone proposes a change to this app and the group needs votes.',
    // OFF by design, and the reason the digest below exists. Before #1374
    // this fired at everyone with the app in "Your apps", everyone active in
    // it and the creator, with no way to turn it off. Defaulting it off
    // without the digest would have quietly cost the group its turnout.
    defaultEnabled: false,
    kinds: Object.freeze(['pr_proposed']),
  }),
  Object.freeze({
    key: 'new_issues',
    label: 'New issues',
    description: 'Someone files a request or a bug report on this app.',
    defaultEnabled: false,
    kinds: Object.freeze(['issue_opened']),
  }),
  Object.freeze({
    key: 'proposal_status',
    label: 'Your proposals',
    description: 'Checks fail, a proposal of yours stalls, or one of them merges.',
    // ON: it is your own work, and two of the three are asking you to act.
    defaultEnabled: true,
    kinds: Object.freeze(['check_failed', 'stale_pr', 'pr_merged']),
  }),
  Object.freeze({
    key: 'thread_replies',
    label: 'Replies to you',
    description: 'Someone replies to your message, issue or proposal on this app.',
    defaultEnabled: true,
    // The EXISTING `reply` kind, not a new one. services/ws.js already fires
    // it app-scoped for a reply to a quoted message or a PR, and a message
    // carries its thread (chat_messages.thread_type is 'issue', 'session' or
    // 'governance'), so issue and proposal discussions are already covered.
    //
    // `mention` is deliberately NOT here. Being named by somebody is a
    // direct address rather than app activity, and muting it per app is a
    // surprise nobody asked for; it stays account-level.
    //
    // #2387 adds `thread_reply`: somebody answered in a reply thread you
    // started or joined in this app's chat. That is this category's promise
    // word for word — a reply to your message on this app — so the one
    // switch governs both, and createThreadReplyNotifications checks it.
    kinds: Object.freeze(['reply', 'thread_reply']),
  }),
  Object.freeze({
    key: 'proposal_votes',
    label: 'Votes on your proposals',
    description: 'Someone votes yes or no on a change you proposed.',
    defaultEnabled: true,
    kinds: Object.freeze(['proposal_vote']),
  }),
  // #1688: the re-confirm ask. Somebody pushed a new version of a proposal
  // this person had said yes to; their yes was on the old version and one
  // tap carries it onto the new one. ON: it is their own vote being asked
  // about, and silence would quietly cost the proposal its support.
  Object.freeze({
    key: 'revision_recheck',
    label: 'Proposals you backed change',
    description: 'A proposal you said yes to gets a new version and needs another look.',
    defaultEnabled: true,
    kinds: Object.freeze(['revision_recheck']),
  }),
  // #1688: the Friday card. Once a week per app, what went live and who
  // made it, and what is waiting on votes; nothing at all on a quiet week.
  // The card itself lands in the app's chat regardless — this gates the
  // notification and push that point at it.
  Object.freeze({
    key: 'weekly_digest',
    label: 'Weekly summary of what shipped',
    description: 'One card a week in the app’s chat: what went live and who made it, and what is waiting on votes. Nothing on a quiet week.',
    defaultEnabled: true,
    kinds: Object.freeze(['weekly_digest']),
  }),
  Object.freeze({
    key: 'app_health',
    label: 'App health',
    description: 'A deploy fails, or the app stops running.',
    defaultEnabled: true,
    adminOnly: true,
    kinds: Object.freeze(['app_health']),
  }),
]);

/**
 * Account-wide categories: no app dimension, because the notification they
 * gate is not about one app.
 *
 * The digest is the counterweight to `new_proposals` defaulting off. Once a
 * day it says how many proposals are waiting on your vote across every app
 * you have a stake in, so somebody who wants a quiet inbox still finds out
 * the group is waiting on them.
 */
const ACCOUNT_CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'vote_digest',
    label: 'Daily summary of what needs your vote',
    description: 'Once a day, a single message counting the proposals waiting on you.',
    defaultEnabled: true,
    kinds: Object.freeze(['vote_digest']),
  }),
]);

const ALL_DEFINITIONS = Object.freeze([
  ...APP_CATEGORY_DEFINITIONS,
  ...ACCOUNT_CATEGORY_DEFINITIONS,
]);

const CATEGORY_BY_KEY = new Map(ALL_DEFINITIONS.map((c) => [c.key, c]));
const APP_CATEGORY_KEYS = Object.freeze(APP_CATEGORY_DEFINITIONS.map((c) => c.key));

/**
 * kind → category. Built with a duplicate guard for the same reason
 * mobile-push-preferences.js has one: a kind belonging to two categories
 * would make "is this muted" depend on map iteration order, which is a bug
 * that only shows up for whichever kind was added second.
 */
const KIND_TO_CATEGORY = new Map();
for (const category of ALL_DEFINITIONS) {
  for (const kind of category.kinds) {
    if (KIND_TO_CATEGORY.has(kind)) {
      throw new Error(`duplicate_notification_preference_kind:${kind}`);
    }
    KIND_TO_CATEGORY.set(kind, category.key);
  }
}

/** Kinds this layer has an opinion about. Everything else is unaffected. */
const GATED_KINDS = new Set(KIND_TO_CATEGORY.keys());

/**
 * Is this kind gated here at all?
 *
 * The answer is NO for most notification kinds — mentions, invitations,
 * conversation messages and the rest are account-level concerns with no app
 * dimension, and they must keep working exactly as they do now. An ungated
 * kind is never suppressed by anything in this file.
 */
function isGatedKind(kind) {
  return typeof kind === 'string' && GATED_KINDS.has(kind);
}

function categoryForKind(kind) {
  return KIND_TO_CATEGORY.get(kind) || null;
}

function definitionFor(categoryKey) {
  return CATEGORY_BY_KEY.get(categoryKey) || null;
}

/**
 * Resolve one category for one user and app from already-loaded rows.
 *
 * `rows` is whatever `readOverrides` returned: `{ appOverrides, accountOverrides }`,
 * both plain category→boolean maps. Pure, so the decision can be unit-tested
 * without a database and so a fan-out can resolve hundreds of recipients
 * from one query rather than one query each.
 */
function resolveEnabled(categoryKey, { appOverrides = {}, accountOverrides = {} } = {}) {
  const definition = CATEGORY_BY_KEY.get(categoryKey);
  if (!definition) return false;
  if (typeof appOverrides[categoryKey] === 'boolean') return appOverrides[categoryKey];
  if (typeof accountOverrides[categoryKey] === 'boolean') return accountOverrides[categoryKey];
  return definition.defaultEnabled;
}

/**
 * The same decision, for a notification KIND rather than a category.
 *
 * An ungated kind resolves TRUE: this layer only ever suppresses things it
 * was given an opinion about, and defaulting the unknown to "send" is what
 * keeps a new notification kind working the day it is added rather than
 * silently vanishing until somebody remembers to add it here.
 */
function isKindEnabled(kind, overrides) {
  if (!isGatedKind(kind)) return true;
  return resolveEnabled(categoryForKind(kind), overrides);
}

/**
 * The categories to show one person for one app, as view models.
 *
 * `isAdmin` hides the admin-only rows. `source` says WHERE each answer came
 * from, which is what lets the dialog draw "following your default" against
 * a row nobody has touched, rather than presenting an inherited value as a
 * per-app decision.
 */
function serializeAppCategories({ appOverrides = {}, accountOverrides = {}, isAdmin = false } = {}) {
  return APP_CATEGORY_DEFINITIONS
    .filter((category) => !category.adminOnly || isAdmin)
    .map((category) => {
      const hasApp = typeof appOverrides[category.key] === 'boolean';
      const hasAccount = typeof accountOverrides[category.key] === 'boolean';
      return {
        key: category.key,
        label: category.label,
        description: category.description,
        defaultEnabled: category.defaultEnabled,
        enabled: resolveEnabled(category.key, { appOverrides, accountOverrides }),
        source: hasApp ? 'app' : (hasAccount ? 'account' : 'default'),
      };
    });
}

/** The account-wide rows, for the Settings roll-up. */
function serializeAccountCategories({ accountOverrides = {} } = {}) {
  return ALL_DEFINITIONS
    .filter((category) => !category.adminOnly)
    .map((category) => ({
      key: category.key,
      label: category.label,
      description: category.description,
      defaultEnabled: category.defaultEnabled,
      enabled: resolveEnabled(category.key, { accountOverrides }),
      source: typeof accountOverrides[category.key] === 'boolean' ? 'account' : 'default',
      appScoped: APP_CATEGORY_KEYS.includes(category.key),
    }));
}

/**
 * Load one user's overrides in a single query.
 *
 * Both layers come back together because every caller needs both to resolve
 * anything: a per-app answer is meaningless without the account-wide value
 * behind it. `appId` null reads only the account layer.
 */
async function readOverrides(pool, userId, appId = null) {
  const { rows } = await pool.query(
    `SELECT app_id, category, enabled
       FROM notification_preferences
      WHERE user_id = $1 AND (app_id IS NULL OR app_id = $2)`,
    [userId, appId]
  );
  const appOverrides = {};
  const accountOverrides = {};
  for (const row of rows) {
    if (row.app_id === null) accountOverrides[row.category] = row.enabled;
    else appOverrides[row.category] = row.enabled;
  }
  return { appOverrides, accountOverrides };
}

/**
 * Resolve ONE category for MANY users on one app, in one query.
 *
 * This is what makes gating a fan-out affordable. `createPrProposedNotifications`
 * can be looking at every active user of an app; asking the database once per
 * recipient would turn one insert into hundreds of round trips.
 *
 * Returns the subset of `userIds` for whom the category is enabled, in the
 * order given.
 */
async function filterUsersByCategory(pool, { userIds, appId, categoryKey }) {
  const ids = [...new Set((userIds || []).filter((id) => Number.isInteger(id)))];
  if (!ids.length) return [];
  const definition = CATEGORY_BY_KEY.get(categoryKey);
  if (!definition) return [];

  const { rows } = await pool.query(
    `SELECT user_id, app_id, enabled
       FROM notification_preferences
      WHERE category = $1 AND user_id = ANY($2::int[])
        AND (app_id IS NULL OR app_id = $3)`,
    [categoryKey, ids, appId]
  );
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, {});
    const entry = byUser.get(row.user_id);
    if (row.app_id === null) entry.account = row.enabled;
    else entry.app = row.enabled;
  }
  return ids.filter((id) => {
    const entry = byUser.get(id) || {};
    if (typeof entry.app === 'boolean') return entry.app;
    if (typeof entry.account === 'boolean') return entry.account;
    return definition.defaultEnabled;
  });
}

/**
 * The single-recipient version, for producers that notify one person.
 *
 * Fails OPEN on a database error: a preference read that breaks must not
 * swallow a notification telling somebody their proposal's checks failed.
 * The quiet failure mode of this whole feature is notifications silently
 * not arriving, so every uncertain path here sends.
 */
async function allowsKind(pool, { userId, appId, kind }) {
  if (!isGatedKind(kind)) return true;
  if (!userId) return true;
  try {
    const overrides = await readOverrides(pool, userId, appId ?? null);
    return isKindEnabled(kind, overrides);
  } catch {
    return true;
  }
}

/** Validate a PATCH body: `{ preferences: { categoryKey: boolean } }`. */
function validatePreferencePatch(body, { allowedKeys = null } = {}) {
  const details = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, 'preferences')) {
    details.preferences = ['The request must contain a preferences object.'];
    return { details, values: null };
  }
  const preferences = body.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    details.preferences = ['The preferences field must be an object.'];
    return { details, values: null };
  }
  const entries = Object.entries(preferences);
  if (!entries.length) details.preferences = ['At least one category is required.'];
  for (const [key, value] of entries) {
    const permitted = allowedKeys ? allowedKeys.includes(key) : CATEGORY_BY_KEY.has(key);
    if (!permitted) {
      details[key] = ['This notification category is not recognized.'];
    } else if (typeof value !== 'boolean' && value !== null) {
      // null is meaningful: it CLEARS the override and falls back to the
      // layer beneath, which is how "follow my default again" is expressed.
      details[key] = ['The category value must be true, false or null.'];
    }
  }
  return {
    details,
    values: Object.keys(details).length ? null : Object.fromEntries(entries),
  };
}

/**
 * Write overrides for one user and (optionally) one app.
 *
 * A `null` value DELETES the row rather than storing a third state, so
 * "follow my default" is the absence of an override and stays correct if the
 * default ever changes. `appId` null writes the account-wide layer.
 */
async function writeOverrides(pool, userId, appId, values) {
  const entries = Object.entries(values);
  const touched = entries.map(([k]) => k);
  const set = entries.filter(([, v]) => typeof v === 'boolean');

  // DELETE-then-INSERT rather than ON CONFLICT, because the natural key
  // includes a NULLABLE column: `app_id IS NULL` is the account-wide layer,
  // and NULLs are not equal to each other, so a plain unique constraint
  // cannot express it and ON CONFLICT would have to infer an expression
  // index. The uniqueness is still enforced (see the COALESCE index in
  // schema.sql); this just avoids depending on inference to write a row.
  // Both statements are keyed on the same `IS NOT DISTINCT FROM`, which is
  // the NULL-safe equality this key needs, and writes here are one settings
  // toggle at a time.
  await pool.query(
    `DELETE FROM notification_preferences
      WHERE user_id = $1 AND category = ANY($2::text[])
        AND app_id IS NOT DISTINCT FROM $3`,
    [userId, touched, appId ?? null]
  );
  if (set.length) {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       SELECT $1, $2, input.category, input.enabled
         FROM UNNEST($3::text[], $4::boolean[]) AS input(category, enabled)`,
      [userId, appId ?? null, set.map(([k]) => k), set.map(([, v]) => v)]
    );
  }
  return readOverrides(pool, userId, appId ?? null);
}

module.exports = {
  APP_CATEGORY_DEFINITIONS,
  ACCOUNT_CATEGORY_DEFINITIONS,
  APP_CATEGORY_KEYS,
  CATEGORY_BY_KEY,
  KIND_TO_CATEGORY,
  GATED_KINDS,
  isGatedKind,
  categoryForKind,
  definitionFor,
  resolveEnabled,
  isKindEnabled,
  serializeAppCategories,
  serializeAccountCategories,
  readOverrides,
  filterUsersByCategory,
  allowsKind,
  validatePreferencePatch,
  writeOverrides,
};
