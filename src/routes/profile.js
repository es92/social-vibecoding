'use strict';

// Profile customization (issue #982) — the write half of the #profile
// screen plus the read that backs its "Completed challenges" section.
//
//   PATCH  /api/me/profile             display name / bio
//   POST   /api/me/username            change the @handle
//   POST   /api/me/username/choose      take the FIRST @handle (#2563)
//   POST   /api/me/avatar              raw image bytes -> user_avatars
//   DELETE /api/me/avatar              remove the picture
//   GET    /api/me/challenges/completed  the viewer's OWN completions
//   GET    /api/me/summary             Me's stat cards + "Your contributions"
//
// Every route is me-scoped and 401s without a session, so this router is
// mounted AFTER authMiddleware in server.js. The public read side of an
// avatar is a separate, deliberately unauthenticated router
// (src/routes/avatars.js) — an <img> can't carry a session dance.
//
// ── The username change ───────────────────────────────────────
//
// This header used to say a username change was impossible anywhere on
// the platform. It is now POST /api/me/username, and what changed is not
// the constraint — it is that the constraint has somewhere to live.
//
// `users.username` is still the login identifier, still the address of
// the public builder page (#leaderboard/users/<username>), still the
// resolution key for the seeded service identities, and still
// denormalized into `apps.admin_usernames` from repo dapp.json files the
// platform cannot rewrite. Releasing a handle re-points every one of
// those at the next person to register it. So a rename does not release
// it: src/services/usernames.js retires the old handle into
// `username_history` permanently and every handle-keyed resolver reads
// through that ledger. See the block comment on the table in schema.sql.
//
// PATCH /api/me/profile above still does NOT write `username`, and must
// not: the rename needs the current password, a cooldown and a ledger
// write in one transaction, none of which belong in a partial field
// update that also accepts a bio. Two endpoints, two contracts.
//
// Admin-initiated renames remain unimplemented —
// routes/topochain/admin/users.js still restricts its writable set to
// email/telegram/discord/display_name/accept_logs, and moving someone
// else's handle is a moderation action with its own audit needs.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { sniffImageType } = require('../services/attachments');
const {
  profileWriteLimiter, usernameChangeLimiter, usernameChooseLimiter,
} = require('../middleware/rate-limits');
const usernames = require('../services/usernames');
const accountEmail = require('../services/account-email');
const socialIdentity = require('../services/social-identity');
const {
  buildChallengeRow,
  DONE_EXPR,
  MY_COUNT_SQL,
  MY_BLOCKS_SQL,
  ALL_CHALLENGE_WHERE,
  onboardingDoneExpr,
  onboardingDoneParams,
} = require('./home-panels');
const { loadOnboarding } = require('../services/topochain/challenge-onboarding');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');
const { MY_SESSIONS_WHERE, MY_PROPOSALS_WHERE } = require('./workshop-overview');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

// ─── Field limits ──────────────────────────────────────────────────────
//
// `display_name` is VARCHAR(255) in the schema (it predates this feature —
// the topochain merge added it). 40 is the LAYOUT budget, not the storage
// one: the same string renders in the standings row and the profile header,
// and neither truncates at 40 on a phone.
const MAX_DISPLAY_NAME = 40;
const MAX_BIO = 280;
// Avatar bytes. The express.raw() limit below must sit ABOVE this so an
// over-size body gets the friendly 400 from validateAvatarUpload rather
// than the parser's opaque 413 — same reasoning as the feedback-screenshot
// route. GIF is rejected on purpose: nothing here decodes frames, and an
// animated avatar is not wanted on a shared surface.
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How many completed challenges the profile section renders. Production's
// whole Season 1 is 34 enabled challenges, so this never bites today; it
// exists so a season that accumulates hundreds can't turn one screen into
// an unbounded response.
const COMPLETED_LIMIT = 60;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ─── GET /api/me/summary: Me's three numbers and its contributions ─────
//
// The prototype's Me page leads with three stat cards — merged, kudos,
// challenges — and closes with "Your contributions". #2740 deferred both
// because the three numbers live in three subsystems and nothing added them
// up. This is that aggregation, ONE me-scoped read:
//
//   merged        the viewer's merged proposals, across every app. Headless
//                 auto sessions are not proposals anybody authored, so they
//                 are out, exactly as the builder page counts them.
//   kudos         what the product calls kudos RECEIVED: the direct PR kudos
//                 on the viewer's proposals plus the issue bounties awarded
//                 to them on merge — the same two arms the Top users board
//                 adds up (src/services/leaderboard-users.js). Unlike that
//                 board this is not limited to public apps: it is the
//                 viewer's own number on the viewer's own page, the same
//                 me-scope GET /api/me/history reads with.
//   challenges    completed in the profile season, by the one per-user done
//                 rule (DONE_EXPR) the completed list and Home already share.
//   contributions the newest merged proposals, each carrying what the row
//                 needs to open it (#app/<slug>/dev/proposals/<session>).
//
// Two small counts and one bounded list: the counts ride the
// chat_sessions (user_id, …) index, the list is LIMITed, and the challenge
// totals are the query /api/me/challenges/completed already runs.
const SUMMARY_CONTRIBUTIONS_LIMIT = 5;

const SUMMARY_COUNTS_SQL = `
  SELECT COUNT(*) FILTER (WHERE cs.status = 'merged')::int AS merged,
         COUNT(DISTINCT cs.app_id) FILTER (WHERE cs.status = 'merged')::int AS apps,
         COUNT(*) FILTER (WHERE cs.status IN (
           'active', 'paused', 'promoted', 'merging', 'merged', 'archived'
         ))::int AS proposals_total,
         -- Your changes' "2 in progress" on Me (UI overhaul): the same two
         -- buckets GET /api/me/proposal-history files as in progress and
         -- open for a vote.
         COUNT(*) FILTER (WHERE cs.status IN (
           'active', 'paused', 'promoted', 'merging'
         ))::int AS in_progress,
         (SELECT COUNT(*)::int
            FROM pr_kudos pk
            JOIN chat_sessions ks ON ks.id = pk.session_id
           WHERE ks.user_id = $1) AS direct_kudos,
         (SELECT COUNT(*)::int
            FROM issue_bounties ib
           WHERE ib.awarded_user_id = $1 AND ib.status = 'awarded') AS bounty_kudos,
         (SELECT u.created_at FROM users u WHERE u.id = $1) AS member_since
    FROM chat_sessions cs
   WHERE cs.user_id = $1 AND cs.is_headless = FALSE
`;

