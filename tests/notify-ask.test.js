// The notification ask (21 Oct 2026): asked at the moment it means
// something, on every platform.
//
//   1. decideNotifyAsk (frontend/src/features/notify-ask/decide.ts), the
//      pure rule: once per moment per surface, two Not nows stop a surface,
//      an OS answer is never asked again, and the web offers the app only
//      when there is one to get and no phone of theirs takes the push.
//   2. The account's record: services/notification-asks.js and its routes.
//   3. /get-app, where the computer's code to scan sends a phone.
//   4. The card renders nothing until its effect has read the answers, so
//      nothing of it is in the prerendered shell.
//   5. Members are told when a project they joined while it was made opens
//      (services/project-opened.js), and the emails that stand in for a
//      push: project_opened and votes_owed.
//   6. The agent session's browser prompt is explained first, once.
//
// Run with: node --test tests/notify-ask.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const { decideNotifyAsk, EMAILED_MOMENTS, NOT_NOW_LIMIT } = loadTsx('frontend/src/features/notify-ask/decide.ts');

const STATE = (asks = [], extra = {}) => ({ asks, phone: false, email: true, ...extra });

// ── 1. The rule ────────────────────────────────────────────────────────

test('in the app: asked while the permission is undecided and the build can ask', () => {
  const app = (over = {}) => decideNotifyAsk({
    moment: 'invite_sent', state: STATE(), native: true, permission: 'undetermined', canRequest: true, ...over,
  }).show;
  assert.equal(app(), 'app');
  assert.equal(app({ permission: null }), 'app', 'an unreadable permission may still be asked by a tap');
  assert.equal(app({ permission: 'granted' }), null, 'nothing to ask');
  assert.equal(app({ permission: 'denied' }), null, 'the OS shows no prompt: never asked again');
  assert.equal(app({ canRequest: false }), null, 'a build that cannot ask');
  assert.equal(app({ state: null }), null, 'answers unread: nothing is asked');
});

test('each moment once per surface, and two Not nows stop the surface', () => {
  const ask = (asks, moment = 'reply', native = true) => decideNotifyAsk({
    moment, state: STATE(asks), native, permission: 'undetermined', canRequest: true, appToGet: true,
  }).show;
  assert.equal(ask([{ surface: 'app', moment: 'reply', answer: 'not_now' }]), null, 'asked at this moment already');
  assert.equal(ask([{ surface: 'web', moment: 'reply', answer: 'not_now' }]), 'app',
    'a web answer does not use up the app\'s: once they have the app it asks in context');
  const twice = [
    { surface: 'app', moment: 'invite_sent', answer: 'not_now' },
    { surface: 'app', moment: 'suggestion', answer: 'not_now' },
  ];
  assert.equal(NOT_NOW_LIMIT, 2);
  assert.equal(ask(twice), null, 'two Not nows: the app stops asking');
  assert.equal(ask(twice.slice(0, 1)), 'app', 'one is not enough to stop');
});

test('on the web: get the app, only when there is one and no phone takes the push', () => {
  const web = (over = {}) => decideNotifyAsk({
    moment: 'invite_sent', state: STATE(), native: false, appToGet: true, ...over,
  });
  assert.deepEqual(web(), { show: 'web', email: true });
  assert.equal(web({ state: STATE([], { phone: true }) }).show, null, 'their phone takes the push already');
  assert.equal(web({ appToGet: false }).show, null, 'no store link: nothing to offer');
  assert.equal(web({ state: STATE([{ surface: 'web', moment: 'community', answer: 'yes' }]) }).show, null,
    'they were given the app already');
  assert.deepEqual(web({ state: STATE([], { email: false }) }), { show: 'web', email: false },
    'no confirmed address (or emails off): no "we\'ll email you"');
  assert.deepEqual(web({ moment: 'reply' }), { show: 'web', email: false },
    'a reply is not emailed, so the web ask does not say it is');
});

test('"we\'ll email you" only where activity-mail really sends', () => {
  assert.deepEqual([...EMAILED_MOMENTS].sort(),
    ['app_building', 'community', 'invite_sent', 'project_opens', 'suggestion']);
  const mail = require('../src/services/activity-mail');
  // app_building and suggestion are build_ready, invite_sent invite_activity,
  // community the votes it promises, project_opens the opening.
  assert.deepEqual([...mail.KINDS].sort(), ['build_ready', 'invite_activity', 'project_opened', 'votes_owed']);
});

// ── 2. The account's record ────────────────────────────────────────────

