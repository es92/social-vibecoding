# Before/after shots

Every proposal that changes something people can see gets before/after
shots. The author declares each change in plain words, along with how to
reach it. Homeroom then builds private copies of the app from before and
after the change. A preview agent follows the declared steps on both builds
and saves what it sees: a still for each screen size and side, plus a short
clip of each side when the change is motion a still cannot show. People look
at the shots to judge the change. Nothing replays them and no model grades
them.

This replaced the earlier replay pipeline. There, the agent wrote a typed
browser program, the platform replayed it twice, and a run published only if
both replays matched pixel for pixel. In a production sweep of proposals
4400–4957, 16 of 125 finished runs were published. Most losses came from
that contract: the agent gave up or timed out writing the program, or the
program failed replay on a locator, an assertion, or a fingerprint.

## Vocabulary

| Word | Meaning | Stored as |
| --- | --- | --- |
| declared change | One visible change the author declares (up to three per proposal) | `intent.stories[]` |
| before / after | The build without and with the proposal | `base` / `head` |
| shot | A PNG of the screen (`kind: "screen"`) or of one element (`kind: "element"`) | variant `context` / `focus` |
| clip | A WebM of one side, for a `motion` change | variant `animation`, side `base`/`head` |
| screen | A declared viewport (`desktop`, `mobile`, …) | `viewport` |
| skipped | A change the preview agent could not reach, with its reason | `hard_verdict.stories[].status` |
| preview agent | The hosted model that takes the shots | evidence worker turn |

Database tables, API fields and routes keep their original names
(`visual_evidence_*`, `visualEvidence`, `/evidence/`). Stored sides stay
`base`/`head`; the agent and people only see *before* and *after*.

## Declaring a change

The implementing agent declares changes with `record_visual_evidence_intent`
on a hosted build turn, or with `visualEvidence` on `submit_work` from an
external agent. The shape is unchanged from version 1:

```json
{
  "version": 1,
  "impact": "ui",
  "rationale": "The invite dialog now suggests members as you type.",
  "stories": [{
    "id": "invite-suggestions",
    "claim": "Typing a username shows suggestions beside the invite button.",
    "persona": "member",
    "viewports": [{ "name": "desktop", "width": 1280, "height": 800 }],
    "intent": {
      "startPath": "/lists/demo",
      "steps": ["Open Members", "Open Invite", "Type ma"],
      "checkpoint": "Suggestions and the Invite button are visible together",
      "focus": "Invite member dialog",
      "animation": "steps",
      "hints": {
        "setup": "Create a list from the + button first",
        "expectText": ["Suggestions"],
        "focusTarget": { "by": "role", "role": "dialog", "name": "Invite member" }
      }
    }
  }]
}
```

- `impact: "none"` with a specific `rationale` means nothing visible changed.
  No run starts and the proposal says so.
- `animation: "motion"` asks for clips as well as stills.
- `hints` are optional. They pass on what the author learned while building
  (data to create first, text that proves the state was reached, and the
  element to point at), so the preview agent can go straight there. They are
  guidance only and are never executed.
- `controlledFailurePath` still lets an error state be shot. The preview
  agent makes that exact API GET fail on both builds, and the shots are
  labelled as a controlled test.

An agent-written replay plan (`visualEvidencePlan` on `submit_work`) is
ignored, and `submit_visual_evidence_plan` no longer exists.

## A run, end to end

1. **Queued.** A run is created for the proposal's exact submitted commit
   (`planned`) when the declaration requires shots.
2. **Building before and after** (`provisioning`). Homeroom builds isolated
   copies of the exact base and head revisions. It resets both to the same
   fixture data and signs in each persona's browser.
3. **Taking the shots** (`exploring`). The preview agent gets one turn in an
   evidence worker. It has three browsers, one per persona, and the "shots"
   tools:

   | Tool | What it does |
   | --- | --- |
   | `get_brief` | The declared changes, before/after addresses, which browser to use for whom, changed files and progress so far |
   | `save_shot` | Publishes a PNG the browser saved with `browser_take_screenshot` for a change, screen and side |
   | `save_clip` | Publishes the clip that the change's browser recorded most recently |
   | `skip_change` | Records why a change cannot be reached; without a change id, it skips all of them |
   | `fail_request` | Blocks a declared `controlledFailurePath` on both builds |

   For each change and screen, the agent resizes the browser and follows the
   steps on the after address, then saves a shot. It does the same on the
   before address. For a `motion` change it also records one clip per side.
   It calls `browser_close` to end the stills session, resizes again, and
   triggers only the motion. Then it calls `browser_close` again, which writes
   the recording, and `save_clip` publishes it.
4. **Saving** (`reviewing`). Each change is folded into one result. A change
   is **ready** when every screen has a before and an after screen shot, plus
   a before and an after clip if it is motion. Element shots are optional
   extras. Anything else is **skipped**, with the agent's reason or, failing
   that, a list of exactly what is missing. The files of ready changes are
   stored, fenced by a hash of the manifest, and the before/after builds are
   torn down.
