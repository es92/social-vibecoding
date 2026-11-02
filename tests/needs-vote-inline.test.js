'use strict';

// #3613: on Needs you, the line for the group is written INLINE, on the vote
// sheet, in the card's own vote format — not in a prompt card castVote raised
// after "Vote yes" was pressed.
//
// The form is EXECUTED (tests/lib/render-tsx.js): a real Needs you row, built
// by the Communities feed's own adapter (needs-reel.tsx `reelRows`), is drawn
// through `NeedsVoteForm`, which is what the sheet renders when Vote is
// pressed. renderToStaticMarkup runs no effects and no clicks, so the press
// itself (Vote → toggleSheet('vote') → this form) and the send (the line goes
// to castVote as `reason`, so castVote never asks) are pinned from source.
//
// Run with: node --test tests/needs-vote-inline.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APP_VIEW = read('public/js/app-view.js');

const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');

const item = {
  kind: 'proposal', id: 42, title: 'Dark mode', summary: 'Adds a dark theme.', author: 'ada',
  number: 7, epoch: 3, at: null, yes: 1, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
};
const noop = () => {};
const form = (over) => renderToHtml(createElement(NeedsVoteForm, {
  row: reelRows([item])[0], side: 'yes', line: '', noChoice: null,
  onSide: noop, onLine: noop, onNoChoice: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
  ...(over || {}),
}));

test('pressing Vote on a Needs you row opens the sheet, and the sheet holds the inline form', () => {
  assert.match(WORKSHOP, /data-ws-rail-btn="vote"[\s\S]{0,400}?onClick=\{\(\) => toggleSheet\('vote'\)\}/, 'Vote opens the vote sheet');
  const sheet = WORKSHOP.slice(WORKSHOP.indexOf('data-ws-sheet="vote"'), WORKSHOP.indexOf('dev-ws-keys-hint'));
  assert.match(sheet, /<NeedsVoteForm\b/, 'and the sheet draws the form');
  assert.ok(!/data-ws-answer-btn="(yes|no)"/.test(sheet), 'not the bare Yes/No pair that led to the prompt card');
});

test('the form is the card\'s vote picker: the switch, the line for the group, Cancel and the send', () => {
  const html = form();
  assert.match(html, /^<div class="dev-ws-vote-form" data-ws-vote-form="" data-side="yes">/);
  assert.match(html, /class="dev-vote-switch"/, 'the card\'s Yes/No switch');
  assert.match(html, /class="dev-vote-switch-opt dev-vote-switch-yes" aria-pressed="true"[^>]*data-act="castVote"/, 'Yes on by default, voting with castVote');
  assert.match(html, /<label class="dev-vote-reason-label" for="dev-ws-vote-reason-needs-proposal-42">Add a line for the group, if you like\.<\/label>/,
    'the line for the group is right there, labelled as on a card');
  assert.match(html, /<textarea id="dev-ws-vote-reason-needs-proposal-42"[^>]*class="dev-vote-reason-box"/, 'with its box inline');
  assert.match(html, /class="dev-vote-reason-cancel">Cancel</);
  assert.match(html, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes</);
  assert.ok(!/role="dialog"/.test(html), 'nothing in the form is a dialog of its own');
});

test('on No the sheet lists the reasons, and the send stays off until one is picked', () => {
  const empty = form({ side: 'no' });
  assert.match(empty, /class="dev-vote-why" role="radiogroup"/, 'the four answers');
  for (const key of ['notWorking', 'approach', 'notNeeded', 'other']) {
    assert.match(empty, new RegExp(`role="radio" aria-checked="false" class="dev-vote-why-opt" data-vote-why="${key}"`));
  }
  assert.match(empty, /Add more, if you like\./, 'the optional line is labelled under them');
  assert.match(empty, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no</,
    'a No cannot be sent without an answer');
  const picked = form({ side: 'no', noChoice: 'notWorking', line: 'Too dark' });
  assert.match(picked, /role="radio" aria-checked="true" class="dev-vote-why-opt" data-vote-why="notWorking"/);
  assert.match(picked, /class="dev-vote-reason-send dev-vote-reason-send-no">Vote no</, 'an answer sends it');
  assert.match(form({ side: 'yes' }), /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes</, 'a Yes needs nothing');
});

