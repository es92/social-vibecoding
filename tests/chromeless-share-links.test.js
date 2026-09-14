// Tests for the chromeless share-link flow (/app/<slug>/full).
//
// Direct visits to an app's own subdomain used to dead-end on the app
// container's 401 ("Not authenticated") because the iframe token only
// exists inside the platform shell. The fix spans four layers; the edge
// gate's redirect is covered behaviorally in tests/edge-gate.test.js.
// This file guards the other three plus the shell wiring:
//   1. The scaffold template's generated server.js redirects
//      unauthenticated top-level document navigations to the platform's
//      chromeless view (real generated output, not source grep).
//   2. The auth flow preserves the URL fragment end-to-end. The old
//      standalone login/register pages are redirect stubs into the SPA's
//      hash routes (fold-auth-pages-into-SPA): each stub forwards an
//      incoming fragment verbatim, the SPA's anonymous boot remembers a
//      non-auth hash as a deep link and offers login first, and the
//      reload-free finishLogin restores it before the authed boot.
//   3. The shell (public/js/app.js + index.html) understands the
//      /app/<slug>/full route: source guards in the style of
//      tests/cc-progress-summary.test.js so the hash routing, the
//      chrome toggling, and the pill can't silently become dead code.
//   4. The Caddyfile's wildcard site carries the 401-interception
//      redirect ({applink} map output + handle_response).
//
// Run with: node --test tests/chromeless-share-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getTemplateFiles } = require('../src/services/template.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. Scaffold template ────────────────────────────────────────────────

test('scaffold server.js redirects unauthenticated document navigations to the chromeless view', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.ok(
    server.includes("req.get('sec-fetch-dest') === 'document'"),
    'gates the redirect on Sec-Fetch-Dest: document'
  );
  // Via PLATFORM_ORIGIN rather than an inlined literal: the origin is read
  // from the injected USERNODE_PLATFORM_ORIGIN at runtime (falling back to
  // the value baked in at scaffold time), so the link follows the platform
  // when its domain moves instead of pointing at where it used to be.
  assert.match(
    server,
    /res\.redirect\(302, PLATFORM_ORIGIN \+ '\/app\/demo-app-abc123\/full' \+ deepPath\)/,
    'redirects to the platform chromeless deep link for this slug, carrying the inner path'
  );
  // The redirect must live INSIDE the unauthenticated branch, before the
  // landing-page fallback (iframe loads must keep getting the 401 page,
  // never a redirect that would nest the shell inside its own iframe).
  const unauthBranch = server.indexOf('if (!req.user) {');
  const redirect = server.indexOf("req.get('sec-fetch-dest')");
  const landing = server.indexOf('Open this app inside Homeroom');
  assert.ok(unauthBranch !== -1 && unauthBranch < redirect && redirect < landing,
    'redirect sits between the auth check and the landing-page fallback');
});

test('scaffold server.js encodes ?path= from req.originalUrl behind the character gate (#743)', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.ok(server.includes("'?path=' + encodeURIComponent(req.originalUrl)"),
    'forwards the visited path+query as one clean-route query value');
  // The gate keeps the value attribute-safe for the landing anchor and
  // relative-only (leading /, no quotes/angle brackets/backslash/space).
  assert.ok(server.includes('/^\\/[A-Za-z0-9\\-._~!$&()*+,;=:@\\/%?]*$/.test(req.originalUrl)'),
    'character allowlist gates the deep path');
  const deepPath = server.indexOf('const deepPath =');
  const unauthBranch = server.indexOf('if (!req.user) {');
  const redirect = server.indexOf("req.get('sec-fetch-dest')");
  assert.ok(unauthBranch < deepPath && deepPath < redirect,
    'deepPath is computed inside the unauthenticated branch, before the redirect');
  // The generated code must be valid JS (the regex survives the
  // template-literal escaping in src/services/template.js).
  assert.doesNotThrow(() => new Function(server), 'generated server.js parses');
});

test('scaffold landing page deep-links to the app, not the bare platform origin', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.match(server, /href="\$\{PLATFORM_ORIGIN\}\/app\/demo-app-abc123\/full\$\{deepPath\}"/,
    'landing anchor carries the gated deep path too, on the runtime origin');
});

