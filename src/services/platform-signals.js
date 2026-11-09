'use strict';

// Platform signals: every problem the platform can detect in itself files
// (or updates) exactly one request, and closes it once it has stopped.
//
// Until now two detectors filed their own requests (main watch's "Main is
// failing" and "Flaky test"), and their loop closed without anybody: the
// bot fixed them. Everything else the platform detects ended as an events
// row, a banner, an admin push or a log line, and a person had to notice it
// first. In the five weeks to 19 Oct 2026 about 55 incidents were found by a
// person, and four ran for between 5 days and 4 weeks before anybody did
// (Goalio undeployable for four weeks, leaked check Secrets for three, bot
// builds killed for memory and labelled "no change" for two).
//
// This module is the shared part: one row per episode of a problem
// (platform_signals), its lifecycle, filing, updating and closing. What
// counts as a problem is the observers' (services/platform-signal-
// observers.js), which read what the existing detectors already store; and
// a source that pushes rather than being read (the Alertmanager receiver,
// routes/alerts-webhook.js) calls raise() and clear() itself.
//
//   raised ─┬─ pending ──(its kind's delay, no release under way, under the
//           │             hourly cap, GitHub budget allows)──▶ open
//           └─ open ◀──(raised again)── clearing ──(quiet window)──▶ closed
//
//   - A FINGERPRINT is the kind plus the narrowest stable thing it is about
//     ("release_stalled:workflow_failed"). At most one row per fingerprint
//     is not closed (the unique index is the claim), so two pods, or a pass
//     after a crash, file once.
//   - A recurrence updates the row, never GitHub: any comment or edit moves
//     an issue's updated_at, and the bot reads every changed request again
//     (homeroom-bot.js classifyIssue). GitHub is written only on a material
//     change (four times as many occurrences as the body last said), on a
//     reopen, and once at close.
//   - A request with an open proposal, or a person's message in the last
//     day, is never closed by this module: closing it would withdraw the
//     bot's proposal (homeroom-bot-closed-requests.js).
//   - Raised again within 7 days of closing: the same request reopens.
//     Later: a new one that names the old.
//
// MODES (PLATFORM_SIGNALS): `off` does nothing; `shadow` keeps the rows
// (the topic pages and figures read them) and files nothing; `file` files.
// The default is `shadow`, and `off` on staging, whose database is a copy
// of production's. PLATFORM_SIGNALS_KINDS limits which kinds may file (a
// noisy kind goes back to shadow alone); PLATFORM_SIGNALS_BOT=off keeps
// every request for people.
//
// What a request says, and the scrubbing that keeps a public repository's
// requests free of anything private: services/platform-signal-evidence.js.

const log = require('./logger');
const evidenceText = require('./platform-signal-evidence');
const repoRef = require('./repo-ref');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Raised again within this long of closing reopens the same request.
const REOPEN_MS = 7 * DAY;
// Never closed while a person said something on it this recently.
const PERSON_RECENT_MS = DAY;
// A pushed problem (an alert) not raised again for this long has stopped:
// Alertmanager repeats a firing alert every hour.
const PUSH_STALE_MS = 3 * HOUR;
// New requests across the platform: a storm files a few, not hundreds.
const MAX_FILED_PER_HOUR = 6;
const MAX_FILED_PER_DAY = 20;
// A raise while a Homeroom release is rolling out waits this long after the
// last process booted, and files only if it is still happening.
const RELEASE_HOLD_MS = 10 * MINUTE;
// The bot works on at most this many signal requests at once per project
// (of its five open proposals there), so people's requests are not starved.
const BOT_SLOTS = 2;
// A row whose filing failed this often stops trying until it is raised anew.
const MAX_FILING_ATTEMPTS = 5;
// A body is rewritten when the problem has happened this many times more
// often than it last said.
const MATERIAL_RATIO = 4;

const TOPICS = Object.freeze(['onboarding', 'homeroom-bot', 'proposal-pipeline', 'infra', 'project-workflows']);

