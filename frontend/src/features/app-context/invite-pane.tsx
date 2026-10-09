/**
 * Invite — the third pane of the app-context sheet: a link to this project
 * that anyone can use to join it (/invite/<token>,
 * src/services/community-invites.js).
 *
 * ── What it does, in order ────────────────────────────────────────────
 *
 *   1. THE LINK. Your newest live link for this project, or a new one made
 *      the first time you open the pane: opening it again does not mint
 *      another. Copy, and Share where the device has a share sheet.
 *   2. YOUR LINKS. Every live one, with Turn off. Someone who manages the
 *      project sees everyone's, with who made each. How long each lasts and
 *      how many it is for is on its row, so the pane spells out nothing
 *      else (#4599: the sentence under the link, the line about newcomers
 *      and the joining rule are gone).
 *   3. CHANGE, a small link beside that heading: how long and for how many,
 *      within the server's limits; a new link is made with them. The old one
 *      keeps working until turned off. The heading row shows even with no
 *      live links, so Change is always there.
 *
 * ── It is a PANE, for About's reason ──────────────────────────────────
 *
 * The kit cannot present a sheet while it is still dismissing another, and
 * inviting is where this menu goes rather than something opened over it
 * (./about-pane.tsx). The header row's back arrow is the way back.
 *
 * ── It opens at its own height, once ─────────────────────────────────
 *
 * The sheet goes up at the height it first renders at, so the pane's first
 * render is as tall as it will be. `AppContext.openInvite()` reads the state
 * before presenting (./invite-data.ts) and the pane starts from that answer;
 * when the read is slow, it starts from InviteSkeleton, the loaded pane's own
 * rows in grey. It never starts from a one-line note that grows: that was a
 * short sheet that rose a second time, with the dim fading in twice.
 *
 * Nothing here is in the prerender: `view` is 'menu' there, so the pane only
 * ever renders on the client, and its data loads in an effect (or arrived
 * before it mounted).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CopyIcon, ShareIcon } from '@/components/ui/icons';
import { Input, inputVariants } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import {
  forgetPreparedInvite,
  inviteApi,
  inviteLinksUrl,
  prepareInvite,
  preparedInvite,
  readInviteState,
  type InviteLink,
  type InviteOutcome,
  type InviteState,
} from './invite-data';
import { daysUntil } from './invite-model';

export type { InviteLink, InviteState } from './invite-data';

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200';
// The links' heading row: the small-caps label, and Change beside it.
const SECTION_ROW = 'flex items-center justify-between gap-3 px-5 pt-4 pb-1';
const SECTION = 'text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';
const CHANGE_LINK = 'shrink-0 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline';
const NOTE = 'px-5 py-2 text-sm text-zinc-500 dark:text-zinc-400';
const TITLE = 'text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100';
const PRIMARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors';
const SECONDARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 '
  + 'dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 transition-colors';

// 0 asks for no limit (WP-D): no end date, or any number of people.
const NO_LIMIT = 0;
const DAY_CHOICES = [1, 7, 30, NO_LIMIT];
const USE_CHOICES = [1, 5, 10, 25, 50, 100, NO_LIMIT];

/** "3 of 25 used · 5 days left", for a row of Your links. */
export function linkDetail(link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses'>, now = Date.now()): string {
  const used = link.maxUses == null ? `${link.uses} joined` : `${link.uses} of ${link.maxUses} used`;
  if (link.expiresAt == null) return `${used} · no end date`;
  const days = daysUntil(link.expiresAt, now);
  return `${used} · ${days <= 1 ? 'under a day left' : `${days} days left`}`;
}

function absolute(path: string): string {
  try { return new URL(path, window.location.origin).toString(); } catch { return path; }
}

/**
 * One line of text that has not arrived: as tall as the line it stands for
 * (the zero-width space takes its height from the type around it), with a
 * bar across it.
 */
