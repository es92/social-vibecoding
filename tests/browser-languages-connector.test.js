'use strict';

// get_browser_languages (#3659): a full admin's connector reads which
// languages people's browsers ask Homeroom for, to choose the languages
// frontend/locales/config.json ships, and where the translation step stands.
// The count is the console's (/api/admin/analytics/browser-languages); the
// connector reaches it through a route outside /api/admin, which no connector
// token may call, behind the same full-admin gate as the other admin tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');
const policy = require('../src/services/cli-api-policy');
const runner = require('../src/services/language-sync-runner');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function register(user) {
  const handlers = new Map();
  const specs = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user, clientName: 'Claude Code', clientId: 'c1',
    origin: 'https://homeroom.example', baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: 1, grantId: null, delegation: null,
  });
  return { specs, handlers };
}

test('a full admin reads the browser languages and the translation step through the connector', async (t) => {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        days: 30,
        people: 120,
        languages: [{ language: 'id-ID', people: 70 }, { language: 'en-US', people: 40 }, { language: 'es', people: 10 }],
        translation: { enabled: true, batch: null, lastPass: null, coverage: { id: { translated: 9700, total: 9759, ships: true } } },
      }),
    };
  };
  t.after(() => { global.fetch = real; });
  const { specs, handlers } = register({ id: 1, username: 'evan', isAdmin: true, canAdminWrite: true });
  assert.match(specs.get('get_browser_languages').description, /^Admin only\./);
  assert.ok(specs.get('get_browser_languages').description.length <= 1800);
  const out = await handlers.get('get_browser_languages')({ days: 30, includeAdmins: true });
  assert.equal(calls[0], 'http://platform.internal/api/browser-languages?days=30&includeAdmins=true');
  assert.deepEqual(out.structuredContent.languages[0], { language: 'id-ID', people: 70 });
  assert.equal(out.structuredContent.people, 120);
  assert.deepEqual(out.structuredContent.translation.coverage.id, { translated: 9700, total: 9759, ships: true });
});

test('nobody else is offered it, and the route is a full admin\'s read outside /api/admin', () => {
  for (const user of [{ id: 2, username: 'ann' }, { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false }]) {
    assert.ok(!register(user).specs.has('get_browser_languages'), user.username);
  }
  const route = read('src/routes/ui-telemetry.js');
  assert.match(route, /router\.get\('\/api\/browser-languages', requireAdminWrite, sameOriginBrowserOnly,/);
  assert.match(route, /translation: await languageSync\.status\(pool\)/);
  assert.ok(policy.CONNECTOR_ALLOWED_ROUTES.some((r) => r.method === 'GET' && r.pattern === '/api/browser-languages'));
});

test('the translation step\'s status names its batch, its last pass and each language\'s coverage', async () => {
  const pool = {
    async query(sql) {
      if (/platform_settings/.test(sql)) {
        return { rows: [{ value: JSON.stringify({ checkedDigest: 'b'.repeat(64), batch: { id: 'msgbatch_1', sourceDigest: 'b'.repeat(64), english: {}, submittedAt: '2026-10-10T00:00:00Z', messages: 9000 } }) }] };
      }
      return { rows: [] };
    },
  };
  const coverage = { id: { translated: 9700, total: 9759, ships: true } };
  assert.deepEqual(await runner.status(pool, { deps: { cache: { live: async () => ({ coverage }) } } }), {
    enabled: true,
    batch: { submittedAt: '2026-10-10T00:00:00Z', messages: 9000 },
    lastPass: null,
    coverage,
  });
  assert.match(tools.TOOL_DESCRIPTIONS?.get_browser_languages || read('src/services/mcp-tools.js'), /Translations are kept in that cache and served at once; none is put to a vote\./);
});
