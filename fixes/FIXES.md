# Homeroom overnight audit: fix hand-off

95 findings from the overnight UI audit of 1 to 2 November 2026: 11 high, 47 medium, 37 low. This file is for a session that fixes them. The same findings, with every screenshot, are in the report: https://claude.ai/artifact/BoMActyoLJK75EFEQRXKG2 (private). The screenshots for this file are in `shots/`, named by finding id.

## Read this first

- **What was audited.** Homeroom at main `313cd65f`, on a full local stack with the real Homeroom bot, on desktop Chrome (800 to 1920), iPhone Safari (upright and sideways), Android Chrome (emulated, and real on an emulator), the Homeroom app shapes for Android, iPhone 13 mini to Pro Max, iPhone Duo (folded, upright, sideways) and iPad, plus the real iOS app in simulators (folded Duo, iPad, 13 mini).
- **Main has moved.** Two bot commits landed after the audited build: #6095 (no turn ends on what it will do next) and #6096 (the working card follows a drawing into its new thread). Reproduce on current main before fixing anything in batch 1.
- **Checked by hand vs reviewer-found.** Each finding says which. Reviewer-found ones came from careful screenshot reviews but were not re-checked; confirm each before changing code. Emulated shapes cannot show real keyboard or WebKit timing; where a finding was seen only in emulation, confirm on a simulator or device.
- **Severity.** High: blocks or badly misleads a task, or looks clearly broken. Medium: noticeable glitch or confusing. Low: polish.
- **Left out as local-only (not bugs):** "Couldn't take the screenshots" on changes (no media storage locally), side benchmark builds failing for want of their own key, blank project App tabs in the local iOS build and the Android emulator, the leaderboard 404 (no season event locally), and the Android splash in emulation.
- **House rules that apply.** Follow AGENTS.md: base commit from canonical main, a proposal branch, `npm run test:changed`, visual evidence for UI changes. The type, colour and "zero says nothing" rules in AGENTS.md are the yardstick several findings use.
- **Re-checking layout.** `npm run audit:layout` (scripts/layout-audit, PR 6089) has the device shapes; `--profiles duo-sideways,phone-sideways` etc. It runs on made-up data; the audit's own live-stack runner and its added shapes (iPhone 13 mini, Pro Max, Safari, Android) are not in the repo.
- **The local stack** from the audit may still be running: `.claude/worktrees/local-stack`, `docker compose -p homeroom-audit -f docker-compose.dev.yml -f compose.audit.yml up -d`, http://localhost:3000. Test accounts audit_ada, audit_ben, audit_cy and audit_new use `AUDIT_TEST_PASSWORD` from that worktree's `.env`. Projects: Watering Rota (Just you), Book Club (Group), Neighbourhood Swap (Community), Flat Chores, Restaurant Tier List.

## Suggested batches

Each batch can be one proposal. Within a batch, highs first. Batch 1 matters most: these are the flows where the bot strands people.

- **1. Homeroom bot: plans and first versions** (7 high, 4 medium, 3 low): B01, B02, B23, B03, B04, B05, B06, B07, B08, B24, B19, B20, B18, S01
- **2. Homeroom bot: messages, cards and what it builds** (5 medium, 6 low): B09, B10, B11, B12, B16, B17, B21, B22, B26, B27, B15
- **3. Votes and counts that disagree** (1 high, 3 medium, 2 low): V01, V02, V05, V03, V04, Y03
- **4. Keyboard and short or odd-shaped screens** (3 high, 10 medium, 1 low): K01, L01, L03, L02, L04, L06, B13, B14, B25, M01, U01, U02, U03, G02
- **5. Navigation, project page, chat and sheets** (13 medium, 12 low): N01, N02, N03, N04, N05, N06, P01, P02, P03, P04, P05, C01, C02, C03, C04, C05, C06, D01, D02, D03, D06, D07, D09, D13, D14
- **6. Desktop and tablet layout** (5 medium, 4 low): W01, W02, W03, W04, W05, W06, W07, W08, D12
- **7. Copy, polish and platform idioms** (7 medium, 9 low): L05, Y01, Y02, Y04, Y05, Y06, Y07, R01, R02, D04, D05, D08, D10, D11, D15, G01

## 1. Homeroom bot: plans and first versions

The flows where a person following the screen gets stuck. Do these first.

### B01 · High · Asking the bot for a new project stalls: it promises to 'come back in a minute' and never does

*Homeroom bot · checked by hand · seen on: desktop 1440, all*

- **What:** The bot opens a private 'New thread' for the idea, but its reply lands in Main Chat with a promise no job keeps. The thread says 'No replies yet' until the person thinks to type something in it. Main has since gained #6095, which re-prompts turns that only announce their next step; it explicitly leaves 'a promise for later' alone, so this probably still happens.
- **How to see it:** As a member, Main Chat: 'Can you make us a chore chart for our flat? …'. Bot: 'New thread, for a new project: …' + 'That sounds like a new app of its own, so I'll come back to you here in a minute with how to get it started.' After 4+ min nothing; the new thread shows 'No replies yet'; server logs show no further bot work. Replying anything in the empty thread (e.g. 'Yes please') makes the bot draw version 1 there, so the flow only continues if the person thinks to prod it.
- **Likely cause:** start_project_thread (homeroom-bot-mayor.js C2.4) should route this turn's reply into the new thread (answer()); the reply landed in Main and the model promised a follow-up the system has no job for
- **Where to look:** src/services/homeroom-bot-mayor.js: `startProjectThread` (C2.4, ~line 2263 on main 2c7a56b7d) says the turn's reply goes in the new thread; it landed in Main
- **Where to look:** main's #6095 `announcesOnly` deliberately skips "a promise for later", which is this reply
- **Done when:** One message about a new project gets exactly one reply, posted inside the new thread, and the drawing (or a real question) follows without the person prodding. No reply promises work for later.
- **Screenshots:** [`B01-1.jpg`](shots/B01-1.jpg) (05-main-after-4min), [`B01-2.jpg`](shots/B01-2.jpg) (06-new-project-thread), [`B01-3.jpg`](shots/B01-3.jpg) (07-thread-replied), [`B01-4.jpg`](shots/B01-4.jpg) (bot-ben-2)
- **Source notes:** F025 (in `sources/`)

### B02 · High · A first version's plan can't be reached once you leave the create screen; every door loops between the Hub and Main Chat

*Homeroom bot · checked by hand · seen on: desktop 1440, all*

- **What:** The 'Two quick questions' exist only on the create screen. Afterwards the Main Chat row says 'Stopped', the Hub's 'Review the plan' opens Main Chat (no plan there), and the activity thread that holds the plan redirects to the Hub. The build never starts.
- **How to see it:** Make a custom project (Flat Chores); on 'Two quick questions' leave the screen. Main Chat row 'Flat Chores, first version · Stopped' opens the project Hub; Hub 'Review the plan' opens Main Chat, which has no plan card; #homeroom-bot/thread/60 (the activity thread holding the plan, message 62 kind plan/needs_you) redirects to the Hub. The build never starts.
- **Likely cause:** first-version activity rows and their threads are redirected to the project page; the Hub's Review link targets Main Chat instead of the plan message in the activity thread
- **Where to look:** frontend/src/features/messages/bot-strip.tsx: the activity-row state map (~line 105-120) maps `first_version_failed` to "Stopped"
- **Where to look:** frontend/src/features/dev-board/workshop/hub-cards.tsx and features/app-frame/app-status.tsx: "Review the plan" target
- **Where to look:** the first-version activity thread (`#homeroom-bot/thread/<card id>`) redirects to the project Hub
- **Where to look:** the plan itself is a `homeroomBot.kind = "plan"` message (moment needs_you, actionId) inside that activity thread
- **Done when:** After leaving the create screen, the two questions are reachable from the Main Chat row, the Hub's "Review the plan" and Needs you; answering them starts the build. The row never says "Stopped" for a plan that waits.
- **Screenshots:** [`B02-1.jpg`](shots/B02-1.jpg) (21-main-plan), [`B02-2.jpg`](shots/B02-2.jpg) (22-first-version-row), [`B02-3.jpg`](shots/B02-3.jpg) (23-review-plan), [`B02-4.jpg`](shots/B02-4.jpg) (17-make-24s)
- **Source notes:** F031, F030, F029 (in `sources/`)

### B23 · High · A first version that went live shows as '✕ Closed' in Main Chat, and the promised 'it's live' message never shows

*Homeroom bot · checked by hand · seen on: desktop 1440, all*

- **How to see it:** Ben's Flat Chores first version merges and goes live (22:12): Main Chat ends with 'Thanks! … tell you here when it's live.' then '✕ Flat Chores, first version · Closed'. The live message went into the activity thread (without its card: 'Cards refused'), and that thread redirects to the Hub.
- **Likely cause:** first-version activity rows map the closed issue to 'Closed' instead of 'Live'; the live notice is posted only in the activity thread
- **Where to look:** frontend/src/features/messages/bot-strip.tsx state map: a live first version reads "Closed"
- **Where to look:** src/services/homeroom-bot-dm.js: the live notice posts into the activity thread only (and loses its card, see B09)
- **Done when:** A first version that went live reads "Live" in Main Chat, and the bot says so in Main Chat.
- **Screenshots:** [`B23-1.jpg`](shots/B23-1.jpg) (30-flat-live), [`B23-2.jpg`](shots/B23-2.jpg) (31-flat-app), [`B23-3.jpg`](shots/B23-3.jpg) (flat-live)
- **Source notes:** F050 (in `sources/`)

### B03 · High · The bot tab miscounts work: 'In progress: 0' while a first version builds, and it is filed under 'Waiting · Nobody yet'

*Homeroom bot · checked by hand · seen on: phone app, desktop, desktop-800, desktop-1024, desktop-1440, desktop-1920*

- **What:** Main Chat and the project page say 'Building it · 8 min so far'; the bot tab's header and lists disagree, and other screens give other counts again.
- **How to see it:** Ben's Flat Chores first version 8 min into its build: Main Chat row 'Building it', project page 'Building it · 8 min so far', but the bot tab header 'Needs you: 1 · In progress: 0' and WAITING · Flat Chores 'First version of Flat Chores · Nobody yet'
- **Likely cause:** the bot tab's lists classify first-version runs by their issue's state (no assignee) instead of the run's phase; In progress counts only request builds
- **Where to look:** frontend/src/features/ai/lists.tsx and features/ai/model.ts: the bot tab's Needs you / In progress / Waiting classification; "Nobody yet" is `changes:board.filterChip.nobodyYet`
- **Done when:** During a first-version build the bot tab counts it under In progress; it never appears as "Waiting · Nobody yet".
- **Screenshots:** [`B03-1.jpg`](shots/B03-1.jpg) (01-bot-tab), [`B03-2.jpg`](shots/B03-2.jpg) (03-project), [`B03-3.jpg`](shots/B03-3.jpg) (02-main), [`B03-4.jpg`](shots/B03-4.jpg) (building-ben)
- **Source notes:** F048, D2, I13 (in `sources/`)

### B04 · High · 'New project > A group' from the bot's drawing opens the generic create screen with the wrong description and no name

*Homeroom bot · checked by hand · seen on: desktop 1440*

