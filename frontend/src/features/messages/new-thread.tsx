/**
 * NEW CHAT: a new chat with Homeroom bot (#6071 follow-up; 14 Nov 2026).
 * Every conversation with the bot is a thread, so this is how one starts:
 * the labelled New chat button in the Homeroom bot tab's head, the phone's
 * Ask bar, and every door that names a project or a thing to ask about
 * (../ai/door.ts botNewAddress; ./store.ts openBot).
 *
 * It opens a NEW CHAT where a thread pane goes. Nothing is saved yet: the
 * thread is made when the person sends their first message
 * (POST /api/conversations/homeroom-bot/new-thread, then the message as its
 * first reply), and a stray tap leaves nothing behind. Nothing is ever sent
 * outside a thread.
 *
 * 5 Nov 2026 (Evan): it opens on what you can do, not on two web selects.
 *
 *            [H]
 *   What do you want to do?
 *   ( I want to fix an issue… )       ← starts, centred where messages go,
 *   ( I want to add a feature… )        each its own pill in the message
 *   ( I want to redesign the page… )    box's type; a tap writes its words
 *   ( I want to design a new page… )    into the box, caret after them
 *   ( I have a question about… )
 *
 *   [▦ Garden club ⌄]                  ← the project, floating over the box
 *   [ + | Message Homeroom bot | 🎙 | ↑ ] ← the same box as every chat
 *
 * The project is chosen as a community is (./project-picker.tsx: the "Your
 * communities" rows, a sheet on a phone, a menu from 768px). It comes
 * already set by whoever opened it (the page's one picked chip, the project
 * the person was last in, the project a door is about); Any project when
 * nothing says. The kind of change the thread is for is not picked: it is
 * read off the start the message begins with (`startOf`), so the server
 * still gets the kind it knows (services/private-threads.js CHANGE_KINDS)
 * and names the thread by it. A design start says Homeroom bot draws the
 * screen (services/design-bot.js write_screen), over the box.
 *
 * WHAT A DOOR CARRIED (14 Nov 2026). A door that used to put something in
 * Main Chat's box, an item to ask about (Ask for changes on a change, a
 * request open beside the lists), puts it here: the item is a chip in the
 * box's card, sent with the first message, and the box asks what the door
 * asked ("What should change?"). Its × takes it off.
 *
 * 10 Nov 2026: a second chip beside the project's says who works on it
 * (./thread-builder.tsx): Homeroom bot, as above, or the person's own Claude
 * Code or ChatGPT. For one of those nothing is sent here and no thread is
 * made: the send opens the product in a new tab with the box's words in it,
 * and until its connector is there the steps to add it take the thread's
 * place.
 *
 * The box is the conversation composer's card (./composer.tsx), drawn with
 * the same pieces: the "+" and its Attach files row, the field, dictation
 * (../dictation/speak-button.tsx) and the accent send disc.
 *
 * 26 Nov 2026: it is drawn as a thread is at every width, a title card
 * ("New chat" over who it is with) and then one card with the starts, the
 * choosers and the box (app.css, A TITLE CARD, THEN ONE CARD, AT EVERY
 * WIDTH), on a phone under a bar that says the tab's name. And once About is
 * a project whose app can be changed live, the title card offers Live
 * preview: START LIVE PREVIEW, below.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChatComposerBar } from '@/components/ui/chat';
import { AppWindowIcon, ArrowTopRightOnSquareIcon, ArrowUpIcon, ChatIcon, FlagIcon, ListBulletIcon, PaperClipIcon, PencilSquareIcon, PlayIcon, PlusIcon, SparklesIcon, XIcon } from '@/components/ui/icons';
import { setListClosed, useShowListButton } from '../ai/list-closed';
import { NewChatInBar, publishNewChatWords } from '../ai/new-chat-bar';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { createStore } from '../../lib/plain-store.js';
import { wantsKeyboardFocus } from '../message-actions/focus';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { useComposerStack } from '../../lib/use-composer-stack';
import { enterSends, useEnterSends } from '../../lib/enter-sends';
import { DropOverlay, useFileDrag } from '../attachments/file-drag';
import { MAX_ATTACHMENTS, stageFiles } from '../attachments/limits';
import { PendingStripRows } from '../attachments/pending-strip';
import { attachmentView, pendingUploadView, type PendingUpload } from './attachment-views';
import { SpeakButton } from '../dictation/speak-button';
import * as api from './api';
import { closeThread, openThread } from './store';
import { useStagedCard } from './composer';
import { BOT_AVATAR, pendingObjectLabel } from './format';
import { takeCarried } from './new-chat-carry';
import { platformSlug } from './channel-hub';
import type { MessageAttachment, SharedObjectReference, StagedObject } from './types';
import { communityScopeStore, describe, loadCommunities } from '../workshop/community-scope';
import { ProjectChip, ProjectPicker } from './project-picker';
import {
  BUILDER_NAME, BUILDER_PRODUCT, BuilderChip, BuilderPicker, BuilderSetup, HANDOFF_MAX, builderLink, useBuilderConnections, type Builder,
} from './thread-builder';

export type ChangeKind = 'any' | 'fix' | 'add' | 'design';
export const CHANGE_KINDS: readonly ChangeKind[] = ['any', 'fix', 'add', 'design'];

/**
 * The ways to start, in order: the words each writes into the box (`text`),
 * the pill that says them (`label`, the same words and a fainter "…"), and
 * the kind of change a message that begins with them is for.
 */
