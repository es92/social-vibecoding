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
      appSlug: null,
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
        `SELECT cs.id, cs.session_title, cs.pr_title, cs.pr_number, cs.status, u.username
          FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1 AND cs.app_id = $2
            AND (cs.user_id = $3 OR cs.shared_at IS NOT NULL
                 OR cs.status IN ('promoted', 'merging', 'merged'))`,
        [ref.object_ref, app.id, user.id]
      );
      if (!rows.length) return unavailable(ref);
      const row = rows[0];
      return {
        ...base, sessionId: row.id, title: row.session_title || row.pr_title || `Proposal #${row.id}`,
        state: row.status, author: row.username,
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
  for (const ref of rows) {
    const card = await hydrateOne(pool, user, ref);
    if (!out.has(ref.message_id)) out.set(ref.message_id, []);
    out.get(ref.message_id).push(card);
  }
  return out;
}

module.exports = {
  strictId,
  normalizeInput,
  validateForShare,
  hydrateOne,
  hydrateForMessages,
  unavailable,
};