// Each kind: its topic, who fixes it, whether it is read (`poll`: cleared
// when its observer no longer sees it) or pushed (`push`: cleared by its
// source, or once stale), how long it must last before it files, and how
// long it must stay clear before its request closes. An observer's item may
// name its own fixer, topic and delay for one subject.
const KINDS = Object.freeze({
  checks_not_change: Object.freeze({
    topic: 'proposal-pipeline', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: DAY, admin: 'incidents',
    done: 'The check passes on changes that do not touch what it tests, with no new "not the change" incident for a day.',
  }),
  checks_platform_fault: Object.freeze({
    topic: 'proposal-pipeline', fixer: 'person', source: 'poll', fileAfterMs: 15 * MINUTE, quietMs: 30 * MINUTE, admin: 'merges',
    done: 'Checks run again on every proposal, with none ending in a platform error for 30 minutes.',
  }),
  release_stalled: Object.freeze({
    topic: 'infra', fixer: 'infra', source: 'poll', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'status',
    done: 'The release goes live: the running version matches main.',
  }),
  workflow: Object.freeze({
    topic: 'proposal-pipeline', fixer: 'bot', source: 'poll', fileAfterMs: 10 * MINUTE, quietMs: 30 * MINUTE, admin: 'workflows',
    done: 'No instance of this machine is faulted, stalled or out of attempts for 30 minutes, and new ones do not fault the same way.',
  }),
  bot_paused: Object.freeze({
    topic: 'homeroom-bot', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'homeroom-bot',
    done: 'The bot runs again, and stays running for 30 minutes.',
  }),
  limit: Object.freeze({
    topic: 'infra', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: HOUR, admin: 'limits',
    done: 'The limit has room again: usage falls below 90% of its warning line.',
  }),
  project_deploys: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: 6 * HOUR, admin: 'status',
    done: 'Projects deploy at this step again, with fewer than 3 failing it in a day.',
  }),
  alert: Object.freeze({
    topic: 'infra', fixer: 'infra', source: 'push', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'status',
    done: 'The alert resolves and stays resolved for 30 minutes.',
  }),
  alerting_silent: Object.freeze({
    topic: 'infra', fixer: 'infra', source: 'poll', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'status',
    done: 'Alertmanager\'s Watchdog heartbeat arrives again every hour.',
  }),
  security: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'status',
    done: 'A complete current security audit no longer finds this advisory.',
  }),
  security_audit: Object.freeze({
    topic: 'infra', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: 30 * MINUTE, admin: 'status',
    done: 'A complete successful security audit is available again.',
  }),
  // ── Wave 2: detectors that did not exist before ──
  server_errors: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: 6 * HOUR, admin: 'status',
    done: 'This route answers without a server error for 6 hours.',
  }),
  client_errors: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: 6 * HOUR, admin: 'analytics',
    done: 'No page hits this error for 6 hours.',
  }),
  // #6002: the browser's session guard cut off a read on a signed-out page
  // or of a public route (signal-observers/session-fences.js).
  // Both read reports a signed-out page sends without an account, so a
  // person triages them: the bot never builds on what anybody could send.
  session_fence_public: Object.freeze({
    topic: 'onboarding', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: 6 * HOUR, admin: 'analytics',
    done: 'No read of this route is cut off on a signed-out page, or as a public read, for 6 hours.',
  }),
  invite_pitch_failed: Object.freeze({
    topic: 'onboarding', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: DAY, admin: 'analytics',
    done: 'Invite pages that fall back to the pitch because the read failed drop below 3 a day, or below 2% of them.',
  }),
  homeroom_crash: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: DAY, admin: 'status',
    done: 'Homeroom\'s processes run for a day without one dying.',
  }),
  // Filed on the PROJECT's own board, held for a person: the bot builds
  // there only when somebody in the project mentions it on the request. The
  // creator is told as before (app_health); nobody else is notified.
  project_down: Object.freeze({
    topic: 'infra', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: HOUR, admin: 'status',
    done: 'The project deploys again.',
  }),
  bot_health: Object.freeze({
    topic: 'homeroom-bot', fixer: 'person', source: 'poll', fileAfterMs: 0, quietMs: DAY, admin: 'homeroom-bot',
    done: 'The figure is back within its line in Admin › Homeroom bot (Rollout health) for a day.',
  }),
  figure_off_target: Object.freeze({
    topic: 'infra', fixer: 'person', source: 'poll', fileAfterMs: DAY, quietMs: DAY, admin: 'analytics',
    done: 'The figure is back on its target for a day.',
  }),
  turn_recovery_gave_up: Object.freeze({
    topic: 'infra', fixer: 'bot', source: 'poll', fileAfterMs: 0, quietMs: DAY, admin: 'incidents',
    done: 'Every interrupted turn is picked up again, with none given up on for a day.',
  }),
});

const WHO_TEXT = Object.freeze({
  bot: 'Homeroom bot has it',
  person: 'Waiting for a person',
  infra: 'Waiting on infra',
});

// ── Switches ────────────────────────────────────────────────────────────

function mode(env = process.env) {
  const fallback = env.USERNODE_ENV === 'staging' ? 'off' : 'shadow';
  const v = String(env.PLATFORM_SIGNALS ?? fallback).trim().toLowerCase();
  return v === 'off' || v === 'shadow' || v === 'file' ? v : 'off';
}

function securityKind(kind) { return kind === 'security' || kind === 'security_audit'; }

// Enable only these two detectors while other signals remain in shadow.
// The global off switch, staging default and kind allowlist still apply.
function modeForKind(kind, env = process.env) {
  const global = mode(env);
  return global === 'shadow' && env.USERNODE_ENV !== 'staging' && securityKind(kind)
    && String(env.PLATFORM_SIGNALS_SECURITY_AUDIT).toLowerCase() === 'on' ? 'file' : global;
}

