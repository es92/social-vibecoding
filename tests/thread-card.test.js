'use strict';

// The thread's card on a request's and a change's page, under the standard
// look and the brand look (frontend/src/features/dev-board/topic/
// thread-card.tsx, card-model.ts and step-store.ts; app.css "THE THREAD'S
// CARD"): a kicker over the title, whose words the summary is, the picture,
// and a foot that says where the thread stands once, with its action. A step
// of "How it got here" opens its content over the card.
//
// The foot's model is pure: which of a change's votes, tests and merge it
// speaks for, and a request's standing in words. These tests read it in
// words, hold the step store's rules, and pin the places that draw the card:
// the two heads (never under one of the frame's looks), a lone change under a
// request, and the stylesheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { withWords } = require('./lib/work-words');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/card-model.ts';
const RAIL_MODEL = 'frontend/src/features/dev-board/topic/rail-model.ts';
const STORE = 'frontend/src/features/dev-board/topic/step-store.ts';
const CARD = 'frontend/src/features/dev-board/topic/thread-card.tsx';
const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';
const REQUEST = 'frontend/src/features/dev-board/topic/request-head.tsx';
const CHANGES = 'frontend/src/features/dev-board/topic/thread-changes.tsx';

const words = (p) => (p == null ? null : typeof p === 'string' ? p : message(p.id, p.values));
const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
const votes = (over = {}) => gate({ name: 'Votes', figure: 'Needs 2 more yes', ...over });
const testing = (over = {}) => gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true, ...over });
const standing = (state) => withWords({ since: '2026-11-08T12:00:00Z', ...state });

test("a change's foot speaks for the vote once its tests have passed", () => {
  const { changeFoot, changePhase } = loadTsx(MODEL);
  const input = {
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: votes({ tone: 'ask', facts: [{ key: 'tally', text: '3 waiting' }, { key: 'mine', text: 'You haven’t voted.', ask: true }], note: ['Any of the 3 members can give it.'] }),
    testing: testing(),
  };
  assert.equal(changePhase(input), 'vote');
  const foot = changeFoot(input);
  assert.equal(foot.gate, 'votes');
  assert.equal(foot.key, 'vote');
  assert.equal(foot.headline, 'Needs 2 more yes');
  assert.equal(foot.title, null);
  assert.deepEqual(JSON.parse(JSON.stringify(foot.facts)), ['3 waiting', 'You haven’t voted.'], 'the card already counts, so no second count');
  assert.deepEqual(JSON.parse(JSON.stringify(foot.sub)), ['Any of the 3 members can give it.']);
  assert.equal(foot.tone, null);
  // With no count of the card's own, the foot counts: "0 of 2", then the viewer's line.
  const bare = changeFoot({ ...input, votes: votes({ tone: 'ask', facts: [{ key: 'mine', text: 'You haven’t voted.', ask: true }] }) });
  assert.deepEqual(bare.facts.map(words), ['0 of 2', 'You haven’t voted.']);
});

test('failed tests lead even over a vote the viewer can cast, and so do tests still running', () => {
  const { changeFoot, changePhase, fixStanding } = loadTsx(MODEL);
  // 17 Nov 2026: nothing can go live until its tests pass, so the foot says
  // that first, in red. Vote stays in the foot beside See what failed
  // (change-head.tsx), a white pill; the sun pill is what moves it on.
  const bad = testing({ name: 'Testing', figure: 'The preview didn’t start', tone: 'bad', done: false, note: ['Could not parse repo URL'] });
  const foot = changeFoot({ status: { key: 'needs_vote', label: 'Vote · 0/2' }, votes: votes({ tone: 'ask' }), testing: bad });
  assert.equal(foot.key, 'failed');
  assert.equal(foot.tone, 'bad');
  assert.equal(words(foot.title), 'Tests failed');
  assert.deepEqual(JSON.parse(JSON.stringify(foot.facts)), ['The preview didn’t start']);
  assert.deepEqual(JSON.parse(JSON.stringify(foot.sub)), ['Could not parse repo URL']);
  // Whether a fix is on its way decides the headline: a bot that stopped says so.
  assert.equal(fixStanding(bad), 'waiting');
  assert.equal(fixStanding({ ...bad, botFix: 'fixing' }), 'fixing');
  assert.equal(fixStanding({ ...bad, botFix: 'queued' }), 'fixing');
  const stopped = changeFoot({ status: { key: 'needs_vote', label: 'Vote · 0/2' }, votes: votes({ tone: 'ask' }), testing: { ...bad, botFix: 'stopped' } });
  assert.equal(words(stopped.title), 'Stopped: its tests still fail');
  // Tests still running lead too (they used to ride under the vote as a
  // third line): Testing, how far they are, and the bar. Vote sits beside
  // See progress.
  const running = testing({ name: 'Testing', figure: 'About 2 min left', tone: null, done: false, note: ['412 of 738 checks done'] });
  const input = { status: { key: 'needs_vote', label: 'Vote · 0/2' }, votes: votes({ tone: 'ask' }), testing: running };
  assert.equal(changePhase(input), 'testing');
  const testingFoot = changeFoot(input);
  assert.equal(testingFoot.key, 'testing');
  assert.equal(testingFoot.headline, 'Testing');
  assert.deepEqual(JSON.parse(JSON.stringify(testingFoot.facts)), ['About 2 min left']);
  assert.deepEqual(JSON.parse(JSON.stringify(testingFoot.sub)), [], 'what the tests are doing is the note under the timeline\'s Testing step');
  // The foot's parts, in the page.
  const change = read(CHANGE);
  assert.match(change, /headline=\{foot\.title \? t\(foot\.title\.id, foot\.title\.values\) : foot\.headline\}/);
  assert.match(change, /\{failed && !ballot && v\.votes\.tone === 'ask' \? voteAction : null\}/);
  assert.match(change, /\{failed \? null : testAction\}\s*\{\/\* Tests still running: the vote is open meanwhile, beside See progress\. \*\/\}\s*\{failed \|\| ballot \|\| decided \? null : voteAction\}/);
  assert.doesNotMatch(read(MODEL), /alsoTests/, 'no line of tests under a vote any more');
  assert.equal(message('project:topic.rail.testsFailedPlain'), 'Tests failed');
});

