// #4455: a change's page, drawn as a Messages reply thread, as a request's
// page is (#4453, tests/request-thread-page.test.js).
//
// The change is the root post (features/dev-board/topic/change-head.tsx,
// covered with the view models in tests/needs-you-change-page.test.js); its
// replies and everything that happened to it are one stream in time order
// (features/group-chat/transcript.tsx `ChangeRows`), whose rules are
// features/dev-board/topic/change-model.ts. The thread is mounted by
// `AppView._mountTopicThread` with `language: 'change'`, which
// public/js/group-chat.js carries to the shell (thread-shell.tsx) and the
// transcript. #4452's one testing bar is drawn by the head's Testing card.
//
// Run with: node --test tests/change-thread-page.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/change-model.ts';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const SHELL = 'frontend/src/features/group-chat/thread-shell.tsx';

const row = (patch) => ({
  id: null, kind: 'message', username: 'maya', time: '09:05 AM',
  timeTitle: 'Oct 8, 2026, 09:05 AM', at: '2026-10-08T09:05:00Z', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false,
  flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
  reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  event: null, eventHref: null,
  ...patch,
});
const ev = (patch) => ({ sessionId: '4368', prNumber: '4368', title: '', actor: '', sender: '', mine: false,
  force: false, votes: '', icon: null, here: true, ...patch });

test('things that happened are single lines, in the page’s own words', () => {
  const { changeLine } = loadTsx(MODEL);
  const line = (patch) => JSON.parse(JSON.stringify(changeLine(row(patch))));
  // A line the page words is one whole message: its id, and what it is read
  // with. <0> is who did it (drawn bold), <1> a vote's reason.
  assert.deepEqual(line({ kind: 'vote', event: ev({ type: 'submitted', actor: 'snait' }) }),
    { kind: 'submitted', glyph: '🗳️', actor: 'snait', id: 'project:topic.change.line.askedForApproval', values: { author: 'snait' } });
  assert.equal(message('project:topic.change.line.askedForApproval'), '<0>{{author}}</0> asked for approval');
  assert.deepEqual(line({ kind: 'vote', event: ev({ type: 'vote', actor: 'cilokman', vote: 'yes' }) }),
    { kind: 'vote', glyph: '✅', actor: 'cilokman', id: 'project:topic.change.line.votedYes', values: { voter: 'cilokman' } });
  assert.equal(message('project:topic.change.line.votedYes'), '<0>{{voter}}</0> voted yes');
  // A yes a newer push retired (services/vote-revision.js) says so.
  assert.equal(line({ kind: 'vote', event: ev({ type: 'vote', actor: 'cilokman', vote: 'yes', earlier: true }) }).id,
    'project:topic.change.line.votedYesEarlier');
  assert.equal(message('project:topic.change.line.votedYesEarlier'), '<0>{{voter}}</0> voted yes on an earlier version');
  assert.deepEqual(line({ kind: 'vote', event: ev({ type: 'vote', actor: 'jo', vote: 'no', reason: 'Not yet' }) }),
    { kind: 'vote', glyph: '✋', actor: 'jo', id: 'project:topic.change.line.votedNoReason', values: { voter: 'jo', reason: 'Not yet' } });
  assert.equal(message('project:topic.change.line.votedNoReason'), '<0>{{voter}}</0> voted no<1>: “{{reason}}”</1>');
  // The two long build notices: the start is the Testing card's to say; the
  // finish is one line with its door.
  assert.equal(changeLine(row({ kind: 'system', stagingBuild: 'started', systemText: 'Building a staging preview…' })), null);
  assert.deepEqual(line({ kind: 'system', stagingBuild: 'ready', systemText: 'The staging preview for PR #4368 is ready…' }),
    { kind: 'preview', glyph: '👀', actor: null, id: 'project:topic.change.line.previewReady', tryIt: true });
  assert.equal(message('project:topic.change.line.previewReady'), 'The preview is ready');
  assert.equal(line({ kind: 'system', event: ev({ type: 'merged', votes: '2/3' }) }).text, 'This change went live with 2/3 votes');
  assert.deepEqual(line({ kind: 'system', event: ev({ type: 'notice', text: 'Synced with main.' }) }),
    { kind: 'notice', glyph: '•', actor: null, text: 'Synced with main.' });
  // A person's message is a Messages row, not a line.
  assert.equal(changeLine(row({ kind: 'message' })), null);
});

