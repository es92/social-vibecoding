import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { ChatIcon, CheckIcon, ClockIcon, InfoCircleIcon, WarningTriangleIcon } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Skeleton } from '@/components/ui/skeleton';
import {
  cardRecord, ensureBotActivity, loadBotActivity, readsAsked, useBotActivity, useBotActivitySync,
} from './bot-activity-store';
import { jobTitle } from './bot-shared';
import { recordObjectOrigin } from './format';
import type { ConversationMessage, HomeroomBotActivity, HomeroomBotActivityOutcome, HomeroomBotMeta } from './types';

/*
 * #3736: activity cards in the Homeroom bot's DM.
 *
 * Like a live activity on a phone. When the bot starts a piece of work for
 * the viewer, it sends ONE message (metadata kind `activity`) at that point
 * in the conversation, and the row draws that message as a card that
 * follows the work in place: the step it is at of the request's steps, what
 * it is doing, how long it has taken, and where to open it, until it ends
 * (a proposal up for a vote, a question asked, a build that did not
 * finish...). The viewer can go on writing below it. The activity tray
 * pinned above the transcript (./bot-work.tsx) stays what it is: everything
 * at once, and the history.
 *
 * WHAT A CARD SAYS is read, never pushed: the server reads every card of the
 * viewer's from the bot's records in one go (services/homeroom-bot-
 * activity.js), and ./bot-activity-store.ts keeps that one read for every
 * card in the transcript, reading again on the bot's news, on the loop's
 * `homeroom_bot_work_changed`, and now and then while a card is going.
 *
 * OWNERSHIP. Every node here is React's, inside the message row React owns;
 * nothing outside writes into it. The sync component renders nothing.
 */

/** The elapsed time on a card that is going moves this often. */
const TICK_MS = 30 * 1000;

/**
 * Keeps the cards in the bot's DM current (./bot-activity-store.ts).
 * Mounted beside the activity tray, in that DM only; `newsKey` is the
 * newest message the bot sent there. Renders nothing.
 */
export function BotActivitySync({ conversationId, newsKey }: { conversationId: number; newsKey: number | null }) {
  useBotActivitySync(conversationId, newsKey);
  return null;
}

// ── Words ──

/** What each ending says, under the card's title. */
export const ACTIVITY_OUTCOME_LABELS: Record<HomeroomBotActivityOutcome, string> = {
  question: 'Asked you a question',
  proposed: 'Built it. Waiting for approval',
  live: 'Built it. It’s live',
  closed: 'Built it. The change was closed',
  blocked: 'Can’t build it as it’s written',
  build_failed: 'Couldn’t finish building it',
  person: 'Left it for the group to decide',
  empty: 'Found nothing to build yet',
  failed: 'Couldn’t finish looking at it',
  held: 'Ready, but held back for now',
  stopped: 'Stopped before it finished',
  answer: 'Answered on the change',
  revise: 'Updated the change',
};

export type ActivityTone = 'done' | 'you' | 'ended' | 'trouble';
type Tone = ActivityTone;

/** How each ending reads at a glance: finished well, waiting on the viewer, ended, or went wrong. */
export const ACTIVITY_OUTCOME_TONES: Record<HomeroomBotActivityOutcome, Tone> = {
  proposed: 'done', live: 'done', answer: 'done', revise: 'done',
  question: 'you', blocked: 'you', empty: 'you',
  person: 'ended', held: 'ended', closed: 'ended',
  build_failed: 'trouble', failed: 'trouble', stopped: 'trouble',
};

export const TONE_WORDS: Record<Tone, string> = {
  done: 'Done',
  you: 'Needs you',
  ended: 'Ended',
  trouble: 'Didn’t finish',
};

// The tile in the ring's place once the work ended: the ring's 38px, round.
// The brand tint and ink follow the theme by themselves, so they replace the
// neutral tile's dark pair too. Complete literals only: Tailwind's extractor
// reads source text.
const TONE_TILES: Record<Tone, string> = {
  done: 'h-[38px] w-[38px] rounded-full bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] dark:bg-[color:var(--brand-tint)] dark:text-[color:var(--brand-ink)]',
  you: 'h-[38px] w-[38px] rounded-full bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] dark:bg-[color:var(--brand-tint)] dark:text-[color:var(--brand-ink)]',
  ended: 'h-[38px] w-[38px] rounded-full',
  trouble: 'h-[38px] w-[38px] rounded-full bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400',
};
const PLAIN_TILE = 'h-[38px] w-[38px] rounded-full';

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === 'done') return <CheckIcon aria-hidden="true" />;
  if (tone === 'you') return <ChatIcon aria-hidden="true" />;
  if (tone === 'trouble') return <WarningTriangleIcon aria-hidden="true" />;
  return <InfoCircleIcon aria-hidden="true" />;
}

