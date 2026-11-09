'use strict';

// #6533: what a change looks like, emails included, drawn without running it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { emailPictures, screenPictures, showChange } = require('../src/services/change-pictures');
const { memoryMediaStore } = require('./lib/media-store');

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
// #6541: a commit pushed after the last checked one, with no checks on it.
const NEWER_SHA = 'c'.repeat(40);
const APP = { id: 9, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo' };

const LAYOUTS = "{ layouts: [{ name: 'Standard', html: '<div>{{content}}</div>', text: '{{content}}' }], templates: {";
function seeds(body) { return `const SEEDS = ${LAYOUTS}${body}} };`; }
const RELEASE_BEFORE = "waitlist_released: { layout: 'Standard', subject: 'You\\'re in: welcome to Homeroom', preheader: '', why: '', html: '<p>Welcome</p>', text: 'Welcome' },";
const RELEASE_AFTER = "waitlist_released: { layout: 'Standard', subject: 'You\\'re in: bring your people', preheader: 'Invite up to three friends.', why: '', html: '<p>Bring a friend</p>', text: 'Bring a friend' },";
const REMINDER = "waitlist_reminder: { layout: 'Standard', subject: 'Your invite is still waiting', preheader: '', why: '', html: '<p>Still waiting</p>', text: 'Still waiting' },";
const REMINDER_LAST = "waitlist_reminder_last: { layout: 'Standard', subject: 'Last reminder about your invite', preheader: '', why: '', html: '<p>Last reminder</p>', text: 'Last reminder' },";

const ACTIONS_TEXT = `const ACTIONS = {
  waitlist_released: { label: 'Waitlist release', sample: { url: 'https://app.onhomeroom.com/#release' } },
  waitlist_reminder: { label: 'Waitlist reminder', sample: { url: 'https://app.onhomeroom.com/#invite' } },
  waitlist_reminder_last: { label: 'Last reminder', sample: { url: 'https://app.onhomeroom.com/#invite' } },
};`;

function mediaDeps() {
  const store = memoryMediaStore();
  return {
    store,
    mediaStore: {
      getStore: () => store,
      put: async (_tx, st, data, contentType = 'application/octet-stream') => {
        const key = `media/sha256/${createHash('sha256').update(data).digest('hex')}`;
        await st.putObject(key, data, contentType);
        return key;
      },
      bytes: async (st, row) => {
        const chunks = [];
        for await (const chunk of await st.getObjectStream(row.object_key)) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      },
    },
  };
}

function fakeGithub({ base, head, newer, changed = [] }) {
  const calls = [];
  return {
    calls,
    async getFileContent(owner, repo, filePath, sha) {
      calls.push({ filePath, sha });
      const text = sha === BASE_SHA ? base : sha === NEWER_SHA ? newer : sha === HEAD_SHA ? head : null;
      if (filePath === 'src/db/email-template-seeds.js') return text?.seeds ?? null;
      if (filePath === 'src/services/mail/actions.js') return text?.actions ?? null;
      return null;
    },
    async listChangedFiles(owner, repo, basehead) {
      calls.push({ changed: basehead });
      return changed;
    },
    async pushFiles() { throw new Error('a showing never writes'); },
  };
}

function fakePool({ linkedIssues = [], authorId = 5, newestHead = null, headSha = HEAD_SHA, baseSha = BASE_SHA } = {}) {
  const client = { query: async () => ({ rows: [] }), release() {} };
  return {
    client,
    async query(sql) {
      const text = String(sql);
      if (text.includes('AS head_sha')) {
        return {
          rows: [{
            id: 77, app_id: 9, pr_number: 6508, handoff_base_sha: baseSha,
            newest_head_sha: newestHead, head_sha: headSha, linked_issues: linkedIssues,
          }],
        };
      }
      if (text.includes('FROM change_pictures')) return { rows: [] };
      if (text.includes('SELECT * FROM chat_sessions')) {
        return { rows: [{ id: 77, app_id: 9, user_id: authorId, status: 'promoted', shots_detail: { intent: { version: 1 } } }] };
      }
      if (text.includes('ANY(cs.linked_issues)')) return { rows: [{ id: 77, user_id: authorId, pr_number: 6508, linked_issues: linkedIssues }] };
      if (text.includes('INSERT INTO change_pictures')) return { rows: [] };
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    },
    async connect() { return client; },
  };
}

const CHANGE = { id: 77, app_id: 9, user_id: 5, pr_number: 6508, linked_issues: [], title: 'Get more people in' };

function setup(over = {}) {
  const { github: githubOver, ...rest } = over;
  const github = fakeGithub({
    base: { seeds: seeds(RELEASE_BEFORE), actions: ACTIONS_TEXT },
    head: { seeds: seeds(RELEASE_BEFORE + RELEASE_AFTER + REMINDER + REMINDER_LAST), actions: ACTIONS_TEXT },
    ...githubOver,
  });
  return { github, ...mediaDeps(), ...rest };
}

test('a change that rewords the admit email and adds two reminders shows before and after, and each new one once', async () => {
  const deps = setup();
  const pool = fakePool({ linkedIssues: [6490] });
  const out = await emailPictures(pool, {}, { app: APP, change: { ...CHANGE, linked_issues: [6490] }, deps });
  assert.equal(out.error, undefined);
  const byKind = (kind) => out.images.filter((im) => im.kind === kind).map((im) => ({ side: im.side, isNew: im.isNew }));
  assert.deepEqual(byKind('waitlist_released'), [{ side: 'before', isNew: false }, { side: 'after', isNew: false }]);
  assert.deepEqual(byKind('waitlist_reminder'), [{ side: 'after', isNew: true }]);
  assert.deepEqual(byKind('waitlist_reminder_last'), [{ side: 'after', isNew: true }]);
  assert.ok(out.subjects.includes("You're in: bring your people"));
  assert.ok(out.subjects.includes('Your invite is still waiting'));
  // Each email is drawn with its action's own sample, and nothing is written.
  assert.deepEqual(deps.github.calls.filter((c) => c.sha).map((c) => c.sha).sort(), [BASE_SHA, BASE_SHA, HEAD_SHA, HEAD_SHA].sort());
  assert.equal(deps.github.calls.some((c) => c.pushFiles), false);
});

test('#6541: emails are drawn from the newest pushed commit even when checks last ran on an older one, and each caption names its commit', async () => {
  const deps = setup({
    github: { newer: { seeds: seeds(RELEASE_BEFORE + RELEASE_AFTER + REMINDER + REMINDER_LAST), actions: ACTIONS_TEXT } },
  });
  const out = await emailPictures(fakePool({ newestHead: NEWER_SHA }), {}, { app: APP, change: CHANGE, deps });
  assert.equal(out.error, undefined);
  assert.equal(out.drawnFrom, 'ccccccc');
  assert.equal(out.headSource, 'newest');
  assert.equal(out.base, 'aaaaaaa');
  const shaReads = deps.github.calls.filter((c) => c.sha).map((c) => c.sha);
  assert.equal(shaReads.includes(HEAD_SHA), false, 'the last checked commit is never read');
  assert.deepEqual([...new Set(shaReads)].sort(), [BASE_SHA, NEWER_SHA].sort());
  const after = out.images.filter((im) => im.side === 'after');
  assert.equal(after.length, 3);
  for (const im of after) assert.match(im.caption, /^.+ · ccccccc$/);
  for (const im of out.images.filter((im) => im.side === 'before')) assert.match(im.caption, /^.+ · aaaaaaa$/);
  // New emails are named by their subject, never by the caption's commit code.
  assert.ok(out.subjects.includes("You're in: bring your people"));
});

test('#6541: a newest commit that cannot be read is named, never swapped for the last checked one', async () => {
  const deps = setup();
  const out = await emailPictures(fakePool({ newestHead: NEWER_SHA }), {}, { app: APP, change: CHANGE, deps });
  assert.match(out.error, /newest version of this change \(ccccccc\) could not be read/);
  assert.equal(out.images, undefined);
  assert.equal(deps.github.calls.some((c) => c.sha === HEAD_SHA), false);
});

test('#6541: a change with no recorded newest head draws its last checked version and says so', async () => {
  const deps = setup();
  const out = await emailPictures(fakePool(), {}, { app: APP, change: CHANGE, deps });
  assert.equal(out.error, undefined);
  assert.equal(out.headSource, 'last_checked');
  assert.equal(out.drawnFrom, 'bbbbbbb');
  assert.equal(out.images.length, 4);
  assert.ok(out.images.filter((im) => im.side === 'after').every((im) => / · bbbbbbb$/.test(im.caption)));
});

test('#6541: the show_change reply names the version the pictures were drawn from', async () => {
  const deps = {
    ...setup({
      github: { newer: { seeds: seeds(RELEASE_BEFORE + RELEASE_AFTER + REMINDER + REMINDER_LAST), actions: ACTIONS_TEXT } },
    }),
    shotsView: { async getForSession() { return { state: 'planned', claims: [], artifacts: [] }; } },
  };
  const pool = fakePool({ newestHead: NEWER_SHA });
  const ctx = {
    app: APP, user: { id: 5 }, change: { ...CHANGE, linked_issues: [] }, place: { type: 'session', ref: 77 },
    deps, config: {},
  };
  const out = await showChange(pool, {}, ctx, { what: 'emails' });
  assert.equal(out.ok, true);
  assert.equal(out.drawnFrom, 'ccccccc');
  assert.equal(out.headSource, 'newest');
  assert.match(out.shown, /drawn from ccccccc, the change's newest version/);
  assert.ok(ctx.gallery.images.every((im) => im.source !== 'email' || / · (ccccccc|aaaaaaa)$/.test(im.caption)));
  assert.deepEqual(out.newEmails.sort(), ['Your invite is still waiting', 'Last reminder about your invite'].sort());
});

test('a change built in Claude Code is shown the same way; who built it is no reason not to show it', async () => {
  const deps = setup();
  const pool = fakePool();
  const out = await emailPictures(pool, {}, {
    app: APP, change: { ...CHANGE, external_agent: 'claude-code' }, deps,
  });
  assert.equal(out.images.length, 4);
  assert.equal(out.none, undefined);
});

test('screens: a verified run gives its shots; none says so and only offers to take them to someone who may', async () => {
  const shots = (state) => ({
    async getForSession() {
      return state === 'verified' ? {
        state: 'verified',
        claims: [{ id: 'story-1', claim: 'The invite sheet' }],
        artifacts: [
          { id: '1'.repeat(32), storyId: 'story-1', viewport: 'desktop', side: 'base', variant: 'focus', media: 'png', url: '/api/apps/demo/proposals/77/shots/' + '1'.repeat(32) },
          { id: '2'.repeat(32), storyId: 'story-1', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: '/api/apps/demo/proposals/77/shots/' + '2'.repeat(32) },
        ],
      } : { state: 'planned', claims: [], artifacts: [] };
    },
  });
  const author = await screenPictures(fakePool({ authorId: 5 }), { app: APP, change: CHANGE, viewer: { id: 5 }, deps: { shotsView: shots('verified') } });
  assert.deepEqual(author.images.map((im) => im.side), ['before', 'after']);
  assert.equal(author.images[0].caption, 'The invite sheet');

  const nobody = await screenPictures(fakePool({ authorId: 5 }), {
    app: APP, change: CHANGE, viewer: { id: 8 }, deps: { shotsView: shots('planned'), appAdmins: { canManageApp: async () => false } },
  });
  assert.equal(nobody.none, true);
  assert.equal(nobody.canRun, false, 'a member who is not the author and not an admin may not take them');

  const owner = await screenPictures(fakePool({ authorId: 5 }), { app: APP, change: CHANGE, viewer: { id: 5 }, deps: { shotsView: shots('planned') } });
  assert.equal(owner.canRun, true);
});

test('no request: the pictures stay in the thread and the answer says a plan goes on a request', async () => {
  const deps = { ...setup(), shotsView: { async getForSession() { return { state: 'planned', claims: [], artifacts: [] }; } } };
  const pool = fakePool();
  const ctx = {
    app: APP, user: { id: 5 }, change: { ...CHANGE, linked_issues: [] }, place: { type: 'session', ref: 77 },
    deps, config: {},
  };
  const out = await showChange(pool, {}, ctx, { what: 'emails' });
  assert.equal(out.ok, true);
  assert.equal(out.request, null);
  assert.match(out.note, /plan goes on a request/);
  assert.equal(ctx.gallery.purpose, 'change');
  assert.equal(ctx.gallery.images.length, 4);
  assert.equal(ctx.offer, undefined);
  // #6541: no recorded newest head, so the reply admits it may not be the latest.
  assert.equal(out.headSource, 'last_checked');
  assert.match(out.shown, /drawn from bbbbbbb, the last version checked; a newer push may not be drawn/);
});

test('a request: the offer posts those very pictures as a plan there', async () => {
  const deps = { ...setup(), shotsView: { async getForSession() { return { state: 'planned', claims: [], artifacts: [] }; } } };
  const pool = fakePool({ linkedIssues: [6490] });
  const ctx = {
    app: APP, user: { id: 5 }, change: { ...CHANGE, linked_issues: [6490] }, place: { type: 'session', ref: 77 },
    deps, config: {},
  };
  const out = await showChange(pool, {}, ctx, { what: 'emails' });
  assert.equal(out.request, 6490);
  assert.equal(ctx.offer.kind, 'post_pictures_plan');
  assert.equal(ctx.offer.args.issueNumber, 6490);
  assert.equal(ctx.offer.args.pictures.length, ctx.gallery.images.length);
});
