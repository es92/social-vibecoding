// Guard test for src/prompts/app-conventions.md (#218), the conventions a
// coding agent building an app here is given. Its sections are load-bearing:
// the platform's own code cites them by name ("Staging mock data", "Time-
// dependent features"), and the escalation section's feature-request framing
// is what keeps agents from being overly conservative about raising a
// platform gap. A doc edit that dropped or renamed one fails here.
//
// Run with: node --test tests/app-conventions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAppConventions, getConventionSection } = require('../src/services/prompts.js');

const ESCALATION_HEADING =
  'Platform-level problems & missing capabilities: escalate, don\'t file workarounds';

// #6815: nothing visible means no before/after shots, so the author's diagram
// is the only picture voters get. The guidance says so, with an example.
test('conventions doc asks for a diagram after a change with nothing visible', () => {
  const doc = getAppConventions().replace(/\s+/g, ' ');
  // The offline excerpt is capped at 9 KB, so it carries the step and a valid
  // example; the kinds and the size rule are spelled out below it.
  assert.match(doc, /record `impact: "none"` with a specific rationale\. Then call `declare_diagram`: `\{"version":1,"kind":"flow","before":\["A"\],"after":\["B"\]\}`\./);
  assert.match(doc, /declare a diagram of it: `flow`, `changes`, `numbers` or `rename`, plain words, 1-60 characters a text, e\.g\. `\{"version":1,"kind":"flow"/);
  // Both examples are diagrams the platform accepts, not invented shapes.
  const { parseDiagram } = require('../src/services/diagram.js');
  for (const [, json] of doc.matchAll(/(\{"version":1,"kind":"flow",[^`]*\})/g)) {
    assert.doesNotThrow(() => parseDiagram(JSON.parse(json), { impact: 'none' }), json);
  }
});

test('conventions doc loads non-empty', () => {
  const doc = getAppConventions();
  assert.equal(typeof doc, 'string');
  assert.ok(doc.length > 0, 'app-conventions.md should load');
});

test('conventions doc carries the "Staging mock data" section (#218)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Staging mock data$/m);
});

test('conventions doc carries the escalation section, covering feature requests', () => {
  const doc = getAppConventions();
  assert.ok(
    doc.includes(`## ${ESCALATION_HEADING}`),
    'escalation section heading missing or renamed'
  );
  // The broadened framing is load-bearing: agents must treat missing
  // platform capabilities / feature requests as worth escalating, not just
  // breakage.
  assert.match(doc, /Missing platform capabilities/);
  assert.match(doc, /Feature requests are as valid as bug reports/);
});

test('conventions doc carries the test-suite discipline section', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Repo test suites on build turns — run them efficiently$/m);
  // The batch-fix rule is the load-bearing instruction: it is what stops
  // the fix-one-rerun-all loop that made big build turns (e.g. session
  // 3255) spend 20+ minutes on redundant full-suite passes.
  assert.match(doc, /Batch-fix before retesting/);
  assert.match(doc, /At most two full-suite passes per turn/);
});

test('conventions doc carries the issue-state snapshots section (#685)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Issue-state snapshots — opt-in app state in filed issues$/m);
  // The sanitization framing is load-bearing: registering the provider
  // is the app's declaration that its snapshot is safe to publish.
  assert.match(doc, /usernode\.issueState\.register/);
  assert.match(doc, /PUBLIC GitHub issue bodies/);
});

test('conventions doc carries the screenshot-state deep-link section (#768)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^### Make the changed screen URL-reachable — screenshot-state deep links$/m);
  // The @mobile annotation is documented alongside it — the capture
  // pipeline parses it (testing-notes.js), so the doc must keep teaching it.
  assert.match(doc, /@mobile/);
});

