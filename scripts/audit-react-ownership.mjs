#!/usr/bin/env node

/**
 * Does any legacy module still write into a subtree a React island owns?
 *
 * WHY THIS EXISTS
 *
 * The step-3 shell migration's central rule (AGENTS.md, and the
 * `react-shell-migration` skill) is ONE OWNER PER SUBTREE: a region may become
 * a React island only when no `public/js/**` module writes into it. Breaking
 * that does not throw, does not fail a unit test, and usually does not even
 * look wrong on the day it lands — the legacy write paints, and it keeps
 * painting until the next store update repaints the row from a model that
 * never heard about it.
 *
 * Two shipped bugs of exactly that shape are what prompted this:
 *
 *   * the group chat's save button had its icon, three attributes and a class
 *     written straight onto a node transcript.tsx renders. It worked, and
 *     would have silently reverted on the next reaction.
 *   * the same transcript's edit paths assigned `.gc-msg-content.innerHTML`.
 *     `Body` memoises its `{__html}` wrapper on the string, so React kept
 *     believing the old content and repainted the row from it the next time
 *     anything else about the message changed — an edit followed by a
 *     reaction reverted the text on screen.
 *
 * Neither is visible to a static check: the write is in a classic script and
 * the node is React's. So this instruments the DOM in a real browser instead.
 *
 * WHAT IT DOES
 *
 * Patches the `innerHTML` setter, `insertAdjacentHTML` and `appendChild`
 * before any app code runs, walks a list of routes, and reports every write
 * whose target sits INSIDE one of the hosts below.
 *
 * WHY A LIST OF HOSTS RATHER THAN "ANY REACT ROOT"
 *
 * `main.tsx` hydrates the whole `<body>`, so "is this node inside a React
 * root" is true of every node in the document and flags nothing useful. Almost
 * everything under it is a DOCUMENTED legacy host — rendered once by React
 * with constant props and never looked inside again, which is the sanctioned
 * pattern (see the header of features/dev-board/board-frame.tsx). The hosts
 * below are the other kind: React renders and RECONCILES every descendant, so
 * a legacy write there is a second author.
 *
 * ADD A HOST HERE whenever a conversion makes one — that is the point.
 *
 * USAGE
 *
 *   AUDIT_BASE=http://localhost:3000 AUTH=/path/auth.json node scripts/audit-react-ownership.mjs
 *
 * **PASS `AUTH`, AND MATCH ITS COOKIE'S HOST.** Signed out, most of the route
 * list renders an empty `#app-content` — no Dev board, no Dev chat composer,
 * no admin console — and the audit sweeps almost nothing while still printing
 * a confident "0 legacy writes". It reported exactly that over a real finding
 * once. The saved cookie is scoped to the host it was captured on, so
 * `http://127.0.0.1:3000` and `http://localhost:3000` are not
 * interchangeable: the wrong one is silently anonymous. When in doubt, open
 * one route with the same storage state and check that something rendered.
 *
 * Exits non-zero when it finds anything, so it can gate a branch.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

/*
 * Playwright is NOT a repository dependency and this script does not make it
 * one. The test suite is node:test over vm sandboxes with no browser in it,
 * and adding ~300MB of browser tooling to install a dev-only audit would be a
 * poor trade. Resolve it from wherever it happens to live — a global install,
 * an `npm i -g playwright`, or PLAYWRIGHT_PATH — and say so clearly when it
 * is absent, rather than failing with a bare module-not-found.
 */
