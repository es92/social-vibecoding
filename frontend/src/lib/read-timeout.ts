/**
 * Bounded reads: no screen waits on the network without limit.
 *
 * ── The gap ────────────────────────────────────────────────────────────
 *
 * On a network that carries nothing (bars showing, no packet getting
 * through: a lift, a train, Wi-Fi handing over to cellular, a captive
 * portal) a request neither answers nor fails. The browser still says it is
 * online, so nothing in the shell suspected anything: Home sat on its
 * skeleton, a conversation on "Loading messages…" and the Homeroom bot tab
 * on an empty card, each until the web view gave up a minute or more later,
 * and a read begun in the quiet spell held its screen even after the
 * network came back (offline test, 2 Nov 2026).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * A same-origin GET or HEAD under /api/ that has no response headers
 * READ_TIMEOUT_MS after it was asked is given up: the request is aborted
 * and the caller's promise rejects with a TypeError, exactly as a fetch the
 * network refused does, so every screen's existing failure path (its error
 * card, its Try again, its saved copy) is what follows. A body already
 * arriving is never cut off: the limit ends when the headers land. The
 * caller's own signal still aborts the request at any time.
 *
 * Either kind of failure, the limit or a fetch that rejected outright, also
 * nudges the connectivity probe (./offline.ts), so a quiet network raises
 * the offline banner even though the browser never fired `offline`.
 *
 * Not bounded: writes (a send has its own handling), other origins, /health
 * (the probe's own read, which has its own limit), an event stream, the
 * admin console's reads (READ_TIMEOUT_EXEMPT: a desktop tool whose reports
 * can legitimately take longer), and a read whose caller says otherwise
 * with `readTimeout` on its init: `false` for no limit, or its own number of
 * milliseconds. A caller with a deliberate longer limit of its own passes
 * that (group chat's catch-up and first page, public/js/group-chat.js).
 *
 * The public/sw.js deadlines are the worker's and come first: it answers a
 * read from its saved copy when it has one, so the limit here decides only
 * reads nothing could answer.
 *
 * Installed from main.tsx as the OUTERMOST fetch wrapper, so the limit
 * covers everything a read waits on, the identity confirmation in
 * ./api-cache-identity.ts and a native session renewal included, and so its
 * signal reaches the request that actually goes out.
 */

export const READ_TIMEOUT_MS = 15_000;

/** Path prefixes whose reads are never bounded here: the admin console's. */
export const READ_TIMEOUT_EXEMPT = Object.freeze(['/api/admin/', '/api/v4/admin/']);

declare global {
  interface RequestInit {
    /**
     * How long a same-origin /api/ read may wait for its response headers
     * (./lib/read-timeout.ts): milliseconds, or `false` for no limit.
     * Ignored by every other request.
     */
    readTimeout?: number | false;
  }
}

const TIMED_OUT = 'Network request timed out';

/** The rejection a read that ran out of time gets: a network failure. */
export function readTimeoutError(): TypeError {
  const error = new TypeError(TIMED_OUT);
  (error as TypeError & { timedOut?: boolean }).timedOut = true;
  return error;
}

/** Whether `error` is the rejection of a read that ran out of time. */
export function isReadTimeout(error: unknown): boolean {
  return !!error && (error as { timedOut?: unknown }).timedOut === true;
}

/** Whether a fetch rejection means the network failed (not a cancel). */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (!!error && (error as { name?: unknown }).name === 'TypeError');
}

function isRequest(input: unknown): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function signalOf(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  if (init && init.signal) return init.signal;
  return isRequest(input) ? input.signal : null;
}

function joined(own: AbortSignal | null, mine: AbortSignal): AbortSignal {
  if (!own) return mine;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, [own, mine]);
  // Older engines (Safari before 17.4): follow the caller's signal by hand,
  // for the life of the request, so a body read stays cancellable too.
  const both = new AbortController();
  const follow = (from: AbortSignal) => () => { if (!both.signal.aborted) both.abort(from.reason); };
  own.addEventListener('abort', follow(own), { once: true });
  mine.addEventListener('abort', follow(mine), { once: true });
  return both.signal;
}

/**
 * Send `input` with `send`, giving up when no response has arrived within
 * `ms`: the request is aborted and the promise rejects with
 * readTimeoutError(). Exported for ./api-cache-identity.ts, whose identity
 * confirmation is a read every other read may be waiting on.
 */
export function fetchWithin(
  send: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  ms: number,
): Promise<Response> {
  const own = signalOf(input, init);
  if (own && own.aborted) return send(input, init);
  const controller = new AbortController();
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = readTimeoutError();
      try { controller.abort(error); } catch { /* the request is gone either way */ }
      reject(error);
    }, ms);
    const done = () => { settled = true; clearTimeout(timer); };
    let sent: Promise<Response>;
    try {
      sent = send(input, { ...init, signal: joined(own, controller.signal) });
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      (res) => { if (!settled) { done(); resolve(res); } },
      (error) => { if (!settled) { done(); reject(error); } },
    );
  });
}

interface Plan {
  /** A same-origin /api/ request: a network failure nudges the probe. */
  api: boolean;
  /** The limit on its response headers, or null for none. */
  ms: number | null;
}

function planFor(win: any, input: RequestInfo | URL, init?: RequestInit): Plan {
  let url: URL;
  try {
    url = new URL(isRequest(input) ? input.url : String(input), win.location.href);
  } catch {
    return { api: false, ms: null };
  }
  const api = url.origin === win.location.origin && url.pathname.startsWith('/api/');
  if (!api) return { api, ms: null };
  const own = init ? init.readTimeout : undefined;
  if (own === false) return { api, ms: null };
  const method = String((init && init.method) || (isRequest(input) ? input.method : '') || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { api, ms: null };
  if (READ_TIMEOUT_EXEMPT.some((prefix) => url.pathname.startsWith(prefix))) return { api, ms: null };
  let accept = '';
  try {
    accept = new Headers((init && init.headers) || (isRequest(input) ? input.headers : undefined)).get('accept') || '';
  } catch { /* unreadable headers: an ordinary read */ }
  if (/text\/event-stream/i.test(accept)) return { api, ms: null };
  return { api, ms: typeof own === 'number' && own > 0 ? own : READ_TIMEOUT_MS };
}

function nudge(win: any): void {
  try {
    // Already offline: the probe's own loop is watching for the way back.
    if (win.Offline && !win.Offline.isOffline()) win.Offline.nudge();
  } catch { /* no probe: the screen's own failure still shows */ }
}

/**
 * Wrap `window.fetch` once. Exported for the test, which hands in its own
 * window; the browser installs it from main.tsx, after the other wrappers.
 */
export function installReadTimeout(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__readTimeoutInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  win.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const plan = planFor(win, input, init);
    if (!plan.api) return send(input, init);
    let rest = init;
    if (init && 'readTimeout' in init) {
      rest = { ...init };
      delete rest.readTimeout;
    }
    let sent: Promise<Response>;
    try {
      sent = plan.ms == null ? send(input, rest) : fetchWithin(send, input, rest, plan.ms);
    } catch (error) {
      sent = Promise.reject(error);
    }
    return sent.catch((error: unknown) => {
      if (isNetworkFailure(error)) nudge(win);
      throw error;
    });
  };
  win.__readTimeoutInstalled = true;
}
