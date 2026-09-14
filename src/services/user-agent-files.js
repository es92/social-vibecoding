'use strict';

// #460: per-user global agent instruction & skill files.
//
// Users upload markdown/text files in the account Settings modal; the
// platform stores them in the `user_agent_files` table and materializes
// them into the dispatching user's per-session CC volume on every
// build/scout turn (worker.syncUserAgentFiles):
//
//   - instruction files → concatenated into ~/.claude/CLAUDE.md, which
//     Claude Code loads natively as user-level memory;
//   - skill files       → ~/.claude/skills/<slug>/SKILL.md, which Claude
//     Code discovers natively as personal skills.
//
// Both paths live OUTSIDE /home/node/workspace, so run-cc.sh's
// `git add -A` can never commit them, and the CC volume is per-session
// (sessions belong to one owner), so files never leak across users.
//
// This module owns the pure, unit-testable pieces (validation, frontmatter
// synthesis, CLAUDE.md assembly, the sync shell script) plus thin DB
// accessors. Route handlers live in src/routes/user-agent-files.js.

const KINDS = ['instruction', 'skill'];
const MAX_FILES_PER_KIND = 10;
const MAX_FILE_BYTES = 48 * 1024; // 48 KB
const MAX_DESCRIPTION_LEN = 200;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Managed container paths. Wiped and rewritten wholesale on every
// build/scout dispatch so deletions in Settings take effect on the next
// run and stale state can't accumulate.
const USER_CLAUDE_MD_PATH = '/home/node/.claude/CLAUDE.md';
const USER_SKILLS_DIR = '/home/node/.claude/skills';

// Normalize an arbitrary uploaded filename / typed name into a slug the
// NAME_RE accepts, or null when nothing usable survives. Strips a
// trailing .md/.txt extension, lowercases, maps whitespace/underscores/
// dots to dashes, drops everything else, collapses dash runs, trims
// leading/trailing dashes, caps at 64 chars.
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/\.(md|txt)$/i, '');
  s = s.toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // A slice can't end on a leading char violation, but it can leave a
  // trailing dash — retrim so the regex verdict below is authoritative.
  s = s.replace(/-+$/g, '');
  return NAME_RE.test(s) ? s : null;
}

// Content gate: must be a non-empty string, valid text (no NUL bytes —
// the cheap reliable "is this a binary?" signal once it's already been
// decoded from the JSON body), and within the size cap measured in
// UTF-8 bytes. Returns { ok: true, sizeBytes } or { ok: false, error }.
function validateContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'File content is required' };
  }
  if (content.includes('\u0000')) {
    return { ok: false, error: 'File must be plain text (markdown or .txt); binary content is not allowed' };
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, error: `File is too large (${Math.ceil(sizeBytes / 1024)} KB). The limit is ${MAX_FILE_BYTES / 1024} KB` };
  }
  return { ok: true, sizeBytes };
}

// First non-empty line of a file, stripped of markdown heading/list
// prefixes — the description fallback for skills uploaded without one.
function firstLineSummary(content, maxLen = 120) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0) || '';
  return line.slice(0, maxLen);
}

// Skills must reach the CLI as a well-formed SKILL.md: YAML frontmatter
// carrying `name` and `description`. When the uploaded content already
// starts with a `---` frontmatter block we trust it as-is; otherwise we
// prepend generated frontmatter (name = slug, description = the
// user-submitted description, falling back to the first content line).
function ensureSkillFrontmatter(content, slug, description) {
  const text = String(content || '');
  if (/^---\s*\n[\s\S]*?\n---\s*(\n|$)/.test(text)) return text;
  const desc = (description || firstLineSummary(text) || slug)
    .replace(/\n/g, ' ')
    .slice(0, MAX_DESCRIPTION_LEN);
  // Single-quote YAML scalar; escape embedded single quotes by doubling.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `---\nname: ${q(slug)}\ndescription: ${q(desc)}\n---\n\n${text}`;
}

