/**
 * #6071 follow-up: a new thread with Homeroom bot, from its "+" (the
 * Homeroom bot tab's header, and the bot chat's header in Messages).
 *
 * The "+" opens a BLANK thread where a thread pane goes. Nothing is saved
 * yet: the thread is made when the person sends their first message
 * (POST /api/conversations/homeroom-bot/new-thread, then the message as its
 * first reply), and a stray tap leaves nothing behind.
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
 *   [▦ Any project ⌄]                  ← the project, floating over the box
 *   [ + | Message Homeroom bot | 🎙 | ↑ ] ← the same box as every chat
 *
 * The project is chosen as a community is (./project-picker.tsx: the "Your
 * communities" rows, a sheet on a phone, a menu from 768px). Any project is
 * the default. The kind of change the thread is for is no longer picked: it
 * is read off the start the message begins with (`startOf`), so the server
 * still gets the kind it knows (services/private-threads.js CHANGE_KINDS)
 * and names the thread's line in Main by it. A design start says Homeroom
 * bot draws the screen (services/design-bot.js write_screen), over the box.
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
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';

import { ChatComposerBar } from '@/components/ui/chat';
import { AppWindowIcon, ArrowTopRightOnSquareIcon, ArrowUpIcon, ChatIcon, FlagIcon, PaperClipIcon, PencilSquareIcon, PlusIcon, SparklesIcon, XIcon } from '@/components/ui/icons';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { DropOverlay, useFileDrag } from '../attachments/file-drag';
import { MAX_ATTACHMENTS, stageFiles } from '../attachments/limits';
import { SpeakButton } from '../dictation/speak-button';
import * as api from './api';
import { closeThread, openThread } from './store';
import { BOT_AVATAR, fileSize } from './format';
import type { MessageAttachment } from './types';
import { loadCommunities } from '../workshop/community-scope';
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

// Which conversation a blank thread is open beside, or none.
let blankIn: number | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** What a blank thread opens already set to, when its door named them (../ai/door.ts botNewAddress). */
export interface NewThreadPreset {
  project: string | null;
  builder: Builder;
}
// The last door's settings, and how many doors have named any: a thread
// already open takes a later door's too.
let preset: NewThreadPreset | null = null;
let presetTurn = 0;

/**
 * Open a blank thread beside the bot chat `conversationId` (closing a thread
 * open there). The "+" opens it on Any project and Homeroom bot; a door that
 * names a project or who works on it passes them as `fresh`.
 */
export function startNewThread(conversationId: number, fresh?: NewThreadPreset | null): void {
  if (!conversationId) return;
  closeThread();
  preset = fresh || null;
  if (fresh) presetTurn += 1;
  blankIn = conversationId;
  notify();
}

/** Close the blank thread. */
export function closeNewThread(): void {
  if (blankIn === null) return;
  blankIn = null;
  notify();
}

/** Whether a blank thread is open beside `conversationId`. */
export function useNewThread(conversationId: number | null | undefined): boolean {
  const open = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => blankIn,
    () => null,
  );
  return !!conversationId && open === conversationId;
}

/** A started thread's name in its head: the kind of change it is for, or New thread. */
export function startedThreadTitle(t: (id: string) => string, changeKind: string | null | undefined): string {
  if (changeKind === 'fix') return t('messages:newThread.kinds.fix');
  if (changeKind === 'add') return t('messages:newThread.kinds.add');
  if (changeKind === 'design') return t('messages:newThread.kinds.design');
  return t('messages:newThread.title');
}

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function key(): string {
  let out = 'newthread-';
  for (let i = 0; i < 16; i += 1) out += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  return out;
}

/** The "+" that opens a blank thread with Homeroom bot. */
export function NewThreadButton({ conversationId, className, onOpen }: {
  conversationId: number | null;
  className: string;
  /** Before the blank thread opens: to bring the chat it opens beside into view. */
  onOpen?: () => void;
}): ReactNode {
  const t = useMessages('messages');
  if (!conversationId) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label={t('messages:newThread.start')}
      title={t('messages:newThread.start')}
      data-bot-new-thread=""
      onClick={() => { onOpen?.(); startNewThread(conversationId); }}
    >
      <PlusIcon aria-hidden="true" />
    </button>
  );
}

