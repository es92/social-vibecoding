// Tests for generateIssueTitle's multi-issue-aware prompt (#658).
//
// The model's behaviour can't be unit-tested, so the assertion surface
// is the prompt text sent to the API: it must keep the imperative
// verb-first single-issue style, carry the multi-issue instruction in
// both its shared-topic and no-shared-topic forms, guard against
// treating one problem with several symptoms as multi-issue, and embed
// the (surrogate-stripped, trimmed) description. Return handling is
// asserted too: trimmed title on success, throw on an empty response.
//
// #3193: the call asks for structured { actionable, title } output, and a
// reply that is no usable title (the four refusals that were published as
// request titles, stubbed below verbatim) resolves with the reporter's own
// words instead of the model's.
//
// Run with: node --test tests/issue-title-multi.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');

// Minimal stub for the non-streaming messages.create surface that
// generateIssueTitle uses (llm-fallback.test.js stubs the streaming
// surface; this call is a plain one-shot create).
function makeStubClient(response) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return response;
      },
    },
  };
}

async function withStubClient(response, fn) {
  const stub = makeStubClient(response);
  const prev = llm._setClientForTests(stub);
  try {
    return await fn(stub);
  } finally {
    llm._setClientForTests(prev);
  }
}

function textResponse(text, stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 40, output_tokens: 12 },
    stop_reason: stopReason,
  };
}

// The structured { actionable, title } reply the call now asks for.
function titleResponse(title, actionable = true) {
  return textResponse(JSON.stringify({ actionable, title }));
}

test('prompt keeps the imperative verb-first single-issue style', async () => {
  await withStubClient(textResponse('Fix broken thing'), async (stub) => {
    await llm.generateIssueTitle({ description: 'The button is broken' });
    assert.equal(stub.calls.length, 1);
    const { model, max_tokens, messages } = stub.calls[0];
    assert.equal(model, 'claude-haiku-4-5');
    assert.equal(max_tokens, 60);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const prompt = messages[0].content;
    assert.match(prompt, /imperative action starting with a verb/);
    assert.match(prompt, /Fix broken leaderboard sort/);
    assert.match(prompt, /not a noun phrase or description/);
    assert.match(prompt, /5-10 words/);
    assert.match(prompt, /no quotes/);
  });
});

test('prompt carries the multi-issue instruction in both forms', async () => {
  await withStubClient(textResponse('Fix multiple things'), async (stub) => {
    await llm.generateIssueTitle({ description: 'A is broken, also B is broken' });
    const prompt = stub.calls[0].messages[0].content;
    // The core rule: don't title only the first problem.
    assert.match(prompt, /more than one distinct problem/);
    assert.match(prompt, /instead of describing only the first/);
    // Shared-topic form (topic named, problems gisted).
    assert.match(prompt, /share a topic/);
    assert.match(prompt, /Fix multiple leaderboard issues: broken sort and stale totals/);
    // No-shared-topic form (each problem gisted briefly).
    assert.match(prompt, /Fix multiple issues: leaderboard sort, dark-mode persistence, export 404/);
    // Relaxed length cap for multi-issue titles only.
    assert.match(prompt, /up to 15 words/);
  });
});

test('prompt guards against treating one problem with several symptoms as multi-issue', async () => {
  await withStubClient(textResponse('Fix one thing'), async (stub) => {
    await llm.generateIssueTitle({ description: 'It flickers, then hangs, then crashes' });
    const prompt = stub.calls[0].messages[0].content;
    assert.match(prompt, /single problem described with several symptoms/);
    assert.match(prompt, /still counts as one problem/);
    assert.match(prompt, /do not use the multi-issue form/);
  });
});

test('prompt embeds the surrogate-stripped, trimmed description', async () => {
  // A lone high surrogate must be stripped and surrounding whitespace
  // trimmed before the description lands in the prompt.
  const description = '  Broken \uD800 export button  ';
  await withStubClient(textResponse('Fix export button'), async (stub) => {
    await llm.generateIssueTitle({ description });
    const prompt = stub.calls[0].messages[0].content;
    assert.ok(prompt.endsWith('FEEDBACK:\nBroken  export button'));
    assert.ok(!prompt.includes('\uD800'));
  });
});

test('returns the trimmed title, with usage and model', async () => {
  await withStubClient(titleResponse('  Fix multiple leaderboard issues: sort and totals  '), async () => {
    const res = await llm.generateIssueTitle({ description: 'sort broken, totals stale' });
    assert.equal(res.title, 'Fix multiple leaderboard issues: sort and totals');
    assert.equal(res.actionable, true);
    assert.equal(res.model, 'claude-haiku-4-5');
    assert.deepEqual(res.usage, { input_tokens: 40, output_tokens: 12 });
  });
});

