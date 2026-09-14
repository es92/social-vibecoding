// #1037: the Mayor can FILE issues. Asked to "create a platform issue for
// step 2" it used to explain that it can only READ the tracker and offer
// the user a choice between Send Feedback and dispatching a coding agent
// to draft a report card. It now calls draft_issue_report in-process,
// which posts the same human-gated card the build agent's CLI posts.
//
// Covered here: the gated FILING ISSUES prompt block, the tool's schema
// and its membership in the in-process resolution sets, the status line,
// the amended read-only tool descriptions, and the phase-1 ordering trap
// (draft_issue_report emitted ALONGSIDE a terminal tool must still create
// the card — that combination is the common case, not an edge case).
//
// Run with: node --test tests/mayor-issue-drafting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mayor-issue-drafting-test-secret';

const sessions = require('../src/routes/sessions');
const issueDraft = require('../src/services/issue-draft');

const {
  getMayorSystemPrompt,
  DATA_TOOL_NAMES,
  IN_PROCESS_TOOL_NAMES,
  DRAFT_TOOL_NAME,
  DRAFT_ISSUE_REPORT_TOOL,
  LIST_GITHUB_ISSUES_TOOL,
  GET_GITHUB_ISSUE_TOOL,
  resolveDataToolResult,
  dataToolStatusLine,
} = sessions;

// ── The prompt block ───────────────────────────────────────────────────

const promptWith = (canDraft) =>
  getMayorSystemPrompt('Demo App', false, '', false, null, '', '', false, '', canDraft);

test('mayor prompt: the FILING ISSUES block is present iff drafting is possible', () => {
  const withBlock = promptWith(true);
  assert.match(withBlock, /FILING ISSUES/);
  assert.match(withBlock, /draft_issue_report/);

  const without = promptWith(false);
  assert.doesNotMatch(without, /FILING ISSUES/);
  assert.doesNotMatch(without, /draft_issue_report/,
    'the tool is never named when it is not offered');
});

test('mayor prompt: canDraftIssues defaults to false (headless call shape stays clean)', () => {
  // Headless call sites pass at most the first five args.
  const prompt = getMayorSystemPrompt('Demo App', false, '', false, null);
  assert.doesNotMatch(prompt, /FILING ISSUES/);
  assert.doesNotMatch(prompt, /draft_issue_report/);
});

test('mayor prompt: the block forbids the exact non-answer this issue is about', () => {
  const p = promptWith(true);
  // The reported behaviour: "I can only read the issue tracker … file it
  // yourself via Send Feedback, or say the word and I'll have the agent
  // draft a report card."
  assert.match(p, /NEVER answer such a request by saying you can only read the issue tracker/);
  assert.match(p, /NEVER offer Send Feedback as the alternative/);
  assert.match(p, /NEVER ask the user to choose between two paths/i);
  assert.match(p, /Do NOT dispatch the coding agent to draft a report card/);
});

test('mayor prompt: the block names the trigger phrasings and both targets', () => {
  const p = promptWith(true);
  for (const phrase of ['create', 'file', 'open', 'log', 'raise']) {
    assert.ok(p.includes(phrase), `trigger verb "${phrase}" named`);
  }
  assert.match(p, /create a platform issue for step 2/, 'the reported phrasing is quoted verbatim');
  assert.match(p, /"platform" for anything about Homeroom itself/);
  assert.match(p, /"app" for a bug or request about Demo App itself/);
});

test('mayor prompt: the block forbids claiming the issue was filed', () => {
  const p = promptWith(true);
  assert.match(p, /NEVER say the issue has been filed or created/);
  assert.match(p, /nothing reaches GitHub until the user taps/);
});

test('mayor prompt: the block carves the drafting turn out of the clarity gate', () => {
  const p = promptWith(true);
  assert.match(p, /CLARITY GATE carve-out/);
  assert.match(p, /the card IS the clarification surface/);
  // ...without weakening the gate itself for everything else.
  assert.match(p, /CLARITY GATE — ask before acting on unclear requests/);
});

test('mayor prompt: the block rides alongside the other gated blocks', () => {
  const p = getMayorSystemPrompt('Demo App', false, 'spec text', true, null, '', '', true, '', true);
  assert.match(p, /FILING ISSUES/);
  assert.match(p, /PRODUCTION DEBUG/, 'prod-debug block still present');
  assert.match(p, /CURRENT SPEC DOC/, 'the spec block still renders after it');
  assert.match(p, /spec text/);
});

// ── The tool ───────────────────────────────────────────────────────────

