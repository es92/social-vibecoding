// The in-band connector setup hint.
//
// The problem: a user who never opens Settings → Connectors has no way to
// learn that the per-call permission prompts are fixable at all. The only
// channel this server has to a human is a tool result routed through the
// model — no MCP surface renders to a person directly — so the hint has to be
// phrased as an explicit instruction to relay, and the model has to have been
// told at initialize that such a block exists and is not app data.
//
// Everything below is about the ways that goes wrong quietly:
//
//   1. Attached to the wrong tool. On a write it arrives as a change reaches
//      a group vote; on prepare_work it sits beside a work order the model
//      was told to reproduce character for character. Eligibility is derived
//      from the read-only naming contract so it cannot drift onto one.
//   2. Attached the wrong way. Eight read tools declare eight outputSchemas
//      and the SDK validates structuredContent against them, so the hint
//      rides as a second content block — which only works if the SDK accepts
//      an extra block, verified here against a real round trip rather than
//      assumed.
//   3. Shown too often, or — as shipped — not at all. /mcp is stateless, so
//      "once per session" cannot be expressed directly. The first version
//      keyed on the ACCESS TOKEN, which one hour of conversations shares, so
//      the first eligible read consumed the only slot and the connector went
//      quiet forever; production held exactly one row. The throttle is now
//      armed by `initialize` and bounded by a cooldown and a rolling weekly
//      budget, and section 5 below is about both failure directions.
//
// Run with: node --test tests/connector-setup-hint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/mcp-tools');
const throttle = require('../src/services/mcp-hint-throttle');
const constants = require('../src/services/mcp-connect-constants');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const REMOTE_SRC = read('src/routes/mcp-remote.js');
const SCHEMA_SQL = read('src/db/schema.sql');

const ORIGIN = 'https://usernode.example';

// ── 1. The model is told the block exists ──────────────────────────────

test('the initialize instructions set up the relay', () => {
  // Without this the hint is an unexplained block in a tool result, which a
  // model can reasonably read as noise and drop — and then nobody is reached
  // at all, which is the failure the whole feature exists to avoid.
  const instructions = tools.SERVER_INSTRUCTIONS;
  assert.match(instructions, /Homeroom setup tip/);
  assert.match(instructions, /relay it once/i);
  // It says the block is NOT untrusted content, because every other line of
  // these instructions says the opposite about everything else returned.
  assert.match(instructions, /never in <untrusted-content> tags/);
  // The longer form — including what the block is NOT — is in the charter.
  // The client cuts `instructions` at 2048 chars, so this clause is delivered
  // twice at two lengths rather than once at the length it would like to be.
  assert.match(require('../src/services/mcp-charter').CHARTER_FULL,
    /not data about their apps/);
});

test('the marker in the instructions is the marker the hint actually uses', () => {
  // Two literals, in two files, that only work if identical.
  assert.ok(tools.buildSetupHint(ORIGIN).startsWith('Homeroom setup tip'));
  assert.match(tools.SERVER_INSTRUCTIONS, /"Homeroom setup tip"/);
});

// ── 2. What the hint says ──────────────────────────────────────────────

test('the hint carries the shipped rules, from the shipped constant', () => {
  const hint = tools.buildSetupHint(ORIGIN);
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    assert.ok(hint.includes(`"${rule}"`), `${rule} is named in the hint`);
  }
  assert.match(hint, /permissions\.allow|"permissions\.allow"/);
  assert.match(hint, /~\/\.claude\/settings\.json/);
  assert.match(hint, /in every repo at once/);
});

test('the hint tells the model to correct the server segment itself', () => {
  // #1218's real failure was an account registered as `Uesrnode`, so every
  // rule Homeroom ships missed it silently. The server cannot see the name
  // the client built its tool names from; the model can. So the correction is
  // delegated to the only party in the exchange that knows.
  const hint = tools.buildSetupHint(ORIGIN);
  assert.match(hint, /substitute the server\s+segment you can actually see/);
  assert.match(hint, /names the server literally/);
  assert.match(hint, /matches nothing, with no error/);
});

test('the hint does not oversell what it turns off', () => {
  const hint = tools.buildSetupHint(ORIGIN);
  assert.match(hint, /still ask every time, by design/);
  assert.ok(hint.includes(`${ORIGIN}/#settings/connectors`),
    'it deep-links the page that has the copy button');
});

