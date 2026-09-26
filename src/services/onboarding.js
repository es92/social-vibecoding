'use strict';

/**
 * Communities, stage 5: a new account's first run.
 *
 *   sign in → username → terms → "What communities do you want to join?"
 *           → the tour → Home, with a Getting started card on top.
 *
 * The first two steps were already there (frontend/src/features/auth/
 * username-first-run.js, frontend/src/features/settings/terms-first-run.js).
 * This module is the server half of the other two: which communities the
 * join screen offers and what answering it does, and the three first steps
 * the card on Home ticks off.
 *
 * ── Who is asked ────────────────────────────────────────────────────────
 *
 * `users.needs_communities_choice`, set TRUE wherever an account is made by
 * a person signing up (email, an activation code, a wallet) and FALSE for
 * everyone else, including every account that existed before the column and
 * every account the boot seeds: the join screen is for newcomers,
 * and a member who has been here a year has already found their
 * communities. See the note beside the column in src/db/schema.sql.
 *
 * ── What the screen offers ─────────────────────────────────────────────
 *
 * Homeroom first: the platform's own project, where the platform itself is
 * built. A new account with platform access is already in it (the
 * users_join_platform_community trigger), so it arrives ticked; unticking it
 * is how a newcomer says "not this one", and answering leaves it. Then any
 * group the person has been invited into, which is the reason somebody
 * signs up more often than not. Then the communities an admin has featured
 * (featured_apps, in its order: the same curated set Discover leads with),
 * and after them the open communities with the most members. Solo projects
 * and view-private apps are never offered: nobody can join those from
 * outside.
 *
 * "Skip for now" is an answer too: it joins and leaves nothing, and the
 * screen does not come back. Discover is where to join later.
 *
 * ── The card ───────────────────────────────────────────────────────────
 *
 * Three steps in ONE community, the first one the person joined on that
 * screen (or Homeroom when that is all they picked), each of which ticks
 * off from something the person actually did rather than from a checkbox:
 *
 *   say-hi   a message of theirs in its chat;
 *   vote     a vote of theirs on a change or a request, or, when nothing
 *            there is waiting on one, a visit to the Workshop;
 *   explore  a visit to the app (app_activity), or for Homeroom, which has
 *            no app of its own to open, joining a second community or a
 *            visit to Discover.
 *
 * The two visits leave no row of their own, so the card records them
 * (`users.getting_started_seen`) while it is showing, and only then.
 */

const communities = require('./communities');

// How many communities the join screen lists. Homeroom and the invites come
// first, so this is the room left for the open communities.
const SUGGESTION_LIMIT = 8;
// The most the screen can join in one answer. It lists eight; the cap is
// only there so the endpoint is not a bulk-join API.
const MAX_JOIN = 20;
// The two visits the card records.
const SEEN_KEYS = new Set(['workshop', 'discover']);

function iconUrl(row) {
  return row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null;
}

// The longest description the join screen shows under a name: two lines on
// a phone. dapp.json's own field has no limit of its own.
const DETAIL_MAX = 100;

// A few words for the communities people are most likely to be offered,
// until each says what it is itself. When this was written none of the live
// apps' dapp.json had a `description`, so the join screen would have been a
// column of bare names. Keyed by slug, which a rename leaves alone (Game
// Corner is still puzzlechain-6cf8ff). A community's own line always wins:
// once its dapp.json says something, its entry here is never read, and can
// be dropped.
const STARTER_DETAILS = Object.freeze({
  'puzzlechain-6cf8ff': 'Daily puzzles and games',
  'mypage-777ed2': 'Decorate your own page',
  'community-tier-lists-57ce6a': 'Rank anything together',
  'recipebot-33b169': 'AI recipe helper',
  'todo-list-b91765': 'Shared to-do lists',
  'supply-line-rts-6408b2': 'Slow-paced strategy game',
  'gym-tracker-9de81f': 'Log your workouts',
});

