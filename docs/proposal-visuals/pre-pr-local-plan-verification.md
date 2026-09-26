# Verify a visual evidence plan before opening a PR

For platform UI changes, the implementing Codex or Claude session can author
the exact replay plan while it still has the code, user flow, and local browser
in context. The plan is useful only after the same capture engine has actually
run it against both revisions. This command performs that local run before a
PR exists:

```sh
npm run verify:visual-evidence:local -- \
  --base <exact-40-character-base-commit> \
  --head <exact-40-character-final-local-commit> \
  --intent /absolute/path/to/visual-intent.json \
  --plan /absolute/path/to/replay-plan.json
```

The intent is the proposal's version-1 `visualEvidence` value. The plan uses
the same claims, personas, viewports, and requested media, adding typed
`replay` actions, locators, focus regions, and assertions. The command rejects
a plan that changes the intent. The plan schema and examples are in
`src/services/visual-evidence-plan.js` and
`scripts/local-visual-evidence/historical-2548-plan.json`.

## Local authoring loop

1. Commit the app change locally and record its full base and head SHAs. A
   worktree that still has uncommitted app changes is not the head image the
   verifier will build. Set up the local development environment with
   `npm run visual-evidence:local-setup` and `make up`. If the local stack runs
   from another checkout, pass its local-only `.env` with `--env-file`.
2. Use the local browser and source code to discover the actual controls and
   their accessible roles, labels, or stable selectors. Write the intent and
   executable plan for the specific user-visible claim. Choose `animation:
   none` for a static state, `steps` for meaningful user interactions, and
   `motion` only when movement is the claim.
   For an error state that requires a failed API request, declare the exact
   `GET /api/...` path in `intent.controlledFailurePath`. Put
   `Controlled test: deliberately block the declared API GET on both revisions.`
   as the first `intent.steps` entry; validation requires the reviewer label.
   Put matching `requestFailure` actions with `enabled: true` before the triggering
   interaction in both `replay.before` and `replay.after`; disable it after
   the interaction if the flow needs a recovery step. The toggle sequence
   must match on both sides. A successful capture requires the browser to
   actually make that blocked request on each side, and the reviewer flow is
   labeled as a controlled test.
3. Run the command. It checks out the two exact commits, builds both Docker
   images, snapshots the *local* database, and restores that same snapshot
   separately for base and head before each story and viewport. It mints the
   normal local capture identities and runs the production browser
   replay/encoder twice, restoring the snapshot between cases and passes. A
   failed locator, action, assertion, media check,
   or reproducibility check exits nonzero and writes a failure JSON file.
   For the platform app, both the local verifier and hosted replay also apply
   the same member conversation fixture to each disposable database after its
   exact-revision image boots, but only when that revision supplied the source
   staging conversation. This allows a member story to open a real Messages
   row and load its transcript. They also create a non-loginable full-admin
   identity only in those disposable databases and disable the server-wide app
   cap only in those evidence runtimes, so write-only admin controls and app
   creation flows can be exercised without changing production or ordinary
   staging. None of these fixtures changes the running app's database or a
   production account.
4. On success, inspect the PNGs and any WebM in
   `.local-visual-evidence/pre-pr-<run-id>/`. Confirm that the captures show
   the claim; replay success alone only proves the steps ran reproducibly and
   produced valid media. Fix the app or plan and rerun until they do.
5. Open the PR only with a plan whose manifest has `passed: true`, the exact
   final head SHA, and the plan hash of the plan you will submit. Send the
   generated `submission.json` fields (`visualEvidence` and
   `visualEvidencePlan`) together in the first `submit_work` that imports this
   PR. The import compares both SHAs with the actual PR, checks the hash and
   the claims, and stores the plan in the evidence run in the same transaction
   as the proposal. If any code commit changes that head, rerun. The platform
   independently replays the same plan on its isolated base/head environments.

The author can make a plan more explicit while testing it: replace vague
locator choices with the actual accessible role/name or stable test id; add
the necessary typed clicks, fills, waits, and before/after assertions; then
rerun and inspect the media. These are executable instructions for the
platform runner. A hosted model does not reinterpret them after import. If
there is no locally verified plan, omit `visualEvidencePlan` and the hosted
evidence agent will author one. The atomic handoff currently applies to new
PR imports; updates to an existing proposal still use the separate
`submit_visual_evidence_plan` action for their new head.

The command reads Git objects and the local development database. It does not
read production data, call a model, create a PR, or submit a proposal. Its
platform-only member conversation is copied from a staging fixture that the
exact revision seeds into each disposable database; it does not copy private
production conversations. Other required states may still be absent. In that
case, the author must create representative *local* test state or report that
the evidence cannot yet be verified. Declared `dapp.json` checks use the
read-only administrator identity, so a route that those checks can open is
not proof that a member can open it. Use the `full_admin` persona only when
the claim requires a Homeroom control that the read-only administrator is
deliberately forbidden to use.

## Scope

This runner currently targets the Homeroom platform repository and its local
Compose stack. It is the pre-PR verification path for local platform changes,
including the browser actions and PNG/WebM creation that previously happened
only after import. It does not exercise hosted model dispatch or prove that a
different production database contains the same state. Other app repositories
need an app-specific way to launch exact base/head revisions with equivalent
local fixture data and capture identities before this gate can apply to them.
