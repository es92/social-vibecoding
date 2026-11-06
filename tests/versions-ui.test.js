'use strict';

// Versions, the screens (docs/plans/versions.md, section "UI").
//
// Every copy of a project is a version of one original. What is pinned here
// is what people see of that, drawn from the API shapes the contract names
// (any field may be missing or null, and then nothing is drawn):
//
//   - the hub hero's line: "Made from Tier list · Gets its updates" on a
//     version, "214 versions · 160 get its updates" on an original
//     (community-card.tsx HeroLineage), and Discover's versions line
//     (browse.js versionsLineFor);
//   - the hub's Update card on a version (which card, and when none) and
//     From its versions on an original (hub-cards.tsx);
//   - an update's change page: the From <original> card's lines, and its
//     Not for your version? row (change-head.tsx);
//   - the shared reads' defensive parsing (features/versions/upstream.ts);
//   - Admin › Limits › Versions (admin-limits.tsx VersionsCard);
//   - the hub shots that draw a version's and an original's hub.
//
// Run with: node --test tests/versions-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/change-head.tsx';
const UPSTREAM = 'frontend/src/features/versions/upstream.ts';

const NEVER = /remix|fork|upstream|template|\bsync\b|\bmerge\b|\boffer/i;

const community = (over = {}) => ({
  slug: 'book-club-picks',
  name: 'Book club picks',
  member_count: 4,
  is_member: true,
  is_creator: true,
  audience: 'invited',
  audience_label: 'Private community',
  members: [{ id: 1, username: 'maya' }],
  channel: null,
  approval: { policy: 'anyone', approvals_required: null, electorate: 4, required: 2 },
  ...over,
});

// ── The hero ────────────────────────────────────────────────────────────

test('the hero says what a version was made from, and how many versions an original has', () => {
  const { HeroLineage } = loadTsx(CARD);
  const draw = (data) => renderToHtml(createElement(HeroLineage, { data: community(data) }));

  const gets = draw({ made_from: { slug: 'tier-list', name: 'Tier list', following: true } });
  assert.match(gets, /class="dev-ws-hero-lineage" data-ws-made-from="tier-list"/);
  assert.match(gets, /<a class="dev-ws-hero-lineage-link" href="#app\/tier-list">Tier list<\/a>/, 'the original\'s name opens it');
  assert.equal(text(gets), 'Made from Tier list · Gets its updates');
  const not = draw({ made_from: { slug: 'tier-list', name: 'Tier list', following: false } });
  assert.equal(text(not), 'Made from Tier list · Doesn’t get its updates');

  assert.equal(text(draw({ versions: { count: 214, following: 160 } })), '214 versions · 160 get its updates');
  assert.equal(text(draw({ versions: { count: 214, following: 1 } })), '214 versions · 1 gets its updates');
  assert.equal(text(draw({ versions: { count: 1, following: 1 } })), '1 version · it gets its updates');
  assert.equal(text(draw({ versions: { count: 3, following: 0 } })), '3 versions', 'a zero says nothing');
  assert.equal(text(draw({ versions: { count: 1, following: 0 } })), '1 version');
  assert.equal(draw({ versions: { count: 0, following: 0 } }), '', 'no line before the first version');
  assert.equal(draw({}), '', 'nothing on a project that is neither, or from a server that sends neither');
  assert.equal(draw({ made_from: null, versions: null }), '');

  const src = read(CARD);
  assert.match(src, /<\/span>\s*<HeroLineage data=\{data\} \/>\s*<\/span>\s*<\/div>/, 'under who it is for, inside the name\'s column');
  assert.doesNotMatch(gets + not, NEVER);
});

// ── The hub's cards ─────────────────────────────────────────────────────

const up = (over = {}) => ({
  enabled: true,
  original: { slug: 'tier-list', name: 'Tier list', emoji: '🏆', iconUrl: null },
  following: true,
  share: false,
  canManage: true,
  private: true,
  behind: false,
  offer: null,
  ...over,
});
const offer = (over = {}) => ({
  state: 'available', sessionId: null, href: null, fromSha: 'abc1234', brings: [], facts: null, keeps: null, conflicts: [], ...over,
});

