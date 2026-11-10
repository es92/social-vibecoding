/**
 * THE WAY INTO HOMEROOM BOT'S CHAT (1 Nov 2026). The chat with the bot lives
 * on its tab only (./index.tsx): its list, and the column beside it with Main
 * Chat or one thread. It used to be a conversation of the Messages screen as
 * well, where a thread opened beside Main; that copy is gone. So every door
 * into the chat lands here and says where in it:
 *
 *   #homeroom-bot                       the lists alone, nothing beside them
 *   #homeroom-bot/main                  Main Chat
 *   #homeroom-bot/thread/<id>           a thread of it, alone in the column
 *   …either with /m/<id>                at that message
 *   #homeroom-bot/request/<slug>/<n>    a request of a project, in the column
 *   #homeroom-bot/change/<slug>/<n>     a change, by its pull request's number
 *   #homeroom-bot/decision/<slug>/<n>   a group decision of a project
 *
 * The router (public/js/app.js) shows the tab and hands the place to
 * `askBotTab` (Main and its threads) or `askBotItem` (an item), which the page
 * takes once, in its column; an item's own page is the fallback when the column
 * does not fit. A Messages address of
 * the bot's chat (`#messages/<id>`, with its `/thread/<id>` and `/m/<id>`
 * forms: a bell row, an email, a bookmark) is the same place, by its old
 * address: the router and the Messages store swap it for the tab's
 * (`botTabFromMessages`), in place.
 *
 * Which conversation is the bot's is noted here by whoever learns it first
 * (the tab, opening it; the Messages store, reading the list), so the router
 * and the side panel can tell it from any other chat without a store of
 * their own.
 *
 * Pure but for that small state; no React beyond one hook.
 */

import { useSyncExternalStore } from 'react';

/** A place in the chat: Main (no thread) or a thread, and a message in it to land on. */
export interface BotAt {
  threadRootId: number | null;
  focusMessageId: number | null;
}

/** The tab's own page: what its Homeroom bot tab links to. */
export const BOT_TAB = '#homeroom-bot';