test('conventions doc carries the user-directory section (#1195)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## User directory — does this handle exist\?$/m);
  // Both surfaces: the server-side platform API and the bridge helpers.
  assert.match(doc, /\/users\/lookup\?username=/);
  assert.match(doc, /\/users\/search\?q=/);
  assert.match(doc, /usernode\.lookupUser/);
  assert.match(doc, /usernode\.searchUsers/);
  // The field allowlist is the point of the section — apps must not
  // plan features around data the directory will never return.
  assert.match(doc, /only\*\* `\{ id, username \}`/);
  // The staging story: BOTH paths now work in previews (#1213), and the
  // frontend degrade rule is still fail-OPEN.
  assert.match(doc, /staging previews/i);
  assert.match(doc, /degrade open/i);
  // The case-collision flag apps have to handle.
  assert.match(doc, /ambiguous.*true/);
});

// A 4 October 2026 first-session run: a group's chore rota showed "Staging
// demo Maya" and the check runner's handle in its preview, because an app
// had no member list to ask for. The section tells the next app to ask for
// it, and why it must not fake it in staging.
test('conventions doc tells apps where "everyone in the group" comes from', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Members: who is in this project$/m);
  const section = doc.slice(doc.indexOf('## Members: who is in this project'));
  const body = section.slice(0, section.indexOf('\n## ', 1));
  assert.match(body, /\$\{PLATFORM_API_BASE\}\/members/);
  assert.match(body, /previews included/);
  assert.match(body, /\*\*real\*\* members/);
  assert.match(body, /not_a_member/);
  assert.match(body, /Never "whoever has opened the app"/);
  assert.match(body, /Never a staging fixture of fake people for this/);
  assert.match(body, /req\.query\.demo === '1'/);
  // The always-read rules point at it, and the user-token-only exception
  // names it beside /users/*.
  assert.match(doc, /"Everyone in the group" is `GET \/members`/);
  assert.match(doc, /endpoints and `\/members` \(see "Members"\)/);
});

// On 5 October 2026 a group was asked to approve a Thursday-evening bins
// reminder nobody could see: Try it opened on a Monday and the shots could
// not show it. The section tells a builder to read "now" through the
// platform, say when the change shows, and declare the moment to see it at
// (services/preview-clock.js parses the declaration).
test('conventions doc has a "Time-dependent features" section with the preview clock contract', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## Time-dependent features$/m);
  const section = doc.slice(doc.indexOf('## Time-dependent features'));
  const body = section.slice(0, section.indexOf('\n## ', 1));
  assert.match(body, /`usernode\.now\(\)`/);
  assert.match(body, /`req\.now`/);
  assert.match(body, /req\.headers\['x-usernode-now'\] \|\| req\.query\['un-now'\]/);
  // The snippet is the scaffold's own helper, so an older app adds exactly
  // what a new one ships with.
  const { getTemplateFiles } = require('../src/services/template');
  const server = getTemplateFiles('Bins', 'bins-1a2b3c', 'postgres://x').find((f) => f.path === 'server.js').content;
  const helper = server.slice(server.indexOf('const IS_STAGING'), server.indexOf('\n}\n', server.indexOf('function requestNow')) + 2);
  assert.ok(helper.length > 100 && body.replace(/\n {5}/g, '\n').includes(helper), 'the doc carries the scaffold helper verbatim');
  assert.match(body, /IS_STAGING \?/, 'the server reads it only on staging');
  assert.match(body, /\*\*Production ignores it entirely\.\*\*/);
  assert.match(body, /\*\*Say when it shows\*\*/);
  assert.match(body, /<!-- usernode:preview-at 2026-10-08T19:00 Europe\/London -->/);
  assert.match(body, /Showing it as on Thursday 8 Oct, 7 pm/);
  assert.match(body, /`testingSteps`/);
  assert.match(body, /\?un-now=2026-10-08T18:00:00Z/);
  assert.doesNotMatch(body, /—/, 'no em dashes');
  // The declaration the doc teaches is the one the platform parses.
  const clock = require('../src/services/preview-clock');
  assert.equal(clock.declaredMoment(body).label, 'Thursday 8 Oct, 7 pm');
});

