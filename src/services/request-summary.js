'use strict';

// The summary at the top of a request's page.
//
// A request's card (frontend/src/features/dev-board/topic/request-head.tsx)
// shows the asker's own words until there is more to say than they said: a
// plan the group can read, or one or more changes built for it. From then on
// Homeroom bot writes a short summary of the thread (who asked for what, and
// where it has got to), the card shows that, and the asker's words are one
// press away, on the timeline's first step.
//
// It is written when the page is read, never on a timer: `forRequest`
// gathers what the summary is written from, names it with a hash, and
// compares that with the stored row (request_summaries). A match is
// returned as it is. Anything else starts one write in the background and
// returns what the row already held, so the read never waits on a model.
// One writer holds the row at a time, on any process (`generating_until`);
// a write that failed is not tried again for RETRY_MS.
//
// While a write is under way the read says so (`writing`), and the page
// holds a spinner where the summary will be rather than the asker's whole
// words (request-head.tsx). The write's end, written or failed, is announced
// on the socket (`request_summary`, ws.pushRequestSummary), and the request
// open on any page re-reads its row then (app.js), so the words arrive as
// soon as they exist instead of on whatever read comes next. The model call
// has a waited-on helper's time limit (llm.js HELPER_TIME_LIMIT_MS), so it
// is a few seconds.
//
// What it is written from is only what every member of the project can
// already read: the request's title and words, the newest plan SHARED with
// the group, and each change that is up for a vote or merged, by its title
// and its own summary. A private thread, a draft plan or a change still in
// somebody's workspace never reaches the model.
//
// Cost: one helper-model call (llm.js generateRequestSummary) each time a
// request that is being read gains a plan or a change, or one of them
// changes. A request nobody opens costs nothing.

const crypto = require('crypto');
const log = require('./logger');

const CLAIM_LEASE_MS = 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const BODY_CHARS = 4000;
const PLAN_CHARS = 5000;
const CHANGE_CHARS = 1200;
// The changes query asks for one more than this; keep its LIMIT in step.
const MAX_CHANGES = 4;

const clip = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Pure: what the summary draws on, for the line under it; null when the asker's words are all there is. */
function basisOf({ plan, changes }) {
  const n = Array.isArray(changes) ? changes.length : 0;
  if (n > 1) return 'changes';
  if (n === 1) return 'change';
  return plan ? 'plan' : null;
}

