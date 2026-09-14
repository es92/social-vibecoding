// The six build venues — one question, asked once.
//
// public/js/build-venues.js replaced nine scattered controls that each named
// their own mechanism and none of which named the others. Two of them said
// "Claude Code" about two different products: the platform backend
// (chat_sessions.agent_backend='claude_code', billed to Homeroom) and the web
// hand-off (users.dev_flow_preference='claude-code', billed to the user's own
// Claude plan). Picking the wrong one cost real money, so the properties
// pinned here are the ones that keep them apart:
//
//   1. the LIST is closed and grouped — six venues, in-chat before elsewhere,
//      and the group is the honest first question ("does this happen in this
//      chat or somewhere else?").
//   2. gating is by OMISSION, never `disabled: true`. The kit's touch idiom
//      is an action sheet, which drops disabled rows entirely — a disabled
//      entry is invisible on a phone and inert-but-present on a desktop.
//   3. venue ids never travel to a server. `preselect()` is the only door
//      from a presentation key to a persisted value, and it refuses to guess.
//   4. `own-tools-pr` is not defaultable and has no chat. Both exceptions are
//      enforced server-side; this module only has to report them, and must
//      not report them wrong.
//   5. the #1071 three-way hand-off derivation lives here now, once, instead
//      of in session-options.js alone.
//
// Run with: node --test tests/build-venues.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const BV = require('../public/js/build-venues.js');

// Everything on: the maximal deployment, so a row that is absent here is
// absent because the list says so, not because a flag was left unset.
const OPEN = {
  openrouterAvailable: true,
  cliAuthEnabled: true,
  // #1281: `local` needs the deployment flag AND the user's own opt-in, so
  // "everything on" has to include the opt-in or the maximal deployment
  // would quietly be a five-venue one.
  sessionBridgeEnabled: true,
  externalFlowsAvailable: true,
  canCollaborate: true,
};

const idsFor = (state) => BV.venuesFor(state).map((r) => r.id);

// ── The list ────────────────────────────────────────────────────────

test('six venues, in-chat first, in menu order', () => {
  assert.deepEqual(BV.VENUES.map((v) => v.id), [
    'usernode-openrouter',
    'usernode-claude',
    'local',
    'web-claude-code',
    'web-codex',
    'own-tools-pr',
  ]);
  assert.deepEqual(BV.VENUES.map((v) => v.group), [
    'in-chat', 'in-chat', 'in-chat',
    'elsewhere', 'elsewhere', 'elsewhere',
  ]);
});

test('the two groups are the question, in question order', () => {
  assert.deepEqual(BV.GROUPS.map((g) => g.id), ['in-chat', 'elsewhere']);
  assert.equal(BV.GROUPS[0].label, 'In this chat');
  assert.equal(BV.GROUPS[1].label, 'Somewhere else');
});

test('every venue carries the copy a row needs', () => {
  for (const v of BV.VENUES) {
    assert.ok(v.label, `${v.id} has no label`);
    assert.ok(v.blurb && v.blurb.length > 20, `${v.id} has no blurb`);
    assert.ok(v.cta, `${v.id} has no cta`);
    assert.ok(v.mechanism && v.mechanism.kind, `${v.id} has no mechanism`);
    assert.equal(typeof v.defaultable, 'boolean');
    assert.equal(typeof v.chat, 'boolean');
  }
});

test('venue() refuses an id it does not know', () => {
  assert.equal(BV.venue('usernode-claude').label, 'Homeroom · Claude');
  assert.equal(BV.venue('claude_code'), null, 'a PERSISTED value is not a venue id');
  assert.equal(BV.venue('claude-code'), null);
  assert.equal(BV.venue(''), null);
  assert.equal(BV.venue(undefined), null);
  // Prototype keys are not venues either.
  assert.equal(BV.venue('constructor'), null);
  assert.equal(BV.venue('toString'), null);
});

// ── Mechanisms: the only place the two vocabularies meet ────────────

