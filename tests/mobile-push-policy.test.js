'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildMessage, recipientBinding, RECIPIENT_CONTEXT, isPushEnvironment,
} = require('../src/services/mobile-push-policy');
const {
  classifyError, parseServiceAccount,
} = require('../src/services/mobile-push-provider');
const { validateConfiguration } = require('../src/services/mobile-push');

const INPUT = {
  token: 'opaque-fcm-token',
  notificationId: 42,
  kind: 'session_done',
  environment: 'production',
  installationId: '123e4567-e89b-12d3-a456-426614174000',
  userId: 7,
  expiresAt: new Date(Date.now() + 60_000),
};

test('recipient binding exactly matches the Flutter context encoding', () => {
  const expected = crypto.createHash('sha256').update([
    RECIPIENT_CONTEXT, INPUT.installationId, '7', 'production',
  ].join('\n')).digest('hex');
  assert.equal(recipientBinding(INPUT), expected);
});

test('push environments match the mobile build contract', () => {
  assert.equal(isPushEnvironment('production'), true);
  assert.equal(isPushEnvironment('staging_2'), true);
  assert.equal(isPushEnvironment('2production'), false);
  assert.equal(isPushEnvironment('Production'), false);
  assert.equal(isPushEnvironment(''), false);
});

test('FCM data payload keeps the opaque, environment-bound contract', () => {
  const message = buildMessage(INPUT);
  assert.deepEqual(Object.keys(message.data).sort(), [
    'environment', 'notification_id', 'recipient_binding', 'schema', 'source',
  ]);
  assert.equal(message.data.source, 'usernode_social');
  assert.equal(message.data.schema, '1');
  assert.equal(message.data.notification_id, '42');
  assert.equal(message.android.notification.channelId, 'social_activity');
  assert.ok(message.android.ttl > 0 && message.android.ttl <= 24 * 60 * 60 * 1000);
  assert.doesNotMatch(JSON.stringify(message.data), /session_done|user_id|token/);
});

test('a notification collapses to one alert per id on both platforms', () => {
  // #1078 UX contract: re-sends of the same notification replace the visible
  // alert (collapse id per notification), and all social pushes group into
  // one thread/channel rather than scattering across the lock screen.
  const now = new Date('2026-08-13T12:00:00Z');
  const message = buildMessage({ ...INPUT, now, expiresAt: new Date(now.getTime() + 60_000) });
  assert.equal(message.android.collapseKey, 'usernode-social-42');
  assert.equal(message.android.notification.tag, 'usernode-social-42');
  assert.equal(message.apns.headers['apns-collapse-id'], 'usernode-social-42');
  assert.equal(message.apns.headers['apns-push-type'], 'alert');
  assert.equal(message.apns.headers['apns-priority'], '10');
  assert.deepEqual(message.apns.payload.aps, {
    category: 'USERNODE_SOCIAL', threadId: 'usernode-social',
  });
  // The APNs expiration mirrors the delivery TTL exactly (unix seconds).
  assert.equal(message.android.ttl, 60_000);
  assert.equal(message.apns.headers['apns-expiration'],
    String(Math.floor((now.getTime() + 60_000) / 1000)));
});

test('reviewed interaction kinds build and unknown kinds stay closed', () => {
  assert.equal(buildMessage({ ...INPUT, kind: 'mention' }).data.notification_id, '42');
  assert.throws(() => buildMessage({ ...INPUT, kind: 'future_kind' }), /kind_not_allowed/);
  assert.throws(() => buildMessage({ ...INPUT, notificationId: 2147483648 }), /id_invalid/);
});

