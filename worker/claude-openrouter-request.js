#!/usr/bin/env node
'use strict';

// Claude Code over OpenRouter (#3296). Some OpenRouter models do better in
// Claude Code than in Codex, so the platform can run an OpenRouter turn with
// the `claude` CLI instead. OpenRouter serves Anthropic's Messages API, and
// Claude Code honours ANTHROPIC_BASE_URL, but pointing the CLI straight at
// OpenRouter would put the user's key in Claude Code's own environment, where
// every Bash command the agent runs inherits it.
//
// So this wrapper does what worker/codex-openrouter-request.js does for
// Codex: a listener on 127.0.0.1, alive for one invocation, holds the turn's
// key and forwards to the configured provider. There is no platform relay.
// Claude Code gets the listener's address and a random per-invocation token;
// the key is removed from its environment, and the key and the Homeroom
// grant are scrubbed from everything it prints.
//
// The listener also enforces what the platform chose for the turn: every
// request is pinned to the session's model (Claude Code's background calls
// ask for a Haiku alias, which would bill a different model to the user's
// key), a reply is capped at the model's catalog output limit, images and
// PDFs are replaced with a note unless the catalog lists that input for the
// model, an image inside a tool result is moved after the tool results for a
// model that is not Anthropic's, the session's thinking level is applied,
// and Claude Code's Anthropic-only web search is swapped for OpenRouter's own.
//
//   node claude-openrouter-request.js <claude arguments...>
//
// Env: OPENROUTER_API_KEY, AGENT_MODEL (required); OPENROUTER_API_BASE,
// AGENT_MODEL_MAX_OUTPUT_TOKENS, AGENT_MODEL_CONTEXT_WINDOW,
// AGENT_REASONING_EFFORT, HOMEROOM_MCP_TOKEN, AGENT_MODEL_SUPPORTS_IMAGES,
// AGENT_MODEL_SUPPORTS_FILES, MODE (optional).

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { constants: { signals } } = require('node:os');
const { performance } = require('node:perf_hooks');

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
// The only request headers that carry meaning upstream. Everything else
// Claude Code sends (its own client identity, the local token) stays here.
const FORWARDED_REQUEST_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta'];
const ROUTES = new Map([
  ['/v1/messages', '/messages'],
  ['/v1/messages/count_tokens', '/messages/count_tokens'],
]);

async function readBounded(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// What one request came to (G, 2026-10-05): its status, the ids that find
// it in OpenRouter's own log, the upstream provider when OpenRouter names
// it, and an error's type and message. Never the request's or reply's
// content. A 400 "tool messages must include a non-empty string
// tool_call_id" on 2026-10-04 could not be traced to a provider without it.
const MAX_OUTCOME_SCAN_BYTES = 64 * 1024;
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,160}$/;
const SAFE_PROVIDER = /^[a-zA-Z0-9 ._:/()-]{1,80}$/;
const SAFE_ERROR_TYPE = /^[a-z0-9_.-]{1,64}$/i;

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function safeProvider(value) {
  return typeof value === 'string' && SAFE_PROVIDER.test(value) ? value : null;
}

// One error envelope, Anthropic's ({ type: 'error', error: { type, message } })
// or OpenRouter's ({ error: { message, code, metadata: { provider_name } } }),
// as the fields an outcome carries. The message is clipped and redacted.
function errorFields(parsed, redact) {
  const error = parsed?.type === 'error' ? parsed.error : parsed?.error;
  if (!error || typeof error !== 'object') return {};
  const out = {};
  const type = typeof error.type === 'string' ? error.type
    : (error.code != null ? String(error.code) : null);
  if (type && SAFE_ERROR_TYPE.test(type)) out.errorType = type;
  if (typeof error.message === 'string' && error.message) {
    out.errorMessage = redact(error.message).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
  }
  const provider = safeProvider(error.metadata?.provider_name);
  if (provider) out.providerName = provider;
  return out;
}

