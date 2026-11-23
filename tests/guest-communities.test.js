// The signed-out page about private communities
// (frontend/src/features/guest/guest-communities.tsx), at `/communities`.
//
// The landing's own pitch is the public library, apps anyone can edit. A
// private community is a different promise (its maker says who gets in and
// who approves a change), for somebody who runs a group, so it has a page
// of its own behind a door on the landing (features/auth/story.tsx). The
// page is the B3 design (23 Nov 2026). This holds:
//   - what the page says, top to bottom;
//   - the walk through a community in its hero: four scenes whose steps
//     count up, the first one up before anything has run, and what holds
//     or moves it;
//   - that its approval rules are the product's four, in its order;
//   - its one way in, which says "Join the waitlist" while new accounts wait
//     and notes itself as where a sign-up came from;
//   - its address: the landing draws it at that pathname in the guest
//     Discover's place, and a visitor with no account may open it;
//   - its look: the website's, spelled as that look's variables outside the
//     walk-through, and its pictures, each one shipped and accounted for.
//
// Run with: node --test tests/guest-communities.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PAGE = 'frontend/src/features/guest/guest-communities.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const STORY = 'frontend/src/features/auth/story.tsx';

const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));
const render = (over = {}) => renderComponent(PAGE, 'GuestCommunities', { waitlist: true, onStart() {}, ...over }, {
  cache: false,
  stubs: { '../auth/sign-up-from': { noteSignUpFrom() {} } },
});
// The supper club's own app, drawn three times in the walk-through.
const SUPPER = ['this friday', 'vol. 14', 'ramen night', '7pm', 'sam’s place', '9 going',
  'S', 'broth', 'samwich', 'M', 'noodles', 'maya.eats', '+', 'dessert', 'claim'];
const SUPPER_END = ['L', 'drinks', 'leo_bakes'];

