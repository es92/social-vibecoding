// /app/<slug>/board and /app/<slug>/workshop are clean names for the existing
// dev vocabulary, not new screens — and they are aliases onto the SAME one:
// both resolve to the forum card area, and what tells them apart is the
// layout it is drawn in. Board is the kanban of work in flight; the Workshop
// is the same cards grouped by theme. /app/<slug>/activity, the retired
// Activity feed's address, lands on the Workshop.
//
// That is a change of meaning for `activity`, which named the app's general
// chat for one round. The chat keeps `dev/chat`, the address it always had.
// The reason is recorded in public/js/app.js's own alias block: Kanban and
// Feed were the Improve panel's sub-strip under the Board row, and a display
// preference that changes what the screen is CALLED is a destination — so the
// layout rides the hash and the sub-strip is retired.
//
// Static-assertion style (cf. tests/hash-route-idempotence.test.js): the
// behaviour itself is covered by declared dapp.json checks on both hashes;
// what must not regress meanwhile is that old `dev` / `dev/chat` links and the
// two aliases resolve to the states they name.
//
// Run with: node --test tests/streamlined-route-aliases.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const body = (start, len = 2400) => {
  const from = appJs.indexOf(start);
  assert.ok(from > -1, `${start} exists`);
  return appJs.slice(from, from + len);
};

test('restoreFromHash rewrites the aliases onto the dev vocabulary', () => {
  // Wide enough to reach the `board` branch, which sits last of the three and
  // grew when it became an alias rather than a layout of its own.
  const fn = body("if (parts[0] === 'app' && parts[1]) {", 4400);
  // Both aliases are the CARD AREA — `parts[3] = null`, the forum — and each
  // carries the layout the destination is named for.
  assert.match(fn, /tab === 'workshop' \|\| tab === 'activity'.*parts\[3\] = null; boardView = 'workshop'/s,
    'workshop (and the retired activity) parse as the card area, drawn as the Workshop');
  // `board` is an ALIAS now: the Board view mode retired, so the address
  // resolves onto the Workshop and asks for the pane that draws those columns.
  assert.match(fn, /tab === 'board'.*parts\[3\] = null; boardView = 'workshop'/s,
    'board parses as the card area, drawn as the Workshop');
  assert.match(fn, /tab === 'board'[\s\S]*_overrideWorkshopGroup\('stage'\)/,
    'and selects the stage pane, which is where the board\'s columns live');
  // Both rewrites must land BEFORE the dev-section switch reads parts[3],
  // or the aliases would fall through to the plain App tab.
  assert.ok(
    fn.indexOf("tab === 'workshop'") < fn.indexOf("const sec = parts[3]"),
    'the rewrites precede the dev-section parse');
});

test('the route applies the layout, and re-renders when only the layout moved', () => {
  const fn = body("if (parts[0] === 'app' && parts[1]) {", 9200);
  // Set BEFORE the dispatch, so a cold entry paints the named layout on the
  // board's first frame instead of flashing the stored one.
  assert.match(fn, /AppView\._setViewMode\(boardView\)/,
    'the resolved layout is published to the module');
  assert.ok(
    fn.indexOf('AppView._setViewMode(boardView)') < fn.indexOf('App.navigateToApp('),
    'and published before the dispatch that renders the board');
  // Board ⇄ Activity leaves `tab` and `subTab` identical, so without this the
  // guarded re-dispatch below would decide nothing had changed and the switch
  // would silently do nothing.
  assert.match(fn, /AppView\._getViewMode\(\) !== boardView/,
    'the change is detected against the mode already resolved');
  assert.match(fn, /\|\| boardViewChanged\) \{/,
    'and forces the re-render the tab/sub-tab comparison would skip');
});

test('the clean serializer names the card area for the layout it is drawn in', () => {
  const fn = body('_appUrl(slug, tab, ref, subTab, options) {', 1800);
  assert.match(fn, /norm\.subTab === 'chat'[\s\S]{0,120}suffix = '\/dev\/chat'/,
    'the general chat writes its own address, not /activity');
  assert.match(fn, /AppView\._getViewMode\(\) === 'kanban'[\s\S]{0,160}kanban \? 'board' : 'workshop'/,
    'and the card area writes whichever of the two names its layout gives it');
});

test('updateHash treats the two aliases and the canonical form as one screen', () => {
  const fn = body('const screenIdOf = (value) => {', 1400);
  // ONE screen for history, deliberately: switching layout is not somewhere to
  // go back FROM, which is also why the retired Kanban|Feed strip pushed no
  // entry. What this pins is that neither alias can produce a spurious push
  // against the canonical `dev` form updateHash computes.
  assert.match(fn, /segs\[2\] === 'workshop' \|\| segs\[2\] === 'activity' \|\| segs\[2\] === 'board'[\s\S]{0,160}splice\(2, 1, 'dev'\)/,
    'every alias normalizes to dev for screen identity');
});
