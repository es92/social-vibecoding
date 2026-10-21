// Source pins for the landing page's persistent header + its two ways in:
//   - the bar is the wordmark over the back disc and carries no CTA; the
//     wordmark gives way to the open app's name, which is why #app-viewer
//     needs no bar of its own,
//   - the ways in are two pills in the body: "Join the waitlist" to the
//     MARKETING site (target="_blank", so the native shell hands it to the
//     bridge) and "Sign in" to #login, with one text line for somebody who
//     already joined,
//   - the marketing URL comes from the server and no host is written into
//     the frontend; until it arrives the pill is inert rather than pointed
//     at the in-app #waitlist form this screen stopped sending people to,
//   - a signed-in but not-yet-admitted visitor sees neither pill: their
//     action area is one pill back to the waiting room,
//   - #app-viewer is an in-flow flex sibling of the scroller and opens /
//     closes with the kit zoom transition (with the outEl the flex-sibling
//     measurement pitfall requires),
//   - ?shot=anon-back drives the viewer through the opener, not through a
//     rendered tile, because there is no longer a directory grid,
//   - the directory is still FETCHED (the shot picks its target from it and
//     pull-to-refresh re-runs it) but renders nothing,
//   - LandingTile survives as the gated-launch contract: gated apps dim,
//     badge a lock, and route taps to #signup with the deep link remembered,
//   - the shell probe is wired at boot and its columns exist in schema,
//   - staging seeds one open + one gated app so both branches exist.
//
// These are content pins (same style as tests/chromeless-share-links
// .test.js): they hold the contract in place so a refactor that silently
// drops a piece fails loudly here.
//
// Run with: node --test tests/landing-directory.test.js

const test = require('node:test');
const { interiorHtmlFor } = require('./lib/lazy-interiors');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');
const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The landing screen crossed over to React in #1080 chunk C, so the pins that
// used to read public/js/auth-screens.js read the component instead. Same
// contracts, same behaviour — a different file owns them.
const LANDING_TSX = 'frontend/src/features/auth/landing.tsx';
const WAITLIST_TSX = 'frontend/src/features/auth/waitlist.tsx';

// ─── index.html: persistent header ────────────────────────────────

test('the landing\'s ways in: no anchor in the bar, and the guest bar\'s Sign in and Sign up are buttons', () => {
  const html = shellMarkup();
  const header = html.match(/<header id="landing-header"[\s\S]*?<\/header>/);
  assert.ok(header, 'landing-header exists');
  // The bar used to hold two anchors, at 28px, in the top-right corner, read
  // at the moment a stranger knows least about the product, and the
  // waitlist landing's moved into its body. The guest Discover's bar carries
  // Sign in and Sign up again, as buttons at the row's height on the
  // column's right edge (tests/header-height-parity.test.js), the one place
  // each appears on the screen.
  assert.doesNotMatch(header[0], /<a[\s>]/, 'no CTA anchor in the landing bar');

  const interior = interiorHtmlFor('auth-landing-screen');
  // The waitlist landing: one pill to the waitlist, one to sign-in, and
  // nothing else. It is still drawn, hidden, for when the first session's
  // story is switched off (services/first-session.js).
  assert.match(interior, /id="landing-waitlist-link"/);
  assert.match(interior, /<a href="#login"/);
  assert.doesNotMatch(interior, /Create account/);
  // The story is the default, and the bar's Sign up is the way to make an
  // account from here: a button that opens the sheet with every way in
  // (Apple, Google, email, a phone). The waitlist landing still defers it,
  // and nothing links to #signup.
  assert.equal((interior.match(/href="#signup"/g) || []).length, 0);
  assert.match(header[0], /<button[^>]*data-landing-sign-up=""[^>]*>Sign up<\/button>/);
  // The in-app survey is not one of them any more. #landing-status-link is
  // the exception and keeps its own href — see the check-my-status test.
  const pills = interior.slice(interior.indexOf('id="landing-waitlist-link"'));
  assert.doesNotMatch(pills, /href="#waitlist"/, 'the join pill leaves the app entirely');
});

test('the landing header is a persistent, non-scrolling sibling of the scroller', () => {
  const html = shellMarkup();
  const header = html.match(/id="landing-header"[^>]*class="([^"]*)"/);
  assert.ok(header, 'landing-header exists');
  // shrink-0 keeps the header out of the flex free-space split, so the
  // scroller (and, when open, the app viewer) take the remaining height.
  assert.match(header[1], /shrink-0/);
  // Notch/status-bar handling, same as the authed #platform-header.
  assert.match(header[1], /un-safe-top-extend/);
  // The overlay is a column so header + body stack instead of overlapping.
  const overlay = html.match(/id="auth-landing-screen"[^>]*class="([^"]*)"/);
  assert.ok(overlay, 'landing overlay exists');
  assert.match(overlay[1], /flex flex-col/);
  // Back + title live in the header, NOT in a viewer-owned bar: the header
  // is what stays put while an app is open.
  assert.match(html, /id="landing-back-btn"/);
  assert.match(html, /id="landing-header-title"/);
  assert.doesNotMatch(html, /id="app-viewer-back"/);
  assert.doesNotMatch(html, /id="app-viewer-title"/);
});

