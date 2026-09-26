# Agent-authored visual evidence for proposal reviews

> **Implementation update (2026-09-21):** The semantic image-review gate
> described below has been removed. The implementing agent can submit the
> bounded interaction plan; otherwise an evidence agent explores and submits
> one. Homeroom checks the exact revisions and fixture, replays the plan twice,
> and stores the PNG/WebM captures. The proposal displays them as **Captured**
> for people to inspect and judge while voting. The internal `verified` state
> now means only that replay and artifact integrity checks passed. The older
> agent verdict, fallback vision reviewer, and semantic repair loop in this
> historical plan are no longer part of the active flow.
>
> **Replay submission update (2026-09-23):** `evidence_run_plan` validates and
> accepts the frozen replay plan immediately. Its response is an acknowledgement,
> not a replay verdict. Homeroom continues both clean replay passes after the
> planning model finishes, records any browser failure, and starts a bounded
> correction turn only for a repairable locator error. This prevents a long
> browser replay from holding one model-tool HTTP request open until a proxy
> drops the connection. People still judge the captured media.

Original #2380 status: implemented, merged, and deployed. Collection, execution, and
presentation are default-on and advisory; one emergency kill switch can stop
the mechanism without restoring legacy default-route screenshots.

Tracks: [GitHub issue #2380](https://github.com/Usernode-Labs/social-vibecoding/issues/2380)

Plan base: `2e0b426fbd11e6c3b118cc5b8d1d3bdf8cd647df`

## Decision summary

Replace route-only before/after capture with **agent-authored evidence stories**.
The agent that implements a user-visible change must describe the claim it
wants reviewers to verify, explore the relevant UI, and submit a bounded
interaction plan. Homeroom then executes that plan against two isolated
environments built from the proposal's exact base and head commits, validates
the result, and publishes only evidence that the agent confirms demonstrates
the claim.

The safety property is not "a screenshot always exists." It is:

> Homeroom never presents an unverified screenshot as evidence of a change.

If a relevant state cannot be reached or verified, the proposal shows an
explicit evidence failure with a useful reason. It must never silently replace
the requested state with the app home page.

Paired PNGs remain the primary review artifact. Interaction changes may also
produce a lightweight animation generated from the clean replay: normally a
4 fps step animation, and at most 8-10 fps when motion itself is the claim.
The capture harness creates and compresses that media; the model does not
encode video.

## Why the existing system cannot be made reliable with more route fixes

The current pipeline has three route sources, in priority order:

1. `testingPaths` supplied with the proposal;
2. a matching `dapp.json` visual scenario selected from changed-file globs;
3. `/` as a deliberate default.

The capture container navigates to the chosen URL, waits, takes a viewport
screenshot, and optionally records an automatic page scroll. It does not
perform the user flow. Platform guidance compensates by requiring agents to
add screenshot-only deep links for states reached through interaction.

That architecture has produced several generations of symptom fixes:

- multiple capture routes;
- SPA/hash-route normalization;
- screenshot-state query parameters;
- propagation and repair of `testingPaths` metadata;
- file-matched visual scenarios and readiness assertions.

Those changes improve routing, but a route still cannot express "open the
members sheet, type two characters, wait for suggestions, and compare the
dialog." It also cannot safely compare a live production database with a
staging clone. The route fallback makes availability look like success by
publishing a screenshot of a state that may be unrelated to the proposal.

The new design changes the unit of work from a **capture path** to an
**evidence story**.

## Goals

- Make each artifact answer a specific user-visible claim.
- Use the implementing agent's knowledge while that context is still
  available.
- Exercise real clicks, typing, keyboard input, hover, selection, scrolling,
  and bounded pointer gestures.
- Compare the exact proposal base and head commits under equivalent data,
  identity, viewport, and browser conditions.
- Make the executable portion deterministic and replayable without a model.
- Let the agent inspect the replayed result and reject evidence that does not
  prove its claim.
- Fail explicitly when evidence cannot be produced; never substitute the home
  page or stale artifacts.
- Keep work bounded to at most three evidence stories and two relevant
  viewports per story.
- Preserve proposal checks as the correctness gate while giving visual
  evidence its own status, diagnostics, and eventual review gate.

## Non-goals

- Pixel-perfect visual-regression gating for every proposal.
- Allowing arbitrary JavaScript or shell code inside an evidence plan.
- Interacting with the live production application.
- Capturing real user data, credentials, private messages, or production
  admin state.
- Requiring capture-only query parameters in application code.
- Replacing durable `dapp.json` browser checks. Evidence stories are
  proposal-specific review material; checks remain long-lived regression
  coverage.
- Supporting multi-user choreography in the first release. A later version
  may add two synthetic personas when the product need is demonstrated.

## Terminology

- **Evidence intent**: the authoring agent's semantic description of what a
  reviewer should see. It is collected before or during submission.
- **Evidence story**: one user-visible claim, one persona, one or more
  relevant viewports, and one paired base/head checkpoint.
- **Base side**: an isolated preview built from the proposal's pinned
  `base_sha`, never a moving `main` tip and never live production.
- **Head side**: an isolated preview built from the proposal's exact submitted
  head SHA. It may reuse the head image, but not the proposal preview's mutable
  database.
- **Exploration**: model-driven browsing used to discover robust locators and
  the correct state.
- **Replay plan**: the schema-validated, bounded list of actions and assertions
  that ordinary platform code can execute with Playwright.
- **Clean replay**: execution of the replay plan in fresh browser contexts and
  fresh paired application state.
- **Checkpoint**: the final comparable UI state for a story.
- **Focused artifact**: a screenshot cropped around a declared stable
  container with context padding.
- **Context artifact**: the full viewport at the same checkpoint.

## Hard product rules

1. An app-root screenshot is allowed only when the evidence story explicitly
   names `/` because the changed UI is on that screen. It is never a fallback.
2. A before-side navigation or assertion failure is evidence failure, not a
   reason to navigate elsewhere.
3. Evidence is revision-scoped. A head change immediately makes every prior
   artifact stale and removes it from reviewer-facing surfaces.
4. Base and head use the same source snapshot, synthetic persona, viewport,
   locale, timezone, color scheme, reduced-motion setting, and hosted asset
   revision.
5. The model may explore and judge relevance. Only platform code executes the
   accepted replay plan and decides whether hard invariants passed.
6. No arbitrary `evaluate`, custom JavaScript, cross-origin navigation, file
   upload, or network-request injection is accepted in replay-plan version 1.
7. Every published story includes its claim, reproduction summary, base SHA,
   head SHA, viewport, persona, plan hash, and verification status.
8. A failed run may retain bounded diagnostics for operators, but it must not
   leave older successful evidence visible for the new head.

## Can platform-hosted models do this?

Yes, with one current capability gap and one important architectural
constraint.

### What exists today

- Hosted Claude **build** turns already receive a pinned Playwright MCP server
  and a revision-matched headless Chromium. They can navigate, click, type,
  resize, inspect, and take screenshots.
- The worker image already contains that Playwright MCP package and Chromium.
- The platform capture image already contains Chromium and ffmpeg.
- The existing capture/check pipeline already knows how to run bounded
  browser jobs, collect media, stream progress, salvage partial output, and
  associate results with an exact commit.

### What does not exist today

- The Codex/OpenRouter worker runner does not load the seeded Playwright MCP
  server. It receives browser guidance but cannot currently call those tools.
- No worker mode is dedicated to post-build evidence generation.
- Raw Playwright MCP calls are not persisted as a safe, replayable interaction
  plan.
- External agents using `submit_work` cannot be resumed by Homeroom or assumed
  to expose their local browser session.

### Required capability model

| Agent source | Current browser support | Required implementation |
| --- | --- | --- |
| Hosted Claude build agent | Available through Playwright MCP | Add evidence tools and a read-only post-build `evidence` mode; resume the author thread when possible. |
| Hosted Codex/OpenRouter build agent | Chromium is installed, but the runner does not register Playwright MCP | Register the same pinned MCP server in Codex configuration, test tool discovery, images, and resumed evidence turns. |
| External Codex/Claude/other agent using `submit_work` | Unknown and outside Homeroom's control | Accept structured evidence intent at submission, then run a platform evidence agent with the intent, task context, diff summary, and paired URLs. |
| Model without tool or image support | Cannot explore or judge screenshots | Run a supplied deterministic plan if one exists; otherwise report `unsupported_agent` and require another evidence agent or human override. |

### Exploration is model-driven; replay is not

Do not blindly replay the model's raw browser transcript. Playwright MCP often
uses ephemeral accessibility references, and exploration naturally contains
dead ends. Instead:

1. The model explores base and head with ordinary browser tools.
2. It submits one executable replay per accepted story to `evidence_run_plan`.
3. The platform attaches the accepted intent, validates the complete plan,
   and executes it with platform-owned Playwright.
4. The model receives the replayed checkpoint images and diagnostics.
5. It accepts the evidence or asks for one corrected plan.

This gives the model the flexibility to understand an arbitrary UI while the
platform retains deterministic, bounded execution. The successful plan and
its results, rather than hidden model reasoning or a raw transcript, become
the durable record.

## End-to-end lifecycle

```text
implementation agent
  -> declares visual impact and evidence intent
  -> verifies the changed-side flow locally when browser tools are available
  -> submits code plus intent

proposal orchestration
  -> pins base SHA and head SHA
  -> provisions an isolated base/head environment pair
  -> starts/resumes a read-only evidence agent

evidence agent
  -> explores both sides
  -> submits a bounded replay plan

platform replay runner
  -> resets both sides
  -> executes the plan in fresh browser contexts
  -> validates assertions and hard invariants
  -> creates focused/context PNGs and optional lightweight animation

evidence agent or fallback vision reviewer
  -> inspects the replayed artifacts against the declared claim
  -> accepts, or performs one repair attempt

proposal review
  -> publishes verified evidence
  -> otherwise shows a specific failure and an allowed recovery action
```

### 1. Classify visual impact

The authoring agent supplies one of:

- `ui`: a static or stateful visual result should be shown;
- `motion`: interaction or animation is itself material;
- `none`: no user-visible change, with a short rationale.

The existing changed-file heuristic remains a cross-check, not the authority.
If the heuristic detects frontend work while the agent says `none`, evidence
stays required until a post-build agent or human reviewer confirms the
rationale. If the heuristic misses a UI change but the agent supplies stories,
the explicit intent wins.

### 2. Collect evidence intent while context is fresh

The agent records one to three claims. At this stage it need not know every
base-side locator, but it must provide:

- the visible outcome;
- the likely starting route;
- relevant persona and viewport;
- the human flow in concise terms;
- the intended checkpoint and focus region;
- whether a step animation or motion clip would add value.

For hosted agents, expose a `record_visual_evidence_intent` MCP tool in build
mode. For external agents, add `visualEvidence` to `submit_work` and the native
proposal handoff endpoint. Do not introduce another markdown block parser.

### 3. Provision a paired evidence environment

After the submitted head is built and healthy:

- resolve the exact `chat_sessions.base_sha` and submitted head SHA;
- reuse the already-built head image when its digest matches the head SHA;
- build or reuse a cached base image keyed by app id, base SHA, build engine,
  manifest fingerprint, and hosted-asset revision;
- obtain one immutable redacted staging-template reference;
- clone two databases from that exact template reference;
- start base and head containers/services with `USERNODE_ENV=staging` and the
  same non-secret staging configuration;
- do not expose an "evidence side" environment variable to app code;
- mint equivalent short-lived synthetic identities for both sides;
- expose only internal, run-scoped origins to the evidence browser.

The public head preview is not reused as an application process because a
reviewer may already have mutated its database. Reusing its immutable image is
safe; reusing its mutable database is not.

The database manager needs a new primitive that returns a pinned clone source,
for example `prepareStagingCloneSource(sourceDb) -> { templateDb,
refreshedAt, fingerprint }`, followed by two `cloneFromPreparedSource` calls.
Calling the existing age-based clone helper twice is insufficient because a
template refresh between calls could give the two sides different data.

### 4. Run an evidence agent with minimum authority

Add worker mode `evidence`:

- read-only repository and diff access;
- no worker push credential;
- no GitHub mutation capability;
- no general platform write API;
- browser access restricted to the two run origins;
- evidence MCP tools restricted to the current run id;
- a maximum of one initial plan and one repair plan;
- a bounded wall-clock and token budget separate from proposal checks.

Resume the authoring agent thread when it is a hosted agent and the thread is
available. Otherwise create a new evidence turn with:

- original user request and accepted specification;
- authoring agent's final summary;
- evidence intent;
- base/head SHAs and a compact diff summary;
- changed-file list;
- relevant durable `dapp.json` checks;
- the two internal browser origins;
- the rules in this document.

Never include hidden reasoning, credentials, raw private transcripts, or
unbounded tool logs.

### 5. Explore, then submit the clean replay plan

The agent may inspect both versions and try interactions. Once it understands
the flow, it calls `evidence_run_plan` with one `{id, replay}` entry for each
accepted story. The platform attaches the frozen semantic intent fields and
validates the resulting complete plan. The runner resets both browser contexts
before execution, so exploratory state cannot leak into the result.

Base and head actions may differ when the change introduces or removes the
control used to reach the state. Comparability is defined by the semantic
checkpoint and assertions, not by requiring byte-identical click sequences.

### 6. Replay and validate

The platform executes both sides, aligns named stages, evaluates assertions,
captures the checkpoint, and records console/page/network failures. A plan
that passes once is executed a second time from fresh state before it can be
called reproducible. Both runs must produce the same hard verdict. Media is
published from the second clean run.

The second execution is ordinary Playwright code and consumes no model turn.

### 7. Semantic review and one repair loop

A vision-capable model receives only:

- the claim;
- reproduction summary;
- focused and context image pairs;
- hard-validation summary;
- relevant visible text and focus metadata.

The preferred reviewer is the resumed authoring agent. If it cannot accept
image input, use a configured platform vision model. It returns structured
output:

```json
{
  "relevant": true,
  "reason": "The open invite dialog shows the old free-text field on the left and the new suggestion list on the right.",
  "focusAccurate": true,
  "needsRepair": false
}
```

If `needsRepair` is true, the evidence agent receives the reason and may submit
one replacement plan. A second failure is terminal until a human or the author
requests a rerun.

### 8. Publish, gate, and clean up

Verified artifacts become the session's current evidence set. Base/head
containers and databases are removed after the run. On a new head:

- mark the prior evidence `stale` synchronously;
- stop returning it from proposal/session serializers;
- remove its PR block or change it to a pending link;
- queue a new paired run.

Evidence is advisory by default: collection, execution, and presentation are
active on every deployment, while review/vote controls remain available. A
future enforcement change may gate those controls only after the success and
relevance targets below are met and evidence is `verified`, `not_required`, or
explicitly overridden by an authorized human.

## Version 1 evidence-plan contract

The external submission contract carries semantic intent. The post-build
agent expands it into the executable `replay` section. Both use a versioned
shape so future actions do not reinterpret stored plans.

```json
{
  "version": 1,
  "impact": "ui",
  "rationale": "The invite flow now displays matching usernames while typing.",
  "stories": [
    {
      "id": "invite-suggestions",
      "claim": "Typing a username shows suggestions without hiding the invite controls.",
      "persona": "member",
      "viewports": [
        { "name": "desktop", "width": 1280, "height": 800 }
      ],
      "intent": {
        "startPath": "/lists/demo",
        "steps": [
          "Open Members",
          "Open Invite",
          "Type ma in Username"
        ],
        "checkpoint": "Suggestions and the Invite button are visible together",
        "focus": "Invite member dialog",
        "baseState": "present",
        "animation": "steps"
      },
      "replay": {
        "before": {
          "startPath": "/lists/demo",
          "actions": [
            {
              "id": "open-members",
              "stage": "members",
              "type": "click",
              "target": { "by": "role", "role": "button", "name": "Members", "exact": true }
            },
            {
              "id": "open-invite",
              "stage": "invite",
              "type": "click",
              "target": { "by": "role", "role": "button", "name": "Invite", "exact": true }
            },
            {
              "id": "type-query",
              "stage": "query",
              "type": "fill",
              "target": { "by": "label", "value": "Username", "exact": true },
              "value": "ma"
            }
          ]
        },
        "after": {
          "startPath": "/lists/demo",
          "actions": [
            {
              "id": "open-members",
              "stage": "members",
              "type": "click",
              "target": { "by": "role", "role": "button", "name": "Members", "exact": true }
            },
            {
              "id": "open-invite",
              "stage": "invite",
              "type": "click",
              "target": { "by": "role", "role": "button", "name": "Invite", "exact": true }
            },
            {
              "id": "type-query",
              "stage": "query",
              "type": "fill",
              "target": { "by": "label", "value": "Username", "exact": true },
              "value": "ma"
            }
          ]
        },
        "checkpoint": {
          "id": "suggestions-open",
          "label": "Username suggestions visible",
          "focus": {
            "before": { "by": "role", "role": "dialog", "name": "Invite member" },
            "after": { "by": "role", "role": "dialog", "name": "Invite member" }
          },
          "assertions": {
            "before": [
              { "type": "hidden", "target": { "by": "role", "role": "listbox" } },
              { "type": "visible", "target": { "by": "role", "role": "button", "name": "Invite" } }
            ],
            "after": [
              { "type": "visible", "target": { "by": "role", "role": "listbox" } },
              { "type": "visible", "target": { "by": "role", "role": "button", "name": "Invite" } }
            ]
          },
          "animation": "steps"
        }
      }
    }
  ]
}
```

### Bounds

- Maximum three stories.
- Maximum two viewports per story.
- Maximum 40 actions per side per viewport.
- One final checkpoint per story in version 1.
- Maximum 10 seconds for an individual wait; maximum 45 seconds per side.
- Maximum 200 characters for ids/labels and 1,000 characters for a claim or
  rationale.
- Maximum 256 characters for a locator value and 512 for a relative path.
- Maximum 100 characters for typed fixture text.
- `intent.baseState` is `present` by default. Use `not_present` only when the
  screen or control is genuinely new; the base replay must still assert and
  capture an explicit absence page or a stable parent container.
- Typed values must be literals approved by validation; secrets, tokens, email
  addresses outside the synthetic fixture domain, and pasted user content are
  rejected.

### Locator forms

Use semantic locators first:

1. `testId`;
2. `role` plus accessible name;
3. `label`;
4. `placeholder`;
5. exact visible `text`;
6. bounded CSS selector as a last resort.

Ephemeral Playwright snapshot references and XPath are not stored. When a
normal browser click used an ephemeral reference during exploration, the
agent must translate it into a semantic locator before submitting the plan.

For canvas or map surfaces, allow a bounded relative-pointer action:

```json
{
  "type": "clickPoint",
  "surface": { "by": "css", "value": "canvas.game" },
  "xRatio": 0.62,
  "yRatio": 0.41
}
```

Ratios must be between 0 and 1 and are resolved inside the visible surface's
bounding box. Plans using relative-pointer actions require two successful
clean replays and are labelled `relative-pointer` in provenance.

### Supported actions

- `navigate` to a validated relative path;
- `click`;
- `fill`;
- `press`;
- `select`;
- `check` / `uncheck`;
- `hover`;
- `drag` between two semantic locators;
- `clickPoint` / `dragPoints` relative to one bounded surface;
- `scrollIntoView`;
- `scrollBy` with bounded distance;
- `waitFor` a locator, visible text substring, URL pattern, or quiet network;
- `waitForHostedApp` with an exact app slug after opening a running public app;
- `assert` through the checkpoint assertion collection.

Each story and viewport replays against a fresh copy of the same paired app
fixture. Changes made while capturing one viewport cannot change the starting
state of another. Plans should still use `check` or `uncheck` when setting a
checkbox to a known state.

Every state-changing action has a stable `stage` name. Matching stage names
align base/head animation frames even when the underlying locators differ.

### Supported assertions

- visible / hidden;
- attached / detached;
- exact or contained text;
- element count;
- input value;
- checked state;
- relative URL/path;
- focus within the expected container.

Assertions are evidence readiness checks, not automatically durable proposal
checks. The implementation agent should still add or update a `dapp.json` test
for behavior that deserves long-term regression coverage.

## Evidence MCP tools

Expose a small, run-scoped MCP server in `evidence` mode. It should not expose
generic platform APIs.

### `evidence_get_context`

Returns sanitized run metadata, intent, changed-file summary, base/head labels,
available viewports/personas, and the allowed origins. It never returns raw
credentials.

### `evidence_reset_side`

Resets one side's browser context and, when the story performed writes, restores
its pristine database snapshot. This is for exploration only; the replay tool
always starts clean.

### Browser exploration tools

Use the pinned Playwright MCP surface, restricted by a proxy to the two run
origins. Screenshot results must be emitted as image content so vision-capable
models can inspect them.

### `evidence_run_plan`

Accepts only `{replays: [{id, replay}, ...]}`. The platform attaches the
accepted version, impact, rationale, claim, persona, viewports, and semantic
flow for each story. It rejects unknown, duplicate, or missing story ids and
validates the assembled versioned plan before executing two clean replays and
returning:

- assertion results;
- action/stage timings;
- console, page, and failed-request diagnostics;
- focused/context images for the final replay;
- media size estimates;
- a plan hash;
- a hard verdict and specific failure reason.

The first call is the initial attempt. At most one replacement call is allowed
after semantic review rejects the result.

### `evidence_finish`

Accepts `verified`, `not_relevant`, or `failed` plus a bounded user-visible
reason. `verified` is accepted only when `evidence_run_plan` has a passing hard
verdict for the same plan hash.

## Replay engine

Implement the executor as ordinary Playwright code, separate from
`capture/capture.js`. The current capture script has a different contract:
route load, screenshot, automatic scroll, and proposal checks. Keeping the new
executor separate prevents an evidence feature from destabilizing the checks
gate.

For each side and viewport:

1. Create an isolated browser context.
2. Set viewport, device scale, locale, timezone, color scheme, reduced motion,
   permissions, and synthetic identity.
3. Disable CSS transitions, nonessential animations, blinking carets, and
   smooth scrolling unless the story is `motion`.
4. Navigate only to the side origin plus the validated relative start path.
5. Wait for the configured load readiness and install console/page/request
   listeners.
6. Execute actions sequentially with per-action diagnostics.
7. Capture a stable frame after each named stage when animation is requested.
8. Evaluate checkpoint assertions.
9. Resolve the focus locator and require a visible, non-zero bounding box.
10. Take the full context PNG.
11. Take a focused PNG with 24 px padding, clamped to the viewport.
12. Close the context and repeat from pristine state for reproducibility.

The runner maps the logical origin token (`base` or `head`) to the internal
URL. Plans never contain hostnames or auth query parameters.

### Focus normalization

For a directly comparable pair:

- prefer the same stable container on both sides;
- calculate each focus rectangle plus padding;
- expand the smaller rectangle to the maximum pair width/height while keeping
  it centered and inside the viewport;
- store both original element boxes and final crop boxes;
- retain full context images so a crop can never hide surrounding evidence.

If the changed element does not exist on one side, the story must name a stable
before/after parent container. A missing focus locator is not silently replaced
with `body`.

### Network and console policy

- Console errors, uncaught exceptions, failed main-document loads, and failed
  same-origin requests fail the hard verdict unless explicitly allowlisted by
  an existing durable app check.
- Third-party network is disabled by default in evidence environments.
- Requests may not leave the app/platform allowlist.
- A continuously polling app uses bounded quiet windows, matching the lessons
  in the existing proposal-check runner.

## Relevance validation

### Hard validation

All of the following are required before semantic review:

- base and head image/runtime digests match the recorded SHAs;
- both databases came from the same pinned template fingerprint;
- persona, viewport, browser configuration, and hosted-asset revision match;
- every action completed or produced an explicitly expected absence;
- every checkpoint assertion passed;
- focus regions were visible and large enough to inspect;
- no unexpected cross-origin navigation, login page, error page, or route
  fallback occurred;
- both reproducibility runs agreed;
- artifacts were produced by the current plan hash and head SHA;
- no artifact exceeded its size cap;
- no prior-head artifact remains associated with the proposal response.

### Semantic validation

The reviewer model answers only whether the evidence demonstrates the stated
claim and whether the selected focus is honest. It is not asked to decide
whether the code is correct or whether the proposal should merge.

Pixel similarity is diagnostic, not a gate:

- an exactly identical pair may be valid for an interaction-only regression
  fix whose visible success is "nothing moved";
- a very large difference may be legitimate for a redesign;
- image hashes can flag suspicious results for the semantic reviewer but must
  not replace the declared assertions and claim.

### Special cases

- **New screen:** capture an intentional base `404`/absence or a named stable
  parent state and label it "Not present in base." Never fall back to `/`.
- **Removed UI:** assert the old element is visible on base and absent on head,
  while focusing the same surrounding container.
- **New control needed to reach the state:** use side-specific actions and a
  shared semantic checkpoint.
- **Motion change:** use the motion artifact profile below and keep still
  checkpoints at the start/end states.
- **Canvas/game/map:** use relative surface coordinates, fixed fixtures, and
  two successful replays.
- **Admin/private screen:** use the synthetic read-only admin persona for
  inspection. Use the evidence-only `full_admin` persona only for Homeroom
  controls that require admin writes. It exists only in the paired disposable
  databases. Use authenticated artifact delivery and never place the image in
  a public PR body.
- **No visual impact:** store the agent rationale and show `not_required`; do
  not run route capture just to fill the card.

## Artifact formats

### Required stills

Each verified story/viewport stores:

- base focused PNG;
- head focused PNG;
- base context PNG;
- head context PNG.

Use lossless PNG because text and UI chrome compress well and reviewers need
sharp typography. Keep the existing 2x device scale default unless the app
explicitly opts out.

### Lightweight interaction animation

Animation is opt-in per story and generated only from the clean replay.

#### `steps` profile (default for interaction evidence)

- Capture one stable frame after each named stage plus the final checkpoint.
- Drop perceptually duplicate adjacent frames.
- Hold each remaining frame for 250-500 ms.
- Encode a paired, side-by-side WebM at 4 fps.
- Maximum combined width: 960 px.
- Maximum duration: 8 seconds.
- No audio.
- Target size: 1.5 MB; hard cap: 4 MB.
- Overlay a small stage label and optional click indicator outside the focus
  content, never over the changed UI.

This is closer to an animated interaction storyboard than a conventional
screen recording. It is cheap, deterministic, and makes the exact flow visible
without recording seconds of idle pixels.

#### `motion` profile

- Use only when animation, dragging, scrolling behavior, or transition timing
  is itself part of the claim.
- Record the bounded segment named by the plan at 8-10 fps.
- Maximum combined width: 960 px.
- Maximum duration: 8 seconds.
- No audio.
- Target size: 2 MB; hard cap: 6 MB.

#### Encoding and delivery

- Use WebM for the in-app experience; it is materially smaller than GIF.
- Do not create a GIF for every story.
- If a public PR embed is explicitly allowed, generate a 4 fps, 480 px GIF
  fallback from `steps` frames under the existing artifact cap.
- Static stories produce no animation.
- The review UI must prefer PNGs, with animation behind a play control. Never
  autoplay multiple proposal videos.

## Storage model

Do not overload `session_visuals` with plan/run state. Keep it readable during
rollout and introduce revision-scoped evidence records.

### `visual_evidence_runs`

Suggested columns:

```text
id                     varchar(32) primary key
session_id             integer references chat_sessions on delete cascade
base_sha               varchar(40) not null
head_sha               varchar(40) not null
plan_version           integer not null
plan_hash              varchar(64)
intent                 jsonb not null
replay_plan            jsonb
trace_summary          jsonb
hard_verdict           jsonb
semantic_verdict       jsonb
state                  varchar(24) not null
trigger                varchar(32)
fixture_fingerprint    varchar(128)
base_image_digest      text
head_image_digest      text
repair_attempt         smallint not null default 0
started_at             timestamptz
completed_at           timestamptz
created_at             timestamptz not null default now()
```

States:

```text
planned -> provisioning -> exploring -> replaying -> reviewing -> verified
                                             \-> failed
verified -> stale
planned/provisioning/... -> cancelled
not_required and overridden are terminal sibling states
```

Enforce one current non-stale run per `(session_id, head_sha)` and reject state
transitions that skip required verdicts.

### `visual_evidence_artifacts`

Suggested columns:

```text
id                 varchar(32) primary key
run_id             varchar(32) references visual_evidence_runs on delete cascade
story_id           varchar(96) not null
viewport           varchar(16) not null
side               varchar(8) not null       -- base, head, paired
variant            varchar(16) not null      -- focus, context, animation
media              varchar(8) not null       -- png, webm, optional gif
content_type       varchar(32) not null
data               bytea not null
width              integer
height             integer
bytes              integer not null
focus_rect         jsonb
stage_labels       jsonb
created_at         timestamptz not null default now()
```

### `chat_sessions` summary

Add only the latest-state pointers needed by hot proposal queries:

```text
visual_evidence_state       varchar(24)
visual_evidence_run_id      varchar(32)
visual_evidence_detail      jsonb
visual_evidence_updated_at  timestamptz
```

The detail snapshot contains claims, progress, failure reason, override
metadata, and whether evidence is required. It does not duplicate binary data
or the full replay trace.

Mark both new tables `staging:private`. Keep failed-run metadata for 30 days,
failed binary artifacts for at most 24 hours, and only the current verified
binary set plus a short rollback window. The existing stale-preview sweeper is
the natural owner for environment cleanup; a separate evidence GC pass owns
database rows and artifacts.

## Artifact authorization

The current `/visuals/:id` route is public so GitHub's image proxy can fetch
unguessable URLs. Agent-driven evidence can deliberately enter privileged UI,
so unguessability is not sufficient.

Add authenticated evidence delivery:

```text
GET /api/apps/:slug/proposals/:sessionId/evidence/:artifactId
```

Require the same proposal/app visibility as the proposal detail. Use immutable
caching only within the authorized response path. The initial release puts a
link and claim summary in GitHub PR bodies rather than embedding protected
images.

An app may later opt a story into public PR embeds only when:

- the persona is the non-admin synthetic member;
- all data is generated evidence fixture data;
- the plan declares public-safe intent;
- a platform policy validator accepts it.

Public embedding is not required to ship issue #2380.

## API and tool changes

### Submission

Add `visualEvidence` to:

- `submit_work`;
- `/api/apps/:slug/pr-import`;
- proposal update/handoff routes;
- native hosted-agent session completion.

The shape is the semantic subset of the version 1 contract: `version`,
`impact`, `rationale`, and stories with `intent`. External callers cannot
supply a pre-verified verdict or artifact identifiers.

Submission responses add:

```text
visualEvidenceAccepted
visualEvidenceRejected
visualEvidenceRequired
visualEvidenceNextStep
```

Keep `testingPaths` and `testingSteps` for the manual "Test this change" link
and backward compatibility. They no longer count as verified visual evidence.

### Proposal status

Extend `get_proposal`, proposal detail serializers, and websocket/SSE events
with:

```text
visualEvidence.state
visualEvidence.required
visualEvidence.claims
visualEvidence.baseSha
visualEvidence.headSha
visualEvidence.failureReason
visualEvidence.repairAvailable
visualEvidence.overriddenBy / overriddenAt / overrideReason
visualEvidence.artifactSummary
```

Do not expose internal origins, fixture database names, credentials, or raw
model/tool transcripts.

### Rerun and override

- A same-commit evidence rerun changes no code and clears no votes.
- Rerun reuses the stored intent but always provisions fresh state.
- The author may replace intent before the rerun.
- Only an authorized app administrator may override required evidence, with a
  user-visible reason and audit record.
- Infrastructure failures expose a retry action; relevance failures ask for a
  corrected story/plan.

## Reviewer UI

Replace route-labelled media rows with claim-labelled evidence cards:

```text
Username suggestions remain usable in the invite dialog       Verified
Open Members -> Open Invite -> Type "ma"

Before                                After
[focused image]                       [focused image]

[Play interaction]  [Open full context]  [View verification details]
```

Requirements:

- Show the claim before the media.
- Display base/head labels and short SHAs.
- Keep focused images at identical rendered dimensions.
- Reuse the existing comparison overlay for full-size side-by-side viewing.
- Add an optional slider/difference view only after the basic pair is clear.
- Keep animation behind an explicit play control.
- Show the concise reproduction flow and viewport/persona.
- Show `Not present in base` rather than an unrelated image.
- For failure, show the exact stage/assertion and whether retry or human input
  is needed.
- For pending evidence, do not render legacy route captures as if they were a
  substitute.

The proposal topic head, cards, dev chat, group vote view, gallery, and PR
metadata must consume one shared evidence serializer. Avoid another set of
slightly different legacy/React renderers.

## Security and prompt-injection boundaries

An evidence agent is looking at app-controlled DOM, which may contain
untrusted text. Treat it like an untrusted browser task:

- evidence mode receives no push token or general platform mutation tool;
- use redacted staging clones and synthetic identities only;
- block arbitrary external navigation and third-party requests;
- keep the evidence MCP server run-scoped and origin-scoped;
- never expose session cookies or capture JWTs to the model;
- redact locator input values and diagnostics before persistence;
- cap screenshots, action logs, console output, and DOM excerpts;
- do not store hidden reasoning;
- reject plan text that resembles a credential or token;
- serve artifacts only to authorized reviewers;
- make all cleanup idempotent and sweep orphan environments after crashes.

The agent may read visible app text to identify controls, but page content is
never authorization to change repositories, platform state, or the evidence
rules.

## Performance and cost budgets

Version 1 budgets:

- one evidence agent turn plus at most one repair turn;
- three stories maximum;
- six story/viewport pairs maximum;
- 45 seconds per side per viewport;
- two deterministic executions after exploration;
- four required PNGs per verified story/viewport;
- animation only when requested;
- 12 minutes total orchestration ceiling, including a cold base-image build;
- 4 minutes total evidence-agent wall clock inside that ceiling;
- immediate reuse of base images keyed by exact build inputs;
- no automatic desktop+mobile duplication when only one viewport is relevant.

Record separately:

- environment provisioning time;
- model exploration/review time and tokens;
- replay time by story and side;
- repair count;
- artifact encode time and bytes;
- cleanup time;
- terminal failure class.

## Integration with existing proposal checks

- Leave `capture/capture.js` and the declared `dapp.json` check runner in
  place for proposal correctness checks.
- Proposal checks continue to gate correctness and console health.
- The new evidence runner does not execute the full check suite.
- A relevant `dapp.json` visual scenario may seed evidence intent, but it is
  not accepted as evidence until its interaction plan is replayed and
  reviewed.
- Stop publishing default `/` media for sessions enrolled in evidence v2.
- Keep legacy route capture only for historical proposals created before
  evidence-v2 enrollment. The emergency kill switch suppresses new review
  media instead of reviving route-only capture.
- Remove the convention that agents must add screenshot-only deep links once
  evidence v2 is enforced. Deep links remain useful product/testing affordances
  when they have value beyond capture.

## Implementation sequence

Ship this as reviewable slices. Do not attempt the agent, paired runtime,
storage, UI, and merge gate in one proposal.

### Slice 1: Contracts, state machine, and observability

Add:

- `src/services/visual-evidence-plan.js` for versioned validation,
  normalization, plan hashing, bounds, and redaction;
- `src/services/visual-evidence-state.js` for legal transitions and stale-head
  handling;
- schema additions for runs, artifacts, and session summary fields;
- `visualEvidence` submission parsing and result fields;
- read-only status serialization;
- one default-on emergency kill switch: `VISUAL_EVIDENCE_V2_ENABLED=false`;
- metrics for required/planned/missing/defaulted legacy evidence.

Tests:

- valid/invalid intent shapes;
- action/locator/path/value bounds;
- no hostname or secret-bearing values;
- state transition table;
- head change marks prior evidence stale synchronously;
- submission/update/same-commit rerun behavior;
- backward compatibility when the flag is off.

Exit criterion: proposals can carry intent and expose a truthful pending state,
but the existing capture pipeline is otherwise unchanged.

### Slice 2: Platform browser parity and evidence worker mode

Add:

- Playwright MCP registration to `worker/run-codex-agent.sh` using the same
  pinned server/config as hosted Claude;
- `evidence` mode to worker dispatch and backend registry;
- no-push/no-general-write credentials for that mode;
- run-scoped evidence MCP server and origin-restricting Playwright proxy;
- `record_visual_evidence_intent` in hosted build mode;
- capability detection for tool support and image input.

Tests:

- Claude and Codex build/evidence modes discover the browser tools;
- scout/sync remain browser-free;
- evidence mode has no push credential;
- origins outside the pair are refused;
- model/backend without tools reports `unsupported_agent` rather than
  pretending capture succeeded;
- screenshots reach the model as image content on both supported backends.

Exit criterion: both hosted backends can explore a controlled test page and
submit a typed evidence plan.

### Slice 3: Paired base/head environment provisioning

Add:

- a pinned staging-template source API in `db-manager`;
- evidence-specific database naming and cleanup;
- image cache lookup/build for the exact base SHA;
- head-image reuse by verified digest;
- paired internal runtime/service creation for Docker and Kubernetes;
- equivalent synthetic member, read-only-admin, and evidence-only full-admin
  identity setup;
- lifecycle heartbeat, crash recovery, timeout, and orphan sweep integration.

Tests:

- both databases derive from one immutable template fingerprint;
- a template refresh cannot split the pair;
- base and head images match requested SHAs;
- no live production container/database is used;
- public staging mutations do not appear in the evidence head clone;
- cleanup is idempotent after success, timeout, cancellation, and restart;
- Kubernetes and Docker names stay DNS-safe.

Exit criterion: a fixture app can be opened at internal base/head origins with
equivalent starting data.

### Slice 4: Deterministic replay engine

Add a separate `evidence/` runtime or service containing:

- plan executor;
- semantic locator resolver;
- relative-pointer resolver;
- action/stage recorder;
- assertion engine;
- console/page/request diagnostics;
- focus/context screenshot capture;
- reproducibility rerun;
- structured stdout or direct run-result protocol;
- size/time caps and partial-failure reporting.

Tests use small fixture pages for:

- modal open + form fill;
- hover-only state;
- select/checkbox/keyboard interaction;
- drag and relative canvas click;
- different base/head locators with the same checkpoint;
- expected element absence;
- new-screen base absence;
- missing/ambiguous focus failure;
- route/login/error fallback refusal;
- console and request failures;
- two-run disagreement marked flaky/failed;
- viewport and crop normalization.

Exit criterion: a stored plan produces reproducible paired PNGs without a
model involved.

### Slice 5: Evidence-agent orchestration and semantic review

Add:

- post-build evidence dispatch after head readiness;
- author-thread resume when available;
- sanitized fallback context for external/unresumable authors;
- exploration tools and `evidence_run_plan` / `evidence_finish`;
- one-repair-loop enforcement;
- fallback vision reviewer selection;
- progress events and terminal diagnostics;
- cancellation/supersession on head changes.

Tests:

- resumed hosted-agent path;
- external-agent fallback path;
- non-vision author uses fallback reviewer;
- accepted first plan;
- rejected plan repaired once;
- second failure terminal;
- head moves during exploration/replay;
- stale operation cannot publish artifacts.

Exit criterion: a real UI fixture goes from intent to semantically verified
evidence with no human intervention.

### Slice 6: Artifact encoding, storage, and authorization

Add:

- focused/context artifact persistence;
- `steps` and `motion` ffmpeg profiles;
- perceptual frame deduplication;
- paired animation compositor;
- authenticated artifact route;
- retention/GC;
- artifact metadata serializer;
- public-embed refusal for privileged evidence.

Tests:

- static story emits no video;
- step story encodes at 4 fps and stays under caps;
- motion story respects 8-10 fps/duration caps;
- failed encoding does not lose PNG evidence;
- unauthorized artifact access is refused;
- authorized range requests work for WebM;
- GC preserves the current verified set and removes expired failed media.

Exit criterion: verified evidence is stored safely and can be reviewed without
the legacy public `/visuals/:id` route.

### Slice 7: Reviewer UI and PR metadata

Add:

- shared evidence serializer/view model;
- claim-first evidence cards;
- focused pair, context expansion, and optional animation player;
- verification details and failure recovery UI;
- pending/stale/overridden states;
- secure Homeroom evidence link in PR metadata;
- gallery filters for relevance failure, replay failure, unsupported agent,
  and override.

Reuse the React visual-comparison overlay for full-size pairs. Move any legacy
HTML rendering needed by proposal surfaces behind the same view model; do not
create new cross-surface styling dependencies.

Tests:

- desktop/mobile rendering;
- keyboard and screen-reader labels;
- no autoplay;
- long claims/stage labels;
- new-screen and removed-UI labels;
- authenticated media errors;
- stale evidence never appears on a newer head;
- PR body update/removal is idempotent.

Exit criterion: reviewers can understand what changed without opening the
preview or reading implementation details.

### Slice 8: Default-on operation, enforcement, and legacy retirement

Collection, execution, and presentation ship enabled. They do not require a
canary deployment or an operator configuration change. Operate in stages:

1. **Advisory:** run evidence v2 for proposals that carry intent, show verified
   v2 evidence first, and collect metrics and human relevance ratings.
2. **Improve:** fix failure classes while leaving missing/failed evidence
   truthful and never substituting legacy route media.
3. **Enforce later:** only through a separate reviewed product change after the
   promotion targets below are met; UI proposal review/vote actions may then
   require `verified`, `not_required`, or authorized `overridden` evidence.
4. **Retire:** stop generating automatic scroll GIFs and remove the mandatory
   screenshot-state-deep-link convention.

Keep one emergency switch capable of stopping evidence v2 without restoring
irrelevant `/` screenshots. Do not split ordinary activation across deployment
flags.

## Test strategy

### Unit coverage

- plan schema and version routing;
- locator/action validation;
- plan hash stability;
- state transitions;
- semantic-review result validation;
- crop geometry;
- animation profile calculation;
- public/private artifact policy;
- status serialization and gating.

### Integration coverage

- disposable PostgreSQL paired clones;
- Docker and Kubernetes evidence runtimes;
- Claude and Codex MCP tool discovery;
- exact base/head checkout and image provenance;
- artifact storage/range serving;
- restart/harvest of an in-flight run;
- head supersession and cleanup.

### End-to-end acceptance fixtures

Create a deliberately small fixture app with stable synthetic data and these
proposal pairs:

1. A modal reached through two clicks.
2. A typeahead reached through typing.
3. A hover menu.
4. A drag/canvas interaction.
5. A mobile-only layout change.
6. A brand-new route.
7. A removed control.
8. A motion/transition change.
9. A backend-only change.
10. A broken plan that would previously have fallen back to `/`.

For each fixture, assert the exact evidence state, claims, action stages,
artifacts, provenance, sizes, and reviewer presentation.

### Production canaries

Before enforcement, run against selected self-app proposals and have humans
answer one question per story: "Does this evidence show the change described?"
Do not ask for a general aesthetic score.

Promotion targets:

- at least 90% of UI proposals produce verified evidence without human repair;
- at least 95% of verified stories are rated relevant by human reviewers;
- fewer than 5% require the one repair attempt;
- zero verified stories used an undeclared route fallback;
- zero stale-head artifacts shown;
- p95 artifact set under 6 MB per story/viewport;
- p95 warm-base evidence completion under 4 minutes;
- no cross-app or unauthorized artifact access in security testing.

## Acceptance criteria for issue #2380

The issue is complete only when all of these are true:

- A proposal changing an interaction-only modal produces a focused, labelled
  before/after pair after real clicks and typing.
- The evidence was generated against the exact recorded base and head SHAs,
  not live production and not a moving branch.
- The same bounded plan passed twice from fresh state.
- The implementing agent or a documented fallback vision reviewer confirmed
  that the pair demonstrates the claim.
- A static change produces paired PNGs without an unnecessary video.
- An interaction change can produce a 4 fps lightweight step animation under
  the configured size cap.
- A motion-specific change can opt into the bounded 8-10 fps profile.
- A newly added screen is labelled absent on base rather than showing home.
- An unreachable or irrelevant state produces an explicit failure and no
  substitute screenshot.
- A new commit immediately hides evidence from the prior head.
- Hosted Claude and hosted Codex/OpenRouter can both run the evidence browser
  tools, or the unsupported backend is reported truthfully.
- External-agent submissions can carry evidence intent and are completed by a
  platform evidence agent.
- Privileged evidence is never served through the public legacy visual route.
- Reviewers see the claim, concise flow, focused pair, provenance, and
  verification status together.
- The default-on evidence mechanism has one emergency off switch that never
  revives the `/` fallback; enforcement remains advisory until separately
  approved.

## Rollback and operational recovery

- All schema changes are additive.
- One default-on switch controls collection, execution, and presentation as a
  unit; setting it to false leaves proposal checks and staging previews
  untouched and does not publish legacy default-root captures.
- Evidence remains advisory by default. Enabling a merge/review gate is a
  separate reviewed product change, not a deployment flag rollout.
- A stuck evidence run is terminalized with its phase and can be rerun on the
  same commit.
- A platform restart adopts or cancels a run using its heartbeat and exact
  run/head identity, following the existing check-run harvest pattern.
- Environment teardown and artifact GC are safe to repeat.
- Existing `session_visuals` rows continue to render for historical proposals
  until a separate migration/retention decision removes them.

## Final implementation principle

The authoring model supplies meaning: what changed, how a person reaches it,
and what would prove it. The platform supplies control: isolated environments,
bounded actions, deterministic replay, provenance, validation, media encoding,
authorization, and truthful failure.

Neither half is sufficient alone. Agent judgment without replay is
non-reproducible; replay without agent intent recreates the irrelevant-homepage
problem in a more elaborate form.
