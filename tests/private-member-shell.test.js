'use strict';

// A PRIVATE MEMBER in the shell (users.private_member_since): an invite link
// lands them inside the group's app with no ✕ (and the tip under the
// Homeroom mark), the mark menu's "Go to Homeroom" is their way on, and the
// Home it opens runs the walk, its fourth card the waitlist card, on a Home
// that has Discover but no Challenges and no New project. The invite's Join that makes
// them asks for a name and a phone first (tests/phone-invite-join.test.js).
// The server half is tests/private-member-postgres.test.js and
// tests/community-invites-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('public/js/app.js');

// The private member's walk is every newcomer's three cards (Evan, 20 Oct
// 2026): no waitlist card (they find it on Home), and Go to community last.
test('the private member\'s walk: the three cards every newcomer gets, and no waitlist card', () => {
  const { homeWalkSteps } = loadTsx('frontend/src/features/first-session/tour-steps.ts');
  const steps = homeWalkSteps({ slug: 'best-brunch', name: 'Best Brunch' });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'home', 'home']);
  assert.deepEqual(steps.map((s) => s.target), [
    '#app-list .app-card[data-slug="best-brunch"]',
    '#platform-tab-ai',
    '#platform-tab-workshop',
  ]);
  assert.deepEqual(steps.map((s) => [s.title, s.text]), [
    ['Welcome to Homeroom', 'Best Brunch lives here, on Home.'],
    ['Homeroom bot', 'It\'s in the Homeroom bot tab. Ask it to make any changes to Best Brunch.'],
    ['Communities', 'Best Brunch\'s hub is under Communities. Invite people and decide what changes.'],
  ]);
  // The group's app from a ready-made starter: its example on the bot card.
  const fromStarter = homeWalkSteps({ slug: 'best-brunch', name: 'Best Brunch', example: 'add a price range to each place' });
  assert.equal(fromStarter[1].text, 'Ask it for changes, like “add a price range to each place”.');
  // Each points at its place and leads on with Next; none is pressed.
  assert.deepEqual(steps.map((s) => !!s.ringed), [true, true, true]);
  assert.deepEqual(steps.map((s) => !!s.last), [false, false, true]);
  assert.ok(steps.every((s) => !s.tap && !s.inMenu && !s.waitsFor));
  // No challenges or points, and no waitlist.
  assert.doesNotMatch(JSON.stringify(steps), /challenge|points|waitlist/i);
  // Every target is one the shell draws: the tabs are the bar's own ids.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.ok(bar.includes('id={`platform-tab-${key}`}'));
  for (const key of ["key: 'workshop' as const", "key: 'messages' as const"]) assert.ok(bar.includes(key), key);
});