// ── 2. Auth-flow fragment preservation (stubs + in-SPA login) ───────────

test('login.html stub forwards an incoming fragment into the SPA', () => {
  const src = read('public/login.html');
  // The stub prefers the deep-link fragment over its default #login route
  // (a share link that bounced through /login.html keeps its target).
  assert.ok(src.includes("var deepLink = location.hash && location.hash !== '#' ? location.hash : '';"),
    'stub captures the incoming fragment');
  assert.ok(src.includes("location.replace('/' + search + (deepLink || route));"),
    'stub redirect carries the fragment (and remaining query) through');
});

test('register.html stub forwards an incoming fragment into the SPA', () => {
  const src = read('public/register.html');
  assert.ok(src.includes("var deepLink = location.hash && location.hash !== '#' ? location.hash : '';"),
    'stub captures the incoming fragment');
  assert.ok(src.includes("location.replace('/' + (deepLink || route));"),
    'stub redirect carries the fragment through');
});

test('the anonymous SPA boot remembers either clean or legacy app deep links', () => {
  const src = read('public/js/app.js');
  // restoreFromHash's anonymous branch: a non-auth route (e.g.
  // /app/<slug>/full) is stored for after login, then the login screen
  // shows — parity with the old server redirect to login.html.
  assert.ok(src.includes('AuthScreens.rememberDeepLink(App._deepLinkTarget());'),
    'anonymous branch stores the deep link');
  assert.ok(src.includes("AuthScreens.show('login');"),
    'anonymous branch then shows the login screen');
});

test('finishLogin restores the pending deep link before the authed boot', () => {
  const src = read('public/js/auth-screens.js');
  assert.ok(src.includes('const target = AuthScreens._pendingHash || \'\';'),
    'finishLogin reads the pending deep link');
  assert.ok(src.includes("history.replaceState(null, '', AuthScreens.deepLinkUrl(target));"),
    'finishLogin restores it onto the URL so restoreFromHash lands there');
});

// ── 3. Shell wiring (source guards) ─────────────────────────────────────

test('app.js routes /app/<slug>/full onto the App tab in chromeless mode', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("const chromeless = tab === 'full';"),
    'restoreFromHash recognizes the full segment');
  assert.ok(src.includes('App.setChromeless(chromeless);'),
    'restoreFromHash applies the mode on app routes');
  assert.ok(src.includes('App.setChromeless(false)'),
    'non-app routes clear the mode');
});

test('app.js round-trips the clean chromeless path, inner path included', () => {
  const src = read('public/js/app.js');
  assert.match(src, /if \(opts\.chromeless\) \{[\s\S]{0,80}suffix = '\/full'/,
    'the serializer emits /full while chromeless');
  assert.ok(src.includes('opts.chromeless ? opts.innerPath : null'),
    'the serializer re-emits the encoded ?path deep link');
});

// ── 5. Inner-path pass-through (#743) ────────────────────────────────────

test('app.js splits the fragment-query off before segment routing', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("const qIdx = rawHash.indexOf('?');"),
    'restoreFromHash finds the fragment-query boundary');
  // `let`, not `const`: the authed branch of the anonymous-shell routing
  // clears a stale auth hash in place (fold-auth-pages-into-SPA).
  assert.match(src, /let hash = rawHash[\s\S]{0,100}: pathRoute;/,
    'routes on a query-stripped hash, falling back to the clean pathname');
  // The value is everything after the first path= (final-param contract,
  // so an inner query string survives raw & / = / ?).
  assert.ok(src.includes('fragQuery.match(/(?:^|&)path=(.*)$/)'),
    'path value is the raw tail of the fragment query');
  assert.ok(src.includes('if (chromeless && fragQuery) {'),
    'the fragment-query is honored on the chromeless route only');
});

