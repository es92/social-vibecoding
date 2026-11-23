/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it unless the
 * first session's switch is off, `story_landing` in the waitlist options).
 *
 * One centred group under the landing's logo bar: the picture, the small
 * caps "Welcome to Homeroom", one headline, the small caps "For example"
 * over the make screen's three examples (to show, not to press). At the
 * foot, one "Continue" button with "Sign in or join with your email." under
 * it (#5251, the navigation review of 15 October 2026: "Get started" beside
 * "Already have an account? Sign in" made people decide which they were, for
 * what is one form). The small pill that also said "We let new people in in
 * waves." (added by #5251) is gone at Evan's request of 17 October 2026,
 * #5376: nothing replaces it. On a
 * phone the foot sits at the foot of the screen and the story shrinks, a
 * step at a time, until it is on screen (`fitStyle`, below); on a wide
 * screen the foot follows the examples, so the button is not left far
 * below them.
 *
 * "Continue" opens the sign-in sheet over this screen. Its email code
 * decides which it is: an address that has an account is signed in, on any
 * device, and only a new one makes an account (routes/auth.js, otp/verify),
 * which is then asked what to make next (../first-session/make.tsx).
 *
 * A "You're in" mail's link for an account that is still new does not wait
 * here (Evan, 12 Oct 2026): the landing spends it as the page opens and
 * shows the full-page Welcome instead (./landing.tsx, ./welcome-page.tsx).
 * The story, greeting the link's address, is for an account already set up,
 * whose link only Get started spends, and for a link already used or
 * expired, whose Get started sends a code.
 */

// The three examples are the make screen's front three (Evan, 8 Oct 2026,
// #4354; examples.ts FRONT since 15 Oct): the same three here and there, the
// tier list drawn as one.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { Message, RichMessage } from '../../lib/i18n/react';
import { noteSignUpFrom } from './sign-up-from';
import { reducedMotion } from '../../lib/reduced-motion';
import { FRONT } from '../first-session/examples';
import { useMessages } from '../../lib/i18n/react';
import { TierChart } from '../first-session/tier-chart';

// The foot's links: Sign in inside the email line, and Look around first.
const STORY_LINK = 'font-semibold text-violet-700 dark:text-violet-400 hover:underline un-touch-target';

// Also the dead invite link's welcome (./invite-card.tsx DeadInvite).
export const SMALL_CAPS = 'text-[12px] leading-4 font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

// The page about private communities (../guest/guest-communities.tsx), which
// the short story's card and, on a phone, its closing line lead to. A path of
// its own so it can be sent to somebody as a link (src/middleware/auth.js
// isSpaDocumentPath lets a visitor with no account open it).
export const COMMUNITIES_PATH = '/communities';

// THE SHORT STORY IS DRAWN IN THE WEBSITE'S LOOK (13 Nov 2026): it is a
// visitor's next click after onhomeroom.com, so it is that site's sky band
// with a white window in it, serif headlines and sun on an ink outline.
// Every colour here is a variable of public/css/app.css's "THE WEBSITE'S LOOK
// ON THE SIGNED-OUT PAGES", which the dark shell moves; nothing below names a
// dark class of its own.
const SITE_SERIF = 'font-[family-name:var(--site-serif)] font-normal';
// The hero's own face (Drea's mock-up, 17 Nov 2026): a lighter, tighter serif
// than the section headings', at a sturdy optical size.
export const SITE_DISPLAY = "font-[family-name:var(--site-display)] font-normal [font-variation-settings:'opsz'_28]";
// The small label over a headline, as the site sets "Currently in early testing".
export const SITE_LABEL = 'text-[13px] leading-[18px] uppercase tracking-[0.04em] text-[color:var(--site-label)]';
// A link inside a sentence: ink, underlined (the site has no second accent).
const SITE_LINK = 'font-semibold text-[color:var(--site-ink)] underline decoration-1 underline-offset-[3px] un-touch-target';
// One of the three dots a window's strip carries.
const WINDOW_DOT = 'h-2 w-2 rounded-full border border-[color:var(--site-line)] md:h-2.5 md:w-2.5';

