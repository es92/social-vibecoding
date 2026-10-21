'use strict';

// Invite links, without a database (tests/community-invites-postgres.test.js
// runs the SQL): the rules that are pure, the page's link preview, and the
// seams that carry a link through sign-in and into the shell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const invites = require('../src/services/community-invites');
const routes = require('../src/routes/community-invites');

test('a token is 22 base64url characters, and nothing else reaches the database', () => {
  assert.equal(invites.isToken('YigKXxtTzBB_TFZVTkjEtg'), true);
  for (const bad of ['', 'short', 'YigKXxtTzBB_TFZVTkjEt', 'YigKXxtTzBB_TFZVTkjEtg1', "YigKXxtTzBB'TFZVTkjEtg", null, 42]) {
    assert.equal(invites.isToken(bad), false, String(bad));
  }
  assert.equal(invites.invitePath('abc'), '/invite/abc');
});

test('defaults are 7 days and 25 people, within 1–30 days and 1–100 people', () => {
  assert.equal(invites.DEFAULT_DAYS, 7);
  assert.equal(invites.DEFAULT_USES, 25);
  assert.deepEqual({ ...invites.LIMITS }, { minDays: 1, maxDays: 30, minUses: 1, maxUses: 100 });
  const schema = read('src/db/schema.sql');
  assert.match(schema, /max_uses\s+INTEGER NOT NULL DEFAULT 25 CHECK \(max_uses BETWEEN 1 AND 100\)/);
});

test('why a link is dead: turned off, then expired, then used up', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const live = { revoked_at: null, expires_at: '2026-10-01T00:00:00Z', uses: 0, max_uses: 25 };
  assert.equal(invites.deadReason(live, now), null);
  assert.equal(invites.deadReason(null, now), 'unknown');
  assert.equal(invites.deadReason({ ...live, revoked_at: now, uses: 25 }, now), 'revoked');
  assert.equal(invites.deadReason({ ...live, expires_at: '2026-09-27T12:00:00Z' }, now), 'expired');
  assert.equal(invites.deadReason({ ...live, uses: 25 }, now), 'used_up');
  // A link dies with its maker's standing: removed from the group, gone.
  assert.equal(invites.deadReason({ ...live, maker_holds: false }, now), 'revoked');
  assert.equal(invites.deadReason({ ...live, maker_holds: true }, now), null);
  // WP-D: no end date and no cap: it works until it is turned off.
  const forever = { ...live, expires_at: null, max_uses: null, uses: 5000 };
  assert.equal(invites.deadReason(forever, now), null);
  assert.equal(invites.deadReason({ ...forever, revoked_at: now }, now), 'revoked');
  assert.equal(invites.deadReason({ ...forever, max_uses: 25, uses: 25 }, now), 'used_up');
  assert.equal(invites.deadReason({ ...forever, expires_at: '2026-09-27T12:00:00Z' }, now), 'expired');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE community_invites ALTER COLUMN expires_at DROP NOT NULL;\nALTER TABLE community_invites ALTER COLUMN max_uses DROP NOT NULL;/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION community_invite_maker_holds\(p_invite INTEGER\) RETURNS BOOLEAN/);
  assert.match(schema, /IF NOT community_invite_maker_holds\(\(SELECT invite_id FROM community_invite_redemptions WHERE id = r\.id\)\) THEN\s+RETURN FALSE;/,
    'checked again at release, for a queued person');
  assert.match(read('src/services/community-invites.js'), /community_invite_maker_holds\(i\.id\) AS maker_holds/);
});

test('what a link grants is what its maker could: a collaborator where building is by invitation', () => {
  assert.equal(invites.grantFor({ collab_visibility: 'private', self_hosted: false }), 'collaborator');
  assert.equal(invites.grantFor({ collab_visibility: 'public', self_hosted: false }), 'member');
  assert.equal(invites.grantFor({ collab_visibility: 'private', self_hosted: true }), 'member', 'Homeroom has no collaborators');
  // The one implementation, in SQL, says the same.
  assert.match(read('src/db/schema.sql'), /IF r\.collab_visibility = 'private' AND NOT r\.self_hosted THEN\s+INSERT INTO app_collaborators/);
});

