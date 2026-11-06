'use strict';

// The shell's text comes from the catalogs (frontend/locales/README.md).
//
// tests/language-packs.test.js covers the catalog format and the packs, and
// tests/language-runtime.test.js the runtime. This suite covers the join
// between the two and the code: an id the code asks for exists, a screen
// renders what the catalog holds in the language on screen, and what has no
// translation yet renders in English.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkIds, literalsIn, looksLikeProse } = require('../scripts/language-inventory');
const { loadInSpanish } = require('./lib/language-fixture');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { renderToHtml, createElement } = require('./lib/render-tsx');

test('every message id the code asks for is in the English source', () => {
  const { used, unknown } = checkIds();
  assert.ok(used > 0, 'the client sources are read');
  assert.deepEqual(unknown.map(({ id, file, line }) => `${file}:${line} ${id}`), [],
    'an id with no catalog entry renders as the id itself');
});

test('a card renders in the language on screen, and in English where there is no translation', async (t) => {
  const { module: card } = await loadInSpanish(t, 'frontend/src/features/leaderboard/locked-challenges-card.tsx', {
    'leaderboard:challenges.locked.title_one': '{{count}} reto se desbloquea al terminar Primeros pasos',
    'leaderboard:challenges.locked.title_many': '{{count}} de retos se desbloquean al terminar Primeros pasos',
    'leaderboard:challenges.locked.title_other': '{{count}} retos se desbloquean al terminar Primeros pasos',
    'leaderboard:challenges.locked.namesAnd': '{{names}} y {{last}}',
  });
  const render = (props) => renderToHtml(createElement(card.LockedChallengesCard, props));
  assert.match(render({ count: 6 }), /<p class="[^"]*">6 retos se desbloquean al terminar Primeros pasos<\/p>/,
    'a counted message takes the plural form of the language');
  assert.match(render({ count: 1 }), />1 reto se desbloquea al terminar Primeros pasos</);
  assert.match(render({ count: 6 }), />Finish Getting started on Home to see them</,
    'a message with no Spanish yet is English, on its own');
  assert.match(render({ count: 2, names: ['Invitar', 'Votar'] }), />Invitar y Votar</, 'a sentence around the names');
  assert.match(render({ count: 5, names: ['Invitar', 'Votar'] }), />Invitar, Votar and 3 more</,
    'the names are joined the language\'s way, and the untranslated sentence around them stays whole');
});

test('in English the same text reads exactly as it did before it moved', () => {
  assert.equal(message('leaderboard:challenges.locked.title', { count: 6 }), '6 challenges unlock after Getting started');
  assert.equal(message('core:tabs.votesWaiting', { count: 1 }), '1 vote waiting on you');
  assert.equal(message('core:tabs.votesWaiting', { count: 4 }), '4 votes waiting on you');
  const { listText, t } = englishPlatformI18n();
  assert.equal(listText(['Recipe Box', t('core:liveApp.stillOpen'), null, 'unread']),
    'Recipe Box, still open, unread');
});

test('a legacy owner gets markup from a whole message, with every word and value escaped', () => {
  const { htmlRich, htmlText } = englishPlatformI18n();
  assert.equal(htmlText('core:header.switchCommunity', { community: '<b>R&D</b>' }),
    '&lt;b&gt;R&amp;D&lt;/b&gt;, switch community');
  // No shipped message carries a tag yet, so this reads the id itself as the
  // text: what matters is the parsing, which is the same for any message.
  const link = (inner) => `<a href="/terms">${inner}</a>`;
  const { loadTsx } = require('./lib/render-tsx');
  const runtime = loadTsx('frontend/src/lib/i18n/core.ts').createLanguageRuntime({
    languages: { en: 'English' }, namespaces: ['core'], manifest: {},
    english: { core: { 'legal.terms': 'Read <0>the "terms"</0>, {{name}} & <1>more</1>.' } },
  });
  assert.equal(runtime.htmlRich('core:legal.terms', { name: '<i>Ana</i>' }, [link]),
    'Read <a href="/terms">the &quot;terms&quot;</a>, &lt;i&gt;Ana&lt;/i&gt; &amp; more.',
    'the wrapper supplies the element; a tag with no wrapper keeps only its text');
  assert.equal(htmlRich('core:tabs.home'), 'Home');
});

test('the remaining-literals report finds interface English and leaves identifiers alone', () => {
  // eslint-disable-next-line global-require
  const ts = require('typescript');
  const found = literalsIn('sample.tsx', [
    'import { x } from "./Some Module";',
    'const cls = "flex items-center gap-2";',
    'export function Sample({ open }: { open: boolean }) {',
    '  if (open === "Open now") console.log("Opened the sample");',
    '  return <button className="btn" aria-label="Close" title={open ? "Hide it" : undefined}>Save changes</button>;',
    '}',
    'export const html = `<p class="note">Nothing here yet</p>`;',
  ].join('\n'), ts).map((literal) => literal.text);
  assert.deepEqual(found, ['Close', 'Hide it', 'Save changes', 'Nothing here yet']);
  assert.equal(looksLikeProse('platform-tabs'), false);
  assert.equal(looksLikeProse('Could not load that language. Try again.'), true);
});

