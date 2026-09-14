// Script and stylesheet ordering in the generated shell document.
//
// Two orderings in public/index.html are load-bearing, and neither is visible
// from any single source file now that the document is assembled by
// frontend/scripts/build-shell.mjs out of src/head.html plus a prerendered
// Shell.tsx. So they are pinned here.
//
// Both are checked against tests/baselines/shell-markup.json — the frozen
// structural baseline scripts/derive-shell-baseline.js took from the
// pre-migration document before the HTML fixture was retired (#1078).
//
// ── 1. The legacy classic scripts ──────────────────────────────────────
//
// public/js/** is 26 files of global-scope script with no module system (24
// of them shell tags; cli-authorize.js and connect-authorize.js are page IIFEs
// for server-rendered documents and were never in the shell):
// each defines a global (App, Home, AppView, DevChat, AuthScreens, …) and
// several depend on an earlier one already existing. app.js is LAST on
// purpose — it registers its DOMContentLoaded handler after every other
// module's, so App.init() runs after all of them. Reordering the tags
// reorders init, which breaks things that look nothing like a script-order
// bug when they fail.
//
// ── 2. The React entry's position ──────────────────────────────────────
//
// The entry must be a `type="module"` script (therefore deferred) so it
// executes AFTER all 24 classic scripts have defined their globals and
// BEFORE DOMContentLoaded runs their init()s. See frontend/src/main.tsx.
//
// ── 3. The stylesheet cascade ──────────────────────────────────────────
//
// native.css → app.css → tailwind.css, with the compiled utilities LAST.
// tests/tailwind-build.test.js asserts this too and index.html carries a
// runtime probe for it; the note in the head explains what broke (#938) when
// it was last inverted. Asserted again here because this file is now
// generated, and the failure it guards is silent and whole-screen.
//
// Run with: node --test tests/shell-script-order.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scriptsOf, stylesheetsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

// The frozen script list, derived once from the pre-migration document by
// scripts/derive-shell-baseline.js (#1078). It replaced the HTML fixture the
// chassis swap compared against — see that script's header for why.
const baseline = require('./baselines/shell-markup.json');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const ENTRY_SRC = '/shell/assets/shell.js';

// Modules added AFTER the baseline was taken, which it cannot know about.
// They are removed from the comparison below — exactly as the React entry is
// — so this test keeps meaning what it says: the baseline's scripts still
// load in their original relative order. A new module's own position is
// pinned by its own assertion instead (see the nav-link.js check below); do
// not add one here without doing the same.
const ADDED_SCRIPTS = [
  '/js/nav-link.js', // #1036 — the real-anchor / new-tab seam
  '/js/dev-flow-select.js', // #1049 — the dev-flow picker + walkthrough
  '/js/session-options.js', // #1055 — the composer's session/billing menu
  '/js/build-venues.js', // the six build venues, shared by every picker
  '/js/feedback-queue.js', // #1054 — the offline feedback outbox, before app.js
  // #1038 — the live session working-state store. It shipped with a
  // SHELL_ASSETS entry but no <script> tag, so window.SessionState was
  // undefined at runtime and every consumer silently took its guarded
  // fallback; the tag was restored in the chat-helper cluster, before
  // app-view.js. It post-dates the baseline like the rest of this list.
  '/js/session-state.js',
];

