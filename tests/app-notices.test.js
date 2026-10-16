'use strict';

// A project's notices (services/app-notices.js, GET /api/apps/:slug/notices),
// and the doors to a project's hub that open the hub (AppView._landOnHub,
// which is AppView._landOnTab turned to the hub since #3555).
//
// Channels carry no activity, so the two app-wide notices — settings changed
// lately and the Friday card — are recorded in `events` and read back here.
// The Workshop tab's "Lately in this project" panel that drew them is gone
// (#4698 follow-up). Merges paused and a stalled release stay the project
// page's banners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');


const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const notices = require('../src/services/app-notices');

const at = new Date('2026-09-27T10:00:00Z');

test('each settings change reads as a line, and a change a vote carried names nobody', () => {
  const row = (event_type, metadata, username = 'ada') => notices.settingsLine({ event_type, metadata, username, created_at: at });
  assert.deepEqual(row('visibility_changed', { to: { collab: 'private', view: 'public' }, source: 'manifest' }), {
    kind: 'visibility', text: 'Who can see it changed: anyone can see it; its members build', by: null, at: at.toISOString(),
  });
  assert.equal(row('visibility_changed', { to: { collab: 'private', view: 'private' }, source: 'manifest' }).text,
    'Who can see it changed: only its members can see it');
  assert.equal(row('governance_changed', { to: { approverPolicy: 'invited', approvalsRequired: 2 }, source: 'manifest' }).text,
    'Approval rule changed: approvals by invited approvers, requiring at least 2 approvals');
  assert.equal(row('app_admins_changed', { to: ['ada', 'bo'], source: 'manifest' }).text, 'Admins changed: @ada, @bo');
  const lock = row('app_lock_changed', { locked: true });
  assert.equal(lock.text, 'Locked: merges also need an admin’s yes vote');
  assert.equal(lock.by, 'ada', 'a person toggled it');
  assert.equal(row('app_lock_changed', { locked: false }).text, 'Unlocked: merges no longer need an admin’s yes vote');
  assert.deepEqual(row('approver_joined', {}, 'bo'), { kind: 'approver', text: '@bo became an approver', by: null, at: at.toISOString() });
  assert.equal(row('approver_joined', {}, null), null, 'nobody to name, nothing to say');
  assert.equal(row('governance_changed', {}), null);
  assert.equal(row('pr_merged', {}), null, 'only the settings kinds');
});

test('the Friday card is shown while it is fresh, as its own sentence, naming nobody', () => {
  assert.equal(notices.weekCard(null), null);
  assert.equal(notices.weekCard({ metadata: { mergedTotal: 0, openTotal: 0 }, created_at: at }), null);
  // #3678: a card stored before the change still carries each change's
  // author and backers; neither the line nor the card's data passes them on.
  const card = notices.weekCard({
    created_at: at,
    metadata: {
      app: 'Tiers', slug: 'tiers', mergedTotal: 1, openTotal: 1,
      merged: [{ id: 41, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: ['alice'] }],
      open: [{ id: 42, prNumber: 42, title: 'Dark mode', author: 'bo' }],
    },
  });
  assert.equal(card.at, at.toISOString());
  assert.equal(card.mergedTotal, 1);
  assert.equal(card.line, 'This week on Tiers: 1 change went live: Custom tier colors. One proposal is waiting for eyes: Dark mode (PR #42).');
  assert.deepEqual(card.merged, [{ title: 'Custom tier colors' }]);
  assert.doesNotMatch(JSON.stringify(card), /evan|alice|\bbo\b/);
  assert.doesNotMatch(JSON.stringify(notices.DEMO_NOTICES.week), /staging-demo-builder|author/, 'the staging demo card names nobody either');
});

test('the reads: this app, the settings kinds, the last week; the latest card of the last three days', async () => {
  assert.match(notices.SETTINGS_SQL, /e\.event_type = ANY\(\$2::text\[\]\)\s+AND e\.created_at > NOW\(\) - \(\$3 \|\| ' days'\)::interval\s+AND e\.app_id = \$1/);
  assert.match(notices.WEEK_SQL, /e\.event_type = 'weekly_digest'/);
  assert.deepEqual([...notices.SETTINGS_TYPES], ['visibility_changed', 'governance_changed', 'app_admins_changed', 'app_lock_changed', 'app_domain_changed', 'approver_joined']);
  assert.equal(notices.SETTINGS_DAYS, 7);
  assert.equal(notices.WEEK_DAYS, 3);
  const seen = [];
  const pool = { query: async (sql, params) => { seen.push(params); return { rows: [] }; } };
  assert.deepEqual(await notices.forApp(pool, 12), { settings: [], week: null });
  assert.deepEqual(seen, [[12, notices.SETTINGS_TYPES, '7', 8], [12, '3']]);
});

test('a staging demo page shows one of each, only where the record has none', () => {
  const demo = notices.withDemoNotices({ settings: [], week: null });
  assert.equal(demo.settings.length, 1);
  assert.equal(demo.settings[0].kind, 'governance');
  assert.ok(demo.week && demo.week.demo);
  const real = { settings: [{ kind: 'lock', text: 'Locked', by: 'ada', at: null }], week: null };
  assert.equal(notices.withDemoNotices(real).settings, real.settings);
  const route = read('src/routes/app-notices.js');
  assert.match(route, /if \(IS_STAGING && req\.query\.demo === '1'\) return res\.json\(notices\.withDemoNotices\(found\)\);/);
  assert.match(route, /appAccess\.getAppForUser\(\s*pool, req\.params\.slug, req\.user, 'view', appAccess\.ACCESS_COLUMNS\s*\);\s*if \(!app\) return res\.status\(404\)/,
    'view access; a project the viewer cannot see is not disclosed');
  assert.match(read('server.js'), /app\.use\(appNoticesRoutes\(config\)\);/);
});

