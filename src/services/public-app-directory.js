'use strict';

// The public app-directory projection shared by the anonymous public API and
// the versioned app-facing API. Keeping the query and serializer here means a
// hosted app cannot see a different visibility set, contributor definition,
// or field shape from the directory people see on Homeroom itself.

const { productionHostname } = require('./caddy');
const { loadContributors, shapeContributor } = require('./contributors');
const { APP_CATEGORIES } = require('./app-manifest');
const { signinEnabled } = require('./edge-gate');

// Apps that do not currently have a usable deployment never appear in the
// public directory. View-private and self-hosted rows are filtered in SQL too.
const HIDDEN_APP_STATUSES = ['error', 'creating', 'awaiting_secrets'];

// dapp.json's one-line description, as the guest Discover card shows it.
// Longer text is the project's own business; the card has two lines.
const DESCRIPTION_MAX = 200;

// The same rule as listPublicApps' WHERE clause, for a single app row that
// carries self_hosted, moderation_suspended_at, view_visibility and status.
// A per-slug public read uses it so it answers for exactly the apps the
// directory lists, and no others.
function isPublicDirectoryApp(app) {
  return Boolean(app)
    && !app.self_hosted
    && app.moderation_suspended_at == null
    && app.view_visibility === 'public'
    && !HIDDEN_APP_STATUSES.includes(app.status);
}

// Whether a visitor with no account can use the app, read off the two
// probes (services/shell-probe.js). An app that answers a visitor with no
// credential at all works for anyone. Where the app-host sign-in half is on,
// every public app also has guests (services/edge-gate.js, "Guests (P15)"),
// so an app that answers a guest's token works too. Anything not positively
// classified fails safe to "needs an account".
function guestReady(row, guestsOn = signinEnabled()) {
  if (row.anon_shell === 'public') return true;
  return Boolean(guestsOn) && row.guest_shell === 'public';
}

function descriptionOf(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : text;
}

// A change's title as a visitor with no account may read it: what its pull
// request is called, unless that is the placeholder a change wears before
// anyone names it, "<username>'s changes" (services/pr-metadata.js), which
// would put a person's name on a page that shows none.
const PLACEHOLDER_TITLE = /^.+'s changes$/;
const CHANGE_TITLE_MAX = 120;

function publicChangeTitle(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || PLACEHOLDER_TITLE.test(text)) return null;
  return text.length > CHANGE_TITLE_MAX ? `${text.slice(0, CHANGE_TITLE_MAX - 1).trimEnd()}…` : text;
}

function categoryOf(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return APP_CATEGORIES.includes(key) ? key : null;
}

function shapeApp(app, contributorRows, includeWallets) {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    status: app.status,
    collab_visibility: app.collab_visibility,
    view_visibility: app.view_visibility,
    created_at: app.created_at,
    last_deploy_at: app.last_deploy_at,
    // Home-card presentation fields. The icon path is relative to the
    // platform origin; app servers also receive USERNODE_PLATFORM_ORIGIN.
    icon_emoji: app.icon_emoji || null,
    icon_url: app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
    active_users: parseInt(app.active_users, 10) || 0,
    // Anything not positively classified public fails safe to login-gated.
    requires_login: app.anon_shell !== 'public',
    // Use the returned URL rather than reconstructing a host from the slug.
    url: `https://${productionHostname(app.slug)}`,
    contributors: (contributorRows || []).map((row) =>
      shapeContributor(row, includeWallets)
    ),
    // The guest Discover's card (frontend/src/features/guest): what the
    // project says it is, the kind of app it is, whether the platform
    // features it, its colour and the picture its group chose for its card,
    // how many people are in its community and how many of its changes are
    // up for a vote, how many of its changes the group voted in and the
    // last of them. Everything here is what a signed-in non-member already
    // reads on Discover and the project's own pages.
    description: descriptionOf(app.description),
    category: categoryOf(app.category),
    featured: Boolean(app.featured),
    featured_order: app.featured_order == null ? null : Number(app.featured_order),
    icon_color: app.icon_color || null,
    illustration_url: app.illustration_id ? `/app-illustrations/${app.illustration_id}` : null,
    illustration_dark_url: app.illustration_id && app.illustration_dark_id
      ? `/app-illustrations/${app.illustration_dark_id}` : null,
    member_count: parseInt(app.member_count, 10) || 0,
    open_votes: parseInt(app.open_votes, 10) || 0,
    merged_count: parseInt(app.merged_count, 10) || 0,
    // How many of them went live in the last seven days: what a card says
    // instead of a count too small to read as busy.
    merged_week: parseInt(app.merged_week, 10) || 0,
    last_merged_at: app.last_merged_at || null,
    latest_change: publicChangeTitle(app.latest_change_title),
    // Whether "Try it" can open the app for somebody with no account
    // (guestReady). `requires_login` above keeps its own meaning: no
    // credential of any kind.
    guest_ready: guestReady(app),
  };
}

