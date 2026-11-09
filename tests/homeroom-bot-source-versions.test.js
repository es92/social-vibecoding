'use strict';

// #6533: a change's own code is read at its starting point and its newest
// version, under the same rules reading main keeps.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function fixture({ collab = 'public', collabAllowed = true, session = null, changed = [] } = {}) {
  const app = {
    id: 7, slug: 'mail-app', name: 'Mail app', repo_url: 'https://github.com/Usernode-Labs/mail-app',
    collab_visibility: collab, view_visibility: 'public',
  };
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (/FROM apps/.test(text)) return { rows: [app] };
      if (/FROM chat_sessions/.test(text)) return { rows: session ? [session] : [] };
      return { rows: [] };
    },
  };
  const reads = [];
  const github = {
    async listRepoFiles(owner, repo, ref) { reads.push(['tree', ref]); return { files: [{ path: 'src/mail/track.js', size: 9 }, { path: '.env', size: 5 }], truncated: false }; },
    async getFileContent(owner, repo, p) { reads.push(['file', p]); return p === 'src/mail/track.js' ? 'const x = 1;' : null; },
    async listChangedFiles(owner, repo, basehead) { reads.push(['changed', basehead]); return changed; },
  };
  const user = collabAllowed ? { id: 5, username: 'snait' } : { id: 6, username: 'other' };
  return { pool, deps: { github }, reads, user, app };
}

test('reading at a change\'s two versions passes its base and head, and keeps the secrets rule', async () => {
  const f = fixture();
  const listed = await mayor.listSource(f.pool, { user: f.user, project: 'mail-app', ref: BASE, at: 'today', deps: f.deps });
  assert.equal(listed.at, 'today');
  assert.equal(listed.branch, undefined, 'a change\'s answer does not say main');
  assert.deepEqual(f.reads.at(-1), ['tree', BASE]);
  const read = await mayor.readSource(f.pool, { user: f.user, project: 'mail-app', path: 'src/mail/track.js', ref: HEAD, at: 'with_change', deps: f.deps });
  assert.equal(read.at, 'with_change');
  assert.match(read.text, /1: const x = 1;/);

  const before = f.reads.length;
  const refused = await mayor.readSource(f.pool, { user: f.user, project: 'mail-app', path: '.env', ref: HEAD, at: 'with_change', deps: f.deps });
  assert.match(refused.error, /holds secrets/);
  assert.equal(f.reads.length, before, 'a secrets file is never fetched, at any version');
});

test('a reader who may not build on the project is refused at a change\'s versions too', async () => {
  const f = fixture({ collab: 'collaborators' });
  const out = await mayor.listSource(f.pool, { user: f.user, project: 'mail-app', ref: BASE, at: 'today', deps: f.deps });
  assert.match(out.error, /No such project/);
  assert.equal(f.reads.length, 0);
});

test('the files a change alters drop secrets, and a change with no head cannot be read', async () => {
  const session = { id: 77, app_id: 7, pr_number: 6508, handoff_base_sha: BASE, head_sha: HEAD };
  const f = fixture({ session, changed: ['src/mail/track.js', '.env', 'certs/server.pem'] });
  const out = await mayor.listChangeFiles(f.pool, { user: f.user, project: 'mail-app', change: { id: 77 }, deps: f.deps });
  assert.deepEqual(out.files, ['src/mail/track.js']);
  assert.deepEqual(f.reads.at(-1), ['changed', `${BASE}...${HEAD}`]);

  const none = fixture({ session: { ...session, head_sha: null } });
  const noHead = await mayor.listChangeFiles(none.pool, { user: none.user, project: 'mail-app', change: { id: 77 }, deps: none.deps });
  assert.match(noHead.error, /cannot be read yet/);
  // A change that is not on this app is refused.
  const other = await mayor.changeRefs(none.pool, 77, 999);
  assert.match(other.error, /cannot be read yet/);
});
