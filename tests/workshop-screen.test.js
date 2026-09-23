'use strict';

// The Workshop screen (#workshop): every app you have, with how much of its
// own Workshop page is addressed to you.
//
// Three things can go wrong here, and this file is organised around them.
//
// 1. THE TWO NUMBERS CAN DRIFT FROM WHAT THEY COUNT. The populations are
//    defined by `AppView._workshopView()` in public/js/app-view.js, which
//    builds them from the board's own endpoints; the screen's counts come out
//    of Postgres instead, in one query. Two derivations of one definition is
//    exactly the shape that rots, so the assertions below pin the query
//    against the statuses and predicates those endpoints use rather than
//    against a number somebody typed.
//    It rotted once already, and the `issues` table is where. That table
//    holds governance proposals AND a `general` twin row per request filed
//    through the platform, so a query over it with no `kind` predicate counts
//    the whole request board as votes owed — which is what put forty-six
//    votes waiting on an app whose board had three open requests. The kinds
//    are pinned below too: in this query, and in each of the four places the
//    list is still written out by hand.
//
// 2. THE QUERY CAN ANSWER FOR THE WRONG VIEWER. Every predicate names `$1`;
//    with a NULL viewer `IS DISTINCT FROM` is true for every row and the
//    "needs you" count becomes "every promoted proposal on the platform".
//    The route refuses an anonymous caller for that reason, and that refusal
//    is asserted here rather than left to the middleware.
//
// 3. THE SCREEN CAN BREAK HYDRATION. It ships hidden and empty; a first
//    render that draws rows would mismatch the prerendered document, which
//    console.errors, which fails every proposal check on every route.
//
// Run with: node --test tests/workshop-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderComponent, renderToHtml } = require('./lib/render-tsx');
const { tokenize } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const route = require('../src/routes/workshop-overview');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const sheetTsx = read('frontend/src/features/app-context/app-context-sheet.tsx');

// ── 1. The counts query counts what the lander counts ──────────────────

