/**
 * The project hub's own cards. The hub is the first of the project page's
 * places (Hub, Needs you, Workshop, then #general and its topics:
 * ./project-places.tsx, #4417), and it is the project's summary for the
 * people in it. Under the hero (./community-card.tsx: what it is, who it is
 * for and who is around this week), top to bottom:
 *
 *   FOR YOU, one card of doors, a row each, each opening its place: Needs
 *   you (the first vote you owe "and 3 more", "4 to vote"), the Workshop
 *   (what happened, and every item; 6 Nov 2026: it took Your work's place
 *   there) and the Discussion (#general and its last line, or "No messages
 *   yet."). ForYouCard.
 *   RECENTLY LIVE, the last three changes that went live, each as its after
 *   shot, its title, and who made it and when; before any has, the app
 *   itself and since when it has been live. RecentlyLive.
 *
 * What landed since your last visit and your work in full are the Workshop
 * place's; how a change gets in is its Approval rules card. The hub points
 * at them rather than drawing them twice.
 *
 * VERSIONS (docs/plans/versions.md). A version made from another project,
 * its original, gets the UPDATE card under the hero when the original has
 * changed and that change is waiting to be looked at, or, on a version that
 * does not get its updates, once, when the original has moved on since
 * (UpdateCard). An original gets FROM ITS VERSIONS after For you: the
 * suggestions its versions sent, what went live in them lately, and how its
 * last update went down (FromVersionsCard).
 *
 * A project Homeroom bot is still building gets its FIRST VERSION card
 * first, right under the hero: where the build stands, and the way to the
 * bot's chat when the bot waits on its maker (FirstVersionCard below). Once
 * Homeroom bot has drawn the FIRST LOOK at it, its maker's card shows that
 * picture too, with the way to watch it built (FirstLookView).
 *
 * ── One hub from the first day ─────────────────────────────────────────
 *
 * Evan, 5 Oct 2026, on a brand-new project of his own: "The initial hub if
 * no one has joined is really sad." It read "Just you", "Nothing more to
 * vote on." and "Your work · No work in progress." Nobody else can put a
 * vote up there, so on a project nobody else is in the vote line says
 * nothing (`alone` in NothingToVote). For a while an empty Your work and
 * the Discussion left a new project's hub too, and a ready-made app's hub
 * then looked nothing like an older project's (15 Oct 2026). So For you is
 * the same card from the first day: the Workshop and the Discussion always,
 * the Discussion saying so when it is empty, and Needs you only when
 * something needs you.
 *
 * ── The channel lives on the page ──────────────────────────────────────
 *
 * A project's channel was a row in Messages (#2718 review). Messages is
 * people and agents now, and the channel is the community's own room, its
 * Discussion (./project-discussion.tsx), so the hub's door to it says the
 * last thing said there, a project that is just yours too. A viewer who may
 * not talk here (a view-public, collab-private app) gets no row: no door
 * that refuses them.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The lander mounts client-side into a legacy host and has no server render,
 * so these read the shared community record (./community-card.tsx's
 * useCommunity) and draw nothing until it has answered.
 */

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader, ListRow } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { ArrowPathIcon, ArrowUpTrayIcon, BallotIcon, BoardIcon, ChatIcon, CheckIcon, ChevronRightIcon, ClockIcon, HashIcon, SparklesIcon } from '@/components/ui/icons';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { agoStamp } from '../../../lib/timestamp';
import { changeHref } from '../../../lib/change-href';
import { BuildLine, type BuildLineState, buildLineOf, phaseLine, useNow } from '../../first-session/build-line';
import { useTourRunning } from '../../first-session/tour-running';
import { DrawnLook, isDrawnLook, ownSrc, useLookSwap } from '../../first-session/drawn-look';
import { firstLookSrc } from '../../first-session/first-look';
import { countsDown, estimateOf, leftNote } from '../../app-frame/first-version-eta';
import { AppIconContent, appIconKind } from '../../apps/app-card-view';
import { madeAppUrl } from '../../first-session/made';
import { ThumbRow } from '../../first-session/sketch-card';
import { open as openConversation, openBot } from '../../messages/store';
import { openBotTab } from '../../ai/door';
import type { DevWorkshopView, ListRow as BoardRow } from '../card/model';
import { isNeedsSeen, needsRowKey, useNeedsSeen } from '../../workshop/needs-seen';
import { reloadCommunity, type CommunityPayload, type HubFirstVersion } from './community-card';
import { channelPlace, liveTopics, placeName, type PlaceKey } from './places';
import { useHubDismissed, type HubCard } from './hub-dismissed';
import {
  askToFit, goTo, upstreamAction, useUpstream, useVersionsSummary,
  type UpstreamState, type VersionsSummary,
} from '../../versions/upstream';

/** How often the hub reads the project again while its first version is being built. */
export const FIRST_VERSION_POLL_MS = 15000;

/**
 * #4053: the build line, the server's for this viewer (`line`, from
 * homeroom-bot-dm.js firstVersionState), so the hub says exactly what the
 * made screen and the App tab say: "Building it", never "Step 4 of 7: Build
 * it", which read as an instruction to the person looking at it. Step
 * numbers stay in Homeroom bot's chat.
 */
export function firstVersionLine(fv: HubFirstVersion): BuildLineState {
  return buildLineOf(fv.line) || (fv.ready ? 'ready' : 'planning');
}

/**
 * The one thing the card offers, for whoever reads it (#4045), or null:
 *
 *   review    its plan waits for their Build it      the person who started it
 *   answer    Homeroom bot asked them a question     the person who started it
 *   see       its plan waits, read only (#4074)      a member who did not start it
 *   try       built and up for approval              everyone
 *   open      live, in the project's first week      everyone
 *   retry     its build stopped, nothing live yet    the person who started it
 *
 * A card with a button hides its build line (the owner, 6 Oct 2026): "Your
 * plan is ready to review" over "Review the plan" said one thing twice, so
 * the button says it and the app's own line sits under its name. See the
 * plan is a quiet link beside the line, not a button, so "Planning it"
 * stays. Try again (14 Oct 2026, newcomer run eight) keeps the line: it
 * says Stopped, which the button does not, and opens the build's thread in
 * its maker's chat with Homeroom bot, where the bot's own Try again is.
 */
export type FirstVersionAction = 'review' | 'answer' | 'see' | 'try' | 'open' | 'retry';

export function firstVersionAction(fv: HubFirstVersion): FirstVersionAction | null {
  const line = firstVersionLine(fv);
  if (line === 'live') return 'open';
  if (line === 'stopped') return fv.mine ? 'retry' : null;
  if (fv.ready) return fv.session_id ? 'try' : null;
  if (fv.waits_on === 'plan') return 'review';
  if (fv.waits_on === 'question') return 'answer';
  if (fv.plan && fv.plan.bullets && fv.plan.bullets.length) return 'see';
  return null;
}

