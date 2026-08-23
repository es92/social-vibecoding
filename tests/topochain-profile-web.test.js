// Profile on the web: the drawer row is no longer gated on the native
// bridge, and a signed-out visitor gets a sign-in prompt instead of a
// generic failure.
//
// The bug this pins: #profile worked perfectly in an ordinary browser —
// /challenges-api/me/* scopes to the platform session server-side since
// the topochain merge — but the drawer entry was revealed only when the
// bridge reported the `getProfileInfo` capability. On the web the screen
// therefore existed and was unreachable. The capability probe was the ONLY
// thing hiding it.
//
// Second half: those routes require a session (requireSessionUser), so an
// anonymous visitor got an opaque `HTTP 401` funnelled into "Could not
// load your profile — check your connection", which blames the network for
// what is really "you aren't signed in".
//
// Run with: node --test tests/topochain-profile-web.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = read('public/index.html');
// The shell's markup SOURCE. public/index.html is a generated artifact now
// (the React + shadcn chassis swap), and JSX comments never reach it — so
// assertions about the explanatory comments around a screen have to read the
// source they actually live in.
const shellSource = read('frontend/src/Shell.tsx');
// #1079 chunk B moved the drawer (#header-menu-panel) out of Shell.tsx into its
// own island — same markup, same comments, new file.
const menuSource = read('frontend/src/features/header/header-menu.tsx');
const nativeChrome = read('public/js/native-chrome.js');
const profileJs = read('frontend/src/features/profile/profile.js');
// #1083 chunk F did the same for the screen itself: <main id="profile-screen">
// and its host div moved out of Shell.tsx into this island, which is also where
// the renderer now lives (./profile.js beside it). Shell.tsx keeps the comment
// describing where the screen's data comes from, above the <ProfileScreen /> it
// renders in the region's place — so the comment assertions below read both.
const profileIsland = read('frontend/src/features/profile/index.tsx');
// #1191 slice 6 finished the conversion: #profile-root is React-owned end to
// end now, so this module's DOM builders are gone. What it decides — which of
// the six load states the screen is in, how a completed row reads, what goes in
// the fallback circle — moved into profile-store.js, which is plain JS on
// purpose so this suite can still read it. The markup moved into three .tsx
// files. Assertions follow the code.
const profileStoreJs = read('frontend/src/features/profile/profile-store.js');
const profileViewTsx = read('frontend/src/features/profile/profile-view.tsx');
const profileSheetTsx = read('frontend/src/features/profile/profile-edit-sheet.tsx');
const profilePublicTsx = read('frontend/src/features/profile/public-profile-card.tsx');

// ─── The drawer row ships visible ───────────────────────────────────────

test('drawer-row-profile carries no `hidden` class', () => {
  const anchor = indexHtml.slice(
    indexHtml.indexOf('<a id="drawer-row-profile"'),
    indexHtml.indexOf('</a>', indexHtml.indexOf('<a id="drawer-row-profile"'))
  );
  assert.ok(anchor, 'the profile anchor must exist');
  const classAttr = (anchor.match(/class="([^"]*)"/) || [])[1] || '';
  assert.ok(!/\bhidden\b/.test(classAttr),
    'the row must ship visible — a `hidden` class puts it back behind the bridge');
});