function capitalized(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "4m", "1h 5m", "2d 3h": a span of time, compactly. Null for none. */
export function spanText(fromIso: string | null, to: Date): string | null {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from)) return null;
  const minutes = Math.max(0, Math.floor((to.getTime() - from) / 60000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The card's title, as the tray names the same work: "Ear Trainer #12: Sort by date". */
export function activityTitle(meta: HomeroomBotMeta): string {
  return jobTitle({
    appName: meta.appName || meta.appSlug || 'A project',
    issueNumber: meta.issueNumber || null,
    title: meta.issueTitle || null,
    firstVersion: !!meta.firstVersion,
  });
}

/** Whether a message is one the bot drew as an activity card. */
export function isActivityMessage(message: ConversationMessage): boolean {
  return !!message.sender.bot && message.metadata?.homeroomBot?.kind === 'activity' && !message.deleted;
}

// ── The view ──

const LINK_CLASS = buttonVariants({ layout: 'iconRow', variant: 'pillNeutral', size: 'sm', ink: 'neutral' });

/**
 * A card's way out: a pill link to the platform's own page. Also the
 * activity tray's (./bot-work.tsx), whose tiles are this card's language;
 * `data` names which surface drew it.
 */
export function ActivityLink({ href, children, data = 'bot-activity' }: { href: string; children: string; data?: 'bot-activity' | 'bot-work' }) {
  return (
    <a
      href={href}
      className={LINK_CLASS}
      data-bot-activity-link={data === 'bot-activity' ? '' : undefined}
      data-bot-work-link={data === 'bot-work' ? '' : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => recordObjectOrigin(event, href)}
    >
      {children}
    </a>
  );
}

const CardLink = ActivityLink;

/**
 * The round thing a card leads with: the ring with its step while the work
 * goes, a clock while it goes without one, then the tile of how it ended.
 * The activity tray's tiles lead with the same.
 */
export function ActivityLead({ step, of, stepName, tone }: { step?: number | null; of?: number | null; stepName?: string | null; tone?: Tone | null }) {
  if (!tone && step && of) {
    return (
      <ProgressRing
        pct={Math.round((step / of) * 100)}
        label={`${step}/${of}`}
        title={`Step ${step} of ${of}${stepName ? `: ${stepName}` : ''}`}
      />
    );
  }
  if (tone) return <IconTile size="xs" className={TONE_TILES[tone]}><ToneIcon tone={tone} /></IconTile>;
  return <IconTile size="xs" className={PLAIN_TILE}><ClockIcon aria-hidden="true" /></IconTile>;
}

export interface BotActivityCardViewProps {
  /** The card's message's own words about the work: which request. */
  meta: HomeroomBotMeta;
  /** Its state, or null until a read says. */
  card: HomeroomBotActivity | null;
  loaded?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  /** For a test: the moment elapsed time is counted to. */
  now?: Date;
}

/** One card, from what was read: a pure render, so a test can draw every state. */
export function BotActivityCardView({ meta, card, loaded = false, failed = false, onRetry, now }: BotActivityCardViewProps) {
  const at = now || new Date();
  const title = activityTitle(meta);
  // B4: their own words lead, and the project moves to the status line.
  const asked = meta.askedText ? `You asked: ${meta.askedText}` : null;
  const project = asked ? (meta.appName || meta.appSlug || null) : null;
  const working = card?.state === 'working';
  const tone: Tone | null = card && card.state === 'done' && card.outcome ? ACTIVITY_OUTCOME_TONES[card.outcome] : null;

  let lead: ReactNode;
  let eyebrow: string;
  let status: ReactNode;
  if (card && working) {
    const stepped = card.step && card.of;
    lead = <ActivityLead step={card.step} of={card.of} stepName={card.stepName} />;
    eyebrow = stepped ? `Step ${card.step} of ${card.of}${card.stepName ? ` · ${card.stepName}` : ''}` : 'Working on it';
    const elapsed = spanText(card.startedAt, at);
    status = (
      <>
        {project ? <span>{`${project} · `}</span> : null}
        <span role="status">{capitalized(card.doing || 'working on it')}</span>
        {elapsed ? <span>{` · ${elapsed} so far`}</span> : null}
      </>
    );
  } else if (card && tone && card.outcome) {
    lead = <ActivityLead tone={tone} />;
    eyebrow = TONE_WORDS[tone];
    const took = card.endedAt ? spanText(card.startedAt, new Date(card.endedAt)) : null;
    status = (
      <>
        {project ? <span>{`${project} · `}</span> : null}
        <span role="status">{ACTIVITY_OUTCOME_LABELS[card.outcome]}</span>
        {took ? <span>{` · took ${took}`}</span> : null}
      </>
    );
  } else {
    lead = <ActivityLead />;
    eyebrow = 'Activity';
    status = failed ? (
      <span role="alert" className="inline-flex flex-wrap items-center gap-2">
        <span>Couldn’t load how far along this is.</span>
        <Button type="button" variant="pillNeutral" size="xsText" ink="neutral" onClick={onRetry}>Try again</Button>
      </span>
    ) : loaded ? <span>No progress to show for this one.</span> : null;
  }

  const links = card ? [
    card.links.proposal ? <CardLink key="proposal" href={card.links.proposal}>Open change</CardLink> : null,
    card.links.request ? <CardLink key="request" href={card.links.request}>{meta.firstVersion ? 'Open request' : `Request #${meta.issueNumber}`}</CardLink> : null,
  ].filter(Boolean) : [];

  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={`Homeroom bot activity: ${title}`}
      data-bot-activity={card ? card.state : 'pending'}
      {...(card?.outcome ? { 'data-bot-activity-outcome': card.outcome } : {})}
    >
      <div className="flex items-center gap-3">
        {lead}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {working ? (
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[color:var(--accent)] opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent)]" />
              </span>
            ) : null}
            <span className="truncate" data-bot-activity-eyebrow="">{eyebrow}</span>
          </div>
          {asked ? (
            <div className="line-clamp-2 text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100" data-bot-activity-asked="">{asked}</div>
          ) : (
            <div className="truncate text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
          )}
          {status ? (
            <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-activity-status="">{status}</p>
          ) : (
            <Skeleton shape="muted" className="mt-1.5 w-1/2" aria-hidden="true" />
          )}
        </div>
      </div>
      {links.length ? <div className="flex flex-wrap gap-2">{links}</div> : null}
    </div>
  );
}