test('each mechanism names the persisted value, not a new one', () => {
  const by = new Map(BV.VENUES.map((v) => [v.id, v.mechanism]));
  assert.deepEqual(by.get('usernode-claude'), { kind: 'backend', backend: 'claude_code' });
  assert.deepEqual(by.get('usernode-openrouter'), { kind: 'backend', backend: 'codex_openrouter' });
  assert.equal(by.get('local').kind, 'lease');
  assert.equal(by.get('web-claude-code').flow, 'claude-code');
  assert.equal(by.get('web-codex').flow, 'codex');
  assert.equal(by.get('own-tools-pr').kind, 'import');
});

test('every settings hash a venue points at is a real settings route', () => {
  // These are ordinary hash navigations, so the device back gesture returns
  // to the chat. A typo here is a dead end, not an error.
  const known = Object.values(BV.SETTINGS_HASHES);
  assert.deepEqual(known.sort(), ['#settings/api-key', '#settings/cli', '#settings/connectors']);
  for (const v of BV.VENUES) {
    if (v.mechanism.hash) {
      assert.ok(known.includes(v.mechanism.hash), `${v.id} points at ${v.mechanism.hash}`);
    }
  }
});

// ── Gating by omission ──────────────────────────────────────────────

test('a bare deployment offers only what needs nothing', () => {
  assert.deepEqual(idsFor({}), ['usernode-claude']);
});

test('each capability flag adds exactly its own venue, and never a disabled row', () => {
  const cases = [
    ['openrouterAvailable', 'usernode-openrouter'],
    ['canCollaborate', 'own-tools-pr'],
  ];
  for (const [flag, id] of cases) {
    const expected = flag === 'openrouterAvailable'
      ? [id, 'usernode-claude']
      : ['usernode-claude', id];
    assert.deepEqual(idsFor({ [flag]: true }), expected, `${flag} → ${id}`);
  }
  // #1281: `local` is the one venue behind TWO flags — the deployment has to
  // offer the CLI surface and the user has to have opted in. Either alone
  // offers nothing, which is the whole point of a gate that defaults off.
  assert.deepEqual(idsFor({ cliAuthEnabled: true }), ['usernode-claude'],
    'the deployment flag alone does not offer the bridge');
  assert.deepEqual(idsFor({ sessionBridgeEnabled: true }), ['usernode-claude'],
    'the opt-in alone does not offer it on a deployment without the CLI');
  assert.deepEqual(
    idsFor({ cliAuthEnabled: true, sessionBridgeEnabled: true }),
    ['usernode-claude', 'local'],
    'both together → the bridge',
  );
  // One flag, two venues: the web hand-offs share a deployment capability.
  assert.deepEqual(
    idsFor({ externalFlowsAvailable: true }),
    ['usernode-claude', 'web-claude-code', 'web-codex'],
  );
});

test('everything on offers all six, still in list order', () => {
  assert.deepEqual(idsFor(OPEN), BV.VENUES.map((v) => v.id));
});

test('an unavailable venue is ABSENT, never present-and-disabled', () => {
  // The kit's action sheet drops disabled rows, so a `disabled` row is a
  // row that exists on desktop and vanishes on a phone. Two products.
  const rows = BV.venuesFor({});
  for (const row of rows) {
    assert.ok(!('disabled' in row), `${row.id} carries a disabled flag`);
  }
  assert.ok(!idsFor({}).includes('usernode-openrouter'));
  assert.ok(!idsFor({}).includes('local'));
  assert.ok(!idsFor({}).includes('own-tools-pr'));
});

// ── Where this session is already building ──────────────────────────

test('currentVenue reads the session, and imported short-circuits everything', () => {
  assert.equal(BV.currentVenue({}), 'usernode-claude');
  assert.equal(BV.currentVenue({ agentBackend: 'claude_code' }), 'usernode-claude');
  assert.equal(BV.currentVenue({ agentBackend: 'codex_openrouter' }), 'usernode-openrouter');
  assert.equal(BV.currentVenue({ localAgent: { leaseId: 'l1' } }), 'local');
  assert.equal(BV.currentVenue({ externalAgent: 'claude-code' }), 'web-claude-code');
  assert.equal(BV.currentVenue({ externalAgent: 'codex' }), 'web-codex');

  // An imported proposal has an agent_backend column like any other row —
  // the insert defaults it — but no turn ever ran through it and none ever
  // will, so reading the backend would name a venue that is not merely
  // unused but structurally unreachable.
  assert.equal(
    BV.currentVenue({ source: 'imported', agentBackend: 'codex_openrouter' }),
    'own-tools-pr',
  );
  assert.equal(
    BV.currentVenue({ source: 'imported', localAgent: { leaseId: 'l1' }, externalAgent: 'codex' }),
    'own-tools-pr',
  );
});

