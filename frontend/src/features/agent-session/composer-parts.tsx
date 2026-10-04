/**
 * The pieces of the agent-session composer's bottom row (#2779 follow-up,
 * the "composer, reworked" design): the model pill and the "Build with"
 * sheet it opens (#3078: Homeroom's models, or the hand-off to Claude Code or
 * Codex, as three tabs), the credits pill and the bar along its bottom, and
 * the files sent with a message as the transcript shows them.
 *
 * None of this is in the prerendered shell: the composer mounts with a
 * conversation, so nothing here has a hydration twin to match.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, ChevronRightIcon, XIcon } from '@/components/ui/icons';

import type { AiBudgetFigures } from '../header/ai-budget';
import { attachmentUrl, type AgentAttachment } from './api';
import { formatSize } from './attachments';
import { ANTHROPIC_PREFIX, OPENROUTER_PREFIX, shortModelName, type PickerOption } from './model-choice';

// ── Credits ────────────────────────────────────────────────────────────

export type CreditTone = 'green' | 'yellow' | 'red';

export interface CreditView {
  remainingCents: number;
  limitCents: number;
  /** What is left, 0..1. */
  fraction: number;
  tone: CreditTone;
  /** "$38 left", "$4.10 left", "None left". */
  label: string;
  /** The label with the allowance after it, for a pill with room: "$38 left / $50". */
  wideLabel: string;
  /** The allowance alone, "$50": the wide label's muted second half. */
  allowance: string;
  /** For a screen reader and the tooltip: "$38.40 of this week's $50.00 left". */
  description: string;
  weekly: boolean;
  byokCents: number;
}

function dollars(cents: number, exact = false): string {
  if (exact || cents < 1000) return `$${(cents / 100).toFixed(2)}`;
  return `$${Math.floor(cents / 100)}`;
}

/**
 * What the pill and its bar say, from the header's own figures
 * (../header/ai-credit.js). Green while more than 40% of the allowance is
 * left, yellow down to 15%, red below. Nothing for an account with no
 * allowance to spend (locked, unavailable, or no figures yet): the bar would
 * only ever read empty there.
 */
export function creditView(figures: AiBudgetFigures | null | undefined): CreditView | null {
  if (!figures || !(figures.limitCents > 0)) return null;
  if (figures.level === 'locked' || figures.level === 'unavailable') return null;
  const remainingCents = Math.max(0, Math.min(figures.limitCents, Number(figures.remainingCents) || 0));
  const fraction = remainingCents / figures.limitCents;
  const tone: CreditTone = fraction > 0.4 ? 'green' : fraction > 0.15 ? 'yellow' : 'red';
  const window = figures.weekly ? 'this week’s' : 'today’s';
  const label = remainingCents > 0 ? `${dollars(remainingCents)} left` : 'None left';
  return {
    remainingCents,
    limitCents: figures.limitCents,
    fraction,
    tone,
    label,
    wideLabel: `${label} / ${dollars(figures.limitCents)}`,
    allowance: dollars(figures.limitCents),
    description: `${dollars(remainingCents, true)} of ${window} ${dollars(figures.limitCents, true)} left`,
    weekly: !!figures.weekly,
    byokCents: Number(figures.byokCents) || 0,
  };
}

/** Complete literals: Tailwind reads these from the source. */
const PILL_INK: Record<CreditTone, string> = {
  green: 'text-zinc-900 dark:text-white',
  yellow: 'text-amber-700 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
};
const BAR_INK: Record<CreditTone, string> = {
  green: 'text-emerald-500 dark:text-emerald-400',
  yellow: 'text-amber-500 dark:text-amber-400',
  red: 'text-red-500 dark:text-red-400',
};
/**
 * "$38 left" in a gray pill beside Send; it opens the model sheet, which
 * spells it out. When the row leaves it room it says "$38 left / $50".
 *
 * "Room" is a container query, not a measured width: the pill's wrapper takes
 * the row's free space (it is the row's spacer) and holds the query container,
 * so the wide label shows once that space is 10rem or more and the pill never
 * reflows the row it measures. Both labels are rendered and CSS picks one;
 * the button's aria-label says the full figures either way.
 *
 * Along the pill's bottom edge runs what is left, as a bar clipped by the
 * pill's own rounding: anchored left, so as credits are spent it drains from
 * the right. It is decoration beside the words, so it is hidden from a
 * screen reader.
 *
 * #3574: the room never gets narrower than the short label. A query container
 * is sized as if it were empty, so the wrapper used to be free to shrink to
 * nothing; on a phone, beside a long model name, it did, and the pill (which
 * does not shrink) spilled out of its LEFT edge — the side `justify-end`
 * overflows to — and was drawn over the model pill. So the container is now
 * one layer in, filling a one-cell grid, and the other occupant of that cell
 * is an invisible, zero-height copy of the short label in the pill's own type
 * and padding. A grid is as wide as what is in it, so the room is at least as
 * wide as the pill, the row's flexbox has to find the space somewhere else,
 * and the model pill — `min-w-0`, truncating — is what gives it up.
 */