export const NEW_THREAD_STARTS = [
  { key: 'fix', kind: 'fix', label: 'messages:newThread.starts.fix.label', text: 'messages:newThread.starts.fix.text', Icon: FlagIcon },
  { key: 'add', kind: 'add', label: 'messages:newThread.starts.add.label', text: 'messages:newThread.starts.add.text', Icon: SparklesIcon },
  { key: 'redesign', kind: 'design', label: 'messages:newThread.starts.redesign.label', text: 'messages:newThread.starts.redesign.text', Icon: PencilSquareIcon },
  { key: 'newPage', kind: 'design', label: 'messages:newThread.starts.newPage.label', text: 'messages:newThread.starts.newPage.text', Icon: AppWindowIcon },
  { key: 'ask', kind: 'any', label: 'messages:newThread.starts.ask.label', text: 'messages:newThread.starts.ask.text', Icon: ChatIcon },
] as const;

/**
 * A sixth start, offered only once a project of its own is picked (never Any
 * project; Homeroom itself only for its admins, #6961): changing the project
 * live. Since 26 Nov 2026 it is the head's Live preview button, not a pill
 * (START LIVE PREVIEW, below): pressing it sends these words. Homeroom bot opens a live draft of it beside the chat
 * (homeroom-bot-mayor.js open_app_preview, services/live-drafts.js) and
 * changes it as they talk. Its kind is any: the thread is no particular kind
 * of change. It writes "I want to make changes to a live preview of" and the
 * project's name, which the bot reads as the request for that draft.
 */
export const LIVE_START = {
  key: 'live', kind: 'any', text: 'messages:newThread.starts.live.text', Icon: PlayIcon,
} as const;

/**
 * Pure: whether the live start is offered for the picked project: any
 * project of its own, and Homeroom's own app (the platform's slug) only to
 * an admin who can change it. Every other self-hosted app is never offered.
 */
export function offersLive(
  project: string | null | undefined,
  info: Record<string, { selfHosted?: boolean } | undefined>,
  { platformSlug = null, isAdmin = false }: { platformSlug?: string | null; isAdmin?: boolean } = {},
): boolean {
  if (!project) return false;
  if (platformSlug && project === platformSlug) return !!isAdmin;
  return !info[project]?.selfHosted;
}

/**
 * Pure: the start a message begins with (its words, ignoring case and the
 * space before them), the longest when two share a beginning; null for
 * words of the person's own.
 */
export function startOf<T extends { text: string }>(words: string, starts: readonly T[]): T | null {
  const said = String(words || '').replace(/^\s+/, '').toLocaleLowerCase();
  let best: T | null = null;
  for (const start of starts) {
    const text = String(start.text || '').trim().toLocaleLowerCase();
    if (text && said.startsWith(text) && (!best || text.length > best.text.trim().length)) best = start;
  }
  return best;
}

/**
 * Pure: the box's words once a start is tapped. The start's words lead,
 * then whatever followed the start the box already began with, or the
 * person's own words when it began with none, then a space for the caret.
 */
export function withStart<T extends { text: string }>(words: string, start: T, starts: readonly T[]): string {
  const current = startOf(words, starts);
  const lead = String(words || '').replace(/^\s+/, '');
  const rest = (current ? lead.slice(current.text.trim().length) : lead).trim();
  return `${start.text.trim()} ${rest}`.replace(/\s+$/, ' ');
}

/**
 * Pure: the message a live start sends. Its words lead; what the box held
 * follows after a colon, unless the box already began with them.
 */
export function leadWith(words: string, lead?: string | null): string {
  const typed = String(words || '').trim();
  const first = String(lead || '').trim();
  if (!first) return typed;
  if (!typed) return first;
  if (typed.toLocaleLowerCase().startsWith(first.toLocaleLowerCase())) return typed;
  return `${first}: ${typed}`;
}

// Which conversation a blank thread is open beside, or none.
let blankIn: number | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** What a new chat opens already set to, when its door named them (../ai/door.ts botNewAddress). */
export interface NewThreadPreset {
  project: string | null;
  builder: Builder;
  /** An item the door is about, attached in the box and sent with the first message. */
  object?: StagedObject | null;
  /** What the box asks while that item is attached (a catalog text, already read). */
  placeholder?: string | null;
  /**
   * 24 Nov 2026: words for the box, as a project's Workshop box took them
   * (./new-chat-carry.ts carryWordsToNewChat). They wait in the box, ready
   * to send; nothing is sent for the person.
   */
  words?: string | null;
  /** And a start to choose, by its key, as pressing it here would (`begin`). */
  start?: string | null;
}