test('native-chrome no longer gates the profile row on getProfileInfo', () => {
  const fn = nativeChrome.slice(
    nativeChrome.indexOf('_initDrawerRows()'),
    nativeChrome.indexOf('// ── Platform login handoff')
  );
  assert.ok(fn.length, '_initDrawerRows must still exist');
  assert.doesNotMatch(fn, /has\(['"]getProfileInfo['"]\)/,
    'the capability probe was the only thing keeping #profile off the web');
  // The drawer-close wiring is the reason the function still exists.
  assert.match(fn, /drawer-row-profile/);
  assert.match(fn, /HeaderMenu\.close\(\)/);
});

test('the stale "hidden unless the bridge reports getProfileInfo" comments are gone', () => {
  // Comments that describe behaviour the code no longer has are worse than
  // no comment: the next reader trusts them.
  const profileAt = menuSource.indexOf('id="drawer-row-profile"');
  assert.ok(profileAt > 0, 'the drawer row must still live in the menu island');
  const anchorComment = menuSource.slice(Math.max(0, profileAt - 900), profileAt);
  assert.doesNotMatch(anchorComment, /Hidden unless/i);
  assert.doesNotMatch(
    nativeChrome.slice(0, nativeChrome.indexOf('const NativeChrome')),
    /shown\s*\n?\/\/\s*when the bridge reports getProfileInfo/,
    'the module header must not still claim the row is capability-gated');
});

test('the screen-host comments no longer describe an external leaderboard', () => {
  // The screen reads from this platform's own database now; the external
  // deployment it used to proxy is retired. Anchored on #profile-screen
  // alone since the leaderboard merge: the sibling #challenges-screen
  // <main> this used to start from is gone, folded into the Leaderboard
  // screen's Challenges tab.
  //
  // Two files since chunk F: the comment sits in Shell.tsx above
  // <ProfileScreen />, the host markup it describes sits in the island. Both
  // are checked, so moving the prose to either side keeps this honest.
  const shellAt = shellSource.indexOf('<ProfileScreen />');
  assert.ok(shellAt > 0, 'the shell must still render the profile screen');
  const islandAt = profileIsland.indexOf('id="profile-screen"');
  assert.ok(islandAt > 0, 'the island must still host #profile-screen');
  const hosts = shellSource.slice(Math.max(0, shellAt - 1200), shellAt)
    + profileIsland.slice(0, islandAt + 400);
  assert.doesNotMatch(hosts, /public leaderboard service/);
  assert.doesNotMatch(hosts, /using the bridge's\s*\n?\s*getProfileInfo participant id/);
  assert.match(hosts, /in-process/,
    'the comments should say where the data actually comes from');
});

// ─── Signed-out state ───────────────────────────────────────────────────

test('_fetchJson carries the HTTP status onto the thrown Error', () => {
  // Without this, _load() cannot tell 401 (not signed in) from 500.
  const fn = profileJs.slice(
    profileJs.indexOf('async _fetchJson('),
    profileJs.indexOf('async _load(')
  );
  assert.match(fn, /err\.status\s*=\s*res\.status/);
});

test('_load renders the signed-out state for an anonymous visitor', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  // Cheap pre-check: the SPA boots anonymously, so skip the round-trip.
  assert.match(fn, /App\.user/, 'checks for a session before fetching');
  assert.match(fn, /signedOut:\s*true/);
  // And the 401 branch, for a session that lapsed while the screen was open.
  assert.match(fn, /err\.status === 401/);
});

test('a 401 replaces stale data rather than leaving the last user on screen', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  const branch = fn.slice(fn.indexOf('err.status === 401'));
  // `_data = { signedOut: true }` unconditionally — NOT `if (!_data)`,
  // which would keep showing the previous user's rank after logout.
  assert.match(branch.slice(0, 300), /Profile\._data = \{ signedOut: true \}/);
});

test('the signed-out render offers a sign-in link, not the connection error', () => {
  const branch = profileViewTsx.slice(
    profileViewTsx.indexOf("view.kind === 'signedOut'"),
    profileViewTsx.indexOf("view.kind === 'error'")
  );
  assert.match(branch, /Sign in to see your profile/);
  assert.match(branch, /#login/, 'links to the in-SPA login route');
  // The generic copy must survive for REAL failures.
  assert.match(profileViewTsx, /Could not load your profile/);
});

test('the signed-out branch is checked before the generic error branch', () => {
  // Twice over: in buildProfileView, which decides the kind, and in the
  // component, which renders it. Either order flipping puts the
  // connection-error copy in front of a visitor who is merely logged out.
  const build = profileStoreJs.slice(profileStoreJs.indexOf('export function buildProfileView'));
  assert.ok(build.indexOf('d.signedOut') < build.indexOf('d.error'),
    'otherwise a signed-out visitor still sees the connection-error copy');
  assert.ok(profileViewTsx.indexOf("view.kind === 'signedOut'")
    < profileViewTsx.indexOf("view.kind === 'error'"));
});

// ─── The editable profile (issue #982) ──────────────────────────────────
//
// The screen grew an identity card and an edit sheet, and its completed
// list stopped being the organiser's flag. These pin the parts a later
// refactor could quietly undo.

test('the identity card renders picture, name and the way in to editing', () => {
  const fn = profileViewTsx.slice(
    profileViewTsx.indexOf('function IdentityCard('),
    profileViewTsx.indexOf('function PublicControls(')
  );
  assert.ok(fn.length, 'IdentityCard must exist');
  assert.match(fn, /IdentityAvatar/, 'the picture, or the initial-in-a-circle fallback');
  assert.match(fn, /profile-edit-btn/);
  assert.match(fn, /Profile\.showEditSheet\(\)/);
  const chips = profileStoreJs.slice(profileStoreJs.indexOf('export function identityView'));
  assert.match(chips, /Your builder profile/);
  assert.match(chips, /#leaderboard\/users\//, 'the builder-profile link goes to the kudos page');
});

test('the bio is a text node, never innerHTML', () => {
  // It is deliberately plain text, not markdown — nothing renders it
  // through marked/DOMPurify, so it must never reach innerHTML.
  // dangerouslySetInnerHTML is the React spelling of the same mistake.
  for (const [name, src] of [
    ['profile.js', profileJs],
    ['profile-store.js', profileStoreJs],
    ['profile-view.tsx', profileViewTsx],
    ['profile-edit-sheet.tsx', profileSheetTsx],
    ['public-profile-card.tsx', profilePublicTsx],
  ]) {
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /innerHTML/, `${name} must render text as text`);
  }
  assert.match(profileViewTsx, /whitespace-pre-line/, 'newlines in a bio still render');
});

test('outbound handle links are scheme-guarded and rel-protected', () => {
  const fn = profileStoreJs.slice(profileStoreJs.indexOf('export function identityView'));
  assert.match(fn, /safeHref\(href\)/,
    'escaping alone would not stop a javascript: href');
  assert.match(fn, /encodeURIComponent\(links\.github\)/);
  assert.match(profileStoreJs, /\^https\?:\\\/\\\//, 'safeHref pins http(s) only');
  // Only the chips built from a user-supplied handle are external; the
  // in-app builder link is not, which is why the flag rides on the chip.
  assert.match(fn, /external: true/);
  assert.match(profileViewTsx, /rel: 'noopener noreferrer'/);
});

test('the username is shown read-only, with somewhere to go', () => {
  assert.match(profileSheetTsx, /id="profile-edit-username"/);
  assert.match(profileSheetTsx, /\breadOnly\b/);
  assert.match(profileSheetTsx, /\bdisabled\b/);
  // The field is still read-only HERE, and still explains itself — a
  // greyed-out field with no explanation reads as a bug. What changed in
  // #1336 is that the explanation is a ROUTE rather than a refusal: the
  // rename exists, it just needs the current password, so it lives in
  // Settings next to Change password.
  assert.match(profileSheetTsx, /#settings\/username/,
    'the footnote must point at the screen that can actually do it');
  assert.doesNotMatch(profileSheetTsx, /can’t be changed/,
    'the handle CAN be changed since #1336 — this copy would be a lie');
  // Nothing may ever PATCH it: the rename is its own credential-gated
  // endpoint (POST /api/me/username), never a profile field write.
  const save = profileJs.slice(profileJs.indexOf('async _save('));
  assert.doesNotMatch(save.slice(0, 2500), /username:/);
});

// This file's header comments discuss the retired `kind: 'sheet'` and the kit's
// class vocabulary on purpose — that is where the reasoning lives — so the
// #1285 assertions below read the CODE, with both comment forms stripped.
const sheetCode = profileSheetTsx
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the edit card degrades when the native modal kit is absent', () => {
  // The lift goes through lib/kit-surface.ts, which returns null when the kit
  // is missing or refuses — the same `|| null` shape Settings.showTermsSheet
  // handles. The editor must still be reachable, so the card simply stays
  // where React rendered it: inside #profile-root.
  assert.match(sheetCode, /adoptKitSurface\(\{/);
  // `kind: 'sheet'` until #1285, and the swap is the fix, not a preference.
  // `.platform-sheet-adopted` pins `max-height: 70vh` and `.un-sheet` sets
  // `touch-action: none` with no scroller detection, so a form this tall was
  // clipped and the drag that tried to scroll it dismissed it instead.
  // `.un-modal` is a real keyboard-aware scroller. Same move as #915's
  // sheet→panel for the hamburger drawer.
  assert.match(sheetCode, /kind: 'modal'/);
  assert.doesNotMatch(sheetCode, /kind: 'sheet'/);
  // The kit takes the CARD and the flag goes on the ROOT — the dialogs' split,
  // and here it is forced: `.platform-modal-adopted` is `display: none
  // !important`, so it cannot land on the node the kit is showing.
  assert.match(sheetCode, /adoptedOn: flagEl/);
  assert.match(sheetCode, /id="profile-edit-root"/);
  assert.match(sheetCode, /home: 'placeholder'/,
    'its home is #profile-root — that IS the no-kit presentation');
  assert.match(profileViewTsx, /<ProfileEditSheet/,
    'rendered inside #profile-root, above the identity card');
});

test('both kit-written nodes render a CONSTANT className (#1285)', () => {
  // `adoptKitSurface` writes `platform-modal-adopted` to the root and
  // `platform-modal-card` to the card, through classList. React writes the
  // whole attribute whenever the prop changes, so a computed string on either
  // node drops the kit's class mid-presentation. That is also why the five
  // `useClassToggle(panelRef, …)` calls that used to draw the no-kit chrome are
  // gone: the chrome is now a constant on the root, which the kit hides for
  // free while it owns the card.
  assert.match(sheetCode, /const ROOT_CLASS = '[^']*'/);
  assert.match(sheetCode, /const CARD_CLASS = '[^']*'/);
  assert.match(sheetCode, /id="profile-edit-root" ref=\{rootRef\} className=\{ROOT_CLASS\}/);
  assert.match(sheetCode, /id="profile-edit-sheet" ref=\{panelRef\} className=\{CARD_CLASS\}/);
  assert.doesNotMatch(sheetCode, /useClassToggle/,
    'the no-kit chrome is a constant on the root now, not a runtime toggle');
});

test('the edit card is a column, and says so in its own class string (#1285)', () => {
  // THE bug in #1285. `app.css`'s `.platform-sheet-adopted` wrote
  // `display: flex !important` with no `flex-direction`, so this card — whose
  // whole class string was `px-4 pb-5` — laid its dozen children out in a ROW:
  // heading, photo group, every field and both buttons side by side, with
  // Cancel off-screen. The other adopted surfaces survived because each spells
  // `flex flex-col` itself (ANCHORED_PANEL_CLASS does), which the `!important`
  // on `display` alone cannot undo. This card now spells it too, so its layout
  // no longer depends on what an adopted class happens to set.
  const card = sheetCode.match(/const CARD_CLASS = '([^']*)'/);
  assert.ok(card, 'CARD_CLASS is a single-quoted literal');
  const tokens = card[1].split(/\s+/);
  assert.ok(tokens.includes('flex'), 'the card declares flex');
  assert.ok(tokens.includes('flex-col'), 'and the direction — that is the fix');
});

test('the form body is the kit inset-grouped list, by the kit rules (#1285)', () => {
  // `.un-group` / `.un-group-header` / `.un-group-row` come from native.css,
  // the same vocabulary features/settings/sections/alerts.tsx reaches into. The
  // heading-and-card pair is emitted once, by the local <Group>, so the section
  // count is its call sites.
  const group = sheetCode.slice(sheetCode.indexOf('function Group('));
  assert.match(group, /className="un-group-header"/);
  assert.match(group, /className="un-group"/);
  const sections = sheetCode.match(/<Group title="/g) || [];
  assert.ok(sections.length >= 4,
    `four labelled sections at least, saw ${sections.length}`);

  // Every class string that names a row also names px-4: the hairline
  // pseudo-element is drawn at `left: 16px` and `.un-group-header`'s own
  // padding is `0 16px 7px`, so a row without it puts its content off that
  // line.
  const rows = sheetCode.match(/'[^']*un-group-row[^']*'/g) || [];
  assert.ok(rows.length >= 3, `saw ${rows.length} row class strings`);
  for (const decl of rows) {
    assert.match(decl, /\bpx-4\b/, `a row must line up with the hairline: ${decl}`);
  }

  // No Tailwind fill on a `.un-group` element. `tailwind.css` loads AFTER
  // `native.css`, so a `bg-*` utility beats `var(--un-group-bg)` — the token
  // that makes the card read as raised against the modal's `--un-sheet-bg`,
  // and the only one that tracks the platform's dark mode. Tokenised, so a
  // row's own `focus-within:bg-*` (token `un-group-row`) is not caught.
  for (const decl of sheetCode.match(/'[^']*'|"[^"]*"/g) || []) {
    const tokens = decl.slice(1, -1).split(/\s+/);
    if (!tokens.includes('un-group')) continue;
    for (const t of tokens) {
      assert.doesNotMatch(t, /^(dark:)?bg-/,
        `--un-group-bg draws the card, not ${t}`);
    }
  }
});

test('the group rows get their field box from the primitive (#1285)', () => {
  // The row IS the box, so the field contributes no fill, no border and no
  // horizontal padding — routed through inputVariants rather than hand-written,
  // per tests/shell-primitive-adoption.test.js.
  const input = read('frontend/@/components/ui/input.tsx');
  assert.match(input, /groupRow:\n\s*'[^']*'/,
    'a complete literal — Tailwind extracts class names with a regex');
  const box = input.match(/groupRow:\s*\n?\s*'([^']*)'/);
  const tokens = box[1].split(/\s+/);
  for (const required of ['bg-transparent', 'border-0', 'px-0']) {
    assert.ok(tokens.includes(required), `groupRow must clear ${required}`);
  }
  assert.match(sheetCode, /box="groupRow"/);
  // `.un-group` is `overflow: hidden`, which clips an outward focus ring, so
  // every row field drops it and the row tints instead.
  const rings = sheetCode.match(/box="groupRow"\s*\n\s*ring=\{false\}/g) || [];
  const boxes = sheetCode.match(/box="groupRow"/g) || [];
  assert.equal(rings.length, boxes.length,
    'a clipped ring is no focus cue — focus-within tints the row');
  assert.match(sheetCode, /focus-within:bg-violet-50/);
});

test('the hidden file input sits OUTSIDE the group (#1285)', () => {
  // `.un-group-row + .un-group-row::after` is an ADJACENT-sibling selector, so
  // a non-row child between two rows silently drops the hairline between them.
  // #profile-edit-file is a real child wherever it sits.
  const group = sheetCode.slice(
    sheetCode.indexOf('id="profile-edit-file"'),
    sheetCode.indexOf('id="profile-edit-choose"'),
  );
  assert.match(group, /<Group title="Photo">/,
    'the file input is declared before the group it feeds, not inside it');
});

test('the photo is downscaled client-side before upload', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _prepareAvatar('),
    profileJs.indexOf('async _decodeImage(')
  );
  assert.ok(fn.length, '_prepareAvatar must exist');
  // The server ships no image decoder, so this is load-bearing, not polish.
  assert.match(fn, /toBlob/);
  assert.match(fn, /AVATAR_MAX_PX/);
  assert.match(fn, /AVATAR_MAX_BYTES/);
  assert.match(fn, /while \(blob && blob\.size > Profile\.AVATAR_MAX_BYTES/,
    'one re-encode is not enough — shrink until it fits');
  // Centre crop, so a portrait photo is not squashed into the circle.
  assert.match(fn, /bitmap\.width - side/);
  assert.match(fn, /bitmap\.height - side/);
});

test('object URLs for a staged photo are revoked', () => {
  assert.match(profileJs, /URL\.revokeObjectURL/);
  const fn = profileJs.slice(profileJs.indexOf('_clearPendingAvatar() {'));
  assert.match(fn.slice(0, 400), /revokeObjectURL\(Profile\._pendingAvatarUrl\)/);
});

test('nothing is written until Save, and the avatar goes first', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _save('),
    profileJs.indexOf('async _errText(')
  );
  const avatarAt = fn.indexOf("'/api/me/avatar'");
  const patchAt = fn.indexOf("'/api/me/profile'");
  assert.ok(avatarAt > 0 && patchAt > avatarAt,
    'the byte upload is the one that can fail — do it before the text write');
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /application\/octet-stream/);
  // And the post-write truth is re-read, not guessed at locally.
  assert.match(fn, /Profile\._refreshUser\(\)/);
});

