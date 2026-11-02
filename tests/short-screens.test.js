// Short and odd-shaped screens (overnight UI audit, 1 to 2 November 2026,
// batch 4). Each test names the finding it pins; the layout itself is
// checked on every shape by `npm run audit:layout` (scripts/layout-audit),
// whose made-up world now carries a request page and an install strip.
//
// Run with: node --test tests/short-screens.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');

// The declarations of the first rule whose selector is exactly `selector`.
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = APP_CSS.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no rule for ${selector}`);
  return m[1];
}

test('L01: the strips above the header are reserved on every screen, not only a paged one', () => {
  // Communities, Messages, the bot and a request are the fixed shell: the
  // token was 0 there, so the rail started a strip's height too high and its
  // Home row was printed over the page's title.
  assert.match(rule('body.has-install-strip'), /--browser-banner-h: var\(--install-strip-h\);/);
  assert.match(rule('body.is-offline'), /--browser-banner-h: var\(--offline-strip-h\);/);
  assert.match(rule('body.is-offline.has-install-strip'), /--browser-banner-h: calc\(var\(--offline-strip-h\) \+ var\(--install-strip-h\)\);/);
  // Declared before the paged rules, which say the same and outrank it.
  assert.ok(APP_CSS.indexOf('body.has-install-strip { --browser-banner-h') < APP_CSS.indexOf('html[data-browser-scroller] body.has-install-strip {'));
  // The rail reads it, as it always did.
  assert.match(APP_CSS, /\.platform-tabs \{[\s\S]{0,400}top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\)/);
});

test('L01: the bot\'s columns start under the strips too', () => {
  for (const sel of ['#ai-screen .ai-main-pane', '#ai-screen .ai-preview-pane', '#ai-main-divider']) {
    assert.match(rule(sel), /top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) - \.5rem\);/, sel);
  }
  assert.doesNotMatch(APP_CSS, /\n\s*top: calc\(var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) - \.5rem\);/,
    'nothing under the header starts from it without the strips');
});

test('the layout audit\'s world has a request page and a phone browser\'s install strip', async () => {
  const { answer, SCREENS } = await import(path.join(ROOT, 'scripts/layout-audit/fixtures.mjs'));
  const { PROFILES } = await import(path.join(ROOT, 'scripts/layout-audit/profiles.mjs'));
  const get = (p) => answer('GET', new URL(`https://homeroom.test${p}`));
  assert.equal(get('/api/public/mobile-app').status, 200);
  assert.equal(get('/api/apps/audit-garden/github-issues/21').json.issue.number, 21);
  const request = SCREENS.find((s) => s.id === 'request');
  assert.ok(request && request.composer, 'the keyboard pass types a reply on it');
  const android = PROFILES.find((p) => p.id === 'android-chrome');
  assert.deepEqual([android.width, android.height, android.native, android.keyboard > 0], [360, 560, false, true]);
});

