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
  assert.doesNotMatch(html, /gc-thread-pin/, 'a change page has no pin host any more (#6419)');
  // The bar is the chat foot's (1 November 2026), Messages' own classes kept.
  assert.match(html, /class="messages-composer messages-composer-thread chat-composer-bar platform-safe-bar"/);
  const request = renderComponent(SHELL, 'ThreadShell', {
    fill: true, withHeader: true, readOnly: false, notice: '', placeholder: 'Reply…', maxLength: 4000, request: true,
  });
  assert.match(request, /^<div class="dev-request platform-kb-column">[\s\S]*aria-label="Request"/, 'the request page is unchanged');
  assert.doesNotMatch(request, /gc-thread-pin/, 'a request page has no pin host');
});

// #6419 (replacing #5725's repeat): on a long change page the real Votes
// and Testing card pair sticks under the sheet's header and shrinks to one
// line each, and lets go at the end of the change's own content, above the
// replies. There is no second Votes card any more.
test('a change page’s gate pair sticks and shrinks instead of repeating', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.doesNotMatch(src, /dev-change-gate-repeat|topInView|gc-thread-pin/);
  assert.doesNotMatch(src, /repeat\?: boolean/);
  // Only the change's own page holds the pair in `dev-change-root`, which is
  // what asks it to stick; a change section on a request's page draws it as
  // before. The caller stays one plain element either way.
  assert.match(src, /<ChangeGates ref=\{pair\} id=\{id\} card=\{card\} v=\{v\} \/>/);
  assert.match(src, /setStick\(!!pair\.current\?\.closest\('\.dev-change-root'\)\);/);
  // The scroller comes from the mark itself, never by a document-wide id:
  // another pane can hold the same id (#4640).
  assert.match(src, /const scroller = el \? el\.closest<HTMLElement>\('#gc-thread-scroll'\) : null;/);
  assert.match(src, /\{ root: scroller, rootMargin: '4px 0px 0px 0px' \}/);
  assert.doesNotMatch(src, /document\.getElementById\('gc-thread-(scroll|pin)'\)/);
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-change-pair\[data-stick\] \{ position: sticky; top: -4px; z-index: 10; \}/);
  assert.match(css, /\.dev-change-pair\[data-stuck\] \{[^}]*background-color: var\(--dc-sheet-solid\);[^}]*\}/);
  assert.match(css, /\.dev-change-pair\[data-stuck\] :is\([^)]*\.dev-change-bar[^)]*\) \{ display: none; \}/);
  assert.doesNotMatch(css, /\.dev-change-gate-repeat|#gc-thread-pin/);
});

test('the gate pair paints plain and decides in the browser whether it sticks', () => {
  const gate = (name, figure, tone) => ({
    name, figure, tone, done: false, label: `x`, note: [], segments: [{ weight: 1, pct: 0, state: 'moving' }],
  });
  const v = {
    votes: gate('Votes', 'Needs 1 more yes', 'ask'),
    testing: gate('Testing', 'Checking it', 'muted'),
  };
  // Effects do not run under renderToStaticMarkup, so the first paint is the
  // plain pair at full size; `data-stick` and the sentinel follow on mount.
  const plain = renderComponent('frontend/src/features/dev-board/topic/change-head.tsx', 'ChangeGates', {
    id: 7, card: {}, v,
  });
  assert.doesNotMatch(plain, /dev-change-pair-mark|data-stick/);
  assert.match(plain, /^<div class="dev-change-pair">/);
  assert.ok(plain.indexOf('data-change-gate="votes"') < plain.indexOf('data-change-gate="testing"'), 'Votes leads');
});

