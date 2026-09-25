# Homeroom Native Bridge Contract

The Homeroom Flutter app injects a `Homeroom` JavaScript channel into every
page loaded in its dapp webview. `public/usernode-bridge.js` (canonical copy:
`public/usernode-bridge/v1/bridge.js`) wraps that channel in promise-returning
methods on `window.usernode`. This document is the versioned contract between
the app (producer — the Flutter shell, which lives in its **own repository**,
`lib/features/dapps/dapp_webview_screen.dart` there) and SV chrome (consumer,
this repo) for the methods SV's own shell depends on.

Wire format: the page posts
`{ id, method, args, privilegedCapability?, realmSessionClaim? }` as JSON to
the channel; the app resolves via
`window.__usernodeResolve(id, value, error)`. The bridge keeps both optional
values private. It adds `privilegedCapability` to privileged methods and adds
`realmSessionClaim` only to the closed set of session-bound methods after a
successful protocol-2 establishment. Unknown methods are silently dropped by
old app builds, so every bridge wrapper races a timeout and fails closed or
returns its documented chrome-read fallback. Feature-detect with
`getBridgeInfo`.

## Versioning

- `getBridgeInfo()` → `{ version: number, capabilities: string[],
  sessionLifecycleProtocol?: 2, appVersion?: string, buildNumber?: string }`
- `version` bumps only on breaking changes. New methods are additive and
  appear in `capabilities`.
- Feature-detect with `capabilities.includes('<method>')`, not `version`.
- Current version: **5**.
- **The two sides of this contract live in different repositories** — the
  producer in the Flutter shell repo, the consumer here. Adding or changing
  a bridge method is therefore a coordinated two-repo change, and the two
  halves ship independently: assume for a while that some installed builds
  have the old surface and some have the new one. That is exactly what
  `capabilities` is for — never assume a method exists because this document
  lists it.

Version 5 is the transaction/profile ownership cut: native `sendTransaction`,
`txObserved`, `getTransactionRecords`, and the legacy native profile identity
endpoint are removed; `submitTransaction` is the sole native submission
operation. There is no fallback to the removed authority. Generic bridge
version 5 does **not** by itself mean that native lifecycle protocol 2 is
available. Supporting builds separately advertise
`sessionLifecycleProtocol: 2` and the `establishNativeSession` capability.
Unsupported builds remain web-only/update-required; Social never falls back
to the removed split lifecycle API.

Temporary walletless compatibility uses the existing `appVersion` and
`buildNumber` discovery fields: Social forwards them as
`Usernode-Native-App-Version` / `Usernode-Native-App-Build` headers on the
web-authenticated handoff. Releases at or above `0.4.0+1252` may receive
`account: null`. Semantic versions are compared numerically before build numbers:
`0.4.1`, `0.5.0`, and `1.0.0` remain compatible even if their build counter restarts.
Older releases and missing/malformed metadata retain the wallet-required HTTP
fallback. The server persists this decision for both issuance and exact replay,
and refreshes it on each authenticated handoff.
These public identifiers select a decoder format and grant no authority.
Native ticket/exchange bodies, proofs and encrypted response formats are unchanged.
TODO(remove-build-1250-compat): Remove this negotiation and the wallet-required
fallback together once the minimum supported mobile release accepts walletless
credentials. Normal version bumps require no Social compatibility change.

The security capabilities remain independently discoverable:

- `privilegedBridgeCapability`: privileged top-frame methods require a
  native-issued capability scoped to the current trusted JavaScript realm.
- `privilegedBridgeReady`: after installing native-event listeners, the trusted
  shell explicitly identifies that exact realm as ready for one atomic state
  replay. A cached older coordinator falls back on its first authorized bridge
  call, so the web and app releases remain independently deployable.
- `privilegedErrorCodes`: every privileged refusal carries a stable
  machine-readable `code` alongside its human message, so the page never has
  to pattern-match English. Optional in both directions — see "Privileged
  refusal codes" below.

One additive **widget** capability introduced in v4 remains available in v5:

- `homeScreenShortcutDarkIcon`: the shell stores a SECOND icon per
  homescreen shortcut and the iOS widget selects between them per system
  appearance. Advertise it only once that is true end to end — SV reads
  it as "sending a dark icon has a visible effect" and re-sends every
  pinned canvas tile the first time it appears. See the homescreen
  shortcuts section below for the contract it unlocks.

One additive **notification** capability extends v4 the same way:

- `setSocialBadgeCount`: the shell applies a web-published unread total to
  the OS app-icon badge (issue #1445). Advertise it only on builds where
  the call has a visible effect end to end — SV feature-detects it
  separately from the four social-push methods, so builds without it keep
  full push support and simply never see the call. See "Homescreen icon
  badge" below for the producer contract it unlocks.

One additive **presentation** capability extends v4 the same way:

- `setAppearance`: the shell remembers the appearance SV resolved to and
  opens its next cold launch in that appearance rather than guessing from
  the OS. Advertise it only once a stored value actually reaches the
  launch screen — SV treats the capability as "telling you has a visible
  effect" and republishes on every theme change. Unprivileged, unlike the
  notification and settings actions: see "Appearance" below for why, and
  for the producer contract it unlocks.

## Methods

### Wallet / transactions

| Method | Args | Resolves |
|---|---|---|
| `getNodeAddress()` | — | `"ut1..."` current account address |
| `submitTransaction(request)` | exact request below | exactly `{ "txId": "..." }` after admission, confirmation and submission |
| `signMessage(message)` | `{ message }` | signature string |
| `openExternal` | `{ url }` (http/https only) | `true` when the system browser opened |

The hosted dapp API remains `window.sendTransaction(destination, amount, memo,
opts)`. In native mode it validates and maps to this single boundary:

```json
{
  "destinationPubkey": "ut1...",
  "amount": 5,
  "memo": "",
  "confirmation": {
    "title": "Send from wallet",
    "subtitle": "Sending 5 UT to ut1..."
  }
}
```

`destinationPubkey` and `memo` are strings; `amount` is a positive safe
integer. `confirmation` is optional and, when present, contains only optional
string `title` and `subtitle` fields. Native must return an object containing
only a non-empty string `txId`. The bridge rejects aliases, missing ids and
additional result fields. `txId` is canonical: leading or trailing whitespace
is rejected, never trimmed, and the accepted value is returned unchanged.
Native has no transaction-observed callback or receipt API.

### Homescreen shortcuts (pre-existing, v1)

`getHomeScreenShortcutSupport`, `addHomeScreenShortcut`,
`getHomeScreenShortcuts`, `removeHomeScreenShortcut`,
`reorderHomeScreenShortcuts` — see the comments in `usernode-bridge.js`.

#### Per-appearance icons (additive; `homeScreenShortcutDarkIcon`)

`addHomeScreenShortcut` takes
`{ name, url, icon_url, icon_url_dark?, silent? }`:

- `icon_url` — required-in-practice primary asset. When a pair is sent it
  is the **light**-appearance asset.
- `icon_url_dark` — **optional** dark-appearance asset. Absent, null or
  empty means "single icon", i.e. exactly the pre-existing behaviour. A
  re-add without it **clears** the dark slot (a re-add of the same URL is
  an in-place refresh — that is what `silent: true` is for).
- Either field may be an `https` URL **or** a `data:image/png;base64,…`
  URI. SV sends data URIs for its canvas-rendered emoji/letter tiles, so
  both fields must go through the same fetch/decode path.
- `version` stays **4**: this is purely additive, and shells that don't
  know the field ignore it like any other unknown key in `args`.

`getHomeScreenShortcuts()` items carry `{ id, name, url, pinnedAtMs }`
plus two icon-presence flags: `has_icon` (SV treats `false` as "the PNG
never landed" and silently re-sends) and `has_icon_dark` (same, for the
second asset). Report `has_icon_dark: true` only once the dark asset is
actually stored; SV tests it with a strict `=== false`, so a build that
omits the key entirely is safe.

**`has_icon_dark` is a load-bearing statement of fact, not a hint.** SV
treats the registry read-back as the authority on what this build can
store, because the capability list cannot be trusted to be complete: a
shell may store the dark asset in a release earlier than the one that
advertises the string, and a degraded `getBridgeInfo` reports no
capabilities at all while saying nothing about storage. So when the
capability answer is anything other than a conclusive yes, SV sends **one**
pair for a single canvas-tile entry, re-reads the registry and believes
`has_icon_dark`:

- `=== true` → this build stores pairs. SV records the verdict against
  `{ appVersion, buildNumber }` and sends pairs from then on.
- anything else → this build does not. SV records that verdict the same
  way and **immediately re-sends that one tile as a single face for the
  current appearance**, so the probe never leaves a light tile stranded on
  a dark homescreen.

Two obligations follow for the shell. A build that stores the asset must
report `has_icon_dark: true` for it — reporting `false` (or omitting the
key) after storing a pair tells SV the opposite of the truth and costs
that build the feature. And a build that accepts `icon_url_dark` while
discarding it must keep reporting `has_icon_dark: false`, which is what
lets SV correct the tile in the same pass.

The verdict is **bound to the installed version pair** and discarded as
soon as it changes: an app update is exactly when a shell gains or loses
this ability, so a verdict that outlived the build it was measured on
would be a latched negative in a slower disguise. When `getBridgeInfo`
cannot supply `appVersion`, no verdict is trusted and SV re-confirms
(one silent send per page load).

**Appearance selection is a render-time decision.** SV re-fetches the
registry and re-evaluates every entry when the app returns to the
foreground, but it cannot repaint while closed. A shell that advertises
the capability (or reports `has_icon_dark: true`) must therefore select
between the two stored assets on `colorScheme` **at widget render time**,
not at store time. Picking a face when the shortcut is added and keeping
it produces precisely the bug this contract exists to fix, while now
reporting the flag that makes SV stop compensating for it.

**Why this exists, and why the flag must not be advertised early.** A
stored PNG cannot restyle itself, and SV cannot repaint one while the app
is closed — which is exactly when the system flips light/dark (#948).
Without the capability, SV bakes the single face matching the current
system appearance and re-sends it when it notices a flip, so the
correction always waits for the next app open. With it, SV sends both
faces and the widget flips natively with SV closed. A shell that accepts
and stores `icon_url_dark` but does not select on `colorScheme` must NOT
advertise the capability: SV would send an asset nobody renders and would
have given up the repaint-on-flip fallback for nothing.

### Homescreen icon badge (additive; `setSocialBadgeCount`)

#### `setSocialBadgeCount({ count })` → resolves when applied

Privileged top-frame action (issue #1445), same per-realm capability and
session-admission rules as the four social-push methods. SV calls it from
the trusted Social shell every time the signed-in account's unread
notification total changes — on every bell repaint, after mark-read, and
with `count: 0` on sign-out — so the OS app-icon badge tracks what the
user would see inside the app.

Producer requirements for a build that advertises the capability:

- **Apply `count` to the OS app-icon badge**: on iOS via
  `UNUserNotificationCenter` badge count; on Android via the launcher
  badge, cancelling the shell's own tray notifications when the count
  reaches 0 so the notification dot clears with it.
- **`count` is authoritative and the call idempotent** — a non-negative
  integer, last write wins. Re-applying the current value must be a
  no-op, not a flicker.
- **Persist nothing beyond the OS surface**: the value is derived state
  SV republishes on session admission and page restore; the shell must
  not replay a stale stored count over a newer one.
- **Clear the badge on logout / session end**, matching SV's own
  `count: 0` publish, so a signed-out device is never left badged.
- **Advertise `setSocialBadgeCount` only where the call has a visible
  effect.** SV feature-detects it separately from the social-push
  capability set (a degraded `getBridgeInfo` is re-probed, never latched
  as unsupported), and builds without it lose nothing: the badge still
  appears via the `aps.badge` / `notificationCount` fields the platform
  stamps into every push, and clears on the next app open once a
  capable build is installed.

The FCM payload side of the same feature needs no shell code at all:
iOS applies `aps.badge` and Android launchers read
`notification.notificationCount` while the app is closed. This method
exists for the live half — updating and clearing the badge while the
user is inside the app.

### Native history gestures (additive; `setBackNavigationEnabled`)

`setBackNavigationEnabled({ enabled: boolean })` enables WebKit's native
back/forward navigation gestures. Only WebKit clients implementing this method
advertise the capability; callers must feature-detect it. This is a privileged
top-frame call, so embedded apps cannot enable the shell's gesture.

The platform header publishes `true` only for a visible Back arrow with a
destination, outside embedded App-tab content. Workshop and other Dev screens
remain eligible. A Workshop topic page (an issue, proposal, governance vote or
shared session) draws its Back as the in-page "Workshop" chip instead of a
header arrow (#2916), and publishes `true` for that chip's destination. Home
icons and hidden headers publish `false`. WebKit still
requires an existing history entry: a cold deep link with no previous page
keeps its clickable header destination but cannot swipe back through history.
The native flag also allows WebKit's standard forward gesture where forward
history exists. Android's existing system-back handling is unchanged.

The Flutter companion defaults the flag to disabled, revalidates the document
before applying each request, serializes changes, and resets it on document
load and disposal. The header republishes on `pageshow`, including restoration
from the back/forward cache. Both the platform update and a native release
containing this capability are required; older clients keep their behavior.

### Appearance (additive; `setAppearance`)

#### `setAppearance({ scheme, background })` → resolves when stored

**Unprivileged**, unlike every other action in this document. It carries no
account state, reveals nothing about the signed-in user, and the launch it
exists to fix is the one *before* sign-in — a privileged envelope would make
it unavailable in exactly the case it was added for.

SV calls it from `public/js/native-chrome.js` on every shell boot and on
every theme change (an explicit Light/Dark pick, and an OS flip while in
system mode).

- `scheme` — `"dark"` or `"light"`. The **resolved** appearance, never the
  tri-state stored mode: SV has already folded `system` against the OS
  preference, and the shell must not re-resolve it.
- `background` — the page ground as `#rrggbb`, optional. SV reads it back
  off the rendered document rather than repeating a literal, so it stays
  the colour the shell actually paints. Absent when the read failed; a
  build must then fall back to its own colour for `scheme`.

**The problem it solves.** SV's theme lives in the WebView's localStorage
and the app's in `app:theme_mode` (SharedPreferences). Nothing carried a
value between them, so the app could only guess from the OS — and guessed
wrong for everyone who had picked Dark on a light-mode phone, painting a
full-screen **white** launch frame ahead of a near-black shell on every cold
launch. No web-side fix reaches that frame: it is painted before any web
code runs. The only way for the app to have the colour is to have been told
last time.

Producer requirements for a build that advertises the capability:

- **Persist it, and open with it.** The value's whole purpose is the launch
  *after* the one that published it. Store it (globally, not per-network —
  appearance is not network state) and use it for the launch background, the
  WebView's own background colour, and the shell's `ThemeMode`.
- **Read it synchronously on the launch path.** A value fetched after the
  first frame has already lost — the flash it prevents happens in that
  frame. An async `SharedPreferences` read that corrects `ThemeMode` a beat
  later trades a white flash for a light-to-dark repaint, which is the same
  bug wearing a different colour.
- **`scheme` is authoritative and the call idempotent** — last write wins,
  re-applying the current value is a no-op rather than a flicker.
- **Nothing else changes on receipt.** It is presentation state: it must not
  affect auth, node lifecycle, or which code path runs.
- **Until a device has published once, fall back to the OS preference** —
  which is what a fresh install and every pre-`setAppearance` build get, and
  is right more often than not.

Builds without the capability lose only the improvement: SV feature-detects
it via `getBridgeInfo().capabilities`, an unknown method is dropped
silently, and the wrapper races a 4s timeout so nothing waits on the answer.

### Chrome data (v2 — the app-as-SV-chrome surface)

#### `getBridgeInfo()` → `{ version, capabilities, appVersion?, buildNumber? }`

Instant, side-effect free. The bridge wrapper resolves
`{ version: 0, capabilities: [] }` on old builds / outside the app, so
callers can always `await` it and gate UI on capabilities.

`appVersion` and `buildNumber` identify the installed Flutter binary (for
example `0.4.0` and `1223`). They are public release identifiers on the
unprivileged probe so a Homeroom staging build can display the app
hosting its WebView without receiving access to native settings or account
state. App builds predating these optional fields omit them; production SV
falls back to the same pair under `getSettingsState().buildInfo` while those
older builds remain installed.

**A probe that FAILS inside the app resolves that same empty shape plus
`degraded: true`** (the wrapper's own marker — native never sends it).
Reading `capabilities` needs no change; **a caller that CACHES or LATCHES
a negative conclusion from a probe MUST check `degraded` and re-probe
instead.** `version: 0` from inside the app means "don't know", not "this
build has no capabilities": treating a 4s timeout as the latter is how one
cold-start hiccup disabled every privileged call for a whole document and
made Settings → Homeroom app unloadable until the app was force-closed
(issue #978). The two in-repo consumers of this rule are the bridge's own
privileged-capability negotiation and `NativeChrome.getInfo()`, which
shares its in-flight promise but never memoises a degraded answer.

#### Why a read came back empty — `getLastNativeReadError(method)`

Every chrome read **resolves a safe fallback rather than rejecting**, so
callers can `await` and render "unavailable" (see the note at the top of
this section). That deliberately loses the reason, so the wrapper parks it
beside the read: `usernode.getLastNativeReadError("getSettingsState")`
returns the most recent FAILED read of that method, or `null` when its
last read succeeded or it was never called.

```json
{ "method": "getSettingsState", "kind": "timeout",
  "message": "getSettingsState did not respond within 12000ms",
  "at": 1780000000000 }
```

`kind` is one of:

| `kind` | Meaning |
|---|---|
| `timeout` | the app did not answer inside the wrapper's budget for that method |
| `rejected` | the app answered with an error (`message` is native's own text) |
| `no-transport` | no channel to the app from this frame at all |
| `not-native` | called outside the app (or on a build without the method) |
| `probe-inconclusive` | the privileged handshake could not be negotiated because `getBridgeInfo` itself came back degraded |
| `privileged-unavailable` | the app refused (or never answered) this realm's privileged handshake, so a privileged method could not be called at all — see "Privileged refusal codes" below |
| `page-changed` | the originating page entered navigation/BFCache before its native reply arrived |

The record carries a method name plus native's own error string only — the
privileged capability lives in a closure and never reaches an error
message — and each frame keeps its own map, so a frame can only read
failures of calls it made itself. `NativeChrome.lastReadError(method)`
forwards to it for SV chrome; SV's Settings screen renders the mapped
reason instead of a bare "could not load".

Privileged **actions** (setters, `openNativeScreen`, the session methods)
still reject rather than resolving a fallback — that part is unchanged —
but they now leave the same record behind, so a refused action is as
diagnosable as a failed read.

#### Privileged refusal codes

When the app refuses a privileged call, the human message is written for a
person and may be reworded at any time. Consumers must not pattern-match
English to decide what happened, so the app may send a stable machine-readable
code alongside it.

**Transport — a 4th argument to `__usernodeResolve`, additive in both
directions.** The page already resolves a request with
`window.__usernodeResolve(id, value, error)` where `error` is a **string**
that the wrapper turns into `new Error(error)`. A build that has a code
passes one more argument:

```js
window.__usernodeResolve(id, null,
  "Privileged bridge is unavailable for this main frame",
  { code: "privileged_frame_unauthorized" });
```

Both halves of this stay compatible on purpose:

- **Old app, new page.** Three arguments arrive, `errorInfo` is `undefined`,
  and the page behaves byte-for-byte as it does today — no code is invented.
- **New app, old page.** Older installed wrappers ignore extra arguments.
- `error` **must stay a string.** Moving the code into that slot would make
  every installed build render `[object Object]` to the user.
- A missing, empty, non-string or malformed `code` is ignored, never trusted.

The wrapper puts a valid code on the rejected error as
`err.usernodeCode`, tags it `err.usernodeKind = "privileged-unavailable"`
and `err.usernodePrivileged = true`, and classifies it:

| `code` | Classified state | What the user is told |
|---|---|---|
| `privileged_frame_unauthorized` | `blocked-frame` | the app is refusing this screen's secure connection |
| `privileged_unsupported_version` | `unsupported` | this app build predates the connection this screen uses |
| `privileged_bootstrap_timeout` | `unattached` | the app never answered the connection request |

An **unrecognised** code still classifies (as `blocked-frame`) rather than
falling through — a code the page has never seen is still positive evidence
that the app refused deliberately. With **no** code at all, the page falls
back to matching native's prose, which is why the classification keeps
working against every build shipped so far.

A build that always sends a code should advertise `privilegedErrorCodes` in
`capabilities`. Nothing on the SV side depends on that capability or on the
codes landing at all — this is a paired change owned by the Flutter repo, and
the consumer half shipped first, degrading to prose matching.

**Codes carry no secrets.** A code is a fixed identifier from the table
above, never a token, path, account identifier or free-form detail: the page
renders it and offers it as copyable text.

#### `getBridgeDiagnostics()` → connection snapshot (synchronous)

Everything the current frame knows about its own bridge, copied, with no
`await`:

```json
{ "isNative": true, "isTopFrame": true, "inIframe": false,
  "usesIframeRelay": false, "hasNativeChannel": true,
  "origin": "https://social.usernode.com",
  "bridgeVersion": 5, "capabilities": ["..."],
  "appVersion": "0.4.0", "buildNumber": "1223",
  "privileged": { "state": "blocked-frame",
                  "code": "privileged_frame_unauthorized",
                  "kind": "privileged-unavailable",
                  "message": "…native's own text…",
                  "at": 1780000000000, "attempts": 3 },
  "lastErrors": { "getSettingsState": { "method": "…", "kind": "…",
                                        "message": "…", "at": 0 } },
  "collectedAt": 1780000000000 }
```

`privileged.state` is one of `ready`, `blocked-frame`, `unsupported`,
`inconclusive`, `unattached`, `unknown`. `bridgeVersion`, `capabilities`,
`appVersion` and `buildNumber` come from the last **conclusive**
`getBridgeInfo` — which is unprivileged, and therefore still answers on a
device whose privileged handshake is refused. That is what makes such a
device diagnosable at all.

It carries **no capability token** (the token lives in a closure and never
reaches a message) and no user data, and each frame reads only its own
records. In a child frame the privileged record is reported as
`blocked-frame` / `no-transport` regardless of what that frame last tried,
so an embedded dapp learns nothing about the top frame.

SV renders it as Settings → Homeroom app → "Homeroom app — connection", with
**Try again** and **Copy diagnostics**.

#### `getNodeStatus()` → snapshot object

```json
{
  "status": "synced",          // synced | syncing | connecting | offline
  "chain": "testnet",
  "localBestHeight": 12480,       // our tip (null while unknown)
  "localBestTimestampMs": 1780000000000,
  "networkBestHeight": 12483,     // block-sync target (null while unknown)
  "readyPeers": 3,
  "connectedPeers": 3,            // compatibility alias for readyPeers
  "totalPeers": 8,
  "syncStalled": false,
  "clockDriftMs": 42,
  "walletDataHydrating": false
}
```

`status` is the chrome-level pill state (small hysteresis applied on the
native side so 1s-poll flapping between synced/syncing doesn't strobe).
`readyPeers` counts peers whose P2P connection has reached the ready state.
`syncStalled` becomes true while syncing after no local-tip, fetch, or apply
progress for three block intervals (with a 60-second minimum). The timestamp
and clock drift are milliseconds; subtracting `clockDriftMs` from the device
clock produces the node clock used for the displayed best-tip age.

**Push events:** the app also dispatches a `usernode:node-status`
`CustomEvent` on `window` with the same snapshot as `detail`:

- once after the shell explicitly confirms its native-event listeners are
  ready, and
- on every pill-state transition.

So chrome renders from the event stream and calls `getNodeStatus()` for an
initial value. Because events only fire on transitions (and can be missed
while the WebView is suspended), chrome also re-reads `getNodeStatus()`
every few seconds while the Settings Node row or the Node sheet is on screen
and the page is visible, and once on each reveal or return to the
foreground. Nothing is read while neither is showing.

#### `getWalletState()` → wallet snapshot

```json
{
  "address": "ut1...",
  "balance": "1284",        // base units, string (BigInt-safe)
  "tokenAmount": 1284.0,    // display units, number
  "tokenSymbol": "UT",
  "lastUpdatedMs": 1714672193412,
  "staking": {
    "delegate": null,
    "delegated_since": null
  }
}
```

Fields other than `address` are `null` while the native wallet provider
hasn't produced a value yet (fresh app start, node still syncing). The app
answers within ~10s worst-case; the bridge wrapper adds its own timeout.

`staking` is `null` while wallet setup or backend reconciliation is not yet
available. Within a staking snapshot, `delegate` alone is authoritative:
`null` means phone block production is active, while a non-null address means
delegation is active. `delegated_since` is optional display metadata and must
never be used to infer whether delegation is enabled.

#### `manageStaking()` → `{ delegate, delegated_since }`

Bridge v4 capability: `manageStaking`. This privileged top-frame method takes
no arguments, opens the native delegation screen, and resolves with the latest
staking snapshot after that screen closes, including when the user makes no
change. Native owns the fixed delegation target, confirmation, backend
synchronization, persistence and node reconfiguration. Homeroom must
not submit a target address or requested delegation state itself.

#### Social-owned transaction receipts

Once `submitTransaction` returns, Social persists the receipt under the
authenticated Social user, polls its own `/explorer-api` proxy by the exact
`txId`, and publishes `usernode:transaction-receipts-changed`. The Wallet
sheet reads `usernode.getTransactionReceipts()` locally; neither operation
crosses the native bridge. Opening the sheet calls
`getTransactionReceipts({ observePending: true })`, which resumes at most one
deduplicated, bounded explorer attempt for a pending receipt restored after a
reload. Periodic display reads omit that flag and never create detached retry
loops. Observation is capped at three minutes even if a dapp supplies a larger
or non-finite timeout. An explorer outage therefore leaves a pending receipt
after the bounded attempt, while a later explicit sheet open can try again.
Receipts are newest first and capped at 50:

```json
{
  "items": [{
    "txId": "...",
    "submittedAt": 1714672193412,
    "fromPubkey": "ut1...",
    "destinationPubkey": "ut1...",
    "amount": 5,
    "memo": "{...}",
    "status": "submitted",
    "confirmedAt": 1714672253412,
    "blockHeight": 12480,
    "blockTimestampMs": 1714672253000
  }]
}
```

Relayed child-app submissions are recorded by the trusted Social top frame
before the exact result is returned to the child. Closing admission stops
observation and prevents an old user's result from being written into a new
user's receipt namespace. Each admitted operation carries a private top-frame
gate generation through native resolution, explorer fetch/parse, persistence,
and confirmation; closing the gate permanently invalidates that generation,
even if the same account is later readmitted. `App.user.id` only chooses the
product-storage namespace and is never treated as authority. Anonymous sends
still receive the exact native result but do not create a persisted Social
receipt.

#### `openNativeScreen({ screen })` → `true`

Pushes an allowlisted native route. Allowed screens: `diagnostics` (the
minimal native diagnostics screen), `benchmark`, `httpLogs`, and `zkIdentity`
— the debugging UIs and hardware-backed identity flow that survive the
thin-shell migration. The former `settings`, `profile`, and `terms` screens
were deleted with their web replacements and are rejected like any other
value. Rejected entirely unless the top frame is the trusted SV origin
(sub-apps cannot drive native navigation).

The additive `zkIdentityFlow` capability means
`openNativeScreen('zkIdentity')` is dispatchable. SV gates its ZK identity
entry action on that feature capability so older app builds never expose a
dead button.

#### `captureScreenshot()` → `{ contentType, base64 }`

Additive bridge-v4 capability: `captureScreenshot`. Captures the currently
visible Homeroom app window on Android or iOS and returns a JPEG as base64.
The native encoder bounds the image to the feedback endpoint's 4 MB limit.
SV hides its feedback dialog before calling so the returned pixels show the
underlying screen, then restores the unchanged draft and presents a preview.

This is a privileged trusted-top-frame action. Child dapps cannot request a
capture of surrounding app chrome. Callers must feature-detect the capability;
older app builds continue to use the feedback dialog's Photos/file fallback.

### Settings (v3 — app-settings-to-web migration)

All v3 methods are trusted-SV-origin gated like `openNativeScreen`. They
power the "Homeroom app" sections in SV's Settings modal
(`frontend/src/features/settings/settings.js`). Profile identity and data are
owned entirely by the authenticated Social session.

#### `getSettingsState()` → settings snapshot

```json
{
  "buildInfo": {
    "appVersion": "1.4.2", "buildNumber": "87",
    "nodeVersion": "0.9.1", "commitHash": "a1b2c3d", "branch": "develop"
  },
  "nodeSleepEnabled": true,
  "debugMode": false,
  "facematchStrict": true,
  "authStatus": "authenticated",  // AuthStatus enum name
  "permissions": {
    "platform": "android",        // android | ios
    "exactAlarmGranted": true,
    "batteryOptDisabled": false,  // Android only, else null
    "deviceManufacturer": "samsung" // Android only, else null
  }
}
```

v4 removed `termsAccepted` (terms moved to the session-authed
`/challenges-api/terms/*` web routes) and `iosKeepAliveActive` (the iOS
foreground keep-alive service was deleted; iOS block production is off).

Permission probes can take a few seconds on a fresh app start; the bridge
wrapper uses a longer (12s) timeout for this method.

Like every chrome read it resolves `null` rather than rejecting on failure,
and the reason is available from
`getLastNativeReadError("getSettingsState")` (see above). SV's Settings →
Homeroom app section renders that reason with a retry, and keeps the blocks
that don't need this snapshot (activity notifications, block production,
terms, FAQ, the native diagnostics screens) on screen, so a failed read is
recoverable rather than a dead end.

#### Setters — each resolves the refreshed settings snapshot

| Method | Args | Effect |
|---|---|---|
| `setNodeSleepEnabled(enabled)` | `{ enabled: bool }` | toggles node sleep on inactivity |
| `setDebugMode(enabled)` | `{ enabled: bool }` | toggles the app's debug mode |
| `setFacematchStrict(enabled)` | `{ enabled: bool }` | toggles strict ZK-passport facematch |
| `requestPermissions()` | — | native alarm-permission prompt; snapshot plus a `granted` bool |
| `requestAlarmPermissions()` | — | Android: opens the first missing producer permission only (the exact-alarm settings page, else the battery dialog), never the notification prompt; call again for the next step. Snapshot plus a `granted` bool (exact alarms) |

`setIosKeepAlive` was removed in v4 with the iOS keep-alive service.

#### Actions — resolve `true`

| Method | Effect |
|---|---|
| `resetZkChallenge()` | discards in-progress ZK identity registration (confirm web-side first) |
| `openBatterySettings()` | Android: shows the one-tap system "let this app always run in the background?" dialog while battery optimization is on, else the app's App info page |
| `openNotificationSettings()` | opens the OS notification settings page for the app. The only way back from a **determined-denied** iOS notification permission: once the user has answered the OS prompt, `requestPermissions()` resolves immediately and presents no dialog, so a screen offering only "request" is a tap that does nothing forever. Capability-gated, and fails fast (probe timeout, not the 120 s permission timeout) — an *inconclusive* probe still calls through, per issue #978. |
| `prepareForLogin()` | from an anonymous trusted shell, closes and drains any privately recovered native session before Social receives a session-mint request; no-op when native is already signed out |
| `logout()` | performs the bounded hard native logout (node stop/drain plus identity and credential cleanup); attempt web revocation and clear caches first, then invoke this as the terminal operation; `offlineLogout` permits API failure and guarantees native WebView cleanup |

### Platform login + node lifecycle (semantic protocol 2)

The native realm starts closed. Before Social publishes a web identity it
synchronously clears any old realm claim, then creates or reloads one exact
attempt identified by `{ protocol: 2, userId, attemptId,
desiredRuntime: "running" }`. That non-secret attempt metadata is the only
session lifecycle state stored in the browser. The ticket, exchange challenge,
native credential, and realm claim are never written to web storage.

Social retrieves the exact ticket response from
`POST /api/v4/mobile/auth/native-establish-ticket` on every establishment or
recovery and passes its `data` value to the single native transaction:

```js
establishNativeSession({
  attemptId,
  nativeEstablishTicket: data,
  desiredRuntime: 'running',
})
```

Native returns exactly:

```js
{
  protocol: 2,
  attemptId,
  nativeRevision: '9',
  identity: { participantId: '41', accountId: '...', address: '...' },
  runtimeStatus: { state: 'running' },
  receiptStatus: 'committedReady',
  realmSessionClaim: '...'
}
```

`nativeRevision` is a canonical unsigned 64-bit decimal string. Identity has
exactly the three shown non-secret fields and `participantId` must equal the
current Social user. `runtimeStatus` is either `{ state: "running" }` or
`{ state: "startFailed", validatedCode }`, where `validatedCode` matches
`^[a-z0-9_]{1,64}$`. The bridge copies and freezes those public fields, stores
the opaque realm claim only in its closure, and returns the public status to
`NativeChrome` without the claim.

Every session-bound native request automatically receives the current claim
as the top-level `realmSessionClaim`. A missing or stale claim fails closed in
both the trusted top frame and iframe relay. Identity replacement, anonymous
publication, `pagehide`, and logout synchronously clear the claim and reject
late establishment or feature responses before a successor can be admitted.
An exact in-flight establishment joins one lease; a different request is
rejected.

The same attempt metadata remains after success so a replacement realm can
replay the exact committed attempt. The server replays the encrypted ticket
and exchange results byte-identically for that attempt; an unused expired
ticket still fails. Builds lacking `sessionLifecycleProtocol: 2` are web-only
and update-required. There is no fallback to a multi-call login, node-start,
or auth-poll sequence.

Builds advertising `restoreWebSession` can recover the web login from
their retained native credential. This root-owned, trusted-top-frame method
does not require a realm-session claim. Native calls
`POST /api/v4/mobile/auth/restore-web-session`, persists the authenticated
90-day lease receipt, installs the seven-day HttpOnly cookie in the OS WebView
store, and returns only `{ status: "restored", protocol: 2, userId, attemptId }`
(or `{ status: "absent" }`). The original web incarnation and attempt are
preserved. Cookie material never crosses the Flutter or JavaScript bridge.

Social tries this before treating a web-auth 401 as signed out, and renews
during foreground use at most once daily per document, including walletless
sessions. Network failures preserve the display snapshot. Logout closes
admission and settles an already-admitted recovery before sending web logout;
restored cookies are also checked against their exact live native credential
on cookie-authenticated paths, so a late response cannot undo revocation.
Deploy the server/schema support before distributing the native capability.
Older builds keep their existing web-login behavior.

Before an anonymous native shell submits any ordinary session-mint request,
it invokes the privileged root-owned `prepareForLogin()` operation. Native
closes admission, drains admitted work, revokes the exact retained credential,
and publishes signed-out before acknowledging. The method carries no realm
session claim because a recovered native session may predate the current web
document. A live web session is never preempted this way: the API returns
`409 logout_required`, requiring the ordinary explicit logout flow.

Logout closes the Social realm first and attempts web-session revocation.
Apps advertising `offlineLogout` can continue after an API failure or a two-second
timeout: native retires local authority without requiring server confirmation,
then deletes WebView cookies, local storage and cache before acknowledging and
replacing the document. The privileged top-frame capability authorizes this
process-root retirement even when an offline document has no native session claim.
Local cleanup failures reject logout and can be retried. Without `offlineLogout`,
web revocation must still succeed before invoking native logout.

Remote revocation is best effort on the offline path; this does not revoke a
server-side session while the server is unreachable or queue a later retry.

## Trust model

- The native transaction confirm sheet remains the sole native chrome over
  SV content (Apple Pay model). Nothing in this contract bypasses it.
- Privileged native methods are gated to the configured SV top-frame origin.
  The top-frame bridge privately asks for `getPrivilegedBridgeCapability` and
  keeps the returned opaque string in its closure. Native binds it to the
  executing JavaScript realm rather than to WebView lifecycle callbacks:
  same-document History API changes retain it, a replacement document gets a
  different capability, and BFCache restoration revives only its original
  realm. The capability is never exposed as a public `window.usernode`
  property.
- Privileged replies and native-to-page events are delivered only when that
  exact realm is still executing. Social calls `markPrivilegedBridgeReady`
  after all native-event listeners exist; native then dispatches its current
  event state in one realm-guarded JavaScript evaluation before acknowledging
  readiness. A failed replay is retryable rather than silently consuming
  state.
  `onPageStarted`/`onPageFinished` are intentionally not authority or listener
  readiness signals because their ordering differs across WebView platforms.
- The parent bridge refuses both capability bootstraps and privileged relays
  from child frames. Non-privileged dapp reads and transaction methods keep
  their existing relay behavior only while the current realm claim is live.
- Loopback origins are not privileged by default. Flutter development builds
  can opt in with `--dart-define=ENABLE_LOCAL_PRIVILEGED_BRIDGE=true`; the
  switch is additionally gated by Flutter debug mode and cannot enable
  loopback privileges in a release build.
- `openExternal` accepts http/https only.

## Offline / App-Bound Domains

The app's iOS webview opts into App-Bound Domains
(`WKAppBoundDomains` = `usernodelabs.org`, `evanshapiro.dev`, `localhost`),
which unlocks service workers — SV's PWA offline mode works inside the app.
Consequences:

- The webview cannot navigate to non-bound domains; external links must go
  through `openExternal`.
- The `Homeroom` channel only exists on bound domains.

Android webviews support service workers without configuration.