test('THE TREE IS RETIRED: no skips, no switch, no chart value; anyone new joins as a private member', () => {
  for (const gone of ['treeEnabled', 'setTreeEnabled', 'adminPayload', 'treeBudgets', 'budgetFor', 'admitThroughTree', 'skipsLeft', 'SETTING_KEY']) {
    assert.equal(invites[gone], undefined, `${gone} is gone`);
  }
  const src = read('src/services/community-invites.js');
  assert.doesNotMatch(src, /invite_tree_enabled|INVITE_TREE_BUDGETS|admitThroughTree\(/);
  // Without platform access, a link makes a private member, whoever made it.
  assert.match(src, /\} else \{\s+privateMember = await joinAsPrivateMember\(client, user\.id, redemptionId, \{ requirePhone \}\);\s+\}/);
  // The admin switch, its routes and its panel went with it.
  assert.doesNotMatch(read('src/routes/topochain/admin/waitlist.js'), /invite-tree|communityInvites/);
  assert.doesNotMatch(read('frontend/src/features/admin/topochain/waitlist.tsx'), /InviteTreePanel|InviteTreeBody|admin-topo-wl-invites/);
  // And the per-generation budget: not in the chart, not declared.
  assert.doesNotMatch(read('deploy/helm/social-vibecoding-platform/templates/platform.yaml'), /INVITE_TREE/);
  assert.doesNotMatch(read('deploy/helm/social-vibecoding-platform/values.yaml'), /inviteTreeBudgets/);
  const appManifest = require('../src/services/app-manifest');
  const declared = new Set(appManifest.readPlatformEnv(JSON.parse(read('dapp.json'))).map((e) => e.key));
  assert.equal(declared.has('INVITE_TREE_BUDGETS'), false);
  // The invite sheet has no skips to count.
  assert.doesNotMatch(read('src/routes/community-invites.js'), /skipsLeft/);
});

test('the tables are staging:private, and a queued invite is applied by a trigger on being let in', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /COMMENT ON TABLE community_invites IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE community_invite_redemptions IS 'staging:private';/);
  assert.match(schema, /CREATE TRIGGER users_apply_queued_community_invites\s+AFTER UPDATE OF has_platform_access ON users\s+FOR EACH ROW WHEN \(NEW\.has_platform_access\)/);
  assert.match(schema, /IF TG_OP = 'UPDATE' AND OLD\.has_platform_access THEN\s+RETURN NULL;/, 'the false → true edge only');
});

test('the invite-links block runs in the Postgres suite\'s scratch schema: it reads only the tables that fixture makes', () => {
  // tests/community-invites-postgres.test.js lifts this block out of
  // schema.sql (to the next "-- ── " header) and runs it beside a handful of
  // tables. A table in it that references one the fixture does not make
  // fails the whole suite, and only where Postgres runs: the open counts'
  // table did, until it moved to its own section after the block.
  const schema = read('src/db/schema.sql');
  const start = schema.indexOf('-- ── Communities, stage 6: invite links');
  const block = schema.slice(start, schema.indexOf('\n-- ── ', start + 10));
  const fixture = read('tests/community-invites-postgres.test.js');
  const made = new Set([
    ...[...fixture.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]),
    ...[...block.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]),
  ]);
  const referenced = [...new Set([...block.matchAll(/REFERENCES (\w+)\(/g)].map((m) => m[1]))];
  assert.ok(referenced.length > 0);
  assert.deepEqual(referenced.filter((name) => !made.has(name)), []);
  assert.ok(!block.includes('community_invite_opens'), 'the open counts live in their own section');
  assert.match(schema, /-- ── Invite opens \(WP-E\)[\s\S]*?CREATE TABLE IF NOT EXISTS community_invite_opens/);
  assert.match(schema, /COMMENT ON TABLE community_invite_opens IS 'staging:private';/);
});

test('the page\'s link preview: a live link names the project and inviter, a dead one nothing, all escaped', () => {
  const live = routes.previewTags({
    live: true,
    project: { name: 'Tiers & <Lists>', iconUrl: '/app-icons/abc' },
    inviter: 'ada',
    memberCount: 3,
  }, 'https://app.example');
  assert.match(live, /<meta property="og:title" content="Tiers &amp; &lt;Lists&gt;">/);
  assert.match(live, /<meta property="og:description" content="@ada invited you to Tiers &amp; &lt;Lists&gt;\. 3 people are in it\.">/);
  assert.match(live, /<meta property="og:image" content="https:\/\/app\.example\/app-icons\/abc">/);
  const dead = routes.previewTags({ live: false, reason: 'revoked' }, 'https://app.example');
  assert.match(dead, /content="Homeroom invite"/);
  assert.doesNotMatch(dead, /og:image/);
  assert.equal(routes.withPreviewTags('<html><head><title>x</title></head></html>', '<meta a>'),
    '<html><head><title>x</title><meta a>\n</head></html>');
});

