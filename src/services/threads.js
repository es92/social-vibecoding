'use strict';

// Threads (#6019): every request, change, governance row and message about
// a piece of work is attached to one thread (src/db/schema.sql, "Threads").
// The schema's triggers attach every new row; the backfill below attaches
// the rows that were there before, once. Who follows a thread is at the end
// (stage 2).
//
// It is idempotent by its predicates: every statement touches only rows
// with no thread yet, and makes a numbered thread with ON CONFLICT DO
// NOTHING, so running it again, or after a run cut short, attaches what is
// left and changes nothing else. A `platform_settings` marker records a
// completed pass so later boots cost one lookup. Deleting the marker runs it
// again, which is safe.
//
// Messages are the large table, so they go in id ranges, set-based per
// range: a numbered thread is made for each request a message names first,
// then the messages are joined to it. Nothing here fails the boot: a step
// that throws is logged, the marker stays unset, and the next boot retries.

const log = require('./logger');
const { planRecordSql } = require('./request-specs');
const issueRefs = require('./issue-proposal-ref');
const { IN_PROGRESS_PAUSED_WINDOW_DAYS } = require('./issue-progress');
const { workedOnSql } = require('../workflow/session-work.ts');

const MARKER_KEY = 'threads_backfilled_v1';
const MESSAGE_BATCH = 10000;
const SESSION_BATCH = 2000;

async function markerSet(pool) {
  const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [MARKER_KEY]);
  return rows.length > 0;
}

async function setMarker(pool) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
     ON CONFLICT (key) DO NOTHING`,
    [
      MARKER_KEY,
      'Marker: every request, change, governance row and message that existed when threads arrived (#6019, stage 1) '
      + 'has been attached to its thread. Deleting it re-runs the pass on the next boot, which is safe: it only '
      + 'attaches rows that have no thread.',
    ]
  );
}

// Requests: one thread per request number.
async function attachRequests(pool) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT app_id, number FROM requests WHERE thread_id IS NULL
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rowCount } = await pool.query(
    `UPDATE requests r SET thread_id = t.id
       FROM threads t
      WHERE r.thread_id IS NULL AND t.app_id = r.app_id AND t.number = r.number`
  );
  return rowCount;
}

// Governance rows: a request's twin and a proposal to close join a number's
// thread; any other kind gets a decision thread of its own (the schema's
// issue_thread_id, the same rule the trigger applies). A twin with no number
// and a proposal to close that names none have no thread to join, so they
// are left out rather than rewritten as unattached on every pass.
async function attachIssues(pool) {
  const { rowCount } = await pool.query(
    `UPDATE issues
        SET thread_id = issue_thread_id(app_id, kind, github_issue_number, payload, title)
      WHERE thread_id IS NULL AND app_id IS NOT NULL
        AND NOT (kind = 'general' AND github_issue_number IS NULL)
        AND NOT (kind = 'close_issue' AND COALESCE(payload ->> 'issueNumber', '') !~ '^[0-9]{1,9}$')`
  );
  return rowCount;
}

// Changes, in id ranges: the schema's session_thread_id, the trigger's rule.
// Each one that gets a thread carries its replies with it (the
// chat_sessions_carry_thread_messages trigger).
async function attachSessions(pool, { batch = SESSION_BATCH } = {}) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_sessions');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions
          SET thread_id = session_thread_id(app_id, linked_issues, created_from_issue_number,
                                            pr_number, branch_name, pr_title)
        WHERE id > $1 AND id <= $2 AND thread_id IS NULL AND app_id IS NOT NULL
          AND (cardinality(COALESCE(linked_issues, '{}')) > 0
               OR created_from_issue_number IS NOT NULL OR pr_number IS NOT NULL)`,
      [lo, lo + batch]
    );
    attached += rowCount;
  }
  return attached;
}

// Messages, in id ranges. A request's discussion names its number: make the
// threads those numbers need first, then join. A change's and a governance
// row's discussion join the thread their row already has.
async function attachMessages(pool, { batch = MESSAGE_BATCH } = {}) {
  await pool.query(
    `INSERT INTO threads (app_id, number)
     SELECT DISTINCT app_id, thread_ref FROM chat_messages
      WHERE thread_type = 'issue' AND thread_id IS NULL AND app_id IS NOT NULL AND thread_ref > 0
     ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO NOTHING`
  );
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max FROM chat_messages');
  const max = Number(rows[0].max) || 0;
  let attached = 0;
  for (let lo = 0; lo <= max; lo += batch) {
    const range = [lo, lo + batch];
    const issue = await pool.query(
      `UPDATE chat_messages m SET thread_id = t.id
         FROM threads t
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'issue'
          AND t.app_id = m.app_id AND t.number = m.thread_ref`,
      range
    );
    const session = await pool.query(
      `UPDATE chat_messages m SET thread_id = s.thread_id
         FROM chat_sessions s
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'session'
          AND s.id = m.thread_ref AND s.app_id = m.app_id AND s.thread_id IS NOT NULL`,
      range
    );
    const governance = await pool.query(
      `UPDATE chat_messages m SET thread_id = i.thread_id
         FROM issues i
        WHERE m.id > $1 AND m.id <= $2 AND m.thread_id IS NULL AND m.thread_type = 'governance'
          AND i.id = m.thread_ref AND i.app_id = m.app_id AND i.thread_id IS NOT NULL`,
      range
    );
    attached += issue.rowCount + session.rowCount + governance.rowCount;
  }
  return attached;
}

/**
 * Attach every row that existed before threads did. Requests and governance
 * rows first, then changes, then messages, so each message's anchor already
 * has its thread. Returns the counts, or `{ skipped }`.
 */
