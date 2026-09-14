// The shell's element-id inventory, pinned.
//
// Every id in public/index.html is an API. public/js/** reaches for them with
// getElementById (57,799 lines of it, none of which the type checker sees),
// public/css/app.css styles some of them, and dapp.json's 315 declared tests
// select against deep chains of them — so a single lost id is a silently
// broken screen plus a blocked merge, and it is by far the most damaging way
// a markup conversion can go wrong.
//
// So: the set of ids the generated document carries must equal the set the
// hand-written one carried, exactly — minus whatever a conversion chunk has
// deliberately retired, plus whatever it has deliberately added.
//
// ── The baseline, not the fixture (#1078) ──────────────────────────────
//
// Step 1 compared against a byte copy of the pre-migration document
// (tests/fixtures/pre-migration-index.html). Step 2 converts screens on
// purpose, so whole-document comparison is the thing that has to go — but the
// id inventory outlives it. The id list now lives in
// tests/baselines/shell-markup.json, derived once from that fixture by
// scripts/derive-shell-baseline.js; the fixture itself is gone.
//
// EVERY CHUNK RECORDS ITS OWN ID CHANGES HERE, in the same commit, with a
// reason. That is the whole mechanism: the baseline stays frozen, and the two
// maps below are the reviewable log of what the migration moved.
//
// Run with: node --test tests/shell-id-inventory.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');

const baseline = require('./baselines/shell-markup.json');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ── The interiors that mount on reveal ─────────────────────────────────
//
// public/index.html is no longer the whole inventory. #settings-screen's
// sixteen panes and the six anonymous-shell screens render their interiors
// on FIRST REVEAL (frontend/src/lib/mount-on-reveal.ts) rather than shipping
// in the prerender: they were 681 of the document's 1,485 elements, parsed,
// styled and hydrated on every load for screens most loads never open. Their
// roots stay in the document exactly as they were; only the children wait.
//
// So the id inventory is resolved against the document PLUS each of those
// interiors, rendered through the same component with its root marked
// mounted (tests/lib/lazy-interiors.js). None of the 187 ids that left the
// prerender is retired — every one is still here, in the interior that owns
// it — and the test at the bottom pins the other half: that the prerender
// really does not carry them any more, which is the whole point.
const { MOUNT_ON_REVEAL, interiorHtmlFor, lazyInteriorsHtml } = require('./lib/lazy-interiors');
const withInteriors = `${after}\n${lazyInteriorsHtml()}`;

