# P07: Home screen fixes

Topic: Home and Communities. Outcome branch: `claude/audit-p07-home`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### Every project name on Home is cut to five letters at 1024 to 1280px

Report item 11 (`home-grid`), severity Medium. Seen on: Small laptop, Tablet landscape, Light and dark.

- **What is wrong:** Pinned projects read “Stagi…”, “Stagi…”, “Stagi…”, with “1 contr…” beneath, and Recent threads read “First versi…”. Nothing on the page can be told apart.
- **Cause:** From 1024px a tile becomes a row (icon, then name on one line), four across. Beside the 244px sidebar that leaves a name about 75px.
- **Fix:** Beside the open sidebar, keep the stacked tile (icon over two lines of name) and two columns of threads until 1280px. With the sidebar folded the row layout still starts at 1024px.
- **Pictures:** `refs/home-grid/before-1024.png` (1024px window, before); `refs/home-grid/after-1024.png` (1024px window, after)

### On a desktop, a piece of the sidebar is left in the corner of “What do you want to make?”

Report item 17 (`make-rail`), severity Medium. Seen on: Desktop, Light and dark.

- **What is wrong:** Open New project on a desktop. The screen covers the page and the sidebar, but the sidebar's top 52px (the fold button and the logo on blue) stays visible as a block in the top-left corner.
- **Cause:** The screen is positioned from under the top bar down, full width. That was written for a phone. On a desktop the sidebar reaches the top of the window beside the bar, so its top strip is not covered.
- **Fix:** Start the screen at the sidebar's edge, so the sidebar stays whole beside it as it does on every other page.
- **Pictures:** `refs/make-rail/before.png` (1440px window, before); `refs/make-rail/after.png` (1440px window, after)

### The search prompts on Communities and Home are cut mid-word

Report item 33 (`search-placeholder`), severity Minor. Seen on: Phone.

- **What is wrong:** Beside the New community button the search box has room for about 100px of words, and its prompt stops at “Search your con”. Home's search box does the same (“Search apps and co”).
- **Cause:** The input clips its placeholder without an ellipsis.
- **Fix:** `text-overflow: ellipsis` on both inputs.
- **Pictures:** `refs/search-placeholder/before.png` (393px phone, before); `refs/search-placeholder/after.png` (393px phone, after)

## Notes for this proposal

- home-grid: between 1024 and 1280px wide with the sidebar open, every project name on Home was cut to about five letters. `fix.patch` includes the matching `WIP_HIDES` change in `tests/standard-wip-look.test.js`.
- The prototype for home-grid sat in the same `@media` block as a sibling proposal's fix (Text size: Home's icons at the largest sizes, the phone rule just above). The two were split apart for you; keep your edit to the 1024px and up rules so they merge cleanly.
- make-rail: "What do you want to make?" (`/#create`) on a desktop, where a piece of the sidebar was left in the corner.
- search-placeholder: the search prompts on Communities and Home were cut mid-word on a phone. A sibling proposal redraws the Joined list on Communities; do not touch the list.

## Before/after shots to declare

- Home at a small-laptop width (about 1024 to 1280) with the sidebar open: project names are whole.
- "What do you want to make?" on a desktop: no piece of sidebar in the corner.
- Communities (or Home) on a phone: the search prompt is whole.
