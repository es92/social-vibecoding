/**
 * Recent activity: Home's card in `#home-aside` (./index.tsx), a row of its
 * own under Pinned apps.
 *
 * It was the Needs you card (#6816), then Recent threads (#6785), the eight
 * threads the viewer last took part in. On a phone that was 530px of titles
 * cut at thirty characters, the same icon on every row for somebody who
 * works mostly in one project, and a flatter copy of what the Homeroom bot
 * tab already lists. 24 Nov 2026 (Homeroom mobile polish, 03): it is a
 * sideways row of cards, ONE PER PROJECT, each saying in a few words what is
 * going on there, and a card opens the tab narrowed to that project:
 *
 *   RECENT ACTIVITY                                   See all ›
 *   ┌──────────────┐ ┌──────────────┐ ┌────
 *   │ [icon]     › │ │ [icon]     › │ │ [ic
 *   │ Homeroom     │ │ Run Club     │ │ Bir
 *   │ 21 need you  │ │ 2 in progress│ │ 1 w
 *   │ 3 in progress│ │              │ │
 *   │ 24m ago      │ │ 3h ago       │ │ 2d
 *   └──────────────┘ └──────────────┘ └────
 *
 * THE NUMBERS ARE THE TAB'S OWN, from the same code, so Home never says 21
 * while the tab says 20: the tab's two reads (../ai/desk.ts readDesk, kept a
 * short while and shared with every Your work row on screen), its four lists
 * from them (../ai/model.ts needsYou, inProgress, upNext, liveThisWeek), and
 * its own count of each project in them and their order (rankProjects, what
 * the tab's project picker lists). Nothing is counted again here. A card's
 * lines are the bands of the tab narrowed to the project (stateLines): its
 * Needs you, its In progress (what is being worked on and what waits on
 * others, one band), and Done's "this week". When it was last active is
 * the newest moment among that project's rows.
 *
 * A project is on the row when it has anything in any of the four lists,
 * however long ago it last moved (a thing that still needs the viewer is
 * still news). Somebody with nothing in any list sees no section.
 *
 * The file, the exported component and the ids keep the names they had,
 * because the looks' CSS knows the card by `#home-needs-card` (and its
 * heading by `#home-needs-card-btn` and `#home-needs-card-title`); what is
 * on screen is "Recent activity". The notifications sheet's Recent threads
 * list, which this card used to open, stays in the sheet, read from
 * /api/me/recent-threads as before.
 *
 * Nothing in the prerender: the lists are read in an effect, after the card
 * mounts (Home mounts it once the viewer is known), and again each time Home
 * is shown, so Home's first paint never waits on them. Until they land, the
 * number of cards the last visit drew on this device holds the row's place.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';
import { StateTag } from '@/components/ui/state-tag';

import { useMessages } from '../../lib/i18n/react';
import { agoStamp } from '../../lib/timestamp';
import { useVisibility } from '../../lib/visibility-store';
import { readDesk } from '../ai/desk';
import { projectTabAddress } from '../ai/filter-address';
import {
  inProgress, liveThisWeek, needsYou, rankProjects, upNext,
  type AiWork, type NeedItem, type ProjectTally,
} from '../ai/model';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { SectionHeading } from './panels/ui';
import { WipHeadMore, WipSkel } from './wip-kit';

/** One project's card: the tab's own tally of it, and when something of it last moved. */
export interface ActivityCard extends ProjectTally {
  /** The newest moment among the project's rows in the four lists, or null when none has one. */
  at: string | null;
}

/**
 * Pure: the row's cards, in the tab's own order (most that need you first,
 * then in progress, then waiting, then name), from the tab's two reads.
 * `null` when either read failed, as the tab's Your work rows read it
 * (../ai/desk.ts deskOf): no numbers rather than wrong ones.
 */
