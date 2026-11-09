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
 *             in blue), as it does on every screen. The "Needs you" card
 *             that asked for it before anyone was invited is gone from the
 *             first session (Evan's test, 6 October 2026). From Create, the
 *             card stays for a plan with nothing to ask (PlanWaitsCard). A
 *             project Homeroom bot does not build has no line, and one quiet
 *             note under the card says who builds it (NO_BOT_NOTE). Once
 *             there is a picture of the app (a ready-made app's example, or
 *             the first look), a switch in its corner turns it between the
 *             invite and the app, starting on the app (INVITE | APP).
 *   asks      QUICK QUESTIONS (newcomer run four, 13 October 2026): its plan
 *             is written at Make it, while the project is set up
 *             (services/first-version-plan.js), and when it has questions
 *             they take the invite line's place, each with its suggested
 *             answer chosen, with Submit, which starts the build. Then the
 *             screen is as below, its line saying the bot builds it.
 *   invite    One quiet line, "Invite people to use it and help improve it
 *             together.", over Share invite and Invite people later. Once the
 *             link has gone out the line says so ("Invite shared." or "Link
 *             copied."), and the buttons keep their places: Share again,
 *             grey, where Share invite was, and Go to app, blue, where
 *             Invite people later was (owner, 8 October 2026; Evan, 15 Oct
 *             2026). Both open the app full screen once it runs; one
 *             Homeroom bot is still building goes Home instead, "Continue"
 *             (./index.tsx). From Create the second button goes to the
 *             project (continueLabel).
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
 * has no end date and no limit of people (LINK_DAYS, LINK_USES), like every
 * new link, and the sheet says so. A note they wrote themselves and shared (the share sheet, not Copy
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
 *
 * UNTIL IT RUNS (#4900) the way on is off and a small card under the project
 * says how far its setup has got (SetupProgress, below).
 *
 * ONE THING AT A TIME (newcomer run six, 14 Oct 2026): for a project Homeroom
 * bot builds from its description, the first session's screen says one thing
 * is going on, never three. While it checks for questions, the project and
 * one spinner over the checking line; while it asks, the project and the
 * questions; at the invite ask, the project and one card, the first look,
 * that carries how far it has got (FirstLookCard, below).
 */

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SpinnerRingIcon, XIcon } from '@/components/ui/icons';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Wordmark } from '@/components/ui/wordmark';

import { useResolvedCommunityColor } from '../../lib/community-color';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { usePageLock } from '../../lib/page-lock';
import { askForPingWhileBotBuilds } from '../dialogs/ping-ask';
import { PlanChoices } from '../messages/bot-plan-view';
import type { HomeroomBotPlanQuestion } from '../messages/types';

import { BUILD_LINE_WORDS, type BuildLineState, buildLineAsks, buildLineDone, buildLineOf, buildLineStopped, phaseLine, useNow } from './build-line';
import { noteBuildStarted } from './build-line-words.js';
import { copyText, inviteText, withVia } from './copy-invite';
import { DrawnLook, isDrawnLook, ownSrc, useLookSwap } from './drawn-look';
import { FIRST_LOOK_POLL_MS, firstLookSrc } from './first-look';
import { syncBuildActivity } from '../app-frame/build-activity';
import { countsDown, estimateOf, leftNote } from '../app-frame/first-version-eta';
import { noteMoment } from './made-moments';
import type { Made, MakeEntry } from './make';
import type { FirstVersionStage } from './tour-steps';
import { type Person, PeopleRow } from './people-row';
import { SketchCard, showsCard, useSketch } from './sketch-card';
import { NotifyAsk } from '../notify-ask/notify-ask';

/** B6: the plan Homeroom bot waits on before it builds anything. */
export type WaitingPlan = {
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  actionId: number;
  messageId: number | null;
  conversationId: number | null;
};

/**
 * 13 Oct 2026: the plan written at Make it (services/first-version-plan.js),
 * for its creator: being written, or written, with its questions and
 * whether they are answered.
 */
export type EarlyPlan = {
  status?: 'pending' | 'ready';
  bullets?: string[];
  questions?: HomeroomBotPlanQuestion[];
  answered?: boolean;
} | null;

type FirstVersion = {
  step?: number; of?: number; ready?: boolean;
  /** #4053: its build line for this reader (homeroom-bot-progress.js buildLineOf). */
  line?: string | null;
  /** B6: the plan waiting for Build it, for its creator (GET /api/apps/:slug). */
  plan?: Partial<WaitingPlan> | null;
  /** 13 Oct 2026: its plan from Make it, for its creator. */
  early?: EarlyPlan;
  /** N4: the stage named, with when it began (homeroom-bot-progress.js firstVersionPhase). */
  phase?: unknown;
  /** Run six: how long it still has to go (services/first-version-eta.js). */
  estimate?: unknown;
  /** Its maker reads it (routes/apps.js): the Live Activity is theirs. */
  mine?: boolean;
  /** N4: every step, and once it is ready, who it waits on: for the Live Activity. */
  steps?: unknown;
  approval?: unknown;
} | null;

/**
 * The project's record as GET /api/apps/:slug answers it, which is `{ app }`:
 * its first version (null while the bot builds nothing), its status, and
 * while it is set up, the step its setup is on (`creationPhase`, SETUP_STEPS;
 * null when the server has none to say). Null for an answer without a
 * record. Page Turners, 5 October 2026: the made screen read `first_version`
 * off the answer itself, never found one, and so never drew the plan its
 * maker waited 18 minutes on.
 */
export function madeAppOf(body: unknown): { firstVersion: FirstVersion; status: string | null; phase: string | null } | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  if (!app || typeof app !== 'object') return null;
  const { first_version: firstVersion, status, creationPhase } = app as { first_version?: FirstVersion; status?: unknown; creationPhase?: unknown };
  return {
    firstVersion: firstVersion || null,
    status: typeof status === 'string' ? status : null,
    phase: typeof creationPhase === 'string' ? creationPhase : null,
  };
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

/**
 * QUICK QUESTIONS (newcomer run four, 13 Oct 2026). Its plan is written the
 * moment Make it is pressed, while the project is set up
 * (services/first-version-plan.js), and when it has questions this screen
 * asks them: each with its suggested answer chosen, and Submit, which keeps
 * the answers and starts the build (POST /api/apps/:slug/first-version/
 * answers). The questions are the plan's waiting for Build it when there is
 * one (the chat's card, the same plan), else the plan from Make it while it
 * is not answered; none for a plan that asks nothing. They slot in when they
 * arrive: until then, and once they are answered, the screen is as it was,
 * its line saying the bot builds it.
 */
export function askedQuestions(fv: FirstVersion): HomeroomBotPlanQuestion[] | null {
  const waiting = waitingPlan(fv);
  if (waiting) return waiting.questions.length ? waiting.questions : null;
  const early = fv && !fv.ready ? fv.early : null;
  if (!early || early.status !== 'ready' || early.answered || !Array.isArray(early.questions)) return null;
  const questions = early.questions.filter((q) => q && typeof q.question === 'string' && Array.isArray(q.answers) && q.answers.length >= 2);
  return questions.length ? questions.slice(0, 2) : null;
}

/**
 * Run five (13 Oct 2026): Share invite and Invite people later showed from
 * the first second, so a tap on either skipped the questions that came a
 * few seconds later. While the plan from Make it is being written, or
 * before the first read of a project the bot builds from a description,
 * the screen says it is checking in their place (CHECKING_LINE). Once the
 * plan is ready the questions come, or the invite buttons when it asks
 * nothing; a plan that failed, or one still not written PLAN_CHECK_MS after
 * the screen opened, gives the invite buttons back too.
 */
export const PLAN_CHECK_MS = 60000;

/** The line in place of the invite buttons while the plan is checked. A message id. */
export const CHECKING_LINE = 'onboarding:firstSession.made.checkingQuestions';

/**
 * Whether the screen is still checking for questions: `makesPlan` is a
 * project the bot builds from its description (not an import or a
 * ready-made app), `read` whether the project has been read once, and
 * `waited` whether PLAN_CHECK_MS has passed. Pure.
 */
export function checksForQuestions(fv: FirstVersion, { makesPlan, read, waited }: { makesPlan: boolean; read: boolean; waited: boolean }): boolean {
  if (!makesPlan || waited) return false;
  if (!read) return true;
  return !!fv && !fv.ready && !!fv.early && fv.early.status === 'pending';
}

/**
 * N1: where a project's first version stands as the made screen hands on:
 * on its way ('building'), built and waiting to be tried ('ready'), or none
 * (null: Homeroom bot builds nothing, or it is live already). Null opens the
 * app itself; anything else goes to Home, and its walk (./index.tsx).
 */
export function madeStage(fv: FirstVersion, botBuilds: boolean, live = false): FirstVersionStage {
  if (!botBuilds || live) return null;
  return fv && fv.ready ? 'ready' : 'building';
}

/** Where Submit sends the answers. */
export function answersUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/first-version/answers`;
}

/** The heading over the questions: "One quick question" or "Two quick questions". */
export function questionsTitle(count: number): string {
  return count === 1 ? translate('onboarding:firstSession.made.questions.titleOne') : translate('onboarding:firstSession.made.questions.titleTwo');
}

/**
 * The made screen's questions, with Submit, in place of the invite line and
 * its buttons until they are answered: the "Needs you" label the screen's
 * other waiting cards carry (PLAN_LABEL, centred here), the heading in the
 * accent, "Homeroom bot builds <project> from your answers.", then each
 * question on the plane's card (the plan card's own choices,
 * ../messages/bot-plan-view.tsx PlanChoices), its suggested answer chosen.
 */
export function QuickQuestions({ name, questions, busy = false, error = null, onSubmit }: {
  name: string;
  questions: HomeroomBotPlanQuestion[];
  busy?: boolean;
  error?: string | null;
  /** Submit, with the answer picked for each question (null for one left alone). */
  onSubmit: (answers: Array<string | null>) => void;
}) {
  const t = useMessages('onboarding');
  const uid = useId();
  const [picked, setPicked] = useState<Array<string | null>>(() => questions.map(() => null));
  const pick = (index: number, answer: string) => setPicked((now) => questions.map((_, i) => (i === index ? answer : now[i] ?? null)));
  return (
    <section data-first-session-questions={questions.length} aria-labelledby={`${uid}-title`} className="flex flex-col">
      <p data-first-session-questions-label="" className="px-1 pb-1.5 text-center text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t(PLAN_LABEL)}</p>
      <h2 id={`${uid}-title`} className="text-center text-[17px] font-semibold leading-snug text-violet-600 dark:text-violet-400">{questionsTitle(questions.length)}</h2>
      <p className="mt-1 text-center text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.made.questions.line', { project: name })}</p>
      <div className="mt-3 rounded-[20px] bg-white px-4 pb-1.5 text-start shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <PlanChoices questions={questions} picked={picked} onPick={pick} idBase={uid} top="plain" />
      </div>
      {error ? <p role="alert" className="mt-2 text-center text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
      <Button
        type="button"
        data-first-session-questions-submit=""
        onClick={() => onSubmit(questions.map((_, i) => picked[i] ?? null))}
        disabled={busy}
        layout="full"
        variant="pillAccent"
        size="pillLg"
        ink="solidLate"
        className="mt-[18px] flex items-center justify-center disabled:opacity-60"
      >
        {t('onboarding:firstSession.made.questions.submit')}
      </Button>
    </section>
  );
}

/** Over the plan's card and the questions: the one thing on the screen that waits on them. A message id, as the labels below are. */
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

/** The line over the buttons once the link has gone out: what went out, and nothing about what comes next. */
export function sharedLine(how: SentHow): string {
  return how === 'copied' ? translate('onboarding:firstSession.made.sent.copied') : translate('onboarding:firstSession.made.sent.shared');
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
 *
 * A ready-made app has none (Evan, sign-up test, 20 Oct 2026): it said "It
 * works as it is. You and anyone you invite can change it from there.",
 * which read as random under a card whose name and description already say
 * what it is, beside a setup card that says it is ready to use.
 */
export function buildNote(botBuilds: boolean, planWaits = false, stalled: Stalled = null, imported = false, readyMade = false): string | null {
  if (stalled === 'failed') return translate('onboarding:firstSession.made.note.failed');
  if (stalled === 'needs-secrets') return translate('onboarding:firstSession.made.note.needsSecrets');
  if (imported) return translate('onboarding:firstSession.made.note.imported');
  if (readyMade) return null;
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
// DEFAULT_DAYS and DEFAULT_USES): no end date and no limit of people, 0
// asking for each (9 Nov 2026). It stopped after a week or 25 people while a
// link let somebody new straight in as a private member and nothing else
// stood in a leak's way; the leaked-link guard does that now (a link that
// brings in 100 people in a day pauses itself, and its maker is told). The
// project's invite pane still makes a shorter or smaller one on request.
const LINK_DAYS = 0;
const LINK_USES = 0;

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
  const mine = links.find((l) => {
    if (!l || typeof l !== 'object') return false;
    const row = l as { mine?: boolean; status?: unknown; note?: unknown };
    // The list also carries links that ended recently: not one of these.
    if (!row.mine || (row.status != null && row.status !== 'live')) return false;
    return typeof row.note === 'string' && row.note;
  });
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
 * IT LEAVES THE WAY IT CAME (newcomer run, 20 Oct 2026, iPhone). It slid up
 * over 200ms and every way out (✕, Done, the dim, Escape) took it off the
 * page in the same frame, so it vanished. Now a way out slides it down first
 * and `onClose` runs when the slide has run (its transitionend, or
 * INVITE_SLIDE_MS and a little after, whichever comes first), as the Who says
 * yes? sheet leaves (PresetsSheet). With reduced motion it goes
 * at once.
 */
export const INVITE_SLIDE_MS = 200;

function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

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
  // Every way out slides it down, then `onClose` takes it off the page
  // (INVITE_SLIDE_MS).
  const leaving = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClose);
  closedRef.current = onClose;
  const close = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    const panel = panelRef.current;
    if (reducedMotion() || !panel) { closedRef.current(); return; }
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      panel.removeEventListener('transitionend', onEnd);
      closedRef.current();
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === panel && e.propertyName === 'transform') gone(); };
    panel.addEventListener('transitionend', onEnd);
    window.setTimeout(gone, INVITE_SLIDE_MS + 60);
    setShown(false);
  }, []);
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
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
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
          await nav.share({ title, text: note.trim() || undefined, url: withVia(url, 'shared') });
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
      const outcome = await copyText(inviteText(note, withVia(url, 'copied')));
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
      const outcome = await copyText(ready ? inviteText(note, withVia(ready, 'copied'))
        : link().then((url) => (url ? inviteText(note, withVia(url, 'copied')) : null)));
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
      <div aria-hidden="true" onClick={close} className={`absolute inset-0 touch-none bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-session-invite-title"
        className={`absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto overscroll-contain rounded-t-[20px] bg-zinc-100 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-zinc-900 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="first-session-invite-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.invite.title', { community: made.name })}</h2>
          <button type="button" onClick={close} aria-label={t('core:common.close')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
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
        {/* Once the link has gone out: hear when they join? (the
            notification ask, ../notify-ask/notify-ask.tsx), then Done. */}
        {out ? <NotifyAsk moment="invite_sent" tone="white" className="mt-3" /> : null}
        {/* Once the link has gone out the sheet stays, with Done to close it. */}
        {out ? (
          <Button
            type="button"
            data-first-session-invite-done=""
            onClick={close}
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
      <div className="flex items-center gap-3 rounded-[20px] bg-white py-3 ps-4 pe-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
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
      <div className="flex items-center gap-3 rounded-[20px] bg-white py-3 ps-4 pe-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
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
 * The made screen's second button: "Invite people later" until an invite is
 * out, then the way on. From Create, to the project itself ("Go to <name>").
 * On the first session, the app itself ("Go to app", Evan, 15 Oct 2026),
 * which both buttons open full screen once it runs; while Homeroom bot is
 * still building it (`building`: its stage, madeStage, is not null) there is
 * no app to go to yet, and the way on is Home ("Continue").
 */
export function continueLabel(entry: MakeEntry, sent: boolean, name: string, building = false): string {
  if (!sent) return translate('onboarding:firstSession.made.inviteLater');
  if (entry === 'create') return translate('onboarding:firstSession.made.goTo', { community: name });
  return building ? translate('onboarding:firstSession.made.continue') : translate('onboarding:firstSession.made.goToApp');
}

/*
 * IT RUNS BEFORE THE WAY ON GOES. Evan, 10 Oct 2026, iPhone: Home showed the
 * new project as a grey letter, "Spinning up...", that the tour's first card
 * asked them to tap and that a tap did nothing on. A press of the way on then
 * waited for a ready-made app to run, its label "Getting it ready...". The
 * onboarding run of 12 Oct 2026 (#4900, iPhone 17): that label held for about
 * 30 seconds with nothing but "Setting it up..." to say how far it had got,
 * then let them on before it ran, and the tour stood over its tile and over
 * the app's "Opening..." cover.
 *
 * So until the app runs, the way on ("Invite people later", or "Go to app"
 * once the invite is out) is off: for every project on the first session,
 * which opens it next (or Home, while its first version is built), and for
 * a ready-made app from Create
 * (waitsToRun). A project the bot builds from Create goes to its hub, which
 * shows a setup as it goes. Share invite stays on: the wait is a good time
 * for it. A tile is tappable once its status is "running" (Home's appView
 * `clickable`), so that is the signal, read every READY_POLL_MS while it is
 * set up, and once it runs Home is read again so the tile has it.
 *
 * Under the project a small card says how far it has got (SetupProgress):
 * the step the server reports (`creationPhase`, SETUP_STEPS), in words and
 * on a ring, and how long setting up usually takes. That is the estimate the
 * create dialog gave ("usually takes under a minute"), said as about a
 * minute; past SETUP_USUAL_MS the card says it should be ready shortly.
 * The server times each step only once the setup is over (its
 * `app_creation_timed` event, #4912), so there is no countdown and no time
 * per step.
 *
 * It is never a wall. A setup that stopped lets them on at once (its card
 * says what happened, with Try again), and READY_WAIT_MS after the screen
 * opened (or after Try again) the way on comes back however far it has got,
 * and the card says so. The tip in the app waits for it to open
 * (./first-visit.ts tipDue). The server stops a setup after five minutes
 * (routes/apps.js CREATION_TIMEOUT_MS), which then reads as stopped here.
 */
export const READY_POLL_MS = 2000;
export const SETUP_USUAL_MS = 60000;
export const READY_WAIT_MS = 120000;

/** Whose way on waits for the app to run: every project on the first session, and a ready-made app from Create. */
export function waitsToRun(entry: MakeEntry, readyMade: boolean): boolean {
  return entry !== 'create' || readyMade;
}

/** Whether the way on is off: an app that waits to run, until it runs, its setup stops, or the wait is up. */
export function holdsContinue(waits: boolean, appStatus: string | null, waitedOut: boolean): boolean {
  return waits && !waitedOut && appStatus !== 'running' && !stalledOf(appStatus);
}

/** The progress card's title until the server has said which step its setup is on. */
export const GETTING_READY = 'onboarding:firstSession.made.gettingReady';

/**
 * Setting a project up, in order: services/app-creation-phase.js PHASES, as
 * GET /api/apps/:slug `creationPhase` names them. Its database, its code (the
 * repository and its first commit), the build that makes it something that
 * can run, and starting it. The words are the card's title, message ids.
 */
export const SETUP_STEPS = ['database', 'repository', 'build', 'deploy'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_WORDS: Readonly<Record<SetupStep, string>> = Object.freeze({
  database: 'onboarding:firstSession.made.setup.database',
  repository: 'onboarding:firstSession.made.setup.repository',
  build: 'onboarding:firstSession.made.setup.build',
  deploy: 'onboarding:firstSession.made.setup.deploy',
});

/**
 * The step a `creationPhase` names, counted from 1, or 0 for none: before the
 * first read, or a server that has no step to say (one restarted mid-setup).
 * The screen keeps the furthest step it has read, so a read without one never
 * sends the card back to the start.
 */
export function setupStepOf(phase: unknown): number {
  return SETUP_STEPS.indexOf(phase as SetupStep) + 1;
}

/** The card's second line: how long it usually takes, that it should be ready shortly, then that they can go on. */
export function setupEstimate(slow: boolean, waitedOut: boolean): string {
  if (waitedOut) return translate('onboarding:firstSession.made.setup.goOn');
  return slow ? translate('onboarding:firstSession.made.setup.slow') : translate('onboarding:firstSession.made.setup.usual');
}

/** The progress card's second line once it has run (READY IN PLACE), and its title over a sketch, whose own line says the rest. */
export const SETUP_DONE = 'onboarding:firstSession.made.setup.done';
export const SETUP_SET_UP = 'onboarding:firstSession.made.setup.setUp';

/**
 * Run five (13 Oct 2026): the lines over the questions hold their height
 * whatever they say, so a read that changes them never moves Submit from
 * under a finger (everything dropped about 35pt between seeing Submit and
 * tapping it). The card is one height in every state: its title one line,
 * its note at most two, room kept for both.
 */
export const SETUP_ROW = 'flex h-[84px] items-center gap-3 rounded-[20px] bg-white py-3 ps-3 pe-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
export const SETUP_NOTE = 'line-clamp-2 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400';

/**
 * How far the setup has got, under the project while the way on waits for it
 * (IT RUNS BEFORE THE WAY ON GOES): a ring with the step ("2/4", the bot's
 * activity cards' ring, turning while it is under way), the step in words,
 * and how long it usually takes. A row, 15 over 13, on the plane's card.
 *
 * READY IN PLACE (onboarding run two, 12 Oct 2026, iPhone 17): the card went
 * the moment the app ran, in one frame, and everything over and under it
 * dropped 33pt, because the block is centred. Once it has shown it stays:
 * `done` is the line the project's own card would have said ("Ready to
 * use."), or "It's set up." over a sketch, which says the build itself; the
 * ring full and quiet, turning on only while the bot still builds.
 *
 * AND GREEN ONCE IT IS MADE (newcomer run, 20 Oct 2026: "the ring when it's
 * done making should be green, not gray"). `finished`: it runs and nothing
 * more is coming for it (a ready-made app, an import, or a first version
 * that is ready or live). Then the full ring is --state-ok, as a finished
 * progress bar is (AGENTS.md, "One accent"): the end is the good news. While
 * the bot still builds, its plan waits, or its build stopped, the ring stays
 * the quiet grey, so green never claims a build that is not there.
 */
export const RING_FINISHED = 'stroke-[color:var(--state-ok)]';
export const RING_QUIET = 'stroke-zinc-400 dark:stroke-zinc-500';

export function SetupProgress({ step, slow, waitedOut, done = null }: {
  step: number; slow: boolean; waitedOut: boolean; done?: { line: string; busy: boolean; finished?: boolean } | null;
}) {
  const t = useMessages('onboarding');
  const total = SETUP_STEPS.length;
  if (done) {
    return (
      <section data-made-setup="done" className="mt-4">
        <div className={SETUP_ROW}>
          <ProgressRing
            pct={100}
            label={`${total}/${total}`}
            title={done.line}
            spinning={done.busy}
            arcClassName={done.finished && !done.busy ? RING_FINISHED : RING_QUIET}
            trackClassName="dark:stroke-zinc-700"
          />
          <div role="status" className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-[650] leading-5">{done.line}</p>
            <p className={SETUP_NOTE}>{t(SETUP_DONE)}</p>
          </div>
        </div>
      </section>
    );
  }
  const at = step > 0 && step <= total ? SETUP_STEPS[step - 1] : null;
  return (
    <section data-made-setup={at || 'started'} className="mt-4">
      <div className={SETUP_ROW}>
        <ProgressRing
          pct={at ? Math.round((step / total) * 100) : 0}
          label={at ? `${step}/${total}` : undefined}
          title={at ? t('onboarding:firstSession.made.setup.ring', { step, total }) : t(GETTING_READY)}
          spinning
          trackClassName="dark:stroke-zinc-700"
        />
        <div role="status" className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-[650] leading-5">{at ? t(SETUP_WORDS[at]) : t(GETTING_READY)}</p>
          <p className={SETUP_NOTE}>{setupEstimate(slow, waitedOut)}</p>
        </div>
      </div>
    </section>
  );
}

/*
 * ONE THING AT A TIME (newcomer run six, 14 Oct 2026, iPhone 17 Safari, Club
 * Votes). Between Make it and the questions the screen said three things
 * were under way at once: "Homeroom bot is planning it" under the project,
 * the setup's card ("Setting up its storage… 1/4", "This usually takes about
 * a minute."), and "Checking whether Homeroom bot needs to ask you anything
 * first." where the buttons go. With the questions up, the planning line
 * stayed, though the plan was written, and "Preparing it to run… 3/4" sat
 * over them. After Submit, a "Starting the build" line and the setup's card
 * were both there again. Now a project Homeroom bot builds from its
 * description, on the first session (`firstLookHere`), says one thing at a
 * time (screenOf):
 *
 *   checking   the project, then one spinner over the checking line, just
 *              under it (IN ONE PLACE, run seven);
 *   questions  the project, then the questions and Submit, in that place;
 *   invite     the project, then one card that carries both the first look
 *              and how far it has got (FirstLookCard), then the invite line
 *              and its buttons.
 *
 * The setup goes on underneath the whole time and is read as before (the way
 * on still waits for it); its progress is drawn only from the invite ask on.
 * The project's own card is the same in every state: its icon is what the
 * people invited see, so the first look goes in the card under it, and in the
 * card only as its App side, switched in its corner (INVITE | APP, below).
 * From Create the screen hands on to the hub, which shows the setup as it
 * goes: there the line under the project says where it is once the
 * questions are done, as before.
 */

/** Which of the three the screen shows, or 'stalled' for a setup that stopped. Pure. */
export type MadeScreenState = 'checking' | 'questions' | 'invite' | 'stalled';

export function screenOf({ checking, asking, stalled }: { checking: boolean; asking: boolean; stalled: boolean }): MadeScreenState {
  if (stalled) return 'stalled';
  if (asking) return 'questions';
  return checking ? 'checking' : 'invite';
}

/**
 * What stands under the project in each state, beside the one thing the
 * state says. `ownLine`: the project's own line under it (the build line
 * under a sketch, the plain card's row). `setupCard`: SetupProgress, while
 * it is set up and once it has run in place. `firstLook`: FirstLookCard,
 * which carries the setup's progress and then the stage in their place.
 * While it checks or asks, none of the three. Pure.
 */
export function madeParts(screen: MadeScreenState, firstLookHere: boolean): { ownLine: boolean; setupCard: boolean; firstLook: boolean } {
  const quiet = screen === 'checking' || screen === 'questions';
  const firstLook = firstLookHere && screen === 'invite';
  return { ownLine: !quiet && !firstLook, setupCard: !quiet && !firstLookHere, firstLook };
}

/*
 * IN ONE PLACE (newcomer run seven, 14 Oct 2026, iPhone Safari, Club Votes):
 * the body grew and centred the project in the room above the footer, so
 * while it checked the spinner sat about 150px under the card, by the
 * toolbar, and when the questions came about 3 seconds later the card
 * jumped up to make room for them. While it checks or asks, the body now
 * stands at the top and takes only its own height (MADE_BODY_TOP), so the
 * spinner line is 16px under the card and the questions come in its place,
 * with the card where it was. The invite ask (and a stopped setup) is
 * centred as before (MADE_BODY).
 */
export const MADE_BODY = 'flex grow flex-col justify-center gap-4 py-4';
export const MADE_BODY_TOP = 'flex flex-col gap-4 py-4';

/** The made screen's body for a state: at the top while it checks or asks, else centred. Pure. */
export function madeBodyClass(screen: MadeScreenState): string {
  return screen === 'checking' || screen === 'questions' ? MADE_BODY_TOP : MADE_BODY;
}

/**
 * Whose made screen carries the first look card: a project Homeroom bot
 * builds from its description (not an import or a ready-made app), on the
 * first session (from Create the screen goes to the hub at once). Pure.
 */
export function firstLookHereFor({ botBuilds, imported, readyMade, entry }: { botBuilds: boolean; imported: boolean; readyMade: boolean; entry: MakeEntry }): boolean {
  return botBuilds && !imported && !readyMade && entry !== 'create';
}

/** The first look card's small caps kicker and its title, message ids. */
export const FIRST_LOOK_KICKER = 'onboarding:firstSession.made.firstLook.kicker';
export const FIRST_LOOK_TITLE = 'onboarding:firstSession.made.firstLook.title';

/**
 * The first look card's second progress line while it is set up: how long it
 * usually takes, then that it should be ready shortly, then that they can go on.
 * SetupProgress's own words (setupEstimate), said short enough for the
 * card's narrow column.
 */
export function firstLookEstimate(slow: boolean, waitedOut: boolean): string {
  if (waitedOut) return translate('onboarding:firstSession.made.firstLook.goOn');
  return slow ? translate('onboarding:firstSession.made.firstLook.slow') : translate('onboarding:firstSession.made.firstLook.usual');
}

/**
 * What the first look card's progress row says: the setup's step while it
 * is set up (SetupProgress's ring and words), then the first version's stage
 * in the words every screen says it in (`words`, ./build-line.tsx: the
 * phase's own, else the build line's), with its note.
 */
export type FirstLookProgress =
  | { setup: true; step: number; slow: boolean; waitedOut: boolean }
  | { setup: false; words: string; note: string; busy: boolean; asks: boolean; finished?: boolean };

/*
 * One height in every state (run five's rule for what stands over the
 * buttons): a picture arriving, the setup's step or the stage changing, a
 * note that is longer or shorter, none of it moves the buttons under it.
 * The phone is the App tab's frame (../app-frame/first-version-screens.tsx,
 * 390 × 844) drawn small.
 */
export const FIRST_LOOK_ROW = 'flex h-[132px] items-center gap-3.5 rounded-[20px] bg-white py-3 ps-3.5 pe-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
export const FIRST_LOOK_PHONE = 'relative h-[108px] w-[50px] shrink-0 overflow-hidden rounded-[11px] bg-zinc-100 shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800';
const FIRST_LOOK_STATUS = 'mt-2 flex h-10 items-center gap-2.5';
const FIRST_LOOK_STEP = 'truncate text-[14px] font-medium leading-[18px] text-zinc-700 dark:text-zinc-300';
const FIRST_LOOK_STEP_ASKS = 'truncate text-[14px] font-semibold leading-[18px] text-[color:var(--accent)]';
const FIRST_LOOK_NOTE = 'truncate text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400';

// The phone's picture fades in over its outline.
const LOOK_FADES = 'transition-opacity duration-300 ease-out motion-reduce:transition-none';

/**
 * The phone: the first look once there is one (the picture tour step 9 and
 * the App tab show, ./first-look.tsx firstLookSrc), faded in once it has
 * loaded; until then its outline, with a band of light passing over it, as
 * the project's card has while it is sketched. With reduced motion nothing
 * moves. A picture that will not load is given back (`onBroken`), and the
 * outline stays until another comes.
 *
 * 15 Oct 2026 (newcomer run nine, 11 seconds of the outline after Submit):
 * until the picture is saved, the drawn screen itself (./drawn-look.tsx),
 * faded in the same way; the picture then takes its place once it is in
 * (useLookSwap), cut in rather than faded over the outline, since it is the
 * same screen.
 */
function FirstLookPhone({ src: next, name, onBroken }: { src: string | null; name: string; onBroken: (src: string) => void }) {
  const t = useMessages('onboarding');
  const src = useLookSwap(next, ownSrc);
  const [loaded, setLoaded] = useState<string | null>(null);
  // The picture after the drawn screen is in already: no outline between.
  const cut = !!src && !!loaded && loaded !== src && isDrawnLook(loaded) && !isDrawnLook(src);
  const shown = !!src && (loaded === src || cut);
  const alt = t('onboarding:firstSession.made.firstLook.alt', { app: name });
  return (
    <div data-made-first-look-phone={shown ? 'ready' : 'drawing'} className={FIRST_LOOK_PHONE}>
      {shown ? null : (
        <div aria-hidden="true" className="absolute inset-0">
          <div className="absolute left-1/2 top-[5px] h-[3px] w-3 -translate-x-1/2 rounded-full bg-zinc-300 dark:bg-zinc-600" />
          <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
            <div className="h-full w-2/5 bg-gradient-to-r from-transparent via-white/70 to-transparent motion-safe:animate-card-sweep dark:via-white/[0.06]" />
          </div>
        </div>
      )}
      {src && isDrawnLook(src) ? (
        <DrawnLook
          key={src}
          src={src}
          label={alt}
          width={50}
          onLoad={() => setLoaded(src)}
          className={`${LOOK_FADES} ${shown ? 'opacity-100' : 'opacity-0'}`}
        />
      ) : src ? (
        <img
          key={src}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => onBroken(src)}
          className={`absolute inset-0 h-full w-full object-cover object-top ${cut ? '' : `${LOOK_FADES} `}${shown ? 'opacity-100' : 'opacity-0'}`}
        />
      ) : null}
    </div>
  );
}

/** The first look card's progress row: a ring, and two lines beside it. */
function FirstLookStatus({ progress }: { progress: FirstLookProgress }) {
  const t = useMessages('onboarding');
  const total = SETUP_STEPS.length;
  if (progress.setup) {
    const { step, slow, waitedOut } = progress;
    const at = step > 0 && step <= total ? SETUP_STEPS[step - 1] : null;
    return (
      <div role="status" data-made-first-look-status={at || 'started'} className={FIRST_LOOK_STATUS}>
        <ProgressRing
          pct={at ? Math.round((step / total) * 100) : 0}
          label={at ? `${step}/${total}` : undefined}
          title={at ? t('onboarding:firstSession.made.setup.ring', { step, total }) : t(GETTING_READY)}
          spinning
          trackClassName="dark:stroke-zinc-700"
        />
        <div className="min-w-0 flex-1">
          <p className={FIRST_LOOK_STEP}>{at ? t(SETUP_WORDS[at]) : t(GETTING_READY)}</p>
          <p className={FIRST_LOOK_NOTE}>{firstLookEstimate(slow, waitedOut)}</p>
        </div>
      </div>
    );
  }
  // Set up: the ring full and quiet, turning while the bot is still at work,
  // and green once the first version is ready or live (SetupProgress, AND
  // GREEN ONCE IT IS MADE); the stage beside it.
  const { words, note, busy, asks, finished } = progress;
  return (
    <div role="status" data-made-first-look-status="stage" className={FIRST_LOOK_STATUS}>
      <ProgressRing
        pct={100}
        title={words}
        spinning={busy}
        arcClassName={finished && !busy ? RING_FINISHED : RING_QUIET}
        trackClassName="dark:stroke-zinc-700"
      />
      <div className="min-w-0 flex-1">
        <p className={asks ? FIRST_LOOK_STEP_ASKS : FIRST_LOOK_STEP}>{words}</p>
        <p className={FIRST_LOOK_NOTE}>{note}</p>
      </div>
    </div>
  );
}

/**
 * The invite ask's one card under the project: on the left, the first look
 * in a small phone; on the right, a small caps "First look", "Here's what
 * Homeroom bot is making", and how far it has got (FirstLookStatus). The
 * picture is swapped in where the outline was, whenever it comes: it can be
 * there already (drawn from the plan at Make it) or a minute after Submit.
 *
 * ONE PICTURE AT A TIME (15 Oct 2026): while the project's card above shows
 * the same first look as its App side (INVITE | APP, below), this card
 * leaves its phone out (`phone` false) and keeps its words and its progress
 * at the same height; flipped back to Invite, the phone is here again.
 *
 * TAPPING IT (#5618): with `onOpen`, the whole card is one more way into
 * the maker's chat with Homeroom bot, where the build is reported. An empty
 * button covers the card (above the phone and its iframe), so tapping the
 * picture, the words or the progress opens it; the card keeps its look, and
 * only a hover tint and the focus ring say it can be tapped.
 */
export function FirstLookCard({ src, name, progress, onBroken = () => {}, phone = true, onOpen }: {
  /** The first look's URL (./first-look.tsx firstLookSrc), or null while there is none. */
  src: string | null;
  name: string;
  progress: FirstLookProgress;
  onBroken?: (src: string) => void;
  /** Whether the card draws the first look itself: not while the project's card above shows it. */
  phone?: boolean;
  /** Opens the maker's chat with Homeroom bot: the whole card becomes its door. */
  onOpen?: () => void;
}) {
  const t = useMessages('onboarding');
  return (
    <section data-made-first-look={src ? 'ready' : 'drawing'} data-made-first-look-above={phone ? undefined : ''} aria-labelledby="made-first-look-title" className="relative">
      <div className={FIRST_LOOK_ROW}>
        {phone ? <FirstLookPhone src={src} name={name} onBroken={onBroken} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-[12px] font-bold uppercase leading-4 tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t(FIRST_LOOK_KICKER)}</p>
          <h2 id="made-first-look-title" className="mt-0.5 line-clamp-2 text-[15px] font-[650] leading-5">{t(FIRST_LOOK_TITLE)}</h2>
          <FirstLookStatus progress={progress} />
        </div>
      </div>
      {onOpen ? (
        <button
          type="button"
          data-made-first-look-open=""
          aria-label={t('onboarding:firstSession.made.firstLook.open')}
          onClick={onOpen}
          className="absolute inset-0 z-[1] rounded-[20px] hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/[0.04]"
        />
      ) : null}
    </section>
  );
}

/**
 * In place of the invite line and its buttons while the plan may still have
 * questions (checksForQuestions): one spinner over the checking line, the
 * one thing the screen says is going on (ONE THING AT A TIME).
 */
export function CheckingLine() {
  const t = useMessages('onboarding');
  return (
    <div role="status" data-first-session-checking="" className="flex flex-col items-center gap-2.5 text-center text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
      <SpinnerRingIcon className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <p>{t(CHECKING_LINE)}</p>
    </div>
  );
}

/*
 * INVITE | APP (Evan, 15 Oct 2026: "on the corner of the thumbnail, a
 * toggle to switch between the share preview and what the app looks like;
 * for templated apps have an example ready that shows this immediately").
 * The project's card has two sides, switched in its top-right corner:
 *
 *   Invite  the card as it is, its icon, which is what the people invited
 *           see (the invite sheet's "What they'll see" stays icon only);
 *   App     what the app looks like, in the card's top area in place of the
 *           icon: a phone with the app's main screen, as the App tab draws
 *           its first look (../app-frame/first-version-screens.tsx), on the
 *           project's colour. The plain card drops its name and description
 *           there, since the picture shows the app; the note under them stays.
 *
 * The switch is there only when there is a picture (appPictureOf), and the
 * card starts on App whenever there is one; a side somebody picks stays
 * picked. A ready-made app has its example from the start
 * (services/app-templates.js `exampleScreen`, POST /api/apps), tagged
 * "Example" so nobody takes its sample entries for their own. A project
 * Homeroom bot builds gets its first look once it is drawn (the same picture
 * as the first look card under it, ./first-look.tsx firstLookSrc), with no
 * tag: it is their app. Until then, and for an import, there is no picture
 * and no switch.
 *
 * One picture at a time: while the App side shows the first look, the first
 * look card under it keeps its words and progress and leaves its phone out
 * (FirstLookCard `phone`). The switch never meets the icon: with it, the
 * Invite side's icon starts below it (PLAIN_INVITE_TOP, FeaturedCard
 * `cornerRoom`), and the App side's phone stands below it too. Switching
 * moves nothing under the card: both sides are the same height (the
 * band's, APP_BAND, for the card's top).
 */

/** Which side of the project's card shows. */
export type CardView = 'invite' | 'app';

/** The App side's picture: its URL, and whether it is a ready-made app's example rather than the project's own. */
export type AppPicture = { src: string; example: boolean };

/** The App side's picture for a project, or null for none (then the card has no switch). Pure. */
export function appPictureOf({ imported, readyMade, botBuilds, exampleScreen, look }: {
  imported: boolean;
  readyMade: boolean;
  botBuilds: boolean;
  /** A ready-made app's example (made.exampleScreen). */
  exampleScreen: string | null | undefined;
  /** The first look, once there is one (./first-look.tsx firstLookSrc). */
  look: string | null;
}): AppPicture | null {
  if (imported) return null;
  if (readyMade) return exampleScreen ? { src: exampleScreen, example: true } : null;
  return botBuilds && look ? { src: look, example: false } : null;
}

/** The side the card shows: the one picked, else App whenever there is a picture. Pure. */
export function cardViewOf(picture: AppPicture | null, picked: CardView | null): CardView {
  return picture ? picked || 'app' : 'invite';
}

/** The switch's two sides, each with its label's message id. */
const CARD_VIEWS: ReadonlyArray<{ value: CardView; label: string }> = [
  { value: 'invite', label: 'onboarding:firstSession.made.cardView.invite' },
  { value: 'app', label: 'onboarding:firstSession.made.cardView.app' },
];

/*
 * The App tab's "Preview | Live" switch, worn the same way (../app-frame/
 * live-switch.tsx): a dark track that reads on a colour, a picture or the
 * white card, and the side shown in white.
 */
export const CARD_SWITCH = 'flex rounded-full bg-black/55 p-0.5 text-[12px] font-semibold leading-4';
const CARD_SWITCH_SIDE = 'min-h-[24px] rounded-full px-2.5 py-1';
/** Where the switch sits: the card's top-right corner. */
export const CARD_CORNER = 'absolute end-3 top-3 z-10';

/** The switch in the card's corner. */
export function CardViewSwitch({ value, onChange }: { value: CardView; onChange: (view: CardView) => void }) {
  const t = useMessages('onboarding');
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v === 'app' ? 'app' : 'invite')}>
      <TabsList role="group" aria-label={t('onboarding:firstSession.made.cardView.label')} data-first-session-card-switch={value} className={CARD_SWITCH}>
        {CARD_VIEWS.map((side) => (
          <TabsTrigger
            key={side.value}
            type="button"
            value={side.value}
            data-card-view={side.value}
            className={CARD_SWITCH_SIDE}
            activeClassName="bg-white text-zinc-900"
            inactiveClassName="text-white"
          >
            {t(side.label)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * The App side's band: the card's top area at one height on both cards (the
 * sketch's FeaturedCard band and the plain card's), with the phone standing
 * in it as on the App tab, drawn smaller for this screen: its top clears the
 * switch and the tag, and the screen still fits a 390 x 844 phone with the
 * invite buttons in view. The card shows the band alone there, no name or
 * description: the picture shows the app.
 */
export const APP_BAND = 'h-[264px]';
export const APP_PHONE = 'relative h-[204px] w-[94px] shrink-0 overflow-hidden rounded-[18px] bg-white shadow-[0_10px_28px_rgba(0,0,0,0.22),0_0_0_4px_rgba(17,17,20,0.9)]';
const APP_PHONE_WIDTH = 94;
/** The "Example" tag: the App tab's pill over its band (first-version-screens.tsx). */
const EXAMPLE_TAG = 'pointer-events-none absolute start-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-semibold leading-4 text-white';

/**
 * The App side: the phone with the picture (the drawn first look framed as
 * ./drawn-look.tsx frames it, else the image), and "Example" over the
 * band's top-left corner for a ready-made app's example. A picture that will
 * not load is given back (`onBroken`), and the card goes back to its icon.
 */
export function AppScreen({ picture, name, onBroken = () => {} }: { picture: AppPicture; name: string; onBroken?: (src: string) => void }) {
  const t = useMessages('onboarding');
  const alt = picture.example
    ? t('onboarding:firstSession.made.cardView.exampleAlt', { app: name })
    : t('onboarding:firstSession.made.firstLook.alt', { app: name });
  return (
    <div data-first-session-app-screen={picture.example ? 'example' : 'own'} className="absolute inset-0 flex items-end justify-center pb-2.5">
      <div className={APP_PHONE}>
        {isDrawnLook(picture.src) ? (
          <DrawnLook key={picture.src} src={picture.src} label={alt} width={APP_PHONE_WIDTH} />
        ) : (
          <img
            key={picture.src}
            src={picture.src}
            alt={alt}
            draggable={false}
            onError={() => onBroken(picture.src)}
            className="h-full w-full object-cover object-top"
          />
        )}
      </div>
      {picture.example ? <span data-first-session-example-tag="" className={EXAMPLE_TAG}>{t('onboarding:firstSession.made.cardView.example')}</span> : null}
    </div>
  );
}

/** The plain card's App side: the band on the project's colour, with the App side and the switch over it. */
function PlainAppBand({ emoji, colorKey, children, corner }: { emoji: string | null; colorKey: string; children: ReactNode; corner: ReactNode }) {
  const color = useResolvedCommunityColor({ iconEmoji: emoji, key: colorKey });
  return (
    <div
      className={`relative -mx-6 self-stretch overflow-hidden bg-zinc-200 dark:bg-zinc-800 ${APP_BAND}`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {children}
      <div className={CARD_CORNER}>{corner}</div>
    </div>
  );
}

/**
 * The plain card (no sketch): with no switch, padded round its icon, the
 * card it always was (PLAIN_CARD). With the switch, both sides are one card
 * (PLAIN_CARD_APP) whose top is the band's height (APP_BAND): on App the
 * band to its edges, on Invite the icon, the name and the description in a
 * box of the same height (PLAIN_INVITE_TOP). So the note under them starts
 * 264px down on either side and the card keeps one height: on a 390 x 844
 * phone the screen overflows, and a shorter Invite side moved the note, the
 * setup card and both buttons by the difference (Evan, sign-up test, 19 Oct
 * 2026). The Invite side's icon starts below the switch (pt-10: the switch
 * ends at 40px), so the two never meet, however narrow the phone or long
 * the switch's words: at 320px wide they did. The name and the description
 * take two lines each at most, so a long one cannot spill out of the box.
 */
export const PLAIN_CARD = 'relative flex flex-col items-center rounded-[20px] bg-white px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
export const PLAIN_CARD_APP = 'relative flex flex-col items-center overflow-hidden rounded-[20px] bg-white px-6 pb-6 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
export const PLAIN_INVITE_TOP = `relative -mx-6 flex flex-col items-center justify-center self-stretch px-6 pt-10 ${APP_BAND}`;

/**
 * The project's card when it has no sketch (a ready-made app, an import, a
 * sketch that never came). Its Invite side is the card as it always was:
 * the icon tile, the name and the description, with the switch in the
 * corner once there is one. Its App side (`band`, the AppScreen) is the band
 * in their place. `children` close it on either side: the build row and the
 * note under them.
 */
export function PlainCard({ made, tile, emoji, band = null, corner = null, children }: {
  made: Pick<Made, 'slug' | 'name' | 'description'>;
  /** What the tile shows: the icon, else the name's first letter. */
  tile: string;
  /** The icon the band's colour is read from. */
  emoji: string | null;
  /** The App side, while it shows (AppScreen). */
  band?: ReactNode;
  /** The switch (CardViewSwitch), once there is a picture. */
  corner?: ReactNode;
  children?: ReactNode;
}) {
  const face = (
    <>
      <span className="app-icon-tile flex h-20 w-20 items-center justify-center rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
      <p className={corner ? 'mt-3 line-clamp-2 text-[22px] font-extrabold leading-tight' : 'mt-3 text-[22px] font-extrabold leading-tight'}>{made.name}</p>
      {made.description ? <p className={corner ? 'mt-1 line-clamp-2 text-[15px] text-zinc-500 dark:text-zinc-400' : 'mt-1 text-[15px] text-zinc-500 dark:text-zinc-400'}>{made.description}</p> : null}
    </>
  );
  return (
    <div data-first-session-card={corner ? (band ? 'app' : 'invite') : undefined} className={band || corner ? PLAIN_CARD_APP : PLAIN_CARD}>
      {band ? (
        <PlainAppBand emoji={emoji} colorKey={made.slug} corner={corner}>{band}</PlainAppBand>
      ) : corner ? (
        <div data-first-session-card-top="" className={PLAIN_INVITE_TOP}>
          <div className={CARD_CORNER}>{corner}</div>
          {face}
        </div>
      ) : face}
      {children}
    </div>
  );
}

type Community ={ member_count?: number; members?: (Person & { source?: string })[] } | null;

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

/** A quiet button: white, under or beside the blue one. Dimmed while it is off (holdsContinue). */
const SECONDARY = 'flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

/** The made screen's root, full screen or under the platform header as make.tsx MAKE_ROOT is. */
export const MADE_ROOT = 'fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100';
export const MADE_ROOT_UNDER_HEADER = 'platform-under-header fixed inset-x-0 bottom-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100';

export function MadeScreen({ made, me, onContinue, onOpenChat, entry = 'first-session', onSetSecrets, underHeader = false }: {
  made: Made;
  me: string;
  /**
   * "Invite people later" / "Go to app" / "Continue" / "Go to …"
   * (continueLabel): `skipped` when nothing went out; `firstVersion`, where
   * its first version stands (madeStage): null once it runs, when the app
   * itself opens, else Home and its walk (./index.tsx).
   */
  onContinue: (skipped: boolean, firstVersion: FirstVersionStage) => void;
  /** Go to chat, on the plan's card (from Create only): the chat with Homeroom bot, where the plan is answered. */
  onOpenChat: (conversationId: number | null) => void;
  entry?: MakeEntry;
  /** Set secrets, on a setup that waits on them: the project's secrets dialog. */
  onSetSecrets?: () => void;
  /** From Create, with the platform header showing: below it, with no wordmark bar of its own. */
  underHeader?: boolean;
}) {
  const t = useMessages('onboarding');
  // Home holds still under it, as under the make screen (lib/page-lock.ts):
  // inert on the first session, only kept from scrolling under the header.
  const rootRef = useRef<HTMLDivElement>(null);
  usePageLock(rootRef, { inert: !underHeader });
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
  // Whether the way on waits for it to run (IT RUNS BEFORE THE WAY ON GOES,
  // above), and whether it is still being set up for it: read more often.
  const waits = waitsToRun(entry, readyMade);
  const settingUp = holdsContinue(waits, appStatus, false);
  // The furthest step of its setup read so far (setupStepOf).
  const [setupStep, setSetupStep] = useState(0);
  // Whether its setup's card has shown here: then it stays once the app runs
  // (READY IN PLACE, SetupProgress).
  const [setupShown, setSetupShown] = useState(false);
  useEffect(() => { if (settingUp) setSetupShown(true); }, [settingUp]);

  // Its plan from Make it is being written: read as often as the setup is,
  // so its questions slot in the moment they are there.
  const planComing = !!fv && !!fv.early && fv.early.status === 'pending';
  // Whether the project has been read once (checksForQuestions).
  const [readOnce, setReadOnce] = useState(false);
  // Read again at once after Submit (`reread`), so the line moves on.
  const [reread, setReread] = useState(0);
  const botBuilds = made.conversationId != null;
  // ONE THING AT A TIME: the first look card, and its picture from the same
  // read (./first-look.tsx firstLookSrc), asked for as often as tour step 9
  // asks (FIRST_LOOK_POLL_MS) while there is none. One that would not load
  // (`brokenLook`) counts as none until another comes. 15 Oct 2026: while
  // there is only its drawn screen (./drawn-look.tsx) it is asked for as
  // often, until its picture is saved.
  const firstLookHere = firstLookHereFor({ botBuilds, imported, readyMade, entry });
  const [look, setLook] = useState<string | null>(null);
  const [brokenLook, setBrokenLook] = useState<string | null>(null);
  const lookShown = look && look !== brokenLook ? look : null;
  const lookWaits = firstLookHere && (!lookShown || isDrawnLook(lookShown));
  useEffect(() => {
    let live = true;
    const read = () => fetch(madeAppUrl(made.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const app = madeAppOf(body);
        if (live && app) {
          setReadOnce(true);
          setFv(app.firstVersion);
          setAppStatus(app.status);
          setSetupStep((was) => Math.max(was, setupStepOf(app.phase)));
          if (app.firstVersion && !app.firstVersion.ready) setBuilding(true);
          const found = firstLookSrc(body, made.slug);
          if (found) setLook(found);
        }
      })
      .catch(() => {});
    read();
    const t = window.setInterval(read, settingUp || planComing ? READY_POLL_MS : lookWaits ? FIRST_LOOK_POLL_MS : 10000);
    return () => { live = false; window.clearInterval(t); };
  }, [made.slug, settingUp, planComing, lookWaits, reread]);

  // QUICK QUESTIONS: Submit keeps the answers and starts the build. Once
  // pressed here the questions go at once, whatever the next read says.
  const [answered, setAnswered] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const submitAnswers = useCallback(async (answers: Array<string | null>) => {
    if (answering) return;
    noteMoment(made.slug, 'submit_tapped', { count: answers.length });
    setAnswering(true);
    setAnswerError(null);
    try {
      const res = await fetch(answersUrl(made.slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setAnswered(true);
      // Run six: Home's tile says it is starting too, from now
      // (./build-line-words.js noteBuildStarted), not the list's "Plan ready".
      noteBuildStarted(made.slug);
      setReread((n) => n + 1);
    } catch {
      setAnswerError(translate('onboarding:firstSession.made.questions.error'));
    } finally {
      setAnswering(false);
    }
  }, [answering, made.slug]);
  const asked = answered ? null : askedQuestions(fv);
  // Run five: no invite buttons while the plan may still have questions
  // (checksForQuestions), for at most PLAN_CHECK_MS.
  const [planWaited, setPlanWaited] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setPlanWaited(true), PLAN_CHECK_MS);
    return () => window.clearTimeout(t);
  }, []);

  // How long it has waited, from the screen's opening or the last Try again
  // (`round`): longer than usual (`slow`), then long enough to let them on
  // however far it has got (`waitedOut`).
  const [round, setRound] = useState(0);
  const [slow, setSlow] = useState(false);
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    setSlow(false);
    setWaitedOut(false);
    const s = window.setTimeout(() => setSlow(true), SETUP_USUAL_MS);
    const w = window.setTimeout(() => setWaitedOut(true), READY_WAIT_MS);
    return () => { window.clearTimeout(s); window.clearTimeout(w); };
  }, [round]);
  // The way on is off until it runs (holdsContinue).
  const holds = holdsContinue(waits, appStatus, waitedOut);
  // Home is read again once it runs, so the grid the app opens from has the
  // tile, tappable and with its icon (Create's own onMade does the same,
  // ./index.tsx).
  useEffect(() => {
    if (waits && appStatus === 'running') (window as { Home?: { load?: () => void } }).Home?.load?.();
  }, [waits, appStatus]);

  // Try again, on a setup that stopped: creation starts over server-side and
  // the next read finds it creating; until then it says so here, from its
  // first step, and the way on waits for it again.
  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(made.slug)}/retry`, { method: 'POST', credentials: 'same-origin' });
      if (res.ok) {
        setAppStatus('creating');
        setSetupStep(0);
        setRound((r) => r + 1);
      }
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

  // WP-E: "Get a ping when it's ready?" in the Homeroom app, now that there
  // is something to be pinged about (features/dialogs/ping-ask.ts: it shows
  // nothing on the web, or once the phone's answer is decided).
  useEffect(() => { if (botBuilds) askForPingWhileBotBuilds(); }, [botBuilds]);
  const sketch = useSketch(made.slug);
  // An import or a ready-made app is never sketched: its plain card, not the
  // sketch's frame while the (absent) sketch is read.
  const card = !imported && !readyMade && showsCard(sketch.state);
  const served = madeLine(fv, botBuilds, !making, stalled, imported);
  // Answered here: built from now on, never planned again, until the next
  // read says where it is. Run five: while the questions are asked here,
  // the line says the bot is planning it, never "Your plan is ready to
  // review", which led to the chat's card asking the same questions.
  const line: BuildLineState | null = answered && (served === 'planning' || served === 'plan') ? 'building'
    : asked && served === 'plan' ? 'planning' : served;
  const checking = !asked && !stalled && checksForQuestions(fv, { makesPlan: botBuilds && !imported && !readyMade, read: readOnce, waited: planWaited });
  // N4: the stage by its own name while it is built, and for how long.
  const now = useNow();
  // Answered here and not read since: the build starting (run five).
  // Run six: the time left, as the App tab says it, when there is an estimate.
  const left = countsDown(line) ? leftNote(estimateOf(fv?.estimate), now) : null;
  const phase = fv?.phase || (answered && line === 'building' ? { key: 'starting' } : null);
  const named = phaseLine(line, phase, now, null, left);
  // Run six: the maker's Live Activity says what this line says, from
  // Submit on (../app-frame/build-activity.ts; the App tab calls the same).
  // Once the first version is gone the line says Live, which ends it.
  useEffect(() => {
    syncBuildActivity({
      slug: made.slug,
      name: made.name,
      mine: fv ? fv.mine === true : false,
      line,
      phase,
      steps: fv?.steps,
      estimate: fv?.estimate,
      approval: fv?.approval,
    });
    // `phase` is made from these (a new object on each render while answered).
  }, [made.slug, made.name, fv, line, answered, now]);
  // The thumbnail says only what the build line does not: a quiet note when
  // the bot builds nothing, or what a stopped setup or an import needs. The
  // plain card says the build's words and one line about what happens next.
  const note = card
    ? (stalled || imported ? buildNote(botBuilds, !!plan, stalled, imported) : botBuilds ? null : t(NO_BOT_NOTE))
    : buildNote(botBuilds, !!plan, stalled, imported, readyMade);
  const plainLine = named.words || (line === 'planning' && served === 'plan' ? translate(BUILD_LINE_WORDS.planning) : buildLine(fv, appStatus, botBuilds, imported, readyMade));
  // Something is under way: the project being set up, or the bot's build
  // (not while its plan waits on them, nor on a setup or a build that
  // stopped: then nothing is).
  const busy = appStatus === 'creating' || (botBuilds && !(fv && fv.ready) && !plan && !stalled && !buildLineStopped(line));
  // Made: it runs and nothing more is coming for it (a ready-made app, an
  // import, or a first version that is ready or live). Its rings go green.
  const finished = !busy && !stalled && appStatus === 'running' && (!botBuilds || (!!line && buildLineDone(line)));
  // Its setup's card, once it has run: in place, saying what the plain card would.
  const ranInPlace = setupShown && !settingUp && !stalled;
  const tile = sketch.card?.emoji || made.emoji || made.name.slice(0, 1);
  // INVITE | APP: the card's App side once there is a picture of the app,
  // shown first; a side somebody picks stays picked. A ready-made app's
  // example that will not load is none; the first look's is the first look
  // card's too (brokenLook).
  const [brokenExample, setBrokenExample] = useState(false);
  const picture = appPictureOf({ imported, readyMade, botBuilds, exampleScreen: brokenExample ? null : made.exampleScreen, look: lookShown });
  const [pickedView, setPickedView] = useState<CardView | null>(null);
  const view = cardViewOf(picture, pickedView);
  const viewSwitch = picture ? <CardViewSwitch value={view} onChange={setPickedView} /> : null;
  const appScreen = picture && view === 'app'
    ? <AppScreen picture={picture} name={made.name} onBroken={(src) => { if (picture.example) setBrokenExample(true); else setBrokenLook(src); }} />
    : null;
  // ONE PICTURE AT A TIME: the first look card leaves its phone out while
  // the card above shows the same picture.
  const lookInCard = !!appScreen && !!picture && !picture.example;
  // Where its first version stands: the app opens once it is null (N1).
  const stage = madeStage(fv, botBuilds && !imported && !readyMade, !making);
  // ONE THING AT A TIME (run six): which of checking, the questions and the
  // invite ask is up, and what stands under the project with it (madeParts).
  const screen = screenOf({ checking, asking: !!asked && !stalled, stalled: !!stalled });
  const { ownLine, setupCard, firstLook } = madeParts(screen, firstLookHere);
  const rowHidden = settingUp || ranInPlace || !ownLine;
  // The first look card's progress row: the setup's step until it runs, then
  // the stage in the build line's own words (BuildLine), with its note.
  const lookProgress: FirstLookProgress = settingUp
    ? { setup: true, step: setupStep, slow, waitedOut }
    : {
      setup: false,
      words: named.words || (line && line !== 'working' ? t(BUILD_LINE_WORDS[line]) : t(SETUP_SET_UP)),
      note: named.note || t(SETUP_SET_UP),
      busy: !!line && !buildLineAsks(line) && !buildLineDone(line) && !buildLineStopped(line),
      asks: !!line && buildLineAsks(line),
      finished,
    };

  // Newcomer run five (13 Oct 2026): when this screen first showed each
  // thing, for the run report (./made-moments.ts). Each once per project on
  // this page, however often a read draws it again.
  useEffect(() => {
    noteMoment(made.slug, 'made_shown', { entry: fromCreate ? 'create' : 'first_session' }, { once: true });
  }, [made.slug, fromCreate]);
  const planningShown = line === 'planning';
  useEffect(() => {
    if (planningShown) noteMoment(made.slug, 'planning_shown', {}, { once: true });
  }, [made.slug, planningShown]);
  const questionsShown = asked && !stalled ? asked.length : 0;
  const [askedHere, setAskedHere] = useState(false);
  useEffect(() => {
    if (!questionsShown) return;
    setAskedHere(true);
    noteMoment(made.slug, 'questions_shown', { count: questionsShown }, { once: true });
  }, [made.slug, questionsShown]);
  // The invite line and its buttons: as the screen opens, and again once
  // the questions that took their place are answered.
  const inviteShown = !questionsShown;
  useEffect(() => {
    if (inviteShown) noteMoment(made.slug, 'invite_shown', askedHere ? { how: 'after_questions' } : {}, { once: true });
  }, [made.slug, inviteShown, askedHere]);
  // Share invite (Share again once the link is out) opened the sheet, and
  // the link went out from it. Invite people later and the way on are told
  // where they are handled (./index.tsx), Submit in submitAnswers.
  const sentRef = useRef(sent);
  sentRef.current = sent;
  useEffect(() => {
    if (inviting) noteMoment(made.slug, 'share_invite_tapped', sentRef.current ? { how: 'again' } : {});
  }, [made.slug, inviting]);
  useEffect(() => {
    if (sentHow) noteMoment(made.slug, 'invite_sent', { how: sentHow });
  }, [made.slug, sentHow]);
  return (
    <div
      ref={rootRef}
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
            and the line over the buttons (canvas C3-started, C5-shared);
            at the top while it checks or asks (IN ONE PLACE). */}
        <div data-first-session-made-body="" className={madeBodyClass(screen)}>
          <div className="flex flex-col items-center gap-2.5 text-center">
            <PeopleRow people={peopleOf(community, me)} />
            <h1 id="first-session-made-title" className="text-[15px] font-normal leading-5 text-zinc-600 dark:text-zinc-400">{t(COMMUNITY_LABEL)}</h1>
          </div>
          {card ? (
            <SketchCard made={made} sketch={sketch} line={ownLine ? line : null} note={note} lineWords={named.words} lineNote={named.note} band={appScreen} bandClassName={APP_BAND} bandCorner={viewSwitch} />
          ) : (
            <PlainCard made={made} tile={tile} emoji={sketch.card?.emoji || made.emoji || null} band={appScreen} corner={viewSwitch}>
              {/* While its setup's card or the first look card is up, that
                  card says where it is; while it checks or asks, nothing does. */}
              {rowHidden ? null : (
                <div data-first-session-build-row="" className="mt-4 flex h-5 max-w-full items-center gap-2 text-[14px] leading-5 text-zinc-600 dark:text-zinc-300">
                  {busy ? <span className="status-dot creating" aria-hidden="true" /> : null}
                  <span data-first-session-build="" className="min-w-0 truncate">{plainLine}</span>
                </div>
              )}
              {note ? <p className={rowHidden ? 'mt-3 text-[13px] text-zinc-500 dark:text-zinc-400' : 'mt-1 text-[13px] text-zinc-500 dark:text-zinc-400'}>{note}</p> : null}
            </PlainCard>
          )}
          {/* Under the project, never above it: the thumbnail stays where it is. */}
          {settingUp && setupCard ? <SetupProgress step={setupStep} slow={slow} waitedOut={waitedOut} /> : null}
          {ranInPlace && setupCard ? <SetupProgress step={setupStep} slow={slow} waitedOut={waitedOut} done={{ line: card ? t(SETUP_SET_UP) : plainLine, busy, finished }} /> : null}
          {firstLook ? <FirstLookCard src={lookShown} name={made.name} progress={lookProgress} onBroken={setBrokenLook} phone={!lookInCard} onOpen={() => onOpenChat(made.conversationId)} /> : null}
          {stalled ? (
            <SetupStoppedCard stalled={stalled} busy={retrying} onRetry={() => { void retry(); }} onSetSecrets={() => onSetSecrets?.()} />
          ) : null}
          {/* The first session asks for no answer here. From Create, its
              card is the way to the chat where the plan is answered. */}
          {plan && !stalled && fromCreate && !asked ? <PlanWaitsCard name={made.name} onOpenChat={() => onOpenChat(plan.conversationId ?? made.conversationId)} /> : null}
          {/* In a browser, while Homeroom bot builds it: get the app to hear
              when it is ready (the notification ask). In the Homeroom app
              the same moment is askForPingWhileBotBuilds's modal, and this
              draws nothing. */}
          {botBuilds && busy && !stalled && !asked && !checking ? <NotifyAsk moment="app_building" className="mt-4 w-full text-start" /> : null}
        </div>
        {/* QUICK QUESTIONS: in place of the invite line and its buttons
            until they are answered, right under the project while the body
            stands at the top (madeBodyClass), where the checking line was. */}
        {asked && !stalled ? (
          <QuickQuestions key={asked.map((q) => q.question).join('|')} name={made.name} questions={asked} busy={answering} error={answerError} onSubmit={(answers) => { void submitAnswers(answers); }} />
        ) : checking ? (
          // Run five: in place of the invite line and its buttons while the
          // plan may still have questions, so a tap cannot skip them.
          <CheckingLine />
        ) : (
        <>
        <p role="status" data-first-session-hint={sentHow || ''} className="text-center text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
          {sentHow ? sharedLine(sentHow) : t(INVITE_HINT)}
        </p>
        <div className="mt-[18px] flex flex-col gap-2.5">
          {/* The buttons keep their places once the link is out: Share again,
              grey, where Share invite was, and the way on, blue, where
              Invite people later was. The way on is off until the app runs
              (holdsContinue); sharing is not. */}
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
            <Button type="button" data-first-session-continue="" onClick={() => onContinue(false, stage)} layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="flex items-center justify-center disabled:opacity-60" disabled={holds}>
              {continueLabel(entry, true, made.name, stage !== null)}
            </Button>
          ) : (
            <button type="button" data-first-session-continue="" onClick={() => onContinue(true, stage)} disabled={holds} className={SECONDARY}>
              {continueLabel(entry, false, made.name)}
            </button>
          )}
        </div>
        </>
        )}
      </div>
      {/* On <body>, out of this screen's scroller (as Who says yes? and the
          make screen's More sheet are): inside it, on an iPhone, the sheet
          rode the scroller Safari keeps scrollable under its toolbar
          (app.css), and a drag on it moved the screen behind. A portal put
          after the screen stays live under its page lock (page-lock.ts). */}
      {inviting && typeof document !== 'undefined' ? createPortal(
        <InviteSheet
          made={sketch.card ? { ...made, emoji: sketch.card.emoji } : made}
          me={me}
          onClose={() => setInviting(false)}
          onSent={(how) => setSentHow(how)}
        />,
        document.body,
      ) : null}
    </div>
  );
}