test('"working" is the viewer\'s own work, in the lander\'s three shapes', () => {
  const sql = route.COUNTS_SQL;
  // The board's `_mySessions`: GET /api/me/active-sessions filtered to the
  // app, which selects `status IN ('active', 'promoted', 'paused')` with
  // `is_headless = FALSE` and which the board then narrows to active/paused.
  assert.match(sql, /my_sessions AS \(/);
  assert.match(sql, /cs\.status IN \('active', 'paused'\)/,
    'the viewer\'s dev sessions are the active and paused ones');
  assert.match(sql, /cs\.is_headless = FALSE/,
    'headless runs are not somebody\'s own work — /api/me/active-sessions excludes them too');
  // The board's `inReview` rows whose user_id is the viewer's: /promoted
  // returns 'promoted' AND 'merging', so a proposal mid-merge is still the
  // author's work in flight rather than vanishing off their row.
  assert.match(sql, /my_proposals AS \([\s\S]*?cs\.status IN \('promoted', 'merging'\)/);
  // #2227's case: a governance proposal you opened is your work too.
  assert.match(sql, /my_governance AS \([\s\S]*?i\.status = 'open'[\s\S]*?i\.created_by = \$1/);
  // Summed, not unioned — the three statuses are disjoint, so nothing is
  // double counted and no DISTINCT is needed to say so.
  assert.match(sql, /COALESCE\(ms\.n, 0\) \+ COALESCE\(mp\.n, 0\) \+ COALESCE\(mg\.n, 0\)\) AS working/);
});

test('"needs" is the votes owed, on the lander\'s own predicate', () => {
  const sql = route.COUNTS_SQL;
  // `_devCardMatches(kind, it, { needsVote: true })`: a proposal needs your
  // vote when `status === 'promoted' && !my_vote` — NOT 'merging', which is
  // past the decision.
  assert.match(sql, /owed_proposals AS \([\s\S]*?cs\.status = 'promoted'/);
  assert.doesNotMatch(
    /owed_proposals AS \(([\s\S]*?)\n  \),/.exec(sql)[1],
    /merging/,
    'a proposal already merging is not a vote anybody still owes',
  );
  // And it is not yours: the lander's `notMine` takes your own promoted
  // proposal out of this pane even though it satisfies "waiting on you",
  // because "What you are working on" has already claimed it.
  assert.match(sql, /cs\.user_id IS DISTINCT FROM \$1/);
  assert.match(sql, /i\.created_by IS DISTINCT FROM \$1/);
  // Governance votes live in their own table and carry no epoch.
  assert.match(sql, /FROM issue_votes iv[\s\S]*?iv\.issue_id = i\.id AND iv\.user_id = \$1/);
});

test('a vote counts as cast only under the proposal\'s current approval epoch', () => {
  // services/pr-vote-revision.js owns that rule for eighteen call sites; a
  // nineteenth that spelled `pv.approval_epoch = cs.approval_epoch` by hand
  // would be a copy that stops tracking the definition. The interpolation is
  // why this query is in the reviewed dynamic SQL baseline.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/pr-vote-revision'\)/);
  assert.match(src, /\$\{currentVotePredicateSql\('pv', 'cs'\)\}/);
  const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');
  assert.ok(
    route.COUNTS_SQL.includes(currentVotePredicateSql('pv', 'cs')),
    'the rendered query carries the shared predicate, whatever it currently says',
  );
});

test('the two `issues` CTEs read governance proposals, never the request board', () => {
  // `issues` is two populations wearing one table name. Beside the governance
  // proposals it holds a `general` TWIN row per request filed through the
  // platform — the row that remembers who filed it, because GitHub files every
  // platform-authored issue as the bot. Nothing votes on a twin, and
  // `AppView._govProposals` drops them before the lander's deck ever sees one.
  // Counting them here is not a rounding error: a twin is only ever closed by
  // a passed close-issue vote, so it outlives its GitHub issue indefinitely
  // and the pile only grows.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/governance-kinds'\)/);
  assert.equal((src.match(/\$\{governanceKindsSql\('i'\)\}/g) || []).length, 2,
    'both `issues` CTEs interpolate the shared predicate rather than spelling the kinds out');

  const { GOVERNANCE_KINDS, governanceKindsSql } = require('../src/services/governance-kinds');
  const cte = (name) => new RegExp(`${name} AS \\(([\\s\\S]*?)\\n  \\)`).exec(route.COUNTS_SQL)[1];
  for (const name of ['my_governance', 'owed_governance']) {
    assert.ok(
      cte(name).includes(governanceKindsSql('i')),
      `${name} renders the shared predicate, whatever it currently says`,
    );
  }
  // Named, never negated: a sixth kind added to the table becomes a vote
  // somebody owes only once somebody lists it here, which is the safe
  // direction for a number that asks people to do something.
  assert.ok(!GOVERNANCE_KINDS.includes('general'),
    'the request board\'s twin kind is not a thing anybody votes on');
});

test('every hand-written copy of the governance kinds still agrees with the constant', () => {
  const { GOVERNANCE_KINDS } = require('../src/services/governance-kinds');
  const expected = [...GOVERNANCE_KINDS].sort();
  const quoted = (text) => (text.match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)).sort();

  // Four sites still spell the list out, on purpose. Three are static query
  // text, which scripts/check-sql.js validates against a real schema —
  // interpolating would move them into the reviewed dynamic-SQL baseline, a
  // weaker guarantee than the duplication costs. The fourth is browser script
  // with no module loader. Duplication is the cheaper trade only while
  // something notices drift, which is this test.
  const sqlCopies = [
    ...(read('src/routes/issues.js').match(/kind IN \([\s\S]*?\)/g) || []),
    ...(read('src/services/shared-objects.js').match(/kind IN \([\s\S]*?\)/g) || []),
  ];
  assert.equal(sqlCopies.length, 3,
    'a query reading `issues` by kind was added or removed; pin it here too');
  for (const copy of sqlCopies) assert.deepEqual(quoted(copy), expected);

  // And the client's, which is what the lander's "Needs your vote" deck is
  // actually built from. A kind missing there is a proposal nobody is asked
  // to vote on, however right the server's count is.
  const clientFilter = /_govProposals = [\s\S]*?\.filter\(\(i\) =>([\s\S]*?)\);/.exec(appViewJs);
  assert.ok(clientFilter, 'the client still filters `_govProposals` by kind');
  assert.deepEqual(quoted(clientFilter[1]), expected);
});

test('every predicate names the viewer, and the route refuses one it has not got', async () => {
  const sql = route.COUNTS_SQL;
  // Five populations, each gated on $1. Without this the anonymous case is
  // not a smaller answer, it is the whole platform's.
  assert.equal((sql.match(/\$1/g) || []).length, 8,
    'the viewer appears in every CTE predicate and in the collaborator join');

  // The refusal itself, driven rather than grepped: `getPool` is called once
  // when the router is built, so a stub config is all it takes.
  const router = route.workshopOverviewRoutes({ databaseUrl: 'postgres://stub/stub' });
  const layer = router.stack.find((l) => l.route?.path === '/api/workshop/counts');
  assert.ok(layer, 'GET /api/workshop/counts is registered');
  let status = null;
  let body = null;
  await layer.route.stack[0].handle(
    { user: null, query: {}, params: {} },
    { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
    () => {},
  );
  assert.equal(status, 401, 'no session, no counts — never a platform-wide tally');
  assert.deepEqual(body, { error: 'Not authenticated' });
});

test('the visibility filter is GET /api/apps\'s, so the two lists cannot disagree', () => {
  const sql = route.COUNTS_SQL;
  assert.match(sql, /\(NOT a\.self_hosted OR \$2::boolean\)/);
  assert.match(sql, /\(\$3::boolean OR a\.view_visibility = 'public' OR me\.user_id IS NOT NULL\)/);
  assert.match(read('src/routes/apps.js'), /\(NOT a\.self_hosted OR \$1::boolean\)/,
    'the clause this mirrors is still the one /api/apps applies');
  // And only apps with something on them are returned: the client reads a
  // missing slug as two zeroes, so a row per app would be payload for nothing.
  assert.match(sql, /\+ COALESCE\(op\.n, 0\) \+ COALESCE\(og\.n, 0\)\) > 0/);
});

test('the demo overlay never overwrites a real count', () => {
  const { withDemoCounts, DEMO_COUNTS } = route;
  // `issues` survives the staging clone, so a preview can have genuine
  // governance rows against a slug the overlay also names.
  const real = { 'staging-demo-your-app': { working: 7, needs: 0 } };
  const out = withDemoCounts(real);
  assert.deepEqual(out['staging-demo-your-app'], { working: 7, needs: 0 });
  assert.deepEqual(out['staging-demo-emoji-icon'], DEMO_COUNTS['staging-demo-emoji-icon']);
  assert.ok(Object.keys(DEMO_COUNTS).includes('staging-demo-your-app'),
    'the one demo row Home.isYours accepts has to be one of these, or the '
    + 'declared checks read a screen of zeroes');
  // Keyed to the rows GET /api/apps injects under the same flag, so a rename
  // there does not silently leave this pointing at nothing.
  const appsJs = read('src/routes/apps.js');
  for (const slug of Object.keys(DEMO_COUNTS)) {
    assert.ok(appsJs.includes(`'${slug}'`),
      `${slug} is still a demo row in src/routes/apps.js`);
  }
});

// ── 2. The screen ──────────────────────────────────────────────────────

/**
 * The one element carrying `id="workshop-empty"`, as its opening tag.
 *
 * Anchored to the ID rather than to a tag name or a whole-document regex: the
 * id is the API (dapp.json selects it, see below), the element it sits on is
 * this screen's to choose, and a test that pins the tag would have to be
 * rewritten by every restyle for no reader's benefit. It asserts there is
 * exactly ONE such element, which is the failure mode that matters — a
 * conversion that leaves the id on a wrapper AND on the card inside it
 * resolves the declared check against whichever comes first.
 */
function emptyTag(html) {
  const all = html.match(/<[a-z]+\b[^>]*\bid="workshop-empty"[^>]*>/g) || [];
  assert.equal(all.length, 1,
    'exactly one element carries id="workshop-empty" — dapp.json selects it');
  return all[0];
}

test('the prerendered screen is hidden and its list has no rows', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  assert.match(html, /<main id="workshop-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a CONSTANT class string — '
    + 'useVisibilityHiddenClass writes that class, so React must not re-render it');
  assert.ok(!/data-workshop-app/.test(html),
    'no rows in the first render — a fetch during render is the hydration mismatch');
  assert.match(emptyTag(html), /\bclass="[^"]*\bhidden\b/,
    'and the empty card is hidden while the list has not answered, so an '
    + 'unloaded screen never reads as "you have no apps"');
  // THE CARD IS THE LIST'S FIRST CHILD, not its last, and that is structural
  // rather than cosmetic: GroupedList's row separator is
  // `[&:not(:last-child)]:after:*` on the ROW, so a note after the rows would
  // leave the last one drawing a hairline under nothing.
  const list = /<div[^>]*id="workshop-list"[^>]*>([\s\S]*?)$/.exec(html);
  assert.ok(list, '#workshop-list is in the prerender');
  assert.match(list[1].trimStart(), /^<div\b[^>]*id="workshop-empty"/);
  // The document the shell actually ships agrees.
  const shipped = read('public/index.html');
  assert.match(shipped, /<main id="workshop-screen" class="hidden /);
  assert.ok(!/data-workshop-app/.test(shipped));
});

// ── The empty state is a CARD (#2445) ──────────────────────────────────
//
// The UI consistency audit (#2383) found this one as a grey caption line
// where the rest of the product answers "there is nothing here" with a card
// that offers the next step: a title, a quieter second line and a trailing
// chevron, the whole plate tapping through. Home's Discover block took the
// same correction in #1913 (features/home/panels/discover.tsx) and lands on
// the same `#apps` directory, which is why that card is the specification
// here rather than a new shape.
//
// The two assertions below are separate on purpose. The first is about the
// LANGUAGE and may move with it. The second is a CONTRACT with dapp.json and
// may not.

test('the empty state is a card that offers the directory, not a grey caption', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  const tag = emptyTag(html);

  // Title over subtitle over chevron, drawn by ListRow rather than by hand,
  // so the card is the same object every other row on this screen is. The card
  // is the anchor INSIDE the id-carrying wrapper — see the ordering test below
  // for why it may not be the wrapper itself.
  const from = html.indexOf(tag) + tag.length;
  const end = html.indexOf('</a>', from);
  assert.ok(end > from, 'the card inside it has an end tag');
  const inner = html.slice(from, end);

  // A link, so cmd-click, middle-click and "open in new tab" work — the same
  // argument AppRow makes for being an anchor.
  assert.match(inner, /^<a\b[^>]*\bhref="#apps"/,
    'the card is an anchor, and it goes where Discover\'s own empty card '
    + 'goes — the directory');

  assert.match(inner, /font-bold[^"]*">You have no apps yet</,
    'a title in the row\'s own subject weight');
  assert.match(inner, /text-zinc-500[^"]*">Browse the directory to find one to join\.</,
    'a quieter second line under it');
  assert.match(inner, /<svg[^>]*>\s*<path[^>]*d="M9 5l7 7-7 7"/,
    'and ListRow\'s trailing disclosure chevron — the "tap through" mark the '
    + 'audit says the caption was missing');

  // The old caption's shape is gone, not merely covered over.
  assert.doesNotMatch(html, /<p[^>]*id="workshop-empty"/,
    'the grey caption paragraph is retired');
  assert.doesNotMatch(html, /Find apps to add in the Discover section/,
    'and so is its sentence');
});

test('the empty card keeps the id and the `hidden` toggle dapp.json selects', () => {
  // dapp.json asserts `#workshop-empty.hidden` once the list has rows: the
  // card must therefore STAY IN THE DOCUMENT and be hidden by a class, never
  // be conditionally rendered away, and the id must stay on the element the
  // check resolves to rather than on a child of it.
  const dapp = read('dapp.json');
  assert.ok(dapp.includes('#workshop-empty.hidden'),
    'the declared check still selects the class toggle — if this line has to '
    + 'change, the markup change is wrong, not the check');

  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /id="workshop-empty" className=\{empty \? '' : 'hidden'\}/,
    'the id and the class toggle are on ONE element, and visibility is a '
    + 'class on it — the element is always rendered');

  // Both states, through the component rather than through the source. One
  // module instance for both renders: loadTsx bundles afresh on every call,
  // so a store written through a second copy would not be the one the
  // component reads.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const render = () => emptyTag(renderToHtml(createElement(mod.WorkshopScreen, {})));

  assert.match(render(), /\bclass="[^"]*\bhidden\b/,
    'unanswered list: hidden, so the screen never reads as "you have no apps" '
    + 'before the fetch lands');

  mod.workshopStore.set({ open: true, rows: [], error: false });
  const shown = render();
  assert.doesNotMatch(shown, /\bclass="[^"]*\bhidden\b/,
    'an account with no apps: the same element, with the class off');

  mod.workshopStore.set({ rows: [{ slug: 'notes-9206f8', name: 'Notes', working: 0, needs: 0 }] });
  const withRows = render();
  assert.match(withRows, /\bclass="[^"]*\bhidden\b/,
    'a list with rows: the element is STILL THERE and hidden, which is the '
    + 'state dapp.json\'s `#workshop-empty.hidden` resolves against — '
    + 'conditional rendering would leave that check nothing to match');
});

