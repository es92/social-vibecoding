const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (path) => fs.readFileSync(path, 'utf8');

test('Kubernetes platform image contains PostgreSQL tools but no Docker CLI', () => {
  const dockerfile = read('Dockerfile.kubernetes');
  assert.match(dockerfile, /postgresql-client/);
  assert.doesNotMatch(dockerfile, /docker-cli|docker\.sock/);
  // Numeric, not `node`: the pod runs with runAsNonRoot and no runAsUser, and
  // Kubernetes can verify a numeric image user only.
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.doesNotMatch(dockerfile, /^USER node$/m,
    'runAsNonRoot cannot verify a symbolic image user before startup');
});

test('Kubernetes hosted-app evidence image declares a numeric non-root user', () => {
  const dockerfile = read('capture/Dockerfile');
  // The shots fixture deliberately runs this image through
  // deployApplication(), whose pod security context sets runAsNonRoot without
  // runAsUser. Kubernetes cannot resolve a symbolic image user such as
  // `node` before startup, even when that account is non-root in /etc/passwd.
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.doesNotMatch(dockerfile, /^USER node$/m,
    'the hosted-app fixture must satisfy the same numeric-user contract as ordinary app images');
});

test('Kubernetes platform image builds and contains the generated shell assets', () => {
  const dockerfile = read('Dockerfile.kubernetes');
  assert.match(dockerfile, /FROM node:22.23.4-alpine AS asset-deps/);
  assert.match(dockerfile, /FROM node:22.23.4-alpine AS shell/);
  assert.match(dockerfile, /from=asset-deps[^\n]+node_modules[^\n]+\\\n\s+node frontend\/scripts\/build-shell\.mjs/);
  assert.match(dockerfile, /from=asset-deps[^\n]+node_modules[^\n]+\\\n\s+node scripts\/build-tailwind\.js/);
  assert.doesNotMatch(dockerfile, /FROM node:22.23.4-alpine AS css/,
    'a second dependency-bearing asset stage makes rootless BuildKit restore it separately');

  const shellBuild = dockerfile.indexOf('node frontend/scripts/build-shell.mjs');
  const publicCopy = dockerfile.indexOf('COPY public ./public');
  const cssBuild = dockerfile.indexOf('node scripts/build-tailwind.js');
  assert.ok(shellBuild > -1 && shellBuild < publicCopy && publicCopy < cssBuild,
    'Tailwind must scan the shell generated earlier in the same stage');

  const shellStage = dockerfile.slice(
    dockerfile.indexOf('FROM node:22.23.4-alpine AS shell'),
    dockerfile.lastIndexOf('\nFROM node:22.23.4-alpine\n'),
  );
  assert.doesNotMatch(shellStage, /RUN npm ci/,
    'asset dependencies must stay outside the generated-output snapshot');

  // The commit id sits BELOW the two expensive steps. A build arg above a RUN
  // is part of that step's cache key, so with GIT_SHA above them every commit
  // rebuilt the bundle and the stylesheet whatever it had changed: 167 of 167
  // preview builds in the logs this order was measured against. Nothing above
  // the id may read it, and everything that does comes after it.
  const order = (needle) => {
    const at = shellStage.indexOf(needle);
    assert.ok(at > -1, `the shell stage must contain \`${needle}\``);
    assert.equal(shellStage.indexOf(needle, at + 1), -1, `the shell stage must contain \`${needle}\` once`);
    return at;
  };
  const bundle = order('node frontend/scripts/build-shell.mjs --keep-prerender');
  const css = order('node scripts/build-tailwind.js');
  const commitArg = order('ARG GIT_SHA=dev');
  const commitEnv = order('ENV GIT_SHA=$GIT_SHA');
  const document = order('node frontend/scripts/build-shell.mjs --document');
  const release = order('RUN node scripts/build-shell-release.js');
  const precompress = order('RUN node scripts/precompress-static-assets.js');
  assert.ok(bundle < css && css < commitArg,
    'the Vite passes and Tailwind run before GIT_SHA is declared, so a commit that left their inputs alone can reuse them');
  assert.ok(commitArg < commitEnv && commitEnv < document,
    'the document this build serves is written with the commit id');
  assert.ok(document < release && release < precompress,
    'the release file and the precompressed copies describe that final document');
  assert.equal(shellStage.split('build-shell.mjs').length - 1, 2,
    'the shell build runs twice in this stage: the bundle, then the document. A plain third run would redo Vite under the commit id');
  assert.match(shellStage, /from=asset-deps[^\n]+node_modules[^\n]+\\\n\s+node frontend\/scripts\/build-shell\.mjs --document/,
    'the document step renders with the prerender bundle, which loads react from the dependency stage');

  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM node:22.23.4-alpine\n'));
  assert.doesNotMatch(runtime, /^COPY --chown=node:node \. \.$/m,
    'the runtime image must not ship tests, docs, or builder sources');
  for (const source of [
    'COPY --chown=node:node server.js dapp.json ./',
    'COPY --chown=node:node src ./src',
    'COPY --chown=node:node scripts ./scripts',
    'COPY --chown=node:node worker ./worker',
    'COPY --chown=node:node app-templates ./app-templates',
    'COPY --chown=node:node --from=shell /build/public ./public',
  ]) {
    assert.ok(runtime.includes(source), `${source} must be present in the runtime stage`);
  }
  assert.doesNotMatch(runtime, /^COPY .*frontend/m);
  assert.doesNotMatch(runtime, /^COPY .*tests/m);
  assert.doesNotMatch(runtime, /^COPY .*docs/m);
});

