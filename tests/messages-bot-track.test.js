'use strict';

// One track per request (16 Oct 2026), drawn the same everywhere
// (frontend/src/features/messages/bot-track.tsx): a request's stored work
// state (5 Nov 2026: lib/work-state.ts, ten stages, the same words on every
// screen) with what its card draws around it. These pin the words a track
// says, the five-step bar and its loop ("Build, try 2"), the card a
// request's thread and its page draw, the groups the tracks fall into (Needs
// you is only what waits on the person; a limit's hold is In progress, never
// finished), and the bot's slots page under a project's Workshop
// (frontend/src/features/dev-board/workshop/bot-slots.tsx).
//
// The server decides the work state (services/work-state.js) and the track
// around it (services/homeroom-bot-track.js, pinned in
// tests/homeroom-bot-track.test.js); these pin how it is said and drawn.
//
// Run with: node --test tests/messages-bot-track.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TRACK = 'frontend/src/features/messages/bot-track.tsx';
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';
const API = 'frontend/src/features/messages/api.ts';
const SLOTS = 'frontend/src/features/dev-board/workshop/bot-slots.tsx';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

const NOW = new Date('2026-10-16T12:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const links = (extra = {}) => ({ request: '#app/plant-pal/dev/i/12', proposal: null, project: '#app/plant-pal', ...extra });
// A work state as the server stores it (services/work-state.js).
const at = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra });
const track = (extra = {}) => ({
  key: `plant-pal#${extra.issueNumber || 12}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
  issueNumber: 12, title: 'Dark mode', firstVersion: false, work: at('building'), step: 'build', waitingOn: null,
  busy: false, try: 1, tryStartedAt: null, tryStarts: [], since: ago(30), rootId: null, askId: null, proposalId: null,
  sessionId: null, links: links(), ...extra,
});
const t = (id, values) => message(`messages:${id}`, values);
const core = (id, values) => message(`core:${id}`, values);

// ── 1. The words ──────────────────────────────────────────────────────────

test('each stage has its word, and its second line a sentence; a loop says which try', () => {
  const { trackStateWord, trackLine, trackEyebrow, trackPlace, trackDetail } = loadTsx(TRACK);
  const fixing = track({ work: at('building', { line: { code: 'fixing' } }), try: 2 });
  assert.equal(trackStateWord(fixing), 'Building');
  assert.equal(trackLine(fixing), core('work.line.fixing'));
  assert.equal(trackLine(fixing), 'Fixing what its tests found');
  assert.equal(trackEyebrow(fixing), `Building · ${t('bot.track.try', { number: '2' })}`, 'the try, once it has looped');
  assert.equal(trackEyebrow(track({ work: at('live'), step: 'live', try: 2 })), core('work.stage.live'), 'an ended track says only how it ended');
  // A stage with no second line says its word, and says it once beside the word.
  const vote = track({ work: at('up_for_vote'), step: 'vote' });
  assert.equal(trackLine(vote), 'Up for a vote');
  assert.equal(trackDetail(vote), '', 'nothing more to say than the stage word');
  assert.equal(trackDetail(fixing), 'Fixing what its tests found');
  assert.equal(trackLine(track({ work: at('waiting_for_you', { why: 'question', line: { code: 'no_such_line' } }), step: 'plan' })),
    'Waiting for your answer', 'an unknown second line falls back to the stage\'s own words');
  // Papote #3: on a page anyone can open, a wait on its requester names them.
  const plan = track({ work: at('waiting_for_you', { why: 'plan' }), step: 'plan', waitingOn: 'you' });
  assert.equal(trackStateWord(plan), 'Waiting for you to OK the plan');
  assert.equal(trackStateWord({ ...plan, waitingFor: 'snait' }), 'Waiting on @snait');
  assert.equal(trackLine({ ...plan, waitingFor: 'snait' }), 'Its plan is ready for @snait to say Build it');
  assert.equal(trackEyebrow({ ...plan, waitingFor: 'snait' }), 'Waiting on @snait');
  const question = { ...plan, work: at('waiting_for_you', { why: 'question' }), waitingFor: 'snait' };
  assert.equal(trackLine(question), 'It has a question for @snait');
  const detail = { ...plan, work: at('waiting_for_you', { why: 'needs_detail' }), waitingFor: 'snait' };
  assert.equal(trackLine(detail), 'It can\'t build this as written: it needs more detail from @snait');
  assert.equal(trackLine({ ...plan, work: at('waiting_for_you', { why: 'decide' }), waitingFor: 'snait' }), 'Waiting on @snait',
    'a wait with no named line of its own says who it waits on');

  // Held: ready to build, waiting for a slot or for its turn among the project's builds.
  const held = track({ work: at('building', { line: { code: 'held_waiting' } }), step: 'build', held: { limit: 'slots', position: 3, until: null } });
  assert.equal(trackStateWord(held), 'Ready to build', 'the same word a held row says under In progress');
  assert.equal(trackLine(held), core('work.line.heldWaiting'));
  assert.equal(trackPlace(held), t('bot.track.held.ahead_other', { count: 2 }));
  assert.equal(trackPlace({ ...held, held: { ...held.held, position: 1 } }), t('bot.track.held.next'));
  // #6156: held for the bot's turn among the project's builds: its own line, never a vote.
  const turn = track({ work: at('building', { line: { code: 'held_builds' } }), step: 'build', held: { limit: 'builds', position: 3, until: null } });
  assert.equal(trackLine(turn), core('work.line.heldBuilds'));
  assert.notEqual(trackLine(turn), trackLine(held));
  assert.equal(trackLine(held), 'Waiting for changes up for a vote to be decided');
  assert.equal(trackLine(turn), 'Waiting for one of the project\'s builds to finish');
  // On hold for the week's building time: until when.
  const week = track({ work: at('reading', { line: { code: 'on_hold' } }), step: null, held: { limit: 'allowance', position: null, until: '2026-10-19T09:00:00Z' } });
  assert.match(trackLine(week), /^On hold until .+: this week's building time is used up$/);
  assert.equal(trackLine({ ...week, held: { ...week.held, until: null } }), core('work.line.onHold'), 'no date: the stage\'s own line');
  assert.equal(trackPlace(week), null, 'no place in a line it is not in');
  // #6357: paused a day after repeated errors: no building time in it,
  // and when it is tried again.
  const cool = track({ work: at('reading', { line: { code: 'cooldown' } }), step: null, retryAt: '2026-10-13T09:41:00Z' });
  assert.match(trackLine(cool), /^Paused after repeated errors: trying again .+$/);
  assert.doesNotMatch(trackLine(cool), /building time/);
  assert.equal(trackLine({ ...cool, retryAt: undefined }), core('work.line.cooldown'), 'no date: the stage\'s own line');
  assert.equal(trackStateWord(cool), 'Not started yet');
  assert.equal(loadTsx(TRACK).trackLook(cool).tone, 'held');
  // In Homeroom bot's line: its place is its line's own words.
  const queued = track({ work: at('reading', { line: { code: 'queued', place: 3 } }), step: null, queue: { ahead: 2 } });
  assert.equal(trackStateWord(queued), 'Not started yet');
  assert.equal(trackLine(queued), 'Number 3 in line');
  assert.equal(trackPlace(queued), null, 'said once, by its line');
  // 16 Oct 2026: one a person has taken since is theirs, not a wait.
  const taken = track({ work: at('building', { line: { code: 'claimed', by: 'maya' } }), step: 'build' });
  assert.equal(trackLine(taken), core('work.line.claimed', { username: 'maya' }));
  assert.equal(trackLine(taken), 'maya is building it');
  assert.equal(trackPlace(taken), null);

  // A stopped build says why it did not finish; one with no known cause, the stage's reason.
  const stopped = track({ work: at('stopped', { reason: 'build_failed' }), step: null, cause: 'time' });
  assert.equal(trackStateWord(stopped), core('work.reason.buildFailed'));
  assert.equal(trackLine(stopped), t('bot.track.line.stopped.time'));
  assert.equal(trackLine({ ...stopped, cause: 'nonsense' }), 'Stopped: the build didn\'t finish');
  assert.equal(trackLine({ ...stopped, cause: undefined }), 'Stopped: the build didn\'t finish');

  const elsewhere = track({ work: at('closed'), step: null, doneBy: { username: 'ben', prNumber: 4822 } });
  assert.equal(trackStateWord(elsewhere), 'Closed');
  assert.equal(trackLine(elsewhere), t('bot.track.line.done_elsewhere.by', { username: 'ben', number: '4822' }), 'who shipped it, and where');
  assert.equal(trackLine({ ...elsewhere, doneBy: { username: 'ben', prNumber: null } }), t('bot.track.line.done_elsewhere.byNoPr', { username: 'ben' }));
  // How a track ended is bot-strip.tsx's now (trackEnding), pinned in
  // tests/messages-bot-strip.test.js.
});

test('every word the module asks for is in the catalog', () => {
  const src = read(TRACK);
  const ids = [...src.matchAll(/'(messages:bot\.track\.[a-zA-Z_.]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 40, 'the steps, the lines a stage has no word for, the holds and the links');
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  for (const id of new Set(ids)) {
    const key = id.slice('messages:'.length);
    assert.ok(catalog[key] || catalog[`${key}_one`], `${id} is in the catalog`);
  }
  // The stage words and second lines are lib/work-state.ts's, in core.
  const words = read('frontend/src/lib/work-state.ts');
  const coreIds = [...words.matchAll(/'(core:work\.[a-zA-Z_.]+)'/g)].map((m) => m[1]);
  assert.ok(coreIds.length > 40, 'the ten stages, the whys, the reasons and the lines');
  const coreCatalog = JSON.parse(read('frontend/locales/en/core.json'));
  for (const id of new Set(coreIds)) {
    const key = id.slice('core:'.length);
    assert.ok(coreCatalog[key] || coreCatalog[`${key}_one`], `${id} is in the catalog`);
  }
  // 5 Nov 2026: the track's own state words and per-state lines went with
  // its old states; none is left in the catalog.
  assert.deepEqual(Object.keys(catalog).filter((key) => /^bot\.track\.state\./.test(key)), ['bot.track.state.waitingNamed']);
  assert.doesNotMatch(src, /bot\.track\.state\.(?!waitingNamed)/);
});

// #6402: a checking change says about how long is left, or that it waits to
// sync with main; a run with no estimate says nothing on the second line.
test('a checking change words its wait, and its minutes survive normalization', () => {
  const { lineWords, normalizeWorkState } = loadTsx('frontend/src/lib/work-state.ts');
  const checking = (line) => normalizeWorkState({ stage: 'checking', line });
  assert.deepEqual(lineWords(checking({ code: 'checks_running', minutes: 2 })),
    { id: 'core:work.line.checksRunning', values: { count: 2 } });
  assert.equal(lineWords(checking({ code: 'checks_running' })), null, 'no estimate, no line');
  assert.deepEqual(lineWords(checking({ code: 'sync_wait' })), { id: 'core:work.line.syncWait' });
  assert.deepEqual(checking({ code: 'checks_running', minutes: 3 }).line, { code: 'checks_running', minutes: 3 });
});

// ── 2. The bar and the card ───────────────────────────────────────────────

test('the bar lights the step it is on; a loop back to building names its try under Build', () => {
  const { stepLooks, TrackBar, TrackBadge } = loadTsx(TRACK);
  assert.deepEqual(stepLooks({ work: at('building'), step: 'build' }), ['done', 'now', 'next', 'next', 'next']);
  assert.deepEqual(stepLooks({ work: at('up_for_vote'), step: 'vote' }), ['done', 'done', 'done', 'now', 'next']);
  assert.deepEqual(stepLooks({ work: at('live'), step: 'live' }), ['live', 'live', 'live', 'live', 'live'], 'live: every step green');
  assert.deepEqual(stepLooks({ work: at('closed'), step: null, doneBy: { username: 'ben', prNumber: null } }), ['live', 'live', 'live', 'live', 'live'], 'shipped another way: green too');
  assert.deepEqual(stepLooks({ work: at('closed'), step: null }), ['next', 'next', 'next', 'next', 'next'], 'just closed: nothing lit');
  assert.deepEqual(stepLooks({ work: at('reading', { line: { code: 'queued' } }), step: null }), ['next', 'next', 'next', 'next', 'next'], 'nothing lit before it starts');

  const html = renderToHtml(createElement(TrackBar, { track: track({ try: 2, work: at('building', { line: { code: 'fixing' } }) }), labels: true }));
  assert.match(html, /role="img" aria-label="Building: step 2 of 5, Build"/, 'said in words for a screen reader');
  assert.match(html, new RegExp(`>${t('bot.track.step.buildTry', { number: '2' })}</span>`), 'Build, try 2');
  assert.equal((html.match(/data-bot-track-step=/g) || []).length, 5);
  assert.match(html, /data-bot-track-step="build" data-state="now"/);
  assert.match(html, /data-bot-track-bar="building"/, 'the bar names its stage');

  const { trackLook } = loadTsx(TRACK);
  assert.equal(trackLook({ work: at('checking', { line: { code: 'checks_failing', failing: 2 } }) }).tone, 'trouble', 'failing tests are a warning, never a spinner');
  assert.equal(trackLook({ work: at('checking') }).tone, 'working');
  assert.equal(trackLook({ work: at('building', { line: { code: 'held_builds' } }) }).tone, 'held', 'a hold is a dimmer wait');
  assert.equal(trackLook({ work: at('building', { line: { code: 'claimed', by: 'maya' } }) }).tone, 'ended', 'a person has it');
  assert.equal(trackLook({ work: at('stopped', { reason: 'change_closed' }) }).tone, 'ended', 'a closed change is a quiet stop');
  assert.equal(trackLook({ work: at('stopped', { reason: 'build_failed' }) }).tone, 'trouble');
  assert.deepEqual([
    trackLook({ work: at('building'), busy: true }).spin,
    trackLook({ work: at('building') }).spin,
    trackLook({ work: at('planning') }).spin,
    trackLook({ work: at('planning'), busy: true }).spin,
  ], [true, false, false, true], 'turning only while the bot is at it, never while a build waits its turn');
  const badge = renderToHtml(createElement(TrackBadge, { track: track({ work: at('waiting_for_you', { why: 'question' }), step: 'plan' }) }));
  assert.match(badge, /data-bot-track-badge="waiting_for_you"/);
  assert.match(badge, /bg-amber-100/, 'what waits on the person wears the need colour');
  assert.match(badge, /<span class="sr-only">Waiting for your answer<\/span>/, 'the stage\'s words, said once');
  const reviewing = renderToHtml(createElement(TrackBadge, { track: track({ work: at('building', { line: { code: 'reviewing', round: 1, of: 2 } }) }) }));
  assert.match(reviewing, /title="Building: Reviewing, round 1 of 2"/, 'and its second line where it has one');
});

test('the card: its status word and try, the title, where it is and why, the bar and its links', () => {
  const { TrackCard, trackLinks } = loadTsx(TRACK);
  const fixing = track({
    try: 2, work: at('building', { line: { code: 'fixing' } }), tryStartedAt: ago(15), links: links({ proposal: '#app/plant-pal/dev/s/88' }),
  });
  const html = renderToHtml(createElement(TrackCard, { track: fixing, title: 'Dark mode', links: trackLinks(fixing), now: NOW }));
  assert.match(html, /role="group" aria-label="Where Dark mode is" data-bot-track="building" data-bot-track-why="fixing" data-bot-activity="working" data-bot-activity-request="plant-pal#12"/);
  assert.match(html, new RegExp(`data-bot-activity-eyebrow="">Building · ${t('bot.track.try', { number: '2' })}</div>`));
  assert.match(html, new RegExp(`data-bot-activity-status="" role="status">${core('work.line.fixing')} · ${t('bot.track.soFar', { duration: '15m' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`), 'and this try\'s clock');
  assert.match(html, /href="#app\/plant-pal\/dev\/s\/88"/, 'its change');
  assert.match(html, /href="#app\/plant-pal\/dev\/i\/12"/, 'its request');
  // The card's why is its stage's: a wait's why, a stop's reason, else its second line's code.
  const waits = renderToHtml(createElement(TrackCard, { track: track({ work: at('waiting_for_you', { why: 'plan' }), step: 'plan' }), title: 'Dark mode', now: NOW }));
  assert.match(waits, /data-bot-track="waiting_for_you" data-bot-track-why="plan"/);
  const stops = renderToHtml(createElement(TrackCard, { track: track({ work: at('stopped', { reason: 'build_failed' }), step: null }), title: 'Dark mode', now: NOW }));
  assert.match(stops, /data-bot-track="stopped" data-bot-track-why="build_failed" data-bot-activity="done"/, 'a stop has ended');
  // A stage with no second line says its word in the eyebrow alone.
  const vote = renderToHtml(createElement(TrackCard, { track: track({ work: at('up_for_vote'), step: 'vote' }), title: 'Dark mode', now: NOW }));
  assert.match(vote, /data-bot-activity-eyebrow="">Up for a vote<\/div>/);
  assert.match(vote, /data-bot-activity-status="" role="status"><\/p>/, 'never "Up for a vote" twice');

  const held = track({ work: at('building', { line: { code: 'held_waiting' } }), held: { limit: 'slots', position: 2, until: null } });
  const heldHtml = renderToHtml(createElement(TrackCard, { track: held, title: 'Dark mode', links: trackLinks(held, { request: false }), now: NOW }));
  assert.match(heldHtml, /data-bot-track-slots="plant-pal"/, 'held for a slot: a way to the bot\'s slots');
  assert.match(heldHtml, new RegExp(`>${t('bot.track.link.slots').replace(/'/g, '&#x27;')}</a>`));
  assert.doesNotMatch(heldHtml, /href="#app\/plant-pal\/dev\/i\/12"/, 'on the request\'s own page, no link to itself');
  assert.match(heldHtml, new RegExp(t('bot.track.held.ahead_one', { count: 1 })));
  // #6156: one held for the bot's turn has the same way to the slots.
  const turn = track({ work: at('building', { line: { code: 'held_builds' } }), held: { limit: 'builds', position: 1, until: null } });
  assert.match(renderToHtml(createElement(TrackCard, { track: turn, title: 'Dark mode', links: trackLinks(turn, { request: false }), now: NOW })),
    /data-bot-track-slots="plant-pal"/);
});

test('a thread\'s card is the track once the viewer\'s tracks have one for the request, and a try starts a divider', () => {
  const src = read(TRACK);
  assert.match(src, /if \(!meta \|\| !track \|\| \(track\.rootId && track\.rootId !== message\.id\)\) return <BotActivityCard message=\{message\} words=\{words\} \/>;/, 'else the activity card as it was');
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /<BotCardOrTrack /);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /useTrackOf\(/, 'the thread reads the request\'s track for its try dividers');
  assert.match(screen, /bot\.track\.tryDivider/);
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(head, /<div className="dev-request-track" data-request-track=\{r\.trackPending \? 'pending' : track\.work\.stage\} inert=\{!!r\.trackPending\}>\s*<TrackCard track=\{track\} title=\{r\.title\} links=\{trackLinks\(track, \{ request: false \}\)\} pictures \/>/, 'the request\'s page draws the same card');
  // Polish board #12: one row of steps on the page, the track card's, and
  // the card unseen while the page is drawn from the board's older row.
  assert.match(head, /<RequestStatus s=\{r\.status\} specs=\{specs\} tracked=\{!!track\} \/>/);
  assert.match(head, /\{s\.closed \|\| tracked \? null : \(\s*<ol className="dev-request-steps">/);
  assert.match(read('public/css/app.css'), /\.dev-request-track\[data-request-track="pending"\] \{ visibility: hidden; \}/);
});

// ── 3. The groups, from the tracks ───────────────────────────────────────

test('the tracks fall into groups: what waits on you, a vote, work under way, and what ended today', () => {
  const { stripGroups, summaryParts } = loadTsx(STRIP);
  const tracks = [
    track({ issueNumber: 1, work: at('waiting_for_you', { why: 'question' }), step: 'plan', askId: 40 }),
    track({ issueNumber: 2, work: at('up_for_vote'), step: 'vote' }),
    track({ issueNumber: 3, work: at('building', { line: { code: 'fixing' } }), step: 'build', try: 2 }),
    track({ issueNumber: 4, work: at('building', { line: { code: 'held_waiting' } }), step: 'build', held: { limit: 'slots', position: 1, until: null } }),
    track({ issueNumber: 5, work: at('live'), step: 'live', since: ago(60) }),
    track({ issueNumber: 6, work: at('live'), step: 'live', since: ago(60 * 30) }),
    track({ issueNumber: 7, work: at('closed'), step: null, since: ago(90), doneBy: { username: 'ben', prNumber: 4822 } }),
    track({ issueNumber: 3, work: at('building'), step: 'build' }),
  ].map((tr) => ({ ...tr, key: `plant-pal#${tr.issueNumber}` }));
  const model = stripGroups({ tracks }, NOW);
  const numbers = (rows) => rows.map((row) => row.track.issueNumber);
  assert.deepEqual(numbers(model.needs), [1], 'only what waits on the person');
  assert.equal(model.needs[0].state, 'Waiting for your answer');
  // The drawer's one action per row and the message it opened at went with
  // the drawer (5 Nov 2026); the track still carries the ask it waits on.
  assert.equal(model.needs[0].track.askId, 40);
  assert.deepEqual(numbers(model.ready), [2], 'a change up for a vote is ready to try');
  // #5392: a hold and a change going live are In progress; none of it has ended.
  assert.deepEqual(numbers(model.progress), [3, 4], 'each request once, the hold among the work');
  assert.equal(model.progress[0].state, 'Fixing what its tests found');
  assert.equal(model.progress[1].state, `${core('work.stage.readyToBuild')} · ${t('bot.track.held.next')}`, 'a hold says it is ready to build, under In progress');
  const { trackShort } = loadTsx(TRACK);
  const second = track({ work: at('building', { line: { code: 'held_waiting' } }), held: { limit: 'slots', position: 3, until: null } });
  assert.equal(trackShort(second), t('bot.track.held.aheadSlot_other', { count: 2 }), 'one short line that still says what it waits for');
  // #6156: held for the bot's turn, its place in that line.
  const turn = track({ work: at('building', { line: { code: 'held_builds' } }), held: { limit: 'builds', position: 3, until: null } });
  assert.equal(trackShort(turn), t('bot.track.held.aheadBuild_other', { count: 2 }));
  assert.equal(trackShort({ ...turn, held: { ...turn.held, position: 1 } }), t('bot.track.held.nextBuild'));
  assert.equal(t('bot.track.held.nextBuild'), 'Next in line to be built');
  assert.equal(trackShort(track({ work: at('up_for_vote'), step: 'vote' })), core('work.stage.upForVote'));
  assert.equal(trackShort({ ...second, held: { ...second.held, position: null } }), core('work.line.heldWaiting'), 'no place known: what it waits for');
  assert.deepEqual(numbers(model.done), [5, 7], 'ended today, done another way among them');
  assert.deepEqual(summaryParts(model).map((part) => part.text),
    ['1 needs you', '1 ready to try', '2 in progress', '2 finished today']);
});

test('there is no On hold group, and no drawer; the slots page still opens from the card', () => {
  const src = read(STRIP);
  assert.doesNotMatch(src, /data-bot-strip-group=/, '#5392: a hold is In progress; 5 Nov 2026: the drawer is gone');
  // #5373: the drawer's own slots links are gone; the slots page opens from
  // a held request's card in the story, which still calls openSlots here.
  const track = read(TRACK);
  assert.match(track, /openSlots\(/, 'the slots page opens as a place under the Workshop');
  assert.doesNotMatch(src, /openSlots\(|bot\.strip\.slots/, 'the strip module carries no slots links of its own');
  assert.match(src, /done_elsewhere: \{ key: 'messages:bot\.final\.doneElsewhere', tone: 'good', icon: CheckIcon \}/);
  assert.equal(message('messages:bot.strip.summary.done', { count: 2 }), '2 finished today');
});

// ── 4. The tracks as the server sends them ───────────────────────────────

test('a track is read field by field; one whose work state the client does not know is drawn nowhere', () => {
  const { normalizeBotTrack, normalizeBotSlots } = loadTsx(API);
  const row = {
    key: 'plant-pal#12', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 12, title: 'Dark mode',
    work: { stage: 'building', line: { code: 'held_waiting' }, since: ago(40) }, step: 'nonsense', try: 3,
    held: { limit: 'slots', position: 2 }, links: { request: '#app/plant-pal/dev/i/12' }, rootId: 55, tryStarts: [ago(90), ago(30)],
  };
  const got = normalizeBotTrack(row);
  assert.deepEqual(got.work, { stage: 'building', why: null, reason: null, line: { code: 'held_waiting' }, whoseMove: null, since: ago(40) });
  assert.equal('state' in got, false, 'no state of its own beside its work state');
  assert.equal('why' in got, false);
  assert.equal(got.step, null, 'an unknown step lights nothing');
  assert.equal(got.try, 3);
  assert.deepEqual(got.held, { limit: 'slots', position: 2, until: null });
  assert.equal(got.rootId, 55);
  assert.equal(got.tryStarts.length, 2);
  assert.equal(normalizeBotTrack({ ...row, work: { stage: 'exploded' } }), null, 'a stage this client does not know');
  assert.equal(normalizeBotTrack({ ...row, work: undefined }), null, 'no work state at all');
  assert.equal(normalizeBotTrack({ ...row, work: { ...row.work, why: 'Not A Code!', line: { code: 'Not A Code!' } } }).work.why, null);
  assert.equal(normalizeBotTrack({ ...row, work: { ...row.work, line: { code: 'Not A Code!' } } }).work.line, null);
  // A stopped build's cause is a code, or nothing.
  const stopped = { ...row, work: { stage: 'stopped', reason: 'build_failed' }, held: undefined };
  assert.equal(normalizeBotTrack({ ...stopped, cause: 'time' }).cause, 'time');
  assert.equal('cause' in normalizeBotTrack({ ...stopped, cause: 'Not A Code!' }), false);
  // Who shipped it, only on a closed one; its place in the bot's line, where sent.
  const doneBy = { username: 'ben', prNumber: 4822 };
  assert.deepEqual(normalizeBotTrack({ ...stopped, work: { stage: 'closed' }, doneBy }).doneBy, doneBy);
  assert.equal(normalizeBotTrack({ ...stopped, doneBy }).doneBy, undefined, 'never on one still open');
  assert.deepEqual(normalizeBotTrack({ ...stopped, queue: { ahead: 3 } }).queue, { ahead: 3 });

  const view = normalizeBotSlots({
    slots: {
      app: { slug: 'plant-pal', name: 'Plant Pal' }, botOn: true, acts: true, buildCap: 5, waitCap: 30, buildsAtOnce: 2, reading: 1,
      slots: [{ kind: 'proposal', issueNumber: 8, title: 'Sort by name', track: { ...row, issueNumber: 8, work: { stage: 'up_for_vote' }, step: 'vote', held: undefined } }],
      waiting: [{ issueNumber: 12, title: 'Dark mode', askedBy: 'lee', excerpt: 'Make it darker at night.', position: 1, track: row }],
      taken: [{ issueNumber: 13, title: 'Frost alerts', by: 'maya', track: { ...row, issueNumber: 13, work: { stage: 'building', line: { code: 'claimed', by: 'maya' } }, held: undefined } }],
      onHold: [], week: { limited: true, usedShare: 1.4, resetsAt: '2026-10-19T00:00:00Z' },
    },
  });
  assert.equal(view.app.slug, 'plant-pal');
  // #6156: the caps are the server's, never one the client makes up.
  assert.deepEqual([view.buildCap, view.waitCap], [5, 30]);
  assert.deepEqual([normalizeBotSlots({ slots: { app: { slug: 'x' }, cap: 5 } }).buildCap, normalizeBotSlots({ slots: { app: { slug: 'x' } } }).waitCap], [null, null]);
  assert.equal(view.slots[0].track.work.stage, 'up_for_vote');
  assert.equal(view.waiting[0].position, 1);
  assert.deepEqual([view.waiting[0].askedBy, view.waiting[0].excerpt], ['lee', 'Make it darker at night.']);
  assert.deepEqual([view.taken[0].by, view.taken[0].track.work.line], ['maya', { code: 'claimed', by: 'maya' }]);
  assert.equal(view.taken[0].track.held, undefined, 'a person has it: no hold of the bot\'s');
  assert.deepEqual(normalizeBotSlots({ slots: { app: { slug: 'x' } } }).taken, [], 'an older server: nobody has taken anything');
  // 16 Oct 2026: and every other open request, by where the bot is on it.
  const rest = normalizeBotSlots({
    slots: {
      app: { slug: 'plant-pal' },
      upNext: [{ issueNumber: 30, kind: 'older', position: 1, trial: 'ready' }, { issueNumber: 31, kind: 'nonsense', trial: 'Not A Code' }],
      waitingOn: [{ issueNumber: 20, track: { ...row, issueNumber: 20, work: { stage: 'waiting_for_you', why: 'plan' }, step: 'plan', held: undefined } }],
      withPeople: 12.7,
    },
  });
  assert.deepEqual(rest.upNext.map((e) => [e.issueNumber, e.kind ?? null, e.position, e.trial ?? null]), [[30, 'older', 1, 'ready'], [31, null, null, null]]);
  assert.deepEqual([rest.waitingOn[0].track.work.stage, rest.waitingOn[0].track.work.why], ['waiting_for_you', 'plan']);
  assert.deepEqual([rest.stopped, rest.leftToPeople, rest.withPeople], [[], [], 12]);
  assert.equal(view.week.usedShare, 1, 'a share is clamped to the whole');
  assert.equal(normalizeBotSlots({ slots: {} }), null, 'no project, no view');
});

// #6151: after "Filed it as request #14…" in a design thread, what happens
// next, from the codes the line carries (services/design-threads.js
// filedNext, pinned in tests/design-plans.test.js), said in the reader's
// language after the line.
test('#6151: a filed design\'s line says what happens next: its codes read field by field, worded and drawn after it', () => {
  const { filedNextLine } = loadTsx(TRACK);
  const { normalizeBotMeta, normalizeFiledNext } = loadTsx(API);
  assert.equal(filedNextLine({ say: 'builds', version: 4 }), t('bot.track.filed.builds', { version: '4' }));
  assert.equal(filedNextLine({ say: 'builds', version: 4 }),
    'Homeroom bot reads it next and builds it from version 4. Its progress shows here and on the request.');
  for (const limit of ['builds', 'slots', 'bot_wide', 'allowance']) {
    assert.equal(filedNextLine({ say: 'held', limit }), t(`bot.track.filed.held.${limit}`), limit);
  }
  assert.deepEqual(normalizeFiledNext({ say: 'held', limit: 'builds' }), { say: 'held', limit: 'builds' }, '#6156: the bot\'s turn');
  assert.equal(filedNextLine({ say: 'held', limit: 'slots' }),
    'Homeroom bot builds it when one of its changes is voted in or closed: it is at its limit of changes up for a vote here. Its progress shows here and on the request.');
  assert.equal(filedNextLine({ say: 'held', limit: 'builds' }),
    'Homeroom bot builds it when one of its builds is done: it is building as much on this project as it may at once. Its progress shows here and on the request.');
  assert.equal(filedNextLine({ say: 'person' }), t('bot.track.filed.person'));
  assert.equal(filedNextLine(null), null);
  assert.equal(filedNextLine({ say: 'held', limit: 'taken' }), null, 'a limit this client does not know says nothing');
  // 3 Nov 2026: the daily limit on questions is gone, and so is its line.
  assert.equal(filedNextLine({ say: 'held', limit: 'questions' }), null);
  for (const key of ['builds', 'held.builds', 'held.slots', 'held.bot_wide', 'held.allowance', 'person']) {
    assert.doesNotMatch(t(`bot.track.filed.${key}`, { version: '4' }), /—/, key);
  }

  assert.deepEqual(normalizeFiledNext({ say: 'builds', version: 4 }), { say: 'builds', version: 4 });
  assert.deepEqual(normalizeFiledNext({ say: 'held', limit: 'bot_wide', extra: 1 }), { say: 'held', limit: 'bot_wide' });
  assert.deepEqual(normalizeFiledNext({ say: 'person' }), { say: 'person' });
  for (const bad of [null, 'builds', [], { say: 'builds' }, { say: 'builds', version: -1 }, { say: 'held', limit: 'taken' }, { say: 'nonsense' }]) {
    assert.equal(normalizeFiledNext(bad), null, JSON.stringify(bad));
  }
  const meta = { kind: 'design_filed', appSlug: 'ear', appName: 'Ear Trainer', filedNext: { say: 'builds', version: 4 } };
  assert.deepEqual(normalizeBotMeta({ homeroomBot: meta }).homeroomBot.filedNext, { say: 'builds', version: 4 });
  assert.equal(normalizeBotMeta({ homeroomBot: { ...meta, filedNext: { say: 'nonsense' } } }).homeroomBot.filedNext, undefined);

  // Drawn after the line, in the design thread.
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const line = (metadata) => renderToHtml(createElement(MessageRow, {
    conversationId: 42, kind: 'direct', botChat: true, inThread: true,
    message: {
      id: 901, conversationId: 42, sender: { id: 2, username: 'homeroom_bot', bot: true }, createdAt: NOW.toISOString(),
      content: 'Filed it as request #14 on Ear Trainer, under your name, with version 4 as its plan.',
      reply: null, reactions: [], attachments: [], objects: [], deleted: false, threadRootId: 500, ...(metadata ? { metadata } : {}),
    },
  }));
  const filed = line({ homeroomBot: meta });
  assert.match(filed, /Filed it as request #14 on Ear Trainer, under your name, with version 4 as its plan\.[\s\S]*<p class="messages-markdown gc-msg-content" data-design-filed-next="builds">Homeroom bot reads it next and builds it from version 4\. Its progress shows here and on the request\.<\/p>/);
  // A line from before, with no codes, is the line alone.
  assert.doesNotMatch(line(null), /data-design-filed-next/);
  assert.doesNotMatch(line({ homeroomBot: { ...meta, kind: 'chat' } }), /data-design-filed-next/, 'only the filed line says it');
});

// ── 5. The bot's slots page ───────────────────────────────────────────────

test('the slots page: what holds each slot, what waits for one in order, and the limits', () => {
  const { BotSlotsBody } = loadTsx(SLOTS);
  const vote = track({ issueNumber: 8, title: 'Sort by name', work: at('up_for_vote'), step: 'vote', links: links({ proposal: '#app/plant-pal/dev/s/91' }) });
  const building = track({ issueNumber: 9, title: 'Water log', work: at('building'), step: 'build' });
  const held = track({ issueNumber: 12, work: at('building', { line: { code: 'held_waiting' } }), step: 'build', held: { limit: 'slots', position: 1, until: null } });
  const view = {
    app: { slug: 'plant-pal', name: 'Plant Pal' }, botOn: true, acts: true, paused: false, buildCap: 5, waitCap: 15, buildsAtOnce: 2, reading: 3,
    slots: [
      { kind: 'proposal', issueNumber: 8, title: 'Sort by name', track: vote },
      { kind: 'build', issueNumber: 9, title: 'Water log', track: building },
    ],
    waiting: [{ issueNumber: 12, title: 'Dark mode', askedBy: 'lee', excerpt: 'Make it darker at night.', position: 1, since: ago(200), track: held }],
    taken: [],
    onHold: [],
    waitingOn: [],
    upNext: [],
    stopped: [],
    leftToPeople: [],
    withPeople: 0,
    week: { limited: true, usedShare: 0.42, usedUp: false, resetsAt: null },
  };
  const html = renderToHtml(createElement(BotSlotsBody, { view }));
  // #6156: the builds and the changes waiting for votes, each against its own cap.
  assert.match(html, new RegExp(`data-ws-bot-slots-building="1/5">${message('project:botSlots.slots.building', { used: 1, cap: 5 })}<`));
  assert.match(html, /data-ws-bot-slots-building="1\/5">Building 1 of 5</);
  assert.match(html, /data-ws-bot-slots-waiting="1\/15">1 of 15 waiting for votes</);
  assert.match(html, new RegExp(message('project:botSlots.slots.votes', { count: 1, cap: 15 })));
  assert.equal((html.match(/data-ws-bot-slot="\d+"/g) || []).length, 3, 'the two holding a slot, and the one waiting');
  assert.match(html, /href="#app\/plant-pal\/dev\/s\/91"[^>]*data-ws-bot-slot="8" data-ws-bot-slot-state="up_for_vote"|data-ws-bot-slot="8" data-ws-bot-slot-state="up_for_vote"[^>]*/, 'a change up for a vote opens the change');
  assert.match(html, /data-ws-bot-waiting=""/);
  assert.match(html, new RegExp(message('project:botSlots.waiting.title')));
  assert.doesNotMatch(html, /data-ws-bot-on-hold=""/, 'no hold, no section');
  assert.match(html, /data-ws-bot-week=""[\s\S]*42% used/);
  assert.match(html, />Up to 2 builds at once on this project</);
  assert.match(html, />3 requests waiting to be read</);
  assert.doesNotMatch(html, /data-ws-bot-slots-note/, 'acting: no note');

  // Its badge names the stage; the row says where it is (the stage's word
  // where it has no second line), and a request waiting for a slot, under
  // the heading that says so, its place in line.
  const { entryLine } = loadTsx(SLOTS);
  assert.equal(entryLine(building), core('work.stage.building'));
  assert.equal(entryLine({ ...building, work: at('building', { line: { code: 'reviewing', round: 1, of: 2 } }) }), 'Reviewing, round 1 of 2');
  assert.equal(entryLine(held), t('bot.track.held.next'));
  assert.equal(entryLine(null), null);
  assert.doesNotMatch(html, />Building · /, 'never the state word twice');

  // 16 Oct 2026: a row says what its request is about, not only its
  // number: a line of what it asks, who asked, and how long it has waited.
  assert.match(html, /data-ws-bot-slot-excerpt="">Make it darker at night\.</);
  const { entryMeta } = loadTsx(SLOTS);
  const meta = entryMeta(view.waiting[0], 'waiting', new Date(NOW.getTime()));
  assert.deepEqual(meta, [
    message('project:botSlots.meta.asked', { username: 'lee' }),
    message('project:botSlots.meta.waiting', { span: message('messages:bot.span.hoursMinutes', { hours: 3, minutes: 20 }) }),
  ]);
  assert.equal(entryMeta({ ...view.waiting[0], askedBy: null }, 'slots', NOW).length, 0, 'a slot\'s row has its clock on its bar');

  // A row opens its item in the Workshop's panel: the request, or its
  // change once it has one, and the open row is marked.
  assert.match(html, /data-ws-bot-slot="12"[^>]*data-ws-open="issue:12"/);
  assert.match(html, /href="#app\/plant-pal\/dev\/i\/12"/, 'the request\'s own address for a plain open');
  const { entryRef, hrefOf } = loadTsx(SLOTS);
  assert.deepEqual(entryRef({ issueNumber: 8, track: { ...vote, proposalId: 91 } }), { kind: 'proposal', id: 91 });
  assert.equal(entryRef({ issueNumber: 8, track: vote }), null, 'a change the panel cannot name opens as a page');
  assert.equal(hrefOf({ issueNumber: 900009, track: { ...held, links: null } }, 'staging-demo'), '#app/staging-demo/dev/issues/900009', 'the demo\'s rows open their mock request');
  const openHtml = renderToHtml(createElement(BotSlotsBody, { view, openKey: 'issue:12', onOpen: () => {} }));
  assert.match(openHtml, /aria-current="true"[^>]*data-ws-open="issue:12"|data-ws-open="issue:12"[^>]*aria-current="true"/);

  // One a person has taken since is listed apart, as theirs: a person is building it.
  const taken = track({ issueNumber: 14, work: at('building', { line: { code: 'claimed', by: 'maya' } }), step: 'build' });
  const takenHtml = renderToHtml(createElement(BotSlotsBody, {
    view: { ...view, taken: [{ issueNumber: 14, title: 'Frost alerts', by: 'maya', since: ago(60 * 26), track: taken }] },
  }));
  assert.match(takenHtml, /data-ws-bot-taken=""/);
  assert.match(takenHtml, new RegExp(message('project:botSlots.taken.title')));
  assert.match(takenHtml, new RegExp(core('work.line.claimed', { username: 'maya' })));
  assert.match(takenHtml, /data-ws-bot-slot-facts="">maya is building it · /);

  const off = renderToHtml(createElement(BotSlotsBody, { view: { ...view, acts: false, slots: [], waiting: [] } }));
  assert.match(off, new RegExp(`data-ws-bot-slots-note="">${message('project:botSlots.notHere').replace(/'/g, '&#x27;')}</p>`));
  assert.match(off, new RegExp(message('project:botSlots.slots.empty')));
});

test('16 Oct 2026: the slots page lists every other open request by where the bot is on it', () => {
  const { BotSlotsBody, olderLine } = loadTsx(SLOTS);
  const plan = track({ issueNumber: 20, work: at('waiting_for_you', { why: 'plan' }), step: 'plan', waitingOn: 'you', since: ago(60 * 20) });
  const queued = track({ issueNumber: 21, work: at('reading', { line: { code: 'queued' } }), step: null });
  const nothing = track({ issueNumber: 22, work: at('stopped', { reason: 'build_failed' }), step: null, cause: 'no_change' });
  const person = track({ issueNumber: 23, work: at('waiting_for_you', { why: 'decide' }), step: 'plan' });
  const older = (n, position, trial) => ({ issueNumber: n, title: `Older ${n}`, kind: 'older', position, trial, track: null });
  const view = {
    app: { slug: 'plant-pal', name: 'Plant Pal' }, botOn: true, acts: true, paused: false, buildCap: 5, waitCap: 15, buildsAtOnce: 2, reading: 1,
    slots: [], waiting: [], taken: [], onHold: [],
    waitingOn: [{ issueNumber: 20, title: 'A plan', askedBy: 'lee', since: ago(60 * 20), track: plan }],
    upNext: [
      { issueNumber: 21, title: 'Just filed', kind: 'queued', track: queued },
      older(30, 1, 'ready'), older(31, 2, null), older(32, 3, 'person'), older(33, 4, null), older(34, 5, null), older(35, 6, null),
    ],
    stopped: [{ issueNumber: 22, title: 'Built nothing', track: nothing }],
    leftToPeople: [{ issueNumber: 23, title: 'A decision', track: person }],
    withPeople: 12,
    week: null,
  };
  const html = renderToHtml(createElement(BotSlotsBody, { view }));
  for (const name of ['waiting-on', 'up-next', 'stopped', 'left']) assert.match(html, new RegExp(`data-ws-bot-${name}=""`), name);
  assert.match(html, new RegExp(`data-ws-bot-slot-facts="">${t('bot.track.line.stopped.no_change')}<`), 'a stopped build says why, from its cause');
  for (const key of ['waitingOn', 'upNext', 'stopped', 'leftToPeople']) {
    assert.match(html, new RegExp(message(`project:botSlots.${key}.title`)), key);
  }
  // In that order, under the slots.
  const where = (name) => html.indexOf(`data-ws-bot-${name}=""`);
  assert.ok(where('waiting-on') < where('up-next') && where('up-next') < where('stopped') && where('stopped') < where('left'));
  // Up next says how older requests are read; a long section shows five and a way to the rest.
  assert.match(html, new RegExp(message('project:botSlots.upNext.note')));
  assert.equal((html.match(/data-ws-bot-slot="3\d"/g) || []).length, 4, 'the queued one and four older ones: five rows');
  assert.match(html, new RegExp(`data-ws-bot-show-all="up-next"[^>]*>${message('project:botSlots.showAll', { count: 7 })}<`));
  assert.match(html, /data-ws-bot-older-badge=""/, 'an older request has a tile, not a track\'s badge');
  // What people have is counted, not listed.
  assert.match(html, new RegExp(`data-ws-bot-with-people="12">${message('project:botSlots.withPeople', { count: 12 })}<`));
  // An older request's line: its place among them, and what its trial run made of it.
  assert.equal(olderLine(older(30, 1, 'ready')), `${message('project:botSlots.older.next')} \u00b7 ${message('project:botSlots.older.trialReady')}`);
  assert.equal(olderLine(older(31, 2, null)), `${message('project:botSlots.older.ahead', { count: 1 })} \u00b7 ${message('project:botSlots.older.notRead')}`);
  assert.equal(olderLine(older(32, 3, 'person')), message('project:botSlots.older.ahead', { count: 2 }), 'a trial that said a person says nothing more');
  // Rows open beside the page, as the slots' rows do.
  assert.match(html, /data-ws-bot-slot="30"[^>]*data-ws-open="issue:30"/);
  // Nothing in a section draws nothing.
  const bare = renderToHtml(createElement(BotSlotsBody, { view: { ...view, waitingOn: [], upNext: [], stopped: [], leftToPeople: [], withPeople: 0 } }));
  assert.doesNotMatch(bare, /data-ws-bot-(?:waiting-on|up-next|stopped|left|with-people)=/);
});

test('#6156: the Workshop\'s door says the builds and the changes waiting for votes apart', () => {
  const { doorWords, slotCounts } = loadTsx(SLOTS);
  const slot = (kind, n) => ({ kind, issueNumber: n });
  const view = {
    buildCap: 5,
    slots: [slot('build', 1), slot('build', 2), slot('build', 3), ...Array.from({ length: 12 }, (_, i) => slot('proposal', 10 + i))],
    waiting: [],
  };
  assert.deepEqual(slotCounts(view), { building: 3, voting: 12 });
  assert.equal(doorWords(view), 'Homeroom bot: building 3 of 5 \u00b7 12 waiting for votes');
  assert.equal(doorWords({ ...view, waiting: [{ issueNumber: 40 }] }), 'Homeroom bot: building 3 of 5 \u00b7 12 waiting for votes \u00b7 1 request in line');
  assert.equal(doorWords({ ...view, slots: view.slots.slice(0, 3) }), 'Homeroom bot: building 3 of 5', 'none waiting for votes says nothing');
  assert.equal(doorWords({ ...view, buildCap: 8 }), 'Homeroom bot: building 3 of 8 \u00b7 12 waiting for votes', 'the server\'s cap, a project\'s own');
  const src = read(SLOTS);
  assert.doesNotMatch(src, /\b(?:cap|buildCap|waitCap):\s*(?:5|15)\b|\?\? (?:5|15)\b|\|\| (?:5|15)\b/, 'no cap written into the page');
});

test('the slots page is a page under the Workshop: its address, its way back, its door', () => {
  const places = loadTsx('frontend/src/features/dev-board/workshop/places.ts');
  assert.equal(places.litPlace('bot'), 'workshop', 'the Workshop stays lit while it is up');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /return tab === 'all' \|\| tab === 'bot' \? 'workshop' : 'status';/, 'Back goes to the Workshop');
  assert.match(ws, /\{tab === 'bot' && slug \? \(\s*<BotSlotsPage\s+slug=\{slug\}\s+backLabel=\{t\('project:page\.backToWorkshop'\)\}\s+onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}\s+openKey=\{sideKey\}\s+onOpen=\{openItem\}\s+\/>/);
  // Its rows open beside it, as the Workshop's own do.
  assert.match(ws, /const sideOpen = !!sideItem && \(tab === 'workshop' \|\| tab === 'all' \|\| tab === 'bot'\);/);
  assert.match(ws, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/);
  assert.match(ws, /data-ws-side-open=\{sideOpen \? '' : undefined\}/);
  assert.match(ws, /\{slug \? <BotSlotsDoor slug=\{slug\} onOpen=\{\(\) => openTab\('bot'\)\} \/> : null\}/, 'its door in the overview card');
  const src = read(SLOTS);
  assert.match(src, /if \(!view \|\| \(!view\.acts && !view\.slots\.length\)\) return null;/, 'no door where the bot neither builds nor holds anything');
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!slug\) return undefined;/, 'it reads in an effect, never on the first render');
  assert.equal(message('project:page.title.bot'), 'Homeroom bot\'s slots');
});
