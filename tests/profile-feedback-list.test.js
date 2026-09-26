// "Your feedback" on the Me screen (#3186): the More row, the list it opens,
// the address that opens it from elsewhere, and the two ways in from outside
// Me (the feedback challenge's page; the dialog's confirmations are pinned in
// tests/feedback-first-ui.test.js).
//
// Pinned here: what each row SAYS for each status, that a row links only to a
// request it can name, that a failed read is told apart from "nothing sent",
// that the list renders nothing until it is asked for (the island rule: the
// prerender stays empty), and that `#profile?feedback` opens it once and takes
// the ask off the address.
//
// Run with: node --test tests/profile-feedback-list.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const STORE = 'frontend/src/features/profile/profile-store.js';
const NOW = Date.parse('2026-09-26T12:00:00Z');

const FEEDBACK = {
  sent: 3,
  counted: 1,
  reports: [
    { id: 30, title: 'Me tab is slow', target: 'platform', appSlug: 'usernode-2d5619', appName: 'Homeroom',
      issueNumber: 3001, createdAt: '2026-09-23T12:00:00Z', status: 'counted', points: 180 },
    { id: 20, title: 'Board jumps', target: 'app', appSlug: 'recipe-box', appName: 'Recipe Box',
      issueNumber: 41, createdAt: '2026-09-26T08:00:00Z', status: 'received', points: null },
    { id: 10, title: null, target: 'app', appSlug: null, appName: null,
      issueNumber: 7, createdAt: null, status: 'received', points: null },
  ],
};

test('each report says what was sent, where, its status, and links to its request', () => {
  const { feedbackListView } = loadTsx(STORE);
  const view = feedbackListView(FEEDBACK, NOW);
  assert.equal(view.loaded, true);
  assert.equal(view.summary, '3 sent · 1 counted');
  assert.deepEqual(view.rows.map((r) => [r.key, r.status, r.statusLabel, r.href]), [
    ['30', 'counted', 'Counted · 180 pts', '#app/usernode-2d5619/dev/issues/3001'],
    ['20', 'received', 'Received', '#app/recipe-box/dev/issues/41'],
    ['10', 'received', 'Received', null],
  ]);
  assert.equal(view.rows[0].meta, 'Homeroom · request #3001 · sent 3 days ago');
  assert.equal(view.rows[1].meta, 'Recipe Box · request #41 · sent today');
  assert.equal(view.rows[2].title, 'Feedback', 'an untitled report still has a name');
  assert.equal(view.rows[2].meta, 'An app', 'no app left to name, no request to link, no date to invent');
  assert.match(view.rows[0].statusClassName, /emerald/);
  assert.doesNotMatch(view.rows[1].statusClassName, /emerald/);
});

test('a row links only to a request it can name', () => {
  const { feedbackListView } = loadTsx(STORE);
  const row = (r) => feedbackListView({ sent: 1, counted: 0, reports: [{ id: 1, status: 'received', ...r }] }, NOW).rows[0];
  assert.equal(row({ appSlug: 'javascript:alert(1)', issueNumber: 3 }).href, null);
  assert.equal(row({ appSlug: 'Recipe Box', issueNumber: 3 }).href, null);
  assert.equal(row({ appSlug: 'ok', issueNumber: 0 }).href, null);
  assert.equal(row({ appSlug: 'ok', issueNumber: '12' }).href, '#app/ok/dev/issues/12');
  assert.equal(row({ status: 'counted', points: 0 }).statusLabel, 'Counted', 'no points, no "0 pts"');
  assert.equal(row({ status: 'reviewed' }).status, 'received', 'only the two statuses the server can prove');
});

test('a failed read is not "nothing sent", and a capped list says so', () => {
  const { feedbackListView } = loadTsx(STORE);
  assert.deepEqual(feedbackListView(null, NOW), { loaded: false, summary: null, truncated: false, rows: [] });
  const empty = feedbackListView({ sent: 0, counted: 0, reports: [] }, NOW);
  assert.equal(empty.loaded, true);
  assert.equal(empty.summary, 'Nothing sent yet');
  assert.equal(feedbackListView({ ...FEEDBACK, sent: 120, truncated: true }, NOW).truncated, true);
});