test('field-level server errors keep the sheet open', () => {
  const fn = profileJs.slice(profileJs.indexOf('async _save('));
  assert.match(fn, /body\.details/);
  assert.match(fn, /if \(pinned\) return \{ fieldErrors \};/,
    'losing the user’s other edits to one bad handle would be its own bug');
  // The sheet pins them per field and stays mounted — _dismissSheet is only
  // reached on the success path.
  assert.match(profileSheetTsx, /setFieldErrors\(result\.fieldErrors\)/);
  assert.match(profileSheetTsx, /if \(result\.ok\) return;/);
});

test('the completed list is the viewer’s own, and every row links out', () => {
  assert.doesNotMatch(profileJs, /challenges\.filter\(\(c\) => c\.completed\)/,
    'c.completed is an ORGANISER flag — that filter showed 28 of production’s '
    + '34 live challenges to every signed-in person as their own completions');
  assert.match(profileJs, /\/api\/me\/challenges\/completed/);
  const shaping = profileStoreJs.slice(profileStoreJs.indexOf('export function completedView'));
  assert.match(shaping, /href: '#leaderboard\/challenges\/'/);
  const fn = profileViewTsx.slice(
    profileViewTsx.indexOf('function Completed('),
    profileViewTsx.indexOf('function TokenCard(')
  );
  assert.match(fn, /See all challenges/);
  assert.match(fn, /No completed challenges yet/);
  assert.match(fn, /Browse challenges/, 'the empty state offers a way forward');
});