const require_ = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require_(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch {
  try {
    ({ chromium } = require_('/opt/node22/lib/node_modules/playwright'));
  } catch {
    console.error(
      'This audit drives a real browser and needs Playwright, which is not a\n'
      + 'dependency of this repo. Install it globally (`npm i -g playwright`)\n'
      + 'or point PLAYWRIGHT_PATH at an existing copy.',
    );
    process.exit(2);
  }
}

const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const AUTH = process.env.AUTH || '';
const CHROME = process.env.CHROME_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Hosts whose ENTIRE subtree a React island renders and reconciles.
 *
 * `when` scopes an entry to one address, for a host that is React's on some
 * routes and a legacy module's on others. `#admin-section-content` is the
 * only one so far and it is a whole class of them: the admin console has one
 * content host and thirty sections take turns in it, so it is owned exactly
 * while the section occupying it is a converted one. Without the scope every
 * un-converted section's own `innerHTML` would report as a violation.
 */
const OWNED = [
  { sel: '#dc-launchpad-slot [data-launchpad="own-tools-pr"]' }, // #1891: shared React guide
  { sel: '[data-account-email-form]', when: '#settings/email' },
  // `#home-grid-overlay` is appended into this host by home.js during a drag,
  // which this sweep never performs and so never sees. It is a deliberate
  // exception resting on a timing invariant rather than a boundary — the
  // reasoning is at Home._showGridOverlay and the invariant is pinned by
  // tests/home-grid-placement.test.js.
  { sel: '#app-list' },                      // features/home/app-grid.tsx
  { sel: '#home-apps-more' },                // features/home/apps-more.tsx
  // The strip's tiles are React's; the kit's reorder recognizer moves those
  // nodes DURING a drag (attachReorder is a displacement model, so the slot
  // travels through the DOM). This sweep never drags, so it would not see
  // that either way — the guard for it is Home.render()'s `_dragActive`
  // bail-out, which keeps React from reconciling mid-gesture.
  { sel: '#home-widget-strip-section' },     // features/home/widget-strip.tsx
  { sel: '#home-discover-section' },         // features/home/panels/sections.tsx
  { sel: '#home-challenges-section' },       // ditto
  // #home-create-section is gone: Create is #app-list's trailing tile now
  // (features/home/create-tile.tsx), inside the host already listed above.
  // The Challenges pane (features/leaderboard/challenges-pane.tsx). Scoped to
  // its route: #challenges-root is only mounted — and only React's — while the
  // Leaderboard screen's Challenges tab is the section on screen.
  { sel: '#challenges-root', when: '#leaderboard/challenges' },
  // The History pane (features/leaderboard/history-pane.tsx), the same
  // arrangement one tab over: React-owned from the day it shipped, and only
  // on screen while History is the section showing.
  { sel: '#leaderboard-history-root', when: '#leaderboard/seasons' },
  // Settings' account block (features/settings/account-rows.tsx) inside the
  // footer settings.js MOVES between columns: the move is the module's, the
  // subtree is React's alone.
  { sel: '#settings-account-rows' },
  // The transcript (features/group-chat/transcript.tsx). A vote row's inline
  // controls are the one exception, and they are the controller-host seam
  // AGENTS.md documents: transcript.tsx renders `.gc-vote-inline` ONCE as an
  // empty span with a constant className and never looks inside it, and
  // group-chat.js's `refreshVoteControls` fills it from AppView.voteState.
  // The row's TINT is not exempt — that is a view-model field React renders,
  // and the module patches the model rather than the class list.
  { sel: '#gc-messages', except: ['[data-vote-controls]'] },
  { sel: '#gc-thread-messages', except: ['[data-vote-controls]'] }, // 'thread' key
  // The app's own menu, behind the Homeroom mark
  // (features/app-context/app-context-sheet.tsx). Its rows are React's end to
  // end and it is mounted on every route, so no `when` clause. It earns an
  // entry with #2718, which retired #improve-btn and made this list the way to
  // the Improve panel: the dot writers that used to aim at the header pill
  // publish through the visibility store, and a classList write by id landing
  // in here instead is exactly the second author this sweep exists to catch.
  //
  // NOT the sheet ROOT: the kit writes `platform-sheet-adopted` to that node
  // on touch, which is the documented seam — and this sweep reports writes
  // INSIDE a host, so scoping to the scroller states the boundary where it
  // actually is.
  { sel: '#switcher-nav' },
  { sel: '#gc-mention-menu' },               // features/group-chat/autocomplete.tsx
  { sel: '#gc-ref-menu' },                   // ditto
  { sel: '#gc-emoji-menu' },                 // ditto
  { sel: '#gc-spec-side-panel' },            // features/group-chat/spec-panel.tsx
  // The card metadata picker (features/dev-board/attr-popover.tsx). Its host
  // is created and removed by app-view.js on every open, so it is only on
  // screen mid-gesture — this sweep never opens one, and the coverage for it
  // is tests/attr-vote-toggle.test.js plus the browser probe in the chunk's
  // commit. Listed anyway so a future write into it is a finding the day the
  // sweep learns to open one.
  { sel: '#attr-popover' },
  // The card's ⋯ menu (features/dev-board/card-menu.tsx). Same story as the
  // picker above: on screen only mid-gesture, so this sweep never sees one.
  { sel: '.dev-card-menu' },
  { sel: '[data-session-checks-host]' },
  // The three body-mounted Dev modals (features/dev-board/modals/). Same
  // story again — each scrim is created on open and removed on close, so
  // this sweep never sees one; the coverage is
  // tests/dev-modals-render.test.js plus the chunk's browser probe.
  //
  // Neither of the two legacy seams inside them needs an exception, for
  // reasons worth stating rather than rediscovering: `CreditOptions.wire`
  // only adds a delegated listener (the card's markup is React's own
  // `dangerouslySetInnerHTML`, which `reactWroteHtml` recognises), and the
  // consent dialog's validation writes `textContent` and a class into
  // `#llm-consent-error`, neither of which is a patched API.
  // The App tab's placeholder states (features/app-frame/app-status.tsx).
  // `#app-content` is a SHARED host — the four Dev sub-views mount their own
  // frames into it and `showLaunchCoverShot` still writes it by hand — so
  // this is scoped to the App tab, where the placeholder is the one thing in
  // there. Unscoped it would report every sibling surface's writes.
  { sel: '#app-content', when: '#app/recipebot/app' },
  // The two alerting SHEETS (Streamlined Concept). Both were screen roots and
  // neither was swept, because a screen root is the host and these were the
  // hosts' contents; as overlays they are React-owned end to end, so the
  // whole subtree is in scope. Scoped by route because they are always in the
  // DOM and only PRESENTED on their own deep link — an unscoped entry would
  // sweep a closed sheet on every route and report nothing.
  { sel: '#notifications-sheet', when: '#notifications' }, // features/notifications/notifications-sheet.tsx
  { sel: '#messages-sheet', when: '#messages' },           // features/messages/index.tsx
  // An agent session (#2779, features/agent-session/index.tsx). The phone
  // screen is React's end to end; the same panel mounted in the Messages
  // pane is covered by the #messages-sheet entry above, and the deep link
  // below puts a seeded conversation (src/db/migrate.js, id 990801) in it.
  { sel: '#agent-session-screen', when: '#agent/' },

  // The AI-credit row in Settings → Anthropic API key
  // (features/header/ai-budget.tsx). It used to be an empty
  // `#ai-budget-slot` that ai-credit.js `innerHTML`ed; the module publishes
  // a view model now and this is the only writer below the row.
  { sel: '#drawer-row-ai-budget' },
  { sel: '#auto-session-modal' },
  { sel: '#credit-options-modal' },
  { sel: '#llm-consent-modal' },
  // The two card surfaces (features/dev-board/workshop/workshop.tsx and
  // dev-kanban.tsx). Both hosts are app-view.js's — `_repaintDevBody`
  // writes them into #dev-body — but every card below them is React's.
  //
  // Three slots inside stay legacy-FILLED, and each is the controller-host
  // seam: rendered once, empty, with a constant className, never looked
  // inside. `.dev-feed-comments` is filled by `_fillFeedComments` when its
  // row scrolls into view; `[data-kudos-host]` by `_fillKudosHosts` (and
  // then by Kudos.attach / _refreshButton / _renderPopover, four writers in
  // another module); `#dev-issue-title-error` by `saveIssueTitle`.
  {
    sel: '#dev-workshop',
    except: ['.dev-feed-comments', '[data-kudos-host]'],
  },
  {
    sel: '#dev-kanban-board',
    except: ['[data-kudos-host]'],
  },
  // The kanban board's filter strip (features/dev-board/kanban-filters.tsx).
  // Swept on #app/recipebot/dev whenever the board is in kanban mode.
  { sel: '#dev-kanban-filterbar' },
  // An issue topic page's GitHub thread
  // (features/dev-board/issue-comments.tsx), inside the topic card that
  // app-view.js still fills. Swept on the topic route above.
  { sel: '#dev-issue-comments' },
  // The thread panel's shell (features/group-chat/thread-shell.tsx). ONE host
  // inside it stays its module's — the transcript's own portal target —
  // rendered once, empty, with a constant className and never looked inside,
  // the controller-host seam AGENTS.md documents.
  //
  // `#gc-thread-head` was on that list too, because app-view.js innerHTMLed
  // the whole opened-topic head into it. It is
  // features/dev-board/topic/topic-head.tsx's now, so it is listed below in
  // its own right with the three seams it keeps.
  //
  // The composer's three slots and the typing line were exceptions until
  // #1191 gave them a store: they are features/group-chat/composer.tsx's now,
  // shared with the general chat, and a write into any of them is a real
  // finding.
  {
    sel: '.dev-thread',
    except: ['#gc-thread-messages'],
  },
  // The opened topic's head — the card and everything under it
  // (features/dev-board/topic/topic-head.tsx). Three seams inside it stay
  // legacy-FILLED, each rendered once, empty, with a constant className:
  // `[data-transcript-body]` (public/js/session-transcript.js writes the
  // chat and its Fork button), `[data-kudos-host]` in the detail action row,
  // and `#dev-issue-comments`, which is a React island of its own listed
  // below. Swept on the topic route.
  {
    sel: '#gc-thread-head',
    except: [
      '[data-transcript-body]', '[data-kudos-host]', '#dev-issue-comments',
      // The change card's tabs give the existing chat controllers their
      // own empty hosts. Their React subtrees are audited separately below.
      '[data-change-discussion]', '[data-change-workspace]',
      // saveIssueTitle writes the error line by id while the editor is open.
      '#dev-issue-title-error',
    ],
  },
  // The general chat pane (features/group-chat/general-chat.tsx). Same two
  // exceptions in their general spelling — the transcript's portal target and
  // the spec reader's, both listed above in their own right.
  {
    sel: '.gc-chat-pane',
    except: ['#gc-messages'],
  },
  // The dev chat's WHOLE screen. `#dc-view` is written by
  // public/js/app-view.js's `renderDevChatTab`; everything inside it is
  // features/dev-chat/view.tsx — the session header, the four banners, the
  // launchpad slot, the transcript, the composer and (on the other branch)
  // the app's session list. Five separate entries collapsed into this one
  // when the skeleton stopped being a string.
  //
  // ONE host inside it stays legacy-owned and is excepted: `#dc-staging-panel`
  // is a SLOT the docked preview is positioned over, watched by a
  // ResizeObserver. `#dc-spec-viewer` was a second — the controller host
  // `_renderSpecViewer` filled — and is in scope now that the reader is
  // features/dev-chat/spec-viewer.tsx. The launchpad slot was never excepted:
  // another module builds its markup, but it arrives through a
  // dangerouslySetInnerHTML sink React itself owns.
  //
  // `#dc-session-list` is in here too, on the no-session branch. This sweep
  // never reaches it: every route into the chat carries a session id (see
  // migration-state.md), so the coverage is
  // tests/archive-session-list.test.js plus the chunk's browser probe, which
  // drives the branch by hand.
  {
    sel: '#dc-view',
    except: ['#dc-staging-panel'],
  },
  // Only reachable under NATIVE=1 — see the stubbed bridge below. The row is
  // features/header/native-app-version-row.tsx; the module that used to write
  // its text and strip its `hidden` publishes to a store instead.
  { sel: '#about-row-native-app-version' },
  { sel: '#llm-grants-list' },               // features/settings/grants-list.tsx
  { sel: '#cli-tokens-list' },               // features/settings/cli-tokens-list.tsx
  { sel: '#connectors-list' },               // features/settings/connectors-list.tsx
  { sel: '#github-link-body' },              // features/settings/social-identity.tsx
  { sel: '#settings-local-agents-list' },    // features/settings/local-agents-list.tsx
  { sel: '#agent-files-instructions-list' }, // features/settings/agent-files-list.tsx
  { sel: '#agent-files-skills-list' },
  { sel: '#browse-list' },                   // features/apps/browse-list.tsx
  { sel: '#browse-sort-bar' },               // features/apps/browse-screen.tsx (#1383)
  // The WHOLE Workshop screen (#workshop): features/workshop/index.tsx renders
  // and reconciles every node under this root, and no public/js/** module has
  // ever written inside it — App.navigateToWorkshop drives it through the
  // controller on `window.UsernodeReact.workshop`, the same seam Messages
  // uses. Listed on the day it shipped so it cannot acquire a second author
  // later without the sweep saying so.
  { sel: '#workshop-screen' },               // features/workshop/index.tsx
  { sel: '#standings-tabs' },                // @/components/ui/tabs, via the leaderboard
  { sel: '#leaderboard-event-bar' },         // features/leaderboard/event-bar.tsx
  { sel: '#admin-section-content', when: '#admin/e2e' },     // features/admin/admin-e2e.tsx
  { sel: '#admin-section-content', when: '#admin/gallery' }, // features/admin/admin-gallery.tsx
  { sel: '#admin-section-content', when: '#admin/node' },    // features/admin/admin-node.tsx
  { sel: '#admin-section-content', when: '#admin/merges' },  // features/admin/admin-merges.tsx
  { sel: '#admin-section-content', when: '#admin/push' },    // features/admin/admin-push.tsx
  { sel: '#admin-section-content', when: '#admin/campaigns' }, // features/admin/admin-campaigns.tsx
  { sel: '#admin-section-content', when: '#admin/mail' },    // features/admin/admin-mail.tsx
  { sel: '#admin-section-content', when: '#admin/status' },  // features/admin/admin-status.tsx
  { sel: '#admin-section-content', when: '#admin/estimator' }, // features/admin/admin-estimator.tsx
  { sel: '#admin-section-content', when: '#admin/analytics' }, // features/admin/admin-analytics.tsx
  { sel: '#admin-section-content', when: '#admin/overview' }, // features/admin/admin-overview.tsx
  { sel: '#admin-section-content', when: '#admin/codes' },   // features/admin/admin-codes.tsx
  { sel: '#admin-section-content', when: '#admin/featured-apps' }, // features/admin/admin-featured-apps.tsx
  { sel: '#admin-section-content', when: '#admin/db-export' }, // features/admin/admin-db-export.tsx
  { sel: '#admin-section-content', when: '#admin/features' }, // features/admin/admin-features.tsx
  { sel: '#admin-section-content', when: '#admin/limits' },  // features/admin/admin-limits.tsx
  { sel: '#admin-section-content', when: '#admin/rollover' }, // features/admin/admin-rollover.tsx
  { sel: '#admin-section-content', when: '#admin/staging-reap' }, // features/admin/admin-staging-reap.tsx
  { sel: '#admin-section-content', when: '#admin/model-costs' }, // features/admin/admin-model-costs.tsx
  // The programme console's screens convert one at a time (#1120 slice 24).
  // The host is #admin-topo-content, not the section host: admin-topochain.js
  // still owns the shell around it and recreates that node on every screen
  // switch, so the boundary React owns is the content node alone.
  { sel: '#admin-topo-content', when: '#admin/api-tester' }, // topochain/api-tester.tsx
  { sel: '#admin-topo-content', when: '#admin/sql-console' }, // topochain/sql-console.tsx
  { sel: '#admin-topo-content', when: '#admin/settings' }, // topochain/settings.tsx
  { sel: '#admin-topo-content', when: '#admin/app-version' }, // topochain/app-version.tsx
  { sel: '#admin-topo-content', when: '#admin/waitlist' }, // topochain/waitlist.tsx
  { sel: '#admin-topo-content', when: '#admin/onchain-accounts' }, // topochain/onchain-accounts.tsx
  { sel: '#admin-topo-content', when: '#admin/user-activities' }, // topochain/user-activities.tsx
  { sel: '#admin-topo-content', when: '#admin/delegations' }, // topochain/delegations.tsx
  { sel: '#admin-topo-content', when: '#admin/challenge-templates' }, // topochain/challenge-templates.tsx
  { sel: '#admin-topo-content', when: '#admin/challenge-scoring' }, // topochain/challenge-scoring.tsx
  { sel: '#admin-topo-content', when: '#admin/seasons' }, // topochain/seasons.tsx
  { sel: '#admin-topo-content', when: '#admin/season-events' }, // topochain/season-events.tsx
  // No `except` any more: `#admin-users-programme` was the programme users
  // card's host, filled by admin-topochain.js, and #1120 slice 35 made that
  // card a child component. The whole section is React's, exemption included.
  { sel: '#admin-section-content', when: '#admin/users' }, // features/admin/admin-users.tsx
  { sel: '#admin-section-content', when: '#admin/support' }, // features/admin/admin-support.tsx
  { sel: '#admin-section-content', when: '#admin/reports' }, // features/admin/admin-reports.tsx
];

const ROUTES = [
  '?shot=launchpad&venue=own-tools-pr#app/usernode-2d5619/dev/sessions/990411',
  '?shot=launchpad&venue=own-tools-pr#app/usernode-2d5619/dev/sessions/990401',
  '#home', '#apps', '#apps/recipebot', '#workshop', '#settings', '#settings/app-ai',
  '#settings/email', '#settings/agent-files', '#settings/api-key', '#settings/cli', '#settings/connectors', '#settings/experimental', '#profile', '#leaderboard', '#leaderboard/challenges', '#leaderboard/seasons', '#messages', '#notifications',
  '#agent/990801', '#agent/990801/changes', '#messages/agent/990801',
  '#app/recipebot', '#app/recipebot/app', '#app/recipebot/dev', '#app/recipebot/dev/chat',
  '#app/recipebot/dev/sessions/1',
  // The spec reader, which is the one host inside `#dc-view` whose subtree
  // only exists while the panel is OPEN — its open state otherwise lives in
  // localStorage, so no plain navigation reaches it and the sweep would run
  // over an empty pane. `?shot=spec-viewer` is the deep link dapp.json's own
  // declared check uses, on the migration-seeded session (src/db/migrate.js
  // fixes id 900830 precisely so the route is stable).
  '?shot=spec-viewer#app/usernode-2d5619/dev/sessions/900830',
  // A TOPIC page, which is the only route that mounts `.dev-thread` — the
  // thread panel, its composer and the topic card app-view.js fills. Without
  // it that OWNED entry was swept on no route at all. The number is a seeded
  // issue (scripts/seed-checks-db.js); if the seed changes, re-point it rather
  // than dropping the route.
  '#app/recipebot/dev/issues/900001',
  '#admin/e2e', '#admin/gallery', '#admin/node', '#admin/merges', '#admin/push', '#admin/campaigns', '#admin/mail', '#admin/estimator', '#admin/analytics', '#admin/overview', '#admin/codes', '#admin/featured-apps', '#admin/db-export', '#admin/features', '#admin/limits', '#admin/users', '#admin/users/900301', '#admin/support', '#admin/support/900302', '#admin/status', '#admin/rollover', '#admin/staging-reap',
  '#admin/model-costs', '#admin/reports',
  '#admin/api-tester', '#admin/sql-console', '#admin/settings', '#admin/app-version', '#admin/waitlist', '#admin/onchain-accounts', '#admin/user-activities', '#admin/delegations',
  '#admin/challenge-templates', '#admin/challenge-scoring', '#admin/seasons', '#admin/season-events',
];

function instrument(owned) {
  window.__ownHits = [];
  const inside = (node) => {
    if (!node || node.nodeType !== 1) return null;
    for (const { sel, when, except } of owned) {
      // A scoped host is only React's while that address is on screen.
      if (when && !String(location.hash || '').startsWith(when)) continue;
      // A documented legacy-filled host INSIDE an owned one: rendered once
      // with constant props and never looked inside. Writes below it are the
      // sanctioned pattern, not a second author.
      // ALL matches, not the first: `[data-vote-controls]` is one seam with
      // one host per votable row, and `querySelector` would exempt only the
      // topmost one and report every row below it.
      if (except && except.some((s2) => [...document.querySelectorAll(s2)]
        .some((h) => h === node || h.contains(node)))) continue;
      const host = document.querySelector(sel);
      // The host ITSELF counts, not just its descendants: appending a row
      // straight into `#gc-messages` is one of the two bugs this exists for.
      // That used to be excluded because mounting writes the host — but the
      // React filter above is what handles mounting now, precisely, so the
      // exclusion would only be hiding findings. (`mountLegacyPortal` clears
      // its host with `replaceChildren`, which is not one of the three
      // patched APIs.)
      if (host && host.contains(node)) return sel;
    }
    return null;
  };
  const where = (el) => {
    const bits = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 3; i += 1, n = n.parentElement) {
      bits.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase()
        + (n.className ? `.${String(n.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''));
    }
    return bits.join(' > ');
  };
  /*
   * React writes to the DOM with the same three APIs, so the patch has to
   * tell React's own commits apart from a legacy module's. Both parts below
   * are statements about what React CANNOT have done, not heuristics over
   * stack text — the bundle is minified, so its frame names say nothing.
   *
   * A portal mount made this necessary: a hydrated island's initial tree
   * arrives in the prerendered document, so React does no appending for it
   * and the audit never saw React at all. A section mounted at runtime
   * appends its whole subtree, and every one of those appends looked like a
   * violation.
   */
  // ELEMENTS AND TEXT NODES BOTH. React precaches the fiber on a text
  // instance as well as an element one, and this deliberately does not check
  // nodeType: an earlier version restricted it to elements and then reported
  // React's own text children — a `{' · '}` appended into a <p> whose first
  // render had said "Loading…" — as a legacy write.
  const own = (node, prefix) => {
    if (!node || typeof node !== 'object') return null;
    for (const k of Object.keys(node)) if (k.startsWith(prefix)) return node[k];
    return null;
  };
  // React attaches the fiber to a host instance in createInstance, BEFORE it
  // is ever appended anywhere — so a child with no fiber was created by
  // something that is not React, which is the whole finding.
  const reactMade = (node) => own(node, '__reactFiber$') != null;
  // Props are written by updateFiberProps ahead of the DOM update in both the
  // mount and the update path, so during React's own write the node's props
  // already hold the exact string being assigned. A legacy write into the
  // same node is a DIFFERENT string — which is precisely the shape of the bug
  // that prompted this script: `.gc-msg-content` is a dangerouslySetInnerHTML
  // sink AND was being assigned by group-chat.js. Comparing the value rather
  // than merely asking "is this a sink" is what keeps that catchable.
  const reactWroteHtml = (el, value) => {
    const props = own(el, '__reactProps$');
    const html = props && props.dangerouslySetInnerHTML && props.dangerouslySetInnerHTML.__html;
    return html != null && String(html) === String(value);
  };
  const note = (kind, el, value) => {
    const host = inside(el);
    if (!host) return;
    if (kind === 'appendChild' ? reactMade(value) : reactWroteHtml(el, value)) return;
    const stack = (String(new Error().stack || '')).split('\n').slice(2, 7)
      .map((l) => l.trim()).filter((l) => !/\bnote\b|<anonymous>:/.test(l));
    window.__ownHits.push({ kind, host, target: where(el), stack });
  };
  const proto = Element.prototype;
  const ih = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  Object.defineProperty(proto, 'innerHTML', {
    ...ih, set(v) { note('innerHTML', this, v); return ih.set.call(this, v); },
  });
  // React never reaches for insertAdjacentHTML, so every call is a finding.
  const iah = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function patched(...a) {
    note('insertAdjacentHTML', this, null); return iah.apply(this, a);
  };
  const ap = Node.prototype.appendChild;
  Node.prototype.appendChild = function patched(...a) {
    note('appendChild', this, a[0]); return ap.apply(this, a);
  };
}


/**
 * A stubbed native bridge, for `NATIVE=1`.
 *
 * Three header modules and one settings section gate on
 * `window.usernode.isNative === true` and then read their data from bridge
 * calls. In an ordinary browser sweep they `return` on their first line, so
 * their hosts never render and this audit reported nothing about them — which
 * read as "clean" and meant "never looked".
 *
 * IT HAS TO BE INSTALLED AFTER LOAD, and that is not a detail.
 *
 * `addInitScript` was the obvious way and it silently does nothing:
 * `/usernode-bridge.js` sets `window.usernode` synchronously in <head>, and
 * public/js/native-chrome.js replaces `window.NativeChrome` — so a pre-load
 * stub is overwritten by both, the modules `return` on their first line, and
 * this audit reports a confident zero about hosts it never reached. That is
 * the same shape of bug as a guard whose exemption outlived its reason, and it
 * is why this runs after the shell has booted and then drives `init()` by hand.
 *
 * `?un-native-webview=1` (see frontend/src/head.html) supplies the presentation
 * half — the `.in-native-webview` class a headless browser can never earn,
 * because the real signal is an injected JS channel. The flag is deliberately
 * presentation-only, so the bridge shape below is still this file's to supply.
 *
 * It is deliberately a separate MODE, not part of the default sweep: a native
 * bridge changes chrome, safe areas and several code paths product-wide, and
 * findings from that configuration are not findings about the web shell.
 */
function nativeBridge() {
  const noop = async () => ({});
  window.NativeChrome = {
    getInfo: async () => ({
      version: 5,
      capabilities: [
        'getSettingsState', 'getWalletState', 'getNodeStatus',
        'submitTransaction',
      ],
      appVersion: '0.4.0',
      buildNumber: '1223',
    }),
    ...(window.NativeChrome || {}),
  };
  window.usernode = {
    isNative: true,
    getSettingsState: async () => ({
      buildInfo: { appVersion: '0.4.0', buildNumber: '1223' },
    }),
    getNodeStatus: async () => ({ state: 'online', peers: 8 }),
    getWalletState: async () => ({ address: 'un1qaudit', balance: '0' }),
    getTransactionReceipts: async () => ({ items: [] }),
    manageStaking: noop,
    ...(window.usernode || {}),
  };
}

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 440, height: 950 },
  serviceWorkers: 'block',
  ...(AUTH && fs.existsSync(AUTH) ? { storageState: AUTH } : {}),
});
const page = await context.newPage();
const NATIVE = process.env.NATIVE === '1';
await page.addInitScript(instrument, OWNED);

const found = new Map();
for (const route of ROUTES) {
  const url = NATIVE
    ? BASE + '/' + (route.startsWith('?') ? route.replace('?', '?un-native-webview=1&') : '?un-native-webview=1' + route)
    : BASE + '/' + route;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  if (NATIVE) {
    // Bridge first (see nativeBridge's note on why this cannot be an init
    // script), then init the modules that gate on it, then open the drawer —
    // its footer is where the native rows live and no URL reaches it.
    await page.evaluate(nativeBridge);
    await page.evaluate(async () => {
      for (const name of ['NativeAppVersion', 'NodePill', 'WalletSheet']) {
        try { await window[name]?.init?.(); } catch { /* not on this route */ }
      }
      try { (window.UsernodeReact?.improve || window.Improve)?.open?.(); } catch { /* ditto */ }
    });
    await page.waitForTimeout(1500);
  }
  const hits = await page.evaluate(() => {
    const out = window.__ownHits || [];
    window.__ownHits = [];
    return out;
  });
  for (const hit of hits) {
    const key = `${hit.kind} into ${hit.host} @ ${hit.target}`;
    if (!found.has(key)) found.set(key, { route, stack: hit.stack });
  }
}
await browser.close();

for (const [key, v] of found) {
  console.log(`${v.route}\n  ${key}`);
  (v.stack || []).slice(0, 2).forEach((s) => console.log(`      ${s.slice(0, 120)}`));
}
console.log(`\n${found.size} legacy write(s) into React-owned subtrees`);
process.exit(found.size ? 1 : 0);
