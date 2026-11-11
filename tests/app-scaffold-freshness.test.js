'use strict';

// The checkout freshness check that every scaffolded app repo carries: the
// app-side counterpart of the platform repository's own session-start check
// (#3102, tests/upstream-drift-hook.test.js).
//
// A coding agent opened on a stale fork of an app reads and edits old code
// without being told. The scaffold now ships a Claude Code SessionStart hook
// (.claude/hooks/homeroom-freshness.sh) that compares HEAD with the app's
// canonical main, which Homeroom names in .claude/homeroom-canonical-repo:
// written on create and import, rewritten on fork so a fork points at itself.
//
// Run with: node --test tests/app-scaffold-freshness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const template = require('../src/services/template');
const prompts = require('../src/services/prompts');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SCRIPT_SOURCE = 'src/templates/app-scaffold/homeroom-freshness.sh';
const SCRIPT = read(SCRIPT_SOURCE);

function scaffoldFile(filePath, files = template.getConnectorScaffoldFiles()) {
  return files.find((f) => f.path === filePath);
}

// ── the script is read-only ─────────────────────────────────────────────

test('the scaffold ships the script file byte for byte', () => {
  assert.equal(scaffoldFile(template.FRESHNESS_HOOK_PATH).content, SCRIPT);
  assert.equal(template.FRESHNESS_HOOK_PATH, '.claude/hooks/homeroom-freshness.sh');
  assert.ok(SCRIPT.startsWith('#!/bin/sh\n'), 'POSIX sh: an imported app need not be a Node app');
});

test('the script only reads git state and prints', () => {
  // This is what the scaffold's one-hook exception rests on
  // (tests/connector-permission-rules.test.js): a committed hook runs on the
  // machine of everyone who opens the repo, so it may only read.
  // Comments and the printed notice (which quotes git commands as advice)
  // are not code that runs.
  const code = SCRIPT.split('\n')
    .filter((line) => !line.trim().startsWith('#') && !line.trim().startsWith('printf '))
    .join('\n');
  const subcommands = [...code.matchAll(/\bgit\s+(?:-C\s+"\$root"\s+)?(?:\\\s*)?(?:-c\s+\S+\s+(?:\\\s*)?)*([a-z-]+)/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(subcommands)].sort(), ['ls-remote', 'merge-base', 'rev-parse']);
  for (const forbidden of ['curl', 'wget', 'rm ', 'mv ', 'eval', 'source ', '. /']) {
    assert.ok(!code.includes(forbidden), `no ${forbidden.trim()}`);
  }
  const redirects = code.match(/\d?>+\s*[^\s|;)]+/g) || [];
  assert.deepEqual([...new Set(redirects)], ['2>/dev/null'], 'writes nothing but stderr to /dev/null');
  assert.match(code, /GIT_TERMINAL_PROMPT=0/, 'never stops to ask for credentials');
  assert.match(code, /SOCIAL_VIBECODING_DRIFT_CHECK:-\}" = off \] && exit 0/, 'hosted workers opt out');
});

// ── the script's behaviour, with real git ───────────────────────────────

function gitRepos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-freshness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (cwd, message) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', message);
  const upstream = path.join(dir, 'upstream');
  const fork = path.join(dir, 'fork');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  commit(upstream, 'one');
  git(dir, 'clone', '-q', upstream, fork);
  fs.mkdirSync(path.join(fork, '.claude'));
  const pointTo = (content) => fs.writeFileSync(path.join(fork, '.claude', 'homeroom-canonical-repo'), content);
  pointTo(`${upstream}\n`);
  return { dir, upstream, fork, git, commit, pointTo };
}

function runHook(projectDir, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv };
  delete env.SOCIAL_VIBECODING_DRIFT_CHECK;
  Object.assign(env, extraEnv);
  const result = spawnSync('sh', [path.join(root, SCRIPT_SOURCE)], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, `always exits 0 (stderr: ${result.stderr})`);
  return result.stdout;
}

