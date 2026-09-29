# Coding-agent project guidance

## Scope of this guidance

These instructions govern only files inside the
`Usernode-Labs/social-vibecoding` Git worktree. Every path below is relative
to this repository's root; a same-named path in a separate repository does
not inherit the rule. When a task opens or clones another repository, use
that repository's own agent instructions for its files instead of applying
this file to them.

Some coding agents retain the repository-instruction chain from where a task
started. If a task started in this repository and the work moves to an
unrelated repository, do not carry these instructions across that boundary.
Make sure the agent has loaded the other repository's own guidance; if it
cannot refresh repository context in place, start a fresh task rooted there
before editing it.

## Check that this checkout is current before you read or write code

- **The code in front of you may not be the code that runs.** Sessions are
  often started on a user's fork, and a fork's `main` can sit hundreds of
  merged pull requests behind `Usernode-Labs/social-vibecoding` main.
  `git fetch origin` cannot tell you: it compares the fork with itself. This
  applies before you *read* code to answer a question about how the platform
  behaves now, not only before an edit. An answer read from a stale checkout
  describes a version that may no longer exist.
- **Check against the canonical repository, not against `origin`:**

  ```sh
  git fetch https://github.com/Usernode-Labs/social-vibecoding main
  git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
  ```

  `behind` means HEAD does not contain the canonical main. To answer a
  question, read the canonical code instead: `git show FETCH_HEAD:<path>` or
  `git grep <pattern> FETCH_HEAD`. To change code, follow the next section:
  the base commit comes from the work order or `proposal_start`, never from
  merging `FETCH_HEAD` yourself. With the Homeroom connector,
  `get_checkout_status` answers the same question.
- **A session-start check runs this for you.**
  `.agents/hooks/upstream-drift.js` runs when a Claude Code session starts
  (`.claude/settings.json`), on the first prompt of a Codex session once its
  project config has been generated, and in OpenCode through
  `.opencode/plugins/`. When HEAD is behind, it puts a notice in your
  context; act on it. It is advisory: offline, or in a Homeroom hosted worker
  (which sets `SOCIAL_VIBECODING_DRIFT_CHECK=off` because the harness fixes
  its base), it stays silent. Silence is therefore not proof the checkout is current: when
  the answer depends on current behavior and you have not seen a verdict,
  run the two commands above.
- **A fork gets the check only once it contains it.** A fork cut before the
  check existed has neither the hook nor this section. Syncing that fork's
  `main` with the canonical one once fixes it for every later session.

## Know your base commit and create its work branch before you write code

- **This checkout can be a fork whose `main` is far behind the platform
  repository, and nothing in it says so** (the section above shows how to
  check). A session dispatched onto a ready-made branch inherits whatever
  commit that branch was cut from. Once
  that was ~190 merged pull requests behind the commit the request itself
  described: the files it named had moved, `src/services/mcp-charter.js` did
  not exist yet, and the drift surfaced only because the request happened to
  quote a SHA. **Do not assume the branch you were handed is based
  correctly**, and do not reach for the fork's default branch as the base —
  that is the thing most likely to be stale.
- **Choose the proposal workflow before resolving the base.** For a native
  locally authored proposal, follow `usernode-proposal`: resolve the app and
  exact base through the authenticated Homeroom API, then use `proposal_start`
  and the platform-managed commit upload. This path needs no personal GitHub
  link and no `prepare_work`. That tool prepares an external fork contribution
  and requires GitHub identity for that different workflow; do not call it
  merely to discover a native proposal's base.
- **Establish the base commit before the first edit.** Use an already supplied
  work order or guided hand-off's `Base commit:` when present. For a new native
  proposal, use the exact canonical revision resolved through Homeroom as
  described in `usernode-proposal`; a verified API result is sufficient and
  does not require another user confirmation. Ask only when no trustworthy
  exact revision can be resolved or the user has requested an ambiguous base.
  Inspect the current checkout with
  `git status --short --branch`, `git rev-parse HEAD`, and
  `git rev-parse --abbrev-ref HEAD`; compare all forty characters of `HEAD`.
  This is the check step 2 of the `usernode-proposal` skill already makes,
  hoisted here on purpose: a skill body loads only when a task selects that
  skill, so a session that arrives on a branch somebody else cut never reads
  it.
