'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { encrypt } = require('../src/services/secrets');
const {
  MobilePushWorker,
  retryDelayMs,
} = require('../src/services/mobile-push-worker');

const DATA_KEY = 'mobile-push-worker-test-key';
const JOB = { id: 9, attempts: 1 };

function delivery(overrides = {}) {
  return {
    id: 9,
    attempts: 1,
    expires_at: new Date(Date.now() + 60_000),
    delivery_created_at: new Date(Date.now() - 1000),
    notification_id: 42,
    notification_user_id: 7,
    kind: 'session_done',
    read_at: null,
    push_category: 'developer_sessions',
    push_enabled: true,
    registration_id: 3,
    delivery_environment: 'production',
    delivery_installation_id: '123e4567-e89b-12d3-a456-426614174000',
    deployment_send_enabled: true,
    deployment_send_not_before: new Date(Date.now() - 2000),
    deployment_firebase_project_id: 'social-prod',
    installation_id: '123e4567-e89b-12d3-a456-426614174000',
    registration_environment: 'production',
    registration_platform: 'android',
    registration_hash: 'a'.repeat(64),
    registration_enc: encrypt('opaque-fcm-token', DATA_KEY),
    permission_status: 'authorized',
    registration_user_id: 7,
    registration_session_expires_at: new Date(Date.now() + 60_000),
    app_name: 'MyPage',
    conversation_id: null,
    conversation_title: null,
    conversation_status: null,
    conversation_message_content: null,
    conversation_member_status: null,
    source_username: null,
    message_content: null,
    session_title: 'Fix login redirect loop',
    pr_title: null,
    branch_name: null,
    detail: null,
    ...overrides,
  };
}

function harness({
  row = delivery(),
  send = async () => 'provider-id',
  deleteRowCount = 1,
  registrationExists = true,
  unreadCount = 3,
  unreadCountError = null,
} = {}) {
  const calls = { sent: [], finished: [], deleted: [], events: [], unreadCounts: [] };
  const pool = {
    async query(sql, params) {
      // countUnread (src/services/notifications.js) — the #1445 icon badge.
      if (sql.includes('FROM notifications AS n')) {
        calls.unreadCounts.push(params[0]);
        if (unreadCountError) throw unreadCountError;
        return { rows: [{ c: unreadCount }] };
      }
      if (sql.includes('DELETE FROM mobile_push_registrations')
          && sql.includes('INSERT INTO mobile_push_registration_events')) {
        calls.deleted.push({
          id: params[0],
          registrationHash: params[1],
          registrationEnc: params[2],
        });
        if (deleteRowCount === 1) {
          calls.events.push({ eventKind: params[3], reasonCode: params[4] });
        }
        return { rows: [], rowCount: deleteRowCount };
      }
      if (sql.startsWith('SELECT 1 FROM mobile_push_registrations')) {
        return { rows: registrationExists ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnabled: true,
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
      dataEncryptionKey: DATA_KEY,
    },
    provider: { send: async (message) => { calls.sent.push(message); return send(message); } },
    options: { sendTimeoutMs: 100 },
  });
  worker.loadDelivery = async () => row;
  worker.finish = async (job, status, code, availableAt) => {
    calls.finished.push({ job, status, code: code || null, availableAt: availableAt || null });
  };
  return { worker, calls };
}

test('eligible delivery sends one contextual bound message and marks it sent', async () => {
  const { worker, calls } = harness();
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.finished, [{ job: JOB, status: 'sent', code: null, availableAt: null }]);
  assert.equal(calls.sent[0].data.notification_id, '42');
  assert.equal(calls.sent[0].data.environment, 'production');
  assert.deepEqual(calls.sent[0].notification, {
    title: 'Your build is ready · MyPage',
    body: '"Fix login redirect loop" finished. Review it while it\'s fresh',
  });
});

test('the recipient unread total rides on the message as the icon badge', async () => {
  // #1445: countUnread runs per send, for the notification's recipient,
  // and lands as aps.badge (iOS) + notificationCount (Android launchers).
  const { worker, calls } = harness({ unreadCount: 6 });
  await worker.processDelivery(JOB);
  assert.deepEqual(calls.unreadCounts, [7],
    'counted once, for notification_user_id');
  assert.equal(calls.sent[0].apns.payload.aps.badge, 6);
  assert.equal(calls.sent[0].android.notification.notificationCount, 6);
});

