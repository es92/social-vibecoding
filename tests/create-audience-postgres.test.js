'use strict';

// POST /api/apps with the create screen's choices (communities, stage 3),
// against the REAL schema in a throwaway PostgreSQL database: who the
// project is for, the invites a Group is created with, and the approval rule
// a Group or Community creator picks. The build itself (createApp) is
// stubbed; what is pinned is the rows the route writes and the community
// they make. Skipped when no server is reachable, required when
// TEST_DATABASE_URL is set, like tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('creating a project for someone, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'create_audience_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  // The route and the services it calls read the pool through getPool; the
  // build, the live pushes and analytics are stubbed before the route loads
  // (apps.js destructures createApp at require time).
  require('../src/db/pool').getPool = () => pool;
  const built = [];
  require('../src/services/app-creator').createApp = async (_config, row) => { built.push(row); };
  require('../src/services/ws').pushNotificationToUser = () => {};
  require('../src/services/events').record = async () => {};
  const { appRoutes } = require('../src/routes/apps');

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, app_quota) VALUES
       ('maker', 'x', TRUE, 10), ('Ada', 'x', TRUE, 2), ('grace', 'x', TRUE, 2), ('other', 'x', TRUE, 10),
       ('writer', 'x', TRUE, 10)
     RETURNING id, username`
  );
  const [maker, ada, grace, other, writer] = people;
  // Mutable: the create limiter allows five an hour per user, so the last
  // two subtests create as other people.
  let viewer = { id: maker.id, username: maker.username, isAdmin: false, canAdminWrite: false };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = viewer; next(); });
  app.use(appRoutes({ maxApps: 0 }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = async (body) => {
    const res = await fetch(`${base}/api/apps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const audienceOf = async (appId) => (await pool.query(
    `SELECT ${require('../src/services/communities').audienceSql('a',
      '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')} AS audience
       FROM apps a WHERE a.id = $1`,
    [appId]
  )).rows[0]?.audience;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await t.test('Just me is private, one member, and reads as Just you', async () => {
    const res = await create({ name: 'Diary', audience: 'solo' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const row = res.data.app;
    assert.deepEqual([row.collab_visibility, row.view_visibility], ['private', 'private']);
    assert.equal(await audienceOf(row.id), 'solo');
    assert.equal(row.approver_policy, 'anyone');
    assert.equal(res.data.invited, 0);
  });

  await t.test('A community is open to see and build, and reads as a Community', async () => {
    const res = await create({ name: 'Town square', audience: 'open' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual([res.data.app.collab_visibility, res.data.app.view_visibility], ['public', 'public']);
    assert.equal(await audienceOf(res.data.app.id), 'open');
  });

  await t.test('A group sends its invites at creation, and reads as a Group straight away', async () => {
    const res = await create({ name: 'Book club', audience: 'invited', invitees: ['@ada', 'Grace', 'maker'] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const appId = res.data.app.id;
    assert.equal(res.data.invited, 2, 'the creator is not invited into their own project');
    const { rows } = await pool.query(
      `SELECT user_id, status, invited_by FROM app_collaborators WHERE app_id = $1 ORDER BY user_id`, [appId]);
    assert.deepEqual(rows.map((r) => [r.user_id, r.status]), [
      [maker.id, 'member'], [ada.id, 'invited'], [grace.id, 'invited'],
    ]);
    assert.ok(rows.filter((r) => r.status === 'invited').every((r) => r.invited_by === maker.id));
    assert.equal(await audienceOf(appId), 'invited', 'a pending invite already makes it a Group');
    const notes = await pool.query(
      `SELECT user_id FROM notifications WHERE app_id = $1 AND kind = 'collab_invite' ORDER BY user_id`, [appId]);
    assert.deepEqual(notes.rows.map((r) => r.user_id), [ada.id, grace.id],
      'each invitee gets the same notification Members & approvals sends');
  });

  await t.test('an unknown username refuses the whole create, naming it', async () => {
    const before = Number((await pool.query('SELECT COUNT(*) AS n FROM apps')).rows[0].n);
    const res = await create({ name: 'Typo group', audience: 'invited', invitees: ['ada', 'nobody_here'] });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /@nobody_here/);
    const after = Number((await pool.query('SELECT COUNT(*) AS n FROM apps')).rows[0].n);
    assert.equal(after, before, 'nothing was created');
  });

  await t.test('"People I pick" writes the rule, seeds the creator as approver, and reaches the template', async () => {
    const res = await create({
      name: 'Council', audience: 'open',
      governance: { approvers: 'invited', approvals: { atLeast: 2 } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const appId = res.data.app.id;
    assert.equal(res.data.app.approver_policy, 'invited');
    assert.equal(res.data.app.approvals_required, 2);
    const approvers = await pool.query(`SELECT user_id, status FROM app_approvers WHERE app_id = $1`, [appId]);
    assert.deepEqual(approvers.rows.map((r) => [r.user_id, r.status]), [[maker.id, 'member']]);
    const handed = built.find((row) => row.id === appId);
    assert.equal(handed.approver_policy, 'invited', 'the build receives the governed row, for dapp.json');
    const governance = require('../src/services/governance');
    governance.invalidateGovernance?.(appId);
    const read = await governance.getGovernance(pool, appId);
    assert.equal(read.approverPolicy, 'invited');
    assert.equal(read.approvalsRequired, 2);
  });

  await t.test('"What is it?" seeds the manifest snapshot and reaches the template', async () => {
    viewer = { id: writer.id, username: writer.username, isAdmin: false, canAdminWrite: false };
    const res = await create({ name: 'Seed swap', audience: 'open', description: '  Swap seeds and\n plan the plots.  ' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const { rows } = await pool.query(`SELECT manifest_snapshot FROM apps WHERE id = $1`, [res.data.app.id]);
    assert.deepEqual(rows[0].manifest_snapshot, { description: 'Swap seeds and plan the plots.', secrets: [] });
    const handed = built.find((row) => row.id === res.data.app.id);
    assert.equal(handed.manifest_snapshot.description, 'Swap seeds and plan the plots.',
      'the build receives the described row, for dapp.json');
    const plain = await create({ name: 'Undescribed', audience: 'open' });
    const bare = await pool.query(`SELECT manifest_snapshot FROM apps WHERE id = $1`, [plain.data.app.id]);
    assert.equal(bare.rows[0].manifest_snapshot, null, 'no line, no seeded snapshot');
    const long = await create({ name: 'Too long', audience: 'open', description: 'x'.repeat(101) });
    assert.equal(long.status, 400);
  });

  await t.test('an older client\'s body still works, and a bad choice is a 400 before anything exists', async () => {
    viewer = { id: other.id, username: other.username, isAdmin: false, canAdminWrite: false };
    const legacy = await create({ name: 'Old client', collabVisibility: 'private', viewVisibility: 'public' });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
    assert.deepEqual([legacy.data.app.collab_visibility, legacy.data.app.view_visibility], ['private', 'public']);
    const bad = await create({ name: 'Bad', audience: 'solo', invitees: ['ada'] });
    assert.equal(bad.status, 400);
    const badRule = await create({ name: 'Bad rule', audience: 'open', governance: { approvers: 'everyone' } });
    assert.equal(badRule.status, 400);
  });
});
