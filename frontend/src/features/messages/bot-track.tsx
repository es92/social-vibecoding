import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  ChatIcon, CheckIcon, ClockIcon, EyeIcon, ListLinesIcon, NoSymbolIcon, PencilSquareIcon, PlayIcon, SpinnerArcIcon,
  UserIcon, WarningTriangleIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { buttonVariants } from '@/components/ui/button';

import { firstSpecScreen, type SpecScreen } from '../../lib/spec-html';
import { lineWords, stageWords, type Stage } from '../../lib/work-state';
import { BotActivityCard, ActivityLink, spanText } from './bot-activity';
import { requestKey } from './bot-request';
import { useBotWork } from './bot-work';
import type { BotFiledNext, BotTrack, BotTrackStep, ConversationMessage, HomeroomBotWork } from './types';

/*
 * One track per request (16 Oct 2026), drawn the same everywhere.
 *
 * A track is a request's stored work state (services/work-state.js, ten
 * stages, worded by lib/work-state.ts: the same words on every screen) and
 * what its card draws around it (services/homeroom-bot-track.js): the step
 * its bar lights, its try and clock, its place in a line, who shipped it.
 * A request's thread, its page and the bot's slots page draw it here:
 *
 *   TrackBadge   the small square a row leads with: what it waits on, or how
 *                it ended
 *   TrackBar     the five steps (Plan, Build, Checks, Vote, Live), the one it
 *                is on lit; "Build, try 2" once it has looped
 *   TrackCard    a request's card: its status word and try, where it is and
 *                why, this try's clock, the bar, its links and its pictures
 *
 * Nothing here reads on its first render beyond the store it is handed
 * (./bot-work.tsx), and every picture loads in an effect.
 */

export const TRACK_STEPS: readonly BotTrackStep[] = ['plan', 'build', 'checks', 'vote', 'live'];

const STEP_WORDS: Record<BotTrackStep, string> = {
  plan: 'messages:bot.track.step.plan',
  build: 'messages:bot.track.step.build',
  checks: 'messages:bot.track.step.checks',
  vote: 'messages:bot.track.step.vote',
  live: 'messages:bot.track.step.live',
};

// Why a build that did not finish stopped (homeroom-bot-track.js
// buildStopWhy): the second line a stopped build says.
const CAUSE_LINES: Record<string, string> = {
  time: 'messages:bot.track.line.stopped.time',
  restart: 'messages:bot.track.line.stopped.restart',
  restarts: 'messages:bot.track.line.stopped.restarts',
  unproposed: 'messages:bot.track.line.stopped.unproposed',
  not_pushed: 'messages:bot.track.line.stopped.not_pushed',
  no_change: 'messages:bot.track.line.stopped.no_change',
  no_change_already: 'messages:bot.track.line.stopped.no_change_already',
  no_change_unclear: 'messages:bot.track.line.stopped.no_change_unclear',
  no_change_could_not: 'messages:bot.track.line.stopped.no_change_could_not',
  no_start: 'messages:bot.track.line.stopped.no_start',
  build_failed: 'messages:bot.track.line.stopped.build_failed',
};

// Papote #3: what a request waits on, naming who it waits on, for a page
// anyone can open (BotTrack.waitingFor).
const NAMED_WAITING_LINES: Record<string, string> = {
  question: 'messages:bot.track.line.waiting.questionNamed',
  plan: 'messages:bot.track.line.waiting.planNamed',
  needs_detail: 'messages:bot.track.line.waiting.detailNamed',
};

/** The stages that are over: what "finished" counts. */
export const ENDED_STAGES: ReadonlySet<Stage> = new Set(['live', 'stopped', 'closed']);

/** Pure: a phrase, said. */
const say = (p: { id: string; values?: Record<string, string | number> } | null) => (p ? translate(p.id, p.values) : '');

/**
 * Pure: a track's stage word, the one every screen uses (lib/work-state.ts):
 * "Building"; "Waiting on @sam" where it waits on somebody else and the
 * page names them.
 */
