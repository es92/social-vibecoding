#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { browserAllowedOrigins } = require('./evidence-hosted-origins');

const output = process.argv[2];
const stateDir = process.env.EVIDENCE_BROWSER_STATE_DIR;
const proxy = process.env.EVIDENCE_PROXY_SERVER;
const hostedFile = process.env.EVIDENCE_HOSTED_ORIGINS_FILE;
if (!output || !stateDir || !proxy || !hostedFile) {
  throw new Error('Evidence MCP config inputs are incomplete.');
}
const baseOrigin = new URL(process.env.EVIDENCE_BASE_ORIGIN).origin;
const headOrigin = new URL(process.env.EVIDENCE_HEAD_ORIGIN).origin;
const origins = browserAllowedOrigins(baseOrigin, headOrigin, hostedFile);
const browserArgs = (persona) => [
  '/usr/local/bin/evidence-browser-observer.js',
  persona === 'read_only_admin' ? 'admin' : persona,
  '--browser', 'chromium', '--headless', '--isolated', '--no-sandbox', '--caps', 'vision',
  '--storage-state', path.join(stateDir, `${persona}.json`),
  '--allowed-origins', origins.join(';'),
  '--block-service-workers', '--image-responses', 'allow',
  '--proxy-server', proxy,
  '--timeout-action', '10000', '--timeout-navigation', '30000',
];
const browserEnv = {
  EVIDENCE_ALLOWED_ORIGINS: JSON.stringify([baseOrigin, headOrigin]),
  EVIDENCE_BROWSER_DIAGNOSTIC_FILE: process.env.EVIDENCE_BROWSER_DIAGNOSTIC_FILE || '',
  EVIDENCE_NAVIGATION_HINTS: process.env.EVIDENCE_NAVIGATION_HINTS || '{}',
};
const config = {
  mcpServers: {
    evidence: { command: 'node', args: ['/usr/local/bin/evidence-mcp.js'] },
    browser_member: { command: 'node', args: browserArgs('member'), env: browserEnv },
    browser_admin: { command: 'node', args: browserArgs('read_only_admin'), env: browserEnv },
    browser_full_admin: { command: 'node', args: browserArgs('full_admin'), env: browserEnv },
  },
};
fs.writeFileSync(output, `${JSON.stringify(config)}\n`, { mode: 0o600 });
