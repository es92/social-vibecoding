// GitHub links only where something is on GitHub.
//
// Every repository, pull request, request and commit link used to be
// GitHub's and said so ("View PR on GitHub", "Open on GitHub", the GitHub
// mark). Since the move to Homeroom's own git host a request's `htmlUrl` is
// its own page here, a proposal's `pr_url` is its change page (GitHub only
// for the platform's own repository and old rows), and app repositories and
// commits are on the git host. Each site now decides by the address
// (frontend/src/lib/repo-link.js, pinned in tests/repo-link.test.js):
//
//   - a github.com URL keeps its GitHub label and mark;
//   - a Homeroom page is no outbound link where the viewer is on it or on a
//     card that opens it, and an in-app link (its route) anywhere else;
//   - a git host repository or commit is "View code" / "Code" with a
//     neutral code mark.
//
// This file pins the sites: the ⋯ rows, the meta-line numbers, the closes
// pills, the version pill, the Details sheet, the dev chat's changes card,
// the home menu's code row and the About pane's Code row.
//
// Run with: node --test tests/github-link-decisions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { installRepoLink } = require('./lib/repo-link');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');
const {
  closeIssueCardHtml, issueCardHtml, mergedCardHtml, proposalCardHtml, sharedSessionCardHtml,
} = require('./lib/dev-card-html');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MERGE_STATUS_SRC = read('public/js/merge-status.js');
const SRC = read('public/js/app-view.js');

const GITHUB_PR = 'https://github.com/Usernode-Labs/social-vibecoding/pull/5821';
const CHANGE_PAGE = 'https://onhomeroom.com/#app/notes-1a2b3c/dev/changes/7';
const REQUEST_PAGE = 'https://onhomeroom.com/#app/notes-1a2b3c/dev/issues/12';
const GIT_HOST_REPO = 'https://git.onhomeroom.com/apps/notes-1a2b3c';
const GIT_HOST_COMMIT = `${GIT_HOST_REPO}/commit/0123456789abcdef0123456789abcdef01234567`;

