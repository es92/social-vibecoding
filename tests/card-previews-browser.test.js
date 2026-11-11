'use strict';

// A project card's animated preview, played in a real browser
// (frontend/src/features/guest/card-preview.tsx, frontend/src/lib/card-previews.ts).
//
// The component is bundled with the frontend's own esbuild into a page of
// three cards and driven with Playwright:
//
//   - at rest there is no <video> at all: nothing mounts and nothing is
//     fetched until a card is pointed at, focused or (on a phone) in view;
//   - on a device with a mouse it starts after a moment of pointing, loops,
//     and stops when the pointer leaves; a quick pass over a card starts
//     nothing; keyboard focus starts it too;
//   - one plays at a time;
//   - nothing plays under reduced motion, with Data Saver, or with "Play
//     previews" turned off;
//   - on a phone the card most in view plays once, without looping, then
//     rests on its picture;
//   - a missing loop leaves the picture, with no error on the console.
//
// Skipped (with the reason) where Chromium cannot launch.
//
// Run with: node --test tests/card-previews-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const LOOP = fs.readFileSync(path.join(ROOT, 'public/illustrations/card-previews/sample.mp4'));

function bundle() {
  const esbuild = require(require.resolve('esbuild', { paths: [FRONTEND] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-previews-'));
  const entry = path.join(dir, 'entry.tsx');
  fs.writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import { CardPreview } from ${JSON.stringify(path.join(FRONTEND, 'src/features/guest/card-preview.tsx'))};
    const srcs = (window as any).CARD_SRCS as string[];
    function Card({ i, src }: { i: number; src: string }) {
      return (
        <article data-card={i} style={{ position: 'relative', width: 320, height: 300, margin: '0 0 24px' }}>
          <span style={{ position: 'relative', display: 'block', width: 320, height: 200, background: '#fde68a' }}>
            <CardPreview src={src} />
          </span>
          <a href={'#card-' + i} data-card-link={i}>Card {i}</a>
        </article>
      );
    }
    createRoot(document.getElementById('root')!).render(<>{srcs.map((src, i) => <Card key={i} i={i} src={src} />)}</>);
  `);
  const result = esbuild.buildSync({
    entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', alias: { '@': path.join(FRONTEND, '@') }, nodePaths: [path.join(FRONTEND, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result.outputFiles[0].text;
}

async function launch() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { skip: 'Playwright is not installed' }; }
  try { return { browser: await chromium.launch({ headless: true, args: ['--no-sandbox'] }) }; } catch (err) {
    return { skip: `Chromium will not launch here: ${String(err.message || err).slice(0, 300)}` };
  }
}

test('a card\'s preview plays only when it is chosen, one at a time, and never against the person\'s settings', async (t) => {
  const { browser, skip } = await launch();
  if (skip) { t.skip(skip); return; }
  const code = bundle();
  const fetched = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/phone') {
      const srcs = url === '/phone' ? ['/loop.mp4', '/loop.mp4', '/loop.mp4', '/loop.mp4'] : ['/loop.mp4', '/loop.mp4', '/missing.mp4'];
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div>
        <script>window.CARD_SRCS = ${JSON.stringify(srcs)};</script><script>${code}</script></body></html>`);
      return;
    }
    if (url === '/loop.mp4') {
      fetched.push(url);
      res.setHeader('Content-Type', 'video/mp4');
      res.end(LOOP);
      return;
    }
    fetched.push(url);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const videos = (page) => page.locator('[data-card-preview-video]').count();
  const playing = (page, i) => page.waitForFunction((n) => {
    const v = document.querySelector(`[data-card="${n}"] [data-card-preview-video]`);
    return !!v && !v.paused && v.currentTime > 0 && v.classList.contains('opacity-100');
  }, i, { timeout: 8000 });
  try {
    await t.test('a mouse: nothing at rest, a moment of pointing starts it, leaving stops it, one at a time', async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base);
      await page.waitForSelector('[data-card-preview]', { state: 'attached' });
      assert.equal(await videos(page), 0, 'no video at rest');
      await page.waitForTimeout(300);
      assert.deepEqual(fetched, [], 'nothing fetched at rest');

      // A quick pass over a card starts nothing.
      await page.mouse.move(100, 100);
      await page.mouse.move(800, 100);
      await page.waitForTimeout(400);
      assert.equal(await videos(page), 0, 'a pass under the delay starts nothing');

      await page.hover('[data-card="0"]');
      await playing(page, 0);
      assert.equal(await page.locator('[data-card="0"] [data-card-preview-video]').evaluate((v) => v.loop && v.muted && v.playsInline && v.preload === 'none'), true);
      // Another card: the first stops.
      await page.hover('[data-card="1"]');
      await playing(page, 1);
      assert.equal(await videos(page), 1, 'one at a time');
      // Away: it stops and resets.
      await page.mouse.move(850, 950);
      await page.waitForFunction(() => !document.querySelector('[data-card-preview-video]'));

      // Keyboard focus starts it too, and leaving the card stops it.
      await page.focus('[data-card-link="0"]');
      await playing(page, 0);
      await page.focus('[data-card-link="1"]');
      await playing(page, 1);
      assert.equal(await videos(page), 1);
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForFunction(() => !document.querySelector('[data-card-preview-video]'));

      // A missing loop: the picture stays, nothing on the console, and it is not asked for again.
      await page.hover('[data-card="2"]');
      await page.waitForFunction(() => !document.querySelector('[data-card="2"] [data-card-preview-video]') && performance.now() > 0, null, { timeout: 8000 });
      await page.waitForTimeout(500);
      assert.equal(await videos(page), 0);
      const asked = fetched.filter((u) => u === '/missing.mp4').length;
      await page.mouse.move(850, 950);
      await page.hover('[data-card="2"]');
      await page.waitForTimeout(500);
      assert.equal(fetched.filter((u) => u === '/missing.mp4').length, asked, 'a failed loop is not asked for again');
      assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), [], 'no script error on the console');
      await context.close();
    });

    for (const [name, setup] of [
      ['reduced motion', async (context, page) => { await page.emulateMedia({ reducedMotion: 'reduce' }); }],
      ['Data Saver', async (context) => { await context.addInitScript(() => { Object.defineProperty(navigator, 'connection', { value: { saveData: true } }); }); }],
      ['the setting off', async (context) => { await context.addInitScript(() => { localStorage.setItem('usernode:cardPreviews', 'off'); }); }],
    ]) {
      await t.test(`nothing plays with ${name}`, async () => {
        const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
        const page = await context.newPage();
        await setup(context, page);
        await page.goto(base);
        await page.waitForSelector('[data-card-preview]', { state: 'attached' });
        await page.hover('[data-card="0"]');
        await page.waitForTimeout(700);
        assert.equal(await videos(page), 0, `no video with ${name}`);
        await context.close();
      });
    }

    await t.test('a phone: the card most in view plays once, unlooped, then rests on its picture', async () => {
      const context = await browser.newContext({ viewport: { width: 360, height: 420 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      await page.goto(`${base}/phone`);
      await page.waitForSelector('[data-card-preview]', { state: 'attached' });
      // The first card is the one most in view once things settle.
      await playing(page, 0);
      assert.equal(await videos(page), 1, 'never more than one');
      assert.equal(await page.locator('[data-card-preview-video]').evaluate((v) => v.loop), false, 'a phone plays it once');
      // It ends (or reaches five seconds) and the picture shows again.
      await page.waitForFunction(() => !document.querySelector('[data-card-preview-video]'), null, { timeout: 9000 });
      await page.waitForTimeout(600);
      assert.equal(await videos(page), 0, 'it does not play again while it stays in view');
      // Scroll the next card into view: it plays.
      await page.evaluate(() => window.scrollTo(0, document.querySelector('[data-card="2"]').offsetTop));
      await playing(page, 2);
      assert.equal(await videos(page), 1);
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});