test('behind until the fork contains the canonical main, then silent', async (t) => {
  const repos = gitRepos(t);
  repos.commit(repos.upstream, 'two');
  const newest = repos.git(repos.upstream, 'rev-parse', 'HEAD');

  const neverSeen = runHook(repos.fork);
  assert.match(neverSeen, /^Checkout freshness: HEAD [0-9a-f]{12} does not contain the canonical main/);
  assert.ok(neverSeen.includes(`main is at ${newest}`));
  assert.ok(neverSeen.includes(`git fetch ${repos.upstream} main`));
  assert.match(neverSeen, /git show FETCH_HEAD:<path>/);
  assert.match(neverSeen, /prepare_work/);
  assert.match(neverSeen, /never merge or rebase onto the canonical main yourself/);
  assert.match(neverSeen, /\n$/);

  repos.git(repos.fork, 'fetch', '-q', 'origin');
  assert.match(runHook(repos.fork), /does not contain/, 'seen but not contained is still behind');

  repos.git(repos.fork, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal(runHook(repos.fork), '');
  repos.commit(repos.fork, 'local work');
  assert.equal(runHook(repos.fork), '', 'a branch ahead of the canonical main is current');
});

test('silent, and still exit 0, whenever it cannot or should not tell', async (t) => {
  const repos = gitRepos(t);
  repos.commit(repos.upstream, 'two');
  assert.equal(runHook(repos.fork, { SOCIAL_VIBECODING_DRIFT_CHECK: 'off' }), '', 'opted out');
  assert.equal(runHook(repos.dir), '', 'not a git checkout');

  repos.pointTo(`${repos.upstream}; touch pwned\n`);
  assert.equal(runHook(repos.fork), '', 'a pointer outside the URL character set is ignored');
  assert.equal(fs.existsSync(path.join(repos.fork, 'pwned')), false);

  repos.pointTo(`${path.join(repos.dir, 'missing')}\n`);
  assert.equal(runHook(repos.fork), '', 'an unreachable remote is silence, not an error');

  fs.rmSync(path.join(repos.fork, '.claude', 'homeroom-canonical-repo'));
  assert.equal(runHook(repos.fork), '', 'no pointer, no check');

  repos.pointTo(`${repos.upstream}\r\n`);
  assert.match(runHook(repos.fork), /does not contain/, 'a CRLF checkout still reads the pointer');
});

// ── the pointer ─────────────────────────────────────────────────────────

test('the pointer names a GitHub repository in one canonical shape, or nothing', () => {
  assert.equal(template.CANONICAL_REPO_PATH, '.claude/homeroom-canonical-repo');
  for (const input of [
    'https://github.com/usernode-bot/todo-list-b641de',
    'https://github.com/usernode-bot/todo-list-b641de.git',
    'https://github.com/usernode-bot/todo-list-b641de/',
    ' https://github.com/usernode-bot/todo-list-b641de\n',
  ]) {
    assert.deepEqual(template.getCanonicalRepoFile(input), {
      path: '.claude/homeroom-canonical-repo',
      content: 'https://github.com/usernode-bot/todo-list-b641de\n',
    }, JSON.stringify(input));
  }
  for (const input of [null, '', 'file:///tmp/x', 'https://gitlab.com/a/b', 'https://github.com/a',
    'https://github.com/a/b/tree/main', 'https://github.com/a/b c']) {
    assert.equal(template.getCanonicalRepoFile(input), null, JSON.stringify(input));
  }
});

test('a create names its own new repository', () => {
  const withRepo = template.getTemplateFiles('Demo', 'demo', 'postgres://x/y', 'https://github.com/usernode-bot/demo');
  assert.equal(scaffoldFile('.claude/homeroom-canonical-repo', withRepo).content,
    'https://github.com/usernode-bot/demo\n');
  assert.equal(scaffoldFile('.claude/homeroom-canonical-repo',
    template.getTemplateFiles('Demo', 'demo', 'postgres://x/y')), undefined,
  'a local build with no GitHub gets no pointer');

  const creator = read('src/services/app-creator.js');
  // No database URL (#4895): none goes into a repository, and the database
  // is made beside the repository rather than before it.
  assert.match(creator, /const repoUrl = repo\.html_url;[\s\S]{0,400}const files = starterFiles\(row, \{ repoUrl, sketch, category \}\);/,
    'the GitHub create passes the repository it just made');
  assert.match(creator, /return getTemplateFiles\(row\.name, row\.slug, null, repoUrl, \{/);
});

// #4895: the database and the repository are made side by side, which holds
// only while the starter carries no database URL: the repository is public.
test('the starter writes no database URL, so it does not wait for the database', () => {
  const secret = 'postgres://app_demo:hunter2-not-real@db.internal:5432/app_demo';
  const withUrl = template.getTemplateFiles('Demo', 'demo', secret, 'https://github.com/usernode-bot/demo');
  const without = template.getTemplateFiles('Demo', 'demo', null, 'https://github.com/usernode-bot/demo');
  assert.ok(!withUrl.some((f) => f.content.includes('hunter2-not-real')), 'no file carries it');
  assert.deepEqual(withUrl, without, 'the files are the same either way');
});

test('an import adds the pointer with the scaffold', () => {
  const creator = read('src/services/app-creator.js');
  const start = creator.indexOf('async function scaffoldImport(row) {');
  const branch = creator.slice(start, creator.indexOf('\n}\n', start));
  assert.match(branch, /getCanonicalRepoFile\(repoUrl\)/);
  assert.match(branch, /\.\.\.getConnectorScaffoldFiles\(\),\s*\.\.\.\(canonicalRepoFile \? \[canonicalRepoFile\] : \[\]\)/);
});

test('a fork always rewrites the pointer to name itself, before its one commit', () => {
  const forker = read('src/services/app-forker.js');
  const start = forker.indexOf('function writeCanonicalRepoPointer(');
  assert.ok(start > 0);
  const fn = forker.slice(start, forker.indexOf('\n}', start));
  assert.match(fn, /getCanonicalRepoFile\(repoUrl\)/);
  assert.doesNotMatch(fn, /existsSync/, 'overwrites: the copied tree names the parent');
  const repoAt = forker.indexOf('const repoUrl = repo.html_url;');
  const writeAt = forker.indexOf('writeCanonicalRepoPointer(tempDir, repoUrl)');
  const initAt = forker.indexOf("['init', '-q', '-b', 'main']");
  assert.ok(repoAt > 0 && writeAt > repoAt && initAt > writeAt,
    "written once the fork's own URL is known, and before the commit that captures the tree");
});

// ── what the agent reads ────────────────────────────────────────────────

test('the template CLAUDE.md scopes the check to reading too and names the pointer', () => {
  const claude = scaffoldFile('CLAUDE.md', template.getTemplateFiles('Demo', 'demo', 'postgres://x/y')).content;
  assert.match(claude, /^## Check that this checkout is current$/m);
  assert.match(claude, /before you \*\*read\*\* code/);
  assert.match(claude, /git fetch "\$\(cat \.claude\/homeroom-canonical-repo\)" main/);
  assert.match(claude, /git merge-base --is-ancestor FETCH_HEAD HEAD/);
  assert.match(claude, /get_checkout_status/);
  assert.match(claude, /its silence is not proof/);
  assert.doesNotMatch(claude, /github\.com\/usernode-bot/, 'no URL baked into a file a fork copies unchanged');
});

test('the scaffold README explains the hook and how to turn it off', () => {
  const readme = scaffoldFile('.claude/README.md').content;
  assert.match(readme, /^## The session-start freshness check$/m);
  assert.match(readme, /git rev-parse`, `git ls-remote` and `git merge-base/);
  assert.match(readme, /SOCIAL_VIBECODING_DRIFT_CHECK=off/);
  assert.match(readme, /rewrites it when the app is forked/);
});

test('the hosted conventions carry the rule for every app, and let dev-chat skip it', () => {
  const slug = 'outside-dev-chat-check-that-your-checkout-is-current';
  assert.ok(prompts.getConventionSlugs().includes(slug));
  const text = prompts.getConventionSection(slug).content;
  assert.match(text, /Inside Homeroom's\s+dev-chat the platform fixes your base commit; skip this section/);
  assert.match(text, /\.claude\/homeroom-canonical-repo/);
  assert.match(text, /get_checkout_status/);
  assert.match(text, /never merge or rebase onto\s+the canonical `main` yourself/);
});
