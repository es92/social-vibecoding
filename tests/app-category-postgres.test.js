// #6585: the sweep's query and the directory's join, against a real
// PostgreSQL (the repository's rule for a new or changed query). The helper
// model is not stubbed here on purpose: with no key in this process the sweep
// must record a failure and leave the project as it was, which is what the
// sentences below check. The service's own logic is tests/app-category.test.js.
//
// Run with: node --test tests/app-category-postgres.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const appCategory = require('../src/services/app-category');
const { listPublicApps } = require('../src/services/public-app-directory');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the sweep and the directory read a stored kind only while its description still matches (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `app_category_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

    const user = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('category_tester', 'unused') RETURNING id`
    )).rows[0];
    let next = 0;
    const makeApp = async (slug, snapshot) => {
      const row = (await pool.query(
        `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility, status, manifest_snapshot)
         VALUES ($1, $2, $3, 'public', 'public', 'running', $4::jsonb) RETURNING id`,
        [slug, `Category ${++next}`, user.id, JSON.stringify(snapshot)]
      )).rows[0];
      return row.id;
    };
    const storeInferred = (appId, category, source, ageHours = 0) => pool.query(
      `INSERT INTO app_inferred_categories (app_id, category, source_description, model, inferred_at)
       VALUES ($1, $2, $3, 'test', NOW() - make_interval(hours => $4))`,
      [appId, category, source, ageHours]
    );

    const gameId = await makeApp('category-game', { category: 'games', description: 'A card game for the group.' });
    await storeInferred(gameId, 'money', 'A card game for the group.');
    const otherId = await makeApp('category-other', { category: 'other', description: 'Split the bills for a shared house.' });
    const changedId = await makeApp('category-changed', { description: 'Recipes from the fridge.' });
    await storeInferred(changedId, 'learning', 'an older description');
    const matchedId = await makeApp('category-matched', { description: 'Log your runs and keep a streak.' });
    await storeInferred(matchedId, 'health', 'Log your runs and keep a streak.');
    const failedId = await makeApp('category-failed', { description: 'Something nobody can place.' });
    await storeInferred(failedId, null, 'Something nobody can place.', 0);
    const foodId = await makeApp('category-food', { description: 'Baking timers for sourdough.' });
    await storeInferred(foodId, 'food', 'Baking timers for sourdough.');
    const staleId = await makeApp('category-stale', { description: 'A new description entirely.' });
    await storeInferred(staleId, 'food', 'an older description');

    // The directory reads the stored kind while the description matches, and
    // a chosen kind always wins over a stale one.
    const before = await listPublicApps(pool);
    const bySlug = (slug) => before.find((a) => a.slug === slug);
    assert.equal(bySlug('category-food').category, 'food', 'the worked-out kind stands in');
    assert.equal(bySlug('category-game').category, 'games', 'the chosen kind wins over a stored one');
    assert.equal(bySlug('category-stale').category, null, 'a stored kind from another description does not count');
    assert.equal(bySlug('category-other').category, 'other', 'nothing stored yet');

    // The sweep owes an answer to: no row (`other`), a changed description,
    // and an old failure. A chosen kind, a matching row, and a fresh failure
    // are not asked about. With no model key every call fails, and a failed
    // answer is stored as NULL to be retried a day later.
    const eligible = await appCategory.candidates(pool, 25);
    assert.deepEqual(eligible.map((r) => r.id).sort(), [otherId, changedId, staleId].sort());

    const out = await appCategory.sweep(pool);
    assert.deepEqual(out, { inferred: 0, failed: 3 });
    const rows = (await pool.query(
      'SELECT app_id, category, source_description, model FROM app_inferred_categories ORDER BY app_id'
    )).rows;
    const rowFor = (id) => rows.find((r) => r.app_id === id);
    assert.equal(rowFor(otherId).category, null);
    assert.equal(rowFor(otherId).source_description, 'Split the bills for a shared house.');
    assert.equal(rowFor(changedId).category, null);
    assert.equal(rowFor(changedId).source_description, 'Recipes from the fridge.');
    assert.equal(rowFor(staleId).category, null);
    assert.equal(rowFor(matchedId).category, 'health', 'a matching answer is left alone');
    assert.equal(rowFor(gameId).category, 'money', 'a chosen kind is never asked about');
    assert.equal(rowFor(failedId).category, null);
    assert.equal(rowFor(staleId).model, null, 'a failure records no model');

    // A description that changed drops the row from the directory read.
    await pool.query(
      `UPDATE apps SET manifest_snapshot = manifest_snapshot || '{"description": "A different recipe."}'::jsonb
        WHERE id = $1`, [foodId]
    );
    const after = await listPublicApps(pool);
    assert.equal(after.find((a) => a.slug === 'category-food').category, null,
      'the stored kind counts only while its source description still matches');
  });