test('the current venue is marked on its row and on no other', () => {
  const rows = BV.venuesFor({ ...OPEN, current: 'web-codex' });
  assert.deepEqual(rows.filter((r) => r.current).map((r) => r.id), ['web-codex']);
  assert.equal(BV.venuesFor(OPEN).filter((r) => r.current).length, 0);
});

// ── The two hard exceptions on own-tools-pr ─────────────────────────

test('own-tools-pr cannot be a default, and every other venue can', () => {
  assert.deepEqual(BV.defaultableVenues().map((v) => v.id), [
    'usernode-openrouter', 'usernode-claude', 'local', 'web-claude-code', 'web-codex',
  ]);
  assert.ok(!BV.defaultableVenues().some((v) => v.id === 'own-tools-pr'));
});

test('own-tools-pr has no chat, and its copy says so in every mode', () => {
  assert.equal(BV.venue('own-tools-pr').chat, false);
  assert.equal(BV.preselect('own-tools-pr').chat, false);
  for (const mode of BV.MODES) {
    const row = BV.venuesFor({ ...OPEN, mode }).find((r) => r.id === 'own-tools-pr');
    assert.equal(row.chat, false, `${mode}: chat flag`);
    assert.match(row.consequence, /can’t be your default/, `${mode}: default exception unstated`);
  }
  // The server refuses dev-chat turns on source='imported'; the two modes
  // that offer this venue as a place to GO say there is no chat there.
  for (const mode of ['start', 'blocked']) {
    const row = BV.venuesFor({ ...OPEN, mode }).find((r) => r.id === 'own-tools-pr');
    assert.match(row.consequence, /no Homeroom chat/i, `${mode}: chat exception unstated`);
  }
  const moving = BV.venuesFor({ ...OPEN, mode: 'switch' }).find((r) => r.id === 'own-tools-pr');
  assert.match(moving.consequence, /this chat stays where it is/i);
});

test('only the in-chat group promises to keep the transcript', () => {
  for (const row of BV.venuesFor({ ...OPEN, mode: 'switch' })) {
    const keeps = /Keeps this chat/.test(row.consequence);
    assert.equal(keeps, row.group === 'in-chat', `${row.id} keeps-chat claim`);
  }
});

// ── Modes ───────────────────────────────────────────────────────────

test('three modes, and anything unrecognised reads as start', () => {
  assert.deepEqual(BV.MODES, ['start', 'switch', 'blocked']);
  const start = BV.venuesFor({ ...OPEN, mode: 'start' }).map((r) => r.label);
  for (const bogus of [undefined, '', 'wizard', 'SWITCH', null]) {
    assert.deepEqual(
      BV.venuesFor({ ...OPEN, mode: bogus }).map((r) => r.label), start,
      `mode ${JSON.stringify(bogus)} should fall back to start`,
    );
  }
});

test('start mode labels the venue and nothing else', () => {
  assert.deepEqual(BV.venuesFor({ ...OPEN, mode: 'start' }).map((r) => r.label), [
    'Homeroom · OpenRouter',
    'Homeroom · Claude',
    'Your computer · Homeroom session',
    'Claude Code on the web',
    'Codex on the web',
    'Your computer · your own tools',
  ]);
});

test('switch mode says what the move does, per group', () => {
  const rows = BV.venuesFor({
    ...OPEN, mode: 'switch', sessionStatus: 'active', hasBranch: true, sessionId: 12,
  });
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get('usernode-openrouter').label, 'Move to Homeroom · OpenRouter');
  assert.equal(by.get('local').label, 'Move to Your computer · Homeroom session');
  // A web hand-off from an under-way session continues it; "Move to" would
  // be a promise this venue does not keep.
  assert.equal(by.get('web-codex').label, 'Continue this session with Codex on the web');
  assert.equal(by.get('own-tools-pr').label, 'Move to Your computer · your own tools');
});

