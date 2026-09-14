'use strict';

const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const conversations = require('../services/conversations');
const messageBookmarks = require('../services/message-bookmarks');
const attachments = require('../services/attachments');
const {
  attachmentUploadLimiter,
  conversationMessageLimiter,
  conversationActionLimiter,
  conversationSafetyLimiter,
  conversationInviteLimiter,
  conversationReactionLimiter,
  conversationReportLimiter,
} = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const MAX_CONVERSATION_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const MAX_USER_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MAX_CONVERSATION_TEXT_BYTES = 200 * 1024;
const NOT_FOUND = { error: 'Conversation not found' };

function privateJson(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function sendNotFound(res) {
  return res.status(404).json(NOT_FOUND);
}

function pushAudience(memberIds, payload, options) {
  const ws = require('../services/ws');
  if (typeof ws.pushConversationEvent === 'function') {
    return ws.pushConversationEvent(memberIds, payload, options);
  }
  let sent = 0;
  for (const userId of [...new Set(memberIds || [])]) {
    if (options?.excludeUserId === userId) continue;
    sent += ws.pushToUser(userId, payload);
  }
  return sent;
}

async function pushNotifications(pool, rows) {
  if (!rows?.length) return;
  const notificationSvc = require('../services/notifications');
  for (const row of rows) await notificationSvc.hydrateAndPush(pool, row);
}

function demoUser(id, username) {
  return { id, username, avatarUrl: null };
}

// A 96x64 solid PNG for the staging demo's screenshot attachment (#2113).
const DEMO_SCREENSHOT_NAME = 'Screenshot 2026-08-13 at 12.44.10\u202fPM.png';
const DEMO_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsPnECsq5cMDN0aQKmurhEAWCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEvTPAqsgmoaz8xeCAAAAAElFTkSuQmCC',
  'base64'
);

function demoConversations(user) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = demoUser(910001, 'ada');
  const lin = demoUser(910002, 'lin');
  return [
    {
      id: 910001, kind: 'direct', title: 'ada', status: 'active', archived: false,
      members: [
        { ...self, role: 'member', status: 'member', joinedAt: '2026-08-11T12:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-11T12:01:00Z' },
      ],
      memberCount: 2, membershipStatus: 'member', myRole: 'member', requester: null, peer: ada,
      latestMessage: null, latestSummary: 'The proposal card is ready to review.',
      lastActivityAt: '2026-08-13T13:30:00Z', unreadCount: 2,
      canSend: true, canInvite: false, canManage: false,
    },
    {
      id: 910002, kind: 'group', title: 'Launch crew', status: 'active', archived: false,
      members: [
        { ...self, role: 'owner', status: 'member', joinedAt: '2026-08-10T10:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-10T10:02:00Z' },
        { ...lin, role: 'member', status: 'member', joinedAt: '2026-08-10T10:03:00Z' },
      ],
      memberCount: 3, membershipStatus: 'member', myRole: 'owner', requester: null, peer: null,
      latestMessage: null, latestSummary: 'I attached the launch checklist.',
      lastActivityAt: '2026-08-13T12:45:00Z', unreadCount: 0,
      canSend: true, canInvite: true, canManage: true,
    },
    {
      id: 910003, kind: 'group', title: 'Design review', status: 'active', archived: false,
      members: [], memberCount: 4, membershipStatus: 'invited', myRole: 'member',
      requester: lin, peer: null, latestMessage: null, latestSummary: '',
      // Fixed, and therefore always further back than the relative form's
      // seven-day floor (#1808): this row's stamp is a DATE, not an age. It
      // used to read "412d ago" here, which is a duration and not an answer.
      lastActivityAt: '2026-08-13T11:00:00Z', unreadCount: 0,
      canSend: false, canInvite: false, canManage: false,
    },
  ];
}

