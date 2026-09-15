// The challenge detail PAGE (ITERATION 03), rendered.
//
// WHAT THIS PINS. The detail used to be a white card floating over a dimmed
// grid; it is a level of the Leaderboard screen now, drawn in the board's
// order below the platform header, which is its nav bar (the chevron up to
// the grid and the challenge's name, set by the controller). The render half
// asserts that order and the parts it is made of; the source half asserts
// what makes it a level rather than an overlay — in flow, the grid and the
// screen's own title, tabs and event bar stepping aside, and no back control
// of its own — because none of that shows in static markup. The artwork well
// under the task is drawn only for an illustration the registry resolves: a
// built-in, or an upload on its payload tone.
//
// Run with: node --test tests/challenge-detail-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const PANE_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const Pane = loadTsx(PANE_PATH);
const src = fs.readFileSync(path.join(__dirname, '..', PANE_PATH), 'utf8');
const screenSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/leaderboard/index.tsx'), 'utf8');

const VIEW = {
  key: '5',
  eyebrow: 'ONBOARDING',
  deadline: '3d left',
  amount: { text: '720 pts so far', earned: false },
  goal: 'Join block production',
  task: 'Up to 2,000 pts a week on-device, or 1,000 delegated.',
  illustration: 'block-production',
  illustrationTone: null,
  state: 'progress',
  stateLabel: '180/500 blocks',
  fill: 0.36,
  counted: true,
  cta: { kind: 'link', href: 'https://example.com/node', label: 'Set up your node' },
  description: 'Run a node that produces blocks.',
  requirements: 'A node reachable all week, on-device or delegated.',
  scoring: 'Points scale with the blocks you produce.',
  participants: 'Participants · 34',
  pointsTotal: '12,800 pts between them',
  moreLabel: 'Show all 34 →',
  entries: {
    kind: 'list',
    hasMore: true,
    rows: [
      { key: '1|0', userId: 1, name: 'Iso Nakamura', nonPodium: false, points: '2,000 pts' },
      { key: '2|1', userId: 2, name: 'Petra Lindqvist', nonPodium: true, points: '1,850 pts' },
    ],
  },
};

const render = (view) => renderToHtml(createElement(Pane.DetailPage, { view }));

test('the page reads in the board’s order', () => {
  const html = render(VIEW);
  const order = [
    '>ONBOARDING<', '<h2', '>3d left<', '>720 pts so far<', 'Up to 2,000 pts a week',
    'src="/illustrations/challenges/block-production.svg"', 'role="progressbar"', 'href="https://example.com/node"',
    'Run a node that produces blocks.', '>Requirements<', '>Scoring<', 'Participants · 34',
    '12,800 pts between them', 'Iso Nakamura', 'id="tc-se-breakdown-more"',
  ];
  let at = -1;
  for (const needle of order) {
    const i = html.indexOf(needle);
    assert.ok(i > at, `${needle} comes after the part before it`);
    at = i;
  }
  assert.doesNotMatch(html, /Next:/, 'no "Next:" hint (owner decision)');
  assert.doesNotMatch(html, /title=/, 'no tooltips');
  assert.doesNotMatch(html, /tc-se-detail-close|aria-label="Back"|×/,
    'no back control of its own: the platform header carries the way back');
});

test('the parts: the card’s meta line and clean rail at page size, a full-width action, button rows', () => {
  const html = render(VIEW);
  assert.match(html, /<h2 id="tc-se-detail-title" tabindex="-1"/, 'the title names the level and takes focus');
  assert.match(html, /role="progressbar"[^>]*class="[^"]*h-10/, 'the rail at page size');
  assert.match(html, /style="width:max\(0\.375rem, 36%\)"/, 'counted: the card’s bar');
  assert.doesNotMatch(html.slice(html.indexOf('role="progressbar"'), html.indexOf('href=')), /pts/,
    'the rail holds the state and nothing else');
  assert.match(html, /<div class="flex min-w-0 items-baseline gap-1\.5 text-sm leading-5">[^]*?>3d left<[^]*?text-amber-800 dark:text-amber-300">720 pts so far<\/span><\/div>/,
    'the meta line under the title, as on the card');
  assert.match(html, /<a href="https:\/\/example\.com\/node" target="_blank" rel="noopener" class="flex h-12 w-full/);
  assert.match(html, />Show all 34 →<\/button>/);
  assert.match(html, /<li><button type="button" class="tc-se-entry [^"]*min-h-11/,
    'participant rows are buttons, keeping their hook and a 44px target');
  assert.match(html, /\(non-podium\)/);
});

