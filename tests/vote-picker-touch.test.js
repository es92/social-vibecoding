'use strict';

// The vote picker is ONE panel (dev-card.tsx VoteButton / VotePicker): a
// two-way switch across the top with Yes on by default, the line box under
// it from the start, and Cancel beside the one button that reads "Vote yes"
// or "Vote no" with the switch. The same panel is the anchored popover on
// desktop and a kit bottom sheet on touch (#1688 follow-ups).
//
//   1. the panel: the "Your vote" header, the switch and its tallies,
//      "Still yes" / "Not this time"
//      on a prior Yes, the label and placeholder that follow the side, and
//      the button that sends whichever side is chosen, line or not;
//   2. VoteButton draws the panel once for both homes; on touch the kit
//      sheet comes first and the action sheet + prompt card are the
//      fallback; the box takes focus with the tap that needs it;
//   3. the styles: the switch's two states, the popover's even inset, and
//      the sheet variant at tap-target size.
//
// Run with: node --test tests/vote-picker-touch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const CARD = 'frontend/src/features/dev-board/card/dev-card.tsx';
const SRC = fs.readFileSync(path.join(__dirname, '..', CARD), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

const yes = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', title: 'Yes', label: 'Yes (2/3)', tally: '2/3', act: { fn: 'castVote', args: [7, 'yes', 3] } };
const no = { key: 'no', cls: 'gc-vote-btn gc-vote-btn-no', title: 'No', label: 'No (0/3)', tally: '0/3', act: { fn: 'castVote', args: [7, 'no', 3] } };
// The count a spec carries on its own, as dev-card.tsx reads it: never parsed out of the label.
const tally = (a) => a.tally || '';
const noop = () => {};
const picker = (over) => renderComponent(CARD, 'VotePicker', {
  yes, no, prior: null, side: 'yes', line: '', reasonId: 'dev-vote-reason-7', tally, withLine: true,
  onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop, ...(over || {}),
});

// ── 1. The panel ──────────────────────────────────────────────────────

test('the switch: Yes on by default with its tally, No beside it; "Still yes" / "Not this time" on a prior Yes', () => {
  const html = picker();
  assert.match(html, /<div class="dev-vote-switch-label" id="dev-vote-reason-7-head">Your vote<\/div><div class="dev-vote-switch" role="group" aria-labelledby="dev-vote-reason-7-head">/,
    'the "Your vote" header, then the switch it names');
  assert.match(html, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-yes" aria-pressed="true"[^>]*data-act="castVote"[^>]*>[\s\S]*?Yes<span class="dev-vote-n">2\/3<\/span><\/button>/);
  assert.match(html, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-no" aria-pressed="false"[^>]*>[\s\S]*?No<span class="dev-vote-n">0\/3<\/span><\/button>/);
  const flipped = picker({ side: 'no' });
  assert.match(flipped, /dev-vote-switch-yes" aria-pressed="false"/);
  assert.match(flipped, /dev-vote-switch-no" aria-pressed="true"/);
  const prior = picker({ prior: 'yes' });
  assert.match(prior, />Still yes<span/);
  assert.match(prior, />Not this time<span/);
});

test('the box is there from the start and its words follow the switch; a No asks why before it can be sent', () => {
  const onYes = picker();
  assert.match(onYes, /<div class="dev-vote-reason" data-vote-reason="yes">/);
  assert.match(onYes, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">Add a line for the group, if you like\.<\/label>/);
  assert.match(onYes, /<textarea id="dev-vote-reason-7" class="dev-vote-reason-box" rows="2" maxLength="280" placeholder="What do you like about it\?"/);
  assert.match(onYes, /<button type="button" class="dev-vote-reason-cancel">Cancel<\/button><button type="button" class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes<\/button>/,
    'Cancel, then the one button: a Yes is one click');
  assert.doesNotMatch(onYes, /dev-vote-why/, 'a Yes is not asked why');
  const onNo = picker({ side: 'no' });
  assert.match(onNo, /<div class="dev-vote-reason" data-vote-reason="no">/);
  assert.match(onNo, /class="dev-vote-why" role="radiogroup" aria-labelledby="dev-vote-reason-7-why"/,
    'the four answers, named by the question');
  assert.ok(onNo.includes(message('project:card.vote.picker.noLabel')), 'the list is named "What’s not working for you?"');
  for (const key of ['notWorking', 'approach', 'notNeeded', 'other']) {
    assert.match(onNo, new RegExp(`role="radio" aria-checked="false" class="dev-vote-why-opt" data-vote-why="${key}"`));
  }
  assert.match(onNo, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">Add more, if you like\.<\/label>/,
    'the optional line is under the answers');
  assert.match(onNo, /placeholder="What would you want to change\?"/);
  assert.match(onNo, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no<\/button>/,
    'a No waits for its answer, line or not');
  const picked = picker({ side: 'no', noChoice: 'approach' });
  assert.match(picked, /role="radio" aria-checked="true" class="dev-vote-why-opt" data-vote-why="approach"/);
  assert.match(picked, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no">Vote no<\/button>/,
    'an answer sends it');
  const blank = picker({ side: 'no', noChoice: 'notNeeded', line: '   ' });
  assert.match(blank, /class="dev-vote-reason-send dev-vote-reason-send-no">Vote no<\/button>/, 'and the line stays optional');
});

test('#22: on a project that is just yours the Yes line is a note; the No side is the same', () => {
  // "Add a line for the group" spoke to a group that a solo project does not
  // have. Only the Yes side's optional line changes: No keeps its words, and
  // now its line is optional too.
  const onYes = picker({ solo: true });
  assert.match(onYes, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">Add a note, if you like\.<\/label>/);
  assert.doesNotMatch(onYes, /for the group/);
  assert.match(onYes, /placeholder="What do you like about it\?"/, 'the box itself is the same');
  assert.match(onYes, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes<\/button>/, 'and a Yes needs no note');
  const onNo = picker({ solo: true, side: 'no' });
  assert.match(onNo, /class="dev-vote-why" role="radiogroup"/, 'the No side asks why on a solo project too');
  assert.ok(onNo.includes(message('project:card.vote.picker.noLabel')));
  assert.match(onNo, /placeholder="What would you want to change\?"/);
  assert.match(onNo, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no<\/button>/,
    'a No waits for its answer');
  assert.match(picker({ solo: false }), /Add a line for the group, if you like\./, 'a group keeps its wording');
  // The card's button reads it off the Yes spec, which app-view.js marks
  // from the app's own record.
  const fn = SRC.slice(SRC.indexOf('export function VoteButton('), SRC.indexOf('export function VotePicker('));
  assert.match(fn, /solo=\{!!yes\.solo\}/);
});

// An approval is only asked on a project that is just yours, so its Yes line
// is a note even when the caller's `solo` has not caught up: the Needs you
// sheet reads it from a community lookup that may not have landed, and the
// staging demo's Just you project reads as public.
test('an approval\'s Yes line is a note whatever `solo` says; its No side is the same', () => {
  for (const solo of [false, undefined]) {
    const onYes = picker({ approve: true, solo });
    assert.match(onYes, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">Add a note, if you like\.<\/label>/, String(solo));
    assert.doesNotMatch(onYes, /for the group/, String(solo));
    const onNo = picker({ approve: true, solo, side: 'no' });
    assert.match(onNo, /class="dev-vote-why" role="radiogroup"/, String(solo));
    assert.match(onNo, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Don’t approve<\/button>/,
      'Don’t approve is a No, so it asks for a reason too');
  }
  assert.match(picker({ approve: false, solo: false }), /Add a line for the group, if you like\./, 'a group vote keeps its wording');
});

test('withLine false: the switch and the button only, and the send is never off', () => {
  // #2603 left no caller passing false — every vote the group casts carries
  // a line now — but the panel still draws without the box for anything
  // demoted into this button that is not a vote.
  const html = picker({ withLine: false });
  assert.doesNotMatch(html, /dev-vote-reason-box|dev-vote-reason-label|dev-vote-why/);
  assert.match(html, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes<\/button>/);
  const noSide = picker({ withLine: false, side: 'no' });
  assert.match(noSide, /class="dev-vote-reason-send dev-vote-reason-send-no">Vote no<\/button>/, 'never off without an answer to wait for');
});

test('#2603: a governance vote takes the same panel, and its line lands in castIssueVote\'s third slot', () => {
  const fn = SRC.slice(SRC.indexOf('export function VoteButton('), SRC.indexOf('export function VotePicker('));
  assert.match(fn, /const isVote = yes\.act\?\.fn === 'castVote' \|\| yes\.act\?\.fn === 'castIssueVote';/,
    'the box is drawn for a governance vote too');
  // castVote(sessionId, vote, expectedEpoch, opts) vs
  // castIssueVote(issueId, vote, opts): padding both to three would put the
  // options bag where castIssueVote has no parameter at all.
  assert.match(SRC, /const VOTE_ARITY: Record<string, number> = \{ castVote: 3, castIssueVote: 2 \};/);
  assert.match(fn, /const positional = VOTE_ARITY\[a\.act\.fn\] \?\? 3;\s*while \(args\.length < positional\) args\.push\(null\);/,
    'the slots are padded per function, so the bag always lands last');
  const gov = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', title: 'Yes', label: 'Yes (1/2)', tally: '1/2', act: { fn: 'castIssueVote', args: [11, 'up'] } };
  const html = picker({ yes: gov, reasonId: 'dev-vote-reason-11' });
  assert.match(html, /<textarea id="dev-vote-reason-11" class="dev-vote-reason-box"/,
    'the same box, keyed by the issue id');
  assert.match(html, /data-act="castIssueVote"/);
});

// ── 2. The two homes ──────────────────────────────────────────────────

test('VoteButton draws the panel once for both homes, opens on Yes, and sends one call with the line', () => {
  const fn = SRC.slice(SRC.indexOf('export function VoteButton('), SRC.indexOf('export function VotePicker('));
  assert.equal((fn.match(/<VotePicker\b/g) || []).length, 1, 'one VotePicker element');
  assert.equal((fn.match(/\{picker\}/g) || []).length, 2, 'rendered into the popover and into the sheet');
  assert.match(fn, /createPortal\(\s*<div\s+ref=\{popRef\}\s+className="dev-vote-pop"\s+role="dialog"\s+aria-label=\{heading\}\s+data-side=\{side\}/,
    'desktop: the anchored popover, a dialog now that it holds a form');
  assert.match(fn, /createPortal\(\s*<div className="dev-vote-sheet" role="dialog" aria-label=\{heading\} data-vote-sheet="" data-side=\{side\}>\s*\{picker\}\s*<\/div>,\s*sheetEl,/,
    'touch: the same panel inside the kit sheet\'s content element');
  // #3977: both homes are named by the picker's own header, which is "Your
  // approval" on a solo change whose Yes is the one it needs.
  assert.match(fn, /const heading = approve \? t\('project:card\.vote\.dialog\.approval'\) : t\('project:card\.vote\.dialog\.vote'\);/);
  assert.deepEqual([message('project:card.vote.dialog.approval'), message('project:card.vote.dialog.vote')], ['Your approval', 'Your vote']);
  assert.match(fn, /aria-haspopup="dialog"/, 'the face says what it opens');
  assert.match(fn, /const startSide = \(\): 'yes' \| 'no' => \(mine === 'no' \? 'no' : 'yes'\);/, 'Yes by default; a viewer who voted No starts from No');
  assert.match(fn, /if \(open \|\| sheetRef\.current\) \{ shut\(\); return; \}\s*setSide\(startSide\(\)\);\s*setLine\(''\);/, 'reset on every open');
  assert.match(fn, /if \(!isVote\) \{ send\(spec, null\); return; \}/, 'anything that is not a vote sends no reason');
  assert.match(fn, /if \(side === 'no'\) \{\s*if \(!noChoice\) return;\s*send\(no, composeNoReason\(/, 'a No is held back until an answer is picked');
  assert.match(fn, /send\(spec, trimmed \|\| null\);/, 'a Yes sends with its optional line, null for none');
  assert.match(fn, /if \(!isVote\) \{ call\(a\.act\); return; \}/, 'anything that is not a vote is the spec\'s own call');
  assert.doesNotMatch(fn, /dev-vote-reason-box|dev-vote-opt|data-asking|setAsking/, 'the rows and the two-step are gone');
});

test('on touch the kit sheet comes first; the action sheet and the prompt card are the fallback', () => {
  const toggle = SRC.slice(SRC.indexOf('const toggle = ('), SRC.indexOf('useEffect(() => {', SRC.indexOf('const toggle = (')));
  const sheetAt = toggle.indexOf('if (openSheet(pu)) return;');
  const actionAt = toggle.indexOf('pu.actionSheet({');
  assert.ok(sheetAt > -1 && actionAt > -1 && sheetAt < actionAt, 'the sheet is tried before the action sheet');
  assert.match(toggle, /pu\.isTouch\(\)\) \{\s*if \(openSheet\(pu\)\) return;/, 'inside the touch branch, first');
  const openSheet = SRC.slice(SRC.indexOf('const openSheet = ('), SRC.indexOf('const toggle = ('));
  assert.match(openSheet, /if \(typeof pu\.sheet !== 'function'[^)]*\) return false;/, 'no sheet API: fall back');
  assert.match(openSheet, /pu\.sheet\(\{\s*contentEl: panel,/, 'the panel is the kit\'s contentEl');
  assert.match(openSheet, /if \(!handle \|\| typeof handle\.dismiss !== 'function'\) return false;/, 'the kit missing (null handle): fall back');
  assert.match(openSheet, /onDismiss: \(\) => \{\s*sheetRef\.current = null;\s*setSheetEl\(null\);\s*setLine\(''\);/,
    'a backdrop tap or a drag clears the picker the same way a send does');
  assert.equal(SRC.split('const pickTouch = (').length - 1, 1, 'defined once');
  assert.equal(SRC.split('pickTouch(').length - 1, 2, 'called from the two fallback rows only');
  const shut = SRC.slice(SRC.indexOf('const shut = () => {'), SRC.indexOf('const send = ('));
  assert.match(shut, /sheet\.dismiss\(\);/, 'closing the picker takes the sheet down');
  assert.match(SRC, /useEffect\(\(\) => \(\) => \{\s*const sheet = sheetRef\.current;\s*if \(sheet\) \{ sheetRef\.current = null; sheet\.dismiss\(\); \}\s*\}, \[\]\);/,
    'and so does the card going away under it');
  assert.match(SRC, /useIsoLayoutEffect\(\(\) => \{\s*if \(open\) boxRef\.current\?\.focus\(\);\s*\}, \[open\]\);/,
    'focus with the desktop popover only — the answers come first now, and a phone keyboard would cover them');
});

// ── 3. The styles ─────────────────────────────────────────────────────

test('the switch has two filled states, the popover one even inset, and the sheet variant tap-target rows', () => {
  const rule = (sel) => (new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS) || [])[1] || '';
  assert.match(rule('.dev-vote-pop'), /width: 312px/);
  assert.match(rule('.dev-vote-pop'), /padding: 10px 10px 8px/, 'the switch sits off the edges like the box and the buttons');
  assert.match(rule('.dev-vote-switch'), /display: flex/);
  assert.match(rule('.dev-vote-switch-opt'), /flex: 1 1 0/, 'equal halves');
  assert.match(rule('.dev-vote-switch-opt'), /height: 34px/);
  assert.match(rule('.dev-vote-switch-yes[aria-pressed="true"]'), /background: var\(--accent\); color: var\(--accent-ink\)/, 'Yes on: the accent fill');
  assert.match(rule('.dev-vote-switch-no[aria-pressed="true"]'), /background: var\(--state-blocked-bg\); color: var\(--state-blocked\)/, 'No on: the blocked tint');
  assert.doesNotMatch(CSS, /\.dev-vote-opt\b|data-asking/, 'the rows and their growing width are gone');
  const head = rule('.dev-vote-switch-label');
  const label = rule('.dev-vote-reason-label');
  const type = (r) => (r.match(/font-size: [^;]+;|font-weight: [^;]+;|color: [^;]+;/g) || []).join(' ');
  assert.ok(type(head).includes('font-size') && type(head).includes('color'), 'the header rule exists');
  assert.equal(type(head), type(label), 'the "Your vote" header is the twin of the label over the box: same size, weight and ink');
  assert.match(head, /padding: 0 6px 4px/, '2px further in than the label, which sits inside the reason block\'s own inset');
  assert.match(rule('.dev-vote-sheet .dev-vote-switch-label'), /font-size: 14px/, 'and at the sheet\'s label size there');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-label'), /font-size: 14px/);
  assert.match(rule('.dev-vote-sheet .dev-vote-switch-opt'), /height: 44px/, 'tap-target rows in the sheet');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-box'), /font-size: 16px/, '16px so iOS does not zoom the page on focus');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-cancel, .dev-vote-sheet .dev-vote-reason-send'), /height: 44px/);
  const block = CSS.slice(CSS.indexOf('.dev-vote-sheet {'), CSS.indexOf('.dev-vote-sheet .dev-vote-reason-cancel'));
  assert.doesNotMatch(block, /position: fixed|bottom: |un-kb-inset|touch-action/, 'the kit owns the sheet\'s placement and keyboard inset; nothing here fights it');
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgb\(/i, 'tokens only');
});

test('the answers are small rounded buttons, the picked one in the No tint, tap-size in a sheet', () => {
  const rule = (sel) => (new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS) || [])[1] || '';
  assert.match(rule('.dev-vote-why'), /flex-wrap: wrap/);
  assert.match(rule('.dev-vote-why'), /gap: 6px/);
  assert.match(rule('.dev-vote-why-opt'), /height: 28px/);
  assert.match(rule('.dev-vote-why-opt'), /border-radius: 10px/);
  assert.match(CSS, /\.dev-vote-why-opt\[aria-checked="true"\] \{ background: var\(--state-blocked-bg\); color: var\(--state-blocked\); border-color: transparent; \}/,
    'the picked answer takes the No side\'s tint, as its send button does');
  assert.match(CSS, /\.dev-vote-sheet \.dev-vote-why-opt, \.dev-ws-vote-form \.dev-vote-why-opt \{ height: 44px;/, 'tap-target rows in the sheets');
});

// ── Test accounts ─────────────────────────────────────────────────────

test('a test account\'s vote on an app a real person made says, in one line, that it will not count', () => {
  const html = picker({ uncounted: true });
  assert.match(html, /<div class="dev-vote-switch-label" id="dev-vote-reason-7-head">Your vote<\/div><p class="dev-vote-uncounted" data-vote-uncounted="">Test account: this vote won’t count\.<\/p><div class="dev-vote-switch"/,
    'the line sits under "Your vote", above the switch');
  assert.doesNotMatch(picker(), /dev-vote-uncounted/, 'nobody else sees it');
  // The flag rides the Yes spec from the /promoted row, as `prior` does.
  assert.match(SRC, /uncounted=\{!!yes\.uncounted\}/);
  const appView = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(appView, /pr\.my_vote_uncounted === true \? \{ uncounted: true \} : \{\}/);
  assert.match(appView, /data-vote-uncounted="">\$\{PlatformI18n\.htmlText\('changes:vote\.row\.uncounted'\)\}/, 'the legacy vote rows carry the same words');
  assert.equal(message('changes:vote.row.uncounted'), 'Test account: this vote won’t count.');
  assert.match(CSS, /\.dev-vote-uncounted \{/);
  assert.match(CSS, /\.gc-vote-uncounted \{/);
});

// ── #4747: the advisory vote ──────────────────────────────────────────

test('an advisory vote says, in one line, that it does not decide; the test-account line wins when both apply', () => {
  const html = picker({ advisory: true });
  assert.match(html, /<div class="dev-vote-switch-label" id="dev-vote-reason-7-head">Your vote<\/div><p class="dev-vote-uncounted" data-vote-uncounted="">Your vote is advisory: it’s recorded, but it doesn’t decide this change\.<\/p><div class="dev-vote-switch"/,
    'the same slot and style as the test-account line, under "Your vote"');
  assert.doesNotMatch(picker(), /dev-vote-uncounted/, 'nobody else sees it');
  const both = picker({ uncounted: true, advisory: true });
  assert.match(both, /Test account: this vote won’t count\./);
  assert.doesNotMatch(both, /advisory/, 'the test-account line wins; one line, never two');
  // The flag rides the Yes spec from the /promoted row, as `uncounted` does.
  assert.match(SRC, /advisory=\{!!yes\.advisory\}/);
  const appView = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(appView, /pr\.my_vote_advisory === true \? \{ advisory: true \} : \{\}/);
  assert.match(appView, /data-vote-uncounted="">\$\{PlatformI18n\.htmlText\('changes:vote\.row\.advisory'\)\}/, 'the legacy vote rows carry the same words');
  assert.equal(message('project:card.vote.picker.advisory'), 'Your vote is advisory: it’s recorded, but it doesn’t decide this change.');
  assert.equal(message('changes:vote.row.advisory'), 'Your vote is advisory: it’s recorded, but it doesn’t decide this change.');
});

// ── #3984: a vote on its way ─────────────────────────────────────────

test('#3984: while a vote is on its way the button reads "Sending…" and takes no press', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const mod = loadTsx(CARD);
  const draw = (y = yes, n = no) => renderToHtml(createElement(mod.VoteButton, { yes: y, no: n }));
  assert.doesNotMatch(draw(), /Sending…|aria-busy/, 'nothing on its way: the plain face');
  mod.voteSendingStore.set({ 'castVote:7': 'yes' });
  const html = draw();
  assert.match(html, /<button type="button" class="dev-vote-btn"[^>]*title="Sending your vote\."[^>]*aria-busy="true"[^>]*disabled=""[^>]*>Sending…<\/button>/);
  assert.doesNotMatch(html, /dev-vote-caret/, 'no caret: there is nothing to pick until it lands');
  const other = { ...yes, act: { fn: 'castVote', args: [8, 'yes', 3] } };
  assert.doesNotMatch(draw(other, { ...no, act: { fn: 'castVote', args: [8, 'no', 3] } }), /Sending…/, 'only that change\'s buttons');
  const issueYes = { ...yes, act: { fn: 'castIssueVote', args: [7, 'up'] } };
  assert.doesNotMatch(draw(issueYes, { ...no, act: { fn: 'castIssueVote', args: [7, 'down'] } }), /Sending…/, 'a request with the same id is a different vote');
  mod.voteSendingStore.set(() => ({}));
  assert.doesNotMatch(draw(), /Sending…/);
});

test('#3984: castVote and castIssueVote set the mark once the vote is committed to, and clear it when the server answers', () => {
  assert.match(SRC, /if \(voteSendingStore\.get\(\)\[sendKey\]\) return;/, 'a vote on its way is not sent again');
  assert.match(SRC, /if \(sending\) return;\n    if \(open \|\| sheetRef\.current\)/, 'nor does the picker open over it');
  assert.match(CSS, /\.dev-vote-btn\[aria-busy="true"\] \{ cursor: progress;/);
  const appView = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  const body = (name) => appView.slice(appView.indexOf(`async ${name}(`), appView.indexOf('\n  },\n', appView.indexOf(`async ${name}(`)));
  const vote = body('castVote');
  assert.match(vote, /const key = `\$\{sessionId\}`;/, 'one vote in flight per change, whichever side');
  assert.ok(vote.indexOf("_publishVoteSending(`castVote:${sessionId}`, vote)") > vote.indexOf('if (reason === false)'),
    'set after the line is in hand: a cancelled No never reads as sending');
  assert.match(vote, /finally \{\s*AppView\._voteInFlight\.delete\(key\);\s*AppView\._publishVoteSending\(`castVote:\$\{sessionId\}`, null\);/);
  const issue = body('castIssueVote');
  assert.match(issue, /_publishVoteSending\(`castIssueVote:\$\{issueId\}`, vote === 'down' \? 'no' : 'yes'\);\n    try \{/);
  assert.match(issue, /finally \{\s*AppView\._voteInFlight\.delete\(key\);\s*AppView\._publishVoteSending\(`castIssueVote:\$\{issueId\}`, null\);/);
  assert.match(appView, /_publishVoteSending\(key, side\) \{\s*try \{ AppView\._reactDevBoard\(\)\?\.publishVoteSending\?\.\(key, side\); \}/);
  const mount = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/mount.ts'), 'utf8');
  assert.match(mount, /\n  publishVoteSending,\n/, 'the bridge publishes it');
});

test('#3984: a notification\'s "Still yes" reads "Sending…" and its row takes no second press', () => {
  const sheet = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/notifications/notifications-sheet.tsx'), 'utf8');
  assert.match(sheet, /disabled=\{a\.key === 'still_yes' && busy\}/, 'only the vote waits; Accept, Decline and the rest do not');
  assert.match(sheet, /\{a\.key === 'still_yes' && busy \? t\('notifications:row\.sending'\) : a\.label\}/);
  assert.equal(message('notifications:row.sending'), 'Sending…');
  assert.match(sheet, /\.then\(\(\) => setBusy\(false\)\)/);
});

test('the counts come from the spec\'s own tally, whatever the label says and however it is punctuated', () => {
  // A label is words in the language on screen; nothing reads a count back
  // out of it. Spanish-style labels with no parentheses at all:
  const si = { ...yes, label: 'Sí: 2/3' };
  const nope = { ...no, label: 'No: 0/3' };
  const html = picker({ yes: si, no: nope });
  assert.match(html, /<span class="dev-vote-n">2\/3<\/span>/);
  assert.match(html, /<span class="dev-vote-n">0\/3<\/span>/);
  // And a label that happens to end in parentheses is not mistaken for a count.
  const odd = picker({ yes: { ...yes, label: 'Yes (really)', tally: '5' }, no: { ...no, tally: '1' } });
  assert.match(odd, /<span class="dev-vote-n">5<\/span>/);
  assert.doesNotMatch(odd, /<span class="dev-vote-n">really<\/span>/);
  const card = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dev-board/card/dev-card.tsx'), 'utf8');
  const tab = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
  for (const src of [card, tab]) {
    assert.doesNotMatch(src, /exec\(a\.label/, 'no count is parsed out of a label');
    assert.doesNotMatch(src, /\/\^Vote\\b\//, 'and no state is recognised by an English word');
  }
  assert.match(tab, /st\.label && !st\.plainVote/);
});