test('the stale "organiser flag" comments are gone', () => {
  // A comment describing behaviour the code no longer has is worse than no
  // comment: the next reader trusts it.
  const header = profileJs.slice(0, profileJs.indexOf('const Profile = {'));
  assert.match(header, /ORGANISER flag/,
    'the header must explain what the list means now, and what it used to mean');
  assert.doesNotMatch(header, /completed challenges from the in-process/,
    'the old header described the /challenges-api grid read that is gone');
});

test('the drawer row can show the viewer’s picture', () => {
  const app = read('public/js/app.js');
  assert.match(indexHtml, /id="drawer-avatar"/);
  assert.match(indexHtml, /id="drawer-profile-glyph"/);
  // Ships hidden with NO src, so a signed-out shell requests nothing.
  const img = indexHtml.slice(indexHtml.indexOf('<img id="drawer-avatar"'));
  assert.match(img.slice(0, 200), /class="hidden/);
  assert.doesNotMatch(img.slice(0, 200), /\ssrc=/);
  assert.match(app, /applyUserAvatar\(\) \{/);
  assert.match(app, /App\.applyUserAvatar\(\);/, 'called on sign-in');
});

test('?shot=profile-edit opens the sheet for the screenshot capture', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('_maybeOpenShot() {'),
    profileJs.indexOf('async _prepareAvatar(')
  );
  assert.match(fn, /shot !== 'profile-edit'/);
  assert.match(fn, /Profile\._shotFired = true/, 'one-shot, so a refresh does not reopen it');
  // Pure UI state with no writes — an env gate would starve the "before"
  // side of the capture forever.
  assert.doesNotMatch(fn, /staging/i);
  // Declared checks used to be a CAPPED resource — the reader kept only the
  // first MAX_TESTS entries, so an entry's POSITION decided whether it ever
  // ran and each new one evicted an older. #1019 removed that cap: every
  // declared check runs, and the only bound left is MAX_DECLARED_TESTS.
  //
  // The surviving invariant is that the reader actually KEEPS these entries
  // (it still drops malformed ones) and that the manifest hasn't grown past
  // the ceiling and started shedding its tail again.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const live = meta.tests;
  assert.ok(live.some((t) => String(t.path).includes('shot=profile-edit')),
    'a state link that stops rendering must fail checks, not regress silently');
  const mine = live.filter((t) => t.name.includes('#982'));
  assert.equal(mine.length, 2, 'two slots, deliberately — see above');
});

