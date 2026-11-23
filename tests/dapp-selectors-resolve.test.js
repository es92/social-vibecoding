// A pure-Node pre-flight for dapp.json's declared UI tests.
//
// dapp.json declares 227 tests across ~100 routes, and a proposal whose
// checks aren't passing is BLOCKED from merging. Each test's `expectSelector`
// is a deep structural chain against the shell's real ids and visibility
// classes, e.g.
//
//   #leaderboard-screen:not(.hidden) #challenges-root:not(.hidden)
//     #tc-se-grid #tc-se-challenge-summary
//
// That suite is the most precise specification the shell has: it pins ids,
// ancestor nesting, `.hidden` semantics and data-* attributes far harder than
// any prose. But finding out you broke one costs a full staging build plus a
// headless capture run — minutes, and far from the edit that caused it.
//
// So this test resolves the STATIC half of every selector against the
// generated public/index.html in a few milliseconds: each `#id` a selector
// mentions must either exist in the shipped markup, or be one that
// public/js/** injects at runtime (an app card, a session row, a rendered
// leaderboard). The runtime-injected ones are listed explicitly, so a
// genuinely lost id can't hide behind "oh, JS probably adds that".
//
// It cannot prove a selector MATCHES (that needs a browser with data loaded);
// it proves the selector's static anchors still exist, which is the failure
// the React chassis swap could plausibly cause.
//
// Run with: node --test tests/dapp-selectors-resolve.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf, tokenize } = require('./helpers/html-tokens');

// The set of data-* attribute NAMES actually used on elements. Deliberately
// not a raw text search: `data-panel-slot`, for one, appears only inside an
// explanatory HTML comment in the hand-written shell — home.js plants those
// hosts at runtime — and a text search would call it present in a document
// that never had it.
function dataAttrsUsed(html) {
  const names = new Set();
  for (const t of tokenize(html)) {
    if (t.kind !== 'open') continue;
    for (const a of t.attrs) {
      const n = a.name.toLowerCase();
      if (n.startsWith('data-')) names.add(n);
    }
  }
  return names;
}

const ROOT = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// The "what the hand-written shell had" side is the frozen baseline now, not
// an HTML fixture: scripts/derive-shell-baseline.js took the id set and the
// data-* name set from tests/fixtures/pre-migration-index.html once, and
// #1078 deleted the fixture. Everything below reads exactly the two lists it
// ever needed from that document, so the coverage is unchanged.
const baseline = require('./baselines/shell-markup.json');

// The document plus the interiors that mount on first reveal rather than
// shipping in the prerender (frontend/src/lib/mount-on-reveal.ts): the
// settings panes and the six anonymous-shell screens. A declared check
// reaches those ids on a route that reveals the screen — and the reveal is
// what mounts the interior, synchronously, before the router paints it — so
// a selector that anchors on one still resolves in the browser. Here they
// are rendered through the same components with their roots marked mounted
// (tests/lib/lazy-interiors.js), which is the static half of that fact.
const { lazyInteriorsHtml } = require('./lib/lazy-interiors');
const withInteriors = `${html}\n${lazyInteriorsHtml()}`;

const shipped = new Set(idsOf(withInteriors));
const shippedBefore = new Set(baseline.ids);

// Every `#id` mentioned anywhere in a selector, including inside :not(…) and
// :has(…), which the shell's selectors use heavily.
function idsInSelector(selector) {
  return [...String(selector).matchAll(/#([A-Za-z_][-\w]*)/g)].map((m) => m[1]);
}

// Every `[data-…]` attribute name a selector mentions.
function dataAttrsInSelector(selector) {
  return [...String(selector).matchAll(/\[(data-[-\w]+)/g)].map((m) => m[1]);
}

const declared = Array.isArray(manifest.tests) ? manifest.tests : [];

test('dapp.json still declares its full test suite', () => {
  assert.ok(
    declared.length >= 227,
    `dapp.json declares ${declared.length} tests; it had 227 before the React chassis swap. `
    + 'NO conversion chunk may remove one to go green: they accumulate across proposals and are '
    + 'the migration\'s real acceptance criteria.',
  );
  for (const t of declared) {
    assert.ok(t.path && t.path.startsWith('/'), `test "${t.name}" has no relative path`);
  }
});

/**
 * Does this selector nest `:has()` inside another `:has()`?
 *
 * Selectors-4 forbids it outright, so `document.querySelector` throws a
 * SyntaxError — and the two runners that evaluate these selectors
 * (capture/capture.js and worker/usernode-run-checks) both wrap that call in
 * a `try`/`catch` that reports a throw as "was not found". An invalid
 * selector therefore fails a check without ever saying it was invalid.
 *
 * `:not(:has(…))` is fine and several declared checks use it; what is not is
 * a `:has()` reached from INSIDE another `:has()`'s argument, however deeply
 * — `:has(x:not(:has(y)))` is the shape that got here.
 */
function nestsHas(selector) {
  const s = String(selector);
  let depth = 0;      // parenthesis depth
  let hasAt = -1;     // depth at which the innermost open `:has(` sits
  for (let i = 0; i < s.length; i += 1) {
    if (s.startsWith(':has(', i)) {
      if (hasAt >= 0) return true;
      hasAt = depth;
      depth += 1;
      i += 4;
      continue;
    }
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (hasAt >= 0 && depth <= hasAt) hasAt = -1;
    }
  }
  return false;
}

test('every dapp.json selector is CSS a browser will actually parse', () => {
  // Written after #2241 shipped `#dc-view:has(#dc-session-header:not(:has(…)))`
  // — valid to Playwright's OWN selector engine, which is what a local smoke
  // test drives, and a SyntaxError to the browser's, which is what the
  // capture container drives. The check failed with "was not found" against a
  // screen that was rendering perfectly, and cost a build to diagnose.
  const invalid = declared
    .filter((t) => t.expectSelector && nestsHas(t.expectSelector))
    .map((t) => `${t.expectSelector} — "${t.name}"`);
  assert.deepEqual(
    invalid, [],
    'dapp.json declares selectors with a :has() nested inside another :has(). '
    + 'That is invalid CSS: document.querySelector throws, and both check runners '
    + 'report a throw as "was not found", so these fail on staging and block the '
    + 'merge while looking like a missing element:\n  ' + invalid.join('\n  '),
  );
});

test('every id a dapp.json selector anchors on is still in the shipped markup', () => {
  // Ids that legitimately do not exist in the static document because
  // public/js/** (or, now, a React island's effect) creates them at runtime.
  // Derived, not hand-listed: an id the PRE-MIGRATION baseline also lacked was
  // always runtime-injected, so it is not something this migration could have
  // dropped. That keeps the exemption honest — it can only ever excuse ids
  // that were never in the markup.
  const failures = [];

  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const id of idsInSelector(t.expectSelector)) {
      if (shipped.has(id)) continue;
      if (!shippedBefore.has(id)) continue; // runtime-injected before and after
      failures.push(`#${id} — required by "${t.name}" (${t.path})`);
    }
  }

  assert.deepEqual(
    [...new Set(failures)], [],
    'dapp.json selectors reference element ids that were in the hand-written shell but are '
    + 'missing from the generated one. Each is a check that will fail on staging and block the '
    + 'merge:\n  ' + [...new Set(failures)].join('\n  '),
  );
});