test('blocked mode keeps the refused venue visible and struck through', () => {
  const rows = BV.venuesFor({ ...OPEN, mode: 'blocked', blockedReason: 'Out of credits until midnight.' });
  const claude = rows.find((r) => r.id === 'usernode-claude');
  // Deleting the row someone was already using makes the menu look like it
  // lost an option rather than like one is temporarily out of reach.
  assert.ok(rows.some((r) => r.id === 'usernode-claude'), 'the blocked venue must stay listed');
  assert.equal(claude.unavailable, true);
  assert.equal(claude.reason, 'Out of credits until midnight.');
  // And nothing else is collateral damage.
  assert.deepEqual(rows.filter((r) => r.unavailable).map((r) => r.id), ['usernode-claude']);
  // With no reason supplied it still explains itself.
  const bare = BV.venuesFor({ ...OPEN, mode: 'blocked' }).find((r) => r.id === 'usernode-claude');
  assert.match(bare.reason, /midnight UTC/);
});

test('no other mode marks anything unavailable', () => {
  for (const mode of ['start', 'switch']) {
    assert.equal(BV.venuesFor({ ...OPEN, mode }).filter((r) => r.unavailable).length, 0, mode);
  }
});

// ── #1071: what a web hand-off does from HERE ───────────────────────

test('webTargetKind is the three-way derivation, moved here intact', () => {
  const cases = [
    [{ sessionStatus: 'active', hasBranch: true }, 'session'],
    // Pausing is bookkeeping, not a decision about the work — the platform
    // auto-pauses idle sessions on the user's behalf.
    [{ sessionStatus: 'paused', hasBranch: true }, 'session'],
    [{ sessionStatus: 'promoted', hasBranch: true }, 'proposal'],
    [{ sessionStatus: 'promoted', hasBranch: false }, 'proposal'],
    // An explicit put-away must not be silently reopened by a push.
    [{ sessionStatus: 'archived', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merging', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merged', hasBranch: true }, 'new'],
    [{ sessionStatus: 'active', hasBranch: false }, 'new'],
    [{ sessionStatus: 'paused', hasBranch: false }, 'new'],
    [{}, 'new'],
  ];
  for (const [state, expected] of cases) {
    assert.equal(BV.webTargetKind(state), expected, `${JSON.stringify(state)} → ${expected}`);
  }
});

test('an active session with no branch is a REACHABLE state, not a stale row (#1350)', () => {
  // Branch creation is deferred to the first turn now, so "active, no branch"
  // is what every freshly created session looks like until somebody sends a
  // message. The derivation already answered 'new' for it; what changed is
  // that this row is common rather than a leftover, so the hand-off has to
  // read as starting work rather than as continuing a branch that is not there.
  for (const status of ['active', 'paused']) {
    assert.equal(BV.webTargetKind({ sessionStatus: status, hasBranch: false }), 'new', status);
    assert.equal(BV.webVerb(BV.webTargetKind({ sessionStatus: status, hasBranch: false })),
      BV.webVerb('new'), 'and it is offered with the start-new-work verb');
  }
  // Promotion is the one status that outranks the missing branch: a promoted
  // session has a proposal to continue whatever its own branch column says.
  assert.equal(BV.webTargetKind({ sessionStatus: 'promoted', hasBranch: false }), 'proposal');
});

test('the hand-off verb follows the target kind', () => {
  assert.equal(BV.webVerb('session'), 'Continue this session with ');
  assert.equal(BV.webVerb('proposal'), 'Continue this proposal with ');
  assert.equal(BV.webVerb('new'), 'Start new work with ');
  assert.equal(BV.webVerb('nonsense'), 'Start new work with ');
});

test('active and paused give byte-identical labels, differing only in the tooltip', () => {
  const rowFor = (sessionStatus) => BV.venuesFor({
    ...OPEN, mode: 'switch', sessionStatus, hasBranch: true, sessionId: 3,
  }).find((r) => r.id === 'web-claude-code');
  const active = rowFor('active');
  const paused = rowFor('paused');
  assert.equal(active.label, paused.label, 'the two cases must not drift apart in the menu');
  assert.notEqual(active.consequence, paused.consequence);
  assert.match(paused.consequence, /when you reopen the session/);
  assert.match(active.consequence, /preview and checks rebuild/);
});

