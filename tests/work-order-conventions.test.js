// The offline conventions appendix carried inside a connector work order.
//
// Every Homeroom app's notes tell a coding agent to fetch the platform
// conventions from the Homeroom site at the start of a session. A hosted
// agent's container BLOCKS that host, so it never reads them — and then
// reasons its way to the very things the document forbids. The observed run
// came within one decision of vendoring the three centrally hosted assets
// into an app repo to "fix" the styling — which nothing would have caught,
// because no check inspects an app's source for a vendored copy (#1215).
//
// So the work order carries a compact excerpt with it. These tests pin the
// two properties that make that safe:
//
//   1. The excerpt is a REGION OF app-conventions.md, not a copy. A copy
//      would drift, and drifted platform rules are worse than none.
//   2. It EXCLUDES "Don't `git push` yourself" — a section addressed to
//      Homeroom's own credential-less build worker. Pasted at an agent
//      pushing to the user's own fork, it forbids the required step.
//
// Run with: node --test tests/work-order-conventions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');
const svc = require('../src/services/external-agent-tasks');

const CONVENTIONS = fs.readFileSync(
  path.join(__dirname, '../src/prompts/app-conventions.md'), 'utf8'
);

// The excerpt has to survive a host model that may truncate the work order,
// and it is background guidance — generous, but not unbounded.
const MAX_ESSENTIALS_BYTES = 6 * 1024;

test('the work-order markers exist in app-conventions.md, exactly once each', () => {
  const begins = CONVENTIONS.split(prompts.WORK_ORDER_BEGIN).length - 1;
  const ends = CONVENTIONS.split(prompts.WORK_ORDER_END).length - 1;
  assert.equal(begins, 1, 'one begin marker');
  assert.equal(ends, 1, 'one end marker');
  assert.ok(
    CONVENTIONS.indexOf(prompts.WORK_ORDER_BEGIN) < CONVENTIONS.indexOf(prompts.WORK_ORDER_END),
    'and they are the right way round'
  );
});

test('the extracted region is non-empty, bounded, and really a slice of the document', () => {
  const essentials = prompts.getWorkOrderEssentials();
  assert.ok(essentials.length > 500, 'there is actually guidance in there');
  assert.ok(
    Buffer.byteLength(essentials, 'utf8') < MAX_ESSENTIALS_BYTES,
    `the excerpt is ${Buffer.byteLength(essentials, 'utf8')} bytes, over the ${MAX_ESSENTIALS_BYTES} bound`
  );
  // One source of truth: editing the conventions edits the excerpt. A
  // second copy of these rules would drift silently.
  assert.ok(CONVENTIONS.includes(essentials), 'the excerpt is a verbatim slice, never a copy');
  assert.ok(!essentials.includes(prompts.WORK_ORDER_BEGIN));
  assert.ok(!essentials.includes(prompts.WORK_ORDER_END));
});

test('the excerpt covers what an offline agent gets wrong, in priority order', () => {
  const essentials = prompts.getWorkOrderEssentials();
  // Ranked by how badly it goes wrong, so a truncation loses the least.
  assert.match(essentials, /centrally hosted/i);
  assert.match(essentials, /never vendor/i);
  assert.match(essentials, /cdn/i);
  assert.match(essentials, /USERNODE_ENV/);
  assert.match(essentials, /IS_STAGING/);
  assert.match(essentials, /seed/i);
  assert.match(essentials, /staging:private/);
  assert.match(essentials, /dapp\.json/);
  assert.match(essentials, /checks GATE MERGE|Checks GATE MERGE/i);
  assert.match(essentials, /RS256/);
  assert.match(essentials, /USERNODE_JWT_PUBLIC_KEY/);
  assert.match(essentials, /LLM proxy|USERNODE_LLM_PROXY_URL/);
  assert.match(essentials, /USERNODE_PLATFORM_API_V1_URL/);
  assert.match(essentials, /never a hardcoded host/);
  assert.match(essentials, /SIGTERM/);
});