function SkeletonLine({ className, shape = 'muted' }: { className: string; shape?: 'line' | 'muted' }): ReactNode {
  return (
    <span className="flex items-center">
      {'\u200b'}
      <Skeleton shape={shape} className={className} />
    </span>
  );
}

/**
 * The pane before its link has come: the loaded pane's own rows, in grey, so
 * the sheet that goes up around it is already the height it stays. Only when
 * the read outlasts the opener's wait (AppContext.openInvite); otherwise the
 * pane's first render is the loaded one.
 *
 * Each row keeps the container, padding and type of the row it stands for,
 * so its height comes from the same classes rather than a copied number: the
 * link field is the Input's own box, the buttons are h-10 like Copy and
 * Share, the heading row and a link row are theirs. What it cannot know is
 * how many links there are, so it draws the common case: one of their own.
 */
export function InviteSkeleton({ label, canShare }: { label: string; canShare: boolean }): ReactNode {
  return (
    <div id="app-invite-pane" className="pb-2" data-invite-loading="">
      <div className="px-5 pt-1">
        <div className={TITLE}>{`Invite people to ${label}`}</div>
      </div>
      {/* The pulse is opacity alone, on the compositor, and still under
          reduced motion. */}
      <SkeletonGroup label="Making your link" className="motion-reduce:animate-none">
        <div className="px-5 pt-3">
          <div className={inputVariants()}>
            <SkeletonLine shape="line" className="w-3/4" />
          </div>
        </div>
        <div className="flex items-stretch gap-2 px-5 pt-3">
          <Skeleton shape="block" className="h-10 flex-1 basis-0 rounded-full" />
          {canShare ? <Skeleton shape="block" className="h-10 flex-1 basis-0 rounded-full" /> : null}
        </div>
        <div className={SECTION_ROW}>
          <span className={`${SECTION} flex-1`}><SkeletonLine shape="line" className="w-16" /></span>
          <span className="text-sm"><SkeletonLine className="w-12" /></span>
        </div>
        <div className={ROW}>
          <Skeleton className="w-2/5" />
          <Skeleton className="ml-auto w-12" />
        </div>
      </SkeletonGroup>
    </div>
  );
}