test('validateAsk takes a known surface, moment and answer, and nothing else', () => {
  const asks = require('../src/services/notification-asks');
  assert.deepEqual(asks.validateAsk({ surface: 'app', moment: 'invite_sent', answer: 'yes', extra: 1 }).value,
    { surface: 'app', moment: 'invite_sent', answer: 'yes' });
  const bad = asks.validateAsk({ surface: 'tv', moment: 'whenever', answer: 'maybe' });
  assert.equal(bad.value, null);
  assert.deepEqual(Object.keys(bad.details).sort(), ['answer', 'moment', 'surface']);
  assert.equal(asks.validateAsk(null).value, null);
  assert.equal(asks.validateAsk([]).value, null);
});

test('the moments are one list: service, schema and client', () => {
  const asks = require('../src/services/notification-asks');
  const schema = read('src', 'db', 'schema.sql');
  const block = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS notification_asks'));
  for (const moment of asks.MOMENTS) {
    assert.match(block, new RegExp(`'${moment}'`), `${moment} is in the table's check`);
  }
  assert.match(block, /COMMENT ON TABLE notification_asks IS 'staging:private'/);
  const decide = read('frontend', 'src', 'features', 'notify-ask', 'decide.ts');
  for (const moment of asks.MOMENTS) assert.match(decide, new RegExp(`'${moment}'`), `${moment} is a NotifyMoment`);
});

test('readAsks: the answers, whether a phone takes the push, and whether email stands in', async () => {
  const asks = require('../src/services/notification-asks');
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push(sql);
      if (/FROM notification_asks/.test(sql)) {
        return { rows: [{ surface: 'web', moment: 'reply', answer: 'not_now' }] };
      }
      if (/FROM mobile_push_registrations/.test(sql)) return { rows: [] };
      if (/FROM users/.test(sql)) return { rows: [{ email: true }] };
      throw new Error('unexpected ' + sql + params);
    },
  };
  assert.deepEqual(await asks.readAsks(pool, 7), {
    asks: [{ surface: 'web', moment: 'reply', answer: 'not_now' }], phone: false, email: true,
  });
  const recorded = [];
  pool.query = async (sql, params) => {
    if (/INSERT INTO notification_asks/.test(sql)) { recorded.push(params); return { rows: [] }; }
    if (/FROM notification_asks/.test(sql)) return { rows: [] };
    if (/FROM mobile_push_registrations/.test(sql)) return { rows: [{ '?column?': 1 }] };
    return { rows: [{ email: false }] };
  };
  const after = await asks.recordAsk(pool, 7, { surface: 'app', moment: 'community', answer: 'yes' });
  assert.deepEqual(recorded, [[7, 'app', 'community', 'yes']]);
  assert.equal(after.phone, true);
});