/** The button's words by action: message ids, read when the card renders. */
const ACTION_WORDS: Record<Exclude<FirstVersionAction, 'see'>, string> = {
  review: 'project:hub.firstVersion.review',
  answer: 'project:hub.firstVersion.answer',
  try: 'project:hub.firstVersion.tryIt',
  open: 'project:hub.firstVersion.openApp',
  retry: 'project:hub.firstVersion.tryAgain',
};

/**
 * FIRST VERSION (#4045): the project's thumbnail drawn small, its icon on
 * its colour and its name (../../first-session/sketch-card.tsx ThumbRow),
 * with ONE more line and at most one thing to do (firstVersionAction). With
 * nothing to tap, the line is the build line the made screen and the App
 * tab draw ("Building it", ../../first-session/build-line.tsx), the
 * server's for this viewer (GET /api/apps/:slug/community `first_version`).
 * With a button, the button says where it is and the card has no line: the
 * project's own description sits once, under the hub's people row (the
 * owner, 8 Oct 2026).
 *
 *   Review the plan, Answer the question   open the maker's chat with
 *                                          Homeroom bot, where it is answered
 *   See the plan                           the plan, read only (./plan-page.tsx)
 *   Try it                                 the version to try, as its message
 *                                          in the chat opens it
 *   Open app                               the app, once it is live
 *
 * No "First version" heading, no step count and no note under it: the
 * thumbnail is what it is, and one line says where it is. Nothing for a
 * project the bot is not building, or once its first version is live and
 * the project's first week is over.
 *
 * While the first-session tour runs (../../first-session/tour-running.ts)
 * there is no Review the plan: the card shows the build line, "Homeroom bot
 * is working on it": the tour asks for nothing but its own cards (requests
 * #4391, #4393), and its last card, here on the hub, is Open app. After the
 * tour, it is as above.
 *
 * No event marks each step, so while the card is on screen the record is
 * read again every FIRST_VERSION_POLL_MS, as the App tab and the made screen
 * read theirs (AppView._recheckFirstVersion, made.tsx).
 *
 * Its maker's card, once the first look is drawn (useFirstLook), is that
 * picture in place of the thumbnail, with the name, the same line and
 * "Watch Homeroom bot build it" beside it (FirstLookView). It was a second
 * card after For you, saying the project's state twice on one screen (Evan,
 * 21 Oct 2026: "merge the working out the details card and the first look
 * card").
 */
export function FirstVersionCard({ slug, data, emoji = null, onSeePlan }: {
  slug: string;
  data: CommunityPayload | null;
  /** The project's icon, as the page already knows it (improveStore). */
  emoji?: string | null;
  /** Opens the plan, read only (./workshop.tsx's 'plan' page). */
  onSeePlan?: () => void;
}): ReactNode {
  const fv = data?.first_version || null;
  const ref = useRef<HTMLElement | null>(null);
  const building = !!fv && fv.line !== 'live';
  useEffect(() => {
    if (!building || !slug) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!ref.current || !ref.current.getClientRects().length) return;
      void reloadCommunity(slug);
    }, FIRST_VERSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [building, slug]);
  // While the first-session tour runs (../../first-session/tour-running.ts),
  // no Review the plan here, only the build line saying the bot is on it.
  const touring = useTourRunning();
  const look = useFirstLook(slug, hubShowsFirstLook(fv));
  const t = useMessages('project');
  const now = useNow();
  if (!fv) return null;
  const asked = firstVersionAction(fv);
  const held = touring && asked === 'review';
  const line: BuildLineState = held ? 'working' : firstVersionLine(fv);
  const action = held ? null : asked;
  // Run five: the stage by its own name while it is built, as the App tab
  // and the Home tile name it ("Starting the build", "Working out the details").
  // Run six: the time left, as the App tab says it, when there is an estimate.
  const left = countsDown(line) ? leftNote(estimateOf(fv.estimate), now) : null;
  const named = phaseLine(line, fv.phase, now, null, left);
  const press = () => {
    if (action === 'review' && fv.plan_at?.threadRootId) {
      // Its plan waits in a private thread of theirs: open it there, at the plan.
      openBotTab({ threadRootId: fv.plan_at.threadRootId, focusMessageId: fv.plan_at.messageId ?? null });
    } else if (action === 'review' || action === 'answer') {
      if (fv.conversation_id) openConversation(fv.conversation_id);
      else void openBot();
    } else if (action === 'try' && fv.session_id) {
      (window as any).AppView?.tryFirstVersion?.(slug, fv.session_id);
    } else if (action === 'open') {
      (window as any).App?.openAppTab?.(slug, 'app');
    } else if (action === 'retry') {
      // The App tab's own opener for it (AppView.openFirstVersionThread).
      const thread = fv.thread || null;
      (window as any).AppView?.openFirstVersionThread?.(slug, thread?.conversationId ?? fv.conversation_id ?? null,
        thread?.threadRootId ?? null, thread?.messageId ?? null);
    }
  };
  const button = action && action !== 'see';
  // Try again keeps the line that says it stopped.
  const lineShown = !button || action === 'retry';
  // The first look is the maker's alone, held back while the tour runs:
  // its own last card is this picture.
  if (look && !touring) {
    return (
      <FirstLookView
        sectionRef={ref}
        slug={slug}
        name={data?.name || slug}
        src={look.src}
        stage={line}
        line={lineShown ? { state: line, words: named.words, note: named.note } : null}
        action={button && action ? (
          <Button
            type="button"
            layout="full"
            variant="pillAccent"
            size="pill"
            ink="solid"
            data-ws-first-version-action={action}
            onClick={press}
          >
            {t(ACTION_WORDS[action])}
          </Button>
        ) : null}
        onBroken={look.onBroken}
        // #5618: the picture and the words open the maker's chat with
        // Homeroom bot, as Review the plan does; Watch keeps its own job.
        onOpen={() => {
          if (fv.conversation_id) openConversation(fv.conversation_id);
          else void openBot();
        }}
      />
    );
  }
  return (
    <section ref={ref} className="dev-ws-strip dev-ws-hub-first" data-ws-first-version={line}>
      <div className="dev-ws-hub-first-row">
        <ThumbRow
          name={data?.name || slug}
          colorKey={slug}
          emoji={emoji}
          line={lineShown ? line : null}
          lineWords={named.words}
          lineNote={named.note}
        />
        {action === 'see' ? (
          <button
            type="button"
            className="dev-ws-hub-first-see un-touch-target"
            data-ws-first-version-plan=""
            onClick={onSeePlan}
          >
            {t('project:hub.firstVersion.seePlan')}
          </button>
        ) : null}
      </div>
      {button && action ? (
        action === 'open' ? (
          <button type="button" className="dev-ws-open-app dev-ws-hub-first-open" data-ws-first-version-action="open" onClick={press}>
            {t(ACTION_WORDS.open)}
          </button>
        ) : (
          <Button
            type="button"
            layout="full"
            variant="pillAccent"
            size="pill"
            ink="solid"
            data-ws-first-version-action={action}
            onClick={press}
          >
            {t(ACTION_WORDS[action])}
          </Button>
        )
      ) : null}
    </section>
  );
}

/* ── First look ──────────────────────────────────────────────────────── */