function valid(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

/** Pure: a place with anything that is not a message id taken out. */
export function cleanAt(at: Partial<BotAt> | null | undefined): BotAt {
  const root = valid(at?.threadRootId) ? at!.threadRootId as number : null;
  const focus = valid(at?.focusMessageId) && at!.focusMessageId !== root ? at!.focusMessageId as number : null;
  return { threadRootId: root, focusMessageId: focus };
}

/** Pure: the tab's address for a place in the chat. */
export function botTabAddress(at: Partial<BotAt> | null | undefined): string {
  const { threadRootId, focusMessageId } = cleanAt(at);
  const base = threadRootId ? `${BOT_TAB}/thread/${threadRootId}` : `${BOT_TAB}/main`;
  return focusMessageId ? `${base}/m/${focusMessageId}` : base;
}

/**
 * Pure: the place a `#homeroom-bot/…` address names, or null for the page
 * itself (`#homeroom-bot`) and anything else.
 */
export function botTabAt(hash: string | null | undefined): BotAt | null {
  const parts = String(hash || '').replace(/^#/, '').split('?')[0].split('/');
  if (parts[0] !== 'homeroom-bot' && parts[0] !== 'ai') return null;
  const rest = parts[1] === 'main' ? parts.slice(2) : parts.slice(1);
  if (parts[1] !== 'main' && parts[1] !== 'thread' && parts[1] !== 'm') return null;
  const out: Partial<BotAt> = {};
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const id = /^\d{1,10}$/.test(rest[i + 1]) ? Number(rest[i + 1]) : NaN;
    if (rest[i] === 'thread') out.threadRootId = id;
    else if (rest[i] === 'm') out.focusMessageId = id;
  }
  return cleanAt(out);
}

// ── A request, a change or a decision, in the column ────────────────────

/** What the column can hold beside the list besides Main and its threads. */
export type BotItemKind = 'request' | 'change' | 'decision';

/** An item opened in the column, named by its project and its number. */
export interface BotItem {
  kind: BotItemKind;
  slug: string;
  number: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,254}$/;

/** A clean item, or null for anything that could not be one. */
function cleanItem(item: Partial<BotItem> | null | undefined): BotItem | null {
  const kind = item?.kind;
  if (kind !== 'request' && kind !== 'change' && kind !== 'decision') return null;
  const slug = typeof item?.slug === 'string' ? item.slug : '';
  if (!SLUG.test(slug)) return null;
  const number = item?.number;
  if (!valid(number)) return null;
  return { kind, slug, number };
}

/**
 * Pure: the tab's address for an item in the column, or the plain tab for
 * anything that could not be one.
 */
export function botItemAddress(item: Partial<BotItem> | null | undefined): string {
  const clean = cleanItem(item);
  return clean ? `${BOT_TAB}/${clean.kind}/${clean.slug}/${clean.number}` : BOT_TAB;
}

/**
 * Pure: the item a `#homeroom-bot/<kind>/<slug>/<n>` address names (its old
 * `#ai/…` spelling too), or null for anything else.
 */
export function botItemAt(hash: string | null | undefined): BotItem | null {
  const match = /^(?:homeroom-bot|ai)\/(request|change|decision)\/([a-z0-9][a-z0-9-]{0,254})\/(\d{1,10})(?:\/(?:plan|shots|design)(?:\/\d{1,10}){0,2})?\/?$/
    .exec(String(hash || '').replace(/^#/, '').split('?')[0]);
  if (!match) return null;
  return cleanItem({ kind: match[1] as BotItemKind, slug: match[2], number: Number(match[3]) });
}

// ── The detail beside the column (#6230) ────────────────────────────────

/** What is open beside the thread, as the address names it. */
export type BotDetail =
  | { kind: 'plan'; sessionId: number; version: number | null }
  | { kind: 'design'; version: number | null }
  | { kind: 'shots'; changeId: number };

const num = (s: string | undefined): number | null => (/^\d{1,10}$/.test(s || '') ? Number(s) : null);

/**
 * Pure: the detail a `#homeroom-bot/…` address carries after its place, or
 * null for a plain place. A design names its thread; a plan its session and
 * (when there is one) its version; a change its viewer.
 */
export function botDetailAt(hash: string | null | undefined): BotDetail | null {
  const path = String(hash || '').replace(/^#/, '').split('?')[0].replace(/\/+$/, '');
  if (!/^(?:homeroom-bot|ai)\//.test(path)) return null;
  const design = /\/design(?:\/(\d{1,10}))?$/.exec(path);
  if (design) return { kind: 'design', version: num(design[1]) };
  const shots = /\/shots\/(\d{1,10})$/.exec(path);
  if (shots) return { kind: 'shots', changeId: Number(shots[1]) };
  const plan = /\/plan\/(\d{1,10})(?:\/(\d{1,10}))?$/.exec(path);
  if (plan) return { kind: 'plan', sessionId: Number(plan[1]), version: num(plan[2]) };
  return null;
}

/**
 * Pure: the panel route an item is shown at, or null for an invalid item. A
 * change is `dev/changes/<pull request number>`.
 */
export function botItemRoute(item: Partial<BotItem> | null | undefined): string | null {
  const clean = cleanItem(item);
  if (!clean) return null;
  const seg = clean.kind === 'request' ? 'issues' : clean.kind === 'change' ? 'changes' : 'governance';
  return `app/${clean.slug}/dev/${seg}/${clean.number}`;
}

/**
 * Pure: the item a panel route names, or null for any other page: a
 * proposal, session or shared address is a change's page under another kind
 * of address, and keeps the plain tab's address.
 */
export function botItemFromRoute(route: string | null | undefined): BotItem | null {
  const match = /^app\/([a-z0-9][a-z0-9-]{0,254})\/dev\/(issues|changes|governance)\/(\d{1,10})\/?$/
    .exec(String(route || '').split('?')[0].replace(/^\/+/, ''));
  if (!match) return null;
  const kind: BotItemKind = match[2] === 'issues' ? 'request' : match[2] === 'changes' ? 'change' : 'decision';
  return cleanItem({ kind, slug: match[1], number: Number(match[3]) });
}

/**
 * Pure: the clean page path a panel route opens (`/app/<slug>/dev/…`), for
 * the routes the column reads as a request, a change or a decision. Those are
 * the pages Expand opens; a proposal, session or shared address is used as it
 * is. Null for any other page.
 */
export function pageLinkFor(route: string | null | undefined): string | null {
  const match = /^app\/([a-z0-9][a-z0-9-]{0,254})\/dev\/(issues|changes|proposals|sessions|shared|governance)\/(\d{1,10})\/?$/
    .exec(String(route || '').split('?')[0].replace(/^\/+/, ''));
  if (!match) return null;
  return `/app/${match[1]}/dev/${match[2]}/${match[3]}`;
}

/**
 * Pure: the tab's address for a Messages address of the bot's chat `botId`
 * (`#messages/<id>`, `/thread/<root>`, `/m/<id>`, the two together), or null
 * for any other address, or while which chat is the bot's is not known.
 */
export function botTabFromMessages(href: string | null | undefined, botId: number | null | undefined): string | null {
  if (!valid(botId)) return null;
  const match = /^#?messages\/(\d{1,10})((?:\/(?:thread|m)\/\d{1,10})*)\/?(?:\?.*)?$/.exec(String(href || ''));
  if (!match || Number(match[1]) !== botId) return null;
  const at: Partial<BotAt> = {};
  const rest = match[2].split('/').filter(Boolean);
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (rest[i] === 'thread') at.threadRootId = Number(rest[i + 1]);
    else if (rest[i] === 'm') at.focusMessageId = Number(rest[i + 1]);
  }
  return botTabAddress(at);
}

// ── A new thread, already set (10 Nov 2026) ─────────────────────────────

/** Who a new thread is for (../messages/thread-builder.tsx Builder), as an address says it. */
export const BOT_NEW_BUILDERS = ['homeroom', 'claude-code', 'chatgpt'] as const;
export type BotNewBuilder = (typeof BOT_NEW_BUILDERS)[number];

/** What a new thread opens already set to: the project it is for, and who works on it. */
export interface BotNew {
  project: string | null;
  builder: BotNewBuilder;
}

/** An app slug as the platform mints them (../../lib/claude-code-link.ts). */
const NEW_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Pure: a new thread's settings with anything the platform would not mint taken out. */
export function cleanNew(fresh: { project?: unknown; builder?: unknown } | null | undefined): BotNew {
  const project = typeof fresh?.project === 'string' && NEW_SLUG.test(fresh.project) ? fresh.project : null;
  const builder = (BOT_NEW_BUILDERS as readonly unknown[]).includes(fresh?.builder) ? fresh!.builder as BotNewBuilder : 'homeroom';
  return { project, builder };
}

/**
 * Pure: the address that opens the tab on a new thread with Homeroom bot's
 * "+" pressed for you, `#homeroom-bot/new`, with `project=<slug>` and
 * `with=<builder>` when a door names them (a project's Workshop asking a
 * newcomer who should build, ../dev-board/workshop/first-change.tsx).
 */
export function botNewAddress(fresh: Partial<BotNew> | null | undefined): string {
  const { project, builder } = cleanNew(fresh);
  const query = new URLSearchParams();
  if (project) query.set('project', project);
  if (builder !== 'homeroom') query.set('with', builder);
  const said = query.toString();
  return said ? `${BOT_TAB}/new?${said}` : `${BOT_TAB}/new`;
}

/** Pure: what a `#homeroom-bot/new…` address sets a new thread to, or null for any other address. */
export function botNewAt(hash: string | null | undefined): BotNew | null {
  const [path, query = ''] = String(hash || '').replace(/^#/, '').split('?');
  const parts = path.split('/');
  if ((parts[0] !== 'homeroom-bot' && parts[0] !== 'ai') || parts[1] !== 'new' || parts.length !== 2) return null;
  const said = new URLSearchParams(query);
  return cleanNew({ project: said.get('project'), builder: said.get('with') });
}

// ── Which conversation is the bot's ─────────────────────────────────────

let botConversation: number | null = null;

/** Note the signed-in person's chat with the bot, once anything has read it. */
export function noteBotConversation(id: number | null | undefined): void {
  if (valid(id)) botConversation = id;
}

/** The person's chat with the bot, when something has said which it is. */
export function knownBotConversation(): number | null {
  return botConversation;
}

/** Pure: whether a side panel route (`messages/<id>…`) is the chat with the bot, which only its tab draws. */
export function isBotChatRoute(route: string | null | undefined, botId: number | null | undefined = botConversation): boolean {
  if (!valid(botId)) return false;
  const match = /^messages\/(\d{1,10})(?:[/?]|$)/.exec(String(route || ''));
  return !!match && Number(match[1]) === botId;
}

// ── Where the router asked the tab to go ────────────────────────────────

let asked: { at: BotAt | null; item: BotItem | null; close?: boolean; fresh?: BotNew; seq: number } | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** The router's half: show this place in the tab's column (the page takes it once). */
export function askBotTab(at: Partial<BotAt> | null | undefined): void {
  seq += 1;
  asked = { at: cleanAt(at), item: null, seq };
  listeners.forEach((fn) => fn());
}

/** The router's half: close what is open beside the lists (a bare `#homeroom-bot`). */
export function askBotClose(): void {
  seq += 1;
  asked = { at: null, item: null, close: true, seq };
  listeners.forEach((fn) => fn());
}

/** The router's half, for an item opened in the column (the page takes it once). */
export function askBotItem(item: Partial<BotItem> | null | undefined): void {
  const clean = cleanItem(item);
  if (!clean) return;
  seq += 1;
  asked = { at: null, item: clean, seq };
  listeners.forEach((fn) => fn());
}

/** The router's half, for a new thread already set (`#homeroom-bot/new…`; the page takes it once). */
export function askBotNew(fresh: Partial<BotNew> | null | undefined): void {
  seq += 1;
  asked = { at: null, item: null, fresh: cleanNew(fresh), seq };
  listeners.forEach((fn) => fn());
}

/** What the router last asked, with its count, so a page takes each ask once. */
export function useBotTabAsk(): { at: BotAt | null; item: BotItem | null; close?: boolean; fresh?: BotNew; seq: number } | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => asked,
    () => null,
  );
}

/**
 * Go to the tab at `at`, by its address, through the router: when the
 * address is already the one in the bar the router runs on it again, so the
 * place is taken even then (as Messages' openAddress does).
 */
export function openBotTab(at: Partial<BotAt> | null | undefined): void {
  goBotAddress(botTabAddress(at));
}

/** The same, for one of the tab's addresses as it is (`#homeroom-bot`, or a place in its chat). */
export function goBotAddress(href: string): void {
  if (typeof window === 'undefined' || !/^#homeroom-bot(?:\/|$)/.test(href)) return;
  if (window.location.hash !== href) { window.location.hash = href; return; }
  (window as { App?: { restoreFromHash?: () => void } }).App?.restoreFromHash?.();
}

if (typeof window !== 'undefined') {
  const host = ((window as any).UsernodeReact ||= {});
  host.ai = { ...(host.ai || {}), openAt: askBotTab, openItem: (hash: string) => { const item = botItemAt(hash); if (item) askBotItem(item); }, closeColumn: askBotClose, openNew: (hash: string) => { const fresh = botNewAt(hash); if (fresh) askBotNew(fresh); }, botTabFromMessages: (href: string) => botTabFromMessages(href, botConversation) };
}
