/**
 * Channels as things a message can NAME (#2783).
 *
 * A channel is #general — a `channel` conversation — or an app the viewer is
 * a member of, whose channel is its general discussion. Each has a `#handle`
 * (`general`, or the app's name folded by src/routes/messages-overview.js),
 * and `#handle` typed in any chat is a link to that channel.
 *
 * `#123` keeps meaning issue 123 and `PR#123` a pull request: a handle must
 * START with a letter, which is what keeps the three apart without context.
 *
 * ── Why a link goes through `#messages/channel/<handle>` ──────────────
 *
 * The chip's address names the HANDLE rather than the place it resolves to,
 * because the writer and the reader may not agree on the place: #general is
 * a conversation id on this database, and an app channel a slug. The store
 * resolves the handle when the link is followed (store.ts `openChannel`), so
 * a chip is right for whoever clicks it.
 *
 * Pure, so the test drives it with arrays rather than a store.
 */

import { changeHref } from '../../lib/change-href';
import type { AppDiscussion } from './inbox';
import type { ConversationSummary } from './types';

export interface ChannelRef {
  /** Lower case, `[a-z][a-z0-9-]*`. */
  handle: string;
  /** What the list row says — `general`, or the app's name. */
  name: string;
  /** Where the channel actually opens on this screen. */
  target: string;
  kind: 'channel' | 'app';
}

/** The handle grammar: a letter, then letters, digits and hyphens. */
export const CHANNEL_HANDLE = /^[a-z][a-z0-9-]{0,39}$/;

export function normalizeHandle(raw: string | null | undefined): string | null {
  const handle = String(raw || '').trim().replace(/^#/, '').toLowerCase();
  return CHANNEL_HANDLE.test(handle) ? handle : null;
}

/** The address a `#handle` chip links to. */
export function channelHref(handle: string): string {
  return `#messages/channel/${handle}`;
}

/** Every channel the viewer can name, #general first. */
export function channelDirectory(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'kind' | 'title' | 'channelKey'>>,
  discussions: ReadonlyArray<AppDiscussion>,
): ChannelRef[] {
  const out: ChannelRef[] = [];
  const seen = new Set<string>();
  for (const item of conversations) {
    if (item.kind !== 'channel') continue;
    const handle = normalizeHandle(item.channelKey || item.title);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, name: item.title || handle, target: `#messages/${item.id}`, kind: 'channel' });
  }
  for (const item of discussions) {
    const handle = normalizeHandle(item.channel || item.slug);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({
      handle,
      name: item.name || item.slug,
      target: `#messages/app/${encodeURIComponent(item.slug)}`,
      kind: 'app',
    });
  }
  return out;
}

/**
 * One text run split into plain text and references: `@name` mentions,
 * `PR#N` and `#N` refs, and `#handle` channel references — the last only
 * when `handles` knows the handle, so a stray `#todo` stays text.
 *
 * The same boundary rules as the app chat's tokenizer (public/js/group-chat.js
 * `tokenizeMentionsAndRefs`): a token needs a non-word character or the start
 * before it, and a numeric ref may not run on into a word.
 */
export type RefSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; name: string }
  | { type: 'ref'; isPr: boolean; num: string }
  | { type: 'channel'; handle: string };

const TOKEN = /(^|[^\w&])(@([A-Za-z0-9_]{1,32}(?:(?<=homeroom) bot\b)?)|(pr ?#|#)(\d{1,7})(?!\w)|#([A-Za-z][A-Za-z0-9-]{0,39})(?![\w-]))/gi;

export function tokenizeRefs(text: string, handles: ReadonlySet<string>): RefSegment[] {
  const segs: RefSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') last.value += value;
    else segs.push({ type: 'text', value });
  };
  let pos = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m[6] != null && !handles.has(m[6].toLowerCase())) {
      // An unknown `#word` is text: leave `pos` where it is, so it is
      // carried into the next text segment untouched.
      continue;
    }
    pushText(text.slice(pos, m.index));
    pushText(m[1]);
    if (m[3] != null) segs.push({ type: 'mention', name: m[3] });
    else if (m[5] != null) segs.push({ type: 'ref', isPr: m[4].trim().length > 1, num: m[5] });
    else segs.push({ type: 'channel', handle: m[6].toLowerCase() });
    pos = m.index + m[0].length;
  }
  pushText(text.slice(pos));
  return segs.length ? segs : [{ type: 'text', value: '' }];
}