// The token counts a reply reports, in Anthropic's split (input excludes
// cache reads and writes), or null. A stream reports them twice: on
// message_start, where OpenRouter's input is still 0, and in full on the
// closing message_delta. Counts only.
const USAGE_FIELDS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['cache_creation_input_tokens', 'cacheWriteInputTokens'],
]);

function usageFields(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  for (const [from, to] of USAGE_FIELDS) {
    if (Number.isSafeInteger(usage[from]) && usage[from] >= 0) out[to] = usage[from];
  }
  return Object.keys(out).length ? out : null;
}

// Both reports of one reply, the larger of each count: they are running
// totals, so the closing one is never smaller.
function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, value);
  return out;
}

// What a reply body says about itself: its message (generation) id and the
// provider OpenRouter routed it to, from a JSON reply or the first event of
// a stream, its token counts, and an error envelope wherever one appears.
// Fields only.
function replyFields(parsed, redact) {
  if (!parsed || typeof parsed !== 'object') return {};
  if (parsed.type === 'error' || (parsed.error && typeof parsed.error === 'object')) return errorFields(parsed, redact);
  if (parsed.type === 'message_delta') {
    const usage = usageFields(parsed.usage);
    return usage ? { usage } : {};
  }
  const message = parsed.type === 'message_start' ? parsed.message : parsed;
  const out = {};
  const id = safeId(message?.id);
  if (id) out.generationId = id;
  const provider = safeProvider(message?.provider ?? parsed.provider);
  if (provider) out.providerName = provider;
  const usage = usageFields(message?.usage);
  if (usage) out.usage = usage;
  return out;
}

// Pass a reply through unchanged while reading what replyFields needs from
// it: a small JSON body whole, or a stream's message_start, message_delta and
// error events.
// Only one event's text is held at a time, and an event longer than
// MAX_OUTCOME_SCAN_BYTES is dropped unread; the bytes always flow on.
async function* observeOutcome(body, { streaming, onFields, redact }) {
  let text = '';
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (streaming) {
      text += Buffer.from(chunk).toString();
      let at;
      while ((at = text.search(/\r?\n\r?\n/)) >= 0) {
        const event = text.slice(0, at);
        text = text.slice(at).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (data && data.length <= MAX_OUTCOME_SCAN_BYTES
            && (data.includes('"message_start"') || data.includes('"message_delta"') || data.includes('"error"'))) {
          try { onFields(replyFields(JSON.parse(data), redact)); } catch { /* Not JSON: passes through. */ }
        }
      }
      if (text.length > MAX_OUTCOME_SCAN_BYTES) text = '';
    } else if (bytes <= MAX_OUTCOME_SCAN_BYTES) {
      text += Buffer.from(chunk).toString();
    }
    yield chunk;
  }
  if (!streaming && bytes <= MAX_OUTCOME_SCAN_BYTES && text) {
    try { onFields(replyFields(JSON.parse(text), redact)); } catch { /* Not JSON. */ }
  }
}

// Anthropic's error envelope, so Claude Code reports a refusal in its own
// words instead of failing to parse one.
function replyError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function sameSecret(presented, expected) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function presentedToken(headers) {
  if (typeof headers['x-api-key'] === 'string') return headers['x-api-key'];
  const auth = headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// The platform gives an OpenRouter model text only unless OpenRouter lists
// image input for it (#3426: AGENT_MODEL_SUPPORTS_IMAGES, as Codex's model
// catalog declares it). Claude Code would otherwise send a screenshot or an
// image it Read as an image block, which a text-only model refuses and which
// fails the whole request. A PDF arrives the same way as a document block,
// and is passed through only when OpenRouter lists file input for the model
// (#3557: AGENT_MODEL_SUPPORTS_FILES): image input says nothing about it.
const NON_TEXT_BLOCKS = new Map([
  ['image', '[image omitted: this model reads text only]'],
  ['document', '[document omitted: this model reads text only]'],
]);

// `counts` tallies the request's images for its result line (worker.js sums
// them per turn): `sent` reach the model, `omitted` became the note above,
// and `moved` (below) counts the sent ones moved out of a tool result.
function textOnly(blocks, { images = false, documents = false, counts = null } = {}) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (images && block.type === 'image') {
      if (counts) counts.sent += 1;
      return block;
    }
    if (documents && block.type === 'document') return block;
    if (NON_TEXT_BLOCKS.has(block.type)) {
      if (counts && block.type === 'image') counts.omitted += 1;
      return { type: 'text', text: NON_TEXT_BLOCKS.get(block.type) };
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: textOnly(block.content, { images, documents, counts }) };
    }
    return block;
  });
}

