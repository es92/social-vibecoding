import { fetchWithin, READ_TIMEOUT_MS } from './read-timeout';

/** Session partitions are cache labels, never credentials or authorization. */
export const API_SCOPE_COOKIE = '__Host-usernode_api_scope';
const DEV_API_SCOPE_COOKIE = 'usernode_api_scope';
export const API_SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const EXPIRY_HEADER = 'X-Usernode-Cache-Expires';
const BOUNDARY_KEY = 'usernode.api-identity-boundary';

/**
 * Auth writes that never start, end or switch a session: none writes or
 * clears the session cookie. A code asked for, a phone linked to the
 * signed-in account, the waiting room's answers. Every other write under
 * /api/auth/ is a session boundary (the server's SESSION_MINT_PATHS, logout,
 * account deletion, a password reset): it fences the reads on their way and
 * tells the other tabs, which reload. Fencing these instead cut off reads
 * the screen was waiting for and reloaded every other tab when someone added
 * a phone. A new route is a boundary until it is listed here, and
 * tests/api-cache-auth-writes.test.js fails until it is classified.
 */
export const AUTH_WRITES_KEEPING_SESSION = Object.freeze([
  '/api/auth/otp/request',
  '/api/auth/password-reset/request',
  '/api/auth/phone/request',
  '/api/auth/phone-link/request',
  '/api/auth/phone-link/verify',
  '/api/auth/waiting/about',
  '/api/auth/wallet-check',
  '/api/auth/oauth/:provider/native/start',
  '/api/auth/oauth/:provider/native/failed',
  // A waiting account uses an admin's invite link (src/routes/access-links.js):
  // its access changes, its session does not, and the page reloads itself.
  '/api/auth/access-link',
]);
const KEEPS_SESSION = AUTH_WRITES_KEEPING_SESSION
  .map(route => new RegExp(`^${route.replace(/:[a-z]+/g, '[^/]+')}$`));

export function authWriteKeepsSession(pathname: string): boolean {
  return KEEPS_SESSION.some(route => route.test(pathname));
}

/**
 * Public reads whose answer is the same for anyone: their handler runs no
 * optionalSessionAuth and reads no req.user or req.cookies (the invite
 * preview counts its open by a browser cookie, in a helper, and answers the
 * same), so no session boundary can have changed it, and a sign-in or
 * sign-out never cuts them off. Fenced, a logout round trip spanning a read and its one retry left an
 * invite link on the waitlist pitch and the waiting room with no countries
 * (#6014). This is a list, not the /api/public/ prefix: a public route may
 * still read the cookie (GET /api/public/profiles/:username answers the
 * viewer's own friendship), and everything not listed stays fenced.
 * tests/session-guard-screens.test.js fails if a listed route reads one.
 */
export const PUBLIC_READS_FOR_ANYONE = Object.freeze([
  '/api/public/apps',
  '/api/public/invites/:token',
  '/api/public/invites/:token/picture',
  '/api/public/invites/:token/icon.png',
  // Whether an admin's invite link to Homeroom still lets somebody in
  // (src/routes/access-links.js): the same answer for anyone.
  '/api/public/access-links/:code',
  '/api/public/waitlist/options',
]);
const FOR_ANYONE = PUBLIC_READS_FOR_ANYONE
  .map(route => new RegExp(`^${route.replace(/\./g, '\\.').replace(/:[a-z]+/g, '[^/]+')}$`));

export function publicReadIsForAnyone(pathname: string): boolean {
  return FOR_ANYONE.some(route => route.test(pathname));
}

