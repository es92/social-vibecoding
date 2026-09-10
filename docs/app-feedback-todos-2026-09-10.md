# App feedback triage — 2026-09-10

49 feedback items from the latest testing round (48 numbered + share links, numbered #49 here). Compound items are split into lettered sub-rows (2a, 2b, …) — 98 rows total. Each action is written to stand alone: it names the screen/element, so a row is actionable without the feedback column.

**Legend**
- **DECIDE** — open product call; a recommendation is given, review confirms: #2a, #24b, #26b, #29c, #34a.
- **❓** — action is a best guess; open question at the bottom: #3, #17, #20.
- Carried-over repeats from the 2026-09-03 triage (`docs/app-feedback-todos.md`): #32c (↔ 9/3 #62), #41b (↔ 9/3 #64), #46 (↔ 9/3 #34/#50), #48 (↔ 9/3 #89).

| # | Feedback | What to do | Area |
|---|----------|------------|------|
| 1a | Switch to app.onhomeroom.com (since my.onhomeroom.com is confusing grammatically). | Move the platform domain from my.onhomeroom.com to app.onhomeroom.com, with redirects from the old domain; recheck share-link certs (#49) after. | Branding |
| 1b | Update appchip name and all instances/weos references to Homeroom. | Rename every weos/instance reference across the platform, and the app chip label, to Homeroom. | Branding |
| 1c | Update the app icon + name to the new ones. | Ship the new Homeroom app icon and name everywhere they appear (PWA manifest, native app, platform). | Branding |
| 2a | Landing page from PWA and mobile app should possibly match sign in with a join button, or have a short 1-line pitch linking out (check apps like Aave). | **DECIDE** the logged-out landing for the PWA/mobile app: rec a sign-in-style screen with a Join-waitlist CTA plus a one-line pitch linking out (Aave-style reference). | Waitlist |
| 2b | Landing page/step 1 is text-heavy and needs rewriting/simplification ("Describe the app you want in chat…"). | Rewrite the text-heavy waitlist landing / step-1 copy (the "Describe the app you want in chat…" screen) down to a few scannable lines. | Waitlist |
| 2c | Back button overlaps text in step 1. | Fix the back button overlapping the text on waitlist step 1. | Waitlist |
| 2d | #waitlist?confirm=1 should be 2 steps instead of 1. | Split the waitlist email-confirm screen (#waitlist?confirm=1) into two steps instead of one. | Waitlist |
| 2e | Missing space before "Optional" next to country name, and format/spacing for "*" needs improvement. | On the waitlist country field, add the missing space before "Optional" and clean up the required-asterisk ("*") formatting. | Waitlist |
| 3 | App theme background color looks skin-colored vs solarized-light. | ❓ Retune the app theme background away from the skin-toned tint toward a true solarized-light. See question below. | Core UI |
| 4 | No quick or easy way to logout. | Add an easy-to-find logout (profile/menu), reachable in one tap from anywhere in the app. | Auth |
| 5 | Confirmation email ("confirm your email") is not being received. | Fix delivery of the "confirm your email" message end to end (sending, provider, spam placement) — it currently never arrives. Waitlist blocker. | Emails |
| 6a | Initial homepage load on mobile is very slow every time the app opens. | Profile and cut the mobile homepage's cold-start load so every app open is fast, not just the first install. | Performance |
| 6b | Opening other apps from the homepage is slow. | Cut the latency of opening apps from the homepage (preload/warm app containers where possible). | Performance |
| 6c | Spinning up/creating new apps takes very long (5+ mins or stuck in "spinning up"). | Fix app provisioning so creating a new app drops from 5+ minutes toward seconds and never sticks in "spinning up"; show honest progress meanwhile (ties #10). | Performance |
| 6d | Pulling up the keyboard on Android has low FPS / laggy animation. | Fix the low-FPS keyboard open/close animation on Android. | Performance |
| 7a | Expanding/clicking cards across Workshop vs other views is inconsistent—Workshop shows extra controls like "Reply" input, "Open on its own page", and recent comments while other views do not. | Unify cards on one component so every view (Workshop and elsewhere) gets the same controls: Reply input, open on its own page, recent comments. | Workshop |
| 7b | Clicking a card in Workshop opens it in a padded container (card itself shouldn't be padded). | Remove the padding on the container Workshop opens a clicked card into — the card should sit flush. | Workshop |
| 7c | Cards have duplicate "Open" and "Open on its own page" buttons. | Merge the duplicate "Open" and "Open on its own page" card buttons into one Open action. | Workshop |
| 7d | Opening a card on your own session navigates to the session instead of opening the card view. | When a card is about your own session, clicking it should open the card view (with a link to the session inside), not navigate to the session. | Workshop |
| 8 | Working directly from Codex shows up on the platform as a Claude session. | Track and display each session's actual provider — a Codex-driven session must show as Codex, not Claude. | Sessions |
| 9 | When working on proposals with multiple iterations, the "proposal" button only displays after the first iteration rather than staying at the bottom. | Keep the "proposal" button persistently at the bottom of multi-iteration proposal sessions, instead of appearing only after the first iteration. | Sessions |
| 10 | Creating a new app results in a "net::ERR_CONNECT_RESET" error on its iframe when opened. | Fix new-app provisioning/routing so a just-created app's iframe loads instead of net::ERR_CONNECT_RESET (likely same root as #6c). | Create/fork |
| 11a | "Building with your own tools" guide is not working well with Codex. | Walk the "Building with your own tools" guide end to end with Codex and fix the steps that break. | Integrations |
| 11b | Instructions for setting up MCP are missing for Codex or other agents. | Add MCP setup instructions for Codex plus a generic variant for other agents (only Claude is covered today). | Integrations |
| 11c | Claude MCP instructions are present but currently broken. | Fix the existing Claude MCP setup instructions — currently broken. | Integrations |
| 12a | All apps are currently locked under "account required" (even ones that didn't previously require an account). | Restore per-app access rules: only apps that truly require an account get the "account required" lock, not everything. | Auth |
| 12b | Logged-in waitlist users still cannot use any apps. | Give logged-in waitlist users access to use apps. | Auth |
| 12c | In Workshop view, replace "app is locked" with a general message explaining who can build on the app. | In Workshop, replace the "app is locked" notice with a general message explaining who can build on the app. | Workshop |
| 13 | There is no way to delete a test app. | Add a way to delete your own (test) apps, with a confirm step. | Create/fork |
| 14 | When failing to load main/directory apps, it displays a generic "failed to load the apps" / "Couldn't reach the app directory" message that needs customized UI/UX alignment. | Replace the generic "failed to load the apps" / "Couldn't reach the app directory" text with a branded error state (plain-language copy, retry CTA); root cause tracked in #22. | Core UI |
| 15 | The option to "create an issue" directly on the board is missing (currently under give feedback). | Add a "create an issue" option directly on the board, instead of only inside the give-feedback flow. | Workshop |
| 16a | The "Reply in thread" input appears disconnected from the page on desktop browsers. | Visually attach the "Reply in thread" input to its thread on desktop — it currently floats disconnected from the page. | Workshop |
| 16b | Reply input is missing on workshop cards tapped under "needs your vote". | Render the reply input on Workshop cards opened from "needs your vote" — it's missing there. | Workshop |
| 17 | Improve UI/UX around "assigned" versus "claim". | ❓ Make "assigned" vs "claim" visually distinct on board/Workshop items: a clear "assigned to X" label vs. one obvious Claim action on unclaimed items. See question below. | Workshop |
| 18 | Opening a session no longer shows action buttons (e.g., archive). | Restore the action buttons (archive, etc.) that used to show when opening a session — regression. | Sessions |
| 19 | Formatting differs between dev session and new session pages (one is full page, the other is not). | Unify the dev-session and new-session pages on one layout (rec: full page for both). | Sessions |
| 20 | Previews are sometimes inaccurate and fail to reflect features that have been worked on. | ❓ Make session previews reliably rebuild from the session's latest state so worked-on features actually show. See question below (need repro examples). | Sessions |
| 21 | Remaining voting time is no longer displayed on tasks, making merge/discard status unclear. | Restore the remaining-voting-time display on tasks so merge/discard timing is clear — regression. | Workshop |
| 22 | SV APIs used to fetch app directory data are broken/incompatible (e.g. "Couldn't reach the app directory — try again in a moment"). | Fix/re-version the platform APIs apps use to fetch app-directory data (Appraise's "Couldn't reach the app directory" is the repro); add a compatibility guarantee for app-facing APIs. | Infra |
| 23 | Recipe bot requests permission to use AI with no visible prompt or option to grant permission. | Show a visible grant/deny prompt when an app requests AI permission (recipe bot is the repro — today it asks with no way to grant). | Apps |
| 24a | Single-page create-app dialogue should use the new pane styling. | Restyle the create-new-app dialog in the new pane styling. | Create/fork |
| 24b | Dialogue shows all choices at once; consider fewer choices or multi-step flow to avoid feeling overwhelming. | **DECIDE** the create-new-app flow shape: rec multi-step with fewer choices per step, instead of one page showing every choice at once. | Create/fork |
| 25 | Improving existing app triggers API Error 400 (Claude Code 2.1.245 does not support model; version 2.1.251+ required). | Upgrade the platform's Claude Code runner to ≥ 2.1.251 — 2.1.245 400s on the current model when improving an app. Blocker. | Infra |
| 26a | "Show more" only exists for "recommended" apps, while other sorting options show all. | Make directory pagination consistent: every sort option gets "Show more", not just "recommended". | Discover |
| 26b | Consider adding a card/prompt in Discover for empty state ("nothing featured right now, browse the directory?"). | **DECIDE** (rec yes): add a Discover empty-state card — "nothing featured right now, browse the directory?" | Discover |
| 27a | Challenges are missing icons. | Add an icon to each challenge. | Challenges |
| 27b | Missing top padding above completion status line. | Add the missing top padding above the challenge completion-status line. | Challenges |
| 27c | Change "Open Leaderboard" link to "Open challenges" and add chevron arrows. | Rename the "Open Leaderboard" link to "Open challenges" and add chevron arrows. | Challenges |
| 27d | Reorganize Leaderboard/Challenges: Challenges -> Kudos -> Leaderboard, remove "Event/pre season 2" text and "See where season stands", use homepage styling and simplify Leaderboard standings view. | Reorganize the section to Challenges → Kudos → Leaderboard; remove the "Event/pre season 2" and "See where season stands" text; restyle to homepage patterns and simplify the standings view. | Challenges |
| 27e | Tapping a challenge should give responsive click feedback and navigate directly to that dedicated challenge page. | Give challenge taps responsive press feedback and navigate directly to that challenge's dedicated page. | Challenges |
| 28a | Mobile panes (Notifications, Improve, App chips) still use old styling. | Apply the new pane styling to the mobile Notifications, Improve, and app-chip panes (still on the old styling). | Mobile |
| 28b | Browse all apps page needs new pane styling. | Apply the new pane styling to the browse-all-apps page. | Mobile |
| 28c | Back navigation from browse all apps shows overlapping app chips during animation. | Fix the back-navigation transition from browse-all-apps so app chips don't overlap during the animation. | Mobile |
| 29a | Workshop summary text erroneously repeats app stats. | Fix the Workshop summary text erroneously repeating the app stats. | Workshop |
| 29b | Hardcoded "20+ shipped this week" should show real numbers. | Replace the hardcoded "20+ shipped this week" in the Workshop summary with the real number. | Workshop |
| 29c | Consider grounding the summary/experience socially by highlighting active contributors alongside changes. | **DECIDE** (rec yes): ground the Workshop summary socially by highlighting active contributors alongside the changes. | Workshop |
| 30a | Voting on a card in Workshop view takes 1-2 seconds before hiding from "needs your vote". | Hide a card from "needs your vote" instantly (optimistically) when voted, instead of after the 1–2 s round-trip. | Workshop |
| 30b | Cards should separate code/conflict status from vote status. | Show a card's code/conflict status and its vote status as two separate indicators, not one. | Workshop |
| 31 | System messages in card discussion views are repetitively duplicated (e.g. "xyz is now synced with main and conflict free"). | Deduplicate/collapse repeated system messages in card discussions (e.g. the repeated "now synced with main and conflict free"). | Workshop |
| 32a | "Replying to" banner close button is too small on mobile. | Enlarge the "Replying to" banner's close button on mobile to a proper tap target (≥ 44 px). | Mobile |
| 32b | Cards show active/pressed states while scrolling unlike standard iOS apps. | Stop cards from showing active/pressed states while the user is scrolling, per iOS convention. | Mobile |
| 32c | iOS system header vs platform background fade in/out at different rates when toggling dialogs. | Sync the iOS system header and platform background fades when toggling dialogs — they animate at different rates (carried from 9/3 #62). | Mobile |
| 33a | +button options in dev view should match desktop styling. | Restyle the dev view's "+" button options to match the desktop styling. | Sessions |
| 33b | Minor font/padding discrepancies exist between collapsed and expanded card views. | Reconcile the minor font/padding differences between collapsed and expanded card views. | Sessions |
| 34a | Consider merging Board into Workshop view with toggle for "sort by category" vs "sort by status" (inline view switch). | **DECIDE**: rec merging Board into the Workshop view behind an inline "sort by category" / "sort by status" toggle. | Workshop |
| 34b | Show auto-categories on board view. | Show the auto-generated categories on the board view. | Workshop |
| 34c | Add "show more" button under "nobody has picked this up". | Add a "show more" button under the board's "nobody has picked this up" section. | Workshop |
| 34d | Add fast board filters for "assigned to / created by you". | Add quick board filters for "assigned to you" and "created by you". | Workshop |
| 35a | Typing on an issue hides past comments and causes the screen/keyboard to snap briefly after keypresses. | Stabilize the keyboard viewport when typing on an issue: past comments stay visible and the screen doesn't snap after keypresses. | Mobile |
| 35b | Typing in PWA sessions forces session pop-up while obscuring typed text. | Stop the session pop-up in the PWA from forcing itself up and obscuring the text while you type. | Mobile |
| 36 | Editing profile social accounts lacks ownership verification. | Require ownership verification (OAuth or post-a-proof) before a social account added in profile editing appears publicly. Depends on #46. | Integrations |
| 37 | Revert top-right "details" button to show "built with" directly. | Revert the top-right header "details" button to showing "built with" directly. | Core UI |
| 38a | Reduce height of session descriptor area. | Reduce the session descriptor area's height to a compact row. | Sessions |
| 38b | Add persistent empty state text/layout (similar to Claude/ChatGPT). | Add a persistent empty state (text + layout) to sessions, in the style of Claude/ChatGPT. | Sessions |
| 38c | Session detail bar turns white on scroll. | Stop the session detail bar turning white on scroll — keep its background fixed. | Sessions |
| 38d | Claude Code detail box toggle button/scrolling is broken. | Fix the Claude Code detail box's broken toggle button and scrolling. | Sessions |
| 38e | Auto-set dark mode header when page content is dark. | Auto-switch the header to dark mode when the page content under it is dark. | Sessions |
| 39a | Replace static green dot with active work indicator. | Replace the static green session dot with an indicator that reflects actual work activity. | Sessions |
| 39b | Clarify misleading yellow dot status. | Define what the yellow session dot means and label it clearly (tooltip/legend) — currently misleading. | Sessions |
| 39c | Fix unclickable "handed off" session entries. | Make "handed off" session entries clickable through to their session/card — currently dead. | Sessions |
| 39d | Auto-name default dev sessions (e.g. dev/evan-17890406…) based on first prompt message. | Auto-name default dev sessions from the first prompt message instead of ids like dev/evan-17890406…. | Sessions |
| 40 | Missing CSS on new server for specific apps (todo list, clear skies, workquest). | Fix CSS/asset serving on the new server for todo list, clear skies, and workquest, then audit all apps for the same failure. | Infra |
| 41a | Search bar is not full width or centered. | Make the homescreen search bar full-width and centered. | Core UI |
| 41b | Search bar disappears/snaps on homepage refresh. | Reserve the homescreen search bar's space during refresh so it doesn't disappear and snap back (carried from 9/3 #64). | Core UI |
| 42a | Clicking blank area below message selector should close compose/conversation pane. | In Messages, close the compose/conversation pane when clicking the blank area below the message selector. | Messages |
| 42b | Clicking message field should highlight whole input box. | In Messages, highlight the whole input box when the message field is clicked/focused. | Messages |
| 42c | Consolidate share/attachment icons. | Consolidate the separate share and attachment icons in Messages into one control. | Messages |
| 42d | Enable direct issue sharing via hamburger menu. | Add direct issue sharing to Messages via the hamburger menu. | Messages |
| 43 | Missing clear option/path to re-enable "live translation" after revoking it. | Add a clear settings path to re-enable a revoked app permission — "live translation" is the repro with no way back today. | Settings |
| 44a | Improve sidebar update delay when spec finishes. | Update the sidebar immediately when a spec finishes, instead of after a delay. | Core UI |
| 44b | Change label from "ready" to "ready for your input". | Change the finished-spec label from "ready" to "ready for your input". | Core UI |
| 45a | Deleting drafts is broken. | Fix deleting saved drafts in sessions — currently broken. | Sessions |
| 45b | Sending a draft does not remove it from saved drafts. | Remove a draft from saved drafts when it is sent. | Sessions |
| 45c | Sending a draft populates input with an existing saved draft instead of clearing chat. | Clear the composer after sending a draft — it currently repopulates with another saved draft. | Sessions |
| 46 | GitHub and X account linking features are not working. | Fix GitHub and X account linking end to end (recurring — 9/3 #34/#50) and add a regression test so it stays fixed. | Integrations |
| 47 | Sending messages occasionally aborts abruptly with "thinking about your request" followed by "stopped by @user". | Root-cause sessions aborting with "thinking about your request" → "stopped by @user" when the user didn't stop them. | Sessions |
| 48 | GLM-5.3 is missing from available models. | Restore GLM-5.3 to the available models list — it's the intended default per the 9/3 decision (#89). | Models |
| 49 | Platform share links fail to open on Safari ("couldn't establish a secure connection"). | Fix the TLS/certificate setup on the share-link domain so Safari stops failing with "couldn't establish a secure connection"; recheck after the #1a domain move. | Infra |

## Open questions (the ❓ rows)

- **#3** — Confirm the target: is solarized-light the intended palette (and the current tint the bug), or should we move off solarized entirely?
- **#17** — Assigned vs claim: what confused — the wording, not knowing who holds an item, or being able to claim something already assigned?
- **#20** — Preview accuracy: an example or two of a session whose preview was stale (which app/feature), so it's reproducible.
