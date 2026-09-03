# App feedback triage — 2026-09-03

115 feedback items from testing, each with a short product-level action. Original numbering kept.
Updated same day with review decisions: all DECIDE calls are resolved and folded into the actions.

**Legend**
- **✅ Fixed** — already resolved since the feedback was taken: #60, #73.
- **❌ Won't do** — decided against: #13, #25.
- **❓** — action is a best guess; open question at the bottom: #42, #47, #51 (+ a wording check on #84).
- **Needs more information** — parked until we know more (section below the table): #43, #44, #52, #114.
- **Area = Game Corner** — fixes belong inside that app (via its own improve flow), not the platform. Same for the broken third-party apps in #9.

| # | Feedback | What to do | Area |
|---|----------|------------|------|
| 1 | Signing in via the app is buggy / may not work right now. | Reproduce and fix mobile-app sign-in end to end. Release blocker. | Mobile app |
| 2 | Opportunity for the app to just be a progressive web app you add from Safari, as well as an app you install? To look at after the meeting. | Confirmed it already works as a PWA — make "Add to Home Screen" the primary install path while the app isn't on the App Store. | Mobile app |
| 3 | On browser, after you close the install app link, goes away forever? Maybe should reappear on refresh? | Re-show the dismissed install banner next session. | Mobile web |
| 4 | On browser, where does the install app link go right now, since it's TestFlight? | Don't show the install-app link at all until the app is on the App Store; push the PWA path (#2) instead. | Mobile web |
| 5 | In the email, would be better to write code near the top, maybe in bigger font size. | Move the code to the top of the email and render it in large type. | Emails |
| 6 | In "want it sooner" screen, since we require https:// prefix, add it automatically instead of marking url without it as a wrong url. | Auto-prepend `https://` instead of rejecting the URL. | Waitlist |
| 7 | In the browser (mobile chrome) version, when I scroll down, url bar stays there so it never enters full screen like with other pages. | Make scrolling collapse the browser chrome (Chrome URL bar, Safari bottom bar) like a normal page, so the app goes full screen. Covers #14. | Mobile web |
| 8 | No way to search/filter the apps. | Add search and basic filters to the apps directory. | Discover |
| 9 | Blank screen for live translation and gym tracker apps. | Fix the two apps or pull them from the directory until they load (feeds #12 curation). | Apps |
| 10 | "Back" android action does nothing when on the page. Expect it to exit the app and go to dashboard when the app is open. | Wire Android back: inside an app → dashboard; on dashboard → exit. | Mobile app |
| 11 | Work quest app "something went wrong loading the screen - not authenticated". Such apps requiring auth used to be behind "lock", but it's confusing when you can open it but it doesn't work - actually number guessing game still has that lock, so functionality is there. | Reapply the existing "lock" treatment to every auth-required app so none opens into an error. | Discover |
| 12 | Ideally most of our top apps should have an app icon and should work. Maybe even separate them from not working/demo-only apps (maybe even hide them, with a possibility to show on expand). | Curate: top apps get icons + verified working; demote demo/broken apps below them (behind "show more"), don't hide them. | Discover |
| 13 | We should block emails containing such trickery we are now using with "+test" for distinct accounts. | ❌ Won't do — plus-addressing has legitimate uses; leave it allowed. | Auth |
| 14 | On other apps, the URL on Safari at the bottom of the screen shrinks when you scroll, here it doesn't, but would be nice if it did here too. | Merged into #7 (same fix, Safari case). | Mobile web |
| 15 | Logout on app doesn't redirect the screen back to the landing / start page, but should. | Redirect to the landing/start page on logout. | Auth |
| 16 | We should decide what the start page on the app should look like – on web we were saying the landing page, but maybe should be something else on mobile. | Build a separate, mobile-native logged-out landing page for the native app + PWA; mobile browser keeps the default landing page. | Mobile app |
| 17 | Refreshing the page, the spinner is half under the header and has too much whitespace under it. | Position the refresh spinner fully below the header with balanced spacing. | Core UI |
| 18 | Country selection should be alphabetical, not grouped by region, to match other apps (couldn't find Switzerland at first). | One alphabetical country list; drop region grouping (do together with #102). | Waitlist |
| 19 | Can we make the confirm your email step happen as a part 2 to joining the waitlist? So after you click join waitlist, it just says great you're on the waitlist, and then confirming your email is a part 2? | Yes — show "you're on the waitlist" immediately on join; email confirmation becomes an explicit step 2. | Waitlist |
| 20 | On the waitlist, Selector outlines disappear when clicked on iOS safari. | Fix selection styling on iOS Safari so chosen options keep a visible outline. | Waitlist |
| 21 | Can the long-form text boxes, eg the one after "ever had a tool you relied on get killed, paywalled, or ruined", expand vertically for more text, not just horizontally? | Make long-answer fields multiline and auto-grow vertically. | Waitlist |
| 22 | Confirm your email screen in the waitlist flow is not optimal. Text confusing. There are 2 ways of validating an email address. Should be discussed. | Consolidate to one verification method and rewrite the screen around it (with #19, #31, #39). Sub-choice open: link vs. code — rec code, consistent with #29/#39. | Waitlist |
| 23 | Should the X / github linking open in a new tab or something? Easy to lose the waitlist page maybe on mobile since you have to go back to get it? | Open linking in a new tab/popup so the waitlist page isn't lost (largely moot once #24 is fixed). | Waitlist |
| 24 | The redirect from X / github linking goes to the landing page, so you lose all of your waitlist progress. | After OAuth, return to the waitlist page with all progress intact — never the landing page. | Waitlist |
| 25 | "Only let me in when at least one person from my link gets in too". Should we have this? | ❌ Won't do. | Waitlist |
| 26 | After submitting answers to the optional list, change "Answer them now" to "Edit my answers"? | Yes — switch the CTA to "Edit my answers" after submission. | Waitlist |
| 27 | Maybe instead of just one "Want in sooner / answer them now", we should have 3 boxes for things that can move you up the list? That might be easier for users to digest & also see the summary of their progress doing things on the list. | Yes — ~3 "move up the list" cards (answers, socials, referrals) with done-states doubling as a progress summary. | Waitlist |
| 28 | It would also be nice if the "you're on the list" waitlist page showed the email address registered with. | Show the registered email on the "you're on the list" page. | Waitlist |
| 29 | If trying to join the waitlist from another device, have a way to go to "show my waitlist status"? Enter an OTP from email to see waitlist status privately. | Add "check my status": enter email → OTP → view status from any device. | Waitlist |
| 30 | On the questions for the waitlist, it allows users to submit all empty ones. | Require at least one non-empty answer (or disable submit until then). | Waitlist |
| 31 | Email to confirm the email address to be reviewed / improved. | Rewrite the confirmation email: short, branded, one clear CTA (depends on #22). | Emails |
| 32 | Text heavy - too much reading - waitlist and want in sooner. | Cut copy across both screens to scannable cards/bullets (with #27, #33). | Waitlist |
| 33 | Want in sooner screen to be reviewed / improved. | Redesign want-in-sooner around the #27 checklist, with far less text. | Waitlist |
| 34 | Connect github / X not working anymore on Mobile app. The buttons do not trigger the connect window. | Fix: connect buttons in the mobile app must open the auth flow (currently no-ops). | Mobile app |
| 35 | https://social-vibecoding.usernodelabs.org/#admin/waitlist should be improved. Not clear what release means. Display the useful cols / details. | Rework the admin waitlist view: define/rename "release"; show the useful columns (status, referrals, answers, dates). | Admin |
| 36 | Your Usernode access is ready email should be improved. It redirects to signup link but when clicking on it we see the home page instead. (WORKED WELL FROM MOBILE). We should add a link in the app to make it easier. | Fix the signup link to land on signup on desktop too; refresh the email; add an in-app entry for invited users. | Emails |
| 37 | In the waitlist, in the extra questions, connecting to GH closes the form. | Fix: GitHub connect must preserve the questions form and its answers. | Waitlist |
| 38 | When getting outside creating a new app dialogue (the one showing new app progress), cannot find it anymore; eventually the app appears at my apps. | Keep a "building…" card with live status visible in My Apps after the dialog closes. | Create/fork |
| 39 | Clicking the get started #signup link in the your usernode access is ready email brings up a page which says to enter an OTP – doesn't get sent until pushing the "email me a code" button, but page implies it would be sent without doing that. Maybe reaching that page should send it, with a timeout on sending it again? And page should auto-fill email from the link too (link should include the signup email prefilled). | Arriving from the email link auto-sends the code (with resend cooldown) and pre-fills the email from the link. | Auth |
| 40 | Forking apps is broken (general Error message). After a while the fork works but it shows the starter template instead of the forked app. | Fix forking: no generic error, and the result must be the forked app, never the starter template. | Create/fork |
| 41 | At first login, update the text of the Terms and conditions dialog to remove token related things. | Strip token-related language from the first-login terms dialog. | Auth |
| 42 | There is a section in the admin to flag users as BPs but there is no way on how to use it / request it from the application. | ❓ Wire the BP flag to something user-facing (request/benefit) or remove the toggle. See question below. | Admin |
| 45 | In profile: Update token allocation section to not confuse users. | Rewrite or hide the token-allocation section until it's meaningful (align with #41). | Settings |
| 46 | Discover / Browse all apps -> Add button confusing. Not sure it makes sense for endusers, may be we have to rename it. | Rename to something self-explanatory ("Add to my apps"); likely removed anyway when #57 lands. | Discover |
| 47 | Settings crowded. Not sure if there is a way to simplify. | ❓ Regroup Settings into a few sections; move rarely used items under "Advanced". See question below. | Settings |
| 48 | Email format should be the same and should be updated to reflect the new brand. | One branded email template (logo, tone, footer) applied to every send. | Emails |
| 49 | Settings -> Language selection -> changing a language does not change anything in the app. The app does not support multi-lang. | Hide the language selector (or mark "coming soon") until multi-language exists. | Settings |
| 50 | Profile connect github works but lacking confirmation at the end of the flow. | Add an explicit success state at flow end (toast + "Connected" badge). | Settings |
| 51 | Link with a usernode wallet from Mobile not intuitive. | ❓ Turn mobile wallet linking into a guided step-by-step flow. See question below. | Settings |
| 53 | In https://social-vibecoding.usernodelabs.org/#admin/users toggle podium is confusing. | Rename "toggle podium" and add a tooltip stating exactly what it changes. | Admin |
| 54 | Create app says: ask admin to enable app creation. Change to 2 allowed apps but still not able to create an app. Works well for admin user. | Fix the allowance bug; give all users 2 apps by default; show your allowance clearly (#108); add a "request more" button admins see; notify users when their allowance changes. | Create/fork |
| 55 | Seems notifications are not working anymore on the latest build but not sure. | Verify notifications on the latest build; fix the regression if confirmed. | Core UI |
| 56 | Maybe after you sign in the first time, we should have some kind of welcome banner that you can dismiss, that explains what is going on? | Yes — add a dismissible first-login welcome banner explaining the platform and first steps. | Core UI |
| 57 | Clicking an app in discover opens the app immediately, maybe instead it should go to the browse app page for that app, where you can add it, see info about it, etc? And then we can remove the + buttons on all of the apps there too. | Yes — tap opens the app's detail page (info, add) instead of launching; drop the per-card + buttons. | Discover |
| 58 | The challenges area, we have 9 initial onboarding challenges – feels like too many, maybe we should have like 3? And then you unlock a few persistent challenges that are there now (like prove your identity), as well as the weekly ones. | Yes — cut onboarding to ~3, then unlock persistent + weekly challenges. | Challenges |
| 59 | Right now your username I think is your email address, which we shouldn't do? Probably not great to disclose that to other users by default, we should have you setup a username on login. | Add username setup at first login; never default the public name to the email. Privacy — prioritize. | Auth |
| 60 | When changing username, I just get "saving…", changing username should gray out during that time. | ✅ Fixed since. | Settings |
| 61 | When changing your username, clicking back should go back to profile, not back to settings. | Back from the username editor returns to profile. | Settings |
| 62 | In iOS Safari, when opening / closing a dialogue, the app background and platform background shading fade out in / back out at different times. | Sync the two fade animations on dialog open/close in iOS Safari. | Core UI |
| 63 | When adding an app to your apps, app doesn't appear until page is refreshed. | Show the added app in My Apps immediately, no refresh (same root as #111). | Discover |
| 64 | When refreshing a page, the search bar momentarily disappears causing a UI jump. | Reserve the search bar's space during load so the layout doesn't jump. | Core UI |
| 65 | The header is slightly different on the browse page and the home page, causing some UI popping in/out. | Unify the header across browse and home so nothing pops on navigation. | Core UI |
| 66 | Apps on the discover page say "x to vote" on them, kind of confusing what that means. | Replace "x to vote" with a clearer label or tooltip explaining group voting (or drop it on discover). | Discover |
| 67 | Header has rounded edges which is nice, but should probably be slightly more rounded to be more intentional? Also cuts out on apps, at some point there is still a gray horizontal line not matching the background of the app. | Slightly increase header radius; fix the gray line where the header meets app backgrounds. | Core UI |
| 68 | Game corner has no transitions, doesn't feel mobile. | Add screen transitions so navigation feels native. | Game Corner |
| 69 | Game corner app has horizontal scroll issue on the profile page. | Fix horizontal overflow on the profile page. | Game Corner |
| 70 | Game corner app overexplains itself in the header. | Cut the header self-explanation to a line or less. | Game Corner |
| 71 | Game corner app's header is way too big; probably would be better as tabs at the bottom, since there already is the platform header. | Replace the oversized header with bottom tabs — the platform header already exists. | Game Corner |
| 72 | Game corner games are hard to find, should be grid maybe? And right now all of the games way below the fold. | Show games as a grid at the top, above the fold. | Game Corner |
| 73 | Would be nice to have a pin button on game corner games to save them / push them to the top. | ✅ Fixed since. | Game Corner |
| 74 | If you scroll on game corner games, and your scroll starts on a button (eg daily on a game) then that gets pushed after you let go. | Scrolls that start on a button must not trigger it on release. | Game Corner |
| 75 | Game corner game pages after you click them should be one page wherever possible, and not require scrolling; also start at the top of the page in any case. | Fit game pages to one screen where possible; always open at the top. | Game Corner |
| 76 | How to play and game chat should be more prominent on game pages. | Elevate "How to play" and game chat on game pages. | Game Corner |
| 77 | When you win a game on gamecorner, there is way too much going on, with the points, the badges, and leaderboard with lots of scrolling. Should feel more like an arcade game. | One arcade-style win moment; move points/badges/leaderboard behind it. | Game Corner |
| 78 | When pulling down on game corner page, get white space where the page gets pulled down. Should keep the background color above and below the page when overscrolling. | Match the overscroll background to the page color, top and bottom. | Game Corner |
| 79 | The kudos text should be shorter when giving feedback (maybe just "encourages someone to take up and solve this issue"). | Shorten the kudos helper text as suggested. | Feedback |
| 80 | Maybe after you give your first feedback, you should be (a) congratulated for giving your first feedback, and (b) prompted to either try making a fix yourself, or going to the board to see all of the other current issues for this app? | Yes — first-feedback moment: congratulate, then offer "try a fix yourself" or "see this app's board". | Feedback |
| 81 | In the activity view, the reply button should grow vertically as I type more text, and have an arrow next to it to send. | Auto-grow the reply box vertically; add a send arrow. | Feedback |
| 82 | In the activity area, recent comments for items should be shown. | Show recent comments inline on activity items. | Feedback |
| 83 | Sign in with email doesn't work if I have already created a password. | Fix: email sign-in must work for accounts with a password (route to password entry or still send the code). | Auth |
| 84 | When resting a proposal, the chat sending / configuring background at the bottom and header at the top are the same color as the chat area, is confusing. The top header changes color to white when I scroll down, but it should also always be white. | Give composer and header distinct backgrounds from the chat area; keep the header white at all scroll positions. | Dev screen |
| 85 | The top header in the dev screen should also have the curved radius in the bottom left and right corners, to match the platform header. | Round the dev-screen header's bottom corners to match the platform header. | Dev screen |
| 86 | The chat model selector is longer than it needs to be, it and the $ amount could be on one line but it's not. | Compact the model selector so it and the $ amount share one line. | Dev screen |
| 87 | The current line item spinner overlaps with a moving … on the dev screen, we should have one not both, and they shouldn't overlap. | Keep exactly one progress indicator (spinner or dots), never overlapping. | Dev screen |
| 88 | Claude code items should be by default collapsed, not opened. | Collapse work items by default; expand on tap. | Dev screen |
| 89 | Default code editor should be openrouter with GLM 5.3 Flash. | Make OpenRouter GLM 5.3 Flash the default now; add per-model average-cost monitoring if it doesn't exist. | Dev screen |
| 90 | Clicking on the usernode -> claude selector at the top while the model is thinking doesn't do anything. | Make the selector work mid-generation, or show it visibly disabled while thinking. | Dev screen |
| 91 | The "building" button in the dev chat header looks like it should be clickable, because it matches the improve button, but it isn't. | Restyle "Building" as a status chip so it stops looking like a button. | Dev screen |
| 92 | The first time a user uses the dev chat, it should explain how you can leave this page and come back – and how you can click improve anytime to see the status of your session. | Add a first-use explainer: you can leave and return; Improve shows session status anytime. | Dev screen |
| 93 | After you start a session, improve shows no changes in progress when clicked. Shows up the next time you open it seemingly. | Fix: a just-started session appears in Improve immediately. | Dev screen |
| 94 | Sessions in progress in the improve tab should show a spinner, like with the other in-progress UI elsewhere on the platform. | Use the platform's standard spinner on in-progress sessions in Improve. | Dev screen |
| 95 | The tab (app / board / activity) looks weird when you're in a session, since none are selected. | Give the in-session state its own selected indicator in the tab row. | Dev screen |
| 96 | The improve menu should show a little icon for what game you are in in the top left. | Show the current app's icon in the Improve menu's top left. | Dev screen |
| 97 | The token spend amount should update as claude code works, not just at the end of each turn. | Update token spend live during the turn. | Dev screen |
| 98 | When creating a new change and going through quick check before putting plan together, selecting "use the suggested defaults" does nothing, "send answers" does nothing - not able to continue. | Fix: both quick-check buttons must advance the flow. Blocker. | Dev screen |
| 99 | "Propose to group" button is still clickable after proposing (should be disabled and say "already proposed"). | Disable after proposing; relabel "Already proposed". | Dev screen |
| 100 | When creating feedback, entering descriptions is required otherwise submit does not work; there is no indication in UI this is the case. | Mark description required with inline validation (or make it optional) — no silent dead submit. | Feedback |
| 101 | Project URL forces you to add http:// which is a bit annoying. | Auto-prepend the protocol wherever URLs are entered (same rule as #6). | Core UI |
| 102 | Uruguay missing from the countries list (so probably others too) - Update the list of countries. | Replace with a complete standard (ISO) country list, alphabetical (with #18). | Waitlist |
| 103 | There is no way to make passwords visible when typing them. | Add a show/hide toggle to all password fields. | Auth |
| 104 | Instructions for setting up your own Claude/ChatGPT are too long, maybe some link could be provided to Claude/ChatGPT so that they imported the instructions to the chat? Would avoid the need for the back-and-forth. | Add a one-click "open in Claude/ChatGPT" link that pre-loads the instructions, replacing the long copy-paste. | Settings |
| 105 | On browser, login screen appears again although never logged out. When trying to sign in, an error message appears saying "Sign out before signing in again" (and there is no way to do that because settings cannot be accessed to sign out). | Fix the dead end: auto-clear the stale session and let sign-in proceed; never demand an unreachable sign-out. | Auth |
| 106 | If going to "CLI & coding-agent access", it says there are no credentials, but doesn't state how/where to add them. | Add "how to add credentials" guidance with a direct CTA on the empty state. | Settings |
| 107 | When the improve task finished, the notification number (1) is on the improve pill, rather than on the bell icon - this prompts the user to click on the improve button again, not finding the notification. | Put completed-task badges on the bell, not the Improve pill. | Core UI |
| 108 | We should be able to see somewhere our app limit and how long until it is reset. | Show app limit, usage, and reset time (create dialog and/or settings); folded into #54's allowance work. | Create/fork |
| 109 | Long bio string rendering doesn't wrap. | Wrap long bio text. | Settings |
| 110 | On mobile, to save space in the app chip, try using emojis for board / draft / activity instead of "draft / board / activity". | Try icons/emoji in place of the word labels in the app chip on mobile. | Core UI |
| 111 | Added an app to apps, it shows up in the homescreen, but not in the apps list in the app chip. Maybe the whole page needs to be refreshed first? | Refresh the app chip's list when an app is added (same root as #63). | Core UI |
| 112 | Under the plus button on the board, would be nice for options to use the same format as elsewhere in the app (eg under the app chip), and have icons. | Restyle the board "+" menu to match the app-chip menu pattern, with icons. | Feedback |
| 113 | Remove the hamburger on each app in your apps, instead use long press to make the menu show up (and have the menu off of the app like in iOS / android, not a pop up below menu). | Replace the per-app hamburger with a long-press context menu anchored on the app tile, native style. | Core UI |
| 115 | UI on mobile is overall cramped, but that's my personal opinion. I would not use this on mobile at all (I prefer the browser version, where I can see more :) ). | Log as a design theme (noted as opinion): audit spacing/density across mobile screens, no single fix. | Core UI |

## Needs more information (parked)

| # | Feedback | What we need before acting |
|---|----------|----------------------------|
| 43 | App dropdown menu confusing. | Specifics on what confuses (labels, contents, discoverability) before changing anything. |
| 44 | Improve menu confusing. | Specifics on what confuses; the concrete Improve fixes (#93–#96, #107) proceed independently. |
| 52 | I don't see versions anymore. | This area has churned back and forth already — pin down where versions should live and what changed before touching it again. |
| 114 | Asking for notifications permissions every time a change is proposed or started. | Repro details (platform/browser, exact trigger) before fixing. |

## Open questions (the ❓ rows)

- **#42** — What does "BP" stand for, and what should the flag actually gate or grant?
- **#47** — Settings: anything you'd remove outright, or is regrouping enough?
- **#51** — Wallet linking: at which step does it currently lose people?
- **#22** — Which canonical verification method: link or code? (rec: code, consistent with #29/#39)
- **#84** — "When resting a proposal" — assume this means *reviewing/creating* a proposal?
