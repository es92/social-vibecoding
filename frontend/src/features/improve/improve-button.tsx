/**
 * #improve-btn — the header control that opens the Improve panel.
 *
 * It replaced three things at once: the App/Dev segmented switch, the feedback
 * bubble and the work cog. The switch is the one worth explaining, because this
 * button inherits its lifecycle exactly. That control was shown by
 * `App.ImproveStatus.setAppOpen()` and hidden everywhere else; this one is shown
 * whenever ../improve/improve-store.js carries a TARGET.
 *
 * TWO publishers put one there. `setAppOpen()` does it for an open app, and
 * `Home.publishImproveTarget()` does it for the platform's own self-hosted row
 * while home is on screen (#1367) — "improve Homeroom itself".
 *
 * That second one shipped once before and was reverted (#1363), which is worth
 * knowing before touching it: the first version re-targeted only on the RETURN paths,
 * so a cold boot at `/` never published anything and the button read as a
 * stale leftover of the app just closed. It publishes from `Home.render()`
 * now — the call every path funnels through — so the button is either there on
 * every home visit or on none.
 *
 * ── Why a labelled pill and not an icon ────────────────────────────────
 *
 * "improve" has no conventional glyph the way a bell or a hamburger does, so
 * it is a word. It was a plain violet text action for as long as it was
 * CONTEXTUAL — quiet on purpose, one of several things that could occupy the
 * slot. Now that it is the standing action on every screen, the board draws
 * it as the bar's one FILLED control, and a bare word beside two glyphs
 * reads as a caption rather than as the primary thing to do. Sized to the
 * header's 28px content row either way.
 *
 * ── What the button says while the panel is SHUT ───────────────────────
 *
 * One thing: `#feedback-queue-dot` (bottom-left, amber) came with the retired
 * feedback button, kept its id and its writer, and belongs here because this
 * button is the only way to reach the feedback dialog — an unsent draft with
 * no visible cue is the failure it exists to prevent.
 *
 * The other thing is `#improve-working-dot` (top-right, emerald, pulsing):
 * a dev session the viewer can see is mid-turn. That is the whole list.
 * #1412 also parked a green session COUNT and a version dot here; both are
 * retired. The version dot said in 8px of colour what the leading glyph
 * already says in shape, and the count moved to the bell in #1610 because
 * nothing behind this button could clear it — see <ImproveIndicators/>
 * below for both.
 *
 * ── The slot is NOT contextual any more ────────────────────────────────
 *
 * For a while this control swapped shape by route: the word on an app's
 * default screens, an EYE on the Dev screens, and an eye/pencil PAIR on a
 * session that had a staging preview. Improve turned out to be the action
 * people reach for most, and a control that both moves and disappears is a
 * bad one to make load-bearing — it was absent exactly on a session with no
 * preview yet, which is where describing a change is most likely. It renders
 * on every screen carrying a target now. The doing<->seeing loop it used to
 * displace lives in the session strip
 * (../dev-chat/session-header.tsx), beside the name of the change it acts
 * on.
 *
 * The dot's visibility rides the visibility store; nothing here may be
 * written by id from a classic module: this button is React-owned end to
 * end, and a pre-hydration `classList` write is a mismatch React patches
 * straight back out.
 */

import { useRef } from 'react';