export function trackStateWord(track: Pick<BotTrack, 'work'> & { waitingFor?: string }): string {
  if (track.work.stage === 'waiting_for_you' && track.waitingFor) {
    return translate('messages:bot.track.state.waitingNamed', { username: track.waitingFor });
  }
  return say(stageWords(track.work, { yours: !track.waitingFor }));
}

/** Pure: where it is now, in a sentence: the stage's second line, or what the track knows beside it. */
export function trackLine(track: BotTrack): string {
  const work = track.work;
  if (work.stage === 'closed' && track.doneBy?.username) {
    return track.doneBy.prNumber
      ? translate('messages:bot.track.line.done_elsewhere.by', { username: track.doneBy.username, number: String(track.doneBy.prNumber) })
      : translate('messages:bot.track.line.done_elsewhere.byNoPr', { username: track.doneBy.username });
  }
  if (track.held?.limit === 'allowance' && track.held.until) {
    const date = new Date(track.held.until);
    if (!Number.isNaN(date.getTime())) {
      const when = date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return translate('messages:bot.track.line.held.until', { date: when });
    }
  }
  // #6357: paused for a day after repeated errors, which is not building time.
  if (work.line?.code === 'cooldown' && track.retryAt) {
    const date = new Date(track.retryAt);
    if (!Number.isNaN(date.getTime())) {
      const when = date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return translate('messages:bot.track.line.cooldown.until', { date: when });
    }
  }
  if (work.stage === 'waiting_for_you' && track.waitingFor && work.why && NAMED_WAITING_LINES[work.why]) {
    return translate(NAMED_WAITING_LINES[work.why], { username: track.waitingFor });
  }
  if (work.stage === 'stopped' && track.cause && CAUSE_LINES[track.cause]) return translate(CAUSE_LINES[track.cause]);
  return say(lineWords(work)) || trackStateWord(track);
}

// #6151: after "Filed it as request #14…" in a design thread, what happens
// next, by the limit a held request waits at (services/design-threads.js
// filedNext). Each a whole sentence: the limit in the track's own words.
const FILED_HELD_LINES: Record<string, string> = {
  builds: 'messages:bot.track.filed.held.builds',
  slots: 'messages:bot.track.filed.held.slots',
  bot_wide: 'messages:bot.track.filed.held.bot_wide',
  allowance: 'messages:bot.track.filed.held.allowance',
};

/**
 * Pure (#6151): what happens to a design filed as a request, in a sentence:
 * Homeroom bot reads it next and builds it from its version, builds it once
 * a limit frees, or a person decides. Null for codes this client does not
 * know.
 */
export function filedNextLine(next: BotFiledNext | null | undefined): string | null {
  if (!next) return null;
  if (next.say === 'builds') return next.version > 0 ? translate('messages:bot.track.filed.builds', { version: String(next.version) }) : null;
  if (next.say === 'held') return FILED_HELD_LINES[next.limit] ? translate(FILED_HELD_LINES[next.limit]) : null;
  if (next.say === 'person') return translate('messages:bot.track.filed.person');
  return null;
}

/** Pure: a held track's place in line, in words, or null (a queued one's line says its place). */
export function trackPlace(track: BotTrack): string | null {
  if (track.held?.position && (track.held.limit === 'builds' || track.held.limit === 'slots')) {
    const ahead = track.held.position - 1;
    return ahead > 0 ? translate('messages:bot.track.held.ahead', { count: ahead }) : translate('messages:bot.track.held.next');
  }
  return null;
}

/**
 * Pure: a track's line where there is room for one short phrase (the slots
 * page's rows): one held for a slot says only its place in line, since its
 * heading already says it is on hold; #6156: one held for the bot's turn
 * among the project's builds, its place in that line; anything else, where
 * it is and its place.
 */
export function trackShort(track: BotTrack): string {
  if (track.held?.limit === 'builds' && track.held.position) {
    const ahead = track.held.position - 1;
    return ahead > 0 ? translate('messages:bot.track.held.aheadBuild', { count: ahead }) : translate('messages:bot.track.held.nextBuild');
  }
  if (track.held?.limit === 'slots' && track.held.position) {
    const ahead = track.held.position - 1;
    return ahead > 0 ? translate('messages:bot.track.held.aheadSlot', { count: ahead }) : translate('messages:bot.track.held.next');
  }
  return [trackLine(track), trackPlace(track)].filter(Boolean).join(' · ');
}

