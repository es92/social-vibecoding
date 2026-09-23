# Submit ready changes while coding is paused

## Problem

A finished change can be paused automatically to release coding resources. The
change detail then disables **Submit for review** and says to resume the change,
even though its uploaded revision has passed its checks. Resuming consumes a
coding-session slot without doing useful coding work and obscures the real
requirements for review.

## Intended behavior

- A paused change can be submitted directly through **Submit for review** when
  the same revision would be eligible while active. Submission does not resume
  its coding worker or pass through the active-session admission path.
- Native proposals expose revision progress independently of coding-session
  status, so a paused session can still report a ready, checking, or failed
  revision. The detail and workspace use that progress consistently.
- Actual blockers remain visible: missing or unsubmitted native revisions,
  pending or failed native checks, busy operations, stale checked heads,
  permissions, and the limit on proposals open for review.
- Automatic pausing and explicit pause/resume continue to manage coding
  resources. Continuing to build remains an explicit, separate action.

## Preserved guarantees

Submission remains owner-only and excludes headless, archived, merged, or
otherwise ineligible sessions. Native submissions retain exact checked-commit
validation against both the branch and PR head. Submission records the reviewed
head, retains existing vote/evidence/merge gates, and observes the promoted
proposal cap. It must not turn a concurrent pause or archive into an unintended
promotion. Reading readiness must not mutate session state or start work.

This proposal does not change resource cleanup, account deletion, checks,
evidence requirements, voting thresholds, or deployment behavior. It does not
automatically submit a change when its worker pauses.

## Verification

Exercise paused and active submission in route and browser-state tests. Cover
pending/failed/unsubmitted revisions, wrong owners, headless and terminal
sessions, checked-head changes, busy operations, capacity limits, duplicate
submissions, and concurrent lifecycle changes. Verify a paused submission has
no resume/worker side effect. Run the affected repository suites and native
staging checks.

Capture the same representative paused ready change on the exact base and head:
the base disables **Submit for review** because it is paused; the head enables
it and reports review readiness. Verify the typed evidence plan locally with
the production replay engine before uploading the final committed revision.

## How to test / observe

Open a paused change with a checked native revision in the staging Dev area.
**Submit for review** should be enabled and the Review row should explain that
the change is ready. Submit it directly; it should become available for review
without resuming a coding worker. A paused change whose checks are still pending
or failing should instead show the actual check blocker. **Continue building**
should retain its existing explicit resume behavior.
