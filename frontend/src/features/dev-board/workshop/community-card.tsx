/**
 * The project page's hero: what this is, who it is for, and Join, at the top
 * of the project's own Workshop page, above where the app is.
 *
 * ── Why it leads the page ──────────────────────────────────────────────
 *
 * Every project belongs to one community (src/services/communities.js), and
 * while the two are one-to-one the community is drawn AS its project: there
 * is no separate community page, so the facts that are the community's
 * rather than the code's live on the page the Workshop tab's row opens. The
 * page used to open on its dashboard, four numbers about the code, with the
 * community in a card under it; a person arriving from Discover or a shared
 * link met "18 open items" before they met the thing's name. So the page
 * leads with identity, the way a profile does, and the dashboard follows:
 *
 *   WHAT IT IS. The app's tile and name (the header chip's, from the page's
 *   own store) and dapp.json's one-line description when it has one.
 *
 *   WHO IT IS FOR. The audience, in the words people see (Public community,
 *   Private community, Just you) as a chip, and for a public or a private
 *   community WHO IS HERE: faces, the member count, and a line of this
 *   week's activity with the last fourteen days as a small bar chart (#3268;
 *   it was the hub's Members & activity card, fourth down the page). The
 *   chart names a day when it is pointed at, or dragged across with a
 *   finger (Spark, below), so it needs no caption of its own.
 *
 *   JOIN, JOINED, INVITE, ⋯. Membership sits across from the name, because
 *   it is a fact about you and this project, the way a profile's Follow
 *   sits across from the person's name. An outsider sees Join, which asks
 *   in a popup under itself (below). A member sees Joined, which is also
 *   the way out: a tap asks before leaving, the same pill Discover draws.
 *   What you can DO here ends the members row: Invite opens Members &
 *   approvals, where the roster, invites and approvers are managed, for
 *   exactly whom the ⋯ menu offers it, and the ⋯ itself (`menu`, the
 *   page's DevPlusMenu) holds Ask for a change and the project's settings.
 *   This hero lists; it does not manage.
 *
 *   MAKE IT PUBLIC. Who a project is for can grow after it exists: Invite
 *   makes a Just-you project a private community, and "Make it public" (it
 *   was "Open it up") makes it a public one. Taking a public community back
 *   is "Make it private", a row of the ⋯ rather than a button here
 *   (confirmMakePrivate): narrowing who a project is for is a setting, not
 *   an invitation, and the hero's row is for asking people in. That is the
 *   visibility change the settings dialog proposes, POST
 *   /api/apps/:slug/visibility-pr, offered to the same people the route
 *   lets open it (`can_manage`). It is a PROPOSAL, not a switch: dapp.json
 *   says who a project is for, so the change is voted in like any other
 *   line of it and applies once it merges. While one is up, the hero says
 *   so and links to it instead of offering a second.
 *
 *   HOW A CHANGE GETS IN is not on the hero any more. The approval rule is
 *   the Workshop page's Approval rules card (ApprovalRules, below), beside
 *   the work it governs: on the hero it was a line about process between
 *   who is here and the channel.
 *
 *   WHERE THEY TALK is no longer a row here. The channel has a card of its
 *   own on the hub (./hub-cards.tsx), with its last messages, because it
 *   lives on the hub now rather than in Messages.
 *
 * Joining is what lets you take part here. The button asks the question every
 * join_required refusal asks, through lib/join-required.ts's offerJoin, and
 * while it shows it registers itself as that app's anchor, so a refusal from
 * anywhere on this page asks in the same popup.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * The hero's community half waits for its read: the fetch runs in an
 * effect, the first render is the identity alone (or nothing, without a
 * name), and a failed read leaves just that, rather than drawing an error
 * where nothing was asked for.
 */

import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronRightIcon, LockIcon, PlayIcon, UserGroupIcon, UserIcon } from '@/components/ui/icons';
import { swatchFor } from '../../messages/format';
import { offerJoin, registerJoinAnchor } from '../../../lib/join-required';

type Audience = 'open' | 'invited' | 'solo';