test('a version\'s hub shows the Update card for an update not yet looked at, a clash, or once when it does not get updates', () => {
  const { updateCardOf, bringsLine } = loadTsx(HUB);
  assert.deepEqual(updateCardOf(up({ offer: offer() })), { kind: 'available', key: 'update:abc1234' });
  assert.deepEqual(updateCardOf(up({ offer: offer({ state: 'needs_fit' }) })), { kind: 'fit', key: 'update:abc1234' });
  assert.equal(updateCardOf(up({ offer: offer({ state: 'open' }) })), null, 'an update up for a vote is Needs you\'s');
  assert.deepEqual(updateCardOf(up({ following: false, behind: true })), { kind: 'behind', key: 'update:behind' });
  assert.equal(updateCardOf(up({ following: true, behind: true })), null, 'a version that gets updates waits for its offer row');
  assert.equal(updateCardOf(up({ offer: offer(), enabled: false })), null, 'nothing while versions are switched off');
  assert.equal(updateCardOf(up({ offer: offer(), original: null })), null);
  assert.equal(updateCardOf(null), null);
  for (const state of ['skipped', 'merged', 'failed']) {
    assert.equal(updateCardOf(up({ offer: offer({ state }) })), null, `nothing for ${state}`);
  }

  assert.equal(bringsLine([{ title: 'Comments' }]), 'Comments');
  assert.equal(bringsLine([{ title: 'Comments' }, { title: 'Help' }, { title: 'People' }]), 'Comments, and 2 more');
  assert.equal(bringsLine([]), '');

  assert.equal(message('project:hub.update.titleBehind', { project: 'Tier list' }), 'Tier list has changed since you made this');
  assert.equal(message('project:hub.update.see'), 'See the update');
  assert.equal(message('project:hub.update.notNow'), 'Not now');
});

test('the Update card draws nothing in its first render, and is placed under the hero', () => {
  const { UpdateCard, FromVersionsCard } = loadTsx(HUB);
  // The reads happen in effects, which a static render never runs: the
  // island's first render is empty.
  const version = community({ made_from: { slug: 'tier-list', name: 'Tier list', following: true } });
  assert.equal(renderToHtml(createElement(UpdateCard, { slug: 'book-club-picks', data: version })), '');
  const original = community({ versions: { count: 214, following: 160 } });
  assert.equal(renderToHtml(createElement(FromVersionsCard, { slug: 'tier-list', data: original })), '');

  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const hub = lander.slice(lander.indexOf("{tab === 'status' ? ("), lander.indexOf("{tab === 'plan' ? ("));
  const at = (x) => hub.indexOf(x);
  assert.ok(at('<FirstVersionCard') < at('<UpdateCard') && at('<UpdateCard') < at('<ShareItCard'), 'under the hero and the first version');
  assert.ok(at('<ForYouCard') < at('<FromVersionsCard') && at('<FromVersionsCard') < at('<RecentlyLive'), 'after For you');

  const src = read(HUB);
  assert.match(src, /const wanted = !!\(slug && data && data\.made_from && data\.is_member\);/, 'a version\'s members only');
  assert.match(src, /const wanted = !!\(slug && data && data\.versions && Number\(data\.versions\.count\) > 0\);/, 'an original with versions only');
});

test('From its versions says what came back, leaving out a row with nothing', () => {
  const { suggestionsLine, latelyLine, lastUpdateLine } = loadTsx(HUB);
  const from = { slug: 'book-club-picks', name: 'Book club picks' };
  assert.equal(suggestionsLine({ suggestions: [{ title: 'Rate out of 10', from }] }), 'Rate out of 10, from Book club picks');
  assert.equal(suggestionsLine({ suggestions: [{ title: 'Rate out of 10', from: null }] }), 'Rate out of 10, from a private version');
  assert.equal(suggestionsLine({ suggestions: [{ title: 'A', from }, { title: 'B', from }] }), 'A, and 1 more');
  assert.equal(suggestionsLine({ suggestions: [] }), '');

  assert.equal(latelyLine({ lately: { versions: 2, changes: 1, rows: [{ title: 'Comments', from }] } }), 'Comments, in Book club picks');
  assert.equal(latelyLine({ lately: { versions: 31, changes: 46, rows: [{ title: 'Comments', from }] } }), 'Comments, in Book club picks, and 45 more');
  assert.equal(latelyLine({ lately: { versions: 0, changes: 0, rows: [] } }), '');
  assert.equal(latelyLine({ lately: null }), '');

  assert.equal(lastUpdateLine({ lastUpdate: { offered: 160, took: 98, skipped: 12, deciding: 50 } }), '98 of 160 took it, 12 skipped, 50 deciding');
  assert.equal(lastUpdateLine({ lastUpdate: { offered: 160, took: 98, skipped: 0, deciding: 62 } }), '98 of 160 took it, 62 deciding');
  assert.equal(lastUpdateLine({ lastUpdate: { offered: 160, took: 148, skipped: 12, deciding: 0 } }), '148 of 160 took it, 12 skipped');
  assert.equal(lastUpdateLine({ lastUpdate: { offered: 3, took: 3, skipped: 0, deciding: 0 } }), '3 of 3 took it');
  assert.equal(lastUpdateLine({ lastUpdate: { offered: 0, took: 0, skipped: 0, deciding: 0 } }), '', 'no update yet says nothing');
  assert.equal(lastUpdateLine({ lastUpdate: null }), '');
  assert.equal(message('project:hub.versions.title'), 'From its versions');
});

