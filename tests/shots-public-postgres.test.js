'use strict';
// Which before & after stills somebody who is not signed in may see
// (src/services/shots-public.js), against the full PostgreSQL schema: a
// public project's change up for a vote, shot as the member account on a
// phone, at its current head, and cleared by the shots agent
// (shot_artifacts.public_safe). Anything else shows no picture. Also the
// project page's overview, which carries the pictures' addresses
// (src/services/public-project.js).
//
// Set TEST_DATABASE_URL to require it; without a reachable server it skips.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/shots-public-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const { publicStillsFor, publicStillBytes, publicStillUrl } = require('../src/services/shots-public');
const { loadProjectOverview } = require('../src/services/public-project');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const RUN = () => crypto.randomBytes(16).toString('hex');
const ART = () => crypto.randomBytes(16).toString('hex');

const intentFor = (persona, viewports) => ({
  version: 1, impact: 'ui', rationale: null,
  stories: [{ id: 'c1', claim: 'The card shows the new badge', persona, viewports,
    intent: { startPath: '/', steps: ['Open the home page'], baseState: 'present', animation: 'none' } }],
});
const PHONE = { name: 'phone', width: 390, height: 844 };
const DESKTOP = { name: 'desktop', width: 1280, height: 800 };

test('public before & after stills against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'shots_public_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  let seq = 0;
  async function project({ visibility = 'public', selfHosted = false } = {}) {
    const slug = `pub-app-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility, self_hosted)
       VALUES ($1, $1, $2, 'running', $3, $3, $4) RETURNING id, slug`,
      [slug, owner.id, visibility, selfHosted]);
    return a;
  }
  // A change up for a vote whose current run is verified at its head, with
  // the stills given as [side, variant, viewport, publicSafe].
  async function change(app, { persona = 'member', viewports = [PHONE, DESKTOP], status = 'promoted', head = SHA('a'), runHead = head, stills }) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, reviewed_head_sha, promoted_at, pr_title)
       VALUES ($1, $2, $3, $4, NOW(), 'Add the badge') RETURNING id`,
      [app.id, owner.id, status, head]);
    const run = RUN();
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, plan_hash, hard_verdict, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'verified', $6, '{}'::jsonb, NOW())`,
      [run, s.id, SHA('b'), runHead, JSON.stringify(intentFor(persona, viewports)), SHA('c').padEnd(64, 'c')]);
    await pool.query(`UPDATE chat_sessions SET shots_run_id = $2, shots_state = 'verified' WHERE id = $1`, [s.id, run]);
    const ids = {};
    for (const [side, variant, viewport, safe] of stills) {
      const id = ART();
      ids[`${side}:${variant}:${viewport}`] = id;
      await pool.query(
        `INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, theme, content_type, data,
                                     width, height, bytes, sha256, public_safe)
         VALUES ($1, $2, 'c1', $3, $4, $5, 'png', 'light', 'image/png', '\\x89504e47'::bytea, 390, 844, 4, $6, $7)`,
        [id, run, viewport, side, variant, SHA(side === 'base' ? 'd' : 'e').padEnd(64, '0'), safe]);
    }
    return { id: s.id, ids };
  }
  const BOTH = (safe = true) => [
    ['base', 'context', 'phone', safe], ['head', 'context', 'phone', safe],
    ['base', 'focus', 'phone', safe], ['head', 'focus', 'phone', safe],
    ['base', 'context', 'desktop', true], ['head', 'context', 'desktop', true],
  ];

  const pub = await project();
  const good = await change(pub, { stills: BOTH() });
  const unsafe = await change(pub, { stills: BOTH(null) });
  const asAdmin = await change(pub, { persona: 'read_only_admin', stills: BOTH() });
  const desktopOnly = await change(pub, { viewports: [DESKTOP], stills: [['base', 'context', 'desktop', true], ['head', 'context', 'desktop', true]] });
  const moved = await change(pub, { head: SHA('f'), runHead: SHA('a'), stills: BOTH() });
  const merged = await change(pub, { status: 'merged', stills: BOTH() });
  const contextOnly = await change(pub, { stills: [['base', 'context', 'phone', true], ['head', 'context', 'phone', true], ['head', 'focus', 'phone', true]] });
  const priv = await project({ visibility: 'private' });
  const hidden = await change(priv, { stills: BOTH() });
  const platform = await project({ selfHosted: true });
  const own = await change(platform, { stills: BOTH() });

  const stills = await publicStillsFor(pool, [good, unsafe, asAdmin, desktopOnly, moved, merged, contextOnly, hidden, own].map((c) => c.id));

  await t.test('a member-account phone still the agent cleared, the element shots when both sides have one', () => {
    assert.deepEqual(stills.get(good.id), {
      slug: pub.slug, before: good.ids['base:focus:phone'], after: good.ids['head:focus:phone'],
    });
    // An element shot on one side only: the whole screens instead.
    assert.deepEqual(stills.get(contextOnly.id), {
      slug: pub.slug, before: contextOnly.ids['base:context:phone'], after: contextOnly.ids['head:context:phone'],
    });
  });

  await t.test('nothing for a still never cleared, an admin\'s, a desktop one, a moved head, a merged change, a private project or the platform', () => {
    for (const c of [unsafe, asAdmin, desktopOnly, moved, merged, hidden, own]) assert.equal(stills.has(c.id), false);
  });

  await t.test('the bytes only for a passing still of that project\'s change', async () => {
    const after = good.ids['head:focus:phone'];
    const bytes = await publicStillBytes(pool, { slug: pub.slug, changeId: good.id, artifactId: after });
    assert.equal(bytes.contentType, 'image/png');
    assert.equal(bytes.data.toString('hex'), '89504e47');
    assert.equal(await publicStillBytes(pool, { slug: 'another', changeId: good.id, artifactId: after }), null);
    assert.equal(await publicStillBytes(pool, { slug: pub.slug, changeId: good.id, artifactId: good.ids['head:context:desktop'] }), null);
    assert.equal(await publicStillBytes(pool, { slug: pub.slug, changeId: unsafe.id, artifactId: unsafe.ids['head:focus:phone'] }), null);
  });

  await t.test('the project page\'s overview carries the addresses, and nothing for a change without', async () => {
    const overview = await loadProjectOverview(pool, pub.slug, { gh: { isEnabled: () => false } });
    const byId = new Map(overview.votes.map((v) => [v.id, v]));
    assert.deepEqual(byId.get(good.id).pictures, {
      before: publicStillUrl(pub.slug, good.id, good.ids['base:focus:phone']),
      after: publicStillUrl(pub.slug, good.id, good.ids['head:focus:phone']),
    });
    assert.equal(byId.get(unsafe.id).pictures, null);
    assert.equal(byId.get(asAdmin.id).pictures, null);
    assert.match(publicStillUrl(pub.slug, good.id, 'abc'), /^\/api\/public\/apps\/pub-app-1\/changes\/\d+\/stills\/abc$/);
  });
});
