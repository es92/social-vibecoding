// Route tests for private-conversation attachments (#1194 upload matrix
// lives in platform-messaging-*.test.js; this file covers the two GET
// routes in src/routes/conversations.js that serve them).
//
// The bug this pins (#2113): the serve and preview routes interpolated the
// stored filename straight into Content-Disposition. A header value may
// only carry Latin-1, and real filenames do not — macOS names every
// screenshot with a narrow no-break space (U+202F) before AM/PM — so
// res.set() threw ERR_INVALID_CHAR, the catch block answered 500, and the
// image never rendered in the thread. The fix routes the header through
// attachments.attachmentDisposition (ASCII fallback + RFC 5987 UTF-8).
//
// Also pinned here, because nothing else exercised these handlers end to
// end: the serve route never sends text/html; /view serves ONLY kind
// 'html' under a sandboxing CSP; unlinked rows (message_id NULL) are
// readable by their uploader only; a direct conversation is gated on the
// pairwise block check; non-members never reach the attachments table;
// and the ?demo=1 rows serve without touching the database.
//
// Harness shape follows tests/chat-attachments-route.test.js: override
// getPool before requiring the route, mount on a real express app, and
// answer each SQL statement from a handler keyed on its FROM clause.
//
// Run with: node --test tests/conversation-attachments-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The demo branch is staging-only (isDemo reads IS_STAGING at module load).
process.env.USERNODE_ENV = 'staging';

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const { conversationRoutes } = require('../src/routes/conversations');
const express = require('express');

const ATT_ID = 'c'.repeat(32);
const CONV_ID = 42;
const ME = 5;
const PEER = 9;
const MAC_NAME = 'Screenshot 2026-09-14 at 8.17.22 AM.png';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function startServer(userId = ME, { isAdmin = false } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, username: 'alice', isAdmin }; next(); });
  app.use(conversationRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function urlFor(server, p) {
  return `http://127.0.0.1:${server.address().port}${p}`;
}

// One handler for the whole read path. `membership` null means the caller
// is not an active member; `blocked` flips the pairwise block check.
function fixture({ kind = 'group', membership = true, blocked = false, row } = {}) {
  const seen = [];
  poolQueryHandler = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM conversations c/.test(sql)) {
      return { rows: membership ? [{ id: CONV_ID, kind, role: 'member', membership_status: 'member' }] : [] };
    }
    if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ other_id: PEER }] };
    if (/FROM user_blocks/.test(sql)) return { rows: blocked ? [{ '?column?': 1 }] : [] };
    if (/FROM conversation_message_attachments/.test(sql)) return { rows: row ? [row] : [] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return seen;
}

function attachment(overrides = {}) {
  return {
    id: ATT_ID, kind: 'image', filename: MAC_NAME, content_type: 'image/png',
    data: PNG, message_id: 100, user_id: PEER, ...overrides,
  };
}

const servePath = `/api/conversations/${CONV_ID}/attachments/${ATT_ID}`;

// ── The #2113 regression ────────────────────────────────────────────

test('an image whose name carries a non-Latin-1 character serves 200 inline', async () => {
  fixture({ row: attachment() });
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, servePath));
    assert.equal(res.status, 200, 'used to be 500: ERR_INVALID_CHAR from res.set()');
    assert.equal(res.headers.get('content-type'), 'image/png');
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^inline; filename="Screenshot 2026-09-14 at 8\.17\.22_AM\.png"; /,
      'ASCII fallback replaces the narrow no-break space');
    assert.match(disposition, /filename\*=UTF-8''Screenshot%202026-09-14%20at%208\.17\.22%E2%80%AFAM\.png$/,
      'exact name travels in the RFC 5987 parameter');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  } finally {
    server.close();
  }
});

test('the html preview route also survives a non-Latin-1 filename', async () => {
  fixture({ row: attachment({ kind: 'html', filename: 'Résumé – draft.html', content_type: 'text/html', data: Buffer.from('<h1>hi</h1>') }) });
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `${servePath}/view`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^inline; filename="R_sum_ _ draft\.html"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%93%20draft\.html$/);
    assert.equal(await res.text(), '<h1>hi</h1>');
  } finally {
    server.close();
  }
});

