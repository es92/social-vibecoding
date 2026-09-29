const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');

const VISUAL_FLAGS = [
  'VISUAL_EVIDENCE_V2_ENABLED',
  'VISUAL_EVIDENCE_V2_COLLECT',
  'VISUAL_EVIDENCE_V2_EXECUTE',
  'VISUAL_EVIDENCE_V2_PRESENT',
  'VISUAL_EVIDENCE_V2_ENFORCE',
  'VISUAL_EVIDENCE_V2_LEGACY_CAPTURE',
];
const VISUAL_BUDGETS = [
  'VISUAL_EVIDENCE_MAX_RUN_MS',
  'VISUAL_EVIDENCE_MAX_AGENT_MS',
];

function loadVisualConfig(overrides = {}) {
  const required = {
    USERNODE_ENV: 'staging',
    DATABASE_URL: 'postgres://localhost/test',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
  };
  const keys = new Set([...Object.keys(required), ...VISUAL_FLAGS, ...VISUAL_BUDGETS]);
  const saved = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of [...VISUAL_FLAGS, ...VISUAL_BUDGETS]) delete process.env[key];
  Object.assign(process.env, required, overrides);
  const realLog = console.log;
  console.log = () => {};
  try {
    return config.load().visualEvidence;
  } finally {
    console.log = realLog;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('visual evidence collection, execution, and presentation are advisory and on by default', () => {
  const visual = loadVisualConfig();
  assert.deepEqual({
    enabled: visual.enabled,
    collect: visual.collect,
    execute: visual.execute,
    present: visual.present,
    enforce: visual.enforce,
  }, {
    enabled: true,
    collect: true,
    execute: true,
    present: true,
    enforce: false,
  });
});

test('the preview agent gets eight minutes and the run/recovery budget stays aligned', () => {
  const visual = loadVisualConfig();
  assert.equal(visual.maxAgentMs, 480_000);
  assert.equal(visual.maxRepairAgentMs, undefined);
  assert.equal(visual.maxRunMs, 1_440_000);
  const override = loadVisualConfig({ VISUAL_EVIDENCE_MAX_AGENT_MS: '300000' });
  assert.equal(override.maxAgentMs, 300_000);
});

test('one emergency switch disables the mechanism and legacy activation flags are ignored', () => {
  const visual = loadVisualConfig({
    VISUAL_EVIDENCE_V2_ENABLED: 'false',
    VISUAL_EVIDENCE_V2_COLLECT: 'true',
    VISUAL_EVIDENCE_V2_EXECUTE: 'true',
    VISUAL_EVIDENCE_V2_PRESENT: 'true',
    VISUAL_EVIDENCE_V2_ENFORCE: 'true',
    VISUAL_EVIDENCE_V2_LEGACY_CAPTURE: 'true',
  });
  assert.deepEqual({
    enabled: visual.enabled,
    collect: visual.collect,
    execute: visual.execute,
    present: visual.present,
    enforce: visual.enforce,
    legacyCapture: visual.legacyCapture,
  }, {
    enabled: false,
    collect: false,
    execute: false,
    present: false,
    enforce: false,
    legacyCapture: undefined,
  });
});

test('deployment documentation exposes only the default-on emergency switch', () => {
  const root = path.join(__dirname, '..');
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(example, /VISUAL_EVIDENCE_V2_ENABLED=true/);
  assert.match(workflow, /VISUAL_EVIDENCE_V2_ENABLED=\$\{\{ vars\.VISUAL_EVIDENCE_V2_ENABLED \|\| 'true' \}\}/);
  for (const retired of VISUAL_FLAGS.slice(1)) {
    assert.doesNotMatch(example, new RegExp(retired));
    assert.doesNotMatch(workflow, new RegExp(retired));
  }
});
