'use strict';

// Profile's "Your work" (UI overhaul): Your changes, Your requests and Your
// votes, three rows on Me and three views of one screen
// (frontend/src/features/profile/my-proposals.tsx, `#profile-proposals-screen`).
//
//   - the server's numbers and rows (src/routes/profile.js: the summary's
//     in-progress count and GET /api/me/requests; the SQL itself runs in
//     tests/me-requests-postgres.test.js);
//   - what each view says, from ./profile-store.js;
//   - the screen: hidden and empty in the prerender, one view at a time, the
//     long groups folded, and Suggest an improvement at the foot of Your requests;
//   - the router's three addresses.
//
// Run with: node --test tests/profile-your-work.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const SCREEN = 'frontend/src/features/profile/my-proposals.tsx';
const NOW = Date.parse('2026-09-23T12:00:00Z');

// ── The server ─────────────────────────────────────────────────────────

test('the summary counts what is in progress: in an agent session or up for a vote', () => {
  const profile = require('../src/routes/profile');
  assert.equal(profile.shapeSummary({ counts: { merged: 9, in_progress: 2 } }).inProgress, 2);
  const sql = read('src/routes/profile.js');
  // A merged change still going live (live_at null) is in progress too.
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE cs\.status IN \(\s*'active', 'paused', 'promoted', 'merging'\s*\) OR \(cs\.status = 'merged' AND cs\.live_at IS NULL\)\)::int AS in_progress,/);
});

