'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { platformOrigin } = require('./app-identity-env');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');

// The doc names the platform's own origin in a handful of places — the three
// centrally hosted assets, the conventions URL. It is injected verbatim into
// every build agent's system prompt and published at /claude.md, so a literal
// hostname in the file is a literal hostname in every agent's prompt: that is
// how the last platform domain move left this document telling agents to
// load three files from a host that no longer answers, and inviting them to
// write that host into the apps they were building. The file carries a token
// instead, resolved here from the same USERNODE_DOMAIN every other caller
// reads. Unset (local dev, tests) it resolves to the empty string, leaving
// the relative path — which Kubernetes deployments serve from the app's own
// origin, and which is in any case the better failure than a dead host.
const PLATFORM_ORIGIN_TOKEN = '{{PLATFORM_ORIGIN}}';

let cached = null;

function getAppConventions() {
  if (cached !== null) return cached;
  try {
    const raw = fs.readFileSync(CONVENTIONS_PATH, 'utf-8');
    cached = raw.split(PLATFORM_ORIGIN_TOKEN).join(platformOrigin() || '');
  } catch (err) {
    log.error('prompts', 'Failed to read app-conventions.md', { err: err.message });
    cached = '';
  }
  return cached;
}

// The offline excerpt carried inside a connector work order.
//
// Every app's notes tell a coding agent to fetch these conventions from the
// Homeroom site at the start of a session. A hosted agent's container blocks
// that host, so it never reads them — and then reasons its way to the very
// things the document forbids (vendoring the hosted assets, "fixing" the
// styling, shipping a screen with no test). The work order therefore carries
// a compact excerpt with it.
//
// The excerpt is a REGION OF THE SAME FILE, delimited by the markers below,
// rather than a second document: a copy would drift, and a drifted copy of
// platform rules is worse than none. Cached alongside getAppConventions().
const WORK_ORDER_BEGIN = '<!-- work-order:begin -->';
const WORK_ORDER_END = '<!-- work-order:end -->';

let cachedEssentials = null;

function getWorkOrderEssentials() {
  if (cachedEssentials !== null) return cachedEssentials;
  const doc = getAppConventions();
  const start = doc.indexOf(WORK_ORDER_BEGIN);
  const end = doc.indexOf(WORK_ORDER_END);
  if (start < 0 || end < 0 || end < start) {
    // Never fatal: the work order loses background guidance, not the base
    // commit or the push commands.
    log.warn('prompts', 'work-order markers missing from app-conventions.md');
    cachedEssentials = '';
    return cachedEssentials;
  }
  cachedEssentials = doc.slice(start + WORK_ORDER_BEGIN.length, end).trim();
  return cachedEssentials;
}

// ── Section index — the connector's conventions lookup ──────────────────
//
// The offline excerpt above is ~4 KB of the document's 116 KB. It is what a
// work order can afford to carry, and it is deliberately the nine rules an
// agent working blind gets WORST. It is not the native UI kit's component
// list, the LLM proxy's request shape, or the `secrets` declaration format —
// and an agent that needs one of those still has nowhere to read it, because
// its own container cannot reach this host.
//
// MCP connector traffic can: it egresses through the chat product's
// infrastructure rather than the sandbox's. So the same document is also
// served section by section over the connector (get_platform_conventions in
// services/mcp-tools.js). These helpers do the slicing.
//
// The parse is one line of intent: the document's own `## ` headings ARE the
// index, so there is no second table of contents to keep in step. Slugs are
// kebab-cased heading text, computed once with the split and cached beside
// the two caches above, so a tool call is a map lookup rather than a
// re-parse of 116 KB.
let cachedSections = null;

