/**
 * THE MESSAGES A PERSON WROTE THAT THE SERVER HAS NOT CONFIRMED, KEPT ON THE
 * DEVICE (offline test, 2 Nov 2026, finding 1).
 *
 * A message sent on a network that connects but passes nothing looked sent,
 * then vanished: its row lived in memory only, so leaving the conversation,
 * a re-read or closing the app took it away, and the server never had it.
 * The store (./store.ts) now keeps every row it has not had confirmed, in
 * flight, waiting for a connection or not sent, and this module keeps a copy
 * of each in IndexedDB so a reload, a crash or the app being closed brings it
 * back into its conversation. IndexedDB rather than localStorage: a record is
 * on disk once its transaction completes, where WebKit writes localStorage
 * back on a timer that a closed app can beat, and it is the store the
 * feedback outbox (public/js/feedback-queue.js) already trusts.
 *
 * Each record is one message, under its idempotency key, the key the server
 * stores it under (services/conversations.js sendMessage): sending a record
 * again can never post it twice. A record names the account that wrote it,
 * and only that account's records come back; the rest are deleted the first
 * time anyone else's are read. Bounded: at most MAX_UNSENT of an account's,
 * the newest, and none older than MAX_UNSENT_AGE_MS. Everything goes on
 * sign-out (App._dropCachedSession, through the store's `clearUnsent`).
 *
 * Every call is best effort: no IndexedDB (a private window, a test, storage
 * refused) is a store that keeps nothing, and the messages still work in
 * memory as they always did.
 */

import type { ConversationMessage, SharedObjectReference } from './types';

/** What a send POSTs, again under the same key on Retry or once the connection is back. */
export interface PendingSend {
  content: string;
  replyToId?: number;
  /** #2387: a reply inside this thread rather than the conversation's own transcript. */
  threadRootId?: number;
  attachmentIds?: string[];
  object?: SharedObjectReference;
  idempotencyKey: string;
}

/**
 * Where an unconfirmed message stands: on its way (`sending`), waiting for a
 * connection to go by itself (`queued`), or refused or unanswered with the
 * connection up, waiting for Retry (`failed`).
 */
export type UnsentState = 'sending' | 'queued' | 'failed';

export interface OutboxRecord {
  /** The idempotency key, which is also the row's client key. */
  key: string;
  /** The account that wrote it. */
  viewer: number;
  conversationId: number;
  payload: PendingSend;
  /** The row as it was drawn: words, quote, files, time. */
  row: ConversationMessage;
  /** The newest server id the transcript held when it was written (store.ts withLocalRows). */
  after: number;
  state: UnsentState;
  savedAt: number;
}

/** The most unsent messages kept for one account, as the in-memory queue always capped them. */
export const MAX_UNSENT = 50;
/** A message not sent in a week is not brought back. */
export const MAX_UNSENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = 'homeroom-messages-unsent';
const STORE = 'unsent';
const STATES: ReadonlyArray<UnsentState> = ['sending', 'queued', 'failed'];

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Pure: a stored value as a record, or null when it is not one this version wrote. */
export function outboxRecord(raw: unknown): OutboxRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<OutboxRecord>;
  const payload = value.payload;
  const row = value.row;
  if (typeof value.key !== 'string' || !value.key) return null;
  if (!positiveInt(value.viewer) || !positiveInt(value.conversationId)) return null;
  if (!payload || typeof payload !== 'object' || payload.idempotencyKey !== value.key || typeof payload.content !== 'string') return null;
  if (!row || typeof row !== 'object' || row.clientKey !== value.key || row.conversationId !== value.conversationId) return null;
  if (!STATES.includes(value.state as UnsentState) || !Number.isFinite(value.savedAt)) return null;
  return {
    key: value.key,
    viewer: value.viewer,
    conversationId: value.conversationId,
    payload,
    row,
    after: Number.isSafeInteger(value.after) ? Number(value.after) : 0,
    state: value.state as UnsentState,
    savedAt: Number(value.savedAt),
  };
}

/**
 * Pure: which stored records come back for `viewer`, oldest first, and the
 * keys of every other one, to delete: another account's, one older than a
 * week, one that is not a record, and the oldest past MAX_UNSENT.
 */
export function restorable(stored: unknown[], viewer: number, now: number): { keep: OutboxRecord[]; drop: string[] } {
  const keep: OutboxRecord[] = [];
  const drop: string[] = [];
  for (const raw of stored) {
    const record = outboxRecord(raw);
    if (!record) {
      const key = raw && typeof raw === 'object' ? (raw as { key?: unknown }).key : null;
      if (typeof key === 'string') drop.push(key);
      continue;
    }
    if (record.viewer !== viewer || now - record.savedAt > MAX_UNSENT_AGE_MS) { drop.push(record.key); continue; }
    keep.push(record);
  }
  keep.sort((a, b) => a.savedAt - b.savedAt);
  while (keep.length > MAX_UNSENT) drop.push((keep.shift() as OutboxRecord).key);
  return { keep, drop };
}

export interface Outbox {
  /** `viewer`'s records, oldest first; everything else stored is deleted. */
  load(viewer: number): Promise<OutboxRecord[]>;
  save(record: OutboxRecord): void;
  drop(key: string): void;
  /** Every record, whoever wrote it. */
  clear(): void;
}

/**
 * The outbox over an IndexedDB factory. Writes go in the order they were
 * asked for: each opens its transaction once the database is open, in turn,
 * and IndexedDB runs read-write transactions on one store in the order they
 * were made.
 */
export function createOutbox(idb: IDBFactory | null | undefined): Outbox {
  let opening: Promise<IDBDatabase | null> | null = null;
  function open(): Promise<IDBDatabase | null> {
    if (!idb) return Promise.resolve(null);
    if (!opening) {
      opening = new Promise((resolve) => {
        let request: IDBOpenDBRequest;
        try { request = idb.open(DB_NAME, 1); } catch { resolve(null); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => { opening = null; resolve(null); };
        request.onblocked = () => { opening = null; resolve(null); };
      });
    }
    return opening;
  }
  function write(apply: (store: IDBObjectStore) => void): void {
    void open().then((db) => {
      if (!db) return;
      try { apply(db.transaction(STORE, 'readwrite').objectStore(STORE)); } catch { /* storage refused: memory only */ }
    });
  }
  return {
    async load(viewer) {
      const db = await open();
      if (!db) return [];
      const stored = await new Promise<unknown[]>((resolve) => {
        try {
          const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
          request.onerror = () => resolve([]);
        } catch { resolve([]); }
      });
      const { keep, drop } = restorable(stored, viewer, Date.now());
      if (drop.length) write((store) => { for (const key of drop) store.delete(key); });
      return keep;
    },
    save(record) { write((store) => { store.put(record); }); },
    drop(key) { write((store) => { store.delete(key); }); },
    clear() { write((store) => { store.clear(); }); },
  };
}

let shared: Outbox | null = null;

/** This document's outbox, opened on first use. */
export function messagesOutbox(): Outbox {
  if (!shared) shared = createOutbox(typeof indexedDB !== 'undefined' ? indexedDB : null);
  return shared;
}