test('the excerpt states the vendoring rule without claiming a check enforces it', () => {
  const essentials = prompts.getWorkOrderEssentials();

  // What IS real: vendoring is forbidden, and the cost is the point — a
  // frozen copy stops receiving the fleet-wide fix and the one-redeploy
  // rollback that central hosting buys.
  assert.match(essentials, /never vendor them/i);
  assert.match(essentials, /fleet-wide fix/i);

  // What is NOT real: any check that inspects an app's source. Nothing in
  // the platform does, and the excerpt used to claim two did (#1215) — an
  // agent that checks and finds nothing discounts the other eight rules.
  assert.doesNotMatch(essentials, /rejected by/i);
  assert.match(essentials, /No automated check catches that/);

  // And the CDN is described as the legacy state it is, with the one-line
  // migration target named so a migration turn does not have to guess it.
  assert.match(essentials, /cdn\.tailwindcss\.com/);
  assert.match(essentials, /legacy state/i);
  assert.match(essentials, /usernode-tailwind\/v1\/tailwind\.js/);
  // Including the reference a one-line-swap framing invites an agent to miss.
  assert.match(essentials, /sw\.js/);
});

test('the excerpt does NOT forbid the one thing the agent has to do', () => {
  const essentials = prompts.getWorkOrderEssentials();

  // "Don't `git push` yourself" addresses Homeroom's own build worker,
  // which runs with no GitHub credentials at all. A fork-pushing agent that
  // reads it as its own instruction stops dead on the required step — so
  // the SECTION is excluded from the excerpt.
  assert.match(CONVENTIONS, /## Don't `git push` yourself/, 'the full document still has it');
  assert.doesNotMatch(essentials, /## Don't `git push` yourself/, 'but the excerpt does not carry the section');
  // None of its prohibition text comes across either.
  assert.doesNotMatch(essentials, /just commit .* and stop/i);
  assert.doesNotMatch(essentials, /zero GitHub credentials in env/i);
  assert.doesNotMatch(essentials, /the harness handles the push for you/i);

  // The one mention that IS allowed: naming the section in order to
  // NEUTRALISE it, for an agent that has seen the full document elsewhere.
  // The mention and the neutralisation have to travel together.
  const mention = essentials.indexOf("Don't `git push` yourself");
  assert.ok(mention > 0, 'the excerpt names the section explicitly');
  assert.match(essentials.slice(mention), /does not apply to a\s+coding agent working in the user's own fork/);
  assert.match(essentials.slice(mention), /pushing your branch is\s+exactly what you are being asked to do/);
  assert.match(essentials.slice(mention), /build\s+worker/);
});

test('a missing marker degrades to an empty appendix rather than throwing', () => {
  // The appendix is background guidance. Losing it must never cost the
  // base commit, the push commands or the task id — so nothing in this
  // path is allowed to throw.
  assert.equal(svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x', platformRules: '',
  }).includes('PLATFORM RULES'), false);
});

test('the work order names all three hosted assets and the full document URL', () => {
  const order = svc.buildWorkOrder({
    appName: 'Recipe Box', appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus: 'ready',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: `ba5e${'0'.repeat(34)}fe`,
    brief: 'x',
    webPath: 'https://usernode.example/#app/recipe-box',
    taskId: 31,
    platformRules: prompts.getWorkOrderEssentials(),
  });

  // The three files whose absence made the app render unstyled in a
  // sandbox browser and one declared check fail.
  assert.equal(svc.HOSTED_ASSET_PATHS.length, 3);
  // They are named as RELATIVE paths, with no hostname in front (#2319).
  // Absolute URLs on a compiled-in host (social-vibecoding.usernodelabs.org)
  // went dead when the platform moved; absolute URLs on the deployment's own
  // origin then got copied into apps as my.onhomeroom.com, which breaks on
  // the next move the same way. The platform serves these paths on every
  // app's own address, so the relative form is the one to copy.
  for (const assetPath of svc.HOSTED_ASSET_PATHS) {
    assert.match(assetPath, /^\/usernode-/);
    assert.ok(order.includes(assetPath), `the work order names ${assetPath}`);
    assert.ok(!order.includes(`https://usernode.example${assetPath}`),
      `and never on a hostname: ${assetPath}`);
  }
  assert.match(order, /RELATIVE paths, exactly as written/);
  assert.doesNotMatch(order, /social-vibecoding\.usernodelabs\.org/);
  assert.ok(svc.HOSTED_ASSET_PATHS.some((u) => u.includes('usernode-bridge')));
  assert.ok(svc.HOSTED_ASSET_PATHS.some((u) => u.includes('usernode-native')));
  assert.ok(svc.HOSTED_ASSET_PATHS.some((u) => u.includes('usernode-tailwind')));

  // The diagnosis, so a less careful agent does not "fix" the sandbox.
  assert.match(order, /local container does not serve these paths/);
  assert.match(order, /Vendoring those files into the repository is forbidden/);
  assert.match(order, /staging preview Homeroom builds/);

  // And it does NOT claim a check enforces any of this. Nothing the platform
  // runs inspects an app's source for a vendored copy or a CDN tag, so the
  // count was always wrong; an excerpt caught overstating one rule gets the
  // other eight discounted with it (#1215).
  assert.doesNotMatch(order, /rejected by/i);
  assert.match(order, /No automated check catches that/);

  // And a pointer to the always-current full document, derived from the
  // deployment's own origin rather than hardcoded.
  assert.match(order, /https:\/\/usernode\.example\/claude\.md/);

  // The appendix is genuinely appended, not merged into the instructions.
  assert.ok(order.indexOf('PLATFORM RULES') > order.indexOf('WHEN YOU ARE DONE'));
});

test('the excerpt survives round-tripping through the work order intact', () => {
  // A rule that arrives mangled is worse than one that does not arrive:
  // the appendix is pasted verbatim, so it must not be re-wrapped.
  const essentials = prompts.getWorkOrderEssentials();
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x', platformRules: essentials,
  });
  assert.ok(order.includes(essentials));
  // And it brings no fence with it — the host wraps the whole work order in
  // one, and a nested fence closes it early.
  assert.ok(!essentials.includes('```'), 'the excerpt carries no triple-backtick fence');
  assert.ok(!order.includes('```'));
});