test('the route never builds the header from the raw filename again', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'conversations.js'), 'utf8');
  assert.doesNotMatch(source, /filename="\$\{safeName\}"/);
  assert.equal((source.match(/attachments\.attachmentDisposition\(/g) || []).length, 4,
    'member serve + view and admin evidence serve + view all go through the shared helper');
});

// ── Serve matrix ────────────────────────────────────────────────────

test('markdown, text and html download as text/plain attachments; binary as octet-stream', async () => {
  const cases = [
    ['markdown', 'text/markdown', 'text/plain; charset=utf-8'],
    ['text', 'text/plain', 'text/plain; charset=utf-8'],
    ['html', 'text/html', 'text/plain; charset=utf-8'],
    ['binary', 'application/pdf', 'application/octet-stream'],
    ['binary', 'application/zip', 'application/zip'],
  ];
  for (const [kind, stored, served] of cases) {
    fixture({ row: attachment({ kind, filename: `notes.${kind}`, content_type: stored, data: Buffer.from('x') }) });
    const server = await startServer();
    try {
      const res = await fetch(urlFor(server, servePath));
      assert.equal(res.status, 200, kind);
      assert.equal(res.headers.get('content-type'), served, kind);
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="notes\./, kind);
    } finally {
      server.close();
    }
  }
});

test('/view refuses everything but html', async () => {
  for (const kind of ['image', 'markdown', 'text', 'binary']) {
    fixture({ row: attachment({ kind }) });
    const server = await startServer();
    try {
      const res = await fetch(urlFor(server, `${servePath}/view`));
      assert.equal(res.status, 404, kind);
    } finally {
      server.close();
    }
  }
});

// ── Access rules ────────────────────────────────────────────────────

test('an unsent upload (message_id NULL) is visible to its uploader only', async () => {
  fixture({ row: attachment({ message_id: null, user_id: PEER }) });
  let server = await startServer(ME);
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 404, 'another member');
  } finally {
    server.close();
  }
  fixture({ row: attachment({ message_id: null, user_id: ME }) });
  server = await startServer(ME);
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 200, 'the uploader');
  } finally {
    server.close();
  }
});

test('a direct conversation is gated on the pairwise block check', async () => {
  let seen = fixture({ kind: 'direct', blocked: true, row: attachment() });
  let server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 404);
    assert.ok(seen.some((q) => /FROM user_blocks/.test(q.sql)), 'block check ran');
    assert.ok(!seen.some((q) => /FROM conversation_message_attachments/.test(q.sql)),
      'the attachment row is never read for a blocked pair');
  } finally {
    server.close();
  }
  seen = fixture({ kind: 'direct', blocked: false, row: attachment() });
  server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 200);
    const pair = seen.find((q) => /FROM conversation_direct_pairs/.test(q.sql));
    assert.ok(pair && /FOR SHARE/.test(pair.sql), 'peer lookup is the FOR SHARE read');
  } finally {
    server.close();
  }
});

test('a group conversation skips the pair and block lookups', async () => {
  const seen = fixture({ kind: 'group', row: attachment() });
  const server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 200);
    assert.ok(!seen.some((q) => /user_blocks|conversation_direct_pairs/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('non-members 404 without the attachment row ever being read', async () => {
  const seen = fixture({ membership: false, row: attachment() });
  const server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, servePath))).status, 404);
    assert.equal((await fetch(urlFor(server, `${servePath}/view`))).status, 404);
    assert.ok(!seen.some((q) => /FROM conversation_message_attachments/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('a malformed attachment id or conversation id is a 404, not a query', async () => {
  const seen = fixture({ row: attachment() });
  const server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, `/api/conversations/${CONV_ID}/attachments/not-hex`))).status, 404);
    assert.equal((await fetch(urlFor(server, `/api/conversations/abc/attachments/${ATT_ID}`))).status, 404);
    assert.equal(seen.length, 0);
  } finally {
    server.close();
  }
});

// ── Staging demo ────────────────────────────────────────────────────

