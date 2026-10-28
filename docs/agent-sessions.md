# Agent sessions: spec (#2779)

Agreed with evan on 2026-09-23, before implementation. This copy is the reference for the proposals that implement it; each one says `Refs #2779`.

## Summary

An **agent session** is one long-lived conversation per thread, per user, with a Mayor that can work on any app, including Homeroom itself. The Mayor drives one change at a time, using the existing per-change machinery underneath and the platform MCP as its toolset. It replaces the per-change sessions. The experimental Global Chat stays as it is, behind its own toggle. It shipped behind a per-user experimental flag; since stages 3 and 4 of the rollout the flag is gone, new work starts in an agent session for everyone, classic sessions are no longer created, and existing ones are read-only: they can be read, and the proposals they became carry on, but their chats take no new message (see *As built: stages 3 and 4* and *As built: classic sessions are read-only*).

**Goals**

- Reuse the per-change pipeline as it is: the Mayor, scout and spec, the coding agent and worker, staging, checks, before & after shots, promotion, votes, merge.
- Do everything a per-change session does through one shared platform MCP toolset, used by the Mayor and by external Claude or Codex clients.
- Give the coding agent read-only platform MCP access. Every write goes through the Mayor, and writes that matter are confirmed with the user.
- Take an app hint from wherever the user starts, without binding the session to that app.
- Keep the conversation open after a change merges or is withdrawn.
- Roll out per user behind a flag, then flip the default for everyone.

**Non-goals for v1**

- Several changes in flight from one agent session. It is one active change at a time.
- Changing how changes are voted on, merged or deployed.
- Migrating or deleting existing per-change sessions.
- Giving the coding agent write access to the platform MCP.
- Changing or retiring the experimental Global Chat. It stays behind its own toggle.

## Decisions already aligned

Evan settled these on 2026-09-23. The rest of the spec builds on them.

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Agent sessions sit alongside the experimental Global Chat, behind their own flag. Global Chat stays as it is for now. | Nobody who turned Global Chat on has to turn it off. Retiring it later is a separate decision (see Global Chat). |
| D2 | One shared MCP toolset. Which server hosts it is our call. | The hosted Homeroom connector gains the native-change tools. The Mayor calls the same tool definitions from inside the server. |
| D3 | The coding agent gets read-only platform MCP. | Writes happen only through the Mayor, and the Mayor confirms the important ones with the user. |
| D4 | One active change per agent session for now. | Starting another change parks the current one; it does not run in parallel. |
| D5 | Work happens through the Homeroom connector. | The base commit and submission for voting go through the connector, not through this stale fork. |
| D6 | Per-user experimental flag. When it is on, existing sessions keep working and agent sessions become the default for new work. | The same switch later becomes the default for everyone. |

## Today's system

Today one `chat_sessions` row is both the conversation and the change. A `chat_sessions` row is closed once its change merges or is archived. No internal agent can reach either MCP server. All references below are upstream `main` at `076c103`.

| Surface | What it is | What it lacks for #2779 |
| --- | --- | --- |
| Per-change session | Chat, branch, PR, staging, checks, before & after shots and votes all key on `chat_sessions.id` (`change-destination.js:3`, `pr_votes.session_id`). The Mayor loop is written inline in `POST /api/sessions/:id/chat` (`sessions.js:4736`, a 15.9k-line file). One warm worker per session clones the app's repo. | Bound to one app (`app_id`) and one PR; the prompt says "ONE branch and ONE pull request" (`sessions.js:15634`). Chat stops once the status leaves `active`/`promoted` (`sessions.js:4758`). The coding agent loads only Playwright, visible-changes and shots MCPs, under `--strict-mcp-config`. |
| Global Chat (experimental, opt-in) | Threads per user, not tied to an app (`global_chat_threads`). A cheap GLM model calls 525 auto-generated web routes by replaying the user's browser cookie. It confirms writes with sealed one-use tokens and has its own monthly cap. | No Mayor and no MCP. Code work creates a per-change session and navigates away (plan.md rule 5). The `activeAppSlug` hint is cleared before the chat opens (`app.js:5586`). |
| Hosted Homeroom connector | 29 MCP tools over stateless Streamable HTTP, with OAuth tokens (`svmcp_`) issued only after browser consent. The allowlist is `CONNECTOR_ALLOWED_ROUTES`. | `prepare_work`/`submit_work` assume an external checkout and the user's own GitHub fork. Its charter assumes a human-driven client. There are no delegated or service tokens. |
| CLI MCP (local, stdio) | Native proposal flow: `proposal_start → push_commit → submit_build → status/recheck → promote`, plus generic `api_read`/`api_write`. Uses `svcli_` device-code tokens and needs no fork. | Runs on the user's machine and uploads a local commit. It has no way to ask a platform worker to build. |

The UI already anticipates this change: three comments say "a platform-wide agent session will take its place" (`messages/index.tsx:481`, `agent-dialog.tsx:18`, `improve-controller.js:992`).

## Concepts

The core move is to separate the conversation from the change. The change stays a `chat_sessions` row, so every downstream system is untouched. The conversation becomes a new, never-closing parent.

```mermaid
flowchart LR
  U[User] --> AS[Agent session<br/>conversation + Mayor]
  AS -- "at most 1 active" --> C1[Change<br/>chat_sessions row]
  AS -. "parked / closed" .-> C2[Earlier changes]
  C1 --> W[Worker<br/>coding agent]
  C1 --> P[Branch · PR · staging<br/>checks · votes]
  AS -- "MCP tools" --> H[Platform MCP]
  W -- "read-only MCP" --> H
```

The Mayor lives in the agent session. Workers, previews and votes stay per change.

| Term | Meaning |
| --- | --- |
| Agent session | A per-user conversation with the Mayor. It is not bound to an app and never closes; the user can archive it. A user can have many, like chat threads. |
| Change | One existing `chat_sessions` row: one app, one branch, one PR, one preview, one vote. A change started from an agent session has no chat of its own. |
| Active change | The one change the Mayor is working on now. Build and scout turns go to its worker. |
| Parked change | A change the agent session has moved away from but that is not closed. It is paused as today (worker released, preview kept) and can be made active again. |
| Focus app | A soft hint about which app the user means. It is set from the entry point or by the Mayor, and it never restricts what the session can do. |
| Mayor | The same project-manager LLM as today, with a global prompt and the platform MCP toolset. It is the only actor that writes to the platform. |
| Coding agent | Claude Code or Codex, running in the active change's worker as today, with read-only platform MCP. |
| Classic session | A per-change session created the old way, with a chat of its own. Since #3976 it is read-only: its transcript, previews and proposal stay, and its chat takes no new message. |

## Rollout: the experimental flag

One per-user flag decides where new work starts. It never changes how existing sessions behave. The same flag, with its platform default flipped, becomes the launch mechanism for everyone.

**Mechanism.** This copies the existing `session_bridge_enabled` pattern, so the client knows the value synchronously at boot.

- `users.agent_sessions_enabled BOOLEAN NULL`. NULL means "follow the platform default"; TRUE or FALSE is the user's explicit choice, so an opt-out survives the later default flip.
- `config.agentSessionsDefault` (env `AGENT_SESSIONS_DEFAULT`, default `false`). The effective value is `COALESCE(user value, platform default)`.
- The effective value is loaded into `req.user` by `middleware/auth.js`, returned by `/api/auth/me` as `agentSessionsEnabled`, and read by the client as `App.user.agentSessionsEnabled`. The pinned auth SELECT in `sql-dynamic-baseline.json` is updated to match.
- `POST /api/me/agent-sessions` is a clone of `/api/me/session-bridge`. The UI is a `SwitchRow`, "Agent sessions (experimental)", in Settings → Experimental. (Both retired in stages 3 and 4.)
- Every server route that creates an agent session also checks the flag. The client check is for routing only; the server check is the gate.

**Behaviour by flag state**

| Surface | Flag off (today) | Flag on |
| --- | --- | --- |
| Existing classic sessions | Unchanged | Unchanged: same chat, same URLs, same controls |
| Improve “New change”, Workshop “Start here” | New classic session on that app | New agent session, focus = that app |
| Messages “+” → Agent chat | App picker, then classic session | New agent session, no app picker |
| App dev tab “new” screen, in-session “New change” banner | Classic session on that app | Agent session, focus = that app |
| Issue row “Start work”, Feedback “fix it” | Classic session linked to the issue | Agent session, focus = app + issue; the Mayor links the issue when it starts the change |
| Proposal “Explore in dev chat” | Classic session seeded with the proposal | Agent session, focus = app + proposal (read-only context in v1) |
| Credits-card external flow, CLI/connector handoffs, fork, clone-headless | Unchanged | Unchanged |
| Global Chat | Available behind its own toggle | Unchanged, behind its own toggle. Agent-session rows sit beside its rows in Messages → Agents |

**Stages**

1. Ship dark. The flag is off for everyone. The Settings switch and \`POST /api/me/agent-sessions\` are admin-only until stage 2 (\`AGENT\_SESSIONS\_OPT\_IN=admins\`).
2. Open opt-in for every user (\`AGENT\_SESSIONS\_OPT\_IN=all\`), with the Experimental label shown. **This is the current stage:** `src/config.js` defaults the audience to `all`, because the variable is not declared in `dapp.json`'s `platform_env` and so could not be set in production. `AGENT_SESSIONS_OPT_IN=admins` closes the switch to admins again.
3. Flip `AGENT_SESSIONS_DEFAULT=true`. Users who opted out keep classic sessions.
4. Remove the classic creation path in a separate, later change. Global Chat's future is decided separately. Classic sessions stay readable until their changes close.

**Done.** Stages 3 and 4 shipped together, and further than planned: there is no opt-out left to keep, because the flag and its Settings switch are gone. See *As built: stages 3 and 4* under the implementation plan.

## Data model

The data model adds one table and two nullable columns. Every migration is additive. `chat_sessions` stays the change record, so staging, checks, votes, merge and the sweepers need no schema changes.

**New table `agent_sessions`**

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | SERIAL PK | Address `#agent/<id>` and the event bus key `agent:<id>` |
| `user_id` | INT FK users, NOT NULL | Owner. Only the owner can read or post in v1. |
| `title`, `title_source` | TEXT | Titled like sessions today; the user can rename it |
| `status` | `open` · `archived` | Never closes on its own. Archiving parks the active change and hides the session. |
| `focus_app_id` | INT FK apps, NULL | Current app hint (see App hint) |
| `focus_context` | JSONB | `{entry, issueNumber?, proposalId?}` from the entry point |
| `active_change_id` | INT FK chat\_sessions, NULL | The one change being worked on (D4) |
| `mayor_model`, `agent_backend`, `agent_model` | TEXT | The Mayor's model, split from the coding agent's model. Today one `selectedModel` serves both. |
| `summary_md`, `summary_through_id` | TEXT, INT | Rolling compaction of older turns (see The Mayor) |
| `active_turn` | JSONB | Lease for the conversation-level turn, so only one Mayor turn runs per session |
| `last_activity_at`, `created_at`, `archived_at` | TIMESTAMPTZ | Sorting and sweepers |

**Changes to existing tables**

- `chat_sessions.agent_session_id INT NULL REFERENCES agent_sessions ON DELETE SET NULL`, indexed. A change with a parent has no chat of its own: `POST /api/sessions/:id/chat` refuses it the same way it refuses headless and imported rows, and points to the parent.
- `chat_session_messages.agent_session_id INT NULL`, index `(agent_session_id, id)`. `session_id` is already nullable, so one table holds both views:
  - the conversation: `WHERE agent_session_id = X`. Rows with no active change have `session_id` NULL.
  - one change's slice: `WHERE session_id = C`, as today, so the existing transcript renderer works unchanged.
- A `BEFORE INSERT` trigger on `chat_session_messages` copies `agent_session_id` from the parent change whenever it is NULL. There are 79 insert sites (scout publication, recovered wrap-ups, issue drafts, handoff events, …); the trigger means none of them has to change and none can drop a row out of the conversation. The repository already uses triggers (for example, mobile push enqueue).
- `chat_session_attachments.agent_session_id INT NULL REFERENCES agent_sessions ON DELETE CASCADE`, and `session_id` becomes nullable, with a CHECK that a row names one or the other. Files sent in a conversation use the dev chat's table, so its validation, its caps (4 per message, 50 MB per conversation), the 24h orphan sweep and the account-deletion purge all apply unchanged. `POST /api/agent-sessions/:id/attachments` uploads one file and `GET …/attachments/:attId` serves it to the owner. A turn's `attachmentIds` must be the user's own unsent uploads to that conversation. The message row lists them in `metadata.attachments` and claims them (`message_id`). The Mayor reads them back through `loadForHistory`, as the dev chat's Mayor does. A build is handed the latest message's files, and the worker downloads them through the change it builds (`routes/internal.js` matches the change's `agent_session_id`).

