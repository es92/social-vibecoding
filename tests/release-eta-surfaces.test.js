// Every surface that shows a change "going live" says when, for a merge of
// the platform's own app waiting for its next release, and keeps its own
// words for everything else (#4309 follow-up).
//
// The words are frontend/src/lib/release-eta.ts (tests/release-eta.test.js);
// the server sets `release` only on a change that is merged, not live, and on
// the self-hosted app (services/release-watch.js releasesFor). So each surface
// is pinned three ways here: a Homeroom merge with a `release` says the
// sentence; a child app's merge going live (no `release`, or a child's
// deploy states) and a change still being merged (`merging`, before GitHub
// merged it) say what they always said.
//
// Run with: node --test tests/release-eta-surfaces.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const words = loadTsx('frontend/src/lib/release-eta.ts');

const MIN = 60 * 1000;
// Twenty seconds over, so a test that takes a moment still rounds to 8.
const inEight = () => ({ state: 'next', etaAt: new Date(Date.now() + 8 * MIN + 20 * 1000).toISOString() });
const SENTENCE = 'Merged; goes live in the next release (about 8 minutes)';

// ── The board and the change page (public/js/app-view.js) ───────────────

function appView() {
  const c = { console, App: { user: { id: 42, username: 'Builder' }, currentApp: 'usernode-2d5619', currentTab: 'dev', _appUrl: () => '#' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    // What main.tsx publishes for the classic scripts.
    ReleaseEta: words };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) vm.runInContext(read(p), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'usernode-2d5619', can_collaborate: true };
  c.av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  c.av._ghIssues = [];
  return c.av;
}

const MERGED = {
  id: 4600, user_id: 7, username: 'maya', status: 'merged', source: 'native', pr_number: 4600,
  pr_title: 'Say when changes reach everyone', pr_summary_md: 'Going live says when.', linked_issues: [],
  yes_count: 2, no_count: 0, votes_required: 2, created_at: '2026-10-09T17:00:00Z', merged_at: '2026-10-09T17:59:00Z',
  check_state: 'passing', test_results: [],
};

test('the board card\'s pill keeps "Going live…" and its title says when, for a Homeroom merge only', () => {
  const av = appView();
  const release = inEight();
  const homeroom = av.statusPillState({ ...MERGED, deployment_state: 'deploying', live_at: null, release });
  assert.equal(homeroom.label, 'Going live…');
  assert.equal(homeroom.title, `${SENTENCE}.`);
  // The by-id read has no deploy state, only live_at: the same words.
  assert.equal(av.statusPillState({ ...MERGED, live_at: null, release }).title, `${SENTENCE}.`);
  // A child app's deploy going live: its own words.
  const child = av.statusPillState({ ...MERGED, deployment_kind: 'child', deployment_state: 'pending' });
  assert.equal(child.label, 'Going live…');
  assert.equal(child.title, 'This change was approved. The app is still running the version before it.');
  // Homeroom going live with no estimate read (an older server): as before.
  assert.equal(av.statusPillState({ ...MERGED, deployment_state: 'deploying', live_at: null }).title,
    'This change was approved. The app is still running the version before it.');
  // Still being merged: a different wait, its own words.
  const merging = av.statusPillState({ ...MERGED, status: 'merging' });
  assert.equal(merging.label, 'Going live…');
  assert.equal(merging.title, 'This change was approved and is going into the app now.');
});

test('the Done column counts them in the same words; a child app\'s summary is unchanged', () => {
  const av = appView();
  av._mergedCtx = { deployment: { state: 'deploying', runningSha: 'a'.repeat(40), pendingCount: 2, release: inEight() } };
  assert.deepEqual(JSON.parse(JSON.stringify(av._doneDeploymentStatus())), {
    tone: 'progress', text: '2 merged changes go live in the next release (about 8 minutes)',
    title: 'Merged changes go live together, in the platform’s next release. Production is still running an earlier revision.',
  });
  av._mergedCtx = { deployment: { state: 'deploying', runningSha: 'a'.repeat(40), pendingCount: 2 } };
  assert.equal(av._doneDeploymentStatus().text, '2 merged changes waiting to go live');
  av._mergedCtx = { deployment: { kind: 'child', state: 'pending', runningSha: null, pendingCount: null } };
  assert.equal(av._doneDeploymentStatus().text, 'Latest merged change · awaiting deployment');
});

test('a Workshop row\'s "Going live…" tag says when on hover', () => {
  const av = appView();
  const brief = av._workshopBrief('merged', { ...MERGED, deployment_state: 'deploying', live_at: null, release: inEight() }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(brief.tags)), [{ label: 'Going live…', tone: 'run', title: `${SENTENCE}.` }]);
  const child = av._workshopBrief('merged', { ...MERGED, deployment_kind: 'child', deployment_state: 'pending' }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(child.tags)), [{ label: 'Going live…', tone: 'plain' }]);
});

