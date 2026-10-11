/**
 * Right after "Make it" (./make.tsx): something to give, and one thing to
 * do with it.
 *
 *   bar       The Homeroom logo bar, as on the story, the invite page and
 *             the make screen (owner, 7 October 2026), so the first session
 *             reads as one product from the story to the tour. It stays
 *             behind the invite sheet. From Create, under the platform's own
 *             header, there is none.
 *   who       Your face in the middle with waiting seats on both sides
 *             (./people-row.tsx, canvas People.dc.html). As people join,
 *             their faces take the seats: the project's community is read
 *             once, then every ten seconds while an invite is out. No line
 *             says who joined as well (decided 6 October 2026).
 *   title     "Your new community", small, as the screen's heading. Then,
 *             16px under it, the thumbnail, which carries the name: a big
 *             name over the card said it twice (owner, 7 October 2026,
 *             canvas v78). The faces, the heading and the thumbnail are one
 *             block, centred between the logo bar and the line over the
 *             buttons.
 *   what      The project's thumbnail (./sketch-card.tsx) with the build
 *             line one line under it (#4053, ./build-line.tsx: "Homeroom bot
 *             is planning it") from GET /api/apps/:slug
 *             (`app.first_version`), read again every ten seconds, past the
 *             service worker's cache (madeAppOf, madeAppUrl). When the plan
 *             waits, only that line changes ("Your plan is ready to review",
 *             in blue), as it does on every screen. Nothing here asks for an
 *             answer: the plan waits until the tour ends, and the "Needs you"
 *             card that asked for it before anyone was invited is gone from
 *             the first session (Evan's test, 6 October 2026). From Create,
 *             which has no tour, the card stays (PlanWaitsCard). A project Homeroom bot does not
 *             build has no line, and one quiet note under the card says who
 *             builds it (NO_BOT_NOTE).
 *   invite    One quiet line, "Invite people to use it and help improve it
 *             together.", over Share invite and Invite people later. Once the
 *             link has gone out the line says so ("Invite shared. Next, a
 *             short tour.", or "Link copied. Next, a short tour."), and the
 *             buttons keep their places: Share again, grey, where Share
 *             invite was, and Start the tour, blue, where Invite people later
 *             was (owner, 8 October 2026). Invite people later and Start the
 *             tour both start the tour (./index.tsx). From Create there is no
 *             tour: the line says "Invite shared." or "Link copied." and the
 *             second button goes to the project (continueLabel).
 *
 * Nothing under the two buttons.
 *
 * The sheet is the first invite, not the project's full invite pane
 * (features/app-context/invite-pane.tsx, with live links, their limits, an
 * invite by username and the project's joining rule, which stays where it
 * is): its title ("Invite people to Sunday Run Club"), a small caps "What
 * they'll see" over the invite as they will see it ("alex invited you to
 * Sunday Run Club" and the note, edited in place), then Share link and Copy
 * link (inviteActions: which one leads depends on the device, #4180).
 * Nothing else: somebody brand new knows nobody on Homeroom to invite by
 * username yet, and the joining rule is the project's business later (both
 * taken out after Evan's run-through, 5 October 2026). The link it makes
 * stops after a week or 25 people (LINK_DAYS, LINK_USES), and the sheet says
 * so. A note they wrote themselves and shared (the share sheet, not Copy
 * link) is also the maker's first message in the group's chat (the sheet
 * says so, #4238), so the people it brings find it waiting there. The note is
 * kept per project on this device
 * (noteKey), else read back from the maker's own newest link.
 *
 *   sketch    The thumbnail is made from the description in a few seconds
 *             (services/app-sketch.js): its emoji, now the project's icon,
 *             and a tagline. The same frame stands while it is sketched.
 *             Without one (a project with no sketch, or one that never came)
 *             it says the description instead.
 *
 * Every line says what is true for this project: when Homeroom bot builds
 * it (`made.conversationId`, its DM), the build line; when it does not, the
 * description is the project's first request, for whoever builds it. Nothing
 * says how long a first version takes (buildNote).
 *
 * FROM CREATE TOO, IMPORTS INCLUDED. Every new project lands here: from the
 * first session, from the Create button's make screen, and from its import
 * form (`made.imported`, ./import-repo.tsx), which is the retired New
 * project dialog's last job. So this screen also says what that dialog's
 * progress view used to: a setup that stopped (status `error`, with Try
 * again, POST /api/apps/:slug/retry) or one waiting on its secrets
 * (`awaiting_secrets`, with Set secrets, which an imported repo can declare),
 * in a card under the project (SetupStoppedCard). An import
 * has no sketch and nothing built from a description: its lines say it is
 * being imported, then that it runs (buildLine, buildNote). Every one is a
 * private community, so every one ends on Share invite.
 *
 * READY-MADE (Evan, 8 October 2026). A choice on the make screen that needs
 * no typing (a tier list of restaurants, the grocery list, ...) makes one of
 * Homeroom's ready-made apps (services/app-templates.js, `made.readyMade`):
 * nothing is sketched or built, so like an import its lines say it is being
 * set up, then that it is ready to use.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';
import type { HomeroomBotPlanQuestion } from '../messages/types';

import { BUILD_LINE_WORDS, type BuildLineState, buildLineOf } from './build-line';
import { copyText, inviteText } from './copy-invite';
import type { Made, MakeEntry } from './make';
import { type Person, PeopleRow } from './people-row';
import { SketchCard, showsCard, useSketch } from './sketch-card';

/** B6: the plan Homeroom bot waits on before it builds anything. */
export type WaitingPlan = {
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  actionId: number;
  messageId: number | null;
  conversationId: number | null;
};