test('the hint is not wrapped as untrusted content', () => {
  // It is platform-authored and meant to be acted on — the same reasoning as
  // get_platform_conventions' preamble. Wrapping it would tell the model to
  // treat an instruction to relay as data not to follow.
  assert.doesNotMatch(tools.buildSetupHint(ORIGIN), /<untrusted-content>/);
});

// ── 3. Which tools carry it ────────────────────────────────────────────

test('eligibility is DERIVED from the read-only naming contract', () => {
  // Not a hand-kept list: a new get_*/list_* tool carries the hint with no
  // extra edit, and a tool renamed to something that acts stops carrying it
  // in the same edit that renames it.
  for (const name of ['get_app', 'get_proposal', 'get_request', 'list_apps',
                      'list_requests', 'get_platform_build',
                      'get_platform_conventions', 'list_my_proposals', 'whoami']) {
    assert.equal(tools.isHintEligibleTool(name), true, `${name} is a read`);
  }
  for (const name of tools.ACTING_TOOLS) {
    assert.equal(tools.isHintEligibleTool(name), false, `${name} acts`);
  }
  // answer_questions is a write that is deliberately NOT in ACTING_TOOLS, so
  // assert it separately or it slips through both lists.
  assert.equal(tools.isHintEligibleTool('answer_questions'), false);
  assert.equal(tools.isHintEligibleTool(''), false);
  assert.equal(tools.isHintEligibleTool(undefined), false);
});

