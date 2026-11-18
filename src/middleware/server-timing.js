'use strict';

// What a request cost, said on its own response (#6792):
//
//   Server-Timing: db;dur=41.2;desc="n=17", total;dur=96.4
//
// `db` is the time its database queries took, added up, and how many there
// were; `total` is from the request's arrival to its first byte. The
// browser's network panel draws both, so a handler that awaits twenty
// queries one after another can be read off any page load, and a change to
// one can be measured there. Queries run together count their full time
// each, so `db` can be more than `total`.
//
// Only an /api/ response that succeeded (or a 304) carries it. A refusal
// says nothing: a 404 for "no such project" and one for "not yours" must
// stay alike, and a query count would tell them apart. Nothing under
// /api/auth/ carries it either, for the same reason.
//
// The count follows the request through an AsyncLocalStorage. A body
// parser reads the request from its socket's events, outside that context,
// so `resumeServerTiming` (mounted after the parsers) enters it again.

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const requests = new AsyncLocalStorage();
const INSTRUMENTED = Symbol('serverTimingInstrumented');

function headerValue(cost, startedAt, now = performance.now()) {
  return `db;dur=${cost.dbMs.toFixed(1)};desc="n=${cost.queries}", total;dur=${(now - startedAt).toFixed(1)}`;
}

function carriesTiming(req, status) {
  const path = req.path || '';
  return path.startsWith('/api/') && !path.startsWith('/api/auth/') && status < 400;
}

function serverTiming() {
  return function serverTimingMiddleware(req, res, next) {
    if (!(req.path || '').startsWith('/api/')) return next();
    const cost = { queries: 0, dbMs: 0 };
    const startedAt = performance.now();
    req.serverTimingCost = cost;
    const writeHead = res.writeHead;
    res.writeHead = function timedWriteHead(...args) {
      res.writeHead = writeHead;
      try {
        const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
        if (!res.headersSent && carriesTiming(req, status)) {
          res.setHeader('Server-Timing', headerValue(cost, startedAt));
        }
      } catch { /* a response is never lost to its own measurement */ }
      return writeHead.apply(this, args);
    };
    return requests.run(cost, next);
  };
}

function resumeServerTiming(req, res, next) {
  const cost = req.serverTimingCost;
  if (!cost || requests.getStore() === cost) return next();
  return requests.run(cost, next);
}

// One query against `cost`: counted when it settles, however it was called
// (a promise, a callback, or a submittable such as a cursor, which is
// counted with no time).
function timed(cost, query, self, args) {
  const startedAt = performance.now();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    cost.queries += 1;
    cost.dbMs += performance.now() - startedAt;
  };
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    args[args.length - 1] = function timedCallback(...answer) { settle(); return last.apply(this, answer); };
    return query.apply(self, args);
  }
  let out;
  try { out = query.apply(self, args); } catch (err) { settle(); throw err; }
  if (out && typeof out.then === 'function') out.then(settle, settle);
  else cost.queries += 1;
  return out;
}

// Count what a pg Pool runs for the request that asked. `pool.query` is
// counted where it is called. A client taken with `await pool.connect()`
// has its queries counted for the request that took it, until it is given
// back. Both read the request when they are CALLED: a waiting checkout is
// handed its client from whichever request released one, and must not be
// counted against that one. The callback form of connect is the pool's own
// (pool.query uses it) and passes through.
function instrumentPool(pool) {
  if (!pool || pool[INSTRUMENTED]) return pool;
  pool[INSTRUMENTED] = true;
  const query = pool.query;
  const connect = pool.connect;
  pool.query = function timedPoolQuery(...args) {
    const cost = requests.getStore();
    return cost ? timed(cost, query, this, args) : query.apply(this, args);
  };
  pool.connect = function timedConnect(...args) {
    const cost = requests.getStore();
    if (!cost || typeof args[0] === 'function') return connect.apply(this, args);
    return connect.apply(this, args).then((client) => {
      if (!client || typeof client.query !== 'function') return client;
      const own = Object.prototype.hasOwnProperty.call(client, 'query');
      const clientQuery = client.query;
      const release = client.release;
      client.query = function timedClientQuery(...queryArgs) { return timed(cost, clientQuery, this, queryArgs); };
      client.release = function timedRelease(...releaseArgs) {
        if (own) client.query = clientQuery; else delete client.query;
        client.release = release;
        return release.apply(this, releaseArgs);
      };
      return client;
    });
  };
  return pool;
}

module.exports = { serverTiming, resumeServerTiming, instrumentPool, headerValue, carriesTiming };