**What stays as it is**

- `pr_votes`, `check_runs`, `shot_runs`, `turn_effects`, `agent_turns`, `chat_session_specs` and the rest keep keying on the change id.
- Global Chat's six `global_chat_*` tables are not touched in v1. They stay for as long as Global Chat does.
- No existing session is migrated. Classic sessions have `agent_session_id` NULL forever.

## The Mayor

The Mayor is today's Mayor loop, moved out of the route and run with a conversation-level context. Classic sessions call the same code, so they keep their exact behaviour.

### Extraction

- New `src/services/mayor/turn.js`: `runMayorTurn({conversation, change, transport, tools, billing, model, signal})`.
  - `conversation`: loads history, appends rows, holds the turn lease.
  - `change`: `{session, repo, spec, prContext, busy(), beginOperation()}`, or null. Null removes the dispatch tools and the spec and PR prompt blocks.
  - `transport`: `{send, sendStatus, heartbeat, done}`, for SSE plus WebSocket plus bus.
- What moves: handler lines \~5392–6706, tool definitions and resolvers \~10596–11700, `resolveTurnPills`, `buildMayorMessages` and `getMayorSystemPrompt` (about 2.5k lines in total).
- What stays in `POST /api/sessions/:id/chat` (\~300 lines): auth, row load, attachments, branch mint, the user-message insert and opening the SSE stream. Its conversation adapter wraps the change's own transcript, so classic behaviour is unchanged.
- `runScoutTool` and `runClaudeCodeTool` keep the whole per-change tail: PR metadata, staging, checks, before & after shots and vote revision. Their only edit is taking `actor` and `heartbeat` instead of `req` and `res`.
- The headless auto-session keeps its own copy of the loop in v1. Folding it into the service is a follow-up.
- Staging: proposal 1 moves the turn as it is, `runMayorTurn(ctx, deps)` taking the route's own inputs, pinned byte-for-byte by `tests/mayor-turn-golden.test.js`. Proposal 3 splits `ctx` into the `conversation`, `change` and `transport` above.

### Turn shape, unchanged

1. mayor1: data tools, at most 3 iterations.
2. One terminal action: scout, build, a confirmed write, or reply-only.
3. The per-change tail runs, if something was dispatched.
4. mayor2 writes the wrap-up.
5. Reply pills.

### Tool set in an agent session

| Tool | Source | Confirmed by user | Notes |
| --- | --- | --- | --- |
| `list_apps`, `get_app`, `list_requests`, `get_request`, `get_discussion`, `get_proposal`, `list_my_proposals`, `get_platform_conventions`, `get_change` | Shared MCP (read) | No | These replace `list_github_issues`/`get_github_issue`, and the MCP versions also include the Homeroom discussion |
| `start_change {app, title, linkedIssues?}` | Shared MCP (new) | **Yes** | Creates a change with `agent_session_id` and makes it active. It parks the previous active change. It counts against the active-session cap. |
| `promote_change`, `sync_change`, `recheck_change`, `withdraw_change` | Shared MCP (new) | **Yes** (except recheck) | Promotion and withdrawal are the user's decision. Sync pushes a merge onto the change's branch, so it needs a yes. It keeps the votes unless a conflict resolution edits files outside the conflict. |
| `create_request`, `claim_request`, `release_request`, `propose_close_request`, `update_proposal_issues` | Shared MCP (existing) | **Yes** | They post publicly in the user's name. `propose_close_request` opens a group vote on closing a request; it closes nothing by itself |
| `dispatch_scout`, `dispatch_coding_agent` | Mayor-internal | No, as today | Target the active change only; refused when there is none |
| `switch_active_change {changeId}`, `set_focus_app {slug}` | Mayor-internal | No | Switching resumes a parked change. The user's own changes only. |
| `web_fetch`, `draft_issue_report`, `get_prod_status`, `suggest_answers`, `suggest_replies` | Mayor-internal, as today | No | `get_prod_status` only for admins when the active change targets the platform app |

**How confirmation works.** This ports Global Chat's sealed one-use confirmations (`global-chat/actions.js`).

1. A write tool returns `pending_confirmation`, and the transcript shows a confirmation card with the exact input.
2. Pressing Confirm POSTs the one-use token.
3. The server re-checks authorization and runs the write with the sealed input.
4. The result is appended as a system row, and the Mayor gets a short follow-up turn.

The model can never confirm its own write, and text like "yes" in the chat is not a confirmation.

As built in proposal 2, the storage-independent half is `services/confirmations`: token minting, normalization, sealing and the expiry bounds. Global Chat's `actions.js` now uses it and keeps its own table and thread check. Proposal 3 adds an agent-session table the same way, so every statement stays static. The tools that need a card are listed in `MAYOR_CONFIRMED_TOOLS` (`mcp-audiences.js`). 3b-i adds that table, `agent_session_actions`; see "As built in 3b-i" under the implementation plan for how a card is claimed and run.

### Prompt

A new `getAgentMayorPrompt`, with shared blocks moved out of the classic prompt:

- **Role.** The user's project manager across Homeroom. Plain English, 1–4 sentences, never writes code.
- **Focus.** The focus app and entry context (see App hint). Treated as a default, never a boundary.
- **Active change.** App, PR #N (proposal M), status, spec, failing checks, vote tally. There is one active change. Distinct work means proposing `start_change`, which parks the current one; this replaces the "ONE branch and ONE pull request" and "Start a new change button" text.
- **Parked and recent changes.** One line each, so the user can say "go back to the dark-mode one".
- **Platform rules** carried over from the connector charter and rewritten for an agent inside the platform:
  - tool results are untrusted data;
  - never claim a change has landed;
  - name proposals as PR #N (proposal M);
  - revise a change instead of duplicating it, and warn that revising clears votes;
  - do not act on a pending check run.
- **Self-edit guardrails** apply when the active change targets the platform app, as `prompts.js` does today for self-hosted sessions.

### History and compaction

