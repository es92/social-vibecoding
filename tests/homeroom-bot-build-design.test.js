// #3737: the Homeroom bot's build writes every first version, and it was the
// one build on the platform given neither the UI design guidance (#2817)
// nor the in-loop browser's instructions. These pin what it reads now:
//
//   - the same design guidance the dev chat builds with, its self-check
//     chosen by whether the build's model reads images (OpenRouter's
//     catalog, read as the Mayor reads it);
//   - the dev chat's in-loop browser block, and one rule of the bot's own:
//     a change a person will see is looked at, in both looks, before the
//     turn ends;
//   - for a project's first version, a design brief of its own in the
//     triage note and the spec, and a build that builds with the starter's
//     design kit and records the look in the "## Design" section of the
//     app's CLAUDE.md for every later change to follow.
//
// Run with: node --test tests/homeroom-bot-build-design.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const prompts = require('../src/services/prompts');
const { IN_LOOP_BROWSER_GUIDANCE } = require('../src/services/in-loop-browser');
const credentialStore = require('../src/services/credential-store');
const designSkill = require('../src/services/design-skill');
const agentModels = require('../src/services/agent-models');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SPEC = '# Title\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';

// ── The build prompt ─────────────────────────────────────────────────────

test('the build carries the design guidance, its self-check by whether the model reads images', () => {
  for (const spec of [null, SPEC]) {
    const images = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, readsImages: true });
    assert.ok(images.includes(prompts.getDesignGuidance({ readsImages: true })), 'the image self-check, whole');
    const text = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, readsImages: false });
    assert.ok(text.includes(prompts.getDesignGuidance({ readsImages: false })), 'the text self-check, whole');
    assert.ok(!text.includes(prompts.getDesignGuidance({ readsImages: true })));
    // Unknown is text: a model is never told to look at what it cannot see.
    assert.equal(live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec }), text);
    for (const p of [images, text]) {
      assert.ok(p.indexOf('Do not commit or push yourself') < p.indexOf('==== UI DESIGN'), 'after the build contract');
      assert.ok(p.indexOf('==== END UI DESIGN ====') < p.indexOf('==== DESCRIPTION ===='), 'before the summary block');
    }
  }
});

test('the build carries the dev chat\'s in-loop browser block and the bot\'s expected visual check', () => {
  const images = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages: true });
  const text = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages: false });
  for (const p of [images, text]) {
    assert.ok(p.includes(IN_LOOP_BROWSER_GUIDANCE), 'the block the dev chat gives an OpenRouter turn, as written');
    assert.match(p, /For you, "commit" in it means finishing your turn,\nsince your working tree is committed for you/,
      'its "commit" is the harness\'s here: the contract says not to commit');
    assert.match(p, /- For you, the Homeroom bot, that visual check is EXPECTED, not optional, when the change is one a person will\n  see\. Boot the app, then/);
    assert.match(p, /at 390x844 and at a desktop width, in both looks \(`\?un-theme=light` and `\?un-theme=dark`, unless the app keeps\n  one fixed look\), and in its empty and error states\. Fix what is wrong, and only then finish\./);
    assert.match(p, /Skip it only when\n  the app cannot boot promptly, and then say why in your summary\. Stay within the time budget above\./);
    assert.ok(p.indexOf(IN_LOOP_BROWSER_GUIDANCE) < p.indexOf('EXPECTED, not optional, when the change'), 'the rule follows the block');
    assert.doesNotMatch(p.slice(p.indexOf('The in-loop browser, as'), p.indexOf(IN_LOOP_BROWSER_GUIDANCE)), /—/);
  }
  assert.match(images, /Boot the app, then\n  take screenshots \(`browser_take_screenshot`\) of each changed screen\n/);
  assert.match(text, /Boot the app, then\n  walk each changed screen through its accessibility snapshot \(`browser_snapshot`; you read text, not images\)\n/);
});

