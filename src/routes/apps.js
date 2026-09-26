const appAllowance = require('../services/app-allowance');
const platformLimits = require('../services/platform-limit-alerts');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { createApp } = require('../services/app-creator');
const { forkApp, findForkSource } = require('../services/app-forker');
const caddy = require('../services/caddy');
const docker = require('../services/docker');
const github = require('../services/github');
const driftPoller = require('../services/main-drift-poller');
const appSecrets = require('../services/app-secrets');
const platformEnv = require('../services/platform-env');
const pendingSecrets = require('../services/pending-secrets');
const appManifest = require('../services/app-manifest');
const { ADMIN_MUTATION_LOCK } = require('../services/advisory-locks');
const renamePr = require('../services/rename-pr');
const staging = require('../services/staging');
const { drainGuard } = require('../services/lifecycle');
const deployFailure = require('../services/deploy-failure');
const { appCreateLimiter, appAllowanceRequestLimiter, issueCreateLimiter, githubLookupLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const approverInvites = require('../services/approver-invites');
const contributors = require('../services/contributors');
const discoveryCuration = require('../services/discovery-curation');
const communities = require('../services/communities');
const governance = require('../services/governance');
const activeUsers = require('../services/active-users');
const createOptions = require('../services/create-options');
const collabInvites = require('../services/collab-invites');

// Cap on the `initialApprovers` list a governance-pr request may carry
// (see that route below) — a sanity bound, not a product limit.
const MAX_INITIAL_APPROVERS = 20;

// Validate a (collabVisibility, viewVisibility) pair against the
// invariants (see schema.sql): both must be public|private, and
// collab-public implies view-public. Returns an error string or null.
// The rule lives in services/create-options.js, which the create route's
// audience parsing shares.
const validateVisibilityCombo = createOptions.visibilityComboError;

// A source must have finished the durable parts of provisioning before a
// fork can take a database/repository snapshot. `awaiting_secrets` is safe:
// its DB and repo are complete and only private deploy input is missing.
// Keeping this as a shared message builder lets both initial fork and Retry
// reject the known race before creating another async failure row.
function forkSourceReadinessError(sourceApp) {
  if (!sourceApp) return 'The source app for this fork no longer exists.';
  if (sourceApp.self_hosted) return 'The platform app cannot be forked.';
  if (sourceApp.status === 'creating') {
    return 'This app is still being set up. Try forking it again once it is ready.';
  }
  if (sourceApp.status === 'error') {
    return 'This app cannot be forked until its setup error is fixed.';
  }
  if (!['running', 'awaiting_secrets'].includes(sourceApp.status)) {
    return 'This app is not ready to fork yet.';
  }
  if (!sourceApp.repo_url) {
    return 'This app is not ready to fork yet because its repository is still being prepared.';
  }
  return null;
}

// Resolve fork lineage for a batch of serialized app objects IN PLACE.
// The stored `apps.forked_from` column holds a REFERENCE ONLY
// ({ appId, slug }); the display name is looked up LIVE here so a rename
// on the source is reflected immediately and a deleted source resolves
// to the literal "<deleted>" with an inert link. One batched query
// covers the whole list (no per-row round trip). Replaces each app's
// `forked_from` with { appId, slug, name, linkable } — or null for
// non-forks / malformed refs, and for an app in demo mode, whose lineage is
// masked here rather than resolved (see below).
async function attachForkLineage(pool, apps) {
  const list = Array.isArray(apps) ? apps : [apps];
  // Demo mode (routes/demo-mode.js): the app stands in for the one it was
  // forked from, on camera, and the badge is the one tell. The lineage stays
  // on the row untouched and is back the moment demo mode goes off; only the
  // payload is quiet about it.
  const masked = (a) => !!(a && a.demo_mode);
  const ids = [];
  for (const a of list) {
    if (masked(a)) continue;
    const ref = a && a.forked_from;
    if (ref && typeof ref === 'object' && Number.isInteger(ref.appId)) {
      ids.push(ref.appId);
    }
  }
  const nameById = new Map();
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT id, name FROM apps WHERE id = ANY($1)',
      [[...new Set(ids)]]
    );
    for (const r of rows) nameById.set(r.id, r.name);
  }
  for (const a of list) {
    if (masked(a)) {
      a.forked_from = null;
      continue;
    }
    const ref = a && a.forked_from;
    if (!ref || typeof ref !== 'object') {
      if (a) a.forked_from = null;
      continue;
    }
    const appId = Number.isInteger(ref.appId) ? ref.appId : null;
    const linkable = appId != null && nameById.has(appId);
    a.forked_from = {
      appId,
      slug: typeof ref.slug === 'string' ? ref.slug : null,
      name: linkable ? nameById.get(appId) : '<deleted>',
      linkable,
    };
  }
}

// Per-viewer access flags appended to app payloads so the client can
// gate tabs / render badges without extra round-trips.
// `adminAppIds` (issue #788) is the pre-fetched set of app ids this
// viewer is a per-app admin of — batched once per request by the
// callers below via appAdmins.getAdminAppIdsForUser, because this
// helper is spread across every row of the home feed and a per-row
// query would be N round-trips. Omitting it just means "no app-admin
// rights", which is the correct fallback for an anonymous viewer.
// #2161: the platform's own row (SELF-HOSTING.md: apps.self_hosted = TRUE,
// slug = config.selfAppSlug) is a core app. Nobody deletes it from the UI,
// full admins included: tearing down the row that IS the deployment is an
// operator task, not a danger-zone click. `selfAppSlug` is the second signal
// because a staging clone's platform row may predate the self_hosted seed.
function isCoreApp(app, selfAppSlug = null) {
  if (!app) return false;
  if (app.self_hosted === true) return true;
  return !!selfAppSlug && app.slug === selfAppSlug;
}

// Why this viewer cannot delete this app right now, or null when they can.
//   'core'      — the platform's own app (see isCoreApp); blocks everyone.
//   'shared'    — the creator asked, but the app has other contributors, so
//                 no one person may destroy it (#1897, #2161).
//   'not_owner' — neither a full admin nor the creator (or the contributor
//                 count could not be established, which fails closed).
// Full admins keep their operational override on shared apps, but the DELETE
// route makes them acknowledge the other contributors explicitly.
function deleteBlockReason(app, user, contributorCount, selfAppSlug = null) {
  if (isCoreApp(app, selfAppSlug)) return 'core';
  if (user?.canAdminWrite) return null;
  if (user?.id == null || app?.created_by !== user.id) return 'not_owner';
  if (Number(contributorCount) === 1) return null;
  return Number(contributorCount) > 1 ? 'shared' : 'not_owner';
}

function canDeleteApp(app, user, contributorCount, selfAppSlug = null) {
  return deleteBlockReason(app, user, contributorCount, selfAppSlug) === null;
}

function accessFlags(app, user, isCollaborator, adminAppIds = null, contributorCount = null,
  selfAppSlug = null) {
  const isAdmin = !!user?.isAdmin;
  // `can_collaborate` is a visibility/read affordance → stays on isAdmin
  // (view-only admins keep it). `can_manage` gates mutating management
  // controls → full-admin-or-creator (issue #311), plus the app's own
  // declared admins (issue #788), who are creator-equivalent for that
  // one app.
  const canAdminWrite = !!user?.canAdminWrite;
  const isAppAdmin = !!(adminAppIds && adminAppIds.has(app.id));
  return {
    is_collaborator: !!isCollaborator,
    can_collaborate: isAdmin || app.collab_visibility !== 'private' || !!isCollaborator,
    can_manage: canAdminWrite || (user?.id != null && app.created_by === user.id) || isAppAdmin,
    // Deletion is deliberately narrower than general app management. App
    // admins can manage settings, but only a full platform admin or the
    // creator while they remain the app's ONE contributor may destroy it.
    can_delete: canDeleteApp(app, user, contributorCount, selfAppSlug),
    // The reason can_delete is false ('core' | 'shared' | 'not_owner'), so
    // the settings dialog can say why instead of only hiding the control.
    delete_block: deleteBlockReason(app, user, contributorCount, selfAppSlug),
  };
}

// The Classic app directory intentionally carries deployment, manifest and
// curation detail for every card. Global Chat's app chooser needs a much
// smaller shape: enough to render the icon, identify the exact app, show its
// useful activity counts and derive safe follow-up actions. Keeping this an
// explicit projection avoids encrypting and sending hundreds of kilobytes of
// unrelated manifest data for a one-click direct action.
function compactGlobalChatApp(app, user, adminAppIds = new Set()) {
  const isCollaborator = !!app.is_collaborator;
  const isAppAdmin = adminAppIds.has(app.id);
  const description = typeof app.description === 'string'
    ? app.description.replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    ...(description ? { description } : {}),
    status: app.status,
    icon_emoji: app.icon_emoji || null,
    icon_url: app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
    isFavorited: !!app.is_favorited,
    isCollaborator,
    canCollaborate: !!user?.isAdmin || app.collab_visibility !== 'private' || isCollaborator,
    canManage: !!user?.canAdminWrite
      || (user?.id != null && app.created_by === user.id)
      || isAppAdmin,
    messagesLast7Days: parseInt(app.message_count, 10) || 0,
    activitySecondsLast7Days: parseInt(app.total_seconds, 10) || 0,
    activeUsers: parseInt(app.active_users, 10) || 0,
    openIssues: parseInt(app.open_issues, 10) || 0,
    openProposals: parseInt(app.open_prs, 10) || 0,
    activeDevelopment: parseInt(app.active_sessions, 10) || 0,
    createdAt: app.created_at || null,
    updatedAt: app.last_deploy_at || app.created_at || null,
  };
}

// Local-dev URL fallback ("http://localhost:<hostport>" instead of the
// real "https://<slug>.<USERNODE_DOMAIN>") is opt-in via env. Previously
// any value of DOCKER_NETWORK flipped this on, but standalone production
// also has to set DOCKER_NETWORK (to point child apps at the platform's
// network) — so DOCKER_NETWORK is no longer a clean signal. Set
// USERNODE_LOCAL_DEV=1 in your local .env to get the localhost fallback.
const IS_LOCAL_DEV = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Staging-gated (?demo=1) home-feed rows so a tester can see the new
// homescreen icon tiles (emoji / custom image / letter fallback) — the
// staging clone's real app rows predate the feature and would all
// render letter tiles. Read-only request-time injection per the
// "Staging mock data" convention: never persisted, strictly a no-op
// outside staging. The image row carries a tiny inline data-URI PNG so
// no app_icons blob needs to exist in the clone (the client renders
// whatever icon_url it's given).
const DEMO_ICON_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAAAg0lEQVR42r3NuRGAMAwEQNdFbXRAIVRHAyQwDmB4/MjS3QUbb5qn7VBKymxddl2YM1l4ZZLwmdHDb0YNSxktrGWUsJXBw14GDS0ZLLRmkHAkC4ejWSj0ZO7Qm7nCSDYcRrOhEJGZQ1RmCpFZN0RnzZCRVUNWVgyZ2S9kZ69Qkd2hKstOLPva44BQr+EAAAAASUVORK5CYII=';
// Relative ISO timestamp for the demo rows below, so their ages read the
// same however long the staging container has been up.
function demoAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function demoIconApps(curation = false) {
  const base = {
    status: 'running',
    self_hosted: false,
    locked: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    created_at: new Date().toISOString(),
    last_deploy_at: new Date().toISOString(),
    // Synthetic preview reviews, never assigned to real apps.
    main_sha: '0000000000000000000000000000000000000001',
    directory_reviewed_sha: '0000000000000000000000000000000000000001',
    directory_reviewed_at: new Date().toISOString(),
    directory_review_status: 'working',
    url: null,
    version: null,
    deployProgress: null,
    missingSecrets: null,
    active_users: 0,
    is_favorited: false,
    your_apps_hidden: false,
    favorite_order: null,
    featured: false,
    featured_order: null,
    is_collaborator: false,
    open_prs: 0,
    active_sessions: 0,
    merged_prs: 0,
    merged_prs_recent: 0,
    last_merged_at: null,
    open_issues: 0,
    // Communities (services/communities.js). Outsiders by default, like the
    // Your-apps flags above; the three rows below that set is_member are
    // the Workshop's three sections, one each, so ?demo=1 shows every
    // audience label whatever the clone's own memberships are.
    is_member: false,
    member_count: 0,
    audience: 'open',
    last_active_at: null,
    icon_emoji: null,
    icon_url: null,
    can_collaborate: false,
    can_manage: false,
    // Marks the tile inert for client gestures: these slugs don't
    // exist in the DB, so drag-to-favorite (issue #746) would 404 —
    // home.js excludes [data-demo] cards from the kit drag.
    demo: true,
  };
  const apps = [
    // "Just you" in the Workshop: a private project nobody else is in.
    {
      ...base, id: 900001, slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_emoji: '🎮',
      view_visibility: 'private', collab_visibility: 'private',
      is_member: true, member_count: 1, audience: 'solo', last_active_at: demoAgo(26),
    },
    {
      ...base,
      id: 900002,
      slug: 'staging-demo-image-icon',
      name: 'Staging demo image icon',
      icon_url: DEMO_ICON_PNG,
      // Deterministic tile for the home screen's "Find more apps" row
      // and the browse screen's featured-first ordering: featured_apps
      // is created by this change, so a prod-cloned staging DB has no
      // real rows to show there (migrate.js also seeds a few from real
      // cloned apps for the no-?demo=1 case).
      featured: true,
      featured_order: 0,
    },
    {
      ...base,
      id: 900003,
      slug: 'staging-demo-featured',
      name: 'Staging demo featured app',
      icon_emoji: '⭐',
      featured: true,
      featured_order: 1,
    },
    // A deliberately LONG name (#951). The tile label is two 11px lines
    // clamped with an ellipsis, and the only way a reviewer can see that
    // working — here and in the before/after screenshots — is a name that
    // actually overflows one line at phone width.
    {
      ...base,
      id: 900012,
      slug: 'staging-demo-long-name',
      name: 'Staging demo photo album and journal',
      icon_emoji: '📔',
      // A "Group" in the Workshop: private, and more than one person in it.
      view_visibility: 'private',
      collab_visibility: 'private',
      is_member: true,
      member_count: 4,
      audience: 'invited',
      last_active_at: demoAgo(3),
    },
    // #1838: the ONE demo row that lands in "Your apps". Every other row
    // here inherits is_favorited/is_collaborator false from `base`, so
    // Home.isYours excludes them all and the launcher grid under ?demo=1
    // holds only whatever the checks clone happens to have — which is why
    // the card-menu deep link carries a featured-row fallback at all. The
    // gesture-driven variants of that link have to dispatch onto a real
    // launcher tile, so seed one deterministically.
    //
    // favorite_order 99 sorts it LAST inside Your apps, so the existing
    // shot=home-apps / shot=home-grid expectations keep their leading tiles;
    // demo:true keeps it out of the kit's placement selector
    // (.app-card[data-yours]:not([data-demo])) so no drag shot changes.
    {
      ...base,
      id: 900013,
      slug: 'staging-demo-your-app',
      name: 'Staging demo your app',
      icon_emoji: '🏠',
      is_favorited: true,
      favorite_order: 99,
      // ...and a "Community" in the Workshop, the most recent one, so the
      // declared checks that find it there do not depend on the clone.
      is_member: true,
      member_count: 12,
      last_active_at: demoAgo(0.5),
    },
    // Four more featured rows so the Discover widget's curated lane is
    // reviewable AT ITS CAP (#949): the lane holds six tiles — one per
    // Home.FEATURED_LIMIT slot — and the whole point of the six-track grid
    // is that all six fit on ONE row. With only the two rows above, a
    // staging capture showed a third-full lane and proved nothing.
    {
      ...base, id: 900004, slug: 'staging-demo-featured-2',
      name: 'Staging demo featured 2', icon_emoji: '🎲',
      featured: true, featured_order: 2,
    },
    {
      ...base, id: 900005, slug: 'staging-demo-featured-3',
      name: 'Staging demo featured 3', icon_emoji: '🧩',
      featured: true, featured_order: 3,
    },
    {
      ...base, id: 900006, slug: 'staging-demo-featured-4',
      name: 'Staging demo featured 4', icon_emoji: '🚀',
      featured: true, featured_order: 4,
    },
    {
      ...base, id: 900007, slug: 'staging-demo-featured-5',
      name: 'Staging demo featured 5', icon_emoji: '🎨',
      featured: true, featured_order: 5,
    },
    // ...and four NON-featured rows carrying an active-user count, for the
    // desktop widget's second lane (Home.popularApps ranks by
    // `active_users` and drops anything at zero). Without these the Popular
    // lane is empty in every staging preview — the clone's own rows keep
    // their real counts, but a check runs against a fresh database.
    // Numbers here where production sends bigint STRINGS; the client
    // coerces either, and tests cover both shapes.
    //
    // The four also carry deliberately DIFFERENT merged-proposal and age
    // profiles, so the #apps sort control (#1383) puts a different row on
    // top under each of its five orders instead of looking broken against
    // an otherwise uniform fixture set. Read them as: 1 = popular but
    // dormant, 2 = the workhorse, 3 = brand new and busy, 4 = neither.
    {
      ...base, id: 900008, slug: 'staging-demo-popular-1',
      name: 'Staging demo popular 1', icon_emoji: '🔥', active_users: 12,
      merged_prs: 3, merged_prs_recent: 0, last_merged_at: demoAgo(90 * 24),
      created_at: demoAgo(200 * 24), last_deploy_at: demoAgo(60 * 24),
    },
    {
      ...base, id: 900009, slug: 'staging-demo-popular-2',
      name: 'Staging demo popular 2', icon_emoji: '📈', active_users: 9,
      merged_prs: 41, merged_prs_recent: 11, last_merged_at: demoAgo(2),
      created_at: demoAgo(120 * 24), last_deploy_at: demoAgo(2),
    },
    {
      ...base, id: 900010, slug: 'staging-demo-popular-3',
      name: 'Staging demo popular 3', icon_emoji: '🎧', active_users: 7,
      merged_prs: 6, merged_prs_recent: 5, last_merged_at: demoAgo(24),
      created_at: demoAgo(3 * 24), last_deploy_at: demoAgo(24),
    },
    {
      ...base, id: 900011, slug: 'staging-demo-popular-4',
      name: 'Staging demo popular 4', icon_emoji: '🗺️', active_users: 5,
      created_at: demoAgo(400 * 24), last_deploy_at: demoAgo(300 * 24),
    },
  ];
  if (curation) apps.push(
    { ...base, id: 990031, slug: 'directory-sample-working', name: 'Directory sample working',
      icon_emoji: '🧩', featured: true, featured_order: -1 },
    { ...base, id: 990032, slug: 'directory-sample-unreviewed', name: 'Directory sample unreviewed',
      icon_emoji: '🌱', directory_review_status: 'unreviewed', directory_reviewed_at: null },
    { ...base, id: 990033, slug: 'directory-sample-demo', name: 'Directory sample demo',
      icon_emoji: '🎭', directory_review_status: 'demo', active_users: 9999 },
    { ...base, id: 990034, slug: 'directory-sample-broken', name: 'Directory sample needs fixes',
      icon_emoji: '🔧', directory_review_status: 'broken', active_users: 9998 },
    { ...base, id: 990035, slug: 'directory-sample-no-icon', name: 'Directory sample needs an icon' },
  );
  return apps.map((app) => ({ ...app, directory: discoveryCuration.describe(app) }));
}

