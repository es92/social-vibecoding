'use strict';

// The first look's DRAWN screen, shown until its picture is saved
// (15 October 2026).
//
// Newcomer run nine: the early first look's screen (services/first-version-
// early-look.js) was drawn well inside 20 seconds of Make it, but the worker
// its picture is drawn in took about 30 seconds longer than usual to start.
// The picture was saved 47.7 seconds in, the maker tapped Submit at 37, and
// the made screen's first look card showed an empty phone for 11 seconds.
// Now, while there is only the drawn screen:
//
//   - GET /api/apps/:slug says so (`first_version.screens.drawn`), and
//     GET /api/apps/:slug/first-version/first-look/drawn serves the screen as
//     the worker's own document, to the picture's readers only, under a CSP
//     that sandboxes it and lets nothing load (services/first-version-
//     screens.js readDrawnDocument, DRAWN_CSP);
//   - every place the first look shows frames it with sandbox="" at the
//     picture's size (frontend/src/features/first-session/drawn-look.tsx),
//     and the picture takes its place once it is in.
//
// Run with: node --test tests/first-look-drawn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The route module's heavy neighbours, as tests/app-contributors-route.test.js stubs them.
for (const [mod, exports] of [
  ['../src/services/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }],
  ['../src/services/app-creator', { createApp: async () => {} }],
  ['../src/services/app-forker', { forkApp: async () => {} }],
  ['../src/services/caddy', { productionHostname: (slug) => `${slug}.example.test` }],
  ['../src/services/docker', { getHostPort: async () => null }],
  ['../src/services/github', { parseGithubUrl: () => null, isEnabled: () => false }],
  ['../src/services/main-drift-poller', { checkAndRedeployOne: async () => ({}) }],
  ['../src/services/app-secrets', {}],
  ['../src/services/app-manifest', { MAX_APP_NAME_LENGTH: 64 }],
  ['../src/services/rename-pr', {}],
  ['../src/services/staging', { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} }],
]) stub(require.resolve(mod), exports);

const fvs = require('../src/services/first-version-screens');
const early = require('../src/services/first-version-early-look');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;

// A real 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = '<template data-screen data-size="phone" data-height="900"><style>.poll{color:rgb(var(--fg))}</style>'
  + '<div data-side="after" data-change="1"><h1>Club Votes</h1><ul class="list"><li class="list-row poll">Pizza night?</li></ul>'
  + '<img src="https://example.test/logo.png" alt=""><script>alert(1)</script></div></template>';
const NOTE = 'One screen: the open polls. Its primary action is New poll.';
const DRAWN_AT = new Date('2026-10-14T19:01:17.000Z');
const SAVED_AT = new Date('2026-10-14T19:01:48.000Z');
const DRAWN_URL = '/api/apps/club-votes/first-version/first-look/drawn?v=17';

/** A pool that answers each query from the first pattern it matches. */
function fakePool(answers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      for (const [re, rows] of answers) if (re.test(String(sql))) return { rows: typeof rows === 'function' ? rows(params) : rows };
      return { rows: [] };
    },
  };
}

const lookRow = (over = {}) => ({
  status: 'drawn', screen: SCREEN, png: null, has_png: false, has_screen: true,
  drawn_at: DRAWN_AT, saved_at: null, plan_note: NOTE, created_at: DRAWN_AT, ...over,
});
const RUN = /FROM homeroom_bot_first_versions f\s+JOIN homeroom_bot_runs r/;
const LOOK = /FROM first_version_early_looks l/;

// ── What the server says and serves ──────────────────────────────────────

