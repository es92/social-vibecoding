/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── A FLAT COLUMN OF CARDS, and the card is the Challenges tab's ───────
 *
 * The ITERATION 03 board's Home screen draws this area straight on the page
 * ground: the season summary, the group headers, one card per challenge and
 * the footer, stacked in one column under the section heading. There is no
 * plate around them (`PanelShell plate="none"`, as Discover) and no rule
 * between them. The cards and the headers are surfaces of their own, so a
 * translucent plate behind them was a second frame, and its 0.625rem padding
 * pulled the whole block in from the heading's left edge.
 *
 * ONE RHYTHM: every band in the column is a 14px step from the one above it.
 * The heading ends on `pb-1.5`, so each band here opens on `pt-2` and closes
 * on `pb-1.5` (6px + 8px). Inside the rows list the cards, the headers and the
 * locked placeholder sit `gap-2.5` (10px) apart, the same step as the featured
 * apps rail (`.home-discover-rail` in app.css). Nothing is inset: the season line, the headers, the cards
 * and the footer all start where the heading's label starts.
 *
 * THE CARD IS SHARED. It is `ChallengeCard` from
 * features/leaderboard/challenge-card.tsx, the same component the Leaderboard
 * screen's Challenges tab draws, so a challenge reads the same state, words and
 * reward on both surfaces. This block used to draw its own: a tinted card, a
 * category word in the well ("ONBOARDI / NG" on a phone), and a pill with a
 * ○/✓ or a count capsule, the season deadline and a plain reward. Only the
 * root class `home-challenge-card` and `data-challenge-id` are this block's,
 * because the declared checks and the tests select on them.
 *
 * A CARD'S DEADLINE sits on the line under its title beside the reward ("5d
 * left · 500 pts"): the challenge's own end, else its event's, else the
 * season's. Only the First challenges open cards draw it; every other group's header
 * carries the clock instead (below).
 *
 * ── Group headers, without counts ─────────────────────────────────────
 *
 * The cards are the Challenges tab's list in the tab's order: grouped by the
 * board's categories (First challenges, This week, Always open, the season's other
 * challenges, and a finished First challenges group last). Expanded, the block draws
 * that whole list. Collapsed, its four slots go to the viewer's unfinished
 * challenges first (#2490), cutting a group mid-way when the cap falls inside
 * it; finished challenges only fill the slots that are left, and they sit
 * last under one "Done" header, so a finished card is never drawn above one
 * still to do. EVERY group opens with the tab's `GroupHeader`, one group on
 * screen included, static here: no toggle, no collapse and no count, because a
 * collapsed block does not draw the whole group. The header owns the clock
 * ("This week · 3d left", "Always open · no deadline") and the cards under it
 * drop theirs; the First challenges cards keep their own. The Done header carries no clock.
 * HomePanels.orderRows, HomePanels.visibleSlots and HomePanels.challengeGroups
 * decide all of it; the headers sit inside `.home-panel-rows` beside the
 * cards, which the declared checks select through, so nothing comes between
 * the season progress and the body. The Done header alone carries a class of
 * its own, `home-challenge-done-head`, which the #2490 check selects on.
 *
 * ── While Getting started gates the season ────────────────────────────
 *
 * Only a NEW account's season is gated (2026-10-01): until its Getting
 * started list (the tour and the First challenges) is done, the server sends
 * only the First challenges, plus how many it holds back and the first few of
 * their names. That list is the card on top of Home (../getting-started.tsx),
 * so this block does not draw it again: it draws ONE dashed locked card, "6
 * challenges unlock after Getting started", "Make a proposal, Invite a friend
 * and 4 more", and nothing else (`view.locked`). The card sits inside
 * `.home-panel-rows`, where the cards it stands in for would, but it is not a
 * `.home-challenge-card`: the declared checks and the tests count and select
 * real cards. Every existing member, and every account once its list is done,
 * gets the normal groups below.
 *
 * The unlock note is what is left of the old arrangement: a closed gate with
 * nothing hidden to count (a season of First challenges only) draws those
 * cards as before, with the note UNDER them, after `.home-panel-body`, which
 * keeps `.home-panel-season + .home-panel-body` adjacent: "Finish Getting
 * started to unlock the rest of the season." Once unlocked there is no note.
 *
 * ── The standings preview is GONE ─────────────────────────────────────
 *
 * A block of leaderboard rows used to sit under the challenges. It is
 * removed: this area is called Challenges, and a second list with its own
 * label inside one card made the reader work out which list they were looking
 * at before they could read either. The way to the Leaderboard screen is one
 * tap from here — "Open challenges" (#1916), in this section's own heading,
 * which renders in every branch including the between-seasons one and lands
 * on the screen's Challenges tab, one tab from the standings.
 *
 * It is the ONLY one. The footer used to repeat "Open challenges" at its right
 * end, one card below the heading's; that copy is gone, so the footer draws
 * only when its "See all N challenges" toggle has something to reveal.
 */

import { Fragment } from 'react';

import { ChallengeCard } from '../../leaderboard/challenge-card';
import { GroupHeader } from '../../leaderboard/group-header';
import { LockedChallengesCard } from '../../leaderboard/locked-challenges-card';
import { SeasonProgress } from '../../leaderboard/season-progress';
import type { ChallengeGroupView, ChallengesView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (view.locked) {
    // While Getting started gates the season: the one locked card, alone.
    // Inside `.home-panel-rows` like the cards it stands in for, so it keeps
    // their place and the column's rhythm, but it is not a
    // `.home-challenge-card` and `data-rows` stays 0: the declared checks and
    // the tests count real cards.
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="none" stamps={{ rows: 0 }}>
        <div className="home-panel-body pt-2">
          <div className="home-panel-rows flex flex-col gap-2.5">
            <LockedChallengesCard
              count={view.lockedCount ?? 0}
              names={view.lockedNames}
              className="home-challenge-locked"
            />
          </div>
        </div>
      </PanelShell>
    );
  }
  if (!view.rows.length) {
    // The line's hover is a text colour, not a tint: with no plate and no
    // inset a background would fill a square box starting at the first glyph,
    // and `.home-panel-body` clips overflow, so a negative-margin inset cannot
    // widen it past the text either.
    //
    // It opens something, so it is a real <button> (#1918, #2989): Tailwind's
    // preflight already strips a button's background, border, padding and
    // font, and `w-full text-left` keep the box and the glyphs where the <p>
    // put them. The accessible name starts with the visible text (so a voice
    // command that reads it still matches) and then says where it goes. The
    // focus ring is inset because `.home-panel-body` clips overflow.
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="none" stamps={{ rows: 0 }}>
        <div className="home-panel-body">
          <button
            type="button"
            className="home-panel-rows home-panel-row flex w-full items-center text-left text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500"
            title="Go to the Challenges tab on the Leaderboard screen"
            aria-label="No challenges are running right now. Go to the Challenges tab on the Leaderboard screen"
            onClick={() => panels()?.goToChallenges?.()}
          >
            No challenges are running right now
          </button>
        </div>
      </PanelShell>
    );
  }

  const groups: ChallengeGroupView[] = view.groups
    ?? [{ key: 'all', heading: null, meta: null, rows: view.rows }];
  const hasFooter = view.expandable !== false;
  // The locked card is the `view.locked` branch above, alone; here the note
  // is the only thing a closed gate adds.
  const hasNote = !!view.onboardingNote;

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      plate="none"
      stamps={{ rows: view.rows.length }}
      footer={hasFooter ? (
        <PanelFooter panelKey={view.key} total={view.total} expanded={view.expanded} />
      ) : null}
    >
      {view.season ? <SeasonProgress view={view.season} className="home-panel-season pt-2 pb-1.5" /> : null}
      {/* The body closes on `pb-1.5` only when a band follows it (the footer or
          the note), as the first half of their 14px step. A block that ends at
          its last card ends there, on the section's own bottom padding, as
          Discover does. */}
      <div className={hasFooter || hasNote ? 'home-panel-body pt-2 pb-1.5' : 'home-panel-body pt-2'}>
        <div className="home-panel-rows flex flex-col gap-2.5">
          {groups.map((g) => (
            <Fragment key={g.key}>
              {g.heading ? (
                <GroupHeader
                  heading={g.heading}
                  meta={g.meta}
                  className={g.key === 'done' ? 'home-challenge-done-head' : undefined}
                />
              ) : null}
              {g.rows.map((row) => (
                <ChallengeCard
                  key={row.id}
                  view={row}
                  className="home-challenge-card"
                  data-challenge-id={row.id}
                  onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      {/* #1915 kept this line off its neighbours. It still is, by the column's
          one rhythm (`pt-2 pb-1.5`, see the header) rather than by a padding
          of its own against a hairline that is gone. It follows the cards. */}
      {hasNote ? (
        <p className="pt-2 pb-1.5 text-sm text-zinc-500 dark:text-zinc-400" role="status">
          {view.onboardingNote}
        </p>
      ) : null}
    </PanelShell>
  );
}