test('a promoted session warns that pushing clears the votes', () => {
  const row = BV.venuesFor({
    ...OPEN, mode: 'switch', sessionStatus: 'promoted', hasBranch: true, sessionId: 9,
  }).find((r) => r.id === 'web-codex');
  assert.equal(row.targetKind, 'proposal');
  assert.match(row.consequence, /clears the votes/);
});

test('targetId rides along only when the hand-off pushes back onto this branch', () => {
  const rows = (state) => new Map(BV.venuesFor({ ...OPEN, ...state }).map((r) => [r.id, r]));

  const continuing = rows({ sessionStatus: 'active', hasBranch: true, sessionId: 41 });
  assert.equal(continuing.get('web-claude-code').targetId, 41);
  assert.equal(continuing.get('web-codex').targetId, 41);
  // Only the flow venues carry it — nothing else pushes anywhere.
  assert.equal(continuing.get('usernode-claude').targetId, null);
  assert.equal(continuing.get('local').targetId, null);
  assert.equal(continuing.get('own-tools-pr').targetId, null);

  // 'new' means the hand-off genuinely starts something separate.
  const fresh = rows({ sessionStatus: 'archived', hasBranch: true, sessionId: 41 });
  assert.equal(fresh.get('web-claude-code').targetId, null);

  // No session id to carry.
  const anon = rows({ sessionStatus: 'active', hasBranch: true });
  assert.equal(anon.get('web-codex').targetId, null);
});

// ── preselect: the one door to a persisted value ────────────────────

test('preselect hands back the persisted value for each venue', () => {
  assert.equal(BV.preselect('usernode-claude').backend, 'claude_code');
  assert.equal(BV.preselect('usernode-claude').flow, null);
  assert.equal(BV.preselect('usernode-openrouter').backend, 'codex_openrouter');
  assert.equal(BV.preselect('web-claude-code').flow, 'claude-code');
  assert.equal(BV.preselect('web-claude-code').backend, null);
  assert.equal(BV.preselect('web-codex').flow, 'codex');

  const local = BV.preselect('local');
  assert.equal(local.kind, 'lease');
  assert.equal(local.hash, '#settings/cli');

  const own = BV.preselect('own-tools-pr');
  assert.equal(own.kind, 'import');
  assert.equal(own.defaultable, false);
  assert.equal(own.chat, false);
});

test('preselect refuses an id it does not know rather than guessing', () => {
  // A venue id off a URL or a stale preference must not silently become
  // "the first backend in the list".
  for (const bogus of ['claude_code', 'claude-code', 'codex', 'openrouter', '', null, undefined, 'CONSTRUCTOR']) {
    assert.equal(BV.preselect(bogus), null, `preselect(${JSON.stringify(bogus)})`);
  }
});

test('every venue round-trips through preselect', () => {
  for (const v of BV.VENUES) {
    const p = BV.preselect(v.id);
    assert.equal(p.venue, v.id);
    assert.equal(p.label, v.label);
    assert.equal(p.kind, v.mechanism.kind);
  }
});

// ── The silent default, made visible ────────────────────────────────

test('every fallback reason the server can send has a sentence', () => {
  // These are the reasons resolveDefaultAgentPreference (src/routes/sessions.js)
  // stamps onto the 201 body. It is deliberately lenient — a session that
  // runs beats a 4xx — so the note is the only place a user learns their
  // saved default was not honoured.
  for (const reason of ['flag_off', 'not_in_beta', 'model_unavailable', 'no_credential']) {
    const note = BV.fallbackNote(reason);
    assert.ok(note, `no note for ${reason}`);
    assert.match(note, /Homeroom · OpenRouter/, `${reason} does not name the venue asked for`);
    assert.match(note, /Homeroom · Claude/, `${reason} does not name the venue given`);
  }
});

test('an unknown fallback reason renders nothing at all', () => {
  for (const bogus of ['', null, undefined, 'kaboom', 'toString']) {
    assert.equal(BV.fallbackNote(bogus), '', `fallbackNote(${JSON.stringify(bogus)})`);
  }
});

