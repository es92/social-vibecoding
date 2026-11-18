// Per-app notification preferences (#1374): services/notification-preferences.js
// re-exports this whole module. It lives with the workflow because the
// merge-followups machine creates the author's "your change is live"
// notification inside its transaction, and decides it by these rules
// (kindAllowed, below).

import type { Queryable } from './db.ts';

export interface Category {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  kinds: readonly string[];
  adminOnly?: boolean;
  smallGroupOnly?: boolean;
}
export interface Overrides { appOverrides: Record<string, boolean>; accountOverrides: Record<string, boolean> }

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
export const APP_CATEGORY_DEFINITIONS: readonly Category[] = Object.freeze([
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
    description: 'Checks fail, a proposal of yours stalls, merges or is closed.',
    // ON: it is your own work, and two of the three are asking you to act.
    defaultEnabled: true,
    kinds: Object.freeze(['check_failed', 'stale_pr', 'pr_merged', 'change_closed']),
  }),
  // A person's message in the discussion of a private project of 8 people or
  // fewer (services/group-channel-notify.js). ON: in a group that small the
  // discussion is the group chat, and a message nobody hears is a
  // conversation that stalls. `smallGroupOnly`: offered on a project's own
  // dialog only while it IS such a group, because nothing else ever sends
  // it, so a switch anywhere else would be a switch that does nothing. The
  // account-wide row is the "quiet in every group" choice, and a project's
  // own row beats it, as for every category here.
  Object.freeze({
    key: 'channel_messages',
    label: 'Every message in the discussion',
    description: 'In a private project of 8 people or fewer, anything someone writes in its discussion. Mentions reach you either way.',
    defaultEnabled: true,
    smallGroupOnly: true,
    kinds: Object.freeze(['channel_message']),
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
    // surprise nobody asked for; it stays account-level. #3952's
    // `issue_mention` (named in a request's text) is a mention too, and is
    // not here for the same reason.
    //
    // #2387 adds `thread_reply`: somebody answered in a reply thread you
    // started or joined in this app's chat. That is this category's promise
    // word for word — a reply to your message on this app — so the one
    // switch governs both, and createThreadReplyNotifications checks it.
    //
    // #4535 adds `issue_thread_reply`: somebody posted in a request's
    // discussion after you did, or answered the request you filed. The same
    // promise, so the same switch governs it too
    // (createIssueThreadNotifications checks it) — one place to turn the
    // conversation follow-ups off.
    //
    // #6019 adds `change_thread_reply`: the same for a thread a change or a
    // decision leads (createThreadNotifications checks it too).
    kinds: Object.freeze(['reply', 'thread_reply', 'issue_thread_reply', 'change_thread_reply']),
  }),
  Object.freeze({
    key: 'proposal_votes',
    label: 'Votes on your proposals',
    description: 'Someone votes yes or no on a change you proposed.',
    defaultEnabled: true,
    kinds: Object.freeze(['proposal_vote']),
  }),
  // #4787: the loop closed on the voter's side. Until this, a merge told
  // only its author; everybody who had a say had to stumble on the news. ON:
  // it is the answer to a vote they cast, not new activity to interrupt
  // them, and muting it is how a person says "I don't follow my votes".
  Object.freeze({
    key: 'voted_changes_live',
    label: 'Changes you voted on go live',
    description: 'A change you voted yes or no on goes live.',
    defaultEnabled: true,
    kinds: Object.freeze(['voted_change_merged']),
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
  // #1688: the Friday card. Once a week, what went live and what is
  // waiting on votes; nothing at all on a quiet week.
  // #6371: ONE notification covers every project the person is in, and
  // opens the This week page; each project's own card still lands in its
  // Workshop (services/app-notices.js) and is not gated by this.
  Object.freeze({
    key: 'weekly_digest',
    label: 'Weekly digest',
    description: 'One notification on Friday covers what went live and what is waiting for approval across your projects. Each project’s own card stays in its Workshop.',
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
export const ACCOUNT_CATEGORY_DEFINITIONS: readonly Category[] = Object.freeze([
  Object.freeze({
    key: 'vote_digest',
    label: 'Daily summary of what needs your vote',
    description: 'Once a day, a single message counting the proposals waiting on you.',
    defaultEnabled: true,
    kinds: Object.freeze(['vote_digest']),
  }),
  // #5404: where the changes you already voted on went, once a week.
  Object.freeze({
    key: 'voted_digest',
    label: 'Weekly summary of changes you voted on',
    description: 'Once a week, a single message counting the changes you voted on that were decided. Nothing on a quiet week.',
    defaultEnabled: true,
    kinds: Object.freeze(['voted_digest']),
  }),
]);

const ALL_DEFINITIONS: readonly Category[] = Object.freeze([
  ...APP_CATEGORY_DEFINITIONS,
  ...ACCOUNT_CATEGORY_DEFINITIONS,
]);

export const CATEGORY_BY_KEY: ReadonlyMap<string, Category> = new Map(ALL_DEFINITIONS.map((c) => [c.key, c]));
export const APP_CATEGORY_KEYS: readonly string[] = Object.freeze(APP_CATEGORY_DEFINITIONS.map((c) => c.key));

/**
 * kind → category. Built with a duplicate guard for the same reason
 * mobile-push-preferences.js has one: a kind belonging to two categories
 * would make "is this muted" depend on map iteration order, which is a bug
 * that only shows up for whichever kind was added second.
 */
const kindToCategory = new Map<string, string>();
for (const category of ALL_DEFINITIONS) {
  for (const kind of category.kinds) {
    if (kindToCategory.has(kind)) {
      throw new Error(`duplicate_notification_preference_kind:${kind}`);
    }
    kindToCategory.set(kind, category.key);
  }
}

export const KIND_TO_CATEGORY: ReadonlyMap<string, string> = kindToCategory;

/** Kinds this layer has an opinion about. Everything else is unaffected. */
export const GATED_KINDS: ReadonlySet<string> = new Set(kindToCategory.keys());

/**
 * Is this kind gated here at all?
 *
 * The answer is NO for most notification kinds — mentions, invitations,
 * conversation messages and the rest are account-level concerns with no app
 * dimension, and they must keep working exactly as they do now. An ungated
 * kind is never suppressed by anything in this file.
 */
export function isGatedKind(kind: unknown): boolean {
  return typeof kind === 'string' && GATED_KINDS.has(kind);
}

export function categoryForKind(kind: string): string | null {
  return KIND_TO_CATEGORY.get(kind) || null;
}

export function definitionFor(categoryKey: string): Category | null {
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
export function resolveEnabled(categoryKey: string | null, { appOverrides = {}, accountOverrides = {} }: Partial<Overrides> = {}): boolean {
  const definition = categoryKey ? CATEGORY_BY_KEY.get(categoryKey) : undefined;
  if (!definition || !categoryKey) return false;
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
export function isKindEnabled(kind: string, overrides: Partial<Overrides>): boolean {
  if (!isGatedKind(kind)) return true;
  return resolveEnabled(categoryForKind(kind), overrides);
}

/**
 * The categories to show one person for one app, as view models.
 *
 * `isAdmin` hides the admin-only rows, and `smallGroup` (the project is a
 * private group of 8 people or fewer, group-channel-notify.isSmallGroup) is
 * what shows the small-group ones. `source` says WHERE each answer came
 * from, which is what lets the dialog draw "following your default" against
 * a row nobody has touched, rather than presenting an inherited value as a
 * per-app decision.
 */
export function offeredOn(category: Category, { isAdmin = false, smallGroup = false }: { isAdmin?: boolean; smallGroup?: boolean } = {}): boolean {
  return (!category.adminOnly || isAdmin) && (!category.smallGroupOnly || smallGroup);
}

export function serializeAppCategories({
  appOverrides = {}, accountOverrides = {}, isAdmin = false, smallGroup = false,
}: Partial<Overrides> & { isAdmin?: boolean; smallGroup?: boolean } = {}) {
  return APP_CATEGORY_DEFINITIONS
    .filter((category) => offeredOn(category, { isAdmin, smallGroup }))
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
export function serializeAccountCategories({ accountOverrides = {} }: Partial<Overrides> = {}) {
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
export async function readOverrides(pool: Queryable, userId: number, appId: number | null = null): Promise<Overrides> {
  const { rows } = await pool.query(
    `SELECT app_id, category, enabled
       FROM notification_preferences
      WHERE user_id = $1 AND (app_id IS NULL OR app_id = $2)`,
    [userId, appId]
  );
  const appOverrides: Record<string, boolean> = {};
  const accountOverrides: Record<string, boolean> = {};
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
export async function filterUsersByCategory(
  pool: Queryable, { userIds, appId, categoryKey }: { userIds: number[]; appId: number | null; categoryKey: string },
): Promise<number[]> {
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
  const byUser = new Map<number, { app?: boolean; account?: boolean }>();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, {});
    const entry = byUser.get(row.user_id)!;
    if (row.app_id === null) entry.account = row.enabled;
    else entry.app = row.enabled;
  }
  return ids.filter((id) => {
    const entry = byUser.get(id) || {} as { app?: boolean; account?: boolean };
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
export async function allowsKind(pool: Queryable, { userId, appId, kind }: { userId: number | null; appId?: number | null; kind: string }): Promise<boolean> {
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
export function validatePreferencePatch(body: any, { allowedKeys = null }: { allowedKeys?: readonly string[] | null } = {}) {
  const details: Record<string, string[]> = {};
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
export async function writeOverrides(pool: Queryable, userId: number, appId: number | null, values: Record<string, boolean | null>): Promise<Overrides> {
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

/**
 * allowsKind for a decision made inside a transaction: an error reading the
 * preferences throws instead of failing open, because there the read has
 * already failed the transaction, and saying "allowed" would only hide why.
 */
export async function kindAllowed(pool: Queryable, { userId, appId, kind }: { userId: number | null; appId?: number | null; kind: string }): Promise<boolean> {
  if (!isGatedKind(kind)) return true;
  if (!userId) return true;
  return isKindEnabled(kind, await readOverrides(pool, userId, appId ?? null));
}