/** The kinds allowed to file: null for every kind. */
function kindsAllowed(env = process.env) {
  const v = String(env.PLATFORM_SIGNALS_KINDS ?? '').trim();
  if (!v || v === '*') return null;
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
}

function botOn(env = process.env) {
  const v = String(env.PLATFORM_SIGNALS_BOT ?? 'on').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false');
}

// ── Pure helpers ────────────────────────────────────────────────────────

/** Pure: the identity of a problem. */
function fingerprintOf(kind, key) {
  const k = String(key == null ? '' : key).replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${kind}:${k}`;
}

/** Pure: an observer's item, made whole from its kind (or null when invalid). */
function normalizeItem(item) {
  if (!item || !KINDS[item.kind]) return null;
  const def = KINDS[item.kind];
  const fixer = ['bot', 'person', 'infra'].includes(item.fixer) ? item.fixer : def.fixer;
  const topic = TOPICS.includes(item.topic) ? item.topic : def.topic;
  return {
    kind: item.kind,
    fingerprint: fingerprintOf(item.kind, item.key),
    subject: item.subject && typeof item.subject === 'object' ? item.subject : {},
    title: String(item.title || item.kind).replace(/\s+/g, ' ').trim().slice(0, 200),
    summary: item.summary || null,
    done: item.done || def.done,
    fixer,
    topic,
    appId: Number.isInteger(item.appId) ? item.appId : null,
    occurrences: Number.isInteger(item.occurrences) && item.occurrences > 0 ? item.occurrences : null,
    fileAfterMs: Number.isFinite(item.fileAfterMs) ? Math.max(0, item.fileAfterMs) : def.fileAfterMs,
    evidence: evidenceText.cleanEvidence(item.evidence),
    evidencePrivate: item.evidencePrivate && typeof item.evidencePrivate === 'object' ? item.evidencePrivate : null,
  };
}

/**
 * Pure: what the sweep does with one row now.
 *   'file'    pending, due, allowed: file its request
 *   'record'  pending and due, but it files nothing (shadow mode, or a kind
 *             of problem that is only counted): mark it open
 *   'wait'    pending, not yet
 *   'close'   clearing, quiet long enough, nothing holding it open
 *   'keep'    anything else
 */
function decide(row, { now, def, modeName, allowed, held = {}, capFull = false, budgetOk = true }) {
  const t = (v) => (v ? new Date(v).getTime() : 0);
  // Ages by the database's clock when the row carries them (ROWS_TO_ACT_SQL):
  // first_seen_at and cleared_at are the database's NOW(), and a process
  // whose clock runs a little behind would otherwise read a row raised this
  // pass as not yet due.
  const age = row.age_ms != null ? Number(row.age_ms) : now - t(row.first_seen_at);
  const clearedFor = row.cleared_ms != null ? Number(row.cleared_ms) : now - t(row.cleared_at);
  const countedOnly = row.subject?.noFile === true;
  // Recorded while filing was off (shadow), and filing is on now: it files.
  const unfiled = row.state === 'pending'
    || (row.state === 'open' && !row.issue_number && modeName === 'file' && !countedOnly);
  if (unfiled) {
    if (row.muted_until && t(row.muted_until) > now) return 'wait';
    const fileAfter = Number.isFinite(row.subject?.fileAfterMs) ? row.subject.fileAfterMs : def.fileAfterMs;
    if (age < fileAfter) return 'wait';
    if (modeName === 'shadow' || countedOnly) return row.state === 'pending' ? 'record' : 'keep';
    if (allowed && !allowed.has(row.kind)) return 'wait';
    if (held.release || capFull || !budgetOk) return 'wait';
    if (Number(row.filing_attempts) >= MAX_FILING_ATTEMPTS) return 'wait';
    return 'file';
  }
  if (row.state === 'clearing') {
    if (clearedFor < def.quietMs) return 'keep';
    if (held.proposal || held.person || held.sourceUnavailable) return 'keep';
    return 'close';
  }
  return 'keep';
}

/** Pure: whether an open, filed row's body is worth rewriting. */
function isMaterial(row) {
  if (securityKind(row.kind)) return !!row.subject?.materialKey && row.subject.materialKey !== row.subject.publishedKey;
  const published = Number(row.published_occurrences) || 0;
  const now = Number(row.occurrences) || 0;
  return published > 0 && now >= published * MATERIAL_RATIO;
}

/** Pure: a workflow machine's topic. */
function machineTopic(machine) {
  const m = String(machine || '');
  if (m.startsWith('bot-')) return 'homeroom-bot';
  if (m === 'app-delivery' || m === 'campaign') return 'infra';
  return 'proposal-pipeline';
}

// ── The database ────────────────────────────────────────────────────────

const RAISE_SQL = `
  INSERT INTO platform_signals (fingerprint, kind, subject, app_id, topic_key, fixer, title, occurrences,
                                evidence, evidence_private, evidence_at, previous_id)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, COALESCE($8, 1), $9::jsonb, $10::jsonb, NOW(),
          (SELECT p.id FROM platform_signals p WHERE p.fingerprint = $1 AND p.state = 'closed'
            ORDER BY p.closed_at DESC NULLS LAST, p.id DESC LIMIT 1))
  ON CONFLICT (fingerprint) WHERE state <> 'closed' DO UPDATE
     SET last_seen_at = NOW(),
         occurrences = GREATEST(platform_signals.occurrences, COALESCE($8, platform_signals.occurrences)),
         subject = EXCLUDED.subject,
         fixer = CASE WHEN EXCLUDED.kind IN ('security', 'security_audit') THEN EXCLUDED.fixer ELSE platform_signals.fixer END,
         title = CASE WHEN EXCLUDED.kind IN ('security', 'security_audit') THEN EXCLUDED.title ELSE platform_signals.title END,
         evidence = EXCLUDED.evidence,
         evidence_private = EXCLUDED.evidence_private,
         evidence_at = NOW(),
         state = CASE WHEN platform_signals.state = 'clearing' THEN 'open' ELSE platform_signals.state END,
         cleared_at = NULL
  RETURNING id, state, (xmax = 0) AS inserted`;

const CLEAR_SQL = `
  UPDATE platform_signals
     SET state = CASE WHEN state = 'pending' THEN 'closed' ELSE 'clearing' END,
         cleared_at = CASE WHEN state = 'pending' THEN cleared_at ELSE NOW() END,
         closed_at = CASE WHEN state = 'pending' THEN NOW() ELSE closed_at END,
         close_reason = CASE WHEN state = 'pending' THEN 'blip' ELSE close_reason END
   WHERE fingerprint = $1 AND state IN ('pending', 'open')
  RETURNING id, state`;

/**
 * Raise one problem. Never throws; resolves the row's { id, state, inserted }
 * or null. `item` is an observer's (see normalizeItem); `boardAppId` the
 * board it files on when the item names none.
 */
async function raise(pool, item, { boardAppId = null } = {}) {
  const it = normalizeItem(item);
  if (!it || !pool) return null;
  try {
    const subject = { ...it.subject, summary: it.summary, done: it.done, fileAfterMs: it.fileAfterMs };
    const { rows: [row] } = await pool.query(RAISE_SQL, [
      it.fingerprint, it.kind, JSON.stringify(subject), it.appId ?? boardAppId, it.topic, it.fixer, it.title,
      it.occurrences, JSON.stringify(it.evidence), it.evidencePrivate ? JSON.stringify(it.evidencePrivate) : null,
    ]);
    return row ? { id: Number(row.id), state: row.state, inserted: row.inserted === true } : null;
  } catch (err) {
    log.warn('platform-signals', 'Could not raise a signal', { fingerprint: it.fingerprint, err: err.message });
    return null;
  }
}

/** Clear one problem: it stopped. Never throws. */
async function clear(pool, fingerprint) {
  if (!pool || !fingerprint) return null;
  try {
    const { rows: [row] } = await pool.query(CLEAR_SQL, [String(fingerprint)]);
    return row || null;
  } catch (err) {
    log.warn('platform-signals', 'Could not clear a signal', { fingerprint, err: err.message });
    return null;
  }
}

/** Mute a problem until `until` (a full admin's choice). */
async function mute(pool, id, until) {
  const { rowCount } = await pool.query(
    `UPDATE platform_signals SET muted_until = $2 WHERE id = $1 AND state <> 'closed'`,
    [Number(id), until ? new Date(until) : null],
  );
  return rowCount > 0;
}

/** A source that speaks while alive spoke (Alertmanager's Watchdog). */
async function noteHeartbeat(pool, source) {
  await pool.query(
    `INSERT INTO platform_signal_sources (source, last_heard_at) VALUES ($1, NOW())
     ON CONFLICT (source) DO UPDATE SET last_heard_at = NOW()`,
    [String(source).slice(0, 48)],
  );
}

// The platform's own app: where signals file unless an item names another.
async function platformAppRow(pool) {
  const { rows } = await pool.query(
    'SELECT id, slug, repo_url FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1',
  );
  return rows[0] || null;
}

function parseRepo(url) {
  return repoRef.ownerRepo(url);
}

// ── Filing, updating, closing ───────────────────────────────────────────

const ROWS_TO_ACT_SQL = `
  SELECT ps.*, a.slug AS app_slug, a.repo_url AS app_repo_url, a.self_hosted AS app_self_hosted,
         i.status AS issue_status,
         (EXTRACT(EPOCH FROM (NOW() - ps.first_seen_at)) * 1000)::bigint AS age_ms,
         (EXTRACT(EPOCH FROM (NOW() - ps.cleared_at)) * 1000)::bigint AS cleared_ms,
         (EXTRACT(EPOCH FROM (NOW() - ps.last_seen_at)) * 1000)::bigint AS quiet_ms
    FROM platform_signals ps
    LEFT JOIN apps a ON a.id = ps.app_id
    LEFT JOIN LATERAL (
      SELECT status FROM issues
       WHERE app_id = ps.app_id AND github_issue_number = ps.issue_number AND kind = 'general'
       ORDER BY id DESC LIMIT 1
    ) i ON TRUE
   WHERE ps.state <> 'closed'
   ORDER BY ps.first_seen_at, ps.id`;

const FILED_RECENTLY_SQL = `
  SELECT COUNT(*) FILTER (WHERE filed_at > NOW() - interval '1 hour')::int AS hour,
         COUNT(*) FILTER (WHERE filed_at > NOW() - interval '1 day')::int AS day
    FROM platform_signals WHERE filed_at IS NOT NULL`;

const LAST_BOOT_SQL = `
  SELECT (EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) * 1000)::bigint AS ago_ms FROM events
   WHERE event_type = 'platform_booted' AND created_at > NOW() - interval '1 hour'`;

const HELD_OPEN_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM chat_sessions cs
             WHERE cs.app_id = $1
               AND cs.status IN ('active', 'promoted', 'merging')
               AND ($2 = ANY(cs.linked_issues) OR cs.created_from_issue_number = $2)) AS proposal,
    EXISTS (SELECT 1 FROM chat_messages m JOIN users u ON u.id = m.user_id
             WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
               AND m.msg_type = 'message' AND u.is_synthetic IS NOT TRUE
               AND m.created_at > NOW() - make_interval(secs => $3::float8 / 1000)) AS person`;