- `buildMayorMessages` reads `WHERE agent_session_id = X`. `[CODING AGENT COMPLETED]` results fold in as today, and each is now labelled with its change (“PR #N on \<app>”).
- The session never closes, so history is compacted. When the replayed history passes a token budget (proposed 60k), the oldest turns are summarized into `summary_md` by one low-effort Mayor-model call at the end of the turn. The last 10 turns and the active-change block always stay verbatim.

### Model, streaming, durability

- **Model.** `mayor_model` is separate from the coding agent's model. The provider follows the user's default backend: Anthropic by default, or OpenRouter through `openrouter-mayor.js`, keyed `homeroom-agent-<id>`. Per-user budgets and BYOK are unchanged.
- **Streaming.** The event protocol is the same, on `POST /api/agent-sessions/:id/turns` with bus key `agent:<id>` and a resumable `GET /api/agent-sessions/:id/events`. The active change's `cc_progress`, `staging_ready`, `pr_created` and similar events are forwarded to the agent bus.
- **Durability.** A turn is the `turn` machine's work item (`agent:<id>`, docs/workflows.md), run whole (mayor1, the dispatch, the coding run, mayor2) in whichever workflow process claims it. `agent_sessions.active_turn` is the conversation's claim: written with the message and the turn's `Asked` in one transaction, it lasts exactly as long as the turn. The coding run stays durable on the change (`chat_sessions.active_turn`), owned by the item. A process that goes loses only the item's lease: the next claim follows the coding run to its end and writes its wrap-up in the change's transcript (the trigger surfaces it in the conversation), then hands the claim back (`handBackAfterRecovery`); a Mayor turn cut before its dispatch is ended interrupted, with Retry.
- **Stop.** Stop stamps the claim and appends `StopRequested` to the turn's instance; the turn reads it from its claim, and a coding run is stopped by its journal, with today's rule that wrap-up cannot be stopped.

### Keeping every screen in step with the server

A conversation is drawn by several screens at once: its own screen, the Messages pane, the side panel, another device. They used to learn what changed from the turn's in-memory event stream, which had to reach each of them exactly once. Several things broke that:

- every deploy replaced the pod the bus lived in;
- a screen that opened mid-turn got no replay;
- a change notice carried only `busy`.

The screen also guessed "the Mayor is working" from those events. The results were a sent message that flashed away and came back, a transcript that only updated after leaving and coming back, and Send quietly turning into Save with nobody working. The design now:

- **The server is the one source of truth, and says when it moved.**
  - `agent_sessions.state_version` is bumped by database triggers on every write a screen draws: a message written or edited, the active change's status, checks or preview, the turn lease taken, moving phase or released, a card, the title, the model, the archive.
  - A read (`seen_at`) does not bump it.
  - Every message row carries `rev`, taken from one sequence on insert and on update.
  - Each bump is announced by the trigger itself, as a `pg_notify` in `services/ws-bus.js`'s own envelope, so every pod delivers `agent_session_changed { agentSessionId, version, busy }` to the owner's sockets.
- **One consistent read.** `GET /api/agent-sessions/:id/state?version=&rev=` reads the session with its changes, the running turn, the messages and the cards in one `REPEATABLE READ` snapshot.
  - A screen that holds the current version gets `{ unchanged, busy, turn }`, a one-row read.
  - Given a rev, it gets only the rows written or edited since.
  - The running turn comes from the claim, whose `phase` and `phaseStartedAt` the turn writes as it moves. That way a screen on any pod can draw it.
- **The screen converges on it.** The store (`frontend/src/features/agent-session/store.ts`, `requestSync`) runs one read at a time. A trigger that arrives mid-read asks for one more, so an older answer can never land over a newer one. It reads:
  - on every route into a conversation, the same one included;
  - on a notice with a newer version;
  - on `accepted`, the saved reply, `done`, `error`, `stopped` and the change's events;
  - when the page comes back to the foreground, or the network or the notices' socket returns;
  - every 4 seconds while the Mayor works, and every 30 seconds otherwise.

  Whether the Mayor is working is the server's answer, never the screen's guess.
- **Events only animate.** Tokens, the tool line and the build's progress are drawn from the turn's events. The streamed words stay until the read that brings the saved row replaces them, in one publish. `GET .../events` replays the running turn's events to a screen that opens mid-turn, and a turn's 30-second buffer cleanup no longer empties a newer turn's buffer.
- **Durable, idempotent sends.**
  - `POST .../turns` takes the screen's `clientMessageId`. It writes the message, takes the claim and asks for the turn in one transaction (`startTurnWithMessage`) before the stream opens, then answers `accepted`.
  - A resend of the same id answers `{ duplicate }` and runs no second turn (a per-conversation unique index on `client_message_id`).
  - Who pays is decided before anything is written, so every refusal writes nothing.
  - On the screen, a message is drawn at once as the conversation's outbox row (`outbox.ts`). The server's row with its id replaces it in place.
  - A send with no answer is tried again under the same id: twice, and after 20 seconds of silence, or on a 503 from a restarting server.
  - A send the server did not take stays in the conversation, Not sent, with Retry, Edit and Discard. It is never handed back to the box and never turned into a draft. The outbox is kept per conversation in `localStorage`, so a reload finds it.
  - Leaving a conversation no longer aborts a send on its way.
- **Turns that outlive their process.**
  - A draining process finishes the turns it runs; at its deadline, or when it dies, it gives their items up, and the next claim carries each on from what it saved (above).
  - A turn whose item fails for good is ended as interrupted when the machine releases its claim: what was said is kept, a `turn_interrupted` note is written (`endInterruptedTurn`). Past six hours a turn is ended the same way.
  - The conversation's last `turn_interrupted` or `turn_failed` note offers Retry. `POST .../turns { retry: true }` re-runs the turn with no new message, and the Mayor is told why.
- **Save for later, unmistakable.** While the Mayor works, typing shows "The Mayor is still working, so this will be saved as a draft, not sent" above the box. The button reads "Save draft", and the drafts list says "Ready to send" once the turn ends.

### Riskiest parts

1. Stop and cleanup ordering, including release-before-`done` (#2599).
2. `tool_use`/`tool_result` pairing across the move.
3. The three places billing is re-resolved mid-turn.
4. About 22 tests that read `sessions.js` source text; they will need re-pointing.
5. Keeping the OpenRouter direct-turn fallback working.

## Platform MCP

The hosted Homeroom connector becomes the single toolset (D2). It gains a few native-change tools, and a new kind of token lets the platform's own agents use it on the user's behalf. The CLI can move onto the same tools later; that move is out of v1.

### One registry, three audiences

`registerTools` in `mcp-tools.js` stays the only place tools are defined. Each tool declares which **audiences** may see it, and each token carries a **kind**. The kind comes from how the token was issued; the client can't choose it.

| Kind | Who | Tools | Writes |
| --- | --- | --- | --- |
| `external` | Claude.ai, Claude Code, ChatGPT via OAuth (today) | Today's 29 tools, plus `get_change`, `recheck_change` | As today |
| `agent_mayor` | The Mayor inside an agent session | All reads, plus the native-change tools and the existing request and proposal writes | Only through a confirmed action (see The Mayor) |
| `worker_read` | The coding agent in a change's worker | `get_platform_conventions`, `get_app`, `list_requests`, `get_request`, `get_proposal`, `get_change`, all bound to one app | None |

### New native-change tools

| Tool | Backed by | Notes |
| --- | --- | --- |
| `get_change {changeId}` | New JSON projection of a `chat_sessions` row: status, PR, staging, checks, `nextStep` | The in-platform twin of the CLI's `proposal_status` |
| `start_change {slug, title, linkedIssues?}` | A loopback to `POST /api/apps/:slug/sessions`, then `PATCH …/title` and `PATCH …/linked-issues` | `agent_mayor` only. The route keeps its caps and its claim of the first request. Proposal 3 has the route read `req.mcpDelegation` to set `agent_session_id` and park the previous active change. |
| `promote_change`, `recheck_change`, `sync_change`, `withdraw_change` | Existing `/promote`, `/recheck`, `/sync-main`, `/archive` routes | `recheck` is safe for `external`; the rest are `agent_mayor` only in v1 |

**As built in proposal 2.**

- Every tool is a loopback to the route the change page's own buttons call, like the rest of `mcp-tools.js`, so ownership, caps and state checks stay in the routes. This replaces the earlier plan to pull session creation out into a service.
- `get_change` reads `GET /api/sessions/:id` plus the live half of `GET /api/sessions/:id/status` (whether a turn or a sync is running).
- Its `nextStep` is worded for the caller. The Mayor is told to dispatch the coding agent or call the change tools. The worker is told what to fix in its own turn. An external client is pointed at the change's page.
- `recheck_change` joins the external route allowlist (`POST /api/sessions/:id/recheck`) and `ACTING_TOOLS`.

`dispatch_scout` and `dispatch_coding_agent` stay Mayor-internal instead of MCP tools. They stream a long SSE turn into the conversation, spend credits, and have no use outside the Mayor. Making them MCP tools would need a new non-streaming "dispatch, then poll" route, which v1 does not need.

### Delegated tokens

- New table `mcp_delegations`, one row per delegated grant: `grant_id` PK, `user_id`, `kind`, `agent_session_id`, `change_id` NULL, `app_id` NULL, `expires_at`, `revoked_at`.
- `mcpOauth.issueDelegatedAccess({userId, kind, agentSessionId, changeId?, appId?, scopes, ttl})` mints only an access row (no refresh token). Its synthetic client id deliberately fails `CLIENT_ID_RE`, so consent and the token endpoint can never use it.
- `authenticateConnector` joins `mcp_delegations`. It refuses when the delegation is revoked or expired, or when its agent session or change is no longer live, and it returns the `delegation`. Revocation therefore needs no hooks to take effect. The turn's `finally` and `session-lifecycle` pause and archive also revoke explicitly.
- `connectorApiBearerChain` enforces each kind's route allowlist. For `worker_read` it also checks that every `:slug` in the route is the bound app.
- Delegated grants are left out of `/api/me/connectors` and the dev-flow connector count.
- Lifetimes: `agent_mayor` read tokens last one turn (at most 15 min). Write tokens are one-shot, minted when the user confirms and revoked right after. `worker_read` lasts one build turn.

**As built in proposal 2.**

- Delegated tokens have their own prefix, `svmcd_`, where consented tokens use `svmcp_`. The gates decide on the shape before any lookup. `authenticateConnector` then refuses a token whose shape and grant disagree, in either direction.
- The synthetic client ids are `homeroom:agent_mayor` and `homeroom:worker_read`.
- Liveness means:
  - the token row and the delegation are both unrevoked and unexpired;
  - when the delegation names a change, the change is still the user's and still in the named app;
  - the change's status is `active` or `promoted` for a worker, or `active`, `paused`, `promoted` or `merging` for the Mayor.
- `agent_session_id` has no foreign key yet. Proposal 3 adds the constraint with the `agent_sessions` table, and adds agent-session liveness to the same join.
- A grant bound to an app is held to it. Every `:slug` must be that app, and every `:id` must be a change in it. A Mayor grant bound to one change may touch only that change. The bearer chain sets `req.mcpDelegation` for the routes.
- Nothing issues a delegation in proposal 2. Proposal 3 starts issuing them, and adds a sweeper for expired delegation and token rows at the same time.

### How the Mayor calls it

- The Mayor calls the MCP inside the server process, over the SDK's `InMemoryTransport` (SDK 1.30.0; `tests/connector-setup-hint.test.js` already wires it up). Each turn it builds `registerTools(server, ctx)` with the delegated token and `baseUrl = http://127.0.0.1:<port>`, as Global Chat does. Loopback calls then land on the same pod instead of the k8s Service.
- The in-process path repeats the two edge duties it skips: the `token_used` audit row, and a rate bucket per agent session.
- MCP tool definitions are translated into Anthropic and OpenRouter tool schemas for the Mayor loop.
- Found while testing proposal 2: the SDK's `Client.callTool` checks `structuredContent` against the tool's output schema even on an error result. `toolError` results never match that schema, so the in-process client must send `tools/call` through `client.request` with `CallToolResultSchema` and read `isError` itself.

### Charter variants

- `mcp-charter.js` sections gain an `audiences` tag, with `charterFor(kind)` and `instructionsFor(kind)` selected by `delegation.kind`, never by `clientName`.
- The `agent_mayor` and `worker_read` variants drop the text written for a human-driven client: fork checkouts, relaying work orders, the 2048-character cap and setup tips.
- The conventions preamble flips for workers: the “don't `git push`” and “in-loop browser” sections *do* apply to them.
- The existing character-budget test covers every variant.
- As built: the external charter, its instructions and its section list are unchanged. Four existing sections are tagged for every kind: what Homeroom is, the conventions pointer, and the two safety clauses. Each delegated kind adds its own sections: the Mayor's role, its confirmation rule and its change lifecycle; the worker's read-only role. `mcp-audiences.js` holds which tools each kind sees. An unknown kind sees no tools and reads no charter.

### Environment gates

`/mcp` and the loopback chain return 404 on staging and when `cliAuthEnabled` is off. Delegated tokens must work in both cases. Without that, the platform's own staging previews could not exercise agent sessions, and proposal checks run there. The external OAuth surface keeps its gates.

As built, the gate lets exactly two things through, both decided on the bearer's shape: `POST /mcp` with an `svmcd_` bearer, and an `svmcd_` bearer on the loopback API chain. Metadata, registration, consent, token, revocation and the Settings list all stay off. Behind the gate, the `/mcp` handler also refuses anything that did not authenticate as a live delegation.

## Coding agent

The coding agent uses one warm worker per change, with the app's repo on the change's branch. It commits and returns its result; shared conductor completion/recovery publishes through the isolated trusted Git pusher. It gains read-only platform MCP bound to that change's app.

**Setup, per build or scout turn**

1. `buildTurnSecretEnv` mints a `worker_read` delegation, next to today's `mintIssuesReadJwt`. It is bound to `user_id`, `change_id` and the change's `app_id`, and lasts one turn.
2. The worker gets it as `HOMEROOM_MCP_TOKEN`.
3. A new stdio bridge, `worker/homeroom-read-mcp.js` (modelled on `visible-changes-mcp.js`; the SDK is already in the worker image), proxies an allowlist of six read tools to `PLATFORM_URL/mcp`.
4. Claude: the bridge is added to the strict `~/.usernode-mcp.json` for build and scout modes. The token is passed through the environment, never expanded into the heredoc at bootstrap.
5. Codex: the bridge is added to the per-turn `config.toml` with `env_vars` and `enabled_tools`. The token is added to `shell_environment_policy.exclude` and to output scrubbing.
6. The turn's `finally` revokes the delegation. Pausing or archiving the change also makes it fail on the next call.

**Prompt.** A short “Homeroom (read-only)” block in the build and scout prompts:

- what the six tools are for: the full request thread, proposal check details, conventions on demand;
- that the agent cannot write to the platform;
- that its questions go back to the Mayor in its final message, as today.

**Why read-only is enough.** Everything a change needs to write is already done around the agent:

- publication through the conductor after the worker returns its commit;
- PR metadata from its description block;
- staging and checks by the server;
- promotion and requests by the Mayor with the user's confirmation.

**Honest value check.** The agent already gets the conventions and failing checks inline, so the gain is modest: on-demand reads of the request discussion and proposal details. This step lands after the Mayor work (see Implementation plan), and it can be dropped without affecting the rest.

**Proposal title and description (as built).** One conversation carries several changes, and a message is filed under whichever change was active when it was sent. So the messages under a change are the go-ahead ("Build the spec") and the next change's opening line, not a description of it. `pr-metadata.js` therefore writes an agent-session change's title and description from the change alone:
- its only request is the name the Mayor gave it at `start_change`, recorded on the `change_started` event (`session_title` follows the PR title once one exists);
- then its spec, its builds' summaries and its coding agent's descriptions.

A Codex change is titled by that name; a Claude change's title is generated from it. The text is rewritten on every build and again at `POST /api/sessions/:id/promote`, so voters read the change as it stands. The refresh is best-effort and never blocks the vote. `start_change` no longer writes `proposed_pr_title`, so only a title a person sets (`PATCH /api/sessions/:id/title`) pins the proposal's name. Coding agents' `**DESCRIPTION**` / `**TESTING ===**` markers are accepted; ordinary headings are not.

## Lifecycle and limits

An agent session is closed only by the user archiving it. Its changes keep today's lifecycle, and the session just tracks which of them is active.

```mermaid
stateDiagram-v2
  [*] --> Active: start_change (confirmed)
  Active --> Parked: start_change / switch away
  Parked --> Active: switch_active_change
  Active --> Voting: promote_change (confirmed)
  Voting --> Active: revise (clears votes)
  Voting --> Closed: merged / rejected / withdrawn
  Active --> Closed: withdraw_change (confirmed)
  Closed --> [*]
```

“Parked” is today's `paused` status, and “Voting” is `promoted`. “Closed” covers `merged` and `archived`. No new change statuses are added.

**Rules**

- **One active change (D4).** Only `active_change_id` receives scout or build dispatches. Starting or switching to another change pauses the current one if it is `active`; that releases its worker and keeps its preview. A `promoted` change keeps its vote running while it is not the active change.
- **Revising a change that is up for a vote** means switching to it first. The Mayor warns that revising clears the votes.
- **When a change closes** (merge, rejection, withdrawal, stale-PR close), hooks in the merge (the merge-followups workflow machine's `agentNote` write) and `finalizeArchivedSession` post a system row to the parent session (“PR #N merged”) and clear `active_change_id` if it pointed there. The conversation carries on.
- **One Mayor turn at a time** per agent session, through the `active_turn` lease. Typing during a turn saves a draft, as the dev chat does today.
- **Archiving an agent session** pauses its active change. It never withdraws a proposal. It can be unarchived.

**Caps and idle**

- Agent sessions hold no worker, so they have no cap in v1.
- Changes count exactly as today: 3 active / 5 promoted, or 5 / 8 for full admins. When `start_change` hits the cap, the Mayor explains and offers to park or withdraw something.
- The change idle sweepers are unchanged: pause after 5 min idle, worker eviction at 10 min. The Mayor resumes a paused active change automatically on the next dispatch.
- An agent session has nothing to sweep. Auto-archiving long-idle sessions is left for later, if lists get long.

## App hint

The entry point passes whatever context it has when the session is created, and the server stores it as the session's focus. The Mayor treats the focus as a starting assumption, never as a limit.

**Capture.** The hint is taken from the entry point's own state, not `App.currentApp`, which is cleared before the Messages and chat screens open (`app.js:5586`).

| Entry point | Hint sent |
| --- | --- |
| Improve “New change”, Workshop “Start here”, app dev “new”, in-session “New change” banner | `{slug}` from `improveStore` or the current session |
| Issue “Start work”, Feedback “fix it” | `{slug, issueNumber}` |
| Proposal “Explore in dev chat” | `{slug, proposalId}` |
| Messages “+” → Agent chat, Messages → Agents “New” | none |

A request card's “Start work” also puts the request's title in the hint, for the screen only (`issueTitle`; `serverHint` in `frontend/src/features/agent-session/api.ts` drops it before either call). The unsent conversation says “Request #N”, its title and its app, and the box holds `Work on request #N: "<title>"`, unsent and editable, where the dev chat's Start work seeded its own box (`request-seed.ts`). The seed is not kept as unsent text until it is edited, so it never turns up in a later New change; it replaces what an earlier unsent conversation left in the box. The Mayor reads the request itself from the session's focus, which is why the seed names the request instead of pasting its description.

**API.** `POST /api/agent-sessions {hint?: {slug, issueNumber?, proposalId?}, message?}`.

- The server resolves the slug with the user's normal app access. If the user can't see the app (for example, the platform row when `restricted`), the hint is dropped, not refused.
- The server stores `focus_app_id` and `focus_context`.
- If `message` is present, the first turn starts straight away. Otherwise the session opens empty and shows starter pills for that app.

**What the Mayor does with the focus**

- The prompt carries “The user opened this from \<app>”, plus the issue title or the proposal's PR number, fetched through MCP on the first turn.
- An ambiguous request (“add dark mode”) goes to the focus app. A request that names another app, or clearly concerns the platform, goes there, and the Mayor says so in one line before `start_change`.
- The focus moves when the active change moves to another app, or when the Mayor calls `set_focus_app`. The header shows the current focus (see UI).
- With an issue hint, `start_change` passes `linkedIssues: [n]` and claims the request, as “Start work” does today. As built, the card defaults it (see "Follow-up: who is working on a request" under the implementation plan), so the claim does not depend on the model remembering.

**Re-entry.** Every entry point creates a new agent session with its own hint. It never takes over an existing conversation. Earlier sessions stay in Messages → Agents, and the user can go back to any of them.

## UI surfaces

There is one new screen, the agent session. Four existing surfaces change. Mockups of these surfaces (11 screens, matched to the live UI at `3688f54`) were reviewed before implementation; proposal 4 carries the real screens.

| Surface | Change |
| --- | --- |
| **Agent session screen**: `#agent/<id>` on phones; on desktop, the Messages pane at `#messages/agent/<id>` (the address Global Chat uses today) | **Header:** title, focus-app chip (tap to change), active-change pill (“PR #N · Voting 3/5” or “Building…”). **Transcript:** today's dev-chat pieces (Mayor replies, agent progress, completion card, spec-updated card, staging-ready card, pills), plus confirmation cards and change dividers (“Started: Dark mode · Whiteboard”, “Switched to …”, “PR #N merged”). **Composer** (as built): one rounded card. The box sits on top. Below it: `+` (the device's own photo and file picker), the model pill (it opens a sheet on a phone and a popover on desktop, grouped Claude Code / Codex, with the thinking level and the week's credits), and a gray "$X left" pill. Send (or Stop, or Save) sits inside a ring that empties clockwise as the allowance goes: green above 40% left, yellow down to 15%, red below. |
| **Changes drawer** (inside the agent session) | The active change's spec, staging preview, checks and votes, reusing the existing spec viewer and `StagingOverlay`. Below it, parked and closed changes with “Switch to”. |
| **Messages → Agents** | Agent-session rows (title, focus-app tile, active-change status, last activity) sit above classic session rows. Global Chat rows still appear for people who turned Global Chat on, labelled apart from agent sessions. “+” → Agent chat opens a new agent session with no app picker. |
| **Change page** `#app/<slug>/dev/proposals/<id>` for a change started from an agent session | Status, preview, spec, checks and votes as today. For the owner, the transcript slice is read-only, and the composer is replaced by “Continue in agent session”. Other members see what they see today. |
| **Entry points** (see Rollout) | Same buttons and labels. With the flag on they open the agent session with a hint instead of a classic session. |
| **Settings → Experimental** | An “Agent sessions (experimental)” switch, shown to admins only until stage 2, and retired in stages 3 and 4. The Global Chat section stays as it is. |

**Implementation constraints** (from AGENTS.md)

- The agent session is a new React-owned island: `AgentSessionScreen`, with its own store fed by the agent-session stream. It reuses dev-chat's presentational React components through a store adapter. It does not host `dev-chat.js`, so no legacy module writes inside the subtree.
- The first render emits hidden, empty markup, and data loads in effects. Visibility goes through `visibility-store`. The id is listed in `SCREEN_IDS` and `REACT_SCREEN_IDS`, and in `_BACK_SLOT`, `TAB_FOR_SCREEN` and the boot-screen map.
- New static ids go in `ADDED_IDS` with a reason. The baseline is never refreshed. The bundle needs no `SHELL_ASSETS` change.
- New `dapp.json` checks cover: create from Improve with a hint, a confirmation card, the changes drawer, and the desktop Messages pane.

## Global Chat

Global Chat stays exactly as it is, behind its own toggle, whatever the agent-sessions flag says. The two flags are independent, so nobody who uses Global Chat has to turn it off. Retiring it is a later, separate decision. Two of its parts move into shared code so agent sessions can use them too.

**Reused**

- **Sealed one-use confirmations** (`global-chat/actions.js`, the confirm route, `CONFIRMATION_POLICIES`) move to `src/services/confirmations/` and back the Mayor's confirmed writes.
- **Messages pane plumbing:** the `#messages/agent/<id>` address, the phone swap to a full-screen route, and the Agents filter.

**Not reused**

- The GLM operator model, its profiles and monthly cap.
- The capability registry.
- The generated 663-route inventory and its generator.
- The suggestion executor and the tool protocol.

The Mayor uses the normal per-user LLM budget instead of the monthly cap.

**Side by side**

- Messages → Agents shows agent-session rows for users with the agent-sessions flag on, and Global Chat rows for users with Global Chat on. A user with both sees both, each labelled.
- The `agentsOn = parityReady && enabled` gate stays as the gate for Global Chat rows only. Agent-session rows get their own gate on `App.user.agentSessionsEnabled` (retired with the flag in stages 3 and 4: every viewer has them).
- `#chat/<id>`, Global Chat's settings section and `/api/global-chat/*` do not change.
- Global Chat's “start development” handoff keeps creating a classic session. Pointing it at agent sessions is out of v1. (Done in stages 3 and 4: it opens an unsent agent session with the task.)

**Existing Global Chat threads** stay where they are, for as long as Global Chat does.

**If Global Chat is retired later** (its own decision and PR), the removal touches:

- **Server:** `routes/global-chat.js`, `services/global-chat/*`, the six `global_chat_*` tables, and the `package.json` inventory scripts.
- **Client:** `GlobalChatScreen` in `Shell.tsx`; the `#chat` route, `SCREEN_IDS` and `REACT_SCREEN_IDS` entries, and `_BACK_SLOT` in `app.js`; `global-chat-screen` and `global-chat-composer` from `ADDED_IDS` (they were never in the frozen baseline).
- **Other references:** `llm-telemetry`, `debug-access` and `db-console-scope`.
- **Tests:** the \~20 `global-chat-*` tests, and the screen lists in `visibility-store`, `screen-transition-order`, `boot-screen` and `react-screen-ids-consistency`.

**As built: Global Chat removed (October 2026).** Nobody had used it for over a month, so its code, settings, checks, copy and tests went in one change. The shared OpenRouter transport it carried moved to `services/openrouter.js` and the platform's effort scale to `services/reasoning-efforts.js`; the server-error observer reads its route-to-file map from the route files themselves. Its old addresses (`#chat`, `#chat/<id>`, `#messages/agent/<uuid>`, `#settings/global-chat`) open Messages. The six `global_chat_*` tables stay for now, with their account-deletion, user-merge and private-data entries, so the transcripts stay out of the admin database console; dropping them is a later change. The `global-chat` entry hint stays accepted, for the agent sessions Global Chat started.

## Security

The design rests on two rules. The Mayor never writes without the user's explicit confirmation. The coding agent's token can read only one app's data, and only for one turn.

| Risk | Mitigation |
| --- | --- |
| The worker token leaks: the agent runs untrusted repo code with Bash and internet access, so assume it can read the token | `worker_read` is bound to one app and one change, allows 6 read tools, lasts one turn, is revoked in `finally`, and is limited to 60 calls/min. Worst case: reading data on one app that the user can already see. |
| Prompt injection into the Mayor through request bodies, proposal titles or the agent's completion text | Results stay wrapped in `<untrusted-content>`. Every platform write needs a confirmation card showing the exact input. The model can't confirm, and chat text like “yes” is not a confirmation. |
| A confirmation replayed or altered | The token is sealed and single-use, bound to user, agent session, tool, exact input, expiry and object revision. Authorization is re-checked when it runs (Global Chat's existing design). |
| A delegated token is escalated or kept alive | No refresh token. The synthetic client can't use consent or token endpoints. The kind is set by the server. There is a route allowlist per kind, and liveness is checked on every request. |
| Acting beyond the user's rights | Every MCP call is authorized as the user through the normal routes. Platform-app work keeps today's access rules and self-edit guardrails. `get_prod_status` stays admin-only. |
| Privacy of the conversation | The transcript is visible only to its owner. Other members see a change's proposal page as today. Sharing and forking transcripts is not in v1. |
| Runaway cost | `start_change` is confirmed. Change caps and per-user budgets are unchanged. There is one Mayor turn at a time per session. |
| Audit gaps on the in-process path | The shim writes `token_used` rows. Issuing and revoking delegations are audited in `mcp_auth_audit_events`. |

**Known gap, not fixed here.** In k8s, `trustDirectPeer` lets a worker pod set `X-Forwarded-For`, so the per-IP limiter can be evaded. The per-token limit still applies. A follow-up issue will track it.

## Cost and models

Billing follows today's rules. The one real change is that the Mayor's model is chosen separately from the coding agent's, because an always-open session runs more Mayor-only turns (status questions, reads) than a per-change chat does.

- **Today.** A Claude session's Mayor runs on the session's selected model, which is also the coding agent's model (`sessions.js:5418`, default `claude-opus-5-5`). OpenRouter sessions use the session's OpenRouter model at low effort.
- **Agent sessions.** `mayor_model` defaults to the user's current coding model, so behaviour matches today. Users can pick a cheaper Mayor model in the session's settings. The coding agent's backend and model are set per session and copied onto each change at `start_change`.
- **Who pays.** Unchanged: `checkBudget` / `resolveBillingPath` per user, BYOK or the platform pool, OpenRouter managed keys. Spend is recorded against the change when one is active, and against the user alone otherwise.
- **Telemetry.** Per-invocation telemetry gains `agent_session_id`, so Mayor spend can be reported separately from build spend.
- **Compaction** is one low-effort call when history passes the budget, billed like a Mayor call.
- **MCP reads** are loopback HTTP and cost no model spend. They count against the per-agent-session rate bucket, proposed at 120 calls/min.

The open question is whether the Mayor default should stay the coding model or move to a cheaper one.

## Testing

The bar: classic sessions behave identically, proved by golden tests taken before the Mayor extraction, and every new write path has a negative test.

**Parity (before any behaviour change)**

- Golden tests capture the event sequence and persisted rows of `POST /api/sessions/:id/chat` against a scripted fake LLM, for: reply-only, scout, build, stop mid-build, refusal and fallback, and the OpenRouter direct turn. The extraction PR must leave them byte-identical.
- The \~22 tests that read `sessions.js` source text are re-pointed to the new service files, with their assertions unchanged.

**New unit and contract tests**

- **Agent sessions:** the flag gate (403 when off), creating with and without a hint, a hint for an app the user can't see is dropped, the one-turn lease, archive and unarchive.
- **Changes:** `start_change` parks the previous change, respects caps and links issues; `switch_active_change` resumes; close hooks post the system row and clear the pointer.
- **Transcript:** the trigger stamps `agent_session_id` for every writer, including recovered wrap-ups.
- **Confirmations:** single use; rejected when the input is altered, the user or session is different, or the token has expired; authorization is re-checked when it runs.
- **Delegated tokens:** issue; liveness; revocation; per-kind allowlist; `worker_read` rejects another app's slug; no refresh; hidden from `/api/me/connectors`.
- **Charter:** character budgets for each variant; the worker conventions preamble.
- **Worker bridge:** the tool allowlist; the token stays out of the shell environment and output.
- **Compaction:** the trigger threshold, and the last 10 turns kept verbatim.

**Shell and UI**

- `ADDED_IDS` entries with reasons.
- Updates to `react-screen-ids-consistency`, `visibility-store`, `screen-transition-order` and `header-back-home`.
- New `dapp.json` checks, flag on: Improve “New change” opens an agent session showing the focus chip; a confirmation card renders; the changes drawer; the desktop Messages pane. Flag off: today's flows unchanged. In either state, Global Chat is unaffected.

**End to end on staging, before stage 2**

On a test app, run the full loop:

1. start;
2. scout, then build;
3. preview and checks;
4. promote, vote, merge.

Then, in the same conversation, a second change on another app, and an admin change on the platform app.

## Implementation plan

The plan is five proposals, each shippable on its own. None changes what a user sees until the flag is on. Each one takes its base commit from `prepare_work`, is submitted through the connector for a vote, and says `Refs #2779`. Upstream `main` was at `3688f54` on 2026-09-23.

| # | Proposal | Contents | Visible change | Size / risk |
| --- | --- | --- | --- | --- |
| 0 | UI mockups | Mockups of the surfaces above, for your review before any code. Nothing is committed. | None | Small |
| 1 | Extract the Mayor | Golden parity tests first, then `src/services/mayor/*`. The classic route calls the service. This spec is committed as `docs/agent-sessions.md`. | None | \~2.5k lines moved. **Highest risk.** |
| 2 | Delegated MCP and native-change tools | `mcp_delegations` and `issueDelegatedAccess`, allowlists per kind, charter variants, `get_change`/`start_change`/`promote_change`/`recheck_change`/`sync_change`/`withdraw_change`, the staging gate fix, the confirmations service moved out of Global Chat | `external` clients gain `get_change` and `recheck_change` | Medium |
| 3a | Agent sessions data | The flag column and route, `agent_sessions`, the new columns and trigger, `/api/agent-sessions/*` (create with a hint, list, read, rename, archive, the transcript), linking a Mayor's `start_change` to its session and parking the previous change, the close hooks, agent-session liveness for delegations | None (API only, behind the flag) | Medium |
| 3b-i | The agent-session Mayor, talking | The turn route and its stream, the turn lease, stop, the in-process MCP shim, the global Mayor prompt, confirmation cards and their table, `switch_active_change` and `set_focus_app`, issuing delegations and sweeping expired ones | None (API only, behind the flag) | High |
| 3b-ii | The agent-session Mayor, building | Dispatch to the active change (`dispatch_scout`, `dispatch_coding_agent`), forwarding the change's events to the conversation, the wrap-up, the follow-up turn after a confirmation, compaction, the Mayor-internal tools | None (API only, behind the flag) | High |
| 4 | Agent sessions UI | `AgentSessionScreen`, the changes drawer, Messages rows, entry-point routing with hints, the owner view of the change page, the Settings switch, `dapp.json` checks | Only for users with the flag on | Medium |
| 5 | Read-only MCP for the coding agent | `worker_read` minting, `homeroom-read-mcp.js`, Claude and Codex config, the prompt block | None visible | Small to medium |
| later | Stage 3 and 4 | Flip `AGENT_SESSIONS_DEFAULT`; then remove the classic creation path. Global Chat is decided separately | Everyone | Separate decision. Shipped as one change: see *As built: stages 3 and 4* |

**Order.** 1 and 2 are independent and can be voted on in parallel. 3 needs both. 4 needs 3. 5 needs 2 and can land any time after it. Step 3 was split in two when it started (3a, then 3b), because the data layer is reviewable on its own and the Mayor turn is the riskiest part of the whole plan. 3b was split again the same way: 3b-i is a Mayor that reads and proposes, 3b-ii is the Mayor that builds. After 3b-i merged, 3b-ii, 4 and 5 were folded into one proposal, so that the Mayor that builds ships together with the screen that shows it and the reads the coding agent gains from it.

**As built in 3a.**

- `users.agent_sessions_enabled` is read into `req.user` as `agentSessionsChoice` and `agentSessionsEnabled`. `/api/auth/me` reports `agentSessionsEnabled` and `agentSessionsChoosable`. `POST /api/me/agent-sessions {enabled: true | false | null}` answers 403 when the opt-in audience is `admins` and the user is not an admin. Since stage 2 the audience defaults to `all`; `AGENT_SESSIONS_OPT_IN=admins` restores the stage-1 gate.
- Only creating a session checks the flag. Reading, renaming and archiving check ownership alone, so turning the flag off never hides a conversation.
- `POST /api/agent-sessions` takes `{hint}` only. The first message arrives with 3b's turn route.
- `POST /api/apps/:slug/sessions` accepts an optional `title`. `start_change` names the change on the create itself, so the rename route is not on the Mayor's list.
- A delegated Mayor grant that names an agent session makes the new change that session's active change, after parking the previous one and before the cap counts it.
- Conversation-level rows (a change starting, a change closing) have `session_id` NULL and `metadata.agentSessionEvent`.
- Account deletion removes those rows before the user row, because `chat_session_messages.agent_session_id` is `SET NULL`, not `CASCADE`, so that a change's own rows outlive their parent.
- Global Chat's route inventory exempts `/api/agent-sessions/*`: one assistant does not drive another.
- The confirmation-token table and the delegation sweeper moved to 3b, where the first confirmations and delegations are created.

**As built in 3b-i.**

- The agent turn is its own module, `services/mayor/agent-turn.js`, not a generalized `turn.js`. The classic turn is untouched, and so is its golden test. A turn is one loop of at most six model rounds; the last round cannot call tools. There is no dispatch and no mayor2 yet, so there is nothing to wrap up.
- `POST /api/agent-sessions/:id/turns {message, model?}` streams the same event protocol as a change's chat, on bus key `agent:<id>`; `GET /api/agent-sessions/:id/events` resumes it and `POST /api/agent-sessions/:id/stop` stops it. The user's message lands on the active change's transcript when there is one, and on the conversation's otherwise. An untitled conversation takes its title from the first message. One opened on a request (Start work) is then named after that request, `#N · <title>`, once the request is read (`agentSessions.nameFromRequest`, #3752); a name the owner chose is never replaced.
- The lease is a row write on `agent_sessions.active_turn`, taken with one conditional `UPDATE`, so two tabs or two pods cannot both start a turn. A lease not renewed for 90 seconds belongs to a turn whose process died, and is taken over (it was 20 minutes, then 3; see "Keeping every screen in step with the server"). Only the turn holding the lease releases it.
- The Mayor follows the user's default coding backend, as the spec says. OpenRouter users get `openrouter-mayor.js` keyed `homeroom-agent-<id>`; everyone else gets Anthropic with today's budget and BYOK resolution. `mayor_model` is not read yet: the model is the request's, or the default.
- Each turn issues an `agent_mayor` delegation with read scope, bound to the conversation, and serves the Mayor's tools through `services/mayor/mcp-shim.js`: an `McpServer` and a `Client` over `InMemoryTransport`. The shim writes the `token_used` audit row and spends from an `agent-mayor-mcp` bucket of 120 calls a minute per conversation before every call, and revokes the grant when the turn ends, however it ends. Results are cut at 24k characters.
- A confirmed tool never runs from the model. The turn seals its exact input into `agent_session_actions` (the shared core in `services/confirmations`) and the model reads back `pending_confirmation`. The card's own id is the handle: `POST /api/agent-sessions/:id/actions/:actionId/confirm` claims the row in one statement (pending, unexpired, the owner's, in an open conversation), so a card runs at most once however many presses race. It then opens the sealed input against its fingerprint and runs it on a one-action write grant bound to the change or app the input names, revoked when the call returns. The outcome is stored on the card and appended to the conversation as an `action_result` event. Cards expire after 15 minutes; expiry is read from `expires_at`, so nothing sweeps it. A delegated bearer cannot reach these routes, because they are on no delegation allowlist.
- `recheck_change` is the one write that runs at once, on its own one-action write grant bound to the change, because it changes nothing a user could regret.
- `switch_active_change` and `set_focus_app` are the Mayor's own moves: they change the conversation, not the platform, so they need no card. Switching accepts only an unmerged, unarchived change this conversation started, parks the previous one and appends a `change_switched` event. The focus is resolved with the user's own access.
- History replays the conversation's last 120 rows. The platform's own events (a change starting, closing, switching; a card's outcome) reach the Mayor as `[HOMEROOM]` notes in the assistant's voice, because the Messages API has no system turn.
- An hourly sweeper deletes delegations a week after they expired or were revoked, and their token rows with them.
- Not yet: dispatch, the follow-up turn after a confirmation (the Mayor reads the outcome on the next turn instead), compaction, and the Mayor-internal tools (`web_fetch`, `draft_issue_report`, `get_prod_status`, the reply pills). The prompt tells the Mayor that building from a conversation is not switched on yet.

**As built in 3b-ii, 4 and 5 (one proposal).**

*The Mayor builds (3b-ii).*

- Dispatch is `services/mayor/agent-dispatch.js`. It has no worker of its own: it runs the classic `runScoutTool` and `runClaudeCodeTool` (exported from `routes/sessions.js` as `MAYOR_TURN_DEPS`) on the conversation's active change. The worker, the durable turn record, the PR, staging, checks, the vote revision and the coding agent's spend all stay the change's, exactly as for a classic build.
- The two dispatch tools are offered only on a round where the active change can take one: it exists, it is not merged or archived, it has a repository, and nothing else is running on it. A parked change is reopened first, through the platform's own `POST /api/sessions/:id/resume` on a one-action `agent_mayor` write grant, so the caps and the LRU pause apply as they do in the browser. `dispatch_coding_agent` takes a prompt only; the model is the change's.
- A dispatch ends the tool loop. At most one runs per turn, and when the model asks for both, the scout runs. The Mayor's reply so far is recorded before the dispatch starts, so a crash mid-build does not lose it.
- The run's events reach the conversation (its SSE response and `agent:<id>`) and the change's own channels (its bus key and the global WebSocket), so the change page and the Dev board see a build started from a conversation like any other. `done` and `stopped` go to the change only; `token`, `usage` and `error` stay off the WebSocket, as in a classic turn.
- The wrap-up is a second Mayor call (`mayor_phase_2`) offered only `suggest_replies`, and it cannot be stopped, as in a classic session. With no payer left, a plain fallback line is recorded instead. The change's durable turn is finished only after the wrap-up (`deferTurnCleanup`), so a restart during the wrap-up is recovered the classic way.
- Stop: during the Mayor's own rounds, `POST /api/agent-sessions/:id/stop` stops the turn. During a dispatch it answers `{stopped: false, reason: 'dispatch_running', changeId}`, and the client calls the change's own `POST /api/sessions/:changeId/stop`, which keeps its kill confirmation and force escalation. During the wrap-up it answers `wrap_up_not_stoppable`.
- The turn lease lasts exactly as long as its turn: taken with the turn's `Asked`, released when its work item ends, never renewed and never taken over.
- After the user confirms a card, the Mayor takes a follow-up turn on its own. That turn records no user message: the card's outcome is already in the conversation.
- Compaction (`services/mayor/agent-compaction.js`) runs after a turn when the replayed history passes about 60k tokens (characters / 4). It keeps the last 10 user turns word for word and folds everything older into `agent_sessions.summary_md` with one Mayor-model call. `summary_through_id` only moves forward, through a conditional `UPDATE`. The summary reaches the prompt inside an untrusted-content block.
- Mayor-internal tools: `web_fetch`, `suggest_replies`, and `get_prod_status` when the active change is eligible for production debug access (an admin's change on the platform app), the same rule a classic session uses. `draft_issue_report` is left out: filing a request from a conversation is `create_request` behind a card.

*The screen (4).*

- `AgentSessionScreen` (`features/agent-session/`) is a React island at `#agent/<id>`. On a desktop the same panel opens in the Messages pane at `#messages/agent/<id>`, and on a phone that address swaps to the full screen. The drawer has its own deep link, `#agent/<id>/changes`. It has its own store, fed by the turn's SSE stream and the conversation's events stream (resumed after a reload), and it hosts no `dev-chat.js`. The transcript rules are one pure module, `transcript.ts`, pinned by `tests/agent-session-ui.test.js`.
- Header: the focus-app chip, the active-change pill and a Changes button. Transcript: the user's and Mayor's messages, change dividers, confirmation cards with the exact input they will run with (Confirm and Not now), the coding agent's completion, and preview-ready rows. The composer is a plain text box.
- The changes drawer shows the active change (status, preview, a link to its proposal page) and every earlier change with "Switch to" (`POST /api/agent-sessions/:id/active-change`).
- Messages lists agent sessions under Agents on the one clock. A classic session row for a change that an agent session started is not listed twice. "+" → "Agent session" starts one, with the flag on.
- Entry points: Improve's new change, Messages' "+", the dev chat's "New change" banner, a proposal's "Explore" and a request's "Create PR" start an agent session with a hint when the flag is on, and the classic session otherwise.
- The change page: for the owner of a change an agent session started, the dev chat's composer is replaced by a "Continue in agent session" banner, and the change's door opens the conversation.
- Settings → Experimental carries the switch, shown only to a user the server says may choose it.
- Staging seeds one conversation (id 990801, the capture admin's, with a pending `promote_change` card on change 990802), so two `dapp.json` checks can load it by address: the desktop Messages pane beside its inbox row with the card's Confirm and Not now, and the screen's bar with the changes drawer open. The manifest keeps 20 of its 810 slots clear, which left room for two; the Settings switch has no declared check. The seed does not turn the flag on: reading a conversation needs ownership alone. Starting a session from Improve is not a declared check, because a check only loads an address.
- Not in v1: the focus chip is a label, not a picker (the Mayor changes the focus with `set_focus_app`); the composer has no model picker and no attachments; the drawer links to the change page for the spec, checks and votes rather than embedding the spec viewer and `StagingOverlay`.

*The coding agent reads the platform (5).*

- The `worker_read` grant is minted in `execInWorker` for build and scout turns, not in `buildTurnSecretEnv`, which only carries it. It is bound to the change's owner, the change and its app, with a two-hour backstop expiry, and it is revoked on every exit of the turn. Minting is best effort: without a grant, the agent runs as before.
- The token reaches the worker only as `HOMEROOM_MCP_TOKEN` in the turn's environment. The bridge's config, `/usr/local/share/usernode/homeroom-mcp.json`, is baked into the image and carries no secret.
- `worker/homeroom-read-mcp.js` proxies the six `WORKER_READ_TOOLS` to `PLATFORM_URL/mcp`. It drops any other tool the server lists, and it offers no tools at all without an `svmcd_` token.
- Claude Code: build gets the bridge next to the pinned browser (`--mcp-config` twice, `--strict-mcp-config`); scout gets the bridge alone. Codex: a `[mcp_servers.homeroom]` block, the token excluded from the shell environment policy, a leak guard and output redaction. Log redaction also covers `svmcp_` and `svmcd_` tokens.
- The build and scout prompts carry a short note naming the six tools, when the turn runs on Homeroom (not on the user's own machine).

*Follow-up: the side panel.* While an app is running on a desktop-width window, an agent session opens in the side panel beside it, the way the Workshop, conversations and classic changes do: starting one from New change or the Workshop's Start here, and opening one from a link. The panel's route table knows `agent/<id>[/changes]` and `messages/agent/<numeric id>` as one page. Back climbs to Messages, the header shows the session's title, and Expand lands on the conversation beside the inbox (`messages/agent/<id>`). The agent store asks the panel first and navigates as before when it declines. `start()` no longer takes a first message, which no caller used: a message sent from the top document's store would not reach the conversation once the panel has it.

*Follow-up: unsent sessions and the model picker.* Two changes to the composer, in one proposal. Together they replace the "no model picker" item under *Not in v1* above.

- **Nothing is created until the first message.** New change (every entry point) opens an unsent conversation at `#messages/agent/new`, which is `#agent/new` on a phone and `agent/new` in the side panel. The store holds it as a `draft`: the hint, and the model picked meanwhile. `GET /api/agent-sessions/draft` resolves what the hint names (the app, with the same view rule `POST` applies) and writes nothing, so the bar can say "started from Notes". The first send creates the session with `POST /api/agent-sessions {hint, agent}`, swaps the address for the session's own with `replaceState` (the router's same-id checks keep the store as it is), then posts the message. Opening New change and leaving writes no row, so no empty conversation appears in Messages. In the side panel, the hint travels as `PanelHint.agentHint`, on the frame's boot or on its `go`, and the panel's own document creates the session. The panel's route updates in place, so Expand reaches the session and not a fresh draft. A reload of `#agent/new` opens an empty draft: the hint is not in the address.
- **One model choice per conversation, changeable at any time.** The composer has a picker in the dev chat's style. It offers Claude Code on an Anthropic model, or Codex on an OpenRouter model, with a reasoning-effort control when that model offers one. The options are the platform's recommended OpenRouter models, the Anthropic models, the saved default and starred favourites. The full catalog stays in the dev chat. The choice is stored on `agent_sessions` (`agent_backend`, `agent_model`, and the new `agent_reasoning_effort`) through `PATCH /api/agent-sessions/:id/agent`. It is validated as the dev chat validates a pick: an allowed Anthropic model, or `resolveExplicitAgentPreference` for OpenRouter. It is also remembered as the user's default, as a dev chat pick is (#1348). A conversation with no choice follows that default.
  - The **Mayor** reads the choice when each turn starts, so a pick made mid-turn applies from the next message. (The composer said so while a turn ran; that line was later removed.)
  - A **change the conversation starts** (`start_change`) is created on the conversation's choice, with a browser pick's exact-or-refuse rule.
  - The **active change** takes the choice at its next build. A different backend, OpenRouter model or effort switches the change first, through the dev chat's own reset (`switchSessionAgent`, extracted from `POST /api/sessions/:id/reset-agent-context`). The change keeps its branch and conversation, starts a fresh agent context, and its transcript says so. A Claude model is chosen per run instead, as the dev chat chooses it per turn, so it needs no reset. A build already running finishes on the model it started with. A switch refused because the change is busy is logged, and the build runs on what the change has.
  - `mayor_model` stays unused: one choice drives both the Mayor and the coding agent, as in a classic session. That settles the open question under *Cost and models* for now.

*Follow-up: first-use fixes.*

- **The side panel survives a reload.** While it is open, the top window's address carries `?side=<route>`, written with `replaceState` so it adds no history entry, and every other parameter kept as the router keeps them. A reload, or Back to the app, reopens the panel on that page once the app is on screen. Closing the panel or leaving the app takes the parameter out. The panel's own document never inherits it.
- **A coding-agent run is one card.** A change writes a run as several rows, and the conversation now folds them into one run item. The rows are: the start line, the running line, the progress row, any raw log, the steps on the way (the PR, the preview build), and the end. The end is the drafted spec, the completion, a failure or a stop. The item is drawn with the dev chat's own run card (`Attached`): a status line that opens in place onto the run's log, or onto a build's summary.
  - The progress row's content is the fixed text "Claude Code progress" whatever agent runs, so it is recognised by its `progressLog` and its words are never shown.
  - The card's caption names the agent from the rows' `agentBackend`: an OpenRouter change runs the Codex CLI and says "Codex · <model>". It never ran Claude Code; only that text said so.
  - While a build runs, the card carries the live progress line and clock, and replaces the separate activity line.
- **A drafted spec is a card.** It is the dev chat's spec card. It opens a read-only spec viewer over the conversation, at the version the card names, with the change's other saved versions to switch to. The viewer reads the change's own `GET /api/sessions/:id/spec` and `/specs/:version`. The changes drawer's active change gets a Spec button that opens the latest version. Sharing and mentions stay on the change page's own viewer.
- **Staging shows both.** The seeded conversation 990801 now carries, on its change 990802, a scout run on Codex, the spec it drafted (two saved versions) and a build run. These are the same rows a real run writes, so the screen folds them the same way. A preview seeded before this gets the rows added on its next boot.

*Follow-up: where your work in progress is, and "paused" goes backend-only.* Four lists answered "what am I working on" with four rules: the Workshop listed a paused session, Messages and the bell hid it, Recents listed no sessions at all, and the platform mark's menu had nothing. They now share one set of rules.

- **Paused is never shown and never asked for.** The status stays in the database, because it is what the caps count, but nothing names it.
  - The platform pauses a session five idle minutes after it was used.
  - Starting new work at the per-user cap pauses the user's least recently used session instead of refusing. `session-lifecycle.freeUserSlot` does this, the same step the resume route always took; it is used on create, clone, fork, the CLI hand-off and a connector's share.
  - Opening, messaging or syncing a session resumes it. `POST /api/sessions/:id/chat` and `sync-main` call `resumePausedSession`, which is extracted from the resume route. A change an agent session owns is refused by the chat route (its conversation is the agent session's) before anything is resumed, because a resume spends a slot and can pause another session.
  - Gone from the UI: "Parked", the Workshop's "paused" chip, the dev chat's Pause and Resume buttons (Free worker and Archive stay), and "Pause or archive one first".
  - The issue chip keeps its internal state but reads "Started · <user>", saying when that person last worked on it.
  - The Mayor's prompt and the MCP tools say "idle" or "keeps its progress" instead.
  - The one refusal left is "Your other sessions are all busy finishing turns".
- **A conversation stands for the changes it started.** Messages already listed the conversation rather than its changes. The bell's session rows and the Continue rows now open the conversation too.
- **Continue under the platform mark.** Up to three of your in-progress items on the menu's app sit directly under Go to workshop, conversations first, then "See all your work", which opens Messages filtered to Agents. Go to workshop still opens the list, as #2761 decided and a declared check pins. (Since reordered: see *what each conversation is doing* below.) The rows are drawn after mount only, so the prerender and the hydrating render match. A conversation nothing was said in yet (no title, since the first message titles it, and no change) is not work in progress and is left out.
- **The bell.** A scout or build that finishes while nobody is watching creates the dev chat's own `session_done` notification on the change: one unread per change. Watching means the turn's stream is still open, or the conversation screen follows its events (`session-bus.subscriberCount`). The notification carries `agentSessionId`, so it opens the conversation and reads "The coding agent finished". Reading the conversation (`GET /api/agent-sessions/:id`) marks its changes' rows read, however the user got there, as opening a dev session does for its own.
- **Recents** lists open agent sessions by their last activity, next to your conversations. Like Messages, Recents and Continue read them for any signed-in viewer, whether or not agent sessions are turned on: the flag gates starting one, and turning it off never hides a conversation that already exists. Empty ones are left out of both.

*Follow-up: the spec beside the chat, in two tabs.* The spec viewer covered the whole conversation, even on a desktop, and showed a spec as one document. Both now follow the dev chat's own viewer (`agent-session/spec-layout.ts`).

- **Beside the chat from 1024px up.** The spec is a right-hand pane next to the conversation, with a divider between them.
  - The divider drags, and moves with the arrow keys.
  - The width is the dev chat viewer's remembered one: the same `localStorage` key, a 480px default and a 280px floor. The chat always keeps at least 320px, and CSS holds the same bounds when the window narrows.
  - The width is read after mount, and the layout is decided after mount, so the first render matches the prerender.
- **Messages makes the room.** While a spec is open beside an agent session, the conversation list steps aside. At 1280px the thread pane alone is about 680px, too narrow for two readable columns. Closing the spec brings the list back.
- **Narrower windows keep the sheet.** Below 1024px the spec is still a sheet over the conversation. That includes the side panel beside a running app, which is a document of its own at the panel's width.
- **Two tabs when the spec has two halves.** A spec under "## User-facing changes" and "## Technical implementation" (the scout's required structure) shows as the dev chat viewer's User-facing and Technical tabs, with the same classes.
  - The title and summary sit above the tabs.
  - The plain-language half shows first.
  - The tab is kept across a version switch and reset for another change.
  - The split is the page's own `splitSpecSections`, so a spec without both headings shows whole, as before.
- **Staging** writes the seeded conversation's spec in the two halves, so the tabs can be seen there. A preview seeded before this picks up the new text.

*Follow-up: what each conversation is doing, in every list, and the mark's menu reordered.*

- **One mark, three lists.** Beside an agent session in Recents, the platform mark's Continue rows and Messages (where a conversation's unread count goes):
  - a spinner while it is working, meaning its turn lease is held, which covers a scout or build the turn dispatched;
  - a green dot (the live-app dot's `green-500`) once it has finished something you have not read yet;
  - nothing otherwise.

  `agent-session/activity.ts` decides it from the session's `busy` and `doneUnseen`, and `activity-mark.tsx` draws it.
- **Finished, and seen.** Two columns on `agent_sessions` hold it.
  - `last_done_at` is stamped when a turn that ran releases its lease (`releaseTurnLease(..., { finished: true })`). A lease handed back before its turn started (no Mayor, no payer) stamps nothing.
  - `seen_at` is stamped by `GET /api/agent-sessions/:id` before it reads, so the answer already carries no dot.
  - `doneUnseen` means not working, and finished after it was last seen.
  - Reading the conversation clears the dot. The store keeps the list's entry equal to the conversation on screen, so the lists follow at once.
- **Live.** The owner gets `agent_session_changed` over the per-user socket (`pushToUser`, which reaches every pod) when a turn starts, when it ends (after the lease is back), and when a read clears a dot in another tab. `app.js` hands it to the store, which reads the list once per burst.
- **The mark's menu.** Go to workshop, the app's (or platform's) discussion and About are the app's own section. Continue sits below them and lists agent sessions only: classic changes are the Workshop's, one row up. Its last row reads "See all sessions".
- **The composer's pickers say what they are.** Closed, they read "Model: Opus 5.5" and "Thinking Level: High". Open, the list marks the default "(default)": the model a conversation with no choice of its own runs on, and the deployment's default effort.
  - A native select shows the chosen option's own text when closed, so the shown line is drawn beside a transparent select, which keeps the focus, the keyboard and the platform's own list (`LabeledSelect`).
  - The default effort is the follow-the-default option itself (`''`), not a second "Default (High)" entry beside "High". A conversation that names the default effort shows as following it (`effortValue`).
  - The "applies from your next message" line beside them is gone: the next message simply runs on the new pick.

*Follow-up: staging builds as cards, with the preview beside the chat.* A build used to say "Staging deployed!" with a link that opened a new tab.

- **Every build is a card** (`PreviewCard`, from `transcript.ts`'s `PreviewItem`):
  - **Deployed:** Open preview, Open draft proposal (the change's page, `#app/<slug>/dev/proposals/<id>`; it was "View change"), and Propose to group while it is active or paused. Once proposed it reads "In vote", with View proposal, as a merged change does.
  - **Failed** (the `stagingFailed` row the build writes, previously folded into the run's steps): the error, Retry, and Propose to group. Proposing rebuilds the preview itself, as in the dev chat.
  - **Checks:** the card says where the change's checks stand ("Checks running", "Checks passing", "2 checks failing"), because they gate merge. The failing count comes from the change's `test_results`.
  - **Superseded:** only a change's newest card is live. Older ones read "Superseded by a newer preview" and offer nothing.
- **The preview in the side pane.** On a wide screen Open preview shows the preview beside the chat. With a spec open too, the pane has Spec and Preview tabs.
  - It is the platform's own preview (`AppView.ensureStaging`), docked over the pane's slot the way it docks beside the dev chat, so sign-in, Full screen and the dev console are the same.
  - `app-view.js` gained a dock host (`setStagingDockHost`): the slot, whether the host is still on screen, and what Full screen, re-docking and closing do. The dev chat's is the default, and it takes the dock back when it opens its own.
  - It also gained an explicit app (`opts.app`), so the preview signs in to the change's app rather than whatever app is on screen, and `opts.readOnly`.
  - The slot stays mounted, hidden, while the Spec tab shows, so the preview keeps its state.
  - While a preview is open the divider's floor is the staging panel's 320px. The preview's iframe ignores the pointer during a drag.
  - Where there is no room beside the chat (a phone, a narrow window, the side panel beside a running app), the preview opens over the chat instead: the platform's own preview, signed in to the change's app, with its Back to the conversation. It used to open the bare staging address in a new tab, signed out. The Changes drawer's Open preview follows the same rule. In the side panel the spec fills the panel too, rather than rising as a sheet over part of it, and the panel's Expand carries an open spec or preview into the full-width chat, beside the conversation (`paneToCarry` / `adoptPane`).
- **Propose and Retry.**
  - Propose confirms ("Put this up for the group's vote?", naming the change and its PR), then calls the owner's `POST /api/sessions/:id/promote`.
  - Retry calls the owner's `POST /api/sessions/:id/ensure-staging`. The build's `staging_ready` or `staging_failed` reaches the conversation, writes the next card, and ends "Retrying…". A build whose answer never lands (a restart, a lost event) gives up after the dev chat preview's three minutes, and says the result will still appear.
  - A preview waiting on a rebuild hears the same events (`AppView.onStagingRebuildResult`), which this conversation may not otherwise receive: the app-room socket only reaches people on that app's screen.
- **Staging** gives the seeded conversation's change two build rows, written as a real build writes them: a failed build, then a deployed one at a fixture address (`.invalid`). So the conversation shows a superseded card and a live one. A declared check pins them. Open preview there reports honestly that the fixture's preview is not running.

*Follow-up: the composer and the live turn, with what the dev chat's had.*

- **Saved drafts** (the dev chat's #798 list, per account like #940).
  - While the Mayor works, the composer's one button is a green "Save draft" when something is typed (Stop when nothing is), with a line above the box saying the message will be saved as a draft, not sent. Enter does the same. Saving parks the text in a list above the box ("Saved drafts (N) · on all your devices"), so nothing typed mid-turn can join the running turn.
  - A draft is sent only by a tap, never on its own, and not while the Mayor works ("sending unlocks when the Mayor finishes"). Edit puts it back in the box; Delete drops it. Sending or editing keeps what the box held as a draft of its own first.
  - The server: `agent_session_drafts` (per conversation, `ON DELETE CASCADE`, `staging:private`) and `GET/POST/DELETE /api/agent-sessions/:id/drafts[/:draftId]` (`routes/agent-session-drafts.js`). Its limits and helpers are the dev chat's own (`routes/chat-drafts.js`): 20 drafts, 10,000 characters, client ids, idempotent writes, the conversation row as the cap's lock. Every write answers with the list and tells the owner's other devices (`agent_session_drafts_changed` over `pushToUser`), which re-read.
- **Unsent text is kept** per conversation in this browser (`unsent.ts`, `usernode:agent-session-unsent:<id|new>`), so a reload or a switch brings it back.
- **Stop hands the message back** to an empty box (the one still waiting, or the newest sent), as the dev chat's does. The busy placeholder says what to do: "The Mayor is working. Type your next message and save it for later."
- **Costs.**
  - The model picker says what a typical change costs on each model, the dev chat's figures (#2570, `GET /api/model-notes`): the platform's estimate for a model it curates, otherwise the catalog's prices times the typical change's token profile, its cached share priced at the catalog's cache prices where it lists them (`modelCost`, `typicalChangeCents`). The open list reads "GLM 5 · about $0.42 for a typical change". Only the open list: the closed control says "Model: X" and nothing after it (#3008), because a figure beside it read as a standing price under every message. Never a bare amount.
  - Each Mayor reply says what it cost, "Mayor · reply $0.012" (`replyCostLabel`). An OpenRouter Mayor's figure is the list-price estimate and carries "~" (`costEstimated`, now written on its rows).
- **A turn that did not finish** (failed, or stopped after it said something) offers the dev chat's pair, "Try that again" and "What went wrong?", when it left no suggestions of its own.
- **The Mayor at work** is its name and three dots where its reply will appear, with what it is doing beside them ("Reading the app", "Wrapping up", the coding agent's progress and clock), instead of a box across the pane. Once it has said something the dots follow the words. Still dots under reduced motion. A screen reader hears "The Mayor is thinking".
- **The outline is the composer card's**, as on Messages (#1954, #2882, #2387): the whole card turns accent while anything in it has focus. The field draws no edge of its own in any engine: `outline: none` at two classes' specificity beats preflight's `:-moz-focusring`, and WebKit's native box and tap flash are reset.
- **The transcript follows new output only while the reader is at the bottom**, as the dev chat's does. Opening a conversation or sending in it goes back to the bottom.
- **The browser tab** says "⏳ Thinking…" while the conversation on screen is working. The dev chat's module stays the title's one writer (`DevChat.setAgentSessionThinking`), so the marker composes with the unread count and the "done" marker as the dev chat's does.
- **Staging** gives the seeded conversation one saved draft and a cost on the Mayor's reply. A declared check pins both.

*Follow-up: session and change controls, credits, and handing the work to a web agent.*

- **The session's ⋯** (the dev chat's): Rename (`PATCH .../title`, asked with the kit's prompt), Archive after a confirm (`POST .../archive`: the conversation leaves the lists and its change is paused; a change up for a vote keeps its vote), and Unarchive. An archived conversation stays on screen, read-only, with "This session is archived. Unarchive it to keep going." above the box.
- **Checks on the staging card.** The checks line ("2 checks failing") opens the platform's own "Proposal checks" dialog (`AppView.openSessionChecks`: every check, Refresh, Re-run). A failing or errored run also offers Re-run checks on the card, which is the platform's recheck (`AppView.castRecheck`, `POST /api/sessions/:id/recheck`) with its own toasts; the card reads "Re-running…" until it answers.
- **The credits meter** beside the model picker is the header's own figure (`aiBudgetStore`, published by `features/header/ai-credit.js` and kept live by `budget_updated`), read when a conversation opens.
- **Out of credits.** A message the platform credits refuse (`429 budget_exceeded`) is no longer a raw red line. It goes back to the box, and the conversation shows a card with `credit-options.js`'s lead ("You're out of this week's free AI credits."), the server's reason, and the ways to keep building: Claude Code and Codex on the web first, then your own API key and the rest a non-developer can follow. The developer routes (a CLI lease, importing your own pull request) are left out: they build a dev session, not this conversation.
- **"Build: Homeroom"** is always in the session bar. Its menu offers Homeroom (here), Claude Code on the web and Codex on the web; the web rows open the hand-off walkthrough. The label stays Homeroom, because the conversation itself keeps building here: the Mayor's dispatch has no venue.
- **The hand-off walkthrough** is the dev chat's (#1049): `dev-flow-select.js` `steps()` over `GET /api/apps/:slug/dev-flow/status` for the conversation's change (its app, `sessionId`/`proposalId`, and `targetKind` session or proposal), drawn in React. Link GitHub, fork the app, connect Homeroom in the Claude or ChatGPT account the agent runs as (the connector steps and the MCP URL open in place), then Copy instructions and Open Claude Code / Codex. It reads the server's status every time, so it resumes where it was. With no change it hands over new work on the conversation's app; with no app at all it says to pick one first.
- **Staging:** a declared check pins "Build: Homeroom" beside the ⋯ on conversation 990801. The walkthrough there shows staging's fixture status (nothing linked yet).

*Follow-up: who is working on a request, and the table of fixes after it.*

- **Claims.** The board shows a request "In progress" from the changes linked to it and from claims, and starting a change from a request claims it for the starter (`POST /api/apps/:slug/sessions` with `issueNumber`). The Mayor starts changes with `start_change`, which links and claims only the requests it is given, and it was told to pass them only when the conversation was opened from one. Two things now make an agent session's work visible:
  - **A default on the card.** A `start_change` card in a conversation opened from a request (`focusContext.issueNumber`, on the same app) links that request when the Mayor passed no `linkedIssues` at all (`withOpenedRequest` in `services/agent-session-actions.js`). Only the conversation's first change on it gets the default, and an explicit `linkedIssues: []` opts out, so a later, unrelated change does not claim a request the user has moved on from. It is written into the card's input, so the user sees "Links: Request #N" before confirming, and the Mayor reads the input back with `pending_confirmation`.
  - **A rule in the prompt.** Before starting a change for a request, read it with `get_request`: `inProgress` names anyone who has claimed it or is building on it, and somebody else there is something to tell the user. Then pass the request in `linkedIssues`, including one just filed with `create_request`. `update_proposal_issues` links a request to a change already open, which shows it in progress through that change.
- **Card outcomes in words** (#3017). A finished card's "Confirmed · …" line printed the tool's raw JSON whenever its answer had no `nextStep`, which is every `create_request`. `outcomeLine` now says it per tool ("Filed request #3006: …", "Claimed request #12 for you. Also claimed by bo.", "Change 88 is open on notes, linked to request #42.") and the rest say their `nextStep`. The listing carries it as `outcome`; the transcript never prints a result that is only JSON. The conversation's `action_result` note, which the Mayor reads, keeps the platform's `nextStep` and falls back to the same line, with member-written text (a title, a username) still inside its untrusted-content envelope.
- **The lists' mark leads the name** (#3013): in Recents and in the Homeroom menu's Continue rows the spinner or green dot sits between the row's icon and the session's name, not at the row's end.
- **The green dot on the Homeroom mark says what it is** (#3015): an agent is mid-turn on a change you can see. The mark says so on hover (its `title`), and the menu it opens says it in words ("An agent is working on a change right now. That is the green dot on the Homeroom mark."), after mount only and below the build notes.
- **A change's title reads as written on the Dev board** (#3010). The session cards' label (`AppView._sessionCardLabel`) still returned `escapeHtml` output from the innerHTML days, while every reader of it is now a React card model that escapes it again, so a title with a quote read `&quot;` (an ampersand, `&amp;`). The Mayor names changes in prose, quotes and all, which is how it surfaced. It returns plain text now, as do the proposal meta's provenance words, which had the same double escape.
- **Phones** (#3016). At 390px the session bar's controls came to 537px, and a bar that could not wrap made the whole conversation that wide; the screen clips its overflow, so the right edge of every message and the Send button were gone. The bar wraps on both surfaces (Build starts the second row on a phone, Changes and the ⋯ end it), the panel shrinks below its content (`min-w-0`), and an empty message box is as tall as its hint instead of cutting it off mid-line.

**As built: stages 3 and 4 (the flag retired, classic creation closed).** Agent sessions are no longer experimental. There is no per-user choice left, so everyone, including users who had opted out, starts new work in an agent session. Classic sessions that already exist kept their chat, builds, previews and votes exactly as before; only creating one was closed. (Since #3976 they are read-only: see the next section.)

- **The flag is gone.** `services/agent-sessions-flag.js`, `config.agentSessionsDefault` / `agentSessionsOptIn` (`AGENT_SESSIONS_DEFAULT`, `AGENT_SESSIONS_OPT_IN`), `POST /api/me/agent-sessions` and the Settings → Experimental switch (`#settings-agent-sessions-row` and its switch and status line) are removed. The auth middleware no longer reads `users.agent_sessions_enabled`. The column stays in `schema.sql`, unread, so a rolling deploy's older pods keep their `SELECT`; a later migration can drop it.
- **`/api/auth/me` still reports `agentSessionsEnabled: true`**, for a shell cached before the deploy: its entry points read it to choose between an agent session and a classic one, and the classic one would now be refused. `agentSessionsChoosable` is gone, so such a shell hides the old switch.
- **Creating a session needs no flag.** `GET /api/agent-sessions/draft` and `POST /api/agent-sessions` answer any signed-in user.
- **Every entry point opens an unsent agent session** with no classic fallback: Improve's New change and the Workshop's Start here (`entry: improve`), Messages' "+" (now "Agent session", with no app picker: `messages/agent-dialog.tsx` and its two ids are removed), the change page's "Start a new change" banner (`banner`), a request's Start work and Feedback's "Try a fix yourself" (`issue`, with the title), a proposal's Explore (`proposal`, now carrying the explain-only seed as the composer's first message), and a finished auto-solve run's primary, which reads "Start work" and starts on the run's request instead of cloning the run.
  - **The hint gains two screen-only fields**, dropped by `serverHint` like `issueTitle`: `message`, the first message the unsent conversation offers (`draftSeed` in `request-seed.ts`), and `handoff`, which opens the composer's "Build with" sheet on that agent's tab. The out-of-credits card's "Use Claude Code" / "Use Codex" (`AppView.createProposal({ flow })`) uses it, instead of creating a classic session to record a hand-off on.
  - **The old address**, `/app/<slug>/dev/sessions/new`, resolves in the router (`App.openNewChangeAsAgentSession`): it prepares the unsent conversation with `{ slug, entry: 'app' }` and replaces itself with `#messages/agent/new` (`#agent/new` in the side panel's own document), so a bookmark or Back lands in an agent session and Back does not bounce. The dev chat's placeholder machinery behind that screen (`startPendingSession`, `_materializePendingSession`) was no longer reachable, and #4268 deleted it.
- **The server closes classic creation.**
  - `POST /api/apps/:slug/sessions` answers `403 {code: 'agent_sessions_only'}` to anything but an `agent_mayor` delegation that names a conversation (the Mayor's `start_change`): a browser, a shell cached before the deploy, a CLI token, a coding agent's `worker_read` grant, and Global Chat's cookie loopback.
  - `POST /api/sessions/:id/clone-headless` answers the same to anything but an external connector token (not a delegation): the hosted connector's `submit_platform_build` still takes ownership of a build this way.
  - `POST /api/sessions/:id/fork` answers `410` to everyone and writes nothing; "Fork this chat" is gone from the transcript, and the transcript read reports `can_fork: false` so an older shell does not draw it.
  - Still creating rows, because none is a classic chat a person starts: the headless run, a CLI hand-off (`proposal_start`), a connector's share of work in progress, an imported PR, a revert, manifest PRs, maintenance campaigns, the Homeroom bot and demo mode.
- **Global Chat's "Start development work"** creates nothing any more. It keeps its capability id and its confirmation, and on confirm hands the browser an `agent_session_handoff` action: the unsent conversation on the app (and the issue), entry `global-chat`, with the exact task in its box for the user to send. "Continue development work" still hands the browser a turn for an existing session that can take one; since #4268 it answers an older (classic) session with the read-only refusal itself (#3976, below). The inventory exempts the fork and clone-headless routes, so Global Chat does not offer them.
- **Staging:** the three declared checks that loaded the classic unsent-change screen now load its old address and assert the unsent agent session it lands on: the empty state, a live message box with the session's ⋯ disabled, and the composer's model pill.

**As built: classic sessions are read-only (#3976).** Creating a classic session was closed in stages 3 and 4; continuing one is closed now. New work happens in an agent session.

- **Which sessions.** A classic session is a change whose chat is its own: a `chat_sessions` row with no parent agent session (`agent_session_id` NULL) that is neither a headless run nor an imported pull request, which have no chat at all (`services/classic-sessions.js`, `isClassicSession`). Two kinds of row the paths above still create are not old sessions and stay continuable on the web: a CLI hand-off (`source = 'cli_handoff'`, whose local and web turns may alternate) and a request's planning record (`source = 'request_spec'`).
- **What is refused**, with `409 {code: 'classic_session_read_only'}` and a message that says to start an agent session:
  - `POST /api/sessions/:id/chat`, where every Mayor turn, scout and coding run of a classic session started. A paused one is refused too, and no longer resumed first. The refusal comes after the duplicate-delivery lookup, so a retry of a message stored before this landed still learns it was received.
  - `POST /api/sessions/:id/attachments` (a file only goes with a message), `POST /api/sessions/:id/reset-agent-context` (the coding agent and model of a next turn) and `POST /api/sessions/:id/build-venue` (where it is built next).
- **What stays open**: reading the transcript, specs and published chats; previews (`ensure-staging`, `deploy-staging`); checks (`recheck`); everything about the proposal it became: proposing it (`promote`, which takes a paused session as it is), the vote, unpromote, sync with main, archive and unarchive, the description, linked requests and the title; sharing; saved drafts (they are only text); stopping a turn already running. Proposing a classic session that was never proposed is allowed on purpose: it is finished work, and putting it to a vote runs nothing new in its chat.
- **The screen.** `GET /api/sessions/:id` carries `classic_read_only`, decided by the same function. The dev chat reads it (`DevChat._classicReadOnlyView`) and:
  - shows a strip above the panes, `#dc-classic-read-only-banner`: "This is an older session. You can read it, but it can no longer be continued. New work happens in agent sessions.", with **Start an agent session**, which opens an unsent agent session on the same app (`DevChat.startNewChange`, entry `banner`);
  - puts the composer away (drafts, quick replies, attach, model picker and send), and with it the questionnaire's answers, the venue dropdown, the launchpad and hand-off walkthrough, the new-change and credits banners, the empty state and the first-use "come back later" hint;
  - never resumes a paused one, on open or when the tab returns;
  - keeps the transcript, the Changes-ready card (Preview, Propose to group, View on GitHub), the sync banner, the spec panel and the preview.
- **Checks.** Every declared check that drove the classic dev chat was retired with it: 109 of them, on the 9008xx and 9904xx fixtures' session pages, the Messages pane that hosts a classic session (`#messages/session/…`) and the `?conversation=workspace` redirect into one. The five on the coding-run card became one on the agent-session fixture (`#messages/agent/990801`), because that card is the dev chat's `Attached`, which agent sessions draw too. The spec panel's (900830, 900831), the published chat's (990002) and the old `/dev/sessions/new` address's checks stay. The fixtures themselves are still seeded, so a preview can open an old session and see the strip.
- **Left for the cleanup that deletes the classic dev chat**: see the next section, which removed what nothing could reach and says what had to stay.

**As built: the unreachable parts removed (#4268).** Two kinds of session still continue in the dev chat on the web: a CLI hand-off (`source = 'cli_handoff'`, whose local and web turns may alternate) and a request's planning record (`source = 'request_spec'`). Everything they use stays; what no remaining kind of session could reach is gone.

- **Removed:**
  - the dev chat's unsent-change placeholder (`startPendingSession`, `_materializePendingSession`, `_materializePendingSessionForVenue`, `isPendingSession`, `pending_agent_choice` and every `session.pending` branch in the picker, the venue sheet, the header strip, send and attach), `DevChat.createSession`, which only it called and which `POST /api/apps/:slug/sessions` refuses to a browser, and `Improve.onSessionCreated`, which only that called. `/app/<slug>/dev/sessions/new` still resolves to an unsent agent session (`NEW_SESSION_REF` and the router keep the word); the venue sheet always opens in its `switch` mode now.
  - Global Chat's "Continue development work" for a classic session: the capability still reads the session (`GET /api/sessions/:id`), and when it reports `classic_read_only` it answers with the same 409 body as `services/classic-sessions.js` `refusal()` instead of handing the browser a turn. Its summary tells the model older sessions are read-only. A CLI hand-off and a planning record are handed off as before.
  - attaching a local agent to a classic session: `POST /api/cli/agent/attach` refuses it with the same 409 and message, server side, so an older CLI (which prints the `error` when it does not know the code) says why too. Sessions that still take turns attach as before.
  - staging fixtures that no check, test or story used and that showed nothing on a read-only session: 990410 (the venue fallback), 990413 (the questionnaire), 990414 (the draft delete, with the dev chat's `?shot=draft-delete`) and 900812 (the not-stoppable spinner, with the `-unstoppable` rule in `/status`'s fixture lookup). `?shot=venue-fallback` stays: it paints on any session that draws the venue line.
- **Stays, because a CLI hand-off or a planning record still uses it:** the classic turn in `POST /api/sessions/:id/chat` and `services/mayor/turn.js` with the suites that drive it; the composer, drafts, quick replies, questionnaire, venue sheet, launchpad, walkthrough and credits banners in `features/dev-chat/`; `agent run --session` itself.
- **Stays, still referenced:** the 9008xx and 9904xx fixtures that a declared check, a unit test or the read-only strip's shots use (900801, 900830, 900831 and 990412 among them); the tests that pin the rest say why each is kept.
- **Removed after (#4311):** the Settings choice of where changes get built. Nothing acted on its value, so the Settings part (`#settings-dev-flow`, `#settings/build-venue`) and its declared check, `POST /api/me/dev-flow` and the venue sheet's and launchpad toggle's writes to it, the `devFlowPreference` field of `GET /api/auth/me`, and Global Chat's inventory entry and settings-inspector row are gone. Picking a web hand-off still records the venue on the session (`chat_sessions.build_venue`). The `users.dev_flow_preference` column and its CHECK stay, so a rollback to an older build still reads and writes it; drop it in a later migration once no deployable build does.

**Process.** Each proposal:

1. pins its base with `prepare_work`;
2. runs the local fast checks (`npm test`, which also builds the shell);
3. declares before & after shots for UI changes;
4. is submitted with a user-facing summary and a technical description.

## Questions

Evan answered all eight on 2026-09-23.

| Question | Answer |
| --- | --- |
| One conversation or many? | **A new agent session each time** “New change” (or another entry point) is pressed. Taking over an existing conversation would be confusing. |
| Mayor model | **Parity in v1.** The Mayor defaults to the user's coding model. |
| Chatting on a change page | **Read-only.** The owner sees “Continue in agent session”. |
| Who sees the flag at stage 1 | **Admins only.** |
| Adopting classic sessions | **Not in v1.** |
| `start_change` for external clients | **Not in v1.** It is `agent_mayor` only. |
| Visibility to collaborators | **Private** to the owner. |

**Global Chat threads:** not a question for now. Global Chat stays behind its own toggle, with a flag separate from agent sessions, so its threads stay too.

I will answer this one myself in proposal 3: how existing `dapp.json` checks drive a dev chat on staging without a live model, so the new checks can do the same.
