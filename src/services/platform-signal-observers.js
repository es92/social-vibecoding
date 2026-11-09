'use strict';

// What counts as a problem now: the wave 1 observers of platform signals
// (services/platform-signals.js sweeps them every five minutes).
//
// Each observer READS what an existing detector already stores, and returns
// the problems it sees right now as items: { kind, key, title, evidence,
// ... } (platform-signals.js normalizeItem). It changes nothing in the
// detector it reads, so a mistake here can mis-file a request but cannot
// break the release watch, the bot or the checks it watches. A problem the
// observer no longer returns has stopped, and the sweep clears it; an
// observer that throws clears nothing for its kinds that pass.
//
//   checks_not_change      the bot's checks-fix turn found a red check was
//                          not the change's doing (platform_incident events)
//   checks_platform_fault  proposals whose checks end in a platform error
//                          (chat_sessions.check_error_platform)
//   release_stalled        Homeroom's own release has not gone live
//                          (apps.release_stall, services/release-watch.js)
//   workflow               workflow instances faulted or stalled, deadlines
//                          overdue, work out of attempts (wf_instances, wf_work)
//   bot_paused             the bot's lane paused on faults, its budget or
//                          GitHub's (wf_instances 'bot-lane')
//   limit                  a server-wide cap full (platform_limit_alerts)
//   project_deploys        three or more projects failing to deploy at one
//                          step in a day (apps.last_failure)
//   alerting_silent        Alertmanager's Watchdog stopped arriving
//                          (platform_signal_sources)
//
// Infra alerts themselves are pushed, not read: routes/alerts-webhook.js.
//
// Everything an item says publicly is written here from typed facts (counts,
// codes, SHAs, slugs, paths). Text a person could have typed (an app's name,
// a request's title, a build's own output) stays out of `evidence` and goes
// to `evidencePrivate` when it is worth keeping for admins.

const log = require('./logger');

const sha7 = (s) => String(s || '').slice(0, 7);
const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs, max = 10) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};

// A short, stable name for an error's text: lower case, numbers, hashes and
// quoted values gone, the first eight words, so "Job 5638 refused" and "Job
// 5641 refused" are one problem.
function causeOf(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/["'`][^"'`]*["'`]/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return words.join('-').slice(0, 80) || 'unknown';
}

// The frames of a stack that are this repository's own code, repo-relative.
function ownFrames(stack, max = 8) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/((?:src|worker|scripts|tools)\/[^\s:()]+|server\.js):(\d+)(?::\d+)?/);
    if (m) {
      const frame = `${m[1]}:${m[2]}`;
      if (!out.includes(frame)) out.push(frame);
    }
    if (out.length >= max) break;
  }
  return out;
}

// ── checks_not_change ───────────────────────────────────────────────────

const NOT_CHANGE_SQL = `
  SELECT e.metadata, e.created_at, e.session_id
    FROM events e
   WHERE e.event_type = 'platform_incident' AND e.metadata->>'kind' = 'checks_not_change'
     AND e.created_at > NOW() - interval '24 hours'
   ORDER BY e.created_at DESC
   LIMIT 200`;

async function checksNotChange(pool) {
  const { rows } = await pool.query(NOT_CHANGE_SQL);
  const byCheck = new Map();
  for (const r of rows) {
    const failing = Array.isArray(r.metadata?.failing) ? r.metadata.failing : [];
    const check = String(failing[0] || 'unnamed check').slice(0, 120);
    if (!byCheck.has(check)) byCheck.set(check, []);
    byCheck.get(check).push(r);
  }
  const items = [];
  for (const [check, hits] of byCheck) {
    const prs = [...new Set(hits.map((h) => h.metadata?.prNumber).filter(Boolean))].map((n) => `#${n}`);
    const heads = [...new Set(hits.map((h) => sha7(h.metadata?.head)).filter(Boolean))];
    const why = String(hits[0].metadata?.why || '').trim();
    const where = /\.(?:test|spec)\.[jt]sx?$/.test(check) || /^tests\//.test(check) ? [check] : [];
    items.push({
      kind: 'checks_not_change',
      key: check,
      subject: { check },
      title: `Checks fail on changes that did not cause it: ${check}`,
      summary: `The check "${check}" failed on proposals whose fix turn found the failure was not their change's doing: `
        + 'it fails without the change too. Until it is fixed, every proposal that runs it is held up.',
      occurrences: hits.length,
      evidence: {
        lines: [
          `${plural(hits.length, 'time', 'times')} in the last 24 hours, the last at ${iso(hits[0].created_at)}.`,
          prs.length ? `Pull requests: ${list(prs)}.` : null,
          heads.length ? `Heads it failed on: ${list(heads, 6)}.` : null,
          why ? `The fix turn's reason: ${why}` : null,
        ].filter(Boolean),
        where,
      },
    });
  }
  return items;
}