// ── What the work order says beyond the appendix ──────────────────────────
//
// The excerpt is deliberately incomplete. Three things therefore have to be
// said in the instructions themselves: that the rest of the handbook is one
// connector call away, that a submission has to carry its own testing
// routes, and that the checks it triggers gate merge and are fixable in the
// same session.

// The full-fat work order, as prepare_work builds it for a submittable task.
function fullOrder(overrides = {}) {
  return svc.buildWorkOrder({
    appName: 'Recipe Box', appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus: 'ready',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: `ba5e${'0'.repeat(34)}fe`,
    brief: 'x',
    webPath: 'https://usernode.example/#app/recipe-box',
    taskId: 31,
    platformRules: prompts.getWorkOrderEssentials(),
    ...overrides,
  });
}

// Instruction text only. The appendix quotes the conventions verbatim and so
// mentions several of the same terms; a match anywhere in the whole order
// would pass on the appendix's wording rather than the instructions'.
function instructions(order) {
  const at = order.indexOf('\nPLATFORM RULES');
  return at > 0 ? order.slice(0, at) : order;
}

test('the work order says the appendix is partial and names the lookup', () => {
  const order = instructions(fullOrder());
  // An agent that does not know the handbook is reachable guesses instead —
  // and the guesses are what the excerpt exists to prevent.
  assert.match(order, /EXCERPT/, 'it says so in as many words');
  assert.match(order, /get_platform_conventions/);
  assert.match(order, /index of every\s+section/, 'and how to use it: index first');
  assert.match(order, /section slug for the full text/, 'then one section');
  // The reason the call works when the site does not answer. Without this an
  // agent that has already been refused by the host assumes the connector
  // is down too and stops asking.
  assert.match(order, /sandbox cannot reach the Homeroom website/i);
  assert.match(order, /connector traffic does not go through your container/i);
});

