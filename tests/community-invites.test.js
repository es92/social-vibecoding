'use strict';

// Invite links, without a database (tests/community-invites-postgres.test.js
// runs the SQL): the rules that are pure, the page's link preview, and the
// seams that carry a link through sign-in and into the shell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

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
  assert.match(live, /<meta property="og:title" content="Join Tiers &amp; &lt;Lists&gt; on Homeroom">/);
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
  assert.match(auth, /\|\| \/\^\\\/invite\\\/\[A-Za-z0-9_-\]\{22\}\$\/\.test\(pathname\)/);
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
  assert.match(auth, /const consented = verified\.created \|\| req\.body\?\.followInvite === true;\s+const invite = consented\s+\? await communityInvites\.redeemCarried\(pool, req, res, verified\.userId, \{\s+requirePhone: phoneAuth\.offered\(config\),\s+\}\)\s+: await communityInvites\.dropCarried\(pool, req, res, verified\.userId\);\s+(?:\/\/[^\n]*\n\s*)*if \(invite && invite\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);\s+if \(verified\.next === 'signed-in'\)/);
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
  assert.match(app, /confirmLabel: 'Join',\s+cancelLabel: 'Not now',/);
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /if \(\/\^\\\/invite\\\/\[A-Za-z0-9_-\]\{22\}\$\/\.test\(value\)\) return value;/, 'a deep link back to it');
  assert.match(screens, /if \(invite\) AuthScreens\._waitingInvite = invite\[1\];/, 'kept for the waiting room');
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /fetch\(`\/api\/invite-links\/by-token\/\$\{encodeURIComponent\(token\)\}\/redeem`/);
  assert.match(waiting, /fetch\('\/api\/invite-links\/queued'/);
});

test('the words: the landing card, the invite pane', () => {
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
  assert.equal(card.HOMEROOM_LINE, 'On Homeroom, people using an app build and improve it together.');
  // The making line is gone: the hero says who invited you, not who made it.
  const src = read('frontend/src/features/auth/invite-card.tsx');
  assert.doesNotMatch(src, /and invited you to join|export function madeLine|export function underLine/);

  const pane = loadTsx('frontend/src/features/app-context/invite-pane.tsx');
  const now = Date.parse('2026-09-27T12:00:00Z');
  const fresh = { expiresAt: '2026-10-04T12:00:00Z', maxUses: 25, uses: 0 };
  assert.equal(pane.linkDetail({ ...fresh, uses: 3 }, now), '3 of 25 used · 7 days left');
  // WP-D: a link with no end date, or for anyone, says so.
  const forever = { expiresAt: null, maxUses: null, uses: 0 };
  assert.equal(pane.linkDetail({ ...forever, uses: 4 }, now), '4 joined · no end date');
  assert.equal(pane.linkDetail({ ...fresh, maxUses: null, uses: 2 }, now), '2 joined · 7 days left');
  const paneSrc = read('frontend/src/features/app-context/invite-pane.tsx');
  assert.match(paneSrc, /const DAY_CHOICES = \[1, 7, 30, NO_LIMIT\];/);
  assert.match(paneSrc, /'Until you turn it off'/);
  assert.match(paneSrc, /'Anyone with the link'/);
  // #4599 (evan): no explanatory lines under the link. Its row of Your links
  // says how long and how many; Change sits beside that heading.
  assert.equal(pane.linkSentence, undefined);
  assert.equal(pane.newcomerLine, undefined);
  assert.doesNotMatch(paneSrc, /joiningRule|app-invite-sentence|Someone new to Homeroom|Change how long or how many/);
  assert.match(paneSrc, /id="app-invite-change-open"[^\n]*\n\s*Change\n/);

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
  assert.match(sheet, /view === 'invite' \? \(\s+<InvitePane slug=\{slug \|\| null\} label=\{appLabel\} \/>/);
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

test(`the preview reads like the page: who made it, their note, the project's picture`, () => {
  const live = {
    live: true,
    project: { name: 'Sunday Run Club', iconUrl: '/app-icons/abc', description: 'A run tracker', picture: null },
    inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, note: 'Come help with our run tracker!', memberCount: 4,
  };
  const tags = routes.previewTags(live, 'https://homeroom.example');
  // The community shares its project's name, so the title names the project.
  assert.match(tags, /og:title" content="Maya made Sunday Run Club"/);
  assert.match(tags, /twitter:title" content="Maya made Sunday Run Club"/);
  assert.doesNotMatch(tags, /made this for/);
  assert.match(routes.previewTags({ ...live, communityName: 'sunday run club' }, null), /og:title" content="Maya made Sunday Run Club"/);
  // A community named apart from its project is what it was made for.
  const forGroup = routes.previewTags({ ...live, project: { ...live.project, name: 'Run Tracker' }, communityName: 'Sunday Run Club' }, null);
  assert.match(forGroup, /og:title" content="Maya made this for Sunday Run Club"/);
  assert.match(tags, /og:description" content="Come help with our run tracker!"/);
  assert.match(tags, /og:image" content="https:\/\/homeroom\.example\/app-icons\/abc"/);
  assert.match(tags, /twitter:card" content="summary"/);
  // No note: the project's own line. Not its maker: the plain invitation.
  const plain = routes.previewTags({ ...live, note: null, inviterMadeIt: false }, null);
  assert.match(plain, /og:title" content="Join Sunday Run Club on Homeroom"/);
  assert.match(plain, /og:description" content="A run tracker"/);
  assert.doesNotMatch(plain, /og:image/);
  // A picture is the large card.
  const shot = routes.previewTags({ ...live, project: { ...live.project, picture: { kind: 'shot', url: '/api/public/invites/t/picture' } } }, 'https://h.example');
  assert.match(shot, /twitter:card" content="summary_large_image"/);
  assert.match(shot, /og:image" content="https:\/\/h\.example\/api\/public\/invites\/t\/picture"/);
  // WP-D: the card of the idea is words, not an image: the preview keeps the icon.
  const sketched = routes.previewTags({ ...live, project: { ...live.project, picture: { kind: 'sketch', url: null, darkUrl: null, card: { emoji: '🏃', tagline: 'Miles', points: [] } } } }, 'https://h.example');
  assert.match(sketched, /og:image" content="https:\/\/h\.example\/app-icons\/abc"/);
  assert.match(sketched, /twitter:card" content="summary"/);
  // The note is escaped like everything else.
  assert.match(routes.previewTags({ ...live, note: 'a "quote" <b>' }, null), /content="a &quot;quote&quot; &lt;b&gt;"/);
  // While its first version is on its way: "is making", as the page says.
  assert.match(routes.previewTags({ ...live, building: true }, null), /og:title" content="Maya is making Sunday Run Club"/);
  assert.match(routes.previewTags({ ...live, building: true, project: { ...live.project, name: 'Run Tracker' }, communityName: 'Sunday Run Club' }, null),
    /og:title" content="Maya is making this for Sunday Run Club"/);
  // The signed-in confirm says the same.
  assert.match(read('public/js/app.js'), /\? `\$\{standing\.inviterName\} \$\{standing\.building \? 'is making' : 'made'\} it and invited you\.`/);
});

test('the picture is served only through a live link, and only an after-shot of a merged change', () => {
  const src = read('src/services/community-invites.js');
  assert.match(src, /WHERE s\.app_id = \$1 AND s\.merged_at IS NOT NULL AND s\.shots_state = 'verified'\s+AND a\.side = 'head' AND a\.media = 'png'/);
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
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn \|\| invitePending;/);
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
  assert.match(card, /\{`Join \$\{project\.name\}`\}/);
});
