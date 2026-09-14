const express = require('express');
const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const models = require('../services/models');
const { listActiveUserIds } = require('../services/active-users');
const appAccess = require('../services/app-access');
const attachmentsSvc = require('../services/attachments');
const messageBookmarks = require('../services/message-bookmarks');
const {
  attachmentUploadLimiter,
  groupChatWriteLimiter,
  messageBookmarkLimiter,
} = require('../middleware/rate-limits');

const THREAD_TYPES = new Set(['issue', 'session', 'governance']);
const MAX_THREAD_REF = 2147483647; // PostgreSQL INTEGER
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Content-Disposition's legacy filename parameter is a header, so it may
// contain ASCII only (macOS screenshot names carry a narrow no-break space
// before AM/PM). The shared helper keeps a readable ASCII fallback and
// carries the exact UTF-8 name in the RFC 5987 parameter; see
// services/attachments.js.
const { attachmentDisposition } = attachmentsSvc;

// #1808: staging demo rows for a chat transcript, injected at request time
// (?demo=1) only when the real read came back EMPTY, so a genuine transcript
// always wins. Never persisted, and a strict no-op outside staging.
//
// Why the group chat needs one at all: `chat_messages` IS cloned into a
// staging preview, so a prod-cloned container has a transcript. A declared
// check does not run against one — it renders against a fresh, empty staging
// database — so the transcript this change is most visibly about was the one
// surface no check could see. These rows also put all three of the stamp's
// branches on screen at once: an earlier year, earlier this year, and today.
// A live seed cannot hold that, because "today" moves.
//
// `thread` is the issue/session/governance thread the reader asked for, or
// null for the general stream. The same four rows serve both: a topic's
// Discussion sheet and an unfolded card's FeedThread read this endpoint with
// a thread filter, and on a clean staging database they came back empty too.
// The ids differ per surface so a page showing both does not draw one id
// twice.
function stagingMockGroupChat(appId, thread) {
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  const base = thread ? 9902011 : 9902001;
  const row = (offset, minutesBack, username, content, createdAt) => ({
    id: base + offset, user_id: 0, username, content,
    msg_type: 'message', metadata: {},
    thread_type: thread ? thread.type : null,
    thread_ref: thread ? thread.ref : null,
    created_at: createdAt || iso(now - minutesBack * 60 * 1000),
    edited_at: null, reactions: [], bookmarked: false,
    has_unread_notification: false, app_id: appId,
  });
  return [
    row(0, 0, 'staging-demo-user',
      '[Mock] Opening line, posted in an earlier year. Its stamp carries the year.',
      '2024-02-19T16:05:00Z'),
    row(1, 0, 'staging-tester',
      '[Mock] A reply from earlier this year: the day, then the time.',
      iso(now - 40 * 24 * 60 * 60 * 1000)),
    row(2, 95, 'staging-demo-user',
      '[Mock] And one from this morning, which needs no date at all.'),
    row(3, 4, 'staging-tester',
      '[Mock] Same again a few minutes ago, so a run of today\'s rows stays easy to scan.'),
    ...[4, 5, 6].map((offset) => ({
      ...row(offset, 7 - offset, null,
        '[Mock] PR #9000001 is now synced with main and conflict-free. It needs 1/2 yes votes needed to merge.'),
      user_id: null, msg_type: 'conflict',
    })),
  ];
}

function parseThreadRef(value) {
  const ref = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN);
  return Number.isSafeInteger(ref) && ref > 0 && ref <= MAX_THREAD_REF ? ref : null;
}

function chatRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Models the UI may offer in its dropdown. Backed by the same
  // allowlist src/routes/sessions.js validates inbound `model`
  // against, so the dropdown and server enforcement can never drift.
  //
  // #800: each entry also carries `changeSize` — the picker's editorial
  // "what kind of work is this model for" copy, which rides along inside
  // models.list() with no work needed here. Deliberately NO measured
  // figures in this payload: nothing readable exists yet (see the
  // agent_cost_cents ledger in routes/anthropic-proxy.js), so the
  // handler stays synchronous and touches no tables. The legacy
  // `outputCostPerMTok` field stays in the payload — it no longer
  // appears in any picker, but removing it would be a needless
  // breaking change for anything else reading this endpoint.
  router.get('/api/models', (_req, res) => {
    res.json({ models: models.list(), default: models.DEFAULT_MODEL });
  });

  router.get('/api/apps/:slug/messages', async (req, res) => {
    const before = req.query.before;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

    // #194: optional thread scoping. Absent → general chat only
    // (thread_type IS NULL) — this is what keeps thread messages out of
    // the general stream. Both params must be present and valid to
    // select a thread; a malformed pair is a 400 rather than silently
    // falling back to general chat.
    const threadType = req.query.thread_type || null;
    const threadRef = req.query.thread_ref != null ? parseThreadRef(req.query.thread_ref) : null;
    if (threadType || req.query.thread_ref != null) {
      if (!THREAD_TYPES.has(threadType) || threadRef == null) {
        return res.status(400).json({ error: 'Invalid thread_type/thread_ref' });
      }
    }

    try {
      // Reading chat history only needs view access (#621): anyone who
      // can see the app gets a read-only look at the dev surface.
      // Posting stays collab-gated at the WS layer (404 on deny so
      // private apps aren't enumerable).
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const appId = app.id;

      // Thread filter: a specific thread when requested, else the
      // general stream (thread_type IS NULL — all legacy rows).
      const params = [appId];
      let threadClause;
      if (threadType) {
        params.push(threadType, threadRef);
        threadClause = `m.thread_type = $2 AND m.thread_ref = $3`;
      } else {
        threadClause = `m.thread_type IS NULL`;
      }
      let beforeClause = '';
      if (before) {
        params.push(before);
        beforeClause = ` AND m.id < $${params.length}`;
      }
      params.push(limit);

      const query = `
        SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata,
               m.thread_type, m.thread_ref, m.created_at, m.edited_at
        FROM chat_messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.app_id = $1 AND ${threadClause}${beforeClause}
        ORDER BY m.id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);
      const messages = rows.reverse();

      // #25: attach emoji reactions so the chat renders them on load (live
      // updates arrive separately over the per-app WS 'reaction' event).
      try {
        const { getReactionsForMessages } = require('../services/ws');
        const byId = await getReactionsForMessages(pool, messages.map((m) => m.id));
        for (const m of messages) m.reactions = byId[m.id] || [];
      } catch (err) {
        log.warn('chat', 'reaction hydrate failed', { message: err.message });
      }

      // #1280: per-message saved flag, so a loaded page renders its
      // bookmark buttons already filled in. Same non-fatal contract as the
      // reaction and unread-dot hydrates around it — a failure here must
      // never break loading the chat, it just renders every button empty.
      if (req.user) {
        try {
          const savedIds = await messageBookmarks.savedMessageIdsFor(
            pool, req.user.id, messages.map((m) => m.id)
          );
          for (const m of messages) m.bookmarked = savedIds.has(m.id);
        } catch (err) {
          log.warn('chat', 'bookmark hydrate failed', { message: err.message });
        }
      }

      // Per-message unread dot: flag any message this user has an unread
      // mention/reply/reaction notification for, so the chat renders a dot
      // next to it. Live messages (over the WS) can't yet carry this flag,
      // so the dot is driven by this loaded-history flag plus client-side
      // reconciliation on notifications_changed. Non-fatal: a failure here
      // must never break loading the chat.
      if (req.user) {
        try {
          const notifications = require('../services/notifications');
          const unreadIds = await notifications.unreadMessageIdsForUser(
            pool, req.user.id, messages.map((m) => m.id)
          );
          for (const m of messages) m.has_unread_notification = unreadIds.has(m.id);
        } catch (err) {
          log.warn('chat', 'unread-dot hydrate failed', { message: err.message });
        }
      }

      // The empty-transcript fallback described at stagingMockGroupChat.
      // Only a first page: a `before` cursor is the client paging PAST what
      // it already has, and answering that with the same four rows again
      // would loop the transcript.
      if (IS_STAGING && req.query.demo === '1' && !before && messages.length === 0) {
        return res.json({
          messages: stagingMockGroupChat(appId, threadType ? { type: threadType, ref: threadRef } : null),
        });
      }

      res.json({ messages });
    } catch (err) {
      log.error('chat', 'Failed to load messages', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Bearer-compatible group-chat write path. The browser normally sends
  // these over /ws/chat/:slug, but CLI/MCP clients authenticate with an API
  // bearer rather than a browser session cookie. Route the JSON request
  // through the same handler so persistence, thread validation, broadcasts,
  // events, mentions, replies, and unread-state updates cannot drift.
  router.post('/api/apps/:slug/messages', groupChatWriteLimiter, async (req, res) => {
    try {
      // Posting is collab-gated and returns the same 404 for a missing app
      // and denied access, so private app slugs cannot be enumerated.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Validate only after the existence-hiding gate. A denied caller gets
      // the same 404 regardless of whether its payload happens to be valid.
      const body = req.body;
      if (!body || Array.isArray(body) || typeof body !== 'object'
          || typeof body.content !== 'string' || !body.content.trim()) {
        return res.status(400).json({ error: 'A non-empty content string is required' });
      }

      const hasThreadType = Object.prototype.hasOwnProperty.call(body, 'thread_type');
      const hasThreadRef = Object.prototype.hasOwnProperty.call(body, 'thread_ref');
      let thread = null;
      if (hasThreadType || hasThreadRef) {
        const ref = parseThreadRef(body.thread_ref);
        if (!hasThreadType || !hasThreadRef
            || !THREAD_TYPES.has(body.thread_type) || ref == null) {
          return res.status(400).json({ error: 'Invalid thread_type/thread_ref' });
        }
        thread = { type: body.thread_type, ref };
      }

      const { handleMessage } = require('../services/ws');
      const result = await handleMessage(
        pool,
        { user: req.user, appId: app.id, appSlug: app.slug },
        { type: 'chat', content: body.content, ...(thread ? { thread } : {}) }
      );
      if (!result?.ok) {
        if (result?.code === 'not_collaborator') {
          return res.status(404).json({ error: 'App not found' });
        }
        if (result?.code === 'write_access_failed') {
          return res.status(503).json({ error: 'temporarily_unavailable' });
        }
        if (result?.code === 'invalid_thread') {
          return res.status(400).json({ error: 'Invalid thread_type/thread_ref' });
        }
        log.error('chat', 'Canonical chat write returned no result', {
          slug: req.params.slug, code: result?.code,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }

      const message = result.message;
      return res.status(201).json({
        message: {
          id: message.id,
          user_id: message.userId,
          username: message.username,
          content: message.content,
          msg_type: message.msgType,
          metadata: message.metadata || {},
          thread_type: message.thread?.type || null,
          thread_ref: message.thread?.ref || null,
          created_at: message.createdAt,
          edited_at: null,
          reactions: [],
        },
      });
    } catch (err) {
      log.error('chat', 'Failed to post message', {
        slug: req.params.slug, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #1280: saving (bookmarking) a group-chat message ─────────────
  //
  // PUT saves, DELETE unsaves, and both are idempotent — the button is a
  // toggle and two tabs (or a double-tap) must not be able to disagree
  // about the result. The saved list is read back through the
  // notifications payload (`savedMessages`), which is what renders the
  // drawer's pinned "Saved" section.
  //
  // Gated on 'view', not 'collab' (#621): a read-only viewer may save what
  // they can read. The message must belong to the named app, so the slug's
  // access check is the real gate rather than decoration — otherwise any
  // public app's slug would unlock every message id on the platform.
  async function resolveBookmarkTarget(req, res) {
    // parseThreadRef is named for its first caller, but what it enforces is
    // "a positive PostgreSQL INTEGER" — the same bound a message id has, so
    // reusing it keeps one definition of that rule rather than two.
    const messageId = parseThreadRef(req.params.id);
    if (messageId == null) {
      res.status(404).json({ error: 'Message not found' });
      return null;
    }
    const app = await appAccess.getAppForUser(
      pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
    );
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    const { rows } = await pool.query(
      `SELECT id FROM chat_messages WHERE id = $1 AND app_id = $2`,
      [messageId, app.id]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Message not found' });
      return null;
    }
    return messageId;
  }

  router.put('/api/apps/:slug/messages/:id/bookmark', messageBookmarkLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const messageId = await resolveBookmarkTarget(req, res);
      if (messageId == null) return undefined;
      await messageBookmarks.save(pool, req.user.id, messageId);
      return res.json({ bookmarked: true });
    } catch (err) {
      log.error('chat', 'Failed to save message', {
        slug: req.params.slug, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/apps/:slug/messages/:id/bookmark', messageBookmarkLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const messageId = await resolveBookmarkTarget(req, res);
      if (messageId == null) return undefined;
      const removed = await messageBookmarks.remove(pool, req.user.id, messageId);
      return res.json({ bookmarked: false, removed });
    } catch (err) {
      log.error('chat', 'Failed to unsave message', {
        slug: req.params.slug, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Group-chat file attachments (#694) ───────────────────────────
  //
  // Upload happens BEFORE send, mirroring dev-chat (#450,
  // src/routes/sessions.js): the client POSTs raw bytes here per file,
  // gets back an attachment id, and passes the ids on the WS 'chat'
  // message, whose handler links them to the message row. The body is
  // always application/octet-stream (real type derived server-side from
  // extension + magic-byte sniff), deliberately sidestepping the global
  // express.json() parser.
  router.post(
    '/api/apps/:slug/chat-attachments',
    attachmentUploadLimiter,
    // Limit must exceed the largest single-file cap (10 MB binaries).
    express.raw({ type: 'application/octet-stream', limit: '11mb' }),
    async (req, res) => {
      try {
        // Uploading is posting: same collab gate as the WS write path
        // (404 on deny so private apps aren't enumerable).
        const app = await appAccess.getAppForUser(
          pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
        );
        if (!app) return res.status(404).json({ error: 'App not found' });

        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = attachmentsSvc.validateChatUpload({ filename, data });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Per-app storage cap — the retention bound for linked rows
        // (orphans are GC'd by the server.js sweeper after 24h).
        const { rows: sumRows } = await pool.query(
          `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
             FROM chat_message_attachments WHERE app_id = $1`,
          [app.id]
        );
        if (Number(sumRows[0].total) + data.length > attachmentsSvc.MAX_APP_CHAT_BYTES) {
          return res.status(400).json({
            error: `This app's chat attachment storage is full (${Math.round(attachmentsSvc.MAX_APP_CHAT_BYTES / 1024 / 1024)} MB max)`,
          });
        }

        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO chat_message_attachments
             (id, app_id, user_id, kind, filename, content_type, size_bytes, meta, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, app.id, req.user.id, verdict.kind, filename, verdict.contentType, data.length,
           verdict.meta ? JSON.stringify(verdict.meta) : null, data]
        );
        return res.json({
          id, kind: verdict.kind, filename,
          contentType: verdict.contentType, sizeBytes: data.length,
          meta: verdict.meta || null,
        });
      } catch (err) {
        // express.raw over-limit bodies raise PayloadTooLargeError before
        // the handler runs; anything landing here is a genuine failure.
        log.error('chat', 'Chat attachment upload failed', { slug: req.params.slug, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // Serve attachment bytes. View-gated like message history (#621 —
  // read-only viewers can download what they can read). Unlinked rows
  // (message_id NULL, upload not yet sent) are only readable by their
  // uploader. Rows are immutable and ids unguessable, so a long private
  // immutable cache is safe. Disposition/type rules: images render
  // inline with their stored type; markdown/html/text serve as
  // text/plain + attachment (stored text/html is NEVER sent inline from
  // this route — HTML only executes on the sandboxed /view route below);
  // binary serves as application/octet-stream + attachment.
  router.get('/api/apps/:slug/chat-attachments/:attId', async (req, res) => {
    const attId = String(req.params.attId || '');
    if (!/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).end();
      const { rows } = await pool.query(
        `SELECT kind, filename, content_type, data, message_id, user_id
           FROM chat_message_attachments
          WHERE id = $1 AND app_id = $2`,
        [attId, app.id]
      );
      if (!rows.length) return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      const inline = att.kind === 'image';
      const contentType = att.kind === 'image'
        ? (att.content_type || 'application/octet-stream')
        : (att.kind === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8');
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', attachmentDisposition(
        inline ? 'inline' : 'attachment', att.filename
      ));
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('chat', 'Chat attachment serve failed', { attId, err: err.message });
      return res.status(500).end();
    }
  });

  // Sandboxed HTML preview (#694): serves an 'html' attachment as a real
  // text/html document under `Content-Security-Policy: sandbox
  // allow-scripts`. The document gets an OPAQUE origin — its scripts can
  // run, but cannot read platform cookies/localStorage or make
  // credentialed same-origin API calls (the SameSite=Lax session cookie
  // rides the top-level navigation that authenticates this GET, never
  // subresource/fetch requests from the opaque-origin document). Never
  // add allow-same-origin here.
  router.get('/api/apps/:slug/chat-attachments/:attId/view', async (req, res) => {
    const attId = String(req.params.attId || '');
    if (!/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).end();
      const { rows } = await pool.query(
        `SELECT kind, filename, data, message_id, user_id
           FROM chat_message_attachments
          WHERE id = $1 AND app_id = $2`,
        [attId, app.id]
      );
      if (!rows.length || rows[0].kind !== 'html') return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', attachmentDisposition('inline', att.filename || 'file.html'));
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('chat', 'Chat attachment view failed', { attId, err: err.message });
      return res.status(500).end();
    }
  });

  // @mention autocomplete candidate set for one app's group chat (#87).
  // Returns the union of:
  //   1. distinct authors of this app's chat messages,
  //   2. the app's active users (same definition that gates voting,
  //      so suggestions match who can actually act on a mention),
  //   3. the app creator.
  // De-duplicated, alphabetical, capped. The client caches this once per
  // app mount and filters by prefix locally; usernames are returned in
  // canonical casing so the inserted @mention renders correctly. Auth is
  // enforced by the global JWT gate (this is a GET under /api/).
  router.get('/api/apps/:slug/mention-suggestions', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appId = app.id;
      const createdBy = app.created_by;

      // Active-user ids, via the shared definition. Non-fatal: if this
      // lookup fails we still return chat authors + creator.
      let activeIds = [];
      try {
        activeIds = await listActiveUserIds(pool, appId);
      } catch (err) {
        log.warn('chat', 'active-user lookup failed for mentions', { message: err.message });
      }

      const ids = [...new Set([
        ...activeIds,
        ...(createdBy != null ? [createdBy] : []),
      ])];

      // Sort case-insensitively (by lowercased username) so uppercase
      // names don't all sort before lowercase ones; the returned value
      // keeps the canonical/original casing. LOWER(u.username) must be in
      // the SELECT list because SELECT DISTINCT requires ORDER BY
      // expressions to appear there.
      const { rows } = await pool.query(
        `SELECT DISTINCT u.username, LOWER(u.username) AS sort_name
           FROM users u
          WHERE u.id = ANY($2::int[])
             OR u.id IN (
               SELECT m.user_id FROM chat_messages m
                WHERE m.app_id = $1 AND m.user_id IS NOT NULL
             )
          ORDER BY sort_name
          LIMIT 500`,
        [appId, ids]
      );

      res.json({ users: rows.map((r) => ({ username: r.username })) });
    } catch (err) {
      log.error('chat', 'Failed to load mention suggestions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { chatRoutes };
