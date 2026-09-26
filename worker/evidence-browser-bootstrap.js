#!/usr/bin/env node
'use strict';

// Exchange short-lived app identity JWTs for ordinary browser storage state
// before the model process starts. The runner unsets the raw tokens
// immediately afterward; MCP receives only the cookie/local-storage state in
// a private file and the model has no filesystem or shell tool in evidence
// mode.

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
const { SessionBootstrapError, bootstrapInternalSession } = require('./session-bootstrap');
const { loadTrustedHostedAppOrigins } = require('./evidence-hosted-origins');

function reportAuth(persona, side, bootstrap, sessionCookiePresent) {
  // Only fixed booleans and status cross the worker boundary. The token,
  // session cookie, URLs, and response body stay inside this process.
  process.stdout.write(`__USERNODE_EVIDENCE_BROWSER__ ${JSON.stringify({
    kind: 'auth_bootstrap',
    persona: persona === 'member' ? 'member' : persona === 'full_admin' ? 'full_admin' : 'admin',
    side,
    attempted: bootstrap.attempted === true,
    cookieAlreadyPresent: bootstrap.cookieAlreadyPresent === true,
    sessionCookieInstalled: bootstrap.sessionCookieInstalled === true,
    sessionCookiePresent,
    ...(Number.isInteger(bootstrap.responseStatus) ? { responseStatus: bootstrap.responseStatus } : {}),
  })}\n`);
}

async function main() {
  const origins = JSON.parse(process.env.EVIDENCE_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin);
  const outputDir = String(process.env.EVIDENCE_BROWSER_STATE_DIR || '');
  const proxy = String(process.env.EVIDENCE_PROXY_SERVER || '');
  const personas = {
    member: String(process.env.EVIDENCE_MEMBER_TOKEN || ''),
    read_only_admin: String(process.env.EVIDENCE_ADMIN_TOKEN || ''),
    full_admin: String(process.env.EVIDENCE_FULL_ADMIN_TOKEN || ''),
  };
  if (origins.length !== 2 || !outputDir || !proxy || Object.values(personas).some((value) => !value)) {
    throw new Error('Evidence browser bootstrap configuration is incomplete.');
  }
  const hostedFile = path.resolve(outputDir, 'hosted-origins.json');
  if (!process.env.EVIDENCE_HOSTED_ORIGINS_FILE
      || path.resolve(process.env.EVIDENCE_HOSTED_ORIGINS_FILE) !== hostedFile) {
    throw new Error('Evidence hosted-app catalog path does not match the private browser state directory.');
  }
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const memberCatalogs = [];
  const browser = await chromium.launch({
    channel: 'chromium', headless: true, proxy: { server: proxy },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    for (const [persona, token] of Object.entries(personas)) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        for (const [index, origin] of origins.entries()) {
          const url = new URL('/', origin);
          url.searchParams.set('token', token);
          const bootstrap = {};
          // Use the same token-to-session exchange as deterministic replay.
          // Navigating alone loses a Secure session cookie on private HTTP.
          await bootstrapInternalSession(context, origin, url.href, token, bootstrap);
          const page = await context.newPage();
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const final = new URL(page.url());
          if (final.origin !== origin) {
            throw new SessionBootstrapError('cross_origin_navigation', 'Evidence authentication left its private origin.');
          }
          await page.close();
          const sessionCookiePresent = (await context.cookies(origin)).some((cookie) => cookie.name === 'session');
          reportAuth(persona, index === 0 ? 'base' : 'head', bootstrap, sessionCookiePresent);
          if (bootstrap.sessionCookieInstalled && !sessionCookiePresent) {
            throw new SessionBootstrapError('session_bootstrap_failed', 'The evidence browser did not retain its private session cookie.');
          }
          if (persona === 'member') {
            const side = index === 0 ? 'base' : 'head';
            memberCatalogs.push(await loadTrustedHostedAppOrigins(context, origin, (result) => {
              process.stdout.write(`__USERNODE_EVIDENCE_BROWSER__ ${JSON.stringify({
                kind: 'hosted_app_catalog', side, ...result,
              })}\n`);
            }));
          }
        }
        const target = path.join(outputDir, `${persona}.json`);
        await context.storageState({ path: target });
        await fs.chmod(target, 0o600);
      } finally { await context.close(); }
    }
    const hostedApps = [...(memberCatalogs[0] || new Map())]
      .filter(([origin, slug]) => memberCatalogs[1]?.get(origin) === slug)
      .map(([origin, slug]) => ({ origin, slug }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const stagedHostedFile = `${hostedFile}.${process.pid}.tmp`;
    await fs.writeFile(stagedHostedFile, `${JSON.stringify({
      version: 2, baseOrigin: origins[0], headOrigin: origins[1], apps: hostedApps,
    })}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(stagedHostedFile, hostedFile);
    process.stdout.write(`__USERNODE_EVIDENCE_BROWSER__ ${JSON.stringify({
      kind: 'hosted_app_allowlist', count: hostedApps.length,
    })}\n`);
  } finally { await browser.close(); }
}

main().catch((error) => {
  // Playwright errors may include a token-bearing navigation URL. Only our
  // controlled, credential-free messages are safe for the worker result.
  process.stderr.write(`${error instanceof SessionBootstrapError
    ? error.message : 'Evidence browser authentication failed.'}\n`);
  process.exit(1);
});