- **Never implement or commit proposal work directly on `main`, `master`, or
  another default branch.** Unless the harness already supplied a dedicated
  non-default branch at the exact base, create and check out a uniquely named
  proposal branch at that SHA before editing:

  ```sh
  git switch -c <proposal-branch> <40-character-base-sha>
  git rev-parse HEAD
  git rev-parse --abbrev-ref HEAD
  ```

  Work and commit only on that branch. If the base object is missing locally,
  fetch that exact SHA and repeat the switch; never substitute a branch tip.
- **A mismatched `HEAD` is a reason to branch from the known base, not to merge
  or rebase the default branch.** Creating the proposal branch from the exact
  SHA leaves commits on the previous branch untouched. If switching in place
  would overwrite tracked changes, preserve them by using an isolated
  worktree or stop and ask before moving them. Which commit a proposal is
  diffed against decides what the group is voting on; a wrong base is caught
  only at submission, after the expensive work is already done.

## Shared task workflows

This repository keeps conditional procedures as portable Agent Skills instead
of loading them for every task. The canonical copies live in
`.agents/skills/`; `.claude/skills/` links to that directory for Claude
Code discovery. OpenCode discovers `.agents/skills/` directly, so it does not
need a duplicate skill tree; its project plugin entry points under
`.opencode/plugins/` link back to the canonical adapters in `.agents/hooks/`.
Use the matching skill whenever its description fits:

- `usernode-api` — inspect or change Homeroom app/platform state.
- `usernode-proposal` — run a locally authored native proposal through
  staging, checks, and optional promotion from an agent on the user's own
  machine. This skill does not apply inside a Homeroom hosted dev-chat worker:
  that worker commits on its assigned branch, declares its visible changes
  with its supplied tool, and leaves push, PR, and staging to the harness.
- `react-shell-migration` — convert a legacy-owned shell region to React.
- `mobile-push-testing` — verify push delivery through a real phone.

`CLAUDE.md` imports this file for the always-on repository rules below.
Claude Code, Codex, and OpenCode load the full workflow bodies only when a task
selects a skill.

## Run the suites that pin what you changed; leave the whole suite to Homeroom

- **The platform runs everything on every submission.** `npm run lint:sql`,
  the full unit suite (`npm test`) and every declared `dapp.json` check run
  against the submitted commit in a clean container, and they gate the merge.
  A local run of all 13,000+ tests duplicates that, minutes at a time, and
  one hung test once held such a run open for an hour with no failure in it.
  The local run's job is narrower: to know, before you submit, whether the
  files you touched still satisfy the suites that read them.
- **`npm run test:changed -- --base <40-character-base-sha>` runs exactly
  those.** It diffs the working tree against the base commit (committed,
  staged, unstaged and untracked alike), maps each changed file to the suites
  that name it — tests here read their sources by path — plus the suites of
  the files that import a changed module under `frontend/` or `src/`, and
  runs them with the `test` script's own preload, flags and timeout.
  `--list` prints the mapping and the command without running; `--files a,b`
  names the changed files yourself. A changed file no suite names is printed
  as such: for a screen, that is the test that does not exist yet; for shared
  code, it is the cue below. It also runs, on every change, the few fast
  whole-tree guards that name no file (icons, inks, em dashes, the Global
  Chat route inventory, …). A guard opts in with a
  `// test:changed: always (…)` line; mark a new one only if it is fast.
- **Run `npm test` only when shared code moved and the mapping cannot see
  who depends on it** — a `public/js/**` module other modules reach through
  a global (the mapping runs the suites that name the module, not those of
  its callers), `app.css`, a primitive many screens draw with. After a check
  fails on the platform, re-run the failing suites and the ones for your fix,
  not everything.
