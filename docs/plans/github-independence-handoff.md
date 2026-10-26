# GitHub migration: handoff to the production session

Written 2026-10-26 by the cloud session that wrote the plan. It is for the
session that can reach production. **That session now drives the whole
migration, operations and code, so nothing is split across sessions.**

Read this file first, then the plan beside it
(`docs/plans/github-independence.md`). The plan is the design. This file is:

- the state of things,
- the promises already made,
- the rules for working with production access,
- the next steps, in order.

Markers: **[V]** verified in code or observed, **[I]** inferred, **[S]**
speculative.

## 1. Where everything is

- Branch: `claude/github-independence-plan` on
  `https://github.com/es92/social-vibecoding`. It holds this file and the
  plan, and no code. Fetch it with:

  ```sh
  git fetch https://github.com/es92/social-vibecoding claude/github-independence-plan
  ```

- Base commit: canonical `Usernode-Labs/social-vibecoding` main
  `b0b1ff542eb69d53be337a413d166881805597e8`. That is also the running
  production build (`serverVersion 1.0.0+b0b1ff5`). File and line
  references below are at that commit.
- **AGENTS.md exception.** AGENTS.md says to take a proposal's base from
  Homeroom. Homeroom cannot read GitHub now (`get_checkout_status` answers
  `repo_unreachable`). Take each branch's base from the canonical repo
  directly:

  ```sh
  git fetch https://github.com/Usernode-Labs/social-vibecoding main
  ```

  Branch from the 40-character `FETCH_HEAD` and record it in the PR.

## 2. Situation (short)

- **[V] What is suspended.** GitHub suspended **`usernode-bot`** (confirmed
  by Evan).
  - It is the account behind `GITHUB_BOT_TOKEN`.
  - Every write goes through that token (`src/services/github.js:649-655`),
    and `createRepo` makes repos in that account (`github.js:600`).
  - API calls answer `Sorry. Your account was suspended`.
- **[V] Its repos are hidden.** `github.com/usernode-bot/<slug>` no longer
  answers anonymously, though app repos are public by design
  (`github.js:2278-2289`).
- **[V] What is unaffected.** The Usernode-Labs org: the platform repo is
  public and people can merge PRs there. Running apps, their databases, the
  platform and its Postgres.
- **[V] What is broken.** Everything that writes to GitHub or clones from
  it:
  - creating, importing and remixing projects
  - dev sessions and worker pushes
  - proposals and merges, on every app including the platform
  - previews, checks and deploys
  - filing requests
- **[V] Request boards** are served from each process's in-memory cache,
  marked `stale: true` (`github.js:2460-2467`), until the process restarts.
- **[V] Your query's counts:**
  - 154 apps on `usernode-bot`, 6 on `Usernode-Labs`, 1 on `alfandra88`.
  - About 208 repos created since 2026-04-25; 130 of them in October,
    against 27 in September. That spike is the likely trigger **[I]**.
  - There is an `app_created` event dated 2026-10-26, so someone tried to
    start a project after the suspension. Check whether it failed (§7, B).

## 3. Decisions Evan has made

1. App code is hosted **only on Homeroom**, on **self-hosted Forgejo**, used
   as dumb git storage. Homeroom owns requests, proposals and merges.
   (Plan §4-§6.)
2. **No app repos move to Usernode-Labs or to any other GitHub account.**
   No hosted forge. No new machine account or PAT for automation.
3. Cloud coding agents work through a **personal `homeroom-workspace` repo**,
   one per person, on their own GitHub account. Work comes back as a
   **branch, not a patch**:
   1. pushed to Homeroom with a per-task token, else
   2. pushed to the workspace repo, and Homeroom fetches that exact SHA
      once, else
   3. a patch.

   (Plan §6.5.)
4. A one-way **mirror to GitHub** is optional, per project, made by the
   owner from their own account. Issues and PRs are off on the mirror.
   (Plan §6.7.)
5. People do not engage on GitHub. Homeroom is the only place to request,
   propose and vote.
6. The platform's own repo, Actions, `ghcr.io` images and the infra repo
   stay on Usernode-Labs until last (plan P7). Every phase lands as a
   **human-opened, human-merged PR on Usernode-Labs**.

## 4. What Evan has told GitHub (every change must keep these true)

