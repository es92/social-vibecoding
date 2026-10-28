'use strict';

// The Mayor for OpenRouter sessions (#2809, #2810).
//
// An OpenRouter session used to be a "direct" path: the user's message went
// straight to the coding agent and its last message became the reply. That
// kept the session on one provider, but it also dropped everything the
// Mayor does around a coding run on a Claude session: the one-line plan
// before the agent starts, the plain-English wrap-up after it, the scout
// that writes and revises the SPEC DOC, the clarifying questions and the
// quick-reply pills.
//
// This module gives those sessions the SAME Mayor loop the Claude path runs
// (routes/sessions.js), on the session's own OpenRouter model and the user's
// own OpenRouter key. The session therefore stays single-provider: no
// Anthropic key is read and no Anthropic billing path is resolved.
//
// The route drives the Mayor through `llm.streamChat`, whose request and
// result are Anthropic Messages shapes (content blocks, tool_use /
// tool_result, input_schema tools). `createClient` returns an object with
// the same `streamChat` / `estimateCostCents` / `isEnabled` surface, so the
// route swaps the client and leaves its conversation bookkeeping alone. The
// translation to OpenRouter's Chat Completions API happens here and is pure,
// so it is tested without a network.
//
// The request is non-streaming on purpose, as the shared transport's is
// (services/openrouter.js): an atomic response lets OpenRouter
// fail over to another provider before any partial tool call is exposed.
// The Mayor's replies are 1-4 sentences, so the whole reply arriving at once
// costs the reader very little.

const credentialStore = require('./credential-store');
const agentModels = require('./agent-models');
const managedOpenRouter = require('./openrouter-managed-keys');
const { platformHeaders } = require('./openrouter-client');
const llmTelemetry = require('./llm-telemetry');
const { withoutDocuments } = require('./attachments');
// The coding turns' host routing (PROVIDER_ROUTING_BY_MODEL and its fallback),
// read from the Claude Code listener itself so the chat and both listeners
// route a model alike.
const listenerRouting = require('../../worker/claude-openrouter-request');
// #5123: every OpenRouter request denies data collection.
const { noTrainingProvider, withNoTraining } = require('../../worker/openrouter-privacy');

const DEFAULT_TIMEOUT_MS = 120_000;
// Reasoning models spend part of this on thinking before the visible reply
// and the dispatch prompt, so it is far above what the reply itself needs.
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// The Mayor chats and routes; it does not write code. Low effort keeps a
// reply quick.
const MAYOR_REASONING_EFFORT = 'low';
const REASONING_EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
// Persisted Mayor rows name the model the same way the direct path's reply
// rows and the coding agent's rows do, so model-costs normalizes all three.
const MODEL_LABEL_PREFIX = 'openrouter/';

// The Codex runner gives an OpenRouter model image input only when the
// catalog lists it (#3426, worker/build-codex-model-catalog.js). The Mayor
// follows the same rule: for any other model a picture (a user's attachment,
// or a request's screenshot in a tool result) reaches it as a line, not bytes.
const IMAGE_PLACEHOLDER = '[image attachment omitted: this model reads text only]';
// The line instead when the model takes pictures but the provider refused a
// request that carried some, and it was sent again without them.
const IMAGE_REFUSED_PLACEHOLDER = '[image omitted: the model provider could not read it]';

function isBase64Image(block) {
  return !!block && block.type === 'image' && block.source?.type === 'base64'
    && typeof block.source.media_type === 'string' && typeof block.source.data === 'string';
}

function imagePart(block) {
  return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
}

// #3557: a PDF the user attached reaches the Mayor as an Anthropic document
// block (attachments.js). It is passed on as an OpenRouter file part only
// when the catalog lists file input for the model; otherwise it becomes a
// line naming the file, so no PDF bytes go to a model that cannot read
// them and OpenRouter never falls back to a paid OCR engine.
function documentPlaceholder(block) {
  const title = typeof block?.title === 'string' && block.title.trim() ? block.title.trim() : 'a PDF';
  return `[PDF attachment omitted: ${title} — this model cannot read PDFs]`;
}

function isPdfDocument(block) {
  return !!block && block.type === 'document' && block.source?.type === 'base64'
    && block.source.media_type === 'application/pdf' && typeof block.source.data === 'string';
}