// What the join screen says under a community's name. Homeroom says what
// joining it means; an invite says who sent it; anything else says what it
// is, in its own words: dapp.json's top-level `description`, the line
// Homeroom's About pane already shows (routes/platform-about.js), which a
// community sets and changes by a voted change like any other line there.
// Without one, its starter line if it has one, else nothing at all.
// "Community · N members" was the same words on every row, and the count
// said little about what the thing is.
function suggestionDetail(row) {
  if (row.self_hosted) return 'Contribute to the Homeroom platform';
  if (row.invited_by) return `Invited by @${row.invited_by}`;
  const own = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim() : '';
  const text = own || STARTER_DETAILS[row.slug] || '';
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1).trimEnd()}…` : text;
}

/**
 * The communities the join screen lists, in its order. `showSelfHosted` is
 * the same rule every listing of the platform's own row applies (admins, or
 * the deployment's selfAppPublicVoting): where Homeroom is not listed
 * anywhere else, it is not offered here either.
 */
async function joinSuggestions(pool, userId, { showSelfHosted = false } = {}) {
  const members = '(SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = a.community_id)';
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.icon_emoji, a.icon_image_id, a.self_hosted,
            ${members}::int AS member_count,
            ${communities.audienceSql('a', members)} AS audience,
            EXISTS (SELECT 1 FROM community_members me
                     WHERE me.community_id = a.community_id AND me.user_id = $1) AS is_member,
            a.manifest_snapshot->>'description' AS description,
            inv.invited_by
       FROM apps a
       LEFT JOIN (
         SELECT c.app_id, u.username AS invited_by
           FROM app_collaborators c
           LEFT JOIN users u ON u.id = c.invited_by
          WHERE c.user_id = $1 AND c.status = 'invited'
       ) inv ON inv.app_id = a.id
       LEFT JOIN featured_apps fa ON fa.app_id = a.id
      WHERE a.community_id IS NOT NULL
        AND (
          (a.self_hosted AND $2::boolean)
          OR (NOT a.self_hosted AND inv.app_id IS NOT NULL)
          OR (NOT a.self_hosted AND a.status = 'running' AND a.view_visibility = 'public')
        )
      ORDER BY a.self_hosted DESC, (inv.app_id IS NOT NULL) DESC,
               (fa.app_id IS NOT NULL) DESC, fa.sort_order ASC NULLS LAST,
               member_count DESC, a.id ASC
      LIMIT $3`,
    [userId, !!showSelfHosted, SUGGESTION_LIMIT]
  );
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    icon_url: iconUrl(row),
    icon_emoji: row.icon_emoji || null,
    self_hosted: !!row.self_hosted,
    audience: row.audience,
    member_count: Number(row.member_count) || 0,
    invited_by: row.invited_by || null,
    is_member: !!row.is_member,
    detail: suggestionDetail(row),
    // Ticked on arrival: what the person is already in (Homeroom, for any
    // account with platform access) and what they were invited into.
    checked: !!row.is_member || !!row.invited_by,
  }));
}

function parseJoin(raw) {
  if (!Array.isArray(raw)) return { error: 'join must be a list of project slugs' };
  const slugs = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) return { error: 'join must be a list of project slugs' };
    if (!slugs.includes(entry.trim())) slugs.push(entry.trim());
  }
  if (slugs.length > MAX_JOIN) return { error: `Pick at most ${MAX_JOIN}.` };
  return { slugs };
}

/**
 * Answer the join screen: join what was ticked, leave Homeroom if it was
 * unticked, and record the answer. Only what the screen could have offered
 * is honoured — an open community, an invite (accepted through the same
 * function the notification's Accept uses), Homeroom — and anything else in
 * the list is skipped rather than refused, because a community that closed
 * between the screen loading and the answer is not the person's mistake.
 *
 * `acceptInvite(appId)` is injected: the invite path lives with the
 * collaborator routes (services/collab-invites.js) and needs the caller.
 *
 * `{ skip: true }` is "Skip for now": the answer is recorded and nothing is
 * joined or left.
 *
 * Returns `{ ok, joined: [slug], left: [slug] }`, or `{ ok: false, status,
 * error }`. A second answer is a 409 with `alreadyDone`, like the username
 * step's.
 */
