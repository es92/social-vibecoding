#!/usr/bin/env node
'use strict';

// Transparent stdio wrapper around Playwright MCP in evidence turns. Codex
// can batch its journal events, so host-side tool timestamps do not measure
// browser-call time. This wrapper observes the JSON-RPC boundary itself and
// writes only bounded, content-free diagnostics to a worker-local file. The
// runner tails that file into the ordinary evidence trace.

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { performance } = require('node:perf_hooks');

const MARKER = '__USERNODE_EVIDENCE_BROWSER__ ';
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const ID_TAIL_BYTES = 4096;
const PENDING_INTERVAL_MS = 15_000;
const TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close',
]);

function lineTap(onLine) {
  let parts = [];
  let capturedBytes = 0;
  let lineBytes = 0;
  let tail = Buffer.alloc(0);
  const append = (part) => {
    lineBytes += part.length;
    tail = part.length >= ID_TAIL_BYTES
      ? part.subarray(-ID_TAIL_BYTES)
      : Buffer.concat([tail, part]).subarray(-ID_TAIL_BYTES);
    if (capturedBytes >= MAX_LINE_BYTES) return;
    const bounded = part.subarray(0, MAX_LINE_BYTES - capturedBytes);
    parts.push(bounded);
    capturedBytes += bounded.length;
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0;
      for (;;) {
        const end = chunk.indexOf(10, offset);
        if (end < 0) { append(chunk.subarray(offset)); break; }
        append(chunk.subarray(offset, end));
        try {
          onLine(Buffer.concat(parts, capturedBytes).toString('utf8'), {
            bytes: lineBytes, truncated: lineBytes > capturedBytes,
            tail: tail.toString('utf8'),
          });
        } catch { /* Observation must never break MCP transport. */ }
        parts = [];
        capturedBytes = 0;
        lineBytes = 0;
        tail = Buffer.alloc(0);
        offset = end + 1;
      }
      callback(null, chunk);
    },
  });
}

function responseId(line, parsed, tail = '') {
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'id')) return parsed.id;
  // A screenshot result can exceed MAX_LINE_BYTES. JSON-RPC normally places
  // the id before or after the content. Read only bounded ends in this case.
  const pattern = /"id"\s*:\s*(?:"([^"\\]{1,80})"|(\d{1,16}))/;
  const match = /"id"\s*:\s*(?:"([^"\\]{1,80})"|(\d{1,16}))\s*}\s*$/.exec(tail)
    || pattern.exec(line.slice(0, 4096));
  return match ? (match[1] === undefined ? Number(match[2]) : match[1]) : null;
}

function errorClass(value) {
  const text = String(value || '');
  if (/timeout|timed out/i.test(text)) return 'timeout';
  if (/net::ERR_|ERR_CONNECTION|ECONN|ENOTFOUND/i.test(text)) return 'network';
  if (/target.*closed|browser.*closed|page.*closed/i.test(text)) return 'browser_closed';
  if (/strict mode violation|resolved to \d+ elements/i.test(text)) return 'locator_ambiguous';
  return 'other';
}

