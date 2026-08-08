const http = require('http');
const { WebSocketServer } = require('ws');
const { getPool } = require('../db/pool');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const notifications = require('./notifications');
const events = require('./events');
const appAccess = require('./app-access');
const attachmentsSvc = require('./attachments');

// #328: server-side cap on a single chat message body. Must match the
// composer `maxlength` (GC_MAX_MESSAGE_LEN in public/js/group-chat.js) — both
// ends agree so a message that passes the composer isn't silently truncated
// here on insert. Raised from 2000 to 8000 alongside markdown support. We
// trim then truncate (rather than reject) to mirror the long-standing
// behaviour: an over-length body from a hostile/buggy client is clamped, not
// dropped.
const MAX_CHAT_LEN = 8000;

let wss;
// Captured in attach() so the module-level push* helpers can run the
// per-app visibility filter (appAccess.getWsVisibility) without every
// caller having to thread a pool through.
let _pool = null;
const rooms = new Map(); // appId -> Set<{ ws, user }>
const globalClients = new Set(); // Set<{ ws, user }> for /ws/events

function attach(server, config) {
  const pool = getPool(config);
  _pool = pool;

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    // Caddy's forward_auth PRESERVES the Connection/Upgrade headers on its
    // auth subrequest while rewriting the URI to /__caddy/access. Node
    // routes any upgrade-flagged request to this 'upgrade' event instead of
    // the normal request listener, so the gate pre-flight for every proxied
    // WebSocket lands here — where it used to fall through to
    // socket.destroy(). forward_auth then read EOF, answered 502, and every
    // WS behind the wildcard (all staging previews / child apps) was
    // unreachable: group chat sat on "Reconnecting…" forever. Re-dispatch
    // anything that isn't one of our real WS endpoints into the regular
    // handler chain (Express) so /__caddy/access — or any other route — can
    // answer with a proper HTTP response over this socket.
    if (!req.url?.startsWith('/ws/')) {
      const handler = server.listeners('request')[0];
      if (!handler) { socket.destroy(); return; }
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      res.shouldKeepAlive = false;
      res.on('finish', () => {
        try { socket.end(); } catch { /* already gone */ }
      });
      handler(req, res);
      return;
    }

    const user = await authenticateWs(req, pool, config);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.url?.startsWith('/ws/events')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user };
        globalClients.add(client);
        log.debug('ws', 'Global events client connected', { userId: user.id });

        ws.on('close', () => {
          globalClients.delete(client);
          log.debug('ws', 'Global events client disconnected', { userId: user.id });
        });
      });
      return;
    }

    if (req.url?.startsWith('/ws/chat/')) {
      const appSlug = req.url.replace('/ws/chat/', '').split('?')[0];
      if (!appSlug) { socket.destroy(); return; }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { user, appSlug });
      });
      return;
    }

    socket.destroy();
  });

  wss.on('connection', async (ws, req, { user, appSlug }) => {
    const app = await resolveAppForAccess(pool, appSlug);
    if (!app) {
      ws.close(4004, 'App not found');
      return;
    }
    // Connect gate is view-level (#621): anyone who may see the app can
    // receive live chat/room broadcasts read-only. Same 4004 as "not
    // found" so the room's existence isn't disclosed (matches the
    // routes' 404-on-deny rule). Mutating message types re-check collab
    // access per message inside handleMessage.
    const allowed = await appAccess.checkAppAccess(pool, app, user, 'view')
      .catch(() => false);
    if (!allowed) {
      ws.close(4004, 'App not found');
      return;
    }
    const appId = app.id;

    const client = { ws, user, appId, appSlug };
    joinRoom(appId, client);

    log.info('ws', 'Client connected', { userId: user.id, appSlug });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        await handleMessage(pool, client, msg);
      } catch (err) {
        log.warn('ws', 'Invalid message', { err: err.message });
      }
    });

    ws.on('close', () => {
      leaveRoom(appId, client);
      log.debug('ws', 'Client disconnected', { userId: user.id, appSlug });
    });
  });

  log.info('ws', 'WebSocket server attached');
}

// Staging-only iframe-JWT fallback, mirroring src/middleware/auth.js.
// `sessions` is staging:private (truncated on every staging redeploy), so
// a browser that kept a cookie from the previous deploy fails the cookie
// path forever: HTTP recovers because the middleware re-mints a session
// from the shell-injected ?token= JWT, but a WebSocket handshake can't
// follow that flow — it just 401s and the client shows "Reconnecting…"
// until the page is reloaded. Accepting the same JWT here (sent by the
// client as ?token= on the WS URL) closes that gap. Gated on
// USERNODE_ENV === 'staging' exactly like the middleware, so prod WS auth
// remains cookie-only.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

