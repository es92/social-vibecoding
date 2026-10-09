// The change page as the Workshop's Needs-you item (task 497).
//
// A proposal's page used to read: the board card at full width; "About this
// change" (the summary folded to a line, the issues); "Where it stands" (the
// ledger); "More about this change" (the technical half and the testing
// steps, as accordion rows); the Discussion. It reads now the way a Needs-you
// item does — the hero: the eyebrow, the title, who proposed it, the tags as
// chips in the card's colours, the band with Vote first, the summary as a
// paragraph, the issue as a chip, the picture or the line that says it is
// coming — then the card's merge-requirements strip expanded into a steps
// sheet, then the Discussion. The technical half is a sheet the ⋯ menu opens;
// the testing steps live beside the preview and are not on the page.
//
// app-view.js builds the two view models (`_topicHeroView`, `_topicStepsView`)
// off the card model and the ledger rows the existing builders make;
// topic/topic-head.tsx draws them. These tests compose the two halves the way
// the store does at runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function context(user = { id: 42, username: 'Builder' }, globals = {}) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams, ...globals };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  c.av._ghIssues = [{ number: 1993, title: 'Wait for authentication before opening previews' }];
  return c.av;
}

// Somebody else's proposal, up for a vote, with the gate's whole ordered list
// recorded — the shape the /promoted route serves (services/merge-requirements.js).
const gates = (over = {}) => [
  { key: 'approvals', label: 'Votes', actor: 'group', state: 'waiting', detail: { note: '1 of 2' } },
  { key: 'integration', label: 'No conflicts with main', actor: 'auto', state: 'done', detail: { note: 'level with main, merges cleanly' } },
  { key: 'checks', label: 'Checks', actor: 'author', state: 'done', detail: null },
  { key: 'main_healthy', label: 'Main is healthy', actor: 'admin', state: 'done', detail: null },
  { key: 'github', label: 'Merge', actor: 'auto', state: 'pending', detail: null },
].map((g) => ({ ...g, ...(over[g.key] || {}) }));

const PR = {
  id: 4090, user_id: 7, username: 'maya', status: 'promoted', source: 'native',
  pr_number: 12, pr_url: 'https://github.com/example/app/pull/12', pr_title: 'Authenticate previews',
  pr_summary_md: 'Previews wait for sign-in.', pr_body: 'The PR body: **technical prose**.',
  linked_issues: [1993], yes_count: 1, no_count: 0, votes_required: 2,
  created_at: '2026-09-11T12:00:00Z', staging_url: 'https://preview.example', check_state: 'passing',
  checks_checked_at: '2026-09-18T12:00:00Z',
  test_results: [{ name: 'Home loads', path: '/', status: 'pass' }],
  freshness: { mergeability: 'clean', behindBy: 0, checkedAt: '2026-09-18T12:00:00Z' },
  mergeRequirements: { measuredAt: '2026-09-18T12:00:00Z', gates: gates(), evaluated: true, provisional: false },
};

const plain = (o) => JSON.parse(JSON.stringify(o));
// B10b: the steps, the pull request and the description are Details, a
// sheet the page keeps mounted in the body (DetailsSheet portals, so a
// server render of the page has none of it). `page` is the page, `details`
// the sheet's contents, and `html` both, in the order the document holds
// them.
const render = (av, item, kind = 'proposal') => {
  const { ChangeDetail, DetailsBody } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const v = av._topicViewFor(kind, item);
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item }));
  const details = renderToHtml(createElement(DetailsBody, {
    prRef: v.body.hero ? v.body.hero.ref : null, steps: v.body.steps,
    help: !!(v.body.details && v.body.details.help), html: v.body.proposalBody ? v.body.proposalBody.html : '',
  }));
  return { v, page, details, html: page + details };
};

test('the page is the thread’s root post, the steps are in Details, and nothing the old shape had (#4455)', () => {
  const av = context();
  const { html, page, details } = render(av, PR);
  const at = (s) => { const i = page.indexOf(s); assert.ok(i >= 0, s); return i; };
  // The change, then Votes over Testing, one above the other.
  assert.ok(at('data-change-root="4090"') < at('data-change-gate="votes"'));
  assert.ok(at('data-change-gate="votes"') < at('data-change-gate="testing"'));
  // B10b: the steps moved one tap down, whole.
  assert.ok(!page.includes('dev-topic-steps'), 'no steps sheet on the page');
  assert.ok(details.includes('class="dev-topic-sheet dev-topic-steps"'));
  for (const gone of ['dev-topic-card"', 'dev-topic-about"', 'dev-topic-ledger', 'dev-topic-more', 'About this change',
    'What changes for you', 'Where it stands', 'More about this change', 'Testing instructions', 'dev-topic-fold',
    'dev-topic-hero', 'data-change-conversation', 'dev-topic-tested', 'gc-card-actions', 'Visible to the group']) {
    assert.ok(!html.includes(gone), `${gone} is not on the page`);
  }
});

