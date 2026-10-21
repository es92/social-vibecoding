/**
 * `#auth-landing-screen` — the anonymous shell's entry point (#1080, step 2
 * chunk C, screen 1 of 6).
 *
 * Converted first because it carries `#landing-header`, the second authored
 * top bar in the codebase: `tests/header-height-parity.test.js` pins it to the
 * same HEADER HEIGHT INVARIANT as `#platform-header` (52px + safe area at
 * every width). The markup below is therefore
 * a like-for-like transcription — same ids, same class strings in the same
 * order, same `hidden` semantics, same `data-*` attributes.
 *
 * ── What is React-owned and what is not ────────────────────────────────
 *
 * The header and the body are ordinary state: React renders the back
 * button's `hidden`, the title-vs-wordmark swap, and the anonymous-vs-waiting
 * -room swap of the action area.
 *
 * Three elements deliberately keep a CONSTANT `className` and are toggled
 * through `classList` instead:
 *
 *   * `#auth-landing-screen` — the router swaps screens inside the kit's view
 *     transition, which needs the class write to land synchronously with the
 *     publish (see `useVisibilityHiddenClass`);
 *   * `#auth-landing-scroll` — the kit's pull-to-refresh attaches to it and
 *     translates it, and the open/close zoom hides it inside the transition
 *     callback for the same reason;
 *   * `#app-viewer` and its `<iframe>` — `AppView.mountViewerCover()` appends
 *     `#app-viewer-cover` INTO the viewer and the teardown REPLACES the frame
 *     element (#1028), both of which are writes into this subtree from
 *     `public/js/**`. It is rendered once, by a memo with no props, and React
 *     never reconciles it again; the handlers below re-resolve it by id, which
 *     is what the legacy module did for exactly the same reason.
 */

import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { alertVariants } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { ChevronLeftIcon, LockIcon, SpinnerArcIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';
import { cn } from '@/lib/utils';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { Message, RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { FRAME_THEME_PARAM } from '../app-frame/app-frame-policy.js';
import {
  AUTH_SCREEN_IDS,
  byId,
  firstSessionNext,
  fx,
  hasSession,
  hiddenLast,
  isNative,
  keepReleaseLink,
  legacy,
  noteSignInBegun,
  type PublicApp,
  type ReleaseLink,
  takeReleaseLink,
  takeStartSheet,
  useAuthScreensPatch,
  zoomFx,
} from './shared';
import { DeepLinkBackdrop, type DeepLinkPlace, deepLinkPlace, deepLinkReturnTo, deepLinkTitle } from './deep-link-sign-in';
import { DeadInvite, InviteJoinBar, InvitePending, inviteTokenFrom, MadeForYou, onInviteLink, useInvitePreview } from './invite-card';
import { type ReleaseAccount, releaseAccountFromToken } from './login';
import {
  type AccountStep,
  type ReleaseSpend,
  SignInSheet,
  type SignInProvider,
  type SignInResume,
  SignUpButtons,
  type SignUpMethod,
  signUpMethods,
  spendReleaseLink,
} from './sign-in-sheet';
import { Story } from './story';
import { GuestDiscover } from '../guest/guest-discover';
import { type GuestIntent, GuestProject } from '../guest/guest-project';
import { type GuestApp, projectHash } from '../guest/guest-data';
import { useWaitlistOptions, type WaitlistOptions, waitlistOptions } from './waitlist-shared';
import { WelcomePage } from './welcome-page';

const LANDING_TITLE = 'Homeroom';

/**
 * Apple and Google, as the sign-in sheet offers them: those the options say
 * an admin set up, Apple first, and none inside the Homeroom app, whose web
 * view the providers' own pages refuse to sign in from.
 */
export function signInProvidersFrom(options: WaitlistOptions | null): SignInProvider[] {
  const list = Array.isArray(options?.sign_in_providers) ? options!.sign_in_providers! : [];
  // Nothing listed is also the prerender's answer, where there is no window
  // to ask whether this is the app.
  if (!list.length || typeof window === 'undefined' || isNative()) return [];
  return (['apple', 'google'] as const).filter((p) => list.includes(p));
}

// The capability an app build advertises for each provider's own sheet
// (NATIVE-BRIDGE.md, Native sign-in).
const NATIVE_SIGN_IN_CAPABILITY: Record<SignInProvider, string> = {
  apple: 'signInWithApple',
  google: 'signInWithGoogle',
};

/**
 * Inside the Homeroom app: those the server lists for the app's own sheets
 * (an admin saved the app's client IDs) and this build of the app can show.
 */
export function nativeSignInProvidersFrom(options: WaitlistOptions | null, capabilities: readonly unknown[]): SignInProvider[] {
  const list = Array.isArray(options?.native_sign_in_providers) ? options!.native_sign_in_providers! : [];
  return (['apple', 'google'] as const)
    .filter((p) => list.includes(p) && capabilities.includes(NATIVE_SIGN_IN_CAPABILITY[p]));
}

/** nativeSignInProvidersFrom, with this build's capabilities read once the page is up; none outside the app. */
export function useNativeSignInProviders(options: WaitlistOptions | null): SignInProvider[] {
  const [capabilities, setCapabilities] = useState<readonly unknown[]>([]);
  useEffect(() => {
    if (!isNative()) return undefined;
    let live = true;
    const read = legacy().usernode?.getBridgeInfo;
    if (typeof read === 'function') {
      read().then((info) => {
        if (live && Array.isArray(info?.capabilities)) setCapabilities(info!.capabilities as unknown[]);
      }).catch(() => {});
    }
    return () => { live = false; };
  }, []);
  return useMemo(() => nativeSignInProvidersFrom(options, capabilities), [options, capabilities]);
}

// The way back from a provider (routes/sign-in-providers.js) leaves its
// outcome in a short-lived cookie the page can read, never in the URL. Read
// once and cleared, so a reload does not reopen the sheet.
const PROVIDER_RESULT_COOKIE = 'hr_oauth_result';
const PROVIDER_RESULT_RE = /^(username|error-[a-z_]{1,40})$/;

export function takeProviderResult(): SignInResume | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${PROVIDER_RESULT_COOKIE}=([^;]*)`));
  if (!match) return null;
  document.cookie = `${PROVIDER_RESULT_COOKIE}=; Max-Age=0; path=/`;
  let value = '';
  try { value = decodeURIComponent(match[1]); } catch { return null; }
  return PROVIDER_RESULT_RE.test(value) ? (value as SignInResume) : null;
}

/**
 * The offline explanation's box (#2443) — the Alert primitive's `notice`
 * variant, spread rather than rendered as `<Alert>` so that `.offline-only`
 * stays at the FRONT of the class attribute: the prerendered markup is probed
 * for the literal `class="offline-only` (tests/offline-session-boot.test.js,
 * tests/pwa-shell-wiring.test.js) and the component appends `className` after
 * its variants. Spelled as a module constant for the same reason login.tsx
 * does; see the longer note there.
 */
// `mx-4` is this screen's gutter, which the block needs now that it sits
// inside the scroller's own unpadded wrapper rather than a padded column.
const OFFLINE_NOTICE = `offline-only mx-4 mb-8 ${alertVariants({ variant: 'notice', density: 'roomy' })}`;

/**
 * The landing tile for `slug` — always null now, and kept for two reasons.
 *
 * The signed-out landing used to end in a grid of every public app, and this
 * resolved the tile a launch zoomed out of. The grid is gone: a stranger's
 * first screen is one message and two pills, and 36 of the 41 tiles were
 * locked and captioned "Account required" anyway.
 *
 * What remains true is that `_landingTileFor` is one of the nine names the
 * legacy router patches over (public/js/auth-screens.js), so the seam has to
 * keep answering; and the kit's zoom takes `fromEl` as a THUNK that is allowed
 * to answer null, falling back to the transition each call site declares
 * ('push' on open, 'none' on close). Both callers pass `() => null` outright
 * rather than routing through here, so this says the same thing in one place
 * for the router.
 */
function landingTileFor(_slug: string | undefined): HTMLElement | null {
  return null;
}

/**
 * The marketing site's waitlist page, as `GET /api/public/waitlist/options`
 * reports it (`waitlist_url`, src/routes/public-api.js).
 *
 * NO HOST IS WRITTEN DOWN HERE. The URL is the platform's own configuration
 * (MARKETING_BASE_URL, src/services/marketing-links.js), so a literal in this
 * file would be a second copy of it that is silently wrong on every
 * deployment that is not production.
 *
 * Until the options land — the first paint, and forever if the request fails
 * — this answers null, and the pill is HIDDEN for as long as that lasts (see
 * `#landing-waitlist-link` below). The two alternatives are both worse: a
 * visible pill with no `href` is an enabled-looking control that silently does
 * nothing, and a fallback href would have to be either the marketing host —
 * which this file must not write down — or the in-app `#waitlist` form, the
 * one destination this screen deliberately stops sending people to.
 *
 * The field is read off the typed payload rather than re-narrowed here, so
 * `waitlist_url` is spelled once on each side of the wire; the `typeof` guard
 * is about the RUNTIME value (unvalidated JSON from the server), not the type.
 */
function marketingWaitlistUrl(options: WaitlistOptions | null): string | null {
  const url = options?.waitlist_url;
  return typeof url === 'string' && url ? url : null;
}

/**
 * The marketing site's front door, read the same way and for the same
 * reasons: `marketing_url` off the typed payload, a runtime `typeof` guard
 * because the JSON is unvalidated, and null until the fetch lands rather than
 * a host written down in this file.
 *
 * This screen says what Homeroom is in one sentence. Somebody deciding
 * whether to hand over an email address wants more than that, and everything
 * written to answer them already exists on the marketing site — so the answer
 * is a way OUT to it, not a second paragraph here.
 */
function marketingSiteUrl(options: WaitlistOptions | null): string | null {
  const url = options?.marketing_url;
  return typeof url === 'string' && url ? url : null;
}

/**
 * #1028: teardown REPLACES the `<iframe>` element instead of pointing the live
 * one at about:blank. Assigning `src` to a frame that already holds a real
 * document is a genuine navigation, so it pushed an entry onto the history
 * stack this shell shares with the app — which is what desynced the viewer's
 * own marker entry and left `history.back()` rewinding the iframe instead of
 * closing the viewer (the reported "empty page"). A fresh, never-navigated
 * frame makes every open the INITIAL about:blank navigation, which browsers
 * elide. It also kills the app's JS context outright, which is a stricter stop
 * than blanking.
 *
 * Callers must re-resolve the frame by id afterwards — any reference captured
 * before the swap is stale.
 */
function swapViewerFrame(): HTMLIFrameElement | null {
  const old = byId<HTMLIFrameElement>('app-viewer-frame');
  if (!old || !old.parentNode) return null;
  const fresh = document.createElement('iframe');
  fresh.id = old.id;
  fresh.className = old.className;
  for (const attr of ['title', 'allow', 'sandbox', 'referrerpolicy', 'allowfullscreen']) {
    const value = old.getAttribute(attr);
    if (value !== null) fresh.setAttribute(attr, value);
  }
  old.parentNode.replaceChild(fresh, old);
  // The new contentWindow has never received the shell's safe-area insets, and
  // the broadcast memo suppresses a repeat post of unchanged values — drop the
  // memo so the next one reaches it.
  const appView = legacy().AppView;
  if (appView && typeof appView.forgetSafeAreaFrame === 'function') {
    appView.forgetSafeAreaFrame('app-viewer-frame');
    appView.scheduleSafeAreaBroadcast?.();
  }
  return fresh;
}

/**
 * In-page app viewer: public apps open in an iframe here instead of a
 * `target=_blank` (which strands mobile webview users on the app subdomain
 * with no way back). It is an IN-FLOW sibling of the scroller — not a fixed
 * overlay — so the header above stays put and owns Back + the app name.
 * Opening zooms it out of the tapped tile (kit 'zoom-in', mirroring
 * App.navigateToApp); the background must stay opaque because the kit pins
 * this LIVE element as a fixed overlay for the duration of the zoom.
 *
 * `memo` with no props: this subtree renders once and React never touches it
 * again. See the file header.
 */
const ViewerRegion = memo(function ViewerRegion() {
  // Read once, not subscribed: this subtree must never re-render (above), so
  // the frame's title stays in the language the screen first mounted in.
  return (
    <div id="app-viewer" className="hidden flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950">
      {/*
          `allow` is the UNGATED BASE and nothing else (#2219). It used to be
          "geolocation", delegated to every public app a visitor opened here.
          A gated capability needs a per-user grant, and this viewer serves
          signed-out visitors, so there is nobody to hold one — see
          ../app-frame/app-frame-policy.js, and BASE_ALLOW there for why
          `pointer-lock` is not written (QA 2026-09-24 Q35): this frame has
          no sandbox, so pointer lock was never restricted in the first place.
      */}
      <iframe
        id="app-viewer-frame"
        className="flex-1 w-full border-0"
        title={translate('auth:landing.viewerTitle')}
        allow="clipboard-write"
      ></iframe>
    </div>
  );
});

/**
 * The lock on an account-required tile. Its own component so the tooltip is
 * read in the language on screen while LandingTile stays a plain function of
 * its props (tests/app-card-keyboard-open.test.js calls it as one).
 */
function AccountRequiredBadge() {
  const t = useMessages('auth');
  return (
    <span
      className="absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300"
      title={t('auth:landing.tile.accountRequired')}
    >
      <LockIcon className="w-3.5 h-3.5" aria-hidden="true" />
    </span>
  );
}

/**
 * One launcher tile, mirroring the authed homescreen's renderAppCard shape
 * (home.js): centered 14x14 icon tile (image > emoji > first letter), then the
 * name row.
 *
 * Account-required apps (requires_login — anything the shell probe didn't
 * positively classify as public) render dimmed with a lock badge only while
 * signed out. A signed-out tap remembers the app deep link and routes to
 * #signup; a waiting-room session already has the account these apps require,
 * so the same tile opens normally with an app-scoped identity token.
 */
export function LandingTile({
  app,
  onOpen,
  signedIn = false,
}: {
  app: PublicApp;
  onOpen: (app: PublicApp) => void;
  signedIn?: boolean;
}) {
  // Only an explicit public verdict unlocks a tile. Missing/stale client
  // metadata must not turn an unknown app into an anonymous launch (#1522).
  // A real session is the other valid unlock: /api/iframe-token deliberately
  // accepts waiting-room accounts even though the wider platform gate does
  // not (#1895).
  const gated = app.requires_login !== false && !signedIn;
  const label = app.name || app.slug;
  return (
    <div
      className={
        'app-card relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 cursor-pointer' +
        // `grayscale` alone, where this was `opacity-50 grayscale`. Opacity
        // composites toward whatever is behind, so it fades on the light page
        // and muddies on the dark one; draining the colour reads the same on
        // both. Same correction as the authed launcher's unlaunchable tiles.
        (gated ? ' grayscale-[0.75]' : '')
      }
      data-slug={app.slug || ''}
      data-gated={gated ? 'true' : 'false'}
      // A card that opens something IS a button (#1918, #2988): in the tab
      // order, named by the app it opens, and Enter/Space open it exactly as
      // a tap does. The tile holds no controls of its own today, but a key
      // that bubbled up from inside it is still not a press on the card.
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onOpen(app)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(app);
        }
      }}
    >
      <div className="relative w-14 h-14 shrink-0">
        {app.icon_url ? (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="image"
          >
            <img
              src={app.icon_url}
              alt=""
              loading="lazy"
              draggable={false}
              className="w-full h-full rounded-xl object-cover"
            />
          </div>
        ) : app.icon_emoji ? (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="emoji"
          >
            <span className="text-3xl leading-none" aria-hidden="true">
              {app.icon_emoji}
            </span>
          </div>
        ) : (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="letter"
          >
            {(app.name || '?').charAt(0).toUpperCase()}
          </div>
        )}
        {gated ? (
          <AccountRequiredBadge />
        ) : null}
      </div>
      {/*
          Name row. This is deliberately the SAME launcher tile the authed home
          screen renders, so it lost the active-users badge with it — an icon
          and a label, nothing else. The count still shows in the Browse-all
          directory, which is a ranked list where it is the point. The label is
          .app-card-title (app.css) — iOS-sized 11px/13px type clamped to two
          lines in a fixed-height lane, same as the authed grid (#951), so both
          launchers show the same amount of a name.
      */}
      <div className="w-full min-w-0">
        <div className="app-card-title" title={label || ''}>
          {label}
        </div>
        {gated ? (
          <p className="app-card-status text-zinc-500 dark:text-zinc-500"><Message id="auth:landing.tile.accountRequired" /></p>
        ) : null}
      </div>
    </div>
  );
}