// The last door's settings, and how many doors have named any: a thread
// already open takes a later door's too.
let preset: NewThreadPreset | null = null;
let presetTurn = 0;
// #7069: how many times New chat has been pressed. The caret goes in the box
// on every open, including one pressed again over a chat already open.
let openTurn = 0;

/**
 * Open a new chat in the bot chat `conversationId` (closing a thread open
 * there). Whoever opens it says what it is set to (`fresh`): the project,
 * who works on it, and an item it is about. An item a door carried for it
 * (./new-chat-carry.ts) is taken here, and is what the chat is about.
 */
export function startNewThread(conversationId: number, fresh?: NewThreadPreset | null): void {
  if (!conversationId) return;
  closeThread();
  const held = takeCarried();
  // What a door just carried is what this chat is about, over anything the
  // page would have attached on its own. Words and a start (a project's
  // Workshop box) carry no item, so the page's own item, if any, stays.
  preset = held
    ? {
        project: fresh?.project ?? null,
        builder: fresh?.builder || 'homeroom',
        object: held.object || (held.words || held.start ? fresh?.object || null : null),
        placeholder: held.object ? held.placeholder : (fresh?.placeholder ?? null),
        words: held.words,
        start: held.start,
      }
    : fresh || null;
  if (preset) presetTurn += 1;
  blankIn = conversationId;
  openTurn += 1;
  notify();
}

/** The chat a new chat is open in right now, else null: the live answer, for a caller that cannot wait for a render. */
export function newThreadIn(): number | null {
  return blankIn;
}

/** Close the new chat. */
export function closeNewThread(): void {
  if (blankIn === null) return;
  blankIn = null;
  notify();
}

/** Whether a new chat is open in `conversationId`. */
export function useNewThread(conversationId: number | null | undefined): boolean {
  const open = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => blankIn,
    () => null,
  );
  return !!conversationId && open === conversationId;
}

/** A started thread's name in its head: the kind of change it is for, or New chat. */
export function startedThreadTitle(t: (id: string) => string, changeKind: string | null | undefined): string {
  if (changeKind === 'fix') return t('messages:newThread.kinds.fix');
  if (changeKind === 'add') return t('messages:newThread.kinds.add');
  if (changeKind === 'design') return t('messages:newThread.kinds.design');
  return t('messages:newThread.title');
}

/** The reference alone, as the server takes it: the staged title stays on the chip (./composer.tsx). */
function referenceOf(object: StagedObject): SharedObjectReference {
  const { type, appId, appSlug, issueNumber, sessionId, proposalId, version } = object;
  return { type, appId, appSlug, issueNumber, sessionId, proposalId, version };
}

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function key(): string {
  let out = 'newthread-';
  for (let i = 0; i < 16; i += 1) out += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  return out;
}

/**
 * THE DOCKED COLUMN'S RESTING STATE (24 Nov 2026). From 768px the bot tab's
 * column is never empty (../ai/index.tsx, THE COLUMN IS NEVER EMPTY BESIDE
 * THE LISTS, #7039): with nothing else open there it holds a new chat. A ✕
 * on that new chat closed it only for the page to start another at once,
 * so there it has none, and it is drawn as a thread is (app.css, NEW CHAT
 * IS DRAWN AS CARDS); opening a thread is how it is left. The bot tab says
 * so around its docked column only: a phone's drawer and Messages keep the
 * ✕, and it still works there.
 */
export const NewThreadDocked = createContext(false);

/**
 * START LIVE PREVIEW (26 Nov 2026). Once About is a project whose app can be
 * changed live (`offersLive`), the head offers it as a button, where the
 * sixth start used to write its words into the box:
 *
 *   New chat                         [▶ Live preview]
 *   With Homeroom bot, only you can see it
 *
 * Pressing it is the first message, sent for the person: the live start's
 * own words (LIVE_START, with anything already typed after them), so the
 * thread is made for that project and Homeroom bot opens the draft. A
 * message sent the usual way starts no preview.
 *
 * From 1500px the bot tab draws the preview's column beside New chat instead
 * (./live-start-pane.tsx, ../ai/index.tsx), with the button in it, or the
 * projects to pick from while About is Any project. That column is another
 * tree, so what it shows and does goes through this store and the two
 * functions under it; `LiveStartBeside` tells the head its button is there.
 */