// ── checks_platform_fault ───────────────────────────────────────────────

const PLATFORM_FAULT_SQL = `
  SELECT cs.id, cs.check_error_detail, cs.first_check_failure_at, cs.last_check_failure_at,
         cs.consecutive_check_failures
    FROM chat_sessions cs
   WHERE cs.check_state = 'error' AND cs.check_error_platform = TRUE
     AND cs.status IN ('active', 'paused', 'promoted', 'merging')
     AND cs.last_check_failure_at > NOW() - interval '2 hours'
   ORDER BY cs.last_check_failure_at DESC
   LIMIT 200`;

async function checksPlatformFault(pool) {
  const { rows } = await pool.query(PLATFORM_FAULT_SQL);
  const byCause = new Map();
  for (const r of rows) {
    const cause = causeOf(r.check_error_detail);
    if (!byCause.has(cause)) byCause.set(cause, []);
    byCause.get(cause).push(r);
  }
  const items = [];
  for (const [cause, hits] of byCause) {
    const longest = hits.reduce((m, h) => Math.max(m, Number(h.consecutive_check_failures) || 0), 0);
    const words = cause.replace(/-/g, ' ');
    items.push({
      kind: 'checks_platform_fault',
      key: cause,
      subject: { cause },
      title: `Checks can't run: ${words}`.slice(0, 160),
      summary: 'Proposals\' checks are ending in a platform error rather than a verdict, so they cannot merge. '
        + 'The platform retries them for a day; this is the same error on several of them.',
      occurrences: hits.length,
      evidence: {
        lines: [
          `${plural(hits.length, 'proposal', 'proposals')} in the last 2 hours: ${list(hits.map((h) => `proposal ${h.id}`))}.`,
          `The longest run of failures is ${longest}, since ${iso(hits.reduce((m, h) => (!m || h.first_check_failure_at < m ? h.first_check_failure_at : m), null))}.`,
        ],
        where: ['src/workflow/preview/machine.ts', 'src/services/check-pod-start.js'],
      },
      // The detail summarizes a boot, and a project's boot prints its own
      // output: only the cause's words above are public.
      evidencePrivate: { details: hits.slice(0, 5).map((h) => ({ session: Number(h.id), detail: h.check_error_detail })) },
    });
  }
  return items;
}

// ── release_stalled ─────────────────────────────────────────────────────

const RELEASE_TITLES = Object.freeze({
  workflow_failed: 'Homeroom release stalled: the release workflow failed',
  workflow_running: 'Homeroom release stalled: the release workflow is still running',
  rollout_missing: 'Homeroom release stalled: the new version never came up',
});

