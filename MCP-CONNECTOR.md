# The Homeroom connector in Claude and ChatGPT

Homeroom hosts an MCP connector at `https://<your-usernode-host>/mcp`. Connect
it from Claude.ai or ChatGPT and you can browse apps, file requests and turn
finished work into proposals from the chat you already have open, with the
coding done by Claude Code or Codex on your own subscription.

This document is about **permission prompts**: why every call used to raise
one, what Homeroom ships to stop that, and what you have to check on your own
side for it to actually take effect. The authentication and transport design
lives in [CLI-MCP-AUTH-SPEC.md](CLI-MCP-AUTH-SPEC.md).

---

## The short version

1. Name the connector **`homeroom`** when you add it. The permission rules
   Homeroom ships hardcode that name and there is no wildcard for it. They
   cover **`Homeroom`** too, so the capitalised form is safe, and they still
   cover **`usernode`** and **`Homeroom`**, the names this connector went by
   before it was renamed — so a connector you added earlier keeps working and
   there is nothing to redo. Any other spelling needs the rules rewritten,
   which Settings → Connectors will do for you.
2. New app repos are scaffolded with a `.claude/settings.json` that allows the
   read-only connector calls. Accept the workspace trust dialog once and the
   per-call prompts for reads stop.
3. On your own machine, the same rules in `~/.claude/settings.json` cover
   every repo at once. On Claude Code **web** they do not — the container is
   fresh each session — so there it is the repo's committed file that applies.
   Settings → Connectors has both blocks with a copy button each.
4. No tool forces a prompt of its own. Setting the connector to **allow always**
   in Claude's connector settings covers every call, acting tools included —
   what the connector files are requests, and the group vote is the
   confirmation. This changed: the acting tools used to override that setting.
5. `get_connector_guidance` is the read-first tool. The instructions a client
   receives at connect time are **truncated at 2048 characters** by Claude
   Code, so the connector's full operating charter is delivered as a tool
   result instead — see section 6.

---

## 1. The connector's name, and why it is load-bearing

A Claude Code permission rule names the server it applies to:

```
mcp__homeroom__get_*
```

The server segment is a **literal**. Glob syntax is accepted only *after* the
`mcp__<server>__` prefix, so the rule names one specific server you configured.
There is no `mcp__*__get_*` fallback.

That has a sharp consequence: **a rule aimed at a connector under a different
name fails silently.** No error, no warning — you keep getting prompted and
conclude the instructions were wrong.

### Where the name comes from

Two different things could supply it, and they behave differently:

- **The server's own `serverInfo.name`.** Homeroom reports `homeroom` — the
  constant is `SERVER_NAME` in `src/services/mcp-connect-constants.js`.
- **What you typed.** Claude.ai's *Settings → Connectors → Add custom
  connector* dialog has a **Name** field, and the client builds tool names from
  the string you put in it.

Issue #1218 reported an account whose tools arrived as `mcp__Uesrnode__whoami`.
That string appears nowhere in Homeroom's source. It was typed at connect time,
which makes it a **name you can fix on your side in ten seconds** rather than a
platform bug — and it is why the Settings → Connectors panel now tells you the
canonical name up front instead of leaving the field to chance.

### Why `homeroom` (lowercase) is the canonical spelling

Because it is exactly what `serverInfo.name` reports. A client that derives the
name from the server and a client where a human typed it then agree, and one
set of rules works for both. Any other spelling makes those two paths disagree.

### The rename, and what it does not do

This connector was called `usernode` before the platform moved to Homeroom's
own domain. Renaming `serverInfo.name` is what keeps the agreement above true:
the docs tell you to type `homeroom`, so the server has to report `homeroom`.

It is **not retroactive**, and it cannot be. A connector already added under
the old name keeps that name, because the client built its tool names from what
its user typed and nothing the server reports changes them. The shipped rules
still cover both old spellings, so that connector goes on working untouched.

The one case that does move is a client that **derives** the name rather than
taking a typed one. On its next reconnect its tools become `mcp__homeroom__…`,
and rules written for the old spelling stop matching — silently, the way every
spelling mismatch does. Re-copying the block from Settings → Connectors fixes
it, and the block already covers the new name.

### Read the name off your own tool list

Do not trust a copy-pasted snippet — including the one in this file. The
prefix Homeroom's tools arrive under **differs by surface**:

| Surface | What the tools are called |
|---|---|
| Claude Code (cloud/web session, this one) | `mcp__homeroom__whoami` |
| Claude connector plumbing that namespaces by client | `mcp__claude_ai_homeroom__whoami` |

Guidance that names only one form is wrong for the other half of users, so:
**look at the tool names you actually see, take the segment between the first
and last `__`, and use that as the server segment of your rules.** If it is not
one of the four spellings the shipped list covers, either edit the rules or
reconnect the connector under the canonical name.

