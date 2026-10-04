const express = require('express');
const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const models = require('../services/models');
const modelCosts = require('../services/model-costs');
const { listActiveUserIds } = require('../services/active-users');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const attachmentsSvc = require('../services/attachments');
const messageBookmarks = require('../services/message-bookmarks');
const appChat = require('../services/app-chat');
const conversationsSvc = require('../services/conversations');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const {
  appChatReadLimiter,
  attachmentUploadLimiter,
  groupChatWriteLimiter,
  messageBookmarkLimiter,
  userDirectoryLimiter,
} = require('../middleware/rate-limits');

// #194's topic threads, plus #2387's reply threads ('message', ref = the
// root chat_messages.id). services/ws.js validateThread is the write-side
// twin of this set and checks each ref against the database.
const THREAD_TYPES = new Set(['issue', 'session', 'governance', appChat.MESSAGE_THREAD]);
const MAX_THREAD_REF = 2147483647; // PostgreSQL INTEGER
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// #2236: how a message reached the thread, as the row will carry it.
//
// 'agent' means a coding agent posted it on the signed-in person's behalf
// through the Homeroom MCP connector: that path authenticates with a
// connector bearer (routes/cli-auth.js connectorApiBearerChain), which is
// the one place `req.connectorClientId` is ever set. The marker is derived
// from that credential and from nothing the client sends — a body field
// could be forged in either direction, and the whole point of the chip is
// that a reader can trust it. A plain CLI access token (`req.cliAuthenticated`
// without a connector client) is a person driving a tool by hand, and a
// browser session is a person typing; both stay NULL, as does every row
// written before the column existed.
function postedViaFor(req) {
  return req && req.connectorClientId ? 'agent' : null;
}

// Content-Disposition's legacy filename parameter is a header, so it may
// contain ASCII only (macOS screenshot names carry a narrow no-break space
// before AM/PM). The shared helper keeps a readable ASCII fallback and
// carries the exact UTF-8 name in the RFC 5987 parameter; see
// services/attachments.js.
const { attachmentDisposition } = attachmentsSvc;

// #1808: staging demo rows for a chat transcript, injected at request time
// (?demo=1) only when the real read came back EMPTY, so a genuine transcript
// always wins — except on the mock topics in PINNED_DEMO_THREADS below, whose
// transcript is fixture content the declared checks read. Never persisted,
// and a strict no-op outside staging.
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
//
// #2387 adds two things to the GENERAL stream only (a topic's mock is
// unchanged): a deleted message's placeholder, first and oldest (id
// 9902000, before the 2024 opener, so id order and time order agree), and a
// reply thread under this morning's row (DEMO_THREAD_ROOT_ID) whose three
// replies `thread_type=message&thread_ref=9902003&demo=1` serves — see
// stagingMockReplyThread below. Every row now carries the `deleted` and
// `thread` fields a real row does.
const DEMO_THREAD_ROOT_ID = 9902003;
// Mock repliers get ids from the mock range, not 0, so a thread summary's
// participants are distinct by id as real ones are (a client keys faces by
// id). Obviously fake: no staging account reaches 9.9 million.
const DEMO_REPLIERS = Object.freeze({
  'staging-tester': 9902101,
  'staging-demo-user': 9902102,
});

function stagingMockReplies(appId) {
  const now = Date.now();
  const reply = (id, minutesBack, username, content) => ({
    id, user_id: DEMO_REPLIERS[username], username, content,
    msg_type: 'message', metadata: {},
    thread_type: appChat.MESSAGE_THREAD, thread_ref: DEMO_THREAD_ROOT_ID,
    created_at: new Date(now - minutesBack * 60 * 1000).toISOString(),
    edited_at: null, reactions: [], bookmarked: false,
    has_unread_notification: false, app_id: appId, posted_via: null,
    deleted: false, thread: null,
  });
  return [
    reply(9902021, 60, 'staging-tester',
      '[Mock] A reply in the thread: the morning build looks right to me.'),
    reply(9902022, 45, 'staging-demo-user',
      '[Mock] Thanks. I will fold that into the next change.'),
    reply(9902023, 20, 'staging-tester',
      '[Mock] Replies stay in here; the main chat only shows how many there are.'),
  ];
}