async function authenticateWs(req, pool, config) {
  const viaCookie = await authenticateWsCookie(req, pool);
  if (viaCookie) return viaCookie;
  if (!IS_STAGING) return null;
  return authenticateWsStagingJwt(req, pool, config);
}

async function authenticateWsCookie(req, pool) {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session;
    if (!token) return null;

    const { rows } = await pool.query(
      `SELECT s.user_id, s.expires_at, u.username, u.is_admin
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = $1`,
      [token]
    );

    if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
      return null;
    }

    return { id: rows[0].user_id, username: rows[0].username, isAdmin: rows[0].is_admin };
  } catch {
    return null;
  }
}

async function authenticateWsStagingJwt(req, pool, config) {
  try {
    let token;
    try {
      token = new URL(req.url || '', 'http://x').searchParams.get('token');
    } catch {
      return null;
    }
    if (!token) return null;

    // App-scoped identity token (RS256, audience `usernode:app:<id>`).
    // USERNODE_APP_ID is injected by services/app-identity-env.js; when
    // it's absent this fails closed, same as middleware/auth.js.
    let payload;
    try {
      payload = platformJwt.verifyAppIdentityToken(token, {
        appId: process.env.USERNODE_APP_ID,
      });
    } catch (err) {
      log.warn('ws', 'Staging iframe-JWT verification failed', { err: err.message });
      return null;
    }
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'number') return null;

    // Same defense-in-depth as tryMintSessionFromIframeJwt: resolve the
    // user from the local (cloned) users table and refuse on a username
    // mismatch (token minted before a rename).
    const { rows } = await pool.query(
      'SELECT id, username, is_admin FROM users WHERE id = $1',
      [payload.id]
    );
    if (rows.length === 0) return null;
    if (typeof payload.username === 'string' && payload.username !== rows[0].username) {
      return null;
    }

    return { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = {};
  header.split(';').forEach((pair) => {
    const [key, ...vals] = pair.trim().split('=');
    if (key) result[key.trim()] = vals.join('=').trim();
  });
  return result;
}

async function resolveAppForAccess(pool, slug) {
  const { rows } = await pool.query(
    'SELECT id, collab_visibility, view_visibility FROM apps WHERE slug = $1',
    [slug]
  );
  return rows[0] || null;
}

function joinRoom(appId, client) {
  if (!rooms.has(appId)) rooms.set(appId, new Set());
  rooms.get(appId).add(client);
}

function leaveRoom(appId, client) {
  const room = rooms.get(appId);
  if (room) {
    room.delete(client);
    if (room.size === 0) rooms.delete(appId);
  }
}

function broadcast(appId, data, excludeWs = null) {
  const room = rooms.get(appId);
  if (!room) return;
  const payload = JSON.stringify(data);
  for (const client of room) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

// Broadcast to all connected clients (global events like app status changes)
function broadcastGlobal(data) {
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const client of globalClients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
      sent++;
    }
  }
  if (data.event === 'cc_progress' && sent === 0 && globalClients.size === 0) {
    log.debug('ws', 'broadcastGlobal: no clients connected');
  }
}

// #194: validate an inbound thread reference { type, ref } for an app.
// Returns { type, ref } when valid, null otherwise. 'session' and
// 'governance' refs must exist for THIS app (DB lookup); 'issue' refs
// accept any positive integer — the GitHub issue list is cached and
// eventual, so a strict existence check would reject messages on
// fresh issues for up to the cache TTL.
async function validateThread(pool, appId, thread) {
  if (!thread || typeof thread !== 'object') return null;
  const type = thread.type;
  const ref = Number(thread.ref);
  if (!['issue', 'session', 'governance'].includes(type)) return null;
  if (!Number.isInteger(ref) || ref <= 0) return null;
  if (type === 'session') {
    const { rows } = await pool.query(
      'SELECT 1 FROM chat_sessions WHERE id = $1 AND app_id = $2', [ref, appId]
    );
    if (!rows.length) return null;
  } else if (type === 'governance') {
    const { rows } = await pool.query(
      'SELECT 1 FROM issues WHERE id = $1 AND app_id = $2', [ref, appId]
    );
    if (!rows.length) return null;
  }
  return { type, ref };
}