// An image inside a tool result, for a model OpenRouter does not run as
// Anthropic. Claude Code's Read and the browser's screenshot tool both return
// their image inside a tool_result. Another provider's hosts take OpenAI's
// chat format (the 2026-10-04 refusal above, about "tool messages", came from
// one), where a tool message is, for OpenAI and many hosts, text only, and
// the image appears not to survive the trip: a GLM 5.3 Flash build (App
// bench studio run 8, trial 1236) said its screenshot "returns empty" and
// began decoding the PNG by hand. An image in a user message's own content is
// an ordinary image part in that format. So each one is moved out of its tool
// result, a pointer left in its place, and added after the message's last
// tool_result (Anthropic's rule: tool results come first), labelled with the
// result it came from, in order. Anthropic's models read images in tool
// results, so theirs stay where they are.
//
// Every request carries the whole conversation, so an early screenshot is
// moved again on each later request, the same way each time: this is a pure
// function of the messages, and the prefix a provider caches stays the same
// from one request to the next. Old images are not pruned for the same
// reason: dropping one would rewrite an earlier message, and every request
// after it would miss the cache from there on.
const ANTHROPIC_MODEL = /^~?anthropic\//;

function toolUseNames(messages) {
  const names = new Map();
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
}

function imagesAfterToolResults(content, toolNames, counts) {
  let lastResult = -1;
  content.forEach((block, index) => { if (block?.type === 'tool_result') lastResult = index; });
  const after = [];
  const rewritten = content.map((block) => {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)
        || !block.content.some((part) => part?.type === 'image')) return block;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
    const name = id && toolNames.get(id);
    const from = `${name ? `the ${name} result` : 'the tool result'}${id ? ` (${id})` : ''}`;
    let n = 0;
    return {
      ...block,
      content: block.content.map((part) => {
        if (part?.type !== 'image') return part;
        n += 1;
        after.push({ type: 'text', text: `[image ${n} of ${from}:]` }, part);
        return { type: 'text', text: `[image ${n} of this result follows after the tool results]` };
      }),
    };
  });
  if (!after.length) return content;
  counts.moved += after.length / 2;
  return [...rewritten.slice(0, lastResult + 1), ...after, ...rewritten.slice(lastResult + 1)];
}

// Every tool result paired with its call by a non-empty id. OpenRouter turns
// a non-Anthropic model's request into OpenAI's chat format, where each
// tool_result becomes a `tool` message whose tool_call_id is the result's
// tool_use_id, and a host refuses the whole request when one is empty: "400
// messages[N]: tool messages must include a non-empty string tool_call_id"
// (gas-lock-07613b 2026-10-04, familystories-84cefe 2026-10-09, GLM). The
// empty id comes from the model itself: a tool call it streamed with no id
// is kept by Claude Code as id "", and so is the result it sends back, so
// every later request in the turn is refused.
//
// So a tool_use whose id is missing or blank gets one made from its place
// in the conversation (message and block index), and a result with a
// missing or blank id takes the next call of the assistant message just
// before it that no result has answered yet, in order, which is how Claude
// Code sends them. Such a result with no call left to take (an orphan,
// which would be refused the same way) becomes a text block saying what it
// was, so its words still reach the model. A result whose id is set is
// never touched. Like the images above, this is a pure
// function of the messages: an id made for an early call is the same on
// every later request, and a conversation with nothing to repair is
// returned as it came.
const MADE_TOOL_ID_PREFIX = 'toolu_hr_';