test('group-chat.js carries the change language from the mount to the shell and the transcript', () => {
  const src = read('public/js/group-chat.js');
  // #6440 adds a governance vote's page ('decision') as a fourth language;
  // the change page's own wiring is unchanged.
  assert.match(src, /const language = \['chat', 'request', 'change', 'decision'\]\.includes\(opts\.language\) \? opts\.language : 'flat';/);
  assert.match(src, /change: fill && language === 'change',/);
  assert.match(src, /if \(closed\) return;\n\s+if \(!st\.loaded\) GroupChat\.loadThreadHistory\(type, ref\);/,
    'an unshared change\'s thread is not read');
  assert.match(src, /\.\.\.\(language === 'change' \? \{ change: \{ loaded: !!\(st\.loaded \|\| a\.closed\), closed: a\.closed \|\| null, issue: a\.issue \|\| null \} \} : \{\}\),/);
  // Notices are events on a change's page too, as they were in its Discussion.
  assert.match(src, /const chat = !!\(opts && \(opts\.language === 'chat' \|\| opts\.language === 'change'\)\);/);
  assert.match(src, /meta\.stagingBuild === 'started' \|\| meta\.stagingBuild === 'ready'/);
  const view = read('public/js/app-view.js');
  assert.match(view, /language: 'change',\n\s+placeholder: PlatformI18n\.t\('changes:page\.thread\.replyPlaceholder'\),/);
  assert.equal(require('./lib/platform-i18n').message('changes:page.thread.replyPlaceholder'), 'Reply…');
});

// #5007: a change built for a request points its replies at that request,
// where the conversation about the change lives. The mount passes the first
// linked request (the one the head's Built for row names first), and the
// unshared notes say the conversation is on the request instead of inviting
// a discussion that cannot start here.
test('the mount points a change built for a request at that request, and only then', () => {
  const src = read('public/js/group-chat.js');
  assert.match(src, /const issue = language === 'change' && opts\.issue && Number\.isInteger\(opts\.issue\.n\)\n\s+&& typeof opts\.issue\.href === 'string' && opts\.issue\.href\.startsWith\('#app\/'\)\n\s+\? \{ n: opts\.issue\.n, href: opts\.issue\.href \} : null;/,
    'only the change language takes an issue pointer, with the in-app href');
  assert.match(src, /\.\.\.\(closed \? \{ closed \} : \{\}\), \.\.\.\(issue \? \{ issue \} : \{\}\)/, 'the pointer rides on activeThread');
  const view = read('public/js/app-view.js');
  assert.match(view, /const linked = AppView\._sanitizeIssueNumbers\(Array\.isArray\(item && item\.linked_issues\) \? item\.linked_issues : \[\]\);/);
  assert.match(view, /const issue = linked\.length\n\s+\? \{ n: linked\[0\], href: `#app\/\$\{AppView\.appData\?\.slug \|\| App\.currentApp\}\/dev\/issues\/\$\{linked\[0\]\}` \}\n\s+: null;/);
  assert.match(view, /\.\.\.\(issue \? \{ issue \} : \{\}\),/);
  assert.match(view, /closed: issue\n\s+\? PlatformI18n\.t\('changes:page\.thread\.onlyYouLinked'\)\n\s+: PlatformI18n\.t\('changes:page\.thread\.onlyYou'\),/);
  assert.match(view, /notice: issue\n\s+\? PlatformI18n\.t\('changes:page\.thread\.shareToDiscussLinked'\)\n\s+: PlatformI18n\.t\('changes:page\.thread\.shareToDiscuss'\),/);
  assert.equal(message('project:topic.change.stream.conversationOn'), 'Conversation lives on <0>#{{number}}</0>');
  assert.equal(message('project:topic.change.stream.moreConversationOn'), 'More of the conversation is on <0>#{{number}}</0>');
  assert.equal(message('changes:page.thread.onlyYouLinked'), 'Only you can see this change. Its conversation so far is on the request.');
  assert.equal(message('changes:page.thread.shareToDiscussLinked'), 'Share this change to discuss it here. Until then, reply on the request.');
});