- **A hang is a failure, not a wait.** `npm test` runs with
  `--test-timeout=180000`, which bounds every test and every file as a whole
  (the slowest file takes about twelve seconds); a test that never settles
  fails after three minutes instead of holding the summary open.

## Declare visible changes for before/after shots

Every proposal that changes something people can see gets before/after shots.
A hosted dev-chat worker declares its changes with its supplied tool. An
external agent sends the same version-1 object as `visualEvidence` on
`submit_work`. Homeroom's preview agent then follows each declared change on
the exact before and after builds and saves what it sees: a still for each
screen size and side, plus a short clip of each side for
`animation: "motion"`. People look at the shots to judge the change. There
is no replay plan to write and nothing to verify locally.
`docs/proposal-visuals/before-after-shots.md` describes the whole flow.

- Declare one to three changes, each as a person would say it, with the real
  `startPath` and `steps` that reach it and the persona and screen sizes
  it needs. Declare only a state you actually reached in the running app.
- Add `intent.hints` when you learned something the preview agent would
  otherwise have to rediscover. `setup` names data to create through the UI
  first, `expectText` gives short text that shows the state was reached, and
  `focusTarget` locates the element to point at. Hints guide; they are never
  executed.
- `impact: none` applies only when no user-visible state changes. Changed
  text, counts, loading, error, and status states need a `ui` change even if
  the code reuses existing markup and styles. If a required fixture or state
  is missing, report that blocker instead of declaring `none`.
- For an error state caused by a failed API request, declare
  `intent.controlledFailurePath` as one exact same-origin `GET /api/...`
  path, and make the first `intent.steps` entry exactly
  `Controlled test: deliberately block the declared API GET on both revisions.`
  The preview agent blocks that request on both builds, and people see the
  controlled-test label. Do not use this for a normal success state.
- A change the preview agent cannot reach is shown as skipped with its
  reason, and the other changes still publish. Better steps or hints, then
  "Take the shots again", is the fix.

## Communities own projects — name them the way the screen does

- **Internally the container is a `community`; on screen it is named by its
  audience.** Every app belongs to exactly one community (`apps.community_id`,
  the "Communities" block at the end of `src/db/schema.sql`,
  `src/services/communities.js`), and a community is what people join.
  People see it by its audience — **Just you** (`solo`), **Group**
  (`invited`) or **Community** (`open`) — and what it owns are **projects**.
  Use "project" in user-facing copy where the app is the thing being built;
  keep "app" where it is the thing being used (the App tab, Discover).
- **Communities is the fourth tab, beside you; Messages is in the middle.**
  It lists every community you are in
  (Communities, Groups, Just you) at `#communities` (`#workshop` still routes
  there; the tab's key and ids keep `workshop`). A project's page opens on
  its **hub** (a hero with who is here and a 14-day trend, then its channel,
  Needs you, and Since your last visit) beside its **Workshop** (what you are
  working on, All items). The Communities screen's Needs you is one feed of
  every decision owed across your projects (`GET /api/workshop/needs-feed`). A
  project's channel lives on its hub, not in Messages, and #general is the
  Homeroom community's channel; Messages is people and agents. **A channel
  is what people said:** Homeroom writes no activity (a proposal put up for a
  vote, a merge, a check verdict, a setting changed) into a project's channel
  or #general. `ws.sendSystemMessage` writes nothing without a thread, so a
  new platform line names the proposal's, request's or decision's own thread
  (`{ type: 'session' | 'issue' | 'governance', ref }`) or is not written.
  App-wide state is shown where it lives: merges paused and a stalled release
  are banners on the project page, and settings changed lately and the
  Friday card are the Workshop tab's notices panel (`services/app-notices.js`,
  read from `events` — record a new kind there, not a chat line).
  `migrate.clearAutomatedChannelLines` clears the lines written before. A
  door to a project's hub (a link that says so) calls
  `AppView._landOnHub(slug)` first, so it opens on the hub rather than the
  tab the page was last left on. Back and Forward are not doors: the page
  reopens on the tab last shown, read fresh when it mounts.
