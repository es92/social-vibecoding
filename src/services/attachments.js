'use strict';

// Dev-chat file attachments (#450, expanded to any file type):
// validation + prompt-assembly helpers. Four kinds: 'image' (vision
// blocks for the Mayor), 'text' (inlined into prompts), 'zip'
// (central-directory-validated archives the coding agent extracts in
// its container), and 'binary' (opaque pass-through workspace files).
//
// Everything in this module that doesn't take a `pool` is PURE so
// tests/attachments.test.js can exercise it without Postgres. Storage is
// bytea-in-Postgres (chat_session_attachments, staging:private) following
// the session_visuals pattern — the platform container has no persistent
// file volume. No new npm deps: magic-byte sniffing instead of a MIME
// library, raw-body upload instead of multer.

// ── Limits (mirrored client-side in public/js/dev-chat.js) ──────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // under Anthropic's 5 MB/image cap
const MAX_TEXT_BYTES = 200 * 1024; // inline-into-prompt gate; bigger text rides the binary path
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED = 100 * 1024 * 1024; // declared-size cap across all entries
const MAX_ZIP_ENTRIES = 2000;
// Per-entry compression-ratio bomb guard; entries smaller than the floor
// are exempt (tiny highly-compressible files legitimately exceed 100:1).
const MAX_ZIP_RATIO = 100;
const ZIP_RATIO_FLOOR_BYTES = 4 * 1024;
const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 4;
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
// ── Group-chat attachment limits (#694, mirrored in public/js/group-chat.js) ──
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_APP_CHAT_BYTES = 200 * 1024 * 1024;
// Per-file inline cap when text-file content is injected into a prompt.
const INLINE_CHAR_CAP = 50000;
// Aggregate inline cap across ALL text files in one dispatch block.
// Historically this guarded Linux's 128 KiB per-argument cap (the prompt
// rode a `docker exec -e PROMPT=...` arg and oversized ones E2BIG'd the
// exec); the prompt now travels as a file (worker.TURN_PROMPT_PATH), so
// the cap survives purely as a token-cost bound — text files that don't
// fit the budget degrade to a download instruction.
const INLINE_TOTAL_CHAR_CAP = 80000;
// Image replay policy: image blocks are re-sent to the Mayor only for
// user rows within the last IMAGE_REPLAY_TURNS user turns, and at most
// IMAGE_REPLAY_MAX images per request. Older rows degrade to a textual
// placeholder — bounds recurring vision cost on long conversations.
const IMAGE_REPLAY_TURNS = 4;
const IMAGE_REPLAY_MAX = 8;

// The stored text a user row gets when the user sent attachments with no
// typed message — downstream code never sees empty content.
const ATTACHMENTS_ONLY_TEXT = '(attached files)';

