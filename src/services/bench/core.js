'use strict';

// #3654 Core v1: the DEFAULT benchmark suite, materialized from a checked-in
// definition (suites/core-v1.json) so an admin only picks "Core v1" and
// presses Run.
//
// The definition lists tasks by stable references, never by private text:
// a stage, an app's slug, a request (or pull request, or proposal) number,
// the moment the original run read it (`as_of`), the run's id when known,
// and tags to slice by. Two kinds need more:
//
//   synthetic  the four adversarial triage tasks are authored, inline, with
//              an authored reference (reference_source 'authored');
//   dynamic    a rule rather than ids nobody could see when it was written:
//              "merged_bot_proposals, limit 10" (the bot's own merged
//              proposals on small apps, one per app, falling back to
//              successful shadow builds whose request is closed now) and
//              "bot_followups, limit 3". Resolved at materialize time.
//
// Materializing (materialize below) is idempotent and never fatal:
//
//   * keyed by the definition's key and version (bench_materializations);
//     once `done` it is a no-op, unless an admin asks to retry, which only
//     tries the tasks that are still missing (each task is keyed by its ref,
//     stored as tags.core_ref), and re-reads the build tasks' expected files
//     and hidden checks from their pull requests' own diffs
//     (suites.refreshPrReferences; never on a frozen suite). A task imported
//     before that fix is also repaired by the next pass that is otherwise a
//     no-op (the boot pass after a deploy), once;
//   * each task resolves to a snapshot: the one its run recorded when there
//     is one, otherwise rebuilt as of `as_of` (services/bench/backfill.js),
//     or, for a build, imported from its merged pull request
//     (suites.importTaskFromPr);
//   * a task that cannot be resolved (the app is gone, the request deleted,
//     the pull request missing, nobody answered the question) is recorded as
//     SKIPPED with its reason in the row's summary, never thrown;
//   * except a DM spec that opts in with "scripted_answer": "if_unanswered":
//     when its requester is known but never answered the bot's question, it
//     becomes a PENDING SCRIPTED task instead (see resolveDm), whose answer
//     the labelling session writes (grading.labelTask's dmAnswer);
//   * GitHub is read only, through the benchmark's guardedGithub, one task at
//     a time with a pause between tasks (rateMs).
//
// The suite is created unfrozen, so its tasks can be labelled (an Opus
// session through the connector, label_bench_task, or an admin); it freezes
// only when an admin presses Freeze, and suites.freezeSuite refuses while any
// task has no reference. Freezing is never automatic.
//
// On boot: the leader materializes it in the background, on production and
// on staging alike, only when GitHub is configured (staging's own "Staging
// demo" suite is untouched either way). BENCH_CORE_MATERIALIZE=off turns
// the boot pass off.

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const suites = require('./suites');
const backfill = require('./backfill');

const DEFINITION_FILE = path.join(__dirname, 'suites', 'core-v1.json');
const RULES = Object.freeze({
  merged_bot_proposals: { stage: 'build', fallbacks: ['shadow_builds_closed_issue'] },
  bot_followups: { stage: 'followup', fallbacks: [] },
});
const VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty']);
// What a DM spec may say about an answer nobody gave: script it when the
// requester never answered (the only value so far).
const SCRIPTED_ANSWER = Object.freeze(['if_unanswered']);
// How much of what happened on a request after the bot's question a pending
// scripted DM task keeps, for whoever writes the answer.
const LATER_ENTRIES = 8;
const LATER_ENTRY_CHARS = 600;
// What a definition must add up to, per stage (static tasks plus dynamic
// limits): the first version's shape (suites.TARGETS) with some room.
const STAGE_RANGES = Object.freeze({
  triage: [40, 50],
  build: [15, 25],
  followups: [3, 8], // followup + checks_fix
  dm: [3, 8],
});
const BOOT_DELAY_MS = 90 * 1000;
const DEFAULT_RATE_MS = 1000;
// A pass beats at least this often while it works (see beat()); a running
// row whose last beat is older than STALE_RUNNING_MINUTES was left by a
// process that died mid-pass (a redeploy), so it may be claimed again.
const HEARTBEAT_MS = 30 * 1000;
const STALE_RUNNING_MINUTES = 10;
const MAX_CANDIDATES = 500;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA_RE = /^[0-9a-f]{40}$/;

let inProcess = null;