- **What:** The drawn version 1 is dropped, 'What should it do?' holds the person's last chat line ('Yes please. Just the three of us…'), and the build is quoted as a fresh 20 to 30 minutes.
- **How to see it:** New-project thread with a drawn 'Version 1: Weekly chore chart' > New project > A group. The create screen's 'What should it do?' reads 'Yes please. Just the three of us: Ada, Ben and Cy.', name is empty, 'Custom · Homeroom bot builds it in 20 to 30 min'; the drawing is not mentioned. Leaving the thread before choosing also drops the 'Who is it for?' step.
- **Likely cause:** offer_project hands the thread's title/last message (see F026) to the create dialog rather than the idea + drawn design
- **Where to look:** src/services/design-bot.js: `offer_project` (~line 254, 689) and the client handler that opens the create dialog
- **Where to look:** the dialog is prefilled from the thread title, which B08 renames to the latest reply
- **Done when:** "New project" from a drawn version carries the idea, a name and the drawing into the new project; no generic create screen holding the last chat line.
- **Screenshots:** [`B04-1.jpg`](shots/B04-1.jpg) (14-a-group), [`B04-2.jpg`](shots/B04-2.jpg) (08-thread-50s)
- **Source notes:** F028 (in `sources/`)

### B05 · High · 'Change something' on a plan says the group will see it, then the bot only drafts it privately

*Homeroom bot · checked by hand · seen on: phone app, all*

- **What:** After sending the change, the person must open a thread and press 'Post it' before the bot re-plans; meanwhile Build it still offers the old plan.
- **How to see it:** Plan card > Change something > type 'Also show who has each thing…' > Send. Composer says 'What you write is posted on the request, where the group can see it.' Bot replies 'I drafted that to post on Neighbourhood Swap, in a thread only you can see. Nothing is posted until you post it.' You must open '1 update in its thread' and press 'Post it'. Meanwhile the plan card still offers Build it on the old plan.
- **Likely cause:** the change-plan reply is routed through the generic DM 'draft a post' path instead of the plan-revision path
- **Where to look:** src/services/homeroom-bot-mayor.js ~line 3187: "I drafted that to post on …" (the generic DM draft path)
- **Where to look:** frontend/src/features/messages/bot-plan-view.tsx: `COMPLICATED_PLAN_NOTE_SHOWN` (`messages:bot.plan.complicatedNoteShown`) promises the opposite
- **Done when:** "Change something" re-plans from the requester's words without a separate "Post it", or the note under the plan says plainly what will happen. Build it is not offered on a plan being replaced.
- **Screenshots:** [`B05-1.jpg`](shots/B05-1.jpg) (05-typed), [`B05-2.jpg`](shots/B05-2.jpg) (06-sent), [`B05-3.jpg`](shots/B05-3.jpg) (08-draft-thread), [`B05-4.jpg`](shots/B05-4.jpg) (09-posted)
- **Source notes:** F018 (in `sources/`)

### B06 · High · 'Build it' on a Needs you row doesn't build: it opens a thread that has no Build it button and says 'Waiting for @you'

*Homeroom bot · checked by hand · seen on: desktop 1440, all*

- **What:** The real Build it is on the plan card back in Main Chat; the thread talks about the requester in the third person.
- **How to see it:** Bot tab > Needs you > tap 'Build it' on the request row. The request thread opens; it says 'Waiting for @audit_ada to OK the plan' with only 'See progress' and 'Read'. The real Build it is on the plan card back in Main Chat.
- **Likely cause:** row's action label promises the action but routes to the thread; thread's waiting card has no approve control
- **Where to look:** frontend/src/features/ai/lists.tsx: the Needs you row's "Build it" action
- **Where to look:** public/js/app-view.js ~line 6126: `changes:request.status.lead.botPlanWaiting` names the approver by @username even when it is the viewer
- **Done when:** "Build it" on a Needs you row builds (or opens the plan card with Build it in view). A thread says "you" when the viewer is the approver.
- **Screenshots:** [`B06-1.jpg`](shots/B06-1.jpg) (desktop-after-build-it), [`B06-2.jpg`](shots/B06-2.jpg) (desktop-plan-card-bottom)
- **Source notes:** F006, F007 (in `sources/`)

### B07 · Medium · One new-project message gets two bot replies at once, each quoting the whole question

*Homeroom bot · checked by hand · seen on: desktop 1440, all*

- **How to see it:** Main Chat: 'Can you make us a chore chart for our flat? …' > Send. Reply 1: 'New thread, for a new project: … Only you can see it.' Reply 2: 'That sounds like a new app of its own, so I'll come back to you here in a minute…'. Needs you also lists it under 'Only you' with 'Only you' again on the right.
- **Likely cause:** the new-thread notice and the conversational reply are posted as two messages; reply-to quote on both
- **Screenshots:** [`B07-1.jpg`](shots/B07-1.jpg) (04-after-25s)
- **Source notes:** F024 (in `sources/`)

### B08 · Medium · A new-project thread renames itself to the person's latest reply ('Yes please. Just the three of us…')

*Homeroom bot · checked by hand · seen on: desktop 1440*

- **How to see it:** Reply 'Yes please…' in a 'New thread, for a new project: A chore chart…' thread: its title and row become the reply text
- **Likely cause:** thread title derived from the latest user message instead of the idea/project name
- **Screenshots:** [`B08-1.jpg`](shots/B08-1.jpg) (bot-ben-3)
- **Source notes:** F026 (in `sources/`)

### B24 · Medium · A request that is already live still reads 'Reading the request' on its Main Chat row

*Homeroom bot · checked by hand · seen on: duo-sideways*

- **What:** The card is titled 'Your change to Book Club is ready to try' and ends 'It's live.'; directly below, the same request #1 shows a spinner and 'Reading the request · 8 updates'; the list header says 'In progress: 0'. Three statuses for one request on one screen. The 9:28 PM time also floats alone in the left gutter beside the card.
- **How to see it:** Main Chat: Book Club change card and the thread row under the New divider
- **Where to look:** `messages:bot.track.line.planning.reading` in frontend/src/features/messages/bot-track.tsx ~line 75 stays on a live request
- **Screenshots:** [`B24-1.jpg`](shots/B24-1.jpg) (duo-sideways--homeroom-bot), [`B24-2.jpg`](shots/B24-2.jpg) (duo-sideways--homeroom-bot)
- **Source notes:** I27 (in `sources/`)

### S01 · Medium · Restarting the app on 'Your new community · Share invite' drops a newcomer on Home; the invite step and their first look are gone

*First session · checked by hand · seen on: phone app*

- **How to see it:** New account: pick Tier list > Make it > (Ready to use, Share invite / Invite people later) > reload or relaunch the app
- **Likely cause:** the first-session hand-off is page state, not persisted; a cold start routes a settled account to #home
- **Screenshots:** [`S01-1.jpg`](shots/S01-1.jpg) (08-reload), [`S01-2.jpg`](shots/S01-2.jpg) (03-after-make-1s), [`S01-3.jpg`](shots/S01-3.jpg) (04-after-make-5s), [`S01-4.jpg`](shots/S01-4.jpg) (new-user-make)
- **Source notes:** F021 (in `sources/`)

### B19 · Low · Bot and request threads open with their title or first message cut under the header; a thread is titled with the bot's own sentence

*Homeroom bot · checked by hand · seen on: phone app, desktop 1440*

- **How to see it:** Open '1 update in its thread' under a bot draft reply
- **Likely cause:** thread title taken from the root message text; initial scroll lands below the root's avatar
- **Screenshots:** [`B19-1.jpg`](shots/B19-1.jpg) (08-draft-thread), [`B19-2.jpg`](shots/B19-2.jpg) (desktop-after-build-it)
- **Source notes:** F019, F008 (in `sources/`)

### B20 · Low · A thread repeats the same request card twice in a row, and reads 'request #1 's' with a gap

*Homeroom bot · checked by hand · seen on: phone app*

- **How to see it:** Post a drafted change from its bot thread
- **Likely cause:** request reference card attached to both the choice echo and the reply; chip renders with trailing space before 's
- **Screenshots:** [`B20-1.jpg`](shots/B20-1.jpg) (09-posted)
- **Source notes:** F020 (in `sources/`)

### B18 · Low · A queued request says 'Its turn'

*Homeroom bot · checked by hand · seen on: desktop 1440*

- **How to see it:** Bot tab with a request queued behind another build: right column reads 'Its turn'
- **Likely cause:** queue status copy; reads as if it is that request's turn now
- **Where to look:** `messages:ai.short.turn` used for `build_queued` in frontend/src/features/ai/model.ts ~line 454
- **Screenshots:** [`B18-1.jpg`](shots/B18-1.jpg) (desktop-ready-card)
- **Source notes:** F013 (in `sources/`)

## 2. Homeroom bot: messages, cards and what it builds

### B09 · Medium · Bot plan and 'live' messages lose their cards ('Cards refused') and arrive as bare text

*Homeroom bot · checked by hand · seen on: server, all*

- **How to see it:** Seen 4 times in one evening on private projects (Watering Rota plan + live, Book Club live, a hello for Cy). Server log: homeroom-bot-dm 'Cards refused; sending the message without them'.
- **Likely cause:** conversations.sendMessage validates each card with sharedObjects.validateForShare as the bot user; it likely cannot see private projects, so the whole card list is refused and the DM falls back to text
- **Where to look:** src/services/homeroom-bot-dm.js ~line 692: "Cards refused; sending the message without them"
- **Where to look:** src/services/conversations.js `sendMessage` runs `sharedObjects.validateForShare` as the bot user; one refused card drops them all
- **Screenshots:** [`B09-1.jpg`](shots/B09-1.jpg) (desktop-live)
- **Source notes:** F044 (in `sources/`)

### B10 · Medium · The bot plans 'fake demo people', and Try it shows them as 'staging-demo-priya' under a 'Staging demo' line

*Homeroom bot · checked by hand · seen on: phone app, all*

- **How to see it:** Cy's Swap change ready > Try it: 'Things to borrow · Staging demo: made-up things and neighbours, for looking around.' Rows 'Belongs to staging-demo-priya / With staging-demo-sam'. The plan's 5th bullet was 'Fake demo people so the week looks filled'.
- **Likely cause:** the spec asks for seeded demo data in staging and the builder names it with internal prefixes; voters see internal words and fake people mixed with their own items
- **Where to look:** the bot spec/build prompts ask for seeded demo data; Try it showed `staging-demo-*` names
- **Where to look:** house rule: no guessed starter content
- **Screenshots:** [`B10-1.jpg`](shots/B10-1.jpg) (02-try-it-5s), [`B10-2.jpg`](shots/B10-2.jpg) (desktop-ai), [`B10-3.jpg`](shots/B10-3.jpg) (tryit-cy), [`B10-4.jpg`](shots/B10-4.jpg) (01-ready-card)
- **Source notes:** F049, F003 (in `sources/`)

### B11 · Medium · Floating '3 new messages' pill and jump-to-latest chevron sit on top of message and plan text

*Homeroom bot · checked by hand · seen on: desktop 1440, android-chrome, phone-sideways, android-small, duo-sideways, phone 393 (app)*

- **What:** The round down-chevron is placed over body text: 'top with the[v]tup date' on Android, and over the bold 'Let members su[v]gest a book' in landscape. It hides words in the one message on screen. Pin it beside the composer or into the gutter, not over content.
- **How to see it:** Bot tab, plan card partly below the fold: the round chevron overlaps 'Your days are still there…' / 'Fake demo people…'
- **Likely cause:** floating button over content, no scroll-padding for it
- **Screenshots:** [`B11-1.jpg`](shots/B11-1.jpg) (desktop-ai), [`B11-2.jpg`](shots/B11-2.jpg) (iphone-mini--request), [`B11-3.jpg`](shots/B11-3.jpg) (02-main-chat), [`B11-4.jpg`](shots/B11-4.jpg) (android-chrome--request)
- **Source notes:** F002, F001, P7, A8, I18, X14 (in `sources/`)

### B12 · Medium · Thread status rows break open the bot's chat bubbles (a bubble with no top edge, borders running into rows)

