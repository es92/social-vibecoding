# GitHub independence: recovery and migration plan

Status: proposal, for discussion. Written 2026-10-25 against canonical main
`b0b1ff542eb69d53be337a413d166881805597e8`, which is also the build
production reports (`serverVersion 1.0.0+b0b1ff5`).

Markers used throughout: **[V]** verified (read in code, or observed from
outside), **[I]** inferred, **[S]** speculative or untested.

## 1. What happened

- **[V]** Homeroom's server credential gets `Sorry. Your account was
  suspended` from the GitHub API on every repository it reads, including the
  public platform repo and `Usernode-Labs/usernode-last-one-wins-dapp`
  (`get_checkout_status` → `repo_unreachable`).
- **[V]** `Usernode-Labs/social-vibecoding` and the Usernode-Labs app repo
  still answer an anonymous `git ls-remote`. The org is healthy.
- **[V]** App repos must be public: workers clone them anonymously and
  private repos are refused (`src/services/github.js:2152-2159`,
  `:2278-2289`). Yet an anonymous `git ls-remote` of
  `github.com/usernode-bot/<slug>` now asks for credentials, and the platform
  reports `defaultBranch: null, headSha: null` for them. So the
  `usernode-bot` repositories are hidden.
- **[V]** `usernode-bot` is the account behind `GITHUB_BOT_TOKEN`.
  `createRepo` uses `createForAuthenticatedUser` (`github.js:600`), so every
  app repo lives in the PAT's own account. `getOctokit` returns the PAT client
  for **every write** (`github.js:649-655`), so every request Homeroom
  filed is authored by `usernode-bot` on GitHub.
- **[I]** The GitHub App is installed on `usernode-bot`; `getBotUsername()`
  is its first installation's login. Whether the App's *owner* is also
  suspended does not matter much: its only installation is on a suspended
  account.

**Conclusion [I, high confidence]:** the machine account `usernode-bot` is
suspended. It held the PAT, owned every app repo, and authored every request.
The suspension notice email went to whatever address that account was
registered with.

A plausible trigger **[S]**: one machine account creating repos and issues in
bulk through a PAT. GitHub's terms allow one free machine account per
human, used only for automation, and reserve suspension for "excessively
frequent" API use. The 2026-10-04 exhaustion of the 5,000/hr PAT budget
(`github.js` header comment) is consistent with that.

## 2. What still works, what is broken

**Still working [V/I]**

- Every running app. Each is a Deployment pinned to an image digest with its
  own `app_<slug>` database, and nothing at runtime reads GitHub
  (`src/services/kubernetes.js:1295-1340`).
- The platform itself, its Postgres, votes, discussions, checks history and
  `private_requests`.
- The platform's own release chain, if a human merges on GitHub: Actions on
  Usernode-Labs → images and Helm chart on `ghcr.io` → Argo CD.

**Broken [V]**

- New app, import, remix and starter images (`app-creator.js:153`).
- Dev sessions: worker bootstrap clones from GitHub (`worker.js:2976`).
- Every worker push (the push proxy uses the PAT).
- Proposal creation, revisions, the CLI `proposal_start` upload,
  connector `submit_work`, and settings PRs (all writes are PAT).
- **Merges, on every app including the platform.** Platform proposals are
  merged by the PAT too.
- Previews, checks and production deploys, because each clones.
- Filing a request (503, nothing saved).
- Request boards read live from GitHub with a process-local 5-minute cache,
  so they empty on the next platform restart.
- **[V]** Nothing recognises a suspension. `github-budget.js` treats only
  rate-limit 403s as special, so every clock and the bot's issue refresh keep
  calling a suspended token at full rate.

## 3. Recover first

### 3.1 Hazards: do not do these

1. **Do not unset `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` to "turn GitHub off".**
   With the App unconfigured, `isEnabled()` is false and `attemptMerge`
   returns `{ outcome: 'merged', noGithub: true }` (`routes/votes.js:6240`).
   Proposals would then be marked merged with no code landing anywhere.
2. **Do not unset `GITHUB_BOT_TOKEN` alone.** `getOctokit` then returns the
   bare installation client, which lacks `.rest.*`, and most calls throw
   TypeErrors (`github.js:740-742`).
3. **Do not release the platform** (no hand merge to Usernode-Labs main)
   until step 3.2.3 is done. A release replaces the platform pod, and its
   `/tmp` emptyDir holds the only git-history copies Homeroom has.
4. **Do not drain or recycle nodes** in `social-apps`. Nodes cache app images
   (`imagePullPolicy: IfNotPresent`), and they are a fallback copy of the
   source if the registry is affected.
5. **Do not delete or redeploy any app** whose Deployment exists. `app-heal`
   on a missing Deployment goes to `needs_deploy`, which clones from GitHub,
   fails, and leaves the app down (`app-heal.js:120-169`).

### 3.2 Steps, most volatile first

1. **Appeal, and ask for the data** (today).
   - File the GitHub Appeal and Reinstatement form from the email registered
     on `usernode-bot`. Appeals are accepted up to six months after the
     decision.
   - In the same ticket, ask for a copy of the account's content. GitHub's
     terms say content of a terminated account is deleted within 90 days, and
     a copy can be requested within that window. Ask specifically for a
     **migration archive** (repositories *with* issues, pull requests and
     comments), not only git bundles.
   - Name a human owner for the machine account in the ticket, as the terms
     require one.
2. **Find out whether the app images are safe.** This decides how much
   source survives. Read `REGISTRY_REPOSITORY_PREFIX` in `Usernode-Labs/infra`,
   or run `SELECT slug, image_ref, main_sha FROM apps`. If the prefix is
   `ghcr.io/usernode-bot/...`, the images are probably hidden too, and the
   node caches (3.1.4) become the primary copy.
3. **Copy the volatile git copies out of the cluster**, before any release:
   - `/tmp/usernode-mirror-*.git` in each platform pod: blobless bare
     mirrors with every branch's commits and trees
     (`repo-mirror.js:54,142-161`). `kubectl cp` them to durable storage.
   - Any live worker pod's `/home/node/workspace`: a full clone of main
     plus the session branch, with `.git` (`worker/worker-run.sh:225-246`).
   - Worker `~/.claude` PVCs: agent transcripts holding partial source.
     Raise `WORKER_IDLE_EVICTION_MS` and stop volume reclaim until they are
     copied.
4. **Snapshot Postgres now** (CNPG backup plus a `pg_dump` of
   `app_usernode_2d5619`). These tables hold the only request text the
   platform has:
   - `issues` twin rows
   - `homeroom_bot_run_snapshots` / `homeroom_bot_snapshot_blobs`
   - `homeroom_bot_requesters`
   - `chat_bot_requests`
   - `feedback_reports`
   - `issue_screenshots` / `issue_videos`
   - `external_agent_tasks.brief`

   Also `chat_messages` threads and `apps.manifest_snapshot`.
5. **Extract each app's source from its newest image** (`crane export`, or
   `ctr images export` on a node), keyed by `apps.main_sha`.
   - kpack images exclude only `node_modules` and `public/tailwind.css`
     (`template.js:1080-1093`).
   - Dockerfile-built images also drop `dapp.json`, `README.md`,
     `CLAUDE.md`, `LICENSE` and `design/` (`template.js:1044-1056`). Restore
     `dapp.json` from `apps.manifest_snapshot`.
6. **Recover history from the best source available**, in order:
   1. GitHub's archive (step 1).
   2. User forks listed in `external_agent_tasks.fork_owner/fork_repo` and
      `chat_sessions.imported_pr_head_repo`.
   3. Live worker clones.
   4. The blobless mirrors.

   **[S]** Where a mirror has main's commit and tree, and the image supplies
   every blob, main can be rebuilt at its **original SHA**. Hash the image's
   files, match them against the mirror's tree, then push the commit
   shallow. Try it on one app first.
7. **Starters are reproducible.** Each app's first commit can be regenerated
   from `app-templates/` and `app_sketches`.

### 3.3 What is recoverable, honestly

| Asset | Outlook | Source |
| --- | --- | --- |
| Platform code and history | Full [V] | Usernode-Labs is healthy; also this checkout |
| Platform data | Full [V] | CNPG backups, Postgres |
| Running apps and their data | Full [V] | Running Deployments, `app_<slug>` DBs |
| Apps' current source | Likely full [I] | Registry images, or node caches if the registry is affected |
| Apps' git history | Partial [I] | GitHub archive, forks, mirrors (commits and trees only) |
| Request text and comments | Partial [I] | GitHub archive; else the Postgres fragments in 3.2.4 |
| Open proposals' code | Partial [I] | Mirrors have the refs; blobs only where merge-tree needed them |

## 4. The lesson that shapes the design

The outage did not cost Homeroom's *workflow*, which is already native:
votes, checks, discussions and mergeability (`integration.js` runs
`merge-tree` locally). It cost the three things Homeroom let GitHub be the
**system of record** for:

1. app source,
2. the merge transport (PR objects, the merge commit),
3. requests (the issue body, comments and numbering).

So the goal is not just "swap GitHub for another forge". The goal is
**Homeroom owns requests, proposals and merges, and a git server is dumb
storage behind a narrow interface.** With that split, the storage can be
replaced in an afternoon the next time.

GitHub then remains, at most, an *optional integration*: a one-time import
of a public repo, or an export/mirror to someone's own account (#3797). It
is never a dependency.

## 5. Choosing the storage backend

| Option | Gives | Costs | Fit |
| --- | --- | --- | --- |
| A. New GitHub owner (org + org-owned App) | Back in days, little code | Same single point of failure; same usage pattern may re-trigger | Bridge only |
| B. Forgejo, self-hosted in-cluster | Git over HTTPS, scoped tokens, web code browser, Actions (largely GitHub Actions syntax), OCI registry for images and Helm | One more stateful service (DB, PVC, backups, upgrades); Gitea-style API, so an adapter is needed either way | **Recommended** |
| C. Platform-native bare repos (`git http-backend` on a retained PVC) | No extra service; fewest moving parts | Auth, GC, quotas and a code browser are ours to build; the platform repo and CI still need a home | Good later, behind the same interface |

**Recommendation: B, used as storage only, behind the interface in §6.1.**
Forgejo also takes over the platform's own repo, CI and registry (§6.6),
which C cannot. Because Homeroom does its own merges (§6.4), Forgejo's PR and
issue features stay unused. Moving later to C is then a backend swap, not a
migration.

Use A only if the appeal stalls and the team needs proposals moving before
§6.3 lands. If so, put the repos in an **org**, use an **org-owned App**
(installation tokens can create org repos with Administration: write), and
use no machine-user PAT.

## 6. Target architecture

### 6.1 `GitHost` interface

One module replaces `github.js` as the source boundary, with a deliberately
small surface:

- `createRepo(slug)`
- `cloneUrl(repo, { purpose })`
- `pushCredential(repo, { refs, ttl })`
- `readRef(repo, ref)`
- `casUpdateRef(repo, ref, expectedSha, newSha)`
- `deleteRef(repo, ref)`
- `archive(repo, sha)`

Everything else (compare, merge-tree, changed files, tree equality) is done
locally on the mirror, which already exists (`repo-mirror.js`).

Repository identity becomes an opaque `apps.repo_id` plus a host, instead of
a URL parsed with `github\.com` regexes. There are 96 such regexes in 66
files, and `src/workflow/rules/github-url.ts:6` rejects any other host.
Both builders must accept the platform host (`kubernetes.js:350`,
`kubernetes-buildkit.js:694-697`).

### 6.2 Native requests

Promote the `private_requests` model (`schema.sql:14955-14989`) into a
`requests` table: title, body, state, labels and author, with comments in
`chat_messages` (already the discussion store).

- **Numbering.** Keep the existing numbers, the GitHub issue numbers that ~20
  tables key on. New requests and proposals draw from **one per-app sequence**
  starting above the current maximum, so `#N` stays unambiguous, as it is on
  GitHub.