test('optional parts drop out cleanly', () => {
  const html = render({
    ...VIEW, eyebrow: null, deadline: null, amount: null, task: null, illustration: null, cta: { kind: 'text', label: 'Go' }, description: null,
    requirements: null, scoring: null, participants: 'Participants', pointsTotal: null,
    entries: { kind: 'loading' },
  });
  assert.doesNotMatch(html, /<a /, 'a scheme-rejected action is text, never an anchor');
  assert.match(html, /\(link unavailable\)/);
  assert.doesNotMatch(html, /Requirements|Scoring|between them|tc-se-breakdown-more|gap-1\.5 text-sm leading-5|uppercase|<img|h-56/);
  assert.match(html, /Loading participants…/);
});

test('the artwork well: only for a registry illustration, on its tone, and dropped if it fails to load', () => {
  const html = render(VIEW);
  assert.ok(html.includes(
    '<div class="home-tone-mint flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]">'
    + '<img src="/illustrations/challenges/block-production.svg" alt="" draggable="false" class="h-48 w-48 object-contain"/></div>'),
  'a full-width 224px well on the artwork’s tone, the art centred at 192px');

  // An upload: the path derived from its slug, fitted into the same box, on
  // the payload's tone, or gray without one the registry knows.
  const HEX = 'fedcba9876543210fedcba9876543210';
  const uploaded = (illustrationTone) => render({ ...VIEW, illustration: `u-${HEX}`, illustrationTone });
  assert.ok(uploaded('sage').includes(
    '<div class="home-tone-sage flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]">'
    + `<img src="/challenge-illustrations/${HEX}" alt="" draggable="false" class="h-48 w-48 object-contain"/></div>`),
  'an uploaded illustration in the same well, on its tone');
  for (const tone of [null, 'not-a-tone']) {
    assert.match(uploaded(tone), /<div class="home-tone-gray flex h-56/, `${tone}: an upload with no known tone is on gray`);
  }
  assert.match(render({ ...VIEW, illustrationTone: 'coral' }), /<div class="home-tone-mint flex h-56/,
    'a built-in keeps its own tone');

  for (const illustration of [null, 'not-in-the-registry', '../../icons/x', 'u-XYZ', `u-${HEX.toUpperCase()}`]) {
    assert.doesNotMatch(render({ ...VIEW, illustration }), /<img|h-56|tint-art/,
      `${illustration}: no well at all, never an empty one`);
  }
  // onError cannot fire in a static render, so the drop is pinned on the source.
  const well = src.slice(src.indexOf('function ArtworkWell('), src.indexOf('export function DetailPage('));
  assert.ok(well.length > 0, 'ArtworkWell located');
  assert.match(well, /resolveIllustration\(slug, tone\)/, 'the well resolves with the payload tone');
  assert.match(well, /onError=\{\(\) => setFailed\(art\.src\)\}/);
  assert.match(well, /if \(!art \|\| failed === art\.src\) return null;/);
  assert.doesNotMatch(src, /until challenges carry illustrations/, 'the reservation note is retired with the reservation');
});

test('a level of the screen, not an overlay: in flow, the rest of the screen steps aside', () => {
  const root = src.slice(src.indexOf('{/* Challenge detail page */}'), src.indexOf('{/* User profile overlay */}'));
  assert.ok(root.length > 0, 'detail root located');
  assert.match(root, /id="tc-se-detail-overlay"\s+className=\{state\.detail \? PAGE : `hidden \$\{PAGE\}`\}/);
  assert.match(root, /id="tc-se-detail-panel"/);
  assert.doesNotMatch(root, /onClick|ref=/, 'no backdrop and no plumbing');
  assert.match(src, /const PAGE = 'mx-auto w-full max-w-lg';/, 'a column in the screen, which scrolls it');
  assert.doesNotMatch(src, /CircleButton|touchstart|inert=|aria-modal|fixed inset-0 z-50 bg-zinc-100/,
    'the platform header is the nav bar, and nothing sits over the screen to guard or trap');
  assert.match(src, /<div id="tc-se-grid" className=\{state\.detail \? 'hidden' : undefined\}>/,
    'the grid steps aside while a page is open');
  assert.match(screenSrc, /<div className=\{detailOpen \? 'hidden' : undefined\}>/,
    'and so do the screen’s own title, tabs and event bar');
  assert.match(src, /e\.key !== 'Escape'/, 'Escape goes back up on a keyboard');
  // The screen's scroller is the page's: a page opens at its top and the grid
  // comes back where it was left, restored BEFORE the tracker reads it again.
  const restore = src.indexOf('else if (wasOpen.current) el.scrollTop = gridScroll.current;');
  const tracker = src.indexOf("target.addEventListener('scroll', track, { passive: true });");
  assert.ok(restore > 0 && tracker > restore, 'restore, then track');
  assert.match(src, /if \(openKey != null\) el\.scrollTop = 0;/);
  assert.equal((src.match(/href=\{/g) || []).length, 1, 'still exactly one href, the guarded action');
});