Ticket status: Evan filed the appeal and data request. GitHub Support
(Nadia) answered that the activity was flagged for manual review, and asked
how the account will be used. Evan's reply (being sent) commits to:

- **Homeroom will not run automation on a shared GitHub account again.**
- `usernode-bot` is used **only to export** its existing repos over about
  **2-4 weeks**:
  - no new repos, no issues;
  - preferably through GitHub's user migration archives;
  - any API calls **capped at about 500 an hour**.

  Then its repos are archived with a pointer to their new home and the
  account is closed (or closed at once, as GitHub prefers).
- People may use GitHub individually, in their own accounts (workspace
  repos, optional mirrors).
- The team keeps developing in Usernode-Labs as ordinary users.

The consequence for the work: **the platform must never use `usernode-bot`
again, even if GitHub reinstates it.** The export runs as a separate,
throttled one-off job, never inside the platform.

## 5. Rules for this session

This session holds production access and will also write code. Keep the two
apart:

1. **Read-only production commands are fine.** That means `get`, `describe`,
   `logs`, SQL `SELECT` inside a `BEGIN … ROLLBACK`, `exec` that only reads,
   and copying data out.
2. **Every production mutation needs Evan's explicit OK first.** Say the
   exact command and wait. Mutations include:
   - env, Secret or ConfigMap changes
   - restarts, rollouts, scaling
   - Argo syncs or pauses
   - creating pods or Jobs
   - SQL writes
   - SIGUSR1
3. **Hazards. Never do these:**
   - Unset `GITHUB_APP_ID` or `GITHUB_PRIVATE_KEY`. `isEnabled()` turns false
     and `attemptMerge` reports `merged` with no code landing
     (`src/routes/votes.js:6240-6242`).
   - Unset `GITHUB_BOT_TOKEN`. The client falls back to a bare installation
     client and most calls throw (`github.js:740-742`). Swap it for an invalid
     placeholder instead (step D), and only after the rescue.
   - Change env, or merge anything to Usernode-Labs main, before rescue steps
     1-2 are done. Each release, and each env change, replaces the platform
     pods, which wipes the in-memory request lists and the `/tmp` mirrors.
   - Drain, cordon or replace app nodes. Their image caches are a fallback
     copy of the source.
   - Delete, redeploy or heal an app whose Deployment exists. A missing
     Deployment heals by cloning from GitHub, which fails and leaves the app
     down (`src/services/app-heal.js:120-169`).
   - Use the `usernode-bot` token for anything (see §4).
4. **Data hygiene.** Dumps and exports hold user data and secrets:
   - store them encrypted, in storage the team controls;
   - never commit them, never paste them into chat, never upload them to
     GitHub or a third party;
   - never print a secret's value.
5. **Code work:**
   - One branch per phase, from canonical main (§1), never on a default
     branch.
   - Run `npm run test:changed -- --base <base-sha>`. Run `npm test` only
     when shared code moved (AGENTS.md).
   - Follow AGENTS.md:
     - interface text goes in `frontend/locales/en/*.json`;
     - generated shell outputs are never committed;
     - the shell's ownership rules apply;
     - `dapp.json` check headroom.
   - Push the branch where Evan can open the PR. Merges skip the group vote,
     so each merge gets a line in #general (plan §8).
6. **Ask Evan when a choice changes what people see, or what GitHub was
   promised.** Decide engineering details yourself and say what you chose.

## 6. Ruled out already (don't reopen without new facts)

- Moving app repos into Usernode-Labs or a new GitHub account or org. It
  repeats the flagged pattern on the last GitHub asset the platform has, and
  may read as evading the suspension.
- A hosted forge (GitLab.com, Gitea Cloud): the same failure mode with a new
  counterparty.
- "Turning GitHub off" by unsetting the App credentials (hazard above).
- Mirroring every app to GitHub, or two-way issue and PR sync (route 2).
- Patches as the main way work comes back.
- Gitea instead of Forgejo. Either works; Forgejo was chosen for its
  non-profit governance. Pin the version.

## 7. Next steps, in order

### A. Finish the rescue runbook (in progress; don't restart it)

Most volatile first. Record everything in the MANIFEST (counts and sha256).

