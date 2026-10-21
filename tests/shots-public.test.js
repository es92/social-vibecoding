'use strict';
// Before & after stills somebody who is not signed in may see: how the
// shots agent's answer travels from save_shot to shot_artifacts.public_safe,
// which pair a change shows (src/services/shots-public.js pairOf), and the
// guest project page's vote card drawing them. The query itself runs against
// PostgreSQL in tests/shots-public-postgres.test.js.
//
// Run with: node --test tests/shots-public.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { pairOf, stillsSql, PHONE_WIDTH_BELOW } = require('../src/services/shots-public');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the shots agent says of each still whether it shows anybody\'s private things, and an unanswered one stays private', () => {
  const mcp = read('worker/shots-mcp.js');
  assert.match(mcp, /showsPrivate: z\.boolean\(\)\.optional\(\)/);
  assert.match(mcp, /\.\.\.\(typeof showsPrivate === 'boolean' \? \{ showsPrivate: showsPrivate \? '1' : '0' \} : \{\}\),/);
  assert.match(read('src/routes/internal.js'), /showsPrivate: req\.query\.showsPrivate,/);
  const control = read('src/services/shots-control.js');
  assert.match(control, /return showsPrivate === '0' \|\| showsPrivate === false \? true : null;/);
  assert.match(control, /entry\.publicSafe = publicSafeOf\(rawTarget\?\.showsPrivate\);/);
  // Kept with the file, replaced with a retake, and published with it.
  assert.match(control, /public_safe = EXCLUDED\.public_safe, saved_at = NOW\(\)/);
  assert.match(read('src/workflow/shots/machine.ts'), /f\.part, f\.scale, f\.focus_rect, f\.public_safe/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE shot_run_files ADD COLUMN IF NOT EXISTS public_safe BOOLEAN;/);
  assert.match(schema, /ALTER TABLE shot_artifacts ADD COLUMN IF NOT EXISTS public_safe BOOLEAN;/);
  // The agent is asked, and told to say true when unsure.
  const { SYSTEM_PROMPT } = require('../src/services/shots-agent');
  assert.match(SYSTEM_PROMPT, /showsPrivate: true if it shows a real\s+person's name, words they wrote or an email address, or another project;/);
  assert.match(SYSTEM_PROMPT, /when unsure,\s+say true/);
});

test('a public still is a member-account phone still the agent cleared, on a public project that is not the platform', () => {
  const sql = stillsSql('TRUE');
  assert.match(sql, /NOT a\.self_hosted AND a\.moderation_suspended_at IS NULL AND a\.view_visibility = 'public'/);
  assert.match(sql, /f\.public_safe IS TRUE/);
  assert.match(sql, /st->>'persona' = 'member'/);
  assert.equal(PHONE_WIDTH_BELOW, 768);
  assert.match(sql, /f\.theme = 'light' AND f\.variant IN \('focus', 'context'\)/);
});

test('a change shows its element shots when both sides have one, else its whole screens; a new app\'s has no before', () => {
  const row = (id, side, variant, story = 'c1', viewport = 'phone') => ({ id, side, variant, story_id: story, viewport });
  assert.deepEqual(pairOf([row('b1', 'base', 'context'), row('a1', 'head', 'context'), row('b2', 'base', 'focus'), row('a2', 'head', 'focus')]),
    { before: 'b2', after: 'a2' });
  assert.deepEqual(pairOf([row('b1', 'base', 'context'), row('a1', 'head', 'context'), row('a2', 'head', 'focus')]),
    { before: 'b1', after: 'a1' });
  assert.deepEqual(pairOf([row('a1', 'head', 'context')]), { before: null, after: 'a1' });
  assert.equal(pairOf([row('b1', 'base', 'context')]), null, 'no after, no picture');
  // The first screen with an after shot, in order.
  assert.deepEqual(pairOf([row('x', 'base', 'context', 'c1'), row('a2', 'head', 'context', 'c2')]), { before: null, after: 'a2' });
});

test('the guest project page draws a change\'s before and after, labelled, only when it has them', () => {
  const app = { slug: 'game-corner', name: 'Game Corner' };
  const vote = { id: 7, pr_number: 1, title: 'Add the badge', summary: null, yes: 2, no: 0 };
  const props = (pictures) => ({ vote: { ...vote, pictures }, app, onIntent() {} });
  const html = renderComponent('frontend/src/features/guest/guest-project.tsx', 'VoteCard',
    props({ before: '/api/public/apps/game-corner/changes/7/stills/b', after: '/api/public/apps/game-corner/changes/7/stills/a' }));
  assert.match(html, /data-guest-vote-pictures=""/);
  assert.match(html, /<img src="\/api\/public\/apps\/game-corner\/changes\/7\/stills\/b"[^>]*>.*<figcaption[^>]*>Before<\/figcaption>/);
  assert.match(html, /<img src="\/api\/public\/apps\/game-corner\/changes\/7\/stills\/a"[^>]*>.*<figcaption[^>]*>After<\/figcaption>/);
  assert.equal(message('auth:guest.project.before'), 'Before');
  const afterOnly = renderComponent('frontend/src/features/guest/guest-project.tsx', 'VoteCard', props({ before: null, after: '/x' }));
  assert.doesNotMatch(afterOnly, />Before</);
  assert.match(afterOnly, /grid-cols-1/);
  const none = renderComponent('frontend/src/features/guest/guest-project.tsx', 'VoteCard', props(null));
  assert.doesNotMatch(none, /data-guest-vote-pictures/);
  // The overview's addresses, from the public route only.
  assert.match(read('src/routes/public-api.js'), /router\.get\('\/api\/public\/apps\/:slug\/changes\/:id\/stills\/:artifactId', publicProjectReadLimiter,/);
});
