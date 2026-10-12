// Shared types of the workflow kernel. The kernel imports nothing from a
// workflow module; machines import these.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// The slice of node-postgres the kernel uses. Kept structural so the kernel
// needs no pg type package and tests can pass any pg Pool.
export interface QueryResult<R> { rows: R[]; rowCount: number | null }
export interface QueryConfig { text: string; values?: unknown[]; queryMode?: 'extended' }
export interface Queryable {
  query<R = any>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>>;
}
export interface PoolClient extends Queryable {
  release(destroy?: Error | boolean): void;
  on?(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on?(event: 'error', listener: (err: Error) => void): unknown;
  removeListener?(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  removeListener?(event: 'error', listener: (err: Error) => void): unknown;
}
export interface Pool extends Queryable { connect(): Promise<PoolClient> }

export interface Logger {
  info(scope: string, message: string, meta?: object): void;
  warn(scope: string, message: string, meta?: object): void;
  error(scope: string, message: string, meta?: object): void;
}

// Who produced an event.
export type Source =
  | { kind: 'route'; name?: string }
  | { kind: 'service'; workId: string; workKind: string; attempt: number }
  | { kind: 'timer'; setAtVersion: number }
  | { kind: 'message'; from: { machine: string; key: string; eventId: number } }
  | { kind: 'admin'; name?: string }
  | { kind: 'system'; name?: string };

// An event as a machine sees it: payload already decoded.
export interface Event<P = unknown> {
  id: number;
  type: string;
  payload: P;
  source: Source;
  actor: string | null;
  requestKey: string;
  appId: number | null;
  causedBy: number | null;
}

// A state as a machine sees it. `name` is the phase; `data` its payload.
export interface State<D = unknown> { name: string; data: D }

export interface TransitionContext {
  machine: string;
  key: string;
  appId: number | null;
  version: number;          // the instance version before this event
  now: Date;                // the transaction's clock; transitions never read Date.now()
}

export interface DomainWrite { type: string; [field: string]: unknown }
export interface WorkRequest {
  kind: string;
  key: string;
  input: Json;
  notBefore?: Date;
  // The key of an earlier item of the same kind on this instance: the new
  // item starts from that item's last checkpoint (a retry keeps the progress).
  continues?: string;
}
export interface MessageRequest {
  to: { machine: string; key: string };
  event: { type: string; payload: Json };
  appId?: number | null;
}
export interface TimerRequest { at: Date; event: { type: string; payload?: Json } }
export interface Notification { type: string; [field: string]: unknown }

// What browsers should hear. Pushes are published inside the transition's
// transaction (RuntimeOptions.publish) and reach them only if it commits:
// every web process relays them, whichever process decided. `kind` and
// `routing` say who may hear it; `data` is what they get.
export interface Push { kind: string; routing?: JsonObject; data: JsonObject }

export interface Outcome<S extends State = State> {
  next: S;
  writes?: DomainWrite[];
  work?: WorkRequest[];
  messages?: MessageRequest[];
  timer?: TimerRequest | null;   // undefined keeps the deadline, null clears it
  push?: Push[];
  notify?: Notification[];
}

// Guards and authorisation return true to pass or a rejection.
export interface Rejection { reject: string }
export type Check = true | Rejection;

export interface Transition<S extends State, F> {
  guard?: (state: S, event: Event<any>, facts: F, ctx: TransitionContext) => Check;
  to: (state: S, event: Event<any>, facts: F, ctx: TransitionContext) => Outcome<S>;
}
export interface Ignored { ignore: string }
export type TableEntry<S extends State, F> = Transition<S, F> | Ignored;

// A transaction handle for machine code: queries only. Transaction control
// and multi-statement text are refused, and the first error poisons it.
export interface Tx {
  query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type Decoder = (payload: unknown) => unknown;
export type Authorize<S extends State, F> = (event: Event<any>, facts: F, state: S) => Check;
// A domain write may add what browsers should hear about the rows it wrote.
export interface WriteContext extends TransitionContext { push(p: Push): void }
export type WriteHandler = (tx: Tx, write: any, ctx: WriteContext) => Promise<unknown>;
export type Notifier = (notification: any) => void | Promise<void>;

// What a machine module writes. Plain objects are authoring syntax only:
// defineMachine converts every table to a Map once, and the kernel reads
// only the Maps (so inherited keys such as `toString` are never entries).
export interface MachineDefinition<S extends State = State, F = unknown> {
  name: string;
  version: number;
  // Event types this machine receives, each with its payload decoder.
  // A decoder throws to refuse a payload (rejected as invalid_payload).
  events: Record<string, Decoder>;
  // Events that may create the instance (handled in the NONE row).
  create?: string[];
  terminal?: string[];
  decode: (row: { state: string; data: unknown }) => S;
  facts?: (tx: Tx, state: S, event: Event<any>, ctx: TransitionContext) => Promise<F>;
  authorize: Record<string, Authorize<S, F>>;
  // state name -> event type (or '*') -> transition or explicit ignore.
  transitions: Record<string, Record<string, TableEntry<S, F>>>;
  writes?: Record<string, WriteHandler>;
  project?: (tx: Tx, before: S, after: S, ctx: TransitionContext) => Promise<void>;
  // The answer for whoever produced the event, built in its transaction after
  // the writes and the projection. It is recorded with the event and its
  // receipt, so a replay returns the original answer, not today's. `facts`
  // are the ones the transition decided on, so an answer they already hold
  // (was this vote a retraction?) needs no query.
  reply?: (tx: Tx, event: Event<any>, after: S, ctx: TransitionContext, facts: F) => Promise<Json | undefined>;
  notifiers?: Record<string, Notifier>;
}

export interface WorkContext {
  workId: string;
  kind: string;
  key: string;
  input: any;
  attempt: number;
  resumeFrom: Json | null;               // the last checkpoint, if any
  checkpoint(value: Json): Promise<void>; // throws LeaseLost if the claim is gone
  signal: AbortSignal;
}

export interface WorkHandler {
  run(ctx: WorkContext): Promise<Json | void>;
  maxAttempts?: number;                   // default 5; an error with `permanent: true` is not retried
  backoffMs?: (attempt: number) => number;
  concurrency?: number;                   // per kind, in this process
  leaseMs?: number;
}

// What a producer gets back for an event.
export interface EventOutcome {
  status: 'accepted' | 'rejected' | 'replayed' | 'faulted' | 'pending';
  eventId: number;
  requestKey: string;
  reason?: string | null;
  state?: string | null;
  version?: number | null;
  reply?: Json | null;      // the machine's reply, for accepted and replayed events
}
