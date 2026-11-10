'use strict';

// #6071 follow-up: a new thread with Homeroom bot, from its "+"
// (frontend/src/features/messages/new-thread.tsx), without a database (the
// thread itself is made against PostgreSQL in
// private-threads-postgres.test.js; 1 Nov 2026, a screen drawn in it in
// design-threads-postgres.test.js).
//
// What this pins:
//   1. The "+" is in the Homeroom bot tab's header and in the bot chat's
//      header in Messages, and is nothing without the chat it opens beside.
//   2. The blank thread's first render reads nothing and saves nothing. It
//      opens (5 Nov 2026) on the ways to start, each a pill whose words a tap
//      writes into the box, and on Any project, a chip over the box that
//      opens the "Your communities" rows (project-picker.tsx): no web select.
//   3. The kind of change is read off the start a message begins with.
//   4. The thread is made on the first send, through a same-origin door.
//   5. A started thread is headed by its kind of change and its project, and
//      in the Homeroom bot tab the blank thread takes Main Chat's place.
//   6. Its box is the conversation composer's card, piece for piece.
//   7. 1 Nov 2026: a design start says to describe the screen, and Homeroom
//      bot draws it: no screen to pick.
//   8. 10 Nov 2026: a second chip says who works on it (thread-builder.tsx).
//      Homeroom bot is the default and its send is untouched. With Claude
//      Code or ChatGPT nothing is sent here: the send opens the product with
//      the person's own words in the link, and until Homeroom's connector is
//      connected there the steps to add it take the thread's place.
//
// Run with: node --test tests/bot-new-thread.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NEW_THREAD = 'frontend/src/features/messages/new-thread.tsx';

function load() {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return new Promise(() => {}); } });
  const mod = loadTsx(NEW_THREAD, {
    stubs: {
      './api': api,
      './store': { closeThread: () => calls.push(['closeThread']), openThread: () => {} },
    },
  });
  return { mod, calls };
}

test('the "+" is in both headers, and is nothing without the chat it opens beside', () => {
  const { mod } = load();
  assert.equal(renderToHtml(createElement(mod.NewThreadButton, { conversationId: null, className: 'x' })), '');
  const html = renderToHtml(createElement(mod.NewThreadButton, { conversationId: 7, className: 'messages-thread-action' }));
  const label = message('messages:newThread.start');
  assert.match(html, new RegExp(`^<button type="button" class="messages-thread-action" aria-label="${label}" title="${label}" data-bot-new-thread="">`));
  assert.match(html, /<svg/);
  const ai = read('frontend/src/features/ai/index.tsx');
  const hero = ai.slice(ai.indexOf('const hero = ('), ai.indexOf('</section>', ai.indexOf('const hero = (')));
  assert.match(hero, /<NewThreadButton\n\s+conversationId=\{botId \|\| null\}\n\s+onOpen=\{openBlank\}/, 'in the Homeroom bot tab\'s header');
  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /\{botDm \? <NewThreadButton conversationId=\{active\.id\} className="messages-thread-action" \/> : null\}/, 'and the bot chat\'s in Messages');
});

