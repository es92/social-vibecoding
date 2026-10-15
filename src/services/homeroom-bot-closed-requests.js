'use strict';

// The Homeroom bot's proposals for requests that closed some other way.
//
// noteRequestMerged (homeroom-bot.js) withdraws the bot's other proposals for
// a request once the bot's OWN proposal for it merges. A request also closes
// when a person's change ships it, when the group votes to close it, or when
// somebody closes it on GitHub, and none of those touched the bot's proposal:
// it stayed up for a vote, and since classifyIssue never reads a closed
// request again, the bot never looked at it again either. On 15 October three
// of the five proposals the platform project allows the bot
// (PROPOSALS_PER_APP_CAP) were for closed requests: #4817 shipped by a
// person's PR, #4389 shipped by another change, #4968 closed by a vote. Every
// other ready request on the project waited behind them.
//
// So a proposal of the bot's that is up for a vote is withdrawn once EVERY
// request it is linked to is closed (one linked to two stays while either is
// open), the same system archive noteRequestMerged uses, with a line on each
// request saying why. A person's proposal is theirs, and one already approved
// (merging, merged) is past withdrawing. What calls this:
//   - every observed close after a merge, the bot's or a person's
//     (issue-close-watcher.js, and included-changes.js for a change that went
//     live inside another);
//   - a passed close-issue vote (routes/issues.js maybeApplyCloseIssueProposal);
//   - the bot's own refresh, for a request closed on GitHub, where Homeroom
//     gets no signal (homeroom-bot.js refreshApp, sweepClosedRequests).
// Best effort everywhere: never a reason a merge, a vote or a refresh fails.

const log = require('./logger');

const BOT_USERNAME = 'homeroom_bot';
const REASON = 'request-closed';

// The bot's proposals up for a vote on one app, by what they are linked to:
// any of `$3` (a close just seen), or none of `$3` (a refresh's open list).
// Kept whole, rather than one query with a clause added, so each stays a
// static statement the SQL checks read as written.
const LINKED_TO_ANY_SQL = `
  SELECT cs.id, cs.app_id, cs.linked_issues,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
         a.repo_url
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    JOIN apps a ON a.id = cs.app_id
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND u.username = $2 AND u.is_synthetic = TRUE
     AND cs.linked_issues && $3::int[]
   ORDER BY cs.id`;

const LINKED_TO_NONE_SQL = `
  SELECT cs.id, cs.app_id, cs.linked_issues,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
         a.repo_url
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    JOIN apps a ON a.id = cs.app_id
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND u.username = $2 AND u.is_synthetic = TRUE
     AND cardinality(cs.linked_issues) > 0
     AND NOT (cs.linked_issues && $3::int[])
   ORDER BY cs.id`;