test('shownFor offers the drawn screen from the moment it is drawn, and the picture once it is saved', async () => {
  const at = async (row, run = null) => early.shownFor(fakePool([[LOOK, row ? [row] : []]]), 1, run);
  assert.deepEqual(await at(lookRow()), { at: DRAWN_AT, drawn: true }, 'drawn: the screen itself');
  assert.deepEqual(await at(lookRow({ status: 'ready', png: PNG, has_png: true, saved_at: SAVED_AT })), { at: SAVED_AT, drawn: false }, 'pictured');
  assert.equal(await at(lookRow({ status: 'pending', screen: null, has_screen: false })), null, 'still being drawn');
  assert.equal(await at(lookRow({ status: 'failed' })), null, 'a drawing whose picture failed is not shown: the spec draws its own');
  assert.equal(await at(lookRow({ has_screen: false })), null);
  assert.equal(await at(null), null);
  // Only for the run built from its plan, as before.
  assert.deepEqual(await at(lookRow(), { build_note: `${NOTE}\n\nWhat its creator approved: …` }), { at: DRAWN_AT, drawn: true });
  assert.equal(await at(lookRow(), { build_note: 'A plan made again' }), null);
  // The switch turns it off with the rest.
  process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK = '0';
  try {
    assert.equal(await at(lookRow()), null);
    assert.equal(await early.screenFor(fakePool([[LOOK, [lookRow()]]]), 1), null);
  } finally {
    delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;
  }
});

test('screenFor hands over the drawn screen while it is drawn or pictured, never once it failed', async () => {
  const of = async (row, run = null) => early.screenFor(fakePool([[LOOK, row ? [row] : []]]), 1, run);
  assert.equal(await of(lookRow()), SCREEN);
  assert.equal(await of(lookRow({ status: 'ready', png: PNG })), SCREEN, 'a frame asked for as the picture is saved still has it');
  for (const status of ['pending', 'failed']) assert.equal(await of(lookRow({ status })), null, status);
  assert.equal(await of(lookRow({ screen: null })), null);
  assert.equal(await of(lookRow(), { build_note: 'A plan made again' }), null);
});

test('the App tab is told the first look is only drawn so far, and then that it is pictured', async () => {
  const showcase = await fvs.showcaseOf(fakePool([[RUN, []], [LOOK, [lookRow()]]]), 1);
  assert.deepEqual(showcase.screens, { first_look: { count: 1, at: DRAWN_AT.toISOString(), drawn: true } });
  assert.deepEqual(fvs.firstVersionShowcase(showcase, 'building').screens, {
    kind: 'first_look', count: 1, at: DRAWN_AT.toISOString(), v: String(DRAWN_AT.getTime()), drawn: true,
  });
  // Pictured: the picture, at a new version, and no `drawn` at all.
  const pictured = await fvs.showcaseOf(fakePool([[RUN, []], [LOOK, [lookRow({ status: 'ready', png: PNG, has_png: true, saved_at: SAVED_AT })]]]), 1);
  assert.deepEqual(fvs.firstVersionShowcase(pictured, 'building').screens, {
    kind: 'first_look', count: 1, at: SAVED_AT.toISOString(), v: String(SAVED_AT.getTime()),
  });
  // The spec's own first look is never "drawn", and real screens never are.
  assert.equal('drawn' in fvs.firstVersionShowcase({ screens: { first_look: { count: 1, at: null } } }, 'building').screens, false);
  assert.equal('drawn' in fvs.firstVersionShowcase({ screens: { real: { count: 2, at: null }, first_look: { count: 1, at: null, drawn: true } } }, 'testing').screens, false);
});