/**
 * Whether the First version card shows its maker the first look
 * (FirstLookView): their own first version, being built or tested, not
 * ready to try and not live. Its words ("Drawn from your answers") are the
 * maker's alone, and once it is ready to try, the card has Try it. Pure.
 */
export function hubShowsFirstLook(fv: HubFirstVersion | null | undefined): boolean {
  return !!fv && fv.mine && !fv.ready && (fv.line === 'building' || fv.line === 'testing');
}

/** The first look alone, never the real screens: its words say it was drawn from the plan. */
const FIRST_LOOK_ONLY: readonly string[] = ['first_look'];

/**
 * FIRST LOOK (newcomer run six, 14 Oct 2026). After the tour's Done the
 * maker landed on the hub: "Building it", the Share it card, then empty
 * space down to the Resume bar. The first look, the picture of the app's
 * main screen Homeroom bot drew from the plan (services/first-version-
 * screens.js), was only on the App tab and on the tour's last card. While
 * their first version is built and that picture is there, the First version
 * card shows it (21 Oct 2026; a card of its own after For you until then).
 *
 * The picture is read as the tour's last card reads it (../../first-session/
 * first-look.tsx: GET /api/apps/:slug `first_version.screens`, the first look
 * alone here), asked again every FIRST_VERSION_POLL_MS while it is not
 * there, and once it is, not again. Null until it is there, and for anyone
 * but the maker of a build on its way (`wanted`, hubShowsFirstLook).
 *
 * 15 Oct 2026 (newcomer run nine): until the picture is saved, its drawn
 * screen (../../first-session/drawn-look.tsx), asked again until the
 * picture is there and swapped for it once it is in.
 */
export function useFirstLook(slug: string, wanted: boolean): { src: string; onBroken: () => void } | null {
  const [src, setSrc] = useState<string | null>(null);
  // A picture that would not load is asked for again, as one not there yet.
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || !slug || (src && src !== broken && !isDrawnLook(src))) return undefined;
    let live = true;
    const read = () => fetch(madeAppUrl(slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const found = firstLookSrc(body, slug, FIRST_LOOK_ONLY);
        if (live && found && found !== broken) setSrc(found);
      })
      .catch(() => {});
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, FIRST_VERSION_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [wanted, slug, src, broken]);
  const shown = useLookSwap(src && src !== broken ? src : null, ownSrc);
  if (!wanted || !shown) return null;
  return { src: shown, onBroken: () => setBroken(shown) };
}

/**
 * "Watch Homeroom bot build it": the project's App tab, where the live
 * picture of the build is (features/app-frame/app-status.tsx), as the First
 * version card's Open app goes there.
 */
export function watchBuild(slug: string): void {
  (window as any).App?.openAppTab?.(slug, 'app');
}

/**
 * The First version card with its maker's first look (FirstVersionCard,
 * useFirstLook): the picture small and phone-shaped in place of the
 * thumbnail, then the project's name, the card's build line ("Working out
 * the details · 2 min so far"), one line saying where the picture came
 * from, the card's own button when something waits on its maker, and
 * "Watch Homeroom bot build it", which opens the App tab, where the live
 * picture of the build is. Nothing to share: inviting is the Share it
 * card's, and an invite is to the community, not to a picture of its app.
 *
 * TAPPING IT (#5618): with `onOpen`, the picture and the words open the
 * maker's chat with Homeroom bot. An empty button over them (under the
 * buttons) is the door, so the card keeps its look and only a hover tint
 * and the focus ring say it can be tapped.
 */
export function FirstLookView({ slug, name, src, stage = null, line = null, action = null, onBroken, onOpen, sectionRef }: {
  slug: string;
  name: string;
  /** The first look's own URL (../../first-session/first-look.tsx firstLookSrc), or its drawn screen's. */
  src: string;
  /** The First version card's line, as its `data-ws-first-version`. */
  stage?: BuildLineState | null;
  /** The build line under the name; null when the card's button says where it is. */
  line?: { state: BuildLineState; words?: string | null; note?: string | null } | null;
  /** The First version card's one button, when something waits on its maker. */
  action?: ReactNode;
  /** The picture would not load: the card asks for it again. */
  onBroken?: () => void;
  /** Opens the maker's chat with Homeroom bot: the picture and words become its door. */
  onOpen?: () => void;
  /** The First version card's own, so it reads the record again while on screen. */
  sectionRef?: Ref<HTMLElement>;
}): ReactNode {
  const t = useMessages('project');
  const alt = t('project:hub.firstLook.alt', { app: name });
  return (
    <section ref={sectionRef} className="dev-ws-strip dev-ws-hub-first dev-ws-first-look" data-ws-first-version={stage ?? undefined} data-ws-first-look="">
      {onOpen ? (
        <button
          type="button"
          className="dev-ws-first-look-open"
          data-ws-first-look-open=""
          aria-label={t('project:hub.firstLook.open')}
          onClick={onOpen}
        />
      ) : null}
      {isDrawnLook(src) ? (
        // Its drawn screen, at the picture's size, until the picture is saved.
        <div className="dev-ws-first-look-shot relative overflow-hidden">
          <DrawnLook src={src} label={alt} width={64} />
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          width={64}
          height={138}
          draggable={false}
          onError={onBroken}
          className="dev-ws-first-look-shot"
        />
      )}
      <div className="dev-ws-first-look-body">
        <p className="dev-ws-first-look-name">{name}</p>
        {line ? <BuildLine state={line.state} words={line.words} note={line.note} stacked className="self-stretch" /> : null}
        <p className="dev-ws-strip-text">{t('project:hub.firstLook.text')}</p>
        {action}
        <Button
          type="button"
          variant="pillNeutral"
          size="sm"
          ink="neutral"
          data-ws-first-look-watch=""
          onClick={() => watchBuild(slug)}
        >
          {t('project:hub.firstLook.watch')}
        </Button>
      </div>
    </section>
  );
}

/** Whether the queue holds a vote the viewer owes: the hub's Needs you door
    is drawn only then. */
export const owesVote = (queue: DevWorkshopView['queue']): boolean => queue.some((row) => row.kind === 'vote');

/**
 * NO VOTE OWED (#3408): in the Needs you card's place, one quiet line that
 * says so, instead of a card whose whole content was that nothing waits.
 * When requests nobody has picked up are open (`unclaimed`, the view
 * model's `dashboard.unclaimed`) the line names them, and that phrase is the
 * way to them: the Workshop, where the work is (Needs you is votes alone).
 *
 * ON A PROJECT NOBODY ELSE IS IN (`alone`) there is nobody to put a vote up,
 * so "Nothing more to vote on." is a zero, and a zero says nothing: the line
 * is not drawn, or it is the requests alone when there are some.
 */