1. **In-memory request lists.** On each web pod, read
   `GET /api/apps/<slug>/github-issues` directly through the pod (port
   3000), not the Service, with an admin session and without `refresh=1`.
   Keep entries that came back `stale: true`. The conductor's copy needs the
   inspector route and Evan's OK.
2. **Mirrors.** Copy `/tmp/usernode-mirror-*.git` out of every platform pod,
   web and conductor.
3. **Workers** (`social-workers`). Make a git bundle of each live
   `/home/node/workspace`, and copy each worker's `~/.claude`.
4. **Images.** Inventory `apps.image_ref`, `chat_sessions.staging_image_ref`
   and `starter_images`. Read `REGISTRY_REPOSITORY_PREFIX`. Copy every image
   by digest, or export from node caches if the registry is hidden.
5. **Databases.** An on-demand CNPG backup (`social-refresh`), plus a
   `pg_dump` per database (`app_usernode_2d5619` and every `app_<slug>`).
6. **Forks.** `external_agent_tasks.fork_owner/fork_repo` and
   `chat_sessions.imported_pr_head_repo`: clone each with `--mirror`,
   anonymously.

**Done when** the MANIFEST has a row per app and Evan has it.

### B. Report three facts (each decides later work)

1. **The registry host** in `REGISTRY_REPOSITORY_PREFIX`, and whether every
   `apps.image_ref` can be pulled.
2. **What happened to the project created after the suspension:**

   ```sql
   SELECT id, slug, status, repo_url, created_at FROM apps
   WHERE created_at >= '2026-10-25' ORDER BY created_at;
   ```

3. **Who owns the GitHub OAuth apps** (`GITHUB_LINK_*`, `WAITLIST_GITHUB_*`)
   and the GitHub App (`GITHUB_APP_ID`).
   - GitHub identity counts toward the "social" verified tier
     (`src/services/limits.js:41-55`, `identity_verified`).
   - If the link app is owned by `usernode-bot`, new verifications fail too.

### C. P0: a pause the platform honours (first code PR)

**Goal:** the platform stops calling GitHub with the dead token, never
reports a merge that did not happen, and tells people why instead of
failing midway.

1. **One paused state, with two ways in:**
   - a platform setting `github_paused`, read through the same 10-second
     cache other `platform_settings` keys use (`src/services/limits.js`
     pattern). Flipping it needs **no env change and no pod restart**;
   - automatic detection: a 401, or a 403 whose message says the account
     was suspended, on the PAT credential marks it dead for the process.
     Record it in `src/services/github-budget.js`, beside `backgroundHold`
     (`:437`) and `isRateLimitError` (`:620`); neither recognises
     suspension today.
2. **While paused:**
   - The background GitHub clocks skip their GitHub calls
     (`src/workflow/clock/services.ts`: `imported-prs` `:616`,
     `merged-by-hand` `:628`, `proposal-revisions` `:638`, `main-drift`
     `:435`, `repo-privacy-audit` `:319`, `compliance-scan` `:327`,
     `platform-signals` `:357`, `title-heal` `:665`, `bench-sweep` `:448`,
     `fixed-check-sync` `:654`).
   - The Homeroom bot's issue refreshes skip theirs
     (`src/services/homeroom-bot.js:1843`, `:9229`).
3. **Merges.** In `attemptMerge` (`src/routes/votes.js:6232`), a session
   with a `repo_url` and a `pr_number` must never take the `noGithub` path:
   - when paused or not enabled, return a refusal the proposal machine
     already understands (`refusalKind`, `:6207`);
   - keep `{ outcome: 'merged', noGithub: true }` only for a real local stack
     with no repo or no PR.
4. **What people see:**
   - creating, importing or remixing a project is refused up front, with a
     clear message, rather than failing at `repoFailed`
     (`src/services/app-creator.js:100`, `:153`);
   - a platform-wide "Code changes are paused" banner on project pages.
     There are existing patterns to reuse: the per-app merges-paused state
     (`mainPaused`, `src/workflow/proposal/facts.ts:330`) and the
     release-stall banner
     (`frontend/src/features/dev-board/release-stall-store.ts`).
   - All text goes in catalogs.
5. **Tests:** suspension detection, the setting, clock skipping, merge
   refusal (including the guard on the `noGithub` path) and the create
   refusal.