const SUMMARY_CONTRIBUTIONS_SQL = `
  SELECT cs.id AS session_id, cs.pr_number, cs.pr_title, cs.session_title,
         cs.merged_at, cs.created_at,
         a.slug AS app_slug, a.name AS app_name, a.icon_emoji, a.icon_image_id,
         a.self_hosted,
         ((SELECT COUNT(*) FROM pr_kudos pk WHERE pk.session_id = cs.id)
          + (SELECT COUNT(*) FROM issue_bounties ib
              WHERE ib.status = 'awarded' AND ib.awarded_session_id = cs.id))::int AS kudos
    FROM chat_sessions cs
    JOIN apps a ON a.id = cs.app_id
   WHERE cs.user_id = $1 AND cs.is_headless = FALSE AND cs.status = 'merged'
   ORDER BY cs.merged_at DESC NULLS LAST, cs.id DESC
   LIMIT $2
`;

// The platform's own app, for the demo rows below.
const SELF_APP_SQL = `
  SELECT slug, name, icon_emoji, icon_image_id
    FROM apps
   WHERE self_hosted = TRUE
   ORDER BY id ASC
   LIMIT 1
`;

// Staging-only ?demo=1 rows. `chat_sessions` is staging:private, so a
// prod-cloned preview holds no proposals and the whole lower half of Me
// would read "nothing merged yet" — unreviewable in the preview and in the
// before/after screenshots. These are four of the MERGED mocks
// src/routes/votes.js serves under the same flag (stagingMockMerged), by id
// and title, so a demo row opens the very proposal page it names.
// tests/me-summary.test.js pins each id and title to that file.
const DEMO_CONTRIBUTIONS = [
  { sessionId: 9100000, prNumber: 910100, days: 0, kudos: 0,
    title: '[Mock] Auto-merged: votes passed and checks turned green — merged automatically (#451)' },
  { sessionId: 9100030, prNumber: 910130, days: 35, kudos: 2,
    title: '[Mock] Completed: rework the onboarding checklist' },
  { sessionId: 9100031, prNumber: 910131, days: 70, kudos: 0,
    title: '[Mock] Completed: ship the notification digest' },
  { sessionId: 9100032, prNumber: 910132, days: 110, kudos: 3,
    title: '[Mock] Completed: split settings into sections' },
];

function appIconUrl(imageId) {
  return typeof imageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(imageId)
    ? `/app-icons/${imageId}` : null;
}

// Pure (exported for tests): one contributions row → the client's shape.
function shapeContribution(r) {
  const prNumber = r.pr_number != null ? Number(r.pr_number) : null;
  const title = (r.pr_title && String(r.pr_title).trim())
    || (r.session_title && String(r.session_title).trim())
    || (prNumber ? `Proposal #${prNumber}` : 'Merged proposal');
  const when = r.merged_at || r.created_at || null;
  return {
    sessionId: Number(r.session_id),
    prNumber,
    title,
    appSlug: r.app_slug,
    appName: r.app_name || r.app_slug,
    appIconEmoji: r.icon_emoji || null,
    appIconUrl: appIconUrl(r.icon_image_id),
    platform: r.self_hosted === true,
    mergedAt: when ? new Date(when).toISOString() : null,
    kudos: Number(r.kudos) || 0,
  };
}

// Pure (exported for tests): the three counts, the contributions and the
// challenge totals → the response body.
function shapeSummary({ counts, contributions, challenges }) {
  const c = counts || {};
  return {
    merged: Number(c.merged) || 0,
    apps: Number(c.apps) || 0,
    proposalsTotal: Number(c.proposals_total) || 0,
    inProgress: Number(c.in_progress) || 0,
    kudos: (Number(c.direct_kudos) || 0) + (Number(c.bounty_kudos) || 0),
    memberSince: c.member_since ? new Date(c.member_since).toISOString() : null,
    challenges: {
      done: Number(challenges && challenges.done) || 0,
      total: Number(challenges && challenges.total) || 0,
      season: challenges && challenges.season
        ? { id: Number(challenges.season.id), name: challenges.season.name }
        : null,
    },
    contributions: (contributions || []).map(shapeContribution),
  };
}

// Pure (exported for tests): the ?demo=1 overlay. REAL DATA WINS — a
// staging viewer who genuinely merged something sees their own rows, and
// the mock only fills a lower half that would otherwise be empty. The
// challenge totals are never mocked: they survive the staging clone.
function withDemoSummary(summary, selfApp, now = Date.now()) {
  if (!selfApp || summary.merged > 0 || summary.contributions.length > 0) return summary;
  const contributions = DEMO_CONTRIBUTIONS.map((d) => ({
    sessionId: d.sessionId,
    prNumber: d.prNumber,
    title: d.title,
    appSlug: selfApp.slug,
    appName: selfApp.name || selfApp.slug,
    appIconEmoji: selfApp.icon_emoji || null,
    appIconUrl: appIconUrl(selfApp.icon_image_id),
    platform: true,
    mergedAt: new Date(now - d.days * 86400000).toISOString(),
    kudos: d.kudos,
  }));
  return {
    ...summary,
    merged: contributions.length,
    apps: Math.max(summary.apps, 1),
    proposalsTotal: Math.max(summary.proposalsTotal, contributions.length),
    kudos: Math.max(summary.kudos, contributions.reduce((n, row) => n + row.kudos, 0)),
    contributions,
    demo: true,
  };
}

// ── GET /api/me/proposal-history ────────────────────────────────────────
//
// "Your proposals" on Me: every proposal the viewer has ever started,
// across every project, grouped by where it stands. Scoped to cs.user_id,
// so a private/self-hosted app's own draft work is visible here regardless
// of the app's visibility — the one surface where that's deliberate.
const PROPOSALS_PER_BUCKET = 50;

