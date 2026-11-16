// Where your work in progress is (#2779 follow-up).
//
// Lists said different things about the same work: the Workshop listed a
// paused session, Messages and the bell hid it, and the platform mark's
// menu listed agent chats beside the app's own rows. The rules are one set
// now, and "paused" is the platform's bookkeeping rather than a state
// anybody is shown or asked to manage:
//
//   1. PAUSED IS NEVER SHOWN AND NEVER ASKED FOR. A session pauses by itself a
//      few idle minutes after it was used, the least recently used one pauses
//      when new work needs its slot, and opening a session resumes it. No
//      list hides it, no label names it, no error asks the user to pause
//      something.
//   2. A change's row opens the change's page.
//   3. The platform mark's menu lists no agent entries (#4729): its Agent
//      chats section left it, and agent chats themselves are retired.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('#3071: a menu row writes its address before the menu closes, so closing cannot take it back', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const fn = sheet.slice(sheet.indexOf('function followThenDismiss('), sheet.indexOf('function MenuRow('));
  assert.match(fn, /e\.preventDefault\(\);\s*\/\/[^\n]*\n\s*if \(window\.location\.hash !== href\) window\.location\.hash = href;\s*AppContext\.dismissForNav\(\);/,
    'the address first, synchronously; then the release, which finds the page off its record');
  assert.match(fn, /if \(e\.defaultPrevented \|\| e\.nativeEvent\.defaultPrevented \|\| e\.button !== 0 \|\| e\.metaKey/,
    'a click the side panel took, or a modified one, only closes the menu');
  const row = sheet.slice(sheet.indexOf('function MenuRow('), sheet.indexOf('export function AppsSwitcherSheet('));
  assert.match(row, /if \(onClick\) \{ onClick\(e\); return; \}\s*followThenDismiss\(e, href\);/,
    'every plain row');
});

test('the mark\'s menu lists no agent entries (#4729)', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // A menu that lists an inbox's CONTENTS was the decay this file's header
  // warns of. Agent chats — its heading, Build it now, the session rows and
  // "Show more" — left it whole.
  assert.doesNotMatch(sheet, /app-menu-sessions/, 'no Agent chats section');
  assert.doesNotMatch(sheet, /improve-row-new-session/, 'and no Build it now row');
  assert.doesNotMatch(sheet, /function AgentChats|<AgentChats/, 'no section component left');
  assert.doesNotMatch(sheet, /continueRows|continue-model/, 'the model that fed it went with it');
  // The app's own rows keep their order and now close the list: About is
  // the last of them, with the agent section that followed gone.
  const menu = sheet.slice(sheet.indexOf('export function AppsSwitcherSheet('));
  const at = (needle) => menu.indexOf(needle);
  assert.ok(at('id="app-menu-row-workshop"') > -1 && at('id="app-menu-row-about"') > -1
    && at('id="app-menu-row-workshop"') < at('id="app-menu-row-about"'),
    'Go to community and About are the app\'s section, and the list ends there');
  // The catalog entries the menu's rows read are gone with them.
  assert.throws(() => message('agent:appContext.agentChats.heading'), undefined, 'the heading is no longer in the catalog');
  assert.throws(() => message('agent:appContext.agentChats.buildNow'));
  assert.throws(() => message('agent:appContext.agentChats.showMore'));
});

test('no list filters paused work out or says "Paused"; the Improve list that did is gone', () => {
  // Messages and the bell listed the Improve controller's session rows,
  // paused ones included, until that list lost its last surface (16 Nov
  // 2026); the controller builds no row now.
  const improve = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(improve, /isParked/, 'no list filters paused work out');
  assert.doesNotMatch(improve, /return 'Paused'/, 'and no row says "Paused"');
  assert.doesNotMatch(improve, /function toRow\(|href: `#app\/\$\{session/, 'the controller builds no session row');
});

test('"paused" is shown nowhere, and nobody is asked to pause or resume anything', () => {
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /'Parked'/);
  assert.doesNotMatch(read('public/js/app-view.js'), /label: 'paused'/, 'no paused chip on the Workshop card');
  for (const file of ['src/routes/sessions.js', 'src/routes/proposal-handoff.js', 'src/services/connector-limits.js']) {
    assert.doesNotMatch(read(file), /Pause or archive one first|Pause one first/, `${file} never asks the user to pause`);
  }
});

test('new work at the cap pauses the user\'s least recently used session instead of refusing', async () => {
  const lifecycle = require('../src/services/session-lifecycle');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await lifecycle.freeUserSlot({ pool, userId: 7 }), { freed: false });
  const pick = calls[0];
  assert.match(pick.sql, /WHERE user_id = \$1 AND status = 'active' AND id <> \$2/);
  assert.match(pick.sql, /ORDER BY last_activity_at ASC/);
  assert.deepEqual(pick.params, [7, 0, false], 'headless runs are not the user\'s to give up');
  await lifecycle.freeUserSlot({ pool, userId: 7, excludeSessionId: 41, includeHeadless: true });
  assert.deepEqual(calls[1].params, [7, 41, true]);
  assert.match(lifecycle.USER_SLOTS_BUSY, /busy finishing turns/);

  const sessions = read('src/routes/sessions.js');
  assert.equal((sessions.match(/sessionLifecycle\.freeUserSlot\(/g) || []).length, 1,
    'resume frees a slot the same way');
  assert.match(sessions, /sessionLifecycle\.freeUserSlot\(\{\s+pool, userId: user\.id, excludeSessionId: sessionId, includeHeadless: true,\s+\}\)/);
  assert.match(read('src/routes/proposal-handoff.js'), /sessionLifecycle\.freeUserSlot\(/);
  assert.match(read('src/services/connector-limits.js'), /lifecycle\.freeUserSlot\(\{ pool, userId: user\.id \}\)/);
});

test('a paused session is resumed by one implementation, for the route and for sync-main', () => {
  // The resume route and sync-main keep the one implementation.
  const sessions = read('src/routes/sessions.js');
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/resume'"));
  assert.match(route.slice(0, 600), /await resumePausedSession\(\{ pool, config, user: req\.user, sessionId \}\)/,
    'one implementation for the route and sync-main');
  const syncMain = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/sync-main'"));
  assert.match(syncMain.slice(0, 2000), /session\.status === 'paused'[\s\S]{0,200}resumePausedSession/);
  assert.equal(typeof require('../src/routes/sessions').resumePausedSession, 'function');
});
