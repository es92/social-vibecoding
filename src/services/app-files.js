'use strict';

// App file storage (#752): user-uploaded images, audio, video, PDFs and
// text files apps store
// through the platform. Bytes live in the MinIO object-store sidecar
// (compose service `usernode-minio`, reachable only from the platform
// over the internal `usernode-storage` network); Postgres's `app_files`
// table holds metadata only (ownership, quotas, visibility).
//
// Layout mirrors services/attachments.js: everything that doesn't take
// a `pool` or a `store` is PURE so tests/app-files.test.js can exercise
// validation without Postgres or MinIO. The object-store wrapper is
// injectable (route factories accept a `store` override) so route tests
// pass a fake client.

const crypto = require('crypto');
const { sniffImageType, fileExt } = require('./attachments');
const log = require('./logger');

// ── Limits ──────────────────────────────────────────────────────────
// Images stay at 5 MB: that fits phone JPEGs, and there is deliberately
// no server-side resizing (that would need a native dep like sharp) —
// apps should downscale large camera photos client-side.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Server-generated narration is longer: 25 MB is roughly 30 minutes of
// speech in Opus or MP3.
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
// A menu, a score or a flyer as a PDF fits comfortably here.
const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
// A short video clip. Counted against the same shared quotas as the rest.
const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024;
// Plain text, CSV, JSON and calendar files are small by nature.
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
// Object storage removes the DB-bloat constraint, so the caps are
// generous: images and audio share one allowance. PER_APP_CAP is the
// default; an admin may give one app its own (apps.file_storage_cap_bytes).
// The per-person cap applies to files people upload, never to the files
// an app keeps for itself (owner 'app').
const PER_APP_CAP = 10 * 1024 * 1024 * 1024; // 10 GB
const PER_USER_PER_APP_CAP = 1 * 1024 * 1024 * 1024; // 1 GB
// Who a stored file belongs to: a person who uploaded it through the app,
// or the app itself (its server, with the app token alone).
const OWNERS = new Set(['user', 'app']);
// Largest page an app may list its files in.
const MAX_LIST_LIMIT = 1000;
// Staging-preview uploads (bridge relay path) are capped tighter and
// GC'd by the server.js sweeper after STAGING_GC_DAYS regardless.
const STAGING_PER_APP_CAP = 100 * 1024 * 1024; // 100 MB
const STAGING_GC_DAYS = 7;

// The raw-body parser's limit. It must exceed MAX_VIDEO_FILE_BYTES (the
// largest per-kind cap) so the service's own structured size check fires
// before the parser's PayloadTooLarge.
const UPLOAD_BODY_LIMIT = '101mb';

// Mirrors attachments.js's image map (not exported there; this keeps a
// 4-line duplication rather than a cross-module export).
const IMAGE_EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Accepted narration extensions and what their bytes must be.
const AUDIO_EXT_TYPES = {
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

// Documents download rather than render: a PDF served inline from the
// platform's own origin would run as a page there.
const DOCUMENT_EXT_TYPES = {
  pdf: 'application/pdf',
};

// Video plays inline. MP4 covers H.264/AAC; WebM must say `webm` in its
// EBML header (a Matroska file is refused). QuickTime is not accepted.
const VIDEO_EXT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
};

// Text and data kinds, also served as downloads. Any of these whose
// bytes begin like HTML, XML, SVG or JavaScript is refused (see
// sniffText), whatever the extension says.
const TEXT_EXT_TYPES = {
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  ics: 'text/calendar; charset=utf-8',
};

// ── Pure validation ─────────────────────────────────────────────────

