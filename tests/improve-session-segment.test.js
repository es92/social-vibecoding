// The view strip says where you are, even when that is a change (#1598).
//
// App / Workshop is a segmented control, and a segmented control with nothing
// selected reads as broken rather than as "you are somewhere else". Inside a
// dev session every segment went grey, which is the state that was reported as
// looking weird.
//
// A session is not a further DESTINATION — it is reached from a card or a
// notification, never from this strip — so the extra segment is inert and
// exists only while you are in one. Outside a session the control is the two
// segments it has, and the declared checks that pin the order and the selected
// segment are untouched.
//
// The Board segment retired after this: the Workshop and the kanban are ONE
// screen in two layouts, so the strip stopped offering the layout as a
// destination and `activeAppView` collapsed its two Dev answers into one.
// `#app/<slug>/board` and `?view=kanban` still resolve onto the kanban, and
// the strip marks Workshop while you are there — which is this file's
// "nothing selected reads as broken" rule applied to the removal.
//
// Run with: node --test tests/improve-session-segment.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const TABS = 'frontend/src/features/improve/view-tabs.tsx';
const src = fs.readFileSync(path.join(ROOT, TABS), 'utf8');

test('a dev session is its own answer, and the other routes are unchanged', () => {
  const { activeAppView } = loadTsx(TABS);

  assert.equal(activeAppView('dev', 'sessions'), 'session');

  // The two destinations answer exactly as before.
  assert.equal(activeAppView('app', null), 'app');
  assert.equal(activeAppView('dev', 'forum'), 'workshop');
  assert.equal(activeAppView('dev', 'topic'), 'workshop');

  // The general chat is a different kind of place and still selects nothing;
  // giving it a segment is its own decision.
  assert.equal(activeAppView('dev', 'chat'), null);
});

test('the board layout is the Workshop segment, not a segment of its own', () => {
  const { activeAppView } = loadTsx(TABS);

  // The layout is no longer an input: the helper takes the route only, so a
  // viewer on the kanban is on the Dev screen's one segment. Passed here as a
  // third argument on purpose — that is where 'kanban' used to change the
  // answer to 'board', and the guard is that it cannot any more.
  assert.equal(activeAppView('dev', 'forum', 'kanban'), 'workshop',
    'which board layout you are in does not change which segment is selected');
  assert.equal(activeAppView('dev', 'topic', 'kanban'), 'workshop');
  assert.equal(activeAppView('dev', 'sessions', 'kanban'), 'session',
    'and it never did change where you are inside a change');

  assert.equal(activeAppView.length, 2, 'the layout is not a parameter');
  assert.ok(!src.includes("'board'"), 'so the strip has no board answer left');
  assert.ok(!src.includes('useDevViewMode'),
    'and nothing in the strip subscribes to the layout any more');
});

test('the extra segment is inert, and only exists inside a session', () => {
  assert.match(src, /\{active === 'session' \? \(/,
    'rendered only while you are in one');
  const segment = src.slice(src.indexOf("{active === 'session' ? ("));
  const upToEnd = segment.slice(0, segment.indexOf('</div>'));
  assert.match(upToEnd, /<span\s/, 'a span, not a control you cannot use');
  assert.doesNotMatch(upToEnd, /<button|<a\s|onClick/,
    'the segment you are already on must not offer to take you there');
  assert.match(upToEnd, /aria-current="page"/);
  assert.match(upToEnd, /data-context-row="session"/);
  assert.match(upToEnd, /segClass\(true\)/,
    'it wears the same selected treatment as the others');
});

test('it comes last, and claims no id from the shell inventory', () => {
  // The declared check pins the order with a general sibling combinator
  // (`app ~ workshop`), so a further segment is only safe after them.
  const order = ['"app"', '"workshop"', '"session"']
    .map((k) => src.indexOf(`data-context-row=${k}`));
  assert.ok(order.every((idx, i) => idx !== -1 && (i === 0 || idx > order[i - 1])),
    'app, workshop, then session');

  const segment = src.slice(src.indexOf("{active === 'session' ? ("));
  assert.doesNotMatch(segment.slice(0, segment.indexOf('</div>')), /\bid=/,
    'a conditional element is not in the built document, so it takes no inventory id');
});
