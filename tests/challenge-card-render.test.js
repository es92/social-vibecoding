// The challenge card parts (ITERATION 03), rendered.
//
// WHAT THIS PINS. A phone-width card body is about 170px on a 320px phone,
// and the defect this exists for is copy that wraps or clips there. It is a
// render property, not a string property, so the parts are rendered
// (tests/lib/render-tsx.js) and the classes that keep the copy on one line are
// asserted on the markup they end up in:
//   * the rail is its own full-width row, holding the state only, and its
//     label `truncate`s;
//   * the meta line under the title ("5d left · 500 pts") is one line: the
//     deadline never shrinks and the reward truncates after it;
//   * the rail is a progressbar, with aria-valuenow ONLY when the fill is a
//     number (indeterminate otherwise), and draws a bar only when counted.
//
// Run with: node --test tests/challenge-card-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const Card = loadTsx('frontend/src/features/leaderboard/challenge-card.tsx');

const rail = (props) => renderToHtml(createElement(Card.ProgressRail, props));
const card = (view) => renderToHtml(createElement(Card.ChallengeCard, { view }));
const classOf = (html, marker) => {
  const m = html.match(new RegExp(`<[^>]*${marker}[^>]*class="([^"]*)"|<[^>]*class="([^"]*)"[^>]*${marker}`));
  return m ? (m[1] || m[2]) : '';
};