async function backfill(pool, { batch = {} } = {}) {
  try {
    if (await markerSet(pool)) return { skipped: 'done' };
  } catch (err) {
    log.warn('threads', 'Backfill not run: the marker could not be read', { err: err.message });
    return { skipped: 'unavailable' };
  }
  const started = Date.now();
  const counts = {};
  try {
    counts.requests = await attachRequests(pool);
    counts.issues = await attachIssues(pool);
    counts.sessions = await attachSessions(pool, { batch: batch.sessions });
    counts.messages = await attachMessages(pool, { batch: batch.messages });
    await setMarker(pool);
  } catch (err) {
    log.error('threads', 'Backfill stopped; the next boot carries on from where it got to', {
      err: err.message, ...counts,
    });
    return { failed: true, ...counts };
  }
  log.info('threads', 'Threads backfilled', { ...counts, ms: Date.now() - started });
  return counts;
}

// ── Open and closed (follow-up) ─────────────────────────────────────
//
// The schema's threads_refresh_state keeps a thread open while anything in
// it is, from the moment its triggers exist. Threads made before then took
// their request's state once, or none, so this sets every thread's state
// from what it holds, once, behind its own marker.
const STATE_MARKER_KEY = 'threads_state_v1';

async function refreshStates(pool) {
  try {
    const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [STATE_MARKER_KEY]);
    if (rows.length) return { skipped: 'done' };
    const started = Date.now();
    const { rowCount } = await pool.query(
      `SELECT threads_refresh_state(id) FROM threads WHERE merged_into IS NULL`
    );
    await pool.query(
      `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
       ON CONFLICT (key) DO NOTHING`,
      [STATE_MARKER_KEY, 'Marker: every thread\'s open or closed state was worked out from what it holds (#6019 follow-up). '
        + 'Deleting it works them out again on the next boot, which is safe.']
    );
    log.info('threads', 'Thread states refreshed', { threads: rowCount, ms: Date.now() - started });
    return { threads: rowCount };
  } catch (err) {
    log.error('threads', 'Thread states not refreshed; the next boot tries again', { err: err.message });
    return { failed: true };
  }
}

// ── Changes that shared a request's number (follow-up) ───────────────
//
// Until session_thread_id learned otherwise, a change that links no request
// joined the thread numbered by its PR number, and on a project still on
// GitHub that number can be an unrelated request's: Change #6002 sat in
// Request #6002's thread. This moves each such change to a thread of its
// own with no number, once, behind its own marker. Its replies go with it
// (chat_sessions_carry_thread_messages), both threads' states are worked out
// again (threads_follow_state), and its people go with it, since followers
// are derived. A change
// that links the request, or was made from it, stays.
const NUMBERS_MARKER_KEY = 'threads_pr_numbers_v1';

const COLLIDED_SQL = `
  SELECT s.id, s.app_id, s.branch_name, s.pr_title
    FROM chat_sessions s
    JOIN threads t ON t.id = s.thread_id
   WHERE t.number = s.pr_number
     AND EXISTS (SELECT 1 FROM requests r WHERE r.app_id = s.app_id AND r.number = s.pr_number)
     AND NOT (s.pr_number = ANY(COALESCE(s.linked_issues, '{}'::int[])))
     AND s.created_from_issue_number IS DISTINCT FROM s.pr_number
   ORDER BY s.id`;

async function separateNumberCollisions(pool) {
  try {
    const { rows: done } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [NUMBERS_MARKER_KEY]);
    if (done.length) return { skipped: 'done' };
    const started = Date.now();
    const { rows } = await pool.query(COLLIDED_SQL);
    for (const row of rows) {
      await pool.query(
        `WITH made AS (
           INSERT INTO threads (app_id, kind, title)
           SELECT $2, k.kind, CASE WHEN k.kind = 'decision' THEN $4 END
             FROM (SELECT thread_kind_for_branch($3) AS kind) k
           RETURNING id
         )
         UPDATE chat_sessions SET thread_id = (SELECT id FROM made) WHERE id = $1`,
        [row.id, row.app_id, row.branch_name, row.pr_title]
      );
    }
    await pool.query(
      `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
       ON CONFLICT (key) DO NOTHING`,
      [NUMBERS_MARKER_KEY, 'Marker: every change that was in a request\'s thread only because its PR number was the '
        + 'request\'s got a thread of its own (#6019 follow-up). Deleting it runs the pass again on the next boot, '
        + 'which is safe: it moves only changes still in that state.']
    );
    log.info('threads', 'Changes moved out of requests that shared their number', { changes: rows.length, ms: Date.now() - started });
    return { changes: rows.length };
  } catch (err) {
    log.error('threads', 'Changes sharing a request\'s number not moved; the next boot tries again', { err: err.message });
    return { failed: true };
  }
}

// ── Followers (stage 2) ─────────────────────────────────────────────
//
// A thread's followers are worked out from what is in it, never stored:
//   requested  whoever filed one of its requests (the request, its twin in
//              `issues`, the bot's requester row, the feedback pin) or
//              proposed one of its governance rows;
//   built      whoever owns one of its changes;
//   voted      whoever voted on one of its changes or governance rows;
//   replied    whoever posted in it before the new message (a live, human
//              post: the bot's status lines make nobody a follower);
//   notify_me  whoever chose Notify me (`thread_followers`, muted_at NULL);
// less whoever chose Mute. The request half is #4535's rule for a request's
// discussion, read across every request number in the thread rather than
// one, so a request's discussion reaches exactly the people it did, plus
// the builders and voters.
//
// $1 the thread, $2 its app, $3 the new message (0 for "everyone now"),
// $4/$5 the app's repository owner and name, for feedback filed against the
// repository rather than the app.
const FOLLOWERS_SQL = `
WITH numbers AS (
  SELECT number FROM threads WHERE id = $1 AND number IS NOT NULL
  UNION SELECT number FROM requests WHERE thread_id = $1
  UNION SELECT github_issue_number FROM issues
         WHERE thread_id = $1 AND kind = 'general' AND github_issue_number IS NOT NULL
), derived AS (
  SELECT i.created_by AS user_id FROM issues i
   WHERE i.app_id = $2 AND i.github_issue_number IN (SELECT number FROM numbers)
  UNION SELECT i.created_by FROM issues i WHERE i.thread_id = $1
  UNION SELECT r.created_by FROM requests r WHERE r.thread_id = $1
  UNION SELECT b.user_id FROM homeroom_bot_requesters b
   WHERE b.app_id = $2 AND b.issue_number IN (SELECT number FROM numbers)
  UNION SELECT f.user_id FROM feedback_reports f
   WHERE f.issue_number IN (SELECT number FROM numbers)
     AND (f.app_id = $2 OR ($4::text IS NOT NULL
          AND LOWER(f.issue_owner) = LOWER($4) AND LOWER(f.issue_repo) = LOWER($5)))
  UNION SELECT s.user_id FROM chat_sessions s
    JOIN users u ON u.id = s.user_id AND u.is_synthetic = FALSE
   WHERE s.thread_id = $1
  UNION SELECT v.user_id FROM pr_votes v
    JOIN chat_sessions s ON s.id = v.session_id
   WHERE s.thread_id = $1
  UNION SELECT v.user_id FROM issue_votes v
    JOIN issues i ON i.id = v.issue_id
   WHERE i.thread_id = $1
  UNION SELECT m.user_id FROM chat_messages m
    JOIN users u ON u.id = m.user_id AND u.is_synthetic = FALSE
   WHERE m.thread_id = $1 AND ($3::int = 0 OR m.id < $3) AND m.msg_type = 'message'
     AND m.deleted_at IS NULL
)
(SELECT user_id FROM derived WHERE user_id IS NOT NULL
 UNION
 SELECT user_id FROM thread_followers WHERE thread_id = $1 AND muted_at IS NULL)
EXCEPT
SELECT user_id FROM thread_followers WHERE thread_id = $1 AND muted_at IS NOT NULL`;