// #621: mutating message types require collab access. Re-checked per
// message (not cached at connect) so a membership revocation takes
// effect immediately — chat rates are low and the lookup is a single
// indexed query. Dropped silently server-side (same pattern as the
// invalid-thread drop): read-only clients don't render these controls,
// so anything arriving here is a stale or hostile client.
const WRITE_MSG_TYPES = new Set(['chat', 'edit', 'react', 'typing']);

async function canWriteChat(pool, client) {
  const { rows } = await pool.query(
    'SELECT id, collab_visibility, view_visibility FROM apps WHERE id = $1',
    [client.appId]
  );
  if (!rows.length) return false;
  return appAccess.checkAppAccess(pool, rows[0], client.user, 'collab');
}

async function handleMessage(pool, client, msg) {
  if (WRITE_MSG_TYPES.has(msg.type)) {
    let allowed;
    try {
      allowed = await canWriteChat(pool, client);
    } catch (err) {
      log.warn('ws', 'write message dropped: access check failed', {
        appId: client.appId, userId: client.user.id, type: msg.type, err: err.message,
      });
      return { ok: false, code: 'write_access_failed' };
    }
    if (!allowed) {
      log.warn('ws', 'write message dropped: not a collaborator', {
        appId: client.appId, userId: client.user.id, type: msg.type,
      });
      return { ok: false, code: 'not_collaborator' };
    }
  }
  switch (msg.type) {
    case 'chat': {
      // #694: optional file attachments, uploaded beforehand via
      // POST /api/apps/:slug/chat-attachments. Malformed ids (or more
      // than the per-message cap) drop the whole message — the sender's
      // client is buggy or hostile either way.
      const attIds = attachmentsSvc.sanitizeAttachmentIds(msg.attachmentIds);
      if (attIds === null) {
        log.warn('ws', 'chat message dropped: bad attachment ids', {
          appId: client.appId, userId: client.user.id,
        });
        return { ok: false, code: 'invalid_attachment_ids' };
      }
      // An attachments-only send is allowed (#694): content stays ''
      // (column is NOT NULL) and the client renders no body.
      const content = (msg.content || '').trim().substring(0, MAX_CHAT_LEN);
      if (!content && !attIds.length) return { ok: false, code: 'empty_message' };

      // #194: optional thread scoping. An invalid/spoofed ref drops the
      // whole message (never silently re-route a thread post into the
      // general stream — the sender's client is buggy or hostile either
      // way, and general chat is the louder surface).
      let thread = null;
      if (msg.thread) {
        thread = await validateThread(pool, client.appId, msg.thread);
        if (!thread) {
          log.warn('ws', 'chat message dropped: invalid thread ref', {
            appId: client.appId, userId: client.user.id,
          });
          return { ok: false, code: 'invalid_thread' };
        }
      }

      // #15: optional quote (Signal-style reply). The client only sends a
      // reference (refMsgId for a chat row, or sessionId for a PR); we
      // re-derive author + snippet server-side from the referenced row so
      // a client can't spoof who said what. If the reference doesn't
      // validate we drop the quote silently and send a plain message.
      // `replyRecipientId` is the author of the quoted thing — used to
      // fire a reply notification below (NULL for system rows / self).
      let quote = null;
      let replyRecipientId = null;
      try {
        const q = msg.quote;
        if (q && typeof q === 'object') {
          if (q.source === 'pr' && Number.isInteger(q.sessionId)) {
            const { rows: prRows } = await pool.query(
              `SELECT cs.id, cs.user_id, cs.pr_number, cs.pr_title, cs.pr_url, u.username
               FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
               WHERE cs.id = $1 AND cs.app_id = $2`,
              [q.sessionId, client.appId]
            );
            if (prRows.length) {
              const r = prRows[0];
              quote = {
                source: 'pr',
                sessionId: r.id,
                prNumber: r.pr_number,
                author: r.username || null,
                snippet: (r.pr_title || `PR #${r.pr_number || r.id}`).substring(0, 200),
                href: r.pr_url || null,
              };
              replyRecipientId = r.user_id || null;
            }
          } else if (['message', 'event', 'spec'].includes(q.source) && Number.isInteger(q.refMsgId)) {
            const { rows: refRows } = await pool.query(
              `SELECT m.id, m.user_id, m.content, m.msg_type, m.metadata, u.username
               FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
               WHERE m.id = $1 AND m.app_id = $2`,
              [q.refMsgId, client.appId]
            );
            if (refRows.length) {
              const r = refRows[0];
              let snippet;
              let author;
              if (r.msg_type === 'spec_share') {
                const sm = (r.metadata || {}).specShare || {};
                snippet = sm.title || `Spec v${sm.version || ''}`.trim();
                author = sm.sharedBy?.username || r.username || null;
              } else if (r.msg_type === 'system' || r.msg_type === 'vote' || r.msg_type === 'conflict') {
                snippet = r.content;
                author = null; // system event — no person to attribute / notify
              } else {
                snippet = r.content;
                // #694: an attachments-only message has empty content —
                // quote it as its first file instead of a blank snippet.
                const quotedAtts = (r.metadata || {}).attachments;
                if (!snippet && Array.isArray(quotedAtts) && quotedAtts.length) {
                  snippet = `\u{1F4CE} ${quotedAtts[0].filename || 'file'}`;
                }
                author = r.username || null;
              }
              const normalizedSource = r.msg_type === 'spec_share'
                ? 'spec'
                : (r.msg_type === 'message' ? 'message' : 'event');
              quote = {
                source: normalizedSource,
                refMsgId: r.id,
                author,
                // Collapse any newlines (multi-line messages) to single
                // spaces so the compact "Replying to…" chip and the small
                // quoted block above a reply stay single-line.
                snippet: (snippet || '').replace(/\s+/g, ' ').trim().substring(0, 200),
              };
              replyRecipientId = r.user_id || null;
            }
          }
        }
      } catch (err) {
        log.warn('ws', 'quote validation failed', { err: err.message });
        quote = null;
        replyRecipientId = null;
      }

      // #694: verify ownership of every referenced attachment before
      // linking — each id must belong to this app + this user and be
      // unlinked. Any miss drops the whole send (hostile/stale client).
      let attRows = [];
      if (attIds.length) {
        const { rows: found } = await pool.query(
          `SELECT id, kind, filename, size_bytes, meta
             FROM chat_message_attachments
            WHERE id = ANY($1) AND app_id = $2 AND user_id = $3 AND message_id IS NULL`,
          [attIds, client.appId, client.user.id]
        );
        if (found.length !== attIds.length) {
          log.warn('ws', 'chat message dropped: attachment ownership check failed', {
            appId: client.appId, userId: client.user.id,
            requested: attIds.length, found: found.length,
          });
          return { ok: false, code: 'attachment_not_owned' };
        }
        // Preserve the client's send order (the SELECT doesn't).
        attRows = attIds.map((id) => found.find((r) => r.id === id));
      }

      const metadata = (quote || attRows.length) ? {} : null;
      if (quote) metadata.quote = quote;
      if (attRows.length) {
        // Render-time summary rides in the message row's metadata so
        // history loads and broadcasts need no join; the bytea rows are
        // only touched by the serve routes.
        metadata.attachments = attRows.map((r) => ({
          id: r.id, kind: r.kind, filename: r.filename, sizeBytes: r.size_bytes,
          ...(r.meta ? { meta: r.meta } : {}),
        }));
      }

      const insertSql = `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5, $6)
         RETURNING id, created_at`;
      // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
      const insertParams = [client.appId, client.user.id, content, JSON.stringify(metadata || {}),
        thread ? thread.type : null, thread ? thread.ref : null];
      let rows;
      if (attRows.length) {
        // Insert + link atomically — a half-linked send would render
        // chips that 404 while the orphan sweeper still owns the rows.
        const cx = await pool.connect();
        try {
          await cx.query('BEGIN');
          ({ rows } = await cx.query(insertSql, insertParams));
          await cx.query(
            `UPDATE chat_message_attachments SET message_id = $1 WHERE id = ANY($2)`,
            [rows[0].id, attIds]
          );
          await cx.query('COMMIT');
        } catch (err) {
          try { await cx.query('ROLLBACK'); } catch { /* connection gone */ }
          throw err;
        } finally {
          cx.release();
        }
      } else {
        ({ rows } = await pool.query(insertSql, insertParams));
      }

      const outMsg = {
        type: 'chat',
        id: rows[0].id,
        userId: client.user.id,
        username: client.user.username,
        content,
        msgType: 'message',
        ...(metadata ? { metadata } : {}),
        ...(thread ? { thread } : {}),
        createdAt: rows[0].created_at,
      };

      broadcast(client.appId, outMsg);

      events.record(pool, {
        type: events.EVENT_TYPES.CHAT_MESSAGE_SENT,
        userId: client.user.id,
        appId: client.appId,
      });

      // #15: reply notification — ping the author of the quoted message
      // or PR (no-op for self-quotes and authorless system rows).
      try {
        const replyRows = await notifications.createReplyNotification(pool, {
          appId: client.appId,
          replyMessageId: rows[0].id,
          senderId: client.user.id,
          recipientId: replyRecipientId,
        });
        if (replyRows.length) {
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])`,
            [replyRows.map((r) => r.id)]
          );
          for (const row of hydrated) {
            pushNotificationToUser(row.user_id, {
              type: 'notification_new',
              notification: notifications.serialize(row),
            });
          }
        }
      } catch (err) {
        log.warn('ws', 'reply notify failed', { err: err.message });
      }

      // Fan out @mention notifications after the chat echo so UI order
      // stays predictable (everyone sees the message first, target user
      // then sees the bell-badge update).
      try {
        const notifRows = await notifications.createMentionNotifications(pool, {
          appId: client.appId,
          chatMessageId: rows[0].id,
          senderId: client.user.id,
          content,
        });
        if (notifRows.length) {
          // Hydrate with app/sender info so the client can render the
          // dropdown item immediately without another fetch. Mirror the
          // column set of notifications.listForUser so the same
          // serialize() works for both fresh and history rows — kudos
          // added session_id / pr_title / pr_number on top of the
          // original mention shape.
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])`,
            [notifRows.map((r) => r.id)]
          );
          for (const row of hydrated) {
            pushNotificationToUser(row.user_id, {
              type: 'notification_new',
              notification: notifications.serialize(row),
            });
          }
        }
      } catch (err) {
        log.warn('ws', 'mention notify failed', { err: err.message });
      }

      // Posting a message in this app's group chat is the "I've engaged
      // with this thread" action: clear every unread mention/reply/reaction
      // notification this user has for this app (the reply-clears-all
      // behavior). Confirmed in the DB, idempotent, and non-fatal — a
      // notification hiccup must never affect the chat send. On >=1 row
      // cleared, fan out notifications_changed so the sender's bell badge +
      // other tabs (and their chat dots) re-sync.
      try {
        const cleared = await notifications.markReadForAction(
          pool, client.user.id, 'message_sent', client.appId
        );
        if (cleared > 0) {
          pushNotificationToUser(client.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('ws', 'message_sent auto-dismiss failed', {
          appId: client.appId, userId: client.user.id, err: err.message,
        });
      }
      // WebSocket callers intentionally ignore this value. The JSON chat
      // route uses it to return the exact row produced by this canonical
      // mutation path instead of duplicating persistence and fan-out logic.
      return { ok: true, message: outMsg };
    }

    // Message editing: the author rewrites the content of one of their own
    // ordinary chat messages. Canonical mutation path (same as 'chat' /
    // 'react'); the socket is already scoped to the app room and gated by
    // appAccess.checkAppAccess(...,'collab') at connect time.
    // Inbound: { type: 'edit', messageId, content }.
    case 'edit': {
      const messageId = Number(msg.messageId);
      if (!Number.isInteger(messageId) || messageId <= 0) return;
      // Mirror the send path: trim (drops leading/trailing whitespace and
      // blank lines) then cap at MAX_CHAT_LEN. An empty edit is rejected —
      // editing is not a deletion path.
      if (!msg.content || !msg.content.trim()) return;
      const content = msg.content.trim().substring(0, MAX_CHAT_LEN);

      // Authorization (enforced server-side so a hand-crafted request can't
      // edit another user's message or a system/vote/conflict/spec_share
      // row): the row must exist in this app, belong to the editor, and be
      // an ordinary 'message'.
      const { rows } = await pool.query(
        `SELECT user_id, msg_type, thread_type, thread_ref
           FROM chat_messages WHERE id = $1 AND app_id = $2`,
        [messageId, client.appId]
      );
      if (!rows.length) {
        log.warn('ws', 'edit dropped: message not found in app', {
          appId: client.appId, userId: client.user.id, messageId,
        });
        return;
      }
      const row = rows[0];
      if (row.user_id !== client.user.id || row.msg_type !== 'message') {
        log.warn('ws', 'edit rejected: not author or not an editable message', {
          appId: client.appId, userId: client.user.id, messageId, msgType: row.msg_type,
        });
        return;
      }

      // Leave metadata (the reply quote) untouched so a reply still points
      // at what it replied to, and reactions (keyed on message id) survive.
      const { rows: upd } = await pool.query(
        `UPDATE chat_messages SET content = $1, edited_at = NOW()
          WHERE id = $2 RETURNING edited_at`,
        [content, messageId]
      );
      const editedAt = upd[0].edited_at;

      // NOTE: we intentionally do NOT re-fire createMentionNotifications for
      // edits in this iteration — a brand-new @mention introduced by an edit
      // won't notify. See the spec's "Deferred work".

      // Echo the row's thread scope (when set) so thread-scoped edits route
      // to the right render target, mirroring the 'chat' broadcast.
      const thread = row.thread_type
        ? { type: row.thread_type, ref: row.thread_ref }
        : null;
      broadcast(client.appId, {
        type: 'chat_edit',
        messageId,
        content,
        editedAt,
        ...(thread ? { thread } : {}),
      });
      break;
    }

    // #25: emoji reaction toggle. Slack-model — a user may stack multiple
    // distinct emoji on one message; the same emoji twice toggles it off.
    // The socket is already scoped to an app room, so we only need to
    // confirm the message lives in this app before mutating.
    case 'react': {
      const messageId = Number(msg.messageId);
      const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
      // Keep it a single short token (no whitespace) — the picker only
      // ever sends one emoji, and this bounds what lands in the column.
      if (!Number.isInteger(messageId) || !emoji || emoji.length > 16 || /\s/.test(emoji)) return;

      const { rows: mrows } = await pool.query(
        `SELECT user_id FROM chat_messages WHERE id = $1 AND app_id = $2`,
        [messageId, client.appId]
      );
      if (!mrows.length) return;
      const authorId = mrows[0].user_id;

      const { rowCount: deleted } = await pool.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, client.user.id, emoji]
      );
      let added = false;
      if (!deleted) {
        await pool.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
          [messageId, client.user.id, emoji]
        );
        added = true;
      }

      const reactions = await getMessageReactions(pool, messageId);
      broadcast(client.appId, { type: 'reaction', messageId, reactions });

      // Notify the author only when a reaction is *added* (not removed),
      // and never for self-reactions or authorless system rows.
      if (added && authorId) {
        try {
          const notifRows = await notifications.createReactionNotification(pool, {
            appId: client.appId,
            messageId,
            senderId: client.user.id,
            recipientId: authorId,
            emoji,
          });
          if (notifRows.length) {
            const { rows: hydrated } = await pool.query(
              `SELECT n.id, n.kind, n.read_at, n.created_at,
                      n.app_id, a.slug AS app_slug, a.name AS app_name,
                      n.chat_message_id, cm.content AS message_content,
                      cm.thread_type, cm.thread_ref,
                      n.session_id, cs.pr_title, cs.pr_number,
                      su.username AS source_username, n.user_id, n.detail
               FROM notifications n
               LEFT JOIN apps a ON a.id = n.app_id
               LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
               LEFT JOIN chat_sessions cs ON cs.id = n.session_id
               LEFT JOIN users su ON su.id = n.source_user_id
               WHERE n.id = ANY($1::int[])`,
              [notifRows.map((r) => r.id)]
            );
            for (const row of hydrated) {
              pushNotificationToUser(row.user_id, {
                type: 'notification_new',
                notification: notifications.serialize(row),
              });
            }
          }
        } catch (err) {
          log.warn('ws', 'reaction notify failed', { err: err.message });
        }
      }
      break;
    }

    case 'typing': {
      // #194: pass the (shape-checked) thread along so typing indicators
      // don't bleed between general chat and threads. No DB lookup —
      // typing is ephemeral and the worst a bogus ref does is show a
      // typing line in a thread nobody has open.
      const t = msg.thread;
      const typingThread = (t && typeof t === 'object'
        && ['issue', 'session', 'governance'].includes(t.type)
        && Number.isInteger(Number(t.ref)) && Number(t.ref) > 0)
        ? { type: t.type, ref: Number(t.ref) } : null;
      broadcast(client.appId, {
        type: 'typing',
        userId: client.user.id,
        username: client.user.username,
        ...(typingThread ? { thread: typingThread } : {}),
      }, client.ws);
      break;
    }

    default:
      break;
  }
}