test('a game sentence keeps everything the catalog writes around the maker\'s words', async (t) => {
  const DIR = 'frontend/src/features/first-session';
  // English, as it reads today: the starter highlighted, then the mark.
  {
    // eslint-disable-next-line global-require
    const { loadTsx } = require('./lib/render-tsx');
    const { TEMPLATES, OWN, sentence } = loadTsx(`${DIR}/examples.ts`);
    const game = TEMPLATES.find((x) => x.key === 'game');
    const board = sentence(game, 'board', 'we roll dice');
    assert.deepEqual([board.head, board.fill, board.tail],
      ['A new game we build together. For the first version, ', 'a board game where', ' …']);
    assert.equal(board.text, 'A new game we build together. For the first version, a board game where we roll dice.');
    // Odd endings read exactly as they did before the text moved: only
    // `.`, `!` and `?` count as an ending in English.
    const said = (words) => sentence(game, 'board', words).text.replace('A new game we build together. For the first version, a board game where ', '');
    assert.deepEqual(['we take turns…', 'we roll dice。', 'really?', 'go!', 'stop.', 'two  spaces ', 'x'].map(said),
      ['we take turns….', 'we roll dice。.', 'really?', 'go!', 'stop.', 'two spaces.', 'x.']);
    assert.equal(sentence(game, 'board', '').text, 'A new game we build together. For the first version, a board game where ');
    const own = sentence(game, OWN, 'we draw and guess!');
    assert.deepEqual([own.head, own.fill, own.tail], ['A new game we build together. For the first version, ', '', '']);
    assert.equal(own.text, 'A new game we build together. For the first version, we draw and guess!');
  }
  // A language that puts words AFTER the blank, marks the blank its own way
  // and closes a sentence with its own full stop.
  const { module: examples } = await loadInSpanish(t, `${DIR}/examples.ts`, {
    'onboarding:firstSession.template.game.board.sentence': 'Intro <0>TABLERO</0> {{words}} FINAL OBLIGATORIO',
    'onboarding:firstSession.template.game.own.sentence': 'Propio {{words}} DESPUÉS',
    'onboarding:firstSession.make.wordsBlank': '___',
    'onboarding:firstSession.make.wordsWithStop': '{{words}}。',
    'onboarding:firstSession.make.sentenceEnders': '。！？',
  });
  const game = examples.TEMPLATES.find((x) => x.key === 'game');
  const board = examples.sentence(game, 'board', 'tiramos dados');
  assert.deepEqual([board.head, board.fill, board.tail], ['Intro ', 'TABLERO', ' ___ FINAL OBLIGATORIO'],
    'the text after the blank is drawn, with the language\'s own mark in the blank');
  assert.equal(board.text, 'Intro TABLERO tiramos dados。 FINAL OBLIGATORIO',
    'and sent, with the catalog\'s punctuation, not an English full stop');
  assert.equal(examples.sentence(game, 'board', 'tiramos dados！').text, 'Intro TABLERO tiramos dados！ FINAL OBLIGATORIO',
    'an ending the language itself lists is left alone');
  assert.equal(examples.sentence(game, 'board', 'tiramos dados.').text, 'Intro TABLERO tiramos dados.。 FINAL OBLIGATORIO',
    'and which endings count is the catalog\'s decision, not the code\'s');
  const own = examples.sentence(game, examples.OWN, 'dibujamos');
  assert.deepEqual([own.head, own.tail], ['Propio  DESPUÉS', '']);
  assert.equal(own.text, 'Propio dibujamos。 DESPUÉS');
});

test('a person with no known username gets a sentence of their own, never a pronoun as a name', () => {
  // eslint-disable-next-line global-require
  const { loadTsx } = require('./lib/render-tsx');
  const friends = loadTsx('frontend/src/features/friends/api.ts');
  assert.equal(friends.errorMessage({ status: 404 }, 'ada'), 'You can’t add @ada as a friend right now.');
  assert.equal(friends.errorMessage({ status: 404 }, null), 'You can’t add @them as a friend right now.',
    'English reads as it always has');
  assert.equal(message('messages:friends.error.cannotAddUnnamed'), 'You can’t add @them as a friend right now.');
  // eslint-disable-next-line global-require
  const profile = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/profile/profile.js'), 'utf8');
  assert.doesNotMatch(profile, /friendErrorMessage\(err, [^)]*'them'\)/);
});

test('the id check finds an id in a namespace nobody defined, and an unknown key in one that exists', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-ids-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  put('frontend/locales/en/core.json', JSON.stringify({
    'probe.label': { text: 'Probe', description: 'Fixture.' },
    'probe.count_one': { text: '{{count}} probe', description: 'Fixture.' },
    'probe.count_other': { text: '{{count}} probes', description: 'Fixture.' },
    'probe.unused': { text: 'Unused', description: 'Fixture.' },
  }));
  // A hyphenated namespace is valid for the pack builder, so it is checked too.
  put('frontend/locales/en/new-surface.json', JSON.stringify({
    'probe.label': { text: 'Probe', description: 'Fixture.' },
  }));
  put('frontend/src/b.ts', [
    "t('new-surface:probe.label');",
    "t('new-surface:probe.missing');",
    "t('other-surface:probe.label');",
    "el.addEventListener('usernode:friends-changed', () => {});",
  ].join('\n'));
  put('frontend/src/a.ts', [
    "t('core:probe.label');",
    "t('core:probe.count', { count: 2 });",
    "t('typo:probe.label');",
    "t('core:probe.missing');",
    "const TABLE = { a: 'core:probe.label', b: `core:probe.alsoMissing` };",
    "window.addEventListener('home:refresh', () => {});",
    "fetch('https://example.com/a.b');",
  ].join('\n'));
  const { used, unknown, unused } = checkIds(root);
  assert.equal(used, 9, 'every id-shaped literal is a candidate, whatever its namespace; an event name is not');
  assert.deepEqual(unknown.map(({ id, file, line }) => `${file.slice(-4)}:${line} ${id}`), [
    'a.ts:3 typo:probe.label', 'a.ts:4 core:probe.missing', 'a.ts:5 core:probe.alsoMissing',
    'b.ts:2 new-surface:probe.missing', 'b.ts:3 other-surface:probe.label',
  ]);
  assert.deepEqual(unused, ['core:probe.unused']);
});

test('a list of approvers words the reader and the unnamed rest for the place the list stands in', async (t) => {
  const FILE = 'frontend/src/features/messages/approval-words.ts';
  // English, as it reads today, in both places.
  {
    // eslint-disable-next-line global-require
    const { loadTsx } = require('./lib/render-tsx');
    const words = loadTsx(FILE);
    assert.equal(words.waitingWords({ you: true, names: ['ada'], more: 2 }), 'Waiting for approval from you, @ada and 2 more');
    assert.equal(words.waitingWords({ you: true, names: [] }), 'Waiting for approval from you');
    assert.equal(words.waitingWords({ you: true, names: [] }, 'sentence'), 'Waiting for approval from you.');
    assert.equal(words.waitingWords({ you: true, names: ['ada', 'ben'], more: 1, missing: 2 }), 'Needs 2 approvals from you, @ada, @ben or 1 other');
    assert.deepEqual(words.afterYesWords({ missing: 4, names: ['ada', 'cy'], more: 2 }),
      { who: 'people', values: { people: '@ada, @cy and 2 more' } });
    assert.equal(message('messages:bot.ready.approved.people.none', { people: '@ada, @cy and 2 more' }),
      'You approved it. It goes live when @ada, @cy and 2 more approve too.');
  }
  // A language whose words change with their place in the sentence, and
  // which has a plural form English lacks (`many`, for a million).
  const { module: words, runtime } = await loadInSpanish(t, FILE, {
    'messages:approval.waiting': 'Esperando la aprobación de {{people}}',
    'messages:approval.waitingYou': 'Esperando tu aprobación',
    'messages:approval.list.from.you': 'ti',
    'messages:approval.list.from.more_one': '{{count}} persona más',
    'messages:approval.list.from.more_many': '{{count}} de personas más',
    'messages:approval.list.from.more_other': '{{count}} personas más',
    'messages:approval.list.subject.more_one': 'otra persona ({{count}})',
    'messages:approval.list.subject.more_many': 'otro millón de personas ({{count}})',
    'messages:approval.list.subject.more_other': 'otras {{count}} personas',
    'messages:approval.list.and': '{{first}} y {{last}}',
    'messages:bot.ready.approved.people.none': 'Lo aprobaste. Se publica cuando {{people}} lo aprueben también.',
  });
  // After "de": the reader is "ti", the rest is "N personas más".
  assert.equal(words.waitingWords({ you: true, names: ['ada'], more: 2 }),
    'Esperando la aprobación de ti, @ada y 2 personas más');
  assert.equal(words.waitingWords({ you: false, names: ['ada'], more: 1000000 }),
    'Esperando la aprobación de @ada y 1000000 de personas más', 'the plural form of the language, not of English');
  // The reader alone: a sentence of its own, where "ti" would be wrong.
  assert.equal(words.waitingWords({ you: true, names: [] }), 'Esperando tu aprobación');
  // As the subject of "approve": a different form of the same rest.
  const after = words.afterYesWords({ missing: 4, names: ['ada', 'cy'], more: 2 });
  assert.equal(after.values.people, '@ada, @cy y otras 2 personas');
  assert.equal(runtime.t('messages:bot.ready.approved.people.none', after.values),
    'Lo aprobaste. Se publica cuando @ada, @cy y otras 2 personas lo aprueben también.');
  assert.equal(words.afterYesWords({ missing: 2, names: ['ada'], more: 1 }).values.people, '@ada y otra persona (1)');
});