export function readApiCacheScope(doc: Pick<Document, 'cookie'> | undefined = typeof document !== 'undefined' ? document : undefined,
  secure = typeof location === 'undefined' || location.protocol !== 'http:'): string | null {
  try {
    if (!doc) return null;
    const name = secure ? API_SCOPE_COOKIE : DEV_API_SCOPE_COOKIE;
    const values = doc.cookie.split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
    if (values.length !== 1) return null;
    const value = values[0].slice(name.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value! : null;
  } catch { return null; }
}

type Context = { epoch: number; scope: string | null; nativeEpoch: number };

/**
 * Why a read was cut off (#6002): `epoch` a reset (an auth write, a viewer
 * change, another tab's boundary), `scope` the partition cookie replaced,
 * `native` the phone app's session renewal moved.
 */
export type FenceReason = 'epoch' | 'scope' | 'native';
export type FenceEntry = { path: string; reason: FenceReason; public: boolean; count: number };
export type FenceReport = { signedIn: boolean; fences: FenceEntry[] };

const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{22,}$/;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,})$/i;
const PLAIN_SEGMENT = /^[A-Za-z0-9._~:-]{1,64}$/;
const MAX_FENCE_PATH = 160;

/**
 * Pure: a fenced read's path as it may be reported. Only the pathname is
 * read, so the query and the hash never enter it; a link code (22 or more
 * URL-safe characters, community-invites.js TOKEN_RE) is `<token>`, a number,
 * UUID or long hex is `<id>`, and anything escaped or unusual is `<value>`.
 * The collector narrows it further to the route it matched
 * (services/ui-telemetry.js routeTemplate), so a name in the address is
 * never stored.
 */