- **Audience is derived, never stored.** `communities.audienceSql` reads it
  off the app's `view_visibility` and its member/invite count. A second
  stored copy is one the visibility reconcile would have to remember. So a
  project GROWS by the same two levers: Invite makes Just you a Group, and
  the hero's "Open it up" / "Make it a group" opens the visibility PR
  (`POST /api/apps/:slug/visibility-pr`), which applies once it merges.
- **Communities and apps are one-to-one today.** A community with a single
  project is drawn as that project — its name, icon and page — and nothing
  should render a separate "community" layer for it. The table is bare on
  purpose; a name and an audience move onto it when a community can own
  more than one project.
- **A project is created FOR someone.** The create dialog asks who it is for
  first (Just me, A group, A community) and `POST /api/apps` takes
  `audience`, a group's `invitees` and the approval rule as dapp.json's own
  `governance` block (`src/services/create-options.js`). The rule is written
  into the new repository's dapp.json by the template, so it is votable later
  like any other line there; an import's own dapp.json decides instead. Every
  project uses an app slot whatever its audience: each one is a real
  container and database.
- **Membership gates taking part, not reading.** Starting a change,
  proposing, filing a request, voting (on proposals and requests) and posting
  in an app's chat answer 403 `join_required` to a non-member
  (`communities.requireAppMembership` / `requireSessionMembership` /
  `requireIssueMembership`, and `chatNeedsJoin` on the WebSocket, which
  answers with a `join_required` frame). Mount the matching gate on any new
  write route of that kind; the client's fetch wrapper
  (`frontend/src/lib/join-required.ts`) turns the 403 into a Join prompt and
  a retry, so no caller handles it by hand. A Mayor or connector tool keeps
  the code (`mcp-tools.platformError` answers `join_required` with the app),
  and the Mayor's refused card offers Join itself. The collab guard in
  `app-access.js` still decides who may be there at all; admins pass.
  Collaborators, Home pins and platform access join by trigger — write those
  rows, not `community_members`, unless the action is literally Join or
  Leave. The vote threshold counts active MEMBERS
  (`services/active-users.js`, concept #3).
- **An invite link grants what its maker could grant.** `/invite/<token>`
  (`services/community-invites.js`, the "Communities, stage 6" block of
  `schema.sql`) is made by any member from the logo menu's "Invite to
  community" pane: 7 days and 25 people unless they choose otherwise, and
  revocable. On a project where building is by invitation it is the
  collaborator invite, accepted; anywhere else it is membership. One SQL
  function, `apply_community_invite()`, applies it, both on the spot and from
  the trigger that runs when an account is let in, so a person without
  platform access is QUEUED and joins on release, however that happens. The
  page carries the token in an HttpOnly cookie, so signing up or in from it
  follows the link server-side (`redeemCarried` in `routes/auth.js`). The
  invite tree (`users.admitted_by`, `invite_generation`; skips of 10, 5, 2)
  is built and OFF behind `INVITE_TREE_ENABLED`; `grantPlatformAccess` is
  "let in by us", generation 0.

## `public/index.html` is a GENERATED artifact — edit `frontend/`, never commit outputs

- The shell's markup is React now. **Do not edit `public/index.html`** — it is
  built from `frontend/` and any hand edit is overwritten by the next build.
  The sources are:
  - `frontend/src/Shell.tsx` — the whole `<body>`: a static tree that composes
    the converted screens' island components (see the statefulness rule
    below). It holds no state itself.
  - `frontend/src/head.html` — the `<head>`, carried over verbatim.
  - `frontend/@/components/ui/` — shadcn primitives, restyled to the
    platform's existing `zinc`/`violet` palette (`cssVariables: false`).
