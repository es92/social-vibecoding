# P02: Top bar and sidebar on tablets and in Safari

Topic: Navigation and top bar. Outcome branch: `claude/audit-p02-topbar-devices`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### On a tablet browser, project pages scroll straight through the top bar

Report item 5 (`tablet-header`), severity High. Seen on: Tablet in a browser, Light and dark.

- **What is wrong:** On a touch tablet, scroll a project's Workshop or All items. The page's text passes visibly behind the logo, the bell and the account button: the top bar has no background there. Home, Settings and Profile are not affected in Safari, because the bar is solid on those.
- **Cause:** From 768px the bar is transparent, which is right on a desktop where the page scrolls inside its own box below the bar. A touch browser scrolls the whole document with the bar pinned over it, and only the plain screens in Safari were given a ground.
- **Fix:** Wherever the document is the scroller, the bar takes the page's solid colour from the sidebar's edge across. This is the same rule that fixes the `rail-header` item.
- **Pictures:** `refs/tablet-header/before-light.png` (820px tablet, a project's Workshop scrolled 220px, before); `refs/tablet-header/after-light.png` (820px tablet, a project's Workshop scrolled 220px, after)

### In Safari on a wide iPhone or iPad, the top bar covers the top of the sidebar

Report item 18 (`rail-header`), severity Medium. Seen on: iPhone held sideways in Safari, iPad in Safari.

- **What is wrong:** The cream top bar is painted over the top of the blue sidebar. The button that folds the sidebar is white on cream and cannot be seen. When the “Get the app” strip is showing, the sidebar's Home row is hidden behind the bar as well.
- **Cause:** In Safari the top bar is given an opaque ground so the status strip takes its colour. From 768px the sidebar is meant to reach the top of the window behind a transparent bar, and it also starts at 0 rather than under the strip.
- **Fix:** Start the bar's ground where the sidebar ends, and start the sidebar under any strip above the header. This is the same rule that fixes the `tablet-header` item.
- **Review note:** The fix needs a small rework: since the audit, main rounded the page's corner where it meets the sidebar (#6956), and my rule squares that corner off in Safari.
- **Pictures:** `refs/rail-header/before-landscape.png` (iPhone sideways in Safari, 852px, before); `refs/rail-header/after-landscape.png` (iPhone sideways in Safari, 852px, after); `refs/rail-header/before-tablet.png` (Tablet in a browser with the “Get the app” strip, 820px, before); `refs/rail-header/after-tablet.png` (Tablet in a browser with the “Get the app” strip, 820px, after)

### On an iPad in the app, the sidebar's fold button sits under the status bar

Report item 19 (`ipad-fold`), severity Medium. Seen on: iPad app, upright and sideways.

- **What is wrong:** The button that folds the sidebar is 16px from the top of the screen, under the clock, while the rest of the top bar starts 24px lower. A tap there goes to the system.
- **Cause:** The button and the sidebar's brand band are placed from the top of the header box, which extends under the status bar. They do not add the safe-area inset the header's own row adds.
- **Fix:** Add the top inset to the button, the brand and the sidebar's first row. The layout audit's four warnings on the two iPad shapes go to zero.
- **Review note:** The repository's own layout audit on iPad and iPhone Duo shapes: 6 warnings on production code, 0 with the fix.
- **Pictures:** `refs/ipad-fold/before.png` (iPad upright, sidebar folded (status bar is the top 24px), before); `refs/ipad-fold/after.png` (iPad upright, sidebar folded (status bar is the top 24px), after)

## Notes for this proposal

- **Re-verify all three with care.** Main changed the top bar on 23 November ("the Workshop as cards across the page, and the page's name in the top bar", request #7036, merged as the commit at or just before `fef8ba9b`). Any of these may be fixed, moved or changed by it.
- **rail-header needs rework, not the patch as it is.** Main rounded the page's corner beside the sidebar (#6956) after the prototype was written, and the prototype's rule sets `border-end-start-radius: 0`, which would square that corner again. Keep main's corner and close the bug another way.
- These depend on device behaviour that was only emulated here (Chrome with an iPad or iPhone user agent and size; the app's safe-area insets set by hand). Say that plainly in the summary and ask voters to try the staging preview on a real iPad (in Safari and in the app) and on a wide iPhone turned sideways in Safari.
- `fix.patch` includes the matching change to `tests/standard-wip-look.test.js` (the `platform-safe-top` pin).
- Request #6970 (header buttons under the iOS status bar on the iPhone Duo) is a different device. Do not link it unless your change fully answers it.

## Before/after shots to declare

- A project's Workshop on a tablet-sized screen, scrolled, if the shots agent has a tablet size and the bug shows in its browser. Declare only what you reached.
- If none of the three states can be reached on a fresh staging copy by the shots agent, say so in the testing steps and declare the nearest reachable screen that changes, or follow AGENTS.md on reporting a state that cannot be reached. Do not declare `impact: none`: these are visible changes.