function stagingMockThreadSummary(appId) {
  const replies = stagingMockReplies(appId);
  const seen = new Set();
  const participants = [];
  for (const r of [...replies].reverse()) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    participants.push({ id: r.user_id, username: r.username });
  }
  const last = replies[replies.length - 1];
  return {
    reply_count: replies.length,
    last_reply_at: last.created_at,
    participants: participants.slice(0, appChat.MAX_PARTICIPANTS),
    last_reply: {
      id: last.id, user_id: last.user_id, username: last.username,
      content: appChat.snippet(last.content), created_at: last.created_at,
    },
  };
}

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
    has_unread_notification: false, app_id: appId, posted_via: null,
    deleted: false, thread: null,
  });
  const general = !thread;
  return [
    // #2387: what a deleted message leaves behind — its author, its time,
    // no text. General stream only.
    ...(general ? [{
      ...row(-1, 0, 'staging-tester', '', '2024-02-19T16:00:00Z'),
      deleted: true,
    }] : []),
    row(0, 0, 'staging-demo-user',
      '[Mock] Opening line, posted in an earlier year. Its stamp carries the year.',
      '2024-02-19T16:05:00Z'),
    row(1, 0, 'staging-tester',
      '[Mock] A reply from earlier this year: the day, then the time.',
      iso(now - 40 * 24 * 60 * 60 * 1000)),
    {
      ...row(2, 95, 'staging-demo-user',
        '[Mock] And one from this morning, which needs no date at all.'),
      // #2387: the general stream's reply thread hangs off this row.
      thread: general ? stagingMockThreadSummary(appId) : null,
    },
    row(3, 4, 'staging-tester',
      '[Mock] Same again a few minutes ago, so a run of today\'s rows stays easy to scan.'),
    ...[4, 5, 6].map((offset) => ({
      ...row(offset, 7 - offset, null,
        '[Mock] PR #9000001 is now synced with main and conflict-free. It needs 1/2 yes votes needed to merge.'),
      user_id: null, msg_type: 'conflict',
    })),
    // #2236: a note a coding agent posted through the connector on the
    // demo user's behalf. The newest human row, so the Activity feed's
    // two-line preview shows it as well as the topic's Discussion sheet.
    // Obviously fake (a username no real account can hold, in the mock
    // stream only) and never persisted; the declared check for the chip
    // reads it on the demo issue's discussion.
    {
      ...row(7, 2, 'staging-demo-agent',
        '[Mock] Posted by a coding agent on the demo user\'s behalf: I have reproduced the report and am drafting a fix.'),
      posted_via: 'agent',
    },
  ];
}

// #2387 follow-up: the general stream draws a reply thread's replies too, as
// a line each where they landed. The mock's three came after this morning's
// root and before the rows of the last few minutes, so they go straight after
// it — one run of consecutive replies, which the transcript merges into one
// card. Their ids sit above the rest of the mock's; order is the array's.
function stagingMockGeneralStream(appId) {
  const rows = stagingMockGroupChat(appId, null);
  const at = rows.findIndex((m) => m.id === DEMO_THREAD_ROOT_ID);
  const root = rows[at];
  const threadRoot = {
    id: DEMO_THREAD_ROOT_ID, username: root.username, content: appChat.snippet(root.content), deleted: false,
  };
  const replies = stagingMockReplies(appId).map((m) => ({ ...m, thread_root: threadRoot }));
  return [...rows.slice(0, at + 1), ...replies, ...rows.slice(at + 1)];
}

// The demo topics whose mock transcript IS the fixture: the declared checks
// read these rows (#1926's folded conflict notices, #2236's via-agent chip on
// issue 900008's Discussion), so they must not depend on nobody having typed
// there. The empty-transcript rule above assumed a check sees an untouched
// database, but a preview is a live, shared stack: a reviewer trying the
// composer on the demo issue, or a shots run doing the same, leaves one
// real row, and from then on every load of that preview answered with that row
// alone and the chip check failed on proposals that never touched it. A thread
// listed here keeps its mock rows on every first page in demo mode and shows
// whatever was posted there AFTER them, so a preview still echoes what a
// tester sends. Only mock topics belong here: none exists outside a preview,
// so no genuine transcript is ever padded with fixture rows.
const PINNED_DEMO_THREADS = new Set(['issue:900008']);

function isPinnedDemoThread(thread) {
  return !!thread && PINNED_DEMO_THREADS.has(`${thread.type}:${thread.ref}`);
}

// What a staging `?demo=1` first page answers with, or null to serve the real
// rows unchanged. `realRows` is the page the SELECT returned, oldest first.
function stagingDemoTranscript(appId, thread, realRows) {
  // A real message's reply thread is never padded: the one mock reply
  // thread is answered by stagingMockReplyThread before the database is
  // read, and fixture replies under somebody's real message would be a lie.
  if (thread && thread.type === appChat.MESSAGE_THREAD) return null;
  if (isPinnedDemoThread(thread)) {
    const mock = stagingMockGroupChat(appId, thread);
    const mockIds = new Set(mock.map((m) => m.id));
    // A real id equal to a mock one would collapse into it on the client
    // (history is merged by id); keep the fixture row, which the checks read.
    return [...mock, ...realRows.filter((m) => !mockIds.has(m.id))];
  }
  if (realRows.length) return null;
  return thread ? stagingMockGroupChat(appId, thread) : stagingMockGeneralStream(appId);
}

// #2387: the mock reply thread, as `thread_type=message&thread_ref=<root>`
// answers it on a staging `?demo=1` read — or null for any other root.
function stagingMockReplyThread(appId, rootId) {
  if (Number(rootId) !== DEMO_THREAD_ROOT_ID) return null;
  const root = stagingMockGroupChat(appId, null).find((m) => m.id === DEMO_THREAD_ROOT_ID);
  return {
    messages: stagingMockReplies(appId),
    root,
    has_more_before: false,
    has_more_after: false,
  };
}