test('a raced-to-zero unread count still badges 1 for the alert being sent', async () => {
  // invalidReason already cancelled read rows, so the delivered
  // notification is itself unread; an alert claiming badge 0 would lie.
  const { worker, calls } = harness({ unreadCount: 0 });
  await worker.processDelivery(JOB);
  assert.equal(calls.sent[0].apns.payload.aps.badge, 1);
  assert.equal(calls.sent[0].android.notification.notificationCount, 1);
});

test('an unread count failure sends the pre-badge payload, never a dead delivery', async () => {
  const { worker, calls } = harness({ unreadCountError: new Error('boom') });
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.equal('badge' in calls.sent[0].apns.payload.aps, false);
  assert.equal('notificationCount' in calls.sent[0].android.notification, false);
  assert.deepEqual(calls.finished, [{ job: JOB, status: 'sent', code: null, availableAt: null }]);
});

test('a delivery with no context fields still sends with the generic fallback', async () => {
  const { worker, calls } = harness({
    row: delivery({
      kind: 'mention',
      push_category: 'direct_interactions',
      app_name: null,
      source_username: null,
      message_content: null,
      session_title: null,
    }),
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0].notification, {
    title: 'Homeroom', body: 'You have new activity',
  });
});

test('conversation delivery uses conversation context and rechecks current membership', async () => {
  const row = delivery({
    kind: 'conversation_mention',
    push_category: 'messages',
    conversation_id: 81,
    conversation_title: 'Design crew',
    conversation_status: 'active',
    conversation_message_content: 'please review the latest mock',
    conversation_member_status: 'member',
    source_username: 'alice',
    app_name: 'must-not-render',
    message_content: 'must-not-render',
  });
  let result = harness({ row });
  await result.worker.processDelivery(JOB);
  assert.deepEqual(result.calls.sent[0].notification, {
    title: '@alice mentioned you · Design crew',
    body: 'please review the latest mock',
  });
  assert.doesNotMatch(JSON.stringify(result.calls.sent[0]), /must-not-render/);

  for (const change of [
    { conversation_member_status: 'invited' },
    { conversation_member_status: null },
    { conversation_id: null },
    { conversation_status: 'archived' },
  ]) {
    result = harness({ row: delivery({ ...row, ...change }) });
    await result.worker.processDelivery(JOB);
    assert.equal(result.calls.sent.length, 0);
    assert.equal(result.calls.finished[0].code, 'conversation_access_revoked');
  }

  result = harness({ row: delivery({
    ...row, kind: 'conversation_invite', conversation_member_status: 'invited',
  }) });
  await result.worker.processDelivery(JOB);
  assert.equal(result.calls.sent.length, 1, 'an invited recipient may receive only the invitation');

  result = harness({ row: delivery({ conversation_id: 81 }) });
  await result.worker.processDelivery(JOB);
  assert.equal(result.calls.sent.length, 0, 'legacy app kinds cannot carry conversation refs');
  assert.equal(result.calls.finished[0].code, 'conversation_access_revoked');
});

test('pre-send revalidation cancels ineligible recipient and deployment state', async () => {
  for (const [change, reason] of [
    [{ read_at: new Date() }, 'notification_read'],
    [{ kind: 'future_kind', push_category: null, push_enabled: false }, 'kind_not_allowed'],
    [{ push_enabled: false }, 'preference_disabled'],
    [{ delivery_environment: 'staging' }, 'environment_mismatch'],
    [{ deployment_send_enabled: false }, 'sender_disabled'],
    [{ deployment_send_enabled: null }, 'sender_disabled'],
    [{ deployment_firebase_project_id: 'other-project' }, 'firebase_project_mismatch'],
    [{ deployment_send_not_before: null }, 'activation_cutoff'],
    [{ deployment_send_not_before: new Date() }, 'activation_cutoff'],
    [{ registration_user_id: 8 }, 'recipient_mismatch'],
    [{ registration_session_expires_at: new Date(Date.now() - 1000) }, 'session_inactive'],
    [{ permission_status: 'denied' }, 'permission_ineligible'],
    [{ permission_status: 'not_determined' }, 'permission_ineligible'],
    [{ registration_id: null }, 'registration_missing'],
    [{ delivery_installation_id: '223e4567-e89b-12d3-a456-426614174999' }, 'installation_mismatch'],
    [{ expires_at: new Date(Date.now() - 1000) }, 'expired'],
  ]) {
    const { worker, calls } = harness({ row: delivery(change) });
    await worker.processDelivery(JOB);
    assert.equal(calls.sent.length, 0, reason);
    assert.equal(calls.finished[0].status, 'cancelled');
    assert.equal(calls.finished[0].code, reason);
  }
});