test('the page, top to bottom: the hero and its walk-through, what a group gets, who it is for, the rules, and one way in', () => {
  const html = render();
  assert.deepEqual(text(html), [
    'Private communities',
    'An app for your group, made by your group',
    // Two sentences, a line each.
    'Say what your group needs and Homeroom builds it.', 'Only the people you invite can see it.',
    'Join the waitlist',
    'Explore public apps',
    'Private to the people you invite', 'Your group votes on every change', 'No code needed, just say what you need',
    // The walk-through's window: the app's sidebar, then its top bar.
    'Home', 'Communities', 'Homeroom bot', 'Messages', '6', 'Projects',
    'Friday Supper Club', 'App', 'Hub', 'Needs you', '1', 'Workshop', 'general',
    'Search apps and communities…', '⌘K',
    // Scene one, the hub. Every word of the walk-through is made up.
    'Friday Supper Club', 'Private · 12 members',
    'Weekly supper, planned by all of us.', 'One dish each, no flakes. This week: ramen night.', 'Open app', 'Invite',
    ...SUPPER, ...SUPPER_END,
    'A', '+4', '9 active this week', 'maya.eats, kai, samwich, ari.k, leo_bakes…',
    'For you', 'Needs you', '1 change up for a vote', '1', 'Workshop', 'What happened, and every item',
    '#general · who’s on dessert??', 'samwich · now', '12',
    // Scene two, a change up for the vote, before anybody here has voted.
    'Needs you', 'Changes your group is deciding on.',
    'maya.eats', 'proposed · 2h', 'Group vote',
    'Add a “who’s bringing what” list',
    ...SUPPER, ...SUPPER_END,
    'Try it first', 'Preview the change in the real app before you vote.', 'Preview',
    '3 of 5 yes', 'Vote yes', 'Not yet', 'Approved · going live',
    // Scene three, a comment on the app: its box is empty until it is typed.
    'Comment mode', '· click anything to send feedback',
    ...SUPPER, 'Feedback on “dessert”', 'Goes to Workshop', 'Send', ...SUPPER_END,
    'Feedback sent to Workshop',
    // Scene four, the thread where it becomes a change.
    'Workshop', 'Where feedback turns into changes.',
    'Show who’s veggie on the list', 'Feedback',
    'you', 'left feedback on', 'dessert', '· 1m', 'could it show who’s veggie? i’d plan dessert around it',
    'maya.eats', 'now', 'yes!! half of us are veggie. drafting it now',
    'Homeroom bot', 'BOT', 'now', 'Draft’s ready. Each name gets a little leaf if they’re veggie.', 'Preview change',
    'P', 'priyaaa', 'now', 'cute. voted yes',
    'Reply in Workshop',
    'The hub', 'Vote on changes', 'Comment on the app', 'Talk it over',
    'What your group gets',
    'One place to talk, decide and build.',
    'Private by default', 'Only the people you invite can see it.',
    'See who’s around', 'Who’s been active this week, at a glance.',
    'Vote on every change', 'Nothing ships until your group says yes.',
    'Comment right on the app', 'Click the exact spot and send feedback.',
    'Talk it over', 'Every idea gets its own thread in Workshop.',
    'Credit for every helper', 'Help build it, get credit for it.',
    'Who it’s for',
    'Made for groups like yours',
    'One app to bring your people together.',
    'Friend groups', 'Plan trips, share lists, and make decisions together.',
    'School clubs & classes', 'Sign-ups, shared resources, and anything your class needs.',
    'Local clubs', 'Keep your club organized with events, logs, and shared plans.',
    'Studios & collectives', 'Project schedules, shared lists, and resources for your studio.',
    'Neighborhoods', 'A shared toolkit, potluck list, and notice board for your street.',
    'Towns & cities', 'Event boards, volunteer sign-ups, and polls for the whole community.',
    'Your group, your rules',
    'Only the people you invite can see the app, and your group chooses who approves changes.',
    'Default', 'You or the group', 'Your yes, or a yes from most of the group.',
    'Two approvals', 'Any two people approve.',
    'Open floor', 'Any member’s yes is enough.',
    'Group vote', 'Most active members approve.',
    'Bring your group.',
    message('auth:guest.groups.closing.body'),
    'Join the waitlist',
  ]);
  // One headline for the page; a heading for each of its three sections and
  // the closing band.
  assert.equal([...html.matchAll(/<h1 /g)].length, 1);
  assert.equal([...html.matchAll(/<h2[ >]/g)].length, 4);
  // Six things a group gets, six kinds of group, four rules.
  assert.equal([...html.matchAll(/<h3[ >]/g)].length, 6 + 6 + 4);
  assert.deepEqual([...html.matchAll(/data-guest-groups-get="([a-z]+)"/g)].map((m) => m[1]), ['private', 'around', 'vote', 'comment', 'talk', 'credit']);
  // Who it is for is drawn three ways, not as six identical cards: a
  // photograph, two tinted cards, and three as a line each under a rule.
  assert.match(html, /<section data-guest-groups-for="" class="gr">/);
  assert.deepEqual([...html.matchAll(/data-guest-groups-kind="([a-z]+)"/g)].map((m) => m[1]), ['friends', 'school', 'clubs', 'studios', 'neighbors', 'towns']);
  assert.equal([...html.matchAll(/<article class="gr-photo"/g)].length, 1);
  assert.deepEqual([...html.matchAll(/<article class="gr-card (blue|green)"/g)].map((m) => m[1]), ['blue', 'green']);
  assert.equal([...html.matchAll(/<ul class="gr-more">(?:<li data-guest-groups-kind="[a-z]+"><h3>.*?<\/h3><p>[^<]+<\/p><\/li>){3}<\/ul>/g)].length, 1);
});