/** Pure: the name of what a summary was written from. Any change to it means the summary is written again. */
function inputKey({ title, body, asker, plan, changes }) {
  const parts = [
    'v1',
    String(title || ''),
    String(body || ''),
    String(asker || ''),
    String(plan || ''),
    ...(changes || []).map((c) => `${c.id}:${c.title || ''}:${c.summary || ''}:${c.merged ? 'merged' : 'open'}`),
  ];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Pure: the labelled text the model is given. */
function promptInput({ title, body, asker, plan, changes }) {
  const lines = [
    `ASKED BY: ${clip(asker || 'a member', 80)}`,
    `REQUEST TITLE: ${clip(title, 300)}`,
    'REQUEST, AS WRITTEN:',
    clip(body, BODY_CHARS) || '(no words beyond the title)',
  ];
  if (plan) lines.push('', 'THE PLAN POSTED FOR IT:', clip(plan, PLAN_CHARS));
  const list = (changes || []).slice(0, MAX_CHANGES);
  if (!list.length) lines.push('', 'CHANGES BUILT FOR IT: none yet.');
  list.forEach((c, i) => {
    lines.push('', `CHANGE ${list.length > 1 ? String.fromCharCode(65 + i) : ''}${c.merged ? ' (merged)' : ' (up for a vote)'}, by ${clip(c.by || 'a member', 80)}: ${clip(c.title, 300)}`);
    lines.push(clip(c.summary, CHANGE_CHARS) || '(it has no summary of its own)');
  });
  return lines.join('\n');
}

// The newest plan shared with the group for this request, as text; null when
// there is none. A plan's record is request-specs.js planRecordSql, written
// out here so the query is one the SQL check can read whole.
async function sharedPlan(pool, appId, number) {
  const { rows } = await pool.query(
    `SELECT s.content
       FROM chat_session_specs s
       JOIN chat_sessions cs ON cs.id = s.session_id
      WHERE cs.app_id = $1 AND cs.created_from_issue_number = $2
        AND cs.source IS NOT DISTINCT FROM 'request_spec' AND cs.branch_name IS NULL
        AND s.shared_to_group_at IS NOT NULL
      ORDER BY s.shared_to_group_at DESC, s.version DESC
      LIMIT 1`,
    [appId, number]
  );
  const content = rows[0] && typeof rows[0].content === 'string' ? rows[0].content.trim() : '';
  return content || null;
}

/** The changes built for this request that the group can see: up for a vote, merging or merged; oldest first. */
async function visibleChanges(pool, appId, number) {
  const { rows } = await pool.query(
    `SELECT cs.id, cs.pr_title, cs.pr_summary_md, cs.status, u.username
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND $2::int = ANY(cs.linked_issues)
        AND cs.is_headless = FALSE
        AND cs.status IN ('promoted', 'merging', 'merged')
      ORDER BY COALESCE(cs.promoted_at, cs.created_at) ASC, cs.id ASC
      LIMIT 5`,
    [appId, number]
  );
  return rows.slice(0, MAX_CHANGES).map((r) => ({
    id: Number(r.id),
    title: r.pr_title || '',
    summary: r.pr_summary_md || '',
    by: r.username || null,
    merged: r.status === 'merged',
  }));
}

// `writing`: a writer holds the row now, on this process or another. Read
// off the database's clock, as `claim` sets the hold.
async function readRow(pool, appId, number) {
  const { rows } = await pool.query(
    `SELECT input_key, summary, basis, failed_at, generating_until,
            (generating_until IS NOT NULL AND generating_until > NOW()) AS writing
       FROM request_summaries WHERE app_id = $1 AND issue_number = $2`,
    [appId, number]
  );
  return rows[0] || null;
}

// One writer for this request and these inputs, on any process. The row's
// earlier summary stays in place while the new one is written, and keeps the
// key it was written from: a write that fails leaves the row naming its old
// inputs, so the next read past the hold tries again.
async function claim(pool, appId, number, key) {
  const { rows } = await pool.query(
    `INSERT INTO request_summaries (app_id, issue_number, input_key, generating_until, updated_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4::double precision / 1000), NOW())
     ON CONFLICT (app_id, issue_number) DO UPDATE SET
       generating_until = EXCLUDED.generating_until, updated_at = NOW()
     WHERE (request_summaries.generating_until IS NULL OR request_summaries.generating_until < NOW())
       AND NOT (request_summaries.input_key = $3 AND request_summaries.summary IS NOT NULL)
       AND NOT (request_summaries.failed_at IS NOT NULL
                AND request_summaries.failed_at > NOW() - make_interval(secs => $5::double precision / 1000))
     RETURNING generating_until`,
    [appId, number, key, CLAIM_LEASE_MS, RETRY_MS]
  );
  return rows.length > 0;
}

async function write(pool, appId, number, { key, summary = null, basis = null, model = null, failed = false }) {
  await pool.query(
    `UPDATE request_summaries SET
       input_key = CASE WHEN $7::boolean THEN input_key ELSE $3 END,
       summary = CASE WHEN $7::boolean THEN summary ELSE $4 END,
       basis = CASE WHEN $7::boolean THEN basis ELSE $5 END,
       model = CASE WHEN $7::boolean THEN model ELSE $6 END,
       failed_at = CASE WHEN $7::boolean THEN NOW() END,
       generating_until = NULL,
       updated_at = NOW()
     WHERE app_id = $1 AND issue_number = $2`,
    [appId, number, key, summary, basis, model ? String(model).slice(0, 64) : null, !!failed]
  );
}

function llm() {
  return require('./llm');
}

// The write ended, with words or without: a page waiting on it reads again.
// Only the project and the request's number travel, to whoever may view the
// project; the words are read through the request's own route.
function announce(appId, slug, number, deps = {}) {
  if (!slug) return;
  try {
    const push = deps.announce || ((data) => require('./ws').pushRequestSummary(data));
    push({ appId, appSlug: slug, issueNumber: Number(number) });
  } catch (err) {
    log.warn('request-summary', 'Request summary was not announced', { appId, number, err: err.message });
  }
}

async function generate(pool, appId, slug, number, inputs, key, basis, deps = {}) {
  const ask = deps.generate || ((args) => llm().generateRequestSummary(args));
  try {
    const out = await ask({
      input: promptInput(inputs),
      telemetryContext: { component: 'request_summary', appId },
    });
    await write(pool, appId, number, { key, summary: out.summary, basis, model: out.model });
  } catch (err) {
    log.warn('request-summary', 'Request summary was not written', { appId, number, err: err.message });
    await write(pool, appId, number, { key, failed: true }).catch(() => {});
  }
  announce(appId, slug, number, deps);
}

/**
 * The summary a request's page shows: `{ text, basis }`, or null when the
 * asker's own words are all there is, or nothing is written and nothing is
 * being written. While a write is under way it is
 * `{ text, basis, writing: true }`, `text` being the summary the row held
 * before (null for a first one): the page waits for the new words then.
 * Never throws and never waits on a model: a read that fails is a page
 * without a summary. `issue` is the request as the route read it (title,
 * body); `asker` its asker's username; `slug` the project's, which the
 * write's announcement names.
 *
 * `deps.generate`, `deps.enabled` and `deps.announce` are for tests;
 * `deps.wait` makes the call wait for the write it started.
 */
async function forRequest(pool, { appId, slug = null, number, issue, asker = null }, deps = {}) {
  try {
    if (!pool || !appId || !(Number(number) > 0) || !issue) return null;
    const [plan, changes] = await Promise.all([
      sharedPlan(pool, appId, number),
      visibleChanges(pool, appId, number),
    ]);
    const basis = basisOf({ plan, changes });
    if (!basis) return null;
    const inputs = { title: issue.title || '', body: issue.body || '', asker, plan, changes };
    const key = inputKey(inputs);
    const row = await readRow(pool, appId, number);
    const shown = row && row.summary ? { text: row.summary, basis: row.basis || basis } : null;
    if (row && row.input_key === key && row.summary) return shown;
    const enabled = deps.enabled != null ? deps.enabled : llm().isEnabled();
    let writing = !!(row && row.writing);
    if (enabled && await claim(pool, appId, number, key)) {
      const work = generate(pool, appId, slug, number, inputs, key, basis, deps);
      if (deps.wait) {
        await work;
        const fresh = await readRow(pool, appId, number);
        return fresh && fresh.summary ? { text: fresh.summary, basis: fresh.basis || basis } : shown;
      }
      work.catch(() => {});
      writing = true;
    }
    // This read's write or another reader's: the page holds its place for
    // the words, and the write's announcement brings them.
    if (writing) return { text: shown ? shown.text : null, basis: shown ? shown.basis : basis, writing: true };
    return shown;
  } catch (err) {
    log.warn('request-summary', 'Request summary read failed', { appId, number, err: err.message });
    return null;
  }
}

module.exports = {
  forRequest, basisOf, inputKey, promptInput, sharedPlan, visibleChanges,
  CLAIM_LEASE_MS, RETRY_MS, MAX_CHANGES,
};