5. **Shots ready** (`verified`). A run publishes if at least one change is
   ready, so one unreachable change never hides the others. If none is
   ready, the run fails with `evidence_capture_incomplete` and each change's
   reason. If the agent itself failed and skipped nothing, it keeps the
   agent's error instead.

`hard_verdict` records the outcome:
`{ passed, mode: "shots", runs: 1, stories: [{ id, status, reason? }] }`.
`plan_hash` holds the manifest hash, which names exactly the files
published.

A run that a platform restart interrupted is retried automatically, up to twice per commit. A
person can take the shots again, stop a running set, or (as an app manager)
waive them.

## What the platform checks, and what it does not

The platform checks:

- every file came from this run's short-lived, run-scoped token;
- it is addressed to a declared change, one of that change's screens, and a
  side;
- a shot is one complete PNG under 6 MB and at most 8192 px on each edge;
- a clip is a WebM between 1 KB and 20 MB, only for a `motion` change;
- the bridge reads only a plain `.png` that is directly inside a persona's
  browser output directory, named by the agent. For a clip, it reads only the
  newest `.webm` in the change's persona directory. Taking a clip retires
  every older recording there, so a stale session can never be published
  later.

It does **not** prove that a "before" shot was taken on the before address,
or that the shot shows the change. These are the preview agent's
observations, and people are the judges, which is also how the replay
pipeline ended: people still had to look. The builds are platform-made from
exact revisions with fixture data, so no author's local data or credentials
can appear in them.

## What people see

The proposal's card leads with each declared change:

- **Ready.** Before and after side by side for each screen. The element shot
  leads when there is one, and "Open full screen" shows the screen shots.
  Motion changes also show a before and an after clip player.
- **Skipped.** The change, a "Skipped" badge and the reason.
- While running, the card shows its state ("Building before and after",
  "Taking the shots", "Saving the shots") and a Stop action. A failed run
  offers "Take the shots again".

The public view model and the connector's `get_proposal` carry `shotResults`
(`[{ id, status: "ready" | "skipped", reason }]`) beside `claims` and
`artifacts`. Runs from before shots have no `shotResults`, and their older
paired clips still play.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `VISUAL_EVIDENCE_V2_ENABLED` | `true` | The one kill switch: stops collecting declarations, taking shots and showing them |
| `VISUAL_EVIDENCE_MAX_AGENT_MS` | 480000 | The preview agent's turn budget |
| `VISUAL_EVIDENCE_MAX_RUN_MS` | 1440000 | Whole-run budget, also used by recovery |

Clips are recorded only for runs with a `motion` change
(`EVIDENCE_RECORD_CLIPS=1` in the worker adds `--save-video=1280x800` to each
browser). Each persona's browser saves files under
`EVIDENCE_SHOTS_DIR/<member|admin|full_admin>` via `--output-dir`.

## Where it lives

| Piece | File |
| --- | --- |
| Declaration schema (`parseIntent`, `hints`, `needsClip`) | `src/services/visual-evidence-plan.js` |
| File checks and per-change results (`shotTarget`, `summarize`) | `src/services/visual-evidence-shots.js` |
| Run-scoped control (`saveShot`, `skipChange`, `summary`) | `src/services/visual-evidence-control.js` |
| Internal routes (`/context`, raw `/shot`, `/skip`) | `src/routes/internal.js` |
| Run flow and the brief (`executeRun`, `shotsBrief`) | `src/services/visual-evidence-orchestrator.js` |
| Preview agent prompt and dispatch | `src/services/visual-evidence-agent.js` |
| Shots bridge (MCP server `shots`) | `worker/evidence-mcp.js` |
| Browser servers (`--output-dir`, `--save-video`) | `worker/write-evidence-mcp-config.js`, `worker/run-codex-agent.sh` |
| States, storage, public summary | `src/services/visual-evidence-state.js`, `src/services/visual-evidence-view.js` |
| Proposal card | `public/js/app-view.js` (`visualEvidenceHtml`) |

## Diagnosing a run

The proposal author and app managers can read
`GET /api/apps/:slug/proposals/:sessionId/evidence/diagnostics` (add
`?runId=` for an earlier run). It carries the run's revisions, provenance,
`shotResults`, stored files (sizes and hashes, not bytes), the failure code
and reason, and a bounded trace:

- `trace.failure` gives the phase, code and message, plus the last refused
  tool call (`tool`, `toolCode`, `toolMessage`);
- `trace.control` gives the files saved, the changes skipped and whether
  everything was skipped;
- `trace.agentDispatches` and `trace.agentActivity` give the backend and
  model, fallback, tool counts, and pending browser and provider calls. See
  `evidence-planner-diagnostics.md` for reading a timeout;
- `trace.agentFinalResponse(s)` holds the agent's own last words (private
  to this route).

## Not yet known

The pipeline has been exercised end to end with real processes: Playwright
MCP saved named screenshots and recorded clips, and the bridge published them
through the internal route and run control, including every refusal path. It
has **not** yet run with a live model on real proposals. The open question
is how often the preview agent reaches each declared state and picks the
right moment to shoot. Rerunning a batch of recent proposals whose replay
failed with real claims, and having a person judge each pair, is the next
step.