// Modules a conversion chunk RETIRED, with the reason. Each one's behaviour
// moved into the React bundle, so the tag is gone from Shell.tsx, the entry
// is gone from SHELL_ASSETS in public/sw.js, and the file is deleted from
// public/js/. They are removed from the baseline side of the comparison.
const RETIRED_SCRIPTS = {
  '/js/launchpad.js': '#1891 — shared React local-agent guide; context helpers moved into dev-chat bundle',
  // #1078 chunk A — service-worker registration and the /health connectivity
  // probe moved into frontend/src/lib/{service-worker,offline}.ts when
  // #offline-banner became a React island (frontend/src/features/shell/
  // banners.tsx). window.Offline keeps its exact API for the six legacy call
  // sites that still use it.
  '/js/offline.js': 'offline banner + SW registration converted to React (chunk A)',
  // #1079 chunk B — the dev-console receiver, its per-app ring buffer and the
  // whole #dev-console-panel subtree moved into frontend/src/features/
  // dev-console/. `window.DevConsole` keeps its exact API (app.js,
  // app-view.js and settings.js call it unguarded), installed at module scope
  // in store.ts rather than from an effect.
  '/js/dev-console.js': 'developer console converted to a React island (chunk B)',
  // #1079 chunk B — #notifications-panel and #work-drawer-panel became islands
  // on @/components/ui/anchored-panel, and the two modules moved verbatim into
  // frontend/src/features/{notifications,work-drawer}/. They still publish
  // window.Notifications / window.WorkDrawer / window.SESSION_NOTIF_KINDS at
  // module scope for app.js, app-view.js, dev-chat.js and home.js.
  '/js/notifications.js': 'bell dropdown converted to a React island (chunk B)',
  '/js/work-drawer.js': 'header-cog drawer converted to a React island (chunk B)',
  // #1079 chunk B — #platform-header and #header-menu-{overlay,panel} became
  // islands (frontend/src/features/header/). header-layout.js is the hook
  // use-header-layout.ts; node-pill.js, wallet-sheet.js and ai-credit.js moved
  // verbatim into the same directory and still publish window.NodePill /
  // window.WalletSheet / window.AiCredit for app.js. theme.js is the one that
  // did NOT move into the bundle: it is inline and head-blocking in
  // frontend/src/head.html, because a deferred module cannot apply the stored
  // theme before first paint.
  '/js/header-layout.js': 'header title centering ported to a hook (chunk B)',
  '/js/node-pill.js': 'drawer node row moved into the header island (chunk B)',
  '/js/wallet-sheet.js': 'drawer wallet row moved into the header island (chunk B)',
  '/js/ai-credit.js': 'drawer AI-credit row moved into the header island (chunk B)',
  '/js/theme.js': 'theme module inlined into the head (chunk B)',
  // #1081 chunk D — #settings-screen became an island
  // (frontend/src/features/settings/), and the module moved verbatim into the
  // same directory: same 3700 lines, same Settings object, same
  // `window.Settings` publication at module scope for app.js, app-view.js,
  // dev-chat.js and credit-options.js. Only its DOMContentLoaded bootstrap
  // changed — init() now runs from the island's layout effect.
  //
  // It is the ONLY module chunk D retires. The issue also named
  // dev-flow-select.js and credit-options.js as candidates; both are consumed
  // by dev-chat.js and app-view.js and cannot go.
  //
  // (The issue's list also named cli-authorize.js and connect-authorize.js.
  // Those two are not shell scripts and were never candidates for any chunk:
  // they are page IIFEs for the server-rendered /cli/authorize and
  // connector-consent documents, in neither Shell.tsx nor SHELL_ASSETS, and
  // this migration does not reach them. They are dropped from the candidate
  // list here rather than carried forward as perpetual not-yet work.)
  '/js/settings.js': 'settings screen converted to a React island (chunk D)',
  // #1082 chunk E — #admin-screen became an island
  // (frontend/src/features/admin/), and all ten admin modules moved verbatim
  // into the same directory: same objects, same `window.AdminConsole` /
  // `window.AdminUI` / `window.Admin<Section>` publications (app.js calls the
  // first, and AdminConsole._renderSection dispatches sections through
  // window[modName]), now behind a `typeof window` guard for the prerender
  // pass. None of them had a DOMContentLoaded bootstrap to replace — the
  // console mounts on demand from App.navigateToAdminConsole.
  //
  // All ten in ONE chunk because they were one load-order cluster: the nine
  // section modules read the AdminUI registry admin-console.js defines, and
  // admin-topochain.js reads it at module-evaluation time. Inside the bundle
  // that is an `import`, so retiring admin-console.js's tag on its own would
  // have left the other nine reading an undefined global.
  '/js/admin-console.js': 'admin console chassis converted to a React island (chunk E)',
  '/js/admin-status.js': 'admin Health & status section moved into the console island (chunk E)',
  '/js/admin-node.js': 'admin Node & chain section moved into the console island (chunk E)',
  '/js/admin-analytics.js': 'admin Analytics section moved into the console island (chunk E)',
  '/js/admin-estimator.js': 'admin Estimator accuracy section moved into the console island (chunk E)',
  '/js/admin-merges.js': 'admin Merge debug section moved into the console island (chunk E)',
  '/js/admin-gallery.js': 'admin Screenshot gallery section moved into the console island (chunk E)',
  '/js/admin-campaigns.js': 'admin Maintenance campaigns section moved into the console island (chunk E)',
  '/js/admin-mail.js': 'admin Email delivery section moved into the console island (chunk E)',
  '/js/admin-topochain.js': 'admin Seasons/Events/Challenges section moved into the console island (chunk E)',
  // #1083 chunk F — #browse-screen became an island
  // (frontend/src/features/apps/browse-screen.tsx) and the module moved
  // verbatim into the same directory, keeping its `window.Browse` publication
  // (app.js's #apps hash branch, navigateToBrowse and nav-link.js all reach it
  // that way) behind a `typeof window` guard for the prerender pass. It had no
  // DOMContentLoaded bootstrap — the screen mounts on demand from
  // App.navigateToBrowse.
  //
  // Its load-order dependency on home.js went with it. browse.js used to load
  // AFTER home.js to read Home.iconTileFor / Home.renderAppPillsHtml as
  // globals; those two are features/apps/app-card.js now, an explicit import
  // here and a delegating method on Home (which is still classic until step 4
  // of the chunk). The remaining Home reads — isYours, matchesQuery,
  // toggleAdded, menuItemsFor — are state rather than markup, stay on the
  // global, and only run once a viewer opens #apps, long after every classic
  // script has evaluated.
  '/js/browse.js': 'browse-all-apps screen converted to a React island (chunk F)',
  // Same chunk, step 2: #profile-screen became an island
  // (frontend/src/features/profile/index.tsx) and the renderer moved to
  // frontend/src/features/profile/profile.js. It keeps `window.Profile` — the
  // #profile hash branch, App.navigateToProfile / _exitProfile and the header
  // menu's Profile row all reach it that way, and app.js is still classic —
  // behind a `typeof window` guard for the prerender pass.
  //
  // It had no load-order dependency to carry: nothing else read a Profile
  // global at evaluation time, and it had no DOMContentLoaded bootstrap. The
  // one ordering claim in the comment it replaced ("loaded before app.js,
  // whose restoreFromHash calls Profile.open()") still holds for a stronger
  // reason — the bundle entry is a module script, so it evaluates after every
  // classic script here.
  '/js/profile.js': 'profile screen converted to a React island (chunk F)',
  // Same chunk, step 3: #leaderboard-screen became an island
  // (frontend/src/features/leaderboard/index.tsx) and ALL FIVE of its modules
  // moved into that directory. Each keeps its `window.X` publication behind a
  // `typeof window` guard — app.js's #leaderboard branch and its aliases,
  // App.navigateToLeaderboard / _routeLeaderboard, its pull-to-refresh handler
  // and app-view.js's twelve Kudos call sites all still reach them by name.
  //
  // They moved TOGETHER because they are one screen with one lifecycle: the
  // Leaderboard module lazily mounts the three guests when their tab is first
  // shown and tears them down in its own close(), and the two Topochain-domain
  // panes read the shared event selection from TopochainEventContext. Inside
  // the bundle that is a set of imports in the island rather than an order
  // implied by five tags.
  //
  // The one piece of DOM that changed hands is the SECTION TAB STRIP.
  // _renderSectionTabs() used to innerHTML three buttons into #standings-tabs;
  // it publishes through features/leaderboard/section-store.ts now and the
  // island renders the strip from the new Tabs primitive
  // (frontend/@/components/ui/tabs.tsx), emitting the same buttons with the
  // same data-standings-tab keys. Pane visibility deliberately did NOT move —
  // _applySection still toggles `hidden` on the three pane roots and the event
  // bar, which is safe because React renders their className as a constant
  // prop (see frontend/src/lib/legacy-dom.ts).
  //
  // kudos.js's ordering claim ("before app-view.js, whose panel renderer calls
  // Kudos.renderButton") survives the move: all twelve of those call sites read
  // `window.Kudos` at call time behind a guard, and the bundle entry is a
  // module script in the head, so it evaluates after every classic script here
  // and before DOMContentLoaded.
  '/js/kudos.js': 'Kudos widget moved into the leaderboard island (chunk F)',
  '/js/leaderboard.js': 'leaderboard screen converted to a React island (chunk F)',
  '/js/topochain-event-context.js':
    "the screen's shared event bar moved into the leaderboard island (chunk F)",
  '/js/topochain-leaderboard.js':
    'the standings pane moved into the leaderboard island (chunk F)',
  '/js/topochain-challenges.js':
    'the challenges pane moved into the leaderboard island (chunk F)',
  // Same chunk, step 4 — the last region: #home-screen became an island
  // (frontend/src/features/home/index.tsx) and its three modules moved into
  // that directory. Each keeps its `window.X` publication behind a `typeof
  // window` guard, because the classic half still reaches all three by name:
  // app.js's navigateHome / _exitHome / resyncCurrentView and its WS app-event
  // fan-out, app-view.js, build-log.js, settings.js and notifications.js call
  // Home; home-panels.js and home-layout.js are read by home.js and by each
  // other. Their DOMContentLoaded-era bootstrap is the island's init call.
  //
  // They moved TOGETHER because the three tags were one ordered chain —
  // geometry, then the widget renderers the grid calls into, then the grid —
  // and inside the bundle that chain is the island's import list.
  //
  // NO DOM changed hands. The island renders the screen's structure exactly as
  // the hand-written shell had it and leaves all four innerHTML hosts
  // (#app-list, #home-panels, #home-widget-strip-section, and the search bar's
  // `data-revealed`) to the modules, which is what keeps the two things this
  // screen is fragile about intact: #home-search-input's focus and caret
  // survive the grid re-render on every WS app event because the input is
  // emitted once and never re-rendered, and drag-to-rearrange still runs
  // entirely in home.js against PlatformUI and the native kit, with React never
  // reconciling inside #app-list.
  //
  // home.js was also the last declarer of the ambient `escapeHtml` /
  // `formatRelativeTime` pair; both are module-scoped now. The note at the top
  // of features/home/home.js traces every remaining consumer.
  '/js/home.js': 'home launcher grid converted to a React island (chunk F)',
  '/js/home-layout.js': 'home grid geometry moved into the home island (chunk F)',
  '/js/home-panels.js': 'home widget renderers moved into the home island (chunk F)',
  // #1084 chunk G, second commit — the dev session chat's module moved into
  // frontend/src/features/dev-chat/dev-chat.js. This one is a MOVE ONLY: the
  // 8,800 lines are unchanged apart from the header and the two `typeof window`
  // guards around its bootstrap, and it still publishes `window.DevChat` at
  // module scope for the dozen legacy callers that read the bare global
  // (app.js, app-view.js, group-chat.js, dev-flow-select.js, session-options.js,
  // credit-options.js, settings.js, dev-alerts.js, …). renderChatView() still
  // writes #dc-view.innerHTML, so the chat screen is NOT React-owned yet —
  // that conversion has to take the frame and the composer's streaming state
  // together, and it is not in this commit.
  //
  // It goes ALONE, unlike chunk E's ten-module cluster, because it is the only
  // consumer end of its load-order chain: the eight pure helpers that had to
  // load before it (session-state, merge-status, build-log,
  // session-transcript, spec-sections, cc-progress-summary, dev-alerts,
  // streaming-markdown) all have consumers outside these two screens and keep
  // their tags. (This comment claimed that of all eight from the start, but
  // session-state.js had no tag to keep — it was precached in SHELL_ASSETS and
  // rendered by nobody, so window.SessionState was undefined at runtime. The
  // tag is restored now, and it is the reverse SHELL_ASSETS assertion in
  // tests/pwa-shell-wiring.test.js, not this prose, that keeps it true.)
  // Their relative order still holds for a stronger reason — the
  // bundle entry is a deferred module, so it evaluates after every classic tag.
  '/js/dev-chat.js': 'dev session chat module moved into the React bundle (chunk G)',
  // #1078 chunk I — the dialogs chunk. It brought modal adoption inside React
  // (frontend/src/lib/static-modal.ts replaces PlatformUI.adoptStaticModal),
  // which is the prerequisite that let all nine shell dialogs stop being
  // markup-only. Two of their modules came into the bundle with them:
  //
  // app-secrets.js is frontend/src/features/dialogs/app-secrets-controller.js
  // now — a MOVE, keeping its `window.Secrets` publication for the Dev screen's
  // "App secrets" row and the platform-variables entry point, with its
  // DOMContentLoaded bootstrap replaced by the island's init() call. Its rows
  // are still innerHTML, so the island renders a constant tree and owns only
  // the open/close lifecycle.
  //
  // screenshot-select.js is frontend/src/features/dialogs/screenshot-select.js,
  // imported by the feedback island — its only consumer. Its ordering claim
  // ("before app.js, so the modal wiring can gate the attach button on
  // isSupported()") is satisfied more directly now: the import is evaluated
  // before feedback-controller.js reads window.ScreenshotSelect. The pure
  // geometry/detection functions keep their module.exports branch for
  // tests/screenshot-select.test.js.
  //
  // The other seven dialogs retired no tag: their behaviour lived inside
  // app.js and app-view.js, which stay.
  '/js/app-secrets.js': 'app-secrets dialog converted to a React island (chunk I)',
  '/js/screenshot-select.js':
    "the feedback dialog's screenshot capture moved into the bundle (chunk I)",
};

