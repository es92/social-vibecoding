'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');

let cached = null;

function getAppConventions() {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(CONVENTIONS_PATH, 'utf-8');
  } catch (err) {
    log.error('prompts', 'Failed to read app-conventions.md', { err: err.message });
    cached = '';
  }
  return cached;
}

// The offline excerpt carried inside a connector work order.
//
// Every app's notes tell a coding agent to fetch these conventions from the
// Usernode site at the start of a session. A hosted agent's container blocks
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

You are editing the Usernode platform itself. Refuse to propose edits to
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

module.exports = {
  getAppConventions,
  getWorkOrderEssentials,
  getConventionSections,
  getConventionSection,
  getConventionSlugs,
  getSelfHostedRefuseList,
  WORK_ORDER_BEGIN,
  WORK_ORDER_END,
};