const FILED_SINCE_SQL = `
  SELECT github_issue_number FROM issues
   WHERE app_id = $1 AND kind = 'general' AND title = $2 AND created_at >= $3::timestamptz
   ORDER BY id LIMIT 1`;

const BOT_SLOT_SQL = `
  SELECT COUNT(*)::int AS n FROM platform_signals
   WHERE app_id = $1 AND fixer = 'bot' AND state = 'open' AND issue_number IS NOT NULL AND id <> $2`;

async function previousRow(pool, row) {
  if (!row.previous_id) return null;
  const { rows } = await pool.query(
    'SELECT id, issue_number, closed_at FROM platform_signals WHERE id = $1', [row.previous_id]);
  return rows[0] || null;
}

// The request on the board: a new issue, or the previous episode's reopened.
async function fileRow(pool, config, row, deps) {
  const github = deps.github;
  const def = KINDS[row.kind];
  const app = row.app_id ? { id: row.app_id, slug: row.app_slug, repo_url: row.app_repo_url } : null;
  const parsed = app && parseRepo(app.repo_url);
  if (!parsed || !github.isEnabled()) return false;
  const prev = await previousRow(pool, row);
  const reopen = prev && prev.issue_number && prev.closed_at
    && Date.now() - new Date(prev.closed_at).getTime() < REOPEN_MS;
  const signal = { ...row, previousIssue: !reopen && prev ? prev.issue_number : null };
  const body = evidenceText.requestBody({
    signal, kind: { ...def, fixer: row.fixer }, evidence: row.evidence, summary: row.subject?.summary, done: row.subject?.done,
  });
  await pool.query(
    'UPDATE platform_signals SET filing_attempts = filing_attempts + 1 WHERE id = $1', [row.id]);
  let issueNumber = null;
  if (reopen) {
    issueNumber = Number(prev.issue_number);
    await github.reopenIssue(parsed.owner, parsed.repo, issueNumber);
    await github.patchIssueBody(parsed.owner, parsed.repo, issueNumber, body).catch(() => {});
    await github.createIssueComment(parsed.owner, parsed.repo, issueNumber, evidenceText.reopenComment({ signal: row }));
    await pool.query(
      `UPDATE issues SET status = 'open' WHERE app_id = $1 AND github_issue_number = $2 AND kind = 'general'`,
      [app.id, issueNumber]);
    await require('./work-state').touched(pool, [{ appId: app.id, issueNumber }]);
  } else {
    // A pass that died between filing and recording the number: find it.
    const { rows: [found] } = await pool.query(FILED_SINCE_SQL, [app.id, row.title, row.first_seen_at]);
    if (found) {
      issueNumber = Number(found.github_issue_number);
    } else {
      const bot = await deps.bot().ensureBotUser(pool, config);
      const created = await github.createIssue(parsed.owner, parsed.repo, { title: row.title, body });
      issueNumber = Number(created && created.number);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('invalid issue number');
      // Not main-watch's fileBotIssue: that also tells everybody who follows
      // the board that a request was filed, and on Homeroom's own board
      // that is every member. A signal tells the full admins instead (below).
      const { rows: [issueRow] } = await pool.query(
        `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
         VALUES ($1, $2, $3, $4, 'general', $5::jsonb, $6) RETURNING id`,
        [app.id, issueNumber, row.title, body, JSON.stringify({ signalId: Number(row.id) }), bot.id]);
      try {
        require('./ws').pushIssueUpdate?.({ action: 'created', appSlug: app.slug, appId: app.id, issueId: issueRow?.id, kind: 'general' });
      } catch {}
    }
  }
  await pool.query(
    `UPDATE platform_signals
        SET state = 'open', issue_number = $2, filed_at = NOW(), published_occurrences = occurrences, last_error = NULL,
            subject = subject || $3::jsonb
      WHERE id = $1`,
    [row.id, issueNumber, JSON.stringify(publishedSubject(row))]);
  await handOff(pool, row, app, issueNumber, deps);
  log.info('platform-signals', reopen ? 'Reopened a signal request' : 'Filed a signal request', {
    kind: row.kind, fingerprint: row.fingerprint, issueNumber, fixer: row.fixer,
  });
  return true;
}

