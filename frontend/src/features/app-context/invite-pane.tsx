/**
 * Invite — the third pane of the app-context sheet: a link to this project
 * that anyone can use to join it (/invite/<token>,
 * src/services/community-invites.js).
 *
 * ── What it does, in order ────────────────────────────────────────────
 *
 *   1. THE LINK. Your newest live link for this project, or a new one made
 *      the first time you open the pane: opening it again does not mint
 *      another. Copy, and Share where the device has a share sheet. The
 *      first Copy or Share of a link tells the server it went out (audit
 *      D03): only then do the Communities row and the hub say a link is out.
 *   2. YOUR LINKS. The live ones, with Turn off, and the ones that ended in
 *      the last 30 days, greyed, with how each ended instead of a Turn off.
 *      A link the leaked-link guard paused (100 people in a day,
 *      services/community-invites.js GUARD) is listed with the live ones,
 *      said to be paused, with Open it again beside its Turn off.
 *      Every row says who came in through its link: how many joined and how
 *      many are waiting, or that nobody has used it yet. Someone who manages
 *      the project sees everyone's, with who made each. How long each lasts
 *      and how many it is for is on its row, so the pane spells out nothing
 *      else (#4599: the sentence under the link, the line about newcomers
 *      and the joining rule are gone).
 *   3. CHANGE, a small link beside that heading: how long and for how many,
 *      within the server's limits; a new link is made with them. Never and
 *      No limit come first and are the defaults: a link has no end and no
 *      cap unless its maker picks one (9 Nov 2026). The old one keeps
 *      working until turned off. The heading row shows even with no live
 *      links, so Change is always there.
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
import { useMessages } from '../../lib/i18n/react';
import { t } from '../../lib/i18n/runtime';
import { withVia } from '../first-session/copy-invite';
import { daysUntil } from './invite-model';
import { NotifyAsk } from '../notify-ask/notify-ask';

export type { InviteLink, InviteState } from './invite-data';

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-start '
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

// 0 asks for no limit (WP-D): no end date, or any number of people. It is
// every new link's default, so it is each list's first choice.
const NO_LIMIT = 0;
const DAY_CHOICES = [NO_LIMIT, 1, 7, 30];
const USE_CHOICES = [NO_LIMIT, 1, 5, 10, 25, 50, 100];

/** "3 of 25 used · 5 days left", for a row of Your links. */
export function linkDetail(
  link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses' | 'status'>,
  now = Date.now(),
): string {
  // A link for anyone says so; how many came in by it is the row's second
  // line (statusLine), like every other link's.
  const uses = link.maxUses == null
    ? t('agent:appContext.invite.detail.anyone')
    : t('agent:appContext.invite.detail.used', { used: link.uses, max: link.maxUses });
  // Two facts about the link, side by side. For a link that has ended, the
  // second is why, in place of how long it had left.
  let expiry: string;
  if (link.status === 'paused') {
    // The guard paused it; it is not over, so this says so rather than why
    // it ended.
    expiry = t('agent:appContext.invite.detail.paused');
  } else if (link.status && link.status !== 'live') {
    expiry = link.status === 'expired'
      ? t('agent:appContext.invite.detail.expired')
      : link.status === 'used_up'
        ? t('agent:appContext.invite.detail.usedUp')
        : t('agent:appContext.invite.detail.turnedOff');
  } else if (link.expiresAt == null) {
    expiry = t('agent:appContext.invite.detail.noEnd');
  } else {
    const days = daysUntil(link.expiresAt, now);
    expiry = days <= 1 ? t('agent:appContext.invite.detail.underDay') : t('agent:appContext.invite.detail.daysLeft', { count: days });
  }
  return t('agent:appContext.invite.detail.pair', { uses, expiry });
}

/**
 * The row's second line: who came in through the link. "2 joined · 1
 * waiting"; each count is left out at zero, and when nobody has used the
 * link at all it says so.
 */