// SELF-HOSTING.md sub-step 2k: helper for the import-flow guards.
// Compares a parsed {owner, repo} against config.platformRepoUrl,
// case-insensitively. Returns false on any malformed input — the caller
// has already validated the parse, so this only fires the guard for
// genuine platform-repo URLs.
function isPlatformRepo(parsed, config) {
  if (!parsed || !parsed.owner || !parsed.repo) return false;
  if (!config.platformRepoUrl) return false;
  const platform = github.parseGithubUrl(config.platformRepoUrl);
  if (!platform) return false;
  return parsed.owner.toLowerCase() === platform.owner.toLowerCase()
      && parsed.repo.toLowerCase() === platform.repo.toLowerCase();
}

// SELF-HOSTING.md sub-step 2h: the platform's deploy is GHA-driven, not
// staging.rebuildProduction-driven, so /redeploy and /check-updates don't
// apply to the self-app row and are refused with an explanatory 403.
//
// The secrets routes used to be refused here too, on the grounds that the
// platform reads its env from .env rather than app_secrets. That is still
// true of `app_secrets` — but the secrets routes now BRANCH for the
// self-hosted app onto services/platform-env.js, which writes the store
// the deploy actually resolves (scripts/dump-platform-env.js). So they
// are no longer a dead end and no longer refused; see the self-hosted
// branches in the three routes further below.
function refuseIfSelfHosted(app, res) {
  if (!app || !app.self_hosted) return false;
  res.status(403).json({
    error: 'The Homeroom platform deploys via GitHub Actions; this action does not apply to the self-app row.',
  });
  return true;
}

// The platform's own env is documented in TWO manifest blocks: `platform_env`
// (the tunables an admin may actually set — backed by platform_env_values)
// and `secrets` (the credentials the deploy injects straight from GitHub
// secrets). Both describe the same process, so the one panel renders both:
// declared tunables from the DAO, plus a synthesized read-only row per
// `secrets` key that platform_env doesn't already declare.
//
// Every such key is in app-manifest.PLATFORM_ENV_UNWRITABLE, so a
// synthesized row can never be editable — `unwritable: true` is asserted
// here rather than derived, and isWritableKey() refuses the write anyway.
// `hasValue` comes from process.env because that IS where the value lives
// for these; no ciphertext exists to read and none is ever returned.
// Heading for the read-only rows that come straight from the platform
// repo's GitHub Actions secrets. Its own group so the panel can say where
// the rows came from and where to change them.
const GITHUB_ACTIONS_GROUP = 'GitHub Actions secrets (platform repo)';

// Staging fixtures for the Actions-secrets group. A self-app staging
// container has no GitHub credentials at all (GITHUB_APP_ID /
// GITHUB_BOT_TOKEN carry `staging_default: ""`), so the live fetch always
// fails there and every PR preview would show only the unavailable line —
// the group's actual rows, and the exact-name annotation path, would be
// unreviewable. Three obviously-fake rows cover all three visuals:
//   STAGING_DEMO_GH_DEPLOY_KEY — an old secret (updated months ago)
//   STAGING_DEMO_GH_API_TOKEN  — a fresh one (updated yesterday)
//   GITHUB_BOT_TOKEN           — an EXACT match with a row the platform's
//                                own `secrets` block declares, so the
//                                "also a GitHub Actions secret"
//                                annotation renders on that row instead
//                                of a duplicate one appearing here
// Returns null outside staging, so production only ever shows real data.
function stagingMockActionsSecrets() {
  if (!IS_STAGING) return null;
  const days = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  return {
    ok: true,
    source: 'staging-mock',
    secrets: [
      { name: 'STAGING_DEMO_GH_DEPLOY_KEY', createdAt: days(400), updatedAt: days(140) },
      { name: 'STAGING_DEMO_GH_API_TOKEN', createdAt: days(30), updatedAt: days(1) },
      { name: 'GITHUB_BOT_TOKEN', createdAt: days(220), updatedAt: days(60) },
    ],
  };
}

function platformSecretsView(rows, manifest, { includeValues, actionsSecrets = null }) {
  const declared = new Set(rows.map((r) => r.key));
  const merged = rows.map((r) => ({
    key: r.key,
    description: r.description,
    required: r.required,
    // Canonical `private` plus the `sensitive` BC alias, populated
    // identically — same contract app-secrets.getRedactedView() has.
    private: r.private,
    sensitive: r.private,
    default: r.defaultValue,
    hasValue: r.hasValue,
    // A private value is never decrypted by listView(), and a non-private
    // one only when the caller passed a dataKey (admins only).
    value: includeValues ? r.value : null,
    valueLast4: includeValues && !r.private ? r.valueLast4 : null,
    updatedAt: r.updatedAt,
    updatedBy: includeValues ? r.updatedBy : null,
    unwritable: r.unwritable,
    group: r.group,
    state: r.state,
    orphan: r.state === 'orphan',
  }));

  for (const entry of (manifest.secrets || [])) {
    if (declared.has(entry.key)) continue;
    merged.push({
      key: entry.key,
      description: entry.description,
      required: entry.required,
      private: entry.private,
      sensitive: entry.private,
      default: entry.default,
      hasValue: !!process.env[entry.key],
      value: null,
      valueLast4: null,
      updatedAt: null,
      updatedBy: null,
      unwritable: true,
      group: 'Managed by the deploy',
      state: 'managed',
      orphan: false,
    });
  }

  // The platform repo's GitHub Actions secrets, read-only. GitHub's API
  // returns names + timestamps ONLY — no endpoint reveals a value with any
  // credential — so `value`/`valueLast4` are hard-coded null here rather
  // than derived: there is nothing to leak, and the UI says so.
  //
  // Dedupe is EXACT-NAME only, and that is deliberate. deploy.yml renames
  // most secrets on their way into the env (`secrets.USERNODE_JWT_SECRET`
  // → `JWT_SECRET`), so an exact match is the only case where the two
  // really are the same object; those annotate the existing row instead of
  // duplicating it. Everything else — including deploy-only secrets that
  // were never env vars (DEPLOY_HOST, DEPLOY_SSH_KEY) — gets its own row.
  // Inferring the rename map would mean parsing the workflow file.
  if (actionsSecrets && Array.isArray(actionsSecrets.secrets)) {
    const byKey = new Map(merged.map((r) => [r.key, r]));
    for (const s of actionsSecrets.secrets) {
      if (!s || typeof s.name !== 'string') continue;
      const existing = byKey.get(s.name);
      if (existing) {
        existing.githubSecret = { name: s.name, updatedAt: s.updatedAt || null };
        continue;
      }
      const row = {
        key: s.name,
        description: '',
        required: false,
        private: true,
        sensitive: true,
        default: null,
        hasValue: true,
        value: null,
        valueLast4: null,
        updatedAt: s.updatedAt || null,
        updatedBy: null,
        unwritable: true,
        group: GITHUB_ACTIONS_GROUP,
        state: 'managed',
        orphan: false,
        source: 'github-actions',
      };
      merged.push(row);
      byKey.set(row.key, row);
    }
  }

  // Group in key order within a group, then float the groups nobody can
  // act on to the bottom: an all-unwritable group leading the list (the
  // API's alphabetical order puts "Managed by the deploy" first) pushes
  // every editable variable below the fold. The GitHub-secrets group is
  // all-unwritable by construction, so it sinks with them — which is
  // where it belongs.
  const groups = [];
  const byGroup = new Map();
  for (const row of merged) {
    if (!byGroup.has(row.group)) { byGroup.set(row.group, []); groups.push(row.group); }
    byGroup.get(row.group).push(row);
  }
  const rank = (g) => {
    const inGroup = byGroup.get(g);
    if (inGroup.every((v) => v.state === 'orphan')) return 2;
    if (inGroup.every((v) => v.unwritable)) return 1;
    return 0;
  };
  groups.sort((a, b) => rank(a) - rank(b));
  return groups.flatMap((g) => byGroup.get(g).sort((a, b) => a.key.localeCompare(b.key)));
}

// If app creation hasn't reached `running` within this window, a watchdog
// flips the row to `error` so the home screen stops showing "Spinning up..."
// and the creator can retry.
const CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_COUNT = 3;

function scheduleCreationWatchdog(pool, appId) {
  setTimeout(async () => {
    try {
      // COALESCE guard (#416): only write the synthetic timeout record
      // when no real captured failure landed first — the watchdog can
      // fire after createApp's own catch already persisted the cause.
      const timeoutRecord = deployFailure.syntheticRecord(
        'timeout',
        `App creation timed out after ${Math.round(CREATION_TIMEOUT_MS / 60000)} minutes`
      );
      const { rowCount } = await pool.query(
        `UPDATE apps SET status = 'error',
                         last_failure = COALESCE(last_failure, $2::jsonb)
         WHERE id = $1 AND status = 'creating'`,
        [appId, JSON.stringify(timeoutRecord)]
      );
      if (rowCount > 0) {
        log.warn('apps', 'App creation timed out, marked as error', { appId });
      }
    } catch (err) {
      log.warn('apps', 'Creation watchdog query failed', { appId, err: err.message });
    }
  }, CREATION_TIMEOUT_MS).unref?.();
}

// Called on server startup: any app that was mid-creation when the previous
// process died is stranded in `creating`. Flip anything older than 10min.
async function sweepStuckCreatingApps(pool) {
  try {
    const sweepRecord = deployFailure.syntheticRecord(
      'timeout',
      'App creation was interrupted by a platform restart'
    );
    const { rowCount } = await pool.query(
      `UPDATE apps SET status = 'error',
                       last_failure = COALESCE(last_failure, $1::jsonb)
       WHERE status = 'creating' AND created_at < NOW() - INTERVAL '10 minutes'`,
      [JSON.stringify(sweepRecord)]
    );
    if (rowCount > 0) {
      log.info('apps', 'Swept stuck creating apps on boot', { count: rowCount });
    }
  } catch (err) {
    log.warn('apps', 'Boot sweep failed', { err: err.message });
  }
}

// #2524: how much time ONE activity heartbeat may report, and how much a
// single (user, app, day) row may ever hold.
//
// These bound a column that RANKS: the home screen orders the directory by
// `SUM(seconds_spent)` over the last seven days, so whatever reaches this
// column decides which apps people are shown first.
//
// The per-post ceiling is generous on purpose. The browser client counts one
// second at a time and flushes at 30 (`AppView.startActivityTracking`), so a
// real body is 1..30; an hour leaves room for a caller that batches — a
// native app returning from the background, say — without leaving the door
// open. It is the DAILY cap that actually holds the line, because a ceiling
// on one request is defeated by sending many.
const ACTIVITY_MAX_PER_POST = 3600;
const ACTIVITY_MAX_PER_DAY = 86400;

/**
 * The seconds to credit for one heartbeat, or `null` to refuse the body.
 *
 * Refuses anything that is not a finite number RATHER THAN COERCING IT. The
 * old guard was `!seconds || seconds < 0`, which let a string through: 'abc'
 * is truthy and `'abc' < 0` is false, so it reached `Math.round('abc')` →
 * NaN → an INTEGER column rejecting NaN, i.e. a 500 where the honest answer
 * was a 400. `Infinity` took the same route. A numeric STRING is refused too:
 * this body comes from our own client, which sends a number.
 */
function activitySeconds(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.min(rounded, ACTIVITY_MAX_PER_POST);
}

function appRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps', async (req, res) => {
    try {
      const appDeployStatus = require('../services/app-deploy-status');
      const compactForGlobalChat = req.get('x-global-chat-loopback') === '1'
        && req.query.view === 'global-chat';
      // SELF-HOSTING.md sub-step 2j: hide self_hosted rows from
      // non-admin listings. Admins see them so they can reach the
      // self-app's settings, dev-chat, etc. The same filter is applied
      // to GET /api/apps/:slug below — a non-admin requesting the slug
      // directly gets a 404, not a 403, so the row's existence isn't
      // disclosed.
      //
      // Phase 4 (SELF_APP_PUBLIC_VOTING): when the flag is on, non-
      // admins also see the self-app row so they can vote on its PRs
      // through the existing voting UI. Off by default; flip via env.
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      // The active_users join mirrors src/services/active-users.js's
      // sticky 10-day rule: a user counts iff they ever spent >= 60s
      // on this app on a single day AND have visited within the last
      // 10 days. Computed in one batched query (one row per app) to
      // avoid the obvious O(N apps) per-app round trip from the
      // group-chat dashboard tile path.
      //
      // The dev/iss joins power the home-card activity chips (#57):
      // PRs awaiting community votes (status promoted/merging — same
      // filter as the admin dashboard overview), in-flight dev sessions
      // (status active; headless runs included — per-app activity
      // legitimately covers autonomous builds, matching /api/status),
      // and open issues. All DB-derived; no GitHub round trips.
      const userId = req.user?.id || null;
      const isAdmin = !!req.user?.isAdmin;
      // Visibility filter: admins see everything; everyone else sees
      // view-public apps plus apps they're a member of (the `me` join).
      // View-private apps are simply absent from the list for outsiders
      // — same non-disclosure stance as the self_hosted filter.
      const { rows } = await pool.query(`
        SELECT ${appAccess.nonSecretAppColumnList('a')},
          COALESCE(msg_counts.cnt, 0) AS message_count,
          COALESCE(activity.total_seconds, 0) AS total_seconds,
          COALESCE(au.cnt, 0) AS active_users,
          (favs.app_id IS NOT NULL AND NOT COALESCE(favs.hidden, FALSE)) AS is_favorited,
          COALESCE(favs.hidden, FALSE) AS your_apps_hidden,
          favs.sort_order AS favorite_order,
          -- Admin-curated "Find more apps" row (featured_apps). Rides the
          -- list payload rather than a second endpoint: this query is
          -- already visibility-filtered, so a featured view-private app is
          -- absent for a viewer who can't see it, and both the home row
          -- and the #apps browse screen derive their ordering from it.
          (fa.app_id IS NOT NULL) AS featured,
          fa.sort_order AS featured_order,
          (me.user_id IS NOT NULL) AS is_collaborator,
          -- The community the app belongs to (services/communities.js):
          -- whether you are in it, how many are, who it is for, and when
          -- it last moved for you. The Workshop lists your communities by
          -- audience and by that recency; Discover's Join button reads
          -- is_member. last_active_at is the latest of your joining, your
          -- own last visit and the last thing that happened in its changes,
          -- so a community you have not opened but that has news rises.
          (cm.user_id IS NOT NULL) AS is_member,
          COALESCE(cmc.cnt, 0) AS member_count,
          ${communities.audienceSql('a', 'cmc.cnt')} AS audience,
          GREATEST(cm.joined_at, mine.last_visit::timestamptz, dev.last_activity_at) AS last_active_at,
          COALESCE(dev.open_prs, 0) AS open_prs,
          COALESCE(dev.active_sessions, 0) AS active_sessions,
          -- "How actively developed is this app?" (#1383). All three ride
          -- the dev subquery's existing unfiltered scan of chat_sessions,
          -- so the sort control costs no extra query and no new index.
          COALESCE(dev.merged_prs, 0) AS merged_prs,
          COALESCE(dev.merged_prs_recent, 0) AS merged_prs_recent,
          dev.last_merged_at AS last_merged_at,
          COALESCE(iss.open_issues, 0) AS open_issues
        FROM apps a
        LEFT JOIN (
          SELECT app_id, COUNT(*) AS cnt
          FROM chat_messages
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY app_id
        ) msg_counts ON msg_counts.app_id = a.id
        LEFT JOIN (
          SELECT app_id, SUM(seconds_spent) AS total_seconds
          FROM app_activity
          WHERE date > CURRENT_DATE - 7
          GROUP BY app_id
        ) activity ON activity.app_id = a.id
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
        LEFT JOIN (
          SELECT app_id, sort_order, hidden FROM app_favorites WHERE user_id = $2
        ) favs ON favs.app_id = a.id
        LEFT JOIN featured_apps fa ON fa.app_id = a.id
        LEFT JOIN app_collaborators me
          ON me.app_id = a.id AND me.user_id = $2 AND me.status = 'member'
        LEFT JOIN community_members cm
          ON cm.community_id = a.community_id AND cm.user_id = $2
        LEFT JOIN (
          SELECT community_id, COUNT(*) AS cnt FROM community_members GROUP BY community_id
        ) cmc ON cmc.community_id = a.community_id
        LEFT JOIN (
          SELECT app_id, MAX(date) AS last_visit FROM app_activity WHERE user_id = $2 GROUP BY app_id
        ) mine ON mine.app_id = a.id
        LEFT JOIN (
          SELECT app_id,
            MAX(last_activity_at) AS last_activity_at,
            COUNT(*) FILTER (WHERE status IN ('promoted', 'merging')) AS open_prs,
            COUNT(*) FILTER (WHERE status = 'active') AS active_sessions,
            -- A merged chat_session IS an accepted community proposal —
            -- the same definition contributors.js and the gallery use.
            -- merged_at was added by a later ALTER TABLE and is NULL on
            -- every row merged before it existed, so COALESCE to
            -- created_at rather than dropping that history on the floor.
            COUNT(*) FILTER (WHERE status = 'merged') AS merged_prs,
            COUNT(*) FILTER (
              WHERE status = 'merged'
                AND COALESCE(merged_at, created_at) > NOW() - INTERVAL '30 days'
            ) AS merged_prs_recent,
            MAX(COALESCE(merged_at, created_at)) FILTER (WHERE status = 'merged')
              AS last_merged_at
          FROM chat_sessions
          GROUP BY app_id
        ) dev ON dev.app_id = a.id
        LEFT JOIN (
          SELECT app_id, COUNT(*) AS open_issues
          FROM issues
          WHERE status = 'open'
          GROUP BY app_id
        ) iss ON iss.app_id = a.id
        WHERE (NOT a.self_hosted OR $1::boolean)
          AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)
        ORDER BY (COALESCE(msg_counts.cnt, 0) + COALESCE(activity.total_seconds, 0)) DESC, a.created_at DESC
      `, [showSelfHosted, userId, isAdmin]);

      // #788: one query for every app this viewer is a per-app admin
      // of, so accessFlags below can resolve can_manage per row without
      // a round-trip each.
      const adminAppIds = await appAdmins.getAdminAppIdsForUser(pool, req.user?.id);

      if (compactForGlobalChat) {
        return res.json({
          apps: rows.map((app) => compactGlobalChatApp(app, req.user, adminAppIds)),
        });
      }

      // How many people BUILT each app, for the Discover cards on the
      // launcher. One round trip for the whole page over the shared
      // contributor definition (services/contributors.js), rather than the
      // per-app fetch the directory's detail view makes: the cards show the
      // number and never the names, so the ranked list would be all cost.
      const contributorCounts = await contributors.loadContributorCounts(
        pool, rows.map((a) => a.id)
      );

      const apps = await Promise.all(rows.map(async (a) => {
        // Per-app missing-required-secrets list. Cheap (one extra query
        // each) and lets the home tile show a "fix secrets" warning
        // without each card making its own /secrets fetch on render.
        //
        // The self-hosted app answers from platform_env instead: its
        // `secrets` block documents GitHub-injected credentials nobody can
        // set from the panel, so counting those would be a permanent
        // false positive. `missingRequired` counts only what the panel can
        // actually fix (required, writable, unset) — the same input the
        // pre-merge gate blocks on.
        let missingSecrets = null;
        if (a.self_hosted) {
          const missing = await platformEnv.missingRequired(pool, a.id);
          missingSecrets = missing.length ? missing.map((m) => m.key) : null;
        } else if (a.manifest_snapshot && typeof a.manifest_snapshot === 'object') {
          const declared = Array.isArray(a.manifest_snapshot.secrets)
            ? a.manifest_snapshot.secrets : [];
          if (declared.some((s) => s && s.required)) {
            const { rows: storedRows } = await pool.query(
              'SELECT key FROM app_secrets WHERE app_id = $1',
              [a.id]
            );
            const storedKeys = new Set(storedRows.map((r) => r.key));
            missingSecrets = declared
              .filter((s) => s && s.required && !storedKeys.has(s.key))
              .map((s) => s.key);
            if (!missingSecrets.length) missingSecrets = null;
          }
        }

        let url = null;
        if (a.status === 'running') {
          if (IS_LOCAL_DEV) {
            const containerName = `usernode-app-${a.slug}`;
            const hostPort = await docker.getHostPort(containerName, 3000);
            if (hostPort) url = `http://localhost:${hostPort}`;
          }
          if (!url) url = `https://${caddy.productionHostname(a.slug)}`;
        }
        // Minimal version info for the home-screen pill — derived
        // entirely from columns we already pulled, no extra round
        // trips. The richer per-app endpoint at
        // /api/apps/:slug/version still does the chat_sessions join
        // for PR title/author, which the home pill doesn't need.
        // Self-hosted (platform self-app) overrides for `active_users`:
        // the LEFT JOIN above scopes to `app_id = a.id`, but no rows
        // ever land under the self-app's id (no App tab → no activity
        // tracking — see services/active-users.js for the full
        // rationale). Re-compute as the union across every app so the
        // home tile shows a meaningful count and the value matches what
        // getActiveUserStats returns for vote-majority math.
        if (a.self_hosted) {
          const { rows: unionRows } = await pool.query(
            `SELECT COUNT(DISTINCT a.user_id) AS cnt
               FROM app_activity a
               WHERE a.date >= CURRENT_DATE - 10
                 AND EXISTS (
                   SELECT 1 FROM app_activity b
                   WHERE b.user_id = a.user_id
                     AND b.seconds_spent >= 60
                 )`
          );
          a.active_users = parseInt(unionRows[0]?.cnt, 10) || 0;
        }

        const [, owner, repo] = (a.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        const version = a.main_sha
          ? {
              sha: a.main_sha,
              shortSha: a.main_sha.slice(0, 7),
              prNumber: a.main_pr_number || null,
              commitUrl: owner && repo
                ? `https://github.com/${owner}/${repo}/commit/${a.main_sha}`
                : null,
              prUrl: a.main_pr_number && owner && repo
                ? `https://github.com/${owner}/${repo}/pull/${a.main_pr_number}`
                : null,
            }
          : null;
        // #416: the raw last_failure JSONB (which carries the full boot
        // log) never rides the list payload. Involved users (creator /
        // collaborator / admin — same audience as the detail endpoint's
        // lastFailure) get the concise reason + timestamp so the card
        // tooltip and the "View build log" menu item work at render
        // time; everyone else sees the plain 'error' status only.
        const canSeeFailure = !!req.user?.isAdmin
          || !!a.is_collaborator
          || (req.user?.id != null && a.created_by === req.user.id);
        const lf = (canSeeFailure && a.last_failure && typeof a.last_failure === 'object')
          ? a.last_failure : null;
        const contributorCount = contributorCounts.get(a.id) || 0;
        return {
          ...appAccess.stripAppSecrets(a),
          contributor_count: contributorCount,
          last_failure: undefined,
          last_failure_reason: lf ? (lf.reason || null) : null,
          last_failure_at: lf ? (lf.at || null) : null,
          url,
          version,
          deployProgress: appDeployStatus.read(a.slug),
          missingSecrets,
          // Server-built icon URL so the client never assembles ids into
          // paths (and staging demo rows can inject arbitrary sources).
          icon_url: a.icon_image_id ? `/app-icons/${a.icon_image_id}` : null,
          directory: discoveryCuration.describe(a),
          is_favorited: !!a.is_favorited,
          your_apps_hidden: !!a.your_apps_hidden,
          favorite_order: a.favorite_order ?? null,
          featured: !!a.featured,
          featured_order: a.featured_order ?? null,
          open_prs: parseInt(a.open_prs, 10) || 0,
          active_sessions: parseInt(a.active_sessions, 10) || 0,
          merged_prs: parseInt(a.merged_prs, 10) || 0,
          merged_prs_recent: parseInt(a.merged_prs_recent, 10) || 0,
          last_merged_at: a.last_merged_at || null,
          open_issues: parseInt(a.open_issues, 10) || 0,
          is_member: !!a.is_member,
          member_count: parseInt(a.member_count, 10) || 0,
          audience: a.audience || 'open',
          last_active_at: a.last_active_at || null,
          ...accessFlags(a, req.user, a.is_collaborator, adminAppIds, contributorCount,
            config.selfAppSlug),
        };
      }));
      // Resolve fork lineage (live source-name lookup, "<deleted>"
      // fallback) for every serialized app in one batched query.
      await attachForkLineage(pool, apps);
      // Staging demo tiles for the icon feature (see demoIconApps above).
      if (IS_STAGING && req.query.demo === '1') {
        apps.unshift(...demoIconApps(req.query.curation === '1'));
      }
      res.json({ apps });
    } catch (err) {
      log.error('apps', 'Failed to list apps', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public-only repo info. Kept as a low-privilege fallback; not used by
  // the import modal anymore (verify-access below is strictly better
  // because it works for private repos the bot can read).
  //
  // githubLookupLimiter (#2519): the call this makes spends the PLATFORM's
  // shared GitHub installation quota, not the caller's. Failures count —
  // see the limiter for why.
  router.get('/api/github/repo-info', githubLookupLimiter, async (req, res) => {
    const parsed = github.parseGithubUrl(req.query.url || '');
    if (!parsed) return res.status(400).json({ error: 'Invalid GitHub URL' });
    const info = await github.fetchPublicRepoInfo(parsed.owner, parsed.repo);
    if (!info) return res.status(404).json({ error: 'Repo not found or private' });
    res.json({ name: info.name, description: info.description });
  });

  // The "Check access" button in the import-existing modal hits this.
  // It's the same pre-flight POST /api/apps runs on submit (so the
  // server stays the source of truth even if a client skips the check),
  // surfaced as its own endpoint so the UI can:
  //   1. accept any pending bot invitation for this exact repo
  //   2. confirm Write access
  //   3. return name/description so the form can prefill the app-name
  //      field with a sensible default
  //
  // githubLookupLimiter (#2519): same shared installation quota as
  // repo-info above, plus step 1 is a side effect worth bounding on its
  // own. One bucket covers both routes.
  router.get('/api/github/verify-access', githubLookupLimiter, async (req, res) => {
    const parsed = github.parseGithubUrl(req.query.url || '');
    if (!parsed) return res.status(400).json({ error: 'Repo URL must look like https://github.com/<owner>/<repo>' });
    // SELF-HOSTING.md sub-step 2k: refuse to import the platform's
    // own repo as a child app. The self-app row already exists; importing
    // a sibling would just produce a confused / broken app row sharing
    // the same code.
    if (isPlatformRepo(parsed, config)) {
      return res.status(409).json({
        error: 'This is the platform repo. The self-app already exists; importing it as a child would create a sibling instance.',
      });
    }
    const verify = await github.verifyBotAccess(parsed.owner, parsed.repo);
    if (!verify.ok) return res.status(verify.status).json({ error: verify.message, code: verify.code });
    res.json({
      ok: true,
      owner: parsed.owner,
      repo: parsed.repo,
      name: verify.name,
      description: verify.description,
      fullName: verify.fullName,
    });
  });

  router.get('/api/me/app-allowance', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      res.json(await appAllowance.read(pool, req.user, { maxApps: config.maxApps }));
    } catch (err) {
      log.error('apps', 'App allowance lookup failed', { message: err.message });
      res.status(500).json({ error: 'Could not load your app allowance. Please try again.' });
    }
  });

  router.post('/api/me/app-allowance/request', appAllowanceRequestLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.canAdminWrite) return res.status(400).json({ error: 'Your account already has unlimited app slots.' });
    try {
      res.json(await appAllowance.requestMore(pool, req.user, { maxApps: config.maxApps }));
    } catch (err) {
      log.error('apps', 'App allowance request failed', { message: err.message });
      res.status(500).json({ error: 'Could not send your request. Please try again.' });
    }
  });

  router.post('/api/apps', drainGuard, appCreateLimiter, async (req, res) => {
    const { name, repoUrl } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // Who it is for, who is invited and who approves (communities, stage
    // 3; services/create-options.js). A body with none of them is an older
    // client and keeps today's visibility fields and defaults.
    const options = createOptions.parseCreateOptions(req.body, { imported: !!repoUrl });
    if (options.error) {
      return res.status(400).json({ error: options.error });
    }
    const { collabVisibility, viewVisibility, invitees, governance: rule, description } = options;

    // Import-existing pre-flight: parse URL, accept any pending invite
    // for this exact repo, then verify Write access. Anything other
    // than `ok` is forwarded to the client with the actionable hint
    // assembled in github.verifyBotAccess.
    let repoUrlNormalized = null;
    if (repoUrl) {
      const parsed = github.parseGithubUrl(repoUrl);
      if (!parsed) {
        return res.status(400).json({ error: 'Repo URL must look like https://github.com/<owner>/<repo>' });
      }
      // SELF-HOSTING.md sub-step 2k: same guard as
      // /api/github/verify-access, but on the submit path so a client
      // that skipped Check (or a script POSTing directly) can't bypass.
      if (isPlatformRepo(parsed, config)) {
        return res.status(409).json({
          error: 'This is the platform repo. The self-app already exists; importing it as a child would create a sibling instance.',
        });
      }
      const verify = await github.verifyBotAccess(parsed.owner, parsed.repo);
      if (!verify.ok) {
        return res.status(verify.status).json({ error: verify.message });
      }
      repoUrlNormalized = `https://github.com/${parsed.owner}/${parsed.repo}`;
    }

    const crypto = require('crypto');
    const code = crypto.randomBytes(3).toString('hex');
    // Length-capped so the derived container name and preview host stay
    // inside a DNS label — see appManifest.MAX_APP_SLUG_LENGTH.
    const slug = appManifest.buildAppSlug(name, code);
    if (!slug) {
      return res.status(400).json({ error: 'Invalid app name' });
    }

    try {
      if (!req.user?.canAdminWrite) {
        const allowance = await appAllowance.read(pool, req.user);
        if (!allowance.canCreateApps) return res.status(403).json(appAllowance.refusal(allowance));
      }

      // A Group's invitees resolve BEFORE anything is created: a typo in a
      // username is a 400 with the name in it, not a project that exists
      // with half its people missing.
      let inviteTargets = [];
      if (invitees.length) {
        const { rows: found } = await pool.query(
          `SELECT id, username FROM users WHERE LOWER(username) = ANY($1::text[])`,
          [invitees.map((u) => u.toLowerCase())]
        );
        const byName = new Map(found.map((u) => [u.username.toLowerCase(), u]));
        const missing = invitees.filter((u) => !byName.has(u.toLowerCase()));
        if (missing.length) {
          return res.status(400).json({
            error: missing.length === 1
              ? `There is no Homeroom user named @${missing[0]}.`
              : `There are no Homeroom users named ${missing.map((u) => '@' + u).join(', ')}.`,
          });
        }
        inviteTargets = invitees
          .map((u) => byName.get(u.toLowerCase()))
          .filter((u) => u.id !== req.user.id);
      }

      // Enforce global app cap (full admins bypass; view-only admins
      // don't — issue #311). Errored apps don't count
      // toward the limit — they hold ~no resources and can be deleted to
      // free a slot.
      if (!req.user?.canAdminWrite && config.maxApps > 0) {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
        );
        if (countRows[0].n >= config.maxApps) {
          log.warn('apps', 'App creation blocked by max-apps cap', {
            userId: req.user.id,
            active: countRows[0].n,
            cap: config.maxApps,
          });
          // Somebody was just refused: make sure the admins have heard.
          platformLimits.nudge(pool, config, 'apps');
          return res.status(429).json({
            error: `This server is at its app limit (${config.maxApps}). Ask an admin to remove an app or raise the limit.`,
          });
        }
      }

      // The CTE makes app row + creator membership atomic — the creator
      // must always have a member row (it's what makes a collab-private
      // app reachable by anyone at all).
      const { rows } = await pool.query(
        `WITH new_app AS (
           INSERT INTO apps (name, slug, repo_url, created_by, status,
                             collab_visibility, view_visibility)
           VALUES ($1, $2, $3, $4, 'creating', $5, $6)
           RETURNING *
         ), membership AS (
           INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT id, $4, 'member', NOW() FROM new_app
           ON CONFLICT (app_id, user_id) DO NOTHING
         )
         SELECT * FROM new_app`,
        [name.trim(), slug, repoUrlNormalized, req.user.id, collabVisibility, viewVisibility]
      );

      let appRow = rows[0];

      // WHO APPROVES, chosen on the create screen. Written to the row now so
      // the rule holds from the first proposal, and passed to the template
      // (appRow → app-creator → template.js) so the new repository's
      // dapp.json says the same thing: that file is the rule's source of
      // truth, and the first deploy's reconcile then finds nothing to change.
      // "People I pick" starts with the creator as its one approver, the
      // same seed applyGovernanceChange plants when a manifest switches a
      // live app to invited approvers.
      if (rule) {
        const { rows: governed } = await pool.query(
          `UPDATE apps SET approver_policy = $1, approvals_required = $2
            WHERE id = $3 RETURNING *`,
          [rule.approverPolicy, rule.approvalsRequired, appRow.id]
        );
        appRow = governed[0] || appRow;
        if (rule.approverPolicy === 'invited') {
          await pool.query(
            `INSERT INTO app_approvers (app_id, user_id, status, accepted_at)
             VALUES ($1, $2, 'member', NOW())
             ON CONFLICT (app_id, user_id) DO NOTHING`,
            [appRow.id, req.user.id]
          );
        }
      }

      // WHAT IT IS, if the creator said. Seeded as the manifest snapshot the
      // template's dapp.json is about to match ({ description, secrets: [] }),
      // so app-creator writes it into the new repository and a Retry still
      // has it. The first deploy then snapshots the real file over it.
      if (description) {
        const { rows: described } = await pool.query(
          `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2 RETURNING *`,
          [JSON.stringify({ description, secrets: [] }), appRow.id]
        );
        appRow = described[0] || appRow;
      }

      // A Group's invites go out now, each the same invite (and the same
      // notification) Members & approvals sends. Best-effort per person: the
      // project exists either way, and anyone missed can be invited from
      // its page.
      let invited = 0;
      for (const target of inviteTargets) {
        try {
          const sent = await collabInvites.sendInvite(pool, { app: appRow, target, inviterId: req.user.id });
          if (sent.ok) invited += 1;
        } catch (err) {
          log.warn('apps', 'Create-time invite failed', { appId: appRow.id, invitee: target.username, err: err.message });
        }
      }

      log.info('apps', repoUrlNormalized ? 'App imported (pending)' : 'App created (pending)', {
        appId: appRow.id,
        slug,
        ...(repoUrlNormalized ? { repoUrl: repoUrlNormalized } : {}),
      });
      events.record(pool, {
        type: events.EVENT_TYPES.APP_CREATED,
        userId: req.user.id,
        appId: appRow.id,
        metadata: {
          imported: !!repoUrlNormalized,
          collabVisibility,
          viewVisibility,
          ...(options.audience ? { audience: options.audience } : {}),
          ...(invited ? { invited } : {}),
          ...(rule ? { approverPolicy: rule.approverPolicy, approvalsRequired: rule.approvalsRequired } : {}),
          ...(description ? { described: true } : {}),
        },
      });

      // Kick off async creation — don't await. If it throws, flip to error.
      createApp(config, appRow).catch(async (err) => {
        log.error('apps', 'Async app creation failed', { appId: appRow.id, err: err.message });
        await pool.query(
          `UPDATE apps SET status = 'error',
                           last_failure = COALESCE(last_failure, $2::jsonb)
           WHERE id = $1 AND status = 'creating'`,
          [appRow.id, JSON.stringify(deployFailure.record(err))]
        ).catch(() => {});
      });

      // Backstop: if createApp hangs (never resolves or rejects), the
      // watchdog will unstick the row after CREATION_TIMEOUT_MS.
      scheduleCreationWatchdog(pool, appRow.id);

      res.status(201).json({ app: appAccess.stripAppSecrets(appRow), invited });
      platformLimits.nudge(pool, config, 'apps');
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An app with that name already exists' });
      }
      log.error('apps', 'Failed to create app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fork an existing app into a brand-new, independent app owned by the
  // forker. Mirrors POST /api/apps: same quota/cap gate, same slug
  // derivation, same insert-CTE (app row + creator membership) — plus a
  // reference-only `forked_from` and an async forkApp() worker that
  // clones the source's repo, public DB data, and non-private secrets.
  router.post('/api/apps/:slug/fork', drainGuard, appCreateLimiter, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'App name is required' });
    }

    try {
      // Resolve the source app + enforce VIEW access (404 on deny so
      // view-private apps aren't enumerable — same stance as elsewhere).
      const { rows: srcRows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!srcRows.length) return res.status(404).json({ error: 'App not found' });
      const sourceApp = srcRows[0];
      if (!(await appAccess.checkAppAccess(pool, sourceApp, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      // Reject a half-built source synchronously. Previously a source could
      // be far enough along to have a repo but still lose the DB snapshot
      // race; the async worker then left a bare "Error" tile behind.
      const readinessError = forkSourceReadinessError(sourceApp);
      if (readinessError) {
        return res.status(sourceApp.self_hosted ? 400 : 409).json({ error: readinessError });
      }

      // The same allowance read as create/import and the account UI.
      if (!req.user?.canAdminWrite) {
        const allowance = await appAllowance.read(pool, req.user);
        if (!allowance.canCreateApps) return res.status(403).json(appAllowance.refusal(allowance));
      }
      if (!req.user?.canAdminWrite && config.maxApps > 0) {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
        );
        if (countRows[0].n >= config.maxApps) {
          platformLimits.nudge(pool, config, 'apps');
          return res.status(429).json({
            error: `This server is at its app limit (${config.maxApps}). Ask an admin to remove an app or raise the limit.`,
          });
        }
      }

      const crypto = require('crypto');
      const slug = appManifest.buildAppSlug(name, crypto.randomBytes(3).toString('hex'));
      if (!slug) return res.status(400).json({ error: 'Invalid app name' });

      // Reference-only lineage: appId + slug, NEVER the name (resolved
      // live at serialize time). Inherit the source's visibility.
      const forkedFrom = JSON.stringify({ appId: sourceApp.id, slug: sourceApp.slug });
      const { rows } = await pool.query(
        `WITH new_app AS (
           INSERT INTO apps (name, slug, created_by, status,
                             collab_visibility, view_visibility, forked_from)
           VALUES ($1, $2, $3, 'creating', $4, $5, $6::jsonb)
           RETURNING *
         ), membership AS (
           INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT id, $3, 'member', NOW() FROM new_app
           ON CONFLICT (app_id, user_id) DO NOTHING
         )
         SELECT * FROM new_app`,
        [name.trim(), slug, req.user.id, sourceApp.collab_visibility, sourceApp.view_visibility, forkedFrom]
      );
      const appRow = rows[0];
      log.info('apps', 'App fork (pending)', { appId: appRow.id, slug, sourceSlug: sourceApp.slug });
      events.record(pool, {
        type: events.EVENT_TYPES.APP_CREATED,
        userId: req.user.id,
        appId: appRow.id,
        metadata: { forkedFromAppId: sourceApp.id, forkedFromSlug: sourceApp.slug },
      });

      forkApp(config, appRow, sourceApp).catch(async (err) => {
        log.error('apps', 'Async fork failed', { appId: appRow.id, err: err.message });
        await pool.query(
          `UPDATE apps SET status = 'error',
                           last_failure = COALESCE(last_failure, $2::jsonb)
           WHERE id = $1 AND status = 'creating'`,
          [appRow.id, JSON.stringify(deployFailure.record(err))]
        ).catch(() => {});
      });
      scheduleCreationWatchdog(pool, appRow.id);

      res.status(201).json({ app: appAccess.stripAppSecrets(appRow) });
      platformLimits.nudge(pool, config, 'apps');
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An app with that name already exists' });
      }
      log.error('apps', 'Failed to fork app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${appAccess.nonSecretAppColumnList()} FROM apps WHERE slug = $1`,
        [req.params.slug]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }

      const appRow = rows[0];
      // SELF-HOSTING.md sub-step 2j: 404 self-hosted rows for
      // non-admins (don't disclose existence via the slug path either).
      // Phase 4: SELF_APP_PUBLIC_VOTING relaxes this for non-admin
      // viewing/voting; falls back to admin-only when the flag is off
      // (today's default).
      if (appRow.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }
      // Visibility gate (view level). 404, not 403, so view-private apps
      // aren't enumerable — same stance as the self_hosted check above.
      const isCollaborator = await appAccess.isCollaborator(pool, appRow.id, req.user?.id);
      if (!req.user?.isAdmin && appRow.view_visibility === 'private' && !isCollaborator) {
        return res.status(404).json({ error: 'App not found' });
      }
      let url = null;
      if (appRow.status === 'running') {
        if (IS_LOCAL_DEV) {
          const containerName = `usernode-app-${appRow.slug}`;
          const hostPort = await docker.getHostPort(containerName, 3000);
          if (hostPort) url = `http://localhost:${hostPort}`;
        }
        if (!url) url = `https://${caddy.productionHostname(appRow.slug)}`;
      }

      // Same missingSecrets computation as the /api/apps list — needed
      // here so AppView.open() can paint the header badge and the
      // 'awaiting_secrets' splash without a second round-trip. Same
      // self_hosted branch rationale as above.
      let missingSecrets = null;
      if (appRow.self_hosted) {
        const missing = await platformEnv.missingRequired(pool, appRow.id);
        missingSecrets = missing.length ? missing.map((m) => m.key) : null;
      } else if (appRow.manifest_snapshot && typeof appRow.manifest_snapshot === 'object') {
        const declared = Array.isArray(appRow.manifest_snapshot.secrets)
          ? appRow.manifest_snapshot.secrets : [];
        if (declared.some((s) => s && s.required)) {
          const { rows: storedRows } = await pool.query(
            'SELECT key FROM app_secrets WHERE app_id = $1',
            [appRow.id]
          );
          const storedKeys = new Set(storedRows.map((r) => r.key));
          missingSecrets = declared
            .filter((s) => s && s.required && !storedKeys.has(s.key))
            .map((s) => s.key);
          if (!missingSecrets.length) missingSecrets = null;
        }
      }

      // #416: full failure detail (reason + build/boot log tail) only
      // for involved users — boot logs can echo whatever the app
      // prints, so outsiders keep today's bare 'error' status. The raw
      // column is always stripped from the payload.
      const canSeeFailure = !!req.user?.isAdmin
        || !!isCollaborator
        || (req.user?.id != null && appRow.created_by === req.user.id);
      // Which step of createApp is running right now, for a client that
      // loaded (or reloaded) mid-creation and so missed the WS
      // broadcasts. Null whenever there is nothing to report — a
      // finished app, or one whose platform process restarted mid-run —
      // which the dialog renders as "in progress, step unknown".
      const appCreationPhase = require('../services/app-creation-phase');
      const phaseEntry = appRow.status === 'creating'
        ? appCreationPhase.read(appRow.slug) : null;

      // Demo mode's partner, by name: the settings dialog says who the
      // synthetic proposals and votes on this app come from
      // (routes/demo-mode.js). Read by the flag, not just the column, so a
      // row that lost it is not named as a partner.
      let demoPartner = null;
      if (appRow.demo_mode && appRow.demo_partner_id) {
        const { rows: partnerRows } = await pool.query(
          'SELECT username FROM users WHERE id = $1 AND is_synthetic = TRUE',
          [appRow.demo_partner_id]
        );
        demoPartner = partnerRows[0]?.username || null;
      }
      const [adminAppIds, contributorCounts] = await Promise.all([
        appAdmins.getAdminAppIdsForUser(pool, req.user?.id),
        contributors.loadContributorCounts(pool, [appRow.id]),
      ]);
      const contributorCount = contributorCounts.get(appRow.id) || 0;
      const appPayload = {
        ...appAccess.stripAppSecrets(appRow),
        demo_partner: demoPartner,
        contributor_count: contributorCount,
        directory: discoveryCuration.describe(appRow),
        last_failure: undefined,
        lastFailure: (canSeeFailure && appRow.last_failure && typeof appRow.last_failure === 'object')
          ? appRow.last_failure : null,
        url,
        creationPhase: phaseEntry ? phaseEntry.phase : null,
        missingSecrets,
        // Reviewer copy needs to distinguish an advisory evidence run from
        // a real vote/merge gate. This is a platform rollout flag, not an app
        // secret or capability grant.
        visualEvidenceEnforced: !!config.visualEvidence?.enforce,
        // The whole-tree verdict under direct merges (services/main-watch.js):
        // is main green, and are this app's merges paused because it is not?
        mainCheck: require('../services/main-watch').describe(appRow),
        // A merged commit of the platform's own app that has not become the
        // running release (services/release-watch.js). Never stalled for a
        // child app. The raw column rides along in the allowlist; this is
        // the shape clients read.
        releaseStall: require('../services/release-watch').describe(appRow),
        ...accessFlags(appRow, req.user, isCollaborator, adminAppIds, contributorCount,
          config.selfAppSlug),
      };
      await attachForkLineage(pool, appPayload);
      res.json({ app: appPayload });
    } catch (err) {
      log.error('apps', 'Failed to get app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Deployed version pill (#21). Returns the SHA + PR context for the
  // commit currently running in prod. Null sha = pre-migration app
  // still in backfill queue, or a local-template build with no repo.
  //
  // Also folds in `deployProgress` so a freshly-loaded client whose
  // app is currently being redeployed sees the pill in its yellow
  // spinning state on first paint, rather than only after the next
  // `app_redeploy_status` WS broadcast.
  router.get('/api/apps/:slug/version', async (req, res) => {
    try {
      const appVersion = require('../services/app-version');
      const appDeployStatus = require('../services/app-deploy-status');
      const gated = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gated) return res.status(404).json({ error: 'App not found' });
      const info = await appVersion.getAppVersion(pool, req.params.slug);
      if (!info) return res.status(404).json({ error: 'App not found' });
      res.json({ ...info, deployProgress: appDeployStatus.read(req.params.slug) });
    } catch (err) {
      log.error('apps', 'Failed to get app version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Per-app secrets (see services/app-secrets.js + app-manifest.js).
  //
  // GET   /api/apps/:slug/secrets         — combined manifest+stored view
  //                                         (everyone with app access)
  // PUT   /api/apps/:slug/secrets/:key    — admin-only direct set
  // DELETE /api/apps/:slug/secrets/:key   — admin-only direct delete
  // POST  /api/apps/:slug/redeploy        — admin-only manual redeploy
  //                                         (used after fixing missing
  //                                         secrets; also reachable from
  //                                         the secret_change vote-apply
  //                                         path in routes/issues.js)
  //
  // Non-admins propose a secret change via POST /api/apps/:slug/issues
  // with kind='secret_change' (handled in routes/issues.js).
  //
  // ALL THREE BRANCH ON `self_hosted`. For the platform's own app row the
  // store is `platform_env_values` via services/platform-env.js, not
  // `app_secrets`: that is the store the deploy resolves into
  // /opt/usernode/.env, so it is the only one where a write has any
  // effect. The branch is why this panel is the single surface for the
  // platform's configuration (the admin console's Platform variables
  // section was deleted in favour of it) — and why nothing here can leak
  // a platform value into a child container: platform-env.js has no path
  // to app-secrets.mergeForDeploy().
  //
  // Credential keys (JWT_SECRET, the GitHub App key, ADMIN_PASSWORD…) are
  // in app-manifest.PLATFORM_ENV_UNWRITABLE and refused by both mutations
  // regardless of who asks — a web form that could rewrite the platform's
  // own signing secret is a privilege-escalation path, not a feature.
  // ────────────────────────────────────────────────────────────────────

  // Shared refusal for a write to a key the deploy owns. Same wording on
  // the direct route and the vote route so the two can't disagree about
  // why a key is off limits.
  const UNWRITABLE_MESSAGE =
    'This variable is set by the deploy from a GitHub secret and cannot be edited here.';

  // Direct (full-admin) write of one platform variable. Called from the PUT
  // route's self_hosted branch; the caller has already enforced
  // canAdminWrite and a non-empty value.
  //
  // Three properties this must keep, all of which the deleted admin-console
  // route also had:
  //   - Shape rules live in the DAO (isWritableKey / validateValue) so the
  //     route and setValue() can never disagree about what is storable.
  //   - The write takes ADMIN_MUTATION_LOCK inside a transaction, so two
  //     admins editing the same key serialize instead of interleaving.
  //   - The VALUE never reaches a log line or an event — only the key, its
  //     privacy flag, and who changed it.
  async function setPlatformVariable(req, res, app) {
    const key = String(req.params.key || '');
    // Trimmed before anything else looks at it (see
    // platform-env.normalizeValue): a pasted value's surrounding
    // whitespace is invisible in the panel and would otherwise survive
    // all the way into /opt/usernode/.env. The DAO normalizes too — this
    // call is what makes a whitespace-only value a 400 from here rather
    // than a throw from setValue() caught into a 500 below.
    const value = platformEnv.normalizeValue(
      typeof req.body?.value === 'string' ? req.body.value : null
    );

    if (!platformEnv.isWritableKey(key)) {
      log.warn('apps', 'Platform-env write refused: unwritable key', {
        key, by: req.user.username,
      });
      return res.status(400).json({ error: UNWRITABLE_MESSAGE });
    }
    const invalid = platformEnv.validateValue(value);
    if (invalid) return res.status(400).json({ error: invalid });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
      const result = await platformEnv.setValue(client, app.id, key, value, {
        userId: req.user.id,
        dataKey: config.dataEncryptionKey,
      });
      await client.query('COMMIT');

      log.info('apps', 'Platform env var set', {
        key, private: result.private, by: req.user.username,
      });
      events.record(pool, {
        type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
        userId: req.user.id,
        appId: app.id,
        metadata: { key, action: 'set', private: result.private, appliedBy: 'admin-direct' },
      });
      return res.json({ ok: true, key, private: result.private });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('apps', 'Platform-env write failed', { key, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }

  // Direct (full-admin) clear of one platform variable. Deleting an
  // unwritable key's row is refused for the same reason setting it is:
  // nothing legitimate ever created one.
  async function clearPlatformVariable(req, res, app) {
    const key = String(req.params.key || '');
    if (!platformEnv.isWritableKey(key)) {
      return res.status(400).json({ error: UNWRITABLE_MESSAGE });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
      const removed = await platformEnv.deleteValue(client, app.id, key);
      await client.query('COMMIT');

      if (!removed) return res.status(404).json({ error: 'No value set for that variable' });

      log.info('apps', 'Platform env var cleared', { key, by: req.user.username });
      events.record(pool, {
        type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
        userId: req.user.id,
        appId: app.id,
        metadata: { key, action: 'clear', appliedBy: 'admin-direct' },
      });
      return res.json({ ok: true, key });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('apps', 'Platform-env delete failed', { key, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }

  // Resolve the platform repo's Actions secrets for the panel, or the
  // reason we can't. Returns { state, reason?, result?, staged? } where
  // state is 'ok' | 'unavailable'.
  //
  // In STAGING the live fetch essentially always fails — a self-app
  // staging container boots with GITHUB_APP_ID / GITHUB_BOT_TOKEN empty
  // (their `staging_default: ""` in the platform's own dapp.json) — so the
  // group would only ever render its unavailable state in a PR preview.
  // Fall back to an obviously-fake staged list there, the same
  // request-time demo-injection pattern routes/issues.js
  // stagingMockGovernance() uses. Strictly a no-op outside staging.
  async function resolveActionsSecrets(app) {
    const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    let result = null;
    if (!github.isEnabled() || !owner || !repo) {
      result = {
        ok: false,
        code: 'disabled',
        message: 'GitHub is not configured on this platform, so its Actions secrets can\'t be listed.',
      };
    } else {
      result = await github.listActionsSecrets(owner, repo.replace(/\.git$/, ''));
    }
    if (result.ok) return { state: 'ok', result };

    const staged = stagingMockActionsSecrets();
    if (staged) return { state: 'ok', result: staged, staged: true };
    return { state: 'unavailable', reason: result.message, result: null };
  }

  // Fold the keys with a declaration PR in flight into the panel view.
  // A key nobody has a row for yet becomes a `state: 'proposed'` row; a
  // key whose value an admin already wrote directly keeps its existing
  // row and just carries the `pending` pointer, so the panel can say
  // "value set, declaration up for vote".
  async function mergePendingDeclarations(view, app) {
    let pending;
    try {
      pending = await pendingSecrets.listLive(pool, app.id);
    } catch (err) {
      log.warn('apps', 'Pending-declaration lookup failed', { slug: app.slug, message: err.message });
      return view;
    }
    if (!pending.length) return view;

    const out = view.slice();
    const byKey = new Map(out.map((r, i) => [r.key, i]));
    for (const p of pending) {
      const pointer = {
        sessionId: p.sessionId,
        prNumber: p.prNumber,
        prUrl: p.prUrl,
        valueApplied: p.valueApplied,
        proposedBy: p.createdBy,
      };
      const at = byKey.get(p.key);
      if (at != null) {
        const row = { ...out[at], pending: pointer };
        // A value with no declaration normally means "removed from
        // dapp.json, value kept for a rollback" — which is what the admin
        // path here looks like from the store's point of view, since the
        // declaration is still only in the PR. It is the opposite
        // situation, so don't render it as an orphan and tell the user to
        // clear it: it is a brand-new key whose declaration is up for vote.
        if (row.state === 'orphan') {
          row.state = 'set';
          row.orphan = false;
          if (p.description) row.description = p.description;
          if (p.group) row.group = p.group;
          row.required = p.required;
        }
        out[at] = row;
        continue;
      }
      out.push({
        key: p.key,
        description: p.description,
        required: p.required,
        private: p.private,
        sensitive: p.private,
        default: p.default,
        stagingDefault: p.stagingDefault,
        hasValue: p.hasValue,
        value: null,
        valueLast4: p.valueLast4,
        updatedAt: p.createdAt,
        updatedBy: p.createdBy,
        unwritable: false,
        orphan: false,
        state: 'proposed',
        ...(app.self_hosted ? { group: p.group } : {}),
        pending: pointer,
      });
    }
    return out;
  }

  // Can this user open a declaration proposal on this app, and if not, why?
  // Mirrors the gates POST /secret-declaration-pr enforces so the button's
  // disabled reason and the route's refusal can't disagree.
  async function describeDeclareAbility(app, user) {
    if (!app.repo_url || !(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/)) {
      return { canDeclare: false, reason: 'This app has no GitHub repository to open a proposal against.' };
    }
    if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
      return {
        canDeclare: false,
        reason: 'Declaring a variable needs GitHub configured on the platform (GITHUB_BOT_TOKEN).',
      };
    }
    return { canDeclare: true, reason: null };
  }

  router.get('/api/apps/:slug/secrets', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, slug, repo_url, manifest_snapshot, self_hosted, collab_visibility, view_visibility FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      // Secrets metadata is a build surface — collab-level access.
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'collab'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      // SELF-HOSTING.md sub-step 2j: 404 self-hosted secrets to
      // non-admins as well; otherwise the listing reveals declared
      // secret keys for the platform itself.
      //
      // Phase 4 (SELF_APP_PUBLIC_VOTING): when the flag is on, expose
      // the view to all users, because proposing a platform-variable
      // change by vote is now open to everyone and you can't propose a
      // change to a list you can't see. PLAINTEXT is still admin-only
      // (see includeValues below), so for a non-admin this stays
      // metadata-only disclosure of information the committed dapp.json
      // already carries — consistent with "open-source-by-live-dev-chat".
      if (app.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot
        : { secrets: [] };
      let view;
      // The platform repo's Actions secrets (metadata only), admins only —
      // the same gate that decides `includeValues`. Names are already
      // public in the committed deploy.yml, so this isn't a disclosure
      // question; it's that nobody else can act on these rows and each
      // panel open otherwise costs a GitHub call. Fails open: a
      // `githubSecrets.state` of 'unavailable' prints one line and the
      // rest of the panel renders exactly as before.
      let githubSecrets = null;
      if (app.self_hosted) {
        // Platform variables. Non-private values ARE shown in full to
        // admins — that's the point of marking a variable non-private,
        // and it's what makes "is MAX_GLOBAL_SESSIONS actually 75 in
        // prod?" answerable from the panel. Non-admins get no data key
        // passed, so listView() never decrypts anything for them.
        const includeValues = !!req.user?.isAdmin;
        const actions = includeValues
          ? await resolveActionsSecrets(app)
          : { state: 'hidden', result: null };
        githubSecrets = {
          state: actions.state,
          reason: actions.reason || null,
          count: actions.result?.ok ? actions.result.secrets.length : 0,
          fetchedAt: actions.state === 'ok' ? new Date().toISOString() : null,
          staged: !!actions.staged,
        };
        const rows2 = await platformEnv.listView(
          pool, app.id, includeValues ? config.dataEncryptionKey : null
        );
        view = platformSecretsView(rows2, manifest, {
          includeValues,
          actionsSecrets: actions.result?.ok ? actions.result : null,
        });
      } else {
        view = await appSecrets.getRedactedView(pool, app.id, manifest);
      }

      // Keys with a declaration PR in flight. A pending key has no row in
      // either store yet (or, on the admin path, a value row and no
      // declaration), so without this the panel would show nothing for a
      // variable somebody just proposed — and a second person would open a
      // duplicate proposal.
      view = await mergePendingDeclarations(view, app);

      const declare = await describeDeclareAbility(app, req.user);

      res.json({
        secrets: view,
        manifestKnown: !!app.manifest_snapshot,
        // Whether the "+ New variable" affordance is offered, and if not,
        // why — so the client renders the real reason instead of guessing.
        canDeclare: declare.canDeclare,
        declareDisabledReason: declare.reason,
        // Platform-only: the read-only Actions-secrets group's meta.
        githubSecrets,
        // `scope` drives the panel's wording: a platform variable takes
        // effect on the next platform deploy, an app secret on the next
        // rebuild of that app.
        scope: app.self_hosted ? 'platform' : 'app',
        // The "redeploy now" footer shortcut hits POST /redeploy, which
        // refuseIfSelfHosted still rejects for the platform — don't offer
        // a button that can only 403.
        redeployable: !app.self_hosted,
        // Retained for older clients that gated their write controls on
        // it. Writes are no longer blanket-refused for the self-app, so
        // it is false everywhere now; per-row `unwritable` is the real
        // signal.
        readOnly: false,
      });
    } catch (err) {
      log.error('apps', 'Failed to list secrets', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/apps/:slug/secrets/:key', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    // Trimmed before the emptiness check, so a whitespace-only value is a
    // 400 here rather than passing this gate and throwing inside
    // appSecrets.setValue() (which the catch below would turn into a 500).
    const value = appSecrets.normalizeValue(
      req.body && typeof req.body.value === 'string' ? req.body.value : ''
    );
    if (!value.length) return res.status(400).json({ error: 'value is required' });

    try {
      const { rows } = await pool.query(
        'SELECT id, manifest_snapshot, self_hosted FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (app.self_hosted) {
        return setPlatformVariable(req, res, app);
      }
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot
        : { secrets: [] };

      const declared = (manifest.secrets || []).find((s) => s.key === req.params.key);
      // Allow setting non-declared keys too (orphan cleanup / pre-declaration
      // bootstrapping) but enforce the same key shape. The deploy paths
      // only ever inject declared keys, so an orphan stays unused unless
      // the manifest grows to include it later.
      if (!declared && !appManifest.KEY_RE.test(req.params.key)) {
        return res.status(400).json({ error: 'Invalid key format' });
      }
      if (!declared && appManifest.RESERVED_KEYS.has(req.params.key)) {
        return res.status(400).json({ error: 'This key is reserved by the platform' });
      }

      await appSecrets.setValue(pool, app.id, req.params.key, value, {
        sensitive: !!declared?.private,
        userId: req.user.id,
        dataKey: config.dataEncryptionKey,
      });
      log.info('apps', 'Secret set (admin direct)', {
        slug: req.params.slug, key: req.params.key, userId: req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to set secret', {
        slug: req.params.slug, key: req.params.key, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/apps/:slug/secrets/:key', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    try {
      const { rows } = await pool.query('SELECT id, self_hosted FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      if (rows[0].self_hosted) {
        return clearPlatformVariable(req, res, rows[0]);
      }
      await appSecrets.deleteValue(pool, rows[0].id, req.params.key);
      log.info('apps', 'Secret deleted (admin direct)', {
        slug: req.params.slug, key: req.params.key, userId: req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to delete secret', {
        slug: req.params.slug, key: req.params.key, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Declare a BRAND-NEW secret / platform variable.
  //
  // The panel's other write paths set the VALUE of a key `dapp.json`
  // already declares. This one adds the key itself, which means editing
  // the manifest — and the manifest only ever changes through a merged PR
  // (services/rename-pr.js is its single writer). So one request produces
  // one proposal: a `secret-declare/*` PR appending the declaration, plus
  // the value, which either lands immediately (a full admin, who may
  // already write values directly) or waits in
  // `pending_secret_declarations` until routes/votes.js finalizeMerge()
  // applies it.
  //
  // Scope follows `self_hosted`, exactly like the value routes above:
  // a child app's key goes in `secrets`, the platform's in `platform_env`
  // (a tunable in the platform's `secrets` block would be silently inert —
  // see app-conventions.md "Editing the PLATFORM itself").
  // ────────────────────────────────────────────────────────────────────
  const MAX_DECLARED_VALUE_LENGTH = 4096;   // matches issues.js MAX_SECRET_VALUE_LENGTH
  const MAX_DECL_DESC_LEN = 400;            // matches MAX_PLATFORM_ENV_DESC_LEN
  const MAX_DECL_DEFAULT_LEN = 2048;        // matches MAX_PLATFORM_ENV_DEFAULT_LEN
  const MAX_DECL_GROUP_LEN = 48;            // matches MAX_PLATFORM_ENV_GROUP_LEN

  router.post('/api/apps/:slug/secret-declaration-pr', drainGuard, issueCreateLimiter, async (req, res) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    // Trimmed up front so every value rule below (the length cap, the
    // required-needs-a-value rule, .env representability) and every
    // downstream write — the immediate admin write, the held pending value —
    // all see the same normalized string. Both DAOs implement the identical
    // rule, so either normalizeValue serves both scopes.
    const value = platformEnv.normalizeValue(
      typeof body.value === 'string' ? body.value : ''
    );
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const defaultValue = typeof body.default === 'string' && body.default.length ? body.default : null;
    const stagingDefault = typeof body.stagingDefault === 'string' && body.stagingDefault.length
      ? body.stagingDefault : null;
    const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : 'General';
    const required = !!body.required;
    const isPrivate = !!body.private;

    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];

      // Same access shape the secrets panel itself has: collab-level, and
      // for the self-app the Phase-4 public-voting gate. Deliberately NOT
      // canManageApp — proposing an env-var change is the `secret_change`
      // authority level, which any collaborator already has.
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'collab'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (app.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }

      const scope = app.self_hosted ? 'platform' : 'app';

      // Key shape + the reserved/unwritable sets. For the platform,
      // isWritableKey() covers PLATFORM_ENV_UNWRITABLE *and* both reserved
      // sets in one call, and the refusal reuses the shared message so the
      // direct write, the vote path, and this route can't disagree about
      // why a key is off limits.
      if (!appManifest.KEY_RE.test(key)) {
        return res.status(400).json({ error: 'Key must be UPPER_SNAKE_CASE (letters, digits and underscores).' });
      }
      if (scope === 'platform') {
        if (!platformEnv.isWritableKey(key)) {
          return res.status(400).json({ error: UNWRITABLE_MESSAGE });
        }
      } else if (appManifest.RESERVED_KEYS.has(key)
        || appManifest.RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
        return res.status(400).json({ error: `${key} is reserved by the platform` });
      }

      // Collision: the manifest snapshot, the value store, and any live
      // declaration proposal. Pointing at the existing row/proposal beats
      // a second entry for the same key.
      const manifest = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
        ? app.manifest_snapshot : { secrets: [] };
      const declaredHere = scope === 'platform'
        ? (manifest.platform_env || []).find((s) => s.key === key)
        : (manifest.secrets || []).find((s) => s.key === key);
      // The platform's `secrets` block documents the GitHub-injected
      // credentials; platformSecretsView already renders a read-only row
      // for each, so declaring the same key as a tunable would be two rows
      // for one variable.
      const documentedAsDeployOwned = scope === 'platform'
        && (manifest.secrets || []).some((s) => s.key === key);
      if (declaredHere || documentedAsDeployOwned) {
        return res.status(409).json({ error: `${key} already exists. Use its row in the panel.` });
      }
      const { rows: valueRows } = await pool.query(
        scope === 'platform'
          ? 'SELECT key FROM platform_env_values WHERE app_id = $1 AND key = $2'
          : 'SELECT key FROM app_secrets WHERE app_id = $1 AND key = $2',
        [app.id, key]
      );
      if (valueRows.length) {
        return res.status(409).json({ error: `${key} already has a stored value. Use its row in the panel.` });
      }
      const alreadyPending = await pendingSecrets.findLiveByKey(pool, app.id, key);
      if (alreadyPending) {
        return res.status(409).json({
          error: `${key} is already up for vote`,
          sessionId: alreadyPending.sessionId,
          prNumber: alreadyPending.prNumber,
          prUrl: alreadyPending.prUrl,
        });
      }

      // Field bounds mirroring the manifest readers, so nothing committed
      // here is silently trimmed when the manifest is read back.
      if (description.length > MAX_DECL_DESC_LEN) {
        return res.status(400).json({ error: `Description must be ≤ ${MAX_DECL_DESC_LEN} characters.` });
      }
      if (defaultValue && defaultValue.length > MAX_DECL_DEFAULT_LEN) {
        return res.status(400).json({ error: `Default must be ≤ ${MAX_DECL_DEFAULT_LEN} characters.` });
      }
      if (stagingDefault && stagingDefault.length > MAX_DECL_DEFAULT_LEN) {
        return res.status(400).json({ error: `Staging default must be ≤ ${MAX_DECL_DEFAULT_LEN} characters.` });
      }
      if (group.length > MAX_DECL_GROUP_LEN) {
        return res.status(400).json({ error: `Group must be ≤ ${MAX_DECL_GROUP_LEN} characters.` });
      }
      if (scope === 'platform'
        && (manifest.platform_env || []).length >= appManifest.MAX_PLATFORM_ENV) {
        return res.status(400).json({
          error: `The platform already declares the maximum of ${appManifest.MAX_PLATFORM_ENV} variables.`,
        });
      }

      // Value rules. A value is optional — a declaration that only
      // documents a committed default is legitimate — but a `required`
      // variable with neither a value nor a default would block the very
      // deploy this proposal produces.
      if (value.length > MAX_DECLARED_VALUE_LENGTH) {
        return res.status(400).json({
          error: `Value must be ≤ ${MAX_DECLARED_VALUE_LENGTH} characters.`,
        });
      }
      if (required && !value.length && !defaultValue) {
        return res.status(400).json({ error: 'A required variable needs either a value or a default.' });
      }
      if (scope === 'platform' && value.length) {
        // Representability in the platform's single-quoted .env line —
        // rejected now rather than accepted and silently dropped by a
        // deploy days later.
        const unrepresentable = platformEnv.validateValue(value);
        if (unrepresentable) return res.status(400).json({ error: unrepresentable });
      }
      if (scope === 'app' && required && isPrivate && !stagingDefault && !defaultValue) {
        // staging.buildAndDeployStaging would throw
        // PrivateSecretMissingStagingDefaultError on this proposal's OWN
        // preview: a private value is never propagated into staging, so a
        // required+private entry must commit a fallback.
        return res.status(400).json({
          error: "PR previews of this app won't boot without a staging default for a required private secret.",
        });
      }

      // GitHub preconditions — same three guards and wording as
      // visibility-pr / governance-pr / admins-pr.
      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Declaring a variable needs GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      if (!(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/)) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      const declaration = pendingSecrets.normalizeDeclaration({
        description,
        required,
        private: isPrivate,
        default: defaultValue,
        staging_default: scope === 'app' ? stagingDefault : null,
        group: scope === 'platform' ? group : null,
      });

      const result = await renamePr.createSecretDeclarationPR(
        config, pool, app,
        { scope, key, declaration, hasValue: !!value.length },
        { id: req.user.id, username: req.user.username }
      );

      // Value handling, only after the PR exists — a failed proposal must
      // not leave a value behind.
      //
      // A full admin's value lands NOW, through the same DAO path the PUT
      // route uses (both stores accept a not-yet-declared key: that's the
      // pre-declaration bootstrapping the PUT route and
      // platform-env.setValue already document). For a child app it stays
      // inert until the declaration merges, because mergeForDeploy only
      // injects declared keys. Everyone else's value waits in
      // pending_secret_declarations and is applied by the merge.
      const applyNow = !!req.user?.canAdminWrite && !!value.length;
      if (applyNow) {
        if (scope === 'platform') {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
            await platformEnv.setValue(client, app.id, key, value, {
              userId: req.user.id,
              dataKey: config.dataEncryptionKey,
              privateHint: isPrivate,
            });
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
          events.record(pool, {
            type: events.EVENT_TYPES.PLATFORM_ENV_CHANGED,
            userId: req.user.id,
            appId: app.id,
            metadata: { key, action: 'set', private: isPrivate, appliedBy: 'admin-direct' },
          });
        } else {
          await appSecrets.setValue(pool, app.id, key, value, {
            sensitive: isPrivate,
            userId: req.user.id,
            dataKey: config.dataEncryptionKey,
          });
        }
      }

      await pendingSecrets.create(pool, {
        appId: app.id,
        sessionId: result.sessionId,
        scope,
        key,
        declaration,
        value: value.length ? value : null,
        userId: req.user.id,
        dataKey: config.dataEncryptionKey,
        valueApplied: applyNow,
      });

      // The VALUE never reaches a log line — only the key, its privacy
      // flag, and who proposed it.
      log.info('apps', 'Secret declaration proposed', {
        slug: app.slug, scope, key, private: isPrivate,
        hasValue: !!value.length, valueApplied: applyNow,
        prNumber: result.prNumber, by: req.user.username,
      });

      res.status(201).json({
        ok: true,
        key,
        scope,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        valueApplied: applyNow,
        hasValue: !!value.length,
      });
    } catch (err) {
      log.error('apps', 'Secret declaration PR failed', {
        slug: req.params.slug, message: err.message,
      });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Trigger a fresh `rebuildProduction`. Used after admins fix missing
  // secrets to retry a deploy from `awaiting_secrets`/`error` (also used
  // by the secret_change vote-apply path). Returns immediately; the
  // rebuild streams progress via the existing `app_redeploy_status` WS
  // event so the UI's version pill flips to its yellow spinning state.
  router.post('/api/apps/:slug/redeploy', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (refuseIfSelfHosted(app, res)) return;
      if (!app.repo_url) {
        return res.status(400).json({ error: 'This app is not backed by a GitHub repo' });
      }
      // Fire-and-forget: same fan-out as the drift-poller and dev-chat
      // merge paths use. Errors land on the deploy-status broadcast.
      staging.rebuildProduction(config, app)
        .then(async ({ containerId, sha }) => {
          await pool.query(
            `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                             last_deploy_at = NOW()
             WHERE id = $3`,
            [containerId, sha || null, app.id]
          );
        })
        .catch((err) => {
          log.warn('apps', 'Manual redeploy failed', { slug: app.slug, err: err.message });
        });
      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Redeploy kickoff failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin-only "Check for updates" button. Runs the same per-app drift
  // check the periodic poller does, but on demand. Returns a structured
  // result so the UI can show a useful toast (no_drift / redeployed /
  // rebuild_failed / fetch_failed). Only meaningful for repo-backed
  // apps; rejects with 400 otherwise. `manual` skips the poller's
  // backoff on a commit that has failed to rebuild before: an admin
  // pressing this has usually just fixed the thing that was failing.
  router.post('/api/apps/:slug/check-updates', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    try {
      const { rows } = await pool.query(
        'SELECT id, slug, repo_url, main_sha, self_hosted FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (refuseIfSelfHosted(app, res)) return;
      if (!app.repo_url) {
        return res.status(400).json({ error: 'This app is not backed by a GitHub repo' });
      }
      const result = await driftPoller.checkAndRedeployOne(config, pool, app, { manual: true });
      res.json(result);
    } catch (err) {
      log.error('apps', 'Manual drift check failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Rename an app by opening a PR that edits (or creates) the top-level
  // `name` field in the repo's dapp.json. The rename does NOT take effect
  // immediately — the PR drops into the existing vote panel as a promoted
  // chat_sessions row and, when it reaches majority and merges, the prod
  // rebuild re-reads dapp.json and reconciles apps.name (see
  // services/app-manifest.js reconcileAppName + staging.rebuildProduction).
  // This replaces the old issue-based rename proposal in routes/issues.js.
  router.post('/api/apps/:slug/rename', drainGuard, issueCreateLimiter, async (req, res) => {
    const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';
    if (!newName) {
      return res.status(400).json({ error: 'newName is required' });
    }
    if (newName.length < 3) {
      return res.status(400).json({ error: 'Name must be at least 3 characters' });
    }
    if (newName.length > appManifest.MAX_APP_NAME_LENGTH) {
      return res.status(400).json({
        error: `Name must be ${appManifest.MAX_APP_NAME_LENGTH} characters or fewer`,
      });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      if (newName.toLowerCase() === (app.name || '').toLowerCase()) {
        return res.status(400).json({ error: 'App is already named that' });
      }

      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Renames need GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      const repoMatch = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!repoMatch) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      // Open the rename PR + promoted vote session via the shared helper
      // (services/rename-pr.js) — the exact same code path the boot
      // migration uses to drain legacy rename issues.
      const result = await renamePr.createRenamePR(
        config, pool, app, newName, { id: req.user.id, username: req.user.username }
      );

      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      });
    } catch (err) {
      log.error('apps', 'Rename PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Toggle the admin-gated change lock (admin only). When locked=true,
  // applying any group-voted change (PR merge, rename proposal, secret
  // change) additionally requires at least one admin yes/up vote on top
  // of the existing active-user majority — enforced in routes/votes.js
  // (checkAndMerge) and routes/issues.js (maybeApplyRenameProposal /
  // maybeApplySecretChangeProposal) via services/admin-approval.js.
  //
  // The home-card lock icon is the canonical UI affordance. We post a
  // system chat message + broadcast `app_update` so every viewer's card
  // and group-chat history reflects the change without a reload.
  router.post('/api/apps/:slug/lock', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    const { locked } = req.body || {};
    if (typeof locked !== 'boolean') {
      return res.status(400).json({ error: 'locked (boolean) required in body' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE apps SET locked = $1 WHERE slug = $2
         RETURNING id, slug, locked`,
        [locked, req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];

      const { sendSystemMessage, pushAppUpdate } = require('../services/ws');
      await sendSystemMessage(pool, app.id,
        locked
          ? `${req.user.username} locked this app, so merges now also require an admin yes vote`
          : `${req.user.username} unlocked this app, so merges no longer require an admin yes vote`,
        'system'
      ).catch((err) => log.warn('apps', 'Lock chat msg failed', { err: err.message }));

      pushAppUpdate({
        action: 'lock_changed',
        appSlug: app.slug,
        appId: app.id,
        locked: app.locked,
      });

      log.info('apps', 'Lock toggled', { slug: app.slug, locked, by: req.user.username });
      res.json({ ok: true, locked: app.locked });
    } catch (err) {
      log.error('apps', 'Lock toggle failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Resume merges while main's unit suite is red (services/main-watch.js).
  // The pause is the safety net under direct merges — a merge commit whose
  // suite failed stops every further merge on the app until a fix lands.
  // This is the admin's "I know, let them through": it applies to exactly
  // the red sha the app is paused on, so the next red is a new pause. The
  // cheaper way out is still to merge the fix; this is for when the red is
  // a flake, an unrelated breakage, or the fix IS the proposal waiting.
  router.post('/api/apps/:slug/main-check/resume', drainGuard, async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Full admin access required' });
    try {
      const { rows } = await pool.query('SELECT id, slug FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const mainWatch = require('../services/main-watch');
      const resumed = await mainWatch.resume(config, pool, rows[0].id, { by: req.user });
      if (!resumed) {
        return res.status(409).json({ error: 'Merges are not paused for this app' });
      }
      res.json({ ok: true, mainCheck: resumed });
    } catch (err) {
      log.error('apps', 'Main-check resume failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Propose a visibility change (issue #124). The two statuses live in
  // dapp.json's top-level `visibility` block, so changing them is a
  // manifest-editing PR — same lifecycle as a rename: the PR drops into
  // the vote panel, and when it merges, the production rebuild's
  // reconcileAppVisibility applies the change (with the transition
  // semantics — pending-invite cleanup etc. — in
  // services/app-manifest.js applyVisibilityChange). The old instant
  // PATCH /api/apps/:slug/visibility is gone; admins fast-track by
  // force-merging the PR (POST /api/sessions/:id/admin-merge).
  router.post('/api/apps/:slug/visibility-pr', drainGuard, issueCreateLimiter, async (req, res) => {
    const collabVisibility = req.body?.collabVisibility;
    const viewVisibility = req.body?.viewVisibility;
    const visibilityError = validateVisibilityCombo(collabVisibility, viewVisibility);
    if (visibilityError) {
      return res.status(400).json({ error: visibilityError });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      // Non-viewers get the existence-hiding 404; viewers without manage
      // rights get an honest 403. Proposer scope stays creator/admin —
      // same authority the old instant switch had (any collaborator can
      // still reach the same outcome via a dev session editing the file).
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!(await appAdmins.canManageApp(pool, app, req.user))) {
        return res.status(403).json({ error: 'Only the app creator or an admin can propose a visibility change' });
      }
      if (refuseIfSelfHosted(app, res)) return;

      if (app.collab_visibility === collabVisibility
          && app.view_visibility === viewVisibility) {
        return res.status(400).json({ error: 'The app already has that visibility' });
      }

      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Visibility changes need GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      if (!(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/)) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      // One visibility proposal in flight per app — point the caller at
      // the open one instead of stacking PRs.
      const existing = await renamePr.findVisibilityPr(pool, app.id);
      if (existing) {
        return res.status(409).json({
          error: 'A visibility change is already up for vote',
          sessionId: existing.id,
          prNumber: existing.pr_number,
          prUrl: existing.pr_url,
        });
      }

      const result = await renamePr.createVisibilityPR(
        config, pool, app,
        { collab: collabVisibility, view: viewVisibility },
        { id: req.user.id, username: req.user.username }
      );

      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      });
    } catch (err) {
      log.error('apps', 'Visibility PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Propose a proposal-approval governance change (issue #646). The two
  // settings live in dapp.json's top-level `governance` block, so
  // changing them is a manifest-editing PR — same lifecycle as a
  // visibility change. Unlike visibility-pr, the self-hosted platform
  // app is ALLOWED: its dapp.json lives in the platform repo and the
  // merged change applies on the post-deploy boot (seedSelfApp's
  // reconcileAppGovernance).
  // Body: { approverPolicy: 'anyone'|'invited',
  //         approvalsRequired: null | 1..MAX_APPROVALS_REQUIRED,
  //         initialApprovers?: string[] }.
  // `initialApprovers` (capped at MAX_INITIAL_APPROVERS) is the roster
  // picked in the panel's "Initial approvers" step when switching to
  // 'invited': approver invites are sent as soon as the PR opens (not
  // at merge time), so invitees can accept while the vote runs —
  // pending rows are harmless under 'anyone' (they only count once
  // accepted AND the policy lands). Ignored for 'anyone'; per-user
  // failures never fail the proposal, they come back as
  // `inviteWarnings` on the 201.
  // ── Per-app admins (issue #788) ───────────────────────────────────
  //
  // Read-only. The roster's ONLY writer is the deploy-time reconcile
  // (services/app-manifest.js reconcileAppAdmins) reading dapp.json's
  // top-level `admins` block, so there is deliberately no PUT/POST
  // here — changing admins means opening a PR that edits the manifest,
  // and that PR needs explicit approval to land.
  //
  // Collab-level read, matching the collaborator + approver rosters.
  // `declared` is the manifest's list verbatim (which is what the panel
  // renders); `unresolved` calls out names that match no registered
  // user, so a typo'd or not-yet-signed-up admin is visible rather than
  // silently missing.
  router.get('/api/apps/:slug/admins', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab',
        appAccess.ACCESS_COLUMNS + ', admin_usernames'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT aa.user_id, u.username
           FROM app_admins aa JOIN users u ON u.id = aa.user_id
          WHERE aa.app_id = $1
          ORDER BY LOWER(u.username)`,
        [app.id]
      );
      const declared = Array.isArray(app.admin_usernames) ? app.admin_usernames : [];
      const resolvedLower = new Set(rows.map((r) => r.username.toLowerCase()));
      // `openProposal` lets the panel render the "already up for vote"
      // state on open instead of discovering it via the POST's 409.
      const openPr = await renamePr.findAdminsPr(pool, app.id);
      const payload = {
        admins: rows.map((r) => ({ userId: r.user_id, username: r.username })),
        declared,
        unresolved: declared.filter((u) => !resolvedLower.has(String(u).toLowerCase())),
        canManage: await appAdmins.canManageApp(pool, app, req.user),
        openProposal: openPr
          ? { sessionId: openPr.id, prNumber: openPr.pr_number, prUrl: openPr.pr_url }
          : null,
      };

      // Staging-only demo state (?demo=1): app_admins is a table this
      // change creates, so it is EMPTY in every staging clone and the
      // Members panel's new section would render blank in every PR
      // review. Request-time only — nothing is persisted, and this is a
      // strict no-op in production. Only fills an otherwise-empty
      // roster so a real one is never masked.
      if (IS_STAGING && req.query.demo === '1' && !payload.admins.length && !declared.length) {
        payload.admins = [
          { userId: 900001, username: 'staging-demo-admin' },
          { userId: 900002, username: 'staging-demo-maintainer' },
        ];
        payload.declared = ['staging-demo-admin', 'staging-demo-maintainer', 'staging-demo-unregistered'];
        payload.unresolved = ['staging-demo-unregistered'];
        payload.canManage = true;
        payload.openProposal = null;
      }

      res.json(payload);
    } catch (err) {
      log.error('apps', 'Failed to list app admins', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/apps/:slug/contributors — the ranked Contributors section on
  // the app-details page (#919: #apps/<slug>, frontend/src/features/apps/browse.js).
  //
  // VIEW-level, matching GET /api/apps/:slug/merged (routes/votes.js): this
  // is read-only history, so a non-collaborator who can see the app gets
  // it. Note the deliberate asymmetry with /collaborators, which is
  // collab-gated: this list includes members, but it discloses no name that
  // isn't already reachable — GET /api/public/apps/:slug/contributors
  // publishes the identical three-source union UNAUTHENTICATED for every
  // view-public non-self-hosted app, and on a view-private app "view
  // access" IS collaborators-plus-admins.
  //
  // Contributor set + ranking + counts all live in
  // services/contributors.js, shared with that public route so the two
  // surfaces can't drift. Deliberately NOT folded into the /api/apps list
  // payload: it's a per-app aggregate nothing on the home grid needs.
  router.get('/api/apps/:slug/contributors', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      // getAppForUser has no self_hosted branch, but GET /api/apps/:slug
      // 404s the self-app for non-admins when SELF_APP_PUBLIC_VOTING is
      // off — mirror it so this can never be read for an app whose own
      // details page doesn't exist for the caller. (The flag defaults on,
      // so this is inert today; it keeps the two routes honest.)
      if (app.self_hosted && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }

      const { items, total } = await contributors.loadRankedContributors(
        pool, app.id, { limit: req.query.limit }
      );

      // Staging mock data (#919): chat_sessions is `staging:private` and is
      // TRUNCATEd CASCADE into every staging clone (taking pr_votes with
      // it), so a preview has zero merges and zero votes for every app and
      // this section would review blank. Request-time only, replaces rather
      // than tops up (so the ?shot=browse-detail capture is deterministic
      // whichever cloned app it drills into), and a strict no-op in prod.
      const demo = contributors.demoRankedContributors(req);

      res.json({
        slug: app.slug,
        total: demo ? demo.total : total,
        contributors: demo ? demo.items : items,
      });
    } catch (err) {
      log.error('apps', 'Failed to list app contributors', {
        slug: req.params.slug, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Propose an app-admins change (issue #788). The roster lives in
  // dapp.json's top-level `admins` array, so changing it is a
  // manifest-editing PR — same lifecycle as a visibility change: the PR
  // drops into the vote panel, and when it merges, the production
  // rebuild's reconcileAppAdmins applies the change. Because it grants
  // app-level power, createAdminsPR stamps the session
  // requires_explicit_approval: no time-based merge path, and app
  // admins can't force-merge it (only a platform admin can).
  // Body: { admins: string[] } — the FULL declared list ([] clears the
  // roster; that's how revocation is expressed).
  router.post('/api/apps/:slug/admins-pr', drainGuard, issueCreateLimiter, async (req, res) => {
    const raw = req.body?.admins;
    if (!Array.isArray(raw) || raw.some((u) => typeof u !== 'string')) {
      return res.status(400).json({ error: 'admins must be an array of usernames' });
    }
    // Same normalization as appManifest.readAdmins: strip a leading @,
    // trim, drop empties, dedupe case-insensitively keeping the first
    // occurrence's display casing — so what we write is exactly what
    // the deploy reader will read back.
    const usernames = [];
    const seen = new Set();
    for (const entry of raw) {
      const name = entry.replace(/^@/, '').trim();
      if (!name) continue;
      if (name.length > appManifest.MAX_ADMIN_USERNAME_LENGTH) {
        return res.status(400).json({
          error: `Admin usernames are capped at ${appManifest.MAX_ADMIN_USERNAME_LENGTH} characters`,
        });
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      usernames.push(name);
    }
    if (usernames.length > appManifest.MAX_APP_ADMINS) {
      return res.status(400).json({
        error: `An app can declare at most ${appManifest.MAX_APP_ADMINS} admins`,
      });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      // Non-viewers get the existence-hiding 404, mirroring visibility-pr.
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!(await appAdmins.canManageApp(pool, app, req.user))) {
        return res.status(403).json({ error: 'Only the app creator or an app admin can propose an admins change' });
      }
      // Unlike governance-pr (whose reconcile runs on the post-deploy
      // boot's seedSelfApp), the self-app is REFUSED here like
      // visibility-pr: reconcileAppAdmins skips self_hosted apps —
      // per-app admins would inherit force-merge on platform proposals —
      // so a merged self-app admins PR would silently do nothing.
      if (refuseIfSelfHosted(app, res)) return;

      // Normalized compare (trim/lowercase/dedupe/sort), so re-ordering
      // or re-casing the same names is correctly a non-change.
      const curNorm = appAdmins.normalizeAdmins(app.admin_usernames);
      const nextNorm = appAdmins.normalizeAdmins(usernames);
      if (curNorm.length === nextNorm.length && curNorm.every((v, i) => v === nextNorm[i])) {
        return res.status(400).json({ error: 'The app already declares those admins' });
      }

      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Admin changes need GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      if (!(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/)) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      // One admins proposal in flight per app.
      const existing = await renamePr.findAdminsPr(pool, app.id);
      if (existing) {
        return res.status(409).json({
          error: 'An app-admins change is already up for vote',
          sessionId: existing.id,
          prNumber: existing.pr_number,
          prUrl: existing.pr_url,
        });
      }

      const result = await renamePr.createAdminsPR(
        config, pool, app,
        { usernames },
        { id: req.user.id, username: req.user.username }
      );

      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      });
    } catch (err) {
      log.error('apps', 'Admins PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/governance-pr', drainGuard, issueCreateLimiter, async (req, res) => {
    const approverPolicy = req.body?.approverPolicy;
    let approvalsRequired = req.body?.approvalsRequired;
    if (approverPolicy !== 'anyone' && approverPolicy !== 'invited') {
      return res.status(400).json({ error: 'approverPolicy must be "anyone" or "invited"' });
    }
    if (approvalsRequired === undefined || approvalsRequired === null || approvalsRequired === '') {
      approvalsRequired = null;
    } else {
      approvalsRequired = Number(approvalsRequired);
      if (!Number.isInteger(approvalsRequired) || approvalsRequired < 1
        || approvalsRequired > appManifest.MAX_APPROVALS_REQUIRED) {
        return res.status(400).json({
          error: `approvalsRequired must be an integer between 1 and ${appManifest.MAX_APPROVALS_REQUIRED} (or null for the default strategy)`,
        });
      }
    }
    let initialApprovers = req.body?.initialApprovers ?? [];
    if (!Array.isArray(initialApprovers) || initialApprovers.some((u) => typeof u !== 'string')) {
      return res.status(400).json({ error: 'initialApprovers must be an array of usernames' });
    }
    if (initialApprovers.length > MAX_INITIAL_APPROVERS) {
      return res.status(400).json({
        error: `initialApprovers is capped at ${MAX_INITIAL_APPROVERS} usernames`,
      });
    }
    // Trim + case-insensitive dedupe; the list only means something when
    // the target policy is 'invited'.
    if (approverPolicy === 'invited') {
      const seen = new Set();
      initialApprovers = initialApprovers
        .map((u) => u.trim())
        .filter((u) => {
          if (!u) return false;
          const k = u.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    } else {
      initialApprovers = [];
    }
    try {
      const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!rows.length) return res.status(404).json({ error: 'App not found' });
      const app = rows[0];
      if (!(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!(await appAdmins.canManageApp(pool, app, req.user))) {
        return res.status(403).json({ error: 'Only the app creator or an admin can propose a governance change' });
      }

      if (app.approver_policy === approverPolicy
          && (app.approvals_required ?? null) === (approvalsRequired ?? null)) {
        return res.status(400).json({ error: 'The app already has those approval settings' });
      }

      if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
        return res.status(503).json({
          error: 'Governance changes need GitHub configured on the platform (GITHUB_BOT_TOKEN).',
        });
      }
      if (!app.repo_url) {
        return res.status(400).json({ error: 'App has no GitHub repository to open a PR against' });
      }
      if (!(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/)) {
        return res.status(400).json({ error: 'Could not parse the app repository URL' });
      }

      // One governance proposal in flight per app.
      const existing = await renamePr.findGovernancePr(pool, app.id);
      if (existing) {
        return res.status(409).json({
          error: 'A governance change is already up for vote',
          sessionId: existing.id,
          prNumber: existing.pr_number,
          prUrl: existing.pr_url,
        });
      }

      const result = await renamePr.createGovernancePR(
        config, pool, app,
        { policy: approverPolicy, approvalsRequired },
        { id: req.user.id, username: req.user.username }
      );

      // Initial-approver invites go out only after the PR exists (a
      // failed proposal must not leave invites behind). Already-member /
      // already-pending users are a silent no-op; validation failures
      // become warnings, never a failed response — the proposal is open
      // either way.
      const inviteWarnings = [];
      for (const username of initialApprovers) {
        try {
          await approverInvites.inviteApprover(
            pool, app, username, { id: req.user.id, username: req.user.username }
          );
        } catch (err) {
          inviteWarnings.push(`@${username.replace(/^@/, '')}: ${err.message}`);
          if (!(err instanceof approverInvites.ApproverInviteError)) {
            log.warn('apps', 'Initial approver invite failed', {
              slug: app.slug, username, message: err.message,
            });
          }
        }
      }

      res.status(201).json({
        ok: true,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        ...(inviteWarnings.length ? { inviteWarnings } : {}),
      });
    } catch (err) {
      log.error('apps', 'Governance PR failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Edge-gate authorize hop (view-private apps) ─────────────────────
  //
  // Platform session cookies are host-only (deliberately — child apps
  // run user-authored code and must never see the platform credential),
  // so a direct visit to a view-private app's subdomain carries no
  // session for the edge gate (/__caddy/access in routes/internal.js)
  // to read. The gate bounces bare browser GETs here, to the apex,
  // where the session cookie IS present and authMiddleware has already
  // resolved req.user (or redirected to /login.html). We re-run the
  // standard view-level access check and, when allowed, send the
  // browser back to the app host with a 120s single-purpose grant the
  // gate exchanges for a per-host scoped access cookie. Non-members get
  // the same existence-hiding 404 every other surface returns.
  router.get('/__access/authorize', async (req, res) => {
    try {
      const parsed = appAccess.parseAppHost(req.query.host);
      if (!parsed) return res.status(404).send('Not found');
      const rawNext = typeof req.query.next === 'string' ? req.query.next : '/';
      const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

      const app = await appAccess.getAppForUser(
        pool, parsed.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).send('Not found');

      const grant = appAccess.mintAccessGrant({
        uid: req.user.id,
        appId: app.id,
        host: parsed.host,
      });
      return res.redirect(
        302,
        `https://${parsed.host}/__usernode_access`
          + `?grant=${encodeURIComponent(grant)}&next=${encodeURIComponent(next)}`
      );
    } catch (err) {
      log.error('apps', 'Edge authorize failed', { host: req.query.host, message: err.message });
      return res.status(500).send('Internal server error');
    }
  });

  // Delete an app. Full admins retain the operational override; otherwise
  // the app's creator may delete it only while they are its sole contributor.
  // The contributor count is read at mutation time (not trusted from the
  // list/detail payload) so a newly accepted member or merged author closes
  // the gate before any destructive teardown starts.
  //
  // #2161 adds three checks in front of the teardown, in this order:
  //   1. a core app (isCoreApp) is never deletable here, admins included;
  //   2. the typed app name is verified HERE, not only in the dialog, so a
  //      bare request cannot skip the confirmation the UI asks for;
  //   3. a shared app (other contributors exist) refuses a plain delete. The
  //      creator is turned away outright; a full admin must send
  //      acknowledge_shared:true, and the other contributors are notified of
  //      the attempt either way, and of the deletion when it goes through.
  //      The vote-backed path for shared apps is request #1898.
  router.delete('/api/apps/:slug', async (req, res) => {
    try {
      // #2523: resolve through the access wall, not a bare slug lookup.
      // This used to `SELECT * FROM apps WHERE slug = $1` with no check and
      // then branch on the row, so the three answers below were readable by
      // anyone: a 404 meant the slug was free, `reason: 'core'` meant it
      // existed and was a core app, and `reason: 'not_owner'` meant it
      // existed and was somebody else's. That is an existence-and-coreness
      // oracle for PRIVATE apps, reachable by any signed-in account, on a
      // verb where probing looks like nothing in particular.
      //
      // `getAppForUser` returns null both for a slug that does not exist and
      // for one this caller cannot see, so the two now answer identically.
      // 'view' rather than 'collab': the leak is about apps you cannot SEE.
      // Once an app is visible to you, that it is core — or not yours — is
      // not a secret, and a 404 there would be a lie about a row on screen.
      // Admins are unaffected (checkAppAccess short-circuits on isAdmin); a
      // VIEW-ONLY admin still passes here and is still refused by the
      // canAdminWrite eligibility check below, exactly as before.
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      // The core app carries its own gate, and `view_visibility` does not
      // express it: the seeded row is 'public', so the wall above lets a
      // non-admin through even when SELF_APP_PUBLIC_VOTING is off and the
      // platform app is meant to be admin-only. Without this the oracle
      // survives for the one app most worth probing — `reason: 'core'` would
      // still confirm it. Four other routes already stand behind this check
      // (lines ~1284, ~1690, ~1899, ~2507); this is the fifth.
      //
      // Keyed on `isCoreApp`, NOT on `self_hosted` alone. Those are not the
      // same test: isCoreApp also recognises a row by the configured
      // `selfAppSlug`, which is how a historical or staging platform row can
      // be core without the flag set. Using the narrower condition here
      // would leave exactly that row answering `reason: 'core'` to a
      // stranger — one definition of "core", used by both the gate and the
      // refusal it guards.
      if (isCoreApp(app, config.selfAppSlug)
        && !req.user?.isAdmin && !config.selfAppPublicVoting) {
        return res.status(404).json({ error: 'App not found' });
      }

      if (isCoreApp(app, config.selfAppSlug)) {
        return res.status(403).json({
          error: 'This is a core platform app. It cannot be deleted from the UI.',
          reason: 'core',
        });
      }

      const eligible = !!req.user?.canAdminWrite
        || (req.user?.id != null && app.created_by === req.user.id);
      if (!eligible) {
        return res.status(403).json({
          error: "Only a full admin or the app's sole contributor can delete this app",
          reason: 'not_owner',
        });
      }
      const counts = await contributors.loadContributorCounts(pool, [app.id]);
      const contributorCount = counts.get(app.id) || 0;
      const others = Math.max(0, contributorCount - 1);
      const blocked = deleteBlockReason(app, req.user, contributorCount, config.selfAppSlug);
      if (!canDeleteApp(app, req.user, contributorCount, config.selfAppSlug)) {
        if (blocked === 'shared') {
          await notifyDeleteAttempt(app, req.user);
          return res.status(403).json({
            error: `This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'}, `
              + 'so its creator cannot delete it alone. Deleting a shared app needs the group\'s agreement.',
            reason: 'shared',
            contributor_count: contributorCount,
          });
        }
        return res.status(403).json({
          error: "Only a full admin or the app's sole contributor can delete this app",
          reason: blocked,
        });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const confirmName = typeof body.confirm_name === 'string' ? body.confirm_name.trim() : '';
      if (!confirmName || confirmName !== String(app.name || '').trim()) {
        return res.status(400).json({
          error: "Type the app's exact name to confirm deletion.",
          reason: 'confirm_name',
        });
      }

      const shared = contributorCount > 1;
      if (shared && body.acknowledge_shared !== true) {
        await notifyDeleteAttempt(app, req.user);
        return res.status(409).json({
          error: `This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'} `
            + 'who have not agreed to this. Deleting a shared app is meant to go through a group '
            + 'vote. A platform admin can override by acknowledging the other contributors.',
          reason: 'shared',
          contributor_count: contributorCount,
        });
      }
      // Who to tell once the app is gone. Read BEFORE the teardown: the
      // contributor set is derived from rows the app delete cascades away.
      const recipients = shared ? await otherContributorIds(app, req.user) : [];

      // Teardown through the backend that owns this app. Historical rows
      // without runtime_kind/runtime_name remain Docker-compatible.
      if (app.runtime_name || app.container_id) {
        const applicationRuntime = require('../services/application-runtime');
        await applicationRuntime.remove(config, {
          runtimeKind: app.runtime_kind || 'docker',
          runtimeName: app.runtime_name || app.container_id,
          appId: app.id,
        }, { deleteBuilds: app.runtime_kind === 'kubernetes' }).catch(() => {});
        if (!app.runtime_kind || app.runtime_kind === 'docker') {
          await applicationRuntime.remove(config, {
            runtimeKind: 'docker', runtimeName: `usernode-app-${app.slug}`,
          }).catch(() => {});
        }
      }

      // No Caddy route to remove — the wildcard site maps hostnames to
      // container names dynamically, so removing the container above
      // takes the app offline. The on-demand cert lingers harmlessly and
      // the ask endpoint stops vouching once the app row is deleted below.

      // Drop app database
      const dbManager = require('../services/db-manager');
      await dbManager.dropDatabase(dbManager.appDbName(app.slug)).catch(() => {});

      // Remove the app's stored user files from the object store (#752)
      // BEFORE the row delete cascades away the app_files metadata.
      // Best-effort with a loud log: a failure here leaves orphaned
      // objects under app/<id>/ for manual cleanup, never a broken
      // delete.
      try {
        const appFilesSvc = require('../services/app-files');
        const store = appFilesSvc.getStore(config);
        if (store) {
          const removed = await store.removeAppPrefix(app.id);
          if (removed) log.info('apps', 'Removed app files from object store', { appId: app.id, count: removed });
        }
      } catch (err) {
        log.warn('apps', 'Object-store cleanup failed on app delete (orphans remain under app/<id>/)', {
          appId: app.id, err: err.message,
        });
      }

      // Delete from DB (cascades to chat_messages, sessions, etc.)
      await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
      appAccess.invalidateVisibility(app.id, app.slug);

      log.info('apps', 'App deleted', {
        appId: app.id, slug: app.slug, by: req.user?.id, shared, notified: recipients.length,
      });
      res.json({ ok: true });

      // Tell the other contributors after the fact. Best-effort: the app is
      // already gone, so a notification failure must not turn into a 500 for
      // a delete that succeeded.
      if (recipients.length) {
        const notifications = require('../services/notifications');
        notifications.createAppDeletedNotifications(pool, {
          appName: app.name, appSlug: app.slug, actorId: req.user?.id ?? null, recipientIds: recipients,
        }).catch((err) => {
          log.warn('apps', 'app_deleted notifications failed', { slug: app.slug, err: err.message });
        });
      }
    } catch (err) {
      log.error('apps', 'Failed to delete app', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The other contributors of `app` (the shared three-source set minus the
  // actor), for the two #2161 notifications above.
  async function otherContributorIds(app, user) {
    const byApp = await contributors.loadContributors(pool, [app.id]);
    const ids = (byApp.get(app.id) || []).map((c) => c.user_id);
    return [...new Set(ids)].filter((id) => id != null && id !== user?.id);
  }

  // A refused delete of a shared app is still news to the people who share
  // it. Best-effort and deduplicated in the service (one unread row per
  // recipient per app), so a retried click is not a second ping.
  async function notifyDeleteAttempt(app, user) {
    try {
      const recipients = await otherContributorIds(app, user);
      if (!recipients.length) return;
      const notifications = require('../services/notifications');
      await notifications.createAppDeleteAttemptNotifications(pool, {
        appId: app.id, actorId: user?.id ?? null, recipientIds: recipients,
      });
    } catch (err) {
      log.warn('apps', 'app_delete_attempted notifications failed', { slug: app.slug, err: err.message });
    }
  }

  // Retry a failed app. Allowed for the app's creator or any admin, capped
  // at MAX_RETRY_COUNT per app to avoid a stuck app burning budget forever.
  router.post('/api/apps/:slug/retry', drainGuard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM apps WHERE slug = $1 AND status = 'error'",
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'No failed app found' });

      const appRow = rows[0];

      const allowed = await appAdmins.canManageApp(pool, appRow, req.user);
      if (!allowed) {
        return res.status(403).json({ error: 'Only the app creator or an admin can retry' });
      }

      if (appRow.retry_count >= MAX_RETRY_COUNT && !req.user.canAdminWrite) {
        return res.status(429).json({
          error: `Retry limit reached (${MAX_RETRY_COUNT}). Ask an admin to investigate.`,
        });
      }

      // A failed fork with no repo must re-enter app-forker so it copies the
      // source. Sending it through createApp used to seed the starter
      // template, which made Retry "succeed" as the wrong app. If the fork
      // repo was already copied, forkApp resumes from that independent repo.
      let sourceApp = null;
      if (appRow.forked_from) {
        sourceApp = await findForkSource(pool, appRow);
        if (!sourceApp && !appRow.repo_url) {
          return res.status(409).json({
            error: 'The source app for this fork no longer exists, so the fork cannot be retried.',
          });
        }
        if (sourceApp && !appRow.repo_url) {
          if (!(await appAccess.checkAppAccess(pool, sourceApp, req.user, 'view'))) {
            return res.status(403).json({
              error: 'You no longer have access to the source app for this fork.',
            });
          }
          const readinessError = forkSourceReadinessError(sourceApp);
          if (readinessError) return res.status(409).json({ error: readinessError });
        }
      }

      await pool.query(
        `UPDATE apps
            SET status = 'creating', retry_count = retry_count + 1,
                last_failure = NULL
          WHERE id = $1`,
        [appRow.id]
      );

      const provision = appRow.forked_from
        ? forkApp(config, appRow, sourceApp)
        : createApp(config, appRow);
      provision.catch(async (err) => {
        log.error('apps', appRow.forked_from ? 'Retry fork failed' : 'Retry app creation failed', {
          appId: appRow.id, err: err.message,
        });
        await pool.query(
          `UPDATE apps SET status = 'error',
                           last_failure = COALESCE(last_failure, $2::jsonb)
           WHERE id = $1 AND status = 'creating'`,
          [appRow.id, JSON.stringify(deployFailure.record(err))]
        ).catch(() => {});
      });
      scheduleCreationWatchdog(pool, appRow.id);

      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Retry failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/favorite', async (req, res) => {
    const { favorited } = req.body;
    if (typeof favorited !== 'boolean') {
      return res.status(400).json({ error: 'favorited must be a boolean' });
    }
    try {
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      const { rows: appRows } = await pool.query(
        `SELECT ${appAccess.ACCESS_COLUMNS} FROM apps WHERE slug = $1 AND (NOT self_hosted OR $2::boolean)`,
        [req.params.slug, showSelfHosted]
      );
      if (appRows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (!(await appAccess.checkAppAccess(pool, appRows[0], req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appId = appRows[0].id;
      if (favorited) {
        // DO UPDATE (not DO NOTHING) so the same statement also clears a
        // member's hidden=TRUE opt-out row — "Add to Your apps" un-hides.
        await pool.query(
          `INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)
           ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = FALSE`,
          [appId, req.user.id]
        );
      } else if (await appAccess.isCollaborator(pool, appId, req.user.id)) {
        // #618: membership (creator or accepted invite) pins the app into
        // "Your apps", so a member's "remove" must persist as an explicit
        // opt-out row rather than a delete — a missing row means "pinned by
        // membership", not "removed". sort_order is cleared so a later
        // un-hide re-enters the section at the ordering fallback position.
        await pool.query(
          `INSERT INTO app_favorites (app_id, user_id, hidden, sort_order)
           VALUES ($1, $2, TRUE, NULL)
           ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = TRUE, sort_order = NULL`,
          [appId, req.user.id]
        );
      } else {
        await pool.query(
          'DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2',
          [appId, req.user.id]
        );
      }
      res.json({ ok: true, is_favorited: favorited });
    } catch (err) {
      log.error('apps', 'Failed to toggle favorite', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The community an app belongs to, as its page's community card draws it
  // (features/dev-board/workshop/community-card.tsx): who it is for, who is
  // in it, whether you are, and the rule a change has to meet to merge.
  // View-gated like the page itself — a private app's community is as
  // invisible to an outsider as the app.
  //
  // THE APPROVAL RULE IS READ, NOT RESTATED. `required` is what the merge
  // gate would ask of an unopposed proposal right now: the app's own
  // `approvals_required` when dapp.json sets one, otherwise
  // active-users.requiredVotes over the same electorate governance.js
  // counts (approvers on an invited-policy app, active members otherwise).
  // It is the headline number, not the whole gate — opposition raises it
  // and the lazy-consensus window can merge below it — and the card says
  // "to merge", not "exactly".
  router.get('/api/apps/:slug/community', async (req, res) => {
    try {
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      const { rows: appRows } = await pool.query(
        `SELECT ${appAccess.ACCESS_COLUMNS}, name,
                LEFT(manifest_snapshot->>'description', 280) AS description
           FROM apps WHERE slug = $1 AND (NOT self_hosted OR $2::boolean)`,
        [req.params.slug, showSelfHosted]
      );
      const app = appRows[0];
      if (!app || !(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      const membership = await communities.getMembership(pool, app, req.user?.id);
      const members = await communities.listMembers(pool, app.id);
      // The channel is the app's group chat, which is COLLAB-gated
      // (app-access.js): a viewer who may see a view-public,
      // collab-private app but not talk in it gets no row for it rather
      // than a preview of a room they cannot enter.
      const canChat = await appAccess.checkAppAccess(pool, app, req.user, 'collab');
      const channel = canChat ? await communities.channelSummary(pool, app.id, req.user?.id) : null;
      const gov = await governance.getGovernance(pool, app.id);
      const electorate = await governance.getElectorate(pool, app.id, gov);
      const required = gov.approvalsRequired != null
        ? gov.approvalsRequired
        : activeUsers.requiredVotes(electorate.active, 0);
      res.json({
        slug: app.slug,
        name: app.name,
        // dapp.json's one line about what the app is, for the page's hero.
        description: typeof app.description === 'string' && app.description.trim()
          ? app.description.replace(/\s+/g, ' ').trim() : null,
        ...membership,
        members,
        channel,
        approval: {
          policy: gov.approverPolicy,
          approvals_required: gov.approvalsRequired,
          electorate: electorate.active,
          required,
        },
      });
    } catch (err) {
      log.error('apps', 'Failed to load community', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Join or leave the community an app belongs to. `joined: true` needs only
  // VIEW access: joining an open community is the point of the button, and a
  // private app's community can only be seen by someone already in it.
  // Joining also pins the app to Home (see communities.join) — the button
  // this replaced was "Add to Your apps", and the directory's one tap keeps
  // doing what it did. Leaving takes you out of the community, off the
  // app's collaborators and off Home in one transaction (communities.leave).
  router.post('/api/apps/:slug/membership', async (req, res) => {
    const { joined } = req.body || {};
    if (typeof joined !== 'boolean') {
      return res.status(400).json({ error: 'joined must be a boolean' });
    }
    try {
      const showSelfHosted = !!req.user?.isAdmin || !!config.selfAppPublicVoting;
      const { rows: appRows } = await pool.query(
        `SELECT ${appAccess.ACCESS_COLUMNS}, name FROM apps WHERE slug = $1 AND (NOT self_hosted OR $2::boolean)`,
        [req.params.slug, showSelfHosted]
      );
      const app = appRows[0];
      if (!app || !(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
        return res.status(404).json({ error: 'App not found' });
      }
      if (joined) {
        await communities.join(pool, app, req.user.id);
      } else {
        const result = await communities.leave(pool, app, req.user.id);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
      }
      const membership = await communities.getMembership(pool, app, req.user.id);
      res.json({ ok: true, ...membership });
    } catch (err) {
      log.error('apps', 'Failed to change membership', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Persist the caller's personal ordering of their "Your apps" cards
  // (issue #128; homepage restructure). Deliberately NOT under
  // /api/apps/… so it can never collide with the :slug-parameterised
  // routes above. Body is the user's complete section list,
  // first-to-last: { order: ["slug-a", "slug-b", ...] }.
  //
  // The save is a self-healing full rewrite inside one transaction:
  // every one of the caller's favorites is reset to NULL, then each
  // submitted slug gets an UPSERTED app_favorites row with sort_order
  // = its array index. Upsert rather than update-only because "Your
  // apps" contains member apps (app_collaborators) that were never
  // explicitly favorited — dragging one into position must still
  // persist, and app_favorites doubles as the single personal-ordering
  // table. Inserting the row is invisible to section membership
  // (members are included regardless).
  //
  // Unknown slugs fall out of the JOIN and are silently ignored — a
  // stale client list shouldn't 400 the whole save. Because rows can
  // now spring into being, the insert is restricted to apps the caller
  // could view (public, or member of a private one, or admin; plus the
  // self_hosted gate) so slug-guessing can't mint favorites for hidden
  // apps. Favorites missing from the array end up NULL and fall to the
  // back via the client's fallback ordering.
  router.put('/api/favorites/order', async (req, res) => {
    const { order } = req.body || {};
    if (
      !Array.isArray(order) ||
      order.length > 200 ||
      order.some((s) => typeof s !== 'string')
    ) {
      return res.status(400).json({ error: 'order must be an array of at most 200 slugs' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE app_favorites SET sort_order = NULL WHERE user_id = $1',
        [req.user.id]
      );
      if (order.length > 0) {
        const isAdmin = !!req.user?.isAdmin;
        const showSelfHosted = isAdmin || !!config.selfAppPublicVoting;
        await client.query(
          `INSERT INTO app_favorites (app_id, user_id, sort_order)
           SELECT a.id, $1, ord.idx
           FROM (
             SELECT slug, (ordinality - 1)::int AS idx
             FROM unnest($2::text[]) WITH ORDINALITY AS t(slug, ordinality)
           ) ord
           JOIN apps a ON a.slug = ord.slug
           WHERE (NOT a.self_hosted OR $3::boolean)
             AND ($4::boolean OR a.view_visibility = 'public' OR EXISTS (
               SELECT 1 FROM app_collaborators c
               WHERE c.app_id = a.id AND c.user_id = $1 AND c.status = 'member'
             ))
           ON CONFLICT (app_id, user_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [req.user.id, order, showSelfHosted, isAdmin]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('apps', 'Failed to reorder favorites', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.post('/api/apps/:slug/activity', async (req, res) => {
    const seconds = activitySeconds(req.body?.seconds);

    if (seconds === null) {
      return res.status(400).json({ error: 'Invalid seconds value' });
    }

    try {
      const appRow = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!appRow) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appRows = [appRow];

      // `xmax = 0` is true only for a freshly INSERTed row; on the
      // ON CONFLICT update path xmax is the locking txid (non-zero). We
      // use it to emit the dapp_active_day analytics event exactly once
      // per (user, app, day) — the first heartbeat of the day — rather
      // than on every periodic activity ping, which would bloat the
      // append-only events log. This matches the one-row-per-active-day
      // shape the migrate.js backfill produces from app_activity.
      const { rows: activityRows } = await pool.query(
        // #2524: the accumulated total is clamped to a day's worth of
        // seconds. The per-request ceiling above bounds ONE body; this is
        // what bounds the column, because a caller that wanted to inflate
        // its app's rank would simply post many times. A day cannot contain
        // more than 86400 seconds, so no honest row is ever touched by it —
        // and with the total bounded, the INTEGER column can no longer be
        // driven to overflow.
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, CURRENT_DATE)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = LEAST(
           app_activity.seconds_spent + EXCLUDED.seconds_spent, $4)
         RETURNING (xmax = 0) AS inserted`,
        [appRows[0].id, req.user.id, seconds, ACTIVITY_MAX_PER_DAY]
      );

      if (activityRows[0]?.inserted) {
        events.record(pool, {
          type: events.EVENT_TYPES.DAPP_ACTIVE_DAY,
          userId: req.user.id,
          appId: appRows[0].id,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      log.error('apps', 'Failed to track activity', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  // For tests/demo-mode-lineage.test.js: the masking is a property of this
  // one resolver, so it is pinned there rather than through a route.
  attachForkLineage,
  appRoutes, sweepStuckCreatingApps, accessFlags, canDeleteApp, compactGlobalChatApp,
  deleteBlockReason, isCoreApp,
  // #2524: the activity guard and its two bounds, so the contract is
  // unit-testable without standing up the whole app router.
  activitySeconds, ACTIVITY_MAX_PER_POST, ACTIVITY_MAX_PER_DAY,
};
