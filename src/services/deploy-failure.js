'use strict';

/**
 * Shared classifier for build/deploy failures (issue #416).
 *
 * Every production deploy path (a new project's setup, app-creator.js,
 * and deployProduction) funnels its caught error through classify() to get
 * a persistable `apps.last_failure` record:
 *
 *   { stage, reason, log, at, sha }
 *
 *   stage  : 'database' | 'repo' | 'clone' | 'build' | 'start' |
 *            'healthcheck' | 'timeout' | 'other'
 *   reason : concise human-readable line, <= 280 chars (same budget as
 *            chat_sessions.check_error_detail)
 *   log    : raw tail of the docker build output / container boot logs,
 *            ANSI-stripped, capped at 16 kB
 *   at     : ISO timestamp of the failure
 *   sha    : commit the failed deploy was building, when known
 *
 * The error-line extraction here is the former
 * visuals.summarizeBootFailure — moved so both the proposal-checks path
 * (staging) and the production deploy path share one implementation.
 * visuals.js re-exports summarizeBootFailure from this module, so the
 * legacy string shape is unchanged for existing consumers.
 */

const { mentionsConnectionLimit, connectionExhaustionMessage } = require('../db/connection-census');
// #2504: the redaction rules directly, NOT through services/logger. This
// record goes to the database, and dozens of test files stub the logger
// with a bare {info,warn,error,debug} — reaching the redactor through that
// facade meant every one of those stubs silently deleted it.
const { redactString } = require('./log-redaction');

const MAX_REASON = 280;
const MAX_LOG = 16 * 1024;

// A new repository GitHub refused with its secondary limit, after the
// setup's waits (services/repo-create-queue.js). GitHub's own text is about
// scraping and its terms of service; the server log keeps it.
const REPO_SLOW_DOWN = 'GitHub is limiting how fast new projects can be made. Try again in a few minutes.';

// Matches the "most specific error line" heuristic used by the staging
// checks pipeline — the app's own crash message beats generic wrapper text.
const ERR_LINE_RE = /(^error\b|Error:|errno|ECONNREFUSED|EADDRINUSE|panic|Unhandled|SQLSTATE|syntax error|does not exist|no unique or exclusion constraint|relation .* does not exist|cannot |failed)/i;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

// ANSI-strip, REDACT, then keep only the last MAX_LOG bytes. Used at
// capture time (docker.buildImage) and defensively again at persist time.
//
// #2504: the redaction is the point. This record is written to
// `apps.last_failure` and handed whole — `log` included — to any
// collaborator, the creator or any admin by GET /api/apps/:slug. It never
// passes through a log line, so it took none of the scrubbing #30 built
// into services/logger.js for exactly this hazard ("a single
// log.warn('docker', err.message) where err.cmd happens to contain a key
// shouldn't be a security incident").
//
// What it holds is not hypothetical: `classify()` below builds from
// `err.buildLog`, `err.containerLogs` and `err.stderr`, and this file's own
// `stripCommandFailedPrefix` comment notes that a rejected execFile carries
// its ENTIRE argv — which services/docker.js builds as one `-e NAME=value`
// per environment variable, i.e. every secret the app declares.
//
// Redacting HERE rather than on read means the database never holds the
// value at all. Reusing the logger's pattern list rather than writing a
// second one means the two can never drift apart.
function truncateLog(s, max = MAX_LOG) {
  const clean = redactString(stripAnsi(s).trim());
  return clean.length > max ? clean.slice(-max) : clean;
}

// #2504: redact here too. `reason` is the 280-character line shown on the
// app card's tooltip, and several paths below build it from `err.message`
// directly — which never passed through truncateLog and so was never
// scrubbed at all.
function capReason(reason) {
  const r = redactString(String(reason || '').trim());
  return r.length > MAX_REASON ? `${r.slice(0, MAX_REASON - 1)}…` : r;
}

// Last error-looking line of a log blob (falls back to the last
// non-empty line). Empty string when the blob is empty.
function pickReasonLine(logs) {
  const lines = String(logs || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERR_LINE_RE.test(lines[i])) return lines[i];
  }
  return lines.length ? lines[lines.length - 1] : '';
}