// #25: aggregate reactions for a message → [{ emoji, count, users:[username] }]
// ordered by first-reacted. `users` powers both the per-viewer "mine"
// highlight (membership check) and the who-reacted tooltip, so history and
// live broadcasts can share one shape.
async function getMessageReactions(pool, messageId) {
  const { rows } = await pool.query(
    `SELECT mr.emoji, COUNT(*)::int AS count,
            COALESCE(array_agg(u.username ORDER BY mr.created_at), '{}') AS users
     FROM message_reactions mr JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = $1
     GROUP BY mr.emoji
     ORDER BY MIN(mr.created_at)`,
    [messageId]
  );
  return rows.map((r) => ({ emoji: r.emoji, count: r.count, users: r.users || [] }));
}

// Batch variant for history hydration: messageIds → { [id]: reactions[] }.
async function getReactionsForMessages(pool, messageIds) {
  if (!messageIds.length) return {};
  const { rows } = await pool.query(
    `SELECT mr.message_id, mr.emoji, COUNT(*)::int AS count,
            COALESCE(array_agg(u.username ORDER BY mr.created_at), '{}') AS users
     FROM message_reactions mr JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1::int[])
     GROUP BY mr.message_id, mr.emoji
     ORDER BY mr.message_id, MIN(mr.created_at)`,
    [messageIds]
  );
  const out = {};
  for (const r of rows) {
    (out[r.message_id] = out[r.message_id] || []).push({ emoji: r.emoji, count: r.count, users: r.users || [] });
  }
  return out;
}

