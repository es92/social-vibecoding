# Capture-first visual evidence (trial)

`VISUAL_EVIDENCE_CAPTURE_MODE=on` changes what the hosted evidence agent is
asked to do. It no longer writes a replay program that the platform must
reproduce twice. It follows the author's accepted steps on the exact base and
head previews and publishes the screenshots it takes itself. Author-supplied
replay plans (`visualEvidencePlan`) still replay exactly as before. The
default is `off`.

## Why

A production sweep of proposals 4400–4957 found 125 evidence runs that
finished. Only 16 were verified, and several of those showed identical or
unrelated before/after images. The failures were spread across many
sequential gates:

- zero-story runs forced by the file heuristic (fixed separately);
- the planner stopping without a plan, or timing out;
- runs killed by redeploys (retried separately);
- replay mismatches such as locator, assertion, fingerprint and browser-console
  failures;
- infrastructure failures.

Most of the planner and replay failures come from the contract itself. The
agent must emit a typed program in which every locator matches exactly one
element on both revisions, and two fresh replays must then agree on a
perceptual hash. In capture mode the agent only has to reach the screen and
take the picture. People still judge whether the picture shows the claim.

## Flow

1. The run provisions the same paired, fixture-seeded base and head previews.
2. The agent calls `evidence_get_context`, then for each story and viewport it:
   - calls `browser_resize`;
   - follows `intent.startPath` and `intent.steps` on each origin;
   - calls `browser_take_screenshot` with a filename;
   - calls `evidence_capture({storyId, viewport, side, variant, file})`.
3. When a story's state cannot be reached, the agent calls
   `evidence_report_blocker({storyId, reason})`. That story is shown as
   "Not captured" with the reason. The other stories are still published.
4. A story is published when every accepted viewport has a base and a head
   context image. Focus crops are optional.
5. If no story is complete, the run fails as `evidence_capture_incomplete`
   with each story's reason. If the agent errored with nothing captured and no
   blocker reported, the agent's own error is kept.

A published run is stored as `verified`, with
`hard_verdict.mode = 'agent_capture'` and `runs: 1`. The proposal card says
"The preview agent took these on the exact base and proposal builds" instead
of "These captures passed replay checks".

## Author hints

`intent.hints` is optional on every story:

- `setup`: data to create first, through the UI;
- `expectText`: up to five short strings that prove the checkpoint was
  reached;
- `focusTarget`: one locator for the claimed element.

These hints steer the agent straight to the state the author already reached.
They are never executed and never treated as proof.

## Plumbing

| Piece | Where |
|---|---|
| Validation and per-claim summary | `src/services/visual-evidence-capture.js` |
| Run control (`submitCapture`, `blockStory`, `captureSummary`) | `src/services/visual-evidence-control.js` |
| Raw-PNG route (7 MB parser, 6 MB capture limit) | `POST /api/internal/evidence/:runId/capture` |
| Per-story blocker route | `POST /api/internal/evidence/:runId/block-story` |
| Bridge tool; reads only `EVIDENCE_SHOTS_DIR/<persona>/<name>.png` | `worker/evidence-mcp.js` (`evidence_capture`) |
| Browser servers save named screenshots per persona | `--output-dir` in `worker/write-evidence-mcp-config.js` and `worker/run-codex-agent.sh` |
| Capture path (`exploring → reviewing → verified`) | `src/services/visual-evidence-orchestrator.js` |

## Trust boundary

These images are the agent's observations, not a reproduced result. The
platform checks the following:

- each image is one complete PNG under 6 MB;
- it is addressed to an accepted story, viewport and side;
- it came from this run's scoped token.

The platform does not check that a "base" image was taken on the base origin.
The previews are still platform-built from the exact revisions with fixture
data. No author's local data or credentials can appear in them.

## Trial and evaluation

1. Set the flag in one environment:
   - Docker deploy: the repo variable `VISUAL_EVIDENCE_CAPTURE_MODE=on`.
   - Helm: `platform.visualEvidenceCaptureMode: "on"`.
2. Rerun visual evidence on recent proposals whose replay failed with real
   claims. Suggested cases:
   - 4781, 4832, 4842, 4844, 4854, 4868, 4885;
   - 4907, 4908, 4909, 4911, 4913, 4922, 4935, 4937;
   - 4946, 4947.
3. For each run, record three things:
   - whether it was published;
   - how many claims were captured versus blocked, and whether each blocker
     reason is accurate;
   - a person's judgement of whether each captured pair shows the claim.
4. Adopt capture mode if about 80% of claims are captured and judged to show
   the change. Otherwise keep replay and move authors to local plan
   verification.