function demoMessages(user, conversationId) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = demoUser(910001, 'ada');
  if (conversationId === 910001) return [
    {
      // #1808: the thread's oldest row, fixed in an earlier YEAR so the
      // transcript's third stamp branch is on screen in every preview. The
      // rows below it are this year's, so one scroll of this pane shows all
      // three spellings the transcript uses. It used to print "08:40 AM"
      // here and "01:20 PM" below, with nothing to say the two were two
      // years apart.
      id: 9100100, conversationId, sender: ada,
      content: 'This is where the thread started, back in 2024.',
      createdAt: '2024-11-02T08:40:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [],
    },
    {
      // `saved: true` on exactly one demo row, so the staging preview and the
      // declared checks show BOTH states of the save button on one screen —
      // filled here, empty on every other row. The real flag is hydrated per
      // viewer in services/conversations.js; this is the ?demo=1 stand-in,
      // because `conversation_message_bookmarks` is staging:private and a
      // staging clone therefore has the table and none of the rows.
      id: 9100101, conversationId, sender: ada, saved: true,
      content: 'Can you look at the latest proposal?', createdAt: '2026-08-13T13:20:00Z', editedAt: null,
      reply: null, reactions: [{ emoji: '👍', count: 2, reacted: false, users: ['ada', self.username] }],
      attachments: [], objects: [{
        type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
        sessionId: 3327, title: 'Platform Messages', subtitle: 'Homeroom', state: 'active',
        author: 'ada', href: '#app/usernode/dev/proposals/3327',
      }],
    },
    {
      id: 9100102, conversationId, sender: self,
      content: 'Yes — the consent and privacy boundary looks right.', createdAt: '2026-08-13T13:25:00Z', editedAt: '2026-08-13T13:26:00Z',
      reply: { id: 9100101, sender: ada, content: 'Can you look at the latest proposal?' },
      reactions: [], attachments: [], objects: [{
        type: 'app', appId: 1, appSlug: 'usernode', available: true,
        title: 'Homeroom', subtitle: 'Platform app', state: 'active', author: 'ada',
        href: '#app/usernode',
      }, {
        type: 'issue', appId: 1, appSlug: 'usernode', issueNumber: 488, available: true,
        title: 'Platform-wide private messaging', subtitle: 'Homeroom · Issue #488',
        state: 'open', author: 'ada', href: '#app/usernode/dev/issues/488',
      }],
    },
    {
      id: 9100103, conversationId, sender: ada,
      content: 'The proposal card is ready to review.', createdAt: '2026-08-13T13:30:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [{
        type: 'spec', appId: 1, appSlug: 'usernode', sessionId: 3327, version: 1,
        available: true, title: 'Platform Messages spec v1', subtitle: 'Homeroom',
        state: 'v1', author: 'ada', href: '#app/usernode/dev/sessions/3327',
      }, {
        type: 'governance', appId: 1, appSlug: 'usernode', proposalId: 701,
        available: true, title: 'Enable Messages rollout', subtitle: 'Homeroom governance',
        state: 'open', author: 'ada', href: '#app/usernode/dev/governance/701',
      }, { type: 'spec', available: false }],
    },
  ];
  if (conversationId === 910002) return [{
    id: 9100201, conversationId, sender: ada,
    content: 'I attached the launch checklist.', createdAt: '2026-08-13T12:45:00Z', editedAt: null,
    reply: null, reactions: [], attachments: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'launch-checklist.md', size: 842,
      contentType: 'text/markdown', kind: 'markdown',
      url: `/api/conversations/${conversationId}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1`,
      viewUrl: null,
    }, {
      // #2113: a screenshot named the way macOS names them, with a narrow
      // no-break space before "PM". Serving it used to 500 because that
      // character cannot travel in a Content-Disposition header, so the
      // preview shows the fix: the image renders instead of breaking.
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: DEMO_SCREENSHOT_NAME,
      size: DEMO_SCREENSHOT_PNG.length, contentType: 'image/png', kind: 'image',
      url: `/api/conversations/${conversationId}/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?demo=1`,
      viewUrl: null,
    }], objects: [],
  }];
  return [];
}

function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

function conversationRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  router.use('/api/conversations', privateJson);
  router.use('/api/me/blocks', privateJson);

  router.get('/api/conversations', async (req, res) => {
    try {
      if (isDemo(req)) return res.json({ conversations: demoConversations(req.user), demo: true });
      return res.json({ conversations: await conversations.listConversations(pool, req.user) });
    } catch (err) {
      log.error('conversations', 'list failed', { err: err.message, userId: req.user.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations', conversationInviteLimiter, async (req, res) => {
    try {
      if (isDemo(req)) return res.status(201).json({ conversation: demoConversations(req.user)[0], demo: true });
      const result = req.body?.kind === 'direct'
        ? await conversations.createDirect(pool, req.user, conversations.strictId(req.body.user_id))
        : req.body?.kind === 'group'
          ? await conversations.createGroup(pool, req.user, req.body.title, req.body.member_ids)
          : null;
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: result.conversationId });
      return res.status(201).json({ conversation: result.conversation });
    } catch (err) {
      log.error('conversations', 'create failed', { err: err.message, userId: req.user.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/conversations/:id', async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      if (isDemo(req)) {
        const item = demoConversations(req.user).find((row) => row.id === id);
        return item ? res.json({ conversation: item, demo: true }) : sendNotFound(res);
      }
      const conversation = await conversations.getConversation(pool, req.user, id);
      return conversation ? res.json({ conversation }) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'get failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/conversations/:id', conversationActionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const conversation = await conversations.updateTitle(pool, req.user, id, req.body?.title);
      if (!conversation) return sendNotFound(res);
      const memberIds = await conversations.activeMemberIds(pool, id);
      pushAudience(memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ conversation });
    } catch (err) {
      log.error('conversations', 'update failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/respond', conversationSafetyLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.respond(pool, req.user, id, req.body?.action);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ conversation: result.conversation, status: req.body.action === 'accept' ? 'member' : 'declined' });
    } catch (err) {
      log.error('conversations', 'respond failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/members', conversationInviteLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.addMembers(pool, req.user, id, req.body?.user_ids);
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ conversation: result.conversation });
    } catch (err) {
      log.error('conversations', 'add members failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/conversations/:id/members/:userId', conversationActionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const targetId = conversations.strictId(req.params.userId);
    if (!id || !targetId) return sendNotFound(res);
    try {
      const result = await conversations.removeMember(pool, req.user, id, targetId);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'remove member failed', { id, targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/leave', conversationSafetyLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.leave(pool, req.user, id);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'leave failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/conversations/:id/messages', async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const before = req.query.before == null ? null : conversations.strictId(req.query.before);
    if (!id || (req.query.before != null && !before)) return sendNotFound(res);
    try {
      if (isDemo(req)) {
        if (!demoConversations(req.user).some((row) => row.id === id && row.membershipStatus === 'member')) return sendNotFound(res);
        return res.json({ messages: demoMessages(req.user, id), nextBefore: null, demo: true });
      }
      const page = await conversations.listMessages(pool, req.user, id, { before, limit: req.query.limit });
      return page ? res.json(page) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'messages list failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      if (isDemo(req)) return res.status(201).json({ message: demoMessages(req.user, 910001)[1], demo: true });
      const result = await conversations.sendMessage(pool, req.user, id, req.body || {});
      if (!result) return sendNotFound(res);
      if (!result.duplicate) {
        await pushNotifications(pool, result.notifications);
        await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
          pushAudience(memberIds, {
            // Object cards are hydrated against one viewer. Never broadcast
            // the sender-authorized card payload to other members; recipients
            // refetch the thread through their own membership/object gates.
            type: 'conversation_message_created', conversationId: id, messageId: result.message.id,
          });
        });
      }
      return res.status(result.duplicate ? 200 : 201).json({ message: result.message, duplicate: result.duplicate });
    } catch (err) {
      log.error('conversations', 'send failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/conversations/:id/messages/:messageId', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.editMessage(pool, req.user, id, messageId, req.body?.content);
      if (!result) return sendNotFound(res);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_message_updated', conversationId: id, messageId: result.message.id,
        });
      });
      return res.json({ message: result.message });
    } catch (err) {
      log.error('conversations', 'edit failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages/:messageId/reactions', conversationReactionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.toggleReaction(pool, req.user, id, messageId, req.body?.emoji);
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_reaction_updated', conversationId: id, messageId,
        });
      });
      return res.json({ reactions: result.reactions });
    } catch (err) {
      log.error('conversations', 'reaction failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #1280, extended to the Messages area: save/unsave one message.
  //
  // PUT saves, DELETE unsaves — the same verbs and the same optimistic
  // client contract the app-chat bookmark has carried since #1280, so the two
  // surfaces behave identically. Both go through `readableMessage`, which is
  // a membership check: saving is a personal act that writes nothing anyone
  // else can see, but it still must not become a way to pin the content of a
  // conversation you are not in.
  //
  // No WebSocket broadcast, deliberately, and for the reason the app-chat
  // toggle has none: a save is private to one user, so there is no audience
  // to tell. It is not rate-limited as a mutation of the conversation either
  // — it mutates only the saver's own list — but it takes the reaction
  // limiter because it is a tap-repeatable button and that is the shape of
  // abuse it could carry.
  // The same two-part gate `listMessages` opens a conversation's history
  // with: a current membership, and — for a direct conversation — a peer
  // neither side has blocked. Then the message must actually belong to that
  // conversation, so a readable id from one cannot be used to save a message
  // out of another.
  async function readableMessage(user, conversationId, messageId) {
    const membership = await conversations.loadMembership(pool, conversationId, user.id);
    if (!membership) return false;
    if (!await conversations.canDirectInteract(pool, membership, user.id)) return false;
    return !!await conversations.getMessage(pool, user, conversationId, messageId);
  }

  router.put(
    '/api/conversations/:id/messages/:messageId/bookmark',
    conversationReactionLimiter,
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      const messageId = conversations.strictId(req.params.messageId);
      if (!id || !messageId) return sendNotFound(res);
      try {
        if (!await readableMessage(req.user, id, messageId)) return sendNotFound(res);
        await messageBookmarks.saveConversationMessage(pool, req.user.id, messageId);
        return res.json({ saved: true });
      } catch (err) {
        log.error('conversations', 'bookmark save failed', { id, messageId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.delete(
    '/api/conversations/:id/messages/:messageId/bookmark',
    conversationReactionLimiter,
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      const messageId = conversations.strictId(req.params.messageId);
      if (!id || !messageId) return sendNotFound(res);
      try {
        // Unsave needs no readability check: it only ever deletes THIS user's
        // own row, and a viewer who has since left the conversation must
        // still be able to clear what they saved from it.
        await messageBookmarks.removeConversationMessage(pool, req.user.id, messageId);
        return res.json({ saved: false });
      } catch (err) {
        log.error('conversations', 'bookmark remove failed', { id, messageId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post('/api/conversations/:id/read', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.body?.message_id);
    if (!id || !messageId) return sendNotFound(res);
    // ?demo=1 has no rows behind it, so the real markRead below finds no
    // conversation 910001 and answers 404 — and opening a thread ALWAYS
    // marks it read (loadThread's last line), so every demo Messages route
    // logged a console error on load. The client swallows the failure, which
    // is why this survived: nothing on screen looked wrong. A console error
    // on any route fails proposal checks, so the first declared check to load
    // this screen is the first thing that could have caught it.
    //
    // Read state is per viewer and the demo conversations are request-time
    // fictions, so there is nothing to record: acknowledging it is the whole
    // correct behaviour, exactly as the other demo branches do.
    if (isDemo(req)) {
      if (!demoConversations(req.user).some((row) => row.id === id)) return sendNotFound(res);
      return res.json({ ok: true, demo: true });
    }
    try {
      const result = await conversations.markRead(pool, req.user, id, messageId);
      if (!result) return sendNotFound(res);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_read', conversationId: id,
          userId: req.user.id, messageId: result.messageId,
        });
      });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'mark read failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/typing', conversationReactionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id || typeof req.body?.typing !== 'boolean') return sendNotFound(res);
    try {
      const memberIds = await conversations.withLockedAudience(pool, req.user, id, (audience) => {
        pushAudience(audience, {
          type: 'conversation_typing', conversationId: id,
          userId: req.user.id, typing: req.body.typing,
        }, { excludeUserId: req.user.id });
      });
      if (!memberIds) return sendNotFound(res);
      return res.status(204).end();
    } catch (err) {
      log.error('conversations', 'typing failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages/:messageId/report', conversationReportLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.reportMessage(
        pool, req.user, id, messageId, req.body?.reason, req.body?.detail
      );
      return result ? res.status(202).json({ ok: true }) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'report failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/conversations/:id/attachments',
    attachmentUploadLimiter,
    express.raw({ type: '*/*', limit: '21mb' }),
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      if (!id) return sendNotFound(res);
      try {
        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const ext = attachments.fileExt(filename);
        let verdict = ext === 'zip'
          ? attachments.validateUpload({ filename, data })
          : attachments.validateChatUpload({ filename, data });
        if (verdict.ok && verdict.kind === 'zip') {
          verdict = { ...verdict, kind: 'binary' };
        }
        if (verdict.ok && ext !== 'zip' && verdict.kind !== 'image'
            && attachments.isUtf8Text(data)
            && data.length > MAX_CONVERSATION_TEXT_BYTES) {
          verdict = { ok: false, error: 'Text/code/Markdown/HTML files must be 200 KB or smaller' };
        }
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });
        const attachmentId = crypto.randomBytes(16).toString('hex');
        const stored = await conversations.transaction(pool, async (db) => {
          const membership = await conversations.lockInteractionMembership(db, id, req.user.id);
          if (!membership) return null;
          // All uploads take these quota locks in the same order. The SUM and
          // INSERT therefore form one serializable quota decision even when
          // requests for one user/conversation arrive concurrently.
          await db.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [`conversation-attachment-quota:${id}`]
          );
          await db.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [`user-attachment-quota:${req.user.id}`]
          );
          const { rows } = await db.query(
            `SELECT
               COALESCE(SUM(size_bytes) FILTER (WHERE conversation_id = $1), 0)::bigint AS conversation_total,
               COALESCE(SUM(size_bytes) FILTER (WHERE user_id = $2), 0)::bigint AS user_total
             FROM conversation_message_attachments`,
            [id, req.user.id]
          );
          const totals = rows[0];
          if (Number(totals.conversation_total) + data.length > MAX_CONVERSATION_ATTACHMENT_BYTES
              || Number(totals.user_total) + data.length > MAX_USER_ATTACHMENT_BYTES) {
            return { full: true };
          }
          await db.query(
            `INSERT INTO conversation_message_attachments
               (id, conversation_id, user_id, kind, filename, content_type, size_bytes, meta, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [attachmentId, id, req.user.id, verdict.kind, filename, verdict.contentType,
             data.length, verdict.meta ? JSON.stringify(verdict.meta) : null, data]
          );
          return { full: false };
        });
        if (!stored) return sendNotFound(res);
        if (stored.full) {
          return res.status(400).json({ error: 'Conversation attachment storage is full' });
        }
        const base = `/api/conversations/${id}/attachments/${attachmentId}`;
        return res.status(201).json({ attachment: {
          id: attachmentId, name: filename, size: data.length,
          contentType: verdict.contentType, kind: verdict.kind, meta: verdict.meta || null,
          url: base, viewUrl: verdict.kind === 'html' ? `${base}/view` : null,
        } });
      } catch (err) {
        log.error('conversations', 'attachment upload failed', { id, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  async function loadAttachment(req, res, { htmlOnly = false } = {}) {
    const id = conversations.strictId(req.params.id);
    const attachmentId = String(req.params.attachmentId || '');
    if (!id || !/^[a-f0-9]{32}$/.test(attachmentId)) return null;
    if (isDemo(req) && id === 910002 && !htmlOnly) {
      if (attachmentId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
        return {
          id: attachmentId, kind: 'markdown', filename: 'launch-checklist.md',
          content_type: 'text/markdown', message_id: 9100201, user_id: 910001,
          data: Buffer.from('# Launch checklist\n\n- Verify consent states\n- Verify private cards\n'),
        };
      }
      if (attachmentId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
        return {
          id: attachmentId, kind: 'image', filename: DEMO_SCREENSHOT_NAME,
          content_type: 'image/png', message_id: 9100201, user_id: 910001,
          data: DEMO_SCREENSHOT_PNG,
        };
      }
    }
    const membership = await conversations.loadMembership(pool, id, req.user.id);
    if (!membership || !(await conversations.canDirectInteract(pool, membership, req.user.id))) return null;
    const { rows } = await pool.query(
      `SELECT id, kind, filename, content_type, data, message_id, user_id
         FROM conversation_message_attachments
        WHERE id = $1 AND conversation_id = $2`,
      [attachmentId, id]
    );
    const row = rows[0];
    if (!row || (htmlOnly && row.kind !== 'html')) return null;
    if (row.message_id == null && row.user_id !== req.user.id) return null;
    return row;
  }

  router.get('/api/conversations/:id/attachments/:attachmentId', async (req, res) => {
    try {
      const row = await loadAttachment(req, res);
      if (!row) return res.status(404).end();
      const inline = row.kind === 'image';
      const contentType = inline
        ? (row.content_type || 'application/octet-stream')
        : row.kind === 'binary'
          ? (row.content_type === 'application/zip' ? 'application/zip' : 'application/octet-stream')
          : 'text/plain; charset=utf-8';
      res.set('Content-Type', contentType);
      // The stored filename is arbitrary UTF-8, and a header value may only
      // carry Latin-1: build the header through the shared helper rather
      // than interpolating the name, or res.set() throws and the response
      // becomes a 500 (#2113).
      res.set('Content-Disposition', attachments.attachmentDisposition(
        inline ? 'inline' : 'attachment', row.filename
      ));
      return res.send(row.data);
    } catch (err) {
      log.error('conversations', 'attachment download failed', { err: err.message });
      return res.status(500).end();
    }
  });

  router.get('/api/conversations/:id/attachments/:attachmentId/view', async (req, res) => {
    try {
      const row = await loadAttachment(req, res, { htmlOnly: true });
      if (!row) return res.status(404).end();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('Content-Disposition', attachments.attachmentDisposition('inline', row.filename || 'file.html'));
      return res.send(row.data);
    } catch (err) {
      log.error('conversations', 'attachment view failed', { err: err.message });
      return res.status(500).end();
    }
  });

  router.get('/api/me/blocks', async (req, res) => {
    try {
      return res.json({ users: await conversations.listBlocks(pool, req.user.id) });
    } catch (err) {
      log.error('conversations', 'block list failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/me/blocks/:userId', conversationSafetyLimiter, async (req, res) => {
    const targetId = conversations.strictId(req.params.userId);
    if (!targetId) return sendNotFound(res);
    try {
      const result = await conversations.setBlock(pool, req.user.id, targetId, true);
      if (!result) return sendNotFound(res);
      for (const audience of result.conversationAudiences || []) {
        pushAudience(audience.memberIds, {
          type: 'conversation_membership_changed', conversationId: audience.conversationId,
        });
      }
      const { pushToUser } = require('../services/ws');
      for (const userId of result.memberIds) pushToUser(userId, { type: 'notifications_changed' });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'block failed', { targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/blocks/:userId', conversationSafetyLimiter, async (req, res) => {
    const targetId = conversations.strictId(req.params.userId);
    if (!targetId) return sendNotFound(res);
    try {
      const result = await conversations.setBlock(pool, req.user.id, targetId, false);
      if (!result) return sendNotFound(res);
      for (const audience of result.conversationAudiences || []) {
        pushAudience(audience.memberIds, {
          type: 'conversation_membership_changed', conversationId: audience.conversationId,
        });
      }
      const { pushToUser } = require('../services/ws');
      for (const userId of result.memberIds) pushToUser(userId, { type: 'notifications_changed' });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'unblock failed', { targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Private moderation queue. View-only admins may inspect retained evidence;
  // resolving/dismissing is a privileged write with resolver attribution.
  router.use('/api/admin/conversation-reports', privateJson);

  async function loadReportedAttachment(req, { htmlOnly = false } = {}) {
    const reportId = conversations.strictId(req.params.id);
    const attachmentId = String(req.params.attachmentId || '');
    if (!reportId || !/^[a-f0-9]{32}$/.test(attachmentId)) return null;
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.filename, a.content_type, a.data
         FROM conversation_message_reports r
         JOIN conversation_message_attachments a
           ON a.conversation_id = r.conversation_id
          AND a.message_id = r.message_id
        WHERE r.id = $1 AND a.id = $2`,
      [reportId, attachmentId]
    );
    const row = rows[0] || null;
    return row && (!htmlOnly || row.kind === 'html') ? row : null;
  }

  router.get(
    '/api/admin/conversation-reports/:id/attachments/:attachmentId',
    adminMiddleware,
    async (req, res) => {
      try {
        const row = await loadReportedAttachment(req);
        if (!row) return res.status(404).end();
        const inline = row.kind === 'image';
        res.set('Content-Type', inline ? row.content_type : 'application/octet-stream');
        res.set('Content-Disposition', attachments.attachmentDisposition(
          inline ? 'inline' : 'attachment', row.filename || 'evidence'
        ));
        return res.send(row.data);
      } catch (err) {
        log.error('conversations', 'report attachment failed', { err: err.message });
        return res.status(500).end();
      }
    }
  );

  router.get(
    '/api/admin/conversation-reports/:id/attachments/:attachmentId/view',
    adminMiddleware,
    async (req, res) => {
      try {
        const row = await loadReportedAttachment(req, { htmlOnly: true });
        if (!row) return res.status(404).end();
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Content-Security-Policy', 'sandbox allow-scripts');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Content-Disposition', attachments.attachmentDisposition('inline', row.filename || 'evidence.html'));
        return res.send(row.data);
      } catch (err) {
        log.error('conversations', 'report attachment view failed', { err: err.message });
        return res.status(500).end();
      }
    }
  );

  router.get('/api/admin/conversation-reports', adminMiddleware, async (req, res) => {
    const status = ['pending', 'resolved', 'dismissed'].includes(req.query.status)
      ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.conversation_id, r.message_id, r.reason, r.detail,
                r.content_snapshot, r.evidence_snapshot, r.status,
                r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                reported.username AS reported_username,
                resolver.username AS resolved_by_username
           FROM conversation_message_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users reported ON reported.id = r.reported_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1
          ORDER BY r.created_at ASC, r.id ASC
          LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('conversations', 'report queue failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/admin/conversation-reports/:id/:action',
    adminMiddleware,
    requireAdminWrite,
    async (req, res) => {
      const reportId = conversations.strictId(req.params.id);
      const status = req.params.action === 'resolve'
        ? 'resolved' : req.params.action === 'dismiss' ? 'dismissed' : null;
      if (!reportId || !status) return res.status(404).json({ error: 'Pending report not found' });
      try {
        const { rows } = await pool.query(
          `UPDATE conversation_message_reports
              SET status = $1, resolved_at = NOW(), resolved_by = $2
            WHERE id = $3 AND status = 'pending'
            RETURNING id, status, resolved_at`,
          [status, req.user.id, reportId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Pending report not found' });
        log.info('conversations', 'Conversation report moderated', {
          reportId, status, by: req.user.username,
        });
        return res.json({ report: rows[0] });
      } catch (err) {
        log.error('conversations', 'report moderation failed', { reportId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  return router;
}

module.exports = {
  conversationRoutes,
  privateJson,
  demoConversations,
  demoMessages,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_USER_ATTACHMENT_BYTES,
};
