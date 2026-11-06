'use strict';

// The Communities tab's badge on a brand-new account (5 Oct 2026).
//
// Two new accounts on production opened their first session under an accent
// "5" and an "8" on the Communities tab. They had joined nothing and been
// asked nothing: every account with platform access is put in Homeroom, the
// platform's own community, and every change proposed to the platform was a
// vote they owed, so the tab asked for them about a community they never
// chose, on the screen that asks "What do you want to make?".
//
// The rule: a community you are in only as every account is ('auto') and
// have not taken part in yet is UNCHOSEN, and its votes do not put a number
// on the tab. They are still counted everywhere you go to look. The
// server's half (which communities are unchosen) runs against Postgres in
// tests/new-account-communities-badge-postgres.test.js; this file EXECUTES
// the client's half (tests/lib/render-tsx.js `loadTsx`): the scope store
// that reads the flag, the number the tab draws from it, and the tab itself.
//
// Run with: node --test tests/new-account-communities-badge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SEEN_SRC = 'frontend/src/features/workshop/needs-seen.ts';
const SCOPE_SRC = 'frontend/src/features/workshop/community-scope.ts';

/** A browser's worth of window: an account, a storage, and two endpoints. */
function fakeBrowser(userId, answers) {
  const store = new Map();
  globalThis.window = {
    App: { user: { id: userId } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    location: { search: '' },
    setTimeout, clearTimeout,
  };
  globalThis.fetch = async (url) => {
    const key = String(url).replace(/\?.*$/, '');
    const body = answers[key];
    return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) };
  };
}

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.fetch;
});

/** The scope store, loaded against the same needs-seen record it derives from. */
function loadScope() {
  const seen = loadTsx(SEEN_SRC);
  const scope = loadTsx(SCOPE_SRC, { stubs: { './needs-seen': seen } });
  return { seen, scope };
}

const HOMEROOM = { slug: 'homeroom', name: 'Homeroom', self_hosted: true, audience: 'open', is_member: true };
const FLAT = { slug: 'flat-4b', name: 'Flat 4B Chores', audience: 'invited', is_member: true };
const HOMEROOM_OWED = ['proposal:11@0', 'proposal:12@0', 'proposal:13@1', 'proposal:14@0', 'governance:5'];

test('a brand-new account: Homeroom\'s five votes are counted, and the tab says nothing', async () => {
  fakeBrowser(41, {
    '/api/apps': { apps: [HOMEROOM] },
    '/api/workshop/counts': { counts: { homeroom: { working: 0, needs: 5, owed: HOMEROOM_OWED, unchosen: true } } },
  });
  const { scope } = loadScope();
  await scope.loadCommunities(true);
  const st = scope.communityScopeStore.get();
  assert.equal(st.info.homeroom.unchosen, true, 'the counts said so, and the scope keeps it beside the number');
  assert.equal(st.info.homeroom.needs, 5, 'the votes are still owed: the switcher still says "5 to vote"');
  assert.equal(st.totalNeeds, 5, 'and its All communities line counts them');
  assert.equal(st.badgeNeeds, 0, 'but none of them asks for a newcomer');
  assert.equal(scope.tabVotes(st), 0, 'no number on the tab on All communities');
  // On Homeroom's own page the tab is on Homeroom, and says nothing either.
  assert.equal(scope.tabVotes({ ...st, slug: 'homeroom' }), 0);
});

test('a member of a group with a change waiting for them: that one asks', async () => {
  fakeBrowser(42, {
    '/api/apps': { apps: [HOMEROOM, FLAT] },
    '/api/workshop/counts': {
      counts: {
        homeroom: { working: 0, needs: 5, owed: HOMEROOM_OWED, unchosen: true },
        'flat-4b': { working: 0, needs: 1, owed: ['proposal:90@0'] },
      },
    },
  });
  const { scope, seen } = loadScope();
  await scope.loadCommunities(true);
  const st = () => scope.communityScopeStore.get();
  assert.equal(st().info['flat-4b'].unchosen, false, 'a community they are in by choice is never unchosen');
  assert.equal(st().totalNeeds, 6);
  assert.equal(st().badgeNeeds, 1, 'the group\'s one change, and not Homeroom\'s five');
  assert.equal(scope.tabVotes(st()), 1);
  assert.equal(scope.tabVotes({ ...st(), slug: 'flat-4b' }), 1, 'and on the group\'s own page');
  // Swiped past in a Needs you feed: both sums follow at once (#3526).
  seen.markNeedsSeen('flat-4b', 'proposal:90@0');
  assert.equal(st().badgeNeeds, 0);
  assert.equal(st().totalNeeds, 5);
  // A project page describing itself keeps what the counts said about it.
  scope.describe('homeroom', { owedCount: 6, owed: [...HOMEROOM_OWED, 'proposal:15@0'] });
  assert.equal(st().info.homeroom.unchosen, true, 'a page\'s own count does not undo it');
  assert.equal(st().badgeNeeds, 0);
  assert.equal(st().totalNeeds, 6);
});

test('once they have voted in Homeroom, its votes count on the tab', async () => {
  // The server stops marking it unchosen; the next read takes the flag off.
  fakeBrowser(43, {
    '/api/apps': { apps: [HOMEROOM] },
    '/api/workshop/counts': { counts: { homeroom: { working: 0, needs: 5, owed: HOMEROOM_OWED, unchosen: true } } },
  });
  const { scope } = loadScope();
  await scope.loadCommunities(true);
  assert.equal(scope.tabVotes(scope.communityScopeStore.get()), 0);
  fakeBrowser(43, {
    '/api/apps': { apps: [HOMEROOM] },
    '/api/workshop/counts': { counts: { homeroom: { working: 0, needs: 4, owed: HOMEROOM_OWED.slice(1) } } },
  });
  await scope.loadCommunities(true);
  const st = scope.communityScopeStore.get();
  assert.equal(st.info.homeroom.unchosen, false, 'read fresh on every load');
  assert.equal(st.badgeNeeds, 4);
  assert.equal(scope.tabVotes(st), 4);
});

