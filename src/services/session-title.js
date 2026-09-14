'use strict';

// #249: meaningful default session names — the display-name layer over
// machine-generated branch names. Sessions are titled:
//   1. From their first interactive message (maybeTitleFirstMessage).
//   2. At pre-PR turn ends, from the full request history + latest
//      spec draft (refreshFromHistory) so the name sharpens as the
//      session's focus develops.
//   3. Once a PR exists, applyPrMetadata (pr-metadata.js) mirrors
//      pr_title into session_title and owns the name from then on —
//      every UPDATE here is guarded on `pr_number IS NULL` so a slow
//      in-flight early-title call can never clobber a PR-mirrored one.
//   4. Headless auto sessions get the deterministic, LLM-free
//      "#N · issue title" at creation (headlessTitle), inherited by
//      clones.
//   5. OpenRouter sessions (#1949) buy no helper-model call at all —
//      their turn is a single-provider path, and pr-metadata.js names
//      their PR deterministically for the same reason — so
//      titleFromFirstMessage trims the opening ask itself, with the same
//      trim the PR title gets: the name a session shows before its PR is
//      the name it keeps after.
//
// Every entry point is fire-and-forget: the returned promise ALWAYS
// resolves (with the new title, or null on failure/skip) and never
// rejects, so callers can ignore it without risking an unhandled
// rejection — title generation must never fail or block a turn.

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');

// Deterministic headless display name: "#N · <issue title>", truncated
// to fit the VARCHAR(256) column. Returns null when the issue fetch
// degraded to number-only (no title to show — the branch-name fallback
// is better than a bare "#N · ").
function headlessTitle(issueNumber, issueTitle) {
  const n = parseInt(issueNumber, 10);
  const t = String(issueTitle || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(n) || n <= 0 || !t) return null;
  return `#${n} · ${t}`.slice(0, 256);
}

// The deterministic, LLM-free trim an OpenRouter session's display name
// and its PR title (deterministicPrMetadataDraft in pr-metadata.js) share:
// fenced code and markdown punctuation dropped, whitespace collapsed, and
// a hard 72-character ceiling with an ellipsis on truncation. Returns ''
// when nothing readable survives so each caller picks its own fallback.
// One derivation on purpose — the session name and the PR title stay
// identical only while they come from the same function.
const DETERMINISTIC_TITLE_MAX = 72;

function deterministicTitle(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > DETERMINISTIC_TITLE_MAX
    ? `${plain.slice(0, DETERMINISTIC_TITLE_MAX - 1).trimEnd()}…`
    : plain;
}

// Guarded persist + broadcast shared by every title source. The
// `pr_number IS NULL` guard: once applyPrMetadata mirrored a PR title in,
// a slower in-flight early-title call must lose the race. `send` is the
// chat turn's event emitter (SSE + global WS + session bus), so open
// session lists update live via the `session_titled` event.
async function persistTitle({ pool, session, title, send }) {
  const { rowCount } = await pool.query(
    `UPDATE chat_sessions SET session_title = $1 WHERE id = $2 AND pr_number IS NULL`,
    [title, session.id]
  );
  if (!rowCount) return null;
  session.session_title = title;
  if (send) send('session_titled', { sessionTitle: title });
  return title;
}

// Core generate → debit → persist → broadcast path.
function generateAndApply({ pool, session, requests, specs, issueTitle, userId, apiKey, send }) {
  return (async () => {
    const meta = await llm.generateSessionTitle({
      requests,
      specs,
      issueTitle,
      apiKey,
      telemetryContext: {
        pool,
        appId: session.app_id,
        sessionId: session.id,
      },
    });

    // Debit the Haiku call to the requesting user — BYOK bucket when
    // their own key paid for it, same as the PR-metadata call.
    if (meta.usage && userId != null && pool) {
      const costCents = llm.estimateCostCents(meta.usage, meta.model);
      await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
    }

    return persistTitle({ pool, session, title: meta.title, send });
  })().catch((err) => {
    log.warn('session-title', 'Title generation failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 1 — first interactive message: only a brand-new session (no
// title yet, no PR) gets named from its opening ask. Existing untitled
// sessions also land here on their next message, which is the
// backfill story for pre-#249 rows.
function maybeTitleFirstMessage({ pool, session, message, userId, apiKey, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  const requests = [String(message || '').trim()].filter(Boolean);
  if (!requests.length) return Promise.resolve(null);
  return generateAndApply({ pool, session, requests, specs: [], userId, apiKey, send });
}

// Hook 1, OpenRouter flavour (#1949) — same entry conditions as
// maybeTitleFirstMessage (untitled, no PR), but no model call and no
// payer to resolve. Reads the session's FIRST user message rather than
// trusting the turn's own: a session whose opening turn was refused
// (worker busy) or stopped is still named from its opening ask on the
// next one, and — since deterministicPrMetadataDraft titles the PR from
// the first request too — the name the session shows now is the one it
// keeps when the PR lands. The turn's `message` is the fallback when no
// row comes back. Fire-and-forget like its siblings: always resolves.
function titleFromFirstMessage({ pool, session, message, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  return (async () => {
    const { rows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC LIMIT 1`,
      [session.id]
    );
    const title = deterministicTitle((rows[0] && rows[0].content) || message);
    if (!title) return null;
    return persistTitle({ pool, session, title, send });
  })().catch((err) => {
    log.warn('session-title', 'First-message title failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 2 — pre-PR turn-end refresh: re-title from everything known so
// far (every user message plus the live spec draft). Callers gate on
// "no PR yet" and "didn't already title this turn"; the UPDATE guard
// above covers the race where a PR landed mid-generation.
function refreshFromHistory({ pool, session, userId, apiKey, send }) {
  return (async () => {
    const { rows: reqRows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC`,
      [session.id]
    );
    const { rows: csRows } = await pool.query(
      `SELECT spec_md FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const specMd = ((csRows[0] && csRows[0].spec_md) || '').trim();
    return generateAndApply({
      pool, session,
      requests: reqRows.map((r) => r.content).filter(Boolean),
      specs: specMd ? [specMd] : [],
      userId, apiKey, send,
    });
  })().catch((err) => {
    log.warn('session-title', 'Turn-end title refresh failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

module.exports = {
  headlessTitle, deterministicTitle, generateAndApply,
  maybeTitleFirstMessage, titleFromFirstMessage, refreshFromHistory,
};
