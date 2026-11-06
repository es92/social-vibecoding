#!/usr/bin/env node
// Real built-shell captures with local, deterministic API fixtures. No live
// account, network writes, hand-written UI, or screenshot CSS overrides.
// Run npm run ensure:shell first. Playwright is an optional developer tool,
// like scripts/audit-react-ownership.mjs, not a repository dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve(process.env.CAPTURE_OUT || 'artifacts/mobile-density');
const phase = process.env.CAPTURE_PHASE || 'before';
// An exported baseline has no .git directory. Name its immutable source
// explicitly instead of accidentally recording the harness checkout's HEAD.
const revision = process.env.CAPTURE_REVISION
  || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(revision, /^[a-f0-9]{40}$/, 'CAPTURE_REVISION must be a full commit SHA');
const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use(express.static('public'));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const apps = [
  ['game-corner', 'Game Corner', '🕹️', 11],
  ['my-page', 'MyPage', '✨', 2],
  ['community-hub', 'Community Hub', '📊', 2],
  ['recipe-bot', 'RecipeBot', '🍲', 3],
  ['todo-list', 'Todo List', '📝', 2],
].map(([slug, name, icon_emoji, member_count], i) => ({
  id: i + 1, slug, name, icon_emoji, active_users: member_count, status: 'running',
  created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-08T12:00:00Z',
  creator_id: 2, visibility: 'public', is_favorite: false, is_member: false,
  description: 'A community-built app.', repo_url: 'https://github.com/example/example',
  open_prs: 1, open_issues: i === 0 ? 37 : 1,
}));
const session = {
  id: 161700, app_id: 2, user_id: 1, status: 'promoted', check_state: 'passing', yes_count: 0, votes_required: 1, session_title: 'add help assistant',
  branch_name: 'session/add-help-assistant', pr_number: 21, pr_title: 'add help assistant',
  agent_backend: 'codex_openrouter', agent_model: 'openai/gpt-5.3-codex',
  staging_url: `${origin}/preview-fixture`, created_at: '2026-09-08T12:00:00Z',
};
const messages = [{ id: 1, role: 'assistant', content: 'The change is ready for review.\n\nOpened PR #21: View pull request\n\nStaging redeployed: Open preview', created_at: '2026-09-08T12:00:00Z' }];
const requests = new Set();
const errors = [];
try {
  await fs.mkdir(output, { recursive: true });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 780 : 900 },
      deviceScaleFactor: 2, isMobile: width === 360, hasTouch: width === 360, colorScheme: 'light',
      serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/challenges-api/')) return route.continue();
      requests.add(`${route.request().method()} ${url.pathname}`);
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 1, username: 'reviewer', display_name: 'Reviewer', hasPlatformAccess: true } };
      else if (url.pathname === '/api/apps') body = { apps };
      else if (url.pathname.endsWith('/favorite') && route.request().method() === 'POST') {
        const target = apps.find(a => a.slug === url.pathname.split('/')[3]);
        assert.ok(target, 'only fixture apps may be modified');
        target.is_favorited = route.request().postDataJSON().favorited;
        body = { favorited: target.is_favorited };
      }
      else if (url.pathname === '/api/apps/my-page') body = { app: { ...apps[1], is_member: true, members: [], proposals: [], sessions: [session] } };
      else if (url.pathname === '/api/sessions/161700') body = { session, messages, drafts: [] };
      else if (url.pathname === '/api/sessions/161700/status') body = { session, messages, status: session.status, is_busy: false };
      else if (url.pathname === '/api/models') body = { models: [{ id: 'sonnet', label: 'Sonnet' }], default: 'sonnet' };
      else if (url.pathname.endsWith('/sessions')) body = { sessions: [session] };
      else if (url.pathname === '/api/me/active-sessions') body = { sessions: [] };
      else if (url.pathname === '/api/me/coding-agent') body = { agent_backend: 'codex_openrouter' };
      else if (url.pathname === '/api/budget') body = { daily_limit: 10, daily_used: 1, remaining: 9 };
      else if (url.pathname === '/api/home-layout') body = { layout: null };
      else if (url.pathname.includes('notifications')) body = { notifications: [], unread: 0 };
      else if (url.pathname.includes('terms/current')) body = { success: true, data: { accepted: true, requires_acceptance: false } };
      else body = { sessions: [], items: [], messages: [], apps: [], notifications: [], models: [], proposals: [], issues: [], members: [], success: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    await context.routeWebSocket('**/ws/**', () => {});
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    // Discover's list (#apps) went with One Home (#6361); Home is the page
    // of apps and communities now.
    await page.goto(`${origin}/?shot=mobile-density`);
    await page.locator('#home-screen:not(.hidden)').waitFor();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(output, `home-${phase}-${width}.png`) });
    await page.goto(`${origin}/?shot=dev-chat-first-use#app/my-page/dev/sessions/161700`);
    await page.locator('#dc-session-header').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(output, `dev-chat-${phase}-${width}.png`) });
    if (phase === 'after' && width === 360) {
      const newCopy = await page.locator('#dc-new-change-banner > span').boundingBox();
      const newAction = await page.locator('#dc-new-change-btn').boundingBox();
      const returnCopy = await page.locator('#dc-return-hint > div').boundingBox();
      const returnAction = await page.locator('#dc-return-hint-dismiss').boundingBox();
      assert.ok(newCopy.y + newCopy.height <= newAction.y,
        'phone new-change action is below the explanation');
      assert.ok(returnCopy.y + returnCopy.height <= returnAction.y,
        'phone return-hint action is below the explanation');
      assert.ok(newCopy.width >= 280 && returnCopy.width >= 280,
        '360px guidance copy keeps a readable line length');
      // #1940: no Details sheet — the provider and the PR link are inline at
      // every width again, and the strip must still fit a 360px phone.
      assert.ok(await page.locator('#dc-venue-select').isVisible(), 'Built with is shown directly');
      assert.ok(await page.locator('#dc-pr-header-link').isVisible(), 'the PR link is shown directly');
      assert.ok(await page.locator('#dc-mode-switch').isVisible(), 'Preview/Building remains available');
      assert.equal(await page.locator('.dc-session-details-trigger').count(), 0, 'no Details button');
      const strip = await page.locator('#dc-session-header').boundingBox();
      const venue = await page.locator('#dc-venue-select').boundingBox();
      assert.ok(venue.x + venue.width <= strip.x + strip.width, 'the provider fits inside the strip');
      await page.locator('#dc-venue-select').click();
      await page.getByText('Where do you want to work on this?', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByText('Where do you want to work on this?', { exact: true }).waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 320, height: 780 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(() => {
        DevChat.currentSession.session_title = 'A much longer session title that still needs to remain readable';
        DevChat._repaintSessionHeader();
      });
      assert.ok((await page.locator('.dc-session-title').boundingBox()).height <= 41, 'long title is capped at two header lines');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px Dev chat has no horizontal overflow');
      const newCopy320 = await page.locator('#dc-new-change-banner > span').boundingBox();
      const newAction320 = await page.locator('#dc-new-change-btn').boundingBox();
      const returnCopy320 = await page.locator('#dc-return-hint > div').boundingBox();
      const returnAction320 = await page.locator('#dc-return-hint-dismiss').boundingBox();
      assert.ok(newCopy320.y + newCopy320.height <= newAction320.y,
        '320px new-change action remains below the explanation');
      assert.ok(returnCopy320.y + returnCopy320.height <= returnAction320.y,
        '320px return-hint action remains below the explanation');
      assert.ok(newCopy320.width >= 240 && returnCopy320.width >= 240,
        '320px guidance copy keeps a readable line length');
      await page.screenshot({ path: path.join(output, 'dev-chat-dark-320.png') });
      await page.locator('#dc-return-hint-dismiss').click();
      await page.locator('#dc-return-hint').waitFor({ state: 'hidden' });
      await page.locator('#dc-new-change-btn').click();
      await page.waitForFunction(() => location.pathname.endsWith('/dev/sessions/new'));
      await page.evaluate(() => { location.hash = ''; });
      await page.locator('#home-screen:not(.hidden)').waitFor();
      await page.waitForTimeout(900);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px Home has no horizontal overflow');
      await page.screenshot({ path: path.join(output, 'home-dark-320.png') });
    }
    if (phase === 'after' && width === 1280) {
      assert.ok(await page.locator('#dc-venue-select').isVisible());
      assert.ok(await page.locator('#dc-pr-header-link').isVisible());
      assert.equal(await page.locator('.dc-session-details-trigger').count(), 0);
      const newCopy = await page.locator('#dc-new-change-banner > span').boundingBox();
      const newAction = await page.locator('#dc-new-change-btn').boundingBox();
      const returnCopy = await page.locator('#dc-return-hint > div').boundingBox();
      const returnAction = await page.locator('#dc-return-hint-dismiss').boundingBox();
      assert.ok(newAction.y < newCopy.y + newCopy.height && newCopy.y < newAction.y + newAction.height,
        'desktop new-change action stays inline with the explanation');
      assert.ok(returnAction.y < returnCopy.y + returnCopy.height && returnCopy.y < returnAction.y + returnAction.height,
        'desktop return-hint action stays inline with the explanation');
    }
    // Run mutation checks AFTER both comparison captures, so the before and
    // after screenshots use the exact same navigation and untouched data.
    if (phase === 'after') {
      await page.goto(`${origin}/?shot=mobile-density#apps`);
      const row = page.locator('.browse-row[data-slug="game-corner"]');
      await row.waitFor();
      const name = row.locator('.browse-row-title');
      const add = row.locator('.browse-add-btn');
      const titleBox = await name.boundingBox(), addBox = await add.boundingBox();
      if (width < 640) assert.ok(titleBox.y + titleBox.height <= addBox.y + 1, 'title is above Add');
      await add.click();
      await page.waitForFunction(() => document.querySelector('.browse-row[data-slug="game-corner"] .browse-add-btn')?.dataset.added === 'true');
      assert.equal(new URL(page.url()).hash, '#apps', 'Add must not navigate into the row');
      await add.click();
      await page.waitForFunction(() => document.querySelector('.browse-row[data-slug="game-corner"] .browse-add-btn')?.dataset.added === 'false');
    }
    console.log(JSON.stringify({ phase, width, errors }));
    await context.close();
  }
  const fingerprints = {};
  for (const file of ['public/css/app.css', 'public/css/tailwind.css', 'public/shell/assets/shell.js']) {
    fingerprints[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  await fs.writeFile(path.join(output, `${phase}-metadata.json`), JSON.stringify({
    phase, revision,
    browser: browser.version(), fixture: 'local synthetic API data; real built shell', fingerprints,
    viewports: [{ width: 360, height: 780, deviceScaleFactor: 2 }, { width: 1280, height: 900, deviceScaleFactor: 2 }],
    requests: [...requests], errors,
  }, null, 2));
  assert.deepEqual(errors, [], 'The built app must not throw while capturing');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
