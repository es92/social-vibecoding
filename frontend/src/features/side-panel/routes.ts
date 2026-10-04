/**
 * WHICH ADDRESSES OPEN BESIDE A RUNNING APP, and what the panel does with
 * each: where Back climbs to, what the header row calls it, and the address
 * its document is loaded at.
 *
 * Pure, and no React: the controller, the embedded document's runtime and
 * tests/side-panel.test.js all read the same answers from here.
 *
 * ── The vocabulary ─────────────────────────────────────────────────────
 *
 * A ROUTE is a platform address the way App.restoreFromHash parses it: the
 * fragment without its '#', or a clean app path without its leading '/'.
 *
 *   app/<slug>/workshop            the app's Workshop (also board, activity,
 *                                  a bare dev)
 *   app/<slug>/dev/proposals/<id>  a proposal (governance/<id> too)
 *   app/<slug>/dev/issues/<n>      an issue
 *   app/<slug>/dev/sessions/<id>   a change — `new` is the unsent one
 *   app/<slug>/dev/shared/<id>     a change's shared page
 *   app/<slug>/dev/chat            the app's discussion, by its old
 *   messages/app/<slug>            addresses (full screen, an inbox thread):
 *                                  its project page's Discussion tab now
 *                                  (#3653), so the Workshop's page and key
 *   messages/<id>                  a direct or group conversation, or a
 *                                  channel (#general)
 *   messages/channel/<handle>      a `#name` reference to a channel: a
 *                                  pointer, rewritten to the channel's own
 *                                  address (isPointer)
 *   chat[/<uuid>]                  an agent chat
 *   agent/<id>[/changes]           an agent session (#2779): one conversation
 *                                  with the Mayor, on any app — `changes`
 *                                  is the same page with its drawer up
 *   agent/new                      a session not sent yet (New change): no
 *                                  row until its first message, when the
 *                                  address becomes the session's own
 *   messages/agent/<id|new>        the same, by the address Messages links
 *                                  it with; a numeric id or `new` only (a
 *                                  UUID there is a Global Chat thread, which
 *                                  the panel does not take)
 *   messages                       the inbox itself — never opened INTO the
 *                                  panel from outside it (it is a tab root,
 *                                  and a tab leaves the app), but it is where
 *                                  Back climbs from a thread, so the panel's
 *                                  own document shows it
 *
 * Everything else is somewhere the panel does not go: the tab roots (Home,
 * Discover, Workshop, Profile), Settings, the leaderboard, admin — and an
 * app's App tab, which is the running app's job and is never started inside
 * the panel.
 */

export type PanelKind =
  | 'workshop'
  | 'proposal'
  | 'issue'
  | 'change'
  | 'new-change'
  | 'thread'
  | 'chat'
  | 'agent'
  | 'messages';

/** The parsed shape of a route the panel knows about. */
export interface PanelPage {
  kind: PanelKind;
  /** The app the page belongs to, for the app-scoped kinds. */
  slug: string | null;
  /** A stable identity: two routes with the same key are the same page. */
  key: string;
}

const NUMERIC = /^[1-9]\d{0,15}$/;
// An agent session's serial id, or `new` for the one not sent yet.
const isAgentSessionId = (segment: string | undefined) => segment === 'new' || NUMERIC.test(segment || '');

