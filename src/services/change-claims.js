'use strict';

// #6420: linking a change to a request is a CLAIM, not a merge. When a
// change lists a request among the ones it closes, that request's page says
// so and its requester and followers hear it once — even when the change
// lives on another request's page. The requester can answer "This doesn't
// close it", which marks the claim and says so in the change's discussion.
// Nothing here unlinks a request: `linked_issues` is untouched, so merging
// the change still closes it unless its builder removes it.
//
// `change_request_claims` (src/db/migrations/change-request-claims.sql) is
// the once-only record: a row means the claim was announced, and
// `disputed_at` is the requester's answer. Both the announcement and the
// answer are best effort: neither may fail the write it rides on.

const log = require('./logger');
const ws = require('./ws');
const repoRef = require('./repo-ref');
const notifications = require('./notifications');

// A change tells the requests it closes only once it is visible to everyone
// (up for a vote, merging, or shared), and only when it is not the request's
// own thread (that page already draws the change in full). A request already
// closed is not told.
const CANDIDATES_SQL = `
SELECT cs.id AS session_id, cs.app_id, cs.pr_number,
       n.number AS request_number, a.repo_url
  FROM chat_sessions cs
  JOIN apps a ON a.id = cs.app_id
  JOIN LATERAL unnest(COALESCE(cs.linked_issues, '{}'::int[])) AS n(number) ON TRUE
  JOIN requests rq ON rq.app_id = cs.app_id AND rq.number = n.number
 WHERE cs.is_headless = FALSE
   AND cs.status IN ('active', 'paused', 'promoted', 'merging')
   AND (cs.status IN ('promoted', 'merging') OR cs.shared_at IS NOT NULL)
   AND rq.state = 'open'
   AND rq.thread_id IS DISTINCT FROM cs.thread_id
   AND NOT EXISTS (
     SELECT 1 FROM change_request_claims c
      WHERE c.session_id = cs.id AND c.request_number = n.number)
   AND ($1::int IS NULL OR cs.id = $1)
   AND ($2::int IS NULL OR cs.app_id = $2)
 ORDER BY cs.id, n.number
 LIMIT 50`;

// "Change #6223 says it closes your request #6210." — a change is written
// PR on a project whose code is on GitHub, where its number comes from
// GitHub's own pull request counter.
function claimLine({ prNumber, requestNumber, repoUrl }) {
  const where = `your request #${Number(requestNumber)}`;
  if (prNumber == null) return `A change says it closes ${where}.`;
  return repoRef.isGithub(repoUrl)
    ? `Change PR ${Number(prNumber)} says it closes ${where}.`
    : `Change #${Number(prNumber)} says it closes ${where}.`;
}

async function botUser(pool, deps = {}) {
  const ensure = deps.ensureBotUser || require('./homeroom-bot').ensureBotUser;
  return deps.bot || ensure(pool);
}

/**
 * Announce every not-yet-recorded claim, either for one change (`sessionId`)
 * or across all apps (`appId: null`, the sweep). Returns how many were told.
 * Never throws: a failure is logged and the sweep tries again.
 */
