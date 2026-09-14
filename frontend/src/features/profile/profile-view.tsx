/**
 * The contents of `#profile-root` (#1191 slice 6, conversion 1).
 *
 * Thin by construction: every branch below reads a field off the view
 * ./profile-store.js derives, and holds no opinion of its own about what the
 * screen should say. That split is what keeps the root `node --test` suite able
 * to assert on this screen's behaviour — it has no JSX transform, so a decision
 * expressed in this file would be a decision no test could reach.
 *
 * The initial store state is `open: false`, whose view is `kind: 'empty'` and
 * renders nothing at all. That is the empty `#profile-root` the hand-written
 * shell shipped, so the prerender pass emits it and hydration matches. Data
 * arrives only from ./profile.js's effects, never from a render.
 */

import { type ReactNode } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { useStoreState } from '../../lib/use-store-state';
import {
  buildProfileView,
  publicAvatarView,
  profileStore,
} from './profile-store.js';
import { Profile } from './profile.js';
import { AccountPanel } from './account-panel';
import { ProfileEditSheet } from './profile-edit-sheet';
import { PublicProfileCard } from './public-profile-card';

/** The round picture, or the initial-in-a-circle fallback — the idiom the rest
 *  of the app already uses for people. */
function IdentityAvatar({ url, initial }: { url: string | null; initial: string }): ReactNode {
  if (url) {
    return (
      <img
        className="w-20 h-20 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={url}
        alt=""
      />
    );
  }
  return (
    <div
      className={
        'w-20 h-20 text-2xl rounded-full shrink-0 flex items-center justify-center '
        + 'font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/** Identity card (#982) — who this profile belongs to, and the way in to
 *  editing it. Sits above the score header so the screen leads with the person
 *  rather than the number. */
function IdentityCard({ identity }: { identity: any }): ReactNode {
  return (
    <div
      id="profile-identity-card"
      className="rounded-2xl bg-white dark:bg-zinc-900 p-4 mb-5"
    >
      <div className="flex items-center gap-4">
        <IdentityAvatar url={identity.avatarUrl} initial={identity.initial} />
        <div className="flex-1 min-w-0">
          <div className="text-xl font-bold truncate">{identity.name}</div>
          {identity.handle ? (
            <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
              {identity.handle}
            </div>
          ) : null}
        </div>
        <Button
          id="profile-edit-btn"
          layout="shrink"
          variant="neutral"
          size="sm"
          ink="neutral"
          onClick={() => Profile.showEditSheet()}
        >
          Edit profile
        </Button>
      </div>
      {/*
          The bio is deliberately plain text, not markdown: React renders it as
          a text child, which is the whole safety story — no HTML string is ever
          built for it, here or anywhere.
      */}
      {identity.bio ? (
        /*
            `break-words` is load-bearing (#1612): a bio is free text, so it can
            be one 280-character word or a pasted URL with no space in it, and
            `whitespace-pre-line` alone leaves that on a single line — it spills
            past the card and gives the whole screen a horizontal scrollbar.
            `overflow-wrap: break-word` breaks such a run only when it would not
            otherwise fit, so ordinary prose still wraps at spaces and nothing
            else about the card changes.
        */
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-3 whitespace-pre-line break-words">
          {identity.bio}
        </p>
      ) : null}
      {identity.chips.length ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {identity.chips.map((chip: any) => (
            <a
              key={chip.key}
              className={chip.className}
              href={chip.href}
              {...(chip.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {chip.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The owner's own controls for the opt-in public profile (#582). */
function PublicControls({ controls, status, publishing, previewOpen }: {
  controls: any;
  status: string;
  publishing: boolean;
  previewOpen: boolean;
}): ReactNode {
  return (
    <section
      id="public-profile-controls"
      className="rounded-2xl bg-white dark:bg-zinc-900 p-4 mb-5"
    >
      <h2 className="font-semibold text-base">Public profile</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
        Private by default. The public page includes only your username,
        display name, bio and Homeroom-hosted photo, not social links, wallet,
        email, roles, memberships or private activity.
      </p>
      <div className={`mt-3 text-sm font-medium ${controls.visibilityClass}`}>
        {controls.visibility}
      </div>
      {controls.moderationDisabled ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400">
          You can keep editing or unpublish, but the public page remains unavailable.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 mt-3">
        <Button
          type="button"
          layout="tap"
          variant="tapPrimary"
          size="none"
          ink="solidText"
          className="disabled:opacity-60"
          disabled={publishing}
          onClick={() => { void Profile._setPublished(!controls.published); }}
        >
          {controls.publishLabel}
        </Button>
        <Button
          type="button"
          layout="tap"
          variant="neutral"
          size="none"
          ink="neutral"
          className="text-sm font-medium"
          onClick={() => Profile.togglePreview()}
        >
          {previewOpen ? 'Hide preview' : 'Preview'}
        </Button>
        <a
          className={`${buttonVariants({ layout: 'tap', variant: 'neutral', size: 'none', ink: 'neutral' })} inline-flex items-center text-sm font-medium`}
          href={controls.openHref}
        >
          Open public page
        </a>
        <Button
          type="button"
          layout="tap"
          variant="neutral"
          size="none"
          ink="neutral"
          className="text-sm font-medium"
          onClick={() => { void Profile.copyPublicLink(controls.openHref); }}
        >
          Copy public link
        </Button>
      </div>
      <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400" role="status" aria-live="polite">{status}</div>
      <div id="public-profile-preview" className={previewOpen ? 'mt-4' : 'hidden mt-4'}>
        {previewOpen ? (
          <PublicProfileCard profile={controls.profile} allowReport={false} />
        ) : null}
      </div>
    </section>
  );
}

/** Completed challenges — the viewer's OWN, and every row links out. */
function Completed({ completed }: { completed: any }): ReactNode {
  return (
    <>
      <div className="flex items-baseline gap-2 mt-6 mb-2">
        <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 flex-1 min-w-0 truncate">
          {completed.title}
        </div>
        {completed.count ? (
          <div className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{completed.count}</div>
        ) : null}
      </div>
      {completed.rows.length === 0 ? (
        <div
          id="profile-completed-empty"
          className="rounded-2xl bg-white dark:bg-zinc-900 p-4 text-center"
        >
          <div className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
            No completed challenges yet.
          </div>
          <a
            className={`${buttonVariants({ variant: 'neutral', size: 'none', ink: 'neutral' })} inline-flex items-center justify-center px-3 min-h-[36px] text-sm font-medium`}
            href="#leaderboard/challenges"
          >
            Browse challenges
          </a>
        </div>
      ) : (
        <>
          {completed.rows.map((row: any) => (
            <a
              key={row.id}
              className={
                'rounded-2xl bg-white dark:bg-zinc-900 p-3 mb-2 '
                // dark:hover was zinc-900 back when the card was transparent;
                // it is the card's own fill now, so the row had no hover at
                // all in dark. One step up the ramp, as everywhere else.
                + 'flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
                + 'transition-colors'
              }
              href={row.href}
              data-completed-challenge={row.id}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{row.title}</div>
                {row.meta ? (
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{row.meta}</div>
                ) : null}
              </div>
              <span
                className={
                  'shrink-0 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold '
                  + 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                }
              >
                Completed
              </span>
            </a>
          ))}
          <div className="mt-1 mb-2">
            <a
              className="text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
              href="#leaderboard/challenges"
            >
              See all challenges
            </a>
          </div>
        </>
      )}
    </>
  );
}

/** The token allocation card. The backend zeroes total_tokens until terms are
 *  accepted, so a gated allocation shows the terms notice and never a fake 0. */
function TokenCard({ token }: { token: any }): ReactNode {
  if (token.gated) {
    return (
      <div className="rounded-2xl bg-white dark:bg-zinc-900 p-4">
        <div className="font-semibold mb-1">Token allocation withheld</div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          Review and accept the terms to see your token allocation.
        </div>
        <Button
          variant="neutral"
          size="sm"
          ink="neutral"
          onClick={() => Profile.reviewTerms()}
        >
          Review terms
        </Button>
      </div>
    );
  }
  // #1552: no allocation yet says so, in words. A blurred 0 behind a
  // "Reveal" button is a build-up to nothing, and it is the state most
  // people are in.
  if (token.empty) {
    return (
      <div className="rounded-2xl bg-white dark:bg-zinc-900 p-4">
        <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">
          Token allocation
        </div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Nothing allocated to you yet. Allocations are made per season, from
          the season&rsquo;s pool, and are provisional and subject to the
          program terms.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-white dark:bg-zinc-900 p-4">
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">
        Token allocation
      </div>
      <div
        className={token.revealed ? 'text-2xl font-bold' : 'text-2xl font-bold blur-md select-none'}
        aria-hidden={token.revealed ? 'false' : 'true'}
      >
        {token.amount}
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
        {/* What the number IS, before what it is subject to. The old card
            said only the second half, so the figure was a quantity of
            something the reader had to guess at. */}
        Your share of the season&rsquo;s token pool. Allocations are
        provisional and subject to the program terms.
      </div>
      {token.revealed ? null : (
        <Button
          variant="neutral"
          size="sm"
          ink="neutral"
          className="mt-3"
          onClick={() => Profile.revealTokens()}
        >
          Reveal
        </Button>
      )}
    </div>
  );
}

/**
 * The profile's loading state, at the SCREEN's own shape.
 *
 * It was the words "Loading profile…" centred in an otherwise empty screen —
 * the emptiest of the three this pass fixed, because unlike a list there is
 * no chrome around it to say what is coming. What arrives is an identity card,
 * a large points figure, and a breakdown list, and this stands in for all
 * three at their own geometry: the card's `rounded-2xl … p-4 mb-5` face, the
 * 44px avatar beside a name and handle, the `text-4xl` figure with its label
 * under it, and three list rows in the same `rounded-2xl` card.
 *
 * The Edit button's shape is here too. It sits at the card's right end and is
 * the widest thing in that row; leaving it out would let the name line run to
 * an edge the real card never reaches.
 */
function ProfileSkeleton(): ReactNode {
  return (
    <SkeletonGroup label="Loading your profile">
      <div className="rounded-2xl bg-white dark:bg-zinc-900 p-4 mb-5">
        <div className="flex items-center gap-4">
          <Skeleton shape="circle" className="w-11 h-11" />
          <div className="flex-1 min-w-0">
            <Skeleton className="w-40 h-4" />
            <Skeleton shape="muted" className="mt-2 w-24" />
          </div>
          <Skeleton shape="block" className="w-24 h-8 rounded-full" />
        </div>
      </div>
      {/* The rank + points header: one big figure over its label. */}
      <div className="mb-5 flex flex-col items-center">
        <Skeleton shape="block" className="w-24 h-9" />
        <Skeleton shape="muted" className="mt-2 w-12" />
      </div>
      {/* The points breakdown, in the card the real rows are drawn in. */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
            <Skeleton shape="muted" className="ml-auto w-14" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

export function ProfileRoot(): ReactNode {
  const state = useStoreState(profileStore);
  const view = buildProfileView(state);

  if (view.kind === 'empty') return null;
  if (view.kind === 'loading') return <ProfileSkeleton />;
  // signedOut is checked BEFORE error — see buildProfileView. A lapsed session
  // is a normal state, and the connection-error copy blames the network for it.
  if (view.kind === 'signedOut') {
    return (
      <div className="py-12 text-center">
        <div className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          Sign in to see your profile.
        </div>
        <a
          className={
            'inline-flex items-center justify-center px-4 min-h-[44px] rounded-lg '
            + 'bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium'
          }
          href="#login"
        >
          Sign in
        </a>
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="text-sm text-zinc-500 py-8 text-center dark:text-zinc-400">
        Could not load your profile. Check your connection and try again.
      </div>
    );
  }
  if (view.kind === 'publicNotFound') {
    return (
      <div className="text-sm text-zinc-500 py-12 text-center dark:text-zinc-400">This profile is unavailable.</div>
    );
  }
  if (view.kind === 'public') {
    return <PublicProfileCard profile={view.profile} allowReport={view.allowReport} />;
  }

  return (
    <>
      {state.sheetOpen ? (
        <ProfileEditSheet
          avatarUrl={view.identity.avatarUrl}
          initial={view.identity.initial}
        />
      ) : null}
      <IdentityCard identity={view.identity} />
      {view.publicControls ? (
        <PublicControls
          controls={view.publicControls}
          status={state.publicStatus}
          publishing={state.publishing}
          previewOpen={state.previewOpen}
        />
      ) : null}

      {/* Rank + points header (native ScoreHeader equivalent). */}
      <div className="text-center mb-5">
        <div className="text-4xl font-extrabold tracking-tight">{view.points}</div>
        <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mt-1">
          points
        </div>
        {view.sub ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">{view.sub}</div>
        ) : null}
      </div>

      <TokenCard token={view.token} />

      {view.breakdown.length > 0 ? (
        <>
          <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">
            Points breakdown
          </div>
          <div
            className="rounded-2xl bg-white dark:bg-zinc-900"
          >
            {view.breakdown.map((row: any, index: number) => (
              // The separator is INSET to the text column and drawn by the row
              // rather than by `divide-y` on the parent: a rule that runs the
              // full width of a rounded card reaches its corner radius. Same
              // idiom, same reason, as @/components/ui/grouped-list.tsx and as
              // the home panels' hairlines in app.css.
              <div
                key={`${row.label}:${index}`}
                className="relative flex items-center gap-3 px-3 py-2 text-sm [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:left-3 [&:not(:first-child)]:before:right-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-zinc-200 dark:[&:not(:first-child)]:before:bg-zinc-800 [&:not(:first-child)]:before:content-['']"
              >
                <span className="flex-1 min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 font-semibold text-violet-700 dark:text-violet-400">
                  {`${Number(row.points || 0).toLocaleString()} pts`}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <Completed completed={view.completed} />
      {/*
          Settings, Admin and the two native rows — the account group the
          retired hamburger drawer used to close with. LAST, because this
          screen leads with who you are and what you have done; where you
          configure it is the footer of that, not the headline.
      */}
      <AccountPanel />
    </>
  );
}

export { publicAvatarView };
