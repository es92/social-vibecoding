// The challenge detail PAGE, rendered.
//
// WHAT THIS PINS. The detail is a level of the Leaderboard screen, drawn below
// the platform header, which is its nav bar (the chevron up to the grid and
// the word "Challenge", set by the controller). Since the Semi design
// (2026-10-16) it holds, in this order: the title, its points, the artwork,
// the rail, the organiser's task line, the action and "What counts" — no
// category eyebrow, deadline, description, Scoring or participants. The task
// line came back (#6592): it says what to do to start and finish. The render
// half asserts that order and the parts it is made of; the source half asserts
// what makes it a level rather than an overlay — in flow, the grid and the
// screen's own tabs and event bar stepping aside, and no back control of its
// own — because none of that shows in static markup. The artwork well is drawn
// only for an illustration the registry resolves: a built-in, or an upload on
// its payload tone.
//
// Run with: node --test tests/challenge-detail-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const PANE_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const Pane = loadTsx(PANE_PATH);
const src = fs.readFileSync(path.join(__dirname, '..', PANE_PATH), 'utf8');
const screenSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/leaderboard/index.tsx'), 'utf8');

const VIEW = {
  key: '5',
  amount: { text: '720 pts so far', earned: false },
  goal: 'Join block production',
  illustration: 'block-production',
  illustrationTone: null,
  state: 'progress',
  stateLabel: '180/500 blocks',
  fill: 0.36,
  counted: true,
  cta: { kind: 'link', href: 'https://example.com/node', label: 'Set up your node' },
  requirements: 'A node reachable all week, on-device or delegated.',
};

const render = (view) => renderToHtml(createElement(Pane.DetailPage, { view }));