test('off-schema plain text is still accepted when it is a valid title', async () => {
  await withStubClient(textResponse('Fix export button on Safari'), async () => {
    const res = await llm.generateIssueTitle({ description: 'export is broken on safari' });
    assert.equal(res.title, 'Fix export button on Safari');
    assert.equal(res.actionable, true);
  });
});

test('an empty response still throws', async () => {
  await withStubClient(textResponse('   '), async () => {
    await assert.rejects(
      llm.generateIssueTitle({ description: 'something broke' }),
      /Empty issue title response/
    );
  });
});

// ---- #3193: refusals never become titles ----

// The four titles that were published on the platform's own board, as
// its request list shows them (clipped at about 200 characters), with the
// feedback each one was written for.
const PUBLISHED_REFUSALS = [
  {
    issue: 3130,
    description: 'Llfg+++',
    reply: 'I don\'t have enough information to create a meaningful GitHub issue title from "Llfg+++" as it appears to be unclear or incomplete feedback. Could you provide more details about the actual issue or pr',
    fallback: 'Feedback: Llfg+++',
  },
  {
    issue: 3107,
    description: 'I like this website',
    reply: 'I need feedback describing a problem or issue to create a GitHub issue title. The statement "I like this website" is positive feedback without any specific problem or improvement request. Please provi',
    fallback: 'Feedback: I like this website',
  },
  {
    issue: 3106,
    description: 'Lfg',
    reply: 'I need more context to create an appropriate issue title. "Lfg" (looking for group) is too vague. Could you provide details about:\n\n- What specific problem needs to be fixed or feature needs to be add',
    fallback: 'Feedback: Lfg',
  },
  {
    issue: 3105,
    description: 'Lfg',
    reply: 'I need more information to create a meaningful GitHub issue title. "Lfg" (looking for group) doesn\'t describe a specific problem or feature request.\n\nCould you provide details about what needs to be f',
    fallback: 'Feedback: Lfg',
  },
];

test('asks for structured { actionable, title } output and says to flag instead of explaining', async () => {
  await withStubClient(titleResponse('Fix broken thing'), async (stub) => {
    await llm.generateIssueTitle({ description: 'The button is broken' });
    const { output_config: outputConfig, messages } = stub.calls[0];
    assert.deepEqual(outputConfig, { format: { type: 'json_schema', schema: llm.ISSUE_TITLE_SCHEMA } });
    assert.deepEqual(llm.ISSUE_TITLE_SCHEMA.required, ['actionable', 'title']);
    assert.equal(llm.ISSUE_TITLE_SCHEMA.properties.actionable.type, 'boolean');
    assert.equal(llm.ISSUE_TITLE_SCHEMA.properties.title.type, 'string');
    const prompt = messages[0].content;
    assert.match(prompt, /set actionable to false/);
    assert.match(prompt, /Never explain, apologise, ask for more detail/);
    assert.doesNotMatch(prompt, /Respond with only the title/);
  });
});

for (const { issue, description, reply, fallback } of PUBLISHED_REFUSALS) {
  test(`#${issue}'s published refusal, sent as plain text, files as "${fallback}"`, async () => {
    await withStubClient(textResponse(reply), async () => {
      const res = await llm.generateIssueTitle({ description });
      assert.equal(res.title, fallback);
      assert.equal(res.actionable, false);
      assert.deepEqual(res.usage, { input_tokens: 40, output_tokens: 12 }, 'the call is still billed');
    });
  });

  test(`#${issue}'s published refusal, sent as the title field, files as "${fallback}"`, async () => {
    await withStubClient(titleResponse(reply, true), async () => {
      const res = await llm.generateIssueTitle({ description });
      assert.equal(res.title, fallback);
      assert.equal(res.actionable, false);
    });
  });

  test(`#${issue}'s published refusal is rejected whole and by its first line alone`, () => {
    assert.notEqual(llm.issueTitleRejection(reply), null);
    assert.notEqual(llm.issueTitleRejection(reply.split('\n')[0]), null);
    assert.notEqual(llm.issueTitleRejection(reply.split('. ')[0]), null);
  });
}

test('actionable: false files under the reporter\'s words, whatever the title says', async () => {
  await withStubClient(titleResponse('Share general praise for the site', false), async () => {
    const res = await llm.generateIssueTitle({ description: '  I like this website  ' });
    assert.equal(res.title, 'Feedback: I like this website');
    assert.equal(res.actionable, false);
  });
});