async function listPublicApps(pool, { includeWallets = true, slug = null } = {}) {
  // The active-users join mirrors the authed home list's sticky 10-day rule:
  // a user counts iff they ever spent >= 60s on the app on a single day AND
  // visited within 10 days. One query returns one row per app. `slug`
  // narrows it to one app (the guest project page's overview), under the
  // same WHERE clause as the list.
  const { rows: apps } = await pool.query(
    `SELECT a.id, a.name, a.slug, a.status, a.collab_visibility,
              a.view_visibility, a.created_at, a.last_deploy_at,
              a.icon_emoji, a.icon_image_id, a.icon_color, a.anon_shell, a.guest_shell,
              a.manifest_snapshot->>'description' AS description,
              a.manifest_snapshot->>'category' AS category,
              (fa.app_id IS NOT NULL) AS featured, fa.sort_order AS featured_order,
              CASE WHEN a.featured_illustration IS NOT NULL THEN ill.id END AS illustration_id,
              CASE WHEN a.featured_illustration IS NOT NULL THEN ill.dark_id END AS illustration_dark_id,
              COALESCE(cmc.cnt, 0) AS member_count,
              COALESCE(dev.open_votes, 0) AS open_votes,
              COALESCE(dev.merged_count, 0) AS merged_count,
              COALESCE(dev.merged_week, 0) AS merged_week,
              dev.last_merged_at, lc.title AS latest_change_title,
              COALESCE(au.cnt, 0) AS active_users
         FROM apps a
         LEFT JOIN (
           SELECT a1.app_id, COUNT(DISTINCT a1.user_id) AS cnt
           FROM app_activity a1
           WHERE a1.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity a2
               WHERE a2.app_id = a1.app_id
                 AND a2.user_id = a1.user_id
                 AND a2.seconds_spent >= 60
             )
           GROUP BY a1.app_id
         ) au ON au.app_id = a.id
         LEFT JOIN featured_apps fa ON fa.app_id = a.id
         LEFT JOIN app_illustrations ill ON ill.app_id = a.id
         LEFT JOIN (
           SELECT community_id, COUNT(*) AS cnt FROM community_members GROUP BY community_id
         ) cmc ON cmc.community_id = a.community_id
         LEFT JOIN (
           SELECT app_id,
                  COUNT(*) FILTER (WHERE status IN ('promoted', 'merging')) AS open_votes,
                  COUNT(*) FILTER (WHERE status = 'merged' AND live_at IS NOT NULL) AS merged_count,
                  COUNT(*) FILTER (WHERE status = 'merged' AND live_at IS NOT NULL
                                     AND COALESCE(merged_at, created_at) >= NOW() - INTERVAL '7 days') AS merged_week,
                  MAX(COALESCE(merged_at, created_at)) FILTER (WHERE status = 'merged' AND live_at IS NOT NULL)
                    AS last_merged_at
             FROM chat_sessions
            GROUP BY app_id
         ) dev ON dev.app_id = a.id
         LEFT JOIN LATERAL (
           SELECT COALESCE(cs.pr_title, cs.session_title) AS title
             FROM chat_sessions cs
            WHERE cs.app_id = a.id AND cs.status = 'merged' AND cs.live_at IS NOT NULL
            ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
            LIMIT 1
         ) lc ON TRUE
        WHERE NOT a.self_hosted
          AND a.moderation_suspended_at IS NULL
          AND a.view_visibility = 'public'
          AND a.status <> ALL($1::text[])
          AND ($2::text IS NULL OR a.slug = $2)
        ORDER BY COALESCE(au.cnt, 0) DESC,
                 a.last_deploy_at DESC NULLS LAST, a.created_at DESC`,
    [HIDDEN_APP_STATUSES, slug]
  );

  const byApp = await loadContributors(pool, apps.map((app) => app.id));

  return apps.map((app) => shapeApp(app, byApp.get(app.id), includeWallets));
}

module.exports = {
  listPublicApps,
  isPublicDirectoryApp,
  guestReady,
  descriptionOf,
  publicChangeTitle,
  HIDDEN_APP_STATUSES,
};
