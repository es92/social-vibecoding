#!/usr/bin/env node
'use strict';

// Transparent stdio wrapper around Playwright MCP in shots turns. The
// agent's own stream records when a tool call was issued and answered, not
// how long the browser spent on it. This wrapper observes the JSON-RPC
// boundary itself and writes only bounded, content-free diagnostics to a
// worker-local file. The runner tails that file into the shots trace.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const boundary = require('./shots-boundary');
const samples = require('./shots-samples');

const MARKER = '__USERNODE_SHOTS_BROWSER__ ';
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

// The page Playwright says the browser is on. Most tool results carry a
// "### Page" block naming it; a tab list marks the current tab
// (`- 0: (current) [Title](url)`). A screenshot's own result names neither,
// so the observer keeps the last one.
function reportedPageUrl(text) {
  const pages = [...String(text || '').matchAll(/^- Page URL: (\S+)$/gm)];
  if (pages.length) return pages[pages.length - 1][1];
  const current = /^- \d+: \(current\) \[.*\]\((\S+)\)(?: \[[^\]\n]*\])*$/m.exec(String(text || ''));
  return current ? current[1] : null;
}

// Where browser_take_screenshot wrote its file: its answer links it by its
// whole path (`- [Screenshot of viewport](/…/name.png)`, --file-paths
// absolute). Read from the raw line too: a result over the capture limit
// still begins with this text.
function savedScreenshotPath(text) {
  const match = /\[Screenshot of [^\n]*?\]\(([^)"\\\n]+?\.(?:png|jpeg))\)/.exec(String(text || ''));
  return match ? match[1] : null;
}

function createObserver({
  persona, phone = false, origins, hints = {}, emit, now = () => performance.now(),
  outputDir = null, provenance = boundary,
}) {
  // What the shots bridge needs to publish only shots of the app: the site
  // each screenshot was taken on, and every site a recorded session showed.
  let pageUrl = null;
  const sessionOrigins = new Set();
  const notePage = (url) => {
    if (!url) return;
    pageUrl = url;
    const origin = provenance.webOrigin(url);
    if (origin) sessionOrigins.add(origin);
  };
  const insideOutput = (file) => {
    if (!outputDir || !file) return false;
    const resolved = path.resolve(file);
    return path.dirname(resolved) === path.resolve(outputDir);
  };
  const active = new Map();
  const routes = new Map();
  let callOrdinal = 0;
  const safePersona = ['admin', 'full_admin', 'guest'].includes(persona) ? persona : 'member';
  // A persona's phone browser reports as that persona, marked as the phone.
  const browser = { persona: safePersona, ...(phone === true ? { phone: true } : {}) };
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
        ...browser, tool: safeTool, callOrdinal: ++callOrdinal,
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
      const shape = resultShape(message, bytes, truncated);
      emit({ kind: 'browser_call_end', ...event,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        ...shape,
      });
      try {
        const text = message
          ? (Array.isArray(message.result?.content) ? message.result.content : [])
            .filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
          : line;
        if (message) notePage(reportedPageUrl(text));
        const succeeded = shape.outcome === 'ok' || (!message && truncated);
        if (call.tool === 'browser_take_screenshot' && succeeded) {
          const file = savedScreenshotPath(text);
          if (insideOutput(file)) provenance.stampScreenshot(outputDir, path.resolve(file), pageUrl);
        }
        if (call.tool === 'browser_close' && shape.outcome === 'ok') {
          // The session's clip is written as it closes: these are its pages.
          // A close with no page since the last one (a second close) ended no
          // session, and leaves the last record as it was.
          if (outputDir && sessionOrigins.size) provenance.recordSession(outputDir, sessionOrigins);
          sessionOrigins.clear();
          pageUrl = null;
        }
      } catch { /* Provenance that cannot be written is provenance that is missing: the bridge refuses the shot. */ }
    },
    // The browser's answer to a call the shots tools made (startControl):
    // the page it reports is the page the browser is on now.
    noteAnswer(text) {
      try { notePage(reportedPageUrl(text)); } catch { /* the next answer says */ }
    },
    // A close-up or a dark shot the shots tools had this browser save
    // (startControl): it shows the page the browser is on now, so it is
    // stamped with that site, as the agent's own screenshots are.
    stampCloseup(name) {
      try {
        const file = path.join(outputDir || '', path.basename(String(name || '')));
        if (insideOutput(file)) provenance.stampScreenshot(outputDir, file, pageUrl);
      } catch { /* unstamped: the bridge refuses it */ }
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
      emit({ kind: 'browser_server_exit', ...browser,
        outcome: code === 0 ? 'ok' : 'error',
        ...(Number.isInteger(code) ? { exitCode: code } : {}),
        ...(signal === 'SIGTERM' || signal === 'SIGINT' ? { signal } : {}),
      });
    },
  };
}