type FirstVersion = {
  step?: number; of?: number; ready?: boolean;
  /** #4053: its build line for this reader (homeroom-bot-progress.js buildLineOf). */
  line?: string | null;
  /** B6: the plan waiting for Build it, for its creator (GET /api/apps/:slug). */
  plan?: Partial<WaitingPlan> | null;
} | null;

/**
 * The project's record as GET /api/apps/:slug answers it, which is `{ app }`:
 * its first version (null while the bot builds nothing) and its status. Null
 * for an answer without a record. Page Turners, 5 October 2026: the made
 * screen read `first_version` off the answer itself, never found one, and
 * so never drew the plan its maker waited 18 minutes on.
 */
export function madeAppOf(body: unknown): { firstVersion: FirstVersion; status: string | null } | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  if (!app || typeof app !== 'object') return null;
  const { first_version: firstVersion, status } = app as { first_version?: FirstVersion; status?: unknown };
  return { firstVersion: firstVersion || null, status: typeof status === 'string' ? status : null };
}

/**
 * The made screen's read of the project, every ten seconds. Tagged and
 * no-store, as the App tab's recheck is (AppView._recheckFirstVersion): the
 * service worker answers a plain GET /api/apps/:slug from its boot cache
 * first, and a poll is asking what is true now.
 */