/** The time now, moving on every TICK_MS while `active`. */
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * A message the bot drew as an activity card (see isActivityMessage), kept
 * current by BotActivitySync. `words` is the message's own text, as the row
 * draws any message's: a card the reads have nothing on keeps it instead
 * (#3770), which is what an older card is, past the newest the server
 * answers for. Until a read that knew of the card lands, it is the card,
 * waiting for its state, so neither the first read nor a new card's flashes
 * the words.
 */
export function BotActivityCard({ message, words = null }: { message: ConversationMessage; words?: ReactNode }) {
  const snap = useBotActivity();
  // How many reads had been asked for when this card was drawn: one asked
  // for after that knew of it (cardRecord).
  const [drawnAt] = useState(readsAsked);
  const known = cardRecord(snap, message.id, drawnAt);
  const card = snap.cards.get(message.id) || null;
  const now = useNow(card?.state === 'working');
  useEffect(() => { ensureBotActivity(); }, []);
  // Drawn after the last read was asked for and newer than all it answered:
  // ask once more, unless something already has, so the card learns whether
  // it has a state at all.
  useEffect(() => {
    if (known === 'pending' && snap.loaded && readsAsked() === drawnAt) void loadBotActivity();
  }, [known, snap.loaded, drawnAt]);
  const meta = message.metadata?.homeroomBot;
  if (!meta) return null;
  if (known === 'none' && words) return <>{words}</>;
  return (
    <BotActivityCardView
      meta={meta}
      card={card}
      loaded={known === 'none'}
      failed={known === 'failed'}
      onRetry={() => { void loadBotActivity(); }}
      now={now}
    />
  );
}
