// Mock alternatives for the Communities page's Joined list on the production-code lab (:3000).
// Fills the Joined grid with six real public communities (mock/joined-mock.json) drawn four ways:
//   now  today's compact card (name and members)
//   A    the compact card plus this week's line, the same words the pinned cards use
//   B    the old row given room: what it is, faces of who was there, this week
//   C    what's new: the latest change that went live this week, else what it is
// node tools/joined-options.js  ->  review/img/j-<option>-<width>.png
const fs = require('fs');
const { chromium } = require('playwright');
const DATA = JSON.parse(fs.readFileSync(process.env.MOCK_DATA || '/home/user/hr-lab/mock/joined-mock.json', 'utf8'));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const CSS = `
#communities-joined-section .cm-grid[data-mock-opt="B"], #communities-joined-section .cm-grid[data-mock-opt="C"] {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 21rem), 1fr));
}
@media (max-width: 767.98px) {
  #communities-joined-section .cm-grid[data-mock-opt] { grid-template-columns: minmax(0, 1fr); gap: 8px; }
}
.mk-more { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-inline-start: 56px; min-width: 0; }
.cm-grid[data-mock-opt="A"] .mk-more { padding-inline-start: 0; margin-top: 12px; }
.cm-grid[data-mock-opt="A"] .cm-week-in { flex-wrap: nowrap; white-space: nowrap; }
.mk-more .cm-card-week { margin-top: 0; }
.mk-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 18px; color: var(--cm-body); }
.mk-week { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; min-width: 0; font-size: 13px; line-height: 18px; color: var(--cm-body); font-variant-numeric: tabular-nums; }
.mk-faces { display: inline-flex; flex: none; }
.mk-face { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #fff; box-shadow: 0 0 0 2px var(--cm-bg); margin-inline-end: -6px; }
.mk-face:last-child { margin-inline-end: 0; }
.mk-sep { color: var(--cm-muted); }
.cm-grid[data-mock-opt="D"] .mk-more { margin-top: 10px; gap: 6px; padding-inline-start: 0; }
.cm-grid[data-mock-opt="D"] .mk-week { gap: 4px 12px; font-size: var(--cm-small); line-height: var(--cm-small-line); }
.cm-grid[data-mock-opt="D"] .mk-desc { font-size: var(--cm-small); line-height: var(--cm-small-line); }
.cm-grid[data-mock-opt="D"] .mk-grp { gap: 6px; }
.cm-grid[data-mock-opt="E"] .cm-card-members { display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; white-space: normal; overflow: visible; }
.cm-grid[data-mock-opt="E"] .cm-card-members > span { white-space: nowrap; }
.cm-grid[data-mock-opt="E"] .mk-faces { margin-inline-end: 2px; }
.cm-grid[data-mock-opt="E"] .mk-face { width: 18px; height: 18px; font-size: 8px; margin-inline-end: -5px; }
.cm-grid[data-mock-opt="E"] .mk-face:last-child { margin-inline-end: 0; }
.cm-grid[data-mock-opt="E"] .mk-live-line { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; font-size: var(--cm-small); line-height: var(--cm-small-line); font-weight: 600; color: var(--cm-link); white-space: nowrap; }
.cm-grid[data-mock-opt="E"] .cm-card-id { gap: 3px; }
/* E, with room: more padding, the lines further apart, 13px words, smaller faces that sit inside the line. */
.cm-grid[data-mock-roomy] .cm-card[data-cm-size="compact"] { padding: 16px; }
.cm-grid[data-mock-roomy] .cm-card-head { gap: 14px; }
.cm-grid[data-mock-roomy] .cm-card-id { gap: 5px; }
.cm-grid[data-mock-roomy] .cm-card-members, .cm-grid[data-mock-roomy] .mk-live-line { font-size: 13px; line-height: 18px; }
.cm-grid[data-mock-roomy] .mk-live-line { margin-top: 0; gap: 5px; }
.cm-grid[data-mock-roomy] .cm-card-members { column-gap: 5px; }
.cm-grid[data-mock-roomy] .mk-face { width: 16px; height: 16px; font-size: 7px; margin-inline-end: -4px; box-shadow: 0 0 0 1.5px var(--cm-bg); }
.cm-grid[data-mock-roomy] .mk-face:last-child { margin-inline-end: 0; }
.cm-grid[data-mock-roomy] .mk-faces { margin-inline-end: 3px; }
@media (min-width: 768px) and (max-width: 1279.98px) { #communities-joined-section .cm-grid[data-mock-roomy][data-mock-cols] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cm-grid[data-mock-roomy] .mk-live-line { max-width: 100%; }
.cm-grid[data-mock-roomy] .mk-live-line > svg + * { overflow: hidden; text-overflow: ellipsis; }
.cm-grid:is([data-mock-opt="G"], [data-mock-opt="G2"]) .cm-card-id { flex: 1 1 auto; }
.mk-top { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.mk-top .cm-card-name { flex: 1 1 auto; min-width: 0; }
.mk-top .cm-card-members { flex: none; overflow: visible; }
.mk-weekrow { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 14px; min-width: 0; font-size: 13px; line-height: 18px; color: var(--cm-body); font-variant-numeric: tabular-nums; }
.cm-grid[data-mock-opt="G2"] .mk-weekrow { flex-direction: column; align-items: flex-start; gap: 5px; }
.mk-weekrow .mk-grp { gap: 6px; }
.mk-weekrow .mk-live { gap: 5px; }
.cm-grid[data-mock-opt="H"] .cm-card-members { display: flex; align-items: center; gap: 6px; overflow: visible; }
.cm-grid[data-mock-opt="H"] .mk-live-line { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; color: var(--cm-link); white-space: nowrap; }
@media (min-width: 768px) { #communities-joined-section .cm-grid[data-mock-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.mk-grp { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.mk-live { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; color: var(--cm-link); white-space: nowrap; }
.mk-tick { width: 14px; height: 14px; flex: none; }
.mk-new { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; line-height: 18px; color: var(--cm-ink); }
.mk-new > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-new .mk-tick { color: var(--state-ok, #1f8a4c); }
.mk-sub { font-size: 12px; line-height: 17px; color: var(--cm-muted); font-variant-numeric: tabular-nums; }
`;