/** The thread a stored message belongs to, with what a notification about it needs. */
async function threadOfMessage(db, { appId, messageId }) {
  const { rows } = await db.query(
    `SELECT m.thread_id, m.thread_type, m.thread_ref, t.kind, a.repo_url,
            -- A change's own thread with no number (session_thread_id: its
            -- PR number is a request's) is named by its change.
            COALESCE(t.number, (SELECT s.pr_number FROM chat_sessions s
                                 WHERE s.thread_id = t.id AND s.pr_number IS NOT NULL
                                 ORDER BY s.id LIMIT 1)) AS number,
            EXISTS (SELECT 1 FROM chat_sessions s
                     WHERE s.thread_id = t.id
                       AND (s.pr_number = t.number OR (t.number IS NULL AND s.pr_number IS NOT NULL))) AS change_led
       FROM chat_messages m
       JOIN apps a ON a.id = m.app_id
       LEFT JOIN threads t ON t.id = m.thread_id AND t.app_id = m.app_id
      WHERE m.id = $1 AND m.app_id = $2`,
    [messageId, appId]
  );
  return rows[0] || null;
}

/** Who follows `threadId` (see FOLLOWERS_SQL); only posts before `beforeMessageId` count. */
async function followerIds(db, { threadId, appId, beforeMessageId = 0, owner = null, repo = null }) {
  if (!threadId || !appId) return [];
  const { rows } = await db.query(FOLLOWERS_SQL, [threadId, appId, Number(beforeMessageId) || 0, owner, repo]);
  return [...new Set(rows.map((r) => Number(r.user_id)))].filter(Number.isInteger);
}

/**
 * One person's standing in a thread: `following` (derived or Notify me),
 * `muted`, or `none`; `chosen` says whether they picked it themselves.
 */
async function followState(db, { threadId, appId, userId, owner = null, repo = null }) {
  if (!threadId || !userId) return { state: 'none', chosen: false };
  const { rows } = await db.query(
    'SELECT muted_at FROM thread_followers WHERE thread_id = $1 AND user_id = $2',
    [threadId, userId]
  );
  if (rows[0]) return { state: rows[0].muted_at ? 'muted' : 'following', chosen: true };
  const ids = await followerIds(db, { threadId, appId, owner, repo });
  return { state: ids.includes(Number(userId)) ? 'following' : 'none', chosen: false };
}

/**
 * Notify me (`notify` true), Mute (false), or back to the derived rule
 * (null). Resolves what is stored now.
 */
async function setFollow(db, { threadId, userId, notify }) {
  if (notify === null) {
    await db.query('DELETE FROM thread_followers WHERE thread_id = $1 AND user_id = $2', [threadId, userId]);
    return null;
  }
  await db.query(
    `INSERT INTO thread_followers (thread_id, user_id, muted_at)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN NULL ELSE NOW() END)
     ON CONFLICT (thread_id, user_id) DO UPDATE
       SET muted_at = EXCLUDED.muted_at, updated_at = NOW()`,
    [threadId, userId, !!notify]
  );
  return !!notify;
}

