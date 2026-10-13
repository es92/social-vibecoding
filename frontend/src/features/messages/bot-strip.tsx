import { useState, type ReactNode } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useResolvedCommunityColor } from '../../lib/community-color';
import * as api from './api';
import { tryChange } from './bot-ready';
import { requestHue, requestKey } from './bot-request';
import { loadBotWork, useBotWork } from './bot-work';
import { openThreadAt } from './store';
import type { HomeroomBotCurrentJob, HomeroomBotJob, HomeroomBotPastJob, HomeroomBotWork } from './types';

/*
 * The activity drawer in the chat with Homeroom bot (one request, one story).
 *
 * The chat itself draws each request as one row (./bot-news-line.tsx), and
 * each request's story is its thread. What is true NOW, across every request,
 * is here: what needs the person, what is ready to try, what is in progress,
 * and what went live today, read from the same endpoint and store the
 * activity tray used (./bot-work.tsx: GET /api/conversations/homeroom-bot/
 * work, read again on the bot's news and on `homeroom_bot_work_changed`). It
 * changes in place; nothing about it is posted to the chat.
 *
 *   - An ACTIVITY BAR under the header: "1 needs you #18 · 2 ready to try ·
 *     2 in progress · 1 done today", zero parts left out, with the numbers of
 *     what needs them in their own colours (./bot-request.ts). Pressing it
 *     opens the drawer OVER the chat, which keeps its place underneath,
 *     dimmed; the bar or the dimmed chat closes it. It starts closed; the
 *     person's choice is remembered on the device.
 *   - NEEDS YOU, a row each with ONE button that opens the request's thread
 *     at the message waiting on them (the entry's `ask`, flashed:
 *     store.openThreadAt). Opening a request closes the drawer.
 *   - READY TO TRY, with Try it and, when their yes would count, Approve: the
 *     ready card's own two acts (./bot-ready.tsx).
 *   - IN PROGRESS and DONE TODAY, a row each, saying what it is doing.
 *
 * Each request appears once, in the first group that fits, with its number
 * in its own colour. No step numbers and no timings: the thread says those.
 *
 * OWNERSHIP. Every node here is React's, inside the thread pane React owns.
 * Nothing is drawn until the first read lands, so a first render matches.
 */

export type StripGroup = 'needs' | 'ready' | 'progress' | 'done';

/** One request's row in the strip, from its tray entry. */
export interface StripRow {
  key: string;
  group: StripGroup;
  job: HomeroomBotJob;
  /** What the row says under the title. */
  state: string;
  /**
   * What its one button says (Needs you), as a message id, or null for a row
   * that is itself the button.
   */
  action: string | null;
  /** The thread and the message the row opens. */
  rootId: number | null;
  focusId: number | null;
}

export interface StripModel {
  needs: StripRow[];
  ready: StripRow[];
  progress: StripRow[];
  done: StripRow[];
}

/** The most numbers of what needs them the bar names. */
export const NEEDS_LIMIT = 3;
/** Done is what went live in the last day. */
const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The endings of History that wait on the person while a message of theirs still asks. */
const NEEDS_OUTCOMES = new Set(['question', 'person', 'blocked', 'empty', 'build_failed', 'needs_look', 'failed', 'stopped']);
const READY_OUTCOMES = new Set(['proposed', 'checking']);
const DONE_OUTCOMES = new Set(['live', 'going_live', 'closed']);

/** What a Needs you row says, by what waits on them. */
const NEEDS_STATES: Record<string, string> = {
  question: 'messages:bot.strip.state.needsAnswer',
  followup_ask: 'messages:bot.strip.state.needsAnswer',
  plan: 'messages:bot.strip.state.planReady',
  person: 'messages:bot.strip.state.needsDecision',
  build_failed: 'messages:bot.strip.state.stopped',
  first_version_failed: 'messages:bot.strip.state.stopped',
  blocked: 'messages:bot.strip.state.blocked',
  empty: 'messages:bot.strip.state.empty',
  checks: 'messages:bot.strip.state.needsLook',
  needs_look: 'messages:bot.strip.state.needsLook',
  failed: 'messages:bot.strip.state.stopped',
  stopped: 'messages:bot.strip.state.stopped',
  on_hold: 'messages:bot.strip.state.onHold',
  secrets: 'messages:bot.strip.state.secrets',
};

