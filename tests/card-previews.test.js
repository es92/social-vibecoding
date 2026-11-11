'use strict';

// A project card's animated preview: a short, silent loop of the real app
// that plays over the card's picture (#card-previews). What the browser
// test (tests/card-previews-browser.test.js) does not cover:
//
//   - the vote's apply moves the loop with the picture, from the proposal's
//     own bytes or the app's, and refuses a loop that is gone;
//   - byte ranges, as a video element asks for them;
//   - the card at rest: an inert layer, no <video>, so nothing hydrates
//     differently and nothing is fetched;
//   - the vote card shows the proposed loop beside the two pictures, as a
//     player that starts only when pressed;
//   - Settings › Accessibility's "Play previews" switch, off in its first
//     render, on by default once storage is read;
//   - the editor's loop buttons, and the words in the catalogs.
//
// Run with: node --test tests/card-previews.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const illustrations = require('../src/workflow/rules/illustrations.ts');
const { sendRange } = require('../src/routes/byte-range');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ID = (c) => c.repeat(32);

/** A transaction client over a pending row and a current row, keeping what is written. */
function client({ pending = null, current = null } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (sql.includes('FROM app_illustration_proposals WHERE issue_id') && sql.includes('UNION ALL')) {
        return { rows: [pending, current].filter(Boolean) };
      }
      if (sql.startsWith('SELECT * FROM app_illustration_proposals')) return { rows: pending ? [pending] : [] };
      if (sql.startsWith('SELECT * FROM app_illustrations')) return { rows: current ? [current] : [] };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
}

test('the vote\'s apply moves a new loop with the picture, keeps a kept one, and drops one the record no longer names', async () => {
  const loop = Buffer.from('loop-bytes');
  const pending = { id: ID('a'), content_type: 'image/png', data: Buffer.from('pic'), dark_id: null,
    preview_id: ID('c'), preview_content_type: 'video/mp4', preview_data: loop };
  const proposed = { url: `/app-illustrations/${ID('a')}`, darkUrl: null, zoom: 1, x: 0, y: 0,
    preview: { url: `/app-previews/${ID('c')}`, type: 'video/mp4' } };
  let c = client({ pending });
  assert.equal(await illustrations.missingProposalImage(c, 1, { proposed }, 9), null);
  await illustrations.applyProposal(c, 1, { proposed }, 9);
  const upsert = c.writes.find((w) => w.sql.includes('INSERT INTO app_illustrations'));
  assert.deepEqual(upsert.params.slice(7), [ID('c'), 'video/mp4', loop], 'the loop lands under the same id');
  assert.ok(c.writes.some((w) => w.sql.startsWith('UPDATE apps SET featured_illustration') && JSON.parse(w.params[1]).preview.url === proposed.preview.url));

  // A reframe keeps the app's own loop.
  const current = { ...pending, id: ID('b'), preview_id: ID('d') };
  const kept = { ...proposed, url: `/app-illustrations/${ID('b')}`, preview: { url: `/app-previews/${ID('d')}`, type: 'video/mp4' } };
  c = client({ current });
  await illustrations.applyProposal(c, 1, { proposed: kept }, 9);
  assert.deepEqual(c.writes.find((w) => w.sql.includes('INSERT INTO app_illustrations')).params.slice(7, 9), [ID('d'), 'video/mp4']);

  // No loop on the record: the columns are emptied.
  c = client({ current });
  const { preview: _gone, ...still } = kept;
  await illustrations.applyProposal(c, 1, { proposed: still }, 9);
  assert.deepEqual(c.writes.find((w) => w.sql.includes('INSERT INTO app_illustrations')).params.slice(7), [null, null, null]);

  // A loop that is gone refuses the apply, and the machine's check says so first.
  const lost = { ...kept, preview: { url: `/app-previews/${ID('e')}`, type: 'video/mp4' } };
  c = client({ current });
  assert.equal(await illustrations.missingProposalImage(c, 1, { proposed: lost }, 9), 'image_unavailable');
  await assert.rejects(illustrations.applyProposal(c, 1, { proposed: lost }, 9), /preview is no longer available/);
  assert.equal(await illustrations.missingProposalImage(client({ current }), 1, { proposed: { ...kept, preview: { url: '/elsewhere.mp4' } } }, 9), 'no_image');
  assert.equal(illustrations.previewIdFromUrl(`/app-previews/${ID('f')}`), ID('f'));
  assert.equal(illustrations.previewIdFromUrl('/app-illustrations/x'), null);
});