// Who gets the request: the bot's queue (a bot problem, within its slots),
// or the full admins (anything else; the bot is held off it, issueHolders).
async function handOff(pool, row, app, issueNumber, deps) {
  try {
    if (row.fixer === 'bot' && botOn()) {
      const { rows: [n] } = await pool.query(BOT_SLOT_SQL, [app.id, row.id]);
      if (Number(n?.n) < BOT_SLOTS) {
        await deps.bot().enqueueFront(pool, { appId: app.id, issueNumber, reason: 'signal' });
      }
      try { deps.bot().noteIssueActivity?.({ appId: app.id, issueNumber, reason: 'created' }); } catch {}
      return;
    }
    // A problem on a project's own board (project_down): its creator is
    // told already (app_health), and Homeroom's admins are not its people.
    if (row.app_self_hosted !== true) return;
    const notifications = deps.notifications();
    const created = await notifications.createPlatformIncidentNotifications(pool, {
      detail: `signal:${issueNumber}`, dedupePrefix: `signal:${issueNumber}`, since: new Date(Date.now() - DAY),
    });
    await Promise.all((created || []).map((r) => notifications.hydrateAndPush(pool, r)));
  } catch (err) {
    log.warn('platform-signals', 'Could not hand a signal request on', { issueNumber, err: err.message });
  }
}