// ── What the selector is BUILT FROM (#1348) ─────────────────────────
//
// `selectorHtml` used to be here and built the `#dc-venue-select` button as a
// string. The session header is a component now and the button is JSX
// (features/dev-chat/session-header.tsx), because a declared check selects it
// as a DIRECT, LAST child of the strip and a `dangerouslySetInnerHTML` sink
// would have made it a grandchild. What this module still owns is every
// question the button ASKS it, so that is what these assert; the markup is
// asserted against the component in tests/dev-session-header.test.js.

test('the selector states where this is building, and is the way to change it', () => {
  const id = BV.currentVenue({ agentBackend: 'codex_openrouter' });
  assert.equal(id, 'usernode-openrouter');
  const v = BV.venue(id);
  assert.equal(v.label, 'Homeroom · OpenRouter');
  // The visible LABEL is the venue and nothing else: the control sits in the
  // header beside a truncating session title, so the caption sentence the old
  // line carried survives only as the hover title — assembled in dev-chat.js's
  // `_headerVenue` from this `blurb`.
  assert.ok(!/Building in/.test(v.label), 'the caption sentence is not in the label');
  assert.ok(v.blurb, 'the sentence the tooltip is built from is here');
  // The note is a separate render — the selector never carried it.
  assert.ok(!/dc-venue-note/.test(v.label + v.blurb));
});

test('the fallback sentence renders on its own, away from the header', () => {
  const html = BV.noteHtml({ agentBackend: 'claude_code', fallbackReason: 'no_credential' });
  assert.match(html, /dc-venue-note/);
  assert.match(html, /OpenRouter key is missing/);
  // No fallback → nothing at all, so .dc-venue-slot:empty collapses.
  assert.equal(BV.noteHtml({ agentBackend: 'claude_code' }), '');
  assert.equal(BV.noteHtml({}), '');
  assert.equal(BV.noteHtml(), '');
});

test('an imported proposal reports its own venue in the selector', () => {
  const id = BV.currentVenue({ source: 'imported', agentBackend: 'claude_code' });
  assert.equal(id, 'own-tools-pr');
  assert.equal(BV.venue(id).label, 'Your computer · your own tools');
});

test('the selector and the chip refuse an unknown venue instead of half-rendering', () => {
  assert.equal(BV.venue('nope'), null);
  assert.equal(BV.chipHtml('nope'), '');
  assert.equal(BV.chipHtml(undefined), '');
});

test('the chip names the venue and explains it on hover', () => {
  const chip = BV.chipHtml('local');
  assert.match(chip, /dc-venue-chip/);
  assert.match(chip, /Your computer · Homeroom session/);
  assert.match(chip, /title="/);
});

test('interpolated state is escaped', () => {
  // `current` reaches here from session state, which is app data.
  assert.equal(BV.escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(BV.escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(BV.escapeHtml(null), '');
  // The selector's own escaping moved with its markup: React escapes text
  // children and attribute values, which is why `_headerVenue` carries the
  // label and the sentence RAW. What is still a string here is the note.
  assert.ok(!/<script/i.test(BV.noteHtml({ current: 'usernode-claude', fallbackReason: 'flag_off' })));
});

// ── The sheet ───────────────────────────────────────────────────────

test('the sheet asks one coarse question, four rows, no headings (#1348)', async () => {
  const calls = [];
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => { calls.push(opts); return Promise.resolve(null); },
    },
  };
  try {
    await BV.open({ state: { ...OPEN, mode: 'switch', sessionStatus: 'active', hasBranch: true } });
  } finally {
    delete global.window;
  }
  assert.equal(calls.length, 1);
  const items = calls[0].items;
  assert.equal(calls[0].title, 'Where do you want to work on this?');
  // The group headings were load-bearing while the rows were six venue
  // names that did not say what they did. The coarse labels say it, so
  // there is nothing left for a heading to explain — and every row is a
  // real answer now, not a separator with a no-op handler.
  assert.equal(items.length, 4, `four choices, got ${items.map((i) => i.label).join(' / ')}`);
  assert.deepEqual(items.map((i) => i.label.replace(' ✓', '')), [
    'On-Platform',
    'Claude or Codex WebUI',
    'Your Own Developer Tooling',
    'Local CLI Bridge',
  ]);
  for (const item of items) {
    assert.ok(!('disabled' in item), `${item.label} carries a disabled flag`);
    assert.equal(typeof item.handler, 'function');
    assert.ok(!/^—/.test(item.label), 'no separator rows survive');
  }
});

test('every row carries a kit icon the kit actually ships (#1348)', async () => {
  // An icon name the kit does not know draws nothing — no throw, no
  // fallback glyph — so a typo here is a silently iconless row.
  const { physics } = require('../public/usernode-native/v1/native.js');
  let items = null;
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => { items = opts.items; return Promise.resolve(null); },
    },
  };
  try {
    await BV.open({ state: { ...OPEN, mode: 'switch' } });
  } finally {
    delete global.window;
  }
  assert.equal(items.length, 4);
  for (const item of items) {
    assert.ok(item.icon, `${item.label} has no icon`);
    assert.ok(physics.ICON_NAMES.includes(item.icon),
      `${item.label}: '${item.icon}' is not in the kit's set`);
  }
});