// `metadata` is an optional plain object persisted to chat_messages.metadata
// (JSONB) and echoed on the live broadcast. Used e.g. by the vote-activity
// lines (promote / vote cast) to carry { vote: { sessionId, prNumber } } so
// the group-chat client can render live vote buttons inline on the row.
// #194: optional `thread` ({ type: 'issue'|'session'|'governance', ref })
// scopes the system message into that thread instead of general chat
// (used by the per-vote activity rows, which post into the proposal's
// thread). Callers are trusted — no ref validation here.
async function sendSystemMessage(pool, appId, content, msgType = 'system', metadata = null, thread = null) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
    [appId, content, msgType, JSON.stringify(metadata || {}),
     thread ? thread.type : null, thread ? thread.ref : null]
  );

  broadcast(appId, {
    type: 'chat',
    id: rows[0].id,
    userId: null,
    username: null,
    content,
    msgType,
    ...(metadata ? { metadata } : {}),
    ...(thread ? { thread } : {}),
    createdAt: rows[0].created_at,
  });
}

function getOnlineUsers(appId) {
  const room = rooms.get(appId);
  if (!room) return [];
  const seen = new Set();
  const users = [];
  for (const client of room) {
    if (!seen.has(client.user.id)) {
      seen.add(client.user.id);
      users.push({ id: client.user.id, username: client.user.username });
    }
  }
  return users;
}

