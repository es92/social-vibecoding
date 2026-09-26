'use strict';

// Evidence-only rows are written to the paired, disposable app databases
// after their exact-revision images boot. The platform's staging check owns
// agent session 990801 as usernode-capture-admin; the evidence member cannot
// read it. Copy its real staging conversation to a separate member-owned row
// so a member story can follow an actual Messages row on both revisions.

const { Client } = require('pg');
const dbManager = require('./db-manager');

const SOURCE_SESSION_ID = 990801;
const SOURCE_CHANGE_ID = 990802;
const MEMBER_SESSION_ID = 990899;
const MEMBER_CHANGE_ID = 990898;
const PROFILE = 'platform-member-agent-session-v1';
// This identity is inserted only into the two disposable evidence databases.
// Production and ordinary staging databases never contain a full-admin
// service account. The high, fixed id lets the platform mint one short-lived
// app-scoped iframe token before either isolated browser starts.
const FULL_ADMIN_USER_ID = 2147483000;
const FULL_ADMIN_USERNAME = 'usernode-evidence-full-admin';
const FULL_ADMIN_PROFILE = 'platform-isolated-full-admin-v1';

function assertEvidenceDatabase(databaseUrl, slug, runId, side) {
  const expected = dbManager.evidenceDbName(slug, runId, side);
  const actual = new URL(databaseUrl).pathname.slice(1);
  if (actual !== expected) throw new Error('Visual evidence fixture requires its isolated evidence database.');
}

async function withClient(databaseUrl, fn) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: 'social-visual-evidence-fixture',
  });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

