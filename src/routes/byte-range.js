'use strict';

// Answering a video element's byte-range requests from one buffer
// (#3940, first written for routes/issue-videos.js; also the card preview
// loops in routes/app-illustrations.js).
//
// A video element seeking into a clip sends `Range: bytes=N-`, and Safari
// asks for `bytes=0-1` before it plays anything at all. Answering
// 200-with-the-whole-body makes some players refuse to seek, or stall until
// the whole buffer arrives. A bytea row is one buffer, so the slice is a
// cheap subarray. The caller sets the content type and cache headers first.

/** Send `data`, honouring a single `Range: bytes=` request (206, or 416 when unsatisfiable). */
function sendRange(req, res, data) {
  res.set('Accept-Ranges', 'bytes');
  const total = data.length;
  const range = req.headers.range;
  if (!range) {
    res.set('Content-Length', String(total));
    return res.send(data);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  const start = match && match[1] !== '' ? parseInt(match[1], 10) : null;
  const end = match && match[2] !== '' ? parseInt(match[2], 10) : null;
  // Malformed or unsatisfiable (start past the end): say so, per the
  // Range spec, rather than silently answering 200.
  if (!match || (start === null && end === null) || (start !== null && start >= total)) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  let first = 0;
  let last = total - 1;
  if (start === null) {
    // bytes=-N: the final N bytes.
    first = Math.max(0, total - end);
  } else {
    first = start;
    if (end !== null) last = Math.min(end, total - 1);
  }
  const body = data.subarray(first, last + 1);
  res.status(206);
  res.set('Content-Range', `bytes ${first}-${last}/${total}`);
  res.set('Content-Length', String(body.length));
  return res.send(body);
}

module.exports = { sendRange };