export function CreditPill({ credit, onOpen }: { credit: CreditView; onOpen: () => void }) {
  return (
    <div className="grid flex-1 justify-items-end" data-agent-session-credits-room>
      <span className="invisible col-start-1 row-start-1 h-0 whitespace-nowrap px-3 text-sm font-semibold tabular-nums" aria-hidden="true">{credit.label}</span>
      <div className="col-start-1 row-start-1 flex w-full justify-end [container-type:inline-size]">
        <button
          type="button"
          className={`relative inline-flex h-8 shrink-0 items-center overflow-hidden rounded-full bg-zinc-100 px-3 text-sm font-semibold tabular-nums dark:bg-zinc-700 ${PILL_INK[credit.tone]}`}
          aria-label={`Credits: ${credit.description}`}
          title={credit.description}
          data-agent-session-credits={credit.tone}
          onClick={onOpen}
        >
          <span className="[@container(min-width:10rem)]:hidden" data-agent-session-credits-label="compact">{credit.label}</span>
          {/* What is left in the tone's ink; the allowance after it in the
              muted ink, so the colour reads as "how much is left" alone. */}
          <span className="hidden [@container(min-width:10rem)]:inline" data-agent-session-credits-label="wide">
            {credit.label}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">{` / ${credit.allowance}`}</span>
          </span>
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]" aria-hidden="true">
            <span
              className={`block h-full bg-current ${BAR_INK[credit.tone]}`}
              style={{ width: `${Math.round(credit.fraction * 1000) / 10}%` }}
              data-agent-session-credits-bar
            />
          </span>
        </button>
      </div>
    </div>
  );
}

// ── The model pill and its sheet ────────────────────────────────────────

/**
 * The pill names the model and, for one that takes a thinking level, that
 * level after it in small muted type (#3079): "GPT-5 High". The label block is
 * centred in the pill; inside it the two words share one baseline.
 *
 * #3574: the name it shows is the model's SHORT name (model-choice.ts
 * shortModelName: "GLM 5.3 Flash", not "Z.ai: GLM 5.3 Flash"), because on a
 * phone this pill gets what the row has left. `label` stays the full name,
 * and the pill still says that one to a screen reader and, when the two
 * differ, as its tooltip. The credits pill beside it keeps its own width
 * (CreditPill), so a pill short of room gives it up from the inside, in this
 * order:
 *
 *   - The thinking level goes first, whole. The label block is a wrapping
 *     flex line one line tall that clips the rest, so a level with no room
 *     beside the name wraps out of sight instead of squeezing it. On one
 *     unwrapped line the level (`shrink-0`) kept "Extra high" at full width
 *     while the name shrank to nothing beside it, and then ran out of the
 *     pill. A screen reader still hears it, and the sheet the pill opens
 *     still shows it.
 *   - Then the name is cut with an ellipsis (`truncate`, alone on its line).
 *   - On a row under 18rem (a 320px phone: the row is a size container in
 *     index.tsx) the pill's side padding drops from 16px to 12px, to hand
 *     the name back some of the little room that row has.
 */
