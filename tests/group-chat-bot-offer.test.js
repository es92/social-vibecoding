'use strict';

// #6582: a tap under Homeroom bot's offer in a request's discussion (Propose
// to close under an "already works" note) says a refusal where it was tapped,
// and an offer that is gone for good leaves a line instead of its buttons.
//
// The refusal line is a useState inside BotOfferButtons, which
// renderToStaticMarkup cannot click, so its wiring is asserted on the
// component's source (the split tests/dialog-import-pr.test.js describes:
// the root suite has no jsdom). The gone line is pinned by rendering the
// request's rows, and the client's answer is pinned by running the module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadGroupChat(userId = 9, { fetch, toasts = [] } = {}) {
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null, addEventListener() {} },
    App: { user: { id: userId } },
    PlatformI18n: englishPlatformI18n(),
    fetch,
  };
  // In a browser these are the same object; the module reads `window.App`.
  sandbox.window.App = sandbox.App;
  sandbox.window.PlatformUI = { toast: (...args) => toasts.push(args) };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  return sandbox.window.GroupChat;
}

const closeOffer = (status, over = {}) => ({
  homeroomBot: {
    kind: 'voice',
    offer: { id: 1, kind: 'close_request', status, forUserId: null, ...over },
    actions: status === 'open'
      ? [{ id: 'yes', label: 'Propose to close', style: 'primary' }, { id: 'no', label: 'Keep it open', style: 'secondary' }]
      : [],
  },
});

test('#6582: an offer that is gone or expired is read, with no actions left to tap', () => {
  const gc = loadGroupChat(9);
  for (const status of ['gone', 'expired']) {
    const view = gc._botOfferView(closeOffer(status));
    assert.ok(view, `${status} is a status the row reads`);
    assert.equal(view.status, status);
    assert.equal(view.forMe, true);
    assert.deepEqual(view.actions, [], 'nothing to tap');
  }
  assert.equal(gc._botOfferView(closeOffer('gone')).status, 'gone');
});

test('#6582: a refused tap is answered to its buttons, and no longer toasted', async () => {
  const toasts = [];
  const messageId = 238255;
  const seen = [];
  const gc = loadGroupChat(9, {
    toasts,
    async fetch(url, options) {
      seen.push({ url, options });
      return {
        ok: false,
        status: 410,
        async json() { return { error: 'That offer is no longer available.' }; },
      };
    },
  });
  gc.appSlug = 'usernode-2d5619';
  const out = await gc.decideBotOffer(messageId, 'yes');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'That offer is no longer available.');
  assert.equal(out.gone, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `/api/apps/usernode-2d5619/messages/${messageId}/bot-offer`);
  assert.equal(toasts.length, 0, 'the reason is shown under the buttons, not toasted');

  // No reason of the server's: the catalog's fallback.
  const bare = loadGroupChat(9, {
    toasts,
    async fetch() { return { ok: false, status: 400, async json() { return {}; } }; },
  });
  bare.appSlug = 'usernode-2d5619';
  const bareOut = await bare.decideBotOffer(1, 'no');
  assert.deepEqual([bareOut.ok, bareOut.error, bareOut.gone], [false, message('chat:group.botOffer.failed'), false]);
  // Sent, and the server already said what happened: the buttons say nothing more.
  const said = loadGroupChat(9, {
    toasts,
    async fetch() { return { ok: false, status: 409, async json() { return { said: 'A vote is open.' }; } }; },
  });
  said.appSlug = 'usernode-2d5619';
  const saidOut = await said.decideBotOffer(1, 'yes');
  assert.deepEqual([saidOut.ok, saidOut.error, saidOut.gone], [false, null, false]);
  // The request never left: the same fallback.
  const offline = loadGroupChat(9, { toasts, async fetch() { throw new Error('offline'); } });
  offline.appSlug = 'usernode-2d5619';
  const offlineOut = await offline.decideBotOffer(1, 'yes');
  assert.deepEqual([offlineOut.ok, offlineOut.error, offlineOut.gone], [false, message('chat:group.botOffer.failed'), false]);
  assert.equal(toasts.length, 0);
});

test('#6582: the refusal is drawn under the buttons, from what the tap answered', () => {
  const src = read('frontend/src/features/group-chat/transcript.tsx');
  const at = src.indexOf('export function BotOfferButtons');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /const \[error, setError\] = useState<string \| null>\(null\);/);
  assert.match(body, /const result = await controller\(\)\?\.decideBotOffer\?\./);
  assert.match(body, /if \(result && result\.ok === false && result\.error\) setError\(String\(result\.error\)\);/);
  assert.match(body, /setError\(null\);/);
  assert.match(body, /<p className="mt-1 text-\[12px\] text-zinc-500 dark:text-zinc-400" role="status" data-gc-bot-offer-error="">\s*\{error\}\s*<\/p>/);
  // The line is inside the buttons' own stack, under the row of buttons.
  assert.ok(body.indexOf('data-gc-bot-offer-error') > body.indexOf('<div className="flex flex-wrap gap-2">'));
});

test('#6582: a gone close offer\'s row draws the line where its buttons were', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const gone = { status: 'gone', forMe: true, kind: 'close_request', actions: [] };
  const rowBase = {
    id: 1, kind: 'message', username: 'homeroom_bot', time: '11:56', timeTitle: 't', bodyHtml: '<p>Already works.</p>',
    systemText: '', mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
    showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
    attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  };
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: gone }] },
  });
  assert.match(html, /data-gc-bot-offer-gone=""/);
  assert.ok(html.includes(message('chat:group.botOffer.goneClose')), 'the close offer\'s own line');
  assert.doesNotMatch(html, /data-gc-bot-offer=""/, 'no live buttons');
  assert.doesNotMatch(html, /Propose to close/);

  // Any other offer says only that it is gone: no ⋯ menu to point at.
  const other = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: { ...gone, kind: 'copy_request' } }] },
  });
  assert.ok(other.includes(message('chat:group.botOffer.gone')), 'the plain line');
  assert.ok(!other.includes(message('chat:group.botOffer.goneClose')), 'not the close offer\'s');

  // Somebody else's gone offer draws nothing for this viewer.
  const theirs = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: { ...gone, forMe: false } }] },
  });
  assert.doesNotMatch(theirs, /data-gc-bot-offer-gone/);
});

test('#6582: both lines exist in the English catalog', () => {
  assert.equal(message('chat:group.botOffer.gone'), 'This offer is no longer available.');
  assert.match(message('chat:group.botOffer.goneClose'), /no longer available.*request’s ⋯ menu/);
});