test('the change page says it where anyone reads it: the Votes card\'s line, outside Details', () => {
  const av = appView();
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const draw = (item) => {
    const v = av._topicViewFor('proposal', item);
    return { v, page: renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item })) };
  };
  const homeroom = { ...MERGED, deployment_state: 'deploying', live_at: null, release: inEight() };
  const { v, page } = draw(homeroom);
  assert.match(page, new RegExp(`data-change-gate="votes"[\\s\\S]*?<p class="dev-change-gate-note" data-change-release="">${SENTENCE.replace(/[()]/g, '\\$&')}\\.</p>`));
  assert.doesNotMatch(page, /It’s going live\./, 'said once, in the new words');
  assert.doesNotMatch(page, /<details[^>]*>[^]*Merged; goes live/, 'not folded away');
  // The hero's eyebrow keeps its short "Going live"; the steps say when too.
  assert.equal(v.body.hero.status, 'Going live');
  assert.equal(v.body.steps.headline, 'Going live');
  assert.equal(v.body.steps.detail, `${SENTENCE}.`);

  // A child app's merge going live: "It's going live.", no release line.
  const child = draw({ ...MERGED, deployment_kind: 'child', deployment_state: 'pending' });
  assert.match(child.page, /<p class="dev-change-gate-note">It’s going live\.<\/p>/);
  assert.doesNotMatch(child.page, /data-change-release|next release/);
  // Still being merged: the same.
  const merging = draw({ ...MERGED, status: 'merging' });
  assert.match(merging.page, /It’s going live\./);
  assert.doesNotMatch(merging.page, /next release/);
});

// ── Agent sessions: the pill, the drawer, the inbox row, the menu ───────

const HOMEROOM_CHANGE = {
  id: 50, appSlug: 'usernode-2d5619', appName: 'Homeroom', status: 'merging', title: 'Say when it goes live',
  prNumber: 4600, appSelfHosted: true,
};

test('an agent session\'s change: the drawer says when, the rows say it short', () => {
  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  const now = Date.now();
  const release = inEight();
  assert.equal(transcript.changeReleaseLine({ ...HOMEROOM_CHANGE, release }, now), `${SENTENCE}.`);
  assert.equal(transcript.changeReleaseLine(HOMEROOM_CHANGE, now), null, 'no release read: nothing extra');
  assert.equal(transcript.changeReleaseLine({ ...HOMEROOM_CHANGE, status: 'merged', release }, now), null, 'live');
  // The pill's label stays the state's word.
  assert.equal(transcript.changeStatusLabel('merging'), 'Going live');
  // A list row's words after the change's name.
  assert.equal(transcript.changeRowWords({ ...HOMEROOM_CHANGE, release }, now), 'Goes live in about 8 minutes');
  assert.equal(transcript.changeRowWords(HOMEROOM_CHANGE, now), 'Going live');
  assert.equal(transcript.changeRowWords({ status: 'promoted' }, now), 'Waiting for approval');
  assert.equal(transcript.changeRowWords({ status: 'merged' }, now), 'Live');
  assert.equal(transcript.changeRowWords({ status: 'active' }, now), 'In progress');

  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const session = (activeChange) => ({
    id: 7, title: 'Say when', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange, changes: [], lastActivityAt: null, createdAt: null,
  });
  const drawer = renderToHtml(createElement(api.ChangesDrawer, { session: session({ ...HOMEROOM_CHANGE, release }) }));
  assert.match(drawer, new RegExp(`title="${SENTENCE.replace(/[()]/g, '\\$&')}\\.">Going live</span>`));
  assert.match(drawer, new RegExp(`<p [^>]*data-agent-session-release="true">${SENTENCE.replace(/[()]/g, '\\$&')}\\.</p>`));
  const child = renderToHtml(createElement(api.ChangesDrawer, {
    session: session({ ...HOMEROOM_CHANGE, appSlug: 'notes', appName: 'Notes', appSelfHosted: false }),
  }));
  assert.match(child, />Going live<\/span>/);
  assert.doesNotMatch(child, /data-agent-session-release|next release/);

  // Messages' agent rows and the Homeroom menu's Agent chats read the same words.
  const messages = read('frontend/src/features/messages/index.tsx');
  const row = messages.slice(messages.indexOf('function MayorSessionRow('), messages.indexOf('function AgentChatThread('));
  assert.match(row, /\$\{changeRowWords\(change\)\}/);
  const model = loadTsx('frontend/src/features/app-context/continue-model.ts');
  const listed = (activeChange) => ({
    id: 7, title: 'Say when', status: 'open', lastActivityAt: new Date(now).toISOString(), focusApp: null, activeChange,
  });
  assert.equal(model.continueRows([listed({ ...HOMEROOM_CHANGE, release })], 5, now).rows[0].sub,
    'Homeroom · goes live in about 8 minutes');
  assert.equal(model.continueRows([listed(HOMEROOM_CHANGE)], 5, now).rows[0].sub, 'Homeroom · going live');
});