function parseRepo(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function numbersOf(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Pure: the line a withdrawal leaves on each of its requests. */
function closedNote(title) {
  const what = title ? `“${String(title).slice(0, 120)}”` : 'Homeroom bot\'s change for this request';
  return `${what} was withdrawn: this request is closed.`;
}

// Whether GitHub says #n is a closed issue. Only a positive answer counts: a
// failed read, a pull request or anything else keeps the proposal up.
function githubClosed(repo, deps) {
  const memo = new Map();
  return (n) => {
    if (!memo.has(n)) {
      const github = deps.github || require('./github');
      memo.set(n, !repo ? Promise.resolve(false) : Promise.resolve()
        .then(() => github.getIssue(repo.owner, repo.repo, n))
        .then((issue) => !!issue && issue.state === 'closed' && !issue.pull_request, () => false));
    }
    return memo.get(n);
  };
}

async function withdrawOne(pool, session, numbers, deps) {
  const lifecycle = deps.sessionLifecycle || require('./session-lifecycle');
  let archived = false;
  try {
    ({ archived } = await lifecycle.archiveSession({ pool, sessionId: Number(session.id), reason: REASON }));
  } catch (err) {
    // A side effect after the archive failed: it is withdrawn if its row says so.
    log.warn('homeroom-bot-closed-requests', 'Withdrawing a proposal partly failed', { sessionId: session.id, err: err.message });
    const { rows } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
    archived = rows[0]?.status === 'archived';
  }
  if (!archived) return false;
  const ws = deps.ws || require('./ws');
  for (const n of numbers) {
    await Promise.resolve(ws.sendSystemMessage(pool, Number(session.app_id), closedNote(session.title),
      'system', null, { type: 'issue', ref: n })).catch(() => {});
  }
  return true;
}

async function withdrawWhereAllClosed(pool, sessions, { known = new Set(), deps = {} }) {
  const withdrawn = [];
  for (const session of sessions) {
    const linked = numbersOf(session.linked_issues);
    if (!linked.length) continue;
    const isClosed = deps.isClosed || githubClosed(parseRepo(session.repo_url), deps);
    let allClosed = true;
    for (const n of linked) {
      if (known.has(n)) continue;
      if (!(await isClosed(n))) { allClosed = false; break; }
    }
    if (allClosed && await withdrawOne(pool, session, linked, deps)) withdrawn.push(Number(session.id));
  }
  return withdrawn;
}

function wakeFor(appId, deps) {
  try {
    (deps.wake || require('./homeroom-bot').wake)({ appId: Number(appId) });
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Could not wake the bot after a withdrawal', { appId, err: err.message });
  }
}

/**
 * Requests `closed` on app `appId` were just closed. Withdraws every proposal
 * of the bot's up for a vote that is linked to one of them and whose other
 * linked requests GitHub also reads closed, then wakes the bot for the app so
 * a held request takes the slot. Resolves { withdrawn: [sessionId] }, or null
 * when it could not read; `strict` (the merge-followups machine's durable
 * work, which retries) throws that instead. Never throws otherwise.
 */
async function noteRequestsClosed(pool, { appId, closed, strict = false, deps = {} } = {}) {
  const numbers = numbersOf(closed);
  if (!pool || !(Number(appId) > 0) || !numbers.length) return { withdrawn: [] };
  try {
    const { rows } = await pool.query(LINKED_TO_ANY_SQL, [Number(appId), BOT_USERNAME, numbers]);
    const withdrawn = await withdrawWhereAllClosed(pool, rows, { known: new Set(numbers), deps });
    if (withdrawn.length) {
      log.info('homeroom-bot-closed-requests', 'Withdrew the bot\'s proposals for closed requests', { appId, closed: numbers, withdrawn });
      wakeFor(appId, deps);
    }
    return { withdrawn };
  } catch (err) {
    if (strict) throw err;
    log.warn('homeroom-bot-closed-requests', 'Could not settle the bot\'s proposals for closed requests', { appId, closed: numbers, err: err.message });
    return null;
  }
}

/**
 * The bot's refresh of one app read its open requests (`openNumbers`, a
 * complete list): a proposal of the bot's up for a vote none of whose linked
 * requests is among them may be for requests closed on GitHub. Each is
 * withdrawn once GitHub confirms every one of its requests closed. The list
 * alone is not trusted: a number just closed is hidden from it before GitHub
 * agrees (github.noteIssuesClosed), and one closed by mistake may be reopened.
 * The caller does not wake the bot; it is the refresh. Resolves
 * { withdrawn: [sessionId] }; never throws.
 */
async function sweepClosedRequests(pool, { appId, openNumbers, deps = {} } = {}) {
  if (!pool || !(Number(appId) > 0) || !Array.isArray(openNumbers)) return { withdrawn: [] };
  try {
    const { rows } = await pool.query(LINKED_TO_NONE_SQL, [Number(appId), BOT_USERNAME, numbersOf(openNumbers)]);
    const withdrawn = await withdrawWhereAllClosed(pool, rows, { deps });
    if (withdrawn.length) {
      log.info('homeroom-bot-closed-requests', 'Withdrew the bot\'s proposals for requests closed on GitHub', { appId, withdrawn });
    }
    return { withdrawn };
  } catch (err) {
    log.warn('homeroom-bot-closed-requests', 'Sweep for the bot\'s proposals on closed requests failed', { appId, err: err.message });
    return { withdrawn: [] };
  }
}

module.exports = { noteRequestsClosed, sweepClosedRequests, closedNote, REASON };
