/**
 * `#dc-view`'s children — the dev chat's screen.
 * See ./view-store.ts for what it absorbed and what stays legacy-owned.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { DevChatBanners } from './banners';
import { DevComposer } from './composer';
import { SessionHeader } from './session-header';
import { sessionHeaderStore } from './session-header-store';
import { SessionChecksPanel } from '../dev-board/modals/session-checks';
import { SessionList } from './session-list';
import { SpecViewer } from './spec-viewer';
import { DevChatTranscript } from './transcript';
import { OwnToolsGuide } from './own-tools-guide';
import { devViewStore, type DevViewState, type PaneView } from './view-store';

const HINT
  = 'mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20'
  + ' text-xs text-zinc-600 dark:text-zinc-300 shrink-0';

const HINT_TEXT
  = 'Describe the change you want. When it’s ready, promoting this'
  + " session's PR is what creates the proposal everyone votes on.";

/** The composer bar's two class runs, as complete literals for Tailwind. */
const BAR = {
  // Streamlined Concept: no `border-t` any more. The composer is a CARD that
  // floats on the pane's ground and carries its own elevation, so a rule
  // above it would draw a second edge across a shape that already has one.
  // The padding narrows with it — the card's own radius does the insetting
  // the old bar did with a full `p-2`.
  framed: 'shrink-0 platform-safe-bar px-3 pb-3 pt-1',
  bare: 'shrink-0 platform-safe-bar',
} as const;

/**
 * Every pane's `-open` string, likewise.
 *
 * The `off` values keep the trailing space the template produced —
 * `class="dc-spec-viewer ${open ? '…' : ''}"` — because this conversion's
 * contract is that the rendered attribute does not move. It is inert: the
 * parser splits a class attribute on whitespace.
 */
const PANE = {
  specResizer: { on: 'dc-spec-resizer dc-spec-resizer-open', off: 'dc-spec-resizer ' },
  specViewer: { on: 'dc-spec-viewer dc-spec-viewer-open', off: 'dc-spec-viewer ' },
  stagingResizer: { on: 'dc-staging-resizer dc-staging-resizer-open', off: 'dc-staging-resizer ' },
  stagingPanel: { on: 'dc-staging-panel dc-staging-panel-open', off: 'dc-staging-panel ' },
} as const;

/**
 * A pane's inline width, saved from a previous drag.
 *
 * Only emitted while the pane is OPEN, exactly as the template did: a closed
 * pane is `width: 0` in app.css and a stale inline width would fight it. CSS
 * clamps the value to a min/max, so a bad one cannot make the chat unusable.
 */
function paneStyle(p: PaneView): { width: string } | undefined {
  return p.open && p.width ? { width: `${p.width}px` } : undefined;
}

/** Keyed by session so switching chats clears results and collapse state. */
function ChecksSection({ sessionId }: { sessionId: number }): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label="Proposal checks" className="mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <button type="button" aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100"
        onClick={() => setOpen(!open)}>
        <span>Proposal checks</span><span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? <div className="max-h-[35dvh] overflow-y-auto overscroll-contain px-4 pb-4 sm:px-5 sm:pb-5">
        <SessionChecksPanel sessionId={sessionId} />
      </div> : null}
    </section>
  );
}

function DevSessionChecks(): ReactNode {
  const s = useStoreState(sessionHeaderStore);
  return s.sessionId && s.pr ? <ChecksSection key={s.sessionId} sessionId={s.sessionId} /> : null;
}