// Ids a conversion chunk deliberately removed, each with the reason.
const RETIRED_IDS = {
  // ── Home's fifth area went; Profile kept its door ───────────────
  // The chip's menu has carried the entrance since #1443 (a "You" group
  // holding #switcher-row-profile and #switcher-row-settings, pinned by
  // the destination-order check in dapp.json), so the row at the foot of
  // the launcher was a second door to the same screen. The design's own
  // answer is a Profile tab in a bottom bar, not a card under Create app.
  'home-account-section': 'The "You" area, last in Home\'s reading order. Home ends on "make something" now.',
  'home-account-row': 'The row inside it, linking #profile. The entrance is #switcher-row-profile.',
  'home-account-avatar': 'The viewer\'s picture on that row. Its writer, App.applyUserAvatar, went with it — this was the last pair it wrote to (the header chip\'s copy was retired in the same #1443 round), and Profile\'s editor re-reads App.user when it saves.',
  'home-account-glyph': 'Its fallback person glyph.',
  // ── #1610: the completed-task count moved to the bell ───────────
  'notifications-badge-ai': 'The green session count on #improve-btn. It counted unread session-related notifications, split out of the bell\'s number so the two would not double-count. Nothing behind that button could CLEAR it: a session notification is marked read by clicking its row in the bell\'s list, by a group-chat mark-read, or by mark-all, and opening the Improve panel marks nothing. So a finished session raised a number on the one control with no way to dismiss it, and the reporter pressed Improve again looking for a notification that was in the bell. The count is folded back into #notifications-badge, which now carries `data-session-done` in its place; what is left on the button is #improve-working-dot.',
  // ── Andrea's 27 Aug 2026 waitlist review ────────────────────────
  // Three stage-1 fields and one stage-2 field, all removed for the same
  // reason: each asked for something nothing read back.
  'waitlist-city': 'The free-text city beside #waitlist-country. Cohorts are balanced by REGION, which the country select already answers; the city was stored and never queried. Rows that hold one keep it, and waitlist-signals.js still reads `a.city` so a signup that answered it does not lose the section.',
  'waitlist-discovery-detail': 'The "Which one?" follow-up under the discovery chips. It asked people to type a second answer to a question they had just answered with a tap, and no screen or export read the free text.',
  'waitlist-referrer': 'The "did someone refer you?" handle on the join form. A typed handle is a claim nobody can resolve; the stage-2 invite link records the same relationship as a row reference (`invite_code` / `invited_by`), which is what the admin screen actually counts.',
  'more-referrer': 'The same question on the stage-2 form, retired for the same reason and doubly redundant there — it sat directly beneath the invite link that attributes the relationship properly.',
  // ── The chip's menu is the APP PICKER, and only that ─────────────
  // Its copy of the App | Board | Activity strip went. The strip is one
  // module rendered from a caller-supplied id map, and the Improve panel's
  // map (#improve-views / #app-context-row-*) is the one every declared
  // check and getElementById already named — so nothing moved, a second
  // rendering of it stopped. See frontend/src/features/improve/view-tabs.tsx.
  'switcher-views': 'The chip menu\'s copy of the three-view strip. The menu answers WHICH APP; a control about the app you are already in sat between you and the list you opened the menu for. The Improve panel keeps the strip, and the header\'s back arrow is the way OUT of a Board now.',
  'switcher-view-app': 'Its App segment. `#app-context-row-app` in the Improve panel is the surviving one.',
  'switcher-view-board': 'Its Board segment; `#app-context-row-board` survived it, and then retired in turn — the Workshop and the kanban are one screen in two layouts, so the strip stopped offering the layout as a destination. `#app/<slug>/board` and `?view=kanban` still resolve onto the kanban board.',
  'switcher-view-activity': 'Its Activity segment; `#app-context-row-activity` survived it, and then retired in turn (below).',
  // ── The Workshop replaced the Activity feed ─────────────────────
  // The strip's middle segment names the lander now: the same cards as the
  // Board, grouped by what they are about. The old #app/<slug>/activity
  // address resolves onto it, so nothing a link named is lost.
  'app-context-row-activity': 'The strip\'s Activity segment. The Workshop (`#app-context-row-workshop`) replaced the Activity feed as the Dev screen\'s lander; the feed\'s two answers — what needs your vote, what changed since you were here — are strips above its themes.',
  // ── #1443: one control names where you are ──────────────────────
  // The chip's menu lists every destination with its own page, so the header
  // stopped needing a second, third and fourth way to say the same thing.
  //
  // #back-icon-home WAS retired here and is NOT any more — it is back in the
  // document, so it belongs to neither map: the baseline already lists it.
  // The reason it came back is the cost that retirement turned out to carry.
  // "Home is a row of the chip's menu" is true, and what it left behind was
  // five screens — the app itself, Profile, Settings, Admin, Messages — with
  // nothing in the bar at all, because 'home' had quietly come to mean
  // HIDDEN rather than "draw a house". The rule is now "every page has a
  // back or a home button, except Home", and the slot is still only one
  // control: chevron where there is a level above, house where there is not.
  // What made it affordable is the OTHER half of #1443 — the fixed 28px box
  // is still gone, so the glyph takes space only on screens that have
  // somewhere to send you.
  // ── Streamlined Concept: the drawer became the APP's surface ──────
  // The Figma board draws ONE app-scoped drawer (the app, its Board, its
  // Activity, "+ New change", the changes here and elsewhere, over a
  // Profile/Settings foot). The short-lived split — a platform drawer plus an
  // #app-context-sheet behind the title tab — collapsed into it. What the
  // drawer gave up in exchange: alerting, which is the two header glyphs
  // (#notifications-btn, #messages-btn), and the app list, which is the Apps
  // sheet behind the title tab.
  'app-context-sheet': 'The second surface is gone: its rows ARE the drawer now (features/app-context/app-context-rows.tsx). The element id lives on as #apps-switcher-sheet, which reuses its controller and kit bottom-sheet lifecycle.',
  'app-context-overlay': 'Backdrop of that surface — #apps-switcher-overlay now.',
  'app-context-body': 'Scroller of that surface; the drawer\'s own #header-menu-rows is the scroller now.',
  'app-context-close': 'Close control of that surface — #apps-switcher-close now.',
  'drawer-top-rows': 'The drawer\'s Notifications + Messages block. Both are header glyphs now, because platform-wide alerting has no business inside the app\'s own surface.',
  'drawer-row-notifications': 'Became #notifications-btn, the bell in the header\'s right group. Same #notifications route, same badge id.',
  'drawer-row-messages': 'Became #messages-btn, the chat bubble beside it. Same #messages route; its badge keeps the id its row used.',
  'drawer-notifications-badge': 'The notifications count rides #notifications-badge on the bell again — one badge, not two.',
  'drawer-your-apps': 'The Your-apps section. Switching apps is the Apps sheet behind the title tab (#apps-switcher-sheet), which is what the board draws.',
  'drawer-row-your-apps': 'Nav row of that section; the sheet\'s Home button is the way to the grid now.',
  'drawer-your-apps-toggle': 'Its fold, retired with the section.',
  // ── Streamlined Concept: the notification list left the drawer ───
  // The rows render on the full-screen #notifications view now
  // (notifications-sheet.tsx, its own ids in ADDED_IDS below); the saved +
  // invites sections moved WITH the surface keeping their ids, so only the
  // drawer-specific chrome is gone.
  'notifications-mark-all': 'The drawer block\'s mark-all control; the screen renders its own (#notifications-screen-mark-all), React-wired.',
  'notifications-list': 'The drawer\'s list scroller; the screen renders rows directly.',
  'notifications-empty': 'Drawer-only never-had-one hint; the screen\'s All tab empty state says it now.',
  'drawer-row-app-version': 'Per-dApp SHA removed from platform information; app versions remain on app cards.',
  'app-version-pill-slot': 'Drawer-only per-dApp SHA renderer removed with its row.',
  // ── THE UI OVERHAUL: four header controls became one ──────────────
  // An app is just an app now, and everything you do *to* it lives behind
  // #improve-btn. Each id below moved to a row of that panel rather than
  // simply going away; the behaviour it named is still reachable.
  'app-mode-switch': 'App/Dev segmented switch retired — Dev is a destination the Improve panel links to, not a header mode. Both #app/<slug>/app and #app/<slug>/dev survive as routes.',
  'app-mode-seg-app': 'Segment of the retired App/Dev switch.',
  'app-mode-seg-dev': 'Segment of the retired App/Dev switch.',
  'feedback-btn': 'Header feedback bubble retired — the dialog opens from the Improve panel\'s "Give feedback" row. App.openFeedbackModal is unchanged.',
  'work-drawer-btn': 'Header work cog retired — its session list is the Improve panel\'s two session sections (this app, and an overflow for every other).',
  'work-drawer-icon': 'The cog glyph, retired with its button. The spinning-while-busy cue is the per-row busy dot in the Improve panel now.',
  'dev-console-btn': 'Header terminal icon retired — the Improve panel\'s "Developer terminal" row is shown on the same DevConsole signal. #staging-dev-console-btn survives; the staging overlay has its own chrome.',
  'dev-console-badge': 'Unseen-error count on the retired header terminal icon. #staging-dev-console-badge survives.',
  // ── The version dot's round trip ──────────────────────────────────
  // #1412 renamed #header-menu-deploy-dot to #improve-version-dot and moved
  // it onto #improve-btn; the Streamlined Concept moved it straight back to
  // the hamburger under its ORIGINAL id — the board keeps the hamburger as
  // the badge cluster, and the Improve slot slims to a text action. So the
  // id matches the baseline again and neither map lists it. What #1412
  // actually added is kept: the violet "the platform rolled past the SHA
  // this tab loaded against" state, and a reader
  // (DrawerStatus.refreshDeployDot) that publishes a state through
  // improveStore instead of toggling a class — the dot renders from
  // <MenuIndicators/> in platform-header.tsx now.
  // ── #1367: two Improve rows became a segmented toggle ────────────
  // "Development kanban" and "Latest development activity" were list rows
  // with a chevron. They are two segments of the App/Feed/Kanban control now
  // (frontend/src/features/improve/view-toggle.tsx), which renders inside the
  // panel on a phone and in the header beside #improve-btn on a wide screen.
  // Improve.openDev(mode) — the handler both rows called — is unchanged, so
  // the behaviour each id named is reachable by one tap rather than two.
  'improve-row-kanban': 'Kanban row retired — the "Kanban" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'kanban\') call.',
  'improve-row-feed': 'Feed row retired — the "Feed" segment of the App/Feed/Kanban toggle. Same Improve.openDev(\'feed\') call.',
  // ── THE UI OVERHAUL: three top-right drawers became one ──────────
  // The bell and the cog merged INTO the hamburger. Nothing they carried was
  // dropped without a new home; each entry below names it.
  // (#notifications-btn's own round trip: THE UI OVERHAUL folded the bell into
  // the hamburger, and the Streamlined Concept gives it back its control in the
  // header's right group — the drawer is the APP's surface now, so platform
  // alerting needs a seat of its own. The id matches the baseline again, so it
  // is listed in neither map; what changed is only which panel it opens.)
  'notifications-panel': 'The bell dropdown. features/notifications keeps its store, list components and module — only the panel around them is gone.',
  'work-drawer-panel': 'The cog drawer. Its session list is the Improve panel\'s (this app, plus an overflow for every other); its pinned rows are ordinary notifications in the merged hamburger.',
  'work-drawer-close': 'Close button of the retired cog drawer.',
  'work-drawer-mark-all': 'Mark-all-read of the retired cog drawer — the merged list has one, #notifications-mark-all.',
  'work-drawer-list': 'Body of the retired cog drawer.',
  'work-drawer-empty': 'Empty hint of the retired cog drawer.',
  // ── …and the hamburger itself lost everything that was not navigation ──
  'drawer-row-theme': 'Theme is a SETTING now, and the first one. A live control that changes how the whole product looks is not navigation. See features/settings/sections/theme.tsx — the track keeps its ids, so app.css draws it unchanged.',
  'drawer-status-pane': 'The kudos + AI-credit meters were ambient numbers nobody acts on from a menu.',
  'drawer-row-kudos': 'Kudos is a leaderboard concern; the home screen\'s Challenges area links there.',
  'kudos-budget-slot': 'Slot of the retired kudos row. Kudos.Budget still resolves it by id and no-ops when absent, so the figure can be re-homed without touching the module.',
  'drawer-row-leaderboard': 'Moved to the HOME SCREEN, into the Challenges area\'s header — beside the shared progress it links to, rather than in a menu you open from memory. #leaderboard is unchanged as a route.',
  'drawer-footer': 'The bottom-anchored reference block moved wholesale into the Improve panel: every line in it was about an app, and that panel is the surface scoped to one.',
  'drawer-row-github': 'View on GitHub — an Improve panel row now.',
  'drawer-row-share': 'Share App — an Improve panel row now.',
  // ── Streamlined Concept: the reference footer has no successor ───
  // The block THE UI OVERHAUL carried from the drawer into the Improve panel
  // (and the Streamlined Concept then carried into the drawer again, as
  // #improve-footer) is dissolved. The board draws a drawer of navigation and
  // work only, and every line of that footer was a different KIND of thing
  // wearing the same row: two of them described the platform, two described
  // the app, and exactly one was an action. Each went where it belongs.
  // ── Streamlined Concept: the hamburger, and the rows it held ─────
  // The drawer's app rows merged into the Improve panel — one surface for
  // the app's navigation AND its work, rather than two that half-overlapped —
  // and the button that opened it went with them. The header's left slot is
  // the board's own cluster now: the app glyph (or a back arrow) beside the
  // title tab, both opening the Apps sheet.
  // ── Streamlined Concept, second pass: the two alerting screens
  //    became SHEETS. A screen reachable from every route has to answer
  //    "back to where?", and both answered "home".
  // ── The hamburger, and the drawer it opened, are gone ────────────
  // The Streamlined Concept retired the hamburger button and left the drawer
  // with no trigger — its rows were reachable only through the ?shot=menu
  // capture links, which is why ten declared checks kept passing over a
  // surface no user could open. The whole panel goes; every row it held has
  // a home on a SCREEN now, with an address and a back arrow of its own.
  'header-menu-panel': 'The drawer itself. Its account rows are the Profile screen\'s account group (features/profile/account-panel.tsx), reached from Home\'s account row.',
  'header-menu-overlay': 'Its backdrop.',
  'header-menu-rows': 'Its scroller.',
  'header-menu-close': 'Its close control.',
  'drawer-main-rows': 'The account group inside it — #profile-account now.',
  'drawer-row-profile': 'Profile is #switcher-row-profile, a row of the chip\'s menu (#1443). It went to Home\'s #home-account-row first, which the menu made redundant and Home has since dropped.',
  'drawer-avatar': 'The viewer\'s picture on that row. No surface carries one now: the chip names the APP you are in, and Home\'s copy went with its account row.',
  'drawer-profile-glyph': 'Its fallback glyph, retired with the picture.',
  'drawer-row-settings': 'Settings is #switcher-row-settings, a row of the chip\'s menu (#1443) — it has its own page, and the menu lists everything that does.',
  'drawer-byok-dot': 'The BYOK dot on that row — #switcher-byok-dot. settings.js publishes the flag through the visibility store rather than writing the class by id, because the row renders inside a React-owned subtree.',
  'drawer-row-admin': 'Admin & moderation is #switcher-row-admin, same isAdmin gate, published rather than class-written for the same reason.',
  'drawer-node-dot': 'Its status dot — #account-node-dot. It also stops PRERENDERING: the row renders inside the Profile screen\'s account group, which draws from profile data, where the drawer shipped on every page.',
  'drawer-node-status': 'Its status text — #account-node-status, same note.',
  'drawer-wallet-balance': 'The wallet row\'s balance readout — #account-wallet-balance, same note.',
  'drawer-row-node': 'The native node row — #account-row-node, same component, same module.',
  'drawer-row-wallet': 'The native wallet row — #account-row-wallet, ditto.',
  'notifications-screen': 'The Notifications screen ROOT. It is #notifications-sheet now — an overlay over the current screen, out of App.SCREEN_IDS entirely, so there is no back arrow to point anywhere. Its children kept their ids.',
  'header-menu-btn': 'The hamburger. Its slot is the app-glyph/back-arrow pair (features/header/header-app-icon.tsx + #back-btn), and its badge cluster moved to #improve-btn — the control whose panel actually holds the work those badges report.',
  'header-menu-deploy-dot': 'Renamed #improve-version-dot with that move. A `header-menu-*` id on the Improve button would be a lie that outlives everyone who remembers it.',
  'drawer-app-rows': 'The app rows\' scroller in the drawer. The Improve panel renders them now, and #improve-sessions is the scroller.',
  'app-context-new-change': 'Merged INTO #improve-row-new-session, the panel\'s middle quick action. Two ids calling one Improve.startSession() was the duplication the merge exists to remove.',
  'improve-row-share': 'Share app is the Improve panel\'s third action (features/improve/improve-panel.tsx) — the one line in that footer that was an action rather than a reference. Same id, same `canShare` gate.',
  'drawer-row-app-fork': 'Fork lineage renders on the app\'s page from the detail descriptor (features/apps/browse-detail.tsx, #browse-detail-fork) — lineage is a fact about an app, not about the drawer you have open.',
  'app-fork-badge-slot': 'Slot AppView.renderForkBadge wrote into. Both the function and App.DrawerStatus.setForkVisible are gone with it.',
  // ── THE UI OVERHAUL: the home screen's widgets became four fixed areas ──
  // Discover, Challenges and Create app were draggable blocks on the launcher
  // canvas; they are sections in a fixed order under the grid now, so the
  // hosts and settings that existed for the PLACEMENT go with it.
  'home-panels': 'The widgets\' stacked FALLBACK host below the grid. It caught the moment before the first grid paint and the active-search view, because a block that lived IN #app-list vanished whenever #app-list did. The three sections are outside it and never re-rendered by a search keystroke, so there is nothing left to catch.',
  'settings-home-panels-section': 'Settings → Home screen widgets. A checkbox per widget only made sense while the blocks were optional furniture a viewer arranged; they are three fixed areas of the screen now. The ⋮ menu on a block still hides one, and POST /api/home-panels/:key/visibility is untouched.',
  'settings-home-panels-list': 'The checkbox list inside that retired section.',
  'settings-home-panels-status': 'Save/error line of that retired section.',
  // ── Andrea's simpler waitlist flow: joining is email-only ─────────
  // "Link something you've made" was a REQUIRED stage-1 field, which
  // contradicted the flow the onboarding doc settled on and that Andrea
  // and Evan agreed in its comments ("Just an email!"). The question is
  // not gone — it moved to the stage-2 "Want in sooner?" form as
  // #more-made-url / #more-made-note, where it is one of the things that
  // helps you move up rather than a gate on joining.
  'waitlist-made-url': 'Moved to the stage-2 survey as #more-made-url; joining no longer asks it.',
  'waitlist-made-note': 'Moved to the stage-2 survey as #more-made-note, with its url field.',
  // ── Andrea's simpler waitlist flow: the invite link is real now ────
  // The five typed-address rows collected emails and did nothing with
  // them: no invite was sent, no attribution was recorded, no count was
  // ever shown. They are replaced by a share link whose joins ARE
  // attributed (waitlist_signups.invited_by), which is the mechanic the
  // doc asks for. Nothing that worked was removed, because nothing here
  // worked.
  'more-invites': 'Typed-address invite rows retired for the share link (#more-invite-url); they sent nothing.',
  'more-invite-add': 'The "add another" button for the retired invite rows.',
  // ── The buddy checkbox promised something nothing delivered (#1534) ──
  // "Only let me in when at least one person from my link gets in too"
  // was stored on the answers blob and read by no admission path, so it
  // held nobody back and let nobody in. The invite link beside it, and
  // the copy saying we try to admit people together, are untouched.
  'more-admit-together': 'The "only let me in when someone from my link gets in too" checkbox. Nothing read the flag, so the promise it made was never kept; the field is dropped on input the way #more-invites was.',
};