test('the walk-through: four scenes whose steps count up, and the first one up before anything has run', () => {
  const { SCENES, lastStep, RESUME_MS } = loadTsx(PAGE);
  assert.deepEqual(SCENES.map((s) => s.key), ['hub', 'needs', 'app', 'workshop']);
  for (const [n, scene] of SCENES.entries()) {
    // Steps 1, 2, 3 … in the order they arrive, all before the scene ends.
    assert.deepEqual(scene.steps.map((s) => s[1]), scene.steps.map((_, i) => i + 1), `${scene.key}'s steps count up from 1`);
    const times = scene.steps.map((s) => s[0]);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${scene.key}'s steps arrive in order`);
    assert.ok(times[times.length - 1] < scene.ms, `${scene.key} ends after its last step`);
    assert.equal(lastStep(n), scene.steps.length);
  }
  assert.equal(RESUME_MS, 1400);

  // Every part drawn for a step names a step its scene has, and every step
  // of a scene draws something.
  const src = read(PAGE);
  const used = SCENES.map(() => new Set());
  for (const m of src.matchAll(/\b(?:on|reached)\((\d), (\d|TYPE_STEP)\)/g)) {
    const step = m[2] === 'TYPE_STEP' ? Number(src.match(/const TYPE_STEP = (\d);/)[1]) : Number(m[2]);
    assert.ok(step >= 1 && step <= lastStep(Number(m[1])), `scene ${m[1]} has a step ${step}`);
    used[Number(m[1])].add(step);
  }
  for (const [n, scene] of SCENES.entries()) assert.equal(used[n].size, scene.steps.length, `every step of ${scene.key} draws something`);

  // BEFORE ANYTHING HAS RUN (the first render): the hub is up, none of its
  // parts has arrived, its tab is the chosen one, and its row is lit in the
  // window's sidebar.
  const html = render();
  assert.match(html, /<div class="hr-demo" data-guest-groups-demo="hub" role="region" aria-label="A walk through a private community on Homeroom">/);
  assert.deepEqual([...html.matchAll(/<section class="hr-scene( is-on)?" data-scene="([a-z]+)">/g)].map((m) => [m[2], Boolean(m[1])]),
    [['hub', true], ['needs', false], ['app', false], ['workshop', false]]);
  assert.doesNotMatch(html, /class="[^"]*(?<![\w-])on(?![\w-])[^"]*"/, 'no part has arrived yet');
  assert.match(html, /<span class="hx-nav is-on"><svg[^>]*>.*?<\/svg>Hub<\/span>/);
  assert.equal([...html.matchAll(/class="hx-nav is-on"/g)].length, 1);
  assert.deepEqual([...html.matchAll(/<button type="button" role="tab" aria-selected="(true|false)" data-guest-groups-tab="([a-z]+)" class="hr-tab( is-on)?" style="--d:(\d+)ms">/g)].map((m) => [m[2], m[1], Boolean(m[3]), Number(m[4])]),
    SCENES.map((s, n) => [s.key, String(n === 0), n === 0, s.ms]));
  // The vote stands at three of five, and the comment box is empty, so its
  // placeholder shows.
  assert.match(html, /<span class="hx-fill" style="width:60%"><\/span>/);
  assert.match(html, /<div class="tx" data-placeholder="Say what you’d change…"><\/div>/);

  // WHAT MOVES IT. A scene's timers are keyed on the scene, the run and
  // whether it is held; a pointer over the window plays the scene out and
  // holds it, and leaving starts the next one a moment later.
  assert.match(src, /\}, \[at\.scene, at\.run, at\.held, feedback\.length, show\]\);/);
  assert.match(src, /timers\.push\(setTimeout\(\(\) => show\(at\.scene \+ 1\), scene\.ms\)\);/);
  assert.match(src, /<div className="hx-win" onMouseEnter=\{hold\} onMouseLeave=\{letGo\}>/);
  assert.match(src, /resume\.current = setTimeout\(\(\) => show\(at\.scene \+ 1\), RESUME_MS\);/);
  // LESS MOTION: Settings › Reduce motion or the device's own preference
  // (lib/reduced-motion.ts) gets each scene played out and still; the tabs
  // still move between them.
  assert.match(src, /import \{ reducedMotion \} from '\.\.\/\.\.\/lib\/reduced-motion';/);
  assert.match(src, /if \(reducedMotion\(\)\) \{\s+\/\/ Played out and still: no timer moves it on\.\s+setTyped\(feedback\.length\);\s+setAt\(\(was\) => \(was\.held && was\.step === lastStep\(was\.scene\) \? was : \{ \.\.\.was, step: lastStep\(was\.scene\), held: true \}\)\);\s+return undefined;/);
  const css = read('public/css/app.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s+#auth-landing-screen \.hr-demo \.hr-scene, #auth-landing-screen \.hr-demo \.hr-step, #auth-landing-screen \.hr-demo \.hx-fill, #auth-landing-screen \.hr-demo \.hr-cursor \{ transition: none; \}/);
  assert.match(css, /:where\(html\[data-motion="reduce"\]\) #auth-landing-screen \.hr-demo \.hr-scene, [^{]+\{ transition: none; \}/);
  assert.match(css, /:where\(html\[data-motion="reduce"\]\) #auth-landing-screen \.hr-demo \.hr-tab\.is-on \.bar i \{ animation: none; width: 100%; \}/);

  // FOUR OF THE CARDS UNDER IT SHOW THEIR SCENE: the card's title is a
  // button whose press area is the whole card.
  assert.deepEqual([...html.matchAll(/<li class="wg-item" data-guest-groups-get="([a-z]+)"><img [^>]*><div><h3>(<button type="button" class="wg-go" title="See it in the demo">)?/g)].map((m) => [m[1], Boolean(m[2])]),
    [['private', false], ['around', true], ['vote', true], ['comment', true], ['talk', true], ['credit', false]]);
  assert.match(src, /\{ key: 'around', [^}]*scene: 0 \},\s+\{ key: 'vote', [^}]*scene: 1 \},\s+\{ key: 'comment', [^}]*scene: 2 \},\s+\{ key: 'talk', [^}]*scene: 3 \},/);
  assert.match(css, /#auth-landing-screen \.wg-go::after \{ content: ""; position: absolute; inset: 0; border-radius: 16px; \}/);
});

