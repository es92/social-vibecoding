import type { ReactNode } from 'react';

import {
  ArrowPathIcon, ChatIcon, CheckIcon, ClockIcon, EllipsisHorizontalIcon, EyeIcon, InfoCircleIcon,
  ListLinesIcon, NoSymbolIcon, PencilSquareIcon, PlayIcon, SpinnerArcIcon, UserIcon, WarningTriangleIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useResolvedCommunityColor } from '../../lib/community-color';
import { requestHue, requestKey } from './bot-request';
import { ENDED_STAGES, trackLine, trackShort, trackStateWord } from './bot-track';
import type { BotTrack, HomeroomBotWork } from './types';

/*
 * The pieces a request's line in the chat with Homeroom bot is drawn with
 * (./bot-news-line.tsx), and the Messages list's line for the bot's chat
 * (./index.tsx): a project's tile, a request's number in its colour, how a
 * request ended, and where each of the viewer's requests stands now, read
 * from their tracks (./bot-work.tsx: each request's stored work state,
 * services/work-state.js).
 *
 * 5 Nov 2026 (docs/plans/bot-one-model.md): the activity drawer this module
 * drew under the bot chat's header is gone. The chat lives on the Homeroom
 * bot tab, whose list is where each request stands (features/ai/), and Main
 * Chat holds only the conversation.
 */

export type StripGroup = 'needs' | 'ready' | 'progress' | 'done';

/** One request, where it stands now. */
export interface StripRow {
  key: string;
  group: StripGroup;
  /** What its line says under the title. */
  state: string;
  track: BotTrack;
}

export interface StripModel {
  needs: StripRow[];
  ready: StripRow[];
  progress: StripRow[];
  done: StripRow[];
}

/**
 * Pure: midnight of `now`'s local day, where "today" starts. #5392: what
 * "Finished today" counts is what ended since then, on the viewer's own
 * device, which is also where the chat starts its "Today" divider.
 */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Pure: how a track ended, in the endings the chat's small squares draw
 * (ENDINGS below), or null for one that has not ended.
 */
export function trackEnding(track: Pick<BotTrack, 'work' | 'doneBy'>): string | null {
  const { stage, reason } = track.work;
  if (stage === 'live') return 'live';
  if (stage === 'going_live') return 'going_live';
  if (stage === 'closed') return track.doneBy ? 'done_elsewhere' : 'closed';
  if (stage === 'stopped') return reason === 'build_failed' ? 'build_failed' : reason === 'look_failed' ? 'failed' : 'stopped';
  return null;
}

/**
 * Pure (17 Oct 2026): each request once, by its stage. Needs you is what
 * waits on the person (its stage waits for them, or stopped); Ready to try,
 * a change up for a vote; In progress, everything under way, a hold among
 * it; what ended today, since midnight, Finished today.
 */
export function stripGroups(work: HomeroomBotWork | null, now: Date = new Date()): StripModel {
  const model: StripModel = { needs: [], ready: [], progress: [], done: [] };
  const seen = new Set<string>();
  for (const track of work?.tracks || []) {
    if (seen.has(track.key)) continue;
    seen.add(track.key);
    const row = (group: StripGroup, state: string): StripRow => ({ key: track.key, group, state, track });
    const { stage } = track.work;
    const held = track.held && (track.held.limit === 'builds' || track.held.limit === 'slots');
    if (stage === 'waiting_for_you' || stage === 'stopped') model.needs.push(row('needs', trackLine(track)));
    else if (stage === 'up_for_vote') model.ready.push(row('ready', trackStateWord(track)));
    else if (held) model.progress.push(row('progress', [trackStateWord(track), trackShort(track)].join(' · ')));
    else if (ENDED_STAGES.has(stage)) {
      const at = Date.parse(track.since || '');
      if (!Number.isFinite(at) || at < startOfDay(now).getTime()) continue;
      model.done.push(row('done', endedWords(trackEnding(track), track, trackLine(track))));
    } else model.progress.push(row('progress', trackLine(track)));
  }
  return model;
}

/**
 * Each request by its key (./bot-request.ts), with the group it is in and
 * what its line says: where it stands NOW, for the chat's news rows. Read
 * once per read of the tracks.
 */
const NOW_CACHE = new WeakMap<HomeroomBotWork, Map<string, StripRow>>();
export function trayNow(work: HomeroomBotWork | null): Map<string, StripRow> | null {
  if (!work) return null;
  const cached = NOW_CACHE.get(work);
  if (cached) return cached;
  const model = stripGroups(work);
  const map = new Map<string, StripRow>();
  for (const row of [...model.needs, ...model.ready, ...model.progress, ...model.done]) {
    const key = requestKey(row.track);
    if (key && !map.has(key)) map.set(key, row);
  }
  NOW_CACHE.set(work, map);
  return map;
}

