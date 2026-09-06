/**
 * #improve-panel — the one surface for everything you can do *to* the thing on
 * screen, rather than *with* it.
 *
 * It replaced the header's App/Dev segmented switch. An app is now just an app;
 * "Improve" is the second half. That reframing is what let three header icons
 * (the switch, the feedback bubble, the work cog) collapse into one button, and
 * it is why the rows below span what used to be four different places — the
 * feedback dialog, the Dev "+" menu, the cog drawer's session list and the
 * hamburger's Share row.
 *
 * ── A fully React-owned island ─────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes a node inside this subtree, so under
 * AGENTS.md's stateful-island rule the whole thing may hold state — and it
 * does, through ./improve-store.js. The classic scripts publish what the panel
 * is about via `window.Improve` (./improve-controller.js) and never touch the
 * DOM here.
 *
 * Two nodes are still handled the careful way, because the native kit writes
 * classes to the panel root at runtime (`platform-sheet-adopted`):
 * `#improve-panel`'s `className` is a CONSTANT prop rendered once, and the only
 * thing that varies on it is `data-open`, an attribute the kit never touches.
 *
 * ── Desktop side panel, mobile bottom sheet ────────────────────────────
 *
 * Both idioms come out of one element. The panel is always mounted and
 * translated off-screen; `data-open` slides it in. `public/css/app.css` draws it
 * from the RIGHT EDGE at `sm` and up and from the BOTTOM below it, so the
 * requirement holds even in a mobile browser with no native kit loaded. On touch
 * WITH the kit, `adoptKitSurface` presents this element as a real kit sheet with
 * its own drag-to-dismiss and `.platform-sheet-adopted` neutralises the fixed
 * chrome — the same contract the work drawer runs under.
 *
 * ── The surface is the shell's pane, not a panel of its own ────────────
 *
 * `.dc-lift dc-lift-panel`, which is what the notifications rail and the app
 * chip's menu wear too. It replaced `bg-white dark:bg-zinc-900` with a zinc
 * hairline and Tailwind's `shadow-2xl` — the pre-lift look, which left this
 * rail and the bell's rail sitting side by side in the same corner of the
 * screen as two different objects. The lift supplies fill, hairline and
 * shadow, so there is nothing here to keep in step by hand.
 *
 * The fill is frosted glass, and the modal dim is one of the shadow layers
 * rather than a paint on #improve-overlay — an outer shadow cannot reach the
 * element's own backdrop-filter, which is what lets the panel frost an
 * UNDIMMED page while darkening everything around it. app.css's
 * `.dc-lift-panel` block carries the measurements.
 *
 * The one thing this file states rather than inherits is the SHAPE, in
 * app.css: `.dc-lift` rounds the two corners of a sheet docked to the floor,
 * and this is docked to the right, so at `sm`+ only the top-left is rounded.
 * Below `sm` it is a floor-docked bottom sheet and takes both.
 *
 * ── First render is the prerender ──────────────────────────────────────
 *
 * The store's initial value is the closed, empty, target-less panel, so the SSG
 * pass in frontend/scripts/build-shell.mjs emits exactly what hydration
 * produces. Sessions load from `Improve.open()`, never from render.
 */

import { useCallback, type ReactNode } from 'react';