/**
 * Pure: the second line where the stage word is said beside it (a badge's
 * name, a card's status): empty when the stage has no second line, so the
 * word is never said twice ("Building: Building").
 */
export function trackDetail(track: BotTrack): string {
  const line = trackLine(track);
  return line === trackStateWord(track) ? '' : line;
}

/** Pure: whether the bot is at it this minute, building or planning, so its clock ticks. */
const ticks = (track: Pick<BotTrack, 'work' | 'tryStartedAt'>) => !!track.tryStartedAt
  && (track.work.stage === 'building' || track.work.stage === 'planning');

/** Pure: this try's clock in words ("15m so far"), for work under way, else null. */
export function trackClock(track: BotTrack, now: Date): string | null {
  if (!ticks(track)) return null;
  const span = spanText(track.tryStartedAt!, now);
  return span ? translate('messages:bot.track.soFar', { duration: span }) : null;
}

/** Pure: the stage word with its try, "Building · Try 2", for the eyebrow of a card. */
export function trackEyebrow(track: BotTrack): string {
  const word = trackStateWord(track);
  return track.try > 1 && !ENDED_STAGES.has(track.work.stage)
    ? `${word} · ${translate('messages:bot.track.try', { number: String(track.try) })}`
    : word;
}

/** The tracks of one read of the bot's work, by request (./bot-request.ts requestKey). */
const BY_KEY = new WeakMap<HomeroomBotWork, Map<string, BotTrack>>();
export function tracksByKey(work: HomeroomBotWork | null): Map<string, BotTrack> | null {
  if (!work || !Array.isArray(work.tracks)) return null;
  const cached = BY_KEY.get(work);
  if (cached) return cached;
  const map = new Map<string, BotTrack>();
  for (const track of work.tracks) {
    const key = requestKey(track);
    if (key && !map.has(key)) map.set(key, track);
  }
  BY_KEY.set(work, map);
  return map;
}

/** The track of one request in the viewer's bot work, when the store has it. */
export function useTrackOf(item: Parameters<typeof requestKey>[0] | null): BotTrack | null {
  const { work } = useBotWork();
  const key = item ? requestKey(item) : null;
  return key ? tracksByKey(work)?.get(key) || null : null;
}

// ── The look ──

type Tone = 'need' | 'ready' | 'working' | 'held' | 'good' | 'ended' | 'trouble';
type Glyph = (props: { className?: string; strokeWidth?: string; 'aria-hidden'?: 'true' }) => ReactNode;

// Complete literals: Tailwind's extractor reads source text. The same
// family of small squares as the chat's other badges.
const TINT: Record<Tone, string> = {
  need: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  ready: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
  working: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  held: 'bg-zinc-200/80 text-amber-600 dark:bg-zinc-700/70 dark:text-amber-400',
  good: 'bg-zinc-200/80 text-emerald-600 dark:bg-zinc-700/70 dark:text-emerald-400',
  ended: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  trouble: 'bg-zinc-200/80 text-red-600 dark:bg-zinc-700/70 dark:text-red-400',
};

const WAIT_GLYPHS: Record<string, Glyph> = {
  question: ChatIcon, plan: ListLinesIcon, needs_detail: PencilSquareIcon, decide: UserIcon, already_works: CheckIcon,
};
const HELD_LINES: ReadonlySet<string> = new Set(['held_builds', 'held_waiting', 'on_hold', 'cooldown']);
const WAITING_LINES: ReadonlySet<string> = new Set(['queued', 'waiting']);

