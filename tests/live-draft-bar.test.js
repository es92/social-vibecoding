'use strict';

// A live draft's bar in its private thread with Homeroom bot
// (frontend/src/features/messages/live-draft-bar.tsx): its first render is
// nothing (the draft is read in an effect), the status line's words for each
// state of the preview, where the messages pane mounts it (an open thread of
// theirs that is about a project), and the socket frame app.js hands it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BAR = 'frontend/src/features/messages/live-draft-bar.tsx';

const draft = (over = {}) => ({
  id: 1, state: 'open', live: 'live', sessionId: 5, rootId: 9, app: { slug: 'gym', name: 'Gym Tracker' },
  edits: 0, headSha: null, prNumber: null, error: null, ...over,
});

test('there is no bar (G): what it did besides drawing is a part that draws nothing, read in an effect', () => {
  assert.equal(renderComponent(BAR, 'LiveDraftWatch', { rootId: 9 }), '');
  assert.equal(renderComponent(BAR, 'LiveDraftControls', { draft: null }), '', 'no controls for a preview that is not a draft\'s');
  assert.doesNotMatch(read(BAR), /export function LiveDraftBar/);
  assert.doesNotMatch(read(BAR), /data-live-draft-open/, 'a draft is opened by asking Homeroom bot, never by a button on every thread');
  assert.match(read(BAR), /fetch\(path, \{ credentials: 'same-origin'/);
  assert.match(read(BAR), /\/api\/live-drafts\?rootId=/);
});

test('the status line says where the preview stands', () => {
  const { draftLine } = loadTsx(BAR);
  assert.deepEqual(draftLine(draft({ live: 'starting' })), { id: 'messages:liveDraft.starting' });
  assert.deepEqual(draftLine(draft({ live: 'rebuilding', edits: 2 })), { id: 'messages:liveDraft.rebuilding' });
  assert.deepEqual(draftLine(draft({ live: 'failed' })), { id: 'messages:liveDraft.failed' });
  assert.deepEqual(draftLine(draft()), { id: 'messages:liveDraft.liveNone' });
  assert.deepEqual(draftLine(draft({ edits: 3 })), { id: 'messages:liveDraft.live', values: { count: 3 } });
  assert.equal(message('messages:liveDraft.live_other').replace('{{count}}', '3'), 'Live preview · 3 changes');
});

test('the preview\'s header says where the draft stands in one short line, and offers its one action (G, C)', () => {
  const { draftHeadLine, draftAction, liveDraftShown } = loadTsx(BAR);
  assert.deepEqual(draftHeadLine(draft({ live: 'failed' })), { id: 'messages:liveDraft.head.failed', bad: true }, 'a preview that could not start is still said');
  assert.deepEqual(draftHeadLine(draft({ live: 'starting' })), { id: 'messages:liveDraft.head.starting', bad: false });
  assert.deepEqual(draftHeadLine(draft()), { id: 'messages:liveDraft.head.none', bad: false });
  assert.deepEqual(draftHeadLine(draft({ edits: 2 })), { id: 'messages:liveDraft.head.edits', values: { count: 2 }, bad: false });
  const proposed = (pending) => draft({ state: 'proposed', editable: true, edits: 4, proposal: { sessionId: 50, prNumber: 142, open: true, pending, headSha: null } });
  assert.deepEqual(draftHeadLine(proposed(1)), { id: 'messages:liveDraft.head.pending', values: { count: 1 }, bad: false });
  assert.equal(message('messages:liveDraft.head.pending_one').replace('{{count}}', '1'), '1 change not in the proposal yet');
  assert.deepEqual(draftHeadLine(proposed(0)), { id: 'messages:liveDraft.head.inProposal', bad: false });
  assert.equal(draftAction(draft()), null, 'nothing to propose before an edit');
  assert.equal(draftAction(draft({ edits: 1 })), 'propose');
  assert.equal(draftAction(proposed(2)), 'update');
  assert.equal(draftAction(proposed(0)), null);
  assert.equal(message('messages:liveDraft.update'), 'Update proposal');
  assert.equal(liveDraftShown(proposed(0)), true, 'a draft up for a vote is still shown');
  assert.equal(liveDraftShown(draft({ state: 'proposed' })), false, 'one proposed before drafts survived Propose is not');
});

test('a draft started on their own proposal says it is on that PR until it has a change of its own', () => {
  const { draftHeadLine } = loadTsx(BAR);
  const onTheirs = (over = {}) => draft({
    state: 'proposed', editable: true, edits: 0,
    proposal: { sessionId: 50, prNumber: 142, open: true, pending: 0, headSha: null },
    builtOn: { sessionId: 50, prNumber: 142, open: true, merged: false, linked: true },
    ...over,
  });
  assert.deepEqual(draftHeadLine(onTheirs()), { id: 'messages:liveDraft.head.onProposal', values: { number: 142 }, bad: false },
    'not "Up for a vote with every change" before any change');
  assert.equal(message('messages:liveDraft.head.onProposal').replace('{{number}}', '142'), 'On PR #142 · no changes yet');
  // A change of its own, not in the proposal yet, then put in it.
  assert.deepEqual(draftHeadLine(onTheirs({ edits: 1, proposal: { sessionId: 50, prNumber: 142, open: true, pending: 1, headSha: null } })),
    { id: 'messages:liveDraft.head.pending', values: { count: 1 }, bad: false });
  assert.deepEqual(draftHeadLine(onTheirs({ edits: 1 })), { id: 'messages:liveDraft.head.inProposal', bad: false });
  // No number to say: no changes yet, which is still true.
  assert.deepEqual(draftHeadLine(onTheirs({
    proposal: { sessionId: 50, prNumber: null, open: true, pending: 0, headSha: null },
    builtOn: { sessionId: 50, prNumber: null, open: true, merged: false, linked: true },
  })), { id: 'messages:liveDraft.head.none', bad: false });
  // On someone else's proposal the draft is open and linked to nothing: as before.
  assert.deepEqual(draftHeadLine(draft({ builtOn: { sessionId: 60, prNumber: 150, open: true, merged: false, linked: false } })),
    { id: 'messages:liveDraft.head.none', bad: false });
  assert.deepEqual(draftHeadLine(onTheirs({ live: 'starting' })), { id: 'messages:liveDraft.head.starting', bad: false }, 'a start is still said first');
});

test('a draft\'s preview opens look-only and waits for a start, so it never lands on "isn\'t running"', () => {
  const { draftPreviewOpts, openLivePreview } = loadTsx(BAR);
  for (const live of ['starting', 'live', 'rebuilding']) {
    assert.deepEqual(draftPreviewOpts(draft({ live })), { readOnly: true, app: { slug: 'gym' }, waitForStart: true }, live);
  }
  assert.deepEqual(draftPreviewOpts(draft({ live: 'failed' })), { readOnly: true, app: { slug: 'gym' } },
    'one that could not start is not waited for: the header says it failed');

  // Pressed in the Artifacts column: AppView.ensureStaging is asked with them.
  const asked = [];
  const had = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { AppView: { ensureStaging: (...args) => { asked.push(args); return Promise.resolve(); } } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ draft: null }) });
  try {
    openLivePreview(draft({ live: 'starting', sessionId: 41 }));
  } finally {
    globalThis.window = had.window;
    globalThis.fetch = had.fetch;
  }
  assert.deepEqual(asked, [[41, null, null, { readOnly: true, app: { slug: 'gym' }, waitForStart: true }]]);
  assert.match(read(BAR), /void view\.ensureStaging\(draft\.sessionId, null, null, draftPreviewOpts\(draft\)\);/,
    'the reload frame\'s open (draftPreviewStep \'open\') goes the same way');
});