function decode(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/**
 * The route an address names, or '' for the platform root. A fragment wins
 * over the path when both are present, exactly as the router reads them, and
 * the fragment's own query (`#app/x/full?path=/y`) is not part of the route.
 */
export function routeFromUrl(href: string, base?: string): string {
  let url: URL;
  try {
    url = new URL(String(href || ''), base || 'http://panel.invalid/');
  } catch {
    return '';
  }
  const frag = url.hash.replace(/^#/, '');
  if (frag) return frag.split('?')[0];
  if (/^\/app\/./.test(url.pathname)) return url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return '';
}

/**
 * Is `href` an address INSIDE this document's router — the root or a clean app
 * path, on this origin — rather than a file, an API route or another site?
 * The click intercepts ask this before they read a route out of a link.
 */
export function isShellAddress(href: string, origin: string): boolean {
  try {
    const url = new URL(String(href || ''), origin);
    if (url.origin !== origin) return false;
    return url.pathname === '/' || /^\/app\/[^/]/.test(url.pathname);
  } catch {
    return false;
  }
}

/** The app segment of an app route, decoded, or null. */
function appSlugOf(parts: string[]): string | null {
  return parts[0] === 'app' && parts[1] ? decode(parts[1]) : null;
}

/**
 * The page a route names, or null for a route the panel never shows.
 *
 * Mirrors restoreFromHash's app-route table branch for branch, including its
 * legacy spellings (`group-chat`, `individual-chat`), because a notification
 * written years ago still links with them.
 */
export function panelPage(route: string): PanelPage | null {
  const parts = String(route || '').split('/');
  const head = parts[0];
  if (head === 'app') {
    const slug = appSlugOf(parts);
    if (!slug) return null;
    const base = `app/${slug}`;
    const tab = parts[2] || 'app';
    if (tab === 'workshop' || tab === 'board' || tab === 'activity') {
      return { kind: 'workshop', slug, key: `${base}/workshop` };
    }
    // #3653: an app's discussion is its project page's Discussion tab, so
    // its old addresses are that page: the router takes them there.
    if (tab === 'group-chat') return { kind: 'workshop', slug, key: `${base}/workshop` };
    if (tab === 'individual-chat') {
      return parts[3] && NUMERIC.test(parts[3])
        ? { kind: 'change', slug, key: `${base}/dev/sessions/${parts[3]}` }
        : { kind: 'workshop', slug, key: `${base}/workshop` };
    }
    if (tab !== 'dev') return null; // the App tab, `full`, or an unknown tab
    const sec = parts[3] || '';
    const id = parts[4] || '';
    if (sec === 'sessions' && id === 'new') {
      return { kind: 'new-change', slug, key: `${base}/dev/sessions/new` };
    }
    if (sec === 'sessions' && NUMERIC.test(id)) {
      return { kind: 'change', slug, key: `${base}/dev/sessions/${id}` };
    }
    if (sec === 'shared' && NUMERIC.test(id)) {
      return { kind: 'change', slug, key: `${base}/dev/shared/${id}` };
    }
    if (sec === 'chat') return { kind: 'workshop', slug, key: `${base}/workshop` };
    if (sec === 'issues' && NUMERIC.test(id)) {
      return { kind: 'issue', slug, key: `${base}/dev/issues/${id}` };
    }
    if ((sec === 'proposals' || sec === 'governance') && NUMERIC.test(id)) {
      return { kind: 'proposal', slug, key: `${base}/dev/${sec}/${id}` };
    }
    // dev, dev/issues, dev/proposals, dev/sessions (no id): the card list.
    return { kind: 'workshop', slug, key: `${base}/workshop` };
  }
  if (head === 'messages') {
    if (parts.length === 1) return { kind: 'messages', slug: null, key: 'messages' };
    if (parts[1] === 'app' && parts[2]) {
      // #3653: the app's discussion, as above — its project page.
      const slug = decode(parts[2]);
      return { kind: 'workshop', slug, key: `app/${slug}/workshop` };
    }
    if (NUMERIC.test(parts[1] || '')) {
      return { kind: 'thread', slug: null, key: `messages/${parts[1]}` };
    }
    if (parts[1] === 'channel' && parts[2]) {
      // A `#name` channel reference (#2783) — see isPointer below.
      return { kind: 'thread', slug: null, key: `messages/channel/${parts[2]}` };
    }
    if (parts[1] === 'agent' && isAgentSessionId(parts[2])) {
      // An agent session (#2779). The panel is phone-width, so its document
      // swaps this for `agent/<id>` in place (App.restoreFromHash) — the same
      // page, which is why the key is the session's own.
      return { kind: 'agent', slug: null, key: `agent/${parts[2]}` };
    }
    // A malformed id: the router degrades it to the list.
    return { kind: 'messages', slug: null, key: 'messages' };
  }
  if (head === 'chat') {
    return { kind: 'chat', slug: null, key: parts[1] ? `chat/${parts[1]}` : 'chat' };
  }
  if (head === 'agent' && isAgentSessionId(parts[1])) {
    return { kind: 'agent', slug: null, key: `agent/${parts[1]}` };
  }
  return null;
}

/**
 * Does following a link to `route` open it BESIDE the running app?
 *
 * Every page the panel shows except the inbox list, which is a tab root: the
 * Messages tab leaves the app like every other tab (the spec's "the sidebar's
 * tabs keep their current meaning").
 */
export function isPanelRoute(route: string): boolean {
  const page = panelPage(route);
  return !!page && page.kind !== 'messages';
}

/**
 * Does `route` only POINT at a page? `messages/channel/<handle>` (#2783) is
 * what a `#name` reference in any chat links to, and the Messages store
 * replaces it with the channel's own address — #general's conversation, or an
 * app's discussion — as soon as it knows which room the handle means. It is
 * never a page to come back to: kept in the panel's history, Back would land
 * on it and be sent straight back to the channel. So it opens in the panel
 * like the channel it names, and the history never keeps it.
 */
export function isPointer(route: string | null | undefined): boolean {
  return /^messages\/channel\/[^/?]/.test(String(route || ''));
}

/** May the panel's OWN document show `route`, or does it belong to the top? */
export function embeddedAllows(route: string): boolean {
  return !!panelPage(route);
}

/**
 * The app whose App tab `route` names — `app/<slug>`, `app/<slug>/app`,
 * `app/<slug>/full` — or null. The panel never runs an app: its document
 * hands these to the top window, where the app beside it lives.
 */
export function appTabSlug(route: string): string | null {
  const parts = String(route || '').split('/');
  const slug = appSlugOf(parts);
  if (!slug) return null;
  return panelPage(route) ? null : slug;
}

/**
 * Where Back climbs from `route` once the panel's own history is spent: a
 * thread of messages to Messages, a piece of an app's work to that app's
 * Workshop. Null for the two lists, which have nothing above them here.
 */
export function parentRoute(route: string): string | null {
  const page = panelPage(route);
  if (!page) return null;
  switch (page.kind) {
    case 'thread':
    case 'chat':
    case 'agent':
      return 'messages';
    case 'proposal':
    case 'issue':
    case 'change':
    case 'new-change':
      return page.slug ? `app/${encodeURIComponent(page.slug)}/workshop` : null;
    default:
      return null;
  }
}

/** Two routes name the same page — a canonical rewrite is not a navigation. */
export function samePage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = panelPage(a);
  const pb = panelPage(b);
  if (!pa || !pb) return a === b;
  return pa.key === pb.key;
}

const KIND_TITLE: Record<PanelKind, string> = {
  workshop: 'Workshop',
  proposal: 'Proposal',
  issue: 'Request',
  change: 'Change',
  'new-change': 'New change',
  thread: 'Messages',
  chat: 'Chat',
  agent: 'Agent session',
  messages: 'Messages',
};

/** The pages whose title is their kind, whatever their header says. */
const FIXED_TITLE: ReadonlySet<PanelKind> = new Set<PanelKind>([
  'workshop', 'messages', 'proposal', 'issue', 'change', 'new-change',
]);

/**
 * The header row's title for `route`, as the prototype draws it.
 *
 * The embedded document's own header title (`reported`) is the source where
 * it names the page: a conversation's name, an agent chat's title. The
 * Workshop, the inbox and a piece of work — a proposal, an issue, a change —
 * take their kind instead: "Workshop", "Messages", "Proposal", "Issue",
 * "Change", "New change". On those the header names only the APP (it draws
 * the app's tile beside it on a phone), which beside the app itself would say
 * nothing. An app's discussion is its project page now (#3653), so the
 * Workshop's.
 */
export function titleFor(route: string | null | undefined, reported?: string | null): string {
  const page = route ? panelPage(route) : null;
  const text = String(reported || '').trim();
  if (!page) return text;
  if (FIXED_TITLE.has(page.kind)) return KIND_TITLE[page.kind];
  return text || KIND_TITLE[page.kind];
}

/**
 * Where Expand takes `route`: the page itself, full width — except an agent
 * session, whose desktop home is the Messages pane beside the inbox
 * (`messages/agent/<id>`), not the phone screen the panel draws it as.
 */
export function expandRoute(route: string): string {
  const page = panelPage(route);
  if (page && page.kind === 'agent') return `messages/${page.key}`;
  return route;
}

/**
 * Query parameters the panel's document must NOT inherit from the top window:
 * its own flag (set fresh below), the chromeless app's inner path, a
 * screenshot state and a post-login return target (both belong to the top's
 * load), the forced native presentation (the panel is never the native
 * top frame), and the top's note of what the panel shows (`side`, see
 * ./controller.ts).
 */
const DROPPED_PARAMS = new Set(['panel', 'path', 'shot', 'return_to', 'un-native-webview', 'side']);

/**
 * The address the panel's document is loaded at: the platform root with
 * `panel=1`, the top window's own query otherwise (so `?demo=1`, a staging
 * preview's `?token=` and a pinned `?theme=` carry over), and the route as
 * its fragment. The router rewrites an app route to its clean path on its
 * first pass, keeping the query.
 */
export function frameUrl(route: string, search: string): string {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  for (const key of [...params.keys()]) {
    if (DROPPED_PARAMS.has(key)) params.delete(key);
  }
  params.set('panel', '1');
  return `/?${params.toString()}#${route}`;
}