test('installation id comparison is case-insensitive, not a cancel', async () => {
  const { worker, calls } = harness({
    row: delivery({ delivery_installation_id: '123E4567-E89B-12D3-A456-426614174000' }),
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.finished[0].status, 'sent');
});

test('a hung provider send hits the deadline and retries as provider_timeout', async () => {
  const { worker, calls } = harness({ send: () => new Promise(() => {}) });
  await worker.processDelivery(JOB);
  assert.equal(calls.finished.length, 1);
  const [finished] = calls.finished;
  assert.equal(finished.status, 'pending', 'a timeout is retryable, not dead');
  assert.equal(finished.code, 'provider_timeout');
  assert.ok(finished.availableAt instanceof Date && finished.availableAt.getTime() > Date.now(),
    'the retry is deferred by the backoff delay');
});

test('the provider deadline keeps an otherwise-idle worker alive until it settles', () => {
  const modulePath = require.resolve('../src/services/mobile-push-worker');
  const script = [
    `const { deadline } = require(${JSON.stringify(modulePath)});`,
    "deadline(new Promise(() => {}), 20).catch((err) => process.stdout.write(err.code));",
  ].join(' ');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'provider_timeout',
    'the deadline timer must remain referenced while the provider is hung');
});

test('delivery reload includes the current deployment state and activation timestamps', async () => {
  let seen;
  const pool = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
    },
    provider: { send: async () => {} },
  });
  assert.equal(await worker.loadDelivery(JOB), null);
  assert.match(seen.sql, /d\.created_at AS delivery_created_at/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_deployment_state state/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_kind_categories policy/);
  assert.match(seen.sql, /LEFT JOIN mobile_push_preferences preference/);
  assert.match(seen.sql, /COALESCE\(preference\.enabled, policy\.default_enabled, FALSE\) AS push_enabled/);
  assert.match(seen.sql, /state\.send_enabled AS deployment_send_enabled/);
  assert.match(seen.sql, /state\.send_not_before AS deployment_send_not_before/);
  assert.match(seen.sql, /state\.firebase_project_id AS deployment_firebase_project_id/);
  assert.match(seen.sql, /r\.platform AS registration_platform/);
  // Send-time context for the contextual notification copy (#3289): the same
  // joins the in-app dropdown uses, all LEFT so a missing row can never make
  // an otherwise-valid delivery vanish.
  assert.match(seen.sql, /LEFT JOIN apps a ON a\.id = n\.app_id/);
  assert.match(seen.sql, /LEFT JOIN users su ON su\.id = n\.source_user_id/);
  assert.match(seen.sql, /LEFT JOIN chat_messages cm ON cm\.id = n\.chat_message_id/);
  assert.match(seen.sql, /LEFT JOIN chat_sessions cs ON cs\.id = n\.session_id/);
  assert.match(seen.sql, /LEFT JOIN conversations c ON c\.id = n\.conversation_id/);
  assert.match(seen.sql, /LEFT JOIN conversation_messages conversation_message/);
  assert.match(seen.sql, /LEFT JOIN conversation_members conversation_member/);
  assert.match(seen.sql, /a\.name AS app_name/);
  assert.match(seen.sql, /su\.username AS source_username/);
  assert.match(seen.sql, /cm\.content AS message_content/);
  assert.match(seen.sql, /c\.title AS conversation_title/);
  assert.match(seen.sql, /conversation_message\.content AS conversation_message_content/);
  assert.match(seen.sql, /cs\.session_title, cs\.pr_title, cs\.branch_name/);
  assert.match(seen.sql, /n\.detail/);
  assert.deepEqual(seen.params, [JOB.id]);
});