test('picking a row hands back the choice, with the venue it resolves to', async () => {
  const picked = [];
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => {
        opts.items.find((i) => /Your Own Developer Tooling/.test(i.label)).handler();
        return Promise.resolve(null);
      },
    },
  };
  try {
    await BV.open({ state: OPEN, onPick: (row) => picked.push(row) });
  } finally {
    delete global.window;
  }
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'own-tools');
  assert.equal(picked[0].venue, 'own-tools-pr',
    'the caller still gets a venue id it can preselect() through');
});

test('the on-platform row resolves its venue server-side, not here', async () => {
  // Its `venue` is null on purpose: which of the two in-chat backends this
  // means is the user's last-used one, and only the server knows that.
  const picked = [];
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => {
        opts.items.find((i) => /On-Platform/.test(i.label)).handler();
        return Promise.resolve(null);
      },
    },
  };
  try {
    // `current: 'web-codex'` so the on-platform row is not the current one
    // — a row you are already in is not pickable.
    await BV.open({ state: { ...OPEN, current: 'web-codex' }, onPick: (row) => picked.push(row) });
  } finally {
    delete global.window;
  }
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'on-platform');
  assert.equal(picked[0].venue, null);
});

test('an unavailable row explains itself instead of being picked', async () => {
  const picked = [];
  const refused = [];
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => {
        const row = opts.items.find((i) => /On-Platform/.test(i.label));
        assert.match(row.label, /unavailable/);
        row.handler();
        return Promise.resolve(null);
      },
    },
  };
  try {
    await BV.open({
      state: { ...OPEN, mode: 'blocked' },
      onPick: (p) => picked.push(p),
      onUnavailable: (r) => refused.push(r),
    });
  } finally {
    delete global.window;
  }
  assert.equal(picked.length, 0, 'a blocked choice must not be selectable');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].id, 'on-platform');
});

test('the current venue ticks the coarse row that contains it', async () => {
  // `local` is one venue inside the Local CLI Bridge row — the tick has to
  // follow the containment, not an id match.
  let items = null;
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => { items = opts.items; return Promise.resolve(null); },
    },
  };
  try {
    await BV.open({ state: { ...OPEN, current: 'local' } });
  } finally {
    delete global.window;
  }
  const ticked = items.filter((i) => /✓/.test(i.label));
  assert.equal(ticked.length, 1);
  assert.match(ticked[0].label, /Local CLI Bridge/);
});

test('either in-chat venue ticks On-Platform, because the row is the pair', async () => {
  for (const venue of ['usernode-claude', 'usernode-openrouter']) {
    let items = null;
    global.window = {
      PlatformUI: {
        hasKit: () => true,
        menu: (opts) => { items = opts.items; return Promise.resolve(null); },
      },
    };
    try {
      await BV.open({ state: { ...OPEN, current: venue } });
    } finally {
      delete global.window;
    }
    const ticked = items.filter((i) => /✓/.test(i.label));
    assert.equal(ticked.length, 1, `${venue} ticks exactly one row`);
    assert.match(ticked[0].label, /On-Platform/, `${venue} ticks On-Platform`);
  }
});