// A button the pointer was left on is shot in its hover colour: the agent
// clicks "Send code", the page moves on, and the next screenshot shows the
// button pale. Before each browser_take_screenshot that follows a click, the
// observer moves the pointer off the page itself and holds the screenshot
// (and every call after it, in order) until that move is answered; the
// move's answer never reaches the agent. (-1, -1) is outside the viewport,
// so nothing is under the pointer, and it stays so when an element
// screenshot scrolls the page; (0, 0) is a pixel of the page and hovers
// whatever is drawn there. A pointer the agent placed itself (a successful
// browser_hover or browser_mouse_move_xy, with no click since) is left where
// it is: the hover may be the very change being shown. When clips are recorded, the pointer is parked before
// browser_close too, so a clip's last frames are not hovered either.
const PARK_TIMEOUT_MS = 12_000;
const PARK_TOMBSTONE_MS = 60_000;
const PARK_TOMBSTONE_MAX = 32;
const PARK_HELD_LINE_MAX_BYTES = 8 * 1024 * 1024;
const PARSED_ANSWER_MAX_BYTES = 1024 * 1024;
// How long a shots tool's own call in the browser may take (an upload waits
// for the page to settle after the files are chosen).
const INJECT_TIMEOUT_MS = 30_000;
const POINTER_LEFT_ON_PAGE = new Set([
  'browser_click', 'browser_drag', 'browser_drop', 'browser_mouse_click_xy', 'browser_mouse_drag_xy',
  'browser_mouse_down', 'browser_mouse_up',
]);
const POINTER_PLACED = new Set(['browser_hover', 'browser_mouse_move_xy']);
const ANY_ID = /"id"\s*:\s*(?:"([^"\\]{1,120})"|(-?\d{1,16}))/g;

