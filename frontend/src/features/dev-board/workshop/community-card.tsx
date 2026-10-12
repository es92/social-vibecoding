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
 *   WHAT IT IS. The app's tile and name, the page's one large heading (the
 *   header chip's, from the page's own store), over who it is for, and
 *   dapp.json's one-line description when it has one (HeroIdentity).
 *
 *   WHO IT IS FOR. The audience, in the words people see (Public community,
 *   Private community, Just you), with how many are in it, "Public community
 *   · 266 members", under the name; and for a public or a private community
 *   WHO IS AROUND: this week's faces, "40 active this week" and their names
 *   (HeroActive). That is all the hub says about activity: it is who is
 *   here, not a dashboard of how they performed. The fortnight's small
 *   chart that sat beside the faces (#3268) is gone, and the hub draws no
 *   charts.
 *
 *   JOIN, JOINED, INVITE, ⋯. Membership sits across from the name, because
 *   it is a fact about you and this project, the way a profile's Follow
 *   sits across from the person's name. An outsider sees Join, which asks
 *   in a popup under itself (below). A member sees Joined, which is also
 *   the way out: a tap asks before leaving, the same pill Discover draws.
 *   What you can DO here ends the members row: Invite opens Members &
 *   approvals, where the roster, invites and approvers are managed, for
 *   exactly whom the ⋯ menu offers it, and the ⋯ itself (`menu`, the
 *   page's DevPlusMenu) holds Suggest an improvement and the project's settings.
 *   This hero lists; it does not manage.
 *
 *   MAKE IT PUBLIC. Who a project is for can grow after it exists: Invite
 *   makes a Just-you project a private community, and "Make it public" (it
 *   was "Open it up") makes it a public one. Taking a public community back
 *   is the Who can see & change it sheet's (#4666,
 *   ../../dialogs/who-decides.tsx, from the ⋯ and the rule line's Rules):
 *   narrowing who a project is for is a setting, not an invitation, and the
 *   hero's row is for asking people in. That is a visibility change, POST
 *   /api/apps/:slug/visibility-pr here and /who-decides-pr in the sheet,
 *   offered to the same people the routes let open it (`can_manage`). It is a PROPOSAL, not a switch: dapp.json
 *   says who a project is for, so the change is voted in like any other
 *   line of it and applies once it merges. While one is up, the hero says
 *   so and links to it instead of offering a second.
 *
 *   HOW A CHANGE GETS IN is not on the hero any more. The approval rule is
 *   the last line of the Workshop's Overview card (ApprovalLine, below),
 *   beside the work it governs: on the hero it was a line about process
 *   between who is here and the channel.
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

import { useEffect, useReducer, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronRightIcon, LockIcon, PersonSilhouetteIcon, PlayIcon, ShieldCheckIcon, UserGroupIcon, UserIcon } from '@/components/ui/icons';
import { swatchFor } from '../../messages/format';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { offerJoin, registerJoinAnchor } from '../../../lib/join-required';
import { AppIconContent, appIconKind } from '../../apps/app-card-view';
import { askToVerifyForPublic, identityNeededHere } from '../../auth/verify-identity';
import { invitedByLine, joinByInvite, useInviteOffer, type InviteJoin, type InviteOffer } from './invite-offer';
import { hubShot, hubShotPayload } from './hub-shot';
import { changeHref } from '../../../lib/change-href';
import type { ApprovalPayload } from '../../who-decides/model';

type Audience = 'open' | 'invited' | 'solo';

/**
 * The first version Homeroom bot is building from the project's
 * description, while it builds it (routes/apps.js hubFirstVersion): the
 * App tab's state, cut to what the hub says. Null once it is live, or when
 * the bot is not building one.
 */
export type HubFirstVersion = {
  step: number | null;
  of: number | null;
  /** #4053: its build line for this viewer (homeroom-bot-progress.js
      buildLineOf), the App tab's and the made screen's; the words are
      ../../first-session/build-line.tsx's, never written here. */
  line: string | null;
  /** Built and up for approval: ready to try. */
  ready: boolean;
  /** The description is the viewer's. */
  mine: boolean;
  creator: string | null;
  /** What it waits on from its maker, for them alone. */
  waits_on: 'plan' | 'question' | null;
  /** The maker's DM with the bot, for them alone. */
  conversation_id: number | null;
  /** The change, once it is ready to try. */
  session_id: number | null;
  /** #4074: the plan waiting for its maker's Build it, read only, for a
      member who did not start it (routes/apps.js sharedPlan); #4396: the
      plan its maker chose, while it is built and tested; else null. */
  plan?: {
    bullets: string[];
    questions: Array<{ question: string; suggested: string | null }>;
  } | null;
};

/** One channel of a project (#4417): #general, or one of its topics. */
export interface PlaceChannel {
  /** The topic's registry row (its channel's thread ref); null for #general. */
  id: number | null;
  kind: 'general' | 'topic';
  /** The topic's category key (dapp.json `id`); null for #general. */
  key: string | null;
  handle: string;
  /** Handles it had before a rename, which still find it. */
  aliases: string[];
  name: string;
  about: string;
  icon: string;
  state: 'live' | 'archived' | 'merged';
  /** A merged topic: the key of the topic it joined, and when. */
  merged_into: string | null;
  merged_at: string | null;
  /** Open requests filed under it; null for #general and retired topics. */
  requests: number | null;
  unread: number;
  /** The figures its channel shows above the room (topic-figures.tsx);
      empty for #general and for a topic that names none. */
  figures?: string[];
}

export interface PlacesPayload {
  /** Votes waiting on the viewer here, or null when not counted. */
  owed: number | null;
  channels: PlaceChannel[];
  /** Topic proposals waiting for a vote (the Topics dialog lists them). */
  proposals?: Array<{ session_id: number; pr_number: number | null; pr_url: string | null; title: string | null }>;
}

export type CommunityPayload = {
  slug: string;
  name?: string;
  /** dapp.json's one-line description, or the first sentence of the
      description it was made from when dapp.json has none yet. */
  description?: string | null;
  /** #4045: made under seven days ago (never the platform's own): the hub
      leaves out what is still empty (decision D). */
  first_week?: boolean;
  /** #4045: the viewer has a live invite link for a project that is still
      just theirs, so the hub draws open seats beside their face instead of
      "Just you". Only ever true for a member, on a Just you project. */
  invite_link?: boolean;
  first_version?: HubFirstVersion | null;
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
  /** Who has been around lately (communities.js activitySummary): the
      hub's people row reads the week's count and up to five of its people
      by name, most recent first. `daily` is the last fourteen days, oldest
      first, as people per day; the hub draws no chart of it. */
  activity?: {
    active_week: number;
    shipped_month: number;
    daily?: Array<{ day: string; n: number }>;
    active_people?: Array<{ id: number; username: string; display_name?: string | null }>;
  } | null;
  /** Whether this viewer may propose who the project is for (the creator,
      an app admin or a platform admin; never the platform's own app). */
  can_manage?: boolean;
  /** An audience change already up for a vote, if one is. */
  audience_change?: { session_id: number; pr_number: number | null; title: string | null } | null;
  /**
   * #4417: THE PLACES — what the project's list says beside each of its
   * places: the votes owed here, and every channel, #general first, then
   * each topic in dapp.json's order, retired ones included and marked so
   * (the list draws the live ones). Null when it could not be read.
   */
  places?: PlacesPayload | null;
  approval: ApprovalPayload;
  /** #4666: who can see and build it, as the two columns say. */
  visibility?: { build: 'public' | 'private'; view: 'public' | 'private' } | null;
  /** #4666: a change to who can see and change it already up for a vote. */
  who_decides_change?: { session_id: number; pr_number: number | null; title: string | null } | null;
};

/**
 * The rule's sentences for one kind of voter, as message ids. Each is the
 * whole sentence, because who has to say yes is worded by how many that is
 * out of how many: "2 of the 12 active members", "both active members", "the
 * only approver". A count dapp.json set can name more people than there are
 * (`short`), and then says how many there are. The `Quiet` ones add the
 * path that needs one Yes and no objection.
 */
type RuleIds = {
  some: string; someQuiet: string;
  short: string; shortQuiet: string;
  only: string;
  both: string; bothQuiet: string;
  all: string; allQuiet: string;
};

const APPROVER_RULE: RuleIds = {
  some: 'project:communityCard.rule.approvers.some',
  someQuiet: 'project:communityCard.rule.approvers.someQuiet',
  short: 'project:communityCard.rule.approvers.short',
  shortQuiet: 'project:communityCard.rule.approvers.shortQuiet',
  only: 'project:communityCard.rule.approvers.only',
  both: 'project:communityCard.rule.approvers.both',
  bothQuiet: 'project:communityCard.rule.approvers.bothQuiet',
  all: 'project:communityCard.rule.approvers.all',
  allQuiet: 'project:communityCard.rule.approvers.allQuiet',
};

const MEMBER_RULE: RuleIds = {
  some: 'project:communityCard.rule.members.some',
  someQuiet: 'project:communityCard.rule.members.someQuiet',
  short: 'project:communityCard.rule.members.short',
  shortQuiet: 'project:communityCard.rule.members.shortQuiet',
  only: 'project:communityCard.rule.members.only',
  both: 'project:communityCard.rule.members.both',
  bothQuiet: 'project:communityCard.rule.members.bothQuiet',
  all: 'project:communityCard.rule.members.all',
  allQuiet: 'project:communityCard.rule.members.allQuiet',
};

function ruleLine(ids: RuleIds, required: number, of: number, quiet: boolean): string {
  if (required < of) return translate(quiet ? ids.someQuiet : ids.some, { count: required, total: of });
  // Counted by how many there are: that is the number English words differently.
  if (required > of) return translate(quiet ? ids.shortQuiet : ids.short, { count: of, required });
  if (of === 1) return translate(ids.only);
  if (of === 2) return translate(quiet ? ids.bothQuiet : ids.both);
  return translate(quiet ? ids.allQuiet : ids.all, { count: of });
}

/**
 * The approval rule as one sentence, in the words the rest of the page
 * uses: a change "goes live", people "approve" it. Exported and pure so the
 * wording is tested against the three regimes governance.js knows:
 *
 *   - members vote (the default): the eased threshold over the active
 *     members, or the quiet path, which needs one Yes and no objection
 *     (active-users.js lazyWindowMs) and so cannot apply when one Yes is
 *     already the threshold;
 *   - invited approvers: the same math over the approvers alone;
 *   - at least N (dapp.json's approvals_required, either policy): N
 *     approvals and no clock at all.
 *
 * First-session run-through, 5 Oct 2026: "Members vote: a change merges at
 * 2 yes votes (2 active members), or unopposed after a wait" was the
 * sentence a newcomer met here.
 */
export function approvalLine(
  approval: CommunityPayload['approval'] | null | undefined,
  viewer?: Pick<CommunityPayload, 'audience' | 'is_member'> & { is_creator?: boolean } | null,
): string {
  if (!approval) return '';
  // #4666: a preset's line, as plain text (its face and bold are the card's).
  const preset = presetSentence(approval, viewer ? { ...viewer, is_creator: !!viewer.is_creator } : viewer);
  if (preset) return translate(preset.long, preset.values).replace(/<\/?\d+>/g, '');
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  // A Just you project's one approver is the person reading it (#4246).
  if (viewer?.audience === 'solo' && viewer.is_member
    && Number(approval.electorate) === 1 && Number(approval.required) === 1) {
    return translate('project:communityCard.rule.you');
  }
  const fixed = approval.approvals_required != null;
  const quiet = !fixed && required > 1;
  if (approval.policy === 'invited') {
    return ruleLine(APPROVER_RULE, required, electorate, quiet);
  }
  if (fixed) {
    return translate('project:communityCard.rule.fixed', { count: required });
  }
  return ruleLine(MEMBER_RULE, required, electorate, quiet);
}

/** "Public community · 12 members"; "Just you" alone, because there is one. */
export function audienceLine(p: Pick<CommunityPayload, 'audience' | 'audience_label' | 'member_count'>): string {
  if (p.audience === 'solo') return p.audience_label || translate('project:communityCard.audience.justYou');
  return translate('project:communityCard.audience.withMembers', { audience: p.audience_label, count: Number(p.member_count) || 0 });
}

/**
 * #4896: "Just you so far", the hero's words for a project nobody else has
 * joined, said to the one person in it, with Invite beside it. A newcomer
 * met "Just you" on the page right after the made screen said "Your new
 * community" (onboarding run, 12 Oct 2026); "so far" says it is where the
 * project starts, not what it is. Null for anyone else, and everywhere else
 * the audience is named (lists, the Who can see & change it sheet) it keeps
 * its name, audienceLine's.
 */
export function justYouSoFar(p: Pick<CommunityPayload, 'audience'>, member: boolean): string | null {
  return p.audience === 'solo' && member ? translate('project:communityCard.audience.justYouSoFar') : null;
}

/**
 * The pending audience change in the hero's words. The PR's title is the
 * settings dialog's ("Make this app public"); the hero says what it means
 * for who the project is for.
 */
export function audienceChangeLine(title: string | null | undefined): string {
  const t = String(title || '');
  if (/ public$/.test(t)) return translate('project:communityCard.audienceChange.toPublic');
  if (/private \(collaborators only\)$/.test(t)) return translate('project:communityCard.audienceChange.toPrivate');
  return translate('project:communityCard.audienceChange.other');
}

function AudienceGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

async function readCommunity(slug: string): Promise<CommunityPayload | null> {
  // `?shot=hub-first-week` (./hub-shot.ts): a made-up first week, drawn for
  // the before/after shots in place of the server's answer.
  const shot = hubShot();
  if (shot) return hubShotPayload(slug, shot);
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
 *
 * ONE CALL, which opens the menu ON the invite pane. It was `open()` then
 * `showInvite()`, and the sheet went up twice: short, on the pane's loading
 * line, then tall when the link came, with the dim fading in again between
 * (AppContext.openInvite says why).
 */
export function openInviteLinks(): void {
  const ctx = (window as any).AppContext;
  if (!ctx) return;
  void ctx.openInvite?.();
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

/**
 * The record already read for `slug`, or null, without asking for one: for a
 * caller outside React (the chat's `#name` links, ./place-store.ts).
 */
export function cachedCommunity(slug: string): CommunityPayload | null {
  return (slug && communities.get(slug)) || null;
}

/** Whether a read of `slug`'s record is on its way. */
export function communityInflight(slug: string): boolean {
  return !!slug && inflight.has(slug);
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

/** Up to HERO_FACES faces, overlapping; nothing for nobody. */
function HeroFaces({ members }: { members: CommunityPayload['members'] | null | undefined }) {
  const faces = (members || []).slice(0, HERO_FACES);
  if (!faces.length) return null;
  return (
    <span className="dev-ws-hero-faces" aria-hidden="true">
      {faces.map((m) => (
        <span key={m.id} className="dev-ws-hero-face" style={{ background: swatchFor(m.username) }} title={`@${m.username}`}>
          {(m.username || '?').charAt(0).toUpperCase()}
        </span>
      ))}
    </span>
  );
}

/** How many faces the first week's row shows: the count says the rest. */
export const WEEK_FACES = 3;

/**
 * The seats of a project nobody has joined yet, in the colours of the
 * canvas board People (set "you-open"): one on each side of your face, pale,
 * with a person's outline in them. They are not buttons; Invite is.
 */
const SEATS = [
  { bg: '#ebefed', ink: '#cedae0' },
  { bg: '#fae5dc', ink: '#ebb199' },
] as const;

function Seat({ bg, ink }: { bg: string; ink: string }) {
  return (
    <span className="dev-ws-hero-face dev-ws-hero-seat" style={{ background: bg, color: ink }}>
      <PersonSilhouetteIcon aria-hidden="true" />
    </span>
  );
}

/**
 * The people row of a project's first week (#4045, the owner, 8 Oct 2026;
 * canvas boards Hub and People): the faces at the left, then who it is for
 * as "Private community" with its lock, and "3 people" under it.
 *
 *   Just you              the label alone: nobody else is here, and no link is
 *                         out ("Just you so far" to its member, justYouSoFar)
 *   a link is out         your face between two open seats, "Private
 *                         community" and no count: the count of one person
 *                         is the seats' whole point
 *   anyone else in it     up to three faces, the audience and "N people"
 *
 * `seats` is `invite_link` on a Just you project (GET .../community): the
 * audience the server derives stays "Just you" until somebody accepts, so the
 * hub says "Private community" itself while the seats are shown.
 */
export function WeekPeople({ members, count, audience, audienceLabel, seats }: {
  members: CommunityPayload['members'] | null | undefined;
  count: number;
  audience?: Audience;
  audienceLabel?: string;
  seats?: boolean;
}) {
  const t = useMessages('project');
  const solo = audience === 'solo';
  const shown: Audience | undefined = seats ? 'invited' : audience;
  const label = seats ? t('project:communityCard.week.privateCommunity') : audienceLabel;
  const you = (members || [])[0];
  const faces = seats ? [] : solo ? [] : (members || []).slice(0, WEEK_FACES);
  const countLine = seats || solo ? '' : t('project:communityCard.week.people', { count });
  return (
    <div className="dev-ws-hero-week-people" data-ws-members="" data-ws-seats={seats ? '' : undefined}>
      {seats && you ? (
        <span className="dev-ws-hero-faces dev-ws-hero-seats" aria-hidden="true">
          <Seat {...SEATS[0]} />
          <span className="dev-ws-hero-face" style={{ background: swatchFor(you.username) }} title={`@${you.username}`}>
            {(you.username || '?').charAt(0).toUpperCase()}
          </span>
          <Seat {...SEATS[1]} />
        </span>
      ) : faces.length ? (
        <span className="dev-ws-hero-faces" aria-hidden="true">
          {faces.map((m) => (
            <span key={m.id} className="dev-ws-hero-face" style={{ background: swatchFor(m.username) }} title={`@${m.username}`}>
              {(m.username || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
      ) : null}
      <span className="dev-ws-hero-week-who" data-ws-members-cell="members">
        {label ? (
          <span className="dev-ws-hero-audience" data-ws-community-audience="">
            {shown ? <AudienceGlyph audience={shown} /> : null}
            <b>{label}</b>
          </span>
        ) : null}
        {countLine ? <span className="dev-ws-hero-week-count">{countLine}</span> : null}
      </span>
    </div>
  );
}

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
  return (
    <div className="dev-ws-hero-people" data-ws-members="">
      <HeroFaces members={members} />
      <HeroCount count={count} audience={audience} audienceLabel={audienceLabel} />
      {children}
    </div>
  );
}

/** "Public community · 23 members", the audience's glyph leading it. */
function HeroCount({ count, audience, audienceLabel }: { count: number; audience?: Audience; audienceLabel?: string }) {
  const t = useMessages('project');
  const solo = audience === 'solo';
  return (
    <span className="dev-ws-hero-count" data-ws-members-cell="members">
      {!audienceLabel ? (solo ? null : t('project:communityCard.people.members', { count }))
        : solo ? <AudienceLabel audience={audience}>{audienceLabel}</AudienceLabel>
          : (
            // One message: the audience, drawn with its glyph, then the count.
            <RichMessage
              id="project:communityCard.people.audienceMembers"
              values={{ audience: audienceLabel, count }}
              components={[<AudienceLabel audience={audience} />]}
            />
          )}
    </span>
  );
}

/** The audience's words in bold, its glyph leading them. */
function AudienceLabel({ audience, children }: { audience?: Audience; children?: ReactNode }) {
  return (
    <span className="dev-ws-hero-audience" data-ws-community-audience="">
      {audience ? <AudienceGlyph audience={audience} /> : null}
      <b>{children}</b>
    </span>
  );
}

/**
 * WHO IS AROUND, BY NAME (the hub's people row): up to HERO_FACES faces of
 * the people active this week (GET .../community `activity.active_people`,
 * most recently active first), "+N" for the rest of them, then "40 active
 * this week" over their names, "evan, talha, zura, scraido2, kempis and 35
 * more". The count is the week's (`active_week`), so the names are some of
 * the people it counts. On a phone the names give way first.
 *
 * That is all the hub says about activity: it is who is here, not a
 * dashboard of how they performed, so it draws no chart. A zero says
 * nothing: with nobody around this week there is no row.
 */
export function HeroActive({ activity }: { activity: CommunityPayload['activity'] | null | undefined }) {
  const t = useMessages('project');
  const count = Number(activity?.active_week) || 0;
  if (!count) return null;
  const people = (activity?.active_people || []).filter((p) => p && p.username).slice(0, HERO_FACES);
  const rest = Math.max(0, count - people.length);
  const names = listText(people.map((p) => p.username));
  return (
    <div className="dev-ws-hero-active" data-ws-members="" data-ws-active-people={String(count)}>
      {people.length ? (
        <span className="dev-ws-hero-faces" aria-hidden="true">
          {people.map((p) => (
            <span key={p.id} className="dev-ws-hero-face" style={{ background: swatchFor(p.username) }} title={`@${p.username}`}>
              {(p.username || '?').charAt(0).toUpperCase()}
            </span>
          ))}
          {rest ? <span className="dev-ws-hero-face dev-ws-hero-face-more">{t('project:hub.people.moreFaces', { count: rest })}</span> : null}
        </span>
      ) : null}
      <span className="dev-ws-hero-active-words">
        <span className="dev-ws-hero-active-n" data-ws-members-cell="active">{t('project:hub.people.active', { count })}</span>
        {people.length ? (
          <span className="dev-ws-hero-active-names" data-ws-active-names="">
            {rest ? t('project:hub.people.namesAndMore', { names, count: rest }) : names}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * WHAT IT IS, AND WHO IT IS FOR (the hub's head): the project's tile and
 * name, the page's one large heading, over "Public community · 266 members"
 * (Just you alone, for a project that is just yours: "Just you so far" to
 * the one person in it, justYouSoFar). The tile and name are the page's own
 * record of the app (improveStore, the header chip's), else the community
 * record's name and a letter.
 */
function HeroIdentity({ slug, name, iconUrl, iconEmoji, data, member }: {
  slug: string;
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  data: CommunityPayload;
  member: boolean;
}) {
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  const solo = data.audience === 'solo';
  const count = Number(data.member_count) || 0;
  return (
    <div className="dev-ws-hero-id" data-ws-community-id="">
      <span className="app-icon-tile dev-ws-hero-tile" data-icon={appIconKind(app)} aria-hidden="true">
        <AppIconContent app={app} />
      </span>
      <span className="dev-ws-hero-id-text">
        <h1 className="dev-ws-hero-name" data-ws-community-name="">{name}</h1>
        <span className="dev-ws-hero-id-sub" data-ws-members-cell="members">
          {solo || !data.audience_label ? (
            <span className="dev-ws-hero-audience" data-ws-community-audience="">{justYouSoFar(data, member) || audienceLine(data)}</span>
          ) : (
            <RichMessage
              id="project:communityCard.people.audienceMembers"
              values={{ audience: data.audience_label, count }}
              components={[<span className="dev-ws-hero-audience" data-ws-community-audience="" />]}
            />
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * Open the visibility proposal (POST /api/apps/:slug/visibility-pr) that
 * makes a project public or private. A public community is public to use and
 * to build; a private community is private to both, as the create dialog
 * maps them. A 409 is one already up, which the hero shows either way, so it
 * is not an error. Throws with words a person can read.
 *
 * #4378: making it public needs a verified owner. The route answers
 * `identity_required` for one who is not; then the verify sheet asks, and
 * once a phone is linked the proposal is sent again. Resolves false when
 * they said Not now (the project stays private), true once it is up.
 */
export async function proposeAudience(slug: string, to: 'public' | 'private'): Promise<boolean> {
  const send = () => fetch(`/api/apps/${encodeURIComponent(slug)}/visibility-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(to === 'private'
      ? { collabVisibility: 'private', viewVisibility: 'private' }
      : { collabVisibility: 'public', viewVisibility: 'public' }),
  });
  let res = await send();
  if (!res.ok && res.status !== 409) {
    let body = await res.json().catch(() => ({}));
    if (body && body.code === 'identity_required') {
      if (!(await askToVerifyForPublic())) return false;
      res = await send();
      if (res.ok || res.status === 409) return true;
      body = await res.json().catch(() => ({}));
    }
    throw new Error((body && body.error) || translate('project:communityCard.audienceChange.failed'));
  }
  return true;
}

/**
 * Before "Make it public" asks its question: an owner the verified-identity
 * rule still holds is asked to verify first ("Verify to make it public").
 * True to go on as before; false for Not now, which leaves it private.
 */
export async function verifiedToGoPublic(): Promise<boolean> {
  if (!identityNeededHere()) return true;
  return askToVerifyForPublic();
}

/** What making it public means, said before it is proposed (the Share it popup and ⋯'s confirm): a message id. */
export const MAKE_PUBLIC_LINE = 'project:communityCard.makePublic.explain';

/**
 * Leave, from the hub's ⋯ (#4045): it was the hero's Joined pill. Whether
 * the ⋯ offers it: a member who did not start the project (they cannot
 * leave what they started).
 */
export function canLeave(data: Pick<CommunityPayload, 'is_member' | 'is_creator'> | null | undefined): boolean {
  return !!data && !!data.is_member && !data.is_creator;
}

/** Leave the community: Home.setMembership asks first, then the hub re-reads. */
export async function leaveCommunity(slug: string): Promise<void> {
  const home = (window as any).Home;
  if (!slug || !home?.setMembership) return;
  try {
    await home.setMembership(slug, false);
  } finally {
    await reloadCommunity(slug);
  }
}

/**
 * "Make it public" on a project that is just yours (ShareItCard): the
 * audience change as a question under its button, the Join popup's shape. The answer opens the visibility
 * PR; the hero then re-reads and shows it as up for a vote. Only this way
 * round: who can see a project is the Who can see & change it sheet's
 * (../../dialogs/who-decides.tsx), from the ⋯ and the rule line's Rules.
 */
function MakePublic({ slug, name, onOpened }: {
  slug: string;
  name: string;
  onOpened: () => void;
}) {
  const t = useMessages('project');
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
      const proposed = await proposeAudience(slug, 'public');
      setOpen(false);
      if (proposed) onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:communityCard.audienceChange.failed'));
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
        onClick={() => {
          setError('');
          if (open) { setOpen(false); return; }
          // #4378: an owner still to verify is asked first; Not now leaves it private.
          void verifiedToGoPublic().then((go) => { if (go) setOpen(true); });
        }}
      >
        {t('project:communityCard.share.makePublic')}
      </Button>
      {open ? (
        <div
          ref={popRef}
          className="dev-ws-join-pop"
          role="dialog"
          aria-label={t('project:communityCard.makePublic.question', { project: name })}
          data-ws-audience-pop=""
        >
          <p className="dev-ws-ask-q">{t('project:communityCard.makePublic.question', { project: name })}</p>
          <p className="dev-ws-vote-sub">{t(MAKE_PUBLIC_LINE)}</p>
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
              {t('project:communityCard.makePublic.propose')}
            </button>
          </div>
          <button type="button" className="dev-ws-vote-later" data-ws-audience-answer="later" onClick={() => setOpen(false)}>
            {t('project:communityCard.makePublic.notNow')}
          </button>
        </div>
      ) : null}
    </span>
  );
}

/**
 * WHO INVITED THEM, AND JOIN (#3700): "@maya invited you", their note, one
 * "Join <name>" as the screen's primary button, standing alone. The
 * confirm's words (./invite-offer.ts), on a page. First in the
 * hero of a page an invite link opened, and the body of a private
 * community's invite preview (../../invite-preview). `children` hang under
 * the button: the hero's Join question.
 */
export function InviteCard({ offer, name, unnamed = false, busy, onJoin, joinRef, children }: {
  offer: Pick<InviteOffer, 'inviter' | 'inviterName' | 'inviterMadeIt' | 'building' | 'note'>;
  name: string;
  /** `name` is a stand-in for a community whose name did not come with the link. */
  unnamed?: boolean;
  busy: boolean;
  onJoin: () => void;
  joinRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  // Subscribed: who invited them is read by invitedByLine.
  const t = useMessages('project');
  return (
    <div className="dev-ws-invite" data-ws-invite="">
      <p className="dev-ws-invite-from" data-ws-invite-from="">{invitedByLine(offer)}</p>
      {offer.note ? <p className="dev-ws-invite-note" data-ws-invite-note="">{t('project:communityCard.inviteCard.note', { note: offer.note })}</p> : null}
      <div className="dev-ws-join-anchor">
        <Button
          ref={joinRef}
          type="button"
          layout="full"
          variant="pillAccent"
          disabledStyle="dim"
          size="pillLg"
          ink="solid"
          data-ws-invite-join=""
          disabled={busy}
          onClick={onJoin}
        >
          {unnamed ? t('project:communityCard.inviteCard.joinUnnamed') : t('project:communityCard.inviteCard.join', { project: name })}
        </Button>
        {children}
      </div>
    </div>
  );
}

export function CommunityCard({ slug, name, iconUrl = null, iconEmoji = null, menu, canOpenApp = false, onJoinedByInvite }: {
  slug: string;
  /** The app's identity as the page already knows it (improveStore), so the
      hero draws the same tile and name as the header's chip. */
  name?: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  /** The ⋯ and its menu (../actions-row.tsx DevPlusMenu), last on the
      members row. The page renders it so its props stay the page's. */
  menu?: ReactNode;
  /** Whether "Open app" leads the actions (#3367): every project but the
      platform's own, which is the page you are on. */
  canOpenApp?: boolean;
  /** Where Join through the invite link this page was opened from lands
      (./invite-offer.ts): the page's own choice, Needs you or the hub. */
  onJoinedByInvite?: () => void;
}) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  // The invite link this page was opened from, if it was (#3700).
  const offer = useInviteOffer(slug);
  const [busy, setBusy] = useState(false);
  // The open Join question, if one is: its answer goes back to whoever asked
  // (lib/join-required.ts's offerJoin), which does the joining, unless the
  // answer is 'joined': the invite link has done it already.
  const [asking, setAsking] = useState<null | { answer: (ok: boolean | 'joined') => void }>(null);
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
    let open: ((ok: boolean | 'joined') => void) | null = null;
    const off = registerJoinAnchor(slug, {
      visible: () => !!joinRef.current && joinRef.current.getClientRects().length > 0,
      ask: () => new Promise<boolean | 'joined'>((resolve) => {
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
  // off the page. The name and tile come with the read (HeroIdentity).
  const openApp = canOpenApp ? (
    <button
      type="button"
      className="dev-ws-open-app"
      data-ws-community-open-app=""
      onClick={() => { (window as any).App?.openAppTab?.(slug, 'app'); }}
    >
      <PlayIcon className="w-3 h-3" aria-hidden="true" />
      {t('project:communityCard.openApp')}
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

  // JOIN THROUGH THE LINK this page was opened from (./invite-offer.ts),
  // which spends a use of it and tells its maker, as the confirm's Join did.
  // From the button it lands where the page says (`onJoinedByInvite`); as
  // the answer to a question a refusal asked under it, it lands nowhere, so
  // the press that met the refusal is simply sent again (offerJoin).
  const joinThroughLink = async (land: boolean): Promise<boolean> => {
    if (!offer || busy) return false;
    setBusy(true);
    let outcome: InviteJoin['outcome'] = 'failed';
    try {
      ({ outcome } = await joinByInvite(offer));
    } finally {
      setBusy(false);
      void load();
    }
    if (outcome === 'joined' && land) onJoinedByInvite?.();
    return outcome === 'joined' || outcome === 'welcomed';
  };
  const answerThroughLink = (answer: (ok: boolean | 'joined') => void) => {
    void joinThroughLink(false).then((ok) => answer(ok ? 'joined' : false));
  };

  // Invite is a MEMBER's (#3362): an invite link can be made by anyone in
  // the community (services/community-invites.js), and the pane says so when
  // the viewer cannot make one yet. Collaborators and approvals stay behind
  // the ⋯'s own gate.
  const displayName = name || data.name || slug;
  const solo = data.audience === 'solo';
  // OPENED FROM AN INVITE LINK and not in it yet (#3700): who invited them
  // and one prominent Join lead the hero, and that Join is the only one on
  // it. `?shot=invite-join` draws the same for whoever is looking, so the
  // hero is drawn as for an outsider then (`member`).
  const invited = !!offer && (!!offer.preview || !data.is_member);
  const member = data.is_member && !offer?.preview;
  // The question a refusal asks, under whichever Join is showing.
  const popup = asking ? (
    <div
      ref={popRef}
      className="dev-ws-join-pop"
      role="dialog"
      aria-label={t('project:communityCard.join.question', { project: displayName })}
      data-ws-join-pop=""
    >
      <p className="dev-ws-ask-q">{t('project:communityCard.join.question', { project: displayName })}</p>
      <p className="dev-ws-vote-sub">{t('project:communityCard.join.explain')}</p>
      <div className="dev-ws-answer-row">
        <button
          type="button"
          className="dev-ws-answer-btn dev-ws-answer-join"
          data-ws-join-answer="join"
          autoFocus
          // Busy is the row's Join waiting on this very answer; only the
          // link's join, once pressed, is something to wait out here.
          disabled={invited && busy}
          onClick={() => { if (invited) answerThroughLink(asking.answer); else asking.answer(true); }}
        >
          {t('project:communityCard.join.answer')}
        </button>
      </div>
      <button type="button" className="dev-ws-vote-later" data-ws-join-answer="later" onClick={() => asking.answer(false)}>
        {t('project:communityCard.join.notNow')}
      </button>
    </div>
  ) : null;
  // WHO INVITED THEM, AND JOIN, first in the hero: visible without scrolling
  // on a phone, above everything the page shows them to decide by (what it
  // is, who is here, Open app, and below the hero what is
  // being decided).
  const inviteHead = invited && offer ? (
    <InviteCard
      offer={offer}
      name={displayName}
      busy={busy}
      joinRef={joinRef}
      onJoin={() => {
        if (asking) { answerThroughLink(asking.answer); return; }
        void joinThroughLink(true);
      }}
    >
      {popup}
    </InviteCard>
  ) : null;
  // YOU AND THIS PROJECT, at the end of the action row: Join. Joined was
  // here too, and was the way out; Leave is a row of the ⋯ now (#4045,
  // canLeave), so a member's row is what they can do, not what they are.
  const membership = invited || data.is_member ? null : (
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
        {t('project:communityCard.join.button')}
      </Button>
      {popup}
    </span>
  );
  // #4045, DECISION D: IN ITS FIRST WEEK the hero leaves out what is still
  // empty: no fortnight of activity. The people row is the week's own
  // (WeekPeople): the faces, "Private community" over "3 people", then what
  // you can do. A pending change to who it is for is not empty, so it stays.
  const week = !!data.first_week;
  // A link is out on a project that is still just theirs: their face and
  // open seats, and the audience it is about to be (WeekPeople).
  const seats = member && solo && !!data.invite_link;
  // While its first version is on the way (or, in its first week, just
  // went live) the First version card is the way into the app: Open app
  // there, so not here too.
  const appButton = data.first_version ? null : openApp;
  const descLine = (
    <p className="dev-ws-hero-desc" data-ws-community-description="">{data.description}</p>
  );

  return (
    <section
      ref={cardRef}
      // THE HUB'S HEAD (the hub as the project's summary): out of its first
      // week, the hero leads with what it is, then who is around, and on a
      // wide window what you can do sits across from the name (app.css
      // `.dev-ws-hero-summary`). The first week keeps its own row.
      className={week ? 'dev-ws-hero' : 'dev-ws-hero dev-ws-hero-summary'}
      data-ws-community=""
      data-audience={data.audience}
      // Lifted while the popup is open: the popup hangs below the hero, over
      // the card after it.
      style={asking ? { position: 'relative', zIndex: 5 } : undefined}
    >
      {inviteHead}
      {/* WHAT IT IS AND WHO IT IS FOR: the tile and the name, the page's one
          large heading, over "Public community · 266 members". In its first
          week the First version card draws the tile and the name, and the
          people row says who it is for (WeekPeople, below). */}
      {week ? null : (
        <HeroIdentity slug={slug} name={displayName} iconUrl={iconUrl} iconEmoji={iconEmoji} data={data} member={member} />
      )}
      {data.description && !week ? descLine : null}
      {/* WHO IS AROUND: this week's faces, how many, and their names. Not on
          a project that is just yours, which has nobody else to name. */}
      {week || solo ? null : <HeroActive activity={data.activity} />}
      {/* WHAT YOU CAN DO HERE, one row: Open app in the community's colour,
          Invite, the ⋯, and across from them Join. "Make it public" and
          "Make it private" are rows of the ⋯ (#4045), and so is Leave. A
          project that is just yours offers Invite here too, beside "Just
          you so far" (#4896): it was left to the Share it card at the foot
          of the hub (ShareItCard), and a newcomer met "Just you" with
          nothing beside it. The ⋯ stays LAST among the actions; Join is the
          row's, pushed to the far end. */}
      <div className="dev-ws-hero-row">
      {week ? (
        <WeekPeople
          members={data.members}
          count={Number(data.member_count) || 0}
          audience={data.audience}
          audienceLabel={justYouSoFar(data, member) || data.audience_label}
          seats={seats}
        />
      ) : null}
      <div className="dev-ws-hero-actions">
        {appButton}
        {member ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-community-invite=""
            title={t('project:communityCard.invite.title')}
            onClick={openInviteLinks}
          >
            {t('project:communityCard.invite.button')}
          </Button>
        ) : null}
        {menu}
      </div>
      {membership ? <span className="dev-ws-hero-member">{membership}</span> : null}
      </div>
      {/* The app's one line sits under the week's people row (canvas board Hub). */}
      {data.description && week ? descLine : null}
      {data.audience_change ? (
        <a
          className="dev-ws-hero-line dev-ws-hero-pending"
          href={changeHref(slug, data.audience_change.session_id, data.audience_change.pr_number)}
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
 *
 * While Homeroom bot builds its first version (the First version card above
 * it, ./hub-cards.tsx), the line says what an invite is for right now, in
 * the made screen's words: people can follow along while it is being built.
 */
export function shareItLine(building: boolean): string {
  return building
    ? translate('project:communityCard.share.lineBuilding')
    : translate('project:communityCard.share.line');
}

export function ShareItCard({ slug, name }: { slug: string; name?: string }) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  if (!data || data.audience !== 'solo') return null;
  const canInvite = !!data.is_member;
  const canOpenUp = !!data.can_manage && !data.audience_change;
  if (!canInvite && !canOpenUp) return null;
  return (
    <section className="dev-ws-strip dev-ws-share" data-ws-share="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{t('project:communityCard.share.title')}</span>
      </div>
      <p className="dev-ws-strip-text">{shareItLine(!!data.first_version && !data.first_version.ready)}</p>
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
            {t('project:communityCard.share.invite')}
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
 * The approvers' names on an invited-approvers project, for the drawing
 * below: GET /api/apps/:slug/approvers, read once per page load and shared.
 * Null until it answers, and for a viewer it refuses (it is collaborator-
 * read), who then sees the faces of the project's members instead.
 */
const approverNames = new Map<string, string[] | null>();
const approverReads = new Map<string, Promise<void>>();
function useApprovers(slug: string, wanted: boolean): string[] | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!wanted || !slug || approverNames.has(slug)) return;
    let read = approverReads.get(slug);
    if (!read) {
      read = fetch(`/api/apps/${encodeURIComponent(slug)}/approvers`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { approvers?: Array<{ username?: string; status?: string }> } | null) => {
          const list = body && Array.isArray(body.approvers)
            ? body.approvers.filter((a) => a && a.status === 'member' && a.username).map((a) => String(a.username))
            : null;
          approverNames.set(slug, list);
        })
        .catch(() => { approverNames.set(slug, null); });
      approverReads.set(slug, read);
    }
    let live = true;
    void read.then(() => { if (live) bump(); });
    return () => { live = false; };
  }, [slug, wanted]);
  return approverNames.get(slug) || null;
}

/**
 * "evan or snait", "evan, snait or maya", "evan and snait"; past three, the
 * first three and "+N". At most three names are ever written out, so each
 * shape is a whole message with the names as its parameters.
 */
function nameList(names: string[], joiner: 'or' | 'and'): string {
  if (!names.length) return '';
  const [first, second, third] = names;
  if (names.length > 3) {
    return translate('project:communityCard.step.names.more', { first, second, third, count: names.length - 3 });
  }
  if (names.length === 1) return first;
  if (names.length === 2) {
    return translate(joiner === 'or' ? 'project:communityCard.step.names.eitherOfTwo' : 'project:communityCard.step.names.bothOfTwo', { first, second });
  }
  return translate(joiner === 'or' ? 'project:communityCard.step.names.anyOfThree' : 'project:communityCard.step.names.allOfThree', { first, second, third });
}

/** How many faces the middle step shows before "+N" says the rest. */
export const RULE_FACES = 3;

/**
 * The middle step in words: who has to say yes, the names under it, and the
 * wait rule's line where there is one. Pure, for the tests; the three
 * regimes are approvalLine's.
 */
export function approvalStep(
  approval: CommunityPayload['approval'],
  viewer: Pick<CommunityPayload, 'audience' | 'is_member'> | null | undefined,
  approvers: string[] | null,
): { who: string; names: string; wait: string; solo: boolean } {
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  if (viewer?.audience === 'solo' && viewer.is_member
    && Number(approval.electorate) === 1 && Number(approval.required) === 1) {
    return {
      who: translate('project:communityCard.step.you'),
      names: translate('project:communityCard.step.justYou'),
      wait: '',
      solo: true,
    };
  }
  const fixed = approval.approvals_required != null;
  const quiet = !fixed && required > 1;
  if (approval.policy === 'invited') {
    // The order is the sentence's: one approver says it whatever was asked for.
    const who = required < electorate
      ? translate('project:communityCard.step.approvers.some', { count: required, total: electorate })
      : electorate === 1 ? translate('project:communityCard.step.approvers.only')
        : electorate === 2 && required === 2 ? translate('project:communityCard.step.approvers.both')
          : required === electorate ? translate('project:communityCard.step.approvers.all', { count: electorate })
            : translate('project:communityCard.step.approvers.short', { count: electorate, required });
    return {
      who,
      names: approvers ? nameList(approvers, required === 1 ? 'or' : 'and') : '',
      wait: quiet ? translate('project:communityCard.step.approvers.wait') : '',
      solo: false,
    };
  }
  if (fixed) {
    return { who: translate('project:communityCard.step.fixed', { count: required }), names: '', wait: '', solo: false };
  }
  const who = required < electorate
    ? translate('project:communityCard.step.members.some', { count: required, total: electorate })
    // Counted by how many there are: that is the number English words differently.
    : required > electorate ? translate('project:communityCard.step.members.short', { count: electorate, required })
      : electorate === 1 ? translate('project:communityCard.step.members.only')
        : electorate === 2 ? translate('project:communityCard.step.members.both')
          : translate('project:communityCard.step.members.all', { count: electorate });
  return {
    who,
    names: '',
    wait: quiet ? translate('project:communityCard.step.members.wait') : '',
    solo: false,
  };
}

/** One regime's sentence on the Workshop's Overview, in its two wordings. */
type LineIds = { long: string; short: string };

/**
 * The approval rule as the Overview card's last line says it, wide and
 * narrow: "A change goes live when its checks pass and …" on a wide card,
 * "Goes live when …" on a phone. A table of ids, read when the line renders.
 */
const RULE_LINE: Record<string, LineIds> = {
  you: { long: 'project:communityCard.line.you', short: 'project:communityCard.lineShort.you' },
  anyOf: { long: 'project:communityCard.line.anyOf', short: 'project:communityCard.lineShort.anyOf' },
  allOf: { long: 'project:communityCard.line.allOf', short: 'project:communityCard.lineShort.allOf' },
  approversSome: { long: 'project:communityCard.line.approvers.some', short: 'project:communityCard.lineShort.approvers.some' },
  approversOnly: { long: 'project:communityCard.line.approvers.only', short: 'project:communityCard.lineShort.approvers.only' },
  approversBoth: { long: 'project:communityCard.line.approvers.both', short: 'project:communityCard.lineShort.approvers.both' },
  approversAll: { long: 'project:communityCard.line.approvers.all', short: 'project:communityCard.lineShort.approvers.all' },
  approversShort: { long: 'project:communityCard.line.approvers.short', short: 'project:communityCard.lineShort.approvers.short' },
  fixed: { long: 'project:communityCard.line.fixed', short: 'project:communityCard.lineShort.fixed' },
  membersSome: { long: 'project:communityCard.line.members.some', short: 'project:communityCard.lineShort.members.some' },
  membersShort: { long: 'project:communityCard.line.members.short', short: 'project:communityCard.lineShort.members.short' },
  membersOnly: { long: 'project:communityCard.line.members.only', short: 'project:communityCard.lineShort.members.only' },
  membersBoth: { long: 'project:communityCard.line.members.both', short: 'project:communityCard.lineShort.members.both' },
  membersAll: { long: 'project:communityCard.line.members.all', short: 'project:communityCard.lineShort.members.all' },
  // #4666: the presets, said from the reader's side. You or the group reads
  // "you say yes" to its creator and names the creator, face first, to
  // everyone else; its group half is the members' count, as above.
  youSome: { long: 'project:communityCard.line.youOrGroup.you.some', short: 'project:communityCard.lineShort.youOrGroup.you.some' },
  youShort: { long: 'project:communityCard.line.youOrGroup.you.short', short: 'project:communityCard.lineShort.youOrGroup.you.short' },
  youOnly: { long: 'project:communityCard.line.youOrGroup.you.only', short: 'project:communityCard.lineShort.youOrGroup.you.only' },
  youBoth: { long: 'project:communityCard.line.youOrGroup.you.both', short: 'project:communityCard.lineShort.youOrGroup.you.both' },
  youAll: { long: 'project:communityCard.line.youOrGroup.you.all', short: 'project:communityCard.lineShort.youOrGroup.you.all' },
  creatorSome: { long: 'project:communityCard.line.youOrGroup.creator.some', short: 'project:communityCard.lineShort.youOrGroup.creator.some' },
  creatorShort: { long: 'project:communityCard.line.youOrGroup.creator.short', short: 'project:communityCard.lineShort.youOrGroup.creator.short' },
  creatorOnly: { long: 'project:communityCard.line.youOrGroup.creator.only', short: 'project:communityCard.lineShort.youOrGroup.creator.only' },
  creatorBoth: { long: 'project:communityCard.line.youOrGroup.creator.both', short: 'project:communityCard.lineShort.youOrGroup.creator.both' },
  creatorAll: { long: 'project:communityCard.line.youOrGroup.creator.all', short: 'project:communityCard.lineShort.youOrGroup.creator.all' },
  twoYeses: { long: 'project:communityCard.line.twoYeses', short: 'project:communityCard.lineShort.twoYeses' },
  openFloor: { long: 'project:communityCard.line.openFloor', short: 'project:communityCard.lineShort.openFloor' },
  own: { long: 'project:communityCard.line.own', short: 'project:communityCard.lineShort.own' },
};

/**
 * #4666: the line for a project on a preset or rules of its own, or null for
 * one on the old two settings (and for Group vote, whose words are the
 * members' own). Pure, for the tests.
 */
export function presetSentence(
  approval: CommunityPayload['approval'],
  viewer: Pick<CommunityPayload, 'audience' | 'is_member' | 'is_creator'> | null | undefined,
): RuleSentence | null {
  if (!approval || approval.mode !== 'rules') return null;
  const preset = approval.preset || null;
  if (preset === 'group_vote') return null;
  const say = (ids: LineIds, values: Record<string, string | number> = {}, names: string[] | null = null): RuleSentence => (
    { ...ids, values, names }
  );
  const solo = viewer?.audience === 'solo' && viewer.is_member;
  if (!preset) return say(RULE_LINE.own);
  if (preset === 'two_yeses') return solo ? say(RULE_LINE.you) : say(RULE_LINE.twoYeses);
  if (preset === 'open_floor') return solo ? say(RULE_LINE.you) : say(RULE_LINE.openFloor);
  // You or the group.
  if (solo) return say(RULE_LINE.you);
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  const creator = approval.creator?.username || null;
  const mine = !!viewer?.is_creator || !creator;
  const pick = (you: LineIds, them: LineIds) => (mine ? you : them);
  const names = mine ? null : [creator as string];
  const values = (extra: Record<string, string | number> = {}) => (mine ? extra : { ...extra, creator: creator as string });
  if (required < electorate) return say(pick(RULE_LINE.youSome, RULE_LINE.creatorSome), values({ count: required, total: electorate }), names);
  // Counted by how many there are: that is the number English words differently.
  if (required > electorate) return say(pick(RULE_LINE.youShort, RULE_LINE.creatorShort), values({ count: electorate, required }), names);
  if (electorate === 1) return say(pick(RULE_LINE.youOnly, RULE_LINE.creatorOnly), values(), names);
  if (electorate === 2) return say(pick(RULE_LINE.youBoth, RULE_LINE.creatorBoth), values(), names);
  return say(pick(RULE_LINE.youAll, RULE_LINE.creatorAll), values({ count: electorate }), names);
}

/** Whether the rule has the quiet path a wait clause describes (approvalStep's `wait`). */
export function ruleHasWait(approval: CommunityPayload['approval'] | null | undefined): boolean {
  if (!approval) return false;
  if (approval.mode !== 'rules') return true;
  return approval.preset === 'group_vote' || approval.preset === 'you_or_the_group';
}

export interface RuleSentence extends LineIds {
  values: Record<string, string | number>;
  /** The approvers the sentence names, whose faces lead their names. */
  names: string[] | null;
}

/**
 * Which sentence the Overview's rule line is, and what goes in it. Pure, for
 * the tests; the branches are approvalStep's, so the line and the three
 * steps it replaced cannot disagree about a regime. An invited-approvers
 * project NAMES its approvers ("evan or snait says yes") when the names
 * are in hand, there are at most RULE_FACES of them, they are the whole
 * electorate, and either one of them or all of them is what it takes; any
 * other count is said as a count.
 */
export function ruleSentence(
  approval: CommunityPayload['approval'],
  viewer: Pick<CommunityPayload, 'audience' | 'is_member'> & { is_creator?: boolean } | null | undefined,
  approvers: string[] | null,
): RuleSentence {
  const preset = presetSentence(approval, viewer ? { ...viewer, is_creator: !!viewer.is_creator } : viewer);
  if (preset) return preset;
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  const say = (ids: LineIds, values: Record<string, string | number> = {}, names: string[] | null = null): RuleSentence => (
    { ...ids, values, names }
  );
  if (viewer?.audience === 'solo' && viewer.is_member
    && Number(approval.electorate) === 1 && Number(approval.required) === 1) {
    return say(RULE_LINE.you);
  }
  if (approval.policy === 'invited') {
    const named = !!approvers && approvers.length > 0 && approvers.length <= RULE_FACES && approvers.length === electorate;
    if (named && required === 1) return say(RULE_LINE.anyOf, { names: nameList(approvers!, 'or') }, approvers);
    if (named && required === electorate) return say(RULE_LINE.allOf, { names: nameList(approvers!, 'and') }, approvers);
    if (required < electorate) return say(RULE_LINE.approversSome, { count: required, total: electorate });
    if (electorate === 1) return say(RULE_LINE.approversOnly);
    if (electorate === 2 && required === 2) return say(RULE_LINE.approversBoth);
    if (required === electorate) return say(RULE_LINE.approversAll, { count: electorate });
    return say(RULE_LINE.approversShort, { count: electorate, required });
  }
  if (approval.approvals_required != null) return say(RULE_LINE.fixed, { count: required });
  if (required < electorate) return say(RULE_LINE.membersSome, { count: required, total: electorate });
  // Counted by how many there are: that is the number English words differently.
  if (required > electorate) return say(RULE_LINE.membersShort, { count: electorate, required });
  if (electorate === 1) return say(RULE_LINE.membersOnly);
  if (electorate === 2) return say(RULE_LINE.membersBoth);
  return say(RULE_LINE.membersAll, { count: electorate });
}

/**
 * The rule's sentence in both its wordings, the wide card's and the narrow
 * card's (app.css shows one): the named approvers' faces, then their names
 * in bold, where the sentence names them.
 */
export function RuleWords({ line }: { line: RuleSentence }) {
  useMessages('project');
  const parts = [
    line.names ? (
      <span className="dev-ws-ov-faces" aria-hidden="true">
        {line.names.map((name) => (
          <span key={name} className="dev-ws-ov-face" style={{ background: swatchFor(name) }}>
            {(name || '?').charAt(0).toUpperCase()}
          </span>
        ))}
      </span>
    ) : <span />,
    <b className="dev-ws-ov-names" />,
  ];
  return (
    <>
      <span className="dev-ws-ov-wide"><RichMessage id={line.long} values={line.values} components={parts} /></span>
      <span className="dev-ws-ov-narrow"><RichMessage id={line.short} values={line.values} components={parts} /></span>
    </>
  );
}

/**
 * HOW A CHANGE GETS IN, as the last line of the Workshop's Overview card
 * (After-Workshop-B, Oct 2026): "A change goes live when its checks pass
 * and [faces] evan or snait says yes", and "Goes live when …" where the
 * card is narrow (app.css `.dev-ws-ov-wide` / `.dev-ws-ov-narrow`, a
 * container query on the card). It folds the three-step Approval rules card
 * (#4457) into the sentence those steps spelled out, read from the server
 * (GET /api/apps/:slug/community, `approval`). The wait rule, where there
 * is one, follows it in a muted clause (approvalStep's `wait`), and the
 * whole rule in one sentence is its tooltip (approvalLine).
 *
 * WHO CAN CHANGE THE RULE reaches in from here (#4527): "Rules", for
 * exactly whom the card's data says can manage (`can_manage`), opens the
 * Members & approvals dialog on its Proposal approvals section, where the
 * change is proposed and voted on. Everyone else gets the line alone.
 */
export function ApprovalLine({ slug }: { slug: string }) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  const invited = !!(data && data.approval && data.approval.policy === 'invited');
  const approvers = useApprovers(slug, invited);
  if (!data || !data.approval) return null;
  const { wait } = ruleHasWait(data.approval) ? approvalStep(data.approval, data, approvers) : { wait: '' };
  return (
    <p className="dev-ws-ov-rule" data-ws-approval-rules="" title={approvalLine(data.approval, data)}>
      <ShieldCheckIcon className="dev-ws-ov-rule-icon" aria-hidden="true" />
      <span className="dev-ws-ov-rule-text" data-ws-community-rule="">
        <RuleWords line={ruleSentence(data.approval, data, approvers)} />
        {wait ? <span className="dev-ws-ov-rule-wait">{wait}</span> : null}
      </span>
      {data.can_manage ? (
        <button
          type="button"
          className="dev-ws-hub-open dev-ws-ov-rule-edit un-touch-target"
          data-ws-rules-edit=""
          aria-label={t('project:communityCard.rule.editName')}
          onClick={() => window.UsernodeReact?.dialogs?.whoDecides?.open({ slug })}
        >
          {t('project:communityCard.rule.rules')}
        </button>
      ) : null}
    </p>
  );
}
