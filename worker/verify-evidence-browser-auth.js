#!/usr/bin/env node
'use strict';

// Image-build regression: a production-mode self-app issues a Secure session
// cookie even though its private evidence origin is HTTP. Exercise the same
// bootstrap, saved storage state, proxy and MCP browser that the planner uses.
const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { hostedAppSlugs } = require('./evidence-hosted-origins');
const { promisify } = require('node:util');
const { verifyBrowser } = require('./verify-evidence-browser-mcp');

const execFileAsync = promisify(execFile);

function fixtureServer(side, hostedOrigin) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const persona = url.searchParams.get('token') === 'member.jwt' ? 'member'
      : url.searchParams.get('token') === 'admin.jwt' ? 'admin'
        : url.searchParams.get('token') === 'full-admin.jwt' ? 'full_admin' : null;
    if (persona) {
      response.setHeader('Set-Cookie', `session=${side}-${persona}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><h1>Token accepted</h1>');
      return;
    }
    const stored = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    const matched = stored === `${side}-member` ? 'member'
      : stored === `${side}-admin` ? 'admin'
        : stored === `${side}-full_admin` ? 'full_admin' : null;
    if (url.pathname === '/api/apps') {
      response.statusCode = matched === 'member' ? 200 : 401;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apps: matched === 'member' ? [{
        slug: 'frame-test', status: 'running', view_visibility: 'public',
        self_hosted: false, url: hostedOrigin(),
        repo_url: 'https://github.com/Usernode-Labs/frame-test', main_sha: 'a'.repeat(40),
      }] : [] }));
      return;
    }
    response.statusCode = matched ? 200 : 401;
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><h1>${matched ? `Signed in as ${matched} on ${side}` : 'Sign in'}</h1>${matched && url.pathname === '/status' ? `<iframe id="app-iframe" title="Public app" src="${hostedOrigin()}/frame"></iframe>` : ''}`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve(server));
  });
}

function proxyRequest(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: url }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function proxyConnect(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('CONNECT timed out')); });
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      socket.destroy();
      resolve(response.split('\r\n', 1)[0]);
    });
    socket.on('error', reject);
  });
}

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return;
    if (child.exitCode !== null) throw new Error('Evidence proxy exited before it became ready.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Evidence proxy did not become ready.');
}

async function main() {
  const address = Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  if (!address) throw new Error('The browser-auth smoke needs a non-loopback container address.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-auth-smoke-'));
  const servers = [];
  let proxy = null;
  try {
    const hosted = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><h2>Deployed child frame loaded</h2>');
    });
    await new Promise((resolve, reject) => {
      hosted.once('error', reject);
      hosted.listen(0, '0.0.0.0', resolve);
    });
    servers.push(hosted);
    const hostedOrigin = `http://${address}:${hosted.address().port}`;
    servers.push(await fixtureServer('base', () => hostedOrigin), await fixtureServer('head', () => hostedOrigin));
    const origins = [
      `http://${os.hostname()}:${servers[1].address().port}`,
      `http://${address}:${servers[2].address().port}`,
    ];
    const ready = path.join(dir, 'proxy.ready');
    const stateDir = path.join(dir, 'state');
    const hostedFile = path.join(stateDir, 'hosted-origins.json');
    proxy = spawn(process.execPath, [path.join(__dirname, 'evidence-origin-proxy.js')], {
      env: { ...process.env, EVIDENCE_ALLOWED_ORIGINS: JSON.stringify(origins),
        EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
        EVIDENCE_PROXY_PORT: '17891', EVIDENCE_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let proxyError = '';
    proxy.stderr.on('data', (chunk) => { proxyError = (proxyError + chunk).slice(-1000); });
    await waitForFile(ready, proxy);
    const env = {
      ...process.env,
      EVIDENCE_ALLOWED_ORIGINS: JSON.stringify(origins),
      EVIDENCE_BASE_ORIGIN: origins[0], EVIDENCE_HEAD_ORIGIN: origins[1],
      EVIDENCE_PROXY_SERVER: `http://127.0.0.1:${fs.readFileSync(ready, 'utf8').trim()}`,
      EVIDENCE_BROWSER_STATE_DIR: stateDir,
      EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
      EVIDENCE_MEMBER_TOKEN: 'member.jwt', EVIDENCE_ADMIN_TOKEN: 'admin.jwt',
      EVIDENCE_FULL_ADMIN_TOKEN: 'full-admin.jwt',
    };
    const bootstrap = await execFileAsync(process.execPath, [path.join(__dirname, 'evidence-browser-bootstrap.js')], {
      env, timeout: 90_000,
    });
    if (!bootstrap.stdout.includes('"kind":"hosted_app_allowlist","count":1')) {
      throw new Error(`Evidence bootstrap omitted the public deployed app: ${bootstrap.stdout.slice(-1000)}`);
    }
    if (JSON.stringify(hostedAppSlugs(hostedFile, origins[0], origins[1])) !== '["frame-test"]') {
      throw new Error('Evidence bootstrap did not expose the paired deployed app slug.');
    }
    const proxyPort = Number(fs.readFileSync(ready, 'utf8').trim());
    if ((await proxyRequest(proxyPort, `${hostedOrigin}/frame`)).status !== 200
        || (await proxyRequest(proxyPort, 'http://not-approved.invalid/frame')).status !== 403
        || !(await proxyConnect(proxyPort, new URL(hostedOrigin).host)).includes('200')
        || !(await proxyConnect(proxyPort, 'not-approved.invalid:443')).includes('403')) {
      throw new Error('Evidence proxy did not enforce the paired hosted-app catalog.');
    }
    const configPath = path.join(dir, 'mcp.json');
    execFileSync(process.execPath, [path.join(__dirname, 'write-evidence-mcp-config.js'), configPath], { env });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const [persona, serverName] of [
      ['member', 'browser_member'], ['admin', 'browser_admin'],
      ['full_admin', 'browser_full_admin'],
    ]) {
      const checks = origins.map((origin, index) => ({
        url: `${origin}/status`,
        expectedText: `Signed in as ${persona} on ${index === 0 ? 'base' : 'head'}`,
        iframeText: 'Deployed child frame loaded',
      }));
      try { await verifyBrowser(config.mcpServers[serverName], checks); }
      catch (error) {
        throw new Error(`${persona} browser failed (${error.message}); proxy exit=${proxy.exitCode}; ${proxyError}`);
      }
    }
    process.stdout.write('All planner personas retained authenticated sessions and loaded an approved child frame on both private revisions.\n');
  } finally {
    if (proxy && proxy.exitCode === null) {
      proxy.kill('SIGTERM');
      await new Promise((resolve) => {
        proxy.once('exit', resolve);
        setTimeout(resolve, 1500).unref();
      });
    }
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