async function announce(pool, { sessionId = null, appId = null } = {}, deps = {}) {
  try {
    const { rows } = await pool.query(CANDIDATES_SQL, [
      Number.isSafeInteger(Number(sessionId)) && Number(sessionId) > 0 ? Number(sessionId) : null,
      Number.isSafeInteger(Number(appId)) && Number(appId) > 0 ? Number(appId) : null,
    ]);
    if (!rows.length) return 0;
    const bot = await botUser(pool, deps);
    if (!bot) return 0;
    let told = 0;
    for (const row of rows) {
      // Only the call that creates the row tells anyone: a second call, or a
      // second process racing this one, posts nothing.
      const { rows: claimed } = await pool.query(
        `INSERT INTO change_request_claims (session_id, app_id, request_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, request_number) DO NOTHING
         RETURNING session_id`,
        [Number(row.session_id), Number(row.app_id), Number(row.request_number)],
      );
      if (!claimed.length) continue;
      try {
        const message = await ws.sendBotMessage(pool, Number(row.app_id), {
          user: bot,
          content: claimLine({
            prNumber: row.pr_number == null ? null : Number(row.pr_number),
            requestNumber: Number(row.request_number),
            repoUrl: row.repo_url,
          }),
          metadata: { kind: 'change_claim', sessionId: Number(row.session_id), request: Number(row.request_number) },
          thread: { type: 'issue', ref: Number(row.request_number) },
        });
        if (message) {
          await notifications.createThreadNotifications(pool, {
            appId: Number(row.app_id), messageId: message.id, senderId: bot.id,
          });
        }
        told += 1;
      } catch (err) {
        log.warn('change-claims', 'A claim could not be announced', {
          sessionId: Number(row.session_id), request: Number(row.request_number), err: err.message,
        });
      }
    }
    if (told) log.info('change-claims', 'Announced changes\' claims on requests', { told });
    return told;
  } catch (err) {
    log.warn('change-claims', 'Could not announce changes\' claims', { err: err.message });
    return 0;
  }
}

const CHANGE_FOR_CLAIM_SQL = `
SELECT cs.id, cs.app_id, cs.status, cs.shared_at, cs.user_id, cs.linked_issues,
       rq.created_by AS requester_id
  FROM chat_sessions cs
  JOIN requests rq ON rq.app_id = cs.app_id AND rq.number = $3
 WHERE cs.id = $1 AND cs.app_id = $2 AND cs.is_headless = FALSE`;

function isNavigable(row, viewerId) {
  if (row.status === 'merged' || row.status === 'merging' || row.status === 'promoted') return true;
  return !!row.shared_at || (viewerId != null && Number(row.user_id) === Number(viewerId));
}

/**
 * The requester's answer to a claim: record it once, and say so in the
 * change's discussion so voters see it. Returns { ok, status, error, code }
 * for the route; an answer already given is a no-op success.
 */
async function dispute(pool, { appId, requestNumber, sessionId, userId, username }, deps = {}) {
  const n = Number(requestNumber);
  const id = Number(sessionId);
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, status: 400, error: 'Invalid request or change' };
  }
  const { rows } = await pool.query(CHANGE_FOR_CLAIM_SQL, [id, Number(appId), n]);
  const row = rows[0];
  if (!row || !Array.isArray(row.linked_issues) || !row.linked_issues.map(Number).includes(n)) {
    return { ok: false, status: 404, error: 'Change not found' };
  }
  if (!isNavigable(row, userId)) return { ok: false, status: 404, error: 'Change not found' };
  if (row.requester_id == null || Number(row.requester_id) !== Number(userId)) {
    return { ok: false, status: 403, error: 'Only the requester can answer this', code: 'not_requester' };
  }
  if (Number(row.user_id) === Number(userId)) {
    return { ok: false, status: 409, error: 'You built this change, so there is nothing to answer', code: 'own_change' };
  }
  const { rows: written } = await pool.query(
    `INSERT INTO change_request_claims (session_id, app_id, request_number, disputed_at, disputed_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (session_id, request_number) DO UPDATE
       SET disputed_at = EXCLUDED.disputed_at, disputed_by = EXCLUDED.disputed_by
       WHERE change_request_claims.disputed_at IS NULL
     RETURNING session_id`,
    [id, Number(appId), n, Number(userId)],
  );
  // Already answered: idempotent, and no second line in the change's thread.
  if (!written.length) return { ok: true, status: 200, disputed: true, repeated: true };
  const sender = deps.ws || ws;
  await sender.sendSystemMessage(pool, Number(appId),
    `@${username} says this doesn't close their request #${n}.`,
    'system', { kind: 'change_claim_disputed', request: n }, { type: 'session', ref: id }).catch((err) => {
      log.warn('change-claims', 'The requester\'s answer could not be posted', { sessionId: id, err: err.message });
    });
  return { ok: true, status: 200, disputed: true };
}

module.exports = { announce, dispute, claimLine, CANDIDATES_SQL };