test('ChangeRows: a change built for a request says the conversation lives on it', () => {
  const issue = { n: 4856, href: '#app/homeroom/dev/issues/4856' };
  // Closed (nobody else can see the change yet) with a request: the pointer
  // row replaces "No replies yet", the note says the conversation is there.
  const closed = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: true, closed: 'Only you can see this change. Its conversation so far is on the request.', issue } }, messages: [] },
  });
  assert.match(closed, /<div class="messages-reply-count dev-change-issue-pointer" data-change-issue="4856"><span>Conversation lives on <a href="#app\/homeroom\/dev\/issues\/4856" class="dev-change-issue-link" data-issue-ref="4856">#4856<\/a><\/span><\/div>/);
  assert.match(closed, /Its conversation so far is on the request\./);
  assert.doesNotMatch(closed, /No replies yet/);
  // Loaded, no replies of its own: the same pointer row, no closed note.
  const empty = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: true, closed: null, issue } }, messages: [] },
  });
  assert.match(empty, /data-change-issue="4856"[^>]*><span>Conversation lives on <a href="#app\/homeroom\/dev\/issues\/4856"/);
  assert.doesNotMatch(empty, /dev-change-closed-note|No replies yet/);
  // Replies of its own too: "More of the conversation" above the usual row.
  const replied = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: true, closed: null, issue } }, messages: [row({ id: 4, username: 'cilokman' })] },
  });
  assert.match(replied, /<p class="dev-change-issue-pointer" data-change-issue="4856"><span>More of the conversation is on <a href="#app\/homeroom\/dev\/issues\/4856" class="dev-change-issue-link" data-issue-ref="4856">#4856<\/a><\/span><\/p>/);
  assert.match(replied, /class="messages-reply-count" data-change-replies="1"><span>1 reply<\/span>/);
  // While the replies load, the line is "Loading replies…" as before.
  const loading = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: false, closed: null, issue } }, messages: [] },
  });
  assert.match(loading, /Loading replies…/);
  assert.doesNotMatch(loading, /Conversation lives on/);
});

test('ChangeRows: a change built for no request keeps today\'s empty states', () => {
  const closed = 'Only you can see this change. Share it with the group to start a discussion.';
  const html = renderComponent(TRANSCRIPT, 'ChangeRows', {
    view: { lead: { language: 'change', change: { loaded: true, closed } }, messages: [] },
  });
  assert.match(html, /<div class="messages-reply-count" data-change-replies="0"><span>No replies yet<\/span><\/div>/);
  assert.match(html, /Share it with the group to start a discussion\./);
  assert.doesNotMatch(html, /dev-change-issue-pointer|Conversation lives on/);
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

// #6419: the real Votes card is the only one, so `data-change-gate` always
// names the card itself, and no declared check selects the stuck form (the
// checks run on a page nobody scrolled).
test('a gate card always carries its own data-change-gate, and nothing selects the stuck form', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(src, /data-change-gate=\{which\}/);
  const dapp = JSON.parse(read('dapp.json'));
  const selectors = dapp.tests.map((t) => t.expectSelector).filter(Boolean);
  assert.ok(selectors.some((s) => String(s).includes('[data-change-gate=')), 'declared checks read the attribute');
  assert.ok(!selectors.some((s) => String(s).includes('data-change-gate-repeat') || String(s).includes('data-stuck')),
    'none selects the stuck form');
});

// Issue #5712: at phone width the Testing card's buttons took the auto
// column, squeezing "Testing" and "Found a problem" into a sliver where they
// drew over each other and the bar. The phone rules stack the card.
test('on a phone the gate card stacks its buttons under its line', () => {
  const css = read('public/css/app.css');
  const blocks = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const phone = blocks.find((b) => b.includes('.dev-change-chips'));
  assert.ok(phone, 'the change page has a phone block');
  assert.match(phone, /\.dev-change-gate \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(phone, /\.dev-change-gate-act \{[^}]*order: 1;[^}]*flex-wrap: wrap;[^}]*\}/);
  assert.match(phone, /\.dev-change-gate-head \{ flex-wrap: wrap; row-gap: 2px; \}/);
  assert.match(phone, /\.dev-change-gate-name \{ min-width: 0; \}/);
  assert.match(phone, /\.dev-change-gate-figure \{ white-space: nowrap; \}/);
  // #6419: while stuck the pair keeps one line on a phone too, the Vote
  // button back on the card's own line rather than under it.
  assert.match(phone, /\.dev-change-pair\[data-stuck\] \.dev-change-gate \{ grid-template-columns: minmax\(0, 1fr\) auto; padding: 8px 12px; \}/);
  assert.match(phone, /\.dev-change-pair\[data-stuck\] \.dev-change-gate-act \{ order: 0; margin-top: 0; flex-wrap: nowrap; \}/);
  const wider = css.replace(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(wider, /\.dev-change-pair\[data-stuck\] \.dev-change-gate-act/, 'the phone-only part of the stuck card lives in the phone block');
  // Desktop keeps today's two columns: one for the text, one for the buttons.
  assert.match(css, /\.dev-change-gate \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
});

// Issue #5178: the sheet's header shows the change's status pill beside
// "Change #N", in the board card's own words and capsule form — so the page
// answers "is it live?" where the reader first looks. The thread view
// carries the card's own state (tests/needs-you-change-page.test.js); this
// is the drawing of it.
const view = (status) => ({
  number: 81, category: null, author: 'snait', at: null, time: '10:03', timeTitle: '',
  via: 'via Claude Code', status, votes: {}, testing: {}, shots: null, thanks: false,
});

test('the change bar publishes the page\'s pill and its ⋯ key for the column beside the bot page (#6431)', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  // The bar itself does not change: the column's heading draws the pill and
  // the rows beside the bot page, and this is what tells it which.
  assert.match(src, /usePanelHead\(\{ kind: 'change', pill: v\.status \|\| null, menuKey: menuKey \|\| null \}\);/);
  // A change's number was a button in its own bar, and that bar goes beside
  // the bot page; the column's heading still links "Change #N" to its page.
  const store = read('frontend/src/features/side-panel/head-store.ts');
  assert.match(store, /if \(!isEmbeddedPanel\(\)\) return undefined;/,
    'and nothing is published where the page keeps its own bar');
});

