// Tests for per-user global agent instruction & skill files (#460).
//
// Two layers, mirroring the repo's test conventions:
//   1. Unit tests for the pure helpers in services/user-agent-files.js —
//      name normalization, content validation, skill frontmatter
//      synthesis, the generated ~/.claude/CLAUDE.md, the docker-exec
//      sync script, the Mayor metadata block, and the per-kind cap
//      (exercised through upsertFile against a scripted fake pool).
//   2. Source guards — the feature spans schema, server.js mounting, the
//      dispatch-time sync in sessions.js, the worker export, and the
//      Settings UI. Each guard pins the contract so a refactor can't
//      silently drop a link in the chain.
//
// Run with: node --test tests/user-agent-files.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const uaf = require('../src/services/user-agent-files.js');
const { shellMarkup } = require('./lib/shell-markup');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── normalizeName ────────────────────────────────────────────────────

test('normalizeName: slugifies a typical uploaded filename', () => {
  assert.equal(uaf.normalizeName('My Code Style.md'), 'my-code-style');
});

test('normalizeName: strips .txt extension and underscores/dots', () => {
  assert.equal(uaf.normalizeName('ui_prefs.v2.txt'), 'ui-prefs-v2');
});

test('normalizeName: collapses dash runs and trims edge dashes', () => {
  assert.equal(uaf.normalizeName('--weird -- name--'), 'weird-name');
});

test('normalizeName: returns null when nothing usable survives', () => {
  assert.equal(uaf.normalizeName('!!!.md'), null);
  assert.equal(uaf.normalizeName(''), null);
  assert.equal(uaf.normalizeName(undefined), null);
});

test('normalizeName: caps at 64 chars and stays regex-valid', () => {
  const out = uaf.normalizeName('a'.repeat(200));
  assert.equal(out.length, 64);
  assert.match(out, uaf.NAME_RE);
});

// ── validateContent ──────────────────────────────────────────────────

test('validateContent: accepts normal markdown and reports UTF-8 bytes', () => {
  const r = uaf.validateContent('# héllo\n');
  assert.equal(r.ok, true);
  assert.equal(r.sizeBytes, Buffer.byteLength('# héllo\n', 'utf8'));
});

test('validateContent: rejects empty / non-string content', () => {
  assert.equal(uaf.validateContent('').ok, false);
  assert.equal(uaf.validateContent('   ').ok, false);
  assert.equal(uaf.validateContent(null).ok, false);
  assert.equal(uaf.validateContent(42).ok, false);
});

test('validateContent: rejects NUL bytes (binary sniff)', () => {
  assert.equal(uaf.validateContent('abc\u0000def').ok, false);
});

test('validateContent: enforces the 48 KB cap in bytes, not chars', () => {
  assert.equal(uaf.validateContent('x'.repeat(uaf.MAX_FILE_BYTES)).ok, true);
  assert.equal(uaf.validateContent('x'.repeat(uaf.MAX_FILE_BYTES + 1)).ok, false);
  // 3-byte chars: 20k chars = 60KB > cap even though char count is small.
  assert.equal(uaf.validateContent('€'.repeat(20000)).ok, false);
});

// ── ensureSkillFrontmatter / skillDescription ────────────────────────

test('ensureSkillFrontmatter: passes through existing frontmatter untouched', () => {
  const src = '---\nname: my-skill\ndescription: does things\n---\n\nBody here.\n';
  assert.equal(uaf.ensureSkillFrontmatter(src, 'other-slug', 'other desc'), src);
});

test('ensureSkillFrontmatter: synthesizes frontmatter with slug + description', () => {
  const out = uaf.ensureSkillFrontmatter('Do the thing.\n', 'thing-doer', 'Does the thing');
  assert.ok(out.startsWith('---\n'));
  assert.match(out, /name: 'thing-doer'/);
  assert.match(out, /description: 'Does the thing'/);
  assert.ok(out.endsWith('Do the thing.\n'));
});

