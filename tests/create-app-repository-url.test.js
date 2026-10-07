// #1604: the import field should supply HTTPS for a bare GitHub repository
// address, just as the waitlist URL field does. The field was the create
// dialog's; it is the make screen's import form now
// (frontend/src/features/first-session/import-repo.tsx).
//
// Run with: node --test tests/create-app-repository-url.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const IMPORT_FORM = path.join(ROOT, 'frontend/src/features/first-session/import-repo.tsx');
const github = require('../src/services/github');

test('client repository URL normalizer adds HTTPS only when appropriate', () => {
  const { normalizeRepositoryUrl } = loadTsx(
    'frontend/src/features/dialogs/repository-url.ts'
  );

  assert.equal(
    normalizeRepositoryUrl(' github.com/owner/repo '),
    'https://github.com/owner/repo'
  );
  assert.equal(
    normalizeRepositoryUrl('www.github.com/owner/repo'),
    'https://www.github.com/owner/repo'
  );
  assert.equal(
    normalizeRepositoryUrl('https://github.com/owner/repo'),
    'https://github.com/owner/repo'
  );
  assert.equal(
    normalizeRepositoryUrl('http://github.com/owner/repo'),
    'http://github.com/owner/repo'
  );
  assert.equal(
    normalizeRepositoryUrl('git@github.com:owner/repo.git'),
    'git@github.com:owner/repo.git'
  );
  assert.equal(
    normalizeRepositoryUrl('ftp://github.com/owner/repo'),
    'ftp://github.com/owner/repo'
  );
  assert.equal(normalizeRepositoryUrl('   '), '');
});

test('import field normalizes on blur, Check, and submit before native URL validation', () => {
  const source = fs.readFileSync(IMPORT_FORM, 'utf8');
  const input = source.match(/<input\s+[\s\S]*?id="make-import-url"[\s\S]*?\/>/)?.[0];
  assert.ok(input, '#make-import-url is rendered');
  assert.match(input, /type="text"/);
  assert.match(input, /inputMode="url"/);
  assert.doesNotMatch(input, /type="url"/,
    'native URL validation must not run before React can normalize the value');
  assert.match(input, /onBlur=\{\(\) => setUrl\(\(typed\) => normalizeRepositoryUrl\(typed\)\)\}/,
    'leaving the field visibly canonicalizes it');

  assert.match(source, /const check = useCallback\(async \(\) => \{\s*const normalized = normalizeRepositoryUrl\(url\);/,
    'Check sends the normalized URL even when blur did not run');
  assert.match(source, /submit\(\{ repoUrl: normalizeRepositoryUrl\(url\),/, 'submit uses the same normalized value');
});

test('server parser accepts scheme-less GitHub URLs and preserves existing forms', () => {
  const expected = { owner: 'owner', repo: 'repo' };
  for (const value of [
    'github.com/owner/repo',
    'www.github.com/owner/repo',
    'https://github.com/owner/repo',
    'http://github.com/owner/repo/',
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
  ]) {
    assert.deepEqual(github.parseGithubUrl(value), expected, value);
  }
});

test('server parser still rejects unsupported schemes, hosts, and malformed paths', () => {
  for (const value of [
    'ftp://github.com/owner/repo',
    'javascript:github.com/owner/repo',
    'example.com/owner/repo',
    'github.com/owner',
    'github.com/owner/repo?tab=readme',
  ]) {
    assert.equal(github.parseGithubUrl(value), null, value);
  }
});