async function rewriteBody(pool, row, deps) {
  const github = deps.github;
  const parsed = parseRepo(row.app_repo_url);
  if (!parsed || !row.issue_number || !github.isEnabled()) return;
  const body = evidenceText.requestBody({
    signal: row, kind: { ...KINDS[row.kind], fixer: row.fixer }, evidence: row.evidence, summary: row.subject?.summary, done: row.subject?.done,
  });
  await github.patchIssueBody(parsed.owner, parsed.repo, row.issue_number, body);
  await pool.query('UPDATE platform_signals SET published_occurrences = occurrences, subject = subject || $2::jsonb WHERE id = $1',
    [row.id, JSON.stringify(publishedSubject(row))]);
  if (securityKind(row.kind) && row.fixer === 'bot' && row.subject?.publishedFixer !== 'bot') {
    await handOff(pool, row, { id: row.app_id, slug: row.app_slug }, row.issue_number, deps);
  }
}

function publishedSubject(row) {
  return securityKind(row.kind) ? { publishedKey: row.subject?.materialKey, publishedFixer: row.fixer } : {};
}

async function closeRow(pool, row, deps, { reason = 'cleared', comment = true } = {}) {
  const github = deps.github;
  const parsed = parseRepo(row.app_repo_url);
  if (row.issue_number && parsed && github.isEnabled() && row.issue_status !== 'closed') {
    if (comment) {
      await github.createIssueComment(parsed.owner, parsed.repo, row.issue_number,
        evidenceText.closingComment({ kind: KINDS[row.kind], signal: row }));
    }
    await github.closeIssue(parsed.owner, parsed.repo, row.issue_number, { reason: 'not_planned' });
    await pool.query(
      `UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = $2 AND kind = 'general'`,
      [row.app_id, row.issue_number]);
    await require('./work-state').touched(pool, [{ appId: Number(row.app_id), issueNumber: Number(row.issue_number) }]);
  }
  await pool.query(
    `UPDATE platform_signals SET state = 'closed', closed_at = NOW(), close_reason = $2 WHERE id = $1`,
    [row.id, reason]);
}

function defaultDeps() {
  return {
    github: require('./github'),
    budget: require('./github-budget'),
    observers: () => require('./platform-signal-observers'),
    bot: () => require('./homeroom-bot'),
    notifications: () => require('./notifications'),
  };
}

