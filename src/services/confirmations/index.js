'use strict';

// Sealed one-use confirmations: the part that does not depend on where the
// confirmation is stored.
//
// Global Chat introduced these for its writes; it has since been removed, and
// agent sessions confirm the Mayor's writes this way (#2779). The rules live
// here, apart from any one consumer's storage:
//
//   * the bearer token is 32 random bytes, returned once to the authenticated
//     client and never placed in model context, logs or transcripts. Only its
//     SHA-256 is stored;
//   * the exact input is normalized (keys sorted, bounded at 1 MiB), sealed
//     with AES-GCM under the deployment's data key, and fingerprinted, so what
//     runs is byte-for-byte what the user was shown;
//   * a confirmation expires, by default in 5 minutes and never later than 15;
//   * an optional object revision lets the consumer refuse a confirmation for
//     an item that changed after it was shown.
//
// Each consumer keeps its own table and its own SQL, so every statement stays
// static and each table's ownership check (an agent session's, today) is
// written where that table is.

const crypto = require('node:crypto');
const secrets = require('../secrets');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_INPUT_BYTES = 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class ActionConfirmationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActionConfirmationError';
    this.code = code;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function normalizedJson(input) {
  let json;
  try { json = JSON.stringify(stableValue(input)); } catch { json = null; }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) {
    throw new ActionConfirmationError('invalid_action', 'The action input is not bounded JSON.');
  }
  return json;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sealedInput(json, dataKey) {
  return { version: 1, ciphertext: secrets.encrypt(json, dataKey) };
}

function openedInput(value, dataKey) {
  if (!value || value.version !== 1 || typeof value.ciphertext !== 'string') {
    throw new ActionConfirmationError('invalid_action', 'The prepared action cannot be read.');
  }
  const json = secrets.decrypt(value.ciphertext, dataKey);
  if (!json) throw new ActionConfirmationError('invalid_action', 'The prepared action cannot be read.');
  let parsed;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ActionConfirmationError('invalid_action', 'The prepared action input is invalid.');
  }
  return { json, input: parsed };
}

// A fresh bearer token and the hash that is all the database ever holds.
function mintToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token) };
}

// Refuse a presented token that cannot be one we minted, before any lookup.
function assertTokenShape(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new ActionConfirmationError('invalid_or_expired_action', 'This confirmation is invalid or expired.');
  }
}

function checkedTime(now) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.valueOf())) throw new ActionConfirmationError('invalid_action', 'Invalid action time.');
  return at;
}

// When a confirmation issued at `now` stops working: `ttlMs` bounded to
// between one second and MAX_TTL_MS, DEFAULT_TTL_MS when absent.
function expiryFor(now, ttlMs = DEFAULT_TTL_MS) {
  const issuedAt = checkedTime(now);
  const bounded = Math.max(1_000, Math.min(MAX_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
  return { issuedAt, expiresAt: new Date(issuedAt.valueOf() + bounded) };
}

// The object revision a confirmation is bound to, or null for none. Printable,
// and at most 255 characters, because it is compared as a string.
function normalizedRevision(objectRevision) {
  if (objectRevision == null) return null;
  const revision = String(objectRevision);
  if (!revision || revision.length > 255 || /[\u0000-\u001f\u007f]/.test(revision)) {
    throw new ActionConfirmationError('invalid_action', 'The object revision is invalid.');
  }
  return revision;
}

// Everything a prepared confirmation stores about its input: the sealed copy
// and the fingerprint of exactly what was sealed.
function sealAction(input, dataKey) {
  if (!dataKey) throw new ActionConfirmationError('invalid_action', 'Action encryption is unavailable.');
  const json = normalizedJson(input);
  return { sealed: sealedInput(json, dataKey), inputHash: sha256(json) };
}

// Open a stored confirmation and prove it still matches its fingerprint.
function openAction(sealed, inputHash, dataKey) {
  if (!dataKey) throw new ActionConfirmationError('invalid_action', 'Action encryption is unavailable.');
  const opened = openedInput(sealed, dataKey);
  if (sha256(opened.json) !== inputHash) {
    throw new ActionConfirmationError('invalid_action', 'The prepared action no longer matches its input.');
  }
  return opened;
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MAX_INPUT_BYTES,
  TOKEN_RE,
  ActionConfirmationError,
  stableValue,
  normalizedJson,
  sha256,
  sealedInput,
  openedInput,
  mintToken,
  assertTokenShape,
  checkedTime,
  expiryFor,
  normalizedRevision,
  sealAction,
  openAction,
};