export function activityCards(needs: NeedItem[] | null, work: AiWork | null, now = Date.now()): ActivityCard[] | null {
  if (!work || !needs) return null;
  const rows = needsYou(needs, work);
  const progress = inProgress(needs, work);
  const waiting = upNext(needs, work);
  const live = liveThisWeek(work, now);
  const newest = new Map<string, { at: string; ms: number }>();
  for (const row of [...rows, ...progress, ...waiting, ...live]) {
    const slug = row.app?.slug;
    const ms = Date.parse(String(row.at || ''));
    if (!slug || !Number.isFinite(ms)) continue;
    const had = newest.get(slug);
    if (!had || ms > had.ms) newest.set(slug, { at: String(row.at), ms });
  }
  return rankProjects(rows, progress, waiting, live).map((p) => ({ ...p, at: newest.get(p.app.slug)?.at ?? null }));
}

/** What a card's lines can say. */
export type StateKey = 'needs' | 'progress' | 'waiting' | 'live';

/** Each line's message: a count, in the plural it takes. */
export const STATE_IDS: Readonly<Record<StateKey, string>> = {
  needs: 'home:needsCard.state.needs',
  progress: 'home:needsCard.state.progress',
  waiting: 'home:needsCard.state.waiting',
  live: 'home:needsCard.state.live',
};

/** How many lines of state a card says. */
export const STATE_LINES = 2;

/**
 * Pure: a card's lines of state, the first two above zero of: what needs
 * the viewer, what is under way, what went live this week. A zero says
 * nothing. Each is a number the tab says of the project once narrowed to
 * it: its Needs you band, its In progress band (and the head's "In
 * progress: N"), and Done's "N this week".
 *
 * The tab's In progress is what is being worked on AND what waits on
 * somebody else, one band since #7083, so the card's second line counts
 * both: a project with 2 being built and 17 waiting says "19 in progress",
 * as the tab it opens does, never "2 in progress" over a band of 19. When
 * none of it is being worked on, the same number says so: "10 waiting on
 * others".
 */
export function stateLines(p: Pick<ProjectTally, StateKey>, max = STATE_LINES): { key: StateKey; count: number }[] {
  const lines: { key: StateKey; count: number }[] = [
    { key: 'needs', count: p.needs },
    { key: p.progress > 0 ? 'progress' : 'waiting', count: p.progress + p.waiting },
    { key: 'live', count: p.live },
  ];
  return lines.filter((line) => line.count > 0).slice(0, max);
}

/** Where the number of cards of the last visit is kept on the device, for the first paint's placeholder. */
export const NEEDS_HINT_KEY = 'homeroom:recent-activity';
/** The key Recent threads kept its count under: removed once this card has written its own. */
const OLD_HINT_KEY = 'homeroom:recent-threads';
export function readNeedsHint(): number {
  try { return Math.max(0, Math.trunc(Number(window.localStorage.getItem(NEEDS_HINT_KEY)) || 0)); } catch { return 0; }
}
export function writeNeedsHint(count: number): void {
  try {
    if (count > 0) window.localStorage.setItem(NEEDS_HINT_KEY, String(count));
    else window.localStorage.removeItem(NEEDS_HINT_KEY);
    window.localStorage.removeItem(OLD_HINT_KEY);
  } catch { /* the next load draws no placeholder */ }
}

/** At most this many placeholder cards hold the row's place: more than any screen shows at once. */
export const HINT_CARDS = 8;

/** The section's heading: every project's work, on the Homeroom bot tab. */
export const SEE_ALL_HREF = '#homeroom-bot';