test('your requests: each says where it stands, and the counts are the whole set\'s', () => {
  const profile = require('../src/routes/profile');
  const row = (number, over) => ({
    number, title: `Request ${number}`, created_at: '2026-09-20T10:00:00Z',
    app_slug: 'run-club', app_name: 'Run Club', self_hosted: false,
    shipped: false, closed: false, underway: false, total: 9, done: 3, ...over,
  });
  const body = profile.shapeRequests([
    row(1),
    row(2, { underway: true }),
    row(3, { shipped: true, underway: true }),
    row(4, { closed: true }),
    row(5, { app_slug: 'usernode-2d5619', app_name: 'usernode', self_hosted: true }),
  ]);
  assert.deepEqual(body.requests.map((r) => [r.number, r.state, r.appName]), [
    [1, 'waiting', 'Run Club'],
    [2, 'underway', 'Run Club'],
    [3, 'shipped', 'Run Club'],
    [4, 'closed', 'Run Club'],
    [5, 'waiting', 'Homeroom'],
  ], 'shipped wins over under way; the platform\'s own are Homeroom\'s');
  assert.equal(body.open, 6);
  assert.equal(body.done, 3);
  assert.equal(body.truncated, true, 'nine in all, five shown');
  assert.deepEqual(profile.shapeRequests([]), { requests: [], open: 0, done: 0 });
  // Staging's demo fills an empty list only, with one of each standing.
  const demo = profile.withDemoRequests({ requests: [], open: 0, done: 0 }, { slug: 'usernode-2d5619' }, NOW);
  assert.deepEqual(demo.requests.map((r) => r.state), ['waiting', 'underway', 'shipped']);
  assert.equal(demo.open, 2);
  const real = { requests: [{ number: 7 }], open: 1, done: 0 };
  assert.equal(profile.withDemoRequests(real, { slug: 'x' }), real, 'real rows win');
  // Me-scoped, and registered behind the signed-in gate.
  assert.match(read('src/routes/profile.js'), /router\.get\('\/api\/me\/requests', requireUser,/);
});

test('your votes can link a group decision to its page', () => {
  const kudos = read('src/routes/kudos.js');
  assert.match(kudos, /i\.github_issue_number AS issue_number, i\.title AS issue_title, i\.kind AS issue_kind, i\.id AS issue_id,/);
  assert.equal((kudos.match(/NULL::int AS issue_id,/g) || []).length, 3, 'every other arm lines up with a NULL');
  assert.match(kudos, /item\.issue = \{ id: r\.issue_id, number: r\.issue_number, title: r\.issue_title, kind: r\.issue_kind \};/);
});

// ── What each view says ────────────────────────────────────────────────

test('Your changes: in progress (either kind, newest first), then merged, then closed', () => {
  const { proposalsView } = loadTsx(STORE);
  const row = (id, at, title) => ({ sessionId: id, title, appSlug: 'run-club', appName: 'Run Club', at });
  const view = proposalsView({
    proposals: {
      openForVote: [row(2, '2026-09-22T10:00:00Z', 'Fix pace rounding')],
      inProgress: [row(1, '2026-09-23T10:00:00Z', 'Dark mode for run logs')],
      merged: [row(3, '2026-09-21T12:00:00Z', 'Pace calculator')],
      closed: [row(4, '2026-08-01T12:00:00Z', 'Leaderboard badges')],
    },
  }, NOW);
  assert.deepEqual(view.sections.map((s) => s.label), ['In progress', 'Live', 'Closed']);
  assert.deepEqual(view.sections[0].rows.map((r) => [r.title, r.meta, r.href]), [
    ['Dark mode for run logs', 'Run Club · in progress', '#app/run-club/dev/sessions/1'],
    ['Fix pace rounding', 'Run Club · waiting for approval', '#app/run-club/dev/proposals/2'],
  ]);
  assert.equal(view.sections[1].rows[0].meta, 'Run Club · 2 days ago');
  assert.equal(view.sections[2].rows[0].meta, 'Run Club · closed without going live');
  assert.equal(proposalsView(null).loaded, false, 'a read that has not answered is not "nothing started"');
  assert.equal(proposalsView({ proposals: { inProgress: [], merged: [] } }).empty, true);
});

test('Your changes: one list across projects, each row led by its project\'s icon (#3364)', () => {
  const profile = require('../src/routes/profile');
  // The server carries the icon beside the name; an image id that is not a
  // plain id never becomes a URL.
  assert.match(profile.MY_PROPOSALS_SQL, /a\.slug AS app_slug, a\.name AS app_name, a\.icon_emoji, a\.icon_image_id/);
  const shaped = profile.shapeProposals([
    { section: 'inProgress', session_id: 1, title: 'A', app_slug: 'run-club', app_name: 'Run Club', icon_emoji: '🏃', icon_image_id: null, status: 'active', at: null },
    { section: 'merged', session_id: 2, title: 'B', app_slug: 'whiteboard', app_name: 'Whiteboard', icon_emoji: null, icon_image_id: 'abc_1', status: 'merged', at: null },
    { section: 'merged', session_id: 3, title: 'C', app_slug: 'odd', app_name: 'Odd', icon_emoji: null, icon_image_id: '../x', status: 'merged', at: null },
  ]).proposals;
  assert.deepEqual([shaped.inProgress[0].appIconEmoji, shaped.inProgress[0].appIconUrl], ['🏃', null]);
  assert.deepEqual(shaped.merged.map((r) => r.appIconUrl), ['/app-icons/abc_1', null]);
  const demo = profile.withDemoProposals({ openForVote: [], inProgress: [], merged: [], closed: [] },
    { slug: 'usernode-2d5619', name: 'Homeroom', icon_emoji: '🏠', icon_image_id: null }, NOW);
  assert.equal(demo.inProgress[0].appIconEmoji, '🏠');

  // The view hands each row its project in app-card.js's field names.
  const { proposalsView } = loadTsx(STORE);
  const view = proposalsView({
    proposals: {
      inProgress: [
        { sessionId: 1, title: 'Dark mode', appSlug: 'run-club', appName: 'Run Club', appIconEmoji: '🏃', at: '2026-09-23T10:00:00Z' },
      ],
      openForVote: [
        { sessionId: 2, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', appIconUrl: '/app-icons/abc', at: '2026-09-22T10:00:00Z' },
      ],
    },
  }, NOW);
  assert.equal(view.sections.length, 1, 'both projects share the one In progress group');
  assert.deepEqual(view.sections[0].rows.map((r) => r.app), [
    { slug: 'run-club', name: 'Run Club', icon_emoji: '🏃', icon_url: null },
    { slug: 'whiteboard', name: 'Whiteboard', icon_emoji: null, icon_url: '/app-icons/abc' },
  ]);

  // The screen draws the tile ahead of each row: emoji, image, or the letter.
  const mod = loadTsx(SCREEN);
  mod.profileProposalsStore.set({
    open: true, kind: 'changes', error: false,
    data: { changes: { proposals: {
      inProgress: [
        { sessionId: 1, title: 'Dark mode', appSlug: 'run-club', appName: 'Run Club', appIconEmoji: '🏃', at: '2026-09-23T10:00:00Z' },
        { sessionId: 3, title: 'Tags', appSlug: 'notes', appName: 'Notes', at: '2026-09-21T10:00:00Z' },
      ],
      openForVote: [
        { sessionId: 2, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', appIconUrl: '/app-icons/abc', at: '2026-09-22T10:00:00Z' },
      ],
    } } },
  });
  const out = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  assert.equal((out.match(/data-profile-work-group=/g) || []).length, 1);
  assert.match(out, /data-icon="emoji" data-profile-work-app="run-club" title="Run Club" aria-hidden="true">[\s\S]*?🏃/);
  // Polish board #11: the app's initial waits under the picture until it has drawn.
  assert.match(out, /data-icon="image" data-profile-work-app="whiteboard" title="Whiteboard" aria-hidden="true"><span class="app-icon-wait" aria-hidden="true">W<\/span><img src="\/app-icons\/abc"/);
  assert.match(out, /data-icon="letter" data-profile-work-app="notes" title="Notes" aria-hidden="true">N</);
  mod.profileProposalsStore.set({ open: false, kind: 'changes', data: {}, error: false });
});

// ── #5272: one page, three tabs; stage chips, a Project choice, next steps ─

const CHANGES = {
  proposals: {
    inProgress: [
      { sessionId: 1, title: 'Dark mode', appSlug: 'run-club', appName: 'Run Club', status: 'active', at: '2026-09-23T10:00:00Z' },
      { sessionId: 5, title: null, appSlug: 'whiteboard', appName: 'Whiteboard', status: 'paused', at: '2026-09-21T10:00:00Z' },
    ],
    openForVote: [
      { sessionId: 2, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', status: 'promoted', at: '2026-09-22T10:00:00Z' },
      { sessionId: 6, title: 'Pace rounding', appSlug: 'run-club', appName: 'Run Club', status: 'merged', at: '2026-09-22T09:00:00Z' },
    ],
    merged: [{ sessionId: 3, title: 'Pace calculator', appSlug: 'run-club', appName: 'Run Club', status: 'merged', at: '2026-09-21T12:00:00Z' }],
    closed: [{ sessionId: 4, title: 'Badges', appSlug: 'notes', appName: 'Notes', status: 'archived', at: '2026-08-01T12:00:00Z' }],
  },
};

test('#5272 Your changes: an untitled change names its project; a paused one says so and carries its next step', () => {
  const { proposalsView } = loadTsx(STORE);
  const view = proposalsView(CHANGES, NOW);
  const rows = Object.fromEntries(view.sections.flatMap((s) => s.rows).map((r) => [r.key, r]));
  assert.equal(rows['5'].title, message('profile:changes.untitled', { project: 'Whiteboard' }));
  assert.equal(rows['5'].title, 'Untitled change to Whiteboard');
  assert.equal(rows['5'].meta, 'paused', 'the title names the project, so the line does not repeat it');
  assert.equal(rows['5'].step, 'Continue', 'a paused session is picked up again from its page');
  assert.equal(rows['1'].meta, 'Run Club · in progress');
  assert.equal(rows['1'].step, null, 'nothing in the read says what an active session needs next');
  assert.equal(rows['2'].meta, 'Whiteboard · waiting for approval');
  assert.equal(rows['6'].meta, 'Run Club · going live', 'approved and on its way is no longer waiting for approval');
  for (const key of ['2', '3', '4', '6']) assert.equal(rows[key].step, null, `row ${key} has no next step of its own`);
  assert.doesNotMatch(read(STORE), /changes\.fallbackTitle/, 'the bare "Change" is gone');
});

test('#5272 Your changes: a PR names an untitled change, and failing checks are the step that comes first', () => {
  const profile = require('../src/routes/profile');
  // The read carries the PR's title and number and the latest checks verdict,
  // straight off chat_sessions (no join), in every bucket.
  assert.equal((profile.MY_PROPOSALS_SQL.match(/cs\.pr_title, cs\.pr_number, cs\.check_state,/g) || []).length, 4);
  assert.match(profile.MY_PROPOSALS_SQL, /SELECT r\.section, r\.session_id, r\.title, r\.pr_title, r\.pr_number, r\.check_state, r\.status, r\.at,/);
  const shaped = profile.shapeProposals([
    { section: 'inProgress', session_id: 1, title: null, pr_title: 'Add lasso', pr_number: 12, check_state: 'failing', app_slug: 'w', app_name: 'W', status: 'paused', at: null },
    { section: 'closed', session_id: 2, title: 'X', pr_title: null, pr_number: null, check_state: null, app_slug: 'w', app_name: 'W', status: 'archived', at: null },
  ]).proposals;
  assert.deepEqual([shaped.inProgress[0].prTitle, shaped.inProgress[0].prNumber, shaped.inProgress[0].checkState], ['Add lasso', 12, 'failing']);
  assert.deepEqual([shaped.closed[0].prTitle, shaped.closed[0].prNumber, shaped.closed[0].checkState], [null, null, null]);
  // The demo shows both: an untitled row with a PR number, and failing checks.
  const demo = profile.withDemoProposals({ openForVote: [], inProgress: [], merged: [], closed: [] },
    { slug: 'usernode-2d5619', name: 'Homeroom' }, NOW);
  assert.ok(demo.inProgress.some((r) => !r.title && r.prNumber === 9999));
  assert.equal(demo.openForVote[0].checkState, 'failing');
  for (const rows of Object.values(demo)) {
    for (const row of rows) assert.ok('prTitle' in row && 'prNumber' in row && 'checkState' in row, 'same shape as a real row');
  }

  const { proposalsView } = loadTsx(STORE);
  const row = (over) => ({ sessionId: 1, title: null, appSlug: 'run-club', appName: 'Run Club', status: 'active', at: '2026-09-23T10:00:00Z', ...over });
  const one = (bucket, over) => proposalsView({ proposals: { [bucket]: [row(over)] } }, NOW).sections[0].rows[0];
  assert.deepEqual([one('inProgress', { prTitle: 'Add lasso' }).title, one('inProgress', { prTitle: 'Add lasso' }).meta],
    ['Add lasso', 'Run Club · in progress'], 'the PR title is a real title, so the line names the project');
  assert.equal(one('inProgress', { prNumber: 42 }).title, message('profile:changes.untitledPr', { number: 42, project: 'Run Club' }));
  assert.equal(one('inProgress', { prNumber: 42 }).title, 'Change #42 to Run Club');
  assert.equal(one('inProgress', { prNumber: 42 }).meta, 'in progress');
  assert.equal(one('inProgress', {}).title, 'Untitled change to Run Club');
  assert.equal(one('inProgress', { status: 'paused', checkState: 'failing' }).step, 'Fix checks', 'failing checks outrank Continue');
  assert.equal(one('openForVote', { status: 'promoted', checkState: 'failing' }).step, 'Fix checks');
  assert.equal(one('openForVote', { status: 'merged', checkState: 'failing' }).step, null, 'going live: nothing left to fix');
  assert.equal(one('closed', { status: 'archived', checkState: 'failing' }).step, null);
  assert.equal(one('inProgress', { checkState: 'error' }).step, null, 'a broken run is not a failed check');
});

test('#5272 Your changes: stage chips and a Project choice narrow the loaded list', () => {
  const { proposalsView, CHANGE_STAGES } = loadTsx(STORE);
  assert.deepEqual([...CHANGE_STAGES], ['inProgress', 'openForVote', 'merged', 'closed']);
  const all = proposalsView(CHANGES, NOW);
  assert.deepEqual(all.stages, ['inProgress', 'openForVote', 'merged', 'closed']);
  assert.deepEqual(all.projects.map((p) => p.slug), ['notes', 'run-club', 'whiteboard'], 'by name');
  assert.deepEqual(all.sections.map((s) => s.key), ['inProgress', 'merged', 'closed'], 'All is the three groups, as before');

  const vote = proposalsView(CHANGES, NOW, { stage: 'openForVote' });
  assert.deepEqual(vote.sections.map((s) => [s.key, s.label, s.rows.map((r) => r.key)]),
    [['openForVote', 'Up for vote', ['2', '6']]]);

  const runClub = proposalsView(CHANGES, NOW, { project: 'run-club' });
  assert.deepEqual(runClub.sections.map((s) => [s.key, s.rows.map((r) => r.key)]),
    [['inProgress', ['1', '6']], ['merged', ['3']]]);
  assert.deepEqual(runClub.stages, all.stages, 'the chips stay put while a project is picked');

  const none = proposalsView(CHANGES, NOW, { stage: 'closed', project: 'run-club' });
  assert.equal(none.filtered, true, 'nothing matches, though something was started');
  assert.equal(none.sections.length, 0);

  const unknown = proposalsView(CHANGES, NOW, { stage: 'bogus', project: 'gone' });
  assert.equal(unknown.stage, 'all');
  assert.equal(unknown.project, '', 'a project no longer in the list is every project');
  assert.equal(proposalsView({ proposals: {} }, NOW).filtered, false, 'nothing started is not "nothing matches"');
});

test('#5272 the screen: three tabs with their addresses, the filters and the pill on Your changes only', () => {
  const mod = loadTsx(SCREEN);
  const html = () => renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  assert.deepEqual(mod.WORK_ROUTES, {
    changes: '#profile/your-changes', requests: '#profile/your-requests', votes: '#profile/your-votes',
  });
  // Every tab address is one the router maps to its view.
  const app = read('public/js/app.js');
  for (const [kind, route] of Object.entries(mod.WORK_ROUTES)) {
    assert.match(app, new RegExp(`'${route.slice('#profile/'.length)}': '${kind}'`));
  }
  assert.doesNotMatch(renderToHtml(createElement(mod.ProfileProposalsScreen, {})), /data-profile-work-tab/,
    'the tabs are not in the prerender');

  mod.profileProposalsStore.set({ open: true, kind: 'changes', error: false, stage: 'all', project: '', data: { changes: CHANGES } });
  let out = html();
  assert.match(out, /data-profile-work-tab="changes" aria-current="page"[^>]*>Changes<[\s\S]*data-profile-work-tab="requests" aria-current="false"[^>]*>Requests<[\s\S]*data-profile-work-tab="votes" aria-current="false"[^>]*>Votes</);
  assert.match(out, /data-profile-work-stage="all"[^>]*>All<[\s\S]*data-profile-work-stage="openForVote"[^>]*>Up for vote</);
  assert.match(out, /aria-pressed="true"[^>]*data-profile-work-stage="all"|data-profile-work-stage="all"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*class="[^"]*"[^>]*data-profile-work-stage="all"/);
  assert.match(out, /data-profile-work-project=""[\s\S]*?<option value="" selected="">All projects<\/option><option value="notes">Notes<\/option>/);
  assert.equal((out.match(/data-profile-work-step=""/g) || []).length, 1, 'one row has a next step');
  assert.match(out, /data-profile-work-step="">Continue</);
  assert.match(out, /Untitled change to Whiteboard/);
  // The groups stay siblings after the filters, as the declared check reads them.
  assert.match(out, /data-profile-work-filters=""[\s\S]*data-profile-work-group="inProgress"[\s\S]*data-profile-work-group="merged"[\s\S]*data-profile-work-group="closed"/);

  mod.profileProposalsStore.set({ stage: 'closed', project: 'run-club' });
  out = html();
  assert.match(out, /None of your changes match these filters\./);
  assert.doesNotMatch(out, /data-profile-work-group=/);

  mod.profileProposalsStore.set({ kind: 'requests', data: { requests: { requests: [{ number: 1, title: 'Export runs', appSlug: 'run-club', appName: 'Run Club', state: 'waiting' }] } } });
  out = html();
  assert.match(out, /data-profile-work-tab="requests" aria-current="page"/);
  assert.doesNotMatch(out, /data-profile-work-filters|data-profile-work-step/, 'the filters are Your changes\' own');
  mod.profileProposalsStore.set({ open: false, kind: 'changes', data: {}, error: false, stage: 'all', project: '' });
});

test('Your requests: open, then done, each opening the request', () => {
  const { requestsView } = loadTsx(STORE);
  const view = requestsView({
    requests: [
      { number: 11, title: 'Export runs to CSV', appSlug: 'run-club', appName: 'Run Club', state: 'underway' },
      { number: 12, title: 'Bigger tap targets', appSlug: 'game-corner', appName: 'Game Corner', state: 'waiting' },
      { number: 21, title: 'Show times in my time zone', appSlug: 'usernode-2d5619', appName: 'Homeroom', state: 'shipped' },
      { number: 13, title: null, appSlug: 'javascript:1', appName: 'Odd', state: 'closed' },
    ],
    truncated: true,
  });
  assert.deepEqual(view.sections.map((s) => [s.label, s.rows.map((r) => r.meta)]), [
    ['Open', ['Run Club · someone is on it', 'Game Corner · nobody on it yet']],
    ['Done', ['Homeroom · live', 'Odd · closed']],
  ]);
  assert.equal(view.sections[0].rows[0].href, '#app/run-club/dev/issues/11');
  assert.equal(view.sections[1].rows[1].href, null, 'no address built from a slug the shell would not route');
  assert.equal(view.sections[1].rows[1].title, 'Request #13');
  assert.equal(view.truncated, true);
  assert.equal(requestsView(undefined).loaded, false);
});

test('Your votes: still open, then decided, each saying your vote as it stands', () => {
  const { votesView } = loadTsx(STORE);
  const view = votesView({
    items: [
      { type: 'pr_vote', vote: 'yes', status: 'promoted', app: { slug: 'run-club', name: 'Run Club' },
        pr: { sessionId: 31, number: 40, title: 'Weekly distance leaderboard' } },
      { type: 'proposal_vote', vote: 'yes', status: 'open', app: { slug: 'run-club', name: 'Run Club' },
        issue: { id: 77, number: null, title: 'Rename to Run Crew', kind: 'rename' } },
      { type: 'pr_vote', vote: 'yes', status: 'merged', app: { slug: 'run-club', name: 'Run Club' },
        pr: { sessionId: 32, title: 'Route map on the run page' } },
      { type: 'pr_vote', vote: 'no', status: 'archived', app: { slug: 'game-corner', name: 'Game Corner' },
        pr: { sessionId: 33, title: 'Timer sounds' } },
      { type: 'kudos', app: { slug: 'x', name: 'X' } },
    ],
    nextBefore: '2026-09-01T00:00:00Z',
  });
  assert.deepEqual(view.sections.map((s) => [s.label, s.rows.map((r) => [r.title, r.meta, r.href])]), [
    ['Still open', [
      ['Weekly distance leaderboard', 'Run Club · you voted yes', '#app/run-club/dev/changes/40'],
      ['Rename to Run Crew', 'Run Club · you voted yes', '#app/run-club/dev/governance/77'],
    ]],
    ['Decided', [
      ['Route map on the run page', 'Run Club · you voted yes · live', '#app/run-club/dev/proposals/32'],
      ['Timer sounds', 'Game Corner · you voted no · closed', '#app/game-corner/dev/proposals/33'],
    ]],
  ], 'kudos are not votes');
  assert.equal(view.more, true);
  assert.equal(votesView({ items: [] }).empty, true);
  assert.equal(votesView(undefined).loaded, false);
});

// #6102: every vote cast is a row, keyed by the server, with the day it
// was cast. A vote changed is two rows on the same change, one per side.
test('Your votes: each cast is its own row, keyed by the server, with its day', () => {
  const { votesView } = loadTsx(STORE);
  const change = { app: { slug: 'run-club', name: 'Run Club' }, pr: { sessionId: 31, number: 40, title: 'Weekly distance leaderboard' } };
  const view = votesView({
    items: [
      { ...change, key: 'e:9', type: 'pr_vote', vote: 'no', status: 'promoted', created_at: '2026-09-23T09:00:00Z' },
      { ...change, key: 'e:8', type: 'pr_vote', vote: 'yes', status: 'promoted', created_at: '2026-09-20T09:00:00Z' },
      // A request is voted up/down (routes/issues.js): the row says yes/no.
      { key: 'e:7', type: 'proposal_vote', vote: 'up', status: 'open', created_at: '2026-09-22T09:00:00Z',
        app: { slug: 'run-club', name: 'Run Club' }, issue: { id: 77, number: null, title: 'Rename to Run Crew', kind: 'rename' } },
      // A standing vote the log never saw, from the vote table, on a change
      // decided since: its day, then the outcome.
      { key: 'pv:3', type: 'pr_vote', vote: 'yes', status: 'merged', created_at: '2026-09-03T09:00:00Z',
        app: { slug: 'run-club', name: 'Run Club' }, pr: { sessionId: 32, title: 'Route map on the run page' } },
      // No key from the server, no date: the row still has a key of its own.
      { type: 'pr_vote', vote: 'no', status: 'archived', app: { slug: 'game-corner', name: 'Game Corner' },
        pr: { sessionId: 33, title: 'Timer sounds' } },
    ],
  }, NOW);
  assert.deepEqual(view.sections.map((s) => [s.label, s.rows.map((r) => [r.key, r.title, r.meta])]), [
    ['Still open', [
      ['e:9', 'Weekly distance leaderboard', `Run Club · you voted no · ${message('profile:date.today')}`],
      ['e:8', 'Weekly distance leaderboard', `Run Club · you voted yes · ${message('profile:date.daysAgo', { count: 3 })}`],
      ['e:7', 'Rename to Run Crew', `Run Club · you voted yes · ${message('profile:date.yesterday')}`],
    ]],
    ['Decided', [
      ['pv:3', 'Route map on the run page', 'Run Club · you voted yes · Sep 3 · live'],
      ['pr_vote:33:4', 'Timer sounds', 'Game Corner · you voted no · closed'],
    ]],
  ], 'two rows for the one change, each its own cast, the day after the vote');
  const keys = view.sections.flatMap((s) => s.rows.map((r) => r.key));
  assert.equal(new Set(keys).size, keys.length, 'every row has a key of its own');
  assert.equal(view.sections[0].rows[0].href, view.sections[0].rows[1].href, 'both casts open the same change');
  // The note under the list says what the list is now.
  assert.equal(message('profile:work.votes.note'),
    'Every vote you cast is here, newest first. If you changed a vote or took it back, each one you cast is its own row.');
  assert.match(read(SCREEN), /t\('profile:work\.votes\.note'\)/);
});

// ── The screen ─────────────────────────────────────────────────────────

test('the screen ships hidden and empty, one root for all three views', () => {
  const mod = loadTsx(SCREEN);
  const html = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  assert.match(html, /^<main id="profile-proposals-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll"[^>]*data-profile-work="changes">/);
  assert.doesNotMatch(html, /data-profile-work-group|Loading/, 'nothing but the frame until it is opened');
  assert.equal(mod.workKind('votes'), 'votes');
  assert.equal(mod.workKind('anything'), 'changes');
  // The titles are catalog entries; the table holds their ids.
  assert.deepEqual(mod.WORK_TITLES,
    { changes: 'profile:work.changes.title', requests: 'profile:work.requests.title', votes: 'profile:work.votes.title' });
  assert.deepEqual(Object.values(mod.WORK_TITLES).map((id) => message(id)), ['Your changes', 'Your requests', 'Your votes']);
});

test('each view draws its own groups; long ones fold; Your requests ends on Suggest an improvement', () => {
  const mod = loadTsx(SCREEN);
  const html = () => renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  const merged = Array.from({ length: 7 }, (_, i) => ({
    sessionId: 100 + i, title: `Merged ${i}`, appSlug: 'run-club', appName: 'Run Club', at: '2026-09-20T10:00:00Z',
  }));
  mod.profileProposalsStore.set({
    open: true, kind: 'changes', error: false,
    data: { changes: { proposals: { inProgress: [], openForVote: [], merged, closed: [] } } },
  });
  let out = html();
  assert.match(out, /data-profile-work-group="merged"/);
  assert.equal((out.match(/Merged \d/g) || []).length, mod.FOLD_AT, 'five, then the fold');
  assert.match(out, /data-profile-work-all="merged"[\s\S]*?Show all live/);

  mod.profileProposalsStore.set({
    kind: 'requests',
    data: { requests: { requests: [{ number: 1, title: 'Export runs', appSlug: 'run-club', appName: 'Run Club', state: 'waiting' }] } },
  });
  out = html();
  assert.match(out, /data-profile-work="requests"/);
  assert.match(out, /Export runs/);
  assert.match(out, /data-profile-work-ask=""[^>]*>Suggest an improvement</);
  assert.match(read(SCREEN), /onClick=\{\(\) => \{ \(window as any\)\.App\?\.openFeedbackModal\?\.\(\); \}\}/);

  mod.profileProposalsStore.set({ kind: 'votes', data: {} });
  assert.match(html(), /Loading…/, 'a view whose read has not answered says so');
  mod.profileProposalsStore.set({ open: false, kind: 'changes', data: {}, error: false });
});

test('the controller reads the view it was opened on, and drops an answer for another', async () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  let release;
  globalThis.location = { search: '' };
  globalThis.fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ items: [] }) }); });
  };
  try {
    const pending = ctl.open('votes');
    assert.deepEqual(asked, ['/api/me/history?type=votes&limit=50']);
    assert.equal(ctl.isOpen('votes'), true);
    assert.equal(ctl.isOpen('requests'), false);
    // The viewer moves on to Your requests before the votes answer.
    store.set({ kind: 'requests' });
    release();
    await pending;
    assert.equal(store.get().data.votes, undefined, 'the votes answer does not paint into Your requests');
    globalThis.fetch = async (url) => { asked.push(url); return { ok: true, json: async () => ({ requests: [] }) }; };
    await ctl.open('requests');
    assert.equal(asked[asked.length - 1], '/api/me/requests');
    assert.deepEqual(store.get().data.requests, { requests: [] });
    ctl.close();
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
  }
});

