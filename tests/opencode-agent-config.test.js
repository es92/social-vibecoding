'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = require('../src/cli/main');
const policy = require('../.agents/hooks/promotion-policy');
const createOpenCodePromotionGuard = require('../.agents/hooks/opencode-promotion-guard');

const root = path.resolve(__dirname, '..');
const pluginLink = path.join(root, '.opencode', 'plugins', 'promotion-approval.js');
const canonicalPlugin = path.join(
  root,
  '.agents',
  'hooks',
  'opencode-promotion-approval.js'
);

function generatedConfig(profile = 'production') {
  const document = main.setupOpenCodeJsonc({
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    profile,
  });
  return {
    document,
    config: JSON.parse(document.slice(main.OPENCODE_GENERATED_HEADER.length)),
  };
}

test('OpenCode reuses the canonical promotion guard through a relative symlink', () => {
  assert.equal(
    fs.readlinkSync(pluginLink),
    '../../.agents/hooks/opencode-promotion-approval.js'
  );
  assert.equal(fs.realpathSync(pluginLink), canonicalPlugin);
  assert.equal(typeof createOpenCodePromotionGuard, 'function');
  assert.equal(
    fs.existsSync(path.join(root, '.opencode', 'skills')),
    false,
    'OpenCode discovers .agents/skills natively; a duplicate skill source would create collisions'
  );
});

test('OpenCode setup contains one credential-free MCP server and reviewed tool policy', () => {
  const { document, config } = generatedConfig('lab');
  assert.ok(document.startsWith(`${main.OPENCODE_GENERATED_HEADER}\n`));
  assert.deepEqual(config.mcp, {
    social_vibecoding: {
      type: 'local',
      command: [
        '/usr/bin/node',
        '/checkout/tools/social-vibecoding',
        'mcp',
        '--profile',
        'lab',
      ],
      enabled: true,
    },
  });

  const permissionEntries = Object.entries(config.permission);
  assert.deepEqual(permissionEntries[0], ['social_vibecoding_*', 'deny']);
  for (const suffix of policy.OPENCODE_REVIEWED_TOOL_SUFFIXES) {
    assert.equal(
      config.permission[policy.OPENCODE_REVIEWED_TOOLS[suffix]],
      suffix === 'proposal_promote' ? 'ask' : 'allow'
    );
  }
  assert.equal(permissionEntries.length, policy.OPENCODE_REVIEWED_TOOL_SUFFIXES.length + 1);
  assert.doesNotMatch(document, /bearer|SOCIAL_VIBECODING_TOKEN|https?:\/\/api\./i);
});

test('OpenCode promotion guard attests each model request and fails closed without approval config', async () => {
  const hooks = await createOpenCodePromotionGuard({ worktree: root, directory: root });
  const system = ['base system prompt'];
  await hooks['experimental.chat.system.transform'](
    { sessionID: 'session-1' },
    { system }
  );
  assert.equal(system.length, 1, 'the guard does not add a provider-incompatible second system message');
  assert.match(system[0], /Homeroom promotion guard health check: PASS/);
  assert.match(system[0], /OpenCode plugin executed for this model request/);

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: policy.OPENCODE_REVIEWED_TOOLS.proposal_promote },
      { args: { session_id: 2969 } }
    ),
    /manual approval is not configured/
  );

  const { config } = generatedConfig();
  await hooks.config(config);
  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: policy.OPENCODE_REVIEWED_TOOLS.proposal_promote },
      { args: { session_id: 2969 } }
    )
  );
});

test('OpenCode promotion guard blocks generic API and raw-shell substitutes', async () => {
  const hooks = await createOpenCodePromotionGuard({ worktree: root, directory: root });
  const { config } = generatedConfig();
  await hooks.config(config);

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: policy.OPENCODE_REVIEWED_TOOLS.api_write },
      { args: { method: 'post', path: '/api/sessions/2969/ProMoTe/', body: {} } }
    ),
    /dedicated proposal_promote tool/
  );
  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'bash' },
      { args: { command: 'curl -X POST https://example.com/api/sessions/2969/promote' } }
    ),
    /Raw proposal promotion is blocked/
  );
  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: policy.OPENCODE_REVIEWED_TOOLS.api_write },
      { args: { method: 'POST', path: '/api/apps/demo/messages', body: {} } }
    )
  );
  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: 'bash' },
      { args: { command: 'npm test' } }
    )
  );
});
