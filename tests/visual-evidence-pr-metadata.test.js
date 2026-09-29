'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../src/services/pr-metadata');

function intent() {
  return {
    version: 1,
    impact: 'ui',
    rationale: 'Visible dialog change.',
    stories: [{
      id: 'dialog',
      claim: '@everyone [click](javascript:alert(1)) <img src=x> now shows suggestions',
      persona: 'member',
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      intent: {
        startPath: '/demo', steps: ['Open dialog'], checkpoint: 'Dialog is open',
        focus: 'Dialog', baseState: 'present', animation: 'none',
      },
    }],
  };
}

test('PR evidence metadata contains the declared changes and one secure Homeroom link, never protected media', () => {
  const block = metadata.buildEvidenceBlock({
    intent: intent(), appSlug: 'demo-app', sessionId: 42, domain: 'my.onhomeroom.com',
  });
  assert.match(block, /^<!-- usernode:visual-evidence -->\n## Before\/after shots\n/);
  assert.doesNotMatch(block, /Visual change preview/);
  assert.match(block, /^- .*now shows suggestions$/m);
  assert.match(block, /@\u200beveryone/);
  assert.match(block, /\\\[click\\\]\\\(javascript:alert\\\(1\\\)\\\)/);
  assert.match(block, /https:\/\/my\.onhomeroom\.com\/#app\/demo-app\/dev\/proposals\/42/);
  assert.equal((block.match(/https:\/\//g) || []).length, 1, 'exactly one link');
  assert.doesNotMatch(block, /!\[|\/visuals\/|\/evidence\/[0-9a-f]{32}/);
});

test('evidence marker updates and removals are idempotent', () => {
  const first = metadata.buildEvidenceBlock({
    intent: intent(), appSlug: 'demo-app', sessionId: 42, domain: 'my.onhomeroom.com',
  });
  const body = metadata.upsertEvidenceBlock('Technical details.', first);
  assert.equal(metadata.upsertEvidenceBlock(body, first), body);
  const second = first.replace('now shows suggestions', 'keeps the action visible');
  const updated = metadata.upsertEvidenceBlock(body, second);
  assert.equal((updated.match(/usernode:visual-evidence/g) || []).length, 2,
    'one opening and one closing marker remain');
  assert.doesNotMatch(updated, /now shows suggestions/);
  assert.match(updated, /keeps the action visible/);
  assert.equal(metadata.upsertEvidenceBlock(updated, ''), 'Technical details.');
});

test('no-impact PR metadata explains the rationale without manufacturing screenshots', () => {
  const block = metadata.buildEvidenceBlock({
    intent: { version: 1, impact: 'none', rationale: 'Only retry accounting changed.', stories: [] },
    appSlug: 'demo-app', sessionId: 42, domain: 'my.onhomeroom.com',
  });
  assert.match(block, /## Before\/after shots/);
  assert.match(block, /No user-visible change declared: Only retry accounting changed\./);
  assert.doesNotMatch(block, /^- /m, 'no declared change is invented');
  assert.doesNotMatch(block, /!\[|<img|\/evidence\/[0-9a-f]{32}/);
});