/** Pure: a track's tone and glyph, for its badge and its bar, by its stage. */
export function trackLook(track: Pick<BotTrack, 'work' | 'busy'>): { tone: Tone; icon: Glyph; spin: boolean } {
  const { stage, why, reason } = track.work;
  const code = track.work.line?.code || '';
  switch (stage) {
    case 'waiting_for_you': return { tone: 'need', icon: WAIT_GLYPHS[why || ''] || ChatIcon, spin: false };
    case 'up_for_vote': return { tone: 'ready', icon: PlayIcon, spin: false };
    case 'checking': return code === 'checks_failing'
      ? { tone: 'trouble', icon: WarningTriangleIcon, spin: false }
      : { tone: 'working', icon: SpinnerArcIcon, spin: !!track.busy };
    case 'going_live': case 'live': return { tone: 'good', icon: CheckIcon, spin: false };
    case 'closed': return { tone: 'ended', icon: XIcon, spin: false };
    case 'stopped': return reason === 'change_closed'
      ? { tone: 'ended', icon: NoSymbolIcon, spin: false }
      : { tone: 'trouble', icon: WarningTriangleIcon, spin: false };
    default:
      if (code === 'claimed') return { tone: 'ended', icon: UserIcon, spin: false };
      if (HELD_LINES.has(code)) return { tone: 'held', icon: ClockIcon, spin: false };
      if (WAITING_LINES.has(code)) return { tone: 'working', icon: ClockIcon, spin: false };
      return { tone: 'working', icon: SpinnerArcIcon, spin: !!track.busy };
  }
}