test('ensureSkillFrontmatter: falls back to the first content line', () => {
  const out = uaf.ensureSkillFrontmatter('# Reviews SQL migrations\n\nsteps...', 'sql-reviewer', '');
  assert.match(out, /description: 'Reviews SQL migrations'/);
});

test('skillDescription: submitted wins, then frontmatter, then first line', () => {
  const fm = '---\nname: x\ndescription: from frontmatter\n---\nbody';
  assert.equal(uaf.skillDescription(fm, ' submitted '), 'submitted');
  assert.equal(uaf.skillDescription(fm, ''), 'from frontmatter');
  assert.equal(uaf.skillDescription('# First line\nrest', ''), 'First line');
});

// ── buildUserClaudeMd ────────────────────────────────────────────────

test('buildUserClaudeMd: empty string when there are no instruction files', () => {
  assert.equal(uaf.buildUserClaudeMd([]), '');
  assert.equal(uaf.buildUserClaudeMd([{ kind: 'skill', name: 's', content: 'x' }]), '');
});

test('buildUserClaudeMd: managed header + one section per instruction, skills excluded', () => {
  const out = uaf.buildUserClaudeMd([
    { kind: 'instruction', name: 'code-style', content: 'Use cents.\n' },
    { kind: 'skill', name: 'not-me', content: 'skill body' },
    { kind: 'instruction', name: 'ui-prefs', content: 'Dark mode first.' },
  ]);
  assert.match(out, /Managed by Homeroom/);
  assert.match(out, /## code-style/);
  assert.match(out, /Use cents\./);
  assert.match(out, /## ui-prefs/);
  assert.ok(!out.includes('not-me'));
  assert.match(out, /platform\nconventions \(which always win\)/);
});

// ── buildSyncShellScript ─────────────────────────────────────────────

test('buildSyncShellScript: always wipes both managed paths, even with no files', () => {
  const script = uaf.buildSyncShellScript([]);
  assert.match(script, /rm -f \/home\/node\/\.claude\/CLAUDE\.md/);
  assert.match(script, /rm -rf \/home\/node\/\.claude\/skills/);
  assert.ok(!script.includes('base64 -d'));
});

test('buildSyncShellScript: base64 payload round-trips the generated CLAUDE.md', () => {
  const files = [{ kind: 'instruction', name: 'code-style', content: "Quotes ' and $vars and `ticks`" }];
  const script = uaf.buildSyncShellScript(files);
  const m = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/home\/node\/\.claude\/CLAUDE\.md/);
  assert.ok(m, 'expected a base64 write of CLAUDE.md');
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.equal(decoded, uaf.buildUserClaudeMd(files));
  assert.ok(decoded.includes("Quotes ' and $vars and `ticks`"));
});

test('buildSyncShellScript: writes each skill to its own SKILL.md and skips bad slugs', () => {
  const script = uaf.buildSyncShellScript([
    { kind: 'skill', name: 'changelog-writer', description: 'writes logs', content: 'body' },
    { kind: 'skill', name: '../escape', description: '', content: 'evil' },
  ]);
  assert.match(script, /mkdir -p \/home\/node\/\.claude\/skills\/changelog-writer/);
  assert.match(script, /> \/home\/node\/\.claude\/skills\/changelog-writer\/SKILL\.md/);
  assert.ok(!script.includes('escape'), 'invalid slug must not reach the script');
});

// ── buildMayorAgentFilesBlock ────────────────────────────────────────

test('buildMayorAgentFilesBlock: empty for no files, lists metadata otherwise', () => {
  assert.equal(uaf.buildMayorAgentFilesBlock([]), '');
  const block = uaf.buildMayorAgentFilesBlock([
    { kind: 'instruction', name: 'code-style', description: '' },
    { kind: 'skill', name: 'changelog-writer', description: 'writes logs' },
  ]);
  assert.match(block, /USER'S PERSONAL AGENT FILES/);
  assert.match(block, /- \[instruction\] code-style/);
  assert.match(block, /- \[skill\] changelog-writer — writes logs/);
});

// ── upsertFile per-kind cap (scripted fake pool) ─────────────────────

function fakePool(responses) {
  let i = 0;
  return {
    query: async () => {
      if (i >= responses.length) throw new Error('unexpected extra query');
      return responses[i++];
    },
  };
}

test('upsertFile: throws kind_cap when a NEW name would exceed the cap', async () => {
  const pool = fakePool([
    { rows: [] },                                   // existence check: not found
    { rows: [{ n: uaf.MAX_FILES_PER_KIND }] },      // count at cap
  ]);
  await assert.rejects(
    uaf.upsertFile(pool, 1, { kind: 'instruction', name: 'new-one', description: '', content: 'x', sizeBytes: 1 }),
    (err) => err.code === 'kind_cap'
  );
});

test('upsertFile: updating an EXISTING name never counts against the cap', async () => {
  const saved = { kind: 'instruction', name: 'old-one', description: '', size_bytes: 1, updated_at: 'now' };
  const pool = fakePool([
    { rows: [{ 1: 1 }] },   // existence check: found → no count query
    { rows: [saved] },      // upsert RETURNING
  ]);
  const out = await uaf.upsertFile(pool, 1, { kind: 'instruction', name: 'old-one', description: '', content: 'x', sizeBytes: 1 });
  assert.equal(out, saved);
});

// ── Source guards ────────────────────────────────────────────────────

test('schema: user_agent_files exists, is staging:private, and is unique per (user, kind, name)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_agent_files/);
  assert.match(schema, /COMMENT ON TABLE user_agent_files IS 'staging:private'/);
  assert.match(schema, /UNIQUE \(user_id, kind, name\)/);
});

test('server.js mounts the /api/me/agent-files router', () => {
  const src = read('server.js');
  assert.match(src, /require\('\.\/src\/routes\/user-agent-files'\)/);
  assert.match(src, /app\.use\(userAgentFilesRoutes\(config\)\)/);
});

test('server.js global 100kb parser skips the upload POST (scoped 256kb parser owns it)', () => {
  const src = read('server.js');
  assert.match(src, /req\.path === '\/api\/me\/agent-files' && req\.method === 'POST'\) return next\(\)/);
});

