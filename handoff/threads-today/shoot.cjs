// Final shots for the artifact: each thread's page whole, cropped to where
// its content ends, on desktop and phone; and the private idea opened from
// the Homeroom bot page (docked Main Chat on desktop, the drawer on a phone).
const path = require('node:path');
const fs = require('node:fs');
// Playwright as the cloud containers have it; elsewhere `npm i -D playwright` in a scratch folder.
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:3999';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SLUG = 'usernode-2d5619';

const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const pages = [
  { key: 'private-messages', route: '#homeroom-bot/thread/139' },
  { key: 'private-bot-page', route: '#homeroom-bot', click: '[data-ai-line="private"]' },
  { key: 'request', route: `#app/${SLUG}/dev/issues/6061` },
  { key: 'change', route: `#app/${SLUG}/dev/issues/6062` },
  { key: 'change-page', route: `#app/${SLUG}/dev/changes/6063` },
  { key: 'plan', route: `#app/${SLUG}/dev/issues/6064` },
  { key: 'plan-change-page', route: `#app/${SLUG}/dev/changes/6065` },
  { key: 'ballot', route: `#app/${SLUG}/dev/issues/6066` },
  { key: 'ballot-change-page', route: `#app/${SLUG}/dev/changes/6067` },
  // A thread opened from the Homeroom bot page: beside its list, in Main Chat's place.
  { key: 'from-bot-page', route: '#homeroom-bot', click: '[data-ai-list="next"] [data-ai-line], [data-ai-list="work"] [data-ai-line="need"]', desktopOnly: true },
];

const SIZES = [
  { name: 'desk', viewport: { width: 1280, height: 900 }, tall: 2400 },
  { name: 'phone', viewport: { width: 390, height: 844 }, tall: 2600, mobile: true },
];

// Where the page's content ends, above its composer, in CSS pixels.
const contentBottom = () => {
  const box = document.querySelector('textarea[placeholder^="Reply"], textarea[placeholder^="Message"]');
  const limit = box ? box.getBoundingClientRect().top - 12 : window.innerHeight;
  let bottom = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom > limit || r.top > limit) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own && !['IMG', 'svg', 'BUTTON'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    bottom = Math.max(bottom, r.bottom);
  }
  return Math.ceil(bottom);
};

(async () => {
  const browser = await chromium.launch();
  for (const size of SIZES) {
    const ctx = await browser.newContext({
      viewport: size.viewport, deviceScaleFactor: 2,
      ...(size.mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
    });
    // Staging pads a request with no comments with "[Mock]" ones; production
    // answers an empty list. Give the page production's answer.
    await ctx.route(/\/api\/apps\/[^/]+\/github-issues\/\d+\/comments(\?.*)?$/, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ comments: [], truncated: false }),
    }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/');
    await p.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'usernode-capture', password: 'capture-pass-123' }) }));
    // The app-store banner a phone browser shows: dismissed, as a returning visitor would have.
    await p.goto(BASE + '/');
    await p.waitForTimeout(2500);
    let n = 0;
    for (const pg of pages) {
      if (pg.desktopOnly && size.mobile) continue;
      if (ONLY && !ONLY.test(pg.key)) continue;
      await p.setViewportSize(size.viewport);
      // A fresh load each time: a hash change alone keeps what the last page left up.
      await p.goto(`${BASE}/?v=${++n}${pg.route}`);
      await p.waitForTimeout(3500);
      if (size.mobile) {
        const x = p.locator('[aria-label="Close"], [aria-label="Dismiss"]').filter({ hasText: '' });
        await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((el) => el.closest('[class*="app-banner"], [class*="smart"], [data-app-banner]') && /close|dismiss/i.test(el.getAttribute('aria-label') || '')); b?.click(); });
        void x;
      }
      if (pg.click) {
        await p.locator(pg.click).first().click();
        await p.waitForTimeout(2500);
        await p.screenshot({ path: path.join(OUT, `${pg.key}-${size.name}.png`) });
        console.log(size.name, pg.key, 'clicked');
        continue;
      }
      await p.setViewportSize({ width: size.viewport.width, height: size.tall });
      await p.waitForTimeout(1500);
      // Back to the top of the thread, then measure.
      await p.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
      await p.waitForTimeout(500);
      const bottom = Math.min(size.tall, (await p.evaluate(contentBottom)) + 24);
      await p.screenshot({ path: path.join(OUT, `${pg.key}-${size.name}.png`), clip: { x: 0, y: 0, width: size.viewport.width, height: Math.max(bottom, size.viewport.height) } });
      console.log(size.name, pg.key, bottom);
    }
    await ctx.close();
  }
  await browser.close();
})();