// One request, one story: Homeroom bot's plan on its change reads as the
// plan itself, "Plan v1: {title} · Read"; a person's share keeps its line.
test('Homeroom bot\'s plan on a change is "Plan v{n}: {title}", with its Read', () => {
  const { changeLine } = loadTsx(MODEL);
  const share = (patch) => ({ title: 'Dark mode', previewTitle: 'Dark mode', sharedBy: 'homeroom_bot', version: 2,
    built: null, prNumber: null, sessionId: 51, snippetHtml: null, snippetText: null, ...patch });
  assert.deepEqual(JSON.parse(JSON.stringify(changeLine(row({ kind: 'spec_share', specShare: share() })))),
    { kind: 'spec', glyph: '📋', actor: null, id: 'project:topic.change.line.botPlan', values: { version: 2, title: 'Dark mode' } });
  assert.equal(message('project:topic.change.line.botPlan'), 'Plan v{{version}}: {{title}}');
  assert.equal(changeLine(row({ kind: 'spec_share', specShare: share({ sharedBy: 'evan' }) })).id, 'project:topic.change.line.postedSpec');
  const view = {
    lead: { earlier: false, placeholder: null, language: 'change', change: { closed: false } },
    messages: [row({ id: 9, kind: 'spec_share', specShare: share() })],
  };
  const html = renderComponent(TRANSCRIPT, 'ChangeRows', { view });
  assert.match(html, /data-change-event="spec"[\s\S]*?Plan v2: Dark mode · <button[^>]*>Read</);
});

test('the stream keeps every person and every line it draws; "N replies" counts the people', () => {
  const { changeStream, changeReplyCount } = loadTsx(MODEL);
  const rows = [
    row({ id: 1, kind: 'vote', event: ev({ type: 'submitted', actor: 'snait' }) }),
    row({ id: 2, kind: 'system', stagingBuild: 'started', systemText: 'Building…' }),
    row({ id: 3, kind: 'system', stagingBuild: 'ready', systemText: 'Ready.' }),
    row({ id: 4, username: 'cilokman' }),
    row({ id: 5, deleted: true }),
  ];
  const out = changeStream(rows);
  assert.deepEqual(out.map((m) => m.id), [1, 3, 4, 5]);
  assert.equal(changeReplyCount(out), 1, 'a deleted message is not a reply');
});

test('ChangeRows: "N replies", then Messages rows and quiet lines in the order they happened', () => {
  const view = {
    lead: { earlier: false, placeholder: null, language: 'change', change: { loaded: true, closed: null } },
    messages: [
      row({ id: 1, kind: 'vote', time: '1:36 PM', event: ev({ type: 'submitted', actor: 'snait' }) }),
      row({ id: 2, kind: 'system', stagingBuild: 'started', systemText: 'Building a staging preview…' }),
      row({ id: 3, kind: 'system', time: '1:37 PM', stagingBuild: 'ready', systemText: 'The staging preview is ready.',
        event: ev({ type: 'notice', text: 'The staging preview is ready.' }) }),
      row({ id: 4, kind: 'vote', time: '1:37 PM', event: ev({ type: 'vote', actor: 'cilokman', vote: 'yes', earlier: true }) }),
      row({ id: 5, username: 'cilokman', bodyHtml: '<p>Looks good on my phone.</p>' }),
      row({ id: 6, kind: 'vote', time: '1:40 PM', event: ev({ type: 'vote', actor: 'jo', vote: 'no', reason: 'Not yet' }) }),
    ],
  };
  const html = renderComponent(TRANSCRIPT, 'ChangeRows', { view });
  assert.match(html, /class="messages-reply-count" data-change-replies="1"><span>1 reply<\/span>/);
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('data-change-event="submitted"') < at('data-change-event="preview"'));
  assert.ok(at('data-change-event="preview"') < at('data-change-event="vote"'));
  assert.ok(at('data-change-event="vote"') < at('Looks good on my phone.'));
  assert.match(html, /<b>snait<\/b> asked for approval<span class="dev-request-event-time"[^>]*> · 1:36 PM<\/span>/);
  assert.match(html, /The preview is ready · <button type="button" class="dev-request-event-link">Try it<\/button>/);
  assert.match(html, /<b>cilokman<\/b> voted yes on an earlier version/);
  assert.match(html, /<b>jo<\/b> voted no<span class="dev-change-event-reason">: “Not yet”<\/span>/, 'a vote\'s reason, quoted after it');
  assert.doesNotMatch(html, /Building a staging preview/, 'the long build notice is not drawn');
  assert.doesNotMatch(html, /gc-event-box|gc-bubble/, 'no boxed notices, no bubbles');
});