/** The small square a request's row leads with: what it waits on, or how it ended, named in words. */
export function TrackBadge({ track }: { track: BotTrack }) {
  const look = trackLook(track);
  const Icon = look.icon;
  const words = [trackStateWord(track), trackDetail(track)].filter(Boolean).join(': ');
  return (
    <span
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${TINT[look.tone]}`}
      title={words}
      data-bot-track-badge={track.work.stage}
    >
      <Icon aria-hidden="true" className={`h-3.5 w-3.5${look.spin ? ' animate-spin [animation-duration:2.4s]' : ''}`} strokeWidth="2.25" />
      <span className="sr-only">{words}</span>
    </span>
  );
}

// The bar's segments. A bar still moving is drawn in the lit ink; a finished
// one is green, as a change page's Votes and Testing cards are; what waits on
// the person is amber, a hold a dimmer amber, and a stop red or grey.
const SEG_DONE = 'bg-[color:var(--lit-ink)] opacity-50';
const SEG_NOW: Record<Tone, string> = {
  need: 'bg-amber-500 dark:bg-amber-400',
  ready: 'bg-[color:var(--lit-ink)]',
  working: 'bg-[color:var(--lit-ink)]',
  held: 'bg-amber-300 dark:bg-amber-500/70',
  good: 'bg-[color:var(--state-ok)]',
  ended: 'bg-zinc-400 dark:bg-zinc-500',
  trouble: 'bg-red-500 dark:bg-red-400',
};
const SEG_NEXT = 'bg-zinc-200 dark:bg-zinc-700';
const SEG_LIVE = 'bg-[color:var(--state-ok)]';

/**
 * Pure: each of the five steps' look, from a track: `done` before the step it
 * is on, `now` for it, `next` after; every step green once it is live (or
 * shipped another way); nothing lit before the first step (queued) or for a
 * request that was just closed.
 */
export function stepLooks(track: Pick<BotTrack, 'work' | 'step' | 'doneBy'>): Array<'done' | 'now' | 'next' | 'live'> {
  if (track.work.stage === 'live' || (track.work.stage === 'closed' && track.doneBy)) return TRACK_STEPS.map(() => 'live');
  const at = track.step ? TRACK_STEPS.indexOf(track.step) : -1;
  return TRACK_STEPS.map((_, index) => (at < 0 ? 'next' : index < at ? 'done' : index === at ? 'now' : 'next'));
}

/**
 * The five steps, Plan, Build, Checks, Vote, Live, the one it is on lit.
 * With `labels`, each step's name under it, "Build, try 2" once the work has
 * looped back to building. Named in words for a screen reader.
 */
export function TrackBar({ track, labels = false, className = '' }: { track: BotTrack; labels?: boolean; className?: string }) {
  const t = useMessages('messages');
  const looks = stepLooks(track);
  const tone = trackLook(track).tone;
  const at = track.step ? TRACK_STEPS.indexOf(track.step) : -1;
  const label = at >= 0
    ? t('messages:bot.track.bar', { state: trackStateWord(track), step: at + 1, name: t(STEP_WORDS[TRACK_STEPS[at]]) })
    : t('messages:bot.track.barNone', { state: trackStateWord(track) });
  const stepName = (step: BotTrackStep) => (step === 'build' && track.try > 1
    ? t('messages:bot.track.step.buildTry', { number: String(track.try) })
    : t(STEP_WORDS[step]));
  return (
    <div className={`flex flex-col gap-1 ${className}`} role="img" aria-label={label} data-bot-track-bar={track.work.stage}>
      <div className="grid grid-cols-5 gap-[3px]">
        {looks.map((look, index) => (
          <i
            key={TRACK_STEPS[index]}
            className={`block ${labels ? 'h-1.5' : 'h-1'} rounded-full ${look === 'live' ? SEG_LIVE : look === 'done' ? SEG_DONE : look === 'now' ? SEG_NOW[tone] : SEG_NEXT}${look === 'now' && track.busy ? ' animate-pulse' : ''}`}
            data-bot-track-step={TRACK_STEPS[index]}
            data-state={look}
          />
        ))}
      </div>
      {labels ? (
        <div className="grid grid-cols-5 gap-[3px] text-[11px] leading-4 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          {TRACK_STEPS.map((step, index) => (
            <span key={step} className={`truncate ${looks[index] === 'now' ? 'font-semibold text-zinc-900 dark:text-zinc-100' : ''}`}>{stepName(step)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Pictures ──

interface ShotPair { before: string; after: string; width: number; height: number }

/** Pure: the first verified screen's before and after pictures from a change's shots view, or null. */
export function shotPairOf(view: unknown): ShotPair | null {
  const shots = (view && typeof view === 'object' ? (view as { shots?: unknown }).shots : null) as {
    state?: string; artifacts?: Array<{ side?: string; variant?: string; viewport?: string; url?: string; width?: number; height?: number; media?: string }>;
  } | null;
  if (!shots || shots.state !== 'verified' || !Array.isArray(shots.artifacts)) return null;
  const images = shots.artifacts.filter((a) => a && a.media === 'png' && typeof a.url === 'string' && /^\/api\//.test(a.url));
  for (const variant of ['focus', 'context']) {
    const viewport = images.find((a) => a.variant === variant)?.viewport;
    if (!viewport) continue;
    const of = (side: string) => images.find((a) => a.variant === variant && a.viewport === viewport && a.side === side);
    const before = of('base');
    const after = of('head');
    if (before?.url && after?.url) {
      return { before: before.url, after: after.url, width: Number(after.width) || 4, height: Number(after.height) || 3 };
    }
  }
  return null;
}

/**
 * A plan screen drawn small: its sandboxed frame scaled to the box, cropped
 * to what changes. Also a complicated change's plan card's (./bot-plan-spec.tsx).
 */
export function DrawnSide({ screen, side, label }: { screen: SpecScreen; side: 'before' | 'after'; label: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const fit = () => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  const [x, y, w] = screen.focus || [0, 0, screen.width];
  const scale = width ? width / w : 0;
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900" style={{ aspectRatio: PICTURE_RATIO }} role="img" aria-label={label}>
      {scale ? (
        <iframe
          sandbox=""
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          title={label}
          srcDoc={side === 'before' ? screen.before : screen.after}
          className="pointer-events-none absolute start-0 top-0 origin-top-left border-0"
          style={{ width: screen.width, height: screen.height, transform: `scale(${scale}) translate(${-x}px, ${-y}px)` }}
        />
      ) : null}
    </div>
  );
}

/**
 * Every picture's frame, whatever the shot's own size (polish board #12): the
 * frame is drawn while the pictures are still being read, and a request's
 * page grew by 200px when they arrived at the shot's own proportions. A shot
 * fills it from its top, a plan's screen from its focus.
 */
const PICTURE_RATIO = '4 / 3';

function PictureSide({ src, label }: { src: string; label: string }) {
  return (
    <span className="block w-full overflow-hidden rounded-lg bg-zinc-100 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800" style={{ aspectRatio: PICTURE_RATIO }}>
      <img src={src} alt={label} loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
    </span>
  );
}

/** A frame waiting for its picture: the same box, empty. */
export function PendingSide() {
  return (
    <span className="block w-full overflow-hidden rounded-lg bg-zinc-100 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800" style={{ aspectRatio: PICTURE_RATIO }} />
  );
}

/**
 * A request's pictures, under its card: its change's before and after
 * shots once they are verified, else the first screen its plan drew, before
 * and after. Read once, in an effect, only where a card asks for them (a
 * thread's card and a request's page, never a list).
 */
export function TrackPictures({ track }: { track: BotTrack }) {
  const t = useMessages('messages');
  const [shots, setShots] = useState<ShotPair | null>(null);
  const [planHtml, setPlanHtml] = useState<string | null>(null);
  const slug = track.appSlug;
  const proposal = track.proposalId;
  const session = track.sessionId;
  // Something to read: the frames hold the pictures' place until it answers.
  const asks = !!((slug && proposal) || session);
  const [reading, setReading] = useState(asks);
  useEffect(() => {
    let live = true;
    setShots(null); setPlanHtml(null); setReading(asks);
    const read = async () => {
      if (slug && proposal) {
        try {
          const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/proposals/${proposal}/shots`, { credentials: 'same-origin' });
          if (res.ok) {
            const pair = shotPairOf(await res.json());
            if (pair) { if (live) setShots(pair); return; }
          }
        } catch { /* the plan's screens, then */ }
      }
      if (session) {
        try {
          const res = await fetch(`/api/sessions/${session}/spec`, { credentials: 'same-origin' });
          if (res.ok) {
            const body = await res.json() as { html?: unknown };
            if (live && typeof body.html === 'string') setPlanHtml(body.html);
          }
        } catch { /* nothing to show */ }
      }
    };
    void read().finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [slug, proposal, session]); // eslint-disable-line react-hooks/exhaustive-deps
  const screen = useMemo(() => (planHtml ? firstSpecScreen(planHtml) : null), [planHtml]);
  const pending = !shots && !screen && reading;
  if (!shots && !screen && !pending) return null;
  const before = t('messages:bot.track.pictures.before');
  const after = t('messages:bot.track.pictures.after');
  return (
    <figure className="m-0 flex flex-col gap-1.5" data-bot-track-pictures={shots ? 'change' : pending ? 'pending' : 'plan'} aria-busy={pending || undefined}>
      <figcaption className="text-[12px] font-semibold text-zinc-500 dark:text-zinc-400">
        {pending ? '\u00a0' : t(shots ? 'messages:bot.track.pictures.change' : 'messages:bot.track.pictures.plan')}
      </figcaption>
      <div className="grid grid-cols-2 gap-2">
        {[{ side: 'before' as const, label: before }, { side: 'after' as const, label: after }].map(({ side, label }) => (
          <div key={side} className="flex min-w-0 flex-col gap-1">
            {shots
              ? <PictureSide src={side === 'before' ? shots.before : shots.after} label={label} />
              : screen ? <DrawnSide screen={screen} side={side} label={label} /> : <PendingSide />}
            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// ── The card ──

/** The time now, moving every half minute while `active`. */
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface TrackCardProps {
  track: BotTrack;
  /** What leads the card: the person's own words, else the request's title. */
  title: string;
  /** The project's name, said beside where it is when it is not the title's. */
  project?: string | null;
  /** Its links: the plan, the change, the request, the bot's slots. */
  links?: ReactNode[];
  /** Its pictures, for the cards that show them. */
  pictures?: boolean;
  /** For a test: the moment its clock counts to. */
  now?: Date;
}

/**
 * A request's card: its status word and try, its title, where it is and why
 * with this try's clock, the five-step bar, its links, and its pictures.
 * The card in a request's thread (the only place there that says where it
 * is), and the same card on the request's page.
 */
export function TrackCard({ track, title, project = null, links = [], pictures = false, now }: TrackCardProps) {
  const t = useMessages('messages');
  const ticking = useNow(!now && ticks(track));
  const at = now || ticking;
  const clock = trackClock(track, at);
  const place = trackPlace(track);
  const facts = [project, trackDetail(track), place, clock].filter(Boolean).join(' · ');
  const ended = ENDED_STAGES.has(track.work.stage);
  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={t('messages:bot.track.name', { title })}
      data-bot-track={track.work.stage}
      data-bot-track-why={track.work.why || track.work.reason || track.work.line?.code || undefined}
      data-bot-activity={ended ? 'done' : 'working'}
      data-bot-activity-request={track.appSlug && track.issueNumber && !track.firstVersion ? `${track.appSlug}#${track.issueNumber}` : undefined}
    >
      <div className="flex items-start gap-3">
        <TrackBadge track={track} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400" data-bot-activity-eyebrow="">{trackEyebrow(track)}</div>
          <div className="line-clamp-2 text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
          <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-activity-status="" role="status">{facts}</p>
        </div>
      </div>
      <TrackBar track={track} labels />
      {pictures ? <TrackPictures track={track} /> : null}
      {links.length ? <div className="flex flex-wrap gap-2">{links}</div> : null}
    </div>
  );
}

/**
 * The links a request's card offers: its change, its request (not on the
 * request's own page), and the bot's slots when it waits for one.
 */
export function trackLinks(track: BotTrack, { request = true }: { request?: boolean } = {}): ReactNode[] {
  const out: ReactNode[] = [];
  if (track.links?.proposal) out.push(<ActivityLink key="change" href={track.links.proposal}>{translate('messages:bot.track.link.change')}</ActivityLink>);
  if (request && track.links?.request && track.issueNumber) {
    out.push(<ActivityLink key="request" href={track.links.request}>{translate('messages:bot.track.link.request', { number: String(track.issueNumber) })}</ActivityLink>);
  }
  if (track.appSlug && (track.held?.limit === 'slots' || track.held?.limit === 'builds')) {
    const slug = track.appSlug;
    out.push(
      <a
        key="slots"
        href={slotsHref(slug)}
        className={SLOTS_LINK}
        data-bot-track-slots={slug}
        onClick={(event) => { event.preventDefault(); openSlots(slug); }}
      >
        {translate('messages:bot.track.link.slots')}
      </a>,
    );
  }
  return out;
}

// The same pill as the card's other links (./bot-activity.tsx ActivityLink).
const SLOTS_LINK = buttonVariants({ layout: 'iconRow', variant: 'pillOnCard', size: 'sm', ink: 'neutral' });

/** A project's page, where its bot slots page hangs: the Workshop. */
export function slotsHref(slug: string): string {
  return `#app/${encodeURIComponent(slug)}/workshop`;
}

/**
 * Open a project's bot slots page, a page under its Workshop, the way every
 * door to a place goes (../dev-board/workshop/place-store.ts openPlace):
 * AppView switches a page that is up in place, and the project's address
 * opens one that is not on that page.
 */
export function openSlots(slug: string): void {
  const w = window as unknown as {
    AppView?: { _landOnTab?: (slug: string, tab: string) => void };
    App?: { _hubHref?: (slug: string) => string };
  };
  try { w.AppView?._landOnTab?.(slug, 'bot'); } catch { /* the page opens on what it remembers */ }
  let href = '';
  try { href = w.App?._hubHref?.(slug) || ''; } catch { href = ''; }
  const to = href || slotsHref(slug);
  window.location.hash = to.startsWith('#') ? to.slice(1) : to;
}

/**
 * A bot activity message in the chat: the card of its request's track when
 * the viewer's bot work has one for it and this is that request's card,
 * else the activity card as it was (./bot-activity.tsx).
 */
export function BotCardOrTrack({ message, words = null }: { message: ConversationMessage; words?: ReactNode }) {
  useMessages('messages');
  const meta = message.metadata?.homeroomBot || null;
  const track = useTrackOf(meta ? { appSlug: meta.appSlug, appName: meta.appName, issueNumber: meta.issueNumber, firstVersion: meta.firstVersion === true } : null);
  if (!meta || !track || (track.rootId && track.rootId !== message.id)) return <BotActivityCard message={message} words={words} />;
  const title = meta.askedText
    ? translate('messages:bot.activity.youAsked', { request: meta.askedText })
    : track.title || track.appName;
  return (
    <TrackCard
      track={track}
      title={title}
      project={meta.askedText ? (meta.appName || meta.appSlug || null) : null}
      links={trackLinks(track)}
      pictures
    />
  );
}
