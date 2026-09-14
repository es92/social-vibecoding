# Self-hosting Homeroom inside itself

Runtime scope: the server, Compose, Docker-log, rollback and host-deployer
procedures here describe the standalone Docker installation and its migration
history. For the Kubernetes installation, use [Kubernetes operations](docs/kubernetes-operations.md)
and the [platform chart](deploy/helm/social-vibecoding-platform/README.md).
Kubernetes uses Argo releases and Pod APIs; no cluster node runs the host poller.

Operational reference for the shipped self-hosting setup. The
self-app is the row in `apps` whose container *is* the running
platform — `self_hosted = TRUE`, slug `usernode-2d5619`, database
`app_usernode_2d5619`, deploys via GitHub Actions rather than the
in-platform rebuild path.

This document is the canonical index for *why* each piece exists
and *how* to operate it (rollback, DB rename, flag flips). Code
comments throughout the platform cite specific phase numbers
(e.g. `SELF-HOSTING.md sub-step 2j`) — those breadcrumbs point
back here. The runbooks below are the ones the code itself can't
capture.

History: this file started as `SELF-HOSTING-PLAN.md`, the
forward-looking execution plan. Each phase below has been
shipped; the structure is preserved so the breadcrumbs in code
comments still resolve.

## Design principle

The original design framed self-hosting as "add a `self_hosted`
flag and special-case three handlers." The cleaner framing
turned out to be the inverse:

> **Make the platform conform to its own conventions for itself.
> Let the only special-casing live at the two points where the
> platform genuinely *is* its container.**

Three semantic systems unify cleanly: per-app database name,
public/private table convention, and `dapp.json` env-var manifest.
Two points genuinely cannot unify: container creation
(the parent container already exists) and PR-merge rebuild (the
parent cannot stop and restart itself the way child apps do).

```mermaid
flowchart TD
    subgraph unified [Unifies cleanly]
        DB["Per-app database<br/>'usernode' &rarr; 'app_usernode_xxxxxx'"]
        Tables["Public/private tables<br/>add staging:private COMMENTs to schema"]
        Manifest["Env vars / dapp.json<br/>declare platform secrets in root manifest"]
    end

    subgraph special [Genuine special-casing]
        Create["createApp(): if self_hosted, no-op<br/>(container already exists, it's the parent)"]
        Merge["votes.js merge: if self_hosted, skip<br/>rebuildProduction; trust auto-deploy"]
    end

    DB --> SeedRow[Seed apps row<br/>slug='usernode', container_id='usernode',<br/>status='running', self_hosted=true]
    Tables --> Enforce[Phase 0: implement TRUNCATE-private<br/>in cloneDatabase]
    Manifest --> SeedRow
    Enforce --> SeedRow
    SeedRow --> Create
    SeedRow --> Merge
```

## Status going in

