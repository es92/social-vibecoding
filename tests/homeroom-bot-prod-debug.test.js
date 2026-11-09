'use strict';

// #6427: Homeroom bot's read-only production debugging for full admins, only
// in their own chat with it (services/homeroom-bot-thread-tools/admin.js
// query_prod_db and prod_status). Who is offered them and where, that every
// call is refused unless both hold again, that SQL runs only as the reviewed
// debug role, that the allowlist holds no personal-looking column, that each
// call is audited before it runs, and that a card posting somewhere public
// after a database read in its thread says so.
//
// Run with: node --test tests/homeroom-bot-prod-debug.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const admin = require('../src/services/homeroom-bot-thread-tools/admin');
const registry = require('../src/services/homeroom-bot-thread-tools');
const debugAccess = require('../src/services/debug-access');
const statusSvc = require('../src/services/status');
const log = require('../src/services/logger');
const confirmations = require('../src/services/confirmations');
const schema = require('../src/services/debug-access-schema.json');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONFIG = { dataEncryptionKey: 'synthetic-test-key' };
const ADMIN = { id: 7, username: 'ada', isAdmin: true };
const BOT = { id: 2, username: 'homeroom_bot' };
const CONVERSATION = 40;
const PROD = ['query_prod_db', 'prod_status'];
const REFUSAL = 'Only a full platform admin can use that, and only in their own chat with me. Nothing was run.';

const names = (tools) => tools.map((t) => t.function.name);

/**
 * A pool that answers what admin.js asks: whether a person is an admin, who
 * is in a conversation, and the admin-actions rows. `members` are
 * { user_id, status, synthetic } rows of a conversation of `kind`.
 */