test('the page reads: title, points, artwork, rail, action, What counts', () => {
  const html = render(VIEW);
  const order = [
    '<h2', '>720 pts so far<',
    'src="/illustrations/challenges/block-production.svg"', 'role="progressbar"', 'href="https://example.com/node"',
    '>What counts<', 'A node reachable all week',
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

test('the page leaves out the eyebrow, time, description, Scoring and participants', () => {
  // Handed every field the page used to draw, it draws none of them.
  const html = render({
    ...VIEW, eyebrow: 'ONBOARDING', deadline: '3d left', ends: 'ends Mon 12 Oct, 02:00', cadence: 'next count 9:37',
    description: 'Run a node that produces blocks.',
    scoring: 'Points scale with the blocks you produce.', participants: 'Participants · 34',
    pointsTotal: '12,800 pts between them', moreLabel: 'Show all 34 →',
    entries: { kind: 'list', hasMore: true, rows: [{ key: '1|0', userId: 1, name: 'Iso Nakamura', nonPodium: false, points: '2,000 pts' }] },
  });
  for (const gone of ['ONBOARDING', '3d left', 'ends Mon', 'next count', 'Run a node', 'Scoring',
    'Participants', 'between them', 'Iso Nakamura', 'tc-se-breakdown-more', 'tc-se-entry', 'uppercase']) {
    assert.ok(!html.includes(gone), `no ${gone}`);
  }
  for (const gone of ['EntriesSkeleton', 'function Entries', 'ProfileBody', 'tc-se-profile-overlay', '_moreBreakdown',
    'openUserProfile', 'EYEBROW']) {
    assert.ok(!src.includes(gone), `${gone} is gone from the pane`);
  }
});

test('the task line sits under the rail, before the action and What counts (#6592)', () => {
  const task = 'Open any app somebody else made and use it for 10 minutes in total.';
  const html = render({ ...VIEW, task });
  const at = html.indexOf('<p class="text-sm text-zinc-600 dark:text-zinc-400" data-challenge-task="true">');
  assert.ok(at !== -1, 'the task is plain prose, with no heading and no box');
  const rail = html.indexOf('role="progressbar"');
  const cta = html.indexOf('href="https://example.com/node"');
  const counts = html.indexOf('>What counts<');
  assert.ok(at > rail, 'after the progress rail');
  assert.ok(at < cta, 'before the action');
  assert.ok(at < counts, 'before What counts');
  assert.ok(html.includes(`>${task}<`), 'the organiser’s words exactly as written');
});

test('a page with no task draws no task line', () => {
  const html = render({ ...VIEW, task: null });
  assert.doesNotMatch(html, /data-challenge-task/);
  assert.doesNotMatch(render(VIEW), /data-challenge-task/, 'and a descriptor without the field behaves the same');
});

test('the parts: the points line and clean rail at page size, a full-width action', () => {
  const html = render(VIEW);
  assert.match(html, /<h2 id="tc-se-detail-title" tabindex="-1"/, 'the title names the level and takes focus');
  assert.match(html, /role="progressbar"[^>]*class="[^"]*h-10/, 'the rail at page size');
  assert.match(html, /style="width:max\(0\.375rem, 36%\)"/, 'counted: the card’s bar');
  assert.doesNotMatch(html.slice(html.indexOf('role="progressbar"'), html.indexOf('href=')), /pts/,
    'the rail holds the state and nothing else');
  assert.match(html, /<div class="min-w-0 truncate text-sm font-medium leading-5 text-amber-800 dark:text-amber-300">720 pts so far<\/div>/,
    'the points under the title, alone on their line');
  assert.match(render({ ...VIEW, amount: { text: '900 pts', earned: true } }),
    /text-emerald-700 dark:text-emerald-400">900 pts<\/div>/, 'earned: emerald, without the word');
  assert.match(html, /<a href="https:\/\/example\.com\/node" target="_blank" rel="noopener" class="flex h-12 w-full/);
});

test('optional parts drop out cleanly', () => {
  const html = render({
    ...VIEW, amount: null, illustration: null, cta: { kind: 'text', label: 'Go' }, requirements: null,
  });
  assert.doesNotMatch(html, /<a /, 'a scheme-rejected action is text, never an anchor');
  assert.match(html, /\(link unavailable\)/);
  assert.doesNotMatch(html, /What counts|text-amber-800|<img|h-56/);
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
  const root = src.slice(src.indexOf('{/* Challenge detail page */}'));
  assert.ok(root.length > 0, 'detail root located');
  assert.match(root, /id="tc-se-detail-overlay"\s+className=\{state\.detail \? PAGE : `hidden \$\{PAGE\}`\}/);
  assert.match(root, /id="tc-se-detail-panel"/);
  assert.doesNotMatch(root, /onClick|ref=/, 'no backdrop and no plumbing');
  assert.match(src, /const PAGE = 'mx-auto w-full max-w-lg';/, 'a column in the screen, which scrolls it');
  assert.doesNotMatch(src, /CircleButton|touchstart|inert=|aria-modal|fixed inset-0 z-50 bg-zinc-100/,
    'the platform header is the nav bar, and nothing sits over the screen to guard or trap');
  assert.match(src, /<div id="tc-se-grid" className=\{state\.detail \? 'hidden' : undefined\}>/,
    'the grid steps aside while a page is open');
  // (#5249: and while kudos is parked, a person's page in the Kudos section,
  // which is a level of its own too.)
  assert.match(screenSrc, /<div className=\{detailOpen \|\| \(KUDOS_PARKED && section === 'kudos'\) \? 'hidden' : section === 'kudos' \? KUDOS_COLUMN : undefined\}>/,
    'and so do the screen’s own title, tabs and event bar');
  assert.match(src, /if \(e\.key === 'Escape'\) controller\(\)\?\.handleBack\(\);/, 'Escape goes back up on a keyboard');
  // The screen's scroller is the page's: a page opens at its top and the grid
  // comes back where it was left, restored BEFORE the tracker reads it again.
  const restore = src.indexOf('else if (wasOpen.current) el.scrollTop = gridScroll.current;');
  const tracker = src.indexOf("target.addEventListener('scroll', track, { passive: true });");
  assert.ok(restore > 0 && tracker > restore, 'restore, then track');
  assert.match(src, /if \(openKey != null\) el\.scrollTop = 0;/);
  assert.equal((src.match(/href=\{/g) || []).length, 1, 'still exactly one href, the guarded action');
});

// #3253, #3248: the note on what the rule counts sits under the points, muted.
test('the count note reads under the points, and is absent without one', () => {
  const note = message('leaderboard:challenges.countNote.onPropose');
  const html = render({ ...VIEW, countNote: note });
  const points = html.indexOf('720 pts so far');
  const at = html.indexOf(note.replaceAll("'", '&#x27;')); // as React escapes it
  assert.ok(points >= 0 && at > points, 'after the points');
  assert.ok(at < html.indexOf('role="progressbar"'), 'before the rail');
  assert.match(html, /<p class="text-\[0\.8125rem\] text-zinc-500 dark:text-zinc-400">Counts when/);
  assert.doesNotMatch(render(VIEW), /Counts when/);
});

// ── #3650: the invite challenge's own note and per-person list ─────────

const INVITES_PEOPLE = [
  { key: '11', name: '@evan', word: 'counted', reason: 'Joined through your invite.' },
  { key: '12', name: '@ocank14', word: 'soon', reason: 'Joined through your invite. It shows here after the next count.' },
  { key: '13', name: '@snait', word: 'waiting', reason: 'They followed your link but haven’t joined yet. They join your community once they’re let into Homeroom.' },
  { key: '14', name: 'Someone you invited', word: 'notCounted', reason: 'They took someone else’s invite first. Each person counts once.' },
];

const INVITES_VIEW = {
  ...VIEW,
  cta: null, // the rail is followed by the note with nothing between them
  invitesNote: 'An invite counts when the person joins your community through your invite link.',
  invites: { state: 'ready', people: INVITES_PEOPLE },
};

test('the invite note sits directly under the rail, on an invite challenge only', () => {
  const html = render(INVITES_VIEW);
  const rail = html.indexOf('role="progressbar"');
  const note = html.indexOf('An invite counts when');
  assert.ok(rail > 0 && note > rail, 'after the rail');
  assert.ok(note < html.indexOf('data-tc-invites'), 'before the list');
  assert.match(html, /<p class="text-sm text-zinc-600 dark:text-zinc-400">An invite counts when/);
  // Any other challenge: neither the note nor the list exists, so the page
  // is exactly as it was.
  assert.doesNotMatch(render(VIEW), /data-tc-invites|An invite counts when|Your invites/);
});

test('the invite list reads as a section before What counts, one row a person', () => {
  const html = render(INVITES_VIEW);
  const list = html.indexOf('data-tc-invites');
  const whats = html.indexOf('>What counts<');
  assert.ok(list > 0 && whats > list, 'the list stands before What counts');
  assert.match(html, /Your invites/);
  // The rows in order, each the person's name over their reason.
  const rows = ['@evan', '@ocank14', '@snait', 'Someone you invited'];
  let at = list;
  for (const name of rows) {
    const i = html.indexOf(name);
    assert.ok(i > at, `${name} in the list`);
    at = i;
  }
  assert.match(html, /Joined through your invite\. It shows here after the next count\./);
});

test('the invite list’s status word: Counted in the finished colour, the rest quiet', () => {
  const html = render(INVITES_VIEW);
  assert.match(html, /text-emerald-700 dark:text-emerald-400">Counted</);
  for (const word of ['Counts soon', 'Waiting', 'Not counted']) {
    const i = html.indexOf(`>${word}</span>`);
    assert.ok(i > 0, `${word} is drawn`);
    assert.match(html.slice(i - 120, i), /text-zinc-500 dark:text-zinc-400/,
      `${word} is muted, not another accent`);
  }
});

test('the invite list’s loading, error and empty states', () => {
  // Loading: three skeleton rows, no names yet.
  const loading = render({ ...INVITES_VIEW, invites: { state: 'loading' } });
  assert.match(loading, /data-tc-invites/);
  assert.match(loading, /Your invites/);
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /@evan|@ocank14/);
  // Error: the list says so, and offers a retry.
  const error = render({ ...INVITES_VIEW, invites: { state: 'error' } });
  assert.match(error, /Couldn&#x27;t load your invites\./);
  assert.match(error, /id="tc-se-invites-retry"[^>]*>Try again<\/button>/);
  // Empty: nobody invited yet.
  const empty = render({ ...INVITES_VIEW, invites: { state: 'ready', people: [] } });
  assert.match(empty, /You haven&#x27;t invited anyone yet\./);
});

// #3226: a line on what points are for, under the points, whenever they show.
test('the points note reads under the points, and only when points show', () => {
  const note = message('leaderboard:challenges.detail.pointsNote');
  assert.equal(note, 'Points add up across challenges and set your place in the standings.');
  const html = render(VIEW);
  const at = html.indexOf(note);
  assert.ok(at > html.indexOf('720 pts so far'), 'after the points');
  assert.ok(at < html.indexOf('src="/illustrations/'), 'before the artwork');
  assert.doesNotMatch(render({ ...VIEW, amount: null }), /set your place in the standings/,
    'no points shown: no note either');
});

// ── #3247: which credits made the count ─────────────────────────────────

const CREDITS = [
  { text: 'Add a dark mode', points: 500, at: '2026-10-02T16:32:00.000Z', precision: 'instant',
    change: { slug: 'my app', sessionId: 41, prNumber: 7 } },
  { text: 'Drafted a plan', points: 100, at: null, precision: null,
    change: { slug: 'one', sessionId: 42, prNumber: null } },
  { text: 'Accepted proposal', points: 300, at: null, precision: null, change: null },
];

test('#3247: What counted sits between the action and What counts, and links each change it can show', () => {
  const html = render({ ...VIEW, credits: CREDITS });
  assert.ok(html.includes(`>${message('leaderboard:challenges.detail.counted')}<`));
  assert.ok(html.indexOf('Set up your node') < html.indexOf('tc-se-detail-credits'));
  assert.ok(html.indexOf('tc-se-detail-credits')
    < html.indexOf(`>${message('leaderboard:challenges.detail.requirements')}<`));
  assert.match(html, /<a href="#app\/my%20app\/dev\/changes\/7"[^>]*>Add a dark mode<\/a>/);
  assert.match(html, /<a href="#app\/one\/dev\/proposals\/42"[^>]*>Drafted a plan<\/a>/);
  assert.match(html, /<span class="block[^"]*">Accepted proposal<\/span>/, 'no address: plain words, no link');
  assert.match(html, /\+500/);
});

test('#3247: a weekly challenge says the list is this week; no credits, no section', () => {
  const weekly = render({ ...VIEW, credits: CREDITS, creditsWeekly: true });
  assert.ok(weekly.includes(`>${message('leaderboard:challenges.detail.countedWeek')}<`));
  for (const credits of [[], undefined]) {
    assert.doesNotMatch(render({ ...VIEW, credits }), /tc-se-detail-credits/);
  }
});