/**
 * The direct element children of `#workshop-list`, as { tag, attrs }.
 *
 * `:first-of-type` is about SIBLINGS, so a regex over the flat string cannot
 * answer the question this file now has to ask; the repo's own tokenizer can.
 */
function listChildren(html) {
  const tokens = tokenize(html);
  const start = tokens.findIndex(
    (t) => t.kind === 'open' && t.attrs.some((a) => a.name === 'id' && a.value === 'workshop-list'),
  );
  assert.ok(start >= 0, '#workshop-list is in the render');
  const out = [];
  let depth = 0;
  for (const t of tokens.slice(start + 1)) {
    if (t.kind === 'open') {
      if (depth === 0) {
        const attrs = {};
        for (const a of t.attrs) attrs[a.name] = a.value === null ? '' : a.value;
        out.push({ tag: t.tag, attrs });
      }
      if (!t.selfClosing) depth++;
    } else if (t.kind === 'close') {
      if (depth === 0) break; // the list's own close tag
      depth--;
    }
  }
  return out;
}

test('an app row, never the empty card, is the first <a> in #workshop-list', () => {
  // THE REGRESSION THIS FILE EXISTS FOR, SECOND TIME. dapp.json declares
  //
  //   #workshop-list a[data-workshop-app]:first-of-type
  //     [data-workshop-needs]:not([data-workshop-needs="0"])
  //
  // to prove that an app with a decision waiting LEADS the list. That check
  // does not name the empty state at all, which is exactly why #2445's first
  // cut broke it and got all the way to the platform: the empty card became an
  // `<a>` sitting among the rows, so the first app row stopped being the first
  // `<a>` among its siblings and the compound matched nothing.
  //
  // `:first-of-type` counts siblings sharing a TAG NAME and is purely
  // structural — `display: none` does not exempt an element from it, so
  // `hidden` is no defence. The rule is therefore about the TREE, and it is
  // asserted here on the tree rather than inferred from the JSX.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));

  // The demo payload the declared check runs against (/?demo=1#workshop):
  // route.DEMO_COUNTS' own numbers, so "leads the list" means what it means
  // in the browser.
  mod.workshopStore.set({
    open: true,
    error: false,
    rows: [
      { slug: 'staging-demo-image-icon', name: 'Image', working: 1, needs: 0 },
      { slug: 'staging-demo-your-app', name: 'Your app', working: 2, needs: 3 },
    ],
  });

  const kids = listChildren(html());
  const anchors = kids.filter((k) => k.tag === 'a');
  assert.ok(anchors.length > 0, 'the rows render as anchors');
  assert.ok('data-workshop-app' in anchors[0].attrs,
    'the FIRST <a> child of #workshop-list is an app row — anything else '
    + 'here steals `a[data-workshop-app]:first-of-type` and silently kills a '
    + 'merge-gating check');
  assert.equal(anchors[0].attrs['data-workshop-app'], 'staging-demo-your-app',
    'and it is the app with votes waiting, which is what that check asserts');

  // The empty card is still present, still first, and still out of the
  // anchors' way — it is a wrapper, and its own link is one level down.
  const empty = kids.find((k) => k.attrs.id === 'workshop-empty');
  assert.ok(empty, '#workshop-empty is a direct child of the list');
  assert.equal(kids[0], empty, 'and the FIRST child, so no row draws a '
    + 'hairline under nothing');
  assert.notEqual(empty.tag, 'a',
    'but NOT an <a>: that is the whole regression. Keep the id on a wrapper '
    + 'and put the ListRow anchor inside it.');
  assert.match(empty.attrs.class || '', /\bhidden\b/,
    'and with rows it is hidden, for #workshop-empty.hidden');
});

