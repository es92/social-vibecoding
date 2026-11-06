'use strict';

/**
 * Polish board batch A (19 Oct 2026): screens open at their final shape.
 *
 * Each block pins one finding's fix: the hub's own skeleton and the reads
 * that stopped answering it with last visit's numbers (#3), Discover's icon
 * placeholders (#11), the request page's one draw (#12), the Workshop's rule
 * line and bot line (#13), the change page's plan card (#14), the channels
 * and the Communities list (#19), the Workshop overview (#24), and Recently
 * live's fallback tile (N13).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── #3: the hub ─────────────────────────────────────────────────────────

test('#3: the hub loads in its own shape, under the page\'s bar', () => {
  const { HubSkeleton } = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const html = renderToHtml(createElement(HubSkeleton, { others: true }));
  assert.match(html, /role="status">Loading the workshop</);
  assert.match(html, /class="dev-ws-hero dev-ws-hero-summary animate-pulse"/, 'the hero\'s own box');
  assert.match(html, /class="dev-ws-hero-active"/, 'who is around, when others are in it');
  assert.equal((html.match(/class="dev-ws-foryou-row /g) || []).length, 3, 'For you\'s three doors');
  assert.equal((html.match(/class="dev-ws-recent-item"/g) || []).length, 3, 'Recently live\'s three pictures');
  const alone = renderToHtml(createElement(HubSkeleton, { others: false }));
  assert.doesNotMatch(alone, /dev-ws-hero-active/, 'a project nobody else is in has no one to name');
});

test('#3: the hub\'s counts are not answered from last visit\'s copy', () => {
  const { isBootReadRequest } = require('../public/sw.js');
  const O = 'https://example.test';
  for (const p of ['promoted', 'merged']) {
    assert.equal(isBootReadRequest(`${O}/api/apps/usernode-2d5619/${p}?results=failing`, O), false, p);
  }
  // The rest of the board's first paint keeps the lane.
  assert.equal(isBootReadRequest(`${O}/api/apps/usernode-2d5619/github-issues`, O), true);
});

test('#3: a hub opened from Communities still gets the late correction', () => {
  const app = read('public/js/app.js');
  const refresh = app.slice(app.indexOf('  refreshActiveScreen() {'));
  assert.match(refresh.slice(0, 6000),
    /if \(workshop\?\.isOpen\?\.\(\) && !App\.currentApp\) \{ workshop\.refreshNeeds\?\.\(\); return; \}/,
    'only the Communities screen itself returns there; a project page falls through to its own loader');
});

// ── #11: Discover's icons ───────────────────────────────────────────────

test('#11: an image icon shows the app\'s initial until the picture has drawn', () => {
  const { AppIconContent } = loadTsx('frontend/src/features/apps/app-card-view.tsx');
  const html = renderToHtml(createElement(AppIconContent, { app: { name: 'maps', icon_url: '/app-icons/7' } }));
  assert.match(html, /<span class="app-icon-wait" aria-hidden="true">M<\/span><img src="\/app-icons\/7" alt="" loading="lazy"/);
  const eager = renderToHtml(createElement(AppIconContent, { app: { name: 'maps', icon_url: '/app-icons/7' }, eager: true }));
  assert.match(eager, /loading="eager"/);
  const css = read('public/css/app.css');
  assert.match(css, /:where\(:has\(> \.app-icon-wait\)\) \{ position: relative; \}/);
  assert.match(css, /\.app-icon-wait \{\s*position: absolute; inset: 0;/);
  // One Home (#6361): Discover's list is Home's Communities to join now.
  const list = read('frontend/src/features/home/communities-to-join.tsx');
  assert.match(list, /eager=\{i < 4\}/, 'the first cards ask at once');
});

// ── #12: the request page ───────────────────────────────────────────────

test('#12: the track card\'s pictures hold their frames while they are read', () => {
  const { TrackPictures } = loadTsx('frontend/src/features/messages/bot-track.tsx');
  const html = renderToHtml(createElement(TrackPictures, {
    track: { appSlug: 'demo', proposalId: 12, sessionId: 34, state: 'checks' },
  }));
  assert.match(html, /data-bot-track-pictures="pending"/);
  assert.equal((html.match(/aspect-ratio:4 \/ 3/g) || []).length, 2, 'two frames, the size the pictures are drawn at');
  const none = renderToHtml(createElement(TrackPictures, { track: { appSlug: 'demo', state: 'queued' } }));
  assert.equal(none, '', 'nothing to read, nothing held');
});

test('#12: a request page drawn from the board\'s older row holds its track card unseen', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /trackPending: !!issue\.track && AppView\._devTopic\?\.kind === 'issue'/);
  const open = view.slice(view.indexOf('    const topic = AppView._devTopic;\n    if (topic) topic.rowFresh = false;'));
  assert.ok(open.length > 0, 'openTopic marks a paint from the lists');
  assert.match(open.slice(0, 1600), /if \(topic\) topic\.rowFresh = true;\s*AppView\._fetchTopicItem\(ref\)/,
    'a page drawn from its own read is fresh');
  assert.match(open.slice(0, 2400), /const held = !!topic && topic\.rowFresh === false;\s*if \(topic\) topic\.rowFresh = true;/,
    'the board\'s reload frees it, failed or not');
});

// ── #13: the Workshop overview ──────────────────────────────────────────

test('#13: the rule line names its approvers from the community record', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /if \(gov\.approverPolicy === 'invited' && canChat\) \{/, 'only for a reader GET /approvers would answer');
  assert.match(route, /approvers: approverNames,/);
  const card = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  assert.match(card, /const asked = useApprovers\(slug, invited && given === undefined\);/,
    'only an older server\'s record, without the field, asks');
});

test('#13: the bot\'s slot line is asked for with the page, and shared', async () => {
  const slots = read('frontend/src/features/dev-board/workshop/bot-slots.tsx');
  assert.match(slots, /export function warmBotSlots\(slug: string \| null \| undefined\): void/);
  assert.match(slots, /const \[state, setState\] = useState<SlotsState>\(\(\) => seenSlots\(slug\)\);/,
    'the last answer is what the line first draws');
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(workshop, /useEffect\(\(\) => \{ warmBotSlots\(v\.slug\); \}, \[v\.slug\]\);/);
});

// ── #14: the change page's plan card ────────────────────────────────────

test('#14: the board\'s change rows carry the plan their page names', async () => {
  const { attachChangePlans } = require('../src/routes/sessions');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ session_id: 5, version: 2, built_at: '2026-10-19T10:00:00Z' }] };
    },
  };
  const rows = [{ id: 5 }, { id: 6, row_type: 'pr' }, { id: 7, row_type: 'close_issue' }];
  await attachChangePlans(pool, rows, 42);
  assert.equal(calls.length, 1, 'one read for the whole list');
  assert.deepEqual(calls[0].params, [[5, 6], 42], 'pull requests only, for this viewer');
  assert.match(calls[0].sql, /SELECT DISTINCT ON \(s\.session_id\)/);
  assert.match(calls[0].sql, /owner_session\.user_id = \$2::int OR/);
  assert.deepEqual(rows[0].plan, { version: 2, at: '2026-10-19T10:00:00Z' });
  assert.equal(rows[1].plan, null, 'a change with no readable plan says so');
  assert.equal('plan' in rows[2], false);

  const failing = { async query() { throw new Error('boom'); } };
  const kept = [{ id: 9 }];
  await attachChangePlans(failing, kept, 1);
  assert.equal('plan' in kept[0], false, 'a failed read leaves the rows as they were');

  const votes = read('src/routes/votes.js');
  assert.equal((votes.match(/await require\('\.\/sessions'\)\.attachChangePlans\(pool, rows, userId\);/g) || []).length, 2,
    '/promoted and /merged both');
});

// ── #19: channels and the Communities list ──────────────────────────────

test('#19: a channel loads in one state, the room\'s own', () => {
  const { ChannelLoading } = loadTsx('frontend/src/features/messages/index.tsx');
  const html = renderToHtml(createElement(ChannelLoading));
  assert.match(html, /<div class="messages-thread-scroll" data-channel-loading=""><div class="messages-state"><span class="messages-spinner"><\/span>/);
  assert.ok(html.includes(message('messages:thread.loading')));
  const discussion = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.equal((discussion.match(/if \(!data\) return <ChannelLoading \/>;/g) || []).length, 2, 'the channel and a topic\'s');
  const frame = read('frontend/src/features/dev-board/board-frame.tsx');
  assert.match(frame, /: opensOnOwnShape\(\) \? DEV_BODY_PLACE_INITIAL : DEV_BODY_WORKSHOP_INITIAL;/,
    'no card list in front of a place that draws its own loading shape');
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(workshop, /if \(pending && \(!v\.slug \|\| \(tab !== 'status' && !channelHere\)\)\) \{/,
    'a channel waits for neither the board nor the record');
});

test('#19: a room\'s picture holds its box until it has drawn', () => {
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(transcript, /data-pending=\{drawn \? undefined : ''\}/);
  assert.match(read('public/css/app.css'), /\.dc-msg-att-img\[data-pending\] \{ width: 160px; height: 120px; \}/);
});

// ── #24 and N13 ─────────────────────────────────────────────────────────

test('#24: the votes figure is square like its neighbours, and a long step gives way with an ellipsis', () => {
  const css = read('public/css/app.css');
  const button = css.slice(css.indexOf('button.dev-ws-dash-cell {'), css.indexOf('button.dev-ws-dash-cell:hover'));
  assert.match(button, /border-radius: 0;/);
  assert.doesNotMatch(button, /border-radius: 10px/);
  assert.match(css, /\.dev-ws-hrow-meta > \.dev-ws-hrow-tag:not\(:has\(> svg\)\) \{\s*flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
});

test('N13: a change with no picture shows the project\'s tile on its colour', () => {
  const { RecentlyLive } = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const html = renderToHtml(createElement(RecentlyLive, {
    slug: 'maps',
    rows: [{ key: 'p1', sessionId: 1, prNumber: 9, title: 'Faster tiles', picture: null, who: 'evan', at: null, going: false }],
    onAll: () => {},
    ident: { name: 'Maps', iconUrl: null, iconEmoji: '🗺️' },
  }));
  assert.match(html, /data-ws-recent-pic="plain" aria-hidden="true"><span class="app-icon-tile dev-ws-recent-app" data-icon="emoji">/);
  assert.doesNotMatch(html, /dev-ws-recent-glyph/, 'no grey box with a check');
  assert.match(read('public/css/app.css'),
    /\.dev-ws-recent-pic:is\(\[data-ws-recent-pic="plain"\], \[data-ws-recent-pic="app"\]\) \{\s*background: var\(--community-tint, var\(--bg-tertiary\)\);/);
});
