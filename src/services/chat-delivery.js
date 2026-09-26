'use strict';

// #3177: confirming that a dev-chat message arrived when the stream that
// carried it broke early.
//
// POST /api/sessions/:id/chat stores the user's message and then answers with
// an SSE stream that lasts as long as the turn, which is minutes for a build.
// On a slow or mobile network that stream can die after a few hundred bytes,
// and a client that read "the stream broke" as "the send failed" told its user
// a message had failed while the agent was already working on it. Three
// additive pieces close that gap:
//
//   1. `accepted`, the turn's first event, written once the message row
//      exists: { type: 'accepted', _seq, messageId, clientMessageId }. A
//      client that has read it knows the message was delivered, whatever
//      happens to the stream afterwards. Its `_seq` is where the turn's replay
//      starts: GET /api/sessions/:id/events?since=<_seq> replays every later
//      event still in this process's ring buffer (services/session-bus.js),
//      then follows the turn live. EventSource's Last-Event-ID does the same
//      on each reconnect.
//   2. `client_message_id` (or `clientMessageId`), optional on the POST. A
//      retry that carries the same id finds the stored message and answers
//      with that message's `accepted` event, marked `duplicate: true` and
//      carrying its `state`, instead of storing it again and starting a
//      second turn.
//   3. GET /api/sessions/:id/status?client_message_id=<id>, the same lookup
//      without sending anything: `delivery` says whether the message arrived
//      and whether its turn is running or done.
//
// A client that sends no id and ignores event types it does not know sees
// nothing different.

const { normalizeIdempotencyKey } = require('./conversations');
const sessionBus = require('./session-bus');
const stopRegistry = require('./stop-registry');
const { isSessionBusy } = require('./active-workers');

// Read the optional id from a request body or query string. It has the same
// shape as a conversation message's idempotency_key (8 to 64 of
// [A-Za-z0-9._:-], starting with a letter or digit), so a UUID fits.
// `present` separates "not sent" from "sent but malformed", which the routes
// refuse with a 400 rather than ignoring.
function readClientMessageId(source) {
  const raw = source?.client_message_id ?? source?.clientMessageId;
  if (raw == null) return { present: false, value: null };
  return { present: true, value: normalizeIdempotencyKey(raw) };
}

const BAD_CLIENT_MESSAGE_ID = 'Bad client_message_id: use 8 to 64 letters, digits, ".", "_", ":" or "-", starting with a letter or digit';

// Where the turn a stored message started stands.
//
//   running   this process is running it. The live stop handle names the
//             message; or a live turn whose handle names none (one adopted
//             after a restart) is running and this is the newest message the
//             user sent.
//   done      nothing is running it and the transcript has moved past it: the
//             turn's reply or status rows, or a later message.
//   received  stored, and nothing has happened after it yet.
function deliveryState({ messageId, liveMessageId, turnLive, isLatestUserMessage, hasLaterRows }) {
  if (liveMessageId != null) {
    if (Number(liveMessageId) === Number(messageId)) return 'running';
  } else if (turnLive && isLatestUserMessage) {
    return 'running';
  }
  return hasLaterRows ? 'done' : 'received';
}

// The `_seq` of the stored message's own `accepted` event while the ring
// buffer still holds it, else null.
function acceptedSeq(sessionId, messageId) {
  const event = sessionBus.findLast(Number(sessionId), (e) => (
    e.type === 'accepted' && Number(e.messageId) === Number(messageId)
  ));
  return event ? event._seq : null;
}

// Look a message up by the id its client sent. Only the session's owner (or a
// platform admin, the rule GET /events uses) gets an answer; anyone else is
// told nothing was received, exactly as for an id that was never sent.
async function lookup(db, { sessionId, clientMessageId, viewer }) {
  const { rows } = await db.query(
    `SELECT m.id,
            EXISTS (SELECT 1 FROM chat_session_messages later
                     WHERE later.session_id = m.session_id AND later.id > m.id) AS has_later,
            NOT EXISTS (SELECT 1 FROM chat_session_messages newer
                         WHERE newer.session_id = m.session_id AND newer.id > m.id
                           AND newer.role = 'user') AS latest_user
       FROM chat_session_messages m
       JOIN chat_sessions cs ON cs.id = m.session_id
      WHERE m.session_id = $1 AND m.client_message_id = $2 AND m.role = 'user'
        AND (cs.user_id = $3 OR $4)`,
    [sessionId, clientMessageId, viewer?.id ?? null, !!viewer?.isAdmin]
  );
  if (!rows.length) return { clientMessageId, received: false };
  const row = rows[0];
  const messageId = Number(row.id);
  const handle = stopRegistry.get(sessionId);
  const state = deliveryState({
    messageId,
    liveMessageId: handle?.userMessageId ?? null,
    turnLive: !!handle || isSessionBusy(Number(sessionId)),
    isLatestUserMessage: !!row.latest_user,
    hasLaterRows: !!row.has_later,
  });
  return {
    clientMessageId,
    received: true,
    messageId,
    state,
    since: acceptedSeq(sessionId, messageId),
  };
}

// The one event a duplicate send answers with. It reuses the original
// `accepted` event's `_seq` while the buffer holds it, so the same resume
// rule (`since=<_seq>`) replays that turn exactly. Otherwise it carries a
// seq no turn ever emits (turns count from 1), which the bus does not know,
// so `since=` replays whatever the buffer still holds and then follows live.
function duplicateAcceptedEvent(delivery) {
  return {
    type: 'accepted',
    _seq: delivery.since || `${Date.now().toString(36)}-0`,
    messageId: delivery.messageId,
    clientMessageId: delivery.clientMessageId,
    duplicate: true,
    state: delivery.state,
  };
}

// A retry of a message that is already stored gets the same response shape
// as a send (an SSE stream), carrying that one event, and ends there: the turn
// it started is running or has run, and GET /events?since= follows it.
function answerDuplicate(res, delivery) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.end(`data: ${JSON.stringify(duplicateAcceptedEvent(delivery))}\n\n`);
}

module.exports = {
  BAD_CLIENT_MESSAGE_ID,
  acceptedSeq,
  answerDuplicate,
  deliveryState,
  duplicateAcceptedEvent,
  lookup,
  readClientMessageId,
};