test('finish updates the in-process claim without a lease-generation fence', async () => {
  let seen;
  const worker = new MobilePushWorker({
    pool: {
      async query(sql, params) {
        seen = { sql, params };
        return { rows: [] };
      },
    },
    config: {},
    provider: { send: async () => {} },
  });
  await worker.finish(JOB, 'sent');
  assert.doesNotMatch(seen.sql, /attempts\s*=|lease_expires_at/);
  assert.match(seen.sql, /WHERE id = \$1 AND status = 'sending'/);
  assert.deepEqual(seen.params, [JOB.id, 'sent', null, true, null]);
});

test('invalid provider token deletes the live registration and kills this delivery', async () => {
  const err = Object.assign(new Error('provider rejected token'), {
    code: 'messaging/registration-token-not-registered',
  });
  const row = delivery();
  const { worker, calls } = harness({ row, send: async () => { throw err; } });
  await worker.processDelivery(JOB);
  assert.deepEqual(calls.deleted, [{
    id: row.registration_id,
    registrationHash: row.registration_hash,
    registrationEnc: row.registration_enc,
  }]);
  assert.equal(calls.finished[0].status, 'dead');
  assert.equal(calls.finished[0].code, err.code);
  assert.deepEqual(calls.events, [{
    eventKind: 'provider_invalidated', reasonCode: err.code,
  }]);
});

test('a refreshed registration survives a permanent result from a stale provider call', async () => {
  const err = Object.assign(new Error('provider rejected stale token'), {
    code: 'messaging/registration-token-not-registered',
  });
  const { worker, calls } = harness({
    send: async () => { throw err; },
    deleteRowCount: 0,
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.finished[0].status, 'pending');
  assert.equal(calls.finished[0].code, 'registration_refreshed');
  assert.ok(calls.finished[0].availableAt > new Date());
});

test('decrypt failures conditionally delete only the registration that was loaded', async () => {
  const stale = delivery({ registration_enc: 'corrupt-envelope' });
  const deleted = harness({ row: stale });
  await deleted.worker.processDelivery(JOB);
  assert.deepEqual(deleted.calls.deleted, [{
    id: stale.registration_id,
    registrationHash: stale.registration_hash,
    registrationEnc: stale.registration_enc,
  }]);
  assert.equal(deleted.calls.finished[0].status, 'dead');
  assert.equal(deleted.calls.finished[0].code, 'registration_decrypt_failed');
  assert.deepEqual(deleted.calls.events, [{
    eventKind: 'registration_corrupt', reasonCode: 'registration_decrypt_failed',
  }]);

  const refreshed = harness({ row: stale, deleteRowCount: 0 });
  await refreshed.worker.processDelivery(JOB);
  assert.equal(refreshed.calls.finished[0].status, 'pending');
  assert.equal(refreshed.calls.finished[0].code, 'registration_refreshed');
});

test('a concurrent invalidation preserves the permanent provider outcome', async () => {
  const err = Object.assign(new Error('provider rejected token'), {
    code: 'messaging/registration-token-not-registered',
  });
  const { worker, calls } = harness({
    send: async () => { throw err; },
    deleteRowCount: 0,
    registrationExists: false,
  });
  await worker.processDelivery(JOB);
  assert.equal(calls.finished[0].status, 'dead');
  assert.equal(calls.finished[0].code, err.code);
  assert.deepEqual(calls.events, [], 'the winning deletion records the shared event');
});

test('transient failures use bounded backoff and keep retrying until delivery expiry', async () => {
  const err = Object.assign(new Error('unavailable'), { code: 'messaging/server-unavailable' });
  const retry = harness({ send: async () => { throw err; } });
  await retry.worker.processDelivery(JOB);
  assert.equal(retry.calls.finished[0].status, 'pending');
  assert.equal(retry.calls.finished[0].code, err.code);
  assert.ok(retry.calls.finished[0].availableAt > new Date());

  const highAttemptJob = { id: 9, attempts: 50 };
  const highAttempt = harness({
    row: delivery({ attempts: 50, expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000) }),
    send: async () => { throw err; },
  });
  await highAttempt.worker.processDelivery(highAttemptJob);
  assert.equal(highAttempt.calls.finished[0].status, 'pending');
  assert.equal(retryDelayMs(1, 5000, 60 * 60 * 1000), 5000);
  assert.equal(retryDelayMs(2, 5000, 60 * 60 * 1000), 10000);
  assert.equal(retryDelayMs(50, 5000, 60 * 60 * 1000), 60 * 60 * 1000);
});

