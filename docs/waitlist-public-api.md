# Waitlist public API

The platform's waitlist is a public, unauthenticated HTTP API. Nothing in
it requires a Homeroom account, an OAuth token or a session cookie. A
signup is identified by an unguessable capability token that the platform
mints on the first join and mails to the address being signed up.

This document is written for an integrator implementing against the API
with no access to the source: an agency running its own signup form, a
partner landing page, a status dashboard. Everything below reflects the
behaviour of `src/routes/public-api.js`, `src/routes/waitlist-connect.js`,
`src/middleware/rate-limits.js` and `src/services/waitlist-integrator.js`
as shipped.

- [Base URL and transport](#base-url-and-transport)
- [Concepts](#concepts)
- [Endpoints](#endpoints)
  - [GET /api/public/waitlist/options](#get-apipublicwaitlistoptions)
  - [POST /api/public/waitlist](#post-apipublicwaitlist)
  - [GET /api/public/waitlist/confirm/:token](#get-apipublicwaitlistconfirmtoken)
  - [POST /api/public/waitlist/confirm](#post-apipublicwaitlistconfirm)
  - [GET /api/public/waitlist/more/:token](#get-apipublicwaitlistmoretoken)
  - [POST /api/public/waitlist/more/:token](#post-apipublicwaitlistmoretoken)
  - [GET /waitlist/connect/:provider](#get-waitlistconnectprovider)
  - [GET /waitlist/connect/:provider/callback](#get-waitlistconnectprovidercallback)
- [Rate limits](#rate-limits)
- [Trusted integrator headers](#trusted-integrator-headers)
- [Errors](#errors)
- [A full worked flow](#a-full-worked-flow)

## Base URL and transport

All paths are relative to the deployment's canonical origin. On the
hosted platform that is:

```
https://social-vibecoding.usernodelabs.org
```

A self-hosted deployment serves the same paths on its own
`USERNODE_DOMAIN`.

Three transport facts an integrator has to plan around:

1. **There is no CORS.** The API sends no `Access-Control-Allow-Origin`
   header, so a browser on your own origin cannot call it. The
   integration is server to server. Post from your backend, and keep any
   integrator secret there too.
2. **Request bodies are JSON.** Send `Content-Type: application/json` on
   every POST. Responses are JSON except for the two redirect endpoints,
   which answer `302` with a `Location` header.
3. **Nothing is versioned in the path.** Fields are added to responses
   over time, so parse leniently and ignore keys you do not recognise.

## Concepts

**The signup.** One row per email address. Joining twice with the same
address is a silent no-op that returns the same success response, so the
API can never be used to test whether an address is already on the list.

**The `more_token`.** A 48-character lowercase hex string
(`/^[a-f0-9]{48}$/`). It is the capability that authenticates every
per-signup request: reading the signup's state, saving stage-2 answers,
confirming the address by link, and starting a social connect. It is
minted on the **first** join only and returned once in that join's
response, as well as being mailed to the address. A repeat join returns
`more_token: null`, because handing a fresh token to whoever retypes an
address would hand a stranger the ability to edit somebody's answers.
Treat the token as a bearer credential: anyone holding it holds the
signup.

**Two survey stages.** Stage 1 is the join itself, where everything
except the email is optional. Stage 2 is the "Want in sooner?" form
behind the token, where everything is optional and sections merge across
visits.

**Three signup states.** `pending` (joined, address not verified),
`confirmed` (address verified), `admitted` (released off the waitlist).
They are derived from timestamps on the row rather than stored as a
field, and they are ordered most advanced first: an admitted signup
reads as `admitted` even though it also carries a confirmation time.

## Endpoints

### GET /api/public/waitlist/options

The survey question definitions: option keys, human labels and the
country list. Render your form from this rather than hardcoding the
enums, so your client and the server's validation cannot drift.

The payload is static for the lifetime of the server process, so cache
it.

**Request**

```http
GET /api/public/waitlist/options HTTP/1.1
Host: social-vibecoding.usernodelabs.org
```

No headers, no body, no rate limit.

**Response `200`**

```json
{
  "discovery_sources": {
    "x": "X",
    "linkedin": "LinkedIn",
    "instagram": "Instagram",
    "reddit": "Reddit or a forum",
    "friend": "Friend or colleague",
    "podcast": "Podcast",
    "event": "Event",
    "other": "Other"
  },
  "group_sizes": {
    "lt10": "Under 10",
    "10-50": "10 – 50",
    "50-250": "50 – 250",
    "250-1000": "250 – 1,000",
    "gt1000": "Over 1,000"
  },
  "group_roles": {
    "founder": "I started it",
    "organizer": "I run or moderate it",
    "active": "I'm one of the active people",
    "member": "I'm a member"
  },
  "group_tools": {
    "discord": "Discord",
    "telegram": "Telegram",
    "whatsapp": "WhatsApp",
    "groupchat": "A group chat",
    "slack": "Slack",
    "facebook": "A Facebook group",
    "spreadsheet": "A spreadsheet somebody maintains",
    "docs": "Notion or Google Docs",
    "forum": "A forum",
    "nothing": "Nothing, it's word of mouth"
  },
  "loss_answers": {
    "yes": "Yes, and it still annoys me",
    "mild": "Something like that",
    "no": "Not really"
  },
  "loss_kinds": {
    "shutdown": "Shut down for good",
    "paywall": "Put behind a paywall",
    "acquired": "Bought, then changed",
    "ads": "Filled with ads",
    "rules": "Rules changed under us",
    "banned": "I was banned or locked out",
    "api": "API closed to third parties",
    "neglect": "Left to rot"
  },
  "countries": {
    "AF": "Afghanistan",
    "AX": "Åland Islands",
    "AL": "Albania",
    "DZ": "Algeria",
    "…": "…",
    "GB": "United Kingdom",
    "US": "United States",
    "UY": "Uruguay",
    "ZM": "Zambia",
    "ZW": "Zimbabwe"
  }
}
```

`countries` is one flat map of all 249 officially assigned ISO 3166-1
alpha-2 codes to their common English names. It arrives already sorted
by name, so render it in the order you received it rather than sorting
it yourself: the order is authored, and re-sorting in your own locale
moves the accented names (`Åland Islands` belongs with the A's, not at
the end). Send a **key**, never a label. Labels are display text and
can be reworded without notice; keys are what gets stored.

> **Breaking change, September 2026.** `countries` used to be grouped by
> region, with one pseudo-code per bucket (`EU`, `LA`, `AF`, `ME`, `AP`)
> meaning "elsewhere in this region". All five are gone, and they stop
> working in two different ways:
>
> - `EU` and `AP` are not ISO codes at all, so they are now rejected
>   with `422 {"error":"Unknown country."}`.
> - `LA`, `AF` and `ME` **are** real ISO codes, and are now accepted as
>   **Laos**, **Afghanistan** and **Montenegro**. A client still mapping
>   "Elsewhere in Latin America" to `LA` gets a `200` and stores the
>   wrong country, with nothing to alert you.
>
> If your form hardcoded the old buckets, replace them with this
> endpoint's flat map. Nothing you send needs to change for the ISO
> codes you were already sending.

### POST /api/public/waitlist

Join the waitlist. This is the only write in the API that does not
require a token.

**Request**

```http
POST /api/public/waitlist HTTP/1.1
Host: social-vibecoding.usernodelabs.org
Content-Type: application/json
X-Waitlist-Client-Key: <integrator secret, optional>
X-Waitlist-Client-IP: <end user address, optional>
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | **yes** | Trimmed and lowercased. Must match `^[^\s@]+@[^\s@]+\.[^\s@]+$` and be at most 255 characters. |
| `discovery_source` | string | no | One key from `discovery_sources`. An unknown key is a `422`. |
| `country` | string | no | One key from `countries`, case-insensitive, stored uppercased. An unknown code is a `422`. |
| `invite_code` | string | no | A 10-character `[a-z0-9]` referral code from another signup's invite link (`<marketing origin>/waitlist?ref=<code>`, and `/#waitlist?ref=<code>` for links minted before the marketing page owned it). An unresolvable code is ignored rather than refused, so a stale link never blocks a join. |

A bare `{"email": "…"}` is a complete, valid signup.

Fields that older clients may still send (`discovery_detail`, `city`,
`referrer_handle`) are accepted and dropped.

**Minimal example**

```json
{ "email": "ada@example.com" }
```

**Full example**

```json
{
  "email": "ada@example.com",
  "discovery_source": "friend",
  "country": "gb",
  "invite_code": "a1b2c3d4e5"
}
```

**Response `200` (first join)**

```json
{
  "ok": true,
  "message": "You're on the waitlist. We'll email you when access opens up.",
  "more_token": "3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d"
}
```

**Response `200` (address already on the list)**

```json
{
  "ok": true,
  "message": "You're on the waitlist. We'll email you when access opens up.",
  "more_token": null
}
```

The two responses are deliberately indistinguishable apart from
`more_token`, and a repeat join sends no mail and mints no verification
code. Do not present `more_token: null` to the visitor as an error. It
means either "you were already on the list" or "this address just
joined from somewhere else", and the platform will not tell you which.

Only a first join triggers the confirmation mail. That mail carries two
things: a one-click confirm link
(`/api/public/waitlist/confirm/<more_token>`) and a six-digit code that
expires after 15 minutes. Both confirm the same signup; whichever
arrives first wins.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `422` | `{"error":"A valid email address is required."}` | `email` missing or malformed. |
| `422` | `{"error":"Unknown country."}` | `country` is not a key in `countries`. |
| `422` | `{"error":"Unknown discovery source."}` | `discovery_source` is not a key in `discovery_sources`. |
| `429` | `{"error":"…","retryAfterSeconds":N}` | See [Rate limits](#rate-limits). |
| `500` | `{"error":"Internal server error"}` | Server fault. Safe to retry. |

Mail delivery is best effort and never fails the join. A deployment with
no mail transport configured still returns `200` with a usable
`more_token`.

### GET /api/public/waitlist/confirm/:token

The one-click confirm link carried in the join mail. It stamps the
signup's confirmation time and then redirects to the stage-2 survey, so
verifying the address and answering the optional questions are one
motion.

This is a state-changing `GET` on purpose: a mail client can only offer
a link, and following an unguessable token that was delivered to the
address being confirmed is itself the proof.

It is idempotent. The original confirmation time is kept, so a forwarded
or re-opened link is harmless.

**Request**

```http
GET /api/public/waitlist/confirm/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d HTTP/1.1
Host: social-vibecoding.usernodelabs.org
```

**Response `302`**

```http
HTTP/1.1 302 Found
Location: /#more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"Unknown or expired link."}` | The token is malformed or resolves to no signup. A stale link 404s rather than redirecting to a blank survey, which would look like the survey was broken. |
| `429` | `{"error":"…","retryAfterSeconds":N}` | See [Rate limits](#rate-limits). |
| `500` | `{"error":"Internal server error"}` | Server fault. |

### POST /api/public/waitlist/confirm

The same confirmation as the link above, by the six-digit code from the
same mail. It exists for phones, where leaving the app for the mail
client loses the browser's place.

**Request**

```http
POST /api/public/waitlist/confirm HTTP/1.1
Host: social-vibecoding.usernodelabs.org
Content-Type: application/json
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | **yes** | Same normalisation as the join. |
| `code` | string | **yes** | Exactly six digits, `^[0-9]{6}$`. Trimmed before checking. |

```json
{ "email": "ada@example.com", "code": "409132" }
```

**Response `200`**

```json
{
  "ok": true,
  "more_token": "3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d"
}
```

Unlike the join, this **does** hand back the token, because presenting a
live code for the address is proof the caller controls that mailbox.
`more_token` can still be `null` if the underlying row has no token.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `422` | `{"error":"Enter the six-digit code from your email."}` | `email` missing or malformed, or `code` is not six digits. |
| `422` | `{"error":"That code is wrong or has expired. Ask for a new one."}` | Every other failure. |
| `429` | `{"error":"…","retryAfterSeconds":N}` | See [Rate limits](#rate-limits). |
| `500` | `{"error":"Internal server error"}` | Server fault. |

The second `422` is deliberately one bucket. A wrong code, an expired
code, a code already used, too many attempts on that code, and an
address that was never on the list all produce the same message, so this
endpoint cannot be used to test whether an address is on the waitlist.
Do not try to distinguish them.

Code rules worth building against: a code lives 15 minutes, only the
newest unconsumed code for an address is live (issuing a new one kills
the old), and after 5 wrong guesses that code is dead even if it has not
expired.

### GET /api/public/waitlist/more/:token

Read a signup's state. This backs the "Want in sooner?" screen: where
the signup stands, its saved answers, which social connects are
available, and its invite link.

Two shapes, selected by the `view` query parameter.

**Request**

```http
GET /api/public/waitlist/more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d HTTP/1.1
Host: social-vibecoding.usernodelabs.org
```

| Query | Values | Notes |
|---|---|---|
| `view` | `status` | Returns the light read below. Any other value, including an unknown one, is ignored and you get the full payload. An unknown value never produces an error. |

#### The full read

**Response `200`**

```json
{
  "ok": true,
  "admitted": false,
  "status": {
    "state": "confirmed",
    "admitted": false,
    "confirmed": true,
    "has_account": false,
    "joined_at": "2026-08-30T09:14:02.881Z",
    "confirmed_at": "2026-08-30T09:16:44.107Z",
    "admitted_at": null
  },
  "answers": {
    "_version": 3,
    "discovery": { "source": "friend" },
    "country": "GB",
    "made_url": "https://ada.example.com/looms",
    "made_note": "A pattern editor for my weaving group.",
    "group": {
      "name": "North London Weavers",
      "size": "10-50",
      "role": "organizer",
      "tools": ["whatsapp", "spreadsheet"],
      "need": "Somewhere to keep the pattern archive that outlives the chat."
    },
    "loss": {
      "had": "yes",
      "product": "Google Reader",
      "kind": ["shutdown"],
      "story": "Ten years of subscriptions, one announcement."
    },
    "handles": { "discord": "ada#4021" },
    "verified": { "github": "adalovelace" },
    "followed_claim": true
  },
  "oauth": { "github": true, "x": true, "linkedin": false },
  "follow": {
    "x": "https://x.com/usernodelabs",
    "linkedin": "https://www.linkedin.com/company/usernodelabs",
    "instagram": null
  },
  "invite": {
    "url": "https://onhomeroom.com/waitlist?ref=a1b2c3d4e5",
    "count": 2,
    "emails": ["gr***@example.com", "jo***@example.net"]
  }
}
```

Field by field:

- **`admitted`** (boolean, top level). Whether this signup has been
  released off the waitlist. It duplicates `status.admitted` on purpose:
  "am I in yet" is the one question this route exists to answer, and a
  caller that reads nothing else should not have to know the shape of
  the status block.
- **`status`** (object). The derived state block, described in
  [The status block](#the-status-block) below.
- **`answers`** (object). Everything saved so far, across both stages.
  `{}` for a signup that answered nothing. `_version` is the answers
  schema version, currently `3`. Sections are only present once
  something in them has been answered, so treat every key as optional.
  A record saved before a key was retired still carries it, so `answers`
  can hold keys this document no longer lists (`invites`,
  `admit_together`); nothing reads them and no new save can add them.
  `handles` holds self-reported handles; `verified` holds handles proved
  by OAuth, and the two are kept apart deliberately.
  `country` is normally an ISO 3166-1 alpha-2 code, but a signup made
  before the region buckets were retired can carry one of five
  namespaced legacy values instead: `X-EU`, `X-LA`, `X-AF`, `X-ME`,
  `X-AP`, meaning "elsewhere in Europe / Latin America / Africa / the
  Middle East / Asia-Pacific". They are display-only. The options
  endpoint never offers them, a join can never submit one, and they must
  not be parsed as ISO codes: strip the `X-` prefix and `LA` is Laos,
  not the region the person meant. Render an unrecognised value as
  stored rather than hiding it.
- **`oauth`** (object). Whether each provider is configured on this
  deployment. All three keys are always present. `false` means the
  deployment has no credentials for that provider, so hide its connect
  button and offer a plain text field instead.
- **`follow`** (object). Public profile addresses for "Follow along".
  All three keys are always present; `null` means none is configured, so
  render no link. Nothing here claims a follow was verified, because no
  network will confirm one.
- **`invite`** (object). `url` is this signup's shareable referral link,
  whose `ref` code you can pass back as `invite_code` on a join. `count`
  is how many signups arrived through it. `emails` are those addresses,
  masked to the first two characters of the local part plus the full
  domain, enough to recognise a friend and never a harvestable list.
  `url` is `null` only when the signup could not be resolved to a code.

  The link points at the public marketing site's `/waitlist` page, whose
  origin is the `MARKETING_BASE_URL` platform variable (default
  `https://onhomeroom.com`). It is deliberately not the app's own
  `#waitlist` route: an invite is shared with people who have never seen
  the product. The `ref` code is unchanged either way, so a link minted
  before the move still attributes its joins correctly.

Note that the invite code is minted lazily, on the first full read of
this route. A signup that never opens the stage-2 form never gets one.

#### The light read (`?view=status`)

**Request**

```http
GET /api/public/waitlist/more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d?view=status HTTP/1.1
Host: social-vibecoding.usernodelabs.org
```

**Response `200`**

```json
{
  "ok": true,
  "admitted": false,
  "status": {
    "state": "pending",
    "admitted": false,
    "confirmed": false,
    "has_account": false,
    "joined_at": "2026-08-30T09:14:02.881Z",
    "confirmed_at": null,
    "admitted_at": null
  }
}
```

Use this for polling. It answers the same state question with two fewer
database queries and no invite-code write, which matters because the
stage-2 screen re-reads this route while it waits for a confirmation to
land. Poll it at a human pace, a few seconds apart at most, and stop
once `state` stops being `pending`.

#### The status block

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `"pending"`, `"confirmed"` or `"admitted"`. Ordered most advanced first, so an admitted signup reads `"admitted"` even though it also carries a `confirmed_at`. |
| `admitted` | boolean | True once the signup has been released off the waitlist. |
| `confirmed` | boolean | True once the address has been verified, by link or by code. |
| `has_account` | boolean | True once the invite has actually been redeemed into a Homeroom account. This is a different question from having been admitted: an admitted signup that has not signed up yet is `admitted: true, has_account: false`. |
| `joined_at` | string or null | ISO-8601 timestamp of the join. |
| `confirmed_at` | string or null | ISO-8601 timestamp of the confirmation, `null` while pending. |
| `admitted_at` | string or null | ISO-8601 timestamp of the release, `null` until admitted. |

The three states in words:

- **`pending`** means joined but not verified. Nothing has proved the
  address is real yet.
- **`confirmed`** means the address is verified and the signup is
  waiting. This is where most signups sit.
- **`admitted`** means access has been opened. Check `has_account` to
  know whether the person has taken it up.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `404` | `{"error":"Unknown or expired link."}` | The token is malformed or resolves to no signup. Both `view` shapes 404 the same way. |
| `429` | `{"error":"…","retryAfterSeconds":N}` | See [Rate limits](#rate-limits). |
| `500` | `{"error":"Internal server error"}` | Server fault. |

### POST /api/public/waitlist/more/:token

Save stage-2 answers. Every field is optional, and sections merge: a
later visit fills in what an earlier one skipped without clearing it.
Merging is section-wise, so re-submitting a section replaces that whole
section while untouched sections keep their previous value.

**Request**

```http
POST /api/public/waitlist/more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d HTTP/1.1
Host: social-vibecoding.usernodelabs.org
Content-Type: application/json
```

| Field | Type | Max | Notes |
|---|---|---|---|
| `made_url` | string | 2000 | Something the person has made. A bare domain gets `https://` prefixed automatically; anything carrying an explicit scheme is left alone and must then look like `https://host.tld/…`. |
| `made_note` | string | 140 | A line about it. Stored only when `made_url` is present. |
| `group_name` | string | 255 | The group they are part of. |
| `group_size` | string | 32 | One key from `group_sizes`. |
| `group_role` | string | 32 | One key from `group_roles`. |
| `group_tools` | array of string | | Keys from `group_tools`. Must be a JSON array. An empty array stores nothing. |
| `group_need` | string | 800 | What the group needs. |
| `had_loss` | string | 16 | One key from `loss_answers`. |
| `loss_product` | string | 255 | What they lost. |
| `loss_kind` | array of string | | Keys from `loss_kinds`. Must be a JSON array. |
| `loss_story` | string | 800 | What happened. |
| `farcaster`, `discord`, `telegram` | string | 255 each | Self-reported handles. Stored under `answers.handles`. |
| `other_handle` | string | 255 | Stored as `answers.handles.other`. |
| `followed_claim` | boolean | | Coerced with `!!`. A claim that they followed, stored apart from `answers.verified` because no network confirms a follow. |

A string longer than its maximum is treated as absent rather than
rejected. An unknown enum key is a `422`: optional means "may be
absent", never "may be anything".

`invites` (an older array of typed addresses) and `admit_together` (an
older flag asking to be admitted only alongside someone from the same
link) are accepted and silently dropped rather than rejected. Use the
invite link from the full read instead of `invites`; nothing reads
`admit_together`, and admission has never depended on it.

**Example**

```json
{
  "made_url": "ada.example.com/looms",
  "made_note": "A pattern editor for my weaving group.",
  "group_name": "North London Weavers",
  "group_size": "10-50",
  "group_role": "organizer",
  "group_tools": ["whatsapp", "spreadsheet"],
  "group_need": "Somewhere to keep the pattern archive that outlives the chat.",
  "had_loss": "yes",
  "loss_product": "Google Reader",
  "loss_kind": ["shutdown"],
  "loss_story": "Ten years of subscriptions, one announcement.",
  "discord": "ada#4021",
  "followed_claim": true
}
```

`made_url` above is stored as `https://ada.example.com/looms`.

**Response `200`**

```json
{
  "ok": true,
  "message": "Saved, thanks. You can come back and add to this any time."
}
```

The save does not echo the merged answers. Re-read
`GET /api/public/waitlist/more/:token` if you need them.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `422` | `{"error":"That does not look like a link. It should start with https://"}` | `made_url` carries a scheme that is not `http`/`https`, or is not host-shaped. |
| `422` | `{"error":"Unknown group size."}` | `group_size` is not a key in `group_sizes`. |
| `422` | `{"error":"Unknown group role."}` | `group_role` is not a key in `group_roles`. |
| `422` | `{"error":"group_tools must be a list."}` | `group_tools` was sent as something other than a JSON array. |
| `422` | `{"error":"Unknown group tool."}` | An entry of `group_tools` is not a key in `group_tools`. |
| `422` | `{"error":"Unknown loss answer."}` | `had_loss` is not a key in `loss_answers`. |
| `422` | `{"error":"loss_kind must be a list."}` | `loss_kind` was sent as something other than a JSON array. |
| `422` | `{"error":"Unknown loss kind."}` | An entry of `loss_kind` is not a key in `loss_kinds`. |
| `404` | `{"error":"Unknown or expired link."}` | The token is malformed or resolves to no signup. Validation runs first, so a bad body on a bad token gives you the `422`. |
| `429` | `{"error":"…","retryAfterSeconds":N}` | See [Rate limits](#rate-limits). |
| `500` | `{"error":"Internal server error"}` | Server fault. |

### GET /waitlist/connect/:provider

Start an OAuth round trip that proves the signup's owner controls a
GitHub, X or LinkedIn account. Note the path: these two routes are **not**
under `/api/public/`.

This proves **account ownership and nothing more**. It does not and
cannot verify that anyone followed anything.

`:provider` is one of `github`, `x`, `linkedin`. Anything else is a bare
`404` with no body.

**Request**

```http
GET /waitlist/connect/github?token=3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d HTTP/1.1
Host: social-vibecoding.usernodelabs.org
```

| Query | Required | Notes |
|---|---|---|
| `token` | **yes** | The signup's `more_token`. |

This is a browser redirect endpoint, meant to be navigated to rather
than fetched. It always answers `302`, never JSON.

| Outcome | `Location` |
|---|---|
| Started | The provider's authorize page (`https://github.com/login/oauth/authorize?…`, `https://x.com/i/oauth2/authorize?…`, `https://www.linkedin.com/oauth/v2/authorization?…`). |
| Unknown token | `/#landing` |
| Provider not configured on this deployment | `/#more/<token>?connect=unavailable` |

The `more_token` never reaches the provider. It is parked in a
server-side record keyed by a random nonce, and only that nonce travels
as the OAuth `state`, so the capability appears in no provider URL and
no referer header. The record lives 10 minutes. X uses PKCE with the
verifier held server-side.

Scopes are the smallest that resolve an identifier: GitHub with
`allow_signup=false`, X with `users.read tweet.read`, LinkedIn with
`openid profile` (deliberately not `email`, since the waitlist row
already has an address).

### GET /waitlist/connect/:provider/callback

The provider's redirect target. You do not call this; the provider does.
It is documented because its outcomes land back on a URL your
integration may need to read.

It exchanges the authorization code, stores the resolved handle under
`answers.verified.<provider>`, and redirects back to the stage-2 form.

**Response `302`**

```http
HTTP/1.1 302 Found
Location: /#more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d?connect=ok
```

| `connect` value | Meaning |
|---|---|
| `ok` | The handle was verified and stored. |
| `denied` | The person declined on the provider's page (no code came back). |
| `unavailable` | The provider is not configured on this deployment. |
| `failed` | The token exchange or profile read failed. |

The status rides in a query segment **inside** the fragment, after the
`#`, so it never reaches any server log, the platform's or a proxy's.

Two redirects carry no `connect` value and land on `/#landing` instead:
an unknown or expired `state` (nothing identifies which signup to
return to), and a successful exchange whose token no longer resolves to
a signup.

Re-requesting a callback URL is safe. A finished round trip remembers
where it landed for 10 minutes, so a reload, a back button or a link
scanner replays the same redirect rather than falling through to the
landing page. The replay is a redirect and nothing else; the
authorization code is never re-exchanged and is never stored.

## Rate limits

Every throttle answers `429` with the same body shape:

```json
{
  "error": "Too many requests for this link. Try again in a few minutes.",
  "retryAfterSeconds": 214
}
```

`retryAfterSeconds` is an integer count of seconds until the window
resets. Wait that long before retrying. There is no `code` field on a
throttle response, deliberately, so treat the status plus
`retryAfterSeconds` as the contract and the `error` string as display
text that may be reworded.

Responses also carry the IETF `draft-7` standard headers:

```
RateLimit: limit=240, remaining=239, reset=847
RateLimit-Policy: 240;w=900
```

Read `RateLimit` for the live budget rather than counting requests
yourself. Legacy `X-RateLimit-*` headers are not sent.

Every window below is **15 minutes**.

| Bucket | Budget | Keyed on | Applies to |
|---|---|---|---|
| `waitlist-join` | 5 | Caller IP address | `POST /api/public/waitlist` with no valid integrator key. |
| `waitlist-join-client` | 200 | Integrator label | `POST /api/public/waitlist` with a valid key. |
| `waitlist-join-client-user` | 5 | Integrator label plus forwarded visitor address | `POST /api/public/waitlist` with a valid key **and** a usable `X-Waitlist-Client-IP`. Charged in addition to the client ceiling. |
| `waitlist-token` | 240 | The 48-hex path token | Every token route: the confirm link, the stage-2 read and the stage-2 save. Falls back to the caller IP where there is no path token, which is how `POST /api/public/waitlist/confirm` is covered. |
| `waitlist-token-scan` | 40, **failures only** | Caller IP address | The same token routes plus `POST /api/public/waitlist/confirm`. Anything that finishes under `400` is refunded. |
| `waitlist-code-confirm` | 10 | SHA-256 of the normalised email | `POST /api/public/waitlist/confirm`. |

Three consequences worth designing around:

1. **Token routes are keyed on the token, not on your address.** One
   real journey (join, save, click the emailed confirm, reload the
   survey) is five or more requests, and 240 per token per 15 minutes is
   sized for that with room to spare. A shared exit address, an office,
   a carrier NAT or a corporate proxy will not put your visitors in one
   another's bucket.
2. **The scan bucket only counts failures.** `waitlist-token-scan` is
   the half that bounds token guessing, and `skipSuccessfulRequests`
   refunds every response under `400`. A caller holding a real token
   essentially never fails and will never approach 40. A caller
   presenting tokens that 404 will hit it in 40 requests, whatever
   tokens they present. So: **do not poll with a token you are not sure
   about**, and stop on the first `404` rather than retrying it.
3. **The code bucket is per address.** Ten wrong six-digit guesses for
   one email address in 15 minutes exhausts it, and the code itself dies
   after 5 wrong attempts regardless.

IPv6 callers are bucketed by subnet prefix rather than by exact address,
so rotating within a `/56` does not buy a fresh budget.

## Trusted integrator headers

`POST /api/public/waitlist` is an anonymous write, so its default bound
is 5 joins per 15 minutes per address. That is right for a visitor
typing their own address into a landing page and wrong for a partner
running the signup form on their own site: every one of their visitors
arrives from the same server address, so the sixth real person in a
window is refused.

Two headers fix that, and only for callers the operator has named.

### `X-Waitlist-Client-Key`

A shared secret issued by the operator, configured server-side as a
comma-separated list of `label:secret` pairs in
`WAITLIST_INTEGRATION_KEYS`. Send the **secret** only:

```http
X-Waitlist-Client-Key: s3cret-one
```

When it matches, the anonymous per-IP bucket no longer applies and the
200-per-15-minutes client ceiling applies instead, keyed on your label.

Four properties to build against:

- **It is not an exemption.** A leaked key is a bounded faucet, not an
  open one.
- **It is not required.** Unset means the feature is off and every
  caller is anonymous.
- **A wrong, stale or malformed key is not an error.** The request stays
  anonymous and gets the ordinary 5-per-window budget. You will get a
  `429` at the sixth join rather than a `401`, so if a partner form
  starts throttling unexpectedly, suspect the key before suspecting the
  endpoint.
- **It grants no read access to anything.** It is a rate-limit key and
  nothing more. The same validation, the same dedupe, the same mail and
  the same non-enumeration contract apply.

The secret is compared over SHA-256 digests with a constant-time
comparison, and neither the secret nor the header is ever logged.

### `X-Waitlist-Client-IP`

The end user's own address, honoured **only** after the key matched:

```http
X-Waitlist-Client-IP: 203.0.113.42
```

When it parses as an IP address, two things happen. That visitor gets
their own 5-per-15-minutes sub-budget, so one bad actor cannot spam the
list through your integration, and it is that address the signup row
records instead of your proxy's. Without it there is nothing finer to
key on and the client ceiling is your only bound.

Send it. A keyed request with a forwarded address is never looser for
the person making it than a direct visit would be, and it is what keeps
the platform's own abuse signals meaningful for your traffic.

## Errors

| Status | When |
|---|---|
| `200` | Success. Waitlist JSON responses carry `ok: true`. |
| `302` | The two redirect endpoints: the confirm link and the connect round trip. |
| `404` | A token that is malformed or resolves to no signup, or an unknown provider. Bodies are `{"error":"Unknown or expired link."}` except for the provider `404`, which has no body. |
| `422` | Validation. The body's `error` is a human-readable sentence intended for display. |
| `429` | Throttled. Body carries `error` and `retryAfterSeconds`. |
| `500` | `{"error":"Internal server error"}`. Safe to retry with backoff. |

There is no `401` or `403` anywhere in this API. A caller either holds a
valid token or does not, and not holding one is a `404`.

Two non-enumeration contracts are load-bearing, and both mean that a
failure you might expect to be specific is deliberately not:

- Joining with an address already on the list returns the same `200` as
  a fresh join.
- Every code-confirmation failure returns one identical `422`.

Build against those rather than around them. They will not become more
specific.

## A full worked flow

An agency running its own signup page, server side.

**1. Cache the option definitions at boot.**

```bash
curl -s https://social-vibecoding.usernodelabs.org/api/public/waitlist/options
```

**2. Post a visitor's signup, forwarding their address.**

```bash
curl -s https://social-vibecoding.usernodelabs.org/api/public/waitlist \
  -H 'Content-Type: application/json' \
  -H 'X-Waitlist-Client-Key: s3cret-one' \
  -H 'X-Waitlist-Client-IP: 203.0.113.42' \
  -d '{"email":"ada@example.com","discovery_source":"friend","country":"GB"}'
```

```json
{
  "ok": true,
  "message": "You're on the waitlist. We'll email you when access opens up.",
  "more_token": "3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d"
}
```

Store `more_token` against your own record of this visitor if you intend
to show them their status later. It is the only time the join returns
it. If it comes back `null`, that address was already on the list and
there is no token to keep.

**3. The visitor confirms.** They click the link in the platform's mail,
or type the six-digit code into your page and you post it:

```bash
curl -s https://social-vibecoding.usernodelabs.org/api/public/waitlist/confirm \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","code":"409132"}'
```

```json
{ "ok": true, "more_token": "3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d" }
```

**4. Save whatever stage-2 answers your form collected.**

```bash
curl -s -X POST \
  https://social-vibecoding.usernodelabs.org/api/public/waitlist/more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d \
  -H 'Content-Type: application/json' \
  -d '{"group_name":"North London Weavers","group_size":"10-50","group_role":"organizer"}'
```

```json
{ "ok": true, "message": "Saved, thanks. You can come back and add to this any time." }
```

**5. Show them where they stand.**

```bash
curl -s 'https://social-vibecoding.usernodelabs.org/api/public/waitlist/more/3f6c1a08b2d94e7f5a0c8e1d2b4f6a9c0e3d5b7f1a2c4e6d?view=status'
```

```json
{
  "ok": true,
  "admitted": false,
  "status": {
    "state": "confirmed",
    "admitted": false,
    "confirmed": true,
    "has_account": false,
    "joined_at": "2026-08-30T09:14:02.881Z",
    "confirmed_at": "2026-08-30T09:16:44.107Z",
    "admitted_at": null
  }
}
```

Read the top-level `admitted` if that is all you need. Read
`status.state` for the three-way distinction. Stop polling once it
leaves `pending`, and re-read it on a much slower schedule after that,
since the move to `admitted` happens on operator time rather than user
time.

## See also

- [SELF-HOSTING.md](../SELF-HOSTING.md), "Waitlist social connect" and
  "Waitlist trusted integrators", for the operator side: which
  environment variables configure the OAuth providers, how integrator
  keys are issued, and the provider-by-provider setup runbooks.
