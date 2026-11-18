// Tests for the app file-storage service (#752, src/services/app-files.js):
// the pure image/audio validation + quota logic, and the write/delete
// ordering contracts against a fake pool and a fake object store (no
// Postgres, no MinIO). Contracts pinned here:
//
//  - images, audio, PDFs, video and text files only, magic-byte sniffed,
//    extension must match the bytes (audio: Ogg/Opus and MP3; video:
//    MP4 and WebM; text: UTF-8 with no NUL bytes, never markup/script);
//  - the per-kind size caps (5 MB images and text, 25 MB audio and PDFs,
//    100 MB video) and the
//    app/user/staging quota caps with their structured error codes;
//  - upload writes the OBJECT first and rolls it back if the metadata
//    INSERT fails (no orphaned rows pointing at nothing);
//  - delete removes the OBJECT first and keeps the row when that fails
//    (so a retry/sweep can reconcile);
//  - no configured store → storage_unavailable, never a crash.
//
// Run with: node --test tests/app-files.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const appFiles = require('../src/services/app-files');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);
// An Ogg page whose identification header (inside the first 64 bytes)
// names Opus.
const OPUS = Buffer.concat([
  Buffer.from('OggS'), Buffer.alloc(20, 0), Buffer.from('OpusHead'), Buffer.alloc(20, 0),
]);
// An Ogg page that carries no Opus identification header (Vorbis, say).
const OGG_NO_OPUS = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 0)]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0)]);
// A bare MPEG Layer III frame sync (0xFF 0xFB is the common MP3 one).
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(32, 0)]);

// A minimal, real PDF: the `%PDF-` header is what the sniff reads.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
);
// An MP4 `ftyp` box (24 bytes): major brand, minor version, compatible brands.
function mp4(brand = 'isom', compatible = 'isomiso2avc1mp41') {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from(brand),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from(compatible),
  ]);
}
// EBML magic + the header that names the DocType, as a WebM file carries it.
function webm(docType = 'webm') {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x42, 0x86, 0x81, 0x01]),
    Buffer.from(docType),
  ]);
}

// ── validateImageUpload ─────────────────────────────────────────────

test('accepts a valid png with matching extension', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: PNG });
  assert.equal(v.ok, true);
  assert.equal(v.contentType, 'image/png');
});

test('accepts jpg/jpeg extensions for jpeg bytes', () => {
  for (const name of ['a.jpg', 'a.jpeg']) {
    const v = appFiles.validateImageUpload({ filename: name, data: JPEG });
    assert.equal(v.ok, true, name);
    assert.equal(v.contentType, 'image/jpeg');
  }
});

test('rejects non-image extensions with invalid_image', () => {
  for (const name of ['notes.wav', 'page.html', 'vector.svg', 'noext']) {
    const v = appFiles.validateImageUpload({ filename: name, data: PNG });
    assert.equal(v.ok, false, name);
    assert.equal(v.code, 'invalid_image');
  }
});

test('rejects extension/bytes mismatch', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: JPEG });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_image');
});

test('rejects bytes that are not a real image', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: Buffer.alloc(64, 7) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_image');
});

test('rejects empty files and bad filenames', () => {
  assert.equal(appFiles.validateImageUpload({ filename: 'a.png', data: Buffer.alloc(0) }).ok, false);
  assert.equal(appFiles.validateImageUpload({ filename: '', data: PNG }).ok, false);
  assert.equal(appFiles.validateImageUpload({ filename: 'x'.repeat(300) + '.png', data: PNG }).ok, false);
});

test('rejects oversized images with file_too_large', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(appFiles.MAX_FILE_BYTES, 1)]);
  const v = appFiles.validateImageUpload({ filename: 'big.png', data: big });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'file_too_large');
  assert.match(v.error, /Image too large \(max 5 MB\)/);
});

// ── audio validation ────────────────────────────────────────────────

test('accepts Opus audio under .opus and .ogg', () => {
  for (const name of ['narration.opus', 'narration.ogg']) {
    const v = appFiles.validateUpload({ filename: name, data: OPUS });
    assert.equal(v.ok, true, name);
    assert.equal(v.contentType, 'audio/ogg');
  }
});

test('accepts MP3 with an ID3 tag and with a bare Layer III frame sync', () => {
  for (const data of [MP3_ID3, MP3_FRAME]) {
    const v = appFiles.validateUpload({ filename: 'narration.mp3', data });
    assert.equal(v.ok, true);
    assert.equal(v.contentType, 'audio/mpeg');
  }
});