test('the list renders its rows, its empty state and its failure', () => {
  const { feedbackListView } = loadTsx(STORE);
  const { FeedbackSheet } = loadTsx('frontend/src/features/profile/feedback-sheet.tsx');
  const html = renderToHtml(createElement(FeedbackSheet, { view: feedbackListView(FEEDBACK, NOW) }));
  assert.match(html, /id="profile-feedback-sheet"/);
  assert.match(html, />Your feedback</);
  assert.match(html, /id="profile-feedback-summary"[^>]*>3 sent · 1 counted</);
  assert.match(html, /<a [^>]*href="#app\/usernode-2d5619\/dev\/issues\/3001"[^>]*data-feedback-report="30"[^>]*data-feedback-status="counted"/);
  assert.match(html, /Counted · 180 pts/);
  assert.match(html, /<div [^>]*data-feedback-report="10"/, 'no request, so a row and not a link');
  assert.match(html, /Received: it was filed as a request\. Counted: it earned points in the feedback challenge\./);
  const empty = renderToHtml(createElement(FeedbackSheet, { view: feedbackListView({ sent: 0, counted: 0, reports: [] }, NOW) }));
  assert.match(empty, /id="profile-feedback-empty"/);
  assert.doesNotMatch(empty, /profile-feedback-list/);
  const failed = renderToHtml(createElement(FeedbackSheet, { view: feedbackListView(null, NOW) }));
  assert.match(failed, /id="profile-feedback-error"[^>]*>Your feedback could not be loaded/);
  const capped = renderToHtml(createElement(FeedbackSheet, {
    view: feedbackListView({ ...FEEDBACK, truncated: true }, NOW),
  }));
  assert.match(capped, /Showing the 50 you sent most recently\./);
});

test('Me draws the list only once it is asked for', () => {
  const real = loadTsx(STORE);
  const base = {
    open: true,
    data: { ranking: {}, summary: null, ownerPublicProfile: null, feedback: FEEDBACK },
    user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
  };
  const render = (state) => {
    const mod = loadTsx('frontend/src/features/profile/profile-view.tsx', {
      stubs: { './profile-store.js': { ...real, profileStore: { get: () => state, subscribe: () => () => {} } } },
    });
    return renderToHtml(createElement(mod.ProfileRoot, {}));
  };
  const closed = render({ ...base, feedbackOpen: false });
  assert.doesNotMatch(closed, /profile-feedback-sheet/);
  assert.match(closed, /id="profile-row-feedback"[^>]*href="#profile\?feedback"/);
  assert.match(closed, /3 sent · 1 counted/, 'the row carries the tally');
  assert.match(render({ ...base, feedbackOpen: true }), /id="profile-feedback-sheet"/);
  // The shipped state is `open: false`, which renders nothing at all.
  assert.equal(real.profileStore.get().feedbackOpen, false);
  assert.equal(real.buildProfileView(real.profileStore.get()).kind, 'empty');
});

test('the More row falls back to what is behind it without a tally', () => {
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null, feedback: null } }));
  assert.match(html, /Your feedback/);
  assert.match(html, /What you sent, and whether it counted/);
  // A plain click opens the card in place; a modified one is the browser's.
  const src = fs.readFileSync(path.join(root, 'frontend/src/features/profile/account-panel.tsx'), 'utf8');
  const row = src.slice(src.indexOf('id="profile-row-feedback"'), src.indexOf('id="profile-row-settings"'));
  assert.match(row, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;/);
  assert.match(row, /event\.preventDefault\(\);\s*Profile\.showFeedback\(\);/);
});

// ── The address ─────────────────────────────────────────────────────────