test('a cut-off or declined reply files under the reporter\'s words', async () => {
  await withStubClient(textResponse('{"actionable": true, "title": "Fix the', 'max_tokens'), async () => {
    const res = await llm.generateIssueTitle({ description: 'Lfg' });
    assert.equal(res.title, 'Feedback: Lfg');
    assert.equal(res.actionable, false);
  });
  await withStubClient({ content: [], usage: { input_tokens: 40, output_tokens: 0 }, stop_reason: 'refusal' }, async () => {
    const res = await llm.generateIssueTitle({ description: 'Lfg' });
    assert.equal(res.title, 'Feedback: Lfg');
    assert.equal(res.actionable, false);
  });
  // Unparseable JSON without a max_tokens stop is still not a title.
  await withStubClient(textResponse('{"actionable": true, "title": "Fix'), async () => {
    const res = await llm.generateIssueTitle({ description: 'Lfg' });
    assert.equal(res.title, 'Feedback: Lfg');
  });
});

test('an empty structured title with actionable: true is not published', async () => {
  await withStubClient(titleResponse('   ', true), async () => {
    const res = await llm.generateIssueTitle({ description: 'Lfg' });
    assert.equal(res.title, 'Feedback: Lfg');
    assert.equal(res.actionable, false);
  });
});

test('issueTitleRejection accepts real titles, single- and multi-issue', () => {
  for (const title of [
    'Fix broken leaderboard sort',
    'Add dark mode toggle',
    'Fix multiple leaderboard issues: broken sort and stale totals',
    'Fix multiple issues: leaderboard sort, dark-mode persistence, export 404',
    'Fix I18n date format on the profile page',
    'Improve iOS install prompt',
  ]) {
    assert.equal(llm.issueTitleRejection(title), null, title);
  }
});

test('issueTitleRejection rejects empty, multi-line, over-long, questions and refusal phrasing', () => {
  assert.equal(llm.issueTitleRejection(''), 'empty');
  assert.equal(llm.issueTitleRejection('   '), 'empty');
  assert.equal(llm.issueTitleRejection(null), 'empty');
  assert.equal(llm.issueTitleRejection('Fix sort\nand totals'), 'multi-line');
  assert.equal(llm.issueTitleRejection(`Fix ${'x'.repeat(120)}`), 'too long');
  assert.equal(llm.issueTitleRejection(Array.from({ length: 21 }, () => 'fix').join(' ')), 'too long');
  assert.equal(llm.issueTitleRejection('What should this title be?'), 'question');
  for (const text of [
    'I need more information to title this',
    "I don't have enough information",
    'I don’t have enough context',
    'To write this, I need more context',
    'Sorry, that is not enough to go on',
    'Unfortunately the feedback is unclear',
    'Could you provide more details',
    'Please provide more detail about the bug',
    'Cannot write an issue title from this',
    '"Lfg" is too vague to title',
  ]) {
    assert.equal(llm.issueTitleRejection(text), 'refusal', text);
  }
});

test('feedbackTitleFromDescription: one line, capped at a word boundary, in the reporter\'s words', () => {
  assert.equal(llm.feedbackTitleFromDescription('Lfg'), 'Feedback: Lfg');
  assert.equal(llm.feedbackTitleFromDescription('  Llfg+++ \n'), 'Feedback: Llfg+++');
  assert.equal(llm.feedbackTitleFromDescription('great\n\nwork   team'), 'Feedback: great work team');
  const long = llm.feedbackTitleFromDescription(
    'The leaderboard page takes a very long time to load on my phone and then shows the wrong totals'
  );
  assert.equal(long, 'Feedback: The leaderboard page takes a very long time to load on my…');
  assert.ok(long.length <= 'Feedback: '.length + 61);
  // One unbroken run is hard-capped rather than cut back to nothing.
  const run = llm.feedbackTitleFromDescription('x'.repeat(200));
  assert.equal(run, `Feedback: ${'x'.repeat(60)}…`);
  // Nothing to quote: the old template.
  assert.equal(llm.feedbackTitleFromDescription('   '), llm.FEEDBACK_FALLBACK_TITLE);
  assert.equal(llm.feedbackTitleFromDescription(undefined), llm.FEEDBACK_FALLBACK_TITLE);
  // A cut through an emoji leaves no lone surrogate behind.
  const emoji = llm.feedbackTitleFromDescription(`${'a'.repeat(59)}\u{1F44D}${'b'.repeat(10)}`);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
