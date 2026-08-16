// #1204 — an agent run that dies on the wire reports it in PROSE, not in
// its exit code.
//
// Claude Code retries an interrupted API stream itself; once the retries
// are exhausted it gives up mid-turn and its FINAL assistant message is a
// notice instead of an answer:
//
//   API Error: Connection lost mid-response. The response above may be
//   incomplete.
//
// The run then ends the way a healthy one does — `__USERNODE_RESULT__` is
// written, the exit code is 0 — so nothing downstream of the exit code can
// tell the difference. For a BUILD turn that message is only a summary
// line. For a SCOUT turn it is the deliverable: the host stores the
// agent's final message verbatim as the session's spec doc (see
// runScoutTool in routes/sessions.js, whose prompt tells the scout "the
// host captures that final message verbatim"). Undetected, the notice
// BECOMES the spec — it overwrites the previous draft, freezes as an
// immutable version in chat_session_specs, and the dev chat announces
// "Scout drafted a 1-line spec from the codebase". That is exactly what
// users reported as "spec result of 'API Error: Connection lost
// mid-response'".
//
// Detection is anchored to the first or last line, never a substring
// search over the body: a spec ABOUT error handling may legitimately
// quote these strings mid-document, and nuking a real spec over a quote
// would be a worse bug than the one this fixes. The trailing-line case
// (partial content, then the stream died) additionally requires the
// runtime's own "incomplete / lost / aborted" wording, so a document that
// merely ends on a line about API errors is left alone.

// The runtime's error notices all open with "API Error" — as `API Error:
// …`, `API Error (400 …)`, and with a `⎿`/bullet gutter prefix in some
// renderings. Anchored at line start.
const API_ERROR_LINE = /^[\s>*\-•⎿|]*API\s+Error\b/i;

// Transport failures the runtime reports as a bare one-line message with
// no "API Error" prefix. Only ever matched against a SINGLE-line result,
// so a spec that ends on such a sentence can't trip them.
const WHOLE_MESSAGE_NOTICES = [
  /^connection error\.?$/i,
  /^request timed out\.?$/i,
  /^stream (?:error|interrupted|disconnected)\.?$/i,
];

// Required, on top of API_ERROR_LINE, before a TRAILING line is read as
// "the response above was cut off". Keeps the trailing-line rule to the
// transport failures it is meant for.
const INCOMPLETE_TAIL = /(lost mid-response|may be incomplete|was aborted|connection (?:lost|error)|timed out)/i;

const MAX_NOTICE_CHARS = 200;

function clip(line) {
  const text = String(line || '').trim();
  return text.length > MAX_NOTICE_CHARS
    ? `${text.slice(0, MAX_NOTICE_CHARS - 1)}…`
    : text;
}

function nonEmptyLines(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Classify an agent's final message. Returns null when it is usable
// content, otherwise { kind, line }:
//   'api_error' — the whole message is the failure notice; the run
//                 produced nothing usable at all.
//   'truncated' — content came first and the stream died partway; the
//                 runtime says so itself on the last line.
// Callers treat both as a failed turn: a knowingly-incomplete document is
// not something to overwrite a reviewed spec draft with.
function agentApiFailure(text) {
  const lines = nonEmptyLines(text);
  if (!lines.length) return null;

  const first = lines[0];
  if (API_ERROR_LINE.test(first)) return { kind: 'api_error', line: clip(first) };
  if (lines.length === 1 && WHOLE_MESSAGE_NOTICES.some((re) => re.test(first))) {
    return { kind: 'api_error', line: clip(first) };
  }

  const last = lines[lines.length - 1];
  if (API_ERROR_LINE.test(last) && INCOMPLETE_TAIL.test(last)) {
    return { kind: 'truncated', line: clip(last) };
  }

  return null;
}

// One plain-terms sentence for the dev chat. Carries the runtime's own
// wording so the user (and the Mayor's wrap-up turn) can see what
// actually happened rather than a generic "something went wrong".
// Callers append what it means for their turn.
function describeAgentApiFailure(failure) {
  if (!failure) return '';
  return failure.kind === 'truncated'
    ? `The coding agent's API connection dropped mid-response, so its answer was cut off — ${failure.line}`
    : `The coding agent's API connection failed — ${failure.line}`;
}

module.exports = { agentApiFailure, describeAgentApiFailure };