export function NothingToVote({ unclaimed, onOpen, alone = false }: {
  /** Open requests nobody has picked up. */
  unclaimed: number;
  onOpen: () => void;
  /** Nobody but one person is in the project (hubAlone): nobody else
      can put a vote up, so the zero says nothing. */
  alone?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const claims = Math.max(0, Number(unclaimed) || 0);
  if (alone && !claims) return null;
  return (
    <p className="dev-ws-week-note" data-ws-hub-needs-none="">
      {!claims ? t('project:hub.needs.none') : (
        // One message either way: alone, the requests are the whole line;
        // otherwise they follow "Nothing more to vote on", inside the same sentence.
        <RichMessage
          id={alone ? 'project:hub.needs.requestsAlone' : 'project:hub.needs.noneButRequests'}
          values={{ count: claims }}
          components={[
            <button type="button" className="dev-ws-link un-touch-target" onClick={onOpen} data-ws-hub-needs-requests="" />,
          ]}
        />
      )}
    </p>
  );
}

/**
 * Whether nobody but one person is in the project: Just you, or a
 * community whose one member is still alone in it. Not before the read has
 * answered, so nothing is taken off the hub on a guess.
 */
export function hubAlone(data: Pick<CommunityPayload, 'audience' | 'member_count'> | null | undefined): boolean {
  return !!data && (data.audience === 'solo' || (Number(data.member_count) || 0) <= 1);
}

/* ── For you ─────────────────────────────────────────────────────────── */

/** A row's label over its card: SectionHeader, set for the hub's column. */
const HUB_HEAD = 'px-1 pb-0 pt-2';

/** The Needs you tile while a vote is owed: the accent, which asks for you. */
const OWED_TILE = 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300';

/**
 * NEEDS YOU, as the card's first row: the first vote you owe and how many
 * more ("Builder login…, and 3 more"), "4 to vote", opening the queue — one
 * decision per screen, as it always was. The queue also carries requests
 * nobody has claimed, which are the group's to pick up rather than yours to
 * answer, so they are not counted here.
 *
 * #3526: THE COUNT IS WHAT YOU HAVE NOT SEEN. A vote swiped past in the feed
 * unanswered is left out of it, as the band's count leaves it out
 * (../../workshop/needs-seen.ts), and the first title is the first vote you
 * have not seen. The row stays while any vote is owed, seen or not: with
 * nothing new it says how many skipped ones are still open instead.
 */
function NeedsRow({ queue, slug, canPost, onOpen, outsider = false }: {
  queue: DevWorkshopView['queue'];
  slug: string;
  canPost: boolean;
  onOpen: () => void;
  /**
   * Signed in but not in the community (the hand-off of 11 Nov 2026): the
   * votes are not theirs to cast yet, so the door is "Up for a vote · Join
   * to vote on these." with how many as a light pill, not "Needs you".
   */
  outsider?: boolean;
}): ReactNode {
  const t = useMessages('project');
  useNeedsSeen();
  const votes = queue.filter((row) => row.kind === 'vote');
  if (outsider) {
    return (
      <div className="dev-ws-foryou-item" data-ws-hub-needs="" data-ws-hub-needs-votes={String(votes.length)} data-ws-hub-needs-outsider="">
        <ListRow
          as="button"
          inset="none"
          className="dev-ws-foryou-row"
          data-ws-hub-needs-open=""
          onClick={onOpen}
          leading={<IconTile size="xs" className={OWED_TILE}><BallotIcon aria-hidden="true" /></IconTile>}
          title={t('project:hub.needs.upForVote')}
          subtitle={<span data-ws-hub-needs-join="">{t('project:hub.needs.joinToVote')}</span>}
          trailing={(
            <span className="dev-ws-foryou-pill dev-ws-foryou-pill-light" data-ws-hub-needs-count="">
              <span aria-hidden="true">{votes.length}</span>
              <span className="sr-only">{t('project:hub.needs.upForVoteCount', { count: votes.length })}</span>
            </span>
          )}
        />
      </div>
    );
  }
  const fresh = votes.filter((row) => !isNeedsSeen(slug, needsRowKey(row)));
  const skipped = votes.length - fresh.length;
  const first = fresh.find((row) => row.t === 'card') || null;
  const count = fresh.length;
  const title = first && first.t === 'card' ? first.card.title.text || first.card.title.title : '';
  const sub = count && title ? (
    <span data-ws-hub-needs-first="">
      {count > 1 ? t('project:hub.forYou.needs.firstAndMore', { title, count: count - 1 }) : title}
    </span>
  ) : !count && skipped ? (
    <span data-ws-hub-needs-skipped="">{t('project:hub.needs.skipped', { count: skipped })}</span>
  ) : undefined;
  return (
    <div className="dev-ws-foryou-item" data-ws-hub-needs="" data-ws-hub-needs-votes={String(count)}>
      <ListRow
        as="button"
        inset="none"
        className="dev-ws-foryou-row"
        data-ws-hub-needs-open=""
        onClick={onOpen}
        leading={<IconTile size="xs" className={count ? OWED_TILE : undefined}><BallotIcon aria-hidden="true" /></IconTile>}
        title={t('project:hub.needs.title')}
        subtitle={sub}
        trailing={count ? <span className="dev-ws-foryou-pill">{t('project:hub.needs.toVote', { count })}</span> : undefined}
      />
      {count && !canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">{t('project:hub.needs.joinToVote')}</p>
      ) : null}
    </div>
  );
}

/**
 * THE WORKSHOP, For you's door to the place: what happened here, and All
 * items. It was the phone's row alone (3 Nov 2026), with Your work beside it
 * from 5 Nov 2026; on 6 Nov 2026 it took Your work's place at every width,
 * so the Hub's rows are the places it leads to. Your own work is the Homeroom
 * bot tab's, and its card is on the Workshop tab (./your-work.tsx,
 * YourWorkCard).
 */
function WorkshopRow({ onOpen }: { onOpen: () => void }): ReactNode {
  const t = useMessages('project');
  return (
    <ListRow
      as="button"
      inset="none"
      className="dev-ws-foryou-row"
      data-ws-workshop-row=""
      onClick={onOpen}
      leading={<IconTile size="xs"><BoardIcon aria-hidden="true" /></IconTile>}
      title={placeName('workshop')}
      subtitle={t('project:hub.workshop.sub')}
    />
  );
}

/**
 * THE DISCUSSION, as the card's last row: the channel's name and the last
 * thing said in it, "@kempis: enjoy the weekend guys · 4h ago", opening the
 * Discussion place (./project-discussion.tsx), where the room is whole. How
 * much there is new since you last read it is its one pill. With nothing
 * said yet, "No messages yet." On a project that is just yours too (15 Oct
 * 2026): the room is there from the first day, for the people an invite
 * brings. No row without a channel this viewer may talk in.
 */
