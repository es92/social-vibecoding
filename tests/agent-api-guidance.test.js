'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');

const root = path.resolve(__dirname, '..');
const canonicalSkills = path.join(root, '.agents', 'skills');
const claudeSkills = path.join(root, '.claude', 'skills');
const openCodePlugin = path.join(root, '.opencode', 'plugins', 'promotion-approval.js');
const skillNames = [
  'mobile-push-testing',
  'react-shell-migration',
  'usernode-api',
  'usernode-proposal',
];

function readSkill(name) {
  return fs.readFileSync(path.join(canonicalSkills, name, 'SKILL.md'), 'utf8');
}

test('Claude, Codex, and OpenCode discover one canonical set of shared skills', () => {
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, '@AGENTS.md\n');
  assert.equal(fs.readlinkSync(claudeSkills), '../.agents/skills');
  assert.equal(fs.realpathSync(claudeSkills), fs.realpathSync(canonicalSkills));
  assert.equal(fs.existsSync(path.join(root, '.opencode', 'skills')), false);
  assert.equal(
    fs.readlinkSync(openCodePlugin),
    '../../.agents/hooks/opencode-promotion-approval.js'
  );

  for (const name of skillNames) {
    const skill = readSkill(name);
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${name} has YAML frontmatter`);
    const keys = frontmatter[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')))
      .sort();
    assert.deepEqual(keys, ['description', 'name'], `${name} uses portable frontmatter`);
    assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, 'm'));

    const openai = fs.readFileSync(
      path.join(canonicalSkills, name, 'agents', 'openai.yaml'),
      'utf8'
    );
    assert.match(openai, new RegExp(`\\$${name}\\b`));
  }
});

test('AGENTS keeps always-on rules and routes conditional work to skills', () => {
  const guidance = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  for (const name of skillNames) assert.ok(guidance.includes(`\`${name}\``));
  assert.match(guidance, /\.agents\/skills/);
  assert.match(guidance, /\.claude\/skills/);
  assert.match(guidance, /OpenCode discovers `\.agents\/skills\/` directly/);
  assert.match(guidance, /public\/index\.html.*GENERATED/);
  // Renamed twice as the console converged on the shell. The reskin folded it
  // into the shell's palette, leaving a RENDERING boundary (components vs
  // class recipes); converting sections to React dissolved that half too, and
  // what remains is a SURFACE one — an operator console is denser than a phone
  // screen, so it keeps its own tuning of the shared vocabulary.
  assert.match(guidance, /One language, two surfaces/);
  // The heading changed with the state it describes: the sections were
  // "moving off innerHTML" while some were, and every one of them renders
  // from React now (#1120 slice 35), so the guidance is about adding a NEW
  // section rather than converting an old one.
  assert.match(guidance, /The console is React — add a section the same way/);
  // The two rules that are easy to lose to React's defaults, and that cost a
  // real bug each: a search box that drives a paged query must not fire per
  // keystroke, and a cross-screen jump needs an explicit export.
  assert.match(guidance, /commits on blur or Enter/);
  assert.match(guidance, /cross-screen jump needs an explicit export/);
  assert.doesNotMatch(guidance, /open `\/hooks`/);
  assert.doesNotMatch(guidance, /social-vibecoding codex setup/);
});

// #1246 — the base-commit check has to be ALWAYS-ON, not skill-scoped.
//
// The check itself is not new: step 2 of the usernode-proposal skill has
// always said to verify HEAD against the proposal base. But a skill body
// loads only when a task selects that skill, and a session dispatched onto a
// branch somebody else cut never selects it — it just starts editing whatever
// it was handed. That is how a change got written against a fork's `main`
// sitting ~190 merged pull requests behind the commit the request described.
//
// So this pins the rule in BOTH places. Deleting either one restores the gap:
// drop it from AGENTS.md and a dispatched session stops being told, drop it
// from the skill and the local-CLI lifecycle loses the step at the point it
// actually pins the commit.
test('the base-commit check is always-on, not only in the proposal skill', () => {
  const guidance = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /Know your base commit and create its work branch before you write code/);
  assert.match(guidance, /git rev-parse HEAD/);
  // The clauses that make it actionable rather than a warning: the fork's
  // default branch is the stale thing, the base has a source, proposal work
  // gets its own exact-base branch, and reconciling the default branch is
  // forbidden.
  assert.match(guidance, /fork's default branch/);
  assert.match(guidance, /prepare_work/);
  assert.match(guidance, /Never implement or commit proposal work directly on `main`/);
  assert.match(guidance, /git switch -c <proposal-branch> <40-character-base-sha>/);
  assert.match(guidance, /not to merge\s+or rebase the default branch/);

  const proposal = readSkill('usernode-proposal');
  assert.match(
    proposal,
    /Verify `git rev-parse HEAD` equals the proposal base SHA/,
    'the skill keeps its own check — AGENTS.md hoists it, it does not replace it'
  );
});