function parkRequest(id) {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'browser_mouse_move_xy',
    arguments: { x: -1, y: -1 },
  } })}\n`);
}

// Splits a byte stream into complete newline-terminated lines without
// decoding it: a character split across two chunks stays whole.
function lineSplitter() {
  let parts = [];
  return {
    push(chunk, onLine) {
      let offset = 0;
      for (;;) {
        const end = chunk.indexOf(10, offset);
        if (end < 0) { if (offset < chunk.length) parts.push(chunk.subarray(offset)); return; }
        parts.push(chunk.subarray(offset, end + 1));
        const line = Buffer.concat(parts);
        parts = [];
        onLine(line);
        offset = end + 1;
      }
    },
    rest() { const line = Buffer.concat(parts); parts = []; return line; },
  };
}

function createPointerParker({
  timeoutMs = PARK_TIMEOUT_MS, parkBeforeClose = false, emit = () => {}, persona = 'member',
  now = () => performance.now(), nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  let leftOnPage = false;
  let parks = 0;
  let waiting = null; // the park move in flight: { id, startedAt, timer }
  const tombstones = new Map(); // timed-out park id -> expiry timer: a late answer is still dropped
  // Calls the shots tools make in this browser (inject), by request id: their
  // answers go back to the caller, never to the agent's own stream.
  const injections = new Map();
  let injected = 0;
  let inputEnded = false;
  // The agent's own hovers and moves still in flight, by request id, with
  // the pointer action they followed: one that succeeds leaves the pointer
  // placed, unless a click came after it.
  const placements = new Map();
  let placementTimer = null;
  let pointerSeq = 0;
  let resume = null;
  let flushed = null;
  let closed = false;
  const queue = []; // { line: Buffer, tool, key, parked }
  const inSplit = lineSplitter();
  const enqueue = (line) => {
    let tool = null;
    let key = null;
    try {
      const message = JSON.parse(line.toString('utf8'));
      if (message?.method === 'tools/call') {
        tool = message.params?.name || null;
        if (message.id != null) key = JSON.stringify(message.id);
      }
    } catch { /* forwarded unchanged */ }
    queue.push({ line, tool, key, parked: false });
  };
  const input = new Transform({
    transform(chunk, _encoding, callback) {
      inSplit.push(chunk, enqueue);
      // While a screenshot waits, the next chunk is not read: what is queued
      // is never more than this one.
      // drain() calls back once this chunk's lines have all gone on.
      resume = callback;
      drain();
    },
    flush(callback) {
      const rest = inSplit.rest();
      if (rest.length) enqueue(rest);
      inputEnded = true;
      flushed = callback;
      drain();
    },
  });
  const bury = (id) => {
    if (tombstones.size >= PARK_TOMBSTONE_MAX) {
      const [oldest, timer] = tombstones.entries().next().value;
      clearTimeout(timer);
      tombstones.delete(oldest);
    }
    const timer = setTimeout(() => tombstones.delete(id), PARK_TOMBSTONE_MS);
    timer.unref?.();
    tombstones.set(id, timer);
  };
  const settlePark = (id, outcome) => {
    if (!waiting || waiting.id !== id) return;
    clearTimeout(waiting.timer);
    const durationMs = Math.max(0, Math.round(now() - waiting.startedAt));
    waiting = null;
    // A move that failed leaves the pointer where it was: the next
    // screenshot tries again. The held screenshot goes ahead either way.
    if (outcome !== 'ok') leftOnPage = true;
    emit({ kind: 'browser_pointer_park', persona, outcome, durationMs });
    drain();
  };
  const settlePlacement = (key, succeeded) => {
    if (!placements.has(key)) return;
    const seq = placements.get(key);
    placements.delete(key);
    if (succeeded && seq === pointerSeq) leftOnPage = false;
    if (!placements.size) { clearTimeout(placementTimer); placementTimer = null; }
    drain();
  };
  const drain = () => {
    if (closed) return;
    while (!waiting && queue.length) {
      const item = queue[0];
      const parksHere = item.tool === 'browser_take_screenshot'
        || (parkBeforeClose && item.tool === 'browser_close');
      if (parksHere && !item.parked) {
        // A hover still in flight decides whether the pointer is placed.
        if (placements.size) {
          if (!placementTimer) {
            placementTimer = setTimeout(() => {
              placementTimer = null;
              placements.clear();
              drain();
            }, timeoutMs);
            placementTimer.unref?.();
          }
          break;
        }
        item.parked = true;
        if (leftOnPage) {
          leftOnPage = false;
          const id = `usernode-shots-park-${nonce}-${++parks}`;
          const timer = setTimeout(() => { bury(id); settlePark(id, 'timeout'); }, timeoutMs);
          timer.unref?.();
          waiting = { id, startedAt: now(), timer };
          input.push(parkRequest(id));
          continue;
        }
      }
      queue.shift();
      if (POINTER_LEFT_ON_PAGE.has(item.tool)) { leftOnPage = true; pointerSeq += 1; }
      else if (POINTER_PLACED.has(item.tool)) {
        pointerSeq += 1;
        if (item.key) placements.set(item.key, pointerSeq);
      } else if (item.tool === 'browser_close') { leftOnPage = false; pointerSeq += 1; }
      input.push(item.line);
    }
    if (waiting || queue.length) return;
    if (resume) { const next = resume; resume = null; next(); }
    if (flushed) { const done = flushed; flushed = null; done(); }
  };
  const watching = () => !!waiting || tombstones.size > 0 || placements.size > 0 || injections.size > 0;
  // The id of a whole held line that the parker is waiting on, if any. The
  // SDK writes the id after the result, so the last match in the line's
  // tail is read first, then its head; only the ends are copied.
  const watchedKeyOf = (chunks, bytes) => {
    const head = [];
    for (let i = 0, size = 0; i < chunks.length && size < 8192; i += 1) {
      head.push(chunks[i]); size += chunks[i].length;
    }
    const tail = [];
    for (let i = chunks.length - 1, size = 0; i >= 0 && size < 8192; i -= 1) {
      tail.unshift(chunks[i]); size += chunks[i].length;
    }
    const texts = bytes <= 16384 ? [Buffer.concat(chunks).toString('utf8')]
      : [Buffer.concat(tail).subarray(-8192).toString('utf8'), Buffer.concat(head).subarray(0, 8192).toString('utf8')];
    for (const text of texts) {
      const matches = [...text.matchAll(ANY_ID)].reverse();
      for (const match of matches) {
        const key = match[1] !== undefined ? JSON.stringify(match[1]) : match[2];
        const id = match[1] !== undefined ? match[1] : null;
        if (id !== null && injections.has(id)) return { injected: id };
        if (id !== null && ((waiting && waiting.id === id) || tombstones.has(id))) return { park: id };
        if (placements.has(key)) return { placement: key };
      }
    }
    return null;
  };
  const failedAnswer = (chunks, bytes) => {
    if (bytes > PARSED_ANSWER_MAX_BYTES) return null;
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return message.error ? 'rpc_error' : message.result?.isError === true ? 'tool_error' : 'ok';
    } catch { return 'unparsed'; }
  };
  // An injected call's answer, for its caller: how it ended and its text.
  const injectedAnswer = (chunks) => {
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const blocks = Array.isArray(message.result?.content) ? message.result.content : [];
      return {
        outcome: message.error ? 'rpc_error' : message.result?.isError === true ? 'tool_error' : 'ok',
        text: message.error ? String(message.error.message || '')
          : blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n'),
      };
    } catch { return { outcome: 'unparsed', text: '' }; }
  };
  const settleInjection = (id, answer) => {
    const entry = injections.get(id);
    if (!entry) return;
    injections.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(answer);
  };
  // While a park move or the agent's own hover is in flight, each answer
  // line is held whole until its id is known; otherwise lines stream
  // through. A park answer (a mouse move's) is a few KB, so a line past the
  // cap cannot be one in practice: it streams on, and the diagnostics say so.
  let held = [];
  let heldBytes = 0;
  let passing = false;
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end + 1);
        offset += part.length;
        if (!passing && !held.length && !watching()) passing = true;
        if (passing) {
          this.push(part);
          if (end >= 0) passing = false;
          continue;
        }
        held.push(part);
        heldBytes += part.length;
        if (end < 0) {
          if (heldBytes > PARK_HELD_LINE_MAX_BYTES) {
            for (const piece of held) this.push(piece);
            held = []; heldBytes = 0; passing = true;
            emit({ kind: 'browser_pointer_park', persona, outcome: 'held_line_over_cap' });
          }
          continue;
        }
        const chunks = held;
        const bytes = heldBytes;
        held = []; heldBytes = 0;
        const watched = watchedKeyOf(chunks, bytes);
        if (watched?.injected) {
          settleInjection(watched.injected, injectedAnswer(chunks));
          continue;
        }
        if (watched?.park) {
          const id = watched.park;
          if (tombstones.has(id)) { clearTimeout(tombstones.get(id)); tombstones.delete(id); }
          settlePark(id, failedAnswer(chunks, bytes) || 'unparsed');
          continue;
        }
        for (const piece of chunks) this.push(piece);
        if (watched?.placement) {
          // An answer too large to read is a snapshot, which a success carries.
          const outcome = failedAnswer(chunks, bytes);
          settlePlacement(watched.placement, outcome === null || outcome === 'ok');
        }
      }
      callback();
    },
    flush(callback) {
      for (const piece of held) this.push(piece);
      held = [];
      callback();
    },
  });
  return {
    input, output,
    // One tool call of the shots tools' own (an upload of a sample file),
    // queued behind the agent's calls already waiting. Its answer goes to the
    // returned promise and never to the agent's stream; one that does not
    // come within `limitMs` is dropped when it does.
    inject(name, args = {}, { limitMs = INJECT_TIMEOUT_MS } = {}) {
      if (closed || inputEnded) return Promise.resolve({ outcome: 'browser_gone', text: '' });
      const id = `usernode-shots-control-${nonce}-${++injected}`;
      return new Promise((resolve) => {
        // Kept referenced: its caller waits on it. close() clears it.
        const timer = setTimeout(() => {
          injections.delete(id);
          bury(id);
          resolve({ outcome: 'timeout', text: '' });
        }, limitMs);
        injections.set(id, { resolve, timer });
        queue.push({
          line: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
            params: { name, arguments: args } })}\n`),
          tool: name, key: JSON.stringify(id), parked: false,
        });
        drain();
      });
    },
    // The browser is gone: stop waiting, and send nothing more.
    close() {
      closed = true;
      if (waiting) clearTimeout(waiting.timer);
      clearTimeout(placementTimer);
      waiting = null;
      placements.clear();
      queue.length = 0;
      for (const timer of tombstones.values()) clearTimeout(timer);
      tombstones.clear();
      for (const id of [...injections.keys()]) settleInjection(id, { outcome: 'browser_gone', text: '' });
    },
  };
}

