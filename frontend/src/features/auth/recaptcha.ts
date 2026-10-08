/**
 * The reCAPTCHA a phone code request answers first. Firebase texts a code
 * for a web caller only with an app-verification token
 * (services/firebase-phone-auth.js, RECAPTCHA_REFUSALS): the answer to a
 * reCAPTCHA whose site key is the Firebase project's own, which the server
 * reads for us (GET /api/auth/phone/recaptcha). It is what Firebase's own
 * web SDK does, without the SDK: an invisible widget, executed once per
 * request, its token handed to POST /api/auth/phone/request.
 *
 * Google's script cannot be vendored (it is the check), so it is the one
 * thing the shell loads from another origin, and only here: on the first
 * code request of a phone sign-in, never on boot (the shell's head stays
 * same-origin, tests/pwa-shell-wiring.test.js). The service worker passes
 * it through (public/sw.js, 'bypass').
 *
 * The badge is not shown (`badge: 'inline'` in a see-through box); the
 * sheet carries the notice Google asks for in its place (RECAPTCHA_LINE).
 * A challenge, when Google wants one, draws over the page on its own.
 *
 * Never throws: anything that goes wrong is a null token, the request goes
 * without one, and the server answers recaptcha_required, which the sheet
 * says in words.
 */

const SCRIPT_SRC = 'https://www.google.com/recaptcha/api.js?render=explicit';
const LOAD_TIMEOUT_MS = 15 * 1000;
const ANSWER_TIMEOUT_MS = 2 * 60 * 1000;

type Widget = {
  render(container: HTMLElement, params: Record<string, unknown>): number;
  execute(id: number): void;
  reset(id: number): void;
  ready?(cb: () => void): void;
};

type RecaptchaWindow = Window & { grecaptcha?: Widget };

let scriptLoad: Promise<Widget | null> | null = null;
let siteKeyRead: Promise<string | null> | null = null;

function loadScript(): Promise<Widget | null> {
  const w = window as RecaptchaWindow;
  if (w.grecaptcha?.render) return Promise.resolve(w.grecaptcha);
  if (scriptLoad) return scriptLoad;
  scriptLoad = new Promise<Widget | null>((resolve) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      const g = (window as RecaptchaWindow).grecaptcha;
      if (!g) { window.clearTimeout(timer); resolve(null); return; }
      const done = () => { window.clearTimeout(timer); resolve(g); };
      if (typeof g.ready === 'function') g.ready(done); else done();
    };
    script.onerror = () => { window.clearTimeout(timer); resolve(null); };
    document.head.appendChild(script);
  }).then((g) => {
    // A failed load is tried again on the next request.
    if (!g) scriptLoad = null;
    return g;
  });
  return scriptLoad;
}

function readSiteKey(): Promise<string | null> {
  if (siteKeyRead) return siteKeyRead;
  siteKeyRead = fetch('/api/auth/phone/recaptcha', { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (typeof data?.siteKey === 'string' && data.siteKey ? data.siteKey : null))
    .catch(() => null)
    .then((key) => {
      if (!key) siteKeyRead = null;
      return key;
    });
  return siteKeyRead;
}

let widget: { id: number; resolve: ((token: string | null) => void) | null } | null = null;

/** A fresh reCAPTCHA token for one phone code request, or null. */
export async function phoneRecaptchaToken(): Promise<string | null> {
  try {
    // Both start at once; with no site key (a server with test numbers
    // only, services/firebase-phone-auth.js) the request goes now, without
    // waiting on Google's script.
    const script = loadScript();
    const siteKey = await readSiteKey();
    if (!siteKey) return null;
    const g = await script;
    if (!g) return null;
    if (!widget) {
      const box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      box.dataset.phoneRecaptcha = '';
      // On screen and see-through, not off it: a challenge is placed by the
      // widget's own box, so one off-screen could be asked off-screen too.
      box.style.cssText = 'position:fixed;left:50%;top:40%;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(box);
      const slot: { id: number; resolve: ((token: string | null) => void) | null } = { id: -1, resolve: null };
      const answer = (token: string | null) => { const r = slot.resolve; slot.resolve = null; r?.(token); };
      slot.id = g.render(box, {
        sitekey: siteKey,
        size: 'invisible',
        badge: 'inline',
        callback: (token: unknown) => answer(typeof token === 'string' && token ? token : null),
        'expired-callback': () => answer(null),
        'error-callback': () => answer(null),
      });
      widget = slot;
    }
    const slot = widget;
    return await new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => { slot.resolve = null; resolve(null); }, ANSWER_TIMEOUT_MS);
      slot.resolve = (token) => { window.clearTimeout(timer); resolve(token); };
      try {
        g.reset(slot.id);
        g.execute(slot.id);
      } catch {
        slot.resolve = null;
        window.clearTimeout(timer);
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * The short line the sign-in sheet's phone steps and the waiting room's
 * add-phone card carry under their button, where the badge is hidden:
 * "Protected by reCAPTCHA · Google Privacy · Terms", the two words linked
 * to Google's pages (RecaptchaLine in ./waitlist-shared.tsx, #4379).
 */
export const RECAPTCHA_LINE = {
  lead: 'Protected by reCAPTCHA · Google ',
  privacy: { label: 'Privacy', href: 'https://policies.google.com/privacy' },
  sep: ' · ',
  terms: { label: 'Terms', href: 'https://policies.google.com/terms' },
} as const;

/** Google's own wording for a page that hides the badge (the admin SMS console's test send). */
export const RECAPTCHA_NOTICE = {
  lead: 'This is protected by reCAPTCHA, and Google’s ',
  privacy: { label: 'Privacy Policy', href: 'https://policies.google.com/privacy' },
  and: ' and ',
  terms: { label: 'Terms of Service', href: 'https://policies.google.com/terms' },
  tail: ' apply.',
} as const;
