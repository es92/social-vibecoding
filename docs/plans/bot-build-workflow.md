# Plan: the Homeroom bot's builds on the workflow kernel

Status: proposal for the group. Base: `5db2cc9`. No code changes yet.

## In plain words

**What goes wrong today.** A Homeroom bot build has several steps:

1. open a session;
2. start a worker;
3. write the plan;
4. post the plan;
5. build;
6. push;
7. nudge the agent if it stopped without changing anything;
8. stop it when its time is up;
9. for a first version, review its screens and fix them;
10. propose.

Only one of these steps survives a release: the agent's own turn, which runs in its worker Pod and writes a journal. Every other step lives in the memory of the server that started the build. Releases restart the server 60 to 80 times a day. After a restart, a separate block of recovery code tries to work out what the old server was doing and finish it. That code re-implements part of the build. It does not re-implement all of it, and it drifts from the main path every time the main path changes.

Since 4 October about a dozen fixes have each closed one gap: time credit, plans kept, reviews before proposing, side builds, checks-fix time limits. Each time, the next gap showed. This week restarts still caused 25 failed bot builds.

**What changes.** A bot build becomes an instance of a workflow machine (`bot-build`) on the kernel in `src/workflow/` that governance proposals and merge follow-ups already use.

- Every step is a saved state in `wf_instances`.
- Every outside action is a durable work item in `wf_work`: a turn, a push, a GitHub comment, a DM, the proposal.
- The build clock is a durable deadline.
- After a restart, the new leader does not "recover" anything. It picks up the pending events and the work whose lease lapsed, and carries on from the exact step the build was at, using the same code as an uninterrupted build. There is one path, so there is nothing for a second path to drift from.

**What people will notice.**

- Bot builds stop failing, restarting from the top, or going quiet because of a release.
- Fewer duplicate or missing posts.
- Admins can open each build's timeline in Admin → Workflows: every step, every retry, and what each restart interrupted.
- Requesters wait about as long as before. A build that was interrupted carries on instead of being sent back to triage.

The two near-term proposals keep their value. Recovery parity (re-push, persisted stop, a nudge after recovery) and the up-to-75-second shutdown park reduce failures now. This plan retires the recovery parity work once each lane has moved over. The park stays, because people's own dev-chat turns still benefit from it.

---

## 1. Today's build as a state machine

The entry point is `buildAndPropose` (`src/services/homeroom-bot-live.js:2676`). It has four callers:

| Caller | Lane | What differs |
|---|---|---|
| `buildLive` (`homeroom-bot.js:7780`), called from `buildOne` (`:8488`) | live: a later change or a first version | `propose: true`. A first version uses the current bot configuration, its reviewer (`review`), a first look (`onFirstLook`) and Live (`onBuildTurn`). A later change can be `complicated`, in which case it builds from an approved `presetSpec`. |
| `planBeforeBuilding` (`homeroom-bot.js:7480`) | live: a complicated change's plan | `planOnly: true`. It stops after the spec turn and waits for "Build it". |
| `shadowBuild` (`homeroom-bot.js:3972`) | the shadow lane, drained by the build lane (`buildsInFlight`) | `propose: false`. It is archived after the build and leaves only a branch. |
| `bench/runner.js:586` | side builds for bot configurations (App bench) | `propose: false`, with a trial's watchers (`onProgress`, `onStage`, `onSight`). Followed across restarts by #4304. |

### Steps, and where their state lives

In the table, **M** means leader memory (lost on restart), **DB** means durable, and **W** means the worker Pod.

