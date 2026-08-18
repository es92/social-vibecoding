# Build methods — inventory, constraints, and direction (#1281)

Research and assessment feeding the spec for **#1281 "Rework discovery
and selection UI for building methods"**. Written 2026-08-18 from a
full audit of this tree at `f4fea64` (post-#1052/#1053) plus external
research. Everything in §2 is current code with file references;
everything in §7 (prices, provider policies, competitor plans) is a
dated snapshot and will drift. The companion issue polishing the
out-of-credits copy is **#1277** — any spec from this doc should
absorb or coordinate with it.

The one-paragraph thesis: the platform already has every rung of a
"start free, graduate to your own plan" ladder — more rungs than any
competitor — but they were built one at a time, are described in three
different vocabularies across five unconnected surfaces, and the two
local rungs are invisible. #1281 is not about adding ways to build.
It is about turning eight accreted features into one legible system
with one default, one escalation moment, and one reference page.

---

## 1. The problem

- Production numbers recorded in `src/routes/dev-flow.js:3-26` when
  #1053 landed: 299 accounts, **32 distinct users have hit the daily
  credit limit**, but one linked GitHub login and three external-agent
  tasks ever. The alternatives "were not missing; they were
  invisible." #1053 fixed the worst of it; the structure that produced
  it is still there.
- Discovery is fragmented across five unconnected surfaces (new-session
  picker card, "+" menu row, out-of-credits card/banner/modal, two
  Settings sections, a `?flow=` deep link) using three vocabularies for
  the same three options: "Build it here on Usernode / with Claude
  Code / with Codex" (`public/js/dev-flow-select.js:41-63`), "Carry on
  in Claude Code / Codex" (`public/js/credit-options.js:93-112`),
  "Build on Usernode / Claude Code (claude.ai/code) / Codex
  (chatgpt.com/codex)" (`public/js/settings.js:1018-1021`).
- The #1053 picker is nearly unreachable in normal use: it renders only
  on an active session with **zero user messages**, no saved
  preference, `externalFlowsAvailable`, and a resolved repo status
  (`public/js/dev-chat.js:740-758`). One typed message removes it for
  that session permanently.
- Two whole methods appear in no picker at all (§2 E and F). The
  out-of-credits card's "Use a coding tool on your computer" CTA
  deep-links `#settings/cli`, which renders a bare credential
  revocation list with no setup steps (`public/js/credit-options.js:73-79`
  → `frontend/src/Shell.tsx:1842-1866`). The lease's only explanation
  hides until a machine has already attached (`public/js/settings.js:810`).
- One reachable dead end: the "+" menu row "Propose with Claude Code or
  Codex" renders unconditionally (`public/js/app-view.js:1480-1483`)
  while the picker it opens refuses to render without
  `externalFlowsAvailable` (`public/js/dev-chat.js:751-753`).

## 2. What exists today — the eight ways to build

| # | Method | Inference paid by | UX kept | Needs | Discoverable? |
|---|--------|-------------------|---------|-------|---------------|
| A | In-platform dev session | Platform (daily credits) | Platform dev chat | Browser only | Default |
| B | BYO Anthropic API key | User (API rates) | Platform dev chat | API key + card | Settings, credits card |
| C | Claude Code web dispatch | User (Claude plan) | claude.ai/code | Claude plan, GitHub identity link, fork | Picker, "+" menu, credits card |
| D | Codex web dispatch | User (ChatGPT plan) | chatgpt.com/codex | ChatGPT plan, same link/fork | Same as C |
| E | Local agent lease (#907) | User (own `claude` login) | **Platform dev chat** | Repo checkout, `claude` CLI, Node | Effectively hidden |
| F | Local CLI proposal handoff | User (local agent) | Their terminal | Repo checkout, device login | README only |
| G | Chat connector (MCP) | User (their coding agent); platform only for `*_platform_build` | Claude.ai / ChatGPT chat | Connector + GitHub link | Settings → Connectors |
| H | Plain git → PR import | User (anything) | Their tools | Fork + PR, `can_collaborate` | "+" menu |

Notes per method, with the load-bearing anchors:

- **A. In-platform session** — the Mayor (in-process Anthropic SDK
  chat, `src/services/llm.js`) dispatches build turns to a per-session
  Docker worker running the real `claude` CLI
  (`src/routes/sessions.js:8733`, `src/services/worker.js:700-826`,
  `worker/run-cc.sh:292-305`). Model is a per-turn composer picker
  (`public/js/dev-chat.js:5833`) validated against
  `src/services/models.js:40-70`: `claude-sonnet-5` /
  `claude-opus-5` (default) / `claude-fable-5`. Backend registry has
  exactly one entry, `claude_code`, and fails closed on anything else
  (`src/agents/registry.js:24-50`).
- **B. BYO key** — Anthropic keys only, **limit-first** (#212): free
  daily credits burn first, the key takes over mid-turn with a one-line
  system message (`src/services/limits.js:224-233`,
  `src/routes/anthropic-proxy.js:215`). Save/verify at
  `src/routes/auth.js:383-398`.
- **C/D. Web dispatch** (#1049→#1053) — Usernode mints a ~11 KB work
  order (repo, fork, branch, exact base SHA, platform-rules excerpt),
  the user pastes it into claude.ai/code or chatgpt.com/codex, the
  agent pushes to the **user's own fork**, Usernode opens the
  cross-fork PR and imports it as a normal proposal
  (`src/routes/dev-flow.js`, `src/services/external-agent-tasks.js`).
  Safety rests on the attribution gate — the PR head must live in a
  repo owned by the GitHub login *this* user verified
  (`external-agent-tasks.js:38-47`) — and on the identity-only,
  zero-scope GitHub link (`src/services/github-link.js:38-41`).
  `PICKABLE_AGENTS = ['claude-code', 'codex']`
  (`src/routes/dev-flow.js:45`).
- **E. Local agent lease** (#907) — `social-vibecoding agent run
  --session <id>` takes a lease; the platform writes turn rows instead
  of starting a container and the laptop long-polls, runs the real
  `claude` binary, and uploads commits file-by-file through the
  platform's GitHub App (`src/services/local-agent.js`,
  `src/routes/cli-agent.js`, `src/cli/agent-command.js`). Stated
  design invariants: the platform never sees credentials
  (`local-agent.js:29-32`), the adapter never reads `~/.claude` or
  token env vars (`src/cli/agent-runtimes/claude-code.js:10-21`), and
  every turn asks for consent at the keyboard
  (`agent-command.js:240-268`). Zero platform cost — no `llm_usage`
  row at all (`src/routes/sessions.js:8430-8433`). Claude Code is the
  only runtime on both sides (`local-agent.js:66`). **This is the
  "keep the platform UX, bring your own compute" cell** — nothing
  gates it to platform developers except that the CLI is unpublished
  (`package.json` `private: true`; setup copy exists only at
  `frontend/src/Shell.tsx:1938-1944`, hidden until attached).
- **F. Local CLI handoff** — `claude setup` / `codex setup` register a
  project-local stdio MCP server (`src/cli/main.js:1313`, `:1040`);
  the `proposal_start` → `proposal_push_commit` →
  `proposal_submit_build` → `proposal_promote` tools carry a fully
  local build through the normal staging/checks pipeline
  (`src/routes/proposal-handoff.js`). Device-login auth
  (`CLI-MCP-AUTH-SPEC.md`). Documented only in `README.md:294-345`
  and `AGENTS.md` — i.e. discoverable exactly by people reading this
  repo.
- **G. Connector** — same engine as C/D behind `prepare_work` /
  `submit_work` (`src/services/mcp-tools.js`); #1052 closed the
  context gap (handbook served section-by-section, testing routes,
  request discussion, failing-check names). `start_platform_build` is
  the one connector path that spends platform credits and is bounded
  harder (`src/services/connector-limits.js:37-43`).
- **H. PR import** — the universal escape hatch; C/D/G all terminate in
  the same `pr-import` (`src/routes/votes.js:1866-1876`), so "any
  agent that can push a branch" is already structurally supported.

Adjacent but distinct: the OpenRouter/second-backend scaffolding.
`chat_sessions.agent_backend/agent_provider/agent_model/...` columns
(`src/db/schema.sql:4548-4561`), a `user_ai_credentials` table with
`CHECK (provider IN ('anthropic','openrouter'))` (`:4600-4632`), the
fail-closed registry, and a backend-neutral progress parser have all
landed — roughly PR1–PR2 of a staged plan whose remaining pieces
(worker adapter, UI, routes) do not exist yet, and whose `plan.md` is
cited ~15 times across the tree but is not in the repo. The planned
backend id is `codex_openrouter` (Codex harness, OpenRouter provider —
see the fixture at `tests/worker-watchdog.test.js:162-163`). **There
is no user-visible OpenRouter option today.**

## 3. The constraint that shapes the funnel

Both major labs prohibit third parties from hosting inference billed
to a user's consumer subscription:

- **Anthropic**: OAuth credentials from Free/Pro/Max are licensed for
  Claude Code and Claude.ai only; server-side enforcement since
  January 2026, explicit policy since February 2026. Products built on
  the Agent SDK must use API keys.
- **OpenAI**: Codex plan-compute is reachable only through Codex's own
  surfaces (CLI, IDE, web, cloud). "Sign in with ChatGPT"
  (August 2026) is identity federation — name, email, avatar — not
  compute delegation. API-key sign-in bills at standard API rates.

So "use the plan you already pay for" is reachable in exactly three
compliant shapes: **their web surface** (claude.ai/code,
chatgpt.com/codex — methods C/D), **their tool on the user's machine**
(methods E/F), or **their chat app via connector** (method G). A
hosted "run platform sessions on your Claude plan" tier is not
buildable, and the lease's never-touch-credentials invariant is the
compliance line for E: it must always drive the genuine first-party
binary, never lift its token. Every rung the platform has corresponds
to a compliant cell; there are no missing cells left to build — only
missing legibility.

This is also the competitive read: Lovable / Bolt / v0 / Replit are
closed runtimes selling hosted credits; bring-your-own exists only in
local OSS tools (Dyad, bolt.diy). None of them can offer a
graduate-to-your-own-agent ladder. The git-native proposal machinery
(fork + attribution gate + PR import) makes this funnel a structural
differentiator, not a cost dodge.

## 4. The intended ladder

Default funnel, in order of escalation:

1. **Build here** (A). Free daily credits, zero setup. The default for
   everyone; never ask a question up front.
2. **Out of credits** — the escalation moment (32/299 users have hit
   it). Present at most three options, personalized (§6), in the
   #1049 order: no-new-account options first (C/D — "the plan you
   already have"), then B ("your API key, keep working right here"),
   then "on your computer" (E/F).
3. **Developer** — C/D's local equivalents: Claude Code / Codex on
   their own machine, via F (full local control) or E (keep the
   platform dev-chat UX). Disclosed progressively on developer
   signals, not role gates.
4. **Platform developer** — E today, since the CLI ships only inside
   this repo. Whether E stays here or is promoted into rung 3 by
   publishing the CLI is an open decision (§7).

Two axes make the system legible — every method is a cell in
**who pays × which UX you keep**:

|  | Platform dev-chat UX | External UX |
|---|---|---|
| **Platform pays** | A (free credits) | G's `start_platform_build` (bounded) |
| **User's chat plan** | E (lease) | C, D, G |
| **User's API key** | B | F, H |

## 5. Platform-session economics — model, provider, OpenRouter

**What OpenRouter actually routes.** By default OpenRouter
cost-optimizes *across providers serving the model you chose* —
load-balanced, weighted by inverse-square price, skipping providers
with recent outages — with `:floor` (strictly cheapest), `:nitro`
(throughput), and `max_price` overrides. Model-level auto-routing
(`openrouter/auto`) picks the *best model for the task* from
market-usage data, not the cheapest, tunable via `cost_tier`; it is
not suitable inside an agentic harness where tool-use fidelity varies
per model. OpenRouter adds no per-token markup; its fee is 5.5% on
credit purchases (5% crypto), plus a 5% BYOK fee past a monthly
allowance. Claude Code officially supports OpenRouter via
`ANTHROPIC_BASE_URL` (the "Anthropic Skin" passes thinking blocks and
native tool use through), but OpenRouter only guarantees it with the
Anthropic first-party provider — which is why the scaffolding's choice
of a **Codex harness** for the OpenRouter backend is right: Codex CLI
is Apache-2.0 and provider-agnostic; Claude Code stays pure-Anthropic.

**Conclusion: "default to OpenRouter" is really "default to a specific
cheaper model, served via OpenRouter."** The model choice remains
ours, per tier, pinned, with a provider allowlist and `max_price` —
never `openrouter/auto` inside a build turn.

**List prices, per MTok in/out (2026-08 snapshot, §7):**
claude-opus-5 $5/$25 · claude-sonnet-5 $3/$15 · claude-haiku-4.5
$1/$5 · Kimi K2.7 Code $0.95/$4 · GLM 5.2 $1.40/$4.40 · MiniMax M3
$0.30/$1.20 · DeepSeek V4-Flash $0.14/$0.28. Nominally 4–25× cheaper
than opus-5. Two erosion factors before believing the sticker: agentic
loops are input-dominated (~20–25× input:output), where Anthropic's
90%-off cache reads claw a lot back and cheap providers' caching is
inconsistent; and weaker models burn more turns per merged change.

**Why not just flip the default.** This platform's loop amplifies
model quality: a weak model doesn't merely cost less, it produces
proposals that fail checks, burn staging builds and screenshots, and
land in front of *voters*. The unit that matters is **cost per merged
proposal**, not per token — and the number needed to compute it just
started being recorded and has no reader yet
(`chat_sessions.agent_cost_cents`, `src/db/schema.sql:1380-1411`,
written by `src/routes/anthropic-proxy.js:272-287`; worker share
measured at ~4.3× the Mayor's). Recommended sequence:

1. **Build the cost readout first** — per-model cost per merged
   proposal from `agent_cost_cents` + `chat_session_messages.cost_cents`
   (filter `agent_cost_cents > 0`; pre-column rows read 0). This also
   answers whether the real burn lever is the per-token price or the
   $25/user/day default cap (`src/services/limits.js:74`).
2. **Cheapest safe cut: `claude-sonnet-5` as the default build model**
   (~40% cheaper than opus-5, zero harness risk; sync turns are
   already pinned to sonnet, `src/services/sync-main.js:588-590`).
   Opus/Fable remain one click away in the existing picker.
3. **Land `codex_openrouter` as an "Economy" tier framed as a credit
   multiplier**, not a vendor toggle. Users cannot evaluate "Kimi
   K2.7 vs Opus"; they can evaluate "≈5× more free building per day
   vs. highest quality." One vetted model per tier, pinned.
4. **Widen BYOK with OpenRouter keys** — the credential store already
   allows `provider='openrouter'` (`src/services/credential-store.js:33`);
   nothing writes it yet. This converts "price-sensitive user" from a
   platform cost problem into a $10-key self-serve path, for any
   model, under the same limit-first rule as B.

"Lock in Claude for the price-insensitive" needs no new mechanism —
it is the existing per-turn model picker plus B.

## 6. How to present it — direction for the #1281 spec

1. **One registry, one vocabulary.** A single client-side source of
   truth for build methods (id, name, one-line value prop, who-pays,
   prerequisites, availability predicate) feeding every surface:
   picker, credits card, Settings, "+" menu. Today's three
   vocabularies are the core discovery bug. Name by value, not by
   plumbing: "Build here — free credits" / "Your Claude plan" / "Your
   ChatGPT plan" / "Your API key" / "Your computer."
2. **Replace the upfront question with an always-visible control.**
   The composer already has `Model:` and (when leased) `Run on:`
   selects. Generalize to a persistent chip — "Builds on: **Usernode ·
   free credits** ▾" — that opens the full ladder. Silent good default
   plus glanceable current state beats interrupting every new session
   with a question ~90% of users can't yet answer. This retires the
   fragile zero-message picker gate.
3. **Spend the design budget on the out-of-credits moment.** It is the
   one moment users are motivated. Personalize from state the server
   already has or can cheaply know: key on file → "your key takes over
   automatically"; connector linked → "ask Claude/ChatGPT to pick this
   up"; GitHub linked + forked before → lead with the web hand-off;
   attached machine before → offer the lease; otherwise the #1049
   default order. At most three options, one visibly recommended.
   Coordinate with #1277 rather than racing it.
4. **Give the local rungs a landing page.** A canonical "Ways to
   build" reference (Settings section or a docs route like the live
   `/claude.md`) with real setup guides for E and F — content that
   today exists only in this repo's README. Point the credits card's
   "Set up a coding tool" CTA there instead of at the bare credential
   list, and fix the "+"-menu dead end on deployments without GitHub
   OAuth.
5. **Progressive disclosure on signals, not roles.** Linked GitHub, an
   issued CLI credential, a past lease, a past external task — all
   already stored — decide whether the developer rungs render at all.
   No admin/role gating.
6. **Preserve the invariants while reworking.** The attribution gate
   (fork ownership), the identity-only GitHub link, the lease's
   never-see-credentials rule, and per-turn keyboard consent are what
   make the whole menu safe to offer. Tests that pin current behavior:
   `tests/dev-flow-select.test.js`, `tests/dev-flow-routes.test.js`,
   `tests/dev-flow-preference.test.js`, `tests/credit-options.test.js`.

Cheap extensions the rework should leave room for (not commitments):
`PICKABLE_AGENTS` is just a list over an agent-agnostic engine, and
every path terminates in the same PR import — Google's Jules has a
free 15-tasks/day tier and GitHub Copilot's coding agent starts at
$10/mo, both GitHub-PR-native. A free rung between "out of credits"
and "needs a $20 plan," and a generic "another tool" work order, are
both small deltas on the existing engine.

## 7. Open decisions

1. **Publish the CLI?** Promotes the lease (E) from platform-developer
   tool to the general rung-3 "keep the platform UX on your own plan"
   option. Cost: support surface, versioning, npm publishing.
2. **Default model**: flip to sonnet-5 now, or after the
   cost-per-merged-proposal readout exists?
3. **Economy tier sequencing**: finish the `codex_openrouter` worker
   adapter first, or ship user-side OpenRouter BYOK first (smaller,
   pure win, exercises the credential store)?
4. **Credit framing**: express tiers as a multiplier ("≈5× more free
   building") — needs the cost readout to pick an honest number.
5. **Scope**: does #1281 absorb #1277's card polish or stay the
   umbrella above it?
6. **Recover or rewrite `plan.md`** for the second backend — the
   scaffolding cites a document the repo does not contain.

## 8. External snapshot (2026-08-18) — sources

Prices and policies above come from: OpenRouter docs and blog
([provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[auto-router](https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/),
[lowest-cost guide](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/),
[Claude Code integration](https://openrouter.ai/blog/tutorials/claude-code-openrouter/),
[fee breakdown](https://www.truefoundry.com/blog/openrouter-pricing));
Anthropic authentication policy
([Claude Code auth docs](https://code.claude.com/docs/en/authentication),
[policy coverage](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use),
[plan usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan));
OpenAI Codex
([plan usage](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan),
[Sign in with ChatGPT launch](https://www.techtimes.com/articles/322791/20260803/sign-chatgpt-launches-what-openai-retains-not-what-gets-shared.htm));
model-price landscape
([agent model pricing](https://www.betterclaw.io/blog/cheapest-ai-models-for-agents),
[agentic cost drivers](https://www.vantage.sh/blog/agentic-coding-costs));
adjacent agents and platforms
([Jules](https://www.morphllm.com/comparisons/jules-google-coding-agent),
[platform comparison](https://zapier.com/blog/lovable-vs-bolt/)).
Treat every external figure in §5 and §7 as point-in-time; re-verify
before building anything that depends on a number.
