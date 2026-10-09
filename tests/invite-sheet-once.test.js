'use strict';

// The hub's Invite opens the Homeroom menu on its invite pane ONCE, at the
// height it stays, with one fade of the dim.
//
// What it did (iOS, October 2026): the sheet slid up short, on the pane's
// one-line "Making your link…", then about 200ms later the dim jumped lighter
// and faded in again while the sheet slid up a second time to its full
// height. The kit measures a sheet's content once when it presents; when the
// content grows after, it slides the sheet up again from where it stood, and
// its dim (1 - offset / height) drops by the share of the sheet that was
// added (public/usernode-native/v1/native.js, `watchSize`). The pane was the
// content that grew.
//
// So, pinned here:
//   * the hub (frontend/src/features/dev-board/workshop/community-card.tsx)
//     and the Share dialog (frontend/src/features/dialogs/share.tsx) make ONE
//     call, AppContext.openInvite();
//   * openInvite (frontend/src/features/app-context/app-context-controller.js)
//     reads the pane's state first, for at most INVITE_WAIT_MS, and presents
//     once, with the invite pane already chosen when the kit measures;
//   * the read (frontend/src/features/app-context/invite-data.ts) is one per
//     opening, makes the first link without a second read, and never rejects;
//   * the pane (frontend/src/features/app-context/invite-pane.tsx) renders
//     that answer on its FIRST render, and while there is none, a skeleton of
//     its own rows rather than a one-line note.
//
// Run with: node --test tests/invite-sheet-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SHEET_CONTROLLER = read('frontend/src/lib/sheet-controller.js');
const CONTROLLER = read('frontend/src/features/app-context/app-context-controller.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── the opener ───────────────────────────────────────────────────────────

/**
 * The REAL controller over the REAL sheet chassis, in a vm, with the kit
 * stubbed for touch. The kit stub snapshots the store at the moment it takes
 * the element: that is when the real kit measures the sheet's height, so what
 * the store says then is the pane the sheet goes up at.
 */
function loadOpener({ panel = true, slug = 'notes-ab12' } = {}) {
  const timers = [];
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    location: { search: '', href: 'https://homeroom.test/#app/notes-ab12/workshop' },
    URLSearchParams,
    addEventListener: () => {},
    document: {
      getElementById: (id) => (panel && id === 'apps-switcher-sheet' ? { id } : null),
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const store = makeStoreStub({ open: false, view: 'menu', adopted: false });
  const improve = makeStoreStub({ slug });
  const presents = [];
  runModules(sandbox, [['sheet-controller.js', SHEET_CONTROLLER]], {
    imports: {
      './kit-surface': {
        adoptKitSurface: (opts) => {
          presents.push({ ...store.state });
          return { kind: opts.kind, contentEl: opts.contentEl, restore() {}, dismiss() { opts.onDismiss(); } };
        },
      },
      './back-stack': { pushDismissible: () => () => {} },
    },
    tail: 'window.__make = createSheetController;',
  });

  // The read, as invite-data.ts answers it: one promise per opening, which a
  // second ask while it is on its way joins.
  const reads = [];
  let land = null;
  let pending = null;
  runModules(sandbox, [['app-context-controller.js', CONTROLLER]], {
    imports: {
      '../../lib/sheet-controller.js': { createSheetController: sandbox.__make },
      '../improve/improve-store.js': { improveStore: improve },
      './app-context-store.js': { appContextStore: store },
      './invite-data': {
        prepareInvite: (s) => {
          reads.push(s);
          if (!pending) pending = new Promise((resolve) => { land = resolve; });
          return pending;
        },
      },
    },
    tail: 'window.__wait = INVITE_WAIT_MS;',
  });

  return {
    AppContext: sandbox.AppContext,
    wait: sandbox.__wait,
    store,
    improve,
    presents,
    reads,
    timers,
    land: (outcome) => land(outcome),
    fireWait: () => {
      for (const t of timers.filter((x) => x.ms === sandbox.__wait)) t.fn();
    },
  };
}

test('Invite reads first, then goes up once, already on the invite pane', async () => {
  const o = loadOpener();
  const done = o.AppContext.openInvite();
  assert.deepEqual(o.reads, ['notes-ab12'], 'the pane\'s read starts at the tap');
  await flush();
  assert.equal(o.presents.length, 0, 'and nothing goes up while it is on its way');
  assert.equal(o.store.state.view, 'menu', 'nor is the pane switched under a closed sheet yet');

  o.land({ slug: 'notes-ab12', state: { links: [] }, error: null });
  await done;
  assert.equal(o.presents.length, 1, 'one present');
  assert.equal(o.presents[0].view, 'invite',
    'the kit measures the invite pane, never the menu that used to go up first');
  assert.equal(o.presents[0].open, true, 'with `open` published before the present');
  assert.deepEqual(
    { open: o.store.state.open, view: o.store.state.view, adopted: o.store.state.adopted },
    { open: true, view: 'invite', adopted: true },
  );
});

test('a slow read does not hold the tap: the sheet goes up at the wait, once', async () => {
  const o = loadOpener();
  assert.ok(o.wait > 0 && o.wait <= 400, `a short wait (${o.wait}ms)`);
  const done = o.AppContext.openInvite();
  await flush();
  assert.equal(o.presents.length, 0);
  o.fireWait();
  await done;
  assert.equal(o.presents.length, 1, 'up at the wait, without the answer');
  assert.equal(o.presents[0].view, 'invite', 'on the invite pane (its skeleton is the loaded height)');
  // The answer landing later changes nothing about the presentation.
  o.land({ slug: 'notes-ab12', state: { links: [] }, error: null });
  await flush();
  assert.equal(o.presents.length, 1, 'and it is not presented again when the link comes');
});

test('a second tap while it waits joins the same opening', async () => {
  const o = loadOpener();
  const first = o.AppContext.openInvite();
  const second = o.AppContext.openInvite();
  o.land({ slug: 'notes-ab12', state: { links: [] }, error: null });
  await Promise.all([first, second]);
  assert.equal(o.presents.length, 1, 'one sheet, one present');
});

test('somewhere else by the time the read lands: nothing opens', async () => {
  const o = loadOpener();
  const done = o.AppContext.openInvite();
  o.improve.set({ slug: 'other-cd34' });
  o.land({ slug: 'notes-ab12', state: { links: [] }, error: null });
  await done;
  assert.equal(o.presents.length, 0);
  assert.equal(o.store.state.view, 'menu', 'and the menu is left on its own first pane');
});

test('an open the sheet refuses leaves the menu on its first pane', async () => {
  const o = loadOpener({ panel: false });
  const done = o.AppContext.openInvite();
  o.land({ slug: 'notes-ab12', state: { links: [] }, error: null });
  await done;
  assert.equal(o.store.state.open, false);
  assert.equal(o.store.state.view, 'menu',
    'or the next open from the Homeroom mark would land on Invite');
});

test('the hub and the Share dialog open it with one call, not open() then a pane switch', () => {
  const hub = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  const body = hub.slice(hub.indexOf('export function openInviteLinks(): void {'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.match(fn, /void ctx\.openInvite\?\.\(\);/);
  assert.doesNotMatch(fn, /ctx\.open\?\.\(\)|showInvite/, 'no menu present before the pane');

  const share = read('frontend/src/features/dialogs/share.tsx');
  const at = share.indexOf('function openInvitePane(): void {');
  const fn2 = share.slice(at, share.indexOf('\n}\n', at) + 2);
  assert.match(fn2, /void ctx\.openInvite\?\.\(\);/);
  assert.doesNotMatch(fn2, /ctx\.open\?\.\(\)|showInvite/);

  // The pane is chosen BEFORE the sheet opens, so the kit's one measurement
  // is of it.
  assert.match(CONTROLLER, /function openAt\(view\) \{\s*appContextStore\.set\(\{ view \}\);\s*AppContext\.open\(\);/);
});

// ── the read ─────────────────────────────────────────────────────────────

const LINK = {
  id: 7, token: 'tok', path: '/invite/tok', maxUses: 25, uses: 0,
  expiresAt: '2026-10-12T12:00:00Z', createdAt: '2026-10-05T12:00:00Z', createdBy: 'maya', mine: true, note: null,
};
const STATE = {
  links: [],
  manages: false,
  canCreate: true,
  grant: 'member',
  defaults: { days: 7, maxUses: 25 },
  limits: { minDays: 1, maxDays: 30, minUses: 1, maxUses: 100 },
  joiningRule: 'Changes go in when 2 people approve.',
};

/** A fetch that answers from `routes` (by method) and records every call. */
function stubFetch(routes) {
  const calls = [];
  const fake = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    const answer = routes[method];
    if (!answer) return { ok: false, json: async () => ({ error: 'nope' }) };
    const { status = 200, body } = typeof answer === 'function' ? answer() : answer;
    return { ok: status < 400, json: async () => body };
  };
  return { fake, calls };
}

async function withFetch(fake, run) {
  const before = global.fetch;
  global.fetch = fake;
  try { return await run(); } finally { global.fetch = before; }
}

test('one read per opening: the first link is made once, and joins the list without a second read', async () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const { fake, calls } = stubFetch({
    GET: { body: STATE },
    POST: { status: 201, body: { link: LINK } },
  });
  await withFetch(fake, async () => {
    const a = api.prepareInvite('notes-ab12');
    const b = api.prepareInvite('notes-ab12');
    assert.equal(a, b, 'a second ask while it is on its way gets the same read');
    const outcome = await a;
    assert.deepEqual(calls, [
      'GET /api/apps/notes-ab12/invite-links',
      'POST /api/apps/notes-ab12/invite-links',
    ], 'one link made, and no third round trip to list it');
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.state.links.map((l) => l.id), [7], 'the new link leads the list');
    assert.equal(api.preparedInvite('notes-ab12'), outcome, 'kept for the pane\'s first render');
    assert.equal(api.preparedInvite('other-cd34'), null, 'for that project only');
    api.forgetPreparedInvite();
    assert.equal(api.preparedInvite('notes-ab12'), null);
  });
});

test('a viewer with a link of their own makes none; a failure is an answer, not a throw', async () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const own = stubFetch({ GET: { body: { ...STATE, links: [LINK] } } });
  await withFetch(own.fake, async () => {
    const outcome = await api.prepareInvite('notes-ab12');
    assert.deepEqual(own.calls, ['GET /api/apps/notes-ab12/invite-links']);
    assert.equal(outcome.state.links.length, 1);
  });
  api.forgetPreparedInvite();
  const down = stubFetch({ GET: { status: 500, body: { error: 'Internal server error' } } });
  await withFetch(down.fake, async () => {
    const outcome = await api.prepareInvite('notes-ab12');
    assert.equal(outcome.state, null);
    assert.equal(outcome.error, 'Internal server error');
  });
});

// ── the pane ─────────────────────────────────────────────────────────────

const classOf = (html, id) => {
  const m = html.match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`));
  assert.ok(m, `#${id} rendered`);
  const c = m[0].match(/class="([^"]*)"/);
  return c ? c[1] : '';
};