const IMAGE_EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function fileExt(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Magic-byte sniff. Returns the detected image content type or null.
// Never trusts the client's Content-Type.
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Valid UTF-8 with no NUL bytes — the gate for `kind: 'text'` uploads.
function isUtf8Text(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Human-readable byte count for placeholder lines ("3.2 MB", "12 KB").
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Zip central-directory safety validation — pure Node, no decompression,
// no new npm deps (same convention as the magic-byte sniffing above).
// Parses the End-of-Central-Directory record and walks every central
// directory entry, rejecting the classic extraction hazards BEFORE the
// bytes are ever stored: path traversal names, symlink entries,
// encrypted entries, declared-size bombs, and entry-count bombs. The
// declared sizes are advisory (a lying local header can differ), which
// is why extraction only ever happens inside the disposable worker
// container — this gate is defence in depth, not the sole defence.
// Returns { ok: true, manifest: { entryCount, uncompressedBytes,
// topLevel } } or { ok: false, error } with a user-facing message.
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function validateZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, error: 'Not a valid zip archive' };
  }
  // EOCD lives in the last 22..65557 bytes (22-byte record + up to
  // 64 KiB trailing comment). Scan backwards for the signature whose
  // comment length exactly reaches the end of the buffer.
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG
        && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return { ok: false, error: 'Not a valid zip archive (no end-of-central-directory record)' };
  }
  const diskNum = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesThisDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNum !== 0 || cdDisk !== 0 || entriesThisDisk !== entryCount) {
    return { ok: false, error: 'Multi-disk zip archives aren\'t supported' };
  }
  // ZIP64 sentinels — anything legitimately under our size caps never
  // needs ZIP64, so reject rather than parse the ZIP64 EOCD.
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: 'Zip archive is too large or uses an unsupported format (ZIP64)' };
  }
  if (!entryCount) {
    return { ok: false, error: 'Zip archive is empty' };
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    return { ok: false, error: `Zip archive has too many files (max ${MAX_ZIP_ENTRIES})` };
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, error: 'Corrupt zip archive (central directory out of bounds)' };
  }

  let pos = cdOffset;
  let totalUncompressed = 0;
  const topLevel = [];
  const seenTop = new Set();
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== CD_SIG) {
      return { ok: false, error: 'Corrupt zip archive (bad central directory entry)' };
    }
    const flags = buf.readUInt16LE(pos + 8);
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const extAttrs = buf.readUInt32LE(pos + 38);
    if (pos + 46 + nameLen > eocd) {
      return { ok: false, error: 'Corrupt zip archive (entry name out of bounds)' };
    }
    if (flags & 0x0001) {
      return { ok: false, error: 'Password-protected zip archives aren\'t supported' };
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      return { ok: false, error: 'Zip archive is too large or uses an unsupported format (ZIP64)' };
    }
    // Symlink entries (Unix mode in the high 16 bits of external
    // attributes) are the second traversal vector after ../ names.
    if (((extAttrs >>> 16) & 0xf000) === 0xa000) {
      return { ok: false, error: 'Zip archive contains symbolic links, which aren\'t supported' };
    }
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    if (rawName.includes(0)) {
      return { ok: false, error: 'Zip archive contains an invalid file name' };
    }
    const name = rawName.toString('utf8').replace(/\\/g, '/');
    if (!name || name.length > 512 || name.startsWith('/') || /^[a-z]:/i.test(name)
        || name.split('/').some((seg) => seg === '..')) {
      return { ok: false, error: 'Zip archive contains an unsafe file path' };
    }
    if (compressed >= ZIP_RATIO_FLOOR_BYTES && uncompressed / compressed > MAX_ZIP_RATIO) {
      return { ok: false, error: 'Zip archive looks like a decompression bomb (extreme compression ratio)' };
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) {
      return { ok: false, error: `Zip contents too large (max ${Math.round(MAX_ZIP_UNCOMPRESSED / 1024 / 1024)} MB uncompressed)` };
    }
    const isDir = name.endsWith('/');
    const topSeg = name.split('/')[0];
    const top = (name.indexOf('/') >= 0 || isDir) ? `${topSeg}/` : topSeg;
    if (!seenTop.has(top)) {
      seenTop.add(top);
      if (topLevel.length < 20) topLevel.push(top);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return {
    ok: true,
    manifest: { entryCount, uncompressedBytes: totalUncompressed, topLevel },
  };
}

// Full upload validation — the four-way classifier. Returns
// { ok: true, kind, contentType, meta? } or { ok: false, error } with a
// user-facing message. `kind` is one of 'image' | 'zip' | 'text' |
// 'binary'; `meta` is the zip manifest (null otherwise). Anything that
// isn't a recognised image, a valid zip, or inline-sized UTF-8 text
// rides the binary path — delivered to the coding agent as a workspace
// file rather than rejected.
function validateUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, error: 'Empty file' };
  }
  const ext = fileExt(name);
  if (IMAGE_EXT_TYPES[ext]) {
    if (data.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
    }
    const sniffed = sniffImageType(data);
    if (!sniffed) {
      return { ok: false, error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image` };
    }
    // Extension and bytes must agree so a served file can't lie about
    // its type (jpg/jpeg both map to image/jpeg).
    if (sniffed !== IMAGE_EXT_TYPES[ext]) {
      return { ok: false, error: `"${name}" extension doesn't match its actual image format` };
    }
    return { ok: true, kind: 'image', contentType: sniffed, meta: null };
  }
  if (ext === 'zip') {
    if (data.length > MAX_ZIP_BYTES) {
      return { ok: false, error: `Zip too large (max ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB)` };
    }
    if (!(data[0] === 0x50 && data[1] === 0x4b)) {
      return { ok: false, error: `"${name}" doesn't look like a valid zip archive` };
    }
    const zv = validateZip(data);
    if (!zv.ok) return zv;
    return { ok: true, kind: 'zip', contentType: 'application/zip', meta: zv.manifest };
  }
  // Any readable UTF-8 file small enough to inline is text, regardless
  // of extension (including .svg and extensionless files). Stored
  // content_type is always text/plain so serving can never execute
  // markup. Bigger or non-UTF-8 files fall through to binary.
  if (data.length <= MAX_TEXT_BYTES && isUtf8Text(data)) {
    return { ok: true, kind: 'text', contentType: 'text/plain', meta: null };
  }
  if (data.length > MAX_BINARY_BYTES) {
    return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
  }
  return { ok: true, kind: 'binary', contentType: 'application/octet-stream', meta: null };
}