/** Its one button, by the same. */
const NEEDS_ACTIONS: Record<string, string> = {
  question: 'messages:bot.strip.action.answer',
  followup_ask: 'messages:bot.strip.action.answer',
  plan: 'messages:bot.strip.action.buildIt',
  person: 'messages:bot.strip.action.decide',
  build_failed: 'messages:bot.strip.action.tryAgain',
  first_version_failed: 'messages:bot.strip.action.tryAgain',
  blocked: 'messages:bot.strip.action.addDetail',
  empty: 'messages:bot.strip.action.addDetail',
};

/** What In progress says a request is doing, by its progress stage, else its phase. */
const STAGE_WORDS: Record<string, string> = {
  reading: 'messages:bot.strip.doing.reading',
  planning: 'messages:bot.strip.doing.planning',
  starting: 'messages:bot.strip.doing.building',
  building: 'messages:bot.strip.doing.building',
  reviewing: 'messages:bot.strip.doing.building',
  proposing: 'messages:bot.strip.doing.building',
  checks: 'messages:bot.strip.doing.testing',
  testing: 'messages:bot.strip.doing.testing',
  queued: 'messages:bot.strip.doing.queued',
  build_queued: 'messages:bot.strip.doing.queued',
  followup_queued: 'messages:bot.strip.doing.followingUp',
  fix_queued: 'messages:bot.strip.doing.followingUp',
  revising: 'messages:bot.strip.doing.followingUp',
  fixing: 'messages:bot.strip.doing.followingUp',
  merging: 'messages:bot.strip.doing.goingLive',
  setting_up: 'messages:bot.strip.doing.settingUp',
};
const PHASE_WORDS: Record<string, string> = {
  looking: 'messages:bot.strip.doing.reading',
  building: 'messages:bot.strip.doing.building',
  queued: 'messages:bot.strip.doing.queued',
  follow_up_queued: 'messages:bot.strip.doing.followingUp',
  following_up: 'messages:bot.strip.doing.followingUp',
  merging: 'messages:bot.strip.doing.goingLive',
  setting_up: 'messages:bot.strip.doing.settingUp',
};

/** "Dark mode", "Plant Pal, first version", "Request #12": a row's title, with no project prefix. */
export function stripTitle(job: Pick<HomeroomBotJob, 'appName' | 'appUnnamed' | 'issueNumber' | 'title' | 'firstVersion'>): string {
  // A project nobody can name is not named by its stand-in: its own wording.
  if (job.firstVersion) return job.appUnnamed ? translate('messages:bot.job.firstVersionUnnamed') : translate('messages:bot.strip.firstVersion', { project: job.appName });
  if (job.title) return job.title;
  return job.issueNumber ? translate('messages:bot.strip.requestNumber', { number: String(job.issueNumber) }) : job.appName;
}

/** What an In progress request is doing, in a word or two ("building"). */
export function doingWord(job: HomeroomBotCurrentJob): string {
  const key = (job.stage && STAGE_WORDS[job.stage]) || PHASE_WORDS[job.phase] || 'messages:bot.strip.doing.building';
  return translate(key);
}

/** Which Needs you case an entry is: what waits on them, from its ask, its stage or its ending. */
function needsCase(job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }): string {
  if (job.stage === 'on_hold') return 'on_hold';
  if (job.ask?.kind) return job.ask.kind;
  if (job.outcome) return job.outcome;
  return 'secrets';
}