// Magic-byte sniff for the audio kinds app storage accepts. Returns the
// detected content type or null; never trusts the client's Content-Type.
//   - Ogg: the buffer opens with `OggS`, and the first page's
//     identification header (searched within the first 64 bytes, to
//     allow for the page's segment table) says `OpusHead`. Ogg files
//     carrying another codec (Vorbis, say) are not accepted.
//   - MP3: an `ID3` tag prefix, or a bare MPEG frame sync whose layer
//     bits are Layer III. The mask keeps the sync bits and the layer
//     bits, so JPEG's `FF D8` and AAC's ADTS sync are not matched.
function sniffAudioType(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') {
    const head = buf.subarray(0, 64).toString('latin1');
    return head.includes('OpusHead') ? 'audio/ogg' : null;
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2) return 'audio/mpeg';
  return null;
}

// ISO-BMFF brands an MP4 may carry: H.264 video (`avc1`, `M4V `), the
// common `mp4*`/`isom` family, and DASH segments. The list is the gate:
// QuickTime's `qt  ` brand and every brand this does not name are refused.
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash',
]);

// MP4: bytes 4..8 are the `ftyp` box; its major brand or one of the
// compatible brands listed in that box must be a known MP4 brand.
function sniffMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  if (buf.subarray(8, 12).toString('latin1').startsWith('qt')) return null;
  let end = buf.readUInt32BE(0);
  if (end < 16) end = 16;
  end = Math.min(end, buf.length);
  for (let off = 8; off + 4 <= end; off += 4) {
    if (MP4_BRANDS.has(buf.subarray(off, off + 4).toString('latin1'))) return 'video/mp4';
  }
  return null;
}

// WebM: the EBML magic, with a DocType of `webm` in the header. Matroska
// (`matroska`) is the same container with a different DocType — refused.
function sniffWebm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (!(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) return null;
  const head = buf.subarray(0, 64).toString('latin1');
  if (head.includes('matroska')) return null;
  return head.includes('webm') ? 'video/webm' : null;
}

// An opening that a browser would treat as markup or script. Refused even
// under a `.txt`/`.csv` name, so a text upload can never be a page.
const SCRIPT_OPENING = /^(#!|\/\/|\/\*|\(function|function\s|import\s|export\s|var\s|let\s|const\s)/;

// Valid UTF-8 with no NUL bytes; a leading BOM and whitespace are dropped.
// Returns the stripped text, or null when the bytes are not plain text.
function sniffText(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (buf.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/^\s+/, '');
  if (text.startsWith('<') || SCRIPT_OPENING.test(text)) return null;
  return text;
}

// The sniff for the document, video and text kinds. Returns the stored
// content type or null; the extension picks the kind, and the bytes must
// agree with it.
function sniffFileType(buf, ext) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (DOCUMENT_EXT_TYPES[ext]) {
    return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
      ? DOCUMENT_EXT_TYPES[ext] : null;
  }
  if (VIDEO_EXT_TYPES[ext]) {
    return VIDEO_EXT_TYPES[ext] === 'video/webm' ? sniffWebm(buf) : sniffMp4(buf);
  }
  if (TEXT_EXT_TYPES[ext]) {
    const text = sniffText(buf);
    if (text === null) return null;
    if (ext === 'json') {
      try { JSON.parse(text); } catch { return null; }
    }
    if (ext === 'ics' && !/^BEGIN:VCALENDAR/i.test(text)) return null;
    return TEXT_EXT_TYPES[ext];
  }
  return null;
}

// Whether a stored type is safe to render on the page. Only media (images,
// audio, video) is inline; everything else is served as an attachment.
function isInlineType(contentType) {
  const type = String(contentType || '').toLowerCase();
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/');
}

