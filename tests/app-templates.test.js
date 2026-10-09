'use strict';

// App templates (#3521): a new project starts from Empty, the scaffold every
// project always got, or from one of Homeroom's ready-made apps. The four
// general starters (social productivity, multimedia social, a 2D game and a
// 3D game) were deleted with the create dialog that offered them. What came
// back (Evan, 8 October 2026) are apps finished enough that a project made
// from one needs nothing built: the make screen's eight choices that need no
// typing (frontend/src/features/first-session/examples.ts; the make screen's
// side is tests/first-session-make.test.js). And the four game starters
// (Evan, the same day): working multiplayer games the make screen's game
// presets start from, on one shared game room, which Homeroom bot's first
// version builds the maker's idea on (tests/homeroom-bot-plan.test.js has
// the bot's side).
//
// What is pinned here, without a database (tests/app-templates-postgres
// .test.js runs each one):
//
//   1. THE ALLOW-LIST. POST /api/apps takes `template` from
//      services/app-templates.js's TEMPLATE_IDS and nothing else: `empty`,
//      the eight ready-made apps and the four game starters; absent is
//      `empty`; a deleted starter's id is refused, not swapped.
//   2. EMPTY IS THE DEFAULT. Absent and `empty` write exactly the same
//      files (#4047 dropped the scaffold's Press! demo, so "always got" is
//      the static welcome screen, not the old one).
//   3. A ROW FROM A DELETED STARTER RETRIES AS EMPTY: app-creator reads an
//      id no longer on the list as the default.
//   4. EVERY READY-MADE APP is a whole repository on the platform's
//      conventions and the new app's design kit: its files, the entry's
//      fill escaped where it lands, the bridge, the theme, no CDN, its own
//      declared checks resolving against its own screen.
//   5. EVERY GAME STARTER is a whole repository too, built on the shared
//      game room (app-templates/_game-room) with its own rules and screen,
//      `ws` added to its package.json and lockfile only, and server.js
//      handing it the server for its live connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { parseCreateOptions } = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');
const appManifest = require('../src/services/app-manifest');

const ROOT = path.join(__dirname, '..');
// The app frame's sandbox flags, read from the source the shell builds from.
const APP_FRAME_SANDBOX = /APP_FRAME_SANDBOX =\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/app-frame/app-frame-policy.js'), 'utf8'))[1];
const DELETED = ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];
const READY = [
  'tier-list-restaurants', 'tier-list-hikes', 'tier-list-cities', 'tier-list-games',
  'grocery-list', 'chore-list', 'lending-library', 'potluck-planner',
];
const GAMES = ['game-board', 'game-space', 'game-blocks', 'game-trivia'];

const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

const generate = (id, name = 'Demo App') => getTemplateFiles(name, 'demo-app-abc123', 'postgres://x', null, { template: id });

test('the allow-list: Empty, the default, the eight ready-made apps and the four game starters; a deleted starter is refused', () => {
  assert.deepEqual([...appTemplates.TEMPLATE_IDS], ['empty', ...READY, ...GAMES]);
  assert.deepEqual([...appTemplates.READY_IDS], READY);
  assert.equal(appTemplates.DEFAULT_TEMPLATE, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo' }).template, 'empty', 'absent is Empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: '' }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: null }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'open', template: 'empty' }).template, 'empty');
  for (const id of [...READY, ...GAMES]) assert.equal(parseCreateOptions({ audience: 'invited', template: id }).template, id);
  const refusal = new RegExp(`^template must be one of: ${['empty', ...READY, ...GAMES].join(', ')}$`);
  for (const bad of [...DELETED, 'chess', 'EMPTY', 'tier-list', '../game-2d', 'toString', '__proto__', 42, ['game-2d'], { id: 'game-2d' }]) {
    assert.match(parseCreateOptions({ audience: 'solo', template: bad }).error, refusal, String(bad));
  }
  for (const id of DELETED) assert.equal(appTemplates.get(id), null, id);
  // `tier-list` is a directory four entries share, not an entry of its own.
  assert.equal(appTemplates.isTemplate('tier-list'), false);
  // An import keeps its repository: Empty (or nothing) is fine, a ready-made app is not.
  assert.equal(parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.equal(parseCreateOptions({}, { imported: true }).template, 'empty');
  assert.match(parseCreateOptions({ template: 'grocery-list' }, { imported: true }).error, /cannot start from a template/);
  assert.match(parseCreateOptions({ template: 'game-board' }, { imported: true }).error, /cannot start from a template/);
  // `_game-room` is the directory every game starter shares, not an entry.
  assert.equal(appTemplates.isTemplate('_game-room'), false);
  // The route reads the import flag and the template from the same call.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /createOptions\.parseCreateOptions\(req\.body, \{ imported: !!repoUrl \}\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'),
    /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
  for (const id of appTemplates.TEMPLATE_IDS) assert.ok(id.length <= 40, `${id} fits apps.template`);
});