test('byte ranges: a whole answer, a slice, the tail, and an unsatisfiable range', () => {
  const data = Buffer.from('0123456789');
  const answer = (range) => {
    const out = { headers: {}, status: 200, body: null };
    const res = {
      set(k, v) { out.headers[k.toLowerCase()] = v; return res; },
      status(code) { out.status = code; return res; },
      send(body) { out.body = body; return res; },
      end() { return res; },
    };
    sendRange({ headers: range ? { range } : {} }, res, data);
    return out;
  };
  assert.deepEqual([answer(null).status, String(answer(null).body)], [200, '0123456789']);
  const slice = answer('bytes=2-4');
  assert.deepEqual([slice.status, String(slice.body), slice.headers['content-range']], [206, '234', 'bytes 2-4/10']);
  assert.equal(String(answer('bytes=-3').body), '789');
  assert.equal(String(answer('bytes=7-').body), '789');
  assert.equal(answer('bytes=10-').status, 416);
  assert.equal(answer('nonsense').status, 416);
  assert.equal(answer(null).headers['accept-ranges'], 'bytes');
  assert.match(read('src/routes/issue-videos.js'), /return sendRange\(req, res, rows\[0\]\.data\);/, 'the feedback clips answer ranges the same way');
});

const BASE = {
  slug: 'pear', name: 'Pear', description: 'Recipes from what is left.', active_users: 0, created_at: '2026-01-01T00:00:00.000Z',
  url: 'https://pear.example', requires_login: true, guest_ready: false, illustration_url: '/app-illustrations/l',
};

test('a card at rest carries an inert layer for its loop and no video; a card without a loop carries neither', () => {
  const { Card } = loadTsx('frontend/src/features/guest/guest-discover.tsx');
  const withLoop = renderToHtml(createElement(Card, { app: { ...BASE, preview_url: '/app-previews/x' }, eager: false }));
  assert.match(withLoop, /<span data-card-preview="" aria-hidden="true" class="pointer-events-none absolute inset-0"><\/span>/);
  assert.doesNotMatch(withLoop, /<video/, 'nothing mounts, and nothing is fetched, until a card is chosen');
  const without = renderToHtml(createElement(Card, { app: BASE, eager: false }));
  assert.doesNotMatch(without, /data-card-preview/);
  // The player's own attributes, when it mounts.
  const src = read('frontend/src/features/guest/card-preview.tsx');
  for (const attr of ['muted', 'playsInline', 'preload="none"', 'loop={!once}', 'disablePictureInPicture']) {
    assert.ok(src.includes(attr), attr);
  }
  assert.match(src, /played\.catch\(\(\) => releasePreview\(id\)\)/, 'a refused play is answered, never an uncaught rejection');
  const lib = read('frontend/src/lib/card-previews.ts');
  assert.match(lib, /export const HOVER_DELAY_MS = 150;/);
  assert.match(lib, /export const PHONE_MAX_SECONDS = 5;/);
  assert.match(lib, /prefers-reduced-motion: reduce/);
  assert.match(lib, /saveData/);
});