export function madeAppUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}?status_recheck=1&manifest=summary`;
}

/**
 * The plan waiting for Build it, or null: read the way the App tab's
 * being-built screen reads it (AppView._firstVersionView), so the two agree
 * on when there is one.
 */
export function waitingPlan(fv: FirstVersion): WaitingPlan | null {
  const plan = fv && !fv.ready ? fv.plan : null;
  if (!plan || !Array.isArray(plan.bullets) || !plan.bullets.length || !Number.isInteger(plan.actionId)) return null;
  return {
    bullets: plan.bullets,
    questions: Array.isArray(plan.questions) ? plan.questions : [],
    actionId: Number(plan.actionId),
    messageId: Number.isInteger(plan.messageId) ? Number(plan.messageId) : null,
    conversationId: Number.isInteger(plan.conversationId) ? Number(plan.conversationId) : null,
  };
}

/** Over the plan's card: it is the one thing on the screen that waits on them. A message id, as the labels below are. */
export const PLAN_LABEL = 'onboarding:firstSession.made.needsYou';

/** The plan's card: that there is one, never what to tap in it (that is the chat's). */
export function planWaitsLine(name: string): string {
  return translate('onboarding:firstSession.made.planWaits', { app: name });
}

/** The screen's heading, small, over the thumbnail (which carries the name). */
export const COMMUNITY_LABEL = 'onboarding:firstSession.made.communityLabel';

/** The one line over the buttons until the link has gone out. */
export const INVITE_HINT = 'onboarding:firstSession.made.inviteHint';

/** The small caps label over the invite as they will see it, in the sheet. */
export const PREVIEW_LABEL = 'onboarding:firstSession.invite.previewLabel';

/**
 * Under the thumbnail when Homeroom bot does not build the project: it has
 * no build line, so this says who builds it. Nothing is said under the card
 * when the bot builds it; the build line says where it is.
 */
export const NO_BOT_NOTE = 'onboarding:firstSession.made.noBotNote';

/** The line over the buttons once the link has gone out. `tour`: the first session's, which goes on to the tour. */
export function sharedLine(how: SentHow, tour = true): string {
  if (how === 'copied') return tour ? translate('onboarding:firstSession.made.sent.copiedTour') : translate('onboarding:firstSession.made.sent.copied');
  return tour ? translate('onboarding:firstSession.made.sent.sharedTour') : translate('onboarding:firstSession.made.sent.shared');
}

/**
 * A setup that is not going on by itself (creation-progress-store.js
 * outcomeOf): it failed, or it waits on secrets. Null while it is creating,
 * once it runs, and before anything has been read.
 */
export type Stalled = 'failed' | 'needs-secrets' | null;

export function stalledOf(appStatus: string | null): Stalled {
  if (appStatus === 'error') return 'failed';
  if (appStatus === 'awaiting_secrets') return 'needs-secrets';
  return null;
}

/** The build line's words ("Building it"), or what to say without a build. */
export function buildLine(fv: FirstVersion, appStatus: string | null, botBuilds = true, imported = false, readyMade = false): string {
  // Before any step: nothing is built on a setup that stopped.
  const stalled = stalledOf(appStatus);
  if (stalled === 'failed') return translate('onboarding:firstSession.made.line.failed');
  if (stalled === 'needs-secrets') return translate('onboarding:firstSession.made.line.needsSecrets');
  // An import has no first version: it is coming over, then it runs.
  if (imported) return appStatus === 'running' ? translate('onboarding:firstSession.made.line.imported') : translate('onboarding:firstSession.made.line.importing');
  // Nor has a ready-made app: it is set up, then it is ready.
  if (readyMade) return appStatus === 'running' ? translate('onboarding:firstSession.made.line.readyToUse') : translate('onboarding:firstSession.made.line.settingUp');
  if (fv && fv.ready) return translate('onboarding:firstSession.made.line.versionOneReady');
  // The plain card (no sketch) says the build line's words too, never a step count (#4053).
  if (fv && fv.step && fv.of) return translate(BUILD_LINE_WORDS[buildLineOf(fv.line) || 'planning']);
  if (appStatus === 'creating') return translate('onboarding:firstSession.made.line.settingUp');
  return botBuilds ? translate('onboarding:firstSession.made.line.botBuilds') : translate('onboarding:firstSession.made.line.firstRequest');
}

/**
 * #4053: the build line under the thumbnail, the server's for this
 * reader (`first_version.line`). Before the first read, and while the
 * project is being set up, Homeroom bot is planning it; once a first version
 * read as on its way is gone (`live`: merged), it is live. None for a
 * project Homeroom bot does not build.
 */
export function madeLine(fv: FirstVersion, botBuilds: boolean, live = false, stalled: Stalled = null, imported = false): BuildLineState | null {
  if (!botBuilds || stalled || imported) return null;
  if (fv) return buildLineOf(fv.line) || (fv.ready ? 'ready' : 'planning');
  return live ? 'live' : 'planning';
}

/**
 * The line under the build's: who tells them, or who builds it. B6: while
 * its plan waits, that nothing happens until they say so.
 *
 * It says nothing about how long. It used to promise "usually in about 10
 * minutes", an ordinary request's typical build (WP-E, homeroom-bot-dm.js
 * typicalMinutes), and a first version plans first and waits on its maker's
 * answer: Page Turners, 5 October 2026, sent its plan 11 minutes after Make
 * it and was ready to try 50 minutes after it. No average stands in for it
 * (Evan, the same day).
 *
 * Nor does it explain the plan any more. Until the plan was sent it said
 * "Homeroom bot plans it first, and asks you to approve the plan", and after
 * it only that it messages you. Evan, 5 October 2026: one plain line, the
 * same before and after the plan, that says it asks when it has questions.
 * While the plan waits, a project that is not sketched says so instead.
 */
export function buildNote(botBuilds: boolean, planWaits = false, stalled: Stalled = null, imported = false, readyMade = false): string {
  if (stalled === 'failed') return translate('onboarding:firstSession.made.note.failed');
  if (stalled === 'needs-secrets') return translate('onboarding:firstSession.made.note.needsSecrets');
  if (imported) return translate('onboarding:firstSession.made.note.imported');
  if (readyMade) return translate('onboarding:firstSession.made.note.readyMade');
  if (!botBuilds) return translate('onboarding:firstSession.made.note.noBot');
  if (planWaits) return translate('onboarding:firstSession.made.note.planWaits');
  return translate('onboarding:firstSession.made.note.making');
}

/**
 * The invite as they will see it, in the sheet and as the shared link's
 * title: "alex invited you to Page Turners". It says nothing about the app
 * being made: the thumbnail and its build line say that, and the same words
 * serve a project that is live already (the Invite people button in the bot's
 * chat, messages/bot-question.tsx).
 */
export function inviteLine(me: string, name: string): string {
  return me ? translate('onboarding:firstSession.invite.line', { inviter: me, community: name }) : translate('onboarding:firstSession.invite.lineAnonymous', { community: name });
}

// The note the sheet opens with when the example has none and nothing is
// kept: sent while the app is still being made, so no "Made us", and no "!" (#4042).
// Read when the sheet opens, so it is written in the language on screen.
const noteDefault = () => translate('onboarding:firstSession.invite.noteDefault');
// The link every invite link gets by default (services/community-invites.js
// DEFAULT_DAYS and DEFAULT_USES): a week, and 25 people. It used to work until
// it was turned off, for anyone it reached (WP-D), which was safe while the
// waitlist stood between a stranger and the group. A link lets somebody new
// straight in now, as a private member, so a forwarded one stops on its own.
// The project's invite pane still makes a longer or wider one on request.
const LINK_DAYS = 7;
const LINK_USES = 25;

/** The note, posted once per project as the maker's first chat message. */
const postedKey = (slug: string) => `usernode:first-session:note-posted:${slug}`;

/** The maker's last note for a project, kept on this device. */
export const noteKey = (slug: string) => `usernode:first-session:note:${slug}`;

/** The note they last wrote for `slug`, or null when there is none kept. */
export function keptNote(slug: string): string | null {
  try { return localStorage.getItem(noteKey(slug)); } catch { return null; }
}

function keepNote(slug: string, note: string): void {
  try { localStorage.setItem(noteKey(slug), note); } catch { /* kept for this sheet only */ }
}

/** The note the sheet opens with: the one kept, else the example's, else the default. */
export function openingNote(slug: string, example: string | null | undefined): string {
  const kept = keptNote(slug);
  return kept !== null ? kept : (example || noteDefault());
}

/**
 * Whether a note goes in the group chat as the maker's first message
 * (#4238): only when the share sheet took the link (a copy may never be
 * pasted anywhere), and only a note they wrote themselves, never the
 * untouched default or the example's preset one.
 */
export function notePostable(how: SentHow, note: string, example: string | null | undefined): boolean {
  const text = note.trim();
  if (how !== 'shared' || !text) return false;
  return text !== noteDefault() && text !== (example || '').trim();
}

/** The newest note on the maker's own live links (GET .../invite-links `links`), or null. */
export function linkNote(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const mine = links.find((l) => l && typeof l === 'object' && (l as { mine?: boolean }).mine
    && typeof (l as { note?: unknown }).note === 'string' && (l as { note: string }).note);
  return mine ? (mine as { note: string }).note : null;
}

/** One of the sheet's two ways to send the link. */
export type InviteAction = 'share' | 'copy';

/**
 * The sheet's buttons, the main one first (#4180). On a phone or tablet the
 * share sheet leads, with Copy link beside it. On a computer Copy link leads,
 * with Share… beside it: a desktop share sheet (Safari's: AirDrop, Mail,
 * Messages, Notes) has no plain way to copy the link. With no share sheet at
 * all, Copy link alone.
 */
export function inviteActions(touch: boolean, canShare: boolean): InviteAction[] {
  if (!canShare) return ['copy'];
  return touch ? ['share', 'copy'] : ['copy', 'share'];
}

/** PlatformUI.isTouch(): a phone or tablet, as the native kit tells them apart. */
function onTouch(): boolean {
  const ui = (globalThis as unknown as { PlatformUI?: { isTouch?: () => boolean } }).PlatformUI;
  return typeof ui?.isTouch === 'function' && ui.isTouch();
}

function hasShareSheet(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// How long "✓ Copied" stays on the button before it reads Copy link again.
const COPIED_MS = 1200;

// How long after the share sheet goes an Escape is still taken as its own:
// the key that dismissed the OS popover can reach the page after the share's
// promise has settled.
const SHARE_ESCAPE_MS = 400;

/**
 * How the link went out. A share says only that it was handed to the share
 * sheet: the page cannot know a message was actually sent (#4196).
 */
export type SentHow = 'shared' | 'copied';

/** The sheet's status once the link has gone out, said the way it went. */
export function sentStatus(how: SentHow): string {
  return how === 'shared' ? translate('onboarding:firstSession.invite.status.shared') : translate('onboarding:firstSession.invite.status.copied');
}

/**
 * The sheet stays open once the link has gone out, with what happened said
 * on it, and Done closes it (#4196: closing at once read as "Share link just
 * goes back"). Share link and Copy link can be pressed again.
 *
 * The link is still made only on a press (copy-invite.ts). A share press
 * that has to make it first waits on that request, and a browser may then
 * refuse the share sheet for want of the press (NotAllowedError, Safari
 * above all). Such a refusal copies instead, the way a missing share sheet
 * always did; when even the copy is refused, the sheet says the link is
 * ready, and the next press shares at once, because the link exists by then
 * and is not waited on. Cancelling the share sheet (AbortError) changes
 * nothing.
 */
export function InviteSheet({ made, me, onClose, onSent }: {
  made: Made;
  me: string;
  onClose: () => void;
  /** The link went out, shared or copied. The sheet stays open. */
  onSent: (how: SentHow) => void;
}) {
  const t = useMessages('onboarding');
  // The example's suggested note (a message id), in the language on screen.
  const exampleNote = made.example ? translate(made.example.note) : null;
  const [note, setNote] = useState(() => openingNote(made.slug, exampleNote));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // When Copy link last copied (0: not lately), for "✓ Copied" on its button.
  const [copied, setCopied] = useState(0);
  // Something went out from this sheet: Done is offered.
  const [out, setOut] = useState(false);
  // The OS share sheet is up, or has only just gone (SHARE_ESCAPE_MS).
  const sharing = useRef(false);
  const shareGoneAt = useRef(0);
  // Which button leads, read once as the sheet opens (inviteActions).
  const [actions] = useState(() => inviteActions(onTouch(), hasShareSheet()));
  const linkRef = useRef<string | null>(null);
  // Whether the note in the box is theirs from this device (kept, or typed
  // here); until it is, a note on one of their own links replaces it.
  const ownNote = useRef(keptNote(made.slug) !== null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // The maker's own newest note, when this device kept none.
  useEffect(() => {
    if (ownNote.current) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const fromLink = live && !ownNote.current ? linkNote(data?.links) : null;
        if (fromLink) setNote(fromLink);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [made.slug]);
  // Escape closes the sheet, unless it is dismissing the OS share sheet
  // over it (or has just done so).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sharing.current || Date.now() - shareGoneAt.current < SHARE_ESCAPE_MS) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!copied) return undefined;
    const t = window.setTimeout(() => setCopied(0), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);

  // The maker's note, as their first message in the group's chat, once,
  // when they shared a note of their own (notePostable).
  const postNote = useCallback(async (how: SentHow) => {
    if (!notePostable(how, note, exampleNote)) return;
    const text = note.trim();
    try { if (localStorage.getItem(postedKey(made.slug))) return; } catch { /* post it */ }
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: text }),
    }).catch(() => null);
    if (res && res.ok) { try { localStorage.setItem(postedKey(made.slug), '1'); } catch { /* once is best effort */ } }
  }, [note, made.slug, exampleNote]);

  const link = useCallback(async (): Promise<string | null> => {
    if (linkRef.current) return linkRef.current;
    const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ days: LINK_DAYS, maxUses: LINK_USES, note: note.trim() || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.link) { setError(data.error || translate('onboarding:firstSession.invite.error.noLink')); return null; }
    linkRef.current = `${location.origin}${data.link.path}`;
    return linkRef.current;
  }, [made.slug, note]);

  // The link went out, shared or copied: said on the sheet, which stays
  // open; the note kept, posted once as their first message in the group
  // chat when it was shared (postNote), and the made screen told.
  const sent = useCallback(async (how: SentHow) => {
    setStatus(sentStatus(how));
    setOut(true);
    keepNote(made.slug, note);
    await postNote(how);
    onSent(how);
  }, [made.slug, note, postNote, onSent]);

  const shareLink = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // A link already made is shared from inside the press; one still to
      // make is waited on first (see the header).
      const url = linkRef.current || await link();
      if (!url) return;
      const title = inviteLine(me, made.name);
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      if (typeof nav.share === 'function') {
        sharing.current = true;
        try {
          await nav.share({ title, text: note.trim() || undefined, url });
          await sent('shared');
          return;
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return;
          // Refused (no press left to open it with) or failed: copy below.
        } finally {
          sharing.current = false;
          shareGoneAt.current = Date.now();
        }
      }
      const outcome = await copyText(inviteText(note, url));
      if (outcome === 'copied') {
        setCopied(Date.now());
        await sent('copied');
        return;
      }
      // Nothing went out, but the link is made: the next press shares it at once.
      setStatus(translate('onboarding:firstSession.invite.status.ready'));
    } catch {
      setError(translate('onboarding:firstSession.invite.error.notShared'));
    } finally {
      setBusy(false);
    }
  }, [busy, link, me, made.name, note, sent]);

  // Copy link: the note and the link, put on the clipboard inside the press
  // even while the link is still being made (copyText: Safari copies nothing
  // after the press has waited on a request), then what a share does.
  const copyLink = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const ready = linkRef.current;
      const outcome = await copyText(ready ? inviteText(note, ready)
        : link().then((url) => (url ? inviteText(note, url) : null)));
      if (outcome === 'no-link') { setError((was) => was || translate('onboarding:firstSession.invite.error.noLink')); return; }
      if (outcome === 'refused') { setError(translate('onboarding:firstSession.invite.error.notCopied')); return; }
      setCopied(Date.now());
      await sent('copied');
    } catch {
      setError(translate('onboarding:firstSession.invite.error.notCopied'));
    } finally {
      setBusy(false);
    }
  }, [busy, link, note, sent]);

  const tile = made.emoji || made.name.slice(0, 1);
  return (
    <div className="fixed inset-0 z-[9001]" data-first-session-invite="">
      <div aria-hidden="true" onClick={onClose} className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-session-invite-title"
        className={`absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-[20px] bg-zinc-100 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out dark:bg-zinc-900 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="first-session-invite-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.invite.title', { community: made.name })}</h2>
          <button type="button" onClick={onClose} aria-label={t('core:common.close')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p data-first-session-invite-label="" className="mt-4 pb-1.5 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t(PREVIEW_LABEL)}</p>
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 p-3">
            <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{tile}</span>
            <div className="min-w-0">
              <p data-first-session-invite-line="" className="text-[15px] font-[650] leading-snug">{inviteLine(me, made.name)}</p>
            </div>
          </div>
          <div className="px-3 pb-2 pt-2.5 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
            <textarea
              id="first-session-note"
              aria-label={t('onboarding:firstSession.invite.noteLabel')}
              rows={2}
              maxLength={280}
              value={note}
              onChange={(e) => { ownNote.current = true; setNote(e.target.value); keepNote(made.slug, e.target.value); }}
              placeholder={t('onboarding:firstSession.invite.notePlaceholder')}
              className="w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-snug placeholder-zinc-500 focus:outline-none"
            />
          </div>
        </div>
        <p className="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.invite.noteHint')}</p>
        {/* The main button, then the other way beside it (inviteActions), a
            white pill on the sheet's grey (pillRaised). Not dimmed while
            "✓ Copied" shows: busy then only holds off a second press. */}
        <div className="mt-4 flex gap-2.5">
          {actions.map((action, i) => {
            const label = action === 'share' ? (i === 0 ? t('onboarding:firstSession.invite.shareLink') : t('onboarding:firstSession.invite.shareOther')) : copied ? t('onboarding:firstSession.invite.copied') : t('onboarding:firstSession.invite.copyLink');
            const press = () => { void (action === 'share' ? shareLink() : copyLink()); };
            const main = i === 0;
            return (
              <Button
                key={action}
                type="button"
                data-first-session-invite-action={action}
                onClick={press}
                disabled={busy && !copied}
                layout={main ? 'flex' : 'shrink'}
                variant={main ? 'pillAccent' : 'pillRaised'}
                size="pillLg"
                ink={main ? 'solidLate' : 'neutral'}
                className="flex items-center justify-center disabled:opacity-60"
              >
                {label}
              </Button>
            );
          })}
        </div>
        {status ? <p role="status" data-first-session-invite-status="" className="mt-3 text-center text-[14px] text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        {error ? <p id="first-session-invite-error" role="alert" className="mt-3 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        {/* Once the link has gone out the sheet stays, with Done to close it. */}
        {out ? (
          <Button
            type="button"
            data-first-session-invite-done=""
            onClick={onClose}
            layout="full"
            variant="pillRaised"
            size="pillLg"
            ink="neutral"
            className="mt-3 flex items-center justify-center"
          >
            {t('core:common.done')}
          </Button>
        ) : null}
        <p className="mt-3 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.invite.limits')}</p>
      </div>
    </div>
  );
}

