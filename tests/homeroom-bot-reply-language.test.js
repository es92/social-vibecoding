'use strict';

// The Homeroom bot writes to people in their own language where it reaches
// them in their DM, and in English everywhere else (10 Oct 2026, issue
// #4645). A person wrote to the bot in English and its follow-up reply came
// back in Chinese: none of the prompts that produce text people read said
// which language to write in. Each such prompt now carries the one wording
// rule the change's group asked for (live.localeRule), worded beside the
// existing "no em dashes" instruction, and the requester's locale
// (users.locale, read off the request's recorded requester) is named where
// the rule can act on it. Quotes of people's own words are still written as
// the person wrote them.
//
// Run with: node --test tests/homeroom-bot-reply-language.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const review = require('../src/services/bot-review');
const bot = require('../src/services/homeroom-bot');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RULE = /Match the user's locale in DMs and default to English otherwise/;
const UNSET = /the requester's locale is unset, so write English/;
const PT = /the requester's locale is `pt-BR`/;

test('the follow-up reply turn words the rule, and names the locale when it is set', () => {
  const unset = followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true });
  assert.match(unset, RULE);
  assert.match(unset, UNSET);
  assert.match(unset, /quote people's own words as they wrote them/i);
  assert.doesNotMatch(unset, PT, 'no locale is named when none was given');
  const set = followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true, locale: 'pt-BR' });
  assert.match(set, PT);
});

test('the checks-fix turn words the rule the same way', () => {
  const unset = followup.checksFixPrompt({ seed: 'S', failing: [{ name: 'x', reason: 'y' }], total: 1 });
  assert.match(unset, RULE);
  assert.match(unset, UNSET);
  assert.match(followup.checksFixPrompt({ seed: 'S', failing: [], total: 0, locale: 'pt-BR' }), PT);
});

test('the triage prompt words the rule, and the requester\'s locale is named beside it', () => {
  assert.match(read('src/prompts/homeroom-bot-triage.md'), RULE);
  const withLocale = bot.triagePromptFor({ seed: 'S', issueNumber: 12, locale: 'pt-BR' });
  assert.match(withLocale, RULE);
  assert.match(withLocale, /The requester's locale is `pt-BR`\./);
  const unset = bot.triagePromptFor({ seed: 'S', issueNumber: 12 });
  assert.match(unset, RULE);
  assert.doesNotMatch(unset, /The requester's locale is /, 'unset says nothing: the default stands');
});

test('the spec prompts, both variants, word the rule', () => {
  const markdown = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.' });
  assert.match(markdown, RULE);
  assert.match(markdown, UNSET);
  const html = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', html: true });
  assert.match(html, RULE);
  assert.match(live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', locale: 'pt-BR' }), PT);
});

test('the revised-plan format, both variants, words the rule', () => {
  const markdown = live.followUpPlanFormat({});
  assert.match(markdown, RULE);
  assert.match(markdown, UNSET);
  const html = live.followUpPlanFormat({ config: { htmlSpecApps: ['*'] }, app: { slug: 'x' }, locale: 'pt-BR' });
  assert.match(html, PT);
});

test('the build prompt\'s description and declared-change lines word the rule', () => {
  const SPEC = [
    '# Pick the next book',
    '',
    '## User-facing changes',
    '',
    'Members pick the next book from the card.',
    '',
    '## Technical implementation',
    '',
    'Edit `public/app.js`.',
  ].join('\n');
  const build = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec: SPEC });
  assert.match(build, RULE);
  assert.match(build, UNSET);
  assert.doesNotMatch(build, /Write it in English/, 'the static English line is gone: the rule names it now');
  assert.match(live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec: SPEC, locale: 'pt-BR' }), PT);
  // The declared changes are claims a voter reads: their language is the
  // rule's now, so the line itself no longer pins one.
  const declare = live.buildVisibleChangesLines(null).join('\n');
  assert.match(declare, /each a claim in plain words a voter would recognise/);
  assert.doesNotMatch(declare, /plain English words/);
});

test('the design-review prompts word the rule', () => {
  assert.match(review.reviewerSystemPrompt(), RULE);
  assert.match(review.reviewerSystemPrompt(), UNSET);
  assert.match(review.reviewerSystemPrompt('pt-BR'), PT);
  assert.match(review.fixPrompt({}), RULE);
  assert.match(review.fixPrompt({ locale: 'pt-BR' }), PT);
});

test('the rule line itself has no em dash, whatever the locale', () => {
  for (const locale of [null, 'pt-BR', 'id']) assert.doesNotMatch(live.localeRule(locale), /—/);
});

test('the DM chat and the thread replies answer in the language people write in', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const voice = require('../src/services/homeroom-bot-voice');
  const dmChat = mayor.systemPrompt({ username: 'ann' });
  assert.match(dmChat, /Answer in the language of their latest message, and in the language they wrote in before when it is too short\n {2}to tell\. English only when you cannot tell\./);
  const thread = voice.systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(thread, /- Reply in the language of the newest message you answer\. English only when you cannot tell\./);
});