// child_process.execFile formats a rejection's message as
//   `Command failed: <the entire argv>\n<stderr>`
// and a `docker run` argv is every -e env var the container gets. That is
// kilobytes of command line in front of the one line that matters, so a
// 280-char reason was nothing but a truncated command and the daemon's
// actual complaint never reached the proposal author. Drop the command
// line and keep what the process said on stderr.
function stripCommandFailedPrefix(message) {
  const text = String(message || '');
  if (!/^Command failed:/.test(text)) return text;
  const nl = text.indexOf('\n');
  const tail = nl === -1 ? '' : pickReasonLine(text.slice(nl + 1));
  return tail || text;
}

// ─── Infrastructure vs the diff (#1771) ────────────────────────────────
//
// A preview whose container cannot get a Postgres connection dies exactly
// like a preview with a broken migration: non-zero exit, boot logs, a
// healthcheck that never passes. The difference is invisible at this layer
// unless something looks for it, and because nothing did, the proposal
// author was handed "[exited] error: sorry, too many clients already" as
// their own build's failure. It was not. Every OTHER proposal in the fleet
// was about to fail the same way for the same reason.
//
// So look for it. Every blob the boot path can hand us is a candidate,
// because which one carries Postgres's complaint depends on how the app
// exits: a crash on first query puts it in containerLogs, a `docker run`
// the daemon refused puts it on stderr, and a rejected execFile buries it
// in the message.
function bootFailureIsInfrastructure(err) {
  if (!err) return false;
  return err.infrastructure === true || mentionsConnectionLimit(err.containerLogs)
    || mentionsConnectionLimit(err.stderr)
    || mentionsConnectionLimit(err.message);
}

// ─── The preview build's own error (#6536) ─────────────────────────────
//
// A BuildKit Job that fails gives checks nothing but the Job's name and
// "BackoffLimitExceeded" unless the Pod's log is read. The log says what the
// app's build actually printed ("Unexpected `**` at …index.tsx:104"), which
// is the difference between "wait for a retry" and "fix the code".
//
// The first error, not the last: a build stops at its first failure and the
// lines after it are the bundler's stack. Vite prints its "error during
// build" wrapper one line before the specific `file:line:col: ERROR: …`, so
// among consecutive Vite lines the more specific one wins.
const BUILD_ERROR_RE = /\bERROR:|error TS\d+|SyntaxError|Unexpected|Transform failed|error during build/;
const BUILD_ERROR_SPECIFIC_RE = /:\d+:\d+:\s*(?:ERROR|error)\b/;
const BUILD_ERROR_LINE_MAX = 240;
const BUILD_ERROR_EXCERPT_LINES = 40;
const BUILD_ERROR_EXCERPT_MAX = 4000;

// The log up to and including its first error line, scrubbed, or null when
// this is not a failed build or the log has no error line at all (a timeout,
// an infrastructure failure, a log that was not captured).
function firstBuildError(err) {
  if (!err || !err.buildFailed || err.killed || !err.buildLog) return null;
  const lines = truncateLog(err.buildLog).split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (BUILD_ERROR_RE.test(lines[i])) { at = i; break; }
  }
  if (at === -1) {
    for (let i = 0; i < lines.length; i += 1) {
      if (ERR_LINE_RE.test(lines[i])) { at = i; break; }
    }
  }
  if (at === -1) return null;
  // The line the bundler names a file and position on is the useful one;
  // "error during build:" is its heading, a line or two above.
  for (let i = at; i < Math.min(lines.length, at + 6); i += 1) {
    if (BUILD_ERROR_SPECIFIC_RE.test(lines[i])) { at = i; break; }
  }
  const line = redactString(stripAnsi(lines[at]).trim()).slice(0, BUILD_ERROR_LINE_MAX);
  const excerptLines = lines.slice(Math.max(0, at - (BUILD_ERROR_EXCERPT_LINES - 1)), at + 1);
  let excerpt = redactString(stripAnsi(excerptLines.join('\n')).trim());
  if (excerpt.length > BUILD_ERROR_EXCERPT_MAX) excerpt = excerpt.slice(-BUILD_ERROR_EXCERPT_MAX);
  return { line, excerpt };
}