/** Pure: a Needs you row's words, and its one button. */
export function needsRow(job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }): { state: string; action: string } {
  const which = needsCase(job);
  let state: string;
  if ((which === 'question' || which === 'followup_ask') && job.ask?.question) state = job.ask.question;
  else if ((which === 'build_failed' || which === 'first_version_failed') && job.stopCause === 'time') state = translate('messages:bot.strip.state.stoppedTime');
  else state = translate(NEEDS_STATES[which] || 'messages:bot.strip.state.needsYou');
  return { state, action: NEEDS_ACTIONS[which] || 'messages:bot.strip.action.open' };
}

/** Pure: a Ready to try row's words. */
export function readyState(job: HomeroomBotJob & { outcome?: string | null }): string {
  if (job.outcome === 'checking') return translate('messages:bot.strip.state.testing');
  if (job.ready?.approve) return translate('messages:bot.strip.state.readyForYes');
  if (job.ready?.waiting) return translate('messages:bot.strip.state.waitingFor', { who: job.ready.waiting });
  return translate('messages:bot.strip.state.waitingApproval');
}

function stripRow(job: HomeroomBotJob, group: StripGroup, state: string, action: string | null, focusId: number | null): StripRow {
  return { key: job.key, group, job, state, action, rootId: job.cardId || null, focusId };
}

/**
 * Pure: the strip's four groups from one read of the tray, in order, each
 * request once (the first group that fits). Needs you: what waits on them
 * (the tray's Needs you, an ending of History whose message still asks, and
 * work on hold until Monday); Ready to try: a change up for their yes or
 * being checked; In progress: the rest of Now; Done: what went live (or was
 * closed) in the last day.
 */
export function stripGroups(work: HomeroomBotWork | null, now: Date = new Date()): StripModel {
  const model: StripModel = { needs: [], ready: [], progress: [], done: [] };
  if (!work) return model;
  const placed = new Set<string>();
  const place = (row: StripRow) => {
    if (placed.has(row.key)) return;
    placed.add(row.key);
    model[row.group].push(row);
  };
  const askOf = (job: HomeroomBotJob) => job.ask?.messageId || null;
  const needs = (job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }) => {
    const { state, action } = needsRow(job);
    place(stripRow(job, 'needs', state, action, askOf(job)));
  };
  const past = [...work.needsYou, ...work.history];
  for (const job of work.needsYou) {
    if (job.outcome && READY_OUTCOMES.has(job.outcome)) continue;
    needs(job);
  }
  for (const job of work.history) {
    if (job.outcome && NEEDS_OUTCOMES.has(job.outcome) && job.ask) needs(job);
  }
  for (const job of work.now) if (job.stage === 'on_hold') needs(job);
  for (const job of past) {
    if (job.outcome && READY_OUTCOMES.has(job.outcome)) {
      place(stripRow(job, 'ready', readyState(job), null, job.ready?.messageId || null));
    }
  }
  for (const job of work.now) place(stripRow(job, 'progress', doingWord(job), null, null));
  for (const job of work.history) {
    const at = job.at ? Date.parse(job.at) : NaN;
    if (!job.outcome || !DONE_OUTCOMES.has(job.outcome) || !Number.isFinite(at) || now.getTime() - at > DONE_WINDOW_MS) continue;
    const said = job.outcome === 'closed' ? 'messages:bot.strip.state.closed' : 'messages:bot.strip.state.live';
    place(stripRow(job, 'done', translate(said), null, null));
  }
  return model;
}

/**
 * Each request in the tray by its key (./bot-request.ts), with the group it
 * is in and what its row says: where it stands NOW, for the chat's news rows.
 * Read once per tray read.
 */
const NOW_CACHE = new WeakMap<HomeroomBotWork, Map<string, StripRow>>();
export function trayNow(work: HomeroomBotWork | null): Map<string, StripRow> | null {
  if (!work) return null;
  const cached = NOW_CACHE.get(work);
  if (cached) return cached;
  const model = stripGroups(work);
  const map = new Map<string, StripRow>();
  for (const row of [...model.needs, ...model.ready, ...model.progress, ...model.done]) {
    const key = requestKey(row.job);
    if (key && !map.has(key)) map.set(key, row);
  }
  NOW_CACHE.set(work, map);
  return map;
}

