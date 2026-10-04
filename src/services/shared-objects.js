'use strict';

// Canonical platform-object references for private conversations. The client
// supplies identifiers only; labels, state, and hrefs are derived from live
// rows after checking the sender/viewer's current access.

const appAccess = require('./app-access');
const github = require('./github');

const MAX_ID = 2147483647;
const TYPE_ALIASES = new Map([
  ['app', 'app'],
  ['issue', 'github_issue'],
  ['github_issue', 'github_issue'],
  ['proposal', 'code_proposal'],
  ['code_proposal', 'code_proposal'],
  ['governance', 'governance_proposal'],
  ['governance_proposal', 'governance_proposal'],
  ['spec', 'spec'],
]);

function strictId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= MAX_ID ? n : null;
}

function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = TYPE_ALIASES.get(String(raw.type || raw.kind || ''));
  if (!type) return null;
  const appId = strictId(raw.app_id ?? raw.appId);
  const appSlug = typeof (raw.app_slug ?? raw.appSlug) === 'string'
    ? String(raw.app_slug ?? raw.appSlug).trim()
    : null;
  let objectRef = null;
  let objectVersion = null;
  if (type === 'app') objectRef = appId;
  if (type === 'github_issue') objectRef = strictId(raw.issue_number ?? raw.issueNumber ?? raw.object_ref);
  if (type === 'code_proposal') objectRef = strictId(raw.session_id ?? raw.sessionId ?? raw.object_ref);
  if (type === 'governance_proposal') objectRef = strictId(
    raw.proposal_id ?? raw.proposalId ?? raw.governance_id ?? raw.governanceId ?? raw.object_ref
  );
  if (type === 'spec') {
    objectRef = strictId(raw.session_id ?? raw.sessionId ?? raw.object_ref);
    objectVersion = strictId(raw.version ?? raw.spec_version ?? raw.specVersion ?? raw.object_version);
  }
  if ((type !== 'app' && !objectRef) || (type === 'spec' && !objectVersion)
      || (!appId && !appSlug)) return null;
  return { type, appId, appSlug, objectRef, objectVersion };
}

async function resolveApp(pool, user, normalized) {
  let app;
  if (normalized.appId) {
    const { rows } = await pool.query(
      `SELECT ${appAccess.nonSecretAppColumnList()} FROM apps WHERE id = $1`,
      [normalized.appId]
    );
    app = rows[0] || null;
    if (app && !(await appAccess.checkAppAccess(pool, app, user, 'view'))) app = null;
  } else {
    app = await appAccess.getAppForUser(
      pool, normalized.appSlug, user, 'view', appAccess.nonSecretAppColumnList()
    );
  }
  return app;
}

function publicType(type) {
  return ({
    github_issue: 'issue', code_proposal: 'proposal', governance_proposal: 'governance',
  })[type] || type;
}

