# P04: A full-size Invite button on the hub

Topic: Project pages. Outcome branch: `claude/audit-p04-hub-invite`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

This proposal is a small redesign the reviewer approved from mock-ups. There is no prototype patch.

## Items

### Replace the hub's drawn arrow with a full-size Invite button

Report item 32 (`hero-arrow`), severity Minor. Seen on: Small laptop, Tablet.

- **What is wrong:** The hand-drawn arrow is meant to swoop from the member count to the Invite button. When Invite wraps to the next line the arrow stays behind, pointing at empty space.
- **Cause:** The arrow and the button are separate items of a wrapping row.
- **Fix:** Move Invite into the hero's action row as a full-size outlined button beside Open app, and remove the arrow and the small pill from the members line.
- **Review note:** Approved as a redesign rather than a patch: Invite becomes a full-size button beside Open app, and the arrow and small pill go. On Homeroom's hub, which has no Open app, Invite stands alone in that row. The code for this isn't written yet; the patch still holds the earlier arrow fix, which this replaces.
- **Pictures:** `refs/hero-arrow/before-big.png` (A project's hub, 1024px window, before); `refs/hero-arrow/after-big.png` (A project's hub, 1024px window, after)

## Notes for this proposal

**This is an approved redesign with no code written yet.** the reviewer found the hub's hand-drawn arrow pointing at a small Invite pill confusing and nonstandard, asked for alternatives, and approved this one from a mock-up ("32 lgtm").

Approved spec:
- Invite becomes a full-size outlined (secondary) button in the hero's action row, beside "Open app". Same height and shape as Open app; Open app stays the filled primary.
- The drawn arrow (`.wip-hub-meta-arrow`) and the small pill (`.wip-hub-meta-invite`) are removed from the members line. The members line keeps everything else it shows.
- On Homeroom's own hub there is no Open app; Invite stands alone in the action row.
- On a phone the two buttons share the row as the action row already lays out its buttons.
- Invite is shown to exactly the people who see the pill today and does exactly what the pill does (same handler, same destination).

Where: `frontend/src/features/dev-board/workshop/community-card.tsx` (the hero; action row `.dev-ws-hero-actions`), and the `.wip-hub-meta-*` and `.dev-ws-hero-actions` rules in `public/css/app.css`.

Watch for:
- `tests/home-needs-you-card.test.js` pins the Invite markup. Update it to pin the new markup.
- `dapp.json`'s declared checks and `tests/baselines/shell-markup.json` may select the pill's ids or `data-*` names. Search for them before removing anything; keep an id or attribute on the new button where a check selects on it, or update the check in the same change (never refresh the baseline wholesale; record deliberate retirements as AGENTS.md says).
- The button's label is existing catalog text; reuse its message id. If a new message is needed, add it to the English catalog only.
- Use the shell's own button primitive or the classes Open app uses, so the two match. No new colours.
- A sibling proposal (hub fixes) edits the hero's title, picture and shortcut cards. Keep to the action row and the members line.
- Request #6896 ("Improve discoverability of community invite actions") may be related. Read it with `get_request`. Link it in `prepare_work` only if this change fully answers it; otherwise mention it in the description.

References in `refs/`: `arrow-now-1024.png` (today), `inv-app-1024.png` and `inv-app-393.png` (approved, a project with an app), `inv-hr-1440.png` (approved, Homeroom's hub). `mock-invite-big.sh` is the script that drew the mock by rearranging the live page; its JS shows which nodes moved. `superseded-arrow-fix.patch` is an earlier fix that kept the arrow; it is context only, do not apply it.

## Before/after shots to declare

- One change: a project's hub, where Invite is now a full-size button beside Open app and the arrow is gone. Declare it for a laptop size and a phone size. Use a project the capture member can invite to (in the lab, `staging-demo-app`).
