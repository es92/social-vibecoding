'use strict';

// "Your community, started" (#4041, #4042): the screen right after Make it
// (frontend/src/features/first-session/made.tsx), its invite sheet, the
// screen after sharing, and the people row (./people-row.tsx).
//
// Evan's test on iPhone, 6 October 2026: the screen led with the build, a
// "Needs you" card asked for the plan before anyone was invited, and after
// sharing "Go to the Homeroom app" did not say where it led. The canvas boards
// C3-started, C4-invite-sheet and C5-shared: the community first, one quiet
// line, and buttons that keep their places (owner, 8 October 2026). The
// sheet's Copy link on a computer is #4180's (tests/first-session-copy-link).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const SRC = read(`${DIR}/made.tsx`);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const made = loadTsx(`${DIR}/made.tsx`);
const people = loadTsx(`${DIR}/people-row.tsx`);


const MADE = { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 };
const draw = (props) => renderToHtml(createElement(made.MadeScreen, { made: MADE, me: 'maya', onContinue() {}, onOpenChat() {}, ...props }));

test('the words: the community first, one quiet line, buttons that say what comes next', () => {
  assert.equal(message(made.COMMUNITY_LABEL), 'Your new community');
  assert.equal(message(made.INVITE_HINT), 'Invite people to use it and help improve it together.');
  assert.equal(message(made.PREVIEW_LABEL), 'What they\'ll see');
  // What went out, and nothing about what comes next (Evan, 15 Oct 2026:
  // "Next, a short tour." is gone with the tour).
  assert.equal(made.sharedLine('shared'), 'Invite shared.');
  // Where there is no share sheet, the link is copied (decided 6 October 2026).
  assert.equal(made.sharedLine('copied'), 'Link copied.');
  assert.equal(made.continueLabel('first-session', true, 'Plant Pal'), 'Go to app');
  assert.equal(made.continueLabel('first-session', true, 'Plant Pal', true), 'Continue');
  assert.equal(made.continueLabel('first-session', false, 'Plant Pal'), 'Invite people later');
  for (const words of [message(made.COMMUNITY_LABEL), message(made.INVITE_HINT), message(made.PREVIEW_LABEL), made.sharedLine('shared'), made.sharedLine('copied'), message(made.NO_BOT_NOTE)]) {
    assert.doesNotMatch(words, /!|—|\bgroup\b/, words);
  }
});