// Group-chat upload classifier (#694). Five kinds: 'image' (inline
// preview), 'markdown' (rendered in the chat side panel), 'html'
// (sandbox-previewable via the /view route), 'text' (other UTF-8,
// download-only), 'binary' (opaque download — zips ride this path too;
// nothing extracts them in group chat, so no central-directory
// validation is needed here). Oversized .md/.html files are rejected
// with a clear error, not silently reclassified, matching images.
function validateChatUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, error: 'Empty file' };
  }
  const ext = fileExt(name);
  if (IMAGE_EXT_TYPES[ext]) {
    if (data.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
    }
    const sniffed = sniffImageType(data);
    if (!sniffed) {
      return { ok: false, error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image` };
    }
    if (sniffed !== IMAGE_EXT_TYPES[ext]) {
      return { ok: false, error: `"${name}" extension doesn't match its actual image format` };
    }
    return { ok: true, kind: 'image', contentType: sniffed, meta: null };
  }
  if (ext === 'md' || ext === 'markdown') {
    if (data.length > MAX_MARKDOWN_BYTES) {
      return { ok: false, error: `Markdown file too large (max ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB)` };
    }
    if (!isUtf8Text(data)) {
      return { ok: false, error: `"${name}" isn't valid UTF-8 text` };
    }
    return { ok: true, kind: 'markdown', contentType: 'text/markdown', meta: null };
  }
  if (ext === 'html' || ext === 'htm') {
    if (data.length > MAX_HTML_BYTES) {
      return { ok: false, error: `HTML file too large (max ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB)` };
    }
    if (!isUtf8Text(data)) {
      return { ok: false, error: `"${name}" isn't valid UTF-8 text` };
    }
    return { ok: true, kind: 'html', contentType: 'text/html', meta: null };
  }
  // Any other readable UTF-8 file under the text cap is 'text' (stored
  // text/plain — keeps the .svg-is-text rule: SVG never serves as an
  // image type). Bigger or non-UTF-8 files fall through to binary.
  if (data.length <= MAX_TEXT_BYTES && isUtf8Text(data)) {
    return { ok: true, kind: 'text', contentType: 'text/plain', meta: null };
  }
  if (data.length > MAX_BINARY_BYTES) {
    return { ok: false, error: `File too large (max ${Math.round(MAX_BINARY_BYTES / 1024 / 1024)} MB)` };
  }
  return { ok: true, kind: 'binary', contentType: 'application/octet-stream', meta: null };
}

// attachmentIds from the chat POST body → deduped array of valid 32-hex
// ids, or null when the input is malformed / over the per-message cap.
function sanitizeAttachmentIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !/^[a-f0-9]{32}$/.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_PER_MESSAGE) return null;
  return out;
}

