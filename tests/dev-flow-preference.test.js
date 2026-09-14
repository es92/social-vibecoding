// The saved build-flow preference (#1049).
//
// "Remember my choice" on the dev-chat flow picker, and the same dropdown in
// Settings, write ONE nullable column: users.dev_flow_preference. Null is
// load-bearing — it means "ask me every time", which is the default and the
// only state in which the picker renders at all.
//
// Three layers, in the shape tests/user-locale.test.js established for the
// sibling `locale` preference:
//   1. Behavioural: POST /api/me/dev-flow mounted with a stubbed pool — the
//      three allowed flows persist, null / "" / a missing body clear it, a
//      value outside the allowlist is a 400 that never reaches the database,
//      and unauthenticated is a 401.
//   2. /api/auth/me round-trips the stored value, and reports whether the
//      external flows are offerable in this deployment at all.
//   3. Source guards down the rest of the chain: the column and its CHECK,
//      the Settings dropdown, and the two client surfaces that read the
//      preference (the dev-chat picker gate, and the "+" menu entry).
//
// The three-way agreement between DEV_FLOWS, the CHECK constraint and
// DevFlowSelect.FLOWS is pinned in tests/dev-flow-select.test.js.
//
// Run with: node --test tests/dev-flow-preference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes. `storedFlow` is what the
// /api/auth/me user lookup reports back, so the round-trip can be exercised
// without a database.
const poolMod = require('../src/db/pool');
let calls = [];
let storedFlow = null;
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      return { rows: [{ dev_flow_preference: storedFlow }] };
    }
    return { rows: [] };
  },
});

const { authRoutes, DEV_FLOWS } = require('../src/routes/auth');
const { shellMarkup } = require('./lib/shell-markup');

// With OAuth credentials configured the hand-off is offerable; the
// no-credentials case gets its own server below.
const LINKED_CONFIG = {
  jwtSecret: 'test-secret',
  githubLinkClientId: 'client-id',
  githubLinkClientSecret: 'client-secret',
};

let server, base, bareServer, bareBase;
let user = null;

async function mount(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes(config));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return [s, `http://127.0.0.1:${s.address().port}`];
}

test.before(async () => {
  [server, base] = await mount(LINKED_CONFIG);
  // A deployment with no GitHub OAuth credentials at all. The env can also
  // supply them, so they are cleared for the duration of this file.
  delete process.env.GITHUB_LINK_CLIENT_ID;
  delete process.env.GITHUB_LINK_CLIENT_SECRET;
  [bareServer, bareBase] = await mount({ jwtSecret: 'test-secret' });
});
test.after(() => {
  // closeAllConnections first: undici keeps the sockets alive, and a bare
  // close() would wait for them and hang the runner.
  for (const s of [server, bareServer]) {
    if (!s) continue;
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    s.close();
  }
});