// The landing bar's back disc: the same periwinkle disc as the signed-in
// bar's back button (BACK_BTN_CLASS in header/platform-header.tsx). The
// landing sits on the same wallpaper now, so its one glyph control is drawn
// the same way.
//
// `un-touch-target` is the last token for the same reason it is on the
// signed-in bar: the disc is DRAWN at 28px so the header's content row stays
// 28px, and the kit's ::after (public/usernode-native/v1/native.css) grows
// only the HIT BOX to max(100%, 44px). Without it this control was 28px to
// the finger as well as to the eye — the one live control on this screen that
// missed the 44px floor, and the landing bar's copy of the class had simply
// been dropped when it was transcribed from platform-header.tsx.
const LANDING_BACK_CLASS = 'inline-flex items-center justify-center w-7 h-7 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

/**
 * The screen's primary pill, as the shell already spells it: the 48px filled
 * accent pill every auth screen's main action uses (`SOLID` in login.tsx is
 * the same four variants). It is `buttonVariants(...)` rather than `<Button>`
 * because both pills here are ANCHORS — `<Button>` renders a `<button>`, and
 * the marketing pill needs a real `href` for the shell's delegated
 * `a[target="_blank"]` handler (public/js/nav-link.js) to hand it to the
 * bridge at all. Same recipe-on-an-anchor shape profile-view.tsx uses.
 *
 * `flex items-center justify-center` is what an anchor needs and a button
 * gets from the browser; `w-full` comes from `layout: 'full'`.
 */
const PRIMARY_PILL = cn(
  buttonVariants({
    layout: 'full',
    variant: 'pillAccent',
    size: 'pillLg',
    ink: 'solidLate',
  }),
  // Weight 650 for the main buttons on the story and its sheets (the C1
  // boards), where pillLg's own is 600.
  'flex items-center justify-center font-[650]',
);

/**
 * The secondary pill, transcribed from `PILL_LINK` in login.tsx — the white
 * 44px pill that screen already draws under its primary button. Copied rather
 * than imported: that constant is private to the sign-in screen and the two
 * screens are free to diverge, but on the shared wallpaper they must read as
 * one language, so the string is the same one.
 *
 * White, not the `pillNeutral` recipe's zinc-100: on this ground a fill is
 * how a control says it is a surface, and zinc-100 (#eaeaea) against the
 * cream wallpaper is almost no step at all.
 */
const SECONDARY_PILL = 'flex h-11 w-full items-center justify-center rounded-full bg-white'
  + ' text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900'
  + ' dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors';

/**
 * One chip in the rail below the illustration, transcribed from the brand
 * frame (Figma 1246:281, board 1's chip row) rather than derived from
 * anything in the shell.
 *
 * A `<span>`, not `@/components/ui/chip`'s `Chip`: that component is a
 * `<button aria-pressed>` — a filter toggle — and four permanently unpressed
 * toggles on a screen where nothing is filterable is a defect, not a
 * shortcut. Its own header makes the argument: sharing the LOOK is not a
 * reason to share the SEMANTICS. The RAIL is a plain div, so that one IS
 * imported.
 *
 * It used to be NEAR that primitive's resting look — a white pill, `rounded-
 * full`, centred 15px label, `shadow-sm`. The frame draws something else and
 * this is now that: a SQUARE card (no radius at all — the corners are the
 * chip's whole character on this page of round pills), a 1px near-black
 * hairline, a hard 2px/2px offset shadow, and a 34px gradient block flush
 * into its left edge, which is why the padding is `0 12px 0 0` and there is
 * no vertical padding to speak of: at `h-9` (36px) minus the two hairlines
 * the content box is exactly the block's 34px.
 *
 * Board values, literally: height 36, gap 8, padding-right 12, border
 * `1px solid #0b0b0c`, background `#ffffff`, shadow
 * `2px 2px 4px rgba(161,152,152,0.25)`, label 15px at `rgba(0,0,0,0.8)` and
 * no weight of its own (the old `font-medium` went with the pill). The
 * border spells `border-zinc-950` rather than `border-[#0b0b0c]` because
 * that token IS #0b0b0c in tailwind.config.js — an arbitrary value is for a
 * colour the palette cannot name, and this one it can.
 *
 * Still NO `hover:` and no `transition-colors`: these are static spans, and
 * a hover state on something that does nothing is a lie about what it is.
 *
 * ── DARK ─────────────────────────────────────────────────────────────
 *
 * The frame is a light-mode drawing and does not answer this, so the dark
 * twin is derived the same way the wallpaper's is (app.css, "DARK MODE IS
 * THE SAME WALLPAPER ON THE INVERTED GROUND"): keep the GRAPHIC character,
 * move the values onto the inverted ground.
 *
 * Shipping the frame's chip as drawn would put four white cards with black
 * hairlines on #0b0d1b — the loudest thing on the screen by a wide margin,
 * louder than the heading, and this rail is a caption. So the card takes the
 * surface every other dark card on this wallpaper takes (`zinc-900`,
 * #1c1c1e, which app.css measures as the step above the #0b0d1b ground), the
 * hairline inverts to a mid neutral that still reads as a DRAWN edge rather
 * than a fade, and the label takes the ordinary dark primary ink. The shadow
 * keeps its exact offset and blur and turns black: a warm grey cast on a
 * near-black page is a glow, not a shadow, and black still separates the
 * card where the rail crosses the wallpaper's lavender and rose washes.
 * The gradient block is untouched in both themes — it is the one thing here
 * that carries the brand, and it reads on either ground.
 *
 * Complete literals throughout — the extractor is a regex over source text.
 */
const CHIP = 'mr-2 inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border'
  + ' border-zinc-950 bg-white pl-0 pr-3 shadow-[2px_2px_4px_rgba(161,152,152,0.25)]'
  + ' dark:border-zinc-600 dark:bg-zinc-900 dark:shadow-[2px_2px_4px_rgba(0,0,0,0.55)]';

/**
 * The gradient block, and the label beside it — the board's own two children.
 *
 * The block is a plain 34px square; the GRADIENT is the one value on this
 * screen that cannot be a sane class literal (seven colour stops at named
 * percentages, one per chip), so it rides in an inline `style` instead of
 * four `bg-[…]` arbitraries that would each be an unreadable 120-character
 * class with every space and comma escaped. That is the same call the
 * sign-in screen's back disc makes for its safe-area `top` (login.tsx): an
 * inline style is right for a value no complete class literal can carry,
 * and wrong for anything one could.
 */
const CHIP_DOT = 'h-[34px] w-[34px] shrink-0';
const CHIP_LABEL = 'text-[15px] text-[rgba(0,0,0,0.8)] dark:text-zinc-100';