function DiscussionRow({ data, onOpen, outsider = false }: {
  data: CommunityPayload | null;
  onOpen: () => void;
  /** Not in the community: nothing in the room is theirs to catch up on, so no unread pill. */
  outsider?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const channel = data?.channel;
  if (!data || !channel) return null;
  // The newest line with words in it: a message that is only a picture or a
  // file has none to quote, so it is named by who sent it.
  const recent = (channel.recent || []).map((m) => ({ content: m.content, by: m.by, at: m.created_at }));
  if (!recent.length && channel.last_at) recent.push({ content: channel.last_message || '', by: channel.last_by, at: channel.last_at });
  const words = (m: { content: string | null }) => String(m.content || '').replace(/\s+/g, ' ').trim();
  const last = [...recent].reverse().find((m) => words(m)) || recent[recent.length - 1] || null;
  const unread = outsider ? 0 : Number(channel.unread_count) || 0;
  const line = last ? words(last) : '';
  const ago = last && last.at ? agoStamp(last.at).text : '';
  const sub = last ? (
    <span data-ws-channel-last="">
      {/* The message is cut short, never the time: with the pill and the
          chevron at the row's end, "· 9…" was all that was left of
          "· 9m ago" (audit P04). */}
      {line && last.by ? (
        <RichMessage
          id="project:hub.forYou.discussion.lastBy"
          values={{ username: last.by, message: line, ago }}
          components={[<span data-ws-channel-said="" />, <span data-ws-channel-ago="" />]}
        />
      ) : line ? (
        <RichMessage
          id="project:hub.forYou.discussion.last"
          values={{ message: line, ago }}
          components={[<span data-ws-channel-said="" />, <span data-ws-channel-ago="" />]}
        />
      )
          : last.by ? t('project:hub.forYou.discussion.postedBy', { username: last.by, ago })
            : t('project:hub.forYou.discussion.posted', { ago })}
    </span>
  ) : (
    <span data-ws-channel-empty="">{t('project:hub.channel.empty')}</span>
  );
  return (
    <ListRow
      as="button"
      inset="none"
      className="dev-ws-foryou-row"
      data-ws-channel="preview"
      data-ws-channel-open=""
      data-ws-channel-handle={channel.handle || undefined}
      onClick={onOpen}
      leading={<IconTile size="xs"><ChatIcon aria-hidden="true" /></IconTile>}
      title={(
        <RichMessage
          id="project:hub.forYou.discussion.title"
          values={{ handle: channel.handle || 'general' }}
          components={[<span className="dev-ws-foryou-handle" />]}
        />
      )}
      subtitle={sub}
      trailing={unread > 0 ? (
        <span className="dev-ws-foryou-pill" data-ws-channel-unread={String(unread)}>
          {t('project:hub.channel.unread', { count: unread, shown: unread > 99 ? '99+' : String(unread) })}
        </span>
      ) : undefined}
    />
  );
}

/**
 * FOR YOU: what on this project is the viewer's, one card of doors under its
 * label — Needs you, the Workshop, the Discussion — each row a door to its
 * place, at most one pill on it, 15 over 13. The same card from a project's
 * first day (15 Oct 2026): the Workshop and the Discussion are always there,
 * the Discussion saying so when it is empty, and Needs you only when a vote
 * waits on you. With no vote owed, Needs you is the quiet line that says so
 * (NothingToVote, #3408), or nothing on a project nobody else is in.
 * Nothing at all when no row has anything to say.
 *
 * 6 Nov 2026: the Workshop's row is drawn at every width, in the place Your
 * work had, and opens the Workshop (the phone's row until then). Your work
 * is the Homeroom bot tab's, said on the Workshop tab's own card.
 */
export function ForYouCard({
  slug, queue, unclaimed, mine, alone, data, canPost, onNeeds, onWork, onDiscussion,
}: {
  slug: string;
  queue: DevWorkshopView['queue'];
  /** Open requests nobody has picked up (the view model's
      `dashboard.unclaimed`): Needs you is votes alone, so with no vote
      owed its quiet line names them and opens the Workshop. */
  unclaimed: number;
  mine: DevWorkshopView['mine'] | null | undefined;
  /** Nobody else is in it (hubAlone): no zeros. */
  alone: boolean;
  data: CommunityPayload | null;
  canPost: boolean;
  onNeeds: () => void;
  onWork: () => void;
  onDiscussion: () => void;
}): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const owes = owesVote(queue);
  const claims = Math.max(0, Number(unclaimed) || 0);
  const needs = owes || !alone || claims > 0;
  // The Workshop's row is for anyone signed in, whose work there may be, or
  // not; a visitor has no work to be told about.
  const work = !!mine?.viewer;
  const talk = !!(data && data.channel);
  // Signed in and not in it: the votes are the group's, the room theirs to read.
  const outsider = !!data && !data.is_member;
  if (!needs && !work && !talk) return null;
  return (
    <section className="dev-ws-hub-section" data-ws-hub-for-you="" aria-labelledby={headId}>
      <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.forYou.title')}</SectionHeader>
      <div className="dev-ws-strip dev-ws-foryou">
        {owes
          ? <NeedsRow queue={queue} slug={slug} canPost={canPost} onOpen={onNeeds} outsider={outsider} />
          : <NothingToVote unclaimed={claims} onOpen={onWork} alone={alone} />}
        {work ? <WorkshopRow onOpen={onWork} /> : null}
        <DiscussionRow data={data} onOpen={onDiscussion} outsider={outsider} />
      </div>
    </section>
  );
}

/** How many topics the Hub lists before "Show N more". */
export const HUB_TOPICS_SHOWN = 6;

/**
 * TOPICS, ON A PHONE (Evan, 3 Nov 2026: "you land on hub and you click
 * links"). The drawer that listed a community's places beside its page is
 * gone, so the Hub is how you reach them: For you leads to Needs you, the
 * Workshop and #general, and this card to each live topic's channel, a row
 * a topic, drawn as the Discussion's row is: its icon, its name and #handle,
 * what it is about, and how much is new in it. The first few are listed and
 * the rest wait behind "Show N more", as the sidebar folds them. A wide
 * window lists the topics in its sidebar and draws no card.
 */
export function TopicsCard({ data, onOpen }: {
  data: CommunityPayload | null;
  onOpen: (key: PlaceKey) => void;
}): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const [all, setAll] = useState(false);
  const topics = liveTopics(data?.places);
  if (!topics.length) return null;
  const shown = all ? topics : topics.slice(0, HUB_TOPICS_SHOWN);
  const more = topics.length - shown.length;
  return (
    <section className="dev-ws-hub-section" data-ws-hub-topics="" aria-labelledby={headId}>
      <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.topics.title')}</SectionHeader>
      <div className="dev-ws-strip dev-ws-foryou">
        {shown.map((topic) => {
          const unread = Math.max(0, Number(topic.unread) || 0);
          return (
            <ListRow
              key={topic.handle}
              as="button"
              inset="none"
              className="dev-ws-foryou-row"
              data-ws-hub-topic={topic.handle}
              onClick={() => onOpen(channelPlace(topic.handle))}
              leading={(
                <IconTile size="xs">
                  {topic.icon
                    ? <span className="text-base leading-none" aria-hidden="true">{topic.icon}</span>
                    : <HashIcon aria-hidden="true" />}
                </IconTile>
              )}
              title={(
                <>
                  {topic.name || topic.handle} <span className="dev-ws-foryou-handle">#{topic.handle}</span>
                </>
              )}
              subtitle={topic.about || undefined}
              trailing={unread ? (
                <span className="dev-ws-foryou-pill" data-ws-hub-topic-unread={String(unread)}>
                  {t('project:hub.channel.unread', { count: unread, shown: unread > 99 ? '99+' : String(unread) })}
                </span>
              ) : undefined}
            />
          );
        })}
        {more > 0 ? (
          <ListRow
            as="button"
            inset="none"
            className="dev-ws-foryou-row"
            data-ws-hub-topics-more={String(more)}
            onClick={() => setAll(true)}
            title={t('project:places.list.showMore', { count: more })}
          />
        ) : null}
      </div>
    </section>
  );
}