/**
 * B6: the plan waits for its maker's answer, which is given in the chat with
 * Homeroom bot (Build it, or Change something). Here it is one small card
 * under the project, in the place it always takes, with the way to that
 * chat. It never says Build it itself.
 */
export function PlanWaitsCard({ name, onOpenChat }: { name: string; onOpenChat: () => void }) {
  const t = useMessages('onboarding');
  return (
    <section data-first-session-plan="waiting" aria-labelledby="first-session-plan-label" className="mt-4">
      <p id="first-session-plan-label" className="px-1 pb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t(PLAN_LABEL)}</p>
      <div className="flex items-center gap-3 rounded-[20px] bg-white py-3 pl-4 pr-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-[650] leading-snug">{planWaitsLine(name)}</p>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.made.planAnswer')}</p>
        </div>
        <Button type="button" data-first-session-plan-chat="" onClick={onOpenChat} variant="pillAccent" size="sm" ink="solid" className="shrink-0 text-[15px] font-semibold">
          {t('onboarding:firstSession.made.goToChat')}
        </Button>
      </div>
    </section>
  );
}

/**
 * A setup that stopped, under the project: what
 * it needs, and the one thing that does it. What the New project dialog's
 * progress view said with its Retry and Set secrets.
 */
export function SetupStoppedCard({ stalled, busy, onRetry, onSetSecrets }: {
  stalled: Exclude<Stalled, null>;
  busy: boolean;
  onRetry: () => void;
  onSetSecrets: () => void;
}) {
  const t = useMessages('onboarding');
  const failed = stalled === 'failed';
  return (
    <section data-made-stalled={stalled} aria-labelledby="made-stalled-label" className="mt-4">
      <p id="made-stalled-label" className="px-1 pb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t(PLAN_LABEL)}</p>
      <div className="flex items-center gap-3 rounded-[20px] bg-white py-3 pl-4 pr-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <p className="min-w-0 flex-1 text-[15px] font-[650] leading-snug">
          {failed ? t('onboarding:firstSession.made.stalled.failed') : t('onboarding:firstSession.made.stalled.needsSecrets')}
        </p>
        <Button
          type="button"
          data-made-stalled-action=""
          disabled={busy}
          onClick={failed ? onRetry : onSetSecrets}
          variant="pillAccent"
          size="sm"
          ink="solid"
          className="shrink-0 text-[15px] font-semibold disabled:opacity-60"
        >
          {failed ? t('core:common.tryAgain') : t('onboarding:firstSession.made.stalled.setSecrets')}
        </Button>
      </div>
    </section>
  );
}