*Homeroom bot · checked by hand · seen on: desktop 1440, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** The 9:24 bubble has no bottom edge and the 9:28 bubble has no top edge. The 'B ▷ #1 Let members suggest... Ready for your yes · 4 updates' row sits across the gap, so the two messages look like one broken frame with a row painted over it. This looks like a rendering glitch at every width.
- **How to see it:** Main Chat after Build it: the 9:12 bubble's left/right borders start under '1 update in its thread' with no top border
- **Likely cause:** grouped-message continuation style applied to a bubble that follows a thread link
- **Screenshots:** [`B12-1.jpg`](shots/B12-1.jpg) (desktop-ready-card), [`B12-2.jpg`](shots/B12-2.jpg) (desktop-1920--homeroom-bot), [`B12-3.jpg`](shots/B12-3.jpg) (desktop-1440--homeroom-bot), [`B12-4.jpg`](shots/B12-4.jpg) (desktop-1024--homeroom-bot)
- **Source notes:** F014, D3, A22 (in `sources/`)

### B15 · Medium · A triage fails ('no warm worker registered for session 6') when several requests arrive together

*Homeroom bot · checked by hand · seen on: server*

- **How to see it:** File 4 requests on 2 projects within a few seconds; one triage fails on the platform
- **Likely cause:** warm-worker registration races with concurrent bot sessions (seen on the Docker runtime)
- **Source notes:** F011 (in `sources/`)

### B16 · Low · Every bot reply re-quotes the same request

*Homeroom bot · checked by hand · seen on: all*

- **How to see it:** Bot chat after one request: the quote block repeats on each reply
- **Likely cause:** reply-to quote attached to every bot message in the same exchange
- **Screenshots:** [`B16-1.jpg`](shots/B16-1.jpg) (desktop-ai)
- **Source notes:** F004 (in `sources/`)

### B17 · Low · One decision is called Vote, Approve and 'your yes' on different screens (a Just-you project's row says Vote)

*Homeroom bot · reviewer-found, confirm first · seen on: desktop 1440, android-small, android-tablet, duo-folded*

- **What:** The words vary by screen: 'Vote' and '1 to vote' in lists, an 'Approve' button with 'Needs 2 approvals from you, @audit_ben or @audit_cy' in the chat card, 'Ready for your yes', 'asked for approval' and '0 of 2 yes votes'. People can't tell whether approving and voting are the same action.
- **How to see it:** Solo project, bot's change ready: Needs you row action 'Vote', card button 'Approve'
- **Likely cause:** row label does not follow the project's approval rule
- **Screenshots:** [`B17-1.jpg`](shots/B17-1.jpg) (desktop-ready-card), [`B17-2.jpg`](shots/B17-2.jpg) (android-tablet--homeroom-bot), [`B17-3.jpg`](shots/B17-3.jpg) (android-tablet--request), [`B17-4.jpg`](shots/B17-4.jpg) (android-small--homeroom-bot)
- **Source notes:** F012, A10 (in `sources/`)

### B21 · Low · The bot's hello card for a newcomer's first app shows a generic ◆, not the app's icon

*Homeroom bot · checked by hand · seen on: phone app*

- **How to see it:** New account makes Restaurant Tier List; open Homeroom bot > Main Chat: the APP card's tile is a black diamond while Home shows the bar-chart icon
- **Likely cause:** bot card falls back to a placeholder glyph instead of the project's icon
- **Screenshots:** [`B21-1.jpg`](shots/B21-1.jpg) (12-bot-main), [`B21-2.jpg`](shots/B21-2.jpg) (new-user-2)
- **Source notes:** F022 (in `sources/`)

### B22 · Low · The bot's drawn first screen uses made-up June dates in November

*Homeroom bot · checked by hand · seen on: all*

- **How to see it:** New-project thread > version 1 drawing > Open preview
- **Likely cause:** designer prompt has no today's date; invents sample dates
- **Screenshots:** [`B22-1.jpg`](shots/B22-1.jpg) (09-open-preview)
- **Source notes:** F027 (in `sources/`)

### B26 · Low · The bot-built Watering Rota app draws stray marks over 'Wed' and 'Fri' on a 13 mini

*Homeroom bot (built apps) · checked by hand · seen on: iphone-mini*

- **What:** A solid black square covers the 'd' of 'Wed' and a grey square covers the 'F' of 'Fri', and the seven buttons are squeezed to ~1pt gaps. The same screen renders cleanly on the other phones, so this looks like a paint glitch in the app frame at 375pt.
- **How to see it:** Watering Rota app, 'Your days' row: Wed and Fri
- **Screenshots:** [`B26-1.jpg`](shots/B26-1.jpg) (iphone-mini--app-tab)
- **Source notes:** I23 (in `sources/`)

### B27 · Low · For a Just-you project the bot explains group votes and offers to check 'the project's board'

*Homeroom bot · checked by hand · seen on: phone app*

- **How to see it:** New account with only Restaurant Tier List (Just you): Main Chat > tap 'How does the group decide?'
- **Likely cause:** canned suggestion chip and answer ignore the project's audience; 'board' is an internal word for the Workshop
- **Screenshots:** [`B27-1.jpg`](shots/B27-1.jpg) (21-answer)
- **Source notes:** F051 (in `sources/`)

## 3. Votes and counts that disagree

One source of truth for "waiting on you" and tallies.

### V01 · High · A vote waiting on you shows in Communities and Workshop, but the Hub says 'Nothing more to vote on' and Needs you says 'All caught up'

*Votes · checked by hand · seen on: all, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** Other screens agree the user owes a vote: Communities shows '1 vote waiting on you · Book Club', the bot's NEEDS YOU lists Book Club with a Vote link, and the request page shows 'Needs 2 more yes' with a Vote button. The project's own Hub says 'Nothing more to vote on.' The Hub is the project's front door, and here it hides the one decision the user owes.
- **How to see it:** Book Club (group) with the bot's change up for a vote, as audit_ada who has not voted: Communities tab 'Communities, 1 vote waiting on you' and row '1 to vote'; Workshop '1 waiting on a vote'; Hub For you 'Nothing more to vote on.'; Needs you 'All caught up. Every change you can vote on has your answer.'
- **Likely cause:** Hub/Needs-you vote query excludes this change (probably the bot's change whose screenshots failed, or the requester's own) while the counts include it
- **Where to look:** frontend/src/features/dev-board/workshop/hub-cards.tsx ~line 481-499 ("Nothing more to vote on")
- **Where to look:** frontend/src/features/dev-board/workshop/workshop.tsx ~line 2213 ("All caught up")
- **Where to look:** compare with the Communities count (`GET /api/workshop/needs-feed`) and the Workshop "waiting on a vote" figure
- **Done when:** Hub, Needs you, Communities and Workshop agree on what waits on the viewer, for the bot's change and for the requester's own.
- **Screenshots:** [`V01-1.jpg`](shots/V01-1.jpg) (needs-you-click), [`V01-2.jpg`](shots/V01-2.jpg) (desktop--workshop), [`V01-3.jpg`](shots/V01-3.jpg) (desktop--communities), [`V01-4.jpg`](shots/V01-4.jpg) (verify-3)
- **Source notes:** F034, D1, P15, A1 (in `sources/`)

### V02 · Medium · After voting on the only change waiting, the Communities badge grows from a blue 1 to a grey 2

*Votes · checked by hand · seen on: phone app*

- **How to see it:** As Cy: Communities > Review > Vote yes. 'All caught up', but the tab badge now reads 2 (grey) instead of clearing
- **Likely cause:** badge switches from votes (blue) to unread messages (grey) with no cue that it changed meaning
- **Screenshots:** [`V02-1.jpg`](shots/V02-1.jpg) (05-after-vote), [`V02-2.jpg`](shots/V02-2.jpg) (04-vote-sheet), [`V02-3.jpg`](shots/V02-3.jpg) (vote-cy-2)
- **Source notes:** F042 (in `sources/`)

### V05 · Medium · Vote tallies read '2 of 1 yes vote', '2/1 yes' and '1/2'

*Votes · checked by hand · seen on: phone, iphone-mini, duo-upright, duo-sideways, ipad, ipad-sideways*

- **What:** Once passed, the chip says '2 of 1 yes vote' (more than needed, singular) and the change header 'Live · 2/1 yes'. Earlier it read '0 of 2 yes votes', then 'Goes live in ~2d 23h · 1/2' beside 'Any of the 3 members can give it'. The threshold seems to change from 2 to 1 and is written four ways. The vote row also mixes purple-outline, blue, green and red pills, and on 375-393pt phones 'No (0)' wraps to a line of its own.
- **How to see it:** Request #1 thread: vote chip and the change header pill
- **Where to look:** `changes:badge.votePill.tallyWords_one` = "{{yes}} of 1 yes vote" in frontend/locales/en/changes.json ~line 5767; the tally passes yes > needed
- **Screenshots:** [`V05-1.jpg`](shots/V05-1.jpg) (iphone-mini--request), [`V05-2.jpg`](shots/V05-2.jpg) (ipad--request), [`V05-3.jpg`](shots/V05-3.jpg) (duo-sideways--request), [`V05-4.jpg`](shots/V05-4.jpg) (duo-upright--request)
- **Source notes:** I15, X3 (in `sources/`)

### V03 · Medium · The same vote shows three ways in four colours of pill on a request, with zero counts

*Votes · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, android-small*

- **What:** The Votes card shows 'Needs 2 more yes' and a blue Vote button. At 1920 the change header adds a purple 'Vote · 0/2' pill. The bot's message then adds four outlined chips in purple, blue, green and red: '0 of 2 yes votes', 'Preview', 'Yes (0)' and 'No (0)'. These show zero counts, use colours outside the single-accent palette and put four pills in one row.
- **How to see it:** Request page: Votes card, change header and the bot message's chips
- **Screenshots:** [`V03-1.jpg`](shots/V03-1.jpg) (desktop-1920--request), [`V03-2.jpg`](shots/V03-2.jpg) (desktop--request), [`V03-3.jpg`](shots/V03-3.jpg) (desktop-800--request), [`V03-4.jpg`](shots/V03-4.jpg) (android-tablet--request)
- **Source notes:** D22, A9 (in `sources/`)

### V04 · Low · The vote sheet opens with Yes already chosen

*Votes · checked by hand · seen on: phone app*

- **How to see it:** Communities > Review > Vote: Yes is pre-selected; 'Vote yes' is one tap away
- **Likely cause:** default choice; a neutral start avoids nudging a group decision
- **Screenshots:** [`V04-1.jpg`](shots/V04-1.jpg) (04-vote-sheet)
- **Source notes:** F043 (in `sources/`)

### Y03 · Low · Zeros are spelled out ('In progress: 0', big '0 live' and '0 challenges' tiles) where the house rule says zero shows nothing

*Copy · checked by hand · seen on: all, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** Two large cards show only zeros, against the rule that zero shows nothing. '0 live' also contradicts the Hub ('Book Club · Live since today') and the bot ('LIVE THIS WEEK · 1'), so the number looks wrong.
- **How to see it:** Bot tab with nothing building: header subtitle 'In progress: 0'
- **Likely cause:** counts rendered even at zero; house rule is that zero says nothing
- **Screenshots:** [`Y03-1.jpg`](shots/Y03-1.jpg) (13-profile), [`Y03-2.jpg`](shots/Y03-2.jpg) (11-bot-tab), [`Y03-3.jpg`](shots/Y03-3.jpg) (desktop--profile), [`Y03-4.jpg`](shots/Y03-4.jpg) (desktop-800--profile)
- **Source notes:** F023, D25, P26, A12, D31, P22, I14, X19 (in `sources/`)

## 4. Keyboard and short or odd-shaped screens

Re-check each with `npm run audit:layout` on the named shapes.

### K01 · High · Replying on a request page with the keyboard up: the reply box sits behind the keys and the thread shrinks to one sliced line

*Keyboard · checked by hand · seen on: Android emulator, Chrome (real), iPhone Safari, Android Chrome, phone sideways*