// Heading text → slug. Backticks, emphasis markers and apostrophes are
// dropped rather than turned into separators, so "Don't `git push` yourself"
// is `dont-git-push-yourself` and not `don-t-git-push-yourself`; every other
// run of non-alphanumerics collapses to a single dash.
function slugifyHeading(title) {
  return String(title)
    .replace(/[`*’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseSections() {
  if (cachedSections !== null) return cachedSections;
  const doc = getAppConventions();
  const sections = [];
  if (!doc) {
    // Same posture as the excerpt: an unreadable document costs the lookup
    // tool its answer, never a whole turn.
    cachedSections = sections;
    return cachedSections;
  }
  const heads = [];
  const re = /^## (.+)$/gm;
  for (let m; (m = re.exec(doc)) !== null; ) {
    heads.push({ title: m[1].trim(), start: m.index });
  }
  const used = new Set();
  heads.forEach((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].start : doc.length;
    // The heading line travels WITH its body: a section handed to an agent
    // on its own should still say what it is.
    const content = doc.slice(head.start, end).trim();
    let slug = slugifyHeading(head.title) || `section-${i + 1}`;
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    sections.push({
      slug,
      title: head.title,
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    });
  });
  cachedSections = sections;
  return cachedSections;
}

// The index: one entry per H2 section, without the bodies. `bytes` lets the
// caller (and the model) see what a section costs before asking for it.
function getConventionSections() {
  return parseSections().map(({ slug, title, bytes }) => ({ slug, title, bytes }));
}

// One section by slug, or null when the slug is unknown. Returns
// { slug, title, bytes, content } — `content` includes the heading line.
function getConventionSection(slug) {
  const want = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (!want) return null;
  return parseSections().find((s) => s.slug === want) || null;
}

// Exported for the tests, which pin the slug list so a heading edit that
// silently breaks a slug an agent has already learned shows up as a failure.
function getConventionSlugs() {
  return parseSections().map((s) => s.slug);
}

// SELF-HOSTING.md sub-step 2i: appended to the Mayor system prompt
// only when the chat session's app is self_hosted=TRUE. The list
// is the source of truth (originally derived from the design-phase
// "sensitive globs" plus two added by the security assessment:
// `docker-compose.yml` for the sidecar-volume hazard and
// `.github/workflows/deploy.yml` for the JWT_SECRET rotation hazard).
//
// "Refuse without explicit allow_risky" means: surface the risk first,
// require user confirmation in the same message, and don't silently
// include such edits in a broader change. The list is exhaustive on
// purpose — Mayor errs on the side of asking.
const SELF_HOSTED_REFUSE_LIST = `

==== PLATFORM SELF-EDIT GUARDRAILS (self-hosted only) ====

You are editing the Homeroom platform itself. Refuse to propose edits to
any of the following without an explicit \`allow_risky: true\`
confirmation from the user in the same message:

- The bootstrap path in \`server.js\` (anything that runs before the
  Express app starts listening).
- \`src/middleware/auth.js\` and any code that reads or writes
  \`JWT_SECRET\` or anything in \`src/services/secrets.js\`.
- \`src/db/migrate.js\` for anything beyond append-only DDL
  (\`CREATE TABLE IF NOT EXISTS\`, \`ADD COLUMN IF NOT EXISTS\`,
  forward-only data backfills). Drops, renames, type changes, and
  not-null tightenings are all risky.
- Files configuring or mounting \`/var/run/docker.sock\` (any
  service that talks to the host's Docker daemon).
- \`docker-compose.yml\` — sidecar volumes, container privileges,
  network exposure.
- \`.github/workflows/deploy.yml\` — anything that rotates secrets,
  changes the deploy target, or alters the rollback path.

If the user asks you to touch any of these, surface the risk first and
require explicit confirmation. Do not silently include such edits in a
broader change.

==== END PLATFORM SELF-EDIT GUARDRAILS ====`;

function getSelfHostedRefuseList() {
  return SELF_HOSTED_REFUSE_LIST;
}

// ── What the launchpad hands to the agent (#1049 successor) ───────────
//
// The browser used to mint the work order: the user typed a brief into the
// walkthrough, Homeroom minted a task and rendered a ~300-line order, and two
// more steps walked them through copying it and coming back to press Submit.
// That is backwards — people expect to talk to Claude Code or Codex, not to
// fill in a form on Homeroom first — and it is also the reason the launchpad
// had any state to get stuck on.
//
// So this is all it hands over now. The agent asks what to build, then calls
// prepare_work ITSELF, which is what returns the task id, the branch and the
// base commit. Two things fall out of that and are worth keeping in mind
// before shortening this further:
//
//   The connector is REQUIRED, not advisory. Without it there is no
//   prepare_work, so no base commit and no task id, and the last paragraph is
//   the only thing standing between that agent and a branch cut from the
//   wrong place. The walkthrough refuses to render this step at all until the
//   account has one.
//
//   The base commit is fresher this way. A work order minted in the browser
//   pinned whatever main was when the user pressed a button; pasted three
//   days later it branched from stale code. prepare_work called at the moment
//   work actually starts cannot.
//
// Step 0 (#2092) comes before the question. A session is routinely dispatched
// into a checkout it did not make — a fork whose main is far behind the app's
// repository, on a branch cut from wherever that fork was — and nothing in the
// checkout says so, because `git fetch origin` compares a fork with itself. An
// agent that asks what to build and then reads THAT code plans the change
// against a version that no longer exists. So before it reads or asks anything
// it verifies the checkout through get_checkout_status and moves to the commit
// the canonical main is at. That moves the working copy only: the commit a
// proposal starts from is still the one prepare_work returns, never a merge of
// the agent's own making, because which commit a change is diffed against
// decides what the group votes on.
function getLaunchpadInstructions({ appName, slug, targetProposalId } = {}) {
  const name = appName || slug || 'this app';
  const continuing = Number.isInteger(Number(targetProposalId)) && Number(targetProposalId) > 0;
  return [
    `You are making a change to "${name}" on Homeroom (app \`${slug}\`).`,
    '',
    '0. Catch your checkout up to the app\'s upstream main before you read its code',
    '   or ask anything. The checkout you were handed may be a fork whose main is',
    '   far behind, and `git fetch origin` cannot tell you. Through your Usernode',
    `   connector, call get_checkout_status with slug "${slug}", \`headSha\` (from`,
    '   `git rev-parse HEAD`) and `remoteUrl` (from `git remote get-url origin`).',
    '   Unless it says `current` or `ahead`, fetch the `baseToUse` commit it returns',
    '   from the `canonicalRepo` it names and check that commit out. That moves your',
    '   working copy only: the commit a proposal starts from still comes from',
    '   prepare_work, never from merging main yourself.',
    '',
    'NEXT, IF THE USER HAS NOT ALREADY TOLD YOU WHAT TO BUILD, ASK THEM.',
    'Do not guess, and do not start until they answer.',
    '',
    'Then, through your Homeroom connector:',
    continuing
      ? `1. Call prepare_work with slug "${slug}" and proposalId ${Number(targetProposalId)}, `
        + 'and their answer as `brief`. Naming the proposal is what makes this an '
        + 'UPDATE to work that already exists rather than a second copy of it.'
      : `1. Call prepare_work with slug "${slug}" and their answer as \`brief\`.`,
    '   It returns the branch to push, the exact commit to start from, and the',
    '   platform rules this app is held to. Read those rules rather than guessing.',
    '2. Build it, starting from that commit.',
    '3. Push the branch to your own fork of the app.',
    '4. Call submit_work with the taskId prepare_work gave you and the branch you',
    '   pushed. That opens the pull request and puts the change to the group vote.',
    '   Then give the user the link it returns.',
    '',
    'If you have no Homeroom tools at all, the connector was never added to the',
    'account you are running in. Say so rather than improvising a base commit:',
    'the user adds it at https://my.onhomeroom.com/#settings/connectors, and',
    'without it nothing you push can be submitted as a proposal.',
  ].join('\n');
}

module.exports = {
  getAppConventions,
  getLaunchpadInstructions,
  getWorkOrderEssentials,
  getConventionSections,
  getConventionSection,
  getConventionSlugs,
  getSelfHostedRefuseList,
  WORK_ORDER_BEGIN,
  WORK_ORDER_END,
};
