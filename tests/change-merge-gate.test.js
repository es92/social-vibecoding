// #6563: a change that is approved and tested, but which GitHub has not
// merged yet, says what it waits on. The change's page gets a third card,
// Merging, under Votes and Tested; its times are counted from the viewer's
// own clock; a wait of about 30 minutes or more is called out; GitHub's own
// required checks failing again is red and names no times.
//
// Run with: node --test tests/change-merge-gate.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderComponent } = require('./lib/render-tsx');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');

const HEAD = 'frontend/src/features/dev-board/topic/change-head.tsx';
const NOW = Date.parse('2026-11-10T20:30:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const ahead = (min) => new Date(NOW + min * 60000).toISOString();

// Effects do not run under renderToStaticMarkup, so the card's times are
// read from the clock as this one render finds it. Pin Date.now for the call.
function render(g) {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    // React escapes the apostrophes in "GitHub's": read the words back.
    return renderComponent(HEAD, 'MergeCard', { g, id: 7 })
      .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  } finally {
    Date.now = real;
  }
}

const held = (over = {}) => ({
  name: message('changes:page.merge.name'),
  figure: message('changes:page.merge.figure.githubChecks'),
  tone: 'muted', done: false,
  segments: [{ weight: 1, pct: 60, state: 'moving' }],
  label: message('changes:page.merge.label.githubChecks'),
  note: [message('changes:page.merge.note.githubChecks')],
  hold: 'github_checks',
  wait: { triedAt: ago(2), retryAt: ahead(3), since: ago(2) },
  ...over,
});

