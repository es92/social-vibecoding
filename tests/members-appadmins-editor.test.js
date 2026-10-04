// Frontend tests for the App-admins editor in the members modal
// (issue #788 follow-up: creators/app admins stage a roster draft and
// Propose opens a PR editing dapp.json's `admins` array).
//
// Behaviour under test, all in app-view.js:
//   - _renderAppAdmins() owns the section's visibility: managers
//     (outside the self-app) always see it — an empty roster shows the
//     "No app admins yet" entry point — while non-managers keep the
//     hide-when-empty rule and never see edit controls.
//   - _addAppAdmin / _removeAppAdmin stage draft rows locally ("will be
//     added" / "will be removed") with no fetch; Cancel restores the
//     declared list; the 20-name cap is enforced inline.
//   - _proposeAppAdmins() confirms, POSTs the draft to
//     /api/apps/:slug/admins-pr, and repaints from the CURRENT declared
//     list (never optimistically) with the open-proposal status.
//   - An existing openProposal, a self_hosted app, and a repo-less app
//     each degrade the editor correctly.
//
// Same harness pattern as tests/members-approvers-panel.test.js: the
// real app-view.js runs in a vm context against a small DOM stub that
// supports _wireMembersModal's cloneNode-swap wiring.
//
// Run with: node --test tests/members-appadmins-editor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
// The members dialog's behaviour moved into the island's controller in #1078
// chunk I (see its header for why it is a controller and not JSX). The sandbox
// runs it the way init() does in the browser: Object.assign back onto the live
// window.AppView. Evaluated as an expression, because its file-local
// `let AppView` would otherwise collide with app-view.js's top-level const in
// the one lexical scope a vm context shares.
const MEMBERS_SRC = `(function () {\n${
  fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'members-controller.js'),
    'utf8',
  ).replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '')
}\nreturn { init, MembersDialog };\n})()`;

// DOM element stub with enough behaviour for the clone-swap wiring plus
// the innerHTML-then-querySelectorAll pattern the list renderers use.
function makeEl({ id = '', dataset = {}, classes = [] } = {}) {
  const el = {
    id,
    dataset: { ...dataset },
    value: '',
    textContent: '',
    innerHTML: '',
    className: classes.join(' '),
    disabled: false,
    _listeners: {},
    _focused: false,
    parentNode: null,
    classList: null,
    focus() { el._focused = true; },
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) {
      (el._listeners[type] || []).forEach((fn) => fn(event));
    },
    querySelectorAll() {
      const a = [];
      a.forEach = Array.prototype.forEach.bind(a);
      return a;
    },
    cloneNode() {
      const c = makeEl({ id: el.id, dataset: { ...el.dataset } });
      el._set.forEach((cls) => c.classList.add(cls));
      c.value = el.value;
      c.disabled = el.disabled;
      return c;
    },
  };
  const set = new Set(classes);
  el._set = set;
  el.classList = {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
  };
  return el;
}

function makeRegistry() {
  const byId = {};
  const bySelectorGroup = {};
  const parent = {
    replaceChild(fresh, old) {
      fresh.parentNode = parent;
      if (old.id) byId[old.id] = fresh;
      for (const group of Object.values(bySelectorGroup)) {
        const i = group.indexOf(old);
        if (i !== -1) group[i] = fresh;
      }
    },
  };
  const register = (el, groupKey) => {
    el.parentNode = parent;
    if (el.id) byId[el.id] = el;
    if (groupKey) (bySelectorGroup[groupKey] ||= []).push(el);
    return el;
  };
  return { byId, bySelectorGroup, register };
}