function fakePool({
  adminRow = { is_admin: true, admin_readonly: false, is_synthetic: false },
  members = [{ user_id: 7, status: 'member' }, { user_id: 2, status: 'member', synthetic: true }],
  kind = 'direct', audits = [], events = null,
} = {}) {
  const queries = [];
  return {
    queries, audits,
    async query(sql, values = []) {
      queries.push({ sql, values });
      events?.push(`pool:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
      if (/FROM users WHERE id = \$1/.test(sql)) return { rows: adminRow ? [adminRow] : [] };
      if (/FROM conversation_members cm/.test(sql)) {
        const [, person, bot] = values;
        const rows = kind === 'direct' ? members : [];
        return {
          rows: [{
            members: rows.length,
            person: rows.filter((m) => m.user_id === person && m.status === 'member').length,
            bot: rows.filter((m) => m.user_id === bot && m.status === 'member' && m.synthetic).length,
          }],
        };
      }
      if (/INSERT INTO homeroom_bot_admin_actions/.test(sql)) {
        audits.push({
          id: values[0], user_id: values[1], conversation_id: values[2], thread_root_id: values[3], tool_name: values[4],
          sealed_input: JSON.parse(values[5]), input_hash: values[6], status: 'running',
        });
        return { rows: [] };
      }
      if (/UPDATE homeroom_bot_admin_actions SET status = \$2, result/.test(sql)) {
        const row = audits.find((a) => a.id === values[0] && a.status === 'running');
        if (row) Object.assign(row, { status: values[1], result: JSON.parse(values[2]) });
        return { rows: [] };
      }
      if (/SELECT 1 FROM homeroom_bot_admin_actions/.test(sql)) {
        const [user, conversation, roots] = values;
        const hit = audits.some((a) => a.user_id === user && a.conversation_id === conversation
          && a.tool_name === 'query_prod_db' && ['running', 'done'].includes(a.status)
          && roots.includes(Number(a.thread_root_id) || 0));
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO bot_cards/.test(sql)) return { rows: [{ id: 11 }] };
      return { rows: [] };
    },
  };
}

function turn({ user = ADMIN, threadRootId = null, conversationId = CONVERSATION, deps = {} } = {}) {
  return {
    user, bot: BOT, conversationId, config: CONFIG,
    deps: { ...(threadRootId ? { threadRootId } : {}), ...deps },
  };
}

/** Swap a module's export for the test, put back after it. */
function swap(t, mod, key, value) {
  const original = mod[key];
  mod[key] = value;
  t.after(() => { mod[key] = original; });
}

// ── Offering ────────────────────────────────────────────────────────────

test('a full admin is offered both reads in their own two-member chat with the bot, in Main and in a private thread', async () => {
  for (const threadRootId of [null, 900]) {
    const ctx = turn({ threadRootId });
    assert.ok(!names(admin.tools(ctx)).some((n) => PROD.includes(n)), 'nothing before the turn has read whose chat it is');
    await admin.beforeTurn(fakePool(), ctx);
    const offered = names(admin.tools(ctx));
    for (const name of PROD) assert.ok(offered.includes(name), `${name} is offered (thread ${threadRootId})`);
    const lines = admin.promptLines(ctx).join('\n');
    assert.match(lines, /query_prod_db/);
    assert.match(lines, /Never copy query results/);
    assert.match(lines, /Describe what you found in your\s+own words instead/);
    assert.doesNotMatch(lines, /—/, 'no em dash in what the bot is told');
  }
  // Through the registry the chat turn uses, beforeTurn first (homeroom-bot-mayor.js answer).
  const ctx = turn({ threadRootId: 900 });
  await registry.beforeTurn(fakePool(), ctx);
  const offered = names(registry.toolsFor(ctx));
  for (const name of PROD) assert.ok(offered.includes(name));
  const query = registry.toolsFor(ctx).find((t) => t.function.name === 'query_prod_db');
  assert.deepEqual(query.function.parameters.required, ['sql']);
  assert.match(query.function.description, /requests\(id, app_id, number, state/, 'the readable columns are named for the model');
  assert.match(query.function.description, /only here, in their own chat with you/);
});

test('a view-only admin, a non-admin and a synthetic account are never offered them, nor told of them', async () => {
  for (const user of [
    { id: 7, username: 'ro', isAdmin: true, adminReadonly: true },
    { id: 7, username: 'cw', isAdmin: true, canAdminWrite: false },
    { id: 7, username: 'sam' },
    { id: 7, username: 'sam', isAdmin: false },
    { id: 7, username: 'homeroom_bot', isAdmin: true, isSynthetic: true },
  ]) {
    const pool = fakePool();
    const ctx = turn({ user });
    await admin.beforeTurn(pool, ctx);
    assert.equal(pool.queries.length, 0, `${user.username}: nothing is even read`);
    assert.ok(!names(admin.tools(ctx)).some((n) => PROD.includes(n)), `${user.username} is offered neither`);
    assert.doesNotMatch(admin.promptLines(ctx).join('\n'), /query_prod_db/);
  }
});

test('a conversation with a third member, or not with the bot, offers neither', async () => {
  const cases = {
    'a third member': { members: [{ user_id: 7, status: 'member' }, { user_id: 2, status: 'member', synthetic: true }, { user_id: 9, status: 'member' }] },
    'a third member only invited': { members: [{ user_id: 7, status: 'member' }, { user_id: 2, status: 'member', synthetic: true }, { user_id: 9, status: 'invited' }] },
    'a person, not the bot': { members: [{ user_id: 7, status: 'member' }, { user_id: 2, status: 'member' }] },
    'somebody else\'s pair': { members: [{ user_id: 8, status: 'member' }, { user_id: 2, status: 'member', synthetic: true }] },
    'a group': { kind: 'group' },
  };
  for (const [label, shape] of Object.entries(cases)) {
    const ctx = turn();
    await admin.beforeTurn(fakePool(shape), ctx);
    assert.ok(!names(admin.tools(ctx)).some((n) => PROD.includes(n)), `${label}: neither is offered`);
  }
  // A stale mark for another conversation offers nothing either.
  const ctx = { ...turn(), ownChatWithBot: CONVERSATION + 1 };
  assert.ok(!names(admin.tools(ctx)).some((n) => PROD.includes(n)));
});

// ── Refusing ────────────────────────────────────────────────────────────

test('run() refuses, and runs nothing, with a third member, outside a chat with the bot, or once admin is revoked', async (t) => {
  let ran = 0;
  swap(t, debugAccess, 'runQuery', async () => { ran += 1; return { rows: [], rowCount: 0, truncated: false }; });
  swap(t, statusSvc, 'gather', async () => { ran += 1; return {}; });
  const refusedRun = async (_t, label, { pool, ctx, name = 'query_prod_db' }) => {
    const before = ran;
    const out = await admin.run(pool, ctx, name, { sql: 'SELECT id FROM apps' });
    assert.deepEqual(out, { ok: false, error: REFUSAL }, label);
    assert.equal(ran, before, `${label}: nothing ran`);
    assert.ok(!pool.queries.some((q) => /homeroom_bot_admin_actions/.test(q.sql)), `${label}: nothing was recorded as run`);
  };
  // Offered at the turn's start, so only the fresh reads stand in the way.
  for (const name of PROD) {
    await refusedRun(t, `${name}: a third member`, {
      name, ctx: { ...turn(), ownChatWithBot: CONVERSATION },
      pool: fakePool({ members: [{ user_id: 7, status: 'member' }, { user_id: 2, status: 'member', synthetic: true }, { user_id: 9, status: 'member' }] }),
    });
    await refusedRun(t, `${name}: not a conversation with the bot`, {
      name, ctx: { ...turn(), ownChatWithBot: CONVERSATION },
      pool: fakePool({ members: [{ user_id: 7, status: 'member' }, { user_id: 5, status: 'member' }] }),
    });
    await refusedRun(t, `${name}: admin revoked between the turn starting and the call`, {
      name, ctx: { ...turn(), ownChatWithBot: CONVERSATION },
      pool: fakePool({ adminRow: { is_admin: false, admin_readonly: false, is_synthetic: false } }),
    });
    await refusedRun(t, `${name}: made view-only since`, {
      name, ctx: { ...turn(), ownChatWithBot: CONVERSATION },
      pool: fakePool({ adminRow: { is_admin: true, admin_readonly: true, is_synthetic: false } }),
    });
    await refusedRun(t, `${name}: no turn of a full admin`, {
      name, ctx: { ...turn({ user: { id: 7, username: 'sam' } }), ownChatWithBot: CONVERSATION }, pool: fakePool(),
    });
  }
});

test('called by name where it was never offered, the call still gets its own refusal through the registry', async (t) => {
  let ran = 0;
  swap(t, debugAccess, 'runQuery', async () => { ran += 1; return { rows: [], rowCount: 0, truncated: false }; });
  const pool = fakePool({ members: [{ user_id: 7, status: 'member' }, { user_id: 9, status: 'member' }] });
  const ctx = turn();
  await registry.beforeTurn(pool, ctx);
  assert.ok(!names(registry.toolsFor(ctx)).includes('query_prod_db'));
  assert.deepEqual(await registry.run(pool, ctx, 'query_prod_db', { sql: 'SELECT 1' }), { ok: false, error: REFUSAL });
  const stranger = turn({ user: { id: 8, username: 'sam' } });
  assert.deepEqual(await registry.run(fakePool(), stranger, 'prod_status', {}), { ok: false, error: REFUSAL });
  assert.equal(ran, 0);
});

// ── Never on a public surface ───────────────────────────────────────────

test('the tool lists of project threads, request discussions and chat mentions never include either', () => {
  const voice = require('../src/services/homeroom-bot-voice');
  const everything = { ownChange: true, otherChange: true, requestChange: true, openChangeCount: 3, platform: true, planWaiting: true };
  for (const type of ['issue', 'session', 'chat', 'category', 'message']) {
    for (const opts of [{}, everything]) {
      const offered = names(voice.toolsFor({ type, ref: 1 }, opts));
      for (const name of PROD) assert.ok(!offered.includes(name), `${type}: ${name} is never offered`);
    }
  }
  // No public surface loads the admin registry, and homeroom-bot-chat.js
  // gives its model no thread tools at all; only the chat with the bot does.
  // #6534 lets a project thread offer the pictures tool, so voice may load
  // that one module and nothing else from the thread tools.
  for (const file of ['src/services/homeroom-bot-voice.js', 'src/services/homeroom-bot-chat.js']) {
    const source = read(file);
    for (const name of PROD) assert.ok(!source.includes(name), `${file} never names ${name}`);
  }
  assert.doesNotMatch(read('src/services/homeroom-bot-chat.js'), /homeroom-bot-thread-tools/, 'the chat with the bot never loads the thread tools');
  const threadToolImports = [...read('src/services/homeroom-bot-voice.js')
    .matchAll(/require\('\.\/homeroom-bot-thread-tools\/([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(threadToolImports, ['pictures'], 'a public thread loads only the pictures module, never the admin or follow-up tools');
  const loaders = ['src/services/homeroom-bot-voice.js', 'src/services/homeroom-bot-chat.js', 'src/services/homeroom-bot-mayor.js']
    .filter((file) => /require\('\.\/homeroom-bot-thread-tools'\)/.test(read(file)));
  assert.deepEqual(loaders, ['src/services/homeroom-bot-mayor.js']);
  assert.match(read('src/services/homeroom-bot-mayor.js'), /await threadTools\.beforeTurn\(pool, ctx\);\s+const extraTools = threadTools\.toolsFor\(ctx\);/,
    'the chat with the bot reads whose chat it is before it lists its tools');
});

// ── The role ────────────────────────────────────────────────────────────

test('a query runs through debugAccess.runQuery as the debug role, never on the main pool', async (t) => {
  const asked = [];
  swap(t, debugAccess, 'runQuery', async (sql, opts) => {
    asked.push({ sql, opts });
    return { rows: [{ id: 3, state: 'open' }], rowCount: 1, truncated: false };
  });
  const pool = fakePool();
  const ctx = { ...turn({ threadRootId: 900 }), ownChatWithBot: CONVERSATION };
  const sql = 'SELECT id, state FROM requests WHERE number = 6351';
  const out = await admin.run(pool, ctx, 'query_prod_db', { sql: `  ${sql}  ` });
  assert.deepEqual(asked, [{ sql, opts: { config: CONFIG } }]);
  assert.deepEqual(JSON.parse(out.result), { rowCount: 1, truncated: false, rows: [{ id: 3, state: 'open' }] });
  assert.ok(!pool.queries.some((q) => q.sql.includes('FROM requests')), 'the statement never reaches the main pool');
  assert.deepEqual(ctx.looked, [{ what: 'Read production\'s database' }]);
  assert.equal(debugAccess.ROLE, 'usernode_debug_ro');
  assert.match(read('src/services/debug-access.js'), /user: ROLE,/, 'runQuery\'s pool logs in as the role');
});

test('a statement touching a column outside READABLE_COLUMNS comes back refused, with nothing read', async (t) => {
  // What Postgres answers the role (prod-debug-grants-postgres.test.js holds
  // it against the real grants): no grant reaches a personal column.
  for (const [table, column] of [['users', 'email'], ['users', 'password'], ['requests', 'title'], ['requests', 'body'],
    ['homeroom_bot_runs', 'reason'], ['work_states', 'line'], ['conversation_messages', 'content']]) {
    const grants = debugAccess.buildGrantStatements([{ table, kind: 'r', columns: [column, 'id'] }]);
    assert.ok(!grants.some((g) => g.includes(`"${column}"`)), `${table}.${column} is never granted`);
  }
  swap(t, debugAccess, 'runQuery', async () => {
    const err = new Error('permission denied for table users');
    err.code = '42501';
    throw err;
  });
  const pool = fakePool();
  const ctx = { ...turn(), ownChatWithBot: CONVERSATION };
  const out = await admin.run(pool, ctx, 'query_prod_db', { sql: 'SELECT email FROM users' });
  assert.equal(out.ok, false);
  assert.match(out.error, /The read-only role refused it \(permission denied for table users\)/);
  assert.match(out.error, /Nothing was read\.$/);
  assert.equal(out.result, undefined);
  assert.equal(pool.audits[0].status, 'failed');
  assert.deepEqual(pool.audits[0].result, { ok: false, code: '42501' });
});

test('the role being unavailable, an empty statement and an over-long one run nothing', async (t) => {
  swap(t, debugAccess, 'runQuery', async () => {
    const err = new Error('prod-debug role not set up yet');
    err.code = 'unavailable';
    throw err;
  });
  const ctx = { ...turn(), ownChatWithBot: CONVERSATION };
  const off = await admin.run(fakePool(), ctx, 'query_prod_db', { sql: 'SELECT 1' });
  assert.deepEqual(off, { ok: false, error: 'Production debugging is not available right now. Nothing was read.' });
  for (const sql of ['', '   ', 'x'.repeat(4001), null]) {
    const pool = fakePool();
    const out = await admin.run(pool, ctx, 'query_prod_db', { sql });
    assert.equal(out.ok, false);
    assert.ok(!pool.queries.some((q) => /INSERT INTO homeroom_bot_admin_actions/.test(q.sql)), 'nothing recorded, nothing run');
  }
});

test('results are clipped the way the admin tools clip, and contact details in a value are masked', async (t) => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, repo_url: `https://example.invalid/fake-${i}`, note: 'fake.person@example.com' }));
  swap(t, debugAccess, 'runQuery', async () => ({ rows, rowCount: 500, truncated: false }));
  const out = await admin.run(fakePool(), { ...turn(), ownChatWithBot: CONVERSATION }, 'query_prod_db', { sql: 'SELECT 1' });
  assert.ok(out.result.length <= 12_000, 'at most MAX_RESULT_CHARS');
  assert.match(out.result, /cut at 12000 characters: ask for fewer rows or columns/);
  assert.doesNotMatch(out.result, /fake\.person@example\.com/);
  assert.match(out.result, /\[email\]/);
  assert.equal(admin.maskPersonal('call +44 20 7946 0000 from 203.0.113.9'), 'call [phone] from [ip]');
});

test('prod_status is the health snapshot, without the words people and agents wrote, contact details masked', async (t) => {
  const asked = [];
  swap(t, statusSvc, 'gather', async (config, opts) => {
    asked.push({ config, opts });
    return {
      summary: { stuckSessions: 1, workersInFlight: 2 },
      stuckSessions: [{ id: 5, appSlug: 'fake-app', username: 'ada', prTitle: 'Fake private title', sessionTitle: 'Fake' }],
      workers: [{ name: 'sv-worker-s5', lastProgress: 'Fake agent words', state: 'running' }],
      apps: [{ slug: 'fake-app', name: 'Fake App', sessions: [] }],
      events: [{ message: 'duplicate ring' }],
    };
  });
  swap(t, log, 'tail', () => [{ level: 'info', tag: 'mail', message: 'Sent to fake.person@example.com from 198.51.100.7' }]);
  const out = await admin.run(fakePool(), { ...turn(), ownChatWithBot: CONVERSATION }, 'prod_status', {});
  assert.deepEqual(asked, [{ config: CONFIG, opts: { isAdmin: true } }]);
  const snapshot = JSON.parse(out.result);
  assert.deepEqual(snapshot.summary, { stuckSessions: 1, workersInFlight: 2 });
  assert.deepEqual(snapshot.stuckSessions, [{ id: 5, appSlug: 'fake-app', username: 'ada' }], 'titles left out');
  assert.deepEqual(snapshot.workers, [{ name: 'sv-worker-s5', state: 'running' }], 'an agent\'s progress line left out');
  assert.equal(snapshot.apps, undefined, 'the per-app tree is left out');
  assert.equal(snapshot.events, undefined, 'the log ring is given once');
  assert.equal(snapshot.recentLog[0].message, 'Sent to [email] from [ip]');
  // Too long, the log ring goes first.
  const big = admin.statusForModel({ summary: {} }, Array.from({ length: 400 }, (_, i) => ({ message: `line ${i} `.repeat(10) })));
  assert.ok(big.length <= 12_000);
  assert.deepEqual(JSON.parse(big).recentLog, []);
});

// ── The allowlist guard ─────────────────────────────────────────────────

// Named like personal data: a contact detail or identifier, anything that
// signs somebody in, or text people write. Matched as whole words of the
// column's name, so `username` (the one identifier the role reads) is one
// word and passes.
const PERSONAL_WORD = /^(e?mails?|phones?|ips?|address(es)?|names?|token|passwords?|contents?|bod(y|ies)|titles?|texts?)$/;
// Reviewed exceptions, each a platform-made name rather than a person's.
const NAMED_BY_THE_PLATFORM = Object.freeze({
  'apps.runtime_name': 'the workload name the platform gives an app (sv-app-<id>-<slug>)',
  'chat_sessions.branch_name': 'the git branch the platform names for a change',
});

test('no column in READABLE_COLUMNS is named like personal data', () => {
  const flagged = [];
  for (const [table, columns] of Object.entries(debugAccess.READABLE_COLUMNS)) {
    for (const column of columns) {
      const key = `${table}.${column}`;
      if (Object.hasOwn(NAMED_BY_THE_PLATFORM, key)) continue;
      const words = column.split('_');
      if (words.some((w) => PERSONAL_WORD.test(w))) flagged.push(key);
      // `tokens` is a count of a model's tokens, never a credential: allowed
      // only as a number.
      if (words.includes('tokens')) {
        assert.match(schema[key].type, /^(integer|bigint|smallint|numeric)/, `${key} must be a count`);
      }
    }
  }
  assert.deepEqual(flagged, [], 'a column named like personal data is never readable');
  for (const key of Object.keys(NAMED_BY_THE_PLATFORM)) {
    const [table, column] = key.split('.');
    assert.ok(debugAccess.READABLE_COLUMNS[table]?.includes(column), `${key} is still on the list, or its exception goes`);
  }
  // The guard catches what it is for.
  for (const column of ['email', 'phone_number', 'last_ip', 'home_address', 'real_name', 'push_token', 'password',
    'content', 'body', 'title', 'text', 'display_name']) {
    assert.ok(column.split('_').some((w) => PERSONAL_WORD.test(w)), `${column} would be caught`);
  }
});

test('the bot\'s own tables are on the list without their words, and every column has a reviewed type', () => {
  const R = debugAccess.READABLE_COLUMNS;
  assert.ok(R.homeroom_bot_queue.includes('held_until') && R.homeroom_bot_queue.includes('held_reason'));
  assert.ok(R.work_states.includes('stage'));
  assert.ok(R.requests.includes('state') && R.requests.includes('number'));
  const words = {
    requests: ['title', 'body', 'labels', 'author_login'],
    homeroom_bot_runs: ['reason', 'question', 'question_default', 'missing_fact', 'build_note', 'error', 'build_error',
      'build_spec_md', 'build_spec_html', 'first_step', 'plan_change', 'plan', 'review', 'builder', 'rating_note'],
    work_states: ['line'],
  };
  for (const [table, columns] of Object.entries(words)) {
    for (const column of columns) assert.ok(!R[table].includes(column), `${table}.${column} stays unreadable`);
  }
  for (const [table, columns] of Object.entries(R)) {
    for (const column of columns) assert.ok(schema[`${table}.${column}`], `${table}.${column} has a reviewed definition`);
  }
  assert.equal(Object.values(R).flat().length, Object.keys(schema).length, 'no reviewed definition is left over');
});

// ── Audit ───────────────────────────────────────────────────────────────

test('every call writes one audit row and one log line before it runs', async (t) => {
  const events = [];
  const lines = [];
  const realInfo = log.info;
  swap(t, log, 'info', (tag, message, data) => {
    if (tag === 'prod-debug') { lines.push({ message, data }); events.push(`log:${message}`); }
    return realInfo.call(log, tag, message, data);
  });
  swap(t, debugAccess, 'runQuery', async () => { events.push('runQuery'); return { rows: [], rowCount: 0, truncated: false }; });
  swap(t, statusSvc, 'gather', async () => { events.push('gather'); return { summary: {} }; });
  const pool = fakePool({ events });
  const ctx = { ...turn({ threadRootId: 900 }), ownChatWithBot: CONVERSATION };
  const sql = 'SELECT stage FROM work_states WHERE item_ref = 6351';
  await admin.run(pool, ctx, 'query_prod_db', { sql });
  await admin.run(pool, ctx, 'prod_status', {});

  assert.equal(pool.audits.length, 2, 'one row per call');
  const [q, s] = pool.audits;
  assert.deepEqual({ user: q.user_id, conversation: q.conversation_id, root: q.thread_root_id, tool: q.tool_name, status: q.status },
    { user: 7, conversation: CONVERSATION, root: 900, tool: 'query_prod_db', status: 'done' });
  assert.deepEqual(confirmations.openAction(q.sealed_input, q.input_hash, CONFIG.dataEncryptionKey).input, { sql },
    'the SQL text is on the row, sealed');
  assert.deepEqual(q.result, { ok: true, rowCount: 0, truncated: false }, 'never the rows themselves');
  assert.equal(s.tool_name, 'prod_status');
  assert.equal(s.status, 'done');

  assert.equal(lines.length, 2, 'one log line per call');
  assert.equal(lines[0].message, 'Homeroom bot SQL query');
  assert.deepEqual({ ...lines[0].data, actionId: undefined }, {
    userId: 7, conversationId: CONVERSATION, threadRootId: 900, actionId: undefined, tool: 'query_prod_db', query: sql,
  });
  assert.equal(lines[0].data.actionId, q.id);
  assert.equal(lines[1].message, 'Homeroom bot status snapshot');

  const order = (e) => events.indexOf(e);
  assert.ok(order('log:Homeroom bot SQL query') < order('pool:INSERT INTO homeroom_bot_admin_actions'));
  assert.ok(order('pool:INSERT INTO homeroom_bot_admin_actions') < order('runQuery'), 'recorded before it runs');
  assert.ok(events.lastIndexOf('pool:INSERT INTO homeroom_bot_admin_actions') < order('gather'));
});

test('a call that cannot be recorded does not run, and a read row can never be confirmed', async (t) => {
  let ran = 0;
  swap(t, debugAccess, 'runQuery', async () => { ran += 1; return { rows: [], rowCount: 0, truncated: false }; });
  const pool = fakePool();
  const query = pool.query;
  pool.query = async (sql, values) => {
    if (/INSERT INTO homeroom_bot_admin_actions/.test(sql)) throw new Error('fake insert failure');
    return query.call(pool, sql, values);
  };
  const out = await admin.run(pool, { ...turn(), ownChatWithBot: CONVERSATION }, 'query_prod_db', { sql: 'SELECT 1' });
  assert.deepEqual(out, { ok: false, error: 'I could not record this read, so I did not run it. Nothing was run.' });
  assert.equal(ran, 0);
  // The row starts `running`: confirmAction claims only `pending` rows.
  assert.match(read('src/services/homeroom-bot-thread-tools/admin.js'), /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, \$7, 'running', \$8, \$9\)/);
  assert.match(read('src/services/homeroom-bot-thread-tools/admin.js'), /AND status = 'pending' AND expires_at > NOW\(\)/);
});

// ── The card line ───────────────────────────────────────────────────────

function dmFake() {
  const sent = [];
  return {
    sent,
    async sendDm(pool, args) { sent.push(args); return { messageId: 100 + sent.length, conversationId: CONVERSATION }; },
  };
}

const APP = { id: 5, slug: 'fake-project', name: 'Fake Project' };
const FILE = { kind: 'file_request', app: APP, title: 'Add a fake thing', details: 'Fake details' };

test('after query_prod_db ran in a thread, a card there that posts somewhere public carries the line', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const audits = [{ user_id: 7, conversation_id: CONVERSATION, thread_root_id: 900, tool_name: 'query_prod_db', status: 'done' }];
  const offerIn = async ({ user = ADMIN, threadRootId, o = FILE, pool = fakePool({ audits }) }) => {
    const dm = dmFake();
    await mayor.offer(pool, {
      bot: BOT, user, conversationId: CONVERSATION, message: { id: 77, ...(threadRootId ? { threadRootId } : {}) },
      text: 'Fake words', offer: o, deps: { dmSvc: dm, ...(threadRootId ? { threadRootId } : {}) },
    });
    return { card: dm.sent.find((s) => s.metadata?.kind === 'confirm'), pool };
  };

  const inThread = await offerIn({ threadRootId: 900 });
  assert.equal(inThread.card.metadata.dbRead, true, 'a request to file, in the thread that read the database');
  const reply = await offerIn({ threadRootId: 900, o: { kind: 'post_reply', app: APP, issueNumber: 12, title: 'reply', details: 'Fake reply' } });
  assert.equal(reply.card.metadata.dbRead, true, 'a reply to post');
  const close = await offerIn({ threadRootId: 900, o: { kind: 'close_request', app: APP, issueNumber: 12, title: 'Fake', details: 'Fake why' } });
  assert.equal(close.card.metadata.dbRead, true, 'a close to propose');

  const elsewhere = await offerIn({ threadRootId: 901 });
  assert.equal(elsewhere.card.metadata.dbRead, undefined, 'a thread with no database read: no line');
  const main = await offerIn({ threadRootId: null });
  assert.equal(main.card.metadata.dbRead, undefined, 'Main, where nothing was read');

  // Read in Main, drafted from Main: the draft goes in a thread of its own and still says so.
  const fromMain = await offerIn({ threadRootId: null, pool: fakePool({ audits: [{ ...audits[0], thread_root_id: null }] }) });
  assert.equal(fromMain.card.metadata.dbRead, true);
  assert.equal(fromMain.card.threadRootId, 101, 'in the draft\'s own thread');

  // A failed read read nothing; a person who is not an admin never pays for the look.
  const failed = await offerIn({ threadRootId: 900, pool: fakePool({ audits: [{ ...audits[0], status: 'failed' }] }) });
  assert.equal(failed.card.metadata.dbRead, undefined);
  const member = await offerIn({ threadRootId: 900, user: { id: 7, username: 'sam' } });
  assert.equal(member.card.metadata.dbRead, undefined);
  assert.ok(!member.pool.queries.some((q) => /FROM homeroom_bot_admin_actions/.test(q.sql)));
});