test('the unread total rides as the icon badge on both platforms', () => {
  // #1445: iOS only badges the homescreen icon when a push carries
  // `aps.badge`; Android launchers read `notificationCount`.
  const message = buildMessage({ ...INPUT, unreadCount: 5 });
  assert.deepEqual(message.apns.payload.aps, {
    category: 'USERNODE_SOCIAL', threadId: 'usernode-social', badge: 5,
  });
  assert.equal(message.android.notification.notificationCount, 5);

  // Zero is a valid count (it clears the badge), even though the worker
  // clamps to 1 in practice because the delivered notification is unread.
  const cleared = buildMessage({ ...INPUT, unreadCount: 0 });
  assert.equal(cleared.apns.payload.aps.badge, 0);
  assert.equal(cleared.android.notification.notificationCount, 0);
});

test('a missing or invalid unread count degrades to the pre-badge payload', () => {
  // The badge is display-only: a count problem must never fail a delivery,
  // so anything but a non-negative safe integer omits both fields.
  for (const unreadCount of [undefined, null, -1, 1.5, NaN, '5', Infinity]) {
    const message = buildMessage({ ...INPUT, unreadCount });
    assert.equal('badge' in message.apns.payload.aps, false,
      `aps.badge omitted for ${String(unreadCount)}`);
    assert.equal('notificationCount' in message.android.notification, false,
      `notificationCount omitted for ${String(unreadCount)}`);
  }
});

const CONTEXT = {
  appName: 'MyPage',
  conversationTitle: 'Design crew',
  sourceUsername: 'alice',
  messageContent: 'hey can you look at the header',
  sessionTitle: 'Fix login redirect loop',
  prTitle: null,
  branchName: null,
  detail: null,
};

test('each kind renders its own title and body from send-time context', () => {
  const cases = [
    ['conversation_invite', CONTEXT,
      '@alice invited you to a conversation · Design crew',
      'Open Messages to accept or decline'],
    ['conversation_message', CONTEXT,
      '@alice sent you a message · Design crew',
      'hey can you look at the header'],
    ['conversation_mention', CONTEXT,
      '@alice mentioned you · Design crew',
      'hey can you look at the header'],
    ['conversation_reply', CONTEXT,
      '@alice replied to you · Design crew',
      'hey can you look at the header'],
    ['conversation_reaction', { ...CONTEXT, detail: '👍' },
      '@alice reacted 👍 to your message · Design crew',
      'You said: hey can you look at the header'],
    ['mention', CONTEXT,
      '@alice mentioned you in "Fix login redirect loop" · MyPage',
      'hey can you look at the header'],
    ['reply', CONTEXT,
      '@alice replied in "Fix login redirect loop" · MyPage',
      'hey can you look at the header'],
    // #2387: a reply in an app-chat reply thread you are in.
    ['thread_reply', CONTEXT,
      '@alice replied in a thread · MyPage',
      'hey can you look at the header'],
    ['reaction', { ...CONTEXT, detail: '👍' },
      '@alice reacted 👍 to your message · MyPage',
      'You said: hey can you look at the header'],
    ['kudos', CONTEXT,
      '@alice gave you kudos for "Fix login redirect loop" · MyPage',
      'Your work is getting noticed'],
    ['collab_invite', CONTEXT,
      '@alice wants to build MyPage with you',
      'Join as a collaborator. Accept or decline in the app'],
    ['collab_invite_accepted', CONTEXT,
      '@alice is in! · MyPage',
      'Your invite was accepted. You can start building together'],
    ['approver_invite', CONTEXT,
      '@alice asked you to be an approver · MyPage',
      "You'd review and vote on proposals. Accept in the app"],
    ['approver_invite_accepted', CONTEXT,
      '@alice is now an approver · MyPage',
      'They can review and vote on proposals from now on'],
    ['spec_shared', { ...CONTEXT, detail: '3' },
      '@alice shared "Fix login redirect loop" with you · MyPage',
      'Spec v3. Take a look and leave feedback'],
    ['session_done', CONTEXT,
      'Your build is ready · MyPage',
      '"Fix login redirect loop" finished. Review it while it\'s fresh'],
    // #3181: the turn stopped before finishing. Where, then what to do.
    ['session_stalled', CONTEXT,
      'Your session on MyPage stopped before finishing',
      'Open "Fix login redirect loop" to continue'],
    ['pr_proposed', { ...CONTEXT, prTitle: 'Fix login redirect loop', sessionTitle: null },
      '@alice proposed "Fix login redirect loop" · MyPage',
      '@alice would love your eyes on this'],
    ['proposal_vote', CONTEXT,
      '@alice voted yes on "Fix login redirect loop" · MyPage',
      'Open the proposal to review their vote'],
    ['pr_merged', CONTEXT,
      '"Fix login redirect loop" merged · MyPage',
      'The vote carried. Your change is live'],
    ['issue_opened', { ...CONTEXT, detail: '2273' },
      '@alice filed issue #2273 · MyPage',
      'Open the issue to see what needs attention'],
    ['vote_digest', { ...CONTEXT, detail: '3' },
      '3 proposals are waiting for your vote',
      'Open Dev to review them'],
    ['check_failed', CONTEXT,
      'Checks failed on "Fix login redirect loop" · MyPage',
      'Needs a fix before it can merge'],
    ['stale_pr', CONTEXT,
      '"Fix login redirect loop" is waiting for eyes · MyPage',
      'Share the preview or ask a friend to try it'],
  ];
  for (const [kind, context, title, body] of cases) {
    const message = buildMessage({ ...INPUT, kind, context });
    assert.deepEqual(message.notification, { title, body }, kind);
  }
});