async function answerJoin(pool, user, body, { showSelfHosted = false, acceptInvite } = {}) {
  const skip = !!(body && body.skip === true);
  const parsed = skip ? { slugs: [] } : parseJoin(body && body.join);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };

  const { rows: flag } = await pool.query(
    'SELECT needs_communities_choice FROM users WHERE id = $1', [user.id]);
  if (!flag[0] || flag[0].needs_communities_choice !== true) {
    return { ok: false, status: 409, error: 'You have already picked your communities.', alreadyDone: true };
  }

  const offered = await joinSuggestions(pool, user.id, { showSelfHosted });
  const bySlug = new Map(offered.map((c) => [c.slug, c]));
  // A community can be answered for that fell off the first eight (it was
  // listed when the screen loaded, and a new one has since overtaken it),
  // so an open community is re-checked on its own rather than only by
  // membership of the list.
  const { rows: found } = parsed.slugs.length ? await pool.query(
    `SELECT id, slug, name, community_id, created_by, self_hosted, status, view_visibility, collab_visibility
       FROM apps WHERE slug = ANY($1::text[])`,
    [parsed.slugs]
  ) : { rows: [] };

  // In the order the screen listed them: the first one joined is the one the
  // Getting started card is about (focusCommunity reads joined_at).
  found.sort((a, b) => parsed.slugs.indexOf(a.slug) - parsed.slugs.indexOf(b.slug));
  const joined = [];
  const left = [];
  for (const app of found) {
    if (app.community_id == null) continue;
    const listed = bySlug.get(app.slug);
    if (app.self_hosted) {
      if (!showSelfHosted) continue;
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    } else if (listed && listed.invited_by && typeof acceptInvite === 'function') {
      const result = await acceptInvite(app);
      if (result && result.ok) joined.push(app.slug);
    } else if (app.status === 'running' && app.view_visibility === 'public') {
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    }
  }

  // Homeroom unticked: the person is in it by default, and this screen is
  // where they said no.
  // Not on a skip: "not now" leaves everything as it was, Homeroom included.
  const self = offered.find((c) => c.self_hosted);
  if (!skip && self && self.is_member && !parsed.slugs.includes(self.slug)) {
    const { rows: selfRows } = await pool.query(
      'SELECT id, slug, created_by FROM apps WHERE slug = $1', [self.slug]);
    if (selfRows[0]) {
      const result = await communities.leave(pool, selfRows[0], user.id);
      if (result.ok) left.push(self.slug);
    }
  }

  await pool.query(
    `UPDATE users
        SET needs_communities_choice = FALSE, communities_onboarded_at = NOW()
      WHERE id = $1 AND needs_communities_choice = TRUE`,
    [user.id]
  );
  return { ok: true, joined, left };
}

/**
 * The one community the card's three steps are about: the first the person
 * joined on the join screen, else the first they joined at all, else
 * Homeroom. Their own projects are not it: "say hi" in something you
 * started alone is not a first step.
 */
