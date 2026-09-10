# App feedback triage — 2026-09-10

49 feedback items from the latest testing round (48 numbered + share links, numbered #49 here). Compound items are split into lettered sub-rows (2a, 2b, …), each with its own product-level action — 98 rows total. Reporter attributions are the source item's reporters, repeated on each sub-row.

**Legend**
- **DECIDE** — open product call; a recommendation is given, review confirms: #2a, #24b, #26b, #29c, #34a.
- **❓** — action is a best guess; open question at the bottom: #3, #17, #20.
- Carried-over repeats from the 2026-09-03 triage (`docs/app-feedback-todos.md`): #32c (↔ 9/3 #62), #41b (↔ 9/3 #64), #46 (↔ 9/3 #34/#50), #48 (↔ 9/3 #89).

| # | Feedback | What to do | Area |
|---|----------|------------|------|
| 1a | Switch to app.onhomeroom.com (since my.onhomeroom.com is confusing grammatically). (Evan, SNM) | Move the platform to app.onhomeroom.com with redirects from the old domain; recheck #49's certs after. | Branding |
| 1b | Update appchip name and all instances/weos references to Homeroom. (Evan, SNM) | Rename every weos/instance reference and the app chip to Homeroom. | Branding |
| 1c | Update the app icon + name to the new ones. (Evan, SNM) | Ship the new icon and name everywhere they appear (PWA manifest, native app, platform). | Branding |
| 2a | Landing page from PWA and mobile app should possibly match sign in with a join button, or have a short 1-line pitch linking out (check apps like Aave). (Evan, Zura, SNM, Lukas) | **DECIDE**: rec a sign-in-style screen with a Join CTA plus a one-line pitch (Aave-style). | Waitlist |
| 2b | Landing page/step 1 is text-heavy and needs rewriting/simplification ("Describe the app you want in chat…"). (Evan, Zura, SNM, Lukas) | Rewrite step 1 down to a few scannable lines. | Waitlist |
| 2c | Back button overlaps text in step 1. (Evan, Zura, SNM, Lukas) | Fix the back-button overlap. | Waitlist |
| 2d | #waitlist?confirm=1 should be 2 steps instead of 1. (Evan, Zura, SNM, Lukas) | Split the confirm screen into two steps. | Waitlist |
| 2e | Missing space before "Optional" next to country name, and format/spacing for "*" needs improvement. (Evan, Zura, SNM, Lukas) | Fix the "Optional" spacing and the "*" formatting. | Waitlist |
| 3 | App theme background color looks skin-colored vs solarized-light. (Evan) | ❓ Retune the background away from the skin-toned tint toward a true solarized-light. See question below. | Core UI |
| 4 | No quick or easy way to logout. (Evan) | Add an easy-to-find logout (profile/menu), one tap from anywhere. | Auth |
| 5 | Confirmation email ("confirm your email") is not being received. (Evan, Lukas) | Fix confirmation-email delivery end to end (send, provider, spam placement). Blocker for the waitlist flow. | Emails |
| 6a | Initial homepage load on mobile is very slow every time the app opens. (Bruno, Lukas, Zura, SNM) | Profile and cut cold-start load so every open is fast, not just the first install. | Performance |
| 6b | Opening other apps from the homepage is slow. (Bruno, Lukas, Zura, SNM) | Cut app-open latency (preload/warm where possible). | Performance |
| 6c | Spinning up/creating new apps takes very long (5+ mins or stuck in "spinning up"). (Bruno, Lukas, Zura, SNM) | Fix provisioning so spin-up drops from minutes toward seconds and never sticks; show honest progress meanwhile (ties #10). | Performance |
| 6d | Pulling up the keyboard on Android has low FPS / laggy animation. (Bruno, Lukas, Zura, SNM) | Fix the Android keyboard animation jank. | Performance |
| 7a | Expanding/clicking cards across Workshop vs other views is inconsistent—Workshop shows extra controls like "Reply" input, "Open on its own page", and recent comments while other views do not. (Bruno, SNM, Evan) | One card component everywhere: same controls (reply, open, recent comments) in every view. | Workshop |
| 7b | Clicking a card in Workshop opens it in a padded container (card itself shouldn't be padded). (Bruno, SNM, Evan) | Remove the padding on the opened-card container. | Workshop |
| 7c | Cards have duplicate "Open" and "Open on its own page" buttons. (Bruno, SNM, Evan) | Merge them into one Open action. | Workshop |
| 7d | Opening a card on your own session navigates to the session instead of opening the card view. (Bruno, SNM, Evan) | Open the card view; link to the session from inside it. | Workshop |
| 8 | Working directly from Codex shows up on the platform as a Claude session. (Bruno) | Record and display the actual provider/agent per session (Codex vs Claude). | Sessions |
| 9 | When working on proposals with multiple iterations, the "proposal" button only displays after the first iteration rather than staying at the bottom. (Bruno) | Keep the proposal button persistently at the bottom across all iterations. | Sessions |
| 10 | Creating a new app results in a "net::ERR_CONNECT_RESET" error on its iframe when opened. (Bruno) | Fix new-app provisioning/routing so a just-created app's iframe loads (likely same root as #6c). | Create/fork |
| 11a | "Building with your own tools" guide is not working well with Codex. (Bruno) | Walk the guide end to end with Codex and fix what breaks. | Integrations |
| 11b | Instructions for setting up MCP are missing for Codex or other agents. (Bruno) | Add MCP setup instructions for Codex plus a generic-agent variant. | Integrations |
| 11c | Claude MCP instructions are present but currently broken. (Bruno) | Fix the Claude MCP setup instructions. | Integrations |
| 12a | All apps are currently locked under "account required" (even ones that didn't previously require an account). (Zura, Evan) | Restore per-app access — only truly account-required apps get locked. | Auth |
| 12b | Logged-in waitlist users still cannot use any apps. (Zura, Evan) | Let logged-in waitlist users use apps. | Auth |
| 12c | In Workshop view, replace "app is locked" with a general message explaining who can build on the app. (Zura, Evan) | Reword the lock into "who can build here" messaging. | Workshop |
| 13 | There is no way to delete a test app. (SNM) | Add app deletion for your own (test) apps, with a confirm step. | Create/fork |
| 14 | When failing to load main/directory apps, it displays a generic "failed to load the apps" / "Couldn't reach the app directory" message that needs customized UI/UX alignment. (SNM) | Design a branded error state (plain-language copy, retry CTA) replacing the generic text; root cause tracked in #22. | Core UI |
| 15 | The option to "create an issue" directly on the board is missing (currently under give feedback). (SNM) | Add "create an issue" directly on the board, not only inside give-feedback. | Workshop |
| 16a | The "Reply in thread" input appears disconnected from the page on desktop browsers. (SNM, Evan) | Visually attach the reply input to its thread on desktop. | Workshop |
| 16b | Reply input is missing on workshop cards tapped under "needs your vote". (SNM, Evan) | Render the reply input on needs-your-vote cards too. | Workshop |
| 17 | Improve UI/UX around "assigned" versus "claim". (SNM) | ❓ Make the two states visually distinct — clear "assigned to X" label vs. one obvious Claim action on unclaimed items. See question below. | Workshop |
| 18 | Opening a session no longer shows action buttons (e.g., archive). (SNM) | Restore the session action buttons — regression. | Sessions |
| 19 | Formatting differs between dev session and new session pages (one is full page, the other is not). (SNM) | Unify both on one layout (rec: full page). | Sessions |
| 20 | Previews are sometimes inaccurate and fail to reflect features that have been worked on. (SNM) | ❓ Make previews reliably rebuild/refresh from the session's latest state. See question below (need repro examples). | Sessions |
| 21 | Remaining voting time is no longer displayed on tasks, making merge/discard status unclear. (SNM) | Restore the remaining-time display on votes — regression. | Workshop |
| 22 | SV APIs used to fetch app directory data are broken/incompatible (e.g. "Couldn't reach the app directory — try again in a moment"). (SNM) | Fix/re-version the app-directory APIs apps depend on (Appraise is the repro); add a compatibility guarantee for app-facing APIs. | Infra |
| 23 | Recipe bot requests permission to use AI with no visible prompt or option to grant permission. (Lukas) | Show the AI-permission prompt with grant/deny whenever an app requests AI (recipe bot is the repro). | Apps |
| 24a | Single-page create-app dialogue should use the new pane styling. (Lukas, Evan) | Restyle the create-app dialog in the new pane styling. | Create/fork |
| 24b | Dialogue shows all choices at once; consider fewer choices or multi-step flow to avoid feeling overwhelming. (Lukas, Evan) | **DECIDE**: rec a multi-step flow with fewer choices per step. | Create/fork |
| 25 | Improving existing app triggers API Error 400 (Claude Code 2.1.245 does not support model; version 2.1.251+ required). (Lukas) | Upgrade the platform's Claude Code runner to ≥ 2.1.251. Blocker for improving apps. | Infra |
| 26a | "Show more" only exists for "recommended" apps, while other sorting options show all. (Evan) | Paginate consistently across all sort options. | Discover |
| 26b | Consider adding a card/prompt in Discover for empty state ("nothing featured right now, browse the directory?"). (Evan) | **DECIDE** (rec yes): add the empty-state card linking to the directory. | Discover |
| 27a | Challenges are missing icons. (Evan) | Add an icon per challenge. | Challenges |
| 27b | Missing top padding above completion status line. (Evan) | Add the padding. | Challenges |
| 27c | Change "Open Leaderboard" link to "Open challenges" and add chevron arrows. (Evan) | Relabel and add chevrons. | Challenges |
| 27d | Reorganize Leaderboard/Challenges: Challenges -> Kudos -> Leaderboard, remove "Event/pre season 2" text and "See where season stands", use homepage styling and simplify Leaderboard standings view. (Evan) | Reorder to Challenges → Kudos → Leaderboard; cut the season copy; restyle to homepage patterns; simplify standings. | Challenges |
| 27e | Tapping a challenge should give responsive click feedback and navigate directly to that dedicated challenge page. (Evan) | Add press feedback and deep-link taps straight to the challenge page. | Challenges |
| 28a | Mobile panes (Notifications, Improve, App chips) still use old styling. (Evan) | Apply the new pane styling to all three. | Mobile |
| 28b | Browse all apps page needs new pane styling. (Evan) | Apply the new pane styling there too. | Mobile |
| 28c | Back navigation from browse all apps shows overlapping app chips during animation. (Evan) | Fix the transition so chips never overlap. | Mobile |
| 29a | Workshop summary text erroneously repeats app stats. (Evan) | Fix the duplicated stats. | Workshop |
| 29b | Hardcoded "20+ shipped this week" should show real numbers. (Evan) | Wire the real weekly count. | Workshop |
| 29c | Consider grounding the summary/experience socially by highlighting active contributors alongside changes. (Evan) | **DECIDE** (rec yes): show active contributors in the summary. | Workshop |
| 30a | Voting on a card in Workshop view takes 1-2 seconds before hiding from "needs your vote". (Evan) | Hide voted cards optimistically on tap; reconcile in the background. | Workshop |
| 30b | Cards should separate code/conflict status from vote status. (Evan) | Show them as two separate indicators. | Workshop |
| 31 | System messages in card discussion views are repetitively duplicated (e.g. "xyz is now synced with main and conflict free"). (Evan) | Deduplicate/collapse repeated system messages. | Workshop |
| 32a | "Replying to" banner close button is too small on mobile. (Evan) | Enlarge the tap target (≥ 44px). | Mobile |
| 32b | Cards show active/pressed states while scrolling unlike standard iOS apps. (Evan) | Suppress pressed states during scroll, per iOS convention. | Mobile |
| 32c | iOS system header vs platform background fade in/out at different rates when toggling dialogs. (Evan) | Sync the fades (carried from 9/3 #62). | Mobile |
| 33a | +button options in dev view should match desktop styling. (Evan) | Match the dev-view "+" menu to desktop styling. | Sessions |
| 33b | Minor font/padding discrepancies exist between collapsed and expanded card views. (Evan) | Reconcile the typography and padding. | Sessions |
| 34a | Consider merging Board into Workshop view with toggle for "sort by category" vs "sort by status" (inline view switch). (Evan) | **DECIDE**: rec yes — merge Board into Workshop behind an inline category/status sort toggle. | Workshop |
| 34b | Show auto-categories on board view. (Evan) | Display the auto-generated categories on the board view. | Workshop |
| 34c | Add "show more" button under "nobody has picked this up". (Evan) | Add it. | Workshop |
| 34d | Add fast board filters for "assigned to / created by you". (Evan) | Add the two quick filters. | Workshop |
| 35a | Typing on an issue hides past comments and causes the screen/keyboard to snap briefly after keypresses. (Evan) | Stabilize the keyboard viewport: thread stays visible, no per-keypress snapping. | Mobile |
| 35b | Typing in PWA sessions forces session pop-up while obscuring typed text. (Evan) | Stop the pop-up from stealing focus and covering the input while typing. | Mobile |
| 36 | Editing profile social accounts lacks ownership verification. (Evan) | Require ownership verification (OAuth or post-a-proof) before a social account appears on a profile. Depends on #46. | Integrations |
| 37 | Revert top-right "details" button to show "built with" directly. (Evan) | Revert: show "built with" directly. | Core UI |
| 38a | Reduce height of session descriptor area. (Evan) | Compress the descriptor to a compact row. | Sessions |
| 38b | Add persistent empty state text/layout (similar to Claude/ChatGPT). (Evan) | Add a persistent Claude/ChatGPT-style empty state. | Sessions |
| 38c | Session detail bar turns white on scroll. (Evan) | Keep its background fixed while scrolling. | Sessions |
| 38d | Claude Code detail box toggle button/scrolling is broken. (Evan) | Fix the toggle and its scrolling. | Sessions |
| 38e | Auto-set dark mode header when page content is dark. (Evan) | Switch the header to dark automatically over dark content. | Sessions |
| 39a | Replace static green dot with active work indicator. (Evan) | Make the dot reflect real activity (animated/working state). | Sessions |
| 39b | Clarify misleading yellow dot status. (Evan) | Define what yellow means and label it (tooltip/legend). | Sessions |
| 39c | Fix unclickable "handed off" session entries. (Evan) | Make them clickable through to their session/card. | Sessions |
| 39d | Auto-name default dev sessions (e.g. dev/evan-17890406…) based on first prompt message. (Evan) | Generate the session name from the first prompt. | Sessions |
| 40 | Missing CSS on new server for specific apps (todo list, clear skies, workquest). (Evan) | Fix asset build/serving for those three on the new server, then audit all apps for the same failure. | Infra |
| 41a | Search bar is not full width or centered. (Evan) | Make it full-width and centered. | Core UI |
| 41b | Search bar disappears/snaps on homepage refresh. (Evan) | Reserve its space during load (carried from 9/3 #64). | Core UI |
| 42a | Clicking blank area below message selector should close compose/conversation pane. (Evan) | Close the pane on click-outside. | Messages |
| 42b | Clicking message field should highlight whole input box. (Evan) | Highlight the whole input on focus. | Messages |
| 42c | Consolidate share/attachment icons. (Evan) | Merge them into one attach/share control. | Messages |
| 42d | Enable direct issue sharing via hamburger menu. (Evan) | Add "share to messages" for issues in the hamburger menu. | Messages |
| 43 | Missing clear option/path to re-enable "live translation" after revoking it. (Evan) | Add a clear settings path to re-grant a revoked app permission (live translation is the repro). | Settings |
| 44a | Improve sidebar update delay when spec finishes. (Evan) | Push the status change to the sidebar immediately. | Core UI |
| 44b | Change label from "ready" to "ready for your input". (Evan) | Relabel it. | Core UI |
| 45a | Deleting drafts is broken. (Evan) | Fix draft deletion. | Sessions |
| 45b | Sending a draft does not remove it from saved drafts. (Evan) | Remove a draft from saved on send. | Sessions |
| 45c | Sending a draft populates input with an existing saved draft instead of clearing chat. (Evan) | Clear the composer after send — never auto-load another draft. | Sessions |
| 46 | GitHub and X account linking features are not working. (Evan) | Fix GitHub and X linking end to end (recurring — 9/3 #34/#50); add a regression test so it stays fixed. | Integrations |
| 47 | Sending messages occasionally aborts abruptly with "thinking about your request" followed by "stopped by @user". (Evan) | Root-cause the spurious "stopped by @user" aborts — a session must only stop when the user actually stopped it. | Sessions |
| 48 | GLM-5.3 is missing from available models. (Evan) | Restore GLM-5.3 to the model list — it's the intended default per the 9/3 decision (#89). | Models |
| 49 | Platform share links fail to open on Safari ("couldn't establish a secure connection"). (Evan) | Fix the TLS/cert setup on the share-link domain so Safari opens them; recheck after the #1a domain move. | Infra |

## Open questions (the ❓ rows)

- **#3** — Confirm the target: is solarized-light the intended palette (and the current tint the bug), or should we move off solarized entirely?
- **#17** — Assigned vs claim: what confused — the wording, not knowing who holds an item, or being able to claim something already assigned?
- **#20** — Preview accuracy: an example or two of a session whose preview was stale (which app/feature), so it's reproducible.