test('C3: who, then the community, then the app, then one line over two buttons', () => {
  const html = draw();
  // Run five: a project the bot builds checks for questions first, in the
  // buttons' place; one it does not build shows them from the start.
  const buttons = draw({ made: { ...MADE, conversationId: null } });
  // Run six: one thing going on while it checks, the checking line under
  // the project, with no build line and no setup card beside it.
  assert.doesNotMatch(html, /data-build-line=|data-made-setup/);
  assert.ok(html.indexOf('data-featured-card=') < html.indexOf('data-first-session-checking=""'));
  assert.doesNotMatch(html, /Share invite|Invite people later/);
  assert.ok(buttons.indexOf('>Invite people to use it and help improve it together.</p>') < buttons.indexOf('>Share invite</button>'));
  assert.ok(buttons.indexOf('>Share invite</button>') < buttons.indexOf('>Invite people later</button>'));
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  // The Homeroom logo bar first, as on the story, the invite page and the
  // make screen (owner, 7 October 2026), then the people row 16px under it.
  assert.ok(at('data-first-session-made-top=""') < at('data-first-session-people="1"'));
  // (#6801: the bar holds still for Create's ✕, which only Create draws.)
  assert.match(CODE, /<div data-first-session-made-top="" className="relative flex h-\[max\(52px,calc\(env\(safe-area-inset-top\)\+32px\)\)\] shrink-0 items-center justify-center pt-\[env\(safe-area-inset-top\)\]">\s+\{closeButton\}\s+<Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" \/>/);
  assert.match(CODE, /max-w-sm grow flex-col px-6 pb-\[max\(36px,env\(safe-area-inset-bottom\)\)\]">/);
  // The faces and the heading over the thumbnail, one block centred in the
  // room between the bar and the line over the buttons. The name is the
  // thumbnail's alone. Run seven: at the top while it checks or asks
  // (tests/first-session-one-thing), so this one, checking, stands there.
  assert.match(CODE, /<div data-first-session-made-body="" className=\{madeBodyClass\(screen\)\}>/);
  assert.equal(made.madeBodyClass('invite'), 'flex grow flex-col justify-center gap-4 py-4');
  assert.match(html, /<div data-first-session-made-body="" class="flex flex-col gap-4 py-4">/);
  assert.match(buttons, /<div data-first-session-made-body="" class="flex grow flex-col justify-center gap-4 py-4">/, 'the invite ask, centred');
  assert.ok(at('data-first-session-made-body=""') < at('data-first-session-people="1"'));
  assert.ok(at('data-first-session-people="1"') < at('<h1 id="first-session-made-title"'));
  assert.ok(at('<h1 id="first-session-made-title"') < at('data-featured-card='));
  assert.ok(at('data-featured-card=') < at('data-first-session-checking=""'));
  assert.match(html, /<h1 id="first-session-made-title" class="text-\[15px\] font-normal leading-5 text-zinc-600 dark:text-zinc-400">Your new community<\/h1>/);
  assert.equal((html.match(/>Plant Pal</g) || []).length, 1, 'the name once, on the thumbnail');
  assert.match(html, /role="dialog" aria-labelledby="first-session-made-title" data-first-session-made=""/);
  // Nothing else: no note under the card, no plan, no old invite heading.
  assert.doesNotMatch(html, /Homeroom is making|Needs you|Go to chat|Invite people to Plant Pal|They can follow along|data-first-session-note|Share again|Start the tour|Go to app/);
  // Invite people later goes on with nothing sent, once the app runs.
  assert.match(CODE, /data-first-session-continue="" onClick=\{\(\) => onContinue\(true, stage\)\} disabled=\{holds\} className=\{SECONDARY\}>\s*\{continueLabel\(entry, false, made\.name\)\}/);
});

// Evan, 10 Oct 2026, iPhone: a ready-made app was still being set up when
// the made screen let him on, so Home showed a grey letter the tour's first
// card asked him to tap. A press of the way on then waited for it, saying
// only "Getting it ready…", and let them on after 45 seconds however far it
// had got (onboarding run, 12 Oct 2026, #4900). Now the way on is off until
// the app runs, and a card under the project says how far it has got.
test('#4900: the way on is off until the app runs, for every first-session project and a ready-made one from Create', () => {
  const { holdsContinue, waitsToRun, READY_POLL_MS, SETUP_USUAL_MS, READY_WAIT_MS } = made;
  assert.equal(waitsToRun('first-session', false), true, 'it opens next (or Home, while it is built), whoever builds it');
  assert.equal(waitsToRun('first-session', true), true);
  assert.equal(waitsToRun('create', true), true, 'a ready-made app from Create, as before');
  assert.equal(waitsToRun('create', false), false, 'Create\'s way on is the hub, which shows a setup as it goes');
  assert.equal(holdsContinue(true, 'creating', false), true, 'being set up: off');
  assert.equal(holdsContinue(true, null, false), true, 'nothing read yet: off');
  assert.equal(holdsContinue(true, 'running', false), false, 'running, and its tile can be tapped: on');
  assert.equal(holdsContinue(true, 'error', false), false, 'a setup that failed: on, its card says so');
  assert.equal(holdsContinue(true, 'awaiting_secrets', false), false, 'one that waits on secrets: on');
  assert.equal(holdsContinue(true, 'creating', true), false, 'the wait is up: on, never a wall');
  assert.equal(holdsContinue(false, 'creating', false), false, 'one that does not wait is never off');
  assert.equal(READY_POLL_MS, 2000);
  assert.equal(SETUP_USUAL_MS, 60000);
  assert.equal(READY_WAIT_MS, 120000);
  // Read every two seconds while it is set up, every ten after.
  assert.match(CODE, /const waits = waitsToRun\(entry, readyMade\);\s+const settingUp = holdsContinue\(waits, appStatus, false\);/);
  // (And while its plan from Make it is written, 13 Oct 2026, and once more
  // at once after Submit: `reread`.)
  // (Run six: and as often as tour step 9 asks while the first look card
  // waits for its picture, tests/first-session-first-look.test.js.)
  assert.match(CODE, /const t = window\.setInterval\(read, settingUp \|\| planComing \? READY_POLL_MS : lookWaits \? FIRST_LOOK_POLL_MS : 10000\);\s+return \(\) => \{ live = false; window\.clearInterval\(t\); \};\s+\}, \[made\.slug, settingUp, planComing, lookWaits, reread\]\);/);
  // The furthest step read, never back to the start on a read without one.
  assert.match(CODE, /setSetupStep\(\(was\) => Math\.max\(was, setupStepOf\(app\.phase\)\)\);/);
  // Slow after a minute, let go after two, counted again after Try again.
  assert.match(CODE, /const s = window\.setTimeout\(\(\) => setSlow\(true\), SETUP_USUAL_MS\);\s+const w = window\.setTimeout\(\(\) => setWaitedOut\(true\), READY_WAIT_MS\);[\s\S]*?\}, \[round\]\);/);
  assert.match(CODE, /if \(res\.ok\) \{\s+setAppStatus\('creating'\);\s+setSetupStep\(0\);\s+setRound\(\(r\) => r \+ 1\);\s+\}/);
  assert.match(CODE, /const holds = holdsContinue\(waits, appStatus, waitedOut\);/);
  // Both ways on are off while it holds; Share invite and Share again never are.
  assert.match(CODE, /data-first-session-continue="" onClick=\{\(\) => onContinue\(false, stage\)\} layout="full"[^>]*className="flex items-center justify-center disabled:opacity-60" disabled=\{holds\}>/);
  assert.match(CODE, /data-first-session-continue="" onClick=\{\(\) => onContinue\(true, stage\)\} disabled=\{holds\}/);
  assert.doesNotMatch(CODE, /setWaiting|onLabel|aria-busy/, 'no press held any more');
  // Once it runs Home is read again, so its tile can be tapped.
  assert.match(CODE, /if \(waits && appStatus === 'running'\) \(window as \{ Home\?: \{ load\?: \(\) => void \} \}\)\.Home\?\.load\?\.\(\);/);

  // Drawn as it opens, nothing read yet: on the first session the way on is
  // off and says where it goes; Share invite is on.
  const first = draw({ made: { ...MADE, conversationId: null } });
  assert.match(first, /<button type="button" data-first-session-continue="" disabled="" class="[^"]*disabled:opacity-60[^"]*">Invite people later<\/button>/);
  assert.doesNotMatch(first, /<button[^>]*disabled=""[^>]*>Share invite<\/button>/);
  assert.match(first, />Share invite<\/button>/);
  // From Create, a project the bot builds goes to its hub at once, with no card.
  assert.doesNotMatch(draw({ entry: 'create' }), /data-made-setup/);
  const create = draw({ entry: 'create', made: { ...MADE, conversationId: null } });
  assert.match(create, /<button type="button" data-first-session-continue="" class="[^"]*">Invite people later<\/button>/);
  assert.doesNotMatch(create, /data-made-setup/);
  // A ready-made app from Create waits, as it did.
  const readyMade = draw({ entry: 'create', made: { ...MADE, conversationId: null, readyMade: true } });
  assert.match(readyMade, /data-first-session-continue="" disabled="" class="[^"]*">Invite people later<\/button>/);
  assert.match(readyMade, /data-made-setup="started"/);
});

