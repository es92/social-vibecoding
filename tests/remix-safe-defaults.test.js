'use strict';

// Make your own: safe defaults. People see a fork as "Make your own" (their
// own version of the app, docs/plans/versions.md); the code, the route (POST
// /api/apps/:slug/fork) and every id keep "fork". The file keeps its old name.
//
// What is pinned here is what a person reads before they make a version,
// because it has to match what the worker does (src/services/app-forker.js,
// pinned in tests/app-forker-reliability.test.js and
// tests/app-forker-no-shell.test.js):
//
//   - the dialog (frontend/src/features/dialogs/fork-app.tsx), as the
//     prerendered shell ships it: its title, lead, field, the box saying what
//     is copied, what starts fresh and what is not, the "Get its updates"
//     switch, on, and its button. Two old bugs are pinned closed: JSX dropped
//     the spaces around the inline app name ("ForkingBook Clubstands up…"),
//     and the name was near-white (`text-zinc-300`) on a light card.
//   - the four doors to it say "Make your own", and the lineage says "Made
//     from". Nothing on screen says remix, fork or upstream.
//
// Run with: node --test tests/remix-safe-defaults.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DIALOG_SRC = read('frontend/src/features/dialogs/fork-app.tsx');

/** The #fork-modal subtree of the prerendered shell, as markup. */
function forkModalHtml() {
  const html = read('public/index.html');
  const start = html.indexOf('<div id="fork-modal"');
  assert.ok(start !== -1, 'the shell prerenders #fork-modal');
  const end = html.indexOf('<div id="import-pr-modal"', start);
  return html.slice(start, end === -1 ? undefined : end);
}

