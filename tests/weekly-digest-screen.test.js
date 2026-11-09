'use strict';

// This week (#6371): the page the weekly digest opens.
//
//   1. it ships hidden and empty, so hydration agrees with the prerender;
//   2. `#week` routes to it, and Home's back arrow is the way out;
//   3. the week it draws is each project's label over its changes, the open
//      vote's blue pill only where the viewer has not voted, and the more
//      line when a busy project has more than it lists.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderComponent, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the page ships hidden and empty', () => {
  const html = renderComponent('frontend/src/features/weekly-digest/index.tsx', 'WeeklyDigestScreen', {});
  assert.match(html, /<main id="weekly-digest-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a constant class string');
  assert.doesNotMatch(html, /data-weekly-digest-pane=/, 'the week is client data: none of it in the first render');
});

test('#week routes to the page, and its arrow goes up to Home', () => {
  const appJs = read('public/js/app.js');
  assert.match(appJs, /parts\[0\] === 'week'[\s\S]*?App\.navigateToWeeklyDigest\(\)/);
  assert.match(appJs, /case 'week': return 'weekly-digest-screen';/);
  assert.match(appJs, /'weekly-digest-screen',\s*\n\s*\/\/ The AI tab's main view/,
    'the visibility seam lists it, as it lists #workshop-screen');
  assert.match(appJs, /'weekly-digest-screen': \['arrow', '\/'\]/, 'a page under Home');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="WeeklyDigestScreen"><WeeklyDigestScreen \/><\/Island>/);
});

test('the week draws each project, its changes, and the vote only where it is owed', () => {
  const mod = loadTsx('frontend/src/features/weekly-digest/index.tsx');
  const html = () => renderToHtml(createElement(mod.WeeklyDigestScreen, {}));
  const until = new Date('2026-11-06T16:00:00.000Z');
  mod.weeklyDigestStore.set({
    open: true,
    loading: false,
    error: false,
    data: {
      since: new Date(until.getTime() - 7 * 86400000).toISOString(),
      until: until.toISOString(),
      projects: [
        {
          slug: 'tiers', name: 'Tier Lists',
          merged: [{ sessionId: 41, prNumber: 41, title: 'Custom tier colors', mergedAt: '2026-11-05T10:00:00Z' }],
          mergedTotal: 12,
          open: [
            { sessionId: 44, prNumber: 44, title: 'Dark mode toggle', myVote: false },
            { sessionId: 45, prNumber: 45, title: 'Already voted', myVote: true },
          ],
          openTotal: 2,
        },
      ],
      mergedTotal: 12,
      projectCount: 1,
    },
  });
  const out = html();
  assert.match(out, /Tier Lists/, 'the project is a small-caps label over its card');
  assert.match(out, /Custom tier colors/);
  assert.match(out, new RegExp(message('weekly-digest:upForVote')), 'an open change says it is up for a vote');
  assert.match(out, new RegExp(message('weekly-digest:vote')), 'the vote owed carries its pill');
  assert.equal((out.match(new RegExp(message('weekly-digest:vote'), 'g')) || []).length, 1,
    'only the change the viewer has not voted on');
  assert.match(out, new RegExp(message('weekly-digest:more', { count: 11 })), 'the rest lives in the Workshop');
  mod.weeklyDigestStore.set({ open: false, loading: false, data: null, error: false });
});

test('nothing in the week says so in words', () => {
  const mod = loadTsx('frontend/src/features/weekly-digest/index.tsx');
  mod.weeklyDigestStore.set({
    open: true, loading: false, error: false,
    data: { since: '2026-10-30T00:00:00Z', until: '2026-11-06T00:00:00Z', projects: [], mergedTotal: 0, projectCount: 0 },
  });
  const out = renderToHtml(createElement(mod.WeeklyDigestScreen, {}));
  assert.match(out, new RegExp(message('weekly-digest:empty')));
  mod.weeklyDigestStore.set({ open: false, loading: false, data: null, error: false });
});