test('every read tool returns through readResult and no others do', () => {
  // The wiring itself, since eligibility is only consulted on the path that
  // asks for it. Everything that acts must still return plain toolResult().
  const hinted = [...TOOLS_SRC.matchAll(/return readResult\('([a-z_]+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(hinted)].sort(), [
    'get_app', 'get_checkout_status', 'get_connector_guidance',
    'get_platform_build', 'get_platform_conventions', 'get_proposal',
    'get_request', 'list_apps', 'list_my_proposals', 'list_requests', 'whoami',
  ]);
  for (const name of hinted) {
    assert.equal(tools.isHintEligibleTool(name), true);
  }

  // And the acting tools' handlers still return plain results.
  for (const name of [...tools.ACTING_TOOLS, 'answer_questions']) {
    const idx = TOOLS_SRC.indexOf(`server.registerTool('${name}'`);
    assert.ok(idx > 0, `${name} is registered`);
    const next = TOOLS_SRC.indexOf('server.registerTool(', idx + 10);
    const body = TOOLS_SRC.slice(idx, next > 0 ? next : undefined);
    assert.doesNotMatch(body, /readResult\(/,
      `${name} acts — it must not carry a setup tip`);
  }
});

test('prepare_work in particular never carries it', () => {
  // Its workOrder is reproduced character for character by the model. A
  // second block of platform prose next to it competes with that instruction
  // at the one moment precision matters most.
  const idx = TOOLS_SRC.indexOf("server.registerTool('prepare_work'");
  const next = TOOLS_SRC.indexOf('server.registerTool(', idx + 10);
  assert.doesNotMatch(TOOLS_SRC.slice(idx, next), /readResult|buildSetupHint/);
});

test('an error result never carries a hint', () => {
  // A failing call is not a teaching moment, and toolError is the shape every
  // failure goes through.
  const err = tools.toolError('no_access', 'nope');
  assert.equal(err.content.length, 1);
  assert.equal(err.isError, true);
  const src = TOOLS_SRC.slice(TOOLS_SRC.indexOf('function toolError('));
  assert.doesNotMatch(src.slice(0, src.indexOf('\n}')), /hint/);
});

// ── 4. The shape on the wire ───────────────────────────────────────────

test('the hint is a second content block, leaving structuredContent alone', () => {
  const structured = { a: 1, b: 'two' };
  const plain = tools.toolResult(structured);
  assert.equal(plain.content.length, 1);
  assert.deepEqual(plain.structuredContent, structured);

  const hinted = tools.toolResult(structured, 'Homeroom setup tip — hello');
  assert.equal(hinted.content.length, 2);
  assert.equal(hinted.content[1].type, 'text');
  assert.equal(hinted.content[1].text, 'Homeroom setup tip — hello');

  // The JSON block and the structured object are byte-identical either way:
  // a caller parsing content[0], and a caller reading structuredContent, both
  // see exactly what they saw before the hint existed.
  assert.equal(hinted.content[0].text, plain.content[0].text);
  assert.deepEqual(hinted.structuredContent, plain.structuredContent);
  assert.equal(JSON.stringify(hinted.structuredContent),
               JSON.stringify(plain.structuredContent));

  // A falsy hint adds nothing, so a refused throttle claim leaves the result
  // exactly as it was.
  for (const empty of [null, undefined, '']) {
    assert.equal(tools.toolResult(structured, empty).content.length, 1);
  }
});

test('the SDK accepts the extra block against a declared outputSchema', async () => {
  // The assumption the whole approach rests on, checked rather than assumed:
  // @modelcontextprotocol/sdk validates structuredContent against each tool's
  // outputSchema on both sides. If an extra content block tripped that
  // validation, the hint would have to move inside the first block instead.
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { z } = require('zod');

  const server = new McpServer({ name: 'usernode', version: '1.0.0' });
  const structured = { username: 'ada', scopes: ['usernode:apps:read'] };
  server.registerTool('get_thing', {
    title: 'thing', description: 'thing',
    inputSchema: {},
    outputSchema: { username: z.string(), scopes: z.array(z.string()) },
  }, async () => tools.toolResult(structured, tools.buildSetupHint(ORIGIN)));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({ name: 'get_thing', arguments: {} });
  assert.ok(!res.isError, 'the extra block does not fail output validation');
  assert.equal(res.content.length, 2);
  assert.deepEqual(res.structuredContent, structured);
  assert.deepEqual(JSON.parse(res.content[0].text), structured);
  assert.ok(res.content[1].text.startsWith('Homeroom setup tip'));

  await client.close();
  await server.close();
});

// ── 5. The throttle ────────────────────────────────────────────────────

test('the client suppression covers the surfaces with no prompts to stop', () => {
  for (const name of ['ChatGPT', 'chatgpt.com', 'OpenAI', 'Codex CLI', 'openai codex']) {
    assert.equal(tools.hintSuppressedForClient(name), true, `${name} is suppressed`);
  }
  for (const name of ['Claude', 'claude.ai', 'Claude Code', 'Unknown client', '', null]) {
    assert.equal(tools.hintSuppressedForClient(name), false, `${name} is not suppressed`);
  }
});

// A pool that records what it was asked and answers with whatever the test
// queued. The claim is one atomic statement by design, so "did it return a
// row" is the entire contract.
function fakePool(responses) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

const THROTTLE_SRC = read('src/services/mcp-hint-throttle.js');

// The claim statement's WHERE, isolated. Every grant/refuse rule lives in
// SQL rather than in JS, so this is the thing under test in most of what
// follows and pulling it out once keeps each assertion about one rule.
const CLAIM_SQL = THROTTLE_SRC.slice(
  THROTTLE_SRC.indexOf('async function claimHintShow'),
  THROTTLE_SRC.indexOf('async function getHintStatus')
);

test('each exported function is one atomic statement against one table', () => {
  // Two reads racing on the same grant must not both win the slot, which
  // rules out read-then-write. Three exported functions, three statements —
  // not "one query in the module", which is what this asserted when claiming
  // was the only thing the module did.
  assert.equal((THROTTLE_SRC.match(/pool\.query\(/g) || []).length, 3);
  for (const fn of ['armHint', 'claimHintShow', 'getHintStatus']) {
    assert.equal(typeof throttle[fn], 'function', `${fn} is exported`);
  }
  assert.match(CLAIM_SQL, /ON CONFLICT \(grant_id\) DO UPDATE/);
  assert.match(CLAIM_SQL, /RETURNING shown_count/);
  const tables = [...THROTTLE_SRC.matchAll(/(?:INSERT INTO|UPDATE|FROM)\s+([a-z_]+)/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['mcp_connector_hints']);
});

test('the claim does NOT key on the access token — that was the bug', () => {
  // The regression this file exists to prevent from coming back. One hourly
  // access token serves every conversation opened in that hour, so refusing a
  // claim when the token matches the last one means the FIRST eligible read
  // after connecting spends the only slot and every conversation afterwards
  // gets nothing. In production that produced exactly one row, ever.
  assert.doesNotMatch(CLAIM_SQL, /last_token_id IS DISTINCT FROM/);
  // It is still WRITTEN — a diagnostic column — but never read by the guard.
  const where = CLAIM_SQL.slice(CLAIM_SQL.indexOf('WHERE ('), CLAIM_SQL.indexOf('RETURNING'));
  assert.match(CLAIM_SQL, /last_token_id = EXCLUDED\.last_token_id/);
  assert.doesNotMatch(where, /last_token_id/);
});

test('the conditions on a claim are ANDed, not offered as alternatives', () => {
  const where = CLAIM_SQL.slice(CLAIM_SQL.indexOf('WHERE ('), CLAIM_SQL.indexOf('RETURNING'));
  // 1. shown_count = 0 — the row armHint just created. Load-bearing because
  //    last_shown_at is NOT NULL DEFAULT NOW(), so that row looks "just
  //    shown" and a cooldown check alone would refuse its first tip for an
  //    hour. It is the escape hatch on BOTH bounds, hence twice.
  assert.equal((where.match(/mcp_connector_hints\.shown_count = 0/g) || []).length, 2);
  // 2. armed since the last showing — a new session began.
  assert.match(where, /mcp_connector_hints\.armed_at > mcp_connector_hints\.last_shown_at/);
  // 3. the cooldown elapsed.
  assert.match(where, /mcp_connector_hints\.last_shown_at < NOW\(\) - \$5::interval/);

  // And the shape, which is the whole fix. The version before this one wrote
  // arming and the cooldown as an OR, so arming — the one thing a client does
  // freely, and more than once per human conversation — was a route to a
  // claim that skipped the cooldown entirely. Production spent a grant's
  // whole weekly budget of three inside fourteen minutes and then went silent
  // for six days. An OR here is that bug, so match the AND explicitly.
  assert.match(
    where,
    /armed_at > mcp_connector_hints\.last_shown_at\)\s*\n?\s*AND \(/,
    'arming and the cooldown are ANDed — an OR lets a re-connect spend a slot'
  );
  assert.match(
    where,
    /last_shown_at < NOW\(\) - \$5::interval\)\s*\n?\s*AND \(/,
    'and the weekly budget is ANDed onto both'
  );
});

test('a re-arm inside the cooldown is refused by the statement, not by the caller', async () => {
  // The guard is one atomic statement, so "refused" is the absence of a
  // returned row — there is no branch in JavaScript to test instead. What
  // this pins is that the caller reads that absence as a refusal and shows
  // nothing, which is what a reconnect two minutes into a session produces
  // now and did not before.
  const pool = fakePool([[]]);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 100,
  }), false);
  assert.equal(pool.calls.length, 1, 'and it does not retry around the guard');
  assert.equal(pool.calls[0].params[4], throttle.HINT_COOLDOWN,
    'the cooldown the statement was given is the shipped constant');
});

test('showing consumes the arm, so one initialize buys one tip', () => {
  // Without this, every read in an armed session would claim: armed_at would
  // stay ahead of last_shown_at until the next initialize.
  assert.match(CLAIM_SQL, /armed_at = NULL/);
});

test('the budget is a rolling window, not a lifetime cap', () => {
  // The lifetime cap had no reset path: a grant that spent three showings
  // went quiet for the remaining life of a 30-day refresh chain, and there
  // was nothing in the product to undo it.
  assert.equal(throttle.MAX_SHOWS_PER_WINDOW, 3);
  assert.equal(throttle.HINT_WINDOW, '7 days');
  assert.equal(throttle.HINT_WINDOW_DAYS, 7);
  assert.equal(throttle.HINT_COOLDOWN, '60 minutes');
  assert.equal(throttle.HINT_COOLDOWN_MINUTES, 60);
  assert.equal(throttle.MAX_SHOWS_PER_GRANT, undefined, 'the lifetime cap is gone');
  // The window rolls forward inside the same statement that claims, so no
  // second write and no scheduled job is needed to refill it.
  assert.match(CLAIM_SQL, /window_started_at = CASE/);
  assert.match(CLAIM_SQL, /shown_count = CASE/);
  const where = CLAIM_SQL.slice(CLAIM_SQL.indexOf('WHERE ('), CLAIM_SQL.indexOf('RETURNING'));
  assert.match(where, /window_started_at < NOW\(\) - \$4::interval\s*\n?\s*OR mcp_connector_hints\.shown_count < \$6/);
});

test('a returned row is a granted claim, no row is a refusal', async () => {
  const pool = fakePool([[{ shown_count: 1 }], []]);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 100,
  }), true);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 100,
  }), false, 'the statement refused it, so the caller shows nothing');

  const { params } = pool.calls[0];
  assert.deepEqual(params, [
    'g1', 7, 100,
    throttle.HINT_WINDOW, throttle.HINT_COOLDOWN, throttle.MAX_SHOWS_PER_WINDOW,
  ]);
});

