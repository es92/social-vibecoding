'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');
const fixtures = require('../src/services/visual-evidence-fixtures');
const identities = require('../src/services/visual-evidence-identities');

test('full-admin evidence token names only the identity installed in disposable clones', async () => {
  const original = visuals.mintCaptureToken;
  const queries = [];
  visuals.mintCaptureToken = (user, appId) => `${appId}:${user.id}:${user.username}`;
  try {
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [
          { id: 10, username: visuals.CAPTURE_USERNAME },
          {
            id: 11, username: visuals.CAPTURE_ADMIN_USERNAME,
            is_admin: true, admin_readonly: true,
          },
        ] };
      },
    };
    const tokens = await identities.mintEvidenceAuthTokens(pool, 42);
    assert.equal(tokens.member, `42:10:${visuals.CAPTURE_USERNAME}`);
    assert.equal(tokens.read_only_admin, `42:11:${visuals.CAPTURE_ADMIN_USERNAME}`);
    assert.equal(tokens.full_admin,
      `42:${fixtures.FULL_ADMIN_USER_ID}:${fixtures.FULL_ADMIN_USERNAME}`);
    assert.deepEqual(queries[0].params[0], [visuals.CAPTURE_USERNAME, visuals.CAPTURE_ADMIN_USERNAME]);
  } finally {
    visuals.mintCaptureToken = original;
  }
});