- **Never add or commit `public/index.html` or
  `public/shell/assets/shell.js`.** Both are gitignored and rebuilt from the
  lockfile-pinned frontend sources by every Docker image. For local browser
  work run `npm run ensure:shell` (or `npm run build:shell` after installing
  `frontend/`); `npm test`, `npm start`, and `npm run dev` ensure the ignored
  outputs they need automatically. `tests/shell-build.test.js` pins that
  lifecycle instead of comparing a committed fixture.
- `npm run ensure:shell` generates the shell and then its CSS in the required
  order. If invoking the low-level commands directly, **run `build:shell`
  FIRST, then `build:css`.**
  `public/index.html` is a Tailwind content source *and* a shell-build output,
  so compiling the stylesheet first scans the previous document. The Docker
  image build enforces the same ordering: its shell builder prerenders the
  current `index.html`, then the CSS builder scans that generated document.
  There is no loop — `tailwind.css` is not a shell input.
- **`Shell.tsx` is now hand-maintained; resolve conflicts in it directly.** The
  one-time generators that derived it from the hand-written document
  (`html-to-jsx.cjs`, `apply-step1-edits.cjs`) and the pre-migration fixture
  they read are gone — step 2 changes the markup on purpose, so re-deriving it
  from main would throw the conversion away. Merge `Shell.tsx` like any other
  source file.
- Two constraints in `frontend/src/Shell.tsx` are load-bearing, and its header
  comment explains each: it **renders the legacy `<script>` tags** in their
  original order (`app.js` must stay last), and **converted markup is
  like-for-like** — same ids, class strings, `hidden` semantics and `data-*`
  attributes as the hand-written shell, because `public/js/**` looks those up
  by `getElementById` and `dapp.json`'s 338 declared tests select on deep
  chains of them. The structural baseline is
  `tests/baselines/shell-markup.json` (ids, `data-*` names, script order,
  stylesheet order), enforced by `tests/shell-id-inventory.test.js`,
  `tests/dapp-selectors-resolve.test.js` and
  `tests/shell-script-order.test.js`. **Never refresh the baseline to go
  green** — record each deliberate change in that chunk's commit in the
  `RETIRED_IDS`/`ADDED_IDS` and `RETIRED_SCRIPTS`/`ADDED_SCRIPTS` maps, with a
  reason. `scripts/derive-shell-baseline.js` exists for a reviewed wholesale
  refresh only.
- **A region may become stateful only when its entire subtree is React-owned**
  — no `public/js/**` module may write into any node inside it. The shell is a
  static tree containing stateful islands; React reconciling over DOM that a
  legacy module also mutates is the failure this rule prevents. Two corollaries:
  an island's *initial* render must emit exactly the empty/hidden markup the
  hand-written shell shipped (data loads in effects, never in initial render —
  otherwise hydration mismatches `console.error`, which fails proposal checks),
  and screen visibility must be published through
  `frontend/src/lib/visibility-store.ts` rather than by toggling `.hidden` from
  outside React.
- **The nine dialogs present themselves through
  `frontend/src/lib/static-modal.ts` — nothing outside React lifts their
  cards.** That seam used to be `PlatformUI.adoptStaticModal`, which watched
  each root in `STATIC_MODAL_IDS` and, when `hidden` came off, lifted the card
  element out of the root — leaving a comment placeholder — into the native
  kit's `presentModal` shell. Two owners wrote to those nodes, so the dialogs
  had to stay markup-only. #1078 chunk I moved the lift inside React
  (`useStaticModal`, driven by `features/dialogs/use-dialog.ts`) and retired the
  `public/js/**` copy, which is what made all nine stateful. **Drive a dialog
  only through `useDialog`** — it owns `hidden`, the kit hand-off, the
  backdrop-dismiss rule and the ghost-click guard, and it publishes the
  controller on `window.UsernodeReact.dialogs.<name>` for the legacy callers.
  Two things it does not relax: the root's `className` is still rendered once,
  as a constant, because the kit writes `platform-modal-adopted` to that node;
  and anything a controller module fills by `innerHTML` (the members roster,
  the secrets rows, the feedback status line) stays that module's host. The
  same applies to any element the kit or `app.css` writes classes to at runtime
  — use the `useHiddenClass` / `useClassToggle` refs in
  `frontend/src/lib/legacy-dom.ts`, never a rendered `className`.
