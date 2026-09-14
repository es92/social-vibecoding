'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const conversations = require('../src/services/conversations');
const github = require('../src/services/github');
const sharedObjects = require('../src/services/shared-objects');

const ROOT = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(ROOT, 'src/services/conversations.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(ROOT, 'src/routes/conversations.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const notificationsSource = fs.readFileSync(path.join(ROOT, 'src/services/notifications.js'), 'utf8');
const pushWorkerSource = fs.readFileSync(path.join(ROOT, 'src/services/mobile-push-worker.js'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(ROOT, 'src/routes/sessions.js'), 'utf8');
const collaboratorsSource = fs.readFileSync(path.join(ROOT, 'src/routes/collaborators.js'), 'utf8');
const schemaSource = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const rateLimitSource = fs.readFileSync(path.join(ROOT, 'src/middleware/rate-limits.js'), 'utf8');

test('strict identifiers and bounded message inputs fail closed', () => {
  assert.equal(conversations.strictId('1'), 1);
  assert.equal(conversations.strictId('2147483647'), 2147483647);
  for (const value of ['0', '-1', '+1', '01', '2147483648', '1x', null]) {
    assert.equal(conversations.strictId(value), null);
  }
  assert.equal(conversations.normalizeTitle('  Design   crew '), 'Design crew');
  assert.equal(conversations.normalizeTitle('x'.repeat(81)), null);
  assert.equal(conversations.normalizeContent('  hello  '), 'hello');
  assert.equal(conversations.normalizeContent('x'.repeat(8001)), null);
  assert.equal(conversations.normalizeIdempotencyKey('client:offline.123'), 'client:offline.123');
  assert.equal(conversations.normalizeIdempotencyKey('short'), null);
  assert.deepEqual(conversations.normalizeAttachmentIds([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]), ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
});

test('shared object references accept UI aliases but no labels or arbitrary URLs', () => {
  assert.deepEqual(sharedObjects.normalizeInput({
    type: 'proposal', appId: 7, sessionId: 9, title: 'ignored', href: 'https://evil.invalid',
  }), {
    type: 'code_proposal', appId: 7, appSlug: null,
    objectRef: 9, objectVersion: null,
  });
  assert.deepEqual(sharedObjects.normalizeInput({
    type: 'spec', appSlug: 'demo', sessionId: 4, version: 3,
  }), {
    type: 'spec', appId: null, appSlug: 'demo', objectRef: 4, objectVersion: 3,
  });
  assert.equal(sharedObjects.normalizeInput({ type: 'url', href: 'https://example.com' }), null);
  assert.equal(sharedObjects.normalizeInput({ type: 'spec', appId: 1, sessionId: 2 }), null);
});

function publicAppPool() {
  return {
    query: async (sql, params) => {
      if (sql.includes('FROM apps WHERE id = $1')) {
        assert.deepEqual(params, [7]);
        return { rows: [{
          id: 7,
          slug: 'demo',
          name: 'Demo',
          repo_url: 'https://github.com/example/demo.git',
          view_visibility: 'public',
          collab_visibility: 'public',
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('transient GitHub reads do not reject a valid issue-card identity', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  const pool = publicAppPool();
  const user = { id: 3, isAdmin: false };
  const raw = { type: 'issue', appId: 7, issueNumber: 1956 };

  for (const note of ['rate limited', 'fetch failed']) {
    github.fetchPublicIssue = async () => ({ issue: null, note });
    assert.deepEqual(await sharedObjects.validateForShare(pool, user, raw), {
      objectType: 'github_issue',
      appId: 7,
      objectRef: 1956,
      objectVersion: null,
      specShare: null,
    });

    const hydrated = await sharedObjects.hydrateOne(pool, user, {
      object_type: 'github_issue', app_id: 7, object_ref: 1956, object_version: null,
    });
    assert.deepEqual(hydrated, {
      type: 'issue', available: true, appId: 7, appSlug: 'demo', subtitle: 'Demo',
      issueNumber: 1956, title: 'Issue #1956', state: null, author: null,
      href: '#app/demo/dev/issues/1956',
    });
  }
});

test('definitive GitHub misses still reject issue-card identities', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  const pool = publicAppPool();
  const user = { id: 3, isAdmin: false };
  const raw = { type: 'issue', appId: 7, issueNumber: 1956 };

  for (const note of ['not found', 'not an issue (pull request)']) {
    github.fetchPublicIssue = async () => ({ issue: null, note });
    assert.equal(await sharedObjects.validateForShare(pool, user, raw), null);
  }
});

test('invitation serialization cannot hydrate private conversation content', () => {
  assert.match(serviceSource, /const accepted = row\.membership_status === 'member'/);
  assert.match(serviceSource, /const members = accepted && includeMembers/);
  assert.match(serviceSource, /const latest = accepted && row\.latest_message_id/);
  assert.match(serviceSource, /const peer = accepted && row\.peer_id/);
  assert.match(serviceSource, /listMessages[\s\S]*loadMembership\(pool, conversationId, user\.id\)/);
  assert.doesNotMatch(serviceSource, /allowInvited:\s*true[\s\S]{0,200}listMessages/);
});

test('direct consent, retry, and block rules are explicit in canonical service', () => {
  assert.match(serviceSource, /pg_advisory_xact_lock/);
  assert.match(serviceSource, /reciprocalPending/);
  assert.match(serviceSource, /recipientReopens/);
  assert.match(serviceSource, /row\.created_by !== user\.id/);
  assert.match(serviceSource, /membership\.created_by !== user\.id/,
    'pending direct recipient cannot send, requester can send the opening message');
  assert.match(serviceSource,
    /SELECT 1 FROM conversation_messages WHERE conversation_id = \$1 LIMIT 1/,
    'the requester gets exactly one pre-acceptance opening message');
  assert.match(serviceSource, /if \(existingMessages\.rows\.length\) return null/);
  assert.match(serviceSource, /toggleReaction[\s\S]*blockedEitherWay/);
  assert.match(serviceSource, /editMessage[\s\S]*blockedEitherWay/);
  const interactionHelper = serviceSource.match(
    /async function lockInteractionMembership[\s\S]*?\n}\n/
  )?.[0] || '';
  assert.ok(interactionHelper.indexOf('lockPair(') < interactionHelper.indexOf('forUpdate: true'),
    'direct advisory pair lock must precede membership row locking');
  assert.match(serviceSource,
    /async function setBlock[\s\S]*?lockPair\(db, userId, targetId\)[\s\S]*?UPDATE conversation_members/,
    'block uses the same pair lock before mutating pending membership');
});

test('normalized pair locks are globally ordered and precede membership row locks', async () => {
  const pairKeys = [];
  await conversations.lockPairsFor({
    query: async (_sql, params) => { pairKeys.push(params[0]); return { rows: [] }; },
  }, 5, [9, 1, 3, 9]);
  assert.deepEqual(pairKeys, [
    'conversation-direct:1:5',
    'conversation-direct:3:5',
    'conversation-direct:5:9',
  ]);

  const calls = [];
  const db = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM conversations c')) {
        return { rows: [{ id: 44, kind: 'direct', membership_status: 'member' }] };
      }
      if (sql.includes('FROM conversation_direct_pairs')) return { rows: [{ other_id: 9 }] };
      return { rows: [] };
    },
  };
  assert.ok(await conversations.lockInteractionMembership(db, 44, 5));
  const advisory = calls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const rowLock = calls.findIndex((sql) => sql.includes('FOR UPDATE OF c, cm'));
  assert.ok(advisory >= 0 && rowLock > advisory, 'pair advisory lock must be first');
});

test('pending direct idempotency and block terminal state preserve consent', () => {
  const send = serviceSource.slice(
    serviceSource.indexOf('async function sendMessage'),
    serviceSource.indexOf('async function editMessage')
  );
  assert.ok(send.indexOf('idempotency_key = $3') < send.indexOf("accepted.rows[0].count < 2"),
    'same-key lost-response retry is resolved before the one-opening-message guard');
  const block = serviceSource.slice(
    serviceSource.indexOf('async function setBlock'),
    serviceSource.indexOf('async function listBlocks')
  );
  assert.ok(block.indexOf("SET status = 'declined'") < block.indexOf('UPDATE conversations c'),
    'pending invite is declined before its direct conversation is archived');
  assert.ok(block.indexOf('outcome.conversationAudiences') < block.indexOf('if (!blocked)'),
    'both block and unblock return a realtime refresh audience');
});

test('mentions resolve exact active-member usernames including long hyphenated names', () => {
  const long = `team-${'x'.repeat(50)}`;
  assert.equal(conversations.mentionsUsername(`hello @${long}!`, long), true);
  assert.equal(conversations.mentionsUsername('hello @ann-marie', 'ann'), false);
  assert.equal(conversations.mentionsUsername('mail@host.example', 'host.example'), false);
  assert.match(serviceSource, /mentionsUsername\(content, member\.username\)/);
});

test('attachment path owns raw parsing and enforces retained private access', () => {
  assert.match(serverSource, /api\\\/conversations\\\/\[\^\/\]\+\\\/attachments/);
  assert.match(routeSource, /express\.raw\(\{ type: '\*\/\*', limit: '21mb' \}\)/);
  assert.match(routeSource, /attachments\.validateUpload/);
  assert.match(routeSource, /MAX_CONVERSATION_TEXT_BYTES = 200 \* 1024/);
  assert.match(routeSource, /MAX_CONVERSATION_ATTACHMENT_BYTES = 200 \* 1024 \* 1024/);
  assert.match(routeSource, /MAX_USER_ATTACHMENT_BYTES = 500 \* 1024 \* 1024/);
  assert.match(routeSource, /Cache-Control', 'private, no-store'/);
  assert.match(routeSource, /Content-Security-Policy', 'sandbox allow-scripts'/);
  assert.doesNotMatch(routeSource, /allow-same-origin/);
});

test('staging demo is environment-gated and production ignores demo query', () => {
  assert.match(routeSource, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
  assert.match(routeSource, /return IS_STAGING && req\.query\.demo === '1'/);
});

test('realtime never broadcasts viewer-hydrated shared-object cards', () => {
  assert.match(routeSource,
    /type: 'conversation_message_created', conversationId: id, messageId: result\.message\.id/);
  assert.match(routeSource,
    /type: 'conversation_message_updated', conversationId: id, messageId: result\.message\.id/);
  assert.doesNotMatch(routeSource,
    /type: 'conversation_message_(?:created|updated)'[^\n]*message: result\.message/);
});

test('block revocation closes every private direct-message read channel', () => {
  assert.match(notificationsSource, /user_blocks direct_block[\s\S]*direct_conversation\.kind = 'direct'/);
  assert.match(pushWorkerSource, /conversation_direct_blocked/);
  assert.match(pushWorkerSource, /conversation_direct_blocked\) return 'conversation_access_revoked'/);
  assert.match(sessionsSource, /chat_session_spec_conversation_shares[\s\S]*user_blocks direct_block/);
  assert.match(serviceSource, /status = 'declined'[\s\S]*kind = 'conversation_invite'/);
  assert.match(serviceSource, /DELETE FROM notifications n[\s\S]*conversation_direct_pairs p/);
});

test('archived conversations are absent from REST, notifications, and mobile push', () => {
  assert.match(serviceSource, /WHERE c\.id = \$1 AND c\.status = 'active'/);
  assert.match(serviceSource, /WHERE me\.user_id = \$1 AND c\.status = 'active'/);
  assert.match(notificationsSource, /notification_conversation\.status = 'active'/);
  assert.match(pushWorkerSource, /row\.conversation_status !== 'active'/);
  assert.match(serviceSource,
    /async function transferOrArchive[\s\S]*status = 'declined'[\s\S]*kind = 'conversation_invite'/);
});

test('reaction and typing realtime envelopes contain identifiers only', () => {
  assert.match(routeSource,
    /type: 'conversation_reaction_updated', conversationId: id, messageId,/);
  assert.doesNotMatch(routeSource,
    /type: 'conversation_reaction_updated'[^\n]*reactions/);
  const typing = routeSource.slice(
    routeSource.indexOf("router.post('/api/conversations/:id/typing'"),
    routeSource.indexOf("router.post('/api/conversations/:id/messages/:messageId/report'")
  );
  assert.match(typing, /withLockedAudience/);
  assert.doesNotMatch(typing, /username:/);
});

test('reports preserve canonical object and attachment evidence for moderation', () => {
  assert.match(serviceSource,
    /FROM conversation_message_objects[\s\S]*FROM conversation_message_attachments/);
  assert.match(serviceSource, /objects: objectResult\.rows\.map/);
  assert.match(serviceSource, /attachments: attachmentResult\.rows\.map/);
  assert.match(routeSource, /\/api\/admin\/conversation-reports/);
  assert.match(routeSource, /requireAdminWrite/);
  assert.match(routeSource,
    /conversation-reports\/:id\/attachments\/:attachmentId/);
  assert.match(routeSource, /a\.message_id = r\.message_id/);
});

test('account deletion transfers owners and archives empty or direct conversations', () => {
  assert.match(schemaSource, /CREATE OR REPLACE FUNCTION prepare_conversations_for_user_delete/);
  assert.match(schemaSource, /ORDER BY cm\.joined_at NULLS LAST, cm\.created_at, cm\.user_id/);
  assert.match(schemaSource, /BEFORE DELETE ON users/);
  assert.match(schemaSource, /SET status = 'archived'[\s\S]*c\.kind = 'direct'/);
  assert.match(schemaSource,
    /conversation_message_attachments ALTER COLUMN user_id DROP NOT NULL/);
  assert.match(schemaSource, /conversation_message_attachments_user_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(schemaSource, /conversation_message_reports_reporter_user_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(schemaSource, /DELETE FROM notifications n[\s\S]*conversation_direct_pairs p/);
});

test('upload quota decision is transactional and uses deterministic quota locks', () => {
  const upload = routeSource.slice(
    routeSource.indexOf("'/api/conversations/:id/attachments'"),
    routeSource.indexOf('async function loadAttachment')
  );
  const conversationLock = upload.indexOf('conversation-attachment-quota:');
  const userLock = upload.indexOf('user-attachment-quota:');
  const sum = upload.indexOf('SUM(size_bytes)');
  const insert = upload.indexOf('INSERT INTO conversation_message_attachments');
  assert.match(upload, /conversations\.transaction/);
  assert.ok(conversationLock >= 0 && conversationLock < userLock && userLock < sum && sum < insert);
});

test('safety actions and recipient-weighted invitation limits use separate buckets', () => {
  assert.match(rateLimitSource, /const conversationSafetyLimiter/);
  assert.match(rateLimitSource, /new Set\(raw\.map\(String\)\)\.size/);
  assert.match(routeSource, /\/respond', conversationSafetyLimiter/);
  assert.match(routeSource, /\/leave', conversationSafetyLimiter/);
  assert.match(routeSource, /\/api\/me\/blocks\/:userId', conversationSafetyLimiter/);
  assert.match(routeSource, /router\.post\('\/api\/conversations', conversationInviteLimiter/);
});

test('private spec recipients cannot mint transitive conversation grants', () => {
  const validate = fs.readFileSync(path.join(ROOT, 'src/services/shared-objects.js'), 'utf8').slice(
    0,
    fs.readFileSync(path.join(ROOT, 'src/services/shared-objects.js'), 'utf8').indexOf('async function hydrateOne')
  );
  assert.match(validate, /cs\.user_id = \$4 OR s\.shared_to_group_at IS NOT NULL/);
  assert.doesNotMatch(validate, /chat_session_spec_user_shares/);
  assert.doesNotMatch(validate, /chat_session_spec_conversation_shares/);
});

test('orphan conversation attachment GC is independent of session auto-pause', () => {
  const startIndex = serverSource.indexOf('startConversationAttachmentSweeper(config);');
  const autoPauseIndex = serverSource.indexOf('startSessionAutoPauseSweeper(config);');
  assert.ok(startIndex > 0 && startIndex < autoPauseIndex);
  assert.match(serverSource, /function startConversationAttachmentSweeper\(config\)/);
});

test('messages-scoped user search hides self and either-direction blocks only in that scope', () => {
  assert.match(collaboratorsSource, /req\.query\.scope === 'messages'/);
  assert.match(collaboratorsSource, /id <> \$4/);
  assert.match(collaboratorsSource, /b\.blocker_id = \$4 AND b\.blocked_user_id = users\.id/);
  assert.match(collaboratorsSource, /b\.blocker_id = users\.id AND b\.blocked_user_id = \$4/);
  assert.match(collaboratorsSource, /messageScope \? 255 : 32/);
});
