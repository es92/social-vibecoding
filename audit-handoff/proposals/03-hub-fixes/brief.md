# P03: Project hub fixes

Topic: Project pages. Outcome branch: `claude/audit-p03-hub-fixes`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (4 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### Homeroom's hub picture covers its description between about 900 and 1200px

Report item 9 (`hero-art`), severity Medium. Seen on: Small laptop, Tablet landscape, Light and dark.

- **What is wrong:** On Homeroom's own hub, the illustration of four people is drawn over the community's description and over the names of who was active this week.
- **Cause:** The picture's height follows the card and its width follows its height. Where the words wrap the card grows taller, the picture grows wider, and it leaves the 30% of the card reserved for it.
- **Fix:** Keep the picture inside its reserved side (`max-width`, `object-fit: contain`), standing on the bottom edge and drawn smaller when that side is narrow.
- **Pictures:** `refs/hero-art/before-1024.png` (1024px window, before); `refs/hero-art/after-1024.png` (1024px window, after)

### A project hub's three shortcut cards read “N…” and “Disc…”

Report item 10 (`hub-doors`), severity Medium. Seen on: Tablet, Small laptop, 768 to 1200px.

- **What is wrong:** Under For you, the Needs you card shows “N…” with “[…” beneath it, and Discussion shows “Disc…”. The cards are three across in a space that fits one and a half.
- **Cause:** The hub switches to three columns at 768px whatever room is left beside the sidebar. After its icon, count and chevron, a 230px card has about 20px for words.
- **Fix:** Keep the three as a list, one to a row, until there is room for three (1200px beside the open sidebar, 1020px beside the folded one).
- **Pictures:** `refs/hub-doors/before-1024.png` (1024px window, before); `refs/hub-doors/after-1024.png` (1024px window, after)

### A project's name runs under the ⋯ button on its hub

Report item 20 (`hero-title`), severity Medium. Seen on: Phone, Names longer than about 14 letters.

- **What is wrong:** On a phone, the last letters of a project's name are drawn under the round ⋯ button in the hero's corner.
- **Cause:** The ⋯ is positioned in the card's corner, out of the flow, and reaches 24px into the column the name is set in.
- **Fix:** End the name's first line short of the button (`padding-inline-end: 1.75rem` when the button is there).
- **Pictures:** `refs/hero-title/before-phone.png` (393px phone, before); `refs/hero-title/after-phone.png` (393px phone, after)

### The “code changes are paused” notice is cut mid-sentence with room to spare

Report item 31 (`pause-banner`), severity Low. Seen on: Desktop.

- **What is wrong:** On a 1440px window the notice ends “Requests and discus…”, with a third of the row empty beside it and no way to read the rest.
- **Cause:** The notice is one line capped at 62% of the row, whatever the row's width, and has no tooltip.
- **Fix:** Cap it at the row less the title's own room, and put the whole sentence in its `title` for the widths where it is still cut.
- **Review note:** Present in the code, but probably nobody sees it today: the notice only shows for a project whose code is still on GitHub while changes to it are paused, and Homeroom's own changes are merging normally.
- **Pictures:** `refs/pause-banner/before-1440.png` (1440px window, before); `refs/pause-banner/after-1440.png` (1440px window, after)

## Notes for this proposal

- All on a project's hub (`/#app/<slug>/dev/hub`). Main reworked project pages on 23 November (request #7036); re-verify each item on your base.
- A sibling proposal (hub Invite) edits the same hero: the action row in `frontend/src/features/dev-board/workshop/community-card.tsx` and the members line's `.wip-hub-meta-*` rules. Stay away from those lines so the two merge cleanly.
- pause-banner: the notice only shows on a project whose code is on GitHub while merges are paused, so most people never see it. In the lab it shows on Homeroom's hub with `?demo=1` at 1440 wide. `fix.patch` includes the matching change to `tests/proposal-code-missing-render.test.js`.
- hero-title: needs a project with a long name on a phone (`staging-demo-app` in the lab).

## Before/after shots to declare

- Homeroom's hub at a laptop width: the picture no longer covers the description, and the three shortcut cards show their whole labels. Same screen, so one change.
- A long-named project's hub on a phone: the name no longer runs under the ⋯ button.
- The paused notice probably cannot be reached on a fresh staging copy. Put it in the testing steps.