- **What:** When Reply is focused, the request card shrinks to its title. The thread is one sliced line: '(#1) · 9:15 PM' cut through the glyphs on iPhone, and a half-avatar plus clipped name on Android. In landscape only the Workshop pill and the Reply box remain. On Android and in landscape the jump-to-latest chevron also covers the title ('vote on the n[v]one'). You cannot see what you are replying to, and the large title block stays on screen while the content goes.
- **How to see it:** Open a request (dev/issues/1), tap the reply box with the keyboard up on a short viewport
- **Likely cause:** request page's composer is not lifted by the keyboard inset like chats (layout rule reply-box-covered, 10px and 36px behind)
- **Where to look:** request page composer: public/js/app-view.js (request view) and app.css; the chats already lift by the keyboard inset
- **Where to look:** layout rule `reply-box-covered` in scripts/layout-audit/rules.mjs flags it (android-chrome, phone-sideways)
- **Done when:** On a request page with the keyboard up, the reply box sits above the keys and the latest entry shows; `reply-box-covered` passes for android-chrome and phone-sideways in `npm run audit:layout`.
- **Screenshots:** [`K01-1.jpg`](shots/K01-1.jpg) (11-request-keyboard), [`K01-2.jpg`](shots/K01-2.jpg) (safari-phone--request--keyboard), [`K01-3.jpg`](shots/K01-3.jpg) (phone-sideways--request--keyboard), [`K01-4.jpg`](shots/K01-4.jpg) (android-chrome--request--keyboard)
- **Source notes:** F015, P4 (in `sources/`)

### L01 · High · Phone held sideways: the side rail's 'Home' row is printed over the page title

*Phone sideways · checked by hand · seen on: iPhone Safari sideways 852x393, phone-sideways*

- **What:** On Communities, Homeroom bot, Messages, DM, group, the App tabs and the request page, the rail's first row (house icon and 'Home') sits on top of the header's sidebar toggle and page title. You get 'Home' overprinted on 'Communities' / 'Messages' / 'Homeroom bot', and on the hub-open shot the title 'Neighbourhood Swap' runs half-faded under the rail and half-bold beside it. On the request page a pale green band covers the rail's top. It looks broken and covers both the sidebar toggle and the page title. Home, Discover, Profile, Settings and the hub do not overlap, so this is position or stacking on some screens only.
- **How to see it:** Turn an iPhone sideways in Safari: Communities, Homeroom bot, Messages: 'Home' and its icon overprint 'Communities' / 'Homeroom bot' / 'Messages' at the top-left
- **Likely cause:** page title in the header row and the rail's first row share the same box when the rail is shown at <500px height
- **Where to look:** public/css/app.css: the side rail on short viewports (the sideways-phone block from PR 6094) and the header title row
- **Done when:** On a phone held sideways no rail row overlaps the page title on any screen.
- **Screenshots:** [`L01-1.jpg`](shots/L01-1.jpg) (phone-sideways--communities), [`L01-2.jpg`](shots/L01-2.jpg) (phone-sideways--homeroom-bot), [`L01-3.jpg`](shots/L01-3.jpg) (verify-2), [`L01-4.jpg`](shots/L01-4.jpg) (phone-sideways--direct-message--keyboard)
- **Source notes:** F035, P1 (in `sources/`)

### B25 · High · Duo held sideways: the bot's chat runs under the 84pt system column; Send and the 'Live ›' chevron sit under the clock strip

*Homeroom bot · checked by hand · seen on: duo-sideways*

- **What:** Every other screen stops short of the column. A PR for exactly this (6086, 'chat under the column') was open earlier on 1 November; check it against current main before fixing again.
- **How to see it:** Homeroom bot tab, right chat pane: Send button, 'Live >' chevron, 'New' divider label, row chevrons
- **Where to look:** public/css/app.css: `--ai-edge` / the Duo side-strip blocks; check PR 6086 ("chat under the column") first, it may already fix this
- **Done when:** On a Duo held sideways nothing of the bot chat sits under the 84pt column (`npm run audit:layout -- --profiles duo-sideways`).
- **Screenshots:** [`B25-1.jpg`](shots/B25-1.jpg) (duo-sideways--homeroom-bot), [`B25-2.jpg`](shots/B25-2.jpg) (duo-sideways--homeroom-bot--keyboard), [`B25-3.jpg`](shots/B25-3.jpg) (duo-sideways--homeroom-bot), [`B25-4.jpg`](shots/B25-4.jpg) (duo-sideways--homeroom-bot--keyboard)
- **Source notes:** I0 (in `sources/`)

### L03 · Medium · Typing on a short screen leaves no conversation visible: a sideways phone shows only the reply box; a small Android phone shows only a '2 finished' strip

*Keyboard · checked by hand · seen on: iPhone Safari sideways, phone-sideways, Android emulator, Chrome (real)*

- **What:** In a sideways DM or group, focusing the message box removes the conversation header and every message. Only the outlined composer is left at the top of an empty card. The Homeroom bot chat keeps only the clipped bottom of the last card. Meanwhile the 270 pt rail and the full app header stay visible, so the space goes to navigation instead of the conversation you are typing into.
- **How to see it:** DM on a sideways phone, tap the reply box
- **Likely cause:** banner + header + keyboard leave ~0 height for the transcript (header folding from PR 6094 is not enough with the banner)
- **Screenshots:** [`L03-1.jpg`](shots/L03-1.jpg) (06-bot-main-keyboard), [`L03-2.jpg`](shots/L03-2.jpg) (phone-sideways--direct-message--keyboard), [`L03-3.jpg`](shots/L03-3.jpg) (phone-sideways--direct-message--keyboard), [`L03-4.jpg`](shots/L03-4.jpg) (phone-sideways--group--keyboard)
- **Source notes:** F041, P5, F053 (in `sources/`)

### L02 · Medium · Phone sideways: the side rail takes about a third of the width and squeezes every page

*Phone sideways · reviewer-found, confirm first · seen on: phone-sideways*

- **What:** On a phone held sideways the full-width rail stays open by default. Settings then has three columns, so the list truncates 'Linked ph...'. The Communities row subtitle cuts off at '1 in progress · 2 new messages · 3 ...'. The hub subtitle wraps 'Private community · 3 / members' beside its buttons. Home shows only four app tiles above the fold. A collapsed icon rail would give the content the room it needs.
- **How to see it:** Left rail, about 270 of 852 pt
- **Screenshots:** [`L02-1.jpg`](shots/L02-1.jpg) (phone-sideways--settings), [`L02-2.jpg`](shots/L02-2.jpg) (phone-sideways--communities), [`L02-3.jpg`](shots/L02-3.jpg) (phone-sideways--workshop), [`L02-4.jpg`](shots/L02-4.jpg) (phone-sideways--home)
- **Source notes:** P14 (in `sources/`)

### L04 · Medium · Safari's 'Add it to your home screen' banner stays up on a sideways phone, taking about 70 of 393pt

*Install banner · checked by hand · seen on: iPhone Safari sideways*

- **How to see it:** Open Homeroom in Safari, turn sideways: banner remains on every screen
- **Likely cause:** banner not hidden or compacted on short viewports
- **Screenshots:** [`L04-1.jpg`](shots/L04-1.jpg) (phone-sideways--discover)
- **Source notes:** F039 (in `sources/`)

### L06 · Medium · While data loads, screens claim to be empty: Discover says 'No apps to show yet', the bot shows an empty Needs you card

*Loading · checked by hand · seen on: iphone-max*

- **What:** Discover says 'No apps to show yet.' although every other device lists 11+ apps; the bot shows a 'NEEDS YOU' card with an empty body and no subtitle, chips or + button; the bell has no badge. A slow load should look like loading, not like a final 'nothing here'. Where a skeleton does show (Home), it draws two rows of four icons and full-width bars, unlike the real one row of tiles and square cards, so the page jumps on arrival.
- **How to see it:** Discover list; Homeroom bot NEEDS YOU card; Home skeleton; bell
- **Where to look:** frontend/src/features/apps/browse.js ~line 782 `discover:empty.all` shows before data arrives
- **Where to look:** `messages:ai.work.empty` in frontend/src/features/ai/lists.tsx ~line 492
- **Screenshots:** [`L06-1.jpg`](shots/L06-1.jpg) (iphone-max--discover), [`L06-2.jpg`](shots/L06-2.jpg) (iphone-max--homeroom-bot), [`L06-3.jpg`](shots/L06-3.jpg) (iphone-max--home)
- **Source notes:** I3 (in `sources/`)

### B13 · Medium · The bot tab squeezes three columns on in-between widths: its header breaks one word per line on a sideways phone and at 800px

*Homeroom bot · checked by hand · seen on: iPhone Safari sideways, phone-sideways, desktop-800, duo-sideways, ipad, ipad-sideways*

- **What:** The list column is about 170 pt wide. 'Homeroom bot' wraps onto two lines and 'Homeroom' is cut off at the card's right edge. 'Needs you: 1 · In progress: 0' breaks one word per line down the card. The project chip shows only 'Book C' and the Main Chat row is pushed below the fold. The rail, list and chat each get a third of 852 pt, and the list's third cannot hold its own header.
- **How to see it:** Homeroom bot on a phone held sideways: 'Homeroom bot / Needs / you: / 1 · / In / progress: / 0'
- **Likely cause:** rail (~270pt) + list + chat all shown at 852pt width
- **Screenshots:** [`B13-1.jpg`](shots/B13-1.jpg) (phone-sideways--homeroom-bot), [`B13-2.jpg`](shots/B13-2.jpg) (phone-sideways--homeroom-bot), [`B13-3.jpg`](shots/B13-3.jpg) (phone-sideways--homeroom-bot--keyboard), [`B13-4.jpg`](shots/B13-4.jpg) (desktop-800--homeroom-bot)
- **Source notes:** F036, P2, D4, I26 (in `sources/`)

### B14 · Medium · Android app: the bot tab's 'Ask Homeroom bot' bar sits under the system navigation bar

*Homeroom bot · checked by hand · seen on: Android small phone, app (emulated insets)*

- **How to see it:** Android app shape 360x640 with a 48px navigation bar: Homeroom bot tab, ask bar text and mic under the nav bar (layout rule content-under-system)
- **Likely cause:** ask bar positioned from the viewport bottom without the bottom inset the tab bar uses; verify on a real Android build
- **Screenshots:** [`B14-1.jpg`](shots/B14-1.jpg) (android-small--homeroom-bot)
- **Source notes:** F032 (in `sources/`)

### M01 · Medium · On the 13 mini, subtitles and chips are cut ('2 n…', 'Just you' at the edge, 'Neighbourhood Sw…') and tab labels touch

*iPhone 13 mini · checked by hand · seen on: iphone-mini, phone 393 (app)*

- **What:** At 375pt Book Club's subtitle becomes '1 in progress · 2 n…' (the '2 new messages' is lost behind the '1 to vote' pill; it is already cut to '2 new …' on the 393pt phone), the 'Just you 1' chip is cut at the edge, the project header reads 'Neighbourhood Sw…', Settings subtitles end 'signed in w…' and 'ChatGPT …', the bot's chip reads 'Watering Rot'. In the tab bar 'Homeroom bot' runs into the lit Messages pill with no gap, so neighbouring targets visually merge.
- **How to see it:** Communities rows and chips, project header, Settings subtitles, bot chips, tab bar
- **Screenshots:** [`M01-1.jpg`](shots/M01-1.jpg) (iphone-mini--home), [`M01-2.jpg`](shots/M01-2.jpg) (iphone-mini--communities), [`M01-3.jpg`](shots/M01-3.jpg) (iphone-mini--communities), [`M01-4.jpg`](shots/M01-4.jpg) (iphone-mini--hub-open)
- **Source notes:** I10, X20 (in `sources/`)

### U01 · Medium · Duo: a pale capsule is painted through a coloured project header above the clock