test('what feeds it: the lock toggle and the Friday sweep record events, not channel lines', () => {
  const apps = read('src/routes/apps.js');
  const lock = apps.slice(apps.indexOf("router.post('/api/apps/:slug/lock'"), apps.indexOf("router.post('/api/apps/:slug/main-check/resume'"));
  assert.match(lock, /type: events\.EVENT_TYPES\.APP_LOCK_CHANGED,\s*userId: req\.user\.id,\s*appId: app\.id,\s*metadata: \{ locked: app\.locked \},/);
  assert.doesNotMatch(lock, /sendSystemMessage/);
  const digest = read('src/services/weekly-digest.js');
  assert.match(digest, /await events\.record\(pool, \{ type: events\.EVENT_TYPES\.WEEKLY_DIGEST, appId: app\.id, metadata: digest \}\);/);
  assert.doesNotMatch(digest.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /sendSystemMessage/, 'no call, only the history in its comments');
  const { EVENT_TYPES } = require('../src/services/events');
  assert.equal(EVENT_TYPES.APP_LOCK_CHANGED, 'app_lock_changed');
  assert.equal(EVENT_TYPES.WEEKLY_DIGEST, 'weekly_digest');
});

test('the Workshop tab draws no "Lately in this project" panel: Overview leads straight into What\'s happening', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/dev-board/workshop/notices.tsx')), 'the panel is gone');
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.doesNotMatch(lander, /WorkshopNotices|NoticesPanel|data-ws-notices|from '\.\/notices'/);
  const ws = lander.slice(lander.indexOf("{tab === 'workshop' && !weekUp ? ("), lander.indexOf("{tab === 'needs' ? ("));
  assert.match(ws, /\{slug \? <ApprovalLine slug=\{slug\} \/> : null\}\n\s*<\/section>\n\s*\) : null\}\n\n\s*\{\/\* ── WHAT'S HAPPENING ──/,
    'the Overview card, then What\'s happening');
  assert.doesNotMatch(read('public/css/app.css'), /\.dev-ws-notice/, 'and none of its CSS');
  assert.doesNotMatch(read('frontend/locales/en/project.json'), /"notices\./, 'and none of its words');
});

test('a door to a project\'s hub opens the hub; a page opened again reads the tab last shown', () => {
  const view = read('public/js/app-view.js');
  // #3555: the hub's door is the general one turned to the hub, so a Recents
  // channel can open its project's Discussion tab the same way.
  assert.match(view, /_landOnHub\(slug\) \{\n\s*AppView\._landOnTab\(slug, 'status'\);\n\s*\},/);
  assert.match(view, /_landOnTab\(slug, tab\) \{\n\s*const key = AppView\._isWorkshopPlace\(tab\) \? tab : 'status';\n\s*AppView\._setWorkshopTab\(key\);\n\s*try \{\n\s*window\.dispatchEvent\(new CustomEvent\('usernode:workshop-tab', \{ detail: \{ slug: slug \|\| null, tab: key \} \}\)\);/);
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(lander, /if \(!door \|\| \(door\.slug && door\.slug !== v\.slug\)\) return;\n\s*setTab\(door\.tab\);/, 'a page already open switches; another project\'s door is not its');
  assert.match(lander, /window\.addEventListener\('usernode:workshop-tab', onDoor\);/);
  // #3555: ...and is read when the page turns to that project. Going
  // straight from one project's page to another's keeps the host, so the
  // page is not mounted again; it reads the tab afresh when its project
  // changes, as a mount does.
  assert.match(lander, /useLayoutEffect\(\(\) => \{\n\s*if \(!v\.slug\) return;\n\s*const was = tabSlug\.current;\n\s*tabSlug\.current = v\.slug;\n\s*if \(was && was !== v\.slug\) setTab\(freshTab\(\) \|\| 'status'\);\n\s*\}, \[v\.slug\]\);/);
  // Seeded from a fresh read, not the store's last publish: that one can be
  // a tab the viewer has since left, which is what Back used to reopen on.
  assert.match(lander, /useState<TabKey>\(\(\) => freshTab\(\) \|\| v\.tab \|\| 'status'\)/);
  assert.match(lander, /export function freshTab\(\): TabKey \| null \{\n\s*const tab = callAppView\('_workshopTab'\);/);
  // The doors: the logo menu row, Discover's rows, the Communities rows and a
  // Needs you card's project name. Back and Forward are not doors.
  // The menu row lands on the hub before either way it navigates: full width
  // beside a running app on a desktop, its own link everywhere else.
  assert.match(read('frontend/src/features/app-context/app-context-sheet.tsx'), /onClick=\{\(e\) => \{\n\s*if \(slug\) \(window as any\)\.AppView\?\._landOnHub\?\.\(slug\);\n\s*if \(slug && [^\n]*\n\s*&& \(window as any\)\.UsernodeReact\?\.sidePanel\?\.openFullWidth\?\.\([^\n]*\n[^}]*\}\n\s*followThenDismiss\(e,/);
  assert.match(read('frontend/src/features/apps/browse.js'), /if \(typeof AppView !== 'undefined' && AppView\._landOnHub\) AppView\._landOnHub\(view\.slug\);\n\s*location\.hash = href;/);
  assert.match(read('frontend/src/features/workshop/index.tsx'), /win\.AppView\?\._landOnHub\?\.\(row\.slug\);\n\s*win\.App\?\.navigateToApp\?\.\(row\.slug, 'dev'\);/);
  assert.match(read('frontend/src/features/workshop/needs-reel.tsx'), /onClick=\{\(\) => \{ \(window as any\)\.AppView\?\._landOnHub\?\.\(app\.slug\); \}\}/);
});
