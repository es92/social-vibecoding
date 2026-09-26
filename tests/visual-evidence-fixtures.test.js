'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../src/services/visual-evidence-fixtures');

test('evidence identities and rows cannot be created, inspected, or copied outside the run database', async () => {
  const input = {
    databaseUrl: 'postgres://usernode:localdev@127.0.0.1:5440/usernode',
    slug: 'usernode-2d5619', runId: '1'.repeat(32), side: 'base',
    selfAppSlug: 'usernode-2d5619',
  };
  await assert.rejects(fixtures.ensureFullAdminIdentity(input), /isolated evidence database/);
  await assert.rejects(fixtures.canCopyMemberAgentSession(input), /isolated evidence database/);
  await assert.rejects(fixtures.copyMemberAgentSession(input), /isolated evidence database/);
});