import {
  ArrowPathIcon,
  GitHubIcon,
  ShareIcon,
  SpinnerArcIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';
import { SessionRow } from './session-row';
import { AppViewTabs, IMPROVE_VIEW_IDS } from './view-tabs';

/** Close the panel before whatever the row does next. */
function dismissForNav(): void {
  Improve.dismissForNav();
}

// Sentence case, not uppercase: the board's own labels read "Changes in
// progress", and the app name above them is the app's name as written.
const SECTION_LABEL_CLASS =
  'px-4 pt-2.5 pb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400';

/**
 * THE GROUP the change rows sit in — the widget language's grouped list
 * (@/components/ui/grouped-list), which is how every other list of RECORDS in
 * the deck is drawn: a label, then a card of hairline-separated rows.
 *
 * A hairline border rather than that component's figure/ground card, and the
 * difference is the surface, not a preference. `GroupedList` is a white card
 * floating on the page's grey ground; this panel is already a light surface
 * in its own right, so the same card here would be an invisible rectangle. The border is what states the same
 * thing on a surface that cannot use contrast to state it.
 *
 * The point of it is what it stops the rows being mistaken for. Below this
 * list sit the footer's action rows — "View on GitHub", "Share app" — and
 * edge-to-edge rows in a panel of edge-to-edge rows all read as one menu. A
 * bordered group says these four are a SET, and a different kind of thing from
 * the entries under them.
 */
const GROUP_CLASS =
  'mx-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 '
  + '[&>a+a]:border-t [&>a+a]:border-zinc-200 dark:[&>a+a]:border-zinc-800';

const ROW_BASE =
  'w-full flex items-center gap-3 px-4 min-h-[44px] text-left';
const ROW_REST =
  ' text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800';

/**
 * One of the panel's two lead actions, as its own button.
 *
 * ── Why they are not a divided well any more ───────────────────────────
 *
 * Feedback, New change and Share shipped as three equal thirds of one recessed
 * group with hairline dividers, on the argument that they are peers and a
 * group says so in half the height. Two things undid it. Share left (it is a
 * fact about the app, so it sits with "View on GitHub" in the footer), and a
 * divided well of two is not a group, it is a control with a seam down the
 * middle. And the well read as ONE control with segments — the thing it looks
 * like elsewhere in this bundle is the view strip directly below it, which IS
 * a segmented control, so the panel opened with two identical shapes meaning
 * two different kinds of thing.
 *
 * So they are buttons, shaped like the control that opens this panel:
 * `h-9 rounded-full`, the same pill #improve-btn is.
 *
 * ── They are the SAME button, and it is the FILLED one ─────────────────
 *
 * Neither is more special than the other: describing a problem and starting a
 * change are two ways into the same work, and which one a person wants is
 * about what they have to say, not about which the panel prefers. So they
 * match — that part has not changed.
 *
 * WHICH of the two shared states they match in has. They spent a round in
 * `bg-violet-500/10`, a 10% tint, chosen because a solid pill put a second
 * filled violet control under #improve-btn's own and read as an accent
 * competing with the button that opened it. In use the tint went the other
 * way: at a tenth opacity these are the palest things in a panel whose every
 * other row is a real surface, and the two controls the panel EXISTS for read
 * as the least pressable things in it — closer to a disabled state than to an
 * action.
 *
 * `bg-violet-600` is the fill "New change" carried before that round, and it
 * is the platform's ordinary primary button. The competing-accent worry is
 * real and it is the smaller cost: #improve-btn is in the HEADER, outside the
 * panel and behind its backdrop once the panel is up, so the two are rarely
 * read together — whereas these two are read every single time it opens.
 *
 * Every id is the one it has always had: `#improve-row-feedback` is what the
 * outbox dot's writer selects and `#improve-row-new-session` has named
 * Improve.startSession() since this panel existed.
 */
const ACTION_BASE =
  'inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-9 px-3 '
  + 'rounded-full text-sm font-semibold transition-colors un-touch-target';

const ACTION_FILL =
  'bg-violet-600 hover:bg-violet-500 text-white';

function QuickAction({ id, label, onClick }: {
  id: string;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      className={ACTION_BASE + ' ' + ACTION_FILL}
    >
      <span className="min-w-0 truncate">
        {label}
      </span>
    </button>
  );
}

/**
 * A reference row in the footer: a glyph, a label, and an optional value.
 *
 * Restored with the footer (#1443). The one caller that needs `external` is
 * the GitHub link, which is the only thing in this panel that leaves the app
 * — hence target=_blank, and hence NOT a hash route the sheet controller
 * would want to dismiss for.
 */
/**
 * What is happening to the build, in the panel that offers to change it.
 *
 * Three states, and each is a different kind of thing to say:
 *
 *   - BUILDING. A note, not an offer. Either this app is deploying a merged
 *     change or the platform is rolling one out; there is nothing to press,
 *     so pressing is not offered.
 *   - READY. The one case with an action: the new build is downloaded and a
 *     reload will land on it. `failed` gets the same button with a warier
 *     line, because a reload that might need two tries still beats a tab with
 *     no way forward.
 *   - IDLE. Nothing. A row saying "up to date" is a row that is right almost
 *     always and therefore never read.
 *
 * `versionState` is the platform's, published from
 * App.renderPlatformVersionPill; `deploying` is this app's own. They are
 * separate facts with one presentation here, because "something is being
 * built" is what the viewer is asking, and which of the two it is shows in
 * the wording.
 */
function UpdateStatus(): ReactNode {
  const { versionState, deploying } = useStoreState(improveStore);
  const platformBusy = versionState === 'deploying' || versionState === 'downloading';
  const ready = versionState === 'ready' || versionState === 'failed';

  if (ready) {
    return (
      <button
        id="improve-update-ready"
        type="button"
        className={'flex w-full items-center gap-3 px-4 py-3 text-left '
          + 'text-sm font-medium text-violet-600 dark:text-violet-400 '
          + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 un-touch-target'}
        onClick={() => window.location.reload()}
      >
        <ArrowPathIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          There is a new version available. Click here to get the new version.
        </span>
      </button>
    );
  }

  if (platformBusy || deploying) {
    // Which one is building decides the wording. Both at once is possible and
    // says the more surprising of the two.
    const line = platformBusy
      ? (versionState === 'downloading'
        ? 'A new version of the platform is downloading. The reload appears once it is ready.'
        : 'A new version of the platform is being built.')
      : 'A new version of this app is being built.';
    return (
      <div
        id="improve-update-note"
        className="flex items-center gap-3 px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <SpinnerArcIcon className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 flex-1">{line}</span>
      </div>
    );
  }

  return null;
}

function ImproveRow({
  id,
  icon,
  label,
  detail,
  onClick,
  href,
  external,
}: {
  id?: string;
  icon: ReactNode;
  label: string;
  detail?: ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}): ReactNode {
  const body = (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {detail}
    </>
  );
  if (href) {
    return (
      <a
        id={id}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className={ROW_BASE + ROW_REST}
        onClick={() => Improve.dismissForNav()}
      >
        {body}
      </a>
    );
  }
  return (
    <button id={id} type="button" className={ROW_BASE + ROW_REST} onClick={onClick}>
      {body}
    </button>
  );
}

export function ImprovePanel() {
  const state = useStoreState(improveStore);
  const {
    open, adopted, target, name, slug, selfHosted, sessions, otherSessions,
  } = state;

  const close = useCallback(() => Improve.close(), []);

  // "Nothing anywhere", which is a different state from "nothing on this app"
  // — and the only one that has spare vertical space to spend.
  const nothingRunning = state.sessionsLoaded
    && sessions.length === 0 && otherSessions.length === 0;

  // Everything below renders unconditionally — the panel is always mounted and
  // slid off-screen, never unmounted — so a closed panel is inert markup rather
  // than a tree React has to rebuild on every open.
  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop dims the scene (and fades with its spring), so
          raising this one too both over-dimmed and, on close, held the dim at
          full strength until the teardown — the background snapped clear
          instead of fading with the slide. */}
      <div
        id="improve-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40"
        onClick={close}
      >
      </div>
      {/* "this app" is wrong on home, where the target is the platform itself
          (#1367), so the label follows the target rather than assuming one.
          #improve-target-name inside the header spells out which app. */}
      <div
        id="improve-panel"
        role="dialog"
        aria-label={target === 'platform' ? 'Improve the platform' : 'Improve this app'}
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col dc-lift dc-lift-panel improve-panel-transition"
      >
        {/*
            ONE LINE. It was a stacked title-over-subtitle pair with `py-3`,
            which spent about seventy points saying two words. "Improve" and
            the app's name are the same fact read at two altitudes, so they sit
            on one baseline with the name muted after it — and the sheet starts
            where its content starts.

            The name keeps its id and its job: on the home screen the target is
            the platform itself, and this is the only cue that says "Improve"
            there means Social Vibecoding rather than an app.
        */}
        <div className="flex items-center gap-2 px-4 py-2 shrink-0">
          <h2 className="shrink-0 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Improve
          </h2>
          <p
            id="improve-target-name"
            className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400"
          >
            {name}
          </p>
          <button
            id="improve-close"
            type="button"
            className="shrink-0 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 un-touch-target dark:text-zinc-400"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/*
            A COLUMN FLEX with EXACTLY ONE SCROLLER in it. The quick actions
            and the view rows are `shrink-0`; #improve-sessions is
            `flex-1 min-h-0 overflow-y-auto`. That is the whole layout rule,
            and it gives both idioms their behaviour for free: a full-height
            desktop side panel scrolls its list inside a fixed column, and a
            mobile bottom sheet is content-sized until it reaches its cap and
            then scrolls the same list — which is what the board draws.
            No measurement, no fold, nothing pushed past the bottom.
        */}
        <div
          id="improve-body"
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          {/*
              ── Zone 1: the two actions ────────────────────────────────

              Feedback and New change, as two BUTTONS — see the note on
              QuickAction above for why the divided well of three retired.
              "Give feedback", not "Feedback": both of these are things you DO,
              and a bare noun beside the verb phrase "New change" read as a
              category label sitting next to an action. The two labels are the
              same part of speech now. It still leads, because it is the one
              action that needs nothing of the viewer — no collaborator bit, no
              session, no repo. Both carry the same fill; see QuickAction.

              Share was the third segment and is not here any more: it is a
              fact ABOUT the app rather than something you do to it, so it
              sits with "View on GitHub" in the footer, which is where the
              app's other outward-facing facts already are. It keeps its
              `#improve-row-share` id and its `canShare` gate.

              The two ids that stayed keep their meaning:
              `#improve-row-feedback` is what the outbox dot's writer selects,
              and `#improve-row-new-session` has named Improve.startSession()
              since this panel existed. The drawer's own
              `#app-context-new-change` retires INTO the second — two ids
              calling one method was the duplication the merge removed.
          */}
          <div
            id="improve-quick-actions"
            className="shrink-0 flex items-stretch gap-2 px-4 pt-1 pb-2"
          >
            <QuickAction
              id="improve-row-feedback"
              label="Give feedback"
              onClick={() => Improve.giveFeedback()}
            />
            {state.readOnly ? null : (
              <QuickAction
                id="improve-row-new-session"
                label="New change"
                onClick={() => Improve.startSession()}
              />
            )}
          </div>

          {/*
              ── Zone 2: the app's three views ──────────────────────────

              ONE segmented control, not three rows and a sub-strip. See
              ./view-tabs.tsx for why the Kanban|Feed pair underneath Board
              retired into it: those two WERE Board and Activity, so the
              hierarchy was a choice between three things drawn as four
              controls on two levels.

              #1443 moved these to the chip's menu on the argument that they
              are destinations and destinations belong there, then moved them
              back. Both surfaces carry the strip now, which is the answer
              that argument was reaching for: the menu answers "which app",
              this answers "which part of it", and either is a fair place to
              ask the second question.

              `mx-4 mb-2` and not a wrapper: #improve-views is a DIRECT child
              of #improve-body, which is the band order dapp.json's declared
              check selects on.
          */}
          <AppViewTabs
            ids={IMPROVE_VIEW_IDS}
            onNavigate={dismissForNav}
            className="mx-4 mb-2"
          />

          {/*
              ── Zone 3: the work in flight, and the only scroller ──────

              THE ONE SCROLLER in this panel, which is what lets the two zones
              above stay on screen at any viewport: they are `shrink-0`, this
              is `flex-1 min-h-0 overflow-y-auto`. On the desktop side panel
              that means the list scrolls inside a full-height column; on the
              mobile sheet the panel is content-sized until it hits its cap
              and then this scrolls, which is the bottom-sheet behaviour the
              board draws.
          */}
          <div
            id="improve-sessions"
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {/* THE HEADING ONLY EARNS ITS LINE WHEN THERE IS A LIST UNDER IT.
                A section label over an empty section is a label describing
                nothing, and it was the reason the empty state read as
                squeezed: two cramped lines in the rhythm a full list needs. */}
            {nothingRunning ? null : (
              <div className={SECTION_LABEL_CLASS}>
                Changes in progress
              </div>
            )}
            {state.loadingSessions && !state.sessionsLoaded ? (
              <div className="px-4 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
                Loading…
              </div>
            ) : null}
            {sessions.length ? (
              <div className={GROUP_CLASS}>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.key}
                    session={session}
                    showApp={false}
                    onNavigate={dismissForNav}
                  />
                ))}
              </div>
            ) : null}
            {/*
                NOTHING RUNNING ANYWHERE — the one state with room to spare, so
                it gets some. Everything else in this panel is tuned for a
                contested column; here the list is the thing that is absent,
                and a centred block with real air says "nothing is running"
                far better than a muted fragment tucked under a heading.

                `text-sm`, not the `text-xs` the metadata around it uses: this
                is the only prose on the surface, and prose has a floor.
            */}
            {nothingRunning ? (
              <div id="improve-sessions-empty" className="px-6 py-9 text-center">
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  No changes in progress.
                </p>
                <p className="mt-1 text-sm text-zinc-500 text-pretty dark:text-zinc-400">
                  Start one with New change, or send feedback and let someone
                  else pick it up.
                </p>
              </div>
            ) : null}
            {/* This app is quiet but another is not: the space is contested
                again, so the note goes back to one muted line. */}
            {state.sessionsLoaded && sessions.length === 0 && otherSessions.length > 0 ? (
              <div className="px-4 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
                Nothing running on this app.
              </div>
            ) : null}

            {/* The overflow area: changes running on the viewer's OTHER apps —
                the board's own second section, and the reason its sticky calls
                this surface "not focused on a selected app". */}
            {otherSessions.length > 0 ? (
              <>
                <div className={SECTION_LABEL_CLASS}>
                  Changes in other apps
                </div>
                <div className={GROUP_CLASS}>
                  {otherSessions.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      showApp={true}
                      onNavigate={dismissForNav}
                    />
                  ))}
                </div>
              </>
            ) : null}

            {state.showTerminal ? (
              <button
                id="improve-row-terminal"
                type="button"
                className={ROW_BASE + ROW_REST + ' mt-2'}
                onClick={() => Improve.openTerminal()}
              >
                <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
                  <TerminalIcon />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  Developer terminal
                </span>
              </button>
            ) : null}
          </div>

          {/*
              ── Zone 4: what is happening to this app ──────────────────

              THE VERSIONS ARE IN SETTINGS. This footer used to carry all
              three of them — the app's merged main, the platform's deployed
              commit, the installed mobile release. They moved to Settings'
              About block, came back here in #1443 on the argument that you
              are INSIDE the app when this panel is open and should not have
              to leave it to read them, and have gone back to Settings now
              that this footer answers the question those rows were actually
              being read for.

              That question was never "which SHA". Nobody opens this panel to
              compare commit hashes; they open it because something looked
              like it was happening, or because the app told them a new build
              existed. Three static rows answered that only by implication —
              you had to notice that one of them had turned into a spinner.
              So the footer states it instead, and the raw revisions go back
              to the screen you consult rather than the one you act from.

              Nothing is lost by the move: the state is published by
              App.renderPlatformVersionPill (see App.platformUpdateState), not
              inferred from whatever is rendered here, so this block and the
              Settings rows are two readers of one fact rather than one
              reading the other.
          */}
          {/*
              NO `pt-2`. The hairline is the footer's top edge and the rows
              below it are `min-h-[44px] items-center`, so each row already
              centres its own glyph with ~12px of clear air either side. The
              8px of padding on top of that put "View on GitHub" 20px below the
              rule and 12px above whatever came next — the row read as sitting
              low in its own band rather than centred in it. Spacing inside the
              footer is the ROW's, once, not the row's plus the container's.
          */}
          <div
            id="improve-footer"
            className="shrink-0 border-t border-zinc-100 dark:border-zinc-800 platform-safe-scroll"
          >
            {state.repoUrl ? (
              <ImproveRow
                id="improve-row-github"
                icon={<GitHubIcon className="w-5 h-5 shrink-0" />}
                label="View on GitHub"
                href={state.repoUrl}
                external={true}
              />
            ) : null}
            {/* Share, next to the repository link, because the two are the
                same KIND of thing: the app as something you point other people
                at. It was the third segment of the action well at the top,
                where it sat among things you do TO the app — and it is
                conditional (`canShare` is false for an app that is still
                creating, errored, or waiting on its secrets), so it was also
                the one segment that could leave a three-up control drawn as
                two. Same id, same gate, same dialog. */}
            {state.canShare ? (
              <ImproveRow
                id="improve-row-share"
                icon={<ShareIcon className="w-5 h-5 shrink-0" />}
                label="Share app"
                onClick={() => Improve.share()}
              />
            ) : null}
            <UpdateStatus />
          </div>
        </div>
      </div>
    </>
  );
}