async function releaseStalled(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, release_stall FROM apps WHERE self_hosted = TRUE AND release_stall IS NOT NULL`);
  return rows.map((r) => {
    const s = r.release_stall || {};
    const kind = String(s.kind || 'unknown');
    return {
      kind: 'release_stalled',
      key: kind,
      appId: Number(r.id),
      subject: { stall: kind },
      fixer: kind === 'workflow_failed' ? 'bot' : 'infra',
      title: RELEASE_TITLES[kind] || 'Homeroom release stalled: it has not gone live',
      summary: 'A merge into Homeroom has not gone live. Until it does, Homeroom keeps running the version before it, '
        + 'and every merge after it waits behind it.',
      evidence: {
        lines: [
          `Merge ${sha7(s.sha)}${s.prNumber ? ` (#${s.prNumber})` : ''} stalled at ${iso(s.detectedAt || s.since)}.`,
          s.running ? `Homeroom is running ${sha7(s.running)}.` : null,
          s.runStatus || s.runConclusion ? `Release workflow: ${[s.runStatus, s.runConclusion].filter(Boolean).join(', ')}.` : null,
          s.runUrl ? `Workflow run: ${s.runUrl}` : null,
        ].filter(Boolean),
        where: kind === 'workflow_failed'
          ? ['.github/workflows/build-kubernetes-images.yml', 'Dockerfile.kubernetes']
          : ['src/services/release-watch.js'],
      },
    };
  });
}

// ── workflow ────────────────────────────────────────────────────────────

const FLAGGED_SQL = `
  SELECT i.machine, i.flag, COALESCE(i.flag_detail->>'code', '') AS code,
         COUNT(*)::int AS n, MIN(i.updated_at) AS since,
         (ARRAY_AGG(i.key ORDER BY i.updated_at DESC))[1:10] AS keys,
         (ARRAY_AGG(i.flag_detail->>'message' ORDER BY i.updated_at DESC))[1] AS message,
         (ARRAY_AGG(i.flag_detail->>'eventId' ORDER BY i.updated_at DESC))[1] AS event_id
    FROM wf_instances i
   WHERE i.flag IS NOT NULL
   GROUP BY i.machine, i.flag, COALESCE(i.flag_detail->>'code', '')`;

const EXHAUSTED_SQL = `
  SELECT w.machine, w.kind, COUNT(*)::int AS n, MIN(w.created_at) AS since,
         (ARRAY_AGG(w.key ORDER BY w.created_at DESC))[1:10] AS keys,
         (ARRAY_AGG(w.last_error ORDER BY w.created_at DESC))[1] AS last_error
    FROM wf_work w
   WHERE w.status IN ('reported', 'settled') AND w.result->>'outcome' = 'exhausted'
     AND w.created_at > NOW() - interval '6 hours'
   GROUP BY w.machine, w.kind`;

const OVERDUE_SQL = `
  SELECT machine, COUNT(*)::int AS n, MIN(deadline_at) AS since,
         (ARRAY_AGG(key ORDER BY deadline_at))[1:10] AS keys
    FROM wf_instances
   WHERE deadline_at < NOW() - interval '10 minutes'
   GROUP BY machine`;

const EVENT_ERROR_SQL = `SELECT error FROM wf_events WHERE id = $1`;

async function workflowProblems(pool) {
  const { machineTopic } = require('./platform-signals');
  const [flagged, exhausted, overdue] = await Promise.all([
    pool.query(FLAGGED_SQL), pool.query(EXHAUSTED_SQL), pool.query(OVERDUE_SQL),
  ]);
  const items = [];
  for (const r of flagged.rows) {
    let frames = [];
    if (r.event_id && /^\d+$/.test(String(r.event_id))) {
      try {
        const { rows: [ev] } = await pool.query(EVENT_ERROR_SQL, [Number(r.event_id)]);
        frames = ownFrames(ev?.error?.stack);
      } catch { /* the frames are a help, not a requirement */ }
    }
    const what = r.flag === 'faulted' ? 'faulted' : 'stalled';
    items.push({
      kind: 'workflow',
      key: `${r.machine}:${r.flag}:${r.code}`,
      topic: machineTopic(r.machine),
      subject: { machine: r.machine, flag: r.flag, code: r.code },
      title: `Stuck work in ${r.machine}: ${what}${r.code ? ` (${r.code})` : ''}`,
      summary: r.flag === 'faulted'
        ? `A transition of the ${r.machine} workflow threw, so its instance is held until an admin releases it. `
          + 'That is a bug in the machine or a broken invariant.'
        : `Events for the ${r.machine} workflow keep timing out, so its instance has stopped moving.`,
      occurrences: r.n,
      evidence: {
        lines: [
          `${plural(r.n, 'instance', 'instances')} ${what}, the first at ${iso(r.since)}: ${list(r.keys || [])}.`,
          r.code ? `Error code: ${r.code}.` : null,
          r.message ? `Message: ${String(r.message).slice(0, 240)}` : null,
        ].filter(Boolean),
        where: frames.length ? frames : [`src/workflow/${r.machine}/machine.ts`],
      },
    });
  }
  for (const r of exhausted.rows) {
    const err = r.last_error && typeof r.last_error === 'object' ? r.last_error : {};
    items.push({
      kind: 'workflow',
      key: `${r.machine}:exhausted:${r.kind}`,
      topic: machineTopic(r.machine),
      subject: { machine: r.machine, flag: 'exhausted', work: r.kind },
      title: `Stuck work in ${r.machine}: ${r.kind} ran out of attempts`,
      summary: `Work of kind ${r.kind} on the ${r.machine} workflow failed every attempt it was given, `
        + 'so what it was for did not happen.',
      occurrences: r.n,
      evidence: {
        lines: [
          `${plural(r.n, 'item', 'items')} out of attempts in the last 6 hours, the first at ${iso(r.since)}: ${list(r.keys || [])}.`,
          err.code ? `Last error code: ${err.code}.` : null,
          err.message ? `Last error: ${String(err.message).slice(0, 240)}` : null,
        ].filter(Boolean),
        where: [`src/workflow/${r.machine}/services.ts`],
      },
    });
  }
  for (const r of overdue.rows) {
    items.push({
      kind: 'workflow',
      key: `${r.machine}:overdue`,
      topic: machineTopic(r.machine),
      subject: { machine: r.machine, flag: 'overdue' },
      title: `Stuck work in ${r.machine}: deadlines did not fire`,
      summary: `Instances of the ${r.machine} workflow are past a deadline that should have woken them, `
        + 'so they are waiting for something that will not come.',
      occurrences: r.n,
      evidence: {
        lines: [`${plural(r.n, 'instance', 'instances')} overdue since ${iso(r.since)}: ${list(r.keys || [])}.`],
        where: ['src/workflow/kernel/timers.ts', `src/workflow/${r.machine}/machine.ts`],
      },
    });
  }
  return items;
}

// ── bot_paused ──────────────────────────────────────────────────────────

// The lane's budget and GitHub holds are re-armed by its next look, so one
// that lapsed a few minutes ago is usually still on: read as still paused.
const LAPSE_MS = 10 * 60 * 1000;
// A fault pause is a problem from its third doubling (about 14 minutes in).
const FAULT_ATTEMPTS = 3;

async function botPaused(pool, { now = Date.now() } = {}) {
  const { rows: [lane] } = await pool.query(
    `SELECT data FROM wf_instances WHERE machine = 'bot-lane' AND key = 'bot'`);
  const d = lane?.data || {};
  const until = (x) => (x && x.until ? new Date(x.until).getTime() : 0);
  const items = [];
  if (d.fault && Number(d.fault.attempts) >= FAULT_ATTEMPTS) {
    items.push({
      kind: 'bot_paused', key: 'fault', subject: { reason: 'fault' },
      title: 'Homeroom bot paused: the platform keeps failing under it',
      summary: 'The bot stopped starting work because what it runs on keeps failing: each failure doubles its pause, '
        + 'up to an hour. Nobody\'s request moves until a look succeeds.',
      evidence: { lines: [`Pause ${Number(d.fault.attempts)} in a row; the next try is at ${iso(d.fault.until)}.`] },
    });
  }
  if (d.budget && until(d.budget) > now - LAPSE_MS) {
    items.push({
      kind: 'bot_paused', key: 'budget', subject: { reason: 'budget' }, fileAfterMs: 60 * 60 * 1000,
      title: 'Homeroom bot paused: its weekly budget is used up',
      summary: 'The bot reached its weekly spending cap, so it starts nothing until the cap is raised or the week resets.',
      evidence: { lines: ['The bot\'s weekly cap is reached (Admin › Homeroom bot shows its spend).'] },
    });
  }
  if (d.github && until(d.github) > now - LAPSE_MS) {
    items.push({
      kind: 'bot_paused', key: 'github', subject: { reason: 'github' }, fileAfterMs: 30 * 60 * 1000,
      title: 'Homeroom bot paused: GitHub\'s hourly budget is nearly used up',
      summary: 'The bot is holding off until GitHub\'s hourly API budget resets. Something is spending it faster than usual.',
      evidence: { lines: [`Held until ${iso(d.github.until)}.`] },
    });
  }
  return items;
}

// ── limit ───────────────────────────────────────────────────────────────

const LIMIT_TITLES = Object.freeze({
  apps: 'Platform limit full: apps',
  sessions: 'Platform limit full: sessions running at once',
  github_app: 'GitHub budget used up: the GitHub App',
});

async function limitsFull(pool) {
  const { rows } = await pool.query(
    `SELECT limit_key, used, cap, measured_at FROM platform_limit_alerts WHERE level = 'full'`);
  // Only the caps still measured (platform-limit-alerts.js LIMITS). A row
  // for one that is not (the bot token's `github`, gone with the token)
  // keeps the level it last had, and says nothing about today.
  const watched = new Set(require('./platform-limit-alerts').LIMITS.map((l) => l.key));
  return rows.filter((r) => watched.has(r.limit_key)).map((r) => ({
    kind: 'limit',
    key: r.limit_key,
    subject: { limit: r.limit_key },
    title: LIMIT_TITLES[r.limit_key] || `Platform limit full: ${r.limit_key}`,
    summary: 'A server-wide limit is full, so people are being turned away from what it limits.',
    evidence: {
      lines: [`${r.used == null ? 'Unknown' : r.used} of ${r.cap == null ? 'unknown' : r.cap} in use at ${iso(r.measured_at)}.`],
    },
  }));
}

// ── project_deploys ─────────────────────────────────────────────────────

// Three projects failing at one step in a day is the platform's problem,
// not three projects'.
const PROJECT_DEPLOY_MIN = 3;

async function projectDeploys(pool, { now = Date.now() } = {}) {
  const { rows } = await pool.query(
    `SELECT slug, last_failure FROM apps
      WHERE last_failure IS NOT NULL AND self_hosted IS NOT TRUE
      ORDER BY id DESC LIMIT 500`);
  const byStage = new Map();
  for (const r of rows) {
    const f = r.last_failure || {};
    const at = f.at ? new Date(f.at).getTime() : 0;
    if (!at || now - at > 24 * 60 * 60 * 1000) continue;
    const stage = String(f.stage || 'unknown').slice(0, 40);
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(r);
  }
  const items = [];
  for (const [stage, hits] of byStage) {
    if (hits.length < PROJECT_DEPLOY_MIN) continue;
    items.push({
      kind: 'project_deploys',
      key: stage,
      subject: { stage },
      title: `Projects can't deploy: failing at the ${stage} step`,
      summary: `Several projects' production deploys failed at the same step (${stage}) within a day, `
        + 'so the cause is more likely the platform\'s than each project\'s.',
      occurrences: hits.length,
      evidence: {
        lines: [`${plural(hits.length, 'project', 'projects')} in the last 24 hours: ${list(hits.map((h) => h.slug))}.`],
        where: ['src/services/staging.js', 'src/services/deploy-failure.js'],
      },
      // Each failure's reason can carry the project's own build output.
      evidencePrivate: { reasons: hits.slice(0, 10).map((h) => ({ slug: h.slug, reason: h.last_failure?.reason || null })) },
    });
  }
  return items;
}

