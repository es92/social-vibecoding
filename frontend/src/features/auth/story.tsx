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
// The small label over a headline, as the site sets "Currently in early testing".
const SITE_LABEL = 'text-[13px] leading-[18px] uppercase tracking-[0.04em] text-[color:var(--site-label)]';
// A link inside a sentence: ink, underlined (the site has no second accent).
const SITE_LINK = 'font-semibold text-[color:var(--site-ink)] underline decoration-1 underline-offset-[3px] un-touch-target';
// One of the three dots a window's strip carries.
const WINDOW_DOT = 'h-2 w-2 rounded-full border border-[color:var(--site-line)] md:h-2.5 md:w-2.5';

// The short story's headline. On a phone it leads the page, the welcome label
// being a wide screen's; under a greeted address (`welcomeEmail`) the label
// shows on a phone too, so the headline keeps its room above there as well.
const HERO_HEADLINE = `${SITE_SERIF} text-[28px] leading-[32px] tracking-[-0.01em] text-[color:var(--site-ink)] text-balance md:mt-2.5 md:text-[46px] md:leading-[50px]`;
const HERO_HEADLINE_AFTER = `mt-2 ${SITE_SERIF} text-[28px] leading-[32px] tracking-[-0.01em] text-[color:var(--site-ink)] text-balance md:text-[46px] md:leading-[50px]`;

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
   * the headline, one line that says what this place is like, how an app
   * here changes as three numbered points, and a closing line that points
   * at the apps below. No button: the 21 Oct 2026 review found two Sign ins,
   * then two Sign ups, on one screen read as a mistake, and the hero's own
   * button, put back for the waitlist weeks, went again on 13 Nov 2026 when
   * the bar's filled button took its words ("Join the waitlist" while new
   * accounts wait, landing.tsx). No examples (the real apps follow it) and,
   * on a phone, no picture and no lines under the points, so the first apps
   * are near the first screen; nothing to fit, so no steps.
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
    // the way Wikipedia says it of an encyclopedia. The headline, one line
    // that makes the comparison, then how an app here changes as three
    // numbered points (somebody makes a change, its community votes, the app
    // is the community's), each with its line from md, and a closing line
    // that points at the apps below.
    //
    // NO BUTTON OF ITS OWN: the bar's filled button is the one way to make an
    // account, and says "Join the waitlist" while new accounts wait
    // (landing.tsx). A second one under the headline asked before a visitor
    // had a reason to answer.
    //
    // BESIDE IT from md: the picture, "This month" (how many changes went
    // live across the public apps and how many people made them, once the
    // directory's read has brought them: `month`), and the door to the page
    // about private communities (../guest/guest-communities.tsx). A private
    // community is a different promise from the one this hero makes, so it
    // is a card of its own and not a fourth point.
    //
    // ON A PHONE the apps should start near the first screen: no "Welcome to
    // Homeroom" (the wordmark is directly above), the points' titles only,
    // the two figures as one line, and the closing line carries the door.
    const points = [
      { title: t('auth:guest.hero.change.title'), body: t('auth:guest.hero.change.body') },
      { title: t('auth:guest.hero.vote.title'), body: t('auth:guest.hero.vote.body') },
      { title: t('auth:guest.hero.owned.title'), body: t('auth:guest.hero.owned.body') },
    ];
    const figures = month ? [
      { id: 'auth:guest.hero.month.changes', count: month.changes },
      { id: 'auth:guest.hero.month.contributors', count: month.contributors },
    ] : [];
    return (
      <div ref={storyRef} data-landing-story="" data-landing-story-compact="" className="site-band [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-4 md:pt-6 md:pb-8">
        <div data-landing-story-window="" className="border border-[color:var(--site-line)] bg-[var(--site-panel)]">
          <div className="flex h-6 items-center gap-1.5 border-b border-[color:var(--site-line)] px-2.5 md:h-8 md:px-3" aria-hidden="true">
            <span className={`${WINDOW_DOT} bg-[#e8452e]`} />
            <span className={`${WINDOW_DOT} bg-[#f2a531]`} />
            <span className={`${WINDOW_DOT} bg-[#3cc23c]`} />
          </div>
          <div className="flex items-center gap-10 px-4 pt-4 pb-5 md:px-10 md:py-8">
            <div className="flex min-w-0 flex-1 flex-col items-start text-start">
              <div className={welcomeEmail ? SITE_LABEL : `${SITE_LABEL} hidden md:block`}>{t('auth:story.welcome')}</div>
              {welcomeEmail ? (
                <div data-landing-story-email="" className="mt-1 max-w-full text-[15px] leading-5 font-semibold text-[color:var(--site-muted)] [overflow-wrap:anywhere]">{welcomeEmail}</div>
              ) : null}
              <h1 className={welcomeEmail ? HERO_HEADLINE_AFTER : HERO_HEADLINE}>
                {t('auth:guest.hero.headline')}
              </h1>
              <p className="mt-2 text-[17px] leading-[23px] text-[color:var(--site-muted)] text-balance md:mt-3 md:text-xl md:leading-[27px]">{t('auth:guest.hero.sub')}</p>
              {month ? (
                <p data-landing-story-month="" className="mt-2.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[15px] leading-5 text-[color:var(--site-muted)] md:hidden">
                  <span>{t('auth:guest.hero.month.title')}</span>
                  {figures.map((f) => (
                    <span key={f.id}>
                      <RichMessage id={f.id} values={{ count: f.count, total: f.count.toLocaleString() }} components={[<strong className="font-semibold text-[color:var(--site-ink)]" />]} />
                    </span>
                  ))}
                </p>
              ) : null}
              <ol data-landing-story-points="" className="mt-4 flex flex-col gap-2.5 md:mt-6 md:gap-3.5">
                {points.map((p, i) => (
                  <li key={p.title} className="flex min-w-0 items-center gap-2.5 md:items-start md:gap-3.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sun)] text-sm font-semibold text-[color:var(--site-on-sun)]" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={`block ${SITE_SERIF} text-[17px] leading-[22px] text-[color:var(--site-ink)] md:text-[21px] md:leading-[27px]`}>{p.title}</span>
                      <span className="hidden text-[15px] leading-[21px] text-[color:var(--site-muted)] md:block">{p.body}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p data-landing-story-next="" className="mt-4 hidden text-[15px] leading-[21px] text-[color:var(--site-muted)] md:mt-6 md:block">{t('auth:guest.hero.start')}</p>
              <p data-landing-story-next="" className="mt-4 text-[15px] leading-[21px] text-[color:var(--site-muted)] md:hidden">
                <RichMessage id="auth:guest.hero.startShort" components={[<a href={COMMUNITIES_PATH} data-landing-story-private="" className={SITE_LINK} />]} />
              </p>
            </div>
            <div className="hidden w-[320px] shrink-0 flex-col items-center gap-3.5 md:flex">
              <img
                src="/brand/people.png"
                alt=""
                width={816}
                height={612}
                draggable={false}
                className="h-auto w-[190px] shrink-0"
              />
              {month ? (
                <div data-landing-story-month="" className="w-full border border-[color:var(--site-line)] bg-[var(--site-window)]">
                  <div className="flex h-7 items-center gap-2 border-b border-[color:var(--site-line)] bg-[var(--site-sun)] px-2.5 text-[13px] leading-[18px] font-semibold text-[color:var(--site-on-sun)]">
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#e8452e]" />
                      <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#f2a531]" />
                      <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#3cc23c]" />
                    </span>
                    {t('auth:guest.hero.month.title')}
                  </div>
                  <div className="grid grid-cols-2">
                    {figures.map((f, i) => (
                      <p key={f.id} className={i ? 'min-w-0 border-s border-[color:var(--site-line)] px-4 pt-2.5 pb-3 text-[13px] leading-[18px] text-[color:var(--site-muted)]' : 'min-w-0 px-4 pt-2.5 pb-3 text-[13px] leading-[18px] text-[color:var(--site-muted)]'}>
                        <RichMessage id={f.id} values={{ count: f.count, total: f.count.toLocaleString() }} components={[<strong className={`block ${SITE_SERIF} text-[34px] leading-[38px] tracking-[-0.02em] text-[color:var(--site-ink)]`} />]} />
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              <a href={COMMUNITIES_PATH} data-landing-story-private="" className="flex w-full items-center gap-2.5 rounded-xl border border-[color:var(--site-line)] bg-[var(--site-panel)] py-3 ps-4 pe-3 no-underline shadow-[0_2px_0_var(--site-line)]">
                <span className="min-w-0 flex-1">
                  <span className={`block ${SITE_SERIF} text-[19px] leading-6 text-[color:var(--site-ink)]`}>{t('auth:guest.hero.private.title')}</span>
                  <span className="mt-0.5 block text-[13px] leading-[18px] text-[color:var(--site-muted)]">{t('auth:guest.hero.private.body')}</span>
                </span>
                <ChevronRightIcon className="h-5 w-5 shrink-0 text-[color:var(--site-ink)]" />
              </a>
            </div>
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
