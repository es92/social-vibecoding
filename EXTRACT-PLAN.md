# Extracting Homeroom into its own repo

Historical repository-extraction plan. The standalone server described here is
one supported deployment mode; it does not describe the Kubernetes runtime.
See [Kubernetes operations](docs/kubernetes-operations.md) for cluster releases,
logs and failure reporting.

A phased plan for pulling `projects/usernode-social-vibecoding/` out of
the `evanshapi.ro` monorepo and into a standalone repo
(`Usernode-Labs/social-vibecoding`), without disrupting the running
deploy at any point along the way.

The phasing is the whole point: each phase is independently useful and
reversible, so we don't have to commit to a fully independent deploy
before knowing whether the extraction "feels" right.

## Status

- **Phase 1 — DONE.** The repo was bootstrapped as a fresh `git init`
  rather than via `git filter-repo`; we explicitly chose to drop
  history. The Phase 1 section below describes the original
  history-preserving approach for posterity. The actual sequence
  used was: copy directory → `git init` → first commit → push to
  `Usernode-Labs/social-vibecoding` → in `evanshapi.ro`,
  `git rm -r projects/usernode-social-vibecoding` and add it back
  as a submodule pointing at the new repo.
- **Phase 2–4** are pending; descriptions below are still
  authoritative.

## Goal

- Homeroom lives in its own repo with its own issues, PRs, releases.
- Eventually, Homeroom deploys itself — no dependence on `evanshapi.ro`
  for CI, secrets, or orchestration.
- Every step along the way is a valid stopping point.

## What the code survey found

Inside `projects/usernode-social-vibecoding/`, nothing escapes the
directory. All imports are `./` or `../services/...`; no references to
sibling projects, no shared libs, no `../../` path leaks.

One real cross-reference exists:

- `src/routes/feedback.js` hardcoded
  `https://api.github.com/repos/es92/evanshapi.ro/issues` — fixed to
  point at `Usernode-Labs/social-vibecoding/issues` in the bootstrap
  commit.

Four places in `evanshapi.ro` reach into the project directory:

1. `.github/workflows/deploy.yml` — writes `.env`, syncs repo to VPS.
2. `scripts/orchestrate.sh` — globs `projects/*/project.yaml` to
   generate combined docker-compose + Caddyfile.
3. `docker-compose.dev.yml` — hardcoded build context.
4. `scripts/sync-issues.sh` — iterates projects.

All of these keep working unchanged if the directory stays at the same
path — which is exactly what a git submodule provides.

## Phase 1 — Extract with history + plug back in as submodule

**Goal:** new repo exists, deploy still runs from `evanshapi.ro`.
Low-stakes, reversible.

1. **Split out the history** (preserves every commit that touched the
   path):

   ```bash
   git clone git@github.com:es92/evanshapi.ro.git /tmp/usernode-split
   cd /tmp/usernode-split
   git filter-repo --subdirectory-filter projects/usernode-social-vibecoding
   ```

   Requires `git-filter-repo` (`pipx install git-filter-repo` or
   `brew install git-filter-repo`).

2. **Create empty `Usernode-Labs/social-vibecoding` on GitHub** — same
   visibility as `evanshapi.ro` for now; flip to public later if
   desired.

3. **Push:**

   ```bash
   git remote add origin git@github.com:Usernode-Labs/social-vibecoding.git
   git push -u origin main
   ```

4. **In `evanshapi.ro`:**

   ```bash
   git rm -r projects/usernode-social-vibecoding
   git submodule add git@github.com:Usernode-Labs/social-vibecoding.git \
     projects/usernode-social-vibecoding
   git commit -m "Extract usernode-social-vibecoding into its own repo"
   ```

5. **Fix the cross-ref** in the newly split repo:
   `src/routes/feedback.js` line 52 → point at
   `Usernode-Labs/social-vibecoding/issues`.

6. **Deploy once from `evanshapi.ro` main** to confirm `submodules:
   recursive` + orchestrator still work.

**Done-criteria:** a PR merged in the new repo, followed by a
submodule-bump commit in `evanshapi.ro`, deploys cleanly.

## Phase 2 — Make submodule-bump painless

If every change requires two commits in two repos, the friction will
push us to skip the new repo, defeating the point. Pick one, cheapest
first:

- **Cron bump (~5 minutes of setup):** a tiny GitHub Action in
  `evanshapi.ro`, hourly, that does
  `git submodule update --remote projects/usernode-social-vibecoding`
  and auto-commits if it moved. Latency up to 1 hour. Fine for most
  weeks.
- **Dispatch bump (~30 minutes):** on every push to the new repo's
  `main`, fire a `repository_dispatch` at `evanshapi.ro`, which does
  the same bump and commits. Near-immediate.