test('shared Homeroom skills retain API safety and scope the hook UI to Codex CLI', () => {
  const api = readSkill('usernode-api');
  assert.match(api, /social-vibecoding codex setup/);
  assert.match(api, /social-vibecoding claude setup/);
  assert.match(api, /social-vibecoding opencode setup/);
  assert.match(api, /Use `production` unless the user explicitly requests/);
  assert.match(api, /browser approval/i);
  assert.match(api, /still-valid legacy credential lacks the API grant/);
  assert.match(api, /social-vibecoding logout --profile/);
  assert.match(api, /host_execution_required/);
  assert.match(api, /untrusted data/);

  const proposal = readSkill('usernode-proposal');
  const cli = proposal.indexOf('**Codex CLI only:**');
  const hookInstruction = proposal.indexOf('open `/hooks`');
  const desktop = proposal.indexOf('**ChatGPT desktop:**');
  assert.ok(cli >= 0 && hookInstruction > cli && desktop > hookInstruction);
  assert.match(proposal, /desktop app has no `\/hooks` command/);
  assert.match(proposal, /must not trigger a `\/hooks` warning/);
  assert.match(proposal, /\*\*Claude Code:\*\*/);
  assert.match(proposal, /\*\*OpenCode:\*\*/);
  assert.match(proposal, /OpenCode has no Codex `\/hooks` trust procedure/);
  assert.match(proposal, /proposal_promote/);
  assert.match(proposal, /How to test \/ observe/);
  assert.match(proposal, /staging route or fixture/);
  assert.match(proposal, /Structured command results do not replace/);
});

test('proposal summaries remain scannable user-visible Markdown', () => {
  const proposal = readSkill('usernode-proposal');

  assert.match(proposal, /`kind: "summary"`.*user-visible Markdown transcript message/);
  assert.match(proposal, /one concrete finding, change, or test result per bullet/);
  assert.match(proposal, /each distinct issue and its corresponding fix/);
  assert.match(proposal, /omit empty sections instead of filling a template/);
  assert.match(proposal, /commit, managed-head, session, build, or similar identifiers/);
  assert.match(proposal, /Do not compress several defects, fixes, results, and identifiers into one dense paragraph/);
  assert.match(proposal, /`phase` field.*not a substitute for visible structure in `content`/);
});

test('proposal guidance preserves one work identity through check recovery', () => {
  const proposal = readSkill('usernode-proposal');
  assert.match(proposal, /request ID and returned session ID as the permanent identity/);
  assert.match(proposal, /recovering stalled checks never authorizes another `proposal_start`/);
  assert.match(proposal, /When stalled, call `proposal_recheck` for that session/);
  assert.match(proposal, /`supersedes_session_id` only after the user explicitly asks/);
});

test('machine-local agent setup artifacts are ignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.codex\/config\.toml$/m);
  assert.match(ignore, /^\.codex\/config\.toml\.lock\.\*$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock$/m);
  assert.match(ignore, /^\.claude\/social-vibecoding-mcp\.local\.json\.lock\.\*$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc\.lock$/m);
  assert.match(ignore, /^\.opencode\/opencode\.jsonc\.lock\.\*$/m);
});

test('authorization and token-management copy covers all configured coding agents', () => {
  const authorize = fs.readFileSync(path.join(root, 'public/cli-authorize.html'), 'utf8');
  const authorizeJs = fs.readFileSync(path.join(root, 'public/js/cli-authorize.js'), 'utf8');
  const settings = shellMarkup();
  for (const source of [authorize, authorizeJs, settings]) {
    assert.match(source, /Codex/);
    assert.match(source, /Claude Code/);
    assert.match(source, /OpenCode/);
  }
  assert.match(settings, /CLI &amp; coding-agent access/);
});