// MY_SESSIONS_WHERE and MY_PROPOSALS_WHERE come from workshop-overview.js.
// MY_PROPOSALS_WHERE has no is_headless guard of its own (Workshop never
// needed one there), so the open-for-vote branch below adds it inline.
const MY_PROPOSALS_SQL = `
  WITH items AS (
    SELECT 'inProgress' AS section, cs.id AS session_id, cs.session_title AS title,
           cs.app_id, cs.status, cs.last_activity_at AS at
      FROM chat_sessions cs
     WHERE ${MY_SESSIONS_WHERE}
     UNION ALL
    SELECT 'openForVote' AS section, cs.id AS session_id, cs.session_title AS title,
           cs.app_id, cs.status, COALESCE(cs.promoted_at, cs.last_activity_at) AS at
      FROM chat_sessions cs
     WHERE ${MY_PROPOSALS_WHERE} AND cs.is_headless = FALSE
     UNION ALL
    SELECT 'merged' AS section, cs.id AS session_id, cs.session_title AS title,
           cs.app_id, cs.status, COALESCE(cs.merged_at, cs.last_activity_at) AS at
      FROM chat_sessions cs
     WHERE cs.user_id = $1 AND cs.is_headless = FALSE AND cs.status = 'merged'
     UNION ALL
    SELECT 'closed' AS section, cs.id AS session_id, cs.session_title AS title,
           cs.app_id, cs.status, COALESCE(cs.archived_at, cs.last_activity_at) AS at
      FROM chat_sessions cs
     WHERE cs.user_id = $1 AND cs.is_headless = FALSE AND cs.status = 'archived'
  ),
  ranked AS (
    SELECT it.*, ROW_NUMBER() OVER (
             PARTITION BY it.section ORDER BY it.at DESC NULLS LAST, it.session_id DESC
           ) AS rn
      FROM items it
  )
  SELECT r.section, r.session_id, r.title, r.status, r.at,
         a.slug AS app_slug, a.name AS app_name, a.icon_emoji, a.icon_image_id
    FROM ranked r
    JOIN apps a ON a.id = r.app_id
   WHERE r.rn <= $2
   ORDER BY r.section, r.at DESC NULLS LAST, r.session_id DESC
`;

// Pure (exported for tests): raw rows → the response body's four buckets.
function shapeProposalRow(r) {
  return {
    sessionId: Number(r.session_id),
    title: r.title,
    appSlug: r.app_slug,
    appName: r.app_name,
    appIconEmoji: r.icon_emoji || null,
    appIconUrl: appIconUrl(r.icon_image_id),
    status: r.status,
    at: r.at ? new Date(r.at).toISOString() : null,
  };
}

function shapeProposals(rows) {
  const buckets = { openForVote: [], inProgress: [], merged: [], closed: [] };
  for (const row of rows || []) {
    const bucket = buckets[row.section];
    if (bucket) bucket.push(shapeProposalRow(row));
  }
  return { proposals: buckets };
}

// Staging-only ?demo=1 rows, one per bucket. Ids follow src/routes/profile.js
// and src/routes/votes.js's occupied 91000xx ranges (see their own comments);
// 9100035-9100040 were unused before this. The merged bucket reuses
// DEMO_CONTRIBUTIONS' own ids/titles so the same mock row opens the same
// proposal page from either screen.
const DEMO_PROPOSALS = {
  inProgress: [
    { sessionId: 9100035, title: '[Mock] Rework the onboarding checklist', status: 'active' },
  ],
  openForVote: [
    { sessionId: 9100036, title: '[Mock] Ship the notification digest', status: 'promoted' },
  ],
  merged: [
    { sessionId: 9100030, title: '[Mock] Completed: rework the onboarding checklist',
      status: 'merged' },
    { sessionId: 9100031, title: '[Mock] Completed: ship the notification digest',
      status: 'merged' },
  ],
  closed: [
    { sessionId: 9100063, title: '[Mock] Split settings into sections', status: 'archived' },
  ],
};

// Pure (exported for tests): the ?demo=1 overlay. REAL DATA WINS, per
// bucket — a bucket the real query already returned rows for is left alone;
// only a bucket that came back empty gets the mock rows for it.
function withDemoProposals(proposals, selfApp, now = Date.now()) {
  if (!selfApp) return proposals;
  const result = {};
  for (const key of Object.keys(proposals)) {
    if (proposals[key].length > 0) {
      result[key] = proposals[key];
      continue;
    }
    result[key] = (DEMO_PROPOSALS[key] || []).map((d) => ({
      sessionId: d.sessionId,
      title: d.title,
      appSlug: selfApp.slug,
      appName: selfApp.name || selfApp.slug,
      appIconEmoji: selfApp.icon_emoji || null,
      appIconUrl: appIconUrl(selfApp.icon_image_id),
      status: d.status,
      at: new Date(now).toISOString(),
    }));
  }
  return result;
}

// ── GET /api/me/requests ────────────────────────────────────────────────
//
// "Your requests" on Me (UI overhaul; it was "Your feedback", #3186): every
// request the viewer asked for, whichever way they asked. Two ways in, one
// list:
//
//   - the Ask for a change dialog, recorded in feedback_reports once the
//     request exists (a platform request has no app_id there: it is the
//     self-hosted app's, the repository it was filed into, matched by name);
//   - a project's board, which records it in `issues` (kind 'general').
//
// One request can be in both, so the list is DISTINCT per app and number.
//
// WHERE EACH ONE STANDS, from what this platform itself records, because a
// request's open/closed state lives on GitHub and in a short-lived cache
// that cannot be trusted to say "closed" (see MY_FEEDBACK_SQL in
// routes/feedback.js). What IS recorded here:
//
//   shipped   a merged change that named it (chat_sessions.linked_issues);
//   closed    a close-request proposal the members voted through
//             (issues kind 'close_issue', applied);
//   underway  a change in progress or up for a vote that names it;
//   waiting   none of those.
//
// So "Done" is shipped or closed, and a request somebody closed on GitHub
// by hand stays under Open until one of those is true. Bounded by
// MY_REQUESTS_LIMIT, newest first; the two counts are over the whole set.
const MY_REQUESTS_LIMIT = 50;

