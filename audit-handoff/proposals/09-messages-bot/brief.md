# P09: Messages and Homeroom bot fixes

Topic: Messages and Homeroom bot. Outcome branch: `claude/audit-p09-messages-bot`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### On a desktop, a group invitation is one word per line with a button printed over it

Report item 3 (`invite-card`), severity High. Seen on: Desktop, Messages, Light and dark.

- **What is wrong:** Open a pending group invitation in Messages on a desktop. In the pane beside the list the invitation's text is laid out one word per line down a card taller than the window, and “Decline & block” is drawn across the words. At 1440px the text gets a narrow strip of thirteen lines beside the buttons.
- **Cause:** The card is a row: text, then three buttons that never give way. Beside the list the pane is 330 to 590px wide, the buttons take all of it, and the text's column is laid out at zero width. The stacked layout exists only under 768px.
- **Fix:** Give the words a reading width of at least 18rem and let the buttons drop under them when the two do not fit side by side.
- **Pictures:** `refs/invite-card/before-1024.png` (1024px window, the invitation beside the list, before); `refs/invite-card/after-1024.png` (1024px window, the invitation beside the list, after); `refs/invite-card/before-1440.png` (1440px window, before); `refs/invite-card/after-1440.png` (1440px window, after)

### A confirmation opened over a dialog looks like a hole in it

Report item 16 (`confirm-edge`), severity Medium. Seen on: Phone, Desktop, Light and dark.

- **What is wrong:** In a group's members dialog, press Leave group. The “Leave Launch crew?” card is the same colour as the dialog under it and has no edge or shadow. The rows behind it are cut off on either side (“Remove” reads “move”).
- **Cause:** The alert relies on a dimmed backdrop to stand out, but its backdrop is layered below an open dialog, so it dims the page and not the dialog.
- **Fix:** Bring the alert's backdrop over the dialog and give the card a hairline and a shadow.
- **Pictures:** `refs/confirm-edge/before.png` (393px phone, before); `refs/confirm-edge/after.png` (393px phone, after)

### With a bot conversation open, the list beside it cuts every title short

Report item 21 (`bot-list-docked`), severity Medium. Seen on: Desktop, 1024px and wider.

- **What is wrong:** Opening a conversation narrows the Homeroom bot list to about 270px. Each row still keeps an empty 48px column for a request number that most rows do not have, so titles read “Staging …” twice in a row.
- **Cause:** The number column is `hidden lg:block`: it follows the window's width, not the list's.
- **Fix:** Hide the number column while a conversation is open beside the list, as it already is on every screen under 1024px. The number stays on the conversation's own header.
- **Pictures:** `refs/bot-list-docked/before.png` (1440px window, conversation open, before); `refs/bot-list-docked/after.png` (1440px window, conversation open, after)

## Notes for this proposal

- invite-card: a group invitation card in a conversation, on a desktop (1024, 1280, 1440 wide), where the words were squeezed to one per line with the button printed over them. In the lab database it was conversation 22; ids differ between databases, so find the conversation that holds a group invitation by its name.
- confirm-edge: a confirmation opened over a dialog looked like a hole in the dialog. `tools/flow.js confirm-edge` reaches it on both copies. The prototype's rule sits next to the `:root { --un-navbar-bg …; --un-toast-bg … }` block in `public/css/app.css`.
- bot-list-docked: on a desktop with a Homeroom bot conversation open, the list beside it cut every title short.
- A sibling proposal (Text size) changes the font sizes of Messages rows and bubbles from px to rem. Do not touch font sizes here.

## Before/after shots to declare

- A conversation with a group invitation on a desktop: the card's words read normally and the button sits below them.
- Homeroom bot on a desktop with a conversation open: the list's titles are whole (or cut once, with an ellipsis, only where they truly do not fit).
- The confirmation over a dialog: declare it if the steps reach it reliably; otherwise testing steps.
