'use strict';

// The storage-independent half of sealed one-use confirmations
// (services/confirmations), used by agent sessions since #2779. This pins
// the rules every consumer relies on, so a second consumer cannot quietly get
// a weaker copy of them.
//
// Run with: node --test tests/confirmations-core.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const confirmations = require('../src/services/confirmations');

const KEY = 'test-only-data-key';

test('tokens are 32 random bytes, and only their hash is kept', () => {
  const a = confirmations.mintToken();
  const b = confirmations.mintToken();
  assert.match(a.token, confirmations.TOKEN_RE);
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, confirmations.sha256(a.token));
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => confirmations.assertTokenShape(a.token));
  for (const bad of ['', 'short', `${a.token}x`, null, 42, 'a'.repeat(42) + '!']) {
    assert.throws(() => confirmations.assertTokenShape(bad), { code: 'invalid_or_expired_action' });
  }
});

test('the input is normalized, so key order cannot change what runs', () => {
  assert.equal(
    confirmations.normalizedJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }),
    '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}'
  );
  const big = { blob: 'x'.repeat(confirmations.MAX_INPUT_BYTES) };
  assert.throws(() => confirmations.normalizedJson(big), { code: 'invalid_action' });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => confirmations.normalizedJson(cyclic), { code: 'invalid_action' });
});

test('a sealed action opens to exactly its input, and refuses anything altered', () => {
  const input = { slug: 'recipe-box', title: 'Dark mode', linkedIssues: [12] };
  const { sealed, inputHash } = confirmations.sealAction(input, KEY);
  assert.equal(sealed.version, 1);
  assert.ok(!JSON.stringify(sealed).includes('Dark mode'), 'the stored copy is ciphertext');
  const opened = confirmations.openAction(sealed, inputHash, KEY);
  assert.deepEqual(opened.input, input);

  assert.throws(() => confirmations.openAction(sealed, confirmations.sha256('{}'), KEY),
    { code: 'invalid_action' }, 'a fingerprint for other input is refused');
  const tampered = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -4)}AAAA` };
  assert.throws(() => confirmations.openAction(tampered, inputHash, KEY), { code: 'invalid_action' });
  assert.throws(() => confirmations.openAction(sealed, inputHash, 'another-key'), { code: 'invalid_action' });
  assert.throws(() => confirmations.sealAction(input, null), { code: 'invalid_action' });
  assert.throws(() => confirmations.openAction(sealed, inputHash, null), { code: 'invalid_action' });
});

test('a confirmation expires, by default in five minutes and never after fifteen', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const at = (ttl) => confirmations.expiryFor(now, ttl).expiresAt.toISOString();
  assert.equal(at(undefined), '2026-09-23T12:05:00.000Z');
  assert.equal(at(60_000), '2026-09-23T12:01:00.000Z');
  assert.equal(at(24 * 60 * 60 * 1000), '2026-09-23T12:15:00.000Z');
  assert.equal(at(1), '2026-09-23T12:00:01.000Z', 'at least one second');
  assert.throws(() => confirmations.expiryFor('not a date'), { code: 'invalid_action' });
});

test('an object revision is a bounded printable string, or none', () => {
  assert.equal(confirmations.normalizedRevision(null), null);
  assert.equal(confirmations.normalizedRevision(undefined), null);
  assert.equal(confirmations.normalizedRevision(4), '4');
  for (const bad of ['', 'x'.repeat(256), 'a\nb']) {
    assert.throws(() => confirmations.normalizedRevision(bad), { code: 'invalid_action' });
  }
});