// Extract a display description for a skill row: the user-supplied one
// wins; otherwise pull `description:` out of the file's frontmatter;
// otherwise first content line.
function skillDescription(content, submitted) {
  const s = typeof submitted === 'string' ? submitted.trim() : '';
  if (s) return s.slice(0, MAX_DESCRIPTION_LEN);
  const m = String(content || '').match(/^---\s*\n[\s\S]*?^description:\s*(.+?)\s*$[\s\S]*?\n---/m);
  if (m) return m[1].replace(/^['"]|['"]$/g, '').slice(0, MAX_DESCRIPTION_LEN);
  return firstLineSummary(content).slice(0, MAX_DESCRIPTION_LEN);
}

// Assemble the platform-generated ~/.claude/CLAUDE.md from the user's
// instruction files. Claude Code loads this natively as user-level
// memory. The header makes provenance obvious to both the agent and any
// human poking around the volume. Returns '' when there are no
// instruction files (callers then skip writing the file entirely).
function buildUserClaudeMd(files) {
  const instructions = (files || []).filter((f) => f.kind === 'instruction');
  if (!instructions.length) return '';
  const parts = [
    '<!-- Managed by Homeroom — assembled from the user\'s "Agent',
    'instructions & skills" in their platform Settings. Do not edit here;',
    'changes are overwritten on every dispatch. -->',
    '',
    '# Personal instructions (from the dispatching user)',
    '',
    'These are the personal preferences of the user who dispatched this',
    'run. Follow them wherever they don\'t conflict with the platform',
    'conventions (which always win) or the repo\'s own CLAUDE.md on',
    'app-specific matters.',
    '',
  ];
  for (const f of instructions) {
    parts.push(`## ${f.name}`, '', String(f.content || '').trim(), '');
  }
  return parts.join('\n');
}

// Build the shell script that wipes + rewrites the managed paths inside
// the worker container. Executed via `docker exec -i <container> sh`
// with this script as stdin, so file contents never appear in CLI args
// (/proc cmdline, docker inspect). Contents travel base64-encoded inside
// single quotes — immune to quoting/heredoc-delimiter collisions with
// user text.
function buildSyncShellScript(files) {
  const lines = [
    'set -e',
    `rm -f ${USER_CLAUDE_MD_PATH}`,
    `rm -rf ${USER_SKILLS_DIR}`,
  ];
  const claudeMd = buildUserClaudeMd(files);
  if (claudeMd) {
    lines.push(`mkdir -p /home/node/.claude`);
    lines.push(`printf '%s' '${Buffer.from(claudeMd, 'utf8').toString('base64')}' | base64 -d > ${USER_CLAUDE_MD_PATH}`);
  }
  for (const f of (files || []).filter((x) => x.kind === 'skill')) {
    // Slugs are validated against NAME_RE before they ever reach the DB,
    // so interpolating them into the path is safe; assert anyway.
    if (!NAME_RE.test(f.name)) continue;
    const skillMd = ensureSkillFrontmatter(f.content, f.name, f.description);
    lines.push(`mkdir -p ${USER_SKILLS_DIR}/${f.name}`);
    lines.push(`printf '%s' '${Buffer.from(skillMd, 'utf8').toString('base64')}' | base64 -d > ${USER_SKILLS_DIR}/${f.name}/SKILL.md`);
  }
  return lines.join('\n') + '\n';
}

// Compact metadata block for the Mayor's system prompt — names +
// descriptions only, never contents (those belong to Claude Code, which
// reads them from disk in the worker). Returns '' when the user has no
// files so the prompt stays byte-identical for everyone else.
function buildMayorAgentFilesBlock(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const line = (f) => `- [${f.kind}] ${f.name}${f.description ? ` — ${f.description}` : ''}`;
  return `

==== USER'S PERSONAL AGENT FILES ====

The user has personal agent instruction/skill files configured in their
platform Settings. They apply automatically to every build and spec run
this user dispatches (the coding agent reads them from disk); you never
see their full contents — only this list. If asked, you can name them
and remind the user they're managed in Settings → "Agent instructions &
skills". Platform conventions still override them on any platform-wide
rule.

${list.map(line).join('\n')}

==== END USER'S PERSONAL AGENT FILES ====`;
}

// ── DB accessors ───────────────────────────────────────────────────────

async function listForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT kind, name, description, size_bytes, updated_at
       FROM user_agent_files
      WHERE user_id = $1
      ORDER BY kind, name`,
    [userId]
  );
  return rows;
}

async function loadAllForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT kind, name, description, content
       FROM user_agent_files
      WHERE user_id = $1
      ORDER BY kind, name`,
    [userId]
  );
  return rows;
}