// ── #5452: a vote shows in Your votes as soon as it is saved ───────────

test('#5452: voted() re-reads the open votes view and publishes what it answered', async () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  const pending = [];
  globalThis.location = { search: '' };
  globalThis.fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { pending.push(resolve); });
  };
  try {
    const first = ctl.open('votes');
    assert.equal(pending.length, 1);
    pending[0]({ ok: true, json: async () => ({ items: [] }) });
    await first;
    assert.deepEqual(store.get().data.votes, { items: [] });

    // A vote is cast while the view is up: the list reads again in place.
    const again = ctl.voted();
    assert.equal(asked.length, 2, 'voted() fetched again');
    assert.equal(asked[1], '/api/me/history?type=votes&limit=50');
    pending[1]({ ok: true, json: async () => ({ items: [
      { type: 'pr_vote', vote: 'yes', status: 'promoted', app: { slug: 'run-club', name: 'Run Club' },
        pr: { sessionId: 31, number: 40, title: 'Weekly distance leaderboard' } },
    ] }) });
    await again;
    assert.equal(store.get().data.votes.items.length, 1, 'the new vote is listed, without a reload');
    assert.equal(store.get().error, false);
    ctl.close();
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    store.set({ open: false, kind: 'changes', data: {}, error: false });
  }
});

