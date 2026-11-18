const { Pool } = require('pg');
const log = require('../services/logger');
const { isConnectionLimitError } = require('./connection-census');
const { connectionName, connectionOptions, POOL_IDLE_MS } = require('./connection-options');

let pool;

function getPool(config) {
  if (!pool) {
    // `max` defaults to pg's built-in 10; config.dbPoolMax lets prod widen
    // it so many concurrent SSE turns + staging DB work don't queue on a
    // starved pool, and narrows it in a staging preview, which shares one
    // Postgres server with the whole fleet (#1771). idleTimeoutMillis lets
    // the pool shed idle connections back down after a burst — but only for
    // a connection nothing reuses, which is why a preview running the fleet
    // sweepers on a timer never shed any.
    //
    // NO JIT (21 Oct 2026). Postgres compiles a query to machine code when the
    // planner's ESTIMATE crosses jit_above_cost, and inlines and optimizes it
    // past 500,000, on every execution. Our estimates are inflated by
    // correlated subqueries that mostly never run, so the notifications feed
    // did ~43 ms of work and spent 2.9 s compiling it (EXPLAIN ANALYZE on the
    // replica); pg_stat_statements on the primary had compiling as ~99% of
    // every compiled statement's time, 14,610 s since 9 Sep. JIT pays off for
    // long analytic scans, which the web's queries are not.
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax || 10,
      idleTimeoutMillis: POOL_IDLE_MS,
      ...connectionOptions(config, { name: connectionName('main'), extra: { jit: 'off' } }),
    });
    pool.on('error', (err) => {
      // #1771: name the one failure that is not this process's fault. A
      // server-side refusal means the shared Postgres is out of backends,
      // and reporting it as "unexpected" is how it gets read as an app bug
      // — which is exactly what happened to a proposal's declared checks.
      if (isConnectionLimitError(err)) {
        log.error('db', 'Postgres refused a connection: the server is at max_connections', {
          message: err.message,
          code: err.code,
          poolMax: config.dbPoolMax || 10,
        });
        return;
      }
      log.error('db', 'Unexpected pool error', { message: err.message });
    });
    // Each request's queries are counted for its Server-Timing header.
    require('../middleware/server-timing').instrumentPool(pool);
  }
  return pool;
}

// A draining process (server.js drainUntilIdle) starts no new work: its pool
// shrinks to DRAIN_DB_POOL_MAX: connections beyond it close (idle ones now,
// busy ones when given back), and none is opened past it again. Two releases
// draining per role are budgeted at this size, not at the serving one (item
// 4: workflow-foundation design-item4-connections.md).
function shrinkForDrain(config) {
  if (!pool) return null;
  return require('./connection-options').shrinkPool(pool, (config && config.drainDbPoolMax) || 4);
}

// What it still holds above its drain size (server.js drainUntilIdle).
function drainExcess() {
  return require('./connection-options').poolExcess(pool);
}

module.exports = { getPool, shrinkForDrain, drainExcess };