// public/js/topochain-events.js is deliberately NOT in that map, and now stays
// out of it for good. It is the shared "which event should this screen open
// on?" RULE — pure data with no DOM of its own — so chunk E could not move it
// with the console and chunk F has no region to move it with either: its one
// consumer (features/leaderboard/topochain-event-context.js) is in the bundle,
// reads window.TopochainEvents at call time behind a guard, and is deferred
// past this classic script. Moving it would be a rewrite, not a move.

test('every legacy script is loaded, in exactly the baseline order', () => {
  const expected = baseline.scripts.filter((s) => !(s in RETIRED_SCRIPTS));
  const actual = scriptsOf(after)
    .filter((s) => s.src && s.src !== ENTRY_SRC && !ADDED_SCRIPTS.includes(s.src))
    .map((s) => s.src);

  assert.deepEqual(
    actual, expected,
    'the <script src> sequence in public/index.html no longer matches the frozen baseline.\n'
    + 'These are global-scope classic scripts with load-order dependencies (app.js must stay last, '
    + 'so App.init() runs after every other module registers). Fix the order in '
    + 'frontend/src/Shell.tsx / frontend/src/head.html and rebuild.',
  );
});

test('the shell still loads the expected number of legacy scripts', () => {
  // 24 /js/** tags, ALL at the end of <body> — the head has none left. The
  // count moves whenever main adds a module — it was 48 at the chassis swap
  // (plus theme.js in the head), main's mail console and credit-options
  // screens brought it to 50, #1036's nav-link.js made 51, #1049's
  // dev-flow-select.js made 52, #1055's session-options.js made 53, and the
  // shared build-venues.js list made 54. It goes DOWN as conversion chunks
  // retire modules: #1078 chunk A retired offline.js (53), and #1079 chunk B
  // retires dev-console.js (52), notifications.js and work-drawer.js (50),
  // then header-layout.js, node-pill.js, wallet-sheet.js, ai-credit.js and
  // theme.js (46 — theme.js was the head's only one, so the body count drops
  // by four). #1081 chunk D retires settings.js (45), and #1082 chunk E
  // retires the admin console's ten modules in one go (35) — see the cluster
  // note in RETIRED_SCRIPTS for why they could not go one at a time. It goes
  // back UP when a new module ships: #1054's feedback-queue.js makes 36.
  // #1083 chunk F retires its ten modules one screen at a time: browse.js
  // (35), profile.js (34), the leaderboard screen's five together (29), and
  // finally the home screen's three (26). #1084 chunk G retires dev-chat.js
  // (25) — the eight pure chat helpers keep their tags, because group-chat.js,
  // app-view.js and the session drawer still read them as globals. Restoring
  // #1038's session-state.js tag — one of those eight, precached in
  // SHELL_ASSETS but rendered by nobody since it shipped — makes 26. #1078
  // chunk I retires app-secrets.js and screenshot-select.js together (24):
  // they are the only two modules the nine dialogs owned outright. #1281's
  // launchpad.js — the panel that stands in for the composer when a session
  // builds somewhere else — makes 25. #1891 moves it into React (24).
  const bodyScripts = scriptsOf(after.slice(after.indexOf('</head>')))
    .filter((s) => s.src && s.src.startsWith('/js/'));
  assert.equal(
    bodyScripts.length, 24,
    `expected the 24 legacy /js/** scripts at the end of <body>, found ${bodyScripts.length}. `
    + 'Adding or removing one is fine, but it also needs a matching SHELL_ASSETS entry in '
    + 'public/sw.js (tests/pwa-shell-wiring.test.js enforces that) — so update this count '
    + 'deliberately rather than loosening the check.',
  );

  const headScripts = scriptsOf(after.slice(0, after.indexOf('</head>')))
    .filter((s) => s.src && s.src.startsWith('/js/'))
    .map((s) => s.src);
  assert.deepEqual(
    headScripts, [],
    'no /js/** script belongs in the head any more. theme.js was the last one, and #1079 chunk B '
    + 'inlined it into frontend/src/head.html — an external tag there is a second request the '
    + 'first paint has to wait for, and the thing it decides is whether the page is dark.',
  );
});

