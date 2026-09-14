#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECEIPT_VERSION = 2;
const RECEIPT_TTL_MS = 10 * 60 * 1000;
const PROMOTION_GUARD_ATTESTATION = [
  'Homeroom promotion guard health check: PASS.',
  'The trusted project UserPromptSubmit hook executed for this prompt;',
  'the Codex CLI promotion-readiness check in the usernode-proposal skill is satisfied.',
].join(' ');
const CHECKOUT_ROOT = path.resolve(__dirname, '../..');
const LAUNCHER = path.join(CHECKOUT_ROOT, 'tools', 'social-vibecoding');

function promotionSessionId(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.includes('%')) return null;
  let parsed;
  try {
    parsed = new URL(target, 'https://usernode.invalid');
  } catch {
    return null;
  }
  // Express routes are case-insensitive and trailing-slash tolerant unless
  // the application explicitly enables stricter settings.
  const match = parsed.pathname.match(/^\/api\/sessions\/([1-9]\d*)\/promote\/?$/i);
  return match ? match[1] : null;
}

function isTool(toolName, suffix) {
  return typeof toolName === 'string' && toolName.endsWith(suffix);
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function parseSimpleCommand(command, platform = process.platform) {
  if (typeof command !== 'string' || !command.length) return null;
  const windows = platform === 'win32';
  const source = windows ? command.replace(/^\s*&\s+/, '') : command;
  const tokens = [];
  let token = '';
  let state = 'bare';
  let started = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (state === 'single') {
      if (char === "'") state = 'bare';
      else token += char;
      started = true;
      continue;
    }
    if (state === 'double') {
      if (char === '"') {
        state = 'bare';
      } else if (char === '\\') {
        if (windows) {
          token += char;
        } else {
          i += 1;
          if (i >= source.length) return null;
          token += source[i];
        }
      } else if (char === '$' || char === '`') {
        return null;
      } else {
        token += char;
      }
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    if (char === "'") {
      state = 'single';
      started = true;
      continue;
    }
    if (char === '"') {
      state = 'double';
      started = true;
      continue;
    }
    if (char === '\\') {
      if (windows) {
        token += char;
      } else {
        i += 1;
        if (i >= source.length) return null;
        token += source[i];
      }
      started = true;
      continue;
    }
    if (';&|<>`$()'.includes(char)) return null;
    token += char;
    started = true;
  }
  if (state !== 'bare') return null;
  if (started) tokens.push(token);
  return tokens;
}

function canonicalPromotionArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 9) return null;
  const [nodePath, launcher, command, method, target, profileFlag, profile, dataFlag, data] = argv;
  const sessionId = promotionSessionId(target);
  if (!sessionId
      || command !== 'api'
      || method !== 'POST'
      || profileFlag !== '--profile'
      || typeof profile !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)
      || dataFlag !== '--data'
      || data !== '{}') {
    return null;
  }
  let realNode;
  let realLauncher;
  try {
    realNode = fs.realpathSync(nodePath);
    realLauncher = fs.realpathSync(launcher);
  } catch {
    return null;
  }
  if (realNode !== fs.realpathSync(process.execPath)
      || realLauncher !== fs.realpathSync(LAUNCHER)) {
    return null;
  }
  return { argv: [...argv], sessionId };
}

function hostPromotionFromToolResponse(response) {
  if (!response || typeof response !== 'object' || response.isError !== true) return null;
  const value = response.structuredContent;
  if (!value || typeof value !== 'object'
      || value.requires_host_execution !== true
      || value.code !== 'host_execution_required') {
    return null;
  }
  const invocation = canonicalPromotionArgv(value.argv);
  return invocation && value.cwd === CHECKOUT_ROOT ? invocation : null;
}

function receiptRoot() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `social-vibecoding-codex-promotions-${uid}`);
}

function ensureReceiptRoot(root) {
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe promotion receipt directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Promotion receipt directory has the wrong owner');
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(root, 0o700);
}

function receiptPath(input, sessionId, root = receiptRoot()) {
  const digest = crypto.createHash('sha256')
    .update(String(input.session_id || ''))
    .update('\0')
    .update(String(input.turn_id || ''))
    .update('\0')
    .update(sessionId)
    .digest('hex');
  return path.join(root, `${digest}.json`);
}

function claimPath(target, nonce) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
  return `${target}.${nonce}.claim`;
}