test('the drawn screen is served as the worker\'s own document, with nothing in it that would run or load', async () => {
  const doc = await fvs.readDrawnDocument(fakePool([[RUN, []], [LOOK, [lookRow()]]]), 1);
  assert.match(doc, /^<!doctype html><html data-side="after"><head><meta charset="utf-8">/);
  assert.ok(doc.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">'));
  assert.ok(doc.includes('<h1>Club Votes</h1><ul class="list"><li class="list-row poll">Pizza night?</li></ul>'));
  assert.ok(doc.includes('<style>.poll{color:rgb(var(--fg))}</style>'), 'its own styles');
  assert.doesNotMatch(doc, /<script|example\.test/, 'nothing the CSP would refuse, so nothing is logged');
  assert.ok(doc.includes('<img alt="">'));
  // The same document the picture is drawn from, but for what is taken out.
  const screen = fvs.mainScreenOf(fvs.screenDocument(SCREEN));
  assert.equal(doc, fvs.firstLookDocument({ ...screen, markup: fvs.inertMarkup(screen.markup) }));

  // A run built from the plan, with no first look of its own yet: still the drawn screen.
  const run = [{ id: 3, build_caption: null, build_note: `${NOTE}\n\nWhat its creator approved: …` }];
  assert.ok(await fvs.readDrawnDocument(fakePool([[RUN, run], [/FROM first_version_screens/, []], [LOOK, [lookRow()]]]), 1));
  // Its own first look replaces it.
  assert.equal(await fvs.readDrawnDocument(fakePool([[RUN, run], [/FROM first_version_screens/, [{ 1: 1 }]], [LOOK, [lookRow()]]]), 1), null);
  // Nothing drawn, or a drawing that failed: nothing.
  assert.equal(await fvs.readDrawnDocument(fakePool([[RUN, []], [LOOK, [lookRow({ status: 'failed' })]]]), 1), null);
  assert.equal(await fvs.readDrawnDocument(fakePool([[RUN, []]]), 1), null);
  assert.equal(await fvs.readDrawnDocument(fakePool([[RUN, []], [LOOK, [lookRow({ screen: '<template data-screen></template>' })]]]), 1), null);
});

test('inertMarkup takes out what the frame\'s CSP would refuse, and keeps the screen', () => {
  const dirty = '<div data-side="after" onclick="x()" style="background:url(https://evil.test/a.png) red">'
    + '<script>alert(1)</script><noscript><img src="https://evil.test/n.png"></noscript><img src="https://evil.test/p.png" alt="p">'
    + '<img src="data:image/png;base64,AAAA" alt="d" onerror="x()">'
    + '<link rel="stylesheet" href="https://evil.test/s.css"><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">'
    + '<style>@import url("https://evil.test/x.css"); .a{background:url(\'/x.png\')} .b{background:url(data:image/png;base64,AA)}</style>'
    + '<svg><use href="#icon"/><image href="https://evil.test/i.png"/></svg><a href="https://evil.test" ping="https://evil.test">Link</a>'
    + '<iframe src="https://evil.test" srcdoc="<p>x</p>"></iframe><object data="https://evil.test/o"></object>'
    + '<video poster="https://evil.test/v.png"><source src="https://evil.test/v.mp4"></video>'
    + '<form action="https://evil.test"><button formaction="https://evil.test">Go</button></form><p title="a > b" class=card>Text</p><input disabled></div>';
  assert.equal(fvs.inertMarkup(dirty),
    '<div data-side="after" style="background:none red"><img alt="p"><img src="data:image/png;base64,AAAA" alt="d">'
    + '<style> .a{background:none} .b{background:url(data:image/png;base64,AA)}</style>'
    + '<svg><use href="#icon"/><image/></svg><a>Link</a><form><button>Go</button></form><p title="a > b" class=card>Text</p><input disabled></div>');
  assert.equal(fvs.inertMarkup(null), '');
});

test('the CSP: sandboxed, nothing loads but inline styles and data', () => {
  assert.equal(fvs.DRAWN_CSP, "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  const policy = new Map(fvs.DRAWN_CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(policy.get('sandbox'), '', 'no allow-scripts, no allow-same-origin, nothing allowed');
  assert.equal(policy.get('default-src'), "'none'");
  assert.equal([...policy.keys()].some((k) => /script|connect|frame|child|worker|form-action/.test(k)), false);
});

// ── The route ────────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let appRow = null;
let look = lookRow();
poolMod.getPool = () => ({
  async query(sql) {
    const s = String(sql);
    if (/FROM apps WHERE slug = \$1/.test(s)) return { rows: appRow ? [appRow] : [] };
    if (RUN.test(s)) return { rows: [] };
    if (LOOK.test(s)) return { rows: look ? [look] : [] };
    return { rows: [] };
  },
});
const { appRoutes } = require('../src/routes/apps');
const communities = require('../src/services/communities');
const express = require('express');

let currentUser = null;
let members = new Set();

async function withServer(fn) {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ selfAppPublicVoting: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const realIsMember = communities.isMember;
  communities.isMember = async (_pool, _appId, userId) => members.has(Number(userId));
  try {
    const get = async (p) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    };
    await fn(get);
  } finally {
    communities.isMember = realIsMember;
    server.close();
  }
}

const MAKER = 10;
const MEMBER = 11;
const READER = 12;

function reset(over = {}) {
  appRow = { id: 7, slug: 'club-votes', created_by: MAKER, self_hosted: false, collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null, ...over };
  look = lookRow({ status: 'ready', png: PNG, has_png: true, saved_at: SAVED_AT });
  members = new Set([MAKER, MEMBER]);
  currentUser = { id: MEMBER, isAdmin: false };
}

const DRAWN = '/api/apps/club-votes/first-version/first-look/drawn?v=1';
const PICTURE = '/api/apps/club-votes/first-version/screens/first_look/0?v=1';

test('GET …/first-look/drawn: an inert document, private, for the same readers as the picture', async () => {
  reset();
  await withServer(async (get) => {
    const res = await get(DRAWN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-security-policy'), fvs.DRAWN_CSP);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600', 'cached no longer than the picture');
    const doc = res.body.toString('utf8');
    assert.match(doc, /^<!doctype html>/);
    assert.ok(doc.includes('Pizza night?'));
    assert.doesNotMatch(doc, /<script/);

    // The picture's readers, and only they: a member, its maker (a member).
    const both = async () => [(await get(DRAWN)).status, (await get(PICTURE)).status];
    assert.deepEqual(await both(), [200, 200], 'a member');
    currentUser = { id: MAKER, isAdmin: false };
    assert.deepEqual(await both(), [200, 200], 'its maker');
    for (const [who, user] of [['a reader who is not a member', { id: READER, isAdmin: false }], ['signed out', null]]) {
      currentUser = user;
      assert.deepEqual(await both(), [404, 404], who);
    }
    // A maker who left the community reads neither.
    members.delete(MAKER);
    currentUser = { id: MAKER, isAdmin: false };
    assert.deepEqual(await both(), [404, 404], 'a maker who is not a member');
    // A private project its member may not view, and a project that is not there.
    reset({ view_visibility: 'private' });
    assert.deepEqual(await both(), [404, 404], 'no view access');
    reset();
    appRow = null;
    assert.deepEqual(await both(), [404, 404], 'no project');
    // Nothing drawn: 404, as for a picture that is not there, and still inert.
    reset();
    look = lookRow({ status: 'failed' });
    const none = await get(DRAWN);
    assert.equal(none.status, 404);
    assert.equal(none.headers.get('content-security-policy'), fvs.DRAWN_CSP, 'every answer is framed inert, the 404 too');
    assert.equal(none.headers.get('x-content-type-options'), 'nosniff');
    // Drawn but not pictured: the document, and no picture yet.
    look = lookRow();
    assert.deepEqual(await both(), [200, 404]);
  });
});

test('the frame\'s navigation goes past the service worker to the server, never to the cached shell', () => {
  const { classifyRequest } = require('../public/sw.js');
  const origin = 'https://homeroom.example';
  assert.equal(classifyRequest('GET', `${origin}${DRAWN}`, 'text/html', 'navigate', origin), 'bypass');
});

// ── The shell ────────────────────────────────────────────────────────────

const DIR = 'frontend/src/features/first-session';
const drawnLook = loadTsx(`${DIR}/drawn-look.tsx`);

test('a drawn first look has its own URL, spelled alike by the made screen, the hub and the App tab', () => {
  const { drawnLookUrl, isDrawnLook } = drawnLook;
  const { firstLookSrc } = loadTsx(`${DIR}/first-look.tsx`);
  const body = (screens) => ({ app: { first_version: { line: 'building', screens } } });
  assert.equal(drawnLookUrl('club-votes', '17'), DRAWN_URL);
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17', drawn: true }), 'club-votes'), DRAWN_URL);
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17', drawn: true }), 'club-votes', ['first_look']), DRAWN_URL, 'the hub\'s');
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17' }), 'club-votes'), '/api/apps/club-votes/first-version/screens/first_look/0?v=17');
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17', drawn: 'yes' }), 'club-votes'), '/api/apps/club-votes/first-version/screens/first_look/0?v=17');
  assert.equal(firstLookSrc(body({ kind: 'real', count: 2, v: '9', drawn: true }), 'club-votes'), '/api/apps/club-votes/first-version/screens/real/0?v=9', 'only a first look is ever drawn');
  assert.equal(isDrawnLook(DRAWN_URL), true);
  assert.equal(isDrawnLook('/api/apps/club%20votes/first-version/first-look/drawn'), true);
  for (const src of ['/api/apps/club-votes/first-version/screens/first_look/0?v=17', 'https://x.test/api/apps/a/first-version/first-look/drawn', '/api/apps/a/b/first-version/first-look/drawn', null, undefined, '']) {
    assert.equal(isDrawnLook(src), false, String(src));
  }
  // The App tab's legacy half spells the same URL (public/js/app-view.js _firstVersionScreens).
  const appView = read('public/js/app-view.js');
  assert.match(appView, /if \(sc\.kind === 'first_look' && sc\.drawn === true\) \{\s+return \{ kind: 'first_look', at, images: \[`\/api\/apps\/\$\{slug\}\/first-version\/first-look\/drawn\?v=\$\{v\}`\] \};/);
});

test('the frame: sandbox="", lazy, named, out of the tab order, takes no pointer, 390 × 844 scaled to its box', () => {
  const { DrawnLook, DRAWN_LOOK_WIDTH, DRAWN_LOOK_HEIGHT } = drawnLook;
  assert.deepEqual([DRAWN_LOOK_WIDTH, DRAWN_LOOK_HEIGHT], [390, 844]);
  const html = renderToHtml(createElement(DrawnLook, { src: DRAWN_URL, label: 'The first look at Club Votes', width: 50 }));
  assert.equal(html, '<div role="img" aria-label="The first look at Club Votes" data-first-look-drawn="" class="pointer-events-none absolute inset-0 overflow-hidden ">'
    + `<iframe src="${DRAWN_URL}" title="The first look at Club Votes" sandbox="" loading="lazy" referrerPolicy="no-referrer" scrolling="no" tabindex="-1" aria-hidden="true"`
    + ' class="absolute left-0 top-0 h-[844px] w-[390px] origin-top-left border-0 [color-scheme:light] " style="transform:scale(0.1282051282051282)"></iframe></div>');
  // Named by the box it is in.
  const hidden = renderToHtml(createElement(DrawnLook, { src: DRAWN_URL, label: 'x', width: 125, hidden: true }));
  assert.match(hidden, /^<div aria-hidden="true" data-first-look-drawn=""/);
  assert.match(hidden, /scale\(0\.32051282051282054\)/);
  // A box of no fixed width is measured before it is shown.
  assert.match(renderToHtml(createElement(DrawnLook, { src: DRAWN_URL, label: 'x' })), /class="[^"]*\[color-scheme:light\] opacity-0"><\/iframe>/);
  // Never anything that would let it run or reach out.
  const src = read(`${DIR}/drawn-look.tsx`);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /allow-scripts|allow-same-origin|allow-forms|allow-popups|srcDoc|dangerouslySetInnerHTML/);
});