/**
 * One pass, on the leader (server.js, leader timer 'platform-signals'):
 * read every observer, raise what it sees and clear what it no longer sees,
 * then file, update and close. Never throws.
 */
async function sweep(pool, config, { deps = defaultDeps(), now = Date.now() } = {}) {
  const modeName = mode();
  if (modeName === 'off' || !pool) return { mode: modeName };
  // The sweep's lock is on the process's lock connection, never a pooled one:
  // the sweep queries the pool (src/db/session-locks.js).
  const locks = require('../db/session-locks');
  try {
    const out = await locks.ifSessionLockFree(pool, { text: 'platform-signals' }, () => sweepLocked(pool, config, { deps, now, modeName }));
    return out === locks.BUSY ? { mode: modeName, skipped: true } : out;
  } catch (err) {
    log.warn('platform-signals', 'Sweep failed', { err: err.message });
    return { mode: modeName, error: err.message };
  }
}

async function sweepLocked(pool, config, { deps, now, modeName }) {
  const board = await platformAppRow(pool);
  const out = { mode: modeName, raised: 0, cleared: 0, filed: 0, closed: 0, rewritten: 0 };
  // A pushed problem (an alert) is raised by whichever process took it,
  // without the board: it files on the platform's own.
  if (board) {
    await pool.query(`UPDATE platform_signals SET app_id = $1 WHERE app_id IS NULL AND state <> 'closed'`, [board.id]);
  }

  // 1. What the observers see now, and which of them could look.
  const { items, ok } = await deps.observers().observeAll(pool, { now });
  const seen = new Set();
  for (const item of items) {
    // Seen whether or not its write lands: a failed write must not read as
    // the problem having stopped.
    seen.add(fingerprintOf(item.kind, item.key));
    const r = await raise(pool, item, { boardAppId: board ? board.id : null });
    if (r) out.raised += 1;
  }

  // 2. What stopped: a read kind its observer no longer sees, a pushed kind
  //    gone stale, and a filed request somebody closed (a fix's merge).
  const { rows } = await pool.query(ROWS_TO_ACT_SQL);
  for (const row of rows) {
    const def = KINDS[row.kind];
    if (!def) continue;
    // Unknown time cannot confirm resolution. A still-observed finding
    // also breaks the quiet window if its refresh upsert failed above.
    if (securityKind(row.kind) && (!ok.has(row.kind) || seen.has(row.fingerprint)) && row.state === 'clearing') {
      await pool.query("UPDATE platform_signals SET state = 'open', cleared_at = NULL WHERE id = $1", [row.id]);
      row.state = 'open';
    }
    if (row.issue_number && row.issue_status === 'closed' && row.state !== 'pending') {
      await closeRow(pool, row, deps, { reason: 'closed', comment: false });
      out.closed += 1;
      row.state = 'closed';
      continue;
    }
    const gone = def.source === 'poll'
      ? ok.has(row.kind) && !seen.has(row.fingerprint)
      : Number(row.quiet_ms) > PUSH_STALE_MS;
    if (gone && (row.state === 'pending' || row.state === 'open')) {
      const c = await clear(pool, row.fingerprint);
      if (c) { out.cleared += 1; row.state = c.state; row.cleared_ms = 0; }
    }
  }

  // 3. File, rewrite and close.
  const allowed = kindsAllowed();
  const [{ rows: [filed] }, { rows: [boot] }] = await Promise.all([
    pool.query(FILED_RECENTLY_SQL), pool.query(LAST_BOOT_SQL),
  ]);
  let filedHour = Number(filed?.hour) || 0;
  let filedDay = Number(filed?.day) || 0;
  const release = boot?.ago_ms != null && Number(boot.ago_ms) < RELEASE_HOLD_MS;
  const budgetOk = deps.budget.budgetAllows('background');
  for (const row of rows) {
    if (row.state === 'closed') continue;
    const def = KINDS[row.kind];
    if (!def) continue;
    try {
      let held = { release, sourceUnavailable: securityKind(row.kind) && !ok.has(row.kind) };
      if (row.state === 'clearing' && row.issue_number && row.app_id) {
        const { rows: [h] } = await pool.query(HELD_OPEN_SQL, [row.app_id, row.issue_number, PERSON_RECENT_MS]);
        held = { ...held, proposal: !!h?.proposal, person: !!h?.person };
      }
      const capFull = filedHour >= MAX_FILED_PER_HOUR || filedDay >= MAX_FILED_PER_DAY;
      const rowMode = modeForKind(row.kind);
      const what = decide(row, { now, def, modeName: rowMode, allowed, held, capFull, budgetOk });
      if (what === 'record') {
        await pool.query(`UPDATE platform_signals SET state = 'open' WHERE id = $1 AND state = 'pending'`, [row.id]);
      } else if (what === 'file') {
        if (await fileRow(pool, config, row, deps)) {
          out.filed += 1; filedHour += 1; filedDay += 1;
        }
      } else if (what === 'close') {
        await closeRow(pool, row, deps);
        out.closed += 1;
      } else if (row.state === 'open' && row.issue_number && rowMode === 'file' && isMaterial(row)) {
        await rewriteBody(pool, row, deps);
        out.rewritten += 1;
      }
    } catch (err) {
      log.warn('platform-signals', 'Could not act on a signal', { fingerprint: row.fingerprint, err: err.message });
      await pool.query('UPDATE platform_signals SET last_error = $2 WHERE id = $1',
        [row.id, String(err.message || err).slice(0, 500)]).catch(() => {});
    }
  }
  return out;
}