test('Empty is the scaffold every project always got, byte for byte', () => {
  const plain = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {});
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'empty' }), plain);
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: null }), plain);
  assert.ok(!plain.some((f) => f.path === 'api.js' || f.path === 'public/app.js'));
  const server = file(plain, 'server.js');
  // #4047: the scaffold ships no Press! demo any more — no demo endpoints
  // and no table; the starter screen is static. The server still listens.
  assert.doesNotMatch(server, /\/api\/press|\/api\/leaderboard|presses/);
  assert.match(server, /app\.listen\(port/);
  assert.doesNotMatch(server, /require\('\.\/api'\)/);
  assert.deepEqual(JSON.parse(file(plain, 'dapp.json')), { secrets: [] });
  // #4047: the welcome card opens with the app's thumbnail tile (no sketch,
  // no starter here, so the name's letter falls back the way the home tile
  // does).
  const emptyHtml = file(plain, 'public/index.html');
  assert.match(emptyHtml, /<div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ground text-title"><span class="text-muted">N<\/span><\/div>/);
  assert.doesNotMatch(emptyHtml, /Try the example|What's already working/);
  assert.throws(() => getTemplateFiles('Notes', 'notes', 'pg://x', null, { template: 'chess' }), /Unknown app template: chess/);
});

test('app-creator scaffolds from the row, and a deleted starter\'s row retries as Empty', () => {
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /function templateOf\(row\) \{\s*const t = row\?\.template;\s*return typeof t === 'string' && appTemplates\.isTemplate\(t\) \? t : appTemplates\.DEFAULT_TEMPLATE;/);
  assert.equal((creator.match(/template: templateOf\(appRow\)/g) || []).length, 2, 'both the GitHub and the local path');
  // What templateOf answers for a project made from a starter before they went.
  for (const id of DELETED) assert.equal(appTemplates.isTemplate(id), false, id);
});

test('each ready-made app is a directory of its own files; the four tier lists share one', () => {
  assert.equal(appTemplates.STARTERS_DIR, path.join(ROOT, 'app-templates'));
  assert.deepEqual(appTemplates.starterFiles('empty'), []);
  for (const id of DELETED) assert.deepEqual(appTemplates.starterFiles(id), [], id);
  const dirs = new Set(READY.map((id) => appTemplates.dirOf(id)));
  assert.deepEqual([...dirs].sort(), ['chore-list', 'grocery-list', 'lending-library', 'potluck-planner', 'tier-list']);
  const games = new Set(GAMES.map((id) => appTemplates.dirOf(id)));
  const shared = new Set(GAMES.map((id) => appTemplates.get(id).shared));
  assert.deepEqual([...shared], ['_game-room'], 'every game starter shares one game room');
  assert.deepEqual(fs.readdirSync(appTemplates.STARTERS_DIR).sort(), [...dirs, ...games, ...shared].sort(), 'no directory that no entry uses');
  for (const dir of dirs) {
    for (const rel of appTemplates.REQUIRED_FILES) {
      assert.ok(fs.existsSync(path.join(appTemplates.STARTERS_DIR, dir, rel)), `${dir}/${rel}`);
    }
  }
  for (const id of READY) {
    const t = appTemplates.get(id);
    assert.equal(t.ready, true, id);
    assert.equal(appTemplates.isReadyMade(id), true, id);
    for (const k of ['title', 'summary', 'icon', 'tables']) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.features.length >= 3, `${id} says what it already does`);
  }
  assert.equal(appTemplates.isReadyMade('empty'), false, 'Empty is built by its first version');
  // The tier lists: one app, what it ranks filled in.
  for (const id of READY.slice(0, 4)) {
    const t = appTemplates.get(id);
    assert.equal(t.dir, 'tier-list');
    assert.deepEqual(Object.keys(t.fill).sort(), ['ITEM_EXAMPLE', 'ITEM_ONE', 'ITEM_PLURAL']);
    assert.match(t.fill.ITEM_EXAMPLE, /^e\.g\. /, 'the add field\'s placeholder is an example that says so');
  }
  // The platform's own build never reads the starters.
  for (const f of ['Dockerfile', 'tailwind.config.js', '.dockerignore']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /app-templates/, f);
  }
});