*iPhone Duo · checked by hand · seen on: iPhone Duo folded, real app, duo-folded*

- **What:** The header runs across the top of the system column, and a pale rounded capsule about 55pt wide is painted through it, fading toward the clock. On the teal project header it shows as a white smear. On neutral screens it is faint, with a small blue smudge under the header's bottom edge beside the avatar chevron. It looks like a rendering artifact next to the system clock.
- **How to see it:** Folded Duo, open Book Club (teal header): above '9:42' a translucent rounded shape cuts into the teal band
- **Likely cause:** the column's top cap is drawn with the page's plane colour over the header instead of matching the header's tint (or being transparent)
- **Screenshots:** [`U01-1.jpg`](shots/U01-1.jpg) (duo-capsule-crop), [`U01-2.jpg`](shots/U01-2.jpg) (duo-folded--workshop), [`U01-3.jpg`](shots/U01-3.jpg) (duo-folded--request), [`U01-4.jpg`](shots/U01-4.jpg) (duo-folded--proposals)
- **Source notes:** F047, A30 (in `sources/`)

### U03 · Medium · Duo upright: Messages has no header title, and other titles are centred or left-aligned at random

*iPhone Duo · reviewer-found, confirm first · seen on: duo-upright*

- **What:** Messages shows only the bell and avatar, with an empty left half and no title. Home, Discover, Communities, Homeroom bot, Profile, Settings and Challenges centre their title on the full width while the bell/avatar are pushed left of the clock, so 'Homeroom bot' crowds the bell and the left side is empty. Conversations, hubs and the App view left-align instead. Phones and iPad always left-align.
- **How to see it:** Top header on the unfolded Duo, upright
- **Screenshots:** [`U03-1.jpg`](shots/U03-1.jpg) (duo-upright--messages), [`U03-2.jpg`](shots/U03-2.jpg) (duo-upright--homeroom-bot), [`U03-3.jpg`](shots/U03-3.jpg) (duo-upright--direct-message), [`U03-4.jpg`](shots/U03-4.jpg) (duo-upright--home)
- **Source notes:** I5 (in `sources/`)

### G02 · Medium · Android small phone: a project's App frame runs about 5px under the navigation bar

*Android · reviewer-found, confirm first · seen on: android-small*

- **What:** The app sheet goes to the bottom of the screen with no bottom inset. The template's footer line 'disappears once you build your real app.' ends at about 597px, past the 592px top of the 48px navigation bar, so the last 48px of any app sits under the system bar. The shell's own tab bar does keep clear of it.
- **How to see it:** Bottom edge of a project's App tab
- **Screenshots:** [`G02-1.jpg`](shots/G02-1.jpg) (android-small--hub-group), [`G02-2.jpg`](shots/G02-2.jpg) (android-small--hub-open)
- **Source notes:** A19 (in `sources/`)

### U02 · Low · Duo rail: labels overflow or truncate, the ✕ on a recent app is 20pt, chat headers hug the top edge

*iPhone Duo · checked by hand · seen on: iPhone Duo folded, real app (WebKit), duo-folded*

- **What:** 'Communities' is wider than its lit pill and runs past both edges, and 'Messages' touches them. App chips truncate ('Neighbou…', 'Watering …'), and 'Homeroom bot' wraps to two lines while the others use one. The × that removes a recent app is about an 8pt target perched on the icon's corner.
- **How to see it:** Folded Duo app, side rail with a recently opened project: its ✕ 'Forget Watering Rota' is 20x20
- **Likely cause:** platform-side-app-x sized for a pointer
- **Screenshots:** [`U02-1.jpg`](shots/U02-1.jpg) (duo-folded--settings), [`U02-2.jpg`](shots/U02-2.jpg) (duo-folded--communities), [`U02-3.jpg`](shots/U02-3.jpg) (duo-folded--hub-open), [`U02-4.jpg`](shots/U02-4.jpg) (duo-folded--workshop)
- **Source notes:** F033, A32, A33 (in `sources/`)

## 5. Navigation, project page, chat and sheets

### N01 · Medium · Phone tab bar: keyboard and screen-reader order (Home, Messages, Bot, Communities) differs from the order on screen

*Navigation · checked by hand · seen on: all phones, app and browser*

- **How to see it:** DOM/tab/VoiceOver order: Home, Messages, Homeroom bot, Communities, You. On screen: Home, Communities, Homeroom bot, Messages, You.
- **Likely cause:** tabs reordered with CSS order (or absolute x) instead of in the DOM; keyboard and screen-reader order no longer match
- **Where to look:** the phone tab bar orders tabs visually (CSS) differently from the DOM: Home, Messages, Bot, Communities, You
- **Screenshots:** [`N01-1.jpg`](shots/N01-1.jpg) (tabbar)
- **Source notes:** F016 (in `sources/`)

### N02 · Medium · The Communities tab becomes the last community's boxed tile ('B'), keeps it in other projects, and its label sits lower than its neighbours

*Navigation · checked by hand · seen on: iPhone Duo folded, real app, all phones, all phones, app and browser, duo-folded, android-small, safari-phone*

- **What:** After you visit Book Club, the Communities item becomes a teal-framed 'B' with a grey badge. It stays that way on Profile, Settings and Challenges, and even inside Watering Rota's app. The tab then looks like a Book Club shortcut, and its badge loses the blue that marks a waiting vote.
- **How to see it:** Open Book Club, then Watering Rota: the rail/tab 'Communities' shows a boxed 'B' with a grey badge while you are in Watering Rota; on Home it is the boxed people glyph
- **Likely cause:** tab icon switches to a 'last community' tile; reads as if Book Club were selected; also the source of the boxed-icon misalignment (F017)
- **Where to look:** frontend/src/features/nav/: the Communities tab icon switches to the last community's tile
- **Screenshots:** [`N02-1.jpg`](shots/N02-1.jpg) (tabbar), [`N02-2.jpg`](shots/N02-2.jpg) (duo-capsule-crop), [`N02-3.jpg`](shots/N02-3.jpg) (safari-phone--home), [`N02-4.jpg`](shots/N02-4.jpg) (verify-duo)
- **Source notes:** F046, F017, A31, A34, P13, I11 (in `sources/`)

### N03 · Medium · A link to a project's Workshop or Proposals lands on the Hub (clicking Workshop inside the app works)

*Navigation · checked by hand · seen on: all, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** At every width, the Workshop shots and the Proposals shots both show Book Club's Hub, with 'Hub' highlighted in the sidebar, and the two are identical. The Workshop board and the proposals list never appear. Either those routes redirect to the Hub or they cannot be reached directly. Worth checking which.
- **How to see it:** Load /app/book-club-d10610/workshop or #app/…/dev/proposals cold: the Hub shows with Hub lit in the sidebar. Clicking Workshop in the sidebar then shows the Workshop.
- **Likely cause:** _landOnHub runs for any cold entry to a project, not only for doors that say 'hub'
- **Screenshots:** [`N03-1.jpg`](shots/N03-1.jpg) (desktop--workshop), [`N03-2.jpg`](shots/N03-2.jpg) (desktop--proposals), [`N03-3.jpg`](shots/N03-3.jpg) (desktop-1920--workshop), [`N03-4.jpg`](shots/N03-4.jpg) (desktop-1920--proposals)
- **Source notes:** F040, D15, P9, A2, I24, X10 (in `sources/`)

### N04 · Medium · Sidebar badges change colour and shape or vanish between pages, and an unexplained grey dot sits on a project's App row

*Navigation · checked by hand · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, android-tablet*

- **What:** Book Club's blue '1' disappears when its row expands, and its 'Needs you' sub-row shows no count. 'All 4 communities' shows a blue '1' on most pages but a grey one on the Hub. Homeroom bot shows a grey '1' circle at 800. #general has a grey '2 unread' pill, while the Hub shows the same messages as a blue '2 new' pill. One kind of count gets four different treatments, and the one that matters disappears when you open the project.
- **How to see it:** Left sidebar, Communities list
- **Screenshots:** [`N04-1.jpg`](shots/N04-1.jpg) (desktop--workshop), [`N04-2.jpg`](shots/N04-2.jpg) (desktop--hub-group), [`N04-3.jpg`](shots/N04-3.jpg) (desktop--home), [`N04-4.jpg`](shots/N04-4.jpg) (desktop-800--home)
- **Source notes:** D13, A28, P32, D14, I12, I34 (in `sources/`)

### P01 · Medium · A project's top bar switches between its colour and neutral (and loses Suggest) across its own tabs

*Project page · checked by hand · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** On the App tab the bar is light, with a periwinkle 'Suggest' pill. On the Hub and request pages the same project's bar turns solid teal and Suggest disappears. On the Hub, the primary 'Open app' button is also teal instead of the single blue action accent. The same project looks like two different products.
- **How to see it:** Top bar on Book Club's App tab compared with its Hub and request pages
- **Screenshots:** [`P01-1.jpg`](shots/P01-1.jpg) (10-request), [`P01-2.jpg`](shots/P01-2.jpg) (12-project), [`P01-3.jpg`](shots/P01-3.jpg) (desktop--hub-group), [`P01-4.jpg`](shots/P01-4.jpg) (desktop--workshop)
- **Source notes:** D12, P21, A14 (in `sources/`)

### P05 · Medium · On phones a project's App view has no Suggest button and no way to its Hub

*Project page · reviewer-found, confirm first · seen on: phone, iphone-mini, iphone-max*

- **What:** On the Duo upright and every sidebar layout the header has a 'Suggest' pill (and the sidebar lists Hub, Needs you, Workshop). On every phone the header has only X, the name, bell and avatar: no Suggest, no switch to Hub or Workshop, and the tab bar is hidden. The starter screen itself tells people to tap the Homeroom icon and choose Suggest an improvement.
- **How to see it:** Project App view header
- **Screenshots:** [`P05-1.jpg`](shots/P05-1.jpg) (phone--app-tab), [`P05-2.jpg`](shots/P05-2.jpg) (iphone-max--hub-group), [`P05-3.jpg`](shots/P05-3.jpg) (duo-upright--app-tab)
- **Source notes:** I22 (in `sources/`)

### C01 · Medium · In a group chat on a phone, the members and ••• buttons float over the top of the transcript

*Chat · checked by hand · seen on: Android emulator, Chrome (real), iPhone Safari, Android Chrome, android-chrome, safari-phone, android-small*

- **What:** The members and ••• buttons float over the scrolling thread with no backing bar. In the Android group they cover the '@audit_ada 9:14 PM' sender line. On iPhone they sit on the first visible bubble. In the DM with the keyboard up, ••• sits on 'has the numbers'. Text shows through around them, and a tap meant for the bubble lands on the menu.
- **How to see it:** Pixel-class emulator 720x1280, Chrome, Flat 4B: 'Can someone remind n…' runs under the members disc
- **Likely cause:** floating header actions over the transcript (see C01)
- **Screenshots:** [`C01-1.jpg`](shots/C01-1.jpg) (08-group), [`C01-2.jpg`](shots/C01-2.jpg) (iphone-mini--group), [`C01-3.jpg`](shots/C01-3.jpg) (safari-phone--group), [`C01-4.jpg`](shots/C01-4.jpg) (android-chrome--group)
- **Source notes:** F052, F045, P6, A7, I4, X7 (in `sources/`)

### C02 · Medium · The group chat 'Flat 4B' is filed under 'Direct messages'

*Chat · checked by hand · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** Flat 4B has 3 members ('you own this group') but appears under DIRECT MESSAGES in the list and under 'Direct messages' in the sidebar. Its avatar is also drawn three ways: a stacked pair in the list, a single 'A' tile in the sidebar and a single 'A' circle in the chat header.
- **How to see it:** Messages list section label and the sidebar sub-heading under Messages
- **Screenshots:** [`C02-1.jpg`](shots/C02-1.jpg) (07-messages), [`C02-2.jpg`](shots/C02-2.jpg) (desktop--messages), [`C02-3.jpg`](shots/C02-3.jpg) (desktop--group), [`C02-4.jpg`](shots/C02-4.jpg) (desktop-800--messages)
- **Source notes:** D10, P11, A5, I19 (in `sources/`)