test('app.js validates the inner path (relative-only, attribute-safe, capped)', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes('_validateInnerPath(p)'), 'validator exists');
  assert.ok(src.includes("if (!path.startsWith('/') || path.startsWith('//')) return null;"),
    'relative-only: leading /, never protocol-relative //');
  assert.ok(src.includes('/[\\s\\\\`\'"<>]/.test(path)'),
    'rejects whitespace, backslash, backtick, quotes and angle brackets');
  assert.ok(src.includes('path.length > 512'), 'length cap matches TESTING_PATH_MAX');
  assert.ok(src.includes('/[\\x00-\\x1f\\x7f]/.test(path)'), 'rejects control characters');
});

test('app-view.js builds the iframe src via the URL API with origin check and token clobbering', () => {
  const src = read('public/js/app-view.js');
  assert.ok(src.includes('buildAppIframeSrc()'), 'shared builder exists');
  assert.ok(src.includes("new URL(AppView.pendingInnerPath || '/', appUrl)"),
    'inner path composes against the app origin; no path → root (backward compat)');
  assert.ok(src.includes('if (url.origin !== new URL(appUrl).origin) url = new URL(appUrl);'),
    'a path that escapes the app origin falls back to the root');
  assert.ok(src.includes("url.searchParams.set('token', token)"),
    'token is set via searchParams so a smuggled ?token= is clobbered');
  // Tokens are per-app since the RSA cutover: the builder must read the
  // cached token through tokenForSlug, which returns null unless the
  // cached token was minted for the app now being framed. Otherwise a
  // stale token for the previously-open app rides along and the child
  // rejects it on audience.
  assert.ok(src.includes("const token = AppView.tokenForSlug(AppView.appData && AppView.appData.slug);"),
    'builder reads the token through the per-app slug guard');
  assert.ok(src.includes('const iframeSrc = AppView.buildAppIframeSrc();'),
    'renderAppTab uses the shared builder');
  // The 45-min token refresh must reuse it too, so a mid-session refresh
  // does not yank the viewer back to the app root. Since #1085 chunk H the
  // refresh reaches the frame through the app-frame seam (which mutates the
  // live element's src rather than re-rendering it) instead of a
  // getElementById + assignment, but it must still compose through the
  // builder — and the builder must be the only source of that url.
  assert.ok(src.includes('frame.setSrc(AppView.buildAppIframeSrc());'),
    'token refresh reuses the shared builder');
  assert.ok(!/\.src\s*=\s*(?!AppView\.buildAppIframeSrc)[^;\n]*token/.test(src),
    'no other code path assigns a token-bearing src to the app iframe');
  assert.ok(!src.includes('?token=${AppView.iframeToken}'),
    'no string-concat token src remains for the production iframe');
  assert.ok(src.includes('AppView.pendingInnerPath = null;'),
    'close() clears the stored inner path');
});

test('app.js screen identity handles both clean paths and legacy hashes', () => {
  const src = read('public/js/app.js');
  assert.match(src, /parsed\.hash[\s\S]{0,120}parsed\.pathname/,
    'screenIdOf prefers a legacy hash and otherwise parses the clean pathname');
  assert.ok(src.includes('(chromeless && innerPath !== prevInnerPath)'),
    'a chromeless hash with a different inner path forces a re-render');
});

