// "Change assignee…" in a dev card's ⋯ menu did nothing on desktop.
//
// The row was wired, the handler ran, the popover was created and appended —
// and then the very same click, still bubbling, reached the document-level
// "a click outside #attr-popover dismisses it" listener in _attrInit. Its
// target was the menu row: outside the popover (and by then detached from the
// document along with the menu), so the popover was removed inside the same
// dispatch that opened it. No console error, nothing on screen, no feedback
// of any kind. Touch was fine, because the native action sheet invokes its
// handler after its own dismissal rather than mid-click — which is why this
// survived: every existing check either inspected descriptors or went through
// the sheet, and none of them let a real click finish bubbling.
//
// So these tests dispatch clicks the way the browser does — row handler
// first, document listeners after, one shared event object — instead of
// calling `act()` directly, and assert on what is on screen afterwards.
//
// Run with: node --test tests/dev-card-menu-attr-popover.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { renderComponent } = require('./lib/render-tsx');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

// ── A DOM stub with real bubbling ───────────────────────────────────────
//
// Only what these paths touch: parents, a `closest` over the handful of
// selectors the listeners use, id lookup, and document-level listeners that
// a dispatch actually runs (in registration order, capture listeners first)
// so "the click carried on bubbling" is modelled rather than assumed.

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function matches(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  if (sel[0] === '#') return node.id === sel.slice(1);
  if (sel[0] === '.') return String(node.className || '').split(/\s+/).includes(sel.slice(1));
  const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attr) {
    const v = node.dataset ? node.dataset[camel(attr[1].replace(/^data-/, ''))] : undefined;
    return attr[2] == null ? v !== undefined : v === attr[2];
  }
  throw new Error(`test DOM stub can't match selector: ${sel}`);
}

function mkEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    style: {},
    dataset: {},
    parentNode: null,
    handlers: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach() {} }),
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, right: 90 }),
    focus() {},
  };
  el.closest = (sel) => {
    for (let n = el; n; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  };
  return el;
}

function mkDoc(sandbox) {
  const byId = Object.create(null);
  const listeners = [];
  const doc = {
    nodeType: 9,
    listeners,
    byId,
    resolve: () => null,        // per-test querySelector resolver
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => doc.resolve(sel),
    querySelectorAll: () => ({ forEach() {} }),
    createElement: (tag) => mkEl(tag),
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    body: {
      appendChild(node) {
        node.parentNode = { removeChild: (n) => { if (n.id) delete byId[n.id]; n.parentNode = null; } };
        if (node.id) byId[node.id] = node;
        return node;
      },
    },
  };
  // #attr-popover removes itself via el.remove().
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const el = create(tag);
    el.remove = () => { if (el.id) delete byId[el.id]; el.parentNode = null; };
    return el;
  };
  sandbox.document = doc;
  return doc;
}

// One browser click: the element handler runs, then the document listeners it
// bubbles up to — all sharing the single event object, which is the whole
// point (the fix keys off event identity).
function click(doc, target, el) {
  const ev = {
    type: 'click', target, preventDefault() {}, stopPropagation() {},
  };
  for (const fn of ((el && el.handlers.click) || [])) fn(ev);
  for (const l of doc.listeners) if (l.type === 'click' && l.capture) l.fn(ev);
  for (const l of doc.listeners) if (l.type === 'click' && !l.capture) l.fn(ev);
  return ev;
}