test('a tier list ranks what its entry says, escaped where it lands, and its script reads none of it', () => {
  const hikes = generate('tier-list-hikes');
  const html = file(hikes, 'public/index.html');
  assert.match(html, /Our favorite hikes, ranked together\./);
  assert.match(html, /<label for="add-name" class="section-label mb-0">Add a hike<\/label>/);
  assert.match(html, /placeholder="e\.g\. the lake loop"/);
  assert.match(html, /<p class="text-heading">No hikes yet<\/p>/);
  assert.doesNotMatch(file(generate('tier-list-cities'), 'public/index.html'), /hike/);
  // The fill is the entry's, never the maker's, but it is escaped all the same,
  // like the name.
  const odd = getTemplateFiles('A <b>"Best"</b> & co', 'x', 'postgres://x', null, { template: 'tier-list-games' });
  const oddHtml = file(odd, 'public/index.html');
  assert.match(oddHtml, /<title>A &lt;b&gt;&quot;Best&quot;&lt;\/b&gt; &amp; co<\/title>/);
  assert.doesNotMatch(oddHtml, /<b>"Best"/);
  for (const id of READY) {
    for (const f of generate(id)) assert.doesNotMatch(f.content, /\{\{[A-Z_]+\}\}/, `${id}: ${f.path} has every placeholder filled`);
  }
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  assert.doesNotMatch(script, /\{\{/, 'the script is the same for every tier list');
  // It opens on Yours, so a newcomer can drag straight away; a saved choice
  // of the group's still wins.
  assert.match(html, /<div id="board" class="list" data-view="yours">/);
  assert.match(html, /data-view="yours" aria-checked="true"/);
  assert.match(html, /data-view="group" aria-checked="false"/);
  assert.match(script, /var view = 'yours';\n\s*try \{ if \(localStorage\.getItem\('tier-list:view'\) === 'group'\) view = 'group'; \}/);
  // With nothing added yet, the empty tiers still show under "No hikes yet".
  assert.match(script, /el\.ranking\.hidden = state !== 'ready' && state !== 'empty';/);
  assert.doesNotMatch(script, /if \(!data\.items\.length\) return show\('empty'\)/);
  const board = appTemplates.get('tier-list-hikes').tests.find((c) => c.id === 'tiers.board');
  assert.match(board.expectSelector, /#board\[data-view="yours"\]/, 'the visual check reads the board it opens on');
});

for (const id of READY) {
  test(`the ${id} app is a whole repository on the platform's conventions`, () => {
    const files = generate(id);
    const html = file(files, 'public/index.html');
    const script = file(files, 'public/app.js');
    const api = file(files, 'api.js');
    // The screen: forwarder, precompiled Tailwind, the bridge by relative
    // path, the viewer's theme, its own script last.
    assert.match(html, /usernode-dev-console@1/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/);
    assert.match(html, /window\.usernode && window\.usernode\.theme/);
    assert.match(html, /<script src="\/app\.js"><\/script>\s*<\/body>/);
    assert.match(html, /<title>Demo App<\/title>/);
    assert.match(html, /<h1 class="text-title">Demo App<\/h1>/);
    // No CDN: every script and stylesheet is the app's own or the platform's, by path.
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${id}: ${m[1]} is not fetched from another origin`);
    }
    // A ready-made app is the app: no "started from a template" notice to delete.
    assert.doesNotMatch(html, /usernode-starter-notice@1/);
    // Its script: plain DOM, people's words as text, the platform's token on every call.
    assert.doesNotThrow(() => new vm.Script(script), `${id}: app.js parses`);
    assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    assert.match(script, /var headers = \{ 'x-usernode-token': token \};/);
    assert.match(script, /if \(window\.usernode && window\.usernode\.previewNow\) headers\['x-usernode-now'\] = window\.usernode\.now\(\)\.toISOString\(\);/);
    assert.match(script, /\b\w+\.error === 'account_required'/, 'a guest\'s write is asked to make an account, not shown a code');
    // Homeroom's app frame allows no dialogs (no allow-modals), so confirm()
    // answers false unseen and the action never happens: ask in the page.
    assert.doesNotMatch(APP_FRAME_SANDBOX, /allow-modals/);
    assert.doesNotMatch(script.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(?:confirm|alert|prompt)\(/, `${id}: no browser dialogs`);
    // Its server half: mounted after the sign-in check, tables on boot,
    // staging rows only in staging and owned by fake identities, now from req.now.
    assert.doesNotThrow(() => new vm.Script(`(function (module, require, process) {${api}\n})`), `${id}: api.js parses`);
    assert.match(api, /module\.exports = \{ migrate, routes \};/);
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    assert.match(api, /if \(IS_STAGING\) \{[\s\S]*'staging-demo-user'/);
    assert.match(api, /'Staging demo /, 'seeded rows say so');
    assert.doesNotMatch(api.replace(/\/\/.*$/gm, ''), /new Date\(\)/, 'now is req.now, not the server clock');
    assert.doesNotMatch(api, /err\.message \}\)/, 'a failure is logged, not sent to the screen');
    const server = file(files, 'server.js');
    assert.ok(server.indexOf("const api = require('./api');") > server.indexOf('app.use((req, res, next) => {'), 'after the sign-in check');
    assert.match(server, /await api\.migrate\(pool\);/);
    assert.match(server, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\);/);
    // Its manifest: the entry's icon and checks; its README and notes say what it is.
    const t = appTemplates.get(id);
    const manifest = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(manifest.icon, { emoji: t.icon });
    assert.deepEqual(manifest.tests, JSON.parse(JSON.stringify(t.tests)));
    const readme = file(files, 'README.md');
    assert.match(readme, new RegExp(`ready-made\\s+> \\*\\*${t.title}\\*\\*`));
    for (const f of t.features) assert.ok(readme.includes(`- ${f}`), `${id}: README lists "${f.slice(0, 30)}"`);
    const claude = file(files, 'CLAUDE.md').replace(/\s+/g, ' ');
    assert.match(claude, new RegExp(`created from Homeroom's ready-made \\*\\*${t.title}\\*\\*`));
    assert.ok(claude.includes(`(${t.tables})`), `${id}: its tables are named`);
    // No em dashes in what the app says or what its notes say about it.
    for (const f of appTemplates.starterFiles(id)) assert.doesNotMatch(f.content, /\u2014/, `${id}: ${f.path}`);
    assert.doesNotMatch(JSON.stringify(t), /\u2014/);
  });

  test(`the ${id} app is drawn with the design kit only`, () => {
    const own = appTemplates.starterFiles(id).filter((f) => /^public\//.test(f.path));
    const src = own.map((f) => f.content.replace(/<!--[\s\S]*?-->/g, '')).join('\n');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?!['"]?\))/, 'no raw hex colour');
    const stock = /(?<![\w:/-])(?:[a-z]+:)*(?:bg|text|border|ring|divide|from|via|to|accent|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    assert.deepEqual([...src.matchAll(stock)].map((m) => m[0]), [], 'colour comes from the kit\'s tokens, never a stock palette class');
    assert.doesNotMatch(src, /\bdark:/, 'the tokens carry both looks');
    assert.doesNotMatch(src, /\buppercase\b|\btracking-/, 'no uppercase eyebrows');
    assert.match(src, /class="min-h-screen bg-ground text-fg"/);
    // Honest states: loading shapes, an error with Retry, an empty state.
    assert.match(src, /class="skeleton /);
    assert.match(src, /class="state-error card"[\s\S]*?>Retry<\/button>/);
    assert.match(src, /class="state-empty card"/);
  });

  test(`the ${id} app's declared checks are valid and select its own screen`, () => {
    const t = appTemplates.get(id);
    const parsed = appManifest.readTests({ tests: t.tests });
    assert.equal(parsed.length, t.tests.length, 'every check survives the manifest\'s own validation');
    const visual = parsed.filter((c) => c.visual);
    assert.equal(visual.length, 1, 'one visual flow its first proposals are compared on');
    assert.ok(visual[0].impact.length, 'with the files that change it');
    const own = appTemplates.starterFiles(id);
    const src = own.filter((f) => /^public\//.test(f.path)).map((f) => f.content).join('\n');
    for (const c of parsed) {
      for (const [, name] of c.expectSelector.matchAll(/#([\w-]+)/g)) assert.match(src, new RegExp(`id="${name}"|'${name}'`), `${id}: #${name}`);
      for (const [, attr] of c.expectSelector.matchAll(/\[(data-[\w-]+)/g)) assert.ok(src.includes(attr), `${id}: [${attr}]`);
    }
    // Each is reached on a staging preview through seeded rows: the API
    // seeds ids the screen draws.
    assert.match(own.find((f) => f.path === 'api.js').content, /VALUES\s*\(900001,/);
  });
}

// ── The game starters ────────────────────────────────────────────────────

test('the game starters: not ready-made, built on the shared game room, and told to Homeroom bot', () => {
  const extra = require('../src/templates/node-app/extra-packages.json');
  for (const id of GAMES) {
    const t = appTemplates.get(id);
    assert.equal(t.kind, 'game', id);
    assert.equal(appTemplates.isReadyMade(id), false, `${id}: Homeroom bot still builds its first version`);
    assert.equal(appTemplates.botStarter(id), t, `${id}: the bot is told what it builds on`);
    assert.equal(t.shared, '_game-room');
    assert.deepEqual([...t.dependencies], ['ws']);
    for (const dep of t.dependencies) assert.ok(extra[dep] && extra[dep].packages[`node_modules/${dep}`], `${dep} is locked`);
    for (const k of ['title', 'summary', 'icon']) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.features.length >= 3, `${id} says what it already does`);
    assert.ok(t.bot.what && t.bot.build, `${id}: what it is, and what to keep`);
    assert.doesNotMatch(JSON.stringify(t), /—/, `${id}: no em dashes`);
  }
  for (const id of ['empty', ...READY, 'nope']) assert.equal(appTemplates.botStarter(id), null, id);
  // `ws` comes only with a game: every other app's package and lockfile
  // are the template's, untouched.
  const plain = generate('empty');
  for (const id of ['empty', ...READY]) {
    const files = generate(id);
    assert.equal(file(files, 'package.json'), file(plain, 'package.json'), id);
    assert.doesNotMatch(file(files, 'package-lock.json'), /node_modules\/ws/, id);
  }
});

for (const id of GAMES) {
  test(`the ${id} game starter is a whole repository on the platform's conventions`, () => {
    const t = appTemplates.get(id);
    const files = generate(id);
    for (const p of ['api.js', 'game/room.js', 'game/live.js', 'game/rules.js', 'public/index.html', 'public/app.js', 'public/game/room.js']) file(files, p);
    const html = file(files, 'public/index.html');
    assert.match(html, /usernode-dev-console@1/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/);
    assert.match(html, /window\.usernode && window\.usernode\.theme/);
    assert.match(html, /<script src="\/game\/room\.js"><\/script>\s*<script (?:type="module" )?src="\/app\.js"><\/script>\s*<\/body>/,
      'the game room\'s page side, then the game');
    // A title screen with the game's name, and the game's own scene,
    // styled after the kit (public/scene.css).
    assert.match(html, /<h1 class="[^"]*">Demo App<\/h1>/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">\s*<link rel="stylesheet" href="\/scene\.css">/);
    assert.match(file(files, 'public/scene.css'), /CLAUDE\.md "## Design"/, 'the scene says where its look is written down');
    assert.match(html, /id="title"[^>]*>/, 'a title screen');
    assert.match(html, /id="stage"[^>]*class="[^"]*\bfixed inset-0\b/, 'the game fills the screen');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${id}: ${m[1]} is not fetched from another origin`);
    }
    assert.doesNotMatch(html, /usernode-starter-notice@1/);
    // Honest states: loading shapes, an error with Retry, an empty state.
    assert.match(html, /class="skeleton /);
    assert.match(html, /class="state-error[^"]*"[\s\S]*?>Retry<\/button>/);
    assert.match(html, /class="state-empty[^"]*"/);
    assert.match(html, /<body class="min-h-screen bg-ground text-fg">/);
    // Its scripts: plain DOM, people's words as text, no browser dialogs.
    for (const p of ['public/app.js', 'public/game/room.js']) {
      const js = file(files, p);
      // The 3D starter's screen is an ES module: its import is the only module syntax.
      assert.doesNotThrow(() => new vm.Script(js.replace(/^import .*$/m, '')), `${id} ${p} parses`);
      assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, `${id} ${p}`);
      assert.doesNotMatch(js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(?:confirm|alert|prompt)\(/, `${id} ${p}: no browser dialogs`);
    }
    const room = file(files, 'public/game/room.js');
    assert.match(room, /var headers = \{ 'x-usernode-token': token \};/);
    assert.match(room, /\b\w+\.error === 'account_required'/, 'a guest\'s move is asked to make an account');
    assert.match(room, /usernode:visibility-changed/, 'quiet while Homeroom keeps it loaded but hidden');
    // Content rules: nothing on screen is a weapon, combat or gambling.
    const screen = files.filter((f) => /^public\//.test(f.path) && !/^public\/vendor\//.test(f.path)).map((f) => f.content).join('\n');
    assert.doesNotMatch(screen, /\b(?:guns?|weapons?|shoot(?:ing)?|bullets?|kill|enem(?:y|ies)|bombs?|explo(?:de|sion)|bet|wager|casino)\b/i, `${id}: content rules`);
    // Its server half: the room on boot, the live connection on the server.
    const api = file(files, 'api.js');
    assert.doesNotThrow(() => new vm.Script(`(function (module, require, process) {${api}\n})`), `${id}: api.js parses`);
    assert.match(api, /module\.exports = \{ migrate, routes, attach \};/);
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    assert.match(api, /if \(IS_STAGING\) \{[\s\S]*?await room\.seed\(pool, \{/, 'staging rows, only in staging');
    for (const [, who] of api.matchAll(/username: '([^']+)'/g)) assert.match(who, /^staging-demo-/, `${id}: ${who} is obviously fake`);
    assert.match(api, /await room\.migrate\(pool\);[\s\S]*await room\.load\(pool\);/);
    assert.doesNotMatch(api.replace(/\/\/.*$/gm, ''), /new Date\(\)/);
    const server = file(files, 'server.js');
    assert.match(server, /const live = typeof api\.attach === 'function' \? api\.attach\(server\) : null;/);
    assert.match(server, /if \(live && typeof live\.close === 'function'\) live\.close\(\);/, 'its sockets close on SIGTERM');
    // `ws`, in both package.json and the lockfile `npm ci` installs from.
    const extra = require('../src/templates/node-app/extra-packages.json');
    const pkg = JSON.parse(file(files, 'package.json'));
    const lock = JSON.parse(file(files, 'package-lock.json'));
    assert.equal(pkg.dependencies.ws, extra.ws.range);
    assert.equal(lock.packages[''].dependencies.ws, extra.ws.range);
    assert.deepEqual(lock.packages['node_modules/ws'], extra.ws.packages['node_modules/ws']);
    assert.equal(lock.packages[''].name, 'demo-app-abc123');
    assert.deepEqual(Object.keys(lock.packages)[0], '', 'the root package first, as npm writes it');
    // Its manifest, README and notes.
    const manifest = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(manifest.icon, { emoji: t.icon });
    assert.deepEqual(manifest.tests, JSON.parse(JSON.stringify(t.tests)));
    const readme = file(files, 'README.md');
    assert.match(readme, /> \*\*Game starter\.\*\* This repo was scaffolded by Homeroom from its/);
    for (const f of t.features) assert.ok(readme.includes(`- ${f}`), `${id}: README lists "${f.slice(0, 30)}"`);
    const claude = file(files, 'CLAUDE.md');
    assert.match(claude, new RegExp(`## Starter template: ${t.title}`));
    assert.match(claude, /Never delete the game room\s+layer to start over/);
    assert.match(claude, /`game\/rules\.js`: this game's rules/);
    assert.doesNotMatch(claude, /ready-made \*\*/, 'a game starter is not a ready-made app');
    // No em dashes anywhere the app says something (the vendored library aside).
    for (const f of appTemplates.starterFiles(id)) {
      if (!/^public\/vendor\/.*\.js$/.test(f.path)) assert.doesNotMatch(f.content, /—/, `${id}: ${f.path}`);
    }
  });

  test(`the ${id} game starter's declared checks are valid and select its own screen`, () => {
    const t = appTemplates.get(id);
    const parsed = appManifest.readTests({ tests: t.tests });
    assert.equal(parsed.length, t.tests.length);
    const visual = parsed.filter((c) => c.visual);
    assert.equal(visual.length, 1, 'one visual flow');
    assert.deepEqual(visual[0].impact, ['public/**', 'api.js', 'game/**']);
    const src = appTemplates.starterFiles(id).filter((f) => /^public\/.*\.(?:html|js)$/.test(f.path) && !/^public\/vendor\//.test(f.path))
      .map((f) => f.content).join('\n');
    for (const c of parsed) {
      for (const [, name] of c.expectSelector.matchAll(/#([\w-]+)/g)) assert.match(src, new RegExp(`id="${name}"|'${name}'`), `${id}: #${name}`);
      for (const [, attr] of c.expectSelector.matchAll(/\[(data-[\w-]+)/g)) assert.ok(src.includes(attr), `${id}: [${attr}]`);
    }
  });
}

test('the 3D blocks starter carries three.js itself, copied exactly, and never from a CDN', () => {
  const files = appTemplates.starterFiles('game-blocks');
  const three = file(files, 'public/vendor/three.module.min.js');
  const onDisk = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'game-blocks/public/vendor/three.module.min.js'), 'utf8');
  assert.equal(three, onDisk, 'never touched by placeholder filling');
  assert.match(three.slice(0, 200), /@license[\s\S]*Three\.js Authors[\s\S]*MIT/);
  assert.match(three, /REVISION|"186"/);
  assert.ok(three.length < 800 * 1024, 'one minified module');
  assert.match(file(files, 'public/vendor/README.md'), /three\.js\]\(https:\/\/threejs\.org\) 0\.186\.1/);
  assert.match(file(files, 'public/app.js'), /^import \* as THREE from '\.\/vendor\/three\.module\.min\.js';$/m);
});

// ── Each game's rules, as plain functions ────────────────────────────────

const rulesOf = (dir) => require(path.join(appTemplates.STARTERS_DIR, dir, 'game/rules.js'));
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('the board game: turns, a six rolls again, shortcuts and slides, a roll made for somebody away', () => {
  const r = rulesOf('game-board');
  const players = [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }];
  let g = r.setup({ players, now: 0 });
  const ctx = (id, roll, now = 0, here = true) => ({ player: { id }, now, random: () => (roll - 1) / 6 + 0.01, isOnline: () => here });
  assert.equal(r.act(g, { type: 'roll' }, ctx(2, 3)).error, 'It is not your turn yet.');
  g = r.act(g, { type: 'roll' }, ctx(1, 6)).game;
  assert.deepEqual([g.pieces[1].pos, g.turn], [6, 0], 'a six rolls again');
  g = r.act(g, { type: 'roll' }, ctx(1, 2)).game;
  assert.deepEqual([g.pieces[1].pos, g.lastMove.landed, g.turn], [20, 8, 1], 'square 8 is a shortcut to 20');
  g = r.act(g, { type: 'roll' }, ctx(2, 3)).game;
  assert.equal(g.pieces[2].pos, 15, 'square 3 is a shortcut to 15');
  g = r.act(g, { type: 'roll' }, ctx(1, 3)).game;
  assert.deepEqual([g.pieces[1].pos, g.lastMove.landed], [11, 23], 'square 23 is a slide to 11');
  // Away: their roll is made for them after a moment, never before.
  assert.equal(r.update(g, { now: 1000, random: () => 0.1, isOnline: () => false }), null);
  const auto = r.update(g, { now: 3000, random: () => 0.1, isOnline: () => false });
  assert.match(auto.log[0].text, /^@ben rolled 1 \(rolled for them\)/);
  // Reaching the finish wins: the winner first, then by how far they got.
  g.pieces[1].pos = 27;
  g.turn = 0;
  g = r.act(g, { type: 'roll' }, ctx(1, 5)).game;
  assert.deepEqual(r.result(g).map((x) => [x.username, x.place]), [['ana', 1], ['ben', 2]]);
  assert.equal(r.act(g, { type: 'roll' }, ctx(2, 1)).error, 'This game is over.');
  // Leaving mid-game: their turn passes on.
  let h = r.setup({ players, now: 0 });
  h = r.removePlayer(h, 1, { now: 5 });
  assert.deepEqual([h.order, h.turn, h.turnAt], [[2], 0, 5]);
});

test('trivia: the author never answers or sees the answer early; quick and known answers score', () => {
  const r = rulesOf('game-trivia');
  const bank = [{ id: 1, authorId: 2, author: 'ben', text: 'My pet?', answer: 'Cat', wrong: ['Dog', 'Fish'] }];
  assert.match(r.setup({ players: [{ id: 2, username: 'ben' }], random: Math.random, now: 0, extra: bank }).error, /about you/);
  assert.match(r.setup({ players: [{ id: 1, username: 'ana' }], random: Math.random, now: 0, extra: [] }).error, /Write a question/);
  let g = r.setup({ players: [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }], random: seq(0.1, 0.9, 0.5), now: 0, extra: bank });
  const v = r.view(g, 1);
  assert.equal(v.question.correct, null, 'no answer before it shows');
  assert.equal(v.picks, null);
  const at = (id, now) => ({ player: { id }, now, random: Math.random, isOnline: () => true });
  assert.match(r.act(g, { type: 'answer', choice: 0 }, at(2, 100)).error, /about you/);
  const right = g.questions[0].correct;
  g = r.act(g, { type: 'answer', choice: right }, at(1, 10000)).game;
  assert.equal(g.stage, 'reveal', 'everyone here answered: no waiting out the clock');
  assert.deepEqual(g.points, { 1: 100 + 25, 2: 25 }, 'half the clock left: 25 for speed; the author 25 for being known');
  assert.equal(r.view(g, 1).question.correct, right);
  assert.equal(r.update(g, { now: 10001 }), null, 'the answer shows for a while');
  g = r.update(g, { now: 20000 });
  assert.equal(g.done, true);
  assert.deepEqual(r.result(g).map((x) => [x.username, x.score, x.place]), [['ana', 125, 1], ['ben', 25, 2]]);
});

test('the space game: storms of sparks made of numbers, stardust to collect, a hit costs a shield, out of shields the ship is out', () => {
  const r = rulesOf('game-space');
  const players = [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }];
  let g = r.setup({ players, now: 0 });
  const random = seq(0.5, 0.2, 0.8, 0.35);
  const fly = (to) => {
    for (let t = g.now + 50; t <= to; t += 50) {
      for (const ship of Object.values(g.ships)) ship.seenAt = t;
      g = r.tick(g, 50, { now: t, random });
    }
  };
  fly(4000);
  // A storm: a pulsar that drifts in from above and throws sparks in a
  // pattern. The frame carries its numbers, not a position for each spark.
  assert.equal(g.storms.length, 1, 'one storm at a time in the first sector');
  const s = g.storms[0];
  assert.equal(s.kind, 'ring', 'the first sector\'s storms are rings');
  assert.equal(r.pulsarAt(s, s.t0).y, -60, 'from above the field');
  assert.equal(r.pulsarAt(s, s.t0 + s.enter).y, s.ys);
  const f = r.frame(g);
  assert.deepEqual(Object.keys(f.storms[0]).filter((k) => ['interval', 'n', 'rot', 'spread', 'v', 'curve', 'a0'].includes(k)).length, 7);
  assert.ok(f.dust.length >= 2, 'stardust drifts down');
  assert.ok(g.ships[1].score > 0, 'time flown scores');
  // Later sectors bring more storms, and fans aimed at the nearest ship.
  fly(95000);
  assert.equal(g.sector, 4);
  assert.ok(g.bursts.some((b) => b.colour === 4), 'comet showers');
  // A ship's own page says where it is, within the speed limit.
  const was = { x: g.ships[1].x, y: g.ships[1].y };
  g = r.input(g, { id: 1 }, { x: was.x + 900, y: was.y }, { now: g.now });
  assert.deepEqual([g.ships[1].x, g.ships[1].y], [was.x, was.y], 'a jump is not believed');
  g = r.input(g, { id: 1 }, { x: was.x + 20, y: was.y - 10 }, { now: g.now + 50 });
  assert.deepEqual([g.ships[1].x, g.ships[1].y], [was.x + 20, was.y - 10]);
  // Stardust close to your ship is yours, once; far away, it is not.
  const d = g.dust[g.dust.length - 1];
  const at = r.dustAt(d, g.now);
  g.ships[2].x = at.x + 400;
  g.ships[2].y = at.y;
  assert.equal(r.act(g, { type: 'collect', id: d.id }, { player: { id: 2 }, now: g.now }).event, undefined, 'too far');
  g.ships[2].x = at.x + 20;
  const got = r.act(g, { type: 'collect', id: d.id }, { player: { id: 2 }, now: g.now });
  assert.deepEqual([got.event, got.game.ships[2].dust], [{ type: 'dust', id: d.id, by: 2 }, 1]);
  assert.equal(r.act(got.game, { type: 'collect', id: d.id }, { player: { id: 1 }, now: g.now }).event, undefined, 'gone');
  // A hit costs a shield, then a moment of cover; out of shields, the ship is out.
  let now = g.now;
  let out = r.act(g, { type: 'hit' }, { player: { id: 1 }, now });
  assert.deepEqual(out.event, { type: 'hit', id: 1, shields: 2 });
  assert.equal(r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: now + 100 }).game.ships[1].shields, 2, 'covered');
  out = r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: (now += 2500) });
  out = r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: (now += 2500) });
  assert.deepEqual([out.game.ships[1].shields, out.game.ships[1].out, out.game.over], [0, true, false], 'the others fly on');
  assert.match(r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now }).error, /out of this run/);
  assert.match(r.act(out.game, { type: 'fire' }, { player: { id: 2 }, now }).error, /not a move/);
  // The run ends when every ship is out: each pilot's own score, highest first.
  g = r.removePlayer(out.game, 2);
  assert.equal(g.over, true);
  const res = r.result(g);
  assert.deepEqual(res.map((x) => x.place), [1, 2]);
  assert.ok(res[0].score >= res[1].score);
  assert.deepEqual(res.map((x) => x.username).sort(), ['ana', 'ben']);
});