test.beforeEach(() => {
  calls = [];
  storedFlow = null;
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body) => fetch(`${base}/api/me/dev-flow`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const flowUpdate = () => calls.find((c) => /UPDATE users SET dev_flow_preference/.test(c.sql));

// ── 1. POST /api/me/dev-flow behaviour ──────────────────────────────────

test('401 when not authenticated', async () => {
  user = null;
  const r = await post({ flow: 'codex' });
  assert.equal(r.status, 401);
  assert.equal(flowUpdate(), undefined, 'an anonymous caller must not write a row');
});

test('each allowed flow persists and is echoed back', async () => {
  for (const flow of DEV_FLOWS) {
    calls = [];
    const r = await post({ flow });
    assert.equal(r.status, 200, `expected 200 for ${flow}`);
    assert.deepEqual(await r.json(), { ok: true, flow });
    assert.deepEqual(flowUpdate().params, [flow, 42]);
  }
});

test('null, empty string and a missing body clear it back to "ask me"', async () => {
  // Unticking "remember my choice" sends null. Clearing has to be possible:
  // a preference you cannot un-save is a trap, and null is what makes the
  // picker come back.
  for (const cleared of [{ flow: null }, { flow: '' }, {}]) {
    calls = [];
    const r = await post(cleared);
    assert.equal(r.status, 200, `expected 200 for ${JSON.stringify(cleared)}`);
    assert.deepEqual(await r.json(), { ok: true, flow: null });
    assert.deepEqual(flowUpdate().params, [null, 42]);
  }
});

test('anything outside the allowlist is a 400 and never reaches the database', async () => {
  for (const bad of [
    'claude',            // close, but not the enum value
    'CODEX',             // the column's CHECK is case-sensitive
    'platform ',
    'external',          // a real agent value, but not a pickable flow
    'DROP TABLE users',
    123,
    true,
    ['codex'],
    { flow: 'codex' },
  ]) {
    calls = [];
    const r = await post({ flow: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(flowUpdate(), undefined, 'no UPDATE on invalid input');
    // The refusal names the values that would work.
    assert.match((await r.json()).error, /platform/);
  }
});

// ── 2. /api/auth/me ─────────────────────────────────────────────────────

test('/api/auth/me round-trips the stored preference', async () => {
  for (const flow of DEV_FLOWS) {
    storedFlow = flow;
    const j = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(j.user.devFlowPreference, flow);
  }
});

test('/api/auth/me reports null when unset', async () => {
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(j.user.devFlowPreference, null, 'unset means "ask me every time"');
});

test('a value the column should never hold is reported as null, not passed through', async () => {
  // Defence in depth: the CHECK constraint makes this unreachable through
  // the route, but the client branches on this string, and an unknown value
  // arriving there would suppress the picker while matching no flow — the
  // one state in which a user can pick nothing at all.
  storedFlow = 'something-else';
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(j.user.devFlowPreference, null);
});

test('/api/auth/me says whether the hand-off is offerable at all', async () => {
  const linked = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(linked.user.externalFlowsAvailable, true,
    'with GitHub OAuth configured, Claude Code / Codex can be offered');

  const bare = await (await fetch(`${bareBase}/api/auth/me`)).json();
  assert.equal(bare.user.externalFlowsAvailable, false,
    'with no GitHub credentials there is nothing to guide anyone through');
  // Still a real boolean, not a missing key the client would read as
  // undefined and render inconsistently.
  assert.equal(typeof bare.user.externalFlowsAvailable, 'boolean');
});

// ── 3. Chain source guards ──────────────────────────────────────────────

test('schema adds the nullable column and constrains its values', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT/);
  assert.match(schema, /users_dev_flow_preference_chk/,
    'the allowed values must be enforced in the database, not only in the route');
  assert.match(schema, /CHECK \(dev_flow_preference IS NULL/,
    'NULL must stay legal — it is the "ask me every time" default');
  // Re-runnable: schema.sql is applied on every boot.
  assert.match(schema, /DROP CONSTRAINT IF EXISTS users_dev_flow_preference_chk/);
});

test('Settings offers the same preference as a dropdown', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /_renderDevFlowSection/);
  assert.match(js, /_saveDevFlow/);
  assert.match(js, /\/api\/me\/dev-flow/);
  assert.match(js, /devFlowPreference/, 'the control renders from the /me value');

  // ── This assertion INVERTED, on purpose (#1191) ────────────────────
  //
  // It used to require that the block be INJECTED and that the dropdown NOT
  // appear in public/index.html. The reason was real at the time: the shell
  // body was a hand-written document frozen against a pre-migration fixture,
  // so a new settings control could only be added by
  // `document.createElement` at runtime. #1078 replaced that fixture with the
  // id/script baselines, and the Connections pane is a React component, so
  // the injection became a legacy module writing a node into a subtree React
  // owns — the one thing the ownership rule forbids.
  //
  // The block is markup now, its three ids are declared in
  // tests/shell-id-inventory.test.js's ADDED_IDS with that reason, and the
  // module keeps exactly what it keeps for every other control on the screen.
  const pane = read('frontend/src/features/settings/sections/connectors.tsx');
  assert.match(pane, /id="dev-flow-pref-section"/);
  assert.match(pane, /id="settings-dev-flow"/);
  assert.match(pane, /data-settings-section="connectors"/,
    'and it is in the Connections pane, where the flows it configures live');
  const html = shellMarkup();
  assert.ok(html.includes('id="settings-dev-flow"'),
    'so the dropdown IS in the prerendered document');
  assert.ok(html.indexOf('id="dev-flow-pref-section"') < html.indexOf('id="github-link-section"'),
    'above the GitHub block, where the injection put it — the preference reads '
    + 'as the question and the link below it as one of the answers');
  // Nothing builds it any more.
  const render = js.slice(js.indexOf('    _renderDevFlowSection() {'));
  assert.doesNotMatch(render.slice(0, 1400), /createElement|innerHTML|insertBefore/,
    'the renderer binds and reflects; it does not build');
});

test('Settings disables the hand-offs when the deployment cannot offer them', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /externalFlowsAvailable/,
    'a deployment with no GitHub link must not offer a preference it cannot honour');
});