test('auto-solve outcomes surface urgency in the title, next step in the body', () => {
  const cases = [
    ['spec', 'Auto-solve finished "Fix login redirect loop" · MyPage',
      'Spec ready. Review it in the app'],
    ['code', 'Auto-solve finished "Fix login redirect loop" · MyPage',
      "Code ready. Review and promote when you're happy"],
    ['spec_code', 'Auto-solve finished "Fix login redirect loop" · MyPage',
      "Spec and code ready. Review and promote when you're happy"],
    ['question', 'Auto-solve is waiting on you · MyPage',
      '"Fix login redirect loop" needs an answer before it can continue'],
    ['failed', 'Auto-solve hit a wall · MyPage',
      '"Fix login redirect loop" failed. Open the log to see what happened'],
  ];
  for (const [detail, title, body] of cases) {
    const message = buildMessage({
      ...INPUT, kind: 'auto_solve_done', context: { ...CONTEXT, detail },
    });
    assert.deepEqual(message.notification, { title, body }, detail);
  }
});

test('a stale proposal names how long it has been waiting when the promotion time is known', () => {
  const day = 24 * 60 * 60 * 1000;
  const bodyAfter = (ms) => buildMessage({
    ...INPUT, kind: 'stale_pr',
    context: { ...CONTEXT, promotedAt: new Date(Date.now() - ms) },
  }).notification.body;
  assert.equal(
    bodyAfter(3 * day + 60_000),
    'Nobody has weighed in for 3 days. Share the preview or ask a friend to try it'
  );
  assert.equal(
    bodyAfter(day + 60_000),
    'Nobody has weighed in for 1 day. Share the preview or ask a friend to try it'
  );
  // Under a day, or promoted_at missing entirely: the nudge stands alone.
  assert.equal(bodyAfter(60_000), 'Share the preview or ask a friend to try it');
});

test('machine-generated branch names never appear as a label', () => {
  const context = {
    ...CONTEXT, sessionTitle: null, prTitle: null, branchName: 'dev/evan-1786562509265',
  };
  assert.equal(
    buildMessage({ ...INPUT, kind: 'pr_proposed', context }).notification.title,
    '@alice proposed a change · MyPage'
  );
  // A human-named branch still earns the label slot.
  assert.equal(
    buildMessage({
      ...INPUT, kind: 'pr_proposed', context: { ...context, branchName: 'fix-header-contrast' },
    }).notification.title,
    '@alice proposed "fix-header-contrast" · MyPage'
  );
});