function makeHarness({ appData = {} } = {}) {
  const reg = makeRegistry();
  // Elements _wireMembersModal touches (missing ones are null-guarded,
  // but the governance pills need their selector groups).
  reg.register(makeEl({ dataset: { mApprovalsMode: 'default' } }), 'approvals-mode');
  reg.register(makeEl({ dataset: { mApprovalsMode: 'at_least' } }), 'approvals-mode');
  reg.register(makeEl({ dataset: { mApproverPolicy: 'anyone' } }), 'approver-policy');
  reg.register(makeEl({ dataset: { mApproverPolicy: 'invited' } }), 'approver-policy');
  reg.register(makeEl({ id: 'members-approvals-n', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-approvals-propose', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-governance-error', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-invite-input' }));
  reg.register(makeEl({ id: 'members-approver-invite-input' }));
  // The App-admins section under test.
  reg.register(makeEl({ id: 'members-appadmins-section', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-appadmins-list' }));
  reg.register(makeEl({ id: 'members-appadmins-edit', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-appadmins-input' }));
  reg.register(makeEl({ id: 'members-appadmins-suggestions', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-appadmins-actions', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-appadmins-propose' }));
  reg.register(makeEl({ id: 'members-appadmins-cancel' }));
  reg.register(makeEl({ id: 'members-appadmins-status', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-appadmins-note' }));

  const querySelectorAll = (sel) => {
    let list = [];
    if (sel.includes('data-m-approvals-mode')) list = reg.bySelectorGroup['approvals-mode'] || [];
    else if (sel.includes('data-m-approver-policy')) list = reg.bySelectorGroup['approver-policy'] || [];
    list = [...list];
    list.forEach = Array.prototype.forEach.bind(list);
    return list;
  };

  const fetches = [];
  const confirms = { queue: [], asked: 0 };
  let fetchResponse = {
    ok: true,
    status: 201,
    json: async () => ({ ok: true, sessionId: 5151, prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' }),
  };
  const sandbox = {
    console: { ...console, debug: () => {}, warn: () => {} },
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    confirm() {
      confirms.asked += 1;
      return confirms.queue.length ? confirms.queue.shift() : true;
    },
    document: {
      getElementById: (id) => reg.byId[id] || null,
      querySelector: () => null,
      querySelectorAll,
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return fetchResponse;
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.PlatformUI = {
    isTouch: () => false,
    hasKit: () => false,
    toast: () => {},
    alert: async () => ({}),
    confirm: async () => sandbox.confirm(''),
    transition: (fn) => fn(),
    attachScreenFx: () => {},
    detachScreenFx: () => {},
    pullToRefresh: () => ({ detach() {} }),
    swipeActions: () => ({ detach() {} }),
    actionSheet: async () => null,
    gestures: () => null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  vm.runInContext(MEMBERS_SRC, sandbox).init();

  const AppView = sandbox.window.AppView;
  AppView.appData = {
    slug: 'demo-app',
    self_hosted: false,
    can_manage: true,
    can_collaborate: true,
    repo_url: 'https://github.com/o/r',
    approver_policy: 'anyone',
    approvals_required: null,
    ...appData,
  };
  AppView._membersGov = { policy: 'anyone', atLeast: null };
  AppView._wireMembersModal();

  const live = () => ({
    section: reg.byId['members-appadmins-section'],
    list: reg.byId['members-appadmins-list'],
    edit: reg.byId['members-appadmins-edit'],
    input: reg.byId['members-appadmins-input'],
    actions: reg.byId['members-appadmins-actions'],
    propose: reg.byId['members-appadmins-propose'],
    cancel: reg.byId['members-appadmins-cancel'],
    status: reg.byId['members-appadmins-status'],
    note: reg.byId['members-appadmins-note'],
  });

  const setFetchResponse = (r) => { fetchResponse = r; };
  return { AppView, live, fetches, confirms, setFetchResponse };
}

const ALICE = { userId: 7, username: 'alice' };
const MANAGER_EMPTY = { admins: [], declared: [], unresolved: [], canManage: true, openProposal: null };
const MANAGER_ALICE = {
  admins: [ALICE], declared: ['alice'], unresolved: [], canManage: true, openProposal: null,
};

// ── section visibility ───────────────────────────────────────────────

test('manager + empty roster: section shown with the empty state and the editor', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_EMPTY);
  const l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false, 'section shown');
  assert.match(l.list.innerHTML, /No app admins yet/);
  assert.equal(l.edit.classList.contains('hidden'), false, 'editor shown');
  assert.equal(l.actions.classList.contains('hidden'), true, 'no propose while clean');
  assert.match(l.note.innerHTML, /Changes are proposed as a pull request/);
});

test('non-manager + empty roster: section hidden entirely', () => {
  const h = makeHarness();
  h.live().section.classList.remove('hidden'); // simulate a stale open state
  h.AppView._renderAppAdmins({ ...MANAGER_EMPTY, canManage: false });
  assert.equal(h.live().section.classList.contains('hidden'), true);
});

test('non-manager + roster: read-only rows, no edit controls, original note', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins({ ...MANAGER_ALICE, canManage: false });
  const l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false);
  assert.match(l.list.innerHTML, /@alice/);
  assert.doesNotMatch(l.list.innerHTML, /data-remove-appadmin/, 'no Remove buttons');
  assert.equal(l.edit.classList.contains('hidden'), true, 'editor hidden');
  assert.match(l.note.innerHTML, /Set in <code>dapp\.json<\/code>/);
});

test('unresolved declared names render the not-a-registered-user tag', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins({
    admins: [ALICE], declared: ['alice', 'ghost'], unresolved: ['ghost'],
    canManage: false, openProposal: null,
  });
  assert.match(h.live().list.innerHTML, /not a registered user/);
  assert.match(h.live().list.innerHTML, /@ghost/);
});

// ── draft staging ────────────────────────────────────────────────────

test('adding stages a "will be added" row with no fetch; removing stages "will be removed"', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('@Bob');
  let l = h.live();
  assert.match(l.list.innerHTML, /@Bob/);
  assert.match(l.list.innerHTML, /will be added/);
  assert.match(l.list.innerHTML, /no account yet/, 'unknown name flagged');
  assert.equal(l.actions.classList.contains('hidden'), false, 'propose/cancel revealed');
  assert.equal(h.fetches.length, 0, 'staging is purely local');

  h.AppView._removeAppAdmin('alice');
  l = h.live();
  assert.match(l.list.innerHTML, /will be removed/);
  assert.match(l.list.innerHTML, /line-through/);
  assert.equal(h.fetches.length, 0);
});

test('typeahead-confirmed names skip the no-account note; duplicates dedupe case-insensitively', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_EMPTY);
  h.AppView._addAppAdmin('zoe', { known: true });
  h.AppView._addAppAdmin('@ZOE');
  assert.doesNotMatch(h.live().list.innerHTML, /no account yet/);
  assert.deepEqual([...h.AppView._appAdminsDraft], ['zoe'], 'one entry, first casing kept');
});

test('re-adding a staged-removed name (Undo) restores the plain row', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._removeAppAdmin('alice');
  assert.match(h.live().list.innerHTML, /will be removed/);
  h.AppView._addAppAdmin('alice');
  const l = h.live();
  assert.doesNotMatch(l.list.innerHTML, /will be removed/);
  assert.equal(l.actions.classList.contains('hidden'), true, 'clean again — actions hidden');
});

test('the 21st admin is refused inline with the cap message', () => {
  const h = makeHarness();
  const declared = Array.from({ length: 20 }, (_, i) => `user${i}`);
  h.AppView._renderAppAdmins({
    admins: [], declared, unresolved: declared, canManage: true, openProposal: null,
  });
  h.AppView._addAppAdmin('one-too-many');
  assert.equal(h.AppView._appAdminsDraft.length, 20, 'draft not grown');
  assert.match(h.live().status.textContent, /at most 20 admins/);
});

test('Cancel restores the declared list and hides the actions', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('bob');
  h.AppView._removeAppAdmin('alice');
  h.live().cancel.dispatch('click');
  const l = h.live();
  assert.deepEqual([...h.AppView._appAdminsDraft], ['alice']);
  assert.doesNotMatch(l.list.innerHTML, /bob/);
  assert.equal(l.actions.classList.contains('hidden'), true);
});

// ── propose ──────────────────────────────────────────────────────────

test('Propose confirms, POSTs the draft, and repaints from the CURRENT declared list', async () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('bob');
  h.live().propose.dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(h.confirms.asked, 1, 'confirm dialog shown');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, '/api/apps/demo-app/admins-pr');
  assert.deepEqual(JSON.parse(h.fetches[0].opts.body), { admins: ['alice', 'bob'] });

  const l = h.live();
  // NOT optimistic: the staged addition is gone, the roster shows the
  // current declared names, and the status names the new proposal.
  assert.doesNotMatch(l.list.innerHTML, /will be added/);
  assert.match(l.list.innerHTML, /@alice/);
  assert.match(l.status.textContent, /Proposal opened \(PR #42\)/);
  assert.equal(l.edit.classList.contains('hidden'), true, 'editor locked while the proposal is open');
});

test('a declined confirm aborts without a POST and keeps the draft', async () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('bob');
  h.confirms.queue.push(false);
  h.live().propose.dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetches.length, 0, 'no POST');
  assert.deepEqual([...h.AppView._appAdminsDraft], ['alice', 'bob'], 'draft preserved');
});

test('a failed POST keeps the draft and shows the error', async () => {
  const h = makeHarness();
  h.setFetchResponse({ ok: false, status: 500, json: async () => ({ error: 'kaboom' }) });
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('bob');
  h.live().propose.dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...h.AppView._appAdminsDraft], ['alice', 'bob'], 'nothing typed is lost');
  assert.match(h.live().status.textContent, /kaboom/);
});

test('a 409 repaints with the already-up-for-vote state', async () => {
  const h = makeHarness();
  h.setFetchResponse({
    ok: false, status: 409,
    json: async () => ({ error: 'dup', sessionId: 9, prNumber: 7, prUrl: 'u' }),
  });
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  h.AppView._addAppAdmin('bob');
  h.live().propose.dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const l = h.live();
  assert.match(l.status.textContent, /already waiting for approval/);
  assert.equal(l.edit.classList.contains('hidden'), true);
});

// ── degraded states ──────────────────────────────────────────────────

test('an existing openProposal locks the editor and says so', () => {
  const h = makeHarness();
  h.AppView._renderAppAdmins({
    ...MANAGER_ALICE,
    openProposal: { sessionId: 9, prNumber: 7, prUrl: 'u' },
  });
  const l = h.live();
  assert.equal(l.edit.classList.contains('hidden'), true, 'editor hidden');
  assert.doesNotMatch(l.list.innerHTML, /data-remove-appadmin/, 'rows read-only');
  assert.match(l.status.textContent, /already waiting for approval/);
});

test('the self-app stays read-only even for a manager (and hides when empty)', () => {
  const h = makeHarness({ appData: { self_hosted: true } });
  h.AppView._renderAppAdmins(MANAGER_ALICE);
  let l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false, 'roster still visible');
  assert.equal(l.edit.classList.contains('hidden'), true, 'no editor on the self-app');
  assert.match(l.note.innerHTML, /Set in <code>dapp\.json<\/code>/, 'original note kept');

  h.AppView._appAdminsDraft = null;
  h.AppView._renderAppAdmins(MANAGER_EMPTY);
  assert.equal(h.live().section.classList.contains('hidden'), true, 'empty roster hides it');
});

test('a repo-less app disables the input and Propose with the no-repo hint', () => {
  const h = makeHarness({ appData: { repo_url: null } });
  h.AppView._renderAppAdmins(MANAGER_EMPTY);
  const l = h.live();
  assert.equal(l.input.disabled, true);
  assert.equal(l.propose.disabled, true);
  assert.match(l.status.textContent, /no GitHub repository/);
  // And a later app WITH a repo clears the disabled state (set, not add).
  h.AppView.appData.repo_url = 'https://github.com/o/r';
  h.AppView._appAdminsDraft = null;
  h.AppView._renderAppAdmins(MANAGER_EMPTY);
  assert.equal(h.live().input.disabled, false);
  assert.equal(h.live().propose.disabled, false);
});
