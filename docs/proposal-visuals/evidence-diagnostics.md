# Diagnosing proposal visual evidence

The private diagnostics response is available to the proposal author and app
managers at `GET /api/apps/:slug/proposals/:sessionId/evidence/diagnostics`.
It is readable while a run is active and after it ends. Add `?runId=:id` to
inspect a prior run after a retry. The response is `private, no-store`; the
public evidence view does not include the executable plan or these traces.
When a proposal never started evidence, the same response gives the recorded
`notStartedReason` if one exists.

Start with `runId`, `currentRun`, `state`, `baseSha`, `headSha`, `trigger`, and
the timestamps. These establish whether the request concerns the intended
proposal revision and whether a rollout or retry superseded it. `planHash`,
`authorPlanSupplied`, `trace.planSource`, and `replayPlan` establish where the
plan came from and exactly what the browser was told to do. The plan is
trusted only after the platform's typed parser and hash check.

| If the failure is in… | Read these fields |
| --- | --- |
| Scheduling or provisioning | `notStartedReason`, `trace.progress`, `trace.failure.phase`, `trace.timingsMs`, `provenance` |
| Model planning | `trace.agentDispatches` (requested and actual backend/model, fallback reason, outcome/code), `trace.agentAttempts`, `trace.tokenUsage`, `trace.control` |
| Browser setup or authentication | `trace.replayEvents` (`browser_launch_*`, `scratch_context_*`, `session_bootstrap`, `navigation_*`), `trace.failure.detail.bootstrap`, `pageState.sessionCookiePresent`, `pageState.navigationStatus` |
| UI step or assertion | `trace.replayEvents` (pass, side, story, viewport, action/assertion start and completion), `trace.failure.detail.targetStates`, `pageState.visibleLandmarkIds`, `visibleIds`, `visibleControlIds`, `visibleTestIds`, `browserDiagnostics` |
| Two-pass comparison | `trace.failure.code` and `trace.failure.detail` (story, viewport, side, field, hash distance where relevant), `trace.replayPasses`, `provenance` |
| Video encoding or storage | `animation_started`/`animation_completed` events, `trace.failure.detail`, `trace.artifactBytes`, `artifacts` (media, dimensions, bytes, SHA-256) |

The browser records the start of an action before it attempts it. The platform
persists that event immediately so an interrupted Kubernetes job can still
identify the last unfinished step. A failed job without a final verdict also
reports its partial-output reason and last protocol event. These records are
bounded: recent events, short error excerpts, safe route shapes, control
counts/names, and cookie **presence** only. The progress events omit action
values, cookies, request headers, a full DOM dump, and screenshot bytes. The
private `replayPlan` can contain typed fill values, so access must remain
restricted to the author and app managers. Full PNG/WebM media is available
only through the existing authenticated artifact
route when the replay completed and passed its integrity checks.

Browser failures retain counts and a short list of HTTP errors, failed
requests, console errors, page errors, and blocked cross-origin requests.
This matters when a harmless 404 appears before the 401 or 500 that explains
the failed UI step. Same-origin locations contain the route and query key
names, not query values. Blocked requests retain only their origin and
resource type.

After deploying a diagnostics change, rerun a previously failing complex
proposal with its existing plan, then run a fresh proposal whose plan is
created inside the platform by the selected tool-capable model. For each run,
check the actual backend/model and fallback reason, action timeline on both
revisions and both passes, replay comparison, and the stored media types. A
passed deterministic replay proves the capture machinery worked; a person
still judges whether the images or video demonstrate the claimed change.