// Legacy shape: extract a concise, human-readable reason from a
// build/boot failure (docker.waitForHealthy attaches containerLogs /
// containerStatus to the thrown error). Kept byte-compatible with the
// old visuals.summarizeBootFailure for check_error_detail consumers.
function summarizeBootFailure(err) {
  // #6536: a preview build that failed has an error of its own, and it is
  // the only thing that tells its author what to fix.
  const build = firstBuildError(err);
  if (build) return capReason(`The preview build failed: ${build.line}`);
  // One exception to the byte-compatibility above, and it is the point of
  // #1771: when the boot logs show the shared Postgres refusing the
  // connection, the most specific error line is the WRONG answer. It is
  // true, it is about this container, and it still sends the author to
  // re-read a diff that was never involved. Say what happened instead.
  if (mentionsConnectionLimit(err?.containerLogs) || mentionsConnectionLimit(err?.stderr) || mentionsConnectionLimit(err?.message)) {
    return capReason(connectionExhaustionMessage(null, { where: 'started' }));
  }
  const logs = (err && err.containerLogs) ? String(err.containerLogs) : '';
  let reason = pickReasonLine(logs);
  // No container logs at all means the container never got far enough to
  // produce any — a `docker run` the daemon refused outright (a bad
  // --hostname, a name collision, an unsatisfiable resource limit). Its
  // explanation is on the rejection's stderr, nowhere else.
  if (!reason && err && err.stderr) reason = pickReasonLine(err.stderr);
  if (!reason) reason = (err && err.message) ? stripCommandFailedPrefix(err.message) : '';
  if (!reason) reason = 'staging preview failed to start';
  if (err && err.containerStatus) reason = `[${err.containerStatus}] ${reason}`;
  return capReason(reason);
}

// An image that names no USER runs as root, and app Pods run with
// runAsNonRoot and no runAsUser, so the kubelet refuses it before the
// process starts. Nothing on the platform's side changes that: the same
// commit fails the same way on every retry, and only a commit that changes
// the Dockerfile can go live (src/prompts/app-conventions.md). Goalio sat
// like that from 17 Sep to 15 Oct 2026, retried ~1,200 times a day, while
// its merges read as done and its previous version kept serving.
const ROOT_IMAGE = 'root_image';
const ROOT_IMAGE_REJECTION = /runAsNonRoot and image will run as root/;
const ROOT_IMAGE_FIX = "The app's image runs as root, so Kubernetes (runAsNonRoot) will not start it. "
  + 'Add `USER 1000:1000` to the final stage of its Dockerfile, with `COPY --chown=1000:1000` '
  + 'for files the app writes, and merge that change.';

function isRootImageRefusal(err) {
  if (!err) return false;
  const text = [err.message, err.terminalPodDetails, err.containerLogs].filter(Boolean).join('\n');
  return ROOT_IMAGE_REJECTION.test(text);
}

// Whether deploying `sha` would only repeat a refusal no retry can change:
// the recorded failure is this very commit's image running as root. A new
// commit, or a deploy asked for by hand, still goes ahead.
function waitsForNewCommit(lastFailure, sha) {
  const r = asRecord(lastFailure);
  if (!r || r.kind !== ROOT_IMAGE || !r.sha || !sha) return false;
  return String(r.sha).toLowerCase() === String(sha).toLowerCase();
}