// Posting in a thread you muted follows it again, as replying does on
// GitHub: the person is taking part, and an answer to what they just said
// should reach them. Notify me stays.
async function unmuteOnPost(db, { messageId, userId }) {
  if (!messageId || !userId) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM thread_followers f
      USING chat_messages m
      WHERE m.id = $1 AND m.thread_id IS NOT NULL AND f.thread_id = m.thread_id
        AND f.user_id = $2 AND f.muted_at IS NOT NULL`,
    [messageId, userId]
  );
  return rowCount || 0;
}

// ── The thread page (stage 3) ───────────────────────────────────────

// How many merges a thread's number is followed through to where it went.
const MERGE_HOPS = 8;
// How many of an item's newest replies its row folds under it.
const FOLDED_REPLIES = 3;

/**
 * The thread a number names in `appId`: the number's own (a request's, or a
 * change's that leads one), else the thread of the change whose pull
 * request has that number, which may lead a request's thread; then wherever
 * a merge took it. Null when there is none.
 *
 * `asChange`: the number is a pull request's, so the change's own thread
 * answers first. A change's page asks this way. On a project still on
 * GitHub a pull request can share its number with an unrelated request
 * (services/app-numbers.js), and the number's own thread is the request's.
 */
const CHANGE_THREAD_SQL = `SELECT t.id, t.app_id, t.number, t.kind, t.title, t.state, t.merged_into
         FROM chat_sessions s JOIN threads t ON t.id = s.thread_id
        WHERE s.app_id = $1 AND s.pr_number = $2
        ORDER BY s.id DESC LIMIT 1`;

async function threadForNumber(db, { appId, number, asChange = false }) {
  const n = Number(number);
  if (!appId || !Number.isSafeInteger(n) || n <= 0) return null;
  let rows = [];
  if (asChange) ({ rows } = await db.query(CHANGE_THREAD_SQL, [appId, n]));
  if (!rows[0]) {
    ({ rows } = await db.query(
      'SELECT id, app_id, number, kind, title, state, merged_into FROM threads WHERE app_id = $1 AND number = $2',
      [appId, n]
    ));
  }
  if (!rows[0] && !asChange) ({ rows } = await db.query(CHANGE_THREAD_SQL, [appId, n]));
  return followMerges(db, rows[0] || null);
}

/** The thread `id`, through any merges, or null. */
async function threadById(db, id) {
  if (!/^[1-9][0-9]{0,15}$/.test(String(id))) return null;
  const { rows } = await db.query(
    'SELECT id, app_id, number, kind, title, state, merged_into FROM threads WHERE id = $1',
    [id]
  );
  return followMerges(db, rows[0] || null);
}

async function followMerges(db, thread) {
  let at = thread;
  for (let hop = 0; at && at.merged_into && hop < MERGE_HOPS; hop += 1) {
    const { rows } = await db.query(
      `SELECT id, app_id, number, kind, title, state, merged_into
         FROM threads WHERE id = $1 AND app_id = $2`,
      [at.merged_into, at.app_id]
    );
    if (!rows[0]) break;
    at = rows[0];
  }
  return at;
}

// 1 Nov 2026 (one page per thread): whether change `s` is one the viewer
// `viewer` may read, by issue-proposal-ref.js isNavigable's rule: proposed
// work is public, a live chat only its owner's until they share it. A
// request's page reads its changes' replies with this.
//
// #6488: `promoted_at` (set when the change went up for a vote, never
// cleared) keeps that work readable once it is closed or reopened: a
// proposal's discussion was public, and a close or a reopen does not make
// it history only its author may read. Status alone missed both.
const visibleChangeSql = (s, viewer) => `(${s}.status IN ('promoted', 'merging', 'merged')
       OR ${s}.promoted_at IS NOT NULL OR ${s}.shared_at IS NOT NULL OR ${s}.user_id = ${viewer})`;

// #6139: a change not yet up for a vote that has finished building (an SQL
// expression over chat_sessions as `cs`): its checks passed on its current
// head and nothing is working on it. A verdict is about one commit, so an
// imported pull request or a submitted local upload whose head moved, or an
// upload not submitted yet (proposal-handoff.js hasUnsubmittedUpload), is not
// ready. A local upload a web turn built on after reads as not ready too: its
// stored head is the upload's, and the mistake that leaves is the old words.
// A native change has no stored head to compare with (preview/facts.ts pinOf):
// its turn hands a new commit to the preview machine, which makes the verdict
// pending, before the turn ends. No staging_url: a preview that went to sleep
// did not unbuild anything. 'skipped' is not enough either: it can mean there
// is nothing built.
const CHANGE_READY_SQL = `(cs.status IN ('active', 'paused')
       AND cs.check_state = 'passing'
       AND cs.checks_commit_sha IS NOT NULL
       AND (cs.source IS DISTINCT FROM 'imported'
            OR LOWER(cs.imported_pr_head_sha) = LOWER(cs.checks_commit_sha))
       AND (cs.source IS DISTINCT FROM 'cli_handoff'
            OR LOWER(cs.handoff_head_sha) = LOWER(cs.checks_commit_sha))
       AND NOT (cs.handoff_uploaded_sha IS NOT NULL
                AND cs.handoff_uploaded_sha IS DISTINCT FROM cs.handoff_head_sha
                AND cs.checks_commit_sha IS NOT DISTINCT FROM cs.handoff_upload_checked_sha)
       AND NOT ${workedOnSql()})`;

// Everything in a thread, oldest first, with how many people's replies are
// anchored to each. A change is listed by the rule the request page's
// "Addressed by" already uses (issue-proposal-ref.js): proposed work is
// public, a live chat only to its owner until they share it. 1 Nov 2026:
// the request that leads the thread counts its changes' replies too, since
// its page is where they are read.
const ITEMS_SQL = `
SELECT 'request' AS type, r.id::bigint AS id, r.number, r.title, r.state AS status,
       NULL::int AS user_id, NULL::timestamptz AS shared_at, NULL::timestamptz AS promoted_at, r.created_at,
       ((SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = r.number
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)
        + (SELECT COUNT(*) FROM chat_messages m
            JOIN chat_sessions s ON s.id = m.thread_ref AND s.thread_id = m.thread_id
           WHERE m.thread_id = $1 AND m.thread_type = 'session'
             AND r.number = (SELECT lt.number FROM threads lt WHERE lt.id = $1)
             AND s.is_headless = FALSE AND ${visibleChangeSql('s', '$3')}
             AND m.msg_type = 'message' AND m.deleted_at IS NULL))::int AS replies,
       NULL::int AS epoch, NULL::text AS my_vote,
       COALESCE(ru.username, r.author_login) AS author, COALESCE(ru.is_synthetic, FALSE) AS author_bot,
       NULL::text AS reason, NULL::int AS target, NULL::int[] AS closes,
       NULL::int AS built_from_session_id, NULL::int AS built_from_version,
       FALSE AS ready,
       NULL::timestamptz AS live_at,
       NULL::jsonb AS closes_requests, NULL::int AS built_for_user_id,
       NULL::text AS applied_at, NULL::text AS applied_by,
       NULL::text AS withdrawn_at, NULL::text AS superseded_by
  FROM requests r LEFT JOIN users ru ON ru.id = r.created_by
 WHERE r.thread_id = $1
UNION ALL
SELECT 'change', cs.id::bigint, cs.pr_number,
       COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''), NULLIF(cs.session_title, ''), NULLIF(cs.branch_name, '')),
       cs.status, cs.user_id, cs.shared_at, cs.promoted_at, cs.created_at,
       (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'session' AND m.thread_ref = cs.id
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)::int,
       cs.approval_epoch,
       (SELECT v.vote::text FROM pr_votes v
         WHERE v.session_id = cs.id AND v.user_id = $3
           AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch),
       cu.username, COALESCE(cu.is_synthetic, FALSE), NULL::text, NULL::int,
       COALESCE(cs.linked_issues, '{}'::int[]),
       cs.built_from_session_id, cs.built_from_version,
       ${CHANGE_READY_SQL},
       cs.live_at,
       -- #6225: every request it closes, resolved for the Votes card, and
       -- the person a yes would be for: its author, or, for a change
       -- Homeroom bot built, the requester it was built for.
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'number', c.n, 'title', r.title, 'by', COALESCE(ru.username, r.author_login),
                 'filerId', r.created_by, 'builtFor', c.n = cs.created_from_issue_number) ORDER BY c.n), '[]'::jsonb)
          FROM (SELECT DISTINCT unnest(COALESCE(cs.linked_issues, '{}'::int[])) AS n) c
          LEFT JOIN requests r ON r.app_id = cs.app_id AND r.number = c.n
          LEFT JOIN users ru ON ru.id = r.created_by
         WHERE c.n > 0) AS closes_requests,
       CASE WHEN COALESCE(cu.is_synthetic, FALSE)
            THEN (SELECT r2.created_by FROM requests r2
                   WHERE r2.app_id = cs.app_id AND r2.number = cs.created_from_issue_number)
            ELSE cs.user_id END AS built_for_user_id,
       NULL::text AS applied_at, NULL::text AS applied_by,
       NULL::text AS withdrawn_at, NULL::text AS superseded_by
  FROM chat_sessions cs LEFT JOIN users cu ON cu.id = cs.user_id
 WHERE cs.thread_id = $1 AND cs.is_headless = FALSE
   AND (cs.status IN ('active', 'promoted', 'merging', 'merged')
        OR (cs.status = 'paused' AND cs.last_activity_at > NOW() - make_interval(days => $2)))
   -- 1 Nov 2026 (C2): a plan a person posted lives on a planning record with
   -- no branch (request-specs.js): it is the request's plan, never a change.
   AND NOT ${planRecordSql('cs')}