/**
 * The rail's four lines: how this place works, in its own words — each with
 * the gradient of the chip it belongs to, so the copy and the colour cannot
 * drift apart the way two arrays indexed by position eventually do. The four
 * gradients are the frame's, in the frame's order: blue/violet, green,
 * pink/orange, yellow.
 *
 * The LINES are deliberately NOT four named people ("+Andrea just joined"),
 * which is how the brand frame writes them. Those read as a live feed of
 * things that just happened, and decision 4 settled that these are static
 * copy for now — so on a shipped screen they would be four invented events
 * attributed to four invented members, indistinguishable from the real
 * thing. A live feed is a later proposal with its own privacy decision;
 * until then the rail says what is true of the platform whoever is reading
 * it. Only the LOOK is transcribed.
 */
// `line` is a message id, read when the rail renders.
const CHIPS: readonly { line: string; dot: string }[] = [
  {
    line: 'auth:landing.chips.describe',
    dot: 'radial-gradient(circle closest-side, #6717fb 0%, #5a32fb 12.5%, #4e4dfc 25%,'
      + ' #3484fc 50%, #1bbafd 75%, #0fd5fd 87.5%, #02f0fd 100%)',
  },
  {
    line: 'auth:landing.chips.build',
    dot: 'radial-gradient(circle closest-side, #41b24a 0%, #66c459 25%, #8bd669 50%,'
      + ' #b0e878 75%, #d6fa87 100%)',
  },
  {
    line: 'auth:landing.chips.vote',
    dot: 'radial-gradient(circle closest-side, #fb179d 0%, #fc3776 25%, #fc5750 50%,'
      + ' #fd7629 75%, #fd8615 87.5%, #fd9602 100%)',
  },
  {
    line: 'auth:landing.chips.own',
    dot: 'radial-gradient(circle closest-side, #ffae2b 0%, #ffce4d 50%, #ffee6f 100%)',
  },
];

/**
 * The story's sheet, once a sign-in through it has a session and before the
 * shell takes over (its `beforeFinish`), and the full-page Welcome's the
 * same way (./welcome-page.tsx).
 *
 * A new account made from the story is asked what to make next
 * (../first-session/make.tsx), not which communities to join: the session's
 * flag says so to the island, and the start is recorded as the story's. So
 * is an account that already existed and has not answered that question
 * yet (one an admin made, say, through the password step, or one that saw
 * it, left without answering and is signing in again); the join step opens
 * its make screen in the same tick the shell starts
 * (./communities-first-run.js). Either way this answers true and the sheet
 * hands off to that screen, once the shell is ready to draw it (#4892), so
 * the two read as one movement. The start is recorded before the shell
 * starts, with the sheet still up, so the join step's own record comes
 * second. Recording the start answers nothing: the question is asked until
 * Make it or "Look around first". Anyone else goes where they always have,
 * with no hand-off.
 */