// Ids a conversion chunk deliberately added, each with the reason.
const ADDED_IDS = {
  'dev-ws-rail-host': 'Empty anchor outside the frosted .dc-lift-strip wrapper, so the Workshop\'s phone tab bar can be `position: fixed` to the real viewport. That wrapper\'s backdrop-filter establishes a containing block for fixed descendants — walking the rail\'s real ancestor chain it is the only one — and it is shared with the chat/topic frames and three panels, so the bar moves out rather than the blur coming off.',
  'staging-retry-btn': '#1993: retry preview sign-in after token acquisition fails; initially hidden.',
  // ── OpenRouter catalog controls ──────────────────────────────────
  'settings-openrouter-model-search': 'Filters the key-visible OpenRouter catalog by model name, id or provider without another network request.',
  'settings-openrouter-favorites-only': 'Limits the settings picker to the viewer\'s saved OpenRouter model favorites.',
  'settings-openrouter-refresh-models': 'Forces a fresh key-visible catalog from OpenRouter and reports when it was refreshed.',
  'settings-openrouter-star-model': 'Adds or removes the selected OpenRouter model from the viewer\'s persistent favorites.',
  'settings-openrouter-catalog-meta': 'Shows the visible and total model counts plus catalog freshness beside the picker.',
  // ── #1538: check my status ────────────────────────────────────────
  // The waitlist confirm step doubles as "read where I stand", so the panel
  // that used to print one fixed sentence now prints what the row actually
  // says. Four of the five ids are inside #waitlist-confirmed; the fifth
  // is the landing page's way in.
  'waitlist-status-pill': 'The three-state queue pill on #waitlist-confirmed, rendered from the SAME table as the stage-2 screen\'s #more-status-pill (waitlist-shared.tsx) so one row cannot be described two ways. Always in the markup and hidden until a code lands: the prerender has no status, and contents rendered before the fetch are a hydration mismatch, which console.errors and fails proposal checks.',
  'waitlist-status-since': 'The joined-on date, offered in place of the queue position this panel deliberately does not show. Nothing on the platform ranks the waitlist (services/waitlist-signals.js computes no score on purpose), so a number would be invented; the date is a fact the row actually holds. Same always-present, hidden-until-filled contract as #waitlist-confirmed-email beside it.',
  'waitlist-status-action': 'The one thing a RELEASED signup can act on: Create my account (#signup) or Sign in (#login), chosen on whether the invite has already been redeemed. Before this, somebody who lost the access-ready mail was told by this panel to keep waiting for it. Hidden for a signup that is still queued.',
  'waitlist-confirmed-headline': 'The panel\u2019s emerald headline, named because it is CONDITIONAL now rather than constant. The card serves two arrivals: somebody who just joined and confirmed, and somebody who typed their address to read where they stand. Congratulating the second one restates what the pill below already says and reads as a system that has lost track of when they joined, so the headline is the confirm path\u2019s and the pill is the status path\u2019s, split on the codeOnly state that already separates the two everywhere else on this screen. Visible in the prerender, which is the shape the hand-written shell shipped.',
  'landing-status-link': 'The landing card\'s "Already joined? Check your status" link, into the same code-entry step #waitlist-enter-code opens. It is the entry point for the case the issue is about — checking from a device that knows nothing about the signup — and it is on the landing page because that is where such a device arrives. Hidden for a session, like the CTA above it.',
  // ── #1876: the check-my-status errand is two steps ────────────────
  // It asked for the address and the six-digit code in one breath, and the
  // control that actually SENT the code was a tertiary "Didn't get it?" link
  // underneath the field. Split, on the codeOnly path only: the post-join
  // path is untouched, because there the join WAS step 1.
  'waitlist-confirm-address': 'Step 1 of that errand: the address, the send, and its own status line. A wrapper rather than a set of per-element class expressions, because the whole half comes and goes together; and a wrapper rather than `display: contents`, which `.hidden` cannot override. Ships hidden: nothing here is on screen until somebody asks to check their status.',
  'waitlist-confirm-code': 'Step 2: the six-digit field, the resend and the way back, which is everything #waitlist-confirm used to hold on its own. Visible in the prerender, because that is what the hand-written shell shipped and what the post-join path still shows; the split only hides it while the address step is up.',
  'waitlist-request-code': 'The address step\u2019s primary action, and the promotion the issue was about: sending the code is what somebody came here to do, so it is a filled button rather than a footnote under the field. Its cooldown and its label are the resend\u2019s, because it is the same request to the same endpoint.',
  'waitlist-request-note': 'That step\u2019s own status line. Separate from #waitlist-resend-note so the two cannot overwrite each other: a request that failed says why here and stays put, and one the server accepted advances and says so on the next step, beside the field it is about.',
  'waitlist-have-code': 'For the reader who arrived from the status mail with a code already in hand. It sends NOTHING on purpose: issueVerificationCode deletes every unconsumed code for an address before minting the next one, so making this button send would invalidate the code in the inbox of the very person who followed that mail here.',
  'waitlist-change-email': 'The way back from the code step to the address step, for the address that was a typo. It assigns the fragment rather than only setting state, so the browser\u2019s own Back does the same thing and the URL and the screen cannot disagree.',
  'feedback-form': 'The existing feedback form is hidden while the first-feedback confirmation is visible (#1583).',
  'feedback-first-success': 'Persistent first-feedback confirmation inside the existing feedback dialog (#1583).',
  'feedback-first-title': 'Accessible heading congratulating the first feedback submission (#1583).',
  'feedback-first-notice': 'Preserves the successful filing and optional bounty outcome in the first-feedback confirmation (#1583).',
  'feedback-first-fix': 'Starts an editable fix draft for the feedback issue (#1583).',
  'feedback-first-fix-note': 'Explains the fix draft or the collaboration access requirement (#1583).',
  'feedback-first-board': 'Opens the board of the app that received the feedback (#1583).',
  'feedback-first-done': 'Dismisses the first-feedback confirmation without starting work (#1583).',
  'improve-working-dot': 'What is left on #improve-btn once the session COUNT moved to the bell (#1610): a bare 8px emerald pulse, rendered only while a dev session the viewer can see is mid-turn. It carries no text and no count, because that is the distinction the move was about — a count is an event waiting to be read and belongs where reading happens, while "a turn is running right now" is a live fact about this button that needs no dismissal. Top-right, so it cannot hide under the bottom-left outbox dot.',
  'wallet-recovery-modal': 'Native-only recovery for a pre-merge email wallet when authoritative session admission reports that the seeded wallet pool is empty. Opened ONLY from Settings → Usernode app → connection ("Connect existing wallet"); it used to open itself on every failed admission attempt, which is the pop-up that was reported.',
  // ── Home area labels: the block chrome moved above the card ──────
  'home-browse-btn': 'Discover\'s way into the #apps directory. Not a new control — it has always been the block\'s browse link — but it is in the COLD DOCUMENT now, which is why it is a new id here. The block\'s title moved out of the card to become the section\'s label, its controls followed (a card whose first row was chrome with one link floating at the end of it reads worse than one that opens on content), and a section heading is constant markup where the block behind it is fetched. So the control ships with the shell instead of appearing when /api/home-panels answers — which is also one less thing that pops in on a cached load.',
  // ── Platform UI pass: the update state, and where the versions live ──
  'improve-btn-glyph': 'The Improve button\'s leading glyph, and a named element rather than a bare <svg> so a declared check can read `data-state` off it. Three states, one per thing worth knowing at a glance from a control that is on every screen: a lightbulb at rest, a spinner while this app or the platform is building or downloading a build, and an arrow-path once one is ready to reload onto. It is `w-4`, inside the 28px content row, so the header height contract is untouched.',
  'settings-about-section': 'Settings → About: the three version rows. They have moved twice before (#1431 built an About block, #1443 took them to the Improve panel\'s footer). They are back because the question they were being read for — "is something happening, and is there a new version yet" — is answered directly by that footer now, as a note and a reload button. What is left over is reference material, and this is the reference screen.',
  'about-row-app-version': 'The open app\'s latest merged main, in that pane. Gated on `slug && !selfHosted`, exactly as the Improve panel\'s copy was: on the platform\'s own app this row IS the platform, so it and "Platform version" under it printed the same seven characters twice.',
  'about-app-version-slot': 'Its value. A store-fed island rather than a legacy innerHTML target — the pane around it is static, and a version arriving when an app opens should repaint one row, not the settings screen.',
  // ── Andrea's 27 Aug 2026 waitlist review: "Follow along" ────────
  'more-follow-row': 'Holds the "Follow on X / LinkedIn / Instagram" links on the stage-2 form. Empty in this document by design: each link renders only when WAITLIST_FOLLOW_<NETWORK>_URL is set, so an unconfigured network shows nothing rather than a dead profile link.',
  'more-followed': 'The "I followed along" checkbox, stored as `answers.followed_claim`. It is a SELF-REPORT and is deliberately kept out of `answers.verified`: LinkedIn returns aggregate follower statistics with no identity, Instagram exposes a count and no relationship lookup, and X retired its boolean friendship endpoint, so no network will confirm a follow for us. Hidden here because its label is shown only once at least one follow URL is configured.',
  // ── #1443: what came back ───────────────────────────────────────
  'messages-screen': 'The Messages screen root, restored. #1431 made it #messages-sheet because a header chat bubble on every route left a full-screen Messages with no honest answer to "back to where?" — the bubble is gone and Messages is a menu row now, so the screen is both the honest shape and the one every messaging product uses for reading past conversations.',
  'improve-footer': 'The panel\'s reference block, restored. #1431 dissolved it and rehomed each fact separately; every move was defensible alone and the sum meant leaving the app to read facts about the app you were standing in.',
  'drawer-row-native-app-version': 'The installed Flutter release, back in that footer. #1431 renamed it #about-row-native-app-version for the Settings About block it built; the block is gone with the rows it existed to hold, so the name goes back too. `.drawer-ver-row` is the shared CSS recipe, not a claim about a drawer.',
  // ── #1443: the app's own views stayed in the Improve panel ──────
  // They spent one round of #1443 as menu rows, on the argument that they are
  // destinations. They came back: the menu answers WHICH APP, and these answer
  // WHICH PART OF IT, which is the question the panel you open from inside an
  // app is already about.
  //
  // There were three. `#app-context-row-board` went the way of the Activity
  // segment before it: the Workshop and the kanban are ONE screen in two
  // layouts, so the strip was offering a layout where its other segments offer
  // destinations. Like other post-baseline ids it simply leaves this map
  // rather than entering RETIRED_IDS. The board route is untouched.
  'improve-views': 'The block holding them. #1431 built it; #1443 kept it.',
  'app-context-row-app': 'View and use the app — Improve.openApp(). Labelled Home on the self-hosted platform row.',
  'app-context-row-workshop': 'The app\'s Workshop — the lander, and the strip\'s only Dev segment: the same cards the kanban draws, grouped by theme, with the vote and since-last-visit strips above them. Replaced the Activity segment, then outlived the Board segment.',
  // ── #1443: the chip and its menu ────────────────────────────────
  'app-switcher-btn': 'The chip: the header\'s label on EVERY screen, and the one control that opens a list. #1431 built this as #header-title-tab but gated it on being inside an app; the gate is the whole difference, and losing it is what let #header-menu-btn, #back-icon-home and #messages-btn all go. It carries the same tinted 28px surface as #back-btn and the bell, because on the bare page ground it read as the heading it replaced.',
  'app-switcher-name': 'The label inside the chip — the same text #header-title carried as a bare heading, now a named slot so a declared check can assert WHAT the chip says and not merely that it exists.',
  'switcher-nav': 'The menu\'s destination list, and its ONLY vertical scroller. The app strip above is horizontal and therefore vertically bounded, so no number of apps can push a destination out of reach — the clipping bug that hid Home and Profile on a 39-app account cannot occur in this shape.',
  'switcher-row-home': 'Home. Was the sheet\'s #apps-switcher-home footer button.',
  'switcher-row-discover': 'Discover (#apps). Was #apps-switcher-explore.',
  'switcher-row-messages': 'Messages. Was #messages-btn in the header; it has its own page, so it is a row. Carries NO count: a message notification is counted on the bell and listed in the notifications sheet with every other notification, which leaves this a plain destination like Home and Discover beside it.',
  'switcher-row-profile': 'Profile.',
  'switcher-row-settings': 'Settings. Was #profile-row-settings on the Profile screen.',
  'switcher-byok-dot': 'The BYOK dot on that row — was #profile-byok-dot. settings.js publishes the flag; the className stays a constant.',
  'switcher-row-admin': 'Admin & moderation. Was #profile-row-admin. Ships `hidden`; App.renderAdminButton publishes the isAdmin flag, unchanged.',
  // ── …and the Apps sheet behind the title tab ─────────────────────
  'apps-switcher-sheet': 'The board\'s Apps sheet — its "Switching between Apps" connector. Reuses the retired #app-context-sheet\'s controller, store and kit bottom-sheet lifecycle.',
  'apps-switcher-overlay': 'Its backdrop.',
  'apps-switcher-close': 'Its close control.',
  'apps-switcher-create': 'The sheet\'s "Create New" action.',
  'apps-switcher-list': 'The horizontal strip of the viewer\'s apps.',
  // ── Streamlined Concept: the drawer leads with Your apps ─────────
  // ── Andrea's simpler waitlist flow ────────────────────────────────
  // The relocated join question (see RETIRED_IDS above).
  'more-made-url': "The \"link something you've made\" field, relocated from the join form (was #waitlist-made-url).",
  'more-made-note': 'Its one-line description (was #waitlist-made-note).',
  // The doc asks for "Email + verification code". The mailed link still
  // works and confirms the same row; the code exists for the phone, where
  // leaving for the mail app and back loses the WebView's place.
  'waitlist-confirm': 'The confirm-your-email block on the join success state. Hides once the code is accepted.',
  'waitlist-code': 'Six-digit email verification code; confirms the same row the mailed link does.',
  'waitlist-code-submit': 'Submits the verification code.',
  'waitlist-enter-code': 'Step-1 link to the confirm step, for somebody who joined earlier and whose 15-minute code expired. Before it, that control was reachable only by submitting the join form again.',
  'waitlist-confirm-email': 'The address the code belongs to, asked for only when the confirm step was reached without a join. Hidden after a join, where the form field still holds it.',
  'waitlist-resend': 'Requests a fresh confirmation code (POST /api/public/waitlist/resend). Disabled for the advertised 60-second gap.',
  'waitlist-resend-note': 'The resend result, kept apart from #waitlist-msg so a wrong code and a resend answer cannot overwrite each other.',
  // The share link that replaced the typed rows (see RETIRED_IDS above).
  'more-invite-url': "The signup's shareable invite link; joins through it set waitlist_signups.invited_by.",
  'more-invite-copy': 'Copies the invite link to the clipboard.',
  'more-invite-joined': 'How many people joined through this link. Empty until the stage-2 load effect fills it.',
  // ── The two-step waitlist: each step of the join ends visibly ────
  // The join screen stacked three states in one column and only the middle
  // one ever ended: the pitch stayed up after a join, and a correct code
  // merely HID #waitlist-confirm with nothing taking its place. Five ids,
  // all additive — nothing is retired, so every dapp.json selector on this
  // screen still resolves.
  'waitlist-step': 'The step line above the title: "Step 1 of 2 \u00b7 Your email" \u2192 "Step 2 of 2 \u00b7 Confirm your email" \u2192 "All done". Hidden for a waiting-room session, which gets #waitlist-queued instead of a flow it is already past. Two steps, not three: the stage-2 survey is optional and counting it would read as required.',
  'waitlist-confirmed': 'The panel that replaces #waitlist-confirm once the six-digit code is accepted. Before it, `confirmed` only removed the block being typed into, and a control that disappears without a word reads as a failure.',
  'more-saved': 'The stage-2 survey\'s ending. A successful save wrote one line into #more-msg and left the whole three-minute form on screen under a heading still asking "Want in sooner?"; this panel takes the screen instead. #more-msg survives for the error and ?connect= cases.',
  'more-saved-edit': 'Returns to that form with every value still in place \u2014 the form is hidden, never unmounted, and answers merge server-side, so adding to them later is the intended path rather than a recovery.',
  'more-saved-back': 'The way out of the ending, to #landing.',
  'more-status-pill': "Where this signup stands in the queue, on the stage-2 form: waiting for confirmation, on the waitlist, or you're in. It is not a new fact \u2014 the row's submitted_at / confirmed_at / released_at have always said this \u2014 it is the first place the person it is about can read it, and it answers the question the survey otherwise leaves open ('I filled this in, then what?'). Present but empty and hidden here by design: the row ships in the markup, and its contents arrive with the stage-2 load effect, because a pill with data in it before the fetch would be a hydration mismatch.",
  // ── #1537: both "you're on the list" surfaces name the address ───
  // Every other fact about a signup was on screen and the one people wrote in
  // about was not: which address they had used. Both ids are always in the
  // markup and `hidden` until there is an address to name, the same contract
  // #more-status-pill above documents — a line that reads "Registered with"
  // and then stops is worse than no line.
  'waitlist-confirmed-email': 'The address inside #waitlist-confirmed, on the join flow. Read from the same client-side value the confirm step already echoes, so no request was added; it is stored lower-cased now, matching what the server normalizes and stores, so this surface and the stage-2 one cannot disagree about the same address.',
  'more-signup-email': "The address on the stage-2 form at #more/<token>, beneath the queue pill. This screen is where the mailed confirm link lands, so it is the surface a RETURNING visitor sees, and it has no client-side memory of the join to read — the value is a new `email` field on the full GET /api/public/waitlist/more/:token payload, which discloses nothing: the 48-hex token is only obtainable by joining with that address or receiving the join mail at it. Plain text, never a mailto: anchor.",
  // ── #1372: the mobile-browser install strip ──────────────────────
  // A visitor on a phone browser is offered the native app. The strip is
  // always in the document and starts `hidden` (the island rule: data loads
  // in effects, so the first render must match the prerender), which is why
  // these ids are present here even on a build where no store listing has
  // been published and the strip can never show.
  'mobile-install-banner': 'The phone-browser strip offering the native app (#1372). Sits under #offline-banner and stacks with it.',
  'mobile-install-open': 'The strip\'s primary control. An anchor to the store when a listing is published for this OS (href from app_version_configs.update_url via GET /api/public/mobile-app); a button revealing the Add-to-Home-Screen steps when none is (#1513).',
  'mobile-install-dismiss': 'Dismisses the strip for this session; the answer is kept in sessionStorage, so the next visit is offered the app once more (#1514).',
  // #1561 — the once-per-account welcome on Home. A new account lands on a
  // launcher grid of other people's apps with nothing on the screen saying
  // what the place is, so the banner states it: the apps are changed by the
  // people using them, and nothing ships without a group vote. Like the
  // install strip above, it is always in the document and starts `hidden`,
  // because the viewer is not known at prerender time.
  'home-welcome': 'The dismissible first-login explainer at the top of #home-body (#1561).',
  'home-welcome-dismiss': 'Dismisses it for good, per account: the answer is kept in localStorage under the viewer\'s user id.',
  // #1281 — the session-CLI bridge opt-in. The spec marks that venue
  // settings-gated and "most users: no", so the gate needs somewhere to
  // live: Settings → Experimental, beside the other per-user preview flag.
  'session-bridge-enabled': 'Opt-in switch for the session-CLI bridge venue (#1281).',
  'session-bridge-status': 'Save/error line for the session-bridge switch (#1281).',
  // Username changes — Settings -> Username, the change-your-@handle form. It sits in
  // Settings rather than the profile edit sheet because the endpoint requires
  // the current password, which is the same reason Change password is here.
  'change-username-section': 'Settings -> Username section wrapper.',
  'cu-current': 'The handle the viewer holds right now, painted by Settings._renderChangeUsernameSection.',
  // The `cu-` prefix mirrors the `cp-` one the change-password controls
  // beside them have always used — and stays clear of the native kit's
  // `.un-*` class vocabulary.
  'cu-new': 'Requested new handle.',
  'cu-password': 'Current password, required by POST /api/me/username.',
  'cu-save': 'Submit for the username change.',
  'cu-status': 'Status line for the username change.',
  'settings-mobile-push-preferences': 'Account-level Social mobile-push category controls in Settings → Alerts.',
  // (#1412's #improve-version-dot came and went: the Streamlined Concept
  // returned the version cue to the hamburger under its original
  // #header-menu-deploy-dot id — see the note in RETIRED_IDS.)
  // ── #1191: the build-flow preference stops being injected ────────
  // These three were BUILT AT RUNTIME by Settings._renderDevFlowSection,
  // which created the block and inserted it into the Connections pane on
  // every render. The reason was this very baseline: the shell's body used to
  // be a hand-written document, so a new settings control had nowhere to go.
  // The pane is a component now, so the block is markup and its ids are a
  // deliberate line here — which is also what stops a legacy module writing
  // into a subtree React owns.
  'dev-flow-pref-section': 'The "Preferred build flow" block in Settings → Connections (#1049) — the escape hatch for the dev-chat picker\'s "remember my option" checkbox.',
  'settings-dev-flow': 'The build-flow dropdown itself. Settings binds its change and gates the two hand-off options on whether the deployment has external flows.',
  'settings-dev-flow-status': 'Save/error line for the build-flow dropdown.',
  'cli-setup-guide': 'Always-visible local-agent setup in Settings → CLI access (#1609). It is static section markup so capability detection and credential-list state cannot blank the instructions.',
  'native-app-version-slot': 'Mobile app version/build rendered through the native bridge (#1101).',
  'feedback-queue-dot': 'Header dot for feedback saved offline and still waiting to send (#1054).',
  'feedback-screenshot-picker-btn': 'Photos fallback for mobile feedback screenshots (#824).',
  'feedback-screenshot-input': 'PNG/JPEG picker backing the mobile feedback fallback (#824).',
  // ── #1603: the description's requirement, said out loud ─────────
  // The field was always mandatory — submitFeedback returned early on an
  // empty one — but nothing on screen said so and the refusal was a bare
  // `return`, so Submit read as broken. Four additive ids: two that state
  // the rule before you type, one that states it back on the field when it
  // is broken, and one naming the field that is NOT required, because
  // marking one of two fields required only reads as a rule if the other's
  // silence is deliberate rather than an omission.
  'feedback-text-label': 'The Description label on #feedback-text, which had a placeholder and no label at all. Also the anchor the declared check selects the asterisk through, so the marker is asserted where a reader would look for it rather than anywhere on the card.',
  'feedback-text-required': 'The red asterisk inside that label. `aria-hidden` because the accessible requirement is carried by aria-required on the field itself, and a screen reader announcing "star" adds nothing to that.',
  'feedback-text-error': "The inline refusal under the description: \"Please add a description.\" Deliberately its OWN node rather than a fifth writer of #feedback-status, which has an explicit newer-and-more-specific-wins rule (paintQueueState) that would either swallow this message or let it erase the offline hint. Ships empty and hidden, like #feedback-status: the controller owns the text, and a message rendered before the submit that earns it would both lie on open and mismatch on hydration.",
  'feedback-title-label': 'The Title label, marked optional. The title generates itself from the description and the server names the issue when it is blank, so its emptiness is a working state - which is worth saying next to a field that is now visibly required.',
  // ── THE UI OVERHAUL: the Improve panel ───────────────────────────
  // One surface for everything you do *to* the app on screen rather than
  // *with* it. It absorbed four header controls (see RETIRED_IDS above)
  // plus the drawer's Share action. Fully React-owned,
  // so unlike most of the shell it holds real state — nothing in
  // public/js/** writes a node inside it.
  'improve-btn': 'Header control that opens the Improve panel; inherits the retired App/Dev switch\'s show/hide lifecycle (App.DrawerStatus.setAppOpen).',
  'improve-overlay': 'Backdrop behind the Improve panel. Never uses `hidden` — opacity fades it and pointer-events stops a closed backdrop eating clicks.',
  'improve-panel': 'The panel root. Right-edge slide-over at `sm` and up, bottom sheet below it, and a real native-kit sheet on touch where the kit is loaded.',
  'improve-target-name': 'Which app the panel is about — the platform\'s own row on the home screen.',
  'improve-close': 'Close button in the Improve panel header.',
  'improve-body': 'The panel\'s scroller.',
  'improve-row-feedback': 'Opens the feedback dialog — the retired #feedback-btn.',
  'improve-quick-actions': 'The panel\'s three circular actions — Feedback, New change, Share — captioned beneath so three fit across a phone.',
  'improve-sessions': 'The changes in flight, here and on the viewer\'s other apps — and the panel\'s ONE scroller, which is what keeps the actions and the views on screen at any height.',
  // #improve-version-dot is NOT here any more, and did not move: it is
  // retired. Amber while a build was deploying or downloading, violet once
  // one was here to reload onto — and the button's LEADING GLYPH already
  // draws the spinner for exactly the amber pair and the arrow-path for
  // exactly the violet one, off the same `versionState`. Two cues for one
  // fact, one of them 8px of colour whose meaning depends on which colour
  // it is. `Improve.setVersionState` and the store field stay; the second
  // renderer is what went. It never reached tests/baselines, so it leaves
  // this map without entering RETIRED_IDS.
  'improve-row-new-session': 'Starts a dev session — the Dev "+" menu\'s "Propose a change".',
  'settings-theme-section': 'The Theme settings pane\'s inner node, matching every other section\'s wrapper/inner pair.',
  // ── THE UI OVERHAUL: the home screen's four areas ────────────────
  // Your apps, Discover, Challenges, Create app — stacked, in that order.
  // The last three were draggable widgets on the launcher canvas; each is a
  // fixed <section> host now, carrying the same `data-panel-slot` key its
  // grid host did so the dapp.json checks still select on it.
  'home-apps-section': 'Wraps the launcher grid and its "Show all" control, so area 1 is a section like the other three.',
  'home-apps-more': '"Show all N apps" — revealed only when a viewer has more than the two-row default shows. The cap is on what is DRAWN, never on what they may have.',
  'home-discover-section': 'Area 2: featured tiles, the Popular lane and the way into the app directory.',
  'home-challenges-section': 'Area 3: the season\'s open challenges, and under them the leaderboard standings the retired #drawer-row-leaderboard used to point at.',
  'home-create-section': 'Area 4: the create-an-app block, on every home screen regardless of quota.',
  // #1082 chunk E — the admin console's CHASSIS. These ids are not new to the
  // running page: admin-console.js._renderShell() has always created them, by
  // writing #admin-root.innerHTML on every open. They are new to
  // public/index.html because the chassis is React-owned markup now, so it is
  // prerendered instead of assembled at mount. Nothing below them moved —
  // #admin-section-content is still an innerHTML host owned by the module.
  'admin-nav-desktop': 'Admin console desktop sidebar host, empty until AdminConsole._renderShell fills it (#1082).',
  'admin-view-only-banner': 'Admin console view-only banner (#311), ships hidden and is toggled through classList (#1082).',
  'admin-section-content': 'Admin console section host — the phone level-1 menu and every section render into it (#1082).',
  'admin-temp-pw-modal': 'Admin console temporary-password dialog root (#282), now static React markup (#1082).',
  'admin-temp-pw-username': 'Recipient name in the temporary-password dialog (#1082).',
  'admin-temp-pw-value': 'The one-time plaintext temporary password (#1082).',
  'admin-temp-pw-copy': 'Copy button in the temporary-password dialog (#1082).',
  'admin-temp-pw-close': 'Done button in the temporary-password dialog (#1082).',
  // #1085 chunk H, step 2 — the ONE new id in the chunk. #app-content keeps its
  // id, its classes and its role as a hand-written innerHTML host; the embedded
  // app's iframe moves out from under it into this React-owned sibling, because a
  // region may only become stateful when its whole subtree is React-owned and
  // #app-content is written by half of public/js/**. Ships hidden and empty, so
  // the prerendered document is unchanged in what it renders. Exactly one of the
  // two is visible; both are flex-1 + min-height:0 children of #app-view's
  // column flex, so the visible one gets the box #app-content used to have.
  'app-frame-host': "React-owned host for the embedded app's #app-iframe, a hidden empty sibling of #app-content (#1085).",
  // #1218 follow-up — the "Stop the permission prompts" block in
  // Settings → Connectors. Static markup with a copy button, the same shape
  // as #connector-url / #connector-url-copy directly above it. It exists
  // because the scaffolded .claude/settings.json fixes one repo at a time and
  // the user's personal ~/.claude/settings.json is the only thing that fixes
  // every repo at once — so the block has to be somewhere they can copy it.
  'connector-prompt-help': 'Settings → Connectors block explaining how to stop the per-call connector permission prompts (#1218).',
  'connector-allow-rules': 'The three read-only allow rules, rendered for copying into a personal ~/.claude/settings.json (#1218).',
  'connector-allow-rules-copy': 'Copy button for that block (#1218).',
  // #1607: the two product walkthroughs below the connector URL are six and
  // seven steps, and the reported cost was reading them. These open a new
  // chat pre-loaded with the server URL and the job, so the assistant that
  // will use the connector answers "where is that button" instead. The href
  // is written by Settings._renderConnectors() from the live #connector-url
  // value, never hardcoded, so a fork shows its own.
  'connector-open-claude': 'Settings → Connectors link opening a pre-loaded Claude chat to walk through connector setup (#1607).',
  'connector-open-chatgpt': 'The same for ChatGPT (#1607).',
  // The in-chat setup tip fired once in production and locked itself out, and
  // the panel it points at had one flaw of its own: a single block headed "add
  // this to ~/.claude/settings.json", which is the wrong file for Claude Code
  // on the WEB — that container is built fresh, so nothing from the user's
  // machine is in it and only the repo's committed copy travels. So the block
  // became three labelled cases with a second copy block for the per-repo
  // file, plus a read-only line reporting the tip's own throttle state.
  //
  // The three case ids are toggled by Settings._renderConnectorCases() and
  // render VISIBLE, so a client name it cannot classify — or a page whose
  // script has not run — shows every case rather than none.
  'connector-case-cc-local': 'Settings → Connectors case for Claude Code on the user\'s own machine (personal settings file).',
  'connector-case-cc-web': 'Settings → Connectors case for Claude Code on the web, where only the repo\'s committed file travels.',
  'connector-case-chat': 'Settings → Connectors case for Claude.ai chat and ChatGPT, which have no per-call prompts to stop.',
  'connector-repo-allow-rules': 'The same three rules, rendered for committing as a repo\'s .claude/settings.json.',
  'connector-repo-allow-rules-copy': 'Copy button for the per-repo block.',
  'connector-hint-status': 'Read-only status of the in-chat setup tip; ships empty and hidden, filled by Settings._renderConnectorHint().',
  // A permission rule names the MCP server LITERALLY — there is no
  // `mcp__*__` — so a connector registered under any name but the one the
  // shipped rules were written for matches none of them, prompts on every
  // read, and produces no error saying why. Usernode now ships both
  // spellings it can predict (`usernode` and `Usernode`); this field covers
  // everything it cannot, because the user is the only party in the exchange
  // who can see what their tools are actually called. Typing a name rewrites
  // BOTH blocks above in place, so the copy buttons already there pick up the
  // corrected rules — hence a field and no button of its own.
  'connector-name-spelling': 'Settings → Connectors input that rewrites both allow-rule blocks for a connector registered under a different server name (#1222 follow-up).',
  'messages-create-dialog': 'React-owned direct/group conversation creation dialog (#488).',
  'messages-members-dialog': 'React-owned group membership and invitation dialog (#488).',
  'messages-share-dialog': 'React-owned typed Usernode item chooser for Messages (#488).',
  'notifications-saved': 'Pinned "Saved" section at the top of the bell drawer, holding the messages this user bookmarked (#1280).',
  // #1344 — eligible users may claim one company-funded OpenRouter key.
  // These are static settings controls; settings.js owns their state. The
  // four plaintext reveal controls originally added here were removed when
  // company-funded credentials became internal-only; like other post-baseline
  // ids, they leave this map rather than entering RETIRED_IDS.
  'settings-openrouter-managed-card': 'Included managed OpenRouter key status and claim card (#1344).',
  'settings-openrouter-managed-message': 'Eligibility/ownership/status copy for the included key (#1344).',
  'settings-openrouter-claim': 'One-time managed child-key provisioning action (#1344).',
  'settings-openrouter-personal-controls': 'Personal-BYOK controls hidden while a managed key owns the credential slot (#1344).',
  // #1383 — the #apps directory's Sort control. It rides INSIDE
  // #browse-search-bar rather than in a strip of its own: both narrow the
  // same list, and one sticky row costs the phone less of the fold than two.
  // The <select> is controlled off browse-store's `sort`, so the remembered
  // choice, a ?sort= deep link and a hand change all show the same value.
  'browse-sort-bar': 'Sort row inside the browse search bar (#1383).',
  'browse-sort-select': 'The five-order Sort control for the all-apps directory (#1383).',
  // ── Streamlined Concept: the Board Filters dialog ────────────────
  // The Figma board (Streamlined Concept / Dev Sessions and Navigation)
  // moves the Board's filter selects and the needs-vote toggle off the
  // filter bar into a dialog; the bar keeps search and gains a
  // `Filters (n)` chip plus dismissable active-filter chips (those are
  // runtime-injected, so only the dialog's ids land in the shell).
  'board-filters-modal': 'The Filters dialog root — tenth shell dialog, same useDialog/static-modal contract as the nine.',
  'board-filters-priority': 'Priority select inside the Filters dialog (was #dev-kanban-priority on the bar).',
  'board-filters-category': 'Category select inside the Filters dialog (was #dev-kanban-category on the bar).',
  'board-filters-assignee': 'Assignee select inside the Filters dialog (was #dev-kanban-assignee on the bar).',
  'board-filters-needsvote': 'The "Needs my vote" switch inside the Filters dialog (was the bar chip #dev-kanban-needsvote).',
  'board-filters-done': 'The dialog\'s Done button — applies the staged filters via AppView.applyKanbanFilters.',
  // ── Streamlined Concept: the app-context sheet ───────────────────
  // The surface behind the header's "app name ⌄" tab: the app's three
  // views, its changes in progress/elsewhere, and the reference footer
  // (which moved here from the Improve panel keeping its ids).
  // ── Streamlined Concept: the full-screen Notifications view ──────
  // A real screen behind the drawer's Notifications row, on the Messages
  // screen's fully-React pattern: All | Unread tabs, Today/Earlier
  // sections, avatar-initial rows. Renders from the same notifications
  // store as the drawer's list.
  'notifications-sheet': 'The Notifications SHEET root. It was #notifications-screen, a screen root in App.SCREEN_IDS — but the bell is in the header on every route, so a full-screen view had to answer "back to where?" and answered "home", wrong every time it was opened from anywhere else. A sheet presents over the current screen and dismisses back to it.',
  'notifications-sheet-overlay': 'Its backdrop.',
  'notifications-sheet-close': 'Its close control — the desktop slide-over needs a visible dismiss, as the Apps sheet has.',
  'notifications-screen-tabs': 'The sheet\'s sticky Unread | Messages | All tab row. Keeps the `-screen-` id it was born with: the declared checks select on it, and renaming a node that did not move would be churn. It no longer carries Mark-all-read — see #notifications-screen-mark-all below.',
  'notifications-tab-unread': 'The sheet\'s FIRST tab, and the one it opens on. All led for a round, which meant opening an inbox on everything you had already read: the bell is tapped because it has a count, and the count is the unread.',
  // (#notifications-see-older, the footer link that takes a filtered tab to
  // All rather than paging another batch into the filter, is NOT here: it
  // renders only when there is something more to see — rows the filter is
  // hiding, or another server page — and the prerendered sheet has no rows at
  // all. Same reason #notifications-all-messages is absent. Its counterpart
  // #notifications-load-older, the real pager, renders only on All.)
  'notifications-tab-all': 'The whole archive, LAST. The strip narrows left to right — the count you came for, the one kind you answer, then the archive holding both — so the unfiltered tab sits behind the two filtered ones rather than between them. It is where the footer link at the bottom of a filtered tab goes — see #notifications-see-older — and the only tab that pages more rows in.',
  'notifications-tab-messages': 'The sheet\'s SECOND tab, between Unread and All. A message notification is one row in a flat chronological feed that also carries every session, proposal and kudos row, so it sinks fast on a busy account; this is the one place to catch up on conversations regardless. Its own \'All messages\' entry (#notifications-all-messages, rendered only while the tab is active and so not in the static markup) leads to the #messages screen the app chip\'s Messages row also opens.',
  'notifications-screen-mark-all': 'Mark-all-read on the sheet — same controller action as the drawer\'s #notifications-mark-all, React-wired instead of id-bound. Same naming note as the tab row above. It sat at the far RIGHT END of that tab row, in tab-sized ink on the same baseline as the three tabs, so a control that changes data read as a fourth place to go; it is a row UNDER the Unread tab now, with the list it empties, and renders nowhere else.',
};