test('the bar swaps the wordmark for the open app\'s name, or a project page\'s, and nothing else', () => {
  const tsx = read(LANDING_TSX);
  // Back and the label are the only two things an open app touches. The
  // label is what makes #app-viewer need no bar of its own: the header stays
  // put and owns Back + the app's name for as long as the viewer runs. A
  // public project's guest page (features/guest) takes the same two: Back to
  // Discover, and the project's name.
  const back = tsx.slice(tsx.indexOf('id="landing-back-btn"'));
  assert.match(back.slice(0, 400), /hiddenLast\(\s*\n?\s*!showBack/,
    'the back button is what an open app or a project page toggles');
  // Discover opened from the story inside the Homeroom app takes a back too
  // (to the story), and keeps the wordmark.
  assert.match(tsx, /const showBack = !!openApp \|\| !!guestProject \|\| appDiscover;/);
  assert.match(tsx, /const headerTitle = openApp \? openApp\.name \|\| openApp\.slug : guestProject \? guestProject\.name : LANDING_TITLE;/);
  assert.match(tsx, /\{openApp \|\| guestProject \? headerTitle : <Wordmark/,
    'the mark gives way to the app name — it never draws over it');
  // The element's class string does NOT move with that swap: it is the same
  // box either way, and a conditional className would rewrite the attribute
  // on every open and close.
  const title = tsx.slice(tsx.indexOf('id="landing-header-title"'));
  assert.match(title.slice(0, 300), /className="[^"]*"/,
    '#landing-header-title keeps a constant className across the swap');
  // The action area is toggled by SESSION state, never by the viewer: a
  // visitor can join or sign in without backing out of an open app.
  assert.match(tsx, /className=\{hiddenLast\(session, 'flex flex-col gap-2\.5'\)\}/,
    'the anonymous pills are toggled by session state');
  assert.match(tsx, /id="landing-back-to-waiting"[\s\S]{0,200}hiddenLast\(!session/,
    'and the waiting-room pill by its inverse');
  // AppBar mirroring for the Flutter WebView.
  assert.match(tsx, /document\.title = headerTitle/);
});

// ─── the landing CTA area vs the #waitlist screen ─────────────────

test('the landing body is eyebrow + heading + sentence + two pills, no card', () => {
  const interior = interiorHtmlFor('auth-landing-screen');
  // The pitch card is gone: 67 words of explanation in a tinted box above a
  // grid of mostly-locked tiles. What is left is one heading and one line.
  assert.doesNotMatch(interior, /id="landing-waitlist"[^-]/, 'the pitch card is retired');
  assert.match(interior, /Opening gradually/, 'the eyebrow');
  assert.match(interior, /Come build the next version with us\./, 'the heading');
  // No survey on this screen — it never was, and it is not coming back by
  // way of the pill, which now leaves the app entirely.
  assert.doesNotMatch(interior, /<form/);
  assert.doesNotMatch(interior, /id="waitlist-email"/);
  // The stacked pills are 10px apart and full width; the primary is the
  // shell's own 48px accent pill and the secondary its white 44px one.
  const pill = interior.slice(interior.indexOf('id="landing-waitlist-link"'));
  assert.match(pill.slice(0, 400), /\bbg-violet-600\b/, 'the primary is the accent pill');
  assert.match(pill.slice(0, 400), /\bw-full\b/);
  assert.match(pill, /<a href="#login"[^>]*class="[^"]*\bh-11\b[^"]*\bbg-white\b/,
    'the secondary is the white 44px pill the sign-in screen draws');
  assert.match(interior, /class="flex flex-col gap-2\.5"/, '10px between stacked pills');
});

test('the check-my-status line sits under the pills, unchanged (#1538)', () => {
  const interior = interiorHtmlFor('auth-landing-screen');
  // It moved out of the retired card and kept everything about itself: same
  // id, same href into the code-entry step, same words, same offline gate.
  const link = interior.slice(interior.indexOf('id="landing-status-link"'));
  assert.match(link.slice(0, 300), /href="#waitlist\?confirm=1"/);
  assert.match(link.slice(0, 300), /data-offline-disabled/);
  assert.match(link.slice(0, 400), /Check your status/);
  assert.match(interior, /Already joined\? /);
  // It is the waitlist landing's, which shows only when the first session's
  // story is switched off (services/first-session.js); the story is the
  // default, so the declared check that used to select on this link now
  // selects on the bar's Sign up, whose sheet signs an existing account in
  // too (#5251), and its one Sign in.
  const manifest = JSON.parse(read('dapp.json'));
  assert.ok(
    manifest.tests.some((t) => /:has\(#landing-header button\[data-landing-sign-up\]\)/.test(t.expectSelector || '')),
    'the declared check reads the story\'s one way in',
  );
});

// A local named after one of this file's own imports shadows it for the whole
// component, and the call site that still wants the IMPORT then gets the local.
// That is not hypothetical: `const waitlistOptions = useWaitlistOptions()` once
// shadowed the memoised `waitlistOptions` fetch this file imports, so
// landingOnShow's `void waitlistOptions()` called an object. It threw inside
// AuthScreens.show(), which aborted before revealing the screen, and every
// declared check on #landing failed against a root that stayed hidden. No unit
// test caught it, because none of them runs the on-show hook in a browser, and
// tsc did not either.
test('no local in the landing shadows one of its own imports', () => {
  const tsx = read(LANDING_TSX);
  const imported = new Set();
  for (const m of tsx.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'[^']+';/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/\btype\b/, '').split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  }
  assert.ok(imported.size > 5, 'the import scan found nothing, so it is not checking anything');
  const shadowed = [...imported].filter((name) =>
    new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(tsx));
  assert.deepEqual(shadowed, [],
    'a declaration reuses an imported name; every call to that name inside the '
    + 'component then resolves to the local, which is how the landing stopped '
    + 'being revealed at all');
});

test('the join pill is the marketing URL, from the server, opened externally', () => {
  const tsx = read(LANDING_TSX);
  // NO HOST IN THE FRONTEND. The URL is platform configuration
  // (MARKETING_BASE_URL), so a literal here would be a second copy of it,
  // silently wrong on every deployment that is not production.
  assert.doesNotMatch(tsx, /https?:\/\/[a-z0-9.-]*homeroom/i,
    'the marketing host is never written into this file');
  assert.match(tsx, /waitlist_url/, 'it is read off the public options payload');
  // ONE hook call, two readers. The property this pins is not the spelling but
  // the SOURCE: both marketing links come from useWaitlistOptions(), which
  // fetches in an effect, so neither is computed during render — a value read
  // at render time would differ between the prerender and the client and
  // console.error, and a console error on any route fails the proposal checks.
  assert.match(tsx, /const waitlistPayload = useWaitlistOptions\(\)/,
    '…through the hook, i.e. in an effect — never during render (hydration)');
  assert.match(tsx, /const waitlistUrl = marketingWaitlistUrl\(waitlistPayload\)/,
    'the join pill derives from that one call');
  assert.match(tsx, /const siteUrl = marketingSiteUrl\(waitlistPayload\)/,
    'and so does the Learn more line — same hook, same effect, same tick');

  // href, target and rel arrive TOGETHER or not at all. An anchor with no
  // href is inert, which is the right thing to be for the tick before the
  // options land; an href pointing at the in-app #waitlist form meanwhile
  // would undo the one change this screen makes.
  const pill = tsx.slice(tsx.indexOf('id="landing-waitlist-link"'));
  assert.match(pill.slice(0, 400), /href=\{waitlistUrl \|\| undefined\}/);
  assert.match(pill.slice(0, 400), /target=\{waitlistUrl \? '_blank' : undefined\}/);
  assert.match(pill.slice(0, 400), /rel=\{waitlistUrl \? 'noopener' : undefined\}/);
  // target="_blank" on a cross-origin URL is the whole of decision 6: the
  // shell's delegated capture listener hands it to the bridge's openExternal
  // and the system browser opens it, rather than the webview navigating off
  // the domain it is bound to.
  assert.match(read('public/js/nav-link.js'), /closest\('a\[target="_blank"\]'\)/);
  assert.match(read('public/js/nav-link.js'), /bridge\.openExternal\(url\.href\)/);

  // THE WAY OUT TO THE LONG VERSION. One sentence is all this screen carries,
  // so somebody still deciding is sent to the marketing site rather than given
  // a second paragraph. Same three rules as the pill above: no host in this
  // file, href/target/rel together or not at all, and hidden until the server
  // has named the host rather than rendered inert.
  assert.match(tsx, /marketing_url/, 'the site link is read off the same payload');
  assert.equal(message('auth:landing.learnMore'), 'Learn more about Homeroom');
  assert.ok(tsx.includes("{t('auth:landing.learnMore')}"));
  const learn = tsx.slice(tsx.indexOf("{t('auth:landing.learnMore')}") - 900);
  assert.match(learn.slice(0, 900), /href=\{siteUrl \|\| undefined\}/);
  assert.match(learn.slice(0, 900), /target=\{siteUrl \? '_blank' : undefined\}/);
  assert.match(learn.slice(0, 900), /rel=\{siteUrl \? 'noopener noreferrer' : undefined\}/);
  assert.match(learn.slice(0, 900), /hiddenLast\(!siteUrl,/,
    'no enabled-looking link with nowhere to go while the fetch is in flight');
  // It names its destination: link text is what a screen reader reads out of
  // context, and "here" names nothing.
  assert.doesNotMatch(tsx, /> *Learn more here *</, 'the link text names where it goes');
  // The server side of the same field.
  assert.match(read('src/routes/public-api.js'), /waitlist_url: waitlistUrl\(config\)/);
});

test('every anchor that leaves the landing tears the viewer down first', () => {
  const tsx = read(LANDING_TSX);
  // The viewer lives INSIDE this z-40 overlay, so a next screen would paint
  // over a still-running iframe. Nothing scrolls or focuses here any more.
  for (const anchor of ['id="landing-waitlist-link"', 'href="#login"',
    'id="landing-status-link"', 'id="landing-back-to-waiting"']) {
    const tag = tsx.slice(tsx.indexOf(anchor));
    assert.match(tag.slice(0, 600), /onClick=\{onLeaveCta\}/, `${anchor} leaves via onLeaveCta`);
  }
  assert.match(tsx, /const onLeaveCta[\s\S]{0,200}resetViewer\(\)/);
  assert.doesNotMatch(tsx, /scrollIntoView/);
});

test('a waiting-room session gets one pill back to the room, and no other', () => {
  const tsx = read(LANDING_TSX);
  const interior = interiorHtmlFor('auth-landing-screen');
  // A signed-in, not-yet-admitted visitor still reaches #landing (app.js
  // routes #waiting here when the session has no platform access). Both
  // anonymous pills are wrong for them — they have already joined the
  // waitlist and they are already signed in — so the action area swaps
  // wholesale rather than dimming one of them.
  assert.match(tsx, /id="landing-back-to-waiting"[\s\S]{0,300}href="#waiting"/,
    'the id the retired wrapper carried is on the anchor itself now');
  assert.match(tsx, /id="landing-back-to-waiting"[\s\S]{0,300}PRIMARY_PILL/,
    'and it is the same primary pill, so the screen has one action either way');
  // BOTH branches are rendered and toggled with `hidden`, never mounted
  // conditionally: the id inventory resolves these against this interior, and
  // an id that renders in only one session state reads to it as lost.
  assert.match(interior, /id="landing-back-to-waiting"[^>]*class="[^"]*\bhidden\b"/,
    'the waiting pill ships hidden for an anonymous visitor, not absent');
  assert.match(interior, /id="landing-waitlist-link"/,
    'and the anonymous pills ship for a session, hidden by their wrapper');
  // Nothing is left of the old pair it replaces.
  assert.doesNotMatch(interior, /id="landing-cta-queued"/);
  assert.doesNotMatch(interior, /id="landing-header-ctas"/);
});

test('#waitlist is check your status, with no join form (#5261)', () => {
  const html = shellMarkup();
  // <main> cannot nest, so the first close tag is this screen's. The
  // screen's interior mounts on first reveal, so the document carries only
  // its root; the interior is what a reveal puts inside it.
  const interior = interiorHtmlFor('auth-waitlist-screen');
  const classes = html.match(/id="auth-waitlist-screen"[^>]*class="([^"]*)"/);
  // Same overlay shape as the other anonymous screens (#more, #login).
  for (const cls of ['hidden', 'fixed', 'inset-0', 'z-40', 'overflow-y-auto']) {
    assert.match(classes[1], new RegExp(cls.replace('-', '\\-')), `screen is ${cls}`);
  }
  for (const id of ['waitlist-confirm-email', 'waitlist-request-code', 'waitlist-code',
    'waitlist-msg', 'waitlist-joined', 'waitlist-more-offer',
    'waitlist-more-link', 'waitlist-confirmed-email']) {
    assert.match(interior, new RegExp(`id="${id}"`), `${id} is on the screen`);
  }
  // The join form went (#5261): Continue makes the account and puts it in
  // line, and the waiting room asks the two optional questions.
  for (const id of ['waitlist-form', 'waitlist-email', 'waitlist-country',
    'waitlist-discovery-chips', 'waitlist-submit', 'waitlist-queued', 'waitlist-enter-code']) {
    assert.doesNotMatch(interior, new RegExp(`id="${id}"`), `${id} is retired`);
  }
  assert.doesNotMatch(interior, /<form/);
  // Back goes to the landing page via the shared delegated handler.
  assert.match(interior, /data-auth-back/);
  // NOT a <header>: the header-layout code used to measure document.querySelector
  // ('header') and must keep resolving to #platform-header.
  assert.doesNotMatch(interior, /<header/);
});

test('#waitlist is a registered route ordered under landing, above #more', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /waitlist: 'auth-waitlist-screen'/);
  const depth = js.match(/const DEPTH = \{[\s\S]*?\};/);
  assert.ok(depth, 'DEPTH map exists');
  // landing(0) → waitlist(1) → more(2): push in, pop back out.
  assert.match(depth[0], /landing: 0/);
  assert.match(depth[0], /waitlist: 1/);
  assert.match(depth[0], /more: 2/);
  // Per-show side effects + one-shot wiring are both dispatched.
  assert.match(js, /if \(route === 'waitlist'\) AuthScreens\._waitlistOnShow\(\);/);
  assert.match(js, /if \(id === 'auth-waitlist-screen'\) AuthScreens\._wireWaitlist\(\);/);
});

test('a bare #waitlist opens Continue, keeping an old link\'s ref (#5261)', () => {
  const js = read('public/js/app.js');
  // Signed out: the landing with its Continue sheet up.
  assert.match(js, /if \(authRoute === 'waitlist' && !\/\(\?:\^\|&\)confirm=1\(\?:&\|\$\)\/\.test\(fragQuery\)\) \{\s+AuthScreens\.retireWaitlistLink\(fragQuery\);\s+return;\s+\}/);
  // A waiting account goes to its room, which sends the ref on.
  const gated = js.match(/if \(App\.user\.hasPlatformAccess === false\) \{[\s\S]*?showWaiting\(\);/);
  assert.ok(gated, 'gated-session branch exists');
  assert.match(gated[0], /if \(authRoute === 'waitlist'\) AuthScreens\.keepWaitlistRef\(fragQuery\);/);
  assert.doesNotMatch(gated[0], /AuthScreens\.show\('waitlist'\)/);
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /retireWaitlistLink\(query\) \{\s+AuthScreens\.keepWaitlistRef\(query\);\s+AuthScreens\._startSheet = true;/);
  assert.match(screens, /if \(ref && \/\^\[a-z0-9\]\{10\}\$\/\.test\(ref\)\) sessionStorage\.setItem\('usernode:waitlist-ref', ref\);/);
  // The landing takes the flag on show and opens the story's sheet.
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /if \(takeStartSheet\(\) && !link\) \{\s+flushSync\(\(\) => \{ setResume\(null\); setSheet\('start'\); \}\);/);
  // AppBar mirroring for the Flutter WebView, same as the landing header.
  assert.match(read(WAITLIST_TSX), /document\.title = translate\('auth:waitlist\.documentTitle'\)/);
  assert.match(tsx, /id="landing-waitlist-link"/);
  assert.doesNotMatch(tsx, /waitlist-form/);
});

test('the anonymous screens are reachable to shots via ?shot=anon', () => {
  const js = read('public/js/app.js');
  // Captures carry a capture token, so the /me fetch would give them a full
  // session and restoreFromHash would strip the auth hash to home. The
  // override has to run BEFORE that fetch.
  const init = js.match(/async init\(\) \{[\s\S]*?\n  \},/);
  assert.ok(init, 'init exists');
  const shotAt = init[0].indexOf('_anonShot()');
  // The fetch itself moved into App._fetchSession when boot gained a
  // deadline (#1021); init calls it, and the ordering is what matters.
  const meAt = init[0].indexOf('_fetchSession()');
  assert.ok(shotAt > -1 && meAt > -1, 'both the shot check and the /me fetch are in init');
  assert.ok(shotAt < meAt, 'the shot override runs before the /me fetch');
  assert.match(js.match(/async _fetchWebSession\(\) \{[\s\S]*?\n  \},/)[0],
    /fetch\('\/api\/auth\/me'/);
  const fn = js.match(/_anonShot\(\) \{[\s\S]*?\n  \},/);
  assert.ok(fn, '_anonShot exists');
  assert.match(fn[0], /'anon'/);
  // The status read-back needs the same anonymous boot: it carries the
  // list place and the stage-2 offer. The join form's shots went with it
  // (#5261).
  assert.match(fn[0], /'waitlist-status'/);
  assert.doesNotMatch(fn[0], /'waitlist-joined'|'waitlist-confirmed'|'waitlist-rejoined'|'waitlist-step1'/);
  // Pure UI state: no env gate, and no request of its own.
  assert.doesNotMatch(fn[0], /USERNODE_ENV|fetch\(/);
  // The shots paint their state client-side: none POSTs.
  const tsx1 = read(WAITLIST_TSX);
  const shot = tsx1.match(/if \(shot === 'waitlist-code-entry'\) \{[\s\S]*?\n    if \(!shot\)/);
  assert.ok(shot, 'the waitlist shot branch exists');
  assert.doesNotMatch(shot[0], /fetch\(/);
  // The offer rides on `waitlist-status`, with no token, so the link keeps
  // the inert href.
  assert.match(shot[0], /'waitlist-status'\) \{[\s\S]*?setOffer\(true\)/);
  assert.doesNotMatch(shot[0], /setMoreToken/);
  // #1537: the settled states name the address, a stand-in literal.
  assert.match(shot[0], /setSentTo\('you@example\.com'\)/);
  assert.match(tsx1, /id="waitlist-more-offer"[\s\S]{0,200}hiddenFirst\(\s*!offer/);
});

test('both "you\'re on the list" surfaces name the registered address (#1537)', () => {
  // The join flow. The address is already client-side — the confirm step's
  // hint echoes it — so the panel reads the same `sentTo`, and no request was
  // added to say something the page already knew.
  const tsx = read(WAITLIST_TSX);
  const panel = tsx.match(/id="waitlist-confirmed-email"[\s\S]{0,400}?<\/p>/);
  assert.ok(panel, '#waitlist-confirmed-email exists');
  assert.match(panel[0], /<RichMessage id="auth:waitlist\.status\.registeredWith" values=\{\{ email: sentTo \}\}/);
  assert.equal(message('auth:waitlist.status.registeredWith', { email: 'a@b.co' }), 'Registered with <0>a@b.co</0>');
  // Hidden rather than conditionally rendered: the id is part of the shell's
  // inventory, and an empty "Registered with" reads as a bug.
  assert.match(panel[0], /hiddenFirst\(\s*!sentTo/);
  // Never a mailto: — the address is a fact being read back, not a control.
  assert.doesNotMatch(panel[0], /mailto:/);
  // Inside the settled panel, not floating beside it.
  const confirmed = tsx.match(/id="waitlist-confirmed"[\s\S]*?id="waitlist-more-offer"/);
  assert.ok(confirmed, 'the confirmed panel exists');
  assert.match(confirmed[0], /id="waitlist-confirmed-email"/);
  // Stored lower-cased, matching what the server normalizes, so this surface
  // and the stage-2 one cannot disagree about the same address.
  assert.match(tsx, /setSentTo\(emailVal\.toLowerCase\(\)\)/);

  // The stage-2 screen, which is where the mailed confirm link lands and so
  // is what a RETURNING visitor sees. It has no memory of the join, so the
  // address comes off the payload — filled in the load applier, never during
  // render, because contents before the fetch are a hydration mismatch.
  const more = read('frontend/src/features/auth/more.tsx');
  assert.match(more, /email\?: string;/);
  assert.match(more, /setSignupEmail\(payload\.email \|\| ''\)/);
  assert.match(more, /const \[signupEmail, setSignupEmail\] = useState\(''\)/);
  const line = more.match(/id="more-signup-email"[\s\S]{0,400}?<\/p>/);
  assert.ok(line, '#more-signup-email exists');
  assert.match(line[0], /<RichMessage id="auth:more\.registeredWith" values=\{\{ email \}\}/);
  assert.equal(message('auth:more.registeredWith', { email: 'a@b.co' }), 'Registered with <0>a@b.co</0>');
  assert.match(line[0], /email \? '' : ' hidden'/);
  assert.doesNotMatch(line[0], /mailto:/);
  // Beside the queue pill, inside the form both dapp.json checks select on.
  assert.equal(message('auth:more.question', { number: 1, total: 4 }), 'Question 1 of 4');
  const block = more.match(/<form\s+id="more-form"[\s\S]*?t\('auth:more\.question', \{ number: 1, total: 4 \}\)/);
  assert.ok(block, 'the stage-2 form exists');
  const pillAt = block[0].indexOf('<StatusPill');
  const emailAt = block[0].indexOf('<SignupEmail');
  assert.ok(pillAt > -1 && emailAt > pillAt, 'the address sits under the pill');
});

// ─── index.html + landing.tsx: in-flow app viewer ─────────────────

test('#app-viewer is an in-flow flex sibling, not a stacked overlay', () => {
  const html = shellMarkup();
  const viewer = html.match(/id="app-viewer"[^>]*class="([^"]*)"/);
  assert.ok(viewer, 'app-viewer exists');
  // Demoted from `fixed inset-0 z-50`: it now shares the overlay's column
  // with the header, so the header stays visible above an open app.
  assert.doesNotMatch(viewer[1], /\bfixed\b/);
  assert.doesNotMatch(viewer[1], /inset-0/);
  assert.match(viewer[1], /flex-1/);
  assert.match(viewer[1], /min-h-0/);
  // Opaque background — the zoom pins it as a live overlay mid-flight.
  assert.match(viewer[1], /bg-white/);
});

test('landing app open/close use the kit zoom with the flex-sibling outEl', () => {
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /type: 'zoom-in'/);
  assert.match(tsx, /type: 'zoom-out'/);
  // `fromEl` used to resolve the tapped tile. There is no tile now, and it is
  // a THUNK precisely so it can say so: both call sites answer null and the
  // kit takes the `fallback` each of them already declared for the case where
  // the tile had scrolled out of view.
  assert.equal((tsx.match(/fromEl: \(\) => null/g) || []).length, 2,
    'both zooms degrade to their declared fallback rather than a missing tile');
  assert.doesNotMatch(tsx, /#landing-apps \.app-card\[data-slug=/,
    'nothing resolves a landing tile any more — the grid is retired');
  // #764: two visible flex:1 siblings split the height 50/50, so the kit's
  // synchronous pre-paint measurement needs the outgoing element handed to
  // it explicitly.
  assert.match(tsx, /outEl: scroller/);
  // Leaving a LIVE iframe must not take a View-Transition snapshot (iOS
  // Safari flash) — mirrors App.navigateHome.
  assert.match(tsx, /fallback: 'none'/);
  // The no-kit path has to run BOTH halves of the split mutation.
  const shared = read('frontend/src/features/auth/shared.ts');
  assert.match(shared, /export function zoomFx/);
  assert.match(shared, /opts\.after === 'function'/);
});

test('leaving the landing screen tears the viewer down instead of stranding it', () => {
  const tsx = read(LANDING_TSX);
  // The router still calls the teardown on every route change off landing.
  assert.match(read('public/js/auth-screens.js'), /_resetLandingViewer\(\)/);
  assert.match(tsx, /_resetLandingViewer: \(\) => live\.current\.resetViewer\(\)/);
  // #1028: the live iframe is dropped by replacing the ELEMENT, not by
  // pointing it at about:blank — that assignment is a real navigation and
  // pushed an entry onto the history stack shared with the app.
  assert.match(tsx, /swapViewerFrame/);
  assert.match(tsx, /replaceChild\(fresh, old\)/);
  assert.doesNotMatch(tsx, /src = 'about:blank'/);
  // The replacement carries no src, so the next open is the initial
  // about:blank navigation browsers elide.
  assert.doesNotMatch(tsx, /fresh\.src\s*=/);
  // OS/browser back closes the viewer via a history marker, so the hash
  // router is never disturbed.
  assert.match(tsx, /svAnonAppViewer/);
  assert.match(tsx, /addEventListener\('popstate'/);
});

test('the guest back arrow closes the viewer directly (#1028)', () => {
  const tsx = read(LANDING_TSX);
  // The button performs the navigation; it never delegates to the browser
  // (the old `if (history.state...) history.back()` is what broke).
  const back = tsx.slice(tsx.indexOf('id="landing-back-btn"'));
  assert.match(back.slice(0, 500), /onClick=\{onBack\}/);
  // An open app first: Back closes it, the same call the button always made.
  // Only with no app open does it go from a project's page to Discover, or,
  // inside the Homeroom app, from Discover back to the story.
  assert.match(tsx, /const onBack = useCallback\(\(\) => \{\s*if \(st\.openSlug\) \{ live\.current\.closeLandingApp\(\); return; \}\s*(?:\/\/[^\n]*\n\s*)*location\.hash = appDiscover && !guestProject \? '#landing' : '#apps';\s*\}, \[st, appDiscover, guestProject\]\);/);
  // The marker entry is unwound AFTER the close, behind a re-entrancy flag.
  assert.match(tsx, /unwindingViewerEntry/);
  // The popstate listener ignores a pop that lands ON the marker entry.
  assert.match(tsx, /if \(history\.state && history\.state\.svAnonAppViewer\) return;/);
  // The frame is re-resolved per use — a captured const goes stale on swap.
  assert.match(tsx, /byId<HTMLIFrameElement>\('app-viewer-frame'\)/);
});

test('?shot=anon-back scripts two guest open/back cycles', () => {
  const app = read('public/js/app.js');
  // Must skip /api/auth/me, or the check runner's own session promotes the
  // page into the signed-in shell and the guest viewer is never exercised.
  assert.match(app, /shot !== 'anon-back'/);
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /runAnonBackShot/);
  // Two cycles: the bug only appears from the second open onward.
  assert.match(tsx, /cycle < 2/);
  // IT OPENS THROUGH THE OPENER, NOT THROUGH A TILE. The script used to poll
  // `#landing-apps .app-card[data-slug=…]` and click it — twice, because
  // `appsReady` settles when the FETCH lands and the tiles appeared one React
  // commit later. With the grid retired those polls could only ever spend
  // their budget and stamp `no-tile` on a perfectly healthy page, failing
  // this declared check on every submission (it sits inside the run window).
  // `openLandingApp` is what the tile click called, so driving it directly
  // exercises exactly what the check is for — two guest open/back cycles
  // through the real viewer, token path and history marker — and drops a
  // prerequisite the screen no longer has.
  assert.match(tsx, /await openLandingApp\(target\);/,
    'the shot opens through the live opener');
  assert.doesNotMatch(tsx, /bail\('no-tile'\)/, 'the tile-presence bails are gone with the tiles');
  assert.doesNotMatch(tsx, /bail\(`no-tile-/);
  assert.doesNotMatch(tsx, /landingTileFor\(target\.slug\)/);
  // It still picks its target from the FETCHED directory, which is the whole
  // reason that fetch survives the grid: an app the viewer would really open,
  // not gated and with a URL.
  assert.match(tsx, /st\.appsList\.find\(\(a\) => a && a\.requires_login === false && a\.url\)/);
  // The completion stamp the dapp.json test asserts on.
  assert.match(tsx, /setAttribute\('data-anon-back', 'done'\)/);
  const manifest = JSON.parse(read('dapp.json'));
  const t = manifest.tests.find((x) => /anon-back/.test(x.path || ''));
  assert.ok(t, 'dapp.json declares the guest-back test');
  assert.match(t.expectSelector, /#app-viewer\.hidden\[data-anon-back="done"\]/);
  // The shot deliberately loads a real app in the viewer iframe, and the
  // staging fixture's own hostname isn't deployed — its 404 reaches the
  // runner's console listener. The behaviour is asserted by the selector;
  // console health on this screen is covered by the plain `?shot=anon#landing`
  // test, which opens no iframe.
  assert.equal(t.allowConsoleErrors, true);
  assert.ok(manifest.tests.some((x) => x.path === '/?shot=anon#landing'),
    'the console-clean landing test still exists');
  // Only the first 12 entries run (src/services/app-manifest readTests).
  assert.ok(manifest.tests.indexOf(t) < 12, 'inside the run window');
});

test('#1755: every bail stamps WHY, so a failure names its step instead of timing out', () => {
  const tsx = read(LANDING_TSX);
  const shot = tsx.slice(tsx.indexOf('const runAnonBackShot'));
  const body = shot.slice(0, shot.indexOf("setAttribute('data-anon-back', 'done')"));

  // The point of the change. A bare `return` leaves data-anon-back unset, so
  // the assertion can never become true and the runner polls it to its 25s
  // cap, reporting "Check did not finish within 25s" whichever step gave up.
  // That verdict is the same for a broken back path and for a slow container,
  // which is why #1755 cost six re-runs of one unchanged head.
  const bares = body.match(/\)\)\) return;/g) || [];
  assert.deepEqual(bares, [], 'no bail may return without stamping a reason');

  // Each step is named, and both cycles are distinguishable: a cycle-2
  // failure means the first open/back round trip worked, which is the single
  // most useful fact about this check when it fails.
  // (The two `no-tile` reasons went with the directory grid: the shot drives
  // the opener directly now, so there is no element to wait for before it.)
  for (const reason of ['no-target', 'open-timeout-${c}', 'close-timeout-${c}']) {
    assert.ok(body.includes(`bail(\`${reason}\`)`) || body.includes(`bail('${reason}')`),
      `the ${reason} bail is stamped`);
  }
  assert.match(body, /const c = `c\$\{cycle \+ 1\}`/, 'the cycle is part of the reason');

  // Slowness and breakage are different answers and must not look alike.
  assert.match(body, /Date\.now\(\) >= deadline \? `\$\{reason\}-slow` : reason/);

  // The stamp the assertion actually wants is still only reachable from the
  // happy path, so nothing that should fail now passes.
  assert.equal(body.includes("'done'"), false, 'no bail stamps done');
  assert.match(tsx, /setAttribute\('data-anon-back', 'done'\)/);

  // And the declared check is unchanged: it still demands exactly "done".
  const manifest = JSON.parse(read('dapp.json'));
  const t = manifest.tests.find((x) => /anon-back/.test(x.path || ''));
  assert.match(t.expectSelector, /\[data-anon-back="done"\]/);
});

test('App._tileFor is scoped to the authed grid', () => {
  // Both grids render `.app-card[data-slug]` and after a reload-free login
  // they share one document — an unscoped lookup could zoom from the wrong
  // tile.
  const js = read('public/js/app.js');
  assert.match(js, /#app-list \.app-card\[data-slug=/);
});

test('public apps list is sorted by usage (active users first)', () => {
  const src = read('src/services/public-app-directory.js');
  assert.match(src, /ORDER BY COALESCE\(au\.cnt, 0\) DESC/);
});

test('landing scroller has kit pull-to-refresh with overscroll containment', () => {
  const tsx = read(LANDING_TSX);
  // PTR must attach to the INNER scroller, never the fixed overlay: the
  // kit's rubber-band translateY on the overlay itself slides the whole
  // opaque screen down and exposes the authed shell's header behind it.
  assert.match(tsx, /pullToRefresh\(byId\('auth-landing-scroll'\)/);
  assert.doesNotMatch(tsx, /pullToRefresh\(byId\('auth-landing-screen'\)/);
  assert.match(tsx, /loadLandingApps\(\)\)/);
  // Containment keeps the browser's native pull-refresh from competing
  // with the kit gesture — same treatment as #home-screen.
  const css = read('public/css/app.css');
  const block = css.match(/#home-screen,\s*#auth-landing-scroll \{[^}]*\}/);
  assert.ok(block, 'shared containment block exists');
  assert.match(block[0], /overscroll-behavior-y: contain/);
});

test('the landing overlay keeps its own scroll wrapper (pull-down backstop)', () => {
  const html = shellMarkup();
  // The overlay itself must NOT be the scroller...
  const overlay = html.match(/id="auth-landing-screen"[^>]*class="([^"]*)"/);
  assert.ok(overlay, 'landing overlay exists');
  assert.doesNotMatch(overlay[1], /overflow-y-auto/);
  // ...the inner wrapper is, filling the overlay's height.
  const scroller = html.match(/id="auth-landing-scroll"[^>]*class="([^"]*)"/);
  assert.ok(scroller, 'inner landing scroller exists');
  assert.match(scroller[1], /overflow-y-auto/);
  // Fills what the header leaves, rather than the whole overlay: h-full
  // under a column flex parent would overflow past the header.
  assert.match(scroller[1], /flex-1/);
  assert.match(scroller[1], /min-h-0/);
});

// ─── the directory is fetched, and renders nothing ────────────────

test('the landing\'s directory is the guest Discover, with no locked tiles', () => {
  const interior = interiorHtmlFor('auth-landing-screen');
  // The old grid is still gone: 41 tiles, 36 of them locked and captioned
  // "Account required", three of the four screens a visitor scrolled
  // through. A stranger's first screen is not a launcher for apps they
  // cannot open.
  assert.doesNotMatch(interior, /id="landing-apps"/);
  assert.doesNotMatch(interior, /class="app-card/);
  assert.doesNotMatch(interior, /Apps built here/);

  // The FETCH is what the guest Discover draws now (features/guest), as well
  // as the three things that always depended on it.
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /'\/api\/public\/apps\?include_wallets=0'/);
  assert.match(tsx, /st\.appsList = list;/, 'the shot picks its target from the list');
  assert.match(tsx, /loadLandingApps\(\)\)/, 'pull-to-refresh re-runs it');
  assert.match(tsx, /_loadLandingApps: \(\) => live\.current\.loadLandingApps\(\)/,
    'and it is a published router seam');
  assert.match(tsx, /setApps\(list as GuestApp\[\]\);/);
  assert.match(tsx, /<GuestDiscover\s+apps=\{apps\}/);
  // WHAT MADE A GRID WORTH HAVING AGAIN: every card opens a page anybody can
  // read, so no card is locked. Whether the app itself needs an account is
  // the project page's "Try it" or "Sign in to use it", not a tile's.
  const discover = read('frontend/src/features/guest/guest-discover.tsx');
  assert.doesNotMatch(discover, /LockIcon|Account required|grayscale/);
  assert.match(discover, /href=\{projectHash\(app\.slug\)\}/);
  assert.doesNotMatch(tsx, /TileSkeleton/);
});

// ─── landing.tsx: tile renderer ────────────────────────────────────

test('landing tiles mirror home cards and gate on requires_login', () => {
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /function LandingTile/);
  // Gated presentation: dimmed + lock + caption.
  assert.match(tsx, /grayscale-\[0\.75\]/);
  assert.match(tsx, /Account required/);
  // Signed-out tap: remember the app deep link, then the signup flow.
  assert.match(tsx, /accountRequired && !signedIn/);
  assert.match(tsx, /rememberDeepLink[\s\S]{0,180}'\/app\/' \+ encodeURIComponent\(app\.slug \|\| ''\)/);
  assert.match(tsx, /location\.hash = '#signup'/);
  // A waiting-room session takes the existing app-scoped token path.
  assert.match(tsx, /AppView\?\._mintToken\?\.\(slug\)/);
  assert.match(tsx, /url\.searchParams\.set\('token', token\)/);
  // Icon priority mirrors home.js iconTileFor: image > emoji > letter.
  assert.match(tsx, /data-icon="image"/);
  assert.match(tsx, /data-icon="emoji"/);
  assert.match(tsx, /data-icon="letter"/);
});

// ─── probe wiring ─────────────────────────────────────────────────

test('the shell probe is a scheduled job of the workflow, and its columns are in schema', () => {
  // A clock (src/workflow/clock/services.ts): every five minutes wherever the
  // workflow runs, and the first run of a new build re-probes every app that
  // read public.
  assert.match(read('src/workflow/clock/services.ts'), /name: 'shell-probe', everyMs: 5 \* MIN,/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell VARCHAR\(10\) NOT NULL DEFAULT 'unknown'/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell_checked_at TIMESTAMPTZ/);
});

// ─── public API contract ──────────────────────────────────────────

test('public apps API exposes the home-card fields the landing consumes', () => {
  // Both the public route and app-facing v1 route use this one projection.
  const src = read('src/services/public-app-directory.js');
  for (const field of ['icon_emoji', 'icon_url', 'active_users', 'requires_login']) {
    assert.match(src, new RegExp(field), `public-api carries ${field}`);
  }
  // Fail-safe mapping: only a positive 'public' classification is open.
  assert.match(src, /app\.anon_shell !== 'public'/);
});

// ─── staging seed ─────────────────────────────────────────────────

test('staging seeds one open + one gated landing tile', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /async function seedStagingLandingDirectory\(pool\)/);
  assert.match(src, /await seedStagingLandingDirectory\(pool\);/);
  // Staging-only, like every other mock-data seed.
  const fn = src.match(/async function seedStagingLandingDirectory\(pool\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'seed body found');
  assert.match(fn[0], /process\.env\.USERNODE_ENV !== 'staging'/);
  // Both branches of requires_login are represented.
  assert.match(fn[0], /'staging-landing-open'/);
  assert.match(fn[0], /'staging-landing-gated'/);
  // The shell probe re-checks running public apps whose stamp is stale, and
  // these fixtures have no container — a NOW() stamp would flip the open
  // tile to 'unknown' (→ gated) inside one 5-minute sweep.
  assert.match(fn[0], /anon_shell_checked_at = NOW\(\) \+ INTERVAL '1 year'/);
  // Idempotent on the every-boot re-run path.
  assert.match(fn[0], /ON CONFLICT DO NOTHING/);
  // Nonzero active-users badge on the open tile.
  assert.match(fn[0], /INSERT INTO app_activity/);
});