import { ArrowPathIcon, LightBulbIcon, SpinnerArcIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/**
 * `h-7` matches the header's 28px content-row ceiling — the same constraint
 * the App/Dev switch was pinned to, and for the same reason: this is the only
 * thing that appears in the header when an app opens, so its height IS the
 * header's height there.
 */
// A FILLED accent pill, per the Streamlined Concept board's session bar
// (nodes 380:9672 and 380:9324 — the CHAT UI and APP PREVIEW frames).
//
// ── Read this before "restoring" the plain text action ─────────────────
//
// `git log -S "Improve is NOT a button"` finds a93c77f1, "Owner review round
// 2: drawer regrouped, Improve as plain text", which moved this run off
// exactly this fill and left a comment saying the owner had called it twice.
// That looks like this pill is a regression. It is not, and the reason is a
// date: THE BOARD IS NEWER THAN THAT REVIEW, confirmed by the owner — it is
// where the current toolbar concept comes from (Improve beside the bell and
// messages glyphs, with the title tab's dropdown opening the Apps sheet), and
// it draws Improve filled.
//
// The review is not wrong either, for the bar it was written about. At
// a93c77f1 the header's right group was the hamburger and this control, full
// stop — no bell, no chat bubble — and "the header stays quiet and the word
// carries it" is right for that bar. That bar no longer exists: the hamburger
// is retired, two glyphs stand where it was, and Improve became the standing
// action on every screen rather than a contextual one. A bare word among
// glyphs reads as their caption; the board's answer is the one filled control
// in the bar.
//
// `violet-600` is #0a6ee0 — the shell's accent is a BLUE, not a violet (see
// tailwind.config.js: the scale name is an identity, not a hue), which is
// exactly the blue the board draws.
//
// h-7 and no vertical padding are the header's 28px content-row ceiling,
// pinned by tests/header-height-parity.test.js — a filled pill keeps it by
// taking its height from `h-7` and its shape from `rounded-full`.
// No trailing margin. `mr-2.5` sat here from when this button had siblings to
// its right; as the LAST control in the bar it was 10px of dead space between
// Improve and the header's own px-4 edge, so the accent pill never actually
// reached the right margin the rest of the shell aligns to. The bell↔Improve
// gap is the right group's `gap-1` now — spacing belongs to the layout, not to
// the last child's margin (#1443).
// `gap-1.5` between the glyph and the word. There was NO gap: the icon and
// the "I" of Improve met, which reads as one smudged mark rather than as a
// state cue in front of a label — worst on the spinner, whose arc has no
// bounding whitespace of its own, and on the arrow-path, whose head reaches
// the glyph box's right edge. 6px is the gap the header's own right group
// uses between controls, so the pill's insides are spaced like the bar it
// sits in. It costs the pill 6px of width and nothing of height, so the
// header's 28px content row (tests/header-height-parity.test.js) is
// untouched.
const IMPROVE_BTN_CLASS =
  'relative inline-flex items-center gap-1.5 h-7 px-3 rounded-full '
  + 'bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold '
  + 'un-touch-target';

// The glyph on the button's leading edge, and the reason the button has one.
//
// "Improve" alone said what the control was FOR and nothing about whether
// anything was happening. The three states it can be in are all things the
// viewer wants at a glance, from a control that is on screen everywhere:
//
//   lightbulb — nothing in flight; the button is an invitation
//   spinner   — this app or the platform is building or downloading a build
//   refresh   — a new build is here, and the panel offers the reload
//
// `w-4 h-4` inside the 28px content row, so the header height contract
// (tests/header-height-parity.test.js) is untouched — no taller than the text
// beside it. `animate-spin` is the caller's, per the note on SpinnerArcIcon.
const BUSY_STATES = ['deploying', 'downloading'];
const READY_STATES = ['ready', 'failed'];

function ImproveGlyph({ versionState, appDeploying }: {
  versionState: string;
  appDeploying: boolean;
}) {
  const cls = 'w-4 h-4 shrink-0';
  if (appDeploying || BUSY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="busy" className="contents">
      <SpinnerArcIcon className={`${cls} animate-spin`} aria-hidden="true" />
    </span>;
  }
  if (READY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="ready" className="contents">
      <ArrowPathIcon className={cls} aria-hidden="true" />
    </span>;
  }
  return <span id="improve-btn-glyph" data-state="idle" className="contents">
    <LightBulbIcon className={cls} aria-hidden="true" />
  </span>;
}

/**
 * What is happening RIGHT NOW behind this button.
 *
 * #1412 built a count here — unread session-related notifications, split out
 * of the bell's number so the two would not double-count — on the grounds
 * that the sessions themselves are behind this button, so its badge sent you
 * somewhere the bell could not.
 *
 * #1610 took the count away, because nothing here could clear it. A session
 * notification is marked read by clicking its row in the bell's list, by a
 * group-chat mark-read, or by mark-all; opening this panel marks nothing. So
 * a finished session raised a number on the one control that could not
 * dismiss it, and the reporter did exactly what the number asked — pressed
 * Improve again, found no notification, and left the badge sitting there. The
 * count lives on the bell now, where the list that clears it lives.
 *
 * What is LEFT is the pulse, and the distinction is the point: a count is an
 * event waiting to be read, and belongs where reading happens; "a turn is
 * running right now" is a live fact about this button, true only while it is
 * true and needing no dismissal at all. It renders as a bare 8px emerald dot
 * with no text and no count.
 *
 * ── #improve-version-dot is GONE, and the glyph is why ─────────────────
 *
 * It was the third corner: amber while a build was deploying or downloading,
 * violet once one was here to reload onto. Every one of those states is
 * ALREADY the glyph on the other side of the label — `BUSY_STATES` draws the
 * spinner for exactly the amber pair and `READY_STATES` the arrow-path for
 * exactly the violet one, off the same `versionState`. So the dot said a
 * second time, in 8px of colour, what a 16px glyph was already saying in
 * shape; and two cues for one fact is worse than one, because a reader who
 * notices only the dot has to work out which of two colours it is.
 *
 * `Improve.setVersionState` and the store field are untouched — the glyph
 * reads them. What is gone is the second renderer.
 *
 * Two corners left, and the rule that separated them still holds: the outbox
 * dot is bottom-left and the working dot top-right, so an unsent draft and a
 * running turn cannot hide under each other. The outbox dot STAYS — it is the
 * one cue here the glyph does not cover, and an unsent feedback draft with
 * nothing to show for it is the failure it exists to prevent.
 *
 * At rest it ships `hidden` with exactly the class run the prerender emits,
 * the same shape as the outbox dot beside it — rendered rather than absent so
 * hydration matches and the id stays in the shell's declared inventory.
 */
const WORKING_DOT_CLS = 'absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-pulse';

function ImproveIndicators() {
  const { working } = useStoreState(improveStore);
  return (
    <span
      id="improve-working-dot"
      className={working ? WORKING_DOT_CLS : `hidden ${WORKING_DOT_CLS}`}
      aria-hidden="true"
    >
    </span>
  );
}

export function ImproveButton() {
  const { target, open, versionState, deploying } = useStoreState(improveStore);
  // "this app" is wrong on home, where the target is the platform itself
  // (#1367). The visible label stays the single word "Improve" at both — what
  // is being improved is named in the panel's own header.
  const label = target === 'platform' ? 'Improve the platform' : 'Improve this app';

  // #1054's outbox dot, moved off the retired feedback button. It ships hidden
  // and its writer publishes through the visibility store rather than toggling
  // the class by id, because a pre-hydration classList write is a mismatch
  // React patches back to the constant className.
  const dotRef = useRef<HTMLSpanElement>(null);
  useVisibilityHiddenClass(dotRef, 'feedback-queue-dot', false);

  // The button materially changes the header's right-group width, which is one
  // of the two inputs to the title's centered-vs-flow decision. The group's
  // ResizeObserver catches it a frame later on its own; this is the explicit
  // hook `App.ImproveStatus.setAppOpen()` used to call for the App/Dev switch,
  // so the title does not visibly jump.
  useIsomorphicLayoutEffect(() => {
    (window as unknown as { HeaderLayout?: { refresh?: () => void } })
      .HeaderLayout?.refresh?.();
    // `target` is the only input left: the control no longer swaps shape by
    // route, so the right group's width moves only when the word itself
    // appears or clears.
  }, [target]);


  // Improve renders on EVERY screen that has a target, Dev included.
  //
  // It used to be the contextual slot: a violet pill in the app's default
  // state, an EYE on the Dev screens, and on a session with a preview an
  // eye/pencil PAIR. That made the one control people reach for most a thing
  // that moved and sometimes vanished — and it vanished on exactly the
  // screens (a session with no preview yet) where wanting to describe a
  // change is most likely. So the slot stops being contextual: Improve is
  // always the header's right-hand action, next to the Messages and
  // Notifications glyphs, and the doing<->seeing loop it used to displace
  // moved down to the session strip, where the change it acts on is named
  // (see ../dev-chat/session-header.tsx).
  const pill = !!target;

  return (
    <button
      id="improve-btn"
      type="button"
      className={pill ? IMPROVE_BTN_CLASS : `hidden ${IMPROVE_BTN_CLASS}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      onClick={() => Improve.toggle()}
    >
      <ImproveGlyph versionState={versionState} appDeploying={deploying} />
      Improve
      {/* Bottom-LEFT, where it landed when #1412's green count took the
          top-right corner. That count is retired (#1610) and the working
          pulse holds the corner instead, so nothing needs to move. */}
      <span
        ref={dotRef}
        id="feedback-queue-dot"
        className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400"
      />
      <ImproveIndicators />
    </button>
  );
}