function removeClaimForRecord(target, record) {
  const targetClaim = claimPath(target, record?.nonce);
  if (!targetClaim) return;
  try { fs.unlinkSync(targetClaim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function writeReceipt(input, invocation, root = receiptRoot()) {
  if (!input.session_id || !input.turn_id) throw new Error('Codex omitted session or turn identity');
  ensureReceiptRoot(root);
  const target = receiptPath(input, invocation.sessionId, root);
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const record = {
    version: RECEIPT_VERSION,
    nonce: crypto.randomBytes(16).toString('hex'),
    sessionId: input.session_id,
    turnId: input.turn_id,
    proposalSessionId: invocation.sessionId,
    argv: invocation.argv,
    expiresAt: Date.now() + RECEIPT_TTL_MS,
  };
  fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    try {
      removeClaimForRecord(target, JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readReceipt(input, invocation, root = receiptRoot()) {
  if (!input.session_id || !input.turn_id) return false;
  const target = receiptPath(input, invocation.sessionId, root);
  let stat;
  let record;
  try {
    ensureReceiptRoot(root);
    stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    record = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
  const valid = record
    && record.version === RECEIPT_VERSION
    && typeof record.nonce === 'string'
    && /^[0-9a-f]{32}$/.test(record.nonce)
    && record.sessionId === input.session_id
    && record.turnId === input.turn_id
    && record.proposalSessionId === invocation.sessionId
    && Array.isArray(record.argv)
    && JSON.stringify(record.argv) === JSON.stringify(invocation.argv)
    && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt >= Date.now();
  if (!valid && Number.isSafeInteger(record?.expiresAt) && record.expiresAt < Date.now()) {
    removeClaimForRecord(target, record);
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  return valid ? { record, target } : null;
}

function readClaim(receipt) {
  const targetClaim = claimPath(receipt.target, receipt.record.nonce);
  let stat;
  let claim;
  try {
    stat = fs.lstatSync(targetClaim);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    claim = JSON.parse(fs.readFileSync(targetClaim, 'utf8'));
  } catch {
    return null;
  }
  return claim && claim.nonce === receipt.record.nonce
    && typeof claim.toolUseId === 'string' && claim.toolUseId
    ? claim
    : null;
}

function claimReceipt(input, invocation, root = receiptRoot()) {
  if (typeof input.tool_use_id !== 'string' || !input.tool_use_id) return false;
  const receipt = readReceipt(input, invocation, root);
  if (!receipt) return false;
  const targetClaim = claimPath(receipt.target, receipt.record.nonce);
  const claim = {
    nonce: receipt.record.nonce,
    toolUseId: input.tool_use_id,
  };
  try {
    fs.writeFileSync(targetClaim, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') return false;
    return readClaim(receipt)?.toolUseId === input.tool_use_id;
  }
}

function hasClaimedReceipt(input, invocation, root = receiptRoot()) {
  const receipt = readReceipt(input, invocation, root);
  return !!receipt && !!readClaim(receipt);
}

function requestedSessionId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

function promotionFromBash(input) {
  const command = input?.tool_input?.command ?? input?.tool_input?.cmd;
  if (typeof command !== 'string'
      || !/\/api\/sessions\//i.test(command)
      || !/\/promote\/?(?:[?'"\s]|$)/i.test(command)) {
    return null;
  }
  const argv = parseSimpleCommand(command);
  return (argv && canonicalPromotionArgv(argv)) || { invalid: true };
}

function processHook(input, { root = receiptRoot() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Hook input must be an object');
  const event = input.hook_event_name;
  const toolName = input.tool_name;

  // The usernode-proposal skill can load even when project hooks are disabled,
  // pending review, or skipped with an untrusted project config. This
  // prompt-time attestation proves to Codex CLI that this exact pinned hook ran.
  if (event === 'UserPromptSubmit') {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: PROMOTION_GUARD_ATTESTATION,
      },
    };
  }

  if (event === 'PostToolUse' && isTool(toolName, 'proposal_promote')) {
    const invocation = hostPromotionFromToolResponse(input.tool_response);
    const approvedSessionId = requestedSessionId(input.tool_input?.session_id);
    const approvedProfile = input.tool_input?.profile;
    const fallbackProfile = invocation?.argv[6];
    if (invocation
        && approvedSessionId === invocation.sessionId
        && (approvedProfile == null || approvedProfile === fallbackProfile)) {
      writeReceipt(input, invocation, root);
    }
    return null;
  }

  if (event === 'PreToolUse' && isTool(toolName, 'api_write')) {
    const sessionId = promotionSessionId(input.tool_input?.path);
    if (sessionId && String(input.tool_input?.method || '').toUpperCase() === 'POST') {
      return deny(
        `Session ${sessionId} promotion requires the dedicated proposal_promote tool and manual Codex approval.`
      );
    }
    return null;
  }

  if (!isTool(toolName, 'Bash')) return null;
  const invocation = promotionFromBash(input);
  if (!invocation) return null;
  if (event === 'PreToolUse') {
    if (invocation.invalid || !claimReceipt(input, invocation, root)) {
      return deny(
        'Raw proposal promotion is blocked. Call social_vibecoding.proposal_promote first; after manual approval, run only its exact returned host argv.'
      );
    }
    return null;
  }
  if (event === 'PermissionRequest'
      && !invocation.invalid
      && hasClaimedReceipt(input, invocation, root)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
  }
  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const result = processHook(JSON.parse(raw));
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`Promotion approval hook failed closed: ${error.message}\n`);
      process.exitCode = 2;
    }
  });
}

if (require.main === module) main();

module.exports = {
  RECEIPT_TTL_MS,
  PROMOTION_GUARD_ATTESTATION,
  canonicalPromotionArgv,
  hostPromotionFromToolResponse,
  parseSimpleCommand,
  processHook,
  promotionSessionId,
  main,
};