- Adding or removing a `public/js/**` script means updating `SHELL_ASSETS` in
  `public/sw.js` and the count in `tests/shell-script-order.test.js` too.

## One language, two surfaces — keep the boundary

This repo ships **one** visual vocabulary in **two tunings**, and the split
between them is about the SURFACE each is drawn for, not about styling.

- **The platform shell** — `frontend/@/components/ui/**`. shadcn primitives,
  hand-rolled, `cssVariables: false`, in the platform's `zinc`/`violet`
  palette. Twenty-two modules today: `alert`, `anchored-panel`, `button`,
  `chat`, `chip`, `dialog`, `feed`, `field`, `grouped-list`, `icon-tile`,
  `icons`, `input`, `label`, `page-header`, `password-input`, `progress-ring`,
  `select`, `skeleton`, `switch`, `tabs`, `textarea`, `wordmark`.
  Count them in the directory rather than trusting this line — it has been
  stale before, and a primitive nobody knows exists gets hand-written instead.
  Variants are `cva` tables; every class in them is a complete literal, because
  Tailwind's extractor is a regex over source text and a computed class name is
  a class name that never gets compiled.
- **The admin console** — the `AdminUI` registry in
  `frontend/src/features/admin/admin-console.js`. A frozen object of class
  *recipes* (`AdminUI.card`, `AdminUI.btn.primary`, `AdminUI.cardTitle`, …). It
  is published on `window.AdminUI` as well as exported, because the section
  modules (`admin-analytics.js`, `admin-mail.js`, `admin-topochain.js`, …) read
  it as a bare identifier at call time.

The console used to be a genuinely separate design system — the topochain
admin's `gray`/`indigo`, deliberately not the shell's `zinc`/`violet`. The
widget-language reskin folded it in: same scales, same figure/ground, same
filled controls, same radii. `gray-*` and `indigo-*` now appear NOWHERE in the
product, and `tests/admin-ui-registry.test.js` enforces that as one rule over
`frontend/@/components/ui/**`, `frontend/src/**` and `public/js/**` rather than
as a split. It is worth knowing WHY that rule is absolute: `zinc` and `violet`
are overridden in `tailwind.config.js` — `violet-*` is the BLUE accent now, not
a violet — so a stray `bg-gray-100` or `bg-indigo-500` renders an untuned stock
hue beside the platform's, which is a difference no reviewer spots in a diff of
class strings.

**Do not cross the surfaces.** What is left after the reskin is a density
boundary, and it does not dissolve as sections convert to React: a 44px tap
target and a card with 1.5rem of padding are right on `#home` and wrong in a
table of 130 rows on a 27" display. A shell component handed `AdminUI.card`
and an admin section reaching for `<Button>` are the same mistake in the two
directions, and the same test catches both — no admin source imports from
`@/components/ui/`, and nothing outside `features/admin/` mentions `AdminUI`
in code (prose in comments is fine). It also holds the console to its own
registry: a section may not hand-write a class string a recipe of five or more
utilities already covers — interpolate the key, or the copy stops tracking the
recipe the first time it changes.

### Type and colour on the platform shell — one scale, one accent

The shell's screens read as one product because a few choices are made once.
Make new UI from them rather than choosing again; the primitives already
carry most of them.

- **Rows are 15 over 13.** `ListRow`'s title is 15px at weight 650, its
  subtitle 13px muted. Messages' `.messages-row-name` / `-preview` use the
  same pair. A 17px bold row title makes every row a heading.