### `whoami` hands the model both halves

The server cannot see the name your client built its tool names from. The model
can — it is looking at the name of the tool it just called. So `whoami` returns
the other half:

| Field | Value |
|---|---|
| `connectorName` | the canonical `homeroom`, straight from `SERVER_NAME` |
| `permissionAllowRules` | the exact rules Homeroom ships — five entries × four spellings of the name — from `READ_ONLY_ALLOW_RULES` |

Comparing the two is a one-step check any client can make: if the tool it just
called is not named `mcp__<connectorName>__…`, this connection is registered
under a different spelling and the shipped rules will not match it. These are
plain output fields, not an instruction to relay — the setup tip is the thing
that gets relayed, and it is throttled precisely because it interrupts.

---

## 2. No tool forces a prompt — the vote is the confirmation

Homeroom's acting tools used to carry the `anthropic/requiresUserInteraction`
metadata Claude Code reads off a tool definition:

```json
{ "name": "submit_work", "_meta": { "anthropic/requiresUserInteraction": true } }
```

For a tool marked that way, Claude Code shows the permission prompt on **every**
call — in `acceptEdits`, `auto` and `bypassPermissions` alike — offers no "don't
ask again", and skips it for no allow rule. It checks the marking *before* it
looks up allow rules, which is the part that made it a poor fit here: it also
outranked the connector's own **allow always** setting, so a user who granted
that in Claude's connector settings kept being prompted anyway, with nothing on
either surface explaining why. The setting looked broken.

**The marking is gone.** Allow-always now means what it says, on every tool.

The reasoning behind it does not apply to this connector. Nothing the connector
exposes writes to an app — one exception, demo mode, is taken up at the end of
this section. Every acting call files a *request* — a proposal, an
issue, a build — and the platform merges none of it without a group vote:

| Tool | What it actually does |
|---|---|
| `submit_work` | Opens or advances a proposal, for the group to vote on |
| `create_request` | Files on the app's board and as a GitHub issue |
| `prepare_work` | Claims the request on the app's board; mints a work order |
| `close_work_order` | Puts away one of the user's own unsubmitted work orders, freeing its slot; touches no branch, proposal or vote |
| `start_platform_build` | Spends the user's daily Homeroom credits |
| `submit_platform_build` | Puts that build to a group vote |
| `recheck_change` | Re-runs a proposal's checks on the commit it already has; no code or vote moves |
| `demo_mode`, `demo_propose`, `demo_promote`, `demo_vote`, `demo_reset` | Demo mode — the exception, below |

Four more acting tools, `start_change`, `promote_change`, `sync_change` and
`withdraw_change`, exist only for the Mayor of an agent session inside Homeroom
(#2779). An external client never sees them. The Mayor runs each one only after
the user confirms it on a card.

The vote is the confirmation, and it is a better one than a prompt clicked
through mid-loop by the one person already driving the agent. A per-call prompt
bought a click, not a decision.

`start_platform_build` is the one whose old justification was not about
write-visibility at all — it spends a daily credit allowance. That allowance is
capped by `connectorLimits` on the server, which is where a spending limit
belongs; it does not need a second gate in the client.

These tools are still named as a group, in `ACTING_TOOLS`. That list no longer
controls prompting — it decides which tools stay out of the setup hint and out
of the allow rules Homeroom ships, which is the subject of the next section.

### The exception: demo mode

Demo mode (`routes/demo-mode.js`) exists so a recording of the proposal flow
can be driven from a connected agent while the phone in shot stays untouched.
An app's creator, when they are also a full platform admin, switches the app
into demo mode and names a *partner*: a
synthetic account the platform owns, with no usable password and no OAuth,
that the session middleware and the login route refuse outright. Through five
tools, and only these, the partner acts:

| Tool | What it actually does |
|---|---|
| `demo_mode` | Switches an app the caller created into demo mode; creates the partner, and puts the app on "at least N approvals" (2 by default) until it is switched off |
| `demo_propose` | The partner opens a proposal from a branch already on the repo, or from a patch the platform applies there itself, and sends the real vote notification; with `hold` it opens the pull request and builds the preview but announces nothing |
| `demo_promote` | Puts a held proposal up for the vote on cue, which sends that notification, casting the partner's vote first when asked |
| `demo_vote` | The partner casts its vote — a real vote, through the real path |
| `demo_reset` | Takes the partner's proposals down, moves the app's `main` back to where demo mode was switched on, and redeploys |

Two of them do what the rest of the connector never does: `demo_vote` votes,
and `demo_reset` rewinds `main`. They may because of where the platform
refuses them — on every app not in demo mode, on any app the caller did not
create, and for a creator who is not a full platform admin (both fences;
never an admin's override on somebody else's app). The partner counts as a
voter on the demo app alone, the app's settings say it is in demo mode and
name the partner, and the read-only `get_demo_status` lists what would spoil
a take. In the permission model they are acting tools like the others: out of
the setup hint, out of the shipped allow rules, prompted like any other write.

### Admin only: test accounts

First-time-user testing needs a genuinely new account each run, and "Reset
first run" on an old one keeps its memberships, votes and history. A full
platform admin's connector (and nobody else's) gets six tools for that, over
`routes/test-accounts.js` and `services/test-accounts.js`:

| Tool | What it actually does |
|---|---|
| `create_test_account` | Makes a new account flagged as a test account and returns its username and a one-time password, with the sign-in steps. Inputs, all optional: `username` (omitted: a placeholder and the real "choose your username" step), `platformAccess` (default `true`; `false` leaves it in the waiting room), `welcomeDm` (default `false`), `note` (≤ 200 characters) |
| `create_test_phone_sign_in` | A one-time phone sign-in for the flows that ask for a phone (an invite's Join sheet): a fictional test number (`+1 415 555 01xx` unless `phoneNumber` names another `+1 … 555 0100–0199` number) and a random six-digit code that works once, within 30 minutes and five tries, in any environment. No text is sent. The account it makes is a test account; naming a live test account's number signs in to it again |
| `send_test_release_email` | Sends the waitlist's real "You're in. Welcome to Homeroom" email to a test address, so the flow from that email can be walked, and the email itself checked, in any environment. Inputs, all optional: `email` (omitted: a fresh `+test` alias of the admin's own confirmed address, such as `you+test1a2b3c@example.com`), `welcomeDm` (default `false`), `note` (≤ 200 characters). The account its link makes is a test account. Returns the address and the delivery's own status (`sent`, `suppressed_rate_limit`, `skipped_staging`, …) with the steps to follow. Refuses an address that belongs to a real account or a real waitlist signup |
| `list_test_accounts` | The live ones: id, username, address, who made it and when, last active, note, and the apps it made with their status; and the test release emails nobody has signed up from yet. Read-only |
| `retire_test_account` | With `confirm: "RETIRE"`: takes down every app the account made (the same teardown as deleting the app), each after keeping its run report (`reportsKept`), then deletes the account. Refuses an account that is not a test account, and stops without deleting it if an app cannot be taken down |
| `get_run_report` | Everything recorded about a test project's first version, for analysing a newcomer test (`services/run-report.js`): the app and its first-version row, the Homeroom bot's runs, each review round's verdict and issues, the app's sessions, agent turns with their telemetry metrics, `llm_invocation` events, first-version screens (metadata only) and incidents. Inputs: `slug` (a live app's report is built now; once the app is gone, the copy retiring kept in `test_run_reports`, with `source` and `savedAt` saying which) and `username` (that test account's kept reports, newest first, with the newest in full). Lengths and metadata, never a prompt, spec, message or image; long text and lists are cut and the report stays under 256 KB. Read-only |

Username plus a generated password, typed into the ordinary sign-in form, is
the one sign-in that works on the web and in the iOS app (which signs in
through the same form) against local, staging and production alike. A device
that is already signed in must sign out first. No endpoint mints a sign-in
link or token: that would be a new credential type with a larger blast radius
than a random password on a flagged account.

The invite's Join sheet signs a newcomer up with a phone, which a password
cannot stand in for, so `create_test_phone_sign_in` mints the one other
credential: a code for one fictional number (`+1 … 555 0100–0199`, reserved
for fiction, so no person holds it). It is random, works once within 30
minutes and five tries, is kept only as a bcrypt hash, and adds its number only
to a test account. A local stack can instead set `PHONE_TEST_CODE`, one fixed
code for every test number, which production refuses.

The waitlist's "you're in" email is reached only from a released waitlist
row, so `send_test_release_email` makes one: the address becomes a waitlist
row, confirmed and released like an admitted signup, marked in
`test_waitlist_releases`, and the mail goes through the same sender, mobile
steps and throttle as Admit (three a day per address, a minute apart, which a
fresh alias avoids). Its link is Admit's too: a freshly minted one-time
sign-in link, or the email code once that is spent. The NEW account either
makes is marked a test account before it is let in
(`waitlist.linkUserByEmail` with `newAccount`, then
`testAccounts.adoptReleasedAccount`), without the invite-tree skips a release
by hand gives. An account that already existed is never let in by a test
release. Test releases are kept out of Admin → Waitlist and the Journey's
admitted cohorts; one nobody signed up from is withdrawn a week after its last
send, and retiring the account deletes its row.

A test account is a real account, so it is fenced from real outcomes rather
than trusted not to use them:

- **Vote thresholds.** It is left out of the active-member denominator.
- **Votes.** Its vote on an app a real person made is recorded and shown, with
  "Test account: this vote won't count." in the vote picker, and left out of
  every tally. On an app a test account made, it counts, so one tester can take
  a project through a vote end to end. One SQL predicate,
  `counts_toward_outcome(voter, app)`, decides both.
- **Rankings and Journey.** `exclude_podium`, and a `test` entry on the Journey
  page's left-out list.
- **People.** No welcome DM unless `welcomeDm` is set: it puts staff into a
  group with the account. Homeroom bot's hellos (after the tour, with a first
  project, on joining, with a first request) are not fenced: they reach a test
  account however it was made, as they reach any newcomer. What it posts in a
  shared space is still seen by everyone there.