function filePart(block) {
  const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : 'document.pdf';
  return {
    type: 'file',
    file: { filename: title, file_data: `data:application/pdf;base64,${block.source.data}` },
  };
}

class OpenRouterMayorError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = 'OpenRouterMayorError';
    this.code = code;
    this.status = status;
  }
}

function modelLabel(modelId) {
  const id = String(modelId || '').trim();
  return id.startsWith(MODEL_LABEL_PREFIX) ? id : `${MODEL_LABEL_PREFIX}${id}`;
}

function bareModelId(modelId) {
  return String(modelId || '').trim().replace(/^openrouter\//, '');
}

function textOfBlocks(content, imagePlaceholder = IMAGE_PLACEHOLDER) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image') return imagePlaceholder;
    if (block.type === 'document') return documentPlaceholder(block);
    return '';
  }).filter(Boolean).join('\n\n');
}

// Anthropic `system` is a string or an array of text blocks.
function systemText(systemPrompt) {
  return textOfBlocks(systemPrompt).trim();
}

function toolCallArguments(input) {
  try {
    return JSON.stringify(input && typeof input === 'object' ? input : {});
  } catch {
    return '{}';
  }
}

// Anthropic Messages -> OpenAI Chat Completions messages. Pure.
//
// Two shapes need real translation:
//   - an assistant turn's tool_use blocks become `tool_calls` on one
//     assistant message;
//   - a user turn's tool_result blocks become one `tool` message each, and
//     they must come FIRST, straight after the assistant message whose calls
//     they answer. Any text in the same user turn follows as a user message.
// Thinking blocks are the provider's own and never replayed.
//
// With `imageInput`, pictures go to the model as image parts. A `tool`
// message carries text only, so a tool result's pictures (a request's
// screenshots, each after the line that names it) move to the user message
// that follows the results, and the tool message says they are coming.
function toChatMessages(systemPrompt, messages, {
  fileInput = false, imageInput = false, imagePlaceholder = IMAGE_PLACEHOLDER,
} = {}) {
  const out = [];
  const system = systemText(systemPrompt);
  if (system) out.push({ role: 'system', content: system });
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const { role, content } = message;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === 'assistant') {
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      const toolCalls = content
        .filter((block) => block && block.type === 'tool_use' && block.id && block.name)
        .map((block) => ({
          id: String(block.id),
          type: 'function',
          function: { name: String(block.name), arguments: toolCallArguments(block.input) },
        }));
      if (!text && !toolCalls.length) continue;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const rest = [];
    const shown = [];
    for (const block of content) {
      if (block && block.type === 'tool_result') {
        const blocks = Array.isArray(block.content) ? block.content : [];
        const pictures = imageInput ? blocks.filter(isBase64Image) : [];
        let resultText;
        if (pictures.length) {
          const isLabel = (b, i) => b && b.type === 'text' && isBase64Image(blocks[i + 1]);
          blocks.forEach((b, i) => {
            if (!isBase64Image(b)) return;
            if (isLabel(blocks[i - 1], i - 1)) shown.push({ type: 'text', text: blocks[i - 1].text });
            shown.push(imagePart(b));
          });
          resultText = [
            textOfBlocks(blocks.filter((b, i) => !isBase64Image(b) && !isLabel(b, i)), imagePlaceholder),
            pictures.length === 1
              ? '[Homeroom: 1 picture from this result follows after the tool results.]'
              : `[Homeroom: ${pictures.length} pictures from this result follow after the tool results.]`,
          ].filter(Boolean).join('\n\n');
        } else {
          resultText = textOfBlocks(block.content, imagePlaceholder);
        }
        out.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id || ''),
          content: block.is_error ? `Error: ${resultText}` : resultText,
        });
      } else {
        rest.push(block);
      }
    }
    const files = fileInput ? rest.filter(isPdfDocument) : [];
    const own = imageInput ? rest.filter(isBase64Image) : [];
    const text = textOfBlocks(
      rest.filter((block) => !files.includes(block) && !own.includes(block)), imagePlaceholder,
    );
    const parts = [...files.map(filePart), ...own.map(imagePart), ...shown];
    if (parts.length) {
      out.push({
        role: 'user',
        content: [...(text ? [{ type: 'text', text }] : []), ...parts],
      });
    } else if (text) {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

// Anthropic tool definitions -> OpenAI function tools. Only client tools
// (the ones with an input_schema) exist on this surface.
function toChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.input_schema)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.input_schema,
      },
    }));
}

function toChatToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}

// The effort to request: MAYOR_REASONING_EFFORT, or the lowest level above
// it the model advertises when it publishes a list without it. Nothing at
// all for a model the catalog says does not reason.
function reasoningEffortFor(catalogModel) {
  if (catalogModel && catalogModel.supportsReasoning === false) return null;
  const advertised = Array.isArray(catalogModel?.reasoningEfforts)
    ? catalogModel.reasoningEfforts.filter((effort) => REASONING_EFFORT_ORDER.includes(effort))
    : [];
  if (!advertised.length || advertised.includes(MAYOR_REASONING_EFFORT)) return MAYOR_REASONING_EFFORT;
  const floor = REASONING_EFFORT_ORDER.indexOf(MAYOR_REASONING_EFFORT);
  const above = advertised
    .filter((effort) => REASONING_EFFORT_ORDER.indexOf(effort) >= floor)
    .sort((a, b) => REASONING_EFFORT_ORDER.indexOf(a) - REASONING_EFFORT_ORDER.indexOf(b));
  return above[0] || advertised[advertised.length - 1];
}

function hasFileParts(request) {
  return hasParts(request, 'file');
}

function hasParts(request, type) {
  return Array.isArray(request?.messages) && request.messages.some((m) => (
    Array.isArray(m.content) && m.content.some((part) => part && part.type === type)
  ));
}

// `chatMessages`, when given, are messages already in the Chat Completions
// shape, sent as they are after the system prompt instead of translating
// `messages`: for a caller that has to place each part itself (the first
// version's reviewer puts every screenshot right after its caption,
// services/bot-review.js), which toChatMessages does not keep.
// What a request asks of OpenRouter's routing. A model the coding turns
// route to a host shortlist (GLM 5.3 Flash's fast hosts, DeepSeek V4.1 Flash
// 1017's Parasail and InferenceNet), or one the platform's
// OPENROUTER_PROVIDER_SHORTLISTS names (`shortlist`, parseShortlist's
// answer), goes to the same hosts in the same order with the listeners'
// latency and throughput preferences. Left to the price-weighted default, a
// 1017 chat reached the hosts that list leaves out on purpose: Cloudflare,
// rate-limited in bursts and keeping 1017's thinking 2 times of 3, and
// DeepInfra's slow flex tier. Any other model lets OpenRouter choose, as it
// always has. Pure.
function providerFor(model, shortlist = null) {
  const id = bareModelId(model);
  const listed = Object.prototype.hasOwnProperty.call(listenerRouting.PROVIDER_ROUTING_BY_MODEL, id);
  if (!listed && !(Array.isArray(shortlist) && shortlist.length)) return noTrainingProvider({ allow_fallbacks: true });
  return listenerRouting.providerRoutingFor(id, { allow_fallbacks: true }, { shortlist });
}

function buildRequest({
  model, reasoningEffort, systemPrompt, messages, chatMessages: given = null, tools, toolChoice, maxTokens, sessionId,
  fileInput = false, imageInput = false, imagePlaceholder = IMAGE_PLACEHOLDER, providerShortlist = null,
}) {
  const chatTools = toChatTools(tools);
  const chatMessages = Array.isArray(given)
    ? [...toChatMessages(systemPrompt, []), ...given]
    : toChatMessages(systemPrompt, messages, {
      fileInput: fileInput === true, imageInput: imageInput === true, imagePlaceholder,
    });
  const request = {
    model: bareModelId(model),
    messages: chatMessages,
    max_tokens: Number.isInteger(maxTokens) && maxTokens > 0
      ? Math.min(maxTokens, DEFAULT_MAX_OUTPUT_TOKENS)
      : DEFAULT_MAX_OUTPUT_TOKENS,
    stream: false,
    usage: { include: true },
    provider: providerFor(model, providerShortlist),
  };
  if (chatTools.length) {
    request.tools = chatTools;
    const choice = toChatToolChoice(toolChoice);
    if (choice !== undefined) request.tool_choice = choice;
  }
  if (reasoningEffort) request.reasoning = { effort: reasoningEffort };
  // #3557: a PDF is read by the model itself, never by OpenRouter's paid
  // OCR fallback.
  if (chatMessages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'file'))) {
    request.plugins = [{ id: 'file-parser', pdf: { engine: 'native' } }];
  }
  if (sessionId != null && /^[A-Za-z0-9._:-]{1,256}$/.test(String(sessionId))) {
    request.session_id = String(sessionId);
  }
  return request;
}