function loadDefinition(file = DEFINITION_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function posInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Whether a definition is well formed. Pure. Every task has a stage, an
 * app, and either a request at a moment (issue_number + as_of), a merged
 * pull request, a proposal, or inline text with an authored reference; no
 * ref or task identity appears twice; and the counts per stage are inside
 * STAGE_RANGES. Resolves { ok, errors, counts }.
 */
function validateDefinition(def) {
  const errors = [];
  const counts = { triage: 0, build: 0, followup: 0, checks_fix: 0, dm: 0, spec: 0 };
  if (!def || typeof def !== 'object') return { ok: false, errors: ['not an object'], counts };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(def.key || ''))) errors.push('key must be a short lower-case slug');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(String(def.name || ''))) errors.push('name is not a valid suite name');
  if (!posInt(def.version)) errors.push('version must be a positive integer');
  if (!suites.SUITE_KINDS.includes(def.kind)) errors.push('kind must be frozen or rotating');
  if (!Array.isArray(def.tasks)) errors.push('tasks must be a list');
  const refs = new Set();
  const identities = new Set();
  for (const [i, t] of (def.tasks || []).entries()) {
    const at = `task ${i} (${t?.ref || 'no ref'})`;
    if (!t || typeof t !== 'object') { errors.push(`${at}: not an object`); continue; }
    if (typeof t.ref !== 'string' || !t.ref) errors.push(`${at}: no ref`);
    else if (refs.has(t.ref)) errors.push(`${at}: duplicate ref`);
    else refs.add(t.ref);
    if (!suites.TASK_STAGES.includes(t.stage)) { errors.push(`${at}: unknown stage`); continue; }
    if (typeof t.app_slug !== 'string' || !t.app_slug) errors.push(`${at}: no app_slug`);
    if (t.as_of != null && (!ISO_RE.test(t.as_of) || Number.isNaN(Date.parse(t.as_of)))) errors.push(`${at}: as_of is not an ISO timestamp`);
    if (t.source_run_id != null && !posInt(t.source_run_id)) errors.push(`${at}: source_run_id must be a positive integer`);
    if (t.tags != null && (typeof t.tags !== 'object' || Array.isArray(t.tags))) errors.push(`${at}: tags must be an object`);
    if (t.tags?.platform != null && typeof t.tags.platform !== 'boolean') errors.push(`${at}: tags.platform must be true or false`);
    if (t.base_sha != null && !SHA_RE.test(t.base_sha)) errors.push(`${at}: base_sha must be a full commit sha`);
    if (t.reference != null && t.reference_source !== 'authored') errors.push(`${at}: an inline reference is reference_source "authored"`);
    if (t.scripted_answer !== undefined) {
      if (t.stage !== 'dm') errors.push(`${at}: only a DM task can have a scripted_answer`);
      else if (!SCRIPTED_ANSWER.includes(t.scripted_answer)) errors.push(`${at}: scripted_answer must be ${SCRIPTED_ANSWER.join(' or ')}`);
    }
    let identity = null;
    if (t.stage === 'triage' || t.stage === 'dm') {
      if (!posInt(t.issue_number)) errors.push(`${at}: no issue_number`);
      if (!t.as_of) errors.push(`${at}: no as_of`);
      if (t.synthetic) {
        if (t.stage !== 'triage') errors.push(`${at}: only a triage task can be synthetic`);
        if (typeof t.synthetic.title !== 'string' || !t.synthetic.title || typeof t.synthetic.body !== 'string') errors.push(`${at}: synthetic needs title and body`);
        if (!VERDICTS.includes(t.reference?.verdict)) errors.push(`${at}: a synthetic task needs its authored reference verdict`);
      }
      identity = `${t.stage}|${t.app_slug}|${t.issue_number}`;
    } else if (t.stage === 'build') {
      if (!posInt(t.pr_number)) errors.push(`${at}: a build task needs its merged pr_number`);
      if (t.request_from === 'pr_body') { if (t.issue_number != null) errors.push(`${at}: a pr_body task has no issue_number`); } else if (!posInt(t.issue_number)) errors.push(`${at}: no issue_number`);
      identity = `build|${t.app_slug}|pr${t.pr_number}`;
    } else if (t.stage === 'checks_fix') {
      if (!posInt(t.proposal_session_id)) errors.push(`${at}: a checks_fix task needs its proposal_session_id`);
      identity = `checks_fix|${t.proposal_session_id}`;
    } else if (t.stage === 'followup') {
      if (!posInt(t.source_run_id)) errors.push(`${at}: a followup task needs its source_run_id`);
      identity = `followup|${t.source_run_id}`;
    } else {
      errors.push(`${at}: stage ${t.stage} is not materialized from a definition`);
    }
    if (identity) {
      if (identities.has(identity)) errors.push(`${at}: the same task twice (${identity})`);
      identities.add(identity);
    }
    counts[t.stage] += 1;
  }
  for (const [i, r] of (def.dynamic || []).entries()) {
    const at = `dynamic ${i} (${r?.ref || 'no ref'})`;
    const rule = RULES[r?.rule];
    if (!rule) { errors.push(`${at}: unknown rule`); continue; }
    if (typeof r.ref !== 'string' || !r.ref || refs.has(r.ref)) errors.push(`${at}: no ref, or a duplicate one`);
    refs.add(r.ref);
    if (r.stage !== rule.stage) errors.push(`${at}: rule ${r.rule} makes ${rule.stage} tasks`);
    if (!posInt(r.limit) || r.limit > 20) errors.push(`${at}: limit must be 1 to 20`);
    if (r.fallback != null && !rule.fallbacks.includes(r.fallback)) errors.push(`${at}: unknown fallback`);
    if (posInt(r.limit)) counts[rule.stage] += r.limit;
  }
  const inRange = (n, [lo, hi]) => n >= lo && n <= hi;
  if (!inRange(counts.triage, STAGE_RANGES.triage)) errors.push(`triage has ${counts.triage} tasks; expected ${STAGE_RANGES.triage.join(' to ')}`);
  if (!inRange(counts.build, STAGE_RANGES.build)) errors.push(`build has ${counts.build} tasks; expected ${STAGE_RANGES.build.join(' to ')}`);
  if (!inRange(counts.followup + counts.checks_fix, STAGE_RANGES.followups)) errors.push(`follow-ups and check fixes have ${counts.followup + counts.checks_fix}; expected ${STAGE_RANGES.followups.join(' to ')}`);
  if (!inRange(counts.dm, STAGE_RANGES.dm)) errors.push(`dm has ${counts.dm} tasks; expected ${STAGE_RANGES.dm.join(' to ')}`);
  return { ok: !errors.length, errors, counts };
}

/**
 * The first `limit` rows on distinct apps, in the order given, leaving out
 * apps in `exclude`. Pure: the dynamic rules' selection, deterministic for
 * the rows a query returned (newest first).
 */
function pickDistinctApps(rows, limit, { exclude = [] } = {}) {
  const seen = new Set(exclude);
  const out = [];
  for (const r of rows || []) {
    if (out.length >= limit) break;
    if (seen.has(r.app_id)) continue;
    seen.add(r.app_id);
    out.push(r);
  }
  return out;
}

// ── The dynamic rules' candidates ───────────────────────────────────────

async function mergedBotProposals(pool) {
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.app_id, r.issue_number, r.created_at, a.slug AS app_slug, a.repo_url,
            ps.pr_number, ps.id AS proposal_session_id
       FROM homeroom_bot_runs r
       JOIN chat_sessions ps ON ps.id = r.proposal_session_id
       JOIN apps a ON a.id = r.app_id
      WHERE ps.status = 'merged' AND ps.pr_number IS NOT NULL AND r.verdict = 'ready'
      ORDER BY r.id DESC
      LIMIT ${MAX_CANDIDATES}`,
  );
  return rows;
}

async function shadowBuilds(pool) {
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.app_id, r.issue_number, r.created_at, r.build_at, r.build_note,
            a.slug AS app_slug, a.repo_url,
            (SELECT sn.id FROM homeroom_bot_run_snapshots sn WHERE sn.run_id = r.id AND sn.stage = 'build') AS snapshot_id
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
      WHERE r.build_ok IS TRUE AND r.proposal_session_id IS NULL
      ORDER BY r.id DESC
      LIMIT ${MAX_CANDIDATES}`,
  );
  return rows;
}

