'use strict';

// #4490: the diagram record (src/services/diagram.js), shared with #4098.
// Validation and caps per kind, the Mermaid rules (only beside impact
// "none"; no directive, interaction, CSS URL or tag), the text a pull
// request carries, and the ```diagram / ```mermaid fences.

const test = require('node:test');
const assert = require('node:assert/strict');

const diagram = require('../src/services/diagram');

const MERMAID = 'flowchart TD\n  A[Copy database] --> B{Hiccup?}\n  B -- yes --> C[Retry up to 3 times]\n  C --> B';

test('the four fixed kinds are accepted and normalised', () => {
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'rename', from: ' spec ', to: 'plan', places: ['Chat cards', 'Buttons'], note: 'Only the words change.' }),
    { version: 1, kind: 'rename', from: 'spec', to: 'plan', places: ['Chat cards', 'Buttons'], note: 'Only the words change.' },
  );
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] }),
    { version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] },
  );
  assert.equal(diagram.parseDiagram({ version: 1, kind: 'changes', rows: [{ op: 'added', what: 'A setting' }] }).rows[0].op, 'added');
  assert.deepEqual(
    diagram.parseDiagram({ version: 1, kind: 'numbers', unit: 's', rows: [{ label: 'Load time', before: 2.4, after: '0.9' }] }).rows[0],
    { label: 'Load time', before: 2.4, after: 0.9 },
  );
});

test('every text is 1 to 60 characters and every list is capped', () => {
  const long = 'x'.repeat(61);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: long, to: 'plan' }), /diagram\.from: at most 60/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: '', to: 'plan' }), /diagram\.from: required/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'b', places: Array(9).fill('p') }), /diagram\.places: 0 to 8/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'flow', before: Array(7).fill('s'), after: ['t'] }), /diagram\.before: 1 to 6/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'changes', rows: Array(7).fill({ op: 'added', what: 'w' }) }), /diagram\.rows: 1 to 6/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'changes', rows: [{ op: 'renamed', what: 'w' }] }), /added, changed or removed/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'numbers', rows: [{ label: 'x', before: Infinity, after: 1 }] }), /finite number/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'a' }), /must differ/);
});

test('no other kind, version or field is accepted, and nothing is half drawn', () => {
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'svg', svg: '<svg/>' }), (err) => err.code === 'invalid_diagram' && /rename, flow, changes or numbers/.test(err.message));
  assert.throws(() => diagram.parseDiagram({ version: 2, kind: 'rename', from: 'a', to: 'b' }), /version: must be 1/);
  assert.throws(() => diagram.parseDiagram({ version: 1, kind: 'rename', from: 'a', to: 'b', html: '<b>x</b>' }), /unknown field "html"/);
  assert.throws(() => diagram.parseDiagram('rename'), /must be an object/);
  assert.equal(diagram.storedDiagram({ version: 1, kind: 'rename', from: 'a' }), null);
});

test('Mermaid is accepted only beside visible changes of impact "none"', () => {
  const record = { version: 1, kind: 'mermaid', source: MERMAID };
  assert.equal(diagram.parseDiagram(record, { impact: 'none' }).source, MERMAID);
  assert.throws(() => diagram.parseDiagram(record, { impact: 'ui' }), /only for a change nobody sees.*declares "ui".*rename, flow, changes or numbers/);
  assert.throws(() => diagram.parseDiagram(record), /declares no visibleChanges/);
  // A stored one is read back without the question being asked again.
  assert.equal(diagram.storedDiagram(record).kind, 'mermaid');
});

test('Mermaid source is checked without Mermaid: type, size, directives, interaction, URLs and tags', () => {
  const ok = (source) => diagram.checkMermaidSource(source);
  for (const type of ['flowchart LR', 'graph TD', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram']) {
    assert.ok(ok(`${type}\n  A --> B`));
  }
  assert.ok(ok('sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi'));
  assert.ok(ok('classDiagram\n  Animal <|-- Duck'));
  assert.throws(() => ok('gantt\n  title x'), /must open with one of/);
  assert.throws(() => ok('%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A --> B'), /directives/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  click A "https://example.com"'), /"click" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[href] --> B'), /"href" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  click A callback'), /not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[javascript:alert(1)] --> B'), /javascript:/);
  assert.throws(() => ok('flowchart TD\n  A --> B\n  style A fill:url(https://example.com/x)'), /"url\(" is not allowed/);
  assert.throws(() => ok('flowchart TD\n  A[<img src=x>] --> B'), /only in arrows/);
  assert.throws(() => ok('flowchart TD\n  A[x > 3] --> B'), /only in arrows/);
  assert.throws(() => ok(`flowchart TD\n${'  A --> B\n'.repeat(40)}`), /at most 40 lines/);
  assert.throws(() => ok(`flowchart TD\n  A[${'x'.repeat(2000)}] --> B`), /at most 2000 characters/);
});