/* ── The hub while it loads ──────────────────────────────────────────── */

/** A text line's own box, filled: the bar is exactly as tall as the words it stands for. */
const BAR = 'inline-block max-w-full rounded bg-zinc-200 align-top dark:bg-zinc-800';
const BAR_SOFT = 'inline-block max-w-full rounded bg-zinc-200/70 align-top dark:bg-zinc-800/70';

function SkeletonRow({ wide }: { wide: string }): ReactNode {
  return (
    <div className="dev-ws-foryou-row flex items-center">
      <span className="h-8 w-8 shrink-0 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] leading-5"><span className={`${BAR} ${wide}`}>{'\u00a0'}</span></span>
        <span className="mt-0.5 block text-[0.8125rem] leading-[1.125rem]"><span className={`${BAR_SOFT} w-2/3`}>{'\u00a0'}</span></span>
      </span>
    </div>
  );
}

/**
 * THE HUB'S OWN SHAPE WHILE IT LOADS (polish board #3): its hero (the tile
 * and the name over who it is for, the description, who is around, the
 * actions), For you's three doors and Recently live's three pictures, drawn
 * in the hub's own boxes, so what arrives lands on its own outline. It was
 * the Dev board's card list (CardSkeleton), which is no part of the hub.
 * Who is around is drawn when the last read of the communities says other
 * people are in it (`others`), as the hero only draws it then.
 */
