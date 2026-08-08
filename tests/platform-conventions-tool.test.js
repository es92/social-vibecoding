// The platform conventions, over the MCP connector.
//
// A connector work order can carry ~4 KB of a 116 KB document — the nine
// rules an agent working blind gets worst. Everything else it needs while
// actually writing code (how auth works, how to declare a secret, the LLM
// proxy's shape, the native UI kit) is in the part it cannot read, because
// its sandbox blocks this host. Connector traffic is not blocked: it egresses
// through the chat product. get_platform_conventions is that channel.
//
// These tests pin the properties that make it worth having:
//
//   1. It is the SAME document, sliced — never a second copy. A copy of
//      platform rules drifts, and drifted rules are worse than none.
//   2. Every section fits in one response, so "read the section" is one call
//      rather than a paging protocol nobody implements.
//   3. It carries the neutralisation preamble. Three sections are addressed
//      to Usernode's own build worker, and one of them ("Don't `git push`
//      yourself") forbids the exact step the agent reading this was asked to
//      perform — the work-order excerpt neutralises it, and so must this.
//   4. It is NOT wrapped as untrusted content. Everything else the connector
//      returns is other people's writing; this is the platform's own rules,
//      and an agent that treats them as mere data ignores them.
//
// Run with: node --test tests/platform-conventions-tool.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');
const tools = require('../src/services/mcp-tools');

const CONVENTIONS = fs.readFileSync(
  path.join(__dirname, '../src/prompts/app-conventions.md'), 'utf8'
);
const TOOLS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8'
);

// Just this tool's registration — bounded by the next one, so a
// doesNotMatch() below can never accidentally read a neighbouring tool's
// body and pass (or fail) for the wrong reason.
function toolBody(name) {
  const start = TOOLS_SRC.indexOf(`server.registerTool('${name}'`);
  assert.ok(start > 0, `${name} is registered`);
  const next = TOOLS_SRC.indexOf('server.registerTool(', start + 10);
  return TOOLS_SRC.slice(start, next > start ? next : undefined);
}