test('a draft\'s header opens its proposal, and only once it has one (request 7119)', () => {
  const { draftChangeHref } = loadTsx(BAR);
  // An open draft has its own preview change (`sessionId`), but nothing to
  // open until it is proposed: with or without saved edits.
  assert.equal(draftChangeHref(draft()), null, 'no proposal yet');
  assert.equal(draftChangeHref(draft({ edits: 2 })), null, 'edits are not a proposal');
  const proposed = (over = {}) => draft({
    state: 'proposed', editable: true,
    proposal: { sessionId: 8, prNumber: 142, open: true, pending: 1, headSha: null },
    builtOn: { sessionId: 7, prNumber: 141, open: true, merged: false, linked: false },
    ...over,
  });
  assert.equal(draftChangeHref(proposed()), '#app/gym/dev/proposals/8', 'its proposal\'s page, never the draft\'s own change or the one it was started on');
  // A draft started on the person's own proposal is on it from the start.
  assert.equal(draftChangeHref(proposed({
    proposal: { sessionId: 7, prNumber: 141, open: true, pending: 0, headSha: null },
    builtOn: { sessionId: 7, prNumber: 141, open: true, merged: false, linked: true },
  })), '#app/gym/dev/proposals/7');
  assert.equal(draftChangeHref(proposed({ app: { slug: '', name: 'Gym Tracker' } })), null);
  assert.equal(draftChangeHref(proposed({
    proposal: { sessionId: 8, prNumber: 142, open: false, pending: 0, headSha: null },
  })), '#app/gym/dev/proposals/8', 'its proposal\'s page even once it has ended');
  assert.equal(draftChangeHref(null), null);

  const acts = { busy: null, error: null, act: async () => {}, discard: async () => {}, discardItem: null };
  // An open draft: no way through, and Propose still drawn once there are edits.
  for (const edits of [0, 2]) {
    const open = renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits }), acts });
    assert.doesNotMatch(open, /data-live-draft-change=""/, `no change to open: ${edits} edits`);
    if (edits) assert.match(open, /data-live-draft-propose=""/);
  }
  for (const live of ['live', 'starting', 'failed']) {
    const open = renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits: 0, live }), acts });
    assert.doesNotMatch(open, /data-live-draft-change=""/, `no change to open: ${live}`);
  }
  // Proposed: Open change comes before the header's one filled action.
  const header = renderComponent(BAR, 'LiveDraftControls', { draft: proposed(), acts });
  assert.match(header, /data-live-draft-change=""/);
  assert.equal(message('messages:liveDraft.openChange'), 'Open change');
  assert.match(header, new RegExp(message('messages:liveDraft.openChange')));
  assert.match(header, /data-live-draft-update=""/);
  assert.ok(header.indexOf('data-live-draft-change') < header.indexOf('data-live-draft-update'),
    'the way through comes before the header\'s one filled action');
  assert.equal(renderComponent(BAR, 'LiveDraftControls', { draft: null, acts }), '');

  // An outlined button, and the preview goes before the page does.
  const bar = read(BAR);
  assert.match(bar, /className="staging-draft-quiet" data-live-draft-change=""/);
  assert.match(bar, /if \(stagingStore\.get\(\)\.open\) \(window as any\)\.AppView\?\.closeStagingOverlay\?\.\(\);\s*window\.location\.hash = changeHref;/,
    'the preview closes as its change page opens');
});

