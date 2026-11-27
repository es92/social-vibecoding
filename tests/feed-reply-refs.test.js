// #2497 — the Activity feed's reply box suggests pull requests and issues on
// `PR#` and `#`, the way the card page's chat composer already does.
//
// ── One message box, one # list (27 Nov 2026) ─────────────────────────
//
// The classic script's RefAutocomplete and the feed's ref-typeahead.tsx were
// two copies of this list. Every box that writes into a project's chat is
// Messages' box now (features/messages/composer.tsx MessageBox), and a
// project's chat answers its `#` from features/group-chat/chat-sources.ts
// (`chatRefMatch`, over what `loadChatRefs` holds): the trigger grammar, the
// two endpoints and the canonical `PR#N` / `#N` it inserts are the old
// list's, and a bare `#` offers the viewer's channels after them (#2783).
//
// Run with: node --test tests/feed-reply-refs.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const FEED = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const GC = read('frontend/src/features/group-chat/composer.tsx');
const SOURCES = 'frontend/src/features/group-chat/chat-sources.ts';

const held = {
  prs: [{ kind: 'pr', number: 2151, title: 'Refs in the reply box' }, { kind: 'pr', number: 12, title: 'A twelve' }],
  issues: [{ kind: 'issue', number: 2497, title: 'Add autocomplete for PR and issue references' }, { kind: 'issue', number: 13, title: '' }],
  fetchedAt: Date.now(),
};

test('PR# lists pull requests, a bare # lists requests then changes, and a word lists channels', () => {
  const { chatRefMatch } = loadTsx(SOURCES);
  const pr = chatRefMatch('see PR#2', held);
  assert.equal(pr.start, 4, 'the token starts at the P');
  assert.deepEqual(pr.items.map((i) => i.insert), ['PR#2151']);
  const bare = chatRefMatch('see #1', held);
  assert.deepEqual(bare.items.map((i) => i.insert), ['#13', 'PR#12'], 'requests first, then changes, by number prefix');
  assert.equal(bare.items[0].label, '#13');
  assert.equal(chatRefMatch('see #', held).items[0].name, 'Add autocomplete for PR and issue references', 'a row names its title');
  assert.equal(chatRefMatch('PR#ab', held), null, 'a change is a number, never a channel');
  assert.equal(chatRefMatch('a&#1', held), null, 'the renderer\'s `&` boundary');
  assert.equal(chatRefMatch('no token here', held), null);
  // Not loaded yet: the token still stands, with nothing to offer.
  assert.deepEqual(chatRefMatch('#1', null).items, []);
});

test('the @ list and the # list can never be open at the same caret', () => {
  const { chatRefMatch } = loadTsx(SOURCES);
  // A `#` token needs its `#` (or `PR#`) right before what is typed, and the
  // box's `@` token is a run with no `#` boundary in it: `@ev` is not a ref.
  assert.equal(chatRefMatch('hi @ev', held), null);
});

test('the candidates are the two endpoints the drawer already reads, fetched once per app', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const bodies = {
    '/api/apps/usernode-2d5619/promoted?results=failing': {
      promoted: [
        { pr_number: 2151, pr_title: 'Refs in the reply box' },
        { pr_number: 2152, username: 'evan' },
        { pr_number: null, pr_title: 'not a PR yet' },
      ],
    },
    '/api/apps/usernode-2d5619/github-issues': {
      issues: [{ number: 2497, title: 'Add autocomplete for PR and issue references' }],
    },
  };
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => bodies[url] || {} }; };
  try {
    const api = loadTsx(SOURCES);
    assert.equal(api.promotedPath('usernode-2d5619'), '/api/apps/usernode-2d5619/promoted?results=failing');
    assert.equal(api.githubIssuesPath('a b'), '/api/apps/a%20b/github-issues');
    assert.equal(api.heldChatRefs('usernode-2d5619'), null, 'nothing is read until somebody types #');
    const [a, b] = await Promise.all([api.loadChatRefs('usernode-2d5619'), api.loadChatRefs('usernode-2d5619')]);
    assert.equal(b, a, 'two boxes asking at once share one read');
    assert.deepEqual(a.issues, [{ kind: 'issue', number: 2497, title: 'Add autocomplete for PR and issue references' }]);
    assert.deepEqual(a.prs, [
      { kind: 'pr', number: 2151, title: 'Refs in the reply box' },
      { kind: 'pr', number: 2152, title: 'by evan' },
    ], 'a PR with no title falls back to its author, and one with no number is not a candidate');
    assert.equal(calls.length, 2);
    assert.equal(api.heldChatRefs('usernode-2d5619'), a);
    await api.loadChatRefs('usernode-2d5619');
    assert.equal(calls.length, 2, 'a later box reads the held lists');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the comments box and a chat\'s box read the list only once somebody types #', () => {
  for (const src of [FEED, GC]) {
    assert.match(src, /if \(!held && before\.includes\('#'\)\) void loadChatRefs\(slug\)\.then\(\(\) => refsArrived\(\(n\) => n \+ 1\)\);\s*return chatRefMatch\(before, held\);/);
  }
});

test('the lists only read', () => {
  const src = read(SOURCES);
  const refs = src.slice(src.indexOf('// ── Requests and changes'), src.indexOf('// ── Files'));
  assert.doesNotMatch(refs, /method:/);
});