// Upload validation for images, audio, documents, video and text. Returns
// { ok: true, contentType }
// or { ok: false, code, error } with a user-facing message. Same rules as
// attachments.validateUpload's image branch: magic-byte sniff, never trust
// the client's Content-Type, extension must agree with the bytes. The
// extension picks the kind, so each kind has its own size limit.
function validateUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, code: 'invalid_image', error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, code: 'invalid_image', error: 'Empty file' };
  }
  const ext = fileExt(name);
  const imageType = IMAGE_EXT_TYPES[ext];
  const audioType = AUDIO_EXT_TYPES[ext];
  const documentType = DOCUMENT_EXT_TYPES[ext];
  const videoType = VIDEO_EXT_TYPES[ext];
  const textType = TEXT_EXT_TYPES[ext];
  if (!imageType && !audioType && !documentType && !videoType && !textType) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" isn't a supported file type (PNG, JPEG, GIF, WebP, Opus, MP3, PDF, MP4, WebM, TXT, CSV, JSON or ICS)`,
    };
  }
  if (documentType || videoType || textType) {
    const cap = documentType ? MAX_PDF_FILE_BYTES
      : videoType ? MAX_VIDEO_FILE_BYTES : MAX_TEXT_FILE_BYTES;
    const label = documentType ? 'PDF' : videoType ? 'Video' : 'File';
    if (data.length > cap) {
      return {
        ok: false, code: 'file_too_large',
        error: `${label} too large (max ${Math.round(cap / 1024 / 1024)} MB)`,
      };
    }
    const sniffed = sniffFileType(data, ext);
    if (!sniffed) {
      const what = documentType ? 'a valid PDF'
        : ext === 'webm' ? 'a valid WebM video'
          : videoType ? 'a valid MP4 video'
            : textType === TEXT_EXT_TYPES.json ? 'valid JSON'
              : textType === TEXT_EXT_TYPES.ics ? 'a valid calendar (.ics) file'
                : 'plain UTF-8 text';
      return {
        ok: false, code: 'invalid_file',
        error: `"${name}" doesn't look like ${what}`,
      };
    }
    return { ok: true, contentType: sniffed };
  }
  if (audioType) {
    if (data.length > MAX_AUDIO_FILE_BYTES) {
      return {
        ok: false, code: 'file_too_large',
        error: `Audio too large (max ${Math.round(MAX_AUDIO_FILE_BYTES / 1024 / 1024)} MB)`,
      };
    }
    const sniffed = sniffAudioType(data);
    if (!sniffed) {
      return {
        ok: false, code: 'invalid_audio',
        error: `"${name}" doesn't look like valid Opus or MP3 audio`,
      };
    }
    if (sniffed !== audioType) {
      return {
        ok: false, code: 'invalid_audio',
        error: `"${name}" extension doesn't match its actual audio format`,
      };
    }
    return { ok: true, contentType: sniffed };
  }
  if (data.length > MAX_FILE_BYTES) {
    return {
      ok: false, code: 'file_too_large',
      error: `Image too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`,
    };
  }
  const sniffed = sniffImageType(data);
  if (!sniffed) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image`,
    };
  }
  if (sniffed !== imageType) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" extension doesn't match its actual image format`,
    };
  }
  return { ok: true, contentType: sniffed };
}

// Kept as an alias so existing callers and tests keep working.
const validateImageUpload = validateUpload;

function normalizeVisibility(raw) {
  return raw === 'private' ? 'private' : 'public';
}

// Object key: the per-app prefix enables bulk prefix deletion when an
// app is removed (removeAppPrefix below).
function objectKey(appId, fileId) {
  return `app/${appId}/${fileId}`;
}

// The stable, absolute URL an app persists in its own DB. Apex-host
// based so it works identically from production and staging containers
// and survives any future storage-backend move (serving is
// platform-proxied, never a direct object-store URL).
function fileUrl(id) {
  // Lazy require avoids a cycle if caddy ever grows a dep on services.
  const { USERNODE_DOMAIN } = require('./caddy');
  return `https://${USERNODE_DOMAIN}/app-files/${id}`;
}