/**
 * #4029: where `@name` opens — that person's page, the address a project's
 * contributors and Kudos' Top users already open.
 */
export function personHref(username: string): string {
  return `#leaderboard/users/${encodeURIComponent(username)}`;
}

/** #4029: whether `@name` names Homeroom bot, which has no person page. */
export function isBotMention(name: string): boolean {
  const key = String(name || '').toLowerCase();
  return key === 'homeroom bot' || key === 'homeroom_bot' || key === 'homeroombot';
}

/**
 * #3770: where `#N` opens when a message names the project it is about:
 * that project's request N, the address the server's own cards give it.
 */
export function issueRefHref(appSlug: string, num: string): string {
  return `#app/${encodeURIComponent(appSlug)}/dev/issues/${Number(num)}`;
}

/**
 * Decorate rendered, SANITIZED message HTML in place: text nodes only, never
 * inside a link or code, and every element built through DOM APIs — so no
 * markup the sanitizer removed can come back through a reference.
 *
 * `appSlug` is the project the message is about, when it names one (#3770:
 * a Homeroom bot message carries its request's): its `#N` chips are links
 * to that project's requests, and its `PR#N` chips to those proposals'
 * pages (#5728).
 */
export function decorateRefs(root: Element, handles: ReadonlySet<string>, me: string, appSlug?: string | null): void {
  const doc = root.ownerDocument;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) decorateText(child as Text);
      else if (child.nodeType === 1 && !/^(A|CODE|PRE)$/i.test((child as Element).tagName)) walk(child);
    }
  };
  const decorateText = (textNode: Text) => {
    const segs = tokenizeRefs(textNode.nodeValue || '', handles);
    if (segs.length === 1 && segs[0].type === 'text') return;
    const frag = doc.createDocumentFragment();
    for (const seg of segs) {
      if (seg.type === 'text') {
        frag.appendChild(doc.createTextNode(seg.value));
      } else if (seg.type === 'mention') {
        // #4029: a link to the person's page; Homeroom bot has none, so its
        // mention ("@Homeroom bot", the app chat's B9 form, or its handle)
        // stays text.
        const bot = isBotMention(seg.name);
        const el = doc.createElement(bot ? 'span' : 'a');
        el.className = seg.name.toLowerCase() === me ? 'gc-mention gc-mention-self' : 'gc-mention';
        if (!bot) {
          el.setAttribute('href', personHref(seg.name));
          el.setAttribute('data-mention', seg.name);
        }
        el.textContent = `@${seg.name}`;
        frag.appendChild(el);
      } else if (seg.type === 'ref') {
        // An issue in a message that names its project is a link to the
        // request (#3770), and a PR a link to its proposal page (#5728).
        // Anything else has no app to reveal it in — a DM belongs to none —
        // so the chip names the ref without pretending to navigate, and
        // app.css draws it as text there.
        const href = appSlug
          ? (seg.isPr ? changeHref(appSlug, null, seg.num) : issueRefHref(appSlug, seg.num))
          : null;
        const chip = doc.createElement(href ? 'a' : 'span');
        if (href) chip.setAttribute('href', href);
        chip.className = seg.isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
        chip.setAttribute('data-ref-type', seg.isPr ? 'pr' : 'issue');
        chip.setAttribute('data-ref-number', seg.num);
        chip.textContent = seg.isPr ? `PR#${seg.num}` : `#${seg.num}`;
        frag.appendChild(chip);
      } else {
        const link = doc.createElement('a');
        link.className = 'gc-channel-ref';
        link.setAttribute('href', channelHref(seg.handle));
        link.setAttribute('data-channel-ref', seg.handle);
        link.textContent = `#${seg.handle}`;
        frag.appendChild(link);
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  };
  walk(root);
}

/**
 * #5728: a rendered, sanitized reply with its references chipped, for the
 * surfaces that draw markdown without Messages' own row (an agent session's
 * reply, a change's chat). With no project to name, nothing is chipped and
 * the html comes back exactly as it was, so a conversation with no project
 * looks as it always did.
 */
export function linkRefsInHtml(html: string, appSlug: string | null | undefined): string {
  if (!html || !appSlug || typeof document === 'undefined') return html;
  const root = document.createElement('div');
  root.innerHTML = html;
  const app = typeof window === 'undefined' ? null : (window as any).App;
  const me = String(app?.user?.username || '').toLowerCase();
  decorateRefs(root, new Set(), me, appSlug);
  return root.innerHTML;
}