test('the pull request carries a text version, and a ```mermaid block for Mermaid', () => {
  const rename = { version: 1, kind: 'rename', from: 'spec', to: 'plan', places: ['Chat cards', 'Buttons'] };
  assert.equal(diagram.toMarkdown(rename), '**Rename:** spec → plan (Chat cards, Buttons)');
  assert.match(diagram.toMarkdown({ version: 1, kind: 'flow', before: ['Vote', 'Closes'], after: ['Vote', 'Checks', 'Closes'] }),
    /- Before: Vote → Closes\n- After: Vote → Checks → Closes/);
  assert.match(diagram.toMarkdown({ version: 1, kind: 'numbers', unit: 's', rows: [{ label: 'Load time', before: 2.4, after: 0.9 }] }),
    /- Load time: 2\.4 s → 0\.9 s/);
  assert.equal(diagram.toMarkdown({ version: 1, kind: 'mermaid', source: MERMAID }), `\`\`\`mermaid\n${MERMAID}\n\`\`\``);
  // An author's words cannot become markup or a mention on GitHub.
  assert.equal(diagram.toMarkdown({ version: 1, kind: 'rename', from: '@team', to: '[x](y)' }), '**Rename:** @​team → \\[x\\]\\(y\\)');

  const block = diagram.prBlock(rename, 'author');
  assert.ok(block.startsWith(diagram.PR_MARKER_START) && block.endsWith(diagram.PR_MARKER_END));
  assert.match(block, /## Diagram/);
  assert.match(block, /_Diagram by the change's author\._/);
  const body = diagram.upsertPrBlock('The change.', block);
  assert.equal(diagram.extractPrBlock(body), block);
  // Rewritten when it changes, and dropped when it is removed.
  const next = diagram.upsertPrBlock(body, diagram.prBlock({ ...rename, to: 'outline' }));
  assert.match(next, /spec → outline/);
  assert.doesNotMatch(next, /→ plan/);
  assert.equal(diagram.upsertPrBlock(next, ''), 'The change.');
});

test('a ```diagram or ```mermaid fence reads as the same record (#4098)', () => {
  assert.equal(diagram.fromFence('diagram', JSON.stringify({ version: 1, kind: 'rename', from: 'a', to: 'b' })).kind, 'rename');
  assert.equal(diagram.fromFence('mermaid', MERMAID).kind, 'mermaid');
  assert.throws(() => diagram.fromFence('diagram', '{not json'), /must hold the diagram's JSON/);
  assert.throws(() => diagram.fromFence('svg', '<svg/>'), /```diagram or ```mermaid/);
});

test('a regenerated pull request body carries the diagram under the summary, before the other blocks', () => {
  const { renderPrMetadataDraft } = require('../src/services/pr-metadata');
  const block = diagram.prBlock({ version: 1, kind: 'rename', from: 'spec', to: 'plan' });
  const out = renderPrMetadataDraft(
    { title: 'Rename', body: '- Renames spec to plan', summary: 'Spec is now plan.' },
    { username: 'ada', closingBlock: 'Closes #4490', testingBlock: '## How to test\n\n1. Look.', diagramBlock: block },
  );
  const body = out.body;
  assert.ok(body.indexOf('Spec is now plan.') < body.indexOf(diagram.PR_MARKER_START));
  assert.ok(body.indexOf(diagram.PR_MARKER_END) < body.indexOf('## How to test'));
  assert.ok(body.indexOf('## How to test') < body.indexOf('Closes #4490'));
  // And none at all when there is no diagram: legacy bodies stay identical.
  const plain = renderPrMetadataDraft({ title: 'T', body: 'B', summary: '' }, { username: 'ada' });
  assert.doesNotMatch(plain.body, /usernode:diagram/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/pr-metadata.js'), 'utf8'),
    /&& !shotsChanged && !diagramChanged && !summaryChanged\)/, 'a changed diagram reaches GitHub on a title-unchanged turn');
});

test('a hosted build declares its diagram beside its visible changes, on its own session only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const worker = read('worker/visible-changes-mcp.js');
  assert.match(worker, /server\.registerTool\('declare_diagram'/);
  assert.match(worker, /\/api\/internal\/sessions\/\$\{sessionId\}\/diagram/);
  assert.match(read('worker/run-codex-agent.sh'), /enabled_tools = \["declare_visible_changes", "declare_diagram"\]/);
  const internal = read('src/routes/internal.js');
  const at = internal.indexOf("router.post('/api/internal/sessions/:sessionId/diagram'");
  assert.ok(at > 0, 'the route');
  const route = internal.slice(at, internal.indexOf('\n    });\n', at));
  assert.match(route, /Number\(req\.workerSession\.sessionId\) !== sessionId/, 'its own session only');
  assert.match(route, /parseDiagram\(req\.body\?\.diagram, \{ impact: rows\[0\]\.impact \|\| null \}\)/, 'Mermaid only beside impact "none"');
  assert.match(route, /code: 'invalid_diagram'/);
  // Asked for by both build prompts, never drawn by the bot on its own.
  assert.match(read('src/routes/sessions.js'), /also call declare_diagram once with that kind/);
  assert.match(read('src/services/homeroom-bot-live.js'), /'declare_diagram once with that kind \(rename, flow, changes or numbers\)/);
});