test('a private member lands in the app with the tip, and "Go to Homeroom" opens the Home that runs the walk', () => {
  const src = read('frontend/src/features/first-session/index.tsx');
  // The same walk as any newcomer's.
  assert.match(src, /const \{ slug, name, example \} = mode\.info;\s+return homeWalkSteps\(\{ slug, name, example \}\);/);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  assert.match(welcome, /const privateMember = !!app\?\.user\?\.privateMember;/);
  assert.match(welcome, /walkOwed = \(privateMember \|\| !!info\.newAccount\) && oweWalk\(uid, \{ slug, name, privateMember \}\);\s+if \(walkOwed\) app\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(welcome, /const going = app\?\.navigateToApp\?\.\(slug, 'app'\);/);
  // Go to Homeroom: noted first (the app has its ✕ from then on), then Home,
  // where the walk runs: the app was their first visit.
  const goHome = src.slice(src.indexOf('goHome('), src.indexOf('holdWelcome(): boolean'));
  assert.match(goHome, /app\?\._notePrivateHome\?\.\(\);\s+app\?\.navigateHome\?\.\(\);/);
  assert.match(goHome, /if \(uid != null\) \{ armWalk\(uid\); setOwing\(\(n\) => n \+ 1\); \}/);
  assert.doesNotMatch(goHome, /path: 'private'/);
});

test('the app has no ✕ for a private member until they have gone to Homeroom, from either writer', () => {
  // Nor for anybody new the first session still owes its walk on Home: their
  // menu offers the same "Go to Homeroom", and the ✕ skipped the walk.
  assert.match(APP, /_privateNoClose\(\) \{\s+return \(!!App\.user\?\.privateMember \|\| App\._homeWalkOwed\(\)\) && !App\._privateHomeVisited\(\);/);
  // The walk is read as first-visit.ts owedWalk reads it, under its prefix.
  const { WALK_PREFIX } = { WALK_PREFIX: read('frontend/src/features/first-session/first-visit.ts').match(/export const WALK_PREFIX = '([^']+)';/)[1] };
  assert.ok(APP.includes(`FIRST_SESSION_WALK_PREFIX: '${WALK_PREFIX}'`), 'the same key as the first session writes');
  const owed = APP.slice(APP.indexOf('  _homeWalkOwed() {'), APP.indexOf('  _privateNoClose() {'));
  assert.match(owed, /if \(!raw \|\| raw === 'done'\) return false;/, 'a walk that has run is not owed');
  assert.match(owed, /typeof record\.slug === 'string' && record\.slug/, 'a record with a slug, as owedWalk asks');
  // Kept by the account, so every device agrees: /api/auth/me's marks first,
  // this device's records beside them.
  assert.match(owed, /if \(App\.user\?\.homeWalkOwed === true\) return true;/);
  const visited = APP.slice(APP.indexOf('  _privateHomeVisited() {'), APP.indexOf('  _notePrivateHome() {'));
  assert.match(visited, /if \(App\.user\?\.homeroomReached === true\) return true;/);
  assert.match(visited, /=== 'done';/, 'the walk having run here is Homeroom reached');
  assert.match(APP, /_notePrivateHome\(\) \{[\s\S]{0,200}App\._noteHomeWalk\('reached'\);/);
  assert.match(APP, /HOME_WALK_PATH: '\/api\/me\/home-walk'/);
  // The first session tells the account when the walk is owed and when it
  // runs or is claimed; goHome tells it through _notePrivateHome.
  const fs = read('frontend/src/features/first-session/index.tsx');
  assert.match(fs, /walkOwed = \(privateMember \|\| !!info\.newAccount\) && oweWalk\(uid, \{ slug, name, privateMember \}\);\s+if \(walkOwed\) app\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(fs, /if \(oweWalk\(uid, \{ slug, name, maker: true \}\)\) legacy\(\)\.App\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(fs, /noteWalkRun\(uid\);\s+\/\/ On Home: they have reached Homeroom, on every device\.\s+legacy\(\)\.App\?\._noteHomeWalk\?\.\('reached'\);/);
  assert.match(fs, /!claimWalk\(uid\)\) \{ setMode\(\{ kind: 'none' \}\); return; \}\s+legacy\(\)\.App\?\._noteHomeWalk\?\.\('reached'\);/);
  // The menu and the tip read the account's mark too, and never once reached.
  assert.match(read('frontend/src/features/app-context/about-data.ts'),
    /const owed = owedWalk\(uid\) != null \|\| app\?\.user\?\.homeWalkOwed === true;\s+return owed && !app\?\._privateHomeVisited\?\.\(\);/);
  // The account's side: the route, the marks, and /api/auth/me's two fields.
  assert.match(read('src/routes/onboarding.js'), /router\.post\('\/api\/me\/home-walk', drainGuard, sameOriginBrowserOnly,/);
  const auth = read('src/routes/auth.js');
  assert.match(auth, /\(u\.getting_started_seen->>'home_walk_owed' IS NOT NULL\s+AND u\.getting_started_seen->>'homeroom_reached' IS NULL\) AS home_walk_owed,/);
  assert.match(auth, /\(u\.getting_started_seen->>'homeroom_reached' IS NOT NULL\) AS homeroom_reached,/);
  assert.match(auth, /\n\s+homeWalkOwed,\n\s+homeroomReached,\n/);
  const slotFor = APP.slice(APP.indexOf('  _backSlotFor(revealId) {'), APP.indexOf("return ['close', App._closeAppHref()];"));
  assert.match(slotFor, /if \(App\._privateNoClose\(\)\) return \['none'\];/);
  // switchTab's App branch publishes the table's own answer, so the two
  // writers agree by construction (and the ✕ never comes back that way).
  assert.match(APP, /if \(tab === 'app'\) \{[\s\S]{0,1200}App\.setBackIcon\(\.\.\.App\._backSlotFor\('app-view'\)\);\s+AppView\.renderAppTab\(\);/);
  assert.doesNotMatch(APP, /App\.setBackIcon\('close',/);
  // No rail beside their first app either: the predicate that keeps it on a
  // desktop asks the same question.
  assert.match(APP, /_railBesideApp\(\) \{[\s\S]{0,200}&& !App\._privateNoClose\(\);/);
  // Remembered per account on this device, like the tours.
  assert.match(APP, /PRIVATE_HOME_PREFIX: 'usernode:private-home:'/);
});

test('the shell follows the tier: a reload when it changes, the store told, "Want in sooner?" reachable', () => {
  assert.match(APP, /if \(!!user\.privateMember !== !!App\.user\?\.privateMember\) \{\s+App\.saveSessionSnapshot\(user\);\s+location\.reload\(\);/);
  assert.match(APP, /window\.UsernodeReact\?\.nav\?\.setPrivateMember\?\.\(!!App\.user\?\.privateMember\);/);
  assert.match(APP, /if \(authRoute === 'more' && App\.user\?\.privateMember\) \{\s+AuthScreens\.show\('more', authSeg\);\s+return;/);
  // Their bar is everybody's: they use public apps from Discover (and do not
  // vote on them, tests/private-member-postgres.test.js).
  assert.doesNotMatch(read('frontend/src/features/nav/tab-bar.tsx'), /privateMember/);
  assert.doesNotMatch(read('public/css/app.css'), /platform-tabs-private/);
  // The prerender is the full bar: the store says FALSE until boot.
  assert.match(read('frontend/src/features/nav/nav-store.js'), /viewer: null,\s+privateMember: false,/);
});

test('the mark menu: "Go to Homeroom" for a private member, and no terminal or Build it now', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // …and for any newcomer the walk on Home is still owed to (sign-up test,
  // 19 Oct 2026; tests/app-about-pane.test.js draws it). A private member's
  // only until they have been Home (Evan, 20 Oct 2026): `newcomer`.
  assert.match(sheet, /\{mounted && \(newcomer \|\| walkOwed\) \? \(\s+<div\s+id="app-menu-homeroom-card"[^>]*>\s+<button\s+id="app-menu-row-homeroom"/);
  // A white card leading the list, right under "Suggest an improvement"
  // (#4401): 20px, one inset hairline, the mark, rows' 15 over 13, a chevron.
  // The card is a wrapper since #4399, which can add a second row to it.
  assert.match(sheet, /id="app-menu-homeroom-card"\s+className="[^"]*\brounded-\[20px\][^"]*\bbg-white\b[^"]*shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/);
  const card = sheet.slice(sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.match(card, /^id="app-menu-row-homeroom"\s+type="button"/);
  assert.match(card, /src="\/brand\/homeroom-mark\.png"[\s\S]*?className="platform-mark-tile w-10 h-10/);
  assert.match(card, /text-\[15px\] font-\[650\][^>]*>\{t\('agent:appContext\.goToHomeroom\.title'\)\}</);
  assert.equal(message('agent:appContext.goToHomeroom.title'), 'Go to Homeroom');
  assert.match(card, /text-\[13px\][^>]*>\{t\('agent:appContext\.goToHomeroom\.sub'\)\}</);
  assert.equal(message('agent:appContext.goToHomeroom.sub'), 'Your Home, your communities and Homeroom bot');
  assert.match(card.slice(0, card.indexOf('</button>')), /<ChevronRightIcon/);
  assert.match(sheet, /firstSession\?\.goHome\?\.\(info\)/);
  assert.match(sheet, /\{showTerminal && !privateMember \? \(/);
  assert.match(sheet, /readOnly: writeBarred,\s+\} = useStoreState\(improveStore\);[\s\S]*const readOnly = writeBarred \|\| privateMember;/);
  // First in the list, inside #switcher-nav, so the quick actions stay its
  // previous sibling (dapp.json: #improve-quick-actions + #switcher-nav).
  const nav = sheet.indexOf('id="switcher-nav"');
  assert.ok(nav < sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.ok(sheet.indexOf('id="app-menu-row-homeroom"') < sheet.indexOf('id="app-menu-row-workshop"'));
});

// "Add this app to your home screen" (Evan, 20 Oct 2026): the row puts the
// APP they are in on the home screen, not Homeroom. It runs the app page's
// own install item, as About's row does (tests/app-install-sheet-row.test.js),
// so the icon it leaves opens the app.
test('the Go to Homeroom card carries "Add this app to your home screen", and the banner waits (#4399)', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const card = sheet.slice(sheet.indexOf('id="app-menu-homeroom-card"'), sheet.indexOf('GIVE FEEDBACK IS NOT A ROW'));
  // A second row in the same card, under a hairline, only while Go to
  // Homeroom is offered to a private member, on a phone outside the app.
  assert.match(sheet, /const appRow = useAboutApp\(slug \|\| null, open && newcomer && !!slug && !restricted\);/);
  assert.match(sheet, /\(menuItemsFor\(appRow\) \|\| \[\]\)\.find\(\(i\) => i && i\.key === 'install'\)/);
  assert.match(sheet, /const addToHomeScreen = newcomer && !isNativeApp\(\) \? installItem : null;/);
  assert.match(card, /\{addToHomeScreen \? \(\s+<>\s+<div aria-hidden="true" className="[^"]*h-px bg-\[color:var\(--app-sheet-line\)\]"/);
  assert.match(card, /id="app-menu-row-add-home"/);
  assert.match(card, /onClick=\{\(\) => \{ void AppContext\.dismissForNav\(\)\.then\(\(\) => addToHomeScreen\.run\(\)\); \}\}/);
  assert.match(card, /w-10 h-10 rounded-\[11px\] bg-zinc-100[^"]*"[^>]*>\s+<PhonePlusIcon/);
  assert.match(card, /text-\[15px\] font-\[650\][^>]*>\{t\('agent:appContext\.addAppToHomeScreen'\)\}</);
  assert.equal(message('agent:appContext.addAppToHomeScreen'), 'Add this app to your home screen');
  // The card's row adds the app, never Homeroom: Homeroom's steps are a row
  // of their own further down (tests/homeroom-home-screen.test.js), and the
  // sheet has no install address of its own.
  assert.doesNotMatch(card, /InstallStepsSheet|setHomeroomSteps|openHomeroomInBrowser/);
  assert.doesNotMatch(sheet, /useHomeScreenOffer|addHomeroomToHomeScreen|\/install['"`]/);
  // The banner stays down while Go to Homeroom is offered.
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  assert.match(banner, /if \(offeringGoToHomeroom\(!!privateMember\)\) \{ setOffer\(null\); return; \}/);
});

test('the waitlist card: join, an email, a code, then On the waitlist with "Want in sooner?"', () => {
  const card = 'frontend/src/features/home/waitlist-card.tsx';
  const none = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'none', email: null, accountEmail: 'lina@example.com', moreToken: null },
    onListed: () => {},
  });
  assert.match(none, /data-waitlist-card="join"/);
  assert.match(none, />Make your own apps</);
  assert.doesNotMatch(none, /suggest changes to them now/, 'the pitch paragraph is gone');
  assert.match(none, /We&#x27;re letting people in a few at a time\./);
  assert.match(none, /id="home-waitlist-join"[^>]*>Join the waitlist</);
  assert.doesNotMatch(none, /On the waitlist/);

  const token = 'ab'.repeat(24);
  const listed = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'listed', email: 'lina@example.com', accountEmail: 'lina@example.com', moreToken: token },
    onListed: () => {},
  });
  assert.match(listed, /data-waitlist-card="listed"/);
  assert.match(listed, /On the waitlist/);
  assert.match(listed, />Make your own apps</);
  assert.match(listed, /We’ll email you when your spot is ready\./);
  assert.doesNotMatch(listed, /few at a time|Until then/, 'one line under the title');
  // "Want in sooner?" is one row: the question, and a link to the questions.
  assert.match(listed, /Want in sooner\?/);
  assert.match(listed, new RegExp(`href="#more/${token}"[^>]*>Answer 4 questions<`));
  assert.doesNotMatch(listed, /Optional \(moves you up the list\)|Answer them now/);

  const src = read(card);
  // Not in the prerender: nothing until the shell knows who is signed in.
  assert.match(src, /if \(!privateMember \|\| !standing \|\| standing\.state === 'admitted'\) return null;/);
  for (const p of ["'/api/me/waitlist'", "'/api/me/waitlist/join'", "'/api/me/waitlist/verify'", "'/api/me/waitlist/join-phone'"]) assert.ok(src.includes(p), p);

  // #4223: a verified phone and no confirmed email joins with the one button,
  // nothing asked; listed by phone, the news goes by text and an email is optional.
  const phone = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'none', email: null, accountEmail: null, hasPhone: true, moreToken: null },
    onListed: () => {},
  });
  assert.match(phone, /id="home-waitlist-join"[^>]*>Join the waitlist</);
  assert.doesNotMatch(phone, /type="email"/);
  assert.match(src, /onClick=\{\(\) => \(phoneOnly \? void joinByPhone\(\) : setStep\(\{ kind: 'email' \}\)\)\}/);
  const byPhone = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'listed', email: null, accountEmail: null, hasPhone: true, moreToken: token },
    onListed: () => {},
  });
  assert.match(byPhone, /We’ll text you when your spot is ready\./);
  assert.match(byPhone, /id="home-waitlist-add-email"[^>]*>Add an email too</);
  assert.match(byPhone, new RegExp(`href="#more/${token}"`));
  assert.doesNotMatch(listed, /Add an email too/, 'an email row has nothing to add');
  // What a search finds of your communities follows the launcher (it was
  // Pinned communities, One Home, #6361, and Discover before that, #4937);
  // the waitlist card keeps its place after it.
  assert.match(read('frontend/src/features/home/index.tsx'), /\{wip \? null : <AppsMore \/>\}\s+<\/WipCard>\s+<\/section>[\s\S]*<HomeCommunityMatches \/>\s+[\s\S]*<WaitlistCard \/>/);
});

test('a private member is offered no New project on Home and no New community on the Communities page, and no Challenges or Create panels', () => {
  const home = read('frontend/src/features/home/home.js');
  assert.match(home, /if \(App\.user\?\.privateMember\) create = null;/);
  // New community is the Communities tab's page's now (it was Pinned
  // communities' tile on Home, One Home, #6361): the tile at the end of
  // Joined and the filled button beside search both hang off the one
  // offer, which a private member is not made.
  const page = read('frontend/src/features/communities/index.tsx');
  assert.match(page, /const offerCreate = state\.ready && !win\?\.App\?\.user\?\.privateMember;/);
  assert.match(page, /const createTile = offerCreate && !q && !editing;/);
  assert.match(page, /\{kit && offerCreate \? \(\s*<WipCta\s+id="communities-new-top"/);
  assert.doesNotMatch(read('frontend/src/features/home/pinned-communities.tsx'), /offerCreate|showCreateModal/, 'nothing on Home\'s side of the tiles makes one');
  const panels = read('src/routes/home-panels.js');
  assert.match(panels, /const PRIVATE_MEMBER_PANELS = new Set\(\['discover'\]\);/);
  assert.match(panels, /if \(req\.user\.privateMember && !PRIVATE_MEMBER_PANELS\.has\(panel\.key\)\) continue;/);
});

test('the vote routes refuse a private member on a public app before anything is recorded', () => {
  const votes = read('src/routes/votes.js');
  const sessionVote = votes.slice(votes.indexOf("router.post('/api/sessions/:id/vote'"));
  assert.match(sessionVote, /const session = sessionRows\[0\];\s+\/\/ A private member does not vote on a public app \(communities\.js\)\.\s+const privateRefusal = await communities\.privateVoteRefusal\(pool, session\.app_id, req\.user\?\.id\);\s+if \(privateRefusal\) return res\.status\(403\)\.json\(privateRefusal\);/);
  const issues = read('src/routes/issues.js');
  const issueVote = issues.slice(issues.indexOf("router.post('/api/issues/:id/vote'"));
  assert.match(issueVote, /const issue = issueRows\[0\];\s+\/\/ A private member does not vote on a public app \(communities\.js\)\.\s+const privateRefusal = await communities\.privateVoteRefusal\(pool, issue\.app_id, req\.user\?\.id\);/);
  // And every tally and denominator leaves such a vote out (schema.sql).
  // (Followed by the verified-identity clause, tests/verified-identity-shell.test.js.)
  assert.match(read('src/db/schema.sql'), /AND pa\.view_visibility = 'public'\s+\)\s+AND NOT public_vote_needs_identity\(voter_id, target_app_id\)\s+\$\$;/);
});

test('the waitlist card\'s routes: a code-mailing join behind the email code\'s limiters, for those still waiting', () => {
  const routes = read('src/routes/member-waitlist.js');
  assert.match(routes, /router\.get\('\/api\/me\/waitlist', async/);
  // Limiters before the same-origin check (tests/same-site-browser.test.js),
  // and only somebody still waiting gets past `waiting`.
  assert.match(routes, /router\.post\('\/api\/me\/waitlist\/join', drainGuard, otpRequestLimiter, otpRequestEmailLimiter,\s+sameOriginBrowserOnly, waiting,/);
  assert.match(routes, /router\.post\('\/api\/me\/waitlist\/verify', drainGuard, otpVerifyLimiter,\s+sameOriginBrowserOnly, waiting,/);
  assert.match(routes, /code: 'already_in'/);
  // Behind the session middleware, after the invite routes.
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(authMiddleware(config));') < server.indexOf('app.use(memberWaitlistRoutes(config));'));
  assert.ok(server.indexOf('app.use(communityInviteRoutes(config));') < server.indexOf('app.use(memberWaitlistRoutes(config));'));
});

// ── Every newcomer, not only a private member (sign-up test, 19 Oct 2026) ─
//
// Evan made a project, opened it, and the mark's menu offered "Go to
// community". He took it: the project's hub opened inside the app, and the
// walk on Home (his tile, Messages and Homeroom bot, Communities) did not run
// until he found Home himself. While that walk is owed, the menu's way on is
// "Go to Homeroom", which goes Home and runs it.

/**
 * The menu as it draws once mounted, on the server renderer: its after-mount
 * effect runs in render (a render-phase update, which the renderer draws
 * again for), once per draw, and the layout effect that hides "Go to
 * community" runs on stand-in elements, since a server render attaches no
 * refs. `walk` is what this device holds for user `uid`, or nothing, and
 * `viewer` is who is signed in.
 */
function drawMenu({ walk = null, uid = 42, viewer = uid, privateMember = false, visited = false } = {}) {
  const React = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  let mountedOnce = false;
  const refs = [];
  const hides = (fn) => /classList\.toggle\(["']hidden["'], hide\)/.test(String(fn));
  const fake = {
    ...React,
    useEffect(fn, deps) {
      if (!mountedOnce && Array.isArray(deps) && deps.length === 0 && /setMounted\(true\)/.test(String(fn))) {
        mountedOnce = true;
        fn();
      } else if (hides(fn)) fn();
    },
    useLayoutEffect(fn) { if (hides(fn)) fn(); },
    useRef(init) {
      if (init !== null) return React.useRef(init);
      const classes = new Set();
      const el = { classes, classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
      refs.push(el);
      return React.useRef(el);
    },
  };
  const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts', { stubs: { react: fake } });
  const data = new Map(walk ? [[`usernode:first-session:walk:${uid}`, typeof walk === 'string' ? walk : JSON.stringify(walk)]] : []);
  const had = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  Object.defineProperty(globalThis, 'window', { value: { App: { user: { id: viewer }, _privateHomeVisited: () => visited } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } }, configurable: true, writable: true });
  const before = ui.improveStore.get();
  const nav = ui.navStore.get();
  ui.improveStore.set({ ...before, target: 'app', slug: 'city-tier-list', name: 'City Tier List' });
  ui.navStore.set({ privateMember });
  try {
    const html = renderToHtml(createElement(ui.AppsSwitcherSheet));
    return { html, mounted: mountedOnce, hidden: refs.filter((el) => el.classes.has('hidden')).length };
  } finally {
    ui.improveStore.set(before);
    ui.navStore.set({ privateMember: nav.privateMember });
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
}

test('a newcomer owed the walk on Home: the menu offers "Go to Homeroom", and "Go to community" is hidden', () => {
  const owed = drawMenu({ walk: { slug: 'city-tier-list', name: 'City Tier List', maker: true, armed: true } });
  assert.ok(owed.mounted, 'drawn as mounted');
  assert.match(owed.html, /<div id="app-menu-homeroom-card" class="[^"]*"><button id="app-menu-row-homeroom" type="button"/);
  assert.match(owed.html, />Go to Homeroom<\/span>/);
  assert.equal(owed.hidden, 1, '"Go to community" hidden');
  // Still in the document, its id and address the Workshop's (dapp.json
  // checks select on it for a viewer who is owed no walk).
  assert.match(owed.html, /<a id="app-menu-row-workshop" data-context-row="workshop" href="#app\/city-tier-list\/dev\/hub"/);
  // The home-screen row stays a private member's.
  assert.doesNotMatch(owed.html, /app-menu-row-add-home/);
  // Not yet armed (they have not opened the app yet) counts the same.
  assert.equal(drawMenu({ walk: { slug: 'city-tier-list', name: 'City Tier List', maker: true } }).hidden, 1);

  // Nobody owed a walk: "Go to community", as always. None on this device,
  // one that has run, or one owed to somebody else signed in here before.
  for (const [label, drawn] of [
    ['none', drawMenu({ walk: null })],
    ['run already', drawMenu({ walk: 'done' })],
    ['somebody else\'s', drawMenu({ walk: { slug: 'x', name: 'X' }, uid: 42, viewer: 7 })],
  ]) {
    assert.ok(drawn.mounted, label);
    assert.doesNotMatch(drawn.html, /app-menu-homeroom-card/, label);
    assert.equal(drawn.hidden, 0, label);
    assert.match(drawn.html, /id="app-menu-row-workshop"/, label);
  }
});

// "After the first time going through, Go to Homeroom would change to Go to
// community" (Evan, 20 Oct 2026): a private member is offered the card until
// they have been Home, then it goes and "Go to community" is back, as for
// everyone else. It used to stay at the top for as long as they were one.
test('a private member: "Go to Homeroom" until they have been Home, then "Go to community"', () => {
  const first = drawMenu({ privateMember: true, visited: false });
  assert.ok(first.mounted);
  assert.match(first.html, /id="app-menu-homeroom-card"/);
  assert.match(first.html, />Go to Homeroom<\/span>/);
  assert.equal(first.hidden, 1, '"Go to community" hidden while Go to Homeroom is offered');
  const after = drawMenu({ privateMember: true, visited: true });
  assert.ok(after.mounted);
  assert.doesNotMatch(after.html, /app-menu-homeroom-card|Go to Homeroom/);
  assert.equal(after.hidden, 0, '"Go to community" shown');
  assert.match(after.html, /<a id="app-menu-row-workshop" data-context-row="workshop" href="#app\/city-tier-list\/dev\/hub"/);
});