const stripTags = (text) => text.replace(/<\/?\d+>/g, '');
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the blank thread reads nothing and saves nothing in its first render, and opens on the ways to start', () => {
  const { mod, calls } = load();
  const html = renderToHtml(createElement(mod.NewThreadPanel, { conversationId: 7 }));
  assert.deepEqual(calls, [], 'no request, and no thread made, by opening it');
  assert.match(html, /data-bot-new-thread-pane=""/);
  assert.doesNotMatch(html, /<select/, 'no plain web select for the project or the kind');
  assert.match(html, new RegExp(escapeRe(message('messages:newThread.welcome.title'))));
  assert.match(html, new RegExp(escapeRe(message('messages:newThread.welcome.sub'))));
  // The five starts, in order, each a pill that is not yet the message's.
  const keys = [...html.matchAll(/data-bot-new-thread-opener="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['fix', 'add', 'redesign', 'newPage', 'ask']);
  assert.equal((html.match(/class="messages-start"[^>]*aria-pressed="false"/g) || []).length, 5);
  for (const start of mod.NEW_THREAD_STARTS) {
    const words = message(start.text);
    assert.equal(stripTags(message(start.label)), `${words}…`, `${start.key}: the pill says the words it writes, then "…"`);
    assert.match(html, new RegExp(`${escapeRe(words)}<span class="messages-start-more">…</span>`));
  }
  // Any project, on the chip over the box; the picker is not drawn until it is opened.
  assert.match(html, new RegExp(`class="messages-project-chip" data-bot-new-thread-project=""[^>]*aria-expanded="false"[^>]*>[\\s\\S]*?${escapeRe(message('messages:newThread.anyProject'))}`));
  assert.doesNotMatch(html, /id="bot-project-picker"/);
  assert.doesNotMatch(html, /data-bot-new-thread-draws/, 'the drawing line only once a design start begins the message');
  assert.deepEqual([...mod.CHANGE_KINDS], ['any', 'fix', 'add', 'design']);
  const server = require('../src/services/private-threads');
  assert.deepEqual(Object.keys(server.CHANGE_KINDS), [...mod.CHANGE_KINDS], 'the kinds the server knows');
  for (const start of mod.NEW_THREAD_STARTS) assert.ok(mod.CHANGE_KINDS.includes(start.kind), `${start.key} is for a kind the server knows`);
});

test('the kind is read off the start a message begins with, and a tap writes the start into the box', () => {
  const { mod } = load();
  const starts = mod.NEW_THREAD_STARTS.map((start) => ({ ...start, text: message(start.text) }));
  const kindOf = (words) => (mod.startOf(words, starts) || { kind: 'any' }).kind;
  assert.equal(kindOf('I want to fix an issue with the login button'), 'fix');
  assert.equal(kindOf('I want to add a feature for reminders'), 'add');
  assert.equal(kindOf('  i want to REDESIGN the page where you vote'), 'design', 'case and the space before it do not matter');
  assert.equal(kindOf('I want to design a new page for stats'), 'design');
  assert.equal(kindOf('I have a question about checks'), 'any');
  assert.equal(kindOf('Fix the login button'), 'any', 'words of their own: any kind of change');
  assert.equal(kindOf(''), 'any');
  const fix = starts.find((start) => start.key === 'fix');
  const add = starts.find((start) => start.key === 'add');
  assert.equal(mod.withStart('', fix, starts), 'I want to fix an issue ', 'the caret waits after the words');
  assert.equal(mod.withStart('I want to fix an issue with login', add, starts), 'I want to add a feature with login', 'another start swaps the start and keeps the rest');
  assert.equal(mod.withStart('I want to fix an issue ', add, starts), 'I want to add a feature ');
  assert.equal(mod.withStart('the login button', fix, starts), 'I want to fix an issue the login button', 'their own words follow it');
  const src = read(NEW_THREAD);
  assert.match(src, /const begun = startOf\(words, starts\);/);
  assert.match(src, /aria-pressed=\{begun\?\.key === start\.key\}/, 'the start the message begins with is lit');
  assert.match(src, /setWords\(\(current\) => withStart\(current, start, starts\)\.slice\(0, 8000\)\);\n\s+toField\(\);/);
  assert.match(src, /input\.setSelectionRange\(end, end\);/, 'the caret goes to the end');
});

