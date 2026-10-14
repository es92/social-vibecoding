'use strict';

/**
 * The platform's processes, and what each one is doing that no other may
 * adopt, tear down, duplicate or call idle (docs/plans/draining-releases.md).
 *
 * A release no longer cuts the Pod it replaces: that Pod hands leadership
 * over, finishes what it started and exits when it holds nothing. For as
 * long as it drains, two processes (or more) run live work at once, and
 * every "is this session busy?" that read one process's memory would answer
 * for one of them only. So each process says what it holds here, and the
 * readers answer for every live one.
 *
 * PROCESSES. One row each in platform_processes, written at start, beaten
 * every HEARTBEAT_MS, marked `draining` (with its deadline) when shutdown
 * begins and deleted as it exits. A row whose beat is older than
 * LIVE_SECONDS is a process that is gone, whatever it says; the leader reaps
 * such rows (`reap`), and their holds with them.
 *
 * HOLDS. `hold(kind, ref)` says this process is doing `kind` for `ref` (a
 * session's turn, a preview build, a shots run, ...) and returns the release.
 * Holds are counted per process: the first writes the row, the last release
 * removes it, in order, retried until the database takes them, and the whole
 * set is written again with every beat, so a lost write is at most one beat
 * old. In memory first: a hold taken before `start` (or in a test that never
 * starts the registry) is this process's alone, as every registry was before.
 *
 * READING. `heldElsewhere(kind, ref)` is synchronous and answers from a copy
 * of the other live processes' holds, read every MIRROR_MS, for the readers
 * that answered from memory before (isSessionBusy and its kin): at most one
 * refresh behind. `holders(kind, ref)` reads the database, for a decision that
 * must be exact: adopting, redoing or tearing down someone's work.
 */

const crypto = require('crypto');
const os = require('os');
const log = require('./logger');
const { successorRoles } = require('./process-role');

const HEARTBEAT_MS = 10 * 1000;
// A process that has not beaten for this long is gone (four beats missed).
const LIVE_SECONDS = 45;
const MIRROR_MS = 2 * 1000;
// Rows the leader deletes: long gone, so nothing could still read them as live.
const REAP_AFTER_SECONDS = 10 * 60;
const WRITE_RETRY_MS = [500, 2000, 5000];

const KINDS = Object.freeze([
  'session',        // a turn or an operation on a dev session (active-workers.js)
  'staging_build',  // a preview build (staging.js)
  'capture',        // a checks capture (visuals.js)
  'sync',           // a sync of a session's branch with main (sync-main.js)
  'handoff',        // a hand-off pipeline (handoff-pipeline.js)
  'shots',          // a before & after shots run, by session (shots-orchestrator.js)
  'teardown',       // an app being torn down (app-teardown.js)
  'deploy',         // a production deploy, by app slug (app-deploy-status.js)
  'agent_turn',     // the Mayor's turn in an agent session (mayor/agent-turn.js)
  'app_creation',   // an app being created (app-creation-owner.js)
  'redeploy',       // an owed redeploy being given (owed-redeploy.js)
  'shots_eval',     // a shots eval trial (shots-eval-runner.js)
  'global_turn',    // a Global Chat turn (routes/global-chat.js)
  'bench_trial',    // a bench trial run here (bench/lane.js)
  'dm_defer',       // a DM answer this process will ask again, by message id: a MARKER (homeroom-bot-mayor.js)
  'dm_answer',      // that answer being asked again now, by message id (homeroom-bot-mayor.js)
  'app_heal',       // an app being healed, by slug (app-heal.js)
  'drift_rebuild',  // an app being rebuilt from main, by app id (main-drift-poller.js)
  'warm',           // a session's worker this process keeps warm (worker.js): a MARKER
  'merge_pass',     // an app's merge queue pass, by app id (merge-queue.js)
  'merge_resolve',  // a proposal's conflict resolution in that pass, by session id (merge-queue.js)
]);
const KNOWN = new Set(KINDS);
// What a process has rather than does: another process reads it (a worker
// warm here is not an orphan there, nor one to evict), but a drain does not
// wait for it, and it is not counted as work (localCount, localSnapshot).
const MARKERS = new Set(['warm', 'dm_defer']);

const ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

let pool = null;
let started = false;
let role = 'all';
let heartbeatTimer = null;
let mirrorTimer = null;
let draining = null; // { since, deadline } once shutdown has begun

// key -> count, for this process. key = `${kind}\u0000${ref}`
const local = new Map();
// key -> Set(processId), for every other live process (the mirror).
let others = new Map();
let mirrorAt = 0;

// Writes, one after another, so a release never lands before its hold.
let writes = Promise.resolve();

function keyOf(kind, ref) {
  return `${kind}\u0000${ref}`;
}

function splitKey(key) {
  const at = key.indexOf('\u0000');
  return { kind: key.slice(0, at), ref: key.slice(at + 1) };
}

function refOf(ref) {
  if (ref === null || ref === undefined || ref === '') throw new Error('a hold needs a ref');
  return String(ref);
}

function checkKind(kind) {
  if (!KNOWN.has(kind)) throw new Error(`unknown hold kind: ${kind}`);
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

// Queue a write; retried a few times, then left to the next beat's full write.
function queue(label, fn) {
  if (!started || !pool) return writes;
  writes = writes.then(async () => {
    for (let i = 0; ; i += 1) {
      try { await fn(pool); return; } catch (err) {
        if (i >= WRITE_RETRY_MS.length || !started) {
          log.warn('processes', 'A hold write failed; the next beat writes it again', { label, err: err.message });
          return;
        }
        await sleep(WRITE_RETRY_MS[i]);
      }
    }
  });
  return writes;
}

/**
 * This process holds `kind` for `ref` until the returned function is called
 * (idempotent). Never throws for a database problem: the hold is this
 * process's at once, and the database's as soon as it takes it.
 */
function hold(kind, ref) {
  checkKind(kind);
  const r = refOf(ref);
  const key = keyOf(kind, r);
  const n = local.get(key) || 0;
  local.set(key, n + 1);
  if (n === 0) {
    queue(`hold ${kind}`, (db) => db.query(
      `INSERT INTO process_holds (process_id, kind, ref) VALUES ($1, $2, $3)
       ON CONFLICT (process_id, kind, ref) DO NOTHING`, [ID, kind, r]));
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const left = (local.get(key) || 1) - 1;
    if (left > 0) { local.set(key, left); return; }
    local.delete(key);
    queue(`release ${kind}`, (db) => db.query(
      'DELETE FROM process_holds WHERE process_id = $1 AND kind = $2 AND ref = $3', [ID, kind, r]));
  };
}

/**
 * A Map (or Set) whose every key is also a hold of `kind`: the registries
 * that said "this process is doing X for key" change their constructor and
 * nothing else. `refFor(key)` turns a key into the hold's ref (default: the
 * key); a key with no ref is kept but holds nothing.
 */
function heldMap(kind, refFor = (key) => key) {
  checkKind(kind);
  const releases = new Map();
  const take = (key) => {
    if (releases.has(key)) return;
    try { releases.set(key, hold(kind, refFor(key))); } catch { /* no ref: nothing to hold */ }
  };
  const give = (key) => {
    const release = releases.get(key);
    releases.delete(key);
    if (release) release();
  };
  class HeldMap extends Map {
    set(key, value) { take(key); return super.set(key, value); }
    delete(key) { const out = super.delete(key); if (out) give(key); return out; }
    clear() { for (const key of [...releases.keys()]) give(key); super.clear(); }
  }
  return new HeldMap();
}

function heldSet(kind, refFor = (key) => key) {
  checkKind(kind);
  const releases = new Map();
  class HeldSet extends Set {
    add(key) {
      if (!releases.has(key)) {
        try { releases.set(key, hold(kind, refFor(key))); } catch { /* no ref: nothing to hold */ }
      }
      return super.add(key);
    }
    delete(key) {
      const out = super.delete(key);
      if (out) { const release = releases.get(key); releases.delete(key); if (release) release(); }
      return out;
    }
    clear() { for (const release of releases.values()) release(); releases.clear(); super.clear(); }
  }
  return new HeldSet();
}

/** Whether this process holds `kind` for `ref`. */
function heldHere(kind, ref) {
  return local.has(keyOf(kind, refOf(ref)));
}

/**
 * Whether another live process held `kind` for `ref` at the last refresh. A
 * copy older than LIVE_SECONDS (the database would not answer) vouches for
 * nobody: a session is not left busy for a process nobody can see.
 */
function heldElsewhere(kind, ref) {
  return heldElsewhereBy(kind, ref).length > 0;
}

/** The other live processes holding `kind` for `ref`, from the mirror. */
function heldElsewhereBy(kind, ref) {
  if (!started) return [];
  if (Date.now() - mirrorAt > LIVE_SECONDS * 1000) return [];
  const set = others.get(keyOf(kind, refOf(ref)));
  return set ? [...set] : [];
}

/**
 * Resolves once no other live process holds `kind` for `ref` (read from the
 * mirror, so up to MIRROR_MS late), or after `timeoutMs` (default: never).
 * Never rejects. For a caller that waits for someone's work to end before
 * taking the session over, as it would wait for its own.
 */
function whenReleasedElsewhere(kind, ref, { timeoutMs = 0, pollMs = MIRROR_MS } = {}) {
  const r = refOf(ref);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  return new Promise((resolve) => {
    const check = () => {
      if (!heldElsewhere(kind, r) || Date.now() >= deadline) { resolve(); return; }
      const t = setTimeout(check, pollMs);
      t.unref?.();
    };
    check();
  });
}

/** Here or elsewhere, as far as this process can say without a query. */
function heldAnywhere(kind, ref) {
  return heldHere(kind, ref) || heldElsewhere(kind, ref);
}

/** The refs of `kind` other live processes held at the last refresh. */
function refsElsewhere(kind) {
  const out = [];
  if (!started || Date.now() - mirrorAt > LIVE_SECONDS * 1000) return out;
  for (const [key, set] of others) {
    if (!set.size) continue;
    const k = splitKey(key);
    if (k.kind === kind) out.push(k.ref);
  }
  return out;
}

/**
 * The live processes holding `kind` (or any of several kinds) for `ref`, this
 * one included, read from the database: for a decision that adopts, redoes or
 * tears down. Rejects on a database error; a caller that cannot tell must not
 * act. Before the registry starts, only this process's own holds count.
 */
async function holders(kind, ref, db = pool) {
  const kinds = Array.isArray(kind) ? kind : [kind];
  kinds.forEach(checkKind);
  const r = refOf(ref);
  const ids = kinds.some((k) => heldHere(k, r)) ? [ID] : [];
  if (!db || !started) return ids;
  const { rows } = await db.query(
    `SELECT DISTINCT h.process_id FROM process_holds h
       JOIN platform_processes p ON p.id = h.process_id
      WHERE h.kind = ANY($1::text[]) AND h.ref = $2 AND h.process_id <> $3
        AND p.heartbeat_at > NOW() - make_interval(secs => $4)`,
    [kinds, r, ID, LIVE_SECONDS]);
  return ids.concat(rows.map((row) => row.process_id));
}

/** How many things this process holds now: what its drain waits for. */
function localCount() {
  let n = 0;
  for (const [key, count] of local) n += count > 0 && !MARKERS.has(splitKey(key).kind) ? 1 : 0;
  return n;
}

/** What this process holds, by kind: [{ kind, ref }], for the drain's log. */
function localSnapshot(limit = 50) {
  return [...local.keys()].map(splitKey).filter((k) => !MARKERS.has(k.kind)).slice(0, limit);
}

async function refreshMirror() {
  if (!started || !pool) return;
  const { rows } = await pool.query(
    `SELECT h.kind, h.ref, h.process_id FROM process_holds h
       JOIN platform_processes p ON p.id = h.process_id
      WHERE h.process_id <> $1 AND p.heartbeat_at > NOW() - make_interval(secs => $2)`,
    [ID, LIVE_SECONDS]);
  const next = new Map();
  for (const row of rows) {
    const key = keyOf(row.kind, row.ref);
    if (!next.has(key)) next.set(key, new Set());
    next.get(key).add(row.process_id);
  }
  others = next;
  mirrorAt = Date.now();
}

// The row, and every hold this process has, written again: a beat heals a
// write the database refused, and a row the leader reaped while this process
// was stalled comes back.
function writeRow(db) {
  return db.query(
    `INSERT INTO platform_processes (id, release, role, host, ip, state, drain_started_at, drain_deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET heartbeat_at = NOW(), state = EXCLUDED.state,
       drain_started_at = EXCLUDED.drain_started_at, drain_deadline_at = EXCLUDED.drain_deadline_at`,
    [ID, process.env.GIT_SHA || null, role, os.hostname(), process.env.POD_IP || null,
      draining ? 'draining' : 'serving', draining?.since || null, draining?.deadline || null]);
}

async function beat() {
  if (!started || !pool) return;
  await writeRow(pool);
  const keys = [...local.keys()].map(splitKey);
  await queue('beat', (db) => db.query(
    `WITH mine AS (SELECT * FROM unnest($2::text[], $3::text[]) AS m(kind, ref)),
          gone AS (DELETE FROM process_holds h WHERE h.process_id = $1
                     AND NOT EXISTS (SELECT 1 FROM mine WHERE mine.kind = h.kind AND mine.ref = h.ref))
     INSERT INTO process_holds (process_id, kind, ref)
     SELECT $1, kind, ref FROM mine ON CONFLICT (process_id, kind, ref) DO NOTHING`,
    [ID, keys.map((k) => k.kind), keys.map((k) => k.ref)]));
}

function every(ms, fn, label) {
  const timer = setInterval(() => {
    fn().catch((err) => log.warn('processes', `${label} failed`, { err: err.message }));
  }, ms);
  timer.unref?.();
  return timer;
}

/**
 * Register this process and start beating and mirroring. `role` is what it
 * runs (services/process-role.js: 'all', 'web' or 'conductor'). Resolves once the first
 * beat and refresh are done; a database that will not take them is logged
 * and retried by the timers, never thrown: holds work in memory meanwhile.
 */
async function start({ pool: db, role: r = 'all' } = {}) {
  if (started) return;
  pool = db;
  role = r;
  // In a Kubernetes Pod the host is the Pod's name, and a Pod runs one
  // platform process: a row of the same host is this container's
  // predecessor, which died (an OOM kill, a failed liveness probe) and must
  // not be read as live, holding its sessions, for LIVE_SECONDS after its last
  // beat. Elsewhere one machine may run several (tests, local development).
  if (process.env.KUBERNETES_SERVICE_HOST) {
    try {
      const { rowCount } = await pool.query('DELETE FROM platform_processes WHERE host = $1 AND id <> $2', [os.hostname(), ID]);
      if (rowCount) log.info('processes', 'Removed the row of this Pod\'s previous process', { count: rowCount });
    } catch (err) {
      log.warn('processes', 'Could not remove this Pod\'s previous process', { err: err.message });
    }
  }
  // The row before any hold's write can reach the queue (a hold references
  // it); holds taken until now are written by the first beat, all at once.
  try { await writeRow(pool); } catch (err) {
    log.warn('processes', 'Could not register this process yet; the beat will', { err: err.message });
  }
  started = true;
  try {
    await beat();
    await refreshMirror();
  } catch (err) {
    log.warn('processes', 'Could not write this process\'s holds yet; the beat will', { err: err.message });
  }
  heartbeatTimer = every(HEARTBEAT_MS, beat, 'Process heartbeat');
  mirrorTimer = every(MIRROR_MS, refreshMirror, 'Reading other processes\' holds');
  log.info('processes', 'Process registered', { id: ID, role });
}

/** Shutdown has begun: refuse new work, finish this, by `deadline`. */
async function markDraining(deadline) {
  draining = { since: new Date(), deadline: deadline ? new Date(deadline) : null };
  if (!started || !pool) return;
  await pool.query(
    `UPDATE platform_processes SET state = 'draining', drain_started_at = $2, drain_deadline_at = $3,
            heartbeat_at = NOW() WHERE id = $1`, [ID, draining.since, draining.deadline]);
}

/**
 * How many live processes that could replace this one (process-role.js
 * successorRoles) began draining after it did: releases faster than work
 * finishes. The drain ends early when there are too many, rather than keep
 * one Pod per release.
 */
async function newerDraining() {
  if (!started || !pool || !draining) return 0;
  const { rows: [row] } = await pool.query(
    `SELECT count(*)::int AS n FROM platform_processes
      WHERE id <> $1 AND role = ANY($2::text[]) AND state = 'draining' AND drain_started_at > $3
        AND heartbeat_at > NOW() - make_interval(secs => $4)`,
    [ID, successorRoles(role), draining.since, LIVE_SECONDS]);
  return row?.n || 0;
}

/**
 * How many live processes that could replace this one (process-role.js
 * successorRoles: a conductor for a conductor, a web process for a web one,
 * an 'all' for either) started after it and are serving (not draining): a
 * successor that registers what it holds, so that this process may stop
 * leading and finish its work beside it. A process of a release from before
 * the registry writes no row: it is never counted, and a process it replaces
 * keeps the cutover it always had. Neither is one older than this one, nor
 * one stopping with it (docs/plans/draining-releases.md).
 */
async function servingOthers() {
  if (!started || !pool) return 0;
  const { rows: [row] } = await pool.query(
    `SELECT count(*)::int AS n FROM platform_processes p
      WHERE p.id <> $1 AND p.role = ANY($2::text[]) AND p.state = 'serving'
        AND p.heartbeat_at > NOW() - make_interval(secs => $3)
        AND p.started_at > COALESCE((SELECT started_at FROM platform_processes WHERE id = $1), '-infinity'::timestamptz)`,
    [ID, successorRoles(role), LIVE_SECONDS]);
  return row?.n || 0;
}

/** The leader's sweep: delete rows (and so holds) of processes long gone. */
async function reap(db = pool) {
  if (!db) return 0;
  const { rowCount } = await db.query(
    'DELETE FROM platform_processes WHERE heartbeat_at < NOW() - make_interval(secs => $1)', [REAP_AFTER_SECONDS]);
  return rowCount || 0;
}

/** Live processes, for the admin console and the logs. */
async function list(db = pool) {
  if (!db) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.release, p.role, p.host, p.state, p.started_at, p.heartbeat_at,
            p.drain_started_at, p.drain_deadline_at,
            (SELECT count(*)::int FROM process_holds h WHERE h.process_id = p.id) AS holds
       FROM platform_processes p
      WHERE p.heartbeat_at > NOW() - make_interval(secs => $1)
      ORDER BY p.started_at`, [LIVE_SECONDS]);
  return rows;
}

/**
 * The last step before exit: this process's row goes, and its holds with it,
 * so whatever it leaves is free for the next leader at once rather than after
 * LIVE_SECONDS. Bounded by the caller.
 */
async function stop() {
  if (!started) return;
  started = false;
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  clearInterval(mirrorTimer); mirrorTimer = null;
  const db = pool;
  await writes.catch(() => {});
  if (db) await db.query('DELETE FROM platform_processes WHERE id = $1', [ID]).catch((err) => {
    log.warn('processes', 'Could not remove this process\'s row; it lapses on its own', { err: err.message });
  });
  others = new Map();
}

/** Tests: forget everything, as a fresh process would know it. */
function _reset() {
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  clearInterval(mirrorTimer); mirrorTimer = null;
  started = false;
  pool = null;
  role = 'all';
  draining = null;
  local.clear();
  others = new Map();
  mirrorAt = 0;
  writes = Promise.resolve();
}

module.exports = {
  ID,
  KINDS,
  MARKERS,
  HEARTBEAT_MS,
  LIVE_SECONDS,
  MIRROR_MS,
  REAP_AFTER_SECONDS,
  hold,
  heldMap,
  heldSet,
  heldHere,
  heldElsewhere,
  heldElsewhereBy,
  heldAnywhere,
  whenReleasedElsewhere,
  refsElsewhere,
  holders,
  localCount,
  localSnapshot,
  start,
  markDraining,
  newerDraining,
  servingOthers,
  reap,
  list,
  stop,
  refreshMirror,
  beat,
  get role() { return role; },
  get draining() { return draining; },
  get started() { return started; },
  get mirrorAt() { return mirrorAt; },
  flush: () => writes,
  _reset,
};