test('draft_issue_report: schema enumerates both targets and requires real content', () => {
  assert.equal(DRAFT_ISSUE_REPORT_TOOL.name, DRAFT_TOOL_NAME);
  const props = DRAFT_ISSUE_REPORT_TOOL.input_schema.properties;
  assert.deepEqual(props.target.enum, ['platform', 'app']);
  assert.deepEqual(
    [...DRAFT_ISSUE_REPORT_TOOL.input_schema.required].sort(),
    ['body', 'target', 'title']
  );
  // The description has to carry the human gate — the model writes its
  // reply from it as much as from the prompt block.
  assert.match(DRAFT_ISSUE_REPORT_TOOL.description, /ONE TAP/);
  assert.match(DRAFT_ISSUE_REPORT_TOOL.description, /files NOTHING by itself/);
  assert.match(DRAFT_ISSUE_REPORT_TOOL.description, /deduped/);
  assert.match(DRAFT_ISSUE_REPORT_TOOL.description, /not_configured/);
  // The caps the service enforces are stated so the model doesn't blow them.
  assert.match(props.title.description, new RegExp(String(issueDraft.TITLE_MAX)));
  assert.match(props.body.description, new RegExp(String(issueDraft.BODY_MAX)));
});

test('draft_issue_report is resolved in-process but is NOT a read-only data tool', () => {
  assert.ok(IN_PROCESS_TOOL_NAMES.has(DRAFT_TOOL_NAME), 'the loop services it');
  assert.ok(!DATA_TOOL_NAMES.has(DRAFT_TOOL_NAME),
    'it has a side effect — the read-only guarantees on DATA_TOOL_NAMES must stay true');
  for (const n of DATA_TOOL_NAMES) {
    assert.ok(IN_PROCESS_TOOL_NAMES.has(n), `${n} is still in the superset`);
  }
});

test('the drafting status line wins over a read riding along in the same batch', () => {
  assert.equal(dataToolStatusLine([{ name: DRAFT_TOOL_NAME, input: {} }]),
    'Drafting an issue report...');
  assert.equal(
    dataToolStatusLine([{ name: 'list_github_issues' }, { name: DRAFT_TOOL_NAME, input: {} }]),
    'Drafting an issue report...'
  );
  // Unchanged for everything else.
  assert.equal(dataToolStatusLine([{ name: 'list_github_issues' }]),
    "Reading the repo's GitHub issues...");
  assert.equal(dataToolStatusLine([{ name: 'get_prod_status' }]),
    'Checking production status...');
});

test('the read-only issue tools point at draft_issue_report instead of refusing', () => {
  for (const tool of [LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL]) {
    assert.match(tool.description, /draft_issue_report/,
      `${tool.name} names the way to file`);
    assert.match(tool.description, /never tell the user\s+you are unable to open issues/,
      `${tool.name} forbids the "I can only read the tracker" answer`);
    // The read-only fact about THIS tool must survive.
    assert.match(tool.description, /only READS/);
    assert.ok(!/it cannot create, comment on, edit, or close/.test(tool.description),
      `${tool.name} no longer claims the Mayor cannot create issues`);
  }
});

// ── Resolution ─────────────────────────────────────────────────────────

function stubCreateDraft(t, impl) {
  const orig = issueDraft.createDraft;
  const calls = [];
  issueDraft.createDraft = async (...args) => {
    calls.push(args);
    return impl ? impl(...args) : { ok: true, suggested: true, msgId: 7, target: 'platform' };
  };
  t.after(() => { issueDraft.createDraft = orig; });
  return calls;
}

test('resolveDataToolResult routes a draft call to createDraft as a user request', async (t) => {
  const calls = stubCreateDraft(t);
  const ctx = { pool: {}, config: { platformRepoUrl: 'https://github.com/o/r' }, sessionId: 12 };

  const out = await resolveDataToolResult(
    { id: 'tu1', name: DRAFT_TOOL_NAME, input: { target: 'app', title: 'T', body: 'B' } },
    'o', 'r', ctx, null
  );

  assert.deepEqual(JSON.parse(out), { ok: true, suggested: true, msgId: 7, target: 'platform' });
  assert.equal(calls.length, 1);
  const [, , opts] = calls[0];
  assert.deepEqual(
    { sessionId: opts.sessionId, title: opts.title, body: opts.body, target: opts.target, source: opts.source },
    { sessionId: 12, title: 'T', body: 'B', target: 'app', source: 'user_request' },
    'a Mayor-drafted card is always sourced as an explicit user request'
  );
});

test('a draft call with no session context resolves to not_configured, never a throw', async (t) => {
  const calls = stubCreateDraft(t);
  const out = await resolveDataToolResult(
    { id: 'tu1', name: DRAFT_TOOL_NAME, input: { target: 'app', title: 'T', body: 'B' } },
    'o', 'r', null, null
  );
  assert.deepEqual(JSON.parse(out), { ok: false, code: 'not_configured' });
  assert.equal(calls.length, 0, 'nothing is drafted without a session to attach it to');
});