test('Kubernetes platform image ships every directory the server reads beside src/', () => {
  // The runtime stage copies a list, not the whole tree, so a top-level
  // directory that src/ reads by path is missing in production unless it is
  // on that list. app-templates/ was not: every ready-made app and game
  // starter failed to create with "ENOENT: scandir '/app/app-templates/…'"
  // while Dockerfile, which copies everything, and every test were fine.
  const dockerfile = read('Dockerfile.kubernetes');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM node:22.23.4-alpine\n'));
  const shipped = new Set();
  for (const [, args] of runtime.matchAll(/^COPY (.+)$/gm)) {
    const parts = args.split(/\s+/).filter((a) => !a.startsWith('--'));
    const dest = parts.pop();
    if (dest === './') for (const p of parts) shipped.add(path.basename(p));
    else shipped.add(dest.replace(/^\.\//, '').split('/')[0]);
  }

  const root = path.resolve(__dirname, '..');
  const reads = [];
  for (const rel of fs.readdirSync(path.join(root, 'src'), { recursive: true })) {
    // The CLI runs from a developer's checkout, never in this image.
    if (!rel.endsWith('.js') || rel.startsWith(`cli${path.sep}`)) continue;
    const file = path.join(root, 'src', rel);
    for (const [call] of read(file).matchAll(/path\.(?:join|resolve)\(__dirname(?:,\s*'[^']*')+/g)) {
      const segments = [...call.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const top = path.relative(root, path.resolve(path.dirname(file), ...segments)).split(path.sep)[0];
      if (top && top !== 'src' && top !== '..') reads.push([top, path.relative(root, file)]);
    }
  }
  assert.ok(reads.some(([top]) => top === 'app-templates'), 'the scan finds services/app-templates.js');
  for (const [top, from] of reads) {
    assert.ok(shipped.has(top), `${from} reads ${top}/, which the runtime stage does not copy`);
  }
});

test('Kubernetes platform image keeps the npm download cache out of both dependency layers', () => {
  // `npm ci` keeps a copy of every tarball it fetched. Left in /root/.npm it
  // was half of each dependency layer (38 MB and 50 MB compressed, 19 MB and
  // 25 MB without it), restored by every build and pulled by every pod, and
  // read by nothing.
  const instructions = read('Dockerfile.kubernetes').replace(/\\\n/g, ' ').split('\n');
  const installs = instructions.filter((line) => /^RUN .*\bnpm ci\b/.test(line));
  assert.equal(installs.length, 2, 'the asset-deps install and the runtime install');
  for (const run of installs) {
    const cache = (run.match(/\bnpm ci\b[^&;|]* --cache (\/\S+)/) || [])[1];
    assert.ok(cache, `${run}: must name its cache directory rather than leave it at the default`);
    assert.ok(run.includes(`&& rm -rf ${cache}`), `${run}: must remove ${cache} in the same layer`);
  }
});

test('Docker keeps boot migrations while Kubernetes can delegate them to a Job', () => {
  const source = read('server.js');
  assert.match(source, /RUN_MIGRATIONS_ON_STARTUP !== 'false'/);
  assert.match(source, /migration = await withMigrationLock\(getPool\(config\), async \(\) => \{\n\s*const result = await migrate\(config\);/);
  // The read-only database roles go with the schema, by the new build,
  // before any Pod of the release: the Job does both (services/db-roles.js).
  const job = read('scripts/migrate-kubernetes.js');
  assert.ok(job.indexOf('await migrate(config)') < job.indexOf("require('../src/services/db-roles').ensureRoles(config)"),
    'the migration Job sets the roles up after the schema');
  assert.ok(!/ensureRole\(|ensureConsoleRole\(/.test(source.slice(source.indexOf('async function becomeLeader()'), source.indexOf('async function start()'))),
    'and no leader does at its election');
});

test('startup diagnostics expose coarse public-safe phases through health', () => {
  const server = read('server.js');
  const migrate = read('src/db/migrate.js');
  assert.match(server, /startup: startupDiagnostics/);
  assert.match(server, /migrationsOnStartup/);
  assert.match(server, /servicesMs: Date\.now\(\) - servicesStartedAt/);
  for (const phase of [
    'preflightMs', 'schemaMs', 'reindexMs', 'coreSeedMs',
    'stagingFixturesMs', 'maintenanceMs', 'totalMs',
  ]) {
    assert.match(migrate, new RegExp(phase));
  }
  assert.match(migrate, /log\.info\('db', 'Migration phases complete', timings\)/);
  assert.match(migrate, /return timings;/);
});

test('self-app previews skip production fleet role maintenance', () => {
  const migrate = read('src/db/migrate.js');
  const start = migrate.indexOf('async function migrateAppDbsToPerRole(pool, config)');
  const end = migrate.indexOf('\nasync function ', start + 1);
  assert.ok(start > -1 && end > start, 'per-app role migration function is located');
  const body = migrate.slice(start, end);
  const stagingGuard = body.indexOf("if (process.env.USERNODE_ENV === 'staging')");
  const fleetQuery = body.indexOf('SELECT id, slug, name, container_id');
  assert.ok(stagingGuard > -1 && stagingGuard < fleetQuery,
    'the preview returns before reading or administering production child apps');
  assert.match(body, /Per-app role migration skipped in staging preview/);
});

test('Kubernetes platform rollout preserves availability and singleton ownership', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(platform, /type: RollingUpdate/);
  assert.match(platform, /maxSurge: 1/);
  assert.match(platform, /maxUnavailable: 0/);
  // A web Pod stays ready 10 s before the old one goes, and needs two
  // readiness answers in a row; the conductor keeps 5 s and one. A release on
  // 6 Nov 2026 declared a web Pod ready one second after it failed liveness
  // (issue #6403), so one quick answer is not proof it can serve.
  assert.equal((platform.match(/minReadySeconds: 10\n/g) || []).length, 1, 'the web Deployment holds a new Pod ready for 10 s');
  assert.equal((platform.match(/minReadySeconds: 5\n/g) || []).length, 1, 'the conductor keeps 5 s');
  assert.match(platform, /successThreshold: \{\{ ternary 1 2 \(eq \.processRole "conductor"\) \}\}/,
    'two readiness answers for web, one for the conductor');
  // The startup probe asks every second and still allows five minutes: the
  // security barrier's 180 s plus ordinary boot and drain work.
  const startup = platform.slice(platform.indexOf('startupProbe:'), platform.indexOf('readinessProbe:'));
  const every = Number(startup.match(/periodSeconds: (\d+)/)[1]);
  const tries = Number(startup.match(/failureThreshold: (\d+)/)[1]);
  assert.equal(every, 1);
  assert.ok(every * tries >= 300, `startup budget ${every * tries}s`);
  assert.match(platform, /name: PLATFORM_LEADER_LOCK, value: "1"/);
  assert.doesNotMatch(platform, /type: Recreate/);
});

test('Kubernetes gives the platform a heap ceiling that fits its memory limit', () => {
  // Node's default heap stops at about 1.5 GB whatever limits.memory says; on
  // 2026-09-25 the platform crash-looped on heap exhaustion with half of its
  // 3Gi container unused.
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(platform,
    /\{\{- with \.Values\.platform\.nodeOptions \}\}\n\s+- \{name: NODE_OPTIONS, value: \{\{ \. \| quote \}\}\}\n\s+\{\{- end \}\}/,
    'the platform container gets NODE_OPTIONS only when a value is set');
  const heap = /nodeOptions: "--max-old-space-size=(\d+)"/.exec(values);
  assert.ok(heap, 'the chart sets a default heap ceiling');
  const limit = /limits:\n\s+cpu: "4"\n\s+memory: (\d+)Gi/.exec(values);
  assert.ok(limit, 'the platform memory limit is in Gi');
  const heapMb = Number(heap[1]);
  const limitMb = Number(limit[1]) * 1024;
  assert.ok(heapMb > 1536, 'above Node\'s default ceiling, or it changes nothing');
  assert.ok(heapMb <= limitMb * 0.8, 'leaves room outside the heap for buffers, code and stacks');
});

test('Kubernetes enables before & after shots by default with one explicit kill switch', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /shotsEnabled: true/);
  assert.match(platform,
    /name: SHOTS_ENABLED, value: \{\{ \.Values\.platform\.shotsEnabled \| quote \}\}/);
  assert.doesNotMatch(platform, /shotsEnabled \| default true/,
    'Helm default treats boolean false as empty and would defeat the kill switch');
});

test('Kubernetes passes no workflow flag: every machine is the only path for what it decides', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.doesNotMatch(platform, /WF_GOVERNANCE_ENABLED|WF_PREVIEWS_ENABLED|PREVIEW_LIFECYCLE_ENABLED/);
  assert.doesNotMatch(platform, /WF_MERGE_FOLLOWUPS_ENABLED|WF_APP_DELIVERY_ENABLED|WF_OWNERSHIP_MODE/);
  assert.doesNotMatch(values, /workflowPreviewsEnabled|previewLifecycleEnabled|workflowGovernanceEnabled/);
  assert.doesNotMatch(values, /workflowMergeFollowupsEnabled|workflowAppDeliveryEnabled/);
});

test('Kubernetes workflow resolves all three images before publishing a release', () => {
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const workerDockerfile = read('worker/Dockerfile');
  for (const component of ['platform', 'worker', 'capture']) {
    assert.match(workflow, new RegExp(`"component":"${component}"`));
  }
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/);
  assert.match(workflow, /ghcr\.io\/\$\{\{ steps\.registry\.outputs\.owner \}\}\/social-vibecoding-\$\{\{ matrix\.component \}\}/);
  assert.doesNotMatch(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}/);
  assert.match(workflow, /sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /steps\.build\.outputs\.digest/);
  assert.match(workflow, /if: steps\.reuse\.outputs\.digest == ''/);
  assert.match(workflow, /IMAGE_DIGEST: \$\{\{ steps\.reuse\.outputs\.digest \|\| steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /no-cache: \$\{\{ steps\.reuse\.outputs\.refresh == 'true' \}\}/);
  assert.match(workflow, /pull: true/);
  // The gates run beside the image builds, and publishing waits for all of them.
  assert.match(workflow, /needs: \[build, security-lockfiles, security-regressions, preview-schema-compatibility\]/);
  assert.match(workflow, /schedule:[\s\S]*cron: '23 5 \* \* \*'/);
  assert.match(workflow, /npm view @anthropic-ai\/claude-code@latest version/);
  assert.equal((workflow.match(/npm view @anthropic-ai\/claude-code@latest version/g) || []).length, 1,
    'the dependency version is resolved once in the plan, not once per image job');
  assert.match(workflow, /if: needs\.plan\.outputs\.should_release == 'true'/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
  assert.match(workflow,
    /if \[ -n "\$SCHEDULED_WORKER_DIGEST" \]; then[\s\S]*echo 'should_release=false'/,
    'an unchanged scheduled dependency must skip every build and release job');
  assert.match(workflow,
    /matrix=\{\"include\":\[\{\"component\":\"worker\",\"context\":\"worker\",\"dockerfile\":\"worker\/Dockerfile\"\}\]\}/,
    'a changed scheduled dependency builds only the worker image');
  assert.match(workflow, /REUSE_CURRENT_PLATFORM: 'true'/);
  assert.match(workflow, /name: image-digest-scheduled-bases/);
  assert.match(workflow, /CLAUDE_CODE_VERSION: \$\{\{ steps\.claude\.outputs\.version \}\}/);
  assert.match(workflow, /build-args: \|\n\s+GIT_SHA=\$\{\{ github\.sha \}\}\n\s+\$\{\{ steps\.claude\.outputs\.build_arg \}\}/,
    'the shell build needs the same exact revision as the runtime, while retaining the worker version');
  assert.match(workerDockerfile, /ARG CLAUDE_CODE_VERSION=latest/);
  assert.match(workerDockerfile, /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
});

test('every Kubernetes chart release validates its immutable platform image with the runtime revision', () => {
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const release = workflow.slice(workflow.indexOf('\n  release:\n'));
  const start = release.indexOf('- name: Validate platform shell release');
  const end = release.indexOf('- name: Prepare and validate release chart');
  assert.ok(start > release.indexOf('- name: Download image digests'));
  assert.ok(start > release.indexOf('- uses: docker/login-action@v4'));
  assert.ok(end > start, 'validation gates chart publication');
  const validation = release.slice(start, end);
  assert.doesNotMatch(validation, /\bif:|continue-on-error:/,
    'scheduled image reuse must pass the same blocking check as a source release');
  assert.match(validation, /image-digests\/platform\.txt/);
  assert.match(validation, /social-vibecoding-platform@\$digest/);
  assert.match(validation, /--env NODE_ENV=production --env GIT_SHA="\$GITHUB_SHA"/);
  assert.match(validation, /--entrypoint node "\$image"/);
  assert.match(validation, /--network none --read-only/);
  assert.match(validation, /require\('\.\/src\/services\/shell-release'\)/);
  assert.match(validation, /loadShellRelease\('\/app\/public'\)/);
});

test('Kubernetes workflow retains queued releases, publishes the tip, and never an older revision over a newer one', () => {
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const release = workflow.slice(workflow.indexOf('\n  release:\n'));
  assert.match(workflow,
    /concurrency:\n  group: kubernetes-images-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n(?:  #[^\n]*\n)*  queue: max/,
    'a later waiting push must not cancel an earlier merge before it gets a release run');
  assert.match(release, /git ls-remote --exit-code origin "\$GITHUB_REF"/);
  assert.match(release, /if \[ "\$current_sha" = "\$GITHUB_SHA" \]; then/);
  // Behind the tip (5 October: twelve queued runs in a row skipped, so
  // nothing deployed for an hour and a half), a stable run publishes only
  // ahead of an older, lower-numbered release, at most every
  // RELEASE_EVERY_MINUTES. tests/kubernetes-release-publish-rule.test.js runs
  // the step against every case.
  assert.match(release, /helm show chart "\$CHART_REF" --version '0\.1\.\*'/,
    'the newest release Argo CD would run, read from the registry');
  assert.match(release, /compare "\$published_sha" "\$GITHUB_SHA"\)" = ahead/, 'only over an older revision');
  assert.match(release, /compare "\$GITHUB_SHA" "\$current_sha"\)" = ahead/, 'only a revision the branch still contains');
  assert.match(release, /\[ "\$RELEASE_CHANNEL" = stable \] \|\| decide false/, 'a candidate waits for its tip');
  // The tip too (7 October: four rollouts in sixteen minutes) goes out no
  // sooner than RELEASE_MIN_GAP_MINUTES after the release before it: it waits
  // in the step, re-reading the branch, and a dispatched run never waits.
  assert.match(release, /RELEASE_MIN_GAP_MINUTES: '4'/);
  assert.match(release, /\[ "\$GITHUB_EVENT_NAME" != workflow_dispatch \] \\\n\s+\|\| decide true/,
    'a run dispatched by hand is the way to release at once');
  assert.match(release, /sleep \$\(\( wait_until - now < 30 \? wait_until - now : 30 \)\)\n\s+current_sha="\$\(branch_tip\)"/,
    'every wait is followed by a fresh read of the branch tip');
  assert.match(release, /^    permissions:\n(?:      #.*\n)*      actions: read$/m,
    'the release age is read from this workflow\'s own runs');
  for (const step of ['Log in to GHCR for Helm', 'Publish OCI Helm release', 'Record atomic release']) {
    assert.match(release, new RegExp(`- name: ${step}\\n        if: steps\\.current_head\\.outputs\\.publish == 'true'`));
  }
});

test('Kubernetes workflow asks Argo CD to refresh on publish, and can never fail the release doing so', () => {
  // The step exists to remove Argo's up-to-three-minute reconcile wait from
  // the merge-to-running gap (#2545). Its safety properties matter more than
  // its effect: services/release-watch.js reads this run's conclusion, so a
  // refresh that could fail the run would report a healthy release as
  // stalled. Every guard below is one of those properties.
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  const release = workflow.slice(workflow.indexOf('\n  release:\n'));
  const step = release.slice(release.indexOf('- name: Ask Argo CD to pick up the release now'));
  assert.ok(step.length > 0, 'the release job asks Argo CD to refresh');
  assert.ok(release.indexOf('- name: Publish OCI Helm release') < release.indexOf('- name: Ask Argo CD to pick up the release now'),
    'the refresh follows the push: a refresh before the tag exists re-reads the old registry');

  const body = step.slice(0, step.indexOf('- name: Record atomic release'));
  assert.match(body, /continue-on-error: true/,
    'a failed refresh must not turn a published release red — release-watch would call it a stall');
  assert.match(body, /if: steps\.current_head\.outputs\.publish == 'true' && steps\.chart\.outputs\.release_channel == 'stable' && env\.ARGOCD_REFRESH_TOKEN != ''/,
    'inert until the infra side provisions the token, and only for the releases Argo tracks');
  assert.match(release, /^    env:\n(?:      #.*\n)*      ARGOCD_REFRESH_TOKEN: \$\{\{ secrets\.ARGOCD_REFRESH_TOKEN \}\}/m,
    'the secret is mapped through job env because a step `if:` cannot read `secrets`');
  assert.match(body, /\?refresh=hard/, 'a normal refresh can be served the cached tag list for the 0.1.* range');
  assert.match(body, /--max-time \d+/, 'bounded: the request blocks until Argo has compared');
  assert.match(body, /\/api\/v1\/applications\/\$\{ARGOCD_APPLICATION\}/);
  assert.match(body, /ARGOCD_APPLICATION: social-vibecoding-platform/);
  assert.match(body, /::warning title=Argo CD refresh not confirmed::/,
    'a token that expired or was revoked is visible on the run, not silent');
  assert.doesNotMatch(body, /\/sync\b/, 'the workflow only refreshes; automated sync owns the rollout');
});

test('migration command validates the target database identifier', () => {
  const { databaseName } = require('../scripts/migrate-kubernetes');
  assert.equal(databaseName('postgres://user:pass@db:5432/app_usernode_2d5619'), 'app_usernode_2d5619');
  assert.throws(() => databaseName('postgres://user:pass@db:5432/bad-name'), /Unsafe database name/);
});

test('Kubernetes workloads receive the canonical repository and release revision', () => {
  const migrationJob = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(migrationJob, /name: USERNODE_DOMAIN, value: \{\{ \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: CLI_CANONICAL_ORIGIN, value: \{\{ printf "https:\/\/%s" \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(migrationJob, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(migrationJob, /name: NODE_RPC_URL, value: \{\{ \.Values\.config\.nodeRpcUrl \| quote \}\}/);
  assert.match(migrationJob, /name: NATIVE_SESSION_V2_TESTNET_CHAIN_ID, value: \{\{ \.Values\.config\.nativeSessionV2TestnetChainId \| quote \}\}/);
  assert.match(platform, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(platform, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(platform, /name: NODE_RPC_URL, value: \{\{ \.Values\.config\.nodeRpcUrl \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM, value: \{\{ \.Values\.config\.explorerUpstream \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM_BASE, value: \{\{ \.Values\.config\.explorerUpstreamBase \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_USE_HTTP, value: \{\{ \.Values\.config\.explorerUseHttp \| quote \}\}/);
});

test('Kubernetes chart supplies the canonical native testnet ChainId', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /nativeSessionV2TestnetChainId: "utc1rq8tql3wr5w8u6nvkwepu7dazq89kv2838xwf02xmg2w5vzgly3s6xf63v"/);
});

test('Kubernetes chart preserves both social account-linking credential pairs', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  const readme = read('deploy/helm/social-vibecoding-platform/README.md');
  for (const provider of [
    { value: 'githubLink', env: 'GITHUB_LINK', callback: 'github' },
    { value: 'xLink', env: 'X_LINK', callback: 'x' },
  ]) {
    assert.match(values, new RegExp(`${provider.value}ClientId: ""`));
    assert.match(values, new RegExp(`${provider.value}ClientSecret: ""`));
    assert.match(secret, new RegExp(`${provider.env}_CLIENT_ID: \\{\\{ \\.Values\\.secrets\\.${provider.value}ClientId \\| quote \\}\\}`));
    assert.match(secret, new RegExp(`${provider.env}_CLIENT_SECRET: \\{\\{ \\.Values\\.secrets\\.${provider.value}ClientSecret \\| quote \\}\\}`));
    assert.match(readme, new RegExp(`/api/me/${provider.callback}/callback`));
  }
});

// GitHub suspended the bot account (25 Oct 2026). The GitHub App is the
// platform's only GitHub credential, so the chart requires its two values and
// nothing of the bot's token: an environment can delete that value, and one
// still set is ignored.
test('Kubernetes chart requires the GitHub App and nothing of the retired bot token', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  const helpers = read('deploy/helm/social-vibecoding-platform/templates/_helpers.tpl');
  assert.match(helpers, /\.Values\.secrets\.create \(or \(empty \.Values\.secrets\.githubAppId\) \(empty \.Values\.secrets\.githubPrivateKey\)\) -\}\}/);
  assert.match(helpers, /fail "secrets\.githubAppId and secrets\.githubPrivateKey are required when platform is enabled"/);
  assert.match(secret, /GITHUB_APP_ID: \{\{ \.Values\.secrets\.githubAppId \| quote \}\}/);
  assert.match(secret, /GITHUB_PRIVATE_KEY: \{\{ \.Values\.secrets\.githubPrivateKey \| quote \}\}/);
  assert.doesNotMatch(values, /githubBotToken|GITHUB_BOT_TOKEN/, 'values.yaml');
  // No template reads it either, so a value still set is inert.
  for (const file of fs.readdirSync('deploy/helm/social-vibecoding-platform/templates')) {
    assert.doesNotMatch(read(`deploy/helm/social-vibecoding-platform/templates/${file}`), /githubBotToken|GITHUB_BOT_TOKEN/, file);
  }
});

test('platform node RPC egress is restricted to the configured namespace and Pod labels', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.enabled/);
  assert.match(platformPolicy, /kubernetes\.io\/metadata\.name/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.port/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.enabled/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.port/);
});

test('all explorer consumers honor the explicit internal HTTP transport', () => {
  for (const sourcePath of [
    // #2505: the explorer passthrough moved out of server.js into its own
    // module so it could be bounded and tested. The property this test pins
    // moved with it — it is still exactly one transport decision, in exactly
    // one place, just no longer inline in server.js.
    'src/routes/explorer-proxy.js',
    'src/services/node-status.js',
    'src/services/chain-poller.js',
    'src/services/genesis-accounts.js',
  ]) {
    assert.match(read(sourcePath), /process\.env\.EXPLORER_USE_HTTP === 'true'/, sourcePath);
  }
});

test('/api/version uses the canonical configured platform repository', () => {
  const server = read('server.js');
  assert.match(server, /repoUrl: config\.platformRepoUrl/);
  assert.doesNotMatch(server, /repoUrl: process\.env\.USERNODE_REPO_URL/);
});

test('PostgreSQL claim template uses only release-stable labels', () => {
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const claimTemplate = postgresql.split('volumeClaimTemplates:')[1];
  assert.ok(claimTemplate, 'volumeClaimTemplates exists');
  assert.match(claimTemplate, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(claimTemplate, /social-vibecoding-platform\.labels/);
});

test('database URLs use the configured embedded or external PostgreSQL endpoint', () => {
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  const helpers = read('deploy/helm/social-vibecoding-platform/templates/_helpers.tpl');
  assert.match(secret, /social-vibecoding-platform\.postgresqlHost/);
  assert.match(secret, /\.Values\.postgresql\.port/);
  assert.match(helpers, /postgresql\.host is required when postgresql\.enabled=false/);
  assert.match(helpers, /-postgresql\.%s\.svc\.%s/);
});

test('platform, migration, and embedded PostgreSQL have independent activation gates', () => {
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  const migration = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const ingress = read('deploy/helm/social-vibecoding-platform/templates/ingress.yaml');
  assert.match(platform, /and \.Values\.enabled \.Values\.platform\.enabled/);
  assert.match(migration, /and \.Values\.enabled \.Values\.migration\.enabled/);
  assert.match(postgresql, /and \.Values\.enabled \.Values\.postgresql\.enabled/);
  assert.match(ingress, /\.Values\.platform\.enabled \.Values\.ingress\.enabled/);
});

test('chart default deny selects only chart-owned workloads', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const defaultDeny = policy.split('kind: NetworkPolicy')[1].split('---')[0];
  assert.match(defaultDeny, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(defaultDeny, /podSelector: \{\}/);
  assert.match(policy, /social-vibecoding-platform\.postgresqlPodSelector/);
});

test('PostgreSQL ingress permits only runtime-managed generated app pods', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const postgresqlPolicy = policy.split('kind: NetworkPolicy')[4].split('---')[0];
  assert.match(postgresqlPolicy, /databaseCallerNamespaces/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/managed-by: social-vibecoding-runtime/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/part-of: social-vibecoding/);
  assert.match(postgresqlPolicy, /port: \{\{ \.Values\.postgresql\.port \}\}/);
});

test('public platform ingress is restricted to the Cilium ingress identity', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /internalCallerNamespaces/);
  assert.doesNotMatch(platformPolicy, /ingress:\s*\n\s*- ports:/);
  assert.match(policy, /fromEntities: \[ingress\]/);
  assert.match(policy, /\{port: "3000", protocol: TCP\}/);
});

test('Kubernetes status inventory does not invoke Docker helpers', async () => {
  const status = require('../src/services/status');
  assert.deepEqual(await status.listContainers({ appRuntime: 'kubernetes' }), []);
  assert.deepEqual(await status.getStats({ appRuntime: 'kubernetes' }), {});
});