test('the pane\'s first render is the answer the opener read', async () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const { fake } = stubFetch({ GET: { body: { ...STATE, links: [LINK] } } });
  await withFetch(fake, () => api.prepareInvite('notes-ab12'));
  const html = renderToHtml(createElement(api.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  assert.match(html, /id="app-invite-url"[^>]*value="\/invite\/tok"|value="\/invite\/tok"[^>]*id="app-invite-url"/,
    'the link is there on the first render, so the kit measures the loaded pane');
  assert.doesNotMatch(html, /data-invite-loading/);
  // #4599: the joining rule the read carries is not spelled out under the link.
  assert.doesNotMatch(html, /Changes go in when 2 people approve\./);
  assert.match(html, /id="app-invite-change-open"[^>]*>Change</, 'Change beside the links\' heading');
});

test('with no live links, the heading row and its Change are still there', async () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const { fake } = stubFetch({ GET: { body: STATE }, POST: { status: 201, body: {} } });
  await withFetch(fake, () => api.prepareInvite('notes-ab12'));
  const html = renderToHtml(createElement(api.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  assert.match(html, />Your links</);
  assert.match(html, /id="app-invite-change-open"/);
});

test('before the answer, the pane is its own rows in grey, never a one-line note', () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const html = renderToHtml(createElement(api.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  assert.match(html, /id="app-invite-pane"[^>]*data-invite-loading=""/);
  assert.doesNotMatch(html, /Making your link…/, 'the short note the sheet went up at is gone');
  assert.match(html, />Invite people to Notes</, 'the title is known, so it is the real one');
  assert.match(html, /role="status">Making your link</, 'said once, to a screen reader');
  assert.match(html, /class="animate-pulse motion-reduce:animate-none" aria-hidden="true"/,
    'the pulse stops under reduced motion');
  assert.doesNotMatch(read('frontend/src/features/app-context/invite-pane.tsx'), /Making your link…/);
});

test('the skeleton is built from the loaded pane\'s own rows', async () => {
  // Same containers, padding and type as the rows they stand for, so the
  // height comes from the same classes: the link field is the Input's own
  // box, the buttons h-10, the heading row with Change, a link row 44px.
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const { fake } = stubFetch({ GET: { body: { ...STATE, links: [LINK] } } });
  await withFetch(fake, () => api.prepareInvite('notes-ab12'));
  const loaded = renderToHtml(createElement(api.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  const skeleton = renderToHtml(createElement(api.InviteSkeleton, { label: 'Notes', canShare: false }));

  assert.ok(skeleton.includes(`class="${classOf(loaded, 'app-invite-url')}"`),
    'the link field\'s stand-in wears the Input\'s own box');
  for (const row of [
    'class="px-5 pt-1"',
    'class="px-5 pt-3"',
    'class="flex items-stretch gap-2 px-5 pt-3"',
    'flex items-center justify-between gap-3 px-5 pt-4 pb-1',
    'text-[0.7rem] font-semibold uppercase tracking-wide',
    'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left',
  ]) {
    assert.ok(loaded.includes(row), `the loaded pane has ${row}`);
    assert.ok(skeleton.includes(row), `and so does its skeleton`);
  }
  assert.equal((skeleton.match(/h-10 flex-1 basis-0 rounded-full/g) || []).length, 1,
    'Copy alone where the device has no share sheet');
  const withShare = renderToHtml(createElement(api.InviteSkeleton, { label: 'Notes', canShare: true }));
  assert.equal((withShare.match(/h-10 flex-1 basis-0 rounded-full/g) || []).length, 2, 'Copy and Share');
});

test('an opening that failed opens on what went wrong', async () => {
  const api = loadTsx('tests/fixtures/invite-pane-api.ts');
  const { fake } = stubFetch({ GET: { status: 403, body: { error: 'Join Notes to invite people to it.' } } });
  await withFetch(fake, () => api.prepareInvite('notes-ab12'));
  const html = renderToHtml(createElement(api.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  assert.match(html, /Join Notes to invite people to it\./);
  assert.doesNotMatch(html, /data-invite-loading/);
});