test('with a reviewer, the build checks its main flow once at one width and leaves the visual sweep to the review', () => {
  for (const readsImages of [true, false]) {
    const without = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages, firstVersion: true });
    const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages, firstVersion: true, reviewed: true });
    assert.ok(p.includes(IN_LOOP_BROWSER_GUIDANCE));
    assert.match(p, /- For you, the Homeroom bot, one check is EXPECTED, not optional: boot the app and, at 390x844 only, do its main\n  thing once \(below\), enough to know it runs and its main flow works, and fix what that shows is broken\./);
    assert.match(p, /Do not\n  check other widths, both looks, or the empty and error states: a reviewer captures and checks every screen at\n  both widths and in both looks once your turn is over, and you fix what it finds\./);
    assert.match(p, /- A page that renders is not a button that works\./, 'the main-flow check stays');
    assert.doesNotMatch(p, /at a desktop width, in both looks/);
    assert.doesNotMatch(p, /Boot the app, then\n  (take screenshots|walk each changed screen)/);
    // Without a reviewer, today's sweep, unchanged.
    assert.match(without, /at 390x844 and at a desktop width, in both looks/);
    assert.doesNotMatch(without, /one check is EXPECTED/);
    assert.equal(without, live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages, firstVersion: true, reviewed: false }));
  }
  const clocked = live.buildPrompt({
    seed: 'ISSUE', buildNote: 'plan', firstVersion: true, reviewed: true, clock: { startedAt: Date.now(), budgetMs: 40 * 60000 },
  });
  assert.match(clocked, /the reviewer checks sizes, looks, and empty and error states/);
  assert.match(clocked, /Do it in the order, and by the time, the TIME section above sets\./);
});

test('the build is told it has a reviewer exactly when its configuration has one', () => {
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /reviewed: Boolean\(review\?\.reviewer\),/);
});

test('the dev chat\'s browser guidance is left as it was', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /browserGuidance: IN_LOOP_BROWSER_GUIDANCE,/);
  assert.doesNotMatch(IN_LOOP_BROWSER_GUIDANCE, /Homeroom bot/);
  assert.doesNotMatch(IN_LOOP_BROWSER_GUIDANCE, /un-theme/);
});

// ── A first version's look, and the note that records it ───────────────

// None of these prompts may use one of the App bench's five starter briefs
// as an example: an example is copied, and one from the benchmark leaks
// straight into it (7 Oct 2026: a proofing timeline for a bread app and a
// staff for an ear trainer were in both the triage's note and the spec's
// brief).
const BENCH_SUBJECTS = /bread|bak(e|ing)|proofing|sourdough|\bRSS\b|feed reader|ear train|\bmusic|\bstaff\b|keyboard|voxel|\bblock world|tier list|ranking/i;