- **Wallets.** A native sign-in never assigns it a season wallet.
- **Scale.** At most 25 live at once, unused phone sign-ins included (refused
  as `at_capacity`, and a release email whose link would make one more);
  10 creates, 10 phone sign-ins, 10 release emails and 10 retires an hour per
  admin.

The password is in the tool result, so it lands in the client's transcript.
That is accepted for a throwaway account that can do nothing a full admin
cannot, is flagged, and is fenced as above; the platform keeps only its hash
and logs it nowhere. The routes sit at `/api/test-accounts` (a connector can
reach neither `/api/admin` nor `/api/auth`), each gated `requireAdminWrite,
testAccountLimiter, sameOriginBrowserOnly`, and no path has a `password`
segment. `create_test_account`, `create_test_phone_sign_in`,
`send_test_release_email` and `retire_test_account` are acting tools;
`list_test_accounts` and `get_run_report` are reads.

### Admin only: the App bench studio, the benchmark, the bot and recent shots

A full platform admin's connector also drives the **App bench studio**
(`services/bench/studio.js`): a brand-new app's first version built from a
brief the way a new project's is built today (the starter and its sketch card
as the first commit, the Homeroom bot's triage, the plan approved as a creator
tapping Build it, the spec, the build, then 16 screenshots), on any model,
with or without a **context pack** (guidance added to the bot's first-version
prompts, and files such as a theme skill added to the first commit), beside
**reference builds** a Claude Code session makes from the same inputs and
hands back. The same connector reads and curates the rest of the Homeroom bot
benchmark, the live bot, and the platform's recent before/after screenshots.
The charter's `app-bench-studio` section is the procedure a session follows.
The **shots evals** (`services/shots-eval.js`, at `/api/shots-evals`, gated
the same way) try the shots agent with another model, prompt or time budget
on merged proposals. They are compared with the live agent in the same batch,
and the charter's `shots-evals` section is their procedure
(docs/proposal-visuals/shots-evals.md).