test('a granted claim is logged at info, not only failures', () => {
  // The first version logged only failures, so "never granted" and "granted
  // every time" looked identical in production — which is why the bug above
  // survived as long as it did. A grant is rare by construction (at most
  // three per connection per week), so this is not chatty.
  const granted = CLAIM_SQL.slice(CLAIM_SQL.indexOf('if (!rows.length) return false;'));
  assert.match(granted, /log\.info\('mcp-hint-throttle'/);
  assert.match(granted, /shownCount: rows\[0\]\.shown_count/);
});

// ── 5b. Arming ─────────────────────────────────────────────────────────

test('arming inserts shown_count 0, never 1', async () => {
  // The subtle one. last_shown_at is NOT NULL DEFAULT NOW(), so a row created
  // by the arm path looks like it was shown this instant. shown_count = 0 is
  // what tells the claim guard the difference, and writing 1 here would make
  // a freshly armed connection wait out the whole cooldown for its first tip.
  const arm = THROTTLE_SRC.slice(
    THROTTLE_SRC.indexOf('async function armHint'),
    THROTTLE_SRC.indexOf('// ── Claim')
  );
  assert.match(arm, /VALUES \(\$1, \$2, 0, NOW\(\)\)/);
  assert.match(arm, /ON CONFLICT \(grant_id\) DO UPDATE\s*\n?\s*SET armed_at = NOW\(\)/);
  // And nothing else: arming records intent, it does not show anything.
  assert.doesNotMatch(arm, /shown_count = /);
  assert.doesNotMatch(arm, /last_shown_at/);

  const pool = fakePool([[{ shown_count: 0 }]]);
  assert.equal(await throttle.armHint(pool, { grantId: 'g1', userId: 7 }), true);
  assert.deepEqual(pool.calls[0].params, ['g1', 7]);
});

test('a missing grant, user or pool refuses without touching the database', async () => {
  const pool = fakePool([[{ shown_count: 1 }]]);
  assert.equal(await throttle.claimHintShow(pool, { grantId: null, userId: 7 }), false);
  assert.equal(await throttle.claimHintShow(pool, { grantId: 'g', userId: null }), false);
  assert.equal(await throttle.claimHintShow(null, { grantId: 'g', userId: 7 }), false);
  assert.equal(await throttle.armHint(pool, { grantId: null, userId: 7 }), false);
  assert.equal(await throttle.armHint(pool, { grantId: 'g', userId: null }), false);
  assert.equal(await throttle.armHint(null, { grantId: 'g', userId: 7 }), false);
  assert.equal(pool.calls.length, 0);
});

test('a failed claim or arm costs a tip, never the result', async () => {
  // The table is advisory. A read that worked must not become an error
  // because a hint could not be booked — the same posture as the
  // fire-and-forget last_used_at update at the /mcp edge.
  const boom = () => new Error('relation "mcp_connector_hints" does not exist');
  assert.equal(await throttle.claimHintShow(fakePool([boom()]), {
    grantId: 'g1', userId: 7, tokenId: 1,
  }), false);
  assert.equal(await throttle.armHint(fakePool([boom()]), {
    grantId: 'g1', userId: 7,
  }), false);
});

// ── 5c. The status read ────────────────────────────────────────────────

test('the status read is read-only, and reports the budget it is bounded by', async () => {
  const status = THROTTLE_SRC.slice(THROTTLE_SRC.indexOf('async function getHintStatus'));
  assert.match(status, /SELECT/);
  assert.doesNotMatch(status, /INSERT|UPDATE |DELETE/,
    'nothing the Settings panel calls may write throttle state');

  const pool = fakePool([[{ shown_this_window: 2, last_shown_at: '2026-08-14T04:21:42.000Z' }]]);
  assert.deepEqual(await throttle.getHintStatus(pool, { userId: 7 }), {
    shownThisWindow: 2,
    lastShownAt: '2026-08-14T04:21:42.000Z',
    maxPerWindow: throttle.MAX_SHOWS_PER_WINDOW,
    windowDays: throttle.HINT_WINDOW_DAYS,
    // Reported so the panel can say "not before <time>" without keeping its
    // own copy of a number this module owns.
    cooldownMinutes: throttle.HINT_COOLDOWN_MINUTES,
  });
  assert.deepEqual(pool.calls[0].params, [7, throttle.HINT_WINDOW]);
});

test('an unreadable status does not take the connector list down with it', async () => {
  // It rides on GET /api/me/connectors, whose point is the list. A status
  // line that cannot be read is one missing line, not a 503.
  const empty = {
    shownThisWindow: 0, lastShownAt: null,
    maxPerWindow: throttle.MAX_SHOWS_PER_WINDOW, windowDays: throttle.HINT_WINDOW_DAYS,
    cooldownMinutes: throttle.HINT_COOLDOWN_MINUTES,
  };
  assert.deepEqual(await throttle.getHintStatus(fakePool([new Error('nope')]), { userId: 7 }), empty);
  assert.deepEqual(await throttle.getHintStatus(null, { userId: 7 }), empty);
  assert.deepEqual(await throttle.getHintStatus(fakePool([[]]), { userId: 7 }), empty);
});

// ── 5d. Arming happens at the /mcp edge, on initialize ─────────────────

test('initialize is detected in the body, batches included', () => {
  const { isInitializeRequest } = require('../src/routes/mcp-remote');
  assert.equal(isInitializeRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }), true);
  // A JSON-RPC batch arrives as an array; one arm per request either way.
  assert.equal(isInitializeRequest([
    { method: 'tools/list' }, { method: 'initialize' },
  ]), true);
  for (const body of [
    { method: 'tools/call', params: { name: 'whoami' } },
    { method: 'tools/list' },
    [{ method: 'tools/call' }],
    [], {}, null, undefined, 'initialize', 42,
  ]) {
    assert.equal(isInitializeRequest(body), false,
      `${JSON.stringify(body)} is not a session opening`);
  }
});