test('an app or an owner with no name gets an unnamed sentence that reads as the named one did with its stand-in', () => {
  // English is unchanged: each unnamed message is the named one with the
  // stand-in the code used to pass as a name written into it.
  for (const [named, unnamed, values] of [
    ['changes:dialog.permission.title', 'changes:dialog.permission.titleUnnamed', { action: 'use your camera' }],
    ['changes:dialog.permission.titleCapability', 'changes:dialog.permission.titleCapabilityUnnamed', { capability: 'geolocation' }],
    ['changes:dialog.permission.note', 'changes:dialog.permission.noteUnnamed', {}],
    ['changes:dialog.permission.noteReopen', 'changes:dialog.permission.noteReopenUnnamed', {}],
    ['changes:dialog.llm.introOwnKey', 'changes:dialog.llm.introOwnKeyUnnamed', {}],
    ['changes:dialog.llm.introBudget', 'changes:dialog.llm.introBudgetUnnamed', {}],
  ]) {
    assert.equal(message(unnamed, values), message(named, { ...values, app: 'This app' }), unnamed);
  }
  for (const [named, unnamed, standIn] of [
    ['agent:appContext.invite.title', 'agent:appContext.invite.titleUnnamed', { project: 'this app' }],
    ['agent:appContext.invite.shareTitle', 'agent:appContext.invite.shareTitleUnnamed', { project: 'this app' }],
    ['agent:appContext.invite.buildersOnly', 'agent:appContext.invite.buildersOnlyUnnamed', { project: 'this app' }],
    ['agent:appContext.invite.joinFirst', 'agent:appContext.invite.joinFirstUnnamed', { project: 'this app' }],
    ['chat:group.specCard.sharedBy', 'chat:group.specCard.sharedBySomeone', { name: 'Someone' }],
    ['chat:group.specCard.sharedByBuilt', 'chat:group.specCard.sharedBySomeoneBuilt', { name: 'Someone' }],
    ['chat:group.specCard.sharedByPr', 'chat:group.specCard.sharedBySomeonePr', { name: 'Someone' }],
    ['chat:group.specCard.sharedByBuiltPr', 'chat:group.specCard.sharedBySomeoneBuiltPr', { name: 'Someone' }],
    ['project:topic.request.stream.postedSpecVersion', 'project:topic.request.stream.postedSpecVersionUnnamed', { author: 'Someone' }],
    ['project:topic.change.line.postedSpec', 'project:topic.change.line.postedSpecUnnamed', { author: 'Someone' }],
    ['project:topic.request.spec.by', 'project:topic.request.spec.bySomeone', { author: 'Someone' }],
    ['project:topic.request.spec.byAt', 'project:topic.request.spec.bySomeoneAt', { author: 'Someone' }],
  ]) {
    const rest = { version: 3, built: 'built 2h ago', number: 7, time: '2h ago' };
    assert.equal(message(unnamed, rest), message(named, { ...rest, ...standIn }), unnamed);
  }
  assert.equal(message('changes:session.shared.workingSomeone'), message('changes:session.shared.working', { owner: 'someone' }));
  assert.equal(message('changes:session.shared.importedBySomeone', { author: 'ada' }),
    message('changes:session.shared.imported', { author: 'ada', owner: 'someone' }));
  // eslint-disable-next-line global-require
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app-view.js'), 'utf8');
  assert.doesNotMatch(src, /app: appName \}/, 'the AI dialog\'s sentences take a real name or their unnamed wording');
  assert.doesNotMatch(src, /username \|\| \(App\.user \? App\.user\.username : ''\) \|\| PlatformI18n/, 'no stand-in word becomes an owner\'s name');
  assert.match(src, /PlatformI18n\.t\('changes:dialog\.permission\.titleUnnamed', \{ action: view\.blurb \}\)/);
});

test('the Workshop\'s counted words read with a plural form for each count, and no number is tested for "one"', () => {
  // The two-count summary sentences (describe()) went with the paragraph
  // they built (After-Workshop-B). What the tab counts now is each a counted
  // message of its own.
  for (const n of [1, 2, 21]) {
    assert.equal(message('project:workRow.replies', { count: n }), `${n} ${n === 1 ? 'comment' : 'comments'}`);
    assert.equal(message('project:workshop.mine.open', { count: n }), `${n} open`);
    assert.equal(message('project:workshop.fresh.count', { count: n }), `${n} since your last visit`);
    assert.equal(message('project:workshop.dash.onYou', { count: n }), `${n} on you`);
    assert.equal(message('project:workshop.dash.fromLastWeek', { count: n }), `from ${n}`);
    for (const total of [2, 5, 21]) {
      assert.equal(message('project:communityCard.line.members.some', { count: n, total }),
        `A change goes live when its checks pass and ${n} of the ${total} active members ${n === 1 ? 'approves' : 'approve'} it.`);
      assert.equal(message('project:communityCard.lineShort.approvers.some', { count: n, total }),
        `Goes live when its checks pass and ${n} of the ${total} approvers ${n === 1 ? 'says' : 'say'} yes.`);
    }
  }
  // eslint-disable-next-line global-require
  const fs = require('node:fs');
  // eslint-disable-next-line global-require
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
  assert.ok(!/function describe\(d: Dash\)/.test(src), 'the derived sentence is gone');
  const tiles = src.slice(src.indexOf('function DashTiles('), src.indexOf(' * The three cards: what landed last week'));
  assert.ok(tiles.length > 200);
  assert.doesNotMatch(tiles, /=== 1/, 'no number is tested for "one" to choose a wording');
  assert.match(tiles, /t\('project:workshop\.dash\.onYou', \{ count: owed \}\)/);
  assert.match(tiles, /t\('project:workshop\.dash\.fromLastWeek', \{ count: d\.shippedPrevWeek \}\)/);
  const card = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dev-board/workshop/community-card.tsx'), 'utf8');
  const rule = card.slice(card.indexOf('export function ruleSentence('), card.indexOf('export function RuleWords('));
  assert.doesNotMatch(rule, /count === 1|=== 1 \?/, 'nor in the rule\'s sentences: each regime is its own message');
});