UNION ALL
SELECT CASE WHEN i.kind = 'close_issue' THEN 'close' ELSE 'decision' END, i.id::bigint, NULL::int,
       i.title, i.status, i.created_by, NULL::timestamptz, NULL::timestamptz, i.created_at,
       (SELECT COUNT(*) FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type = 'governance' AND m.thread_ref = i.id
           AND m.msg_type = 'message' AND m.deleted_at IS NULL)::int,
       NULL::int,
       (SELECT CASE iv.vote WHEN 'up' THEN 'yes' WHEN 'down' THEN 'no' END FROM issue_votes iv
         WHERE iv.issue_id = i.id AND iv.user_id = $3),
       iu.username, COALESCE(iu.is_synthetic, FALSE),
       NULLIF(i.payload->>'reason', ''),
       CASE WHEN i.kind = 'close_issue' AND (i.payload->>'issueNumber') ~ '^[0-9]{1,9}$'
            THEN (i.payload->>'issueNumber')::int END,
       NULL::int[], NULL::int, NULL::int, FALSE,
       NULL::timestamptz AS live_at,
       NULL::jsonb AS closes_requests, NULL::int AS built_for_user_id,
       -- #6439: how an ended vote to close ended, off the governance
       -- machine's audit in the payload (applied, refused, withdrawn or
       -- superseded by the request closing another way).
       i.payload->>'appliedAt' AS applied_at,
       i.payload->>'appliedBy' AS applied_by,
       i.payload->>'withdrawnAt' AS withdrawn_at,
       i.payload->>'supersededBy' AS superseded_by
  FROM issues i LEFT JOIN users iu ON iu.id = i.created_by
 WHERE i.thread_id = $1 AND i.kind <> 'general'
 ORDER BY created_at, type, id`;

// The newest few replies anchored to each change and governance row, for
// the fold under its row; nobody the viewer blocked, or who blocked them.
const FOLDED_SQL = `
SELECT f.thread_type, f.thread_ref, f.id, f.content, f.created_at, u.username, u.is_synthetic
  FROM (SELECT m.id, m.thread_type, m.thread_ref, m.content, m.created_at, m.user_id,
               ROW_NUMBER() OVER (PARTITION BY m.thread_type, m.thread_ref ORDER BY m.id DESC) AS k
          FROM chat_messages m
         WHERE m.thread_id = $1 AND m.thread_type IN ('session', 'governance')
           AND m.msg_type = 'message' AND m.deleted_at IS NULL AND m.user_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = $2 AND b.blocked_user_id = m.user_id)
                 OR (b.blocker_id = m.user_id AND b.blocked_user_id = $2))) f
  JOIN users u ON u.id = f.user_id
 WHERE f.k <= $3
 ORDER BY f.id`;

/**
 * #6225: the requests a change closes, as its Votes card lists them: each
 * one's number, title and filer, and whether its requester has agreed to it.
 * A request counts as confirmed when the change was built for it, whoever
 * filed it, or when its filer is the change's author — and for a change
 * Homeroom bot built, the person it was built for counts as its author
 * (`builtForUserId`). `rows` is ITEMS_SQL's `closes_requests`: `filerId`
 * never leaves the server. Ascending, without duplicates. Pure.
 */
function closesRequests(rows, builtForUserId) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const number = Number(row.number);
    if (!Number.isInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    const filerId = row.filerId == null ? null : Number(row.filerId);
    const author = builtForUserId == null ? null : Number(builtForUserId);
    out.push({
      number,
      title: row.title == null ? null : String(row.title),
      by: row.by == null ? null : String(row.by),
      confirmed: row.builtFor === true || (filerId != null && author != null && filerId === author),
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * What a thread page draws: the thread (what leads it, by kind), every item
 * in it the viewer may open, the newest replies folded under each change and
 * governance row, and the viewer's Notify me / Mute standing.
 */
async function threadPage(db, { thread, viewerId = null, owner = null, repo = null }) {
  const { rows } = await db.query(ITEMS_SQL, [thread.id, IN_PROGRESS_PAUSED_WINDOW_DAYS, viewerId || 0]);
  const { rows: folded } = await db.query(FOLDED_SQL, [thread.id, viewerId || 0, FOLDED_REPLIES]);
  const foldOf = new Map();
  for (const f of folded) {
    const key = `${f.thread_type === 'session' ? 'change' : 'governance'}:${f.thread_ref}`;
    if (!foldOf.has(key)) foldOf.set(key, []);
    foldOf.get(key).push({
      id: Number(f.id),
      username: f.username,
      bot: !!f.is_synthetic,
      text: String(f.content || '').slice(0, 280),
      at: f.created_at,
    });
  }
  const items = [];
  for (const row of rows) {
    if (row.type === 'change' && !issueRefs.isNavigable(row, viewerId)) continue;
    const item = {
      type: row.type,
      id: Number(row.id),
      number: row.number == null ? null : Number(row.number),
      title: row.title || null,
      status: row.status,
      at: row.created_at,
      replies: Number(row.replies) || 0,
      // Who made it: the request's asker, the change's builder, the vote's proposer.
      by: row.author || null,
      byBot: !!row.author_bot,
      mine: !!viewerId && row.user_id != null && Number(row.user_id) === Number(viewerId),
    };
    if (row.type === 'change') {
      item.state = issueRefs.stateOf(row.status);
      // When production first ran it (chat_sessions.live_at), the fact the
      // change's own pill reads: null from the merge until the rollout ends.
      item.liveAt = row.live_at ? new Date(row.live_at).toISOString() : null;
      // #6139: still underway, but built: CHANGE_READY_SQL.
      item.ready = row.ready === true;
      item.folded = foldOf.get(`change:${row.id}`) || [];
      // Stage 6: what the ballot casts with, and the viewer's own vote.
      item.epoch = row.epoch == null ? null : Number(row.epoch);
      item.myVote = row.my_vote === 'yes' || row.my_vote === 'no' ? row.my_vote : null;
      // The requests it closes when it merges (its linked_issues): changes
      // compete only where these overlap (closeRivals).
      item.closes = Array.isArray(row.closes) ? row.closes.map(Number).filter((n) => n > 0) : [];
      // #6225: the same list with each request's title and filer, and whether
      // its requester agreed to be closed by this change (votes card).
      item.closesRequests = closesRequests(row.closes_requests, row.built_for_user_id);
      // 1 Nov 2026 (C2.3): the plan it was built from (a person's on the
      // request, or the bot's own its requester approved), which the
      // request's page draws with it (request-head.tsx plansByChange).
      if (row.built_from_session_id != null) {
        item.builtFrom = {
          sessionId: Number(row.built_from_session_id),
          version: row.built_from_version == null ? null : Number(row.built_from_version),
        };
      }
    } else if (row.type === 'close' || row.type === 'decision') {
      item.folded = foldOf.get(`governance:${row.id}`) || [];
      // #6019: what the close vote says, and the viewer's own vote on it.
      item.reason = row.reason || null;
      item.target = row.target == null ? null : Number(row.target);
      item.myVote = row.my_vote === 'yes' || row.my_vote === 'no' ? row.my_vote : null;
      // #6439: an ended vote to close says how it ended, so the request's
      // page keeps its card and reads "Closed by vote", "Kept open" or
      // "Ended: the request closed another way". Null while it is open.
      if (row.type === 'close' && row.status !== 'open') {
        const appliedBy = String(row.applied_by || '');
        item.outcome = row.applied_at && !appliedBy.startsWith('refused:')
          ? 'closed'
          : row.superseded_by
            ? 'elsewhere'
            : 'kept';
      } else {
        item.outcome = null;
      }
    }
    items.push(item);
  }
  // #6420: which of this thread's changes a requester has answered "This
  // doesn't close it" to, so the change's "Also closes" line can say so.
  // One read over the changes this page draws.
  const changeIds = items.filter((i) => i.type === 'change').map((i) => i.id);
  if (changeIds.length) {
    const { rows: disputed } = await db.query(
      `SELECT session_id, request_number FROM change_request_claims
        WHERE session_id = ANY($1::int[]) AND disputed_at IS NOT NULL`,
      [changeIds]
    );
    const byChange = new Map();
    for (const row of disputed) {
      const key = Number(row.session_id);
      if (!byChange.has(key)) byChange.set(key, []);
      byChange.get(key).push(Number(row.request_number));
    }
    for (const item of items) {
      if (item.type === 'change') item.notConfirmed = (byChange.get(item.id) || []).sort((a, b) => a - b);
    }
  }
  const number = thread.number == null ? null : Number(thread.number);
  // #6406: a change whose plan has a newer version on the request says so
  // beside its plan line ("Built from v1 ... v2 is newer"). Read once.
  const builtChanges = items.filter((i) => i.type === 'change' && i.builtFrom);
  if (builtChanges.length && number != null) {
    let newest = null;
    try {
      newest = await require('./request-specs').personPlanOf(db, { appId: thread.app_id, issueNumber: number });
    } catch (err) {
      log.warn('threads', 'Could not read a request\'s newest plan', { appId: thread.app_id, number, err: err.message });
    }
    if (newest) {
      const authorOf = new Map();
      for (const item of builtChanges) {
        const built = item.builtFrom;
        if (Number(newest.sessionId) === Number(built.sessionId) && Number(newest.version) === Number(built.version)) continue;
        const sid = Number(built.sessionId);
        if (!authorOf.has(sid)) {
          try {
            const { rows: [r] = [] } = await db.query('SELECT user_id FROM chat_sessions WHERE id = $1', [sid]);
            authorOf.set(sid, r && r.user_id != null ? Number(r.user_id) : null);
          } catch {
            authorOf.set(sid, null);
          }
        }
        const builtAuthorId = authorOf.get(sid);
        built.newer = {
          version: newest.version,
          author: newest.author || null,
          sameAuthor: builtAuthorId != null && newest.authorId != null && Number(builtAuthorId) === Number(newest.authorId),
        };
      }
    }
  }
  const leadsChange = number != null
    && items.some((i) => i.type === 'change' && i.number === number)
    && !items.some((i) => i.type === 'request' && i.number === number);
  // A change's own thread with no number (session_thread_id) is the
  // change's, not a decision's.
  const lead = number == null
    ? (thread.kind === 'work' && items.some((i) => i.type === 'change') ? 'change' : 'decision')
    : leadsChange ? 'change' : 'request';
  const follow = viewerId
    ? await followState(db, { threadId: thread.id, appId: thread.app_id, userId: viewerId, owner, repo })
    : null;
  const requests = items.filter((i) => i.type === 'request' && i.number != null).map((i) => i.number);
  // #6421: a thread may hold several requests. A merged thread is named by
  // its change's title while a change lives there, else by its first
  // request's (the lead first), and says how many requests it holds. A
  // thread of one request keeps the page's own title and shape, so the two
  // are read only where several were merged.
  let merged = {};
  if (requests.length > 1) {
    const live = items.find((i) => i.type === 'change' && i.state !== 'merged');
    const first = items.find((i) => i.type === 'request' && i.number === number) || items.find((i) => i.type === 'request');
    merged = { requests: requests.length, name: (live && live.title) || (first && first.title) || null };
  }
  return {
    thread: {
      id: Number(thread.id),
      number,
      kind: thread.kind,
      lead,
      title: thread.title || null,
      state: thread.state,
      ...merged,
    },
    items,
    follow,
    elsewhere: await changesElsewhere(db, { thread, numbers: requests, viewerId }),
  };
}

// 1 Nov 2026 (one page per thread, D4): a change for several requests is
// in its first request's thread (session_thread_id) and lives on that
// request's page. The others' pages say where it is: the changes, still in
// play and readable by the viewer, that close one of `numbers` from another
// thread, each with the request whose page it is on.
const ELSEWHERE_SQL = `
SELECT cs.id, cs.pr_number, COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''), NULLIF(cs.session_title, '')) AS title,
       cs.pr_summary_md, cs.user_id AS builder_id, rq.created_by AS requester_id,
       (c.disputed_at IS NOT NULL) AS disputed,
       t.number AS home, n.number AS request
  FROM chat_sessions cs
  JOIN threads t ON t.id = cs.thread_id
  JOIN LATERAL unnest(COALESCE(cs.linked_issues, '{}'::int[])) AS n(number) ON n.number = ANY($3::int[])
  JOIN requests rq ON rq.app_id = cs.app_id AND rq.number = n.number
  LEFT JOIN change_request_claims c ON c.session_id = cs.id AND c.request_number = n.number
 WHERE cs.app_id = $1 AND cs.thread_id <> $2 AND cs.is_headless = FALSE
   AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
   AND ${visibleChangeSql('cs', '$4')}
   AND t.number IS NOT NULL
   AND EXISTS (SELECT 1 FROM requests r WHERE r.thread_id = t.id AND r.number = t.number)
 ORDER BY cs.id, n.number
 LIMIT 20`;

// #6420: the first sentence of the change's plain-language summary, with
// markdown's marks stripped. The card shows it under the title; a blank
// summary leaves the title alone.
function firstSentence(md) {
  const text = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const sentence = text.match(/^.*?[.!?](?:\s|$)/);
  return (sentence ? sentence[0] : text).trim().slice(0, 200);
}

async function changesElsewhere(db, { thread, numbers, viewerId = null }) {
  const wanted = (numbers || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const { rows } = await db.query(ELSEWHERE_SQL, [thread.app_id, thread.id, wanted, viewerId || 0]);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(Number(row.id))) continue;
    seen.add(Number(row.id));
    const requesterId = row.requester_id == null ? null : Number(row.requester_id);
    const builderId = row.builder_id == null ? null : Number(row.builder_id);
    const mine = viewerId != null && requesterId != null && requesterId === Number(viewerId);
    const disputed = row.disputed === true;
    out.push({
      id: Number(row.id),
      number: row.pr_number == null ? null : Number(row.pr_number),
      title: row.title || null,
      summary: firstSentence(row.pr_summary_md),
      on: Number(row.home),
      request: Number(row.request),
      disputed,
      mine,
      // Only the requester is asked, and not when the change is their own:
      // the notice still shows, but there is nothing to answer.
      ask: mine && requesterId !== builderId && !disputed,
    });
  }
  return out;
}

/**
 * 1 Nov 2026 (one page per thread, D2): the request whose page change
 * `sessionId` lives on, or null when it keeps a page of its own. A change
 * is on its request's page when a request leads its thread (the thread's
 * number is a request in it), wherever a merge took that thread. Null too
 * for a change the viewer may not read: its page answers for itself.
 */
async function requestHome(db, { appId, sessionId, viewerId = null }) {
  const id = Number(sessionId);
  if (!appId || !Number.isSafeInteger(id) || id <= 0) return null;
  const { rows } = await db.query(
    `SELECT id, status, user_id, shared_at, promoted_at, thread_id FROM chat_sessions
      WHERE id = $1 AND app_id = $2 AND is_headless = FALSE AND thread_id IS NOT NULL`,
    [id, appId]
  );
  const row = rows[0];
  if (!row || !issueRefs.isNavigable(row, viewerId)) return null;
  const thread = await threadById(db, row.thread_id);
  if (!thread || thread.number == null || Number(thread.app_id) !== Number(appId)) return null;
  const { rows: leads } = await db.query(
    'SELECT 1 FROM requests WHERE thread_id = $1 AND number = $2 LIMIT 1',
    [thread.id, thread.number]
  );
  return leads.length ? { number: Number(thread.number), threadId: Number(thread.id) } : null;
}

// ── Ballots (stage 6) ────────────────────────────────────────────────
//
// Changes RIVAL each other only when they would close the same request:
// their linked_issues (the requests a change closes when it merges) overlap.
// Being in one thread is not enough. A change that is part of a request and
// closes nothing (#5997, "part of #5927"), or closes another request in the
// thread, is never a rival and never on a ballot with the others (found live
// on prod, 29 Oct). A vote to close competes with the changes that close the
// request it was filed on.
//
// Rivals up for a vote are one ballot on the request's page
// (features/dev-board/topic/thread-changes.tsx); underneath each keeps its
// own vote, pinned to its own revision. The first to pass goes live, and the
// merge closes the others ('superseded', reversible like any close,
// session-lifecycle.js archiveSession), each saying why in its discussion.
// Called from the merge's own pass over its requests
// (issue-close-watcher.js closeAfterMerge). Never throws: a rival left open
// is still a proposal anyone can withdraw, and the merge must not wait on it.
async function closeRivals(db, { appId, prNumber, deps = {} }) {
  try {
    const { rows: [won] } = await db.query(
      `SELECT id, thread_id, linked_issues, rebuilt_from_session_id FROM chat_sessions
        WHERE app_id = $1 AND pr_number = $2 AND status = 'merged' AND thread_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [appId, prNumber]
    );
    if (!won) return [];
    const { rows: rivals } = await db.query(
      `SELECT id, status FROM chat_sessions
        WHERE thread_id = $1 AND id <> $2 AND status = 'promoted' AND is_headless = FALSE
          AND COALESCE(linked_issues, '{}'::int[]) && COALESCE($3::int[], '{}'::int[])`,
      [won.thread_id, won.id, won.linked_issues || []]
    );
    const lifecycle = deps.lifecycle || require('./session-lifecycle');
    const ws = deps.ws || require('./ws');
    const closed = [];
    for (const rival of rivals) {
      try {
        const out = await lifecycle.archiveSession({ pool: db, sessionId: Number(rival.id), reason: 'superseded', from: rival.status });
        if (!out.archived) continue;
        closed.push(Number(rival.id));
        await ws.sendSystemMessage(db, appId, `Change #${prNumber} went live first, so this one closes.`,
          'system', null, { type: 'session', ref: Number(rival.id) }).catch(() => {});
      } catch (err) {
        log.warn('threads', 'A rival change could not be closed', { sessionId: Number(rival.id), err: err.message });
      }
    }
    if (closed.length) log.info('threads', 'Closed the rivals of a change that went live', { appId, prNumber, closed });
    // #6389: the change Homeroom bot rebuilt closes when its version goes
    // live, and says why.
    if (won.rebuilt_from_session_id) {
      try {
        const { rows: [original] } = await db.query(
          `SELECT id, status FROM chat_sessions
            WHERE id = $1 AND status IN ('promoted', 'active')`, [Number(won.rebuilt_from_session_id)]);
        if (original) {
          const out = await lifecycle.archiveSession({
            pool: db, sessionId: Number(original.id), reason: 'superseded', from: original.status,
          });
          if (out.archived) {
            closed.push(Number(original.id));
            await ws.sendSystemMessage(db, appId, `Homeroom bot's version, change #${prNumber}, went live, so this one closes.`,
              'system', null, { type: 'session', ref: Number(original.id) }).catch(() => {});
          }
        }
      } catch (err) {
        log.warn('threads', 'The change Homeroom bot rebuilt could not be closed', {
          sessionId: Number(won.rebuilt_from_session_id), err: err.message,
        });
      }
    }
    return closed;
  } catch (err) {
    log.warn('threads', 'Could not look for a merged change\'s rivals', { appId, prNumber, err: err.message });
    return [];
  }
}

