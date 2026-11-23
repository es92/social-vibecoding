// Which CSS rules set a property on an element. node matched.js <profile> <route> <selector> <prop,prop> [origin]
const { chromium } = require('playwright');
const P = { phone: [393, 852, 1], tablet: [820, 1180, 1], laptop: [1024, 768, 0], desktop: [1440, 900, 0], small: [360, 640, 1] };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
(async () => {
  const [prof, route, sel, props, origin = 'http://127.0.0.1:3000'] = process.argv.slice(2);
  const [w, h, m] = P[prof]; const want = props.split(',');
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: !!m, hasTouch: !!m, ...(m ? { userAgent: UA } : {}), storageState: (process.env.LAB || '/tmp/lab') + '/state/usernode-capture.json', serviceWorkers: 'block' });
  const page = await ctx.newPage(); await page.goto(origin + route); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  const r = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  for (const mr of r.matchedCSSRules) for (const p of mr.rule.style.cssProperties) if (want.includes(p.name)) console.log(`${p.name}: ${p.value.slice(0, 90)}${p.important ? ' !important' : ''}   <=  ${mr.rule.selectorList.text.slice(0, 260)}  [line ${mr.rule.style.range ? mr.rule.style.range.startLine + 1 : '?'}${mr.rule.media && mr.rule.media.length ? ' @' + mr.rule.media.map((x) => x.text).join(' & ').slice(0, 60) : ''}]`);
  await b.close();
})();
