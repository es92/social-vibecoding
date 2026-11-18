'use strict';

// One `Range: bytes=…` header against a body of `total` bytes, for the
// routes that serve stored files (shots artifacts, app files). Returns
// null when there is no header (serve it whole), false when the range
// cannot be satisfied or is not a single byte range (416), or
// { start, end } with `end` inclusive and clamped to the last byte.
function parseRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= total) return false;
  return { start, end: Math.min(end, total - 1) };
}

module.exports = { parseRange };
