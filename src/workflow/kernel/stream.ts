// The event stream: producers append; routes may wait for the outcome.

import { WorkflowInputError, assertJson } from './machine.ts';
import type { Machine } from './machine.ts';
import type { EventOutcome, Logger, Pool, PoolClient, Queryable, Source } from './types.ts';

export interface AppendOptions {
  requestKey: string;
  source: Source;
  actor?: string | null;
  causedBy?: number | null;
  appId?: number | null;
  db?: Queryable;          // append inside the caller's transaction
}

export async function append(
  db: Queryable,
  machine: Machine<any, any> | string,
  key: string,
  event: { type: string; payload?: unknown },
  opts: AppendOptions,
): Promise<number> {
  const name = typeof machine === 'string' ? machine : machine.name;
  const payload = event.payload === undefined ? {} : event.payload;
  if (typeof key !== 'string' || !key || key.length > 256) throw new WorkflowInputError('invalid_key', 'instance key is required');
  if (typeof opts.requestKey !== 'string' || !opts.requestKey || opts.requestKey.length > 512) {
    throw new WorkflowInputError('invalid_request_key', 'request key is required');
  }
  assertJson(payload);
  if (typeof machine !== 'string') {
    // Decode at the boundary so a producer hears about a bad payload now.
    const decoder = machine.events.get(event.type);
    if (!decoder) throw new WorkflowInputError('unknown_event', `${name} has no event ${event.type}`);
    try { decoder(payload); } catch (err) {
      throw new WorkflowInputError('invalid_payload', (err as Error).message);
    }
  }
  const { rows } = await (opts.db || db).query<{ id: string }>(
    `WITH ins AS (
       INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id)
     SELECT id, pg_notify('wf_events', $1) FROM ins`,
    [name, key, opts.appId ?? null, event.type, JSON.stringify(payload), JSON.stringify(opts.source),
      opts.actor ?? null, opts.requestKey, opts.causedBy ?? null],
  );
  return Number(rows[0]!.id);
}

export async function readOutcome(db: Queryable, eventId: number): Promise<EventOutcome | null> {
  const { rows } = await db.query(
    `SELECT id, status, result, reason, state_after, version_after, request_key, reply
       FROM wf_events WHERE id = $1`, [eventId]);
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status === 'processed' ? row.result : 'pending',
    eventId: Number(row.id),
    requestKey: row.request_key,
    reason: row.reason,
    state: row.state_after,
    version: row.version_after == null ? null : Number(row.version_after),
    reply: row.reply ?? null,
  };
}

// One LISTEN connection per process wakes sleepers early. Everything also
// works without it: every wait is bounded and re-reads the database.
//
// Pipeline slots sleep on `wf_events`, and each notification wakes ONE of
// them (the others would only race it for the same instance). A
// notification that finds no slot asleep is kept, so a slot that was busy
// when it came does not sleep through it.
const WAKE_ONE = new Set(['wf_events']);
const MAX_KEPT = 64;

// Outcome notifications seen since a watch began: a producer starts the
// watch before it appends, so an outcome that lands before it starts
// waiting is not missed, and its first read of the outcome is the one
// after the notification.
export interface OutcomeWatch {
  until(eventId: number, ms: number): Promise<boolean>;   // true: notified
  close(): void;
}

export class Signals {
  #pool: Pool;
  #log: Logger;
  #client: PoolClient | null = null;
  #giveBack: ((err?: Error) => void) | null = null;
  #sleepers = new Map<string, Set<(payload: string | null) => void>>();
  #kept = new Map<string, number>();
  #watches = new Set<{ seen: Set<string>; wake: (() => void) | null }>();
  #stopped = false;