const MY_REQUESTS_SQL = `
  WITH self_app AS (
    SELECT id, repo_url FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1
  ),
  filed AS (
    SELECT fr.created_at, fr.title, fr.issue_number AS number,
           COALESCE(fr.app_id, (
             SELECT s.id FROM self_app s
              WHERE fr.target = 'platform'
                AND lower(regexp_replace(regexp_replace(COALESCE(s.repo_url, ''), '^.*github\\.com/', ''), '(\\.git)?/*$', ''))
                  = lower(COALESCE(fr.issue_owner, '') || '/' || regexp_replace(COALESCE(fr.issue_repo, ''), '\\.git$', ''))
           )) AS app_id
      FROM feedback_reports fr
     WHERE fr.user_id = $1 AND fr.issue_number IS NOT NULL
    UNION ALL
    SELECT i.created_at, i.title, i.github_issue_number, i.app_id
      FROM issues i
     WHERE i.created_by = $1 AND i.kind = 'general' AND i.github_issue_number IS NOT NULL
  ),
  mine AS (
    SELECT DISTINCT ON (f.app_id, f.number) f.app_id, f.number, f.title, f.created_at
      FROM filed f
     WHERE f.app_id IS NOT NULL
     ORDER BY f.app_id, f.number, f.created_at ASC
  ),
  standing AS (
    SELECT m.number, m.title, m.created_at,
           a.slug AS app_slug, a.name AS app_name, a.self_hosted,
           EXISTS (SELECT 1 FROM chat_sessions cs
                    WHERE cs.app_id = m.app_id AND cs.status = 'merged'
                      AND m.number = ANY(cs.linked_issues)) AS shipped,
           EXISTS (SELECT 1 FROM issues c
                    WHERE c.app_id = m.app_id AND c.kind = 'close_issue' AND c.status = 'closed'
                      AND c.payload ? 'appliedAt'
                      AND c.payload->>'issueNumber' = m.number::text) AS closed,
           EXISTS (SELECT 1 FROM chat_sessions cs
                    WHERE cs.app_id = m.app_id
                      AND cs.status IN ('active', 'paused', 'promoted', 'merging')
                      AND m.number = ANY(cs.linked_issues)) AS underway
      FROM mine m
      JOIN apps a ON a.id = m.app_id
  )
  SELECT s.*,
         COUNT(*) OVER () AS total,
         COUNT(*) FILTER (WHERE s.shipped OR s.closed) OVER () AS done
    FROM standing s
   ORDER BY s.created_at DESC NULLS LAST, s.number DESC
   LIMIT $2
`;

// Pure (exported for tests): the rows → the response body.
function shapeRequests(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list[0] || {};
  const requests = list.map((r) => {
    const n = Number(r.number);
    return {
      number: Number.isSafeInteger(n) && n > 0 ? n : null,
      title: r.title ? String(r.title) : null,
      appSlug: r.app_slug || null,
      // The platform's own requests are Homeroom's, whatever the row is named.
      appName: r.self_hosted ? 'Homeroom' : (r.app_name || r.app_slug || null),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      state: r.shipped ? 'shipped' : r.closed ? 'closed' : r.underway ? 'underway' : 'waiting',
    };
  });
  const total = Number(first.total) || 0;
  const done = Number(first.done) || 0;
  return {
    requests,
    open: Math.max(0, total - done),
    done,
    ...(total > requests.length ? { truncated: true } : {}),
  };
}

// Staging-only ?demo=1 rows, the same mock requests GET /api/feedback/mine
// shows (routes/feedback.js DEMO_FEEDBACK), one in each standing so every
// kind of line is on screen. REAL DATA WINS: rows of the viewer's own are
// left alone.
const DEMO_REQUESTS = [
  { number: 900006, days: 0, state: 'waiting', title: '[Mock] Voting buttons need a clearer disabled state' },
  { number: 900003, days: 2, state: 'underway', title: '[Mock] Topic cards overflow on narrow phones' },
  { number: 900002, days: 9, state: 'shipped', title: '[Mock] Add a keyboard shortcut for voting' },
];

function withDemoRequests(body, selfApp, now = Date.now()) {
  if (!selfApp || body.requests.length) return body;
  const requests = DEMO_REQUESTS.map((d) => ({
    number: d.number,
    title: d.title,
    appSlug: selfApp.slug,
    appName: 'Homeroom',
    createdAt: new Date(now - d.days * 86400000).toISOString(),
    state: d.state,
  }));
  const done = requests.filter((r) => r.state === 'shipped' || r.state === 'closed').length;
  return { requests, open: requests.length - done, done };
}

// Pure (exported for tests): validate an uploaded avatar body.
// Returns { ok: true, contentType } or { ok: false, error }.
function validateAvatarUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: 'Empty upload' };
  }
  if (data.length > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      error: `Image too large (max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB). Try a smaller photo`,
    };
  }
  const contentType = sniffImageType(data);
  if (!AVATAR_TYPES.has(contentType)) {
    return { ok: false, error: 'Profile picture must be a PNG, JPEG or WebP image' };
  }
  return { ok: true, contentType };
}