/** Visible text, tags removed WITHOUT adding spaces, so a lost space shows. */
function textOf(markup) {
  return markup.replace(/<[^>]*>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

test('the dialog is "Make your own version of <App>", with the name in its sentence and readable', () => {
  const modal = forkModalHtml();
  assert.match(modal, /<h2[^>]*>Make your own version of <span id="fork-source-name">/,
    'a real space between the words and the name');
  const name = modal.match(/<span id="fork-source-name"([^>]*)>/);
  assert.ok(name, '#fork-source-name keeps its id');
  assert.doesNotMatch(name[1], /text-zinc-300/, 'the name is not near-white on the light card');
  assert.doesNotMatch(name[1], /class=/, 'it takes the heading\'s own ink in both themes');
  // The old lead ran the name into its sentence. Every inline element in the
  // dialog now has its space inside a string.
  assert.doesNotMatch(DIALOG_SRC, /<span id="fork-source-name"[^>]*>\s*\{sourceName\}\s*<\/span>\s*\n\s*stands up/);
});

test('the dialog says what a version copies, what starts fresh and what it leaves behind', () => {
  const text = textOf(forkModalHtml());
  for (const line of [
    'It’s yours to change. It starts as Just you.',
    'Name for your version',
    'Copied: the code, the look and the icon.',
    'Starts fresh: it’s Just you, with an empty database. Invite people or open it up later.',
    'Not copied: anyone’s data, keys, chat or members. If the app needs a key, you’ll add your own before it goes live.',
  ]) {
    assert.ok(text.includes(line), `the dialog says: ${line}`);
  }
  // Code can live on Homeroom's own git host now, so the dialog no longer
  // promises where it is public.
  assert.doesNotMatch(text, /public on GitHub/);
  assert.match(forkModalHtml(), /id="fork-submit"[^>]*>Make my version</, 'the button says Make my version');
  assert.match(forkModalHtml(), /placeholder="My version"/);
  // The old box promised the opposite of what a version now does.
  assert.doesNotMatch(text, /public data|Carries over|Fork|Remix|remix|upstream/i,
    'nothing says public data comes along, and people never see "Fork" or "Remix"');
  assert.doesNotMatch(text, /—/, 'no em dashes in the copy');
});

test('the dialog asks to get the original\'s updates, on by default, and sends the answer', () => {
  const modal = forkModalHtml();
  // Prerendered before any source is known: the unnamed words.
  assert.match(modal, /<label[^>]*for="fork-follow"[^>]*class="fork-follow"|<label[^>]*class="fork-follow"[^>]*for="fork-follow"/);
  const text = textOf(modal);
  assert.ok(text.includes('Get its updates'), 'the switch says what it does');
  assert.ok(text.includes('When the original changes, you get the change to try and vote on. Nothing changes unless you say yes.'));
  assert.match(modal, /<input[^>]*id="fork-follow"[^>]*>/);
  assert.match(modal.match(/<input[^>]*id="fork-follow"[^>]*>/)[0], /checked=""/, 'on by default');
  assert.match(modal.match(/<input[^>]*id="fork-follow"[^>]*>/)[0], /class="un-switch"/, 'the shell\'s switch');
  // Named once the source is known.
  assert.equal(message('dialogs:fork.follow.title', { app: 'Tier list' }), 'Get Tier list’s updates');
  assert.equal(message('dialogs:fork.follow.sub', { app: 'Tier list' }),
    'When Tier list changes, you get the change to try and vote on. Nothing changes unless you say yes.');
  // The answer goes with the name, and every open starts on.
  assert.match(DIALOG_SRC, /body: JSON\.stringify\(\{ name, follow \}\)/);
  assert.match(DIALOG_SRC, /setForked\(null\);\s*setFollow\(true\);/);
});

test('the name field suggests "<App> (my version)" and a failed POST says so in plain words', () => {
  assert.match(DIALOG_SRC, /inputRef\.current\.value = src\?\.name\s*\? t\('dialogs:fork\.defaultName\.named', \{ app: src\.name \}\)\s*: t\('dialogs:fork\.defaultName\.unnamed'\);/);
  assert.equal(message('dialogs:fork.defaultName.named', { app: 'Book Club' }), 'Book Club (my version)');
  assert.equal(message('dialogs:fork.defaultName.unnamed'), 'My version');
  assert.match(DIALOG_SRC, /\{busy \? t\('dialogs:fork\.submitting'\) : t\('dialogs:fork\.submit'\)\}/);
  assert.deepEqual([message('dialogs:fork.submitting'), message('dialogs:fork.submit')], ['Making it…', 'Make my version']);
  assert.match(DIALOG_SRC, /setError\(data\.error \|\| t\('dialogs:fork\.error\.failed'\)\)/);
  assert.equal(message('dialogs:fork.error.failed'), 'Could not make your version.');
  assert.match(DIALOG_SRC, /toast\?\.\(\s*t\('dialogs:fork\.beingMade'\),/);
  assert.equal(message('dialogs:fork.beingMade'), 'Your version is being made. It will appear in your apps when it is ready.');
  assert.match(DIALOG_SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(source\.slug\)\}\/fork`/,
    'the route keeps its name');
});

test('the allowance line names versions among what shares it', () => {
  const src = read('frontend/src/features/dialogs/app-allowance.tsx');
  assert.match(src, /t\('dialogs:allowance\.detail\.available', \{ count: quota\.remaining \}\)/);
  for (const id of ['dialogs:allowance.detail.available', 'dialogs:allowance.detail.availableSpent']) {
    assert.match(message(id, { count: 2 }), /New projects, imports and versions share this allowance\./);
    assert.doesNotMatch(message(id, { count: 2 }), /forking|remixing/);
  }
  assert.doesNotMatch(src, /importing and forking/);
});

test('the three doors say "Make your own", and keep their ids and data attributes', () => {
  const about = read('frontend/src/features/app-context/about-pane.tsx');
  assert.match(about, /id="app-about-fork"[\s\S]{0,120}label=\{t\('agent:appContext\.about\.remix'\)\}\s+sub=\{t\('agent:appContext\.about\.remixSub'\)\}/);
  assert.equal(message('agent:appContext.about.remix'), 'Make your own');
  assert.equal(message('agent:appContext.about.remixSub'), 'Your own version to change');

  const plus = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(plus, /data-plus="fork"[\s\S]{0,140}title=\{t\('project:menu\.remix\.title'\)\}\s+sub=\{t\('project:menu\.remix\.sub'\)\}/);
  assert.deepEqual([message('project:menu.remix.title'), message('project:menu.remix.sub')], ['Make your own', 'Your own version to change']);

  const home = read('frontend/src/features/home/home.js');
  assert.match(home, /key: 'fork',\s+label: message\('home:menu\.remix\.label'\),\s+sub: message\('home:menu\.remix\.sub'\),/,
    'the card menu');
  assert.equal(message('home:menu.remix.label'), 'Make your own');
  assert.equal(message('home:menu.remix.sub'), 'Your own version to change');
  assert.equal(message('dialogs:createProgress.title.remixing', { app: 'Book club picks' }), 'Making Book club picks');

  for (const [file, src] of [['about-pane', about], ['actions-row', plus], ['home', home]]) {
    assert.doesNotMatch(src, /'Fork this app'|"Fork this app"/, `${file}: people never see "Fork this app"`);
  }
});

test('lineage reads "Made from" wherever people see it', () => {
  // Where the line is a catalog message, the file names its id and the catalog
  // holds the words; a file that still writes the line holds it itself.
  for (const [file, ids] of [
    ['frontend/src/features/home/home.js', ['home:grid.tile.remixedFrom']],
    ['frontend/src/features/home/app-grid.tsx', ['home:grid.tile.remixedFrom']],
    ['frontend/src/features/app-context/about-pane.tsx',
      ['agent:appContext.about.lineage.remixedFrom', 'agent:appContext.about.lineage.linkTitle']],
  ]) {
    const src = read(file);
    if (ids.length) {
      for (const id of ids) {
        assert.ok(src.includes(`'${id}'`), `${file} reads ${id}`);
        const said = message(id, { app: 'Recipe Box' });
        assert.match(said, /^Made from Recipe Box/, `${file} says Made from`);
        assert.doesNotMatch(said, /Forked from|Remixed from|\u2442/, `${id} no longer says Forked or Remixed from, nor draws the fork sign`);
      }
    } else {
      assert.match(src, /Made from \$\{/, `${file} says Made from`);
    }
    assert.doesNotMatch(src, /[`"']Forked from|\bForked from \$\{/, `${file} no longer says Forked from`);
  }
});

test('the home tile\'s lineage badge keeps .fork-tag and drops the fork sign', () => {
  for (const file of ['frontend/src/features/home/app-grid.tsx', 'frontend/src/features/home/home.js']) {
    const src = read(file);
    assert.ok(src.includes('className="fork-tag ') || src.includes('class="fork-tag '), `${file} keeps the class a declared check finds`);
    assert.doesNotMatch(src.slice(src.indexOf('fork-tag')), /^[^\n]*\u2442/m, `${file} draws no ⑂`);
  }
});

test('no screen word says remix, fork or upstream in the catalogs this change touched', () => {
  const ids = [
    'dialogs:fork.title.named', 'dialogs:fork.intro', 'dialogs:fork.nameLabel', 'dialogs:fork.submit',
    'dialogs:fork.follow.title', 'dialogs:fork.follow.sub', 'dialogs:createProgress.title.remixing',
    'agent:appContext.about.remix', 'agent:appContext.about.lineage.remixedFrom',
    'home:menu.remix.label', 'home:grid.tile.remixedFrom',
    'project:menu.remix.title', 'project:menu.button.remix', 'project:menu.suggestBack.title',
    'project:suggestBack.title', 'project:suggestBack.intro', 'project:suggestBack.notSent',
  ];
  for (const id of ids) {
    const said = message(id, { app: 'Tier list', project: 'Tier list', copy: 'Book club picks', count: 2 });
    assert.doesNotMatch(said, /remix|fork|upstream|template/i, `${id}: ${said}`);
  }
});