  constructor(pool: Pool, log: Logger) { this.#pool = pool; this.#log = log; }

  get listening(): boolean { return this.#client !== null; }

  async start(): Promise<void> {
    if (this.#client || this.#stopped) return;
    let giveBack: ((err?: Error) => void) | null = null;
    try {
      const client = await this.#pool.connect();
      const onNotification = (msg: { channel: string; payload?: string }) => this.wake(msg.channel, msg.payload);
      // The connection goes back to the pool once. Our listeners come off
      // with it: the pool watches an idle connection itself, and one of ours
      // left on it released it a second time when it errored later (a
      // database dropped after stop()), which pg-pool throws on.
      let released = false;
      const onError = (err: Error) => {
        this.#log.warn('workflow', 'signal connection lost', { message: err.message });
        if (this.#client === client) this.#client = null;
        giveBack!(err);
        // Sleepers waiting for notifications go back to polling until then.
        this.wakeAll();
        if (!this.#stopped) setTimeout(() => { this.start(); }, 1000).unref?.();
      };
      giveBack = (err?: Error) => {
        if (released) return;
        released = true;
        client.removeListener?.('notification', onNotification);
        client.removeListener?.('error', onError);
        client.release(err);
      };
      client.on?.('notification', onNotification);
      client.on?.('error', onError);
      await client.query('LISTEN wf_events');
      await client.query('LISTEN wf_outcome');
      await client.query('LISTEN wf_work');
      await client.query('LISTEN wf_timer');
      this.#client = client;
      this.#giveBack = giveBack;
      // Whatever was announced while nobody listened: look once.
      this.wakeAll();
    } catch (err) {
      giveBack?.(err as Error);
      this.#log.warn('workflow', 'signal connection unavailable; polling only', { message: (err as Error).message });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const client = this.#client;
    const giveBack = this.#giveBack;
    this.#client = null;
    this.#giveBack = null;
    this.wakeAll();
    if (client) {
      await client.query('UNLISTEN *').catch(() => {});
      giveBack?.();
    }
  }

  // Wakes every sleeper, whatever it waits for: the connection was lost or
  // regained, or the runtime stops.
  wakeAll(): void {
    for (const set of [...this.#sleepers.values()]) for (const fn of [...set]) fn(null);
    for (const w of this.#watches) w.wake?.();
  }

  wake(channel: string, payload?: string): void {
    if (channel === 'wf_outcome') {
      for (const w of this.#watches) { w.seen.add(payload ?? ''); w.wake?.(); }
    }
    if (WAKE_ONE.has(channel)) {
      const set = this.#sleepers.get(channel);
      const first = set?.values().next().value;
      if (first) first(payload ?? '');
      else this.#kept.set(channel, Math.min(MAX_KEPT, (this.#kept.get(channel) ?? 0) + 1));
      return;
    }
    for (const name of [channel, `${channel}:${payload ?? ''}`]) {
      const set = this.#sleepers.get(name);
      if (set) for (const fn of [...set]) fn(payload ?? '');
    }
  }

  // Resolves on a notification on `channel` (or `channel:payload`) that
  // `accept` takes (default: any), or after ms.
  sleep(channel: string, ms: number, accept?: (payload: string) => boolean): Promise<void> {
    const kept = this.#kept.get(channel) ?? 0;
    if (kept > 0 && !accept) {
      this.#kept.set(channel, kept - 1);
      return Promise.resolve();
    }
    if (this.#stopped) return new Promise((resolve) => { setTimeout(resolve, ms); });
    return new Promise((resolve) => {
      let set = this.#sleepers.get(channel);
      if (!set) this.#sleepers.set(channel, set = new Set());
      const done = (payload: string | null = null) => {
        if (payload !== null && accept && !accept(payload)) return;
        clearTimeout(timer);
        set!.delete(done);
        if (!set!.size) this.#sleepers.delete(channel);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }

  // Null when not listening: the caller polls instead.
  watch(): OutcomeWatch | null {
    if (!this.#client || this.#stopped) return null;
    const w = { seen: new Set<string>(), wake: null as (() => void) | null };
    this.#watches.add(w);
    return {
      until: (eventId, ms) => new Promise((resolve) => {
        const id = String(eventId);
        const check = () => {
          if (!w.seen.delete(id)) return false;
          clearTimeout(timer); w.wake = null; resolve(true);
          return true;
        };
        const timer = setTimeout(() => { w.wake = null; resolve(false); }, ms);
        w.wake = () => { if (!check() && this.#stopped) { clearTimeout(timer); w.wake = null; resolve(false); } };
        check();
      }),
      close: () => { this.#watches.delete(w); },
    };
  }
}

// Wait up to waitMs for the event's outcome; 'pending' means the caller
// answers 202 with the request key, and a retry with that key replays.
// With a watch (started before the append), the outcome is read once its
// notification arrives, or each second as a fallback; without one, polled.
export async function waitForOutcome(
  db: Queryable, signals: Signals | null, eventId: number, waitMs: number, watch: OutcomeWatch | null = null,
): Promise<EventOutcome> {
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      if (watch) await watch.until(eventId, Math.max(0, Math.min(deadline - Date.now(), 1000)));
      const outcome = await readOutcome(db, eventId);
      if (!outcome) throw new Error(`workflow event ${eventId} does not exist`);
      const left = deadline - Date.now();
      if (outcome.status !== 'pending' || left <= 0) return outcome;
      if (watch) continue;
      const nap = Math.min(left, 250);
      if (signals) await signals.sleep(`wf_outcome:${eventId}`, nap);
      else await new Promise((r) => setTimeout(r, nap));
    }
  } finally {
    watch?.close();
  }
}