/**
 * The made screen's second button: on the first session, on to the tour
 * ("Invite people later", then "Start the tour" once an invite is out); from
 * Create, to the project itself.
 */
export function continueLabel(entry: MakeEntry, sent: boolean, name: string): string {
  if (!sent) return translate('onboarding:firstSession.made.inviteLater');
  return entry === 'create' ? translate('onboarding:firstSession.made.goTo', { community: name }) : translate('onboarding:firstSession.made.startTour');
}

/*
 * A READY-MADE APP IS RUNNING BEFORE THE WAY ON GOES (Evan, 10 Oct 2026,
 * iPhone). Home showed the new project as a grey letter, "Spinning up...",
 * that the tour's first card asked them to tap and that a tap did nothing
 * on: the made screen let them on while the app was still being set up.
 * A ready-made app is set up, not built, so its status is all there is to
 * wait for, and "running" comes after its icon is on the record
 * (app-creator.js reconciles dapp.json's icon before it deploys). So while
 * it is being set up the screen reads it every READY_POLL_MS, and a press
 * of the way on waits for it, saying so on the button, and goes on by
 * itself once it runs. A setup that stopped goes on at once (its card says
 * what happened), and so does any press once READY_WAIT_MS has passed since
 * the screen opened: the tile then catches up on Home.
 */