test('the paths: the page is a shell document; following from the waiting room is open, making links is not', () => {
  const auth = read('src/middleware/auth.js');
  // #5263: any one segment, so a mistyped link reaches the page that says it does not work.
  assert.match(auth, /\|\| \/\^\\\/invite\\\/\[\^\/\]\+\$\/\.test\(pathname\)/);
  assert.match(auth, /'\/api\/invite-links\/by-token\/',\s+'\/api\/invite-links\/queued',(\s+\/\/[^\n]*)+\s+'\/api\/me\/first-session\/started',\s+\];/);
  assert.doesNotMatch(auth, /'\/api\/invite-links\/',/, 'not the whole prefix');
  assert.match(auth, /'\/api\/public\/',/, 'the preview rides the existing anonymous tier');
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(communityInviteRoutes(config));') < server.indexOf("app.get('*', (req, res) => {"),
    'mounted before the catch-all');
  const src = read('src/routes/community-invites.js');
  for (const route of [
    "router.post('/api/apps/:slug/invite-links', drainGuard, inviteLinkCreateLimiter,",
    "router.get('/api/apps/:slug/invite-links',",
    "router.delete('/api/invite-links/:id', drainGuard,",
    "router.get('/api/public/invites/:token', invitePreviewLimiter,",
    "router.get('/api/invite-links/by-token/:token', invitePreviewLimiter,",
    "router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter,",
    "router.get('/api/invite-links/queued',",
    "router.get('/invite/:token', invitePreviewLimiter,",
  ]) assert.ok(src.includes(route), route);
  // Only a live link leaves its token for sign-in to follow (never staging's
  // demo link, tests/staging-demo-invite.test.js).
  assert.match(src, /if \(preview\.live && !demo\) \{\s*invites\.setInviteCookie\(req, res, token\);/);
});