/** Pure: the summary bar's parts, zero ones left out ("1 needs you", "2 ready to try"…). */
export function summaryParts(model: StripModel): Array<{ group: StripGroup; text: string }> {
  const parts: Array<{ group: StripGroup; text: string }> = [];
  if (model.needs.length) parts.push({ group: 'needs', text: translate('messages:bot.strip.summary.needs', { count: model.needs.length }) });
  if (model.ready.length) parts.push({ group: 'ready', text: translate('messages:bot.strip.summary.ready', { count: model.ready.length }) });
  if (model.progress.length) parts.push({ group: 'progress', text: translate('messages:bot.strip.summary.progress', { count: model.progress.length }) });
  if (model.done.length) parts.push({ group: 'done', text: translate('messages:bot.strip.summary.done', { count: model.done.length }) });
  return parts;
}

// ── The drawer, open or closed, remembered per device ──

const HIDDEN_KEY = 'homeroom:botDrawer:open';

export function rememberedOpen(): boolean | null {
  try {
    const value = window.localStorage.getItem(HIDDEN_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

function rememberOpen(open: boolean): void {
  try { window.localStorage.setItem(HIDDEN_KEY, open ? '1' : '0'); } catch { /* a private window: this visit only */ }
}

// ── The view ──

/**
 * A project's tile: its icon image, else its emoji, else its initial on the
 * project's colour (../../lib/community-color.ts). `size` is the strip's
 * row (36px) or a news line's (22px). Decorative: the words beside it name
 * the project.
 */
export function ProjectTile({ name, slug = null, iconUrl = null, emoji = null, size = 'row' }: {
  name: string; slug?: string | null; iconUrl?: string | null; emoji?: string | null; size?: 'row' | 'line';
}) {
  const color = useResolvedCommunityColor({ iconUrl, iconEmoji: emoji, key: slug || name || 'project' });
  const box = size === 'row'
    ? 'h-9 w-9 rounded-[10px] text-[15px]'
    : 'h-[22px] w-[22px] rounded-[6px] text-[11px]';
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden font-bold text-white ${box} bg-zinc-400 dark:bg-zinc-600`}
      style={color ? { backgroundColor: color } : undefined}
      aria-hidden="true"
      data-bot-tile=""
    >
      {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" draggable="false" />
        : emoji ? <span className={size === 'row' ? 'text-[18px] leading-none' : 'text-[12px] leading-none'}>{emoji}</span>
          : (name.trim().slice(0, 1).toUpperCase() || '?')}
    </span>
  );
}

const TAG = 'inline-flex shrink-0 items-center rounded-[6px] px-1.5 font-semibold tabular-nums bg-[hsl(var(--req-h)_80%_92%)] text-[hsl(var(--req-h)_70%_26%)] dark:bg-[hsl(var(--req-h)_35%_25%)] dark:text-[hsl(var(--req-h)_80%_82%)]';

/** A request's number, "#18", in its own colour: the same in the drawer, the chat and its thread. */
export function RequestTag({ number, size = 'row' }: { number: number | null | undefined; size?: 'row' | 'line' | 'head' }) {
  if (!number || number <= 0) return null;
  const text = size === 'head' ? 'text-[13px] leading-5' : 'text-[12px] leading-[18px]';
  return (
    <span className={`${TAG} ${text}`} style={{ ['--req-h' as string]: String(requestHue(number)) }} data-request-tag={number}>
      {`#${number}`}
    </span>
  );
}

// Complete literals: Tailwind's extractor reads source text.
const EYEBROW = 'px-4 pb-1 pt-2.5 text-[12px] font-bold uppercase tracking-[0.06em]';
const PILL_PRIMARY = 'inline-flex shrink-0 items-center rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60 dark:bg-violet-500 dark:hover:bg-violet-400';
const PILL_SECONDARY = 'inline-flex shrink-0 items-center rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700';
const NEED_INK = 'text-amber-700 dark:text-amber-400';

/** Open a row's request: its thread at the message it names, else its own page. */
function openRow(row: StripRow): void {
  if (row.rootId || row.focusId) { openThreadAt(row.rootId, row.focusId); return; }
  if (row.job.href && typeof window !== 'undefined') window.location.hash = row.job.href;
}

function RowText({ row }: { row: StripRow }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        {row.job.firstVersion ? null : <RequestTag number={row.job.issueNumber} />}
        <span className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{stripTitle(row.job)}</span>
      </span>
      <span className={`truncate text-[13px] leading-[18px] first-letter:uppercase ${row.group === 'needs' ? NEED_INK : 'text-zinc-500 dark:text-zinc-400'}`} data-bot-strip-state="">{row.state}</span>
    </span>
  );
}

function Tile({ job }: { job: HomeroomBotJob }) {
  return <ProjectTile name={job.appName} slug={job.appSlug} iconUrl={job.iconUrl} emoji={job.iconEmoji} />;
}

/** A Needs you row: its words, and its one button, which opens the thread at what waits. */
function NeedsRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  const t = useMessages('messages');
  return (
    <li className="flex items-center gap-3 px-4 py-2" data-bot-strip-row="needs" data-bot-strip-key={row.key}>
      <Tile job={row.job} />
      <RowText row={row} />
      <button type="button" className={PILL_PRIMARY} data-bot-strip-act="open" onClick={() => onOpen(row)}>{t(row.action || 'messages:bot.strip.action.open')}</button>
    </li>
  );
}