| # | Step | Code | Output | State today | Idempotent? |
|---|---|---|---|---|---|
| S1 | Open session and claim the run | The lane first dedupes in memory (`inFlight`, `liveBuildsInFlight`, `seen`). Then `INSERT chat_sessions`, then `onSession` (`homeroom-bot.js:7893`) runs a conditional `UPDATE … SET build_session_id … WHERE build_session_id IS NULL`. Zero rows means `lostClaim`. | session row | DB, plus in-memory sets | No. A losing claimant has already inserted a session. If `onSession` throws, the build goes on **unclaimed**. |
| S2 | Branch | `sessionLifecycle.ensureSessionBranch` | `branch_name` | DB and GitHub | Yes ("ensure") |
| S3 | Design-skill guidance | `designSkill.repoHasSkill` | prompt text | M | Yes (a read) |
| S4 | Seed message | `INSERT chat_session_messages` | a row | DB | No (a duplicate row on a re-run) |
| S5 | Worker | `worker.ensureWorkerImage` then `worker.ensureWorker` | `containerName` | W, plus the worker registry (M) | Yes |
| S6 | Spec turn | `draftSpec` (scout turn), or a `presetSpec` | `spec` (md, html, version, cost) | the turn: W and its journal. The result: M until `publishSpec` | Dispatch is not idempotent. Following the turn is. |
| S7 | Publish spec | `publishSpec`, which calls `sessions.persistScoutPublication` | `chat_session_specs` version | DB | No (a new version each time) |
| S8 | `skipCheck` | `whyNotBuild` (`homeroom-bot.js:8458`) | a reason or null | M (the callback) | Yes (a read) |
| S9 | Post spec, first look | `onSpec`, which calls `postSpecOnProposal` / `post` (issue comment plus chat card); `onFirstLook` (fire and forget) | comment, card, first-look image | GitHub and DB. The first look is never awaited. | Partly. `post()` dedups only `kind='looking'` (unique index). |
| S10 | Clear the stale stop, read the model's sight | `worker.clearPendingStop`, `buildSeesImages` | none | M (worker registry) | Yes |
| S11 | Build turn | `buildTurnRunner`, which calls `sessions.runCodexAttemptLoop`, which calls `worker.execInWorker` (detached, `active_turn` and journal). Live is started with `onBuildTurn`. | `routed.result` (`pushOk`, `ahead`, `sha`, `agentThreadId`, cost) | the turn: W, journal, and `chat_sessions.active_turn`. **The clock is a `setTimeout` (M).** `activeWorkers` (M). | Following is idempotent. Dispatch is not. |
| S12 | Time-limit stop | the timer in `buildTurnRunner`, which calls `worker.stopTurn` | `stopped = true` | **M only**: the timer, `turnStopped`, and the worker registry's `stopRequestedAt` (`worker.js:4360`) | Yes, but it is lost on restart |
| S13 | No-change nudge | `turnLanded`, `whyNotNudge`, `recordNoChange`, `onNoChange`, then a second `runBuildTurn` with `buildNudgePrompt` that resumes the thread | `noChange` | the decision and remaining time: M. The record: DB (`homeroom_bot_runs.build_no_change`). | No (a second nudge dispatch) |
| S14 | Push and push repair | `worker/run-cc.sh` commits, then `usernode-push` calls `POST /api/internal/sessions/:id/push`. A push that is lost while the platform restarts leaves `pushOk=0, ahead>0`. The dev chat heals that (`routes/sessions.js healPush`, and `server.js:~3790` on adoption, through `worker.execPushFromWorker`). **The bot does not:** `whyNotNudge` refuses to nudge, and the build fails with "produced no change to propose". The only rescue is `rescueUnpushedCommit` (`worker.js`), when the worker is evicted. | branch on GitHub | W (the local commit), the worker registry's `unpushed` (M), GitHub | Yes (pushing the same SHA) |
| S15 | Review loop (first version with a reviewer) | `reviewLanded`, which calls `bot-review.js runReviewLoop`. Each round captures, calls the reviewer, runs a fix turn, and may roll back (`rollbackReviewBranch`). | `reviewed` (final SHA, cost) | `homeroom_bot_runs.review` JSON (DB, per round). The loop's position: M. | No. Captures and reviewer calls cost money. Rollback is idempotent. |
| S16 | Prepare proposal | `prepareProposal` (name and description), `specVisibleChanges.recordForBotProposal` | session fields, visible changes | DB | Yes (overwrites) |
| S17 | Propose | `promoteAsBot`, which sends `POST /api/sessions/:id/promote` into the votes router in process: it opens the PR and starts the preview | `prNumber` | GitHub and DB | Partly. The route promotes only an `active`/`paused` session, so a second call is refused. But a crash after GitHub created the PR and before the session row moved leaves a PR the retry does not know about. `prepareProposal`'s "finished building" message insert is unguarded. |
| S18 | Announce and record | in `buildLive`: `recordLiveBuild`, the issue post (`proposalText`), the requester's DM card (`homeroom-bot-dm.js`), side builds (`botConfigs.spawnSideBuilds`), billing (`limits.recordSpend` for included keys) | rows, posts, DMs | DB, GitHub, DM threads | Mixed. `recordLiveBuild` uses COALESCE. Posts and the spend debit are not idempotent. |
| S19 | Put away | archive or pause the session, retire the worker | none | DB and W | Yes |