test('in a side panel the thread is the same three cards, and the picture is one picture with one switch', () => {
  const css = read('public/css/app.css');
  const panel = 'html:is(:not([data-skin]), [data-skin="brand"]) :is(.dev-ws-side, .in-side-panel body, .gc-tab-body:has(> .gc-spec-side-panel-open)) #dev-topic-thread .dev-request:has(.dev-request-rail:not(:empty))';
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(css, new RegExp(`${esc(panel)} :is\\(#gc-thread-head, #gc-thread-messages, \\.dev-request-rail\\) \\{\\s*min-width: 0;\\s*border-radius: var\\(--thread-card-r\\);\\s*background: var\\(--thread-card\\);`));
  assert.match(css, new RegExp(`${esc(panel)} \\.dev-request-sheet \\{ background: var\\(--thread-ground-look, transparent\\); \\}`));
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai \.dev-thread-kicker \{ display: none; \}/, 'the panel\'s head already names the project and the number');
  const brand = css.slice(css.indexOf('/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING'));
  assert.match(brand, /\.dev-request \{ --thread-ground-look: var\(--bl-page\); \}/);
  assert.match(brand, /\.in-side-panel\.side-panel-beside-ai body:has\(\.dev-thread-card\) \{ background: var\(--bl-page\) !important; \}/);
  // The picture: the size switch and the light and dark flip are the
  // expanded viewer's; the caption is one quiet line.
  assert.match(css, /\[data-thread-picture\] \.dev-change-viewer:not\(:popover-open\) :is\(\.shots-seg-size, \.shots-theme-flip\) \{ display: none; \}/);
  assert.match(css, /\.dev-thread-tiles-legend \.shots-change strong \{[^}]*font-weight: 400;/);
  assert.match(css, /\.dev-thread-tiles-legend \.shots-key \{ display: none; \}/);
  // Under the card look the plan is the timeline's Planned step, not a line over the picture.
  assert.match(read(CHANGES), /\{plan && !thread\.card \? <PlanLine plan=\{plan\} builtFrom=\{item\.builtFrom\} \/> : null\}/);
});

test('a request with one change says it once: the card\'s summary covers the change, and the timeline is a white card', () => {
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  const changes = read(CHANGES);
  // The card's summary, written from the request and its change, is the one summary.
  assert.match(head, /const covers = cardLook && !editing && summary\?\.basis === 'change';/);
  assert.match(head, /useMemo\(\(\) => \(\{ card: cardLook, page, covers \}\), \[cardLook, page, covers\]\)/);
  assert.match(changes, /covered=\{thread\.card && sole && !!thread\.covers\}/);
  assert.match(changes, /const summary = covered \? '' : view\?\.body\.summaryHtml \|\| '';/);
  assert.equal(message('project:topic.card.summaryByBotChange'), 'Summary by Homeroom bot, from the request and its change.');
  // The page with the reader open beside it is the three cards too, and the
  // step's note is a pale wash, not the header's yellow.
  const css = read('public/css/app.css');
  assert.match(css, /\.gc-tab-body:has\(> \.gc-spec-side-panel-open\) \.dev-request:has\(\.dev-request-rail:not\(:empty\)\) \.dev-request-sheet \{ border-top-color: transparent; box-shadow: none;/);
  const brand = css.slice(css.indexOf('/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING'));
  assert.match(brand, /--rail-note: color-mix\(in srgb, var\(--bl-wash\) 50%, var\(--bl-card\)\);/);
});

test('with no vote to cast, failed tests lead in red; running tests lead with how far they are', () => {
  const { changeFoot, barProgress } = loadTsx(MODEL);
  const failed = changeFoot({
    status: { key: 'checks', label: 'Checks failing' },
    votes: votes({ tone: 'muted' }),
    testing: testing({ name: 'Testing', figure: '2 checks failed', tone: 'bad', done: false, note: ['Homeroom bot is fixing it.'] }),
  });
  assert.equal(failed.key, 'failed');
  assert.equal(failed.gate, 'testing');
  assert.equal(failed.headline, '2 checks failed');
  assert.equal(failed.tone, 'bad');
  const segments = [{ weight: 1, pct: 100, state: 'done' }, { weight: 3, pct: 20, state: 'moving' }];
  const running = changeFoot({
    status: null,
    votes: votes({ tone: 'muted' }),
    testing: testing({ name: 'Testing', figure: 'about 6 min left', tone: 'muted', done: false, note: ['Running checks, 3 of 15'], segments }),
  });
  assert.equal(running.key, 'testing');
  assert.equal(running.headline, 'Testing');
  assert.deepEqual(JSON.parse(JSON.stringify(running.facts)), ['about 6 min left']);
  assert.equal(running.progress, 0.4, 'the bar is weighted as the Testing card draws it');
  assert.equal(barProgress([]), null);
  assert.equal(barProgress(undefined), null);
});

test('approved, going live, live and closed each say so, and one phase decides it for the foot and the timeline', () => {
  const { changeFoot, changePhase } = loadTsx(MODEL);
  const { changeRail } = loadTsx(RAIL_MODEL);
  const done = votes({ tone: 'done', done: true, figure: '2 yes votes, 2 needed', note: ['You and sam said yes.'] });
  // Approved: it has the yes it needs and its tests passed. The foot used to
  // stay a vote ("2 yes votes, 2 needed") over a timeline step titled "2 / 2".
  const approved = { status: { key: 'approvals', label: '2 / 2', yes: 2, majority: 2 }, votes: done, testing: testing() };
  assert.equal(changePhase(approved), 'approved');
  const approvedFoot = changeFoot(approved);
  assert.equal(approvedFoot.key, 'approved');
  assert.equal(words(approvedFoot.title), 'Approved');
  assert.equal(approvedFoot.tone, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(approvedFoot.sub)), ['You and sam said yes.']);
  const approvedRail = changeRail({ id: 7, author: 'evan', at: null, plan: null, ...approved });
  const approvedNow = approvedRail[approvedRail.length - 1];
  assert.equal(words(approvedNow.title), 'Approved', 'never the pill\'s "2 / 2"');
  assert.equal(words(approvedNow.note), 'It has the yes it needs. Homeroom syncs it with main, then it goes live.');
  // The merge held by GitHub: one short fact in the foot, its account in the timeline's note.
  const held = { ...approved, merge: gate({ name: 'Merging', figure: 'Waiting on GitHub', note: ['GitHub is building and scanning the release images.'] }) };
  const heldFoot = changeFoot(held);
  assert.equal(heldFoot.key, 'approved');
  assert.deepEqual(JSON.parse(JSON.stringify(heldFoot.facts)), ['Waiting on GitHub']);
  assert.deepEqual(JSON.parse(JSON.stringify(heldFoot.sub)), []);
  const heldRail = changeRail({ id: 7, author: 'evan', at: null, plan: null, ...held });
  assert.equal(words(heldRail[heldRail.length - 1].note), 'Waiting on GitHub. GitHub is building and scanning the release images.');
  // Going live: the merge leads, even over tests that have not reported
  // (the foot used to say "Testing · Not started" under a step titled "Going live…").
  const going = { status: { key: 'merging', label: 'Going live…', yes: 2, majority: 2 }, votes: done, testing: testing({ name: 'Testing', figure: 'Not started', tone: 'muted', done: false }) };
  assert.equal(changePhase(going), 'going');
  const goingFoot = changeFoot(going);
  assert.equal(goingFoot.key, 'merging');
  assert.equal(words(goingFoot.title), 'Approved');
  assert.deepEqual(goingFoot.facts.map(words), ['Going live']);
  const goingRail = changeRail({ id: 7, author: 'evan', at: null, plan: null, ...going });
  assert.deepEqual(goingRail.slice(-2).map((s) => words(s.title)), ['Approved', 'Going live']);
  assert.equal(words(goingRail[goingRail.length - 1].note), 'It has the yes it needs and is on its way to everyone.');
  // Live and closed.
  const live = changeFoot({ status: { key: 'merged', label: '✓ Live' }, votes: votes({ tone: 'done', done: true, note: ['Merged.'] }), testing: testing() });
  assert.equal(live.key, 'live');
  assert.equal(words(live.title), 'Live', 'the word alone: the check mark is the pill\'s');
  assert.equal(live.tone, 'ok');
  const reload = changeFoot({ status: { key: 'merged_reload', label: 'Live · Reload' }, votes: votes({ tone: 'done', done: true }), testing: testing() });
  assert.equal(reload.key, 'live');
  assert.equal(reload.title, null, 'a pill that says more than Live keeps its own words');
  const closed = changeFoot({ status: { key: 'closed', label: 'Closed' }, votes: votes({ tone: 'bad', note: ['Set aside.'] }), testing: testing({ tone: 'bad', done: false }) });
  assert.equal(closed.key, 'closed', 'a closed change says closed, whatever its tests said');
  assert.equal(closed.tone, 'muted');
  // A stalled release is a stop, in red, in the pill's own words.
  const stuck = changeFoot({ status: { key: 'deployment_stalled', label: 'Stuck' }, votes: votes({ tone: 'done', done: true, note: ['Its release is stuck.'] }), testing: testing() });
  assert.equal(stuck.key, 'merging');
  assert.equal(stuck.tone, 'bad');
  assert.equal(stuck.headline, 'Stuck');
  // The page reads the day it went live, and offers no vote once the group has decided.
  const change = read(CHANGE);
  assert.match(change, /if \(foot\.key === 'live' && v\.liveAt\) facts\.unshift\(t\('project:topic\.card\.foot\.since', \{ when: shortDate\(v\.liveAt\) \}\)\);/);
  assert.match(change, /const decided = foot\.key === 'approved' \|\| foot\.key === 'merging' \|\| foot\.key === 'live' \|\| foot\.key === 'closed';/);
  assert.match(read('public/js/app-view.js'), /liveAt: item\.status === 'merged' \? \(item\.live_at \|\| item\.merged_at \|\| null\) : null,/);
});