export async function startedFromStory(kind: 'existing' | 'new'): Promise<boolean> {
  if (kind !== 'new') return firstSessionNext();
  try { sessionStorage.setItem('usernode:first-session:make', '1'); } catch { /* the make screen is then skipped */ }
  await fetch('/api/me/first-session/started', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  return true;
}

/**
 * How long "Signing you in…" may stand. A spend answers in about a second;
 * one that has not after this gives way: as the page opens, to the story and
 * its Get started, with nothing more spent on load; under Get started, to
 * the sheet as it is ("Signing you in from your email…" and its ✕). A
 * stalled request never leaves a spinner with no way out.
 */
export const SIGNING_IN_MAX_MS = 20_000;

/**
 * A "You're in" link that may be spent as the page opens (Evan, 12 Oct
 * 2026): a new account's (`signup`), carrying both the token that names its
 * address, which the check reads, and its one-time sign-in. Its arrival puts
 * "Signing you in…" up at once, before anything is known, so the story is
 * never seen first and then taken away.
 */
export function straightLink(link: ReleaseLink | null | undefined): boolean {
  return !!link && link.route === 'signup' && !!link.token && !!link.signIn;
}

/**
 * Whether that link is spent now, before any tap. Only when the check, a GET
 * that spends nothing and makes no session (GET /api/public/waitlist/more/
 * :token, `new_account`), says its account is still new: none yet, or one
 * with no username and no password. An account already set up waits for Get
 * started, so a mail scanner or an app's own browser that runs this page
 * can never sign it in; so does a link whose check failed, and every link
 * while the story is switched off. The spend itself asks the server to hold
 * the same line (`newAccountOnly`, src/services/release-links.js).
 */
export function spendsOnLoad({ link, account, options }: {
  link: ReleaseLink | null | undefined;
  account: ReleaseAccount | null;
  options: WaitlistOptions | null;
}): boolean {
  return straightLink(link) && account?.newAccount === true && options?.story_landing !== false;
}

/**
 * Where that spend leads: the full-page Welcome for the account it opened;
 * `used`, the story, whose Get started sends a code because the link was
 * already used or has expired; or `story`, the story with the link still
 * unspent for Get started (the server's answer for an account set up in the
 * meantime, or no answer at all). Nothing here signs anybody in: a
 * `signed-in` answer, which `newAccountOnly` rules out, would be the story too.
 */
export function afterLoadSpend(spent: ReleaseSpend | 'refused' | null): AccountStep | 'used' | 'story' {
  if (spent === 'refused') return 'used';
  if (spent && spent.next === 'set-password') {
    return { email: spent.email, needsUsername: spent.needsUsername, suggestedUsername: spent.suggestedUsername };
  }
  return 'story';
}

/**
 * "SIGNING YOU IN…": while a "You're in" mail's one-time sign-in is checked
 * and spent, a plain screen over everything: the logotype, a spinner and the
 * one line, on the landing's own ground. As the page opens, for a new
 * account's link (`straightLink`); and while Get started spends it (the
 * sheet's `link` step, ./sign-in-sheet.tsx). The onboarding run of 12 Oct
 * 2026 saw the story, with the address under "Welcome to Homeroom", stay up
 * while the link signed in, and then the Welcome sheet over it. The address
 * is not said here: the Welcome page that follows says it.
 *
 * It takes the taps while it is up (the dim under it would close the sheet),
 * and it is up only for that moment: rendered nothing otherwise, so the
 * interior's first commit is unchanged.
 */
export function SigningIn() {
  const t = useMessages('auth');
  return (
    <div
      data-landing-signing-in=""
      role="status"
      className="fixed inset-0 z-[60] flex touch-none flex-col items-center justify-center px-4 text-center"
      style={{ background: 'var(--home-wallpaper)' }}
    >
      <Wordmark className="h-8 w-auto text-zinc-950 dark:text-white" />
      <SpinnerArcIcon className="mt-8 h-6 w-6 animate-spin motion-reduce:animate-none text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
      <p className="mt-3 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">{t('auth:landing.signingIn')}</p>
    </div>
  );
}

type Translate = (id: string, params?: Record<string, unknown>) => string;

/** The sign-in sheet's title for what a visitor tried to do on a project's page. */
export function intentTitle(intent: GuestIntent, t: Translate): string {
  const project = intent.app.name;
  switch (intent.kind) {
    case 'join': return t('auth:guest.sheet.join', { project });
    case 'vote': return t('auth:guest.sheet.vote');
    case 'ask': return t('auth:guest.sheet.ask');
    case 'chat': return t('auth:guest.sheet.chat', { project });
    default: return t('auth:guest.sheet.use', { project });
  }
}

export function LandingScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.landing, false);
  const t = useMessages('auth');
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.landing);

  // An invite link's preview (./invite-card.tsx), read in an effect like
  // everything else here. A LIVE link turns the screen into "Made for you":
  // its three cards take the place of the illustration, the rail and the
  // waitlist pitch, which are hidden rather than unmounted for the same
  // reason the session's two action blocks are (the id inventory reads them).
  // While the preview is on its way the pitch stays hidden too, with a quiet
  // placeholder where the cards go, so an invited friend never sees the
  // waitlist first; a dead link, or one whose preview cannot be read, gets
  // the pitch back once that is known.
  const { preview: invite, pending: invitePending } = useInvitePreview();
  const madeForYou = !!invite?.live;
  // A link that does not work, mistyped ones included, has its own page in
  // the pitch's place (DeadInvite, #5263).
  const deadInvite = !!invite && !invite.live;
  // Which sign-in sheet is up (./sign-in-sheet.tsx): an invite's Join, or
  // the story's Make an account or Sign in.
  const [sheet, setSheet] = useState<null | 'join' | 'start' | 'signin'>(null);
  // The way in the guest Discover's hero chose (SignUpButtons): the start
  // sheet opens at it. Null for the sheet's own first step.
  const [signUpWith, setSignUpWith] = useState<SignUpMethod | null>(null);
  // Back from Apple or Google: where the sheet picks up (./sign-in-sheet.tsx).
  const [resume, setResume] = useState<SignInResume | null>(null);
  // A waitlist "you're in" mail's link (AuthScreens.enter): this story with
  // the sheet already open, at the step the link asked for.
  const [release, setRelease] = useState<ReleaseLink | null>(null);
  // Closing the sheet keeps the link (Evan, 10 Oct 2026): Get started again
  // signs in from the email again, while the account it started is not set
  // up yet (src/services/release-links.js), rather than asking for a code.
  const closeSheet = useCallback(() => { setSheet(null); setResume(null); setSignUpWith(null); }, []);
  // A shared link opened while signed out (#5264, ./deep-link-sign-in.tsx):
  // the address it was for (remembered for after the sign-in by the router)
  // and the place it names. Set as the screen shows (landingOnShow), from
  // AuthScreens.showSignInFor; the sheet titled for that place stands over a
  // blurred stand-in for the page, in place of the story.
  //
  // THE GUEST PAGES TAKE MOST OF THESE NOW (features/guest). A link to
  // Discover (`#apps`) opens the guest Discover, and a link to a PUBLIC
  // project opens its read-only page, with no sheet at all: the sheet is for
  // the places a visitor with no account cannot read (Messages, a private
  // project). `deepLink` is the link as it came; `gate` (below) is what is
  // left of it for the sheet, once the public directory has said whether a
  // project is public.
  const [deepLink, setDeepLink] = useState<{ target: string; place: DeepLinkPlace } | null>(null);
  // Closed without signing in: the story, under an address that says so. The
  // link stays remembered, so a sign-in from the story still lands on it.
  const closeGate = useCallback(() => {
    setDeepLink(null);
    closeSheet();
    try {
      history.replaceState(history.state, '', legacy().App?._rootUrl?.('#landing') ?? '/#landing');
    } catch { /* the address stays the link's */ }
  }, [closeSheet]);
  // The address a new account's link names, for the story to greet (Evan,
  // 10 Oct 2026: "Welcome to Homeroom" and the email).
  const [releaseEmail, setReleaseEmail] = useState<string | null>(null);
  // A NEW ACCOUNT'S LINK, AS THE PAGE OPENS (Evan, 12 Oct 2026): no story
  // and no Get started, but "Signing you in…" at once (`holding`) while the
  // link is checked and spent, then the full-page Welcome (`welcome`,
  // ./welcome-page.tsx). A link that spend found already used, or expired,
  // gives the story back, and its Get started then sends a code rather than
  // spending the link again (`releaseUsed`).
  const [holding, setHolding] = useState(false);
  const [welcome, setWelcome] = useState<AccountStep | null>(null);
  const [releaseUsed, setReleaseUsed] = useState(false);
  // Bumped when "Signing you in…" gives way to the story (SIGNING_IN_MAX_MS):
  // an answer that lands after that changes nothing, and nothing more is
  // spent on load. Get started takes it from there.
  const straightRun = useRef(0);
  useEffect(() => {
    if (!holding) return undefined;
    const timer = window.setTimeout(() => { straightRun.current += 1; setHolding(false); }, SIGNING_IN_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  // The story's lookup of the address the link's token names, which also
  // says whether its account is still new (`new_account`). A GET: it spends
  // nothing and makes no session. A new account's link is then spent with
  // `newAccountOnly`, which the server answers only with the account step:
  // an account set up in the meantime is refused there, its link unspent and
  // no session made, and gets the story like any account already set up,
  // whose link only Get started spends (Evan, 10 Oct 2026: a link spent on
  // load was used up by whatever loaded it, an app's own browser before it
  // handed the link to Safari, or a mail scanner that runs the page).
  useEffect(() => {
    if (!release || release.route !== 'signup' || !release.token) return undefined;
    const link = release;
    const token = release.token;
    const run = straightRun.current;
    let live = true;
    void Promise.all([releaseAccountFromToken(token), straightLink(link) ? waitlistOptions() : null]).then(async ([account, options]) => {
      if (!live) return;
      setReleaseEmail(account?.email ?? null);
      if (run !== straightRun.current || !spendsOnLoad({ link, account, options })) {
        setHolding(false);
        return;
      }
      // From here the link is spent whatever the screen does, so its answer
      // lands, unless the story has taken over in the meantime.
      const next = afterLoadSpend(await spendReleaseLink(link.signIn!, { newAccountOnly: true }));
      if (run !== straightRun.current) return;
      if (next === 'used') setReleaseUsed(true);
      else if (next !== 'story') setWelcome(next);
      setHolding(false);
    });
    return () => { live = false; };
  }, [release]);
  // Where the sheet would show its own account step for such a link (after
  // Get started spent it, or after the code a used link sends): the same
  // full-page Welcome, in the sheet's place.
  const toWelcome = useCallback((account: AccountStep) => {
    setWelcome(account);
    setSheet(null);
    setResume(null);
  }, []);
  // The sheet spending that link's one-time sign-in (its `onSigningIn`):
  // "Signing you in…" over everything (SigningIn), for that moment. Every
  // way it ends takes the screen down with it: Welcome, the code a refused
  // or failed spend falls back to, an error, a closed sheet. Past
  // SIGNING_IN_MAX_MS it gives way to the sheet as it stands.
  const [signingIn, setSigningIn] = useState(false);
  const [signingInOverdue, setSigningInOverdue] = useState(false);
  useEffect(() => {
    setSigningInOverdue(false);
    if (!signingIn) return undefined;
    const timer = window.setTimeout(() => setSigningInOverdue(true), SIGNING_IN_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [signingIn]);

  // Both start at the value the prerendered markup shipped with: no session,
  // no app open. `_renderLandingHeader`'s equivalent (refreshHeader) runs on
  // show, i.e. after hydration.
  const [session, setSession] = useState(false);
  const [openApp, setOpenApp] = useState<{ slug: string; name: string } | null>(null);
  // The public directory (loadLandingApps), for the guest Discover and the
  // guest project pages: null until it has been read, and `appsFailed` when
  // it could not be.
  const [apps, setApps] = useState<GuestApp[] | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  // What a visitor tried to do on a project's page (Join, Vote, Ask, the
  // chat, an app that needs an account): the sign-in sheet titled for it.
  const [intent, setIntent] = useState<GuestIntent | null>(null);

  // The memoised options fetch, read for its `waitlist_url`. Null until it
  // resolves — an EFFECT, never the initial render, which is what keeps the
  // interior's first commit identical to the empty root the prerender ships
  // (a hydration mismatch is a console error, and a console error on any
  // route fails the proposal checks).
  const waitlistPayload = useWaitlistOptions();
  const waitlistUrl = marketingWaitlistUrl(waitlistPayload);
  const siteUrl = marketingSiteUrl(waitlistPayload);

  // THE STORY (./story.tsx), unless the first session's switch is off: what
  // Homeroom is and "Make an account", in place of the waitlist pitch, for a
  // visitor with no session who did not come by an invite link. It is the
  // default, so it is what this interior's first render draws, before the
  // options say otherwise: the interior mounts on reveal
  // (lib/mount-on-reveal.ts), so there is no prerendered pitch to match and
  // no reason to flash one. The invite path is read in that first render
  // too, for the same reason; the prerender pass has no location.
  const [onInvitePath, setOnInvitePath] = useState(
    () => typeof location !== 'undefined' && onInviteLink(location.pathname),
  );
  useEffect(() => { setOnInvitePath(onInviteLink(location.pathname)); }, []);

  // Non-render state, mirroring the legacy module's fields one for one.
  const st = useRef({
    appsLoaded: false,
    appsReady: null as Promise<void> | null,
    appsList: [] as PublicApp[],
    openSlug: null as string | null,
    // #931: launch-cover state for the in-page viewer. The generation counter
    // makes a superseded open's `load`/timers inert (same contract as
    // AppView._launchId); the timer array is the one the shared ladder pushes
    // its rungs into.
    launchId: 0,
    timers: [] as number[],
    unwindingViewerEntry: false,
    anonBackShotRan: false,
  }).current;

  /**
   * Single writer for `session`, which swaps the action area between the two
   * states this screen has left:
   *   anonymous            → the "Join the waitlist" / "Sign in" pills and the
   *                          "Already joined?" line
   *   waiting-room session → one "Your spot on the waitlist" pill instead, back to the
   *                          room that can tell them where they stand
   *
   * It does NOT decide the header label: that is `openApp`'s (the app's name
   * while the viewer runs, the wordmark otherwise), and a session change must
   * not disturb it. The NAME is the legacy router's (`_renderLandingHeader`),
   * which is why the viewer's open and close paths still call it — all it does
   * for them is re-read the session.
   */
  const refreshHeader = useCallback(() => {
    setSession(hasSession());
  }, []);
  const storyOn = waitlistPayload?.story_landing !== false && !onInvitePath && !session;
  const pitchHidden = madeForYou || deadInvite || storyOn || invitePending;
  // THE GUEST PAGES (features/guest), wherever the story would be: the guest
  // Discover under the story's short hero, or a public project's read-only
  // page when the address names one. The same switch as the story, so with
  // the story off the landing is the waitlist pitch it was.
  const guestOn = storyOn;
  const deepPlace = deepLink?.place ?? null;
  const linkedSlug = deepPlace?.kind === 'project' ? deepPlace.slug : null;
  const linkedApp = linkedSlug && apps ? apps.find((a) => a.slug === linkedSlug) ?? null : null;
  const guestProject = guestOn ? linkedApp : null;
  // Until the directory is read, a project link is neither public nor not,
  // so neither its page nor the sheet shows yet.
  const linkPending = guestOn && !!linkedSlug && apps === null && !appsFailed;
  const discoverLink = deepPlace?.kind === 'screen' && deepPlace.screen === 'discover';
  const gate = deepLink && !(guestOn && discoverLink) && !guestProject && !linkPending ? deepLink : null;
  // The project's name, when the link is for a public one.
  const gateProject = linkedApp?.name ? String(linkedApp.name) : null;
  // As the page opens for a new account's link, or over Get started's
  // sheet, the one that carries the link.
  const sheetSigningIn = signingIn && !signingInOverdue && storyOn && sheet === 'start';
  const signingInShown = holding || sheetSigningIn;
  const webProviders = useMemo(() => signInProvidersFrom(waitlistPayload), [waitlistPayload]);
  const nativeProviders = useNativeSignInProviders(waitlistPayload);
  const nativeSignIn = nativeProviders.length > 0;
  const providers = nativeSignIn ? nativeProviders : webProviders;
  // An invite makes a private member, who signs up with a phone number
  // (services/community-invites.js): the Join sheet starts there when the
  // server offers it.
  const phoneSignIn = waitlistPayload?.phone_sign_in === true;
  // The hero's ways to make an account: Apple, Google, a phone, email.
  const methods = useMemo(() => signUpMethods(providers, phoneSignIn), [providers, phoneSignIn]);
  const signUp = useCallback((method: SignUpMethod) => { setSignUpWith(method); setSheet('start'); }, []);
  // Back from a provider without a session: reopen the sheet the trip left,
  // the invite's Join on its link, the story's otherwise.
  useEffect(() => {
    const result = takeProviderResult();
    if (!result) return;
    // The result is read once, so a reload now would lose where this
    // sign-in had got to.
    noteSignInBegun();
    setResume(result);
    setSheet(inviteTokenFrom(location.pathname) ? 'join' : 'start');
  }, []);
  // The story switched off while a release link waited for it: no sheet to
  // open, so the link goes where it always went, the sign-in screen, which
  // takes the token from here (./login.tsx).
  // Nothing was spent on load for it (`spendsOnLoad`), and "Signing you in…"
  // goes with the story.
  useEffect(() => {
    if (!release || waitlistPayload?.story_landing !== false) return;
    if (release.token) keepReleaseLink(release);
    setRelease(null);
    setSheet(null);
    setHolding(false);
    location.hash = `#${release.route}`;
  }, [release, waitlistPayload]);

  const clearViewerCover = useCallback(() => {
    st.timers.forEach((t) => clearTimeout(t));
    // In place — the ladder captured this array (see AppView).
    st.timers.length = 0;
    const frame = byId<HTMLIFrameElement>('app-viewer-frame');
    if (frame) {
      frame.onload = null;
      frame.onerror = null;
      frame.style.opacity = '';
    }
    byId('app-viewer-cover')?.remove();
  }, [st]);

  /**
   * Instant, un-animated teardown of the in-page viewer. Used on the paths
   * that LEAVE the landing screen (Sign in, hash routing, the authed boot):
   * animating a zoom-out into a tile on a screen that's being replaced in the
   * same frame just fights the screen transition, and the live iframe must
   * stop either way — `#app-viewer` sits inside the z-40 landing overlay now,
   * so a later screen doesn't cover it.
   */
  const resetViewer = useCallback(() => {
    const viewer = byId('app-viewer');
    // Also cancels a token mint that has not revealed the viewer yet. Without
    // this, leaving #landing during that await can open the app behind the
    // next auth screen when the response finally arrives.
    st.launchId = (st.launchId || 0) + 1;
    clearViewerCover();
    if (!viewer || viewer.classList.contains('hidden')) return;
    st.openSlug = null;
    setOpenApp(null);
    viewer.classList.add('hidden');
    swapViewerFrame();
    byId('auth-landing-scroll')?.classList.remove('hidden');
    refreshHeader();
  }, [clearViewerCover, refreshHeader, st]);

  const openLandingApp = useCallback(
    async (app: PublicApp) => {
      const accountRequired = app.requires_login !== false;
      const signedIn = hasSession();
      // Guard the actual viewer entry, not only tile presentation: the legacy
      // bridge calls this opener too. An anonymous visitor still needs an
      // account; a waiting-room session already has one (#1895).
      if (accountRequired && !signedIn) {
        (legacy().AuthScreens?.rememberDeepLink as undefined | ((h: string) => void))?.(
          '/app/' + encodeURIComponent(app.slug || ''),
        );
        location.hash = '#signup';
        return;
      }
      if (!app.url) return;
      const slug = app.slug || '';
      const launchId = (st.launchId || 0) + 1;
      st.launchId = launchId;
      let launchUrl = app.url;

      // Public apps keep their anonymous URL. An account-required app is
      // loaded only after the platform has minted the app-scoped identity it
      // already permits for waitlist sessions. URL.searchParams.set both
      // preserves existing query/fragment state and replaces any stale token
      // rather than concatenating a second credential.
      if (accountRequired) {
        const token = await legacy().AppView?._mintToken?.(slug);
        if (launchId !== st.launchId) return;
        if (!token) {
          legacy().PlatformUI?.toast?.(
            translate('auth:landing.appSignInFailed'),
            { error: true },
          );
          return;
        }
        try {
          const url = new URL(app.url);
          url.searchParams.set('token', token);
          launchUrl = url.toString();
        } catch {
          legacy().PlatformUI?.toast?.(translate('auth:landing.appOpenFailed'), { error: true });
          return;
        }
      }

      // #3257: the platform's resolved theme, for the app's pre-paint read,
      // exactly as the signed-in app frame carries it
      // (AppView.buildAppIframeSrc). Without it an app that follows the
      // platform theme paints in the OS's look until the bridge's load-time
      // ask is answered. Public or not: it says nothing about who is looking.
      const theme = legacy().AppView?.resolvedTheme?.();
      if (theme) {
        try {
          const url = new URL(launchUrl);
          url.searchParams.set(FRAME_THEME_PARAM, theme);
          launchUrl = url.toString();
        } catch {
          // A URL the URL API cannot parse goes as it always did; the
          // bridge's ask still delivers the theme once the app loads.
        }
      }

      const viewer = byId('app-viewer');
      const scroller = byId('auth-landing-scroll');
      if (!viewer || !scroller) return;
      st.openSlug = slug;
      setOpenApp({ slug, name: app.name || slug });
      // #931: the anonymous viewer had the same white-window problem as the
      // signed-in App tab — the frame started loading here, but the zoom
      // animated a blank iframe and the app popped in afterwards. By this point
      // any required token is ready, so the src assignment is immediate; what
      // was missing is something to look at while it loads. Mount the same cover
      // over the frame and cross-fade it out on load, using the shared ladder in
      // AppView.
      clearViewerCover();
      const frame = byId<HTMLIFrameElement>('app-viewer-frame');
      const appView = legacy().AppView;
      if (appView && typeof appView.mountViewerCover === 'function') {
        appView.mountViewerCover(viewer, frame, app, {
          timers: st.timers,
          isCurrent: () => launchId === st.launchId,
        });
      }
      // The frame is fresh on every open (teardown swaps the element), so this
      // is its INITIAL navigation away from about:blank — the one browsers
      // elide instead of pushing onto the shared history stack.
      if (frame) frame.src = launchUrl;
      history.pushState({ svAnonAppViewer: true }, '', location.href);
      // The flex-sibling pitfall (#764): #app-viewer and #auth-landing-scroll
      // are flex:1 siblings, so while BOTH are visible (fn reveals the viewer,
      // the scroller stays beneath the zoom) they split the height 50/50 and
      // the kit would measure the viewer's destination as the bottom half.
      // `outEl` lets the kit hide the scroller for its synchronous pre-paint
      // measurement, so the zoom targets the true settled rect.
      zoomFx(
        () => {
          viewer.classList.remove('hidden');
        },
        {
          type: 'zoom-in',
          el: viewer,
          // There is no tile to grow out of any more, and `fromEl` is a thunk
          // precisely so it can say so: the kit then takes the `fallback`
          // below, which is the transition this call already declared for the
          // case where the tile had scrolled out of view.
          fromEl: () => null,
          outEl: scroller,
          fallback: 'push',
          after: () => scroller.classList.add('hidden'),
        },
      );
      refreshHeader();
    },
    [clearViewerCover, refreshHeader, st],
  );

  const closeLandingApp = useCallback(() => {
    const viewer = byId('app-viewer');
    const scroller = byId('auth-landing-scroll');
    if (!viewer || !scroller || viewer.classList.contains('hidden')) return;
    st.openSlug = null;
    setOpenApp(null);
    // #931: retire the launch generation and drop the cover before the
    // zoom-out, so a `load` still in flight can't fade a cover back in over
    // the shrinking overlay.
    st.launchId = (st.launchId || 0) + 1;
    clearViewerCover();
    // fallback 'none': a View Transition snapshot of a LIVE app iframe can
    // flash on iOS Safari, so the non-kit path cuts instantly — same choice
    // App.navigateHome makes leaving the App tab. `after` runs exactly once on
    // every path, so the shrinking overlay keeps showing the app's content
    // until it lands.
    zoomFx(
      () => {
        scroller.classList.remove('hidden');
      },
      {
        type: 'zoom-out',
        el: viewer,
        // Nothing to shrink back into — see the open path above.
        fromEl: () => null,
        fallback: 'none',
        after: () => {
          viewer.classList.add('hidden');
          swapViewerFrame();
        },
      },
    );
    refreshHeader();
    // #1028: the UI above has already closed — nothing here waits on the
    // browser. Unwind our own marker entry AFTERWARDS so the stack doesn't grow
    // one entry per open, and only when the current entry really is the
    // marker. The re-entrancy flag swallows exactly the popstate this
    // triggers; the timer is a backstop for the case where that popstate never
    // arrives (a foreign entry), so a later genuine back gesture can't be
    // swallowed instead.
    if (!st.unwindingViewerEntry && history.state && history.state.svAnonAppViewer) {
      st.unwindingViewerEntry = true;
      setTimeout(() => {
        st.unwindingViewerEntry = false;
      }, 600);
      try {
        history.back();
      } catch {
        st.unwindingViewerEntry = false;
      }
    }
  }, [clearViewerCover, refreshHeader, st]);

  const loadLandingApps = useCallback(async () => {
    try {
      const res = await fetch('/api/public/apps?include_wallets=0');
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const list: PublicApp[] = (data && data.apps) || [];
      // NOTHING RENDERS THIS LIST any more — the directory grid is gone. It
      // is still fetched, and this is the whole of why:
      //
      //   * `?shot=anon-back` needs an app the viewer would actually open
      //     (not gated, has a URL) to script its two guest open/back cycles,
      //     and takes it from here (see runAnonBackShot);
      //   * the scroller's pull-to-refresh runs this callback, so a pull
      //     still re-checks whether the platform redeployed
      //     (App._refreshOrReload);
      //   * `_loadLandingApps` is one of the nine names the legacy router
      //     patches over;
      //   * a shared link to a project, opened while signed out, opens the
      //     project's read-only page when it is public and titles its
      //     sign-in sheet with the project's name otherwise (#5264);
      //   * it IS the guest Discover (features/guest/guest-discover.tsx):
      //     every card there is a row of it.
      st.appsList = list;
      setApps(list as GuestApp[]);
      setAppsFailed(false);
    } catch {
      st.appsList = [];
      // A list read before stays on screen; only a first read that failed
      // says so.
      setAppsFailed(true);
    }
  }, [st]);

  /**
   * The whole `?shot=anon-back` script's time budget, held well under the
   * check runner's 25s per-check timeout so the run always ends in a verdict
   * rather than in an abandonment. 18s leaves seven for the page load and the
   * runner's own polling either side of it.
   */
  const ANON_BACK_BUDGET_MS = 18000;

  /**
   * Screenshot-state deep link `?shot=anon-back` (#1028): scripts the guest
   * back path end to end — open an app, back out, open again, back out —
   * because the regression it pins only appears from the SECOND open onward,
   * and neither the capture nor the proposal check can click anything.
   * `#app-viewer` is stamped `data-anon-back="done"` at the end so the
   * dapp.json assertion can't pass vacuously on a directory that never loaded
   * (an empty list leaves the attribute unset).
   *
   * Steps wait on the actual DOM state rather than a fixed delay. Budgets are
   * CAPS, not sleeps: the happy path finishes as fast as the transitions do.
   * They are generous because the close leg rides history.back() → popstate →
   * the 600ms unwind guard and takes ~2s even on an idle page — the old 900ms
   * cap expired mid-close every time, cycle two ran against a still-open
   * viewer, and the stamp never landed (the check runner polls the assertion
   * since #1148, so a few seconds of page-side patience is free).
   */
  const runAnonBackShot = useCallback(async () => {
    const viewer = byId('app-viewer');
    if (!viewer) return;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // ONE OVERALL DEADLINE, because the per-step caps MULTIPLY and nobody had
    // added them up. It was two cycles of 5000 (tile) + 5000 (open) + 8000
    // (close) plus a 2000 the tile got before the loop — 38.4 SECONDS of
    // worst case, against a check runner that abandons a check at 25
    // (TEST_TIMEOUT_MS, capture/capture.js). The three tile polls are gone
    // with the grid and the worst case is 26 now, which is still over.
    // So on any preview slow enough to spend those budgets — which is what a
    // pool of eight hammering one container produces — this check could not
    // report at all, and it failed as "did not finish within 25s" rather than
    // as anything anyone could act on.
    //
    // The caps below stay as they are: each one is a real statement about how
    // long its own step may honestly take, and the close leg genuinely needs
    // seconds (history.back() → popstate → the 600ms unwind guard). What is
    // added is a ceiling on their SUM, so the script always returns in time to
    // be judged. Spending it means the page really was too slow, and the
    // assertion then fails on the missing marker — a fact — instead of on a
    // timeout, which says nothing about the guest back path at all.
    const deadline = Date.now() + ANON_BACK_BUDGET_MS;
    const until = async (pred: () => boolean, budgetMs: number) => {
      const stop = Math.min(Date.now() + budgetMs, deadline);
      while (!pred() && Date.now() < stop) await wait(30);
      return pred();
    };
    const isOpen = () => !viewer.classList.contains('hidden');
    /**
     * Stamp WHY the script gave up (#1755).
     *
     * Every bail below used to be a bare `return`, which left
     * `data-anon-back` unset. The assertion can then never become true, so
     * the runner polls it to its 25s per-check cap and reports `Check did not
     * finish within 25s` — the same sentence whichever step failed, about a
     * page that may be perfectly healthy. That verdict is unactionable, and
     * "re-run it" was the only tool anyone had.
     *
     * Stamping a non-`done` value changes nothing about what passes: the
     * assertion requires `data-anon-back="done"` and still gets it only from
     * the happy path. What it buys is a verdict that arrives IMMEDIATELY, on
     * a settled DOM, naming the step.
     *
     * The `-slow` suffix separates the two questions that matter and used to
     * be indistinguishable: a step that genuinely failed, versus one that ran
     * out of the overall budget because the container was overloaded. The
     * first is a bug in the guest back path; the second is capacity.
     */
    const bail = (reason: string) => {
      viewer.setAttribute('data-anon-back', Date.now() >= deadline ? `${reason}-slow` : reason);
    };
    try {
      await st.appsReady;
    } catch {
      /* ignore */
    }
    // First app the viewer would actually open: not gated, has a URL.
    const target = st.appsList.find((a) => a && a.requires_login === false && a.url);
    if (!target) { bail('no-target'); return; }
    for (let cycle = 0; cycle < 2; cycle++) {
      const c = `c${cycle + 1}`;
      // OPEN THROUGH THE OPENER, not through a tile.
      //
      // This used to poll for the target's tile inside the directory grid and
      // click it, twice — once before the loop and once inside it — because
      // the tiles appeared one React commit after `st.appsReady` settled. The
      // directory grid is gone, so there is no tile to wait for and those two
      // polls would now spend their budget and stamp `no-tile` on a perfectly
      // healthy page, failing the declared check on every submission.
      //
      // `openLandingApp` is what the tile click called. Driving it directly
      // exercises the same thing the check is FOR — two full guest open/back
      // cycles through the real viewer, the real token path and the real
      // history marker — and removes a prerequisite the screen no longer has.
      // It is awaited because the account gate in front of it is async; this
      // target is ungated, so it resolves without a round trip.
      await openLandingApp(target);
      if (!(await until(isOpen, 5000))) { bail(`open-timeout-${c}`); return; }
      // Let the zoom-in settle before backing out, so each cycle exercises a
      // fully-open viewer rather than a mid-transition one.
      await wait(140);
      byId('landing-back-btn')?.click();
      // The stamp below is the assertion's subject: a close that never lands
      // means the guest back path is genuinely broken, so bail WITHOUT
      // stamping rather than start cycle two against an open viewer.
      if (!(await until(() => !isOpen(), 8000))) { bail(`close-timeout-${c}`); return; }
      // Let the marker entry's history.back() popstate drain before the next
      // cycle pushes a fresh entry — a human cannot re-open in under 80ms.
      await wait(80);
    }
    viewer.setAttribute('data-anon-back', 'done');
  }, [openLandingApp, st]);

  const landingOnShow = useCallback(() => {
    refreshHeader();
    // Arrived by a waitlist "you're in" link. Read once, so a reload now
    // would lose it; a sign-in has begun, so the shell does not swap the
    // build in under it (App.noteSignInBegun).
    //
    // A new account's link (Evan, 12 Oct 2026): "Signing you in…" at once
    // (`holding`), while the effect above checks, with a GET that spends
    // nothing, whether the account is still new, and spends the link if it
    // is; then the full-page Welcome. It is committed here, in flushSync,
    // because show() reveals the screen right after this hook returns, and
    // the story must not be seen first and then taken away. An account
    // already set up gets the story once the check says so, and its link
    // still waits for Get started (the 10 Oct rule): only the sheet spends
    // it. An existing account's `?login=1` link opens Sign in, as before.
    const link = takeReleaseLink();
    if (link) {
      noteSignInBegun();
      flushSync(() => {
        setRelease(link);
        setResume(null);
        setHolding(straightLink(link));
        if (link.route !== 'signup') setSheet('signin');
      });
    }
    // An old #waitlist link (#5261): its join form is retired, and Continue
    // is what joins now, so the story opens with it up. With the story
    // switched off there is no sheet, and the landing's own waitlist pill
    // is the way to join.
    if (takeStartSheet() && !link) {
      flushSync(() => { setResume(null); setSheet('start'); });
    }
    // A shared link opened while signed out (#5264): the sheet for the place
    // it names, up as the screen is, so the story is not seen first. Read
    // once; any other way here (a Back, #landing, a sign-out) has none, and
    // takes down one left from before.
    const host = legacy().AuthScreens as { _deepLinkSignIn?: string } | undefined;
    const target = typeof host?._deepLinkSignIn === 'string' ? host._deepLinkSignIn : '';
    if (host) host._deepLinkSignIn = '';
    flushSync(() => {
      setDeepLink(target ? { target, place: deepLinkPlace(target) } : null);
      setIntent(null);
    });
    if (!st.appsLoaded) {
      st.appsLoaded = true;
      st.appsReady = loadLandingApps();
    }
    // Warm the options (memoised) while the visitor is reading the story,
    // so the sheet's providers and terms are there by the time they tap
    // through.
    void waitlistOptions();
    // Screenshot-state deep link `?shot=anon-back` (#1028) — see above.
    let shot: string | null = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch {
      /* ignore */
    }
    if (shot === 'anon-back' && !st.anonBackShotRan) {
      st.anonBackShotRan = true;
      void runAnonBackShot();
    }
  }, [loadLandingApps, refreshHeader, runAnonBackShot, st]);


  // ── The seam back into public/js/** ────────────────────────────────
  //
  // `AuthScreens.show()` / `hideAll()` look these up by name at call time, so
  // patching them here replaces the legacy landing half wholesale. Forwarders
  // keep the installed identity stable while reading the current closures.
  const live = useRef({ landingOnShow, resetViewer, openLandingApp, closeLandingApp, refreshHeader, loadLandingApps });
  live.current = { landingOnShow, resetViewer, openLandingApp, closeLandingApp, refreshHeader, loadLandingApps };
  useAuthScreensPatch({
    _wireLanding: () => {},
    _landingOnShow: () => live.current.landingOnShow(),
    _resetLandingViewer: () => live.current.resetViewer(),
    _openLandingApp: (app: PublicApp) => live.current.openLandingApp(app),
    _closeLandingApp: () => live.current.closeLandingApp(),
    _renderLandingHeader: () => live.current.refreshHeader(),
    _loadLandingApps: () => live.current.loadLandingApps(),
    _landingTileFor: (slug: string) => landingTileFor(slug),
    _swapViewerFrame: () => swapViewerFrame(),
  });

  /**
   * Kit pull-to-refresh on the landing scroller, same element-mode wiring as
   * the authed screens (app.js _wirePullToRefresh). The kit no-ops this on
   * desktop; the refresh re-pulls the app directory (probe results, active-user
   * counts, new deploys) — and, via App._refreshOrReload, hard-reloads when the
   * platform itself redeployed since this document loaded (the anonymous shell
   * has no drawer, hence no stale-version pill, so this pull is its only
   * recovery path to new client code).
   *
   * Attached to the INNER scroller, never the fixed overlay: the rubber-band
   * translate on the overlay itself would expose the authed shell's header
   * behind it during the pull.
   */
  useEffect(() => {
    const ui = legacy().PlatformUI;
    if (!ui) return;
    // The scroller is part of the interior, so there is nothing to attach to
    // until the screen has mounted; keyed on that, this runs once it has.
    if (!mounted) return;
    const handle = ui.pullToRefresh(byId('auth-landing-scroll'), () =>
      legacy().App?._refreshOrReload?.(() => live.current.loadLandingApps()),
    );
    return () => {
      try {
        handle?.detach();
      } catch {
        /* ignore */
      }
    };
  }, [mounted]);

  /**
   * The browser/OS back gesture still closes the viewer. Ignore a popstate
   * that LANDS on the marker entry — that is a pop INTO the open viewer, not
   * out of it — and the one our own unwind provokes.
   */
  useEffect(() => {
    const onPop = () => {
      if (st.unwindingViewerEntry) {
        st.unwindingViewerEntry = false;
        return;
      }
      if (history.state && history.state.svAnonAppViewer) return;
      live.current.closeLandingApp();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [st]);

  // Mirror the header title into the tab title so the Flutter WebView's AppBar
  // follows the screen, same as App.setHeaderTitle does authed.
  const headerTitle = openApp ? openApp.name || openApp.slug : guestProject ? guestProject.name : LANDING_TITLE;
  // A visitor tried to take part on a project's page: the sign-in sheet,
  // titled for it, and signing in lands back on that page, the address the
  // shell restores after a sign-in (AuthScreens.finishLogin).
  const askFor = useCallback((i: GuestIntent) => {
    (legacy().AuthScreens?.rememberDeepLink as undefined | ((h: string) => void))?.(projectHash(i.app.slug));
    setResume(null);
    setIntent(i);
  }, []);
  const closeIntent = useCallback(() => { setIntent(null); setResume(null); }, []);
  // A project's page's Share: the system's share sheet where there is one,
  // else the link copied. The clean `/app/<slug>` address, which opens this
  // page for somebody signed out and the app for a member.
  const shareProject = useCallback(async (app: GuestApp) => {
    const url = `${location.origin}/app/${encodeURIComponent(app.slug)}`;
    const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (typeof nav.share === 'function') {
      try { await nav.share({ title: app.name, url }); } catch { /* dismissed */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      legacy().PlatformUI?.toast?.(translate('auth:guest.project.linkCopied'));
    } catch {
      legacy().PlatformUI?.toast?.(url);
    }
  }, []);
  // A project's page, or Discover again, starts at its top.
  const shownSlug = guestProject?.slug ?? null;
  useEffect(() => {
    byId('auth-landing-scroll')?.scrollTo?.(0, 0);
    if (document.documentElement.dataset.browserScroller) window.scrollTo(0, 0);
  }, [shownSlug]);
  // The bar's back button: out of the open app, else from a project's page
  // to Discover.
  const showBack = !!openApp || !!guestProject;
  const onBack = useCallback(() => {
    if (st.openSlug) { live.current.closeLandingApp(); return; }
    location.hash = '#apps';
  }, [st]);
  useEffect(() => {
    try {
      document.title = headerTitle;
    } catch {
      /* ignore */
    }
  }, [headerTitle]);

  /**
   * Every anchor on this screen tears the viewer down first: they all leave
   * the landing screen, and the viewer lives INSIDE this z-40 overlay now, so
   * the next screen would otherwise paint over a still-running iframe. show()
   * also resets it on the route change — this keeps the teardown ahead of the
   * transition, same as it has always been for Sign in.
   *
   * The marketing pill is the one that does not leave: `target="_blank"` on a
   * cross-origin URL is handed to the native bridge (public/js/nav-link.js)
   * and the app stays where it is. It calls this anyway, because resetViewer
   * returns immediately on a hidden viewer and because the rule "an anchor
   * here closes the viewer" is easier to keep than its exceptions.
   */
  const onLeaveCta = useCallback(() => {
    live.current.resetViewer();
  }, []);

  return (
    <main
      ref={rootRef}
      id="auth-landing-screen"
      className="hidden fixed inset-0 z-40 bg-white dark:bg-zinc-950 flex flex-col"
    >
      {mounted ? (
        <>
      {/*
          Mirrors #platform-header's shape (height, padding, safe-area) so
          both shells read identically — same HEADER HEIGHT INVARIANT:
          `pt-2 pb-4` around a 28px content row, i.e. 52px + safe-area, with
          `h-7` on the lead group as the floor and nothing inside allowed to
          exceed 28px.

          The bar used to carry two CTAs, and they broke that invariant twice
          over: `sm:py-2 sm:text-sm` made them 36px at `sm` and up (a 61px
          bar), and the bordered one was still 30px at `py-1.5`. It carries no
          anchors at all now. The two ways in are pills in the body, where
          somebody who has just read what this place is can reach them; a
          stranger's first tap should not be a 28px chip in the corner.

          The 28px lead box is fixed-WIDTH on purpose: toggling the back
          button's `hidden` must not shift what is beside it.
      */}
      <header
        id="landing-header"
        className="un-safe-top-extend relative flex items-center gap-3 px-4 pt-2 pb-4 shrink-0"
      >
        <div className="w-7 h-7 shrink-0 flex items-center justify-center">
          <button
            id="landing-back-btn"
            type="button"
            className={hiddenLast(!showBack, LANDING_BACK_CLASS)}
            aria-label={t('auth:landing.backToApps')}
            onClick={onBack}
          >
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
        </div>
        {/*
            The bar's one label, saying two different things.

            With an app open it is that app's NAME: the header is what stays
            put while the viewer runs — which is why #app-viewer has no bar of
            its own — and `document.title` follows it into the Flutter
            WebView's AppBar. With nothing open it is the logotype rather than
            the word "Homeroom" set in the UI font.

            The className is CONSTANT across that swap deliberately: it is the
            same box either way, and a class string that moved with the state
            would rewrite this element's attribute on every open and close.
            The mark is `h-7` — the content row exactly — takes its width from
            its own aspect ratio, and is inked black (white in dark mode) like
            the logotype everywhere (#4382); `title` gives it the accessible name the
            text branch has for free, so the bar still answers "Homeroom".

            Not a heading (polish N10): the page under it has its own <h1>
            (the story's or the pitch's headline), and a second one in the
            bar made two top-level headings for one screen.
        */}
        <div
          id="landing-header-title"
          className="flex-1 min-w-0 px-10 text-lg font-bold pointer-events-none truncate text-center"
        >
          {openApp || guestProject ? headerTitle : <Wordmark className="h-7 w-auto inline-block align-middle text-zinc-950 dark:text-white" title={LANDING_TITLE} />}
        </div>
        {/*
            The trailing 28px, mirroring the lead box so the label sits on the
            bar's true centre rather than 40px right of it. It is what makes
            tests/header-height-parity.test.js's stated reason for the w-7 lead
            box ("its title IS centred") true of the markup as well as of the
            prose. No h-7 on it: the floor matcher there takes the FIRST div
            carrying h-7, and the lead group must stay that div.
        */}
        <div className="w-7 shrink-0" aria-hidden="true" />
        {/*
            THE ONE WAY IN THE BAR CARRIES (the guest Discover, 21 Oct 2026):
            a quiet "Sign in", for somebody who has an account and is looking
            around before they do. A button at the content row's own 28px
            with no padding of its own, so the bar keeps its height
            (tests/header-height-parity.test.js), and placed over the
            trailing box rather than in the row, so the mark stays on the
            bar's true centre; the title's `px-10` keeps a long project name
            from running under it. Making an account is still the body's
            Continue, under the sentence that says what this place is.
            Not for a waiting-room session, which is signed in already.
        */}
        <button
          type="button"
          data-landing-sign-in=""
          className={hiddenLast(session || !guestOn, 'absolute right-4 bottom-4 h-7 rounded-full px-1 text-[15px] font-semibold text-zinc-950 hover:text-zinc-600 dark:text-white dark:hover:text-zinc-300')}
          onClick={() => setSheet('signin')}
        >
          {t('auth:guest.header.signIn')}
        </button>
      </header>
      {/*
          Inner scroller: the kit pull-to-refresh rubber-band translates the
          element it is attached to. Attaching to the overlay itself would
          slide the WHOLE screen down (header included) and expose the
          authed shell behind it (z-lower in the same document) — so the
          overlay stays put as an opaque backstop and this wrapper takes
          the gesture. flex-1/min-h-0, not h-full: it's a flex child under
          the header now, and h-full would overflow by the header's height.
      */}
      <div id="auth-landing-scroll" className="flex-1 min-h-0 overflow-y-auto platform-safe-scroll">
        {/*
            The side gutter is `px-4`, and it is stated per BLOCK rather than
            on this wrapper, because the chip rail is the one thing that must
            run past it. 16px is the shell's gutter everywhere — including
            #landing-header above, whose px-4 is part of the parity contract
            with #platform-header — so the bar's mark and the body's text
            share one left edge.

            `pb-[34px]` is the clearance above the home indicator. The
            scroller's own bottom padding is the safe-area inset
            (.platform-safe-scroll REPLACES it), which is zero on a desktop
            or an Android without one, so the last thing on the screen needs
            air of its own either way. A live invite's page ends on its pinned
            Join bar instead (InviteJoinBar, below this scroller), which
            clears the home indicator itself, so it keeps only `pb-4`.

            `flex min-h-full flex-col` is the BOTTOM PIN — board 1 is a flex
            column whose action block sits at the foot of the screen with that
            34px as its only clearance. It is on THIS wrapper and not on
            #auth-landing-scroll because the scroller's class attribute is
            written from outside React (see the file header); a rendered class
            string there would wipe the kit's `hidden`.

            THE COLUMN'S WIDTH grows in two steps and then stops: 384px on a
            phone, 512 from md, 672 from xl (max-w-sm / lg / 2xl — the shell's
            own scale rather than three arbitrary pixel counts). One column of
            words and two pills held at 384 in a maximized window reads as a
            phone screenshot pasted into the middle of a desktop, which is what
            a reviewer said of the build before this one.

            NOTHING WIDER THAN 672, because the chip rail below loops by
            walking half a track one lap long, and a lap is 859px: a container
            wider than that would show ground between the last chip and the
            first.

            THE WIDEST STEP IS xl, NOT lg, and the reason is height. The
            illustration and the heading grow with the column, and at lg the
            two together are ~90px taller — which on the 768px-tall window a
            1024-wide one usually is (and on a 1280x800 laptop) pushed "Join
            the waitlist" under the fold. Tailwind's variants ask about width
            only, so the step that costs height is taken at the width where a
            window is tall enough to pay for it. Measured after: every shape
            from 768x1024 up ends with the status line 37px clear of the
            bottom edge, and nothing below that scrolls any further than it
            did before.

            min-h-full, not h-full, is what keeps the scroller a scroller. The
            wrapper is AT LEAST the height visible inside the scroller, so when
            the content is shorter than the viewport there is free space for
            the two spacers to share. When the content is taller
            — a 560px window, or a long translation — the wrapper's height is
            its content's, the free space is zero, and nothing grows or
            shrinks: the illustration and the heading keep their natural
            boxes and the scroller scrolls exactly as it did before. The
            percentage resolves because the scroller has a definite height
            (flex-1/min-h-0 under a fixed inset-0 column), and it resolves
            against the height INSIDE it — .platform-safe-scroll puts the
            safe-area inset in the scroller's own padding — so the pin cannot
            introduce an overflow of its own.
        */}
        <div className={`${guestOn ? 'max-w-6xl' : 'max-w-sm md:max-w-lg xl:max-w-2xl'} mx-auto flex min-h-full flex-col ${madeForYou ? 'pb-4' : 'pb-[34px]'}`}>
          {/*
              Offline explanation (#1021). Both ways in from this screen —
              the marketing waitlist page and Sign in — need a connection, so
              say so once, here, rather than letting two taps fail silently.
          */}
          <div className={OFFLINE_NOTICE}>
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
              {t('auth:landing.offline.title')}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {t('auth:landing.offline.body')}
            </p>
            <button
              type="button"
              data-offline-retry=""
              className="mt-3 rounded-lg border border-amber-500/50 px-3 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              {t('auth:landing.offline.retry')}
            </button>
          </div>
          {/*
              AN INVITE LINK'S CARDS (./invite-card.tsx): the project and who
              invited you, its picture and the note. The way in is pinned
              below this scroller (InviteJoinBar). Only on
              /invite/<token>, with a placeholder in their place until its
              preview is back — nothing here on any other visit. A dead link
              (or a mistyped one) has its own page in the pitch's place.
          */}
          {invitePending && !invite ? <InvitePending /> : null}
          {madeForYou ? <MadeForYou preview={invite!} /> : null}
          {deadInvite ? <DeadInvite preview={invite!} primaryClass={PRIMARY_PILL} /> : null}
          {/*
              DECORATIVE, so `alt` is empty: everything it says is said again
              in the words below it, and a screen reader announcing a
              description of an illustration before the heading would be one
              more thing between a stranger and what this is.

              `width`/`height` are the file's own pixels (public/brand/
              people.png, 2x), which reserve the box before it decodes so the
              heading under it does not jump. It sits straight on the
              wallpaper with no plate behind it, in both themes.

              `mt-6` is board 1's `padding-top: 24px` on this block, measured
              from the bottom of the bar above. The board draws that bar as
              60px of root padding around a 44px row and #landing-header is a
              52px bar whose shape is pinned by
              tests/header-height-parity.test.js, so what transfers is the GAP
              below the bar, not the two numbers that produce the board's.

              `xl:w-[320px]` is the desktop size, and 320 rather than the 400
              the 672px column could hold: the art is a sticker on the
              wallpaper, not the subject, and every pixel of its height comes
              off the room the two pills have on a 800px-tall laptop.
          */}
          {/*
              THE TOP HALF OF THE CENTRING PAIR. Its twin is the `grow`
              spacer below the sentence, and the two together are what put
              the free space EITHER SIDE of this group rather than all of it
              underneath: two flex children with the same growth factor split
              what is left equally, so the illustration, the rail and the
              words sit centred in the band above the two pills while the
              pills stay pinned to the foot.

              Measured before this existed, the gap under the sentence was
              155px on a 390x844 phone and 391px at 1920x1080, with the
              illustration hard against the bar in both — the screen read as
              two things stuck to opposite edges. Splitting it is the whole
              change; the pin below is untouched.

              When the content is taller than the scroller there is no free
              space to split, so this is zero high and the layout is exactly
              the one a short viewport had before.
          */}
          <div className={hiddenLast(pitchHidden, 'grow')} />
          <img
            src="/brand/people.png"
            alt=""
            width={816}
            height={612}
            draggable={false}
            className={hiddenLast(pitchHidden, 'mx-auto mt-6 block h-auto w-[272px] xl:w-[320px] max-w-full')}
          />
          {/*
              The rail deliberately overflows AND loops: its four chips are
              wider than a phone, and rather than sit cut off they travel.
              The animation is app.css's `.landing-rail-track` — the house
              keeps keyframes there, with the prefers-reduced-motion guard
              beside them, rather than in tailwind.config.js.

              The chips are rendered TWICE and the track walks exactly half
              its width, which is what makes the loop seamless. That halving
              is only exact because each chip carries its 8px as `mr-2`
              rather than the row carrying `gap-2`: eight chips and seven
              gaps do not halve cleanly, and the seam stutters once a cycle.

              This is a plain div, not `ChipRail`: that primitive exists to
              make a row finger-scrollable and hide its scrollbar, and a
              track that moves on its own is not a control. `pl-4` sets the
              first chip on the gutter; nothing pads the right, because
              running off that edge is the whole idea.

              Board 1 draws the row as `padding: 20px 0 4px`: `mt-3` plus
              `pt-2` is the 20 above, `pb-1` the 4 below.
          */}
          <div className={hiddenLast(pitchHidden, 'mt-3 overflow-hidden pt-2 pb-1 pl-4')}>
            <div className="landing-rail-track">
              {[0, 1].map((copy) => CHIPS.map(({ line, dot }) => (
                <span
                  key={`${copy}-${line}`}
                  className={CHIP}
                  // The second lap is the same four lines over again, so it
                  // is the loop's mechanism rather than content: hidden from
                  // assistive tech, which hears the row once.
                  aria-hidden={copy === 1 ? true : undefined}
                >
                  {/*
                      Decoration, and nothing but: the block says the same
                      thing four times in four colours, so it is hidden from
                      assistive tech and the chip announces only its line.
                      `style` carries the gradient for the reason CHIP_DOT
                      gives — it is a value no class literal can hold well.
                  */}
                  <span className={CHIP_DOT} style={{ background: dot }} aria-hidden="true" />
                  <span className={CHIP_LABEL}>{t(line)}</span>
                </span>
              )))}
            </div>
          </div>
          {/*
              The copy block, and the half of the pin that lives down here.
              `flex grow flex-col` is what makes this column take the
              wrapper's free space; the spacer below it is what spends that
              space, pushing the action block to the foot of the screen the
              way board 1's own `flex-grow: 1` does. The words and the
              actions share this column, so the spacer has to be inside it.

              Board 1 opens the block 20px under the rail's 4px tail —
              `pb-1` up there plus `mt-5` here — and sets eyebrow, heading
              and sentence 10px apart (`mt-2.5`).

              `text-balance` on the heading and `text-pretty` on the sentence
              are what centring made necessary: ragged-left, a short last line
              is invisible; centred, "us." alone under a full line is the
              first thing the eye lands on. Both are hints — a browser without
              them wraps exactly as before — so neither is load-bearing.
          */}
          {/*
              CENTRED, not ragged-left. The illustration above is centred on
              the column and the pair of pills below is a symmetric block, so
              left-aligned words between them put the composition's weight on
              one edge and left the other empty — which is what a reviewer
              called "stuck" when the screen was tall enough to show it. One
              `text-center` here carries the eyebrow, the heading, the
              sentence and the way out to the marketing site; the status line
              under the pills was already centred for the same reason.

              It is on the BLOCK rather than on each line because the
              alignment is a property of the composition, not of any one
              string, and a later line added here should inherit it.
          */}
          <div className={hiddenLast(pitchHidden, 'px-4 flex grow flex-col text-center')}>
            <p className="mt-5 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
              {t('auth:landing.pitch.eyebrow')}
            </p>
            <h1 className="mt-2.5 text-[30px] leading-[34px] md:text-[34px] md:leading-[38px] xl:text-[38px] xl:leading-[42px] font-extrabold text-balance">
              {t('auth:landing.pitch.headline')}
            </h1>
            <p className="mt-2.5 text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400 text-pretty">
              {t('auth:landing.pitch.body')}
            </p>
            {/*
                THE WAY OUT TO THE LONG VERSION. One sentence is the right
                length for a first screen and far too short for somebody
                weighing up whether to join, and the marketing site already
                carries everything written to answer them.

                Hidden until the server has named the host, exactly like the
                primary pill above: this file must not write the marketing
                origin down, and an enabled-looking link with no destination
                is worse than one that is not there yet. `target="_blank"` on
                a cross-origin href is what public/js/nav-link.js hands to the
                bridge's openExternal, so on the phone it opens the system
                browser rather than stranding the reader outside the app's
                bound domain.

                It names its destination rather than saying "here", because a
                link's text is what a screen reader reads out of context.
            */}
            <p className={hiddenLast(!siteUrl, 'mt-3 text-[15px]')}>
              <a
                href={siteUrl || undefined}
                target={siteUrl ? '_blank' : undefined}
                rel={siteUrl ? 'noopener noreferrer' : undefined}
                data-offline-disabled=""
                className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
              >
                {t('auth:landing.learnMore')}
              </a>
            </p>
            {/*
                THE PIN ITSELF — board 1's `<div style="flex-grow: 1">`, in the
                same place: between the sentence and the two pills. Measured in
                the build before it, at 411x998, the status line ended 310px
                above the bottom edge and a tall phone read as top-weighted,
                with the two ways in floating in the middle of a dead area.

                It has a twin above the illustration now, and the pair is what
                centres the group between the bar and the pills. Both grow by
                the same factor, so each takes half of whatever is left; this
                one alone would put all of it here, which is the gap the twin's
                note measures.

                A spacer rather than `mt-auto` on the block below, because the
                32px there is a MINIMUM and an auto margin would replace it
                rather than add to it. This way the short-viewport case needs
                no special handling at all: with no free space to distribute
                the spacer is simply zero high, and `mt-8` is the gap.
            */}
            <div className="grow" />
            {/*
                The two pills keep the PHONE's width whatever the column does.
                They are the one part of this screen that is a control rather
                than a picture or a paragraph: a 672px-wide "Join the waitlist"
                stops reading as a button, which is exactly what the previous
                max-w-3xl column drew at 1280 (a 736px pill beside a 272px
                illustration). So the column above grows and this block does
                not — same 384px cap as the sign-in screen's own column, on
                the heading's left edge.
            */}
            <div className="mt-8 w-full max-w-sm md:max-w-md mx-auto">
              {/*
                  THE ANONYMOUS WAY IN: the marketing waitlist page, then Sign
                  in, then one line for somebody who already joined. Both
                  branches of this block are always RENDERED and toggled with
                  `hidden` rather than mounted conditionally — the id
                  inventory resolves #landing-waitlist-link,
                  #landing-status-link and #landing-back-to-waiting against
                  this interior's markup, and an id that renders only in one
                  session state is an id that inventory reads as lost.
              */}
              <div className={hiddenLast(session, 'flex flex-col gap-2.5')}>
                {/*
                    THE PAIR. Stacked on a phone, side by side from md, where
                    the column is wide enough that two full-width pills read
                    as a stack of bars rather than a choice. The primary
                    keeps its prominence from its fill, not from its width,
                    which is the same way the shell's own dialogs pair a
                    confirm with a cancel.

                    A two-column GRID, not `flex-row` with `flex-1` on each:
                    a flex item's `basis-0` is a content-box zero that its own
                    padding still adds to, and these two pills are padded
                    differently — measured, that drew 239px beside 199px. Grid
                    tracks are sized by the track, so the halves are equal
                    whatever each pill carries inside it.

                    The row is a wrapper INSIDE the block rather than the
                    block itself, because the "Already joined?" line below is
                    a footnote to both pills and stays under them at every
                    width.
                */}
                <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2">
                  {/*
                      The waitlist form lives on the MARKETING SITE, and this
                      pill is the only thing that points at it. Three
                      consequences worth stating where they are made:

                      `target="_blank"` on a cross-origin URL is what the
                      shell's delegated capture listener (public/js/nav-link.js)
                      hands to the native bridge's openExternal, so the system
                      browser opens it instead of the webview navigating off the
                      bound domain. Same-origin would not fire that listener at
                      all.

                      `href`, `target` and `rel` arrive TOGETHER or not at all,
                      and the pill is HIDDEN until they do — the URL comes from
                      the options fetch, so that is the first paint, and forever
                      if the request fails. A fully-styled, hover-reactive pill
                      that swallows the tap is worse than no pill: the visitor
                      still has "Sign in" and the status line, both of which
                      work. It is hidden rather than given a fallback href
                      because there are only two candidates and this design
                      rules out both — the marketing host is configuration and
                      is never written into this file, and the in-app #waitlist
                      form is the one destination the redesign removes, so
                      pointing there even for a tick would undo the change.

                      HIDDEN, not unmounted: the id inventory reads this
                      interior's static markup, where no effect has run, so the
                      anchor must be present and carrying `hidden` there — the
                      same rule the two branches of this block follow.

                      `data-offline-disabled` because joining is a POST on the
                      other end and cannot work offline either.
                  */}
                  <a
                    id="landing-waitlist-link"
                    href={waitlistUrl || undefined}
                    target={waitlistUrl ? '_blank' : undefined}
                    rel={waitlistUrl ? 'noopener' : undefined}
                    data-offline-disabled=""
                    className={hiddenLast(!waitlistUrl, PRIMARY_PILL)}
                    onClick={onLeaveCta}
                  >
                    {t('auth:landing.joinWaitlist')}
                  </a>
                  <a href="#login" className={SECONDARY_PILL} onClick={onLeaveCta}>
                    {t('auth:landing.signIn')}
                  </a>
                </div>
                {/*
                    The way back for somebody who already joined, on a device
                    that knows nothing about it (#1538). It opens the same
                    code-entry step the waitlist screen's own "Already
                    joined?" link does, which is where an emailed code is
                    typed and where the status comes back — so this one stays
                    INSIDE the app while the pill above leaves it.
                */}
                {/*
                    Centred, as board 1 draws it: a footnote to the two
                    full-width pills above, not a third left-aligned line.
                */}
                <p
                  className={hiddenLast(
                    session,
                    'mt-1.5 text-center text-[15px] text-zinc-500 dark:text-zinc-400',
                  )}
                >
                  <RichMessage id="auth:landing.alreadyJoined" components={[
                  <a
                    id="landing-status-link"
                    href="#waitlist?confirm=1"
                    data-offline-disabled=""
                    className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
                    onClick={onLeaveCta}
                  />,
                  ]} />
                </p>
              </div>
              {/*
                  THE WAITING-ROOM WAY IN. A signed-in visitor who has not
                  been admitted still reaches this screen (app.js routes
                  `#waiting` here when the session has no platform access),
                  and for them both pills above are wrong: they have already
                  joined the waitlist and they are already signed in. So the
                  action area becomes one pill back to the room that can
                  actually tell them where they stand, and the "already
                  joined?" line goes with the rest — they are past it.

                  The id is the one the retired wrapper div carried, on the
                  anchor itself now; nothing but this test-visible inventory
                  ever looked it up.
              */}
              <a
                id="landing-back-to-waiting"
                href="#waiting"
                className={hiddenLast(!session, PRIMARY_PILL)}
                onClick={onLeaveCta}
              >
                {t('auth:landing.backToWaiting')}
              </a>
            </div>
          </div>
          {/*
              THE GUEST PAGES (features/guest), in the story's place: a
              public project's read-only page when the address names one,
              else the guest Discover under the story's short hero. While a
              project link waits on the directory, nothing yet.
          */}
          {guestOn && guestProject ? (
            <GuestProject
              app={guestProject}
              primaryClass={PRIMARY_PILL}
              onIntent={askFor}
              onOpenInside={(app) => { void live.current.openLandingApp(app); }}
              onShare={shareProject}
            />
          ) : null}
          {guestOn && !guestProject && !linkPending ? (
            <GuestDiscover
              apps={apps}
              failed={appsFailed && !apps}
              primaryClass={PRIMARY_PILL}
              waitlist
              onContinue={() => setSheet('start')}
              onOpenInside={(app) => { void live.current.openLandingApp(app); }}
              hero={(
                <Story
                  compact
                  primaryClass={PRIMARY_PILL}
                  welcomeEmail={releaseEmail}
                  onStart={() => setSheet('start')}
                  onSignIn={() => setSheet('signin')}
                  actions={<SignUpButtons methods={methods} onPick={signUp} primaryClass={PRIMARY_PILL} />}
                />
              )}
            />
          ) : null}
        </div>
      </div>
      {/*
          A live invite's Join, pinned to the foot of the screen (#4203): the
          column's next child after the scroller, so the scroller ends above
          it and nothing on the page can sit under it. Not while an app is
          open in the viewer, which takes the scroller's place.
      */}
      {madeForYou && !openApp ? (
        <InviteJoinBar preview={invite!} primaryClass={PRIMARY_PILL} onJoin={() => setSheet('join')} />
      ) : null}
      <ViewerRegion />
      {/*
          The sign-in sheet "Made for you"'s Join opens (./sign-in-sheet.tsx).
          Rendered nothing until then, so the interior's first commit is the
          markup the prerender shipped.
      */}
      {madeForYou ? (
        <SignInSheet
          open={sheet === 'join'}
          title={t('auth:landing.sheet.join', { project: invite!.project!.name })}
          followInvite
          providers={providers}
          native={nativeSignIn}
          phone={phoneSignIn}
          askName={!invite!.project!.public}
          from="invite"
          returnTo={location.pathname}
          resume={resume}
          onClose={closeSheet}
          primaryClass={PRIMARY_PILL}
        />
      ) : null}
      {/*
          A shared link opened while signed out (#5264): the sign-in sheet,
          titled for where the link leads, over a blurred stand-in for that
          page. Signing in lands there (AuthScreens.finishLogin restores the
          link the router remembered); Apple's or Google's trip comes back to
          it too. Rendered nothing until the screen shows for such a link.
      */}
      {gate ? <DeepLinkBackdrop /> : null}
      {gate ? (
        <SignInSheet
          open
          title={deepLinkTitle(gate.place, gateProject, (id, params) => t(id, params))}
          providers={providers}
          native={nativeSignIn}
          phoneLink={phoneSignIn}
          askName={false}
          from="signin"
          returnTo={deepLinkReturnTo(gate.target)}
          resume={resume}
          onClose={closeGate}
          primaryClass={PRIMARY_PILL}
        />
      ) : null}
      {/*
          Taking part on a public project's page (./../guest/guest-project.tsx):
          Join, Vote, Ask for something, the chat, or an app that has no view
          for visitors yet. Titled for what they were doing, with no line
          under the title (the landing's sheets have none); signing in lands
          back on the project's page.
      */}
      {intent ? (
        <SignInSheet
          open
          title={intentTitle(intent, (id, params) => t(id, params))}
          providers={providers}
          native={nativeSignIn}
          phoneLink={phoneSignIn}
          askName={false}
          from="signin"
          returnTo={`/${projectHash(intent.app.slug)}`}
          resume={resume}
          onClose={closeIntent}
          primaryClass={PRIMARY_PILL}
        />
      ) : null}
      {storyOn ? (
        <SignInSheet
          open={!gate && !intent && (sheet === 'start' || sheet === 'signin')}
          title={sheet === 'signin' ? t('auth:landing.sheet.signIn') : t('auth:landing.sheet.continue')}
          providers={providers}
          native={nativeSignIn}
          phone={phoneSignIn && sheet === 'start' && signUpWith === 'phone'}
          phoneLink={phoneSignIn}
          askName={false}
          start={sheet === 'start' ? signUpWith : null}
          from={sheet === 'signin' ? 'signin' : 'story'}
          returnTo={guestProject ? `/${projectHash(guestProject.slug)}` : '/'}
          resume={resume}
          releaseToken={sheet === 'start' ? release?.token ?? null : null}
          releaseSignIn={sheet === 'start' && !releaseUsed ? release?.signIn ?? null : null}
          linkUsed={sheet === 'start' && releaseUsed}
          onAccount={sheet === 'start' && release?.route === 'signup' ? toWelcome : undefined}
          beforeFinish={startedFromStory}
          onClose={closeSheet}
          primaryClass={PRIMARY_PILL}
          onSigningIn={setSigningIn}
          held={signingInShown}
        />
      ) : null}
      {/*
          The full-page Welcome for a "You're in" link's new account
          (./welcome-page.tsx), over the story and in the sheet's place.
          Rendered nothing until there is one, like the two below it.
      */}
      {welcome ? <WelcomePage account={welcome} beforeFinish={startedFromStory} /> : null}
      {signingInShown ? <SigningIn /> : null}
        </>
      ) : null}
    </main>
  );
}