test('the rail is a progressbar; indeterminate rails omit aria-valuenow', () => {
  const counted = rail({ state: 'progress', label: '3/8 tried', fill: 0.375, name: 'Try apps', counted: true });
  assert.match(counted, /role="progressbar"/);
  assert.match(counted, /aria-valuenow="38"/);
  assert.match(counted, /aria-label="Try apps: 3\/8 tried"/);
  assert.match(counted, /aria-valuetext="3\/8 tried"/, 'the spoken value is the visible count, not a rounded percent');
  assert.match(counted, /style="width:max\(0\.375rem, 38%\)"/, 'the fill is drawn at the same fraction, never under the stub');
  assert.match(rail({ state: 'progress', label: '1/50 tried', fill: 1 / 50, name: 'x', counted: true }),
    /style="width:max\(0\.375rem, 2%\)"/, 'a first step is never narrower than none');

  const open = rail({ state: 'progress', label: 'Started', fill: null, name: 'Produce blocks' });
  assert.match(open, /role="progressbar"/);
  assert.doesNotMatch(open, /aria-valuenow/, 'no number to announce');
  assert.doesNotMatch(open, /style="width/, 'and no fill to draw');

  const zero = rail({ state: 'new', label: '0/3 Apps tried', fill: 0, name: 'Try Three Apps', counted: true });
  assert.match(zero, /aria-valuenow="0"/);
  assert.match(zero, /style="width:0\.375rem"/, 'a counted rail at zero draws the stub: a track not yet run');
  const yesNo = rail({ state: 'new', label: 'Not started', fill: 0, name: 'x' });
  assert.match(yesNo, /aria-valuenow="0"/);
  assert.doesNotMatch(yesNo, /style="width/, 'a yes-or-no rail is words alone');

  const bare = rail({ state: 'new', label: '', fill: null, name: 'Produce your first block' });
  assert.doesNotMatch(bare, /aria-valuenow/, 'a rail that cannot see progress announces no value');
  assert.doesNotMatch(bare, /truncate/, 'and draws no label span');
  assert.match(bare, /aria-label="Produce your first block"/, 'but is still named');
  const done = rail({ state: 'done', label: 'Done', fill: 1, name: 'x', counted: true });
  assert.match(done, /aria-valuenow="100"/);
  assert.doesNotMatch(done, /style="width/, 'a finished rail is the green tone, not a full bar');
});

test('rail copy never wraps: the rail is one full-width row and its label truncates', () => {
  const html = rail({ state: 'progress', label: '180/500 blocks produced this week', fill: 0.36, name: 'x', counted: true });
  const railClass = classOf(html, 'role="progressbar"').split(' ');
  for (const cls of ['w-full', 'min-w-0', 'overflow-hidden', 'h-9', 'rounded-lg']) {
    assert.ok(railClass.includes(cls), `rail has ${cls}`);
  }
  assert.match(html, /<span class="relative min-w-0 truncate">180\/500 blocks produced this week<\/span>/,
    'the label is a single truncating line');
});

test('each state has its own rail tone, and only the accent/emerald/zinc scales', () => {
  const tones = ['new', 'progress', 'done'].map((state) =>
    classOf(rail({ state, label: 'l', fill: state === 'done' ? 1 : 0, name: 'x' }), 'role="progressbar"'));
  assert.equal(new Set(tones).size, 3, 'three distinct recipes');
  assert.match(tones[2], /bg-emerald-500\/10/);
  for (const t of tones) assert.doesNotMatch(t, /\b(gray|indigo)-/, 'no banned scales');
});

test('the tile is an empty neutral face: the group headings carry the category', () => {
  const html = renderToHtml(createElement(Card.ChallengeTile, {}));
  assert.match(html, /h-20 w-20 rounded-2xl/, 'the xl IconTile');
  assert.match(html, /aria-hidden="true"/, 'decorative until it holds artwork');
  assert.doesNotMatch(html, /<span/, 'no category text inside it');
});

const META_OPEN = '<div class="flex min-w-0 items-baseline gap-1.5 text-[0.8125rem] leading-5">';
const DEADLINE = (t) => `<span class="shrink-0 text-zinc-500 dark:text-zinc-400">${t}</span>`;
const DOT = '<span aria-hidden="true" class="shrink-0 text-zinc-400 dark:text-zinc-500">·</span>';
const REWARD = (t) => `<span class="min-w-0 truncate font-medium text-amber-800 dark:text-amber-300">${t}</span>`;
const EARNED = (t) => `<span class="min-w-0 truncate font-medium text-emerald-700 dark:text-emerald-400">${t}</span>`;

test('ChallengeCard is one card for both surfaces: tile, title, meta line and a clean rail', () => {
  const view = {
    goal: 'Try apps', task: 'Open three apps', reward: '500 pts', icon: '🧪',
    state: 'progress', stateLabel: '2/3 tried', fill: 2 / 3, counted: true, deadline: '5d left', earned: null,
  };
  const html = renderToHtml(createElement(Card.ChallengeCard, {
    view, className: 'home-challenge-card', 'data-challenge-id': '7',
  }));
  assert.match(html, /^<div class="home-challenge-card flex items-center gap-3 bg-white/, 'the surface class leads');
  assert.match(html, /data-challenge-id="7"/);
  assert.match(html, />🧪<\/span>/, 'the kind icon sits in the tile');
  assert.doesNotMatch(html, /Open three apps/, 'the card holds no description, even when handed one');
  assert.doesNotMatch(html, /<p /);
  assert.doesNotMatch(html, /title=/, 'no tooltips');

  // Title, then ONE meta line — the deadline beside the reward.
  assert.ok(html.includes(
    '<div class="min-w-0"><div class="truncate text-base font-medium leading-6 text-zinc-900 dark:text-zinc-100">Try apps</div>'
    + `${META_OPEN}${DEADLINE('5d left')}${DOT}${REWARD('500 pts')}</div></div>`),
  'the title, then "5d left · 500 pts" on one line');

  // Title and rail are one group, centred beside the tile rather than
  // stretched to its edges, and the rail is the group's last row.
  assert.match(html, /<div class="flex min-w-0 flex-1 flex-col gap-2">/);
  assert.doesNotMatch(html, /justify-between|self-stretch/);
  const railAt = html.indexOf('role="progressbar"');
  assert.ok(html.indexOf('500 pts') < railAt, 'the reward is above the rail');
  assert.doesNotMatch(html.slice(railAt), /pts/, 'the rail holds the state and nothing else');
  assert.doesNotMatch(html.slice(html.indexOf('flex min-w-0 flex-1 flex-col')), /flex-wrap|p-0\.5|bg-zinc-100/,
    'no capsule around the rail (the tile keeps its own neutral face)');
  assert.match(html, /aria-valuetext="2\/3 tried"/);
  assert.match(html, /style="width:max\(0\.375rem, 67%\)"/);
});

test('the meta line drops what it does not have, and never holds a stray dot', () => {
  const base = { goal: 'Try Three Apps', icon: null, state: 'new', stateLabel: 'Not started', fill: 0, earned: null };
  const rewardOnly = card({ ...base, reward: '500 pts', deadline: null });
  assert.ok(rewardOnly.includes(`${META_OPEN}${REWARD('500 pts')}</div>`), 'no deadline: the reward alone');
  const deadlineOnly = card({ ...base, reward: null, deadline: '23h left' });
  assert.ok(deadlineOnly.includes(`${META_OPEN}${DEADLINE('23h left')}</div>`), 'no reward: the deadline alone');
  const neither = card({ ...base, reward: null, deadline: null });
  assert.doesNotMatch(neither, /items-baseline/, 'neither: no meta line at all');
  assert.doesNotMatch(neither, /·/);

  const done = card({
    ...base, state: 'done', stateLabel: 'Done', fill: 1, counted: true,
    reward: '900 pts', earned: 'Earned 900 pts', deadline: null,
  });
  assert.ok(done.includes(`${META_OPEN}${EARNED('Earned 900 pts')}</div>`),
    'a finished challenge says what was earned, in emerald, with no deadline');
  assert.doesNotMatch(done, /text-amber-800/, 'not the reward on offer');
  assert.doesNotMatch(done, /style="width/, 'and its rail draws no bar');

  const zero = card({ ...base, stateLabel: '0/3 Apps tried', counted: true, reward: '500 pts', deadline: '17d left' });
  assert.match(zero, /style="width:0\.375rem"/, 'the stub at 0 of 3');
  assert.match(zero, />0\/3 Apps tried</);
});

test('the detail page draws the same rail and meta line at page size', () => {
  const lg = classOf(rail({ state: 'progress', label: '180/500 blocks', fill: 0.36, name: 'x', counted: true, size: 'lg' }),
    'role="progressbar"').split(' ');
  for (const c of ['h-10', 'text-[0.9375rem]', 'rounded-[0.75rem]', 'w-full', 'min-w-0', 'overflow-hidden']) {
    assert.ok(lg.includes(c), `lg rail has ${c}`);
  }
  assert.ok(!lg.includes('h-9') && !lg.includes('rounded-lg'), 'one size, not both');
  const meta = renderToHtml(createElement(Card.ChallengeMeta, { deadline: '3d left', text: '720 pts so far', size: 'lg' }));
  assert.equal(meta, `<div class="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">${DEADLINE('3d left')}${DOT}${REWARD('720 pts so far')}</div>`);
  assert.equal(renderToHtml(createElement(Card.ChallengeMeta, { text: 'Earned 900 pts', earned: true })),
    `${META_OPEN}${EARNED('Earned 900 pts')}</div>`, 'the card size is the card’s line, unchanged');
  assert.equal(renderToHtml(createElement(Card.ChallengeMeta, {})), '', 'nothing to say, no line');
});
