// Out-of-credits routes — the ways to keep building when the daily AI
// allowance is spent (three, or four where the #1049 Claude Code / Codex
// hand-offs are available).
//
// The point of public/js/credit-options.js is that ONE module owns the copy
// and the destinations, so the dev-chat card, the red credits banner and the
// Generate-proposal modal cannot drift. These tests pin the three properties
// that make that true:
//
//   1. the destinations are exactly the three Settings sections, and each
//      one is a REAL declared section (a renamed section must fail here, not
//      silently ship a dead link);
//   2. the copy adapts to the two states the server can actually produce —
//      a user who already has a key on file (a decrypt failure still 429s),
//      and the platform's shared budget running out instead of theirs; and
//   3. the platform's own error text is escaped, never injected.
//
// Run with: node --test tests/credit-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CreditOptions = require('../public/js/credit-options.js');
const { shellMarkup } = require('./lib/shell-markup');

const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);
const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/app-view.js'), 'utf8'
);
// Document plus the settings panes, which mount on first reveal.
const INDEX_SRC = shellMarkup();

test('offers exactly three routes by default, in the documented order', () => {
  // Without the #1049 hand-offs (a deployment with no GitHub-link support)
  // this is the original list with TWO changes. The single "use a coding
  // tool on your computer" row became the two venues it always covered —
  // `local` continues this session on your machine, `own-tools-pr` is you
  // working alone and importing a pull request, with no Homeroom chat. And
  // since #1281 `local` is opt-in (users.session_bridge_enabled, default
  // FALSE), so the DEFAULT list is three: it is the bottom rung of the
  // spec's routing tree and it wants the CLI installed before it can do
  // anything, which is not a thing to put in front of somebody who has just
  // been told their credits ran out.
  const options = CreditOptions.options({});
  assert.equal(options.length, 3);
  assert.deepEqual(
    options.map((o) => o.id),
    ['api-key', 'own-tools-pr', 'connector']
  );
  assert.deepEqual(
    options.map((o) => o.hash),
    ['#settings/api-key', '#settings/cli', '#settings/connectors']
  );
  // Opting in puts it back, in its old position — the gate changes who is
  // offered the row, never where it sits.
  assert.deepEqual(
    CreditOptions.options({ sessionBridgeEnabled: true }).map((o) => o.id),
    ['api-key', 'local', 'own-tools-pr', 'connector']
  );
  // Every entry must be renderable: a blank title or CTA would ship an
  // unlabelled button.
  for (const option of options) {
    assert.ok(option.title.length > 0, `${option.id} has a title`);
    assert.ok(option.blurb.length > 0, `${option.id} has a blurb`);
    assert.ok(option.cta.length > 0, `${option.id} has a CTA`);
  }
});