test('the header shows the status pill beside "Change #N", in the card\'s capsule form', () => {
  const head = 'frontend/src/features/dev-board/topic/change-head.tsx';
  const failed = renderComponent(head, 'ChangeBar', {
    v: view({ tier: 0, key: 'delivery_failed', label: message('changes:badge.pill.failed'), tone: 'blocked',
      title: message('changes:badge.pill.failedTitle') }),
    menuKey: '',
  });
  assert.match(failed, /<div class="messages-thread-name min-w-0">Change #81<\/div>/);
  assert.match(failed, /<span class="shrink-0" data-change-status="delivery_failed"><span class="gc-vote-count gc-vote-count-blocked dev-status-pill"/);
  assert.doesNotMatch(failed, /dev-status-pill-block|dev-status-pill-vote/, 'the capsule form, not the board card\'s bar');
  assert.match(failed, new RegExp(`>${message('changes:badge.pill.failed')}<`));
  assert.match(failed, /title="This change was approved, but the app failed to rebuild with it\."/);
  // A live change reads "✓ Live" in the ok tone; no pill, no attribute.
  const live = renderComponent(head, 'ChangeBar', {
    v: view({ tier: 0, key: 'deployed', label: message('changes:badge.pill.live'), tone: 'ok' }),
    menuKey: '',
  });
  assert.match(live, /data-change-status="deployed"[^>]*><span class="gc-vote-count gc-vote-count-ok dev-status-pill"/);
  assert.match(live, new RegExp(`>${message('changes:badge.pill.live')}<`));
  // Being built or closed: the header is as it was.
  const none = renderComponent(head, 'ChangeBar', { v: view(null), menuKey: '' });
  assert.doesNotMatch(none, /data-change-status|gc-vote-count/);
  assert.match(none, /<div class="messages-thread-name min-w-0">Change #81<\/div>/);
  // #5683: a change being voted on keeps its pill beside the title, as it
  // always did (snait asked for it back). The Votes card under the title
  // gives the fuller account; the pill still says where it stands at a glance.
  for (const key of ['needs_vote', 'approvals', 'contested', 'no_vote', 'merge_countdown', 'reject_countdown']) {
    const vote = renderComponent(head, 'ChangeBar', {
      v: view({ tier: 4, key, label: 'Goes live in ~2 h', tone: 'ok' }), menuKey: '',
    });
    assert.match(vote, new RegExp(`<span class="shrink-0" data-change-status="${key}"><span class="gc-vote-count gc-vote-count-ok dev-status-pill"`), `${key} keeps its pill`);
    assert.match(vote, />Goes live in ~2 h</);
  }
});

// #5329: where the ⋯ menu has a Details row (the change has a technical
// half), the header's "Change #N" title itself opens the Details sheet.
// The ⋯ Details row's gate is `body.changeId` (AppView._topicCard), and the
// head passes the same gate to the bar as `detailsId`.
test('the header title is a button that opens Details where the ⋯ menu has a Details row', () => {
  const head = 'frontend/src/features/dev-board/topic/change-head.tsx';
  const open = renderComponent(head, 'ChangeBar', { v: view(null), menuKey: '', detailsId: 81 });
  assert.match(open, /<div class="messages-thread-name min-w-0"><button type="button" class="messages-thread-name-link" data-change-details-open=""/);
  assert.match(open, /aria-label="Change #81, see details" title="See details">Change #81<\/button><\/div>/);
  assert.equal(message('project:topic.change.bar.openDetails', { title: 'Change #81' }), 'Change #81, see details');
  assert.equal(message('project:topic.change.bar.openDetailsTitle'), 'See details');
  // Without the gate, the title is the plain div it always was.
  const plain = renderComponent(head, 'ChangeBar', { v: view(null), menuKey: '' });
  assert.doesNotMatch(plain, /messages-thread-name-link/);
  assert.match(plain, /<div class="messages-thread-name min-w-0">Change #81<\/div>/);
});

test('the title button opens details the way the ⋯ row does, on the row\'s gate', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(src, /onClick=\{\(\) => \(window as any\)\.AppView\?\.openTechnicalDetails\?\.\(detailsId\)\}/,
    'the title button calls the same openTechnicalDetails the ⋯ row calls');
  assert.match(src, /detailsId=\{id && body\.changeId \? id : null\}/,
    'the head gates the title on body.changeId, the ⋯ Details row\'s gate');
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-thread-name-link:hover \{ text-decoration: underline;/);
  assert.match(css, /\.messages-thread-name-link:focus-visible \{ outline: 2px solid var\(--accent\);/);
});

// 3 Nov 2026 (#6237): a change's number comes from GitHub's own pull request
// counter on a project whose code is on GitHub, so it reads "PR 6230" and a
// "#6230" can only be a request. On Homeroom's git host requests and changes
// share one counter, so both keep "#N".
const CHANGES = 'frontend/src/features/dev-board/topic/thread-changes.tsx';
const githubChange = {
  type: 'change', id: 91, number: 6230, title: 'Put plans in their own column',
  status: 'promoted', state: 'review', replies: 0, by: 'homeroom_bot', closes: [6231],
};
const withRepo = (repoUrl, run) => {
  const wasWindow = globalThis.window;
  globalThis.window = {
    AppView: { appData: { slug: 'homeroom', repo_url: repoUrl } },
    addEventListener() {}, removeEventListener() {},
  };
  try { return run(); } finally {
    if (wasWindow === undefined) delete globalThis.window; else globalThis.window = wasWindow;
  }
};

test('#6237: on a GitHub-hosted project a change reads "PR 6230", and "#" is a request', () => {
  const html = withRepo('https://github.com/Usernode-Labs/social-vibecoding', () =>
    renderComponent(CHANGES, 'ChangeLine', { item: githubChange, view: null }));
  assert.match(html, /Change · PR 6230 · homeroom_bot/, 'the change\'s heading');
  assert.doesNotMatch(html, /Change #6230/, 'never the request form');
  assert.equal(message('project:topic.thread.page.changeNumberedPr', { number: 6230, by: 'homeroom_bot' }),
    'Change · PR 6230 · homeroom_bot');

  // The elsewhere card: its own change reads PR, the request it lives on
  // keeps '#', so the two numbers can never be mistaken for one another.
  const elsewhere = withRepo('https://github.com/Usernode-Labs/social-vibecoding', () =>
    renderComponent(CHANGES, 'Elsewhere', { list: [{ id: 91, number: 6223, on: 6207, request: 6210 }] }));
  assert.match(elsewhere, /Change PR 6223/);
  assert.match(elsewhere, /says it closes this/);
  assert.match(elsewhere, /href="#app\/homeroom\/dev\/issues\/6207"/);
  assert.doesNotMatch(elsewhere, /Change #6223/);
  assert.equal(message('project:topic.thread.page.claimsPr', { number: 6223 }),
    '<0>Change PR 6223</0> says it closes this');

  // The tag on a reply written on the change.
  assert.equal(message('project:topic.request.stream.onChangePr', { number: 6230 }), 'on change PR 6230');
  assert.match(read(TRANSCRIPT),
    /projectChangesOnGithub\(\) \? 'project:topic\.request\.stream\.onChangePr' : 'project:topic\.request\.stream\.onChange'/);
});

test('#6237: on Homeroom\'s git host, requests and changes share one counter and keep "#N"', () => {
  const html = withRepo('https://git.onhomeroom.com/apps/social-vibecoding', () =>
    renderComponent(CHANGES, 'ChangeLine', { item: githubChange, view: null }));
  assert.match(html, /Change #6230 · homeroom_bot/);
  assert.doesNotMatch(html, /PR 6230/);
  const elsewhere = withRepo('https://git.onhomeroom.com/apps/social-vibecoding', () =>
    renderComponent(CHANGES, 'Elsewhere', { list: [{ id: 91, number: 6223, on: 6207, request: 6210 }] }));
  assert.match(elsewhere, /Change #6223/);
  assert.match(elsewhere, /says it closes this/);
});

test('#6406: a change built from v1, with a v2 on the request, says so on its plan line', () => {
  const plan = {
    key: 'spec:5:2', title: 'Design: Recipe home, warm and visual', version: 2, by: 'evan', at: null, time: '',
    timeTitle: '', read: { kind: 'shared', sessionId: 5, version: 2, previewTitle: 'Design: Recipe home, warm and visual' },
  };
  const html = withRepo('https://git.onhomeroom.com/apps/recipe-bot', () =>
    renderComponent(CHANGES, 'PlanLine', {
      plan,
      builtFrom: { sessionId: 5, version: 1, newer: { version: 2, author: 'evan', sameAuthor: true } },
    }));
  assert.match(html, /Built from v1 of the plan/);
  assert.match(html, /v2 is newer/);
  assert.ok(html.indexOf('Built from v1') < html.indexOf('v2 is newer'), 'the note follows the plan line');
  assert.match(html, /data-thread-change-newer-plan="2"/);

  const other = withRepo('https://git.onhomeroom.com/apps/recipe-bot', () =>
    renderComponent(CHANGES, 'PlanLine', {
      plan,
      builtFrom: { sessionId: 5, version: 1, newer: { version: 2, author: 'ana', sameAuthor: false } },
    }));
  assert.match(other, /ana(?:&#x27;|')s plan is newer/);

  const none = withRepo('https://git.onhomeroom.com/apps/recipe-bot', () =>
    renderComponent(CHANGES, 'PlanLine', { plan, builtFrom: { sessionId: 5, version: 1 } }));
  assert.match(none, /Built from v1 of the plan/);
  assert.doesNotMatch(none, /is newer/);
});

test('#6237: a stored line\'s "PR #N" is shown as "PR N"; requests keep "#N"', () => {
  const { plainPrRefs, changesOnGithub } = loadTsx('frontend/src/lib/change-ref.ts');
  assert.equal(plainPrRefs('The staging preview for PR #4368 is ready…'), 'The staging preview for PR 4368 is ready…');
  assert.equal(plainPrRefs('Included in #4368'), 'Included in #4368', 'a request keeps its #');
  assert.equal(plainPrRefs('Two: PR #1 and PR #22'), 'Two: PR 1 and PR 22');
  assert.equal(changesOnGithub('https://github.com/a/b'), true);
  assert.equal(changesOnGithub('https://git.onhomeroom.com/apps/b'), false);
  assert.equal(changesOnGithub(null), false, 'no address counts as not GitHub');
});
