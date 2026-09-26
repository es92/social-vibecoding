const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cardHtml } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function appView(user = { id: 42 }) {
  const context = { console, App: { user }, relTime: () => 'just now',
    document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/app-view.js', 'utf8') + '\n;globalThis.av = AppView;', context);
  return context.av;
}

const failing = { id: 123, user_id: 42, status: 'active', check_state: 'failing',
  session_title: 'Underway fix', linked_issues: [],
  failing_checks: { total: 1, rows: [{ name: 'Open settings', reason: 'Button missing' }] },
  test_results: [{ name: 'Open settings', path: '/settings', status: 'fail',
    failureReason: 'Button missing', consoleErrors: [{ message: 'Settings crashed' }] }] };

function menu(av, card) { return av._cardMenus[card.rail.menuKey] || []; }

for (const status of ['active', 'paused']) {
  test(`${status} own card renders failure reason and provides inspection and rerun`, () => {
    const av = appView();
    const card = av._mySessionCardModel({ ...failing, status });
    const html = cardHtml(card);
    assert.match(html, /title="Open settings — Button missing"/);
    const items = menu(av, card);
    assert.ok(items.some((r) => r.label === 'View checks'));
    assert.ok(items.some((r) => r.label === 'Re-run checks'));
    let opened;
    av.openSessionChecks = (id) => { opened = id; };
    items.find((r) => r.label === 'View checks').act();
    assert.equal(opened, failing.id);
  });
}

test('shared cards and their topic headers allow inspection, with rerun only for write admins', () => {
  for (const user of [{ id: 99 }, { id: 99, isAdmin: true }, { id: 99, isAdmin: true, canAdminWrite: true }]) {
    for (const noNav of [false, true]) {
      const av = appView(user);
      const items = menu(av, av._sharedSessionCardModel({ ...failing, status: 'paused' }, { noNav }));
      assert.ok(items.some((r) => r.label === 'View checks'));
      assert.equal(items.some((r) => r.label === 'Re-run checks'), !!user.canAdminWrite);
    }
  }
});

test('passing, closed, read-only and in-flight cards cannot offer a duplicate rerun', () => {
  const av = appView();
  const paused = { ...failing, status: 'paused' };
  for (const check_state of ['failing', 'error', 'pending']) {
    const action = av._recheckAction({ ...paused, check_state });
    assert.equal(action.label, 'Re-run checks');
    assert.equal(action.act.fn, 'castRecheck');
    assert.equal(action.act.args[0], failing.id);
  }
  for (const patch of [{ check_state: null }, { check_state: 'passing' }, { status: 'archived' }, { status: 'merged' }]) {
    assert.equal(av._recheckAction({ ...paused, ...patch }), null);
  }
  av.appData = { can_collaborate: false };
  assert.equal(av._recheckAction(paused), null);
  av.appData = { can_collaborate: true };
  av._recheckInFlight.add(failing.id);
  assert.equal(av._recheckAction(paused).disabled, true);
  assert.ok(!menu(av, av._mySessionCardModel(paused)).some((r) => r.label === 'Re-run checks'));
});

test('results render paths, reasons and console errors as visible escaped text', () => {
  const previous = global.window;
  global.window = { AppView: appView() };
  try {
    const { SessionCheckResults } = loadTsx('tests/fixtures/dev-card-api.ts');
    const html = renderToHtml(createElement(SessionCheckResults, { session: {
      ...failing, test_results: [...failing.test_results,
        { name: '<script>bad</script>', status: 'fail', advisory: true, failureReason: 'Advisory detail' },
        { name: 'Retry check', status: 'pass', runs: 2, fails: 1, passedOnRetry: true, failureReason: 'Transient' }],
    } }));
    for (const text of ['Open settings', '/settings', 'Button missing', 'Settings crashed', 'Advisory detail', 'then passed when re-run']) assert.ok(html.includes(text), text);
    assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
  } finally { global.window = previous; }
});

// #3180: "skipped" is never a bare word. The panel prints why as text, not
// only in the status pill's tooltip that a touch screen cannot open, and a
// row that recorded no reason reads the fallback line.
test('a skipped run says why in the panel, with or without a recorded reason', () => {
  const previous = global.window;
  global.window = { AppView: appView() };
  try {
    const { SessionCheckResults } = loadTsx('tests/fixtures/dev-card-api.ts');
    const skipped = { id: 124, user_id: 42, status: 'active', check_state: 'skipped', test_results: [] };
    const render = (session) => renderToHtml(createElement(SessionCheckResults, { session }));
    const withReason = render({ ...skipped, check_error_detail: 'branch has no commits beyond main, so there is nothing to test' });
    assert.match(withReason, /data-note="checks"[\s\S]*Checks skipped\.[\s\S]*Automated checks were skipped: branch has no commits beyond main, so there is nothing to test\. This does not block the merge\./);
    assert.equal(withReason.split('branch has no commits beyond main').length, 2, 'said once, not repeated under the note');
    assert.doesNotMatch(withReason, /No check results have been recorded yet/);
    for (const check_error_detail of [null, undefined, '']) {
      const bare = render({ ...skipped, check_error_detail });
      assert.match(bare, /Checks skipped\.[\s\S]*Automated checks were skipped: there was nothing to test\. This does not block the merge\./);
    }
  } finally { global.window = previous; }
});