/** The blank thread itself, in a thread pane's place. */
export function NewThreadPanel({ conversationId }: { conversationId: number }): ReactNode {
  const t = useMessages('messages');
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
  const [uploading, setUploading] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  // Who works on it: Homeroom bot, or the person's own Claude Code or ChatGPT.
  const [builder, setBuilder] = useState<Builder>(() => preset?.builder || 'homeroom');
  const [pickingBuilder, setPickingBuilder] = useState(false);
  const [missed, setMissed] = useState(false);
  const builderChipRef = useRef<HTMLButtonElement | null>(null);
  const links = useBuilderConnections();
  const own = builder === 'homeroom' ? null : builder;
  const ownName = own ? BUILDER_NAME[own] : '';
  // Its connector is known to be missing: the steps take the thread's place.
  const setup = !!own && links.phase === 'ready' && !links.connected[own];
  // The kit's keyboard avoidance, as a thread's own scroller has it.
  const scroller = useRef<HTMLDivElement>(null);
  useComposerKeyboard(scroller);
  useAutoGrow(inputRef, words);
  // The starts in the reader's language: what each writes, and what it is for.
  const starts = NEW_THREAD_STARTS.map((start) => ({ ...start, text: t(start.text) }));
  const begun = startOf(words, starts);
  const drawing = begun?.kind === 'design';

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
    setMissed(false);
  }, [turn]);

  // A door named the project: the chip says its name once the communities
  // you are in are known, which the picker would otherwise read on opening.
  useEffect(() => {
    if (project) void loadCommunities();
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

  /** Attach a drop's, a paste's or a pick's files: stage them against the cap, then upload each. */
  const addFiles = async (files: File[]) => {
    const { upload, refused } = stageFiles(files, attachments.length + uploading, t);
    setError(refused || null);
    for (const file of upload) {
      setUploading((count) => count + 1);
      try {
        const attachment = await api.uploadAttachment(conversationId, file);
        setAttachments((items) => [...items, attachment]);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t('messages:composer.uploadFailed', { file: file.name }));
      } finally {
        setUploading((count) => Math.max(0, count - 1));
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
  const begin = (start: (typeof starts)[number]) => {
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
    const link = builderLink(own, content, project || null);
    if (!link) { setError(t('messages:newThread.builder.tooLong', { max: HANDOFF_MAX })); return; }
    const tab = window.open(link, '_blank');
    if (!tab) { setError(t('messages:newThread.builder.blocked')); return; }
    try { tab.opener = null; } catch { /* another origin already */ }
    setError(null);
    closeNewThread();
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = words.trim();
    if (busy || dictating || uploading || (!content && !attachments.length)) return;
    if (own) { handOff(content); return; }
    setBusy(true);
    setError(null);
    try {
      const kind: ChangeKind = startOf(content, starts)?.kind || 'any';
      const made = await api.startBotThread({ project: project || null, kind });
      await api.sendMessage(conversationId, { content, threadRootId: made.rootId, attachmentIds: attachments.map((item) => item.id), idempotencyKey: key() });
      closeNewThread();
      openThread(made.rootId);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:newThread.failed'));
    } finally {
      setBusy(false);
    }
  };

  // Where the count turns amber, as in every other box.
  const nearLimit = words.length > 7600;

  return (
    <aside className="messages-reply-pane platform-kb-column dc-lift dc-lift-session" aria-label={t('messages:newThread.title')} data-bot-new-thread-pane="" data-bot-new-thread-own={own || undefined} data-bot-new-thread-setup={setup ? builder : undefined}>
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">{setup ? t('messages:newThread.builder.setup.title', { builder: ownName }) : t('messages:newThread.title')}</div>
          <div className="messages-thread-sub">
            {setup
              ? t('messages:newThread.builder.setup.sub')
              : own ? t('messages:newThread.builder.sub', { builder: ownName, product: BUILDER_PRODUCT[own] }) : t('messages:newThread.sub')}
          </div>
        </div>
        <button type="button" className="messages-thread-action" aria-label={t('messages:newThread.close')} title={t('messages:newThread.close')} onClick={() => closeNewThread()}>
          <XIcon aria-hidden="true" />
        </button>
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
            {starts.map((start) => (
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
                <span><RichMessage id={start.label} components={[<span className="messages-start-more" />]} /></span>
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
          {attachments.length || uploading ? (
            <div className="dc-attach-strip dc-attach-strip-active">
              {attachments.map((item) => (
                <div key={item.id} className="dc-attach-item">
                  <div className="min-w-0">
                    <div className="dc-attach-name">{item.name}</div>
                    <div className="dc-attach-size">{fileSize(item.size)}</div>
                  </div>
                  <button type="button" className="dc-attach-remove" onClick={() => setAttachments((items) => items.filter((candidate) => candidate.id !== item.id))} aria-label={t('messages:composer.removeAttachment', { file: item.name })}>×</button>
                </div>
              ))}
              {uploading ? <span className="dc-attach-uploading">{t('messages:composer.uploading', { count: uploading })}</span> : null}
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
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
              placeholder={own ? t('messages:newThread.builder.placeholder') : t('messages:newThread.placeholder')}
              aria-label={own ? t('messages:newThread.builder.placeholderLabel', { builder: ownName }) : t('messages:newThread.placeholder')}
              onChange={(e) => setWords(e.currentTarget.value)}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void addFiles(files); } }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
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
              <button type="submit" className="messages-send" onMouseDown={(event) => event.preventDefault()} disabled={busy || dictating || uploading > 0 || (!words.trim() && !attachments.length)} aria-label={t('messages:composer.send')} data-bot-new-thread-send="">
                <ArrowUpIcon aria-hidden="true" />
              </button>
            )}
          </div>
          {error ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
          <div className="messages-composer-count mt-1 px-1 flex justify-end h-[15px]" data-near-limit={nearLimit ? '' : undefined} aria-hidden={!words.length}><span className={`text-[10px] leading-[15px] ${nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{words.length ? `${words.length}/8000` : ''}</span></div>
        </div>
        {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
      </ChatComposerBar>
    </aside>
  );
}