### C03 · Medium · The Messages list has two different row designs, upright phone versus sideways phone and tablet

*Chat · reviewer-found, confirm first · seen on: safari-phone, android-chrome, phone-sideways, android-small, duo-folded*

- **What:** Upright, the rows are bare on the background: no card, no time, a single avatar, and regular-weight titles that do not match the 15/650 row title. Sideways, the same rows sit in a 20 px card with bold titles, '16m ago', a stacked group avatar and a members chip. Upright, the screen also has a large empty area under two rows. It is one component with two designs, and the upright one breaks house style.
- **How to see it:** Conversation rows
- **Screenshots:** [`C03-1.jpg`](shots/C03-1.jpg) (safari-phone--messages), [`C03-2.jpg`](shots/C03-2.jpg) (android-chrome--messages), [`C03-3.jpg`](shots/C03-3.jpg) (phone-sideways--messages), [`C03-4.jpg`](shots/C03-4.jpg) (android-small--messages)
- **Source notes:** P12, A6 (in `sources/`)

### C04 · Medium · Desktop Messages never shows the list beside the conversation, and a conversation stretches about 1500px wide at 1920

*Chat · reviewer-found, confirm first · seen on: desktop, desktop-1440, desktop-1920*

- **What:** The list is a single column of about 700px floating in a full-width sheet, with the rest of the screen empty. Opening a chat replaces the list, so switching chats always means going back. The Homeroom bot tab already shows a list and a chat together at these widths; Messages should do the same.
- **How to see it:** Messages list and conversation views from 1280px up
- **Screenshots:** [`C04-1.jpg`](shots/C04-1.jpg) (desktop-1920--messages), [`C04-2.jpg`](shots/C04-2.jpg) (desktop-1440--messages), [`C04-3.jpg`](shots/C04-3.jpg) (desktop--messages), [`C04-4.jpg`](shots/C04-4.jpg) (desktop-1920--direct-message)
- **Source notes:** D8, D9 (in `sources/`)

### D01 · Medium · Going Back with a bottom sheet open leaves the sheet floating over the next screen; the next tap only closes it

*Sheets and dialogs · checked by hand · seen on: phone 393 (app)*

- **What:** Seen with the hub's ••• sheet and Discover's Filters on phones (Android back, swipe back, browser back). The same menu on desktop closes properly.
- **How to see it:** Phone app shape: open #app/book-club-d10610/workshop, tap the hub's ••• (#dev-plus-btn), then go Back (history.back) or set location.hash to #communities / #settings. Same with #apps > Filters, then #leaderboard/challenges.
- **Screenshots:** [`D01-1.jpg`](shots/D01-1.jpg) (phone-suggest-sheet-after-back), [`D01-2.jpg`](shots/D01-2.jpg) (phone-settings), [`D01-3.jpg`](shots/D01-3.jpg) (phone-profile), [`D01-4.jpg`](shots/D01-4.jpg) (phone-leaderboard)
- **Source notes:** X0 (in `sources/`)

### D02 · Medium · Escape in the 'Who says yes?' picker closes the whole New project dialog and loses the typed idea; the picker doesn't match its row label

*Sheets and dialogs · reviewer-found, confirm first · seen on: desktop 1440, phone 393 (app)*

- **What:** Escape should close only the picker on top. It closes both layers and lands on Home; reopening shows an empty brief, so the description the person wrote is lost.
- **How to see it:** #home > New project tile > type a brief in 'What should it do?' > Change > press Escape. Home is shown; reopen New project: the brief is empty.
- **Screenshots:** [`D02-1.jpg`](shots/D02-1.jpg) (desk-create-typed), [`D02-2.jpg`](shots/D02-2.jpg) (desk-create-who), [`D02-3.jpg`](shots/D02-3.jpg) (desk-create-after-esc), [`D02-4.jpg`](shots/D02-4.jpg) (phone-create-after-esc)
- **Source notes:** X1, X27 (in `sources/`)

### D03 · Medium · Just opening Invite mints a 7-day link, and Communities then says 'Invite link out' for the project

*Invites · checked by hand · seen on: all*

- **What:** Looking at the Invite pane creates a live link (by design per invite-pane.tsx) even if nothing is copied or shared. Afterwards the Communities row for Watering Rota changed from '55m ago' to 'Invite link out', telling the owner an invite is out when none was sent. NOTE: this audit run did this to Watering Rota.
- **How to see it:** Communities shows Watering Rota '55m ago'. Open #app/watering-rota-fba57e/workshop > Invite, close it without copying. Reload #communities: the row now says 'Invite link out'.
- **Where to look:** src/services/community-invites.js ~line 338 and frontend/src/features/workshop/index.tsx ~line 306 ("Invite link out"); the Invite pane creates a link on open
- **Screenshots:** [`D03-1.jpg`](shots/D03-1.jpg) (phone-wr-invite), [`D03-2.jpg`](shots/D03-2.jpg) (phone-communities), [`D03-3.jpg`](shots/D03-3.jpg) (desk-communities)
- **Source notes:** X2 (in `sources/`)

### N05 · Low · Request page: two back buttons, and its header says 'Hub' under a '< Workshop' breadcrumb

*Navigation · checked by hand · seen on: android-small, android-tablet, duo-folded, safari-phone, android-chrome, phone*

- **What:** The breadcrumb right under the header reads '< Workshop', so the two disagree about where you are. On the tablet, none of App, Hub, Needs you or Workshop is lit while a request is open, so nothing shows where you are.
- **How to see it:** Header subtitle under 'Book Club'; tablet sidebar project sub-list
- **Screenshots:** [`N05-1.jpg`](shots/N05-1.jpg) (10-request), [`N05-2.jpg`](shots/N05-2.jpg) (android-small--request), [`N05-3.jpg`](shots/N05-3.jpg) (duo-folded--request), [`N05-4.jpg`](shots/N05-4.jpg) (android-tablet--request)
- **Source notes:** A3, P17, I16 (in `sources/`)

### N06 · Low · A 'Resume' bar for the last app floats over the bottom of Profile and Settings

*Navigation · checked by hand · seen on: Android emulator, Chrome (real)*

- **How to see it:** Open a project's app, then go to You or Settings: a Resume bar sits above the tab bar over 'Your changes' and the Settings list
- **Likely cause:** the resume-app bar overlays content without reserving space
- **Screenshots:** [`N06-1.jpg`](shots/N06-1.jpg) (13-profile), [`N06-2.jpg`](shots/N06-2.jpg) (iphone-mini--settings)
- **Source notes:** F054 (in `sources/`)

### P02 · Low · Pages repeat the project's name as a second large heading; Recently live is mostly empty

*Project page · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** 'Book Club' appears in the top bar, again as a large hero heading under a separate large 'Hub' heading, and a third time as the only Recently live card. That card's teal tile fills about a third of a full-width panel, and the rest of the panel is empty.
- **How to see it:** Book Club Hub
- **Screenshots:** [`P02-1.jpg`](shots/P02-1.jpg) (desktop--workshop), [`P02-2.jpg`](shots/P02-2.jpg) (desktop-1920--workshop), [`P02-3.jpg`](shots/P02-3.jpg) (desktop-800--workshop), [`P02-4.jpg`](shots/P02-4.jpg) (safari-phone--workshop)
- **Source notes:** D32, P20, A13, I28, X18 (in `sources/`)

### P03 · Low · The Hub's For you card nearly touches the screen edges on phones

*Project page · reviewer-found, confirm first · seen on: safari-phone, android-chrome, android-small, duo-folded, phone, iphone-mini*

- **What:** The card is inset about 5 pt from each side. The hero above it, the FOR YOU label, and the cards on Communities, Profile and Settings use about 16 pt. The card looks wider than everything else on the page.
- **How to see it:** FOR YOU card on the hub
- **Screenshots:** [`P03-1.jpg`](shots/P03-1.jpg) (safari-phone--workshop), [`P03-2.jpg`](shots/P03-2.jpg) (android-chrome--workshop), [`P03-3.jpg`](shots/P03-3.jpg) (android-small--workshop), [`P03-4.jpg`](shots/P03-4.jpg) (duo-folded--workshop)
- **Source notes:** P18, A20, I25 (in `sources/`)

### P04 · Low · Hub rows truncate their time to '· 9…'; a Just-you project shows a channel and a bare time

*Project page · reviewer-found, confirm first · seen on: safari-phone, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** The preview '@audit_ben: Works for me 📚 · 9...' loses the timestamp to an ellipsis because the '2 new' pill and the chevron take the right side. A bare '9...' means nothing. Drop the time, or truncate the message text instead of the time.
- **How to see it:** Discussion #general row in the For you card
- **Screenshots:** [`P04-1.jpg`](shots/P04-1.jpg) (safari-phone--workshop), [`P04-2.jpg`](shots/P04-2.jpg) (desktop--communities), [`P04-3.jpg`](shots/P04-3.jpg) (desktop--hub-solo)
- **Source notes:** P19, D33 (in `sources/`)

### C05 · Low · Sender names have '@' in groups but not in DMs, and your own name repeats on every message

*Chat · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, android-small*

- **What:** Group chats put '@' before every sender (@audit_cy, @audit_ada), but the DM shows 'audit_ben' without it. Your own name and time repeat in blue above every one of your bubbles, even consecutive ones sent in the same minute. That uses the action accent on a label and adds noise.
- **How to see it:** Name and time line above each message bubble
- **Screenshots:** [`C05-1.jpg`](shots/C05-1.jpg) (desktop--group), [`C05-2.jpg`](shots/C05-2.jpg) (desktop--direct-message), [`C05-3.jpg`](shots/C05-3.jpg) (android-small--group), [`C05-4.jpg`](shots/C05-4.jpg) (android-small--direct-message)
- **Source notes:** D11, A27, X9 (in `sources/`)

### C06 · Low · An empty reply box's send button looks enabled on requests but disabled in chats

*Chat · reviewer-found, confirm first · seen on: android-small, android-tablet, duo-folded*

- **What:** With nothing typed, the request 'Reply…' box shows a solid blue send button, while the DM and group 'Message…' boxes show a pale disabled one. It is the same component in two states for the same condition.
- **How to see it:** Send button at the right of the composer
- **Screenshots:** [`C06-1.jpg`](shots/C06-1.jpg) (android-small--request), [`C06-2.jpg`](shots/C06-2.jpg) (android-small--direct-message), [`C06-3.jpg`](shots/C06-3.jpg) (duo-folded--request), [`C06-4.jpg`](shots/C06-4.jpg) (duo-folded--direct-message)
- **Source notes:** A29 (in `sources/`)

### D06 · Low · Your own message's action sheet in a group shows '@@audit_ada'

*Chat · reviewer-found, confirm first · seen on: phone 393 (app)*

- **What:** Double '@'. In the DM the same header reads '@audit_ben', so the group path adds a second @ to an already-@ name.
- **How to see it:** #messages/6, long-press 'Can someone remind me Wednesday?'.
- **Screenshots:** [`D06-1.jpg`](shots/D06-1.jpg) (phone-group-own-longpress)
- **Source notes:** X8 (in `sources/`)

### D07 · Low · The Homeroom menu cuts 'Go to community' to 'Go to com…' when a decision waits; the Invite pane's back arrow goes to a menu you never opened

*Navigation · reviewer-found, confirm first · seen on: phone 393 (app)*