- **EXTRACT-PLAN.md Phase 1 (extract repo)** — done.
- **EXTRACT-PLAN.md Phase 3 (standalone deploy)** — done.
  [docker-compose.yml](./docker-compose.yml) is self-contained,
  [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
  auto-deploys on push to `main`.
- **The hidden gap:** `staging:private` is documented at
  [src/prompts/app-conventions.md](./src/prompts/app-conventions.md)
  and recommended to child apps, but
  [src/services/db-manager.js](./src/services/db-manager.js)'s
  `cloneDatabase` is wholesale `CREATE DATABASE … TEMPLATE …`. So
  every child app's `staging:private` annotation is doing nothing
  today. Self-hosting forces this gap shut, which retroactively
  makes every existing child app's privacy claim true.

## Phase 0 — Enforce `staging:private` in `cloneDatabase`

Independent prerequisite. Useful in its own right; must land before
self-app staging is ever enabled.

**Goal:** child apps' `COMMENT ON TABLE foo IS 'staging:private'`
annotations actually keep rows out of staging clones, and column-level
`COMMENT ON COLUMN foo.bar IS 'staging:private'` annotations scrub the
named columns while leaving the surrounding row intact (the latter is
the canonical pattern for `users`, where row identity is needed in
staging for FK attribution but a few columns carry secrets).

**Steps:**

1. Add a post-clone TRUNCATE pass to
   [src/services/db-manager.js](./src/services/db-manager.js)
   `cloneDatabase`, or to the call site in
   [src/services/staging.js](./src/services/staging.js) right after
   `cloneDatabase` returns. Implementation sketch:

   ```sql
   -- Discover private tables in the freshly-cloned DB.
   SELECT n.nspname || '.' || c.relname AS qualified
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema');

   -- Then for each:
   TRUNCATE <qualified> RESTART IDENTITY CASCADE;
   ```

2. Run inside the cloned DB, not the meta-DB. `db-manager.execInDb`
   currently always targets `usernode`; need a sibling `execInTarget(dbName, sql)`
   that does `psql -d <dbName>`. ~10 lines.
3. Wrap in a try-finally so a TRUNCATE failure on one private
   table doesn't block the others (log + continue), but a total
   discovery failure is fatal (we'd rather refuse to spawn staging
   than ship a leaky one).

**Acceptance criteria:**

- A child app with `COMMENT ON TABLE foo IS 'staging:private'`,
  triggered through dev-chat to spawn a staging container, observes
  `foo` schema-only in the staging DB.
- The same app's *public* tables still come over fully populated.
- A unit/integration test in
  [test/](./) — pick a folder convention from existing tests —
  exercises clone + TRUNCATE on a fixture DB.

**Risk:** low. The change is additive (TRUNCATEs only what's
explicitly opted in via comment) and only affects staging clones.
Production deploys don't go through `cloneDatabase`.

**Rollback:** revert the commit. Pre-Phase-0 staging behavior
(wholesale copy) returns; nothing else changes.

**Cost:** ~30–50 lines of code + one test.

## Phase 1 — Write and rehearse `rollback.sh`

Independent prerequisite. Original design rule: "Write and test
this before enabling the self-app, not after."

**Goal:** a kill-switch that does not depend on the harness being
healthy.

**Steps:**

1. Add `scripts/rollback.sh` (in-repo). Contents (sketch):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd /opt/usernode
   PREV_SHA="$(git rev-parse HEAD~1)"
   echo "Rolling back to $PREV_SHA"
   git checkout "$PREV_SHA"
   docker compose up -d --build
   echo "Rollback complete. Current SHA: $(git rev-parse --short HEAD)"
   ```

2. In [.github/workflows/deploy.yml](./.github/workflows/deploy.yml),
   add a step to copy `scripts/rollback.sh` to
   `/opt/usernode-tools/rollback.sh` (separate dir, never rsync'd
   over by the deploy itself, so a broken deploy can't clobber the
   recovery script). `chmod +x` after copy.
3. SSH in and rehearse it once: roll forward to a no-op commit,
   run rollback, verify the harness comes back on the previous SHA.
   Document the SSH-in steps in [README.md](./README.md) under a
   new **Recovery** subsection.

**Acceptance criteria:**

- `/opt/usernode-tools/rollback.sh` exists on the VPS and is
  executable.
- One successful end-to-end rehearsal logged in the README or a
  commit message.

**Risk:** zero — the script is purely opt-in and runs only when
manually invoked.

**Cost:** ~20 lines of shell + one rehearsal.

## Phase 2 — Platform conforms to its own conventions

The meat. Each sub-step is small and independently safe to land;
together they make the self-app row mechanically identical to a
normal app row, with the two unavoidable guards layered in.

Land sub-steps in the order below. Each is independently testable.

### 2a. Add `self_hosted` column

[src/db/schema.sql](./src/db/schema.sql):

```sql
ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS self_hosted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_apps_self_hosted
  ON apps (self_hosted) WHERE self_hosted = TRUE;
```

The partial index is there because the seed-and-startup paths
filter on `self_hosted = TRUE` and there's only ever one such row.

**Acceptance:** schema migration is idempotent, existing rows
default to `FALSE`.

### 2b. Move platform repo URL into config

Today
[src/routes/feedback.js](./src/routes/feedback.js)
hardcodes `Usernode-Labs/social-vibecoding`. Pull it into
[src/config.js](./src/config.js) as `USERNODE_PLATFORM_REPO`
(default
`https://github.com/Usernode-Labs/social-vibecoding`). Both
`feedback.js` and the seed read from there. Document in
[.env.example](./.env.example) for completeness.

**Acceptance:** feedback button still files issues correctly;
unset `USERNODE_PLATFORM_REPO` falls back to the default.

### 2c. Add `staging:private` comments to platform schema

Purely additive. Append to [src/db/schema.sql](./src/db/schema.sql).

**Table-level (8 tables — full TRUNCATE in staging):**

```sql
COMMENT ON TABLE sessions               IS 'staging:private';
COMMENT ON TABLE activation_codes       IS 'staging:private';
COMMENT ON TABLE chat_sessions          IS 'staging:private';
COMMENT ON TABLE chat_session_messages  IS 'staging:private';
COMMENT ON TABLE chat_session_specs     IS 'staging:private';
COMMENT ON TABLE llm_usage              IS 'staging:private';
COMMENT ON TABLE notifications          IS 'staging:private';
COMMENT ON TABLE app_secrets            IS 'staging:private';
```

**Column-level on `users` (5 columns scrubbed, row identity preserved):**

```sql
COMMENT ON COLUMN users.password               IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_enc      IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_last4    IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_token      IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_expires_at IS 'staging:private';
```

`users` rows survive cloning so FK attribution
(`chat_messages.user_id`, `apps.created_by`, `notifications.source_user_id`,
…) keeps working in self-app staging — without this, every dev-chat
message in a staging clone would render as "(deleted user)".
`usernode_pubkey` is intentionally NOT scrubbed: it's an on-chain public
identity, and a self-app dev wants to see it to test wallet-linking
flows. `password` is scrubbed to a sentinel
(`__staging_redacted__`); see Phase 5 below for the iframe-auth scheme
that lets self-app staging containers log admins in without ever
needing a usable `users.password` value.

**Public by omission (no comment):** `apps`, `app_activity`, `issues`,
`users` (the table itself — only specific columns are scrubbed),
`chat_messages`, `issue_votes`, `pr_votes`. These carry no per-row
secrets and the aggregates are already visible in the prod UI to the
audience that would clone the platform.

**Acceptance:** `obj_description((schemaname || '.' || tablename)::regclass, 'pg_class')` returns
`'staging:private'` for the 8 listed tables; `col_description` returns
`'staging:private'` for the 5 listed columns of `users`. With Phase 0
in place, a hypothetical staging clone of the platform DB would have
schema-only copies of those tables and scrubbed columns of `users`.

### 2d. Rename platform DB to follow `app_<slug>` convention

Slug: **`usernode-2d5619`** → DB name: **`app_usernode_2d5619`**.
The `usernode-` prefix matches the container name and the user-facing
brand; the `2d5619` hex suffix (generated once via
`crypto.randomBytes(3).toString('hex')`, frozen at this commit) avoids
a collision with a hypothetical child app whose user-chosen slug
happens to be `usernode`.

Pinned as `SELF_APP_SLUG` and `SELF_APP_DB_NAME` constants in
[src/config.js](./src/config.js). Never read from env, never
overridable — the hex is now part of the platform's identity.

**One-time migration is automated by the deploy workflow.**

[.github/workflows/deploy.yml](./.github/workflows/deploy.yml)
contains an idempotent migration block that runs on every deploy:

1. Skip if `app_usernode_2d5619` already exists and is healthy
   (sanity-checks `users` is non-empty).
2. Otherwise: stop the harness, `pg_dump usernode`, `createdb`
   the new DB, restore the dump with `ON_ERROR_STOP=1`, verify
   row counts match for `users` / `apps` / `chat_messages`, and
   then proceed to `docker compose up -d --build`. Any failure
   drops the partial target DB so the next attempt starts clean.

Code-side, only one place flips:

- [docker-compose.yml](./docker-compose.yml) — change
  `DATABASE_URL: postgres://usernode:${USERNODE_DB_PASSWORD}@usernode-db:5432/usernode`
  to `…/app_usernode_2d5619`.

`deploy.yml` doesn't write `DATABASE_URL` into the runtime `.env`;
the inline `environment:` block in `docker-compose.yml` is the
source of truth, with `${USERNODE_DB_PASSWORD}` substituted from
`.env`. The workflow change is the migration block, which becomes
a 1-line "already exists" no-op once the migration has run.

The bare `usernode` database **stays around** as the
postgres-bookkeeping target that
[src/services/db-manager.js](./src/services/db-manager.js)
`psql -d usernode` issues `CREATE DATABASE` from. Its purpose
is now genuinely just "the meta DB," not "the platform's data."

**Order of operations** (do once, off-hours):

1. Land the docker-compose + deploy.yml changes in `main`.
2. The deploy run executes the migration block. ~2–5 min of
   platform downtime during the dump/restore; child apps and the
   sidecar are unaffected.
3. Watch the deploy logs for `==> Migration complete; counts match`.
4. Verify `/health` and the app UI come up.
5. Leave the original `usernode` DB in place permanently — it's
   the meta-DB target `db-manager.js` connects to. (And during the
   first ~1 week it doubles as a rollback target — flip the
   `DATABASE_URL` back to `…/usernode` and redeploy.)

See [README.md](./README.md) §"Migrating the platform DB to its
app_-prefixed name (Phase 2d)" for the manual fallback runbook,
in case the auto-migration ever needs to be done by hand.

**Acceptance:** platform comes back, `\l` shows both `usernode`
and `app_usernode_2d5619` databases, and all app-creator /
votes / dev-chat flows still work.

**Risk:** moderate. This is the most invasive single step. A
botched dump/restore loses recent data. Mitigations: the auto-
migration aborts on any failure (drops the partial target DB so
the next attempt starts clean); the harness only restarts after
the row-count check passes; the original `usernode` DB stays
around as a rollback target; rehearse once against a local-dev
clone first by setting up `usernode` with sample data and
re-running the workflow's migration block by hand.

**Rollback:** flip `DATABASE_URL` back to `usernode`,
`docker compose up -d`. Any writes that landed in
`app_usernode_2d5619` after the cutover are not in the old DB
and would need re-replay — usually you'd just take the loss for
the cutover-to-rollback window.

### 2e. Add `dapp.json` at the repo root

Per [src/services/app-manifest.js](./src/services/app-manifest.js):

```json
{
  "secrets": [
    {
      "key": "GITHUB_APP_ID",
      "required": true,
      "description": "GitHub App ID for the bot account that owns app repos"
    },
    {
      "key": "GITHUB_PRIVATE_KEY",
      "required": true,
      "private": true,
      "description": "PEM private key for the GitHub App"
    },
    {
      "key": "GITHUB_BOT_TOKEN",
      "required": true,
      "private": true,
      "description": "Classic PAT for repo creation, branch pushes, PR creation"
    },
    {
      "key": "ANTHROPIC_API_KEY",
      "required": false,
      "private": true,
      "description": "Platform-wide fallback Claude key; users can BYOK"
    },
    {
      "key": "ADMIN_USERNAME",
      "required": true,
      "description": "Bootstrap admin username"
    },
    {
      "key": "ADMIN_PASSWORD",
      "required": true,
      "private": true,
      "description": "Bootstrap admin password"
    }
  ]
}
```

Note: `JWT_SECRET`, `DATABASE_URL`, `PORT`, `USERNODE_ENV` are
on the manifest's reserved list (see
[src/services/app-manifest.js#L41-L47](./src/services/app-manifest.js))
and don't go in here. `JWT_SECRET` is genuinely the platform's
own and not a manifest secret either way; it's set via the
deploy workflow. The same is true of the four keys that phase-1
key separation split out of it — `DATA_ENCRYPTION_KEY`,
`IFRAME_JWT_PRIVATE_KEY`, `IFRAME_JWT_PUBLIC_KEY`,
`WORKER_JWT_SECRET`, `EDGE_JWT_SECRET`. Those are declared in
the `platform_env` block under the "Platform keys" group so the
panel can document them, and they land in
`PLATFORM_ENV_UNWRITABLE` so they render read-only.

**Acceptance:** the file parses through `appManifest.read()`,
all listed keys appear in the Settings → Secrets UI for the
self-app row once it exists.

### 2f. Boot-time seed for the self-app row

Add a function `seedSelfApp(pool, config)` invoked from
[server.js](./server.js) after `migrate()` (or wherever the
boot sequence lives). Idempotent:

```js
async function seedSelfApp(pool, config) {
  const { rows } = await pool.query(
    'SELECT id FROM apps WHERE self_hosted = TRUE LIMIT 1'
  );
  if (rows.length) return;
  await pool.query(`
    INSERT INTO apps
      (name, slug, repo_url, container_id, status, self_hosted,
       main_sha, last_deploy_at)
    VALUES
      ('Homeroom', $1, $2, 'usernode', 'running', TRUE, $3, NOW())
  `, [
    config.selfAppSlug,         // 'usernode-2d5619'
    config.platformRepoUrl,     // USERNODE_PLATFORM_REPO
    process.env.GIT_SHA || null,
  ]);
}
```

`GIT_SHA` is already plumbed through the build via
[docker-compose.yml#L52-L53](./docker-compose.yml) (`args:
GIT_SHA: ${GIT_SHA:-dev}`). The boot seed reads it directly so
the self-app row's "live on" pill is correct from first boot.

The seed should also write into the manifest snapshot column
([src/db/schema.sql#L71](./src/db/schema.sql)
`manifest_snapshot`) by reading the local `dapp.json` from
`__dirname/..` — saves a clone-and-snapshot roundtrip the
self-app would never need.

**Acceptance:** fresh DB, server boots, `apps` table has
exactly one row with `self_hosted = TRUE`,
`container_id = 'usernode'`, `status = 'running'`, and a
non-null `main_sha` matching the build's `GIT_SHA`.

### 2g. Container-ownership guards (the only genuine special cases)

Two `if (app.self_hosted)` guards. Total ~10 lines.

**Guard A** — top of
[src/services/app-creator.js](./src/services/app-creator.js)
`createApp`:

```js
async function createApp(config, appRow) {
  if (appRow.self_hosted) {
    log.info('app-creator', 'Skipping create for self-hosted app',
             { appId: appRow.id, slug: appRow.slug });
    return;
  }
  // …existing body
}
```

**Guard B** — in
[src/routes/votes.js#L290-L327](./src/routes/votes.js)' merge
handler, wrap the `rebuildProduction` block:

```js
if (!app.self_hosted) {
  const { containerId, sha } = await staging.rebuildProduction(
    config, app
  );
  // …existing UPDATE apps SET container_id, main_sha, …
} else {
  log.info('votes', 'Self-app PR merged; auto-deploy will roll',
           { appId: app.id, prNumber: session.pr_number });
  // app.main_sha is updated post-deploy by the seed re-running
  // on next boot. Or, if you want it sooner: leave the existing
  // app_version_changed broadcast firing; clients call
  // /api/version which re-derives from GIT_SHA on next boot.
}
```

The `app_version_changed` broadcast at
[votes.js#L320-L325](./src/routes/votes.js) keeps firing in
both branches; that's the hook the banner in Phase 3 reads.

**Acceptance:**

- Calling `createApp(config, selfAppRow)` is a no-op log line.
- A merged PR against the self-app does not call
  `staging.rebuildProduction`.
- A merged PR against any normal app behaves identically to
  before.

### 2h. Self-app secrets UI: the platform's own env store

Originally shipped as "read-only": saving a value for the self-app
row would have persisted into `app_secrets`, which the platform's
own process never reads (its env comes from `.env`, written by
GitHub Actions), so a "Save" click was a silent no-op and the
routes returned 403.

**Superseded.** The panel is now the platform's real configuration
surface. The three secrets routes in
[src/routes/apps.js](./src/routes/apps.js) branch on
`app.self_hosted` onto [services/platform-env.js](./src/services/platform-env.js),
which writes `platform_env_values` — the store the deploy actually
resolves into `/opt/usernode/.env` (see
[scripts/dump-platform-env.js](./scripts/dump-platform-env.js) and
the "Resolve platform env" step in the workflow). So a write here
is effective; it lands on the platform's **next deploy**, which the
panel says in as many words. The panel is titled "Platform
variables" for this row, and the admin console's separate
Platform-variables section was folded into it.

What is still refused, and where:

- **Credentials and deploy-owned keys** (`DATA_ENCRYPTION_KEY`, the
  `IFRAME_JWT_*` pair, `WORKER_JWT_SECRET`, `EDGE_JWT_SECRET`,
  `JWT_SECRET`, `DATABASE_URL`, `ADMIN_PASSWORD`, the GitHub App
  credentials, `USERNODE_DOMAIN`, …) are in
  `app-manifest.PLATFORM_ENV_UNWRITABLE` and refused by the DAO, by
  the route, and by the vote path. They render as read-only
  "Deploy-managed" rows with no controls at all. A web form that could
  rewrite one of the platform's signing keys is a privilege-escalation
  path, not a feature — and for `DATA_ENCRYPTION_KEY` it is also
  structurally impossible: `platform_env_values.value_enc` is encrypted
  with that key, so the store cannot hold it.
- **`/redeploy` and `/check-updates`** still 403 via
  `refuseIfSelfHosted` — the platform's deploy is GHA-driven (2g).
- **Plaintext to non-admins.** Any collaborator may see which
  variables exist and whether they are set; only an admin gets a
  non-private variable's value, and nobody ever gets a private one.

**Acceptance:** GET returns the merged declaration+value view with
`scope: 'platform'` and `redeployable: false`; PUT/DELETE of a
declared tunable succeed for a full admin and 400 for an unwritable
key; a non-admin's GET carries no `value` and no `valueLast4`.

**Declaring a NEW tunable from the panel.** The panel's "+ New
variable" form opens one proposal that carries both halves of the
change: a `secret-declare/*` PR appending the entry to `platform_env`
in [dapp.json](./dapp.json) (via the shared manifest-PR core in
[services/rename-pr.js](./src/services/rename-pr.js)), plus the value.
A full admin's value is written to `platform_env_values` on submit —
which they may already do for any declared key — while everybody
else's waits encrypted in `pending_secret_declarations` and is written
by [routes/votes.js](./src/routes/votes.js) `finalizeMerge()` the
moment the PR merges. The pre-merge platform-env check counts a value
carried by the same session, so such a proposal never blocks itself;
the declaration itself reaches `platform_env_declarations` on the
post-deploy boot's `reconcilePlatformEnv`, like any other manifest
change. Deploy-owned credentials stay out of this: `isWritableKey()`
refuses them at creation, so the form can never declare `JWT_SECRET`
as a writable tunable.

**Reading the repo's GitHub Actions secrets (operator step).** For
admins, the panel also lists the platform repo's Actions secrets
read-only — name, "Set", and last-updated. GitHub's API returns
`{ name, created_at, updated_at }` and never a value, so there is
nothing to reveal and no write path; changing one means the repo's
Settings → Secrets and variables → Actions.

Reading that list is an **admin-level capability on the repo**, and the
platform tries both of its clients
([services/github.js](./src/services/github.js) `listActionsSecrets`):

- the classic PAT (`GITHUB_BOT_TOKEN`) — works when the bot user has
  **admin** access to the platform repo;
- the GitHub App installation — works when the App has the repository
  **Secrets: read** permission, which the App owner must add and the
  installation must approve.

Neither is guaranteed, so the call **fails open**: a 401/403/404 (or
any transport failure or a 4s timeout) degrades to one explanatory
line under the group heading — *"The platform's GitHub token can't read
this repo's Actions secrets…"* — and the rest of the panel renders
unchanged. Grant one of the two above to turn the list on; nothing else
in the platform depends on it. Results are cached for 5 minutes
(failures for 1), and in staging the group is filled with obviously-fake
demo rows because a self-app staging container has no GitHub
credentials at all.

### 2i. Mayor refuse-list paragraph (self-app-only)

[src/services/prompts.js](./src/services/prompts.js) is where
Mayor's system prompt is assembled. When the chat session's app
has `self_hosted = TRUE`, append a paragraph (after the existing
`getAppConventions()` block):

> **You are editing the Homeroom platform itself.** Refuse to
> propose edits to any of the following without an explicit
> `allow_risky: true` confirmation from the user in the same
> message: `server.js` bootstrap path; `src/middleware/auth.js`;
> any code that reads or writes `JWT_SECRET`,
> `DATA_ENCRYPTION_KEY`, the `IFRAME_JWT_*` pair,
> `WORKER_JWT_SECRET`, `EDGE_JWT_SECRET`, or anything in
> `src/services/secrets.js` / `src/services/platform-jwt.js`;
> `src/db/migrate.js` for anything
> beyond append-only DDL; files configuring
> `/var/run/docker.sock` mounting; `docker-compose.yml`;
> `.github/workflows/deploy.yml`. If the user asks you to touch
> these, surface the risk first and require explicit
> confirmation; do not silently include such edits in a broader
> change.

The list combines the doc's globs plus two added by the
assessment: `docker-compose.yml` (sidecar-volume hazard) and
`.github/workflows/deploy.yml` (`DATA_ENCRYPTION_KEY` rotation
hazard — see below).

Where the rotation hazard actually lives, after phase-1 key
separation: **`DATA_ENCRYPTION_KEY`**, not the signing keys.
`services/secrets.js` derives its AES-256-GCM key from it, so
rotating it makes every stored BYOK Anthropic key, app secret and
platform-variable value undecryptable — and `decrypt()` swallows
its own errors and returns `null`, so the platform boots green and
the values simply stop resolving. There is no crash to notice and
no automatic recovery. In the deploy workflow it is sourced from
`secrets.USERNODE_JWT_SECRET` precisely so that no second GitHub
secret exists that someone could regenerate by accident; a genuine
rotation needs a re-encryption migration behind a new `v2:`
envelope. The three new signing keys are the opposite: rotating
`WORKER_JWT_SECRET` evicts warm workers (they re-bootstrap),
rotating `EDGE_JWT_SECRET` makes people re-authorize, and rotating
the `IFRAME_JWT_*` pair re-auths app identities once phase 2 puts
it in the path — all recoverable.

**Acceptance:** dev-chat against the self-app, with Mayor asked
to "edit `DATA_ENCRYPTION_KEY` to a new value," produces a refusal
+ explanation; with `allow_risky: true`, produces the proposed
change. Other apps' Mayor planning is unchanged.

### 2j. Admin-only filter on `/api/apps`

Filter the listing in
[src/routes/apps.js](./src/routes/apps.js) so non-admins don't
see the self-app row:

```js
const { rows } = await pool.query(`
  SELECT * FROM apps
   WHERE NOT self_hosted OR $1::boolean
   ORDER BY …
`, [!!req.user?.isAdmin]);
```

Same filter applies to the `GET /api/apps/:slug` handler:
return 404 for non-admins requesting the self-app slug.

**Acceptance:** non-admin users see no `self_hosted` rows in
the home screen or via direct slug access; admins see them.

### 2k. Block self-repo URL in the import flow

[src/routes/apps.js#L206-L228](./src/routes/apps.js) — in the
`POST /api/apps` pre-flight, after parsing the URL, refuse if it
points at `USERNODE_PLATFORM_REPO`:

```js
if (repoUrlNormalized &&
    repoUrlNormalized.toLowerCase() ===
    config.platformRepoUrl.toLowerCase()) {
  return res.status(409).json({
    error: 'This is the platform repo. The self-app already exists; ' +
           'importing it as a child would create a sibling instance.'
  });
}
```

Same guard on the `verify-access` route at
[apps.js#L191-L204](./src/routes/apps.js), so the modal's
"Check" button surfaces the error before submit.

**Acceptance:** pasting `Usernode-Labs/social-vibecoding` (any
case) into the import modal produces the explanatory error in
both the Check and Submit paths.

## Phase 3 — Platform-updating banner (retired)

**Retired in #1015.** Shipped as a full-width amber
`"Platform updating… sit tight, write actions are paused."` bar that
every signed-in tab latched on the pre-merge
`vote_update { merging: true, selfHosted: true }` broadcast. Behind it
sat `App.PlatformUpdating` in [public/js/app.js](./public/js/app.js): a
`sessionStorage`-persisted latch, a 2s `/api/version` poll, a
`window.fetch` wrapper that rejected every non-`GET`/`HEAD` request
(the actual write block), a 5-minute red "stuck — reload manually"
variant, and a hard `location.reload()` once `/api/version` reported a
different SHA.

**Why it is gone.** All of that existed for one reason: a self-app merge
restarted the *single* `usernode` container, so the server really did
disappear mid-deploy. Blue-green deploys (#1008,
[scripts/platform-rollout.sh](./scripts/platform-rollout.sh)) removed
that premise — a deploy builds the idle color, health-gates it on two
consecutive `/health` passes, flips
`caddy/active/platform-upstream.caddy` with a graceful `caddy reload`,
and only then drains the old color. The live color serves the entire
build window, so the banner paused writes on a platform that was 100%
available for the length of a Docker build — routinely past its own
5-minute "stuck" threshold, telling everyone a healthy deploy had
failed. And because `/api/version` only reports the new SHA *after*
traffic has already cut over, the forced reload no longer recovered
anything; it just interrupted whatever the person was doing.

**What replaced it.** Nothing platform-wide, by design: with
zero-downtime deploys there is nothing for the user to wait for or do. A
tab still running an older build is caught up by the two passive nudges
that survive:

- the drawer's **Platform version** row
  (`App.renderPlatformVersionPill`), which becomes a tappable
  `"<sha> · reload"` when the served SHA differs from the one the
  document booted with — and still shows the `deployProgress` spinner
  while a deploy is in flight;
- **pull-to-refresh** (`App._refreshOrReload` → `App.platformMovedOn`),
  which upgrades a data refresh to a full reload on a moved-on platform.
  This is the anonymous shell's only path to new client code.

Per-proposal state is unaffected: the `Merging…` /
`Resolving conflicts…` / `⚠ Conflict resolution failed` badges in
[merge-status.js](./public/js/merge-status.js), the dev-chat sync
banner and the group-chat play-by-play all still report what is
happening to a specific proposal.

**Kept from this phase:** `selfHosted` on the `vote_update` broadcasts,
`status` on `GET /api/sessions/:id/status`, and `selfAppSlug` on
`/api/version` — no client reads them now, but each is a cheap, honest
fact and they stay for admin/debug tooling. The negative contract (no
banner element, no write-blocking `fetch` wrapper, and the surviving
stale-version nudge) is pinned by
[tests/platform-update-nudge.test.js](./tests/platform-update-nudge.test.js).

## Phase 4 — In-app vote-to-merge for the self-app (code shipped, gated off)

Today, admin manually merges the self-app PR on GitHub. The
"who can vote on the platform's own PRs" question is gated by a
single config flag:

`SELF_APP_PUBLIC_VOTING` (env) → `config.selfAppPublicVoting`
in [src/config.js](./src/config.js). **Default: `false`**.

When `false` (today): the Phase 2j visibility filter applies —
non-admins don't see the self-app row in `/api/apps`, get 404 on
`/api/apps/<self-slug>` and `/api/apps/<self-slug>/secrets`.

When `true`: the visibility filter is relaxed at all three
sites. Non-admins can:
- see the self-app row in the home grid
- load its app view, group chat, dev chat
- list its promoted PRs and cast votes via the existing PR
  voting UI (which has no admin gate, so once visibility is
  granted, voting works)
- view the Platform-variables metadata (key + description +
  group + `required` + `hasValue`; a non-admin never receives a
  value or a last-4)
- **propose** a platform-variable change by vote
  (`kind='secret_change'`, same flow as any app's secrets) —
  deploy-owned credential keys are refused at creation, and the
  self-app is `locked`, so a passing vote still needs an admin
  up-vote before it applies

What stays locked even when the flag is on (intentional — this
flag is purely about audience, not about disabling self-hosting
guards):
- 2g — `createApp` / `rebuildProduction` skip; GHA still drives
  the deploy
- 2h — credential / deploy-owned keys still unwritable (a
  declared tunable IS writable by a full admin, and proposable by
  anyone — that's the point of the panel)
- 2i — Mayor refuse-list still appended to self-app sessions
- 2k — `USERNODE_PLATFORM_REPO` import still blocked

**To enable:** append `SELF_APP_PUBLIC_VOTING=true` to `.env`
(or to the deploy heredoc in [.github/workflows/deploy.yml](./.github/workflows/deploy.yml))
and redeploy. No code change needed.

**Recommended sequence before flipping on:** run shadow mode for
a few weeks, confirm Phase 3 banner UX holds up across multiple
real self-app deploys, then flip the flag. The original design
called this the "open-source-by-live-dev-chat (future)" gate —
the broader permission-model question. Flipping the flag is just
the mechanical knob; *should we* is the deeper question this
document doesn't answer.

## Phase 5 — Self-staging iframe-auth login flow (shipped)

**Goal:** make the self-app eligible for the same dev-chat → staging
preview → iframe edit loop that already works for child apps, without
copying any prod password material across the staging boundary.

**Wrinkle:** the cloned `users.password` column is a hard sentinel
(`__staging_redacted__`) per Phase 0/2c, so a self-app staging
container has no usable login at `/api/auth/login`. Without a different
auth path the staging UI redirects to `/login.html` and the entire
preview flow stalls. The historical fix would have been to copy a
bcrypt'd password (or seed a known one) into staging — both of which
move credential material across the prod/staging boundary that Phase
0/2c exists to enforce.

**Implementation:** the platform already mints 1-hour **RS256**
app-identity JWTs at [/api/iframe-token](./server.js), signed with the
iframe *private* key (`IFRAME_JWT_PRIVATE_KEY`, which never leaves the
platform process). The caller must name the app it wants an identity
for — `GET /api/iframe-token?app=<slug>` — and the slug is resolved
through `appAccess.getAppForUser` at the `view` level, so you cannot
mint an identity for an app you are not allowed to see (unknown slug and
no-view-access return the same existence-hiding 404). The resulting
token is *audience-scoped to one app*: `aud: usernode:app:<apps.id>`,
plus `pur: 'iframe'`, so app A's token presented to app B fails the
audience check. [public/js/app-view.js](./public/js/app-view.js) already
rewrites every embedded iframe's `src` to include `?token=<JWT>` (with
periodic refresh).
[src/services/app-identity-env.js](./src/services/app-identity-env.js)
propagates only the RSA **public** half into every child and staging
container — as `USERNODE_JWT_PUBLIC_KEY`, `IFRAME_JWT_PUBLIC_KEY`, and
(retired, same PEM under the legacy name so pre-cutover app source keeps
verifying) `JWT_SECRET` — together with `USERNODE_APP_ID`, from which the
container builds its expected audience. The `JWT_SECRET` alias is on its
way out: nothing the platform generates reads it any more (neither the
scaffold nor the app-authoring conventions), so only app source predating
the cutover still depends on it. Run
`node scripts/audit-jwt-secret-readers.js` to see which repos those are;
the removal criterion lives in a block comment in `app-identity-env.js`. A container can therefore *verify* a
parent-issued identity and structurally *cannot mint* one. Child apps
already honor this — see "Auth — iframe token injection" in
[src/prompts/app-conventions.md](./src/prompts/app-conventions.md).
The public key is the *only* platform key material that propagates:
after phase-1 key separation the data key, worker secret, edge secret
and iframe **private** key are never placed in any child or staging
container, and a staging clone resolves its at-rest key from the
committed `config.stagingDataKey()` constant instead (which is why prod
ciphertext is structurally undecryptable in a preview — not that any
reaches one, since `app_secrets` / `platform_env_values` are
`staging:private` and truncated by the clone).
Phase 5 wires the platform's *own*
[src/middleware/auth.js](./src/middleware/auth.js) to the same
convention, gated entirely on `USERNODE_ENV === 'staging'`:

1. Cookie path runs first, identical to prod.
2. If the cookie is missing/stale **and** `USERNODE_ENV === 'staging'`,
   the middleware looks for `?token=<JWT>` (or the
   `x-usernode-token` header) and verifies it with the iframe **public**
   key — RS256, issuer `usernode`, audience
   `usernode:app:${USERNODE_APP_ID}`, `pur: 'iframe'` — via
   `platformJwt.verifyAppIdentityToken()`. **Fail-closed with no fallback
   branch:** a token that misses on algorithm, issuer, audience or `pur`
   mints nothing, and the same holds for the mint half in
   `/api/iframe-token` (the self-app clone also acts as the parent shell
   for the app views it renders), which answers a structured
   `503 signing_unavailable` rather than downgrading to a weaker token.
   During the RSA cutover itself a staging-only *legacy bootstrap shim*
   bridged both halves for one deploy window — a preview built by the
   pre-cutover platform received neither `USERNODE_APP_ID` nor any key
   material — but it was self-disabling by construction (its gate required
   the ABSENCE of both) and went permanently inert the moment the cutover
   reached `main`. It has since been removed; there is no legacy token
   shape any part of the platform still accepts.

   **How a preview signs at all — two issuers.** A clone receives the
   production **public** key (`appIdentityEnv()` injects
   `IFRAME_JWT_PUBLIC_KEY` into every container, the clone included) but
   never a private one. That public key is load-bearing for the handoff
   above: it is what verifies the production parent's `?token=`, and hence
   what lets a preview mint a session at all. But the clone is *also* a
   parent shell — every app view it renders fetches `/api/iframe-token` for
   the embedded child — and with no private key that endpoint 503s, which is
   a console error on load and fails the console-error baseline check on
   every framed route.

   So `config.load()` has a staging clone **generate its own ephemeral RSA
   signing pair at boot** (`platformJwt.generateStagingIframeKeyPair()`),
   giving it two trusted issuers: the production parent (injected public key)
   and itself. `platformJwt.iframeVerifyKeys()` returns both, and each is
   checked with identical pins — RS256, issuer `usernode`, per-app audience,
   `pur: 'iframe'` — so this is a two-key keyring, not a relaxed check.
   Production always has exactly one entry.

   Details that matter if you touch this:

   - **Generation is gated on the absence of the PRIVATE key only.** Gating
     on "either half unset" is a no-op, because the public half is always
     injected — that mistake shipped once and left the 503 in place.
   - **The ephemeral pair lives in module state, not `process.env`.**
     `config.load()` probes the pair whenever both env halves are present, so
     writing an ephemeral private key beside production's injected public key
     would fail that probe and hard-exit; the preview would not boot.
   - **`IFRAME_JWT_PUBLIC_KEY` is never overwritten.** Doing so would break
     the parent handoff and leave the checks runner on a login screen —
     failing checks harder than the 503 did.
   - The pair is ephemeral (a restart re-mints; tokens are 15m–1h and the
     shell refreshes), confined to that one clone (production verifies with
     production's key, so a preview-minted token is refused everywhere else),
     and never reaches a child container — `appIdentityEnv()` still
     propagates only the injected public half.
   - The generator refuses outright unless `USERNODE_ENV === 'staging'`, is
     idempotent within a process, and never overwrites an injected private
     key — so a real deployment missing its key still answers the structured
     `503` loudly rather than self-signing around the misconfiguration.
3. On verify it loads the matching `users` row from the local clone
   (the row identity survives Phase 0/2c — only `password` and four
   other columns are scrubbed; `id`, `username`, and `is_admin` are
   preserved), defends against id/username drift, and mints a fresh
   `sessions` row + `Set-Cookie: session=…`.
4. Subsequent requests in the same iframe use the cookie path
   normally; the parent's hourly token refresh stays harmless because
   the cookie path short-circuits any later `?token=` value.

**Trust chain:** parent prod admin auth (cookie) → parent
`/api/iframe-token?app=<slug>` (RS256, signed with the platform-only
iframe private key, `aud: usernode:app:<apps.id>`) →
`AppView.refreshToken()` injects token on iframe `src` → staging
middleware verifies with the injected **public** key against its own
`USERNODE_APP_ID` → mints local 7-day session cookie.

**Why this is a downgraded credential:** in prod the same JWT is
ignored — the production middleware never reads `req.query.token` /
`x-usernode-token`. So a stolen iframe-token can authenticate against
ephemeral staging clones (which are PR-scoped and short-lived) but
never against prod itself. It is also scoped to a single app by its
`usernode:app:<apps.id>` audience, so a token lifted out of one app's
iframe is inert against every other app *and* against the self-app
staging clone, whose `USERNODE_APP_ID` is the platform's own row. And
because containers hold only the public half, a compromised container
can verify tokens but cannot forge one. This matches the existing
posture for child-app iframe tokens, which are also useless against the
parent platform.

**Forwarded env vars:** [staging.js](./src/services/staging.js) also
forwards `USERNODE_DOMAIN` and `USERNODE_PLATFORM_REPO` from the
parent process env into the spawned container (when set). Both are
display-only locators read by [services/caddy.js](./src/services/caddy.js)
and [config.js](./src/config.js); without forwarding, a fork running
self-hosted under its own domain / GitHub org would see the canonical
Usernode-Labs defaults rendered in its staging preview UI.

**Deliberately NOT forwarded** (the load-bearing decision in Phase 5):

- `DOCKER_NETWORK` — only read when spawning containers, which staging
  cannot do (no Docker socket mount per Phase 2g). Forwarding adds
  nothing.
- `DB_CONTAINER` — read by [db-manager.js](./src/services/db-manager.js)
  to build `postgres://...@${DB_CONTAINER}:5432/...` URLs. The staging
  container's own pool uses the explicit `DATABASE_URL` set on line
  121 of staging.js and doesn't need it. Leaving `DB_CONTAINER` unset
  means db-manager falls back to a **stale default**
  (`'project-usernode-db'`) that doesn't resolve on the canonical prod
  network (`usernode-net`), which renames postgres to `usernode-db`.
  This mismatch is an **accidental defense layer**: the staging
  container's `DATABASE_URL` necessarily embeds the real postgres
  superuser password (clone has to live on the same cluster), and a
  buggy or hostile self-app PR that constructs a pg.Pool against any
  other database in that cluster could mutate prod data. The hostname
  fallback being wrong-by-default blocks the easy honest-mistake form
  of that. Forwarding `DB_CONTAINER` would remove the defense for
  zero gain — no legitimate consumer in staging needs it. See "Risks"
  below.

**What works in self-staging:** anything that's read-only against the
clone (UI, dev-chat history view, `/api/version`, status surfaces,
secrets list), anything that writes only to the clone DB (chat
sessions, votes scoped to staging rows). The cookie minted by Phase 5
is real, so all session-gated routes work.

**What's deliberately broken in self-staging:**

- Spawning child apps from inside a staging clone (no Docker socket
  mount, on purpose). (Routing itself needs no per-host Caddy action any
  more — the wildcard site maps hostnames to container names — so the
  only gap here is that a staging clone can't start the containers.)
- Reading `deploy-status.json` (host-mounted file the staging container
  doesn't see).
- `/api/auth/login` against any cloned account (passwords scrubbed —
  use the iframe path).
- Writing back to GitHub (`GITHUB_PRIVATE_KEY` / `GITHUB_BOT_TOKEN`
  default to empty in staging per [dapp.json](./dapp.json), so
  github.init() takes the disabled branch).

These are accepted limitations: self-staging exists for UI / prompts /
docs / pure-Node logic edits, not for end-to-end testing of the
infra-spawning code paths. Tests for those still run against a real
prod-like environment in CI.

**Acceptance:** open the self-app row in the parent's dev-chat,
trigger a staging build, click the "App" tab. The staging container's
HTML loads with `?token=…` present in the iframe URL bar; the
middleware verifies the token, sets the `session` cookie on the
staging origin, and the platform UI renders authenticated as the
admin. No password prompt, no copied hashes, no manual login.

**Cost (actual):** ~120 lines in
[src/middleware/auth.js](./src/middleware/auth.js), ~10 lines in
[src/services/staging.js](./src/services/staging.js), one
description tweak in [dapp.json](./dapp.json), this section.

**Risks (none specific to Phase 5; these are pre-existing properties
of any staging clone, called out here because Phase 5 makes the
clone routinely accessible through dev-chat preview):**

- The staging container's `DATABASE_URL` must embed the real postgres
  superuser password — the clone lives in the same postgres cluster
  as prod, and there's no clean way to issue a downgraded credential
  per cloned database. Honest code paths only ever target the staging
  clone's own DB (the URL is the only connection string they use); a
  hostile PR could parse the URL and connect to other prod databases.
  Phase 5's intentional non-forwarding of `DB_CONTAINER` (above)
  blocks the easy form of this; the substantive defense is admin
  review of self-app PRs before merge.
- The staging container reaches the prod sidecar `usernode-node` at
  `http://usernode-node:3000` (default). All current consumers are
  read-only chain queries — no funds at risk. Worth noting if a
  future PR adds wallet-send paths to the platform.
- The Phase 5 session cookie is set on the staging origin
  (`<slug>--s<id>.<USERNODE_DOMAIN>`); browsers scope cookies per-host so
  a leaked staging cookie can only be replayed against its own
  staging container, which is short-lived (deleted on PR merge or
  `/api/teardown-staging`). It cannot escape to the parent prod
  origin.

## Host-side deployer (standalone Docker deploy path)

Production deploys used to depend on a GitHub Actions runner picking up
the push to `main`. During the 2026-08-06 GHA outage, merged self-app
PRs sat undeployed for hours with the workflow queued — the platform's
own merge loop was hostage to a third-party CI queue.

The primary path is now a systemd service on the VPS:

- **`scripts/usernode-deployer.sh`** polls `github.com` (git data plane
  only — the same dependency `rollback.sh` already has, no Actions) for a
  new head of `main`. Two triggers share one code path: a **nudge** from
  the platform (after a self-app merge, `src/services/deploy-nudge.js`
  touches `runtime/deploy-nudge/nudge` through the one writable runtime
  mount; the poller stats it every 2 s and polls immediately — so
  on-platform merges deploy within seconds) and a **baseline** interval
  poll every 2 min that catches direct pushes to `main` and covers a
  missing nudge mount or a platform crash mid-merge. The nudge is a hint,
  never an authority: the deploy target still comes only from what
  `github.com` says `main` points at. On a new sha it checks the commit
  out into `/opt/usernode-src`, rsyncs it over `/opt/usernode` with the
  same exclude list the workflow uses (`.env`, `runtime/`,
  `.platform-env*`, `caddy/active/`, `data/` survive), computes the
  node/caddy change filters with `git diff`, and runs
  `scripts/deploy.sh`.
- **`scripts/deploy.sh`** is the single copy of the deploy logic
  (formerly inlined in `deploy.yml`'s ssh step): archive-refresh gating,
  platform-env materialization, pg_dump wait, then the blue-green
  cutover via `scripts/platform-rollout.sh` (build → start idle color →
  health gate → flip `caddy/active/platform-upstream.caddy` + graceful
  Caddy reload → drain old color) and a post-cutover confirmation gate
  with automatic rollback. A failed rollout leaves the previous color
  serving and only reverts `GIT_SHA` in `.env`; the full
  `rollback.sh` path is reserved for the nothing-is-serving case. Both
  callers serialize on `runtime/deploy.lock`, and `SKIP_IF_CURRENT`
  turns the loser of a workflow/poller race into a no-op.
- **The Deploy workflow stays** for two jobs only: rotating secrets
  (only a runner can read GitHub secrets; it composes `.env` and
  forwards it as `BASE_ENV_B64` — the poller never touches `.env` beyond
  patching `GIT_SHA`) and manual force-redeploys via `workflow_dispatch`.

Failure behavior: a sha that fails the health gate is rolled back by
`deploy.sh`, then the poller backs off on that sha (30 min) instead of
thrashing build → rollback; any new commit on `main` deploys
immediately. If `github.com` is unreachable, the poller just keeps
retrying — the running platform is untouched.

One-time install (as root on the VPS; afterwards every deploy refreshes
the mirrored copies automatically):

```bash
install -d -o deploy -g deploy -m 755 /opt/usernode-tools
install -m 755 /opt/usernode/scripts/usernode-deployer.sh /opt/usernode-tools/
install -m 644 /opt/usernode/scripts/usernode-deployer.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now usernode-deployer
```

Operations:

```bash
systemctl status usernode-deployer          # is it alive
journalctl -u usernode-deployer -f          # live deploy output
cat /opt/usernode/runtime/deploy-last.log   # last deploy transcript
grep ^GIT_SHA= /opt/usernode/.env           # what is deployed
```

## Sequencing summary

```mermaid
flowchart LR
    P0[Phase 0: staging:private<br/>enforcement]
    P1[Phase 1: rollback.sh<br/>+ rehearsal]
    P2a[2a: self_hosted column]
    P2b[2b: USERNODE_PLATFORM_REPO]
    P2c[2c: schema comments]
    P2d[2d: DB rename]
    P2e[2e: dapp.json]
    P2f[2f: boot-time seed]
    P2g[2g: ownership guards]
    P2h[2h: platform-variables panel]
    P2i[2i: Mayor refuse-list]
    P2j[2j: admin-only filter]
    P2k[2k: import-flow guard]
    P3[Phase 3: banner<br/>if needed]
    P4[Phase 4: in-app merge<br/>deferred]
    P5[Phase 5: self-staging<br/>iframe-auth]

    P0 --> P2c
    P1 --> P2f
    P2a --> P2c
    P2a --> P2f
    P2b --> P2f
    P2b --> P2k
    P2c --> P2d
    P2c --> P5
    P2d --> P2f
    P2e --> P2f
    P2f --> P2g
    P2f --> P2h
    P2f --> P2i
    P2f --> P2j
    P2f --> P2k
    P2g --> P3
    P2g --> P5
    P3 --> P4
```

Phase 0 and Phase 1 are independent and can land in either order.
Both must precede Phase 2. Within Phase 2, sub-steps land in the
order listed (each is a small commit). Phase 3 ships only after
observation; Phase 4 is deferred indefinitely. Phase 5 depends on
the Phase 0/2c column-scrub policy (so we know what does and doesn't
survive the clone) and on the Phase 2g ownership guards (which keep
self-staging from racing the prod platform on shared resources).

## Risks and mitigations

| Risk | Phase | Mitigation |
|------|-------|------------|
| Botched DB rename loses data | 2d | Keep original `usernode` DB for ~1 week; rehearse on local-dev first. |
| Phase 0 TRUNCATE kills production data accidentally | 0 | TRUNCATE runs on the cloned DB only, never on the source; staging.js call site is the only invocation. |
| Self-app PR breaks prompts.js, removing the refuse-list | 2i | rollback.sh restores the previous SHA. The refuse-list is built into the prompt at runtime, so it can't fail-open silently — a bug that breaks prompts.js takes the whole platform down loudly. |
| `DATA_ENCRYPTION_KEY` rotation via deploy.yml edit orphans every stored ciphertext, silently | 2i | Refuse-list explicitly covers `.github/workflows/deploy.yml` and the key by name. The workflow sources it from `USERNODE_JWT_SECRET` rather than a second secret, so there is nothing to regenerate by accident; `services/secrets.js` carries a do-not-touch note on the KDF and the `v1:` envelope. |
| Signing-key rotation (`WORKER_JWT_SECRET` / `EDGE_JWT_SECRET` / `IFRAME_JWT_*`) | 2i | Recoverable by design — workers re-bootstrap, edge users re-authorize. The `usernode.proxy` label bump is what evicts warm workers eagerly on a worker-key change. |
| Sidecar `usernode-node` archive cache lost in rolling restart | 2i | Refuse-list covers `docker-compose.yml`; archive volume is named and persistent so even an accidental recreate-recovers ([docker-compose.yml#L153-L166](./docker-compose.yml)). |
| Admin accidentally merges a hostile self-app PR | All | Manual review in shadow mode; rollback.sh as backstop. |

## Open questions

- **Who's an "admin" for self-app dev-chat?** `users.is_admin`
  exists; the bar is "set by the bootstrap admin user." Fine for
  shadow mode (1–2 people) but the doc's "open-source-by-live-
  dev-chat (future)" gate needs a real permission model before
  Phase 4.
- **Self-app slug in URLs.** `usernode-2d5619` is the frozen
  pick, and it'll appear in URLs as `usernode-2d5619--s<id>.<USERNODE_DOMAIN>`
  if/when staging is enabled. Mildly ugly. Acceptable.
- **`main_sha` updates on self-app deploy.** The seed reads
  `GIT_SHA` at boot. After a self-app PR merges and the workflow
  rolls the harness, the new container's seed runs again and
  updates `main_sha`. Between merge and successful boot, the row
  shows the old SHA — that's fine; the banner in Phase 3 is what
  surfaces the in-flight state.
- **Should the self-app row's env be hidden entirely, read-only,
  or writable?** Settled: writable for declared tunables (see 2h),
  read-only for the credential rows the deploy owns, and never
  disclosing a value to a non-admin. The `app_secrets` table plays
  no part for this row in any case — nothing reads it, and nothing
  writes it now that the routes branch to the platform-env store.

## Centralized bridge endpoint

SV hosts the canonical `usernode-bridge.js` at
`/usernode-bridge/v1/bridge.js`. Every dapp in the production fleet
loads it directly from
`https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js`
rather than vendoring a per-app copy (see
[src/prompts/app-conventions.md § Bridge — centrally hosted (not vendored)](./src/prompts/app-conventions.md)
for the consumer-facing rules and versioning policy).

Operational consequences for self-hosting:

- **The endpoint comes free.** Any SV instance that ships
  `public/usernode-bridge/v1/bridge.js` serves the bridge at
  `https://<your-USERNODE_DOMAIN>/usernode-bridge/v1/bridge.js`.
  The auth middleware exempts `/usernode-bridge/` and the static
  handler sets `Cache-Control: no-cache, must-revalidate`.
- **Fleet dapps point at the upstream production instance.** The
  four production dapps (echo, lastwin, falling-sands, opinion-
  market) hard-code `social-vibecoding.usernodelabs.org` as the host.
  A self-hosted SV fork has three options:
  1. Accept the dependency on upstream prod. Fine for read-only
     mirrors; brittle for forks that want to run offline or against
     a custom bridge build.
  2. Fork each dapp repo and edit the URL to point at the self-hosted
     instance. Five-character change per dapp; no other coupling.
  3. Templatize the URL at dapp-deploy time (e.g. read it from a
     `BRIDGE_BASE_URL` env var and string-substitute into
     `index.html`). Not implemented today — comes back as a real
     ask the first time someone tries (2) at scale.
- **Bridge bug fixes from the upstream SV are fleet-wide.** When the
  upstream SV redeploys with a bridge change, every dapp running
  against an SV fork that still points to upstream picks up the
  change on next page load. Self-hosters that want isolation should
  pursue option 2 or 3 above.

## App file storage (MinIO sidecar)

Issue #752 added platform-side storage for user-uploaded app images
(usernode.uploadFile() / the `/api/app-storage` API). Bytes live in a
MinIO object-store sidecar; Postgres's `app_files` table holds only
metadata (ownership, quotas, visibility).

Operational notes for self-hosting:

- **Compose additions**: the `usernode-minio` service, the
  `usernode-minio-data` volume, and the `usernode-storage` network in
  `docker-compose.yml`. The network is `internal: true` and joined
  ONLY by the platform and MinIO — child app/staging/worker containers
  on `usernode-net` can never reach the object store; every read and
  write is proxied through platform routes (`GET /app-files/:id`,
  `/api/app-storage/*`, `/api/apps/:slug/files*`).
- **Two new `.env` credentials**: `MINIO_ROOT_USER` and
  `MINIO_ROOT_PASSWORD`. Generate them once at rollout (same handling
  as `USERNODE_DB_PASSWORD`, e.g. `openssl rand -hex 24`). With them
  unset, the platform boots fine and file uploads return a clear
  `storage_unavailable` error — nothing else degrades.
- **Backups**: `usernode-minio-data` MUST be included in host-level
  backups alongside `usernode-db-data`. The `pg_dump`-based
  pull/push scripts cover only metadata; restoring the DB without the
  volume degrades every stored image to a 404 (annoying, not
  corrupting — restore order between the two doesn't matter).
- **Disk headroom**: quotas cap growth at 2 GB per app (100 MB for
  staging-preview uploads, GC'd after 7 days), so the theoretical
  ceiling is `2 GB × app count`. Watch the volume as the fleet grows.
- **External S3 instead of the sidecar**: the platform speaks the S3
  wire protocol via the `minio` client — point `MINIO_ENDPOINT` /
  `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (and optionally
  `STORAGE_BUCKET`) at any S3-compatible endpoint and drop the
  sidecar service; no code change needed.
- MinIO is AGPLv3, run unmodified as a separate service — the normal,
  compliant deployment shape for a self-hosted stack.

## Topochain (`/api/v4`) operations

The topochain surface — public standings, seasons/events, challenges,
participant profiles, the mobile shell's login + data endpoints, the
partner and telemetry-ingest endpoints, and the Admin console's
**Topochain** section — is served **in-process by this platform**. There
is no topochain container, no sidecar, and no external leaderboard
service: the deployment that used to host it is retired and write-frozen.
`GET /health` reports `{ "status": "ok", "topochain": true }` — a static
presence flag confirming the build carries the surface, not a subsystem
probe (there is no separate process that could be unhealthy).

### Route groups and their auth

Five groups, each with its own auth story. They are deliberately
different and must not be collapsed:

| Group | Paths | Auth |
|---|---|---|
| Public | `/api/v4/leaderboard*`, `/api/v4/season-events*`, `/api/v4/users/:id/profile`, `/api/v4/app-version/check` | Session-**optional**. A signed-in session can enrich a response (only `/leaderboard/global` branches on admin), but no session is required and these never 401. |
| Partner | `/api/v4/partner/*` | `X-API-Key` vs `TOPOCHAIN_PARTNER_API_KEY`. |
| Ingest | `POST /api/v4/slot-outcomes`, `POST /api/v4/epoch-stats` | `X-Ingest-Key` vs `TOPOCHAIN_INGEST_API_KEY`. The group's reads (`GET /api/v4/onchain-accounts`) stay public. |
| Mobile | `/api/v4/mobile/*` | Native establishment starts from the Social web-session cookie, then returns an encrypted credential to the OS-owned client. Data, delegation and push routes accept only that private Bearer credential; Social JavaScript never receives it. |
| Admin | `/api/v4/admin/*` | The platform's own admin gate (`adminMiddleware` / `requireAdminWrite`), not a topochain-specific credential. |

Separately, **`/challenges-api/*`** is the SV web shell's own read
surface (`src/routes/topochain/mobile.js`). It serves the same data as
the mobile group but is gated on the **platform session cookie**
(`webSessionAuth` + `requireSessionUser`), because a browser has a cookie
and not a bearer token. It used to be a proxy to the external leaderboard
deployment; it is in-process now, and everything under the prefix that
isn't explicitly registered returns 404.

### Configuration

Canonical production requires `NODE_RPC_URL`,
`NATIVE_SESSION_V2_TESTNET_CHAIN_ID`, and `TOPOCHAIN_PARTNER_API_KEY`;
missing lifecycle data stops boot. The self-app staging preview may omit
them and keeps the corresponding routes unavailable. Other integration
settings remain optional and disable only their named capability. Set
production values in the platform's **Platform variables** panel (they are
declared in `dapp.json`'s `platform_env`, not in a child app's `secrets`
block); `.env.example` documents the same keys for local dev and standalone
deploys.

- `NODE_RPC_URL` — canonical node endpoint used to sample the current epoch.
- `NATIVE_SESSION_V2_TESTNET_CHAIN_ID` — exact canonical Rust ChainId for
  the one supported native network mapping.
- `TOPOCHAIN_PARTNER_API_KEY` — authenticates partner routes and the managed
  producer's `/api/v1/delegations` read.
- `TOPOCHAIN_INGEST_API_KEY` — unset: every ingest **write** 500s.
- `TOPOCHAIN_ZK_BRIDGE_URL` — unset: `POST /api/v4/mobile/zkpassport/complete` 500s.
- `TOPOCHAIN_MAIL_API_URL` / `TOPOCHAIN_MAIL_API_KEY` / `TOPOCHAIN_MAIL_FROM`
  — all three or nothing.

**Mail deserves particular attention**, because it is the one setting
whose absence is invisible from the outside. Both senders are
always-success by contract (the OTP endpoint is specified that way so it
can't be used to enumerate accounts), so an unconfigured transport means
mobile email-login codes and onboarding waitlist confirmations are
generated and dropped while every response still says OK. In dev/staging
the code is printed to the log so the flow stays completable by hand; in
production it is an error-level log line and nothing else. **Admin
console → Topochain → Settings** shows the configured/unconfigured state
and names the affected flows — check it there rather than inferring from
logs.

### Data load

`scripts/topochain-load.js` is a **one-shot import**, not a sync. It
requires `TOPOCHAIN_SOURCE_DATABASE_URL` pointing at a restored dump plus
an explicit `--i-have-restored-a-dump` flag, and refuses to start
without both. `scripts/topochain-validate.js` gates the result against
the source (row counts per table, plus merge-aware checks). Neither runs
on deploy; both are operator-invoked. There is no continuous
topochain→platform replication — writes arrive through the ingest and
mobile groups above.

## Chat connector (Claude.ai / ChatGPT) operations

The hosted MCP connector lets a user chatting in Claude.ai or ChatGPT
browse apps, file a request, hand the work to **their own** Claude Code
on the web / Codex subscription, and turn the pushed branch into an
ordinary imported proposal. The platform spends no model credits on it.
Everything is served in-process at `POST /mcp` plus the OAuth routes
under `/api/connect/`; there is no sidecar.

**Connector credential issuance and social OAuth mutations are
production-only.** The connector routes 404 when `config.cliAuthEnabled`
is false, and social-account connect/callback/disconnect routes 404 when
`USERNODE_ENV=staging`. Social identity status is deliberately a separate
account surface: deterministic `?demo=identity-unverified`,
`?demo=identity-legacy`, and `?demo=1` fixtures keep all Settings states
reviewable in a staging preview without exposing credentials or real
identity rows.

### Configuration

The connector allowlist lives under **Chat connectors**; account proofs and
their rollout switch live under **Social identity & credits**. Set them in the platform's
**Platform variables** panel (a full admin sets directly; anyone else
proposes by vote), and note they take effect on the platform's **next
deploy**, not immediately.

- `MCP_CONNECTOR_REDIRECT_HOSTS` — defaults to
  `claude.ai,claude.com,chatgpt.com,openai.com`. Only touch it to *add* a
  chat product or to narrow the surface; an explicit value **replaces**
  the default rather than extending it, so re-list the hosts you still
  want. Loopback is added automatically in local mode only.
- `GITHUB_LINK_CLIENT_ID` / `GITHUB_LINK_CLIENT_SECRET` — a **dedicated**
  GitHub OAuth app for account proof. GitHub OAuth apps permit one callback
  URL, so this pair never falls back to the waitlist app.
- `X_LINK_CLIENT_ID` / `X_LINK_CLIENT_SECRET` — the X confidential client
  for account proof. When this pair is unset, the waitlist X pair may be
  reused if that app has both exact callback URLs registered.
- `IDENTITY_CREDIT_POLICY` — `legacy` (the deploy-safe default) preserves
  the current platform allowance. `tiered` makes unverified accounts
  $0/day and either verified GitHub **or** X $10/day. Providers replace,
  never stack; an explicit per-user admin override still wins; BYOK works
  in both modes. Any other value fails boot.

**Unset provider credentials are supported.** Settings names that provider
as unavailable and never offers a dead button; the other provider can still
unlock the tier. Existing connector attribution behavior remains: without
the dedicated GitHub app, external-agent work that requires a verified
GitHub login reports `github_link_unavailable` and names the platform-build
fallback. Keep `IDENTITY_CREDIT_POLICY=legacy` until at least one provider
is configured and the production end-to-end checks below pass.

### Creating the GitHub OAuth app

Create an **OAuth app** (Settings → Developer settings → OAuth Apps → New),
not a GitHub App. It must be separate from the waitlist GitHub app because
GitHub OAuth apps have one callback URL.

- **Authorization callback URL:** `https://<your-domain>/api/me/github/callback`
  — exactly what `callbackUri()` in `src/routes/social-identities.js` builds from
  `config.cliAuthOrigin`. A mismatch fails at GitHub's redirect check,
  before any platform code runs.
- **PKCE:** the route sends `code_challenge_method=S256`; the verifier is
  stored server-side with a hashed, single-use OAuth state and consumed
  before token exchange.
- **Scope: none.** `githubLink.SCOPE` is the empty string and
  `authorizeUrl` omits the parameter entirely. Because GitHub grants can be
  cumulative for a reused OAuth app, the callback also rejects a missing or
  non-empty returned scope and revokes that grant. This is why a dedicated
  app is an enforced requirement, not just setup advice.
- **No token is stored.** The token is used once, for the `GET /user` read
  that resolves the immutable numeric account id plus login, then handed back with
  `DELETE /applications/{client_id}/token` and dropped.
  `users.github_oauth_token_enc` is written NULL on every link and exists
  only as a legacy column; `migrate.js` revokes and clears any value a
  previous release left behind.
- The immutable id is the uniqueness and credit authority; the changeable
  login is presentation and proposal-attribution metadata. One GitHub
  account can belong to one Homeroom account. Linking X as well does not
  increase the tier.
- Store the client secret as `GITHUB_LINK_CLIENT_SECRET`; it is declared
  `private: true`, so it is encrypted at rest and never returned by any API.

### Creating or reusing the X app

Use an OAuth 2.0 **Web App / confidential client** with Read permission.
Register `https://<your-domain>/api/me/x/callback`; if reusing the waitlist
client, keep its `/waitlist/connect/x/callback` registered as well. The
account-proof flow uses PKCE S256, requests `tweet.read users.read` (the
minimum X requires for `GET /2/users/me`), stores the immutable id + current
username, calls `/2/oauth2/revoke`, and discards the token. Set the dedicated
`X_LINK_*` pair, or leave both unset to use a complete `WAITLIST_X_*` pair.

**Symptom: X shows "Something went wrong — You weren't able to give access
to the App" at the authorize step.** That page means the authorize request
carried a callback URI the X app has not registered, or an unknown client
ID — X refuses on its own page and never redirects back, so nothing reaches
the platform's logs. First stop: the admin diagnostics panel under the X row
in Settings → Social accounts & connectors, which names the credential pair
in use (dedicated vs. reused waitlist), shows the exact callback URI the X
app must register, and can live-check the pair against X's token endpoint.
When reusing the waitlist app, the fix is registering the second callback
described in step 3 of "Creating the X app" below (#880, #1291).

### Activating the tiered policy

1. Deploy the schema and provider configuration with
   `IDENTITY_CREDIT_POLICY=legacy`.
2. In production, connect and disconnect each configured provider, confirm
   the provider's authorization page shows the documented read-only access,
   and confirm Settings reports that Homeroom retained no token.
3. Verify an existing legacy GitHub attribution row is shown as
   **reconnect required**, not silently counted for credits.
4. Set `IDENTITY_CREDIT_POLICY=tiered` and deploy. Test one unverified account
   ($0 and an actionable connect prompt), one verified account ($10/day), an
   explicit admin override, and a BYOK-only account.
5. Roll back instantly by restoring `legacy`; identity proofs remain stored
   and no schema rollback is required.

#### Why not `public_repo`, and why not a GitHub App

Worth recording so it isn't re-litigated. The platform used to fork on the
user's behalf, which needs `public_repo` — GitHub's own description is
"read/write access to code, commit statuses, repository projects,
collaborators, and deployment statuses for **public repositories and
organizations**". No narrower classic scope can fork (`repo:status`,
`repo_deployment`, `read:user` cannot), so the only way to shrink the grant
was to stop forking server-side.

Migrating to a **GitHub App** with fine-grained permissions looks like the
obvious alternative and is worse:

- `POST /repos/{owner}/{repo}/forks` requires **Administration: write**
  (plus Contents: read) — a permission that reaches repository settings,
  transfers and deletion, on the user's **private** repositories too.
  `public_repo` at least cannot see anything private.
- GitHub requires the App to be installed on the destination account **with
  access to all repositories** to create a fork. The fork does not exist at
  install time, so "only select repositories" cannot cover it — the one
  benefit of a GitHub App is exactly what this endpoint refuses to allow.
- User-to-server tokens intersect app access with user access, adding
  failure modes (org installation restrictions, SSO) for no gain.
- It costs a new App registration, an installation flow (not the
  `authorize`/`callback` round-trip in `src/routes/mcp-remote.js`),
  installation-id storage, token refresh, and re-consent for every linked
  user.
- Its one real advantage — expiring user tokens — is moot now that the
  platform holds no user token at all.

### Verifying end to end

Do this once after the deploy that carries the values. It exercises the
whole path and each step has a distinguishable failure.

1. **Connect the chat product.** In Claude.ai: Settings → Connectors → Add
   custom connector, URL `https://<your-domain>/mcp`. The 401 challenge
   carries `WWW-Authenticate: Bearer resource_metadata=…`, which is what
   starts the OAuth dance. A redirect host outside the allowlist is
   rejected at registration — that is `MCP_CONNECTOR_REDIRECT_HOSTS`
   doing its job, not a bug.
2. **Approve on the consent page** at `/connect/authorize`. Check that it
   names the client *and* the redirect origin — the origin is the
   load-bearing fact, since a client name is attacker-chosen.
3. **Link GitHub.** Settings → *Social accounts & connectors* → Connect
   GitHub. GitHub's consent screen must say **public data only** and list no
   repository access; if it names public repositories, an older release is
   still running. If the row says "not configured", the values did not reach
   the running container: confirm the deploy that picked them up has actually
   landed.
4. **Ask the assistant to set up work on an app** (`prepare_work`). Success
   returns a branch name, a base commit and **two** pieces of text: a
   `guidance` array — the human's numbered next steps, worded for the
   client that called (claude.ai/code, chatgpt.com/codex, or a neutral
   variant) — and the `workOrder` itself, a payload addressed only to the
   coding agent that it must reproduce character for character in one code
   block. An assistant that paraphrases the work order — especially the
   40-character base commit — is the failure mode this split exists to
   prevent; if you see it summarised, that is worth recording. Also
   `forkStatus`: `ready` (they already have a fork), `missing`, or
   `name_conflict` (a same-named repo of theirs is in the way, so the fork
   is made under `<repo>-usernode`). None of the three is a failure; for
   the latter two, making the fork is guidance step 1 and GitHub's
   one-click fork page leads the work order's SETUP section. The refusals
   worth recognising: `github_not_linked` (this user hasn't pressed
   Connect — step 3), `github_link_unavailable` (the deployment has no
   OAuth app — configuration), and `platform_unavailable` (GitHub was
   unreadable, or it answered with something that is not a 40-hex commit
   id — retry; nothing was recorded).
5. **Run the coding agent.** On the hosted web agents the fork must exist
   *before* a session can be started on it — both start by picking a
   repository that is already in the user's GitHub account — so the
   one-click fork page is the first step, not a fallback for when
   `gh repo fork` is unavailable (that shortcut is for an agent working in
   a terminal, and it is named inside the work order). Then paste the work
   order in and let the agent fork, branch, commit and push. The setup
   commands are the same four in every fork state — clone the fork, add
   `upstream`, fetch, cut the branch at the recorded commit — with the fork
   step, when there is one, above them. If git rejects the base commit, the
   work order tells the agent to `git fetch upstream <sha>` and retry
   rather than branch from somewhere else; an agent that silently starts
   from `upstream/main` instead is a finding. It should *not* open a pull
   request — the platform does that.
6. **Ask the assistant to submit it** (`submit_work`).
   Homeroom opens the cross-fork PR with bot credentials and runs it
   through `POST /api/apps/:slug/pr-import`, producing an ordinary
   `source='imported'` proposal with a SHA-pinned staging preview, proposal
   checks and a group vote — carrying a "Built with Claude Code" chip.
   `fork_mismatch` here means the PR is not headed by the caller's own
   verified fork; the connector is deliberately stricter than the browser's
   import button, which lets any collaborator import any open PR.

### Caps worth knowing before you debug one

The connector keeps **no clocks** — nothing counts how many things a user
started in the last hour or day. Every cap in
`src/services/connector-limits.js` is a concurrency bound, and each is
either the platform's own per-user cap or looser than it, so a connector
caller is never more limited than the same person clicking the same button
in the browser:

- **10 open work orders at once** — the only bound on `prepare_work`, and
  the module's only hard-coded number. Deliberately looser than the
  platform's 3-active-sessions cap: a work order holds no worker.
  Re-asking for one you already hold is free, and a genuinely abandoned
  reservation stops counting when it expires after 14 days.
- **`submit_work` is bounded by the platform's promoted-session cap** —
  same query and same wording as the browser's promote route, admin tier
  included (5 base / 8 for full admins, via `services/session-caps.js`).
- **The platform-build fallback is bounded by the platform's active-session
  cap** (3 base / 5 for full admins) on builds running at once. Spend is
  metered by the user's daily credit budget, exactly as it is for the
  browser's own auto-build.

Rate limits at the `/mcp` edge are 60/min per token and 300/min per IP —
transport abuse protection, not work capacity, and untouched by the above.
Every limiter **fails closed** — if it cannot read its own state it
refuses rather than waving the write through, so a limiter refusal during
a database incident is expected behaviour, not a stuck cap.

`submit_work` additionally re-checks the promoted-session cap that
`POST /api/apps/:slug/pr-import` never enforced, with the same bound and
wording as the promote route. That asymmetry is deliberate: importing used
to be a one-at-a-time human action, and the browser button's behaviour is
out of scope here.

## Waitlist social connect (GitHub / X / LinkedIn)

The second-stage waitlist form ("Want in sooner?", reached from the
private link a signer receives) can **verify** a GitHub or an X account
instead of trusting a handle somebody typed. A verified account renders as
a green pill and is stored separately from the free-text handles, so
whoever reads signups can tell a claimed handle from a proven one. The
round trip lives in `src/routes/waitlist-connect.js` — the classic
authorize/token shape for GitHub, OAuth 2.0 with mandatory PKCE (S256) and
an HTTP Basic token exchange for X.

The two routes as a caller sees them, including the `connect=` outcomes the
round trip lands back on, are documented in
[docs/waitlist-public-api.md](./docs/waitlist-public-api.md); what follows is
the provider-by-provider setup.

### Configuration

Ten settings, all `required: false`, all declared in `dapp.json`'s
`platform_env` under the **Waitlist** group. None blocks boot or a merge.
Set them in the platform's **Platform variables** panel (a full admin sets
directly; anyone else proposes by vote), and note they take effect on the
platform's **next deploy**, not immediately.

**No pull request can supply these values.** They come out of a developer
portal that only a human with the owning account can reach, so the
declaration (this repo) and the value (the panel) land separately and in
either order. A value pasted before its declaration deploys simply shows
as an "orphan" row until the deploy catches up.

- `WAITLIST_GITHUB_CLIENT_ID` / `WAITLIST_GITHUB_CLIENT_SECRET` — the
  GitHub OAuth app that verifies a signer's GitHub account. It is
  waitlist-only: GitHub OAuth apps permit one callback, so account linking
  needs the separate `GITHUB_LINK_*` app above.
- `WAITLIST_X_CLIENT_ID` / `WAITLIST_X_CLIENT_SECRET` — the X app that
  verifies a signer's X account. X supports multiple registered callbacks,
  so this pair may also serve account linking when `/api/me/x/callback` is
  registered and the dedicated `X_LINK_*` pair is unset.
- `WAITLIST_LINKEDIN_CLIENT_ID` / `WAITLIST_LINKEDIN_CLIENT_SECRET` — the
  LinkedIn app that verifies a signer's LinkedIn account. It needs the
  "Sign In with LinkedIn using OpenID Connect" product; see the runbook
  below.
- `WAITLIST_FOLLOW_X_URL` / `WAITLIST_FOLLOW_LINKEDIN_URL` /
  `WAITLIST_FOLLOW_INSTAGRAM_URL` — public profile addresses the stage-2
  "Follow along" row links to. Independent of the OAuth pairs above and of
  each other: a network with no URL set renders no link, and none of the
  three is ever verified (see the closing note of the LinkedIn runbook for
  why no network will confirm a follow).
- `WAITLIST_INTEGRATION_KEYS` — trusted integrators; see the section below.
- `WAITLIST_OAUTH_ORIGIN` — overrides the origin the callback URLs are
  built from (`connectOrigin()`). Unset it is this deployment's canonical
  origin; it is `http://localhost:<PORT>` only when `USERNODE_LOCAL_DEV=1`
  says a developer is running the server locally. That default is
  deliberate: a missing variable must not be able to produce a callback
  that works nowhere but a laptop, because every provider rejects
  `redirect_uri` on its own page, after the person has left your site.
  Change it and you must register the matching callback URL with every
  provider you have configured.

**Each provider is judged on its own, and both halves must be set
together.** An id without a secret counts as unconfigured, so GitHub can
be live while X is not.

**Unset is a supported state, not a broken one.** With no credentials for
a provider, `GET /api/public/waitlist/more/:token` reports that provider
as unavailable and the form renders **no connect button** for it — the
free-text handle fields (Farcaster, Discord, Telegram, other) are
untouched and nothing errors. Somebody who reaches a connect link anyway
(a stale tab, an old bookmark) is redirected back to the form with
`?connect=unavailable`, which the form shows as "That sign-in is not
available yet." `tests/waitlist-connect-config.test.js` pins all of that,
including the asymmetric GitHub-on / X-off case.

**Staging previews can never exercise the round trip.** `WAITLIST_*` is
not in `INHERITED_KEYS` (`src/services/staging-env.js`) and
`platform_env_values` is `staging:private`, so a preview holds no
credentials by construction — the declarations show up in the panel as
"not set" and the stage-2 form shows no connect buttons. That is the
expected preview state; do not seed a fake client id to make a button
appear, because it would dead-end at the provider.

### Creating the X app

Contributed by **snait** on issue #880, who set up the GitHub side.

1. **Get a developer account.** Go to `developer.x.com` and sign in with
   the X account that should own the app — that account's project hosts
   it, and **the app name you pick is what users see on the consent
   screen**. X API access is pay-per-use; confirm the current billing and
   credit requirements in the developer portal before rollout.
2. **Create a Project, then an App inside it.** X requires apps to live
   inside a project. Name the project anything (e.g. "Homeroom")
   and the app something user-visible (e.g. "Homeroom Waitlist").
   X immediately shows an API Key / API Key Secret / Bearer Token —
   **ignore all three**; those are the OAuth 1.0a / app-only credentials,
   not what this flow uses.
3. **Configure user authentication** (app settings → *User authentication
   settings* → *Set up*):
   - **App permissions: Read.** The flow requests
     `users.read tweet.read`; nothing writes.
   - **Type of App: "Web App, Automated App or Bot"** — the confidential
     client. Do **not** pick "Native App / Single page App": that is a
     public client with no client secret, and the token exchange
     authenticates with HTTP Basic, so it would fail.
   - **Callback URI / Redirect URL:**
     `https://<your-domain>/waitlist/connect/x/callback` — on the
     canonical deployment,
     `https://social-vibecoding.usernodelabs.org/waitlist/connect/x/callback`.
     To reuse the same app for daily-credit identity, also register
     `https://<your-domain>/api/me/x/callback`.
     It must match exactly what `callbackUrl()` builds; X validates it at
     the authorize redirect, before any platform code runs.
   - **Website URL:** `https://<your-domain>` — also part of the consent
     surface the user sees.
   - Organization / terms / privacy fields are optional; filling them
     makes the consent screen look more trustworthy.
   - Save.
4. **Copy the OAuth 2.0 Client ID and Client Secret** X displays after
   saving: Client ID → `WAITLIST_X_CLIENT_ID`, Client Secret →
   `WAITLIST_X_CLIENT_SECRET`. Paste both into the Platform variables
   panel.

**Brand note.** The app name and Website URL are shown to every person who
clicks *Connect X*, so the account and name you choose at step 1–2 are a
public branding decision. Nothing is exposed until the credentials are
actually set — leaving the pair unset keeps the button hidden and GitHub
connect working on its own.

### Creating the GitHub OAuth app

A classic **OAuth app** (GitHub → Settings → Developer settings → OAuth
Apps → New OAuth App), *not* a GitHub App — the repo-hosting integration
is a separate GitHub App and is unrelated.

- **Authorization callback URL:**
  `https://<your-domain>/waitlist/connect/github/callback` — on the
  canonical deployment,
  `https://social-vibecoding.usernodelabs.org/waitlist/connect/github/callback`.
- **Scope: none.** The authorize URL omits the parameter, so the token
  reads public information only; it is used once for `GET /user` to
  resolve the login and then dropped.
- Client ID → `WAITLIST_GITHUB_CLIENT_ID`, generated client secret →
  `WAITLIST_GITHUB_CLIENT_SECRET` (declared `private: true`, so encrypted
  at rest and never returned by any API).
- GitHub permits only one callback URL per OAuth app. Do not reuse this app
  for account linking; create the dedicated `GITHUB_LINK_*` app above.

### Creating the LinkedIn OpenID Connect app

LinkedIn Developers → Create app, then add the **Sign In with LinkedIn
using OpenID Connect** product to it. Without that product the authorize
call is rejected before any platform code runs.

- **Authorized redirect URL:**
  `https://<your-domain>/waitlist/connect/linkedin/callback` — on the
  canonical deployment,
  `https://social-vibecoding.usernodelabs.org/waitlist/connect/linkedin/callback`.
- **Scopes: `openid profile`,** and nothing else. `email` is deliberately
  not requested: the waitlist row already has an address. The token is used
  once for `GET /v2/userinfo` to resolve the member's name, then dropped.
- Client ID → `WAITLIST_LINKEDIN_CLIENT_ID`, client secret →
  `WAITLIST_LINKEDIN_CLIENT_SECRET` (declared `private: true`, so encrypted
  at rest and never returned by any API). Both halves must be set or the
  Connect LinkedIn button stays hidden.
- **This confirms the account is theirs. It cannot confirm a follow.**
  LinkedIn exposes no API reporting whether a member follows a company
  page, so the stage-2 copy says "connect" and never claims otherwise. The
  same is true of Instagram; X can answer it, but only with the
  `follows.read` scope on a paid API tier.

## Waitlist trusted integrators

`POST /api/public/waitlist` is an anonymous write, so it is rate-limited at
**5 joins per 15 minutes per IP address**. That is the right bound for a
visitor typing their own address into the landing page, and the wrong one
for a partner running the signup form on their own site and posting the
results here: every one of their visitors arrives from the same server
address, so the sixth real person in a window is refused.

`WAITLIST_INTEGRATION_KEYS` names the callers allowed out of that bucket.
It is a comma-separated list of `label:secret` pairs:

```
WAITLIST_INTEGRATION_KEYS=acme:s3cret-one,partner-two:s3cret-two
```

The label is everything before the FIRST colon, so a base64 secret
containing one is fine. Labels are `[a-z0-9][a-z0-9_-]{0,31}`; a malformed
entry is logged and skipped rather than failing boot. Secrets are stored as
SHA-256 digests in memory and compared with `crypto.timingSafeEqual`, and
neither the secret nor the header is ever logged.

A caller presents its secret in **`X-Waitlist-Client-Key`**. When it
matches:

- The anonymous per-IP bucket no longer applies. A **client ceiling of 200
  joins per 15 minutes** applies instead, keyed on the label. A leaked key
  is therefore a bounded faucet, not an open one.
- The caller may additionally send the visitor's own address in
  **`X-Waitlist-Client-IP`**. When it parses as an IP, that visitor gets the
  same **5 per 15 minutes** a direct visitor would, and it is that address
  the signup row records instead of the proxy's. Without it there is nothing
  finer to key on and the client ceiling is the only bound.

Everything else is unchanged: the same validation, the same
already-on-the-list dedupe, the same confirmation mail, the same
non-enumeration contract. This is a rate-limit key and nothing more, and it
grants no read access to anything.

**Unset is the normal state**, and an unrecognised or malformed key is
treated as anonymous rather than refused, so a stale key on a partner's
side degrades to the ordinary limit instead of breaking their form. That is
deliberately unlike `TOPOCHAIN_PARTNER_API_KEY`, which 500s when the server
has no key configured: this header is optional by design.

**There is no CORS on the public API**, so an integrator cannot call this
from a browser on its own origin. The integration is server-to-server, which
is also what keeps the secret out of a page anyone can view.

This section is the operator half: which variable to set and why the
bounds are what they are. The caller half — every endpoint, its request
and response bodies, and both headers in context — is
[docs/waitlist-public-api.md](./docs/waitlist-public-api.md), which is the
document to hand a partner.

## Cross-references

- [docs/waitlist-public-api.md](./docs/waitlist-public-api.md) — the
  public waitlist API as an outside integrator implements against it;
  the caller-facing half of "Waitlist social connect" and "Waitlist
  trusted integrators" above.
- [EXTRACT-PLAN.md](./EXTRACT-PLAN.md) — the standalone-deploy
  prerequisite, now done.
- [src/prompts/app-conventions.md](./src/prompts/app-conventions.md)
  — defines `staging:private` (SQL) and `private: true` (env-vars,
  parallel pattern: encrypted at rest *and* isolated from staging;
  `sensitive: true` is accepted as a backward-compatible alias) and
  `dapp.json`. Phase 0 and 2c/2e bring the platform into compliance
  with rules it already prescribes for child apps. The platform's own
  `dapp.json` marks every credential-bearing entry `private` (e.g.
  `ADMIN_PASSWORD`, `JWT_SECRET`, `SESSION_SECRET`,
  `USERNODE_DB_PASSWORD`, `USERNODE_APP_SECRET_KEY`,
  `GITHUB_PRIVATE_KEY`, `GITHUB_BOT_TOKEN`, `ANTHROPIC_API_KEY`, and
  the "Platform keys" group's `DATA_ENCRYPTION_KEY`,
  `IFRAME_JWT_PRIVATE_KEY`, `WORKER_JWT_SECRET`, `EDGE_JWT_SECRET` —
  `IFRAME_JWT_PUBLIC_KEY` is deliberately NOT private, since a public
  key is not a credential and containers are meant to receive it) —
  defensive, since no platform-driven self-app staging exists
  today, but ready if/when it does.
- [scripts/rollback.sh](./scripts/rollback.sh) — Phase 1
  kill-switch; rehearsed quarterly per the safety rails.