export function InvitePane({ slug, label }: { slug: string | null; label: string }) {
  // What AppContext.openInvite() read before the sheet went up, when it came
  // in time: the pane's first render is then the loaded one.
  const [prepared] = useState<InviteOutcome | null>(() => (slug ? preparedInvite(slug) : null));
  const fromOpener = useRef(prepared != null);
  const [state, setState] = useState<InviteState | null>(prepared?.state ?? null);
  const [error, setError] = useState<string | null>(prepared?.error ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [days, setDays] = useState(prepared?.state?.defaults.days ?? 7);
  const [uses, setUses] = useState(prepared?.state?.defaults.maxUses ?? 25);

  const base = slug ? inviteLinksUrl(slug) : null;

  const apply = useCallback((next: InviteState) => {
    setState(next);
    setDays(next.defaults.days);
    setUses(next.defaults.maxUses);
  }, []);

  // After a change of theirs (a new link, one turned off): read it again.
  const load = useCallback(async () => {
    if (!slug) return;
    setError(null);
    try {
      apply(await readInviteState(slug, false));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [slug, apply]);

  // Opening: the opener's read, taken whole when it came in time, else joined
  // where it is (it may be making their first link, so it is never started
  // twice). Reached without the opener, this starts it.
  useEffect(() => {
    if (!slug) return undefined;
    if (fromOpener.current) {
      fromOpener.current = false;
      forgetPreparedInvite();
      return undefined;
    }
    let live = true;
    void prepareInvite(slug).then((outcome) => {
      if (!live) return;
      forgetPreparedInvite();
      if (outcome.state) apply(outcome.state);
      else setError(outcome.error);
    });
    return () => { live = false; };
  }, [slug, apply]);

  const current = state?.links.find((l) => l.mine) || null;
  const url = current ? absolute(current.path) : '';

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy. Press and hold the link to copy it.');
    }
  };
  const share = async () => {
    if (!url || typeof navigator.share !== 'function') return;
    try { await navigator.share({ title: `Join ${label} on Homeroom`, url }); } catch { /* dismissed */ }
  };
  const make = async () => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      await inviteApi(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, maxUses: uses }),
      });
      setChanging(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async (link: InviteLink) => {
    setBusy(true);
    setError(null);
    try {
      await inviteApi(`/api/invite-links/${link.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (!slug) return <div id="app-invite-pane"><p className={NOTE}>Open a project to invite people to it.</p></div>;
  if (!state && error) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>{error}</p>
      </div>
    );
  }
  if (!state) return <InviteSkeleton label={label} canShare={canShare} />;
  if (!state.canCreate) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>
          {state.grant === 'collaborator'
            ? `Only the people building ${label} can invite others to it.`
            : `Join ${label} to invite people to it.`}
        </p>
      </div>
    );
  }
  return (
    <div id="app-invite-pane" className="pb-2">
      <div className="px-5 pt-1">
        <div className={TITLE}>
          {`Invite people to ${label}`}
        </div>
      </div>
      {current ? (
        <>
          <div className="px-5 pt-3">
            <Input
              id="app-invite-url"
              readOnly
              value={url}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className="flex items-stretch gap-2 px-5 pt-3">
            <button id="app-invite-copy" type="button" className={PRIMARY} onClick={copy}>
              <CopyIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{copied ? 'Copied' : 'Copy link'}</span>
            </button>
            {canShare ? (
              <button id="app-invite-share" type="button" className={SECONDARY} onClick={share}>
                <ShareIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Share</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <p role="alert" className="px-5 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <div id="app-invite-links">
        <div className={SECTION_ROW}>
          <h4 className={SECTION}>{state.manages ? 'Live links' : 'Your links'}</h4>
          {changing ? null : (
            <button id="app-invite-change-open" type="button" className={CHANGE_LINK} onClick={() => setChanging(true)}>
              Change
            </button>
          )}
        </div>
        {changing ? (
          <div id="app-invite-change" className="px-5 pt-2 pb-2 space-y-3">
            <label className="block text-sm text-zinc-700 dark:text-zinc-200">
              <span className="block pb-1">Expires after</span>
              <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                {DAY_CHOICES.filter((d) => d === NO_LIMIT || (d >= state.limits.minDays && d <= state.limits.maxDays)).map((d) => (
                  <option key={d} value={d}>{d === NO_LIMIT ? 'Until you turn it off' : d === 1 ? '1 day' : `${d} days`}</option>
                ))}
              </Select>
            </label>
            <label className="block text-sm text-zinc-700 dark:text-zinc-200">
              <span className="block pb-1">Works for</span>
              <Select value={String(uses)} onChange={(e) => setUses(Number(e.target.value))}>
                {USE_CHOICES.filter((n) => n === NO_LIMIT || (n >= state.limits.minUses && n <= state.limits.maxUses)).map((n) => (
                  <option key={n} value={n}>{n === NO_LIMIT ? 'Anyone with the link' : n === 1 ? '1 person' : `${n} people`}</option>
                ))}
              </Select>
            </label>
            <div className="flex items-stretch gap-2">
              <button type="button" className={SECONDARY} onClick={() => setChanging(false)}>Cancel</button>
              <button id="app-invite-make" type="button" className={PRIMARY} disabled={busy} onClick={make}>
                Make new link
              </button>
            </div>
          </div>
        ) : null}
        {state.links.length ? state.links.map((link) => (
          <div key={link.id} className={ROW} data-invite-link={link.id}>
            <span className="flex-1 min-w-0">
              <span className="block truncate">{linkDetail(link)}</span>
              {!link.mine && link.createdBy ? (
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{`by @${link.createdBy}`}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="shrink-0 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={() => turnOff(link)}
            >
              Turn off
            </button>
          </div>
        )) : (changing ? null : <p className={NOTE}>No live links.</p>)}
      </div>
    </div>
  );
}