test('the shell still carries every id in the frozen baseline', () => {
  // The baseline was taken from main's hand-written markup at the point the
  // fixture was retired. It is asserted anyway: a SILENT drop (a truncated
  // JSON write, a bad merge) would otherwise make the comparison below
  // vacuous.
  assert.equal(
    baseline.ids.length, 444,
    `tests/baselines/shell-markup.json has ${baseline.ids.length} ids, not the expected 444. The `
    + 'baseline is frozen — record deliberate changes in RETIRED_IDS / ADDED_IDS rather than '
    + 'refreshing it.',
  );

  const actual = new Set(idsOf(withInteriors));
  const missing = baseline.ids.filter((id) => !actual.has(id) && !(id in RETIRED_IDS));

  assert.deepEqual(
    [...new Set(missing)], [],
    `${new Set(missing).size} element id(s) disappeared from public/index.html and from every `
    + 'mount-on-reveal interior. public/js/** looks these up by getElementById and dapp.json '
    + 'selects on them, so each one is a broken screen. If a removal is intentional, add it to '
    + 'RETIRED_IDS with a reason in the same commit.',
  );
});

test('the shell has not grown ids nobody declared', () => {
  const expected = new Set(baseline.ids);
  const added = [...new Set(idsOf(withInteriors))].filter((id) => !expected.has(id) && !(id in ADDED_IDS));
  assert.deepEqual(
    added, [],
    'public/index.html gained element id(s) the baseline does not have. A new id is fine, but '
    + 'declare it in ADDED_IDS with a reason so the inventory stays a deliberate list.',
  );
});

