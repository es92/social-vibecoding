'use strict';

// #1688: the general chat's merge line names its people, and Friday's card.
//
// A merge used to post "<title> is live (PR #N). Thanks to everyone who
// voted (a/b votes)". It now posts "… Built by evan, backed by alice and
// bob, shaped by carol. (a/b votes)", with the same names as metadata on the
// row. This pins:
//
//   1. `_parseCredits` reads the names back out of the sentence, for a row
//      whose metadata did not survive — and null for the older wording;
//   2. `_proposalEvent` still recognises both merge wordings, prefers the
//      metadata over the sentence, and hands the names on as `credits`;
//   3. the Friday card is a `weekly` event decided from metadata alone —
//      never from the "PR #N"s its text happens to carry — announced by
//      the app, with no glyph and no proposal link;
//   4. proposal-event.tsx draws a named merge as the sentence with the
//      number and the tally in a muted tail, and the Friday card as its
//      sections and its door.
//
// Run with: node --test tests/group-chat-merge-credits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const EVENT = 'frontend/src/features/group-chat/proposal-event.tsx';
const gcJs = fs.readFileSync(path.join(root, 'public/js/group-chat.js'), 'utf8');

function loadGroupChat(AppView, App) {
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' }, ...(App || {}) },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  if (AppView) sandbox.AppView = AppView;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

// Objects from the vm realm have another prototype (and so do its arrays);
// a JSON round-trip is the same-realm copy deepEqual can compare.
const plain = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

const devIcons = {
  DEV_CARD_ICONS: { proposal: ['tint-proposal', 'M14 10h4'], done: ['tint-done', 'M5 13l4 4L19 7'], issue: ['tint-issue', 'M0 0'] },
  _devCardIcon(type, opts) {
    const [tint, d] = this.DEV_CARD_ICONS[type] || this.DEV_CARD_ICONS.issue;
    return { tint, path: d, small: opts && opts.small ? true : undefined, pulse: undefined, title: undefined };
  },
};
const promoted = { id: 5, status: 'promoted', pr_number: 12, my_vote: null };
const voteState = { bySession: { 5: promoted }, byPrNumber: { 12: promoted }, majority: 1, activeUsers: 1 };

const CREDITS = { author: 'evan', backers: ['alice', 'bob'], shapers: ['carol'] };
const NAMED = 'Custom tier colors is live (PR #41). Built by evan, backed by alice and bob, shaped by carol. (3/5 votes)';
const OLD = 'Custom tier colors is live (PR #41). Thanks to everyone who voted (3/5 votes)';

// ── 1. The sentence, read back ────────────────────────────────────────

test('_parseCredits reads the names out of the sentence, and nothing out of the older wording', () => {
  const gc = loadGroupChat();
  assert.deepEqual(plain(gc._parseCredits('Built by evan, backed by alice and bob, shaped by carol.')), CREDITS);
  assert.deepEqual(plain(gc._parseCredits('Built by evan.')), { author: 'evan', backers: [], shapers: [] });
  assert.deepEqual(plain(gc._parseCredits('Backed by alice.')), { author: '', backers: ['alice'], shapers: [] });
  assert.deepEqual(plain(gc._parseCredits('Backed by alice, bob and carol, shaped by dave.')),
    { author: '', backers: ['alice', 'bob', 'carol'], shapers: ['dave'] });
  assert.deepEqual(plain(gc._parseCredits('Built by evan, backed by u1, u2, u3, u4, u5, u6, u7, u8 and 2 more.')),
    { author: 'evan', backers: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'], shapers: [] },
    'the "and N more" tail is a count, not a person');
  assert.equal(gc._parseCredits('Thanks to everyone who voted'), null);
  assert.equal(gc._parseCredits(''), null);
});

// ── 2. The merge event ────────────────────────────────────────────────

test('_proposalEvent: both merge wordings, the names from metadata first and the sentence second', () => {
  const gc = loadGroupChat();
  assert.deepEqual(plain(gc._proposalEvent({ content: NAMED }, 'system')), {
    type: 'merged', sessionId: '', prNumber: '41', title: 'Custom tier colors', actor: '', force: false, votes: '3/5',
    credits: CREDITS,
  });
  assert.deepEqual(plain(gc._proposalEvent({ content: 'PR #41 is live. Built by evan. (1/1 votes)' }, 'system')), {
    type: 'merged', sessionId: '', prNumber: '41', title: '', actor: '', force: false, votes: '1/1',
    credits: { author: 'evan', backers: [], shapers: [] },
  });
  const older = gc._proposalEvent({ content: OLD }, 'system');
  assert.equal(older.type, 'merged');
  assert.ok(!('credits' in older), 'the older wording names nobody: the event keeps its old shape');
  // Metadata wins over the sentence: a row that carries both is read from
  // the data, which is what the server wrote the names into.
  const meta = { merged: { sessionId: 9, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: ['zed'], shapers: [], votes: '3/5' } };
  assert.deepEqual(plain(gc._proposalEvent({ content: OLD, metadata: meta }, 'system').credits),
    { author: 'evan', backers: ['zed'], shapers: [] });
  assert.equal(gc._mergeCredits({ metadata: { merged: { author: '', backers: [], shapers: [] } } }), null,
    'metadata naming nobody is no metadata');
  assert.equal(gc._mergeCredits({ metadata: { merged: 'yes' } }), null);
  const forced = gc._proposalEvent({ content: 'PR #41: Custom tier colors force-merged by admin dfk (0/2 votes at the time)' }, 'system');
  assert.equal(forced.force, true);
  assert.ok(!('credits' in forced), 'an override thanks nobody');
  assert.equal(gc._proposalEvent({ content: NAMED }, 'message'), null, 'a person quoting the wording is a message');
});

// Follow-up to #2897: a merge on the platform's own app is released after it
// merges, so its line says it "merged (PR #N) and will be live in a few
// minutes". Both wordings are merges; the stored "is live" rows above keep
// classifying exactly as they did, with no `liveSoon` on them.
const SOON = 'Custom tier colors merged (PR #41) and will be live in a few minutes. Built by evan, backed by alice and bob, shaped by carol. (3/5 votes)';
const SOON_OLD = 'Custom tier colors merged (PR #41) and will be live in a few minutes. Thanks to everyone who voted (3/5 votes)';

test('_proposalEvent: the self-hosted "will be live in a few minutes" wording is a merge too, and says so', () => {
  const gc = loadGroupChat();
  assert.deepEqual(plain(gc._proposalEvent({ content: SOON }, 'system')), {
    type: 'merged', sessionId: '', prNumber: '41', title: 'Custom tier colors', actor: '', force: false, votes: '3/5',
    credits: CREDITS, liveSoon: true,
  });
  assert.deepEqual(plain(gc._proposalEvent({ content: 'PR #41 merged and will be live in a few minutes. Built by evan. (1/1 votes)' }, 'system')), {
    type: 'merged', sessionId: '', prNumber: '41', title: '', actor: '', force: false, votes: '1/1',
    credits: { author: 'evan', backers: [], shapers: [] }, liveSoon: true,
  });
  assert.deepEqual(plain(gc._proposalEvent({ content: SOON_OLD }, 'system')), {
    type: 'merged', sessionId: '', prNumber: '41', title: 'Custom tier colors', actor: '', force: false, votes: '3/5',
    liveSoon: true,
  });
  // The structured field wins: metadata saying `liveSoon` marks the event
  // whatever the wording, and a row without it falls back to the wording.
  const meta = { merged: { sessionId: 9, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: [], shapers: [], votes: '3/5', liveSoon: true } };
  assert.equal(gc._proposalEvent({ content: NAMED, metadata: meta }, 'system').liveSoon, true);
  assert.equal(gc._mergeLiveSoon({ metadata: meta }), true);
  assert.equal(gc._mergeLiveSoon({ metadata: { merged: { liveSoon: 'yes' } } }), false);
  assert.equal(gc._mergeLiveSoon({}), false);
  // Backward compatibility: stored "is live" rows are merges without it.
  for (const content of [NAMED, OLD, 'PR #41 is live. Thanks to everyone who voted (1/1 votes)']) {
    const ev = gc._proposalEvent({ content }, 'system');
    assert.equal(ev.type, 'merged', content);
    assert.ok(!('liveSoon' in ev), `${content}: an "is live" row keeps its old shape`);
  }
  assert.equal(gc._proposalEvent({ content: SOON }, 'message'), null, 'a person quoting the wording is a message');
  const here = gc._threadEvent({ content: SOON }, 'system');
  assert.equal(here.type, 'merged');
  assert.equal(here.here, true);
  assert.equal(here.liveSoon, true, 'the change page reads the same wording');
});

// ── 3. The Friday card ────────────────────────────────────────────────

const weekly = {
  app: 'Recipe App', slug: 'recipe-app',
  merged: [
    { id: 41, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: ['alice', 'bob'] },
    { id: 42, prNumber: 42, title: 'Mobile drag fix', author: 'carol', backers: [] },
  ],
  mergedTotal: 5,
  open: [{ id: 44, prNumber: 44, title: 'Dark mode toggle', author: 'dave' }],
  openTotal: 1,
};
const weeklyRow = {
  id: 77, msg_type: 'system', metadata: { weekly },
  content: 'This week on Recipe App: 5 changes went live: Custom tier colors (PR #41); … One change is waiting for approval: Dark mode toggle (PR #12).',
  created_at: '2026-09-18T15:00:00.000Z',
};

test('_weeklyEvent: decided from metadata, normalised, and never a proposal link', () => {
  const gc = loadGroupChat();
  const ev = plain(gc._proposalEvent(weeklyRow, 'system'));
  assert.equal(ev.type, 'weekly');
  assert.deepEqual(ev.weekly, {
    app: 'Recipe App', slug: 'recipe-app',
    merged: [
      { id: 41, prNumber: '41', title: 'Custom tier colors', author: 'evan', backers: ['alice', 'bob'] },
      { id: 42, prNumber: '42', title: 'Mobile drag fix', author: 'carol', backers: [] },
    ],
    mergedTotal: 5,
    open: [{ id: 44, prNumber: '44', title: 'Dark mode toggle', author: 'dave', backers: [] }],
    openTotal: 1,
  });
  assert.ok(!('credits' in ev));
  assert.equal(gc._proposalEvent(weeklyRow, 'message'), null, 'a person\'s message never becomes the card');
  assert.equal(gc._weeklyEvent({ metadata: { weekly: 'soon' } }), null);
  assert.deepEqual(plain(gc._weeklyEvent({ metadata: { weekly: { app: 'X', merged: 'no', open: null } } }).weekly),
    { app: 'X', slug: '', merged: [], mergedTotal: 0, open: [], openTotal: 0 }, 'garbage lists are empty lists');
});

test('_messageView draws the Friday card as a message from the app, with no glyph and no link', () => {
  const warm = loadGroupChat({ ...devIcons, voteState, appData: { slug: 'recipe-app', name: 'Recipe App' } });
  const v = warm._messageView(weeklyRow);
  assert.equal(v.kind, 'system');
  assert.equal(v.event.type, 'weekly');
  assert.equal(v.event.sender, 'Recipe App', 'the app announcing its own week');
  assert.equal(v.event.mine, false);
  assert.equal(v.event.icon, null, 'no proposal to take a glyph from');
  assert.equal(v.eventHref, null, 'the "PR #12" in its text must not resolve it to a proposal');
  assert.equal(v.event.weekly.mergedTotal, 5);
  assert.ok(!('votePhase' in v));

  // A named merge, next to it, still resolves and links as it always did.
  const m = warm._messageView({ id: 10, msg_type: 'system', content: NAMED.replace('#41', '#12') });
  assert.equal(m.event.type, 'merged');
  assert.deepEqual(plain(m.event.credits), CREDITS);
  assert.equal(m.event.sender, 'Recipe App');
  assert.equal(m.event.icon.tint, 'tint-done');
  assert.equal(m.eventHref, '/app/recipe-app/dev/proposals/5');
});

// ── 4. The component ──────────────────────────────────────────────────

const base = {
  id: 1, kind: 'system', username: '', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  bodyHtml: '', systemText: '', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: false, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null,
};
const icon = { tint: 'bg-sky-500/15 text-sky-700 dark:text-sky-400', path: 'M5 13l4 4L19 7', small: true };
const mergedEvent = (over) => ({
  type: 'merged', sessionId: '9', prNumber: '41', title: 'Custom tier colors', actor: '', sender: 'Recipe App',
  mine: false, force: false, votes: '3/5', icon, credits: CREDITS, ...(over || {}),
});

test('eventText, eventTail, creditsSentence: a named merge is the sentence, the number and tally its tail', () => {
  const { eventText, eventTail, creditsSentence } = loadTsx(EVENT);
  assert.equal(creditsSentence(CREDITS), 'Built by evan, backed by alice and bob, shaped by carol.');
  assert.equal(creditsSentence({ author: '', backers: ['alice'], shapers: [] }), 'Backed by alice.');
  assert.equal(creditsSentence({ author: '', backers: [], shapers: [] }), '');

  const named = { ...base, id: 2, systemText: NAMED, event: mergedEvent() };
  assert.equal(eventText(named), 'Custom tier colors is live. Built by evan, backed by alice and bob, shaped by carol.');
  assert.equal(eventTail(named), '3/5 votes');
  const untitled = { ...named, event: mergedEvent({ title: '' }) };
  assert.equal(eventText(untitled), 'A change is live. Built by evan, backed by alice and bob, shaped by carol.');
  const older = { ...named, systemText: OLD, event: mergedEvent({ credits: null }) };
  assert.equal(eventText(older), 'Custom tier colors went live with 3/5 votes', 'the older row reads as it did');
  assert.equal(eventTail(older), '');
  const forced = { ...named, event: mergedEvent({ force: true, actor: 'dfk', sender: 'dfk', votes: '0/2', credits: null }) };
  assert.equal(eventText(forced), 'An admin made “Custom tier colors” live (0/2 votes)');
  assert.equal(eventTail(forced), '');
  const card = { ...base, id: 3, event: { ...mergedEvent({ type: 'weekly', prNumber: '', title: '', votes: '', credits: null, icon: null }), weekly } };
  assert.equal(eventText(card), 'This week on Recipe App');
  assert.equal(eventTail(card), '');
});

test('eventText: a self-hosted merge says it merged and will be live in a few minutes, never that it is live', () => {
  const { eventText, eventTail } = loadTsx(EVENT);
  const named = { ...base, id: 2, systemText: SOON, event: mergedEvent({ liveSoon: true }) };
  assert.equal(eventText(named), 'Custom tier colors was approved and will be live in a few minutes. Built by evan, backed by alice and bob, shaped by carol.');
  assert.equal(eventTail(named), '3/5 votes');
  assert.equal(eventText({ ...named, event: mergedEvent({ liveSoon: true, title: '' }) }),
    'A change was approved and will be live in a few minutes. Built by evan, backed by alice and bob, shaped by carol.');
  assert.equal(eventText({ ...named, event: mergedEvent({ liveSoon: true, credits: null }) }),
    '“Custom tier colors” was approved with 3/5 votes and will be live in a few minutes');
  assert.equal(eventText({ ...named, event: mergedEvent({ liveSoon: true, credits: null, here: true }) }),
    'This change was approved with 3/5 votes and will be live in a few minutes');
  assert.equal(eventText({ ...named, event: mergedEvent({ liveSoon: true, here: true }) }),
    'This change was approved and will be live in a few minutes. Built by evan, backed by alice and bob, shaped by carol.');
  // The older rows are untouched.
  assert.equal(eventText({ ...named, event: mergedEvent({ credits: null, here: true }) }), 'This change went live with 3/5 votes');
  assert.equal(eventText({ ...named, event: mergedEvent({ here: true }) }), 'This change is live. Built by evan, backed by alice and bob, shaped by carol.');
  for (const t of [eventText(named), eventText({ ...named, event: mergedEvent({ liveSoon: true, credits: null }) })]) {
    assert.doesNotMatch(t, /\bis live\b|went live/, t);
  }
});

test('EventRow draws the named merge with its muted tail, and the Friday card with its sections and door', () => {
  const named = renderComponent(EVENT, 'EventRow', { msg: { ...base, id: 2, event: mergedEvent(), eventHref: '/app/recipe-app/dev/proposals/9' } });
  assert.match(named, /data-event="merged"/);
  assert.match(named, /Custom tier colors is live\. Built by evan, backed by alice and bob, shaped by carol\.<span class="gc-event-tail"> 3\/5 votes<\/span>/);
  assert.match(named, /<a class="gc-event-box" href="\/app\/recipe-app\/dev\/proposals\/9"/);
  const older = renderComponent(EVENT, 'EventRow', { msg: { ...base, id: 2, event: mergedEvent({ credits: null }) } });
  assert.doesNotMatch(older, /gc-event-tail/, 'no tail without names');

  const card = renderComponent(EVENT, 'EventRow', {
    msg: { ...base, id: 3, event: { ...mergedEvent({ type: 'weekly', prNumber: '', title: '', votes: '', credits: null, icon: null }), weekly } },
  });
  assert.match(card, /data-event="weekly"/);
  assert.match(card, /data-event-sender="">Recipe App</, 'from the app');
  assert.match(card, /class="gc-event-box gc-event-weekly"/);
  assert.match(card, /class="gc-weekly-title">This week on Recipe App</);
  assert.match(card, /gc-weekly-head-live">5 changes went live</);
  assert.match(card, /data-weekly="merged"><span class="gc-weekly-line-title">Custom tier colors<\/span><span class="gc-weekly-line-who"> · evan, backed by alice and bob<\/span>/);
  assert.match(card, /data-weekly="merged"><span class="gc-weekly-line-title">Mobile drag fix<\/span><span class="gc-weekly-line-who"> · carol<\/span>/);
  assert.match(card, /class="gc-weekly-more">and 3 more</, 'the totals say what the card does not list');
  assert.match(card, /gc-weekly-head-open">One change is waiting for approval</);
  assert.match(card, /data-weekly="open"><span class="gc-weekly-line-title">Dark mode toggle<\/span><\/div>/);
  assert.match(card, /<a class="gc-weekly-door" href="#app\/recipe-app\/dev">Open the Workshop ›<\/a>/);
  assert.doesNotMatch(card, /gc-event-text|data-open/, 'not a proposal row');

  const quiet = renderComponent(EVENT, 'EventRow', {
    msg: { ...base, id: 4, event: { ...mergedEvent({ type: 'weekly', prNumber: '', title: '', votes: '', credits: null, icon: null }),
      weekly: { ...weekly, merged: [], mergedTotal: 0, open: [], openTotal: 0, slug: '' } } },
  });
  assert.match(quiet, /gc-weekly-head-live">Nothing landed this week</);
  assert.doesNotMatch(quiet, /waiting for eyes|gc-weekly-door/, 'no open section and no door without a slug');
});
