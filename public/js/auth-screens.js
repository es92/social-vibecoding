// Anonymous-shell screens (fold-auth-pages-into-SPA).
//
// Landing / login / register / waiting used to be standalone documents
// (landing.html, login.html, register.html, waiting.html). They are now
// in-SPA screens over the same document as the authed shell, which buys:
//   - kit push/pop transitions between them (PlatformUI.transition) —
//     no full page loads while navigating the anonymous side;
//   - a RELOAD-FREE login: on success we refetch /api/auth/me and call
//     App.enterAuthed(user) in place (see app.js staged boot), which also
//     establishes the native realm in one protocol-2 transaction without
//     the old navigate-to-'/' round trip;
//   - one document for the service worker's offline fallback.
//
// Hash routes: #landing, #login, #signup (login screen with the
// email-code sub-view open — otp/verify is the account-creation path),
// #register[/<code>], #waiting, #waitlist?confirm=1 (check your waitlist
// status; a bare #waitlist opens Continue instead, #5261). app.js's
// restoreFromHash owns the routing and calls AuthScreens.show(); this
// module owns the screens.
//
// The old documents remain as thin redirect stubs so bookmarks, old
// share links, and SW-cached copies keep working.
(function () {
  'use strict';

  const SCREEN_IDS = {
    landing: 'auth-landing-screen',
    login: 'auth-login-screen',
    // Sub-view of the login screen. #signup/<address> carries a url-encoded
    // email address from the waitlist-release email.
    signup: 'auth-login-screen',
    register: 'auth-register-screen',
    waiting: 'auth-waiting-screen',
    // Check your waitlist status, #waitlist?confirm=1: an address that
    // joined (on the marketing site, or before #5261 here) asks for a code
    // and reads back where it stands. The join form this screen also held
    // is retired (#5261): a bare #waitlist opens Continue
    // (retireWaitlistLink below), which makes the account and puts it in
    // line.
    waitlist: 'auth-waitlist-screen',
    // Stage-2 waitlist survey ("Want in sooner?"), #more/<token> — the
    // token is the signup's capability from the join response / email.
    more: 'auth-more-screen',
    // Emailed password-reset magic link, #reset-password/<token> — a
    // sub-view of the login screen, like signup. The view itself is
    // mounted on demand rather than prerendered (frozen-markup contract;
    // see features/auth/login.tsx).
    'reset-password': 'auth-login-screen',
  };

  // Drives push (deeper) vs pop (back toward landing) transition types.
  // landing → waitlist → more is a real chain now, so `more` sits a level
  // below the stage-1 screen it is offered from.
  const DEPTH = {
    landing: 0, login: 1, signup: 1, register: 1, waiting: 1, waitlist: 1,
    more: 2, 'reset-password': 1,
  };

  const ROUTES = Object.keys(SCREEN_IDS);

  // The pages a `?return_to=` may send somebody to once they have signed in.
  //
  // Matched on the PATHNAME, never on the whole string. The MCP consent
  // request IS its query string — client id, redirect uri, PKCE challenge,
  // state — so an exact-string allowlist could not carry it, which is how
  // that flow ended up smuggling its return target in a fragment nothing
  // reads. The pathname is still the thing that decides the destination, so
  // the open-redirect property is unchanged.
  const RETURN_TO_PATHS = [
    '/cli/authorize', '/connect/authorize',
    '/api/me/social-identities/github/connect',
    '/api/me/social-identities/x/connect',
    // Back to the app a guest was looking around (P15): the app-host
    // authorize hop (services/edge-gate.js) signs them in there and returns
    // them to the same page. It only ever redirects to an app host it can
    // parse, never anywhere a query names.
    '/__access/authorize',
  ];

  // Screen transitions come from the platform's native kit via the
  // PlatformUI seam; when the kit failed to load the mutation just runs
  // without animation.
  function fx(fn, type) {
    if (window.PlatformUI) window.PlatformUI.transition(fn, { type });
    else fn();
  }

  // Same seam, but forwarding the full zoom opts (el / fromEl / outEl /
  // fallback / after). Zoom callers split their mutation into fn (reveal
  // the incoming screen) + after (conceal the outgoing one), so the
  // no-kit path has to run BOTH halves.
  function zoomFx(fn, opts) {
    if (window.PlatformUI) window.PlatformUI.transition(fn, opts);
    else {
      fn();
      if (opts && typeof opts.after === 'function') opts.after();
    }
  }

  function byId(id) { return document.getElementById(id); }

  // The React seam (#1078). Screen roots convert one chunk at a time, and
  // once React owns one, a classList write from out here is reconciled
  // away on its next render — so hand the decision to App, which knows
  // which ids have crossed over. `App` is a script-global (not on
  // window), and this file loads before app.js, so the guard is a typeof
  // check and the fallback is the pre-seam behaviour.
  function setScreenVisible(id, visible) {
    if (typeof App !== 'undefined' && App._setScreenVisible) {
      App._setScreenVisible(id, visible);
      return;
    }
    const el = byId(id);
    if (el) el.classList.toggle('hidden', !visible);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError(el) { el.classList.add('hidden'); }

  // Every credential exchange on these screens is a server round trip, so
  // offline they can only fail. app.js's boot comment claimed for a long
  // time that "the login screen refuses submits while offline" — it did
  // not, and the user got a bare "Network error" that read like a wrong
  // password (#1021). Guard first, and say what's actually wrong.
  //
  // The check is Offline's probe result, not navigator.onLine: the flag
  // false-positives behind captive portals, which is exactly where a
  // submit would hang. When it says nothing is wrong we let the request
  // go — an unguarded real failure still falls back to its own catch.
  function blockedOffline(errorEl) {
    let offline = false;
    try { offline = !!(window.Offline && Offline.isOffline()); } catch (_) { offline = false; }
    if (!offline) return false;
    if (errorEl) {
      showError(errorEl, PlatformI18n.t('auth:offline.signIn'));
    }
    try { window.Offline.nudge(); } catch (_) { /* ignore */ }
    return true;
  }

  const AuthScreens = {
    _current: null,       // route name currently shown, or null
    // Deep-link target an anonymous visitor arrived with. Legacy links store
    // a fragment (`#app/...`); clean app links store their pathname
    // (`/app/...`). Restored right before the authed boot so the router lands
    // on the exact app instead of the platform home.
    _pendingHash: '',
    // A shared link opened with no session (#5264): the address, for the
    // landing to take as it shows (features/auth/landing.tsx), which opens
    // the sign-in sheet titled for where it leads. Read once.
    _deepLinkSignIn: '',
    // The token of an invite link an account still waiting opened, kept by
    // showWaiting for the waiting room (features/auth/waiting.tsx).
    _waitingInvite: '',
    // An old #waitlist link (#5261): the landing opens its Continue sheet
    // on show (takeStartSheet in features/auth/shared.ts).
    _startSheet: false,
    // What a waitlist "you're in" mail's link asked for, `{ route, token }`,
    // kept by enter() for the landing to take on show (takeReleaseLink in
    // features/auth/shared.ts), which opens the sign-in sheet over the story.
    _releaseLink: null,
    _wired: {},           // per-screen one-shot wiring markers
    _waitingTimer: null,

    // ── Routing helpers (consumed by App.restoreFromHash) ────────────

    // First path segment → route name, or null when the hash isn't an
    // auth route.
    routeFromHash(hash) {
      const seg = String(hash || '').split('/')[0];
      return ROUTES.includes(seg) ? seg : null;
    },

    rememberDeepLink(fullHash) {
      if (!fullHash) return;
      if (AuthScreens.routeFromHash(fullHash.replace('#', ''))) return;
      AuthScreens._pendingHash = fullHash;
    },

    // A deep link with no session (App.restoreFromHash): remembered for
    // after the sign-in, and answered with the landing's sign-in sheet,
    // titled for the place the link names, instead of the full-page form.
    showSignInFor(fullHash) {
      AuthScreens.rememberDeepLink(fullHash);
      AuthScreens._deepLinkSignIn = AuthScreens._pendingHash || '';
      AuthScreens.show('landing');
    },

    // Discover or a project's page for an account still on the waitlist
    // (App.restoreFromHash): the landing's guest pages, signed in, with no
    // sheet. Remembered as well, for the day it is let in.
    showGuestPagesFor(fullHash) {
      AuthScreens.rememberDeepLink(fullHash);
      AuthScreens._deepLinkSignIn = fullHash || '';
      AuthScreens.show('landing');
    },

    // A `return_to` value this platform will actually navigate to, or ''.
    //
    // Resolved against this origin and then matched by pathname, so an
    // allowed page keeps the query string it was asked for while an absolute
    // URL, a scheme like javascript:, and a traversal that climbs out are all
    // refused rather than becoming an open redirect. What refuses an OFF-SITE
    // target is the ORIGIN comparison plus a pathname match taken from the
    // parsed `url` — never from the raw string.
    //
    // The two shape tests do something narrower and are still load-bearing:
    // dropping `raw.startsWith('//')` changes outcomes, because a
    // protocol-relative value naming THIS host ('//usernode.example/…')
    // resolves same-origin onto an allowed path and would then be accepted.
    // That would not escape anywhere — it lands on the same page the plain
    // path does — but the accepted spelling is deliberately just one shape,
    // a plain absolute path, so a reader is never left comparing two.
    //
    // The fragment is dropped, and NOT because it is a security boundary —
    // saying so would be false and would invite somebody to defend the wrong
    // line. Neither allowed page needs one forwarded: connect-authorize.js
    // never reads location.hash at all, and cli-authorize.js carries its
    // launch code across a sign-in in sessionStorage rather than in the URL
    // it returns to. (That card is reachable anyway from the
    // `verification_uri_complete` link the server itself mints, so nothing
    // here stands between anyone and it.) Forwarding a fragment would add a
    // value nothing reads, so this returns one shape and only one.
    returnToUrl(value) {
      const raw = String(value || '');
      if (!raw.startsWith('/') || raw.startsWith('//')) return '';
      let url;
      try {
        url = new URL(raw, window.location.origin);
      } catch (_) { return ''; }
      if (url.origin !== window.location.origin) return '';
      if (!RETURN_TO_PATHS.includes(url.pathname)) return '';
      return url.pathname + url.search;
    },

    deepLinkUrl(target) {
      const value = String(target || '');
      if (value.startsWith('/app/')) return value;
      // An invite link a visitor signed in from (App.restoreFromHash
      // remembers it): back to it, so it is followed as the new session.
      if (/^\/invite\/[A-Za-z0-9_-]{22}$/.test(value)) return value;
      // A fragment link keeps the address's query, the way every other
      // screen change does (App._rootUrl): a shared demo link is
      // `/?demo=1#app/<slug>/board`, and without its `?demo=1` the screen it
      // names has no demo in it, or falls back to Home (#4789).
      const root = typeof App !== 'undefined' ? App._rootUrl : null;
      if (value.startsWith('#')) return typeof root === 'function' ? root(value) : '/' + value;
      return typeof root === 'function' ? root('') : '/';
    },

    // Anonymous boot entry (App.enterAnonymous). Routing lives in
    // restoreFromHash — its anonymous branch calls back into show().
    enter() {
      // Pre-SPA link forms: /?signup=1 (the old landing CTA target) and
      // /?login=1. Honor one once, then let the hash own everything.
      //
      // #1545: these are the shapes EMAIL links use now. A fragment is
      // client-side only, so a desktop mail client's link rewriter can drop
      // `#signup` while rebuilding the URL and deliver a bare `/` — which is
      // the home page, and exactly what the access-ready mail was reported
      // doing on desktop while working from a phone. A query survives that.
      //
      // First match wins, and the query comes off the address, so whichever
      // spelling arrives the address bar ends up identical.
      //
      // `?status=1` is the check-my-status mail's one button (#1538). It
      // resolves to the code-entry step of the waitlist screen, which is a
      // hash ROUTE plus a hash QUERY. The state stays in the fragment for
      // the same reason it always has: a query would put it in server logs.
      //
      // `?signup=1[&t=<token>]` and `?login=1` are the waitlist's "you're
      // in" mail (sendWaitlistReleaseMail), and they no longer go to the
      // sign-in screen. They open the STORY, the screen everybody else
      // starts on (features/auth/landing.tsx takes this on show): for an
      // account that is still new, the landing spends the one-time sign-in
      // as it opens ("Signing you in…", then the Welcome page), once a read
      // that spends nothing says so; for one already set up, its Get started
      // opens the sheet, which spends it then, or fills in the address the
      // token names and sends the code; for one that exists, the Sign in
      // sheet is open over it. So the address goes back to `/`, the
      // landing's own, and the link waits on this object rather than in it,
      // which also keeps the token out of the address bar. With the story
      // switched off the landing hands it on to `#signup` / `#login`, as
      // before.
      try {
        if (!location.hash) {
          const params = new URLSearchParams(location.search);
          const route = params.has('signup') ? 'signup'
            : params.has('login') ? 'login'
              : params.has('status') ? 'waitlist?confirm=1'
                : null;
          if (route === 'signup' || route === 'login') {
            const t = params.get('t');
            // #4594: `key` is the mail's one-time sign-in link. Kept here,
            // never spent on this GET: the landing or its sheet spends it
            // with a POST.
            const key = params.get('key');
            AuthScreens._releaseLink = {
              route,
              token: route === 'signup' && t && /^[A-Za-z0-9_-]{8,128}$/.test(t) ? t : null,
              signIn: route === 'signup' && key && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null,
            };
            history.replaceState(null, '', '/');
          } else if (route) history.replaceState(null, '', `/#${route}`);
        }
      } catch (_) {}
      if (window.App) App.restoreFromHash();
    },

    // An old `#waitlist?ref=<code>` link's referral code (#5261). The join
    // form that sent it with a join is retired, so it is kept for this tab
    // until the waiting room, right after the account is made, sends it on
    // (features/auth/waiting-about.tsx). The fragment's own query, so it
    // never reached a server log, and it does not now.
    keepWaitlistRef(query) {
      try {
        const ref = new URLSearchParams(String(query || '')).get('ref');
        if (ref && /^[a-z0-9]{10}$/.test(ref)) sessionStorage.setItem('usernode:waitlist-ref', ref);
      } catch (_) { /* the link still opens Continue, without the code */ }
    },

    // A bare #waitlist, from a bookmark or a link minted before #5261, for a
    // visitor with no session: the join form it named is retired, so it
    // opens the landing with Continue up, which makes the account and puts
    // it in line. The address becomes the landing's own, so Back and a
    // reload do not come round to it again.
    retireWaitlistLink(query) {
      AuthScreens.keepWaitlistRef(query);
      AuthScreens._startSheet = true;
      try {
        const root = window.App?._rootUrl?.('') || '/';
        history.replaceState(null, '', root);
      } catch (_) { /* ignore */ }
      AuthScreens.show('landing');
    },

    // Waiting-room entry (App.enterAuthed with hasPlatformAccess=false).
    showWaiting() {
      // An invite link opened by an account still waiting: the address is
      // about to become /#waiting, so its token is kept for the waiting room,
      // which follows it (features/auth/waiting.tsx) and clears this.
      const invite = /^\/invite\/([A-Za-z0-9_-]{22})$/.exec(location.pathname);
      if (invite) AuthScreens._waitingInvite = invite[1];
      if (AuthScreens.routeFromHash(location.hash.replace('#', '')) !== 'waiting') {
        const target = window.App?._rootUrl?.('#waiting') || '#waiting';
        history.replaceState(null, '', target);
      }
      AuthScreens.show('waiting');
    },

    // ── Screen switching ─────────────────────────────────────────────

    show(route, seg) {
      const id = SCREEN_IDS[route];
      if (!id) return;
      // The screen's interior is not in the prerendered document: the
      // island mounts it on first reveal (lib/mount-on-reveal.ts). Everything
      // below — _wireScreen, the on-show hook, setScreenVisible — was written
      // against markup that was always there, so ask for it first. The bridge
      // mounts it inside flushSync and returns with the nodes in place and
      // the screen's React half already patched onto this object.
      AuthScreens._ensureMounted(id);
      AuthScreens._wireScreen(route);

      const prev = AuthScreens._current;
      const sameScreen = prev && SCREEN_IDS[prev] === id;

      // Per-route side effects run even when the screen element is
      // already up (e.g. login ↔ signup share one screen).
      if (route === 'landing') AuthScreens._landingOnShow();
      // seg is `forgot` on #login/forgot, the recovery view's own address
      // (QA 2026-09-24 Q16), so Back from it lands on Sign in.
      if (route === 'login') AuthScreens._loginOnShow(false, seg);
      // seg is the url-encoded email address from a waitlist-release link
      // (#signup/<address>); the login island prefills it and asks for a code.
      if (route === 'signup') AuthScreens._loginOnShow(true, seg);
      if (route === 'reset-password') AuthScreens._resetOnShow(seg);
      if (route === 'register') AuthScreens._registerOnShow(seg);
      if (route === 'waiting') AuthScreens._waitingOnShow();
      if (route === 'waitlist') AuthScreens._waitlistOnShow();
      if (route === 'more') AuthScreens._moreOnShow(seg);
      if (prev === 'waiting' && route !== 'waiting') AuthScreens._stopWaitingPoll();
      // Leaving the landing screen with an app still open: stop the
      // iframe and put the directory back, un-animated.
      if (prev === 'landing' && route !== 'landing') AuthScreens._resetLandingViewer();

      if (sameScreen || prev === route) {
        AuthScreens._current = route;
        return;
      }

      const type = prev == null
        ? 'none'
        : (DEPTH[route] > DEPTH[prev] ? 'push'
          : DEPTH[route] < DEPTH[prev] ? 'pop' : 'none');

      // BEFORE the transition, not after it. `prev`, `sameScreen` and `type`
      // are all resolved above, so nothing below still needs the old value —
      // and App._syncPlatformTabs reads this to decide whether the platform's
      // tab bar belongs on screen, from inside the callback. `fx` runs that
      // callback synchronously on the no-animation path and a task later on
      // the animated one; an assignment after the call is correct for one of
      // those and a frame late for the other.
      AuthScreens._current = route;
      fx(() => {
        window.UsernodeBrowserScroll?.capture();
        for (const r of Object.keys(SCREEN_IDS)) {
          setScreenVisible(SCREEN_IDS[r], SCREEN_IDS[r] === id);
        }
        // The platform's tab bar has nothing to tab to from here, so it goes
        // with the rest of the authed shell. In the callback because the kit
        // captures the incoming page from what the callback did before it
        // returned — the same rule App._showOnlyScreen states for the header.
        window.App?._syncPlatformTabs?.();
      }, type);
    },

    // See show(). Reached by name — this file is a classic script, and
    // tests load it as one — and a no-op wherever the bridge is absent (a
    // document without the React entry, a `vm` harness).
    _ensureMounted(id) {
      try {
        window.UsernodeReact?.mount?.ensure?.(id);
      } catch (err) { /* ignore */ }
    },

    hideAll() {
      AuthScreens._stopWaitingPoll();
      AuthScreens._resetLandingViewer();
      for (const r of Object.keys(SCREEN_IDS)) setScreenVisible(SCREEN_IDS[r], false);
      AuthScreens._current = null;
      // The authed shell is back, so the tab bar's decision changes — but
      // WHETHER it comes back is App's to say, not this file's: the viewer
      // may be landing straight into an app or a chromeless route. Cleared
      // `_current` first, for the reason show() gives.
      window.App?._syncPlatformTabs?.();
    },

    _wireScreen(route) {
      const id = SCREEN_IDS[route];
      if (AuthScreens._wired[id]) return;
      AuthScreens._wired[id] = true;
      if (id === 'auth-landing-screen') AuthScreens._wireLanding();
      if (id === 'auth-login-screen') AuthScreens._wireLogin();
      if (id === 'auth-register-screen') AuthScreens._wireRegister();
      if (id === 'auth-waiting-screen') AuthScreens._wireWaiting();
      if (id === 'auth-waitlist-screen') AuthScreens._wireWaitlist();
      if (id === 'auth-more-screen') AuthScreens._wireMore();
    },

    // ── Reload-free login completion ─────────────────────────────────
    //
    // Called after ANY successful credential exchange (password form,
    // OTP set-password, wallet verify, activation-code register).
    // Confirm the session before navigating. Failure stays on the form and
    // returns a fixed diagnostic result to its React owner; retrying this
    // method never sends credentials or mints another session.
    //
    // `opts.beforeShell` runs once the session is confirmed and this page is
    // staying on its build, just before the signed-in shell starts: the
    // sign-in sheet's hand-off to "What do you want to make?"
    // (features/auth/sign-in-sheet.tsx). The sheet stays up, busy, through
    // the session read and leaves only then, so the make screen, drawn in
    // the tick the shell starts, follows it with no wait between (#4892:
    // leaving first showed a blank page for as long as the read took).
    //
    // `opts.stillWanted` is for a completion nobody asked for in this
    // moment: the boot's second session read (App._adoptLateSession), which
    // runs in the background behind the anonymous shell. It is asked once
    // the read has answered, before this changes the address or starts the
    // shell, and once it answers false this stops without touching
    // anything: a sign-in the viewer started meanwhile owns the page, and
    // an older read must not send it somewhere else. Such a completion
    // never waits again after that check: it does not move to the live
    // build, has no `beforeShell`, and enters the shell without the screen
    // transition (`enter` below), so everything it changes happens in the
    // same tick as the check.
    async finishLogin(opts) {
      const beforeShell = opts && typeof opts.beforeShell === 'function' ? opts.beforeShell : null;
      const stillWanted = opts && typeof opts.stillWanted === 'function' ? opts.stillWanted : null;
      const superseded = () => !!stillWanted && !stillWanted();
      // A background completion enters the shell WITHOUT the screen
      // transition. The kit's transition runs its callback later (a view
      // transition on desktop), and a sign-in the viewer begins in that gap
      // would find the shell entered under it and its deep link already
      // spent. Run in the same tick as the check above, the address, the
      // pending deep link and the shell change together or not at all.
      const enter = (fn, type) => (stillWanted ? fn() : fx(fn, type));
      let returnTo = '';
      // The login-return targets accepted by the platform. Both are separate
      // documents by design — real navigation stays.
      try {
        const params = new URLSearchParams(location.search);
        const values = params.getAll('return_to');
        if (values.length === 1 &&
            [...params.keys()].every((k) => k === 'return_to')) {
          const target = AuthScreens.returnToUrl(values[0]);
          if (target) {
            returnTo = target;
          }
        }
      } catch (_) {}

      // Drop any offline session snapshot left by whoever used this
      // device last (#1021). enterAuthed writes a fresh one below; until
      // it does, a stale snapshot for a DIFFERENT account must not be
      // sitting there ready for the next offline boot to paint.
      try { window.App?.clearSessionSnapshot?.(); } catch (_) {}

      // Asked alongside the session check below rather than after it: is
      // this page behind the live build (App._moveToLiveShell)? Nothing to
      // ask when the sign-in returns to another document.
      // Not asked for a background completion (`stillWanted`, below), which
      // never moves the page: its signed-out boot already asked to move.
      const liveShell = !returnTo && !stillWanted && typeof App !== 'undefined'
        && typeof App._askLiveBuild === 'function' ? App._askLiveBuild() : null;

      let stage = 'session-check';
      let status = null;
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 12000);
      try {
        const res = await fetch('/api/auth/me', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        status = res.status;
        if (!res.ok) {
          return { stage, status, code: status === 401 || status === 403
            ? 'session-rejected' : 'server-response' };
        }
        stage = 'session-response';
        const data = await res.json();
        const user = data && data.user;
        if (!user || typeof user !== 'object' || !user.id) {
          return { stage, status, code: 'invalid-response' };
        }
        stage = 'open-session';
        if (superseded()) return null;

        if (returnTo) {
          window.location.href = returnTo;
          return null;
        }

        if (user.hasPlatformAccess === false) {
          // Gated account: the waiting room takes over (enterAuthed
          // routes there); keep the deep link pending for the release.
          // The waiting room moves to the live build when it lets them in
          // (features/auth/waiting.tsx), before the signed-in shell starts.
          enter(() => App.enterAuthed(user), 'push');
          return null;
        }

        const target = AuthScreens._pendingHash || '';
        history.replaceState(null, '', AuthScreens.deepLinkUrl(target));
        // Signed in on a build that is behind the live one: move to it now,
        // before the signed-in shell starts, so no first-run screen is drawn
        // by the old build. The reload lands on the address just restored.
        // It never resolves once it reloads, so the sign-in stays busy until
        // the page goes.
        //
        // The session this read just confirmed is kept for that reload first.
        // The new page then starts from it (App.init's snapshot boot) and
        // draws its first screen, "What do you want to make?" for a new
        // account, in the tick it starts. Without it the reload waited on
        // /api/auth/me and painted Home, then the landing, before the make
        // screen. enterAuthed writes the same snapshot when nothing reloads.
        //
        // A background completion (`stillWanted`) does not move: the boot's
        // signed-out move already asked, and a reload that lands while the
        // viewer has begun a sign-in of their own would take the page from
        // under it.
        if (!stillWanted && typeof App !== 'undefined' && typeof App._moveToLiveShell === 'function') {
          try { App.saveSessionSnapshot?.(user); } catch (_) {}
          await App._moveToLiveShell('signed-in', liveShell);
        }
        // Staying: the sheet goes now (see above), and the shell starts once
        // it has gone. A hand-off that fails must not keep anyone out.
        if (beforeShell) {
          try { await beforeShell(); } catch (_) { /* the shell starts all the same */ }
        }
        enter(() => {
          App.enterAuthed(user);
        }, 'pop');
        AuthScreens._pendingHash = '';
        return null;
      } catch (e) {
        // Never include exception messages or response bodies: either may
        // carry personal data. The UI explains this bounded category.
        return { stage, status, code: timedOut ? 'timeout'
          : stage === 'session-check' ? 'network-error'
            : stage === 'session-response' ? 'invalid-response' : 'client-error' };
      } finally {
        clearTimeout(timer);
      }
    },

    // ── Landing ──────────────────────────────────────────────────────
    //
    // #1080 chunk C: the landing screen is a React component now
    // (frontend/src/features/auth/landing.tsx). It patches the entry points
    // below onto this object at hydration — before DOMContentLoaded, i.e.
    // before show() can call any of them — so the router above needs no
    // knowledge of which half is live. The no-ops are what the prerender
    // pass and a kit-less boot see.
    _wireLanding() {},
    _landingOnShow() {},
    _renderLandingHeader() {},
    _resetLandingViewer() {},
    _openLandingApp() {},
    _closeLandingApp() {},
    _loadLandingApps() {},
    _landingTileFor() { return null; },
    _swapViewerFrame() { return null; },


    // ── Waitlist status check and survey ─────────────────────────────
    //
    // #1080 chunk C: both screens are React now. Check your status is
    // frontend/src/features/auth/waitlist.tsx and stage 2 ("Want in sooner?",
    // #more/<token>) is frontend/src/features/auth/more.tsx. They share the
    // memoised GET /api/public/waitlist/options fetch and the chip / select
    // helpers, which moved with them into
    // frontend/src/features/auth/waitlist-shared.tsx.
    _wireWaitlist() {},
    _waitlistOnShow() {},
    _wireMore() {},
    _moreOnShow() {},

    // ── Login (+ signup / OTP + recovery + wallet fast path) ─────────
    //
    // #1080 chunk C: the login screen is a React component now
    // (frontend/src/features/auth/login.tsx), and it owns all four views on
    // that screen element — the password form, the #signup email-code
    // sub-view, the forgot-password recovery sub-view and the
    // #reset-password/<token> redeem view — plus the wallet fast path and
    // the two runtime-built blocks _ensureResetUi used to inject. It patches
    // the entry points below onto this object at hydration, before
    // DOMContentLoaded and therefore before show() can call any of them.
    _wireLogin() {},
    _loginOnShow() {},
    _showLoginBaseView() {},
    _showOtpView() {},
    _resetOnShow() {},
    _walletDetect() {},

    // ── Register (activation-code flow) ──────────────────────────────
    //
    // #1080 chunk C: React (frontend/src/features/auth/register.tsx). It
    // patches the entry points below at hydration, before DOMContentLoaded.
    _wireRegister() {},
    _registerOnShow() {},

    // ── Waiting room (platform-access gate) ──────────────────────────
    //
    // #1080 chunk C: React (frontend/src/features/auth/waiting.tsx). The
    // release poll is the screen's, but its lifecycle is the router's —
    // show() stops it when navigating away from `waiting` and hideAll()
    // stops it on the way into the authed shell — so _startWaitingPoll and
    // _stopWaitingPoll stay part of the patched surface.
    _wireWaiting() {},
    _waitingOnShow() {},
    _startWaitingPoll() {},
    _stopWaitingPoll() {},
  };

  // Corner back links on the login/register screens → landing.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-auth-back]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = '#landing';
      });
    });
  });

  // Coming back online used to be handled here: a `usernode:offline-change`
  // listener cleared the stale "you're offline" message from every
  // credential screen's error slot, since the CSS re-enables the controls
  // and nothing else would say the message no longer applied. Every one of
  // those slots — login, otp, wallet, register — now belongs to a React
  // screen that owns its own listener (#1080 chunk C), so there is nothing
  // left out here to clear.

  window.AuthScreens = AuthScreens;
})();
