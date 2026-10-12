/**
 * Should this visitor be offered the native app, and where does it send them?
 *
 * The whole decision is ONE pure function taking an explicit environment,
 * rather than a component reading `navigator` and `window` as it renders.
 * Every rule below is a suppression — a reason NOT to show an unsolicited
 * strip over someone's screen — and a suppression that only exists inside a
 * component is a suppression nobody can test. `install-banner.tsx` samples the
 * browser once and hands the result here.
 */

export type MobileOs = 'ios' | 'android';

/** The payload of `GET /api/public/mobile-app`. */
export interface StoreUrls {
  ios: string | null;
  android: string | null;
}

export interface InstallEnv {
  ua: string;
  /** `navigator.maxTouchPoints`. The only thing that identifies an iPad. */
  maxTouchPoints: number;
  /** Inside the Homeroom native app (the `usernode` bridge is present). */
  native: boolean;
  /** Already installed — launched from a home-screen icon, not a tab. */
  standalone: boolean;
  /**
   * Signed in with platform access: somebody who is already in Homeroom
   * (lib/platform-viewer.ts). False on the signed-out landing, an invite
   * link's page before Join, the sign-in page and the waiting room.
   */
  member: boolean;
  /**
   * A first-session tour is on screen (../first-session/tour-running.ts):
   * its cards and its spotlight are the screen while it runs (#4899).
   */
  touring: boolean;
  dismissed: boolean;
  /** `null` until the fetch resolves. */
  urls: StoreUrls | null;
}

/**
 * What the strip should offer this visitor.
 *
 * Two kinds, because there are two ways onto a phone's home screen and only
 * one of them needs anybody to have published anything (#1513):
 *
 *   `store` — a real listing exists for this OS. Unchanged behaviour: the
 *             strip links out to it.
 *   `a2hs`  — no listing does, so the offer is the PWA the platform already
 *             ships. `public/manifest.webmanifest` and the service worker
 *             have been there all along; nothing about "add to home screen"
 *             was waiting on an App Store review.
 *
 * Before this, no listing meant no offer at all: `installOffer` returned null
 * and the strip stayed inert markup. That was right when the strip could only
 * say "get the app on the App Store", and wrong once you notice the app is
 * already installable.
 */
export type InstallOffer =
  | { kind: 'store'; os: MobileOs; url: string }
  | { kind: 'a2hs'; os: MobileOs };

/**
 * The strip's line for each platform's store, when the URL says nothing more:
 * a message id whose text is the whole line ("Get the app on the App Store").
 */
export const STORE_LABEL: Record<MobileOs, string> = {
  ios: 'agent:install.banner.getOnAppStore',
  android: 'agent:install.banner.getOnGooglePlay',
};

/**
 * What the strip should CALL the destination.
 *
 * Not simply `STORE_LABEL[os]`, because the URL is not always a store. The
 * value published for iOS today is a `testflight.apple.com` invite — a beta,
 * not an App Store listing — and a strip that said "Get the app on the App
 * Store" while opening TestFlight would be telling the visitor something
 * untrue about what they are about to join.
 *
 * The host is the only thing that can answer this: `update_url` is one free
 * text field, and whoever fills it in is not asked which kind of link it is.
 * Anything unrecognised falls back to the platform's store name.
 */
export function storeLabel(os: MobileOs, url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return STORE_LABEL[os];
  }
  if (host === 'testflight.apple.com') return 'agent:install.banner.getOnTestFlight';
  if (host === 'apps.apple.com' || host === 'itunes.apple.com') return 'agent:install.banner.getOnAppStore';
  if (host === 'play.google.com') return 'agent:install.banner.getOnGooglePlay';
  return STORE_LABEL[os];
}

/**
 * Which mobile OS is this, if any?
 *
 * iPadOS 13+ is the whole reason this takes `maxTouchPoints`: it ships the
 * desktop Safari user-agent string verbatim, `Macintosh` included, so a UA
 * test alone reads every iPad as a laptop. A Mac has no touch points; an iPad
 * has five. Chrome on a Windows touchscreen would pass that second test, which
 * is why it is an AND against `Macintosh` rather than a check on its own.
 */
export function detectMobileOs(ua: string, maxTouchPoints: number): MobileOs | null {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios';
  return null;
}

/**
 * `update_url` is admin-supplied free text that this banner renders straight
 * into an `href`, so the scheme is checked rather than trusted: a
 * `javascript:` value pasted into the App version form would otherwise become
 * a scripted link on every mobile page of the platform.
 *
 * Only `http(s)` passes. That does exclude the `itms-apps://` deep link an
 * operator might reach for — deliberately: the `https://apps.apple.com/…`
 * form opens the App Store app on a device anyway, and works as a real link
 * everywhere else.
 */