export const READY_POLL_MS = 2000;
export const READY_WAIT_MS = 45000;

/** Whether a press of the way on waits: a ready-made app still being set up, until the wait is up. */
export function holdsContinue(readyMade: boolean, appStatus: string | null, waitedOut: boolean): boolean {
  return readyMade && !waitedOut && appStatus !== 'running' && !stalledOf(appStatus);
}

/** The way on's label once pressed, while it waits (holdsContinue). */
export const GETTING_READY = 'onboarding:firstSession.made.gettingReady';

type Community = { member_count?: number; members?: (Person & { source?: string })[] } | null;

const COMMUNITY_POLL_MS = 10000;

/**
 * The project's community: read once (`on`), then again every ten seconds
 * while `polling` (an invite is out), so a join takes a seat.
 */
function useCommunity(slug: string, polling: boolean): Community {
  const [community, setCommunity] = useState<Community>(null);
  useEffect(() => {
    let live = true;
    const read = () => fetch(`/api/apps/${encodeURIComponent(slug)}/community`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && data) setCommunity(data); })
      .catch(() => {});
    read();
    const t = polling ? window.setInterval(read, COMMUNITY_POLL_MS) : 0;
    return () => { live = false; window.clearInterval(t); };
  }, [slug, polling]);
  return community;
}

