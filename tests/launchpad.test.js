// Shared own-tools setup guide, session context, and web hand-off regressions (#1891).

const test = require('node:test');
const assert = require('node:assert/strict');

const Launchpad = require('./lib/launchpad');
const BuildVenues = require('../public/js/build-venues.js');

const { renderComponent } = require('./lib/render-tsx');
const ownToolsHtml = (state) => renderComponent(
  'frontend/src/features/dev-chat/own-tools-guide.tsx', 'OwnToolsGuide',
  { view: { prompt: Launchpad.prefillText(state), resumeHtml: Launchpad.resumeBannerHtml(state), canImport: state.canImport !== false } },
);

test('the launchpad venues are exactly the ones with no Homeroom chat', () => {
  // build-venues.js already answers this, per venue, with `chat`. This
  // module keeps its own list so it still works loaded alone — so the two
  // have to be asserted equal, or they are free to drift.
  const chatless = BuildVenues.VENUES.filter((v) => !v.chat).map((v) => v.id);
  assert.deepEqual([...Launchpad.LAUNCHPAD_VENUES].sort(), [...chatless].sort());

  for (const id of chatless) assert.ok(Launchpad.isLaunchpad(id), `${id} launches`);
  for (const v of BuildVenues.VENUES.filter((x) => x.chat)) {
    assert.ok(!Launchpad.isLaunchpad(v.id), `${v.id} keeps its composer`);
  }
  // A venue id that is not a venue must not launch anything either.
  assert.ok(!Launchpad.isLaunchpad('nonsense'));
  assert.ok(!Launchpad.isLaunchpad(null));
  assert.ok(!Launchpad.isLaunchpad(undefined));
});

