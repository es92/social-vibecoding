'use strict';

// THE COMMUNITIES A PERSON PINNED (One Home, #6361): the "Pinned" group of
// the Communities tab's page, the account's, in their order (schema:
// one-home-pins.sql, home_community_pins). They were Home's "Pinned
// communities" grid until the Communities tab came back; the table and the
// routes keep the name.
//
// Separate from two neighbours on purpose:
//   - app_favorites is Home's "Pinned apps": an app pin opens the app.
//   - community_pins is the desktop sidebar's four (services/community-pins.js),
//     a member's only.
// A community pin here needs no membership: a person can follow a community
// before joining it, signed in or (on the device) signed out.
// Joining writes one (communities.join), leaving removes it
// (communities.leave), and its app's pin stays either way.

const appAccess = require('./app-access');

/** A sane ceiling on one account's list, not a product limit. */
const PINS_MAX = 200;

const fail = (status, body) => { throw Object.assign(new Error(body.error), { status, body }); };

/** The pins, in order, as the Communities page draws them. */
async function list(db, userId) {
  const { rows } = await db.query(
    `SELECT slug, name, icon_image_id, icon_emoji, icon_color, is_member FROM (
       SELECT DISTINCT ON (p.community_id) p.position, p.pinned_at,
              a.slug, a.name, a.icon_image_id, a.icon_emoji, a.icon_color,
              EXISTS (SELECT 1 FROM community_members m
                       WHERE m.community_id = p.community_id AND m.user_id = p.user_id) AS is_member
         FROM home_community_pins p
         JOIN apps a ON a.community_id = p.community_id
        WHERE p.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = p.user_id AND b.app_id = a.id)
          -- A pin made while a project was public says nothing of it once it
          -- is private to people its viewer is not among; it comes back if
          -- it opens again. A member always sees their own.
          AND a.moderation_suspended_at IS NULL
          AND (a.view_visibility = 'public'
               OR EXISTS (SELECT 1 FROM community_members m
                           WHERE m.community_id = p.community_id AND m.user_id = p.user_id))
        ORDER BY p.community_id, a.id
     ) pins
     ORDER BY position, pinned_at`,
    [userId]
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name || r.slug,
    iconUrl: r.icon_image_id ? `/app-icons/${r.icon_image_id}` : null,
    iconEmoji: r.icon_emoji || null,
    iconColor: r.icon_color || null,
    member: !!r.is_member,
  }));
}

async function findApp(db, user, slug) {
  const { rows } = await db.query(
    `SELECT ${appAccess.ACCESS_COLUMNS}, name, community_id FROM apps WHERE slug = $1`,
    [slug]
  );
  const app = rows[0];
  if (!app || !app.community_id || !(await appAccess.checkAppAccess(db, app, user, 'view'))) return null;
  return app;
}

/** Pin `communityId` for `userId` at the end of their list. Idempotent. */
async function pinCommunity(db, communityId, userId) {
  await db.query(
    `INSERT INTO home_community_pins (community_id, user_id, position)
     SELECT $1, $2, COALESCE(MAX(position) + 1, 0) FROM home_community_pins WHERE user_id = $2
     ON CONFLICT (user_id, community_id) DO NOTHING`,
    [communityId, userId]
  );
}

async function addPin(db, user, slug) {
  const app = await findApp(db, user, slug);
  if (!app) fail(404, { error: 'Community not found' });
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM home_community_pins WHERE user_id = $1', [user.id]);
  if (rows[0].n >= PINS_MAX) fail(409, { error: 'Unpin one first.', code: 'pins_full' });
  await pinCommunity(db, app.community_id, user.id);
}

async function locked(pool, user, change) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    await change(db);
    const pins = await list(db, user.id);
    await db.query('COMMIT');
    return pins;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Pin the community of the project `slug` to Home. Returns the pins. */
function pin(pool, user, slug) {
  return locked(pool, user, (db) => addPin(db, user, slug));
}

/** Unpin it. Always allowed; membership is untouched. Returns the pins. */
function unpin(pool, user, slug) {
  return locked(pool, user, (db) => db.query(
    `DELETE FROM home_community_pins p USING apps a
      WHERE p.user_id = $1 AND a.slug = $2 AND p.community_id = a.community_id`,
    [user.id, slug]
  ));
}

/** Put the pins in this order (slugs); any not named keep their place after them. */
function reorder(pool, user, slugs) {
  const wanted = (Array.isArray(slugs) ? slugs : []).filter((s) => typeof s === 'string' && s).slice(0, PINS_MAX);
  return locked(pool, user, async (db) => {
    const { rows } = await db.query(
      `SELECT p.community_id, a.slug FROM home_community_pins p
         JOIN apps a ON a.community_id = p.community_id
        WHERE p.user_id = $1
        ORDER BY p.position, p.pinned_at`,
      [user.id]
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r.community_id]));
    const order = [...new Set([...wanted.filter((s) => bySlug.has(s)).map((s) => bySlug.get(s)),
      ...rows.map((r) => r.community_id)])];
    for (let i = 0; i < order.length; i++) {
      await db.query('UPDATE home_community_pins SET position = $3 WHERE user_id = $1 AND community_id = $2',
        [user.id, order[i], i]);
    }
  });
}

