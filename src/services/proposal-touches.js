'use strict';

// "What it touches" (#4490): the picture a Needs-you card shows when a change
// has no before & after shots and its author drew no diagram. It is made from
// the change's own files, by fixed path rules, so it costs no model call and
// cannot be wrong about what it says: which parts of the project the change
// touches, and how much.
//
// Stored per proposal head (chat_sessions.pr_touches, pr_touches_sha) and
// refreshed in the background when a list read finds the head has moved: one
// GitHub compare per head, never per view. No file list (GitHub unreachable,
// a mock) leaves the column empty and the card keeps today's spacer.

const log = require('./logger');

const AREAS = Object.freeze([
  { key: 'screens', label: 'Screens' },
  { key: 'server', label: 'Server' },
  { key: 'database', label: 'Database' },
  { key: 'tests', label: 'Tests' },
  { key: 'docs', label: 'Docs' },
  { key: 'other', label: 'Other' },
]);

/**
 * The area one path belongs to. First rule wins, in this order, because the
 * specific beats the general: a test under frontend/ is a test, and a schema
 * under src/ is the database.
 */
function areaOf(file) {
  const p = String(file || '').replace(/^\.?\//, '').toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z0-9]+$/.test(p)) return 'tests';
  if (/^src\/db\//.test(p) || /(^|\/)migrations?\//.test(p) || /\.sql$/.test(p) || /(^|\/)postgres\//.test(p)) return 'database';
  if (/^docs?\//.test(p) || /\.(md|mdx|txt)$/.test(p)) return 'docs';
  if (/^(frontend|public|styles|static|assets|client|web)\//.test(p) || /\.(css|scss|html|tsx|jsx|svg|png|jpe?g|webp|gif)$/.test(p)) return 'screens';
  if (/^(src|server|api|lib|routes|worker)\//.test(p) || /^server\.[cm]?[jt]s$/.test(p)) return 'server';
  return 'other';
}

/**
 * The picture's data from a file list. `files` is GitHub's compare shape,
 * `{ filename, additions, deletions }` (a bare path counts as one line).
 * Areas come in a fixed order, each with its file and line counts; areas
 * with nothing are kept, so the card can say "none" beside them.
 */
function summarize(files) {
  const by = new Map(AREAS.map((a) => [a.key, { key: a.key, label: a.label, files: 0, lines: 0 }]));
  let total = 0;
  for (const f of Array.isArray(files) ? files : []) {
    const name = typeof f === 'string' ? f : f && f.filename;
    if (!name) continue;
    const lines = typeof f === 'string' ? 1 : (Number(f.additions) || 0) + (Number(f.deletions) || 0);
    const slot = by.get(areaOf(name));
    slot.files += 1;
    slot.lines += lines;
    total += 1;
  }
  if (!total) return null;
  return { version: 1, files: total, areas: [...by.values()] };
}

/** A stored value as the client may draw it, or null. */
function storedTouches(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.areas)) return null;
  const keys = new Set(AREAS.map((a) => a.key));
  const areas = value.areas
    .filter((a) => a && keys.has(a.key))
    .map((a) => ({
      key: a.key,
      label: AREAS.find((x) => x.key === a.key).label,
      files: Math.max(0, Math.floor(Number(a.files) || 0)),
      lines: Math.max(0, Math.floor(Number(a.lines) || 0)),
    }));
  const files = areas.reduce((n, a) => n + a.files, 0);
  return files ? { version: 1, files, areas } : null;
}

// Heads being read right now, so two list reads in a row start one compare.
const inFlight = new Set();
const MAX_PER_READ = 4;

function repoOf(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Read one head's file list and store its picture. Resolves true when it
 * stored one. Never throws: a failed read leaves the column as it was.
 */
async function refreshOne(pool, { sessionId, repoUrl, headSha, baseRef = 'main' }, deps = {}) {
  const github = deps.github || require('./github');
  const repo = repoOf(repoUrl);
  if (!repo || !/^[0-9a-f]{40}$/i.test(String(headSha || '')) || typeof github.compareFiles !== 'function') return false;
  const key = `${sessionId}:${headSha}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const { files } = await github.compareFiles(repo.owner, repo.repo, `${baseRef}...${headSha}`, 0);
    const touches = summarize(files);
    if (!touches) return false;
    await pool.query(
      `UPDATE chat_sessions SET pr_touches = $2::jsonb, pr_touches_sha = $3
        WHERE id = $1 AND pr_touches_sha IS DISTINCT FROM $3`,
      [Number(sessionId), JSON.stringify(touches), headSha]
    );
    return true;
  } catch (err) {
    log.warn('proposal-touches', 'Could not read the files a change touches', { sessionId, err: err.message });
    return false;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * For list reads: start a background refresh for the rows whose stored
 * picture is for an older head (or missing), at most a few per read. Each
 * row needs `id`, `repo_url`, `pr_touches_sha` and its head (`head`). Does
 * not wait; the next read shows what it stored.
 */
function scheduleRefresh(pool, rows, deps = {}) {
  if (!pool) return 0;
  let started = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (started >= MAX_PER_READ) break;
    const headSha = row && row.head;
    if (!headSha || row.pr_touches_sha === headSha || !row.repo_url) continue;
    started += 1;
    refreshOne(pool, { sessionId: row.id, repoUrl: row.repo_url, headSha }, deps).catch(() => {});
  }
  return started;
}

module.exports = {
  AREAS,
  areaOf,
  summarize,
  storedTouches,
  refreshOne,
  scheduleRefresh,
  _inFlight: inFlight,
};