// ── Object-store wrapper (MinIO / any S3-compatible endpoint) ───────
//
// Constructed from config; absent config (no MINIO_ENDPOINT / creds in
// env) yields null and every route degrades to a clear
// `storage_unavailable` error instead of crashing. Bucket creation is
// lazy and retried per call so a MinIO that comes up after the platform
// (depends_on is service_started, not service_healthy) heals itself.
function createObjectStore(config, { client: injectedClient } = {}) {
  const endpoint = config?.storageEndpoint;
  const accessKey = config?.storageAccessKey;
  const secretKey = config?.storageSecretKey;
  const bucket = config?.storageBucket || 'usernode-app-files';
  if (!endpoint || !accessKey || !secretKey) return null;

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    log.error('app-files', 'Invalid storage endpoint URL', { endpoint });
    return null;
  }
  const Minio = require('minio');
  const client = injectedClient || new Minio.Client({
    endPoint: url.hostname,
    port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
    useSSL: url.protocol === 'https:',
    accessKey,
    secretKey,
  });

  let bucketReady = false;
  async function ensureBucket() {
    if (bucketReady) return;
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket).catch(async (err) => {
        // Concurrent first-uploads can race makeBucket; a bucket that
        // exists after the error is a win, not a failure.
        if (await client.bucketExists(bucket).catch(() => false)) return;
        throw err;
      });
    }
    bucketReady = true;
  }

  return {
    bucket,
    // Raw keys for the platform media store. Unlike app uploads, its bucket
    // is provisioned by the operator (including versioning and lifecycle),
    // so these methods never silently create a missing bucket.
    async putObject(key, buffer, contentType) {
      await client.putObject(bucket, key, buffer, buffer.length, { 'Content-Type': contentType });
    },
    async statObject(key) {
      try {
        return await client.statObject(bucket, key);
      } catch (err) {
        if (err.code === 'NoSuchKey' || err.code === 'NotFound') return null;
        throw err;
      }
    },
    async getObjectStream(key, range = null) {
      return range
        ? client.getPartialObject(bucket, key, range.start, range.end - range.start + 1)
        : client.getObject(bucket, key);
    },
    async removeObject(key) {
      await client.removeObject(bucket, key);
    },
    async *objects(prefix, after = '') {
      const stream = client.listObjectsV2(bucket, prefix, true, after);
      try {
        for await (const object of stream) yield object;
      } finally {
        stream.destroy();
      }
    },
    async putFile(appId, fileId, buffer, contentType) {
      await ensureBucket();
      await client.putObject(bucket, objectKey(appId, fileId), buffer, buffer.length, {
        'Content-Type': contentType,
      });
    },
    async getFileStream(appId, fileId, range = null) {
      return range
        ? client.getPartialObject(bucket, objectKey(appId, fileId), range.start, range.end - range.start + 1)
        : client.getObject(bucket, objectKey(appId, fileId));
    },
    async removeFile(appId, fileId) {
      await client.removeObject(bucket, objectKey(appId, fileId));
    },
    // Bulk delete of every object under app/<appId>/ — the app-deletion
    // cleanup path. Streams the listing so a large app doesn't buffer
    // its whole key set.
    async removeAppPrefix(appId) {
      await ensureBucket();
      const prefix = `app/${appId}/`;
      const keys = [];
      await new Promise((resolve, reject) => {
        const stream = client.listObjectsV2(bucket, prefix, true);
        stream.on('data', (obj) => { if (obj?.name) keys.push(obj.name); });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      if (keys.length) await client.removeObjects(bucket, keys);
      return keys.length;
    },
  };
}

// Module-level singleton for server.js / route factories. Tests inject
// their own store through the route factories' `deps` param instead.
let _store;
let _storeInitialized = false;
function getStore(config) {
  if (!_storeInitialized) {
    _store = createObjectStore(config);
    _storeInitialized = true;
    if (!_store) {
      log.warn('app-files', 'Object storage not configured — app file uploads disabled '
        + '(set MINIO_ENDPOINT / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD)');
    }
  }
  return _store;
}

// ── Quota + persistence helpers ─────────────────────────────────────

// The app's file allowance: its admin-set figure, else PER_APP_CAP.
async function appCapBytes(pool, appId) {
  const { rows } = await pool.query('SELECT file_storage_cap_bytes FROM apps WHERE id = $1', [appId]);
  const cap = rows[0] ? rows[0].file_storage_cap_bytes : null;
  return cap == null ? PER_APP_CAP : Number(cap);
}

async function usageSums(pool, appId, userId, staging = null) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(size_bytes), 0)::bigint AS app_bytes,
       COALESCE(SUM(size_bytes) FILTER (WHERE user_id = $2), 0)::bigint AS user_bytes,
       COALESCE(SUM(size_bytes) FILTER (WHERE staging), 0)::bigint AS staging_bytes,
       COALESCE(SUM(size_bytes) FILTER (WHERE owner = 'app'), 0)::bigint AS app_owned_bytes
     FROM app_files WHERE app_id = $1 AND ($3::boolean IS NULL OR staging = $3)`,
    [appId, userId, staging]
  );
  return {
    appBytes: Number(rows[0].app_bytes),
    userBytes: Number(rows[0].user_bytes),
    stagingBytes: Number(rows[0].staging_bytes),
    appOwnedBytes: Number(rows[0].app_owned_bytes),
  };
}

// Pure: quota verdict for an upload of `size` bytes given current sums.
// Returns null when the upload fits, else { code, error }. A file the app
// keeps for itself counts against the app's allowance only.
function quotaVerdict({
  size, appBytes, userBytes, stagingBytes, staging, appCapBytes: appCap = PER_APP_CAP, owner = 'user',
}) {
  if (staging && stagingBytes + size > STAGING_PER_APP_CAP) {
    return {
      code: 'staging_quota_exceeded',
      error: `Staging upload storage for this app is full (${Math.round(STAGING_PER_APP_CAP / 1024 / 1024)} MB max)`,
    };
  }
  if (appBytes + size > appCap) {
    return {
      code: 'app_quota_exceeded',
      error: `This app's file storage is full (${formatCap(appCap)} max)`,
    };
  }
  if (owner === 'user' && userBytes + size > PER_USER_PER_APP_CAP) {
    return {
      code: 'user_quota_exceeded',
      error: `Your file storage in this app is full (${Math.round(PER_USER_PER_APP_CAP / 1024 / 1024)} MB max)`,
    };
  }
  return null;
}