test('the server-side directory section covers staging previews (#1213)', () => {
  const doc = getAppConventions();
  // Retitled from "(production)" — previews can reach the directory now.
  assert.match(doc, /^### From your server \(production AND staging previews\)$/m);
  // One code path, one conditional header: the app token is sent only
  // when its env var exists (production); previews send the user token
  // alone.
  assert.match(doc, /if \(process\.env\.USERNODE_LLM_PROXY_TOKEN\) \{/);
  assert.match(doc, /send \*\*only\*\*\n\s*`x-usernode-user-token`/);
  // The version-pinned URL and legacy fallback are injected into both
  // environments…
  assert.match(doc, /`USERNODE_PLATFORM_API_V1_URL` and its legacy fallback are injected into\n\*\*both\*\* production and staging containers/);
  // …but the governance feed stays token-gated, so the FEED_ENABLED
  // check that ANDs both env vars must still be documented as required.
  assert.match(doc, /`FEED_ENABLED` check above \(which ANDs `PLATFORM_API_BASE` \*\*and\*\*\n`USERNODE_LLM_PROXY_TOKEN`\) remains correct and required/);
});

test('app-facing APIs publish a pinned v1 directory contract (#1908)', () => {
  const doc = getAppConventions();
  assert.match(doc, /^## App-facing platform API — use the pinned v1 base$/m);
  assert.match(doc, /USERNODE_PLATFORM_API_V1_URL/);
  assert.match(doc, /Within v1, existing route paths, response field names, field types, and\nfield meanings stay compatible/);
  assert.match(doc, /breaking shape\nrequires a new `\/v2` path and `USERNODE_PLATFORM_API_V2_URL`/);
  assert.match(doc, /unversioned paths and\n`USERNODE_PLATFORM_API_URL` remain aliases of v1/);
  assert.match(doc, /^## App directory — apps and contributors$/m);
  assert.match(doc, /`GET \/apps` on `PLATFORM_API_BASE`/);
  assert.match(doc, /'x-usernode-app-token': process\.env\.USERNODE_LLM_PROXY_TOKEN/);
  assert.match(doc, /Use the returned `url`, never rebuild a hostname from `slug`/);
  assert.match(doc, /obviously fake directory fixture/);
});

test('the offline essentials excerpt points at the user directory (#1195)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);
  // One clause on rule 8, next to the LLM proxy and file storage — an
  // agent that never reads the full doc still learns the capability
  // exists rather than inventing a directory from seen users.
  assert.match(excerpt, /usernode\.lookupUser\(\)/);
  assert.match(excerpt, /never a guess from users your app has already seen/);
});

test('conventions doc warns that seeding must not fabricate a signal (#1212)', () => {
  const doc = getAppConventions();
  assert.match(
    doc, /^### Seeded data must not fabricate a signal your logic reads$/m,
    'the seeding/logic-interaction subsection is missing or renamed'
  );
  const section = doc.slice(
    doc.indexOf('### Seeded data must not fabricate a signal your logic reads'),
    doc.indexOf('### Make the changed screen URL-reachable')
  );
  // The three habits are the load-bearing part: each one is what the real
  // case (Todo List invite validation, #1212) actually needed.
  assert.match(section, /\*\*Never seed the visitor\.\*\*/);
  assert.match(section, /\*\*Request-time seeding only behind `\?demo=1`\.\*\*/);
  assert.match(section, /\*\*Ask what the empty database answers\.\*\*/);
  // And the remedy an author can act on: assert the production shape on
  // the route that carries no seeding.
  assert.match(section, /declare a test on the\nunseeded route/);
});

test('the Proposal tests section names the gate\'s staging-only blind spot (#1212)', () => {
  const doc = getAppConventions();
  const checks = doc.slice(
    doc.indexOf('## Proposal tests — "CI for proposals"'),
    doc.indexOf('## Repo test suites on build turns')
  );
  assert.ok(checks.length > 500, 'the Proposal tests section is still there');
  assert.match(checks, /What the checks cannot see/);
  // The cross-reference has to keep matching the subsection's heading, or
  // the pointer dangles the way #218's did.
  assert.match(checks, /Seeded data must not fabricate a signal your logic reads/);
});

test('the offline essentials excerpt carries the fake-identity seed rule (#1212)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);
  // Rule 3 is the seeding rule, and an agent that only ever reads the
  // excerpt has to learn that seeding can become an INPUT to its own logic.
  assert.match(excerpt, /Seed FAKE identities only/);
  assert.match(excerpt, /never a signal your own logic reads/);
});

test('the excerpt and the full Tailwind section agree about the CDN (#1215)', () => {
  const doc = getAppConventions();
  const begin = doc.indexOf('<!-- work-order:begin -->');
  const end = doc.indexOf('<!-- work-order:end -->');
  assert.ok(begin >= 0 && end > begin, 'work-order markers must survive');
  const excerpt = doc.slice(begin, end);

  // The excerpt used to call a `cdn.tailwindcss.com` tag forbidden and
  // "rejected by two automated checks", while the section below called the
  // hosted copy a MIGRATION TARGET for apps still on that CDN. An agent
  // reading only the excerpt could only conclude the app was in violation
  // or the rules were wrong; both cost more than the sentence saved.
  const tailwind = doc.slice(
    doc.indexOf('## Tailwind — precompiled per app, runtime centrally hosted'),
    doc.indexOf('## Vendored shared files')
  );
  assert.ok(tailwind.length > 500, 'the full Tailwind section is still there');

  // Both halves name the same one-line migration target.
  const TARGET = /usernode-tailwind\/v1\/tailwind\.js/;
  assert.match(excerpt, TARGET);
  assert.match(tailwind, TARGET);

  // And neither claims a check rejects the CDN, because none does.
  assert.doesNotMatch(excerpt, /rejected by/i);
  assert.match(tailwind, /No proposal check rejects a `cdn\.tailwindcss\.com` tag/);
});

test('a first version\'s populated demo: the viewer\'s own data, a screen and a half, labelled once, every control; nothing else changes (7 Oct 2026)', () => {
  const doc = getAppConventions();
  const mock = doc.slice(doc.indexOf('## Staging mock data'), doc.indexOf('### Seeded data must not fabricate a signal your logic reads'));
  // The general rule names the carve-out that wins over it, as "Small" does.
  // Run 196's blind grades: a first version's boot-time rows were stamped
  // "Sample data" on each row too, so the carve-out names them.
  assert.match(mock, /- \*\*Obviously fake\.\*\* Give seeded rows a consistent "Sample data …"\n  prefix so they can't be mistaken for real user content\. \(A first\n  version's `\?demo=1` demo, and any rows it seeds on boot, are\n  labelled once instead, on an element marked\n  `data-usernode-demo-note`: see "A first version's populated demo"\n  below\.\)/);
  assert.match(mock, /- \*\*Small\.\*\* A handful of rows — just enough for the testing steps\.\n  \(A project's first version is the one exception: see "A first\n  version's populated demo" below\.\)/);
  const demo = mock.slice(mock.indexOf("### A first version's populated demo"));
  assert.ok(demo.length > 500, 'the carve-out is there, inside "Staging mock data"');
  const flat = demo.replace(/\s+/g, ' ');
  assert.match(flat, /For that build only, and on `\?demo=1` only, four seed rules change\. Every later change keeps the rules above\./);
  assert.match(flat, /\*\*Enough to look lived in\.\*\* Varied, realistic rows filling about a screen and a half of the main screen at phone width \(390×844\), not a handful\. - \*\*Labelled once/);
  // Labelled once, at the top or in the list's name, not on every row; the rows stay made up.
  assert.match(flat, /\*\*Labelled once, not on every row\.\*\* The screen says "Sample data" once, plainly and visibly: a banner or a line of its own at the top of the screen \(never the app's name, nor in place of its tagline\), or the name of the list or collection the rows belong to\. Each row needs no label of its own \(a "Sample data" pill or prefix on every row only clutters the screen\), and this replaces the "Sample data …" prefix above for these rows\. The rows themselves stay obviously made up: no real people and no real private data\./);
  // Newcomer run seven (14 Oct 2026): the label's element is marked, so
  // Homeroom can hide it where it shows the app under a label of its own.
  assert.match(flat, /no real private data\. The element that carries the label gets the attribute `data-usernode-demo-note`: the banner or the line itself, or, in a list's name, a `<span data-usernode-demo-note>` around the label's own words, so the name stays\. Homeroom hides that element where it shows the app with its sample data under a label of its own\./);
  assert.doesNotMatch(flat, /Each still reads "Sample data/);
  assert.match(flat, /\*\*The viewer's own data too\.\*\*/);
  assert.match(flat, /Either add the viewer's demo rows to the `\?demo=1` responses without storing them, or write them for the viewing account on its first `\?demo=1` request, once \(fixed ids, `ON CONFLICT DO NOTHING`/);
  assert.match(flat, /the rows land only in staging's own database: that is not cloning production rows, so "Never reference real users" still holds\. Other people in the demo are still fake identities\./);
  assert.match(flat, /\*\*Every control the real screen has\.\*\* .* A "view only" demo that hides them is not a populated screen\./);
  // What does not move: staging only, ?demo=1 only, the plain route's test, and the signal rule.
  assert.match(flat, /nothing is written outside staging, nothing is written by a route without `\?demo=1` \(the page passes `demo=1` on to its own API calls\), boot-time seeding stays with fake identities, and the plain route keeps its test of the production-shaped answer\./);
  assert.match(flat, /The viewer's demo rows must never be what makes a check of the form "has this user done X" pass/);
  assert.doesNotMatch(demo, /—/);
  // The rule it bends says so, and so does the offline excerpt.
  const signal = doc.slice(doc.indexOf('### Seeded data must not fabricate a signal your logic reads'), doc.indexOf('### Make the changed screen URL-reachable'));
  assert.match(signal, /\(A first version's `\?demo=1` demo\n  may give the viewer rows of their own, within the limits of "A first\n  version's populated demo" above; nothing else may\.\)/);
  const excerpt = doc.slice(doc.indexOf('<!-- work-order:begin -->'), doc.indexOf('<!-- work-order:end -->'));
  assert.match(excerpt, /A project's first version is the one\n   exception, on `\?demo=1` only: see "A first version's populated demo"\./);
});

// The shots copies sign in fixture accounts, and Homeroom tells an app who
// is signed in, never their role in it. An app that hard-codes its creator's
// account into a screen makes every change there unshootable (three runs on
// one app's Creator Studio, QuestVerse's PRs 7 to 9), so the doc says so
// where it explains who the before & after shots see.
test('conventions doc says no shots persona is the app\'s creator or admin, and not to hard-code people', () => {
  const doc = getAppConventions();
  const start = doc.indexOf('### Who the before & after shots see');
  assert.ok(start > 0, 'the section is there');
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1)).replace(/\s+/g, ' ');
  assert.match(section, /Six things it cannot do by itself/);
  assert.match(section, /\*\*No persona is your app's creator or one of its admins\.\*\*/);
  assert.match(section, /Homeroom tells your app who is signed in, never their role in it/);
  assert.match(section, /`read_only_admin` and `full_admin` are Homeroom's own administrators, which your app is not told/);
  assert.match(section, /refuses every shots browser, and its changes are skipped/);
  assert.match(section, /Do not hard-code people into a screen the project works on/);
  assert.match(section, /name that way in `hints\.setup`/);
});

// From 2026-10-09 to 10-12, 22 shot runs failed and 13 more changes were
// skipped because the copies lacked the state the change shows, most of
// them new in the proposal itself. A seed in the same proposal reaches the
// after copy, the side a new state needs, so the doc says to add one, and
// squares it with the seed rule: a fixture account is not whoever opened
// the preview, and no seed answers the question the change's code asks.
test('conventions doc says to seed a new state in the same proposal, within the seed rule', () => {
  const doc = getAppConventions();
  const start = doc.indexOf('### Who the before & after shots see');
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1)).replace(/\s+/g, ' ');
  assert.match(section, /\*\*It finds only the data the copies hold\.\*\*/);
  assert.match(section, /add an idempotent, obviously fake seed for it in the same proposal: the seed reaches the after copy, which is the side a state new in this proposal needs\./);
  assert.match(section, /`usernode-capture` is the member/);
  assert.match(section, /a fixture account is one named account, not whoever opens the preview/);
  assert.match(section, /never seed a signal your code reads to decide something, so a seed never answers the question the change's own code asks/);
  assert.match(section, /A reply from an AI feature is seeded as the stored reply, never asked for/);
  assert.match(section, /A seed cannot help a change to a state that already existed, which both copies need/);
  // What no seed or step reaches, and what to declare then (18 Nov 2026).
  assert.match(section, /\*\*Some states cannot be staged at all\.\*\* A controlled failure covers one API GET, never a POST, PUT or DELETE; there is no native phone app/);
  assert.match(section, /two requests cannot be made to race/);
  assert.match(section, /declare `impact: "none"` with a reason that names what the copies cannot do, rather than claim a state they cannot reach/);

  // The seed rule points there, in the full text and in the offline excerpt.
  const visitor = doc.slice(doc.indexOf('**Never seed the visitor.**'), doc.indexOf('**Request-time seeding only'))
    .replace(/\s+/g, ' ');
  assert.match(visitor, /The before & after shots' fixture accounts are not the visitor/);
  const excerpt = doc.slice(doc.indexOf('<!-- work-order:begin -->'), doc.indexOf('<!-- work-order:end -->'))
    .replace(/\s+/g, ' ');
  assert.match(excerpt, /The shots' fixture accounts are not whoever opened the preview: a state new in a change is seeded in that change/);
});

// 21 Oct 2026: a minesweeper first version drew its board as a grid of
// buttons, so a long press selected the numbers and every tap waited on the
// browser's click. A game's play area is drawn on a canvas instead, and the
// first version's spec and build point here by this heading.
test('conventions doc says a game draws its play area on a canvas, with what that takes', () => {
  const doc = getAppConventions();
  const heading = '## Games: draw the play area on a canvas';
  assert.match(doc, /^## Games: draw the play area on a canvas$/m);
  const start = doc.indexOf(heading);
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.match(section, /is drawn on a `<canvas>` and played with pointer events on that canvas\. That holds for turn-based and grid games too: minesweeper, sudoku/);
  assert.match(section, /\*\*Nothing to select or copy\.\*\*/);
  assert.match(section, /\*\*No touch delay\.\*\*/);
  // The rest of the screen stays HTML, from the kits.
  assert.match(section, /What stays HTML is everything that is not the play/);
  // The CSS that makes the difference on a phone, on the play area only.
  for (const rule of ['touch-action: none;', 'user-select: none;', '-webkit-touch-callout: none;']) {
    assert.ok(section.includes(rule), `the play area sets ${rule}`);
  }
  assert.match(section, /\*\*Input is pointer events, never `click`\.\*\*/);
  assert.match(section, /`devicePixelRatio`/);
  assert.match(section, /redraw on `usernode:theme-changed`/);
  // Checks and the in-loop browser can still see and press it.
  assert.match(section, /`data-\*` attributes/);
  assert.match(section, /dispatch `pointerdown` and `pointerup` on the canvas with `browser_evaluate`/);
  // Starters and existing apps keep what they have.
  assert.match(section, /A project built on a game starter keeps the starter's own drawing/);
  assert.match(section, /do not convert one as a drive-by/);
  assert.doesNotMatch(section, /—/);

  // The first version's spec and build name it by this heading.
  const cite = '"Games: draw the play area on a canvas"';
  assert.ok(require('../src/services/prompts.js').FIRST_VERSION_SPEC_DESIGN_BRIEF.includes(cite));
  const lines = require('../src/services/homeroom-bot-live.js').FIRST_VERSION_DESIGN_LINES.join(' ').replace(/\s+/g, ' ');
  assert.ok(lines.includes(cite), 'the build cites the section by its heading');
});

// #6766: rule 8's old headline ("don't call third-party APIs directly")
// read as a ban on every outside API, so the bot told someone a real map
// with place search could not be built, though Homeroom Maps does exactly
// that. The rules now say what is allowed, and the data rule distinguishes a
// library the app serves itself from a script on another origin. The group's
// follow-up on the request gave the allowed list, the two bans and their
// reasons, and the guidance worded as a preference.
test('conventions allow outside data services and content, with two bans (#6766)', () => {
  const doc = getAppConventions();
  const excerpt = doc.slice(doc.indexOf('<!-- work-order:begin -->'), doc.indexOf('<!-- work-order:end -->')).replace(/\s+/g, ' ');
  // The phrase the bot and two projects read as a platform limit is gone.
  assert.doesNotMatch(excerpt, /don't call\s+third-party APIs directly/);
  assert.match(excerpt, /\*\*AI goes through the platform's LLM proxy and uploads through its file storage\. Other outside services \(map tiles, place search, weather, public data APIs\) are fine\.\*\*/);
  assert.match(excerpt, /declare any key in `dapp\.json` `secrets` \(rule 7\) for the owner to set in the Secrets UI/);
  assert.match(excerpt, /Never ask the people using the app for an API key\./);
  assert.match(excerpt, /keyless providers need no secret/);
  // Rule 12 names what may come from another site.
  assert.match(excerpt, /Everything else from other sites is fine: images, video and audio; map tiles and map styles; web fonts; data from public APIs, from the app's server or from the browser when the API allows it; and embedded players such as YouTube or Vimeo in an `<iframe>`\./);
  // Ban 1: an outside script, with the governance reason, and npm instead.
  assert.match(excerpt, /No trackers, analytics, ad SDKs, pixels or beacons in any form, including image pixels: a privacy promise to the people using the apps \(see also request #6048\)\. No `<script>` tag from another origin: the group votes on the code in the repository, and an outside script can change after the vote, so the app would run code nobody voted on and nobody can see in the repo\./);
  assert.match(excerpt, /Install libraries from npm and serve them from the app's own origin, as Homeroom Maps does with MapLibre\./);
  // Guidance is a preference, never a ban.
  assert.match(excerpt, /Prefer fonts from npm \(`@fontsource\/\*`\) over Google Fonts, YouTube's `youtube-nocookie\.com` embed, and calls from the app's server rather than the browser so visitors' IP addresses are not sent too\./);

  const data = getConventionSection('data-rules-what-no-app-may-collect-or-load');
  assert.ok(data && data.content, 'the data rules section exists');
  const section = data.content.replace(/\s+/g, ' ');
  // The line that read as "the app's own code and Homeroom's assets only"
  // is gone, replaced by the allowed list.
  assert.doesNotMatch(section, /An app loads its own code and the centrally hosted Homeroom assets only/);
  assert.match(section, /Everything else from other sites is fine: images, video and audio hosted elsewhere; map tiles and map styles; web fonts; public API data \(from the app's server, or the browser where the API allows it\); and embedded players such as YouTube or Vimeo in an `<iframe>`\./);
  // Ban 1: an outside script, because the group voted on the repository.
  assert.match(section, /No `<script>` tag from another origin either: the group votes on the code in the repository, and an outside script can change after the vote, so the app would run code nobody voted on and nobody can see in the repo\./);
  assert.match(section, /Install libraries from npm and serve them from the app's own origin, as Homeroom Maps does with MapLibre\./);
  // Ban 2: trackers and pixels in any form, a privacy promise (#6048).
  assert.match(section, /No trackers, analytics, ads, pixels or beacons in any form, including image pixels: a privacy promise to the people using the apps \(see also request #6048\)\./);
  // Calling from the app's server keeps IP addresses away, not the words.
  assert.match(section, /A server-side call still sends what people type to the provider, so choose providers knowingly\./);
});

// 17 Nov 2026 (#6769): the data rules were written as whole-topic bans, so
// the bot refused a gym log, a game PIN, a choir rota or a Spotify playlist
// sync. Each line now bans what was actually meant, and the document no
// longer contradicts itself with Stripe and "charge real cards" examples.
test('the data rules ban what is meant, not whole topics (#6769)', () => {
  const prompts = require('../src/services/prompts.js');
  const { content } = prompts.getConventionSection('data-rules-what-no-app-may-collect-or-load');
  const flat = content.replace(/\s+/g, ' ');

  // 1. Sign-in stays Homeroom-only; connecting an outside account is allowed.
  assert.match(flat, /People sign in to the app only through Homeroom/);
  assert.match(flat, /no "Sign in with X"/);
  assert.match(flat, /Connecting a person's account on another service so the app can use its data \(OAuth\) is allowed\./);
  assert.match(flat, /client secret as a private secret and the tokens in a private table/);

  // 2. Passwords and PINs mean account credentials; app-made codes are fine.
  assert.match(flat, /Never ask for or store a person's password or PIN for an account/);
  assert.match(flat, /payment card number or security code/);
  assert.match(flat, /Codes the app makes for its own use, such as a game PIN or a room code, are not passwords\./);

  // 3. Children means under 13, Homeroom's minimum age.
  assert.match(flat, /Nothing designed for or marketed to children under 13/);
  assert.match(flat, /Homeroom's minimum age/);
  assert.match(flat, /family or class tool used by adults and teens is fine/);

  // 4. Sensitive data is about profiling people, not the topic.
  assert.match(flat, /Profiling people by sensitive traits/);
  assert.match(flat, /sort, rank or target people by them/);
  assert.match(flat, /A club or topic in these areas is fine \(a choir/);
  assert.match(flat, /a note a person chooses to enter about themselves/);
  assert.match(flat, /keep it in a private table/);

  // 5. Payments are banned plainly, through any provider.
  assert.match(flat, /No payments: apps don't charge money or take card details, through any provider\./);

  // The old whole-topic lines are gone.
  assert.doesNotMatch(flat, /No app is designed or marketed for children\./);
  assert.doesNotMatch(flat, /Never ask for, infer or store health/);
  assert.doesNotMatch(flat, /no other identity provider/);
  assert.doesNotMatch(flat, /Never ask for, receive or store a password, PIN, card number or security code, seed data included\./);

  // "When unsure" now covers only what the lines do not.
  assert.match(flat, /When unsure about anything the lines above do not cover, treat it as not allowed and ask\./);

  // The document no longer contradicts itself about payments or passwords.
  const doc = getAppConventions();
  assert.doesNotMatch(doc, /STRIPE_SECRET_KEY/);
  assert.doesNotMatch(doc, /charging cards/);
  assert.doesNotMatch(doc, /charge real cards/);
  assert.doesNotMatch(doc, /password hashes/);
  assert.match(doc, /WEATHER_API_KEY/);

  // Essentials rule 12 carries the same five changes in one paragraph.
  const essentials = prompts.getWorkOrderEssentials().replace(/\s+/g, ' ');
  assert.match(essentials, /only through Homeroom/);
  assert.match(essentials, /under 13|under-13s/);
  assert.match(essentials, /payments/);
  assert.match(essentials, /account passwords or card data/);
  assert.match(essentials, /connecting an outside account for its data is fine/);
});