// ── The shots tools' way into this browser ─────────────────────────────
//
// The agent's own file tool stays blocked (run-cc.sh): it would hand a page
// any file on the worker, the browsers' signed-in storage state among them.
// A page that asks for a file is answered through the shots bridge's
// upload_file instead, which asks this observer over a socket of its own in
// SHOTS_BROWSER_CONTROL_DIR (a directory only the worker's own user can
// open), with the turn's control token. The observer chooses the files
// itself, by name from the sample set (shots-samples.js), and sends the
// browser the upload the agent cannot: the page gets a sample or nothing.
const CONTROL_LINE_MAX_BYTES = 4096;
// How long a page switched to dark mode is given to repaint before its dark
// shot (an `action: 'dark'`), in seconds.
const DARK_SETTLE_SECONDS = 0.6;
const CONTROL_ANSWER_MAX_CHARS = 200_000;

function sameToken(value, expected) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

// A close-up (patch-playwright-mcp.js `closeup`): a region of the
// screen at a density, saved under a name the observer chooses.
const CLOSEUP_MAX_SCALE = 16;
function closeupArgs(message) {
  const rect = message?.rect || {};
  const scale = Number(message?.scale);
  const ok = ['x', 'y', 'w', 'h'].every((key) => Number.isSafeInteger(rect[key]) && rect[key] >= 0 && rect[key] <= 20000)
    && rect.w > 0 && rect.h > 0 && scale > 1 && scale <= CLOSEUP_MAX_SCALE;
  return ok ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: Math.round(scale * 10) / 10 } : null;
}