/** One project's card: its icon and a chevron, its name, up to two lines of state, and when it was last active. One link, to the tab narrowed to the project. */
export function ActivityCardLink({ card }: { card: ActivityCard }): ReactNode {
  const t = useMessages('home');
  const { app } = card;
  const name = app.name || app.slug;
  const { text: when, title: whenTitle } = agoStamp(card.at);
  return (
    <a className="wip-card wip-activity-card" href={projectTabAddress(app.slug)} data-home-activity={app.slug}>
      <span className="wip-activity-top">
        <span
          aria-hidden="true"
          data-icon={appIconKind(app)}
          className="app-icon-tile w-10 h-10 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
        >
          <AppIconContent app={{ name, icon_url: app.icon_url || null, icon_emoji: app.icon_emoji || null }} />
        </span>
        <ChevronRightIcon className="wip-activity-chevron h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" strokeWidth="2.4" aria-hidden="true" />
      </span>
      <span className="wip-activity-words">
        <b className="wip-item-title block truncate text-[15px] font-[650] leading-5">{name}</b>
        {stateLines(card).map(({ key, count }) => (
          key === 'needs' ? (
            // What asks for the viewer: the one line that is theirs to do, the
            // one tag in its needs-you state (@/components/ui/state-tag).
            <StateTag key={key} state="needs" data-home-activity-line={key} data-ask="">
              {t(STATE_IDS[key], { count })}
            </StateTag>
          ) : (
            <span key={key} className="block truncate text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400" data-home-activity-line={key}>
              {t(STATE_IDS[key], { count })}
            </span>
          )
        ))}
      </span>
      {when ? (
        <span className="wip-activity-when block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400">
          <time dateTime={card.at || undefined} title={whenTitle}>{when}</time>
        </span>
      ) : null}
    </a>
  );
}

/** A card's placeholder, the card's own size: its icon, its name, a line and when. */
function CardSkeleton(): ReactNode {
  return (
    <span className="wip-card wip-activity-card" aria-hidden="true">
      <span className="wip-activity-top"><WipSkel shape="icon" /></span>
      <span className="wip-activity-words wip-skel-lines">
        <WipSkel shape="line" />
        <WipSkel shape="line-short" />
      </span>
    </span>
  );
}

export function NeedsYouCard(): ReactNode {
  const t = useMessages('home');
  // Until the lists are read this load, the row stands on how many cards the
  // last visit drew on this device, so its place is held from the first
  // paint and nothing under it moves when they arrive. Somebody with nothing
  // last time gets no placeholder to flash and go.
  const [hint] = useState(readNeedsHint);
  const [cards, setCards] = useState<ActivityCard[] | null>(null);
  // A read that failed draws nothing, and leaves the hint as it was; one
  // that fails after one that landed keeps the cards it drew.
  const [failed, setFailed] = useState(false);
  // Read when the card mounts and again each time Home is shown: what is
  // yours moves while you are on another tab, and the tab reads afresh on
  // every showing. The reads are kept a short while (readDesk), so coming
  // straight back asks for nothing.
  const shown = useVisibility('home-screen', true);
  const had = useRef(false);
  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    const fail = () => { if (live && !had.current) setFailed(true); };
    void readDesk().then(({ work, needs }) => {
      if (!live) return;
      const next = activityCards(needs, work);
      if (!next) { fail(); return; }
      had.current = true;
      setCards(next);
      setFailed(false);
    }, fail);
    return () => { live = false; };
  }, [shown]);

  useEffect(() => { if (cards) writeNeedsHint(cards.length); }, [cards]);

  const drawn = cards ? cards.length > 0 : !failed && hint > 0;
  if (!drawn) return null;

  return (
    <section id="home-needs-card" aria-label={t('home:needsCard.eyebrow')} data-projects={cards ? String(cards.length) : undefined}>
      {/* The section's label line, on the page as every section's is: the
          label and See all, one link, to the tab with every project. */}
      <SectionHeading>
        <WipHeadMore
          id="home-needs-card-btn"
          direction="right"
          href={SEE_ALL_HREF}
          label={t('home:needsCard.seeAllLabel')}
          pill={t('home:needsCard.seeAll')}
        >
          <span id="home-needs-card-title" className="wip-head-words">{t('home:needsCard.eyebrow')}</span>
        </WipHeadMore>
      </SectionHeading>
      {!cards ? (
        // The lists are on their way: as many placeholder cards as the last
        // visit drew, so the row is its own height. Said once, in words.
        <ul className="wip-activity-rail animate-pulse" data-loading="" role="status" aria-label={t('home:grid.loading')}>
          {Array.from({ length: Math.min(hint, HINT_CARDS) }, (_, i) => <li key={i}><CardSkeleton /></li>)}
        </ul>
      ) : (
        <ul className="wip-activity-rail" aria-labelledby="home-needs-card-title">
          {cards.map((card) => <li key={card.app.slug}><ActivityCardLink card={card} /></li>)}
        </ul>
      )}
    </section>
  );
}