// Pure (exported for tests): normalize + validate the PATCH body.
// Only keys PRESENT in the body are returned in `fields`, so a partial
// update never blanks a field the client didn't send. An empty string is
// an explicit "clear this" and maps to NULL.
//
// Returns { fields: { column: value }, details: { field: [msg] } }.
// A non-empty `details` means reject the whole request — nothing is saved
// partially, which is what lets the sheet show errors inline and keep the
// user's other edits in the form.
function parseProfileFields(body) {
  const fields = {};
  const details = {};
  const src = (body && typeof body === 'object') ? body : {};

  if ('displayName' in src) {
    const raw = src.displayName;
    if (raw !== null && typeof raw !== 'string') {
      details.displayName = ['Display name must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (/[\r\n]/.test(value)) {
        details.displayName = ['Display name cannot contain line breaks.'];
      } else if (value.length > MAX_DISPLAY_NAME) {
        details.displayName = [`Display name must be ${MAX_DISPLAY_NAME} characters or fewer.`];
      } else {
        fields.display_name = value === '' ? null : value;
      }
    }
  }

  if ('bio' in src) {
    const raw = src.bio;
    if (raw !== null && typeof raw !== 'string') {
      details.bio = ['Bio must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (value.length > MAX_BIO) {
        details.bio = [`Bio must be ${MAX_BIO} characters or fewer.`];
      } else {
        fields.bio = value === '' ? null : value;
      }
    }
  }

  // A pre-#1939 cached shell still posts the retired free-text fields. Do not
  // answer 200 while discarding what the person typed: fail the stale request
  // field-by-field so that client can keep the value visible and explain the
  // provider-verified replacement path.
  for (const key of ['github', 'x']) {
    if (key in src) {
      details[key] = [
        'Social handles cannot be entered manually. Open Settings > Connectors > Social accounts to connect or change this account.',
      ];
    }
  }

  return { fields, details };
}

// The profile object echoed by PATCH and embedded in GET /api/auth/me, so
// both surfaces speak one shape and the client can swap `App.user` wholesale.
// Social links are passed separately because their only trusted source is the
// OAuth-backed user_social_identities table. In particular, never fall back to
// row.github / row.x: those legacy columns contain self-declared text.
function shapeProfile(row, verifiedLinks = {}) {
  return {
    displayName: row?.display_name ?? null,
    bio: row?.bio ?? null,
    avatarUrl: row?.avatar_id ? `/avatars/${row.avatar_id}` : null,
    links: {
      github: verifiedLinks?.github ?? null,
      x: verifiedLinks?.x ?? null,
    },
  };
}

// The season the profile's completed list is scoped to.
//
// DELIBERATELY NOT home-panels' fetchCurrentSeason: that one additionally
// requires `starts_at <= NOW() AND ends_at >= NOW()`, which is right for a
// "what's open right now" widget and wrong here. Production's only season
// (Season 1, is_active = TRUE) ended 2026-06-30, so the strict resolver
// returns null and every profile would show an empty list of completions
// people genuinely earned. This mirrors what the profile screen itself has
// always done client-side: the active season, else the newest one.
//
// AN ACTIVE SEASON WITH NO CHALLENGES IS NOT AN ANSWER (#982). "Newest
// active" alone empties every profile the moment an organiser opens the
// NEXT season, because a season is created before its challenges are:
// production has both Season 1 (58 challenges, ended, still is_active) and
// Pre Season 2 (is_active, zero challenges), so the plain resolver picks
// the empty one and the completions people earned in Season 1 vanish from
// their profile until Season 2's challenges land. So prefer the newest
// active season that has at least one in-scope challenge — the same scope
// the list itself uses (ALL_CHALLENGE_WHERE: a public event, challenge
// organiser-enabled) — and only then fall back to newest-active and
// newest-of-all. Each step is strictly more forgiving than the last, so a
// deployment whose seasons all carry challenges resolves exactly as before.
async function fetchProfileSeason(pool, preferredSeasonId = null) {
  // A staging clone can carry a newer production season than the synthetic
  // 900500 catalogue whose challenge activity migrate.js seeds for the
  // capture identities. Prefer that fixture only when the caller asks for
  // it; production keeps the ordinary latest-active/latest-season rule.
  if (preferredSeasonId != null) {
    const { rows: preferred } = await pool.query(
      `SELECT id, name FROM seasons
        WHERE id = $1 AND internal = FALSE
        LIMIT 1`,
      [preferredSeasonId]
    );
    if (preferred[0]) return preferred[0];
  }
  const { rows: stocked } = await pool.query(
    `SELECT s.id, s.name FROM seasons s
      WHERE s.internal = FALSE AND s.is_active = TRUE
        AND EXISTS (
              SELECT 1 FROM season_events se
                JOIN challenges c ON c.season_event_id = se.id
               WHERE se.season_id = s.id
                 AND se.internal = FALSE AND c.enabled = TRUE
            )
      ORDER BY s.starts_at DESC, s.id DESC LIMIT 1`
  );
  if (stocked[0]) return stocked[0];

  const { rows } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  if (rows[0]) return rows[0];
  const { rows: fallback } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return fallback[0] || null;
}

// The viewer's done rule for one season, as Home's Challenges block counts
// it: DONE_EXPR, with the First challenges' own answer over it where the
// season has them (home-panels.js onboardingDoneExpr). A First challenge is
// done from every credit on its TEMPLATE, an earlier season's included, which
// is also how the Getting started card and the gate read it (2026-10-01), so
// Me's "N of M done" and Home's "N/M done in Season 2" cannot disagree about
// one of them. `sql(n)` places the rule's two parameters at $n and $n+1 of
// the statement it is spliced into; with no First challenges it is DONE_EXPR
// and takes none.
async function viewerDoneRule(pool, userId, seasonId) {
  const onboarding = await loadOnboarding(pool, userId, { seasonId });
  if (!onboarding) return { sql: () => DONE_EXPR, params: [] };
  return {
    sql: (n) => onboardingDoneExpr(`$${n}`, `$${n + 1}`),
    params: onboardingDoneParams(onboarding),
  };
}