export function statusLine(link: Pick<InviteLink, 'joined' | 'waiting'>): string {
  const parts: string[] = [];
  if (link.joined > 0) parts.push(t('agent:appContext.invite.detail.joined', { count: link.joined }));
  if (link.waiting > 0) parts.push(t('agent:appContext.invite.status.waiting', { count: link.waiting }));
  if (!parts.length) return t('agent:appContext.invite.status.nobody');
  if (parts.length === 1) return parts[0];
  return t('agent:appContext.invite.status.pair', { joined: parts[0], waiting: parts[1] });
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
export function InviteSkeleton({ label, unnamed = false, canShare }: { label: string; unnamed?: boolean; canShare: boolean }): ReactNode {
  const t = useMessages('agent');
  return (
    <div id="app-invite-pane" className="pb-2" data-invite-loading="">
      <div className="px-5 pt-1">
        <div className={TITLE}>{unnamed ? t('agent:appContext.invite.titleUnnamed') : t('agent:appContext.invite.title', { project: label })}</div>
      </div>
      {/* The pulse is opacity alone, on the compositor, and still under
          reduced motion. */}
      <SkeletonGroup label={t('agent:appContext.invite.making')} className="motion-reduce:animate-none">
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
          <Skeleton className="ms-auto w-12" />
        </div>
      </SkeletonGroup>
    </div>
  );
}

/**
 * `label` is the project's name. With `unnamed`, no name has loaded and `label`
 * is a stand-in: the sentences here use their unnamed wording instead of
 * taking the stand-in as a name.
 */
export function InvitePane({ slug, label, unnamed = false }: { slug: string | null; label: string; unnamed?: boolean }) {
  const t = useMessages('agent');
  // What AppContext.openInvite() read before the sheet went up, when it came
  // in time: the pane's first render is then the loaded one.
  const [prepared] = useState<InviteOutcome | null>(() => (slug ? preparedInvite(slug) : null));
  const fromOpener = useRef(prepared != null);
  const [state, setState] = useState<InviteState | null>(prepared?.state ?? null);
  const [error, setError] = useState<string | null>(prepared?.error ?? null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The link went out from here (copied or shared): the notification ask.
  const [sentOut, setSentOut] = useState(false);
  const [changing, setChanging] = useState(false);
  const [days, setDays] = useState(prepared?.state?.defaults.days ?? NO_LIMIT);
  const [uses, setUses] = useState(prepared?.state?.defaults.maxUses ?? NO_LIMIT);

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

  const current = state?.links.find((l) => l.mine && l.status === 'live') || null;
  const url = current ? absolute(current.path) : '';

  // Audit D03: the link went out, so the Communities row and the hub may
  // say an invite is out. Opening the pane made it; only this says it was
  // sent. Once per link, and nothing waits on it.
  const noted = useRef(new Set<number>());
  const noteSent = (link: InviteLink) => {
    if (link.shared || noted.current.has(link.id)) return;
    noted.current.add(link.id);
    void inviteApi(`/api/invite-links/${link.id}/shared`, { method: 'POST' }).catch(() => { noted.current.delete(link.id); });
  };

  const copy = async () => {
    if (!url || !current) return;
    try {
      await navigator.clipboard.writeText(withVia(url, 'copied'));
      noteSent(current);
      setCopied(true);
      setSentOut(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(t('agent:appContext.invite.copyFailed'));
    }
  };
  const share = async () => {
    if (!url || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ title: unnamed ? t('agent:appContext.invite.shareTitleUnnamed') : t('agent:appContext.invite.shareTitle', { project: label }), url: withVia(url, 'shared') });
      if (current) noteSent(current);
      setSentOut(true);
    } catch { /* dismissed */ }
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

  // The leaked-link guard paused it: opening it again clears the pause and
  // starts its count afresh.
  const reopen = async (link: InviteLink) => {
    setBusy(true);
    setError(null);
    try {
      await inviteApi(`/api/invite-links/${link.id}/reopen`, { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (!slug) return <div id="app-invite-pane"><p className={NOTE}>{t('agent:appContext.invite.noProject')}</p></div>;
  if (!state && error) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>{error}</p>
      </div>
    );
  }
  if (!state) return <InviteSkeleton label={label} unnamed={unnamed} canShare={canShare} />;
  if (!state.canCreate) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>
          {state.grant === 'collaborator'
            ? (unnamed ? t('agent:appContext.invite.buildersOnlyUnnamed') : t('agent:appContext.invite.buildersOnly', { project: label }))
            : (unnamed ? t('agent:appContext.invite.joinFirstUnnamed') : t('agent:appContext.invite.joinFirst', { project: label }))}
        </p>
      </div>
    );
  }
  return (
    <div id="app-invite-pane" className="pb-2">
      <div className="px-5 pt-1">
        <div className={TITLE}>
          {unnamed ? t('agent:appContext.invite.titleUnnamed') : t('agent:appContext.invite.title', { project: label })}
        </div>
      </div>
      {current ? (
        <>
          <div className="px-5 pt-3">
            <Input
              id="app-invite-url"
              readOnly
              value={url}
              aria-label={t('agent:appContext.invite.linkLabel')}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className="flex items-stretch gap-2 px-5 pt-3">
            <button id="app-invite-copy" type="button" className={PRIMARY} onClick={copy}>
              <CopyIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{copied ? t('agent:appContext.invite.copied') : t('agent:appContext.invite.copyLink')}</span>
            </button>
            {canShare ? (
              <button id="app-invite-share" type="button" className={SECONDARY} onClick={share}>
                <ShareIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{t('agent:appContext.invite.share')}</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <p role="alert" className="px-5 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {/* The link went out: hear when they join? (the notification ask). */}
      {sentOut ? <div className="px-5 pt-3"><NotifyAsk moment="invite_sent" /></div> : null}

      <div id="app-invite-links">
        <div className={SECTION_ROW}>
          <h4 className={SECTION}>
            {state.manages
              ? t('agent:appContext.invite.liveLinks')
              : t('agent:appContext.invite.yourLinks')}
          </h4>
          {changing ? null : (
            <button id="app-invite-change-open" type="button" className={CHANGE_LINK} onClick={() => setChanging(true)}>
              {t('agent:appContext.invite.change')}
            </button>
          )}
        </div>
        {changing ? (
          <div id="app-invite-change" className="px-5 pt-2 pb-2 space-y-3">
            <label className="block text-sm text-zinc-700 dark:text-zinc-200">
              <span className="block pb-1">{t('agent:appContext.invite.expiresAfter')}</span>
              <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                {DAY_CHOICES.filter((d) => d === NO_LIMIT || (d >= state.limits.minDays && d <= state.limits.maxDays)).map((d) => (
                  <option key={d} value={d}>{d === NO_LIMIT ? t('agent:appContext.invite.option.untilOff') : t('agent:appContext.invite.option.days', { count: d })}</option>
                ))}
              </Select>
            </label>
            <label className="block text-sm text-zinc-700 dark:text-zinc-200">
              <span className="block pb-1">{t('agent:appContext.invite.worksFor')}</span>
              <Select value={String(uses)} onChange={(e) => setUses(Number(e.target.value))}>
                {USE_CHOICES.filter((n) => n === NO_LIMIT || (n >= state.limits.minUses && n <= state.limits.maxUses)).map((n) => (
                  <option key={n} value={n}>{n === NO_LIMIT ? t('agent:appContext.invite.option.anyone') : t('agent:appContext.invite.option.people', { count: n })}</option>
                ))}
              </Select>
            </label>
            <div className="flex items-stretch gap-2">
              <button type="button" className={SECONDARY} onClick={() => setChanging(false)}>{t('core:common.cancel')}</button>
              <button id="app-invite-make" type="button" className={PRIMARY} disabled={busy} onClick={make}>
                {t('agent:appContext.invite.makeNew')}
              </button>
            </div>
          </div>
        ) : null}
        {state.links.length ? state.links.map((link) => {
          const paused = link.status === 'paused';
          const ended = link.status !== 'live' && !paused;
          return (
            <div
              key={link.id}
              className={ended ? `${ROW} text-zinc-500 dark:text-zinc-400` : ROW}
              data-invite-link={link.id}
              data-invite-status={link.status}
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate">{linkDetail(link)}</span>
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{statusLine(link)}</span>
                {!link.mine && link.createdBy ? (
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{t('agent:appContext.invite.madeBy', { username: link.createdBy })}</span>
                ) : null}
              </span>
              {paused ? (
                <button
                  type="button"
                  className="shrink-0 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-50"
                  disabled={busy}
                  data-invite-reopen={link.id}
                  onClick={() => reopen(link)}
                >
                  {t('agent:appContext.invite.reopen')}
                </button>
              ) : null}
              {ended ? null : (
                <button
                  type="button"
                  className="shrink-0 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  disabled={busy}
                  onClick={() => turnOff(link)}
                >
                  {t('agent:appContext.invite.turnOff')}
                </button>
              )}
            </div>
          );
        }) : (changing ? null : <p className={NOTE}>{t('agent:appContext.invite.noLinks')}</p>)}
      </div>
    </div>
  );
}