test('#5296: All communities hands its counts to the tab, so a vote that lands moves both at once', async () => {
  fakeBrowser(44, {
    '/api/apps': { apps: [HOMEROOM, FLAT] },
    '/api/workshop/counts': {
      counts: {
        homeroom: { working: 0, needs: 5, owed: HOMEROOM_OWED, unchosen: true },
        'flat-4b': { working: 0, needs: 1, owed: ['proposal:90@0'] },
      },
    },
  });
  const { scope } = loadScope();
  await scope.loadCommunities(true);
  assert.equal(scope.tabVotes(scope.communityScopeStore.get()), 1);
  scope.takeCounts({
    homeroom: { working: 0, needs: 5, owed: HOMEROOM_OWED, unchosen: true },
    'flat-4b': { working: 0, needs: 2, owed: ['proposal:90@0', 'proposal:91@0'] },
  });
  const st = scope.communityScopeStore.get();
  assert.equal(st.badgeNeeds, 2, 'the page\'s read, on the tab without a read of its own');
  assert.equal(st.totalNeeds, 7);
  assert.equal(scope.votesWaiting(st.info.homeroom), 0, 'one definition: an unchosen community waits on nobody');
  assert.equal(scope.votesWaiting(st.info['flat-4b']), 2);
  scope.takeCounts({});
  assert.equal(scope.communityScopeStore.get().badgeNeeds, 0, 'a community the counts left out owes nothing');
});

// ── The tab itself ─────────────────────────────────────────────────────

const ui = loadTsx('tests/fixtures/tab-bar-api.ts');

function workshopTab(state) {
  const before = ui.communityScopeStore.get();
  ui.communityScopeStore.set(state);
  try {
    const html = renderToHtml(createElement(ui.PlatformTabs, {}));
    const at = html.indexOf('id="platform-tab-workshop"');
    assert.ok(at > 0, '#platform-tab-workshop renders');
    return html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at) + 4);
  } finally {
    ui.communityScopeStore.set(before);
  }
}

test('the tab draws no accent number for an unchosen community, and draws one for a group\'s vote', () => {
  const homeroom = { slug: 'homeroom', name: 'Homeroom', iconUrl: null, iconEmoji: null, iconColor: null, needs: 8, unchosen: true };
  const flat = { slug: 'flat-4b', name: 'Flat 4B Chores', iconUrl: null, iconEmoji: '🧹', iconColor: null, needs: 1 };
  const list = ['homeroom', 'flat-4b'];

  const newcomer = workshopTab({ slug: null, info: { homeroom }, list: ['homeroom'], totalNeeds: 8, badgeNeeds: 0 });
  assert.doesNotMatch(newcomer, /platform-tab-votes/, 'a brand-new account: no badge');
  const onHomeroom = workshopTab({ slug: 'homeroom', info: { homeroom }, list: ['homeroom'], totalNeeds: 8, badgeNeeds: 0 });
  assert.doesNotMatch(onHomeroom, /platform-tab-votes/, 'nor with the tab on Homeroom');

  const member = workshopTab({ slug: null, info: { homeroom, flat }, list, totalNeeds: 9, badgeNeeds: 1 });
  assert.match(member, /<span class="platform-tab-votes" aria-label="1 vote waiting on you">1<\/span>/,
    'the group\'s one vote, in words for a screen reader, and only that one');
  const taking = workshopTab({ slug: 'homeroom', info: { homeroom: { ...homeroom, unchosen: false } }, list: ['homeroom'], totalNeeds: 8, badgeNeeds: 8 });
  assert.match(taking, /<span class="platform-tab-votes" aria-label="8 votes waiting on you">8<\/span>/,
    'someone who takes part in Homeroom still sees its votes');
});

test('the tab reads its number from tabVotes, and the counts route carries the flag', () => {
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /const votes = tabVotes\(scope\);/);
  assert.doesNotMatch(bar, /scope\.totalNeeds/, 'All communities\' badge is not every vote owed any more');
  const route = read('src/routes/workshop-overview.js');
  assert.match(route, /communities\.unchosenCommunities\(pool, req\.user\.id\)/);
  assert.match(route, /\.\.\.\(unchosen\.has\(row\.slug\) \? \{ unchosen: true \} : \{\}\),/);
  // The switcher and the app menu still count every vote owed. Home's Needs
  // you tile does not (#5296): it says the tab's number, `badgeNeeds`, the
  // sum of the tab's own `votesWaiting`, because a page saying 14 under a
  // tab that said 13 was the bug. (It was the Communities list's Needs you
  // row until One Home, #6361.)
  assert.match(read('frontend/src/features/workshop/community-scope.ts'), /badgeNeeds \+= votesWaiting\(info\[s\]\);/);
  assert.match(read('frontend/src/features/home/pinned-communities.tsx'), /const \{ badgeNeeds \} = useStoreState\(communityScopeStore\)/);
  for (const file of [
    'frontend/src/features/workshop/community-switcher.tsx',
    'frontend/src/features/app-context/app-context-sheet.tsx',
  ]) {
    assert.ok(!/\.unchosen\b|\bunchosen:/.test(read(file)), `${file} still counts every vote owed`);
  }
});
