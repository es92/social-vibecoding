/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── A PLATE OF CARDS, and the card is the Challenges tab's ─────────────
 *
 * One card per challenge on a translucent plate that holds them and the season
 * summary together (`.home-challenges-plate` in app.css): at 55% the grouping
 * reads and the wallpaper's washes carry on through.
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
 * THE DEADLINE IS ON EVERY OPEN CARD, on the line under its title beside the
 * reward ("5d left · 500 pts"): the challenge's own end, else its event's,
 * else the season's. The ring says the season's only when no card on screen
 * shows one. It stays on the cards until deadline bands group the challenges
 * by when they end; then the band heading says it.
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
 */

import { ProgressRing } from '@/components/ui/progress-ring';
import { ChallengeCard } from '../../leaderboard/challenge-card';
import type { ChallengesView, SeasonView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

/**
 * The ring and the season's two numbers, at the top of the plate.
 *
 * It replaces the "· 1 of 6 · 3,900 pts left" that rode the section heading,
 * where at 12px after the area's name and its link it pushed the label into
 * an ellipsis on a phone. As a ring it is content: the first thing on the
 * plate, stating the one fact the block exists to state.
 *
 * The ring itself is `@/components/ui/progress-ring` — the geometry, the
 * twelve-o'clock start and the zero case all live there, because it is a
 * shape of the language rather than of this block, and because a raw SVG
 * element under `features/**` is a glyph that escaped icons.tsx as far as
 * tests/shell-icon-set.test.js is concerned; that scanner is a plain search
 * for the opening tag, comments included, so this sentence spells the tag out
 * in words rather than tripping the rule it is describing.
 *
 * NO PLATE OF ITS OWN. It sits directly on the block's plate rather than in a
 * card, so the four tinted cards below are the only card-shaped things here
 * and the summary reads as their caption.
 */
function SeasonRing({ view }: { view: SeasonView }) {
  return (
    <div className="home-panel-season flex items-center gap-2.5 px-1 pb-2.5 pt-0.5">
      <ProgressRing pct={view.pct} label={view.fraction} title={view.label} />
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
          {view.lead}
        </div>
        {view.sub ? (
          <div className="truncate whitespace-nowrap text-[12.5px] leading-tight text-zinc-500 dark:text-zinc-400">
            {view.sub}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (!view.rows.length) {
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="soft" stamps={{ rows: 0 }}>
        <div className="home-panel-body">
          <p
            className="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
            title="Go to the Challenges tab on the Leaderboard screen"
            onClick={() => panels()?.goToChallenges?.()}
          >
            No challenges are running right now
          </p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      plate="soft"
      stamps={{ rows: view.rows.length }}
      footer={(
        <PanelFooter
          panelKey={view.key}
          total={view.total}
          expanded={view.expanded}
          expandable={view.expandable !== false}
        />
      )}
    >
      {view.season ? <SeasonRing view={view.season} /> : null}
      {/* #1915: padded on BOTH sides. With `pb-3` alone the line sat flush
          against the season ring's bottom hairline above it. */}
      {view.onboardingNote ? (
        <p className="px-1 py-3 text-sm text-zinc-500 dark:text-zinc-400" role="status">
          {view.onboardingNote}
        </p>
      ) : null}
      <div className="home-panel-body">
        <div className="home-panel-rows flex flex-col gap-2">
          {view.rows.map((row) => (
            <ChallengeCard
              key={row.id}
              view={row}
              className="home-challenge-card"
              data-challenge-id={row.id}
              onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
            />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}