function safeStoreUrl(raw: string | null | undefined): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return value;
  } catch {
    return null;
  }
}

export function installOffer(env: InstallEnv): InstallOffer | null {
  // Already here. Offering someone the app they are reading this in is the
  // one unambiguous bug this feature can ship.
  if (env.native) return null;
  // Already installed something — a home-screen launch is not a browser tab.
  if (env.standalone) return null;
  // #4204: not before somebody is in. On an invite's page the strip asked a
  // stranger to put Homeroom on their home screen before they knew what they
  // were invited to, and sat above the one action that matters there: Join.
  // It is offered once they are signed in and let in, wherever they land.
  if (!env.member) return null;
  // #4899: nor while the first-session tour is on screen. Right after a first
  // app was made the strip came up on Home and stayed pinned at the top
  // through the whole tour, on Home and inside the app: the strip, a tour
  // card and the app, three layers at once. It is held rather than
  // dismissed, so it comes up as the tour ends (its last card or Skip), and
  // on the next visit when this one ends mid-tour.
  if (env.touring) return null;
  if (env.dismissed) return null;
  if (!env.urls) return null;

  const os = detectMobileOs(env.ua, env.maxTouchPoints);
  if (!os) return null;

  // Per-OS, because the two listings go live independently: an Android
  // visitor must not be shown a control that goes nowhere while only the iOS
  // listing exists.
  const url = safeStoreUrl(env.urls[os]);
  // #1513: no listing for THIS OS is not "nothing to offer" any more. The
  // platform is an installable PWA on both, so the fallback is the home-screen
  // install rather than an empty strip.
  if (!url) return { kind: 'a2hs', os };
  // #1515: a BETA is not "the app". `update_url` is one free-text field that
  // feeds both the native update gate and this strip, and the value published
  // for iOS today is a TestFlight invite. The update gate is right to follow
  // it: it is talking to somebody who already installed that build. This strip
  // is talking to a stranger, and sending them to "join a beta, install
  // TestFlight first, accept an invite" under a button that says Get is a
  // different offer from the one it appears to make.
  //
  // Since #1513 the answer here is the home-screen install rather than
  // nothing, which is the better one: a stranger who cannot be sent to a
  // public listing still gets a real way to install, and it is the path that
  // works on this platform today.
  //
  // The same host test `storeLabel` uses, so the strip cannot end up naming a
  // destination it has decided not to offer.
  if (isBetaInvite(url)) return { kind: 'a2hs', os };

  return { kind: 'store', os, url };
}

/**
 * How you add this to a home screen, per OS.
 *
 * Instructions rather than a prompt, deliberately. iOS Safari exposes no
 * install API at all — Share, then Add to Home Screen, is the only path there
 * is — and Android's `beforeinstallprompt` fires only when Chrome decides it
 * should, so a control wired to it is a control that is sometimes missing.
 * Telling somebody where the menu item is works on both, every time.
 */
export const A2HS_STEPS: Record<MobileOs, string> = {
  ios: 'agent:install.sentence.ios',
  android: 'agent:install.sentence.android',
};

/** One numbered line of the banner's "How" sheet, with the glyph it names. */
export interface A2hsStep {
  text: string;
  /** The toolbar control the line tells you to tap, drawn beside it. */
  glyph?: 'share' | 'menu';
}

/**
 * The same instructions as `A2HS_STEPS`, one line per step, for the install
 * banner's "How" sheet (#4400). The sentence form stays for the app's About
 * pane, which has one line to spend; the sheet has room to number them and to
 * show the control the first step names.
 */
export const A2HS_STEP_LIST: Record<MobileOs, readonly A2hsStep[]> = {
  ios: [
    { text: 'agent:install.ios.step1', glyph: 'share' },
    { text: 'agent:install.ios.step2' },
    { text: 'agent:install.ios.step3' },
  ],
  android: [
    { text: 'agent:install.android.step1', glyph: 'menu' },
    { text: 'agent:install.android.step2' },
    { text: 'agent:install.android.step3' },
  ],
};

/**
 * Is this a beta invite rather than a public store listing?
 *
 * Only TestFlight today, and deliberately a HOST test rather than a guess at
 * the shape of a URL: an unrecognised host is somebody's real store listing on
 * a domain this function has not heard of, and refusing it would hide a
 * working offer. A beta we can name is the only thing worth suppressing.
 */
export function isBetaInvite(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'testflight.apple.com';
  } catch {
    return false;
  }
}