function startControl({ dir, name, token, samplesDir, parker, emit = () => {}, browser = {}, onAnswer = null, onCloseup = null }) {
  if (!dir || !/^[0-9a-f]{64}$/.test(String(token || ''))
      || !/^(member|admin|full_admin|guest)(_phone)?$/.test(String(name || ''))) return null;
  const socketPath = path.join(dir, `${name}.sock`);
  try { fs.unlinkSync(socketPath); } catch { /* none left over */ }
  const handle = async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return { ok: false, code: 'invalid_request' }; }
    if (!sameToken(message?.token, token)) return { ok: false, code: 'forbidden' };
    if (message.action === 'closeup') {
      const closeup = closeupArgs(message);
      if (!closeup) return { ok: false, code: 'invalid_closeup' };
      const file = `closeup-${crypto.randomBytes(8).toString('hex')}.png`;
      const answer = await parker.inject('browser_take_screenshot', { filename: file, closeup });
      emit({ kind: 'closeup', ...browser, outcome: answer.outcome });
      if (answer.outcome !== 'ok') return { ok: false, code: 'closeup_failed', outcome: answer.outcome };
      try { onCloseup?.(file); } catch { /* unstamped: refused later */ }
      return { ok: true, file };
    }
    if (message.action === 'dark') {
      // The screen as it stands, in dark mode (#6787): the page's
      // prefers-color-scheme switched where it is, so the shot has its light
      // one's framing with no second navigation, then switched back before
      // anything else runs in this browser. A page that follows only a URL
      // parameter does not change, and Homeroom says so (sameAsLight).
      const file = `dark-${crypto.randomBytes(8).toString('hex')}.png`;
      const on = await parker.inject('browser_emulate_media', { colorScheme: 'dark' });
      if (on.outcome !== 'ok') {
        emit({ kind: 'dark_shot', ...browser, outcome: on.outcome });
        return { ok: false, code: 'dark_unavailable', outcome: on.outcome };
      }
      let shot = { outcome: 'not_taken' };
      let restored = { outcome: 'not_taken' };
      try {
        // Colours that ease from one mode to the other settle first.
        await parker.inject('browser_wait_for', { time: DARK_SETTLE_SECONDS });
        shot = await parker.inject('browser_take_screenshot', { filename: file });
      } finally {
        restored = await parker.inject('browser_emulate_media', { colorScheme: 'light' });
      }
      emit({ kind: 'dark_shot', ...browser, outcome: shot.outcome, ...(restored.outcome !== 'ok' ? { restored: restored.outcome } : {}) });
      if (shot.outcome !== 'ok') {
        return { ok: false, code: 'dark_failed', outcome: shot.outcome, lightRestored: restored.outcome === 'ok' };
      }
      try { onCloseup?.(file); } catch { /* unstamped: refused later */ }
      return { ok: true, file, lightRestored: restored.outcome === 'ok' };
    }
    if (message.action !== 'upload') return { ok: false, code: 'unknown_action' };
    let paths;
    try { paths = samples.samplePaths(message.files, samplesDir); }
    catch (error) { return { ok: false, code: error.code || 'invalid_sample_files', message: error.message }; }
    // No files closes the chooser without choosing.
    const answer = await parker.inject('browser_file_upload', paths.length ? { paths } : {});
    emit({ kind: 'sample_upload', ...browser, outcome: answer.outcome, count: paths.length });
    try { onAnswer?.(answer); } catch { /* the answer still goes back */ }
    return { ok: answer.outcome === 'ok', outcome: answer.outcome, text: answer.text.slice(0, CONTROL_ANSWER_MAX_CHARS) };
  };
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* the caller went away */ });
    socket.setTimeout(INJECT_TIMEOUT_MS + 15_000, () => socket.destroy());
    let data = Buffer.alloc(0);
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end < 0 || end > CONTROL_LINE_MAX_BYTES) {
        if (end > CONTROL_LINE_MAX_BYTES || data.length > CONTROL_LINE_MAX_BYTES) socket.destroy();
        return;
      }
      socket.off('data', onData);
      handle(data.subarray(0, end).toString('utf8'))
        .catch(() => ({ ok: false, code: 'control_failed' }))
        .then((answer) => { if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`); });
    };
    socket.on('data', onData);
  });
  server.on('error', () => { /* no control: upload_file says the browser cannot be reached */ });
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* the directory is private anyway */ }
  });
  // The observer still exits with its browser.
  server.unref();
  return {
    socketPath,
    close() {
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    },
  };
}

// The Playwright MCP command. The worker image's own install unless the
// local dry run names another (scripts/shots-dry-run.js), as a JSON array.
function browserCommand(value = process.env.SHOTS_BROWSER_MCP_COMMAND) {
  try {
    const parsed = JSON.parse(value || 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every((part) => typeof part === 'string' && part)) {
      return parsed;
    }
  } catch { /* fall through to the installed server */ }
  return ['playwright-mcp'];
}

function start({ persona, phone = false, args, binary = null,
  recordsClips = process.env.SHOTS_RECORD_CLIPS === '1',
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  diagnosticFile = process.env.SHOTS_BROWSER_DIAGNOSTIC_FILE,
  origins = JSON.parse(process.env.SHOTS_ALLOWED_ORIGINS || '[]'),
  hints = JSON.parse(process.env.SHOTS_NAVIGATION_HINTS || '{}'),
  controlDir = process.env.SHOTS_BROWSER_CONTROL_DIR,
  controlToken = process.env.SHOTS_BROWSER_CONTROL_TOKEN,
  samplesDir = process.env.SHOTS_SAMPLES_DIR || samples.SAMPLES_DIR,
} = {}) {
  const emit = (event) => {
    if (!diagnosticFile) return;
    try { fs.appendFileSync(diagnosticFile, `${MARKER}${JSON.stringify(event)}\n`); }
    catch { /* Diagnostics must never prevent shots navigation. */ }
  };
  const list = args || [];
  const outputAt = list.indexOf('--output-dir');
  const outputDir = outputAt >= 0 ? list[outputAt + 1] || null : null;
  const observer = createObserver({ persona, phone, origins, hints, emit, outputDir });
  const [command, ...prefix] = binary ? [binary] : browserCommand();
  // In the read-only samples directory: the server's workspace root
  // (--ignore-roots), so the only files a page can be handed are the samples
  // upload_file names (the agent's own file tools are denied).
  const child = spawn(command, [...prefix, ...list], {
    stdio: ['pipe', 'pipe', 'pipe'], ...(samplesDir && fs.existsSync(samplesDir) ? { cwd: samplesDir } : {}),
  });
  child.stdin.on('error', () => { /* Child exit is reported by the close handler. */ });
  const inputTap = lineTap((line, meta) => observer.request(line, meta));
  const safePersona = ['admin', 'full_admin', 'guest'].includes(persona) ? persona : 'member';
  const parker = createPointerParker({
    emit, persona: safePersona,
    parkBeforeClose: recordsClips,
  });
  const control = startControl({
    dir: controlDir, name: `${safePersona}${phone === true ? '_phone' : ''}`, token: controlToken,
    samplesDir, parker, emit, browser: { persona: safePersona, ...(phone === true ? { phone: true } : {}) },
    onAnswer: (answer) => observer.noteAnswer(answer.text),
    onCloseup: (file) => observer.stampCloseup(file),
  });
  stdin.pipe(inputTap).pipe(parker.input).pipe(child.stdin);
  child.stdout.pipe(parker.output)
    .pipe(lineTap((line, meta) => observer.response(line, meta))).pipe(stdout);
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
    parker.close();
    control?.close();
    stdin.pause();
    observer.exit(code, signal);
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
  return child;
}

// The browser this wrapper observes: a persona's (its output directory's
// name), or its phone browser's, `<persona>_phone` (write-shots-mcp-config.js).
function browserName(value) {
  const match = /^(member|admin|full_admin|guest)(_phone)?$/.exec(String(value || ''));
  return match ? { persona: match[1], phone: !!match[2] } : null;
}

if (require.main === module) {
  const browser = browserName(process.argv[2]);
  if (!browser) process.exit(2);
  start({ ...browser, args: process.argv.slice(3) });
}

module.exports = {
  MARKER, lineTap, createObserver, createPointerParker, startControl, closeupArgs, start, reportedPageUrl, savedScreenshotPath,
  browserCommand, browserName,
};