export function fencePath(pathname: string): string {
  const bare = String(pathname || '').split(/[?#]/)[0];
  const out = bare.split('/').map((segment, i) => {
    if (i === 0) return '';
    if (ID_SEGMENT.test(segment)) return '<id>';
    if (TOKEN_SEGMENT.test(segment)) return '<token>';
    if (!PLAIN_SEGMENT.test(segment)) return segment ? '<value>' : '';
    return segment;
  }).join('/');
  return out.length > MAX_FENCE_PATH ? out.slice(0, MAX_FENCE_PATH) : out;
}

// A page reports at most MAX_FENCE_WINDOWS windows in any FENCE_BUDGET_MS
// (a rolling budget, so a page kept open for days still reports later
// bursts), each with at most MAX_FENCE_PATHS distinct paths per signed-in
// group. Reads past that are counted in an overflow entry of their own
// reason and kind, `/api/<other>` or `/api/public/<other>`, which never
// takes another entry's path, reason or public flag: at most six, so a
// report holds at most MAX_FENCE_ENTRIES. Each is counted up to
// MAX_FENCE_COUNT reads.
export const FENCE_WINDOW_MS = 5000;
export const FENCE_BUDGET_MS = 10 * 60 * 1000;
export const MAX_FENCE_WINDOWS = 3;
export const MAX_FENCE_PATHS = 10;
export const MAX_FENCE_ENTRIES = 16;
export const MAX_FENCE_COUNT = 1000;

type Timer = unknown;
/**
 * The page load's fence log: a burst of fences is one report. The first
 * fence opens a window; it closes FENCE_WINDOW_MS later, or at once when
 * the page is hidden (`close()`), and delivers one report per signed-in
 * group, each read counted under its path and reason.
 */
export function createFenceLog({ setTimer, clearTimer, deliver, now = Date.now }: {
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
  deliver: (report: FenceReport) => void;
  now?: () => number;
}) {
  let opened: number[] = [];
  let timer: Timer | null = null;
  let open: Map<boolean, Map<string, FenceEntry>> | null = null;

  function close(): void {
    if (timer !== null) { clearTimer(timer); timer = null; }
    const groups = open;
    open = null;
    if (!groups) return;
    for (const [signedIn, entries] of groups) {
      if (!entries.size) continue;
      try { deliver({ signedIn, fences: [...entries.values()] }); } catch { /* reporting never matters to the read */ }
    }
  }

  function note(pathname: string, reason: FenceReason, signedIn: boolean): void {
    if (!open) {
      const at = now();
      opened = opened.filter(t => at - t < FENCE_BUDGET_MS);
      if (opened.length >= MAX_FENCE_WINDOWS) return;
      opened.push(at);
      open = new Map();
      timer = setTimer(close, FENCE_WINDOW_MS);
    }
    let path = fencePath(pathname);
    let entries = open.get(signedIn);
    if (!entries) { entries = new Map(); open.set(signedIn, entries); }
    let key = `${reason}|${path}`;
    if (!entries.has(key)) {
      const named = [...entries.values()].filter(e => !e.path.endsWith('/<other>')).length;
      if (named >= MAX_FENCE_PATHS) {
        // Past the cap the read still counts, in its own reason's and
        // kind's overflow entry: a public read stays a public one.
        path = path.startsWith('/api/public/') ? '/api/public/<other>' : '/api/<other>';
        key = `${reason}|${path}`;
      }
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = { path, reason, public: path.startsWith('/api/public/'), count: 0 };
      entries.set(key, entry);
    }
    entry.count = Math.min(MAX_FENCE_COUNT, entry.count + 1);
  }

  return { note, close };
}

export function installApiCacheIdentity(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__apiCacheIdentityInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  const secure = new URL(win.location.href).protocol === 'https:';
  const cookieName = secure ? API_SCOPE_COOKIE : DEV_API_SCOPE_COOKIE;
  const scope = () => readApiCacheScope(win.document, secure);
  const renewal = () => {
    try { return win.NativeChrome?.webSessionRenewal?.() || { epoch: 0, settled: null }; }
    catch { return { epoch: 0, settled: null }; }
  };
  let epoch = 0;
  let boundary = 0;
  let observedScope = scope();
  let observedNativeEpoch = renewal().epoch;
  let verifiedNativeEpoch = observedNativeEpoch;
  let viewer: string | null | undefined;
  let nativeVerification: { epoch: number; boundary: number; pending: Promise<void> } | null = null;

  // Each fence's reason, kept on the exception it threw, and why each epoch
  // moved, keyed by the epoch it moved to (the last 16).
  const fenceReasons = new WeakMap<object, FenceReason>();
  const causes = new Map<number, FenceReason>();
  const bumped = (reason: FenceReason) => {
    epoch++;
    causes.set(epoch, reason);
    if (causes.size > 16) causes.delete(causes.keys().next().value as number);
  };
  const changed = (reason: FenceReason) => {
    const err = new DOMException('Session changed', 'AbortError');
    fenceReasons.set(err, reason);
    return err;
  };
  // Why a read that started in `context` is no longer current.
  const reasonFor = (context: Context): FenceReason => causes.get(context.epoch + 1)
    || (renewal().epoch !== context.nativeEpoch ? 'native' : 'scope');
  const fenceLog = createFenceLog({
    setTimer: (fn, ms) => {
      if (typeof win.setTimeout === 'function') return win.setTimeout(fn, ms);
      const timer: any = setTimeout(fn, ms);
      timer?.unref?.(); // outside a browser, a pending report never holds the process
      return timer;
    },
    clearTimer: timer => (typeof win.clearTimeout === 'function' ? win.clearTimeout(timer) : clearTimeout(timer as any)),
    deliver: report => { try { win.UITelemetry?.reportFence?.(report); } catch { /* best effort */ } },
  });
  // A fence is reported, never changed: any failure here is swallowed.
  function noteFence(pathname: string, reason: FenceReason, signedIn: boolean): void {
    try {
      if (pathname.startsWith('/api/ui-telemetry/')) return; // a report never reports itself
      fenceLog.note(pathname, reason, signedIn);
    } catch { /* best effort */ }
  }
  function observe(): Context {
    const next = scope(), nativeEpoch = renewal().epoch;
    // Bootstrapping a legacy session's missing hint need not discard its
    // already-running, server-confirmed reads. Replacing a real hint does.
    if (nativeEpoch !== observedNativeEpoch) bumped('native');
    else if (observedScope !== null && next !== observedScope) bumped('scope');
    observedScope = next;
    observedNativeEpoch = nativeEpoch;
    return { epoch, scope: next, nativeEpoch };
  }
  function current(context: Context, responseScope: string | null): boolean {
    const now = observe();
    return now.epoch === context.epoch && now.nativeEpoch === context.nativeEpoch
      && (now.scope === context.scope || (context.scope === null && now.scope === responseScope))
      && (now.scope === null || responseScope === null || now.scope === responseScope);
  }
  function broadcastBoundary(): void {
    try { win.localStorage.setItem(BOUNDARY_KEY, `${Date.now()}:${Math.random()}`); } catch { /* no storage */ }
  }
  // A document nobody was ever signed in to: no partition hint before or
  // now, no viewer, and the same native session. Its reads carried no
  // identity, so no identity can have changed under them.
  const anonymous = () => observedScope === null && scope() === null
    && currentViewer() == null && renewal().epoch === observedNativeEpoch;
  // `unlessAnonymous`: a caller dropping a session it may never have had
  // (App._dropCachedSession, on a signed-out boot's /me) fences nothing when
  // there was none. Fencing then threw away public reads already on their
  // way, so an invite link showed the waitlist pitch instead of its card.
  function reset({ broadcast = false, unlessAnonymous = false } = {}): void {
    boundary++;
    if (!(unlessAnonymous && anonymous())) bumped('epoch');
    observedScope = scope();
    observedNativeEpoch = renewal().epoch;
    if (broadcast) broadcastBoundary();
  }

  function rememberScope(res: Response, label: string): boolean {
    const expiry = Date.parse(res.headers.get(EXPIRY_HEADER) || '');
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
    // The server writes the hint with every session it mints or renews, so
    // it is usually here already. Writing it again then only adds a copy: a
    // Homeroom preview's hint is partitioned (browser-session-cookies.js),
    // and this unpartitioned Lax one beside it puts the name in the jar
    // twice, which reads as no hint at all and fences every read in flight.
    if (scope() === label) return true;
    try {
      win.document.cookie = `${cookieName}=${label}; Path=/; SameSite=Lax; Expires=${new Date(expiry).toUTCString()}${secure ? '; Secure' : ''}`;
    } catch { /* unavailable cookies disable the offline partition */ }
    return true;
  }

  const currentViewer = () => viewer !== undefined ? viewer
    : win.App?.user?.id == null ? undefined : String(win.App.user.id);

  async function adoptNativeIdentity(res: Response, context: Context, boundaryAtStart: number,
    expectedViewer: string | null | undefined): Promise<Context> {
    const label = res.headers.get(API_SCOPE_HEADER);
    if (!res.ok || res.redirected || !/^[a-f0-9]{64}$/.test(label || '')) throw changed('native');
    const data = await res.clone().json();
    const active = renewal(), cookie = scope();
    if (boundaryAtStart !== boundary || active.epoch !== context.nativeEpoch || active.settled
        || currentViewer() !== expectedViewer || data?.user?.id == null
        || (expectedViewer !== undefined && String(data.user.id) !== expectedViewer)
        || (cookie !== context.scope && cookie !== label)) throw changed(boundaryAtStart !== boundary ? 'epoch' : 'native');
    // The real auth middleware may already have renewed both cookies.
    // Permit that exact server-confirmed label, never an intervening login.
    if (!rememberScope(res, label!)) throw changed('native');
    const confirmed = observe();
    verifiedNativeEpoch = confirmed.nativeEpoch;
    return confirmed;
  }

  function confirmNativeIdentity(context: Context): Promise<void> {
    if (nativeVerification?.epoch === context.nativeEpoch && nativeVerification.boundary === boundary) {
      return nativeVerification.pending;
    }
    const boundaryAtStart = boundary, expectedViewer = currentViewer();
    const pending = (async () => {
      // An already-admitted native document skips admission's /me on resume.
      // Confirm the rotated cookie once, before any ordinary request can
      // consume an offline copy. Use the original fetch to avoid recursion.
      // Bounded like any read (./read-timeout.ts): every read waits on this
      // one, so a confirmation begun on a dead network must not outlive it.
      const res = await fetchWithin(send, new Request(new URL('/api/auth/me', win.location.href), {
        credentials: 'same-origin', cache: 'no-store',
      }), undefined, READ_TIMEOUT_MS);
      await adoptNativeIdentity(res, context, boundaryAtStart, expectedViewer);
    })();
    const verification = { epoch: context.nativeEpoch, boundary: boundaryAtStart, pending };
    nativeVerification = verification;
    void pending.finally(() => {
      if (nativeVerification === verification) nativeVerification = null;
    }).catch(() => {});
    return pending;
  }

  function waitForSession<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      // Cancelling one caller must not cancel the verification another
      // reader is awaiting, but that caller still settles immediately.
      pending.then(value => {
        signal.removeEventListener('abort', abort); resolve(value);
      }, error => {
        signal.removeEventListener('abort', abort); reject(error);
      });
    });
  }

  // Fence body consumption as well as fetch resolution. JSON parsing or a
  // stream may complete after logout even when response headers arrived first.
  function guarded(res: Response, context: Context, responseScope: string | null,
    fenced: (reason: FenceReason) => void): Response {
    const check = () => {
      if (current(context, responseScope)) return;
      const reason = reasonFor(context);
      fenced(reason);
      throw changed(reason);
    };
    let stream: ReadableStream | null | undefined;
    return new Proxy(res, {
      get(target, prop) {
        if (prop === 'clone') return () => {
          check();
          if (stream?.locked) throw new TypeError('Response body is locked');
          return guarded(target.clone(), context, responseScope, fenced);
        };
        if (['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'].includes(String(prop))) {
          const read = (target as any)[prop];
          if (typeof read !== 'function') return read;
          return async () => {
            check();
            if (stream?.locked) throw new TypeError('Response body is locked');
            const body = await read.call(target); check(); return body;
          };
        }
        if (prop === 'body') {
          check();
          if (stream !== undefined) return stream;
          if (!target.body) return (stream = null);
          let reader: ReadableStreamDefaultReader | undefined;
          stream = new ReadableStream({
            async pull(controller) {
              try {
                check();
                reader ||= target.body!.getReader();
                const item = await reader.read();
                check();
                if (item.done) controller.close(); else controller.enqueue(item.value);
              } catch (err) {
                void reader?.cancel(err).catch(() => {});
                controller.error(err);
              }
            },
            cancel: reason => reader ? reader.cancel(reason) : target.body!.cancel(reason),
          // No speculative pull: a chunk queued for the former identity
          // must not bypass the check when the next reader consumes it.
          }, { highWaterMark: 0 });
          return stream;
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  // Signed in at either end of a read: a hint cookie or a viewer, when it
  // started or now.
  const signedInNow = () => scope() !== null || currentViewer() != null;

  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    const url = new URL(raw, win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return send(input, init);
    const signedInAtStart = signedInNow();
    const fenced = (reason: FenceReason) => noteFence(url.pathname, reason, signedInAtStart || signedInNow());
    try {
      return await guardedFetch(input, init, url, fenced);
    } catch (err) {
      // Each reader a fence rejected counts once, a shared native check too.
      // A caller's own abort is not a fence and is never recorded.
      const reason = err && typeof err === 'object' ? fenceReasons.get(err) : undefined;
      if (reason) fenced(reason);
      throw err;
    }
  };

  async function guardedFetch(input: RequestInfo | URL, init: RequestInit | undefined, url: URL,
    fenced: (reason: FenceReason) => void): Promise<Response> {
    const req = new Request(typeof Request !== 'undefined' && input instanceof Request ? input : url.href, init);
    const auth = url.pathname.startsWith('/api/auth/');
    const mutation = auth && req.method !== 'GET' && req.method !== 'HEAD'
      && !authWriteKeepsSession(url.pathname);
    const identityRead = req.method === 'GET' && url.pathname === '/api/auth/me';
    const forAnyone = (req.method === 'GET' || req.method === 'HEAD') && publicReadIsForAnyone(url.pathname);
    if (mutation) { reset({ broadcast: true }); }
    // Native restoration installs its HttpOnly cookie outside this document.
    // Wait for that boundary, then confirm its new identity before cache use.
    const restoring = !mutation && renewal().settled;
    if (restoring) {
      try { await waitForSession(restoring, req.signal); }
      catch { req.signal.throwIfAborted(); /* the server still decides */ }
    }
    let before = observe();
    const headers = new Headers(req.headers);
    headers.delete(API_SCOPE_HEADER);
    const tokenRequest = headers.has('authorization') || headers.has('x-usernode-token')
      || url.searchParams.has('token') || new URL(win.location.href).searchParams.has('token');
    if (!auth && !tokenRequest && req.credentials !== 'omit' && verifiedNativeEpoch !== before.nativeEpoch) {
      req.signal.throwIfAborted();
      await waitForSession(confirmNativeIdentity(before), req.signal);
      before = observe();
    }
    const permitted = !!before.scope && !auth && !tokenRequest && req.credentials !== 'omit'
      && verifiedNativeEpoch === before.nativeEpoch;
    if (permitted) headers.set(API_SCOPE_HEADER, before.scope!);
    // Revalidate the browser's HTTP copy too: 'no-cache' always asks the
    // server, with If-None-Match, so an unchanged read costs a 304 and no
    // body (#6790; 'reload' asked for the whole body every time). The copy
    // is private and varies on the cookie, so it is never another session's.
    // Permitted offline fallbacks still work in the worker; private reads
    // skip its sub-second deadlines and get the saved copy only from a
    // network silent for seconds.
    const boundaryBefore = boundary, expectedViewer = currentViewer();
    const confirmsNative = identityRead && !tokenRequest && req.credentials !== 'omit'
      && verifiedNativeEpoch !== before.nativeEpoch;
    const res = await send(new Request(req, { headers,
      cache: permitted && req.cache !== 'no-store' ? 'no-cache' : 'no-store' }));
    // A read whose answer is the same for anyone (PUBLIC_READS_FOR_ANYONE)
    // is never fenced: no session boundary can have changed it.
    if (forAnyone) return res;
    const responseScope = /^[a-f0-9]{64}$/.test(res.headers.get(API_SCOPE_HEADER) || '')
      ? res.headers.get(API_SCOPE_HEADER) : null;
    let context = before;
    const now = observe();
    const unchanged = now.epoch === before.epoch && now.nativeEpoch === before.nativeEpoch && now.scope === before.scope;
    if (confirmsNative && res.ok && responseScope) {
      context = await adoptNativeIdentity(res, before, boundaryBefore, expectedViewer);
    } else if (identityRead && res.ok && responseScope && unchanged) {
      // Existing sessions predate the hint cookie. Only a fresh /me may
      // bootstrap it, and an intervening login always wins over this read.
      rememberScope(res, responseScope);
      context = observe();
      verifiedNativeEpoch = context.nativeEpoch;
    } else if (mutation) {
      context = observe();
      broadcastBoundary();
    }
    // A response for another partition is never handed to a screen. The
    // 401 status remains visible to the native-renewal retry wrapper; its
    // old body is still fenced by guarded().
    if (res.ok && (!current(context, responseScope)
        || (context.scope !== null && responseScope !== null && context.scope !== responseScope))) {
      throw changed(reasonFor(context));
    }
    return guarded(res, context, responseScope, fenced);
  }
  const bridge = (win.UsernodeReact ||= {});
  bridge.apiCache = {
    scope,
    reset: (options: { broadcast?: boolean } = {}) => reset({ ...options, unlessAnonymous: true }),
    setViewer(id: number | string | null, verified = true) {
      const next = id == null ? null : String(id);
      if (viewer !== undefined && next !== viewer) reset({ broadcast: verified });
      viewer = next;
    },
  };
  // A hidden page sends what it has: listened for here, at install, so the
  // report is queued before UI telemetry's own pagehide flush runs.
  win.addEventListener?.('pagehide', () => fenceLog.close());
  try {
    win.document?.addEventListener?.('visibilitychange', () => {
      if (win.document.visibilityState === 'hidden') fenceLog.close();
    });
  } catch { /* no document */ }
  win.addEventListener?.('storage', (event: StorageEvent) => {
    if (event.key !== BOUNDARY_KEY) return;
    reset();
    // Other tabs share the cookie jar. Discard the former viewer's memory
    // and display state as well as its cached responses.
    if (win.App?.user) {
      win.App._dropCachedSession?.({ apiCache: false });
      win.location.reload();
    }
  });
  win.__apiCacheIdentityInstalled = true;
}