test('a retired id is really gone, and an added id is really there', () => {
  // Keeps the two maps honest: a stale entry that no longer describes the
  // markup is a hole in the inventory, not a harmless leftover.
  const actual = new Set(idsOf(withInteriors));
  for (const id of Object.keys(RETIRED_IDS)) {
    assert.ok(
      !actual.has(id),
      `#${id} is listed in RETIRED_IDS but is still in public/index.html — drop the entry.`,
    );
  }
  for (const id of Object.keys(ADDED_IDS)) {
    assert.ok(
      actual.has(id),
      `#${id} is listed in ADDED_IDS but is not in public/index.html — drop the entry.`,
    );
  }
});

// Ids that appear more than once in the hand-written shell. getElementById
// returns the first match, so a duplicate is latent breakage — but these
// predate the React chassis swap and fixing one is a behavioural change to a
// live screen, which the scaffolding steps must not make. They are pinned
// here so the count can only go DOWN, and so a chunk converting either screen
// has the problem in front of it.
//
//   wallet-status — one in the Settings screen's wallet-link row, one in the
//   anonymous login screen's wallet sign-in block. Only one is ever mounted
//   at a time in practice, which is why this has never bitten.
const KNOWN_DUPLICATE_IDS = { 'wallet-status': 2 };

test('no id is used twice beyond the duplicates that predate this migration', () => {
  const seen = new Map();
  for (const id of idsOf(withInteriors)) seen.set(id, (seen.get(id) || 0) + 1);
  const duplicates = Object.fromEntries([...seen.entries()].filter(([, n]) => n > 1));

  assert.deepEqual(
    duplicates, KNOWN_DUPLICATE_IDS,
    'the set of duplicated element ids in public/index.html plus the mount-on-reveal interiors '
    + 'changed. getElementById returns the '
    + 'first match, so a NEW duplicate silently binds handlers to the wrong element — and JSX '
    + 'makes pasting a subtree easy. If you FIXED one, delete its entry from KNOWN_DUPLICATE_IDS.',
  );
});

