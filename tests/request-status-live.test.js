'use strict';

// #6390 (6 Nov 2026): a request's status card and its Ask button follow the
// same live bot work the track card under it reads.
//
// Seen on request #6389 in the Homeroom bot tab's side column: the bot said
// "I'm on it", the track card switched to "Reading it", and the status card
// above it kept saying "Nobody is working on this yet." with "Ask Homeroom
// bot to build this". Nothing re-read the request's row there, because
// refreshDevData returns at once off the board; and between the reply and
// the run starting the stored track says `reading` before `issue.bot` is
// set, so the card fell through to "nobody".
//
// app-view.js is a plain browser script, loaded into a vm sandbox as
// tests/work-with-bot.test.js loads it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');

function makeAppView() {
  const fetches = [];
  const renders = [];
  const listeners = {};
  const sandbox = {
    console,
    relTime: () => ({ text: 'just now', title: '' }),
    App: { user: { id: 42, username: 'me' }, currentTab: 'homeroom-bot', currentSubTab: 'forum', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { hash: '#homeroom-bot/main', search: '', pathname: '/' },
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    PlatformUI: { toast: () => {} },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return sandbox.answer(url, options);
    },
    answer: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: (event) => {
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  require('./lib/repo-link').installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._ghIssuesMeta = { myRemaining: 5 };
  AppView._govProposals = [];
  AppView.appData = { slug: 'demo', can_collaborate: true };
  AppView._renderTopicHead = (t) => renders.push(t);
  return { AppView, sandbox, fetches, renders, listeners };
}

const baseIssue = (over) => ({
  number: 3, title: 'Dark mode', body: '', htmlUrl: 'https://github.com/o/r/issues/3', state: 'open',
  bounty_count: 0, my_bounty: false, created_by_username: 'me',
  headless: null, in_progress: null, myPrSessionId: null, bot: null, botAwaits: null, botHold: null,
  chatCount: 0, lastMessageAt: null, title_fallback: false, priority: null, assignee: null, category: null,
  track: null,
  ...over,
});
const plain = (x) => JSON.parse(JSON.stringify(x));

// The gap the report found: the stored track already says the bot is reading
// the reply, while `issue.bot` is still empty.
const readingTrack = { work: { stage: 'reading', reply: true, doing: 'reading the new reply' } };

test('#6390: a reading track says the bot is on it, with no Ask button', () => {
  const { AppView } = makeAppView();
  // The bot door is open, so without the reading track this row's card would
  // lead with "Ask Homeroom bot to build this".
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { enabled: true } };
  const before = plain(AppView._requestStatusView(baseIssue()));
  assert.equal(before.lead, 'Nobody is working on this yet.');
  assert.equal(before.action.label, 'Ask Homeroom bot to build this');

  const status = plain(AppView._requestStatusView(baseIssue({ track: readingTrack })));
  assert.equal(status.lead, 'Homeroom bot is reading this.');
  assert.equal(status.action, null, 'no Ask button once the bot is reading');
  assert.equal(status.botSays, true, 'no "Plan v1 is ready" line under it');
  assert.equal(status.ownAgent, false, 'no "Build it with your own Claude Code" either');
});

test('#6390: once the row carries the bot, the card reads it as a fresh page does', () => {
  const { AppView } = makeAppView();
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { enabled: true } };
  const status = plain(AppView._requestStatusView(baseIssue({
    bot: { what: 'reading', since: '2026-11-06T12:13:17Z', askedBy: 'me', mine: true },
    track: readingTrack,
  })));
  assert.equal(status.lead, 'Homeroom bot is reading this.');
  // #6401/#6403 (merged after this request): the progress card under this
  // one already says where Homeroom bot is, so the request's own page offers
  // no button that scrolls to it. What matters here is no Ask button.
  assert.equal(status.action, null, 'no Ask button once the row carries the bot');
});

test('#6390: someone else\'s bot gets the greyed reading button, never Ask', () => {
  const { AppView } = makeAppView();
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { enabled: true } };
  const status = plain(AppView._requestStatusView(baseIssue({
    bot: { what: 'reading', since: '2026-11-06T12:13:17Z', askedBy: 'ada' },
  })));
  assert.equal(status.action.label, 'Homeroom bot is reading…');
  assert.equal(status.action.disabled, true);
});

