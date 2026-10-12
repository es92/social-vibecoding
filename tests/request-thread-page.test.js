// #4453: a request's page, drawn as a Messages reply thread.
//
// The request is the root post (features/dev-board/topic/request-head.tsx),
// its replies one stream in the order they were written, wherever they were
// written (features/group-chat/transcript.tsx `RequestRows`), and the rule
// for which rows are a spec and which are the same spec twice is
// features/dev-board/topic/request-model.ts. The issue row's half is
// AppView's (`_requestView`, `_requestStatusView`, `_requestMenuItems`,
// `_requestThreadRows`) and the merge by time is GroupChat's.
//
// Run with: node --test tests/request-thread-page.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const MODEL = 'frontend/src/features/dev-board/topic/request-model.ts';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';

const row = (patch) => ({
  id: null, kind: 'message', username: 'maya', time: '09:05 AM',
  timeTitle: 'Oct 8, 2026, 09:05 AM', at: '2026-10-08T09:05:00Z', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false,
  flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
  reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  event: null, eventHref: null,
  ...patch,
});

const specShare = (version, patch = {}) => ({
  title: 'Topics as channels', previewTitle: 'Topics as channels', sharedBy: 'evan', version,
  built: null, prNumber: null, sessionId: 7296, snippetHtml: null, snippetText: null, ...patch,
});

const botSpecComment = row({
  kind: 'github', key: 'g1', username: 'usernode-bot', bodyHtml: '', at: '2026-10-08T19:58:30Z',
  githubSpec: { title: 'Topics as channels', markdown: 'The spec', html: '<p>The spec</p>' },
});

test('the bot\'s GitHub copy of a spec posted here is the same posting twice, and leaves the stream', () => {
  const { requestStream } = loadTsx(MODEL);
  const rows = [
    row({ id: 1, kind: 'spec_share', specShare: specShare(1), at: '2026-10-08T19:58:25Z' }),
    botSpecComment,
    row({ id: 2, kind: 'spec_share', specShare: specShare(2), at: '2026-10-08T21:00:00Z' }),
  ];
  const out = requestStream(rows);
  assert.equal(out.rows.length, 2, 'the mirror is gone');
  assert.ok(!out.rows.some((m) => m.kind === 'github'));
  assert.equal(out.specs.length, 1, 'one card per spec');
  assert.equal(out.specs[0].version, 2, 'at its newest version');
  assert.equal(out.specs[0].read.kind, 'shared');
});

test('with no posting in the thread, the bot\'s spec comment is the spec: a card, by Homeroom bot', () => {
  const { requestStream } = loadTsx(MODEL);
  const out = requestStream([row({ id: 1 }), botSpecComment]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.specs.length, 1);
  assert.equal(out.specs[0].by, 'Homeroom bot');
  assert.equal(out.specs[0].version, null);
  assert.equal(out.specs[0].read.kind, 'text');
});

test('the stage: no spec is Asked, a spec is Spec, and the row\'s Built or Voted in wins', () => {
  const { requestStage, replyCount, eventText } = loadTsx(MODEL);
  assert.equal(requestStage('asked', 0), 'asked');
  assert.equal(requestStage('asked', 1), 'spec');
  assert.equal(requestStage('built', 1), 'built');
  assert.equal(requestStage('voted', 0), 'voted');
  assert.equal(replyCount([row({}), row({ kind: 'github' }), row({ kind: 'system' }), botSpecComment]), 2,
    'people count, notices and specs do not');
  assert.equal(eventText(row({ kind: 'system', systemText: 'evan claimed this issue' })), 'evan started working on this');
});

test('the stream: "N replies", a GitHub reply in the same row with "· on GitHub", events as lines', () => {
  const view = {
    lead: { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } },
    messages: [
      row({ id: 1, username: 'jordan', bodyHtml: '<p>Would topics replace categories?</p>' }),
      row({ kind: 'github', key: 'c1', username: 'priya', bodyHtml: '<p>+1 for onboarding</p>' }),
      row({ id: 3, kind: 'system', systemText: 'evan claimed this issue' }),
      row({ id: 4, kind: 'spec_share', specShare: specShare(1) }),
      botSpecComment,
    ],
  };
  const html = renderComponent(TRANSCRIPT, 'RequestRows', { view });
  assert.match(html, /class="messages-reply-count"[^>]*><span>2 replies<\/span>/);
  assert.match(html, /gc-msg gc-msg-github[\s\S]*?priya[\s\S]*?· on GitHub/);
  assert.match(html, /data-request-event="claim"[\s\S]*?<b>evan<\/b> started working on this/);
  assert.match(html, /data-request-event="spec"[\s\S]*?<b>evan<\/b> posted plan v1[\s\S]*?>Read</);
  assert.doesNotMatch(html, /Homeroom bot/, 'the bot\'s copy of the posting is not drawn');
});