function parseToolInput(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const STOP_REASONS = Object.freeze({
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
});

// OpenAI Chat Completions response -> the shape llm.streamChat returns. Pure.
function fromChatCompletion(completion, { requestedModel } = {}) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const message = choice?.message || {};
  const text = textOfBlocks(message.content);
  const rawContent = [];
  if (text) rawContent.push({ type: 'text', text });
  const toolUses = [];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  calls.forEach((call, index) => {
    const name = call?.function?.name;
    if (typeof name !== 'string' || !name) return;
    const id = typeof call.id === 'string' && call.id ? call.id : `call_${index + 1}`;
    const input = parseToolInput(call.function.arguments);
    rawContent.push({ type: 'tool_use', id, name, input });
    toolUses.push({ id, name, input });
  });
  const usage = completion?.usage || {};
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const costUsd = Number(usage.cost);
  const served = typeof completion?.model === 'string' && completion.model
    ? completion.model
    : requestedModel;
  return {
    text,
    toolUses,
    stopReason: toolUses.length
      ? 'tool_use'
      : (STOP_REASONS[choice?.finish_reason] || 'end_turn'),
    rawContent,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(Number.isFinite(costUsd) && costUsd >= 0 ? { cost_usd: costUsd } : {}),
    },
    requestedModel: modelLabel(requestedModel),
    servedModel: modelLabel(served),
    fallbackServed: false,
    fallbackBoundary: null,
    stopDetails: null,
  };
}

// Cents, fractional like llm.estimateCostCents. OpenRouter's own figure for
// the call wins; the catalog list price is the fallback; no price at all
// charges nothing rather than a guess.
function estimateCostCents(usage, pricing) {
  if (!usage) return 0;
  const reported = Number(usage.cost_usd);
  if (Number.isFinite(reported) && reported >= 0) return reported * 100;
  const input = Number(pricing?.inputPricePerMillion);
  const output = Number(pricing?.outputPricePerMillion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return 0;
  const dollars = ((Number(usage.input_tokens) || 0) / 1_000_000) * input
    + ((Number(usage.output_tokens) || 0) / 1_000_000) * output;
  return dollars * 100;
}

// Content-free telemetry (#717), the same allowlisted event the Anthropic
// Mayor records from llm.js. Never throws and is never awaited on the turn.
function recordTelemetry({ context, billingPath, requestedModel, result, error, startedAt }) {
  const ctx = context || {};
  if (!ctx.pool) return;
  const costUsd = Number(result?.usage?.cost_usd);
  const reported = Number.isFinite(costUsd) && costUsd >= 0;
  llmTelemetry.record(ctx.pool, {
    appId: ctx.appId,
    sessionId: ctx.sessionId,
    provider: 'openrouter',
    backend: ctx.backend || 'mayor',
    component: ctx.component || 'other_helper',
    requestedModel,
    servedModel: result ? bareModelId(result.servedModel) : null,
    billingPath,
    inputTokens: result?.usage?.input_tokens,
    outputTokens: result?.usage?.output_tokens,
    costUsd: reported ? costUsd : null,
    costSource: reported ? 'provider_reported' : 'unavailable',
    durationMs: Date.now() - startedAt,
    outcome: error ? (error.name === 'AbortError' ? 'cancelled' : 'error') : 'success',
    stopReason: result ? result.stopReason : null,
    attemptNumber: 1,
    requestMode: 'single',
  });
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
}

async function readBoundedJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new OpenRouterMayorError('response_too_large', 'Mayor response exceeded the limit');
  }
  // OpenRouter may prefix a non-streaming body with keep-alive whitespace.
  return JSON.parse(text.trim());
}