- **A label over a card is small caps; a title inside a card is a
  sentence.** `SectionHeader` is 12px bold uppercase, tracked `0.06em`, muted
  (Messages' `.messages-section-head` matches it). It is the only uppercase
  text in the shell. A heading inside a card (`.dev-ws-head-title`) stays
  sentence case. A page has at most one large heading, such as the project
  hero's name.
- **Cards are the plane colour, 20px, one hairline.** `GroupedList` draws
  them: `--dc-sheet-solid` (tone `plane`) or white, `rounded-[20px]`, and an
  inset `--app-sheet-line` hairline. A list drawn outside the primitive (for
  example `.messages-section-card`) spells the same three values.
- **One accent, with three jobs kept apart.**
  - `violet-*` (the blue: `tailwind.config.js` overrides it) and `--accent`
    mark an action, or a number that asks for the viewer ("3 to vote").
  - `--lit-ink` / `--lit-tint` / `--lit-line` mark where you are: the lit
    tab on the phone bar, the rail row, and the Workshop strip's marker.
  - `--brand-*` periwinkle is the header's own ink (the app chip, the bell,
    the back disc) and nothing else.

  A state that is already done gets no fill. "Joined" is grey with a check;
  a filled green pill made the settled thing the loudest thing on screen.
- **Say it in words, and let zero say nothing.** A count on a row is a
  phrase ("2 in progress · 3 to vote"), not a glyph and a bare number that
  need a legend. A zero is hidden (`hidden`, kept in the DOM when a declared
  check selects on it). Show a status dot only when something is wrong,
  never a green dot on every running app.
- **At most one pill on a list row.** Use `AppPills limit={1}`. Pass the
  heading's own words to a row's label so the row does not repeat them.

Tests pin the literals where they live (`tests/section-heading-primitives`,
`tests/nav-tab-bar`, `tests/workshop-screen`), so a change to one of these is
a change to the rule. Make it here as well.

### The console is React — add a section the same way

**Every admin section renders from React.** `admin-console.js` is a chassis
(routing, the nav, `canWrite`/`_alert`/`_confirm`, the money helpers) and
`admin-topochain.js` is a router for the eleven programme screens under
`frontend/src/features/admin/topochain/`. Neither builds markup. A NEW section
follows the same seam rather than reintroducing an `innerHTML` one.

`AdminConsole._renderSection` hands each section module its content host and
calls `mod.render(host)`, so a section module is:

```js
render(el) { host = el; mountLegacyPortal(el, <Section/>); },
destroy()  { unmountLegacyPortal(host); host = null; },
```

Five things that hold across all of them:

- **The host is genuinely single-owner.** Every path into
  `#admin-section-content` — `_renderSection`, `_renderMobileMenu` — runs
  `_teardownActiveSection()` first, so exactly one section occupies it at a
  time and each owns its whole subtree. That is the ownership rule satisfied at
  the section boundary, not at a node inside it. The programme screens nest the
  same arrangement one level down: `admin-topochain.js` owns
  `#admin-topo-content` and mounts exactly one screen into it, tearing the
  previous portal down BEFORE the `innerHTML` that discards the node.
- **`destroy()` is the state reset.** Dropping the portal entry gives the next
  `render()` a fresh `seq` and therefore a fresh component instance.
- **Use the surface, don't re-derive it.** A console section builds from the
  `AdminUI` recipe registry; a programme screen builds from
  `topochain/ui.tsx` (`Panel`, `ScreenHeader`, `List`, `Pager`, `Field`,
  `FormGrid`, `FormError`, `Skeleton`, `EmptyState`, `ErrorState`, `Badge`,
  `CloseButton`, `BackButton`, …) and `topochain/tokens.ts`. Fetching goes
  through `topochain/api.ts`. Re-implementing any of these is how two panels
  stop matching.