// App-scoped global broadcast with visibility filtering. Public-view
// apps keep the broadcast-to-all fast path; for a view-private app the
// payload (name, status, PR titles...) only goes to admins + members.
// Membership comes from appAccess.getWsVisibility's 10s TTL cache, so
// this is at most one query per app per window. Fail-closed: if the
// lookup errors we drop the event (a stale UI beats a privacy leak).
function broadcastGlobalScoped(payload, { appId = null, appSlug = null } = {}) {
  if (!_pool || (appId == null && !appSlug)) {
    broadcastGlobal(payload);
    return;
  }
  appAccess.getWsVisibility(_pool, { appId, appSlug })
    .then((info) => {
      if (!info) return; // app gone — nothing to broadcast
      if (!info.viewPrivate) {
        broadcastGlobal(payload);
        return;
      }
      const json = JSON.stringify(payload);
      for (const client of globalClients) {
        if (client.ws.readyState !== 1) continue;
        if (client.user.isAdmin || info.memberIds.has(client.user.id)) {
          client.ws.send(json);
        }
      }
    })
    .catch((err) => {
      log.warn('ws', 'scoped broadcast dropped', { type: payload.type, err: err.message });
    });
}

// Push an app status update to all connected clients (filtered for
// view-private apps). `errorReason` (#416) is the concise one-line
// failure reason only — the full build log stays behind the gated
// GET /api/apps/:slug payload.
function pushAppStatusUpdate(app) {
  broadcastGlobalScoped({
    type: 'app_status',
    appId: app.id,
    slug: app.slug,
    status: app.status,
    url: app.url || null,
    errorReason: app.errorReason || null,
  }, { appId: app.id, appSlug: app.slug });
}

