# LLM telemetry contract

This is the complete content-free observability contract for issue #717. It is
diagnostic only: collection must not change prompts, messages, tools, model
selection, routing, budgets, retries, billing, or provider request options, and
a telemetry failure must never fail an LLM turn.

## Privacy boundary

The invocation normalizer is an explicit allowlist. The ledger may contain only:

- bounded numeric counts, token/cost measurements, and durations;
- strict provider/backend/component/billing/outcome enums;
- provider model identifiers, a constrained inference-region slug, timestamps,
  and opaque invocation/correlation identifiers;
- strict booleans such as usage-reset detection.

It must never contain prompts, message or response text, tool names, tool
arguments/results, filenames or paths, raw errors, credentials, HTTP bodies, or
provider request IDs. Character counts are computed in memory; the corresponding
content is not copied into the event. Unknown values remain unavailable rather
than being recorded as zero.

## One invocation record

Every record keeps the baseline attribution and accounting fields:

- provider, backend, component, requested/served model, billing path, cost source;
- input, cache-read, cache-write, output, and reasoning-output tokens;
- known cost, end-to-end duration, outcome, stop reason, attempt, and correlation.

A direct Messages API call is one invocation. A server-side fallback produces one
record per model hop. A coding-agent CLI run is one provider run because the CLI
exposes aggregate terminal accounting; `providerTurnCount` records the API/model
turns inside that run when the runtime reports them.

## Diagnostic fields

All fields are nullable and carry an availability count in the admin report.

Request/context shape:

- request mode (single, stream, new agent, resumed agent);
- total/user/assistant message counts and content-block count;
- total, user, assistant, prior-thinking, prior-tool-result, system, in-memory
  JSON-shape, and tool-definition/schema character counts;
- prior tool-call/result, image, document, and cache-breakpoint counts
  (5-minute and 1-hour);
- coding-runtime tool, MCP-server, agent-definition, skill, and plugin counts when
  the runtime emits its content-free initialization event;
- max output, sampling controls, stop-sequence count, fallback-model count;
- tool choice, output format, thinking mode/budget, requested service tier and
  inference region, and reasoning effort.

Usage and response shape:

- 5-minute/1-hour cache-write tokens and server web-search/fetch requests;
- response content/text/tool/server-tool/thinking/redacted-thinking block counts;
- response text and thinking character counts.

Latency and agent workload:

- provider/API, runtime-reported agent, local queue, platform dispatch-setup,
  first-output, and end-to-end wall duration;
- observed model context/output limits, provider turns, and distinct models;
- provider retries/rate-limit events and context compactions (including the
  largest reported pre-compaction token count);
- tool calls/results/errors and distinct tool categories, permission denials,
  commands, file reads/searches/changes (including distinct-file counts), MCP,
  subagent, web-tool, and deferred-tool-search calls.

Reliability dimensions:

- safe error class, physical attempt, logical correlation, new/resumed mode,
  requested-vs-served fallback attribution, and cumulative-usage reset detection.

## Provider availability

| Source | Request shape | Token/cache detail | First output / API time | Agent/tool workload |
| --- | --- | --- | --- | --- |
| Anthropic Messages | Full, content-free counts | Full when returned, including cache TTL and server tools | First output for streams; API/wall duration | Response block/tool counts; one provider turn per model hop |
| Claude coding agent | Initial prompt-size/resume mode plus runtime capability counts | Aggregate terminal usage/cost when returned | CLI API/runtime duration and live first output | Turns, models, compactions/rate-limit events, distinct tools/files, subagents, searches, permissions, response shape; hidden transport retries stay unavailable |
| Codex/OpenRouter agent | Initial prompt-size counts, resume mode, model limits/effort | Durable per-attempt token deltas and catalog-estimated cost | End-to-end duration; other latency only when emitted | JSONL command/file/MCP/response/retry and distinct-tool/file counters; unavailable provider turns stay null |
| Local coding agent | Initial prompt-size counts | Unavailable unless the local protocol later reports them | Queue and accepted-to-finished duration | Final response-size counts; opaque local runtime internals stay unavailable |

## Admin report

`GET /api/admin/llm-telemetry?days=N` returns:

- a global summary and the existing provider/backend/component/model/billing groups;
- invocation, logical-run, retry, fallback, outcome, token, cache, cost, and
  availability totals;
- average, median, and p95 known cost for each model group, calculated only
  from invocations whose cost is available;
- count maps for every categorical diagnostic;
- availability, total, average, median, and p95 for every numeric diagnostic;
- UTC daily trend buckets with the same diagnostic statistics.

Summary diagnostic totals and averages are combined from groups. Summary
percentiles are deliberately omitted because independently grouped percentiles
cannot be combined correctly; exact percentiles remain on each group and day.

Any future field must fit the privacy boundary, have a stable provider-neutral
meaning, preserve null-versus-zero semantics, be added to the fixed report
whitelist, and include collector, aggregation, payload-privacy, and request-
unchanged tests in the same change.

The JSON-shape character metric is computed by walking the existing in-memory
request. It does not serialize or copy the full payload, and therefore does not
add a second prompt-sized allocation immediately before provider dispatch. The
telemetry kill switch skips this traversal and the coding-runtime diagnostic
counters as well as skipping persistence.