test('a de-duped result reaches the model verbatim so it can name the existing issue', async (t) => {
  stubCreateDraft(t, async () => ({ ok: true, deduped: true, number: 42, url: 'https://gh/42' }));
  const out = await resolveDataToolResult(
    { id: 'tu1', name: DRAFT_TOOL_NAME, input: { target: 'platform', title: 'T', body: 'B' } },
    'o', 'r', { pool: {}, config: {}, sessionId: 1 }, null
  );
  assert.deepEqual(JSON.parse(out), { ok: true, deduped: true, number: 42, url: 'https://gh/42' });
});

// ── The phase-1 ordering trap ──────────────────────────────────────────
//
// Parallel tool use means the Mayor routinely emits draft_issue_report
// ALONGSIDE suggest_replies. The loop breaks on a terminal tool without
// re-invoking (a dangling tool_use would 400 the next call) — so if the
// draft were only resolved on the re-invocation path, the single most
// common shape of a "create an issue" turn would silently produce no
// card. This reproduces the loop's decision logic against the exported
// sets and asserts the draft is still executed.

function loopDecision(toolUses, dataIters = 0, MAX = 3) {
  const dataCalls = toolUses.filter((t) => IN_PROCESS_TOOL_NAMES.has(t.name));
  const hasTerminalTool = toolUses.some((t) =>
    t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'
    || t.name === 'suggest_answers' || t.name === 'suggest_replies');
  if (!dataCalls.length || dataIters >= MAX) return { resolve: [], reinvoke: false };
  if (hasTerminalTool) {
    return { resolve: dataCalls.filter((t) => t.name === DRAFT_TOOL_NAME), reinvoke: false };
  }
  return { resolve: dataCalls, reinvoke: true };
}

test('phase-1: draft + suggest_replies resolves the draft and skips only the re-invocation', () => {
  const d = loopDecision([
    { id: 'a', name: DRAFT_TOOL_NAME },
    { id: 'b', name: 'suggest_replies' },
  ]);
  assert.deepEqual(d.resolve.map((t) => t.id), ['a'], 'the card is still created');
  assert.equal(d.reinvoke, false, 'no re-invocation — the terminal tool_use would dangle');
});

test('phase-1: draft + dispatch resolves the draft before handing off to phase-2', () => {
  const d = loopDecision([
    { id: 'a', name: 'dispatch_claude_code' },
    { id: 'b', name: DRAFT_TOOL_NAME },
  ]);
  assert.deepEqual(d.resolve.map((t) => t.id), ['b']);
  assert.equal(d.reinvoke, false);
});

test('phase-1: a READ riding along with a terminal tool is still dropped (unchanged)', () => {
  const d = loopDecision([
    { id: 'a', name: 'list_github_issues' },
    { id: 'b', name: 'suggest_replies' },
  ]);
  assert.deepEqual(d.resolve, [], 'a re-fetchable read needs no side effect here');
  assert.equal(d.reinvoke, false);
});

test('phase-1: a lone draft call resolves AND re-invokes so the Mayor can reply about it', () => {
  const d = loopDecision([{ id: 'a', name: DRAFT_TOOL_NAME }]);
  assert.deepEqual(d.resolve.map((t) => t.id), ['a']);
  assert.equal(d.reinvoke, true, 'the model sees the result and writes "tap to confirm"');
});

// ── The phase-2 stray branch ───────────────────────────────────────────

function phase2Content(tu, activeId, memo) {
  if (tu.id === activeId) return 'terminal result';
  if (memo.has(tu.id)) return memo.get(tu.id);
  if (IN_PROCESS_TOOL_NAMES.has(tu.name)) return 'freshly resolved';
  return 'Skipped — only one action runs per turn.';
}

test('phase-2: a stray draft is answered from the memo, never re-drafted or skipped', () => {
  const memo = new Map([['b', '{"ok":true,"suggested":true,"msgId":7}']]);
  const tools = [
    { id: 'a', name: 'dispatch_claude_code' },
    { id: 'b', name: DRAFT_TOOL_NAME },
  ];
  const out = tools.map((tu) => phase2Content(tu, 'a', memo));
  assert.equal(out[0], 'terminal result');
  assert.equal(out[1], '{"ok":true,"suggested":true,"msgId":7}',
    'the already-created card is reported, not created a second time');
  assert.ok(!out[1].includes('Skipped'),
    'dropping it would silently lose the issue the user asked for');
});

test('phase-2: an unknown tool still gets the benign skip note', () => {
  const out = phase2Content({ id: 'z', name: 'something_else' }, 'a', new Map());
  assert.equal(out, 'Skipped — only one action runs per turn.');
});
