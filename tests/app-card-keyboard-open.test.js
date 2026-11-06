'use strict';

// #2988 — the landing tile and the Home Discover card open from the keyboard.
//
// House rule #1918: a card that opens something IS a button. It is in the tab
// order (tabIndex=0), carries role="button", is named by what it opens, and
// Enter/Space press it like a tap. Both cards here opened on click only: a
// keyboard user could not reach the landing tile at all, and on a Discover
// card reached only the inner ⊕ badge, never the detail page the card opens.
//
// Two kinds of test per surface:
//
//   1. MARKUP. Render the real component and read the attributes off its open
//      tag. The attributes are in the INITIAL render (no effect adds them), so
//      the prerender and the client agree. On the Discover card they must sit
//      AFTER `data-slug`: several suites read the tag as
//      `class="app-card home-discover-card …" data-slug=…`.
//   2. BEHAVIOUR. Call the component as a function (neither has a hook at its
//      top level) and drive the element's own `onKeyDown` with events shaped
//      like React's: Enter and Space activate and Space's page scroll is
//      suppressed; other keys, and keys aimed at an inner control, do not.
//
// Run with: node --test tests/app-card-keyboard-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { decodeEntities } = require('./helpers/html-tokens');

// The card reads its text through a hook, so a direct call runs inside a
// render: the element it returns is what the assertions walk.
function inRender(fn) {
  let out;
  const Probe = () => { out = fn(); return null; };
  renderToHtml(createElement(Probe));
  return out;
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { LandingTile } = loadTsx('frontend/src/features/auth/landing.tsx');
const { DiscoverCard, activateOnKey } = loadTsx('frontend/src/features/home/panels/discover.tsx');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};

// A keydown as React hands it to the handler. `onInner` aims it at a child
// (the ⊕ badge) so it bubbles to the card rather than landing on it.
function keyEvent(key, { onInner = false, defaultPrevented = false } = {}) {
  const card = { clicks: 0, click() { this.clicks += 1; } };
  const ev = {
    key,
    currentTarget: card,
    target: onInner ? { tagName: 'BUTTON' } : card,
    defaultPrevented,
    prevented: false,
    preventDefault() { this.prevented = true; this.defaultPrevented = true; },
  };
  return ev;
}

// ── landing tile ─────────────────────────────────────────────────────────

const APP = { slug: 'polls', name: 'Opinion Polls', requires_login: false };

test('landing tile: a focusable button named by the app it opens', () => {
  for (const app of [APP, { ...APP, requires_login: true }]) {
    const html = renderToHtml(createElement(LandingTile, { app, onOpen() {} }));
    const tag = html.match(/<div class="app-card [^>]*>/)[0];
    assert.equal(attr(tag, 'role'), 'button');
    assert.equal(attr(tag, 'tabindex'), '0');
    assert.equal(attr(tag, 'aria-label'), 'Opinion Polls');
    // The existing selectors still resolve.
    assert.equal(attr(tag, 'data-slug'), 'polls');
  }
  // No name falls back to the slug, the same string the visible label shows.
  const html = renderToHtml(createElement(LandingTile, { app: { slug: 'polls', requires_login: false }, onOpen() {} }));
  assert.equal(attr(html.match(/<div class="app-card [^>]*>/)[0], 'aria-label'), 'polls');
});

test('landing tile: Enter and Space open it like a tap; nothing else does', () => {
  const opened = [];
  const el = LandingTile({ app: APP, onOpen: (a) => opened.push(a.slug) });
  const { onKeyDown } = el.props;
  assert.equal(typeof onKeyDown, 'function');

  const enter = keyEvent('Enter');
  onKeyDown(enter);
  const space = keyEvent(' ');
  onKeyDown(space);
  assert.deepEqual(opened, ['polls', 'polls']);
  assert.ok(space.prevented, 'Space does not also scroll the page');

  onKeyDown(keyEvent('a'));
  onKeyDown(keyEvent('Tab'));
  onKeyDown(keyEvent('Enter', { onInner: true }));
  assert.deepEqual(opened, ['polls', 'polls'], 'other keys and bubbled keys are ignored');
});

// ── Home Discover card ───────────────────────────────────────────────────

const TILE = {
  slug: 'alpha', name: 'Alpha Board', status: 'running', added: false, joined: false,
  icon: { kind: 'letter', letter: 'A' }, illustration: null, blurb: '', meta: null, contributors: 0,
};

test('Discover card: a focusable button named by its app, attributes after data-slug', () => {
  const html = renderToHtml(createElement(DiscoverCard, { tile: TILE }));
  const tag = html.match(/<div class="app-card home-discover-card [^>]*>/)[0];
  assert.equal(attr(tag, 'role'), 'button');
  assert.equal(attr(tag, 'tabindex'), '0');
  assert.equal(attr(tag, 'aria-label'), 'Alpha Board');
  // The shape the render suites match on is untouched.
  assert.match(html, /class="app-card home-discover-card [^"]*" data-slug="alpha"/);
  assert.ok(tag.indexOf('data-slug=') < tag.indexOf('role='), 'role comes after data-slug');
  // The inner pill keeps its own name; the card's does not replace it.
  // A card the viewer has neither joined nor added offers the real join.
  assert.match(html, /class="card-add-btn [^"]*"[^>]*aria-label="Join Alpha Board"/);
});

test('Discover card: the editor preview stays a picture, out of the tab order', () => {
  const html = renderToHtml(createElement(DiscoverCard, { tile: TILE, preview: true, previewTheme: 'light' }));
  const tag = html.match(/<div class="app-card home-discover-card [^>]*>/)[0];
  assert.equal(attr(tag, 'role'), null);
  assert.equal(attr(tag, 'tabindex'), null);
  assert.equal(inRender(() => DiscoverCard({ tile: TILE, preview: true })).props.onKeyDown, undefined);
});

test('Discover card: Enter/Space on the card press it; keys on the ⊕ badge do not', () => {
  const el = inRender(() => DiscoverCard({ tile: TILE }));
  assert.equal(el.props.onKeyDown, activateOnKey);

  const enter = keyEvent('Enter');
  activateOnKey(enter);
  assert.equal(enter.currentTarget.clicks, 1, 'Enter clicks the card');
  const space = keyEvent(' ');
  activateOnKey(space);
  assert.equal(space.currentTarget.clicks, 1, 'Space clicks the card');
  assert.ok(space.prevented, 'Space does not also scroll the rail');

  for (const ev of [
    keyEvent('Enter', { onInner: true }),
    keyEvent(' ', { onInner: true }),
    keyEvent('ArrowRight'),
    keyEvent('Enter', { defaultPrevented: true }),
  ]) {
    activateOnKey(ev);
    assert.equal(ev.currentTarget.clicks, 0, `${JSON.stringify(ev.key)} is not a card press`);
  }
});