test('#5452: voted() with the votes view closed drops the cached list and fetches nothing', () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  globalThis.location = { search: '' };
  // A read that never settles: if voted() fetched here, the ask count says so.
  globalThis.fetch = (url) => { asked.push(url); return new Promise(() => {}); };
  try {
    // Your changes is up, with a votes list left over from an earlier look.
    store.set({ open: true, kind: 'changes', error: false, data: { votes: { items: [] } } });
    ctl.voted();
    assert.equal(store.get().data.votes, undefined, 'the next open loads, it does not paint the old list');
    assert.deepEqual(asked, [], 'nothing fetched: the view is not up');
    // And with no cached list to drop, it stays quiet all the same.
    store.set({ data: {} });
    ctl.voted();
    assert.deepEqual(asked, []);
    assert.deepEqual(store.get().data, {});
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    store.set({ open: false, kind: 'changes', data: {}, error: false });
  }
});

test('#5452: a read started before the vote cannot put the stale list back over the new one', async () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const pending = [];
  globalThis.location = { search: '' };
  globalThis.fetch = () => new Promise((resolve) => { pending.push(resolve); });
  try {
    // The read open() started before the vote was saved…
    const stale = ctl.open('votes');
    // …then the vote is saved and voted() reads again.
    const fresh = ctl.voted();
    assert.equal(pending.length, 2);
    pending[1]({ ok: true, json: async () => ({ items: [{ pr: { sessionId: 31 } }] }) });
    await fresh;
    assert.equal(store.get().data.votes.items.length, 1);
    // …and only now lands. It is the older read, so it publishes nothing.
    pending[0]({ ok: true, json: async () => ({ items: [] }) });
    await stale;
    assert.equal(store.get().data.votes.items.length, 1, 'the stale answer did not overwrite the fresh one');
    ctl.close();
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    store.set({ open: false, kind: 'changes', data: {}, error: false });
  }
});

