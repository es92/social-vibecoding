'use strict';

// One-time uploads through the connector: a plan, a video, a screenshot or
// an HTML design.
//
// A coding agent hands Homeroom large things through tool calls, and a tool
// argument is text the agent has to reproduce in full. post_spec took a plan
// that way: an HTML plan with its screens drawn in is easily 400 KB, most of
// it base64, and every character of it had to be written out into the call.
// create_request took screenshots as base64 in the call too, and could not
// attach a video at all, so a request filed by an agent could not carry the
// walkthrough clip Send feedback can. The work-order patch upload (#4264,
// services/external-agent-patch-upload.js) already solved this for patches:
// the agent pipes the bytes to Homeroom with curl, and the tool call names
// the upload by id. This is the same thing for the other three.
//
// THE FLOW. prepare_upload mints a row here for one file of one kind and
// prints a curl command. The agent runs it; routes/connector-uploads.js
// checks the token, checks the file is what its kind says, and stores it.
// Then post_spec takes `specUploadId`, or create_request takes
// `videoUploadId` and `screenshotUploadIds`, and the connector reads the
// upload back on the owner's behalf (takeUpload) instead of reading bytes
// out of the call. A plan's text waits in this table; a video or a
// screenshot goes straight to where the feedback dialog's clips and stills
// go (issue_videos, issue_screenshots), unlinked, so create_request files
// it through the same route, with the same checks and the same inline
// player, as a person's.
//
// THE CREDENTIAL, bounded on every side the way the patch upload's is:
//
//   * 32 random bytes (256 bits); only the SHA-256 is stored, and it is
//     compared in constant time;
//   * printed in the prepare_upload answer to its owner and nowhere else
//     (log-redaction.js masks the `svcu_` shape anyway);
//   * bound to ONE upload of one kind: presented for any other upload it
//     matches nothing, and once a file has been stored with it, it stores
//     no other. So a token that leaked cannot replace the file its owner is
//     about to file; the worst it can do is spend the command first, and the
//     owner's next step then says so;
//   * it does one thing, store bytes for its owner. Using them takes the
//     owner's own connector, which names the upload by id and is checked
//     against the owner here;
//   * it lapses after 24 hours, and the row is swept a day later.
//
// THE SANDBOX CAVEAT is the patch upload's: a hosted sandbox that cannot
// reach Homeroom cannot run the command, so the inline fields stay.

const crypto = require('crypto');
const log = require('./logger');