test('the root post: who put it up and when, the title, the summary as a quote, and one row of the requests and the thanks', () => {
  const av = context();
  const { v, page, details } = render(av, PR);
  // The hero's model still names the author and the pull request (Details).
  const hero = plain(v.body.hero);
  assert.deepEqual(hero, {
    kind: 'Change', ref: { s: 'PR#12', href: 'https://github.com/example/app/pull/12' }, status: 'Waiting for approval',
    age: hero.age, author: 'maya', verb: 'proposed', provenance: null, tint: 'b',
  });
  assert.match(details, /^<p class="dev-details-pr" data-details-part="pr"><span>PR#12<\/span><a href="https:\/\/github\.com\/example\/app\/pull\/12" target="_blank" rel="noopener">Open on GitHub<\/a><\/p>/);
  const t = plain(v.body.thread);
  assert.equal(t.number, 12, '"Change #12" heads the sheet');
  assert.equal(t.author, 'maya');
  assert.equal(t.via, null);
  assert.match(page, /<span class="messages-message-author">maya<\/span><time dateTime="2026-09-11T12:00:00Z"/);
  assert.match(page, /<h1 class="dev-request-title" data-change-title="4090">Authenticate previews<\/h1>/);
  // The summary is the request page's quote.
  assert.match(page, /<div class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4" data-request-words="">[\s\S]{0,120}Previews wait for sign-in\./);
  // One row under it: "Addresses", the request's chip, the thanks.
  assert.match(page, /<span class="dev-change-chips-lead">Addresses<\/span><span class="dev-change-chips-first"><a href="[^"]*\/dev\/issues\/1993" class="dev-ws-chip dev-ws-chip-info dev-topic-issue" data-issue-ref="1993"><b>#1993<\/b><span>Wait for authentication before opening previews<\/span><\/a><\/span>/);
  assert.doesNotMatch(page, /data-kudos-host/, 'no Kudos on this page: no thanks');
  const thanked = render(context({ id: 42, username: 'Builder' }, KUDOS), PR).page;
  assert.match(thanked, /<\/a><\/span><span class="contents" data-kudos-host="4090" data-kudos-face="thread"><\/span><\/div>/, 'the thanks closes the row');
  assert.doesNotMatch(page, /data-status-tag|data-issue-chip|Closes #/, 'no tags on the post');
  // What built it, when something outside Homeroom did.
  assert.equal(av._topicViewFor('proposal', { ...PR, external_agent: 'claude-code' }).body.thread.via, 'via Claude Code');
});

// First-session run-through, 4 Oct 2026: a merged change's page read
// "CHANGE · MERGED" over a filled green "✓ Merged". A newcomer's word is
// live. #3848 also drew the pill grey, as a quiet done state; #3873 brought
// the green back for Live, so the pill is the green "✓ Live".
// First-session run-through, 4 Oct 2026: a newcomer's word is live. #4455:
// the Votes card says it was voted in, full and green, and where its
// rollout is; the eyebrow's words stay the hero model's.
test('a merged change was voted in: a full green Votes card that says where it is going live', () => {
  const av = context();
  const merged = { ...PR, status: 'merged', merged_at: '2026-09-19T12:00:00Z', mergeRequirements: undefined };
  const { v, page } = render(av, merged);
  assert.equal(v.body.hero.status, 'Live');
  assert.deepEqual(plain(v.body.thread.votes), {
    name: 'Votes', figure: 'Voted in', tone: 'done', done: true,
    segments: [{ weight: 1, pct: 100, state: 'done' }], label: 'Votes: voted in', note: ['It’s live.'],
  });
  assert.match(page, /data-change-gate="votes" data-done="true" data-tone="done"/);
  assert.doesNotMatch(page, /Merged/);
  const pending = av._topicViewFor('proposal', { ...merged, deployment_kind: 'child', deployment_state: 'pending' });
  assert.deepEqual(plain(pending.body.thread.votes.note), ['It’s going live.']);
  // While the rollout is pending or failed the eyebrow does not claim it.
  assert.equal(av._topicHeroView('proposal', { ...merged, deployment_kind: 'child', deployment_state: 'pending' }).status, 'Going live');
  assert.equal(av._topicHeroView('proposal', { ...merged, deployment_kind: 'child', deployment_state: 'failed' }).status, 'Not live yet');
  assert.equal(av._topicHeroView('proposal', { ...PR, status: 'merging' }).status, 'Going live');
});

// Flat 4B Chores, 5 Oct 2026: the first version (PR 3) was up for a vote
// when the bot built a fix on its branch (PR 8), and PR 8 merged with PR 3's
// commit in it. PR 3 is marked merged as included in PR 8
// (services/included-changes.js), and its page says where it went live: the
// eyebrow and the steps' headline name the change, the hero links to it, and
// nothing asks for a vote or offers to undo a merge it never had.
test('a change that went live inside another one says so and links to it', () => {
  const av = context();
  const included = {
    ...PR, status: 'merged', merged_at: '2026-10-05T12:00:00Z', mergeRequirements: undefined,
    merge_commit_sha: 'c'.repeat(40), included_in_session_id: 6288,
    included_in_pr_number: 8, included_in_pr_title: 'Fix mark as done in Jordan’s first version',
  };
  const { v, page, details } = render(av, included);
  assert.equal(v.body.hero.status, 'Live, included in #8');
  assert.equal(v.body.steps.headline, 'Live, included in #8');
  assert.match(details, /Live, included in #8/);
  assert.deepEqual(plain(v.body.includedIn), {
    heading: 'Went live as part of', state: 'merged', sessionId: 6288, label: '#8',
    title: 'Fix mark as done in Jordan’s first version', href: '#app/example/dev/changes/8',
  });
  const box = page.slice(page.indexOf('data-topic-part="included-in"'));
  assert.ok(page.includes('aria-label="The change this one went live in"'));
  assert.match(box, /<h4 class="dev-topic-h">Went live as part of<\/h4>/);
  assert.match(box, /href="#app\/example\/dev\/changes\/8"[^>]*data-included-in="6288"/);
  assert.match(box, />#8<\/span><span[^>]*>Fix mark as done in Jordan’s first version<\/span>/);
  // No vote, and no claim of a rollout of its own.
  assert.doesNotMatch(page, /data-vote-choice|Waiting for approval|It’s live\./);
  assert.equal(av._topicHeroView('proposal', { ...included, deployment_kind: 'child', deployment_state: 'pending' }).status,
    'Going live, included in #8');
  // A change that merged on its own says nothing of the kind.
  const own = render(av, { ...included, included_in_session_id: null, included_in_pr_number: null, included_in_pr_title: null });
  assert.equal(own.v.body.hero.status, 'Live');
  assert.equal(own.v.body.includedIn, null);
  assert.ok(!own.page.includes('data-included-in'));
  // A carrying change without a pull request number is still named.
  assert.equal(av._topicHeroView('proposal', { ...included, included_in_pr_number: null }).status,
    'Live, included in another change');
});

// First-session run-through, 4 Oct 2026. An invited flatmate tapped "Ready
// to try" and read, top to bottom: "homeroom_bot · proposed 35m ago", a
// "Closes #1" tag, "Thank homeroom_bot", and then the first version's spec:
// its Design brief, with the accent as RGB triples, the kit's class names
// and "Exact words: ...". The summary it came from is the spec's
// user-facing half (homeroom-bot-live.js specUserFacing), credit line last.
const LEAD = 'Everyone in the flat sees this week’s chores and who is on each one.';
const BRIEF = [
  '### Design',
  '- Accent: sage green (light 95 118 83, dark 168 201 138).',
  '- Kit: btn-primary, btn-secondary, card, skeleton, state-empty, state-error.',
  '- Exact words: "This week", "Done".',
].join('\n');
const BOT_PR = {
  ...PR, id: 5101, user_id: 99, username: 'homeroom_bot', pr_number: 2,
  pr_title: 'Share the flat’s chores and who is on each',
  pr_summary_md: `${LEAD}\n\n${BRIEF}\n\nAsked for by @maya`,
  pr_body: `${LEAD}\n\n${BRIEF}\n\nAsked for by @maya\n\nCloses #1`,
  linked_issues: [1],
};
const KUDOS = { Kudos: { _ensureCache: () => ({}), renderButton: () => '' } };

test('a change Homeroom bot built: the plain lead first, its Design brief one tap down, and no developer chrome', () => {
  const av = context({ id: 42, username: 'Builder' }, KUDOS);
  av._ghIssues = [{ number: 1, title: 'First version of Flat 4B Chores' }];
  const { v, page, details } = render(av, BOT_PR);

  // The summary is the lead and the credit; the brief is folded under it, shut.
  const summary = page.slice(page.indexOf('data-request-words'), page.indexOf('data-topic-part="summary-more"'));
  assert.ok(summary.includes(LEAD) && summary.includes('Asked for by @maya'));
  assert.doesNotMatch(summary, /Design|sage green|btn-primary|Exact words/);
  assert.match(page, /<details class="dev-topic-details dev-topic-hero-more" data-topic-part="summary-more"><summary class="dev-topic-details-summary">How it’s built<\/summary><div class="dev-issue-body dev-topic-details-body">[\s\S]*### Design[\s\S]*btn-primary[\s\S]*<\/div><\/details>/);
  assert.ok(page.indexOf('data-request-words') < page.indexOf('data-topic-part="summary-more"'));
  assert.ok(page.indexOf('data-topic-part="summary-more"') < page.indexOf('data-change-gate="votes"'), 'right under the lead');
  assert.doesNotMatch(v.body.summaryMore.html, /Asked for by/, 'the credit is the change’s, not the brief’s');
  // The open flag is AppView's, so a repaint keeps it open.
  av._setSummaryMoreOpen(5101, true);
  assert.equal(av._topicViewFor('proposal', BOT_PR).body.summaryMore.open, true);
  av._setSummaryMoreOpen(5101, false);
  assert.equal(av._topicViewFor('proposal', BOT_PR).body.summaryMore.open, false);
  // The whole description is still in Details, as on every change.
  assert.match(details, /data-details-part="description"[\s\S]*btn-primary[\s\S]*Closes #1/);

  // The post names the bot as it is named everywhere else.
  assert.equal(v.body.hero.author, 'Homeroom bot');
  assert.equal(v.body.hero.verb, 'made');
  assert.equal(v.body.thread.author, 'Homeroom bot');
  assert.match(page, /<span class="messages-message-author">Homeroom bot<\/span>/);
  assert.doesNotMatch(page, /homeroom_bot/);

  // The request is named once, in words, under the summary: no "Closes #1" tag.
  assert.doesNotMatch(page, /data-issue-chip|Closes #/);
  assert.match(page, /<span class="dev-change-chips-lead">Addresses<\/span><span class="dev-change-chips-first"><a [^>]*data-issue-ref="1"><b>#1<\/b><span>First version of Flat 4B Chores<\/span><\/a>/);

  // No kudos: they would thank the bot's account. Not on the post, not in ⋯.
  assert.equal(v.body.thread.thanks, false);
  assert.doesNotMatch(page, /data-kudos-host/);
  assert.ok(!av._cardMenuItems(v.card.rail.menuKey).some((a) => a.icon === 'kudos'));
  assert.ok(!av._proposalCardModel(BOT_PR, {}).actions.some((a) => a.kudos != null), 'nor on its board card');
  assert.ok(!av._proposalMenuItems(BOT_PR, { noNav: false }).some((a) => a.icon === 'kudos'), 'nor in the card’s ⋯');
  // Asking the bot for changes is the ⋯'s first row after Details.
  const menu = av._cardMenuItems(v.card.rail.menuKey);
  assert.ok(menu.some((a) => a.label === 'Ask for changes'));

  // A person's change keeps its thanks and its by-line.
  const { v: theirs, page: theirsPage } = render(av, PR);
  assert.match(theirsPage, /data-kudos-host="4090"/);
  assert.equal(theirs.body.hero.verb, 'proposed');
  assert.equal(theirs.body.summaryMore, null);
});

test('the lead is the stored summary’s own words: shown whole when there is nothing to fold, and never for a person’s change', () => {
  const av = context();
  const parts = (item) => plain(av._summaryParts(item));
  // A description the build wrote itself has no brief: shown whole.
  assert.deepEqual(parts({ ...BOT_PR, pr_summary_md: `${LEAD}\n\nAsked for by @maya` }),
    { lead: `${LEAD}\n\nAsked for by @maya`, more: '' });
  // A summary that opens with the brief has no lead to show: shown whole, as before.
  assert.deepEqual(parts({ ...BOT_PR, pr_summary_md: BRIEF }), { lead: BRIEF, more: '' });
  // A heading inside a code fence is not one.
  const fenced = `${LEAD}\n\n\`\`\`\n### Design\n\`\`\``;
  assert.deepEqual(parts({ ...BOT_PR, pr_summary_md: fenced }), { lead: fenced, more: '' });
  // The credit stays with the lead when a later update follows it.
  assert.deepEqual(parts({ ...BOT_PR, pr_summary_md: `${LEAD}\n\n${BRIEF}\n\nAsked for by @maya\n\n**Latest update:** Tidied the list.` }),
    { lead: `${LEAD}\n\nAsked for by @maya`, more: `${BRIEF}\n\n**Latest update:** Tidied the list.` });
  // Other subsections a person will see stay in the lead, up to the brief.
  assert.deepEqual(parts({ ...BOT_PR, pr_summary_md: `${LEAD}\n\n### Screens\nA row each.\n\n${BRIEF}` }),
    { lead: `${LEAD}\n\n### Screens\nA row each.`, more: BRIEF });
  // A person's (or their agent's) summary is theirs, headings and all.
  const mine = `${LEAD}\n\n${BRIEF}`;
  assert.deepEqual(parts({ ...PR, pr_summary_md: mine }), { lead: mine, more: '' });
  assert.equal(av._topicViewFor('proposal', { ...PR, pr_summary_md: mine }).body.summaryMore, null);
  // An underway session the bot is building reads the same way.
  const building = av._topicViewFor('session', { ...BOT_PR, status: 'active', shared_at: '2026-10-04T12:00:00Z' });
  assert.ok(building.body.summaryMore && /btn-primary/.test(building.body.summaryMore.html));
  assert.equal(building.body.hero.verb, 'started');
});

test('a stale summary stays, with the quiet line under it that says it was written for an earlier version', () => {
  const av = context();
  const { page } = render(av, { ...PR, pr_summary_stale: true });
  assert.match(page, /Previews wait for sign-in\./);
  assert.match(page, /<p class="dev-change-stale" role="note">Written for an earlier version of this change\.<\/p>/);
  assert.doesNotMatch(page, /No change summary has been added yet\./);
  assert.doesNotMatch(render(av, PR).page, /Written for an earlier version/);
});

test('a stale flag without any saved summary points to the current description', () => {
  const av = context();
  const { page } = render(av, { ...PR, pr_summary_md: null, pr_summary_stale: true });
  assert.match(page, /The current description is below\./);
  assert.doesNotMatch(page, /Written for an earlier version/);
  // "Below" is on the page: the description, folded under the line, in the
  // same markdown view the Details sheet reads.
  const fold = page.slice(page.indexOf('data-topic-part="description"'));
  assert.ok(page.includes('data-topic-part="description"'), 'the description is folded on the page');
  assert.ok(page.indexOf('The current description is below') < page.indexOf('data-topic-part="description"'), 'under the line that points at it');
  assert.match(fold, /<summary class="dev-topic-details-summary">Description<\/summary>/);
  assert.match(fold, /technical prose/);
  // A summary, or a plan, is read instead: no fold.
  assert.doesNotMatch(render(av, PR).page, /data-topic-part="description"/);
});

test('Vote is the Votes card’s button and Preview the Testing card’s; everything else is the sheet’s ⋯ (#4455)', () => {
  const av = context();
  const { v, page } = render(av, PR);
  const votes = page.slice(page.indexOf('data-change-gate="votes"'), page.indexOf('data-change-gate="testing"'));
  const testing = page.slice(page.indexOf('data-change-gate="testing"'));
  assert.match(votes, /<div class="dev-change-gate-act"><button type="button" class="dev-vote-btn"/);
  assert.match(testing, /<div class="dev-change-gate-act"><button type="button" class="gc-vote-btn gc-vote-btn-preview" aria-label="Open preview"/);
  assert.doesNotMatch(page, /gc-explore-chat-btn|>Share<|gc-card-actions/, 'no action band');
  const menu = av._cardMenuItems(v.card.rail.menuKey).map((a) => a.label);
  for (const row of ['Details', 'Explore in a coding agent', 'Share to…', 'View PR on GitHub']) {
    assert.ok(menu.includes(row), `${row} is a ⋯ row`);
  }
  assert.ok(!menu.includes('Edit requests'), 'a reader cannot edit its requests');
  const own = av._topicViewFor('proposal', { ...PR, user_id: 42 });
  assert.ok(av._cardMenuItems(own.card.rail.menuKey).some((a) => a.label === 'Edit requests'), 'its author can');
  assert.ok(menu.some((l) => /priority/.test(l)) && menu.some((l) => /Assign|assignee/.test(l)), 'and the tags');
  assert.ok(!menu.some((l) => /kudos/i.test(l)), 'the thanks is on the page');
});

test('the ⋯ menu carries Details as a row of its own, which opens the sheet', () => {
  const av = context();
  const { v, page, details } = render(av, PR);
  const menu = av._cardMenuItems(v.card.rail.menuKey);
  assert.equal(menu[0].label, 'Details');
  assert.equal(menu[0].icon, 'details');
  assert.ok(av.MENU_ICONS.details, 'the glyph resolves');
  assert.ok(!menu.some((a) => a.label === 'Open on GitHub'), 'B10b: GitHub is in Details');
  assert.ok(menu.some((a) => a.label === 'View PR on GitHub'), '#4455: and a ⋯ row, now the page has no PR link');
  // The sheet is body-mounted: the page itself renders none of it.
  assert.ok(!page.includes('technical prose'));
  assert.ok(!page.includes('dev-details-card'));
  assert.match(details, /<section class="dev-details-part" data-details-part="description"><h5 class="dev-details-sub">Description<\/h5><div class="dev-issue-body dev-topic-details-body">[\s\S]*technical prose/);
  const src = read('public/js/app-view.js');
  assert.match(src, /openTechnicalDetails\(id, part = null\) \{\n\s+window\.dispatchEvent\(new CustomEvent\('change-details-open', \{ detail: part \? \{ id: Number\(id\), part \} : Number\(id\) \}\)\);/);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /window\.addEventListener\('change-details-open', onOpen\)/);
  assert.match(tsx, /createPortal\(\n\s+<div className="dev-details-scrim" hidden=\{!open\}/, 'body-mounted: a frosted sheet would contain a fixed box; mounted while shut');
  assert.ok(tsx.includes('/(?:^|[?&])details=1(?:&|$)/'), '?details=1 opens it as the page loads');
  // A change with nothing written about it still has its steps there.
  const bare = av._topicViewFor('proposal', { ...PR, pr_body: null, pr_summary_md: null, spec_md: null });
  assert.equal(av._cardMenuItems(bare.card.rail.menuKey)[0].label, 'Details');
});

test('#4452: the Testing card is one bar, split by how long each part usually takes, with the time left', () => {
  const av = context();
  const testing = (over) => plain(av._changeTestingView({ ...PR, ...over }));
  // Passed: full and green, and what it took.
  const passed = testing({ checks_progress: { build: { step: 'done', steps: [{ key: 'image_build', ms: 180000 }] }, checksMs: 540000 } });
  assert.deepEqual([passed.name, passed.figure, passed.done, passed.segments], ['Tested', 'All checks passed', true, [{ weight: 1, pct: 100, state: 'done' }]]);
  assert.deepEqual(passed.note, ['Preview built in 3 min, checked in 9.']);
  // In flight: the build done, the checks a third of the way, about 6 minutes left.
  const live = testing({
    check_state: 'pending', check_phase: 'testing',
    checks_estimate: { buildMs: 180000, checksMs: 540000, runs: 12 },
    checks_progress: {
      ran: 284, expected: 840, unit: { ran: 6900, expected: 19240, done: false },
      build: { step: 'done', steps: [{ key: 'source_fetch', ms: 1 }, { key: 'image_build', ms: 1 }, { key: 'clone', ms: 1 }, { key: 'health', ms: 1 }, { key: 'prepare_checks', ms: 1 }] },
    },
  });
  assert.equal(live.figure, 'about 6 min left');
  assert.deepEqual(live.segments, [{ weight: 180000, pct: 100, state: 'done' }, { weight: 540000, pct: 35, state: 'moving' }]);
  assert.deepEqual(live.note, ['Preview built, checks a third done. Usually about 12 minutes here.']);
  // Still building: the build's step, and no checks yet.
  const building = testing({
    check_state: 'pending', check_phase: 'building', checks_estimate: { buildMs: 180000, checksMs: 540000 },
    checks_progress: { build: { step: 'clone', steps: [{ key: 'source_fetch', ms: 1 }, { key: 'image_build', ms: 1 }] } },
  });
  assert.equal(building.segments[1].pct, 0);
  assert.match(building.note[0], /^Building the preview, step 3 of 5\. Usually about 12 minutes here\.$/);
  // No estimate yet: where it is, and no promise of a time.
  assert.equal(testing({ check_state: 'pending', check_phase: 'testing', checks_progress: { ran: 1, expected: 4 } }).figure, 'Checking it');
  // A queued run says where it is in line.
  assert.match(testing({ check_state: 'pending', check_phase: 'queued', checks_progress: { queue: { ahead: 2 } } }).note[0], /\(2 ahead\)$/);
  // #4502: the deferred status explains the actual admission reason; the
  // native disclosure can open with a pointer, touch, or keyboard.
  const deferred = { ...PR, check_state: 'pending', check_phase: 'deferred' };
  const deferredView = testing(deferred);
  assert.deepEqual(deferredView.note, ['Checks deferred']);
  assert.equal(deferredView.noteDetail, av.CHECKS_PHASE_COPY.deferred.detail);
  assert.match(deferredView.noteDetail, /conflicts with main/);
  assert.match(deferredView.noteDetail, /run once it merges cleanly/);
  const deferredPage = render(av, deferred).page;
  assert.match(deferredPage, /<details[^>]*data-change-gate-explanation="">\s*<summary[^>]*title="[^"]*conflicts with main[^>]*>Checks deferred<\/summary>/);
  assert.match(deferredPage, /<p class="mt-2">The preview is up, but the tests were not run:/);
  assert.ok(!render(av, { ...PR, check_state: 'pending', check_phase: 'queued' }).page.includes('data-change-gate-explanation'));
  assert.ok(!render(av, PR).page.includes('data-change-gate-explanation'));
  // A failure says so in the same card, with the door to what failed.
  const failed = testing({ check_state: 'failing', test_results: [{ name: 'Home loads', status: 'fail' }] });
  assert.deepEqual([failed.figure, failed.tone, failed.details], ['Found a problem', 'bad', true]);
  assert.deepEqual(failed.note, ['1 check failed.']);
  assert.equal(testing({ check_state: 'skipped' }).figure, 'Not tested');
  assert.equal(testing({ check_state: 'error' }).figure, 'Couldn’t finish');
  assert.equal(testing({ check_state: null, staging_url: null }).figure, 'Not started');
  const { page } = render(av, PR);
  assert.match(page, /data-change-gate="testing" data-done="true" data-tone="done"/);
  const tsx = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.ok(tsx.includes("openTechnicalDetails?.(id, 'checks')"), 'See what failed opens Details at the Checks part');
  assert.ok(read('frontend/src/features/dev-board/topic/topic-head.tsx').includes('querySelector(`[data-note="${part}"]`)'), 'and scrolls to that part');
});

test('the steps sheet is the strip expanded: its headline and count, one short step per gate in the gate’s order', () => {
  const av = context();
  const { v, html } = render(av, PR);
  const s = plain(v.body.steps);
  assert.equal(s.headline, 'Waiting for your approval');
  assert.equal(s.detail, null, 'no detail on the page: the current step says it');
  assert.equal(s.simple, true);
  assert.deepEqual([s.done, s.total], [3, 5]);
  assert.deepEqual(s.rows.map((r) => [r.gate, r.key, r.state, r.label, r.line]), [
    ['approvals', 'votes', 'waiting', 'Votes', null],
    ['integration', 'mergeability', 'done', 'No conflicts with main', null],
    ['checks', 'checks', 'done', 'Checks', 'All 1 passed'],
    ['main_healthy', 'main_healthy', 'done', 'Main is healthy', null],
    ['github', 'github', 'pending', 'Merge', null],
  ]);
  // No actor column, no ledger sentence, no bar or pill inside the vote step.
  for (const r of s.rows) {
    assert.equal(r.actor, undefined, `${r.gate} names nobody`);
    assert.equal(r.row, undefined, `${r.gate} carries no ledger row`);
    assert.equal(r.vote, undefined, `${r.gate} carries no tally`);
  }
  assert.equal(s.rows[0].votes, 'Loading votes…', 'the Votes step names who voted, once the roster answers');
  assert.equal(s.rows[0].help, true);
  assert.match(html, /<div class="dev-steps-head"><span class="dev-steps-headline">Waiting for your approval<\/span><span class="dev-steps-count">3\/5<\/span><\/div>/);
  assert.match(html, /<li class="dev-step dev-step-waiting" data-note="votes" data-req-gate="approvals" data-req-state="waiting"><span class="dev-step-mark dev-step-mark-waiting" aria-hidden="true">!<\/span><span class="dev-step-main"><span class="dev-step-label">Votes<\/span><span class="dev-ledger-review-line"><span class="dev-ledger-roster dev-step-line">Loading votes…<\/span><span class="dev-ledger-help voting-help-hint"><button type="button" class="voting-help-btn un-touch-target" data-voting-help=""/);
  assert.doesNotMatch(html, /dev-step-actor|dev-step-vote-bar|dev-step-vote-tally|dev-ledger-text/, 'none of the old step furniture');
  // Checks opens onto its run; a finished run starts closed.
  assert.match(html, /<li class="dev-step dev-step-done" data-note="checks" data-req-gate="checks" data-req-state="done"><span class="dev-step-mark dev-step-mark-done" aria-hidden="true">✓<\/span><button type="button" class="dev-step-main dev-step-toggle" aria-expanded="false" aria-controls="dev-step-run-checks"><span class="dev-step-label">Checks<\/span><span class="dev-step-line">All 1 passed<\/span>/);
  assert.match(html, /<li class="dev-step dev-step-pending" data-note="github" data-req-gate="github" data-req-state="pending"><span class="dev-step-mark dev-step-mark-pending" aria-hidden="true">·<\/span><span class="dev-step-main"><span class="dev-step-label">Merge<\/span><\/span><\/li>/);
});

test('the card’s strip and the page say one fact in the same words', () => {
  const av = context();
  const item = { ...PR, integration: { blockReasons: ['integrating'] }, integration_conflict_paths: ['a.js'],
    mergeRequirements: { gates: gates({ approvals: { state: 'done' }, integration: { state: 'active', detail: { note: 'conflicts with main in 1 file; the platform will resolve it' } }, checks: { state: 'pending' } }), evaluated: true, provisional: false } };
  const spec = av.requirementsSpec(item);
  const integration = spec.gates.find((g) => g.key === 'integration');
  // The live lane wins over the recording's older wording, and the collapsed
  // line's detail IS the current step's line.
  assert.equal(integration.note, 'Resolving a conflict in 1 file');
  assert.equal(spec.detail, 'Resolving a conflict in 1 file');
  const { v } = render(av, item);
  assert.equal(plain(v.body.steps).rows.find((r) => r.gate === 'integration').line, 'Resolving a conflict in 1 file');
  // Checks behind an unfinished sync wait, rather than describing a run the
  // sync is about to throw away.
  assert.equal(spec.gates.find((g) => g.key === 'checks').note, 'Runs after the sync');
});

test('a step the recording did not reach takes what the columns already know', () => {
  const av = context();
  // The recording stopped at the vote; the head has since measured clean and
  // its checks are running.
  const item = { ...PR, check_state: 'pending', check_phase: 'testing', integration_merges_clean: true, integration_behind_by: 0,
    integration: { mergesClean: true, behindBy: 0, measuredAt: '2026-09-18T12:00:00Z' },
    mergeRequirements: { gates: gates({ integration: { state: 'pending', detail: null }, checks: { state: 'pending' } }), evaluated: true, provisional: false } };
  const spec = av.requirementsSpec(item);
  const state = (k) => spec.gates.find((g) => g.key === k).state;
  assert.equal(state('integration'), 'done');
  assert.equal(state('checks'), 'active', 'a live run is not "not reached"');
  assert.equal(spec.headline, 'Waiting for your approval', 'the current step is still the vote');
});

// #3234: the threshold counts active members live, so it can move while the
// vote is open. The vote step says so beside the counts when it has; a row
// whose number has not moved, or that predates the stamp, says nothing.
test('the vote step notes the threshold it opened with only when that has moved', () => {
  const av = context();
  const note = (item) => plain(render(av, item).v.body.steps).rows[0].was;
  assert.equal(note({ ...PR, votes_required_at_promote: 2 }), null, 'same number: nothing');
  assert.equal(note({ ...PR, votes_required_at_promote: null }), null, 'older proposal: nothing');
  assert.equal(note({ ...PR, votes_required_at_promote: 1 }), 'Needs 2, was 1 when voting opened');
  assert.equal(note({ ...PR, votes_required_at_promote: 1, approvals_required: 2 }), null,
    '"at least N" is a fixed count');
  const { html } = render(av, { ...PR, votes_required_at_promote: 1 });
  assert.match(html, /<span class="dev-step-line dev-step-vote-was">Needs 2, was 1 when voting opened<\/span>/);
  assert.doesNotMatch(render(av, PR).html, /dev-step-vote-was/);
});

test('a failing check opens its step onto the run, with each failure’s door; the merge step says the conflict in one line', () => {
  const av = context();
  const item = {
    ...PR, check_state: 'failing',
    test_results: [{ name: 'Home loads', path: '/', status: 'fail', failureReason: 'Expected app, received login' }],
    freshness: { mergeability: 'conflict', behindBy: 8, mergeabilityFiles: ['a.js', 'b.js'], checkedAt: '2026-09-18T12:00:00Z' },
    mergeRequirements: { gates: gates({ checks: { state: 'blocked', detail: { note: 'some checks are failing' } }, integration: { state: 'active', detail: { note: 'resolving a conflict with main (2 files)' } } }), evaluated: true, provisional: false },
  };
  const { v, html } = render(av, item);
  const s = plain(v.body.steps);
  assert.equal(s.headline, 'Waiting for your approval', 'the strip names the first outstanding step: the vote comes before the sync');
  const sync = s.rows.find((r) => r.gate === 'integration');
  assert.equal(sync.key, 'mergeability', 'the ledger row’s key is the data-note, so the declared checks still find it');
  assert.equal(sync.state, 'active');
  assert.equal(sync.line, 'Conflict in 2 files · queued to fix');
  assert.match(html, /data-note="mergeability" data-req-gate="integration" data-req-state="active"><span class="dev-step-mark dev-step-mark-active" aria-hidden="true"><span class="dc-status-icon dc-status-spinner-arc"/);
  assert.doesNotMatch(html, /Main has moved 8 commits ahead/, 'no sentence restating the sync');
  const checks = s.rows.find((r) => r.gate === 'checks');
  assert.equal(checks.state, 'blocked');
  assert.equal(checks.line, '1 of 1 failed');
  assert.equal(checks.run.open, true, 'a failed run opens by itself');
  assert.match(html, /data-note="checks" data-req-gate="checks" data-req-state="blocked">[\s\S]*?aria-expanded="true"[\s\S]*?<div class="dev-step-run" id="dev-step-run-checks">[\s\S]*?<span class="dev-step-run-v is-bad">0 passed · 1 failed<\/span>[\s\S]*?<ul class="dev-ledger-fails"><li class="dev-ledger-check dev-ledger-check-why"><details class="dev-ledger-why"><summary class="dev-ledger-check-line">/);
  assert.match(html, /Expected app, received login/);
});

test('a run in progress opens its step by itself: the build as its steps, then the checks and the unit suite as bars', () => {
  const av = context();
  const item = {
    ...PR, check_state: 'pending', check_phase: 'testing', check_trigger: 'commit-push', test_results: [],
    checks_progress: {
      ran: 212, passed: 210, failed: 2, expected: 412,
      unit: { phase: 'running', ran: 840, passed: 840, failed: 0, expected: 1284 },
      build: { step: 'done', totalMs: 160000, steps: [
        { key: 'source_fetch', ms: 4000 }, { key: 'image_build', ms: 112000 }, { key: 'clone', ms: 31000 },
        { key: 'health', ms: 13000 }, { key: 'prepare_checks', ms: 2000 }] },
    },
    mergeRequirements: { gates: gates({ checks: { state: 'active', detail: { note: 'still running' } } }), evaluated: true, provisional: false },
  };
  const { v, html } = render(av, item);
  const checks = plain(v.body.steps).rows.find((r) => r.gate === 'checks');
  assert.equal(checks.line, 'Running · 212 of 412');
  assert.equal(checks.run.live, true);
  assert.equal(checks.run.open, true);
  assert.match(html, /aria-expanded="true" aria-controls="dev-step-run-checks"/);
  assert.match(html, /<div class="dev-step-run-row dev-ledger-progress-build" data-build-step="done"><span class="dev-step-run-k">Build<\/span><span class="dev-ledger-build-bar" aria-hidden="true" data-build-progress="5\/5">(<span class="dev-ledger-build-seg is-done" data-step="[a-z_]+"><\/span>){5}<\/span><span class="dev-step-run-v">Built in 2m 40s<\/span><\/div>/);
  assert.match(html, /<span class="dev-step-run-k">App checks<\/span><span class="dev-step-run-track" aria-hidden="true"><i class="is-pass" style="width:50\.9[0-9]*%"><\/i><i class="is-fail" style="left:50\.9[0-9]*%;width:0\.4[0-9]*%"><\/i><\/span><span class="dev-step-run-v is-bad">212 \/ 412 · 2 failed<\/span>/);
  assert.match(html, /<span class="dev-step-run-k">Unit tests<\/span><span class="dev-step-run-track" aria-hidden="true">[\s\S]*?<span class="dev-step-run-v">840 \/ ~1,284<\/span>/);
  assert.match(html, /<p class="dev-step-run-note">Running the automated tests… Triggered by a new commit on this proposal\.<\/p>/);
  // A finished run starts closed, and a run behind an unfinished sync has
  // nothing to open.
  assert.equal(plain(render(av, PR).v.body.steps).rows.find((r) => r.gate === 'checks').run.open, false);
  const moot = { ...PR, mergeRequirements: { gates: gates({ integration: { state: 'active' }, checks: { state: 'pending' } }), evaluated: true, provisional: false } };
  assert.equal(plain(render(av, moot).v.body.steps).rows.find((r) => r.gate === 'checks').run, null);
});

test('a run that overlapped a platform update says it will run again, and opens onto its reason', () => {
  const av = context();
  const reason = 'Checks ran while Homeroom was updating, so they will run again.';
  const item = {
    ...PR, check_state: 'error', check_error_detail: reason, test_results: [],
    mergeRequirements: { gates: gates({ checks: { state: 'active', detail: { note: 'they ran while Homeroom was updating and will run again' } } }), evaluated: true, provisional: false },
  };
  const { v, html } = render(av, item);
  const checks = plain(v.body.steps).rows.find((r) => r.gate === 'checks');
  assert.equal(checks.state, 'active');
  assert.equal(checks.line, 'Will run again', 'nothing is running yet, so the line does not say Running');
  assert.equal(checks.run.live, false);
  assert.equal(checks.run.open, true, 'the reason is read without a tap');
  assert.equal(checks.run.note, reason);
  assert.match(html, /aria-expanded="true" aria-controls="dev-step-run-checks"/);
  assert.match(html, /<p class="dev-step-run-note">Checks ran while Homeroom was updating, so they will run again\.<\/p>/);
  assert.equal(checks.actions.length, 0, 'no re-run button: the run goes again on its own');
  // The page's Testing card says the same, still moving (#4455).
  assert.deepEqual([v.body.thread.testing.figure, v.body.thread.testing.note[0]], ['Running again soon', 'Testing will run again by itself.']);
  // Any other error, which blocks on the author, still reads as broken.
  const broke = { ...PR, check_state: 'error', check_error_detail: 'The test run broke.', test_results: [] };
  if (!av._checksWillRetry(broke)) assert.equal(av._changeTestingView(broke).figure, 'Couldn’t finish');
});

// #2588 retired the tail this test used to end on. The sheet's rows are the
// merge gates and the states of the change — a failed preview, console
// errors — and nothing else: the provenance notes that used to draw after
// them said where the change came from, which the hero line above the card
// says, and inside an x/y progress indicator that read as a step nobody
// could ever clear. The hero's own words are asserted here unchanged.
test('nothing draws after the gates: a failed preview is the Checks step’s, with its retry, and no provenance note', () => {
  const av = context();
  const item = { ...PR, source: 'imported', imported_pr_author: 'octo', staging_url: null, staging_error: 'container never came up', check_state: 'error',
    mergeRequirements: { gates: gates({ checks: { state: 'blocked', detail: { note: 'the staging preview could not start' } } }), evaluated: true, provisional: false } };
  const { v } = render(av, item);
  const s = plain(v.body.steps);
  assert.deepEqual(s.rows.map((r) => r.gate), ['approvals', 'integration', 'checks', 'main_healthy', 'github'], 'one step per gate, nothing else');
  const checks = s.rows.find((r) => r.gate === 'checks');
  assert.equal(checks.line, 'Couldn’t run');
  assert.equal(checks.run.note, 'The preview did not start: container never came up');
  assert.ok(checks.actions.some((a) => a.label === 'Retry preview'), 'the retry rides on the step');
  assert.equal(v.body.hero.verb, 'imported');
  assert.equal(v.body.hero.provenance, 'imported from GitHub (octo)');
});

test('buttons only for whoever can clear the step: Sync with main is the author’s, and only when the sync is theirs', () => {
  const mine = { ...PR, user_id: 42 };
  const stuck = (integration) => ({ ...mine, mergeRequirements: { gates: gates({ approvals: { state: 'done' }, integration }), evaluated: true, provisional: false } });
  const syncOf = (av, item) => plain(render(av, item).v.body.steps).rows.find((r) => r.gate === 'integration').actions.map((a) => a.label);
  const av = context();
  assert.deepEqual(syncOf(av, stuck({ state: 'blocked', actor: 'author', detail: { note: 'conflicts with main and the platform could not resolve it' } })), ['Sync with main']);
  assert.deepEqual(syncOf(av, stuck({ state: 'active', actor: 'auto', detail: { note: 'resolving a conflict with main' } })), [],
    'not while the platform is resolving it');
  assert.deepEqual(syncOf(av, stuck({ state: 'done' })), [], 'not on a finished step');
  assert.deepEqual(syncOf(context({ id: 9, username: 'jo' }), stuck({ state: 'blocked', actor: 'author' })), [], 'not for somebody else');
});

test('before review the page is the same shape: not up for a vote yet, and the steps it will take', () => {
  const av = context();
  const mine = { ...PR, user_id: 42, status: 'active', pr_number: null, pr_url: null, mergeRequirements: undefined, shared_at: null, spec_md: '# Spec' };
  const { v, html, page } = render(av, mine, 'session');
  assert.equal(v.body.hero.kind, 'Change');
  assert.equal(v.body.hero.ref, null);
  assert.equal(v.body.hero.status, 'Not shared yet');
  assert.equal(v.body.hero.verb, 'started');
  assert.equal(v.body.thread.number, null, 'no pull request yet: "Change"');
  assert.equal(v.body.thread.votes.figure, 'Not up for a vote yet');
  // The draft's own step, then the gates it will meet once it is up for a
  // vote, drawn the way a proposal's are: one short line each.
  const s = plain(v.body.steps);
  assert.equal(s.simple, true);
  assert.equal(s.headline, 'Waiting on you');
  assert.deepEqual([s.done, s.total], [2, 5]);
  assert.deepEqual(s.rows.map((r) => [r.key, r.state, r.label, r.line]), [
    ['review', 'waiting', 'Submitted for review', 'Ready'],
    ['votes', 'pending', 'Votes', null],
    ['mergeability', 'done', 'No conflicts with main', null],
    ['checks', 'done', 'Checks', 'All 1 passed'],
    ['github', 'pending', 'Merge', null],
  ]);
  assert.doesNotMatch(html, /Where it stands|dev-ledger-text/);
  // The one Submit for review is the Votes card's button; the step does not repeat it.
  assert.equal((html.match(/>Submit for review</g) || []).length, 1);
  assert.match(page.slice(page.indexOf('data-change-gate="votes"')), /^[^]*?data-act="runChangeAction">Submit for review</);
  // The Build door is a ⋯ row.
  const menu = av._cardMenuItems(v.card.rail.menuKey).map((a) => a.label);
  assert.ok(menu.includes('Continue building'));
  // The spec stands in for the technical half, behind the ⋯ row.
  assert.ok(menu.includes('Details'));
});

test('a draft’s steps: who is waiting, what the checks are doing, and Sync with main only for the owner of a conflicting draft', () => {
  const draft = { ...PR, user_id: 42, status: 'active', pr_number: null, pr_url: null, mergeRequirements: undefined, shared_at: '2026-09-12T12:00:00Z' };
  const steps = (av, item) => plain(render(av, item, 'session').v.body.steps);
  const row = (s, gate) => s.rows.find((r) => r.gate === gate);
  const owner = context();
  const other = context({ id: 9, username: 'jo' });
  // Somebody else reads whose turn it is, not the author's readiness note.
  const theirs = steps(other, draft);
  assert.equal(theirs.headline, 'Waiting on the author');
  assert.equal(row(theirs, 'review').line, 'Not submitted yet');
  // A run in progress opens Checks by itself; nothing else spins.
  const running = steps(owner, { ...draft, check_state: 'pending', check_phase: 'testing', test_results: [] });
  assert.equal(row(running, 'checks').state, 'active');
  assert.equal(row(running, 'checks').run.open, true);
  assert.equal(row(running, 'review').line, 'Ready · checks are still running');
  // A conflict: the checks wait for the sync, and the owner may sync now.
  const conflicted = { ...draft, check_state: 'pending', check_phase: 'deferred', test_results: [],
    freshness: { mergeability: 'conflict', behindBy: 5, mergeabilityFiles: ['a.js', 'b.js'], checkedAt: '2026-09-18T12:00:00Z' } };
  const c = steps(owner, conflicted);
  assert.deepEqual([row(c, 'integration').state, row(c, 'integration').line], ['pending', 'Conflict in 2 files']);
  assert.deepEqual(row(c, 'integration').actions.map((a) => a.label), ['Sync with main']);
  assert.deepEqual([row(c, 'checks').state, row(c, 'checks').line], ['pending', 'Runs after the sync']);
  assert.deepEqual(row(steps(other, conflicted), 'integration').actions, [], 'nobody else gets the button');
  assert.deepEqual(row(steps(owner, draft), 'integration').actions, [], 'a clean draft needs none');
  // Nothing pushed yet says so, and the checks have not run.
  const empty = steps(owner, { ...draft, staging_url: null, check_state: null, test_results: [], freshness: null });
  assert.equal(row(empty, 'review').line, 'Nothing committed yet');
  assert.equal(row(empty, 'checks').line, 'Not run yet');
  // A failed run is the Checks step's, with its door and its re-run; no
  // separate row trails after the steps.
  const failing = steps(owner, { ...draft, check_state: 'failing',
    test_results: [{ name: 'Home loads', path: '/', status: 'fail', failureReason: 'Expected app, received login' }] });
  assert.equal(row(failing, 'checks').state, 'blocked');
  assert.equal(row(failing, 'checks').run.open, true);
  assert.ok(row(failing, 'checks').actions.some((a) => /re-run/i.test(a.label)));
  assert.equal(row(failing, 'review').line, 'Ready · checks must pass before it merges');
  assert.deepEqual(failing.rows.map((r) => r.gate), ['review', 'approvals', 'integration', 'checks', 'github']);
});

test('the picture: verified shots are the viewer specs use, a run under way is a line inside the card, a failed one says why', () => {
  const av = context();
  const claim = { id: 's1', claim: 'The preview waits for sign-in', viewports: ['desktop'], steps: ['Open a preview'] };
  const building = render(av, { ...PR, shots: { state: 'exploring', claims: [claim], artifacts: [] } }).page;
  assert.match(building, /<section class="dev-change-shots dev-change-shots-plain" data-change-shots="exploring" aria-label="Before and after"><div class="dev-change-card-name">Before and after<\/div><p class="dev-change-shots-line"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span><span>Taking the shots\. They show up here when they are ready\.<\/span><\/p>/);
  assert.ok(!building.includes('data-shots="1"'), 'no panel for a run still going');
  const failed = render(av, { ...PR, shots: { state: 'failed', failureReason: 'The dialog never opened.', claims: [claim], artifacts: [] } }).page;
  assert.match(failed, /data-change-shots="failed"[\s\S]*<span>Couldn’t take the shots\. The dialog never opened\.<\/span>/);
  assert.ok(!failed.includes('dc-status-spinner-arc'));
  // Interrupted by a restart, with an automatic retry coming: under way.
  const retrying = render(av, { ...PR, shots: {
    state: 'failed', failureCode: 'shots_run_interrupted', automaticRetryPending: true,
    failureReason: 'Homeroom restarted.', claims: [claim], artifacts: [],
  } }).page;
  assert.match(retrying, /<span class="dc-status-spinner-arc" aria-hidden="true"><\/span><span>Taking the shots\./);
  // Verified: the side-by-side viewer, its title in the switch's row; the
  // steps and the screen size are Shot details' (Details), not the card's.
  const url = (side) => `/api/apps/example/proposals/4090/shots/${side.repeat(32)}`;
  const shots = { state: 'verified', claims: [claim], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    artifacts: [{ storyId: 's1', viewport: 'desktop', side: 'base', variant: 'context', url: url('a') },
      { storyId: 's1', viewport: 'desktop', side: 'head', variant: 'context', url: url('b') }] };
  const verified = render(av, { ...PR, shots }).page;
  assert.match(verified, /<section class="dev-change-shots" data-change-shots="verified"><div class="dev-change-shots-html"><section data-shots="1" data-shots-state="verified" aria-label="Before and after" class="dev-change-shots-body"><div class="shots-viewer shots-viewer-spec dev-change-viewer">/);
  assert.match(verified, /<div class="shots-bar"><span class="dev-change-card-name">Before and after<\/span><span class="shots-seg shots-seg-side"/);
  assert.match(verified, /shots-seg-both/, 'side by side is one of its sides');
  assert.match(verified, /shots-side-auto/, 'and it starts side by side when there is room');
  assert.doesNotMatch(verified, /shots-view-meta|Open a preview|Taken on the exact|Shots ready|Shot details|Take the shots again/);
  const shot = av.shotsHtml(shots, { sessionId: 4090, details: true });
  assert.match(shot, /<strong>The preview waits for sign-in<\/strong>[\s\S]*Desktop · seen as a member[\s\S]*Open a preview/);
  assert.match(shot, /Taken on the exact before and after builds of this change/);
  const menu = (item) => { const v = av._topicViewFor('proposal', item); return av._cardMenuItems(v.card.rail.menuKey).map((a) => a.label); };
  assert.ok(menu({ ...PR, shots }).includes('Shot details'));
  assert.ok(!menu({ ...PR, user_id: 42, shots: { ...shots, state: 'exploring' } }).includes('Take the shots again'), 'not while a run is going');
  assert.ok(menu({ ...PR, user_id: 42, shots }).includes('Take the shots again'), 'the author can take them again');
  assert.ok(!menu({ ...PR, shots }).includes('Take the shots again'), 'somebody else cannot');
});

test('the capture tiles are checked on a live proposal page, against the staging captures they are seeded with (#4269)', () => {
  // #3976 retired the three checks that read the tiles (the routes past the
  // first behind a disclosure, the phone outline, the empty tile) with the
  // classic chat's Changes-ready card on 990412. The tiles still render for
  // everyone on a proposal's page, in the hero, so ONE check reads all three
  // there, on the promoted staging proposal whose captures cover each state:
  // 900001 on staging-demo-app (migrate.js seedStagingDemoAppCard, then
  // seedStagingVisuals).
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /\(900001, 'Staging demo app', 'staging-demo-app', 'running', 'public', 900001\)/);
  assert.match(migrate, /\(900001, 900001, 900001, 'staging-demo\/promoted-pr', 900001,\s+'Staging demo PR[^']*', 'promoted', NOW\(\)\)/);
  assert.ok(migrate.indexOf('await seedStagingDemoAppCard(pool);') < migrate.indexOf('await seedStagingVisuals(pool);'),
    'the captures are written after the proposal they hang off');
  const start = migrate.indexOf('async function seedStagingVisuals(pool)');
  const seed = migrate.slice(start, migrate.indexOf('\n}\n', start));
  assert.match(seed, /const DEMO_SESSION_ID = 900001;/);
  const deep = /const SELF_APP_DEEP_PATH = '([^']+)'/.exec(seed)[1];
  // The rows as /promoted aggregates them, shaped by the route's own helper.
  const agg = {};
  for (const [, ch, rest] of seed.matchAll(/\{ id: '(\w)'\.repeat\(32\), ([^}]*)\}/g)) {
    const field = (name) => {
      const m = new RegExp(`${name}: (?:'([^']*)'|(\\w+))`).exec(rest);
      return m ? (m[1] ?? m[2]) : undefined;
    };
    const p = field('path');
    agg[`${field('kind')}_${field('idx')}_${field('media')}`] = {
      id: ch.repeat(32), path: p === 'SELF_APP_DEEP_PATH' ? deep : p,
      viewport: field('viewport') || null, commit: null, fellBack: field('fellBack') === 'true',
    };
  }
  const shaped = require('../src/services/visuals').shapeAgg(agg, null);
  const groups = shaped.captures;
  assert.ok(groups.length > 1, 'more than one route, so the rest sit behind the disclosure');
  assert.ok(groups.slice(1).some((g) => g.viewport === 'mobile'), 'a phone capture past the first route');
  assert.ok(groups.some((g) => !g.before && g.after), 'a route with no production version');

  const av = context();
  const { html } = render(av, { ...PR, id: 900001, shots: null, visuals: shaped });
  const card = html.indexOf('data-change-shots="legacy"');
  const scope = html.indexOf('<div class="dev-change-shots-tiles usn-visuals-body" data-visuals-scope="1">');
  assert.ok(card >= 0 && scope > card, 'the tiles are in the Before and after card');
  const more = html.indexOf(`<details class="usn-visual-more"><summary class="usn-visual-more-summary">All ${groups.length} screens</summary>`, scope);
  assert.ok(more > scope, 'the routes past the first sit behind "All N screens"');
  assert.match(html.slice(more), /class="usn-visual-media usn-visual-phone"/, 'the phone capture is drawn in its outline');
  assert.match(html.slice(scope), /class="usn-visual-empty" aria-hidden="true"/, 'the missing side is an empty tile');

  const DAPP = JSON.parse(read('dapp.json'));
  const check = DAPP.tests.find((t) => t.path === '/#app/staging-demo-app/dev/proposals/900001');
  assert.ok(check, 'the proposal page is a declared check');
  assert.equal(check.expectSelector,
    '#dev-topic-thread [data-change-shots="legacy"] [data-visuals-scope]:has(.usn-visual-more .usn-visual-phone):has(.usn-visual-empty)'
    + ' .usn-visual-more > .usn-visual-more-summary');
  assert.equal(check.expectText, `All ${groups.length} screens`, 'the count the seeded captures make');
  assert.ok(!DAPP.tests.some((t) => /#dc-pr-card[^"]*\.usn-visual/.test(t.expectSelector || '')),
    'nothing reads them on the classic card any more');
});

test('an issue page keeps the card and the sections under it', () => {
  const av = context();
  const issue = { number: 1993, title: 'Wait for authentication before opening previews', body: 'The preview opens on the login page.', state: 'open', user: { login: 'maya' }, created_at: '2026-09-11T12:00:00Z' };
  const { v, html } = render(av, issue, 'issue');
  assert.equal(v.body.hero, undefined);
  assert.equal(v.body.steps, undefined);
  assert.match(html, /class="dev-topic-sheet dev-topic-card" data-topic-sheet="card"/);
  assert.ok(!html.includes('dev-topic-hero'));
  assert.ok(!html.includes('data-change-root'));
});

test('the band is the card’s alone now; the change page draws none (#4455)', () => {
  const card = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(card, /export function ActionBand\(\{ actions, menuKey, preview, lead, actionEnd, dense \}/);
  assert.match(card, /<ActionBand\n\s+actions=\{bandActions\}\n\s+menuKey=\{m\.rail\.menuKey \|\| ''\}\n\s+preview=\{m\.actionPreview \|\| m\.rail\.preview \|\| null\}\n\s+actionEnd=\{actionEnd\}\n\s+dense=\{dense\}\n\s+\/>/, 'DevCard draws its band through it');
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx') + read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.doesNotMatch(tsx, /<ActionBand|ChangeHero|dev-topic-hero-actions/);
});



test('no bare whitespace expression, no em dash in copy, no computed Tailwind class', () => {
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.doesNotMatch(tsx, /\{' '\}/);
  // Every utility the steps panel wears is the strip's own complete literal.
  assert.match(tsx, /className="dev-steps rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800\/50"/);
  assert.match(tsx, /className="dev-steps-list border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"/);
});

// ── #2601/#2558: "planned" is two different things ───────────────────────
//
// `recordIntent` writes 'planned' onto a proposal the moment it declares a
// claim, and only a scheduled run moves it on. So the same state covers a
// run minted seconds ago and one nothing ever picked up — and every surface
// spun on both. Five minutes of an untouched 'planned' is the product
// owner's line between them.
const IDLE = 5 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const CLAIM = { claim: 'The preview waits for sign-in', viewports: ['desktop'], steps: ['Open a preview'] };

test('a fresh planned run is in progress, and says so in the words the state uses', () => {
  const av = context();
  const evidence = { state: 'planned', updatedAt: ago(30 * 1000), claims: [CLAIM], artifacts: [] };
  assert.equal(av._shotsNotStarted(evidence), false);
  const v = av._shotsView(evidence);
  assert.equal(v.label, 'Before & after queued');
  assert.equal(v.notStarted, false);
  assert.match(v.sentence, /^Before & after: getting ready to take the shots\. Homeroom shows each declared change before and after, on this exact proposal build\.$/);
  // It is still a run under way, so the card keeps its quiet spinner line.
  const { page } = render(av, { ...PR, shots: evidence });
  assert.match(page, /data-change-shots="planned"[^]*<span class="dc-status-spinner-arc" aria-hidden="true"><\/span><span>Taking the shots\. They show up here when they are ready\.<\/span>/);
});

test('a failed run quotes its reason as written and promises no shots', () => {
  const av = context();
  const v = av._shotsView({
    state: 'failed', failureCode: 'shots_capture_incomplete',
    failureReason: 'API returned 500 on the members list.', claims: [CLAIM], artifacts: [],
  });
  assert.equal(v.sentence, 'Couldn\u2019t take the shots. API returned 500 on the members list.');
  assert.ok(!/Homeroom shows each declared change/.test(v.sentence));
});

test('a planned run untouched past five minutes has not started: no spinner, the reason, and the retry', () => {
  const av = context();
  const evidence = {
    state: 'planned',
    updatedAt: ago(IDLE + 60 * 1000),
    notStartedReason: 'Before & after shots are not being taken on this deployment.',
    claims: [CLAIM],
    artifacts: [],
  };
  assert.equal(av._shotsNotStarted(evidence), true);
  const v = av._shotsView(evidence);
  assert.equal(v.label, 'Before & after not started');
  assert.equal(v.notStarted, true);
  assert.match(v.sentence, /not being taken on this deployment\. None have been taken for this commit yet\.$/);
  assert.ok(!/Homeroom shows each declared change/.test(v.sentence),
    'a run that never started is not promising shots are being taken');

  const { page } = render(av, { ...PR, user_id: 42, shots: evidence });
  assert.ok(!page.includes('dc-status-spinner-arc'), 'nothing spins on a run that is not moving');
  assert.ok(!page.includes('Taking the shots'));
  // The card says it has not started, and why; the retry is the ⋯'s.
  assert.match(page, /data-change-shots="planned"/);
  assert.match(page, /Before &amp; after not started\. Before &amp; after shots are not being taken on this deployment\./);
  const v2 = av._topicViewFor('proposal', { ...PR, user_id: 42, shots: evidence });
  assert.ok(av._cardMenuItems(v2.card.rail.menuKey).some((a) => a.label === 'Take the shots again'));
  assert.doesNotMatch(page, /Visual change preview|Retry visual/);
});

test('with no reason recorded the not-started state still stands on its own', () => {
  const av = context();
  const evidence = { state: 'planned', updatedAt: ago(IDLE + 1000), claims: [CLAIM], artifacts: [] };
  const v = av._shotsView(evidence);
  assert.equal(v.label, 'Before & after not started');
  assert.match(v.sentence, /nothing has picked this preview up yet/i);
});

test('an unknown or missing timestamp reads as still starting, never as stuck', () => {
  const av = context();
  for (const updatedAt of [undefined, null, '', 'not a date']) {
    assert.equal(av._shotsNotStarted({ state: 'planned', updatedAt }), false,
      `a ${JSON.stringify(updatedAt)} timestamp must not be read as an idle run`);
  }
  // And the threshold itself is the five minutes that was asked for.
  assert.equal(av.SHOTS_IDLE_MS, 5 * 60 * 1000);
  assert.equal(av._shotsNotStarted({ state: 'planned', updatedAt: ago(IDLE - 30 * 1000) }), false);
  // Only 'planned' is ever read this way: the other pending states are
  // written by a run that is demonstrably executing.
  for (const state of ['provisioning', 'exploring', 'replaying', 'reviewing', 'failed', 'verified']) {
    assert.equal(av._shotsNotStarted({ state, updatedAt: ago(IDLE * 10) }), false, state);
  }
});

test('the card tag follows the same split, and only the moving one spins', () => {
  const av = context();
  const reasons = (evidence) => av.blockReasons({ ...PR, shots: evidence })
    .find((r) => r.key === 'shots');

  const moving = reasons({ state: 'planned', updatedAt: ago(10 * 1000), required: true });
  assert.equal(moving.label, 'Taking before & after shots');
  assert.equal(moving.running, true);

  const stuck = reasons({
    state: 'planned', updatedAt: ago(IDLE + 1000), required: true,
    notStartedReason: 'No staging preview was built for this commit.',
  });
  assert.equal(stuck.label, 'Before & after not started');
  assert.equal(stuck.running, false, 'the neutral in-flight tone is what read as "any moment now"');
  assert.equal(stuck.detail, 'No staging preview was built for this commit.');

  const failed = reasons({ state: 'failed', updatedAt: ago(IDLE * 2), required: true, failureReason: 'The dialog never opened.' });
  assert.equal(failed.label, 'Couldn\u2019t take the shots');
  assert.equal(failed.running, false);
  assert.equal(failed.detail, 'The dialog never opened.');
  // Interrupted by a restart, with an automatic retry coming: under way.
  const retrying = reasons({
    state: 'failed', updatedAt: ago(10 * 1000), required: true, failureCode: 'shots_run_interrupted',
    automaticRetryPending: true, failureReason: 'Homeroom restarted. You can take them again.',
  });
  assert.equal(retrying.label, 'Trying the shots again');
  assert.equal(retrying.running, true);
  assert.match(retrying.detail, /starts them again on its own in a moment/);
  const exploring = reasons({ state: 'exploring', updatedAt: ago(IDLE * 2), required: true });
  assert.equal(exploring.label, 'Taking before & after shots');
  assert.equal(exploring.running, true);
  // A set that is neither moving nor failed (a newer commit made it stale)
  // still owes the proposal its shots.
  const stale = reasons({ state: 'stale', updatedAt: ago(IDLE * 2), required: true });
  assert.equal(stale.label, 'Before & after needed');
  assert.equal(stale.running, false);
  assert.equal(stale.detail, 'This proposal has no before & after shots for its current commit yet.');
  // Shots that are ready, waived or not needed owe nothing.
  for (const state of ['verified', 'overridden', 'not_required']) {
    assert.equal(reasons({ state, required: true }), undefined, state);
  }
});

test('every state reads in the before & after words', () => {
  const av = context();
  const copy = (evidence) => av._shotsStateCopy(evidence);
  const at = copy({ state: 'planned', updatedAt: ago(10 * 1000) });
  assert.equal(at.planned[0], 'Before & after queued');
  assert.equal(at.provisioning[0], 'Building before and after');
  assert.equal(at.exploring[0], 'Taking the shots');
  assert.equal(at.reviewing[0], 'Saving the shots');
  assert.equal(at.failed[0], 'Couldn\u2019t take the shots');
  assert.equal(at.stale[0], 'Shots are out of date');
  assert.equal(at.cancelled[0], 'Shots cancelled');
  assert.equal(at.not_required[0], 'No before & after needed');
  assert.equal(at.overridden[0], 'Shots waived');
  assert.equal(copy({ state: 'failed', failureCode: 'shots_stopped' }).failed[0], 'Shots stopped');
  // A verified run's strip label is the card's badge.
  assert.equal(av._shotsView({ state: 'verified', claims: [CLAIM] }).label, 'Shots ready');
  assert.doesNotMatch(JSON.stringify(at), /visual change preview|visual preview/i);
});

// #3826: a change that needs a Yes from another member said so only in the
// lock glyph's hover title, which a phone never shows. The hero says it in
// words under the status row while that Yes is missing, and says nothing
// once it is in or when the rule does not apply.
test('the Votes card says when a change still needs a Yes from another member', () => {
  const av = context();
  const flagged = {
    ...PR, requires_explicit_approval: true, explicit_approval_reason: 'governance',
    needs_other_member_yes: true, other_member_yes_count: 0,
  };
  const line = /Needs a Yes from another member before it can go live\./;
  const votes = (item) => { const { page } = render(av, item); return page.slice(page.indexOf('data-change-gate="votes"'), page.indexOf('data-change-gate="testing"')); };
  assert.match(votes(flagged), line);
  // Satisfied: nothing.
  assert.doesNotMatch(votes({ ...flagged, other_member_yes_count: 1 }), line);
  // A one-member project, or an unflagged change: nothing.
  assert.doesNotMatch(votes({ ...flagged, needs_other_member_yes: false }), line);
  assert.doesNotMatch(votes(PR), line);
  // Settled: nothing.
  assert.doesNotMatch(votes({ ...flagged, status: 'closed' }), line);
});

test('#4455: the Votes card: one part per yes, the figure in the accent when the viewer can give it, and a yes a newer push retired', () => {
  const av = context();
  const v = av._topicViewFor('proposal', PR);
  const votes = (item, roster) => {
    if (roster) av._voteRoster[item.id] = { phase: 'ready', ...roster };
    const built = av._topicViewFor('proposal', item);
    return plain(built.body.thread.votes);
  };
  const open = votes(PR, { yesNames: ['jo'], earlierYes: ['cilokman'], earlierNo: [], approvers: 3 });
  assert.equal(open.figure, 'Needs 1 more yes');
  assert.equal(open.tone, 'ask');
  assert.deepEqual(open.segments, [{ weight: 1, pct: 100, state: 'moving' }, { weight: 1, pct: 0, state: 'moving' }]);
  assert.deepEqual(open.note, ['Any of the 3 approvers can give it.', 'cilokman’s yes was on an earlier version.']);
  // The viewer has voted: the figure is no longer an ask.
  assert.equal(votes({ ...PR, my_vote: 'yes' }).tone, 'muted');
  // Reached, while testing runs: the names, and that it waits on testing.
  const reached = votes({ ...PR, yes_count: 2, check_state: 'pending' }, { yesNames: ['jo', 'cilokman'], earlierYes: [], earlierNo: [], approvers: 0 });
  assert.equal(reached.figure, '2 of 2 yes');
  assert.equal(reached.done, true);
  assert.deepEqual(reached.note, ['jo and cilokman said yes.', 'It goes live once testing passes.']);
  assert.ok(v.body.thread.votes, 'every change page has its Votes card');
  // The roster keeps the names the card reads.
  const src = read('public/js/app-view.js');
  assert.match(src, /earlierYes,\n\s+earlierNo,\n\s+yesNames: Array\.isArray\(data\.yes\) \? data\.yes\.slice\(\) : \[\],\n\s+approvers: Array\.isArray\(data\.approvers\) \? data\.approvers\.length : 0,/);
});
