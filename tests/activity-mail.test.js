'use strict';

// WP-E: activity mail, the email that stands in for a push a person's phone
// cannot take (src/services/activity-mail.js), its two templates, its
// one-click unsubscribe, and its own hourly budget beside sign-in codes'.
//
// Run with: node --test tests/activity-mail.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const activityMail = require('../src/services/activity-mail');
const templates = require('../src/services/mail/templates');
const rateLimit = require('../src/services/mail/rate-limit');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A pool that answers the two reads emailIfNoPush makes.
function fakePool({ user = null, phones = 0 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM users WHERE id/.test(sql)) return { rows: user ? [user] : [] };
      if (/FROM mobile_push_registrations/.test(sql)) return { rows: phones ? [{ '?column?': 1 }] : [] };
      if (/UPDATE users SET activity_email = FALSE/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const CONFIRMED = { email: 'maya@example.com', email_confirmed: true, activity_email: true, is_synthetic: false };

test('the unsubscribe token is the account\'s own, and a wrong one changes nothing', async () => {
  activityMail.init({ sessionSecret: 'k1' });
  const token = activityMail.unsubscribeToken(7);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(activityMail.tokenMatches(7, token), true);
  assert.equal(activityMail.tokenMatches(8, token), false, 'another account');
  assert.equal(activityMail.tokenMatches(7, token.slice(0, 31)), false, 'cut short');
  assert.equal(activityMail.unsubscribeToken(7, 'k2') === token, false, 'another secret');
  assert.match(activityMail.unsubscribeUrl(7), /\/mail\/unsubscribe\?u=7&t=[A-Za-z0-9_-]{32}$/);

  const pool = fakePool();
  assert.equal(await activityMail.turnOff(pool, { userId: 7, token: 'x'.repeat(32) }), false);
  assert.equal(pool.queries.length, 0, 'a wrong token writes nothing');
  assert.equal(await activityMail.turnOff(pool, { userId: 7, token }), true);
  assert.match(pool.queries[0].sql, /SET activity_email = FALSE/);
});

test('sent only to a confirmed address with no phone, and never once turned off', async () => {
  activityMail.init({ sessionSecret: 'k1' });
  const args = { userId: 7, kind: 'build_ready', appName: 'Run Club', appSlug: 'run-club', conversationId: 12 };
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: CONFIRMED, phones: 1 }), args), 'push');
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: { ...CONFIRMED, email_confirmed: false } }), args), 'no_email');
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: { ...CONFIRMED, activity_email: false } }), args), 'turned_off');
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: { ...CONFIRMED, is_synthetic: true } }), args), 'no_email');
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: CONFIRMED }), { ...args, kind: 'otp' }), 'off', 'only its own kinds');
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: CONFIRMED }), args), 'sent');
  activityMail.init(null);
  assert.equal(await activityMail.emailIfNoPush(fakePool({ user: CONFIRMED }), args), 'off', 'nothing before boot hands it a config');
});

test('the button opens the bot\'s chat for a build, the project otherwise', () => {
  assert.match(activityMail.openUrl({ appSlug: 'run-club', conversationId: 12 }), /\/#messages\/12$/);
  assert.match(activityMail.openUrl({ appSlug: 'run-club' }), /\/app\/run-club$/);
});

test('both templates carry a one-click unsubscribe and say why they came', () => {
  const unsubscribeUrl = 'https://app.onhomeroom.com/mail/unsubscribe?u=7&t=abc';
  const ready = templates.buildMessage('build_ready', { appName: 'Run Club', url: 'https://x/#messages/12', unsubscribeUrl });
  // "One story": the push's words when the sender hands none over
  // (tests/homeroom-bot-notify-copy.test.js pins the request-titled ones).
  assert.equal(ready.subject, 'Run Club: Ready to try');
  assert.match(ready.text, /^Ready to try\. Try it, and approve it if you're happy\./);
  assert.match(ready.text, /To stop these emails: https:\/\/app\.onhomeroom\.com\/mail\/unsubscribe/);
  assert.deepEqual(ready.headers, {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.match(ready.html, /no phone/);
  const joined = templates.buildMessage('invite_activity', {
    appName: 'Run Club', line: '@sam joined Run Club through your invite.', url: 'https://x/app/run-club', unsubscribeUrl,
  });
  assert.equal(joined.subject, '@sam joined Run Club through your invite');
  assert.ok(joined.headers['List-Unsubscribe']);
  // Every other kind's message is unchanged: no headers key at all.
  assert.equal('headers' in templates.buildMessage('otp', { code: '123456' }), false);
});

test('both transports send a kind\'s headers', () => {
  const gmail = read('src/services/mail/transports/gmail.js');
  assert.match(gmail, /Object\.entries\(message\.headers \|\| \{\}\)/);
  assert.match(gmail, /headerSafe\(value\)/, 'a header value cannot carry a line break');
  const http = read('src/services/mail/transports/http-api.js');
  assert.match(http, /headers: \{ \.\.\.message\.headers \}/);
});

test('activity mail has its own hourly budget, apart from sign-in codes', () => {
  assert.deepEqual([...rateLimit.ACTIVITY_KINDS].sort(), ['build_ready', 'invite_activity']);
  assert.ok(rateLimit.RULES.build_ready && rateLimit.RULES.invite_activity);
  // A full activity budget refuses activity mail…
  const full = rateLimit.decide({
    kind: 'build_ready', globalCount: rateLimit.ACTIVITY_MAX_PER_HOUR, maxPerHour: rateLimit.ACTIVITY_MAX_PER_HOUR,
  });
  assert.equal(full.allowed, false);
  // …and the mailer counts each budget on its own, choosing the cap by kind.
  const index = read('src/services/mail/index.js');
  assert.match(index, /AND \(kind = ANY\(\$1::text\[\]\)\) = \$2/);
  assert.match(index, /rateLimit\.ACTIVITY_KINDS\.has\(kind\) \? rateLimit\.ACTIVITY_MAX_PER_HOUR : maxPerHour\(config\)/);
});

test('the unsubscribe route is mounted before sign-in, and the column defaults on', () => {
  const server = read('server.js');
  const at = server.indexOf("require('./src/routes/activity-mail').activityMailRoutes(config)");
  assert.ok(at > 0, 'mounted');
  assert.ok(at < server.indexOf('app.use(authMiddleware(config))'), 'before authMiddleware');
  // Initialised with the configuration every process running the workflow
  // machines sets up (src/workflow/setup.ts), which server.js runs at load.
  assert.match(server, /require\('\.\/src\/workflow\/setup\.ts'\)\.configureWorkflowProcess\(config\)/);
  assert.match(read('src/workflow/setup.ts'), /legacy\('services\/activity-mail'\)\.init\(config\)/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_email BOOLEAN NOT NULL DEFAULT TRUE;/);
  const route = read('src/routes/activity-mail.js');
  assert.match(route, /router\.get\('\/mail\/unsubscribe'/);
  assert.match(route, /router\.post\('\/mail\/unsubscribe'/);
});
