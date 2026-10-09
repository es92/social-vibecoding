'use strict';

// Where a change's diagram (#4490, services/diagram.js) is stored and how it
// reaches the pull request. Two writers, one column:
//
//   - submit_work's `diagram` (services/mcp-tools.js): the author's own
//     description already carries the text block, so only the row is written.
//   - a hosted build's `declare_diagram` (worker/visible-changes-mcp.js →
//     POST /api/internal/sessions/:id/diagram): the row, then the pull
//     request body's block when the change has one (pr-metadata.js also
//     writes it on every regeneration, beside the shots block).
//
// An update replaces the stored diagram; one is kept until its author sends
// another, as declared visible changes are.

const log = require('./logger');
const diagram = require('./diagram');

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
 * Write the diagram's block into the change's pull request body, when it has
 * one Homeroom wrote (an imported pull request's body is its author's).
 * Best-effort: resolves { updated, reason }.
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
  const match = String(session.repo_url || '').match(/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) return { updated: false, reason: 'invalid_repo' };
  const github = deps.github || require('./github');
  await github.updatePR(match[1], match[2], session.pr_number, { body: next });
  await pool.query('UPDATE chat_sessions SET pr_body = $2 WHERE id = $1', [id, next]);
  return { updated: true };
}

module.exports = { store, syncPrBlock, SOURCES };