// #1049: running out of credits is the moment someone is most willing to try
// another route, so the two that need no card and no new account — the Claude
// or ChatGPT subscription they already pay for — lead, and each carries a
// `flow` the surface can act on in place.
test('with the external flows available, the hand-offs lead', () => {
  const options = CreditOptions.options({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ['web-claude-code', 'web-codex', 'api-key', 'local', 'own-tools-pr'],
    'the two web venues first, then BYOK, then the two on-your-computer venues'
  );
  assert.deepEqual(
    options.filter((o) => o.flow).map((o) => o.flow),
    ['claude-code', 'codex'],
    'only the two hand-offs carry a flow — and it is still the PERSISTED '
    + 'dev_flow_preference value, not the venue id'
  );
  // Every entry keeps a hash: a surface that wires no flow handler still has
  // somewhere to send the user (see the wire() test below).
  for (const option of options) {
    assert.match(option.hash, /^#settings\//, `${option.id} keeps a hash fallback`);
    assert.ok(option.title.length > 0, `${option.id} has a title`);
    assert.ok(option.blurb.length > 0, `${option.id} has a blurb`);
    assert.ok(option.cta.length > 0, `${option.id} has a CTA`);
  }
  // The old "connector" plumbing entry is replaced by the two flows, not
  // stacked on top of them.
  assert.ok(!options.some((o) => o.id === 'connector'));
});

test('the intro sentence counts the routes actually offered', () => {
  assert.match(CreditOptions.cardHtml({}), /Three ways to keep building/);
  assert.match(
    CreditOptions.cardHtml({ externalFlowsAvailable: true }),
    /Four ways to keep building/
  );
  // #1281: opting in to the bridge adds a route, and the sentence moves
  // with it — the count is spelled from the list, never frozen.
  assert.match(
    CreditOptions.cardHtml({ externalFlowsAvailable: true, sessionBridgeEnabled: true }),
    /Five ways to keep building/
  );
  // Gating is by OMISSION, so a deployment with no CLI and a read-only
  // viewer produces a shorter list — and the sentence has to be able to
  // spell whatever number that is, in words. A digit here means the
  // numeral table fell off the end of a count it can now reach.
  for (const state of [
    {},
    { externalFlowsAvailable: true },
    { externalFlowsAvailable: true, cliAuthEnabled: false, canCollaborate: false },
    { cliAuthEnabled: false, canCollaborate: false },
  ]) {
    assert.doesNotMatch(
      CreditOptions.introFor(CreditOptions.options(state)), /^\d/,
      `the intro fell back to a digit for ${JSON.stringify(state)}`
    );
  }
});

test('a venue this viewer cannot use is absent, never disabled', () => {
  // The kit's touch idiom is an action sheet, which DROPS disabled rows —
  // so a disabled entry is invisible on a phone and inert-but-present on
  // desktop. Two different products. See public/js/build-venues.js.
  const gated = CreditOptions.options({
    externalFlowsAvailable: true, cliAuthEnabled: false, canCollaborate: false,
  });
  const ids = gated.map((o) => o.id);
  assert.ok(!ids.includes('local'), 'no CLI on this deployment → no local venue');
  assert.ok(
    !ids.includes('own-tools-pr'),
    'a viewer who cannot push branches cannot import a PR either'
  );
  for (const option of gated) {
    assert.ok(!('disabled' in option), `${option.id} must not ship a disabled flag`);
  }
});

test('every destination is a section Settings actually declares', () => {
  // The guard this file exists for: renaming a Settings section without
  // updating the card would produce buttons that navigate nowhere.
  for (const option of CreditOptions.options({ externalFlowsAvailable: true })) {
    const key = option.hash.replace('#settings/', '');
    assert.match(
      SETTINGS_SRC,
      new RegExp(`key: '${key}'`),
      `Settings.SECTIONS declares '${key}'`
    );
    assert.match(
      INDEX_SRC,
      new RegExp(`data-settings-section="${key}"`),
      `index.html has a [data-settings-section="${key}"] wrapper`
    );
  }
});

test('a user who already has a key is told to check it, not to add one', () => {
  // Reachable state: limits.loadUserApiKey treats a decrypt failure as "no
  // key on file", so a saved-but-unusable key still produces the 429.
  const [first] = CreditOptions.options({ hasApiKey: true });
  assert.match(first.title, /could not be used|couldn't be used/i);
  assert.match(first.cta, /check/i);
  assert.doesNotMatch(first.cta, /^Add /);

  const [fresh] = CreditOptions.options({ hasApiKey: false });
  assert.match(fresh.cta, /^Add /);
  // The destination is the same either way — only the wording changes.
  assert.equal(first.hash, fresh.hash);
});

test('the lead distinguishes your allowance from the shared platform budget', () => {
  assert.match(CreditOptions.lead({}), /you're out of today's free ai credits/i);
  assert.match(CreditOptions.lead({ globalOut: true }), /shared daily ai budget/i);
  // Both states still offer every route: all of them bypass the platform
  // budget.
  assert.equal(CreditOptions.options({ globalOut: true }).length, 3);
});

test('the platform error text is escaped, never injected', () => {
  const html = CreditOptions.cardHtml({ error: '<img src=x onerror="alert(1)">' });
  assert.ok(!html.includes('<img'), 'no raw tag survives into the markup');
  assert.ok(html.includes('&lt;img'), 'it is rendered as escaped text');
  assert.ok(!html.includes('onerror="'), 'no attribute injection');
});

test('the hand-off buttons carry the flow the surface acts on', () => {
  const state = { externalFlowsAvailable: true };
  const card = CreditOptions.cardHtml(state);
  for (const flow of ['claude-code', 'codex']) {
    assert.ok(card.includes(`data-credits-flow="${flow}"`), `card marks ${flow}`);
  }
  // The BYOK and local-tool rows stay plain hash navigations — there is no
  // in-place walkthrough for either.
  assert.equal((card.match(/data-credits-flow="/g) || []).length, 2);
  // #1348: the BANNER carries no flows at all now. It offers one venue
  // door rather than a button per venue, and the sheet behind it dispatches
  // the walkthrough — so a flow attribute here would be a second, staler
  // way into the same thing.
  const banner = CreditOptions.bannerActionsHtml(state);
  assert.equal((banner.match(/data-credits-flow="/g) || []).length, 0);
  assert.match(banner, /data-credits-venue="1"/);
});

test('the CARD renders one actionable control per route', () => {
  // The card is where every route is spelled out with its blurb — #1348
  // moved that job here alone, so this assertion moved with it.
  const card = CreditOptions.cardHtml({});
  for (const option of CreditOptions.options({})) {
    assert.ok(
      card.includes(`data-credits-hash="${option.hash}"`),
      `card links ${option.hash}`
    );
  }
  // The card is identifiable so dev-chat can wire it after each render.
  assert.match(card, /data-credits-card="1"/);
});

test('the banner offers exactly two doors: pay for it, or build elsewhere (#1348)', () => {
  const banner = CreditOptions.bannerActionsHtml({ externalFlowsAvailable: true, sessionBridgeEnabled: true });
  const buttons = banner.match(/<button/g) || [];
  assert.equal(buttons.length, 2, 'the bar is two buttons whatever the deployment offers');
  assert.match(banner, /Add API key/);
  assert.match(banner, /Change session type/);
  // The banner keeps the historical id on its first button so any existing
  // selector against it still resolves.
  assert.match(banner, /id="dc-credits-add-key"/);
});

test('an unverified account is asked to connect before it is asked to pay', () => {
  // It cannot spend credits at all yet, so "Add API key" is not the lead
  // remedy — but the second door is the same one.
  const banner = CreditOptions.bannerActionsHtml({ verificationRequired: true });
  assert.equal((banner.match(/<button/g) || []).length, 2);
  assert.match(banner, /Connect GitHub or X/);
  assert.match(banner, /Change session type/);
  assert.doesNotMatch(banner, /Add API key/);
});

test('wire() navigates by hash and is idempotent per node', () => {
  // Minimal DOM stand-in: enough to prove one handler is attached and that
  // it sets location.hash rather than pushing history itself.
  const handlers = [];
  const node = {
    addEventListener(type, fn) { handlers.push({ type, fn }); },
    contains() { return true; },
  };
  CreditOptions.wire(node);
  CreditOptions.wire(node);
  assert.equal(handlers.length, 1, 'a second wire() call does not stack handlers');

  const originalWindow = global.window;
  global.window = { location: { hash: '' } };
  try {
    handlers[0].fn({
      target: { closest: () => ({ getAttribute: () => '#settings/connectors' }) },
      preventDefault() {},
    });
    assert.equal(global.window.location.hash, '#settings/connectors');
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});

test('a flow click is handled in place, or falls through to the hash', () => {
  // #1049: the dev chat handles 'claude-code'/'codex' itself (it starts the
  // walkthrough in the message list). A surface that wires no onFlow handler
  // must still go somewhere — the option's hash.
  function fireFlowClick(handlers) {
    const listeners = [];
    const node = {
      addEventListener(type, fn) { listeners.push(fn); },
      contains() { return true; },
    };
    CreditOptions.wire(node, handlers);
    const attrs = { 'data-credits-flow': 'codex', 'data-credits-hash': '#settings/connectors' };
    let prevented = false;
    listeners[0]({
      target: { closest: () => ({ getAttribute: (name) => attrs[name] || null }) },
      preventDefault() { prevented = true; },
    });
    return prevented;
  }

  const picked = [];
  assert.equal(fireFlowClick({ onFlow: (flow) => picked.push(flow) }), true);
  assert.deepEqual(picked, ['codex'], 'the handler receives the flow id');

  const originalWindow = global.window;
  global.window = { location: { hash: '' } };
  try {
    fireFlowClick({});
    assert.equal(
      global.window.location.hash, '#settings/connectors',
      'with no onFlow handler the button is an ordinary hash navigation'
    );
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});

test('all three surfaces render from the shared module', () => {
  // The reason the module exists: none of the three call sites may inline
  // its own copy of the routes.
  assert.match(DEV_CHAT_SRC, /CreditOptions\.cardHtml\(msg\.creditsCard\)/,
    'the dev-chat message card renders the shared card');
  assert.match(DEV_CHAT_SRC, /CreditOptions\.bannerActionsHtml\(/,
    'the credits banner renders the shared button row');
  assert.match(APP_VIEW_SRC, /CreditOptions\.cardHtml\(state\)/,
    'the Generate-proposal modal renders the shared card');

  // And the module has to be loaded before its consumers. #1084 chunk G moved
  // dev-chat.js into the React bundle, whose entry is `type="module"` and so
  // deferred past every classic /js/** script — that attribute is the ordering
  // guarantee for that consumer now, in place of a tag position.
  const creditIdx = INDEX_SRC.indexOf('/js/credit-options.js');
  const appViewIdx = INDEX_SRC.indexOf('/js/app-view.js');
  assert.ok(creditIdx > 0, 'credit-options.js is loaded by the shell');
  assert.ok(creditIdx < appViewIdx, 'loaded before app-view.js');
  assert.ok(!INDEX_SRC.includes('src="/js/dev-chat.js"'),
    'dev-chat.js is bundled now (chunk G) — it must not come back as a tag');
  assert.ok(INDEX_SRC.includes('<script type="module" src="/shell/assets/shell.js">'),
    'the React entry must stay a deferred module so DevChat sees window.CreditOptions');
});

test('the dev chat renders the refusal as a card, not as prose', () => {
  // The old behaviour pushed a markdown paragraph that named only the BYOK
  // route. Guard against a regression back to that.
  assert.match(
    DEV_CHAT_SRC,
    /data\.code === 'budget_exceeded'[\s\S]{0,1800}creditsCard:/,
    'the budget_exceeded branch pushes a creditsCard row'
  );
  assert.doesNotMatch(
    DEV_CHAT_SRC,
    /Open Settings from the menu \(or use the banner above\) to add your key/,
    'the BYOK-only prose reply is gone'
  );
});

test('the Generate-proposal path shows the card instead of a bare toast', () => {
  assert.match(
    APP_VIEW_SRC,
    /data\.code === 'budget_exceeded'[\s\S]{0,200}_showCreditOptionsModal/,
    'a budget refusal opens the three-route modal'
  );
});

// ── #1281: routing the card by who you are ──────────────────────────────
//
// The spec's out-of-credits screen shows the routes anyone can follow
// first, and puts the two that need a terminal behind an "Are you a
// developer?" expander. What makes that safe to do is that it is a
// DISCLOSURE change and nothing else: `options()` still returns every
// route to every surface, so nothing is removed and no caller has to know
// about the split.

test('the two routes that need a terminal are the developer ones', () => {
  // sessionBridgeEnabled so BOTH terminal routes are present — the point of
  // this test is which side of the expander each lands on, which needs them
  // both in the list to be worth asserting.
  const options = CreditOptions.options({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  });
  const byId = Object.fromEntries(options.map((o) => [o.id, o]));

  // Derived from the venue's mechanism (lease / import), not from a list of
  // ids: a seventh venue must land on the right side by declaring what it
  // is. `local` is the CLI lease, `own-tools-pr` is fork-branch-and-import.
  assert.equal(byId.local.developer, true, 'the CLI lease needs a terminal');
  assert.equal(byId['own-tools-pr'].developer, true, 'importing a PR needs git');

  // Everything a person can do from the browser alone stays primary —
  // including the API key, which the spec puts in the first group.
  assert.equal(byId['web-claude-code'].developer, false);
  assert.equal(byId['web-codex'].developer, false);
  assert.equal(byId['api-key'].developer, false);

  // The flag is on every route, so `partition` can never silently drop one.
  for (const option of options) {
    assert.equal(
      typeof option.developer, 'boolean', `${option.id} declares who it is for`
    );
  }
  const split = CreditOptions.partition(options);
  assert.equal(
    split.primary.length + split.developer.length, options.length,
    'partition is a split, not a filter'
  );
  assert.deepEqual(split.developer.map((o) => o.id), ['local', 'own-tools-pr']);
  assert.deepEqual(
    split.primary.map((o) => o.id),
    ['web-claude-code', 'web-codex', 'api-key'],
    'the primary half keeps the order options() chose'
  );
});

test('the card shows the primary routes first and hides the developer ones', () => {
  const card = CreditOptions.cardHtml({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  });
  const expander = card.indexOf('data-credits-dev="1"');
  assert.ok(expander > -1, 'the card carries the expander');
  assert.match(card, /Are you a developer\?/);

  // Position is the assertion that matters: a primary route rendered INSIDE
  // the expander is hidden from the people it was written for, and a
  // developer route rendered outside it is the flat list this replaced.
  for (const id of ['#settings/connectors', '#settings/api-key']) {
    const at = card.indexOf(`data-credits-hash="${id}"`);
    assert.ok(at > -1 && at < expander, `${id} renders before the expander`);
  }
  assert.ok(
    card.lastIndexOf('data-credits-hash="#settings/cli"') > expander,
    'the on-your-computer routes render inside the expander'
  );

  // Still one control per route, expanded or not — the existing
  // "one actionable control per route" test proves the card links every
  // hash; this proves hiding them did not turn them into plain text.
  assert.equal(
    (card.match(/class="dc-pr-btn dc-credits-go"/g) || []).length,
    CreditOptions.options({ externalFlowsAvailable: true, sessionBridgeEnabled: true }).length,
    'every route keeps its button'
  );
});

test('the count still spells the whole list, not just the visible half', () => {
  // Three rows and an expander over "Five ways to keep building right now"
  // is a promise the card keeps. Counting only the visible three would hide
  // that the other two exist — the discovery failure this card exists for.
  const card = CreditOptions.cardHtml({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  });
  assert.match(card, /Five ways to keep building/);
});

test('no developer routes means no expander at all', () => {
  // Gating is by omission (see build-venues.js), so a deployment with no
  // CLI and a viewer who cannot push branches has nothing to disclose. An
  // empty "Are you a developer?" would be a question with no answer.
  const card = CreditOptions.cardHtml({
    externalFlowsAvailable: true, cliAuthEnabled: false, canCollaborate: false,
  });
  assert.doesNotMatch(card, /data-credits-dev/);
  assert.doesNotMatch(card, /Are you a developer/);
});

test('the compact banner stays flat', () => {
  // The banner is a one-line strip of affordances beside the refusal, not
  // the screen where the choice is made. Putting a disclosure widget in the
  // surface with the least room to explain itself would cost two clicks to
  // reach a route that is one click away today.
  const state = { externalFlowsAvailable: true, sessionBridgeEnabled: true };
  const banner = CreditOptions.bannerActionsHtml(state);
  assert.doesNotMatch(banner, /data-credits-dev/);
  assert.doesNotMatch(banner, /<details/);
  // #1348: and it no longer grows with the deployment either. Every route
  // used to be a button here, so a deployment with more venues got a wider
  // strip; the second door is one button whatever is behind it.
  assert.equal((banner.match(/data-credits-hash="/g) || []).length, 2);
  assert.ok(
    CreditOptions.options(state).length > 2,
    'this only means something while the full list is longer than the bar',
  );
});

test('the expander needs no wiring — the browser owns the toggle', () => {
  // wire() looks for [data-credits-flow] / [data-credits-hash]. The summary
  // matches neither, so the click falls through to the browser instead of
  // being preventDefault()ed into a dead control.
  const card = CreditOptions.cardHtml({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  });
  const summary = card.match(/<summary[^>]*>/)[0];
  assert.doesNotMatch(summary, /data-credits-hash/);
  assert.doesNotMatch(summary, /data-credits-flow/);
});
