'use strict';

// #3660: a Homeroom link in a message is drawn as the card it names — for
// each READER, through the view rules a shared card is hydrated under.
//
// The client parses the page out of a link to this platform's own address
// and sends a type, an app slug and a number (POST /api/link-cards). This
// pins the server half: what it accepts, that it never takes a URL, that a
// page the reader cannot open comes back exactly as a page that does not
// exist (unavailable, nothing else), and that the route is rate limited.
//
// Run with: node --test tests/link-cards-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const github = require('../src/services/github');
const sharedObjects = require('../src/services/shared-objects');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APPS = {
  open: {
    id: 7, slug: 'open', name: 'Open App', status: 'running',
    repo_url: 'https://github.com/example/open.git',
    view_visibility: 'public', collab_visibility: 'public',
  },
  secret: {
    id: 8, slug: 'secret', name: 'Secret App', status: 'running',
    repo_url: 'https://github.com/example/secret.git',
    view_visibility: 'private', collab_visibility: 'private',
  },
};

/**
 * A database holding the two apps above, one shared change (#41) and one
 * private draft (#42) on `open`, and a governance question (#5). `member`
 * is whether the viewer collaborates on `secret`.
 */
function fakePool({ member = false } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push(sql);
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (/FROM app_collaborators/.test(sql)) return { rows: member && params[0] === 8 ? [{ '?column?': 1 }] : [] };
      if (/FROM apps WHERE slug = \$1/.test(sql)) return { rows: APPS[params[0]] ? [APPS[params[0]]] : [] };
      if (/FROM chat_sessions cs LEFT JOIN users/.test(sql)) {
        // The visibility rule is the query's; the fake answers as it would:
        // the shared change is anybody's to see, the draft only its owner's.
        if (params[0] === 41) return { rows: [{ id: 41, session_title: 'Sort by date', status: 'promoted', username: 'ada' }] };
        return { rows: [] };
      }
      if (/FROM issues i LEFT JOIN users/.test(sql)) {
        return params[0] === 5 ? { rows: [{ id: 5, title: 'Rename the app', status: 'open', username: 'lin' }] } : { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const viewer = { id: 3, isAdmin: false };

test('a link ref is a type, a slug and a number, and nothing else is taken', () => {
  assert.deepEqual(sharedObjects.normalizeLink({ type: 'issue', app_slug: 'open', issue_number: 12 }),
    { type: 'issue', slug: 'open', ref: 12 });
  assert.deepEqual(sharedObjects.normalizeLink({ type: 'proposal', appSlug: 'open', sessionId: '41' }),
    { type: 'proposal', slug: 'open', ref: 41 });
  assert.deepEqual(sharedObjects.normalizeLink({ type: 'hub', app_slug: 'open', href: 'https://evil.example' }),
    { type: 'hub', slug: 'open', ref: null }, 'a URL rides along unread');
  for (const bad of [
    { type: 'url', app_slug: 'open', href: 'https://example.com' },
    { type: 'spec', app_slug: 'open', session_id: 1, version: 1 },
    { type: 'issue', app_slug: 'open' },
    { type: 'issue', app_slug: 'open', issue_number: '01' },
    { type: 'governance', app_slug: 'open', proposal_id: 2147483648 },
    { type: 'hub', app_slug: 'Open' },
    { type: 'hub', app_slug: '../admin' },
    { type: 'hub', app_id: 7 },
    null, [], 'hub',
  ]) {
    assert.equal(sharedObjects.normalizeLink(bad), null, JSON.stringify(bad));
  }
});

test('a community hub and its discussion are as visible as the app', async () => {
  const pool = fakePool();
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'hub', app_slug: 'open' }), {
    type: 'hub', available: true, appId: 7, appSlug: 'open', title: 'Open App', subtitle: null,
    href: '#app/open/workshop',
  });
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'discussion', app_slug: 'open' }), {
    type: 'discussion', available: true, appId: 7, appSlug: 'open', title: 'Open App', subtitle: null,
    href: '#app/open/dev/chat',
  });
  // A private app the viewer is not in: the same answer as no app at all.
  for (const type of ['hub', 'discussion', 'app']) {
    const hidden = await sharedObjects.hydrateLink(pool, viewer, { type, app_slug: 'secret' });
    const missing = await sharedObjects.hydrateLink(pool, viewer, { type, app_slug: 'nothing-here' });
    assert.deepEqual(hidden, { type, available: false }, `${type} on a private app reveals nothing`);
    assert.deepEqual(missing, hidden, `${type}: hidden and missing cannot be told apart`);
  }
  // A member of that private app sees it.
  const member = await sharedObjects.hydrateLink(fakePool({ member: true }), viewer, { type: 'hub', app_slug: 'secret' });
  assert.equal(member.available, true);
  assert.equal(member.title, 'Secret App');
});