async function botFollowups(pool) {
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.app_id, r.issue_number, r.verdict, r.created_at, a.slug AS app_slug, a.repo_url,
            (SELECT sn.id FROM homeroom_bot_run_snapshots sn WHERE sn.run_id = r.id AND sn.stage = 'followup') AS snapshot_id
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id IS NOT NULL AND r.checks_head_sha IS NULL
        AND r.verdict IN ('answer', 'revise', 'question')
      ORDER BY r.id DESC
      LIMIT ${MAX_CANDIDATES}`,
  );
  return rows;
}

// ── Materializing ────────────────────────────────────────────────────────

function sleep(msec) {
  return msec > 0 ? new Promise((resolve) => { const t = setTimeout(resolve, msec); if (t.unref) t.unref(); }) : Promise.resolve();
}

/** Record that this pass is still alive, at most every HEARTBEAT_MS. Never throws. */
async function beat(ctx) {
  const now = Date.now();
  if (!ctx.definition || now - (ctx.lastBeat || 0) < HEARTBEAT_MS) return;
  ctx.lastBeat = now;
  await ctx.pool.query(
    `UPDATE bench_materializations SET heartbeat_at = NOW()
      WHERE definition = $1 AND version = $2 AND status = 'running'`,
    [ctx.definition.key, ctx.definition.version],
  ).catch(() => {});
}

function skipped(reason, transient = false) {
  return { ok: false, reason, transient };
}

async function appBySlug(pool, slug) {
  const { rows } = await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE slug = $1', [String(slug)]);
  return rows[0] || null;
}

async function hasRef(pool, suiteId, ref) {
  const { rows } = await pool.query(
    "SELECT 1 FROM bench_tasks WHERE suite_id = $1 AND tags->>'core_ref' = $2 LIMIT 1", [suiteId, ref],
  );
  return rows.length > 0;
}

/** The run a task names, when it is still there and is the same request. */
async function sourceRun(pool, spec, app) {
  if (!spec.source_run_id) return null;
  const { rows } = await pool.query(
    `SELECT id, app_id, issue_number, verdict, label_verdict, created_at,
            question, question_default, missing_fact, question_answers, plan
       FROM homeroom_bot_runs WHERE id = $1 AND app_id = $2 AND issue_number = $3`,
    [spec.source_run_id, app.id, spec.issue_number],
  );
  return rows[0] || null;
}

async function recordedSnapshotId(pool, runId, stage) {
  if (!runId) return null;
  const { rows } = await pool.query(
    'SELECT id FROM homeroom_bot_run_snapshots WHERE run_id = $1 AND stage = $2', [runId, stage],
  );
  return rows[0]?.id || null;
}

async function firstVersionOf(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    'SELECT first_version FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2', [appId, issueNumber],
  );
  return !!rows[0]?.first_version;
}

function baseTags(ctx, spec, app, extra = {}) {
  const bot = require('../homeroom-bot');
  const platform = typeof spec.tags?.platform === 'boolean' ? spec.tags.platform : bot.isPlatformRepo(app, ctx.config);
  return {
    ...(spec.tags || {}),
    platform,
    app_slug: app.slug,
    repo_size: platform ? 'large' : 'small',
    difficulty: null,
    known_outcome: null,
    core_ref: spec.ref,
    core_definition: `${ctx.definition.key}@${ctx.definition.version}`,
    ...extra,
  };
}

/** A triage snapshot for a spec: the one its run recorded, else rebuilt as of as_of. */
async function triageSnapshot(ctx, spec, app, repo, run) {
  const { pool, github } = ctx;
  const recorded = await recordedSnapshotId(pool, run?.id, 'triage');
  if (recorded) {
    const snap = await require('../homeroom-bot-snapshots').readSnapshot(pool, recorded);
    return { ok: true, snapshotId: recorded, origin: 'recorded', issue: snap?.thread?.issue || {}, promptChars: snap?.texts?.prompt?.length || null, github: false };
  }
  const out = await backfill.backfillTriage(pool, {
    app, repo, issueNumber: spec.issue_number, asOf: spec.as_of, github,
    synthetic: spec.synthetic || null,
    firstVersion: spec.synthetic ? false : await firstVersionOf(pool, app.id, spec.issue_number),
    extra: { ref: spec.ref, sourceRunId: run?.id || null },
    deps: ctx.deps,
  });
  if (!out.ok) return out;
  return { ok: true, snapshotId: out.snapshotId, origin: 'backfilled', issue: out.issue, promptChars: null, github: true, meta: out.meta };
}

async function promptChars(pool, snapshotId) {
  const snap = await require('../homeroom-bot-snapshots').readSnapshot(pool, snapshotId);
  return snap?.texts?.prompt?.length || snap?.texts?.seed?.length || null;
}

async function resolveTriage(ctx, spec, app, repo) {
  const run = spec.synthetic ? null : await sourceRun(ctx.pool, spec, app);
  const snap = await triageSnapshot(ctx, spec, app, repo, run);
  if (!snap.ok) return snap;
  const tags = baseTags(ctx, spec, app, {
    verdict: spec.tags?.verdict_bot || (spec.synthetic ? 'adversarial' : 'unknown'),
    request_type: spec.tags?.request_type || suites.requestType(snap.issue?.title, snap.issue?.body),
    prompt_chars: snap.promptChars || await promptChars(ctx.pool, snap.snapshotId),
    snapshot_origin: snap.origin,
    ...(snap.meta?.bodyEditedAfter ? { body_edited_after: true } : {}),
  });
  let reference = {};
  let source = null;
  if (spec.synthetic) {
    reference = spec.reference;
    source = 'authored';
  } else if (run?.label_verdict && VERDICTS.includes(run.label_verdict)) {
    // A labeller already said what was right on this run.
    reference = { verdict: run.label_verdict };
    source = 'human';
  }
  const task = await suites.insertTask(ctx.pool, {
    suiteId: ctx.suite.id, stage: 'triage', sourceRunId: run?.id || null, snapshotId: snap.snapshotId,
    appId: app.id, issueNumber: spec.issue_number, tags, reference, referenceSource: source,
  });
  return { ok: true, task, github: snap.origin === 'backfilled' };
}

/**
 * Who filed a request, by every record the platform keeps of it. A request
 * filed through Homeroom is authored on GitHub by the bot account, so the
 * GitHub author alone names nobody: the bot's own requester row (DM era),
 * the platform's issues row and feedback report (who pressed submit), and
 * the body's "**Source:** Homeroom user (name)" line (routes/issues.js
 * creatorFromSourceLine, the same fallback issue edits use) each name the
 * person. A bare "Homeroom admin" with no name names nobody.
 */
async function requesterNames(pool, app, repo, issueNumber, body) {
  const { rows } = await pool.query(
    `SELECT u.username FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2
     UNION
     SELECT u.username FROM issues i JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1 AND i.github_issue_number = $2
     UNION
     SELECT u.username FROM feedback_reports f JOIN users u ON u.id = f.user_id
      WHERE f.issue_owner = $3 AND f.issue_repo = $4 AND f.issue_number = $2`,
    [app.id, issueNumber, repo?.owner || null, repo?.repo || null],
  );
  const names = rows.map((r) => r.username).filter(Boolean);
  const fromSource = require('../../routes/issues').creatorFromSourceLine(body);
  if (fromSource && fromSource !== 'admin') names.push(fromSource);
  return [...new Set(names)];
}

/**
 * The requester's real answer to a question run: their DM answer, else their
 * next reply on the request. A requester who is known but never answered is
 * a skip marked `unanswered`, carrying what was read of the request after the
 * question (`later`), for a spec that scripts the answer instead.
 */
async function trueAnswer(ctx, spec, app, repo, run) {
  const { pool, github } = ctx;
  if (run) {
    const { rows } = await pool.query(
      `SELECT m.content FROM homeroom_bot_dm_messages d
         JOIN conversation_messages m ON m.id = d.answer_message_id
        WHERE d.run_id = $1 AND d.answered_at IS NOT NULL
        ORDER BY d.answered_at LIMIT 1`,
      [run.id],
    );
    if (rows[0]?.content) return { ok: true, text: String(rows[0].content).slice(0, 2000), source: 'dm' };
  }
  const read = await backfill.readIssue(github, repo, spec.issue_number);
  if (!read.ok) return read;
  const names = await requesterNames(pool, app, repo, spec.issue_number, read.issue.body);
  const botLogin = await require('../homeroom-bot-live').botUsernameOf(github);
  const author = read.issue.user || null;
  if (author && (!botLogin || author.toLowerCase().replace(/\[bot\]$/, '') !== botLogin.toLowerCase().replace(/\[bot\]$/, ''))) names.push(author);
  if (!names.some(Boolean)) return skipped('the requester is not known, so their answer cannot be told from anyone else\'s');
  const thread = await backfill.threadMessagesAfter(pool, app.id, spec.issue_number, spec.as_of);
  const reply = backfill.nextReplyAfter({ comments: read.comments, threadMessages: thread, after: spec.as_of, requester: names });
  if (!reply) {
    return {
      ...skipped('the requester never answered the question (no DM answer, and no reply of theirs on the request after it)'),
      unanswered: true,
      later: { issue: read.issue, comments: read.comments, thread },
    };
  }
  return { ok: true, text: reply.text, source: reply.source };
}

/** The question a run asked, as far as the run recorded it; null when it recorded none. */
function askedQuestion(run) {
  if (!run) return null;
  const q = {};
  if (run.question) q.text = String(run.question).slice(0, 2000);
  if (run.question_default) q.default = String(run.question_default).slice(0, 1000);
  if (run.missing_fact) q.missing_fact = String(run.missing_fact).slice(0, 1000);
  if (Array.isArray(run.question_answers) && run.question_answers.length) {
    q.answers = run.question_answers.filter((a) => typeof a === 'string').map((a) => a.slice(0, 200)).slice(0, 6);
  }
  // B6: a read can ask a second question with the first.
  const second = Array.isArray(run.plan?.questions) ? run.plan.questions[1] : null;
  if (second && typeof second.question === 'string') {
    q.second = {
      text: second.question.slice(0, 300),
      answers: (Array.isArray(second.answers) ? second.answers : []).filter((a) => typeof a === 'string').map((a) => a.slice(0, 200)).slice(0, 4),
    };
  }
  return q.text || q.missing_fact ? q : null;
}

/**
 * What happened on a request after the bot's question, for whoever scripts
 * the requester's answer: the request's state now, the first few comments and
 * thread messages after as_of (anyone's but the requester's, who wrote none),
 * and the proposals that merged for it. Never shown to a grader.
 */
async function laterOnRequest(pool, app, spec, { issue, comments = [], thread = [] }) {
  const cutoff = Date.parse(spec.as_of);
  const entries = [
    ...comments.map((c) => ({ ...c, where: 'github' })),
    ...thread.map((m) => ({ ...m, where: 'thread' })),
  ]
    .filter((e) => Date.parse(e.createdAt) > cutoff && String(e.body || '').trim())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, LATER_ENTRIES)
    .map((e) => ({ author: e.author || 'unknown', at: e.createdAt, where: e.where, body: String(e.body).trim().slice(0, LATER_ENTRY_CHARS) }));
  const { rows } = await pool.query(
    `SELECT pr_number, pr_title FROM chat_sessions
      WHERE app_id = $1 AND $2 = ANY(linked_issues) AND status = 'merged' AND pr_number IS NOT NULL
      ORDER BY id LIMIT 3`,
    [app.id, spec.issue_number],
  );
  return {
    request_state: issue?.state || null,
    comments: entries,
    merged: rows.map((r) => ({ pr: r.pr_number, title: r.pr_title || null })),
  };
}

async function resolveDm(ctx, spec, app, repo) {
  const run = await sourceRun(ctx.pool, spec, app);
  // The answer first: a question nobody answered is skipped before any
  // snapshot is written for it, unless the spec scripts the answer and the
  // run recorded the question to script it to.
  const answer = await trueAnswer(ctx, spec, app, repo, run);
  const question = answer.unanswered && spec.scripted_answer === 'if_unanswered' ? askedQuestion(run) : null;
  if (!answer.ok && !question) {
    const reason = answer.unanswered && spec.scripted_answer === 'if_unanswered'
      ? `${answer.reason}; its run recorded no question to script an answer to`
      : answer.reason;
    return { ...answer, reason, github: true };
  }
  const snap = await triageSnapshot(ctx, spec, app, repo, run);
  if (!snap.ok) return snap;
  const tags = baseTags(ctx, spec, app, {
    verdict: 'question',
    request_type: spec.tags?.request_type || suites.requestType(snap.issue?.title, snap.issue?.body),
    prompt_chars: snap.promptChars || await promptChars(ctx.pool, snap.snapshotId),
    snapshot_origin: snap.origin,
    answer_source: answer.ok ? answer.source : 'scripted',
  });
  // A pending scripted task has no answer yet: it is labelled with one
  // (grading.labelTask's dmAnswer) and never runs until it has.
  const dmScript = answer.ok
    ? { true_answer: answer.text, accepted: [], max_turns: 3, source: answer.source }
    : {
      true_answer: null, accepted: [], max_turns: 3, source: 'scripted', pending: true,
      question, later: await laterOnRequest(ctx.pool, app, spec, answer.later || {}),
    };
  const task = await suites.insertTask(ctx.pool, {
    suiteId: ctx.suite.id, stage: 'dm', sourceRunId: run?.id || null, snapshotId: snap.snapshotId,
    appId: app.id, issueNumber: spec.issue_number, tags,
    reference: { dm_script: dmScript },
    referenceSource: null,
  });
  return { ok: true, task, github: true };
}

async function resolveBuildFromPr(ctx, spec, app, extraTags = {}) {
  const out = await suites.importTaskFromPr(ctx.pool, {
    suiteId: ctx.suite.id, appSlug: app.slug, issueNumber: spec.issue_number, prNumber: spec.pr_number,
    config: ctx.config, deps: { github: ctx.github, ...(ctx.deps.threadContext ? { threadContext: ctx.deps.threadContext } : {}), ...(ctx.deps.sessions ? { sessions: ctx.deps.sessions } : {}) },
    baseSha: spec.base_sha || null, requestFromPr: spec.request_from === 'pr_body',
    tags: {
      ...(spec.tags || {}), core_ref: spec.ref, core_definition: `${ctx.definition.key}@${ctx.definition.version}`,
      snapshot_origin: 'import', ...extraTags,
    },
    extra: { ref: spec.ref },
  });
  if (!out.ok) return { ...skipped(out.error, out.status >= 500), github: true };
  return { ok: true, task: out.task, github: true };
}

async function resolveChecksFix(ctx, spec, app, repo) {
  const { pool } = ctx;
  const { rows: [session] } = await pool.query(
    `SELECT id, app_id, pr_number, status, check_state, reviewed_head_sha, checks_commit_sha, test_results, linked_issues
       FROM chat_sessions WHERE id = $1`,
    [spec.proposal_session_id],
  );
  if (!session) return skipped(`proposal ${spec.proposal_session_id} is gone`);
  if (session.app_id !== app.id) return skipped(`proposal ${spec.proposal_session_id} is not on ${app.slug}`);
  // The bot's own first look at the red head, when it recorded one: exactly
  // what its checks-fix turn read.
  const { rows: [recorded] } = await pool.query(
    `SELECT r.id, r.issue_number, sn.id AS snapshot_id
       FROM homeroom_bot_runs r
       JOIN homeroom_bot_run_snapshots sn ON sn.run_id = r.id AND sn.stage = 'checks_fix'
      WHERE r.proposal_session_id = $1 AND r.checks_head_sha IS NOT NULL
      ORDER BY r.id ASC LIMIT 1`,
    [session.id],
  );
  let snapshotId;
  let issueNumber;
  let origin;
  let runId = null;
  if (recorded) {
    snapshotId = recorded.snapshot_id;
    issueNumber = recorded.issue_number;
    origin = 'recorded';
    runId = recorded.id;
  } else {
    const { rows: [any] } = await pool.query(
      'SELECT issue_number FROM homeroom_bot_runs WHERE proposal_session_id = $1 ORDER BY id LIMIT 1', [session.id],
    );
    issueNumber = any?.issue_number || (Array.isArray(session.linked_issues) ? Number(session.linked_issues[0]) : null);
    if (!posInt(issueNumber)) return skipped(`proposal ${session.id} names no request`);
    const out = await backfill.backfillChecksFix(pool, {
      app, repo, session, issueNumber, github: ctx.github, extra: { ref: spec.ref }, deps: ctx.deps,
    });
    if (!out.ok) return { ...out, github: true };
    snapshotId = out.snapshotId;
    origin = 'backfilled';
  }
  const tags = baseTags(ctx, spec, app, {
    verdict: 'checks', request_type: spec.tags?.request_type || null,
    prompt_chars: await promptChars(pool, snapshotId), snapshot_origin: origin, proposal_pr: session.pr_number || spec.pr_number || null,
  });
  const task = await suites.insertTask(pool, {
    suiteId: ctx.suite.id, stage: 'checks_fix', sourceRunId: runId, snapshotId, appId: app.id, issueNumber, tags,
  });
  return { ok: true, task, github: origin === 'backfilled' };
}

async function resolveRecordedRun(ctx, spec, app, stage) {
  const snapshotId = await recordedSnapshotId(ctx.pool, spec.source_run_id, stage);
  if (!snapshotId) return skipped(`run ${spec.source_run_id} recorded no ${stage} snapshot (it predates snapshots)`);
  const { rows: [run] } = await ctx.pool.query('SELECT id, issue_number, verdict FROM homeroom_bot_runs WHERE id = $1', [spec.source_run_id]);
  if (!run) return skipped(`run ${spec.source_run_id} is gone`);
  const tags = baseTags(ctx, spec, app, {
    verdict: run.verdict, request_type: spec.tags?.request_type || null,
    prompt_chars: await promptChars(ctx.pool, snapshotId), snapshot_origin: 'recorded',
  });
  const task = await suites.insertTask(ctx.pool, {
    suiteId: ctx.suite.id, stage, sourceRunId: run.id, snapshotId, appId: app.id, issueNumber: run.issue_number, tags,
  });
  return { ok: true, task, github: false };
}

/** One task of the definition: resolved and inserted, or the reason it was not. Never throws. */
async function materializeOne(ctx, spec) {
  await beat(ctx);
  if (await hasRef(ctx.pool, ctx.suite.id, spec.ref)) return { ok: true, existed: true };
  let out;
  try {
    const app = await appBySlug(ctx.pool, spec.app_slug);
    if (!app) {
      out = skipped(`the app ${spec.app_slug} is gone`);
    } else {
      const repo = require('../homeroom-bot').parseRepo(app.repo_url);
      if (!repo) out = skipped(`${app.slug} has no GitHub repository`);
      else if (spec.stage === 'triage') out = await resolveTriage(ctx, spec, app, repo);
      else if (spec.stage === 'dm') out = await resolveDm(ctx, spec, app, repo);
      else if (spec.stage === 'build') out = await resolveBuildFromPr(ctx, spec, app);
      else if (spec.stage === 'checks_fix') out = await resolveChecksFix(ctx, spec, app, repo);
      else if (spec.stage === 'followup') out = await resolveRecordedRun(ctx, spec, app, 'followup');
      else out = skipped(`stage ${spec.stage} is not materialized from a definition`);
    }
  } catch (err) {
    out = { ...skipped(`failed: ${err.message}`, true), github: true };
  }
  if (!out.ok) ctx.skipped.push({ ref: spec.ref, stage: spec.stage, app: spec.app_slug, reason: String(out.reason || 'unknown').slice(0, 500), ...(out.transient ? { transient: true } : {}) });
  if (out.github) await sleep(ctx.rateMs);
  return out;
}

async function ruleTasks(pool, suiteId, ruleRef) {
  const { rows } = await pool.query(
    "SELECT app_id FROM bench_tasks WHERE suite_id = $1 AND tags->>'core_rule' = $2", [suiteId, ruleRef],
  );
  return rows.map((r) => r.app_id);
}

function isPlatformRow(ctx, row) {
  return row.app_slug === ctx.definition.platform_app || require('../homeroom-bot').isPlatformRepo(row, ctx.config);
}

/** One dynamic rule: its candidates, then each picked one through materializeOne. */
async function materializeRule(ctx, rule) {
  const { pool } = ctx;
  const notes = { rule: rule.ref, candidates: 0, added: 0, fallback: 0, notEligible: 0 };
  const used = await ruleTasks(pool, ctx.suite.id, rule.ref);
  let room = rule.limit - used.length;
  const exclude = new Set(used);
  const take = async (spec, appId) => {
    const out = await materializeOne(ctx, spec);
    if (out.ok && !out.existed) { room -= 1; notes.added += 1; exclude.add(appId); }
    return out;
  };
  if (rule.rule === 'merged_bot_proposals') {
    const rows = (await mergedBotProposals(pool)).filter((r) => !(rule.exclude_platform && isPlatformRow(ctx, r)));
    notes.candidates = rows.length;
    // Distinct apps in order; a pick that cannot be imported gives way to
    // the next app's.
    for (const r of pickDistinctApps(rows, rows.length, { exclude: [...exclude] })) {
      if (room <= 0) break;
      // eslint-disable-next-line no-await-in-loop
      await take({
        ref: `${rule.ref}:${r.app_slug}#${r.issue_number}`, stage: 'build', app_slug: r.app_slug,
        issue_number: r.issue_number, pr_number: r.pr_number,
        tags: { verdict_bot: 'ready', platform: false, core_rule: rule.ref, source: 'merged_bot_proposal' },
      }, r.app_id);
    }
    if (room > 0 && rule.fallback === 'shadow_builds_closed_issue') {
      const shadow = (await shadowBuilds(pool)).filter((r) => !(rule.exclude_platform && isPlatformRow(ctx, r)));
      for (const r of pickDistinctApps(shadow, shadow.length, { exclude: [...exclude] })) {
        if (room <= 0) break;
        // eslint-disable-next-line no-await-in-loop
        const out = await shadowBuildTask(ctx, rule, r);
        if (out === 'not_closed') { notes.notEligible += 1; continue; }
        if (out?.ok && !out.existed) { room -= 1; notes.fallback += 1; exclude.add(r.app_id); }
      }
    }
  } else if (rule.rule === 'bot_followups') {
    const rows = await botFollowups(pool);
    notes.candidates = rows.length;
    const replayable = rows.filter((r) => r.snapshot_id);
    notes.notEligible = rows.length - replayable.length;
    for (const r of pickDistinctApps(replayable, rule.limit, { exclude: [...exclude] })) {
      if (room <= 0) break;
      // eslint-disable-next-line no-await-in-loop
      await take({
        ref: `${rule.ref}:${r.app_slug}#${r.issue_number}:run${r.run_id}`, stage: 'followup', app_slug: r.app_slug,
        source_run_id: r.run_id, issue_number: r.issue_number,
        tags: { verdict_bot: r.verdict, core_rule: rule.ref },
      }, r.app_id);
    }
  }
  if (room > 0) {
    ctx.skipped.push({
      ref: rule.ref, stage: rule.stage, app: null,
      reason: `only ${rule.limit - room} of ${rule.limit} could be found (${notes.candidates} candidates; ${notes.notEligible} not eligible)`,
    });
  }
  return notes;
}