function hasToolId(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '[non-text content]'))
    .join('\n');
}

function pairToolIds(messages) {
  let changed = false;
  // The calls of the latest assistant message no result has answered yet.
  let open = [];
  const out = messages.map((message, m) => {
    if (!message || !Array.isArray(message.content)) {
      open = [];
      return message;
    }
    if (message.role === 'assistant') {
      let rewritten = false;
      const content = message.content.map((block, b) => {
        if (block?.type !== 'tool_use' || hasToolId(block.id)) return block;
        rewritten = true;
        return { ...block, id: `${MADE_TOOL_ID_PREFIX}${m}_${b}` };
      });
      open = content.filter((block) => block?.type === 'tool_use').map((block) => block.id);
      if (!rewritten) return message;
      changed = true;
      return { ...message, content };
    }
    if (message.role !== 'user') return message;
    let rewritten = false;
    const content = message.content.map((block) => {
      if (block?.type !== 'tool_result') return block;
      if (hasToolId(block.tool_use_id)) {
        const at = open.indexOf(block.tool_use_id);
        if (at !== -1) open.splice(at, 1);
        return block;
      }
      rewritten = true;
      if (!open.length) {
        const said = toolResultText(block);
        return { type: 'text', text: `[a tool result that answers no tool call${said ? `:\n${said}` : ''}]` };
      }
      return { ...block, tool_use_id: open.shift() };
    });
    // Results answer only the assistant message right before them.
    open = [];
    if (!rewritten) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}

// The platform's effort scale (minimal … xhigh) plus Anthropic's `max`.
// OpenRouter translates each onto the model's own reasoning levels.
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Claude Code's WebSearch is Anthropic's server-side search tool
// (`web_search_20250305` and its successors), which only Anthropic runs.
// OpenRouter has its own server-side search, `openrouter:web_search`, on the
// same Messages API and for any model. Swap one for the other, so WebSearch
// works on an OpenRouter model. Codex never had search here: its catalog
// declares none. Claude Code sends this tool only on its own WebSearch
// sub-request, so a surprise in OpenRouter's reply fails that one search
// rather than the turn. Each search is billed to the key (about $0.007 with
// Exa, OpenRouter's fallback engine for models without native search), so
// the searches per call are capped.
const ANTHROPIC_WEB_SEARCH = /^web_search_\d{8}$/;
const WEB_SEARCH_MAX_USES = 5;

function openRouterWebSearch(tool) {
  const maxUses = Number.isSafeInteger(tool.max_uses) && tool.max_uses > 0
    ? Math.min(tool.max_uses, WEB_SEARCH_MAX_USES)
    : WEB_SEARCH_MAX_USES;
  const parameters = { max_uses: maxUses };
  // Anthropic's `blocked_domains` is OpenRouter's `excluded_domains`; like
  // Anthropic, OpenRouter takes one list or the other, never both.
  if (Array.isArray(tool.allowed_domains) && tool.allowed_domains.length) {
    parameters.allowed_domains = tool.allowed_domains;
  } else if (Array.isArray(tool.blocked_domains) && tool.blocked_domains.length) {
    parameters.excluded_domains = tool.blocked_domains;
  }
  return { type: 'openrouter:web_search', parameters };
}

// Which of a model's hosts OpenRouter tries first (provider routing). Left
// to itself it balances by price, and its prompt-cache stickiness then keeps
// a turn on whichever host the turn's first request landed on. A GLM build on
// 2026-10-06 landed on a host averaging 44 s a request, against 7 s on the
// host that served the same build again, and ran out its 40 minutes before
// it ever opened the in-loop browser. These preferences only reorder: a host
// whose time to first token is over 15 s at p90, or whose median output is
// under 30 tokens a second, over OpenRouter's last few minutes, is tried after
// the hosts that meet them, never excluded, and price still decides among
// the rest. Kept in step with the other OpenRouter listener (tests pin it).
const PROVIDER_PREFERENCES = Object.freeze({
  preferred_max_latency: Object.freeze({ p90: 15 }),
  preferred_min_throughput: Object.freeze({ p50: 30 }),
});

// Pair every tool result with its call, pin the model, cap the reply, keep
// the input text, set the thinking level, prefer hosts that answer
// promptly, and route web search to OpenRouter.
// Exported for tests: this is the policy. `imageCounts`, when given, is
// filled with what the request did with its images.
function applyTurnPolicy(body, {
  model, maxOutputTokens, countTokens, reasoningEffort = null, imageInput = false, documentInput = false,
  imageCounts = null,
}) {
  body.model = model;
  if (Array.isArray(body.messages)) body.messages = pairToolIds(body.messages);
  if (Array.isArray(body.messages)) {
    const images = imageInput === true;
    const counts = imageCounts || { sent: 0, moved: 0, omitted: 0 };
    const moveImages = images && !ANTHROPIC_MODEL.test(String(model));
    const toolNames = moveImages ? toolUseNames(body.messages) : null;
    body.messages = body.messages.map((message) => {
      if (!message || !Array.isArray(message.content)) return message;
      const content = textOnly(message.content, { images, documents: documentInput === true, counts });
      return {
        ...message,
        content: moveImages && message.role === 'user' ? imagesAfterToolResults(content, toolNames, counts) : content,
      };
    });
  }
  if (countTokens) return body;
  // Any preference the request already carries is kept.
  const asked = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider) ? body.provider : {};
  body.provider = { ...PROVIDER_PREFERENCES, ...asked };
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => (tool && typeof tool.type === 'string' && ANTHROPIC_WEB_SEARCH.test(tool.type)
      ? openRouterWebSearch(tool)
      : tool));
  }
  // The thinking level. On OpenRouter's Messages API `output_config.effort`
  // becomes the model's own reasoning effort, and it outranks an adaptive or
  // budgeted `thinking`. `thinking: disabled` would still switch reasoning
  // off for a non-Anthropic model, so it goes when an effort is set.
  if (REASONING_EFFORTS.has(reasoningEffort)) {
    const config = body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config)
      ? body.output_config
      : {};
    body.output_config = { ...config, effort: reasoningEffort };
    if (body.thinking?.type === 'disabled') delete body.thinking;
  }
  if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) {
    const asked = body.max_tokens;
    body.max_tokens = Number.isSafeInteger(asked) && asked > 0
      ? Math.min(asked, maxOutputTokens)
      : maxOutputTokens;
  }
  // Anthropic's rule: the thinking budget must sit below max_tokens. A cap
  // that lands under it would turn every request into a 400, so drop the
  // explicit budget and let the model think at its own default instead.
  const budget = body.thinking?.budget_tokens;
  if (Number.isSafeInteger(budget) && Number.isSafeInteger(body.max_tokens)
      && budget >= body.max_tokens) {
    delete body.thinking;
  }
  return body;
}