- **What:** The status phrase takes the row and the action label is cut mid-word. Put the status on a second line.
- **How to see it:** Open #app/book-club-d10610 while a vote is waiting on you > Homeroom menu (#platform-mark-btn).
- **Screenshots:** [`D07-1.jpg`](shots/D07-1.jpg) (phone-bc-menu), [`D07-2.jpg`](shots/D07-2.jpg) (phone-bc-invite)
- **Source notes:** X11, X29 (in `sources/`)

### D09 · Low · People pickers put a red 'Block' beside every search result

*Messages · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** A destructive action shares the row with the primary one in a picker whose job is choosing someone. It is easy to mis-tap and loud for an action rarely wanted here. Move it to a row menu or the profile.
- **How to see it:** #messages > New message (#messages-new) > Direct message > type 'aud'.
- **Screenshots:** [`D09-1.jpg`](shots/D09-1.jpg) (phone-dm-picker-typed), [`D09-2.jpg`](shots/D09-2.jpg) (phone-group-picker-typed), [`D09-3.jpg`](shots/D09-3.jpg) (phone-new-dm)
- **Source notes:** X15 (in `sources/`)

### D13 · Low · On desktop, a message's hover toolbar sits far from a left-aligned message

*Chat · reviewer-found, confirm first · seen on: desktop 1440*

- **What:** The reaction/actions bar pins to the transcript's right edge, about 800px from the bubble it acts on, overlapping the row above. It is hard to tell which message it belongs to.
- **How to see it:** #messages/6 on desktop, hover a message from someone else.
- **Screenshots:** [`D13-1.jpg`](shots/D13-1.jpg) (desk-group-hover)
- **Source notes:** X25 (in `sources/`)

### D14 · Low · Cancel on a typed Suggest form throws it away without asking

*Sheets and dialogs · reviewer-found, confirm first · seen on: phone 393 (app)*

- **What:** Several lines of typed feedback and an auto-suggested title vanish on one tap, with no draft kept and no confirm.
- **How to see it:** Homeroom menu > Suggest an improvement > Got it > Form > type in 'What should change?' > Cancel > reopen.
- **Screenshots:** [`D14-1.jpg`](shots/D14-1.jpg) (phone-form-typed), [`D14-2.jpg`](shots/D14-2.jpg) (phone-after-cancel)
- **Source notes:** X26 (in `sources/`)

## 6. Desktop and tablet layout

### W01 · Medium · Settings at 800px keeps three columns and cuts your name to 'A.' and '@.'

*Desktop layout · checked by hand · seen on: desktop 800, desktop-800, ipad, duo-sideways*

- **What:** At 800px the page keeps three columns (app sidebar, settings nav, detail), which leaves the detail pane about 260px wide. The profile card shows 'A.' and '@.' instead of 'Ada Audit' and '@audit_ada', and the Sign-in rows cut off as 'Email & rec...' and 'audit_ada@au...'. The user cannot read their own account details. Below about 1000px the settings nav or the app sidebar should collapse.
- **How to see it:** Desktop window 800px wide > Settings: Profile card shows 'A.' and '@.', 'Email & rec…', 'Agent instructions…'
- **Likely cause:** sidebar + settings list + detail pane all kept at 800px
- **Screenshots:** [`W01-1.jpg`](shots/W01-1.jpg) (desktop-800--settings), [`W01-2.jpg`](shots/W01-2.jpg) (ipad--settings), [`W01-3.jpg`](shots/W01-3.jpg) (duo-sideways--settings)
- **Source notes:** F038, D0, I2 (in `sources/`)

### W02 · Medium · Every top-level screen uses a different content width and alignment; Discover alone runs edge to edge

*Desktop layout · reviewer-found, confirm first · seen on: desktop, desktop-1440, desktop-1920*

- **What:** At 1920 the main column is centred at about 1000px on Home, Profile and Settings, 640px on Communities, 690px on Messages, 760px on Hub and the request page, and about 1640px edge to edge on Discover and in conversations. Challenges pins its tabs left and centres its message. Moving between sidebar items makes the content jump in width and position.
- **How to see it:** Main column on Home, Discover, Communities, Messages, Profile, Hub and Challenges
- **Screenshots:** [`W02-1.jpg`](shots/W02-1.jpg) (desktop-1920--home), [`W02-2.jpg`](shots/W02-2.jpg) (desktop-1920--communities), [`W02-3.jpg`](shots/W02-3.jpg) (desktop-1920--discover), [`W02-4.jpg`](shots/W02-4.jpg) (desktop-1920--leaderboard)
- **Source notes:** D7, D6 (in `sources/`)

### W03 · Medium · Discover at 800px: the two-column grid cuts off every card's subtitle

*Desktop layout · reviewer-found, confirm first · seen on: desktop-800, ipad, duo-sideways*

- **What:** Each card is about 250px wide. Titles wrap onto two lines ('Group / challenge', 'Find a / time'), every subtitle cuts off as 'Updated 2...', and the Homeroom card's description shows only 'The commu...'. The same cards fit on one line at 1024. A single column would fit at this width.
- **How to see it:** Discover, ALL APPS grid
- **Screenshots:** [`W03-1.jpg`](shots/W03-1.jpg) (desktop-800--discover), [`W03-2.jpg`](shots/W03-2.jpg) (ipad--discover), [`W03-3.jpg`](shots/W03-3.jpg) (duo-sideways--discover), [`W03-4.jpg`](shots/W03-4.jpg) (ipad-sideways--discover)
- **Source notes:** D5, I8 (in `sources/`)

### W04 · Medium · Tablet Home and Discover don't use the wide screen; Discover rows are very tall with a filled Join on every row

*Tablet layout · reviewer-found, confirm first · seen on: android-tablet, android-small, duo-folded*

- **What:** Four small app icons are spread about 250px apart across the full width. The Home search bar touches the header with no gap. On Discover, the search box and For you/Browse/Joined stop at about 575px while the card grid below runs about 1000px, and the ALL APPS label is indented about 16px from the cards.
- **How to see it:** Home My apps row and search bar; Discover search, tabs and grid
- **Screenshots:** [`W04-1.jpg`](shots/W04-1.jpg) (android-tablet--home), [`W04-2.jpg`](shots/W04-2.jpg) (android-tablet--discover), [`W04-3.jpg`](shots/W04-3.jpg) (android-small--discover), [`W04-4.jpg`](shots/W04-4.jpg) (duo-folded--discover)
- **Source notes:** A21, A25 (in `sources/`)

### W08 · Medium · Discover rows on phones split a title from its subtitle and drop the Join button

*Discover · reviewer-found, confirm first · seen on: phone, iphone-mini*

- **What:** At 375-393pt each row is ~96pt tall: the title sits at the top, 'Updated 52m ago' falls ~37pt below it and the Join pill lines up with the subtitle, below the icon's centre. On the Duo upright the same row is compact (title over subtitle, Join centred). The phone version looks like a wrapping bug and fits half as many apps.
- **How to see it:** Discover, ALL APPS list rows
- **Screenshots:** [`W08-1.jpg`](shots/W08-1.jpg) (phone--discover), [`W08-2.jpg`](shots/W08-2.jpg) (iphone-mini--discover), [`W08-3.jpg`](shots/W08-3.jpg) (duo-upright--discover)
- **Source notes:** I7 (in `sources/`)

### W05 · Low · Settings: 'Account' opens a pane titled 'Profile' under three large headings; odd search field; truncated labels

*Settings · checked by hand · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, android-tablet*

- **What:** The highlighted nav item is 'Account', but the pane opens on 'Profile', followed by 'Sign-in' and 'Delete account', all the same large size. House style allows one large heading per page. The 'Find a setting' field is also grey-filled with no search icon, unlike every other search field in the shell.
- **How to see it:** Settings detail pane and search field
- **Screenshots:** [`W05-1.jpg`](shots/W05-1.jpg) (14-settings), [`W05-2.jpg`](shots/W05-2.jpg) (desktop--settings), [`W05-3.jpg`](shots/W05-3.jpg) (desktop-1024--settings), [`W05-4.jpg`](shots/W05-4.jpg) (android-tablet--settings)
- **Source notes:** D28, A24, P24, A23, D27, I29, X17 (in `sources/`)

### W06 · Low · Desktop polish: My apps spread across the width, search against the top bar, carousel cuts its last card, panes ride into the top bar

*Desktop layout · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, ipad*

- **What:** Four icons about 56px wide are justified across the whole column with gaps of about 190px, so the row looks scattered rather than like a grid. At 800, 'Neighbourhood Swap' wraps even though the row has space to spare. A left-aligned grid with fixed spacing would hold together.
- **How to see it:** Home, My apps row
- **Screenshots:** [`W06-1.jpg`](shots/W06-1.jpg) (desktop-1920--home), [`W06-2.jpg`](shots/W06-2.jpg) (desktop--home), [`W06-3.jpg`](shots/W06-3.jpg) (desktop-800--home), [`W06-4.jpg`](shots/W06-4.jpg) (desktop-1024--home)
- **Source notes:** D18, D19, D20, D26, D30, I30, I31, I9 (in `sources/`)

### W07 · Low · The empty Challenges page is a bare line, misaligned with its tabs and unlike Home's empty state

*Empty states · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** The empty state is one grey sentence centred across the page, while the Challenges/Standings control is pinned left. On Home the same empty state is a card with a title and a hint ('No challenges right now / New ones will show up here.'). At 1920 the control sits at the left with nothing beneath it.
- **How to see it:** Challenges / Standings page
- **Screenshots:** [`W07-1.jpg`](shots/W07-1.jpg) (desktop-1920--leaderboard), [`W07-2.jpg`](shots/W07-2.jpg) (desktop--leaderboard), [`W07-3.jpg`](shots/W07-3.jpg) (desktop--home), [`W07-4.jpg`](shots/W07-4.jpg) (safari-phone--leaderboard)
- **Source notes:** D29, P27, A26, I32 (in `sources/`)

### D12 · Low · The Workshop's 'By stage' board breaks out of the page column on desktop

*Project page · reviewer-found, confirm first · seen on: desktop 1440*

- **What:** The board starts left of the 'Workshop' title and runs past the end of its rule, so title and content do not share an edge.
- **How to see it:** #app/book-club-d10610/workshop > Workshop > See all > By stage.
- **Screenshots:** [`D12-1.jpg`](shots/D12-1.jpg) (desk-bc-by-stage)
- **Source notes:** X23 (in `sources/`)

## 7. Copy, polish and platform idioms

### L05 · Medium · Names break mid-word: 'Neighbourh / ood Swap' under Home's tiles, 'Grou / p…' and 'Sign- / up…' on Discover cards

*Text · checked by hand · seen on: phones (app and browser), phone sideways, phone-sideways, safari-phone, android-chrome, android-small*

- **What:** Each card fits an icon, the title and a filled Join pill into about 220 pt. The titles come out as 'Grou / p...' and 'Sign- / up...', and the subtitle as 'Upda...'. You cannot tell what the apps are, and the Join button is the widest thing on the card. Use one column here, or put Join under the title.
- **How to see it:** Home > My apps with 'Neighbourhood Swap'; Discover on a sideways phone
- **Likely cause:** word-break: break-all / overflow-wrap:anywhere on tile labels; card title column too narrow beside the Join button
- **Screenshots:** [`L05-1.jpg`](shots/L05-1.jpg) (iphone-mini--home), [`L05-2.jpg`](shots/L05-2.jpg) (phone-sideways--discover), [`L05-3.jpg`](shots/L05-3.jpg) (after-signin-s), [`L05-4.jpg`](shots/L05-4.jpg) (safari-phone--home)
- **Source notes:** F037, P3, P10, A15, I6 (in `sources/`)

### Y01 · Medium · Audiences are named Public/Private/'Private community' on some screens and Group/Community/Just you on others

