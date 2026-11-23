# P06: Project menus and dialogs

Topic: Project pages. Outcome branch: `claude/audit-p06-project-menus-dialogs`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### In Suggest an improvement, the Homeroom option runs off the sheet

Report item 15 (`feedback-tile`), severity Medium. Seen on: Phone, Desktop with a long project name.

- **What is wrong:** The form asks “Where should this go?” with two tiles. With a long project name the second tile reads “Homeroo / The platfor” and is cut at the screen's edge. At 360px it touches the edge even with an ordinary name.
- **Cause:** The two tiles' wrappers have no `min-width: 0`, so the long name never shrinks to its ellipsis and pushes the other tile out.
- **Fix:** Let both wrappers shrink, so the two share the row and a long name is cut with an ellipsis.
- **Pictures:** `refs/feedback-tile/before.png` (393px phone, a project with a long name, before); `refs/feedback-tile/after.png` (393px phone, a project with a long name, after)

### On a phone, a settings row reads “App secretsNo manifest yet”

Report item 23 (`sheet-labels`), severity Low. Seen on: Phone.

- **What is wrong:** In a project's Settings & rules sheet, a row's name and its status are run together with no space: “App secretsNo manifest yet”, “Platform variables1 required missing”.
- **Cause:** The phone sheet copies the desktop menu row's text. On the desktop the name and status are two items with a gap between; as plain text there is none.
- **Fix:** Join the two with a middle dot when building the sheet's label.
- **Pictures:** `refs/sheet-labels/before.png` (393px phone, before); `refs/sheet-labels/after.png` (393px phone, after)

### The Rename app dialog is missing two spaces

Report item 24 (`rename-spaces`), severity Low. Seen on: Every screen size.

- **What is wrong:** The dialog reads “Current app name:Staging demo: kite log” and “Opens a PR that editsdapp.json; …”.
- **Cause:** The two English strings have no space before the tag that wraps the name and the file name.
- **Fix:** Add the two spaces in the English catalog.
- **Pictures:** `refs/rename-spaces/before.png` (393px phone, before); `refs/rename-spaces/after.png` (393px phone, after)

## Notes for this proposal

- feedback-tile: the Suggest an improvement sheet; the Homeroom option ran off the sheet beside a long project name.
- sheet-labels: `public/js/app-view.js`, `_wirePlusMenu`. Two tests pin this function: `tests/dev-workshop.test.js` (#2141: the function must open with `const btn…; const menu…; if (!btn || !menu) return;`, so the helper goes below that guard) and `tests/improve-action-deduplication.test.js` (its stand-in nodes have no `childNodes`; the helper must cope).
- rename-spaces: two missing spaces in `frontend/locales/en/dialogs.json`. English catalog only; never touch another language's.
- `tools/flow.js sheet-labels|rename-spaces|feedback-tile` clicks through to each state on both copies (phone size).

## Before/after shots to declare

- A project's settings sheet on a phone: a row's name and its note are separate ("App secrets", then "No manifest yet").
- The Suggest an improvement sheet on a phone, for a project with a long name: both options fit.
- The Rename app dialog: the two sentences have their spaces. If three is too many screens to reach reliably, keep the first two and put Rename in the testing steps.