// ── The Homeroom bot's DM: the ready card, the activity card, the tray ──

const NOW = new Date('2026-10-09T18:00:00Z');
const release8 = { state: 'next', etaAt: new Date(NOW.getTime() + 8 * MIN).toISOString() };

test('the ready card: a Homeroom merge says when; any other says it is going live now', () => {
  const { readyLine, ReadyCardView } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  assert.equal(readyLine('going_live', null, NOW, undefined, release8), `${SENTENCE}.`);
  assert.equal(readyLine('going_live', null, NOW), 'It’s approved and going live now.');
  assert.equal(readyLine('going_live', null, NOW, undefined, { state: 'waiting', etaAt: null }), 'Merged; waiting for a release.');
  const meta = {
    kind: 'proposal', appName: 'Homeroom', appSlug: 'usernode-2d5619', ready: { group: false, last: true, waitingOn: [], more: 0 },
    actions: [], status: 'open', sessionId: 50, epoch: 1,
  };
  const html = renderToHtml(createElement(ReadyCardView, {
    meta, state: 'going_live', actions: [], now: NOW, fresh: { messageId: 1, state: 'going_live', actions: [], release: release8 },
  }));
  assert.match(html, new RegExp(`<p class="messages-bot-answered" role="status">${SENTENCE.replace(/[()]/g, '\\$&')}\\.</p>`));
  const child = renderToHtml(createElement(ReadyCardView, {
    meta, state: 'going_live', actions: [], now: NOW, fresh: { messageId: 1, state: 'going_live', actions: [] },
  }));
  assert.match(child, /role="status">It’s approved and going live now\.<\/p>/);
});

test('the activity card: "Built it." and then when', () => {
  const { BotActivityCardView, outcomeLabel } = loadTsx('frontend/src/features/messages/bot-activity.tsx');
  assert.equal(outcomeLabel({ outcome: 'going_live', release: release8 }, NOW.getTime()), `Built it. ${SENTENCE}`);
  assert.equal(outcomeLabel({ outcome: 'going_live' }, NOW.getTime()), 'Built it. Going live now');
  assert.equal(outcomeLabel({ outcome: 'live', release: release8 }, NOW.getTime()), 'Built it. It’s live', 'only going live');
  const META = { kind: 'activity', appSlug: 'usernode-2d5619', appName: 'Homeroom', issueNumber: 12, issueTitle: 'Say when', mirrors: true };
  const card = {
    messageId: 31, state: 'done', startedAt: new Date(NOW.getTime() - 40 * MIN).toISOString(), links: { request: null, proposal: null },
    step: null, of: null, stepName: null, doing: null, outcome: 'going_live', endedAt: new Date(NOW.getTime() - 10 * MIN).toISOString(),
  };
  const html = renderToHtml(createElement(BotActivityCardView, { meta: META, loaded: true, now: NOW, card: { ...card, release: release8 } }));
  assert.match(html, new RegExp(`<span role="status">Built it\\. ${SENTENCE.replace(/[()]/g, '\\$&')}</span>`));
  const child = renderToHtml(createElement(BotActivityCardView, { meta: META, loaded: true, now: NOW, card }));
  assert.match(child, /<span role="status">Built it\. Going live now<\/span>/);
});