function pushSessionUpdate(data) {
  broadcastGlobalScoped({ type: 'session_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// #1038: live working-state for one session (services/session-state.js).
// Scoping is the whole point of having a dedicated helper rather than
// reusing broadcastGlobal: the payload names an app and a session, so an
// unscoped fan-out would tell every connected client that a private app
// has activity.
//
//   shared  → broadcastGlobalScoped, i.e. everyone who may VIEW the app
//             (which is exactly who already sees the shared session card
//             or the auto-run's issue card).
//   private → the owner's own sockets only. A session nobody else can see
//             must not announce itself, not even as an anonymous id.
//
// A payload with no resolved owner AND no app (the row lookup failed) is
// dropped rather than guessed at — failing closed matches
// broadcastGlobalScoped's own stance.
// Pure routing decision, exported so the privacy boundary is unit-testable
// without stubbing the socket registry. 'app' | 'user' | 'none'.
function sessionStateAudience(data) {
  if (!data) return 'none';
  if (data.shared && (data.appId != null || data.appSlug)) return 'app';
  if (data.userId != null) return 'user';
  return 'none';
}

function pushSessionState(data) {
  const payload = { type: 'session_state', ...data };
  switch (sessionStateAudience(data)) {
    case 'app':
      broadcastGlobalScoped(payload, { appId: data.appId, appSlug: data.appSlug });
      break;
    case 'user':
      pushToUser(data.userId, payload);
      break;
    default:
      log.debug('ws', 'session_state dropped: no audience', { sessionId: data.sessionId });
  }
}

function pushVoteUpdate(data) {
  broadcastGlobalScoped({ type: 'vote_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// PR kudos count changed. Fan out the new total + the giver's username
// (so the receiving client can append the new giver to its popover
// cache without a refetch). Same broadcast model as vote_update —
// every connected (and view-authorized) client gets the message and
// decides whether it cares.
function pushKudosUpdate(data) {
  broadcastGlobalScoped({ type: 'kudos_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Notify all clients that an app's metadata changed (e.g. renamed via vote).
function pushAppUpdate(data) {
  broadcastGlobalScoped({ type: 'app_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Notify all clients that an issue/rename-proposal was created, voted on,
// or closed for a given app — so their open vote panel refreshes in real
// time instead of only on page reload.
function pushIssueUpdate(data) {
  broadcastGlobalScoped({ type: 'issue_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// #613: the manual card order in a Dev-board column changed — fan out so
// every client with that app's board open re-pulls the order and repaints
// in real time (same broadcast model as vote_update). `column` names which
// column moved so the client could scope its repaint if it wanted; today it
// just triggers a full dev-data reload.
function pushBoardOrderUpdate(data) {
  broadcastGlobalScoped({ type: 'board_order_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Send a payload to every ADMIN /ws/events socket. Same `client.user.isAdmin`
// filter broadcastGlobalScoped applies for view-private apps, in the loop
// shape of pushNotificationToUser below. Used by the bulk container
// rollover (services/app-rollover.js): its progress payload is an
// operational inventory of every app on the box, so it must not go out over
// broadcastGlobal, which reaches every connected client. View-only admins
// are included deliberately — they can watch, they just can't start one.
function broadcastToAdmins(payload) {
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user && client.user.isAdmin && client.ws.readyState === 1) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

// Send a payload to every /ws/events socket belonging to `userId`. Used for
// @mention delivery — a single user may have multiple tabs open — and, since
// #1038, for the owner-only fan-out of a private session's working state.
// `pushNotificationToUser` is kept as an alias so the notification call sites
// above (and any external caller) read naturally and don't have to churn.
function pushToUser(userId, payload) {
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user.id === userId && client.ws.readyState === 1) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

const pushNotificationToUser = pushToUser;

module.exports = { attach, broadcast, broadcastGlobal, broadcastGlobalScoped, broadcastToAdmins, sendSystemMessage, getOnlineUsers, pushAppStatusUpdate, pushSessionUpdate, pushSessionState, sessionStateAudience, pushVoteUpdate, pushKudosUpdate, pushAppUpdate, pushIssueUpdate, pushBoardOrderUpdate, pushToUser, pushNotificationToUser, getReactionsForMessages, validateThread, handleMessage, MAX_CHAT_LEN };