/** A Ready to try row: Try it, and Approve when their yes counts. */
function ReadyRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  const t = useMessages('messages');
  const ready = row.job.ready || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = ready?.sessionId || null;
  const canApprove = !!ready?.approve && !!sessionId;

  function tryIt() {
    if (sessionId && row.job.appSlug) { tryChange({ appSlug: row.job.appSlug }, sessionId); return; }
    openRow(row);
  }

  async function approve() {
    if (!sessionId) return;
    setBusy(true); setError(null);
    const out = await api.approveChange(sessionId, ready?.epoch ?? null);
    setBusy(false);
    if (out.ok) { loadBotWork(); return; }
    setError(out.stale ? t('messages:bot.strip.approveStale') : out.error || t('messages:bot.strip.approveFailed'));
  }

  return (
    <li className="px-4 py-2" data-bot-strip-row="ready" data-bot-strip-key={row.key}>
      <div className="flex items-center gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(row)}>
          <Tile job={row.job} />
          <RowText row={row} />
        </button>
        <button type="button" className={PILL_SECONDARY} data-bot-strip-act="try" onClick={tryIt}>{t('messages:bot.strip.action.tryIt')}</button>
        {canApprove ? <button type="button" className={PILL_PRIMARY} data-bot-strip-act="approve" disabled={busy} onClick={() => { void approve(); }}>{t('messages:bot.strip.action.approve')}</button> : null}
      </div>
      {error ? <p role="alert" className="mt-1 pl-12 text-[13px] text-red-700 dark:text-red-400">{error}</p> : null}
    </li>
  );
}

/** A row that is itself the button: Done's. */
function PlainRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  return (
    <li data-bot-strip-row={row.group} data-bot-strip-key={row.key}>
      <button type="button" className="flex w-full items-center gap-3 px-4 py-2 text-left" onClick={() => onOpen(row)}>
        <Tile job={row.job} />
        <RowText row={row} />
      </button>
    </li>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className: string }) {
  return <div className={`${EYEBROW} ${className}`}>{children}</div>;
}

export interface BotStripViewProps {
  work: HomeroomBotWork | null;
  /** The remembered Hide / Show; null for none. */
  remembered?: boolean | null;
  onRemember?: (open: boolean) => void;
  /** For a test: the moment "today" is counted back from. */
  now?: Date;
}