test('the profile checks assert on the changed screen, not on "/"', () => {
  const appManifest = require('../src/services/app-manifest');
  const live = appManifest.read(path.join(__dirname, '..')).tests;
  const mine = live.filter((t) => t.name.includes('#982'));
  for (const t of mine) {
    assert.match(t.path, /#profile$/,
      'the self-app is hash-routed — a bare pathname boots the home feed');
    assert.ok(t.expectSelector, `${t.name} must assert on a real element`);
  }
  // The screen check proves BOTH halves of the change in one slot: the
  // corrected completed list (the selector) and the identity card above it
  // (the text, which only the card renders).
  const screen = mine.find((t) => t.path === '/#profile');
  assert.match(screen.expectSelector, /data-completed-challenge/);
  assert.equal(screen.expectText, 'Edit profile');
});

test('spending profile slots did not evict a still-needed check', () => {
  // The home-panels widget suite requires its own zero-state entry to stay
  // inside the cap. Prepending here is what could push it out, so assert it
  // from this side too rather than only discovering it in that file.
  const appManifest = require('../src/services/app-manifest');
  const live = appManifest.read(path.join(__dirname, '..')).tests;
  assert.ok(live.some((t) => t.path === '/?demo=1&challenges=none'),
    'the #947 challenges-widget zero-state check must still run');
});