// Cap inlined text-file content with an explicit marker.
function clipText(str, cap = INLINE_CHAR_CAP) {
  const s = String(str || '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n[truncated — file continues past ${cap} characters]`;
}

function attachedFileBlock(filename, text) {
  return `==== ATTACHED FILE: ${filename} ====\n${clipText(text)}\n==== END ATTACHED FILE ====`;
}

// Image replay planning. `imageCounts` is the per-user-turn image count,
// CHRONOLOGICAL order. Returns a same-length array of booleans: whether
// that turn's images are included as vision blocks. A turn's images are
// all-or-nothing (partial inclusion would make the placeholder text lie).
function planImageInclusion(imageCounts, { turnWindow = IMAGE_REPLAY_TURNS, maxImages = IMAGE_REPLAY_MAX } = {}) {
  const include = imageCounts.map(() => false);
  let budget = maxImages;
  for (let back = 0; back < Math.min(turnWindow, imageCounts.length); back++) {
    const i = imageCounts.length - 1 - back;
    const count = imageCounts[i];
    if (!count) continue;
    if (count <= budget) {
      include[i] = true;
      budget -= count;
    }
  }
  return include;
}

// One-line Mayor-facing placeholder for a zip attachment, built from
// the manifest captured at upload time. The Mayor never sees archive
// bytes — this is how it learns enough to write a good dispatch brief.
function zipPlaceholderLine(att) {
  const meta = att.meta || {};
  const size = humanSize(att.sizeBytes != null ? att.sizeBytes : (att.data ? att.data.length : 0));
  const count = meta.entryCount != null ? `, ${meta.entryCount} files` : '';
  const top = Array.isArray(meta.topLevel) && meta.topLevel.length
    ? `; top level: ${meta.topLevel.slice(0, 10).join(', ')}`
    : '';
  return `[attached file: ${att.filename} — zip archive, ${size}${count}${top}. Its contents are made available to the coding agent on dispatch.]`;
}

function binaryPlaceholderLine(att) {
  const size = humanSize(att.sizeBytes != null ? att.sizeBytes : (att.data ? att.data.length : 0));
  return `[attached file: ${att.filename} — binary file, ${size}. It is made available to the coding agent on dispatch.]`;
}

// Build the Mayor-facing content for one user row that has attachments.
// `attachments` entries: { kind, filename, contentType, data: Buffer }.
// Returns a plain string when there are no attachments, otherwise an
// Anthropic content-block array: image blocks first, then a single text
// block carrying the user's text + inlined text files (+ placeholders for
// images excluded by the replay policy and for zip/binary attachments,
// which are never inlined). Only user rows ever become arrays —
// assistant rows stay strings (buildMayorMessages merges them).
function buildUserMessageContent({ text, attachments, includeImages }) {
  const atts = attachments || [];
  if (!atts.length) return text;

  const blocks = [];
  const textParts = [String(text || '')];

  for (const att of atts) {
    if (att.kind === 'image') {
      if (includeImages) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.contentType || att.content_type,
            data: att.data.toString('base64'),
          },
        });
      } else {
        textParts.push(`[image attachment: ${att.filename} — shown in an earlier turn]`);
      }
    } else if (att.kind === 'zip') {
      textParts.push(zipPlaceholderLine(att));
    } else if (att.kind === 'binary') {
      textParts.push(binaryPlaceholderLine(att));
    } else {
      textParts.push(attachedFileBlock(att.filename, att.data.toString('utf8')));
    }
  }

  // Anthropic rejects empty text blocks — only emit one when there's
  // text to carry (the chat route stores a stub caption for
  // attachments-only sends, so this is belt-and-suspenders).
  const joined = textParts.filter(Boolean).join('\n\n');
  if (joined) blocks.push({ type: 'text', text: joined });
  if (!blocks.length) return String(text || '');
  return blocks;
}