/** The drawer's chevron: down while closed, turned up while open. */
function Chevron({ open }: { open: boolean }) {
  return <ChevronDownIcon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${open ? 'rotate-180' : ''}`} />;
}

/**
 * The activity drawer, from one read: a pure render, so a test can draw every
 * state. A bar under the chat's header says what is waiting ("1 needs you #18
 * · 2 ready to try"); pressing it opens the drawer OVER the chat, which keeps
 * its place underneath. Opening a request closes it. Closed until the person
 * opens it; their choice is remembered on the device.
 */
export function BotStripView({ work, remembered = null, onRemember, now }: BotStripViewProps) {
  const t = useMessages('messages');
  const model = stripGroups(work, now || new Date());
  const [open, setOpen] = useState<boolean>(remembered ?? false);
  const parts = summaryParts(model);
  if (!parts.length) return null;
  const choose = (next: boolean) => { setOpen(next); onRemember?.(next); };
  const onOpen = (row: StripRow) => { choose(false); openRow(row); };
  const needTags = model.needs.slice(0, NEEDS_LIMIT).map((row) => row.job.issueNumber).filter((n): n is number => !!n && n > 0);
  return (
    <section className="relative z-20 shrink-0" aria-label={t('messages:bot.strip.name')} data-bot-strip={open ? 'open' : 'closed'}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 bg-[color:var(--dc-sheet-solid)] px-4 py-2.5 text-left shadow-[inset_0_-1px_0_var(--app-sheet-line)] hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
        aria-expanded={open}
        data-bot-strip-toggle=""
        onClick={() => choose(!open)}
      >
        <span className="shrink-0 text-[14px] font-[650] text-zinc-900 dark:text-zinc-100">{t('messages:bot.strip.activity')}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-600 dark:text-zinc-300" data-bot-strip-summary="">
          {parts.map((part, index) => (
            <span key={part.group}>
              {index ? <span aria-hidden="true">{' · '}</span> : null}
              <span className={part.group === 'needs' ? NEED_INK : undefined} data-bot-strip-count={part.group}>{part.text}</span>
              {part.group === 'needs' && needTags.length ? (
                <span className="ml-1 inline-flex gap-1 align-[1px]">{needTags.map((n) => <RequestTag key={n} number={n} />)}</span>
              ) : null}
            </span>
          ))}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <>
          <div className="absolute inset-x-0 top-full h-[100vh] bg-zinc-900/10 dark:bg-black/40" aria-hidden="true" data-bot-strip-scrim="" onClick={() => choose(false)} />
          <div
            className="absolute inset-x-0 top-full max-h-[45vh] overflow-y-auto md:max-h-[min(70vh,560px)] overscroll-contain rounded-b-[20px] bg-[color:var(--dc-sheet-solid)] pb-2 shadow-[0_18px_36px_rgba(0,0,0,0.18)]"
            data-bot-strip-drawer=""
          >
            {model.needs.length ? (
              <>
                <Eyebrow className={NEED_INK}>{t('messages:bot.strip.group.needs')}</Eyebrow>
                <ul data-bot-strip-group="needs">{model.needs.map((row) => <NeedsRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
            {model.ready.length ? (
              <>
                <Eyebrow className="text-violet-700 dark:text-violet-300">{t('messages:bot.strip.group.ready')}</Eyebrow>
                <ul data-bot-strip-group="ready">{model.ready.map((row) => <ReadyRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
            {model.progress.length ? (
              <>
                <Eyebrow className="text-zinc-500 dark:text-zinc-400">{t('messages:bot.strip.group.progress')}</Eyebrow>
                <ul data-bot-strip-group="progress">{model.progress.map((row) => <PlainRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
            {model.done.length ? (
              <>
                <Eyebrow className="text-zinc-500 dark:text-zinc-400">{t('messages:bot.strip.group.done')}</Eyebrow>
                <ul data-bot-strip-group="done">{model.done.map((row) => <PlainRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The strip in the chat with Homeroom bot, kept current by BotWorkSync (./bot-work.tsx). */
export function BotStrip() {
  // Subscribed: the rows' words are read from the catalog as this renders.
  useMessages('messages');
  const { work } = useBotWork();
  const [remembered] = useState(rememberedOpen);
  return <BotStripView work={work} remembered={remembered} onRemember={rememberOpen} />;
}