export function ModelPill({ label, effort = '', disabled, open, onOpen, pillRef }: {
  /** The model's full name, as the catalog gives it. */
  label: string;
  /** The thinking level's label, or '' for a model that takes none. */
  effort?: string;
  disabled: boolean;
  open: boolean;
  onOpen: () => void;
  pillRef: RefObject<HTMLButtonElement | null>;
}) {
  const short = shortModelName(label) || label;
  return (
    <button
      ref={pillRef}
      type="button"
      className="inline-flex h-10 min-w-0 max-w-[14rem] items-center rounded-full bg-zinc-100 px-4 text-[15px] font-medium [@container(max-width:18rem)]:px-3 text-zinc-900 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={effort ? `Model: ${label}, thinking ${effort}` : `Model: ${label}`}
      title={short !== label ? label : undefined}
      disabled={disabled}
      data-agent-session-model
      onClick={onOpen}
    >
      <span className="flex h-6 min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 overflow-hidden leading-6">
        <span className="truncate">{short}</span>
        {effort ? (
          <span className="shrink-0 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-model-effort>{effort}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The Homeroom tab's one "Model" list: the Claude models, then the OpenRouter
 * ones, then anything else. It used to be grouped under "Claude Code" and
 * "Codex" headings, which read as the two web agents the other tabs hand the
 * work to; here the Mayor runs every one of them.
 */
export function modelList(options: PickerOption[]): PickerOption[] {
  const claude = options.filter((option) => option.value.startsWith(ANTHROPIC_PREFIX));
  const codex = options.filter((option) => option.value.startsWith(OPENROUTER_PREFIX));
  const other = options.filter((option) => !claude.includes(option) && !codex.includes(option));
  return [...claude, ...codex, ...other];
}

export interface SheetEffort {
  value: string;
  options: PickerOption[];
  onPick: (value: string) => void;
}

/** The Homeroom tab's contents, from plain props so a test can draw it. */
export function ModelSheetBody({ options, value, onPick, effort, credit }: {
  options: PickerOption[];
  value: string;
  onPick: (value: string) => void;
  effort: SheetEffort | null;
  credit: CreditView | null;
}) {
  const [effortOpen, setEffortOpen] = useState(false);
  const effortLabel = effort ? (effort.options.find((option) => option.value === effort.value)?.label || effort.value) : '';
  const row = 'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700/60';
  return (
    <div className="flex flex-col gap-3" data-agent-session-model-sheet>
      <p className="px-1 text-sm leading-snug text-zinc-600 dark:text-zinc-300">The agent builds it here, on your Homeroom credits.</p>
      {options.length ? (
        <div className="flex flex-col gap-1">
          <p className="px-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">Model</p>
          <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
            {options.map((option, index) => {
              const chosen = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={chosen}
                  title={option.title || undefined}
                  className={`${row} ${index ? 'border-t border-zinc-100 dark:border-zinc-700' : ''}`}
                  data-agent-session-model-option={option.value}
                  onClick={() => onPick(option.value)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[15px] font-medium text-zinc-900 dark:text-zinc-100">
                      {option.label}
                      {option.isDefault ? <span className="ml-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">default</span> : null}
                    </span>
                    {option.detail ? <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{option.detail}</span> : null}
                  </span>
                  {chosen ? <CheckIcon className="h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {effort ? (
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
          <button
            type="button"
            className={row}
            aria-expanded={effortOpen}
            data-agent-session-effort
            onClick={() => setEffortOpen((open) => !open)}
          >
            <span className="flex-1 text-[15px] text-zinc-900 dark:text-zinc-100">Thinking level</span>
            <span className="text-[15px] text-zinc-500 dark:text-zinc-400">{effortLabel}</span>
            <ChevronRightIcon className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${effortOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
          {effortOpen ? effort.options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={option.value === effort.value}
              className={`${row} border-t border-zinc-100 py-2.5 pl-8 dark:border-zinc-700`}
              onClick={() => { effort.onPick(option.value); setEffortOpen(false); }}
            >
              <span className="flex-1 text-[15px] text-zinc-800 dark:text-zinc-200">
                {option.label}
                {option.isDefault ? <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">default</span> : null}
              </span>
              {option.value === effort.value ? <CheckIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null}
            </button>
          )) : null}
        </div>
      ) : null}
      {credit ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-white px-4 py-3 dark:bg-zinc-800" data-agent-session-sheet-credits>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{credit.weekly ? 'This week’s credits' : 'Today’s credits'}</p>
          <div
            role="meter"
            aria-label="Credits left"
            aria-valuemin={0}
            aria-valuemax={credit.limitCents / 100}
            aria-valuenow={credit.remainingCents / 100}
            className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
          >
            <div className={`h-full rounded-full bg-current ${BAR_INK[credit.tone]}`} style={{ width: `${Math.round(credit.fraction * 100)}%` }} />
          </div>
          <p className="flex flex-wrap gap-x-3 text-[13px] text-zinc-600 dark:text-zinc-300">
            <span className="flex-1">{credit.description}</span>
            {credit.byokCents > 0 ? <span className="text-zinc-500 dark:text-zinc-400">Your key: {dollars(credit.byokCents, true)} today</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ── Build with: the sheet's three tabs (#3078) ─────────────────────────

export type BuildTab = 'homeroom' | 'claude-code' | 'codex';

export const BUILD_TABS: Array<{ id: BuildTab; label: string }> = [
  { id: 'homeroom', label: 'Homeroom' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/**
 * "Build with": where this conversation's work is built. Homeroom is the
 * model list the pill always opened; Claude Code and Codex ARE the hand-off,
 * drawn in place rather than behind a second dialog. A real tablist: the
 * arrow keys, Home and End move between the tabs, and only the selected one
 * is in the Tab order.
 */
export function BuildSheetBody({ tab, onTab, onClose, heading = true, homeroom, handoff }: {
  tab: BuildTab;
  onTab: (tab: BuildTab) => void;
  onClose: () => void;
  heading?: boolean;
  homeroom: ReactNode;
  handoff: ReactNode;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = BUILD_TABS.findIndex((item) => item.id === tab);
    const next = event.key === 'ArrowRight' ? (at + 1) % BUILD_TABS.length
      : event.key === 'ArrowLeft' ? (at + BUILD_TABS.length - 1) % BUILD_TABS.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? BUILD_TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onTab(BUILD_TABS[next].id);
    strip.current?.querySelector<HTMLElement>(`[data-agent-session-build-tab="${BUILD_TABS[next].id}"]`)?.focus();
  };
  return (
    <div className="flex flex-col gap-3" data-agent-session-build={tab}>
      {heading ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <h2 className="mr-[52px] flex-1 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">Build with</h2>
        </div>
      ) : null}
      <div
        ref={strip}
        role="tablist"
        aria-label="Build with"
        className="flex gap-1 rounded-full bg-zinc-200/70 p-1 dark:bg-zinc-800"
        onKeyDown={move}
      >
        {BUILD_TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`agent-session-build-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="agent-session-build-panel"
              tabIndex={selected ? 0 : -1}
              className={`flex-1 whitespace-nowrap rounded-full px-2 py-1.5 text-sm font-semibold ${selected
                ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100'}`}
              data-agent-session-build-tab={item.id}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="agent-session-build-panel"
        aria-labelledby={`agent-session-build-tab-${tab}`}
        data-agent-session-build-panel={tab}
      >
        {tab === 'homeroom' ? homeroom : handoff}
      </div>
    </div>
  );
}

function wide(): boolean {
  try { return window.matchMedia('(min-width: 640px)').matches; } catch { return false; }
}

/**
 * The sheet itself: a bottom sheet on a phone, a popover over the pill on a
 * wider screen. Portalled to the page so nothing it sits in can clip it.
 * Escape, the backdrop and a pick close it, and focus goes back to the pill.
 */
export function ModelSheet({ anchor, onClose, children }: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [desktop] = useState(wide);
  const [place, setPlace] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);

  // Over the whole composer card, not just the pill, so the box stays in
  // view: left-aligned with the pill, as tall as the room above allows.
  useLayoutEffect(() => {
    if (!desktop) return;
    const pill = anchor.current;
    const rect = pill?.getBoundingClientRect();
    if (!rect) return;
    const top = pill?.closest('form')?.getBoundingClientRect().top ?? rect.top;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 12 - 352));
    setPlace({
      left,
      bottom: Math.max(12, window.innerHeight - top + 8),
      maxHeight: Math.max(200, Math.min(window.innerHeight * 0.8, top - 20)),
    });
  }, [desktop, anchor]);

  useEffect(() => {
    const pill = anchor.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    const first = panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      || panel.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey, true);
      pill?.focus();
    };
  }, [anchor, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div
        className={desktop ? 'fixed inset-0 z-[70]' : 'fixed inset-0 z-[70] bg-black/40'}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal={desktop ? undefined : true}
        aria-label="Build with"
        className={desktop
          ? 'fixed z-[71] w-[22rem] overflow-y-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900'
          : 'fixed inset-x-0 bottom-0 z-[71] max-h-[85vh] overflow-y-auto rounded-t-[28px] bg-zinc-50 px-4 pb-8 pt-2 dark:bg-zinc-900'}
        style={desktop && place ? { left: place.left, bottom: place.bottom, maxHeight: place.maxHeight } : undefined}
      >
        {desktop ? null : <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" />}
        {children}
      </div>
    </>,
    document.body,
  );
}

// ── Files, as sent ──────────────────────────────────────────────────────

/** A sent message's files: images as thumbnails, the rest as chips. Each opens or downloads the file. */
export function SentAttachments({ sessionId, attachments }: { sessionId: number | null; attachments: AgentAttachment[] }) {
  if (!sessionId || !attachments.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap items-start justify-end gap-2" data-agent-session-attachments={attachments.length}>
      {attachments.map((att) => {
        const href = attachmentUrl(sessionId, att.id);
        if (att.kind === 'image') {
          return (
            <a key={att.id} href={href} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
              <img src={href} alt={att.filename} loading="lazy" className="h-24 w-24 object-cover" />
            </a>
          );
        }
        return (
          <a
            key={att.id}
            href={href}
            download={att.filename}
            className="flex max-w-[14rem] flex-col rounded-xl bg-zinc-100 px-3 py-2 text-left dark:bg-zinc-800"
          >
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{att.filename}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatSize(att.sizeBytes)}</span>
          </a>
        );
      })}
    </div>
  );
}