// One request, one story: Homeroom bot's plan reads as its own sentence on
// the request's page (homeroom-bot-live.js specCard puts `botNote` on it).
test('Homeroom bot\'s plan row says what it is doing with the plan, with its Read', () => {
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  const bot = (patch) => specShare(1, { sharedBy: 'homeroom_bot', title: 'Dark mode', ...patch });
  const html = renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead, messages: [
    row({ id: 1, kind: 'spec_share', specShare: bot({ botNote: 'building' }) }),
    row({ id: 2, kind: 'spec_share', specShare: bot({ version: 2, botNote: 'waiting', waitingFor: 'sam' }) }),
    row({ id: 3, kind: 'spec_share', specShare: bot({ version: 3, botNote: 'waiting' }) }),
    row({ id: 4, kind: 'spec_share', specShare: bot({ version: 4 }) }),
  ] } });
  assert.match(html, /Plan v1: Dark mode\. I(?:'|&#x27;|&#39;)m building it now\.[\s\S]*?>Read</);
  assert.match(html, /Plan v2: Dark mode\. Waiting for @sam to say Build it\.[\s\S]*?>Read</);
  assert.match(html, /Plan v3: Dark mode\. Waiting for the person who asked for it to say Build it\./);
  assert.match(html, /Plan v4: Dark mode · /, 'an older row of the bot\'s reads as the plan');
  assert.doesNotMatch(html, /posted plan/);
});

test('an empty stream says so once its history is in, and "Loading replies…" before', () => {
  const lead = (loaded) => ({ earlier: false, placeholder: null, language: 'request', request: { loaded } });
  assert.match(renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead: lead(true), messages: [] } }), /No replies yet/);
  assert.match(renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead: lead(false), messages: [] } }), /Loading replies…/);
});

const requestView = (status) => ({
  number: 4417, category: 'Communities & projects', menuKey: 'request:4417', asker: 'evan',
  askedAt: '2026-10-08T14:01:11Z', askedTime: '04:01 PM', askedTitle: 'Oct 8, 2026, 04:01 PM',
  title: 'Add topics as discussion containers', titleEditing: null,
  bodyHtml: '<div class="dev-issue-body"><p>Consider topics.</p></div>',
  editor: { issue: 4417, markdown: 'Consider topics.', source: '**Source:** Homeroom admin (evan)', canEdit: true },
  status: {
    stage: 'asked', lead: 'You’re working on this.', note: null,
    fine: 'If nothing moves by Oct 15, it opens up for someone else.',
    action: { label: 'Continue your work', act: { fn: 'openChangeWorkspace', args: [1] } }, closed: null,
    ...status,
  },
});

