'use strict';

// #3572: a project's short description has a limit, and it is two lines.
//
//   1. THE LIMIT IS 90. services/create-options.js refuses a longer "What is
//      it?" with a sentence that names the number. 90 is two lines of the
//      project's hub hero on a 360px phone with room to spare (the
//      measurement is written out beside DESCRIPTION_MAX). The create dialog
//      whose field counted down to it is retired: the make screen sends a
//      description only with an example, and every example's fits
//      (tests/first-session-make.test.js).
//   2. LONGER LINES ARE CLAMPED, NOT REFUSED. A repository's own dapp.json can
//      say more (an import, a later proposal); the deploy keeps it, and the
//      hub hero draws two lines of it and the About pane three, with an
//      ellipsis. Discover and the join screen already clamped at two.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const options = require('../src/services/create-options');
const manifest = require('../src/services/app-manifest');

test('#3572: the server holds the limit, 90, and every example the make screen sends fits it', () => {
  assert.equal(options.DESCRIPTION_MAX, 90);
  assert.match(options.parseCreateOptions({ audience: 'open', description: 'x'.repeat(91) }).error,
    /^Say what it is in 90 characters or fewer\.$/, 'the refusal names the limit');
  const { EXAMPLES } = loadTsx('frontend/src/features/first-session/examples.ts');
  for (const e of EXAMPLES) assert.ok(e.description.length <= options.DESCRIPTION_MAX, e.key);
});

test('#3572: a longer line from a repository is kept, and clamped where it is drawn', () => {
  const long = 'x '.repeat(80).trim();
  assert.equal(manifest.readDescription({ description: long }), long, 'the deploy keeps it: no import or deploy fails on it');
  assert.equal(manifest.readDescription({ description: 'y'.repeat(400) }).length, 280, 'the reader\'s own ceiling is unchanged');

  // The hub hero: two lines, the measure the limit was taken against.
  const css = read('public/css/app.css');
  const hero = css.slice(css.indexOf('.dev-ws-hero-desc {\n  display'), css.indexOf('}', css.indexOf('.dev-ws-hero-desc {\n  display')));
  assert.match(hero, /display: -webkit-box;/);
  assert.match(hero, /-webkit-box-orient: vertical;/);
  assert.match(hero, /-webkit-line-clamp: 2;/);
  assert.match(hero, /line-clamp: 2;/);
  assert.match(hero, /overflow: hidden;/);
  assert.match(read('frontend/src/features/dev-board/workshop/community-card.tsx'),
    /<p className="dev-ws-hero-desc" data-ws-community-description="">\{data\.description\}<\/p>/);

  // The About pane: three, beside the icon and a size smaller.
  assert.match(read('frontend/src/features/app-context/about-pane.tsx'),
    /<p id="app-about-tagline" className="mt-0\.5 line-clamp-3 text-\[0\.8125rem\] leading-snug/);

  // Discover and the join screen already stopped at two.
  assert.match(css, /\.home-discover-blurb \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(read('frontend/src/features/auth/communities-first-run.js'), /'mt-0\.5 line-clamp-2 text-\[0\.8125rem\]/);
});

test('#3572: the conventions tell an app\'s builders the limit', () => {
  const doc = read('src/prompts/app-conventions.md');
  const section = doc.slice(doc.indexOf('### Top-level `description`'), doc.indexOf('### Top-level `visibility`'));
  assert.ok(section.length > 0, 'a section of its own, after `name`');
  assert.match(section, /\*\*90 characters or fewer\*\*/);
  assert.match(section, /two lines\s+on a phone/);
});