test('a first version\'s triage sketches a look of its own, which the spec settles; every other triage is unchanged', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const first = flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true }));
  const other = flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1 }));
  assert.match(first, /Sketch a look of its own, too: the starter's screen is placeholder, so there is no existing screen for it to look like\./);
  assert.match(first, /Say in `build_note` the screen's one job and its one primary action/);
  assert.match(first, /its colours \(neutrals, an action colour and any set of colours the subject itself uses, each working in both looks; not the starter's default palette, unless chosen on purpose\)/);
  assert.match(first, /ONE signature element drawn from the app's subject, something no other app would have, and a rough layout\./);
  assert.match(first, /It is a first sketch: the spec that follows settles the look, the layout and the scope, and may replace any of it\. Never ask about them\./);
  assert.ok(first.indexOf('Sketch a look of its own') > first.indexOf('never ask about it.'), 'after the light and dark rule');
  assert.doesNotMatch(other, /Sketch a look of its own|ONE signature element/);
  const look = first.slice(first.indexOf('Sketch a look of its own'), first.indexOf('Never ask about them.'));
  assert.doesNotMatch(look, /—/);
  assert.doesNotMatch(look, BENCH_SUBJECTS);
  assert.doesNotMatch(look, /an accent colour plus neutrals/);
});

test('a first version\'s spec decides its colours, signature element, layout and finish; every other spec keeps its brief', () => {
  const brief = prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF;
  assert.match(brief, /there is no existing screen for it to look like, and the triage only sketched one/);
  // A screen for doing has its one primary action; one for reading keeps its actions quiet.
  assert.match(brief, /the main screen's one job, and what a person does most on it: when that is an action \(adding, logging, calculating\), its one primary action; when it is reading, browsing or comparing, say so, keep the actions quiet and give the content the room \(a screen for reading needs no big filled button\);/);
  // (e) Its colours: neutrals, an action colour and the subject's own set.
  assert.match(brief, /its colours, chosen for this app and each a kit token with a light and a dark value \(the dark one in the light one's hue\): the neutrals, one action colour for the primary action \(ink is fine when the subject's own colours carry the screen\), and any set of colours the subject itself uses/);
  assert.match(brief, /which fit the subject rather than being a cliché to avoid \(not the starter's default palette, unless you choose it on purpose and say why\)/);
  assert.match(brief, /a visual language drawn from the app's subject: its signature element \(something a generic app would not have\) and the consistent details that carry the subject through the whole screen, such as a small drawn icon for each kind of thing, the subject's own colours and materials, or a typeface that suits it;/);
  assert.doesNotMatch(brief, /ONE signature element/);
  assert.match(brief, /a sketch of the main screen's layout at phone width, a few plain lines from top to bottom, and how dense it is there/);
  // The finish the build should not have to invent.
  assert.match(brief, /for each repeated row or card, what it shows and in what order and prominence \(its main text, its secondary text, and its small details such as a time, a count or a status\)/);
  assert.match(brief, /which control each setting or input uses \(a text field, a stepper, a slider, a switch, a segmented control, a list to pick from\) and what it starts at/);
  // (b) The populated demo, from the viewer's own seat.
  assert.match(brief, /what the populated demo shows, the staging preview opened with \?demo=1, which is how this first version is first seen: the viewer's own data and not only other people's/);
  // Labelled once, not on every row (every row's pill cluttered all nine test drawings).
  assert.match(brief, /varied and realistic rows filling about a screen and a half at phone width, and every control the real populated screen has \(a view-only demo that hides actions is not a populated screen\), labelled "Staging demo" once, plainly and visibly, in a banner or a line of its own at the top of the screen \(never the app's name, nor in place of its tagline\) or in the name of the list or collection its rows belong to, rather than on each row, with the rows themselves still obviously made up \(no real people and no real private data\), and the element that carries the label marked with the attribute `data-usernode-demo-note` \(in a list's name, a span around the label's own words\) so Homeroom can hide it where it shows the app with its sample data;/);
  assert.doesNotMatch(brief, /every demo row labelled/);
  assert.match(brief, /on staging and with \?demo=1 only, idempotent, either added to those responses or written once for the viewing account on its first \?demo=1 request \(the platform conventions' "Staging mock data"/);
  assert.match(brief, /records it in the app's CLAUDE\.md/);
  // A game's play area is planned on a canvas, a grid game included.
  assert.match(brief, /If the app is a game, its play area \(the board, the field, the pieces, the cards\) is drawn on a canvas and played with pointer events, never built from HTML elements, a grid game such as minesweeper, sudoku or chess included: say so here, and the technical half plans it that way \(the platform conventions' "Games: draw the play area on a canvas"\)/);
  assert.match(brief, /A game starter's own drawing is kept\./);
  assert.doesNotMatch(brief, /which existing screen of this app it should look/);
  assert.doesNotMatch(brief, /—/);
  assert.doesNotMatch(brief, BENCH_SUBJECTS);
  assert.doesNotMatch(brief, /an accent colour plus the neutrals/);

  // The brief every other spec reads, the dev chat's scout included, as it was.
  assert.match(prompts.SPEC_DESIGN_BRIEF, /which existing screen of this app it should look and behave like/);
  assert.doesNotMatch(prompts.SPEC_DESIGN_BRIEF, /signature element|zinc/);

  const first = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true });
  const other = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan' });
  assert.ok(first.includes(`- ${brief}`));
  assert.ok(other.includes(`- ${prompts.SPEC_DESIGN_BRIEF}`));
  assert.ok(!other.includes(brief));
  // And App bench context pack 4's nudge to read the frontend-design skill
  // (services/design-skill.js; tests/design-skill.test.js), the plan read as
  // a first sketch, and the first version's own scope: the only differences.
  const nudge = live.guidanceLines(designSkill.stageGuidance('spec', { firstVersion: true })).join('\n');
  const swapped = first
    .replace(brief, prompts.SPEC_DESIGN_BRIEF)
    .replace(`\n${nudge}`, '')
    .replace(live.specPlanLines('plan', true).join('\n'), live.specPlanLines('plan', false).join('\n'))
    .replace(live.specScopeLines(true).join('\n'), live.specScopeLines(false).join('\n'));
  assert.equal(swapped, other, 'the brief, the nudge, the plan\'s framing and the scope are the only differences');
  assert.equal(live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: false }), other);
});

test('a first version\'s spec owns its design and scope; what its creator approved binds it', () => {
  const note = `A plant log.${bot.creatorChoiceNote([{ question: 'Reminders?', answer: 'Phone alert' }], { bullets: ['See each plant and when it was last watered', 'Get a reminder when one is due'] })}`;
  for (const html of [false, true]) {
    const first = live.specPrompt({ seed: 'ISSUE', buildNote: note, firstVersion: true, html });
    const other = live.specPrompt({ seed: 'ISSUE', buildNote: note, html });
    const flat = first.replace(/\s+/g, ' ');
    // The plan is a first sketch the spec may improve on...
    assert.match(flat, /It is a new project's FIRST VERSION, and this is the triage's plan for it, a first sketch written before anyone looked closely: A plant log\./);
    assert.match(flat, /- Yours to design\. The plan's look, layout and scope are the triage's first sketch: keep what is good in it, replace what a careful senior product designer would do better, and say under Assumptions what you replaced and why\. What binds you is the request itself and what its creator approved, above\./);
    // ...but what its creator approved under it binds the spec.
    // Newcomer run seven: and where one of its lines and an answer differ, the answer wins.
    assert.match(flat, /WHAT ITS CREATOR APPROVED, below, binds the spec as the request does: never contradict it\. Where a plan line, even an approved one, and one of the creator's answers differ, the answer wins: never add an option or a behaviour an answer ruled out\. Approved by the creator, who tapped Build it under this plan: - See each plant and when it was last watered - Get a reminder when one is due The creator chose, from the plan they were shown: - Reminders\? Phone alert/);
    // The scope: a complete first version, not "as small as the request".
    assert.match(flat, /- A complete first version of what the request asks for, done fully and well, including the small touches that make it feel finished\. Not a new feature, screen or setting the request does not imply\./);
    assert.doesNotMatch(first, /As small as the request/);
    // A later change keeps today's wording.
    assert.match(other, /- As small as the request: the plan above, no refactoring or extra features\./);
    assert.match(other, /concluded it is ready to build, with this plan:\n\nA plant log\./);
    assert.doesNotMatch(other, /first sketch|WHAT ITS CREATOR APPROVED|Yours to design|A complete first version/);
    assert.doesNotMatch(first.slice(first.indexOf('It is a new project'), first.indexOf('Written without em dashes')), /—/);
  }
  // A long note never loses what was approved off its end.
  const long = `${'x'.repeat(5000)}${bot.creatorChoiceNote([], { bullets: ['Keep this bullet'] })}`;
  assert.match(live.specPrompt({ seed: 'ISSUE', buildNote: long, firstVersion: true }), /under this plan:\n- Keep this bullet/);
  assert.match(live.buildPrompt({ seed: 'ISSUE', buildNote: long, firstVersion: true }), /under this plan:\n- Keep this bullet/);
  assert.doesNotMatch(live.buildPrompt({ seed: 'ISSUE', buildNote: long }), /Keep this bullet/, 'a later build clips its note as before');
});

test('a first version\'s spec is sized for about 25 of its build\'s 40 minutes and ranks its work; its build follows that order', () => {
  // The build's clock this aims inside: twice the default turn budget.
  assert.equal(bot.FIRST_VERSION_BUILD_TIME_FACTOR, 2);
  for (const html of [false, true]) {
    const first = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, html }).replace(/\s+/g, ' ');
    const other = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', html });
    assert.match(first, /- Sized for the build that follows: it has about 40 minutes, so plan about 25 minutes of its work, which leaves it time to look at the result and fix it\. This is a size to aim for, not a cut: nothing the request needs is dropped to fit, and what may not fit goes last in the order below\./);
    assert.match(first, /End the technical half with a "Build order" subsection of two short lists\. "Must-haves first": the main action working end to end; honest loading, empty and error states \(never a blank loading screen, a made-up zero or a raw server error\); the phone layout \(nothing covering or cutting off content, the tab you are on marked\); demo data that shows the app's core idea; and the signature element on the first screen\. Then "Nice-to-haves": everything else, most valuable first\./);
    // Gentle: the complete first version is still asked for.
    assert.match(first, /- A complete first version of what the request asks for, done fully and well/);
    assert.doesNotMatch(other, /Build order|25 minutes|Must-haves first/, 'a later change is as it was');
  }
  for (const line of live.FIRST_VERSION_SIZE_LINES) assert.ok(!/—/.test(line), line);
  const order = live.FIRST_VERSION_ORDER_LINES.join('\n');
  assert.match(order.replace(/\s+/g, ' '), /Build in the order the spec's "Build order" gives: every must-have first, working, then the nice-to-haves, most valuable first, only while time is left\./);
  for (const spec of [null, '# Spec']) {
    const first = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, firstVersion: true });
    assert.ok(first.includes(order));
    assert.ok(first.indexOf(order) < first.indexOf('Make exactly that change, and nothing else:'));
    assert.ok(!live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec }).includes('Build order'), 'a later build is as it was');
  }
});

test('a first version\'s HTML spec draws its finished screens within a budget; a markdown spec and every later spec do not', () => {
  const screens = prompts.FIRST_VERSION_SCREENS_BRIEF;
  const flat = screens.replace(/\s+/g, ' ');
  assert.match(flat, /draws UP TO TWO screens of the finished first version, in full, as faithful mocks: the build takes them as its visual target/);
  assert.match(flat, /The first is normally the main screen, populated with the demo data your Design subsection describes/);
  assert.match(flat, /at phone width \(data-size="phone"\) with data-height set to the screen's real scroll length, at most 2400, and no data-focus/);
  // No fake "before": the drawn screens are the after side only.
  assert.match(flat, /wrap each screen's whole tree in one <div data-side="after" data-change="N">/);
  assert.match(flat, /so the before side stays empty rather than showing the starter's placeholder/);
  assert.match(flat, /Draw the light look; the Design subsection gives the dark look's values for the same tokens/);
  assert.match(flat, /--ground, --surface, --raised, --fg, --muted, --line, --accent and --on-accent, plus any new token the Design subsection defines/);
  assert.match(flat, /An icon or illustration is an inline <svg> inside the screen, so the build can lift it: no emoji as icons, and no images/);
  // The fidelity budget.
  assert.match(flat, /Draw at the app's REAL fidelity: the HTML and CSS the build should write, not artwork/);
  assert.match(flat, /A game's play area is the one exception: the build paints it on a canvas, so draw it as one inline <svg> picture of what the canvas shows/);
  assert.match(flat, /Icons are line icons: a 24 by 24 viewBox, one stroke width, at most about 8 shapes each, and no gradients, filters, masks, patterns or text turned into paths\. A consistent set of them is welcome: one for each kind of thing, the app's own mark, its actions\./);
  assert.match(flat, /A larger illustration is fine where it carries the subject, each kept to about 30 shapes\./);
  assert.match(flat, /Each screen, its <style> included, stays within about 20,000 characters: a screen that needs more is drawn in too much detail\. Draw repeated rows with identical structure\. Spend the effort where a careful designer would: hierarchy, density, spacing, type and the subject's own details; leave out decoration that carries no meaning\./);
  assert.ok(flat.includes(require('../src/services/spec-html').SCREEN_CHAR_BUDGET.toLocaleString('en-US')), 'the words and the measure name one budget');
  assert.doesNotMatch(screens, /—/);
  assert.doesNotMatch(screens, BENCH_SUBJECTS);

  const htmlFirst = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, html: true });
  assert.ok(htmlFirst.includes(screens));
  assert.ok(htmlFirst.indexOf(screens) > htmlFirst.indexOf('HTML SPEC FORMAT'), 'after the format it overrides');
  assert.ok(!live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true }).includes(screens), 'a markdown spec draws nothing');
  assert.ok(!live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', html: true }).includes(screens), 'nor does a later change');
  assert.ok(!prompts.specHtmlContract(false).includes('FIRST VERSION SCREENS'), 'the format itself is unchanged');
});

test('a first version\'s build uses the starter\'s design kit and records its look in CLAUDE.md; later builds follow it', () => {
  const lines = live.FIRST_VERSION_DESIGN_LINES.join('\n');
  const flat = lines.replace(/\s+/g, ' ');
  // #3737 Rec2: the kit every new app's stylesheet carries
  // (tests/template-design-kit.test.js), re-pointed rather than reinvented.
  assert.match(flat, /Build it with the starter's design kit \(`styles\/tailwind-input\.css`\): set its colour tokens to this app's palette \(its neutrals, its action colour and any set of colours its subject uses, adding a token for a colour the kit has no name for\), a light and a dark value each, the dark one in the light one's hue, unless the app keeps one fixed look; every text pair at 4\.5:1 or more\./);
  assert.match(flat, /Use only those tokens and the kit's components, its loading, empty and error states included/);
  assert.match(flat, /the design guidance's "no new colours" means none beyond them, and every token the spec defines is one of them\./,
    'the colours it defines are the app\'s own palette, not the kind the guidance bans');
  // The spec decides; its drawn screens are the visual target (a+).
  assert.match(flat, /Where the spec's design differs from the plan's, follow the spec: the plan's look was the triage's first sketch\./);
  assert.match(flat, /When the spec draws screens \(its "### Screen markup"\), they are your visual target: reproduce them, reusing their markup structure, inline SVG icons, proportions, spacing and type choices, translated onto the kit's tokens and components rather than re-invented\./);
  assert.match(flat, /In your look-and-fix rounds, compare your screenshots with the drawn screens and fix what differs\. Where a drawing and the spec's words disagree, the words decide what the app does and the drawing decides how it looks\./);
  // Except a game's play area, which is painted on a canvas (a minesweeper
  // first version reused its drawn board as a grid of buttons).
  assert.match(flat, /A game's play area \(its board, field, pieces or cards\) is the one thing you never build from the drawing's markup: paint what the drawing shows on a canvas, played with pointer events, as the platform conventions' "Games: draw the play area on a canvas" says, even for a grid game\. A game starter's own drawing is kept\./);
  // The populated demo (b).
  assert.match(flat, /Build the populated demo the spec describes, the staging preview opened with `\?demo=1`: the viewer's own data as well as other people's, varied realistic rows filling about a screen and a half at phone width, every control the real screen has \(never a view-only demo\), and the app's main result already there \(the scores added up, the schedule filled in, the totals worked out\), not only what goes into it\. It is labelled "Staging demo" once, plainly, as a banner or a line of its own at the top of the screen \(never the app's name, nor in place of its tagline\) or in the name of its list, not on each row, and rows the app seeds on boot carry no label of their own either; every row stays obviously made up\. On staging and with `\?demo=1` only, and idempotent/);
  // Run 196's blind grades: an empty or error screen filled two buttons.
  assert.match(flat, /The empty and error screens fill one button at most, the empty state's own action or Retry: a pinned or floating primary button is hidden on both\./);
  // Newcomer run seven: the label's element is marked, so Homeroom can hide it.
  assert.match(flat, /The element that carries the "Staging demo" label gets the attribute `data-usernode-demo-note` \(the banner or the line itself; in a list's name, a `<span data-usernode-demo-note>` around the label's own words, so the name stays\), so Homeroom can hide it where it shows the app with its sample data\./);
  assert.doesNotMatch(flat, /each row labelled/);
  assert.doesNotMatch(flat, BENCH_SUBJECTS);
  // The record: the starter's "## Design" section, which a starter other
  // than Empty does not have yet.
  assert.match(flat, /Then fill in the "## Design" section of the app's `CLAUDE\.md` \(add it if it is missing\): the palette by name, the signature element, the type scale, and the one fixed look if the app keeps one\. Every later change follows it\./);
  // Run five (13 Oct 2026, fix 7): the header's mark is the project's icon, or none.
  assert.match(flat, /If the app's header shows its own mark, show the project's icon there \(the emoji in `dapp\.json`'s `icon` block\), or leave the mark out: never an empty tile, and never `brand\/icon\.png`, which the app does not serve\./);
  assert.doesNotMatch(flat, /zinc|violet|`Design:` note/, 'nothing left of the old starter\'s palette or note');
  for (const line of live.FIRST_VERSION_DESIGN_LINES) assert.ok(!/—/.test(line), line);

  for (const spec of [null, SPEC]) {
    const first = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, firstVersion: true });
    const other = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec });
    assert.ok(first.includes(lines));
    assert.ok(first.indexOf(lines) < first.indexOf('Make exactly that change, and nothing else:'),
      'part of "that change", before the contract that forbids adding notes');
    // And App bench context pack 4's nudge and look-and-fix loop
    // (services/design-skill.js; tests/design-skill.test.js).
    const pack4 = live.guidanceLines(designSkill.stageGuidance('build', { firstVersion: true })).join('\n');
    // #4387: and the "Adding …" phrases its waiting members see.
    const progress = live.FIRST_VERSION_PROGRESS_LINES.join('\n');
    assert.ok(first.includes(progress) && !other.includes('usernode-progress'));
    // #4487: and a later change is asked to declare its visible changes.
    const declare = live.buildVisibleChangesLines(null).join('\n');
    assert.ok(other.includes(declare) && !first.includes('declare_visible_changes'));
    // The copies have no model key, so no declared step waits for the bot (PR 4536).
    assert.match(declare.replace(/\n/g, ' '), /The before and after copies have no model key, so nothing on them answers with a model: Homeroom bot only says it cannot reach its model there/);
    assert.match(declare.replace(/\n/g, ' '), /Never make a step ask Homeroom bot \(or any AI feature\) for something and wait for its reply\./);
    // A state new in the change is seeded in it: the after copy is the side
    // that needs it (22 failed runs and 13 skipped changes, 2026-10-09 to 10-12).
    assert.match(declare.replace(/\n/g, ' '), /add an idempotent, obviously fake staging seed for it in this same change: it reaches the after copy, which is the side a new state needs\./);
    assert.match(declare.replace(/\n/g, ' '), /fake people, never a signal your code reads to decide something, and a reply as the stored message, never asked for\./);
    assert.match(declare.replace(/\n/g, ' '), /A change to a state that already existed needs it on both copies, which a seed in this change cannot give/);
    // And the order its spec ranked the work in.
    const order = live.FIRST_VERSION_ORDER_LINES.join('\n');
    assert.equal(first.replace(`${lines}\n`, '').replace(`${progress}\n`, '').replace(`${order}\n`, '').replace(`${pack4}\n`, ''), other.replace(`${declare}\n`, ''),
      'the record, the progress phrases, the build order, the skill\'s nudge, the look-and-fix loop and the declaration are the only differences');
    // Every build, a later one included, reads the note through the guidance.
    for (const p of [first, other]) {
      assert.match(p, /If the app's `CLAUDE\.md` has a "## Design" section \(or a `Design:` note under "App-specific conventions"\), that is this app's look/);
    }
  }
});

// ── Through buildAndPropose ──────────────────────────────────────────────

function buildHarness() {
  const calls = { prompts: [] };
  const pool = { async query(sql) { return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [] }; } };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) {
        calls.prompts.push({ mode: opts.mode, prompt: opts.prompt });
        return opts.mode === 'scout' ? { lastResultText: SPEC } : { pushOk: true, ahead: 1 };
      },
      stopTurn() { return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}), estimatedCostUsd: 0.01 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
    activeWorkers: new Set(),
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: { dataEncryptionKey: 'k' }, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 13, issue: { title: 'Ear trainer' }, seed: 'ISSUE',
  buildNote: 'x', turnBudgetMs: 60_000, propose: false,
};

const promptFor = (calls, mode) => calls.prompts.find((c) => c.mode === mode).prompt;

test('the build reads the model\'s image input from the catalog, with the key its turn runs on', async (t) => {
  const real = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    resolveModelPricing: agentModels.resolveModelPricing,
  };
  t.after(() => Object.assign(credentialStore, { readMetadata: real.readMetadata, readSecret: real.readSecret })
    && Object.assign(agentModels, { resolveModelPricing: real.resolveModelPricing }));
  const asked = [];
  credentialStore.readMetadata = async (args) => { asked.push(['meta', args.userId, args.provider, args.purpose]); return { status: 'valid', revision: 4 }; };
  credentialStore.readSecret = async (args) => { asked.push(['secret', args.userId, args.expectedRevision]); return 'sk-or-test'; };
  agentModels.resolveModelPricing = async ({ apiKey, modelId }) => {
    asked.push(['catalog', apiKey, modelId]);
    return { 'z-ai/glm-5.3-flash': { supportsImages: true }, 'text/only': { supportsImages: false } }[modelId] || null;
  };

  const sees = buildHarness();
  await live.buildAndPropose({ pool: sees.pool, deps: sees.deps, ...ARGS, model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(asked, [
    ['meta', 77, 'openrouter', 'coding_agent'],
    ['secret', 77, 4],
    ['catalog', 'sk-or-test', 'z-ai/glm-5.3-flash'],
  ], 'the bot\'s own coding key, as the Mayor reads it');
  assert.ok(promptFor(sees.calls, 'build').includes(prompts.getDesignGuidance({ readsImages: true })));

  for (const model of ['text/only', 'not/in-catalog']) {
    const h = buildHarness();
    await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, model });
    assert.ok(promptFor(h.calls, 'build').includes(prompts.getDesignGuidance({ readsImages: false })), model);
  }

  // No key, or a catalog that cannot be read: text, and the build goes on.
  credentialStore.readMetadata = async () => null;
  assert.equal(await live.buildSeesImages({ pool: {}, config: {}, userId: 77, model: 'z-ai/glm-5.3-flash' }), false);
  credentialStore.readMetadata = async () => { throw new Error('db down'); };
  assert.equal(await live.buildSeesImages({ pool: {}, config: {}, userId: 77, model: 'z-ai/glm-5.3-flash' }), false);
});

test('a first version reaches its spec and its build; any other build reads the usual brief', async () => {
  const first = buildHarness();
  first.deps.seesImages = true;
  await live.buildAndPropose({ pool: first.pool, deps: first.deps, ...ARGS, model: 'm', firstVersion: true });
  assert.ok(promptFor(first.calls, 'scout').includes(prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF));
  assert.ok(promptFor(first.calls, 'build').includes(live.FIRST_VERSION_DESIGN_LINES.join('\n')));

  const other = buildHarness();
  other.deps.seesImages = true;
  await live.buildAndPropose({ pool: other.pool, deps: other.deps, ...ARGS, model: 'm' });
  assert.ok(promptFor(other.calls, 'scout').includes(prompts.SPEC_DESIGN_BRIEF));
  assert.ok(!promptFor(other.calls, 'scout').includes(prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF));
  assert.ok(!promptFor(other.calls, 'build').includes('FIRST VERSION'));
});

test('a live first version passes the flag to its build, and a benchmark trial replays it', async (t) => {
  const realBuild = live.buildAndPropose;
  const realPost = live.post;
  t.after(() => { live.buildAndPropose = realBuild; live.post = realPost; });
  live.post = async () => ({});
  const seen = [];
  live.buildAndPropose = async (args) => { seen.push(args.firstVersion); return { ok: false, error: 'stop here', costUsd: 0 }; };
  const pool = { async query() { return { rows: [] }; } };
  for (const firstVersion of [true, false]) {
    await bot.buildLive({
      pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' }, repo: { owner: 'o', repo: 'r' },
      issueNumber: 13, issue: { title: 'x' }, parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900,
      seed: 's', seedReadAt: '2026-09-28T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm', firstVersion,
      deps: {
        github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
        ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
        limits: { async recordSpend() {} }, managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
      },
    });
  }
  assert.deepEqual(seen, [true, false]);

  const runner = read('src/services/bench/runner.js');
  const specStage = runner.slice(runner.indexOf('async function specStage('), runner.indexOf('async function buildResult('));
  const buildStage = runner.slice(runner.indexOf('async function buildStage('), runner.indexOf('function followupTurn('));
  for (const stage of [specStage, buildStage]) assert.match(stage, /firstVersion: !!snapshot\.extra\?\.firstVersion,/);
});

// #4387: once a first version's spec is written, its drawn screens are
// handed on for the App tab's first look, with the worker they can be drawn
// in, and the build goes straight on without waiting for it.
test('a first version\'s spec screens are handed to its first look, and nothing waits on it', async () => {
  const HTML_SPEC = '<article data-spec><h1>Plants</h1><section data-spec-tab="user"><figure data-screens>'
    + '<template data-screen data-size="phone"><div data-side="after" data-change="1">Today</div></template>'
    + '<ol data-changes><li>The list</li></ol></figure><p>What changes.</p></section>'
    + '<section data-spec-tab="tech"><p>How.</p></section></article>';
  const h = buildHarness();
  h.deps.seesImages = true;
  const exec = h.deps.worker.execInWorker;
  h.deps.worker.execInWorker = async (id, opts) => (opts.mode === 'scout' ? { lastResultText: HTML_SPEC } : exec(id, opts));
  const looks = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const built = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, model: 'm', firstVersion: true,
    onFirstLook: async (args) => { looks.push(args); await held; },
  });
  release();
  assert.equal(built.ok, true, 'built while the first look was still being drawn');
  assert.equal(looks.length, 1);
  assert.equal(looks[0].containerName, 'w');
  assert.ok(looks[0].specHtml.includes('<template data-screen data-size="phone">'));
  assert.equal('specHtml' in built, false, 'the HTML is never carried onto the result');

  // A markdown spec draws nothing to look at.
  const md = buildHarness();
  md.deps.seesImages = true;
  const none = [];
  await live.buildAndPropose({ pool: md.pool, deps: md.deps, ...ARGS, model: 'm', firstVersion: true, onFirstLook: (a) => none.push(a) });
  assert.equal(none.length, 0);
});
