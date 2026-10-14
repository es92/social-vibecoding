# Web and conductor processes

Every platform Pod used to do everything: serve people's requests and
WebSockets, and stand for the leader lock, whose holder runs the platform's
own work (the workflow loops, the timers and sweeps, the merge queue, the
Homeroom bot, the bench lane, recovery). A release replaced the Pod, and with
it the leader: the replaced Pod resigned and the new one took over
(docs/plans/draining-releases.md).

Now the two jobs can run apart (`platform.conductor.enabled` in the chart):

- **web** Pods (`PROCESS_ROLE=web`) serve requests and WebSockets and never
  stand for leader. A route still starts what it always started (a turn, a
  preview build, a checks capture, a shots run), and a web Pod a release
  replaces finishes that work as any Pod does.
- **the conductor** (`PROCESS_ROLE=conductor`, a Deployment of its own, one
  replica) stands for leader and runs the leader's work. It listens on HTTP
  too, for what is addressed to its own Pod (a shots worker calls the Pod
  that runs its run), but no Service sends it people's requests.
- **all** (no `PROCESS_ROLE`) is both, as before: docker-compose, local
  development, tests, staging previews, and the chart with the switch off.

`src/services/process-role.js` reads the role; an unknown value fails boot.

## What changes for a process that never leads

A web process ran as a follower before, for the seconds of a rollout. Now it
is one for its whole life, so what a follower could not do had to move:

- **Its own duties run on every process** (`server.js startProcessDuties`):
  the idle eviction of its own warm workers, which only the leader ran. A
  worker whose session is busy on another process is left alone: a session's
  turns land wherever the Service sends them.
- **The read-only database roles** the leader sets up at its election are
  recorded for the others (`platform_db_roles`). The prod-debug role's
  password, which only the leader's memory held, is stored encrypted with the
  data key, as app secrets are, and denied to both roles; a web process reads
  it on first use and again when Postgres refuses it (a newer leader rotated
  it). The SQL console's role has no password: a web process takes the
  leader's word that it was set up.
- **What the leader keeps in memory and an admin screen reads** is published
  for the others (`services/leader-status.js`, table `leader_status`): the
  leader rewrites each status every 10 seconds, a route reads it from memory
  where the work runs and from the table elsewhere, and a copy nobody rewrote
  for two minutes is none. The Homeroom bot's loop (its last pass, refusals,
  what runs, backoffs, the platform fault, the budget pause, the build lane),
  the bench lane, the preview reaper's automatic pass, the custom-domain
  sweep and the storage cap's last sweep.
- **The leader's loops are woken over the bus** from wherever a request
  landed: the bench lane (`bench_wake`) and the shots eval runner
  (`shots_eval_wake`), as the bot's wakes already were. A process not running
  one asks; the one running it passes; nobody passes a wake on.
- **What one process learns about a repo's issues, the others hear**
  (`issues_cache`): a close, a reopen or an invalidation leaves every
  process's open-issues copy, so a list a web process serves is as fresh as
  the merge or the heal the conductor made.
- **A DM answer the bot promised to ask again** is marked by the process
  that will ask it (`dm_defer`, a marker no drain waits for) and held while
  the try runs (`dm_answer`): the leader's resume leaves either alone, and its
  minute sweep picks up what a process that exited or died left.
- **A worker warm in one process** is a marker for the others (`warm`, which
  no drain waits for): the admin status shows another process's worker as
  in flight or warm, not as an orphan; adoption leaves it; and when two
  processes keep the same worker warm, the idle one forgets it and the last
  one evicts it. A draining process forgets its idle ones at once, so the next
  leader adopts them, and the leader adopts every five minutes the idle
  workers nobody live holds (`sweepLeftWarmWorkers`): a web process's release
  elects nobody.
- **A heal or a drift rebuild under way** is held (`app_heal`,
  `drift_rebuild`), so a request on a web process and the conductor's sweep
  no longer both start one (the copy they read is up to two seconds old, so
  two that start within that window still can; each heal's cooldown is its
  process's own).
- **An app's merge queue pass is single-flight across processes**
  (`services/merge-queue.js`): a vote lands on a web process, and the
  eligible-merge sweep and the drift poller run on the conductor. A pass
  holds the app's advisory lock (`MERGE_QUEUE_PASS_LOCK`) on a client of its
  own and is held in the registry (`merge_pass`, and `merge_resolve` for a
  proposal's conflict resolution in it), so status reads see it from any
  process. A trigger that cannot take the lock asks the holder over the bus
  (`merge_kick`) to run again once it is done; a process shutting down hands
  its re-run to anyone serving. The merge claim (promoted to merging) was
  always the guard against a second merge; this keeps two passes from syncing
  the same branch.
- **Sweeps that check a session is not mid-turn** before acting on it (the
  imported-PR head sync, the proposal measurement) check every process.
- **A conductor does not say a release is live**: only a process that serves
  requests records the merges it carries as running.

What already worked across processes (docs/plans/draining-releases.md) is
what makes the split safe: every process registers what it holds, stops reach
the process that holds the work over the WebSocket bus, and a worker's
callbacks (the model proxy, BYOK spend, a shots eval's bill) read a turn that
is not in their process from the database.

## Successors

A release replaces a process with one that can do what it did
(`processRole.successorRoles`): a conductor with a conductor or an 'all', a
web process with a web one or an 'all', an 'all' with an 'all' or a
conductor. The drain waits for one (up to `SUCCESSOR_WAIT_MS`) before it
resigns and finishes its work, and counts its fellow drainers the same way.
So the split is switched on and off by a release of its own: switched on, the
old Pods resign to the new conductor; switched off, the old conductor resigns
to the new Pods.

## Chart

`platform.conductor.enabled` (on by default) adds `<fullname>-conductor`,
the platform's own Pod run as the conductor, and runs the platform Deployment
as web; off, one Deployment does both, as before. The conductor's Pods keep
the platform's `component` label, so the network policies that admit the
platform admit them, in the chart and outside it; the Service and the
PodDisruptionBudget select `social.usernode.io/serves-requests: "true"`, which
only the serving Pods carry. The Service is in Argo CD sync wave 1: its
selector changes only after the Deployments are healthy, so the release that
first requires the label never leaves it with no labelled Pod Ready. (Applied
without Argo, all at once, that first release would.) The platform
Deployment's selector (immutable) also matches the conductor's Pods:
ownership keeps them apart, but `kubectl logs deploy/<fullname>` may pick a
conductor Pod; select by `social.usernode.io/process-role`.

The first release with the split replaces Pods of a build from before it.
Their registry counts only an 'all' as a successor, so they find none and
hand over with the minute's cutover (docs/plans/draining-releases.md), once;
every release after that drains.

## Still per process

What a web process shows of work the conductor runs, and the other way
round, is less detailed than what it shows of its own:

- the GitHub budget page counts the requests of the process that answered;
- a turn's live phase, spend and estimate show on the process that runs it
  (elsewhere it is busy, from the registry, without them), and a recovered
  turn's events reach other processes' tabs over the bus but not their
  `Last-Event-Id` replay;
- an admin's preview sweep and the automatic one keep their own job records.

## Not in this change

- Rolling the conductor only when its own code changes. Every release builds
  one image and rolls both Deployments; the release pipeline decides that,
  not the chart. With the drain, a conductor release no longer cuts the work
  it was doing, so the gain is smaller than it was.
- Routes recording work for the conductor instead of starting it in their
  own process. A web Pod finishes what it starts; nothing has to move for
  that.