test('the controls are the preview header\'s, beside its way out; Discard draft is the title menu\'s and asks first', () => {
  const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(overlay, /const liveDraft = useDraftForSession\(state\.open \? state\.sessionId : null\);/);
  assert.match(overlay, /const draftActs = useLiveDraftActs\(liveDraft\);/);
  assert.match(overlay, /<LiveDraftControls draft=\{liveDraft\} acts=\{draftActs\} \/>\s*<div className="staging-tools">/);
  const bar = read(BAR);
  assert.match(bar, /data-live-draft-propose=""/);
  assert.match(bar, /data-live-draft-update=""/);
  // 24 Nov 2026: beside Propose, "Close draft" read as the preview's ×, which
  // only hides the preview. The header's row keeps its line and its one
  // action; ending the draft is Discard draft, the title menu's last entry.
  const acts = { busy: null, error: null, act: async () => {}, discard: async () => {}, discardItem: null };
  const header = renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits: 2 }), acts });
  assert.match(header, /data-live-draft-propose=""/);
  assert.doesNotMatch(header, /data-live-draft-close|Close draft|Discard draft/, 'no way to end the draft beside Propose');
  assert.match(bar, /data: \{ 'data-live-draft-close': '' \},/, 'the check hook moves with it, to the menu entry');
  assert.match(bar, /label: t\('messages:liveDraft\.discard'\),/);
  assert.match(bar, /const ok = await confirmAction\(\{\s*title: t\('messages:liveDraft\.closeConfirm\.title'\)/);
  assert.match(bar, /confirmLabel: t\('messages:liveDraft\.close'\),\s*danger: true,/);
  assert.match(bar, /await call\(`\/api\/live-drafts\/\$\{draft\.id\}\/close`, \{ method: 'POST' \}\);/, 'it ends the draft as Close draft did');
  assert.equal(message('messages:liveDraft.discard'), 'Discard draft');
  assert.equal(message('messages:liveDraft.close'), 'Discard draft', 'the confirm button says the menu entry\'s words');
  assert.equal(message('messages:liveDraft.closeConfirm.title'), 'Discard this draft?');
  // The menu is there whenever the preview is a draft's, beside a thread or
  // in the whole window (a phone), where Discard draft is its only entry.
  assert.match(overlay, /const menuHere = pickHere \|\| !!liveDraft;/);
  assert.match(overlay, /return menuHere \? \(/);
  assert.match(overlay, /end=\{draftActs\.discardItem\}>/);
  const card = read('frontend/src/features/detail/detail-card.tsx');
  assert.match(card, /<div className="detail-card-menu-end" data-alone=\{rows\.length \? undefined : ''\}>/);
  assert.match(card, /role="menuitem"[\s\S]{0,200}data-danger=\{end\.danger \? '' : undefined\}[\s\S]{0,200}\{\.\.\.end\.data\}/);
  assert.match(read('frontend/src/features/staging/placement.ts'), /sessionId: Number\(input\.sessionId\) \|\| null,/);
});

test('a refusal on the header\'s line goes once the draft is proposed (24 Nov 2026: two Proposes at once)', () => {
  // The Propose under the bot's reply and this one, tapped together: this one
  // is told the draft is being put up for a vote, and that line goes once the
  // other has proposed it, rather than standing in for "Up for a vote".
  assert.match(read(BAR), /useEffect\(\(\) => \{ setError\(null\); \}, \[draft\?\.id, draft\?\.state\]\);/);
  const acts = { busy: null, error: 'It is being put up for a vote right now.', act: async () => {}, discard: async () => {}, discardItem: null };
  assert.match(renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits: 2 }), acts }), /It is being put up for a vote right now\./);
});