export interface LiveStartState {
  /** The chat the new chat is open in. */
  conversationId: number;
  /** The project picked, or '' for Any project. */
  project: string;
  /** Its name, as the About chip says it. */
  name: string;
  /** A live preview of it can be started here. */
  offered: boolean;
  /** Homeroom bot is who works on it: a hand-off to Claude Code or ChatGPT has no preview. */
  bot: boolean;
  /** A send is under way, or a file is still uploading. */
  busy: boolean;
}
export const liveStartStore = createStore<LiveStartState | null>(null);
let liveStartActs: { start: () => void; pick: (slug: string) => void } | null = null;
/** Start the live preview of the new chat's project, as its head's button does. */
export function startLivePreview(): void { liveStartActs?.start(); }
/** Set the new chat's project, as its About chip's picker does. */
export function pickLiveProject(slug: string): void { liveStartActs?.pick(slug); }
/** True where the preview's column is drawn beside New chat, with the button in it. */
export const LiveStartBeside = createContext(false);
/**
 * The thread a live start just made, until Homeroom bot's draft is there:
 * the column beside it says the draft is opening instead of going away.
 */
export const liveOpeningStore = createStore<{ rootId: number; name: string } | null>(null);

/** The new chat itself, in a thread pane's place. */
export function NewThreadPanel({ conversationId }: { conversationId: number }): ReactNode {
  const t = useMessages('messages');
  const docked = useContext(NewThreadDocked);
  const beside = useContext(LiveStartBeside);
  // #6963: the bot tab's list is hidden, and a new chat under its own head
  // offers the same way back to it.
  const showList = useShowListButton();
  const [project, setProject] = useState(() => preset?.project || '');
  const [picking, setPicking] = useState(false);
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #6256: files, the way every other thread takes them — dropped, pasted or
  // picked from the "+". They upload at once to the bot chat, before the
  // thread exists; the thread is still made only on the first send, and an
  // upload never sent is left to the orphan-attachment sweep.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // #6862: a file still uploading is drawn too — an image as its own local
  // preview, dimmed with a progress ring, with no × until it lands.
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const uploading = pending.length;
  const pendingRef = useRef<PendingUpload[]>([]);
  pendingRef.current = pending;
  const uploadSeq = useRef(0);
  const [addOpen, setAddOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  // Who works on it: Homeroom bot, or the person's own Claude Code or ChatGPT.
  const [builder, setBuilder] = useState<Builder>(() => preset?.builder || 'homeroom');
  // What the door that opened it is about: a chip in the box's card, sent
  // with the first message; the box asks the door's own question meanwhile.
  const [object, setObject] = useState<StagedObject | null>(() => preset?.object || null);
  const [prompt, setPrompt] = useState<string | null>(() => preset?.placeholder || null);
  // The server's reading of the item, so its chip names its title and project (./composer.tsx).
  const stagedCard = useStagedCard(object);
  const [pickingBuilder, setPickingBuilder] = useState(false);
  const [missed, setMissed] = useState(false);
  const builderChipRef = useRef<HTMLButtonElement | null>(null);
  const links = useBuilderConnections();
  const own = builder === 'homeroom' ? null : builder;
  const ownName = own ? BUILDER_NAME[own] : '';
  // Its connector is known to be missing: the steps take the thread's place.
  const setup = !!own && links.phase === 'ready' && !links.connected[own];
  // ONE LOOK (25 Nov 2026): in the Homeroom bot tab's drawer on a phone the
  // bar is borrowed while the new chat is up, for its back disc
  // (../ai/new-chat-bar.ts): these are the words it says.
  // 26 Nov 2026: New chat is drawn there as it is from 768px, under a head
  // of its own that names it, so the bar says the tab's name beside the disc.
  const inBar = useContext(NewChatInBar);
  const barTitle = t('messages:ai.hero.name');
  const barSub = '';
  useIsomorphicLayoutEffect(() => {
    if (!inBar) return undefined;
    publishNewChatWords({ title: barTitle, sub: barSub });
    return undefined;
  }, [inBar, barTitle, barSub]);
  useEffect(() => (inBar ? () => publishNewChatWords(null) : undefined), [inBar]);
  // The kit's keyboard avoidance, as a thread's own scroller has it.
  const scroller = useRef<HTMLDivElement>(null);
  useComposerKeyboard(scroller);
  useAutoGrow(inputRef, words);
  // Phone review #58: once the text wraps, it has the card's whole width.
  const stacked = useComposerStack(inputRef, words);
  // Plain Enter sends on this device: the hint and the tooltip say so.
  const enterKey = useEnterSends();
  // The starts in the reader's language: what each writes, and what it is for.
  const scope = useSyncExternalStore(communityScopeStore.subscribe, communityScopeStore.get, communityScopeStore.get);
  // #6961: an admin may change Homeroom itself live; the mask "View as
  // non-admin" leaves isAdmin false, so it hides the start as it hides the rest.
  const live = offersLive(project, scope.info as Record<string, { selfHosted?: boolean } | undefined>, {
    platformSlug: platformSlug(),
    isAdmin: typeof window !== 'undefined' && !!(window as any).App?.user?.isAdmin,
  });

  // The name the live start says: the project's own, or its address name
  // until the communities you are in are read.
  const appName = (project && scope.info[project]?.name) || project || '';
  const pills = NEW_THREAD_STARTS.map((start) => ({ ...start, text: t(start.text, { app: appName }) }));
  // The live start has no pill (26 Nov 2026: the head's Live preview button
  // sends it). Its words are still read (`startOf`), and still written when
  // a door carries them (a project's Workshop box).
  const liveWords = t(LIVE_START.text, { app: appName });
  const starts = live ? [...pills, { ...LIVE_START, text: liveWords }] : pills;
  const begun = startOf(words, starts);
  const drawing = begun?.kind === 'design';
  // What a door carried for the box (a project's Workshop): its words, and
  // the start it chose, written in as pressing that start here would.
  const takeWords = (from: NewThreadPreset | null) => {
    if (!from || (!from.words && !from.start)) return false;
    const chosen = from.start ? starts.find((start) => start.key === from.start) || null : null;
    const said = String(from.words || '');
    setWords((chosen ? withStart(said, chosen, starts) : said).slice(0, 8000));
    return true;
  };

  // A door named the project or who works on it while this thread was
  // already open: it takes them too. The first render read them above.
  const turn = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => presetTurn,
    () => 0,
  );
  const turnTaken = useRef(turn);
  useEffect(() => {
    if (turn === turnTaken.current || !preset) return;
    turnTaken.current = turn;
    setProject(preset.project || '');
    setBuilder(preset.builder);
    setObject(preset.object || null);
    setPrompt(preset.placeholder || null);
    setMissed(false);
    if (takeWords(preset) || preset.object) toField();
  }, [turn]); // eslint-disable-line react-hooks/exhaustive-deps
  // The words a door carried go in once the starts are read, with the caret after them.
  useEffect(() => { if (takeWords(preset)) toField(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A door's item arrives with the caret in the box, ready for the question.
  useEffect(() => { if (object) toField(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // #7069: New chat puts the caret in the box, so the person can type at
  // once. On a touch-only phone it does not, so the keyboard stays down over
  // the starts they may want to tap (../message-actions/focus).
  const opened = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => openTurn,
    () => 0,
  );
  useEffect(() => { if (wantsKeyboardFocus()) toField(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  // A door named the project: the chip says its name once the communities
  // you are in are known, which the picker would otherwise read on opening.
  // 14 Nov 2026: a door can name a project the person is not in (a public
  // project's Workshop row, followed as a link, or a chip the bot page drew
  // from its address): the chip said "Any project" over a chat that was set
  // to that project all the same. Its name and icon are read once then.
  useEffect(() => {
    if (!project) return undefined;
    let live = true;
    void loadCommunities().then(() => {
      if (!live || communityScopeStore.get().info[project]) return null;
      return fetch(`/api/apps/${encodeURIComponent(project)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          const app = body && typeof body === 'object' ? (body.app || body) : null;
          if (!live || !app || app.slug !== project || typeof app.name !== 'string' || !app.name) return;
          describe(project, {
            name: app.name,
            iconUrl: app.icon_url || (app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null),
            iconEmoji: app.icon_emoji || null,
            iconColor: app.icon_color || null,
          });
        });
    }).catch(() => { /* the chip keeps Any project; the picker still chooses */ });
    return () => { live = false; };
  }, [project]);

  // Their own Claude Code or ChatGPT is picked, by the picker or by a door:
  // whether its connector is there is read once it matters.
  useEffect(() => {
    if (own && links.phase === 'idle') void links.load();
  }, [own, links.phase, links.load]);

  // Back from Claude or ChatGPT in another tab, with the steps up: look again.
  useEffect(() => {
    if (!setup) return undefined;
    const again = () => { void links.load(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [setup, links.load]);

  /** #6862: an upload's row and its local preview go together. */
  const forgetPending = (key: string) => {
    setPending((items) => {
      const gone = items.find((item) => item.key === key);
      if (gone?.thumbUrl) URL.revokeObjectURL(gone.thumbUrl);
      return items.filter((item) => item.key !== key);
    });
  };
  // A preview outlives neither the box nor its host.
  useEffect(() => () => {
    for (const item of pendingRef.current) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }, []);

  /** Attach a drop's, a paste's or a pick's files: stage them against the cap, then upload each. */
  const addFiles = async (files: File[]) => {
    const { upload, refused } = stageFiles(files, attachments.length + uploading, t);
    setError(refused || null);
    for (const file of upload) {
      // #6862: the row appears at once. An image shows its own picture, made
      // from the File and not yet on the server; anything else waits as a
      // card. Both say "uploading" and offer no × until the upload lands.
      const key = `p${(uploadSeq.current += 1)}`;
      const thumbUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((items) => [...items, { key, file, thumbUrl }]);
      try {
        const attachment = await api.uploadAttachment(conversationId, file);
        setAttachments((items) => [...items, attachment]);
        forgetPending(key);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t('messages:composer.uploadFailed', { file: file.name }));
        forgetPending(key);
      }
    }
  };

  // #4065: the same drop zone a reply thread has, in the same shared tracker.
  const drop = useFileDrag({ onFiles: (files) => { void addFiles(files); } });

  // The "+" menu closes the way every other transient panel in the shell
  // does: a press outside it, or Escape. Bound only while it is open.
  useEffect(() => {
    if (!addOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  /** The field, focused with its caret at the end of what it holds. */
  const toField = () => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  };

  /** A start tapped: its words lead the box, and the caret waits after them. */
  const begin = (start: (typeof pills)[number]) => {
    setWords((current) => withStart(current, start, starts).slice(0, 8000));
    toField();
  };

  const closePicker = useCallback(() => {
    setPicking(false);
    chipRef.current?.focus({ preventScroll: true });
  }, []);

  const closeBuilderPicker = useCallback(() => {
    setPickingBuilder(false);
    builderChipRef.current?.focus({ preventScroll: true });
  }, []);

  /** Check again, under the steps: read the connections, and say so when this product's is still not there. */
  const checkAgain = async () => {
    const found = await links.load();
    setMissed(!!own && !(found && found[own]));
  };

  /** The person's words, handed to their own Claude Code or ChatGPT in a new tab. Nothing is made here. */
  const handOff = (content: string) => {
    if (!own) return;
    if (attachments.length) { setError(t('messages:newThread.builder.files', { builder: ownName })); return; }
    // Nor can an attached item: only the person's own words go into the link.
    if (object) { setError(t('messages:newThread.builder.item', { builder: ownName })); return; }
    const link = builderLink(own, content, project || null);
    if (!link) { setError(t('messages:newThread.builder.tooLong', { max: HANDOFF_MAX })); return; }
    const tab = window.open(link, '_blank');
    if (!tab) { setError(t('messages:newThread.builder.blocked')); return; }
    try { tab.opener = null; } catch { /* another origin already */ }
    setError(null);
    closeNewThread();
  };

  const send = async (event?: FormEvent, lead?: string) => {
    event?.preventDefault();
    // A live start leads with its own words; what was typed follows them.
    const content = leadWith(words, lead);
    if (busy || dictating || uploading || (!content && !attachments.length && !object)) return;
    if (own) { handOff(content); return; }
    setBusy(true);
    setError(null);
    try {
      const kind: ChangeKind = startOf(content, starts)?.kind || 'any';
      const made = await api.startBotThread({ project: project || null, kind });
      await api.sendMessage(conversationId, {
        content, threadRootId: made.rootId, attachmentIds: attachments.map((item) => item.id), idempotencyKey: key(),
        ...(object ? { object: referenceOf(object) } : {}),
      });
      closeNewThread();
      openThread(made.rootId);
      // A live start: the column beside the thread says the draft is opening (../ai/index.tsx).
      if (lead) liveOpeningStore.set({ rootId: made.rootId, name: appName });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:newThread.failed'));
    } finally {
      setBusy(false);
    }
  };

  /** The head's Live preview, and the column's Start: the live start, sent. */
  const liveReady = live && !own && !setup;
  const startLive = () => { if (liveReady) void send(undefined, liveWords); };
  // The column beside (./live-start-pane.tsx) reads what this chat is set to
  // and acts on it through these.
  const holding = busy || dictating || uploading > 0;
  useIsomorphicLayoutEffect(() => {
    liveStartStore.set({ conversationId, project, name: appName, offered: liveReady, bot: !own, busy: holding });
  }, [conversationId, project, appName, liveReady, own, holding]);
  const acts = useRef({ start: startLive, pick: (slug: string) => { setProject(slug || ''); toField(); } });
  acts.current = { start: startLive, pick: (slug: string) => { setProject(slug || ''); toField(); } };
  useEffect(() => {
    liveStartActs = { start: () => acts.current.start(), pick: (slug) => acts.current.pick(slug) };
    return () => { liveStartActs = null; liveStartStore.set(null); };
  }, []);
  const liveInHead = liveReady && !beside;

  // Where the count turns amber, as in every other box.
  const nearLimit = words.length > 7600;
  // What the keys do, once the text runs to a second line, as under every
  // message box (./composer.tsx).
  const keysHint = enterKey && words.includes('\n') && !nearLimit;

  // #6862: what is staged, as the pending strip draws it — the files already
  // uploaded, then the ones still in flight. Only a landed file carries a ×.
  const staged = [...attachments.map(attachmentView), ...pending.map(pendingUploadView)];
  const removeStaged = (index: number) => {
    const item = attachments[index];
    if (item) setAttachments((items) => items.filter((candidate) => candidate.id !== item.id));
  };

  return (
    <aside className="messages-reply-pane platform-kb-column dc-lift dc-lift-session" aria-label={t('messages:newThread.title')} data-bot-new-thread-pane="" data-bot-new-thread-docked={docked ? '' : undefined} data-bot-new-thread-own={own || undefined} data-bot-new-thread-setup={setup ? builder : undefined}>
      <header className="messages-thread-header">
        {showList ? (
          <button type="button" className="messages-thread-action messages-thread-back" data-reply-show-list=""
            aria-label={t('messages:ai.list.show')} title={t('messages:ai.list.show')}
            onClick={() => setListClosed(false)}>
            <ListBulletIcon aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">{setup ? t('messages:newThread.builder.setup.title', { builder: ownName }) : t('messages:newThread.title')}</div>
          <div className="messages-thread-sub">
            {setup
              ? t('messages:newThread.builder.setup.sub')
              : own ? t('messages:newThread.builder.sub', { builder: ownName, product: BUILDER_PRODUCT[own] })
              // The button shares the head's one line with these words, so they are the short ones:
              // in a narrow column the long line was cut to "With Homeroom bo…" beside it.
              : liveInHead ? t('messages:newThread.barSub') : t('messages:newThread.sub')}
          </div>
        </div>
        {liveInHead ? (
          <Button type="button" variant="unstyled" size="none" ink="none" className="messages-live-start" data-bot-new-thread-live="" disabled={holding}
            aria-label={t('messages:newThread.live.startLabel', { app: appName })} title={t('messages:newThread.live.startLabel', { app: appName })}
            // The field keeps the keyboard if it had it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={startLive}>
            <PlayIcon aria-hidden="true" />
            <span>{t('messages:newThread.live.button')}</span>
          </Button>
        ) : null}
        {/* In the phone's drawer the bar's back disc is the way out. */}
        {docked || inBar ? null : (
          <button type="button" className="messages-thread-action" aria-label={t('messages:newThread.close')} title={t('messages:newThread.close')} onClick={() => closeNewThread()}>
            <XIcon aria-hidden="true" />
          </button>
        )}
      </header>
      {/* Claude Code or ChatGPT picked, and Homeroom's connector is not in it
          yet: the steps to add it, where the starts and the box go. Those two
          stay mounted behind it (app.css hides them), so what was typed is
          still there once it is connected. */}
      {setup && own ? (
        <BuilderSetup
          builder={own}
          checking={links.phase === 'loading'}
          missed={missed}
          onCheck={() => { void checkAgain(); }}
          onUseBot={() => { setBuilder('homeroom'); setMissed(false); toField(); }}
        />
      ) : null}
      {/* A thread's foot, as every chat's (@/components/ui/chat, "A chat's
          foot"), with no typing line: nobody else is in a thread that does
          not exist yet. The starts sit in the middle of it, where the first
          message will land (app.css "THE BLANK THREAD'S OPENING"). */}
      <div ref={scroller} className="messages-thread-scroll messages-reply-scroll platform-safe-scroll flex flex-col justify-end chat-transcript">
        <div className="messages-starts" data-bot-new-thread-start="">
          <div className="messages-starts-hello">
            <img src={BOT_AVATAR} alt="" />
            <h2 className="messages-starts-title">{t('messages:newThread.welcome.title')}</h2>
            <p className="messages-starts-sub">{t('messages:newThread.welcome.sub')}</p>
          </div>
          <div className="messages-starts-list" role="group" aria-label={t('messages:newThread.starts.label')} data-bot-new-thread-starts="">
            {pills.map((start) => (
              <button
                key={start.key}
                type="button"
                className="messages-start"
                data-bot-new-thread-opener={start.key}
                data-bot-new-thread-kind={start.kind}
                aria-pressed={begun?.key === start.key}
                // The field keeps the keyboard if it had it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => begin(start)}
              >
                <start.Icon aria-hidden="true" />
                <span><RichMessage id={start.label} values={{ app: appName }} components={[<span className="messages-start-more" />]} /></span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <ChatComposerBar as="form" className={`messages-composer messages-composer-thread${drop.dragging ? ' messages-composer-dragging' : ''}`} onSubmit={(e) => { void send(e); }} {...drop.handlers}>
        {drawing && !own ? <p className="messages-composer-hint" data-bot-new-thread-draws="">{t('messages:newThread.draws')}</p> : null}
        {own ? <p className="messages-composer-hint" data-bot-new-thread-handoff="">{t('messages:newThread.builder.handoff', { builder: ownName })}</p> : null}
        {/* The project it is for, floating over the box rather than in its card. */}
        <div className="messages-project-row">
          <ProjectChip
            slug={project || null}
            open={picking}
            onOpen={(el) => { chipRef.current = el; setAddOpen(false); setPickingBuilder(false); setPicking((open) => !open); }}
          />
          <BuilderChip
            builder={builder}
            open={pickingBuilder}
            onOpen={(el) => {
              builderChipRef.current = el;
              setAddOpen(false);
              setPicking(false);
              // Which products are connected is read here, the first time it is asked.
              if (!pickingBuilder && links.phase !== 'ready' && links.phase !== 'loading') void links.load();
              setPickingBuilder((open) => !open);
            }}
          />
        </div>
        <ProjectPicker
          open={picking}
          slug={project || null}
          anchor={chipRef.current}
          onPick={(slug) => { setProject(slug || ''); setPicking(false); toField(); }}
          onClose={closePicker}
        />
        <BuilderPicker
          open={pickingBuilder}
          builder={builder}
          links={links}
          anchor={builderChipRef.current}
          onPick={(next) => { setBuilder(next); setMissed(false); setError(null); setPickingBuilder(false); toField(); }}
          onClose={closeBuilderPicker}
        />
        {/* The conversation composer's card (./composer.tsx), piece for piece. */}
        <div className="messages-composer-card">
          {/* The files staged for the first message, as a reply thread draws
              them: name, size, and a × that takes it back off. */}
          {object ? (
            <div className="messages-pending-object" data-bot-new-thread-object={object.type}>
              <span aria-hidden="true">◆</span>
              <span className="truncate">{pendingObjectLabel(object, stagedCard)}</span>
              <button type="button" onClick={() => { setObject(null); setPrompt(null); }} aria-label={t('messages:composer.removeSharedItem')}>×</button>
            </div>
          ) : null}
          {staged.length ? (
            <div className="dc-attach-strip dc-attach-strip-active">
              <PendingStripRows items={staged} onRemove={removeStaged} />
              {uploading ? <span className="dc-attach-uploading">{t('messages:composer.uploading', { count: uploading })}</span> : null}
            </div>
          ) : null}
          <div className="messages-composer-row flex items-end gap-1.5" data-stacked={stacked ? '' : undefined}>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ''; }} />
            {/* The same "+" and menu a reply thread offers. The cap disables the
                Attach files ROW, never the "+" itself. */}
            <div className="messages-composer-add" ref={addRef}>
              <button type="button" className="messages-composer-action" onClick={() => setAddOpen((open) => !open)} aria-haspopup="menu" aria-expanded={addOpen} aria-label={t('messages:composer.addToMessage')} title={t('messages:composer.addToMessage')}><PlusIcon aria-hidden="true" /></button>
              {addOpen ? (
                <div className="messages-composer-menu" role="menu" aria-label={t('messages:composer.addToMessage')}>
                  <button type="button" role="menuitem" disabled={attachments.length + uploading >= MAX_ATTACHMENTS} onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>
                    <PaperClipIcon aria-hidden="true" />
                    <span>{t('messages:composer.attachFiles')}</span>
                  </button>
                </div>
              ) : null}
            </div>
            <textarea
              ref={inputRef}
              dir="auto"
              className="messages-composer-input"
              value={words}
              rows={1}
              maxLength={8000}
              placeholder={own ? t('messages:newThread.builder.placeholder') : (object && prompt) || t('messages:newThread.placeholder')}
              aria-label={own ? t('messages:newThread.builder.placeholderLabel', { builder: ownName }) : t('messages:newThread.placeholder')}
              onChange={(e) => setWords(e.currentTarget.value)}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void addFiles(files); } }}
              onKeyDown={(e) => {
                // Enter sends where there is a keyboard, as in every message box (lib/enter-sends.ts).
                if (enterSends(e.nativeEvent)) { e.preventDefault(); void send(); }
              }}
            />
            <SpeakButton scope="messages:new-thread" getText={() => inputRef.current?.value || ''} onText={setWords} maxLength={8000} onBusyChange={setDictating} disabled={busy} />
            {own ? (
              // Not a send: it opens the product, so it says Open and wears the leaving-arrow.
              <button type="submit" className="messages-send messages-send-open" onMouseDown={(event) => event.preventDefault()} disabled={dictating || links.phase === 'loading' || !words.trim()} aria-label={t('messages:newThread.builder.open', { builder: ownName })} data-bot-new-thread-open={own}>
                <span>{t('messages:newThread.builder.openShort')}</span>
                <ArrowTopRightOnSquareIcon aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="messages-send" onMouseDown={(event) => event.preventDefault()} disabled={busy || dictating || uploading > 0 || (!words.trim() && !attachments.length && !object)} aria-label={t('messages:composer.send')} title={enterKey ? t('messages:composer.sendShortcut') : undefined} data-bot-new-thread-send="">
                <ArrowUpIcon aria-hidden="true" />
              </button>
            )}
          </div>
          {error ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
          {keysHint ? <p className="mt-1 px-3 text-end text-[11px] leading-[15px] text-zinc-500 dark:text-zinc-400" data-enter-hint="">{t('messages:composer.newLineHint')}</p> : null}
          <div className="messages-composer-count mt-1 px-1 flex justify-end h-[15px]" data-near-limit={nearLimit ? '' : undefined} aria-hidden={!words.length}><span className={`text-[10px] leading-[15px] ${nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{words.length ? `${words.length}/8000` : ''}</span></div>
        </div>
        {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
      </ChatComposerBar>
    </aside>
  );
}