- **Closing.** `Closes #N` becomes a Postgres link set at merge, not a keyword
  GitHub parses.
- **Backfill.** From the GitHub archive if it arrives, else from the
  fragments in §3.2.4, with `recovered_partial` marking what is incomplete.

### 6.3 Builds, workers and pushes from the platform host

- Clones use `cloneUrl` with a short-lived read token.
- The worker push proxy keeps its shape, but pushes with a ref-scoped
  credential instead of the PAT.
- kpack and BuildKit get the platform URL plus a pull secret.
- Repo creation, starter seeding, remix and starter images move to
  `createRepo` plus a local `git push`. There is no Git Data API and no
  serialized create queue, because the secondary rate limit no longer exists.

### 6.4 Proposals without pull requests

A proposal is already a `chat_sessions` row with a branch, heads, votes and
checks. Remove the PR object:

- **Merge.** `git merge-tree --write-tree`, then `commit-tree` (squash, one
  parent: main), then `casUpdateRef(main, expected, new)`. The CAS failure is
  today's `HeadMovedError` (`github.js:1761`), with the same exact-SHA
  semantics.
- **Settings changes.** Settings PRs against `dapp.json`
  (`routes/apps.js:2683-3675`), reverts (`createRevertPR`) and governance
  closes take the same path.