test('a design plan card says it too, and the client draws the line only while the offer is open', async () => {
  assert.match(read('src/services/homeroom-bot-mayor.js'), /answers: designPlanAnswers\(n\), actions, status: 'open', mirrors: false, \.\.\.dbRead,/);
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.equal(catalog['bot.dbRead.note'].text,
    'A database read happened in this thread. Check this holds nothing private before you post it.');

  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, quoteInComposer() {}, scopeKey: () => 'k', setReply() {}, async tapBotAction() {} } },
  });
  const card = (meta) => ({
    id: 9, conversationId: CONVERSATION, content: 'words', createdAt: '2026-11-06T10:00:00Z', reactions: [], attachments: [], objects: [],
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: {
      homeroomBot: {
        kind: 'confirm', appSlug: 'fake-project', appName: 'Fake Project', actionId: 11, question: 'File this as a request on Fake Project?',
        answers: ['File it', 'Not now'],
        actions: [{ id: 'yes', label: 'File it', style: 'primary', type: 'server' }, { id: 'no', label: 'Not now', style: 'secondary', type: 'server' }],
        status: 'open', mirrors: false, ...meta,
      },
    },
  });
  const line = /data-bot-db-read="">.*A database read happened in this thread\. Check this holds nothing private before you post it\./;
  assert.match(renderToHtml(createElement(BotQuestion, { message: card({ dbRead: true }), conversationId: CONVERSATION })), line);
  assert.doesNotMatch(renderToHtml(createElement(BotQuestion, { message: card({}), conversationId: CONVERSATION })), /data-bot-db-read/);
  assert.doesNotMatch(renderToHtml(createElement(BotQuestion, {
    message: card({ dbRead: true, status: 'answered', answer: 'File it', chosen: 'yes' }), conversationId: CONVERSATION,
  })), /data-bot-db-read/, 'decided: the line has done its job');
  // The legacy answers-only offer draws it as well.
  assert.match(renderToHtml(createElement(BotQuestion, {
    message: card({ dbRead: true, actions: undefined }), conversationId: CONVERSATION,
  })), line);
});
