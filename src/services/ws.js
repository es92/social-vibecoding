const { nativeWebSessionIsLive } = require('./web-session-auth');
const http = require('http');
const { WebSocketServer } = require('ws');
const { getPool } = require('../db/pool');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const notifications = require('./notifications');
const events = require('./events');
const appAccess = require('./app-access');
const communities = require('./communities');
const attachmentsSvc = require('./attachments');
const appChat = require('./app-chat');
const groupChannelNotify = require('./group-channel-notify');
const wsBus = require('./ws-bus');

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

// A message from ANOTHER instance. Route it through the same local delivery
// the emitting pod already ran, so one code path decides who may see what.
//
// `oversize` means the payload did not fit in a NOTIFY (8000 bytes) and was
// not sent. The audience still needs to know something moved, so they get the
// nudge their own reconnect path already handles — `resyncCurrentView` in
// public/js/app.js — rather than a truncated event.
function _onBusMessage({ kind, routing, data, oversize, fromWorkflow }) {
  const r = routing || {};
  const payload = oversize ? { type: 'resync_hint' } : data;
  if (payload == null) return;
  // A workflow machine names a notification instead of carrying it: the
  // relay reads it for the recipient's open tabs, outside the transition
  // that created it (src/workflow/merge-followups/machine.ts).
  if (fromWorkflow && kind === 'user' && !oversize && payload.type === 'notification_new'
      && payload.notificationId != null && !payload.notification) {
    relayNotification(r.userId, payload.notificationId);
    return;
  }
  switch (kind) {
    case 'global':
      deliverGlobal(payload);
      return;
    case 'room':
      if (r.appId != null) deliverToRoom(r.appId, payload, null, r);
      return;
    case 'scoped':
      // An oversize scoped event degrades to a GLOBAL nudge rather than a
      // scoped one: "re-pull what you are looking at" leaks nothing, and
      // running the visibility lookup to decide who may receive a content-free
      // hint would cost a query per instance to protect nothing.
      if (oversize) deliverGlobal(payload);
      else deliverGlobalScoped(payload, { appId: r.appId ?? null, appSlug: r.appSlug ?? null });
      // A card a machine moved on a board: the Workshop hears it (debounced, leased).
      if (fromWorkflow && r.boardChange) noteBoardChange({ appId: r.appId ?? null, appSlug: r.appSlug ?? null });
      return;
    case 'admins':
      deliverToAdmins(payload);
      return;
    case 'user':
      if (r.userId != null) deliverToUser(r.userId, payload);
      return;
    case 'session':
      // #4318: the same routing the emitting pod ran, against THIS pod's
      // sockets and THIS pod's watch list.
      if (r.sessionId != null) deliverSessionEvent(payload, r);
      return;
    case 'account_deleted':
      void require('./account-deletion-runtime').receive(_pool, r.userId)
        .catch(() => log.warn('ws', 'Account stream cleanup will retry'));
      return;
    case 'agent_stop':
      // An older release's wake for a Mayor turn's stop: a turn's Stop is its
      // machine's now (src/workflow/turn/), read from the turn's claim.
      return;
    case 'issues_closed':
      // From a workflow transition only: issues it closed on GitHub, for
      // this process's own copy of the open-issues list (github.js keeps one
      // per process). Nothing is sent to sockets; the transition's own
      // issue_update tells browsers to re-read.
      // Applied here only: every process hears the transition itself.
      if (fromWorkflow && r.owner && r.repo) {
        require('./github').applyIssuesChange(r.owner, r.repo, {
          closed: payload.numbers, open: payload.open, invalidate: true,
        });
      }
      return;
    case 'app_access':
      // What another process changed about an app's visibility, governance
      // or admins (app-access.js shareAccessChange), for this process's own
      // caches. Nothing is sent to sockets.
      if (!oversize) {
        appAccess.invalidateVisibilityHere(r.appId ?? payload?.appId ?? null, payload?.slug || null);
        const id = payload?.appId ?? null;
        if (id != null) {
          require('./governance').invalidateGovernanceHere(Number(id));
          require('./app-admins').invalidateAppAdminsHere(Number(id));
        } else {
          require('./app-admins').invalidateAppAdminsHere(null);
        }
      }
      return;
    case 'issues_cache':
      // What another process learned of a repo's issues (github.js
      // shareIssuesChange), for this process's own copy. Nothing is sent to
      // sockets: the sender's issue_update tells browsers to re-read.
      if (!oversize && r.owner && r.repo) require('./github').applyIssuesChange(r.owner, r.repo, payload);
      return;
    case 'homeroom_bot':
      // An older release's wake for the bot's loop, which is the workflow's
      // now (bot-request, bot-lane): nothing to do.
      return;
    // ROLLOUT-ONLY: an older release's stop forward, for a turn it saw this
    // release hold: the process running it asks the turn's machine
    // (turn-leftovers.js receiveOlderStop). Never a socket event.
    case 'session_stop':
      if (!oversize) void require('./turn-leftovers').receiveOlderStop(payload)
        .catch((err) => log.warn('ws', 'A stop an older release forwarded failed', { err: err.message }));
      return;
    // A turn's stream has a new row (services/session-bus.js): this
    // process's subscribers to it read on. Never a socket event.
    case 'stream':
      if (fromWorkflow && r.key != null) require('./session-bus').wake(r.key, Number(r.id) || null);
      return;
    case 'turn_byok':
      if (!oversize) require('./worker').receiveTurnByok(payload);
      return;
    default:
      log.warn('ws', 'unknown bus kind', { kind });
  }
}

// #4177: the bus listener has just been subscribed again, so whatever other
// instances published while it was down never reached this instance's sockets
// (services/ws-bus.js `_listening`). Every one of them gets the nudge an
// oversize payload becomes: the events socket answers it with
// `App.resyncCurrentView`, a chat room with `GroupChat.resyncLoaded`. It says
// only "re-read", so it leaks nothing to anyone in any room.
function _onBusListening() {
  // And what it missed may have invalidated this process's own caches (a
  // merge's issues_closed, an app made private): they are read again rather
  // than trusted until their TTL.
  try {
    appAccess.invalidateAllVisibility();
    require('./governance').invalidateGovernanceHere(null);
    require('./app-admins').invalidateAppAdminsHere(null);
    require('./github').expireIssuesCachesHere();
  } catch (err) {
    log.warn('ws', 'Could not clear the caches after the bus came back', { err: err.message });
  }
  const hint = { type: 'resync_hint' };
  deliverGlobal(hint);
  for (const appId of rooms.keys()) deliverToRoom(appId, hint);
}

// The Homeroom bot follows issue activity. Best-effort by construction: the
// event has already been delivered, and a bot that fails to hear it is
// caught up by its reconcile sweep.
function noteIssueActivityForBot(appId, issueNumber, reason) {
  try {
    require('./homeroom-bot').noteIssueActivity({ appId, issueNumber, reason });
  } catch (err) {
    log.warn('ws', 'homeroom bot wake failed', { err: err.message });
  }
}

function noteProposalActivityForBot(pool, appId, sessionId) {
  try {
    Promise.resolve(require('./homeroom-bot').noteProposalActivity(pool, { appId, sessionId })).catch(() => {});
  } catch (err) {
    log.warn('ws', 'homeroom bot wake failed', { err: err.message });
  }
}

function disconnectUser(userId) {
  for (const clients of [globalClients, ...rooms.values()]) {
    for (const client of clients) {
      if (Number(client.user.id) !== Number(userId)) continue;
      clients.delete(client);
      client.ws.terminate();
    }
  }
}

// A release is replacing this process, which finishes its work without
// serving anyone (docs/plans/draining-releases.md). Every socket is closed
// with 1012 (service restart): each tab reconnects, which the Service sends
// to the new Pod, and re-reads what it shows, as on any dropped socket.
// Returns how many were closed.
let _closedForRelease = false;
function closeAllForRelease() {
  _closedForRelease = true;
  let n = 0;
  for (const clients of [globalClients, ...rooms.values()]) {
    for (const client of [...clients]) {
      try { client.ws.close(1012, 'Service restart'); n += 1; } catch { /* already gone */ }
    }
  }
  return n;
}

function connectedUserIds() {
  return [...new Set([globalClients, ...rooms.values()]
    .flatMap(clients => [...clients].map(client => Number(client.user.id))))];
}

// ── How fast one person may write over the chat socket ─────────────────
//
// The REST twins are limited (POST and DELETE /api/apps/:slug/messages
// mount groupChatWriteLimiter, middleware/rate-limits.js), and the socket
// used to be the open door beside them: every frame ran the live-account
// query and handleMessage, so a script could post, react (each reaction can
// notify the author) or delete as fast as it could send. attach() now runs
// admitSocketFrame on each parsed frame BEFORE any of that.
//
// The check lives here and not in handleMessage on purpose: the REST twins
// call handleMessage behind their own limiter, and the Homeroom bot's relays
// (homeroom-bot-dm.js) call it on a person's behalf. Counting either again
// would charge one message twice.
//
// Budgets per person (user.id, across all their sockets), in one-minute
// windows that start at the first frame, like express-rate-limit's store:
//   - chat, edit and delete share 60, the REST twins' groupChatWriteLimiter;
//   - react has 120, the size of conversationReactionLimiter;
//   - typing has its own 120. The composer sends at most one every two
//     seconds, so only a script reaches it, and over it the frame is
//     dropped without a word: nobody needs telling that a typing dot was
//     not shown.
// In process, which is exact at the one replica the platform ships with; at
// several, each pod counts its own sockets. The Postgres token bucket is not
// worth a round trip per typing frame.
const SOCKET_RATE_WINDOW_MS = 60 * 1000;
const SOCKET_RATE_BUDGETS = Object.freeze({
  chat: Object.freeze({ bucket: 'write', max: 60 }),
  edit: Object.freeze({ bucket: 'write', max: 60 }),
  delete: Object.freeze({ bucket: 'write', max: 60 }),
  react: Object.freeze({ bucket: 'react', max: 120 }),
  typing: Object.freeze({ bucket: 'typing', max: 120, silent: true }),
});
const socketRateWindows = new Map(); // `${bucket}:${userId}` -> { used, resetAt, logged }
let socketRateSweepAt = 0;