test('claim uses the current deployment and increments the retry count', async () => {
  let seen;
  const pool = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [{ id: 5, attempts: 2 }] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: {
      mobilePushEnabled: true,
      mobilePushEnvironment: 'production',
      firebaseProjectId: 'social-prod',
    },
    provider: { send: async () => {} },
  });
  assert.deepEqual(await worker.claimBatch(), [{ id: 5, attempts: 2 }]);
  assert.doesNotMatch(seen.sql, /SKIP LOCKED|lease_expires_at/);
  assert.match(seen.sql, /JOIN mobile_push_deployment_state/);
  assert.match(seen.sql, /send_enabled/);
  assert.match(seen.sql, /d\.created_at >= state\.send_not_before/);
  assert.match(seen.sql, /attempts = d\.attempts \+ 1/);
  assert.equal(seen.params[1], 'production');
  assert.equal(seen.params[2], 'social-prod');
  assert.equal(seen.params.length, 3);
});

test('maintenance resets interrupted work and performs bounded retention', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: { mobilePushEnabled: true, mobilePushEnvironment: 'production' },
    provider: { send: async () => {} },
    options: { retentionDays: 14, retentionBatchSize: 25 },
  });
  await worker.maintain();
  assert.equal(queries.length, 5);
  assert.doesNotMatch(queries[0].sql, /attempts\s*>=/);
  assert.doesNotMatch(queries[0].sql, /lease_expires_at/);
  assert.match(queries[0].sql, /status = 'sending'/);
  assert.equal(queries[0].params, undefined);
  assert.doesNotMatch(queries[1].sql, /mobile_auth_tokens/);
  assert.match(queries[1].sql, /r\.session_expires_at <= NOW\(\)/);
  assert.match(queries[1].sql, /ORDER BY r\.id LIMIT \$1/);
  assert.match(
    queries[1].sql,
    /DELETE FROM mobile_push_registrations r USING doomed\s+WHERE r\.id = doomed\.id\s+AND r\.session_expires_at <= NOW\(\)/
  );
  assert.match(queries[1].sql, /INSERT INTO mobile_push_registration_events/);
  assert.match(queries[1].sql, /'session_expired', 'mobile_session_expired'/);
  assert.deepEqual(queries[1].params, [25]);
  assert.match(queries[2].sql, /status IN \('sent', 'dead', 'cancelled'\)/);
  assert.match(queries[2].sql, /ORDER BY id LIMIT \$2/);
  assert.deepEqual(queries[2].params, [14, 25]);
  assert.match(queries[3].sql, /FROM mobile_push_installation_mutations/);
  assert.match(queries[3].sql, /NOT EXISTS/);
  assert.match(queries[3].sql, /FROM mobile_push_registrations/);
  assert.match(queries[3].sql, /m\.latest_mutation_revision = doomed\.latest_mutation_revision/);
  assert.match(queries[3].sql, /LIMIT \$2/);
  assert.deepEqual(queries[3].params, [14, 25]);
  assert.match(queries[4].sql, /FROM mobile_push_registration_events/);
  assert.match(queries[4].sql, /ORDER BY created_at, id/);
  assert.match(queries[4].sql, /DELETE FROM mobile_push_registration_events/);
  assert.deepEqual(queries[4].params, [14, 25]);
});

test('test pushes use the normal provider path and recheck opt-outs before sending', async () => {
  for (const enabled of [true, false]) {
    const { worker, calls } = harness({ row: delivery({
      kind: 'test_alert', app_name: null, session_title: null, push_enabled: enabled,
    }) });
    await worker.processDelivery(JOB);
    assert.equal(calls.sent.length, enabled ? 1 : 0);
    assert.equal(calls.finished[0].status, enabled ? 'sent' : 'cancelled');
    if (enabled) assert.equal(calls.sent[0].notification.title, 'Homeroom test alert');
    else assert.equal(calls.finished[0].code, 'preference_disabled');
  }
});