- **PR body.** `pr_body` is already mirrored. It becomes the source of truth
  and nothing is synced outward.
- **Imported PRs.** These become "import a branch from a public URL" (an
  anonymous fetch). The webhook and the `imported-prs` / `merged-by-hand`
  clocks go away.

### 6.5 Identity and external coding agents

- **`prepare_work`.** Stop requiring a GitHub link. Mint a per-task push
  token scoped to `refs/heads/usernode/ext-<task>/*` on the platform host.
  The patch path (`external-agent-patch-upload.js`) stays as the fallback.
  This also delivers #4856.
- **GitHub link and waitlist OAuth.** These stay as optional social
  identities only.

### 6.6 The platform's own supply chain

Today the platform depends on:

- `Usernode-Labs/social-vibecoding`
- GitHub Actions (`build-kubernetes-images.yml`)
- `ghcr.io` images and the OCI Helm chart
- `Usernode-Labs/infra`, Argo CD's source

Move the repo and infra to Forgejo, the workflows to Forgejo Actions, and the
images and chart to Forgejo's registry or a cloud registry. Argo CD supports
OCI Helm from any registry. Also update `release-watch.js`, which reads
GitHub Actions run conclusions.

## 7. Phases (each its own proposal)

The effort estimates are rough **[S]**. 288 files under `src/` and 660 test
files mention GitHub.