function makeAppView({ links = true } = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42, canAdminWrite: false } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => false, actionSheet: () => {}, toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { origin: 'https://onhomeroom.com', hash: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    published: {},
  };
  sandbox.UsernodeReact = {
    devBoard: {
      mountCardMenu: () => {},
      publishCardMenu: () => {},
      publishCodePause: (state) => { sandbox.published.codePause = state; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  if (links) installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  AppView.appData = { id: 10, slug: 'notes-1a2b3c', can_collaborate: true };
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 7, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});
const labels = (items) => Array.from(items || [], (it) => it.label);
const menuOf = (AppView, html) => {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? (AppView._cardMenus[m[1]] || []) : [];
};

test('a ⋯ row to a pull request on GitHub keeps "View PR on GitHub" and the GitHub mark', () => {
  const AppView = makeAppView();
  const row = AppView._prMenuItem(GITHUB_PR, 'View PR on GitHub', 'View code');
  assert.equal(row.label, 'View PR on GitHub');
  assert.equal(row.icon, 'github');
  assert.equal(row.githubPr, true);
  const items = AppView._proposalMenuItems(PR({ pr_url: GITHUB_PR }), {});
  const gh = Array.from(items).find((it) => it.githubPr);
  assert.ok(gh, 'the proposal menu offers it');
  assert.equal(gh.label, message('changes:proposal.menu.viewPr'));
  assert.equal(AppView._menuIconKey(gh), 'github');
});

test('a change kept in Homeroom has no GitHub row: its pull-request address is its own page', () => {
  const AppView = makeAppView();
  assert.equal(AppView._prMenuItem(CHANGE_PAGE, 'View PR on GitHub', 'View code'), null);
  for (const items of [
    AppView._proposalMenuItems(PR({ pr_url: CHANGE_PAGE }), {}),
    AppView._importedUnderwayMenuItems(PR({ pr_url: CHANGE_PAGE, status: 'active', source: 'imported' })),
    menuOf(AppView, sharedSessionCardHtml(AppView, PR({ pr_url: CHANGE_PAGE, status: 'active', shared_at: '2026-06-01T00:00:00Z' }))),
  ]) {
    const all = labels(items);
    assert.ok(!all.some((l) => /GitHub/.test(l)), all.join('|'));
    assert.ok(!Array.from(items).some((it) => it.icon === 'github' || it.githubPr || it.codePr));
  }
});

test('code on the git host is "View code", with the neutral code mark', () => {
  const AppView = makeAppView();
  const row = AppView._prMenuItem(GIT_HOST_REPO, 'View PR on GitHub', 'View code');
  assert.equal(row.label, 'View code');
  assert.equal(row.icon, 'code');
  assert.equal(row.codePr, true);
  assert.equal(AppView._menuIconKey(row), 'code');
  assert.ok(AppView.MENU_ICONS.includes('code'));
  assert.equal(message('changes:proposal.menu.viewCode'), 'View code');
});

test('a request\'s own page is no "Open on GitHub"; an issue still on GitHub keeps it', () => {
  const AppView = makeAppView();
  const issue = (htmlUrl) => ({ number: 12, title: 'Fix the thing', htmlUrl });
  assert.ok(!labels(AppView._issueMenuItems(issue(REQUEST_PAGE), {})).includes(message('changes:issue.menu.openOnGithub')));
  assert.ok(labels(AppView._issueMenuItems(issue('https://github.com/o/r/issues/12'), {})).includes('Open on GitHub'));
});

test('a card\'s own number is plain text for a Homeroom page and a new-tab link on GitHub', () => {
  const AppView = makeAppView();
  // A proposal card opens the change's page; its PR#7 linking there too
  // would open the same page again.
  const native = proposalCardHtml(AppView, PR({ pr_url: CHANGE_PAGE }));
  assert.match(native, /<span class="font-mono"[^>]*>PR#7<\/span>/);
  assert.doesNotMatch(native, /href="[^"]*dev\/changes\/7"[^>]*target="_blank"/);
  const github = proposalCardHtml(AppView, PR({ pr_url: GITHUB_PR }));
  assert.match(github, new RegExp(`<a href="${GITHUB_PR}" target="_blank" rel="noopener"[^>]*>PR#7</a>`));
  // The same rule for a request card's #12, and a merged card's PR#.
  assert.match(issueCardHtml(AppView, { number: 12, title: 'T', htmlUrl: REQUEST_PAGE }), /<span class="font-mono"[^>]*>#12<\/span>/);
  assert.match(mergedCardHtml(AppView, PR({ pr_url: CHANGE_PAGE, status: 'merged' }), 3), /<span class="font-mono"[^>]*>PR#7<\/span>/);
});

test('without the reader, a site draws no link rather than guessing GitHub', () => {
  const AppView = makeAppView({ links: false });
  assert.equal(AppView._prMenuItem(GITHUB_PR, 'View PR on GitHub', 'View code'), null);
  assert.deepEqual({ ...AppView._ownRefPart(GITHUB_PR, 'PR#7', 'x') }, { t: 'span', s: 'PR#7', cls: 'font-mono' });
});

test('"Closes #N" opens the request\'s page in Homeroom, for a native change and a GitHub one alike', () => {
  const AppView = makeAppView();
  for (const pr_url of [CHANGE_PAGE, GITHUB_PR]) {
    const specs = Array.from(AppView.closesPillSpecs(PR({ pr_url, status: 'merged', linked_issues: [12, 3] })));
    assert.deepEqual(specs.map((s) => s.href), ['#app/notes-1a2b3c/dev/issues/3', '#app/notes-1a2b3c/dev/issues/12'], pr_url);
    assert.equal(specs[0].title, 'Open request #3, which this change closed');
    assert.ok(!specs.some((s) => /GitHub/.test(s.title)));
  }
  const open = Array.from(AppView.closesPillSpecs(PR({ pr_url: CHANGE_PAGE, linked_issues: [12] })));
  assert.equal(open[0].title, 'Open request #12, which this change closes');
});

test('a link to a Homeroom page on a card opens in place: the closed request of a close vote', () => {
  const AppView = makeAppView();
  const html = closeIssueCardHtml(AppView, {
    id: 4, kind: 'close_issue', payload: { issueNumber: 12, required: 1 }, status: 'applied',
    up_count: 1, down_count: 0, applied_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z',
  });
  const link = html.match(/<a [^>]*>#12<\/a>/);
  assert.ok(link, html);
  assert.match(link[0], /href="#app\/notes-1a2b3c\/dev\/issues\/12"/);
  assert.doesNotMatch(link[0], /target=/);
});

test('the version pill: a change page opens in place, a commit on the git host in a new tab', () => {
  const AppView = makeAppView();
  const pill = (version) => AppView.renderAppVersionPillHTML({ slug: 'notes-1a2b3c', version, plain: true });
  const native = pill({ sha: 'abcdef1234', shortSha: 'abcdef1', prNumber: 7, prUrl: CHANGE_PAGE, commitUrl: GIT_HOST_COMMIT });
  assert.match(native, /<a href="#app\/notes-1a2b3c\/dev\/changes\/7" class=/);
  assert.doesNotMatch(native, /target=/);
  const commit = pill({ sha: 'abcdef1234', shortSha: 'abcdef1', commitUrl: GIT_HOST_COMMIT });
  assert.match(commit, new RegExp(`<a href="${GIT_HOST_COMMIT}" target="_blank" rel="noopener"`));
  const github = pill({ sha: 'abcdef1234', shortSha: 'abcdef1', prNumber: 5821, prUrl: GITHUB_PR });
  assert.match(github, new RegExp(`<a href="${GITHUB_PR}" target="_blank" rel="noopener"`));
});

test('the explore message names a native change by its page, and a GitHub PR as a PR link', () => {
  const AppView = makeAppView();
  assert.match(AppView._exploreSeed(PR({ pr_url: CHANGE_PAGE })), new RegExp(`\\nChange page: ${CHANGE_PAGE.replace(/[/.?#]/g, '\\$&')}\\n`));
  assert.match(AppView._exploreSeed(PR({ pr_url: '/#app/notes-1a2b3c/dev/changes/7' })),
    /\nChange page: https:\/\/onhomeroom\.com\/#app\/notes-1a2b3c\/dev\/changes\/7\n/);
  assert.match(AppView._exploreSeed(PR({ pr_url: GITHUB_PR })), new RegExp(`\\nPR link: ${GITHUB_PR.replace(/[/.]/g, '\\$&')}\\n`));
});

test('the board\'s "More open requests" footer is GitHub\'s only', () => {
  const kanban = SRC.slice(SRC.indexOf('const issuesFooter = '), SRC.indexOf('const issuesFooter = ') + 300);
  assert.match(kanban, /meta\.truncatedList && meta\.repoUrl && AppView\._linkKind\(meta\.repoUrl\) === 'github'/);
});

test('the earlier-comments line links to GitHub only for an issue there', () => {
  const GC = read('public/js/group-chat.js');
  assert.match(GC, /links\.linkKind\(extra\.htmlUrl\) === 'github'/);
  assert.match(GC, /githubMore = extra && extra\.truncated \? \{ url: moreUrl \} : null;/);
});

test('the Details sheet: "Open on GitHub" for GitHub, "View code" for the git host, nothing for its own page', () => {
  const render = (href) => renderComponent('frontend/src/features/dev-board/topic/topic-head.tsx', 'DetailsBody', {
    prRef: { s: 'PR#7', href }, steps: null, help: false, html: '',
  });
  const gh = render(GITHUB_PR);
  assert.match(gh, />Open on GitHub</);
  assert.match(gh, /target="_blank"/);
  const code = render(GIT_HOST_REPO);
  assert.match(code, />View code</);
  assert.doesNotMatch(code, /GitHub/);
  const own = render(CHANGE_PAGE);
  assert.match(own, /<span>PR#7<\/span>/);
  assert.doesNotMatch(own, /<a /);
});

test('the dev chat\'s changes card: a native change opens its page, a GitHub PR keeps "View on GitHub"', () => {
  const SRC_TX = read('frontend/src/features/dev-chat/transcript.tsx');
  assert.match(SRC_TX, /const prButton = prKind === 'github' \? t\('devchat:card\.changes\.viewOnGithub'\)\n\s+: prKind === 'code' \? t\('devchat:card\.changes\.viewCode'\)\n\s+: prKind === 'homeroom' \? t\('devchat:card\.changes\.openChange'\) : null;/);
  assert.equal(message('devchat:card.changes.openChange'), 'Open change');
  assert.doesNotMatch(message('devchat:card.changes.openChange'), /GitHub/);
});

test('the home menu: "View on GitHub" for a repository there, "View code" for the git host', () => {
  const { HOME_SRC } = require('./helpers/home-modules');
  const sandbox = {
    console, URL, PlatformI18n: englishPlatformI18n(), App: { user: { id: 1 } },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', origin: 'https://sv.test' },
    addEventListener: () => {}, removeEventListener: () => {},
    detectInstallHost: () => 'none',
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  require('./helpers/home-grid-store').installGridStore(sandbox);
  require('./helpers/app-card').installAppCard(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  const row = (repo_url) => Array.from(Home.menuItemsFor({ id: 1, slug: 'notes', name: 'Notes', status: 'running', repo_url }))
    .find((i) => i.key === 'github' || i.key === 'code') || null;
  const gh = row('https://github.com/Usernode-Labs/social-vibecoding');
  assert.equal(gh.key, 'github');
  assert.equal(gh.label, 'View on GitHub');
  const code = row(GIT_HOST_REPO);
  assert.equal(code.key, 'code');
  assert.equal(code.label, 'View code');
  assert.equal(row(null), null);
  assert.equal(row('javascript:alert(1)'), null, 'an address that is no web page is no row');
});

test('the About pane\'s Code row: GitHub\'s mark and "Public on GitHub" only for GitHub', () => {
  const PANE = read('frontend/src/features/app-context/about-pane.tsx');
  assert.match(PANE, /<Icon>\{repoKind === 'github' \? <GitHubIcon \/> : <CodeIcon \/>\}<\/Icon>/);
  assert.match(PANE, /\{repoKind === 'github' \? \(\n\s+<span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">\{t\('agent:appContext\.about\.codePublic'\)\}<\/span>\n\s+\) : null\}/);
  assert.match(PANE, /id="improve-row-github"/, 'the row keeps its id');
});

test('the version a list row reports links its change, not a GitHub pull request GitHub never had', () => {
  const { mergedPrUrl } = require('../src/services/app-version');
  const prev = { GIT_HOST_URL: process.env.GIT_HOST_URL, USERNODE_DOMAIN: process.env.USERNODE_DOMAIN };
  process.env.GIT_HOST_URL = 'https://git.onhomeroom.com';
  process.env.USERNODE_DOMAIN = 'onhomeroom.com';
  try {
    assert.equal(mergedPrUrl({ slug: 'notes-1a2b3c', repo_url: GIT_HOST_REPO }, 7), CHANGE_PAGE);
    assert.equal(mergedPrUrl({ slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' }, 5821), GITHUB_PR);
    assert.equal(mergedPrUrl({ slug: 'x', repo_url: GIT_HOST_REPO }, null), null);
    assert.equal(mergedPrUrl({ slug: 'x', repo_url: null }, 7), null);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.match(read('src/routes/apps.js'), /prUrl: require\('\.\.\/services\/app-version'\)\.mergedPrUrl\(a, a\.main_pr_number\),/);
});

test('no site derives a GitHub issue address from a pull request or a repository', () => {
  // The derivation of a GitHub issue URL from a PR URL, and the repo URL +
  // /issues/<n> guess, are gone: a request is Homeroom's own page.
  assert.doesNotMatch(SRC, /issueUrlFromPrUrl/);
  assert.doesNotMatch(SRC, /\$\{base\}\/issues\/\$\{issueN\}/);
});