test('the tray: Now, History and the status line say when for a Homeroom merge', () => {
  const { trayStatus, BotWorkPanelView } = loadTsx('frontend/src/features/messages/bot-work.tsx');
  const job = (extra) => ({
    key: 'usernode-2d5619#12', appSlug: 'usernode-2d5619', appName: 'Homeroom', iconUrl: null, iconEmoji: null,
    issueNumber: 12, title: 'Say when', firstVersion: false, href: null, links: { request: null, proposal: null, project: null }, earlier: [], ...extra,
  });
  const merging = job({ phase: 'merging', step: null, of: null, stepName: null, doing: null, since: null });
  const work = (extra) => ({ now: [], needsYou: [], history: [], ...extra });
  assert.equal(trayStatus(work({ now: [{ ...merging, release: release8 }] }), NOW).long, 'Working on Homeroom #12 · goes live in about 8 minutes');
  assert.equal(trayStatus(work({ now: [merging] }), NOW).long, 'Working on Homeroom #12 · going live');
  const went = job({ id: 3, outcome: 'going_live', doing: null, at: new Date(NOW.getTime() - 2 * MIN).toISOString() });
  assert.match(trayStatus(work({ history: [{ ...went, release: release8 }] }), NOW).long, /^Last: Homeroom #12 goes live in about 8 minutes · /);
  assert.match(trayStatus(work({ history: [went] }), NOW).long, /^Last: Homeroom #12 going live · /);

  const panel = renderToHtml(createElement(BotWorkPanelView, {
    now: NOW, work: work({ now: [{ ...merging, release: release8 }], history: [{ ...went, release: release8 }] }), historyOpen: true,
  }));
  assert.ok(panel.includes(SENTENCE), 'Now says the sentence');
  assert.ok(panel.includes(`Built it. ${SENTENCE}`), 'History says it as the card does');
  const plain = renderToHtml(createElement(BotWorkPanelView, { now: NOW, work: work({ now: [merging], history: [went] }), historyOpen: true }));
  assert.ok(!plain.includes('next release'));
  assert.ok(plain.includes('Making the approved change live'));
});

test('the bot\'s reads keep `release` only where it belongs', () => {
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const done = (outcome, extra = {}) => ({ messageId: 9, state: 'done', outcome, endedAt: null, links: {}, ...extra });
  const [going, live, junk] = api.normalizeBotActivity({ cards: [
    done('going_live', { release: release8 }), done('live', { release: release8 }), done('going_live', { release: { state: 'soon' } }),
  ] });
  assert.deepEqual(going.release, release8);
  assert.equal(live.release, undefined, 'only a card going live');
  assert.equal(junk.release, undefined, 'only a release block');
  const [ready, open] = api.normalizeBotReadyNow({ ready: [
    { messageId: 1, state: 'going_live', release: release8 }, { messageId: 2, state: 'open', release: release8 },
  ] });
  assert.deepEqual(ready.release, release8);
  assert.equal(open.release, undefined);
  const w = api.normalizeBotWork({
    now: [{ key: 'a#1', appSlug: 'a', phase: 'merging', release: release8 }, { key: 'b#1', appSlug: 'b', phase: 'building', release: release8 }],
    history: [{ key: 'c#1', appSlug: 'c', id: 3, outcome: 'going_live', release: release8 }],
  });
  assert.deepEqual(w.now[0].release, release8);
  assert.equal(w.now[1].release, undefined);
  assert.deepEqual(w.history[0].release, release8);
});

// ── A project's chat: the requester's card ──────────────────────────────

test('the request card in a project\'s chat: approved and merged into Homeroom says when', () => {
  const { cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const now = NOW.getTime();
  const filed = { messageId: 5, kind: 'filed', title: 'Dark mode', issueNumber: 12 };
  assert.equal(cardWords({ ...filed, state: { stage: 'approved', sessionId: 50, release: release8 } }, now), `Approved: Dark mode. ${SENTENCE}.`);
  assert.equal(cardWords({ ...filed, state: { stage: 'approved', sessionId: 50 } }, now), 'Approved: Dark mode. It’s going live.');
  const revise = { messageId: 6, kind: 'revise', title: 'Dark mode', issueNumber: 12, sessionId: 50 };
  assert.equal(cardWords({ ...revise, state: { stage: 'approved', release: release8 } }, now), `“Dark mode” was approved. ${SENTENCE}.`);
  assert.equal(cardWords({ ...revise, state: { stage: 'approved' } }, now), '“Dark mode” was approved. It’s going live.');
});

// ── The leaderboard's badge ─────────────────────────────────────────────

test('the leaderboard\'s "going live" badge says when on hover, for a Homeroom merge only', () => {
  const ctx = { console, document: { getElementById: () => null }, location: { hash: '' }, ReleaseEta: words };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${read('frontend/src/features/leaderboard/leaderboard.js').replace(/^export .*$/gm, '')}\n;globalThis.__lb = Leaderboard;`, ctx);
  const lb = ctx.__lb;
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(lb._statusBadge('merging', inEight())), { tone: 'amber', label: 'going live', title: `${SENTENCE}.` });
  assert.deepEqual(plain(lb._statusBadge('merging')), { tone: 'amber', label: 'going live' });
  assert.deepEqual(plain(lb._statusBadge('merged', inEight())), { tone: 'emerald', label: 'live' });
  const [row] = lb.profilePrRowViews([{ app_slug: 'usernode-2d5619', session_id: 1, status: 'merging', release: inEight(), created_at: null }]);
  assert.equal(row.badge.title, `${SENTENCE}.`);
  assert.match(read('frontend/src/features/leaderboard/kudos-pane.tsx'), /title=\{badge\.title\}>\{badge\.label\}<\/span>/);
});

// ── What is left as it was, on purpose ─────────────────────────────────

test('a child app\'s first version keeps its "Going live" step; the creation dialog is not a platform release', () => {
  assert.match(read('frontend/src/features/dialogs/creation-progress-store.js'), /\{ key: 'deploy', label: 'Going live' \}/);
});