/** A fallback build task from a shadow build, when its request is closed now. */
async function shadowBuildTask(ctx, rule, r) {
  const ref = `${rule.ref}:shadow:${r.app_slug}#${r.issue_number}`;
  await beat(ctx);
  if (await hasRef(ctx.pool, ctx.suite.id, ref)) return { ok: true, existed: true };
  const repo = require('../homeroom-bot').parseRepo(r.repo_url);
  if (!repo) return 'not_closed';
  const fetched = await ctx.github.fetchPublicIssue(repo.owner, repo.repo, r.issue_number);
  await sleep(ctx.rateMs);
  if (fetched?.issue?.state !== 'closed') return 'not_closed';
  const app = { id: r.app_id, slug: r.app_slug, repo_url: r.repo_url };
  const spec = {
    ref, stage: 'build', app_slug: r.app_slug, issue_number: r.issue_number,
    tags: { verdict_bot: 'ready', platform: false, core_rule: rule.ref, source: 'shadow_build' },
  };
  let snapshotId = r.snapshot_id;
  let origin = 'recorded';
  try {
    if (!snapshotId) {
      const out = await backfill.backfillBuild(ctx.pool, {
        app, repo, issueNumber: r.issue_number, asOf: r.created_at, buildAt: r.build_at, buildNote: r.build_note || '',
        github: ctx.github, extra: { ref, sourceRunId: r.run_id }, deps: ctx.deps,
      });
      await sleep(ctx.rateMs);
      if (!out.ok) {
        ctx.skipped.push({ ref, stage: 'build', app: r.app_slug, reason: out.reason, ...(out.transient ? { transient: true } : {}) });
        return out;
      }
      snapshotId = out.snapshotId;
      origin = 'backfilled';
    }
    const tags = baseTags(ctx, spec, app, {
      verdict: 'ready', request_type: suites.requestType(fetched.issue.title, fetched.issue.body),
      known_outcome: 'built', prompt_chars: await promptChars(ctx.pool, snapshotId), snapshot_origin: origin,
    });
    const task = await suites.insertTask(ctx.pool, {
      suiteId: ctx.suite.id, stage: 'build', sourceRunId: r.run_id, snapshotId, appId: r.app_id, issueNumber: r.issue_number, tags,
    });
    return { ok: true, task };
  } catch (err) {
    ctx.skipped.push({ ref, stage: 'build', app: r.app_slug, reason: `failed: ${err.message}`, transient: true });
    return skipped(err.message, true);
  }
}