export type CommunityPayload = {
  slug: string;
  name?: string;
  /** dapp.json's one-line description, when the repository declares one. */
  description?: string | null;
  member_count: number;
  is_member: boolean;
  is_creator: boolean;
  audience: Audience;
  audience_label: string;
  members: Array<{ id: number; username: string; display_name?: string | null; source?: string }>;
  channel: {
    last_message: string | null;
    last_at: string | null;
    last_by: string | null;
    unread_count: number;
    /** The newest few messages, oldest first, for the hub's preview. */
    recent?: Array<{ id: number; content: string; created_at: string; by: string | null }>;
    /** Where Open goes: the app's channel, or #general for Homeroom's. */
    href?: string;
    /** `general` on Homeroom's own hub, whose channel #general is. */
    handle?: string | null;
    /** Where the hub's composer sends: the room's own write route. */
    post_url?: string | null;
  } | null;
  /** Who has been around lately, for Members & activity: two counts and
      the last fourteen days, oldest first, as people-per-day. */
  activity?: {
    active_week: number;
    shipped_month: number;
    daily?: Array<{ day: string; n: number }>;
  } | null;
  /** Whether this viewer may propose who the project is for (the creator,
      an app admin or a platform admin; never the platform's own app). */
  can_manage?: boolean;
  /** An audience change already up for a vote, if one is. */
  audience_change?: { session_id: number; pr_number: number | null; title: string | null } | null;
  approval: {
    policy: 'anyone' | 'invited';
    approvals_required: number | null;
    electorate: number;
    required: number;
  };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The approval rule as one sentence. Exported and pure so the wording is
 * tested against the three regimes governance.js knows.
 */
export function approvalLine(approval: CommunityPayload['approval'] | null | undefined): string {
  if (!approval) return '';
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  if (approval.policy === 'invited') {
    return `Approvers decide: ${plural(required, 'yes vote', 'yes votes')} from ${plural(electorate, 'approver', 'approvers')} to merge a change.`;
  }
  if (approval.approvals_required != null) {
    return `A change needs ${plural(required, 'yes vote', 'yes votes')} from members to merge.`;
  }
  return `Members vote: a change merges at ${plural(required, 'yes vote', 'yes votes')} (${plural(electorate, 'active member', 'active members')}), or unopposed after a wait.`;
}

/** "Public community · 12 members"; "Just you" alone, because there is one. */
export function audienceLine(p: Pick<CommunityPayload, 'audience' | 'audience_label' | 'member_count'>): string {
  if (p.audience === 'solo') return p.audience_label || 'Just you';
  return `${p.audience_label} · ${plural(Number(p.member_count) || 0, 'member', 'members')}`;
}

/**
 * The pending audience change in the hero's words. The PR's title is the
 * settings dialog's ("Make this app public"); the hero says what it means
 * for who the project is for.
 */
export function audienceChangeLine(title: string | null | undefined): string {
  const t = String(title || '');
  if (/ public$/.test(t)) return 'Making it a public community is waiting for approval';
  if (/private \(collaborators only\)$/.test(t)) return 'Making it a private community is waiting for approval';
  return 'A change to who it is for is waiting for approval';
}

function AudienceGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

async function readCommunity(slug: string): Promise<CommunityPayload | null> {
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/community`);
    if (!res.ok) return null;
    return (await res.json()) as CommunityPayload;
  } catch {
    return null;
  }
}

/*
 * ONE READ FOR THE WHOLE HUB. The hero, the channel card and Members &
 * activity all draw from GET /api/apps/:slug/community, so they share this
 * cache rather than asking three times. Each consumer's mount asks for a
 * fresh copy unless one is already on its way, and a failed read keeps the
 * last good answer rather than blanking the page.
 */
const communities = new Map<string, CommunityPayload>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/**
 * Invite people with a link (#3362): the Homeroom menu's invite pane, a link
 * to this project anyone can use to join it (../../app-context/invite-pane.tsx).
 * The menu's own "Invite to community" row is gone, so the hub's Invite is
 * the way in, beside the people it adds. Collaborators and approvals are
 * still the ⋯'s "Members & approvals".
 */
export function openInviteLinks(): void {
  const ctx = (window as any).AppContext;
  if (!ctx) return;
  ctx.open?.();
  ctx.showInvite?.();
}

export function reloadCommunity(slug: string): Promise<void> {
  if (!slug) return Promise.resolve();
  const pending = readCommunity(slug).then((next) => {
    inflight.delete(slug);
    if (next && next.slug === slug) {
      communities.set(slug, next);
      for (const listener of [...listeners]) listener();
    }
  });
  inflight.set(slug, pending);
  return pending;
}

export function useCommunity(slug: string): CommunityPayload | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  useEffect(() => {
    if (slug && !inflight.has(slug)) void reloadCommunity(slug);
  }, [slug]);
  return slug ? communities.get(slug) || null : null;
}

/** How many faces the hero shows before the count says the rest. */
export const HERO_FACES = 5;

/**
 * The hub's people line (#3268): up to HERO_FACES faces, then who the
 * community is for and how many are in it, "Public community · 23 members".
 * The label used to be a chip of its own under the name, and the name is the
 * coloured header's now, so the audience rides the count instead of spending
 * a row of the page on itself. Just you is the label alone.
 */
export function HeroPeople({ members, count, audience, audienceLabel, children }: {
  members: CommunityPayload['members'] | null | undefined;
  count: number;
  audience?: Audience;
  audienceLabel?: string;
  children?: ReactNode;
}) {
  const faces = (members || []).slice(0, HERO_FACES);
  const solo = audience === 'solo';
  return (
    <div className="dev-ws-hero-people" data-ws-members="">
      {faces.length ? (
        <span className="dev-ws-hero-faces" aria-hidden="true">
          {faces.map((m) => (
            <span key={m.id} className="dev-ws-hero-face" style={{ background: swatchFor(m.username) }} title={`@${m.username}`}>
              {(m.username || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
      ) : null}
      <span className="dev-ws-hero-count" data-ws-members-cell="members">
        {audienceLabel ? (
          <span className="dev-ws-hero-audience" data-ws-community-audience="">
            {audience ? <AudienceGlyph audience={audience} /> : null}
            <b>{audienceLabel}</b>
          </span>
        ) : null}
        {solo ? null : `${audienceLabel ? ' · ' : ''}${plural(count, 'member', 'members')}`}
      </span>
      {children}
    </div>
  );
}

/** "Sat, Sep 26", the day a bar stands for, in the viewer's own words. */
export function sparkDay(day: string): string {
  const when = new Date(`${day}T12:00:00`);
  return Number.isNaN(when.getTime()) ? day
    : when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The tip's first line: "Sat, Sep 26 · 21 people". */
export function sparkTip(d: { day: string; n: number }): string {
  return `${sparkDay(d.day)} · ${plural(Number(d.n) || 0, 'person', 'people')}`;
}

/** How long a tip stays up after a finger lifts off the chart. */
const TIP_LINGER_MS = 2500;

/**
 * The fourteen days as bars, and the day under the pointer as a tip.
 *
 * NO CAPTION, AND NO `title` ON THE BARS. The chart carried "Who took part,
 * last 14 days" under the activity line, and each bar a native tooltip that
 * a phone never shows. The caption is the tip's second line now, where it
 * explains the number it sits under, and the tip is the chart's own:
 *
 *   - with a mouse it follows the pointer across the bars and leaves with
 *     it;
 *   - with a finger it shows on touch and follows the drag sideways (the
 *     chart takes the pointer, so the drag does not scroll the page; a
 *     vertical drag still does, `touch-action: pan-y` in app.css), and
 *     lingers a moment after the finger lifts, so a tap can be read.
 *
 * The tip is placed against the chart's right edge, not over the bar: the
 * chart ends the row at the screen's edge, and a tip centred on the last
 * bar would run off it. The bar it is about is lit instead.
 *
 * For a screen reader nothing changes: the chart is one image whose name
 * lists every day's count, and the tip is hidden from it.
 */
function Spark({ days, peak }: { days: Array<{ day: string; n: number }>; peak: number }) {
  const [at, setAt] = useState<number | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLinger = () => {
    if (linger.current) clearTimeout(linger.current);
    linger.current = null;
  };
  useEffect(() => stopLinger, []);
  const pick = (clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (!r.width) return;
    const i = Math.floor(((clientX - r.left) / r.width) * days.length);
    setAt(Math.min(days.length - 1, Math.max(0, i)));
  };
  const active = at == null ? null : days[at] || null;
  return (
    <span className="dev-ws-hero-spark-wrap">
      <span
        ref={boxRef}
        className="dev-ws-hero-spark"
        data-ws-members-trend=""
        {...(active ? { 'data-ws-spark-active': '' } : {})}
        role="img"
        aria-label={`People taking part each day, last ${days.length} days: ${days.map((d) => Number(d.n) || 0).join(', ')}`}
        onPointerDown={(e) => {
          stopLinger();
          if (e.pointerType !== 'mouse') {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
          }
          pick(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || at != null) pick(e.clientX);
        }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setAt(null); }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') return;
          stopLinger();
          linger.current = setTimeout(() => setAt(null), TIP_LINGER_MS);
        }}
        onPointerCancel={() => { stopLinger(); setAt(null); }}
      >
        {days.map((d, i) => {
          const n = Number(d.n) || 0;
          return (
            <span
              key={d.day}
              className={(n ? 'dev-ws-hero-spark-bar' : 'dev-ws-hero-spark-bar dev-ws-hero-spark-bar-quiet')
                + (i === at ? ' dev-ws-hero-spark-bar-on' : '')}
              style={{ height: `${n && peak ? Math.max(12, Math.round((n / peak) * 100)) : 8}%` }}
            />
          );
        })}
      </span>
      {active ? (
        <span className="dev-ws-hero-spark-tip" aria-hidden="true" data-ws-spark-tip="">
          <span className="dev-ws-hero-spark-tip-day">{sparkTip(active)}</span>
          <span className="dev-ws-hero-spark-tip-cap">Who took part, last 14 days</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The hero's activity line (#3268): who was around this week and what
 * shipped this month, in words, with the last fourteen days as a small bar
 * chart at its end. A zero says nothing; a fortnight in which nobody did
 * anything is one quiet sentence instead of fourteen slivers.
 */
export function HeroActivity({ activity }: { activity: CommunityPayload['activity'] | null | undefined }) {
  const days = activity?.daily || [];
  const active = Number(activity?.active_week) || 0;
  const shipped = Number(activity?.shipped_month) || 0;
  const peak = Math.max(0, ...days.map((d) => Number(d.n) || 0));
  if (!active && !shipped && !peak) {
    return (
      <p className="dev-ws-hero-line" data-ws-members-trend="" data-ws-trend-empty="">
        Nobody has been around in the last 14 days.
      </p>
    );
  }
  return (
    <div className="dev-ws-hero-activity" data-ws-members-stats="">
      <span className="dev-ws-hero-activity-words">
        <span className="dev-ws-hero-activity-line">
          {active ? <span data-ws-members-cell="active"><b>{active}</b> active this week</span> : null}
          {active && shipped ? ' · ' : null}
          {shipped ? <span data-ws-members-cell="shipped"><b>{shipped}</b> shipped this month</span> : null}
          {!active && !shipped ? 'Quiet this week' : null}
        </span>
      </span>
      {days.length >= 2 ? <Spark days={days} peak={peak} /> : null}
    </div>
  );
}

/**
 * Open the visibility proposal (POST /api/apps/:slug/visibility-pr) that
 * makes a project public or private. A public community is public to use and
 * to build; a private community is private to both, as the create dialog
 * maps them. A 409 is one already up, which the hero shows either way, so it
 * is not an error. Throws with words a person can read.
 */
export async function proposeAudience(slug: string, to: 'public' | 'private'): Promise<void> {
  const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/visibility-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(to === 'private'
      ? { collabVisibility: 'private', viewVisibility: 'private' }
      : { collabVisibility: 'public', viewVisibility: 'public' }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body && body.error) || 'That did not go through. Try again.');
  }
}

/** What making it private means, said before it is proposed. */
export const MAKE_PRIVATE_LINE = 'Only people who are invited can see it and build it. '
  + 'Members vote on this first, and it applies once it merges.';

/**
 * "Make it private", from the hub's ⋯ (../actions-row.tsx DevPlusMenu's
 * `onMakePrivate`). It was a button in the hero beside Invite; it is a
 * setting, so it lives with the settings. The same question the hero's
 * popup asked, as the platform's confirm (the kit's alert, which a row of
 * the touch action sheet can present, as App display name's prompt does),
 * then the same proposal, then the hero re-reads and shows it up for a vote.
 */
export async function confirmMakePrivate(slug: string, name: string): Promise<void> {
  const ui = (window as any).PlatformUI;
  if (!ui || typeof ui.confirm !== 'function') return;
  const ok = await ui.confirm({
    title: `Make ${name} a private community?`,
    message: MAKE_PRIVATE_LINE,
    confirmLabel: 'Propose making it private',
    cancelLabel: 'Not now',
  });
  if (!ok) return;
  try {
    await proposeAudience(slug, 'private');
  } catch (err) {
    ui.toast?.(err instanceof Error ? err.message : 'That did not go through. Try again.');
    return;
  }
  await reloadCommunity(slug);
}

/**
 * "Make it public" (it was "Open it up"): the audience change as a question
 * under its button, the Join popup's shape. The answer opens the visibility
 * PR; the hero then re-reads and shows it as up for a vote. Only this way
 * round: "Make it private" is the ⋯'s (confirmMakePrivate, above).
 */
function MakePublic({ slug, name, onOpened }: {
  slug: string;
  name: string;
  onOpened: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || btnRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  const propose = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await proposeAudience(slug, 'public');
      setOpen(false);
      onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="dev-ws-join-anchor">
      <Button
        ref={btnRef}
        type="button"
        variant="pillNeutral"
        size="sm"
        ink="neutral"
        data-ws-community-audience-change="open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setError(''); setOpen((v) => !v); }}
      >
        Make it public
      </Button>
      {open ? (
        <div
          ref={popRef}
          className="dev-ws-join-pop"
          role="dialog"
          aria-label={`Make ${name} a public community?`}
          data-ws-audience-pop=""
        >
          <p className="dev-ws-ask-q">{`Make ${name} a public community?`}</p>
          <p className="dev-ws-vote-sub">
            Anyone can find it on Discover, join, and propose changes. Members vote on this first, and it applies once it merges.
          </p>
          {error ? <p className="dev-ws-audience-error" role="alert" data-ws-audience-error="">{error}</p> : null}
          <div className="dev-ws-answer-row">
            <button
              type="button"
              className="dev-ws-answer-btn dev-ws-answer-join"
              data-ws-audience-answer="propose"
              autoFocus
              disabled={busy}
              onClick={() => { void propose(); }}
            >
              Propose making it public
            </button>
          </div>
          <button type="button" className="dev-ws-vote-later" data-ws-audience-answer="later" onClick={() => setOpen(false)}>
            Not now
          </button>
        </div>
      ) : null}
    </span>
  );
}

/**
 * Whether the hub's ⋯ offers "Make it private": a public community, to
 * whoever may open the visibility proposal (`can_manage`, the route's own
 * rule), while no change to who it is for is already up for a vote.
 */
export function canMakePrivate(data: Pick<CommunityPayload, 'audience' | 'can_manage' | 'audience_change'> | null | undefined): boolean {
  return !!data && data.audience === 'open' && !!data.can_manage && !data.audience_change;
}

export function CommunityCard({ slug, name, menu, canOpenApp = false }: {
  slug: string;
  /** The app's identity as the page already knows it (improveStore), so the
      hero draws the same tile and name as the header's chip. */
  name?: string;
  /** The ⋯ and its menu (../actions-row.tsx DevPlusMenu), last on the
      members row. The page renders it so its props stay the page's. */
  menu?: ReactNode;
  /** Whether "Open app" leads the actions (#3367): every project but the
      platform's own, which is the page you are on. */
  canOpenApp?: boolean;
}) {
  const data = useCommunity(slug);
  const [busy, setBusy] = useState(false);
  // The open Join question, if one is: its answer goes back to whoever asked
  // (lib/join-required.ts's offerJoin), which does the joining.
  const [asking, setAsking] = useState<null | { answer: (ok: boolean) => void }>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const joinRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const load = () => reloadCommunity(slug);

  // THE ANCHOR. While this card shows a Join button, the question for this
  // app is asked here. `visible` is what stops a card on a screen that is
  // mounted but hidden from swallowing a question asked in Messages. On the
  // way out, a question still open is answered No, so nothing waits forever.
  const canJoin = !!data && !data.is_member;
  useEffect(() => {
    if (!canJoin) return undefined;
    let open: ((ok: boolean) => void) | null = null;
    const off = registerJoinAnchor(slug, {
      visible: () => !!joinRef.current && joinRef.current.getClientRects().length > 0,
      ask: () => new Promise<boolean>((resolve) => {
        open = resolve;
        setAsking({
          answer: (ok) => {
            open = null;
            setAsking(null);
            resolve(ok);
          },
        });
        cardRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      }),
    });
    return () => {
      off();
      if (open) open(false);
    };
  }, [slug, canJoin]);

  // Closing it: Escape, or a press anywhere outside the popup. A listener
  // rather than a scrim, because this card is `.dev-ws-strip`, whose
  // backdrop-filter makes it the containing block for anything fixed inside
  // it — a full-screen scrim drawn here would cover the card and nothing else.
  useEffect(() => {
    if (!asking) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') asking.answer(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || joinRef.current?.contains(t))) return;
      asking.answer(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [asking]);

  // BEFORE THE READ: the actions that depend on nothing the read says (Open
  // app and the ⋯), so a read that fails cannot take the project's settings
  // off the page. The name and tile are the coloured header's now.
  const openApp = canOpenApp ? (
    <button
      type="button"
      className="dev-ws-open-app"
      data-ws-community-open-app=""
      onClick={() => { (window as any).App?.openAppTab?.(slug, 'app'); }}
    >
      <PlayIcon className="w-3 h-3" aria-hidden="true" />
      Open app
    </button>
  ) : null;
  if (!data) {
    return (openApp || menu) ? (
      <section className="dev-ws-hero" data-ws-community-pending="">
        <div className="dev-ws-hero-row"><div className="dev-ws-hero-actions">{openApp}{menu}</div></div>
      </section>
    ) : null;
  }

  // The button asks the same question every other refusal asks, through the
  // same function, which finds this card as its anchor.
  const join = async () => {
    if (busy) return;
    if (asking) { asking.answer(false); return; }
    setBusy(true);
    try {
      await offerJoin({ code: 'join_required', app: { slug, name: name || data.name || slug } });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const leave = async () => {
    const home = (window as any).Home;
    if (!home?.setMembership || busy) return;
    setBusy(true);
    try {
      await home.setMembership(slug, false);
    } finally {
      setBusy(false);
      void load();
    }
  };

  // Invite is a MEMBER's (#3362): an invite link can be made by anyone in
  // the community (services/community-invites.js), and the pane says so when
  // the viewer cannot make one yet. Collaborators and approvals stay behind
  // the ⋯'s own gate.
  const displayName = name || data.name || slug;
  const solo = data.audience === 'solo';
  // YOU AND THIS PROJECT, at the end of the action row: Join, or Joined.
  const membership = !data.is_member ? (
    <span className="dev-ws-join-anchor">
      <Button
        ref={joinRef}
        type="button"
        variant="pillAccent"
        size="sm"
        ink="solid"
        data-ws-community-join=""
        aria-haspopup="dialog"
        aria-expanded={!!asking}
        disabled={busy && !asking}
        onClick={() => { void join(); }}
      >
        Join
      </Button>
      {asking ? (
        <div
          ref={popRef}
          className="dev-ws-join-pop"
          role="dialog"
          aria-label={`Join ${displayName}?`}
          data-ws-join-pop=""
        >
          <p className="dev-ws-ask-q">Join {displayName}?</p>
          <p className="dev-ws-vote-sub">Members start changes, file requests, vote and chat here.</p>
          <div className="dev-ws-answer-row">
            <button
              type="button"
              className="dev-ws-answer-btn dev-ws-answer-join"
              data-ws-join-answer="join"
              autoFocus
              onClick={() => asking.answer(true)}
            >
              Join
            </button>
          </div>
          <button type="button" className="dev-ws-vote-later" data-ws-join-answer="later" onClick={() => asking.answer(false)}>
            Not now
          </button>
        </div>
      ) : null}
    </span>
  ) : data.is_creator ? null : (
    // JOINED IS THE LEAVE CONTROL. A state you can see, with a check, and a
    // tap asks before it takes you out (Home.setMembership), the same pill
    // Discover draws. Outlined, not filled: it shares a row with Open app,
    // and a settled state should not be the loudest thing in it. The creator
    // gets none: they cannot leave what they started.
    <Button
      type="button"
      variant="pillNeutral"
      size="sm"
      ink="neutral"
      className="dev-ws-joined inline-flex items-center gap-1"
      data-ws-community-leave=""
      title={`Joined. Tap to leave ${displayName}`}
      disabled={busy}
      onClick={() => { void leave(); }}
    >
      <CheckIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />
      Joined
    </Button>
  );

  return (
    <section
      ref={cardRef}
      className="dev-ws-hero"
      data-ws-community=""
      data-audience={data.audience}
      // Lifted while the popup is open: the popup hangs below the hero, over
      // the card after it.
      style={asking ? { position: 'relative', zIndex: 5 } : undefined}
    >
      {/* WHO IS HERE, AND WHO IT IS FOR: the faces, then "Public community ·
          23 members". The tile and the name are the coloured header's. */}
      <HeroPeople
        members={solo ? [] : data.members}
        count={Number(data.member_count) || 0}
        audience={data.audience}
        audienceLabel={data.audience_label}
      />
      {data.description ? (
        <p className="dev-ws-hero-desc" data-ws-community-description="">{data.description}</p>
      ) : null}
      {/* WHAT YOU CAN DO HERE, one row: Open app in the community's colour,
          Invite, "Make it public" (a private community only: a public one's
          "Make it private" is a row of the ⋯), the ⋯, and across from them
          Join or Joined. A project that is just yours grows from its Share
          it card instead (ShareItCard), so its row keeps Open app and the ⋯.
          The ⋯ stays LAST among the actions (its menu hangs off its right
          edge); Join or Joined is the row's, pushed to the far end. */}
      <div className="dev-ws-hero-row">
      <div className="dev-ws-hero-actions">
        {openApp}
        {data.is_member && !solo ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-community-invite=""
            title="Invite people with a link"
            onClick={openInviteLinks}
          >
            Invite
          </Button>
        ) : null}
        {data.can_manage && !data.audience_change && data.audience === 'invited' ? (
          <MakePublic slug={slug} name={displayName} onOpened={() => { void load(); }} />
        ) : null}
        {menu}
      </div>
      {membership ? <span className="dev-ws-hero-member">{membership}</span> : null}
      </div>
      {solo ? null : <HeroActivity activity={data.activity} />}
      {data.audience_change ? (
        <a
          className="dev-ws-hero-line dev-ws-hero-pending"
          href={`#app/${encodeURIComponent(slug)}/dev/proposals/${data.audience_change.session_id}`}
          data-ws-community-audience-pending={String(data.audience_change.session_id)}
        >
          {audienceChangeLine(data.audience_change.title)}
          <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

/**
 * SHARE IT: how a project that is just yours grows, at the foot of its hub.
 * The same two levers the hero offers a community (Invite makes it a private
 * community; "Make it public" proposes making it public, voted in like any other
 * line of dapp.json), gathered under one line that says what they do, since
 * on a project of one they are the whole of what there is to do with people.
 * Offered to exactly whom the hero would offer them; nothing when neither
 * applies, and nothing until the shared read has answered.
 */
export function ShareItCard({ slug, name }: { slug: string; name?: string }) {
  const data = useCommunity(slug);
  if (!data || data.audience !== 'solo') return null;
  const canInvite = !!data.is_member;
  const canOpenUp = !!data.can_manage && !data.audience_change;
  if (!canInvite && !canOpenUp) return null;
  return (
    <section className="dev-ws-strip dev-ws-share" data-ws-share="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Share it</span>
      </div>
      <p className="dev-ws-strip-text">Invite people to make it a private community, or make it public so anyone can join.</p>
      <div className="dev-ws-share-actions">
        {canInvite ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-share-invite=""
            onClick={openInviteLinks}
          >
            Invite people
          </Button>
        ) : null}
        {canOpenUp ? (
          <MakePublic slug={slug} name={name || data.name || slug} onOpened={() => { void reloadCommunity(slug); }} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * HOW A CHANGE GETS IN, on the Workshop page: the approval rule, read from
 * the server rather than restated here (GET /api/apps/:slug/community,
 * `approval`), as the headline number an unopposed change needs. It is a
 * headline and it says so ("to merge", not "exactly") because opposition
 * raises it and the quiet-week path can merge below it
 * (services/active-users.js). It was the hero's last line; it sits with the
 * work it governs now. Nothing until the shared read has answered.
 */
export function ApprovalRules({ slug }: { slug: string }) {
  const data = useCommunity(slug);
  if (!data || !data.approval) return null;
  return (
    <section className="dev-ws-strip" data-ws-approval-rules="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Approval rules</span>
      </div>
      <p className="dev-ws-rules-line" data-ws-community-rule="">{approvalLine(data.approval)}</p>
      <p className="dev-ws-rules-sub">Changing a rule is a proposal too, applied once it is voted in.</p>
    </section>
  );
}