// "in 12 seconds", "in 1 second", or "in a moment" when there is no number.
// public/js/group-chat.js words its toast the same way.
function socketRetryPhrase(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'in a moment';
  const whole = Math.ceil(n);
  return `in ${whole} ${whole === 1 ? 'second' : 'seconds'}`;
}

// Spend one frame of `type` from `userId`'s budget. A type with no budget
// (and a frame with no sender) always passes. Over the budget, nothing is
// spent and the answer says how long until the window resets.
function takeSocketRate(userId, type, now = Date.now()) {
  const budget = Object.prototype.hasOwnProperty.call(SOCKET_RATE_BUDGETS, type)
    ? SOCKET_RATE_BUDGETS[type] : null;
  if (!budget || userId == null) return { ok: true };
  // Forget finished windows once a window, so the map holds only the people
  // who wrote in the last minute.
  if (now >= socketRateSweepAt) {
    for (const [key, win] of socketRateWindows) {
      if (win.resetAt <= now) socketRateWindows.delete(key);
    }
    socketRateSweepAt = now + SOCKET_RATE_WINDOW_MS;
  }
  const key = `${budget.bucket}:${userId}`;
  let win = socketRateWindows.get(key);
  if (!win || win.resetAt <= now) {
    win = { used: 0, resetAt: now + SOCKET_RATE_WINDOW_MS, logged: false };
    socketRateWindows.set(key, win);
  }
  if (win.used >= budget.max) {
    const firstRefusal = !win.logged;
    win.logged = true;
    return {
      ok: false,
      bucket: budget.bucket,
      silent: !!budget.silent,
      firstRefusal,
      retryAfterSeconds: Math.max(1, Math.ceil((win.resetAt - now) / 1000)),
    };
  }
  win.used += 1;
  return { ok: true };
}

// The frame check attach() runs before handleMessage. True lets the frame
// through; false means it was refused, and the sender has been told when
// there is something to tell: a delete gets the `delete_error` its composer
// already rolls back on, and chat, edit and react get `rate_limited`
// carrying the refused frame as `retry`, like `join_required` does. Only the
// sending socket hears about it; nothing is broadcast.
function admitSocketFrame(client, msg, now = Date.now()) {
  const type = msg && typeof msg === 'object' ? msg.type : null;
  const userId = client && client.user ? client.user.id : null;
  const verdict = takeSocketRate(userId, type, now);
  if (verdict.ok) return true;
  // One line per person and window, not one per refused frame: a flood
  // would otherwise write the log as fast as it writes the socket.
  if (verdict.firstRefusal) {
    log.warn('ws', 'Throttled', { name: `ws-${verdict.bucket}`, userId, appId: client.appId, type });
  }
  if (verdict.silent) return false;
  const { retryAfterSeconds } = verdict;
  const frame = type === 'delete'
    ? { type: 'delete_error', id: appChat.positiveInt(msg.id), code: 'rate_limited', retryAfterSeconds }
    : {
      type: 'rate_limited',
      retryAfterSeconds,
      error: `You're sending messages too fast. Try again ${socketRetryPhrase(retryAfterSeconds)}.`,
      retry: msg,
    };
  try {
    if (client.ws && client.ws.readyState === 1) client.ws.send(JSON.stringify(frame));
  } catch { /* a closed socket has nobody to tell */ }
  return false;
}