async function stageCounts(pool, suiteId) {
  const { rows } = await pool.query(
    `SELECT stage, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE reference_source IS NOT NULL)::int AS labelled
       FROM bench_tasks WHERE suite_id = $1 GROUP BY stage`,
    [suiteId],
  );
  return Object.fromEntries(rows.map((r) => [r.stage, { ready: r.n, labelled: r.labelled }]));
}

/** The summary a materialization leaves: ready and skipped per stage, and why each skip. */
async function summarize(pool, suiteId, definition, skippedList) {
  const ready = await stageCounts(pool, suiteId);
  const stages = {};
  for (const stage of suites.TASK_STAGES) {
    const r = ready[stage]?.ready || 0;
    const s = skippedList.filter((x) => x.stage === stage).length;
    if (r || s) stages[stage] = { ready: r, skipped: s };
  }
  const total = Object.values(ready).reduce((n, x) => n + x.ready, 0);
  return {
    definition: definition.key, version: definition.version, suiteId,
    ready: total, stages, skipped: skippedList.slice(0, 200), finishedAt: new Date().toISOString(),
  };
}

/** Claim this definition's row, or null when there is nothing to do. */
async function claim(pool, definition, force) {
  const { rows } = await pool.query(
    `INSERT INTO bench_materializations (definition, version, status, attempts, started_at, heartbeat_at)
     VALUES ($1, $2, 'running', 1, NOW(), NOW())
     ON CONFLICT (definition, version) DO UPDATE
       SET status = 'running', attempts = bench_materializations.attempts + 1, started_at = NOW(),
           heartbeat_at = NOW(), finished_at = NULL
     WHERE bench_materializations.status = 'failed'
        OR ($3::boolean AND bench_materializations.status = 'done')
        OR (bench_materializations.status = 'running'
            AND COALESCE(bench_materializations.heartbeat_at, bench_materializations.started_at)
                < NOW() - make_interval(mins => $4))
     RETURNING *`,
    [definition.key, definition.version, !!force, STALE_RUNNING_MINUTES],
  );
  return rows[0] || null;
}