test('the known duplicates are the ones the baseline recorded', () => {
  // Guards the allow-list: if a duplicate turns out to have been introduced by
  // the conversion rather than inherited, it must not be excused here.
  assert.deepEqual(
    baseline.duplicateIds, KNOWN_DUPLICATE_IDS,
    'KNOWN_DUPLICATE_IDS no longer matches the duplicates the frozen baseline recorded, so one of '
    + 'them was introduced by the conversion and needs fixing rather than excusing.',
  );
});

test('the ids the dev-console and staging overlay bind are present', () => {
  // The dev-console island binds these on mount (#1079 chunk B moved the
  // module into frontend/src/features/dev-console). The staging twin in
  // particular lives deep inside #staging-overlay and is easy to lose in a
  // conversion, and its absence only shows up while previewing staging —
  // late, and far from the change that caused it.
  // #dev-console-btn and #dev-console-badge are NOT in this list any more:
  // THE UI OVERHAUL retired the header terminal icon in favour of the Improve
  // panel's "Developer terminal" row, which is driven by the same
  // DevConsole._refreshButtonVisibility signal. The staging twin is exactly
  // the one this test was written for, so it matters more than ever.
  for (const id of [
    'staging-dev-console-btn', 'dev-console-close',
    'dev-console-clear', 'dev-console-filter', 'dev-console-log',
  ]) {
    assert.ok(after.includes(`id="${id}"`), `the dev-console island binds #${id}, which is missing`);
  }
});