test('the work order keeps agent instructions with their repository', () => {
  const order = instructions(fullOrder());
  assert.match(order, /has loaded this repository's own instructions/);
  assert.match(order, /changing directory from an unrelated project may not\s+replace them/);
  assert.match(order, /start a\s+fresh task rooted in this repository/);
});

test('the work order separates manual testing routes from interaction evidence', () => {
  const order = instructions(fullOrder());
  assert.match(order, /testingPaths/);
  assert.match(order, /testingSteps/);
  // Routes remain useful for a human entering the preview and for durable
  // checks, but they are no longer presented as visual proof.
  assert.match(order, /manual "Test this change" link/);
  assert.match(order, /THE SCREEN YOU\s+CHANGED/);
  assert.match(order, /not the\s+home page/);
  assert.match(order, /do not add a screenshot-only route/);
  assert.doesNotMatch(order, /query param handled at boot/);

  // The agent declares what changed and how a person reaches that exact
  // state; Homeroom's preview agent takes the before/after shots.
  assert.match(order, /visualEvidence/);
  assert.match(order, /record_visual_evidence_intent/);
  assert.match(order, /helper is not exposed[\s\S]*documented version-1 object directly/,
    'a connector without the helper still documents the supported v1 input path');
  assert.match(order, /before\/after shots/);
  assert.match(order, /declared\s+changes/);
  assert.match(order, /report that blocker/);
  assert.doesNotMatch(order, /replay|bounded plan/i, 'no replay plan is asked for any more');

  // The submission response distinguishes a malformed manual route from the
  // evidence lifecycle instead of silently replacing either with '/'.
  assert.match(order, /testingPathsRejected/);
  assert.match(order, /visualEvidenceAccepted/);
  assert.match(order, /visualEvidenceState/);
  assert.match(order, /visualEvidenceNextStep/);
});

test('the work order says the checks gate merge and how to clear them', () => {
  const order = instructions(fullOrder());
  assert.match(order, /GATE MERGE/);
  assert.match(order, /cannot merge however the vote goes/);
  assert.match(order, /get_proposal/, 'it names the tool that reports them');
  // The fix is another commit on the same branch. The two wrong moves are
  // resubmitting and starting over, so both are named as prohibited.
  assert.match(order, /push again to the SAME branch/);
  assert.doesNotMatch(
    order, /call `submit_work` again(?! with slug)/,
    'resubmitting is not offered as the remedy'
  );
  const step7 = order.slice(order.indexOf('7. THEN CHECK THE CHECKS'));
  assert.match(step7, /Do not call\s+`submit_work` again/);
  assert.match(step7, /do not call `prepare_work`/);
  // Evidence is revision-scoped and can fail honestly; no generic home-page
  // screenshot is allowed to masquerade as proof of an unreachable state.
  assert.match(step7, /visualEvidence/);
  assert.match(step7, /check that your declared changes were accepted/);
  assert.match(step7, /wait for `verified`/);
  assert.match(step7, /`shotResults` says why any change was skipped/);
  assert.match(step7, /`failed` includes a specific reason/);
  assert.match(step7, /does not substitute a home-page screenshot/);
  assert.doesNotMatch(step7, /captureDefaultedToRoot/);
});

test('a task with nothing to submit gets none of the submission guidance', () => {
  // The no-task work order ends at "push your branch and report it" — a
  // reader with no proposal to check must not be told to check its checks.
  const order = instructions(svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x',
    platformRules: prompts.getWorkOrderEssentials(),
  }));
  assert.doesNotMatch(order, /THEN CHECK THE CHECKS/);
  assert.doesNotMatch(order, /testingPaths/);
  // The handbook pointer is not submission guidance, so it stays.
  assert.match(order, /get_platform_conventions/);
});

test('every addition sits above the appendix, and none brings a fence', () => {
  const order = fullOrder();
  const appendix = order.indexOf('\nPLATFORM RULES');
  assert.ok(appendix > 0, 'the appendix is there to be above');
  // The boundary marker is the heading ON ITS OWN LINE. The words also
  // appear mid-sentence just above it ("The PLATFORM RULES below are the
  // offline excerpt"), so a bare substring search finds the wrong place —
  // which is exactly the trap a new pointer to the appendix falls into.
  assert.equal(
    order.split('\nPLATFORM RULES\n').length - 1, 1,
    'the heading occurs once as a line of its own'
  );
  for (const marker of [
    'get_platform_conventions',
    'testingPaths',
    'visualEvidence',
    '7. THEN CHECK THE CHECKS',
  ]) {
    const at = order.indexOf(marker);
    assert.ok(at > 0, `${marker} is in the work order`);
    assert.ok(at < appendix, `${marker} is instruction text, not appendix text`);
  }
  // The whole order is pasted inside one fence by the host. A nested fence
  // closes it early and the rest arrives as prose.
  assert.ok(!order.includes('```'), 'no triple-backtick fence anywhere');
});