6. **Done when:** with the setting on, the logs show no GitHub calls from
   clocks or the bot, merges are refused, not faked, and creating a project
   shows the message.
7. **Before Evan merges it:** confirm A.1 and A.2 are done, because the
   merge releases the platform.

### D. Swap the PAT for a placeholder (after A, with Evan's OK)

Set `GITHUB_BOT_TOKEN` to an invalid placeholder string, not empty. It rolls
the platform pods, so do it only after A.1-A.2. Then, even if GitHub
reinstates the account, the platform cannot resume using it.

If GitHub does reinstate it, Evan must:

1. revoke every token on `usernode-bot`;
2. uninstall the Homeroom GitHub App from that account.

Then the export runs as a one-off job with a fresh token, capped at about
500 API calls an hour (§4).

### E. Forgejo in `Usernode-Labs/infra`

Deployed by Argo CD from a reviewed PR:

- **Version:** a pinned Forgejo release.
  - Chart: `oci://code.forgejo.org/forgejo-helm/forgejo`. Verify the
    current location in the chart's README; an older `codeberg.org` path
    also circulates.
- **Storage:** the database on CNPG, with barman backups like the others;
  repos on a retained PVC (`openebs-lvm-retain`), with snapshots.
- **Access:**
  - an ingress with TLS on a Homeroom domain;
  - sign-up disabled; anonymous read of public repos; push-to-create off.
- **Accounts:**
  - an `apps` organization;
  - a service account whose token lives in a Secret the platform reads.
    People and agents never get that token.
- **Done when** an anonymous `git clone` of a test repo works from inside
  the cluster and from outside, and a push with the service token works.

### F. P1: the recovery job (code here, run in production)

A one-off Job that rebuilds every app's main and pushes it to
`apps/<slug>`.

1. **Source.** Use the image at `apps.image_ref`, or a node cache.
   - kpack images hold the source under `/workspace`, minus `node_modules`
     and `public/tailwind.css` (`src/services/template.js:1080-1093`).
   - Dockerfile images hold it under `/app`, minus `.git`, `README.md`,
     `CLAUDE.md`, `LICENSE`, `dapp.json` and `design/`
     (`template.js:1044-1056`). Restore `dapp.json` from
     `apps.manifest_snapshot`.
2. **Exact SHA first [S].** If the mirror from A.2 holds `apps.main_sha`, and
   every blob of that commit's tree can be hashed from the image's files,
   write those blobs and keep the original commit. Main keeps its SHA, and
   GitHub's archive, if it arrives, connects to it as plain history.
3. **Otherwise** make one new root commit: "Recovered from image <digest>;
   GitHub main was <sha>".
4. **Record every app's outcome:** exact, recovered or failed, plus the
   files that were missing.
5. **Order:** dry run on 2-3 apps, Evan reviews, then all 154. Do the 6
   Usernode-Labs apps and the `alfandra88` one by `git clone --mirror` from
   GitHub, which still answers.

### G. P2 and P3, in parallel

As the plan describes:

- **P2: `GitHost`** (plan §6.1, §6.3). Clones, both builders, workers, the
  push proxy and repo creation run against Forgejo; `apps.repo_url` is
  repointed.
- **P3: native requests** (plan §6.2), backfilled from the dump and, later,
  from GitHub's archive.

### H. P4-P7

As the plan describes: native merges, the workspace repo and agents, then
deleting the GitHub paths, then the platform's own supply chain.

## 8. Where GitHub lives in the code (so you don't redo the sweep)

All at `b0b1ff5`. There are 288 files under `src/` and 660 test files that
mention GitHub, and 96 `github\.com` regexes in 66 files.
`src/workflow/rules/github-url.ts:6` rejects every other host.

**The client and its credentials**

- `src/services/github.js` (3,183 lines) is the only client.
  - `getOctokit` `:649` always uses the PAT.
  - App reads are `readsViaApp` `:691` / `getReadOctokit` `:822`, with a
    fallback to the PAT.
  - `isEnabled()` `:545` only means "App credentials set".
  - `getBotUsername()` `:579` is the App's first installation; new repos'
    owner follows it.

**App source**