test('#6532: a ready build waiting its turn says it will build next, not that it is building', () => {
  const { AppView } = makeAppView();
  const bot = { what: 'building', since: '2026-11-09T10:00:00Z', askedBy: 'me', mine: true };
  const leadFor = (track) => plain(AppView._requestStatusView(baseIssue({ bot, track }))).lead;
  assert.equal(
    leadFor({ busy: false, work: { stage: 'building', line: { code: 'queued', place: 1 } } }),
    'Homeroom bot will build this next.',
    'next in line says so, as the progress card does',
  );
  assert.equal(
    leadFor({ busy: false, work: { stage: 'building', line: { code: 'held_builds' } } }),
    'Homeroom bot will start when one of the changes it is building here is done.',
  );
  assert.equal(
    leadFor({ busy: false, work: { stage: 'building', line: { code: 'held_waiting' } } }),
    'Homeroom bot will start when one of its changes here is voted in or closed.',
  );
  assert.equal(
    leadFor({ busy: true, work: { stage: 'building', line: { code: 'queued', place: 1 } } }),
    'Homeroom bot is building this.',
    'a build that has really started still says so',
  );
  assert.equal(
    leadFor({ busy: false, work: { stage: 'building', line: { code: 'fixing' } } }),
    'Homeroom bot is building this.',
    'a fix in progress is never a queued build',
  );
  assert.equal(
    leadFor({ busy: false, work: { stage: 'building', line: { code: 'claimed', by: 'maya' } } }),
    'Homeroom bot is building this.',
    "a person's claim keeps today's wording",
  );
});

test('#6390: a work event re-reads the request open beside the bot tab', async () => {
  const { AppView, sandbox, fetches, renders, listeners } = makeAppView();
  const stale = baseIssue();
  const fresh = baseIssue({
    bot: { what: 'reading', since: '2026-11-06T12:13:17Z', askedBy: 'me', mine: true },
    track: readingTrack,
  });
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: fresh }) });
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [stale, baseIssue({ number: 5 })];
  AppView._devDataSlug = 'demo';

  assert.ok(listeners['homeroom-bot-work-changed']?.length, 'the event is wired');
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed'));
  const done = AppView._requestRowRefresh?.done;
  assert.ok(done, 'the refresh is in flight');
  await done;

  assert.deepEqual(fetches.map((f) => f.url), ['/api/apps/demo/github-issues/3']);
  assert.equal(AppView._ghIssues[0].bot.what, 'reading', 'the open row in the board list is replaced');
  assert.equal(AppView._ghIssues[1].number, 5, 'other rows are left alone');
  assert.equal(renders.length, 1, 'the head repaints from the fresh row');
  assert.equal(AppView._requestStatusView(AppView._ghIssues[0]).lead, 'Homeroom bot is reading this.');
  assert.equal(AppView._requestStatusView(AppView._ghIssues[0]).action, null, 'no Ask button once the row is re-read');
  // Another work event with nothing new for this request: one GET, no repaint.
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed'));
  await AppView._requestRowRefresh.done;
  assert.equal(fetches.length, 2);
  assert.equal(renders.length, 1, 'an unchanged row does not repaint the head');
});

test('#6390: nothing is fetched when no request page or panel is open', async () => {
  const { AppView, sandbox, fetches } = makeAppView();
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: baseIssue() }) });
  AppView._devTopic = null;
  AppView._devTopicInPanel = false;
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  // A proposal's page is not a request row.
  AppView._devTopic = { kind: 'proposal', id: 9 };
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  // A request the panel has closed no longer refreshes.
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = false;
  sandbox.App.currentTab = 'homeroom-bot';
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  assert.deepEqual(fetches, []);
});

test('#6390: a burst of work events is one fetch, with one more queued behind it', async () => {
  const { AppView, sandbox, fetches } = makeAppView();
  const pending = [];
  sandbox.answer = async () => new Promise((resolve) => {
    pending.push(() => resolve({ ok: true, json: async () => ({ issue: baseIssue({ bot: { what: 'reading', mine: true } }) }) }));
  });
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [baseIssue()];
  AppView._devDataSlug = 'demo';
  const first = AppView._refreshOpenRequestRow();
  AppView._refreshOpenRequestRow();
  AppView._refreshOpenRequestRow();
  assert.equal(fetches.length, 1, 'one fetch in flight');
  pending.shift()();
  await new Promise((r) => setImmediate(r));
  assert.equal(fetches.length, 2, 'the burst asked for one more read, not one per event');
  pending.shift()();
  await first;
  assert.equal(fetches.length, 2);
});
