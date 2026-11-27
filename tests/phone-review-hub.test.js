'use strict';

// The project hub's fixes from the phone review of 23 Nov 2026 (proposal 6),
// held by what they do: each project remembers its own place (#43), Recently
// live shows what changed or nothing (#41), a door's pill rides its title
// line (#91), Recently live shares its row by width (#139), the hero's words
// stop short of its picture (#76), Open app stays in the hero (#53), and the
// menu's count says what it counts (#22).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const CSS = read('public/css/app.css');

function withAppView(fn, currentApp = null) {
  const stored = new Map();
  const saved = { window: globalThis.window, App: globalThis.App, CustomEvent: globalThis.CustomEvent };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.App = { currentApp };
  globalThis.window = {
    location: { search: '', hash: '', pathname: '/' },
    addEventListener() {},
    dispatchEvent: () => true,
    localStorage: { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)) },
  };
  delete require.cache[require.resolve('../public/js/app-view.js')];
  const AppView = require('../public/js/app-view.js');
  try {
    return fn(AppView, stored);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
}

test('#43: a project reopens on its own last place, never on another project\'s', () => {
  withAppView((AppView, stored) => {
    // The old device-wide key, as a device that used it last has it.
    stored.set(AppView.WORKSHOP_TAB_KEY, 'workshop');
    AppView._setWorkshopTab('workshop', 'gym-tracker');
    assert.equal(stored.get('devWorkshopTab:gym-tracker'), 'workshop');
    assert.equal(AppView._workshopTab('group-challenge'), 'status', 'a project never opened on its Workshop opens on its Hub');
    assert.equal(AppView._workshopTab('gym-tracker'), 'workshop');
    globalThis.App.currentApp = 'gym-tracker';
    assert.equal(AppView._workshopTab(), 'workshop', 'unnamed, the project on screen');
    AppView._landOnTab('group-challenge', 'needs');
    assert.equal(AppView._workshopTab('group-challenge'), 'needs');
    assert.equal(AppView._workshopTab('gym-tracker'), 'workshop', 'a door to one project leaves the other\'s place alone');
  });
  // Open app from the hub stamps the entry it leaves with the place on show,
  // so the app's ✕ (a step back to that entry) returns there.
  const app = read('public/js/app.js');
  assert.match(app, /if \(tab === 'app' && typeof AppView !== 'undefined' && AppView\._stampWorkshopTab && AppView\._onProjectPage\?\.\(slug\)\) \{\s*AppView\._stampWorkshopTab\(slug, AppView\._workshopTab\(slug\)\);/);
  assert.match(app, /if \(pageTab\) AppView\._setWorkshopTab\(pageTab\.tab, pageTab\.slug\);/);
});

test('#41: Recently live shows the element its change is about, the element shot whole, or the project\'s tile', () => {
  withAppView((AppView) => {
    const url = (n) => `/api/apps/garden/proposals/7/shots/${String(n).padStart(32, '0')}`;
    const screen = { viewport: 'mobile', width: 402, after: { url: url(1), height: 874 }, frames: [{ n: 1, b: null, a: [12, 745, 378, 46] }] };
    assert.deepEqual(AppView._recentLiveThumb({}, { after: url(1), screens: [screen] }),
      { picture: null, frame: { url: url(1), width: 402, height: 874, box: [12, 745, 378, 46] } }, 'framed on the claim\'s element');
    const shots = { artifacts: [{ url: url(4), variant: 'focus' }, { url: url(1), variant: 'context' }] };
    assert.deepEqual(AppView._recentLiveThumb(shots, { after: url(4), screens: [] }), { picture: url(4), frame: null }, 'an element shot, whole');
    assert.deepEqual(AppView._recentLiveThumb(shots, { after: url(1), screens: [] }), { picture: null, frame: null },
      'a whole screen and nothing to frame on: no picture, the tile instead');
    assert.deepEqual(AppView._recentLiveThumb(null, null), { picture: null, frame: null });
  });
  const { RecentlyLive, recentFrameView, framedShotStyle } = loadTsx(HUB);
  const frame = { url: '/api/apps/garden/proposals/7/shots/00000000000000000000000000000001', width: 402, height: 874, box: [12, 745, 378, 46] };
  const view = recentFrameView(frame);
  assert.deepEqual(view, [0, 623, 402, 251], 'the element with room round it, grown to the slot\'s shape, inside the screen');
  assert.deepEqual(framedShotStyle(frame), { width: '100%', marginLeft: '0%', marginTop: '-154.94%' });
  const html = renderToHtml(createElement(RecentlyLive, {
    slug: 'garden', onAll() {},
    rows: [{ key: 'live:7', sessionId: 7, prNumber: 70, title: 'Rounder reply box', who: 'ada', at: new Date().toISOString(), going: false, picture: null, frame }],
  }));
  assert.match(html, /<span class="dev-ws-recent-pic" data-ws-recent-pic="frame" aria-hidden="true"><img class="dev-ws-recent-frame" src="[^"]+" alt="" loading="lazy" draggable="false" style="width:100%;margin-left:0%;margin-top:-154.94%"\/><\/span><span class="dev-ws-recent-title">/);
  assert.match(CSS, /\.dev-ws-recent-pic\[data-ws-recent-pic="shot"\] > img \{ object-fit: contain; object-position: center; \}/);
});

test('#91: a door\'s one pill is on its title line, so the line under it has the row\'s width', () => {
  const src = read(HUB);
  assert.match(src, /function pillTitle\(name: ReactNode, pill: ReactNode\): ReactNode \{\s*return pill \? <><span className="dev-ws-foryou-name">\{name\}<\/span>\{pill\}<\/> : name;/);
  assert.equal((src.match(/titleClassName=\{TITLE_WITH_PILL\}/g) || []).length, 4, 'Needs you (both), the Discussion and each topic');
  assert.doesNotMatch(src.slice(src.indexOf('function NeedsRow'), src.indexOf('export const HUB_TOPICS_SHOWN')), /trailing=/, 'no pill beside the two lines');
  assert.match(CSS, /\.dev-ws-foryou-title \{ display: flex; align-items: center; gap: 8px; \}/);
  assert.match(CSS, /\.dev-ws-foryou-title > \.one-tag \{ margin-inline-start: auto; \}/);
});

test('#139 and #76: Recently live shares its row by width; the hero\'s words stop short of its picture', () => {
  assert.match(CSS, /html:root #dev-workshop \[data-ws-hub-recent\] \.dev-ws-recent-list \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 18\.75rem\), 1fr\)\); \}/);
  assert.doesNotMatch(CSS, /\[data-ws-hub-recent\] \.dev-ws-recent-list \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(CSS, /\.dev-ws-tabbody > \.dev-ws-hero-summary \{ padding-inline-end: calc\(min\(30%, 20rem\) \+ 1\.5rem\); \}/);
});

test('#53: Make it public is drawn in Invite\'s shape and type, beside Open app', () => {
  assert.match(CSS, /\.dev-ws-hero-actions :is\(\[data-ws-community-invite\], \[data-ws-community-audience-change\]\) \{\s*display: inline-flex;[^}]*font-family: inherit;/);
  assert.match(read('frontend/src/features/dev-board/workshop/community-card.tsx'), /\{canOpenApp && appLive \? \(/, 'the project card of somebody not in it, too');
});
