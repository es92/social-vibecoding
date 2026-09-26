#!/usr/bin/env node
'use strict';

// Image-build smoke test for the exact browser MCP command and flags used by
// evidence turns. Listing tools catches a missing MCP binary; calling a
// browser tool also catches Chromium startup failures in the worker image.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close',
];

function verifyBrowser(server, navigationChecks = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let settled = false;
    let tools;
    let phase = 'tools/list';
    const finish = (error, tools) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(tools);
    };
    const timeout = setTimeout(() => finish(new Error(`Browser MCP ${phase} timed out after 60 seconds: ${errors.slice(-500)}`)), 60_000);
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => finish(new Error(`Browser MCP exited during ${phase} (${code ?? signal}): ${errors.slice(-1000)}`)));
    child.stdin.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) return finish(new Error('Browser MCP output exceeded the smoke-test limit.'));
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2) {
          if (message.error) return finish(new Error(`Browser MCP tools/list failed: ${JSON.stringify(message.error).slice(0, 500)}`));
          tools = message.result?.tools || [];
          const names = new Set(tools.map((tool) => tool.name));
          const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
          if (missing.length) return finish(new Error(`Browser MCP is missing tools: ${missing.join(', ')}`));
          phase = 'browser_tabs';
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
            name: 'browser_tabs', arguments: { action: 'list' },
          } })}\n`);
        } else if (message.id === 3) {
          if (message.error || message.result?.isError) {
            return finish(new Error(`Browser MCP browser_tabs failed: ${JSON.stringify(message.error || message.result).slice(0, 1200)}; stderr: ${errors.slice(-500)}`));
          }
          const response = (message.result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
          if (!response.includes('Open tabs')) {
            return finish(new Error(`Browser MCP browser_tabs returned no tab listing: ${response.slice(0, 500)}`));
          }
          phase = 'browser_mouse_move_xy';
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
            name: 'browser_mouse_move_xy', arguments: { element: 'browser viewport', x: 10, y: 10 },
          } })}\n`);
        } else if (message.id === 4) {
          if (message.error || message.result?.isError) {
            return finish(new Error(`Browser MCP coordinate hover failed: ${JSON.stringify(message.error || message.result).slice(0, 1200)}`));
          }
          if (navigationChecks.length) {
            phase = 'browser_navigate';
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
              name: 'browser_navigate', arguments: { url: navigationChecks[0].url },
            } })}\n`);
          } else return finish(null, tools);
        } else if (message.id >= 5 && message.id < 5 + navigationChecks.length) {
          const index = message.id - 5;
          const response = (message.result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
          if (message.error || message.result?.isError || !response.includes(navigationChecks[index].expectedText)
              || (navigationChecks[index].iframeText && !response.includes(navigationChecks[index].iframeText))) {
            return finish(new Error(`Browser MCP ${phase} did not load its authenticated state: ${response.slice(0, 500)}`));
          }
          const next = navigationChecks[index + 1];
          if (!next) return finish(null, tools);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id + 1, method: 'tools/call', params: {
            name: 'browser_navigate', arguments: { url: next.url },
          } })}\n`);
        }
      }
    });
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'evidence-image-smoke', version: '1' },
      } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-mcp-smoke-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir);
    for (const persona of ['member', 'read_only_admin', 'full_admin']) {
      fs.writeFileSync(path.join(stateDir, `${persona}.json`), '{"cookies":[],"origins":[]}');
    }
    const output = path.join(dir, 'mcp.json');
    const hostedFile = path.join(stateDir, 'hosted-origins.json');
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid',
      headOrigin: 'http://head.example.invalid', apps: [],
    }));
    const diagnosticFile = path.join(dir, 'browser-diagnostics.log');
    fs.writeFileSync(diagnosticFile, '');
    execFileSync(process.execPath, [path.join(__dirname, 'write-evidence-mcp-config.js'), output], {
      env: {
        ...process.env,
        EVIDENCE_BROWSER_STATE_DIR: stateDir,
        EVIDENCE_BROWSER_DIAGNOSTIC_FILE: diagnosticFile,
        EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
        EVIDENCE_BASE_ORIGIN: 'http://base.example.invalid',
        EVIDENCE_HEAD_ORIGIN: 'http://head.example.invalid',
        EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
      },
    });
    const config = JSON.parse(fs.readFileSync(output, 'utf8'));
    for (const persona of ['browser_member', 'browser_admin', 'browser_full_admin']) {
      fs.writeFileSync(diagnosticFile, '');
      const tools = await verifyBrowser(config.mcpServers[persona]);
      const records = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n')
        .filter((line) => line.startsWith('__USERNODE_EVIDENCE_BROWSER__ '))
        .flatMap((line) => {
          try { return [JSON.parse(line.slice('__USERNODE_EVIDENCE_BROWSER__ '.length))]; }
          catch { return []; }
        })
        .filter((event) => event.persona === (persona === 'browser_admin' ? 'admin'
          : persona === 'browser_full_admin' ? 'full_admin' : 'member'));
      if (!records.some((event) => event.kind === 'browser_call_start')
          || !records.some((event) => event.kind === 'browser_call_end')) {
        throw new Error(`Browser observer did not record ${persona} tool timing`);
      }
      process.stdout.write(`${persona}: ${tools.length} MCP tools available; Chromium opened a tab\n`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { verifyBrowser };
