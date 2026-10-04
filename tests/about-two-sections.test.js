// "About this change" is two sections with two audiences.
//
// The sheet has rendered a generated summary above a collapsed PR body since
// #1370, but only for proposals built ON the platform: llm.generatePrMetadata
// writes pr_summary_md, and nothing else did. A connector submission or a
// browser import went in through the pr-import route, which stored pr_body and
// left pr_summary_md null — so those proposals showed a non-technical voter
// nothing but the diff explained in developer terms, which is the state this
// change fixes. submit_work now carries the user-facing half, and the two
// halves are labelled so they read as two sections rather than as a paragraph
// with a link underneath it.
//
// Run with: node --test tests/about-two-sections.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { topicHeadHtml, BLANK_CARD } = require('./lib/dev-card-html');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VOTES_SRC = read('src/routes/votes.js');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const LLM_SRC = read('src/services/llm.js');
const TASKS_SRC = read('src/services/external-agent-tasks.js');
const charter = require('../src/services/mcp-charter');

// ── The two labelled halves ────────────────────────────────────────────

test('a proposal summary is labelled, so the sheet reads as two sections', () => {
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this change',
    summaryHtml: '<p>Signing in now brings you back to what you were doing.</p>',
    proposalBody: { id: 7, open: false, html: '<p>Technical prose.</p>' },
  });
  assert.match(html, /About this change/);
  assert.match(html, /What changes for you/, 'the user-facing half is named');
  assert.match(html, /Signing in now brings you back/);
  assert.match(html, /Technical details/, 'and so is the technical half');
  // Order matters: the plain-English half is what a voter should hit first.
  assert.ok(html.indexOf('What changes for you') < html.indexOf('Technical details'));
});

test('the technical half stays collapsed by default', () => {
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this change',
    summaryHtml: '<p>Plain words.</p>',
    proposalBody: { id: 7, open: false, html: '<p>Technical prose.</p>' },
  });
  const details = html.slice(html.indexOf('<details'));
  assert.ok(!/^<details[^>]* open(?: |>|=)/.test(details), 'closed unless the reader opens it');
});

test('an issue body is not dressed up as a user-facing summary', () => {
  // The label is a claim about who the text was written for. An issue body
  // was written by whoever filed it, so it keeps rendering bare.
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this issue',
    issueBodyHtml: '<p>The button does nothing.</p>',
  });
  assert.match(html, /The button does nothing/);
  assert.doesNotMatch(html, /What changes for you/);
});

test('an issue author gets the body edit control in the About sheet (#2427)', () => {
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this issue',
    issueBodyHtml: '<div class="dev-issue-body"><p>The button does nothing.</p></div>',
    issueBodyEditor: { issue: 900008, markdown: 'The button does nothing.', canEdit: true },
  });
  assert.match(html, /data-issue-body-edit="900008"/);
  assert.match(html, /aria-label="Edit request"/);
  assert.match(html, /The button does nothing/);
  assert.doesNotMatch(html, /data-issue-body-editor=/, 'the textarea opens only after the author asks');
});

test('a reader sees the issue body without its author-only edit control', () => {
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this issue',
    issueBodyHtml: '<div class="dev-issue-body"><p>Read only.</p></div>',
    issueBodyEditor: { issue: 900008, markdown: 'Read only.', canEdit: false },
  });
  assert.match(html, /Read only/);
  assert.doesNotMatch(html, /data-issue-body-edit=/);
});

test('a proposal with no summary shows no label rather than an invented one', () => {
  // Every proposal imported before this change is in exactly this state, and
  // nothing generates a summary for it on the way in. An empty labelled
  // section would promise something the row does not have.
  const html = topicHeadHtml(BLANK_CARD, {
    actions: null,
    aboutTitle: 'About this change',
    proposalBody: { id: 7, open: false, html: '<p>Technical prose.</p>' },
  });
  assert.doesNotMatch(html, /What changes for you/);
  assert.match(html, /Technical details/, 'the technical half is still there');
});

// ── The import route: where the user-facing half was being dropped ─────