function scroll(doc, target) {
  const ev = { type: 'scroll', target };
  for (const l of doc.listeners) if (l.type === 'scroll') l.fn(ev);
}

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42, username: 'me' }, currentSubTab: 'dev' },
    PlatformUI: { isTouch: () => false, actionSheet: () => {}, toast: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    // Never resolves, so the popover stays on its "Loading…" body: these
    // tests are about the synchronous open, not the fetched contents.
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1280,
    innerHeight: 800,
  };
  // #1191: the menu's ROWS are features/dev-board/card-menu.tsx's, published
  // through this bridge. The host, its placement, its dismissers and the one
  // delegated click are still app-view.js's, which is what these tests are
  // about — so the bridge records what was published and the row nodes are
  // still built by hand below.
  sandbox.publishedMenuRows = [];
  sandbox.UsernodeReact = {
    devBoard: {
      mountCardMenu: () => {},
      mountAttrPopover: () => {},
      publishCardMenu: (rows) => { sandbox.publishedMenuRows = rows; },
      publishAttrPopover: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  const doc = mkDoc(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app' };
  AppView._attrInit();                 // the dismissers under test
  return { AppView, doc, sandbox };
}

// Open the ⋯ menu for one card and hand back the row element for `field`.
// The rows are a React component in the browser; here the published view
// model stands in for them, and the row NODE is built with the same dataset
// the real button carries.
function openMenuRow(AppView, doc, field, items, sandbox) {
  const trigger = mkEl('button');
  trigger.dataset.cardMenu = 'issue:5';
  AppView._cardMenus['issue:5'] = items;
  AppView._toggleCardMenu(trigger);
  const menu = AppView._openCardMenu.el;
  const idx = items.findIndex((it) => it.icon === field);
  assert.ok(idx >= 0, `no ${field} row registered`);
  if (sandbox) {
    assert.ok(sandbox.publishedMenuRows.some((r) => r.row === field),
      'the row carries its meaning as a stable hook');
  }
  const row = mkEl('button');
  row.dataset.menuIdx = String(idx);
  row.dataset.menuRow = field;
  row.parentNode = menu;
  return { menu, row };
}

// The three metadata rows every dev card offers, straight from the builder.
function attrRows(AppView, over) {
  return AppView._attrMenuItems('issue', 5, { number: 5, ...(over || {}) });
}

test('the ⋯ row for an attribute is wired to open its picker', () => {
  const { AppView } = makeAppView();
  const rows = attrRows(AppView);
  const assignee = rows.find((it) => it.icon === 'assignee');
  assert.ok(assignee, 'an assignee row is offered');
  assert.match(assignee.label, /assign/i);
  assert.equal(typeof assignee.act, 'function', 'and it is not an inert label');
});

test('the click that RUNS the row does not also dismiss the picker it opened', () => {
  const { AppView, doc, sandbox } = makeAppView();
  const rows = attrRows(AppView);
  const { row } = openMenuRow(AppView, doc, 'assignee', rows, sandbox);
  // The card is on screen with no assignee chip yet — the unset case the row
  // exists for, so the popover anchors to the card.
  const card = mkEl('div');
  card.dataset.refIssue = '5';
  doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);

  click(doc, row, AppView._openCardMenu.el);

  assert.ok(doc.getElementById('attr-popover'),
    'the picker is on screen after the click that opened it finished bubbling');
  assert.ok(AppView._attrPopover, 'and the app still considers it open');
  assert.equal(AppView._attrPopover.field, 'assignee');
  assert.equal(AppView._openCardMenu, null, 'the menu itself closed, as it should');
});

test('every metadata row survives its own click, not just assignee', () => {
  for (const field of ['assignee', 'priority', 'category']) {
    const { AppView, doc } = makeAppView();
    const rows = attrRows(AppView);
    const { row } = openMenuRow(AppView, doc, field, rows);
    const card = mkEl('div');
    card.dataset.refIssue = '5';
    doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);

    click(doc, row, AppView._openCardMenu.el);

    assert.ok(doc.getElementById('attr-popover'), `${field} row opened nothing`);
    assert.equal(AppView._attrPopover.field, field);
  }
});

test('the NEXT click outside still dismisses it — the guard is one event wide', () => {
  const { AppView, doc } = makeAppView();
  const { row } = openMenuRow(AppView, doc, 'assignee', attrRows(AppView));
  const card = mkEl('div');
  card.dataset.refIssue = '5';
  doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);
  click(doc, row, AppView._openCardMenu.el);
  assert.ok(doc.getElementById('attr-popover'));

  // Anywhere else on the page, a separate dispatch.
  click(doc, mkEl('div'), null);

  assert.equal(doc.getElementById('attr-popover'), null, 'outside-click dismissal still works');
  assert.equal(AppView._attrPopover, null);
});