function parseRepo(url) {
  const match = String(url || '').match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

// B4: a change's status, as people read it on its card.
const CHANGE_STATE_WORDS = Object.freeze({
  active: 'in progress', paused: 'in progress', promoted: null, merging: 'going live', merged: 'live',
  closed: 'closed', archived: 'closed',
});
// "Your" approval only for the one person a project is for, reading it.
function changeStateWords(status, { yours = false } = {}) {
  if (status === 'promoted') return yours ? 'waiting for your approval' : 'waiting for approval';
  return Object.prototype.hasOwnProperty.call(CHANGE_STATE_WORDS, status) ? CHANGE_STATE_WORDS[status] : (status || null);
}

function unavailable(ref) {
  return {
    type: publicType(ref?.object_type || ref?.type || 'app'),
    available: false,
  };
}

// A message stores only the canonical app + issue number, so an unavailable
// GitHub read must not make that identity unsendable. In particular, the
// anonymous GitHub quota is shared by every app on a host; exhausting it used
// to turn a real issue card into a generic 404 from the message endpoint.
// Keep hard answers (404 / pull-request number) fail-closed, but let transient
// reads preserve the already-validated identity and hydrate a safe fallback.
function isTransientIssueRead(result) {
  return !result?.issue && ['rate limited', 'fetch failed'].includes(result?.note);
}

async function validateForShare(pool, user, raw, { conversationId = null } = {}) {
  const ref = normalizeInput(raw);
  if (!ref) return null;
  const app = await resolveApp(pool, user, ref);
  if (!app) return null;

  let row = null;
  if (ref.type === 'app') {
    ref.objectRef = ref.objectRef || app.id;
    if (ref.objectRef !== app.id) return null;
    row = { id: app.id };
  } else if (ref.type === 'github_issue') {
    const repo = parseRepo(app.repo_url);
    if (!repo) return null;
    const result = await github.fetchPublicIssue(repo.owner, repo.repo, ref.objectRef);
    if (!result.issue && !isTransientIssueRead(result)) return null;
    row = result.issue || { number: ref.objectRef };
  } else if (ref.type === 'code_proposal') {
    ({ rows: [row] } = await pool.query(
      `SELECT id, app_id, session_title, pr_title, pr_number, status, user_id
         FROM chat_sessions
        WHERE id = $1 AND app_id = $2
          AND (user_id = $3 OR shared_at IS NOT NULL
               OR status IN ('promoted', 'merging', 'merged'))`,
      [ref.objectRef, app.id, user.id]
    ));
  } else if (ref.type === 'governance_proposal') {
    ({ rows: [row] } = await pool.query(
      `SELECT id, app_id, title, status, kind, created_by
         FROM issues
        WHERE id = $1 AND app_id = $2
          AND kind IN ('secret_change', 'rename', 'close_issue', 'maintenance_campaign',
                       'featured_illustration')`,
      [ref.objectRef, app.id]
    ));
  } else if (ref.type === 'spec') {
    ({ rows: [row] } = await pool.query(
      `SELECT s.session_id, s.version, s.built_at, cs.app_id, cs.user_id,
              cs.session_title, cs.pr_title
         FROM chat_session_specs s
         JOIN chat_sessions cs ON cs.id = s.session_id
        WHERE s.session_id = $1 AND s.version = $2 AND cs.app_id = $3
          AND (cs.user_id = $4 OR s.shared_to_group_at IS NOT NULL)`,
      [ref.objectRef, ref.objectVersion, app.id, user.id]
    ));
  }
  if (!row) return null;
  return {
    objectType: ref.type,
    appId: app.id,
    objectRef: ref.objectRef,
    objectVersion: ref.objectVersion,
    specShare: ref.type === 'spec' && conversationId
      ? { sessionId: ref.objectRef, version: ref.objectVersion, conversationId }
      : null,
  };
}

async function hydrateOne(pool, user, ref) {
  try {
    const normalized = {
      type: ref.object_type,
      appId: ref.app_id,
      // A message's stored card names its app by id; a link names it by slug
      // (#3660 `hydrateLink`). Either way the viewer's access is checked.
      appSlug: ref.app_id ? null : (ref.app_slug || null),
      objectRef: ref.object_ref,
      objectVersion: ref.object_version,
    };
    const app = await resolveApp(pool, user, normalized);
    if (!app) return unavailable(ref);
    const base = {
      type: publicType(ref.object_type), available: true,
      appId: app.id, appSlug: app.slug, subtitle: app.name,
    };
    if (ref.object_type === 'app') {
      return { ...base, title: app.name, state: app.status, href: `#app/${encodeURIComponent(app.slug)}/app` };
    }
    if (ref.object_type === 'github_issue') {
      const repo = parseRepo(app.repo_url);
      if (!repo) return unavailable(ref);
      const result = await github.fetchPublicIssue(repo.owner, repo.repo, ref.object_ref);
      if (!result.issue && !isTransientIssueRead(result)) return unavailable(ref);
      if (!result.issue) {
        return {
          ...base, issueNumber: ref.object_ref, title: `Issue #${ref.object_ref}`,
          state: null, author: null,
          href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${ref.object_ref}`,
        };
      }
      return {
        ...base, issueNumber: ref.object_ref, title: result.issue.title,
        state: result.issue.state, author: result.issue.author || result.issue.user?.login || null,
        href: `#app/${encodeURIComponent(app.slug)}/dev/issues/${ref.object_ref}`,
      };
    }
    if (ref.object_type === 'code_proposal') {
      const { rows } = await pool.query(
        `SELECT cs.id, cs.session_title, cs.pr_title, cs.pr_number, cs.status, u.username, u.is_synthetic,
                (SELECT COUNT(*)::int FROM community_members m JOIN apps a ON a.community_id = m.community_id
                  WHERE a.id = cs.app_id) AS members,
                EXISTS (SELECT 1 FROM community_members m JOIN apps a ON a.community_id = m.community_id
                         WHERE a.id = cs.app_id AND m.user_id = $3) AS mine
          FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1 AND cs.app_id = $2
            AND (cs.user_id = $3 OR cs.shared_at IS NOT NULL
                 OR cs.status IN ('promoted', 'merging', 'merged'))`,
        [ref.object_ref, app.id, user.id]
      );
      if (!rows.length) return unavailable(ref);
      const row = rows[0];
      return {
        ...base, sessionId: row.id, title: row.session_title || row.pr_title || `Change #${row.id}`,
        // B4: where the change is, in words, not its raw status; and no
        // "by homeroom_bot" under one the bot built for somebody.
        state: changeStateWords(row.status, { yours: row.mine === true && Number(row.members) === 1 }),
        author: row.is_synthetic ? null : row.username,
        href: `#app/${encodeURIComponent(app.slug)}/dev/proposals/${row.id}`,
      };
    }
    if (ref.object_type === 'governance_proposal') {
      const { rows } = await pool.query(
        `SELECT i.id, i.title, i.status, u.username
           FROM issues i LEFT JOIN users u ON u.id = i.created_by
          WHERE i.id = $1 AND i.app_id = $2
            AND i.kind IN ('secret_change', 'rename', 'close_issue', 'maintenance_campaign',
                           'featured_illustration')`,
        [ref.object_ref, app.id]
      );
      if (!rows.length) return unavailable(ref);
      const row = rows[0];
      return {
        ...base, proposalId: row.id, title: row.title, state: row.status, author: row.username,
        href: `#app/${encodeURIComponent(app.slug)}/dev/governance/${row.id}`,
      };
    }
    if (ref.object_type === 'spec') {
      const { rows } = await pool.query(
        `SELECT s.session_id, s.version, cs.session_title, cs.pr_title, u.username
           FROM chat_session_specs s
           JOIN chat_sessions cs ON cs.id = s.session_id
           LEFT JOIN users u ON u.id = cs.user_id
          WHERE s.session_id = $1 AND s.version = $2 AND cs.app_id = $3
            AND (
              cs.user_id = $4 OR s.shared_to_group_at IS NOT NULL OR EXISTS (
                SELECT 1 FROM chat_session_spec_user_shares us
                 WHERE us.session_id = s.session_id AND us.version = s.version
                   AND us.recipient_id = $4
              ) OR EXISTS (
                SELECT 1 FROM chat_session_spec_conversation_shares scs
                JOIN conversations shared_conversation
                  ON shared_conversation.id = scs.conversation_id
                 AND shared_conversation.status = 'active'
                JOIN conversation_members cm ON cm.conversation_id = scs.conversation_id
                 WHERE scs.session_id = s.session_id AND scs.version = s.version
                   AND cm.user_id = $4 AND cm.status = 'member'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM conversations direct_conversation
                       JOIN conversation_direct_pairs direct_pair
                         ON direct_pair.conversation_id = direct_conversation.id
                       JOIN user_blocks direct_block
                         ON (direct_block.blocker_id = direct_pair.user_low_id
                             AND direct_block.blocked_user_id = direct_pair.user_high_id)
                          OR (direct_block.blocker_id = direct_pair.user_high_id
                             AND direct_block.blocked_user_id = direct_pair.user_low_id)
                      WHERE direct_conversation.id = scs.conversation_id
                        AND direct_conversation.kind = 'direct'
                   )
              )
            )`,
        [ref.object_ref, ref.object_version, app.id, user.id]
      );
      if (!rows.length) return unavailable(ref);
      const row = rows[0];
      return {
        ...base, sessionId: row.session_id, version: row.version,
        title: row.session_title || row.pr_title || `Spec v${row.version}`,
        state: `v${row.version}`, author: row.username,
        href: `#app/${encodeURIComponent(app.slug)}/dev/sessions/${row.session_id}`,
      };
    }
    return unavailable(ref);
  } catch (_) {
    return unavailable(ref);
  }
}

async function hydrateForMessages(pool, user, messageIds) {
  const ids = [...new Set((messageIds || []).map(strictId).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT id, message_id, position, object_type, app_id, object_ref, object_version
       FROM conversation_message_objects
      WHERE message_id = ANY($1::int[])
      ORDER BY message_id, position, id`,
    [ids]
  );
  // One read per distinct card on the page, not one per message carrying it
  // (#3705, #3706). The Homeroom bot puts a request's card under every
  // message about that request, and an issue card is a live GitHub read
  // whenever the issue is not in the open-issues cache (a closed one never
  // is), so a page of its DM asked GitHub the same question again and again,
  // one after another. That page was slow enough for the service worker to
  // answer a realtime re-read with its stale copy. A card depends only on
  // its reference and the viewer, so one answer serves every message.
  const cards = new Map();
  for (const ref of rows) {
    const key = [ref.object_type, ref.app_id, ref.object_ref, ref.object_version ?? ''].join(':');
    if (!cards.has(key)) cards.set(key, await hydrateOne(pool, user, ref));
    if (!out.has(ref.message_id)) out.set(ref.message_id, []);
    out.get(ref.message_id).push({ ...cards.get(key) });
  }
  return out;
}

// ── #3660: a Homeroom link in a message, as the card it names ─────────
//
// A message that links to one of Homeroom's own pages draws that page as a
// card under it, in a DM and in an app's discussion alike. The client reads
// the page out of the address (frontend/src/features/messages/
// homeroom-links.ts) and sends only that — a type, an app slug and a number
// — never the link, and nothing is fetched from anywhere but this database
// (and, for a request, the same public GitHub read the issue card already
// makes). Nothing is stored: each reader asks, and each answer is THEIR
// view of the page, through the rules a shared card is hydrated under —
// the app's view rule, then the item's own. A page the reader cannot see,
// or that does not exist, is the same unavailable answer, so the two cannot
// be told apart.
//
// Two of the pages are not items a person can share: a community's hub
// (the app's project page) and its discussion (the app's channel). Both are
// exactly as visible as the app.
const LINK_TYPES = new Set(['app', 'hub', 'discussion', 'issue', 'proposal', 'governance']);
// The router's slug grammar for a clean app path (public/js/app.js
// App._appRouteFromPath), which is the same one homeroom-links.ts reads.
const LINK_SLUG = /^[a-z0-9][a-z0-9-]{0,254}$/;
const MAX_LINK_CARDS = 10;

function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!LINK_TYPES.has(type)) return null;
  const slug = raw.app_slug ?? raw.appSlug;
  if (typeof slug !== 'string' || !LINK_SLUG.test(slug)) return null;
  let ref = null;
  if (type === 'issue') ref = strictId(raw.issue_number ?? raw.issueNumber);
  if (type === 'proposal') ref = strictId(raw.session_id ?? raw.sessionId);
  if (type === 'governance') ref = strictId(raw.proposal_id ?? raw.proposalId);
  if (['issue', 'proposal', 'governance'].includes(type) && !ref) return null;
  return { type, slug, ref };
}

async function hydrateLink(pool, user, raw) {
  const link = normalizeLink(raw);
  if (!link) return { type: LINK_TYPES.has(raw?.type) ? raw.type : 'app', available: false };
  if (link.type === 'hub' || link.type === 'discussion') {
    try {
      const app = await resolveApp(pool, user, { appId: null, appSlug: link.slug });
      if (!app) return { type: link.type, available: false };
      const slug = encodeURIComponent(app.slug);
      return {
        type: link.type, available: true, appId: app.id, appSlug: app.slug,
        title: app.name, subtitle: null,
        href: link.type === 'hub' ? `#app/${slug}/workshop` : `#app/${slug}/dev/chat`,
      };
    } catch (_) {
      return { type: link.type, available: false };
    }
  }
  return hydrateOne(pool, user, {
    object_type: TYPE_ALIASES.get(link.type),
    app_id: null,
    app_slug: link.slug,
    object_ref: link.ref,
    object_version: null,
  });
}

/** One card per link, in order: at most MAX_LINK_CARDS, one at a time. */
async function hydrateLinks(pool, user, refs) {
  const cards = [];
  for (const raw of (refs || []).slice(0, MAX_LINK_CARDS)) {
    cards.push(await hydrateLink(pool, user, raw));
  }
  return cards;
}

module.exports = {
  MAX_LINK_CARDS,
  normalizeLink,
  hydrateLink,
  hydrateLinks,
  strictId,
  normalizeInput,
  validateForShare,
  hydrateOne,
  hydrateForMessages,
  unavailable,
};
