// Before/after captures that need real clicks. node flow.js <name>
const { chromium } = require('playwright'); const fs = require('fs');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FLOWS = {
  'sheet-labels': async (page, out) => {
    await page.goto(page.origin + '/app/staging-demo-kite-log/dev/hub'); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
    await page.click('#dev-plus-btn'); await page.waitForTimeout(700);
    await page.locator('text="Settings & rules" >> visible=true').first().click(); await page.waitForTimeout(1500);
    const r = await page.evaluate(() => { const b = [...document.querySelectorAll('.un-action-sheet .un-action-btn')].filter((x) => /secrets|variables/i.test(x.innerText))[0]; const q = b.getBoundingClientRect(); return { y: q.top, h: q.height, text: b.innerText }; });
    console.log(out, JSON.stringify(r.text));
    await page.screenshot({ path: out, clip: { x: 0, y: Math.max(0, r.y - 62), width: 393, height: r.h + 124 } });
  },
  'rename-spaces': async (page, out) => {
    await page.goto(page.origin + '/app/staging-demo-kite-log/dev/hub'); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
    await page.click('#dev-plus-btn'); await page.waitForTimeout(700);
    await page.locator('text="Settings & rules" >> visible=true').first().click(); await page.waitForTimeout(1500);
    await page.locator('text="App display name" >> visible=true').first().click(); await page.waitForTimeout(1400);
    const r = await page.evaluate(() => { const d = [...document.querySelectorAll('.un-modal, [role=dialog]')].filter((e) => /Rename app/.test(e.innerText)).pop(); const q = d.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; });
    await page.screenshot({ path: out, clip: { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(393, r.w + 8), height: r.h + 8 } });
  },
  'confirm-edge': async (page, out) => {
    await page.goto(page.origin + '/#messages/26'); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
    await page.locator('[aria-label="Group members"], [title="Group members"]').first().click(); await page.waitForTimeout(1200);
    await page.locator('text="Leave group" >> visible=true').first().click(); await page.waitForTimeout(1200);
    await page.screenshot({ path: out, clip: { x: 0, y: 200, width: 393, height: 470 } });
    await page.locator('.un-alert >> text="Cancel"').first().click().catch(() => {}); await page.waitForTimeout(400);
  },
  'feedback-tile': async (page, out) => {
    await page.goto(page.origin + '/#app/staging-demo-long-name/dev'); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
    await page.evaluate(() => window.UsernodeReact.dialogs.feedback.open({ slug: 'staging-demo-long-name' })); await page.waitForTimeout(1500);
    const r = await page.evaluate(() => { const q = document.querySelector('#feedback-target').getBoundingClientRect(); return { y: q.top, h: q.height }; });
    await page.screenshot({ path: out, clip: { x: 0, y: Math.max(0, r.y - 44), width: 393, height: r.h + 120 } });
  },
};
(async () => { const name = process.argv[2]; const b = await chromium.launch({ args: [/^https:/.test(process.env.LAB_REMOTE || '') || process.argv.some((x) => /^https:/.test(x)) ? '--proxy-server=http://127.0.0.1:43011' : '--no-proxy-server'] });
  fs.mkdirSync(`${process.env.BUGS_DIR || ((process.env.LAB || '/tmp/lab') + '/out')}/${name}`, { recursive: true });
  for (const [kind, origin] of [['before', 'http://127.0.0.1:3000'], ['after', 'http://127.0.0.1:3001']]) {
    const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA, storageState: (process.env.LAB || '/tmp/lab') + '/state/usernode-capture.json', serviceWorkers: 'block' });
    const page = await ctx.newPage(); page.origin = origin;
    await FLOWS[name](page, `${process.env.BUGS_DIR || ((process.env.LAB || '/tmp/lab') + '/out')}/${name}/${kind}.png`); await ctx.close(); }
  await b.close(); })().catch((e) => { console.error(e); process.exit(1); });
