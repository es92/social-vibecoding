// The validation ladder of POST /api/apps/:slug/secret-declaration-pr
// (src/routes/apps.js) — the panel's "+ New variable" endpoint.
//
// The route needs a live pool, a live express request and a governance
// gate to run, so this is text-pinning like its siblings
// (tests/admins-pr-route.test.js, tests/platform-env-vote.test.js). What's
// pinned is the set of refusals that carry weight, in the order that makes
// them meaningful:
//
//   1. A KEY THE DEPLOY OWNS IS REFUSED, with the SAME message the direct
//      write and the vote path use — a form that could declare
//      JWT_SECRET as a writable tunable would be a privilege-escalation
//      path, not a feature.
//   2. COLLISIONS ARE REFUSED against all three places a key can already
//      live: the manifest snapshot, the value store, and another live
//      proposal. Two entries for one key is a broken manifest.
//   3. A REQUIRED VARIABLE CAN'T LAND UNSATISFIABLE — value or default,
//      and for a private child-app secret a staging fallback too, or the
//      proposal's own preview can't boot.
//   4. THE VALUE IS WRITTEN IMMEDIATELY ONLY FOR A FULL ADMIN. Everyone
//      else's waits for the vote in pending_secret_declarations.
//   5. THE VALUE NEVER REACHES A LOG LINE.
//
// Run with: node --test tests/secret-declaration-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appsJs = fs.readFileSync(path.join(root, 'src/routes/apps.js'), 'utf8');

// The route handler, sliced out by its opening line.
const route = (() => {
  const start = appsJs.indexOf("router.post('/api/apps/:slug/secret-declaration-pr'");
  assert.notStrictEqual(start, -1, 'secret-declaration-pr route not found');
  const end = appsJs.indexOf("  // Trigger a fresh `rebuildProduction`", start);
  assert.notStrictEqual(end, -1, 'end of the declaration route not found');
  return appsJs.slice(start, end);
})();

test('access is the panel gate — collab, plus the self-app public-voting rule', () => {
  assert.match(route, /checkAppAccess\(pool, app, req\.user, 'collab'\)/);
  assert.match(route, /app\.self_hosted && !req\.user\?\.isAdmin && !config\.selfAppPublicVoting/,
    'the self-app gate mirrors GET /secrets exactly');
  assert.ok(!/canManageApp\(/.test(route),
    'deliberately NOT the visibility/admins authority level — proposing an env var is collab-level');
});

test('the scope follows self_hosted, so the platform never gets a `secrets` tunable', () => {
  assert.match(route, /const scope = app\.self_hosted \? 'platform' : 'app'/);
});

test('a deploy-owned key is refused with the shared UNWRITABLE_MESSAGE', () => {
  assert.match(route, /platformEnv\.isWritableKey\(key\)/);
  assert.match(route, /res\.status\(400\)\.json\(\{ error: UNWRITABLE_MESSAGE \}\)/,
    'same wording as the direct write and the vote path — they must not disagree');
  // And a child app still gets the reserved-key rules it always had.
  assert.match(route, /appManifest\.RESERVED_KEYS\.has\(key\)/);
  assert.match(route, /appManifest\.RESERVED_KEY_PREFIXES\.some\(\(p\) => key\.startsWith\(p\)\)/);
  assert.match(route, /appManifest\.KEY_RE\.test\(key\)/);
});

test('collisions are checked against manifest, store and live proposals', () => {
  assert.match(route, /manifest\.platform_env \|\| \[\]\)\.find\(\(s\) => s\.key === key\)/);
  assert.match(route, /manifest\.secrets \|\| \[\]\)\.find\(\(s\) => s\.key === key\)/);
  assert.match(route, /documentedAsDeployOwned/,
    "a key in the platform's `secrets` block already renders a read-only row");
  assert.match(route, /FROM platform_env_values WHERE app_id = \$1 AND key = \$2/);
  assert.match(route, /FROM app_secrets WHERE app_id = \$1 AND key = \$2/);
  assert.match(route, /pendingSecrets\.findLiveByKey\(pool, app\.id, key\)/);
  assert.match(route, /is already waiting for approval/);
  assert.match(route, /res\.status\(409\)/, 'a collision is a conflict, not a validation error');
});

test('field bounds mirror the manifest readers so nothing is silently trimmed', () => {
  assert.match(route, /MAX_DECL_DESC_LEN/);
  assert.match(route, /MAX_DECL_DEFAULT_LEN/);
  assert.match(route, /MAX_DECL_GROUP_LEN/);
  assert.match(route, /appManifest\.MAX_PLATFORM_ENV/);
  // The declared bounds equal the reader's own caps.
  assert.match(appsJs, /const MAX_DECL_DESC_LEN = 400;/);
  assert.match(appsJs, /const MAX_DECL_DEFAULT_LEN = 2048;/);
  assert.match(appsJs, /const MAX_DECL_GROUP_LEN = 48;/);
  assert.match(appsJs, /const MAX_DECLARED_VALUE_LENGTH = 4096;/);
});