// #2387: a permalink or catch-up read of the mock general stream. `around`
// on a mock row (or a mock reply, which opens on its root) answers the whole
// mock transcript with its focus; `after` answers what follows. Null when
// the id is not a mock one, so the real read runs.
function stagingMockStreamPage(appId, { around = null, after = null } = {}) {
  const rows = stagingMockGeneralStream(appId);
  const ids = new Set(rows.filter((m) => !m.thread_type).map((m) => m.id));
  if (around != null) {
    if (ids.has(around)) {
      return {
        messages: rows, has_more_before: false, has_more_after: false,
        focus: { message_id: around, thread_ref: null },
      };
    }
    if (stagingMockReplies(appId).some((m) => m.id === around)) {
      return {
        messages: rows, has_more_before: false, has_more_after: false,
        focus: { message_id: around, thread_ref: DEMO_THREAD_ROOT_ID },
      };
    }
    return null;
  }
  if (after != null && ids.has(after)) {
    return {
      messages: rows.filter((m) => m.id > after),
      has_more_before: true,
      has_more_after: false,
    };
  }
  return null;
}

// #2387: what the read cursor answers for a mock message id under
// `?demo=1`, where there is no row to move a real cursor to. A read leaves
// nothing unread; an unread leaves the mock rows from other people at and
// after the message — the same definition of "unread" as the real one.
function stagingMockUnreadCount(appId, messageId, move) {
  const rows = stagingMockGroupChat(appId, null);
  if (!rows.some((m) => m.id === messageId)) return null;
  if (move === 'read') return 0;
  return rows.filter((m) => m.id >= messageId && m.msg_type === 'message'
    && !m.deleted && m.user_id != null).length;
}

// #2387: the paging cursors. Absent (or empty) → null; present → a positive
// PostgreSQL INTEGER, or undefined for a malformed value the route refuses.
function cursorParam(value) {
  if (value == null || value === '') return null;
  const n = parseThreadRef(value);
  return n == null ? undefined : n;
}

function pageLimit(value) {
  const n = parseInt(value || '50', 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 100);
}