function attach(server, config) {
  const pool = getPool(config);
  // The bot's voice is handed messages from here, and reads its config here.
  require('./homeroom-bot-voice').setConfig(config);
  // Also reconcile after a missed NOTIFY or reconnect. This includes HTTP
  // streams; the timer runs on every pod, independently of leader duties.
  const revocationTimer = setInterval(() => {
    void require('./account-deletion-runtime').reconcile(pool)
      .catch(() => log.warn('ws', 'Account revocation check unavailable'));
  }, 30_000);
  revocationTimer.unref();
  server.once('close', () => clearInterval(revocationTimer));
  _pool = pool;

  // Cross-instance fan-out. A single-pod deployment (the shipped default)
  // behaves exactly as before: every event is still delivered locally first,
  // and its own echo is dropped by instance id.
  wsBus.start({
    pool,
    connectionString: config.databaseUrl,
    onMessage: _onBusMessage,
    onListening: _onBusListening,
  });

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    // A process finishing its work after a release serves no new socket: the
    // tab tries again and reaches the new Pod (closeAllForRelease).
    if (_closedForRelease) { socket.destroy(); return; }
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
        void pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id])
          .then(result => { if (!result.rows.length) disconnectUser(user.id); })
          .catch(() => disconnectUser(user.id));
        log.debug('ws', 'Global events client connected', { userId: user.id });
        // Which build this socket landed on — see sendPlatformVersion. A tab
        // whose socket comes back after a rollout learns the new build from
        // the handshake, not from its next poll.
        sendPlatformVersion(ws, 'connected');

        // #4318: the one thing a tab says on this socket — which sessions
        // it has on screen (see handleEventsFrame).
        ws.on('message', (raw) => {
          void handleEventsFrame(pool, client, raw)
            .catch((err) => log.warn('ws', 'events frame failed', { err: err.message }));
        });

        ws.on('close', () => {
          globalClients.delete(client);
          unwatchAllSessions(client);
          laggingClients.delete(client);
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
    const live = await pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id]).catch(() => ({ rows: [] }));
    if (!live.rows.length) { disconnectUser(user.id); return; }

    log.info('ws', 'Client connected', { userId: user.id, appSlug });

    ws.on('message', async (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw);
        // The rate check comes first, so a frame over the budget costs no
        // query at all (see admitSocketFrame).
        if (!admitSocketFrame(client, msg)) return;
        const live = await pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id]);
        if (!live.rows.length) { disconnectUser(user.id); return; }
        await handleMessage(pool, client, msg);
      } catch (err) {
        log.warn('ws', 'Invalid message', { err: err.message });
        // A chat message that failed before it was written was not posted
        // either.
        if (!storedChats.has(msg)) refuseChat(client, msg, 'send_failed');
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
       WHERE s.token = $1 AND ${nativeWebSessionIsLive('s')}`,
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
    'SELECT id, collab_visibility, view_visibility, moderation_suspended_at FROM apps WHERE slug = $1',
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

// LOCAL delivery. Every `deliver*` below sends to this process's sockets and
// nothing else; the `broadcast*` wrappers do that AND fan out to the other
// instances. Splitting them is what lets a bus message replay the identical
// local half on a remote pod without re-publishing it into a loop.
function deliverToRoom(appId, data, excludeWs = null, audience = {}) {
  const room = rooms.get(appId);
  if (!room) return;
  if (data.type === 'app_suspended') {
    for (const client of room) client.ws.close(4004, 'App suspended by moderation');
    return;
  }
  const payload = JSON.stringify(data);
  const hidden = new Set(audience.blockedUserIds || []);
  const quoteHidden = new Set(audience.quoteHiddenUserIds || []);
  const withoutQuote = quoteHidden.size && data.metadata?.quote
    ? JSON.stringify({ ...data, metadata: { ...data.metadata, quote: null } }) : null;
  const reactionVariants = audience.reactionsByViewer || {};
  // #2387: a reply thread's summary as seen by a viewer who blocked one of
  // its repliers (count and faces without that person). `null` is a real
  // variant — nothing left for them to see — so test for the key.
  const threadVariants = audience.threadByViewer || {};
  for (const client of room) {
    if (client.ws !== excludeWs && client.ws.readyState === 1 && !hidden.has(client.user.id)) {
      const reactions = reactionVariants[client.user.id];
      if (Object.prototype.hasOwnProperty.call(threadVariants, client.user.id)) {
        client.ws.send(JSON.stringify({ ...data, thread: threadVariants[client.user.id] }));
        continue;
      }
      client.ws.send(reactions
        ? JSON.stringify({ ...data, reactions })
        : (withoutQuote && quoteHidden.has(client.user.id) ? withoutQuote : payload));
    }
  }
}

// `excludeWs` is deliberately NOT published: it identifies a socket object in
// THIS process, and the sender it excludes cannot be connected to another one.
function broadcast(appId, data, excludeWs = null) {
  deliverToRoom(appId, data, excludeWs);
  wsBus.publish('room', { appId }, data);
}

// App discussions share a room across users, so a blocked sender must be
// removed from the local audience and from every remote pod's audience.
async function broadcastFromSender(pool, appId, data, senderId, excludeWs = null) {
  const { rows } = await pool.query(
    `SELECT blocker_id FROM user_blocks WHERE blocked_user_id = $1`, [senderId]
  );
  const routing = { appId, blockedUserIds: rows.map((row) => row.blocker_id) };
  const quotedId = Number(data.metadata?.quote?.refMsgId);
  if (Number.isInteger(quotedId) && quotedId > 0) {
    const quoted = await pool.query(
      `SELECT blocked.blocker_id FROM chat_messages quoted
         JOIN user_blocks blocked ON blocked.blocked_user_id = quoted.user_id
        WHERE quoted.id = $1`, [quotedId]
    );
    routing.quoteHiddenUserIds = quoted.rows.map((row) => row.blocker_id);
  }
  // #2387 follow-up: a reply-thread reply now draws a line in the general
  // stream naming its thread's first message. Whoever blocked that message's
  // author cannot open the thread and does not load its replies, so the live
  // frame is withheld from them too.
  const rootId = data.type === 'chat' && data.thread && data.thread.type === appChat.MESSAGE_THREAD
    ? Number(data.thread.ref) : null;
  if (rootId) {
    const rootBlockers = await pool.query(
      `SELECT blocked.blocker_id FROM chat_messages root
         JOIN user_blocks blocked ON blocked.blocked_user_id = root.user_id
        WHERE root.id = $1`, [rootId]
    );
    routing.blockedUserIds.push(...rootBlockers.rows.map((row) => row.blocker_id));
  }
  if (data.type === 'reaction') {
    const blockedReactors = await pool.query(
      `SELECT blocked.blocker_id, reactor.username
         FROM message_reactions reaction
         JOIN users reactor ON reactor.id = reaction.user_id
         JOIN user_blocks blocked ON blocked.blocked_user_id = reaction.user_id
        WHERE reaction.message_id = $1`, [data.messageId]
    );
    const namesByViewer = new Map();
    for (const row of blockedReactors.rows) {
      if (!namesByViewer.has(row.blocker_id)) namesByViewer.set(row.blocker_id, new Set());
      namesByViewer.get(row.blocker_id).add(row.username);
    }
    if (namesByViewer.size) {
      routing.reactionsByViewer = {};
      for (const [viewerId, names] of namesByViewer) {
        routing.reactionsByViewer[viewerId] = data.reactions.map((reaction) => {
          const users = reaction.users.filter((username) => !names.has(username));
          return { ...reaction, count: users.length, users };
        }).filter((reaction) => reaction.count > 0);
      }
    }
  }
  deliverToRoom(appId, data, excludeWs, routing);
  wsBus.publish('room', routing, data);
}

// #2387: tell the room a reply thread changed — a reply arrived, or one was
// deleted — so every general-stream row showing that root can redraw its
// "N replies" line without refetching. Sent after the change itself, and
// best-effort: a missed summary is corrected by the next history load.
async function broadcastThreadSummary(pool, appId, rootId, senderId) {
  try {
    const { thread, byViewer, withheldFrom = [] } = await appChat.threadSummaryForRoom(pool, appId, rootId);
    const { rows } = await pool.query(
      `SELECT blocker_id FROM user_blocks WHERE blocked_user_id = $1`, [senderId]
    );
    const routing = {
      appId,
      // The sender's blockers, and the blockers of a replier past the
      // per-viewer cap: the base frame would name the person they blocked.
      blockedUserIds: [...rows.map((row) => row.blocker_id), ...withheldFrom],
      threadByViewer: byViewer,
    };
    const data = { type: 'thread_summary', root_id: Number(rootId), thread };
    deliverToRoom(appId, data, null, routing);
    wsBus.publish('room', routing, data);
  } catch (err) {
    log.warn('ws', 'thread summary broadcast failed', { appId, rootId, err: err.message });
  }
}

// Broadcast to all connected clients (global events like app status changes)
function deliverGlobal(data) {
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const client of globalClients) {
    if (sendToEventsClient(client, payload)) sent++;
  }
  if (data.event === 'cc_progress' && sent === 0 && globalClients.size === 0) {
    log.debug('ws', 'broadcastGlobal: no clients connected');
  }
  return sent;
}

function broadcastGlobal(data) {
  // #4318: a session's live events are routed by session, not sent to
  // every socket on the platform. Every caller that streams a run (agent
  // runs, Mayor turns, checks, previews, sync-main, recovery) reaches it
  // through here, so the routing is decided in one place.
  if (data && data.type === 'session_event' && positiveSessionId(data.sessionId) != null) {
    broadcastSessionEvent(data);
    return;
  }
  deliverGlobal(data);
  wsBus.publish('global', null, data);
}

// ── Session events, routed by session (#4318) ──────────────────────────
//
// `session_event` is the live stream of one session: the coding agent's
// progress lines, the Mayor's status rows and replies, checks, previews.
// It used to go to EVERY /ws/events socket, so the work grew as open tabs ×
// running sessions × events. Now each event goes to:
//
//   * the session owner's sockets (as before, and also what keeps a tab
//     still running an older build working: it sends no watch frames);
//   * sockets that WATCH the session: a tab sends `watch_session` while it
//     has that session open (DevChat — the session chat and the Mayor chat
//     — on the owner's or an admin's screen) and `unwatch_session` when it
//     leaves, and re-sends its watches whenever the socket reconnects;
//   * for the few events lists and boards also draw (SESSION_FANOUT_EVENTS:
//     a checks run's progress and verdict, a preview built or failed),
//     everyone who may VIEW the app as well — the broadcastGlobalScoped
//     audience. Those are the events App.handleSessionEvent handles before
//     its "is this the open session" gate; every other event it drops
//     unless DevChat has that session open.
//
// The owner and app are read once per session (sessionMetaFor, cached),
// not per event. The bus carries the resolved routing, and the receiving
// pod applies it against its own sockets and its own watch list.
const SESSION_FANOUT_EVENTS = new Set(['checks_ready', 'staging_ready', 'staging_failed']);
const MAX_WATCHED_SESSIONS_PER_SOCKET = 16;
const sessionWatchers = new Map(); // sessionId -> Set<client>

function positiveSessionId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** Pure routing decision for one session event: 'app' | 'session'. */
function sessionEventAudience(data) {
  return data && SESSION_FANOUT_EVENTS.has(data.event) ? 'app' : 'session';
}

// sessionId -> { settled, value, expiresAt, promise, queued }
const SESSION_META_TTL_MS = 60 * 1000;
const SESSION_META_MISS_TTL_MS = 5 * 1000;
const SESSION_META_MAX = 5000;
const sessionMetaCache = new Map();

function sessionMetaFor(sessionId) {
  const now = Date.now();
  const hit = sessionMetaCache.get(sessionId);
  if (hit && (!hit.settled || hit.expiresAt > now)) return hit;
  if (sessionMetaCache.size >= SESSION_META_MAX) {
    for (const [id, entry] of sessionMetaCache) {
      if (entry.settled && entry.expiresAt <= now) sessionMetaCache.delete(id);
    }
    if (sessionMetaCache.size >= SESSION_META_MAX) {
      sessionMetaCache.delete(sessionMetaCache.keys().next().value);
    }
  }
  const entry = { settled: false, value: null, expiresAt: 0, promise: null, queued: 0 };
  const lookup = _pool
    ? Promise.resolve().then(() => _pool.query(
      `SELECT cs.user_id, cs.app_id, a.slug AS app_slug
         FROM chat_sessions cs LEFT JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1`, [sessionId]))
      .then((res) => {
        const row = res && res.rows && res.rows[0];
        return row ? {
          userId: row.user_id == null ? null : Number(row.user_id),
          appId: row.app_id == null ? null : Number(row.app_id),
          appSlug: row.app_slug || null,
        } : null;
      })
    : Promise.resolve(null);
  entry.promise = lookup.catch((err) => {
    log.warn('ws', 'session event routing lookup failed', { sessionId, err: err.message });
    return null;
  }).then((value) => {
    entry.value = value;
    entry.settled = true;
    entry.expiresAt = Date.now() + (value ? SESSION_META_TTL_MS : SESSION_META_MISS_TTL_MS);
    return value;
  });
  sessionMetaCache.set(sessionId, entry);
  return entry;
}

function sessionRouting(sessionId, meta, data) {
  return {
    sessionId,
    userId: meta && meta.userId != null ? meta.userId : null,
    appId: meta && meta.appId != null ? meta.appId : null,
    appSlug: meta && meta.appSlug ? meta.appSlug : null,
    fanout: sessionEventAudience(data) === 'app',
  };
}

function broadcastSessionEvent(data) {
  const sessionId = positiveSessionId(data.sessionId);
  const run = (meta) => {
    const routing = sessionRouting(sessionId, meta, data);
    deliverSessionEvent(data, routing);
    // One queue per session, so a run's stream costs a few NOTIFYs a
    // second however fast it writes (ws-bus.js publishBatched).
    wsBus.publishBatched(`session:${sessionId}`, 'session', routing, data);
  };
  const entry = sessionMetaFor(sessionId);
  // Events of one session keep their order: while an earlier one still
  // waits on the lookup, a later one queues behind it rather than
  // overtaking it on the cached path.
  if (entry.settled && entry.queued === 0) {
    run(entry.value);
    return;
  }
  entry.queued++;
  entry.promise.then((meta) => {
    entry.queued--;
    run(meta);
  }).catch((err) => log.warn('ws', 'session event dropped', { sessionId, err: err.message }));
}

// LOCAL delivery of one session event (also what a bus message replays).
function deliverSessionEvent(data, routing) {
  const r = routing || {};
  const sessionId = positiveSessionId(r.sessionId);
  if (sessionId == null) return;
  const json = JSON.stringify(data);
  const targets = new Set(sessionWatchers.get(sessionId) || []);
  if (r.userId != null) {
    const ownerId = Number(r.userId);
    for (const client of globalClients) {
      if (Number(client.user.id) === ownerId) targets.add(client);
    }
  }
  // The session's own audience first and synchronously, so its stream stays
  // in order with the session's other events.
  for (const client of targets) sendToEventsClient(client, json);
  if (!r.fanout) return;
  // Lists and boards: everyone who may view the app. With no app resolved
  // (the lookup failed) this falls back to what every session event did
  // before #4318 — the event names a session and nothing else.
  if ((r.appId == null && !r.appSlug) || !_pool) {
    for (const client of globalClients) {
      if (!targets.has(client)) sendToEventsClient(client, json);
    }
    return;
  }
  appAccess.getWsVisibility(_pool, { appId: r.appId, appSlug: r.appSlug })
    .then((info) => {
      if (!info || info.suspended) return;
      for (const client of globalClients) {
        if (targets.has(client)) continue;
        if (info.blockedUserIds?.has(client.user.id)) continue;
        if (info.viewPrivate && !client.user.isAdmin && !info.memberIds?.has(client.user.id)) continue;
        sendToEventsClient(client, json);
      }
    })
    .catch((err) => {
      log.warn('ws', 'session event fan-out dropped', { event: data.event, err: err.message });
    });
}

// Who may watch a session's live events: exactly who may open its live
// stream, GET /api/sessions/:id/events in routes/sessions.js — its owner or
// an admin. (The session chat itself, GET /api/sessions/:id, is the same.)
function canWatchSessionRow(row, user) {
  if (!row || !user) return false;
  return !!user.isAdmin || (row.user_id != null && Number(row.user_id) === Number(user.id));
}

async function canWatchSession(pool, user, sessionId) {
  const { rows } = await pool.query(
    'SELECT user_id FROM chat_sessions WHERE id = $1', [sessionId]);
  return canWatchSessionRow(rows[0], user);
}

function watchSession(client, sessionId) {
  if (!client.watching) client.watching = new Set();
  client.watching.add(sessionId);
  let set = sessionWatchers.get(sessionId);
  if (!set) { set = new Set(); sessionWatchers.set(sessionId, set); }
  set.add(client);
}

function unwatchSession(client, sessionId) {
  if (client.watching) client.watching.delete(sessionId);
  const set = sessionWatchers.get(sessionId);
  if (!set) return;
  set.delete(client);
  if (!set.size) sessionWatchers.delete(sessionId);
}

function unwatchAllSessions(client) {
  if (client.wantWatch) client.wantWatch.clear();
  for (const sessionId of [...(client.watching || [])]) unwatchSession(client, sessionId);
}

function replyToEventsClient(client, frame) {
  try {
    if (client.ws && client.ws.readyState === 1) client.ws.send(JSON.stringify(frame));
  } catch { /* closed between the frame and the answer */ }
}

// A tab's frames on /ws/events. Small, few (a tab sends one when it opens
// or leaves a session), and capped per socket so a script cannot make one
// socket cost a query per frame for long.
const EVENTS_FRAME_MAX_BYTES = 512;
const EVENTS_FRAME_BUDGET = 120; // per socket per minute
async function handleEventsFrame(pool, client, raw) {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw && raw.length) || 0;
  if (size > EVENTS_FRAME_MAX_BYTES) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'watch_session' && msg.type !== 'unwatch_session') return;
  const now = Date.now();
  if (!client.frameWindow || client.frameWindow.resetAt <= now) {
    client.frameWindow = { used: 0, resetAt: now + SOCKET_RATE_WINDOW_MS };
  }
  if (++client.frameWindow.used > EVENTS_FRAME_BUDGET) return;
  const sessionId = positiveSessionId(msg.sessionId);
  if (sessionId == null) return;
  if (!client.wantWatch) client.wantWatch = new Map();
  if (msg.type === 'unwatch_session') {
    client.wantWatch.delete(sessionId);
    unwatchSession(client, sessionId);
    replyToEventsClient(client, { type: 'session_watch', sessionId, watching: false });
    return;
  }
  if (client.watching && client.watching.has(sessionId)) {
    replyToEventsClient(client, { type: 'session_watch', sessionId, watching: true });
    return;
  }
  if (client.wantWatch.size >= MAX_WATCHED_SESSIONS_PER_SOCKET && !client.wantWatch.has(sessionId)) {
    replyToEventsClient(client, { type: 'session_watch', sessionId, watching: false, code: 'too_many' });
    return;
  }
  // A token, so an unwatch that lands while this check is in flight wins.
  const token = Symbol('watch');
  client.wantWatch.set(sessionId, token);
  let allowed = false;
  try {
    allowed = await canWatchSession(pool, client.user, sessionId);
  } catch (err) {
    log.warn('ws', 'session watch check failed', { sessionId, err: err.message });
  }
  if (client.wantWatch.get(sessionId) !== token) return;
  if (!allowed || !globalClients.has(client)) {
    client.wantWatch.delete(sessionId);
    replyToEventsClient(client, { type: 'session_watch', sessionId, watching: false, code: 'not_found' });
    return;
  }
  watchSession(client, sessionId);
  replyToEventsClient(client, { type: 'session_watch', sessionId, watching: true });
}

// ── A slow socket is skipped, then told to re-read (#4318) ─────────────
//
// `ws.send` never refuses: what the peer has not read piles up in the
// socket's buffer (`bufferedAmount`), in this process's memory. A tab on a
// stalled connection used to grow it by every event on the platform. Over
// SLOW_CLIENT_MAX_BUFFERED a socket is marked lagging and skipped; once it
// has drained below SLOW_CLIENT_RESUME_BUFFERED it gets ONE `resync_hint` —
// the nudge its reconnect path already answers with App.resyncCurrentView —
// and ordinary delivery resumes.
const SLOW_CLIENT_MAX_BUFFERED = 1024 * 1024;
const SLOW_CLIENT_RESUME_BUFFERED = 64 * 1024;
const LAGGING_CHECK_MS = 1000;
const laggingClients = new Set();
let laggingTimer = null;

function sendToEventsClient(client, json) {
  const socket = client && client.ws;
  if (!socket || socket.readyState !== 1) return false;
  if (client.lagging || Number(socket.bufferedAmount) > SLOW_CLIENT_MAX_BUFFERED) {
    markLagging(client);
    return false;
  }
  socket.send(json);
  return true;
}

function markLagging(client) {
  if (!client.lagging) {
    client.lagging = true;
    laggingClients.add(client);
    log.debug('ws', 'events socket lagging, skipping it', { userId: client.user && client.user.id });
  }
  if (!laggingTimer) {
    laggingTimer = setInterval(checkLaggingClients, LAGGING_CHECK_MS);
    if (typeof laggingTimer.unref === 'function') laggingTimer.unref();
  }
}

function checkLaggingClients() {
  for (const client of laggingClients) {
    const socket = client.ws;
    if (!socket || socket.readyState !== 1 || !globalClients.has(client)) {
      laggingClients.delete(client);
      client.lagging = false;
      continue;
    }
    if (Number(socket.bufferedAmount) > SLOW_CLIENT_RESUME_BUFFERED) continue;
    laggingClients.delete(client);
    client.lagging = false;
    try { socket.send(JSON.stringify({ type: 'resync_hint' })); } catch { /* gone */ }
  }
  if (!laggingClients.size && laggingTimer) {
    clearInterval(laggingTimer);
    laggingTimer = null;
  }
}

// ── The build this process is, told over the socket (#2545) ───────────
//
// `platform_version` carries the one fact /api/version exists for — which
// build is being served — at the moment it is true rather than on the next
// poll. `sha` is a build a request from that tab will now land on: this
// process's own, sent on every /ws/events handshake (`reason: 'connected'`),
// or its successor's, pushed by the process being replaced once its listener
// has closed (`reason: 'rollout'`, see announceSuccessorBuild in server.js).
// The client treats both the same way: public/js/app.js handlePlatformVersion.
//
// Local sockets only, deliberately — no bus. The pod being replaced is telling
// the tabs IT holds that their traffic has moved; the new pod's own sockets
// learned its build from their handshake. Fanning out would reach only tabs
// whose answer is already in hand, and in a multi-replica rollout would tell
// a tab still served by an older pod about a build its requests may not reach
// yet.
function platformVersionPayload(sha, reason) {
  return { type: 'platform_version', sha: sha || 'dev', reason };
}

function sendPlatformVersion(socket, reason) {
  try {
    socket.send(JSON.stringify(platformVersionPayload(process.env.GIT_SHA, reason)));
  } catch { /* closed between the handshake and this send */ }
}

/** Returns the number of open events sockets told. */
function pushPlatformVersion({ sha, reason = 'rollout' } = {}) {
  if (!sha) return 0;
  return deliverGlobal(platformVersionPayload(sha, reason));
}

// #194: validate an inbound thread reference { type, ref } for an app.
// Returns { type, ref } when valid, null otherwise. 'session' and
// 'governance' refs must exist for THIS app (DB lookup); 'issue' refs
// accept any positive integer — the GitHub issue list is cached and
// eventual, so a strict existence check would reject messages on
// fresh issues for up to the cache TTL.
//
// #2387: 'message' is a reply thread, ref = its root. The root must be a
// general-stream message a person wrote in THIS app (so a reply can never
// be a root: no nesting), and — when `viewerId` is given — not by somebody
// the poster blocked, whose message they cannot see to answer.
//
// #4417: 'category' is a topic's channel, ref = its app_category_registry
// row (origin 'topic') of THIS app. A live topic takes posts; an archived or
// merged one is read-only, and comes back marked `closed` so the sender is
// told rather than silently dropped. A reply thread under a message of a
// retired topic is closed with it.
const THREAD_TYPES = Object.freeze(['issue', 'session', 'governance', appChat.MESSAGE_THREAD, appChat.CATEGORY_THREAD]);

const TOPIC_CLOSED_MESSAGE = 'This topic is archived. Its history stays here to read.';

async function topicChannelState(pool, appId, ref) {
  const { rows } = await pool.query(
    `SELECT topic_state FROM app_category_registry
      WHERE id = $1 AND app_id = $2 AND origin = 'topic'`,
    [ref, appId]
  );
  return rows[0] ? (rows[0].topic_state || 'live') : null;
}

async function validateThread(pool, appId, thread, viewerId = null) {
  if (!thread || typeof thread !== 'object') return null;
  const type = thread.type;
  const ref = Number(thread.ref);
  if (!THREAD_TYPES.includes(type)) return null;
  if (!Number.isInteger(ref) || ref <= 0 || ref > 2147483647) return null;
  if (type === appChat.MESSAGE_THREAD) {
    const root = await appChat.findThreadRoot(pool, appId, ref, viewerId);
    if (!root) return null;
    // A deleted message starts no NEW thread (#2387), as in Messages; one
    // that already has replies stays open under its placeholder.
    if (root.deleted_at) {
      const { rows } = await pool.query(
        `SELECT 1 FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'message' AND thread_ref = $2 LIMIT 1`,
        [appId, ref]
      );
      if (!rows.length) return null;
    }
    if (root.thread_type === appChat.CATEGORY_THREAD) {
      const state = await topicChannelState(pool, appId, Number(root.thread_ref));
      if (!state) return null;
      if (state !== 'live') return { type, ref, closed: true };
    }
  } else if (type === appChat.CATEGORY_THREAD) {
    const state = await topicChannelState(pool, appId, ref);
    if (!state) return null;
    if (state !== 'live') return { type, ref, closed: true };
  } else if (type === 'session') {
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
// indexed query. Read-only clients don't render these controls, so an
// edit, a reaction or a typing ping arriving here is dropped silently; a
// chat message is answered (refuseChat below).
const WRITE_MSG_TYPES = new Set(['chat', 'edit', 'react', 'typing']);

// A chat message this server will not post. The composer that sent it
// emptied as it left, so a refusal nobody answered was a message that
// simply vanished (feedback, 21 Oct 2026: a reply on a change's page, sent
// to another app's socket, refused as `invalid_thread`). Answered on the
// sender's socket like `channel_moved`, and public/js/group-chat.js says it
// was not sent. `message` only where the person can act on it; the client
// words the rest. The REST write route has no socket and answers in HTTP.
const NOT_COLLABORATOR_MESSAGE = 'Only collaborators can post here.';

// The chat messages handleMessage has written, so a failure after the row
// (its broadcast, say) is never answered as a message that was not sent.
const storedChats = new WeakSet();

function refuseChat(client, msg, code, message = null) {
  if (!msg || msg.type !== 'chat') return;
  try {
    if (client.ws && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: 'error', code, ...(message ? { message } : {}) }));
    }
  } catch { /* a closed socket has nobody to tell */ }
}

async function canWriteChat(pool, client) {
  if (await require('./moderation').isRestricted(pool, client.user.id)) return false;
  const { rows } = await pool.query(
    'SELECT id, collab_visibility, view_visibility, moderation_suspended_at FROM apps WHERE id = $1',
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
      refuseChat(client, msg, 'write_access_failed');
      return { ok: false, code: 'write_access_failed' };
    }
    if (!allowed) {
      log.warn('ws', 'write message dropped: not a collaborator', {
        appId: client.appId, userId: client.user.id, type: msg.type,
      });
      refuseChat(client, msg, 'not_collaborator', NOT_COLLABORATOR_MESSAGE);
      return { ok: false, code: 'not_collaborator' };
    }
  }
  // Posting in an app's chat is for the members of its community
  // (services/communities.js). Like every refused chat message, this is
  // ANSWERED, and with a question:
  // the sender is a legitimate client whose composer does not know they have
  // not joined, so the refusal goes back to that one socket as a
  // `join_required` frame carrying the message, and the composer
  // (public/js/group-chat.js) offers Join and sends it again. Only 'chat':
  // see chatNeedsJoin for why typing and reactions are not gated.
  if (msg.type === 'chat') {
    let join = null;
    try {
      join = await communities.chatNeedsJoin(pool, client.appId, client.user);
    } catch (err) {
      log.warn('ws', 'chat message dropped: membership check failed', {
        appId: client.appId, userId: client.user.id, err: err.message,
      });
      refuseChat(client, msg, 'write_access_failed');
      return { ok: false, code: 'write_access_failed' };
    }
    if (join) {
      try {
        if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type: 'join_required', ...join, retry: msg }));
      } catch { /* a closed socket has nobody to ask */ }
      return { ok: false, code: 'join_required' };
    }
  }
  // HOMEROOM'S OLD CHANNEL IS READ-ONLY. The platform's own project talks
  // in #general now (the Homeroom community's channel), and this discussion
  // is kept as history: its main stream and its reply threads take no new
  // post. A proposal's or a request's own thread is not the channel and
  // stays open. Answered, like the join refusal, so the composer can say so.
  if (msg.type === 'chat' && (!msg.thread || msg.thread.type === 'message')) {
    let archived = false;
    try {
      archived = await communities.channelArchived(pool, client.appId);
      // #4417: a reply thread under a message in one of the project's
      // TOPIC channels is that topic's, not the old channel's: Homeroom's
      // topics are threads on this same app chat, and they take posts.
      if (archived && msg.thread && msg.thread.type === 'message') {
        const rootId = Number(msg.thread.ref);
        if (Number.isInteger(rootId) && rootId > 0 && rootId <= 2147483647) {
          const { rows: roots } = await pool.query(
            'SELECT thread_type FROM chat_messages WHERE id = $1 AND app_id = $2',
            [rootId, client.appId]
          );
          if (roots[0] && roots[0].thread_type === appChat.CATEGORY_THREAD) archived = false;
        }
      }
    } catch (err) {
      log.warn('ws', 'channel archive check failed', { appId: client.appId, err: err.message });
    }
    if (archived) {
      try {
        if (client.ws && client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({ type: 'error', code: 'channel_moved', message: communities.CHANNEL_MOVED }));
        }
      } catch { /* a closed socket has nobody to tell */ }
      return { ok: false, code: 'channel_moved' };
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
        refuseChat(client, msg, 'invalid_attachment_ids');
        return { ok: false, code: 'invalid_attachment_ids' };
      }
      // An attachments-only send is allowed (#694): content stays ''
      // (column is NOT NULL) and the client renders no body.
      const content = (msg.content || '').trim().substring(0, MAX_CHAT_LEN);
      if (!content && !attIds.length) return { ok: false, code: 'empty_message' };

      // #194: optional thread scoping. An invalid/spoofed ref drops the
      // whole message (never silently re-route a thread post into the
      // general stream — general chat is the louder surface). The sender is
      // told: a stale page sent one here (a thread of another app).
      let thread = null;
      if (msg.thread) {
        thread = await validateThread(pool, client.appId, msg.thread, client.user.id);
        if (!thread) {
          log.warn('ws', 'chat message dropped: invalid thread ref', {
            appId: client.appId, userId: client.user.id,
          });
          refuseChat(client, msg, 'invalid_thread');
          return { ok: false, code: 'invalid_thread' };
        }
        // #4417: a retired topic's channel is read-only. Answered, like the
        // archived channel above, so the composer can say why.
        if (thread.closed) {
          try {
            if (client.ws && client.ws.readyState === 1) {
              client.ws.send(JSON.stringify({ type: 'error', code: 'topic_closed', message: TOPIC_CLOSED_MESSAGE }));
            }
          } catch { /* a closed socket has nobody to tell */ }
          return { ok: false, code: 'topic_closed' };
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
              `SELECT m.id, m.user_id, m.content, m.msg_type, m.metadata, m.moderation_hidden_at, u.username
               FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
               WHERE m.id = $1 AND m.app_id = $2 AND m.deleted_at IS NULL`,
              [q.refMsgId, client.appId]
            );
            // #2387: a deleted message cannot be quoted — its text is gone,
            // so the send goes out as a plain message.
            if (refRows.length) {
              const r = refRows[0];
              let snippet;
              let author;
              if (r.msg_type === 'spec_share') {
                const sm = (r.metadata || {}).specShare || {};
                snippet = sm.title || `Plan v${sm.version || ''}`.trim();
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
          refuseChat(client, msg, 'attachment_not_owned');
          return { ok: false, code: 'attachment_not_owned' };
        }
        // Preserve the client's send order (the SELECT doesn't).
        attRows = attIds.map((id) => found.find((r) => r.id === id));
      }

      // `client.relayKey` (server-side callers only: the Homeroom bot passing
      // a person's DM words on, from its workflow work): the post's mark, so
      // a retry after a restart finds it and posts it nowhere twice.
      const relayKey = typeof client.relayKey === 'string' && client.relayKey ? client.relayKey.slice(0, 200) : null;
      if (relayKey) {
        const { rows: had } = await pool.query(
          `SELECT id, created_at FROM chat_messages WHERE app_id = $1 AND user_id = $2 AND metadata->>'relayKey' = $3 LIMIT 1`,
          [client.appId, client.user.id, relayKey]);
        if (had.length) return { ok: true, message: { id: Number(had[0].id), createdAt: had[0].created_at }, again: true };
      }
      const metadata = (quote || attRows.length || relayKey) ? {} : null;
      if (relayKey) metadata.relayKey = relayKey;
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

      // #2236: `client.postedVia` is 'agent' when the JSON write route was
      // reached with a Homeroom MCP connector credential (routes/chat.js
      // derives it from the request, never from the body). A browser
      // socket has no such field, so its rows stay NULL — a person typing.
      const postedVia = client.postedVia === 'agent' ? 'agent' : null;

      const insertSql = `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, posted_via)
         VALUES ($1, $2, $3, 'message', $4, $5, $6, $7)
         RETURNING id, created_at`;
      // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
      const insertParams = [client.appId, client.user.id, content, JSON.stringify(metadata || {}),
        thread ? thread.type : null, thread ? thread.ref : null, postedVia];
      // 17 Oct 2026: a person's message in any place but a governance vote's
      // is heard by the Homeroom bot's voice there (src/workflow/bot-voice/)
      // in the statement that inserts it: an answer it owes is never only in
      // this process's memory. Never a connector's post.
      const heard = postedVia !== 'agent' && (!thread || thread.type !== 'governance');
      const insert = (db) => (heard
        ? require('../workflow/platform.ts').insertHeard(db, insertSql, insertParams, { appId: client.appId, thread: thread || null })
        : db.query(insertSql, insertParams).then((r) => r.rows));
      let rows;
      if (attRows.length) {
        // Insert + link atomically — a half-linked send would render
        // chips that 404 while the orphan sweeper still owns the rows.
        const cx = await pool.connect();
        try {
          await cx.query('BEGIN');
          rows = await insert(cx);
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
        rows = await insert(pool);
      }
      storedChats.add(msg);

      // #2387 follow-up: a reply in a reply thread is drawn in the general
      // stream as a line naming the message its thread hangs off.
      let threadRoot = null;
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        const root = await appChat.findThreadRoot(pool, client.appId, thread.ref);
        if (root) {
          threadRoot = {
            id: Number(root.id), username: root.username || null,
            content: root.deleted_at ? '' : appChat.snippet(root.content), deleted: !!root.deleted_at,
            // #4417: where the root is: the general stream (null), or one of
            // the project's topic channels, whose stream draws the reply.
            thread_type: root.thread_type || null,
            thread_ref: root.thread_ref == null ? null : Number(root.thread_ref),
          };
        }
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
        ...(threadRoot ? { threadRoot } : {}),
        createdAt: rows[0].created_at,
        // Always present on a human row, so a live row and a loaded one
        // carry the same fact (`posted_via` on the REST payload).
        postedVia,
      };

      await broadcastFromSender(pool, client.appId, outMsg, client.user.id);
      // What the Homeroom bot does with it (its voice's answer, a
      // newcomer's offer, the chat's ask) is the place's workflow machine's:
      // heard above, in the insert's transaction.
      // WP-E: somebody an invite brought, writing here for the first time:
      // the link's maker hears they said hi (services/invite-activity.js).
      // Not awaited here; the small-group ring below waits for it, so the
      // maker is not told about the same message twice. It never throws.
      const hello = postedVia !== 'agent'
        ? require('./invite-activity').noteFirstMessage(pool, {
          appId: client.appId, userId: client.user.id, chatMessageId: rows[0].id,
        })
        : null;
      // A person answering on an issue's thread is exactly what the Homeroom
      // bot waits for; a system row (a claim, a bounty) is not a message. Its
      // request's instance heard it in the statement above (insertHeard).
      // A connector's post (a person's agent writing for them) is heard
      // after it, as what they said; one on a request the bot has no
      // instance for yet only asks for its project's refresh.
      if (thread && thread.type === 'issue' && !heard) noteIssueActivityForBot(client.appId, thread.ref, 'thread');
      else if (thread && thread.type === 'issue' && !rows[0]?.requestHeard) noteIssueActivityForBot(client.appId, thread.ref, 'posted');
      // #4974: that reply also settles the bot's asks in the requester's DM —
      // the question it is waiting on, a stop still showing its buttons — and
      // says so in the request's thread there. Not awaited. The bot's own post
      // of a DM answer is skipped by its viaBotDm flag, a connector's above.
      if (thread && thread.type === 'issue' && postedVia !== 'agent' && !client.viaBotDm) {
        void require('./homeroom-bot-dm').noteRequestReply(pool, {
          appId: client.appId, issueNumber: thread.ref, userId: client.user.id,
          chatMessageId: rows[0].id, content, createdAt: rows[0].created_at,
        }).catch((err) => log.warn('ws', 'Homeroom bot request-reply note failed', { err: err.message }));
      }
      // #3264: a reply in the discussion of the bot's own proposal.
      if (thread && thread.type === 'session') noteProposalActivityForBot(pool, client.appId, thread.ref);
      // #2387: a reply thread grew — every row showing its root redraws its
      // "N replies" line from this frame.
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        await broadcastThreadSummary(pool, client.appId, thread.ref, client.user.id);
      }

      events.record(pool, {
        type: events.EVENT_TYPES.CHAT_MESSAGE_SENT,
        userId: client.user.id,
        appId: client.appId,
      });

      // #2387: everyone who already got a more specific row for this message
      // (quoted → 'reply', @named → 'mention'). A reply-thread participant in
      // this set gets that row, not a second 'thread_reply' one, and a
      // request-discussion participant not a second 'issue_thread_reply'
      // one either (#4535).
      const directlyNotified = new Set();

      // #15: reply notification — ping the author of the quoted message
      // or PR (no-op for self-quotes and authorless system rows).
      try {
        const replyRows = await notifications.createReplyNotification(pool, {
          appId: client.appId,
          replyMessageId: rows[0].id,
          senderId: client.user.id,
          recipientId: replyRecipientId,
        });
        for (const r of replyRows) directlyNotified.add(Number(r.user_id));
        if (replyRows.length) {
          // #4417 follow-up: root_thread_type/_ref say where a reply thread starts
          // (notifications.THREAD_ROOT_COLUMNS_SQL, spelled out so this read stays
          // static SQL), so a row about a reply in a topic's thread opens beside it.
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    (SELECT thread_root.thread_type FROM chat_messages thread_root
                      WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_type,
                    (SELECT thread_root.thread_ref FROM chat_messages thread_root
                      WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocked
                  WHERE blocked.blocker_id = n.user_id
                    AND blocked.blocked_user_id = n.source_user_id
               )`,
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
        for (const r of notifRows) directlyNotified.add(Number(r.user_id));
        if (notifRows.length) {
          // Hydrate with app/sender info so the client can render the
          // dropdown item immediately without another fetch. Mirror the
          // column set of notifications.listForUser so the same
          // serialize() works for both fresh and history rows — kudos
          // added session_id / pr_title / pr_number on top of the
          // original mention shape.
          // #4417 follow-up: root_thread_type/_ref say where a reply thread starts
          // (notifications.THREAD_ROOT_COLUMNS_SQL, spelled out so this read stays
          // static SQL), so a row about a reply in a topic's thread opens beside it.
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    (SELECT thread_root.thread_type FROM chat_messages thread_root
                      WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_type,
                    (SELECT thread_root.thread_ref FROM chat_messages thread_root
                      WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocked
                  WHERE blocked.blocker_id = n.user_id
                    AND blocked.blocked_user_id = n.source_user_id
               )`,
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

      // A small private group's discussion is its group chat: a person's
      // message in the main stream reaches the rest of the group, one row
      // per discussion that folds the next ones in
      // (services/group-channel-notify.js). Whoever this message already
      // reached above, or as the invite maker's "said hi", is not told
      // twice. Never a connector's post.
      if (!thread && postedVia !== 'agent') {
        try {
          const said = hello ? await hello : null;
          if (said?.row && Number(said.row.chat_message_id) === Number(rows[0].id)) {
            directlyNotified.add(Number(said.row.user_id));
          }
          await groupChannelNotify.notifyChannelMessage(pool, {
            appId: client.appId,
            messageId: rows[0].id,
            senderId: client.user.id,
            excludeUserIds: [...directlyNotified],
          });
        } catch (err) {
          log.warn('ws', 'group channel notify failed', { appId: client.appId, err: err.message });
        }
      }

      // #2387: a reply in a reply thread pings the root's author and the
      // earlier repliers ('thread_reply'), minus the sender and anybody the
      // two blocks above already reached — a mention wins.
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        try {
          const threadRows = await notifications.createThreadReplyNotifications(pool, {
            appId: client.appId,
            replyMessageId: rows[0].id,
            rootId: thread.ref,
            senderId: client.user.id,
            excludeUserIds: [...directlyNotified],
          });
          await Promise.all(threadRows.map((row) => notifications.hydrateAndPush(pool, row)));
        } catch (err) {
          log.warn('ws', 'thread reply notify failed', { err: err.message });
        }
      }

      // #4535: a message in a request's discussion thread pings the
      // request's filer and the people who posted there before
      // ('issue_thread_reply'), the same fan-out as a reply thread above
      // minus the sender and anybody this message already reached with a
      // mention or a quote — a mention wins. Proposal and governance
      // threads are left as they are.
      if (thread && thread.type === 'issue') {
        try {
          const issueRows = await notifications.createIssueThreadNotifications(pool, {
            appId: client.appId,
            messageId: rows[0].id,
            issueNumber: thread.ref,
            senderId: client.user.id,
            excludeUserIds: [...directlyNotified],
          });
          await Promise.all(issueRows.map((row) => notifications.hydrateAndPush(pool, row)));
        } catch (err) {
          log.warn('ws', 'issue thread notify failed', { err: err.message });
        }
      }

      // Posting a message in this app's group chat is the "I've engaged
      // with this thread" action: clear every unread mention/reply/reaction
      // notification this user has for this app (the reply-clears-all
      // behavior). Confirmed in the DB, idempotent, and non-fatal — a
      // notification hiccup must never affect the chat send. On >=1 row
      // cleared, fan out notifications_changed so the sender's bell badge +
      // other tabs (and their chat dots) re-sync.
      try {
        let cleared = await notifications.markReadForAction(
          pool, client.user.id, 'message_sent', client.appId
        );
        // Writing in the main stream is reading it to here, so this
        // person's own small-group discussion row is read too. Its own
        // guard: a failure here must not cost the clear above its re-sync.
        if (!thread) {
          try {
            cleared += await groupChannelNotify.markChannelRead(
              pool, client.user.id, client.appId, rows[0].id
            );
          } catch (err) {
            log.warn('ws', 'discussion notification clear failed', {
              appId: client.appId, userId: client.user.id, err: err.message,
            });
          }
        }
        if (cleared > 0) {
          pushNotificationToUser(client.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('ws', 'message_sent auto-dismiss failed', {
          appId: client.appId, userId: client.user.id, err: err.message,
        });
      }
      // #2387: posting in the general stream is reading it — the poster's
      // cursor moves forward to their own message (never back). A thread
      // reply is not in the general stream and leaves the cursor alone.
      if (!thread) {
        try {
          await appChat.advanceReadCursor(pool, client.appId, client.user.id, rows[0].id);
        } catch (err) {
          log.warn('ws', 'read cursor advance failed', {
            appId: client.appId, userId: client.user.id, err: err.message,
          });
        }
      } else if (thread.type === appChat.CATEGORY_THREAD) {
        // #4417: and posting in a topic's channel is reading that channel.
        try {
          await appChat.advanceCategoryCursor(pool, client.appId, thread.ref, client.user.id, rows[0].id);
        } catch (err) {
          log.warn('ws', 'topic read cursor advance failed', {
            appId: client.appId, userId: client.user.id, err: err.message,
          });
        }
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
        `SELECT user_id, msg_type, thread_type, thread_ref, deleted_at, moderation_hidden_at
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
      if (row.moderation_hidden_at || row.user_id !== client.user.id || row.msg_type !== 'message') {
        log.warn('ws', 'edit rejected: not author or not an editable message', {
          appId: client.appId, userId: client.user.id, messageId, msgType: row.msg_type,
        });
        return;
      }
      // #2387: a deleted message stays deleted — an edit is not a way back.
      if (row.deleted_at) return { ok: false, code: 'message_deleted' };

      // Leave metadata (the reply quote) untouched so a reply still points
      // at what it replied to, and reactions (keyed on message id) survive.
      const { rows: upd } = await pool.query(
        `UPDATE chat_messages SET content = $1, edited_at = NOW()
          WHERE id = $2 AND deleted_at IS NULL AND moderation_hidden_at IS NULL RETURNING edited_at`,
        [content, messageId]
      );
      // Deleted between the check and the write.
      if (!upd.length) return { ok: false, code: 'message_deleted' };
      const editedAt = upd[0].edited_at;

      // NOTE: we intentionally do NOT re-fire createMentionNotifications for
      // edits in this iteration — a brand-new @mention introduced by an edit
      // won't notify. See the spec's "Deferred work".

      // Echo the row's thread scope (when set) so thread-scoped edits route
      // to the right render target, mirroring the 'chat' broadcast.
      const thread = row.thread_type
        ? { type: row.thread_type, ref: row.thread_ref }
        : null;
      await broadcastFromSender(pool, client.appId, {
        type: 'chat_edit',
        messageId,
        content,
        editedAt,
        ...(thread ? { thread } : {}),
      }, client.user.id);
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
        `SELECT m.user_id FROM chat_messages m
          WHERE m.id = $1 AND m.app_id = $2
            AND m.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks blocked
               WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.user_id
            )`,
        [messageId, client.appId, client.user.id]
      );
      // Missing, blocked, or (#2387) deleted: nothing to react to.
      if (!mrows.length) return { ok: false, code: 'message_unavailable' };
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
      await broadcastFromSender(pool, client.appId,
        { type: 'reaction', messageId, reactions }, client.user.id);

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
            // #4417 follow-up: root_thread_type/_ref say where a reply thread starts
            // (notifications.THREAD_ROOT_COLUMNS_SQL, spelled out so this read stays
            // static SQL), so a row about a reply in a topic's thread opens beside it.
            const { rows: hydrated } = await pool.query(
              `SELECT n.id, n.kind, n.read_at, n.created_at,
                      n.app_id, a.slug AS app_slug, a.name AS app_name,
                      n.chat_message_id, cm.content AS message_content,
                      cm.thread_type, cm.thread_ref,
                      (SELECT thread_root.thread_type FROM chat_messages thread_root
                        WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_type,
                      (SELECT thread_root.thread_ref FROM chat_messages thread_root
                        WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_ref,
                      n.session_id, cs.pr_title, cs.pr_number,
                      su.username AS source_username, n.user_id, n.detail
               FROM notifications n
               LEFT JOIN apps a ON a.id = n.app_id
               LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
               LEFT JOIN chat_sessions cs ON cs.id = n.session_id
               LEFT JOIN users su ON su.id = n.source_user_id
               WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM user_blocks blocked
                    WHERE blocked.blocker_id = n.user_id
                      AND blocked.blocked_user_id = n.source_user_id
                 )`,
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

    // #2387: the author deletes one of their own messages. Inbound:
    // { type: 'delete', id } — and the REST route
    // DELETE /api/apps/:slug/messages/:id lands here too, so the socket and
    // the route cannot disagree about what deleting does. Not in
    // WRITE_MSG_TYPES on purpose: taking back your own words needs only the
    // view access the socket already has, so someone who has since lost
    // collaborator access can still remove what they wrote. Authorship is
    // the gate (services/app-chat.js deleteOwnMessage).
    //
    // A refusal is answered to the requesting socket alone, as
    // `{ type: 'delete_error', id, code }`, so the composer that already drew
    // the placeholder can put the message back (public/js/group-chat.js). It
    // names only that sender's own attempt, with the same code the REST twin
    // answers as 403/404; nothing is broadcast. The REST path has no socket
    // and reads the returned result instead.
    case 'delete': {
      const messageId = appChat.positiveInt(msg.id);
      if (!messageId) return { ok: false, code: 'not_found' };
      const result = await appChat.deleteOwnMessage(pool, {
        appId: client.appId, userId: client.user.id, messageId,
      });
      if (!result.ok) {
        log.warn('ws', 'delete rejected', {
          appId: client.appId, userId: client.user.id, messageId, code: result.code,
        });
        try {
          if (client.ws && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'delete_error', id: messageId, code: result.code }));
          }
        } catch { /* a closed socket has nobody to tell */ }
        return result;
      }
      if (result.alreadyDeleted) return result;
      const { message } = result;
      await broadcastFromSender(pool, client.appId, {
        type: 'chat_delete',
        id: message.id,
        thread_type: message.thread_type,
        thread_ref: message.thread_ref,
      }, client.user.id);
      // A reply went: its thread's count and faces change with it.
      if (message.thread_type === appChat.MESSAGE_THREAD && message.thread_ref) {
        await broadcastThreadSummary(pool, client.appId, message.thread_ref, client.user.id);
      }
      // Notification rows pointing at the message went in the same
      // transaction; the people who held them re-sync their bells.
      for (const userId of result.clearedUserIds) {
        pushNotificationToUser(userId, { type: 'notifications_changed' });
      }
      return result;
    }

    case 'typing': {
      // #194: pass the (shape-checked) thread along so typing indicators
      // don't bleed between general chat and threads. No DB lookup —
      // typing is ephemeral and the worst a bogus ref does is show a
      // typing line in a thread nobody has open.
      const t = msg.thread;
      const typingThread = (t && typeof t === 'object'
        && THREAD_TYPES.includes(t.type)
        && Number.isInteger(Number(t.ref)) && Number(t.ref) > 0)
        ? { type: t.type, ref: Number(t.ref) } : null;
      await broadcastFromSender(pool, client.appId, {
        type: 'typing',
        userId: client.user.id,
        username: client.user.username,
        ...(typingThread ? { thread: typingThread } : {}),
      }, client.user.id, client.ws);
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
async function getReactionsForMessages(pool, messageIds, viewerId = null) {
  if (!messageIds.length) return {};
  const { rows } = await pool.query(
    `SELECT mr.message_id, mr.emoji, COUNT(*)::int AS count,
            COALESCE(array_agg(u.username ORDER BY mr.created_at), '{}') AS users
     FROM message_reactions mr JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1::int[])
       AND ($2::int IS NULL OR NOT EXISTS (
         SELECT 1 FROM user_blocks blocked
          WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = mr.user_id
       ))
     GROUP BY mr.message_id, mr.emoji
     ORDER BY mr.message_id, MIN(mr.created_at)`,
    [messageIds, viewerId]
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
// #194: `thread` ({ type: 'issue'|'session'|'governance', ref }) scopes the
// system message into that thread (used by the per-vote activity rows,
// which post into the proposal's thread). Callers are trusted — no ref
// validation here.
//
// A CHANNEL IS WHAT PEOPLE SAID. With no thread there is nothing to write:
// the main stream is the app's channel (the hub's Channel card, the Messages
// room), and Homeroom's activity — a proposal put up for a vote, a merge, a
// check verdict, a setting changed, main going red — is no longer a line in
// it, nor in #general. The story of one proposal, request or decision is
// told in its own thread, which every caller names. The app-wide notices
// that have no thread are shown where that state lives: main's suite and a
// stalled release as banners on the project page (dev-board/board-frame.tsx),
// and the Friday card and settings changed lately in the Workshop's notices
// panel (services/app-notices.js, read from `events`). A call with no thread
// is refused here rather than trusted to the callers.
// db/migrate.js clearAutomatedChannelLines removes the lines written before.
async function sendSystemMessage(pool, appId, content, msgType = 'system', metadata = null, thread = null) {
  if (!thread) return null;
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
    [appId, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref]
  );

  broadcast(appId, {
    type: 'chat',
    id: rows[0].id,
    userId: null,
    username: null,
    content,
    msgType,
    ...(metadata ? { metadata } : {}),
    thread,
    createdAt: rows[0].created_at,
  });
  // #1688: the row, for a caller that hangs something off the message — the
  // "needs a conversation" prompt names people, and their mention rows point
  // at it. Every existing caller ignores the return.
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

/**
 * #3288: a thread post from a synthetic account (the Homeroom bot), written
 * and broadcast as an ORDINARY message from that user, so the chat draws it
 * as a bubble with a name and not as a centred system line.
 *
 * Deliberately NOT handleMessage. That is the path for a person at a
 * keyboard, and three of its effects are wrong for text a model wrote:
 *   - it turns every `@name` in the body into a notification, so a reply
 *     that quoted a handle would notify whoever owns it (the caller writes
 *     the one mention it means, for the person it answers);
 *   - it wakes the Homeroom bot on issue and proposal threads, and this is
 *     the bot talking;
 *   - its collaborator and join gates are for people; the bot is on an app
 *     because the app is in its live list.
 * What it keeps is the row and the frame: `msg_type = 'message'`, the
 * author's user_id, and the same `chat` payload handleMessage broadcasts,
 * through broadcastFromSender so a viewer who blocked the account does not
 * receive it. Thread posts only, like sendSystemMessage.
 *
 * `msgType` may also be 'spec_share': the bot's spec, drawn as the same spec
 * card a person's "Share to group" posts (metadata.specShare), with the
 * card's summary line as its content. Nothing else.
 *
 * services/request-specs.js posts a PERSON's spec card on a request through
 * this too, as that person: the same thread card, and it should not wake the
 * bot either. Its route has already applied the membership and collaborator
 * gates this function skips.
 */
const BOT_MESSAGE_TYPES = new Set(['message', 'spec_share']);
async function sendBotMessage(pool, appId, { user, content, metadata = null, thread = null, msgType = 'message' } = {}) {
  if (!thread || !user || !Number.isInteger(Number(user.id))) return null;
  const text = String(content || '').trim().slice(0, MAX_CHAT_LEN);
  if (!text) return null;
  const kind = BOT_MESSAGE_TYPES.has(msgType) ? msgType : 'message';
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $7, $4, $5, $6)
     RETURNING id, created_at`,
    [appId, Number(user.id), text, JSON.stringify(metadata || {}), thread.type, thread.ref, kind]
  );
  // A reply in a reply thread names its root, as a person's does, so the
  // stream the root is in can draw it (the bot's voice answers there).
  let threadRoot = null;
  if (thread.type === appChat.MESSAGE_THREAD) {
    const root = await appChat.findThreadRoot(pool, appId, thread.ref).catch(() => null);
    if (root) {
      threadRoot = {
        id: Number(root.id), username: root.username || null,
        content: root.deleted_at ? '' : appChat.snippet(root.content), deleted: !!root.deleted_at,
        thread_type: root.thread_type || null,
        thread_ref: root.thread_ref == null ? null : Number(root.thread_ref),
      };
    }
  }
  await broadcastFromSender(pool, appId, {
    type: 'chat',
    id: rows[0].id,
    userId: Number(user.id),
    username: user.username,
    content: text,
    msgType: kind,
    ...(metadata ? { metadata } : {}),
    thread,
    ...(threadRoot ? { threadRoot } : {}),
    createdAt: rows[0].created_at,
    postedVia: null,
  }, Number(user.id));
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

/**
 * #4238: the ONE line Homeroom writes into a project's channel. When a new
 * project's first version goes live, Homeroom bot says so there, once, as
 * its own message (a bubble with its name, not a system line), with an Open
 * button (metadata.actions). Everything else Homeroom says still goes to a
 * thread (sendSystemMessage, sendBotMessage): a channel is what people said,
 * and this is the bot telling the people there that what they asked for is
 * made. Once per project: a second call finds the first and writes nothing.
 * Not wired to handleMessage, for the reasons sendBotMessage gives.
 */
const FIRST_VERSION_KIND = 'first_version';
async function sendFirstVersionMessage(pool, appId, { user, content, metadata = null } = {}) {
  if (!user || !Number.isInteger(Number(user.id)) || !Number.isInteger(Number(appId))) return null;
  const text = String(content || '').trim().slice(0, MAX_CHAT_LEN);
  if (!text) return null;
  const meta = { ...(metadata || {}), kind: FIRST_VERSION_KIND };
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata)
     SELECT $1, $2, $3, 'message', $4::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages
         WHERE app_id = $1 AND user_id = $2 AND thread_type IS NULL
           AND metadata->>'kind' = '${FIRST_VERSION_KIND}')
     RETURNING id, created_at`,
    [Number(appId), Number(user.id), text, JSON.stringify(meta)]
  );
  if (!rows.length) return null;
  await broadcastFromSender(pool, Number(appId), {
    type: 'chat',
    id: rows[0].id,
    userId: Number(user.id),
    username: user.username,
    content: text,
    msgType: 'message',
    metadata: meta,
    createdAt: rows[0].created_at,
    postedVia: null,
  }, Number(user.id));
  return { id: rows[0].id, createdAt: rows[0].created_at };
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
// The visibility lookup runs on EVERY instance rather than being resolved once
// and shipped: membership decides who may see this, each pod holds its own
// sockets and its own 10s cache, and a fail-closed rule has to be able to fail
// closed locally. So the bus carries the routing, not the answer.
function deliverGlobalScoped(payload, { appId = null, appSlug = null } = {}) {
  if (!_pool || (appId == null && !appSlug)) {
    deliverGlobal(payload);
    return;
  }
  appAccess.getWsVisibility(_pool, { appId, appSlug })
    .then((info) => {
      if (!info || info.suspended) return; // no ordinary activity from a suspended app
      if (!info.viewPrivate && !info.blockedUserIds?.size) {
        deliverGlobal(payload);
        return;
      }
      const json = JSON.stringify(payload);
      for (const client of globalClients) {
        if (client.ws.readyState !== 1) continue;
        if (!info.blockedUserIds?.has(client.user.id)
            && (!info.viewPrivate || client.user.isAdmin || info.memberIds.has(client.user.id))) {
          sendToEventsClient(client, json);
        }
      }
    })
    .catch((err) => {
      log.warn('ws', 'scoped broadcast dropped', { type: payload.type, err: err.message });
    });
}

function broadcastGlobalScoped(payload, opts = {}) {
  deliverGlobalScoped(payload, opts);
  wsBus.publish('scoped', { appId: opts.appId ?? null, appSlug: opts.appSlug ?? null }, payload);
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

// Push one creation-phase update for an app that is still 'creating'.
//
// Rides the SAME `app_status` message the terminal transitions above
// use — clients already receive and dispatch it — with `phase` as the
// only new field. Scoped identically to pushAppStatusUpdate, which is
// the whole reason this does not live in app-deploy-status.js: that
// module broadcasts unscoped, and a brand-new app may be view-private.
//
// `status` is pinned to 'creating' rather than read off the row: the
// caller is inside createApp, where that is the only status the row can
// have, and a stale read here would race the terminal update.
function pushAppCreationPhase(app) {
  broadcastGlobalScoped({
    type: 'app_status',
    appId: app.id,
    slug: app.slug,
    status: 'creating',
    url: null,
    errorReason: null,
    phase: app.phase,
  }, { appId: app.id, appSlug: app.slug });
}

// Board-change listeners (services/workshop-themes.js registers one from
// server.js). A card arriving on, or leaving, an app's board is what the
// Workshop's placement stage waits for, and every such change already
// passes through pushSessionUpdate or pushIssueUpdate — so the hook lives
// here rather than at the thirty call sites. Listeners are told only which
// app; they read the board themselves. A listener that throws is logged
// and never breaks the broadcast.
const boardChangeListeners = [];
function onBoardChange(fn) {
  if (typeof fn === 'function') boardChangeListeners.push(fn);
}
function noteBoardChange(data) {
  if (!data || (data.appId == null && !data.appSlug)) return;
  for (const fn of boardChangeListeners) {
    try {
      fn({ appId: data.appId ?? null, appSlug: data.appSlug ?? null });
    } catch (err) {
      log.warn('ws', 'board change listener failed', { message: err.message });
    }
  }
}

function pushSessionUpdate(data) {
  broadcastGlobalScoped({ type: 'session_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
  noteBoardChange(data);
}

// Read only where the recipient has an events socket (what deliverToUser
// writes to); the notification's access predicates run now, at relay time.
function relayNotification(userId, notificationId) {
  if (userId == null || !_pool) return;
  let here = false;
  for (const client of globalClients) if (Number(client.user.id) === Number(userId)) { here = true; break; }
  if (!here) return;
  require('./notifications').hydrateNotification(_pool, notificationId)
    .then((shown) => { if (shown) deliverToUser(shown.userId, { type: 'notification_new', notification: shown.notification }); })
    .catch((err) => log.warn('ws', 'could not read a notification to relay', { notificationId, err: err.message }));
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
  // An edit or an unclaim names the GitHub issue; a create names the local
  // row, so routes/issues.js wakes the bot itself once the twin exists.
  if (data && data.issueNumber != null && data.appId != null
      && (data.action === 'updated' || data.action === 'unclaimed')) {
    noteIssueActivityForBot(data.appId, data.issueNumber, data.action);
  }
  noteBoardChange(data);
}

// The Workshop's grouping for an app moved — cards were placed into
// themes, or the themes were re-drafted (`stage`) — so every open Workshop
// re-fetches GET /api/apps/:slug/workshop-themes. Same scoping as the
// board's other fan-outs: the grouping is built from shared-visibility
// data, so a member of a view-private app may hear about it and nobody
// else.
function pushWorkshopUpdate(data) {
  broadcastGlobalScoped({ type: 'workshop_update', ...data },
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
function deliverToAdmins(payload) {
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user && client.user.isAdmin && sendToEventsClient(client, json)) sent++;
  }
  return sent;
}

// The return value counts THIS instance's admins, which is what every caller
// uses it for (a debug tally). It is not a cluster-wide count and does not
// claim to be.
function broadcastToAdmins(payload) {
  const sent = deliverToAdmins(payload);
  wsBus.publish('admins', null, payload);
  return sent;
}

// Send a payload to every /ws/events socket belonging to `userId`. Used for
// @mention delivery — a single user may have multiple tabs open — and, since
// #1038, for the owner-only fan-out of a private session's working state.
// `pushNotificationToUser` is kept as an alias so the notification call sites
// above (and any external caller) read naturally and don't have to churn.
function deliverToUser(userId, payload) {
  if (payload.type === 'app_blocks_changed') {
    appAccess.invalidateVisibilityHere(payload.appId, payload.slug);
    if (payload.blocked) {
      for (const client of rooms.get(payload.appId) || []) {
        if (client.user.id === userId) client.ws.close(4004, 'App blocked');
      }
    }
  }
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user.id === userId && sendToEventsClient(client, json)) sent++;
  }
  return sent;
}

// One person's tabs are not guaranteed to land on one instance, so an
// @mention delivered only locally reaches whichever half of their sessions
// happens to share a pod with the emitter.
function pushToUser(userId, payload) {
  const sent = deliverToUser(userId, payload);
  wsBus.publish('user', { userId }, payload);
  // #2904: every read path announces itself with this event, so it is also
  // where the iOS icon badge learns the count moved. Only the emitting
  // instance gets here (bus peers call deliverToUser), so one change is one
  // debounced sync. Lazy and guarded: the badge is best-effort and must never
  // break the socket fan-out.
  if (payload && payload.type === 'notifications_changed') {
    try { require('./mobile-push').scheduleBadgeSync(userId); } catch {}
  }
  return sent;
}

// Platform conversations have no app room. Their service resolves a fresh
// active-member audience inside the same mutation and hands that snapshot to
// this helper, which fans out only through each member's authenticated global
// event sockets. Keeping this separate from broadcast()/broadcastGlobal()
// makes an accidental private-message app/global broadcast review-visible.
const CONVERSATION_EVENT_TYPES = new Set([
  'conversation_message_created',
  'conversation_message_updated',
  'conversation_reaction_updated',
  'conversation_read',
  'conversation_membership_changed',
  'conversation_typing',
]);

function pushConversationEvent(memberUserIds, payload, { excludeUserId = null } = {}) {
  if (!Array.isArray(memberUserIds) || !payload || typeof payload !== 'object'
      || Array.isArray(payload) || !CONVERSATION_EVENT_TYPES.has(payload.type)) {
    return 0;
  }
  const conversationId = Number(payload.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0
      || conversationId > 2147483647) {
    return 0;
  }
  const excluded = Number(excludeUserId);
  let sent = 0;
  const seen = new Set();
  for (const value of memberUserIds) {
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647
        || userId === excluded || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    sent += pushToUser(userId, payload);
  }
  return sent;
}

const pushNotificationToUser = pushToUser;

module.exports = { noteBoardChange, broadcastThreadSummary, connectedUserIds, disconnectUser, closeAllForRelease, attach, broadcast, _onBusMessage, _onBusListening, broadcastGlobal, broadcastSessionEvent, sessionEventAudience, canWatchSessionRow, SESSION_FANOUT_EVENTS, MAX_WATCHED_SESSIONS_PER_SOCKET, SLOW_CLIENT_MAX_BUFFERED, SLOW_CLIENT_RESUME_BUFFERED, _checkLaggingClients: checkLaggingClients, _sessionMetaCache: sessionMetaCache, broadcastGlobalScoped, broadcastToAdmins, sendSystemMessage, sendBotMessage, sendFirstVersionMessage, getOnlineUsers, pushAppStatusUpdate, pushAppCreationPhase, pushSessionUpdate, pushSessionState, sessionStateAudience, pushVoteUpdate, pushKudosUpdate, pushAppUpdate, pushIssueUpdate, pushBoardOrderUpdate, pushWorkshopUpdate, onBoardChange, pushToUser, pushConversationEvent, pushNotificationToUser, pushPlatformVersion, getReactionsForMessages, validateThread, TOPIC_CLOSED_MESSAGE, handleMessage, admitSocketFrame, SOCKET_RATE_BUDGETS, SOCKET_RATE_WINDOW_MS, MAX_CHAT_LEN };
