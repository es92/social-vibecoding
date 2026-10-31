const path = require('node:path');
// Playwright as the cloud containers have it; elsewhere `npm i -D playwright` in a scratch folder.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.route(/\/api\/apps\/[^/]+\/github-issues\/\d+\/comments(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ comments: [], truncated: false }) }));
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:3999/');
  await p.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'usernode-capture', password: 'capture-pass-123' }) }));
  await p.goto('http://127.0.0.1:3999/?v=99#homeroom-bot');
  await p.waitForTimeout(3500);
  await p.locator('[data-ai-line]', { hasText: 'Sort Discover by most active' }).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: path.join(__dirname, 'shots/from-bot-page-desk.png') });
  await browser.close();
})();