test('the routes are signed-in only and validate before they write', () => {
  const src = read('src', 'routes', 'notifications.js');
  assert.match(src, /router\.get\('\/api\/me\/notification-asks'/);
  assert.match(src, /router\.post\('\/api\/me\/notification-asks'/);
  const post = src.slice(src.indexOf("router.post('/api/me/notification-asks'"));
  assert.ok(post.indexOf("status(401)") < post.indexOf('validateAsk'), 'signed in first');
  assert.ok(post.indexOf('sameOriginBrowserOnly') < post.indexOf('validateAsk'), 'a same-site browser write');
  assert.ok(post.indexOf('validateAsk') < post.indexOf('recordAsk'), 'validated before it writes');
});

// ── 3. /get-app ────────────────────────────────────────────────────────

test('/get-app sends a phone to its own store, and never to a script', () => {
  const { getAppTarget } = require('../src/routes/public-api');
  const urls = { ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=x' };
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
  const pixel = 'Mozilla/5.0 (Linux; Android 15; Pixel 9)';
  assert.equal(getAppTarget(urls, iphone), urls.ios);
  assert.equal(getAppTarget(urls, pixel), urls.android);
  assert.equal(getAppTarget(urls, 'Mozilla/5.0 (Macintosh)'), '/', 'two stores and no phone named: home');
  assert.equal(getAppTarget({ ios: urls.ios, android: null }, 'Mozilla/5.0 (Macintosh)'), urls.ios,
    'an iPad asking as a Mac: the only store');
  assert.equal(getAppTarget({ ios: null, android: null }, pixel), '/');
  assert.equal(getAppTarget({ ios: 'javascript:alert(1)', android: null }, iphone), '/',
    'an admin\'s free text is never a script');
  const sw = read('public', 'sw.js');
  assert.match(sw, /'\/get-app',/, 'the worker never answers it with the cached shell');
});

// ── 4. The card ─────────────────────────────────────────────────────────

test('the card renders nothing until its effect has read the answers', () => {
  const { NotifyAsk } = loadTsx('frontend/src/features/notify-ask/notify-ask.tsx');
  for (const moment of ['app_building', 'invite_sent', 'suggestion', 'reply', 'community', 'project_opens']) {
    assert.equal(renderToHtml(createElement(NotifyAsk, { moment, project: 'Run Club' })), '', moment);
  }
  const { SuggestionAsk } = loadTsx('frontend/src/features/notify-ask/suggestion-ask.tsx');
  assert.equal(renderToHtml(createElement(SuggestionAsk, {})), '', 'closed until the controller opens it');
});

test('each moment has its words, in the app and on the web', () => {
  const { appCopy } = loadTsx('frontend/src/features/notify-ask/notify-ask.tsx');
  const catalog = JSON.parse(read('frontend', 'locales', 'en', 'notifications.json'));
  const has = (id) => assert.ok(catalog[id.replace(/^notifications:/, '')], `${id} is in the catalog`);
  for (const moment of ['invite_sent', 'suggestion', 'reply', 'project_opens']) {
    const copy = appCopy(moment, false);
    has(copy.title); has(copy.body);
  }
  has(appCopy('community', true).body);
  has(appCopy('community', false).body);
  assert.notEqual(appCopy('community', true).body, appCopy('community', false).body,
    'a small group is promised its messages; a bigger one is not');
  assert.equal(appCopy('app_building', false), null, 'the made screen\'s modal asks that one in the app');
  const src = read('frontend', 'src', 'features', 'notify-ask', 'notify-ask.tsx');
  for (const moment of ['app_building', 'invite_sent', 'suggestion', 'reply', 'community', 'project_opens']) {
    has(`notifications:ask.web.title.${moment}`);
    assert.match(src, new RegExp(`'notifications:ask\\.web\\.title\\.${moment}'`), `${moment}: a literal id`);
  }
  for (const text of Object.values(catalog).map((e) => e.text)) {
    assert.doesNotMatch(text, /—/, 'no em dash in the copy');
  }
});

test('a small group is 2 to 8 people in a private project', () => {
  const { ringsEveryone, SMALL_GROUP_PEOPLE } = loadTsx('frontend/src/features/notify-ask/community-ask.tsx');
  const notify = read('src', 'services', 'group-channel-notify.js');
  assert.match(notify, new RegExp(`const MAX_GROUP_PEOPLE = ${SMALL_GROUP_PEOPLE};`), 'the same size the chat rings at');
  assert.equal(ringsEveryone({ audience: 'invited', member_count: 3 }), true);
  assert.equal(ringsEveryone({ audience: 'invited', member_count: 9 }), false);
  assert.equal(ringsEveryone({ audience: 'invited', member_count: 1 }), false);
  assert.equal(ringsEveryone({ audience: 'open', member_count: 3 }), false);
});

test('the store links: only http(s), the device\'s own on a phone, every one on a computer', () => {
  const { appLinks } = loadTsx('frontend/src/features/notify-ask/ask-state.ts');
  const urls = { ios: 'https://testflight.apple.com/join/abc', android: 'javascript:alert(1)' };
  assert.deepEqual(appLinks(urls, 'ios').map((l) => [l.os, l.label]),
    [['ios', 'agent:install.banner.getOnTestFlight']], 'TestFlight is named as itself');
  assert.deepEqual(appLinks(urls, 'android'), [], 'a script is never an href');
  assert.deepEqual(appLinks({ ios: 'https://apps.apple.com/x', android: 'https://play.google.com/y' }, null)
    .map((l) => l.os), ['ios', 'android']);
  assert.deepEqual(appLinks(null, null), []);
});

test('one card per moment, and no moment holds another back', () => {
  // The shell keeps every screen mounted while hidden: a hub's card left on
  // a hidden screen must not silence the reply ask in Messages.
  const { claimAsk, resetAskStateForTests } = loadTsx('frontend/src/features/notify-ask/ask-state.ts');
  resetAskStateForTests();
  const hub = claimAsk('community');
  assert.ok(hub, 'the hub\'s card claims its moment');
  const reply = claimAsk('reply');
  assert.ok(reply, 'another moment is never held back');
  assert.equal(claimAsk('reply'), null, 'the same moment twice asks once');
  reply();
  reply();
  assert.ok(claimAsk('reply'), 'released (once, however often called), it can be claimed again');
  hub();
  resetAskStateForTests();
});

test('every moment is placed where it means something', () => {
  const at = (file, pattern, why) => assert.match(read(...file.split('/')), pattern, why);
  at('frontend/src/features/first-session/made.tsx', /<NotifyAsk moment="invite_sent"/, 'the invite sheet, once the link is out');
  at('frontend/src/features/first-session/made.tsx', /<NotifyAsk moment="app_building"/, 'the made screen, in a browser');
  at('frontend/src/features/app-context/invite-pane.tsx', /<NotifyAsk moment="invite_sent"/, 'the hub\'s invite pane');
  at('frontend/src/features/dialogs/feedback.tsx', /<SuggestionAsk \/>/, 'a suggestion Homeroom bot builds');
  at('frontend/src/features/dialogs/feedback-controller.js', /if \(building\) ask\?\.showSuggestion\?\.\(\);/, 'only when the bot builds it');
  at('frontend/src/features/messages/composer.tsx', /<NotifyAsk moment="reply"/, 'a message to somebody');
  at('frontend/src/features/dev-board/workshop/workshop.tsx', /<CommunityAsk data=\{community\}/, 'the project\'s hub');
  at('frontend/src/features/app-frame/app-status.tsx', /<NotifyAsk moment="project_opens"/, 'a project still being made');
  at('public/js/app-view.js', /ask: 'project_opens'/, 'for a member who is not its maker');
});

// ── 5. Members told, and the emails ─────────────────────────────────────

test('tellMembers: one project_opened per member, never its maker, then the push and the email', async () => {
  const projectOpened = require('../src/services/project-opened');
  assert.match(projectOpened.MEMBERS_SQL, /cm\.user_id IS DISTINCT FROM a\.created_by/, 'never its maker');
  assert.match(projectOpened.MEMBERS_SQL, /u\.is_synthetic = FALSE/, 'never the bot');
  assert.match(projectOpened.MEMBERS_SQL, /user_app_blocks/, 'nor somebody who blocked it');
  const inserted = [];
  const pool = {
    async query(sql, params) {
      if (/FROM apps WHERE slug/.test(sql)) return { rows: [{ id: 3, slug: 'run-club', name: 'Run Club' }] };
      if (sql === projectOpened.MEMBERS_SQL) return { rows: [{ user_id: 11 }, { user_id: 12 }] };
      if (/INSERT INTO notifications/.test(sql)) {
        assert.match(sql, /NOT EXISTS/, 'once per person and project');
        inserted.push(params);
        return { rows: params[0].map((u, i) => ({ id: 100 + i, user_id: u, app_id: 3, kind: 'project_opened' })) };
      }
      // hydrateAndPush and the email read more; neither may fail the call.
      return { rows: [] };
    },
  };
  const rows = await projectOpened.tellMembers(pool, { appSlug: 'run-club', makerId: 10 });
  assert.equal(rows.length, 2);
  assert.deepEqual(inserted, [[[11, 12], 3]]);
  assert.deepEqual(await projectOpened.tellMembers({ query() { throw new Error('down'); } }, { appSlug: 'x' }), [],
    'never throws');
});

test('the first version going live tells its members, whatever its maker chose', () => {
  const dm = read('src', 'services', 'homeroom-bot-dm.js');
  const at = dm.indexOf("require('./project-opened').tellMembers");
  assert.ok(at > 0);
  const guard = dm.slice(dm.lastIndexOf('if (', at), at);
  assert.match(guard, /story === 'live' && metadata\?\.firstVersion/);
  assert.doesNotMatch(guard, /muted/, 'the maker\'s own switch is theirs');
});

test('project_opened is a Change alert, in the push policy, the seed and the bell', () => {
  const prefs = require('../src/services/mobile-push-preferences');
  assert.equal(prefs.KIND_TO_CATEGORY.get('project_opened'), 'proposal_alerts');
  const schema = read('src', 'db', 'schema.sql');
  assert.match(schema, /\('project_opened', 'proposal_alerts', TRUE\)/);
  const keep = schema.slice(schema.indexOf('DELETE FROM mobile_push_kind_categories'));
  assert.match(keep.slice(0, keep.indexOf(');')), /'project_opened'/, 'and not deleted again on the next boot');
  const policy = read('src', 'services', 'mobile-push-policy.js');
  assert.match(policy, /case 'project_opened':/);
  const bell = read('frontend', 'src', 'features', 'notifications', 'notifications.js');
  assert.match(bell, /n\.kind === 'project_opened'/, 'the bell draws it');
  assert.match(bell, /item\.kind === 'project_opened' && item\.appSlug/, 'and opens the app');
});

test('the two new emails are activity mail: framed, throttled, and say why they came', () => {
  const templates = require('../src/services/mail/templates');
  const rateLimit = require('../src/services/mail/rate-limit');
  const opened = templates.buildMessage('project_opened', { appName: 'Run Club', url: 'https://x/app/run-club', unsubscribeUrl: 'https://x/u' });
  assert.equal(opened.subject, 'Run Club is open');
  assert.match(opened.html, /no phone to send it to/);
  const one = templates.buildMessage('votes_owed', { count: 1, appName: 'Run Club', url: 'https://x' });
  assert.equal(one.subject, 'A change in Run Club needs your vote');
  const many = templates.buildMessage('votes_owed', { count: 4, url: 'https://x' });
  assert.equal(many.subject, '4 changes need your vote');
  for (const kind of ['project_opened', 'votes_owed']) {
    assert.ok(rateLimit.RULES[kind], `${kind} is throttled`);
    assert.ok(rateLimit.ACTIVITY_KINDS.has(kind), `${kind} spends activity mail's own budget`);
  }
});

test('the vote digest is emailed when no phone can take it', () => {
  const src = read('src', 'services', 'vote-digest.js');
  assert.match(src, /void emailDigest\(pool, \{ userId, pending/);
  assert.match(src, /kind: 'votes_owed'/);
  assert.match(src, /hashRoute: '#communities'/, 'several open Needs you, as the bell\'s row does');
});

// ── 6. The agent session's browser prompt ───────────────────────────────

function bootDevAlerts({ permission = 'default', answer = true, native = false, stored = {} } = {}) {
  const calls = { confirm: 0, request: 0 };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem(k) { return Object.hasOwn(stored, k) ? stored[k] : null; },
      setItem(k, v) { stored[k] = String(v); },
    },
    Notification: {
      permission,
      requestPermission() { calls.request += 1; return Promise.resolve('granted'); },
    },
    PlatformUI: { confirm() { calls.confirm += 1; return Promise.resolve(answer); } },
    PlatformI18n: { t: (id) => id },
    document: { visibilityState: 'visible', addEventListener() {} },
    addEventListener() {},
    usernode: native ? { isNative: true } : undefined,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public', 'js', 'dev-alerts.js'), sandbox);
  return { DevAlerts: sandbox.DevAlerts, calls, stored };
}

test('the first send explains, and the browser prompt comes only after Notify me', async () => {
  const yes = bootDevAlerts();
  await yes.DevAlerts.offerNotifyPermission();
  assert.equal(yes.calls.confirm, 1, 'the in-app question first');
  assert.equal(yes.calls.request, 1, 'then the browser\'s prompt');
  await yes.DevAlerts.offerNotifyPermission();
  assert.equal(yes.calls.confirm, 1, 'once per device');

  const no = bootDevAlerts({ answer: false });
  await no.DevAlerts.offerNotifyPermission();
  assert.equal(no.calls.request, 0, 'Not now asks the browser nothing');

  const answered = bootDevAlerts({ permission: 'denied' });
  await answered.DevAlerts.offerNotifyPermission();
  assert.equal(answered.calls.confirm, 0, 'the browser was answered already');

  const app = bootDevAlerts({ native: true });
  await app.DevAlerts.offerNotifyPermission();
  assert.equal(app.calls.confirm, 0, 'the Homeroom app has its own ask');

  const chat = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
  assert.match(chat, /DevAlerts\.offerNotifyPermission\(\)/);
  assert.doesNotMatch(chat, /DevAlerts\.requestNotifyPermission\(\)/, 'never the bare prompt on a send');
});

// ── The Android bridge call ────────────────────────────────────────────

test('the web bridge serves requestNotificationPermission, and the first-run sheet no longer asks for it', () => {
  const bridge = read('public', 'usernode-bridge.js');
  assert.match(bridge, /window\.usernode\.requestNotificationPermission = function \(\) \{\s*return callNativeChromeAction\(\s*"requestNotificationPermission", \{\}, _PERMISSION_REQUEST_TIMEOUT_MS/);
  const chrome = read('public', 'js', 'native-chrome.js');
  const sheet = chrome.slice(chrome.indexOf('async _maybeShowFirstRunPermissions'), chrome.indexOf('presentPermissionsSheet(options)'));
  assert.doesNotMatch(sheet, /requestNotificationPermission/, 'the first-run trigger asks nothing about notifications');
});
