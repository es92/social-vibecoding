# Homeroom Platform

This application-owned chart deploys the platform process and either its own
PostgreSQL StatefulSet or an externally managed PostgreSQL cluster into
`social-platform`. Generated applications, warm workers and capture Jobs are
created later by the platform through the scoped runtime service account.

The `Build Kubernetes images` workflow resolves platform, worker, and capture
images, then packages their exact digests into `values.release.yaml` and
publishes this chart to `oci://ghcr.io/<repository-owner>/charts`. It runs for
source pushes and once each day so the worker can pick up a new Claude Code
release even when the repository is unchanged. The chart is the atomic release
marker: no chart version exists unless all three components have resolved
successfully, either through a build or reuse of a published image.

The platform image still builds at every release revision. Worker and capture
images reuse a published digest when their complete tracked build directory and
the build recipe are unchanged. The reuse key hashes the component's Git tree
(including Dockerfile, ignore files, file modes, and dependency files), the
release workflow, the resolver script, the target architecture, and the branch
ref. The worker key also includes the exact Claude Code version resolved from
npm; a new release rebuilds the worker, while the daily run reuses its digest
when that version is unchanged. An unrelated platform change therefore does
not rebuild worker/capture; a workflow or resolver change conservatively
rebuilds both. Each component's Docker build context must remain its own
directory; additional inputs or build arguments must also be represented in
the reuse key if the workflow is extended.

The registry stores these lookup tags as `inputs-<hash>`, separately for each
component and branch. The release always records the resolved `sha256` digest,
never the lookup tag. Main cannot reuse candidate-branch lookup tags. Missing
images (including the first run after this change) build normally; authentication,
transport, and invalid-manifest errors stop the job. Reuse does not depend on
the previous push's SHA or the retention period of GitHub Actions artifacts.
An image from a successful component build can be reused even if another
component or chart publication failed in that earlier run.

New builds publish `sha-<build-commit>` tags and retain their build provenance
and SBOM. Reused images retain their original source labels/attestations; no new
commit tag is created for them. The chart's release revision identifies the
platform source and chart, while the three digests identify the actual artifacts.
Workflow summaries show each component's resolution reason and selected digest.

Claude Code is the one automatically refreshed floating dependency: the
workflow resolves its current npm version, validates it, includes it in the
worker reuse key, and passes that exact version to the Docker build. Other
dependencies and base images can be refreshed without changing source by
manually running `Build Kubernetes images` with `force_rebuild` set to
`worker`, `capture`, or `all` (default: `none`). For example:

```bash
gh workflow run build-kubernetes-images.yml --ref main -f force_rebuild=worker
```

Selected components bypass reuse and Docker layer caching, and pull their base
images again. This refreshes floating apt/npm/tool dependencies; explicitly
pinned versions still require source changes. The refreshed digest replaces the
lookup tag for subsequent releases with the same inputs; previously published
charts retain their original digests. Registry retention must preserve images
referenced by releases for rollback. A manual run on `main` publishes a normal
stable release for Argo CD, including a new platform build and the selected
component refreshes.

`main` publishes stable `0.1.x` chart versions tracked by Argo CD. The
`feat/k8s` branch publishes `0.0.x-feat-k8s` candidates that can be pulled and
rendered manually but are outside Argo's stable version constraint. Cluster
configuration and SOPS-encrypted secrets remain in the infra repository and
are applied as external Helm values.

For Gmail delivery with `secrets.create: true`, merge these fields into the
existing `secrets` block in the infra repository's SOPS-encrypted
`prototype/bare-metal-platform/clusters/bare-metal-org/workloads/social-vibecoding/values/platform.secrets.sops.yaml`:

```yaml
secrets:
  gmailOauthClientId: "<Google OAuth client ID>"
  gmailOauthClientSecret: "<Google OAuth client secret>"
  gmailOauthRefreshToken: "<sending mailbox refresh token>"
```

Use the SOPS editor to supply real values; keep credentials out of plaintext
values files. These fields map to `GMAIL_OAUTH_CLIENT_ID`,
`GMAIL_OAUTH_CLIENT_SECRET`, and `GMAIL_OAUTH_REFRESH_TOKEN` in the platform
Secret, which the Deployment imports into its environment. With
`secrets.create: false`, supply those environment-variable keys directly in
`secrets.existingSecret` instead.

