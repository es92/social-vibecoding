# P05: Request and change pages

Topic: Project pages. Outcome branch: `claude/audit-p05-request-change-pages`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (2 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### On a phone, a request's or change's status pill covers the ⋯ button and runs off the header card

Report item 4 (`change-pill`), severity High. Seen on: Phone, Any narrow thread column, Light and dark.

- **What is wrong:** At the top of a request or a change, the status pill (“Goes live in ~2d 22h · 1/2”, “Stopped: it couldn't be read”) is printed over the ⋯ menu button and past the card's right edge. At 360px the title is cut off with no ellipsis as well. The line also starts with a stray “·”, left behind by the project name that was squeezed out.
- **Cause:** The small line is a grid whose number and status cells are `max-content`, so they cannot shrink or wrap. When the two are wider than the head, the grid overflows its card.
- **Fix:** When the head's text is under 340px wide (a container query, so it also holds for a thread beside a list), the line becomes the number and the pill alone, the pill drops under the number if the two do not fit, and the orphan “·” goes.
- **Pictures:** `refs/change-pill/before-phone.png` (Change page, 393px phone, before); `refs/change-pill/after-phone.png` (Change page, 393px phone, after); `refs/change-pill/before-360.png` (Request page, 360px phone, before); `refs/change-pill/after-360.png` (Request page, 360px phone, after)

### On All items, cards show through the pinned heading as they scroll under it

Report item 14 (`allitems-head`), severity Medium. Seen on: Phone, Desktop, Light and dark.

- **What is wrong:** Scroll a project's All items board. The heading, search box and column names stay in place, and the cards passing underneath are read through them: a card's title ghosts across “All items” and “Requests”.
- **Cause:** The pinned head is painted at 90% opacity with no blur. A comment in the stylesheet says a pinned head over scrolling rows has to be opaque.
- **Fix:** Paint it solid.
- **Pictures:** `refs/allitems-head/before-desktop.png` (Desktop, scrolled, before); `refs/allitems-head/after-desktop.png` (Desktop, scrolled, after); `refs/allitems-head/before-phone.png` (393px phone, scrolled, before); `refs/allitems-head/after-phone.png` (393px phone, scrolled, after)

## Notes for this proposal

- **Re-verify allitems-head with care.** Main rebuilt the Workshop as cards across the page on 23 November (request #7036), which may have changed the pinned heading on All items.
- change-pill: a request's or a change's page on a phone, where the status pill covered the ⋯ button and the title. Check 360 and 393 wide, on a request and on a change, with a long status.
- allitems-head: All items is the page under the Workshop's "See all". Scroll it and watch the pinned heading; check desktop and phone, light and dark.

## Before/after shots to declare

- A change's (or request's) page on a phone: the status pill no longer covers the ⋯ button.
- All items, scrolled, on a desktop: cards no longer show through the pinned heading. The steps must include the scroll.
