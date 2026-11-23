# P10: Text size setting

Topic: Text size. Outcome branch: `claude/audit-p10-text-size`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (3 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### The Text size setting does not enlarge messages

Report item 22 (`text-size-chat`), severity Medium. Seen on: Phone, Desktop, Anyone using Settings › Accessibility › Text size.

- **What is wrong:** Settings says Text size “makes text bigger everywhere on this browser”. At 150% the page headings and avatars grow, but the text of every message, its sender, its time and the rows of the Messages list stay exactly the same size.
- **Cause:** Those sizes are written in fixed pixels (17px, 15px, 13px), and the setting scales `rem`. A comment in app.css records this as a known gap (“converting it is a later change”).
- **Fix:** A first step: the message bubble, sender, time, the Messages list rows and a project thread's replies move to `rem`, on phone and desktop. Nothing changes at the default size. More pixel-sized text remains elsewhere.
- **Pictures:** `refs/text-size-chat/before-thread.png` (A conversation on a phone at Text size 150%, before); `refs/text-size-chat/after-thread.png` (A conversation on a phone at Text size 150%, after)

### At the two largest text sizes, Home's icons touch and their badges overlap

Report item 26 (`text-size-home`), severity Low. Seen on: Phone, Text size 137% and 150%.

- **What is wrong:** The four project icons of a row meet edge to edge, and the lock and copy marks on neighbouring icons are printed over each other.
- **Cause:** An icon is 3.5rem wide, which at 150% is 84px: the whole of a phone's quarter-width cell.
- **Fix:** An icon is never wider than its own cell less a gap. Nothing changes at the default size.
- **Pictures:** `refs/text-size-home/before.png` (393px phone, Text size 150%, before); `refs/text-size-home/after.png` (393px phone, Text size 150%, after)

### A false “stylesheet order is broken” error is logged at Text size 125% and above

Report item 34 (`cascade-probe`), severity Minor. Seen on: Every page, Text size 125%, 137% and 150%.

- **What is wrong:** Not visible on screen. On every page load the console logs “[tailwind] compiled utilities are losing the cascade to app.css”. Nothing is wrong with the stylesheets. It matters because a console error on any route fails a proposal's checks.
- **Cause:** The self-check expects a 0.65rem probe to be under 12px. With the root at 125% or more, a healthy probe is 13px to 15.6px.
- **Fix:** Compare the probe with the root's own font size.
- **Review note:** Also confirmed on the live site: at the larger text sizes every page load logs it, and at the default size it does not.

## Notes for this proposal

- text-size-chat: the Text size setting (You, Settings) did not enlarge messages, because Messages and project threads set their text in fixed pixels. The fix states those sizes in rem at the same default size. `fix.patch` includes matching changes to `tests/chat-sheets-audit.test.js` and `tests/messages-card-runs.test.js`, which pinned the px values. At the default size nothing may change: compare default-size before and after pictures and expect no difference.
- AGENTS.md states the row rule as "15 over 13". In rem that is 0.9375rem over 0.8125rem; if a test or the AGENTS.md text itself needs a word to say so, add it in the same change.
- text-size-home: at the two largest sizes Home's icons touched on a phone and their badges overlapped. The prototype sat in the same `@media` block as a sibling proposal's fix (Home's grid from 1024px); the two were split apart, so keep your edit to the phone rule.
- cascade-probe: `frontend/src/head.html` logged a false "stylesheet order is broken" console error at Text size 125% because it compared against a fixed pixel size. A console error on any route fails proposal checks, so this one matters more than it looks.
- The setting is stored in `localStorage['homeroom:text-size']` (`large`, `larger`, `xlarge`, `xxlarge`); `shot.js --textSize` sets it.
- Scope: Messages and project threads only. Request and change pages and Settings also have fixed-pixel text; that is a known gap listed in the report, not part of this proposal. Say so in the description.

## Before/after shots to declare

- A conversation in Messages with Text size at its largest: the messages are larger. Steps: open You, Settings, set Text size to the largest, then open Messages and a conversation.
- Home on a phone at the largest Text size: icons no longer touch.
- The console error has nothing to see; describe it in the description and testing steps.