test('signing UP from an invite page follows the link server-side; signing IN is asked first', () => {
  const auth = read('src/routes/auth.js');
  // Only an account the email code just created: signing up from the link is
  // the consent. A forced navigation that plants the cookie cannot make an
  // existing account join anything without the shell's confirm.
  // A link that joined them on the spot (its maker's skip let them in) has
  // its "Find people to build with" counted before the answer (#3564); that
  // one line sits between the redeem and the branch, and nothing else may.
  // An existing account follows it only when the sign-in is the Join its page
  // asked for (the sheet sends followInvite); the cookie alone never does.
  // Otherwise the carried copy is only dropped (dropCarried), which since
  // #4272 also counts the sign-in for the admin Journey's invite funnel as
  // one the link brought; it still follows nothing.
  // The code's route and the release link's (#4594) share that answer
  // (answerProvenEmail): only the code's passes the sheet's followInvite on.
  assert.match(auth, /return await answerProvenEmail\(req, res, verified, \{ followInvite: req\.body\?\.followInvite === true \}\);/);
  assert.match(auth, /return await answerProvenEmail\(req, res, verified, \{ via: 'link', extra: \{ email: verified\.email \} \}\);/);
  assert.match(auth, /const consented = verified\.created \|\| followInvite;\s+const invite = consented\s+\? await communityInvites\.redeemCarried\(pool, req, res, verified\.userId, \{\s+requirePhone: phoneAuth\.offered\(config\),\s+\}\)\s+: await communityInvites\.dropCarried\(pool, req, res, verified\.userId\);\s+(?:\/\/[^\n]*\n\s*)*if \(invite && invite\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);\s+if \(verified\.next === 'signed-in'\)/);
  assert.match(read('frontend/src/features/auth/sign-in-sheet.tsx'), /body: JSON\.stringify\(\{ email, code, \.\.\.\(followInvite \? \{ followInvite: true \} : \{\}\) \}\)/);
  const login = auth.slice(auth.indexOf("log.info('auth', 'Login successful'"), auth.indexOf("log.info('auth', 'Login successful'") + 900);
  assert.match(login, /await communityInvites\.dropCarried\(pool, req, res, user\.id\);/, 'a password sign-in drops the carried copy');
  assert.doesNotMatch(login, /redeemCarried/);
  for (const file of ['src/routes/phone-auth.js', 'src/routes/sign-in-providers.js']) {
    assert.match(read(file), /: await communityInvites\.dropCarried\(pool, req, res, result\.userId\);/, `${file} drops it the same way`);
  }
  const src = read('src/services/community-invites.js');
  // Dropping it follows nothing: it clears the cookie and records the
  // sign-in, and never reaches redeem().
  const drop = src.slice(src.indexOf('async function dropCarried'), src.indexOf('module.exports'));
  assert.match(drop, /clearInviteCookie\(res\);/);
  assert.match(drop, /noteInviteSignedIn\(pool, \{ token, userId, carried: true \}\)/);
  assert.doesNotMatch(drop, /redeem\(/);
  assert.match(src, /httpOnly: true,\s+sameSite: 'lax',/);
  // It never throws into a sign-in.
  assert.match(src, /log\.warn\('invites', 'Following a carried invite link failed'/);
});

test('the shell: signed out it is the landing, remembered for after sign-in; signed in it is a confirm', () => {
  const app = read('public/js/app.js');
  assert.match(app, /const inviteToken = rawHash \? null : App\._inviteTokenFromPath\(location\.pathname\);/);
  assert.match(app, /AuthScreens\.rememberDeepLink\(location\.pathname\);\s+AuthScreens\.show\('landing'\);/);
  assert.match(app, /if \(App\.user\.hasPlatformAccess !== false\) \{\s+App\._followInvite\(inviteToken\);/);
  assert.match(app, /confirmLabel: PlatformI18n\.t\('shell:invite\.confirm\.join'\),\s+cancelLabel: PlatformI18n\.t\('shell:invite\.confirm\.notNow'\),/);
  assert.equal(message('shell:invite.confirm.join'), 'Join');
  assert.equal(message('shell:invite.confirm.notNow'), 'Not now');
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /if \(\/\^\\\/invite\\\/\[A-Za-z0-9_-\]\{22\}\$\/\.test\(value\)\) return value;/, 'a deep link back to it');
  assert.match(screens, /if \(invite\) AuthScreens\._waitingInvite = invite\[1\];/, 'kept for the waiting room');
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /fetch\(`\/api\/invite-links\/by-token\/\$\{encodeURIComponent\(token\)\}\/redeem`/);
  assert.match(waiting, /fetch\('\/api\/invite-links\/queued'/);
});

test('the words: the landing card, the invite pane', async () => {
  const card = loadTsx('frontend/src/features/auth/invite-card.tsx');
  assert.equal(card.inviteTokenFrom('/invite/YigKXxtTzBB_TFZVTkjEtg'), 'YigKXxtTzBB_TFZVTkjEtg');
  assert.equal(card.inviteTokenFrom('/invite/nope'), null);
  assert.equal(card.invitedLine({ live: true, reason: null, project: { name: 'Tiers', iconEmoji: null, iconUrl: null }, inviter: 'ada' }),
    '@ada invited you to join Tiers.');
  assert.equal(card.membersLine(1), '1 person is in it.');
  assert.equal(card.membersLine(0), '');
  // #4203: the page leads with the invitation, not the making, in one line
  // under the project's name: who invited you (display name, else @handle),
  // then how many are in it.
  const evan = { live: true, reason: null, project: { name: 'Supply Line', iconEmoji: '📦', iconUrl: null },
    inviter: 'evan', inviterName: 'Evan', inviterMadeIt: true, memberCount: 26 };
  assert.equal(card.inviteLine(evan), 'Evan invited you to Supply Line · 26 people are in it');
  assert.equal(card.inviteLine({ ...evan, inviterMadeIt: false }), 'Evan invited you to Supply Line · 26 people are in it');
  assert.equal(card.inviteLine({ ...evan, building: true }), 'Evan invited you to Supply Line · 26 people are in it');
  // No display name: preview() sends the handle as inviterName, and the page
  // names the handle as a handle.
  assert.equal(card.inviteLine({ ...evan, inviterName: 'evan' }), '@evan invited you to Supply Line · 26 people are in it');
  assert.equal(card.inviteLine({ ...evan, inviterName: null }), '@evan invited you to Supply Line · 26 people are in it');
  assert.equal(card.inviteLine({ ...evan, inviter: null, inviterName: null }), "You're invited to Supply Line · 26 people are in it");
  // The count: one person, and zero (or none sent) says nothing.
  assert.equal(card.inviteLine({ ...evan, memberCount: 1 }), 'Evan invited you to Supply Line · 1 person is in it');
  assert.equal(card.inviteLine({ ...evan, memberCount: 0 }), 'Evan invited you to Supply Line');
  assert.equal(card.inviteLine({ ...evan, memberCount: undefined }), 'Evan invited you to Supply Line');
  // #4394: inside the project's own card the name is just above, so the
  // invitation does not repeat it.
  assert.equal(card.invitedYouLine(evan), 'Evan invited you · 26 people are in it');
  assert.equal(card.invitedYouLine({ ...evan, inviter: null, inviterName: null }), "You're invited · 26 people are in it");
  assert.equal(card.invitedYouLine({ ...evan, memberCount: 0 }), 'Evan invited you');
  assert.equal(card.invitedYouLine({ ...evan, inviter: null, inviterName: null, memberCount: 0 }), "You're invited");
  assert.equal(card.membersPhrase(2), '2 people are in it');
  assert.equal(card.inviterLabel({ inviter: 'evan', inviterName: 'Evan' }), 'Evan');
  assert.equal(card.inviterLabel({ inviter: 'evan', inviterName: 'evan' }), '@evan');
  assert.equal(card.inviterLabel({}), '');
  // The signed-out page does not say who will see the join (owner, 8 October).
  assert.equal(card.seenLine, undefined);
  assert.equal(card.HOMEROOM_LINE, 'auth:invite.homeroomLine');
  assert.equal(message(card.HOMEROOM_LINE), 'On Homeroom, people using an app build and improve it together.');
  // The making line is gone: the hero says who invited you, not who made it.
  const src = read('frontend/src/features/auth/invite-card.tsx');
  assert.doesNotMatch(src, /and invited you to join|export function madeLine|export function underLine/);

  const pane = loadTsx('frontend/src/features/app-context/invite-pane.tsx');
  const now = Date.parse('2026-09-27T12:00:00Z');
  const fresh = { expiresAt: '2026-10-04T12:00:00Z', maxUses: 25, uses: 0 };
  assert.equal(pane.linkDetail({ ...fresh, uses: 3 }, now), '3 of 25 used · 7 days left');
  // WP-D: a link with no end date, or for anyone, says so. A link for anyone
  // no longer counts its joiners on this line: that is the row's second line.
  const forever = { expiresAt: null, maxUses: null, uses: 0 };
  assert.equal(pane.linkDetail({ ...forever, uses: 4 }, now), 'for anyone · no end date');
  assert.equal(pane.linkDetail({ ...fresh, maxUses: null, uses: 2 }, now), 'for anyone · 7 days left');
  // A link that has ended says why, in place of how long it had left.
  assert.equal(pane.linkDetail({ ...fresh, uses: 3, status: 'expired' }, now), '3 of 25 used · expired');
  assert.equal(pane.linkDetail({ ...fresh, maxUses: 1, uses: 1, status: 'used_up' }, now), '1 of 1 used · all used');
  assert.equal(pane.linkDetail({ ...fresh, uses: 3, status: 'revoked' }, now), '3 of 25 used · turned off');
  // The second line: who came in through the link.
  assert.equal(pane.statusLine({ joined: 2, waiting: 1 }), '2 joined · 1 waiting');
  assert.equal(pane.statusLine({ joined: 0, waiting: 1 }), '1 waiting');
  assert.equal(pane.statusLine({ joined: 3, waiting: 0 }), '3 joined');
  assert.equal(pane.statusLine({ joined: 0, waiting: 0 }), 'No one has joined yet');
  const paneSrc = read('frontend/src/features/app-context/invite-pane.tsx');
  assert.match(paneSrc, /const DAY_CHOICES = \[1, 7, 30, NO_LIMIT\];/);
  assert.match(paneSrc, /t\('agent:appContext\.invite\.option\.untilOff'\)/);
  assert.equal(message('agent:appContext.invite.option.untilOff'), 'Until you turn it off');
  assert.match(paneSrc, /t\('agent:appContext\.invite\.option\.anyone'\)/);
  assert.equal(message('agent:appContext.invite.option.anyone'), 'Anyone with the link');
  // #4599 (evan): no explanatory lines under the link. Its row of Your links
  // says how long and how many; Change sits beside that heading.
  assert.equal(pane.linkSentence, undefined);
  assert.equal(pane.newcomerLine, undefined);
  assert.doesNotMatch(paneSrc, /joiningRule|app-invite-sentence|appContext\.invite\.(?:sentence|fact|newcomer)\b|Someone new to Homeroom|Change how long or how many/);
  const inviteTexts = Object.entries(JSON.parse(read('frontend/locales/en/agent.json')))
    .filter(([key]) => key.startsWith('appContext.invite.')).map(([, entry]) => entry.text).join('\n');
  assert.doesNotMatch(inviteTexts, /Someone new to Homeroom|Change how long or how many|Anyone with this link can join/);
  assert.match(paneSrc, /id="app-invite-change-open"[^\n]*\n\s*\{t\('agent:appContext\.invite\.change'\)\}\n/);
  assert.equal(message('agent:appContext.invite.change'), 'Change');

  // #4780: an ended row is greyed, carries its status, keeps its counts, and
  // has no Turn off (it is already off); a live row keeps its own. The pane
  // is rendered the way tests/invite-sheet-once.test.js does: the fetch
  // stubbed, the read prepared, then the pane's first render from it.
  const paneApi = loadTsx('tests/fixtures/invite-pane-api.ts');
  const liveRow = {
    id: 9, token: 'a'.repeat(22), path: '/invite/' + 'a'.repeat(22), maxUses: 25, uses: 3,
    expiresAt: '2026-10-04T12:00:00Z', createdAt: '2026-10-05T12:00:00Z', createdBy: null,
    mine: true, note: null, status: 'live', joined: 2, waiting: 1,
  };
  const endedRow = { ...liveRow, id: 8, token: 'b'.repeat(22), path: '/invite/' + 'b'.repeat(22), status: 'expired', joined: 1, waiting: 0 };
  const rowsState = {
    links: [liveRow, endedRow], manages: false, canCreate: true, grant: 'member',
    defaults: { days: 7, maxUses: 25 }, limits: { minDays: 1, maxDays: 30, minUses: 1, maxUses: 100 },
  };
  const rowsFetch = async () => ({ ok: true, json: async () => rowsState });
  const realFetch = global.fetch;
  global.fetch = rowsFetch;
  let rowsHtml;
  try {
    // The answer stays settled: the pane takes it on its first render, as
    // tests/invite-sheet-once.test.js does.
    await paneApi.prepareInvite('notes-ab12');
    rowsHtml = renderToHtml(createElement(paneApi.InvitePane, { slug: 'notes-ab12', label: 'Notes' }));
  } finally {
    global.fetch = realFetch;
    paneApi.forgetPreparedInvite();
  }
  const liveRowHtml = rowsHtml.match(/<div[^>]*data-invite-link="9"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  const endedRowHtml = rowsHtml.match(/<div[^>]*data-invite-link="8"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(liveRowHtml && endedRowHtml, 'both rows rendered');
  assert.match(endedRowHtml, /data-invite-status="expired"/);
  assert.match(liveRowHtml, /data-invite-status="live"/);
  assert.doesNotMatch(endedRowHtml, /Turn off/, 'an ended row is already off');
  assert.match(liveRowHtml, /Turn off/);
  assert.match(endedRowHtml, /1 joined/, 'its counts stay on the row');

  // #3362: the menu's "Invite to community" row is gone; the pane opens from
  // the hub's Invite (and a just-yours project's Share it card), beside the
  // people it adds.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(sheet, /id="app-menu-row-invite"/);
  const hubCard = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  // One call that opens the menu ON the pane (tests/invite-sheet-once.test.js).
  assert.match(hubCard, /export function openInviteLinks\(\): void \{[\s\S]*?void ctx\.openInvite\?\.\(\);/);
  assert.match(hubCard, /data-ws-community-invite=""[\s\S]{0,120}onClick=\{openInviteLinks\}/);
  assert.match(hubCard, /data-ws-share-invite=""[\s\S]{0,60}onClick=\{openInviteLinks\}/);
  assert.match(sheet, /view === 'invite' \? \(\s+<InvitePane slug=\{slug \|\| null\} label=\{appLabel\} unnamed=\{!appName\} \/>/);
  assert.match(read('frontend/src/features/app-context/app-context-controller.js'), /showInvite\(\) \{\s+appContextStore\.set\(\{ view: 'invite' \}\);/);
});

test(`a link carries its maker's note: plain text, one paragraph, at most 280 characters`, () => {
  assert.equal(invites.NOTE_MAX, 280);
  assert.deepEqual(invites.cleanNote(undefined), { ok: true, note: null });
  assert.deepEqual(invites.cleanNote('   '), { ok: true, note: null });
  assert.deepEqual(invites.cleanNote('  Come  help\nwith our run tracker! '), { ok: true, note: 'Come help with our run tracker!' });
  assert.equal(invites.cleanNote('x'.repeat(280)).ok, true);
  assert.equal(invites.cleanNote('x'.repeat(281)).ok, false);
  assert.equal(invites.cleanNote('🏃'.repeat(280)).ok, true, 'counted in characters, not code units');
  assert.equal(invites.cleanNote('bell\u0007').ok, false);
  assert.equal(invites.cleanNote(42).ok, false);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS note TEXT;/);
  assert.match(schema, /CHECK \(note IS NULL OR char_length\(note\) BETWEEN 1 AND 280\)/);
  const src = read('src/services/community-invites.js');
  assert.match(src, /const cleaned = cleanNote\(note\);\s+if \(!cleaned\.ok\) return \{ ok: false, status: 400, error: cleaned\.error \};/);
  assert.match(read('src/routes/community-invites.js'), /maxUses: req\.body\?\.maxUses, note: req\.body\?\.note,/);
});

// The card is the project (Evan, 20 Oct 2026): its name, its one line, and
// its icon as the thumbnail. The note is the message the link is sent in,
// so it is the card's line only when the project has none of its own.
test(`the preview is the project: its name, its line, its icon`, () => {
  const live = {
    live: true,
    project: { name: 'Sunday Run Club', iconUrl: '/app-icons/abc', iconEmoji: null, description: 'A run tracker', picture: null },
    inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, note: 'Come help with our run tracker!', memberCount: 4,
    communityName: 'Sunday Runners',
  };
  const tags = routes.previewTags(live, 'https://homeroom.example', 'tok');
  assert.match(tags, /og:title" content="Sunday Run Club"/);
  assert.match(tags, /twitter:title" content="Sunday Run Club"/);
  assert.doesNotMatch(tags, /Maya|made|on Homeroom"/, 'no maker and no "Join … on Homeroom" in the title');
  assert.match(tags, /og:description" content="A run tracker"/);
  assert.match(tags, /og:image" content="https:\/\/homeroom\.example\/app-icons\/abc"/);
  assert.match(tags, /twitter:card" content="summary"/);
  // An emoji icon: drawn on the project's colour, through the link.
  const emoji = routes.previewTags({ ...live, project: { ...live.project, iconUrl: null, iconEmoji: '📊' } }, 'https://h.example', 'Ab_c-1');
  assert.match(emoji, /og:image" content="https:\/\/h\.example\/api\/public\/invites\/Ab_c-1\/icon\.png"/);
  // No token (staging's demo link), no origin, or no icon: no picture.
  assert.doesNotMatch(routes.previewTags({ ...live, project: { ...live.project, iconUrl: null, iconEmoji: '📊' } }, 'https://h.example', null), /og:image/);
  assert.doesNotMatch(routes.previewTags(live, null, 'tok'), /og:image/);
  assert.doesNotMatch(routes.previewTags({ ...live, project: { ...live.project, iconUrl: null } }, 'https://h.example', 'tok'), /og:image/);
  // A picture of the project is the page's, not the card's: the icon stays.
  const shot = routes.previewTags({ ...live, project: { ...live.project, picture: { kind: 'shot', url: '/api/public/invites/t/picture' } } }, 'https://h.example', 'tok');
  assert.match(shot, /twitter:card" content="summary"/);
  assert.match(shot, /og:image" content="https:\/\/h\.example\/app-icons\/abc"/);
  // No line of its own: the note. Neither: who invited you.
  assert.match(routes.previewTags({ ...live, project: { ...live.project, description: null } }, null), /og:description" content="Come help with our run tracker!"/);
  assert.match(routes.previewTags({ ...live, note: null, project: { ...live.project, description: null } }, null), /og:description" content="@maya invited you to Sunday Run Club\. 4 people are in it\."/);
  // Everything is escaped.
  assert.match(routes.previewTags({ ...live, project: { ...live.project, description: 'a "quote" <b>' } }, null), /content="a &quot;quote&quot; &lt;b&gt;"/);
  // The page passes its token, except for staging's demo link.
  assert.match(read('src/routes/community-invites.js'), /previewTags\(preview, requestOrigin\(req\), demo \? null : token\)/);
  // The signed-in confirm says the same.
  // Each wording is a whole message of its own (shell.json).
  assert.match(read('public/js/app.js'), /\? \(standing\.building\s+\? PlatformI18n\.t\('shell:invite\.from\.isMaking', \{ inviter: standing\.inviterName \}\)\s+: PlatformI18n\.t\('shell:invite\.from\.made', \{ inviter: standing\.inviterName \}\)\)/);
  assert.equal(message('shell:invite.from.isMaking', { inviter: 'Maya' }), 'Maya is making it and invited you.');
  assert.equal(message('shell:invite.from.made', { inviter: 'Maya' }), 'Maya made it and invited you.');
});

test('the picture is served only through a live link, and only an after-shot of a merged change anybody may see', () => {
  const src = read('src/services/community-invites.js');
  // A public project's member-account phone still the shots agent cleared
  // (services/shots-public.js; tests/community-invites-postgres.test.js).
  assert.match(src, /const artifactId = await publicMergedStill\(db, appId\);\s+if \(artifactId\) return \{ kind: 'shot', artifactId \};/);
  assert.match(read('src/services/shots-public.js'), /stillsSql\('s\.app_id = \$1 AND s\.merged_at IS NOT NULL'\)/);
  assert.match(src, /async function pictureBytes\(pool, token\) \{\s+const invite = await loadInvite\(pool, token\);\s+if \(deadReason\(invite\)\) return null;/);
  const route = read('src/routes/community-invites.js');
  assert.match(route, /router\.get\('\/api\/public\/invites\/:token\/picture', invitePreviewLimiter,/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff',/);
  // WP-D: while a project is built, the card of the idea its maker was shown
  // (services/app-sketch.js), as words in the preview the page draws itself.
  // 5 October 2026: it was a framed page of a screen mock; no page is served.
  assert.doesNotMatch(route, /sketch\.html/);
  assert.match(src, /const card = sketch\[0\] \? require\('\.\/app-sketch'\)\.cardOf\(sketch\[0\]\.design\) : null;/);
  assert.match(src, /if \(picture\.kind === 'sketch'\) return \{ kind: 'sketch', url: null, darkUrl: null, card: picture\.card \};/);
  const card = read('frontend/src/features/auth/invite-card.tsx');
  assert.doesNotMatch(card, /<iframe/);
  // #4053: the thumbnail, without a build line: the invite knows that its
  // first version is on its way (`building`), not its step. #4394: it is the
  // hero, wearing the project's own icon.
  assert.match(card, /<FeaturedCard\s+name=\{project\.name\}\s+colorKey=\{project\.name\}\s+emoji=\{project\.iconEmoji \|\| \(project\.iconUrl \? null : sketch\.emoji\)\}\s+iconUrl=\{project\.iconUrl\}\s+card=\{sketch\}/);
  assert.doesNotMatch(card, /line=\{/);
  assert.match(card, /<Picture project=\{project\} building=\{!!preview\.building\} \/>/);
});

test(`a live link's landing is "Made for you"; the pitch stays in the document, hidden`, () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const \{ preview: invite, pending: invitePending \} = useInvitePreview\(\);/);
  assert.match(landing, /const madeForYou = !!invite\?\.live;/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| deadInvite \|\| storyOn \|\| invitePending \|\| waitingGuest;/);
  for (const hidden of [
    "hiddenLast(pitchHidden, 'grow')",
    "hiddenLast(pitchHidden, 'mx-auto mt-6 block h-auto w-[272px] xl:w-[320px] max-w-full')",
    "hiddenLast(pitchHidden, 'mt-3 overflow-hidden pt-2 pb-1 pl-4')",
    "hiddenLast(pitchHidden, 'px-4 flex grow flex-col text-center')",
  ]) assert.ok(landing.includes(hidden), hidden);
  const card = read('frontend/src/features/auth/invite-card.tsx');
  assert.match(card, /<section\s+data-landing-invite="live"/);
  assert.match(card, /data-landing-invite-picture=\{picture\.kind\}/);
  assert.match(card, /data-landing-invite-note=""/);
  assert.match(card, /\{t\('auth:invite\.join', \{ project: project\.name \}\)\}/);
  assert.equal(message('auth:invite.join', { project: 'Game Corner' }), 'Join Game Corner');
});