test('a required variable must be satisfiable, and a private one previewable', () => {
  assert.match(route, /required && !value\.length && !defaultValue/);
  assert.match(route, /A required variable needs either a value or a default\./);
  assert.match(route, /scope === 'app' && required && isPrivate && !stagingDefault && !defaultValue/);
  assert.match(route, /won't boot without a staging default/,
    'otherwise buildAndDeployStaging throws PrivateSecretMissingStagingDefaultError on this very proposal');
});

test("a platform value is checked for .env representability at the boundary", () => {
  assert.match(route, /scope === 'platform' && value\.length/);
  assert.match(route, /platformEnv\.validateValue\(value\)/,
    'a single quote or CR must be refused now, not silently dropped by a deploy days later');
});

test('the value is trimmed before any rule looks at it', () => {
  // Surrounding whitespace on a pasted value is invisible in the panel and
  // would otherwise survive into the stored value (and into /opt/usernode/.env
  // for a platform variable, since the line is single-quoted). Normalizing
  // here — not just in the DAO — is what makes every rule below agree with
  // what is actually stored: the length cap, "a required variable needs a
  // value", and .env representability all see the trimmed string.
  assert.match(route, /platformEnv\.normalizeValue\(/);
  const norm = route.indexOf('platformEnv.normalizeValue(');
  assert.ok(norm > 0 && norm < route.indexOf('value.length > MAX_DECLARED_VALUE_LENGTH'),
    'normalize before the length cap');
  assert.ok(norm < route.indexOf('required && !value.length && !defaultValue'),
    'a value of only spaces must not satisfy "a required variable needs a value"');
  assert.ok(norm < route.indexOf('platformEnv.validateValue(value)'),
    'representability is checked on the value that will actually be stored');
});

test('GitHub preconditions match the other manifest-PR routes', () => {
  assert.match(route, /!github\.isEnabled\(\) \|\| !process\.env\.GITHUB_BOT_TOKEN/);
  assert.match(route, /res\.status\(503\)/);
  assert.match(route, /App has no GitHub repository to open a PR against/);
  assert.match(route, /Could not parse the app repository URL/);
});

test('the PR is opened BEFORE any value is written', () => {
  const prAt = route.indexOf('createSecretDeclarationPR');
  const applyAt = route.indexOf('const applyNow');
  assert.ok(prAt > 0 && applyAt > prAt,
    'a failed proposal must not leave a value behind, so the PR comes first');
});

test('only a full admin\'s value is written immediately; everyone else\'s waits', () => {
  assert.match(route, /const applyNow = !!req\.user\?\.canAdminWrite && !!value\.length/);
  // The platform write takes the same advisory lock inside a transaction
  // the direct route uses, so two admins serialize instead of interleaving.
  assert.match(route, /pg_advisory_xact_lock\(\$1\)', \[ADMIN_MUTATION_LOCK\]/);
  assert.match(route, /platformEnv\.setValue\(client, app\.id, key, value, \{[\s\S]*?privateHint: isPrivate/);
  assert.match(route, /appSecrets\.setValue\(pool, app\.id, key, value, \{[\s\S]*?sensitive: isPrivate/);
  // And the pending row is always created — it is what makes the panel
  // show "up for vote" / "value set, declaration up for vote".
  assert.match(route, /pendingSecrets\.create\(pool, \{/);
  assert.match(route, /valueApplied: applyNow/);
});

test('an admin-direct platform write is recorded as a platform-env change', () => {
  assert.match(route, /EVENT_TYPES\.PLATFORM_ENV_CHANGED/);
  assert.match(route, /appliedBy: 'admin-direct'/);
});

test('nothing logs the value', () => {
  const logCall = route.slice(route.indexOf("log.info('apps', 'Secret declaration proposed'"));
  assert.match(logCall, /hasValue: !!value\.length/, 'presence, not content');
  assert.ok(!/value,\s*$/m.test(logCall.split('});')[0]),
    'the value itself is never a log field');
  const errLog = route.slice(route.indexOf("log.error('apps', 'Secret declaration PR failed'"));
  assert.ok(!errLog.includes('value'), 'nor on the error path');
});

test('the view merges pending declarations and exposes canDeclare', () => {
  // The panel needs both to render: a proposed key has no row in either
  // store, and the add button needs the real reason when it is unusable.
  assert.match(appsJs, /view = await mergePendingDeclarations\(view, app\)/);
  assert.match(appsJs, /canDeclare: declare\.canDeclare/);
  assert.match(appsJs, /declareDisabledReason: declare\.reason/);
  const merge = appsJs.slice(
    appsJs.indexOf('async function mergePendingDeclarations('),
    appsJs.indexOf('// Can this user open a declaration proposal')
  );
  assert.match(merge, /state: 'proposed'/);
  assert.match(merge, /value: null/, 'a proposed row never carries plaintext');
  assert.match(merge, /pending: pointer/);
});