async function focusCommunity(pool, userId, { showSelfHosted = false } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.self_hosted
       FROM community_members m
       JOIN apps a ON a.community_id = m.community_id
      WHERE m.user_id = $1
        AND (a.created_by IS NULL OR a.created_by <> $1)
        AND (NOT a.self_hosted OR $2::boolean)
      ORDER BY a.self_hosted ASC,
               (m.source IN ('joined', 'collaborator')) DESC,
               m.joined_at ASC, a.id ASC
      LIMIT 1`,
    [userId, !!showSelfHosted]
  );
  return rows[0] || null;
}

/**
 * The card: `{ show, community, steps, done, total }`. `show` is false once
 * the card is closed, and for an account that never came through the join
 * screen; the client draws nothing then.
 */
async function gettingStarted(pool, userId, { showSelfHosted = false } = {}) {
  const { rows: userRows } = await pool.query(
    `SELECT communities_onboarded_at, getting_started_closed_at, getting_started_seen
       FROM users WHERE id = $1`,
    [userId]
  );
  const u = userRows[0];
  const show = !!(u && u.communities_onboarded_at && !u.getting_started_closed_at);
  const seen = (u && u.getting_started_seen && typeof u.getting_started_seen === 'object')
    ? u.getting_started_seen : {};
  const focus = await focusCommunity(pool, userId, { showSelfHosted });
  const appId = focus ? focus.id : null;

  const { rows: facts } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM chat_messages m
                WHERE m.app_id = $2 AND m.user_id = $1
                  AND m.msg_type = 'message' AND m.deleted_at IS NULL) AS said_hi,
       (EXISTS (SELECT 1 FROM pr_votes v WHERE v.user_id = $1)
        OR EXISTS (SELECT 1 FROM issue_votes v WHERE v.user_id = $1)) AS voted,
       (SELECT COUNT(*)::int FROM chat_sessions cs
         WHERE cs.app_id = $2 AND cs.status = 'promoted'
           AND NOT EXISTS (SELECT 1 FROM pr_votes v
                            WHERE v.session_id = cs.id AND v.user_id = $1)) AS waiting,
       EXISTS (SELECT 1 FROM app_activity x WHERE x.app_id = $2 AND x.user_id = $1) AS opened,
       EXISTS (SELECT 1 FROM community_members m JOIN apps a ON a.community_id = m.community_id
                WHERE m.user_id = $1 AND NOT a.self_hosted) AS in_another`,
    [userId, appId]
  );
  const f = facts[0] || {};
  const name = focus ? focus.name : 'Homeroom';
  const slug = focus ? focus.slug : null;
  const waiting = Number(f.waiting) || 0;

  const steps = [
    {
      id: 'say-hi',
      title: `Say hi in ${name}`,
      detail: 'Post in its chat.',
      done: !!f.said_hi,
      href: slug ? `#messages/app/${encodeURIComponent(slug)}` : '#messages',
    },
    waiting > 0
      ? {
        id: 'vote',
        title: 'Vote on what needs you',
        detail: `${waiting} waiting in ${name}`,
        done: !!f.voted,
        href: '#workshop',
      }
      : {
        id: 'vote',
        title: 'Look around the Workshop',
        detail: 'See what people are building.',
        done: !!f.voted || !!seen.workshop,
        href: '#workshop',
      },
    focus && !focus.self_hosted
      ? {
        id: 'explore',
        title: `Open ${name} and try it`,
        detail: 'Changes voted in ship here.',
        done: !!f.opened,
        href: null,
        slug,
      }
      : {
        id: 'explore',
        title: 'Find another community',
        detail: 'Join one in Discover.',
        done: !!f.in_another || !!seen.discover,
        href: '#apps',
      },
  ];
  return {
    show,
    community: focus ? { slug: focus.slug, name: focus.name, self_hosted: !!focus.self_hosted } : null,
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
  };
}

/** Record a visit the card asked for. Only while the card is showing. */
async function markSeen(pool, userId, what) {
  if (!SEEN_KEYS.has(what)) return { ok: false, status: 400, error: 'Unknown step' };
  await pool.query(
    `UPDATE users
        SET getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object($2::text, NOW())
      WHERE id = $1
        AND communities_onboarded_at IS NOT NULL
        AND getting_started_closed_at IS NULL`,
    [userId, what]
  );
  return { ok: true };
}

/**
 * An admin's "Reset first run" (Admin → Users → ⋯): put an account back to a
 * new account's first run, so its next load shows the join screen, then the
 * tour (communities-first-run.js restarts it in the browser that shows the
 * screen, because "done" is kept per browser), then the Getting started card.
 *
 * It resets the first run and nothing the account owns: its communities,
 * Home tiles, username and terms answer stay as they are. The join screen
 * shows what it is already in, ticked. Returns `{ id, username }`, or null
 * when there is no such account.
 */
async function resetFirstRun(pool, userId) {
  const { rows } = await pool.query(
    `UPDATE users
        SET needs_communities_choice = TRUE,
            communities_onboarded_at = NULL,
            getting_started_closed_at = NULL,
            getting_started_seen = NULL
      WHERE id = $1
      RETURNING id, username`,
    [userId]
  );
  return rows[0] || null;
}

/** The card's close button. */
async function closeCard(pool, userId) {
  await pool.query(
    `UPDATE users SET getting_started_closed_at = NOW()
      WHERE id = $1 AND getting_started_closed_at IS NULL`,
    [userId]
  );
  return { ok: true };
}

module.exports = {
  SUGGESTION_LIMIT,
  MAX_JOIN,
  STARTER_DETAILS,
  joinSuggestions,
  suggestionDetail,
  parseJoin,
  answerJoin,
  focusCommunity,
  gettingStarted,
  markSeen,
  closeCard,
  resetFirstRun,
};