test('a change shows only where the change itself is visible', async () => {
  const pool = fakePool();
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'proposal', app_slug: 'open', session_id: 41 }), {
    type: 'proposal', available: true, appId: 7, appSlug: 'open', subtitle: 'Open App',
    // B4: where it is, in words.
    sessionId: 41, title: 'Sort by date', state: 'waiting for approval', author: 'ada',
    href: '#app/open/dev/proposals/41',
  });
  assert.deepEqual(
    await sharedObjects.hydrateLink(pool, viewer, { type: 'proposal', app_slug: 'open', session_id: 42 }),
    { type: 'proposal', available: false },
    'somebody else’s unshared draft is no card',
  );
  assert.deepEqual(
    await sharedObjects.hydrateLink(pool, viewer, { type: 'proposal', app_slug: 'secret', session_id: 41 }),
    { type: 'proposal', available: false },
    'nor is anything on an app the reader cannot open, whatever its id',
  );
  assert.equal(pool.seen.filter((sql) => /chat_sessions/.test(sql)).length, 2,
    'the private app is refused before its change is ever looked up');
  const gov = await sharedObjects.hydrateLink(pool, viewer, { type: 'governance', app_slug: 'open', proposal_id: 5 });
  assert.equal(gov.available, true);
  assert.equal(gov.href, '#app/open/dev/governance/5');
});

test('a request is the issue card, read through the same public GitHub read', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  const asked = [];
  github.fetchPublicIssue = async (owner, repo, n) => {
    asked.push(`${owner}/${repo}#${n}`);
    return n === 12 ? { issue: { number: 12, title: 'Sort the list', state: 'open', author: 'ada' } } : { issue: null, note: 'not found' };
  };
  const pool = fakePool();
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'issue', app_slug: 'open', issue_number: 12 }), {
    type: 'issue', available: true, appId: 7, appSlug: 'open', subtitle: 'Open App',
    issueNumber: 12, title: 'Sort the list', state: 'open', author: 'ada',
    href: '#app/open/dev/issues/12',
  });
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'issue', app_slug: 'open', issue_number: 13 }),
    { type: 'issue', available: false });
  assert.deepEqual(await sharedObjects.hydrateLink(pool, viewer, { type: 'issue', app_slug: 'secret', issue_number: 12 }),
    { type: 'issue', available: false });
  assert.deepEqual(asked, ['example/open#12', 'example/open#13'],
    'only the app’s own repository is read, and never for an app the reader cannot open');
});

test('a batch answers in order, one card per link, at most ten', async () => {
  const pool = fakePool();
  const cards = await sharedObjects.hydrateLinks(pool, viewer, [
    { type: 'hub', app_slug: 'open' },
    { type: 'url', href: 'https://example.com' },
    { type: 'discussion', app_slug: 'secret' },
  ]);
  assert.deepEqual(cards.map((card) => [card.type, card.available]),
    [['hub', true], ['app', false], ['discussion', false]]);
  const many = await sharedObjects.hydrateLinks(pool, viewer, Array.from({ length: 12 }, () => ({ type: 'hub', app_slug: 'open' })));
  assert.equal(many.length, sharedObjects.MAX_LINK_CARDS);
  assert.equal(sharedObjects.MAX_LINK_CARDS, 10);
});

test('the route takes a bounded list, per user, and answers privately', () => {
  const route = read('src/routes/conversations.js');
  const limits = read('src/middleware/rate-limits.js');
  assert.match(route, /router\.post\('\/api\/link-cards', linkCardLimiter, sameOriginBrowserOnly, async/);
  assert.match(route, /!Array\.isArray\(refs\) \|\| refs\.length > sharedObjects\.MAX_LINK_CARDS/);
  assert.match(route, /sharedObjects\.hydrateLinks\(pool, req\.user, refs\)/);
  assert.match(route, /'\/api\/link-cards'[\s\S]{0,120}res\.set\('Cache-Control', 'private, no-store'\)/);
  assert.match(limits, /const linkCardLimiter = makeLimiter\(\{[\s\S]*?name: 'link-cards',[\s\S]*?keyByUser: true,/);
});