// The helper is a route-module internal, so it is evaluated from source
// rather than re-implemented here — a re-implementation would test the copy.
function loadParseImportSummary() {
  const m = VOTES_SRC.match(/const MAX_IMPORT_SUMMARY = (\d+);[\s\S]*?\nfunction parseImportSummary\(body\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'parseImportSummary is still shaped as expected');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${m[0]}\nglobalThis.__fn = parseImportSummary;\nglobalThis.__max = MAX_IMPORT_SUMMARY;`, sandbox);
  return { parse: sandbox.__fn, max: sandbox.__max };
}

test('an import carries the user-facing summary, trimmed', () => {
  const { parse } = loadParseImportSummary();
  assert.equal(
    parse({ summary: '  Signing in brings you back.  ' }),
    'Signing in brings you back.'
  );
});

test('an absent summary stays null, so nothing is invented on this path', () => {
  const { parse } = loadParseImportSummary();
  for (const body of [{}, { summary: '' }, { summary: '   ' }, { summary: 42 }, null, undefined]) {
    assert.equal(parse(body), null, `null for ${JSON.stringify(body)}`);
  }
});

test('an over-long summary is capped rather than costing the submission', () => {
  // It is the first thing a voter reads. An agent that pastes its whole PR
  // body here would collapse the two sections back into one, so the cap is
  // deliberately far smaller than the description's — but truncating beats
  // refusing a finished push over a long field.
  const { parse, max } = loadParseImportSummary();
  assert.ok(max > 0 && max < 4000, 'much smaller than the testing note cap');
  const long = 'x'.repeat(max + 500);
  assert.equal(parse({ summary: long }).length, max);
});

test('the import writes the summary to the column the About sheet reads', () => {
  const insert = VOTES_SRC.slice(
    VOTES_SRC.indexOf('INSERT INTO chat_sessions'),
    VOTES_SRC.indexOf('RETURNING id, status')
  );
  assert.match(insert, /pr_summary_md/, 'the column is in the imported-proposal insert');
  assert.match(VOTES_SRC, /const importSummary = parseImportSummary\(req\.body\)/);
  assert.match(VOTES_SRC, /\n\s*importSummary,\n/, 'and its value is bound');
});

// ── submit_work: how an agent supplies it ──────────────────────────────

test('submit_work takes the user-facing half and forwards it', () => {
  assert.match(TOOLS_SRC, /summary: z\.string\(\)\.optional\(\)/,
    'the parameter exists and is optional');
  const declared = TOOLS_SRC.slice(TOOLS_SRC.indexOf('summary: z.string().optional()'));
  const describe = declared.slice(0, declared.indexOf('),') + 2);
  assert.match(describe, /USER-FACING/);
  assert.match(describe, /plain everyday English/);
  assert.match(describe, /No file names, no identifiers, no code/);
  // Forwarded on the same POST the testing notes ride, and omitted when
  // blank so the route writes null.
  assert.match(TOOLS_SRC, /\{ summary: summary\.trim\(\) \}/);
  assert.match(TOOLS_SRC, /typeof summary === 'string' && summary\.trim\(\)/);
  // And it reaches the handler at all.
  assert.match(TOOLS_SRC, /title, description, summary, agent,/);
});

test('the description is named as the technical half, so the two do not blur', () => {
  const start = TOOLS_SRC.indexOf("description: z.string().optional().describe('What changed and why");
  assert.ok(start > 0, 'the description parameter is still declared here');
  const describe = TOOLS_SRC.slice(start, start + 600);
  assert.match(describe, /TECHNICAL half/);
  assert.match(describe, /Technical details/);
});

// ── What an agent actually reads ───────────────────────────────────────

test('the work order asks for both halves at the moment of submitting', () => {
  const i = TASKS_SRC.indexOf('2. SUBMIT IT YOURSELF');
  assert.ok(i > 0);
  const step = TASKS_SRC.slice(i, i + 2200);
  assert.match(step, /`summary` is the USER-FACING half/);
  assert.match(step, /`description` is the TECHNICAL half/);
  assert.match(step, /Not every member of the group is a developer/);
});

test('the charter carries the same rule without spending brief budget', () => {
  const section = charter.CHARTER_SECTIONS.find((s) => s.id === 'two-audiences');
  assert.ok(section, 'the section exists');
  assert.match(section.text, /summary` is the user-facing half/);
  assert.match(section.text, /description` is the technical half/);
  // The brief is truncated at 2048 chars by some clients, and the safety
  // clauses are what must never be cut. An optional field whose absence
  // reproduces today's behaviour has not earned a place there.
  assert.ok(!charter.BRIEF_ORDER.includes('two-audiences'),
    'charter-only, by the module\'s own rule');
  assert.ok(!section.brief, 'and it declares no brief');
  assert.ok(charter.SERVER_INSTRUCTIONS.length <= 2048,
    'the delivered instructions still fit the client cap');
});

// ── The generated half, for on-platform sessions ───────────────────────

test('the generated summary is told to keep identifiers out', () => {
  const i = LLM_SRC.indexOf('- A summary:');
  assert.ok(i > 0, 'the summary instruction is still in the PR-metadata prompt');
  const instruction = LLM_SRC.slice(i, LLM_SRC.indexOf('\n', i));
  assert.match(instruction, /plain, everyday English/);
  assert.match(instruction, /identifiers/, 'names what must not appear');
  assert.match(instruction, /must not appear here/);
  assert.match(instruction, /Technical details/,
    'and says where that material does belong, so nothing is lost by omitting it');
});