function WorkspaceView({ s }: { s: Extract<DevViewState, { kind: 'session' }> }): ReactNode {
  return (
    <>
      {/* #194: the one-shot "what a proposal is" hint, above everything. */}
      {s.proposalHint ? <div className={HINT}>{HINT_TEXT}</div> : null}
      {/* The ELEMENT keeps a CONSTANT className: `PlatformUI.attachScreenFx`
          writes a hairline/blur class onto it once the chat scrolls, and
          React never rewrites a className whose prop has not changed.

          THE THREE-LAYER LIFT (`dc-lift`, app.css). A running app shows the
          platform header's ground through the notches at its own two top
          corners (#app-frame-host: a 28px top radius, a hairline, a
          two-layer shadow). This screen repeats that move once per layer:
          the strip rounds ITS top corners over the wallpaper, and the
          session sheet below rounds ITS top corners over the strip. Each
          layer therefore reveals a shoulder of the one above it, which is
          what says the sheet is sitting ON the strip rather than abutting
          it — the same reading the app frame gives the header.

          This strip used to curve its BOTTOM corners away instead
          (`rounded-b-2xl`, #1588), matching the platform header. That was
          the second bar copying the first; it is the middle of three
          surfaces now, so it wears the same top radius the layers above
          and below it wear. app.css owns the geometry so all three read
          from one token — tests/dev-chat-view.test.js pins that this file
          asks for it by class rather than re-declaring a radius here.

          No `overflow-hidden`: the session sheet's shoulders are painted
          OUTSIDE its own arc (see `.dc-lift` in app.css), and clipping to
          the radius would erase exactly them. */}
      <div
        id="dc-session-header"
        className="flex items-center gap-2 px-3 py-2 shrink-0 dc-lift dc-lift-strip"
      >
        <SessionHeader embedded={s.embedded} />
      </div>
      {/* `display: contents` — #dc-view is a flex column and each banner has
          to stay exactly the flex child it was, rather than becoming a block
          child of a wrapper. */}
      <div id="dc-banners" className="contents"><DevChatBanners /></div>
      <div className="dc-session-body flex-1 flex min-h-0 dc-lift dc-lift-session">
        <div id="dc-tab-chat" className="dc-chat-pane flex-1 flex flex-col min-h-0">
          {s.returnHint && !s.embedded ? (
            <aside
              id="dc-return-hint" aria-label="Returning to dev chat"
              className="mx-3 mt-3 mb-1 flex flex-wrap items-center gap-3 rounded-xl bg-violet-500/10 p-3 text-sm text-zinc-700 dark:text-zinc-200 shrink-0"
            >
              <div className="flex-1 min-w-[12rem]">
                <p className="font-semibold">You can come back later</p>
                <p className="mt-1">
                  You can leave this page and return anytime. Open <strong>Improve</strong> in
                  the top bar to check your session’s status or find your chat again.
                </p>
              </div>
              <Button
                id="dc-return-hint-dismiss" type="button" size="sm" layout="shrink"
                variant="neutral" ink="muted" className="min-h-[44px]"
                onClick={() => window.DevChat?.dismissReturnHint()}
              >Got it</Button>
            </aside>
          ) : null}
          {/* #1348: the launchpad is PINNED TO THE TOP of the chat area. It
              stood in the composer's place at the bottom (#1281), which is
              where you look to type — but a launchpad is not a composer: it
              is the screen's subject, a walkthrough you work down while the
              transcript behind it is the reference. At the bottom the first
              step sat furthest from the eye and a long card pushed itself off
              the fold. Above the scroller it holds still while the transcript
              moves under it, and step 1 is the first thing on screen.

              It stays OUTSIDE #dc-messages on purpose: inside, it would
              scroll away with the transcript and stop being a launchpad. The
              slot collapses when empty (.dc-launchpad-slot:empty), so an
              ordinary session's chat pane is exactly what it was — which is
              why an empty `__html` is the right way to draw nothing here. */}
          {s.ownToolsGuide ? (
            <div id="dc-launchpad-slot" className="dc-launchpad-slot">
              <OwnToolsGuide view={s.ownToolsGuide} />
            </div>
          ) : (
            <div
              id="dc-launchpad-slot" className="dc-launchpad-slot"
              dangerouslySetInnerHTML={{ __html: s.launchpadHtml }}
            />
          )}
          {!s.change ? <DevSessionChecks /> : null}
          {/* The element carries the pane's scroll geometry and
              `initScrollTracking` binds click, keydown and scroll on it. */}
          <div id="dc-messages" className="dc-messages-container flex-1 overflow-y-auto py-2">
            <DevChatTranscript embedded={s.embedded} />
          </div>
          {/* platform-safe-bar (app.css): this block is the bottom of the
              screen on a phone, so it carries the home-indicator inset on top
              of its own p-2 — the strip below the Send row is part of this bar
              rather than dead space under it. */}
          <div id="dc-composer-bar" className={s.barEmpty ? BAR.bare : BAR.framed}>
            <DevComposer />
          </div>
        </div>
        <div
          id="dc-spec-resizer" className={s.spec.open ? PANE.specResizer.on : PANE.specResizer.off}
          role="separator" aria-orientation="vertical" aria-label="Resize spec viewer"
        ></div>
        {/* The pane's `width` is the DRAG's inline style and its `-open`
            class is this model's; the reader inside it is its own island,
            with its own store — see ./spec-viewer-store.ts. */}
        <div
          id="dc-spec-viewer" className={s.spec.open ? PANE.specViewer.on : PANE.specViewer.off}
          style={paneStyle(s.spec)}
        ><SpecViewer /></div>
        <div
          id="dc-staging-resizer"
          className={s.staging.open ? PANE.stagingResizer.on : PANE.stagingResizer.off}
          role="separator" aria-orientation="vertical" aria-label="Resize staging preview"
        ></div>
        {/* #771: a SLOT, not a container. The docked preview is an overlay
            positioned over this element's rect, so it stays empty. */}
        <div
          id="dc-staging-panel"
          className={s.staging.open ? PANE.stagingPanel.on : PANE.stagingPanel.off}
          style={paneStyle(s.staging)}
        ></div>
      </div>
    </>
  );
}

/** Session URLs are the workspace; Open card has its own topic destination. */
function SessionView({ s }: { s: Extract<DevViewState, { kind: 'session' }> }): ReactNode {
  useEffect(() => { window.DevChat?.restoreSessionScroll?.(); }, []);
  if (!s.change || s.embedded) return <WorkspaceView s={s} />;
  return <>
    <nav className="dev-change-tabs" aria-label="Change views">
      <button type="button" className="gc-vote-btn" onClick={() => (window as any).AppView?.openTopic('proposal', s.change!.item.id)}>Change overview</button>
      <span className="dev-topic-note">Agent workspace</span>
    </nav>
    <WorkspaceView s={s} />
  </>;
}

export function DevChatViewView({ s }: { s: DevViewState }): ReactNode {
  if (s.kind === 'none') {
    return (
      <div
        id="dc-session-list"
        className="divide-y divide-zinc-200 dark:divide-zinc-800 platform-safe-scroll"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        <SessionList />
      </div>
    );
  }
  return <SessionView key={s.change?.item.id} s={s} />;
}

export function DevChatView(): ReactNode {
  return <DevChatViewView s={useStoreState(devViewStore)} />;
}