// Map a caught deploy error onto { stage, reason, log }. `opts.stage`
// lets a call site that knows better (e.g. the git-clone wrapper) force
// the stage for errors that carry no marker of their own.
function classify(err, opts = {}) {
  if (err && err.healthcheckFailed) {
    return {
      stage: 'healthcheck',
      reason: isRootImageRefusal(err)
        ? capReason(`${err.containerStatus ? `[${err.containerStatus}] ` : ''}${ROOT_IMAGE_FIX}`)
        : summarizeBootFailure(err),
      log: truncateLog(err.containerLogs || ''),
      // Carried so the checks pipeline can record this as 'error' (retried,
      // escalated to the platform owner) rather than 'failing' (blamed on
      // the diff, sticky to the commit). Persisted records ignore it.
      infrastructure: bootFailureIsInfrastructure(err),
    };
  }
  if (err && err.buildFailed) {
    const log = truncateLog(err.buildLog || '');
    let reason;
    if (err.killed) {
      const seconds = Number.isFinite(err.buildTimeoutSeconds) && err.buildTimeoutSeconds > 0
        ? err.buildTimeoutSeconds : 300;
      reason = seconds % 60 === 0
        ? `Build timed out after ${seconds / 60} minute${seconds === 60 ? '' : 's'}`
        : `Build timed out after ${seconds} seconds`;
    } else {
      const line = pickReasonLine(log);
      reason = line ? `Build failed: ${line}` : `Build failed: ${err.message || 'unknown error'}`;
    }
    return { stage: 'build', reason: capReason(reason), log };
  }
  const stage = opts.stage
    || (err && err.repoFailed ? 'repo' : null)
    || (err && err.cloneFailed ? 'clone' : null)
    || 'other';
  // Clone timeouts / ENOENT-style failures carry no .stderr — fall back
  // to err.message, but prefer stderr when execFile captured any.
  const stderr = err && err.stderr ? truncateLog(err.stderr) : '';
  const message = (err && err.message) ? String(err.message) : 'deploy failed';
  // Same unwrapping as summarizeBootFailure: a rejected execFile puts its
  // entire argv in front of the real message, and `docker run`'s argv is
  // long enough to consume the whole 280-char budget on its own. Prefer the
  // process's own stderr line; failing that, drop the command line.
  const detail = pickReasonLine(stderr) || stripCommandFailedPrefix(message);
  const slowDown = stage === 'repo' && require('./github-budget').isSecondaryRateLimitError(err);
  const reason = capReason(
    slowDown ? REPO_SLOW_DOWN : stage === 'repo' ? `GitHub repo creation failed: ${detail}` : detail
  );
  return { stage, reason, log: stderr };
}

// Full apps.last_failure record for a caught deploy error.
function record(err, opts = {}) {
  const { stage, reason, log } = classify(err, opts);
  return {
    stage,
    reason,
    log,
    at: new Date().toISOString(),
    sha: opts.sha || null,
    ...(isRootImageRefusal(err) ? { kind: ROOT_IMAGE } : {}),
  };
}

// Synthetic record for failures that never produced an error object
// (creation watchdog, boot sweep, kickoff catches). Callers persist it
// with a COALESCE guard so it never clobbers a real captured failure.
function syntheticRecord(stage, reason) {
  return {
    stage,
    reason: capReason(reason),
    log: '',
    at: new Date().toISOString(),
    sha: null,
  };
}

// Is `next` the failure `prev` already recorded — the same commit failing at
// the same stage? A production rebuild that cannot succeed (a Dockerfile the
// build sandbox cannot build, a syntax error on main) fails identically on
// every retry, and the drift poller retries every tick; the people who can
// fix it need to hear about the incident once, not per attempt. Twenty-five
// "Deploy failed" pushes went out for one falling-sands commit in a night.
//
// Same sha, and the same stage when both records name one. A different
// stage on the same commit IS news (the build now passes but the container
// will not start). A record without a sha — a synthetic one, or the legacy
// string shape — never matches, so those keep notifying as before.
function sameIncident(prev, next) {
  const a = asRecord(prev);
  const b = asRecord(next);
  if (!a || !b || !a.sha || !b.sha) return false;
  if (String(a.sha).toLowerCase() !== String(b.sha).toLowerCase()) return false;
  return !a.stage || !b.stage || a.stage === b.stage;
}

function asRecord(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}

module.exports = {
  REPO_SLOW_DOWN,
  ROOT_IMAGE,
  ROOT_IMAGE_FIX,
  isRootImageRefusal,
  waitsForNewCommit,
  asRecord,
  classify,
  record,
  syntheticRecord,
  sameIncident,
  summarizeBootFailure,
  firstBuildError,
  bootFailureIsInfrastructure,
  truncateLog,
  stripAnsi,
  MAX_REASON,
  MAX_LOG,
};
