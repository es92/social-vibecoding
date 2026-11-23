# P01: Navigation you can read

Topic: Navigation and top bar. Outcome branch: `claude/audit-p01-nav-readable`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### Bottom tab labels run into each other on small phones and with large system text

Report item 2 (`tab-labels`), severity High. Seen on: Phone, Android with larger font size, 320px phones.

- **What is wrong:** The five labels of the phone's tab bar are printed over each other: “Communities” leaves its lit pill and collides with “Homeroom bot”, which collides with “Messages”. It happens at 320px, and on any phone whose system text size is turned up (Android scales the text, not the bar). At 360px the lit label already touches both edges of its pill.
- **Cause:** The five seats are fixed shares of the bar (`1fr 1.25fr 1.4fr 1.15fr 1fr`), measured to fit the labels at 11px on a 360 to 390px screen, and the two long labels are allowed to overflow their seats rather than be cut.
- **Fix:** Size each seat from its own label (`repeat(5, auto)`) and share out the spare room evenly, so a pill always holds its word. If the five words are wider than the bar, the longest ends in an ellipsis instead of being printed over its neighbour.
- **Review note:** Approved after review. It shows on 320px-wide screens (iPhone SE 1st gen, or an SE or mini with Display Zoom set to Larger Text) and on Android with a larger Font size, which is why it doesn't show on a 393px phone at default text.
- **Pictures:** `refs/tab-labels/before-zoom432.png` (432px phone, system text at 130% (as in the production screenshot), before); `refs/tab-labels/after-zoom432.png` (432px phone, system text at 130% (as in the production screenshot), after); `refs/tab-labels/before-320.png` (320px phone, default text, before); `refs/tab-labels/after-320.png` (320px phone, default text, after); `refs/tab-labels/before-zoom393.png` (393px phone, system text at 130%: not enough room for all five, so the longest are shortened, before); `refs/tab-labels/after-zoom393.png` (393px phone, system text at 130%: not enough room for all five, so the longest are shortened, after)

### The unread count on the selected tab is white on yellow

Report item 6 (`nav-badge`), severity High. Seen on: Phone, Desktop, Light and dark.

- **What is wrong:** When Homeroom bot or Messages is the page you are on, its count sits on the yellow highlight in white numerals at 1.13:1 contrast, so it cannot be read. The Communities count, which uses a different style, stays legible.
- **Cause:** The grey “new to read” badge fills itself with `--text-faint`, which the navigation panel rebinds to white at 32%. The rule that recolours counts on the lit row names the vote counts but not this badge.
- **Fix:** On the lit row the badge takes the row's own dark ink on a light tint of it: still the quiet count, and readable.
- **Pictures:** `refs/nav-badge/before-rail.png` (Desktop sidebar, Homeroom bot selected, before); `refs/nav-badge/after-rail.png` (Desktop sidebar, Homeroom bot selected, after); `refs/nav-badge/before-tabs.png` (Phone tab bar, Messages selected, before); `refs/nav-badge/after-tabs.png` (Phone tab bar, Messages selected, after)

### Communities without a picture are blank white squares in the desktop sidebar

Report item 8 (`rail-tiles`), severity Medium. Seen on: Desktop, Tablet, Light mode.

- **What is wrong:** In the sidebar's Recents and Pinned lists, a community that has no icon should show its initial on a white tile. In light mode the tile is empty, so several communities look identical.
- **Cause:** A letter tile's initial uses `--text-faint`, and the panel rebinds that to white at 32% for its blue ground. The tile's own face is white.
- **Fix:** Inside the panel, a letter tile's initial takes the page's faint grey, the same one Home's tiles use.
- **Pictures:** `refs/rail-tiles/before.png` (Desktop sidebar, 1440px, before); `refs/rail-tiles/after.png` (Desktop sidebar, 1440px, after)

## Notes for this proposal

- All three live in the `#platform-tabs` rules of the standard look in `public/css/app.css`.
- `tests/standard-wip-look.test.js` pins conventions for that block: every selector starts with `html:not([data-skin])`, no literal colours (use the `--wip-nav-*` tokens declared in the token rule, adding one there if you need it), and any `display: none` must be listed in `WIP_HIDES`.
- Tab labels: The reviewer asked whether phones this small exist. They do (320px-wide phones, and larger phones with the system text size turned up, which is the more common case). He approved the fix on that basis. Check 320, 360 and 393 wide, and 393 and 432 with the system text zoom snippet in `captures.sh`.
- The unread count: check the phone tab bar and the desktop sidebar, light and dark. The Communities count uses a different style and was already legible; leave it alone.

## Before/after shots to declare

- One change for the desktop sidebar on Home (the letter tiles for communities without a picture, and the count on the lit row if the capture account has something unread when Homeroom bot or Messages is open).
- One change for the phone tab bar with Messages or Homeroom bot open (the count on the lit tab).
- The 320px bar and system text zoom cannot be reached by the shots agent: put them in the testing steps (a narrow browser window, or a phone with larger system text).