// ── No module may DEREFERENCE a retired id ────────────────────────────
//
// The regression guard for the worst kind of failure this whole inventory
// exists to prevent, and one THE UI OVERHAUL actually shipped for a moment.
//
// Retiring an id is only half the job: something usually still looks it up.
// `HeaderMenu.init()` kept two of them —
//
//   document.getElementById('drawer-row-github').addEventListener(…)
//   document.getElementById('drawer-row-share').addEventListener(…)
//
// — after both rows moved into the Improve panel. Each threw on null. The
// first one threw inside a React layout effect, which unmounted the whole
// shell root; the second threw out of App.init() before it had fetched the
// session. The page rendered nothing and 218 declared checks failed at once,
// none of them naming the actual cause.
//
// So: a retired id may still be MENTIONED (the comments recording where each
// one went are the point of RETIRED_IDS), and it may still be looked up
// GUARDED — `?.`, or a `const el = …; if (el)` — because a module that
// no-ops when its node is absent is exactly how a row gets re-homed without
// touching it. What it may not be is dereferenced on the spot.
// ── The prerender no longer carries the mount-on-reveal interiors ──────
//
// The union above says every id is still SOMEWHERE. This says where it is
// not: each mount-on-reveal root ships in public/index.html as the empty
// element the hand-written shell's converted siblings (#admin-screen,
// #leaderboard-screen, …) always did, and none of the ids an interior owns
// appears in the document. Without this the inventory would pass just as
// happily if a screen quietly went back to prerendering, and the 681
// elements would be back on every load without anyone noticing.
test('a mount-on-reveal interior is rendered by its component, not by the prerender', () => {
  const shipped = new Set(idsOf(after));
  for (const { id } of MOUNT_ON_REVEAL) {
    assert.ok(shipped.has(id), `#${id} — the ROOT — must still be in public/index.html`);
    const interiorIds = idsOf(interiorHtmlFor(id)).filter((x) => x !== id);
    assert.ok(interiorIds.length > 0, `#${id} renders an interior with ids once mounted`);
    const leaked = interiorIds.filter((x) => shipped.has(x) && !(x in KNOWN_DUPLICATE_IDS));
    assert.deepEqual(
      leaked, [],
      `#${id}'s interior is in the prerendered document. It mounts on first reveal — see `
      + 'frontend/src/lib/mount-on-reveal.ts — so the document must carry only the root.',
    );
  }
});

test('no module dereferences a retired id without a guard', () => {
  const roots = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(js|ts|tsx)$/.test(entry.name)) roots.push(full);
    }
  };
  walk(path.join(ROOT, 'public/js'));
  walk(path.join(ROOT, 'frontend/src'));

  const offenders = [];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    for (const id of Object.keys(RETIRED_IDS)) {
      // `getElementById('x').`  /  `querySelector('#x').` — a dot that is not
      // part of `?.` is an immediate dereference of a value that is null.
      const lookups = [
        new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
        new RegExp(`querySelector\\(\\s*['"]#${id}['"]\\s*\\)\\s*(\\??\\.)`, 'g'),
      ];
      for (const re of lookups) {
        let m;
        while ((m = re.exec(src)) !== null) {
          if (m[1] === '?.') continue; // guarded — fine
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file)}:${line} dereferences #${id}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'a retired id is looked up and dereferenced on the spot, which throws on null. '
    + 'Inside a React effect that unmounts the shell; inside App.init() it stops the boot. '
    + 'Delete the lookup with the row it belonged to, or guard it with `?.`.',
  );
});