async function ensureSuite(pool, definition, row, actorId) {
  if (row.suite_id) {
    const existing = await suites.suiteRow(pool, row.suite_id);
    if (existing) return existing;
  }
  const made = await suites.createSuite(pool, {
    name: definition.name, kind: definition.kind,
    notes: `${definition.notes || ''} Definition ${definition.key} v${definition.version}.`.trim(), actorId,
  });
  if (!made.ok) throw new Error(made.error);
  await pool.query(
    'UPDATE bench_materializations SET suite_id = $3 WHERE definition = $1 AND version = $2',
    [definition.key, definition.version, made.suite.id],
  );
  return suites.suiteRow(pool, made.suite.id);
}

/**
 * A done suite's build tasks whose references were never re-read from their
 * pull requests' own diffs (imported before that fix), repaired on the next
 * pass (the boot pass) with nobody pressing anything. Once each has been,
 * this reads nothing. Never on a frozen suite; never throws.
 */
async function repairUnrepaired(pool, suiteId, deps, rateMs) {
  if (!suiteId) return null;
  try {
    const suite = await suites.suiteRow(pool, suiteId);
    if (!suite || suite.frozen_at) return null;
    const github = deps.github || require('./runner').guardedGithub(require('../github'));
    if (!github.isEnabled()) return null;
    const out = await suites.refreshPrReferences(pool, {
      suiteId, github, onlyUnrepaired: true, pause: () => sleep(Number(rateMs) || 0),
    });
    return out.checked ? out : null;
  } catch (err) {
    log.warn('bench', 'Repairing the build references failed', { suiteId, err: err.message });
    return null;
  }
}