// ── #5457: the read waits for the network, and the open view catches up ─
//
// On a slow connection the service worker answered the read from its saved
// copy (taken before the vote) and later posted the correction; this screen
// heard neither, so the vote stayed missing until a refresh. The cases below
// run the controller against the real live-reads module, handed in through
// the loader's stub seam so the test holds the very watch/resync/flush the
// controller binds to; _resetLiveReads between cases, and every case loads a
// fresh controller module, so nothing carries over.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('#5457: reload() asks for a fresh answer on each of the three views', async () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  globalThis.location = { search: '' };
  globalThis.fetch = (url, init) => {
    asked.push([url, init]);
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
  try {
    await ctl.open('changes');
    await ctl.open('requests');
    await ctl.open('votes');
    assert.deepEqual(asked.map(([url]) => url), [
      '/api/me/proposal-history',
      '/api/me/requests',
      '/api/me/history?type=votes&limit=50',
    ]);
    for (const [, init] of asked) {
      assert.equal(init.cache, 'no-cache', 'the worker waits for the network, not its saved copy');
      assert.equal(init.credentials, 'same-origin');
    }
    ctl.close();
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
  }
});

test('#5457: a correction to the open view\'s read re-reads it; another view\'s does not', async () => {
  const live = loadTsx('frontend/src/lib/live-reads.ts');
  live._resetLiveReads();
  const mod = loadTsx(SCREEN, { stubs: { '../../lib/live-reads': live } });
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  const pending = [];
  globalThis.location = { search: '' };
  globalThis.fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { pending.push(resolve); });
  };
  try {
    const first = ctl.open('votes');
    pending[0]({ ok: true, json: async () => ({ items: [] }) });
    await first;
    assert.deepEqual(asked, ['/api/me/history?type=votes&limit=50']);

    // The service worker corrects the read the open view owns: it is read
    // again, and what comes back is published.
    live.resync('correction', '/api/me/history?type=votes&limit=50');
    live.flush();
    assert.equal(asked.length, 2, 'the open view re-read its own URL');
    pending[1]({ ok: true, json: async () => ({ items: [{ pr: { sessionId: 31 } }] }) });
    await settle();
    assert.equal(store.get().data.votes.items.length, 1, 'the corrected list is what shows');

    // A correction to another view's URL — or to another kind of history —
    // is not the open view's read, and wakes nothing.
    live.resync('correction', '/api/me/requests');
    live.flush();
    live.resync('correction', '/api/me/history?type=kudos');
    live.flush();
    assert.equal(asked.length, 2, 'only the view that is up is re-read');
    ctl.close();
  } finally {
    live._resetLiveReads();
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    store.set({ open: false, kind: 'changes', data: {}, error: false });
  }
});