test('the card keeps to itself: the menu on its first line, a reason where a picture is missing, layers under the title, the reply box after the replies', () => {
  const css = read('public/css/app.css');
  const card = read(CARD);
  // The sheet's header row takes no height; its ⋯ sits on the kicker's line
  // and the topic is said in the kicker.
  assert.match(css, /\.dev-request:has\(\.dev-thread-card\) \.dev-request-bar \{ height: 0; position: relative; z-index: 5; box-shadow: none; \}/);
  assert.match(css, /\.dev-request:has\(\.dev-thread-card\) \.dev-request-bar \.messages-thread-action \{ pointer-events: auto; \}/);
  assert.match(css, /\.dev-request:has\(\.dev-request-bar \[data-card-menu\]\) \.dev-thread-kicker \{ padding-inline-end: 44px; \}/);
  assert.match(card, /\{dotLine\(\[app \? app\.name : null, what, category\]\)\}/);
  assert.match(read(REQUEST), /<ThreadKicker kind="request" number=\{r\.number\} category=\{r\.category\} \/>/);
  assert.match(read(CHANGE), /<ThreadKicker kind="change" number=\{v\.number\} category=\{v\.category\} \/>/);
  // No picture: why, where it would be.
  assert.match(card, /export function NoPicture\(\{ none, phase, stopped, touches, diagramLed = false \}/);
  assert.match(read(CHANGE), /\{cardLook && !v\.shots \? <NoPicture none=\{!!v\.shotsNone\} phase=\{phaseOf\(v\)\} stopped=\{fixStanding\(v\.testing\) === 'stopped'\} touches=\{v\.touches\} diagramLed=\{!!readDiagram\(body\.diagram\)\} \/> : null\}/);
  // #6814: a change with nothing visible shows "What it touches" where the
  // box was, and drops the box when the author's diagram already leads.
  assert.match(card, /if \(diagramLed\) return null;/);
  assert.match(card, /if \(touchesPicture\) return <TouchesPicture t=\{touchesPicture\} nothingVisible \/>;/);
  assert.match(card, /return <ShotsWait state="none" title=\{t\('project:topic\.card\.shots\.noneTitle'\)\} text=\{t\('project:topic\.card\.shots\.noneText'\)\} \/>;/, 'no touches keeps today\'s box');
  assert.match(read(CHANGES), /<NoPicture none=\{!!view\.v\.shotsNone\} phase=\{phaseOf\(view\.v\)\} stopped=\{fixStanding\(view\.v\.testing\) === 'stopped'\} touches=\{view\.v\.touches\} \/>/);
  assert.equal(message('project:topic.card.shots.notYetTitle'), 'No screenshots yet');
  assert.equal(message('project:topic.card.shots.neverTitle'), 'No screenshots');
  // A layer opens directly under the title and stays inside the card, which
  // grows to hold it; the scrim starts under the title.
  assert.match(card, /const wanted = from > floor && seen >= height \? from \+ 8 : floor;/);
  assert.match(card, /card\.style\.minHeight = need > room \? `\$\{need\}px` : card\.style\.minHeight;/);
  assert.match(css, /\.dev-step-scrim \{ position: absolute; inset: -6px; top: var\(--step-floor, -6px\);/);
  // The tests as counts and one row per failure; the Testing card is put away under them.
  const change = read(CHANGE);
  assert.match(change, /<ChecksSummary v=\{v\} actions=\{<>\{testingActions\}\{testAction\}<\/>\} \/>/);
  assert.match(css, /\[data-gates-show="checks"\]:has\(> \[data-checks-summary\]\) \.dev-change-pair \[data-change-gate="testing"\] \{ display: none; \}/);
  assert.match(read('public/js/app-view.js'), /const blocking = failures\.filter\(\(row\) => !row\.advisory\);/);
  assert.equal(message('project:topic.card.checks.failed', { count: 2 }), '2 failed');
  assert.equal(message('project:topic.card.checks.passed', { count: 736 }), '736 passed');
  // The reply box follows a short thread, and a phone's foot buttons share the row.
  assert.match(css, /\.dev-request:has\(\.dev-thread-card\) \.dev-request-scroll \{ flex-grow: 0; \}/);
  assert.match(css, /\.dev-thread-foot-acts > :is\(button, a\), \.dev-thread-foot-acts > \[data-thread-foot-next\] > :is\(button, a\) \{ flex: 1 1 auto; justify-content: center; \}/);
  // A request's foot does not repeat the timeline's note, nor show a button that only says the bot is busy.
  const request = read(REQUEST);
  assert.match(request, /const repeats = !!said2 && !!noted && \(noted\.includes\(said2\) \|\| said2\.includes\(noted\)\);/);
  assert.match(request, /const a = s\.action && !\(s\.action\.disabled && foot\?\.busy\) \? s\.action : null;/);
  // The timeline's notes have three tones, and older steps show their day only.
  assert.match(css, /\.dev-rail-note\[data-rail-note="plain"\] \{ background: var\(--rail-note-plain, /);
  assert.match(css, /\.dev-rail-note\[data-rail-note="bad"\] \{ background: var\(--rail-bad-tint\); \}/);
  assert.match(read('frontend/src/features/dev-board/topic/thread-rail.tsx'), /: today \? stamp\.text : shortDate\(s\.at\);/);
});

test("a request's foot is its standing in words, with a sentence for every stage", () => {
  const { requestFoot, stageNote } = loadTsx(MODEL);
  const building = requestFoot(standing({ stage: 'building' }), true);
  assert.equal(building.key, 'building');
  assert.equal(words(building.headline), 'Building');
  assert.equal(building.busy, true);
  assert.equal(building.tone, null);
  assert.ok(words(building.sub), 'a line under it, the server\'s or the plain one');
  assert.equal(requestFoot(standing({ stage: 'stopped' }), true).tone, 'bad');
  assert.equal(requestFoot(standing({ stage: 'live' }), true).tone, 'ok');
  assert.equal(requestFoot(standing({ stage: 'closed' }), true).tone, 'muted');
  const stages = ['reading', 'planning', 'waiting_for_you', 'building', 'checking', 'up_for_vote', 'going_live', 'live', 'stopped', 'closed'];
  for (const stage of stages) {
    const note = stageNote({ stage });
    assert.ok(note && message(note.id), `${stage} has a sentence in the catalog`);
  }
  assert.equal(stageNote({ stage: 'waiting_for_you', why: 'question' }).id, 'project:topic.rail.note.question');
  assert.equal(stageNote({ stage: 'waiting_for_you', why: 'plan' }).id, 'project:topic.rail.note.plan');
  assert.equal(stageNote({ stage: 'checking', line: { code: 'shots' } }).id, 'project:topic.rail.note.shots');
});

test('the step store: one step open on one page, and a second press closes it', () => {
  const { sameStep, isGates, openStep, closeStep, stepStore } = loadTsx(STORE);
  assert.equal(sameStep({ kind: 'request' }, { kind: 'request' }), true);
  assert.equal(sameStep({ kind: 'plan', key: 'a' }, { kind: 'plan', key: 'b' }), false);
  assert.equal(sameStep({ kind: 'checks', changeId: 5 }, { kind: 'checks', changeId: 5 }), true);
  assert.equal(sameStep({ kind: 'checks', changeId: 5 }, { kind: 'votes', changeId: 5 }), false);
  assert.equal(sameStep(null, { kind: 'request' }), false);
  assert.equal(isGates({ kind: 'checks', changeId: 5 }, 5), true, "a change's tests and its votes are one layer");
  assert.equal(isGates({ kind: 'votes', changeId: 5 }, 5), true);
  assert.equal(isGates({ kind: 'votes', changeId: 6 }, 5), false);
  assert.equal(isGates({ kind: 'plan', key: 'a' }, 5), false);
  openStep('request:7', { kind: 'request' });
  assert.equal(stepStore.get().page, 'request:7');
  assert.equal(stepStore.get().open.kind, 'request');
  openStep('request:7', { kind: 'plan', key: 'a' });
  assert.equal(stepStore.get().open.kind, 'plan', 'another step replaces the open one');
  openStep('request:7', { kind: 'plan', key: 'a' });
  assert.equal(stepStore.get().open, null, 'pressing the open step closes it');
  openStep('change:9', { kind: 'votes', changeId: 9 });
  closeStep();
  assert.equal(stepStore.get().open, null);
});

test('the timeline: a passed test opens its checks, and the last step opens its votes, its tests or the bot\'s progress', () => {
  const { requestRail, changeRail, stepOpens } = loadTsx(RAIL_MODEL);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const built = changeRail({
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: null,
    testing: testing(),
    status: { key: 'needs_vote', label: 'Vote · 0/1', yes: 0, majority: 1 },
    votes: votes({ figure: 'Needs 1 more yes', tone: 'ask' }),
  });
  const tested = built.find((s) => s.key === 'tested');
  assert.equal(words(tested.link.label), 'See checks');
  assert.deepEqual(plain(stepOpens(tested)), { kind: 'checks', changeId: 51 });
  const now = built[built.length - 1];
  assert.deepEqual(plain(stepOpens(now)), { kind: 'votes', changeId: 51 });
  assert.equal(stepOpens(built.find((s) => s.key === 'built')), null, 'a step with nothing to show is not a press');
  const live = changeRail({ id: 51, author: 'evan', at: null, plan: null, testing: testing(), status: { key: 'merged', label: 'Live', yes: 1 }, votes: votes({ tone: 'done', done: true }), liveAt: '2026-11-14T09:02:00Z' });
  const liveNow = live[live.length - 1];
  assert.equal(words(liveNow.title), 'Live');
  assert.equal(liveNow.at, '2026-11-14T09:02:00Z', 'the Live step has its date');
  assert.equal(words(liveNow.desc), 'Everyone has it now.', 'one plain line: nothing is waited for, so no note box');
  assert.equal(liveNow.note, null);
  assert.deepEqual(live.map((s) => words(s.title)), ['Built', 'Tested', 'Approved', 'Live']);
  const asked = requestRail({ asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: standing({ stage: 'building' }), track: true });
  const last = asked[asked.length - 1];
  assert.deepEqual(plain(stepOpens(last)), { kind: 'track' });
  assert.ok(words(last.note), 'the last step always says what happens next');
  const untracked = requestRail({ asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: standing({ stage: 'building' }) });
  assert.equal(stepOpens(untracked[untracked.length - 1]), null);
});

test('both heads draw the card only outside the frame\'s looks, and keep Votes, Testing and the progress card in the page', () => {
  const change = read(CHANGE);
  const request = read(REQUEST);
  for (const src of [change, request]) {
    assert.match(src, /const cardLook = !frame;/);
    assert.match(src, /\{cardLook \? <ThreadKicker kind="(change|request)"/);
    assert.match(src, /useEffect\(\(\) => closeStep, \[page\]\);/, 'a step left open does not follow the reader to the next page');
    assert.match(src, /<ThreadRail steps=\{railSteps\} onOpen=\{openRail\} current=\{cardLook \? openNow : null\} \/>/);
  }
  // A change: the pair wraps itself in a layer that stays mounted, so the
  // declared checks and the doors to the vote still find the cards; shut,
  // the cards carry no buttons, so the page offers each action once.
  assert.match(change, /const layer = thread\.card && !ballot;/);
  assert.match(change, /const shut = layer && !isGates\(openNow, id\);/);
  assert.match(change, /if \(!stick \|\| layer\) return;/, 'the pair never floats under the header from inside the layer');
  assert.match(change, /if \(!layer\) return drawn;\s*return \(\s*<GatesShut\.Provider value=\{shut\}>\s*<StepLayer\s+keep\s+open=\{isGates\(openNow, id\)\}\s+name="gates"/);
  assert.match(change, /const voteAction = shut \? null : acts\.voteAction;/);
  assert.match(change, /if \(useContext\(GatesShut\)\) return null;/, 'Fix it is the foot\'s while the layer is shut');
  // The private suggestion rides at the foot's end, inside its band, so the
  // foot is the last thing in the card.
  assert.match(change, /\{cardLook \? <ChangeFoot id=\{id\} card=\{card\} v=\{v\} page=\{page\} tail=\{workWithBot\} \/> : null\}/);
  assert.match(change, /\{cardLook \? null : workWithBot\}/);
  assert.match(change, /\{cardLook && body\.summaryBy \? <WordsBy who=\{body\.summaryBy\}/);
  assert.match(change, /<ThreadCardContext\.Provider value=\{cardContext\}>/);
  // A request: the old status box gives way to the foot, and the bot's
  // progress card is the content of the last step's layer.
  assert.match(request, /\{\(working && !r\.status\.closed\) \|\| cardLook \? null : \(\s*<RequestStatus/);
  assert.match(request, /<StepLayer keep open=\{openNow\?\.kind === 'track'\} name="track"[\s\S]*?<div className="dev-request-track"/);
  assert.match(request, /<WordsBy who="asker" name=\{r\.asker \|\| null\} \/>/);
  assert.match(request, /<ThreadCardContext\.Provider value=\{cardContext\}>/);
  // A lone change under a request draws the same foot, over the same pair.
  const changes = read(CHANGES);
  assert.match(changes, /const lone = thread\.card && !ballot;/);
  assert.match(changes, /\{lone && view && item\.state !== 'underway' && hasCards\(item\)\s*\? <ChangeFoot id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} page=\{thread\.page\} tail=\{tail\} \/> : null\}/);
});

test('the layer: over the card, × on its right, Escape and the dimmed card close it', () => {
  const src = read(CARD);
  assert.match(src, /closest<HTMLElement>\('\[data-thread-card\]'\)/, 'it measures the card it lies over');
  assert.match(src, /if \(event\.key === 'Escape'\) \{ event\.stopPropagation\(\); onClose\(\); \}/);
  assert.match(src, /className="dev-step-scrim" tabIndex=\{-1\}[^>]*onClick=\{onClose\}/);
  assert.match(src, /className="dev-step-close" data-step-close=""/);
  assert.match(src, /if \(!open && !keep\) return null;/);
  assert.match(src, /data-step-layer=\{name\} data-open=\{open \? 'true' : 'false'\} hidden=\{!open\}/);
  const head = src.slice(src.indexOf('className="dev-step-head"'), src.indexOf('className="dev-step-body"'));
  assert.ok(head.indexOf('dev-step-title') < head.indexOf('dev-step-close'), 'the × is the header\'s last thing, on its right');
  assert.doesNotMatch(head, /ChevronLeft|ArrowLeft/, 'no back arrow');
});

test('the stylesheet: the card\'s block sits after the rail\'s and before the bell\'s sheet, with a twin for reduced motion', () => {
  const css = read('public/css/app.css');
  const rail = css.indexOf("THE THREAD'S RAIL");
  const card = css.indexOf("THE THREAD'S CARD");
  const bell = css.indexOf("THE BELL'S SHEET");
  assert.ok(rail > 0 && card > rail && bell > card);
  const block = css.slice(card, bell);
  assert.match(block, /\.dev-thread-card > :first-child:not\(\.min-w-0\) \{ display: none; \}/, 'the author\'s avatar gives way to the kicker');
  assert.match(block, /\.dev-thread-card \{ position: relative; --foot-x: 16px; --foot-b: 16px; \}/, 'the card is the layer\'s containing block, and names its own gutters');
  assert.match(block, /\.dev-step-layer \{ position: absolute; inset: 0;/, 'the layer lies over the card and adds no height');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{ \.dev-step-sheet \{ animation: none; \} \}/);
  assert.match(block, /:where\(html\[data-motion="reduce"\]\) \.dev-step-sheet \{ animation: none; \}/);
  assert.match(block, /\.dev-thread-foot\[data-thread-foot-tone="bad"\] \.dev-thread-foot-head \{ color: var\(--state-blocked\); \}/);
  assert.doesNotMatch(block, /gray-|indigo-/);
});

test('two competing changes are seeded on a staging copy only, as fake rows for the demo request', async () => {
  const { seedStagingCompetingChanges } = require('../src/db/migrate');
  const was = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  try {
    await seedStagingCompetingChanges({ query() { assert.fail('must not seed production'); } });
  } finally {
    if (was === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = was;
  }
  const calls = [];
  process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingCompetingChanges({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } });
  } finally {
    if (was === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = was;
  }
  assert.equal(calls.length, 2, 'two changes');
  for (const call of calls) {
    assert.match(call.sql, /ON CONFLICT \(id\) DO NOTHING/, 'idempotent');
    assert.match(call.sql, /ARRAY\[900001\]/, 'both for the demo request');
    assert.match(call.args[2], /^\[Mock\] Staging demo: /, 'obviously fake');
    assert.match(call.args[7], /^staging-demo-/, 'by fake people, never whoever opened the preview');
  }
});

test('the ballot\'s foot says who leads, that the leaders are level, or that the group is choosing', () => {
  const { ballotHeadline } = loadTsx(MODEL);
  const say = (id, values) => message(id, values);
  assert.equal(ballotHeadline([{ label: 'A', yes: 0 }, { label: 'B', yes: 0 }], say), 'Choosing between 2 changes');
  assert.equal(ballotHeadline([{ label: 'A', yes: 2 }, { label: 'B', yes: 1 }], say), 'A leads, 2 to 1');
  assert.equal(ballotHeadline([{ label: 'A', yes: 1 }, { label: 'B', yes: 3 }], say), 'B leads, 3 to 1');
  assert.equal(ballotHeadline([{ label: 'A', yes: 2 }, { label: 'B', yes: 2 }], say), 'A and B are level');
  assert.equal(ballotHeadline([{ label: 'A', yes: 2 }, { label: 'B', yes: 2 }, { label: 'C', yes: 2 }], say), 'The leading changes are level');
  assert.equal(ballotHeadline([{ label: 'A', yes: 1 }], say), 'A leads, 1 to 0');
  // One Vote button; the question comes after the press.
  const changes = read(CHANGES);
  assert.match(changes, /\{thread\.card \? \([\s\S]*?<ThreadFoot\s+what="ballot"/);
  assert.match(changes, /className="dev-vote-btn" data-ballot-vote="" onClick=\{\(\) => setAsking\(true\)\}/);
  assert.match(changes, /<p className="dev-thread-foot-q">\{t\('project:topic\.card\.ballot\.which'\)\}<\/p>/);
  assert.match(changes, /setBusy\(false\);\s*setAsking\(false\);/, 'a vote cast puts the question away');
  assert.equal(message('project:topic.card.ballot.which'), 'Which one should go live?');
});

test('#6814: a change with nothing visible shows "What it touches" where the empty box was, and nothing under a diagram', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const touches = {
    version: 1, files: 2,
    areas: [
      { key: 'screens', label: 'Screens', files: 0, lines: 0 },
      { key: 'server', label: 'Server', files: 2, lines: 9 },
      { key: 'database', label: 'Database', files: 0, lines: 0 },
      { key: 'tests', label: 'Tests', files: 0, lines: 0 },
    ],
  };
  const none = { none: true, phase: 'live', stopped: false };
  const drawn = renderComponent(CARD, 'NoPicture', { ...none, touches });
  assert.match(drawn, /class="dev-ws-diagram dev-ws-touches"/);
  assert.match(drawn, /Nothing on screen changes/);
  assert.doesNotMatch(drawn, /data-thread-wait/, 'the empty box is not drawn under the picture');
  assert.equal(renderComponent(CARD, 'NoPicture', { ...none, touches, diagramLed: true }), '',
    'the author’s diagram already leads the page');
  const box = renderComponent(CARD, 'NoPicture', { ...none });
  assert.match(box, /data-thread-wait="none"/, 'no picture read yet keeps today’s box');
  assert.match(box, /Nothing you can see changes/);
});

test('a request with a summary shows it on the card, says what it was written from, and keeps the asker\'s words a press away', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const view = (over = {}) => ({
    number: 4417, category: null, menuKey: '', asker: 'maya', askedAt: null, askedTime: '', askedTitle: '',
    title: 'Dark mode switch', titleEditing: null, bodyHtml: '<div class="dev-issue-body"><p>Settings is three taps away.</p></div>',
    bodyMarkdown: 'Settings is three taps away.',
    editor: { issue: 4417, markdown: '', source: null, canEdit: false },
    status: { stage: 'spec', lead: null, note: null, fine: null, action: null, closed: null },
    ...over,
  });
  const own = renderComponent(REQUEST, 'RequestHead', { r: view() });
  assert.match(own, /Settings is three taps away\./);
  assert.match(own, /<p class="dev-thread-by" data-thread-by="asker"><span>maya’s own words\.<\/span><\/p>/);
  const withSummary = renderComponent(REQUEST, 'RequestHead', { r: view({ summary: { text: 'maya asked for a switch. <b>Homeroom bot</b> has a plan.', basis: 'plan' } }) });
  assert.match(withSummary, /<p>maya asked for a switch\. &lt;b&gt;Homeroom bot&lt;\/b&gt; has a plan\.<\/p>/, 'plain text, escaped');
  assert.doesNotMatch(withSummary, /Settings is three taps away\./, 'the asker\'s words are the Asked step\'s, not the card\'s');
  assert.match(withSummary, /data-thread-by="bot">.*?<span>Summary by Homeroom bot, from the request and the plan\.<\/span><\/p>/);
  assert.equal(message('project:topic.card.summaryByBotChange'), 'Summary by Homeroom bot, from the request and its change.');
  assert.equal(message('project:topic.card.summaryByBotChanges'), 'Summary by Homeroom bot, from the request and its changes.');
  const request = read(REQUEST);
  assert.match(request, /const summary = !frame && r\.summary\?\.text \? r\.summary : null;/, 'the frame\'s looks keep the request as written');
  assert.match(request, /\{unbuilt\.length && !cardLook \? \(/, 'the plan card gives way to Read plan in the foot');
  assert.match(request, /data-thread-foot-plan=\{plan\.key\} onClick=\{\(\) => openStep\(page, \{ kind: 'plan', key: plan\.key \}\)\}/);
  // The view takes it from the request's read, and only a basis it knows.
  const av = read('public/js/app-view.js');
  assert.match(av, /summary: issue\.summary && typeof issue\.summary\.text === 'string' && issue\.summary\.text\.trim\(\)/);
});

test('the card\'s picture is the viewer read as one picture: After first, tiles for its screens, the legend beside them', () => {
  const change = read(CHANGE);
  assert.match(change, /if \(auto && after\) after\.checked = true;/, 'it starts on After, not side by side');
  assert.match(change, /pick\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/, 'a tile presses the viewer\'s own screen pick');
  assert.match(change, /<ShotsCard s=\{v\.shots\} single=\{cardLook\} status=\{v\.status\?\.key \|\| null\} \/>/);
  assert.match(change, /className="dev-thread-tile"\s+aria-pressed=\{i === at\}/);
  assert.equal(message('project:topic.card.shots.screenOf', { index: 2, total: 3 }), '2 of 3 screens');
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf("THE THREAD'S CARD"), css.indexOf("THE BELL'S SHEET"));
  assert.match(block, /\[data-thread-picture\] \.dev-change-viewer:not\(:popover-open\) :is\(\.dev-change-card-name, \.shots-seg-both, \.shots-screen-nav, \.shots-view-notes\) \{ display: none; \}/,
    'side by side, the pager and the viewer\'s own legend give way; expanded to the window it is its usual self');
  assert.match(block, /\[data-thread-picture\] \.dev-change-viewer:not\(:popover-open\) \.shots-bar \{\s*position: absolute;/, 'the switch lies over the picture');
});

// ── 17 Nov 2026: closer to the prototype ────────────────────────────────

test('a request with competing changes is one card: a row each with Look, one foot, and each change opened over the card', () => {
  const changes = read(CHANGES);
  // The row: its picture (the After shot, else its letter), its letter and
  // name, who built it, its tests and its yes votes, and Look. The whole row
  // is the press, and it opens the change through the step store.
  assert.match(changes, /function OptionRow\(\{ item, i, view, yes, on, onLook \}/);
  assert.match(changes, /const pic = shots \? \(shots\.after \|\| shots\.before \|\| null\) : null;/);
  assert.match(changes, /<button\s+type="button"\s+role="listitem"\s+className="dev-thread-opt"\s+data-change-row=\{letter\}\s+data-thread-change-row=\{item\.id\}\s+data-change-row-open=\{item\.id\}\s+aria-expanded=\{on\}\s+onClick=\{onLook\}/);
  assert.match(changes, /onLook=\{\(\) => openStep\(thread\.page, \{ kind: 'change', changeId: o\.id \}\)\}/);
  // Nothing is drawn under the foot: the folds are the standard page's, and
  // under the card look each change is a layer kept in the page while shut,
  // so a door to it still finds it.
  assert.match(changes, /\{thread\.card \? \(\s*\/\/ The card look: nothing under the foot\.[\s\S]*?<StepLayer\s+key=\{o\.id\}\s+keep\s+open=\{looked === o\.id\}\s+name="look"/);
  assert.match(changes, /<LookedChange item=\{o\} i=\{i\} view=\{views\[i\]\}/);
  assert.match(changes, /data-thread-look=\{item\.id\} data-thread-fold=\{open \? 'open' : 'shut'\}/);
  // It is voted on in the ballot, the card's foot: the opened change draws
  // its section as a ballot's change, whose Votes card has no button.
  assert.match(changes, /\{open \? <ChangeBody item=\{item\} view=\{view\} plan=\{plan\} ballot look request=\{request\} \/> : null\}/);
  // Opened, it is its summary, two facts and its picture: no Votes card and
  // no status pill, since the vote is the card's one Vote button.
  assert.match(changes, /\{look && view \? <LookFacts v=\{view\.v\} \/> : null\}/);
  assert.match(changes, /\) : look \? null : view \? \(\s+<ChangeGates /);
  assert.equal(message('project:topic.card.look.yes', { count: 2 }), '2 yes');
  // The timeline names a competing change by its letter, as the card does,
  // and its step opens it over the card.
  const { requestRail } = loadTsx('frontend/src/features/dev-board/topic/rail-model.ts');
  const steps = requestRail({
    asker: 'maya', askedAt: '2026-11-07T10:00:00Z', specs: [], standing: null, yours: false,
    changes: [
      { type: 'change', id: 7, number: 70, by: 'sam', at: '2026-11-08T10:00:00Z', state: 'review' },
      { type: 'change', id: 8, number: 80, by: 'ana', at: '2026-11-09T10:00:00Z', state: 'review' },
    ],
    letters: new Map([[7, 'A'], [8, 'B']]),
  });
  const built = steps.filter((s) => s.icon === 'built');
  assert.deepEqual(built.map((s) => s.title), [
    { id: 'project:topic.rail.builtLettered', values: { letter: 'A' } },
    { id: 'project:topic.rail.builtLettered', values: { letter: 'B' } },
  ]);
  assert.deepEqual(built[0].link.open, { kind: 'change', changeId: 7 });
  assert.equal(message('project:topic.rail.builtLettered', { letter: 'A' }), 'Change A built');
  const request = read(REQUEST);
  assert.match(request, /if \(cardLook && open\.kind === 'change' && competes\(open\.changeId\)\) \{\s*openStep\(page, open\);/);
  assert.match(request, /else if \(competes\(open\.changeId\)\) openStep\(page, \{ kind: 'change', changeId: open\.changeId \}\);/);
});

test('a request\'s one change is the card\'s own: one picture with the switch, no second title and no pill', () => {
  const changes = read(CHANGES);
  assert.match(changes, /\{view\?\.v\.shots \? \(thread\.card\s*\? <ShotsCard s=\{view\.v\.shots\} single status=\{view\.v\.status\?\.key \|\| null\} \/>\s*: <ShotsPair/);
  assert.match(changes, /const footed = thread\.card && !!view && item\.state !== 'underway' && hasCards\(item\);/);
  assert.match(changes, /<ChangeLine item=\{item\} view=\{view\} propose=\{propose\} footed=\{footed\} sole=\{thread\.card && sole\} \/>/);
  assert.match(changes, /\{status && !footed \? <span className="shrink-0" data-thread-change-status=/, 'the foot says where it stands');
  assert.match(changes, /<h3 className=\{sole \? 'sr-only' :/, 'the title stays for a screen reader and the declared checks');
  assert.match(changes, /sole=\{!ballot && changes\.length === 1\}/);
});

test('one step, one thing: the Tested step shows the tests, the vote\'s step the votes', () => {
  const change = read(CHANGE);
  assert.match(change, /sub=\{openNow\?\.kind === 'checks' \? t\('project:topic\.card\.layer\.checksSub'\) : t\('project:topic\.card\.layer\.votesSub'\)\}/);
  assert.match(change, /<div data-gates-show=\{isGates\(openNow, id\) \? \(openNow\?\.kind === 'checks' \? 'checks' : 'votes'\) : undefined\}>/);
  const css = read('public/css/app.css');
  assert.match(css, /\[data-gates-show="checks"\] \.dev-change-pair \[data-change-gate="votes"\],\s*\[data-gates-show="votes"\] \.dev-change-pair :is\(\[data-change-gate="testing"\], \[data-change-gate="merge"\]\) \{ display: none; \}/);
  assert.equal(message('project:topic.card.layer.checksSub'), 'The tests on this version');
  assert.equal(message('project:topic.card.layer.votesSub'), 'The votes so far');
});

test('a step\'s layer never covers the card\'s title', () => {
  const card = read('frontend/src/features/dev-board/topic/thread-card.tsx');
  assert.match(card, /const title = card\.querySelector<HTMLElement>\('\.dev-request-title'\);/);
  assert.match(card, /const floor = title \? Math\.max\(8, Math\.round\(title\.getBoundingClientRect\(\)\.bottom - rect\.top\) \+ 8\) : 8;/);
  assert.match(card, /const top = Math\.round\(Math\.max\(floor, Math\.min\(wanted, Math\.max\(floor, room - height - 8\)\)\)\);/);
});

test('the foot is a band that runs to the card\'s end when it ends the card, with the one action as a full pill', () => {
  const card = read('frontend/src/features/dev-board/topic/thread-card.tsx');
  // The foot reads whether anything drawn follows it, up to the card.
  assert.match(card, /el\.toggleAttribute\('data-thread-foot-end', end\);/);
  assert.match(card, /if \(next\.hidden \|\| next\.classList\.contains\('dev-step-layer'\)\) continue;/);
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf("THE THREAD'S CARD"), css.indexOf("THE BELL'S SHEET"));
  assert.match(block, /\.dev-request-root\.dev-thread-card \{ padding: 4px var\(--foot-x\) var\(--foot-b\); \}/);
  assert.match(block, /\.dev-thread-foot \{[^}]*margin: 16px calc\(-1 \* var\(--foot-x\)\) 0; padding: 14px var\(--foot-x\);[^}]*background: var\(--thread-foot, transparent\);\s*\}/);
  assert.match(block, /\.dev-thread-foot\[data-thread-foot-end\] \{\s*margin-bottom: calc\(-1 \* var\(--foot-b\)\);/);
  assert.match(block, /\.dev-thread-foot-acts :is\(button, a\):not\(\.dev-change-gate-link\) \{\s*height: 40px;/);
  assert.match(block, /\.dev-thread-foot-acts \.dev-vote-caret \{ display: none; \}/, 'one Vote, and the question after');
  // The brand look: the sun pill, white pills beside it, the foot's band.
  const brand = css.slice(css.indexOf('/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING'));
  assert.match(brand, /--thread-foot: color-mix\(in srgb, var\(--bl-sun\) 9%, var\(--bl-card\)\);/);
  assert.match(brand, /\.dev-thread-foot-acts :is\(\.dev-vote-btn:not\(\.dev-vote-btn-yes\), \.dev-request-primary\),[^{]*\{\s*background: var\(--bl-sun\);\s*color: var\(--bl-on-sun\);\s*box-shadow: var\(--bl-pill-edge\);/);
  assert.match(brand, /\.dev-rail \{ --rail-now-box: var\(--bl-page\); --rail-now-box-line: var\(--app-sheet-line\); --rail-note-plain: transparent; \}/);
});

test('the picture\'s chip says what the side is for this change', () => {
  const change = read(CHANGE);
  assert.match(change, /data-thread-chips=\{chips \? '' : undefined\}/);
  assert.match(change, /'--thread-chip-after': JSON\.stringify\(chips\.after\), '--thread-chip-before': JSON\.stringify\(chips\.before\)/);
  assert.equal(message('project:topic.card.shots.chipIfPasses'), 'If it passes · After');
  assert.equal(message('project:topic.card.shots.chipTodayBefore'), 'Today · Before');
  assert.equal(message('project:topic.card.shots.chipLive'), 'Live now');
  const css = read('public/css/app.css');
  assert.match(css, /\.shots-flip-chip-after::after \{ content: var\(--thread-chip-after\); \}/);
  assert.match(css, /\.shots-flip-chip-before::after \{ content: var\(--thread-chip-before\); \}/);
});

test('a run that worked out its screens is drawn with the Needs you slider, not the tinted viewer', () => {
  const PICTURE = 'frontend/src/features/dev-board/topic/thread-picture.tsx';
  const change = read(CHANGE);
  // The card look hands such a run to the slider; a run without screens keeps the viewer.
  assert.match(change, /if \(single && s\.state === 'verified' && s\.screens && s\.screens\.length\) \{/);
  assert.match(change, /return <ThreadPicture s=\{s\} captions=\{voting \? null : chips\} \/>;/);
  const picture = read(PICTURE);
  assert.match(picture, /import \{ CompareSlider \} from '\.\.\/\.\.\/review-flow\/compare';/);
  assert.match(picture, /ground="var\(--messages-surface-2\)"/, 'the ground is the card\'s own, never a tint');
  assert.doesNotMatch(picture, /shots-box|shots-flip-chip|groundFor/);
  assert.match(picture, /kind: 'shots', ref: \{ changeId: s\.changeId \}/, 'Expand opens the full viewer in the detail column');
  // The slider prints the page's own words for a change that is live or closed.
  const compare = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(compare, /\{captions \? captions\.after : <RichMessage id="communities:review\.compare\.captionAfter"/);
  assert.match(compare, /\{captions \? captions\.before : <RichMessage id="communities:review\.compare\.captionBefore"/);
  // The page's model carries the screens.
  assert.match(read('public/js/app-view.js'), /return html \? \{ state: 'verified', html, line: null, thumbs, screens, changes, changeId: Number\(item\.id\) \|\| null \} : null;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-thread-compare \{\s*--rf-black: var\(--text-primary\); --rf-cream: var\(--bg-primary\); --rf-line: var\(--app-sheet-line\);/);

  // The frame: the changed area, never larger than life, in a picture no taller than its room.
  const { pictureFrame, PICTURE_MAX } = loadTsx(PICTURE);
  const screen = (over = {}) => ({
    viewport: 'desktop', width: 1280, before: { url: '/b', height: 800 }, after: { url: '/a', height: 800 },
    regions: [{ n: 1, b: [100, 200, 400, 60], a: [100, 200, 400, 60], bMark: null, aMark: null }], changes: [1], ...over,
  });
  const small = pictureFrame(screen(), 600);
  assert.equal(small.place.scale, 1, 'a small change is shown at life size');
  assert.ok(small.height >= 300 && small.height <= PICTURE_MAX, `height ${small.height}`);
  const tall = pictureFrame(screen({ viewport: 'mobile', width: 390, before: { url: '/b', height: 3000 }, after: { url: '/a', height: 3000 }, regions: [{ n: 1, b: [0, 0, 390, 2800], a: [0, 0, 390, 2800], bMark: null, aMark: null }] }), 600);
  assert.ok(tall.height <= PICTURE_MAX);
  assert.ok(tall.place.scale < 1, 'a tall change is fitted to the room');
  const phone = pictureFrame(screen(), 340);
  assert.ok(phone.height <= 374 && phone.height >= 200, `height ${phone.height}`);
});

// #6807: a change whose failing check is not its own, while Homeroom bot gets
// that check fixed, keeps Tests failed for its foot: it is not Stopped.
test('#6807: a change the bot is getting its failing check fixed for says Tests failed', () => {
  const { changeFoot } = loadTsx(MODEL);
  const bad = testing({ name: 'Testing', figure: 'Found a problem', tone: 'bad', done: false, note: [] });
  const foot = changeFoot({
    status: { key: 'needs_vote', label: 'Vote · 0/2' }, votes: votes({ tone: 'ask' }),
    testing: { ...bad, botFix: 'fixing', authorNote: message('changes:page.testing.note.botFixingCheck', { number: 6805 }) },
  });
  assert.equal(foot.key, 'failed');
  assert.equal(words(foot.title), 'Tests failed', 'not "Stopped: its tests still fail"');
});