test('sessions.js syncs personal files on both build and scout dispatch', () => {
  const src = read('src/routes/sessions.js');
  const calls = src.match(/worker\.syncUserAgentFiles\(session\.id, personalFiles\)/g) || [];
  assert.ok(calls.length >= 2, `expected build + scout sync calls, found ${calls.length}`);
  assert.match(src, /loadAllForUser\(pool, session\.user_id\)/);
  assert.match(src, /buildMayorAgentFilesBlock/);
});

test('worker.js exports syncUserAgentFiles and pipes the script via stdin', () => {
  const src = read('src/services/worker.js');
  assert.match(src, /async function syncUserAgentFiles\(/);
  assert.match(src, /syncUserAgentFiles,/);
  // Since the prompt-file transport (E2BIG fix) the stdin plumbing lives
  // in docker.execShellStdin, shared with writeTurnPrompt.
  assert.match(src, /docker\.execShellStdin\(meta\.containerName, buildSyncShellScript\(files \|\| \[\]\)/);
  const dockerSrc = read('src/services/docker.js');
  assert.match(dockerSrc, /\['exec', '-i', containerName, 'sh'\]/);
});

test('routes: demo mode is staging-gated and the POST uses a scoped body parser', () => {
  const src = read('src/routes/user-agent-files.js');
  assert.match(src, /req\.query\.demo === '1' && process\.env\.USERNODE_ENV === 'staging'/);
  assert.match(src, /express\.json\(\{ limit: '256kb' \}\)/);
  // Own bucket since the #522 follow-up — file saves must not draw from
  // the issues/proposals allowance.
  assert.match(src, /agentFileWriteLimiter/);
});

test('Settings UI: section markup + renderer are wired', () => {
  const html = shellMarkup();
  assert.match(html, /id="agent-files-section"/);
  assert.match(html, /id="agent-files-instructions-list"/);
  assert.match(html, /id="agent-files-skills-list"/);
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /_renderAgentFilesSection\(\)/);
  assert.match(js, /\/api\/me\/agent-files/);
});