/**
 * Take in the pins a device kept while signed out, once, at sign-in. A slug
 * that is gone or no longer visible is skipped quietly; the rest go at the
 * end, in the device's order. Returns the pins.
 */
function importPins(pool, user, slugs) {
  const wanted = (Array.isArray(slugs) ? slugs : []).filter((s) => typeof s === 'string' && s).slice(0, 50);
  return locked(pool, user, async (db) => {
    for (const slug of wanted) {
      try {
        await addPin(db, user, slug);
      } catch (err) {
        if (!err.status) throw err;
      }
    }
  });
}

/** How many faces a community's card shows. */
const ACTIVITY_FACES = 3;

/**
 * WHAT IS GOING ON IN EACH OF A PERSON'S COMMUNITIES (Drea's review of
 * #6699): the facts the Communities page's cards print under each name, for
 * every community `list` returns and every other one the viewer is a member
 * of (the page's Pinned and Joined groups), in one read:
 *   members      how many are in it (community_members, as the app list
 *                counts them);
 *   live_week    changes that went live in the last seven days (merged and
 *                running in production, as the public directory counts
 *                `merged_week`);
 *   active_week  people who took part in the last seven days: said
 *                something in its channel, started a change or voted, the
 *                same three kinds of taking part, over the same week and
 *                people only, as the hub's "40 active this week"
 *                (communities.activitySummary);
 *   people       up to ACTIVITY_FACES of them, the most recently active
 *                first, each with their picture when they have one.
 * The pinned ones are those `list` shows (the same filters, written out
 * again so the query stays one static statement), and a membership is the
 * viewer's own, so this never says anything about a community the viewer
 * cannot see. Keyed by slug.
 */
async function activity(db, userId) {
  const { rows } = await db.query(
    `WITH pins AS (
       SELECT DISTINCT ON (c.community_id) c.community_id, a.id AS app_id, a.slug
         FROM (
           SELECT p.community_id FROM home_community_pins p WHERE p.user_id = $1
           UNION
           SELECT m.community_id FROM community_members m WHERE m.user_id = $1
         ) c
         JOIN apps a ON a.community_id = c.community_id
        WHERE NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = $1 AND b.app_id = a.id)
          AND a.moderation_suspended_at IS NULL
          AND (a.view_visibility = 'public'
               OR EXISTS (SELECT 1 FROM community_members m
                           WHERE m.community_id = c.community_id AND m.user_id = $1))
        ORDER BY c.community_id, a.id
     ),
     who AS (
       SELECT m.app_id, m.user_id, m.created_at AS at
         FROM chat_messages m JOIN pins ON pins.app_id = m.app_id
        WHERE m.user_id IS NOT NULL AND m.created_at > NOW() - INTERVAL '7 days'
       UNION ALL
       SELECT s.app_id, s.user_id, s.created_at
         FROM chat_sessions s JOIN pins ON pins.app_id = s.app_id
        WHERE s.user_id IS NOT NULL AND s.created_at > NOW() - INTERVAL '7 days'
       UNION ALL
       SELECT s.app_id, v.user_id, v.created_at
         FROM pr_votes v
         JOIN chat_sessions s ON s.id = v.session_id
         JOIN pins ON pins.app_id = s.app_id
        WHERE v.user_id IS NOT NULL AND v.created_at > NOW() - INTERVAL '7 days'
     ),
     people AS (
       SELECT who.app_id, u.id, u.username, av.id AS avatar_id,
              ROW_NUMBER() OVER (PARTITION BY who.app_id ORDER BY MAX(who.at) DESC, u.id) AS rn,
              COUNT(*) OVER (PARTITION BY who.app_id) AS active_week
         FROM who
         JOIN users u ON u.id = who.user_id AND u.is_synthetic IS NOT TRUE
         LEFT JOIN user_avatars av ON av.user_id = u.id
        GROUP BY who.app_id, u.id, u.username, av.id
     )
     SELECT pins.slug,
            (SELECT COUNT(*)::int FROM community_members cm
              WHERE cm.community_id = pins.community_id) AS members,
            (SELECT COUNT(*)::int FROM chat_sessions s
              WHERE s.app_id = pins.app_id AND s.status = 'merged' AND s.live_at IS NOT NULL
                AND COALESCE(s.merged_at, s.created_at) >= NOW() - INTERVAL '7 days') AS live_week,
            COALESCE((SELECT MAX(pp.active_week)::int FROM people pp WHERE pp.app_id = pins.app_id), 0) AS active_week,
            COALESCE((SELECT json_agg(json_build_object('username', pp.username, 'avatar_id', pp.avatar_id) ORDER BY pp.rn)
                        FROM people pp WHERE pp.app_id = pins.app_id AND pp.rn <= $2), '[]'::json) AS people
       FROM pins`,
    [userId, ACTIVITY_FACES]
  );
  const out = {};
  for (const r of rows) {
    out[r.slug] = {
      members: Number(r.members) || 0,
      liveWeek: Number(r.live_week) || 0,
      activeWeek: Number(r.active_week) || 0,
      people: (Array.isArray(r.people) ? r.people : []).map((p) => ({
        username: p.username,
        avatarUrl: p.avatar_id ? `/avatars/${p.avatar_id}` : null,
      })),
    };
  }
  return out;
}

module.exports = { PINS_MAX, ACTIVITY_FACES, list, activity, pin, unpin, reorder, importPins, pinCommunity };