test('the arm is placed after authentication and the audit insert', () => {
  // It writes a row keyed on a grant, so an unauthenticated caller must not be
  // able to write one — and the audit is the platform's rule that an
  // authorization it cannot record is one it does not grant.
  const handler = REMOTE_SRC.slice(
    REMOTE_SRC.indexOf('router.post(MCP_PATH, jsonBody('),
    REMOTE_SRC.indexOf('router.all(MCP_PATH,')
  );
  const authAt = handler.indexOf('auth = await authenticateConnector');
  const auditAt = handler.indexOf("eventType: 'token_used'");
  const armAt = handler.indexOf('.armHint(pool,');
  const dispatchAt = handler.indexOf('mcpTools.registerTools(server, {');
  assert.ok(authAt > 0 && auditAt > authAt, 'the audit still follows authentication');
  assert.ok(armAt > auditAt, 'the arm follows the audit insert');
  assert.ok(armAt < dispatchAt, 'and precedes the dispatch it is arming for');
  // Reads the already-parsed body rather than the stream, so it observes the
  // same object handleRequest is handed a few lines later.
  assert.match(handler, /isInitializeRequest\(req\.body\)/);
});

test('a suppressed client is never armed, and a failed arm never fails the request', () => {
  const handler = REMOTE_SRC.slice(
    REMOTE_SRC.indexOf('router.post(MCP_PATH, jsonBody('),
    REMOTE_SRC.indexOf('router.all(MCP_PATH,')
  );
  const arm = handler.slice(handler.indexOf('if (isInitializeRequest(req.body)'));
  assert.match(arm, /!mcpTools\.hintSuppressedForClient\(auth\.clientName\)/,
    'ChatGPT/Codex connections write no row at all');
  // Fire-and-forget with the rejection swallowed and logged: an advisory tip
  // must not delay or fail a working request. No `await` on this call.
  assert.match(arm.slice(0, arm.indexOf('let transport')), /\.catch\(\(err\) => \{/);
  assert.doesNotMatch(arm.slice(0, arm.indexOf('let transport')), /await[\s\S]{0,40}armHint/);
});

test('the per-request memo means one claim however many reads run', () => {
  // registerTools runs once per HTTP request (the transport is stateless), so
  // memoising the promise on that closure is what bounds it. It also keeps
  // initialize and tools/list from burning the slot: nothing is claimed until
  // a read handler actually returns.
  const start = TOOLS_SRC.indexOf('const claimSetupHint = () => {');
  assert.ok(start > 0);
  const body = TOOLS_SRC.slice(start, TOOLS_SRC.indexOf('\n  };', start));
  assert.match(body, /if \(hintClaim\) return hintClaim;/);
  assert.match(body, /hintClaim = \(async \(\) => \{/);
  assert.match(body, /hintSuppressedForClient\(clientName\)/);
});

test('the throttle keys are threaded in from the authenticated token', () => {
  // There is no MCP session id to key on — sessionIdGenerator is undefined —
  // so the token and the grant are the two durable stand-ins, and they have
  // to reach registerTools for any of this to work.
  assert.match(REMOTE_SRC, /sessionIdGenerator: undefined/);
  const start = REMOTE_SRC.indexOf('mcpTools.registerTools(server, {');
  const ctx = REMOTE_SRC.slice(start, REMOTE_SRC.indexOf('});', start));
  assert.match(ctx, /tokenId: auth\.tokenId/);
  assert.match(ctx, /grantId: auth\.grantId/);
});

// ── 6. End to end through registerTools ────────────────────────────────

// A pool that answers both queries a whoami round trip makes: the github-link
// lookup, and the hint claim. Routed by statement text so the order of the two
// does not matter.
function wiringPool({ claimGranted }) {
  const claims = [];
  return {
    claims,
    async query(text, params) {
      if (/mcp_connector_hints/.test(text)) {
        claims.push(params);
        return { rows: claimGranted() ? [{ shown_count: claims.length }] : [] };
      }
      return { rows: [{ github_login: null, github_linked_at: null }] };
    },
  };
}

// registerTools takes an McpServer; all this needs is the handlers it hands
// over, so a recorder standing in for one keeps the loopback stack out of it.
function collectTools(ctx) {
  const handlers = new Map();
  const server = {
    registerTool(name, _spec, handler) { handlers.set(name, handler); },
  };
  tools.registerTools(server, {
    accessToken: 'svmcp_test', scopes: [constants.READ_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: ctx.pool, config: {}, tokenId: ctx.tokenId, grantId: ctx.grantId,
  });
  return handlers;
}

test('a read tool really does emit the hint, once per request', async () => {
  const pool = wiringPool({ claimGranted: () => true });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });

  const first = await handlers.get('whoami')({});
  assert.equal(first.content.length, 2, 'the hint rides along on the read');
  assert.ok(first.content[1].text.startsWith('Homeroom setup tip'));
  assert.equal(first.structuredContent.username, 'ada');

  // Same request (same registerTools closure): the memo spends one slot even
  // if the model calls two reads before the response is written.
  const second = await handlers.get('whoami')({});
  assert.equal(second.content.length, 2, 'the memoised hint is the same one');
  assert.equal(pool.claims.length, 1, 'exactly one claim per HTTP request');
});

test('a refused claim leaves the read exactly as it was', async () => {
  const pool = wiringPool({ claimGranted: () => false });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });
  const res = await handlers.get('whoami')({});
  assert.equal(res.content.length, 1);
  assert.equal(res.structuredContent.username, 'ada');
});

test('a suppressed client never even asks for a slot', async () => {
  const pool = wiringPool({ claimGranted: () => true });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });
  // Re-register with a ChatGPT client name.
  const chatgpt = new Map();
  tools.registerTools({
    registerTool(name, _spec, handler) { chatgpt.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [constants.READ_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'ChatGPT', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: 100, grantId: 'g1',
  });
  const res = await chatgpt.get('whoami')({});
  assert.equal(res.content.length, 1);
  assert.equal(pool.claims.length, 0, 'no row is written for a suppressed client');
  assert.ok(handlers.size > 0);
});

// ── 7. The table ───────────────────────────────────────────────────────

test('the throttle table is declared and kept out of staging', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS mcp_connector_hints/);
  const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS mcp_connector_hints');
  const ddl = SCHEMA_SQL.slice(start, SCHEMA_SQL.indexOf(');', start));
  assert.match(ddl, /grant_id\s+TEXT PRIMARY KEY/);
  assert.match(ddl, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(ddl, /shown_count\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(ddl, /last_token_id BIGINT/);
  // Same treatment as every other mcp_* table: connector state does not get
  // copied into a staging container.
  assert.match(SCHEMA_SQL, /COMMENT ON TABLE mcp_connector_hints IS 'staging:private'/);
});