test('a click INSIDE the picker leaves it open', () => {
  const { AppView, doc } = makeAppView();
  const { row } = openMenuRow(AppView, doc, 'assignee', attrRows(AppView));
  const card = mkEl('div');
  card.dataset.refIssue = '5';
  doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);
  click(doc, row, AppView._openCardMenu.el);

  const pop = doc.getElementById('attr-popover');
  const inner = mkEl('button');
  inner.parentNode = pop;
  click(doc, inner, null);

  assert.ok(doc.getElementById('attr-popover'), 'using the picker must not close it');
});

test('scrolling the picker\'s own overflowing list does not dismiss it', () => {
  const { AppView, doc } = makeAppView();
  const { row } = openMenuRow(AppView, doc, 'assignee', attrRows(AppView));
  const card = mkEl('div');
  card.dataset.refIssue = '5';
  doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);
  click(doc, row, AppView._openCardMenu.el);

  // .attr-popover is max-height:320px + overflow-y:auto, so a long assignee
  // list scrolls inside it. Reaching the name you want is not a dismissal.
  scroll(doc, doc.getElementById('attr-popover'));
  assert.ok(doc.getElementById('attr-popover'), 'its own scroll closed the picker');

  // The page scrolling under it still is one — the popover is position:fixed
  // and would otherwise be stranded beside nothing.
  scroll(doc, doc);
  assert.equal(doc.getElementById('attr-popover'), null);
});

// ── Landing on screen ───────────────────────────────────────────────────

test('the picker flips above an anchor near the bottom of the viewport', () => {
  const { AppView, sandbox } = makeAppView();
  const pop = mkEl('div');
  pop.offsetHeight = 200;
  AppView._positionAttrPopover(pop, { getBoundingClientRect: () => ({ top: 700, bottom: 720, left: 40 }) });
  // 720 + 4 + 200 would run off an 800px viewport, so it opens upwards.
  assert.equal(pop.style.top, `${700 - 200 - 4}px`);
  assert.equal(pop.style.left, '40px');
  assert.equal(sandbox.innerHeight, 800);
});

test('an anchor scrolled out of view still puts the picker inside the viewport', () => {
  const { AppView } = makeAppView();
  const pop = mkEl('div');
  pop.offsetHeight = 200;
  // A card deep inside a kanban column that scrolls internally: its rect can
  // sit thousands of pixels below the fold. Unclamped, the picker opened
  // off screen — indistinguishable from "the row does nothing".
  AppView._positionAttrPopover(pop, { getBoundingClientRect: () => ({ top: 4976, bottom: 4996, left: 40 }) });
  const top = parseInt(pop.style.top, 10);
  assert.ok(top >= 8 && top + 200 <= 800, `picker off screen at top:${top}`);
});

test('the ordinary case is unchanged: straight under the anchor', () => {
  const { AppView } = makeAppView();
  const pop = mkEl('div');
  pop.offsetHeight = 200;
  AppView._positionAttrPopover(pop, { getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40 }) });
  assert.equal(pop.style.top, '124px');
});

// ── Surviving the repaint a vote triggers ───────────────────────────────

test('a vote cast from the ⋯ row keeps the picker open with no chip rendered', () => {
  const { AppView, doc } = makeAppView();
  AppView._repaintCards = () => {};
  const pop = doc.createElement('div');
  pop.id = 'attr-popover';
  doc.body.appendChild(pop);
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 5, slug: 'demo-app' };
  // Still unassigned after the vote (one vote is a tally, not a value), so
  // there is no chip — only the card.
  const card = mkEl('div');
  card.dataset.refIssue = '5';
  doc.resolve = (sel) => (sel.includes('data-attr-chip') ? null : card);

  AppView._refreshAttrCards();

  assert.ok(doc.getElementById('attr-popover'),
    'the picker closing on the vote you just cast is the same dead-end by another route');
  assert.match(pop.style.top, /px$/, 're-anchored to the card');
});