async function canCopyMemberAgentSession({ databaseUrl, slug, runId, side }) {
  assertEvidenceDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query(
      `SELECT to_regclass('public.agent_sessions') IS NOT NULL AS has_sessions,
              to_regclass('public.chat_sessions') IS NOT NULL AS has_changes,
              to_regclass('public.chat_session_messages') IS NOT NULL AS has_messages`
    );
    if (!rows[0]?.has_sessions || !rows[0]?.has_changes || !rows[0]?.has_messages) return false;
    const source = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM agent_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND u.username = 'usernode-capture-admin'
       ) AS session_ready,
       EXISTS (
         SELECT 1 FROM chat_sessions c
          WHERE c.id = $2 AND c.agent_session_id = $1
       ) AS change_ready,
       EXISTS (
         SELECT 1 FROM chat_session_messages m
          WHERE m.agent_session_id = $1 AND m.role = 'user'
       ) AS message_ready`,
      [SOURCE_SESSION_ID, SOURCE_CHANGE_ID]
    );
    return !!(source.rows[0]?.session_ready && source.rows[0]?.change_ready
      && source.rows[0]?.message_ready);
  });
}

async function ensureFullAdminIdentity({ databaseUrl, slug, runId, side }) {
  assertEvidenceDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const conflict = await client.query(
        `SELECT id, username FROM users
          WHERE id = $1 OR username = $2
          FOR UPDATE`,
        [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
      );
      if (conflict.rows.some((row) => Number(row.id) !== FULL_ADMIN_USER_ID
          || row.username !== FULL_ADMIN_USERNAME)) {
        throw new Error('The reserved visual-evidence full-admin identity conflicts with cloned data.');
      }
      if (conflict.rowCount === 0) {
        await client.query(
          `INSERT INTO users
             (id, username, password, is_admin, admin_readonly, can_create_apps,
              has_platform_access, platform_access_granted_at)
           VALUES ($1, $2, '__evidence_not_a_login__', TRUE, FALSE, FALSE, TRUE, NOW())`,
          [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
        );
      } else {
        await client.query(
          `UPDATE users
              SET is_admin = TRUE, admin_readonly = FALSE, can_create_apps = FALSE,
                  has_platform_access = TRUE,
                  platform_access_granted_at = COALESCE(platform_access_granted_at, NOW())
            WHERE id = $1 AND username = $2`,
          [FULL_ADMIN_USER_ID, FULL_ADMIN_USERNAME]
        );
      }
      await client.query('COMMIT');
      return {
        id: FULL_ADMIN_PROFILE,
        persona: 'full_admin',
        startPath: '/#admin',
        path: '/#admin/users',
        userId: FULL_ADMIN_USER_ID,
        username: FULL_ADMIN_USERNAME,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

async function copyMemberAgentSession({ databaseUrl, slug, runId, side, selfAppSlug }) {
  assertEvidenceDatabase(databaseUrl, slug, runId, side);
  return withClient(databaseUrl, async (client) => {
    await client.query('BEGIN');
    try {
      const viewer = await client.query(
        `SELECT id FROM users WHERE username = 'usernode-capture' AND is_admin = FALSE`
      );
      const app = await client.query('SELECT id FROM apps WHERE slug = $1', [selfAppSlug]);
      if (viewer.rowCount !== 1 || app.rowCount !== 1) {
        throw new Error('Visual evidence member identity or platform app is missing from the paired fixture.');
      }
      const userId = viewer.rows[0].id;
      const appId = app.rows[0].id;
      // A member story must see the same private app surface that a genuine
      // collaborator sees. This grant lives only in this run's disposable DB.
      await client.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
         VALUES ($1, $2, 'member', NOW())
         ON CONFLICT (app_id, user_id)
         DO UPDATE SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
        [appId, userId]
      );
      const session = await client.query(
        `INSERT INTO agent_sessions
           (id, user_id, title, title_source, status, focus_app_id, focus_context,
            last_activity_at, created_at)
         SELECT $1, $2, s.title, 'manual', 'open', $3, s.focus_context,
                NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '5 minutes'
           FROM agent_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $4 AND u.username = 'usernode-capture-admin'
         RETURNING id, title`,
        [MEMBER_SESSION_ID, userId, appId, SOURCE_SESSION_ID]
      );
      if (session.rowCount !== 1) throw new Error('The source agent session is unavailable for member evidence.');
      const change = await client.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, session_title, status, agent_session_id,
            created_at, last_activity_at)
         SELECT $1, $2, $3, 'evidence-fixture/member-agent-session', c.session_title,
                'active', $4, NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '2 minutes'
           FROM chat_sessions c
          WHERE c.id = $5 AND c.agent_session_id = $6
         RETURNING id`,
        [MEMBER_CHANGE_ID, appId, userId, MEMBER_SESSION_ID, SOURCE_CHANGE_ID, SOURCE_SESSION_ID]
      );
      if (change.rowCount !== 1) throw new Error('The source agent change is unavailable for member evidence.');
      await client.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1',
        [MEMBER_SESSION_ID, MEMBER_CHANGE_ID]);
      // Copy a real user message from the exact revision's own staging
      // fixture. It proves the transcript loaded; no model or fake response
      // is needed and no admin confirmation card crosses the identity wall.
      const message = await client.query(
        `INSERT INTO chat_session_messages
           (session_id, agent_session_id, role, content, metadata, created_at)
         SELECT NULL, $1, m.role, m.content, '{}'::jsonb, NOW() - INTERVAL '5 minutes'
           FROM chat_session_messages m
          WHERE m.agent_session_id = $2 AND m.role = 'user'
          ORDER BY m.id LIMIT 1
         RETURNING id`,
        [MEMBER_SESSION_ID, SOURCE_SESSION_ID]
      );
      if (message.rowCount !== 1) throw new Error('The source agent message is unavailable for member evidence.');
      await client.query('COMMIT');
      return {
        id: PROFILE,
        persona: 'member',
        startPath: '/#messages',
        path: `/#messages/agent/${MEMBER_SESSION_ID}`,
        title: session.rows[0].title,
        sessionId: MEMBER_SESSION_ID,
        changeId: MEMBER_CHANGE_ID,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  PROFILE,
  SOURCE_SESSION_ID,
  MEMBER_SESSION_ID,
  MEMBER_CHANGE_ID,
  FULL_ADMIN_USER_ID,
  FULL_ADMIN_USERNAME,
  FULL_ADMIN_PROFILE,
  ensureFullAdminIdentity,
  canCopyMemberAgentSession,
  copyMemberAgentSession,
};