function formatCap(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// The shape every path answers with, from an app_files row.
function fileShape(row) {
  return {
    id: row.id,
    url: fileUrl(row.id),
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    visibility: row.visibility,
    owner: row.owner,
    sha256: row.sha256 || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Full upload: validate → quota-check → put object → insert metadata.
// Object first, row second; on INSERT failure the object is best-effort
// removed so it can't leak (a row-less object is invisible anyway).
// `owner: 'app'` stores a file the app keeps for itself: no uploader, and
// only the app's allowance applies. Returns { ok: true, file } or
// { ok: false, status, code, error }.
async function storeAppFile(pool, store, { appId, userId, owner = 'user', filename, visibility, staging, data }) {
  if (!store) {
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  if (!OWNERS.has(owner)) throw new TypeError(`Unknown file owner: ${owner}`);
  if (owner === 'user' && userId == null) throw new TypeError('A person\'s upload needs its user id');
  // Staging never holds the app token, so a preview never keeps app files.
  if (owner === 'app' && staging) throw new TypeError('An app file is never staging data');
  const verdict = validateUpload({ filename, data });
  if (!verdict.ok) {
    return { ok: false, status: 400, code: verdict.code, error: verdict.error };
  }
  const uploader = owner === 'app' ? null : userId;
  const [sums, appCap] = await Promise.all([usageSums(pool, appId, uploader), appCapBytes(pool, appId)]);
  const quota = quotaVerdict({ size: data.length, ...sums, staging: !!staging, appCapBytes: appCap, owner });
  if (quota) return { ok: false, status: 400, code: quota.code, error: quota.error };

  const id = crypto.randomBytes(16).toString('hex');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  try {
    await store.putFile(appId, id, data, verdict.contentType);
  } catch (err) {
    log.error('app-files', 'Object store put failed', { appId, err: err.message });
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO app_files (id, app_id, user_id, owner, filename, content_type, size_bytes, visibility, staging, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, filename, content_type, size_bytes, visibility, owner, sha256, created_at`,
      [id, appId, uploader, owner, String(filename).trim(), verdict.contentType, data.length,
        normalizeVisibility(visibility), !!staging, sha256]
    );
    row = rows[0];
  } catch (err) {
    log.error('app-files', 'Metadata insert failed; removing object', { appId, id, err: err.message });
    await store.removeFile(appId, id).catch(() => {});
    return { ok: false, status: 500, code: 'upload_failed', error: 'Upload failed' };
  }
  return { ok: true, file: fileShape(row) };
}

// One page of an app's own production files, oldest id first after
// `after`, for an app reconciling or resuming a copy. `owner` narrows it
// to the app's own files or to people's uploads; omitted, both.
async function listAppFiles(pool, { appId, owner = null, after = null, limit = 100 }) {
  if (owner != null && !OWNERS.has(owner)) throw new TypeError(`Unknown file owner: ${owner}`);
  const n = Math.min(Math.max(1, Number.isInteger(limit) ? limit : 100), MAX_LIST_LIMIT);
  const { rows } = await pool.query(
    `SELECT id, filename, content_type, size_bytes, visibility, owner, sha256, created_at
       FROM app_files
      WHERE app_id = $1 AND NOT staging
        AND ($2::text IS NULL OR owner = $2)
        AND ($3::text IS NULL OR id > $3)
      ORDER BY id
      LIMIT $4`,
    [appId, owner, after, n + 1]
  );
  const files = rows.slice(0, n).map(fileShape);
  return { files, next: rows.length > n ? files[files.length - 1].id : null };
}

// One of the app's own production files, or null.
async function findAppFile(pool, { appId, fileId }) {
  if (!/^[a-f0-9]{32}$/.test(String(fileId || ''))) return null;
  const { rows } = await pool.query(
    `SELECT id, app_id, filename, content_type, size_bytes, visibility, owner, sha256, created_at
       FROM app_files WHERE id = $1 AND app_id = $2 AND NOT staging`,
    [fileId, appId]
  );
  return rows[0] || null;
}

// Deletion: object first, row second — a failed object delete leaves
// the row so a retry (or the staging sweep) can reconcile, while a
// deleted object with a lingering row just 404s on serve.
// `requireUserId` (bridge path) restricts to the uploader's own files;
// the production server path (takedowns) passes null for its app files.
async function deleteAppFile(pool, store, { appId, fileId, requireUserId = null, staging = false }) {
  if (!store) {
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  if (!/^[a-f0-9]{32}$/.test(String(fileId || ''))) {
    return { ok: false, status: 404, code: 'not_found', error: 'File not found' };
  }
  const { rows } = await pool.query(
    'SELECT id, user_id FROM app_files WHERE id = $1 AND app_id = $2 AND staging = $3',
    [fileId, appId, staging]
  );
  if (!rows.length || (requireUserId != null && rows[0].user_id !== requireUserId)) {
    return { ok: false, status: 404, code: 'not_found', error: 'File not found' };
  }
  try {
    await store.removeFile(appId, fileId);
  } catch (err) {
    log.error('app-files', 'Object store delete failed', { appId, fileId, err: err.message });
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  await pool.query('DELETE FROM app_files WHERE id = $1 AND app_id = $2 AND staging = $3', [fileId, appId, staging]);
  return { ok: true };
}

// ── Admin: the file allowance beside each app's database cap ──────

function fileFigures(row) {
  const override = row.file_storage_cap_bytes == null ? null : Number(row.file_storage_cap_bytes);
  return {
    fileBytes: Number(row.file_bytes || 0),
    fileAppOwnedBytes: Number(row.app_owned_bytes || 0),
    fileCapBytes: override == null ? PER_APP_CAP : override,
    fileCapOverrideBytes: override,
  };
}

// slug → what the admin console shows of each app's stored files.
async function adminFileFigures(pool) {
  const { rows } = await pool.query(
    `SELECT a.slug, a.file_storage_cap_bytes,
            COALESCE(f.bytes, 0)::bigint AS file_bytes,
            COALESCE(f.app_owned_bytes, 0)::bigint AS app_owned_bytes
       FROM apps a
       LEFT JOIN (SELECT app_id, SUM(size_bytes) AS bytes,
                         SUM(size_bytes) FILTER (WHERE owner = 'app') AS app_owned_bytes
                    FROM app_files WHERE NOT staging GROUP BY app_id) f ON f.app_id = a.id
      WHERE NOT a.self_hosted`
  );
  return new Map(rows.map((row) => [row.slug, fileFigures(row)]));
}

// Set (bytes) or clear (null) one app's file allowance. Takes effect on
// the next upload. Returns the app's figures, or null for no such app.
async function setFileCapOverride(pool, slug, capBytesOrNull) {
  let cap = null;
  if (capBytesOrNull != null) {
    cap = Number(capBytesOrNull);
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new Error('file cap must be a non-negative integer number of bytes, or null for the default');
    }
  }
  const { rows } = await pool.query(
    `UPDATE apps SET file_storage_cap_bytes = $1
      WHERE slug = $2 AND NOT self_hosted
  RETURNING id, file_storage_cap_bytes`,
    [cap, slug]
  );
  if (!rows[0]) return null;
  log.info('app-files', 'App file allowance set', { slug, capBytes: cap });
  const sums = await usageSums(pool, rows[0].id, null, false);
  return fileFigures({ ...rows[0], file_bytes: sums.appBytes, app_owned_bytes: sums.appOwnedBytes });
}

// `userId` null is the app asking for itself: no person's figures.
async function usageReport(pool, appId, userId, { staging = false } = {}) {
  const [sums, appCap] = await Promise.all([usageSums(pool, appId, userId, staging), appCapBytes(pool, appId)]);
  return {
    appBytes: sums.appBytes,
    appCapBytes: appCap,
    appOwnedBytes: sums.appOwnedBytes,
    userBytes: userId == null ? null : sums.userBytes,
    userCapBytes: userId == null ? null : PER_USER_PER_APP_CAP,
  };
}

// Staging-upload GC (server.js sweeper): remove objects for staging
// rows past STAGING_GC_DAYS, deleting each row only after its object
// removal succeeded so failures retry on the next sweep.
async function sweepStagingFiles(pool, store, { limit = 200 } = {}) {
  if (!store) return 0;
  const { rows } = await pool.query(
    `SELECT id, app_id FROM app_files
      WHERE staging AND created_at < NOW() - INTERVAL '${STAGING_GC_DAYS} days'
      ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  let removed = 0;
  for (const row of rows) {
    try {
      await store.removeFile(row.app_id, row.id);
      await pool.query('DELETE FROM app_files WHERE id = $1', [row.id]);
      removed++;
    } catch (err) {
      log.warn('app-files', 'Staging file GC failed; will retry next sweep', {
        id: row.id, appId: row.app_id, err: err.message,
      });
    }
  }
  return removed;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_AUDIO_FILE_BYTES,
  MAX_PDF_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  UPLOAD_BODY_LIMIT,
  PER_APP_CAP,
  PER_USER_PER_APP_CAP,
  MAX_LIST_LIMIT,
  STAGING_PER_APP_CAP,
  STAGING_GC_DAYS,
  IMAGE_EXT_TYPES,
  AUDIO_EXT_TYPES,
  DOCUMENT_EXT_TYPES,
  VIDEO_EXT_TYPES,
  TEXT_EXT_TYPES,
  sniffAudioType,
  sniffFileType,
  isInlineType,
  validateUpload,
  validateImageUpload,
  normalizeVisibility,
  quotaVerdict,
  objectKey,
  fileUrl,
  createObjectStore,
  getStore,
  usageSums,
  appCapBytes,
  fileShape,
  storeAppFile,
  listAppFiles,
  findAppFile,
  deleteAppFile,
  usageReport,
  adminFileFigures,
  setFileCapOverride,
  sweepStagingFiles,
};