test('?demo=1 serves the demo group rows without touching the database', async () => {
  const seen = fixture({ membership: false });
  const server = await startServer();
  try {
    const md = await fetch(urlFor(server, '/api/conversations/910002/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1'));
    assert.equal(md.status, 200);
    assert.equal(md.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(md.headers.get('content-disposition'), /^attachment; filename="launch-checklist\.md"/);
    assert.match(await md.text(), /^# Launch checklist/);

    // The demo screenshot carries the macOS narrow no-break space on
    // purpose, so the staging preview renders the exact case that 500ed.
    const img = await fetch(urlFor(server, '/api/conversations/910002/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?demo=1'));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-disposition'), /filename\*=UTF-8''Screenshot%202026-08-13%20at%2012\.44\.10%E2%80%AFPM\.png$/);
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG');
    assert.equal(seen.length, 0);

    // The demo list advertises both rows under ?demo=1 urls.
    const list = await fetch(urlFor(server, '/api/conversations/910002/messages?demo=1'));
    assert.equal(list.status, 200);
    const body = await list.json();
    const atts = body.messages.flatMap((m) => m.attachments);
    assert.deepEqual(atts.map((a) => a.id), ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    assert.equal(atts[1].name, 'Screenshot 2026-08-13 at 12.44.10 PM.png');
    assert.equal(atts[1].contentType, 'image/png');
    assert.match(atts[1].url, /\?demo=1$/);
  } finally {
    server.close();
  }
});

test('?demo=1 never bypasses the real path for /view or other conversations', async () => {
  const seen = fixture({ membership: false });
  const server = await startServer();
  try {
    assert.equal((await fetch(urlFor(server, '/api/conversations/910002/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/view?demo=1'))).status, 404);
    assert.equal((await fetch(urlFor(server, '/api/conversations/910001/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1'))).status, 404);
    assert.ok(seen.some((q) => /FROM conversations c/.test(q.sql)), 'fell through to the membership read');
  } finally {
    server.close();
  }
});

// ── Admin evidence (reported messages) ──────────────────────────────

test('admin evidence routes survive a non-Latin-1 filename too', async () => {
  const seen = [];
  poolQueryHandler = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM conversation_message_reports r/.test(sql)) {
      return { rows: [{ id: ATT_ID, kind: 'image', filename: MAC_NAME, content_type: 'image/png', data: PNG }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const server = await startServer(ME, { isAdmin: true });
  try {
    const res = await fetch(urlFor(server, `/api/admin/conversation-reports/77/attachments/${ATT_ID}`));
    assert.equal(res.status, 200, 'used to be 500: ERR_INVALID_CHAR from res.set()');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'),
      /^inline; filename="Screenshot 2026-09-14 at 8\.17\.22_AM\.png"; filename\*=UTF-8''Screenshot%202026-09-14%20at%208\.17\.22%E2%80%AFAM\.png$/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.deepEqual(seen[0].params, [77, ATT_ID], 'joined through the report row');
  } finally {
    server.close();
  }

  poolQueryHandler = async () => ({
    rows: [{ id: ATT_ID, kind: 'html', filename: 'Résumé.html', content_type: 'text/html', data: Buffer.from('<p>x</p>') }],
  });
  const viewServer = await startServer(ME, { isAdmin: true });
  try {
    const res = await fetch(urlFor(viewServer, `/api/admin/conversation-reports/77/attachments/${ATT_ID}/view`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="R_sum_\.html"; filename\*=UTF-8''R%C3%A9sum%C3%A9\.html$/);
  } finally {
    viewServer.close();
  }
});

test('admin evidence routes stay admin-only and html-only for /view', async () => {
  let queried = false;
  poolQueryHandler = async () => {
    queried = true;
    return { rows: [{ id: ATT_ID, kind: 'image', filename: 'a.png', content_type: 'image/png', data: PNG }] };
  };
  let server = await startServer(ME, { isAdmin: false });
  try {
    assert.equal((await fetch(urlFor(server, `/api/admin/conversation-reports/77/attachments/${ATT_ID}`))).status, 403);
    assert.equal(queried, false, 'non-admins never reach the query');
  } finally {
    server.close();
  }
  server = await startServer(ME, { isAdmin: true });
  try {
    assert.equal((await fetch(urlFor(server, `/api/admin/conversation-reports/77/attachments/${ATT_ID}/view`))).status, 404,
      'an image is not previewable as html');
  } finally {
    server.close();
  }
});