test('a change nobody else can see yet says so instead of a stream', () => {
  const closed = 'Only you can see this change. Share it with the group to start a discussion.';
  const html = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: true, closed } }, messages: [] },
  });
  assert.match(html, /No replies yet/);
  assert.match(html, /<p class="dev-change-closed-note">Only you can see this change\./);
  const loading = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: false, closed: null } }, messages: [] },
  });
  assert.match(loading, /Loading replies…/);
});

test('the shell draws a change page as the request page’s sheet, with Messages’ composer', () => {
  const html = renderComponent(SHELL, 'ThreadShell', {
    fill: true, withHeader: true, readOnly: false, notice: '', placeholder: 'Reply…', maxLength: 4000, change: true,
  });
  assert.match(html, /^<div class="dev-request dev-change platform-kb-column"><div id="gc-thread-back" class="dev-request-back"><\/div><section class="dev-request-sheet dc-lift dc-lift-session" aria-label="Change"><div id="gc-thread-bar" class="dev-request-bar"><\/div>/);
  assert.match(html, /<div id="gc-thread-head"><\/div><div id="gc-thread-messages"><\/div>/);
  assert.match(html, /class="messages-composer messages-composer-thread platform-safe-bar"/);
  const request = renderComponent(SHELL, 'ThreadShell', {
    fill: true, withHeader: true, readOnly: false, notice: '', placeholder: 'Reply…', maxLength: 4000, request: true,
  });
  assert.match(request, /^<div class="dev-request platform-kb-column">[\s\S]*aria-label="Request"/, 'the request page is unchanged');
});

test('group-chat.js carries the change language from the mount to the shell and the transcript', () => {
  const src = read('public/js/group-chat.js');
  assert.match(src, /const language = \['chat', 'request', 'change'\]\.includes\(opts\.language\) \? opts\.language : 'flat';/);
  assert.match(src, /change: fill && language === 'change',/);
  assert.match(src, /if \(closed\) return;\n\s+if \(!st\.loaded\) GroupChat\.loadThreadHistory\(type, ref\);/,
    'an unshared change\'s thread is not read');
  assert.match(src, /\.\.\.\(language === 'change' \? \{ change: \{ loaded: !!\(st\.loaded \|\| a\.closed\), closed: a\.closed \|\| null \} \} : \{\}\),/);
  // Notices are events on a change's page too, as they were in its Discussion.
  assert.match(src, /const chat = !!\(opts && \(opts\.language === 'chat' \|\| opts\.language === 'change'\)\);/);
  assert.match(src, /meta\.stagingBuild === 'started' \|\| meta\.stagingBuild === 'ready'/);
  const view = read('public/js/app-view.js');
  assert.match(view, /language: 'change',\n\s+placeholder: PlatformI18n\.t\('changes:page\.thread\.replyPlaceholder'\),/);
  assert.equal(require('./lib/platform-i18n').message('changes:page.thread.replyPlaceholder'), 'Reply…');
});

test('a moving bar is the lit ink, a finished one green with its check, and AGENTS.md says a finished bar may be green', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-change-bar-fill\[data-state="moving"\],\n\.dev-change-gate\[data-done="false"\] \.dev-change-bar-fill\[data-state="done"\] \{ background: var\(--lit-ink\); \}/);
  assert.match(css, /\.dev-change-gate\[data-done="true"\] \.dev-change-bar-fill\[data-state="done"\] \{ background: var\(--state-ok\); \}/);
  assert.match(css, /\.dev-change-gate\[data-tone="done"\] \.dev-change-gate-figure \{ color: var\(--state-ok\); font-weight: 600; \}/);
  assert.match(css, /\.dev-change-gate-check \{[^}]*color: var\(--state-ok\);/);
  assert.match(css, /\.dev-change-shots \.shots-stage \{ margin: 0 8px; aspect-ratio: 4 \/ 5; \}/, 'a taller frame on a phone');
  assert.match(read('AGENTS.md'), /A finished progress bar may be green \(`--state-ok`/);
});