- **No automation (free):** manually
  `git submodule update --remote && git add -A && git commit` when
  we feel like deploying. Fine if deploys are infrequent.

## Phase 3 — Grow the standalone deploy in the new repo, in parallel

This is where the new repo learns to deploy itself *without disturbing
the live deploy*. Trick: have it deploy to a **separate slot** on the
same VPS until we trust it.

### 3a. Add a standalone `.github/workflows/deploy.yml` in the new repo

Mirror the relevant steps from `evanshapi.ro`'s workflow: write `.env`,
build image, deploy. Point at `/opt/usernode-standalone/` (not
`/opt/infra/repo/...`). Gate with `workflow_dispatch` only at first, so
it never runs on push until we say so.

Copy these secrets from `evanshapi.ro` to the new repo
(Settings → Secrets):

- `DEPLOY_HOST`, `DEPLOY_SSH_KEY`
- `USERNODE_ADMIN_USERNAME`, `USERNODE_ADMIN_PASSWORD`,
  `USERNODE_SESSION_SECRET`, `USERNODE_JWT_SECRET`
  (now deployed as `DATA_ENCRYPTION_KEY` — copy the value verbatim,
  never regenerate it or stored ciphertext is lost),
  `USERNODE_WORKER_JWT_SECRET`, `USERNODE_EDGE_JWT_SECRET`,
  `USERNODE_IFRAME_JWT_PRIVATE_KEY`, `USERNODE_IFRAME_JWT_PUBLIC_KEY`,
  `USERNODE_DB_PASSWORD`
- `USERNODE_GITHUB_APP_ID`, `USERNODE_GITHUB_PRIVATE_KEY`,
  `USERNODE_GITHUB_BOT_TOKEN`
- `USERNODE_ANTHROPIC_API_KEY`

### 3b. Add a standalone `docker-compose.yml` in the new repo

Self-contained: `usernode` service + `usernode-db` service + Caddy
config snippet. Port to a different host port initially so nothing
collides with the live deploy.

### 3c. Run a shadow deploy

Trigger the standalone workflow manually. Stands up at
`usernode-shadow.evanshapiro.dev` (unadvertised). Point a test user at
it, poke it, iterate.

### 3d. Decide how Caddy coexists

Two choices:

- **Own Caddy (simpler):** the standalone compose has its own Caddy
  container on a different port. Costs one more container + a few
  lines of Caddyfile.
- **Share Caddy:** the standalone compose joins the `shared-web`
  network and adds its Caddy fragment via config reload. More elegant,
  more moving parts.

Start with "own Caddy" for shadow. Reconsider at cutover.

## Phase 4 — Cutover

When the shadow deploy has been stable for a week or so:

1. Point `usernode.evanshapiro.dev` DNS/Caddy at the standalone
   container instead of the orchestrated one.
2. Migrate Postgres data: `pg_dump` from `project-usernode-db` →
   restore into standalone DB (or, if on the same volume, just repoint
   — but the dump is safer).
3. Remove the submodule from `evanshapi.ro` and strip the
   usernode-specific blocks from `.github/workflows/deploy.yml` and
   `docker-compose.dev.yml`.
4. Disable the cron/dispatch bump from Phase 2.

After this, `evanshapi.ro` has no knowledge of Homeroom. The
orchestrator still deploys recipe-bot / best-of-the-best /
gdocs-claude-bot. Homeroom deploys itself.

## Gotchas regardless of path

- `usernode-vibecoding.2026-04-15.private-key.pem` sits at the
  monorepo root and is `.gitignore`d. Don't accidentally `git add -f`
  it in the new repo. The CI secret
  (`USERNODE_GITHUB_PRIVATE_KEY`) is what deploy actually uses, so the
  file is mostly for local dev.
- Existing GitHub issues (`#18`, `#28`, `#21`, `#30`, etc.) live on
  `evanshapi.ro`. Moving them is optional (`gh issue transfer`) but
  `feedback.js` is the only in-app reference.
- After extraction, `docker-compose.dev.yml` in the monorepo will
  break unless we either a) use submodules, or b) remove the usernode
  block.

## Recommended order

Do Phase 1 as a single focused session. It's the step that *feels*
irreversible but is actually the lowest risk of the four — nothing in
production changes. Phase 2 follows naturally the first time the
two-commit flow annoys us. Phase 3+4 can wait weeks or months; they're
most valuable when we're feeling friction from `evanshapi.ro` being in
the loop.

## Cross-reference

The [SELF-HOSTING.md](./SELF-HOSTING.md) document is the operational
reference for the now-shipped self-app — Homeroom registered as an
app inside itself. That work depended on this extraction being done
through at least Phase 2 (ideally Phase 4), because "edit this app"
means "edit a GitHub repo," and the original monorepo contained
three other unrelated projects.