test('the screen is built from the grouped-list primitives, not a copy of them', () => {
  // AGENTS.md: "a primitive nobody knows exists gets hand-written instead."
  // GroupedList / SectionHeader / ListRow ARE the widget language's primary
  // content shape — the section label over a borderless white card of
  // hairline-separated rows — and an earlier cut of this screen hand-rolled
  // all three, with a ring, a backdrop blur and `divide-y`, none of which the
  // language draws any more.
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /from '@\/components\/ui\/grouped-list'/);
  // SectionHeader left this list with the screen's own <h1> (#2718 review):
  // the bar above already says Workshop, and the one group on this screen is
  // the whole of it, so there is no group WITHIN a screen left to label.
  for (const name of ['GroupedList', 'ListRow']) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} is used`);
  }
  for (const wrong of [/\bdivide-y\b/, /\bbackdrop-blur/, /\bring-1\b/, /rounded-\[22px\]/]) {
    assert.doesNotMatch(src, wrong,
      'the card has no border, no blur and no hand-rolled radius — the '
      + 'language separates by figure/ground and GroupedList owns the shape');
  }
  // The leading tile is app.css's one face at the primitive's own geometry,
  // exactly as features/apps/browse-list.tsx draws it.
  assert.match(src, /app-icon-tile w-11 h-11 shrink-0 rounded-xl/);
  assert.match(src, /data-icon=\{appIconKind/);
});

test('a row goes to that app\'s own Workshop page, as an anchor', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = mod.joinCounts([{ slug: 'notes-9206f8', name: 'Notes' }], {});
  assert.deepEqual(rows, [{ slug: 'notes-9206f8', name: 'Notes', working: 0, needs: 0 }],
    'a slug the counts endpoint said nothing about is two zeroes, not absent');
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /href=\{`\/app\/\$\{encodeURIComponent\(row\.slug\)\}\/workshop`\}/,
    'App._appUrl spells the lander /app/<slug>/workshop, so a copied address '
    + 'restores the same page cold');
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/,
    'a modified click is the browser\'s — that is what makes this an anchor');
  assert.match(src, /App\?\.navigateToApp\?\.\(row\.slug, 'dev'\)/);
});

test('an app that wants a decision leads the list, and the rest keep their order', () => {
  const { orderRows } = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = orderRows([
    { slug: 'quiet-a', working: 0, needs: 0 },
    { slug: 'mine-a', working: 2, needs: 0 },
    { slug: 'quiet-b', working: 0, needs: 0 },
    { slug: 'owed-a', working: 0, needs: 1 },
    { slug: 'owed-b', working: 3, needs: 4 },
  ]);
  assert.deepEqual(rows.map((r) => r.slug),
    ['owed-a', 'owed-b', 'mine-a', 'quiet-a', 'quiet-b'],
    'votes owed, then your own work, then the quiet ones — and inside each '
    + 'band the platform\'s own "Your apps" order survives, because the sort '
    + 'is stable and the comparator answers 0');
  assert.ok(orderRows([]).length === 0);
});

test('the controller loads both reads and survives losing the counts', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const apps = [
    { slug: 'a', name: 'A', is_favorited: true },
    { slug: 'b', name: 'B', is_favorited: true },
  ];
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { partitionApps: (list) => ({ yours: list, rest: [] }) } };
  try {
    const answers = new Map([
      ['/api/apps', { ok: true, json: async () => ({ apps }) }],
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts: { b: { working: 1, needs: 2 } } }) }],
    ]);
    global.fetch = async (url) => answers.get(url) || { ok: false, json: async () => ({}) };
    await workshopController.open();
    assert.equal(workshopStore.get().open, true);
    assert.equal(workshopStore.get().error, false);
    assert.deepEqual(workshopStore.get().rows.map((r) => [r.slug, r.working, r.needs]),
      [['a', 0, 0], ['b', 1, 2]]);

    // THE COUNTS ARE THE OPTIONAL HALF. An app list with no numbers is still
    // a usable launcher; refusing to draw because one of two requests failed
    // is not. The app list is not optional, and losing it IS the error card.
    answers.set('/api/workshop/counts', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, false);
    assert.deepEqual(workshopStore.get().rows.map((r) => r.needs), [0, 0]);

    answers.set('/api/apps', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, true);

    // A LOAD THAT LANDS AFTER THE VIEWER LEFT PUBLISHES NOTHING. `open` is
    // the liveness flag, not decoration: without the check, a slow fetch
    // repaints a screen nobody is on and races the next entry's own load.
    answers.set('/api/apps', { ok: true, json: async () => ({ apps }) });
    workshopStore.set({ rows: [{ slug: 'kept', working: 9, needs: 9 }], error: false });
    const inFlight = workshopController.reload();
    workshopController.close();
    await inFlight;
    assert.deepEqual(workshopStore.get().rows.map((r) => r.slug), ['kept'],
      'the rows are left as they were, so a re-entry paints them at once');
    assert.equal(workshopController.isOpen(), false);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── 3. The route in, and the way back out ──────────────────────────────

test('coming back from an app re-reveals the screen', () => {
  // `_inWorkshop` and workshopController.isOpen() both stay true while the
  // viewer is inside an app they opened from here — navigateToApp reveals
  // #app-view through the kit's `after` callback, not through an exit chain,
  // so nothing clears either. A re-entry guard built on those would refuse
  // the one navigation this screen exists to support: the way back.
  const body = /\n  navigateToWorkshop\(\) \{([\s\S]*?)\n  \},/.exec(appJs);
  assert.ok(body, 'navigateToWorkshop is defined');
  assert.match(body[1], /if \(App\._inWorkshop && !App\.currentApp\) return;/,
    'the guard is the PAIR: the flag set, and no app on screen');
  assert.doesNotMatch(body[1], /workshop\?\.isOpen/,
    'not the island, which cannot tell "here" from "came from here"');
  // And both halves are written before the transition, because popstate and
  // hashchange land in the same tick — `_revealedScreen` is only assigned
  // inside the callback and would let the second run straight through.
  const beforeTransition = body[1].slice(0, body[1].indexOf('PlatformUI.transition('));
  assert.match(beforeTransition, /App\._inWorkshop = true;/);
  assert.match(beforeTransition, /App\.currentApp = null;/);
  // The other half of the same fact: nothing on the way into an app clears
  // the flag, which is what leaves the breadcrumb readable on the lander.
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const chain = enter.slice(0, enter.indexOf('PlatformUI.transition('));
  assert.doesNotMatch(chain, /_exitWorkshop/,
    'entering an app must not clear _inWorkshop — navigateToApp reads it');
});

test('#workshop is a route of its own', () => {
  assert.match(appJs, /if \(parts\[0\] === 'workshop'\) \{[\s\S]*?App\.navigateToWorkshop\(\);/,
    'restoreFromHash resolves it, so a bookmark and a cold boot both land here');
  assert.match(appJs, /navigateToWorkshop\(\) \{/);
  assert.match(appJs, /_exitWorkshop\(\) \{[\s\S]*?App\._inWorkshop = false;/);
  assert.match(appJs, /App\.setHeaderTitle\('Workshop'\)/);
  // THE DOOR IS A TAB (#2718). It was a menu row between Home and Discover,
  // on the rule that the app chip's menu listed every destination; the bar
  // carries them now, and Workshop is the fourth of five.
  const html = read('public/index.html');
  assert.match(html, /id="platform-tab-workshop"[^>]*href="#workshop"/,
    'the unscoped screen is a tab');
  // The app menu keeps the SCOPED entrance — the link-out every mini-app host
  // in the study draws under a mini-app — as a plain "Go to workshop" row
  // (#2761). It spent a round as the App | Workshop strip's segment; the
  // owner asked for a row, not a toggle.
  assert.match(sheetTsx, /href=\{slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#'\}/,
    "and the app's menu links out to it, scoped");
  assert.match(sheetTsx, /id="app-menu-row-workshop"/, 'as a row');
  assert.ok(!/AppViewTabs/.test(sheetTsx), 'and not as a toggle segment');
});

test('the app-entry breadcrumb has one writer and one clearer', () => {
  // Read by AppView._repaintDevBody to turn the Dev lander's house into a
  // real ← back to #workshop. Anything that can set it from a second place,
  // or fail to clear it, leaves an arrow pointing at a screen the viewer
  // never came from.
  const writes = appJs.match(/App\._appBackHref = /g) || [];
  assert.equal(writes.length, 2,
    'navigateToApp\'s write and _showOnlyScreen\'s clear — no more');
  assert.match(appJs, /^ {2}_appBackHref: null,$/m,
    'and the slot is declared on App with the prose that says who owns it');
  assert.match(appJs, /App\._appBackHref = App\._inWorkshop \? '#workshop' : null;/,
    'a BARE fragment: #back-btn\'s handler follows its href only when it '
    + 'startsWith("#"), and anything else falls through to navigateHome');
  assert.match(appJs, /if \(href && href\.startsWith\('#'\) && href\.length > 1\) \{/,
    'and that is still the rule the handler applies');
  // The mixed address the fragment produces — /app/<slug>/workshop#workshop —
  // is healed to /#workshop by restoreFromHash, which is what makes a
  // middle-click into a new tab land on the screen rather than the app.
  assert.match(appJs, /if \(rawHash && pathRoute && !rawHash\.startsWith\('app\/'\)\) \{/);
  assert.match(appJs, /if \(revealId !== 'app-view'\) App\._appBackHref = null;/,
    'revealing any other screen ends the app visit the breadcrumb was about');
});

test('the Dev lander needs no back arrow, because the rail is beside it', () => {
  // IT HAD ONE, and it was the whole of the way out: `App._appBackHref` said
  // the app had been opened from the Workshop screen, and the lander
  // published a ← to it. That was the best available answer on a surface
  // with no rail — and it only pointed anywhere at all for readers who
  // arrived by that one route.
  //
  // The rail is there now (#2718 review). The app's Workshop is a platform
  // screen scoped to one app, App._syncPlatformTabs keeps the bar up on it
  // and lights the Workshop tab, and that tab lands on the very screen the
  // arrow pointed at — for everyone, however they got here.
  assert.ok(!appViewJs.includes("App.setBackIcon?.('arrow', App._appBackHref)"),
    'the lander publishes no arrow of its own');
  assert.match(appViewJs, /App\.setBackIcon\?\.\('none'\);/,
    'and the sub-view reset is an empty slot, not the house');
  // The reset still sits ABOVE the branches, so the session's own ← survives
  // it and nothing else inherits that arrow. #2770 moved its destination: a
  // change is an agent conversation, so it hangs off Messages, not the board.
  const reset = appViewJs.indexOf("App.setBackIcon?.('none');");
  const session = appViewJs.indexOf("if (subTab === 'sessions' && ref) {");
  assert.ok(reset > 0 && session > reset,
    'the reset leads, so every sub-view that wants a slot claims it after');
  const sessionBranch = appViewJs.slice(session, appViewJs.indexOf('\n    }', session));
  assert.match(sessionBranch, /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'and a session leads with a real ← up to Messages (#2770)');
  // `_appBackHref` is not retired: the ✕ on the app tab still lands wherever
  // the visit began.
  assert.match(read('public/js/app.js'), /App\.setBackIcon\('close', App\._appBackHref \|\| undefined\);/);
  // An arrow WITH an href is what turns the phone's back gesture on — still
  // true, and still what the session sub-view relies on.
  assert.match(read('frontend/src/features/header/native-back-navigation.ts'),
    /mode === 'arrow' && !!href/);
});

// ── One Workshop, two scopes (#2718 review) ────────────────────────────

test('the app\'s own Workshop keeps the rail, and lights the tab it came through', () => {
  // "should preserve the side bar. It doesn't need a back button anymore
  // because of the side bar."
  //
  // #app-view is TWO screens behind one id: the running app, which takes the
  // whole window because that is what makes it feel like a program, and on
  // the `dev` tab the platform's own Workshop for that app. The second is a
  // platform screen that happens to be scoped, and hiding the rail there left
  // it as the one such screen with no navigation at all.
  const appJs = read('public/js/app.js');
  const sync = appJs.slice(appJs.indexOf('  _syncPlatformTabs(revealId) {'));
  const body = sync.slice(0, sync.indexOf('\n  },\n'));
  assert.match(body, /const inApp = screen === 'app-view' && App\.currentTab === 'app';/,
    'the app itself covers the rail; its Workshop does not');
  assert.match(body, /!!screen && !App\.chromeless && !inApp,/);
  // The Workshop tab is lit, so the rail knows where you are — except on the
  // app's DISCUSSION, which is a row in the Messages inbox and lights that
  // instead (#2718 review).
  assert.match(body, /\? \(App\._isMessagesThread\(\) \? 'messages' : 'workshop'\)/,
    'and the Workshop tab is lit, so the rail knows where you are');

  // A TAB HOP inside the app crosses that line without a screen reveal, so
  // it is the only other place that has to re-sync.
  const hop = appJs.slice(appJs.indexOf('  async switchTab(tab, ref, subTab, options) {'));
  assert.match(hop.slice(0, hop.indexOf('\n  },\n')),
    /if \(App\._isScreenVisible\?\.\('app-view'\)\) App\._syncPlatformTabs\('app-view'\);/,
    'the rail moves with the tab');

  // And the Workshop's lander ends ABOVE the platform's bar: its floor takes
  // off the larger of that bar and the home-indicator strip. (The Workshop's
  // own tabs used to float at the foot and ride on the bar; they sit at the
  // head of the page now, #2767, so the floor is the only thing that has to
  // know about it.)
  const css = read('public/css/app.css');
  assert.match(css,
    /--ws-area: calc\([\s\S]*?max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)\s*\);/);
});

test('the app\'s own Workshop wears the same scope chip, read from the other end', () => {
  // "should preserve the app switcher". The all-apps screen's chip says "All
  // apps" and picking one navigates here; this one names the app and its
  // panel offers the others — and All apps, which is the way back up and the
  // other half of why the back arrow is gone.
  const chrome = read('frontend/src/features/workshop/workshop-chrome.tsx');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');

  assert.match(ws, /import \{ AppWorkshopScope \} from '\.\.\/\.\.\/workshop\/workshop-chrome';/,
    'ONE component, not a second chip that can drift from the first');
  assert.match(ws, /<AppWorkshopScope\n\s+slug=\{slug\}/);
  // Its name and artwork come from the store the header's own tile reads, so
  // the two cannot disagree about which app this is, and no second fetch.
  assert.match(ws, /name=\{app\.name \|\| undefined\}/);
  assert.match(ws, /iconUrl=\{app\.iconUrl\}/);
  assert.match(ws, /const app = useStoreState\(improveStore\);/);

  // THE PANEL'S "All apps" ROW IS THE WAY BACK UP.
  assert.match(chrome, /onClick=\{\(\) => \{ onClose\(\); goToAllApps\(\); \}\}/);
  assert.match(chrome, /function goToAllApps\(\): void \{[\s\S]{0,200}window\.location\.hash = '#workshop';/,
    'a hash assignment, so the rail\'s Workshop tab and this are one route');
  // The app you are already in closes the panel and goes nowhere: a row that
  // re-navigated to the current route would throw this screen's scroll
  // position and its open windows away to arrive where it started.
  assert.match(chrome, /onClose\(\);\n\s*if \(scope\.slug === app\.slug\) return;/);

  // ITS OPEN STATE IS A STORE OF ITS OWN (#2768): two controls open this
  // panel — the chip above 700px, the header's tile and name below it — so
  // the flag cannot be the chip's `useState`. And it is still not
  // workshopStore: that was the all-apps screen's, which wears no chip now.
  const island = chrome.slice(chrome.indexOf('export function AppWorkshopScope('));
  assert.match(island, /const \{ open \} = useStoreState\(appScopeStore\)/);
  assert.ok(!island.includes('workshopStore'), 'the two screens share no flag');
  // A panel left open does not outlive the app, nor the Workshop.
  assert.match(island, /useEffect\(\(\) => \{\n\s*appScopeStore\.set\(\{ open: false \}\);\n\s*return \(\) => appScopeStore\.set\(\{ open: false \}\);\n\s*\}, \[slug\]\);/);
  // The list loads in an effect and never during render.
  assert.match(island, /useEffect\(\(\) => \{[\s\S]{0,600}fetch\(`\/api\/apps\$\{demoQuery\(\)\}`\)/);
  assert.match(island, /catch \{/, 'and offline leaves the chip working');
});