test('the root post: who asked and when, the title in bold, the words as a quote, then where it stands', () => {
  const html = renderComponent(HEAD, 'RequestHead', { r: requestView() });
  assert.match(html, /<article class="messages-message dev-request-root" data-ref-issue="4417"/);
  assert.match(html, /messages-message-author">evan<\/span><time[^>]*>04:01 PM<\/time>/);
  assert.match(html, /<h1 class="dev-request-title" data-issue-title="4417">Add topics as discussion containers<\/h1>/);
  assert.match(html, /class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4"/);
  assert.match(html, /data-request-stage="asked"/);
  // The stepper: Asked is where it is, the rest still to come.
  assert.match(html, /data-state="now" aria-current="step"><span class="dev-request-step-mark"><\/span><span class="dev-request-step-label">Asked/);
  assert.equal((html.match(/data-state="next"/g) || []).length, 3);
  assert.match(html, /dev-request-say">You’re working on this\.<\/p><p class="dev-request-fine">If nothing moves by Oct 15/);
  assert.match(html, /data-act="openChangeWorkspace"[^>]*>Continue your work</);
});

test('voted in: every step is done, with no fill; a closed request says so instead of the stepper', () => {
  const voted = renderComponent(HEAD, 'RequestHead', { r: requestView({ stage: 'voted', lead: 'Voted in.', action: null }) });
  assert.equal((voted.match(/data-state="done"/g) || []).length, 4);
  const closed = renderComponent(HEAD, 'RequestHead', { r: requestView({ closed: 'This request was closed by vote.', action: null }) });
  assert.doesNotMatch(closed, /dev-request-steps/);
  assert.match(closed, /This request was closed by vote\./);
});

function appView(username = 'evan', globals = {}) {
  const c = {
    ...globals,
    console,
    App: { user: { id: 42, username, canAdminWrite: !!globals.admin }, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._govProposals = [];
  return c.av;
}

const issue = (patch = {}) => ({
  number: 4417, state: 'open', title: 'Add topics', created_by_username: 'evan',
  body: '**Source:** Homeroom admin (evan)\n\nConsider "topics" as other channels.',
  createdAt: '2026-10-08T14:01:11Z', bounty_count: 0, chatCount: 0, in_progress: null,
  category: { top: null }, priority: { top: null }, assignee: { top: null },
  ...patch,
});

test('the page leaves the Source line out of the words, and the editor puts it back', () => {
  const av = appView();
  const row = issue();
  av._ghIssues = [row];
  const r = av._topicViewFor('issue', row).body.request;
  assert.doesNotMatch(r.bodyHtml, /Source/);
  assert.match(r.bodyHtml, /Consider/);
  assert.equal(r.editor.source, '**Source:** Homeroom admin (evan)');
  assert.equal(r.editor.markdown, 'Consider "topics" as other channels.');
  assert.equal(r.asker, 'evan');
  assert.equal(r.askedAt, '2026-10-08T14:01:11Z');
});

test('the status sentence says who is on it once, and when the claim lapses', () => {
  const av = appView();
  const expiresAt = '2026-10-15T13:00:00Z';
  const mine = av._requestStatusView(issue({
    in_progress: { claims: [{ username: 'evan', mine: true, claimedAt: '2026-10-08T13:00:00Z', expiresAt }], sessions: [], users: [], count: 0 },
  }));
  assert.equal(mine.stage, 'asked');
  assert.equal(mine.lead, 'You’re working on this.');
  assert.match(mine.fine, /^If nothing moves by .+, it opens up for someone else\.$/);
  const nobody = av._requestStatusView(issue());
  assert.equal(nobody.lead, 'Nobody is working on this yet.');
  const merged = av._requestStatusView(issue({ addressed_by: { sessionId: 9, state: 'merged', prNumber: 12, title: 'Topics' } }));
  assert.equal(merged.stage, 'voted');
  assert.equal(merged.lead, 'Live.');
  assert.equal(merged.note, null, 'the sentence already says it is live');
  assert.equal(merged.action.label, 'See the change');
  const underway = av._requestStatusView(issue({ myPrSessionId: 77, addressed_by: { sessionId: 77, state: 'underway', title: 'Topics' } }));
  assert.equal(underway.stage, 'built');
  assert.equal(underway.action.label, 'Continue your work');
  assert.deepEqual(JSON.parse(JSON.stringify(underway.action.act)), { fn: 'openChangeWorkspace', args: [77] });
});

// #4663: Homeroom bot built this request, its change waits for approval, and
// the status card still offered "Ask Homeroom bot to build this" — a second
// build of something already built. The card offers "See the change" instead.
test('the status card asks the bot no more once its change waits for approval', () => {
  const av = appView();
  av._ghIssuesMeta = { homeroomBot: { typicalMinutes: 7 } };
  const built = av._requestStatusView(issue({
    addressed_by: { sessionId: 9, state: 'review', prNumber: 12, title: 'Topics' },
  }));
  assert.equal(built.stage, 'built');
  // One request, one story: no "Nobody is working on this yet." while its
  // change waits for votes; the sentence says it is up for a vote.
  assert.equal(built.lead, 'Up for a vote.');
  assert.equal(built.note, null);
  assert.equal(built.action.label, 'See the change');
  assert.equal(built.action.href, '#app/example/dev/changes/12');
  assert.equal(built.action.act, undefined);
});

// One request, one story: the status card says what is really happening.
test('the status card says what Homeroom bot is really doing, or waiting for', () => {
  const av = appView();
  const lead = (patch) => av._requestStatusView(issue(patch)).lead;
  assert.equal(lead({ botAwaits: { kind: 'question', messageId: 5 } }), 'Waiting for an answer to Homeroom bot\'s question.');
  assert.equal(lead({ bot: { what: 'queued', since: null, plan: true, askedBy: 'sam' } }), 'Waiting for @sam to OK the plan.');
  assert.equal(lead({ bot: { what: 'queued', since: null, plan: true } }), 'Waiting for the person who asked for it to OK the plan.');
  assert.equal(lead({ bot: { what: 'building', since: null } }), 'Homeroom bot is building this.');
  assert.equal(lead({ bot: { what: 'queued', since: null, held: true } }),
    'Homeroom bot will start when one of its changes here is voted in or closed.');
  assert.equal(lead({ bot: { what: 'queued', since: null } }), 'Homeroom bot will build this next.');
  // Its sentence is the plan's news: no "Plan v1 is ready for comments." after it.
  assert.match(fs.readFileSync(path.join(__dirname, '..', HEAD), 'utf8'), /const specLine = stage === 'spec' && !s\.botSays/);
  assert.equal(av._requestStatusView(issue({ bot: { what: 'queued', plan: true, askedBy: 'sam' } })).botSays, true);
  assert.equal(av._requestStatusView(issue()).botSays, false);
  // Up for a vote, with how many more yes it needs when the vote panel knows.
  av.voteState = { bySession: { 9: { id: 9, status: 'promoted' } }, byPrNumber: {} };
  av.statusPillState = () => ({ yes: 1, majority: 3 });
  assert.equal(lead({ addressed_by: { sessionId: 9, state: 'review', prNumber: 12, title: 'Topics' } }), 'Up for a vote: needs 2 more yes.');
  av.statusPillState = () => ({ yes: 0, majority: 1 });
  assert.equal(lead({ addressed_by: { sessionId: 9, state: 'review', prNumber: 12, title: 'Topics' } }), 'Up for a vote: needs 1 more yes.');
  // Its plan waiting, and its build held, say so on the card's button too.
  const button = (bot) => av._issuePrimaryActionSpec(issue({ bot }), { noNav: true });
  assert.equal(button({ what: 'queued', plan: true, askedBy: 'sam' }).label, 'Waiting for the plan\'s OK');
  assert.equal(button({ what: 'queued', held: true }).label, 'Homeroom bot will build this');
  assert.equal(button({ what: 'queued' }).label, 'Homeroom bot is on it');
});

test('⋯ holds the work rows first, then the author\'s edits and the tags', () => {
  const av = appView();
  const row = issue({ myPrSessionId: 77 });
  av._ghIssues = [row];
  const labels = JSON.parse(JSON.stringify(av._requestMenuItems(row).map((item) => item.label)));
  assert.deepEqual(labels.slice(0, 4), ['Start more work', 'Claim it', 'Edit title', 'Edit request']);
  assert.ok(labels.includes('Set priority…') && labels.includes('Set category…') && labels.includes('Assign someone…'));
  assert.ok(labels.indexOf('Assign someone…') < labels.indexOf('Open on GitHub') || !labels.includes('Open on GitHub'));
});

test('an admin can release somebody else\'s claim from ⋯, and nobody else is offered it', () => {
  const claimed = issue({
    in_progress: { claims: [{ username: 'maya', userId: 7, mine: false, claimedAt: '2026-10-08T13:00:00Z' }], sessions: [], users: [], count: 0 },
  });
  const admin = appView('evan', { admin: true });
  admin._ghIssues = [claimed];
  assert.ok(admin._requestMenuItems(claimed).some((item) => item.label === 'Release maya’s claim'));
  const member = appView('evan');
  member._ghIssues = [claimed];
  assert.ok(!member._requestMenuItems(claimed).some((item) => /^Release/.test(item.label)));
});

test('GitHub comments become stream rows; Homeroom bot\'s spec rides as githubSpec, not as words', () => {
  const av = appView();
  const row = issue({ htmlUrl: 'https://github.com/o/r/issues/4417' });
  av._ghIssues = [row];
  av._ghComments.set(av._ghCommentsKey('example', 4417), {
    truncated: true,
    comments: [
      { id: 5, author: 'priya', body: '+1', createdAt: '2026-10-08T20:11:00Z' },
      { id: 6, author: 'usernode-bot', body: 'evan posted a spec.\n\n<details><summary>The spec</summary>\n\n# Topics\n\nThe body\n\n</details>', createdAt: '2026-10-08T19:58:25Z' },
    ],
  });
  const out = av._requestThreadRows(4417);
  assert.equal(out.truncated, true);
  assert.equal(out.htmlUrl, 'https://github.com/o/r/issues/4417');
  assert.equal(out.rows[0].kind, 'github');
  assert.equal(out.rows[0].key, '5');
  assert.equal(out.rows[0].githubSpec, null);
  assert.equal(out.rows[1].githubSpec.title, 'Topics');
  assert.equal(out.rows[1].bodyHtml, '');
  assert.equal(av._requestThreadRows(1), null, 'nothing until the comments are in hand');
});

function groupChat() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' }, URLSearchParams,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {} }) },
    window: { matchMedia: () => ({ matches: false }) }, navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

test('GitHub comments are slotted into the thread by time, and the thread\'s own order is kept', () => {
  const GroupChat = groupChat();
  const hr = [
    { id: 1, at: '2026-10-08T09:00:00Z' },
    { id: 2, at: '2026-10-08T11:00:00Z' },
    // Same instant as the one before it, and then an older one: a run the
    // repeat fold reads in the server's order.
    { id: 3, at: '2026-10-08T11:00:00Z' },
    { id: 4, at: '2026-10-08T10:59:00Z' },
  ];
  const gh = [{ key: 'b', at: '2026-10-08T12:00:00Z' }, { key: 'a', at: '2026-10-08T10:00:00Z' }];
  const merged = JSON.parse(JSON.stringify(GroupChat._mergeByTime(hr, gh).map((r) => r.id || r.key)));
  assert.deepEqual(merged, [1, 'a', 2, 3, 4, 'b']);
});