test('rejects Ogg without an Opus header', () => {
  const v = appFiles.validateUpload({ filename: 'narration.ogg', data: OGG_NO_OPUS });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_audio');
  assert.match(v.error, /doesn't look like valid Opus or MP3 audio/);
});

test('rejects image bytes named as audio', () => {
  const v = appFiles.validateUpload({ filename: 'narration.opus', data: PNG });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_audio');
});

test('rejects audio bytes whose extension names the other audio format', () => {
  // Ogg/Opus bytes named .mp3.
  const v = appFiles.validateUpload({ filename: 'narration.mp3', data: OPUS });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_audio');
  assert.match(v.error, /extension doesn't match its actual audio format/);
});

test('sniffAudioType returns null for JPEG bytes and empty input', () => {
  assert.equal(appFiles.sniffAudioType(JPEG), null);
  assert.equal(appFiles.sniffAudioType(Buffer.alloc(0)), null);
});

test('accepts a 6 MB audio file, still under the 25 MB audio cap', () => {
  const sixMb = Buffer.concat([OPUS, Buffer.alloc(6 * 1024 * 1024, 0)]);
  const v = appFiles.validateUpload({ filename: 'narration.opus', data: sixMb });
  assert.equal(v.ok, true);
  assert.equal(v.contentType, 'audio/ogg');
});

test('rejects audio over 25 MB with file_too_large', () => {
  const tooBig = Buffer.concat([OPUS, Buffer.alloc(appFiles.MAX_AUDIO_FILE_BYTES, 0)]);
  const v = appFiles.validateUpload({ filename: 'narration.mp3', data: tooBig });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'file_too_large');
  assert.match(v.error, /Audio too large \(max 25 MB\)/);
});

test('unknown extensions are still invalid_image', () => {
  for (const name of ['narration.wav', 'narration.aiff']) {
    const v = appFiles.validateUpload({ filename: name, data: OPUS });
    assert.equal(v.ok, false, name);
    assert.equal(v.code, 'invalid_image');
  }
});

test('UPLOAD_BODY_LIMIT sits above the video file cap', () => {
  const bytes = parseInt(appFiles.UPLOAD_BODY_LIMIT, 10) * 1024 * 1024;
  assert.ok(bytes > appFiles.MAX_VIDEO_FILE_BYTES);
  assert.ok(bytes > appFiles.MAX_AUDIO_FILE_BYTES);
});

// ── documents, video and text ───────────────────────────────────────

test('accepts a real PDF as application/pdf', () => {
  const v = appFiles.validateUpload({ filename: 'menu.pdf', data: PDF });
  assert.equal(v.ok, true);
  assert.equal(v.contentType, 'application/pdf');
});

test('accepts an MP4 whose ftyp box names a known brand', () => {
  for (const brand of ['isom', 'mp42', 'avc1', 'M4V ']) {
    const v = appFiles.validateUpload({ filename: 'clip.mp4', data: mp4(brand) });
    assert.equal(v.ok, true, brand);
    assert.equal(v.contentType, 'video/mp4');
  }
});

test('refuses a QuickTime brand and an unknown brand named .mp4', () => {
  const quicktime = appFiles.validateUpload({ filename: 'clip.mp4', data: mp4('qt  ') });
  assert.equal(quicktime.ok, false);
  assert.equal(quicktime.code, 'invalid_file');
  assert.match(quicktime.error, /doesn't look like a valid MP4 video/);
  // No known brand anywhere in the ftyp box.
  const unknown = appFiles.validateUpload({
    filename: 'clip.mp4', data: mp4('XXXX', 'XXXXXXXX'),
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'invalid_file');
});

test('accepts a WebM EBML header and refuses a Matroska one', () => {
  const ok = appFiles.validateUpload({ filename: 'clip.webm', data: webm('webm') });
  assert.equal(ok.ok, true);
  assert.equal(ok.contentType, 'video/webm');
  const mkv = appFiles.validateUpload({ filename: 'clip.webm', data: webm('matroska') });
  assert.equal(mkv.ok, false);
  assert.equal(mkv.code, 'invalid_file');
  assert.match(mkv.error, /doesn't look like a valid WebM video/);
});

test('refuses bytes a browser could run, whatever the name says', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const js = Buffer.from('const x = 1;');
  const pdfAsHtml = appFiles.validateUpload({ filename: 'menu.pdf', data: html });
  assert.equal(pdfAsHtml.ok, false);
  assert.equal(pdfAsHtml.code, 'invalid_file');
  assert.match(pdfAsHtml.error, /doesn't look like a valid PDF/);
  for (const data of [svg, html]) {
    const v = appFiles.validateUpload({ filename: 'notes.txt', data });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'invalid_file');
  }
  // An SVG renamed to a text extension is refused too (its bytes open `<`).
  assert.equal(appFiles.validateUpload({ filename: 'data.csv', data: svg }).code, 'invalid_file');
  // The risky extensions have no kind at all.
  for (const name of ['page.html', 'page.htm', 'script.js', 'module.mjs', 'feed.xml', 'vector.svg']) {
    const v = appFiles.validateUpload({ filename: name, data: html });
    assert.equal(v.ok, false, name);
    assert.equal(v.code, 'invalid_image', name);
  }
  assert.equal(appFiles.validateUpload({ filename: 'notes.txt', data: js }).ok, false);
  assert.equal(appFiles.validateUpload({ filename: 'data.json', data: Buffer.from('</script>') }).ok, false);
});

test('accepts text, CSV, JSON and calendar files', () => {
  const cases = [
    ['notes.txt', Buffer.from('Buy milk\nCall Sam\n'), 'text/plain; charset=utf-8'],
    ['rows.csv', Buffer.from('name,qty\napples,3\n'), 'text/csv; charset=utf-8'],
    ['data.json', Buffer.from('{"name":"Plant Pal","count":3}'), 'application/json'],
    ['event.ics', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\r\nBEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n')]), 'text/calendar; charset=utf-8'],
  ];
  for (const [name, data, type] of cases) {
    const v = appFiles.validateUpload({ filename: name, data });
    assert.equal(v.ok, true, name);
    assert.equal(v.contentType, type, name);
  }
});

test('refuses invalid UTF-8, NUL bytes, bad JSON and a non-calendar .ics', () => {
  const cases = [
    ['notes.txt', Buffer.from([0xc3, 0x28, 0x41])], // invalid UTF-8 sequence
    ['notes.txt', Buffer.from('abc\u0000def')],
    ['data.json', Buffer.from('{not json')],
    ['event.ics', Buffer.from('BEGIN:VEVENT\nEND:VEVENT')],
  ];
  for (const [name, data] of cases) {
    const v = appFiles.validateUpload({ filename: name, data });
    assert.equal(v.ok, false, name);
    assert.equal(v.code, 'invalid_file', name);
  }
});

test('per-kind caps: PDF 25 MB, video 100 MB, text 5 MB', () => {
  const pdfTooBig = Buffer.concat([PDF, Buffer.alloc(appFiles.MAX_PDF_FILE_BYTES, 0)]);
  const pdfV = appFiles.validateUpload({ filename: 'big.pdf', data: pdfTooBig });
  assert.equal(pdfV.ok, false);
  assert.equal(pdfV.code, 'file_too_large');
  assert.match(pdfV.error, /PDF too large \(max 25 MB\)/);

  const videoTooBig = Buffer.concat([mp4(), Buffer.alloc(appFiles.MAX_VIDEO_FILE_BYTES, 0)]);
  const videoV = appFiles.validateUpload({ filename: 'big.mp4', data: videoTooBig });
  assert.equal(videoV.ok, false);
  assert.equal(videoV.code, 'file_too_large');
  assert.match(videoV.error, /Video too large \(max 100 MB\)/);

  const textTooBig = Buffer.concat([Buffer.from('a,'), Buffer.alloc(appFiles.MAX_TEXT_FILE_BYTES, 0x61)]);
  const textV = appFiles.validateUpload({ filename: 'big.csv', data: textTooBig });
  assert.equal(textV.ok, false);
  assert.equal(textV.code, 'file_too_large');
  assert.match(textV.error, /File too large \(max 5 MB\)/);
});

test('accepts a 30 MB MP4, over the image cap but under the video cap', () => {
  const clip = Buffer.concat([mp4(), Buffer.alloc(30 * 1024 * 1024, 0)]);
  const v = appFiles.validateUpload({ filename: 'clip.mp4', data: clip });
  assert.equal(v.ok, true);
  assert.equal(v.contentType, 'video/mp4');
});

test('isInlineType renders only media inline', () => {
  for (const type of ['image/png', 'audio/ogg', 'video/mp4', 'video/webm']) {
    assert.equal(appFiles.isInlineType(type), true, type);
  }
  for (const type of ['application/pdf', 'text/csv; charset=utf-8', 'application/json',
    'application/octet-stream', '', null, undefined]) {
    assert.equal(appFiles.isInlineType(type), false, String(type));
  }
});

// ── quotaVerdict ────────────────────────────────────────────────────

test('quota verdict: fits under all caps', () => {
  assert.equal(appFiles.quotaVerdict({
    size: 1000, appBytes: 0, userBytes: 0, stagingBytes: 0, staging: false,
  }), null);
});

test('quota verdict: per-app cap (10 GB)', () => {
  assert.equal(appFiles.PER_APP_CAP, 10 * 1024 * 1024 * 1024);
  const v = appFiles.quotaVerdict({
    size: 1000, appBytes: appFiles.PER_APP_CAP - 10, userBytes: 0, stagingBytes: 0, staging: false,
  });
  assert.equal(v.code, 'app_quota_exceeded');
});

test('quota verdict: per-user cap (1 GB)', () => {
  assert.equal(appFiles.PER_USER_PER_APP_CAP, 1 * 1024 * 1024 * 1024);
  const v = appFiles.quotaVerdict({
    size: 1000, appBytes: 0, userBytes: appFiles.PER_USER_PER_APP_CAP - 10, stagingBytes: 0, staging: false,
  });
  assert.equal(v.code, 'user_quota_exceeded');
});

test('quota verdict: staging cap only applies to staging uploads', () => {
  const base = { size: 1000, appBytes: 0, userBytes: 0, stagingBytes: appFiles.STAGING_PER_APP_CAP - 10 };
  assert.equal(appFiles.quotaVerdict({ ...base, staging: false }), null);
  assert.equal(appFiles.quotaVerdict({ ...base, staging: true }).code, 'staging_quota_exceeded');
});

// ── helpers ─────────────────────────────────────────────────────────

test('objectKey embeds the app id for prefix deletes', () => {
  assert.equal(appFiles.objectKey(42, 'a'.repeat(32)), `app/42/${'a'.repeat(32)}`);
});

test('normalizeVisibility defaults everything but private to public', () => {
  assert.equal(appFiles.normalizeVisibility('private'), 'private');
  assert.equal(appFiles.normalizeVisibility('public'), 'public');
  assert.equal(appFiles.normalizeVisibility('sneaky'), 'public');
  assert.equal(appFiles.normalizeVisibility(undefined), 'public');
});

test('fileUrl is an absolute platform URL keyed by id', () => {
  const url = appFiles.fileUrl('b'.repeat(32));
  assert.match(url, new RegExp(`^https://.+/app-files/${'b'.repeat(32)}$`));
});

// ── storeAppFile / deleteAppFile ordering ───────────────────────────

function fakePool({ failInsert = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*FROM app_files WHERE app_id/.test(sql)) {
        return { rows: [{ app_bytes: '0', user_bytes: '0', staging_bytes: '0' }] };
      }
      if (/INSERT INTO app_files/.test(sql)) {
        if (failInsert) throw new Error('insert boom');
        return { rows: [{ id: params[0], filename: params[4], content_type: params[5], size_bytes: params[6], visibility: params[7], owner: params[3], sha256: params[9], created_at: new Date(0) }] };
      }
      if (/SELECT id, user_id FROM app_files/.test(sql)) {
        return { rows: [{ id: params[0], user_id: 5 }] };
      }
      return { rows: [] };
    },
  };
}

function fakeStore({ failRemove = false } = {}) {
  const ops = [];
  return {
    ops,
    async putFile(appId, id, buf, contentType) { ops.push(['put', appId, id, contentType]); },
    async getFileStream() { throw new Error('not used'); },
    async removeFile(appId, id) {
      ops.push(['remove', appId, id]);
      if (failRemove) throw new Error('remove boom');
    },
    async removeAppPrefix() { return 0; },
  };
}

test('storeAppFile: object then row, returns the file shape', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, true);
  assert.match(r.file.id, /^[a-f0-9]{32}$/);
  assert.equal(r.file.contentType, 'image/png');
  assert.equal(r.file.sizeBytes, PNG.length);
  assert.equal(r.file.visibility, 'public');
  assert.match(r.file.url, /\/app-files\//);
  assert.deepEqual(store.ops[0].slice(0, 2), ['put', 7]);
  assert.ok(pool.calls.some((c) => /INSERT INTO app_files/.test(c.sql)));
});

test('storeAppFile: stores an MP3 as audio/mpeg', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: 5, filename: 'narration.mp3', visibility: 'public', staging: false, data: MP3_ID3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.file.contentType, 'audio/mpeg');
  assert.equal(store.ops[0][3], 'audio/mpeg');
  const insert = pool.calls.find((c) => /INSERT INTO app_files/.test(c.sql));
  assert.equal(insert.params[5], 'audio/mpeg');
});