/** The people row's faces: the community's members (its maker first), else just you. */
export function peopleOf(community: Community, me: string): Person[] {
  const members = Array.isArray(community?.members) ? community!.members.filter((m) => m && (m.username || m.display_name)) : [];
  return members.length ? members : [{ username: me || translate('onboarding:firstSession.made.people.you') }];
}

/** A quiet button: white, under or beside the blue one. */
const SECONDARY = 'flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

/** The made screen's root, full screen or under the platform header as make.tsx MAKE_ROOT is. */
export const MADE_ROOT = 'fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100';
export const MADE_ROOT_UNDER_HEADER = 'platform-under-header fixed inset-x-0 bottom-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100';

export function MadeScreen({ made, me, onContinue: goOn, onOpenChat, entry = 'first-session', onSetSecrets, underHeader = false }: {
  made: Made;
  me: string;
  /** "Invite people later" / "Start the tour" / "Go to …" (continueLabel): `skipped` when nothing went out. */
  onContinue: (skipped: boolean) => void;
  /** Go to chat, on the plan's card (from Create only): the chat with Homeroom bot, where the plan is answered. */
  onOpenChat: (conversationId: number | null) => void;
  entry?: MakeEntry;
  /** Set secrets, on a setup that waits on them: the project's secrets dialog. */
  onSetSecrets?: () => void;
  /** From Create, with the platform header showing: below it, with no wordmark bar of its own. */
  underHeader?: boolean;
}) {
  const t = useMessages('onboarding');
  const [fv, setFv] = useState<FirstVersion>(null);
  const [appStatus, setAppStatus] = useState<string | null>('creating');
  const [inviting, setInviting] = useState(false);
  // How the link last went out from the invite sheet, or null.
  const [sentHow, setSentHow] = useState<SentHow | null>(null);
  const sent = sentHow !== null;
  const [retrying, setRetrying] = useState(false);
  const imported = !!made.imported;
  const readyMade = !!made.readyMade;
  const fromCreate = entry === 'create';
  // Whether a first version has been read as on its way: once it has, a read
  // without one means it is live (or came to something else), and the
  // project is no longer "being made" (makerLine).
  const [building, setBuilding] = useState(false);
  // A ready-made app still being set up (READY-MADE, above): read more often.
  const settingUp = holdsContinue(readyMade, appStatus, false);

  useEffect(() => {
    let live = true;
    const read = () => fetch(madeAppUrl(made.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const app = madeAppOf(body);
        if (live && app) {
          setFv(app.firstVersion);
          setAppStatus(app.status);
          if (app.firstVersion && !app.firstVersion.ready) setBuilding(true);
        }
      })
      .catch(() => {});
    read();
    const t = window.setInterval(read, settingUp ? READY_POLL_MS : 10000);
    return () => { live = false; window.clearInterval(t); };
  }, [made.slug, settingUp]);

  // The way on, pressed: at once, or once a ready-made app runs
  // (holdsContinue). `waiting` is the press held, as `skipped`.
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaitedOut(true), READY_WAIT_MS);
    return () => window.clearTimeout(t);
  }, []);
  const holds = holdsContinue(readyMade, appStatus, waitedOut);
  const [waiting, setWaiting] = useState<boolean | null>(null);
  const onContinue = (skipped: boolean) => {
    if (holds) setWaiting(skipped);
    else goOn(skipped);
  };
  useEffect(() => {
    if (waiting === null || holds) return;
    setWaiting(null);
    goOn(waiting);
  }, [waiting, holds]);
  // Home is read again once it runs, so the grid it opens on has the tile
  // with its icon (Create's own onMade does the same, ./index.tsx).
  useEffect(() => {
    if (readyMade && appStatus === 'running') (window as { Home?: { load?: () => void } }).Home?.load?.();
  }, [readyMade, appStatus]);
  const onLabel = (sent: boolean) => (waiting !== null ? t(GETTING_READY) : continueLabel(entry, sent, made.name));

  // Try again, on a setup that stopped: creation starts over server-side and
  // the next read finds it creating; until then it says so here.
  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/retry`, { method: 'POST', credentials: 'same-origin' });
      if (res.ok) setAppStatus('creating');
    } catch { /* still stopped: the card stays, and pressing it again tries again */ }
    setRetrying(false);
  }, [made.slug, retrying]);

  const community = useCommunity(made.slug, sent);
  const plan = waitingPlan(fv);
  // A setup that failed or waits on secrets (stalledOf).
  const stalled = stalledOf(appStatus);
  // Not live yet: nothing read, still on its way, up for approval, or a
  // setup that stopped. That last reads no first version either, and is
  // nothing to try: the card said "Ready to try" over "Setting it up didn't
  // finish" until it counted here. An import, or a ready-made app, has no
  // first version at all: it is live once it runs.
  const making = imported || readyMade ? appStatus !== 'running' : (!!stalled || !(building && !fv));

  const botBuilds = made.conversationId != null;
  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const sketch = useSketch(made.slug);
  // An import or a ready-made app is never sketched: its plain card, not the
  // sketch's frame while the (absent) sketch is read.
  const card = !imported && !readyMade && showsCard(sketch.state);
  const line = madeLine(fv, botBuilds, !making, stalled, imported);
  // The thumbnail says only what the build line does not: a quiet note when
  // the bot builds nothing, or what a stopped setup or an import needs. The
  // plain card says the build's words and one line about what happens next.
  const note = card
    ? (stalled || imported ? buildNote(botBuilds, !!plan, stalled, imported) : botBuilds ? null : t(NO_BOT_NOTE))
    : buildNote(botBuilds, !!plan, stalled, imported, readyMade);
  const plainLine = buildLine(fv, appStatus, botBuilds, imported, readyMade);
  // Something is under way: the project being set up, or the bot's build
  // (not while its plan waits on them, nor on a setup that stopped: then
  // nothing is).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready) && !plan && !stalled);
  const tile = sketch.card?.emoji || made.emoji || made.name.slice(0, 1);
  return (
    <div
      role="dialog"
      aria-labelledby="first-session-made-title"
      data-first-session-made=""
      data-make-entry={entry}
      className={underHeader ? MADE_ROOT_UNDER_HEADER : MADE_ROOT}
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      {underHeader ? null : (
        // The logo bar: the whole mark below the status bar's inset, at least
        // 32px under it (the make screen's bar).
        <div data-first-session-made-top="" className="flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
          <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />
        </div>
      )}
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-6 pb-[max(36px,env(safe-area-inset-bottom))]">
        {/* The community and its app, one block, centred between the logo bar
            and the line over the buttons (canvas C3-started, C5-shared). */}
        <div data-first-session-made-body="" className="flex grow flex-col justify-center gap-4 py-4">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <PeopleRow people={peopleOf(community, me)} />
            <h1 id="first-session-made-title" className="text-[15px] font-normal leading-5 text-zinc-600 dark:text-zinc-400">{t(COMMUNITY_LABEL)}</h1>
          </div>
          {card ? (
            <SketchCard made={made} sketch={sketch} line={line} note={note} />
          ) : (
            <div className="flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
              <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
              <p className="mt-3 text-[22px] font-extrabold leading-tight">{made.name}</p>
              {made.description ? <p className="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">{made.description}</p> : null}
              <div className="mt-4 flex items-center gap-2 text-[14px] text-zinc-600 dark:text-zinc-300">
                {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
                <span data-first-session-build="">{plainLine}</span>
              </div>
              <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{note}</p>
            </div>
          )}
          {/* Under the project, never above it: the thumbnail stays where it is. */}
          {stalled ? (
            <SetupStoppedCard stalled={stalled} busy={retrying} onRetry={() => { void retry(); }} onSetSecrets={() => onSetSecrets?.()} />
          ) : null}
          {/* The first session asks for no answer yet: the plan waits until the
              tour ends. From Create there is no tour, so its card is the way
              to the chat where the plan is answered. */}
          {plan && !stalled && fromCreate ? <PlanWaitsCard name={made.name} onOpenChat={() => onOpenChat(plan.conversationId ?? made.conversationId)} /> : null}
        </div>
        <p role="status" data-first-session-hint={sentHow || ''} className="text-center text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
          {sentHow ? sharedLine(sentHow, !fromCreate) : t(INVITE_HINT)}
        </p>
        <div className="mt-[18px] flex flex-col gap-2.5">
          {/* The buttons keep their places once the link is out: Share again,
              grey, where Share invite was, and the way on, blue, where
              Invite people later was. */}
          {sent ? (
            <button type="button" data-first-session-share-again="" onClick={() => setInviting(true)} className={SECONDARY}>
              {t('onboarding:firstSession.made.shareAgain')}
            </button>
          ) : (
            <Button type="button" onClick={() => setInviting(true)} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center">
              {t('onboarding:firstSession.made.shareInvite')}
            </Button>
          )}
          {sent ? (
            <Button type="button" data-first-session-continue="" onClick={() => onContinue(false)} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center" aria-busy={waiting !== null || undefined}>
              {onLabel(true)}
            </Button>
          ) : (
            <button type="button" data-first-session-continue="" onClick={() => onContinue(true)} className={SECONDARY} aria-busy={waiting !== null || undefined}>
              {onLabel(false)}
            </button>
          )}
        </div>
      </div>
      {inviting ? (
        <InviteSheet
          made={sketch.card ? { ...made, emoji: sketch.card.emoji } : made}
          me={me}
          onClose={() => setInviting(false)}
          onSent={(how) => setSentHow(how)}
        />
      ) : null}
    </div>
  );
}
