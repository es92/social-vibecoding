/**
 * The two fixed section hosts, and the state that decides what is in them.
 *
 * There were three. Create app was the third, below Challenges; it is the
 * launcher grid's trailing tile now (../create-tile.tsx, the prototype's
 * scrHome), so its host, its view model and its block went together.
 *
 * ── Why the hosts are the components ──────────────────────────────────
 *
 * `HomePanels.render()` used to do three things to each host: assign its
 * `innerHTML`, toggle `hidden` on it, and MIRROR the block's own state
 * attributes up onto it (`_stampState`). That third one existed because a
 * selector written the way the spec, the dapp.json checks and the screenshot
 * assertions write it —
 * `[data-panel-slot="create"][data-create-enabled="true"]` — asks for both
 * attributes on ONE element, and the block that knows the value is a child of
 * the host that carries the slot name.
 *
 * Rendering the host from React collapses all three into props, and the mirror
 * stops being a second pass over markup somebody else wrote: the same view
 * model feeds the host's attribute and the block's.
 *
 * ── `hidden` and the prerender ────────────────────────────────────────
 *
 * The hand-written shell shipped these sections WITHOUT `hidden`, empty. They
 * still ship without it, holding a skeleton (#10, 19 Oct 2026: the empty
 * section was a heading that grew by a block when the data landed, moving
 * everything under it). That is what the prerendered document contains and
 * what the first client render has to agree with, so `hidden` waits for
 * `painted` — the flag that
 * separates "no render has happened yet" from "this render decided there is
 * nothing to show". Inferring it from a null block would put `hidden` on the
 * very first paint and mismatch hydration, which is a console error on #home
 * and a failed proposal check.
 */

import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { panelsStore, type HomePanelsState, type PanelStamps } from '../panels-store';
import { ChallengesPanel } from './challenges';
import { SectionHeading, SeeAllLink, stampProps } from './ui';

/**
 * One host. `slot` names WHICH block it is for — it rides along from the grid
 * cell each section replaces, and it is the hook everything outside the
 * feature already selects on.
 *
 * `label` is the area's name, drawn ABOVE the block (see `SectionHeading`).
 * This host is prerendered with its view null, and the first client render
 * has to agree with that document or hydration mismatches, which is a
 * console error on `#home` and a failed proposal check. So whatever the
 * heading draws BEFORE a view exists is a constant: Discover's label always
 * is, and Challenges' is "Challenges" with no link until its view arrives
 * (ChallengesSectionView below).
 *
 * The heading lives INSIDE the section, so a block with nothing to show takes
 * its label down with it rather than leaving a label over a gap.
 */
function Section({
  id, slot, label, action, painted, stamps, holdLabel = false, skeleton, children,
}: {
  id: string;
  slot: string;
  label: string;
  action?: ReactNode;
  painted: boolean;
  stamps?: PanelStamps;
  /** Draw the label's box but not its words until the first paint. */
  holdLabel?: boolean;
  /** What stands in for the block until the first paint. */
  skeleton: ReactNode;
  children: ReactNode;
}) {
  // PENDING until HomePanels' first paint (`painted`), which waits for both
  // /api/home-panels and /api/apps (HomePanels.readyToPaint). The prerender
  // is this state, so hydration matches. `home-section-pending` is what
  // app.css holds at the height this device last drew the section at
  // (../../../lib/first-paint-reserve.ts), and the skeleton's pulse is what the app's launch cover
  // waits to see gone (public/js/native-chrome.js, `shellPainted`).
  const pending = !painted;
  return (
    <section
      id={id}
      data-panel-slot={slot}
      className={pending ? 'home-section-pending px-3 pb-3' : children ? 'px-3 pb-3' : 'hidden px-3 pb-3'}
      {...stampProps(stamps)}
    >
      <SectionHeading action={action}>
        {pending && holdLabel ? <span className="invisible">{label}</span> : label}
      </SectionHeading>
      {pending ? skeleton : children}
    </section>
  );
}

/**
 * The skeleton, the shape of what usually arrives: three challenge cards (the
 * shared card is 104px, `gap-2.5` apart under a `pt-2`, as ./challenges.tsx
 * lays them out). A device that has drawn Home before holds each section at
 * the height it last drew instead (../../../lib/first-paint-reserve.ts and app.css), so these set
 * the shape only for a first visit. Decorative: the grid's skeleton already
 * says "Loading" to a screen reader once.
 */
const CHALLENGES_SKELETON = (
  <div className="home-panel-body pt-2 animate-pulse" aria-hidden="true">
    <div className="flex flex-col gap-2.5">
      <div className="h-[104px] rounded-3xl bg-zinc-200/70 dark:bg-zinc-800/70" />
      <div className="h-[104px] rounded-3xl bg-zinc-200/70 dark:bg-zinc-800/70" />
      <div className="h-[104px] rounded-3xl bg-zinc-200/70 dark:bg-zinc-800/70" />
    </div>
  </div>
);

/**
 * The sections as pure functions of the whole state, and the store-connected
 * components that are all `<Shell/>` mounts.
 *
 * The split exists for the same reason `WidgetStripBody` is split from
 * `WidgetStrip`: tests/home-panels-render.test.js runs `HomePanels.render()`
 * in a vm and then renders what it pushed, and a component that reads the
 * bundle's own store through a hook cannot be handed a sandbox's state.
 */
// No mirrored attributes: `data-rows` describes the block's COMPOSITION and
// is selected on the article itself, which is where the string renderer put
// it too.
//
// THE HEADING NAMES WHAT THE BLOCK HOLDS: "First challenges", "Next
// challenges", or "Challenges" over its one line (HomePanels.challengesView),
// with "See all" beside it in every mode but "No challenges right now".
//
// WHY THIS CANNOT MISMATCH HYDRATION. The heading element is the same static
// `h2.home-area-label` in every state; only its text and its link follow the
// view, and both fall back to the prerender's own values while there is no
// view: "Challenges", held invisible, and no link. The view is null in the
// prerender and stays null until HomePanels.render() pushes one after
// `/api/home-panels` and `/api/apps` answer, which is long after hydration,
// the same moment the cards under the heading appear. So the first client
// render draws exactly the document the shell ships, and the content-named
// heading is an ordinary update after it.
//
// THE WORDS ARE HELD, NOT GUESSED (#10). The loading state used to SAY
// "Challenges" and then switch to "Next challenges" or "First challenges"
// when the view landed, a word change in the middle of the first screen. The
// label keeps its box (so nothing moves) and shows no words until the view
// says which. (The counter that once rode here was dropped with the season
// progress; see ./challenges.tsx.)
export function ChallengesSectionView({ painted, challenges }: HomePanelsState) {
  const t = useMessages('home');
  return (
    <Section
      id="home-challenges-section"
      slot="challenges"
      label={challenges ? challenges.heading : t('home:challenges.heading')}
      action={challenges?.seeAll ? <SeeAllLink /> : null}
      painted={painted}
      holdLabel
      skeleton={CHALLENGES_SKELETON}
    >
      {challenges ? <ChallengesPanel view={challenges} /> : null}
    </Section>
  );
}

export function ChallengesSection() {
  return <ChallengesSectionView {...useStoreState(panelsStore)} />;
}