test('storeAppFile: failed INSERT rolls the object back', async () => {
  const pool = fakePool({ failInsert: true });
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'upload_failed');
  assert.equal(store.ops.filter((o) => o[0] === 'put').length, 1);
  assert.equal(store.ops.filter((o) => o[0] === 'remove').length, 1);
});

test('storeAppFile: no store → storage_unavailable 503', async () => {
  const r = await appFiles.storeAppFile(fakePool(), null, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'storage_unavailable');
});

test('deleteAppFile: object delete failure keeps the row', async () => {
  const pool = fakePool();
  const store = fakeStore({ failRemove: true });
  const r = await appFiles.deleteAppFile(pool, store, { appId: 7, fileId: 'c'.repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'storage_unavailable');
  assert.ok(!pool.calls.some((c) => /DELETE FROM app_files/.test(c.sql)));
});

test('deleteAppFile: uploader gate 404s on someone else\'s file', async () => {
  const pool = fakePool(); // stored row's user_id is 5
  const store = fakeStore();
  const r = await appFiles.deleteAppFile(pool, store, {
    appId: 7, fileId: 'c'.repeat(32), requireUserId: 9,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(store.ops.length, 0);
});

test('deleteAppFile: malformed id 404s without querying', async () => {
  const pool = fakePool();
  const r = await appFiles.deleteAppFile(pool, fakeStore(), { appId: 7, fileId: 'not-an-id' });
  assert.equal(r.status, 404);
  assert.equal(pool.calls.length, 0);
});

// ── Files an app keeps for itself ───────────────────────────────────

test('quotaVerdict: an app file skips the per-person cap; the app cap is per app', () => {
  const GB = 1024 * 1024 * 1024;
  const over = { size: 10, appBytes: 0, userBytes: 2 * GB, stagingBytes: 0, staging: false };
  assert.equal(appFiles.quotaVerdict({ ...over, owner: 'user' }).code, 'user_quota_exceeded');
  assert.equal(appFiles.quotaVerdict({ ...over, owner: 'app' }), null);
  const nearly = { size: 10, appBytes: 3 * GB, userBytes: 0, stagingBytes: 0, staging: false, owner: 'app' };
  assert.equal(appFiles.quotaVerdict(nearly), null, '10 GB by default');
  const verdict = appFiles.quotaVerdict({ ...nearly, appCapBytes: 3 * GB });
  assert.equal(verdict.code, 'app_quota_exceeded');
  assert.match(verdict.error, /3 GB max/);
});

test('storeAppFile: owner app stores no uploader and the bytes\' SHA-256', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: null, owner: 'app', filename: 'chapter.mp3', visibility: 'public', staging: false, data: MP3_ID3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.file.owner, 'app');
  assert.equal(r.file.sha256, require('crypto').createHash('sha256').update(MP3_ID3).digest('hex'));
  const insert = pool.calls.find((c) => /INSERT INTO app_files/.test(c.sql));
  assert.equal(insert.params[2], null);
  assert.equal(insert.params[3], 'app');
});

test('storeAppFile: refuses a person\'s upload with no person, and an app file in staging', async () => {
  const base = { appId: 7, filename: 'a.mp3', visibility: 'public', data: MP3_ID3 };
  await assert.rejects(appFiles.storeAppFile(fakePool(), fakeStore(), { ...base, userId: null, staging: false }), TypeError);
  await assert.rejects(appFiles.storeAppFile(fakePool(), fakeStore(), { ...base, owner: 'app', staging: true }), TypeError);
  await assert.rejects(appFiles.storeAppFile(fakePool(), fakeStore(), { ...base, owner: 'nobody', staging: false }), TypeError);
});