test('the Merging card says GitHub is building and scanning the release images, and not how a try went', () => {
  const html = render(held());
  assert.match(html, /data-change-gate="merge"/);
  assert.match(html, /Merging/);
  assert.match(html, /Waiting on GitHub's checks/);
  assert.match(html, /building and scanning the release images/);
  assert.match(html, /about 6 minutes/);
  assert.doesNotMatch(html, /Tried |Trying again/);
  assert.match(html, /data-tone="muted"/);
});

test('a busy or refused GitHub hold still counts the last try and the next one', () => {
  const html = render(held({
    figure: message('changes:page.merge.figure.githubWait'),
    label: message('changes:page.merge.label.githubWait'),
    note: [message('changes:page.merge.note.githubWait')],
    hold: 'github_wait',
  }));
  assert.match(html, /Tried 2 min ago\./);
  assert.match(html, /Trying again in about 3 min\./);
});

test('a long wait is called out at about 30 minutes, and not before', () => {
  const short = render(held({ wait: { triedAt: ago(1), retryAt: ahead(3), since: ago(29) } }));
  assert.match(short, /Waiting on GitHub's checks/);
  assert.match(short, /data-tone="muted"/);
  assert.doesNotMatch(short, /Waiting longer than usual/);

  const long = render(held({ wait: { triedAt: ago(1), retryAt: ahead(3), since: ago(31) } }));
  assert.match(long, /Waiting longer than usual/);
  assert.match(long, /data-tone="warn"/);
  assert.match(long, /it has waited 31 min/);
  assert.match(long, /say so in this change's thread/);
});

test('while the merge is under way it reads Merging now on a moving bar, with no times', () => {
  const html = render({
    name: message('changes:page.merge.name'),
    figure: message('changes:page.merge.figure.merging'),
    tone: 'muted', done: false,
    segments: [{ weight: 1, pct: 60, state: 'moving' }],
    label: message('changes:page.merge.label.merging'),
    note: [], wait: null, hold: 'merging',
  });
  assert.match(html, /data-change-gate="merge"/);
  assert.match(html, /data-tone="muted"/);
  assert.match(html, /Merging now/);
  assert.match(html, /data-state="moving"/);
  assert.doesNotMatch(html, /Tried |Trying again/);
  assert.doesNotMatch(html, /<button/);
});

test("GitHub's checks failing is red, names no times, and offers no button", () => {
  const html = render({
    name: message('changes:page.merge.name'),
    figure: message('changes:page.merge.figure.failing'),
    tone: 'bad', done: false,
    segments: [{ weight: 1, pct: 100, state: 'bad' }],
    label: message('changes:page.merge.label.failing'),
    note: [message('changes:page.merge.note.failing')],
    hold: 'failing',
  });
  assert.match(html, /GitHub's checks failed/);
  assert.match(html, /data-tone="bad"/);
  assert.match(html, /Its author has to fix them/);
  assert.doesNotMatch(html, /Tried |Trying again/);
  assert.doesNotMatch(html, /<button/);
});

test('the card is Votes and Tested\'s own markup: name, figure, bar and note in that order', () => {
  const html = render(held());
  // The same skeleton GateCard draws for Votes and Tested, in the same order.
  const parts = ['dev-change-gate-main', 'dev-change-gate-head', 'dev-change-gate-name',
    'dev-change-gate-figure', 'dev-change-bar', 'dev-change-bar-seg',
    'dev-change-bar-fill', 'dev-change-gate-note'];
  let at = -1;
  for (const part of parts) {
    const next = html.indexOf(part, at + 1);
    assert.ok(next > at, part);
    at = next;
  }
  assert.match(html, /class="dev-change-gate"/);
  assert.match(html, /class="dev-change-gate-main"/);
  assert.match(html, /class="dev-change-gate-head"/);
  assert.match(html, /class="dev-change-gate-name"/);
  assert.match(html, /class="dev-change-gate-figure"/);
  assert.match(html, /class="dev-change-bar"/);
  assert.match(html, /class="dev-change-gate-note"/);
});

test('the card is the same card as Votes and Tested, with a name and a bar', () => {
  const html = render(held());
  assert.match(html, /class="dev-change-gate"/);
  assert.match(html, /class="dev-change-bar"/);
  const changes = require('../frontend/locales/en/changes.json');
  const project = require('../frontend/locales/en/project.json');
  for (const key of ['page.merge.name', 'page.merge.figure.githubChecks', 'page.merge.figure.githubWait',
    'page.merge.figure.failing', 'page.merge.figure.merging', 'page.merge.note.githubChecks',
    'page.merge.note.githubChecksProgress', 'page.merge.note.githubWait', 'page.merge.note.failing',
    'page.testing.figure.passedHomeroom', 'page.testing.label.passedHomeroom']) {
    assert.ok(changes[key] && changes[key].text && changes[key].description, key);
  }
  for (const key of ['topic.change.gate.merge.tried_one', 'topic.change.gate.merge.tried_other',
    'topic.change.gate.merge.triedJustNow', 'topic.change.gate.merge.next_one',
    'topic.change.gate.merge.next_other', 'topic.change.gate.merge.nextNow',
    'topic.change.gate.merge.longFigure', 'topic.change.gate.merge.long']) {
    assert.ok(project[key] && project[key].text && project[key].description, key);
  }
});

// `_changeMergeView` builds the card's view from a row (public/js/app-view.js).
function appView() {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const root = path.join(__dirname, '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const c = {
    console, App: { user: { id: 42, username: 'maya' }, currentApp: 'usernode-2d5619', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
  };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) vm.runInContext(read(p), c);
  vm.runInContext('globalThis.av = AppView', c);
  return c.av;
}

const mergeRow = (over = {}) => ({
  status: 'promoted',
  integration: { blockReasons: ['github_checks'], heldAt: ago(2), heldUntil: ahead(3), heldSince: ago(2) },
  ...over,
});

test('the view says which hold it is, and draws the count only for a valid pair', () => {
  const av = appView();
  const view = av._changeMergeView(mergeRow());
  assert.equal(view.hold, 'github_checks');
  assert.equal(view.note.length, 1, 'no count when GitHub would not answer');

  const counted = av._changeMergeView(mergeRow({
    integration: { blockReasons: ['github_checks'], githubChecks: { done: 7, total: 10 } },
  }));
  assert.equal(counted.note[counted.note.length - 1], "GitHub's checks: 7 of 10 done.");

  for (const bad of [{ done: 7, total: 0 }, { done: 11, total: 10 }, { done: -1, total: 10 },
    { done: 1.5, total: 10 }, { done: '7', total: 10 }, null]) {
    const bare = av._changeMergeView(mergeRow({
      integration: { blockReasons: ['github_checks'], githubChecks: bad },
    }));
    assert.equal(bare.note.length, 1, JSON.stringify(bad));
  }

  assert.equal(av._changeMergeView(mergeRow({
    integration: { blockReasons: ['github_busy'] },
  })).hold, 'github_wait');
  assert.equal(av._changeMergeView(mergeRow({
    integration: { blockReasons: ['github_checks_failing'] },
  })).hold, 'failing');
  assert.equal(av._changeMergeView({ status: 'merging' }).hold, 'merging');
});