/** Each request by its key, with how it ended, at any age: what the chat's settled rows say. */
const ENDED_CACHE = new WeakMap<HomeroomBotWork, Map<string, string>>();
export function trayEnded(work: HomeroomBotWork | null): Map<string, string> | null {
  if (!work) return null;
  const cached = ENDED_CACHE.get(work);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (const track of work.tracks || []) {
    const key = requestKey(track);
    const ending = trackEnding(track);
    if (key && ending && !map.has(key)) map.set(key, ending);
  }
  ENDED_CACHE.set(work, map);
  return map;
}

/** Pure: a model's counts in words, zeros left out ("1 needs you · 2 in progress"). */
export function summaryParts(model: StripModel): Array<{ group: StripGroup; text: string }> {
  const parts: Array<{ group: StripGroup; text: string }> = [];
  if (model.needs.length) parts.push({ group: 'needs', text: translate('messages:bot.strip.summary.needs', { count: model.needs.length }) });
  if (model.ready.length) parts.push({ group: 'ready', text: translate('messages:bot.strip.summary.ready', { count: model.ready.length }) });
  if (model.progress.length) parts.push({ group: 'progress', text: translate('messages:bot.strip.summary.progress', { count: model.progress.length }) });
  if (model.done.length) parts.push({ group: 'done', text: translate('messages:bot.strip.summary.done', { count: model.done.length }) });
  return parts;
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

/** A request's number, "#18", in its own colour: the same in the chat and its thread. */
export function RequestTag({ number, size = 'row' }: { number: number | null | undefined; size?: 'row' | 'line' | 'head' }) {
  if (!number || number <= 0) return null;
  const text = size === 'head' ? 'text-[13px] leading-5' : 'text-[12px] leading-[18px]';
  return (
    <span className={`${TAG} ${text}`} style={{ ['--req-h' as string]: String(requestHue(number)) }} data-request-tag={number}>
      {`#${number}`}
    </span>
  );
}

// ── How a request ended ──

type EndingTone = 'good' | 'ended' | 'trouble';
type BadgeTone = EndingTone | 'need' | 'ready' | 'working' | 'held';
type Glyph = (props: { className?: string; strokeWidth?: string; 'aria-hidden'?: 'true' }) => ReactNode;
interface Ending { key: string; tone: EndingTone; icon: Glyph; stroke?: string }

/**
 * A settled request's ending, by what its last run came to (the activity
 * cards' tones, ./bot-activity.tsx): made it in (a green check), ended
 * without a change (grey), or went wrong (red). `person` is the bot stepping
 * back (homeroom-bot.js handOff): a call for a person to make, a change it
 * may revise no further, failures it cannot fix safely; a person.
 * Endings that still wait on somebody are never settled, so they are not here.
 */
const ENDINGS: Record<string, Ending> = {
  live: { key: 'messages:bot.final.live', tone: 'good', icon: CheckIcon },
  going_live: { key: 'messages:bot.final.goingLive', tone: 'good', icon: CheckIcon },
  done_elsewhere: { key: 'messages:bot.final.doneElsewhere', tone: 'good', icon: CheckIcon },
  closed: { key: 'messages:bot.final.closed', tone: 'ended', icon: XIcon },
  person: { key: 'messages:bot.final.person', tone: 'ended', icon: UserIcon, stroke: '1.75' },
  held: { key: 'messages:bot.final.held', tone: 'ended', icon: ClockIcon },
  stopped: { key: 'messages:bot.final.stopped', tone: 'ended', icon: NoSymbolIcon },
  build_failed: { key: 'messages:bot.final.failed', tone: 'trouble', icon: WarningTriangleIcon },
  failed: { key: 'messages:bot.final.failed', tone: 'trouble', icon: WarningTriangleIcon },
};

/**
 * Pure: how a request ended, in words, beside its small mark on a Finished
 * today row: the ending's own word ("Live", "Closed"), and for a build that
 * went wrong the reason with it ("Couldn’t build · Its build didn't
 * finish"), the dot joining two whole sentences so each can be translated
 * on its own. No record of how it ended: `fallback`, the words the row last
 * said.
 */
export function endedWords(outcome: string | null | undefined, track: BotTrack | null, fallback: string): string {
  const ending = outcome ? ENDINGS[outcome] : undefined;
  if (!ending) return fallback;
  const word = translate(ending.key);
  return ending.tone === 'trouble' && track ? `${word} · ${trackLine(track)}` : word;
}
// A tile like the project's: the same small square family. What is still
// open is tinted (amber while it waits on the person, blue while it is ready
// to try); what is settled is grey, with only its glyph in colour, so it is
// never louder than what is open and never reads as a request's number,
// whose eight hues include a green and a red (./bot-request.ts).
const BADGE_TINT: Record<BadgeTone, string> = {
  good: 'bg-zinc-200/80 text-emerald-600 dark:bg-zinc-700/70 dark:text-emerald-400',
  ended: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  trouble: 'bg-zinc-200/80 text-red-600 dark:bg-zinc-700/70 dark:text-red-400',
  need: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  ready: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
  working: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  held: 'bg-zinc-200/80 text-amber-600 dark:bg-zinc-700/70 dark:text-amber-400',
};

/** Where a request stands, as a small square: its glyph on its tone's tint. */
function StatusBadge({ tone, icon: Icon, stroke = '2.5', words = null, spin = false, data }: {
  tone: BadgeTone; icon: Glyph; stroke?: string; words?: string | null; spin?: boolean; data: string;
}) {
  return (
    <span
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${BADGE_TINT[tone]}`}
      title={words || undefined}
      aria-hidden={words ? undefined : 'true'}
      data-bot-badge={data}
    >
      <Icon aria-hidden="true" className={`h-3.5 w-3.5${spin ? ' animate-spin [animation-duration:2.4s]' : ''}`} strokeWidth={stroke} />
      {words ? <span className="sr-only">{words}</span> : null}
    </span>
  );
}

/**
 * How a request ended, as a small square after its project's tile, named
 * for a screen reader and on hover. An ending its track has no record of is a
 * plain grey square named by the words it last said.
 */
export function FinalState({ outcome, fallback }: { outcome: string | null | undefined; fallback: string }) {
  const t = useMessages('messages');
  const ending = outcome ? ENDINGS[outcome] : undefined;
  return (
    <span className="contents" data-bot-final={outcome || ''}>
      <StatusBadge
        tone={ending?.tone || 'ended'} icon={ending?.icon || EllipsisHorizontalIcon} stroke={ending?.stroke}
        words={ending ? t(ending.key) : fallback} data={outcome || 'unknown'}
      />
    </span>
  );
}

/** What an open request waits on, by why it waits: the glyph of what to do. */
const NEED_GLYPHS: Record<string, { icon: Glyph; stroke?: string }> = {
  question: { icon: ChatIcon, stroke: '2' },
  plan: { icon: ListLinesIcon },
  decide: { icon: UserIcon, stroke: '1.75' },
  needs_detail: { icon: PencilSquareIcon, stroke: '2' },
  already_works: { icon: CheckIcon, stroke: '2' },
  stopped: { icon: ArrowPathIcon, stroke: '2' },
  checks: { icon: EyeIcon, stroke: '2' },
};

/**
 * Where an open request stands, as the same small square its ending will be:
 * amber with what to do while it waits on the person (a bubble to answer, a
 * pencil to add detail, a person to decide, a loop to try again), blue
 * with a play mark while it is up for a vote, grey and turning while the
 * bot works on it. Decorative: the row's second line says it in words.
 */
export function OpenState({ row }: { row: StripRow }) {
  const { work } = row.track;
  if (row.group === 'needs') {
    const which = work.stage === 'stopped' ? (work.reason === 'fix_stopped' ? 'checks' : 'stopped') : work.why || 'question';
    const glyph = NEED_GLYPHS[which] || { icon: InfoCircleIcon, stroke: '2' };
    return <StatusBadge tone="need" icon={glyph.icon} stroke={glyph.stroke} data="needs" />;
  }
  if (row.group === 'ready') return <StatusBadge tone="ready" icon={PlayIcon} stroke="2" data="ready" />;
  // Work a limit holds back is still under way, never finished: a clock,
  // waiting, never turning.
  if (row.track.held) return <StatusBadge tone="held" icon={ClockIcon} data="progress" />;
  // Turning only while the bot works on it this minute.
  const spin = !!row.track.busy;
  return <StatusBadge tone="working" icon={SpinnerArcIcon} spin={spin} data="progress" />;
}

/**
 * A settled request on one line, in the chat: the
 * project's small tile at the end of the big tile's column, so it sits as
 * close to its badge as a big tile does, then how it ended, its number and
 * its title. Only what is still open gets two lines and a full tile.
 */
export function SettledLine({ name, slug, iconUrl, emoji, number, title, outcome, fallback, words = null, nested = false }: {
  name: string; slug: string | null; iconUrl: string | null; emoji: string | null;
  number: number | null | undefined; title: string; outcome: string | null | undefined; fallback: string;
  /** #5392: how it ended, in words after the title, where the mark alone does not say it. */
  words?: string | null;
  /** Inside an opened run (./bot-news-line.tsx SettledRun): no big tile's column to keep. */
  nested?: boolean;
}) {
  return (
    <>
      <span className={nested ? 'flex shrink-0' : 'flex w-9 shrink-0 justify-end'}>
        <ProjectTile name={name} slug={slug} iconUrl={iconUrl} emoji={emoji} size="line" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <FinalState outcome={outcome} fallback={fallback} />
        <RequestTag number={number} size="line" />
        {/* Polish N15: the title is the flexible part, so it has the room
            ("Fix scr…" had 58px beside a 149px status) and a short one
            still puts its status at the row's end, as the others are; the
            status takes at most 40% and gives way first. */}
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-zinc-700 dark:text-zinc-300">{title}</span>
        {words ? <span className="min-w-0 max-w-[40%] truncate text-end text-[13px] leading-5 text-zinc-500 dark:text-zinc-400" data-bot-settled-words="">{words}</span> : null}
      </span>
    </>
  );
}