test('the proposal prompt names the app, issue, and brief for either local agent', () => {
  const text = Launchpad.prefillText({ slug: 'usernode-2d5619', issueNumber: 1891, sessionTitle: 'Fix the guide' });
  assert.match(text, /Create a proposal for the Homeroom app `usernode-2d5619`/);
  assert.match(text, /What to build: issue #1891: Fix the guide/);
  assert.match(text, /Read the issue and its discussion/);
  assert.match(text, /link the proposal to issue #1891/);
  assert.doesNotMatch(text, /claude mcp|prepare_work|submit_work|own fork/);
});

test('a session with no request falls back to its own title, then to a blank', () => {
  const titled = Launchpad.prefillText({ slug: 'app-1', sessionTitle: 'Add a dark mode' });
  assert.match(titled, /What to build: Add a dark mode/);
  assert.doesNotMatch(titled, /issue #/, 'no request number to invent');
  assert.doesNotMatch(titled, /requestNumber/, 'and none on the prepare_work call');

  const bare = Launchpad.prefillText({ slug: 'app-1' });
  assert.match(bare, /<describe the change here>/,
    'an empty brief is an obvious blank to fill in, not a confident lie');

  // No slug at all still produces a runnable shape rather than "undefined".
  const noSlug = Launchpad.prefillText({});
  assert.doesNotMatch(noSlug, /undefined|null/);
  assert.match(noSlug, /<app slug>/);
});

test('a non-numeric or nonsense request number is ignored, not printed', () => {
  for (const issueNumber of ['12; rm -rf /', 0, -3, 1.5, NaN, null, {}]) {
    const text = Launchpad.prefillText({ slug: 'app-1', issueNumber, sessionTitle: 'A change' });
    assert.doesNotMatch(text, /issue #/, `${JSON.stringify(issueNumber)} must not become a request`);
    assert.match(text, /What to build: A change/);
  }
});

test('user content is escaped in the shared guide', () => {
  const html = ownToolsHtml({ slug: '"><img src=x onerror=alert(1)>', sessionTitle: '</pre><script>alert(2)</script>' });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
});

test('own-tools reuses the Settings card with three steps and four copy controls', () => {
  const html = ownToolsHtml({ slug: 'app-1', issueNumber: 7 });
  assert.match(html, /id="dc-cli-setup-guide"/);
  assert.match(html, /Set up a local coding agent/);
  assert.equal((html.match(/<li /g) || []).length, 3);
  for (const label of ['repository setup commands', 'Codex command', 'Claude Code command', 'example proposal prompt']) {
    assert.ok(html.includes(`aria-label="Copy ${label}"`), label);
  }
  assert.match(html, /<code>codex<\/code>/);
  assert.match(html, /<code>claude<\/code>/);
  assert.match(html, /issue #7/);
  assert.doesNotMatch(html, /cli-tokens-list|settings-sidebar|id="cli-setup-guide"|claude mcp/);
  const defaults = renderComponent('frontend/src/features/settings/cli-setup-guide.tsx', 'CliSetupGuide');
  assert.match(defaults, /id="cli-setup-guide"/);
  assert.match(defaults, /Create a proposal for &lt;app name&gt;/);
});

test('manual PR import remains available only to users with access', () => {
  assert.doesNotMatch(ownToolsHtml({ canImport: false }), /data-launchpad-action="import"/);
  assert.match(ownToolsHtml({ canImport: true }), /data-launchpad-action="import"/);
  assert.match(ownToolsHtml({ canImport: false }), /Set up a local coding agent/);
});

// ── The swap: dev-chat renders the launchpad WHERE the composer was ─────
//
// Source guards rather than DOM assertions, for the same reason the rest of
// this repo's chat-view tests are: renderChatView writes one large template
// literal and mounting it needs the whole shell. What is worth pinning is
// the handful of decisions inside it that are easy to undo by accident.

const fs = require('node:fs');
const path = require('node:path');

const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8',
);

test('the composer is HIDDEN, never removed', () => {
  // Every public/js/** and chat-helper module looks its controls up by id
  // (#dc-input, #dc-form, #dc-budget, #dc-runner…). A getElementById that
  // started returning null would throw on a route the checks load, and a
  // console error on any route fails proposal checks — so the composer is
  // hidden beside the launchpad rather than replaced by it.
  // #1078: the composer is a component, so the swap is a `hidden` FIELD of
  // its model rather than an interpolation in the template. Same guarantee,
  // read on both halves of the seam.
  assert.match(DEV_CHAT_SRC, /hidden: !!DevChat\._launchpadVenue\(\),/,
    'the model carries the swap');
  const VIEW_TSX2 = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'view.tsx'), 'utf8');
  assert.match(VIEW_TSX2, /id="dc-launchpad-slot"/);
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.match(COMPOSER_TSX, /id="dc-composer-controls" hidden=\{s\.hidden \|\| undefined\}/);
  // Both always render, so neither id ever disappears from the document —
  // which is what the `hidden` attribute buys over a conditional subtree.
  const at = COMPOSER_TSX.indexOf('id="dc-composer-controls"');
  const body = COMPOSER_TSX.slice(at);
  assert.ok(body.includes('id="dc-form"'), 'the form is inside it');
  assert.doesNotMatch(body.slice(0, body.indexOf('id="dc-form"')), /s\.hidden \?/,
    'and is not rendered conditionally on the same flag');
});

test('the venue control stays outside the swap — it is the way back', () => {
  // The venue selector is the persistent control the spec asks for. If it
  // were inside #dc-composer-controls it would be hidden by exactly the
  // state it exists to undo, stranding the session in its launchpad. #1348
  // moved it further out of reach of the swap, into the session header.
  // The strip is a component now (features/dev-chat/session-header.tsx) and
  // the button is one of its children, so "outside the swap" is a property of
  // where the HEADER is written rather than of where the string landed.
  // The header is written by `renderChatView`; the swap is inside the
  // composer, which is a different file entirely — so the two cannot be
  // compared by position any more, and the guarantee is stronger for it.
  const VIEW_TSX3 = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'view.tsx'), 'utf8');
  assert.match(VIEW_TSX3, /id="dc-session-header"/, 'the session header is painted');
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.ok(COMPOSER_TSX.includes('id="dc-composer-controls"'), 'the swap is the composer\'s');
  assert.doesNotMatch(COMPOSER_TSX, /dc-venue-select/,
    'and the venue selector is not inside the thing it exists to undo');
  const headerTsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'session-header.tsx'), 'utf8');
  assert.match(headerTsx, /<VenueSelect/, 'and the venue selector is in that strip');
});