### How the turn itself is started, awaited and stopped

1. `runCodexAttemptLoop` (`routes/sessions.js`) calls `agentTurn.startCodexAttempt`, which writes the `agent_turns` ledger row.
2. `worker.execInWorker` then writes `chat_sessions.active_turn` (`dispatch_pending`) and starts a detached `docker exec -d` (or `nohup` on Kubernetes). The runner's output goes to `TURN_JOURNAL`.
3. `_consumeJournal` follows the journal until `__USERNODE_EXIT__`. It parses `__USERNODE_RESULT__ … ahead= sha= push_ok= agent_thread_id=`. A liveness watchdog backs it up.
4. `finishTurn` clears `active_turn`.

`worker.stopTurn` sets `stopRequestedAt` in the registry, kills the runner, and appends `__USERNODE_EXIT__ 143`. A pending stop makes later dispatches skip until `clearPendingStop`.

The worker-side stop hook (`worker/build-stop-hook.js`) sends an agent that tries to stop without having changed anything back to work, up to twice. It lives inside the turn and survives restarts already.

### Module state that a restart erases

| Location | State |
|---|---|
| `homeroom-bot.js` | `pendingLive` (`:4673`), `liveBuildsInFlight` (`:5401`), `buildsInFlight` (`:3722`), `inFlight` (`:8054`), `stoppedSessions`, `readsInFlight` |
| `worker.js` | the `_registry` entries (`stopRequestedAt`, `unpushed`, `inFlight`) |
| `active-workers.js` | `activeSessionOperations` |

Inside `buildAndPropose`, every local is lost as well: `spec`, `noChange`, `buildPart`, `reviewed`, `turnStartedMs`, the clock's `setTimeout`, and the `liveTurn` handle.

`scripts/workflow-state-trace.mjs` does not exist at this base. Section 5 proposes adding it. The list above was compiled by hand from module-level `let` and `new Map/Set` declarations.

### Gaps the recovery code still leaves

Recovery today goes through these paths:

- **Detached turn.** `server.js recoverActiveWorkers` → `adoptOrphanWorker` → `adoptBotOrphan` → `resumeDetachedTurn`. This re-arms an in-memory clock from `recoveryDeadline` and replays the journal with `worker.resumeTurnFromJournal`.
- **Bot side.** `finishRecoveredTurn` → `noteRecoveredLive` → `pendingLive`, then `completeRecoveredLive`. The latter re-implements `buildLive`'s tail: debit, resume from the plan or requeue (`MAX_RESTARTED_BUILDS`), `reviewRecoveredBuild`, `prepareProposal`, `promoteAsBot`, `announceBuilt`.
- **Backstops.** `finishInterruptedReviews` and `settleAbandonedLiveBuilds`.
- **Bench.** Bench trials have their own copy: `bench/lane.js finishRecoveredTrial`, `handBackTrial`, and its own `recoveryDeadline`.

Each of the following is a place where that second path is not the first one:

1. **A lost push is not re-pushed** (above).
2. **The time-limit stop is not persisted.** The bot's clocks call `stopTurn` without `turnLifecycle.markStopRequested`; only follow-ups stamp their deadline. A build that finished in time but is recovered after its deadline gets a clock that fires at once, and is recorded as "ran past its time limit".
3. **A recovered no-change build is not nudged.** `recoveredNoChange` records "a restart caught the turn, and recovery does not nudge".
4. **`pendingLive` is in memory.** A second restart between the turn record being cleared and `completeRecoveredLive` loses the note. The backstop sweep then calls the build lost.
5. **A restart after `active_turn` is cleared but before promote** is seen as a lost turn. The build is resumed from its plan, which rebuilds work that was already done and pushed.
6. **The shadow lane has no restart cap.** `handBackRun` refunds the attempt, so a shadow build that restarts keep catching can loop. A lost shadow build turn without a kept spec starts over from scratch.
7. **Nothing is saved at shutdown.** `cleanup` stops new work and leaves running turns for recovery.

### Side effects that need exactly-once guards

