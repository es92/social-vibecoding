// The focused proposal view splits About into two labelled halves: the
// user-facing summary, then the complete GitHub PR description behind a
// collapsed "Technical details" disclosure. Compact cards keep using the
// short generated summary and render neither label.
//
// Run with: node --test tests/proposal-body-details.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  detailsHtml, proposalBodyHtml, proposalCardHtml,
} = require('./lib/dev-card-html');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8'
);
const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
);
const VOTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
);
const MIGRATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8'
);

function makeAppView(renderMarkdown) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42 } },
    DevChat: { renderMarkdown },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`,
    sandbox
  );
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView.appData = { slug: 'recipe-box' };
  return AppView;
}

test('both live and completed proposal rows include the full PR body', () => {
  assert.match(
    VOTES_SRC,
    /function mergedRowSelect\(\)[\s\S]*?SELECT[^`]*cs\.pr_summary_md, cs\.pr_summary_stale, cs\.pr_body,/
  );
  assert.match(
    VOTES_SRC,
    /\/api\/apps\/:slug\/promoted[\s\S]*?SELECT[^`]*cs\.pr_summary_md, cs\.pr_summary_stale, cs\.pr_body,/
  );
  // #1367 split the topic head into a view MODEL and a component; the
  // ordering contract is the order of the model's fields, which is what
  // topic/topic-head.tsx renders them in.
  assert.match(
    APP_VIEW_SRC,
    /summaryHtml: AppView\._proposalSummaryHtml\(item\),[\s\S]*?proposalBody: AppView\._proposalBodyView\(item\),[\s\S]*?details: AppView\._proposalDetailsView\(item\),/,
    'the focused topic places the full body between its summary and metadata'
  );
  const HEAD_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'topic', 'topic-head.tsx'),
    'utf8'
  );
  // On the page the summary leads the hero, and the steps sheet (the
  // detail view's ledger) and the full body are the sheet the ⋯ menu's
  // "Details" row opens (topic-head.tsx DetailsSheet, B10b) — reached from
  // the page, never drawn on it.
  assert.match(
    HEAD_SRC,
    /body\.summaryHtml[\s\S]*?<DetailsSheet\n\s+id=\{Number\(id\)\}\n\s+prRef=\{body\.hero\?\.ref \|\| null\}\n\s+steps=\{body\.steps\}\n\s+help=\{!!\(body\.details && body\.details\.help\)\}\n\s+html=\{body\.proposalBody\?\.html \|\| ''\}/,
    'and the component draws the summary, with the steps and the body behind the ⋯'
  );
});

test('an imported Underway topic reuses proposal details without opening voting', () => {
  const AppView = makeAppView((md) => `<safe-markdown>${md}</safe-markdown>`);
  const item = {
    id: 88,
    status: 'active',
    source: 'imported',
    username: 'bruno',
    imported_pr_author: 'contributor',
    pr_url: 'https://github.example/pull/88',
    check_state: 'failing',
    checks_checked_at: '2026-09-04T12:00:00Z',
    test_results: [{
      name: 'Imported proposal details',
      path: '/app/demo/dev',
      status: 'fail',
      failureReason: 'assignee chip was missing',
    }],
  };
  const view = AppView._proposalDetailsView(item);
  assert.equal(view.help, false);
  assert.equal(view.helpHint, false);
  assert.equal(view.roster, null);
  assert.equal(view.lockedNote, null);

  const html = detailsHtml(AppView, item);
  // The GitHub link is the card's meta line's last word now (`_topicCard`),
  // not a line under the card; the model still carries it.
  assert.equal(view.meta[0].href, 'https://github.example/pull/88');
  assert.doesNotMatch(html, /View PR on GitHub/);
  // #2588: the imported note is no longer one of the steps. "Imported pull
  // request, authored by contributor …" said where the change came from
  // inside the x/y progress indicator, where every other row is a gate
  // somebody has to clear. The hero line above the card says it instead,
  // and the checks row below is untouched.
  assert.doesNotMatch(html, /authored by.*contributor/);
  assert.doesNotMatch(html, /Imported pull request/);
  assert.doesNotMatch(html, /voting begins only after it is put up for vote/);
  assert.equal(AppView._topicHeroView('session', item).provenance,
    'imported from GitHub (contributor)', 'where the reader finds it now');
  assert.match(html, /Imported proposal details/);
  assert.match(html, /assignee chip was missing/);
  assert.doesNotMatch(html, /How voting works|Who can vote/);

  const promoted = AppView._proposalDetailsView({ ...item, status: 'promoted' });
  assert.equal(promoted.help, true);
  assert.equal(promoted.roster.phase, 'loading');
});

test('every underway session topic renders summary, PR body and check details in order', () => {
  const sessionBranch = APP_VIEW_SRC.slice(
    APP_VIEW_SRC.indexOf("} else if (t.kind === 'session')"),
    APP_VIEW_SRC.indexOf('\n    } else {', APP_VIEW_SRC.indexOf("} else if (t.kind === 'session')") + 1)
  );
  assert.match(sessionBranch,
    /body = \{[\s\S]*?summaryHtml: AppView\._proposalSummaryHtml\(item\),[\s\S]*?proposalBody: AppView\._proposalBodyView\(item\),[\s\S]*?details: AppView\._proposalDetailsView\(item\),/);
  assert.doesNotMatch(sessionBranch, /castVote|_cardVoteButtonSpecs|voteButtonsHtml/,
    'metadata reuse must not pull voting controls into Underway');
});

test('the proposal staging fixture carries a reviewable full body', () => {
  const fixture = MIGRATE_SRC.slice(
    MIGRATE_SRC.indexOf('async function seedStagingExternalAgentProposal'),
    MIGRATE_SRC.indexOf('\nasync function ', MIGRATE_SRC.indexOf('async function seedStagingExternalAgentProposal') + 1)
  );
  assert.match(fixture, /agent: 'codex',[\s\S]*?body: '## What changed/);
  assert.match(fixture, /pr_summary_md, pr_body/);
  assert.match(fixture, /SET source = 'imported'[\s\S]*?pr_body = \$5/,
    'existing staging rows are restamped, not only newly inserted rows');
});

test('the default open-proposal fixture also exposes the disclosure', () => {
  const start = MIGRATE_SRC.indexOf('async function seedStagingMyOpenPr');
  const fixture = MIGRATE_SRC.slice(
    start,
    MIGRATE_SRC.indexOf('\nasync function ', start + 1)
  );
  assert.match(fixture, /const prBody = '## What changed/);
  assert.match(fixture, /pr_summary_md, pr_body, status/);
  assert.match(fixture, /conflict_checked_at = NOW\(\),\s*pr_body = \$2/,
    'the first/default fixture is restamped when it already exists');
});

test('legacy and blank PR bodies render no disclosure', () => {
  const AppView = makeAppView(() => {
    assert.fail('blank bodies must not reach the Markdown renderer');
  });
  assert.equal(AppView._proposalBodyView({ id: 7 }), null);
  assert.equal(AppView._proposalBodyView({ id: 7, pr_body: '   ' }), null);
  assert.equal(proposalBodyHtml(AppView, { id: 7, pr_body: '   ' }), '');
});

test('a full PR body is collapsed and rendered through the Markdown pipeline', () => {
  const seen = [];
  const AppView = makeAppView((md, opts) => {
    seen.push({ md, opts });
    return `<safe-markdown>${md}</safe-markdown>`;
  });
  const pr = { id: 7, pr_body: '# Why\n\nMore context.' };
  const html = proposalBodyHtml(AppView, pr);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].md, '# Why\n\nMore context.');
  assert.equal(seen[0].opts.images, true,
    'reviewer screenshots use the Markdown renderer\'s sanitized image mode');
  assert.match(html, /^<details /);
  assert.doesNotMatch(html, /^<details[^>]* open(?: |>|=)/, 'closed by default');
  assert.match(html, />Technical details<\/summary>/);
  assert.match(html, /<safe-markdown># Why\n\nMore context\.<\/safe-markdown>/);
  // The toggle is an onToggle closure now, not an `ontoggle` attribute, so
  // what the markup can carry is the id it reports back with.
  assert.equal(AppView._proposalBodyView(pr).id, 7);
});

test('the no-Markdown-renderer fallback escapes an untrusted PR body', () => {
  const AppView = makeAppView(undefined);
  const html = proposalBodyHtml(AppView, {
    id: 7,
    pr_body: '<img src=x onerror="alert(1)">',
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('the expanded state survives a focused-view repaint', () => {
  // The flag lives in app-view.js rather than in component state for
  // exactly this reason: the head repaints on every checks poll and WS
  // event, and each repaint rebuilds the model from here.
  const AppView = makeAppView((md) => md);
  AppView._setProposalBodyOpen(7, true);
  assert.match(proposalBodyHtml(AppView, { id: 7, pr_body: 'Details' }), /^<details[^>]* open/);

  AppView._setProposalBodyOpen(7, false);
  assert.doesNotMatch(
    proposalBodyHtml(AppView, { id: 7, pr_body: 'Details' }),
    /^<details[^>]* open/
  );
});

test('compact proposal cards do not render the full body', () => {
  const AppView = makeAppView((md) => `<safe-markdown>${md}</safe-markdown>`);
  const html = proposalCardHtml(AppView, {
    id: 7,
    pr_number: 700,
    pr_title: 'Add details',
    pr_body: 'UNIQUE FULL BODY COPY',
    username: 'someone',
    user_id: 999,
    status: 'promoted',
    created_at: '2026-08-21T00:00:00Z',
  });

  assert.doesNotMatch(html, /Technical details/);
  assert.doesNotMatch(html, /UNIQUE FULL BODY COPY/);
});

// ── #1442: the freshness fixtures the proposal screens are reviewed from ──
//
// The screens this issue changes are only reachable when a proposal is in a
// state production rarely holds still in: green checks against a superseded
// base, a predicted conflict with no merge attempted, an unmeasured row. A
// staging preview starts from an empty database for the new columns, so each
// of those states is seeded rather than waited for.

const FRESH_FIXTURE = (() => {
  const start = MIGRATE_SRC.indexOf('async function seedStagingMyOpenPr');
  return MIGRATE_SRC.slice(start, MIGRATE_SRC.indexOf('\nasync function ', start + 1));
})();

test('#1442 — the fixtures cover a false-clean conflict, a superseded base and an unmeasured row', () => {
  assert.match(FRESH_FIXTURE, /staging-fixture\/false-clean-conflict/);
  assert.match(FRESH_FIXTURE, /staging-fixture\/checks-superseded-base/);
  assert.match(FRESH_FIXTURE, /staging-fixture\/freshness-unmeasured/);
  // Every fixture row is labelled, so nothing seeded can be mistaken for a
  // real proposal by a reviewer looking at the preview.
  for (const m of FRESH_FIXTURE.matchAll(/title: '([^']+)'/g)) {
    assert.match(m[1], /^\[staging fixture\]/, `${m[1]} names itself a fixture`);
  }
});

test('#1442 — the false-clean fixture is a PREDICTION, with no merge attempted', () => {
  const block = FRESH_FIXTURE.slice(
    FRESH_FIXTURE.indexOf("staging-fixture/false-clean-conflict"),
    FRESH_FIXTURE.indexOf('},', FRESH_FIXTURE.indexOf("baseVerdict: 'superseded'")) + 2
  );
  // The load-bearing part: merge_conflict_state stays null. Setting it would
  // seed the OTHER box (a merge that was tried and failed), which is the box
  // that already existed and is not what this issue is about.
  assert.match(block, /state: null/);
  assert.match(block, /files: '\[\]'/, 'and no attempted-conflict file list');
  assert.match(block, /mergeability: 'conflict'/);
  assert.match(block, /checkState: 'passing'/,
    'green checks are the point: that is what made the stale proposal look ready');
  assert.match(block, /behindBy: 8/);
});

test('#1442 — the unmeasured fixture reports its reason rather than a verdict', () => {
  const block = FRESH_FIXTURE.slice(FRESH_FIXTURE.indexOf('staging-fixture/freshness-unmeasured'));
  assert.match(block, /mergeability: 'unknown'/);
  assert.match(block, /error: 'GitHub API unreachable \(staging fixture\)'/);
});

test('#1442 — pre-existing siblings default to measured and clean', () => {
  // Without a default every older fixture row would render the new
  // "conflicts with main" box, because null mergeability and a conflict are
  // indistinguishable to a reviewer reading the screen.
  assert.match(FRESH_FIXTURE, /const f = s\.fresh \|\| \{[\s\S]*?mergeability: 'clean'/);
  assert.match(FRESH_FIXTURE, /baseVerdict: 'current', baseBehindBy: 0/);
  // And the freshness snapshot is stamped recently enough that the on-demand
  // TTL refresh does not immediately overwrite it with a GitHub call that
  // cannot succeed against a fixture branch.
  assert.match(FRESH_FIXTURE, /freshness_checked_at = NOW\(\) - INTERVAL '2 minutes'/);
});

test('#1442 — the main fixture is clean on purpose, so the two boxes stay distinct', () => {
  const main = FRESH_FIXTURE.slice(0, FRESH_FIXTURE.indexOf('const siblings'));
  assert.match(main, /mergeability = 'clean'/);
  assert.match(main, /mergeability_files = '\[\]'::jsonb/);
  assert.match(main, /checks_base_verdict = 'current'/);
});

test('#1442 — the ?demo=1 proposals cover the same four states', () => {
  const mocks = VOTES_SRC.slice(VOTES_SRC.indexOf('function stagingMockProposals'));
  for (const id of ['9000033', '9000034', '9000035', '9000036']) {
    assert.ok(mocks.includes(id), `demo proposal ${id} is seeded`);
  }
  assert.match(mocks, /mergeability: 'conflict'/);
  assert.match(mocks, /mergeability: 'unknown'/);
  assert.match(mocks, /checks_base_verdict: 'superseded'/);
});

test('#1442/#2038 — every promoted row is serialized with its measurement blocks', () => {
  assert.match(
    VOTES_SRC,
    /row\.freshness = freshnessSvc\.readFreshness\(row\);/,
    'the client reads one nested block, not twelve loose columns'
  );
  assert.match(
    VOTES_SRC,
    /row\.integration = integrationSvc\.readIntegration\(row\);/,
    '#2038: and one block for where the proposal stands against main, '
    + 'carrying its own measuredAt so the card can say how old the answer is'
  );
  // Both list routes select the columns those blocks read.
  for (const col of ['cs.mergeability', 'cs.freshness_behind_by', 'cs.checks_base_verdict',
    'cs.integration_behind_by', 'cs.integration_block_reason', 'cs.approval_epoch']) {
    assert.ok(VOTES_SRC.includes(col), `${col} is selected`);
  }
});