// Filenames appear inside suggested shell commands — keep only
// shell-innocuous characters so a crafted name can't inject anything.
function safePathName(filename) {
  const s = String(filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return s || 'file';
}

// The scout/build dispatch prompt block for the CURRENT turn's
// attachments. Text files are inlined verbatim (clipped, within an
// aggregate budget — see INLINE_TOTAL_CHAR_CAP); images, zips, and
// binaries are listed with usernode-attachments CLI instructions so
// Claude Code can fetch them in the worker container. '' when empty.
function buildDispatchBlock(attachments) {
  const atts = attachments || [];
  if (!atts.length) return '';
  const parts = [];
  let hasCliRefs = false;
  let inlineBudget = INLINE_TOTAL_CHAR_CAP;
  for (const att of atts) {
    const safeName = safePathName(att.filename);
    if (att.kind === 'image') {
      hasCliRefs = true;
      parts.push(`image: ${att.filename} (id ${att.id}) — download it with \`usernode-attachments ${att.id} /tmp/${safeName}\` (run via Bash), then use your Read tool on /tmp/${safeName} to view it.`);
    } else if (att.kind === 'zip') {
      hasCliRefs = true;
      const meta = att.meta || {};
      const count = meta.entryCount != null ? `, ${meta.entryCount} files` : '';
      const top = Array.isArray(meta.topLevel) && meta.topLevel.length
        ? `; top level: ${meta.topLevel.join(', ')}`
        : '';
      const dirName = safeName.replace(/\.zip$/i, '') || 'archive';
      parts.push(`zip archive: ${att.filename} (id ${att.id}${count}${top}) — extract it with \`usernode-attachments ${att.id} --unzip /home/node/attachments/${dirName}/\` (run via Bash), then browse that directory with your normal tools. Treat it as read-only reference material — do not copy it wholesale into the repo unless asked.`);
    } else if (att.kind === 'binary') {
      hasCliRefs = true;
      parts.push(`binary file: ${att.filename} (id ${att.id}) — download it with \`usernode-attachments ${att.id} /home/node/attachments/${safeName}\` (run via Bash).`);
    } else {
      const block = attachedFileBlock(att.filename, att.data.toString('utf8'));
      if (block.length <= inlineBudget) {
        inlineBudget -= block.length;
        parts.push(block);
      } else {
        // Aggregate inline budget exhausted — degrade to a download
        // instruction rather than clipping harder.
        hasCliRefs = true;
        parts.push(`text file: ${att.filename} (id ${att.id}) — too large to inline here; download it with \`usernode-attachments ${att.id} /home/node/attachments/${safeName}\` (run via Bash), then Read it.`);
      }
    }
  }
  const cliNote = hasCliRefs
    ? '\n\nA read-only helper `usernode-attachments` is available (run it via Bash): with no arguments it lists this session\'s attachments as JSON; `usernode-attachments <id> <outpath>` downloads one attachment\'s bytes to a file; `usernode-attachments <id> --unzip <dir>` downloads a zip attachment and extracts it into <dir>. Use it to fetch the attachments referenced above.'
    : '';
  return `\n\n==== USER-ATTACHED FILES (this turn) ====\n\n${parts.join('\n\n')}\n\n==== END USER-ATTACHED FILES ====${cliNote}`;
}

// ── DB helpers (thin — the pure logic above stays pg-free) ──────────

// Bulk-load attachment rows (with bytes) for the user rows of a loaded
// chat history. Returns Map<messageId, [{ id, kind, filename,
// contentType, data }]>. History rows carry metadata.attachments (the
// render-time summary); the bytea rows are the prompt-time source.
async function loadForHistory(pool, history) {
  const ids = [];
  for (const row of history) {
    if (row.role === 'user' && row.id != null
        && Array.isArray(row.metadata?.attachments) && row.metadata.attachments.length) {
      ids.push(row.id);
    }
  }
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await pool.query(
    `SELECT id, message_id, kind, filename, content_type, size_bytes, meta, data
       FROM chat_session_attachments
      WHERE message_id = ANY($1)
      ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  for (const r of rows) {
    const entry = {
      id: r.id, kind: r.kind, filename: r.filename, contentType: r.content_type,
      sizeBytes: r.size_bytes, meta: r.meta, data: r.data,
    };
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push(entry);
  }
  return map;
}

// Load the current turn's attachments (with bytes) for the dispatch
// block. `ids` are already ownership-verified by the chat handler.
async function loadByIds(pool, ids) {
  if (!ids || !ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, kind, filename, content_type, size_bytes, meta, data
       FROM chat_session_attachments
      WHERE id = ANY($1)
      ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, filename: r.filename,
    contentType: r.content_type, sizeBytes: r.size_bytes, meta: r.meta, data: r.data,
  }));
}

// Content-Disposition's legacy filename parameter is a header, so Node only
// accepts Latin-1 in it. Real filenames are not: macOS screenshot names carry
// a narrow no-break space (U+202F) before AM/PM, and people attach files
// named in any script. Passing such a name through verbatim makes
// res.set() throw ERR_INVALID_CHAR, which every serve route turns into a
// 500 (#2113). Keep a readable ASCII fallback and carry the exact UTF-8
// filename in the RFC 5987 parameter browsers prefer.
function attachmentDisposition(type, filename) {
  const name = String(filename || 'file');
  const fallback = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'file';
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_UNCOMPRESSED,
  MAX_ZIP_ENTRIES,
  MAX_BINARY_BYTES,
  MAX_PER_MESSAGE,
  MAX_SESSION_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_HTML_BYTES,
  MAX_APP_CHAT_BYTES,
  INLINE_CHAR_CAP,
  INLINE_TOTAL_CHAR_CAP,
  IMAGE_REPLAY_TURNS,
  IMAGE_REPLAY_MAX,
  ATTACHMENTS_ONLY_TEXT,
  fileExt,
  sniffImageType,
  isUtf8Text,
  humanSize,
  validateZip,
  validateUpload,
  validateChatUpload,
  attachmentDisposition,
  sanitizeAttachmentIds,
  clipText,
  attachedFileBlock,
  planImageInclusion,
  buildUserMessageContent,
  buildDispatchBlock,
  loadForHistory,
  loadByIds,
};