/**
 * Materialize a definition: its suite and every task it can resolve. A
 * no-op once done (unless `force`, which retries only what is missing),
 * except that build tasks imported before their references were read from
 * their pull requests' own diffs are repaired (repairUnrepaired).
 * Resolves { ok, noop?, suiteId, summary }. Never throws.
 */
async function materialize(pool, config = {}, {
  definition = loadDefinition(), deps = {}, force = false, rateMs = DEFAULT_RATE_MS, actorId = null,
} = {}) {
  const v = validateDefinition(definition);
  if (!v.ok) {
    log.error('bench', 'The Core suite definition is invalid', { errors: v.errors.slice(0, 10) });
    return { ok: false, status: 500, error: `The definition is invalid: ${v.errors[0]}` };
  }
  const row = await claim(pool, definition, force);
  if (!row) {
    const current = await statusRow(pool, definition);
    const references = current?.status === 'done' ? await repairUnrepaired(pool, current.suite_id, deps, rateMs) : null;
    return {
      ok: true, noop: true, status: current?.status || null, suiteId: current?.suite_id || null, summary: current?.summary || null,
      ...(references ? { references } : {}),
    };
  }
  const startedMs = Date.now();
  try {
    const github = deps.github || require('./runner').guardedGithub(require('../github'));
    if (!github.isEnabled()) throw new Error('GitHub is not configured');
    const suite = await ensureSuite(pool, definition, row, actorId);
    const ctx = { pool, config, github, deps, definition, suite, skipped: [], rateMs: Number(rateMs) || 0 };
    const rules = [];
    let references = null;
    if (suite.frozen_at) {
      ctx.skipped.push({ ref: definition.key, stage: null, app: null, reason: 'the suite is frozen: nothing more can be added to it' });
    } else {
      // A retry also re-reads the build tasks' references from their pull
      // requests' own diffs (suites.refreshPrReferences): the repair for
      // tasks imported when their files and checks were read from the task's
      // base to the merge, which swept in everything merged in between.
      // Before the missing tasks, which are imported right already.
      if (force) {
        references = await suites.refreshPrReferences(pool, {
          suiteId: suite.id, github, pause: () => sleep(ctx.rateMs),
        });
      }
      for (const spec of definition.tasks) {
        // eslint-disable-next-line no-await-in-loop
        await materializeOne(ctx, spec);
      }
      for (const rule of definition.dynamic || []) {
        // eslint-disable-next-line no-await-in-loop
        rules.push(await materializeRule(ctx, rule));
      }
    }
    const summary = {
      ...(await summarize(pool, suite.id, definition, ctx.skipped)), rules,
      ...(references ? { references } : {}),
      durationMs: Date.now() - startedMs,
    };
    await pool.query(
      `UPDATE bench_materializations SET status = 'done', summary = $3::jsonb, finished_at = NOW()
        WHERE definition = $1 AND version = $2`,
      [definition.key, definition.version, JSON.stringify(summary)],
    );
    log.info('bench', 'Core suite materialized', {
      definition: `${definition.key}@${definition.version}`, suiteId: suite.id, ready: summary.ready,
      skipped: summary.skipped.length,
      perStage: Object.fromEntries(Object.entries(summary.stages).map(([k, x]) => [k, `${x.ready} ready, ${x.skipped} skipped`])),
      seconds: Math.round(summary.durationMs / 1000),
    });
    return { ok: true, suiteId: suite.id, summary };
  } catch (err) {
    log.warn('bench', 'Core suite materialization failed', { definition: definition.key, err: err.message });
    await pool.query(
      `UPDATE bench_materializations SET status = 'failed', summary = summary || $3::jsonb, finished_at = NOW()
        WHERE definition = $1 AND version = $2`,
      [definition.key, definition.version, JSON.stringify({ error: String(err.message).slice(0, 500) })],
    ).catch(() => {});
    return { ok: false, status: 500, error: err.message };
  }
}

