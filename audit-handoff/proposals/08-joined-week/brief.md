# P08: The Joined list shows each community's week

Topic: Home and Communities. Outcome branch: `claude/audit-p08-joined-week`.

Read `audit-handoff/README.md` first: it has the rules and the steps. This file is what is specific to your proposal.

This proposal is a small redesign the reviewer approved from mock-ups. There is no prototype patch.

## Items

### The Joined list says what happened this week

Report item 1 (`joined-row`), severity High. Seen on: Communities, Phone, Desktop.

- **What is wrong:** Today each joined community shows its name and member count, and nothing about whether anything is happening there.
- **Cause:** The 21 November rebuild removed the description, the faces and the week's figures along with the broken layout.
- **Fix:** Under each name, “34 members, 6 active this week” as one plain line, then “✓ 6 changes live this week” in blue when something went live. A quiet community stays “16 members”. The cards get a little more room: three across from 1280px, two across under that, one to a line on a phone. It uses data the page already loads.
- **Review note:** Approved as a redesign. The bug I first reported here (a row with no name) was fixed on main on 21 November, when the list was rebuilt as simple cards (#6959). That rebuild also dropped the week's detail, and this brings it back without the crowding. The code for it isn't written yet.
- **Pictures:** `refs/joined-row/now-393.png` (Phone, with six communities from your list, before); `refs/joined-row/f0-393.png` (Phone, with six communities from your list, after); `refs/joined-row/now-1440.png` (1440px window, before); `refs/joined-row/f0-1440.png` (1440px window, after)

## Notes for this proposal

**This is an approved redesign with no code written yet.** The Joined list on Communities was rebuilt on main as plain cards (#6959), which fixed the bug first reported here but dropped what each community did this week. The reviewer liked that information and asked for it back without the crowding. After several rounds of mock-ups he approved this one ("F, without the little people icons").

Approved spec, per card:
- The community's icon and name, as today.
- Under the name, one plain grey line: "34 members, 6 active this week". If nobody was active this week it is only "16 members".
- Under that, only when changes went live this week, a line in the link blue with a check: "✓ 6 changes live this week" ("1 change live this week" for one).
- No row of member faces, no people glyph, no description. Those were tried and turned down as busy.
- The card is a little roomier than today's compact card: 16px padding, 14px between the icon and the words, 5px between the lines, small text at 13px on an 18px line.
- The grid: one card per line on a phone, two across from 768px, three across from 1280px.

Data: `GET /api/me/home-pins/activity` already serves `members`, `activeWeek` and `liveWeek` per community. The client store is `homePinsActivityStore`; today it loads only when pinned cards are drawn (`frontend/src/features/communities/index.tsx`). The Joined list needs it loaded too. The card is `frontend/src/features/communities/card.tsx` (`CommunityCardCompactContent`, `CommunityPageCard compact`). Check on your base that the endpoint covers every joined community, not only pinned ones; if it does not, extend it in the smallest way and say so.

Watch for:
- The island's first render must emit the same markup as before data arrives (AGENTS.md: data loads in effects; a hydration mismatch logs a console error, which fails proposal checks). Until the figures arrive the card shows what it shows today, with no layout jump worth noticing (reserve the line or accept one line appearing; choose what looks calmer and say which).
- New text goes in the English catalog for this surface as whole messages with descriptions and `_one`/`_other` pairs. "34 members, 6 active this week" is one message, not two joined by a comma in code; read `frontend/locales/README.md` for how to handle two counts in one message. "Zero says nothing": no "0 active", no "0 changes".
- A screen reader gets the same words.
- AGENTS.md's type rules: 13px muted for the line under a name; the blue is `violet-*` / `--accent` because the number asks for a look, and it is the only coloured thing on the card. No filled pill.
- Tests that pin the Joined list or the compact card (`tests/*communit*`, `tests/section-heading-primitives*`, `tests/workshop-screen*`). Update pins that describe the old card.
- A sibling proposal fixes the search prompt at the top of this screen. Do not touch the search box.

References in `refs/`: `j-now-393.png` (today, phone), `j-F0-393.png`, `j-F0-1024.png`, `j-F0-1440.png` (approved, at three widths). `mock-joined-options.js` drew the mocks over the live page; run with `OPTS=F0` to see the exact styles used (search it for `F0`, `roomy`, `noFaces`). `joined-mock.json` is the sample data in the pictures.

## Before/after shots to declare

- One change: Communities, the Joined list, where each card now says how many members it has, how many were active this week and how many changes went live. Declare it for a phone size and a desktop size. On a fresh staging copy the figures come from the demo data; if every community there is quiet, seed a little obviously fake activity as AGENTS.md describes (idempotent, in `src/db/migrate.js`, for the shots' fixture accounts), in this proposal, since the state is new.