test('the project is chosen from the "Your communities" rows, Any project first', () => {
  const picker = loadTsx('frontend/src/features/messages/project-picker.tsx');
  const info = {
    a: { slug: 'a', name: 'Book Club' }, b: { slug: 'b', name: 'Trail Notes' }, c: { slug: 'c', name: 'Garden Swap' },
  };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const none = plain(picker.pickerSections(['a', 'b', 'c'], info, ['c', 'a'], ''));
  assert.equal(none.found, null);
  assert.deepEqual(none.recent.map((row) => row.slug), ['c', 'a'], 'Recent: the switcher\'s own');
  assert.deepEqual(none.rest.map((row) => row.slug), ['b'], 'then every other community you are in');
  const searched = plain(picker.pickerSections(['a', 'b', 'c'], info, ['c', 'a'], 'trail'));
  assert.deepEqual(searched.found.map((row) => row.slug), ['b'], 'words in the search take their place');
  assert.deepEqual(plain(picker.pickerSections(null, {}, [], '')), { found: null, recent: [], rest: [] });
  assert.equal(renderToHtml(createElement(picker.ProjectPicker, { open: false, slug: null, anchor: null, onPick() {}, onClose() {} })), '', 'nothing until it is opened');
  const src = read('frontend/src/features/messages/project-picker.tsx');
  // A sheet from the floor on a phone (the kit's when it is there), a menu from 768px.
  assert.match(src, /wide\n\s+\? <PickerMenu slug=\{slug\} anchor=\{anchor\} onPick=\{onPick\} onClose=\{onClose\} \/>\n\s+: <PickerSheet slug=\{slug\} onPick=\{onPick\} onClose=\{onClose\} \/>/);
  assert.match(src, /adoptKitSurface\(\{\n\s+kind: 'sheet',/);
  assert.match(src, /className="community-switcher community-switcher-sheet"/);
  assert.match(src, /className="community-switcher community-switcher-menu"/);
  assert.match(src, /import \{ switcherRecent, switcherSub \} from '\.\.\/workshop\/community-switcher';/, 'the switcher\'s Recent and its "Public · 23 members" line');
  assert.doesNotMatch(src, /id="community-switcher/, 'its own ids, never the switcher\'s');
  assert.doesNotMatch(src, /goToCommunity/, 'picking a project goes nowhere');
});

test('the thread is made on the first send, through a same-origin door, and the message goes into it', () => {
  const src = read(NEW_THREAD);
  assert.match(src, /const kind: ChangeKind = startOf\(content, starts\)\?\.kind \|\| 'any';\n\s+const made = await api\.startBotThread\(\{ project: project \|\| null, kind \}\);\n\s+await api\.sendMessage\(conversationId, \{ content, threadRootId: made\.rootId, attachmentIds: attachments\.map\(\(item\) => item\.id\), idempotencyKey: key\(\) \}\);\n\s+closeNewThread\(\);\n\s+openThread\(made\.rootId\);/);
  assert.match(read('frontend/src/features/messages/api.ts'), /request<unknown>\('\/api\/conversations\/homeroom-bot\/new-thread', \{ method: 'POST'/);
  assert.match(read('src/routes/conversations.js'), /router\.post\('\/api\/conversations\/homeroom-bot\/new-thread', conversationActionLimiter, sameOriginBrowserOnly,/);
});

test('a started thread is headed by what it is for, never as a request, and takes Main Chat\'s place in the tab', () => {
  const { mod } = load();
  const t = (id) => message(id);
  assert.equal(mod.startedThreadTitle(t, 'fix'), 'Fix something broken');
  assert.equal(mod.startedThreadTitle(t, 'design'), 'Design a screen');
  assert.equal(mod.startedThreadTitle(t, undefined), message('messages:newThread.title'));
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const started = rootMeta\?\.kind === 'opened_thread' \? rootMeta : null;\n\s+const request = rootMeta && !started \? botRequestNames\(rootMeta\) : null;/);
  assert.match(read('frontend/src/features/messages/api.ts'), /\{ changeKind: String\(pick\(bot, 'changeKind'\)\)/, 'the kind survives the client\'s reading of the metadata');
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout-embedded\.messages-has-blank-thread > \.messages-thread-pane \{ display: none; \}/);
  assert.match(css, /\.messages-layout-embedded\.messages-has-blank-thread > \.messages-reply-pane \{ flex: 1 1 auto; margin-inline-start: 0; \}/);
  // On a phone its composer keeps clear of the tab bar, as a thread's does.
  // The chat foot's bar, as a form (1 November 2026), which brings the class.
  assert.match(read(NEW_THREAD), /<ChatComposerBar as="form" className=\{`messages-composer messages-composer-thread\$\{drop\.dragging \? ' messages-composer-dragging' : ''\}`\}/);
});

test('files are dropped, pasted or picked in a blank thread, and ride its first message', () => {
  // The way every other thread takes them (#6256), and the same shared rules
  // (../attachments/limits) so the cap cannot drift between the two boxes.
  const src = read(NEW_THREAD);
  assert.match(src, /import \{ DropOverlay, useFileDrag \} from '\.\.\/attachments\/file-drag';/);
  assert.match(src, /import \{ MAX_ATTACHMENTS, stageFiles \} from '\.\.\/attachments\/limits';/);
  assert.match(src, /const drop = useFileDrag\(\{ onFiles: \(files\) => \{ void addFiles\(files\); \} \}\);/);
  assert.match(src, /\.\.\.drop\.handlers/, 'a drop on the bar lands in attachFiles');
  assert.match(src, /\{drop\.dragging \? <DropOverlay className="messages-drop-overlay" \/> : null\}/);
  assert.match(src, /api\.uploadAttachment\(conversationId, file\)/, 'before the thread exists, the bot chat is where a file goes');
  assert.match(src, /onPaste=\{\(e\) => \{ const files = \[\.\.\.e\.clipboardData\.files\]; if \(files\.length\) \{ e\.preventDefault\(\); void addFiles\(files\); \} \}\}/);
  assert.match(src, /aria-haspopup="menu"/);
  assert.match(src, /role="menuitem" disabled=\{attachments\.length \+ uploading >= MAX_ATTACHMENTS\}/, 'the row greys out at four, the "+" does not');
  assert.equal(message('messages:composer.attachFiles'), 'Attach files');
  assert.match(src, /setAddOpen\(false\); fileRef\.current\?\.click\(\)/);
  for (const id of ['messages:composer.removeAttachment', 'messages:composer.uploading', 'messages:composer.addToMessage', 'messages:composer.attachFiles']) {
    assert.ok(src.includes(`t('${id}'`), `${id} is the words the rest of Messages uses`);
  }
  assert.doesNotMatch(src, /messages:newThread\.(attach|drop|upload)/, 'no new catalog text');
  // Send is enabled by files alone, and held while an upload runs.
  assert.match(src, /disabled=\{busy \|\| dictating \|\| uploading > 0 \|\| \(!words\.trim\(\) && !attachments\.length\)\}/);
  assert.match(src, /if \(busy \|\| dictating \|\| uploading \|\| \(!content && !attachments\.length\)\) return;/);
  assert.match(src, /attachmentIds: attachments\.map\(\(item\) => item\.id\)/);
});

test('its box is the conversation composer\'s card, piece for piece', () => {
  const src = read(NEW_THREAD);
  const composer = read('frontend/src/features/messages/composer.tsx');
  for (const piece of [
    '<div className="messages-composer-card">',
    '<div className="flex items-end gap-1.5">',
    '<div className="messages-composer-add" ref={addRef}>',
    'className="messages-composer-input"',
    'className="messages-send"',
    "aria-label={t('messages:composer.send')}",
    '<ArrowUpIcon aria-hidden="true" />',
    '<div className="messages-composer-count mt-1 px-1 flex justify-end h-[15px]"',
  ]) {
    assert.ok(composer.includes(piece), `the conversation composer draws ${piece}`);
    assert.ok(src.includes(piece), `and so does the blank thread's`);
  }
  assert.match(src, /<SpeakButton scope="messages:new-thread" getText=\{\(\) => inputRef\.current\?\.value \|\| ''\} onText=\{setWords\} maxLength=\{8000\} onBusyChange=\{setDictating\} disabled=\{busy\} \/>/, 'dictation, as in every box');
  assert.match(src, /useAutoGrow\(inputRef, words\);/, 'the field grows with what is typed');
  // The project floats over the card, never inside it.
  const bar = src.slice(src.indexOf('<ChatComposerBar as="form"'), src.indexOf('<div className="messages-composer-card">'));
  assert.match(bar, /<div className="messages-project-row">\n\s+<ProjectChip/);
  assert.doesNotMatch(src, /newThread\.(send|hint|kind)\b/, 'the retired words');
  for (const id of ['newThread.send', 'newThread.hint', 'newThread.kind', 'newThread.kinds.any']) {
    assert.throws(() => message(`messages:${id}`), `${id} is retired`);
  }
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-start \{[^}]*font-size: 17px;\n\s+line-height: 22px;/, 'a pill in the box\'s own type');
  assert.match(css, /@media \(min-width: 768px\) \{\n\s+\.messages-start \{ font-size: 15px; \}\n\}/, 'which is 15px from 768px, as the box is');
  assert.match(css, /\.messages-starts \{\n\s+margin-block: auto;/, 'in the middle of the empty thread');
});

test('a design start says to describe the screen, and Homeroom bot draws it: no screen to pick', () => {
  assert.equal(message('messages:newThread.draws'), 'Describe the screen and Homeroom bot draws it.');
  const src = read(NEW_THREAD);
  assert.match(src, /const drawing = begun\?\.kind === 'design';/);
  // 10 Nov 2026: only while Homeroom bot works on it. Claude Code and ChatGPT draw nothing here.
  assert.match(src, /\{drawing && !own \? <p className="messages-composer-hint" data-bot-new-thread-draws="">\{t\('messages:newThread\.draws'\)\}<\/p> : null\}/);
  assert.doesNotMatch(src, /startScreenPick|pickScreen|<Button/, 'the screen picker retired');
  assert.throws(() => message('messages:newThread.pickScreen'));
});

const BUILDER = 'frontend/src/features/messages/thread-builder.tsx';

test('who works on it: Homeroom bot by default, on a chip beside the project\'s, and nothing is read to draw it', () => {
  const { mod, calls } = load();
  const html = renderToHtml(createElement(mod.NewThreadPanel, { conversationId: 7 }));
  assert.deepEqual(calls, [], 'the connections are not read until the picker is opened');
  const chip = html.match(/<button type="button" class="messages-project-chip" data-bot-new-thread-builder="homeroom"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(chip, 'the builder chip is the project chip\'s own class');
  assert.match(chip[0], /aria-haspopup="dialog" aria-expanded="false"/);
  assert.doesNotMatch(chip[0], /data-picked/, 'tinted only for a pick of the person\'s own');
  assert.match(chip[0], new RegExp(escapeRe(message('messages:newThread.builder.homeroom.name'))));
  assert.ok(html.indexOf('data-bot-new-thread-project=""') < html.indexOf('data-bot-new-thread-builder="homeroom"'), 'after the project\'s chip');
  // Homeroom bot's thread is as it was: its own words under the title, its send, no steps.
  assert.match(html, new RegExp(escapeRe(message('messages:newThread.sub'))));
  assert.match(html, /data-bot-new-thread-send=""/);
  assert.doesNotMatch(html, /data-bot-new-thread-open=|data-bot-new-thread-handoff|data-bot-builder-setup|data-bot-new-thread-setup/);
  assert.doesNotMatch(html, /id="bot-builder-picker"/, 'the picker is not drawn until it is opened');
  const src = read(NEW_THREAD);
  assert.match(src, /const \[builder, setBuilder\] = useState<Builder>\(\(\) => preset\?\.builder \|\| 'homeroom'\);/, 'Homeroom bot, unless the door that opened it named another (ai-screen.test.js)');
  const bar = src.slice(src.indexOf('<div className="messages-project-row">'), src.indexOf('<div className="messages-composer-card">'));
  assert.match(bar, /<ProjectChip[\s\S]*?\/>\n\s+<BuilderChip/, 'both chips float over the card, in one row');
  assert.match(bar, /if \(!pickingBuilder && links\.phase !== 'ready' && links\.phase !== 'loading'\) void links\.load\(\);/, 'read on the first open');
  assert.match(read('public/css/app.css'), /\.messages-project-row \{ display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 8px; \}/);
});

test('which products are connected is read off the names Settings sorts its cards by', () => {
  const builder = loadTsx(BUILDER, { stubs: { './api': {} } });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual([...builder.BUILDERS], ['homeroom', 'claude-code', 'chatgpt']);
  assert.deepEqual(plain(builder.connectedBuilders([])), { 'claude-code': false, chatgpt: false });
  assert.deepEqual(plain(builder.connectedBuilders([{ clientName: 'Claude', live: true }])), { 'claude-code': true, chatgpt: false });
  assert.deepEqual(plain(builder.connectedBuilders([{ clientName: 'ChatGPT', live: true }])), { 'claude-code': false, chatgpt: true });
  assert.deepEqual(plain(builder.connectedBuilders([{ clientName: 'Claude', live: false }])), { 'claude-code': false, chatgpt: false }, 'a sign-in that ran out is not a connection');
  assert.deepEqual(plain(builder.connectedBuilders([{ clientName: 'Codex CLI (OpenAI)', live: true }])), { 'claude-code': false, chatgpt: false }, 'Codex is its own client, not the ChatGPT chat');
  assert.deepEqual(plain(builder.connectedBuilders([{ clientName: 'Some other agent', live: true }])), { 'claude-code': false, chatgpt: false });
  // The list is Settings' own, read through the same-origin door, and Settings' demo flag rides along.
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /const path = flag\.startsWith\('connectors-'\) \? `\/api\/me\/connectors\?demo=\$\{encodeURIComponent\(flag\)\}` : '\/api\/me\/connectors';/);
  assert.match(api, /live: pick\(one, 'status'\) !== 'expired'/);
  assert.match(read('src/routes/mcp-remote.js'), /router\.get\('\/api\/me\/connectors', userRate,/);
  assert.equal(renderToHtml(createElement(builder.BuilderPicker, {
    open: false, builder: 'homeroom', anchor: null, onPick() {}, onClose() {},
    links: { phase: 'idle', connected: { 'claude-code': false, chatgpt: false }, load: async () => null },
  })), '', 'nothing until it is opened');
});

test('a pick of the person\'s own opens the product with their own words in the link, and makes nothing here', () => {
  const builder = loadTsx(BUILDER, { stubs: { './api': {} } });
  const words = 'I want to add a feature for reminders';
  const prompt = builder.builderPrompt(`  ${words}  `, 'run-club-1a2b3c');
  assert.ok(prompt.startsWith(`${words}\n\n`), 'their words first, as typed');
  assert.match(prompt, /Use the Homeroom connector for this, on the Homeroom app `run-club-1a2b3c`\./);
  assert.match(prompt, /submit_work so it goes to the group for a vote\.$/);
  const any = builder.builderPrompt(words, null);
  assert.match(any, /find the project with list_apps,/, 'no project picked: the agent finds it');
  assert.doesNotMatch(builder.builderPrompt(words, 'Not A Slug!'), /Not A Slug/, 'only a slug the platform would mint is named');
  const claude = builder.builderLink('claude-code', words, 'run-club-1a2b3c');
  assert.ok(claude.startsWith('https://claude.ai/code?prompt='), 'the address "Open in Claude Code" uses');
  assert.equal(decodeURIComponent(claude.slice('https://claude.ai/code?prompt='.length)), prompt);
  const chatgpt = builder.builderLink('chatgpt', words, null);
  assert.ok(chatgpt.startsWith('https://chatgpt.com/?q='), 'the address Settings\' "Ask ChatGPT to guide you" uses');
  assert.equal(decodeURIComponent(chatgpt.slice('https://chatgpt.com/?q='.length)), any);
  assert.match(read('frontend/src/features/settings/settings.js'), /\['connector-open-chatgpt', 'https:\/\/chatgpt\.com\/\?q='\]/);
  assert.equal(builder.builderLink('claude-code', '   ', null), null, 'no words, no link');
  assert.equal(builder.builderLink('claude-code', 'x'.repeat(builder.HANDOFF_MAX + 1), null), null, 'an address has a length');
  assert.ok(builder.builderLink('claude-code', 'x'.repeat(builder.HANDOFF_MAX), null));
  // In the panel, the hand-off comes before anything is made, and Homeroom bot's send is the one pinned above.
  const src = read(NEW_THREAD);
  assert.match(src, /if \(busy \|\| dictating \|\| uploading \|\| \(!content && !attachments\.length\)\) return;\n\s+if \(own\) \{ handOff\(content\); return; \}\n\s+setBusy\(true\);/);
  const handOff = src.slice(src.indexOf('const handOff = '), src.indexOf('const send = '));
  assert.doesNotMatch(handOff, /startBotThread|sendMessage/, 'no thread and no message in Homeroom');
  assert.match(handOff, /const link = builderLink\(own, content, project \|\| null\);/);
  assert.match(handOff, /const tab = window\.open\(link, '_blank'\);\n\s+if \(!tab\) \{ setError\(t\('messages:newThread\.builder\.blocked'\)\); return; \}\n\s+try \{ tab\.opener = null; \}/, 'a blocked tab keeps the words and says so');
  assert.match(handOff, /if \(attachments\.length\) \{ setError\(t\('messages:newThread\.builder\.files', \{ builder: ownName \}\)\); return; \}/, 'files cannot ride a link');
  assert.match(src, /className="messages-send messages-send-open"[^\n]*data-bot-new-thread-open=\{own\}>\n\s+<span>\{t\('messages:newThread\.builder\.openShort'\)\}<\/span>\n\s+<ArrowTopRightOnSquareIcon aria-hidden="true" \/>/, 'it says Open, beside the leaving-arrow');
  assert.match(src, /\{own \? <p className="messages-composer-hint" data-bot-new-thread-handoff="">\{t\('messages:newThread\.builder\.handoff', \{ builder: ownName \}\)\}<\/p> : null\}/);
  assert.equal(message('messages:newThread.builder.placeholder'), 'Your prompt');
});

test('until its connector is there, the steps to add it take the thread\'s place', () => {
  const builder = loadTsx(BUILDER, { stubs: { './api': {} } });
  const { message: settingsText } = require('./lib/platform-i18n');
  const steps = (key, extra) => renderToHtml(createElement(builder.BuilderSetup, {
    builder: key, checking: false, missed: false, onCheck() {}, onUseBot() {}, ...extra,
  }));
  const claude = steps('claude-code');
  assert.match(claude, /^<div class="messages-builder-setup" data-bot-builder-setup="claude-code">/);
  assert.match(claude, new RegExp(escapeRe(settingsText('settings:connectors.claudeSteps.open.title'))), 'Settings\' own walkthrough, not a second copy');
  assert.match(claude, /data-connector-setup-url="1"/, 'the MCP server URL, with its Copy');
  assert.match(claude, /data-bot-builder-check=""/);
  assert.match(claude, /data-bot-builder-use-bot=""/);
  assert.doesNotMatch(claude, /data-bot-builder-missed/);
  assert.doesNotMatch(claude, /data-connector-step-tick/, 'no ticks: those are Settings\'');
  const chatgpt = steps('chatgpt', { missed: true });
  assert.match(chatgpt, new RegExp(escapeRe(settingsText('settings:connectors.chatgptSteps.directory.title'))));
  assert.match(chatgpt, /role="status"[^>]*data-bot-builder-missed=""/, 'Check again found nothing: said, not silent');
  const src = read(NEW_THREAD);
  assert.match(src, /const setup = !!own && links\.phase === 'ready' && !links\.connected\[own\];/, 'only once the list was read and has no connection for it');
  assert.match(src, /data-bot-new-thread-setup=\{setup \? builder : undefined\}/);
  assert.match(src, /onUseBot=\{\(\) => \{ setBuilder\('homeroom'\); setMissed\(false\); toField\(\); \}\}/);
  assert.match(src, /setMissed\(!!own && !\(found && found\[own\]\)\);/);
  // The starts and the box stay mounted behind the steps, so what was typed is kept.
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-reply-pane\[data-bot-new-thread-setup\] > \.messages-thread-scroll,\n\.messages-reply-pane\[data-bot-new-thread-setup\] > \.messages-composer \{ display: none; \}/);
  const walkthrough = read(BUILDER);
  assert.match(walkthrough, /import \{ ChatgptSetupSteps, ClaudeSetupSteps \} from '\.\.\/settings\/connector-setup-steps';/);
  assert.match(walkthrough, /import \{ ConnectorUrl \} from '\.\.\/dev-chat\/connector-setup-inline';/);
});