test('every data-* attribute a dapp.json selector anchors on is still present', () => {
  const shippedAttrs = dataAttrsUsed(withInteriors);
  const shippedAttrsBefore = new Set(baseline.dataAttributes);

  const failures = [];
  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const attr of dataAttrsInSelector(t.expectSelector)) {
      if (shippedAttrs.has(attr)) continue;
      if (!shippedAttrsBefore.has(attr)) continue; // runtime-injected before and after
      failures.push(`${attr} — required by "${t.name}" (${t.path})`);
    }
  }
  assert.deepEqual(
    [...new Set(failures)], [],
    'dapp.json selectors reference data-* attributes the generated markup no longer has:\n  '
    + [...new Set(failures)].join('\n  '),
  );
});

test('the static-anchor coverage is meaningful, not vacuously empty', () => {
  // Without this, a bug that made idsInSelector() return nothing would turn
  // both tests above into no-ops that pass forever.
  const anchored = new Set();
  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const id of idsInSelector(t.expectSelector)) if (shippedBefore.has(id)) anchored.add(id);
  }
  assert.ok(
    anchored.size > 50,
    `only ${anchored.size} dapp.json selector ids resolve to static shell markup — expected well `
    + 'over 50. Either the selector parsing broke or the shell lost a great many ids.',
  );
});

test('the self-app hash routes dapp.json targets are the ones visuals.js normalises', () => {
  // src/services/visuals.js rewrites a self-app testing path whose FIRST
  // segment is in SELF_APP_HASH_ROUTES into the URL fragment, because a
  // pathname would just load index.html with an empty hash and photograph the
  // home feed for both sides of a before/after pair. Nothing in step 1 changes
  // routing — App.restoreFromHash() in public/js/app.js is still the only
  // router — so every declared path must still start with a segment that set
  // knows about, or be a genuinely standalone server page.
  const HASH_ROUTES = new Set([
    'app', 'apps', 'leaderboard', 'group-chat', 'individual-chat', 'create', 'admin',
  ]);
  // Real server-rendered pages and static assets, which pass through untouched.
  // /reports/ is the public report share link (routes/report-snapshots.js,
  // mounted before authMiddleware) — a standalone sandboxed document, not an
  // SPA route. /api/public/ is the anonymous JSON tier (routes/public-api.js):
  // a GET there answers with its own payload and never reaches index.html, so
  // a declared check on one reads the API rather than photographing a screen.
  // /waitlist/connect/ is the social-connect round trip
  // (routes/waitlist-connect.js): its callback answers with its own
  // standalone status page, never index.html.
  // /api/me/staking/context is authenticated JSON from routes/staking.js.
  // The #1551 check intentionally exercises real preview configuration.
  // /invite/<token> is the invite page (routes/community-invites.js): the
  // shell's own document, served at that pathname with a link preview in its
  // head, and the SPA draws the invite landing from it. It is not a hash
  // route, and rewriting it into one would lose the view the check is about.
  // /communities is the signed-out page about private communities
  // (frontend/src/features/guest/guest-communities.tsx): the shell's own
  // document again, which the landing draws that page from by its pathname.
  const STANDALONE = ['/cli/authorize', '/usernode-native/', '/dashboard', '/admin-features',
    '/status', '/node-status', '/debug', '/gallery', '/reports/', '/api/public/',
    '/waitlist/connect/', '/api/me/staking/context', '/invite/', '/communities'];

  const unroutable = [];
  for (const t of declared) {
    const p = t.path;
    if (p === '/' || p.startsWith('/?') || p.startsWith('/#')) continue;
    if (STANDALONE.some((s) => p.startsWith(s))) continue;
    const first = p.slice(1).split(/[/?#]/)[0];
    if (HASH_ROUTES.has(first)) continue;
    unroutable.push(`${p} — "${t.name}"`);
  }

  assert.deepEqual(
    unroutable, [],
    'dapp.json declares test paths whose first segment is neither a self-app hash route nor a '
    + 'standalone server page. src/services/visuals.js will leave them as pathnames, index.html '
    + 'will boot to the home feed, and the check will photograph a screen the change never '
    + 'touched:\n  ' + unroutable.join('\n  '),
  );
});