test('a retired script is really gone, everywhere', () => {
  // Keeps RETIRED_SCRIPTS honest. Retiring a module is a four-part edit — the
  // <script> tag in Shell.tsx, the SHELL_ASSETS entry in public/sw.js, the
  // file under public/js/, and this map — and a half-done one either 404s
  // during the service worker's install or silently keeps the old module
  // running alongside its React replacement.
  const sw = require('../public/sw.js');
  for (const [src, reason] of Object.entries(RETIRED_SCRIPTS)) {
    assert.ok(reason, `RETIRED_SCRIPTS[${src}] needs a reason`);
    assert.ok(
      !after.includes(`src="${src}"`),
      `${src} is listed in RETIRED_SCRIPTS but public/index.html still loads it.`,
    );
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'public', src.replace(/^\//, ''))),
      `${src} is listed in RETIRED_SCRIPTS but the file is still in the repo — delete it, or `
      + 'drop the entry if the module is still live.',
    );
    assert.ok(
      !sw.SHELL_ASSETS.includes(src),
      `${src} is retired but public/sw.js still precaches it — the install would 404.`,
    );
  }
});

test('nav-link.js loads ahead of every module that consumes it', () => {
  // Excluded from the fixture comparison above (the frozen pre-migration
  // document predates it), so its position is pinned here instead. #1036:
  // app.js, app-view.js, dev-chat.js, home.js and leaderboard.js all
  // reference window.NavLink, and it has no dependencies of its own.
  // browse.js, leaderboard.js and dev-chat.js are consumers too and are kept
  // in the list below even though #1083 chunk F and #1084 chunk G retired their
  // tags — the `idx === -1` arm covers them, and the entries document that a
  // re-added tag would still have to come after.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/nav-link.js');
  assert.notEqual(at, -1, 'the shell must load /js/nav-link.js');
  for (const consumer of ['/js/platform-ui.js', '/js/app.js', '/js/app-view.js',
    '/js/browse.js', '/js/dev-chat.js', '/js/home.js', '/js/leaderboard.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `nav-link.js must load before ${consumer}, which reads window.NavLink`);
  }
  // The converted consumers live in the bundle now, and the bundle's tag is
  // in the HEAD — ahead of nav-link.js in document order. What makes that
  // safe is `type="module"`, which defers it past every classic script, so
  // that attribute is the actual guarantee and is asserted rather than
  // assumed. (frontend/src/head.html owns the tag.)
  const entry = scriptsOf(after).find((s) => s.src === ENTRY_SRC);
  assert.ok(entry, `the shell must load ${ENTRY_SRC}`);
  assert.equal(entry.type, 'module',
    `${ENTRY_SRC} must stay type="module": that is what defers it past the classic `
    + 'scripts its own modules read globals from (window.NavLink, window.Home, window.PlatformUI).');
});

test('feedback-queue.js loads ahead of app.js, which arms and drains it', () => {
  // Excluded from the fixture comparison above for the same reason as
  // nav-link.js, so its position is pinned here. #1054: app.js calls
  // FeedbackQueue.init() while wiring the Send Feedback dialog and hands it
  // any submit the network refuses, so window.FeedbackQueue has to exist by
  // then. The module itself depends on nothing (window.Offline is read lazily,
  // inside the flush triggers).
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/feedback-queue.js');
  assert.notEqual(at, -1, 'the shell must load /js/feedback-queue.js');
  const appAt = srcs.indexOf('/js/app.js');
  assert.ok(appAt === -1 || at < appAt,
    'feedback-queue.js must load before app.js, which reads window.FeedbackQueue');
});

test('dev-flow-select.js loads ahead of the modules that consume it', () => {
  // Excluded from the fixture comparison above for the same reason as
  // nav-link.js, so its position is pinned here. #1049: dev-chat.js owns the
  // state and calls DevFlowSelect.pickerHtml / wizardHtml / wire, and
  // app-view.js pokes DevChat._devFlow from the "+" menu — the module itself
  // has no dependencies at all. dev-chat.js keeps its entry below even though
  // #1084 chunk G retired its tag: the `idx === -1` arm covers it, and the
  // deferred bundle runs after every classic script anyway.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/dev-flow-select.js');
  assert.notEqual(at, -1, 'the shell must load /js/dev-flow-select.js');
  for (const consumer of ['/js/dev-chat.js', '/js/app-view.js', '/js/app.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `dev-flow-select.js must load before ${consumer}, which reads window.DevFlowSelect`);
  }
});

test('session-options.js loads ahead of the modules that consume it', () => {
  // Excluded from the fixture comparison above for the same reason as the
  // two modules before it, so its position is pinned here. #1055: dev-chat.js
  // owns the state and calls SessionOptions.open / openInstructions; the
  // module itself depends only on PlatformUI, which loads earlier still.
  // dev-chat.js keeps its entry below despite #1084 chunk G retiring its tag,
  // for the same reason as in the dev-flow-select.js check above.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/session-options.js');
  assert.notEqual(at, -1, 'the shell must load /js/session-options.js');
  const platformUi = srcs.indexOf('/js/platform-ui.js');
  assert.ok(platformUi === -1 || platformUi < at,
    'platform-ui.js must load before session-options.js, which presents through the seam');
  for (const consumer of ['/js/dev-chat.js', '/js/app.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `session-options.js must load before ${consumer}, which reads window.SessionOptions`);
  }
});

test('build-venues.js loads ahead of the modules that consume it', () => {
  // Excluded from the fixture comparison above for the same reason as the
  // three modules before it, so its position is pinned here. It is the
  // single list of the six build venues, and it is a LEAF: pure data, copy
  // and presentation, depending only on PlatformUI for the sheet. Every
  // surface that asks "where should this be built?" reads window.BuildVenues,
  // which is four modules — if any one of them loads first it silently falls
  // back to whatever local copy it still has, which is exactly the drift
  // this module exists to end. dev-chat.js keeps its entry below despite
  // #1084 chunk G retiring its tag (the `idx === -1` arm covers it).
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/build-venues.js');
  assert.notEqual(at, -1, 'the shell must load /js/build-venues.js');
  const platformUi = srcs.indexOf('/js/platform-ui.js');
  assert.ok(platformUi === -1 || platformUi < at,
    'platform-ui.js must load before build-venues.js, which presents the sheet through the seam');
  for (const consumer of [
    '/js/credit-options.js', '/js/session-options.js',
    '/js/dev-chat.js', '/js/app-view.js', '/js/app.js',
  ]) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `build-venues.js must load before ${consumer}, which reads window.BuildVenues`);
  }
});

test('session-state.js loads ahead of the modules that consume it', () => {
  // Excluded from the baseline comparison above for the same reason as the
  // four modules before it, so its position is pinned here. #1038: a pure
  // leaf store — it touches window.App only at call time — but app-view.js
  // registers SessionState.onEvent / SessionState.subscribe at MODULE SCOPE,
  // behind a `if (window.SessionState)` guard, so a tag that loads late (or
  // not at all) makes the live store silently inert instead of throwing.
  // That is exactly what shipped: SHELL_ASSETS precached the module and no
  // <script> tag rendered it. tests/pwa-shell-wiring.test.js now fails on
  // that shape directly; this check keeps the ORDER honest once it loads.
  const srcs = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/')).map((s) => s.src);
  const at = srcs.indexOf('/js/session-state.js');
  assert.notEqual(at, -1,
    'the shell must load /js/session-state.js — without the tag window.SessionState is '
    + 'undefined and every consumer in app.js / app-view.js takes its guarded fallback');
  // dev-chat.js keeps its entry despite #1084 chunk G retiring its tag (the
  // `idx === -1` arm covers it — the bundle is deferred past every classic
  // script either way).
  for (const consumer of ['/js/dev-chat.js', '/js/app-view.js', '/js/app.js']) {
    const idx = srcs.indexOf(consumer);
    assert.ok(idx === -1 || at < idx,
      `session-state.js must load before ${consumer}, which reads window.SessionState`);
  }
});

test('app.js is the last legacy script', () => {
  const legacy = scriptsOf(after).filter((s) => s.src && s.src.startsWith('/js/'));
  assert.equal(
    legacy[legacy.length - 1].src, '/js/app.js',
    'app.js must remain the LAST /js/** script: it registers its DOMContentLoaded handler last, '
    + 'which is what makes App.init() run after every other module has initialised.',
  );
});

test('the React entry is a deferred module, and the only one', () => {
  const scripts = scriptsOf(after);
  const modules = scripts.filter((s) => s.type === 'module');

  assert.equal(modules.length, 1, 'there should be exactly one type="module" script — the React entry');
  assert.equal(modules[0].src, ENTRY_SRC, `the module entry should be ${ENTRY_SRC}`);

  for (const s of scripts) {
    if (s.src === ENTRY_SRC) continue;
    assert.notEqual(
      s.type, 'module',
      `${s.src || '<inline>'} must stay a CLASSIC script. Converting a legacy /js/** file to a `
      + 'module would defer it and silently change init order.',
    );
  }
});

test('the React entry loads after every legacy script in document order', () => {
  // Module scripts are deferred, so a module in <head> still executes after
  // in-body classic scripts. Position alone is not the guarantee — being a
  // module is (asserted above) — but the entry must not be somewhere that
  // makes the intent unreadable, e.g. interleaved among the /js/** tags.
  const entryAt = after.indexOf(`src="${ENTRY_SRC}"`);
  const headEnd = after.indexOf('</head>');
  assert.ok(entryAt > -1, 'the React entry is not referenced at all');
  assert.ok(
    entryAt < headEnd,
    'the React entry belongs at the END of <head>: it is deferred, so it runs after the body\'s '
    + 'classic scripts and before DOMContentLoaded, which is the window frontend/src/main.tsx '
    + 'documents. Placing it among the /js/** tags in <body> would obscure that.',
  );
  const lastHeadScript = after.lastIndexOf('<script', headEnd);
  assert.ok(
    after.slice(lastHeadScript, headEnd).includes(ENTRY_SRC),
    'the React entry should be the LAST script in <head>, after the bridge and the vendored libs',
  );
});

test('the stylesheet cascade is native.css → app.css → tailwind.css', () => {
  assert.deepEqual(
    stylesheetsOf(after),
    baseline.stylesheets,
    'the compiled utilities must be linked LAST. app.css was written against a cascade where '
    + 'Tailwind wins equal-specificity conflicts; inverting it silently restyles the shell (#938). '
    + 'The head also probes this at runtime and console.errors when it breaks, which fails checks.',
  );
});

test('the head still loads the bridge before anything can use it', () => {
  const head = after.slice(0, after.indexOf('</head>'));
  const bridgeAt = head.indexOf('/usernode-bridge.js');
  const nativeClassAt = head.indexOf('in-native-webview');
  assert.ok(bridgeAt > -1, 'the head must load /usernode-bridge.js');
  assert.ok(
    nativeClassAt > bridgeAt,
    'the inline script that adds .in-native-webview reads window.usernode.isNative, which '
    + '/usernode-bridge.js sets synchronously — it must run after the bridge. Reversing them '
    + 'reintroduces the flash of a duplicated header title inside the Homeroom app WebView.',
  );
  assert.ok(
    head.indexOf('window.Theme') < bridgeAt,
    'the inline theme block should keep running first so the stored theme is applied before '
    + 'first paint — it is head-blocking precisely so nothing paints ahead of it',
  );
});

test('the document loads nothing cross-origin', () => {
  // tests/tailwind-build.test.js and tests/pwa-shell-wiring.test.js already
  // assert this; repeated here because the document is generated now and a
  // build-time template edit is a new way to break it.
  for (const m of after.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    assert.ok(
      !/^https?:\/\//.test(m[1]),
      `public/index.html loads an off-origin asset: ${m[1]}. Vendor it under public/vendor/ `
      + '(npm run vendor:assets) or compile it in instead.',
    );
  }
});