test('the dev chat asks nothing at creation, and assumes nothing either', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /forcePicker/,
    'nothing re-asks at creation time — the venue dropdown is the door now');
  // #1353: and nothing ANSWERS for the user either. The saved default used
  // to turn any untouched session into a web hand-off before a word was
  // typed — while the venue derivation, which never read the preference,
  // went on telling the header and the sheet that the session was
  // On-Platform. One preference, two screens, and the only way back was per
  // tab. A hand-off is a choice made about THIS session now, through the
  // dropdown, and recorded on it (chat_sessions.build_venue).
  const target = devChat.match(/_devFlowTarget\(\) \{[\s\S]*?\n  \},/);
  assert.ok(target, '_devFlowTarget must exist');
  assert.doesNotMatch(target[0], /devFlowPreference/,
    'the walkthrough is not summoned by a standing preference');
  const venue = devChat.match(/_currentVenueId\(\) \{[\s\S]*?\n  \},/);
  assert.ok(venue, '_currentVenueId must exist');
  assert.doesNotMatch(venue[0], /devFlowPreference/,
    'nor does the venue the whole session paints from claim one');
});

test('the walkthrough appears exactly where the session says it is handed over', () => {
  // The gates this used to check — no PR, still active, nothing typed —
  // existed to keep a walkthrough summoned by a standing PREFERENCE from
  // landing on work already under way. With that door closed (#1353) the
  // walkthrough has one cause left: the venue this session is in, which is
  // a deliberate act and outranks all three of those states by design
  // (#1281 — a hand-off chosen halfway through a session is still a
  // hand-off). So the assertion is that there is ONE input, not four.
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  const fnStart = devChat.indexOf('_devFlowTarget() {');
  assert.ok(fnStart !== -1, '_devFlowTarget must exist');
  const fn = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fn, /DevChat\._currentVenueId\(\)/, 'the venue is the whole question');
  assert.match(fn, /'web-codex'/);
  assert.match(fn, /'web-claude-code'/);
  assert.doesNotMatch(fn, /pr_number|status !== 'active'|role === 'user'/,
    'no second set of gates to fall out of step with the header');
  // And the surface asks the same one thing, which is the invariant
  // tests/venue-surface-sync.test.js drives for real.
  const launchpad = devChat.match(/_launchpadVenue\(\) \{[\s\S]*?\n  \},/);
  assert.ok(launchpad, '_launchpadVenue must exist');
  assert.match(launchpad[0], /DevChat\._currentVenueId\(\)/);
});

test('the "+" menu asks nothing about venue', () => {
  // "Propose with Claude Code or Codex" sat one row under "Propose a
  // change" and meant the same thing, so the menu made the venue a fork in
  // the road before the work existed — and could only name two of six.
  const appView = read('public/js/app-view.js');
  assert.ok(!appView.includes('data-plus="proposal-external"'),
    'the second propose row is gone');
  assert.ok(!/createProposal\(\{ pickFlow: true \}\)/.test(appView),
    'and nothing re-opens a picker that no longer exists');
  // The one surviving programmatic entry is the out-of-credits card's, and
  // it stays: that user has been refused here, so a venue IS decided for
  // them.
  assert.match(appView, /createProposal\(\{ flow \}\)/,
    'the out-of-credits hand-off still opens its walkthrough directly');
});

test('the "+" menu is two named groups, not one flat list', () => {
  const appView = read('public/js/app-view.js');
  // #1084 chunk G converted the menu to JSX: the two headings are
  // <PlusMenuHeading> elements in the toolbar row now (actions-row.tsx, split
  // out of the board frame when the Workshop gained its own copy), not
  // AppView._plusMenuHeading() calls. #1490 moved New change to Improve and
  // left import alone in the first group; #1900 put File an issue back beside
  // it, so the group is "Add to the board" — what both rows do.
  const frame = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(frame, /label="Add to the board" groupKey="build" divider=\{false\}/);
  assert.match(frame, /label="Settings &amp; rules"[\s\S]{0,80}groupKey="settings"[\s\S]{0,40}divider/);
  // A heading must not be a <button>: _wirePlusMenu collects
  // `button[data-plus]` for the touch action sheet, and a heading that
  // matched would arrive there as a tappable row that does nothing.
  const fnStart = frame.indexOf('function PlusMenuHeading(');
  assert.ok(fnStart !== -1, 'the PlusMenuHeading primitive must exist');
  // Slice from the RETURN, not the signature: the destructured props' type
  // annotation closes with a `}` in column 0, which is not the function's end.
  const fn = frame.slice(fnStart, frame.indexOf('\n}\n', frame.indexOf('return (', fnStart)));
  assert.match(fn, /<div\s+data-plus-group=/, 'headings render as a div');
  assert.ok(!fn.includes('data-plus="'), 'a heading carries no data-plus');
  // The touch sheet renders them too, since it has no heading primitive.
  assert.match(appView, /button\[data-plus\], \[data-plus-group\]/,
    'the action sheet walks headings and rows together, in DOM order');
});