test('the approval rules are the product\'s four, in its order', () => {
  const html = render();
  // The four presets a community picks from, in the Who decides dialog's
  // order; a new one starts on the first, and only that one says so.
  const { PRESET_KEYS, DEFAULT_PRESET } = require('../src/services/governance-rules');
  assert.deepEqual([...html.matchAll(/data-guest-groups-rule="([a-z_]+)"/g)].map((m) => m[1]), [...PRESET_KEYS]);
  assert.equal(DEFAULT_PRESET, PRESET_KEYS[0], 'the pill sits on the rule a new community has');
  assert.equal([...html.matchAll(/>Default</g)].length, 1);
  assert.ok(html.indexOf('>Default<') < html.indexOf('Two approvals'));
  for (const key of PRESET_KEYS) {
    assert.ok(message(`auth:guest.groups.rules.${key}.line`).length <= 48, `${key}'s line is short`);
  }
  // Three are named as the dialog names them. The design calls the second
  // "Two approvals", where the dialog says "Two yeses": the page's names are
  // its own messages so that one can differ.
  for (const key of ['you_or_the_group', 'open_floor', 'group_vote']) {
    assert.equal(message(`auth:guest.groups.rules.${key}.name`), message(`dialogs:whoDecides.preset.${key}.name`));
  }
  assert.equal(message('auth:guest.groups.rules.two_yeses.name'), 'Two approvals');
  // The rule on the walk-through's change is the dialog's own name.
  assert.match(read(PAGE), /<span className="hx-pill blue">\{td\('dialogs:whoDecides\.preset\.group_vote\.name'\)\}<\/span>/);
});