test('a picture after a drawn screen waits until it is in; anything else is drawn as it comes', () => {
  const { holdsDrawn } = drawnLook;
  const PICTURE_URL = '/api/apps/club-votes/first-version/screens/first_look/0?v=48';
  assert.equal(holdsDrawn(DRAWN_URL, PICTURE_URL), true, 'the drawn screen stays until its picture is in');
  assert.equal(holdsDrawn(null, PICTURE_URL), false, 'nothing to keep');
  assert.equal(holdsDrawn(DRAWN_URL, null), false, 'gone: gone');
  assert.equal(holdsDrawn(DRAWN_URL, DRAWN_URL), false);
  assert.equal(holdsDrawn(DRAWN_URL, '/api/apps/club-votes/first-version/first-look/drawn?v=18'), false, 'drawn again: at once');
  assert.equal(holdsDrawn(PICTURE_URL, '/api/apps/club-votes/first-version/screens/real/0?v=60'), false, 'picture to picture: as before');
});

test('the made screen\'s first look card: the drawn screen faded in over the outline, then the picture cut in', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  const card = (src) => renderToHtml(createElement(made.FirstLookCard, { src, name: 'Club Votes', progress: { setup: true, step: 3, slow: false, waitedOut: false } }));
  const html = card(DRAWN_URL);
  assert.match(html, /data-made-first-look="ready"/);
  assert.match(html, /data-made-first-look-phone="drawing"/, 'the outline until the frame has loaded');
  assert.match(html, /motion-safe:animate-card-sweep/);
  assert.match(html, /<div role="img" aria-label="The first look at Club Votes&#x27;s main screen" data-first-look-drawn="" class="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300 ease-out motion-reduce:transition-none opacity-0">/);
  assert.match(html, new RegExp(`<iframe src="${DRAWN_URL.replace(/[?.]/g, '\\$&')}"[^>]* sandbox=""[^>]*style="transform:scale\\(0\\.1282051282051282\\)"`), '50px wide, as the phone is');
  assert.doesNotMatch(html, /<img/);
  // The phone is the same box whatever it holds.
  for (const src of [null, DRAWN_URL, '/api/apps/club-votes/first-version/screens/first_look/0?v=17']) {
    assert.match(card(src), /<div data-made-first-look-phone="(drawing|ready)" class="relative h-\[108px\] w-\[50px\] shrink-0 overflow-hidden rounded-\[11px\] /);
  }
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /const src = useLookSwap\(next, ownSrc\);/);
  assert.match(src, /const cut = !!src && !!loaded && loaded !== src && isDrawnLook\(loaded\) && !isDrawnLook\(src\);/);
  assert.match(src, /const lookWaits = firstLookHere && \(!lookShown \|\| isDrawnLook\(lookShown\)\);/, 'asked for every 5 s until the picture');
});

