'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const curation = require('../src/services/discovery-curation');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const app = (over = {}) => ({
  status: 'running', main_sha: 'a'.repeat(40), icon_emoji: '🎮',
  last_deploy_at: '2026-09-01T12:00:00Z', directory_review_status: 'unreviewed', ...over,
});

test('an app that runs and has an icon is listed, with no review', () => {
  assert.deepEqual(curation.describe(app()), { state: 'listed', tier: 'listed', label: null, flagged: false, flaggedAt: null });
  assert.equal(curation.describe(app({ icon_emoji: null, icon_image_id: 'image-id' })).tier, 'listed');
  assert.equal(curation.describe(app({ icon_emoji: null, icon_url: '/app-icons/image-id' })).tier, 'listed');
  // Whatever a review used to say, and however long ago it deployed: no
  // version pinning, nothing that lapses on a deploy.
  for (const over of [{ directory_review_status: 'working' }, { directory_review_status: null },
    { main_sha: 'b'.repeat(40) }, { main_sha: null }, { last_deploy_at: '2030-01-01T00:00:00Z' }, { demo: true }]) {
    assert.equal(curation.describe(app(over)).tier, 'listed', JSON.stringify(over));
  }
  for (const icon of [null, '', '  ']) {
    const result = curation.describe(app({ icon_emoji: icon }));
    assert.equal(result.tier, 'more'); assert.equal(result.state, 'missing_icon'); assert.equal(result.label, 'Needs an icon');
  }
  for (const status of ['creating', 'error', 'awaiting_secrets']) {
    const result = curation.describe(app({ status }));
    assert.equal(result.tier, 'more'); assert.equal(result.label, 'Not running');
  }
});

test('an admin\'s flag hides an app from Discover, whatever its numbers, and is the only editorial state', () => {
  for (const directory_review_status of ['demo', 'broken']) {
    const result = curation.describe(app({ directory_review_status, active_users: 9999, featured: true,
      directory_reviewed_at: '2026-10-29T12:00:00Z' }));
    assert.deepEqual(result, { state: 'flagged', tier: 'hidden', label: 'Hidden from Discover', flagged: true,
      flaggedAt: '2026-10-29T12:00:00.000Z' });
  }
  // A flag wins over not running and no icon: it is left out, not under Show more.
  assert.equal(curation.describe(app({ directory_review_status: 'broken', status: 'error', icon_emoji: null })).tier, 'hidden');
  assert.equal(curation.isFlagged(app({ directory_review_status: curation.FLAGGED })), true);
  assert.equal(curation.isFlagged(app({ directory_review_status: curation.UNFLAGGED })), false);
  assert.deepEqual(curation.FLAGGED_STATES, ['demo', 'broken']);
});

test('featuring needs an icon and no flag, and says which is missing', () => {
  assert.equal(curation.featureRefusal(app()), null);
  assert.equal(curation.featureRefusal(app({ status: 'error' })), null, 'a stopped app is left out where it would show, not refused');
  assert.match(curation.featureRefusal(app({ icon_emoji: null })), /has no icon/);
  assert.match(curation.featureRefusal(app({ directory_review_status: 'broken' })), /is flagged[\s\S]*Clear the flag/);
});


test('staging preview fixtures exercise the flag without touching real apps', () => {
  const { catalogFixtures: fixture } = require('../src/services/staging-apps');
  assert.ok(fixture().filter((a) => a.featured).every((a) => a.directory.tier === 'listed'));
  const samples = fixture(true).filter((a) => a.slug.startsWith('directory-sample-'));
  assert.deepEqual(samples.map((a) => [a.slug, a.directory.state]), [
    ['directory-sample-listed', 'listed'], ['directory-sample-flagged', 'flagged'], ['directory-sample-no-icon', 'missing_icon']]);
  // Preview serves the seeded row, not this in-memory copy, so the seed
  // stores the flag too.
  const seed = fs.readFileSync(path.join(__dirname, '../src/services/staging-apps.js'), 'utf8');
  assert.match(seed, /main_sha, directory_review_status, directory_reviewed_at\)/);
  assert.doesNotMatch(seed, /directory_reviewed_sha/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8'), /req.query.demo === '1'/);
});

test('the admin console lists flagged apps and flags one only after asking; a view-only admin reads the list', () => {
  const { DiscoverFlags, canFeature } = loadTsx('frontend/src/features/admin/admin-featured-apps.tsx');
  const flagged = { slug: 'hidden-one', name: 'Hidden one', icon_emoji: '🚩', directory: curation.describe(app({ directory_review_status: 'broken' })) };
  const listed = { slug: 'listed-one', name: 'Listed one', icon_emoji: '🧩', directory: curation.describe(app()) };
  const html = renderToHtml(createElement(DiscoverFlags, { apps: [flagged, listed], canWrite: true, onChanged: () => {} }));
  assert.match(html, /Flagged apps/);
  assert.match(html, /left out of Discover and Featured everywhere/);
  assert.match(html, /data-flagged-row="hidden-one"/);
  assert.doesNotMatch(html, /data-flagged-row="listed-one"/);
  assert.match(html, /data-unflag="hidden-one"[^>]*>Clear flag</);
  assert.match(html, /<option value="listed-one">Listed one<\/option>/, 'the picker offers only unflagged apps');
  assert.doesNotMatch(html, /<option value="hidden-one">/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /review/i);

  const readOnly = renderToHtml(createElement(DiscoverFlags, { apps: [flagged], canWrite: false, onChanged: () => {} }));
  assert.match(readOnly, /data-flagged-row="hidden-one"/);
  assert.doesNotMatch(readOnly, /Clear flag|admin-flag-picker/, 'a view-only admin reads the list');
  assert.match(renderToHtml(createElement(DiscoverFlags, { apps: [listed], canWrite: true, onChanged: () => {} })), /No app is flagged/);

  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/admin/admin-featured-apps.tsx'), 'utf8');
  assert.match(src, /_confirm\(\{[\s\S]*?danger: true/, 'flagging asks first');
  assert.match(src, /\/api\/admin\/apps\/\$\{encodeURIComponent\(app\.slug\)\}\/discover-flag/);

  assert.equal(canFeature(listed), true);
  assert.equal(canFeature(flagged), false);
  assert.equal(canFeature({ slug: 'x', directory: curation.describe(app({ icon_emoji: null })) }), false);
});