// The short story's two buttons: a sun pill on an ink outline, as the bar's
// button is, and its plain twin beside it.
const HERO_PILL = 'inline-flex min-h-11 items-center justify-center rounded-full whitespace-nowrap px-[18px] py-2 text-center font-[family-name:var(--site-display)] text-[16px] leading-[22px] font-medium no-underline shadow-[inset_0_0_0_1px_var(--site-line),0_2px_0_var(--site-line)] un-touch-target';
export const HERO_PRIMARY = `${HERO_PILL} bg-[var(--site-sun)] text-[color:var(--site-on-sun)]`;
export const HERO_SECONDARY = `${HERO_PILL} bg-[var(--site-panel)] text-[color:var(--site-ink)]`;

// "Explore apps" brings what follows the story (the communities, which start
// right under it) to the top of the screen, clear of the bar.
function exploreApps(event: { currentTarget: HTMLElement }): void {
  let next = event.currentTarget.closest('[data-landing-story]')?.nextElementSibling as HTMLElement | null;
  // A block that is put away (the search, while nothing is pinned) has no height: pass it.
  while (next && !next.offsetHeight) next = next.nextElementSibling as HTMLElement | null;
  if (!next) return;
  next.style.scrollMarginTop = '52px';
  const calm = reducedMotion();
  next.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
}

// The short story's headline. On a phone it leads the page, the welcome label
// being a wide screen's; under a greeted address (`welcomeEmail`) the label
// shows on a phone too, so the headline keeps its room above there as well.
const HERO_HEADLINE_TYPE = `${SITE_DISPLAY} text-[31px] leading-[35px] tracking-[-0.03em] text-[color:var(--site-ink)] md:text-[50px] md:leading-[54px] xl:text-[60px] xl:leading-[64px]`;
const HERO_HEADLINE = `${HERO_HEADLINE_TYPE} md:mt-4`;
const HERO_HEADLINE_AFTER = `mt-2 ${HERO_HEADLINE_TYPE}`;

// THE STORY SHRINKS TO FIT ITS SCREEN (Evan, 10 Oct 2026, iPhone Safari): on
// a phone shorter than the story, Get started fell below the fold, under
// Safari's toolbar, and a foot pinned over the examples looked wrong. So the
// story takes these steps, in the owner's order and each on top of the last,
// only as far as its screen needs: 1 the picture, 2 the spacing, 3 the
// headline, 4 two examples instead of three. A screen it already fits (a
// large phone, a desktop) sees step 0, the story as it was.
export const FIT_STEPS = 4;

export function fitStyle(fit: number) {
  return {
    picture: fit >= 1 ? 'w-[136px]' : 'w-[200px]',
    group: fit >= 2 ? 'py-2' : 'py-6',
    label: fit >= 2 ? 'mt-3' : 'mt-4',
    examples: fit >= 2 ? 'mt-[18px]' : 'mt-7',
    row: fit >= 2 ? 'py-2' : 'py-2.5',
    foot: fit >= 2 ? 'pt-4' : 'pt-6',
    headline: fit >= 3 ? 'text-[23px] leading-[28px]' : 'text-[28px] leading-[33px]',
    count: fit >= 4 ? 2 : FRONT.length,
  };
}

// Safari's toolbar comes and goes as a page scrolls (about 98px). A screen
// that changes height by less than this keeps its step; anything more, or a
// new width, starts again.
const TOOLBAR_SLACK = 120;