async function statusRow(pool, definition) {
  const { rows } = await pool.query(
    'SELECT * FROM bench_materializations WHERE definition = $1 AND version = $2', [definition.key, definition.version],
  );
  return rows[0] || null;
}

/** The Core suite's id, when it has been made. */
async function coreSuiteId(pool, definition = loadDefinition()) {
  const row = await statusRow(pool, definition);
  return row?.suite_id || null;
}

/** What the Benchmark area shows of Core: the definition, the materialization, the suite's labels. */
async function coreStatus(pool, { definition = loadDefinition() } = {}) {
  const v = validateDefinition(definition);
  const row = await statusRow(pool, definition);
  let suite = null;
  if (row?.suite_id) {
    const { rows: [s] } = await pool.query(
      `SELECT s.id, s.name, s.version, s.frozen_at,
              COUNT(t.id)::int AS total,
              COUNT(t.id) FILTER (WHERE t.reference_source IS NOT NULL)::int AS labelled
         FROM bench_suites s LEFT JOIN bench_tasks t ON t.suite_id = s.id
        WHERE s.id = $1 GROUP BY s.id`,
      [row.suite_id],
    );
    suite = s || null;
  }
  // A running row nobody has beaten for STALE_RUNNING_MINUTES was left by a
  // process that died mid-pass: it is not running, and may be tried again.
  const lastBeat = row ? new Date(row.heartbeat_at || row.started_at).getTime() : 0;
  const stale = !!row && row.status === 'running' && !inProcess
    && Date.now() - lastBeat > STALE_RUNNING_MINUTES * 60 * 1000;
  return {
    definition: { key: definition.key, name: definition.name, version: definition.version, expected: v.counts, valid: v.ok },
    materialization: row ? {
      status: row.status, summary: row.summary || {}, attempts: row.attempts, startedAt: row.started_at, finishedAt: row.finished_at,
      heartbeatAt: row.heartbeat_at || null, stale,
    } : null,
    suite,
    running: !!inProcess || (row?.status === 'running' && !stale),
  };
}

/** Start a materialization in the background (one per process); resolves at once. */
function materializeInBackground(pool, config, opts = {}) {
  if (inProcess) return { ok: false, status: 409, error: 'Core is already being materialized' };
  inProcess = materialize(pool, config, opts)
    .catch((err) => ({ ok: false, error: err.message }))
    .finally(() => { inProcess = null; });
  return { ok: true, started: true, promise: inProcess };
}

/** Whether this deployment materializes Core on boot: production and staging, unless switched off. */
function bootEnabled(env = process.env) {
  if (String(env.BENCH_CORE_MATERIALIZE || '').toLowerCase() === 'off') return false;
  return env.USERNODE_ENV === 'staging' || env.NODE_ENV === 'production';
}

/** On the leader: materialize Core in the background a little after boot. */
function startOnBoot(config, { env = process.env, delayMs = BOOT_DELAY_MS } = {}) {
  if (!bootEnabled(env)) return false;
  const timer = setTimeout(() => {
    try {
      const github = require('../github');
      if (!github.isEnabled()) {
        log.info('bench', 'Core suite not materialized: GitHub is not configured');
        return;
      }
      const { getPool } = require('../../db/pool');
      materializeInBackground(getPool(config), config);
    } catch (err) {
      log.warn('bench', 'Core suite boot pass failed to start', { err: err.message });
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

module.exports = {
  DEFINITION_FILE,
  RULES,
  STAGE_RANGES,
  SCRIPTED_ANSWER,
  STALE_RUNNING_MINUTES,
  loadDefinition,
  validateDefinition,
  pickDistinctApps,
  materialize,
  materializeOne,
  coreStatus,
  coreSuiteId,
  materializeInBackground,
  bootEnabled,
  startOnBoot,
  _awaitForTests: () => inProcess || Promise.resolve(null),
};