// ── The reads ───────────────────────────────────────────────────────────

test('the shared reads take the contract\'s shapes and draw nothing from anything else', () => {
  const { readUpstreamBody, readVersionsBody } = loadTsx(UPSTREAM);
  assert.equal(readUpstreamBody(null), null);
  assert.equal(readUpstreamBody('nope'), null);
  const body = readUpstreamBody({
    enabled: true,
    original: { slug: 'tier-list', name: 'Tier list', emoji: '🏆', iconUrl: null },
    following: false, share: true, canManage: true, private: true, behind: true,
    offer: { state: 'needs_fit', sessionId: '42', href: '#app/b/dev/changes/3', fromSha: 'f00', brings: [{ title: 'A' }, {}], facts: { ai: true }, keeps: { count: 4, titles: ['x', 7] }, conflicts: ['api.js', null] },
  });
  assert.equal(body.offer.sessionId, 42);
  assert.deepEqual(body.offer.brings, [{ title: 'A' }]);
  assert.deepEqual(body.offer.keeps, { count: 4, titles: ['x'] });
  assert.deepEqual(body.offer.conflicts, ['api.js']);
  assert.equal(body.behind, true);
  const bare = readUpstreamBody({});
  assert.equal(bare.original, null);
  assert.equal(bare.offer, null);
  assert.equal(bare.enabled, true, 'a server that leaves `enabled` out has not switched it off');

  const v = readVersionsBody({ count: '3', following: 2, suggestions: [{ title: 'S', from: null }, { title: '' }], lately: { versions: 1, changes: 1, rows: [{ title: 'R', from: { slug: 'a', name: 'A' } }] }, lastUpdate: null });
  assert.equal(v.count, 3);
  assert.deepEqual(v.suggestions.map((s) => s.title), ['S']);
  assert.equal(v.lately.rows[0].from.name, 'A');
  assert.equal(v.lastUpdate, null);
});