test('with no kit the sheet resolves null rather than throwing', async () => {
  assert.equal(await BV.open({ state: OPEN }), null);
  global.window = { PlatformUI: { hasKit: () => false, menu: () => { throw new Error('nope'); } } };
  try {
    assert.equal(await BV.open({ state: OPEN }), null);
  } finally {
    delete global.window;
  }
});

test('every row is a bare answer to the sheet\'s question (#1348)', () => {
  // No verbs at all now: under "Where do you want to work on this?" a bare
  // noun IS the answer, and "Move to …" / "Continue this session with …"
  // read as instructions bolted onto one.
  const rows = BV.choicesFor({ ...OPEN, mode: 'switch', sessionStatus: 'active', hasBranch: true });
  for (const row of rows) {
    assert.doesNotMatch(row.label, /^(Continue|Start new work|Move to)\b/,
      `${row.id} should read as a bare answer, got "${row.label}"`);
  }
});

test('the web row still explains WHICH work the hand-off takes (#1071)', () => {
  // The label stopped saying it (#1348), so this is the only place left on
  // this surface: continuing this session, continuing the proposal, and
  // starting fresh are different promises, and picking the wrong one costs
  // somebody their branch. Desktop shows it as the row's tooltip.
  const note = (state) => BV.choicesFor(state).find((r) => r.id === 'web-agent').consequence;
  const base = { ...OPEN, mode: 'switch', hasBranch: true, sessionId: 7 };
  assert.match(note({ ...base, sessionStatus: 'active' }),
    /pushes its work back onto this session/);
  assert.match(note({ ...base, sessionStatus: 'paused' }),
    /pushes its work back onto this session/);
  assert.match(note({ ...base, sessionStatus: 'promoted' }),
    /pushes back onto the same proposal/);
  assert.match(note({ ...base, sessionStatus: 'archived', hasBranch: false }),
    /comes back as its own proposal/);
  // All four must stay distinguishable from one another.
  const notes = ['active', 'promoted', 'archived']
    .map((sessionStatus) => note({ ...base, sessionStatus, hasBranch: sessionStatus !== 'archived' }));
  assert.equal(new Set(notes).size, 3, 'the three target states must not collapse into one sentence');
});

test('a refused row says only that, not that you are also standing in it', async () => {
  // Blocked mode marks the venue that just refused the turn — which is by
  // definition the one you are in, so the tick and the note would always
  // land together. "On-Platform ✓ (unavailable)" is two answers to one
  // question.
  let items = null;
  global.window = {
    PlatformUI: {
      hasKit: () => true,
      menu: (opts) => { items = opts.items; return Promise.resolve(null); },
    },
  };
  try {
    await BV.open({ state: { ...OPEN, mode: 'blocked', current: 'usernode-claude' } });
  } finally {
    delete global.window;
  }
  const row = items.find((i) => /On-Platform/.test(i.label));
  assert.match(row.label, /\(unavailable\)/);
  assert.doesNotMatch(row.label, /✓/, 'no tick on a row that is refusing you');
  // …while an ordinary current row still ticks.
  assert.equal(items.filter((i) => /✓/.test(i.label)).length, 0);
});


test('native handoffs retain their actual provider without becoming web sessions', () => {
  const BV = require('../public/js/build-venues');
  for (const [agent, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['external', 'External agent'], [undefined, 'External agent']]) {
    const state = { source: 'cli_handoff', externalAgent: agent, agentBackend: 'claude_code' };
    assert.equal(BV.currentVenue(state), 'local');
    assert.equal(BV.sessionVenue(state).label, label);
    assert.equal(BV.sessionVenue(state).chat, true);
    assert.equal(BV.sessionVenue({ ...state, buildVenue: 'usernode-openrouter' }).label, 'Homeroom · OpenRouter');
    assert.equal(BV.sessionVenue({ ...state, localAgent: { leaseId: 'active' } }).label, 'Your computer · Homeroom session');
  }
  assert.equal(BV.sessionVenue({ externalAgent: 'codex' }).label, 'Codex on the web');
  assert.equal(BV.sessionVenue({ agentBackend: 'claude_code' }).label, 'Homeroom · Claude');
});