// ── Reads for the rest of the platform ──────────────────────────────────

const FOR_TOPIC_SQL = `
  SELECT id, kind, title, fixer, state, first_seen_at, last_seen_at, occurrences, issue_number
    FROM platform_signals
   WHERE app_id = $1 AND topic_key = $2 AND state IN ('open', 'clearing')
     AND (muted_until IS NULL OR muted_until < NOW())
   ORDER BY first_seen_at DESC, id DESC
   LIMIT 20`;

/**
 * The open problems a topic page lists (GET /api/apps/:slug/topics/:key/
 * signals). Before filing is on, only full admins see them: in shadow mode
 * they are not requests yet.
 */
async function openForTopic(pool, { appId, topicKey, fullAdmin = false }) {
  if (mode() === 'off') return { signals: [] };
  const { rows } = await pool.query(FOR_TOPIC_SQL, [Number(appId), String(topicKey || '')]);
  const signals = rows
    .filter((r) => fullAdmin || (modeForKind(r.kind) === 'file' && r.issue_number))
    .map((r) => {
      const who = r.fixer === 'bot' && !botOn() ? 'person' : r.fixer;
      return {
        id: Number(r.id),
        kind: r.kind,
        title: r.title,
        who,
        whoText: WHO_TEXT[who],
        state: r.state,
        since: new Date(r.first_seen_at).toISOString(),
        lastSeen: new Date(r.last_seen_at).toISOString(),
        occurrences: Number(r.occurrences) || 1,
        issueNumber: r.issue_number == null ? null : Number(r.issue_number),
        adminSection: fullAdmin ? (KINDS[r.kind]?.admin || 'status') : null,
      };
    });
  return { signals };
}

/**
 * The requests on a board the bot must leave to people: a person or infra
 * signal, and a bot signal past the bot's slots (homeroom-bot.js
 * issueHolders). [{ n, since }]. Empty when the table cannot be read.
 */
async function heldIssues(pool, appId) {
  try {
    const { rows } = await pool.query(
      `SELECT issue_number AS n, first_seen_at AS since FROM (
         SELECT issue_number, first_seen_at, fixer,
                ROW_NUMBER() OVER (PARTITION BY fixer = 'bot' ORDER BY filed_at, id) AS rank
           FROM platform_signals
          WHERE app_id = $1 AND issue_number IS NOT NULL AND state = 'open'
       ) s
       WHERE s.fixer <> 'bot' OR s.rank > $2 OR $3::boolean IS NOT TRUE`,
      [Number(appId), BOT_SLOTS, botOn()],
    );
    return rows;
  } catch (err) {
    log.warn('platform-signals', 'Could not read the signal holds', { appId, err: err.message });
    return [];
  }
}

/** The signal behind one request, for the bot's triage, or null. */
async function forIssue(pool, appId, issueNumber) {
  try {
    const { rows } = await pool.query(
      `SELECT kind, fixer FROM platform_signals
        WHERE app_id = $1 AND issue_number = $2 AND state <> 'closed'
        ORDER BY id DESC LIMIT 1`,
      [Number(appId), Number(issueNumber)],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

/** Map<issueNumber, topicKey> of a board's signal requests (places, the Workshop). */
async function topicsByIssue(pool, appId) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (issue_number) issue_number, topic_key FROM platform_signals
        WHERE app_id = $1 AND issue_number IS NOT NULL AND topic_key IS NOT NULL
        ORDER BY issue_number, id DESC`,
      [Number(appId)],
    );
    return new Map(rows.map((r) => [Number(r.issue_number), r.topic_key]));
  } catch {
    return new Map();
  }
}

module.exports = {
  KINDS,
  TOPICS,
  WHO_TEXT,
  SWEEP_INTERVAL_MS,
  MAX_FILED_PER_HOUR,
  MAX_FILED_PER_DAY,
  BOT_SLOTS,
  REOPEN_MS,
  PUSH_STALE_MS,
  mode,
  modeForKind,
  kindsAllowed,
  botOn,
  fingerprintOf,
  normalizeItem,
  decide,
  isMaterial,
  machineTopic,
  raise,
  clear,
  mute,
  noteHeartbeat,
  sweep,
  openForTopic,
  heldIssues,
  forIssue,
  topicsByIssue,
};