test('but it does close when neither chip nor card is rendered any more', () => {
  const { AppView, doc } = makeAppView();
  AppView._repaintCards = () => {};
  const pop = doc.createElement('div');
  pop.id = 'attr-popover';
  doc.body.appendChild(pop);
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 5, slug: 'demo-app' };
  doc.resolve = () => null;            // filtered off the board entirely

  AppView._refreshAttrCards();
  assert.equal(doc.getElementById('attr-popover'), null);
  assert.equal(AppView._attrPopover, null);
});

// ── Source guards ───────────────────────────────────────────────────────

test('the row handler stamps the acting event and the dismisser skips exactly it', () => {
  assert.match(SRC, /AppView\._menuActEvent = ev;/,
    'the ⋯ row handler must mark the dispatch it is acting on');
  assert.match(SRC, /if \(e === AppView\._menuActEvent\) return;/,
    'and the outside-click dismisser must skip that one event, by identity');
  // Not by deferring act(): "Open on GitHub" does window.open, which a popup
  // blocker eats outside the user gesture. Not by stopPropagation() either —
  // that would swallow the click from every other document-level listener.
  const at = SRC.indexOf('menu.addEventListener(\'click\'');
  const body = SRC.slice(at, SRC.indexOf('trigger.setAttribute', at));
  assert.doesNotMatch(body, /setTimeout\(\s*\(\)\s*=>\s*it\.act/, 'act() must stay in the gesture');
  assert.doesNotMatch(body, /ev\.stopPropagation\(\)/, 'the click belongs to the whole document');
});

test('every ⋯ row exposes its meaning as data-menu-row', () => {
  const { AppView, sandbox } = makeAppView();
  AppView._fillCardMenu(mkEl('div'), [
    { label: 'Change assignee…', icon: 'assignee', act: () => {} },
    { label: 'Open on GitHub', icon: 'github', act: () => {} },
    { label: 'No icon', act: () => {} },
  ]);
  // The module's half: the hook is the descriptor's icon key, and a row
  // without one carries null rather than an empty string.
  assert.deepEqual(sandbox.publishedMenuRows.map((r) => r.row), ['assignee', 'github', null]);

  // The component's half: null means the attribute is ABSENT, not empty —
  // an empty one would match `[data-menu-row]` by accident.
  const html = renderComponent(
    'frontend/src/features/dev-board/card-menu.tsx', 'CardMenuView',
    { rows: JSON.parse(JSON.stringify(sandbox.publishedMenuRows)) },
  );
  assert.match(html, /data-menu-row="assignee"/);
  assert.match(html, /data-menu-row="github"/);
  assert.doesNotMatch(html, /data-menu-row=""/);
  // …and the three things the delegated handler and the styles need.
  assert.match(html, /data-menu-idx="0"[^>]*data-menu-row="assignee"/);
  assert.match(html, /role="menuitem"/);
  // Audit D08: the icon is a line icon (UserCheckIcon), not the old "@".
  assert.match(html, /<span class="dev-card-menu-icon" aria-hidden="true"><svg[^>]*>[\s\S]*?<\/svg><\/span><span class="dev-card-menu-label">Change assignee…<\/span>/);
  assert.match(html, /d="M16 11l2 2 4-4"/, 'the assignee row draws the person-with-a-tick');
});

test('a danger row is red, and an inert row is disabled rather than hidden', () => {
  const { AppView, sandbox } = makeAppView();
  AppView._fillCardMenu(mkEl('div'), [
    { label: 'Withdraw', icon: 'withdraw', danger: true, act: () => {} },
    // No `act` — "Close proposed" and friends, kept so they can explain
    // themselves rather than disappearing.
    { label: 'Close proposed', icon: 'close', title: 'A close vote is already open' },
  ]);
  const html = renderComponent(
    'frontend/src/features/dev-board/card-menu.tsx', 'CardMenuView',
    { rows: JSON.parse(JSON.stringify(sandbox.publishedMenuRows)) },
  );
  assert.match(html, /class="dev-card-menu-item dev-card-menu-item-danger"[^>]*data-menu-idx="0"/);
  assert.match(html, /data-menu-idx="1"[^>]*title="A close vote is already open" disabled=""/);
  assert.equal((html.match(/disabled/g) || []).length, 1, 'only the inert row is disabled');
});