test('the sheet sends its line with the vote, so castVote does not ask again', () => {
  assert.match(WORKSHOP, /answer\('yes', undefined, voteTrimmed \|\| null\)/, 'a Yes sends its line');
  assert.match(WORKSHOP, /if \(voteSide === 'no'\) \{\s*if \(!voteChoice\) return;/, 'a No sends only once an answer is picked');
  assert.match(WORKSHOP, /answer\('no', undefined, composeNoReason\(choice, voteLine,/, 'and carries the answer with its line');
  assert.match(WORKSHOP, /const opts = reason === undefined \? \{ onSend \} : \{ onSend, reason \};/,
    'a line (or null) rides in the options bag; only the swipe leaves it out');
  // castVote asks only when the bag has no `reason` key at all.
  const resolve = APP_VIEW.slice(APP_VIEW.indexOf('  async _resolveVoteReason(vote, opts)'), APP_VIEW.indexOf('  async castVote(sessionId'));
  assert.match(resolve, /hasOwnProperty\.call\(o, 'reason'\)[\s\S]*return AppView\._askVoteReason\(vote\);/);
  // Y and N turn the switch rather than voting by themselves.
  assert.match(WORKSHOP, /\(k === 'y' \|\| k === 'Y'\) && sheet === 'vote'\) \{ setVoteSide\('yes'\); return; \}/);
  assert.match(WORKSHOP, /\(k === 'n' \|\| k === 'N'\) && sheet === 'vote'\) \{ setVoteSide\('no'\); return; \}/);
});

// #4794: a vote saved from the Communities reel takes its card out of the
// screen's own feed copy at once, so going back and re-entering Needs you
// cannot redraw it as still owed. The reel learns of the vote ONLY where the
// feed has it: inside the `ok === true` branch, after setAnswered — never on
// a cancel, a refusal or a network failure.
test('#4794: onAnswered fires only where the vote is saved, and the reel keeps the feed it was drawn', () => {
  const REEL = read('frontend/src/features/workshop/needs-reel.tsx');
  const SCREEN = read('frontend/src/features/workshop/index.tsx');
  const answer = WORKSHOP.slice(WORKSHOP.indexOf('const answer = (which'), WORKSHOP.indexOf('const voteTrimmed'));
  const okBranch = answer.slice(answer.indexOf('if (ok === true) {'), answer.indexOf('} else if (pinnedHere)'));
  assert.match(okBranch, /setAnswered\(/, 'the confirmation is drawn first, as it is today');
  assert.match(okBranch, /try \{ onAnswered\(row, which\); \} catch/, 'then the screen that owns the feed copy is told');
  assert.equal((answer.match(/onAnswered/g) || []).length, 2,
    'the hook appears twice in answer() — the guard and the call, both inside the ok branch');
  assert.ok(!WORKSHOP.includes('onAnswered={'), 'a project page passes nothing; its refresh already drops the row');

  // The reel acts only on a proposal's answer, with the epoch of the source
  // item; a group decision has no Yes or No in the feed and never reaches it.
  assert.match(REEL, /onAnswered\?: \(id: number, epoch: number \| null\) => void;/);
  assert.match(REEL, /row\.askAbout\.kind === 'proposal'/);
  assert.match(REEL, /epochs\.get\(row\.key\)/);
  // A vote on the last card empties the feed copy; once the feed has been
  // drawn this mount, the reel keeps it drawn instead of switching to the
  // empty line over the viewer's head.
  assert.match(REEL, /drawnRef\.current = true/);
  assert.match(REEL, /!items && !drawnRef\.current/);
  assert.match(REEL, /!shown\.length && !drawnRef\.current/);
  // And the screen wires the reel to the controller that owns the store.
  assert.match(SCREEN, /onAnswered=\{\(id, epoch\) => workshopController\.answered\(id, epoch\)\}/);
  assert.match(SCREEN, /answered\(id: number, epoch: number \| null\)/);
});

// An approval row (a change on a project that is just yours) asks for a note
// from the row itself, before the community read has landed and on the
// staging demo's Just you card, whose project reads as public.
test('an approval row\'s Yes line is a note before any community read; a group row keeps its line', () => {
  const approval = reelRows([{ ...item, approve: true }])[0];
  assert.equal(approval.yes.approve, true, 'the reel marks the row an approval');
  const yes = form({ row: approval });
  assert.match(yes, /<label class="dev-vote-reason-label" for="dev-ws-vote-reason-needs-proposal-42">Add a note, if you like\.<\/label>/);
  assert.doesNotMatch(yes, /for the group/);
  assert.match(form({ row: approval, side: 'no' }), /class="dev-vote-why" role="radiogroup"/, 'No is the same');
  assert.match(form(), /Add a line for the group, if you like\./, 'a group row keeps its wording');
});

// #22: on a project that is just yours, the Yes line is a note: "for the
// group" spoke to a group a solo project does not have. The form reads who
// the row's project is for from the hub's shared community read
// (community-card.tsx useCommunity), handed in here as that import so the
// answer can be set. The No side is unchanged, its line included.
test('#22: on a solo project the Yes line is a note, asked of the row\'s own project; No is unchanged', () => {
  const real = loadTsx('frontend/src/features/dev-board/workshop/community-card.tsx');
  const asked = [];
  let audience = 'solo';
  const { NeedsVoteForm: SoloForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx', {
    stubs: {
      './community-card': {
        ...real,
        useCommunity: (slug) => { asked.push(slug); return { audience }; },
      },
    },
  });
  const draw = (over) => renderToHtml(createElement(SoloForm, {
    row: reelRows([item])[0], slug: 'open-project', side: 'yes', line: '',
    onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
    ...(over || {}),
  }));

  const yes = draw();
  assert.match(yes, /<label class="dev-vote-reason-label" for="dev-ws-vote-reason-needs-proposal-42">Add a note, if you like\.<\/label>/);
  assert.doesNotMatch(yes, /for the group/);
  assert.deepEqual(asked.slice(-1), ['demo-app'], 'the row\'s project, not the page\'s');

  const no = draw({ side: 'no' });
  assert.match(no, /class="dev-vote-why" role="radiogroup"/);
  assert.match(no, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no</, 'No waits for its answer');

  audience = 'invited';
  assert.match(draw(), /Add a line for the group, if you like\./, 'a group keeps its wording');
  assert.match(WORKSHOP, /<NeedsVoteForm\s+row=\{row\}\s+slug=\{slug\}/, 'the sheet hands the form the page\'s project for rows without their own');
});