const PIVOT_OPS = new Set(['<', '<=', '>', '>=']);

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

  // #2570: what each model is good for, and what a change on it is
  // expected to cost. The picker reads this once per session open and
  // renders the note beside each option and under the selected one.
  //
  // `models` carries the platform's CURATED ids — the three Anthropic ones
  // and the OpenRouter models it recommends — because this process has no
  // user key to read an OpenRouter catalogue with. `typicalChange` is what
  // lets the client finish the job for every other model: it already holds
  // that user's catalogue, prices and all, and the estimate is per-token
  // pricing times this profile. One definition of "a typical change", two
  // places that can apply it.
  //
  // Every figure is an ESTIMATE and is labelled one wherever it is shown.
  router.get('/api/model-notes', async (_req, res) => {
    try {
      res.json(await modelCosts.pickerPayload(pool));
    } catch (err) {
      log.warn('chat', 'model notes read failed', { err: err.message });
      // A picker without notes is the pre-#2570 picker, which is a fine
      // thing to degrade to. It is never an error the user has to see.
      res.json({ typicalChange: modelCosts.TYPICAL_CHANGE, models: {} });
    }
  });

  // ── Reading a transcript (#194, #2387) ───────────────────────────
  //
  //   GET /api/apps/:slug/messages
  //     ?limit=1..100 (default 50)
  //     &thread_type=&thread_ref=   one thread; absent = the general stream
  //     &before=<id>                older page, ids < before
  //     &after=<id>                 newer page, ids > after (catch-up)
  //     &around=<id>                a permalink window centred on one message
  //   → { messages /* oldest first */, has_more_before, has_more_after,
  //       focus?: { message_id, thread_ref },   // around only
  //       root?: Message }                      // thread_type=message only
  //
  // At most one of before / after / around. `around` on a reply-thread
  // message while reading the general stream centres the window on the
  // thread's ROOT and says so in focus.thread_ref, so a permalink to a reply
  // opens the chat where the thread is and the thread on the reply.
  //
  // Every row carries `deleted` (a placeholder: no text, no attachments, no
  // quote) and `thread` (a general-stream row's reply summary, or null).
  router.get('/api/apps/:slug/messages', async (req, res) => {
    const limit = pageLimit(req.query.limit);

    // #194: optional thread scoping. Absent → the general chat: its own
    // messages (thread_type IS NULL), which keeps topic threads out of it,
    // plus — since the #2387 follow-up — the live replies of its reply
    // threads, which the transcript draws as a line each (selectStream). Both params must
    // be present and valid to select a thread; a malformed pair is a 400
    // rather than silently falling back to general chat.
    const threadType = req.query.thread_type || null;
    const threadRef = req.query.thread_ref != null ? parseThreadRef(req.query.thread_ref) : null;
    if (threadType || req.query.thread_ref != null) {
      if (!THREAD_TYPES.has(threadType) || threadRef == null) {
        return res.status(400).json({ error: 'Invalid thread_type/thread_ref' });
      }
    }
    const before = cursorParam(req.query.before);
    const after = cursorParam(req.query.after);
    const around = cursorParam(req.query.around);
    if (before === undefined || after === undefined || around === undefined
        || [before, after, around].filter((v) => v != null).length > 1) {
      return res.status(400).json({ error: 'Invalid before/after/around' });
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
      const viewerId = req.user.id;
      const thread = threadType ? { type: threadType, ref: threadRef } : null;
      const demo = IS_STAGING && req.query.demo === '1';

      // #2387 staging fixtures that no database row stands behind: the mock
      // reply thread, and a permalink or catch-up read on a mock id.
      if (demo && thread && thread.type === appChat.MESSAGE_THREAD) {
        const mock = stagingMockReplyThread(appId, thread.ref);
        if (mock) return res.json(mock);
      }
      if (demo && !thread && (around != null || after != null)) {
        const mock = stagingMockStreamPage(appId, { around, after });
        if (mock) return res.json(mock);
      }

      // A reply thread is readable exactly when its root is: a general-
      // stream message a person wrote in this app, by nobody this viewer
      // blocked.
      let rootRow = null;
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        rootRow = await appChat.findThreadRoot(pool, appId, thread.ref, viewerId);
        if (!rootRow) return res.status(404).json({ error: 'Message not found' });
      }

      const stream = { appId, thread, viewerId };
      let rows;
      let hasMoreBefore = false;
      let hasMoreAfter = false;
      let focus = null;
      if (around != null) {
        const target = await locateAround(appId, thread, around, viewerId);
        if (!target) return res.status(404).json({ error: 'Message not found' });
        // The anchor and up to half the page before it, the rest after;
        // one extra row each way answers "is there more".
        const olderCount = Math.floor((limit - 1) / 2) + 1;
        const newerCount = limit - olderCount;
        const older = await selectStream(pool, {
          ...stream, op: '<=', pivot: target.anchorId, order: 'DESC', limit: olderCount + 1,
        });
        const newer = await selectStream(pool, {
          ...stream, op: '>', pivot: target.anchorId, order: 'ASC', limit: newerCount + 1,
        });
        hasMoreBefore = older.length > olderCount;
        hasMoreAfter = newer.length > newerCount;
        rows = [...older.slice(0, olderCount).reverse(), ...newer.slice(0, newerCount)];
        focus = { message_id: target.messageId, thread_ref: target.threadRef };
      } else if (after != null) {
        const newer = await selectStream(pool, {
          ...stream, op: '>', pivot: after, order: 'ASC', limit: limit + 1,
        });
        hasMoreAfter = newer.length > limit;
        rows = newer.slice(0, limit);
        hasMoreBefore = (await selectStream(pool, {
          ...stream, op: '<=', pivot: after, order: 'DESC', limit: 1,
        })).length > 0;
      } else {
        const older = await selectStream(pool, before != null
          ? { ...stream, op: '<', pivot: before, order: 'DESC', limit: limit + 1 }
          : { ...stream, order: 'DESC', limit: limit + 1 });
        hasMoreBefore = older.length > limit;
        rows = older.slice(0, limit).reverse();
        if (before != null) {
          hasMoreAfter = (await selectStream(pool, {
            ...stream, op: '>=', pivot: before, order: 'ASC', limit: 1,
          })).length > 0;
        }
      }

      const messages = await hydrateRows(rows, { appId, viewerId, general: !thread });
      const root = rootRow
        ? (await hydrateRows([rootRow], { appId, viewerId, general: true }))[0]
        : null;

      // The empty-transcript fallback described at stagingMockGroupChat, and
      // the pinned demo topics described at PINNED_DEMO_THREADS. Only a first
      // page: a `before` cursor is the client paging PAST what it already
      // has, and answering that with the same rows again would loop the
      // transcript.
      if (demo && before == null && after == null && around == null) {
        const mock = stagingDemoTranscript(appId, thread, messages);
        if (mock) {
          return res.json({ messages: mock, has_more_before: false, has_more_after: false });
        }
      }

      const body = { messages, has_more_before: hasMoreBefore, has_more_after: hasMoreAfter };
      if (focus) body.focus = focus;
      if (root) body.root = root;
      res.json(body);
    } catch (err) {
      log.error('chat', 'Failed to load messages', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // One page of one stream, newest-first or oldest-first around a pivot id.
  // `op` and `order` come from the fixed sets below, never from a request.
  async function selectStream(db, { appId, thread, viewerId, op = null, pivot = null, order, limit }) {
    if (op && !PIVOT_OPS.has(op)) throw new Error(`bad pivot op: ${op}`);
    const direction = order === 'ASC' ? 'ASC' : 'DESC';
    const params = [appId];
    let where = 'm.app_id = $1';
    if (thread) {
      params.push(thread.type, thread.ref);
      where += ' AND m.thread_type = $2 AND m.thread_ref = $3';
    }
    if (op) {
      params.push(pivot);
      where += ` AND m.id ${op} $${params.length}`;
    }
    params.push(viewerId);
    const viewerIndex = params.length;
    // The general stream (#2387 follow-up): its own messages, and the live
    // replies of its reply threads, which the transcript draws as a line each
    // where they landed. A deleted reply leaves no line; neither does a reply
    // under a root by somebody the viewer blocked.
    if (!thread) {
      where += ` AND (m.thread_type IS NULL OR (
        m.thread_type = 'message' AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM chat_messages hidden_root
            JOIN user_blocks hb ON hb.blocked_user_id = hidden_root.user_id
           WHERE hidden_root.id = m.thread_ref AND hb.blocker_id = $${viewerIndex}
        )))`;
    }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata,
              m.thread_type, m.thread_ref, m.created_at, m.edited_at, m.posted_via,
              m.deleted_at, m.moderation_hidden_at
         FROM chat_messages m
         LEFT JOIN users u ON m.user_id = u.id
        WHERE ${where}
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks blocked
             WHERE blocked.blocker_id = $${viewerIndex}
               AND blocked.blocked_user_id = m.user_id
          )
        ORDER BY m.id ${direction}
        LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  // Where an `around` window centres. The message must be visible (in this
  // app, by nobody the viewer blocked) and in the stream being read — or,
  // when reading the general stream, a reply whose visible root is in it,
  // in which case the window centres on the root.
  async function locateAround(appId, thread, messageId, viewerId) {
    const { rows } = await pool.query(
      `SELECT target.id, target.thread_type, target.thread_ref
         FROM chat_messages target
        WHERE target.id = $1 AND target.app_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks blocked
             WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = target.user_id
          )`,
      [messageId, appId, viewerId]
    );
    const target = rows[0];
    if (!target) return null;
    const replyRoot = target.thread_type === appChat.MESSAGE_THREAD ? Number(target.thread_ref) : null;
    const inStream = thread
      ? target.thread_type === thread.type && Number(target.thread_ref) === thread.ref
      : target.thread_type == null;
    if (inStream) return { anchorId: target.id, messageId: target.id, threadRef: replyRoot };
    if (!thread && replyRoot) {
      const root = await appChat.findThreadRoot(pool, appId, replyRoot, viewerId);
      if (!root) return null;
      return { anchorId: root.id, messageId: target.id, threadRef: root.id };
    }
    return null;
  }

  // Everything a transcript row carries beyond its columns. The quote check
  // is part of the read (a blocked author's words must not leak through a
  // reply); the rest is decoration, and a failure in any of it renders the
  // row without that decoration rather than failing the read.
  async function hydrateRows(rows, { appId, viewerId, general }) {
    const messages = rows.map(appChat.shapeRow);
    const live = messages.filter((m) => !m.deleted);
    const liveIds = live.map((m) => m.id);

    // A reply can quote a blocked author's text even when its own sender
    // remains visible: hide that quote for this viewer. #2387: a quote of a
    // message deleted since keeps who said it and loses what.
    const quotedIds = live.map((m) => Number(m.metadata?.quote?.refMsgId))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (quotedIds.length) {
      const { rows: quoted } = await pool.query(
        `SELECT quoted.id, (quoted.deleted_at IS NOT NULL) AS deleted,
                (quoted.moderation_hidden_at IS NOT NULL OR EXISTS (
                  SELECT 1 FROM user_blocks blocked
                   WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = quoted.user_id
                )) AS hidden
           FROM chat_messages quoted
          WHERE quoted.id = ANY($2::int[])`,
        [viewerId, quotedIds]
      );
      const byId = new Map(quoted.map((row) => [Number(row.id), row]));
      for (const m of live) {
        const q = byId.get(Number(m.metadata?.quote?.refMsgId));
        if (!q) continue;
        if (q.hidden) {
          m.metadata = { ...m.metadata, quote: null };
        } else if (q.deleted) {
          m.metadata = { ...m.metadata, quote: { ...m.metadata.quote, snippet: '', deleted: true } };
        }
      }
    }

    // A deleted row lost its reactions, bookmarks and notifications with
    // its text, so it answers the decorations without asking.
    for (const m of messages) {
      if (!m.deleted) continue;
      m.reactions = [];
      m.bookmarked = false;
      m.has_unread_notification = false;
    }

    // #25: attach emoji reactions so the chat renders them on load (live
    // updates arrive separately over the per-app WS 'reaction' event).
    try {
      const { getReactionsForMessages } = require('../services/ws');
      const byId = await getReactionsForMessages(pool, liveIds, viewerId);
      for (const m of live) m.reactions = byId[m.id] || [];
    } catch (err) {
      log.warn('chat', 'reaction hydrate failed', { message: err.message });
    }

    // #1280: per-message saved flag, so a loaded page renders its
    // bookmark buttons already filled in. Same non-fatal contract as the
    // reaction and unread-dot hydrates around it — a failure here must
    // never break loading the chat, it just renders every button empty.
    try {
      const savedIds = await messageBookmarks.savedMessageIdsFor(pool, viewerId, liveIds);
      for (const m of live) m.bookmarked = savedIds.has(m.id);
    } catch (err) {
      log.warn('chat', 'bookmark hydrate failed', { message: err.message });
    }

    // Per-message unread dot: flag any message this user has an unread
    // mention/reply/reaction/thread-reply notification for, so the chat
    // renders a dot next to it. Live messages (over the WS) can't yet carry
    // this flag, so the dot is driven by this loaded-history flag plus
    // client-side reconciliation on notifications_changed. Non-fatal: a
    // failure here must never break loading the chat.
    try {
      const notifications = require('../services/notifications');
      const unreadIds = await notifications.unreadMessageIdsForUser(pool, viewerId, liveIds);
      for (const m of live) m.has_unread_notification = unreadIds.has(m.id);
    } catch (err) {
      log.warn('chat', 'unread-dot hydrate failed', { message: err.message });
    }

    // #2387 follow-up: a reply drawn in the general stream names the message
    // its thread hangs off — the start of it, as the line reads it out.
    const rootIds = [...new Set(messages
      .filter((m) => m.thread_type === appChat.MESSAGE_THREAD).map((m) => Number(m.thread_ref)))];
    if (general && rootIds.length) {
      try {
        const { rows: roots } = await pool.query(
          `SELECT r.id, r.content, r.deleted_at, u.username
             FROM chat_messages r
             LEFT JOIN users u ON u.id = r.user_id
            WHERE r.id = ANY($1::int[]) AND r.app_id = $2`,
          [rootIds, appId]
        );
        const byId = new Map(roots.map((r) => [Number(r.id), {
          id: Number(r.id), username: r.username || null,
          content: r.deleted_at ? '' : appChat.snippet(r.content), deleted: !!r.deleted_at,
        }]));
        for (const m of messages) {
          if (m.thread_type === appChat.MESSAGE_THREAD) m.thread_root = byId.get(Number(m.thread_ref)) || null;
        }
      } catch (err) {
        log.warn('chat', 'thread root hydrate failed', { message: err.message });
      }
    }

    // #2387: a general-stream row with visible replies says how many, when
    // the last one came, and who is in it. A deleted root keeps its thread.
    for (const m of messages) m.thread = null;
    if (general && messages.length) {
      try {
        const summaries = await appChat.threadSummaries(
          pool, appId, messages.filter((m) => m.thread_type == null).map((m) => m.id), viewerId
        );
        for (const m of messages) m.thread = summaries.get(Number(m.id)) || null;
      } catch (err) {
        log.warn('chat', 'thread summary hydrate failed', { message: err.message });
      }
    }
    return messages;
  }

  // Bearer-compatible group-chat write path. The browser normally sends
  // these over /ws/chat/:slug, but CLI/MCP clients authenticate with an API
  // bearer rather than a browser session cookie. Route the JSON request
  // through the same handler so persistence, thread validation, broadcasts,
  // events, mentions, replies, and unread-state updates cannot drift.
  router.post('/api/apps/:slug/messages', groupChatWriteLimiter, communities.requireAppMembership(pool), async (req, res) => {
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
        // `postedVia` rides on the CLIENT, beside the identity it qualifies,
        // rather than in the message: it describes who is holding the pen,
        // and the body is the one thing a caller gets to write.
        { user: req.user, appId: app.id, appSlug: app.slug, postedVia: postedViaFor(req) },
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
        if (result?.code === 'channel_moved') {
          return res.status(409).json({ error: communities.CHANNEL_MOVED, code: 'channel_moved' });
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
          posted_via: message.postedVia || null,
        },
      });
    } catch (err) {
      log.error('chat', 'Failed to post message', {
        slug: req.params.slug, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #2387: deleting your own message ─────────────────────────────
  //
  //   DELETE /api/apps/:slug/messages/:id
  //   → 200 { ok: true, id, thread_type, thread_ref, deleted: true }
  //     404 { error: 'Message not found' } | 403 { error: 'not_author' }
  //
  // The REST twin of the socket's `{ type: 'delete', id }`: both run the one
  // canonical handler (ws.handleMessage → services/app-chat.js), which
  // clears the row, removes its attachments, reactions, bookmarks and
  // notifications, and broadcasts `chat_delete` (plus `thread_summary` for a
  // reply) to the app's room. Idempotent: deleting an already-deleted
  // message of yours answers 200 again. View-gated, not collab-gated, like
  // the socket: someone who has since lost collaborator access can still
  // take back what they wrote, and authorship is the real gate.
  router.delete('/api/apps/:slug/messages/:id', groupChatWriteLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const messageId = parseThreadRef(req.params.id);
    if (messageId == null) return res.status(404).json({ error: 'Message not found' });
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { handleMessage } = require('../services/ws');
      const result = await handleMessage(
        pool,
        { user: req.user, appId: app.id, appSlug: app.slug },
        { type: 'delete', id: messageId }
      );
      if (!result?.ok) {
        if (result?.code === 'not_author') return res.status(403).json({ error: 'not_author' });
        return res.status(404).json({ error: 'Message not found' });
      }
      return res.json({
        ok: true,
        id: result.message.id,
        thread_type: result.message.thread_type,
        thread_ref: result.message.thread_ref,
        deleted: true,
      });
    } catch (err) {
      log.error('chat', 'Failed to delete message', {
        slug: req.params.slug, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #2387: the read cursor ───────────────────────────────────────
  //
  //   POST /api/apps/:slug/messages/read    { message_id } → { unread_count }
  //   POST /api/apps/:slug/messages/unread  { message_id } → { unread_count }
  //
  // `read` moves this viewer's position in the app's general stream forward
  // to the message (never back); `unread` moves it back to just before the
  // message, so it and everything after it is unread again (never forward).
  // The message must be a general-stream message of this app: 404
  // otherwise. `unread_count` is the same number the Messages list shows
  // for the app (general stream, from other people, not deleted, not from
  // anybody the viewer blocked).
  //
  // Nothing advances the cursor on a READ of the transcript: opening a chat
  // through Global Chat or an agent's connector is not the person reading
  // it, and a "mark unread" would not survive the next reload if loading
  // the page marked it read again. The client says so explicitly; posting
  // in the general stream is the one implicit move (services/ws.js).
  async function moveReadCursor(req, res, move) {
    res.set('Cache-Control', 'private, no-store');
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      // Validated after the existence-hiding gate, as the write route is.
      const messageId = parseThreadRef(req.body && req.body.message_id);
      if (messageId == null) {
        return res.status(400).json({ error: 'A positive integer message_id is required' });
      }
      if (IS_STAGING && req.query.demo === '1') {
        const mock = stagingMockUnreadCount(app.id, messageId, move);
        if (mock != null) return res.json({ unread_count: mock });
      }
      const result = move === 'read'
        ? await appChat.markRead(pool, { appId: app.id, userId: req.user.id, messageId })
        : await appChat.markUnread(pool, { appId: app.id, userId: req.user.id, messageId });
      if (!result.ok) return res.status(404).json({ error: 'Message not found' });
      return res.json({ unread_count: result.unread_count });
    } catch (err) {
      log.error('chat', `Failed to mark ${move}`, { slug: req.params.slug, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  router.post('/api/apps/:slug/messages/read', appChatReadLimiter, sameOriginBrowserOnly,
    (req, res) => moveReadCursor(req, res, 'read'));
  router.post('/api/apps/:slug/messages/unread', appChatReadLimiter, sameOriginBrowserOnly,
    (req, res) => moveReadCursor(req, res, 'unread'));

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
      `SELECT id, deleted_at FROM chat_messages WHERE id = $1 AND app_id = $2`,
      [messageId, app.id]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Message not found' });
      return null;
    }
    // #2387: a deleted message has nothing left to save. Unsaving stays
    // allowed (and is a no-op: the delete removed every bookmark of it).
    if (rows[0].deleted_at && req.method === 'PUT') {
      res.status(409).json({ error: 'message_deleted' });
      return null;
    }
    return messageId;
  }

  router.put('/api/apps/:slug/messages/:id/bookmark', messageBookmarkLimiter, sameOriginBrowserOnly, async (req, res) => {
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

  router.delete('/api/apps/:slug/messages/:id/bookmark', messageBookmarkLimiter, sameOriginBrowserOnly, async (req, res) => {
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

  // ── B9: asking Homeroom bot from the chat ───────────────────────────
  //
  // A message that mentions Homeroom bot is handed to it by the room itself
  // (services/ws.js, homeroom-bot-chat.js). These two are the rest:
  //
  //   GET  /api/apps/:slug/my-bot-requests
  //     → { bot, builds, cards }: the cards under the viewer's OWN messages
  //       that asked the bot for something, for the chat to draw again after
  //       a reload. Read from chat_bot_requests by requester, never from
  //       chat_messages, so nobody else's card can come back.
  //   POST /api/apps/:slug/messages/:id/request  { dismiss? }
  //     → "Make this a request" on a message of the viewer's own (or File it
  //       under the card that asked first): the same as a mention, without
  //       the read. `dismiss` is Not now. Members only, from the person's own
  //       browser, and capped per person by the service.
  router.get('/api/apps/:slug/my-bot-requests', appChatReadLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const out = await require('../services/homeroom-bot-chat').myRequests(pool, { app, user: req.user });
      return res.json(out);
    } catch (err) {
      log.error('chat', 'Failed to read the viewer\'s chat requests', { slug: req.params.slug, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/messages/:id/request', groupChatWriteLimiter, sameOriginBrowserOnly,
    communities.requireAppMembership(pool), async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      try {
        const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS);
        if (!app) return res.status(404).json({ error: 'App not found' });
        const botChat = require('../services/homeroom-bot-chat');
        const [project, person] = await Promise.all([botChat.appRow(pool, app.id), botChat.personRow(pool, req.user.id)]);
        if (!project || !person) return res.status(404).json({ error: 'App not found' });
        const out = await botChat.requestFromMessage(pool, config, {
          app: project, user: person, messageId: req.params.id, dismiss: req.body?.dismiss === true,
        });
        if (!out.ok) return res.status(out.status || 400).json({ error: out.error, code: out.code || null, card: out.card || null });
        return res.json(out);
      } catch (err) {
        log.error('chat', 'Failed to make a message a request', { slug: req.params.slug, message: err.message });
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
    // Uploading is posting, so it takes joining too (403 join_required),
    // as POST /messages does: the storage cap below is per app, and a
    // non-member could otherwise fill it. Before the body parser, so a
    // refusal reads no bytes.
    communities.requireAppMembership(pool),
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
          WHERE id = $1 AND app_id = $2
            AND NOT EXISTS (SELECT 1 FROM chat_messages hidden WHERE hidden.id = chat_message_attachments.message_id AND hidden.moderation_hidden_at IS NOT NULL)`,
        [attId, app.id]
      );
      if (!rows.length) return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      if (att.message_id != null && (await pool.query(
        `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2`,
        [req.user.id, att.user_id]
      )).rows.length) return res.status(404).end();
      const inline = att.kind === 'image';
      const contentType = att.kind === 'image'
        ? (att.content_type || 'application/octet-stream')
        : (att.kind === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8');
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', attachmentDisposition(
        inline ? 'inline' : 'attachment', att.filename
      ));
      res.set('Cache-Control', 'private, no-store');
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
          WHERE id = $1 AND app_id = $2
            AND NOT EXISTS (SELECT 1 FROM chat_messages hidden WHERE hidden.id = chat_message_attachments.message_id AND hidden.moderation_hidden_at IS NOT NULL)`,
        [attId, app.id]
      );
      if (!rows.length || rows[0].kind !== 'html') return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      if (att.message_id != null && (await pool.query(
        `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2`,
        [req.user.id, att.user_id]
      )).rows.length) return res.status(404).end();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', attachmentDisposition('inline', att.filename || 'file.html'));
      res.set('Cache-Control', 'private, no-store');
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
  //   3. the app creator,
  //   4. the members of the app's community (#3361), after the three above.
  // De-duplicated, alphabetical, capped. The chat composer caches this once
  // per app mount and filters by prefix locally. #3361: `?q=` narrows it on
  // the server instead (the hub's channel composer), with the conversation
  // list's prefix rules (conversations.mentionPrefixQuery) and a cap of 25,
  // so in a community past the 500-row cap a new member is still found by
  // name; usernames are returned in
  // canonical casing so the inserted @mention renders correctly. Auth is
  // enforced by the global JWT gate (this is a GET under /api/). A
  // per-keystroke search over people, so it shares the user-directory
  // searches' per-user bucket, as /mention-candidates does.
  router.get('/api/apps/:slug/mention-suggestions', userDirectoryLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appId = app.id;
      const createdBy = app.created_by;
      // Only after the access check: a refused viewer learns nothing from q.
      const prefixed = req.query.q !== undefined;
      const query = prefixed ? conversationsSvc.mentionPrefixQuery(req.query.q) : null;
      if (prefixed && query === null) return res.json({ users: [] });

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
      // #2386: the viewer's friends lead, flagged `friend: true`. Every
      // caller filters this list by prefix in the order it arrives, so the
      // order is the whole benefit.
      // #3361: and the project's community members, who are the people
      // this channel is FOR — somebody who joined but has not spoken yet
      // was not offered at all. Members come after the people above (who
      // have spoken, are active or made it), so a large public community
      // cannot push those people out of the cap. Not on the platform's own project, whose
      // community is every account: its channel is #general now, which
      // answers from GET /api/conversations/:id/mention-candidates by prefix
      // instead of listing everybody here.
      const { rows } = await pool.query(
        `WITH engaged AS (
           SELECT unnest($2::int[]) AS user_id
           UNION
           SELECT m.user_id FROM chat_messages m
            WHERE m.app_id = $1 AND m.user_id IS NOT NULL
         ), members AS (
           SELECT cm.user_id FROM community_members cm
             JOIN apps a ON a.community_id = cm.community_id
            WHERE a.id = $1 AND NOT $4::boolean
         )
         SELECT u.username, LOWER(u.username) AS sort_name,
                EXISTS (SELECT 1 FROM friendships f
                         WHERE f.status = 'accepted'
                           AND f.user_low_id = LEAST(u.id, $3::int)
                           AND f.user_high_id = GREATEST(u.id, $3::int)) AS friend,
                u.id IN (SELECT user_id FROM engaged) AS engaged
           FROM users u
          WHERE NOT EXISTS (
                  SELECT 1 FROM user_blocks blocked
                   WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = u.id
                )
            AND (u.id IN (SELECT user_id FROM engaged)
             OR u.id IN (SELECT user_id FROM members))
            AND ($5::text IS NULL OR LOWER(u.username) LIKE LOWER($5::text) || '%' ESCAPE '\\')
          ORDER BY friend DESC, engaged DESC, sort_name
          LIMIT $6`,
        [
          appId, ids, req.user.id, !!app.self_hosted,
          prefixed ? conversationsSvc.escapeMentionLike(query) : null,
          prefixed ? conversationsSvc.MENTION_CANDIDATES_MAX : 500,
        ]
      );

      // B9: Homeroom bot, offered first when it answers this viewer here.
      const botChat = require('../services/homeroom-bot-chat');
      const here = await botChat.botFor(pool, { app, user: await botChat.personRow(pool, req.user.id) });
      res.json({
        users: rows.map((r) => (r.friend
          ? { username: r.username, friend: true }
          : { username: r.username })),
        ...(here ? { bot: { username: 'homeroom_bot', displayName: 'Homeroom bot', builds: here.builds } } : {}),
      });
    } catch (err) {
      log.error('chat', 'Failed to load mention suggestions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  chatRoutes,
  postedViaFor,
  stagingMockGroupChat,
  stagingMockGeneralStream,
  stagingDemoTranscript,
  stagingMockReplyThread,
  stagingMockStreamPage,
  stagingMockUnreadCount,
  DEMO_THREAD_ROOT_ID,
  THREAD_TYPES,
};