test('the hub\'s first look card: the drawn screen in the picture\'s box', () => {
  const hub = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: DRAWN_URL }));
  assert.match(html, /^<section class="dev-ws-strip dev-ws-hub-first dev-ws-first-look" data-ws-first-look=""><div class="dev-ws-first-look-shot relative overflow-hidden"><div role="img" aria-label="The first look at Club Votes&#x27;s main screen" data-first-look-drawn=""/);
  assert.match(html, /sandbox=""[^>]*style="transform:scale\(0\.1641025641025641\)"/, '64px wide');
  assert.doesNotMatch(html, /<img/);
  const src = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(src, /if \(!wanted \|\| !slug \|\| \(src && src !== broken && !isDrawnLook\(src\)\)\) return undefined;/);
  assert.match(src, /const shown = useLookSwap\(src && src !== broken \? src : null, ownSrc\);/);
});

test('the App tab: the drawn screen in the band\'s phone, and under Live while it starts', () => {
  const band = loadTsx('frontend/src/features/app-frame/first-version-screens.tsx');
  const html = renderToHtml(createElement(band.ScreensBand, {
    screens: { kind: 'first_look', at: null, images: [DRAWN_URL] }, name: 'Plant Pal', onEmpty() {},
  }));
  assert.match(html, /data-first-version-screens="first_look"/);
  assert.match(html, /First look · drawn from the plan/);
  assert.match(html, /<div role="img" aria-label="A first look at Plant Pal, drawn from the plan" data-first-look-drawn=""/);
  assert.match(html, /sandbox=""[^>]*style="transform:scale\(0\.32051282051282054\)"/, '125px wide');
  assert.doesNotMatch(html, /<img/);
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.match(status, /const steady = useLookSwap\(screens \?\? null, firstImage\);/);
  assert.match(status, /const shows = hasScreens\(steady\) && emptyKey !== shownKey \? steady : null;/);
  const live = read('frontend/src/features/app-frame/live-band.tsx');
  assert.match(live, /\{look && !drawn && isDrawnLook\(look\) \? <DrawnLook src=\{look\} label=\{name\} width=\{125\} hidden \/> : null\}/);
});
