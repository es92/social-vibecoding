'use strict';

// #6534: the files Homeroom bot attaches to its reply in a request's, a
// change's or a reply thread.
//
// A thread is read by the whole group, so the bot attaches only what this
// turn made or rendered, or a design already stored for the person asking:
// never something a link points to, and never something another message told
// it to post. Each file is checked with the chat composer's own classifier
// (services/attachments.js), counted against the reply's four-file limit and
// the app's storage cap, and stored unlinked against the bot's account.
// ws.sendBotMessage links the rows to the reply when it posts it; a turn
// that ends quiet leaves them unlinked, and the daily sweep removes them.

const crypto = require('crypto');
const attachments = require('./attachments');
const log = require('./logger');

function refusal(error) {
  return { ok: false, error: `${error} Nothing was attached.` };
}

/**
 * Store `files` ([{ filename, data }]) for the reply in `ctx`.
 * Resolves { ok: true, stored: [{ id, kind, filename, sizeBytes }] } and
 * pushes the same rows onto ctx.attached, or { ok: false, error } in words
 * the model can tell the person.
 */
async function store(pool, ctx, files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && Buffer.isBuffer(f.data) && f.data.length);
  if (!list.length) return { ok: true, stored: [] };
  const appId = Number(ctx.app.id);
  const botId = Number(ctx.bot.id);
  const already = Array.isArray(ctx.attached) ? ctx.attached.length : 0;
  if (already + list.length > attachments.MAX_PER_MESSAGE) {
    return refusal(`A reply carries at most ${attachments.MAX_PER_MESSAGE} files; ${already + list.length} were offered.`);
  }
  const checked = [];
  for (const file of list) {
    const verdict = attachments.validateChatUpload({ filename: file.filename, data: file.data });
    if (!verdict.ok) return refusal(`${file.filename}: ${verdict.error}.`);
    checked.push({ ...verdict, filename: file.filename, data: file.data });
  }
  const adding = checked.reduce((n, f) => n + f.data.length, 0);
  const { rows: sumRows } = await pool.query(
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
       FROM chat_message_attachments WHERE app_id = $1`,
    [appId]
  );
  if (Number(sumRows[0].total) + adding > attachments.MAX_APP_CHAT_BYTES) {
    return refusal(`This project's chat attachment storage is full (${Math.round(attachments.MAX_APP_CHAT_BYTES / 1024 / 1024)} MB max).`);
  }
  const stored = [];
  for (const file of checked) {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO chat_message_attachments
         (id, app_id, user_id, kind, filename, content_type, size_bytes, meta, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, appId, botId, file.kind, file.filename, file.contentType, file.data.length,
        file.meta ? JSON.stringify(file.meta) : null, file.data]
    );
    stored.push({ id, kind: file.kind, filename: file.filename, sizeBytes: file.data.length });
  }
  ctx.attached = [...(Array.isArray(ctx.attached) ? ctx.attached : []), ...stored];
  log.info('homeroom-bot-thread-attachments', 'Stored files for a reply', {
    appId, files: stored.length,
  });
  return { ok: true, stored };
}

module.exports = { store };