| Path | Where |
| --- | --- |
| New app | `app-creator.js` `setUp` `:100` → `seedStarter` `:153` → `createRepo` → `pushFiles` (`github.js:895`) |
| Remix | `app-forker.js` |
| Starter images | `starter-images.js:250-266` |
| Production deploy | `staging.js` `rebuildProductionInner` `:840`, clones at `:896-907` |
| Preview | `staging.js` `:209`, `:246-296` |
| kpack | `kubernetes.js` `:346-407` (rejects non-GitHub URLs at `:350`) |
| BuildKit | `kubernetes-buildkit.js` `:392-397`, `:694-697`, `:913-919` |
| Worker bootstrap | `worker.js` `_bootstrapWarmContainer` `:2976` (`checkRepoPublic` `github.js:2328`) and `worker/worker-run.sh:241` |
| Worker push proxy | `worker.js:5994`, `worker-git-push.js` |
| Mergeability mirror | `repo-mirror.js` `:129` (URL hard-coded at `:131`), `integration.js` |
| Unit-suite checks | `unit-suite.js:1384-1645` |

**Proposals**

| Path | Where |
| --- | --- |
| Create and update | `pr-metadata.js` `applyPrMetadata` `:800`; `createPR` `github.js:1580`; `updatePR` `:1720` |
| Merge | `votes.js` `attemptMerge` `:6232` → `github.js` `mergePR` `:1776` (squash, SHA pinned; 409 → `HeadMovedError` `:1761`) |
| Observing the merge | `workflow/proposal/services.ts:302-320` |
| Settings PRs | `routes/apps.js:2683-3675` |
| Native handoff and commit upload | `routes/proposal-handoff.js:1145`, `:1290`, `:1428-1480` → `createProposalCommit` `github.js:1304` |
| Imported PRs | `pr-import-sync.js`; webhook `routes/github-webhook.js` |

**Requests**

| Path | Where |
| --- | --- |
| Board read | `routes/issues.js:1884` → `fetchPublicIssues` `github.js:2521` (in-memory cache `:132-170`, stale fallback `:2460`) |
| Create | `issues.js:1275` → `createIssue` (`github.js:2128`) plus an `issues` twin row (`:1583`); refuses with 503 when GitHub fails |
| Other filers | `homeroom-bot-dm.js:5197`, `homeroom-bot-mayor.js:2998`, `main-watch.js:510`, `platform-signals.js:448`, `homeroom-bot-move.js:228`, `feedback-reports.js:52` |
| Numbering | The GitHub issue number is the key in about 20 tables (plan §6.2) |
| Fully native model to copy | `private_requests` / `private_request_comments` (`schema.sql:14955-14989`) |

**Agents**

| Path | Where |
| --- | --- |
| `prepare_work` | `external-agent-tasks.js:1825` (needs a GitHub link, `:1838-1856`) |
| `submit_work` | `:3571` |
| Mirror and patch rungs | `external-agent-head.js` (`resolveWriteCredential` `:134`, `mirrorForkBranch` `:275`) |
| Patch | `external-agent-patch.js`, `external-agent-patch-upload.js` |

**Seams that already exist**

- `github-mock.js` covers imported PRs only, in staging.
- GitHub-off mode: about 117 `isEnabled()` branches.
- Staging issue fixtures: `issues.js:192`, `:377`.
- `private_requests`.
- `repo-mirror.js` and `integration.js` already do merge-tree, conflict and
  ahead/behind answers locally.

**The platform's release**

- `.github/workflows/build-kubernetes-images.yml` builds on a push to main,
  then publishes the images and an OCI Helm chart to `ghcr.io`.
- Argo CD tracks the chart (`0.1.*`).
- `release-watch.js` reads the Actions runs through the dead PAT and falls
  back to elapsed time.

## 9. Open questions

1. Registry host, and whether images can be pulled (B.1).
2. Owners of the OAuth apps and the GitHub App (B.3).
3. Are the issues `usernode-bot` wrote on `Usernode-Labs/social-vibecoding`
   (the platform's own request board) hidden too? Expected, unverified.
4. Does "remove GitHub entirely" include the optional import of a public
   repo, or only the operational dependency? (Plan §9.)
5. How does a private workspace repo grant read access, once private
   projects have private code? (Plan §6.5.)