// ── alerting_silent ─────────────────────────────────────────────────────

const SILENT_AFTER_MS = 2 * 60 * 60 * 1000;

async function alertingSilent(pool, { now = Date.now() } = {}) {
  const { rows: [r] } = await pool.query(
    `SELECT last_heard_at FROM platform_signal_sources WHERE source = 'alertmanager'`);
  if (!r) return [];
  if (now - new Date(r.last_heard_at).getTime() < SILENT_AFTER_MS) return [];
  return [{
    kind: 'alerting_silent',
    key: 'alertmanager',
    subject: { source: 'alertmanager' },
    title: 'Infra alerts have gone quiet: no heartbeat from Alertmanager',
    summary: 'Alertmanager\'s Watchdog alert always fires and reaches Homeroom every hour. It has stopped arriving, '
      + 'so alerts may not be reaching anyone.',
    evidence: { lines: [`Last heard at ${iso(r.last_heard_at)}.`] },
  }];
}

// ── All of them ─────────────────────────────────────────────────────────

// Wave 2's detectors, one module each under signal-observers/, loaded when
// they run so a broken one costs only its own kinds.
const lazy = (file) => (pool, opts) => require(`./signal-observers/${file}`).run(pool, opts);

const OBSERVERS = Object.freeze([
  { kinds: ['checks_not_change'], run: checksNotChange },
  { kinds: ['checks_platform_fault'], run: checksPlatformFault },
  { kinds: ['release_stalled'], run: releaseStalled },
  { kinds: ['workflow'], run: workflowProblems },
  { kinds: ['bot_paused'], run: botPaused },
  { kinds: ['limit'], run: limitsFull },
  { kinds: ['project_deploys'], run: projectDeploys },
  { kinds: ['alerting_silent'], run: alertingSilent },
  { kinds: ['security', 'security_audit'], run: lazy('security-audit') },
  { kinds: ['server_errors'], run: lazy('server-errors') },
  { kinds: ['client_errors'], run: lazy('client-errors') },
  { kinds: ['session_fence_public', 'invite_pitch_failed'], run: lazy('session-fences') },
  { kinds: ['homeroom_crash'], run: lazy('homeroom-crashes') },
  { kinds: ['project_down'], run: lazy('project-down') },
  { kinds: ['bot_health'], run: lazy('bot-health') },
  { kinds: ['figure_off_target'], run: lazy('figures-off-target') },
  { kinds: ['turn_recovery_gave_up'], run: lazy('turn-recovery') },
]);

/**
 * Every observer, each on its own: { items, ok } where `ok` is the set of
 * kinds whose observer looked. A kind whose observer failed is not in `ok`,
 * so nothing of that kind is cleared on a pass that could not look.
 */
async function observeAll(pool, { now = Date.now(), observers = OBSERVERS } = {}) {
  const items = [];
  const ok = new Set();
  for (const o of observers) {
    try {
      const found = await o.run(pool, { now });
      // An incomplete audit can report discoveries without confirming that
      // any old finding has gone away. Older observers return just an array.
      items.push(...(Array.isArray(found) ? found : found.items));
      for (const k of o.kinds) if (Array.isArray(found) || found.ok.has(k)) ok.add(k);
    } catch (err) {
      log.warn('platform-signals', 'An observer could not look', { kinds: o.kinds, err: err.message });
    }
  }
  return { items, ok };
}

module.exports = {
  OBSERVERS,
  observeAll,
  causeOf,
  ownFrames,
  checksNotChange,
  checksPlatformFault,
  releaseStalled,
  workflowProblems,
  botPaused,
  limitsFull,
  projectDeploys,
  alertingSilent,
  PROJECT_DEPLOY_MIN,
};