test('the messages pane reads the draft on an open thread of theirs, with no bar; a newly opened draft brings its preview up', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.doesNotMatch(pane, /<LiveDraftBar/);
  assert.match(pane, /import \{ useLiveDraft \} from '\.\/live-draft-bar';/);
  assert.match(pane, /const liveDraft = useLiveDraft\(privateMine && privateRoot && privateWhere\?\.state === 'open' \? privateRoot : null\);/);
  const { draftPreviewStep } = loadTsx(BAR);
  const step = (over) => draftPreviewStep({ draft: draft(), last: null, paneHere: false, framed: false, ...over });
  assert.equal(step({ opened: true, draft: draft({ live: 'starting' }) }), 'open');
  assert.equal(step({ opened: true, draft: draft({ state: 'closed' }) }), null, 'not one that is closed');
  const bar = read(BAR);
  assert.match(bar, /const step = draftPreviewStep\(\{[\s\S]{0,200}paneHere: paneOn\(next\.sessionId\), framed: frameShowsPreview\(\),\s*\}\);/);
  assert.match(bar, /if \(step === 'open'\) openPreview\(next\);\s*else if \(step === 'reload'\) void reloadPreview\(next\.sessionId, next\.app\.slug\);/);
});

// 24 Nov 2026: a cleared frame's `src` property reads back as Homeroom's own
// page, so the old "has it a src" guard never fired. Only an address on the
// preview's own origin is a preview in the frame.
test('a frame shows a preview only when its src attribute is an address on another origin', () => {
  const { showsPreview } = loadTsx(BAR);
  const HOME = 'https://app.onhomeroom.com';
  assert.equal(showsPreview(null, HOME), false, 'no attribute');
  assert.equal(showsPreview('', HOME), false, 'cleared');
  assert.equal(showsPreview('about:blank', HOME), false);
  assert.equal(showsPreview('https://app.onhomeroom.com/', HOME), false, 'Homeroom\'s own page');
  assert.equal(showsPreview('https://app.onhomeroom.com/app/gym/dev?x=1#chat', HOME), false);
  assert.equal(showsPreview('/app/gym', HOME), false, 'a path is Homeroom\'s own');
  assert.equal(showsPreview('javascript:void(0)', HOME), false);
  assert.equal(showsPreview('https://gym--s41.onhomeroom.dev/?token=x', HOME), true);
  assert.equal(showsPreview('http://localhost:4100/', 'http://localhost:3000'), true, 'a local preview on its own port');
  assert.equal(showsPreview('not a url', HOME), false);
  const bar = read(BAR);
  assert.match(bar, /showsPreview\(frame\.getAttribute\('src'\), home\)/, 'the attribute is read, never the property');
  assert.doesNotMatch(bar, /frame\.src\b/);
  // reloadPreview never points the frame at Homeroom's own page.
  assert.match(bar, /if \(!frame \|\| !frameShowsPreview\(frame\)\) return;\s*let src = frame\.getAttribute\('src'\) as string;/);
});

test('a preview still starting when its pane opened comes up by itself when it goes live', () => {
  const { draftPreviewStep } = loadTsx(BAR);
  const step = (over) => draftPreviewStep({ draft: draft(), last: 'live', paneHere: true, framed: true, ...over });
  // The pane opened on a dead end, or a loader: the frame holds no preview.
  assert.equal(step({ last: 'starting', reload: true, framed: false }), 'open', 'deployed: the pane is opened on it again');
  assert.equal(step({ last: 'starting', framed: false }), 'open', 'starting to live, with no reload asked');
  assert.equal(step({ last: 'rebuilding', framed: false }), 'open');
  assert.equal(step({ reload: true, framed: false }), 'open', 'a saved edit while the frame holds none');
  // The frame shows the preview: it is reloaded, as before.
  assert.equal(step({ reload: true }), 'reload');
  assert.equal(step({ last: 'rebuilding' }), 'reload', 'built again');
  assert.equal(step({ last: 'starting' }), 'reload');
  // Not on this draft's pane: the reload is left to reloadPreview's own guard.
  assert.equal(step({ last: 'starting', reload: true, paneHere: false, framed: false }), 'reload');
  // Nothing came up and nothing was asked.
  assert.equal(step({}), null);
  assert.equal(step({ last: 'starting', draft: draft({ live: 'starting' }), framed: false }), null);
  assert.equal(step({ last: 'live', draft: draft({ live: 'rebuilding' }), framed: false }), null);
  assert.equal(step({ last: 'starting', draft: draft({ live: 'failed' }), framed: false }), null);
  assert.equal(step({ reload: true, framed: false, draft: draft({ state: 'closed' }) }), 'reload', 'a closed draft is never opened again');
});