export function HubSkeleton({ others }: { others: boolean }): ReactNode {
  const t = useMessages('project');
  return (
    <>
      <div className="sr-only" role="status">{t('project:page.loading')}</div>
      <section className="dev-ws-hero dev-ws-hero-summary animate-pulse" aria-hidden="true" data-ws-hub-skeleton="">
        <div className="dev-ws-hero-id">
          <span className="dev-ws-hero-tile bg-zinc-200 dark:bg-zinc-800" />
          <span className="dev-ws-hero-id-text">
            <span className="dev-ws-hero-name"><span className={`${BAR} w-44`}>{'\u00a0'}</span></span>
            <span className="dev-ws-hero-id-sub"><span className={`${BAR_SOFT} w-36`}>{'\u00a0'}</span></span>
          </span>
        </div>
        <span className="dev-ws-hero-desc block"><span className={`${BAR_SOFT} w-full`}>{'\u00a0'}</span><br /><span className={`${BAR_SOFT} w-2/3`}>{'\u00a0'}</span></span>
        {others ? (
          <div className="dev-ws-hero-active">
            <span className="h-8 w-28 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="dev-ws-hero-active-words">
              <span className="dev-ws-hero-active-n"><span className={`${BAR} w-32`}>{'\u00a0'}</span></span>
              <span className="dev-ws-hero-active-names"><span className={`${BAR_SOFT} w-48`}>{'\u00a0'}</span></span>
            </span>
          </div>
        ) : null}
        <div className="dev-ws-hero-row">
          <div className="dev-ws-hero-actions">
            <span className="h-8 w-24 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="h-8 w-20 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="h-8 w-8 rounded-full bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </div>
      </section>
      <section className="dev-ws-hub-section animate-pulse" aria-hidden="true">
        <div className={`${HUB_HEAD} text-xs font-bold uppercase leading-4`}><span className={`${BAR_SOFT} w-16`}>{'\u00a0'}</span></div>
        <div className="dev-ws-strip dev-ws-foryou">
          <SkeletonRow wide="w-24" />
          <SkeletonRow wide="w-28" />
          <SkeletonRow wide="w-20" />
        </div>
      </section>
      <section className="dev-ws-hub-section animate-pulse" aria-hidden="true">
        <div className={`${HUB_HEAD} text-xs font-bold uppercase leading-4`}><span className={`${BAR_SOFT} w-24`}>{'\u00a0'}</span></div>
        <div className="dev-ws-strip dev-ws-recent">
          <ul className="dev-ws-recent-list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="dev-ws-recent-item">
                <span className="dev-ws-recent-card">
                  <span className="dev-ws-recent-pic" />
                  <span className="dev-ws-recent-title"><span className={`${BAR} w-5/6`}>{'\u00a0'}</span></span>
                  <span className="dev-ws-recent-meta"><span className={`${BAR_SOFT} w-1/2`}>{'\u00a0'}</span></span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

/* ── Recently live ───────────────────────────────────────────────────── */

/** How many of the newest changes Recently live draws. */
export const RECENT_LIVE_SHOWN = 3;

/**
 * The app itself, for Recently live while none of its changes has gone live
 * yet: its tile and name (the page's own record of it, the hero's), and
 * since when it has been live (GET /api/apps/:slug/community `live_since`).
 */
export interface RecentOwn {
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  since: string | null | undefined;
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();
function dayWords(date: Date, withYear: boolean): string {
  const key = withYear ? 'year' : 'day';
  let format = DAY_FORMATS.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, withYear
      ? { year: 'numeric', month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric' });
    DAY_FORMATS.set(key, format);
  }
  return format.format(date);
}

/**
 * "Live since today", or "Live since October 12" (the year too when it is
 * not this one): the app's own card on Recently live. The day is the
 * reader's. '' without a date. Pure; `now` is the reader's clock.
 */
export function liveSinceLine(value: string | null | undefined, now: number = Date.now()): string {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate();
  if (sameDay || at.getTime() > now) return translate('project:hub.recent.own.today');
  return translate('project:hub.recent.own.since', { date: dayWords(at, at.getFullYear() !== today.getFullYear()) });
}

/** The app's own card opens the app, as the First version card's Open app does. */
function openApp(slug: string): void {
  (window as any).App?.openAppTab?.(slug, 'app');
}

/**
 * RECENTLY LIVE: the last three changes that went live, newest first
 * (AppView._workshopRecentLive), each a door to its page: its after shot
 * when the checks took one (else a plain tile), its title, and who made it
 * and when it went live — "Homeroom bot · 1h ago" — or that it is going
 * live now. The label's door, "All in Workshop", opens the Workshop, where
 * what landed is listed week by week. Three across on a wide window; on a
 * phone a row that scrolls sideways.
 *
 * NEVER EMPTY (15 Oct 2026). Before any change has gone live, the section
 * is one card for the app itself (`own`): its tile and name, "Live since
 * today" or "Live since October 12", opening the app. A new project's hub
 * then ends the way an older one's does, on what is live. Nothing without
 * that either: an app that has never run (`since` null), or one whose first
 * version Homeroom bot is still building (the page leaves `own` out), is
 * not live yet.
 */
export function RecentlyLive({ slug, rows, onAll, own = null, ident = null, month = 0 }: {
  slug: string;
  rows: DevWorkshopView['recentLive'];
  onAll: () => void;
  /**
   * How many changes went live in the last thirty days (GET .../community
   * `activity.shipped_month`): the section ends "36 more live this month",
   * those less the ones it shows, opening the Workshop. Nothing at zero.
   */
  month?: number | null;
  /** The app itself, drawn while `rows` is empty. */
  own?: RecentOwn | null;
  /**
   * The project's tile, for a change with no picture (polish board N13): its
   * icon on the community's colour, where a grey box with a check was.
   */
  ident?: Omit<RecentOwn, 'since'> | null;
}): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const list = (rows || []).slice(0, RECENT_LIVE_SHOWN);
  const self = !list.length && own && own.since ? liveSinceLine(own.since) : '';
  const more = list.length ? Math.max(0, (Number(month) || 0) - list.length) : 0;
  if (!slug || (!list.length && !self)) return null;
  const app = own ? { slug, name: own.name, icon_url: own.iconUrl || null, icon_emoji: own.iconEmoji || null } : null;
  const tile = ident ? { slug, name: ident.name, icon_url: ident.iconUrl || null, icon_emoji: ident.iconEmoji || null } : null;
  return (
    <section className="dev-ws-hub-section" data-ws-hub-recent="" aria-labelledby={headId}>
      <div className="dev-ws-hub-sechead">
        <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.recent.title')}</SectionHeader>
        {/* The door to what landed: nothing has yet, while the app's own card shows. */}
        {list.length ? (
          <button type="button" className="dev-ws-hub-open un-touch-target" data-ws-recent-all="" onClick={onAll}>
            {t('project:hub.recent.all')}
            <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="dev-ws-strip dev-ws-recent">
        <ul className="dev-ws-recent-list">
          {self && own && app ? (
            <li className="dev-ws-recent-item">
              <button type="button" className="dev-ws-recent-card" data-ws-recent-own="" onClick={() => openApp(slug)}>
                <span className="dev-ws-recent-pic" data-ws-recent-pic="app" aria-hidden="true">
                  <span className="app-icon-tile dev-ws-recent-app" data-icon={appIconKind(app)}>
                    <AppIconContent app={app} />
                  </span>
                </span>
                <span className="dev-ws-recent-title">{own.name}</span>
                <span className="dev-ws-recent-meta" data-ws-recent-since="">{self}</span>
              </button>
            </li>
          ) : null}
          {list.map((r) => {
            const ago = r.at ? agoStamp(r.at) : null;
            const meta = r.going
              ? (r.who ? t('project:hub.recent.byGoing', { who: r.who }) : t('project:hub.recent.going'))
              : r.who && ago && ago.text ? t('project:hub.recent.byAgo', { who: r.who, ago: ago.text })
                : r.who || (ago ? ago.text : '');
            return (
              <li key={r.key} className="dev-ws-recent-item">
                <a
                  className="dev-ws-recent-card"
                  href={changeHref(slug, r.sessionId, r.prNumber)}
                  data-ws-recent-item={r.key}
                  data-ws-recent-going={r.going ? '' : undefined}
                >
                  <span className="dev-ws-recent-pic" data-ws-recent-pic={r.picture ? 'shot' : 'plain'} aria-hidden="true">
                    {r.picture ? (
                      <img src={r.picture} alt="" loading="lazy" draggable={false} />
                    ) : tile ? (
                      <span className="app-icon-tile dev-ws-recent-app" data-icon={appIconKind(tile)}>
                        <AppIconContent app={tile} />
                      </span>
                    ) : r.going ? (
                      <ClockIcon className="dev-ws-recent-glyph" aria-hidden="true" />
                    ) : (
                      <CheckIcon className="dev-ws-recent-glyph" aria-hidden="true" />
                    )}
                  </span>
                  <span className="dev-ws-recent-title">{r.title}</span>
                  {meta ? (
                    <span className={r.going ? 'dev-ws-recent-meta dev-ws-recent-going' : 'dev-ws-recent-meta'} title={ago ? ago.title : undefined}>
                      {meta}
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
        {more ? (
          <button type="button" className="dev-ws-recent-more" data-ws-recent-more={String(more)} onClick={onAll}>
            <span className="dev-ws-recent-more-n" aria-hidden="true">{t('project:hub.recent.morePill', { count: more })}</span>
            <span className="dev-ws-recent-more-words">{t('project:hub.recent.moreThisMonth', { count: more })}</span>
            <ChevronRightIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}


/* ── Versions: the Update card, on a version ───────────────────────────── */

/**
 * Which Update card a version's hub draws, and the name it is closed under
 * on this device (./hub-dismissed.ts), or null for none. Pure, for the tests.
 *
 *   - `available`: the original changed and nothing has been made of it yet
 *     (a version nobody has visited lately waits for this card). See the
 *     update makes it a change and opens it.
 *   - `fit`: the change clashes with the version's own (`needs_fit`). Ask
 *     Homeroom bot to fit it files the request that builds it.
 *   - `behind`: a version that does not get its updates, once the original
 *     has moved on since it last took them, its one-time card.
 *
 * An update already up as a change (`open`) is a vote, and Needs you shows
 * it; nothing is drawn for it here, nor while versions are switched off.
 * "Not now" closes the card for that one update (`update:<its commit>`),
 * so the next one shows again; the behind card is once per device.
 */
export function updateCardOf(up: UpstreamState | null | undefined): { kind: 'available' | 'fit' | 'behind'; key: HubCard } | null {
  if (!up || !up.enabled || !up.original) return null;
  const offer = up.offer;
  const name = (kind: string) => `update:${(offer && offer.fromSha) || kind}` as HubCard;
  if (offer && offer.state === 'available') return { kind: 'available', key: name('available') };
  if (offer && offer.state === 'needs_fit') return { kind: 'fit', key: name('fit') };
  if (offer && offer.state === 'open') return null;
  if (!up.following && up.behind) return { kind: 'behind', key: 'update:behind' };
  return null;
}

/** The first of the original's changes the update brings, and how many more, or ''. */
export function bringsLine(brings: Array<{ title: string }> | null | undefined): string {
  const titles = (brings || []).map((b) => b && b.title).filter(Boolean);
  if (!titles.length) return '';
  return titles.length > 1
    ? translate('project:hub.update.bringsMore', { title: titles[0], count: titles.length - 1 })
    : titles[0];
}

/**
 * THE UPDATE CARD (docs/plans/versions.md): under the hero of a version
 * whose original has changed, for its members. Its words and buttons are
 * the share card's shape (a title, a line, a row of pills): "Update from
 * Tier list", what it brings, See the update and Not now; or, on a version
 * that does not get its updates, "Tier list has changed since you made
 * this". Reads GET /api/apps/:slug/upstream in an effect, so it draws
 * nothing until that answers (the island rule) and nothing on a project
 * that is not a version.
 */
export function UpdateCard({ slug, data }: { slug: string; data: CommunityPayload | null }): ReactNode {
  const t = useMessages('project');
  const wanted = !!(slug && data && data.made_from && data.is_member);
  const up = useUpstream(slug, wanted);
  const card = updateCardOf(up);
  const [closed, close] = useHubDismissed(slug, card ? card.key : 'update:none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  // Once Homeroom bot was asked (`asked` is the request's address), the card
  // stays to say so, whatever the record says next.
  if (!wanted || !up || !up.original) return null;
  if (asked === null && (!card || closed)) return null;
  const project = up.original.name;
  const offer = up.offer;
  const kind = card ? card.kind : 'fit';
  const title = kind === 'behind'
    ? t('project:hub.update.titleBehind', { project })
    : t('project:hub.update.title', { project });
  const conflicts = offer ? offer.conflicts.length : 0;
  const line = kind === 'behind' ? t('project:hub.update.behindLine')
    : kind === 'fit' && conflicts ? t('project:hub.update.clash', { count: conflicts })
      : bringsLine(offer && offer.brings) || t('project:hub.update.ready');

  const see = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await upstreamAction(slug, 'open', {}, 'project:hub.update.failed');
      const o = next && next.offer;
      const href = (o && o.href) || (o && o.sessionId ? changeHref(slug, o.sessionId) : '');
      if (!href) throw new Error(t('project:hub.update.failed'));
      goTo(href);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:hub.update.failed'));
    } finally {
      setBusy(false);
    }
  };
  const fit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setAsked((await askToFit(slug, 'project:hub.update.failed')) || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:hub.update.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dev-ws-strip dev-ws-share dev-ws-update" data-ws-update={kind}>
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{title}</span>
      </div>
      {asked !== null ? (
        <p className="dev-ws-strip-text" role="status" data-ws-update-asked="">
          <RichMessage
            id="project:hub.update.fitAsked"
            components={[asked ? <a className="dev-ws-link" href={asked} /> : <span />]}
          />
        </p>
      ) : (
        <>
          <p className="dev-ws-strip-text" data-ws-update-line="">{line}</p>
          {error ? <p className="dev-ws-share-sent" role="alert">{error}</p> : null}
          <div className="dev-ws-share-actions">
            {kind === 'fit' ? (
              <Button type="button" variant="pillAccent" size="sm" data-ws-update-fit="" disabled={busy} onClick={() => { void fit(); }}>
                {t('project:hub.update.fit')}
              </Button>
            ) : (
              <Button type="button" variant="pillAccent" size="sm" data-ws-update-see="" disabled={busy} onClick={() => { void see(); }}>
                {busy ? t('project:hub.update.opening') : t('project:hub.update.see')}
              </Button>
            )}
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-ws-update-later="" disabled={busy} onClick={close}>
              {t('project:hub.update.notNow')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ── Versions: From its versions, on an original ───────────────────────── */

/** The Suggestions row's line: the one suggestion and who sent it, or the first and how many more. Pure. */
export function suggestionsLine(v: Pick<VersionsSummary, 'suggestions'>): string {
  const first = v.suggestions[0];
  if (!first) return '';
  if (v.suggestions.length > 1) {
    return translate('project:hub.versions.suggestions.more', { title: first.title, count: v.suggestions.length - 1 });
  }
  return first.from
    ? translate('project:hub.versions.suggestions.from', { title: first.title, version: first.from.name })
    : translate('project:hub.versions.suggestions.fromPrivate', { title: first.title });
}

/** The "Lately in its versions" row's line: the newest change, where, and how many more. Pure. */
export function latelyLine(v: Pick<VersionsSummary, 'lately'>): string {
  const lately = v.lately;
  const first = lately && lately.rows[0];
  if (!lately || !first || !first.from) return '';
  const more = Math.max(0, lately.changes - 1);
  return more
    ? translate('project:hub.versions.lately.firstMore', { title: first.title, version: first.from.name, count: more })
    : translate('project:hub.versions.lately.first', { title: first.title, version: first.from.name });
}

/** The "Your last update" row's line, the parts with nothing in them left out. Pure. */
export function lastUpdateLine(v: Pick<VersionsSummary, 'lastUpdate'>): string {
  const u = v.lastUpdate;
  if (!u || !u.offered) return '';
  const values = { took: u.took, offered: u.offered, skipped: u.skipped, deciding: u.deciding };
  if (u.skipped && u.deciding) return translate('project:hub.versions.last.all', values);
  if (u.deciding) return translate('project:hub.versions.last.noSkipped', values);
  if (u.skipped) return translate('project:hub.versions.last.noDeciding', values);
  return translate('project:hub.versions.last.took', values);
}

/**
 * FROM ITS VERSIONS (docs/plans/versions.md): on an original's hub, after
 * For you, under its small-caps label, one card of rows as For you is:
 * Suggestions (what its versions sent it, the first one's door), Lately in
 * its versions (what went live in them, from the public ones and the ones
 * that share it), and Your last update (how many took it, skipped it, are
 * deciding). A row with nothing to say is left out, and so is the section
 * while nobody has made a version (the community record's `versions`).
 * Reads GET /api/apps/:slug/versions in an effect.
 */
export function FromVersionsCard({ slug, data }: { slug: string; data: CommunityPayload | null }): ReactNode {
  const t = useMessages('project');
  const headId = useId();
  const wanted = !!(slug && data && data.versions && Number(data.versions.count) > 0);
  const v = useVersionsSummary(slug, wanted);
  if (!wanted || !v || !v.count) return null;
  const suggestions = suggestionsLine(v);
  const lately = latelyLine(v);
  const last = lastUpdateLine(v);
  if (!suggestions && !lately && !last) return null;
  const first = v.suggestions[0];
  const firstHref = first ? (first.href || (first.sessionId ? changeHref(slug, first.sessionId) : '')) : '';
  return (
    <section className="dev-ws-hub-section" data-ws-hub-versions="" aria-labelledby={headId}>
      <SectionHeader id={headId} className={HUB_HEAD}>{t('project:hub.versions.title')}</SectionHeader>
      <div className="dev-ws-strip dev-ws-foryou">
        {suggestions ? (
          <ListRow
            {...(firstHref ? { as: 'a' as const, href: firstHref } : {})}
            inset="none"
            chevron={!!firstHref}
            className="dev-ws-foryou-row"
            data-ws-versions-suggestions={String(v.suggestions.length)}
            leading={<IconTile size="xs"><ArrowUpTrayIcon aria-hidden="true" /></IconTile>}
            title={t('project:hub.versions.suggestions.title')}
            subtitle={suggestions}
          />
        ) : null}
        {lately ? (
          <ListRow
            inset="none"
            chevron={false}
            className="dev-ws-foryou-row"
            data-ws-versions-lately={String(v.lately ? v.lately.changes : 0)}
            leading={<IconTile size="xs"><SparklesIcon aria-hidden="true" /></IconTile>}
            title={t('project:hub.versions.lately.title')}
            subtitle={lately}
          />
        ) : null}
        {last ? (
          <ListRow
            inset="none"
            chevron={false}
            className="dev-ws-foryou-row"
            data-ws-versions-last=""
            leading={<IconTile size="xs"><ArrowPathIcon aria-hidden="true" /></IconTile>}
            title={t('project:hub.versions.last.title')}
            subtitle={last}
          />
        ) : null}
      </div>
    </section>
  );
}
