# P11: Signed-out pages and approval pages

Topic: Visitors and sign-in. Outcome branch: `claude/audit-p11-visitor-approval`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

Prototype: `fix.patch` in this folder (4 fixes, made against production's commit `dc7d5e2c`; it applied cleanly to main at `fef8ba9b` on 23 November). Captures used for the report: `captures.sh`. Reference pictures: `refs/<item>/`.

## Items

### The logo reads “Homeroon” for signed-out visitors on a 360px phone

Report item 12 (`guest-logo`), severity Medium. Seen on: Signed out, 360px phones, Any phone at larger text sizes.

- **What is wrong:** In the visitor's top bar the Homeroom logo is cut off on the right: “Homeroon” at 360px, and as little as “Hon” at a large text size. On invite pages at large text a stray “…” is printed after the logo instead.
- **Cause:** The logo sits in a box that shrinks to make room for Sign in and Join the waitlist, and clips what does not fit.
- **Fix:** Let the logo scale down to fit its box, so it is always whole.
- **Review note:** Also confirmed on the live site, signed out, at 360px.
- **Pictures:** `refs/guest-logo/before.png` (360px phone, signed out, before); `refs/guest-logo/after.png` (360px phone, signed out, after)

### With an app open, a visitor sees its name run under the Pin button

Report item 13 (`visitor-pin`), severity Medium. Seen on: Signed out, Phone, Light and dark.

- **What is wrong:** When a signed-out visitor opens an app, its name in the top bar is drawn underneath “Pin”. Short names collide too at 360px.
- **Cause:** The Pin button was added beside Sign in, about 110px over the title's end. The title still reserves room for Sign in alone.
- **Fix:** When Pin is present the title reserves room for both, and a long name ends in an ellipsis before them.
- **Pictures:** `refs/visitor-pin/before.png` (393px phone, signed out, an app open, before); `refs/visitor-pin/after.png` (393px phone, signed out, an app open, after)

### A visitor's search with no matches leaves a blank page

Report item 25 (`guest-search`), severity Low. Seen on: Signed out, Every screen size.

- **What is wrong:** On the public front page, search for something that matches nothing. The heading, filters and cards all disappear and nothing takes their place.
- **Cause:** The list returns nothing when a search has no results. The line for this case, “No apps match that yet.”, exists in the catalog but is never shown.
- **Fix:** Show that line.
- **Pictures:** `refs/guest-search/before.png` (393px phone, signed out, before); `refs/guest-search/after.png` (393px phone, signed out, after)

### The CLI and connector approval pages are wider than a phone screen

Report item 27 (`authorize-card`), severity Low. Seen on: Phone.

- **What is wrong:** The approval card runs off both edges of a phone and the page scrolls sideways by 18px.
- **Cause:** The card's width is set to the screen less 3rem, and its 2rem of padding is then added on top.
- **Fix:** Make the width include the padding (`box-sizing: border-box`). Nothing changes on a wide screen. I loaded these pages by their file path, because the approval routes need a real request to open.
- **Pictures:** `refs/authorize-card/before.png` (393px phone, before); `refs/authorize-card/after.png` (393px phone, after)

## Notes for this proposal

- guest-logo, visitor-pin, guest-search are what a signed-out visitor sees (`--persona guest`). Main rebuilt parts of the public front page on 21 November (#6959 and others); re-verify each.
- guest-search: a visitor's search with no matches left a blank page. The fix passes an `emptyLine` to the shared list (`frontend/src/features/guest/guest-discover.tsx`, `frontend/src/features/home/communities-to-join.tsx`). Its text must come from the English catalog; check whether the prototype reuses an existing message or needs a new one.
- authorize-card: the CLI and connector approval pages (`/cli-authorize.html`, `/connect-authorize.html`) were wider than a phone screen. They are standalone pages with their own stylesheets (`public/css/cli-authorize.css`, `connect-authorize.css`) and load no shell bundle.

## Before/after shots to declare

- The public front page on a small phone, signed out: the logo reads "Homeroom" in full. The shots agent needs a signed-out persona for this; check `docs/proposal-visuals/before-after-shots.md` for how to declare one, and if it cannot, use testing steps.
- An app opened by a visitor on a phone: its name no longer runs under the Pin button.
- A visitor's search with no matches: a line says nothing matched.
- The approval pages go in the testing steps (open the page on a phone or a narrow window).