*Copy · checked by hand · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** The filter chips read 'Public 2 · Private 1 · Just you 1', and the Hub calls Book Club a 'Private community', but the product's audience names are Just you, Group and Community. Home lists the same things as 'My apps' and 'Discover Communities', Discover says 'ALL APPS', and Communities offers 'Make a project'. Across screens, users see app, project, community, group, private and public for overlapping ideas.
- **How to see it:** Communities filter chips, Hub subtitle, Home and Discover headings
- **Screenshots:** [`Y01-1.jpg`](shots/Y01-1.jpg) (iphone-mini--communities), [`Y01-2.jpg`](shots/Y01-2.jpg) (duo-capsule-crop), [`Y01-3.jpg`](shots/Y01-3.jpg) (desktop--communities), [`Y01-4.jpg`](shots/Y01-4.jpg) (desktop--workshop)
- **Source notes:** D16, P23, A4, I20 (in `sources/`)

### Y02 · Medium · Section headings use three different styles across Home, Discover, Communities, Profile and Hub

*Copy · reviewer-found, confirm first · seen on: desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920, safari-phone*

- **What:** Home puts large bold sentence-case headings over its cards ('My apps', 'Challenges') plus one in Title Case ('Discover Communities'). Discover, Communities, Profile and Hub use small bold uppercase labels ('ALL APPS', 'NEEDS YOU', 'YOUR WORK'). House style is the small uppercase label.
- **How to see it:** Labels above card groups on Home compared with Discover, Communities, Profile and Hub
- **Screenshots:** [`Y02-1.jpg`](shots/Y02-1.jpg) (desktop--home), [`Y02-2.jpg`](shots/Y02-2.jpg) (desktop--communities), [`Y02-3.jpg`](shots/Y02-3.jpg) (desktop--profile), [`Y02-4.jpg`](shots/Y02-4.jpg) (safari-phone--home)
- **Source notes:** D17, P29, I21 (in `sources/`)

### R01 · Medium · Request page: scrolled text and the 'See progress' button show through, sliced, under the sticky title

*Requests · checked by hand · seen on: desktop-800, desktop-1440, desktop-1920, safari-phone, phone, iphone-mini*

- **What:** When the body scrolls, its lines are cut horizontally under the sticky header. At 1920 a second copy of the title 'Let members suggest a book and vote on the next one' appears sliced in half right below the real one. At 1440 a line of the description is cut through the middle. At 800 only a stray grey bar from the quote border is left. The header needs an opaque background with a divider or fade.
- **How to see it:** Request #1, just below the sticky REQUEST #1 header
- **Screenshots:** [`R01-1.jpg`](shots/R01-1.jpg) (ipad--request), [`R01-2.jpg`](shots/R01-2.jpg) (desktop-1920--request), [`R01-3.jpg`](shots/R01-3.jpg) (desktop-1440--request), [`R01-4.jpg`](shots/R01-4.jpg) (desktop-800--request)
- **Source notes:** D21, P8, I33 (in `sources/`)

### D04 · Medium · Notification text is cut mid-word with no '…'; the Unread count disagrees with the dots; times truncate

*Notifications · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** The body is truncated server-side or by character count and shown without '…', so it reads like a typo and hides the instruction.
- **How to see it:** Tap the bell (#notifications-btn); Unread tab, Watering Rota group.
- **Screenshots:** [`D04-1.jpg`](shots/D04-1.jpg) (phone-sheet), [`D04-2.jpg`](shots/D04-2.jpg) (desk-sheet), [`D04-3.jpg`](shots/D04-3.jpg) (phone-all-scrolled), [`D04-4.jpg`](shots/D04-4.jpg) (phone-all)
- **Source notes:** X4, X5, X6 (in `sources/`)

### D05 · Medium · The Report form truncates the child-safety reason

*Safety · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** The most serious category is the only one cut off, on every shape, so its meaning is hidden. Let it wrap.
- **How to see it:** Homeroom menu > Report app.
- **Screenshots:** [`D05-1.jpg`](shots/D05-1.jpg) (phone-report), [`D05-2.jpg`](shots/D05-2.jpg) (desk-report), [`D05-3.jpg`](shots/D05-3.jpg) (phone-report)
- **Source notes:** X12 (in `sources/`)

### G01 · Medium · Android gets iPhone idioms: chevron-in-a-disc back buttons, horizontal ••• menus, pill segmented controls

*Android · reviewer-found, confirm first · seen on: android-small, android-tablet, android-chrome*

- **What:** Discover, chats, Settings, Challenges and project pages use a '<' chevron in a tinted disc. Android's convention is a plain left arrow (Material arrow_back) with no disc, so the app reads as an iOS port.
- **How to see it:** Header, left of the title, on pushed screens
- **Screenshots:** [`G01-1.jpg`](shots/G01-1.jpg) (android-small--discover), [`G01-2.jpg`](shots/G01-2.jpg) (android-small--direct-message), [`G01-3.jpg`](shots/G01-3.jpg) (android-small--settings), [`G01-4.jpg`](shots/G01-4.jpg) (android-tablet--settings)
- **Source notes:** A17, A18, P33 (in `sources/`)

### Y04 · Low · 'All 2 communities' in the sidebar

*Copy · checked by hand · seen on: desktop*

- **How to see it:** Sidebar with two communities
- **Likely cause:** copy template 'All N communities' with small N
- **Screenshots:** [`Y04-1.jpg`](shots/Y04-1.jpg) (desktop-ai)
- **Source notes:** F005 (in `sources/`)

### Y05 · Low · Discover's 'For you' shows a list titled ALL APPS

*Copy · reviewer-found, confirm first · seen on: safari-phone, android-chrome*

- **What:** With 'For you' selected the card is labelled ALL APPS, though Home sends you here from 'Discover Communities'. The rows are very tall: a large gap separates the title from 'Updated 22m ago', and each row has a 44 pt filled Join pill. Only two or three items fit on a phone.
- **How to see it:** Discover, first card
- **Screenshots:** [`Y05-1.jpg`](shots/Y05-1.jpg) (safari-phone--discover), [`Y05-2.jpg`](shots/Y05-2.jpg) (android-chrome--discover)
- **Source notes:** P28 (in `sources/`)

### Y06 · Low · The same person is drawn differently (name format, avatar colour) from screen to screen

*Copy · reviewer-found, confirm first · seen on: safari-phone, android-chrome, phone-sideways*

- **What:** In the DM the sender is 'audit_ben'; in the group the same person is '@audit_ben'. audit_ada's avatar is blue in the hub's 'active this week' row, purple on the request page and pale blue on Profile. Inconsistent name format and colour make one person look like several.
- **How to see it:** Sender names and avatars
- **Screenshots:** [`Y06-1.jpg`](shots/Y06-1.jpg) (safari-phone--direct-message), [`Y06-2.jpg`](shots/Y06-2.jpg) (safari-phone--group), [`Y06-3.jpg`](shots/Y06-3.jpg) (android-chrome--request), [`Y06-4.jpg`](shots/Y06-4.jpg) (safari-phone--profile)
- **Source notes:** P31 (in `sources/`)

### Y07 · Low · Header title and subtitle truncate on a 360px phone

*Copy · reviewer-found, confirm first · seen on: android-chrome*

- **What:** The App tab header cuts 'Neighbourhood Swap' to 'Neighbourhood S...', and the group header subtitle to '3 members · you own this gr...'. The bell and the account chip with its chevron take the space. A two-word project name should fit.
- **How to see it:** Top header
- **Screenshots:** [`Y07-1.jpg`](shots/Y07-1.jpg) (android-chrome--hub-open), [`Y07-2.jpg`](shots/Y07-2.jpg) (android-chrome--group)
- **Source notes:** P30 (in `sources/`)

### R02 · Low · Request threads use internal words ('created issue'), say '1 reply' over five entries, and restate the plan four times

*Requests · checked by hand · seen on: all, desktop-800, desktop-1024, desktop, desktop-1440, desktop-1920*

- **What:** The divider says '1 reply' but five entries follow. The first event reads 'audit_ada created issue' although the product calls these requests. The request title ('...a book and vote on the next one') and the plan and change title ('...books and vote on the next read') differ, and the change is numbered '#3' on request '#1'. It is hard to tell which thing is which.
- **How to see it:** Request thread timeline: 'audit_ada created issue: …(#1)'; plan also in the waiting card, the waiting-on-you card, the plan row and the timeline
- **Likely cause:** timeline copy from the GitHub-era event names
- **Where to look:** src/routes/issues.js ~line 1746: `${username} created issue: "…"`
- **Screenshots:** [`R02-1.jpg`](shots/R02-1.jpg) (desktop-after-build-it), [`R02-2.jpg`](shots/R02-2.jpg) (desktop--request), [`R02-3.jpg`](shots/R02-3.jpg) (desktop-1024--request), [`R02-4.jpg`](shots/R02-4.jpg) (safari-phone--request)
- **Source notes:** F009, F010, D23, P16, A11, I17 (in `sources/`)

### D08 · Low · A request's More actions sheet mixes emoji and text glyphs as icons; Workshop's orange 'Couldn't take the screenshots' offers no next step

*Requests · reviewer-found, confirm first · seen on: phone 393 (app)*

- **What:** Colour emoji (🏷, 🔕) sit beside monochrome glyphs, in colours (red, orange) that do not mean anything. Every other sheet uses the line icon set (for example the hub ••• sheet).
- **How to see it:** #app/book-club-d10610/dev/issues/1 > More actions (•••).
- **Screenshots:** [`D08-1.jpg`](shots/D08-1.jpg) (phone-request-more), [`D08-2.jpg`](shots/D08-2.jpg) (phone-bc-hub)
- **Source notes:** X13, X24 (in `sources/`)

### D10 · Low · A stray blue caret under the chosen Appearance option; focusing Bio in Edit profile scrolls its label under the sheet's edge

*Settings · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** A small triangle pokes out below the control's border with nothing attached. It reads as a broken tooltip arrow.
- **How to see it:** #settings/theme; or Homeroom menu > Suggest an improvement > Got it > Form.
- **Screenshots:** [`D10-1.jpg`](shots/D10-1.jpg) (phone-theme-caret), [`D10-2.jpg`](shots/D10-2.jpg) (phone-appearance), [`D10-3.jpg`](shots/D10-3.jpg) (phone-form), [`D10-4.jpg`](shots/D10-4.jpg) (phone-edit-bio-typed)
- **Source notes:** X16, X28 (in `sources/`)

### D11 · Low · Discover's Filters has a Type section with a single chip, 'Other'

*Discover · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** A filter group with a single 'Other' option filters nothing useful and looks unfinished.
- **How to see it:** #apps > Filters.
- **Screenshots:** [`D11-1.jpg`](shots/D11-1.jpg) (phone-discover-filters-clean), [`D11-2.jpg`](shots/D11-2.jpg) (desk-discover-filters)
- **Source notes:** X22 (in `sources/`)

### D15 · Low · Opening the Homeroom menu logs a snapdom warning every time

*Console · reviewer-found, confirm first · seen on: phone 393 (app), desktop 1440*

- **What:** Opening the menu logs '[snapdom] Text in inline/table-cell elements kept its natural width…', so a page snapshot runs on every open (a cost even if never used). In the app shape every load logs '[native-chrome] native session establishment failed: This Homeroom app version must be updated for secure sign-in', and Settings > Homeroom app shows a red 'Could not load Homeroom app settings'. That is likely because the bridge is emulated here, but worth confirming on a real build. No console errors or exceptions were seen; the only HTTP failure was the leaderboard 404.
- **How to see it:** Open the Homeroom menu on any screen; open #settings/usernode in the app shape.
- **Screenshots:** [`D15-1.jpg`](shots/D15-1.jpg) (desk-menu), [`D15-2.jpg`](shots/D15-2.jpg) (phone-homeroom-app)
- **Source notes:** X30 (in `sources/`)