function render({ opt, data }) {
  let cols = null; if (opt === 'D3') { opt = 'D'; cols = '3'; } if (opt === 'E3') { opt = 'E'; cols = '3'; } let roomy = false; if (opt === 'F') { opt = 'E'; cols = '3'; roomy = true; } if (opt === 'G' || opt === 'G2' || opt === 'H') { cols = '3'; roomy = true; } let noFaces = false; if (opt === 'F0') { opt = 'E'; cols = '3'; roomy = true; noFaces = true; }
  const grid = document.querySelector('#communities-joined-section .cm-grid');
  const tpl = grid.querySelector('.cm-card[data-cm-size="compact"]');
  const badgeTpl = grid.querySelector('[data-home-community-votes]');
  grid.dataset.mockOpt = opt;
  if (cols) grid.dataset.mockCols = cols;
  if (roomy) grid.dataset.mockRoomy = '1';
  grid.innerHTML = '';
  const TICK = '<svg class="mk-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const COLORS = ['rgb(138, 90, 131)', 'rgb(91, 117, 83)', 'rgb(74, 111, 165)', 'rgb(196, 112, 74)', 'rgb(111, 179, 168)'];
  const LETTERS = 'ADKMRSTBNJ';
  const word = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  data.forEach((c, i) => {
    const card = tpl.cloneNode(true);
    card.removeAttribute('data-home-community-pinned');
    card.querySelector('.cm-card-name').textContent = c.name;
    card.querySelector('.cm-card-members').textContent = word(c.members, 'member', 'members');
    const icon = card.querySelector('.cm-card-icon');
    icon.dataset.icon = 'image';
    icon.innerHTML = `<img alt="" class="w-full h-full rounded-xl object-cover" src="${c.icon}">`;
    card.querySelectorAll('[data-home-community-votes]').forEach((b) => b.remove());
    if (c.votes && badgeTpl) { const b = badgeTpl.cloneNode(true); b.textContent = String(c.votes); card.querySelector('.cm-card-face').appendChild(b); }
    const more = document.createElement('span');
    more.className = 'mk-more';
    const faces = () => noFaces ? '' : `<span class="mk-faces">${Array.from({ length: Math.min(3, c.active) }, (_, k) => `<span class="mk-face" style="background:${COLORS[(i + k) % COLORS.length]}">${LETTERS[(i * 3 + k) % LETTERS.length]}</span>`).join('')}</span>`;
    if (opt === 'A') {
      if (c.active || c.live) {
        const parts = [];
        if (c.active) parts.push(`<span>${c.live ? `${c.active} active` : `${c.active} active this week`}</span>`);
        if (c.live) parts.push(`<span class="cm-week-live">${word(c.live, 'change', 'changes')} live this week</span>`);
        more.innerHTML = `<span class="cm-card-week"><span class="cm-week-in">${parts.join('')}</span></span>`;
      }
    } else if (opt === 'B') {
      const rows = [];
      if (c.desc) rows.push(`<span class="mk-desc">${c.desc}</span>`);
      if (c.active || c.live) {
        const bits = [];
        if (c.active) bits.push(`<span class="mk-grp">${faces()}<span>${c.active} active this week</span></span>`);
        if (c.live) bits.push(`<span class="mk-live">${TICK}${word(c.live, 'change', 'changes')} live</span>`);
        rows.push(`<span class="mk-week">${bits.join('')}</span>`);
      }
      more.innerHTML = rows.join('');
    } else if (opt === 'E') {
      const m = card.querySelector('.cm-card-members');
      const members = word(c.members, 'member', 'members');
      m.innerHTML = c.active
        ? `<span class="mk-grp" style="gap:4px">${faces()}<span>${members},</span></span><span>${c.active} active this week</span>`
        : `<span>${members}</span>`;
      if (c.live) {
        const live = document.createElement('span');
        live.className = 'mk-live-line';
        live.innerHTML = `${TICK}${word(c.live, 'change', 'changes')} live this week`;
        card.querySelector('.cm-card-id').appendChild(live);
      }
    } else if (opt === 'G' || opt === 'G2') {
      const id = card.querySelector('.cm-card-id');
      const name = id.querySelector('.cm-card-name'); const m = id.querySelector('.cm-card-members');
      const top = document.createElement('span'); top.className = 'mk-top';
      id.insertBefore(top, name); top.append(name, m);
      if (c.active || c.live) {
        const row = document.createElement('span'); row.className = 'mk-weekrow';
        row.innerHTML = (c.active ? `<span class="mk-grp">${faces()}<span>${c.active} active this week</span></span>` : '')
          + (c.live ? `<span class="mk-live">${TICK}${word(c.live, 'change', 'changes')} live this week</span>` : '');
        id.appendChild(row);
      }
    } else if (opt === 'H') {
      const m = card.querySelector('.cm-card-members');
      const members = word(c.members, 'member', 'members');
      m.innerHTML = (c.active ? faces() : '') + `<span>${members}</span>`;
      if (c.live) {
        const live = document.createElement('span');
        live.className = 'mk-live-line';
        live.innerHTML = `${TICK}${word(c.live, 'change', 'changes')} live this week`;
        card.querySelector('.cm-card-id').appendChild(live);
      }
    } else if (opt === 'D') {
      const rows = [];
      if (c.active || c.live) {
        const bits = [];
        if (c.active) bits.push(`<span class="mk-grp">${faces()}<span>${c.active} active this week</span></span>`);
        if (c.live) bits.push(`<span class="mk-live">${TICK}${word(c.live, 'change', 'changes')} live this week</span>`);
        rows.push(`<span class="mk-week">${bits.join('')}</span>`);
      }
      if (c.desc) rows.push(`<span class="mk-desc">${c.desc}</span>`);
      more.innerHTML = rows.join('');
    } else if (opt === 'C') {
      card.querySelector('.cm-card-members').textContent = word(c.members, 'member', 'members') + (c.active ? ` · ${c.active} active this week` : '');
      if (c.live && c.latest) {
        more.innerHTML = `<span class="mk-new">${TICK}<span>${c.latest}</span></span><span class="mk-sub">${c.live > 1 ? `and ${c.live - 1} more ${c.live - 1 === 1 ? 'change' : 'changes'} live this week` : 'Live this week'}</span>`;
      } else if (c.desc) {
        more.innerHTML = `<span class="mk-desc">${c.desc}</span>`;
      }
    }
    if (more.innerHTML) card.appendChild(more);
    grid.appendChild(card);
  });
  document.querySelector('#communities-joined-section').scrollIntoView({ block: 'start' });
}

(async () => {
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  const shapes = [['1440', { width: 1440, height: 900 }, false], ['1024', { width: 1024, height: 768 }, false], ['393', { width: 393, height: 852 }, true]];
  for (const [w, viewport, mobile] of shapes) {
    for (const opt of (process.env.OPTS || 'now,A,B,C,D').split(',')) {
      const ctx = await b.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, ...(mobile ? { userAgent: UA } : {}), storageState: '/home/user/hr-lab/state/usernode-capture.json', serviceWorkers: 'block' });
      await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch {} });
      const p = await ctx.newPage();
      await p.goto('http://127.0.0.1:3000/#communities'); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(2000);
      await p.addStyleTag({ content: CSS });
      await p.evaluate(render, { opt, data: DATA });
      await p.waitForTimeout(700);
      const r = await p.evaluate(() => { const s = document.querySelector('#communities-joined-section'); const q = s.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; });
      await p.screenshot({ path: `${process.env.MOCK_OUT || '/home/user/hr-lab/review/img'}/j-${opt}-${w}.png`, clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(viewport.width - Math.max(0, r.x - 8), r.w + 16), height: Math.min(viewport.height - Math.max(0, r.y - 8), r.h + 16) } });
      await ctx.close();
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