// The season's in-scope challenge count and how many of them the viewer has
// done, by the viewer's done rule (above). Shared by the completed list's "N
// of M done" header and Me's challenges stat card, so the two can never
// disagree. Totals over the WHOLE in-scope set, so a capped row list never
// makes them lie. `rule` is passed by a caller that already read it.
async function readChallengeTotals(pool, userId, seasonId, rule = null) {
  const done = rule || await viewerDoneRule(pool, userId, seasonId);
  const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${done.sql(3)})::int AS done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE}`,
        [userId, seasonId, ...done.params]
  );
  const row = totalRows[0];
  return row ? { total: Number(row.total) || 0, done: Number(row.done) || 0 } : null;
}

function profileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Shared me-scope gate. These routes are mounted after authMiddleware,
  // which already redirects/401s an anonymous browser — this is the
  // belt-and-braces check every other /api/me/* route also carries.
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  router.get('/api/me/email', requireUser, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT email, email_confirmed, password_set, is_admin FROM users WHERE id = $1', [req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
      const user = rows[0];
      res.set('Cache-Control', 'no-store');
      return res.json({ email: user.email, verified: !!user.email_confirmed,
        passwordRequired: !!user.password_set, recoveryAllowed: !user.is_admin });
    } catch (error) {
      log.error('account-email', 'Could not read account email', { message: error.message });
      return res.status(500).json({ error: 'Could not load account email.' });
    }
  });

  for (const action of ['request', 'verify']) {
    router.post(`/api/me/email/${action}`, requireUser, profileWriteLimiter,
      express.json({ limit: '4kb' }), async (req, res) => {
        try {
          const result = action === 'request'
            ? await accountEmail.requestCode(pool, config, req.user.id, req.body?.email, req.body?.currentPassword)
            : await accountEmail.verifyCode(pool, req.user.id, req.body?.code);
          return res.json(result);
        } catch (error) {
          if (error instanceof accountEmail.AccountEmailError) {
            return res.status(error.status).json({ error: error.message });
          }
          log.error('account-email', 'Email verification failed', { message: error.message });
          return res.status(500).json({ error: 'Could not update account email. Please try again.' });
        }
      });
  }

  // Re-read the columns the client renders, in one statement, so PATCH and
  // the avatar writes can all echo the post-write truth rather than
  // reconstructing it from the request.
  async function readProfile(userId) {
    const [{ rows }, verifiedLinks] = await Promise.all([
      pool.query(
        `SELECT u.display_name, u.bio, av.id AS avatar_id
           FROM users u
           LEFT JOIN user_avatars av ON av.user_id = u.id
          WHERE u.id = $1`,
        [userId]
      ),
      socialIdentity.verifiedProfileLinks(pool, userId),
    ]);
    return shapeProfile(rows[0], verifiedLinks);
  }

  // ── PATCH /api/me/profile ────────────────────────────────────────────
  router.patch(
    '/api/me/profile',
    requireUser,
    profileWriteLimiter,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const { fields, details } = parseProfileFields(req.body);
      if (Object.keys(details).length) {
        return res.status(400).json({ error: 'Some fields need fixing', details });
      }
      const columns = Object.keys(fields);
      if (!columns.length) {
        // Nothing to write (an empty body, or only unknown keys) — not an
        // error; echo current state so the client repaints identically.
        return res.json({ profile: await readProfile(req.user.id) });
      }
      try {
        const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
        await pool.query(
          `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
          [req.user.id, ...columns.map((col) => fields[col])]
        );
        log.info('profile', 'Profile updated', {
          userId: req.user.id, fields: columns,
        });
        return res.json({ profile: await readProfile(req.user.id) });
      } catch (err) {
        log.error('profile', 'Profile update failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── POST /api/me/username ────────────────────────────────────────────
  //
  // Body: { username, currentPassword }. Separate from PATCH /api/me/profile
  // on purpose — see the header. The step order below is a security order,
  // not a readability one:
  //
  //   1. shape         — pure, leaks nothing, costs nothing
  //   2. password      — BEFORE any availability answer, so a stolen session
  //                      without the password cannot walk the namespace
  //                      asking "is @x free?"
  //   3. service ident — a seeded identity may never move
  //   4. cooldown      — before availability for the same reason: a user in
  //                      cooldown gets no probes either
  //   5. availability  — live table AND retired ledger
  //   6. rename        — one transaction
  router.post(
    '/api/me/username',
    requireUser,
    usernameChangeLimiter,
    express.json({ limit: '4kb' }),
    async (req, res) => {
      const { username: requested, currentPassword } = req.body || {};

      const check = usernames.validateUsername(requested);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const next = check.value;

      if (!currentPassword || typeof currentPassword !== 'string') {
        return res.status(400).json({ error: 'Current password is required' });
      }

      try {
        const { rows } = await pool.query(
          'SELECT username, password FROM users WHERE id = $1',
          [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const { username: current, password: hash } = rows[0];

        const valid = await bcrypt.compare(currentPassword, hash);
        if (!valid) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Seeded service accounts (usernode-capture and friends) are found
        // BY NAME at runtime, so renaming one breaks a subsystem rather than
        // moving an identity. src/services/visuals.js is the caller that
        // would fail first.
        if (usernames.isServiceIdentity(current)) {
          return res.status(403).json({ error: 'This account cannot be renamed.' });
        }

        // An exact no-op is a success, not an error — the sheet resubmitting
        // an unchanged field should not read as a failure. A CASE-ONLY change
        // falls through: renameUser treats it as a re-case, which retires
        // nothing and burns no cooldown.
        if (current === next) {
          return res.json({ username: current, retired: null, unchanged: true });
        }
        const recase = current.toLowerCase() === next.toLowerCase();

        if (!recase) {
          const cooldown = await usernames.checkCooldown(pool, req.user.id);
          if (!cooldown.ok) {
            return res.status(429).json({ error: cooldown.error, retryAfter: cooldown.retryAfter });
          }
        }

        const free = await usernames.checkAvailability(pool, next, req.user.id);
        if (!free.available) {
          return res.status(409).json({ error: free.error });
        }

        const result = await usernames.renameUser(pool, req.user.id, next);
        if (!result) return res.status(404).json({ error: 'User not found' });

        log.info('profile', 'Username changed', {
          userId: req.user.id, from: current, to: result.username, recase,
        });
        if (!recase) {
          try {
            const events = require('../services/events');
            events.record(pool, {
              type: events.EVENT_TYPES.USERNAME_CHANGED,
              userId: req.user.id,
              metadata: { from: current, to: result.username },
            });
          } catch (err) {
            log.warn('profile', 'Username event record failed', { err: err.message });
          }
        }

        return res.json({ username: result.username, retired: result.retired });
      } catch (err) {
        // The unique indexes on users.username and username_history are the
        // backstop behind the availability check above; a race between two
        // people claiming the same handle lands here.
        if (err.code === '23505') {
          return res.status(409).json({ error: 'That username is taken.' });
        }
        log.error('profile', 'Username change failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/me/username/suggestion lived here: the handle, derived from
  // the email's local part, that the first-run step arrived holding
  // (#2563). #3575 retired it with the prefill it served — "do not just
  // generate a username from their email" — and the step now starts empty.
  // See the block above placeholderUsername in src/services/usernames.js.

  // ── POST /api/me/username/choose ─────────────────────────────────────
  //
  // Body: { username }. The FIRST handle an account ever takes (#2563) —
  // not a rename, and deliberately not POST /api/me/username above.
  //
  // Three things that endpoint requires, this one cannot ask for, and the
  // reasons are not the same reason:
  //
  //   • The current password. An email-code account has `password_set =
  //     FALSE` and a random hash nobody knows, so requiring it would lock
  //     the gate shut for exactly the accounts the gate exists for.
  //   • The 30-day cooldown. It prices handle CHURN; a first choice is not
  //     churn, and charging for it would leave a typo in place for a month.
  //   • A `username_history` row. See chooseFirstUsername — what is being
  //     left behind is an email address or an opaque placeholder, and the
  //     ledger is read by every handle resolver on the platform.
  //
  // What replaces the password as the authorization is the flag itself:
  // the UPDATE only fires while `needs_username_choice` is TRUE, so this
  // endpoint can be called exactly once per account and a session that
  // reaches it can do nothing a rename would not already allow.
  router.post(
    '/api/me/username/choose',
    requireUser,
    usernameChooseLimiter,
    express.json({ limit: '4kb' }),
    async (req, res) => {
      const { username: requested } = req.body || {};

      const check = usernames.validateUsername(requested);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const next = check.value;

      try {
        const { rows } = await pool.query(
          'SELECT needs_username_choice FROM users WHERE id = $1',
          [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        if (!rows[0].needs_username_choice) {
          // Already chosen — a replayed submit, or a second tab. Not an
          // error the person can act on, so the client treats it as "the
          // gate is done" and closes.
          return res.status(409).json({
            error: 'You have already chosen your username.',
            alreadyChosen: true,
          });
        }

        const free = await usernames.checkAvailability(pool, next, req.user.id);
        if (!free.available) return res.status(409).json({ error: free.error });

        const result = await usernames.chooseFirstUsername(pool, req.user.id, next);
        // The flag went out from under us between the read and the write —
        // the other tab won. Same answer as above.
        if (!result) {
          return res.status(409).json({
            error: 'You have already chosen your username.',
            alreadyChosen: true,
          });
        }

        log.info('profile', 'First username chosen', {
          userId: req.user.id, to: result.username,
        });
        return res.json({ username: result.username });
      } catch (err) {
        // The unique index on users.username and the two BEFORE triggers
        // (case-variant and retired-handle, see schema.sql) are the backstop
        // behind checkAvailability; a race between two people claiming the
        // same handle lands here.
        if (err.code === '23505') {
          return res.status(409).json({ error: 'That username is taken.' });
        }
        log.error('profile', 'First username choice failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── POST /api/me/avatar ──────────────────────────────────────────────
  // Raw bytes (application/octet-stream) — deliberately sidesteps the
  // global express.json() parser, same reasoning as the feedback
  // screenshot and dev-chat attachment uploads. The 2mb parser ceiling
  // sits above the 1 MB cap so an over-size body reaches
  // validateAvatarUpload and gets a sentence a human can act on.
  router.post(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    express.raw({ type: 'application/octet-stream', limit: '2mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = validateAvatarUpload(data);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Fresh id per upload: the URL is content-addressed and served
        // with a year-long immutable header, so replacing the bytes MUST
        // replace the id or every cache keeps the old picture forever.
        const id = crypto.randomBytes(16).toString('hex');
        const sha256 = crypto.createHash('sha256').update(data).digest('hex');
        await pool.query(
          `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
             SET id = EXCLUDED.id,
                 content_type = EXCLUDED.content_type,
                 size_bytes = EXCLUDED.size_bytes,
                 data = EXCLUDED.data,
                 sha256 = EXCLUDED.sha256,
                 created_at = NOW()`,
          [id, req.user.id, verdict.contentType, data.length, data, sha256]
        );
        log.info('profile', 'Avatar uploaded', {
          userId: req.user.id, bytes: data.length, contentType: verdict.contentType,
        });
        return res.json({ avatarUrl: `/avatars/${id}` });
      } catch (err) {
        log.error('profile', 'Avatar upload failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // ── DELETE /api/me/avatar ────────────────────────────────────────────
  // Idempotent: deleting when there is nothing to delete is a 200, not a
  // 404 — the client's "Remove photo" should never fail for a user who
  // double-tapped it.
  router.delete(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    sameOriginBrowserOnly,
    async (req, res) => {
      try {
        await pool.query('DELETE FROM user_avatars WHERE user_id = $1', [req.user.id]);
        log.info('profile', 'Avatar removed', { userId: req.user.id });
        return res.json({ avatarUrl: null });
      } catch (err) {
        log.error('profile', 'Avatar delete failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── GET /api/me/challenges/completed ─────────────────────────────────
  //
  // The challenges the VIEWER completed — not the ones an organiser marked
  // finished. `challenges.completed` is an organiser flag about the
  // challenge ("this one is over"); the profile screen used to filter on it
  // client-side, which is why every signed-in person saw 28 of production's
  // 34 live challenges listed as their own completions.
  //
  // Done-ness comes from DONE_EXPR — the same rule the home Challenges
  // widget uses — so a numeric challenge at 3 of 8 is correctly NOT done.
  // Scope is ALL_CHALLENGE_WHERE (organiser-finished and out-of-window
  // challenges included): a challenge that is over and that you completed
  // is exactly what belongs in this list.
  router.get('/api/me/challenges/completed', requireUser, async (req, res) => {
    try {
      const season = await fetchProfileSeason(
        pool,
        process.env.USERNODE_ENV === 'staging' ? 900500 : null
      );
      if (!season) {
        return res.json({ season: null, total: 0, done: 0, completed: [] });
      }

      // The viewer's done rule (viewerDoneRule): DONE_EXPR, with the First
      // challenges' lifetime answer over it, read once for the list and the
      // totals both.
      const rule = await viewerDoneRule(pool, req.user.id, season.id);
      const { rows } = await pool.query(
        `SELECT c.id, c.season_event_id, c.goal, c.task, c.reward,
                c.schedule_start, c.schedule_end,
                c.cta_label, c.cta_link,
                c.metric_type, c.metric_target, c.metric_label,
                c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
                se.name AS event_name,
                ${TEMPLATE_JOIN_COLUMNS_SQL},
                ${MY_COUNT_SQL} AS my_activity_count,
                (SELECT COALESCE(SUM(ua.points), 0) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_points,
                (SELECT MAX(ua.activity_at) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_last_activity_at,
                ${MY_BLOCKS_SQL} AS my_blocks,
                ${rule.sql(4)} AS my_done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE} AND (${rule.sql(4)})
          ORDER BY my_last_activity_at DESC NULLS LAST, c.id DESC
          LIMIT $3`,
        [req.user.id, season.id, COMPLETED_LIMIT + 1, ...rule.params]
      );

      // Totals over the WHOLE in-scope set so the header's "N of M done"
      // is honest even when the row list is capped.
      const totals = await readChallengeTotals(pool, req.user.id, season.id, rule);

      const truncated = rows.length > COMPLETED_LIMIT;
      if (truncated) {
        // Never silently drop rows — a capped list that reads as complete
        // is worse than a shorter one that says so.
        log.info('profile', 'Completed-challenge list truncated', {
          userId: req.user.id, seasonId: season.id, limit: COMPLETED_LIMIT,
        });
      }

      // A challenge whose template row vanished is skipped rather than
      // 500ing the section — the same guard the panel and public.js apply.
      const completed = rows
        .slice(0, COMPLETED_LIMIT)
        .filter((r) => r.t_id != null)
        .map((r) => ({
          ...buildChallengeRow(r),
          season_event_id: Number(r.season_event_id),
          event_name: r.event_name || null,
          activity_count: Number(r.my_activity_count) || 0,
          last_activity_at: r.my_last_activity_at
            ? new Date(r.my_last_activity_at).toISOString()
            : null,
        }));

      return res.json({
        season: { id: Number(season.id), name: season.name },
        total: totals ? totals.total : 0,
        done: totals ? totals.done : completed.length,
        completed,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      log.error('profile', 'Completed-challenge read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/me/summary ──────────────────────────────────────────────
  //
  // Me's stat cards and "Your contributions" — see SUMMARY_COUNTS_SQL above
  // for what each number means. The three independent reads go out together;
  // only the challenge totals wait, on the season they are scoped to.
  router.get('/api/me/summary', requireUser, async (req, res) => {
    try {
      const [countRows, contributionRows, season] = await Promise.all([
        pool.query(SUMMARY_COUNTS_SQL, [req.user.id]),
        pool.query(SUMMARY_CONTRIBUTIONS_SQL, [req.user.id, SUMMARY_CONTRIBUTIONS_LIMIT]),
        fetchProfileSeason(pool, IS_STAGING ? 900500 : null),
      ]);
      const totals = season ? await readChallengeTotals(pool, req.user.id, season.id) : null;
      let summary = shapeSummary({
        counts: countRows.rows[0],
        contributions: contributionRows.rows,
        challenges: season
          ? { done: totals ? totals.done : 0, total: totals ? totals.total : 0, season }
          : null,
      });
      if (IS_STAGING && req.query.demo === '1') {
        const { rows: selfRows } = await pool.query(SELF_APP_SQL);
        summary = withDemoSummary(summary, selfRows[0] || null);
      }
      return res.json(summary);
    } catch (err) {
      log.error('profile', 'Me summary read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/me/requests ─────────────────────────────────────────────
  //
  // "Your requests" on Me. See MY_REQUESTS_SQL above for the two ways a
  // request is recorded and where each one stands.
  router.get('/api/me/requests', requireUser, async (req, res) => {
    try {
      const { rows } = await pool.query(MY_REQUESTS_SQL, [req.user.id, MY_REQUESTS_LIMIT]);
      let body = shapeRequests(rows);
      if (IS_STAGING && req.query.demo === '1') {
        const { rows: selfRows } = await pool.query(SELF_APP_SQL);
        body = withDemoRequests(body, selfRows[0] || null);
      }
      res.set('Cache-Control', 'no-store');
      return res.json(body);
    } catch (err) {
      log.error('profile', 'Me requests read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/me/proposal-history ─────────────────────────────────────
  //
  // "Your proposals" screen: every proposal the viewer has started, in up
  // to four buckets (openForVote, inProgress, merged, closed). See
  // MY_PROPOSALS_SQL above for how each bucket is read and capped.
  router.get('/api/me/proposal-history', requireUser, async (req, res) => {
    try {
      const { rows } = await pool.query(MY_PROPOSALS_SQL, [req.user.id, PROPOSALS_PER_BUCKET]);
      let { proposals } = shapeProposals(rows);
      if (IS_STAGING && req.query.demo === '1') {
        const { rows: selfRows } = await pool.query(SELF_APP_SQL);
        proposals = withDemoProposals(proposals, selfRows[0] || null);
      }
      return res.json({ proposals });
    } catch (err) {
      log.error('profile', 'Me proposals read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  profileRoutes,
  // Exported for tests.
  validateAvatarUpload,
  parseProfileFields,
  shapeProfile,
  fetchProfileSeason,
  readChallengeTotals,
  shapeContribution,
  shapeSummary,
  withDemoSummary,
  DEMO_CONTRIBUTIONS,
  SUMMARY_CONTRIBUTIONS_LIMIT,
  shapeProposals,
  withDemoProposals,
  DEMO_PROPOSALS,
  MY_REQUESTS_SQL,
  MY_REQUESTS_LIMIT,
  shapeRequests,
  withDemoRequests,
  DEMO_REQUESTS,
  MY_PROPOSALS_SQL,
  PROPOSALS_PER_BUCKET,
  MAX_DISPLAY_NAME,
  MAX_BIO,
  MAX_AVATAR_BYTES,
  COMPLETED_LIMIT,
};
