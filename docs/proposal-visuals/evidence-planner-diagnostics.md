# Reading a preview agent timeout

The owner-only before/after run trace records `agentActivity` while the
preview agent works, including before the turn exits. Its `budgetMs` records the *effective*
configured agent budget. The default is 480,000 ms (8 minutes); an
environment override can change it. The run's default recovery window is 1,440,000 ms (24 minutes).

Before model exploration, `auth_bootstrap` records one fixed-shape event for
each persona and revision. `responseStatus`, `sessionCookieInstalled`, and
`sessionCookiePresent` show whether the private preview accepted its
app-scoped identity and the preview agent's browser retained the resulting
session.
The trace never contains the identity token, cookie, URL, or page content.
An HTTP preview that issues a Secure session cookie needs the explicit
private-context exchange; otherwise the preview agent sees a sign-in screen.

For a timeout, look at the last `events` and the three pending lists:

| Trace field | What it measures | A long pending item suggests |
| --- | --- | --- |
| `pendingProviderRequests` | Time inside the Codex/OpenRouter request adapter, with 15-second progress marks | `await_headers`: provider or network wait; `await_first_byte`: model has sent headers but no output yet; `streaming`: output started but has not finished. Compare byte and chunk counts between marks to see whether the stream is still advancing. |
| `pendingBrowserCalls` | Actual Playwright MCP call time, with 15-second progress marks | Browser navigation, page loading, action, or snapshot is taking time. The tool name and base/head side identify the operation. |
| `pendingDocumentRequests` | In-flight HTTP document loads through the evidence origin proxy | The preview app may be slow to serve the page. This is available for HTTP document requests; HTTPS CONNECT is opaque to the proxy. |

Completed `provider_request_end`, `browser_call_end`, and `document_response`
events report durations and outcomes. Provider events also mark response headers
and first byte separately. A sequence of short successful browser calls followed
by a long `provider_request_pending` points to model time. A long
`browser_call_pending` with an unfinished document request points to page or
browser time. If neither boundary has a pending call while the turn remains
active, inspect the last model tool event and runner phase: the gap is in the
agent process between calls, and the trace alone cannot prove what it was
thinking. Compare those events with `agent_deadline` and `worker_stop_requested`
to distinguish the platform's timeout from an external interruption.

`routeHint` reports whether a browser navigation matches an accepted intent
start or a declared check, with only an ordinal for its route. Browser result
shape counts headings, buttons, links, image blocks, and response size. These
fields help spot repeated navigation or a blank/error page without retaining
URLs, page text, prompts, model output, credentials, or screenshots in the
diagnostic trace. The shots themselves remain the place for human review.

These counters diagnose the *next* run. They do not retroactively explain an
older timeout, and longer budgets do not by themselves repair a stuck model,
browser, or preview app.