test('the fallback circle picks a letter, not whatever character is first', () => {
  // A display name is free text: "[Staging demo] admin" or "…hello" would
  // otherwise put a bracket or an ellipsis in the circle.
  const fn = profileStoreJs.slice(
    profileStoreJs.indexOf('export function initialOf('),
    profileStoreJs.indexOf('export function avatarUrlOf(')
  );
  assert.match(fn, /\[\\p\{L\}\\p\{N\}\]/u,
    'match the first letter-or-digit');
  assert.match(fn, /u\.displayName, u\.username/, 'display name first, then the handle');
  assert.match(fn, /return '\?'/, 'and a last resort that is never blank');
});

test('the profile no longer fetches the season challenge list via the old route', () => {
  // #981: this screen stops paying for the season-wide grid it used to
  // filter client-side. /challenges-api/me/* and /challenges-api/seasons
  // must survive; the retired /challenges-api/challenges read must not.
  const body = profileJs.slice(profileJs.indexOf('const Profile'));
  assert.doesNotMatch(body, /\/challenges-api\/challenges/,
    'the old season-grid fetch must not come back');
  assert.match(profileJs, /\/challenges-api\/seasons/,
    'the season lookup stays — it scopes both /me/* reads and names the season');
  assert.match(profileJs, /\/challenges-api\/me\/ranking/);
  assert.match(profileJs, /\/challenges-api\/me\/breakdown/);
});