test('following is a vote: the switch opens follow-pr, and a 409 already open is as good', () => {
  const src = read(UPSTREAM);
  assert.match(src, /post\(api\(slug, 'follow-pr'\), \{ follow \}\)/);
  assert.match(src, /res\.status === 409 && data && \(data\.code === 'already_open'/);
  assert.match(src, /post\(api\(slug, `upstream\/\$\{action\}`\), body\)/, 'open, skip and share answer the GET body');
  const sheet = read('frontend/src/features/versions/updates-sheet.tsx');
  assert.match(sheet, /disabled=\{!up \|\| busy !== null \|\| proposed !== null\}/, 'it says how it is now until the vote changes it');
  assert.match(sheet, /\{up && up\.private && up\.canManage \? \(/, 'share is a private version\'s, for its managers');
  assert.equal(message('project:updates.follow.title', { project: 'Tier list' }), 'Get Tier list’s updates');
  assert.equal(message('project:updates.share.title', { project: 'Tier list' }), 'Share what we make with Tier list');
});

// ── The change page ─────────────────────────────────────────────────────

test('an update\'s page says what it brings, then what it does in this version, in words off the diff', () => {
  const { upstreamLines } = loadTsx(HEAD);
  const lines = upstreamLines({
    from: { slug: 'tier-list', name: 'Tier list', emoji: '🏆' },
    brings: [{ title: 'Comments on each item' }, { title: 'A help sheet' }],
    facts: { tablesAdded: ['comments'], destructive: [], hostsAdded: [], secretsAdded: [], ai: false, storage: false },
    keeps: { count: 5, titles: ['Rate out of 10', 'Who suggested each book'] },
    state: 'open',
    conflicts: [],
  });
  assert.deepEqual(lines.brings, ['Comments on each item', 'A help sheet']);
  // The titles are joined by the language's own list (listText).
  assert.match(lines.here[0].text, /^Keeps your changes: Rate out of 10(,| and) Who suggested each book, and 3 more$/);
  assert.deepEqual(lines.here.slice(1).map((l) => l.text), [
    'Adds 1 table to your data: comments. None of the data you have changes.',
    'No new outside connections',
  ]);
  const risky = upstreamLines({
    facts: { tablesAdded: ['x'], destructive: ['DROP COLUMN rating'], hostsAdded: ['api.example.com'], secretsAdded: ['OPENAI_KEY'], ai: true, storage: true },
    keeps: { count: 1, titles: ['Covers'] },
  });
  assert.deepEqual(risky.here.map((l) => l.text), [
    'Keeps your change: Covers',
    'Changes data you already have: DROP COLUMN rating',
    'Connects to something new outside Homeroom: api.example.com',
    'Needs a new key before it goes live: OPENAI_KEY',
    'Starts using AI',
    'Starts storing files',
  ]);
  assert.equal(risky.here[1].warn, true, 'changing data already there is the one line in the attention ink');
  assert.deepEqual(upstreamLines({ keeps: { count: 2, titles: [] } }).here.map((l) => l.text), ['Keeps your 2 changes']);
  assert.deepEqual(upstreamLines({ facts: {} }).here.map((l) => l.text), ['None of your data changes.', 'No new outside connections']);
  assert.deepEqual(upstreamLines(null), { brings: [], here: [] });
  for (const line of [...lines.here, ...risky.here]) assert.doesNotMatch(line.text, NEVER);
});

test('the From card sits under the summary and Skip under Votes and Testing, and app-view passes upstream through', () => {
  const src = read(HEAD);
  assert.match(src, /\{body\.summaryMore \? <SummaryMore m=\{body\.summaryMore\} \/> : null\}\s*\{v\.upstream \? <UpstreamCard u=\{v\.upstream\} \/> : null\}/);
  assert.match(src, /<ChangeGates ref=\{pair\} id=\{id\} card=\{card\} v=\{v\} \/>\s*\{v\.upstream \? <UpstreamDecline u=\{v\.upstream\} id=\{id\} \/> : null\}\s*\{v\.shots \?/);
  assert.match(src, /state !== 'open' && state !== 'needs_fit'/, 'Skip only while it is still up, as the route allows');
  assert.match(src, /upstreamAction\(slug, 'skip', \{\}, 'project:topic\.change\.upstream\.skip\.failed'\)/);
  assert.match(src, /ui\.confirm\(\{/, 'it asks before it skips');
  const appView = read('public/js/app-view.js');
  assert.match(appView, /upstream: \(item && item\.upstream && typeof item\.upstream === 'object'\) \? item\.upstream : null,/);
  assert.equal(message('project:topic.change.upstream.skip.button'), 'Skip this update');
  assert.equal(message('project:topic.change.upstream.skip.title'), 'Not for your version?');
  assert.equal(message('project:hub.update.fit'), 'Ask Homeroom bot to fit it');
  assert.doesNotMatch(message('project:topic.change.upstream.skip.sub', { project: 'Tier list' }), NEVER);
});

// ── Admin › Limits › Versions ───────────────────────────────────────────

test('the Versions card renders its ids, reads the setting, and offers nothing before it has', () => {
  globalThis.window = globalThis.window || globalThis;
  const mod = loadTsx('frontend/src/features/admin/admin-limits.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (key === 'btn' ? new Proxy({}, { get: () => 'btn' }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const html = renderToHtml(createElement(mod.VersionsCard, { canWrite: true }));
  assert.match(html, /id="admin-versions"/);
  assert.match(html, /id="admin-versions-state"[^>]*>Loading…</);
  assert.match(html, />Versions</);
  assert.doesNotMatch(html, /admin-versions-toggle-btn/, 'no button before the read lands');
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');
  const src = read('frontend/src/features/admin/admin-limits.tsx');
  assert.match(src, /fetchJson\('\/api\/admin\/versions'\)/);
  assert.match(src, /fetch\('\/api\/admin\/versions', \{\s*method: 'PUT'/);
  assert.match(src, /VERSIONS_ENABLED is false/);
  assert.match(src, /<PreviewProjectsCard canWrite=\{canWrite\} \/>\s*<VersionsCard canWrite=\{canWrite\} \/>/);
});

// ── The shots ───────────────────────────────────────────────────────────

test('the hub shots draw a version of Tier list and Tier list itself, with their cards\' reads answered', () => {
  const shot = loadTsx('frontend/src/features/dev-board/workshop/hub-shot.ts');
  assert.equal(shot.hubShot('?shot=hub-version'), 'version');
  assert.equal(shot.hubShot('?shot=hub-original'), 'original');
  const version = shot.hubShotPayload('book-club-picks', 'version', 0);
  assert.deepEqual(version.made_from, { slug: 'tier-list', name: 'Tier list', following: true });
  assert.equal(version.versions, null);
  const original = shot.hubShotPayload('tier-list', 'original', 0);
  assert.deepEqual(original.versions, { count: 214, following: 160 });
  assert.equal(original.made_from, null);
  assert.equal(shot.hubShotUpstream('version').offer.state, 'available');
  assert.equal(shot.hubShotUpstream('original'), null);
  assert.equal(shot.hubShotVersions('original', 0).suggestions.length, 2);
  assert.equal(shot.hubShotVersions('creator', 0), null);
  // The first-week shots are untouched.
  assert.equal(shot.hubShotPayload('garden', 'creator', 0).made_from, undefined);
});