function resultShape(message, bytes, truncated) {
  if (!message) return { outcome: 'unparsed', responseBytes: Math.min(bytes, 10_000_000) };
  const result = message.result;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  const content = texts.join('\n');
  const failed = !!message.error || result?.isError === true;
  return {
    outcome: message.error ? 'rpc_error' : result?.isError === true ? 'tool_error' : 'ok',
    responseBytes: Math.min(bytes, 10_000_000),
    textChars: Math.min(content.length, 10_000_000),
    imageBlocks: Math.min(blocks.filter((block) => block?.type === 'image').length, 1000),
    headingCount: Math.min((content.match(/^\s*- heading\b/gm) || []).length, 1000),
    buttonCount: Math.min((content.match(/^\s*- button\b/gm) || []).length, 1000),
    linkCount: Math.min((content.match(/^\s*- link\b/gm) || []).length, 1000),
    ...(failed ? { errorClass: errorClass(message.error?.message || content) } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function createObserver({ persona, origins, hints = {}, emit, now = () => performance.now() }) {
  const active = new Map();
  const routes = new Map();
  let callOrdinal = 0;
  const safePersona = ['admin', 'full_admin'].includes(persona) ? persona : 'member';
  const originList = Array.isArray(origins) ? origins.map((value) => {
    try { return new URL(value).origin; } catch { return null; }
  }) : [];
  const navigation = (args) => {
    let url;
    try { url = new URL(args?.url); } catch { return {}; }
    const side = url.origin === originList[0] ? 'base'
      : url.origin === originList[1] ? 'head' : 'outside';
    if (side === 'outside') return { side };
    const key = `${url.pathname}${url.search}${url.hash}`;
    if (!routes.has(key) && routes.size < 1000) routes.set(key, routes.size + 1);
    const checkRank = Array.isArray(hints.declaredPaths) ? hints.declaredPaths.indexOf(key) + 1 : 0;
    const intentStart = Array.isArray(hints.intentPaths) && hints.intentPaths.includes(key);
    return {
      side,
      ...(routes.has(key) ? { routeOrdinal: routes.get(key) } : {}),
      routeHint: checkRank > 0 ? 'declared_check' : intentStart ? 'intent_start' : 'other',
      ...(checkRank > 0 ? { checkRank } : {}),
    };
  };
  return {
    request(line, { truncated } = {}) {
      if (truncated) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const tool = message?.params?.name;
      if (message?.method !== 'tools/call' || message.id == null) return;
      const safeTool = TOOLS.has(tool) ? tool : 'other';
      const call = {
        persona: safePersona, tool: safeTool, callOrdinal: ++callOrdinal,
        ...(safeTool === 'browser_navigate' ? navigation(message.params.arguments) : {}),
        startedAt: now(),
      };
      active.set(JSON.stringify(message.id), call);
      const { startedAt: _privateTime, ...event } = call;
      emit({ kind: 'browser_call_start', ...event });
    },
    response(line, { bytes = 0, truncated = false, tail = '' } = {}) {
      let message = null;
      if (!truncated) { try { message = JSON.parse(line); } catch {} }
      const id = responseId(line, message, tail);
      if (id == null) return;
      const key = JSON.stringify(id);
      const call = active.get(key);
      if (!call) return;
      active.delete(key);
      const { startedAt, ...event } = call;
      emit({ kind: 'browser_call_end', ...event,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        ...resultShape(message, bytes, truncated),
      });
    },
    pending() {
      for (const call of active.values()) {
        const { startedAt, ...event } = call;
        emit({ kind: 'browser_call_pending', ...event,
          durationMs: Math.max(0, Math.round(now() - startedAt)) });
      }
    },
    exit(code, signal) {
      for (const call of active.values()) {
        const { startedAt, ...event } = call;
        emit({ kind: 'browser_call_end', ...event, outcome: 'server_exit',
          durationMs: Math.max(0, Math.round(now() - startedAt)) });
      }
      active.clear();
      emit({ kind: 'browser_server_exit', persona: safePersona,
        outcome: code === 0 ? 'ok' : 'error',
        ...(Number.isInteger(code) ? { exitCode: code } : {}),
        ...(signal === 'SIGTERM' || signal === 'SIGINT' ? { signal } : {}),
      });
    },
  };
}

function start({ persona, args, binary = 'mcp-server-playwright',
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  diagnosticFile = process.env.EVIDENCE_BROWSER_DIAGNOSTIC_FILE,
  origins = JSON.parse(process.env.EVIDENCE_ALLOWED_ORIGINS || '[]'),
  hints = JSON.parse(process.env.EVIDENCE_NAVIGATION_HINTS || '{}'),
} = {}) {
  const emit = (event) => {
    if (!diagnosticFile) return;
    try { fs.appendFileSync(diagnosticFile, `${MARKER}${JSON.stringify(event)}\n`); }
    catch { /* Diagnostics must never prevent evidence navigation. */ }
  };
  const observer = createObserver({ persona, origins, hints, emit });
  const child = spawn(binary, args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* Child exit is reported by the close handler. */ });
  const inputTap = lineTap((line, meta) => observer.request(line, meta));
  stdin.pipe(inputTap).pipe(child.stdin);
  child.stdout.pipe(lineTap((line, meta) => observer.response(line, meta))).pipe(stdout);
  child.stderr.pipe(stderr);
  const pending = setInterval(() => observer.pending(), PENDING_INTERVAL_MS);
  pending.unref?.();
  const signalHandlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', () => { /* close also follows a spawn error. */ });
  child.on('close', (code, signal) => {
    clearInterval(pending);
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    // MCP clients may keep our stdin pipe open after stopping Playwright.
    // Release that handle so the observer exits with its child.
    stdin.unpipe(inputTap);
    inputTap.destroy();
    stdin.pause();
    observer.exit(code, signal);
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
  return child;
}

if (require.main === module) {
  const persona = process.argv[2];
  if (!['member', 'admin', 'full_admin'].includes(persona)) process.exit(2);
  start({ persona, args: process.argv.slice(3) });
}

module.exports = { MARKER, lineTap, createObserver, start };