test('the block world: blocks inside the world, one per cell, sent to everyone as an event', () => {
  const r = rulesOf('game-blocks');
  let g = r.setup();
  const me = { player: { id: 1, username: 'ana' } };
  const out = r.act(g, { type: 'place', x: 1, y: 0, z: 2, c: 3 }, me);
  assert.deepEqual(out.event, { type: 'place', x: 1, y: 0, z: 2, c: 3, by: 'ana' });
  g = out.game;
  assert.match(r.act(g, { type: 'place', x: 1, y: 0, z: 2, c: 1 }, me).error, /already/);
  assert.match(r.act(g, { type: 'place', x: r.SIZE.x, y: 0, z: 0, c: 1 }, me).error, /outside/);
  assert.match(r.act(g, { type: 'place', x: 0, y: 0, z: 0, c: r.BLOCKS }, me).error, /Pick a block/);
  assert.match(r.act(g, { type: 'remove', x: 9, y: 9, z: 9 }, me).error, /no block/);
  assert.deepEqual(r.view(g).blocks, [[1, 0, 2, 3]]);
  g = r.act(g, { type: 'remove', x: 1, y: 0, z: 2 }, me).game;
  assert.equal(g.count, 0);
  // Where each builder is flying, which way they face, and their block.
  g = r.input(g, { id: 1, username: 'ana' }, { x: 3.04, y: 6.5, z: -4.2, yaw: 1.234, c: 2 }, { now: Date.now() });
  assert.deepEqual(r.frame(g).builders, [[1, 'ana', 3, 6.5, -4.2, 1.23, 2]]);
  assert.deepEqual(r.view(g).builders, r.frame(g).builders, 'a plain request sees them too');
  g = r.input(g, { id: 1, username: 'ana' }, { x: 500, y: 1, z: 1 }, { now: Date.now() });
  assert.deepEqual(r.frame(g).builders, [], 'nobody is far outside the world');
  assert.equal(r.open, true, 'always on: no lobby');
  assert.equal(r.result(g), null, 'never over');
});