/**
 * A vote to close passed and closed `closed` (the request it was filed on
 * and the rest still open in its thread): the changes up for a vote that
 * would have closed one of them lose to it and close (the governance
 * machine's `threads.closeChanges` work). A change that closes none of them
 * stays. Strict, so a failure to read runs the work again; one change that
 * will not close is logged and the rest still are.
 */
async function closeThreadChanges(db, { appId, threadId, closed: numbers = [], closedBy = null, deps = {} }) {
  const wanted = (Array.isArray(numbers) ? numbers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const { rows } = await db.query(
    `SELECT id, status FROM chat_sessions
      WHERE app_id = $1 AND thread_id = $2 AND status = 'promoted' AND is_headless = FALSE
        AND COALESCE(linked_issues, '{}'::int[]) && $3::int[]
      ORDER BY id`,
    [appId, threadId, wanted]
  );
  const lifecycle = deps.lifecycle || require('./session-lifecycle');
  const ws = deps.ws || require('./ws');
  const closed = [];
  for (const row of rows) {
    try {
      const out = await lifecycle.archiveSession({ pool: db, sessionId: Number(row.id), reason: 'superseded', from: row.status });
      if (!out.archived) continue;
      closed.push(Number(row.id));
      const line = closedBy ? `The vote to close #${closedBy} passed, so this change closes.` : 'The vote to close passed, so this change closes.';
      await ws.sendSystemMessage(db, appId, line, 'system', null, { type: 'session', ref: Number(row.id) }).catch(() => {});
    } catch (err) {
      log.warn('threads', 'A change could not be closed after its thread\'s close vote', { sessionId: Number(row.id), err: err.message });
    }
  }
  if (closed.length) log.info('threads', 'Closed the changes of a thread a vote closed', { appId, threadId, closed });
  return closed;
}

module.exports = {
  closeRivals,
  closeThreadChanges,
  closesRequests,
  threadForNumber,
  threadById,
  threadPage,
  requestHome,
  changesElsewhere,
  ELSEWHERE_SQL,
  visibleChangeSql,
  FOLDED_REPLIES,
  FOLLOWERS_SQL,
  threadOfMessage,
  followerIds,
  followState,
  setFollow,
  unmuteOnPost,
  MARKER_KEY,
  MESSAGE_BATCH,
  SESSION_BATCH,
  attachRequests,
  attachIssues,
  attachSessions,
  attachMessages,
  backfill,
  STATE_MARKER_KEY,
  refreshStates,
  NUMBERS_MARKER_KEY,
  separateNumberCollisions,
};