test('#4900: a card under the project says how far its setup has got, in words, and how long it usually takes', () => {
  const { SETUP_STEPS, SETUP_WORDS, GETTING_READY, setupStepOf, setupEstimate, SetupProgress, madeAppOf } = made;
  // The server's own steps, in its order (services/app-creation-phase.js).
  assert.deepEqual([...SETUP_STEPS], require('../src/services/app-creation-phase').PHASES);
  assert.match(read('src/routes/apps.js'), /creationPhase: phaseEntry \? phaseEntry\.phase : null,/);
  assert.deepEqual(madeAppOf({ app: { status: 'creating', creationPhase: 'build' } }), { firstVersion: null, status: 'creating', phase: 'build' });
  assert.equal(madeAppOf({ app: { status: 'running' } }).phase, null);
  assert.deepEqual(['database', 'repository', 'build', 'deploy', null, 'nope'].map(setupStepOf), [1, 2, 3, 4, 0, 0]);
  // Each step in words, the way the made screen speaks: never "repository" or "deploy".
  assert.deepEqual(SETUP_STEPS.map((step) => message(SETUP_WORDS[step])),
    ['Setting up its storage…', 'Saving its code…', 'Preparing it to run…', 'Starting it up…']);
  assert.equal(message(GETTING_READY), 'Getting it ready…');
  // How long: the create dialog's "usually under a minute", then calm about a slow one.
  assert.equal(setupEstimate(false, false), 'Usually about a minute.');
  assert.equal(setupEstimate(true, false), 'Should be ready shortly…');
  assert.equal(setupEstimate(true, true), 'Should be ready shortly. You can go on, and open it once it’s ready.');
  for (const words of [...SETUP_STEPS.map((step) => message(SETUP_WORDS[step])), setupEstimate(false, false), setupEstimate(true, true)]) {
    assert.doesNotMatch(words, /!|—|\d/, words);
  }

  // Before any step is read: "Getting it ready…", the ring turning with no number.
  const started = renderToHtml(createElement(SetupProgress, { step: 0, slow: false, waitedOut: false }));
  assert.match(started, /data-made-setup="started"/);
  assert.match(started, /aria-label="Getting it ready…"[^>]*data-progress-ring-spinning=""/);
  assert.doesNotMatch(started, /<text/);
  assert.match(started, /<div role="status" class="min-w-0 flex-1"><p class="truncate text-\[15px\] font-\[650\] leading-5">Getting it ready…<\/p><p class="line-clamp-2 text-\[13px\] leading-\[18px\] text-zinc-500 dark:text-zinc-400">Usually about a minute\.<\/p><\/div>/);
  // On the third step: its words, and 3/4 on the ring, said in words to a screen reader.
  const third = renderToHtml(createElement(SetupProgress, { step: 3, slow: true, waitedOut: false }));
  assert.match(third, /data-made-setup="build"/);
  assert.match(third, /aria-label="Step 3 of 4"/);
  assert.match(third, />3\/4<\/text>/);
  assert.match(third, />Preparing it to run…<\/p>/);
  assert.match(third, />Should be ready shortly…<\/p>/);
  // The plane's card, 20px, one hairline, as the other cards under the project.
  assert.match(third, /class="flex h-\[84px\] items-center gap-3 rounded-\[20px\] bg-white py-3 ps-3 pe-4 shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900"/);

  // On the made screen: under the project, over the line and the buttons.
  // (A project Homeroom bot builds from its description has its setup's
  // progress in the first look card instead, from the invite ask on: run
  // six, tests/first-session-one-thing.test.js.)
  const html = draw({ made: { ...MADE, conversationId: null } });
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('data-featured-card=') < at('data-made-setup="started"'));
  assert.ok(at('data-made-setup="started"') < at('data-first-session-hint=""'));
  assert.match(CODE, /\{settingUp && setupCard \? <SetupProgress step=\{setupStep\} slow=\{slow\} waitedOut=\{waitedOut\} \/> : null\}/);
  // A plain card's own "Setting it up…" gives way to it while it shows, and
  // once it has run, to the same card in its place (READY IN PLACE).
  assert.match(CODE, /const rowHidden = settingUp \|\| ranInPlace \|\| !ownLine;/);
  assert.match(CODE, /\{rowHidden \? null : \(\s+<div data-first-session-build-row="" className="mt-4 flex h-5 max-w-full items-center gap-2 text-\[14px\] leading-5 text-zinc-600 dark:text-zinc-300">/);
});

test('READY IN PLACE: once the app runs its setup card stays where it was, so nothing over or under it moves (onboarding run two)', () => {
  const { SetupProgress, SETUP_DONE, SETUP_SET_UP } = made;
  assert.equal(message(SETUP_DONE), 'It’s running now.');
  assert.equal(message(SETUP_SET_UP), 'It’s set up.');
  const done = renderToHtml(createElement(SetupProgress, { step: 4, slow: false, waitedOut: false, done: { line: 'Ready to use.', busy: false } }));
  assert.match(done, /data-made-setup="done"/);
  // The same card, row and sizes as while it ran: 15 over 13, two lines.
  assert.match(done, /class="flex h-\[84px\] items-center gap-3 rounded-\[20px\] bg-white py-3 ps-3 pe-4 shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900"/);
  assert.match(done, /<div role="status" class="min-w-0 flex-1"><p class="truncate text-\[15px\] font-\[650\] leading-5">Ready to use\.<\/p><p class="line-clamp-2 text-\[13px\] leading-\[18px\] text-zinc-500 dark:text-zinc-400">It’s running now\.<\/p><\/div>/);
  // Full and quiet while nothing says it is made, and turns only while the bot builds.
  assert.match(done, />4\/4<\/text>/);
  assert.match(done, /stroke-zinc-400/);
  assert.doesNotMatch(done, /data-progress-ring-spinning/);
  const building = renderToHtml(createElement(SetupProgress, { step: 4, slow: false, waitedOut: false, done: { line: 'It’s set up.', busy: true, finished: false } }));
  assert.match(building, /data-progress-ring-spinning=""/);
  assert.match(building, /stroke-zinc-400/);
  assert.doesNotMatch(building, /--state-ok/);
  // Newcomer run, 20 Oct 2026: "the ring when it's done making should be
  // green". Made, the full ring is --state-ok, as a finished progress bar is.
  const made_ = renderToHtml(createElement(SetupProgress, { step: 4, slow: false, waitedOut: false, done: { line: 'Ready to use.', busy: false, finished: true } }));
  assert.match(made_, /stroke-\[color:var\(--state-ok\)\]/);
  assert.doesNotMatch(made_, /stroke-zinc-400|data-progress-ring-spinning/);
  // Made: it runs, and nothing more is coming for it.
  assert.match(CODE, /const finished = !busy && !stalled && appStatus === 'running' && \(!botBuilds \|\| \(!!line && buildLineDone\(line\)\)\);/);
  // Only once it has shown here, and never over a setup that stopped.
  assert.match(CODE, /useEffect\(\(\) => \{ if \(settingUp\) setSetupShown\(true\); \}, \[settingUp\]\);/);
  assert.match(CODE, /const ranInPlace = setupShown && !settingUp && !stalled;/);
  assert.match(CODE, /\{ranInPlace && setupCard \? <SetupProgress step=\{setupStep\} slow=\{slow\} waitedOut=\{waitedOut\} done=\{\{ line: card \? t\(SETUP_SET_UP\) : plainLine, busy, finished \}\} \/> : null\}/);
});

test('C4: the sheet is titled with the community, a small caps label over the invite as they will see it', () => {
  const html = renderToHtml(createElement(made.InviteSheet, { made: MADE, me: 'maya', onClose() {}, onSent() {} }));
  assert.match(html, /<h2 id="first-session-invite-title" class="[^"]*">Invite people to Plant Pal<\/h2>/);
  assert.match(html, /<p data-first-session-invite-label="" class="[^"]*uppercase[^"]*">What they&#x27;ll see<\/p>/);
  assert.ok(html.indexOf('>Invite people to Plant Pal<') < html.indexOf('What they&#x27;ll see'));
  assert.ok(html.indexOf('What they&#x27;ll see') < html.indexOf('data-first-session-invite-line'));
  assert.ok(html.indexOf('data-first-session-invite-line') < html.indexOf('<textarea'));
  // Share and Copy link are main's (#4180): on a computer without a share
  // sheet, Copy link alone.
  assert.match(html, /data-first-session-invite-action="copy"[^>]*>Copy link<\/button>/);
});

test('C5: after sharing, the line says so, and the buttons keep their places: Share again, then Go to app', () => {
  // Share again is grey where Share invite was; Go to app is blue where
  // Invite people later was.
  const shared = CODE.slice(CODE.indexOf('{sent ? ('), CODE.indexOf('{inviting && typeof document'));
  assert.ok(shared.indexOf('data-first-session-share-again=""') < shared.indexOf('data-first-session-continue=""'));
  assert.match(CODE, /<button type="button" data-first-session-share-again="" onClick=\{\(\) => setInviting\(true\)\} className=\{SECONDARY\}>\s*\{t\('onboarding:firstSession\.made\.shareAgain'\)\}/);
  assert.equal(message('onboarding:firstSession.made.shareAgain'), 'Share again');
  assert.match(CODE, /<Button type="button" data-first-session-continue="" onClick=\{\(\) => onContinue\(false, stage\)\} layout="full" variant="pillAccent"/);
  assert.match(CODE, /\{sentHow \? sharedLine\(sentHow\) : t\(INVITE_HINT\)\}/);
  assert.match(CODE, /\{continueLabel\(entry, true, made\.name, stage !== null\)\}/);
  assert.match(CODE, /onSent=\{\(how\) => setSentHow\(how\)\}/);
  // The logo bar stays behind the sheet and after sharing; Share invite is gone.
  assert.doesNotMatch(draw(), /Go to the Homeroom app|Invite sent|joined\./);
});

test('the people row: your face in the middle, waiting seats on both sides, faces take the seats as people join', () => {
  const row = (list) => renderToHtml(createElement(people.PeopleRow, { people: list }));
  const src0 = read(`${DIR}/people-row.tsx`);
  const one = row([{ username: 'maya' }]);
  assert.match(one, /role="img" aria-label="You" data-first-session-people="1"/);
  assert.equal((one.match(/data-first-session-seat=""/g) || []).length, 4, 'two seats on each side');
  assert.match(one, />M<\/span>/);
  // Your face is the middle of five places, with a seat either side of it.
  const at = (needle) => one.indexOf(needle);
  const seats = [...one.matchAll(/data-first-session-seat=""/g)].map((m) => m.index);
  assert.ok(seats[0] < seats[1] && seats[1] < at('>M</span>') && at('>M</span>') < seats[2] && seats[2] < seats[3]);
  // Not interactive, a soft person silhouette, lightened colours rather than opacity.
  assert.doesNotMatch(one, /<button|<a |tabindex|opacity/);
  assert.equal((one.match(/pointer-events-none/g) || []).length, 4);
  assert.equal((one.match(/<svg[^>]*><path d="M12 4\.4a4\.6 4\.6/g) || []).length, 4, 'a silhouette in every seat');
  assert.match(src0, /import \{ PersonSilhouetteIcon \} from '@\/components\/ui\/icons';/);
  for (const bg of ['#ebefed', '#ede5f2', '#fae5dc', '#f5e9e5']) assert.match(one, new RegExp(`background:${bg}`), bg);
  assert.match(one, /margin-inline-start|-ms-2\.5/, 'the places overlap');
  const three = row([{ username: 'maya' }, { username: 'sam' }, { username: 'alex' }]);
  assert.equal((three.match(/data-first-session-seat=""/g) || []).length, 2, 'two seats left once three are in');
  assert.match(three, /aria-label="You and 2 others"/);
  assert.deepEqual(people.placesOf([{ username: 'maya' }, { username: 'sam' }, { username: 'alex' }]).map((p) => p && p.username),
    [null, 'alex', 'maya', 'sam', null]);
  const many = row(Array.from({ length: 7 }, (_, i) => ({ username: `p${i}` })));
  assert.match(many, /data-first-session-people="5"/, 'at most five faces');
  assert.doesNotMatch(many, /data-first-session-seat=""/);
  assert.equal(people.peopleLabel([{ username: 'maya' }, { username: 'sam' }]), 'You and sam');
  assert.equal(people.peopleLabel([{ username: 'maya' }, {}]), 'You and 1 other');
  assert.equal(people.PLACES, 5);
  // The hub's faces: the initial on the person's swatch.
  const src = read(`${DIR}/people-row.tsx`);
  assert.match(src, /import \{ swatchFor \} from '\.\.\/\.\.\/lib\/community-color';/);
  assert.match(src, /background: swatchFor\(name\)/);
  // The made screen draws the community's members, else you.
  assert.match(CODE, /<PeopleRow people=\{peopleOf\(community, me\)\} \/>/);
});

test('from Create there is no tour: its line and its way on say so', () => {
  const html = draw({ entry: 'create', underHeader: true });
  assert.doesNotMatch(html, /data-first-session-made-top/, 'under the platform header there is no logo bar');
  assert.equal(made.continueLabel('create', true, 'Plant Pal'), 'Go to Plant Pal');
  assert.match(CODE, /\{plan && !stalled && fromCreate && !asked \? <PlanWaitsCard/);
});