| Side effect | Guard today | Guard on the machine |
|---|---|---|
| session row and run claim | conditional link after the insert | the instance key, plus a domain write in the creating transition |
| spec version | none | a domain write in the `SpecWritten` transition |
| spec comment and card | none (only `looking` is deduped) | work `bot.post` with key `spec:v<n>`; checkpoint plus marker, as in `github-work.ts closeAndComment` |
| agent turn dispatch | `active_turn` on the session | work `agent.turn`; checkpoint `{turnId}` before dispatch completes |
| stop | memory | work `agent.stop` with key `stop:<turnKey>`; `data.stopAsked` |
| push repair | adoption path only | work `git.push`; an idempotent push of the expected SHA |
| PR / proposal | none | work `bot.propose`; checkpoint `prNumber`; on retry, first look for an open PR on the branch or `chat_sessions.pr_number` |
| issue post, DM | partly (`lastPostKind`) | work with keys `announce:proposal`, `dm:proposal`, `dm:failed` |
| spend debit (`limits.recordSpend`, `debitRecovered`) | **none**: recovery and the live path can both debit | a domain write keyed by the turn's `logicalTurnId` (a unique index on a ledger row) |
| building time (#4705, #4709) | recorded at the end | a domain write per turn result |

---

## 2. The target machine

### One machine, three lanes

The machine lives in `src/workflow/bot-build/` (`machine.ts`, `facts.ts`, `services.ts`), following `merge-followups/`.

| Lane | Instance key | Created by |
|---|---|---|
| live, plan-only, shadow | `run:<homeroom_bot_runs.id>` | `buildOne` / `buildLive` / `planBeforeBuilding` / the build lane append `BuildRequested`, with request key `build:<runId>:<attempt>` |
| side build (bench trial) | `trial:<bench trial id>` | `botConfigs.spawnSideBuilds`, as a message from the live instance, or the bench lane |

The lanes differ only in data that `BuildRequested` fixes once:

```
{ lane: 'live'|'shadow'|'side', propose, planOnly, firstVersion, starter,
  model, specModel, harness, review?: { configVersionId }, presetSpec?, budgets: { specMs, turnMs, reviewMs },
  issue: { appId, number, title }, locale, checkedFirst, proposalCeiling }
```

No callbacks are passed. The current callbacks become one of three things:

- events, such as `NotNeeded` replacing `skipCheck`;
- pushes, such as `onStage` and `onProgress` becoming `pushes.ts` entries for the bench studio and Live;
- work, such as `onFirstLook` becoming `bot.firstLook`.

### States

Each state is a phase a person would recognise (docs/workflows.md, rule 5). I/O progress belongs in checkpoints.

```
(none) ─BuildRequested→ preparing ─WorkSucceeded(prepare)→ planning
planning ─spec ok→ (planOnly ? awaiting_go : building)
         ─spec blocked→ blocked*          ─spec failed→ building (from the plan alone)
awaiting_go ─GoSaid→ building     ─PlanChanged→ planning     ─Dropped→ skipped*
building ─turn landed→ (review ? reviewing : proposing|built*)
         ─turn no-change, time left→ building (data.turn='nudge')
         ─pushOk=false, ahead>0→ pushing ─pushed→ (same as landed)
         ─ClockRanOut→ stopping ─turn ended→ failed* ("ran past its time limit")
reviewing ─round done / budget spent / interrupted→ proposing
proposing ─WorkSucceeded(propose)→ announcing ─all announced→ proposed*
          ─WorkFailed(propose)→ built_unproposed*   (session left paused, as today)
any non-terminal ─NotNeeded|Cancel→ stopping → skipped*
any work exhausted that is fatal → failed*
```

Terminal states (marked `*`): `proposed`, `built` (shadow and side), `built_unproposed`, `planned` (only if plan-only stays a separate instance; see open question 3), `blocked`, `skipped`, `failed`.

Terminal states still accept work results (kernel rule 7), so a late `bot.post` can still report.

### Persisted data (`wf_instances.data`)

```
{ ...BuildRequested fields,
  sessionId, branchName,
  spec: { version, ok, blockedWhy?, error?, costUsd, turnId },
  turn: { kind: 'spec'|'build'|'nudge'|'fix', key, turnId?, threadId?, startedAt },
  clock: { startedAt, budgetMs, creditedMs, stopAsked },
  noChange?: {...same shape as build_no_change},
  push: { sha, commits, pushOk },
  review?: { round, state, budgetEndsAt, finalSha },
  costs: { spec, build, review, turnIds[] },
  outcome?: { prNumber?, error?, skipped? } }
```

The projection (`project`) writes the legacy columns that readers use now: `homeroom_bot_runs.build_*`, `build_no_change`, `review`, `review_rounds`, `review_stop`, and `proposal_session_id`, plus `chat_sessions.status`. The bot dashboard, the activity cards, the connector, and the `dapp.json` checks therefore keep working unchanged.

### Work items (`services.ts`)

| Kind | Handler wraps | Checkpoint |
|---|---|---|
| `bot.prepare` | `ensureSessionBranch`, `designSkill.repoHasSkill`, `worker.ensureWorkerImage`/`ensureWorker` | `{branch, container}` |
| `agent.turn` | `buildTurnRunner` without its timer. Dispatches with `worker.execInWorker`, then follows the journal. | `{turnId}`, written as soon as `active_turn` exists |
| `agent.stop` | `worker.stopTurn` | none |
| `git.push` | `worker.execPushFromWorker` | `{sha}` |
| `review.capture`, `review.judge`, `git.rollback` | split out of `bot-review.js runReviewLoop` | the reviewer's verdict is cached in the checkpoint so it is never paid for twice |
| `bot.post` (spec, proposal, failure, blocked) | `post` / `postOnProposal` / `postSpecOnProposal` | `{commentId}` plus a hidden marker |
| `bot.firstLook`, `bot.live` | `first-version-live.js` | none (best effort, `maxAttempts: 1`) |
| `bot.propose` | `prepareProposal`, `recordForBotProposal`, `promoteAsBot` | `{prNumber}`. Before calling, it reads the session's existing PR. |
| `bot.dm` | `homeroom-bot-dm.js` cards | `{messageId}` |
| `worker.retire` | reused from merge-followups | none |

Spend and building time are recorded as **domain writes** in the transition that receives each turn's result. A unique index on `(session_id, logical_turn_id)` makes a replayed result debit nothing.

### Awaiting a worker turn across a restart

`agent.turn` is an ordinary work item with a long-running handler:

1. **First attempt.** The handler calls `execInWorker` with a turn id derived from the work row (`wf:<workId>`). It checkpoints `{turnId}` as soon as the worker has written `active_turn`, then follows the journal until `__USERNODE_RESULT__`.
2. **The process dies.** The lease (`leaseMs` about 60 s, with a heartbeat) lapses. The detached turn keeps running in its Pod.
3. **The next attempt** on the new leader gets `resumeFrom.turnId`. It **never dispatches**. It re-attaches to the journal with the follow code extracted from the adoption path (`turn-lifecycle.js` / `agent-turn.js`: the part of `adoptOrphanWorker` and `finalizeRecoveredTurn` that replays a journal), and returns the same result an uninterrupted attempt would.
4. If the worker is gone and the journal has no result, the handler returns `{lost: true}`. The transition decides what that means: re-dispatch from the thread if time is left, otherwise fail with an honest message.

The adoption path in `server.js` must skip sessions whose `active_turn.turnId` starts with `wf:`, so that two followers never race on one session.

We could instead split the step into a short `agent.dispatch` work item plus a `TurnEnded` event from a separate journal watcher. That keeps the turn out of a work slot, but it puts back a follower that lives in memory. The plan uses one long work item and sets `concurrency` on `agent.turn` to the bot's build cap (3 per project, global cap from settings).

### Timers: build clock, review budget, nudge

The kernel gives an instance **one** deadline. The machine always arms the earliest relevant moment and names it in the event: `ClockCheck {which: 'build'|'review'|'spec'}`.

- **Build clock.** When the build turn's result or dispatch is recorded, the transition sets `clock.startedAt` and arms `startedAt + budgetMs + creditedMs`. When `ClockCheck` fires, the facts read `wf_work_attempts` for the current turn item. A gap between a `lost` attempt and the next claim is restart time, so it goes into `creditedMs` and the deadline is re-armed. This replaces `restartAllowanceMs` / `recoveredBuildMs` (#4306) with one rule computed from durable rows. Otherwise the transition moves to `stopping` and emits `agent.stop`. **The stop is now durable** (`clock.stopAsked`). A restart during the stop re-runs `agent.stop`, and a later `ClockCheck` acts as the backstop.
- **Nudge.** `WorkSucceeded(agent.turn kind=build)` with no landed change, no fault, and time left (the `whyNotNudge` rules, moved into the machine as pure code) emits `agent.turn` with key `nudge` and the thread id. Because the transition makes this decision whichever process followed the turn, **a recovered no-change build is nudged too**. Recovery parity covers this case separately today.
- **Review budget.** `review.budgetEndsAt` is armed when review starts. A round boundary checks it, as `budgetCheck` does today.
- **Spec clock.** Today a `setTimeout` inside `draftSpec`; it becomes a deadline in the same way.

### Cancellation and skips

- `noteRequestMerged`, an admin "Stop", a closed issue, and "answered by another proposal" each append `NotNeeded {why}` (or `Cancel`).
- The transition moves to `stopping`, emits `agent.stop` if a turn is running, and ends `skipped` when the turn reports.
- At each boundary (spec done, build done, review done, before propose), the facts also run `whyNotBuild`'s queries, so a missed event still causes the build to stop where it would have stopped today.

### How the lanes share or differ

| Lane | Steps it takes |
|---|---|
| **Live, later change** | S1 to S19 without review or first look. Declares visible changes. |
| **Live, first version** | Adds `reviewing`, `bot.firstLook` and `bot.live`. Uses doubled budgets. Declares no visible changes. Messages side builds (`SideBuild` to `trial:<id>` instances) once it is created. |
| **Plan-only** | Ends `planning` in `awaiting_go`, which waits on `GoSaid`/`PlanChanged` from the DM card instead of ending the instance (open question 3). |
| **Shadow and side** | `propose: false`. They end `built` after the push (and review, for side builds with a reviewer). No posts or DMs. The side lane records its trial through `bench/lane.js recordTrial` as a work item, replacing `adoptBenchOrphan`/#4304. |

---

## 3. What recovery code goes, and what stays

Code is deleted lane by lane once that lane's flag is the default (kernel rule 9).

**Deleted:**

- `homeroom-bot.js`:
  - `isRecoveredBotSession`, `holdSlotDuringRecovery`, `abandonRecoveredTurn` and `settleReapedTurn` (bot branches), `reviewRecoveredBuild`, `noteReviewInterrupted`, `settleAbandonedLiveBuilds` and `sayBuildLost` (once no legacy builds remain), `restartedBuildsBefore`;
  - the pending-live machinery: `pendingLive`, `noteRecoveredLive`, `completeRecoveredLive`, `liveRunOfSession`;
  - `finishRecoveredTurn` (bot branch), `recoveredNoChange`, `finishInterruptedReviews` and its `INTERRUPTED_REVIEW_GRACE_MINUTES` sweep, and the first-version review rebuild that follows it (#4258);
  - the clock arithmetic: `recoveryDeadline`, `restartAllowanceMs`, `recoveredBuildMs`;
  - the requeue-and-resume path: `handBackRun`, `requeueForRestart`, `resumeLiveBuildFromSpec`, `keptRunSpec`, and the `MAX_RESTARTED_BUILDS` / `RESTARTED_BUILD_NOTE` counting;
  - `debitRecovered`;
  - the in-flight sets `liveBuildsInFlight` and `buildsInFlight` (the instance is the claim).
- `server.js`: `adoptBotOrphan`, `homeroomBotRecovery`, `adoptBenchOrphan`, `abandonOrphanBenchTurn`, the bot and bench branches of `resumeDetachedTurnInner` (the re-armed `botClock`), and the bot branches of `recoverActiveWorkers`.
- `bench/lane.js`: `finishRecoveredTrial`, `handBackTrial` and the lane's own `recoveryDeadline` / `sideTurnDeadline`, for trials that run as `trial:` instances.
- `homeroom-bot-live.js`: the callback parameters `onSession`, `onNoChange`, `skipCheck`, `onSpec` and `onBuildTurn`; `buildAndPropose` itself once the last lane moves. Its pure parts (prompts, `readSpec`, `turnLanded`, `whyNotNudge`, `turnFacts`, `prepareProposal`) move into `src/workflow/bot-build/`.
- The near-term recovery-parity additions, once their lane has moved.

**Stays:**

- the worker's detached turn, `active_turn` and the journal (the machine relies on them);
- `adoptOrphanWorker`, `finalizeRecoveredTurn`, `recoverSessions` and `resumeHeadlessRuns` for **people's** dev-chat and Mayor turns;
- the shutdown park (proposal b), for those same turns;
- the checks-fix and follow-up turns (#4533, #4591) and `finishRecoveredFollowUp`, until a later machine takes them. They run on the bot's proposal session, after this machine has ended;
- triage and the read loop (`homeroom-bot.js` passes, `readsInFlight`), which are out of scope.

---

## 4. Migration

There is one flag, `WF_BOT_BUILDS` (Helm value `platform.workflowBotBuilds`, also declared in `dapp.json` `platform_env`). Its value is a **lane list**, `shadow,side,later,first`, plus an `off` / `drain` switch.

- A build's path is chosen once, when it starts. A build started on the legacy path finishes on the legacy path, and its recovery code stays until no legacy builds are in flight.
- `drain` admits no new instances but keeps the runtime finishing the open ones, as merge-followups does with its flag off.

| Phase | Content |
|---|---|
| **0. Groundwork** (no behaviour change) | Extract the journal follower from the adoption path into a callable. Make `active-workers.js` session operations durable (already a `todo` in `workflow-processes-postgres.test.js`). Add the spend ledger's unique index and make `limits.recordSpend` idempotent per turn. Add `scripts/workflow-state-trace.mjs`, which lists module state per file, so the in-memory state is pinned. |
| **1. Shadow lane** | Machine, services, projection and the fake-worker harness. Shadow builds are real builds that propose nothing and post nothing, so this is the lowest-risk real traffic. For a week, compare outcomes against the legacy shadow builds of the week before: restarts survived, time-outs, cost. |
| **2. Side builds** | Bench trials (`trial:` instances), retiring #4304's follower. Also low risk, since nobody waits on a side build. |
| **3. Later changes (live)** | The bulk of the live volume and the subset with fewest steps (no review, no first look or Live). Turn it on first for the Homeroom project and the platform repo (`platformRepo`), then for everyone. Add `awaiting_go` for complicated changes in this phase. |
| **4. First versions** | Adds `reviewing`, first look, Live and side-build messages. These come last because they have the most steps and a person is waiting on each one. By this phase every other path has been proven. |
| **5. Delete** | After two weeks at the default in production with no legacy build in flight: delete section 3's list, shrink `tests/baselines/workflow-process-state.json`, and switch ownership to `raise` for the claimed `homeroom_bot_runs` columns. |

**Shadow-running.** The bot build is not shadow-run as a duplicate. Two builds per request would double the agent spend, and both would race on the same branch. The shadow lane is the existing lane of throwaway builds, which is why it goes first. Before each later phase, a one-week **decision comparison** runs. The legacy path appends the events it observes (`BuildRequested`, turn results, clock-outs) to a `bot-build-observer` copy of the machine whose work handlers only record. A script then reports where the machine would have acted differently, for example "would have nudged" or "would have re-pushed".

**Rollback.** Set the lane back to legacy, or set `drain`. Open instances finish on the machine. New builds take the legacy path, whose code is not deleted until phase 5. An instance that faults in a way an admin can't release can be ended with an admin `Abandon` event. Its run is then recorded as failed with "the build was stopped by an admin", and the request can be run again.

---

## 5. Testing

The suites build on `tests/lib/workflow-processes.js` and `tests/lib/workflow-child.js`.

- **A fake worker that writes a real journal.**
  - **Where it lives.** It is added to `tests/fixtures/workflow-outside-fakes.js` and replaces `worker.execInWorker`, `ensureWorker`, `stopTurn` and `execPushFromWorker`.
  - **How a turn runs.** Each turn is a scripted, **detached** Node process (`fork` with `detached: true`), so it survives the child's SIGKILL just as a Pod does. It writes the same JSONL journal and `__USERNODE_RESULT__` line as `worker/run-cc.sh`, into a temporary directory that stands for the CC volume, and sets `chat_sessions.active_turn`.
  - **What a script can say.** Each turn can end landed, no-change, failed, slow (to hit the clock), or push lost (`pushOk: 0`, `ahead: 1`). GitHub (branch, PR, comments) and the DM sender record their effects in `wf_test_effects`.
- **Kill at every step.**
  - **Pause points.** One pause point (`wf_test_pauses`) per step boundary and per work-item phase: before dispatch, after the `{turnId}` checkpoint, mid-journal, after the result and before reporting, mid-stop, mid-push, mid-capture, between the reviewer verdict and the fix, after the PR is created and before its checkpoint, after the comment and before its checkpoint, and mid-DM.
  - **Generated, not hand-picked.** A generated test loops over the list: `arm(point)`, start a build, `reached(point)`, `kill()`, `expireLeases()`, start a new child, wait for a terminal state.
  - **The check.** It compares with an uninterrupted run: the same terminal state and projection, **one** session, **one** spec version, **one** spec comment, **one** PR, **one** DM, **one** debit per turn, and work in two processes.
  - **Scale.** About 40 points per lane, times 4 lanes.
- **Clock.**
  - A turn that runs past its budget is stopped once, even when the process dies between `ClockCheck` and `agent.stop`.
  - A 90-second outage during a turn adds about 90 s to `creditedMs`.
  - A no-change turn whose result is reported by the second process is nudged.
- **Rolling deploy.** Two children run at once, the old one on `machine_version` N and the new one on N+1: no double dispatch, and the old one stands down.
- **Soak.** One build kills the child at a random point every 20 to 60 seconds, ten times. The build still ends where an uninterrupted run ends. This test is the regression test for "60 to 80 restarts a day".
- **Unit level.** Every `(state, event)` pair, using `defineMachine`'s validation and the pure transitions, with no database.
- **Lists.** `tests/workflow-process-state.test.js` gains the `bot-build` machine (see risk 4).

---

## 6. Risks and open questions

1. **Long work items.** An `agent.turn` holds a work slot for up to an hour, on the leader only. `concurrency` must be per kind and must not starve short items (posts, pushes). Should service loops run on every Pod with row-lock claims, ahead of the planned "loops in their own Deployment" step?
2. **`promoteAsBot` goes through the votes router in process.** It is the least idempotent call: it creates a PR, starts a preview, and posts. Do we first split promotion into "open PR" and "start preview" with their own idempotency, or wrap it as is with a "look before acting" guard?
3. **Plan-only as one instance or two.** Today the plan session is archived and "Build it" starts a new session from `presetSpec`. One instance (`awaiting_go`) is simpler to follow and recover, but it keeps an instance open for days. Is that acceptable?
4. **The "only shrinks" list.** A new machine may list only ownership entries. `bot-build`'s handlers necessarily use `worker.js`, `homeroom-bot-dm.js`, `bot-review.js` and the votes router. The group needs to agree on an entry allowance for this machine, or require phase 0 to move those calls behind `setup.ts` clients first.
5. **Ownership of `homeroom_bot_runs` columns.** Many writers exist today: dashboard actions, triage, `recordLiveBuild`. Which columns does the machine claim, and which stay shared?
6. **Machine versions during long builds.** A build spans several releases. Every change to `data` needs a `version` bump and a decoder that reads the old shape, or open instances of the old shape are left alone by the new code. That is a discipline every bot change must follow from then on.
7. **Policy for credited time.** Restart time is given back on the clock. Should it also be excluded from the requester's weekly building-time cap and from the billing of tokens spent after a resume?
8. **Watchers.** The bench studio and Live use in-process callbacks (`onProgress`, `onStage`, `onSight`). They become pushes and work, so a studio watching a trial across a restart sees a short gap rather than an error. Is that acceptable?
9. **Interaction with the near-term proposals.** Recovery parity (a) should be written so it is easy to delete: keep it inside the recovery functions listed in section 3, not in `buildAndPropose`.

---

## 7. Effort

These are estimates for one engineer working with an agent. Each phase is one or two proposals.

| Phase | Work | Estimate |
|---|---|---|
| 0 | journal follower extraction, durable session operations, idempotent spend, state trace | 1 week |
| 1 | machine, facts, services, projection, fake worker, kill-at-every-step suite; shadow lane on | 2–2.5 weeks |
| 2 | side builds (`trial:` instances, `recordTrial` as work), retire #4304 | 0.5 week |
| 3 | later changes live: posts, DMs, propose, `awaiting_go`, decision comparison, rollout | 1.5–2 weeks |
| 4 | first versions: review states and work, first look and Live, side-build messages | 2 weeks |
| 5 | deletion, list shrink, ownership to `raise` | 1 week |
| **Total** | | **about 8–9 weeks**, with value from phase 1 (shadow), phase 3 (most live failures) and phase 4 (first versions) |