// A client with llm.streamChat's surface, bound to one model and one key.
function createClient({
  apiKey,
  apiBase,
  origin,
  model,
  catalogModel = null,
  sessionId = null,
  // 'platform' for the included key, 'openrouter_byok' for a personal one.
  billingPath = 'unknown',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // Whether a request whose pictures the provider refused (HTTP 400) is
  // sent again with each picture replaced by a line saying so (#3557). A
  // caller for whom the pictures ARE the question (the first version's
  // reviewer) passes false, and the refusal is an error instead.
  imageFallback = true,
  // The platform's host shortlist for this model
  // (config.openrouterProviderShortlists): provider slugs joined by commas,
  // or 'none'. Absent, the model's own shortlist applies (providerFor).
  providerShortlist = null,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new OpenRouterMayorError('authentication', 'OpenRouter key is unavailable');
  }
  const boundModel = bareModelId(model);
  if (!boundModel) throw new OpenRouterMayorError('model_required', 'OpenRouter model is unavailable');
  const base = String(apiBase || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const reasoningEffort = reasoningEffortFor(catalogModel);
  // #3557: PDFs go through only for a model the catalog lists as taking files.
  const fileInput = catalogModel?.supportsFiles === true;
  // Pictures likewise, for a model it lists as taking images.
  const imageInput = catalogModel?.supportsImages === true;
  const shortlist = listenerRouting.parseShortlist(providerShortlist);

  async function streamChat({
    messages, chatMessages = null, systemPrompt, tools, toolChoice, onToken, onDone, onError, signal, maxTokens, telemetryContext,
  } = {}) {
    // `model` and `apiKey` from the caller are deliberately ignored: this
    // client is bound to the session's OpenRouter model and key, and a
    // Claude id or an Anthropic key must never reach OpenRouter.
    const request = (history, { images = imageInput } = {}) => buildRequest({
      model: boundModel, reasoningEffort, systemPrompt, messages: history, chatMessages, tools, toolChoice, maxTokens, sessionId, fileInput,
      imageInput: images, imagePlaceholder: images === imageInput ? IMAGE_PLACEHOLDER : IMAGE_REFUSED_PLACEHOLDER,
      providerShortlist: shortlist,
    });
    const body = request(messages);
    const startedAt = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const post = async (payload) => {
      try {
        return await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            ...platformHeaders(origin),
          },
          body: JSON.stringify(withNoTraining(payload)),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new OpenRouterMayorError(
          timeout.signal.aborted ? 'timeout' : 'network',
          timeout.signal.aborted ? 'The Mayor model timed out' : 'Could not reach the Mayor model',
        );
      }
    };
    // One request, from send to parsed completion. A request its host
    // shortlist refuses (no host left on it: 404, or every one busy or
    // failing: 429, 502, 503) is sent once more to every host, as the coding
    // turns' listeners send it (sendRouted).
    const send = async (payload) => {
      let response = await post(payload);
      const plain = listenerRouting.withoutShortlist(payload.provider, { allow_fallbacks: true });
      if (plain && listenerRouting.SHORTLIST_FALLBACK_STATUSES.has(response.status)) {
        try { await response.body?.cancel?.(); } catch { /* the refusal is not read */ }
        response = await post({ ...payload, provider: plain });
      }
      if (!response.ok) {
        throw new OpenRouterMayorError(
          providerErrorCode(response.status),
          `Mayor model request failed (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      let completion;
      try {
        completion = await readBoundedJson(response);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OpenRouterMayorError) throw err;
        throw new OpenRouterMayorError('stream_error', 'The Mayor model returned an unreadable response');
      }
      if (completion?.error) {
        const status = Number(completion.error.code);
        throw new OpenRouterMayorError(
          Number.isInteger(status) ? providerErrorCode(status) : 'provider_error',
          'The Mayor model reported an error',
          { status: Number.isInteger(status) ? status : null },
        );
      }
      return completion;
    };
    try {
      let completion;
      try {
        completion = await send(body);
      } catch (err) {
        // #3557: a PDF the provider cannot take fails the whole request, and
        // the Mayor replays it on later turns. A request that carried one
        // and was refused as invalid is retried ONCE with each PDF replaced
        // by a line naming it. A picture is treated the same way.
        // Not for messages sent as built (`chatMessages`), and not for
        // pictures when the caller said so (`imageFallback`): a model
        // answering about pictures it never saw is worse than no answer.
        const files = hasFileParts(body);
        const pictures = hasParts(body, 'image_url');
        if (!(err instanceof OpenRouterMayorError) || err.status !== 400 || (!files && !pictures)) throw err;
        if (pictures && (!imageFallback || Array.isArray(chatMessages))) {
          throw new OpenRouterMayorError(
            'images_refused', 'The model provider refused the request\'s images (HTTP 400)', { status: 400 },
          );
        }
        if (Array.isArray(chatMessages)) throw err;
        completion = await send(request(files ? withoutDocuments(messages) : messages, { images: !pictures && imageInput }));
      }
      const result = fromChatCompletion(completion, { requestedModel: boundModel });
      recordTelemetry({
        context: telemetryContext, billingPath, requestedModel: boundModel, result, startedAt,
      });
      if (result.text && typeof onToken === 'function') onToken(result.text);
      if (typeof onDone === 'function') onDone();
      return result;
    } catch (err) {
      recordTelemetry({
        context: telemetryContext, billingPath, requestedModel: boundModel, error: err, startedAt,
      });
      if (typeof onError === 'function') onError(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: 'openrouter',
    model: boundModel,
    modelLabel: modelLabel(boundModel),
    reasoningEffort,
    // Read by the agent-session Mayor to decide whether the platform tools
    // fetch a request's screenshots for this model at all.
    imageInput,
    isEnabled: () => true,
    streamChat,
    estimateCostCents: (usage) => estimateCostCents(usage, catalogModel),
  };
}

// Everything the chat route needs to run an OpenRouter session's Mayor, or
// `{ error }` when it cannot, in which case the route keeps the direct path.
// Reads the same credential the coding turn will use, so the Mayor and the
// agent are always paid for by the same key.
// `sessionKey` names the conversation to OpenRouter when it is not a change:
// an agent session passes `homeroom-agent-<id>` (#2779). A change keeps the
// `homeroom-session-<id>` it has always sent.
async function resolveForSession({ pool, config = {}, session, userId, fetchImpl, sessionKey = null }) {
  if (!config.openrouterSessionMayorEnabled) return { error: 'disabled' };
  if (!config.codexOpenrouterEnabled) return { error: 'backend_disabled' };
  const model = bareModelId(session?.agent_model || await require('./default-model').effective(pool, config));
  if (!model) return { error: 'model_required' };
  const meta = await credentialStore.readMetadata({
    pool, userId, provider: 'openrouter', purpose: 'coding_agent',
  });
  if (!meta || meta.status !== 'valid') return { error: 'credential_required' };
  let apiKey = null;
  try {
    apiKey = await credentialStore.readSecret({
      pool, userId, provider: 'openrouter', purpose: 'coding_agent',
      dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
    });
  } catch {
    return { error: 'credential_required' };
  }
  if (!apiKey) return { error: 'credential_required' };
  const catalogModel = await agentModels.resolveModelPricing({
    pool, userId, credentialRevision: meta.revision, apiKey, modelId: model, config,
  });
  // The Mayor IS a tool loop. A model the catalog says cannot call tools
  // keeps the direct path, where the coding agent handles the message alone.
  if (catalogModel && catalogModel.supportsTools === false) return { error: 'model_without_tools' };
  const usesIncludedKey = meta.metadata?.source === managedOpenRouter.MANAGED_SOURCE;
  const client = createClient({
    apiKey,
    apiBase: config.openrouterApiBase,
    origin: config.openrouterOrigin,
    model,
    catalogModel,
    sessionId: sessionKey || (session?.id != null ? `homeroom-session-${session.id}` : null),
    billingPath: usesIncludedKey ? 'platform' : 'openrouter_byok',
    providerShortlist: config.openrouterProviderShortlists?.[model] || null,
    fetchImpl,
  });
  return {
    client,
    model,
    modelLabel: client.modelLabel,
    usesIncludedKey,
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAYOR_REASONING_EFFORT,
  IMAGE_PLACEHOLDER,
  IMAGE_REFUSED_PLACEHOLDER,
  OpenRouterMayorError,
  modelLabel,
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  reasoningEffortFor,
  providerFor,
  buildRequest,
  fromChatCompletion,
  estimateCostCents,
  createClient,
  resolveForSession,
};
