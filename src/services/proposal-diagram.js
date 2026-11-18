'use strict';

// Where a change's diagram (#4490, services/diagram.js) is stored and how it
// reaches the pull request. Two writers, one column:
//
//   - submit_work's `diagram` (services/mcp-tools.js): the author's own
//     description already carries the text block, so only the row is written.
//   - a hosted build's `declare_diagram` (worker/visible-changes-mcp.js →
//     POST /api/internal/sessions/:id/diagram): the row, and with it the
//     proposal machine's `pr.diagram`, which writes the pull request body's
//     block when the change has one (storeDeclared; pr-metadata.js also
//     writes it on every regeneration, beside the shots block).
//
// An update replaces the stored diagram; one is kept until its author sends
// another, as declared visible changes are.

const log = require('./logger');
const diagram = require('./diagram');
const repoRef = require('./repo-ref');

const SOURCES = Object.freeze(['author']);

/** Store a validated record. Resolves true when a row took it. */
async function store(pool, sessionId, record, source = 'author') {
  const id = Number(sessionId);
  if (!pool || !Number.isInteger(id) || id <= 0) return false;
  const value = diagram.storedDiagram(record);
  if (!value || !SOURCES.includes(source)) return false;
  try {
    const { rowCount } = await pool.query(
      'UPDATE chat_sessions SET pr_diagram = $2::jsonb, pr_diagram_source = $3 WHERE id = $1',
      [id, JSON.stringify(value), source]
    );
    return rowCount > 0;
  } catch (err) {
    log.warn('proposal-diagram', 'Could not store the diagram', { sessionId: id, err: err.message });
    return false;
  }
}

/**
 * Whether the change already has a stored diagram (its author's, or kept from
 * an earlier update). Resolves false on a bad id, and true when the lookup
 * fails: a reminder that could not check is never sent (#6815).
 */
async function hasStored(pool, sessionId) {
  const id = Number(sessionId);
  if (!pool || !Number.isInteger(id) || id <= 0) return false;
  try {
    const { rows } = await pool.query(
      'SELECT pr_diagram IS NOT NULL AS has FROM chat_sessions WHERE id = $1',
      [id]
    );
    return rows[0]?.has === true;
  } catch (err) {
    log.warn('proposal-diagram', 'Could not read the stored diagram', { sessionId: id, err: err.message });
    return true;
  }
}

/**
 * A hosted build's declared diagram: the row, and in the same transaction the
 * proposal machine's DiagramStored, which owes the pull request's body its
 * block (`pr.diagram`, syncPrBlock). Written after the commit instead, a
 * restart in between lost the block for good. Resolves true when a row took
 * it; throws when it could not be stored.
 */
async function storeDeclared(pool, sessionId, record) {
  const id = Number(sessionId);
  const value = diagram.storedDiagram(record);
  if (!pool || !Number.isInteger(id) || id <= 0 || !value) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE chat_sessions SET pr_diagram = $2::jsonb, pr_diagram_source = 'author' WHERE id = $1 RETURNING app_id`,
      [id, JSON.stringify(value)]
    );
    if (rows[0]) await require('../workflow/platform.ts').diagramStored(client, { sessionId: id, appId: rows[0].app_id });
    await client.query('COMMIT');
    return rows.length > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Write the diagram's block into the change's pull request body, when it has
 * one Homeroom wrote (an imported pull request's body is its author's): the
 * proposal machine's `pr.diagram`. Resolves { updated, reason }; throws when
 * GitHub refused, so the work tries again.
 */
async function syncPrBlock(pool, sessionId, deps = {}) {
  const id = Number(sessionId);
  if (!pool || !Number.isInteger(id) || id <= 0) return { updated: false, reason: 'invalid_session' };
  const { rows } = await pool.query(
    `SELECT cs.id, cs.source, cs.pr_number, cs.pr_body, cs.pr_diagram, cs.pr_diagram_source, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [id]
  );
  const session = rows[0];
  if (!session || !session.pr_number) return { updated: false, reason: 'missing_pr' };
  if (session.source === 'imported') return { updated: false, reason: 'imported_pr' };
  const block = diagram.prBlock(session.pr_diagram, session.pr_diagram_source || 'author');
  const next = diagram.upsertPrBlock(session.pr_body || '', block);
  if (next === (session.pr_body || '')) return { updated: false, reason: 'unchanged' };
  const repo = repoRef.ownerRepo(session.repo_url);
  if (!repo) return { updated: false, reason: 'invalid_repo' };
  const github = deps.github || require('./github');
  try {
    await github.updatePR(repo.owner, repo.repo, session.pr_number, { body: next });
  } catch (err) {
    // GitHub refusing this write (the pull request gone, a body it will not
    // take) is final: trying again would hold the proposal's other GitHub
    // moves (an open, a close) behind it. A limit or an outage is tried again.
    const status = Number(err && err.status);
    if (status >= 400 && status < 500 && status !== 403 && status !== 429) {
      return { updated: false, reason: 'github_refused', status };
    }
    throw err;
  }
  await pool.query('UPDATE chat_sessions SET pr_body = $2 WHERE id = $1', [id, next]);
  return { updated: true };
}

module.exports = { store, storeDeclared, syncPrBlock, hasStored, SOURCES };