| Phase | What | Exit criterion | Rough size |
| --- | --- | --- | --- |
| P0 Stop the bleeding | Ops steps in §3. Code: a suspension circuit breaker. Treat `account was suspended` / 401 on the PAT as a terminal credential state: halt clocks and the bot refresh, refuse merges explicitly (never `noGithub`), show "Code changes are paused" banners | No GitHub calls with the dead token; no silent merges | 1-2 days |
| P1 Recover | Extract sources and rebuild history (§3.2.5-6); stand up Forgejo; push recovered repos | Every running app has a repo whose main matches its running image | ~1 week |
| P2 Native requests | §6.2 plus backfill | Request boards survive a restart with GitHub unreachable | 1-2 weeks |
| P3 `GitHost` | §6.1 and §6.3: URL parsing in one module, builders, workers, push proxy, repo creation | A new app can be created, edited in a dev session, previewed and deployed with no GitHub credential set | 2-3 weeks |
| P4 Native proposals | §6.4: merges, settings changes, reverts, imports | A proposal is voted in and lands on main via CAS; no PR object anywhere | 2-3 weeks |
| P5 Agents and identity | §6.5 | `prepare_work` / `submit_work` work for a user with no GitHub link | ~1 week |
| P6 Platform supply chain | §6.6 | A platform release builds, publishes and rolls out with GitHub unreachable | ~1 week |
| P7 Delete | Remove `github.js` write paths, the mock, the webhook and the budget; keep import/export as an optional adapter | `git grep -i 'api.github.com\|GITHUB_BOT_TOKEN'` is empty under `src/` | 1 week |

**Ordering rationale:** P0 and P1 are urgent and independent of the backend
choice. P2 comes before P3 and P4 because request text is the asset most at
risk of being lost for good. P6 is the least urgent because the Usernode-Labs
org is healthy, but it carries the same risk.

## 8. Governance during the outage

Homeroom cannot merge any change by vote, its own included, until P3 and P4
or the bridge (option A) land, because merges go through the suspended PAT.
P0 and P1 therefore need **admin merges made directly on GitHub**, outside
the group vote. Say so in #general, link each out-of-band merge, and put
each one to a retroactive vote once votes work again.

## 9. Open questions

1. Which account received the notice, and what reason was given?
2. Where does `REGISTRY_REPOSITORY_PREFIX` point in production (§3.2.2)?
3. Are issues on `Usernode-Labs/social-vibecoding` authored by `usernode-bot`
   now hidden as well? (Expected, unverified.)
4. Does "remove GitHub entirely" include the optional import/export of a
   public GitHub repo, or only the operational dependency?
5. Who owns the GitHub OAuth apps (`GITHUB_LINK_*`, `WAITLIST_GITHUB_*`)?
   If `usernode-bot` owns them, they are dead too.
