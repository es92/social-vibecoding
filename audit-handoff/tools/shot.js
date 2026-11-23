// One targeted screenshot. node shot.js --out file.png --route '/#x' [--profile phone] [--theme light] [--persona X]
//   [--origin http://127.0.0.1:3000] [--scale 2] [--clip x,y,w,h | --sel 'css' [--pad 12]] [--js 'code after load'] [--textSize xlarge] [--eval 'expr to print'] [--w N --h N]
const fs = require('node:fs'); const { chromium } = require('playwright');
const P = { phone: [393, 852, 1], small: [360, 640, 1], narrow: [320, 568, 1], tablet: [820, 1180, 1], laptop: [1024, 768, 0], desktop: [1440, 900, 0], wide: [1920, 1080, 0], duo: [669, 951, 1], laptop13: [1280, 800, 0] };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
(async () => {
  const a = { profile: 'phone', theme: 'light', persona: 'usernode-capture', origin: 'http://127.0.0.1:3000', scale: '2', pad: '12', wait: '1800' };
  const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  const [w, h, mobile] = P[a.profile];
  const browser = await chromium.launch({ args: [/^https:/.test(process.env.LAB_REMOTE || '') || process.argv.some((x) => /^https:/.test(x)) ? '--proxy-server=http://127.0.0.1:43011' : '--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: Number(a.w || w), height: Number(a.h || h) }, deviceScaleFactor: Number(a.scale), isMobile: !!mobile, hasTouch: !!mobile, ...(mobile ? { userAgent: UA } : {}),
    storageState: a.persona === 'guest' ? undefined : `${process.env.LAB || "/tmp/lab"}/state/${a.persona}.json`, serviceWorkers: 'block', colorScheme: a.theme });
  await ctx.addInitScript(({ theme, textSize, hideBanner }) => { try { localStorage.setItem('theme', theme); if (textSize) localStorage.setItem('homeroom:text-size', textSize); } catch {} }, { theme: a.theme, textSize: a.textSize });
  const page = await ctx.newPage();
  const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.goto(a.origin + a.route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(Number(a.wait));
  if (a.js) { await page.evaluate(a.js); await page.waitForTimeout(1000); }
  if (a.eval) console.log(JSON.stringify(await page.evaluate(a.eval), null, 1));
  let clip;
  if (a.clip) { const [x, y, cw, ch] = a.clip.split(',').map(Number); clip = { x, y, width: cw, height: ch }; }
  else if (a.sel) { const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, a.sel);
    if (!r) { console.error('selector not found', a.sel); } else { await page.waitForTimeout(300); const b = await page.evaluate((s) => { const q = document.querySelector(s).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }, a.sel); const p = Number(a.pad); const vw = Number(a.w || w), vh = Number(a.h || h); const x = Math.max(0, b.x - p), y = Math.max(0, b.y - p); clip = { x, y, width: Math.min(vw - x, b.w + 2 * p), height: Math.min(vh - y, b.h + 2 * p) }; } }
  if (a.out) await page.screenshot({ path: a.out, ...(clip ? { clip } : {}) });
  if (errs.length) console.error('console errors:', errs.join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