test('#5457: a reconnect re-reads the open view; close() stops it; open() stacks nothing', async () => {
  const live = loadTsx('frontend/src/lib/live-reads.ts');
  live._resetLiveReads();
  const mod = loadTsx(SCREEN, { stubs: { '../../lib/live-reads': live } });
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  const pending = [];
  globalThis.location = { search: '' };
  globalThis.fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { pending.push(resolve); });
  };
  try {
    const first = ctl.open('votes');
    pending[0]({ ok: true, json: async () => ({ items: [] }) });
    await first;

    // A socket reconnect (or the tab coming back) re-reads the view that is up.
    live.resync('reconnect');
    live.flush();
    assert.deepEqual(asked, [
      '/api/me/history?type=votes&limit=50',
      '/api/me/history?type=votes&limit=50',
    ], 'one re-read for the pass, of the view that is up');
    pending[1]({ ok: true, json: async () => ({ items: [] }) });
    await settle();

    // Entry then a switch of views: two open() calls left one watcher.
    const second = ctl.open('requests');
    pending[2]({ ok: true, json: async () => ({ requests: [] }) });
    await second;
    asked.length = 0;
    live.resync('reconnect');
    live.flush();
    assert.deepEqual(asked, ['/api/me/requests'], 'still one re-read per pass, now of Your requests');
    pending[3]({ ok: true, json: async () => ({ requests: [] }) });
    await settle();

    ctl.close();
    asked.length = 0;
    live.resync('reconnect');
    live.flush();
    live.resync('correction', '/api/me/requests');
    live.flush();
    assert.deepEqual(asked, [], 'close() stopped the watcher: a closed screen re-reads nothing');
  } finally {
    live._resetLiveReads();
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    store.set({ open: false, kind: 'changes', data: {}, error: false });
  }
});