All three values are optional for chart installation but must be populated to
enable Gmail delivery. The refresh token needs the `gmail.send` scope, and its
mailbox must be authorized to send as `Homeroom <no-reply@onhomeroom.com>`
(the application's default sender). The Kubernetes deployment reads the Secret;
the Platform variables panel does not populate this chart's values.

Release the updated chart and sync the encrypted values through Argo CD. The
Deployment's existing secrets checksum triggers a rollout when these values
change. After rollout, check the admin mail status and verify delivery to a
mailbox you control.

For GitHub and X account linking, add both OAuth credential pairs to the same
encrypted file's existing `secrets` block using the SOPS editor:

```yaml
secrets:
  githubLinkClientId: "<GitHub OAuth client ID>"
  githubLinkClientSecret: "<GitHub OAuth client secret>"
  xLinkClientId: "<X OAuth client ID>"
  xLinkClientSecret: "<X OAuth client secret>"
```

With `secrets.create: true`, these map to `GITHUB_LINK_CLIENT_ID`,
`GITHUB_LINK_CLIENT_SECRET`, `X_LINK_CLIENT_ID`, and `X_LINK_CLIENT_SECRET` in
the platform Secret and reach the process through the Deployment's `envFrom`.
With `secrets.create: false`, provide those environment-variable keys in
`secrets.existingSecret`. All four fields default to empty strings and remain
optional for chart installation. Register
`https://<config.domain>/api/me/github/callback` on the GitHub OAuth app and
`https://<config.domain>/api/me/x/callback` on the X OAuth app. Publish the
updated chart and sync the encrypted values through Argo CD; the existing
secrets checksum rolls out credential changes.

For GitHub and X waitlist OAuth, merge these fields into the same
SOPS-encrypted `platform.secrets.sops.yaml` file's existing `secrets` block:

```yaml
secrets:
  waitlistGithubClientId: "<GitHub OAuth client ID>"
  waitlistGithubClientSecret: "<GitHub OAuth client secret>"
  waitlistXClientId: "<X OAuth client ID>"
  waitlistXClientSecret: "<X OAuth client secret>"
```

With `secrets.create: true`, these map to `WAITLIST_GITHUB_CLIENT_ID`,
`WAITLIST_GITHUB_CLIENT_SECRET`, `WAITLIST_X_CLIENT_ID`, and
`WAITLIST_X_CLIENT_SECRET` in the platform Secret, imported through the
Deployment's `envFrom`. Each provider requires both its ID and secret; empty
defaults leave that provider disabled. Waitlist OAuth does not fall back to
the account-linking credential fields above. Register
`https://<config.domain>/waitlist/connect/github/callback` and
`https://<config.domain>/waitlist/connect/x/callback` on the respective OAuth
apps. With `secrets.create: false`, provide the environment-variable keys in
`secrets.existingSecret`. Publish the updated chart and sync the encrypted
values through Argo CD; the existing secrets checksum rolls out changes to
chart-managed credentials.

To override the waitlist OAuth callback origin, set this non-secret value in
the infra repository's plaintext `platform.yaml`:

```yaml
config:
  waitlistOauthOrigin: "https://onhomeroom.com"
```

This maps to `WAITLIST_OAUTH_ORIGIN` in the platform Deployment. The empty
default preserves the application's canonical-origin fallback. Supply an
origin including the scheme, with no path or trailing slash; the application
appends `/waitlist/connect/<provider>/callback`. When overriding it, register
the resulting callback URLs with the OAuth providers.

For OpenRouter managed keys, set `secrets.openrouterManagementApiKey` in the
same SOPS-encrypted values file. With `secrets.create: true`, it maps to
`OPENROUTER_MANAGEMENT_API_KEY` in the platform Secret, imported through the
Deployment's `envFrom`. The field defaults to an empty string and is optional
for chart installation. With `secrets.create: false`, supply
`OPENROUTER_MANAGEMENT_API_KEY` in `secrets.existingSecret` instead. Release the
updated chart and sync through Argo CD; the secrets checksum triggers a rollout
when the value changes.

For mobile push, merge these fields into the same SOPS-encrypted
`platform.secrets.sops.yaml` file's existing `secrets` block:

```yaml
secrets:
  mobilePushEnabled: true
  pushEnv: production
  firebaseProjectId: usernode-7f4a2
  firebaseServiceAccountJsonB64: "<base64-encoded production service-account JSON>"
```

With `secrets.create: true`, these map to `MOBILE_PUSH_ENABLED`, `PUSH_ENV`,
`FIREBASE_PROJECT_ID`, and `FIREBASE_SERVICE_ACCOUNT_JSON_B64` in the platform
Secret and reach the process through the Deployment's `envFrom`. Push defaults
to disabled; the other three fields default to empty strings. Populate all
four together before enabling push, using a service account for the configured
Firebase project. Supply the base64-encoded JSON directly; the chart does not
base64-encode it again. Keep the credential in SOPS-encrypted values.

With `secrets.create: false`, provide the same environment-variable keys in
`secrets.existingSecret` instead. Publish the updated chart and sync the
encrypted values through Argo CD; the existing secrets checksum triggers a
rollout when chart-managed values change.

`config.domain` is the canonical platform hostname (`USERNODE_DOMAIN`).
`config.appsDomain` optionally sets a separate suffix for generated apps and
session previews (`USERNODE_APPS_DOMAIN`). When empty, it defaults to
`config.domain` and preserves existing deployments. For example:

```yaml
config:
  domain: app.onhomeroom.com
  appsDomain: onhomeroom.com
```

This serves the platform at `app.onhomeroom.com`, production apps at
`<slug>.onhomeroom.com`, and previews at `<slug>--s<sessionId>.onhomeroom.com`.
Platform links, CLI authentication, and access-grant redirects continue to use
`config.domain`. The platform hostname is reserved: app deployment rejects a
collision before writing Kubernetes resources, and app access parsing never
treats the platform as a generated app.

Agent-authored visual evidence is active by default. The chart always injects
`VISUAL_EVIDENCE_V2_ENABLED=true`; in an incident, set
`platform.visualEvidenceV2Enabled: false` and sync Argo CD to stop collection,
execution, and presentation together. This kill switch does not restore
legacy default-route screenshots.

DNS and cert-manager must support both hostname sets before rollout. Keep
session cookies host-only. Update external OAuth callback URLs and any
registered origins for the platform hostname. This change does not migrate
existing generated-app Ingresses or persisted preview URLs automatically:
redeploy existing apps and rebuild active previews through their normal
platform workflows after the platform release. Keep the prior DNS records
until migration and rollback checks are complete. A deployment restart alone
does not reconcile existing child-app routes.

The bundled standalone Caddyfile still uses its existing single-domain layout;
the separate-domain configuration described here is for the Kubernetes chart.

The OCI chart package must be public for unauthenticated Argo CD pulls. If it
is kept private, Argo CD needs a read-only GHCR repository credential with OCI
support enabled. Runtime image visibility is independent and may use the
cluster's existing image pull Secret.

Resource ordering within the Application is:

1. Secret, service accounts and network policy at sync wave `-3`.
2. PostgreSQL Service and StatefulSet at sync wave `-2`.
3. Idempotent migration `Sync` hook at wave `-1`.
4. Platform Deployment, Service and Ingress at wave `0`.

Session capacity and idle cleanup are explicit `config` values:
`maxGlobalSessions`, `maxUserSessions`, `maxUserPromotedSessions`,
`maxAdminUserSessions`, `maxAdminUserPromotedSessions`, `workerIdleEvictionMs`,
`sessionAutopauseIdleMs`, and `stagingIdleTeardownMs`. Defaults match the
application defaults; cluster values can restore the standalone deployment's
session ceiling and five-minute worker eviction without changing Docker defaults.
These values render as explicit environment variables and take precedence over
the same keys in an imported Secret or ConfigMap. Zero idle-timeout values are
preserved, including the supported `sessionAutopauseIdleMs: 0` disable switch.

The session ceiling counts logical active/promoted coding sessions, including
sessions with evicted workers. It does not reserve a worker or preview for each
session. Raising it requires matching namespace compute/object/PVC budgets,
working idle eviction and preview cleanup. ResourceQuota can still reject work
at its memory/request/object ceiling; it is not a job queue or a throughput
guarantee. Keep per-user caps and observe quota headroom after changes.

The master `enabled` gate is split further into `platform.enabled`,
`migration.enabled`, and `postgresql.enabled`. All three default to `true` for
backward compatibility. To use CloudNativePG or another external database, set
`postgresql.enabled=false`, configure `postgresql.host`, `postgresql.port`, and
the narrow `postgresql.podSelector`, then let the database-owning deployment
control ingress to its Pods. This also permits a cutover-ready configuration
with the platform, migration Job, and ingress disabled until the database is
writable.

Previews prefer the node hosting the external CloudNativePG primary by default
(`config.previewFollowDatabasePrimary: true`). The chart derives
`PREVIEW_DATABASE_CLUSTER` from `postgresql.podSelector["cnpg.io/cluster"]` and
`PREVIEW_DATABASE_NAMESPACE` from `postgresql.namespace` (or the release
namespace). Set the flag to `false` to disable the preference. Bundled PostgreSQL
and external databases without the CNPG cluster selector keep normal placement.
Installations without Helm can set both environment variables on the platform.

Only staging preview Deployments receive a weight-100 preferred Pod affinity
term matching that cluster's `cnpg.io/instanceRole: primary` across
`kubernetes.io/hostname`. Other eligible nodes remain available if the primary's
node is full, unavailable, or no matching primary exists. This is a scheduler
preference, not a guarantee: other scheduling scores can outweigh it. It needs
no node labels beyond the standard hostname, extra runtime RBAC, or node lookup.

After releasing the platform image and chart together, newly created or
reconciled preview Deployments get this policy. Existing Deployments are not
patched automatically. Following a database failover, newly scheduled Pods
prefer the new primary; running previews stay where they are. Opting out affects
future reconciliation too. Production apps, build Pods, workers and captures
retain their existing placement. See the
[Kubernetes affinity documentation](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#inter-pod-affinity-and-anti-affinity)
and [CloudNativePG labels](https://cloudnative-pg.io/docs/1.28/labels_annotations/).

Platform upgrades use a Kubernetes-native blue/green equivalent: a
`RollingUpdate` Deployment creates a new ReplicaSet beside the live one,
requires two consecutive readiness successes plus `minReadySeconds`, and keeps
`maxUnavailable: 0`. The stable Service starts routing to the new Pod only
after it is Ready; Kubernetes removes and terminates the old Pod after the new
ReplicaSet is Available. Existing connections receive the platform's normal
pre-stop and SIGTERM drain budget.

Both Pods may serve independent requests during the brief overlap. That is safe
because `PLATFORM_LEADER_LOCK=1` uses the platform's PostgreSQL advisory-lock
coordinator: only one Pod runs singleton recovery, sweepers and reconcilers.
This is intentionally implemented with the built-in Deployment controller;
the cluster does not need Caddy, Argo Rollouts, or another rollout CRD.

If the candidate never becomes Ready, the Deployment times out without taking
the old ReplicaSet down. Roll back by restoring the previous OCI chart version
in the Argo CD source; the same readiness-gated rollout then moves traffic back
to the previous immutable image set.

PostgreSQL data is held by a retained `openebs-lvm-retain` PVC. Deleting the
StatefulSet or Argo Application does not delete the underlying volume. Take a
logical backup or VolumeSnapshot before database upgrades or data migration.

To inspect a published release without installing it:

```bash
helm pull oci://ghcr.io/adonagy-corp/charts/social-vibecoding-platform \
  --version 0.1.<release> --untar
helm template social-vibecoding-platform ./social-vibecoding-platform \
  -f ./social-vibecoding-platform/values.release.yaml \
  --set enabled=true \
  --set secrets.create=false \
  --set secrets.existingSecret=social-vibecoding
```


## Proposal checks in Kubernetes

Capture Jobs honor the same `CAPTURE_CPUS` and `CAPTURE_MEMORY` limits as
Docker (eight CPUs / 6 GiB by default, for a pool of sixteen concurrent
browser groups). Their requests are one CPU / 3 GiB, matching the observed
browser working set; smaller limit overrides also lower the requests so
Kubernetes can admit the Pod. Per-job ephemeral storage remains 1 GiB
requested / 4 GiB limited. Changes apply to newly created check Jobs.

Capture Jobs visit the generated app and preview HTTPS ingress hostnames. The
self-app's production capture uses the canonical platform hostname. Worker
namespace DNS and egress must reach these ingress endpoints with valid TLS;
there is no HTTP or certificate-verification fallback. This preserves Secure
session cookies in Paketo's production-mode previews. Docker captures retain
their existing network path.

When `WORKER_RUNTIME=kubernetes`, repo unit suites run as separate Jobs using
`KUBERNETES_WORKER_IMAGE`, pinned by the same chart release. That image includes
Node, git and a local disposable PostgreSQL 17 for repositories opting into SQL
checks. Each Job has no service-account token or shared workspace volume,
uses the existing worker service account for image pulls, and runs as UID 1000.
Clone credentials are in a temporary Secret owned by the Job and deleted when
the runner finishes. Jobs have no retries, a default ten-minute deadline, and
a one-hour cleanup TTL. The default limit is eight CPUs / 4 GiB (`node --test`
sizes its process pool from the CPU quota, so the limit sets the suite's
parallelism), with requests of one CPU / 1 GiB; existing `UNIT_SUITE_CPUS`,
`UNIT_SUITE_MEMORY` and
`UNIT_SUITE_TIMEOUT_MS` settings apply. Allow worker quota for simultaneous
capture and unit-suite Jobs. Unit-suite log reads are bounded to 32 MiB.

Failed Jobs preserve their exit code and available test output in the check
result; timeouts remain failures. Checks and earned merge gating are not
bypassed. Existing previews can be rechecked after the platform release; a
preview rebuild is not required just to change its capture URL.

## Platform rollout reporting

The platform reads its own Deployment for `/api/version` and admin status.
The chart binds `social-platform-runtime` to a Role with only `get` on that
Deployment and injects its namespace and name, including fullname overrides.
Incomplete rollouts, controller failures, paused rollouts, and unavailable API
reads remain distinct. This reports Argo-applied rollout state; image build and
chart publication progress remain in the `Build Kubernetes images` workflow.
Kubernetes self-app merges do not write the standalone host-deployer nudge.