test('B25: on the Duo held sideways Main Chat stops at the column; its sheet still runs under it', () => {
  // Send, the "Live ›" row's chevron and the New label sat in the 84px column.
  assert.match(APP_CSS, /html\[data-side-strip="right"\] #ai-screen \.ai-main-pane \.messages-layout\[data-main-chat\] > \.messages-thread-pane,\nhtml\[data-side-strip="right"\] #ai-screen \.ai-main-pane \.messages-layout\[data-main-chat\] > \.messages-reply-pane :is\(\.chat-transcript, \.chat-status, \.chat-composer-bar\) \{\n  padding-right: var\(--ai-edge, 0px\);\n\}/);
  // The column itself still reaches the screen's edge (no band of another colour).
  assert.match(rule('#ai-screen .ai-main-pane'), /width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(rule('#ai-screen .ai-main-pane'), /right: 0;/);
});

test('B13: the bot list\'s heading keeps its line where the list is narrow', () => {
  assert.match(rule('#ai-screen [data-ai-hero]'), /container-type: inline-size;/);
  assert.match(APP_CSS, /@container \(max-width: 340px\) \{\n  #ai-screen \[data-ai-hero\] > img \{ display: none; \}\n\}/);
  assert.match(APP_CSS, /@container \(max-width: 260px\) \{\n  #ai-screen \[data-ai-hero\] h1 \{ font-size: 1\.25rem; \}\n\}/);
  // The hero is still marked so for the rule to find it.
  assert.match(read('frontend/src/features/ai/index.tsx'), /<section className="flex items-center gap-3 px-4 pt-3" data-ai-hero="">\n\s+<img src=\{BOT_AVATAR\}/);
});

test('L06: the bot\'s Needs you card shows its rows\' shape until the lists are read', () => {
  const src = read('frontend/src/features/ai/lists.tsx');
  assert.match(src, /empty=\{ready \? <p [^>]*data-ai-empty="">\{t\('messages:ai\.work\.empty'\)\}<\/p> : \(/);
  assert.match(src, /<SkeletonGroup label=\{t\('messages:ai\.work\.loading'\)\}[^>]*data-ai-loading="">/);
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.equal(catalog['ai.work.loading'].text, 'Loading what needs you');
  // Discover's list: the store's prerender value draws nothing, as before.
  assert.match(read('frontend/src/features/apps/browse-store.js'), /\n  loading: false,/);
  assert.match(read('frontend/src/features/apps/browse-screen.tsx'), /: state\.loading\n\s+\? <BrowseRowsLoading label=\{t\('discover:list\.loading'\)\} \/>/);
});

test('B14: the bot\'s Ask bar sticks on the tab bar, not behind it', () => {
  const at = APP_CSS.indexOf('#ai-screen .ai-drawer-list .ai-askbar {');
  assert.ok(at > 0);
  const body = APP_CSS.slice(at, APP_CSS.indexOf('}', at));
  assert.match(body, /position: sticky;/);
  assert.match(body, /bottom: var\(--platform-tabs-h, 0px\);/);
  assert.match(body, /margin-bottom: var\(--platform-tabs-h, 0px\);/, 'the last row still clears it, scrolled to the end');
});

test('the layout audit has the Android app\'s shape, with its navigation bar', async () => {
  const { PROFILES } = await import(path.join(ROOT, 'scripts/layout-audit/profiles.mjs'));
  const android = PROFILES.find((p) => p.id === 'android-small');
  assert.deepEqual([android.width, android.height, android.native, android.platform, android.insets.bottom], [360, 640, true, 'android', 48]);
  assert.ok(android.system.some((z) => z.name === 'navigation bar' && z.severity === 'error'));
  assert.match(read('scripts/layout-audit/run.mjs'), /un-platform=\$\{profile\.platform \|\| 'ios'\}/);
});

test('M01: on a narrow phone the lit Messages pill clears "Homeroom bot"; the audience chips fit at 393', () => {
  // Home's and You's short words give Messages' and the bot's seats room.
  assert.match(APP_CSS, /@media \(max-width: 767\.98px\) \{[\s\S]{0,400}#platform-tabs \{ grid-template-columns: \.85fr 1\.3fr 1\.4fr 1\.1fr \.85fr; \}/);
  assert.match(APP_CSS, /@media \(max-width: 374\.98px\) \{[\s\S]{0,300}#platform-tabs \{ grid-template-columns: \.85fr 1\.25fr 1\.35fr 1\.1fr \.85fr; \}/);
  assert.match(read('frontend/src/features/workshop/index.tsx'), /className=\{key !== 'all' && !count \? 'hidden' : 'gap-1\.5 px-3'\}/);
});

test('U03: the header\'s title is on the left from 640px, as on phones and the iPad', () => {
  // Between 640 and 768 the hook centred; the Duo upright (669px) had Home and
  // the bot centred and Messages (the drawer's absolutely-laid title,
  // measured 0px wide) cut to nothing.
  assert.match(APP_CSS, /@media \(min-width: 640px\) \{\n  #header-title\.is-centered \{\n    position: static;\n    transform: none;\n    flex: 1 1 auto;\n    text-align: left;/);
  assert.doesNotMatch(APP_CSS, /@media \(min-width: 768px\) \{\n  #header-title\.is-centered \{/);
  assert.match(read('frontend/src/features/header/use-header-layout.ts'), /const CENTER_MIN_WIDTH_PX = 640;/, 'the hook never centres below it');
});

test('U02: the Duo strip\'s ✕ is pressed as 32px, and "Communities" fits its lit pill', () => {
  assert.match(APP_CSS, /html\[data-side-strip\] \.platform-side-app-x::after \{\n    content: "";\n    position: absolute;\n    inset: -6px;\n  \}/);
  assert.match(APP_CSS, /html\[data-side-strip\] \.platform-side-app-x \{[^}]*width: 20px;\n    height: 20px;/, 'drawn as before: 20 + 6 + 6');
  assert.match(APP_CSS, /html\[data-side-strip\] #platform-tab-workshop \.platform-tab-label \{\n    font-size: 9px;\n    letter-spacing: -\.03em;\n  \}/);
});