test('the router: three addresses no username can have, one screen, the bar named for the view', () => {
  const app = read('public/js/app.js');
  assert.match(app, /PROFILE_WORK: \{\s*proposals: 'changes',\s*'your-changes': 'changes',\s*'your-requests': 'requests',\s*'your-votes': 'votes',\s*\},/);
  assert.match(app, /if \(parts\[0\] === 'profile' && App\.PROFILE_WORK\[parts\[1\]\]\) \{[\s\S]{0,600}?App\.navigateToProfileProposals\(App\.PROFILE_WORK\[parts\[1\]\]\);/);
  // The table holds the three titles' message ids, read when the bar is named.
  assert.match(app, /App\.setHeaderTitle\(PlatformI18n\.t\(App\.PROFILE_WORK_TITLES\[view\]\)\);/);
  assert.match(app, /PROFILE_WORK_TITLES: \{\s*changes: 'shell:title\.yourChanges', requests: 'shell:title\.yourRequests', votes: 'shell:title\.yourVotes',\s*\},/);
  assert.deepEqual(['shell:title.yourChanges', 'shell:title.yourRequests', 'shell:title.yourVotes'].map((id) => message(id)),
    ['Your changes', 'Your requests', 'Your votes']);
  assert.match(app, /window\.UsernodeReact\?\.profileProposals\?\.open\?\.\(view\);/);
  // The dialog's "See your requests" lands on the view.
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'), /const SEE_MINE_ROUTE = '#profile\/your-requests';/);
});

// ── #5454: coming back to the screen from an app reads the list again ──

test('#5454: the already-open guard stops only the duplicate dispatch, not a return from an app', () => {
  const app = read('public/js/app.js');
  const start = app.indexOf('  navigateToProfileProposals(');
  assert.ok(start > 0, 'navigateToProfileProposals is defined in app.js');
  const body = app.slice(start, app.indexOf('\n  },', start));
  // With an app open the entry must run on to open(view) (which reloads),
  // AppView.close() and the reveal; only the same view re-entered with no
  // app open bails out, so one tick's popstate + hashchange still paints
  // once (#979).
  assert.match(body, /if \(App\._inProfileProposals && !App\.currentApp && window\.UsernodeReact\?\.profileProposals\?\.isOpen\?\.\(view\)\) \{\s*return;\s*\}/,
    'the guard includes !App.currentApp');
  assert.ok(body.indexOf('!App.currentApp') < body.indexOf('PlatformUI.transition('),
    'the guard runs before the transition, so a replay never starts one');
});

test('#5454: entering an app exits the screen, like Leaderboard, Profile, Admin and Settings', () => {
  const app = read('public/js/app.js');
  // App.setChromeless(chromeless) runs only in restoreFromHash's
  // #app/<slug> branch. The Workshop deliberately stays open behind an app,
  // so it is the one exit this branch must not gain.
  const at = app.indexOf('App.setChromeless(chromeless);');
  assert.ok(at > 0, 'the #app/<slug> branch sets chromeless');
  const exits = app.slice(Math.max(0, at - 700), at + 'App.setChromeless(chromeless);'.length);
  assert.match(exits, /if \(App\._inSettings\) App\._exitSettings\(\);\s*if \(App\._inProfileProposals\) App\._exitProfileProposals\(\);\s*App\.setChromeless\(chromeless\);/,
    'the #app/<slug> branch exits the screen before App.setChromeless(chromeless)');
});

// ── #5453: a late correction re-reads the screen in place ─────────────

test('#5453: the late-arrival correction re-reads the Your work screen', () => {
  const app = read('public/js/app.js');
  const start = app.indexOf('  refreshActiveScreen() {');
  assert.ok(start >= 0, 'App.refreshActiveScreen is defined');
  const body = app.slice(start, app.indexOf('\n  },', start));
  assert.match(body, /UsernodeReact\?\.profileProposals/,
    'the correction names the Your work controller');
  assert.match(body, /visible\('profile-proposals-screen'\)/,
    'only while the screen is the one showing');
  assert.match(body, /work\?\.isOpen\?\.\(\)/,
    'and while the controller is open, the flag reload() itself checks');
  assert.match(body, /work\.reload\?\.\(\); return; \}/,
    'through its own reload, with no app view to fall through to');
  const workAt = body.indexOf('UsernodeReact?.profileProposals');
  const workshopAt = body.indexOf('UsernodeReact?.workshop');
  assert.ok(workAt >= 0 && workshopAt > workAt,
    'the branch sits before the Workshop branch, so a Workshop store still marked open cannot take the correction while Your work is the visible screen');
});