test('a mention with no message text still locates the conversation', () => {
  // The label already anchors the title, so the body is simply omitted.
  assert.deepEqual(
    buildMessage({
      ...INPUT, kind: 'mention', context: { ...CONTEXT, messageContent: null },
    }).notification,
    { title: '@alice mentioned you in "Fix login redirect loop" · MyPage' }
  );
  // No label either: the copy falls back to the plain form.
  assert.deepEqual(
    buildMessage({
      ...INPUT, kind: 'mention',
      context: { ...CONTEXT, messageContent: null, sessionTitle: null },
    }).notification,
    { title: '@alice mentioned you · MyPage' }
  );
});

test('titles and bodies are sanitized, collapsed, and truncated', () => {
  const message = buildMessage({
    ...INPUT,
    kind: 'mention',
    context: {
      ...CONTEXT,
      appName: 'A'.repeat(200),
      messageContent: `line one\n\n  ${'x'.repeat(300)}`,
    },
  });
  assert.equal(message.notification.title.length, 80);
  assert.ok(message.notification.title.endsWith('…'));
  assert.equal(message.notification.body.length, 140);
  assert.ok(message.notification.body.startsWith('line one x'));
  assert.ok(message.notification.body.endsWith('…'));
  assert.doesNotMatch(message.notification.body, /\n/);

  const embedded = buildMessage({
    ...INPUT,
    kind: 'pr_proposed',
    context: { ...CONTEXT, sessionTitle: null, prTitle: 'p'.repeat(200) },
  });
  assert.ok(embedded.notification.title.includes('…'));
  assert.ok(embedded.notification.title.length <= 80);
  // Title-embedded labels get a tighter cap than body embeds, so the app
  // suffix survives instead of being eaten by the 80-char truncation.
  assert.ok(embedded.notification.title.endsWith(' · MyPage'));
});

test('missing context degrades to the generic notification, never a throw', () => {
  for (const context of [undefined, {}, { appName: 42, sourceUsername: {} }]) {
    const message = buildMessage({ ...INPUT, kind: 'mention', context });
    assert.deepEqual(message.notification, {
      title: 'Homeroom', body: 'You have new activity',
    });
  }
  // System kinds keep their kind-specific title even without app/session data.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'session_done', context: {} }).notification,
    { title: 'Your build is ready' }
  );
  // #3181: a stalled session still says what happened and what to do.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'session_stalled', context: {} }).notification,
    { title: 'Your session stopped before finishing', body: 'Open it to continue' }
  );
  // The new system-owned kinds can still identify the event without an
  // actor, app or proposal label, so they never regress to generic activity.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'pr_merged', context: {} }).notification,
    { title: 'Your proposal merged', body: 'The vote carried. Your change is live' }
  );
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'vote_digest', context: {} }).notification,
    { title: 'Proposals are waiting for your vote', body: 'Open Dev to review them' }
  );
});

test('context never leaks into the data payload', () => {
  const message = buildMessage({ ...INPUT, kind: 'mention', context: CONTEXT });
  assert.doesNotMatch(JSON.stringify(message.data), /alice|MyPage|header/);
});

test('provider errors distinguish dead tokens from retryable transport failures', () => {
  assert.equal(
    classifyError({ code: 'messaging/registration-token-not-registered' }).action,
    'drop_registration'
  );
  assert.equal(
    classifyError({ code: 'messaging/mismatched-credential' }).action,
    'drop_registration'
  );
  assert.equal(classifyError({ code: 'messaging/server-unavailable' }).action, 'retry');
  assert.deepEqual(classifyError({ code: 'messaging/invalid-payload' }), {
    action: 'dead', code: 'invalid_application_payload',
  });
});

test('enabled delivery requires a matching Firebase project and explicit environment', () => {
  const account = {
    project_id: 'social-prod', client_email: 'firebase@example.test', private_key: 'pem',
  };
  const encoded = Buffer.from(JSON.stringify(account)).toString('base64');
  assert.equal(parseServiceAccount(encoded, 'social-prod').project_id, 'social-prod');
  assert.throws(() => parseServiceAccount(encoded, 'other'), /another project/);
  assert.throws(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: '',
  }), /PUSH_ENV/);
  assert.doesNotThrow(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: 'production',
    firebaseProjectId: 'social-prod',
    firebaseServiceAccountJsonB64: encoded,
  }));
});