const TOKEN_PREFIX = 'svcu_';
const TOKEN_RE = /^svcu_[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL_HOURS = 24;
const KINDS = Object.freeze(['plan', 'video', 'screenshot', 'design']);
// Unused commands one person may hold at once. Minting past it drops the
// oldest unused one, as the patch upload drops its oldest token: an agent
// that asks twenty times is not using the first.
const MAX_OPEN_PER_USER = 20;
// Where a video or a screenshot is stored: the feedback dialog's own tables.
const MEDIA_TABLES = Object.freeze({ video: 'issue_videos', screenshot: 'issue_screenshots' });

// The path the command prints; routes/connector-uploads.js answers on
// '/api/connector-uploads/:uploadId'.
function uploadPath(uploadId) {
  return `/api/connector-uploads/${Number(uploadId)}`;
}

// The most one upload of a kind may be. A plan is held to the plan viewer's
// character limit, and UTF-8 spends at most four bytes on a character; a
// video and a screenshot to what the feedback dialog takes. Read lazily: the
// feedback route is a heavy module this one has no other reason to load.
function maxBytesFor(kind) {
  if (kind === 'plan') return require('./request-specs').MAX_SPEC_HTML_CHARS * 4;
  if (kind === 'video') return require('../routes/feedback').MAX_VIDEO_BYTES;
  if (kind === 'screenshot') return require('../routes/feedback').MAX_SCREENSHOT_BYTES;
  if (kind === 'design') return require('./attachments').MAX_HTML_BYTES;
  return 0;
}

function sizeLabel(bytes) {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function makeToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function isCanonicalToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// `Authorization: Bearer svcu_…`, exactly. Anything else is not one of ours.
function tokenFromHeader(header) {
  const m = /^Bearer (svcu_[A-Za-z0-9_-]{43})$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

function uploadIdOf(value) {
  const id = /^\d{1,18}$/.test(String(value == null ? '' : value)) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// What the agent does with a stored upload, said in the upload's answer.
function nextStepFor(kind, uploadId) {
  if (kind === 'plan') return `Call post_spec with specUploadId ${uploadId} instead of spec.`;
  if (kind === 'design') return `Call post_message with designUploadId ${uploadId}.`;
  if (kind === 'video') return `Call create_request with videoUploadId ${uploadId}.`;
  return `Call create_request with ${uploadId} in screenshotUploadIds, or show it in a plan's text as <img src="PATH"> (PATH is this answer's \`path\`), or post_message with it in screenshotUploadIds.`;
}

// Where a stored video or screenshot is served (routes/issue-videos.js,
// the screenshot route), which a plan's text may show.
function mediaPath(kind, mediaId) {
  if (!mediaId) return null;
  if (kind === 'screenshot') return `/issue-images/${mediaId}`;
  if (kind === 'video') return `/issue-videos/${mediaId}`;
  return null;
}

// Rows a day past their expiry. Never fatal; the next mint sweeps again.
async function sweep(pool) {
  try {
    await pool.query(
      `DELETE FROM connector_uploads
        WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
  } catch (err) {
    log.warn('connector-upload', 'sweep failed (continuing)', { err: err.message });
  }
}

// Mint the credential for one upload of one kind, for this user.
async function mintUpload(pool, { userId, kind, origin }) {
  if (!KINDS.includes(kind)) {
    return fail('invalid_request', `kind must be one of ${KINDS.join(', ')}.`);
  }
  let base;
  try {
    base = new URL(String(origin || '')).origin;
  } catch {
    base = null;
  }
  if (!userId || !base || base === 'null') {
    return fail('platform_unavailable', 'Homeroom could not make an upload command right now. Try again shortly.');
  }
  await sweep(pool);
  const token = makeToken();
  const { rows } = await pool.query(
    `INSERT INTO connector_uploads (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(hours => $4::int))
     RETURNING id, expires_at`,
    [userId, kind, hashToken(token), TOKEN_TTL_HOURS]
  );
  const row = rows && rows[0];
  if (!row || !row.id) {
    return fail('platform_unavailable', 'Homeroom could not make an upload command right now. Try again shortly.');
  }
  await pool.query(
    `DELETE FROM connector_uploads
      WHERE user_id = $1 AND stored_at IS NULL
        AND id NOT IN (
          SELECT id FROM connector_uploads
           WHERE user_id = $1 AND stored_at IS NULL
           ORDER BY id DESC
           LIMIT $2)`,
    [userId, MAX_OPEN_PER_USER]
  );
  const uploadId = Number(row.id);
  return {
    ok: true,
    uploadId,
    kind,
    token,
    url: `${base}${uploadPath(uploadId)}`,
    expiresAt: new Date(row.expires_at),
    maxBytes: maxBytesFor(kind),
  };
}

// Which upload, if any, this token is for. The refusals are told apart only
// for the holder of a matching token: to anybody else, an unknown upload and
// a wrong token are the same answer.
async function authenticateUpload(pool, { uploadId, token }) {
  const id = uploadIdOf(uploadId);
  if (!id || !isCanonicalToken(token)) {
    return fail('invalid_upload_token', 'That upload token is not valid for this upload.', { status: 401 });
  }
  const { rows } = await pool.query(
    `SELECT id, user_id, kind, token_hash, stored_at, expires_at > NOW() AS live
       FROM connector_uploads
      WHERE id = $1`,
    [id]
  );
  const row = rows && rows[0];
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(String((row && row.token_hash) || ''), 'hex');
  const same = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
  if (!row || !same) {
    return fail('invalid_upload_token', 'That upload token is not valid for this upload.', { status: 401 });
  }
  if (row.stored_at) {
    return fail(
      'upload_used',
      'This upload command was already used: each one stores one file. Ask prepare_upload for a new one.',
      { status: 409 }
    );
  }
  if (!row.live) {
    return fail(
      'upload_token_expired',
      'This upload command has expired. Ask prepare_upload for a new one.',
      { status: 401 }
    );
  }
  return { ok: true, uploadId: id, userId: Number(row.user_id), kind: row.kind };
}

// Store the file an authenticated upload sent, already checked by the route
// for its kind. The row is claimed in the same statement that records the
// file, so two uploads racing on one command store one file: the loser's
// media row is removed again and it is told the command was used.
async function storeUpload(pool, { uploadId, userId, kind, contentType, body }) {
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const usedUp = () => fail(
    'upload_used',
    'This upload command was already used: each one stores one file. Ask prepare_upload for a new one.',
    { status: 409 }
  );
  if (kind === 'plan' || kind === 'design') {
    const { rows } = await pool.query(
      `UPDATE connector_uploads
          SET stored_at = NOW(), data = $2, bytes = $3, sha256 = $4, content_type = $5
        WHERE id = $1 AND user_id = $6 AND kind IN ('plan', 'design') AND stored_at IS NULL AND expires_at > NOW()
        RETURNING id`,
      [uploadId, body, body.length, sha256, contentType, userId]
    );
    if (!rows || !rows[0]) return usedUp();
    return { ok: true, uploadId, kind, bytes: body.length, sha256 };
  }
  if (!MEDIA_TABLES[kind]) return fail('invalid_request', 'That upload is of no kind Homeroom stores.', { status: 400 });
  const mediaId = crypto.randomBytes(16).toString('hex');
  const mediaRow = [mediaId, userId, contentType, body.length, body];
  if (kind === 'video') {
    await pool.query(
      `INSERT INTO issue_videos (id, user_id, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5)`,
      mediaRow
    );
  } else {
    await pool.query(
      `INSERT INTO issue_screenshots (id, user_id, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5)`,
      mediaRow
    );
  }
  const { rows } = await pool.query(
    `UPDATE connector_uploads
        SET stored_at = NOW(), media_id = $2, bytes = $3, sha256 = $4, content_type = $5
      WHERE id = $1 AND user_id = $6 AND kind = $7 AND stored_at IS NULL AND expires_at > NOW()
      RETURNING id`,
    [uploadId, mediaId, body.length, sha256, contentType, userId, kind]
  );
  if (!rows || !rows[0]) {
    const removal = kind === 'video'
      ? pool.query('DELETE FROM issue_videos WHERE id = $1 AND issue_number IS NULL', [mediaId])
      : pool.query('DELETE FROM issue_screenshots WHERE id = $1 AND issue_number IS NULL', [mediaId]);
    await removal.catch((err) => log.warn('connector-upload', 'removing a raced upload failed (the 24 h sweep will)', {
      uploadId, err: err.message,
    }));
    return usedUp();
  }
  return { ok: true, uploadId, kind, bytes: body.length, sha256, path: mediaPath(kind, mediaId) };
}

// The upload a tool call names, of the user making it, of the kind the field
// takes. Every refusal says what to do instead. A plan comes back as its
// text; a video or a screenshot as the id the request route links.
async function takeUpload(pool, { userId, uploadId, kind, field }) {
  const name = field || 'uploadId';
  const id = uploadIdOf(uploadId);
  if (!id) return fail('invalid_request', `${name} must be the uploadId prepare_upload printed.`);
  const { rows } = await pool.query(
    `SELECT id, kind, stored_at, expires_at > NOW() AS live, data, media_id, bytes, sha256
       FROM connector_uploads
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  const row = rows && rows[0];
  if (!row) {
    return fail(
      'upload_not_found',
      `There is no upload ${id} of yours. It may have been used already, or have expired: ask prepare_upload `
      + 'for a new command and send the file again.'
    );
  }
  if (row.kind !== kind) {
    return fail(
      'upload_wrong_kind',
      `Upload ${id} is a ${row.kind}, and ${name} takes a ${kind}. Ask prepare_upload for a ${kind} upload.`
    );
  }
  if (!row.stored_at) {
    return fail(
      'upload_not_sent',
      `Nothing has been sent with upload ${id}'s command yet. Run the command prepare_upload printed, then call again.`
    );
  }
  if (!row.live) {
    return fail('upload_expired', `Upload ${id} has expired. Ask prepare_upload for a new command and send the file again.`);
  }
  if (kind === 'plan') {
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '');
    return { ok: true, uploadId: id, kind, text: buf.toString('utf8'), bytes: Number(row.bytes) || buf.length };
  }
  if (kind === 'design') {
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '');
    return { ok: true, uploadId: id, kind, data: buf, bytes: Number(row.bytes) || buf.length };
  }
  return { ok: true, uploadId: id, kind, mediaId: String(row.media_id || ''), bytes: Number(row.bytes) || 0 };
}

// A screenshot upload's own bytes, for a tool that hands the picture itself
// to a route instead of linking it by id: propose_featured_illustration,
// whose route (routes/app-illustrations.js) keeps the picture in the
// proposal it opens. The owner's own, and only while it is linked to no
// request.
async function takeImage(pool, { userId, uploadId, field }) {
  const taken = await takeUpload(pool, { userId, uploadId, kind: 'screenshot', field });
  if (!taken.ok) return taken;
  const { rows } = await pool.query(
    `SELECT data FROM issue_screenshots
      WHERE id = $1 AND user_id = $2 AND issue_number IS NULL`,
    [taken.mediaId, userId]
  );
  const data = rows && rows[0] && Buffer.isBuffer(rows[0].data) ? rows[0].data : null;
  if (!data) {
    return fail('upload_not_found', `Upload ${taken.uploadId}'s picture is gone. Ask prepare_upload for a new command and send it again.`);
  }
  return { ok: true, uploadId: taken.uploadId, data };
}

// After a call that used them: the rows are done with. A video's or a
// screenshot's file stays, linked to its request. Never fatal; the sweep
// removes anything left over.
async function consumeUploads(pool, { userId, uploadIds }) {
  const ids = (uploadIds || []).map(uploadIdOf).filter(Boolean);
  if (!ids.length) return;
  try {
    await pool.query(
      'DELETE FROM connector_uploads WHERE id = ANY($1::bigint[]) AND user_id = $2',
      [ids, userId]
    );
  } catch (err) {
    log.warn('connector-upload', 'cleanup after use failed (continuing)', { uploadIds: ids, err: err.message });
  }
}

module.exports = {
  TOKEN_PREFIX,
  TOKEN_TTL_HOURS,
  KINDS,
  MAX_OPEN_PER_USER,
  MEDIA_TABLES,
  uploadPath,
  maxBytesFor,
  sizeLabel,
  makeToken,
  isCanonicalToken,
  hashToken,
  tokenFromHeader,
  uploadIdOf,
  nextStepFor,
  mediaPath,
  sweep,
  mintUpload,
  authenticateUpload,
  storeUpload,
  takeUpload,
  takeImage,
  consumeUploads,
};
