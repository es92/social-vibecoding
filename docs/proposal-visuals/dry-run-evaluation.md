# Evaluating before/after shots on real proposals (local dry run)

Goal: find out whether the preview agent, given only a proposal's declared
changes, reaches each change on real builds and saves shots a person would
accept, before this replaces replay in production. The shots code has only
been exercised with scripted tool calls; this is its first run with a model.

This plan runs on a developer machine with Docker, the local Homeroom stack
and a logged-in `claude` CLI. It uses `scripts/shots-dry-run.js`, which runs
the production preview-agent prompts, shots bridge, internal routes and run
control against two builds you start, and writes a contact sheet to judge.

## 0. Ground rules

- Work on branch `claude/inspiring-sagan-xzhaw9` of `es92/social-vibecoding`.
  It is deliberately based on `883818738f0bbba0238342d6a92f5372ca4716f6`; the
  session-start "behind canonical main" notice is expected. Do not merge,
  rebase, open a PR, or submit a proposal.
- Nothing here touches production. Read proposal data through the Homeroom
  connector or API only.
- You may fix `scripts/shots-dry-run.js` and add throwaway helpers under
  `.shots-dry-run/` (ignored). Write down, rather than fix, anything that
  looks wrong in the platform's shots code, with the proposal and evidence.

## 1. Pick 4–5 proposals

Candidates are recent `usernode-2d5619` proposals whose replay run failed
with real declared changes: 4781, 4832, 4842, 4844, 4854, 4868, 4885, 4907,
4908, 4909, 4911, 4913, 4922, 4935, 4937, 4946, 4947. With `get_proposal`,
keep those whose `visualEvidence.claims` is non-empty, and choose a mix: a
plain member flow, a `read_only_admin` or `full_admin` change, a `mobile`
viewport, and anything with `animation: "motion"`. Record each one's old
`failureCode` / `failureReason` for comparison.

For each, you need `baseSha`, `branch.headSha`, and the full version-1
declaration. `get_proposal` omits `startPath`, viewport sizes, `checkpoint`
and `focus`. Get them from the owner-only diagnostics
(`GET /api/apps/usernode-2d5619/proposals/<id>/evidence/diagnostics`, via the
`usernode-api` skill): production still runs replay, so an accepted run's
`replayPlan.stories[]` carries the full intent. Where no plan exists,
reconstruct the missing fields from the claim, its steps and the PR diff,
and mark that change "reconstructed" in your results. Do not add `hints`
on the first pass; the author did not have that option.

## 2. Stand up before and after

The deleted pre-PR verifier did exactly this and is the recipe:
`git show 52e2e414:scripts/local-visual-evidence/verify-local-plan.js` (and
`prepare-env.js` beside it for the local-only `.env`). In short:

1. Start the local stack (`make up`) with the evidence-lab `.env`.
2. `git worktree add --detach` each exact SHA; `docker build` each.
3. `pg_dump` the local dev database once; restore it into two databases.
4. Apply the same per-side fixtures a hosted run applies (the full-admin
   identity, the member conversation copy, the app cap):
   see `resetPair` in `src/services/visual-evidence-environment.js` and
   `src/services/visual-evidence-fixtures.js`.
5. Run the two images on the `usernode-net` network like the old verifier,
   **but publish their ports to the host**, because the browsers run on the
   host: for example `-p 127.0.0.1:4101:3000` and `-p 127.0.0.1:4102:3000`.

Cookies are scoped by host, not port, so the two builds must not share a
host name or their sessions overwrite each other. Use
`http://127.0.0.1:4101` for before and `http://localhost:4102` for after (or
two other host names that both resolve to the builds).

## 3. Sign the personas in

Mint the three persona tokens with
`mintEvidenceAuthTokens(pool, 1)` from
`src/services/visual-evidence-identities.js` against the local database.
Then, for each persona, open one Playwright context, exchange the token for
a session on **both** origins with `bootstrapInternalSession` from
`worker/session-bootstrap.js` (the loop in
`worker/evidence-browser-bootstrap.js` shows the calls; skip its proxy), and
save `context.storageState()` as `<state-dir>/member.json`,
`read_only_admin.json` and `full_admin.json`. Check each file holds a
`session` cookie for both hosts.

## 4. Take the shots

For each proposal:

```sh
npm run shots:dry-run -- \
  --intent .shots-dry-run/<id>/intent.json \
  --before http://127.0.0.1:4101 --after http://localhost:4102 \
  --state-dir .shots-dry-run/state \
  --base-sha <baseSha> --head-sha <headSha> \
  --head-checkout <head worktree> --title "<PR title>" \
  --model claude-opus-5-5 \
  --out .shots-dry-run/<id>/run-1
```

`claude-opus-5-5` is the production default for the preview agent. Add
`--executable-path` if Playwright's Chromium is not installed, or
`--claude-args --bare` to skip your own hooks and CLAUDE.md (needs
`ANTHROPIC_API_KEY`). Restart both builds from the dump before each
proposal, so one run's writes never reach the next.

Optional second pass: add the `hints` the implementing agent would have
known (setup data, expected text, the focus element) and rerun as
`run-2`, to see what hints buy.

## 5. Judge and record

Open each `index.html`. For every declared change, record:

| Field | Values |
| --- | --- |
| proposal / change id | |
| declaration | original / reconstructed |
| result | ready / skipped (reason) |
| skip reason accurate? | yes / no / n/a |
| after shows the change? | yes / partly / no |
| before shows the same place without it? | yes / partly / no |
| clip needed / present / shows the motion? | |
| agent seconds, tool calls (from `result.json`) | |
| old replay outcome | failure code |
| notes | what went wrong, what the agent did |

Put the table in `.shots-dry-run/RESULTS.md` and finish with:

- ready rate, and the share of ready changes judged "yes" on both sides;
- the most common reasons for skips and wrong shots;
- whether any published shot is misleading (published but wrong). That is
  the one new failure this design allows, so count it separately;
- any bug found in the shots code, with reproduction.

A reasonable bar for going ahead: about 80% of declared changes ready and
judged right, and no misleading shot that a reader would not catch.