test('a vote that brings a loop shows it beside the two pictures, as a player that starts only when pressed', () => {
  const { IllustrationPreviewRow } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');
  const row = (proposed, current = { url: '/icons/v3/icon-192.png', darkUrl: null, tint: null }) => renderToHtml(createElement(IllustrationPreviewRow, {
    x: { t: 'illustration', key: 'k', remove: false, proposed, current },
  }));
  const html = row({ url: '/illustrations/card-previews/sample.png', darkUrl: null, tint: 'yellow', previewUrl: '/illustrations/card-previews/sample.mp4' });
  const figure = html.slice(html.indexOf('data-illustration-side="preview"'));
  assert.match(figure, new RegExp(message('project:card.illustration.preview')));
  const video = figure.match(/<video[^>]*>/)[0];
  for (const attr of ['src="/illustrations/card-previews/sample.mp4"', 'poster="/illustrations/card-previews/sample.png"', 'controls=""', 'loop=""', 'playsInline=""', 'preload="none"',
    `aria-label="${message('project:card.illustration.previewLabel')}"`]) {
    assert.ok(video.includes(attr), `${attr} in ${video}`);
  }
  assert.doesNotMatch(video, /autoplay/i);
  // No loop, or the same loop the card already plays: no player.
  assert.doesNotMatch(row({ url: '/a.png', darkUrl: null, tint: null }), /data-illustration-side="preview"/);
  const same = '/app-previews/' + ID('a');
  assert.doesNotMatch(row({ url: '/a.png', darkUrl: null, tint: null, previewUrl: same }, { url: '/b.png', darkUrl: null, tint: null, previewUrl: same }), /data-illustration-side="preview"/);
  // Both card models carry the loop's address to it.
  const { governanceContent } = loadTsx('frontend/src/features/dev-board/topic/governance-model.ts');
  const content = governanceContent({ kind: 'featured_illustration', payload: { proposed: { url: '/a.png', preview: { url: same, type: 'video/mp4' } }, current: null } });
  assert.equal(content.proposed.previewUrl, same);
  assert.match(read('public/js/app-view.js'), /previewUrl: rec\.preview && typeof rec\.preview\.url === 'string' \? String\(rec\.preview\.url\) : null/);
  // The ?demo=1 vote proposes the shipped sample loop over its own first frame.
  assert.match(read('src/routes/issues.js'), /preview: \{ url: '\/illustrations\/card-previews\/sample\.mp4', type: 'video\/mp4' \}/);
  for (const file of ['sample.mp4', 'sample.png']) assert.ok(fs.statSync(path.join(ROOT, 'public/illustrations/card-previews', file)).size > 0);
});

test('Settings › Accessibility: "Play previews", off in its first render, its words in the catalog', () => {
  const html = renderComponent('frontend/src/features/settings/sections/accessibility.tsx', 'AccessibilitySection', {});
  assert.match(html, /id="settings-card-previews"/);
  assert.match(html, new RegExp(message('settings:accessibility.previews.label')));
  assert.match(message('settings:accessibility.previews.description'), /reduce motion or save data/);
  const lib = read('frontend/src/lib/card-previews.ts');
  assert.match(lib, /const PREF_KEY = 'usernode:cardPreviews';/);
  assert.match(lib, /return storage\(\)\?\.getItem\(PREF_KEY\) !== 'off';/, 'on unless turned off');
});

test('the editor adds, replaces and removes a loop, checked as the server checks it', () => {
  const src = read('frontend/src/features/apps/featured-illustration-editor.tsx');
  assert.match(src, /accept="video\/mp4,video\/webm"/);
  assert.match(src, /const MAX_PREVIEW_BYTES = 1536 \* 1024;/);
  assert.equal(require('../src/routes/app-illustrations').MAX_PREVIEW_BYTES, 1536 * 1024);
  assert.match(src, /preview: pendingPreview\.current \? await encode\(pendingPreview\.current\) : null/);
  for (const id of ['add', 'replace', 'remove', 'formats', 'fileLabel', 'player', 'invalid']) {
    assert.ok(message(`discover:illustration.preview.${id}`), id);
    assert.ok(src.includes(`discover:illustration.preview.${id}`), id);
  }
});