test('the walkthrough repaints on whichever surface it is living on', () => {
  // Every dev-flow action used to end in renderMessages(), because the card
  // was the last row of the transcript. In a launchpad venue renderMessages
  // deliberately omits it, so repainting that way would freeze the card on
  // its pre-click state — the #1304 class of bug.
  // #1078: both halves of the swap are published — the launchpad slot's
  // markup lives in `_devViewState`, the composer's `hidden` in
  // `_composerView` — so the repaint is two publishes rather than a reach
  // into `#dc-launchpad-slot` with a whole-view fallback behind it.
  const repaint = DEV_CHAT_SRC.match(/_repaintDevFlow\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(repaint, '_repaintDevFlow must exist');
  assert.match(repaint[0], /DevChat\._publishDevView\(\);/);
  assert.match(repaint[0], /DevChat\._publishComposer\(\);/);
  assert.match(repaint[0], /DevChat\._wireLaunchpad\(\);/);
  assert.doesNotMatch(repaint[0], /innerHTML\s*=/, 'and it writes no markup');
  assert.match(DEV_CHAT_SRC, /launchpadHtml: DevChat\._launchpadHtml\(\),/,
    'the slot is a field of the screen model');
  assert.match(
    DEV_CHAT_SRC,
    /_launchpadVenue\(\) \? '' : DevChat\._devFlowHtml\(\)/,
    'and the transcript drops it so it cannot render twice',
  );
  const actions = DEV_CHAT_SRC.match(/async _devFlowAction\([\s\S]*?\n  \},/);
  assert.ok(actions, '_devFlowAction must exist');
  assert.doesNotMatch(actions[0], /DevChat\.renderMessages\(\)/,
    'no dev-flow action may repaint only the transcript');
});

test('the launchpad is wired on every re-render, in its own host', () => {
  // _wireDevFlowCard only ever scans #dc-messages, so a walkthrough card in
  // the launchpad slot needs its own wiring — a card wired by nobody is
  // every button on it doing nothing.
  const wire = DEV_CHAT_SRC.match(/_wireLaunchpad\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(wire, '_wireLaunchpad must exist');
  assert.match(wire[0], /data-flow-wizard/, 'it wires the walkthrough too');
  assert.doesNotMatch(wire[0], /Launchpad\.wire/, 'React handles own-tools controls');
  assert.doesNotMatch(DEV_CHAT_SRC, /_launchpadCopy\(/, 'no legacy mutation of React copy buttons');
  assert.match(DEV_CHAT_SRC, /DevChat\._wireLaunchpad\(\);/, 'called from renderChatView');
});

test('the vendor toggle switches in place and stores the new venue', () => {
  const actions = DEV_CHAT_SRC.match(/async _devFlowAction\([\s\S]*?\n  \},/)[0];
  assert.match(actions, /vendor-claude-code|vendor-codex/, 'both toggle actions are handled');
  assert.match(actions, /_saveDevFlowPreference\(next\)/, 'the saved default moves with it');
  assert.match(actions, /_persistBuildVenue\(venue\)/, 'and so does this session');
  assert.match(actions, /flow\.status = null/,
    'the status is re-read for the new vendor rather than reused');
});

test('the card carries the instructions, because the agent asks for the rest', () => {
  // This replaces the brief field. The launchpad used to collect what to build
  // and mint the work order itself, which is why it had a text box here and a
  // task to get stuck on. It hands over instructions now: the agent asks what
  // to build and mints its own order through the connector.
  const DevFlowSelect = require('../public/js/dev-flow-select.js');
  const ready = {
    github: { linked: true },
    fork: { state: 'ready', owner: 'a', repo: 'b' },
    connectors: { count: 1 },
    instructions: 'Ask the user what to build, then call prepare_work.',
  };

  const html = DevFlowSelect.wizardHtml({ agent: 'codex', status: ready });
  assert.doesNotMatch(html, /data-flow-brief/, 'nothing to type here any more');
  assert.match(html, /Copy instructions/);
  assert.match(html, /Ask the user what to build, then call prepare_work\./,
    'and the text is on the card, for a clipboard that refuses');

  // The step copy must not point at a control the launchpad hides.
  assert.doesNotMatch(html, /message box below/,
    'the composer is not on screen in a launchpad venue');

  // It escapes like everything else: the instructions carry an app name that
  // came from a user.
  const nasty = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: { ...ready, instructions: '<img src=x onerror=alert(1)>' },
  });
  assert.doesNotMatch(nasty, /<img src=x/);
  assert.match(nasty, /&lt;img src=x/);

  // With no connector there is nothing to hand over yet, so no instructions
  // block either.
  const unconnected = DevFlowSelect.wizardHtml({
    agent: 'codex', status: { ...ready, connectors: { count: 0 } },
  });
  assert.match(unconnected, /data-flow-action="link-connector"/);
  assert.doesNotMatch(unconnected, /Copy instructions/);
});
test('preparing reads the card first and the composer only as a fallback', () => {
  // In a launchpad venue #dc-input is hidden, so reading it would make
  // "Prepare work order" permanently impossible — the button would report
  // an empty brief no matter what the user typed.
  const fn = DEV_CHAT_SRC.match(/async _devFlowPrepare\([\s\S]*?\n  \},/);
  assert.ok(fn, '_devFlowPrepare must exist');
  const body = fn[0];
  const cardAt = body.indexOf("querySelector('[data-flow-brief]')");
  const composerAt = body.indexOf("getElementById('dc-input')");
  assert.ok(cardAt > -1, 'it reads the card field');
  assert.ok(composerAt > cardAt, 'and the composer only after it, as a fallback');
  assert.match(body, /flow\.brief = brief/, 'the brief survives the repaints that follow');
});

test('dismissing a launchpad repaints BOTH halves of the swap', () => {
  // "Build on Homeroom instead" changes the SWAP. Repainting only the slot
  // would empty the launchpad and leave the composer still hidden behind it
  // — a session with no way to type at all.
  //
  // #1078: that used to need a whole `renderChatView`, because the slot's
  // markup and the composer's `hidden` were baked into one innerHTML string
  // and the only way to change which one was on screen was to write it
  // again. They are two publishes now, and BOTH are unconditional — which is
  // the same guarantee without the fall-through, and without throwing the
  // transcript away to get it.
  const fn = DEV_CHAT_SRC.match(/_repaintDevFlow\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(fn);
  assert.match(fn[0], /DevChat\._publishDevView\(\);/, 'the slot');
  assert.match(fn[0], /DevChat\._publishComposer\(\);/, 'and the composer that hides behind it');
  assert.doesNotMatch(fn[0], /renderChatView\(\)/,
    'and neither needs the screen rebuilt to land');
  // Both read the same predicate, so they cannot disagree about the swap.
  assert.match(DEV_CHAT_SRC, /barEmpty: !!DevChat\._launchpadVenue\(\)/);
  assert.match(DEV_CHAT_SRC, /hidden: !!DevChat\._launchpadVenue\(\),/);
});

test('the web launchpad takes its vendor from the VENUE, not the flow target', () => {
  // Regression: _launchpadHtml delegated to _devFlowHtml, which asks
  // _devFlowTarget() which vendor this is. That answers null in cases where
  // the launchpad is legitimately up — a ?shot=launchpad URL stores no
  // venue, and the saved-preference path additionally wants an untouched
  // session, a linked deployment and no PR — so the panel rendered EMPTY.
  // The venue is what put the launchpad on screen, so it is what knows the
  // vendor.
  const fn = DEV_CHAT_SRC.match(/_launchpadHtml\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(fn, '_launchpadHtml must exist');
  const body = fn[0];
  assert.match(body, /agent: venue === 'web-codex' \? 'codex' : 'claude-code'/,
    'the vendor is derived from the venue');
  assert.doesNotMatch(body, /_devFlowHtml\(\)/,
    'and not routed through the target-gated helper');
  assert.match(body, /_devFlowEnsureStatus\(\)/,
    'the status read still has to be kicked on first paint');
});

test('the walkthrough carries its vendor toggle in every state', () => {
  // A staging page paints before the status read resolves, and a clone
  // often answers "unavailable" — so a toggle that only rendered on the
  // live card would be missing exactly where a reviewer looks first.
  const DevFlowSelect = require('../public/js/dev-flow-select.js');
  const states = [null, { available: false, reason: 'no_repository' }, { github: { linked: true } }];
  for (const status of states) {
    const html = DevFlowSelect.wizardHtml({ agent: 'codex', status });
    assert.match(html, /dc-flow-vendors/, `toggle missing for ${JSON.stringify(status)}`);
    assert.match(html, /data-flow-action="vendor-claude-code"/);
    // The vendor you are already on is a statement, so it is inert.
    assert.match(html, /dc-flow-vendor-on[^>]*>ChatGPT|ChatGPT<\/button>/);
  }
});

// ── #1350: continuing a branch vs starting fresh ────────────────────

test('the prefill switches shape when there is a branch to continue', () => {
  const resume = Launchpad.prefillText({
    slug: 'usernode-2d5619',
    sessionTitle: 'Rework build method UI',
    targetKind: 'session',
    targetId: 990401,
    branchName: 'dev/evan-1750000000000',
  });
  // The whole point of the resume shape: an agent handed a branch that
  // already has commits must not start over from the default branch.
  assert.match(resume, /Continue work already started/);
  assert.match(resume, /dev\/evan-1750000000000/, 'names the branch by hand');
  assert.match(resume, /Continue session #990401/, 'identifies the existing work');
  assert.match(resume, /Do not start over/i);
  assert.match(resume, /current head of that branch/);
  assert.match(resume, /Preserve the existing work/);

  // A brand-new session (deferred branch, nothing run yet) keeps the
  // original start-work shape rather than pointing at a branch that is
  // not there.
  const fresh = Launchpad.prefillText({
    slug: 'usernode-2d5619',
    sessionTitle: 'Rework build method UI',
    targetKind: 'new',
    targetId: 990409,
    branchName: null,
  });
  assert.doesNotMatch(fresh, /Continue work already started/);
  assert.doesNotMatch(fresh, /proposalId/);
  assert.match(fresh, /Create a proposal/);
});

test('a half-filled resume target falls back to starting work', () => {
  // Each of these is a state the shell can genuinely be in mid-load. A
  // prefill that named a blank branch would send the agent looking for a
  // ref that does not exist, which is worse than starting clean.
  const degenerate = [
    { targetKind: 'session', targetId: 990401, branchName: '' },
    { targetKind: 'session', targetId: null, branchName: 'dev/evan-1' },
    { targetKind: 'new', targetId: 990401, branchName: 'dev/evan-1' },
  ];
  for (const extra of degenerate) {
    const text = Launchpad.prefillText({ slug: 'app-1', sessionTitle: 'A change', ...extra });
    assert.doesNotMatch(text, /Continue work already started/, JSON.stringify(extra));
    assert.doesNotMatch(text, /undefined|null/);
  }
});

test('the resume banner says which of the two things is happening', () => {
  const cont = Launchpad.resumeBannerHtml({
    targetKind: 'session', targetId: 990401, branchName: 'dev/evan-1750000000000',
  });
  assert.match(cont, /data-launchpad-resume="continue"/);
  assert.match(cont, /dev\/evan-1750000000000/);

  const fresh = Launchpad.resumeBannerHtml({ targetKind: 'new', targetId: 990409, branchName: null });
  assert.match(fresh, /data-launchpad-resume="new"/);
  assert.doesNotMatch(fresh, /<code/, 'no branch to name');

  // A branch name is user-adjacent text that lands inside the markup.
  const nasty = Launchpad.resumeBannerHtml({
    targetKind: 'session', targetId: 1, branchName: 'dev/<img src=x onerror=alert(1)>',
  });
  assert.doesNotMatch(nasty, /<img/);
  assert.match(nasty, /&lt;img/);
});