test('the index covers every H2 section of the document, in order', () => {
  const headings = [...CONVENTIONS.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const sections = prompts.getConventionSections();
  assert.ok(headings.length > 20, 'the document really is sectioned');
  assert.equal(sections.length, headings.length, 'one index entry per heading');
  assert.deepEqual(sections.map((s) => s.title), headings, 'same titles, same order');
  for (const s of sections) {
    assert.match(s.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${s.slug} is a clean slug`);
    assert.ok(s.bytes > 0, `${s.slug} reports its size`);
  }
  // Slugs are what an agent learns and reuses across calls, so they must be
  // unique.
  const slugs = prompts.getConventionSlugs();
  assert.equal(new Set(slugs).size, slugs.length, 'slugs are unique');
  assert.deepEqual(slugs, sections.map((s) => s.slug));
});

test('the slugs an agent is most likely to ask for are the obvious ones', () => {
  // Not an exhaustive pin — headings get edited — but these are the questions
  // that actually come up mid-build, and a slug that quietly changed shape
  // would turn a working second call into invalid_request.
  const slugs = prompts.getConventionSlugs();
  for (const expected of [
    'stack',
    'auth-iframe-token-injection',
    'database',
    'staging-mock-data',
    'proposal-tests-ci-for-proposals',
    'per-app-secrets-dapp-json',
    'app-llm-access-the-platform-claude-proxy',
    'app-file-storage-user-uploaded-images',
    'native-feel-ui-kit-centrally-hosted-usernode-native',
    // The one an agent must be told NOT to follow — it has to be reachable
    // for that neutralisation to make sense.
    'dont-git-push-yourself',
  ]) {
    assert.ok(slugs.includes(expected), `${expected} is a slug`);
  }
});

test('a section is a verbatim slice of the document, heading included', () => {
  for (const { slug } of prompts.getConventionSections()) {
    const section = prompts.getConventionSection(slug);
    assert.ok(section, `${slug} resolves`);
    assert.equal(section.slug, slug);
    assert.ok(
      CONVENTIONS.includes(section.content),
      `${slug} is a slice of the document, not a copy`
    );
    assert.match(
      section.content, /^## /,
      `${slug} carries its own heading, so it says what it is on its own`
    );
    assert.equal(
      Buffer.byteLength(section.content, 'utf8'), section.bytes,
      `${slug}'s advertised size is its real size`
    );
  }
});

test('sections partition the document — no gap, no overlap', () => {
  // Together with the verbatim-slice property above, this is what makes
  // "read the section" complete: an agent that walked the whole index has
  // read everything from the first heading onwards. Whitespace between
  // sections is not compared — each slice is trimmed — but the spans must
  // still run end-to-end in order.
  const sections = prompts.getConventionSections();
  let cursor = CONVENTIONS.indexOf('## ');
  assert.ok(cursor >= 0, 'the document has a first H2');
  for (const { slug } of sections) {
    const { content } = prompts.getConventionSection(slug);
    const at = CONVENTIONS.indexOf(content, cursor);
    assert.ok(at >= cursor, `${slug} starts at or after the previous section's end`);
    assert.equal(
      CONVENTIONS.slice(cursor, at).trim(), '',
      `nothing but whitespace is dropped before ${slug}`
    );
    cursor = at + content.length;
  }
  assert.equal(
    CONVENTIONS.slice(cursor).trim(), '',
    'the last section runs to the end of the document'
  );
});

test('every section fits in one response', () => {
  // The cap exists so a future section that does not fit is truncated with a
  // flag rather than flooding the caller's context. Today none of them needs
  // it, and that is the property worth knowing about: no paging protocol.
  const cap = tools.MAX_CONVENTIONS_CHARS;
  assert.equal(cap, 32 * 1024);
  for (const s of prompts.getConventionSections()) {
    const section = prompts.getConventionSection(s.slug);
    assert.ok(
      section.content.length <= cap,
      `${s.slug} is ${section.content.length} chars, over the ${cap} response cap`
    );
  }
});

test('an unknown slug is an error that teaches the index', () => {
  assert.equal(prompts.getConventionSection('no-such-section'), null);
  assert.equal(prompts.getConventionSection(''), null);
  assert.equal(prompts.getConventionSection(null), null);
  assert.equal(prompts.getConventionSection(undefined), null);
  // Case and stray whitespace are the two mistakes worth absorbing rather
  // than punishing — the slug came out of a previous tool response.
  assert.ok(prompts.getConventionSection('  Stack  '));
  assert.equal(prompts.getConventionSection('STACK').slug, 'stack');
});

test('the tool is registered as a read, and returns both shapes', () => {
  const body = toolBody('get_platform_conventions');
  assert.match(body, /annotations: readAnnotations/, 'it is a read');
  assert.match(body, /scopeGuard\(READ_SCOPE\)/, 'and still scope-gated');
  // Index shape, then section shape.
  assert.match(body, /essentials: prompts\.getWorkOrderEssentials\(\)/);
  assert.match(body, /sections: index/);
  assert.match(body, /fullDocUrl: `\$\{origin\}\/claude\.md`/);
  assert.match(body, /toolError\(\s*'invalid_request'/, 'an unknown slug is a structured error');
});

test('the conventions are read locally, so no allowlist entry is needed', () => {
  // The document is on this host's disk. Reading it over loopback would mean
  // adding a route to the connector allowlist for something that needs no
  // authorization at all — /claude.md is public.
  const body = toolBody('get_platform_conventions');
  assert.match(body, /require\('\.\/prompts'\)/);
  assert.doesNotMatch(body, /callPlatform\(/, 'no loopback call in this handler');
});

test('platform-authored rules are NOT wrapped as untrusted content', () => {
  // Every other free-text field in mcp-tools is wrapped precisely because it
  // was written by other users. These rules were written by the platform and
  // are meant to be followed — an envelope here would teach the model to
  // discount them.
  const body = toolBody('get_platform_conventions');
  assert.doesNotMatch(body, /untrusted\(/, 'the conventions are not enveloped');
  assert.match(body, /preamble: conventionsPreamble/);
});

test('the preamble neutralises the sections addressed to the build worker', () => {
  // "Don't `git push` yourself" is written for Usernode's own worker, which
  // has no GitHub credentials. An agent that fetches that section and reads
  // it as its own instruction stops dead on the step it was asked to do —
  // the same failure the work-order excerpt already guards against.
  const preamble = TOOLS_SRC.match(/const conventionsPreamble = ([\s\S]*?);\n\n/);
  assert.ok(preamble, 'the preamble is a single shared string');
  // It is written as a concatenation of source lines, so join them back up
  // before looking for phrases — several of them straddle a `+`.
  const text = preamble[1].replace(/'\s*\+\s*'/g, '').replace(/\\'/g, "'");
  assert.match(text, /Don't `git push` yourself/);
  assert.match(text, /no GitHub credentials/);
  assert.match(text, /own fork/);
  assert.match(text, /Outputting file edits/);
  assert.match(text, /In-loop browser/);
  // And it says which way round to read the rest.
  assert.match(text, /platform-authored/);

  // Each named section really exists, so the preamble never neutralises a
  // heading that has since been renamed.
  const slugs = prompts.getConventionSlugs();
  for (const slug of ['dont-git-push-yourself', 'outputting-file-edits']) {
    assert.ok(slugs.includes(slug), `${slug} is still a real section`);
  }
  assert.ok(
    slugs.some((s) => s.startsWith('in-loop-browser')),
    'the in-loop browser section is still a real section'
  );
});

test('the work order tells the agent the tool exists', () => {
  // The excerpt's job is not to be complete — it is to be the nine worst
  // rules PLUS a pointer to the rest. An agent that does not know the lookup
  // exists guesses instead.
  const svc = require('../src/services/external-agent-tasks');
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x', taskId: 7,
    platformRules: prompts.getWorkOrderEssentials(),
  });
  assert.match(order, /get_platform_conventions/);
  assert.match(order, /EXCERPT/);
  // And it says why the call works when the website does not answer.
  assert.match(order, /connector traffic does not go through your container/i);
});

test('the lookup is unmetered, so asking twice is free', () => {
  // The rate limiter bounds the expensive writes (proposals, forks, platform
  // builds). A read that an agent is being told to call mid-build must not
  // burn one of those, or the guidance becomes a trap.
  const limits = require('../src/services/connector-limits');
  assert.ok(limits.LIMITS.proposalsPerDay > 0, 'writes are metered');
  const LIMITS_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/connector-limits.js'), 'utf8'
  );
  assert.doesNotMatch(LIMITS_SRC, /conventions/i, 'the read is not metered');
  const body = toolBody('get_platform_conventions');
  assert.doesNotMatch(body, /connectorLimits|limits\./, 'and the handler takes no allowance');
});