test('app.js setChromeless toggles the header and the pill', () => {
  const src = read('public/js/app.js');
  const pill = read('frontend/src/features/header/chromeless-pill.tsx');
  const header = read('frontend/src/features/header/platform-header.tsx');
  // #1079 chunk B: #platform-header is a React island and the pill is a
  // component beside it, so setChromeless PUBLISHES both flags through the
  // shell's visibility store instead of writing the DOM — a classList toggle
  // from outside React is exactly what that store exists to replace. The two
  // subscribers produce the same DOM the imperative version did.
  assert.ok(src.includes("App.Visibility.publish('platform-header', !enable)"),
    'the header hide must go through the visibility store');
  assert.ok(src.includes("App.Visibility.publish('chromeless-pill', enable)"),
    'and so must the pill');
  assert.ok(header.includes("useVisibility('platform-header', true)"),
    'the header island subscribes, defaulting to the visible markup it ships');
  assert.ok(header.includes('useHiddenClass(headerRef, !visible)'),
    'and applies it imperatively — PlatformUI.attachScreenFx writes to this '
    + 'element, so a rendered className would clobber the kit');
  assert.ok(pill.includes("useVisibility('chromeless-pill', false)"),
    'the pill subscribes, defaulting to absent — the shipped markup has none');
  // The App/Dev switch needs no line of its own: it lives inside
  // #platform-header now (it used to be the separate #app-tabs bar), so
  // hiding the header hides it too.
  assert.ok(!src.includes("document.getElementById('app-tabs')"),
    'setChromeless still reaches for the deleted tab bar');
  // #970: the bottom safe-area inset needs no line of its own EITHER any
  // more. It used to: #app-view carried `un-safe-bottom` for every surface,
  // so chromeless had to strip the class to render edge-to-edge. The inset
  // is now surface-dependent (`data-app-surface`, set by
  // AppView._setSurface) and chromeless always lands on the app surface,
  // which reserves nothing. Re-adding the toggle would double-manage it.
  assert.ok(!src.includes("classList.toggle('un-safe-bottom'"),
    'setChromeless must not hand-manage the bottom inset any more (#970)');
  // Hiding/showing the header changes #app-view's rect, so the per-frame
  // insets forwarded into the app have to be recomputed.
  assert.ok(src.includes('AppView.scheduleSafeAreaBroadcast()'),
    'toggling chromeless must re-broadcast the frame safe-area insets');
  // The pill renders nothing at all until the flag flips — that is what keeps
  // the prerendered markup and the first hydrating render identical.
  assert.ok(pill.includes('if (!chromeless) return null;'));
  assert.ok(pill.includes("id=\"chromeless-pill\""));
  assert.ok(pill.includes("aria-label=\"Open this app on Homeroom\""));
  // The pill's exit target is the regular App-tab view, which clears the
  // mode via restoreFromHash. The slug is read at CLICK time, so the pill
  // survives app-to-app navigation without a remount.
  assert.ok(pill.includes('const slug = window.App?.currentApp;'));
  assert.ok(pill.includes("window.App?.openAppTab?.(slug, 'app');"));
  const openAppTab = src.slice(src.indexOf('openAppTab(slug, tab, opts) {'));
  assert.match(openAppTab.slice(0, 700), /App\.setChromeless\(false\)/,
    'the ordinary App target clears chromeless mode before serializing its URL');
});

test('index.html carries the ids setChromeless toggles', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="platform-header"'));
  assert.ok(html.includes('id="app-view"'));
});

test('an expired session boots the anonymous shell in place — no login.html redirect', () => {
  const src = read('public/js/app.js');
  // fold-auth-pages-into-SPA: a 401 (or offline failure) on /api/auth/me
  // boots the anonymous shell in the same document. The deep-link hash is
  // untouched by that path, and restoreFromHash's anonymous branch
  // remembers it (covered above) — so the fragment still survives.
  assert.ok(src.includes('App.enterAnonymous();'),
    'App.init boots the anonymous shell on 401/offline');
  assert.ok(!src.includes("window.location.href = '/login.html'"),
    'no redirect to the old standalone login page remains in app.js');
});

// ── 4. Caddyfile 401 interception ───────────────────────────────────────

test('Caddyfile maps production hosts to a chromeless {applink} and intercepts 401s', () => {
  const caddy = read('Caddyfile');
  assert.ok(caddy.includes('map {host} {upstream} {applink}'),
    'map emits the applink output');
  assert.ok(caddy.includes('"https://{$USERNODE_DOMAIN}/#app/${1}/full"'),
    'production rows deep-link to the chromeless view');
  assert.match(caddy, /@unauth status 401/, 'response matcher on upstream 401');
  assert.match(caddy, /handle_response @unauth/, '401s route through handle_response');
  assert.match(caddy, /header Sec-Fetch-Dest document/, 'only document navigations redirect');
  assert.match(caddy, /not vars \{applink\} ""/, 'staging/default rows are excluded');
  assert.match(caddy, /redir @chromeless \{applink\}\?path=\{uri\} 302/,
    'redirects to the applink carrying the original request URI as the final ?path= param');
  assert.match(caddy, /copy_response/, 'non-matching 401s pass through verbatim');
});