test('app.js hands the draft\'s socket frame on as the bar\'s window event', () => {
  const { LIVE_DRAFT_EVENT } = loadTsx(BAR);
  const app = read('public/js/app.js');
  assert.match(app, new RegExp(`case 'live_draft_changed':\\s*(//[^\\n]*\\n\\s*)*window\\.dispatchEvent\\(new CustomEvent\\('${LIVE_DRAFT_EVENT}', \\{ detail: data \\}\\)\\);`));
});

test('New chat offers a live preview once a project of its own is picked: a button that sends "I want to make changes to a live preview of…"', () => {
  const NEW = 'frontend/src/features/messages/new-thread.tsx';
  const { LIVE_START, offersLive, NEW_THREAD_STARTS, startOf, leadWith } = loadTsx(NEW);
  assert.equal(offersLive('', {}), false, 'not for Any project');
  assert.equal(offersLive('gym', {}), true);
  assert.equal(offersLive('gym', { gym: { selfHosted: false } }), true);
  // #6961: Homeroom's own app is offered to its admins, and only to them.
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }), false, 'never to a non-admin');
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }, { platformSlug: 'homeroom' }), false);
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }, { platformSlug: 'homeroom', isAdmin: true }), true);
  assert.equal(offersLive('homeroom', {}, { platformSlug: 'homeroom', isAdmin: true }), true, 'even before the project is described');
  assert.equal(offersLive('other-self', { 'other-self': { selfHosted: true } }, { platformSlug: 'homeroom', isAdmin: true }), false,
    'another self-hosted app is never offered, admins included');
  assert.equal(offersLive('gym', { gym: { selfHosted: false } }, { platformSlug: 'homeroom', isAdmin: true }), true);
  const words = message(LIVE_START.text, { app: 'Gym' });
  assert.equal(words, 'I want to make changes to a live preview of Gym');
  // 26 Nov 2026: it is no pill any more. The head's Live preview button sends its words.
  assert.equal(LIVE_START.label, undefined, 'the live start has no pill to label');
  assert.equal(message('messages:newThread.live.button'), 'Live preview');
  assert.equal(message('messages:newThread.live.startLabel', { app: 'Gym' }), 'Start a live preview of Gym');
  assert.equal(LIVE_START.kind, 'any');
  assert.ok(!NEW_THREAD_STARTS.some((s) => s.key === 'live'), 'the five starts stay five; the live one is the button');
  const starts = [...NEW_THREAD_STARTS, LIVE_START].map((s) => ({ ...s, text: message(s.text, { app: 'Gym' }) }));
  assert.equal(startOf('I want to make changes to a live preview of Gym: make the button bigger', starts).key, 'live');
  assert.equal(startOf('I want to change an app live: make the button bigger', starts), null, 'the old words are no longer a start');
  assert.match(read(NEW), /offersLive\(project, scope\.info[\s\S]*?platformSlug: platformSlug\(\),[\s\S]*?isAdmin: typeof window !== 'undefined' && !!\(window as any\)\.App\?\.user\?\.isAdmin,/);
  // The pill and the box say the picked project's name, falling back to its slug.
  assert.match(read(NEW), /const appName = \(project && scope\.info\[project\]\?\.name\) \|\| project \|\| '';/);
  assert.match(read(NEW), /text: t\(start\.text, \{ app: appName \}\)/);
  assert.match(read(NEW), /<RichMessage id=\{start\.label\} values=\{\{ app: appName \}\}/);
  // Only the five are drawn as pills; the live start is still read, and written when a door carries it.
  assert.match(read(NEW), /const pills = NEW_THREAD_STARTS\.map\(\(start\) => \(\{ \.\.\.start, text: t\(start\.text, \{ app: appName \}\) \}\)\);/);
  assert.match(read(NEW), /const liveWords = t\(LIVE_START\.text, \{ app: appName \}\);\s+const starts = live \? \[\.\.\.pills, \{ \.\.\.LIVE_START, text: liveWords \}\] : pills;/);
  assert.match(read(NEW), /\{pills\.map\(\(start\) => \(/);
  // The button is the first message, sent: the live start's words, then what the box held.
  assert.equal(leadWith('', words), words);
  assert.equal(leadWith('  make the button bigger ', words), `${words}: make the button bigger`);
  assert.equal(leadWith(`${words}: make the button bigger`, words), `${words}: make the button bigger`, 'never said twice');
  assert.equal(leadWith('just words'), 'just words', 'an ordinary send is the box alone');
  assert.match(read(NEW), /const liveReady = live && !own && !setup;\s+const startLive = \(\) => \{ if \(liveReady\) void send\(undefined, liveWords\); \};/);
  assert.match(read(NEW), /const content = leadWith\(words, lead\);/);
  assert.match(read(NEW), /\{liveInHead \? \(\s+<Button type="button" variant="unstyled" size="none" ink="none" className="messages-live-start" data-bot-new-thread-live=\{reopen \? 'show' : ''\} disabled=\{reopen \? false : holding\}/);
  assert.match(read(NEW), /onClick=\{reopen \|\| startLive\}>\s+<PlayIcon aria-hidden="true" \/>\s+<span>\{t\('messages:newThread\.live\.button'\)\}<\/span>/);
  // A secondary action, flat in the sky tint: Send stays the one sun.
  assert.match(read('public/css/app.css'), /html:root \[data-bot-new-thread-pane\] \.messages-live-start \{\s+display: inline-flex;[^}]*background: var\(--one-sky-tint\); color: var\(--one-sky-ink\);/);
  // Homeroom bot is what opens it: the chat's tool, named for that start.
  const mayor = require('../src/services/homeroom-bot-mayor');
  const tool = mayor.TOOLS.find((t) => t.function.name === 'open_app_preview').function;
  assert.match(tool.description, /I want to make changes to a live preview of/);
  // Step 6 (#6864): opening it loads the draft's tools into the same turn,
  // so the change they asked for is made then, and replied to.
  assert.match(tool.description, /It gives you the draft's tools for the rest of this turn: when they asked for a change, make it then, and reply\./);
});

test('from 1500px the preview\'s column waits beside New chat: Start for a picked project, projects to pick from for Any project', () => {
  const PANE = 'frontend/src/features/messages/live-start-pane.tsx';
  const NEW = 'frontend/src/features/messages/new-thread.tsx';
  const { livePicks, LIVE_PICKS } = loadTsx(PANE);
  const info = {
    gym: { slug: 'gym', name: 'Gym' }, books: { slug: 'books', name: 'Book Club' },
    homeroom: { slug: 'homeroom', name: 'Homeroom', selfHosted: true },
    a: { slug: 'a', name: 'A' }, b: { slug: 'b', name: 'B' }, c: { slug: 'c', name: 'C' },
  };
  const slugs = (rows) => rows.map((row) => row.slug);
  // The recent projects that can be previewed, in the picker's own order: never one that cannot.
  assert.deepEqual(slugs(livePicks(['homeroom', 'gym', 'gone', 'books'], info, { platformSlug: 'homeroom' })), ['gym', 'books']);
  assert.deepEqual(slugs(livePicks(['homeroom', 'gym'], info, { platformSlug: 'homeroom', isAdmin: true })), ['homeroom', 'gym'], 'Homeroom itself for its admins');
  assert.equal(livePicks(['gym', 'books', 'a', 'b', 'c'], info, {}).length, LIVE_PICKS, 'a handful, then All projects');
  assert.deepEqual(livePicks([], info, {}), []);
  // Its first render has no chat to read: it asks for a project, with the picker's door.
  const pick = renderComponent(PANE, 'LiveStartPane', {});
  assert.match(pick, /class="detail-card live-start" data-live-start="pick"/, 'drawn as the column\'s other cards are');
  assert.ok(pick.includes(message('messages:newThread.live.pane.pickTitle')));
  assert.ok(pick.includes(message('messages:newThread.live.pane.noProject')));
  assert.match(pick, /data-live-start-all=""/);
  assert.doesNotMatch(pick, /data-live-start-go/);
  // Just started: it says the draft is opening rather than leaving and coming back.
  const opening = renderComponent(PANE, 'LiveStartPane', { opening: { name: 'Gym' } });
  assert.match(opening, /data-live-start="opening"/);
  assert.ok(opening.includes(message('messages:newThread.live.pane.openingTitle', { app: 'Gym' })));
  // Start is the new chat's own live start, and a pick only sets About.
  const pane = read(PANE);
  assert.match(pane, /<Button type="button" variant="sun" size="none" ink="none" className="live-start-go" data-live-start-go="" disabled=\{chat\.busy\} onClick=\{\(\) => startLivePreview\(\)\}>/);
  assert.match(pane, /onClick=\{\(\) => pickLiveProject\(row\.slug\)\}/);
  assert.match(pane, /onPick=\{\(slug\) => \{ setPicking\(false\); pickLiveProject\(slug \|\| ''\); \}\}/);
  const fresh = read(NEW);
  assert.match(fresh, /liveStartStore\.set\(\{ conversationId, project, name: appName, offered: liveReady, bot: !own, busy: holding \}\);/);
  assert.match(fresh, /return \(\) => \{ liveStartActs = null; liveStartStore\.set\(null\); \};/);
  assert.match(fresh, /const liveInHead = reopen \? !own && !setup : liveReady && !beside;/, 'with the column beside it, the head has no button');
  assert.match(fresh, /openThread\(made\.rootId\);\s+\/\/[^\n]*\n\s+if \(lead\) liveOpeningStore\.set\(\{ rootId: made\.rootId, name: appName \}\);/);
  // The bot page draws it only where three columns fit, beside a new chat with Homeroom bot, in the preview's own pane.
  const ai = read('frontend/src/features/ai/index.tsx');
  assert.match(ai, /const roomForLive = !!botId && docked && !phone && fits === 'three' && !panel\.open && !detailHere;/);
  assert.match(ai, /const liveNew = roomForLive && column\?\.at === 'new' && !!liveChat && liveChat\.bot;\s+const waitingNew = liveNew && !liveClosed;/);
  assert.match(ai, /const openingHere = roomForLive && column\?\.at === 'thread' && !!liveOpening && liveOpening\.rootId === column\.rootId;/);
  assert.match(ai, /const previewHere = detailHere \|\| waitingHere;/);
  assert.match(ai, /<LiveStartBeside\.Provider value=\{waitingNew\}>/);
  assert.match(ai, /\) : waitingHere \? \([\s\S]{0,260}<aside\s+ref=\{previewRef\}\s+id="ai-preview-pane"\s+className="ai-preview-pane"\s+data-ai-preview-pane=\{layout\}\s+data-ai-live-start=""/);
  assert.match(ai, /<LiveStartPane\s+opening=\{openingHere && liveOpening \? \{ name: liveOpening\.name \} : null\}/);
  // Waiting, the two edges remember widths of their own, in a real preview's rules, so each drags on its own
  // (27 Nov 2026: clamping the column to the chat's width made one edge move the other).
  assert.match(ai, /data-ai-live-wait=\{waitingHere \? '' : undefined\}/);
  assert.match(ai, /const threadWidthKey = waitingHere \? AI_LIVE_COLUMN_WIDTH_KEY : threeFits \? AI_PREVIEW_COLUMN_WIDTH_KEY : AI_MAIN_WIDTH_KEY;/);
  assert.match(ai, /data-ai-live-start=""[\s\S]{0,400}widthKey=\{AI_LIVE_PREVIEW_WIDTH_KEY\}\s+probe=\{previewProbe\}/);
  const resize = loadTsx('frontend/src/features/side-panel/resize.ts');
  assert.equal(new Set([resize.AI_MAIN_WIDTH_KEY, resize.AI_PREVIEW_COLUMN_WIDTH_KEY, resize.AI_PREVIEW_WIDTH_KEY,
    resize.AI_LIVE_COLUMN_WIDTH_KEY, resize.AI_LIVE_PREVIEW_WIDTH_KEY]).size, 5, 'the waiting pair is kept apart from a real preview\'s');
  const set = new Map();
  const root = { style: { setProperty: (k, v) => set.set(k, v), removeProperty: (k) => set.delete(k) } };
  resize.applyWidth(500, root, resize.AI_LIVE_COLUMN_WIDTH_KEY);
  resize.applyWidth(620, root, resize.AI_LIVE_PREVIEW_WIDTH_KEY);
  assert.deepEqual([...set], [['--ai-live-col-chosen-w', '500px'], ['--ai-live-preview-chosen-w', '620px']]);
  const css = read('public/css/app.css');
  // Never dragged, they use all of the room: the list is held to 42rem, so New chat takes what the list and the
  // column do not need (at least 440px), and past its 720px measure the column takes the rest.
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="three"\]\[data-ai-live-wait\]:not\(\.hidden\)\) \{\s+--ai-preview-w: max\(360px, min\(var\(--ai-live-preview-chosen-w, max\(min\(440px, calc\(var\(--ai-room\) - 920px\)\), calc\(var\(--ai-room\) - var\(--ai-list-max, 42rem\) - 720px\)\)\), calc\(var\(--ai-room\) - 800px\)\)\);\s+--ai-col-w: max\(320px, min\(var\(--ai-live-col-chosen-w, max\(min\(var\(--ai-main-w\), 440px\), calc\(var\(--ai-room\) - var\(--ai-list-max, 42rem\) - var\(--ai-preview-w\)\)\)\), calc\(var\(--ai-room\) - 480px - var\(--ai-preview-w\)\)\)\);\s+\}/);
  // The same sums in plain numbers, at the widths the rule was written for (rem at 16px).
  const starts = (room, mainW = 9999) => {
    const preview = Math.max(360, Math.min(Math.max(Math.min(440, room - 920), room - 672 - 720), room - 800));
    const chat = Math.max(320, Math.min(Math.max(Math.min(mainW, 440), room - 672 - preview), room - 480 - preview));
    return { list: room - chat - preview, chat, preview };
  };
  assert.deepEqual(starts(1288), { list: 480, chat: 440, preview: 368 }, 'a 1500px window: the list at its floor, New chat its 440px');
  assert.deepEqual(starts(1671), { list: 672, chat: 559, preview: 440 }, 'a 1900px window: no band beside the list, the room is New chat\'s');
  assert.deepEqual(starts(2348), { list: 672, chat: 720, preview: 956 }, 'wider still: New chat stops at its measure and the column takes the rest');
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]\[data-ai-live-wait\]:not\(\.hidden\)\) \{\s+--ai-preview-w: max\(320px, min\(var\(--ai-live-preview-chosen-w, calc\(var\(--ai-room\) \/ 2\)\), calc\(var\(--ai-room\) - 320px\)\)\);\s+\}/);
  // Neither width is read from the other, and neither reads a real preview's.
  const waiting = css.slice(css.indexOf('body:has(#ai-screen[data-ai-preview="three"][data-ai-live-wait]'), css.indexOf("/* From 1500px the preview's column waits beside New chat instead"));
  assert.doesNotMatch(waiting, /--ai-live-col:|var\(--ai-live-col\)|var\(--ai-preview-chosen-w|var\(--ai-col-chosen-w/);
  // The draft arriving, or the person going elsewhere, ends the wait; so does two minutes.
  assert.match(ai, /if \(detailHere \|\| elsewhere\) \{ liveOpeningStore\.set\(null\); return undefined; \}/);
  assert.match(ai, /const LIVE_OPENING_MS = 120_000;/);
});

test('the waiting column can be closed: a choice kept on this device, and New chat\'s head brings it back', () => {
  const COLUMN = 'frontend/src/features/ai/live-column.ts';
  const PANE = 'frontend/src/features/messages/live-start-pane.tsx';
  const NEW = 'frontend/src/features/messages/new-thread.tsx';
  const column = loadTsx(COLUMN);
  // One key, '1' while closed, nothing kept while it is open; storage that is absent or throws is "not closed".
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  assert.equal(column.readLiveColumnClosed(store), false);
  column.writeLiveColumnClosed(true, store);
  assert.deepEqual([...mem], [[column.AI_LIVE_COLUMN_CLOSED_KEY, '1']]);
  assert.equal(column.readLiveColumnClosed(store), true);
  column.writeLiveColumnClosed(false, store);
  assert.equal(mem.size, 0);
  assert.equal(column.readLiveColumnClosed(null), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(column.readLiveColumnClosed(broken), false);
  assert.doesNotThrow(() => column.writeLiveColumnClosed(true, broken));
  assert.notEqual(column.AI_LIVE_COLUMN_CLOSED_KEY, loadTsx('frontend/src/features/side-panel/resize.ts').AI_LIST_CLOSED_KEY, 'not the list\'s choice');
  // The in-memory answer follows the choice.
  assert.equal(column.isLiveColumnClosed(), false);
  column.setLiveColumnClosed(true);
  assert.equal(column.isLiveColumnClosed(), true);
  column.setLiveColumnClosed(false);
  assert.equal(column.isLiveColumnClosed(), false);
  // The column's title card has the close, drawn as a real preview's is, only when it is given one.
  assert.doesNotMatch(renderComponent(PANE, 'LiveStartPane', {}), /data-live-start-close/);
  const closable = renderComponent(PANE, 'LiveStartPane', { onClose() {} });
  const close = message('messages:newThread.live.pane.close');
  assert.ok(closable.includes(`<span class="detail-card-exits"><button type="button" data-live-start-close="" aria-label="${close}" title="${close}" class="detail-card-disc">`));
  assert.match(renderComponent(PANE, 'LiveStartPane', { opening: { name: 'Gym' }, onClose() {} }), /data-live-start-close=""/, 'and while a draft is opening');
  // The page: closed, the column is not drawn beside a new chat, and the head is handed the way back.
  const ai = read('frontend/src/features/ai/index.tsx');
  assert.match(ai, /const liveClosed = useLiveColumnClosed\(\);/);
  assert.match(ai, /<LiveStartReopen\.Provider value=\{liveNew && liveClosed \? showLiveColumn : null\}>/);
  assert.match(ai, /onClose=\{openingHere \? stopLiveOpening : closeLiveColumn\}/);
  assert.match(ai, /const closeLiveColumn = \(\): void => setLiveColumnClosed\(true\);\s+const showLiveColumn = \(\): void => setLiveColumnClosed\(false\);\s+const stopLiveOpening = \(\): void => \{ liveOpeningStore\.set\(null\); \};/);
  // The head's button there shows the column and starts nothing, whatever About says.
  const fresh = read(NEW);
  assert.match(fresh, /export const LiveStartReopen = createContext<\(\(\) => void\) \| null>\(null\);/);
  assert.match(fresh, /aria-label=\{reopen \? t\('messages:newThread\.live\.showLabel'\) : t\('messages:newThread\.live\.startLabel', \{ app: appName \}\)\}/);
  assert.equal(message('messages:newThread.live.showLabel'), 'Show the live preview column');
});