// ── The layout (#3498) ─────────────────────────────────────────────────
//
// "Your requests + your votes sections are misformatted (gray, behind
// sidebar) on desktop." The screen arrived after app.css's per-screen route
// lists and was on none of them, so the body kept its gray `bg-zinc-100`
// instead of the wallpaper, the bar kept its zinc-200 surface, and the page
// was not moved over for the desktop rail: its column centred in the whole
// window and, from a laptop width down, began under the rail. The column
// also passed its lists `mx-0` (Profile's arrangement) without Profile's
// `px-4` gutter, so the cards ran edge to edge on a phone.

const CSS = read('public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');

// Every selector in app.css, comments stripped, as written before its `{`.
const SELECTORS = (CSS.match(/[^{}]+(?=\{)/g) || []).map((s) => s.trim());

test('#3498: every wallpaper and bar rule that names Workshop names Your work too', () => {
  // The rules keyed on a visible screen root: `body:has(:is(<roots>):not(.hidden))`.
  const routeRules = SELECTORS.filter((sel) => /body:has\(:is\([^)]*#workshop-screen[^)]*\):not\(\.hidden\)\)/.test(sel));
  // The light and dark ground, their 640px layer sets and the launch cover
  // (5); the cleared bar, its glass, its clip and its faked layer, the
  // opaque ground under that glass in an iOS browser tab, and (run seven)
  // that bar sticky at the top there, the document not scrolling (6).
  assert.equal(routeRules.length, 11, 'the eleven route rules that name #workshop-screen are found');
  for (const sel of routeRules) {
    assert.ok(sel.includes('#profile-proposals-screen'),
      `${sel.replace(/\s+/g, ' ').slice(0, 90)}… also names #profile-proposals-screen`);
  }
  const ground = routeRules.filter((sel) => !sel.includes('#platform-header'));
  assert.equal(ground.length, 5, 'so the page paints the wallpaper, not the gray body');
  const bar = routeRules.filter((sel) => sel.includes('#platform-header'));
  assert.equal(bar.length, 6, 'and the bar wears the same glass as on Workshop');
});

test('#3498: on a desktop the screen moves over for the rail like its siblings', () => {
  const desktop = CSS.slice(CSS.indexOf('--platform-rail-w: var(--platform-rail-full);'));
  const at = desktop.indexOf(':is(#home-screen, #workshop-screen');
  assert.ok(at > 0, 'the rail\'s list of screens that move over is found');
  const rule = desktop.slice(at, desktop.indexOf('}', at));
  const roots = rule.slice(0, rule.indexOf('{'));
  assert.match(roots, /#profile-proposals-screen/, 'Your changes, requests and votes clear the rail');
  assert.match(rule, /padding-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
});

test('#3498: the column is Profile\'s, gutter and all, so its mx-0 lists keep a margin', () => {
  const profileRoot = read('frontend/src/features/profile/index.tsx')
    .match(/<div id="profile-root" className="([^"]+)">/);
  assert.ok(profileRoot, 'Profile\'s column is found');
  assert.match(profileRoot[1], /\bpx-4\b/, 'Profile\'s column carries the gutter its mx-0 lists rely on');
  const mod = loadTsx(SCREEN);
  const html = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  const column = html.match(/^<main id="profile-proposals-screen"[^>]*><div class="([^"]+)">/);
  assert.ok(column, 'the screen\'s column is found');
  // Class for class, minus the two-column widening the own profile adds at
  // lg — the Your work screen keeps the base column everywhere.
  const baseColumn = profileRoot[1].replace(/\s*\blg:max-w-5xl\b/g, '').trim();
  assert.equal(column[1], baseColumn, 'the same column as #profile-root, class for class');
  assert.match(read(SCREEN), /<GroupedList className="mx-0" tone="plane">/,
    'the lists still pass mx-0, which is why the column owns the gutter');
});