async function getFile(pool, userId, kind, name) {
  const { rows } = await pool.query(
    `SELECT kind, name, description, content, size_bytes, updated_at
       FROM user_agent_files
      WHERE user_id = $1 AND kind = $2 AND name = $3`,
    [userId, kind, name]
  );
  return rows[0] || null;
}

// Upsert keyed on (user_id, kind, name). The per-kind cap is enforced
// here (not in the route) so it can't be bypassed; an update over an
// existing name never counts as a new slot.
async function upsertFile(pool, userId, { kind, name, description, content, sizeBytes }) {
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM user_agent_files WHERE user_id = $1 AND kind = $2 AND name = $3`,
    [userId, kind, name]
  );
  if (!existing.length) {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_agent_files WHERE user_id = $1 AND kind = $2`,
      [userId, kind]
    );
    if (countRows[0].n >= MAX_FILES_PER_KIND) {
      const err = new Error(`You already have ${MAX_FILES_PER_KIND} ${kind} files. Remove one first`);
      err.code = 'kind_cap';
      throw err;
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO user_agent_files (user_id, kind, name, description, content, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, kind, name)
     DO UPDATE SET description = EXCLUDED.description,
                   content = EXCLUDED.content,
                   size_bytes = EXCLUDED.size_bytes,
                   updated_at = NOW()
     RETURNING kind, name, description, size_bytes, updated_at`,
    [userId, kind, name, description || '', content, sizeBytes]
  );
  return rows[0];
}

async function deleteFile(pool, userId, kind, name) {
  const { rowCount } = await pool.query(
    `DELETE FROM user_agent_files WHERE user_id = $1 AND kind = $2 AND name = $3`,
    [userId, kind, name]
  );
  return rowCount > 0;
}

// ── Staging demo rows (?demo=1) ────────────────────────────────────────
// Fabricated list for staging previews — the table is staging:private so
// it's always empty there. Same pattern as llm-grants' demoGrants().
function demoFiles() {
  return [
    {
      kind: 'instruction',
      name: 'code-style',
      description: '',
      content: '# code-style\n\n- Prefer small, well-named functions over comments.\n- All currency values are integer cents, never floats.\n',
      size_bytes: 110,
      updated_at: new Date('2026-01-15T12:00:00Z').toISOString(),
      demo: true,
    },
    {
      kind: 'instruction',
      name: 'ui-preferences',
      description: '',
      content: '# ui-preferences\n\n- Dark mode first; test every screen in dark mode.\n- Buttons use rounded-lg, never rounded-full.\n',
      size_bytes: 108,
      updated_at: new Date('2026-02-02T09:30:00Z').toISOString(),
      demo: true,
    },
    {
      kind: 'skill',
      name: 'changelog-writer',
      description: 'Writes a user-facing changelog entry for every merged change',
      content: '---\nname: changelog-writer\ndescription: Writes a user-facing changelog entry for every merged change\n---\n\nWhen asked for a changelog entry, summarize the change in one friendly sentence.\n',
      size_bytes: 180,
      updated_at: new Date('2026-03-10T17:45:00Z').toISOString(),
      demo: true,
    },
  ];
}

module.exports = {
  KINDS,
  MAX_FILES_PER_KIND,
  MAX_FILE_BYTES,
  MAX_DESCRIPTION_LEN,
  NAME_RE,
  USER_CLAUDE_MD_PATH,
  USER_SKILLS_DIR,
  normalizeName,
  validateContent,
  firstLineSummary,
  ensureSkillFrontmatter,
  skillDescription,
  buildUserClaudeMd,
  buildSyncShellScript,
  buildMayorAgentFilesBlock,
  listForUser,
  loadAllForUser,
  getFile,
  upsertFile,
  deleteFile,
  demoFiles,
};