test('a machine with no name is a label where it stands alone and a wording of its own inside a sentence', async (t) => {
  const FILE = 'frontend/src/features/dev-chat/composer-chrome.tsx';
  // English, as it has always read.
  {
    // eslint-disable-next-line global-require
    const { loadTsx } = require('./lib/render-tsx');
    const { RunnerControlsView } = loadTsx(FILE);
    const past = renderToHtml(createElement(RunnerControlsView, { kind: 'past', label: 'your machine', unnamed: true }));
    assert.match(past, /title="The last turn ran on your machine\. That machine has detached, so the next turn runs on Homeroom\."/);
    assert.match(past, />Last turn: your machine<\/span>/);
    const live = renderToHtml(createElement(RunnerControlsView, { kind: 'live', label: 'your machine', unnamed: true }));
    assert.match(live, /<option value="local"[^>]*>your machine<\/option>/);
    assert.match(live, /title="Plan and coding turns in this session run on your machine, using its own Claude subscription\./);
    const named = renderToHtml(createElement(RunnerControlsView, { kind: 'past', label: 'ada-laptop' }));
    assert.match(named, /title="The last turn ran on ada-laptop\. /);
    for (const id of ['pastTitle', 'liveTitle']) {
      assert.equal(message(`devchat:runner.${id}Unnamed`), message(`devchat:runner.${id}`, { machine: 'your machine' }), id);
    }
  }
  // A language where the machine takes a different form after a preposition.
  const { module: chrome } = await loadInSpanish(t, FILE, {
    'devchat:runner.yourMachine': 'ваша машина',
    'devchat:runner.lastTurn': 'Последний ход: {{machine}}',
    'devchat:runner.pastTitle': 'Последний ход выполнен на {{machine}}.',
    'devchat:runner.pastTitleUnnamed': 'Последний ход выполнен на вашей машине.',
    'devchat:runner.liveTitle': 'Ходы выполняются на {{machine}}.',
    'devchat:runner.liveTitleUnnamed': 'Ходы выполняются на вашей машине.',
  });
  const past = renderToHtml(createElement(chrome.RunnerControlsView, { kind: 'past', label: 'ваша машина', unnamed: true }));
  assert.match(past, />Последний ход: ваша машина<\/span>/, 'alone, the stand-in is a label');
  assert.match(past, /title="Последний ход выполнен на вашей машине\."/, 'in the sentence, the unnamed wording has its own form');
  assert.doesNotMatch(past, /на ваша машина/);
  const live = renderToHtml(createElement(chrome.RunnerControlsView, { kind: 'live', label: 'ваша машина', unnamed: true }));
  assert.match(live, /title="Ходы выполняются на вашей машине\."/);
  assert.match(live, /<option value="local"[^>]*>ваша машина<\/option>/);
  const named = renderToHtml(createElement(chrome.RunnerControlsView, { kind: 'past', label: 'ada-laptop' }));
  assert.match(named, /title="Последний ход выполнен на ada-laptop\."/);
});

test('a stand-in for a missing name never reaches a sentence as the name, wherever it was made', async (t) => {
  // Each of these stand-ins is made in one file and used in another. English
  // is unchanged: the unnamed message is the named one with the stand-in in it.
  const rest = { number: 7, title: 'Fix the header' };
  for (const [named, unnamed, standIn] of [
    ['project:modals.aiConsent.title', 'project:modals.aiConsent.titleUnnamed', { app: message('changes:dialog.llm.fallbackApp') }],
    ['messages:bot.job.firstVersion', 'messages:bot.job.firstVersionUnnamed', { project: message('messages:bot.job.unnamedProject') }],
    ['messages:bot.job.request', 'messages:bot.job.requestUnnamed', { project: message('messages:bot.job.unnamedProject') }],
    ['messages:bot.job.requestTitled', 'messages:bot.job.requestTitledUnnamed', { project: message('messages:bot.job.unnamedProject') }],
    ['messages:bot.job.titled', 'messages:bot.job.titledUnnamed', { project: message('messages:bot.job.unnamedProject') }],
    ['leaderboard:standings.openDetails', 'leaderboard:standings.openDetailsAnonymous', { name: message('leaderboard:standings.anonymous') }],
    ['leaderboard:kudos.row.by', 'leaderboard:kudos.row.byUnknown', { username: message('leaderboard:kudos.unknownUser') }],
    ['session:transcript.attachment.title', 'session:transcript.attachment.titleUnnamed', { filename: message('session:transcript.attachment.unnamed') }],
  ]) {
    assert.equal(message(unnamed, rest), message(named, { ...rest, ...standIn }), unnamed);
  }

  // The bot's job names, in a language where a project's name and "a project"
  // do not sit in the sentence the same way.
  const { module: bot } = await loadInSpanish(t, 'frontend/src/features/messages/bot-shared.ts', {
    'messages:bot.job.unnamedProject': 'Un proyecto',
    'messages:bot.job.firstVersion': 'Primera versión de {{project}}',
    'messages:bot.job.firstVersionUnnamed': 'Primera versión de un proyecto',
    'messages:bot.job.request': '{{project}} n.º {{number}}',
    'messages:bot.job.requestUnnamed': 'Un proyecto, n.º {{number}}',
    'messages:bot.job.requestTitled': '{{project}} n.º {{number}}: {{title}}',
    'messages:bot.job.requestTitledUnnamed': 'Un proyecto, n.º {{number}}: {{title}}',
    'messages:bot.job.titled': '{{project}}: {{title}}',
    'messages:bot.job.titledUnnamed': 'Un proyecto: {{title}}',
  });
  const unnamed = { appName: 'Un proyecto', appUnnamed: true, issueNumber: null, title: '', firstVersion: false };
  assert.equal(bot.jobName({ ...unnamed, firstVersion: true }), 'Primera versión de un proyecto');
  assert.equal(bot.jobName({ ...unnamed, issueNumber: 7 }), 'Un proyecto, n.º 7');
  assert.equal(bot.jobName(unnamed), 'Un proyecto', 'alone, the stand-in is a label');
  assert.equal(bot.jobTitle({ ...unnamed, issueNumber: 7, title: 'Cabecera' }), 'Un proyecto, n.º 7: Cabecera');
  assert.equal(bot.jobTitle({ ...unnamed, title: 'Cabecera' }), 'Un proyecto: Cabecera');
  assert.equal(bot.jobName({ appName: 'Recetas', issueNumber: null, title: '', firstVersion: true }), 'Primera versión de Recetas');
  assert.equal(bot.jobTitle({ appName: 'Recetas', issueNumber: 7, title: 'Cabecera', firstVersion: false }), 'Recetas n.º 7: Cabecera');

  // The flag is set where the stand-in is chosen, and read where the sentence is.
  const read = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
  assert.match(read('public/js/app-view.js'), /appUnnamed: !realAppName,/);
  assert.match(read('frontend/src/features/dev-board/modals/llm-consent-modal.tsx'), /view\.appUnnamed \? t\('project:modals\.aiConsent\.titleUnnamed'\)/);
  assert.match(read('frontend/src/features/messages/bot-activity.tsx'), /appUnnamed: !\(meta\.appName \|\| meta\.appSlug\),/);
  assert.match(read('frontend/src/features/leaderboard/topochain-leaderboard.js'), /anonymous: !name,/);
  assert.match(read('frontend/src/features/leaderboard/topochain-standings.tsx'), /row\.anonymous \? t\('leaderboard:standings\.openDetailsAnonymous'\)/);
  assert.match(read('frontend/src/features/leaderboard/leaderboard.js'), /authorUnknown: !row\.author_username,/);
  assert.match(read('frontend/src/features/leaderboard/kudos-pane.tsx'), /row\.authorUnknown \? t\('leaderboard:kudos\.row\.byUnknown'\)/);
  assert.match(read('public/js/session-transcript.js'), /htmlText\('session:transcript\.attachment\.titleUnnamed'\)/);
});

test('a normalizer says whether the name it gives is real, and the sentence downstream uses that', async (t) => {
  const es = {
    'messages:bot.job.unnamedProject': 'Un proyecto',
    'messages:bot.job.firstVersion': 'Primera versión de {{project}}',
    'messages:bot.job.firstVersionUnnamed': 'Primera versión de un proyecto',
    'messages:bot.job.request': '{{project}} n.º {{number}}',
    'messages:bot.job.requestUnnamed': 'Un proyecto, n.º {{number}}',
    'messages:api.conversationTitle': 'Conversación',
    'messages:api.unknownUser': 'desconocido',
  };
  const { module: api } = await loadInSpanish(t, 'frontend/src/features/messages/api.ts', es);
  const { module: bot } = await loadInSpanish(t, 'frontend/src/features/messages/bot-shared.ts', es);

  // The viewer's requests (GET /api/ai/tracks): every track, whatever its
  // stage, comes through here (5 Nov 2026: the tray's Now, Needs you and
  // History are gone).
  const work = api.normalizeBotWork({
    tracks: [{ firstVersion: true, work: { stage: 'building' } }, { appSlug: 'recetas', issueNumber: 7, work: { stage: 'building' } },
      { appName: 'A project', firstVersion: true, work: { stage: 'building' } },
      { firstVersion: true, work: { stage: 'waiting_for_you', why: 'question' } }, { firstVersion: true, work: { stage: 'live' } }],
  });
  const [nameless, slugged, calledAProject, ...others] = work.tracks;
  assert.equal(nameless.appUnnamed, true);
  assert.equal(nameless.appName, 'Un proyecto', 'alone, the stand-in is the catalog\'s label');
  assert.equal(bot.jobName(nameless), 'Primera versión de un proyecto');
  assert.doesNotMatch(bot.jobName(nameless), /A project|de Un proyecto/);
  assert.ok(!slugged.appUnnamed, 'a slug names the project');
  assert.equal(bot.jobName(slugged), 'recetas n.º 7');
  assert.ok(!calledAProject.appUnnamed, 'a project really called "A project" is named');
  assert.equal(bot.jobName(calledAProject), 'Primera versión de A project');
  assert.equal(others.length, 2, 'a track in any stage is read from the payload');
  for (const track of others) {
    assert.equal(track.appUnnamed, true, track.work.stage);
    assert.equal(bot.jobName(track), 'Primera versión de un proyecto', track.work.stage);
  }

  // A conversation nobody named, and one that is really called "Conversation".
  const untitled = api.normalizeConversation({ id: 4, kind: 'group', members: [] });
  assert.equal(untitled.title, 'Conversación');
  assert.equal(untitled.untitled, true);
  const titled = api.normalizeConversation({ id: 5, kind: 'group', title: 'Conversación', members: [] });
  assert.equal(titled.untitled, false);
  const direct = api.normalizeConversation({ id: 6, kind: 'direct', peer: { id: 2, username: 'ada' }, members: [] });
  assert.equal(direct.untitled, false);
  assert.equal(direct.title, 'ada');

  // A person whose username did not come with the row.
  assert.equal(api.normalizeUser({ id: 9 }).unnamed, true);
  assert.equal(api.normalizeUser({ id: 9 }).username, 'desconocido');
  assert.equal(api.normalizeUser({ id: 9, username: 'unknown' }).unnamed, undefined, 'an account really called "unknown" is named');
  assert.equal(api.normalizeUser({ id: 9, username: '' }).username, '', 'an empty username stays empty, as before');

  // The consumers read the flag: source pins for each sentence.
  const read = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
  const members = read('frontend/src/features/messages/members-dialog.tsx');
  assert.match(members, /active\?\.untitled \? t\('messages:members\.leave\.titleUntitled'\)\s*: active\?\.title \? t\('messages:members\.leave\.title', \{ group: active\.title \}\)/);
  assert.match(read('frontend/src/features/messages/share-to-dialog.tsx'), /choice\.unnamed === 'conversation' \? t\('messages:shareTo\.sharedToUntitled'\)/);
  assert.match(read('frontend/src/features/messages/message-row.tsx'), /message\.sender\.unnamed \? \(message\.sender\.id \? t\('messages:row\.block\.titleUnknownHandle'\)/);
  assert.doesNotMatch(read('frontend/src/features/messages/api.ts'), /'A project'|'unknown'\)/);
});

test('every unnamed wording added for a stand-in reads as the named one did with that stand-in', () => {
  const pairs = [
    ['messages:members.leave.title', 'messages:members.leave.titleUntitled', { group: 'Conversation' }],
    ['messages:shareTo.sharedTo', 'messages:shareTo.sharedToUntitled', { destination: 'Conversation' }],
    ['messages:members.remove.title', 'messages:members.remove.titleUnknown', { username: 'unknown' }],
    ['messages:invitation.invitedBy', 'messages:invitation.invitedByUnknown', { username: 'unknown' }],
    ['messages:invitation.declineAndBlock', 'messages:invitation.declineAndBlockUnknown', { username: 'unknown' }],
    ['messages:attachments.removeNamed', 'messages:attachments.removeUnnamed', { file: 'file' }],
    ['chat:group.attachment.openFullSize', 'chat:group.attachment.openFullSizeUnnamed', { file: 'file' }],
    ['chat:group.attachment.download', 'chat:group.attachment.downloadUnnamed', { file: 'file' }],
    ['chat:group.attachment.view', 'chat:group.attachment.viewUnnamed', { file: 'file' }],
    ['chat:group.attachment.previewTitle', 'chat:group.attachment.previewTitleUnnamed', { file: 'file' }],
    ['chat:group.menu.block', 'chat:group.menu.blockUnknown', { username: 'System' }],
    ['chat:group.blockConfirm.title', 'chat:group.blockConfirm.titleUnknown', { username: 'System' }],
    ['chat:group.report.label', 'chat:group.report.labelUnknown', { username: 'System' }],
    ['chat:group.composer.replyingTo', 'chat:group.composer.replyingToPr', { name: 'PR 12', number: 12 }],
    ['chat:group.composer.replyingTo', 'chat:group.composer.replyingToPrUnnumbered', { name: 'PR' }],
    ['devchat:transcript.attachment.openFullSize', 'devchat:transcript.attachment.openFullSizeUnnamed', { name: 'file' }],
    ['devchat:transcript.attachment.download', 'devchat:transcript.attachment.downloadUnnamed', { name: 'file' }],
    ['agent:appContext.about.lineage.linkTitle', 'agent:appContext.about.lineage.linkTitleDeleted', { app: '<deleted>' }],
    ['agent:appContext.about.lineage.remixedFrom', 'agent:appContext.about.lineage.remixedFromDeleted', { app: '<deleted>' }],
    ['home:grid.tile.remixedFrom', 'home:grid.tile.remixedFromDeleted', { app: '<deleted>' }],
    ['project:communityCard.inviteCard.join', 'project:communityCard.inviteCard.joinUnnamed', { project: 'this community' }],
  ];
  for (const base of ['messages:composer.replyingTo', 'messages:row.block.title', 'messages:row.reportLabel',
    'messages:row.menu.block', 'messages:header.block.title']) {
    pairs.push([base, `${base}UnknownHandle`, { name: '@unknown' }], [base, `${base}Unknown`, { name: 'unknown' }]);
  }
  for (const [named, unnamed, standIn] of pairs) {
    assert.equal(message(unnamed, { open: '<', close: '>', ...standIn }), message(named, standIn), unnamed);
  }
  // Stand-ins that are shown alone, and sentences that used to be bare literals.
  assert.equal(message('messages:api.unknownUser'), 'unknown');
  assert.equal(message('chat:group.attachment.unnamed'), 'file');
  assert.equal(message('devchat:attach.unnamedFile'), 'file');
  assert.equal(message('chat:group.quote.system'), 'system');
  assert.equal(message('shell:invitePreview.unnamed'), 'this community');
  assert.equal(message('shell:invitePreview.privateCommunity'), 'Private community');
  assert.equal(message('messages:store.error.groupNeedsName'), 'A group needs a name.');
  assert.equal(message('messages:store.error.groupNameTooLong'), 'Group names can be up to 80 characters.');
  assert.equal(message('messages:store.error.chooseConversation'), 'Choose a conversation.');
  // Each protected setting has its own whole sentences; no phrase is fitted into a frame.
  const phrases = { admins: 'who runs this app', governance: 'how changes are approved', visibility: 'who can see this app',
    platformEnv: 'this app’s platform settings', secrets: 'this app’s keys' };
  for (const [key, phrase] of Object.entries(phrases)) {
    assert.equal(message(`changes:explicit.lead.${key}`), `It changes ${phrase}.`);
    assert.equal(message(`changes:explicit.adminMerge.${key}`),
      `Admin: merge this change to ${phrase} right now, without the vote or another member’s Yes`);
  }
});

test('the remaining-literals report reads what the earlier version skipped', () => {
  // eslint-disable-next-line global-require
  const ts = require('typescript');
  const found = (code) => literalsIn('x.js', code, ts).map((literal) => literal.text);
  // A sentence that starts with a one-letter word, or with an acronym.
  assert.equal(looksLikeProse('A project'), true);
  assert.equal(looksLikeProse('PR #12'), true);
  // A stand-in for a missing name in a name-like field, in lower case.
  assert.deepEqual(found("const row = { name: a.filename || 'file', who: c.username || 'unknown' };"), ['file', 'unknown']);
  assert.deepEqual(found("const row = { kind: a.kind || 'file', id: x || 'main' };"), [], 'an identifier elsewhere is left alone');
  // Text inside a callback handed to a call whose own arguments are not text.
  assert.deepEqual(found("el.addEventListener('click', () => { toast('Saved for later'); });"), ['Saved for later']);
  // Text on the other side of a comparison.
  assert.deepEqual(found("return open({ title: 'Private community' }) !== false;"), ['Private community']);
  assert.deepEqual(found("if (kind === 'Private community') go();"), []);
  // A thrown message written to a person; a developer's reason is left alone.
  assert.deepEqual(found("throw new Error('A group needs a name.');"), ['A group needs a name.']);
  assert.deepEqual(found("throw new Error('fetch failed');"), []);
  // A spoken attribute set by hand, a single-quoted one in markup, an element's children,
  // a default for a name, and a literal handed to a message as a value.
  assert.deepEqual(found("el.setAttribute('aria-label', 'close'); el.setAttribute('data-kind', 'Open thing');"), ['close']);
  assert.deepEqual(found("el.innerHTML = `<button title='Close panel'>x</button>`;"), ['Close panel']);
  assert.deepEqual(found("React.createElement('p', null, 'Nothing here yet');"), ['Nothing here yet']);
  assert.deepEqual(found("function row(name = 'someone', kind = 'main') { return name + kind; }"), ['someone']);
  assert.deepEqual(found("t('chat:x.y', { name: who || 'Someone else' });"), ['Someone else']);
  // Known not to be seen: an error message with no full stop, and text that is built from pieces.
  assert.deepEqual(found("throw new Error('Could not save the draft');"), []);
});

test('the flag survives every copy between the normalizer and the sentence', async (t) => {
  const es = {
    'messages:api.unknownUser': 'desconocido',
    'messages:api.conversationTitle': 'Conversación',
    'messages:thread.summary.openLastFrom_one': '{{count}} respuesta, la última de @{{username}}. Abrir hilo',
    'messages:thread.summary.openLastFrom_other': '{{count}} respuestas, la última de @{{username}}. Abrir hilo',
    'messages:thread.summary.openLastFrom_many': '{{count}} respuestas, la última de @{{username}}. Abrir hilo',
    'messages:thread.summary.openLastFromUnknown_one': '{{count}} respuesta, la última de alguien sin nombre. Abrir hilo',
    'messages:thread.summary.openLastFromUnknown_other': '{{count}} respuestas, la última de alguien sin nombre. Abrir hilo',
    'messages:thread.summary.openLastFromUnknown_many': '{{count}} respuestas, la última de alguien sin nombre. Abrir hilo',
    'messages:thread.summary.openLastFromSomeone_one': '{{count}} respuesta, la última de otra persona. Abrir hilo',
    'messages:thread.summary.openLastFromSomeone_other': '{{count}} respuestas, la última de otra persona. Abrir hilo',
    'messages:thread.summary.openLastFromSomeone_many': '{{count}} respuestas, la última de otra persona. Abrir hilo',
  };
  const { module: api } = await loadInSpanish(t, 'frontend/src/features/messages/api.ts', es);

  // Share to: the row's label is built with an @ in front, and the flag goes with it.
  const { module: share } = await loadInSpanish(t, 'frontend/src/features/messages/share-to-dialog.tsx', es);
  const conversation = (row) => ({ ...api.normalizeConversation(row), membershipStatus: 'member', canSend: true, archived: false });
  const [nameless, calledUnknown, group, named] = share.shareDestinations([
    conversation({ id: 1, kind: 'direct', peer: { id: 7 }, members: [] }),
    conversation({ id: 2, kind: 'direct', peer: { id: 8, username: 'unknown' }, members: [] }),
    conversation({ id: 3, kind: 'group', members: [] }),
    conversation({ id: 4, kind: 'group', title: 'Diseño', members: [] }),
  ], [], { me: 1 });
  assert.equal(nameless.label, '@desconocido', 'alone, the row shows the stand-in');
  assert.equal(nameless.unnamed, 'person');
  assert.equal(calledUnknown.label, '@unknown');
  assert.equal(calledUnknown.unnamed, undefined, 'an account really called "unknown" is named');
  assert.equal(group.unnamed, 'conversation');
  assert.equal(named.unnamed, undefined);

  // The card under a message: Messages hands "unknown", an app's chat "someone".
  const { module: summary } = await loadInSpanish(t, 'frontend/src/features/message-actions/thread-summary.tsx', es);
  const card = (lastReply, replyCount = 2) => renderToHtml(createElement(summary.ThreadSummaryChip, {
    replyCount, lastReplyAt: null, lastReply: { face: null, text: 'hola', ...lastReply }, onOpen() {},
  }));
  assert.match(card({ name: 'desconocido', unnamed: 'unknown' }), /aria-label="2 respuestas, la última de alguien sin nombre\. Abrir hilo"/);
  assert.match(card({ name: 'desconocido', unnamed: 'unknown' }, 1), /aria-label="1 respuesta, la última de alguien sin nombre\. Abrir hilo"/);
  assert.match(card({ name: 'alguien', unnamed: 'someone' }), /aria-label="2 respuestas, la última de otra persona\. Abrir hilo"/);
  assert.match(card({ name: 'unknown' }), /aria-label="2 respuestas, la última de @unknown\. Abrir hilo"/, 'a real username stays on the named path');
  assert.match(card({ name: 'desconocido', unnamed: 'unknown' }), />@desconocido<\/strong>/, 'alone, the stand-in is a label');

  // English is what it was for each stand-in.
  for (const [named1, unnamed1, standIn] of [
    ['messages:thread.summary.openLastFrom', 'messages:thread.summary.openLastFromUnknown', { username: 'unknown' }],
    ['messages:thread.summary.openLastFrom', 'messages:thread.summary.openLastFromSomeone', { username: 'someone' }],
    ['messages:thread.summary.openLastFromAt', 'messages:thread.summary.openLastFromUnknownAt', { username: 'unknown' }],
    ['messages:thread.summary.openLastFromAt', 'messages:thread.summary.openLastFromSomeoneAt', { username: 'someone' }],
  ]) {
    for (const count of [1, 2]) {
      assert.equal(message(unnamed1, { count, when: '5m ago' }), message(named1, { count, when: '5m ago', ...standIn }), `${unnamed1} ${count}`);
    }
  }
  for (const [named1, unnamed1, standIn] of [
    ['messages:header.menu.block', 'messages:header.menu.blockUnnamedHandle', { name: '@unknown' }],
    ['messages:header.menu.block', 'messages:header.menu.blockUnnamed', { name: 'unknown' }],
    ['messages:shareTo.sharedTo', 'messages:shareTo.sharedToUnknown', { destination: '@unknown' }],
    ['messages:composer.requestSent.waitingNamed', 'messages:composer.requestSent.waitingUnknown', { username: 'unknown' }],
    ['messages:composer.firstMessageHintNamed', 'messages:composer.firstMessageHintUnknown', { username: 'unknown' }],
    ['messages:thread.typingOne', 'messages:thread.typingOneUnknown', { name: 'unknown' }],
    ['messages:thread.typingTwo', 'messages:thread.typingTwoUnknown', { first: 'unknown', second: 'unknown' }],
    ['messages:thread.typingTwo', 'messages:thread.typingTwoFirstUnknown', { first: 'unknown', second: 'ada' }],
    ['messages:thread.typingTwo', 'messages:thread.typingTwoSecondUnknown', { first: 'ada', second: 'unknown' }],
    // One request, one story: the tray's status line (bot.tray.*) and the
    // strip that replaced it are gone; a request's name (bot-shared.ts
    // jobName) and the chat's line for a first version say it this way.
    ['messages:bot.job.firstVersion', 'messages:bot.job.firstVersionUnnamed', { project: 'A project' }],
    ['chat:group.file.loadFailedStatus', 'chat:group.file.loadFailedStatusUnnamed', { file: 'file', status: 404 }],
    ['project:topic.request.spec.by', 'project:topic.request.spec.bySystem', { author: 'System' }],
    ['project:topic.request.spec.byAt', 'project:topic.request.spec.bySystemAt', { author: 'System' }],
    ['project:topic.request.stream.postedSpec', 'project:topic.request.stream.postedSpecSystem', { author: 'System' }],
  ]) {
    const rest = { first: 'ada', second: 'ada', time: '2h ago' };
    assert.equal(message(unnamed1, { ...rest, ...standIn }), message(named1, { ...rest, ...standIn }), unnamed1);
  }

  // The hops themselves: each copy of the name takes the flag with it.
  const read = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
  assert.match(read('frontend/src/features/messages/message-row.tsx'), /name: message\.thread\.lastReply\.sender\.username,\n\s*\.\.\.\(message\.thread\.lastReply\.sender\.unnamed \? \{ unnamed: 'unknown' as const \} : \{\}\),/);
  assert.match(read('public/js/group-chat.js'), /unnamed: !last\.username, text:/);
  assert.match(read('frontend/src/features/group-chat/transcript.tsx'), /data-att-unnamed=\{att\.unnamed \? '' : undefined\}/, 'the DOM bridge carries the flag too');
  assert.match(read('public/js/group-chat.js'), /btn\.hasAttribute\('data-att-unnamed'\)/);
  assert.match(read('frontend/src/features/group-chat/transcript.tsx'), /\.\.\.\(msg\.thread\.lastReply\.unnamed \? \{ unnamed: 'someone' as const \} : \{\}\),/);
  assert.match(read('frontend/src/features/messages/index.tsx'), /peer\.unnamed \? \(peer\.id \? t\('messages:header\.menu\.blockUnnamedHandle'\) : t\('messages:header\.menu\.blockUnnamed'\)\)/);
  assert.match(read('frontend/src/features/messages/composer.tsx'), /waitingUnknown \? t\('messages:composer\.requestSent\.waitingUnknown'\)/);
  // A request's track keeps the flag its job was read with, and its name reads it.
  assert.match(read('frontend/src/features/messages/api.ts'), /\.\.\.\(job\.appUnnamed \? \{ appUnnamed: true \} : \{\}\),/);
  assert.match(read('frontend/src/features/messages/bot-shared.ts'), /if \(job\.appUnnamed\) \{\n\s*if \(job\.firstVersion\) return t\('messages:bot\.job\.firstVersionUnnamed'\);/);
});

test('the bot\'s news line never takes the unnamed project\'s stand-in as a project\'s name', async (t) => {
  // One request, one story: the header's status line, which this test held
  // to the rule, is gone, and so is the "Your requests" drawer that replaced
  // it (5 Nov 2026). Each request's line in the chat names it
  // (bot-news-line.tsx newsTitle), and holds to the same rule.
  const es = {
    'messages:bot.job.unnamedProject': 'Un proyecto',
    'messages:bot.job.firstVersionUnnamed': 'La primera versión de un proyecto',
    'messages:bot.strip.firstVersion': '{{project}}, primera versión',
    'messages:bot.strip.requestNumber': 'Solicitud n.º {{number}}',
  };
  const { module: news } = await loadInSpanish(t, 'frontend/src/features/messages/bot-news-line.tsx', es);
  const title = (meta) => news.newsTitle({ kind: 'merged', appName: null, appSlug: null, ...meta });
  assert.equal(title({ firstVersion: true }), 'La primera versión de un proyecto', 'the stand-in is not placed as a name');
  assert.equal(message('messages:bot.job.firstVersionUnnamed') === message('messages:bot.strip.firstVersion', { project: 'Un proyecto' }), false);
  // A project really called "A project", and one known by its slug, stay on the named path.
  assert.equal(title({ firstVersion: true, appName: 'A project' }), 'A project, primera versión');
  assert.equal(title({ firstVersion: true, appSlug: 'recetas' }), 'recetas, primera versión');
  // A request is named by itself, never by its project.
  assert.equal(title({ issueNumber: 12 }), 'Solicitud n.º 12');
  assert.equal(title({ issueNumber: 12, requestTitle: 'Recetas' }), 'Recetas');
  // Nothing else to name it by: the stand-in alone, as a label.
  assert.equal(title({}), 'Un proyecto');
});

test('the reply strip words a nameless row in its own sentence', async (t) => {
  const { module: composer } = await loadInSpanish(t, 'frontend/src/features/group-chat/composer.tsx', {
    'chat:group.composer.replyingTo': '↩ Respondiendo a {{name}}',
    'chat:group.composer.replyingToSystem': '↩ Respondiendo a un aviso del sistema',
    'chat:group.composer.replyingToSomeone': '↩ Respondiendo a alguien',
  });
  const strip = (quote) => renderToHtml(createElement(composer.ComposerSlotsView, {
    scope: 'general', slot: { quote: { snippet: 'x', ...quote }, attachError: null, attachments: [], status: '' },
  }));
  assert.match(strip({ label: '@System', unnamed: 'system' }), />↩ Respondiendo a un aviso del sistema</);
  assert.match(strip({ label: '@Someone', unnamed: 'someone' }), />↩ Respondiendo a alguien</);
  assert.match(strip({ label: '@System', unnamed: null }), />↩ Respondiendo a @System</, 'an account really called System is named');
  assert.equal(message('chat:group.composer.replyingToSystem'), message('chat:group.composer.replyingTo', { name: '@System' }));
  assert.equal(message('chat:group.composer.replyingToSomeone'), message('chat:group.composer.replyingTo', { name: '@Someone' }));
});

test('the release banner has a whole sentence for a commit that is not known', async (t) => {
  const kinds = { workflow_failed: 'failed', workflow_running: 'slow', rollout_missing: 'notRolled', unknown: 'noRun' };
  for (const key of Object.values(kinds)) {
    assert.equal(message(`project:releaseStall.${key}.commitUnknown`), message(`project:releaseStall.${key}.commit`, { commit: '(unknown)' }), key);
    assert.equal(message(`project:releaseStall.${key}.commitUnknownRunning`, { running: 'abc1234' }),
      message(`project:releaseStall.${key}.commitRunning`, { commit: '(unknown)', running: 'abc1234' }), key);
  }
  const { module: stall } = await loadInSpanish(t, 'frontend/src/features/dev-board/release-stall-store.ts', {
    'project:releaseStall.failed.commit': 'El commit {{commit}} llegó a main pero no se publicó.',
    'project:releaseStall.failed.commitUnknown': 'Un commit que no conocemos llegó a main pero no se publicó.',
  });
  assert.equal(stall.releaseStallText({ kind: 'workflow_failed', sha: null, prNumber: null, running: null }),
    'Un commit que no conocemos llegó a main pero no se publicó.');
  assert.equal(stall.releaseStallText({ kind: 'workflow_failed', sha: '7817d05', prNumber: null, running: null }),
    'El commit 7817d05 llegó a main pero no se publicó.');
});