| Tool | What it actually does |
|---|---|
| `get_bench_studio` | The studio's recent runs, its packs, its host app, the starter briefs and its limits. Read-only |
| `launch_bench_studio` | Launches a studio run: briefs (`briefSet: "starter"`, new `{ name, brief }`, `{ ref }` or `{ taskId }`) × `models` (`"today"` is the live bot's own per stage) × `contextPackIds` (0 for none) × `repeats`, with `references` planned per brief. `capUsd` is required; over $100 needs `confirmLargeCap` |
| `get_bench_studio_run` | A run as it moves: each build's arm, step, time, spend, last activity lines, skills invoked or read, screenshots, code and preview. `since` takes the previous call's cursor and returns only what changed. Read-only |
| `get_bench_reference_order` | The work order for one reference: the brief, the start commit (the same first commit the bot's builds start from, on a public branch of the host repository), the pack, how builds are judged and how to hand back. Given, alone, to a fresh Claude Code session. Read-only |
| `submit_bench_reference` | Hands a reference in with a `label`, as a branch on a repository the admin's linked GitHub account owns or a patch (≤ 256 KB). It is copied into the host repository and captured like the bot's builds, at no model cost; the same label again is its next attempt |
| `rerun_bench_trial`, `cancel_bench_trial`, `keep_bench_trial` | One build: run again as the arm's next attempt, stop, or keep its branch past the seven-day sweep |
| `deploy_bench_preview` | Puts a studio build up for 24 hours through the platform's own preview path, on the host app with a fresh, empty database; at most four at once |
| `get_bench_gallery` | Every studio brief with its builds across runs. Read-only |
| `list_bench_context_packs`, `get_bench_context_pack`, `create_bench_context_pack` | The packs; one in full with its diff from its parent; save the next version of one |
| `list_bench_suites`, `get_bench_suite`, `add_bench_task`, `edit_bench_task` | The benchmark's suites and tasks; add a task (a brief, a capture, a bot run at a stage, a merged pull request) or edit a taste task's brief while its suite is open |
| `list_bench_trials`, `get_bench_trial` | Any run's trials one by one, and one in full with its screenshots as images. Refused for a run that is not a studio run while any of its trials waits for the judge, so blind grading stays blind |
| `get_bench_trial_transcript` | One trial's whole transcript, a page of up to 500 lines at a time, optionally one step's: every activity line its turns reported, with when it came and its step |
| `get_homeroom_bot`, `rate_homeroom_bot_run` | The bot as its console section shows it (settings, spend, queue, a page of its runs) and a run's rating |
| `list_recent_shots`, `get_recent_shots` | Merged proposals' before/after screenshots as the console's Screenshot gallery lists them, and one proposal's stills as images |
| `list_shots_configs`, `save_shots_config` | The live shots agent (model, time budget, prompts) and the saved shots configurations; save the next version of one. Only an eval runs a configuration |
| `launch_shots_eval`, `cancel_shots_eval` | Reshoots merged proposals (`sessionIds`, or `sameProposalsAs` an earlier eval) with the live agent as the control and each configuration in `configIds`, `repeats` times, billed to the platform. `capUsd` is required; over $100 needs `confirmLargeCap` |
| `list_shots_evals`, `get_shots_eval`, `get_shots_eval_shots` | The evals; one eval's numbers per arm (ready rate, cost, time, win rate against the control, judged marks) and its trials; one proposal's shots across every arm as images. Read-only |
| `get_shots_eval_pair`, `submit_shots_eval_pick` | A blind pair (the control and a configuration on one proposal, in random order) and its pick, with marks on each ready change |

The studio's builds run in one private host app the benchmark user owns,
made once through app creation's own path, so a preview's database is that
app's own empty one and never an app's real data. A studio run is open by
design (its watch names the model of every build); a session that grades
blind items should never have watched. The routes sit at `/api/bot-studio`
(`routes/bench-studio.js`), each gated `requireAdminWrite` first, reads
included, and every write then `benchStudioLimiter` (a launch
`benchRunLimiter`) and `sameOriginBrowserOnly`. The writes are acting tools;
everything else is a `get_`/`list_` read.

### Admin only: the programme's challenges

A full platform admin's connector also manages the challenge programme: the
events, the challenges in each, the templates challenges are made from, and
the rules that credit them automatically. These are the console's Season
events, Challenge templates and Challenge scoring screens, a call at a time,
so a week can be set up from a conversation instead of one form after
another. The charter's `challenges` section is the procedure a session
follows.

| Tool | What it actually does |
|---|---|
| `list_challenge_events`, `get_challenge_event` | The events, newest first (`search`, `seasonId`, `page`); one event in full with its challenges in order, each with what its card shows, which fields it sets itself, its place and whether it is featured, and with `availableTemplates` the templates it has no challenge from yet. Read-only |
| `save_challenge_event` | Makes an event (no `eventId`) or changes one. Deleting an event stays in the console |
| `add_challenge`, `edit_challenge` | Adds a challenge to an event from a template, or changes one. A field set to `null` goes back to the template's |
| `reorder_challenges`, `move_challenge` | Sets an event's order from a list of its challenge ids; moves a challenge, with the credits earned for it, to another event |
| `remove_challenge` | With `confirm: "REMOVE"`: removes a challenge and every credit earned for it. `edit_challenge` with `enabled: false` hides one instead |
| `list_challenge_templates`, `get_challenge_template` | The templates and their categories; one in full. Read-only |
| `save_challenge_template`, `delete_challenge_template` | Makes or changes a template (which changes every challenge made from it, wherever the challenge does not set that field itself); deletes one no challenge uses |
| `get_challenge_scoring` | The measures, the rules with each challenge they cover and why any is skipped, the last runs and the schedule. Read-only |
| `save_challenge_scoring_rule`, `delete_challenge_scoring_rule` | Makes, changes or deletes a scoring rule. Credits a deleted rule wrote stay |
| `run_challenge_scoring` | Runs the scorer now, or previews it with `dryRun: true`, which writes nothing and calls no grading model |

Fields keep the console's own names (`goal`, `schedule_start`, `cta_link`)
in both directions, so a refusal that names a field names the one sent. The
routes sit at `/api/challenge-admin` (`routes/challenge-admin.js`), because a
connector can never reach `/api/v4`. Each is gated `requireAdminWrite` first,
reads included, and every write then `challengeAdminLimiter` and
`sameOriginBrowserOnly`. Each one then hands the request to the console's own
route at the same path under `/api/v4/admin`, so the console and a connector
session validate and write alike. Only the listed doors open: deleting an
event, the CSV export, users and the SQL console are not among them. The
writes are acting tools; the reads are `get_`/`list_`.

---

## 3. The allowlist Homeroom ships

Every app repo Homeroom scaffolds gets a `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__homeroom__get_*",
      "mcp__homeroom__list_*",
      "mcp__homeroom__whoami",
      "mcp__homeroom__notify_awaiting_input",
      "mcp__homeroom__notify_input_received",
      "mcp__Homeroom__get_*",
      "mcp__Homeroom__list_*",
      "mcp__Homeroom__whoami",
      "mcp__Homeroom__notify_awaiting_input",
      "mcp__Homeroom__notify_input_received",
      "mcp__usernode__get_*",
      "mcp__usernode__list_*",
      "mcp__usernode__whoami",
      "mcp__usernode__notify_awaiting_input",
      "mcp__usernode__notify_input_received",
      "mcp__Usernode__get_*",
      "mcp__Usernode__list_*",
      "mcp__Usernode__whoami",
      "mcp__Usernode__notify_awaiting_input",
      "mcp__Usernode__notify_input_received"
    ]
  }
}
```

Project settings load from the repo's `.claude/` directory, so every user of
every app picks this up with no setup, and a `.claude/README.md` beside it
carries the reasoning (JSON has no comments).

That file fixes one repo. The same rules in your **personal**
`~/.claude/settings.json` fix every repo at once, including repos Homeroom
never scaffolded — see section 4, and Settings → Connectors has the block with
a copy button.

### Which file applies where

The two files hold identical content and differ only in reach, and the reach
that matters depends on the surface you are on. Guidance that names one file is
wrong for whoever is on the other surface — which is why Settings → Connectors
now shows three labelled cases rather than one block of prose.

| Where you are | What applies | Why |
|---|---|---|
| **Claude Code on your own machine** | `~/.claude/settings.json` | Your home directory persists, so one file covers every repo, including repos Homeroom never made. |
| **Claude Code on the web** | the repo's committed `.claude/settings.json` | The container is built fresh each session, so nothing from your machine is in it. The repo is the only thing that travels — subject to the trust dialog below. |
| **Claude.ai chat, ChatGPT** | neither | You approve the connector once in that product's own settings; it does not prompt per call. Both files are Claude Code's format and have no effect here. |

The web row is the reason the per-repo copy is offered in the product at all.
A personal settings file is strictly better where it works, and it does not
work there.

### Why not `mcp__homeroom__*`

Because of where this file lives, not because of what the tools do. It is
committed into every app repo Homeroom scaffolds, so it grants on behalf of
everyone who ever opens that repo. "Every call this connector can make" is not
a reviewable thing to put in front of a stranger in the trust dialog; a list of
reads is. **Never widen these to a wildcard.**

If you want the acting calls allowed too, that is a fine thing to want — grant
it on your own account, where the decision covers your machine only: set the
connector to allow-always in Claude's connector settings, or add the rules to
your own `~/.claude/settings.json`. Both now cover the acting tools too — that
is what section 2 changed.

### The naming contract that keeps those globs honest

The globs are durable only because tool naming is treated as a **contract**, not
a description:

- A read-only tool is named `get_*` or `list_*`.
- A tool that acts is **never** named `get_*` or `list_*`.

`whoami` is the single grandfathered exception, which is why it gets its own
literal entry. The contract is enforced by `tests/mcp-tools.test.js` against the
registered tool surface, so a new acting tool named `get_something` fails the
suite rather than quietly becoming allowed in every scaffolded repo. Add a read
and it is allowed everywhere with no migration; add an action and give it any
other name.

### One workspace trust dialog

`permissions.allow` rules in a project's `.claude/settings.json` grant
capability, so Claude Code applies them **only after you accept the workspace
trust dialog** for that workspace. Until then it reads the rules and does not
apply them. The dialog lists the allow rules, so you can review these three
before accepting.

That is the right trade. A repo silently granting a connector permission on your
behalf is exactly what the trust check exists to prevent, and one reviewable
consent beats dozens of per-call prompts.

> **Open question — does workspace trust persist across
> ephemeral web containers?**
>
> A Claude Code **web** session clones the repo fresh each time. If trust state
> lives in the container rather than in the account, web users trade per-call
> prompts for a per-session trust dialog. That is still a large improvement —
> one dialog instead of thirty — but it is not silent, and it should not be
> announced as if it were.
>
> **This has not been settled.** It cannot be answered from this repository: it
> needs a fresh Claude Code web session, on a scaffolded app, checked for
> whether the trust dialog reappears on the second session. Nothing in the
> implementation depends on the answer — the file, the rules and the marking are
> correct either way — so it is recorded here rather than blocking. If you run
> that session, replace this box with what you saw.

---

## 4. The repos the scaffold does not reach

### Every creation path now scaffolds it

`.claude/settings.json` used to ship only from the **fresh-create** path, which
is the one that writes the whole template. Two other paths make an app repo and
neither called that code, so neither produced the file:

| Path | Before | Now |
| --- | --- | --- |
| Create a new app | scaffolded | scaffolded |
| **Import an existing repo** | nothing | connector scaffold added if absent |
| **Fork another app** | inherited whatever the source had | connector scaffold added if absent |

All three now read the two `.claude/` entries from one helper,
`getConnectorScaffoldFiles()` in `src/services/template.js`, so a create, an
import and a fork cannot end up with three different versions of the file.

Both new paths are **write-if-absent, and never fatal.** An import keeps the
repo it imported: if `.claude/settings.json` is already there it is left alone,
and if the push fails — a user-owned repo the platform's GitHub App cannot write
to is an ordinary import, not an error — the failure is logged and the app is
created anyway. A fork writes into the flattened working tree before the single
squashed commit, skipping any path the source already carries, because a fork
copies an app rather than normalising it.

### Repos that existed before this

The scaffold reaches repos **created, imported or forked after it shipped**
(commit `feabb34f`) and no others. At that point the platform held **37 apps,
every one of them created earlier**, so the number of existing app repos
carrying `.claude/settings.json` because Homeroom put it there is zero. Read
the table above as "from now on", not as a description of the fleet.

There is no campaign to fix that by hand. It would mean a proposal and a vote
per app, and the last comparable sweep landed 12 of 35 — leaving a majority of
users no better off while looking finished. More to the point, a per-repo file
is the wrong shape for the problem: it fixes one repo at a time, and someone
working across several Homeroom apps has to collect them.

**The everywhere-at-once fix is the user's own settings file.** The same three
rules under `permissions.allow` in `~/.claude/settings.json` apply to every
repo, scaffolded or not. Settings → Connectors renders that block with a copy
button, and `.claude/settings.local.json` is the uncommitted per-repo variant
for anyone who wants it narrower.

### Homeroom's own build workers are not affected either way

Worth stating because it is a natural assumption: none of this changes anything
for the platform's in-house build agents. They run with
`--dangerously-skip-permissions`, so they have no permission prompts to
suppress, and their harness passes `--strict-mcp-config`, so they do not load
this connector at all. Scaffolding `.claude/` into the repos they work in would
have been dead weight in every proposal diff.

### How a user finds out any of this exists

A user who never opens Settings → Connectors would otherwise never learn the
prompts are fixable. The connector therefore says so **in band**, on the
results of read-only tools:

- The `initialize` instructions tell the model that a second text block
  beginning `Homeroom setup tip` is Homeroom talking to the user through it,
  and is to be relayed once rather than treated as data. Without that, an
  unexplained block in a tool result is reasonably read as noise and dropped.
- The hint itself is a second `content` text block on read-only results only —
  never on a tool that acts, never on an error, and never on `prepare_work`,
  whose work order the model has been told to reproduce character for
  character. It carries the rules, the personal settings path, and an
  instruction to substitute whatever server segment the model can actually see
  in the tool name it just called, which is the self-correcting answer to the
  misspelling problem in section 1.
- It is **armed by `initialize`**. That message is the protocol saying a
  session has started, and it is the only such signal a stateless transport
  gets, so `POST /mcp` arms the connection's row the moment it sees one (after
  authentication and the audit insert, never before). A claim is then granted
  when the connection has been armed since the tip was last shown, and showing
  it consumes the arm — one session, one tip, however many reads run in it.
- It is **bounded twice, and both bounds are ANDed**: a **sixty-minute** floor
  between showings, so a client that re-initializes for a reconnect or a second
  tab does not turn the tip into a nag, and at most **three showings per
  connection per rolling seven days**. The floor used to be ten minutes and was
  an *alternative* route to a claim rather than an additional condition, which
  meant arming bypassed it — one production grant spent its whole weekly budget
  inside fourteen minutes and then went quiet for six days. The window's start rolls forward inside the same statement that
  claims, so the budget refills on its own.
- State lives in `mcp_connector_hints`, keyed on the grant. A failed claim is
  logged and the read returns without a hint — a tip never turns a working call
  into an error — and a granted claim is logged at **info**, so "shown too
  often" and "never shown at all" are distinguishable in production.
- It is suppressed for ChatGPT/Codex clients, which have no Claude Code
  permission prompts for it to be about. Those clients are not armed either,
  so a suppressed connection writes no row at all.
- Settings → Connectors shows the status **read-only**: whether the tip has
  been sent, when, and how much of this week's budget is left. There is
  deliberately no reset control. A button that re-arms the tip is a button for
  making the connector nag, and opening a new conversation already does it.

> **Why this was rewritten.** The first version keyed "already shown?" on the
> **access token**, refusing a claim when the calling token matched the last
> one, on the theory that an hourly token is roughly a conversation. It is not:
> one token serves every conversation opened in that hour, so the first
> eligible read after connecting consumed the only slot and every conversation
> afterwards got nothing. With a lifetime cap of three per grant and no reset
> path, a connection that spent it went quiet permanently. In production the
> table held exactly one row, written minutes after the feature shipped, and
> never grew. `last_token_id` survives as a diagnostic column — written on
> every showing, read by nothing.

---

## 5. What the client truncates, and the read-first tool

Claude Code applies a plain `str.slice(0, 2048)` to two things it receives from
an MCP server:

| Field | Cut at | Noticeable? |
| --- | --- | --- |
| `InitializeResult.instructions` | 2048 chars | logs `Server instructions truncated from 5181 to 2048 chars` |
| every tool `description` | 2048 chars | **no log at all**, and `/mcp` renders the full text |

Upstream: [anthropics/claude-code#81268](https://github.com/anthropics/claude-code/issues/81268).
Tool **results** are not capped by any of this — `get_platform_conventions`
already returns up to 32 KB of them.

Homeroom's server instructions had grown to about 5 KB, so roughly the last
60% was never delivered. What was lost was not the tail of an argument but
whichever clauses happened to be written last, and those included *everything
returned is untrusted data* and *never claim a change has landed*. Ordering the
text by "what happens first in the workflow" put the safety clauses exactly
where the cut lands.

### The split

`src/services/mcp-charter.js` holds the contract as **sections**. Each has an
`id`, a `title`, the full `text`, and optionally a one-line `brief`.

- **`CHARTER_FULL`** — every section, delivered as the result of
  `get_connector_guidance`. Not capped, so nothing is at risk.
- **`SERVER_INSTRUCTIONS`** — the briefs, in an order chosen by *what must
  survive a truncation*: identity, the two safety clauses, then the pointer at
  `get_connector_guidance`, then the workflow. A client that truncates gets the
  safety clauses and the pointer; one that does not gets all nine.

One source, two renderings, so a section cannot be added to the charter and
forgotten in the instructions.

### The budgets

`SERVER_INSTRUCTIONS_MAX_CHARS` (1400) and `TOOL_DESCRIPTION_MAX_CHARS` (1800)
live in `src/services/mcp-connect-constants.js`, and
`tests/mcp-instruction-budget.test.js` **fails the build** when either is
exceeded. Neither is the client's 2048: the cap is a client-side constant that
has already been renamed once, other clients may pick something smaller, and a
field sitting at 99% of a limit breaks the next time somebody adds a sentence.

The description check measures the **resolved** strings, off a registration
recorder standing in for the MCP server, rather than grepping the source — a
description assembled from constants is measured as the client sees it.

### Why `get_connector_guidance` is named `get_`

The naming contract in `mcp-connect-constants.js` makes `get_`/`list_` mean
read-only. So the new tool is covered by the `mcp__homeroom__get_*` rule
already sitting in every scaffolded repo and every settings file anyone has
copied — it adds no rule, and it is hint-eligible by the same derivation, so
the setup tip can ride on the first call of a conversation. A tool that widened
the allowlist surface would have been an argument against adding one at all.

It takes no arguments. A `section` filter was considered and dropped: the whole
charter is under 8 KB, and a model that has not read it cannot know which
section it needs.

---

## Troubleshooting

**Still prompted on every read.**
Check the server segment first — it is the usual cause. Run a read-only tool and
look at the name in the prompt: if it is not `mcp__homeroom__…`,
`mcp__Homeroom__…`, `mcp__usernode__…` or `mcp__Usernode__…`, your connector is
registered under a different name and none of the shipped rules match it. Paste
that spelling into the **"Connector registered under a different name?"** field
in Settings → Connectors — both copy blocks are rewritten for it — or reconnect
under `homeroom`. Then check you accepted the workspace trust dialog
for this workspace.

**Prompted on `submit_work` even though I allowed it.**
This used to be intended behaviour and is not any more — see section 2. If you
are still seeing it, the likely cause is which allow rule you set. The rules
Homeroom *ships* cover reads only (`get_*`, `list_*`, `whoami`), by design, so
they will not cover `submit_work`. Either set the connector to **allow always**
in Claude's connector settings, or add the acting tools to your own
`~/.claude/settings.json`. Do not add them to a repo's `.claude/settings.json`,
which grants for everyone who opens that repo rather than for you.

**I want a per-call confirmation on the acting tools anyway.**
There is no longer one built into the connector, and a repo-level allow rule
cannot create one — allow rules only ever loosen. Leave the connector at
ask-each-time in Claude's connector settings and do not add acting-tool rules to
any settings file; that is the configuration that prompts.