function loadProfile(hash) {
  const replaced = [];
  globalThis.location = { hash, pathname: '/', search: '?demo=1' };
  globalThis.history = { state: null, replaceState(_s, _t, url) { replaced.push(url); } };
  const { Profile, profileStore } = loadTsx('frontend/src/features/profile/mount.ts');
  return { Profile, profileStore, replaced };
}

test('#profile?feedback asks for the list once, and the ask comes off the address', (t) => {
  t.after(() => { delete globalThis.location; delete globalThis.history; });
  const { Profile, replaced } = loadProfile('#profile?feedback');
  assert.equal(Profile._takeFeedbackRoute(), true);
  assert.deepEqual(replaced, ['/?demo=1#profile'], 'the query string survives; the ask does not');
  for (const hash of ['#profile', '#profile/feedback', '#profile?other=1', '#settings?feedback', '#profile/evan?feedback']) {
    globalThis.location.hash = hash;
    assert.equal(Profile._takeFeedbackRoute(), false, hash);
  }
  assert.equal(replaced.length, 1);
});

test('the list opens over the own profile only, and leaving Me closes it', (t) => {
  t.after(() => { delete globalThis.location; delete globalThis.history; });
  const { Profile, profileStore } = loadProfile('#profile');
  Profile._open = true;
  Profile._feedbackRequested = true;
  Profile._data = null;
  Profile._maybeOpenFeedback();
  assert.equal(profileStore.get().feedbackOpen, false, 'still loading: the load opens it');
  assert.equal(Profile._feedbackRequested, true);
  Profile._data = { error: true };
  Profile._maybeOpenFeedback();
  assert.equal(profileStore.get().feedbackOpen, false, 'never over an error');
  assert.equal(Profile._feedbackRequested, false, 'and the ask is spent');
  Profile._feedbackRequested = true;
  Profile._data = { ranking: {}, feedback: FEEDBACK };
  Profile._maybeOpenFeedback();
  assert.equal(profileStore.get().feedbackOpen, true);
  Profile.showFeedback();
  assert.equal(profileStore.get().feedbackOpen, true, 'a second open is a no-op');
  Profile._feedbackRequested = true;
  Profile.close();
  assert.equal(profileStore.get().feedbackOpen, false);
  assert.equal(Profile._feedbackRequested, false, 'a pending ask does not outlive the screen');
});

// ── The feedback challenge's page ───────────────────────────────────────

test('the feedback challenge\'s page links to Your feedback, and no other page does', () => {
  const src = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
  const sandbox = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {}, console, setTimeout, clearTimeout, URL,
    location: { hash: '#leaderboard/challenges', search: '', origin: 'https://app.onhomeroom.com', hostname: 'app.onhomeroom.com' },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  const pageOf = (illustration) => {
    pane._detailChallenge = { id: 5, completed: false, card_preview: { goal: 'Send useful feedback', illustration } };
    return pane.detailView();
  };
  assert.equal(pageOf('useful-feedback').feedbackLink, true);
  assert.equal(pageOf('try-three-apps').feedbackLink, false);
  assert.equal(pageOf(null).feedbackLink, false);
  pane._detailChallenge = null;

  const { DetailPage } = loadTsx('frontend/src/features/leaderboard/challenges-pane.tsx');
  const view = {
    key: '5', eyebrow: null, goal: 'Send useful feedback', task: null, illustration: null, illustrationTone: null,
    deadline: null, amount: null, state: 'progress', stateLabel: '1/4 reports', fill: 0.25, counted: true,
    cta: null, description: null, requirements: null, scoring: null, participants: 'Participants',
    pointsTotal: null, moreLabel: 'Show more', entries: { kind: 'empty' },
  };
  assert.match(renderToHtml(createElement(DetailPage, { view: { ...view, feedbackLink: true } })),
    /<a id="tc-se-feedback-mine" href="#profile\?feedback"[^>]*>See your feedback<\/a>/);
  assert.doesNotMatch(renderToHtml(createElement(DetailPage, { view: { ...view, feedbackLink: false } })),
    /tc-se-feedback-mine/);
});
