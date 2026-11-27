'use strict';

// The overnight UI audit's chat, sheet and dialog findings (1 to 2 Nov 2026,
// batch 5b): what each fix holds, pinned where it lives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

/** The phone drawer's block of app.css (max-width 767.98px), as the drawer's rows read it. */
function drawerRules() {
  const start = CSS.indexOf('.messages-layout.messages-drawer { position: relative;');
  assert.ok(start > 0, 'the drawer block is there');
  return CSS.slice(start, CSS.indexOf('/* ── The hero\'s rows', start));
}

test('C03: the phone\'s Messages list keeps the rows\' own type and time', () => {
  const block = drawerRules();
  // The rows are the shared row (ListRow) on a phone as on a desktop: the
  // drawer's block draws nothing of them, so it cannot shrink their type or
  // hide their time.
  assert.doesNotMatch(block, /\.messages-(conversation-row|row-name|row-preview|row-time)/, 'no row rules in the drawer');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /<ListRow\s+as="a"\s+href=\{`#messages\/\$\{conversation\.id\}`\}/, 'the shared row');
  assert.match(screen, /top=\{<time dateTime=\{conversation\.lastActivityAt\} title=\{activity\.title\}>\{activity\.text\}<\/time>\}/, 'the time stays');
});

test('C06: an empty reply box on a request or a channel shows Send faded, as Messages does', () => {
  // One message box (27 Nov 2026): a request's and a channel's box is
  // Messages' own, which marks staged files on its card as the chat's did.
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /<div className="messages-composer-card" id=\{ids\.card\} data-gc-files=\{staged\.length \? '' : undefined\}>/);
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /<MessageBox place=\{place\}/);
  assert.match(CSS, /\.messages-send:disabled \{ opacity: \.35; \}/);
  assert.match(CSS, /\.messages-composer-card:not\(\[data-gc-files\]\):has\(textarea:placeholder-shown\) \.messages-send \{ opacity: \.35; \}/);
});

test('C04: a desktop conversation with nothing beside it keeps a reading width', () => {
  // The list sits beside a conversation again (7 Nov 2026), so "nothing
  // beside it" is a conversation set to Full width.
  assert.match(CSS, /\.messages-layout\.messages-list-collapsed > \.messages-thread-pane:last-child \{\s*max-width: 960px;\s*margin-inline: auto;\s*\}/);
});

test('D13: the hover bar on somebody else\'s bubble hangs off its name line, beside the message', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const barBesideHead = sided && !mine && !grouped;/);
  assert.match(row, /\{status\}\{barBesideHead \? actions : null\}<\/div>\}/);
  assert.match(row, /\{barBesideHead \? null : actions\}\n\s*<MessageActionSheet/);
  assert.match(CSS, /\.messages-message-head > \.messages-message-actions \{ top: -10px; inset-inline-end: auto; inset-inline-start: calc\(100% \+ 8px\); \}/);
});

test('D09: the new-message picker offers no Block beside each person', () => {
  const dialog = read('frontend/src/features/messages/create-dialog.tsx');
  assert.doesNotMatch(dialog, /void block\(user\)|create\.result\.block/);
  assert.match(dialog, /onClick=\{\(\) => void unblock\(user\)\}/, 'Blocked people still unblocks');
});

test('D03: the Invite pane says a link went out on its first Copy or Share, not on opening', () => {
  const pane = read('frontend/src/features/app-context/invite-pane.tsx');
  assert.match(pane, /void inviteApi\(`\/api\/invite-links\/\$\{link\.id\}\/shared`, \{ method: 'POST' \}\)/);
  // The link now carries the "copied" tag (#6540); the sent note still
  // fires on the press itself, before anything else.
  assert.match(pane, /await navigator\.clipboard\.writeText\(withVia\(url, 'copied'\)\);\n\s*noteSent\(current\);/);
  assert.match(pane, /if \(current\) noteSent\(current\);\n\s*setSentOut\(true\);/);
  const route = read('src/routes/community-invites.js');
  assert.match(route, /router\.post\('\/api\/invite-links\/:id\/shared', drainGuard, sameOriginBrowserOnly,/);
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /AND \(i\.shared_at IS NOT NULL OR EXISTS \(\n\s*SELECT 1 FROM community_invite_redemptions y WHERE y\.invite_id = i\.id\)\)/);
  assert.match(read('src/db/migrations/0010-invite-link-shared.sql'), /ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;/);
});

test('D07: the waiting decisions sit under "Go to community", and an Invite opened from the hub has no back disc', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /\{sub \? \(\n\s*<span className="flex-1 min-w-0">\n\s*<span className="block truncate font-medium">\{label\}<\/span>\n\s*\{sub\}/);
  assert.match(sheet, /sub=\{owed \? \(\n\s*<span\n\s*id="app-menu-workshop-owed"/);
  assert.match(sheet, /\{back === 'none' \? null : \(\n\s*<button\n\s*id="app-about-back"/);
  const controller = read('frontend/src/features/app-context/app-context-controller.js');
  assert.match(controller, /appContextStore\.set\(\{ back: opts\.back === 'about' \? 'about' : 'none' \}\);/);
});
