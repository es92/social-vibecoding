'use strict';

// #4490: a picture on every Needs-you card. The card's fallback order
// (shots, then the author's or a group decision's diagram, then a legacy
// capture pair, then "What it touches", then the spacer), the shared renderer
// in frontend/src/lib/diagram/, the Mermaid kind's strict, on-demand loading,
// and the Communities feed carrying the same pictures as a project's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const route = require('../src/routes/workshop-overview');

const RENAME = { version: 1, kind: 'rename', from: 'spec', to: 'plan', places: ['Chat cards', 'Buttons'], note: 'Only the words change.' };

test('the card shows shots first, then the diagram, the legacy pair, "What it touches" and the spacer', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const at = src.indexOf('{shots && row.visuals ? <ShotsPicture');
  assert.ok(at > 0, 'the picture slot');
  const slot = src.slice(at, src.indexOf('<div className="dev-ws-item-caption">', at));
  const order = ['<ShotsPicture', "picture.kind === 'diagram'", '<BeforeAfter', "picture.kind === 'touches'", 'dev-ws-item-spacer'];
  let last = -1;
  for (const mark of order) {
    const i = slot.indexOf(mark);
    assert.ok(i > last, `${mark} comes after the one before it`);
    last = i;
  }
  // Shots always win: usePicture says nothing when the row has screens.
  assert.match(src, /function usePicture\(row: QueueRow, shots: boolean\): Picture \{[\s\S]*?if \(shots\) return \{ kind: 'none' \};/);
  // A Mermaid diagram that cannot be drawn drops to "What it touches".
  assert.match(src, /if \(d && !failed\) return \{ kind: 'diagram'[\s\S]*?return touches \? \{ kind: 'touches', t: touches \} : \{ kind: 'none' \};/);
  // The summary keeps its place above the picture, clamped shorter.
  assert.match(src, /picture\.kind === 'diagram' \|\| picture\.kind === 'touches' \? 'dev-ws-item-summary dev-ws-item-summary-short'/);
  assert.match(read('public/css/app.css'), /\.dev-ws-item-summary\.dev-ws-item-summary-short \{ -webkit-line-clamp: 3; \}/);
  // A far card's Mermaid diagram waits until the reader is near it.
  assert.match(src, /defer=\{!near\}/);
});

test('each fixed kind renders as text, with its label and where it came from', () => {
  const entry = 'frontend/src/lib/diagram/diagram.tsx';
  const rename = renderComponent(entry, 'Diagram', { d: RENAME, source: 'author' });
  assert.match(rename, /data-ws-diagram="rename"/);
  assert.match(rename, /data-diagram-source="author"/);
  assert.match(rename, />Rename</);
  assert.match(rename, /dev-ws-diagram-old">spec</);
  assert.match(rename, /dev-ws-diagram-new">plan</);
  assert.match(rename, /Diagram by the change’s author/);
  const flow = renderComponent(entry, 'Diagram', { d: { version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] }, source: 'decision' });
  assert.match(flow, /dev-ws-diagram-step dev-ws-diagram-new" data-differs="">Checks</, 'the new step is marked');
  assert.match(flow, /From the group decision/);
  const changes = renderComponent(entry, 'Diagram', { d: { version: 1, kind: 'changes', rows: [{ op: 'removed', what: '<b>x</b>' }] }, source: 'author' });
  assert.match(changes, /&lt;b&gt;x&lt;\/b&gt;/, 'an author’s words are text');
  const numbers = renderComponent(entry, 'Diagram', { d: { version: 1, kind: 'numbers', unit: 's', rows: [{ label: 'Load', before: 2.4, after: 0.9 }] }, source: 'author' });
  assert.match(numbers, /2\.4 s/);
  assert.match(numbers, /0\.9 s/);
  // A Mermaid diagram draws nothing in the render pass: the library is
  // loaded in an effect, and a deferred one not at all.
  const mermaid = renderComponent(entry, 'Diagram', { d: { version: 1, kind: 'mermaid', source: 'flowchart TD\n  A --> B' }, source: 'author', defer: true });
  assert.match(mermaid, /dev-ws-diagram-wait/);
  assert.match(mermaid, /Diagram by the change’s author · Mermaid/);
  assert.doesNotMatch(mermaid, /<svg/);
});

test('a group decision draws from its own facts, never a secret’s value', () => {
  const lib = loadTsx('frontend/src/lib/diagram/diagram.tsx');
  assert.deepEqual(lib.decisionDiagram({ kind: 'rename', newName: 'Recipe Box' }, 'Staging demo app'),
    { version: 1, kind: 'rename', from: 'Staging demo app', to: 'Recipe Box', places: ['Project name'] });
  assert.equal(lib.decisionDiagram({ kind: 'rename', newName: 'Same' }, 'Same'), null);
  assert.equal(lib.decisionDiagram({ kind: 'close_issue', issueNumber: 12, issueTitle: 'Dark mode', reason: 'Obsolete' }, null).rows[0].what, '#12 Dark mode');
  assert.equal(lib.decisionDiagram({ kind: 'secret_change', key: 'API_KEY', action: 'set' }, null).rows[0].detail, 'A secret setting, value not shown');
  assert.equal(lib.decisionDiagram({ kind: 'maintenance_campaign' }, null), null);
  // The server names the fields one by one.
  assert.deepEqual(route.decisionFacts('secret_change', { key: 'API_KEY', action: 'set', value: 'hunter2', hasValue: true }),
    { kind: 'secret_change', key: 'API_KEY', action: 'set' });
  assert.equal(route.decisionFacts('featured_illustration', { proposed: {} }), null);
  assert.match(read('public/js/app-view.js'), /_decisionFacts\(item\) \{[\s\S]*?action: p\.action === 'delete' \? 'delete' : 'set' \}/);
  // A read of a value of the wrong shape draws nothing rather than half.
  assert.equal(lib.readDiagram({ version: 1, kind: 'rename', from: 'a' }), null);
  assert.equal(lib.readDiagram({ version: 1, kind: 'svg' }), null);
});

test('"What it touches" lists the four main areas, dims the empty ones and says when nothing on screen changes', () => {
  const html = renderComponent('frontend/src/features/dev-board/workshop/touches.tsx', 'TouchesPicture', {
    t: { version: 1, files: 3, areas: [
      { key: 'screens', label: 'Screens', files: 0, lines: 0 },
      { key: 'server', label: 'Server', files: 2, lines: 64 },
      { key: 'database', label: 'Database', files: 0, lines: 0 },
      { key: 'tests', label: 'Tests', files: 1, lines: 38 },
      { key: 'docs', label: 'Docs', files: 0, lines: 0 },
      { key: 'other', label: 'Other', files: 0, lines: 0 },
    ] },
    nothingVisible: true,
  });
  assert.match(html, /data-ws-touches=""/);
  assert.match(html, /What it touches/);
  assert.match(html, />Screens<[\s\S]*?>none</);
  assert.match(html, />Server<[\s\S]*?>2 files</);
  assert.doesNotMatch(html, />Docs</, 'an empty minor area is left out');
  assert.match(html, /Nothing on screen changes · drawn from the change’s files/);
});

test('Mermaid is the vendored copy, loaded on demand under strict settings and cleaned before it is shown', () => {
  const src = read('frontend/src/lib/diagram/mermaid.ts');
  const m = src.match(/MERMAID_SRC = '(\/vendor\/mermaid-[\d.]+\.min\.js)'/);
  assert.ok(m, 'one pinned path');
  assert.ok(fs.statSync(path.join(ROOT, 'public', m[1])).size > 1_000_000, 'vendored beside marked and DOMPurify');
  assert.ok(read('public/vendor/README.md').includes(path.basename(m[1])), 'with its provenance row');
  assert.ok(read('scripts/vendor-assets.js').includes(`to: '${path.basename(m[1])}'`), 'written by vendor:assets');
  assert.ok(!read('public/sw.js').includes('mermaid'), 'not precached');
  assert.ok(!read('frontend/src/head.html').includes('mermaid'), 'not a script tag');
  const lib = loadTsx('frontend/src/lib/diagram/mermaid.ts');
  const config = lib.mermaidConfig(false);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.htmlLabels, false);
  assert.equal(config.flowchart.htmlLabels, false);
  assert.equal(config.startOnLoad, false);
  assert.equal(config.suppressErrorRendering, true, 'a bad source throws to us, not into the page');
  assert.equal(config.logLevel, 5, 'fatal only: nothing reaches the console as an error');
  assert.equal(lib.mermaidConfig(true).theme, 'dark');
  assert.equal(lib.MAX_PARTS, 30);
  assert.match(src, /purify\.sanitize\(svg, \{ USE_PROFILES: \{ svg: true, svgFilters: true \}/);
  assert.match(src, /if \(nodes > MAX_PARTS \|\| edges > MAX_PARTS\) throw/);
});

test('the Communities feed carries the same pictures, shots included', () => {
  const sql = route.NEEDS_FEED_SQL;
  for (const col of ['shots_run_id', 'shots_detail', 'pr_diagram', 'pr_touches', 'pr_touches_sha', 'visuals_agg', 'decision_kind', 'decision_payload']) {
    assert.match(sql, new RegExp(`o\\.${col}`), `the feed reads ${col}`);
  }
  const head = 'c'.repeat(40);
  const touches = { version: 1, files: 1, areas: [{ key: 'server', label: 'Server', files: 1, lines: 4 }] };
  const fields = route.pictureFields({
    kind: 'proposal', source: 'native', reviewed_head_sha: head,
    pr_diagram: RENAME, pr_diagram_source: 'author',
    pr_touches: touches, pr_touches_sha: head,
    shots: { state: 'verified' },
    shots_detail: { intent: { impact: 'none' } },
  });
  assert.deepEqual(fields.diagram, RENAME);
  assert.equal(fields.diagram_source, 'author');
  assert.equal(fields.touches.files, 1);
  assert.deepEqual(fields.shots, { state: 'verified' });
  assert.equal(fields.nothing_visible, true);
  assert.equal(route.pictureFields({ kind: 'proposal', reviewed_head_sha: head, pr_touches: touches, pr_touches_sha: 'd'.repeat(40) }).touches,
    undefined, '"What it touches" only for the head it was read at');
  assert.deepEqual(route.pictureFields({ kind: 'governance', name: 'Old', decision_kind: 'rename', decision_payload: { newName: 'New' } }),
    { decision: { kind: 'rename', newName: 'New', fromName: 'Old' } });

  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const shaped = { path: 'Before & after', mobile: false, before: '/a', after: '/b', protected: true, screens: [] };
  const prevWindow = global.window;
  global.window = { AppView: { _workshopVisuals: (visuals, shots) => (shots ? shaped : null) } };
  try {
    const app = { slug: 's', name: 'S', icon_url: null, icon_emoji: null };
    const [change, decision] = reel.reelRows([
      { kind: 'proposal', id: 1, title: 'T', summary: null, author: null, number: null, epoch: 0, at: null, yes: 0, no: 0,
        shots: { state: 'verified' }, diagram: RENAME, diagram_source: 'author', touches, nothing_visible: true, app },
      { kind: 'governance', id: 2, title: 'R', summary: null, author: null, number: null, epoch: null, at: null, yes: null, no: null,
        decision: { kind: 'rename', newName: 'New' }, app },
    ]);
    assert.equal(change.visuals, shaped, 'the project page’s own shaping, not null');
    assert.deepEqual(change.diagram, RENAME);
    assert.equal(change.diagramSource, 'author');
    assert.equal(change.touches, touches);
    assert.equal(change.nothingVisible, true);
    assert.equal(decision.visuals, null);
    assert.deepEqual(decision.decision, { kind: 'rename', newName: 'New' });
  } finally { global.window = prevWindow; }
});

test('the project list and a change’s page carry the diagram; a moved head is read again in the background', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /cs\.pr_diagram, cs\.pr_diagram_source, cs\.pr_touches, cs\.pr_touches_sha,/);
  assert.match(votes, /proposalTouches\.scheduleRefresh\(pool, rows\.map/);
  assert.match(votes, /row\.touches = head && row\.pr_touches_sha === head \? proposalTouches\.storedTouches\(row\.pr_touches\) : null;/);
  assert.match(votes, /proposal\.diagram = diagramContract\.storedDiagram\(/);
  const view = read('public/js/app-view.js');
  assert.match(view, /\.\.\.AppView\._workshopPicture\(kind, item\),/);
  assert.match(view, /diagram: item && item\.diagram && typeof item\.diagram === 'object' \? item\.diagram : null,/);
  assert.match(read('frontend/src/features/dev-board/topic/change-head.tsx'), /<ChangeDiagram value=\{body\.diagram\} \/>\s*<RequestWords/);
});

test('staging holds each picture under ?demo=1, and ?shot= opens the feed on it', () => {
  const votes = require('../src/routes/votes');
  void votes;
  const src = read('src/routes/votes.js');
  assert.match(src, /mk\(9000490, 900490,\s*'\[Mock\] Diagram test/);
  assert.match(src, /mk\(9000491, 900491,\s*'\[Mock\] What-it-touches test/);
  assert.match(src, /mk\(9000492, 900492,\s*'\[Mock\] Mermaid test/);
  const demo = route.DEMO_NEEDS_FEED;
  assert.ok(demo.some((it) => it.diagram && it.diagram.kind === 'changes'));
  assert.ok(demo.some((it) => it.touches));
  assert.ok(demo.some((it) => it.decision && it.decision.kind === 'rename'));
  const diagram = require('../src/services/diagram');
  for (const it of demo) if (it.diagram) assert.ok(diagram.storedDiagram(it.diagram), `${it.title}: a valid record`);
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /shot === 'needs-diagram' \? 'diagram' : shot === 'needs-touches' \? 'touches'/);
  const check = require('../dapp.json').tests.find((t) => /author's diagram under that sentence/.test(t.name));
  assert.ok(check, 'folded into the existing Needs-you item check');
  assert.match(check.expectSelector, /:has\(\.dev-ws-item-summary \+ \[data-ws-diagram=rename\]\)/);
  assert.ok(check.expectSelector.length <= 256, "the runner clips selectors at 256 characters");
});