test('one way in, which says what it does and notes where the sign-up came from', () => {
  const waiting = render({ waitlist: true });
  const open = render({ waitlist: false });
  // The same button at the top and in the closing band.
  assert.equal([...waiting.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Join the waitlist<\/button>/g)].length, 2);
  assert.equal([...open.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Start a community<\/button>/g)].length, 2);
  assert.doesNotMatch(open, /Join the waitlist/);
  // Everything else that can be pressed moves the walk-through (its four
  // tabs, four cards under it) or goes back to the public apps, a plain
  // link to the guest Discover: this page and that one are two addresses of
  // one document. What is drawn inside the window is a picture: its Open
  // app, Invite, Vote yes and Send are not buttons.
  assert.equal([...waiting.matchAll(/<button /g)].length, 2 + 4 + 4);
  assert.deepEqual([...waiting.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/']);
  assert.match(waiting, /<button type="button" data-guest-groups-start="" class="[^"]*">Join the waitlist<\/button><a href="\/" data-guest-groups-public="" class="[^"]*bg-\[var\(--site-panel\)\][^"]*">Explore public apps<\/a>/);
  const src = read(PAGE);
  assert.match(src, /const start = \(\) => \{ noteSignUpFrom\('groups'\); onStart\(\); \};/);
  assert.match(src, /const startLabel = waitlist \? t\('auth:guest\.hero\.joinWaitlist'\) : t\('auth:guest\.groups\.start'\);/);
  // The server records that name and no other (tests/sign-up-from.test.js).
  assert.ok(require('../src/services/sign-up-from').SIGN_UP_FROM.includes('groups'));
  // No id of its own (tests/shell-id-inventory.test.js) and no drawing of its
  // own (tests/shell-icon-set.test.js): its glyphs are the shell's set, and
  // the logotype in the window is the shell's primitive.
  assert.doesNotMatch(waiting, / id="/);
  assert.doesNotMatch(src, /<svg|\sd="M/);
  assert.match(src, /<Wordmark className="hx-logo" \/>/);
});

test('its address: the landing draws it at /communities in Discover\'s place, and anybody may open that document', () => {
  assert.equal(loadTsx(STORY).COMMUNITIES_PATH, '/communities');
  const landing = read(LANDING);
  // Read in the first render, as the invite path is; the prerender has no location.
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && location\.pathname === COMMUNITIES_PATH,\s+\);/);
  assert.match(landing, /useEffect\(\(\) => \{ setOnGroupsPath\(location\.pathname === COMMUNITIES_PATH\); \}, \[\]\);/);
  // A project's page or a members' link's sheet named by the hash still comes first.
  assert.match(landing, /const groupsPage = guestPages && onGroupsPath && !guestProject && !linkPending && !gate;/);
  // In the guest Discover's place, under either drawing of it.
  assert.match(landing, /\{groupsPage \? \(\s+<GuestCommunities waitlist=\{accountsWait\} onStart=\{\(\) => setSheet\('start'\)\} \/>\s+\) : \(\s+<>/);
  const at = landing.indexOf('<GuestCommunities');
  assert.ok(at > 0 && at < landing.indexOf('<LandingFrame') && at < landing.indexOf('<GuestDiscover'));

  // A visitor with no account is who it is for: the anonymous redirect and
  // the waiting-room gate both leave that one pathname alone.
  const auth = read('src/middleware/auth.js');
  const source = auth.match(/function isSpaDocumentPath\(pathname\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'isSpaDocumentPath is one function');
  const isSpaDocumentPath = new Function(`${source[0]}; return isSpaDocumentPath;`)();
  assert.equal(isSpaDocumentPath('/communities'), true);
  assert.equal(isSpaDocumentPath('/'), true);
  assert.equal(isSpaDocumentPath('/app/notes-9206f8'), true);
  // Narrow: nothing under it and nothing beside it.
  assert.equal(isSpaDocumentPath('/communities/'), false);
  assert.equal(isSpaDocumentPath('/communities/anything'), false);
  assert.equal(isSpaDocumentPath('/community'), false);
  assert.equal(isSpaDocumentPath('/dashboard'), false);
});

test('drawn in the website\'s look: the hero frame, the green, a soft sky, and every colour outside the walk-through a variable of that look', () => {
  const html = render();
  const src = read(PAGE);
  const css = read('public/css/app.css');
  // THE LANDING'S HERO FRAME: the sky band is the clouds with a white window
  // in it. From lg the words stand on the left and the walk-through in a
  // column of the page's ground beside them.
  assert.match(html, /<section class="site-band site-clouds \[--band:var\(--site-sky\)\] [^"]*"><div class="border border-\[color:var\(--site-line\)\] bg-\[var\(--site-panel\)\] lg:grid lg:grid-cols-\[minmax\(0,0\.92fr\)_minmax\(0,1\.08fr\)\] lg:items-stretch">/);
  assert.match(html, /<div class="[^"]* hidden md:block">Private communities<\/div><h1 class="font-\[family-name:var\(--site-display\)\] font-\[460\] [^"]*">An app for your group, made by your group<\/h1>/);
  assert.match(html, /<span class="block">Say what your group needs and Homeroom builds it\.<\/span> <span class="block">Only the people you invite can see it\.<\/span>/);
  assert.match(html, /<ul data-guest-groups-points="" class="hr-points">(?:<li><svg[^>]*>.*?<\/svg>[^<]+<\/li>){3}<\/ul>/);
  assert.match(html, /<div class="hr-demo-col" data-guest-groups-hub=""><div class="hr-demo"/);
  assert.match(css, /@media \(min-width: 1024px\) \{\s+#auth-landing-screen \.hr-points \{[^}]*\}\s+#auth-landing-screen \.hr-demo-col \{ display: flex; align-items: center; padding: 36px 32px; background: var\(--site-ground\); border-inline-start: 1px solid var\(--site-line\); \}/);
  // The first button is the landing's sun pill and the one beside it its
  // white pill (features/auth/story.tsx).
  assert.match(html, /<button type="button" data-guest-groups-start="" class="[^"]*bg-\[var\(--site-sun\)\] text-\[color:var\(--site-on-sun\)\]"/);
  assert.match(src, /import \{ HERO_PRIMARY, HERO_SECONDARY, SITE_LABEL \} from '\.\.\/auth\/story';/);

  // DOWN THE PAGE: the green with stars under what a group gets and under
  // the rules, the page's own ground between them, and a soft sky to close.
  // Each is a picture laid edge to edge as the clouds are.
  assert.deepEqual([...html.matchAll(/<section data-guest-groups-([a-z]+)="" class="([^" ]+)/g)].map((m) => [m[1], m[2]]),
    [['gets', 'wg'], ['for', 'gr'], ['decides', 'site-stars'], ['closing', 'site-sky-soft']]);
  assert.match(html, /<section data-guest-groups-gets="" class="wg site-stars">/);
  assert.match(css, /#auth-landing-screen :is\(\.site-stars, \.site-sky-soft\)::before \{\s+content: "";\s+position: absolute;\s+z-index: -1;\s+inset-block: 0;\s+left: 50%;\s+width: var\(--platform-usable-w\);\s+transform: translateX\(-50%\);\s+\}/);
  assert.match(css, /#auth-landing-screen \.site-stars::before \{ background: #a9cf97 url\('\/brand\/groups\/stars\.webp'\) center \/ cover no-repeat; \}/);
  // The soft sky is the brand kit's own (public/brand/bg/), not a second copy.
  assert.match(css, /#auth-landing-screen \.site-sky-soft::before \{ background: #8ec3e6 url\('\/brand\/bg\/sky\.webp'\) center \/ cover no-repeat; \}/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/brand/bg/sky.webp')));
  // This page's headings are the hero's serif at every size.
  assert.match(css, /#auth-landing-screen \[data-guest-groups\] \{\s+--site-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;\s+\}/);

  // No colour of the app's own palette and no dark class: outside the
  // walk-through the look's variables are the only inks, and the dark shell
  // moves them in one rule.
  assert.doesNotMatch(src, /\b(?:text|bg|border|shadow)-(?:zinc|violet|white|black)\b/);
  assert.doesNotMatch(src, /\bdark:/);
  for (const name of new Set([...src.matchAll(/var\((--site-[a-z-]+)\)/g)].map((m) => m[1]))) {
    assert.match(css, new RegExp(`#auth-landing-screen \\{[^}]*${name}:`), `${name} is declared for the light shell`);
  }
  const dark = css.match(/\.dark #auth-landing-screen \{[^}]*\}/);
  assert.ok(dark, 'the dark shell moves the look\'s variables in one rule');
  for (const name of ['--site-ink', '--site-muted', '--site-line', '--site-sky', '--site-ground', '--site-panel', '--site-sky-pale', '--site-mint', '--site-line-soft', '--site-card-sky', '--site-card-leaf', '--site-card-words']) {
    assert.ok(dark[0].includes(`${name}:`), `${name} has a dark value`);
  }
  // Sun keeps its ink words in the dark shell too, and so do the green and
  // the soft sky, which are the same picture in both modes.
  assert.doesNotMatch(dark[0], /--site-sun:|--site-on-sun:|--site-on-band:/);
  assert.match(css, /--site-on-band: #000000;/);
  assert.match(css, /html:not\(\[data-skin\]\) #auth-landing-screen:has\(:is\(\[data-guest-discover\], \[data-guest-groups\]\)\) \{\s+background: var\(--site-ground\);/);
  // THE WALK-THROUGH IS A PICTURE OF THE APP: one palette of its own, which
  // no dark rule moves.
  assert.match(css, /#auth-landing-screen \.hr-demo \{\s+--ink: #14161a;/);
  assert.doesNotMatch(css, /\.dark [^{]*\.(?:hr|hx|sc)-[a-z]/);
  // And it mirrors: its parts are placed by their inline sides.
  assert.doesNotMatch(src, /style=\{\{ (?:left|right):/);
});

test('its pictures: each one drawn is shipped, each one shipped is drawn, and the README says where it came from', () => {
  const src = read(PAGE);
  const css = read('public/css/app.css');
  const shipped = fs.readdirSync(path.join(ROOT, 'public/brand/groups')).sort();
  const drawn = new Set([...css.matchAll(/url\('\/brand\/groups\/([a-z0-9-]+\.webp)'\)/g)].map((m) => m[1]));
  // The six drawings on the cards are named by the card's key.
  assert.match(src, /src=\{`\/brand\/groups\/benefit-\$\{item\.key\}\.webp`\} alt="" width=\{56\} height=\{56\} loading="lazy"/);
  for (const key of ['private', 'around', 'vote', 'comment', 'talk', 'credit']) drawn.add(`benefit-${key}.webp`);
  assert.deepEqual([...drawn].sort(), shipped);
  // A face in the walk-through is a class of the sheet, never a file named in markup.
  for (const m of src.matchAll(/\bav-([a-z0-9]+)\b/g)) assert.ok(shipped.includes(`avatar-${m[1]}.webp`), `avatar-${m[1]}.webp ships`);
  const readme = read('public/brand/README.md');
  for (const file of shipped) assert.ok(readme.includes(`groups/${file}`) || readme.includes(`\`${file}\``), `${file} is in the README`);
  // Small enough to sit on a marketing page: the lot is under 250 KB.
  const bytes = shipped.reduce((sum, file) => sum + fs.statSync(path.join(ROOT, 'public/brand/groups', file)).size, 0);
  assert.ok(bytes < 250 * 1024, `${bytes} bytes of pictures`);
});