test('test alert uses explicit copy with the normal opaque push envelope', () => {
  const message = buildMessage({ ...INPUT, kind: 'test_alert' });
  assert.deepEqual(message.notification, {
    title: 'Homeroom test alert',
    body: 'Your phone can receive push notifications from Homeroom.',
  });
  assert.equal(message.data.notification_id, '42');
  assert.equal(message.android.notification.channelId, 'social_activity');
});

test('app health alerts say what happened and what to do (#2253, #2273)', () => {
  // The storage cap and deploy-failure tokens all produce contextual copy.
  // Unknown future tokens still identify the app and direct the recipient to
  // the durable detail instead of degrading to generic activity.
  const warn = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_warn' },
  });
  assert.deepEqual(warn.notification, {
    title: 'Storage is nearly full · MyPage',
    body: 'MyPage has used most of its storage. Clean up old data or ask an admin to raise the limit',
  });
  const full = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_full' },
  });
  assert.deepEqual(full.notification, {
    title: 'Out of storage · MyPage',
    body: 'New data cannot be saved until an admin raises the limit or allows time to clean up',
  });
  const deploy = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'deploy_failed' },
  });
  assert.deepEqual(deploy.notification, {
    title: 'Deploy failed · MyPage',
    body: 'The latest change did not go live. Open the app to see what failed',
  });
  const other = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'future_token' },
  });
  assert.deepEqual(other.notification, {
    title: 'App needs attention · MyPage',
    body: 'Open the app to see what needs attention',
  });
});

test('platform limit alerts name the cap, how full it is, and the lever', () => {
  // Full admins only, and no app: the title carries no " · App" suffix.
  const copy = (detail) => buildMessage({
    ...INPUT, kind: 'platform_limit', context: { detail },
  }).notification;
  assert.deepEqual(copy('apps_warn:40:50'), {
    title: 'Nearing the app limit',
    body: '40 of 50 apps are in use. Raise MAX_APPS in Platform variables before new apps are refused',
  });
  assert.deepEqual(copy('apps_full:50:50'), {
    title: 'App limit reached',
    body: '50 of 50 apps are in use. New apps are refused until an admin raises MAX_APPS or removes one',
  });
  assert.deepEqual(copy('sessions_warn:60:75'), {
    title: 'Nearing the session limit',
    body: '60 of 75 coding sessions are running. At the limit, idle sessions are paused to make room',
  });
  assert.equal(copy('sessions_full:75:75').title, 'Session limit reached');
  assert.match(copy('sessions_full:75:75').body, /MAX_GLOBAL_SESSIONS/);
  // An unreadable token still says what kind of alert it is.
  assert.equal(copy('disk_warn:1:2').title, 'Platform limit');
  assert.equal(copy(undefined).title, 'Platform limit');
});

test('#2386: a friend request and its acceptance name the person and what to do', () => {
  const request = buildMessage({ ...INPUT, kind: 'friend_request', context: { sourceUsername: 'lin' } });
  assert.deepEqual(request.notification, {
    title: '@lin sent you a friend request',
    body: 'Accept or decline in Notifications',
  });
  const accepted = buildMessage({ ...INPUT, kind: 'friend_accept', context: { sourceUsername: 'ada' } });
  assert.equal(accepted.notification.title, '@ada accepted your friend request');
  assert.match(accepted.notification.body, /friends now/);
  // No app and no conversation ride along, so nothing is appended.
  assert.doesNotMatch(request.notification.title, / · /);
  // Without the person there is nothing true to say: the generic copy.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'friend_request', context: {} }).notification,
    { title: 'Homeroom', body: 'You have new activity' },
  );
  // The opaque data payload is unchanged by the kind.
  assert.equal(request.data.notification_id, '42');
  assert.equal(Object.keys(request.data).includes('source_username'), false);
});
