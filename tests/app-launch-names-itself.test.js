// Opening an app from Home shows the app you tapped from the first frame
// (polish board #9, 19 Oct 2026). Recorded on an iPhone, the zooming card
// showed a blank white icon tile, the header read "Homeroom" with a blank
// circle, and only then did the icon and the name arrive.
//
//   1. The cover's icon is one `{ __html }` object for as long as its markup
//      is the same (useInnerHtml), so a store write during the launch (the
//      src, the spinner at LAUNCH_SPINNER_MS) no longer rebuilds its <img>;
//      in a Chrome trace the tile's <img> was rebuilt four times per launch.
//   2. The cover's <img> is not lazy: it is on screen from the first frame,
//      inside a scaled card, and it is the image the tile just showed.
//   3. The header says the app's name and icon from the launcher's record
//      as the route commits, before GET /api/apps/:slug answers.
//
// Run with: node --test tests/app-launch-names-itself.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the launch cover keeps its icon node across renders', () => {
  const src = read('frontend/src/features/app-frame/app-frame.tsx');
  const cover = src.slice(src.indexOf('function LaunchCover('), src.indexOf('const AppFrame = memo('));
  assert.match(cover, /const icon = useInnerHtml\(iconHtml\);/);
  assert.match(cover, /dangerouslySetInnerHTML=\{icon\}/);
  assert.doesNotMatch(cover, /dangerouslySetInnerHTML=\{\{/, 'no wrapper made fresh on each render');
  assert.match(src, /import \{ useInnerHtml \} from '\.\.\/\.\.\/lib\/html';/);
});

test('the cover\'s icon image loads with the frame, not lazily', () => {
  const src = read('public/js/app-view.js');
  const descriptor = src.slice(src.indexOf('  _coverDescriptor(record) {'), src.indexOf('  _launchCoverHtml(record'));
  assert.match(descriptor, /iconHtml: tile\.kind === 'image'\s*\? tile\.html\.replace\(' loading="lazy"', ' decoding="sync"'\)\s*: tile\.html,/);
  // The tile helper it rewrites still says lazy, for the grids that want it.
  assert.match(read('frontend/src/features/apps/app-card.js'), /<img src="\$\{escapeHtml\(app\.icon_url\)\}" alt="" loading="lazy" draggable="false"/);
});

test('the header names the app being opened from the launcher\'s record', () => {
  const app = read('public/js/app.js');
  const nav = app.slice(app.indexOf('  async navigateToApp('), app.indexOf('\n  navigateHome(opts) {'));
  const at = nav.indexOf("if (initialRoute.tab === 'app') {\n        let named = null;");
  assert.ok(at > 0, 'the App tab names it');
  assert.ok(at > nav.indexOf('PlatformUI.transition('), 'as the view is revealed, inside the transition (#979)');
  assert.ok(at < nav.indexOf('AppView.beginLaunch(slug, tab)'), 'in the same callback, before the frame mounts');
  assert.ok(at < nav.indexOf('await'), 'before anything is awaited: in the tap\'s own task');
  // With no launcher row, the name the device remembers (offline, finding 7;
  // tests/nav-parked-app.test.js drives it).
  assert.match(nav, /try \{ named = AppView\.launchRecordFor\?\.\(slug\) \|\| App\._rememberedAppRecord\(slug\); \} catch \(_\) \{ named = null; \}\s*if \(named && named\.name && !named\.self_hosted\) \{\s*App\.setHeaderTitle\(named\.name\);\s*App\.ImproveStatus\.setPendingApp\(named\);\s*\}/);
  assert.match(app, /setPendingApp\(record\) \{ window\.ImproveStatus\?\.setPendingApp\?\.\(record\); \},/);
});

test('a pending app publishes only its name and icon, and only for the app being opened', () => {
  const targets = [];
  const sandbox = {
    console,
    App: { currentApp: 'todo-b91765' },
    Improve: { setTarget: (t) => targets.push(JSON.parse(JSON.stringify(t))) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = read('frontend/src/features/improve/improve-status.js')
    .replace(/^export \{[^}]*\};?\s*$/m, '')
    .replace(/^import [^\n]*\n/gm, '');
  vm.runInContext(src, sandbox);
  const status = sandbox.ImproveStatus;
  const rec = {
    slug: 'todo-b91765', name: 'Todo List', icon_url: '/app-icons/abc', icon_emoji: null, icon_color: '#2a63c6',
    url: 'https://todo.example', status: 'running', repo_url: 'https://github.com/x/todo', can_report: true,
  };
  status.setPendingApp(rec);
  assert.deepEqual(targets, [{
    kind: 'app', slug: 'todo-b91765', name: 'Todo List', iconUrl: '/app-icons/abc', iconEmoji: null, iconColor: '#2a63c6',
  }], 'nothing it offers (share, repo, report) until the read confirms it');
  status.setPendingApp({ ...rec, slug: 'another-app' });
  status.setPendingApp({ ...rec, self_hosted: true });
  status.setPendingApp(null);
  assert.equal(targets.length, 1, 'never another app, never the platform\'s own row');
});