// WHERE THE SCREEN ENDS. The fit used to work it out from the box the page
// lays the story out in and the space that box keeps under the foot (its
// bottom air and, in iPhone Safari, a toolbar allowance from `100lvh -
// 100svh`). On an iPhone 13 mini in Safari 26 that box ends some 50px above
// the toolbar and the allowance comes to almost nothing, so the third
// example went with about 100px left empty over the toolbar (Evan, 10 Oct
// 2026, through #4691 and #4695). A fixed box is measured instead: Safari
// ends one just above its toolbar (where the sign-in sheet's dim and the
// make screen stopped on that phone), and elsewhere it is the screen less
// the home indicator. The probe is added for the moment it is read and
// taken away again.
export function screenFoot(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;bottom:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const foot = probe.getBoundingClientRect().bottom;
  probe.remove();
  return foot;
}

// The step after `fit`, or null once it fits: the story's foot ("Sign in"
// and the 12px under it), as it would sit on the page unscrolled, ends at or
// above the foot of the screen. Past the last step there is nothing more to
// take, and the page scrolls.
export function nextStep(fit: number, footBottom: number, screenBottom: number): number | null {
  if (footBottom <= screenBottom + 0.5 || fit >= FIT_STEPS) return null;
  return fit + 1;
}

export function Story({ primaryClass, welcomeEmail = null, onStart, onSignIn, compact = false, lookAround = false, month = null }: {
  primaryClass: string;
  /** The address a "You're in" mail's link names, greeted under the welcome. */
  welcomeEmail?: string | null;
  onStart: () => void;
  /** The foot line's "Sign in": the sheet in its Sign in mode. Continue's when absent. */
  onSignIn?: () => void;
  /**
   * THE SHORT STORY, over the guest Discover (features/guest/guest-discover.tsx):
   * the headline, two short lines that say what this place is like, and two
   * buttons: Explore apps, which brings the list under it to the top, and
   * the door to the page about private communities. Neither makes an
   * account: the 21 Oct 2026 review found two Sign ins, then two Sign ups, on
   * one screen read as a mistake, so that is the bar's filled button alone
   * ("Join the waitlist" while new accounts wait, landing.tsx). No examples
   * (the real apps follow it) and, on a phone, no pictures, so the first
   * apps are near the first screen; nothing to fit, so no steps.
   */
  compact?: boolean;
  /**
   * The short story's two figures, "This month": changes that went live
   * across the public apps in the last 30 days and the people who made them
   * (GET /api/public/apps `month`). Null until the directory is read, and
   * when it came without them; then nothing is drawn in their place.
   */
  month?: { changes: number; contributors: number } | null;
  /**
   * Inside the Homeroom app the full story is still the front door
   * (landing.tsx `storyFront`), and this adds "Look around first" under its
   * foot: a link in the Sign in line's blue, on a line of its own, to
   * Discover's public projects (#apps), for somebody who wants to see what
   * is here before making an account. It is part of the foot, so the fit
   * steps make room for it.
   */
  lookAround?: boolean;
}) {
  const t = useMessages('auth');
  const storyRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // One fit: the screen it was made for, and whether it has settled.
  const fitting = useRef<{ width: number; height: number; settled: boolean } | null>(null);
  const fittedFor = useRef<string | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  const [measure, setMeasure] = useState(0);
  // Measured before the browser paints, so the steps are never seen: the
  // next step while the foot ends below the foot of the screen. The first
  // render (the prerender's) is step 0.
  useLayoutEffect(() => {
    const story = storyRef.current;
    const foot = footRef.current;
    if (!story || !foot || !story.offsetHeight) return;
    if (compact) return;
    // The address arrives after the story is drawn, a line more to fit:
    // start again from full size.
    if (fittedFor.current !== welcomeEmail) {
      fittedFor.current = welcomeEmail;
      fitting.current = null;
      if (fit !== 0) { setFit(0); return; }
    }
    if (!fitting.current) fitting.current = { width: window.innerWidth, height: window.innerHeight, settled: false };
    const f = fitting.current;
    if (f.settled) return;
    // Where the foot would end with the page at its top: the document in a
    // phone browser, the landing's own scroller in the app.
    const scrolled = window.scrollY + (story.closest('#auth-landing-scroll')?.scrollTop || 0);
    const next = nextStep(fit, foot.getBoundingClientRect().bottom + scrolled, screenFoot());
    if (next === null) f.settled = true;
    else setFit(next);
  }, [fit, measure, welcomeEmail, compact]);
  // A new screen (a turned phone, a resized window) starts again from full
  // size. A story first laid out while its screen was hidden is measured
  // once it shows.
  useEffect(() => {
    const story = storyRef.current;
    if (!story || compact) return undefined;
    const onResize = () => {
      const f = fitting.current;
      if (!f) return;
      if (window.innerWidth === f.width && Math.abs(window.innerHeight - f.height) < TOOLBAR_SLACK) return;
      fitting.current = null;
      setFit(0);
      setMeasure((n) => n + 1);
    };
    window.addEventListener('resize', onResize);
    const shown = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (!fitting.current && story.offsetHeight) setMeasure((n) => n + 1); })
      : null;
    shown?.observe(story);
    // The first fit can run before the typeface has loaded, while the
    // fallback face sets the headline a line shorter: the fit settled a step
    // early and the foot ended below the screen once the face arrived. So it
    // fits again, from full size, when the fonts are in.
    let live = true;
    document.fonts?.ready.then(() => {
      if (!live || !fitting.current?.settled) return;
      fitting.current = null;
      setFit(0);
      setMeasure((n) => n + 1);
    });
    return () => {
      live = false;
      window.removeEventListener('resize', onResize);
      shown?.disconnect();
    };
  }, [compact]);
  const foot = (
    <>
      <a href="#signup" data-landing-story-start="" className={primaryClass} onClick={(e) => { e.preventDefault(); noteSignUpFrom('story'); onStart(); }}>
        {t('auth:story.continue')}
      </a>
      {/* Polish N10: the line read like a second way in but was plain
          text. Its "Sign in" is one now, the same sheet titled Sign in
          (landing.tsx's 'signin'), for somebody who has an account. */}
      <p data-landing-story-how="" className="mt-1 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400 text-balance">
        <RichMessage
          id="auth:story.email"
          components={[
            <a
              href="#login"
              data-landing-story-signin=""
              className={STORY_LINK}
              onClick={(e) => { e.preventDefault(); noteSignUpFrom('story_sign_in'); (onSignIn || onStart)(); }}
            />,
          ]}
        />
      </p>
      {lookAround ? (
        <p className="text-[15px] leading-5">
          <a href="#apps" data-landing-story-look="" className={STORY_LINK}>
            {t('auth:story.lookAround')}
          </a>
        </p>
      ) : null}
    </>
  );
  if (compact) {
    // On the page itself, as the story always was, and short. THE PITCH
    // (Evan, 13 Nov 2026): Homeroom is the app library anyone can edit, said
    // the way Wikipedia says it of an encyclopedia. The headline, then the
    // comparison as two lines, then two buttons. The three numbered points
    // and the closing line that were here (13 Nov) went on 17 Nov 2026: they
    // stood between a visitor and the apps, which say it better.
    //
    // TWO BUTTONS, NEITHER AN ACCOUNT: Explore apps scrolls to the list under
    // the hero, and the white one is the door to the page about private
    // communities (../guest/guest-communities.tsx), a different promise from
    // the one this hero makes. The bar's filled button is still the one way
    // to make an account (landing.tsx).
    //
    // THE PICTURES are for the eye only: the communities page beside the
    // words from lg, and from md the people on the window's bottom edge with
    // "This month" beside them (how many changes went live across the public
    // apps and how many people made them, once the directory's read has
    // brought them: `month`). From lg the yellow window laps over the white
    // one and the people over the page under the sky.
    //
    // ON A PHONE the apps should start near the first screen: no "Welcome to
    // Homeroom" (the wordmark is directly above), no pictures, and the two
    // figures as one line.
    const figures = month ? [
      { id: 'auth:guest.hero.month.changes', count: month.changes },
      { id: 'auth:guest.hero.month.contributors', count: month.contributors },
    ] : [];
    return (
      <div ref={storyRef} data-landing-story="" data-landing-story-compact="" className="site-band site-clouds [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-6 md:pt-5 md:pb-6 lg:pb-0">
        {/* DREA'S HERO (17 Nov 2026): one white window on the clouds, its
            words centred in the left part and a picture of the communities
            page on the right; the people sit on the window's bottom edge and
            "This month" is a yellow window on the sky beside them. */}
        <div data-landing-story-window="" className="border border-[color:var(--site-line)] bg-[var(--site-panel)] lg:grid lg:grid-cols-[minmax(0,9fr)_minmax(0,11fr)] lg:items-center">
          <div className="flex min-w-0 flex-col items-center px-4 pt-6 pb-6 text-center md:px-8 md:pt-10 md:pb-20 lg:ps-6 lg:pe-0 lg:pt-14 lg:pb-20">
            <div className={welcomeEmail ? SITE_LABEL : `${SITE_LABEL} hidden md:block`}>{t('auth:story.welcome')}</div>
            {welcomeEmail ? (
              <div data-landing-story-email="" className="mt-1 max-w-full text-[15px] leading-5 font-semibold text-[color:var(--site-muted)] [overflow-wrap:anywhere]">{welcomeEmail}</div>
            ) : null}
            <h1 className={welcomeEmail ? HERO_HEADLINE_AFTER : HERO_HEADLINE}>
              {t('auth:guest.hero.headline')}
            </h1>
            {/* Its two sentences are a line each, at every width. */}
            <p className="mt-3 text-[17px] leading-[24px] text-[color:var(--site-muted)] md:mt-4 md:text-[20px] md:leading-[28px]">
              <RichMessage id="auth:guest.hero.sub" components={[<span className="block" />, <span className="block" />]} />
            </p>
            {month ? (
              <p data-landing-story-month="" className="mt-2.5 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[15px] leading-5 text-[color:var(--site-muted)] md:hidden">
                <span>{t('auth:guest.hero.month.title')}</span>
                {figures.map((f) => (
                  <span key={f.id}>
                    <RichMessage id={f.id} values={{ count: f.count, total: f.count.toLocaleString() }} components={[<strong className="font-semibold text-[color:var(--site-ink)]" />]} />
                  </span>
                ))}
              </p>
            ) : null}
            <div data-landing-story-actions="" className="mt-5 flex flex-wrap justify-center gap-2.5 md:mt-6">
              <button type="button" data-landing-story-explore="" className={HERO_PRIMARY} onClick={exploreApps}>
                {t('auth:guest.hero.explore')}
              </button>
              <a href={COMMUNITIES_PATH} data-landing-story-private="" className={HERO_SECONDARY}>
                {t('auth:guest.hero.privateHow')}
              </a>
            </div>
          </div>
          <div className="hidden min-w-0 py-7 ps-6 pe-8 lg:block xl:pe-10" aria-hidden="true">
            <img
              src="/brand/landing-communities.webp"
              alt=""
              width={1060}
              height={656}
              draggable={false}
              className="mx-auto h-auto w-full max-w-[640px]"
            />
          </div>
        </div>
        {/* The yellow window laps over the white one, and the people over the
            page under the sky (from lg, where there is room for both). */}
        <div className="relative z-10 -mt-16 hidden grid-cols-[minmax(0,9fr)_minmax(0,11fr)] items-start md:grid lg:-mb-7">
          <div className="flex min-w-0 justify-center ps-4 lg:ps-6">
            <img
              src="/brand/landing-people.webp"
              alt=""
              width={619}
              height={434}
              draggable={false}
              className="h-auto w-[280px] max-w-full shrink-0 lg:w-[380px]"
            />
          </div>
          <div className="flex min-w-0 justify-center px-6 pt-20 lg:pt-10">
            {month ? (
              <div data-landing-story-month="" className="w-full max-w-[460px] border border-[color:var(--site-on-sun)] bg-[var(--site-sun)] text-[color:var(--site-on-sun)]">
                <div className="flex h-8 items-center gap-2.5 border-b border-[color:var(--site-on-sun)] px-3 text-[13px] leading-[18px] font-semibold uppercase tracking-[0.04em]">
                  <span className="flex gap-1.5" aria-hidden="true">
                    <span className="h-2.5 w-2.5 rounded-full border border-[color:var(--site-on-sun)] bg-[#e8452e]" />
                    <span className="h-2.5 w-2.5 rounded-full border border-[color:var(--site-on-sun)] bg-[#f2a531]" />
                    <span className="h-2.5 w-2.5 rounded-full border border-[color:var(--site-on-sun)] bg-[#3cc23c]" />
                  </span>
                  {t('auth:guest.hero.month.title')}
                </div>
                <div className="p-3">
                  <div className="grid grid-cols-2 border border-[color:var(--site-on-sun)] bg-[var(--site-sun-pale)] py-3.5">
                    {figures.map((f) => (
                      <p key={f.id} className="min-w-0 px-3 text-center text-[15px] leading-5 uppercase tracking-[0.02em]">
                        <RichMessage id={f.id} values={{ count: f.count, total: f.count.toLocaleString() }} components={[<strong className="mb-1 block text-[40px] leading-[44px] font-normal tracking-[-0.03em]" />]} />
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  const s = fitStyle(fit);
  return (
    <div ref={storyRef} data-landing-story="" className="px-4 flex grow flex-col text-center">
      {/* One group, centred in the room above the button: the picture, the
          label 16px under it, the headline 8px under that, and the examples
          28px lower (closer from step 2). Where even step 4 does not fit,
          the auto margins fall to zero and the page scrolls. From md the
          group and the foot are centred together instead (#5251). */}
      <div className={`my-auto md:mb-0 flex flex-col items-center ${s.group}`}>
        <img
          src="/brand/people.png"
          alt=""
          width={816}
          height={612}
          draggable={false}
          className={`mx-auto block h-auto ${s.picture} max-w-full`}
        />
        <div className={`${s.label} ${SMALL_CAPS}`}>{t('auth:story.welcome')}</div>
        {/* "Welcome to Homeroom" and the address, from a "You're in" mail's
            link (Evan, 10 Oct 2026). Its own line, as written: an address
            in small caps would read as shouting. */}
        {welcomeEmail ? (
          <div data-landing-story-email="" className="mt-1 max-w-full text-[15px] leading-5 font-semibold text-zinc-700 dark:text-zinc-300 [overflow-wrap:anywhere]">{welcomeEmail}</div>
        ) : null}
        <h1 className={`mt-2 ${s.headline} font-extrabold text-balance`}>
          {t('auth:story.headline')}
        </h1>
        <div className={`${s.examples} flex w-full max-w-sm md:max-w-lg flex-col gap-2 text-start`}>
          <div className={`px-1 ${SMALL_CAPS}`}>{t('auth:story.examples')}</div>
          <ul className="w-full overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
            {FRONT.slice(0, s.count).map((e) => (
              <li key={e.key} className={`flex items-center gap-3 px-3.5 ${s.row} [&+&]:shadow-[inset_0_1px_0_var(--app-sheet-line)]`}>
                <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{e.chart ? <TierChart /> : e.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-[650] text-zinc-900 dark:text-zinc-100"><Message id={e.title} /></span>
                  <span className="block text-[13px] text-zinc-500 dark:text-zinc-400"><Message id={e.line} /></span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div ref={footRef} className={`w-full max-w-sm md:max-w-lg mx-auto md:mb-auto flex flex-col gap-3 ${s.foot} pb-3`}>
        {foot}
      </div>
    </div>
  );
}