async function startMessagesAdapter({
  baseUrl, apiKey, model, maxOutputTokens = null, reasoningEffort = null, localToken,
  onTiming = null, timingIntervalMs = 15_000, fetchImpl = fetch, imageInput = false, documentInput = false,
}) {
  const base = new URL(baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid_provider_url');
  }
  if (!apiKey || !model || !localToken) throw new Error('invalid_request_adapter_config');
  const upstreamBase = base.href.replace(/\/+$/, '');
  // An error message is the provider's text: never let the turn's key or the
  // listener's token through, should a provider ever echo a header.
  const redactOutcome = makeRedactor([apiKey, localToken]);
  const active = new Set();
  let requestOrdinal = 0;
  // Each request's start and end also say when they happened (atMs), in ms
  // since this listener started, which is when the turn's agent did. The
  // platform reads the turn's journal again after a restart, so the moment
  // it reads a line is not when the line was written; these stamps are what
  // let it split a turn's time between the model and the tools between
  // requests (worker.js noteCodingRequestClock).
  const listenerStartedAt = performance.now();
  const emitTiming = (event) => {
    if (!onTiming) return;
    try { onTiming(event); } catch { /* Telemetry cannot affect the provider request. */ }
  };

  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    const upstreamPath = ROUTES.get(pathname);
    if (req.method !== 'POST' || !upstreamPath) {
      replyError(res, 404, 'not_found_error', 'Unsupported OpenRouter adapter route');
      return;
    }
    if (!sameSecret(presentedToken(req.headers), localToken)) {
      replyError(res, 401, 'authentication_error', 'OpenRouter adapter authentication failed');
      return;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      replyError(res, 415, 'invalid_request_error', 'Unsupported OpenRouter request encoding');
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    const countTokens = pathname.endsWith('/count_tokens');
    let timing = null;
    try {
      let body;
      try {
        body = JSON.parse((await readBounded(req, MAX_REQUEST_BYTES)).toString());
      } catch {
        replyError(res, 400, 'invalid_request_error', 'Invalid OpenRouter request body');
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        replyError(res, 400, 'invalid_request_error', 'Invalid OpenRouter request body');
        return;
      }
      const images = { sent: 0, moved: 0, omitted: 0 };
      applyTurnPolicy(body, {
        model, maxOutputTokens, countTokens, reasoningEffort, imageInput, documentInput,
        imageCounts: images,
      });
      const serializedBody = JSON.stringify(body);
      if (onTiming && !countTokens) {
        // Sizes and counts only: the request's content never leaves here.
        const ordinal = ++requestOrdinal;
        const startedAt = performance.now();
        timing = { ordinal, startedAt, stage: 'await_headers', status: null,
          responseBytes: 0, chunks: 0, outcome: 'ok', images };
        emitTiming({
          kind: 'provider_request_start', requestOrdinal: ordinal,
          atMs: Math.max(0, Math.round(startedAt - listenerStartedAt)),
          payloadBytes: Buffer.byteLength(serializedBody),
          inputBytes: body.messages == null ? 0 : Buffer.byteLength(JSON.stringify(body.messages)),
          instructionBytes: body.system == null ? 0 : Buffer.byteLength(JSON.stringify(body.system)),
          inputItems: Array.isArray(body.messages) ? body.messages.length : null,
          previousResponseLinked: false,
          maxOutputTokens: body.max_tokens,
        });
        timing.interval = setInterval(() => emitTiming({
          kind: 'provider_request_pending', requestOrdinal: ordinal,
          stage: timing.stage,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        }), timingIntervalMs);
        timing.interval.unref?.();
      }
      const headers = {
        'content-type': 'application/json',
        'accept-encoding': 'identity',
        authorization: `Bearer ${apiKey}`,
      };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const response = await fetchImpl(`${upstreamBase}${upstreamPath}`, {
        method: 'POST', headers, body: serializedBody, redirect: 'error', signal: controller.signal,
      });
      if (timing) {
        timing.status = response.status;
        timing.stage = 'await_first_byte';
        timing.outcome = response.status >= 400 ? 'http_error' : 'ok';
        emitTiming({ kind: 'provider_response_headers', requestOrdinal: timing.ordinal,
          httpStatus: response.status,
          durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
      }
      if (timing) {
        timing.result = {
          requestId: safeId(response.headers.get('x-request-id') || response.headers.get('x-openrouter-request-id')),
        };
      }
      const responseHeaders = {};
      const responseConnectionHeaders = new Set(String(response.headers.get('connection') || '')
        .toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of response.headers) {
        // fetch decodes compressed bodies; do not forward their old length or
        // encoding. Everything else, including provider request ids, survives.
        if (!HOP_HEADERS.has(name) && !responseConnectionHeaders.has(name) && name !== 'content-encoding') {
          responseHeaders[name] = value;
        }
      }
      res.writeHead(response.status, responseHeaders);
      if (!response.body) {
        res.end();
        return;
      }
      let bodyStream = Readable.fromWeb(response.body);
      if (timing) {
        const streaming = /text\/event-stream/i.test(String(response.headers.get('content-type') || ''));
        bodyStream = Readable.from(observeOutcome(bodyStream, {
          streaming,
          redact: redactOutcome,
          onFields: ({ usage, ...fields }) => {
            Object.assign(timing.result, fields);
            if (usage) timing.result.usage = mergeUsage(timing.result.usage, usage);
          },
        }));
        async function* observeTransfer() {
          for await (const chunk of bodyStream) {
            timing.responseBytes += chunk.length;
            timing.chunks += 1;
            if (timing.stage === 'await_first_byte') {
              timing.stage = 'streaming';
              emitTiming({ kind: 'provider_response_first_byte', requestOrdinal: timing.ordinal,
                durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
            }
            yield chunk;
          }
        }
        await pipeline(Readable.from(observeTransfer()), res);
      } else {
        await pipeline(bodyStream, res);
      }
    } catch {
      if (timing) timing.outcome = controller.signal.aborted ? 'cancelled'
        : timing.stage === 'await_headers' ? 'network_error' : 'stream_error';
      if (!res.headersSent && !res.destroyed) replyError(res, 502, 'api_error', 'OpenRouter request transport failed');
      else res.destroy();
    } finally {
      if (timing) {
        clearInterval(timing.interval);
        // What the request came to, before its end: the platform logs a
        // failed one, keeps the provider for the turn's ledger row, and sums
        // the token counts of each that finished, which is what a turn
        // stopped before Claude Code's own total is priced from, and the
        // images each carried, moved or left out, for the turn's metrics.
        emitTiming({
          kind: 'provider_request_result', requestOrdinal: timing.ordinal,
          ...(timing.status != null ? { httpStatus: timing.status } : {}),
          outcome: timing.outcome,
          ...Object.fromEntries(Object.entries(timing.result || {}).filter(([, v]) => v != null)),
          images: timing.images,
        });
        const endedAt = performance.now();
        emitTiming({ kind: 'provider_request_end', requestOrdinal: timing.ordinal,
          atMs: Math.max(0, Math.round(endedAt - listenerStartedAt)),
          outcome: timing.outcome, stage: timing.stage,
          ...(timing.status != null ? { httpStatus: timing.status } : {}),
          durationMs: Math.max(0, Math.round(endedAt - timing.startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        });
      }
      active.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    activeRequestCount() { return active.size; },
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Literal replacement (split/join, never a regex), so a secret containing
// regex metacharacters is scrubbed exactly. Short values are ignored rather
// than turning ordinary words into asterisks.
function makeRedactor(secrets) {
  const list = [...new Set(secrets.filter(v => typeof v === 'string' && v.length >= 8))];
  return line => list.reduce((out, secret) => out.split(secret).join('****'), line);
}

// Claude Code compacts the conversation once its context reaches this many
// tokens, or the model's whole window when that is smaller: the limit Codex
// compacts at (build-codex-model-catalog.js AUTO_COMPACT_TOKEN_LIMIT). An
// OpenRouter model is one Claude Code does not know: an older Claude Code
// compacted only once the provider refused a prompt as too long, which GLM
// 5.3 Flash's 1,310,720-token window never does, and a newer one assumes a
// window of its own. A bot build resent its whole history on every request,
// 0.5 to 1.2 MB each, and 13 of the week's builds to 2026-10-09 ran out of
// time doing it (one, at $5.77, was on its 317th request, of 540 KB).
const AUTO_COMPACT_TOKEN_LIMIT = 200_000;

// Any other provider's model (GLM among them) compacts sooner. Its images are
// sent again on every request (imagesAfterToolResults, never pruned) and
// first-version builds that failed on their clock carried 600 to 870 KB
// requests, so it compacts at 120k. Anthropic's models keep the limit above.
const NON_ANTHROPIC_AUTO_COMPACT_TOKEN_LIMIT = 120_000;

function autoCompactLimit(model) {
  return ANTHROPIC_MODEL.test(String(model || '')) ? AUTO_COMPACT_TOKEN_LIMIT : NON_ANTHROPIC_AUTO_COMPACT_TOKEN_LIMIT;
}

// Claude Code's compaction settings for this turn: the model's real window
// (AGENT_MODEL_CONTEXT_WINDOW, from the catalog) and the window it compacts
// at. A value already in the environment is kept.
function compactionEnv(env, model) {
  const window = Number(env.AGENT_MODEL_CONTEXT_WINDOW);
  const known = Number.isSafeInteger(window) && window > 0;
  const limit = autoCompactLimit(model);
  const out = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(known ? Math.min(window, limit) : limit),
  };
  if (known) out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
  for (const name of Object.keys(out)) if (env[name]) delete out[name];
  return out;
}

// The environment Claude Code runs with. Exported for tests: the key must not
// be in it, and every model alias must resolve to the session's model.
function claudeChildEnv(env, { baseUrl, localToken, model }) {
  const child = { ...env };
  delete child.OPENROUTER_API_KEY;
  delete child.ANTHROPIC_AUTH_TOKEN;
  Object.assign(child, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: localToken,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    // Anthropic-only beta headers mean nothing to another provider and are
    // the usual reason a gateway rejects a Claude Code request.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    ...compactionEnv(env, model),
  });
  return child;
}

async function runClaude(args, env = process.env) {
  const model = env.AGENT_MODEL;
  const maxOutputTokens = Number(env.AGENT_MODEL_MAX_OUTPUT_TOKENS);
  const localToken = crypto.randomBytes(32).toString('hex');
  const adapter = await startMessagesAdapter({
    baseUrl: env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
    model,
    maxOutputTokens: Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    reasoningEffort: env.AGENT_REASONING_EFFORT || null,
    imageInput: env.AGENT_MODEL_SUPPORTS_IMAGES === '1',
    documentInput: env.AGENT_MODEL_SUPPORTS_FILES === '1',
    localToken,
    // The same content-free request timing a Codex turn reports, so a quiet
    // model call shows in the owner's progress log either way.
    onTiming: diagnostic => process.stdout.write(`__USERNODE_CODING_PROVIDER__ ${JSON.stringify(diagnostic)}\n`),
  });
  const redact = makeRedactor([env.OPENROUTER_API_KEY, env.HOMEROOM_MCP_TOKEN]);
  const child = spawn('claude', args, {
    env: claudeChildEnv(env, { baseUrl: adapter.baseUrl, localToken, model }),
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  // Serialize complete lines from both child streams and our diagnostics so
  // a diagnostic cannot land halfway through a large stream-json event.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity })
      .on('line', line => process.stdout.write(`${redact(line)}\n`));
  }
  let killTimer;
  const stop = signal => {
    child.kill(signal);
    killTimer ||= setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signals[signal] ? 128 + signals[signal] : 1)));
    });
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    clearTimeout(killTimer);
    await adapter.close();
  }
}

if (require.main === module) {
  runClaude(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write('__USERNODE_ERROR__ Could not start the OpenRouter request adapter for Claude Code\n');
    process.exitCode = 1;
  });
}

module.exports = {
  startMessagesAdapter, applyTurnPolicy, pairToolIds, makeRedactor, claudeChildEnv, runClaude, replyFields, PROVIDER_PREFERENCES,
  AUTO_COMPACT_TOKEN_LIMIT, NON_ANTHROPIC_AUTO_COMPACT_TOKEN_LIMIT, autoCompactLimit,
};