- **Ids are like-for-like on a conversion.** `dapp.json`'s declared checks
  select on them, so keep every id, `data-*` and class string unless the
  product change requires otherwise. `esc()` goes away — React escapes text
  children — but the rule it could not express does not: an admin- or
  API-supplied URL is NEVER rendered as a clickable anchor.
- **Scope the host in the ownership audit.** Add
  `{ sel: '#admin-section-content', when: '#admin/<key>' }` (or
  `{ sel: '#admin-topo-content', … }` for a programme screen) to `OWNED` in
  `scripts/audit-react-ownership.mjs`, and the route to `ROUTES`. The `when`
  clause is load-bearing: the host is shared, so an unscoped entry would report
  a sibling section's writes as a violation.

Two behaviours are easy to lose to React's defaults and are worth naming:

- **A search box that drives a paged server query commits on blur or Enter,
  not on every keystroke.** React's `onChange` is the DOM `input` event; these
  boxes listened for `change`. Keep them uncontrolled with a `defaultValue` and
  commit in `onBlur` / `onKeyDown`.
- **A cross-screen jump needs an explicit export.** Delegations' "View
  account" opens the dialog Onchain accounts owns; Seasons' "View events"
  hands Season events a pre-set filter. Publish a function from the target
  module and import it — a bare global read broke exactly this way once, and
  a dead button is silent.

## Shell CSS is generated by the image build — do not commit it

- **Cache releases are generated too.** `scripts/build-shell-release.js` runs
  after the shell and CSS builds and writes ignored `public/shell/release.json`
  and `public/shell/worker.js`. The fixed `/sw.js` URL serves this generated
  worker. Its asset hashes change automatically with the built interface,
  including lazy chunks; do not bump `SW_VERSION` for UI changes. Keep all
  image paths and `ensure:shell` in the same shell → CSS → release order.
  Hosted images must carry their exact `GIT_SHA` through build and runtime.
  Test updates with an existing cache as well as a fresh browser. The stable
  API cache and assets used by open tabs must survive a shell upgrade.

- The platform shell's Tailwind is **compiled**, not loaded from a CDN:
  `tailwind.config.js` + `styles/tailwind-input.css` build to
  `public/css/tailwind.css` via `npm run build:css`. The Dockerfile runs that
  command in a disposable builder stage on every production/staging image and
  copies only the result into the production-only runtime stage.
- `public/css/tailwind.css` is gitignored and excluded from the Docker build
  context. **Never add or commit it.** For local browser work, run
  `npm run build:css` (or `npm run watch:css`); the ignored output is only a
  convenience for that checkout.
- The compiler scans `public/index.html`, `public/js/**`, the usernode-native
  demo, and `frontend/**`. The frontend tree is scanned because shadcn variant
  tables hold classes that appear in no static markup.
- Tailwind stays pinned at **v3.4.17**. v4 changes utility semantics (default
  border colour, ring width, opacity utilities, the `space-*` selector) and
  would silently restyle the whole shell — it is a deliberate later decision
  with its own before/after evidence, not a free upgrade.
- `tests/tailwind-build.test.js` performs a fresh compile into a temporary
  directory, validates representative utilities and palette semantics, and
  pins the Docker builder/copy contract. Its `public/index.html` input is the
  ignored output materialized by the test preflight, never a committed
  artifact.
- The shell loads **no cross-origin assets**. marked, DOMPurify and qrcodejs
  are vendored under `public/vendor/` by `npm run vendor:assets` (provenance
  in `public/vendor/README.md`). Don't add a CDN `<script>`/`<link>` to
  `frontend/src/head.html` — vendor or compile it instead; three tests
  enforce this.
- The three stylesheet links must stay in the order `native.css` → `app.css`
  → `tailwind.css`, with the compiled utilities **last**. `app.css` was
  written against a cascade where Tailwind wins equal-specificity conflicts;
  inverting it silently restyled the whole dev screen once (#938). The head
  also probes this at runtime and `console.error`s when it breaks — which
  fails proposal checks, since a console error on any route does.
