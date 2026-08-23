'use strict';

/**
 * Reader for `dapp.json` — the per-dapp manifest declaring which env
 * vars the dapp needs at runtime.
 *
 * Lives in the dapp repo root, alongside Dockerfile and package.json. The
 * platform reads it from the freshly-cloned working tree on every deploy
 * (createApp / buildAndDeployStaging / rebuildProduction) so the manifest
 * is always the current code's source of truth. It is NEVER snapshotted
 * into the platform DB — staleness is a guaranteed pain we don't want.
 *
 * Shape:
 *   {
 *     "secrets": [
 *       {
 *         "key": "ECHO_APP_SECRET_KEY",       // env var name
 *         "description": "...",               // human help text for UI
 *         "required": true,                   // deploy blocks if unset
 *         "private": true,                    // encrypted at rest, never
 *                                             // returned by API, AND not
 *                                             // propagated from prod into
 *                                             // staging — sibling to
 *                                             // staging:private for SQL.
 *                                             // See app-conventions.md.
 *         "default": "...",                   // applied if no stored value
 *         "staging_default": "..."            // committed staging fallback
 *                                             // for private entries.
 *                                             // Wins over `default` in
 *                                             // staging.
 *       },
 *       ...
 *     ]
 *   }
 *
 * `sensitive: true` is accepted as a backward-compatible alias for
 * `private: true` — the canonical field is `private`. Existing
 * dapp.json files written before the rename keep working unchanged.
 *
 * Missing file or unparseable JSON is treated as `{ secrets: [] }` — i.e.
 * exactly the legacy behavior. The platform never refuses to deploy on
 * an absent manifest; only on declared-required-but-unset values.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const usernames = require('./usernames');
const { validatePath } = require('./testing-notes');

const MANIFEST_FILENAME = 'dapp.json';

// #47: per-app automated tests (the "CI for proposals" framework). Each
// test navigates one staging route and asserts load + no-console-errors
// (+ optional selector/text).
//
// THE READER NO LONGER CAPS AT 12. It used to keep only the first
// MAX_TESTS entries, which meant this repo's own 240-odd declared checks
// were 12 real ones and 229 pieces of decoration — never parsed, never
// run, never able to fail. The capture container now runs EVERY declared
// check through a bounded parallel page pool (capture/capture.js), so the
// only remaining bound is a validation ceiling that keeps a pathological
// manifest from queueing an unbounded suite. Entries past the ceiling are
// dropped and logged, and services/visuals.js turns "this proposal pushed
// the list past the ceiling" into a blocking check row so the silent-drop
// bug cannot come back.
//
// Raised 300 → 400 (PR #1125). This repo's own manifest crossed 300 and the
// tail — including the two `?shot=feedback-*` checks added for #1054 — was
// being dropped, which turns the over-ceiling guard into a blocker on every
// subsequent proposal rather than a warning about a pathological manifest.
// 400 checks still finish inside the capture budget: at the ~3.9s marginal
// cost per check over a pool of 8 that is ~195s of ideal work against a
// 420s TESTS_DEADLINE_MS, the 2x margin tests/checks-budget.test.js pins.
// Raising it further means raising that deadline (and the container run
// timeout above it) in the same change.
const MAX_DECLARED_TESTS = 400;

// The pre-pool cap, kept for exactly one purpose: services/check-history.js
// bootstraps an app with no recorded history by marking its first
// LEGACY_GATING_HEAD declared checks as already-graduated, so the set of
// checks that block a merge on the first build after this ships is exactly
// the set that blocked one before it. Nothing else reads it, and no check
// needs to sit near the top of the array any more.
const LEGACY_GATING_HEAD = 12;
// Deprecated alias — `MAX_TESTS` meant "the parse cap" and there is no
// parse cap now. Exported so a stale reference resolves to something sane
// rather than `undefined`.
const MAX_TESTS = LEGACY_GATING_HEAD;
const MAX_TEST_NAME_LEN = 120;
const MAX_TEST_SELECTOR_LEN = 256;
const MAX_TEST_TEXT_LEN = 256;

// Normalize the optional top-level `tests` array. Each entry must carry a
// valid `path` (same rules as a testing-block path: relative, single
// leading slash, no scheme/whitespace/markup). `name` falls back to the
// path. `expectSelector` / `expectText` are optional presence assertions;
// `allowConsoleErrors` opts a test out of the baseline no-console-errors
// rule (for a route that legitimately logs errors). Invalid entries are
// dropped, duplicate (name+path) pairs collapse, the list is bounded by
// MAX_DECLARED_TESTS. A non-array / absent block resolves to [] — exactly
// the legacy behaviour (no declared tests → the orchestrator synthesizes
// the baseline). Never throws.
//
// readTestsWithMeta is the same pass with its bookkeeping exposed, because
// the over-ceiling guard has to compare LIKE WITH LIKE: the ceiling applies
// to VALID, DE-DUPLICATED entries, so a manifest with 305 raw entries of
// which 290 survive validation has dropped nothing for ceiling reasons and
// must not be failed. `ceilingDropped` counts only the entries this pass
// refused because the list was already full.
function readTestsWithMeta(parsed) {
  const raw = Array.isArray(parsed?.tests) ? parsed.tests : [];
  const out = [];
  const seen = new Set();
  let invalidDropped = 0;
  let ceilingDropped = 0;
  for (const t of raw) {
    if (!t || typeof t !== 'object') { invalidDropped++; continue; }
    const p = validatePath(t.path);
    if (!p) { invalidDropped++; continue; }
    const name = (typeof t.name === 'string' && t.name.trim())
      ? t.name.trim().slice(0, MAX_TEST_NAME_LEN)
      : p;
    const dedupeKey = `${name}${p}`;
    if (seen.has(dedupeKey)) continue;
    if (out.length >= MAX_DECLARED_TESTS) { ceilingDropped++; continue; }
    seen.add(dedupeKey);
    out.push({
      name,
      path: p,
      expectSelector: typeof t.expectSelector === 'string' && t.expectSelector.trim()
        ? t.expectSelector.trim().slice(0, MAX_TEST_SELECTOR_LEN) : null,
      expectText: typeof t.expectText === 'string' && t.expectText.trim()
        ? t.expectText.trim().slice(0, MAX_TEST_TEXT_LEN) : null,
      allowConsoleErrors: !!t.allowConsoleErrors,
    });
  }
  const dropped = invalidDropped + ceilingDropped;
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-ceiling test entries', {
      dropped, invalidDropped, ceilingDropped, kept: out.length, ceiling: MAX_DECLARED_TESTS,
    });
  }
  return { tests: out, rawCount: raw.length, ceilingDropped };
}

function readTests(parsed) {
  return readTestsWithMeta(parsed).tests;
}

// The durable identity of one declared check, and the ONLY thing the
// per-check history is keyed by (services/check-history.js). It is the
// same (name + path) pair readTests already de-duplicates on, hashed so
// the column is fixed-width regardless of how long a check's name is.
//
// Consequence, and it is deliberate: renaming or re-pathing a check mints
// a NEW key, so the check drops back to advisory and has to be observed
// passing again before it can block a merge. An edited check is a new
// check as far as "has this ever actually worked?" is concerned.
function checkKey(name, path) {
  return crypto.createHash('sha256')
    .update(`${String(name == null ? '' : name)}\n${String(path == null ? '' : path)}`)
    .digest('hex');
}

// Reserved keys the platform owns. A manifest entry using one of these
// is rejected on read so a dapp can't shadow / spoof the platform-injected
// values that all dapps depend on.
const RESERVED_KEYS = new Set([
  'DATABASE_URL',
  // The RS256 public key user tokens are verified against, and the app's
  // own integer id (the audience the platform mints for). Reserved for the
  // same reason as JWT_SECRET: a manifest that shadowed either could point
  // the container's verifier at an attacker-controlled key or make it
  // accept identities minted for a different app.
  'USERNODE_JWT_PUBLIC_KEY',
  'USERNODE_APP_ID',
  // Retired alias of USERNODE_JWT_PUBLIC_KEY (holds the same public PEM),
  // still injected so pre-cutover scaffolds verify unchanged. The
  // RESERVATION OUTLIVES THE INJECTION: even after app-identity-env.js
  // stops setting this name (see the removal criterion there), a manifest
  // must never be able to introduce it — an app that still reads
  // JWT_SECRET would then be handed an attacker-chosen verification key.
  'JWT_SECRET',
  // Same public PEM again, under the platform's own env-var name — see
  // services/app-identity-env.js. Reserved for the same reason.
  'IFRAME_JWT_PUBLIC_KEY',
  'PORT',
  'USERNODE_ENV',
  'USERNODE_MISSING_SECRETS',
  'USERNODE_LLM_PROXY_URL',
  'USERNODE_LLM_PROXY_TOKEN',
  'USERNODE_STORAGE_URL',
  'USERNODE_STORAGE_TOKEN',
  'USERNODE_PLATFORM_API_URL',
]);

// Reserved prefixes for the LLM-proxy (issue #34), app-storage (#752),
// and app-platform-API (#744) env-var families — any future
// USERNODE_LLM_PROXY_* / USERNODE_STORAGE_* / USERNODE_PLATFORM_API_*
// addition stays platform-owned without another set entry.
const RESERVED_KEY_PREFIXES = ['USERNODE_LLM_PROXY', 'USERNODE_STORAGE', 'USERNODE_PLATFORM_API'];

const KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// ---------------------------------------------------------------------------
// platform_env: the platform's own environment-variable manifest.
//
// This block is read ONLY from the self-hosted platform repo's dapp.json.
// It is deliberately separate from `secrets`, which describes a *child
// dapp's* container env and is merged by services/app-secrets.js at
// deploy time. Nothing in the child-dapp path reads platform_env, and
// mergeForDeploy() never learns about it — that containment is the whole
// point: a value declared here lands in the VPS `.env` of the platform
// process, never in a dapp container.
// ---------------------------------------------------------------------------

// Keys that may be *declared* (so the admin console can show them and the
// pre-merge check can reason about them) but can NEVER be written through
// the admin UI or resolved from the platform_env store at deploy time.
// These are the platform's structural identity and credentials: they are
// injected by .github/workflows/deploy.yml straight from GitHub secrets,
// or computed by the deploy itself. Letting an admin overwrite one from a
// web form would be a privilege-escalation path (rotate JWT_SECRET →
// forge any session; rewrite DATABASE_URL → point the platform at an
// attacker's Postgres), so writes are refused at the DAO, the route, and
// the UI. Declaring one is fine and useful: it documents the variable.
const PLATFORM_ENV_UNWRITABLE = new Set([
  // Reserved / structural.
  'DATABASE_URL',
  'PORT',
  'USERNODE_ENV',
  'GIT_SHA',
  // Auth + session crypto.
  //
  // DATA_ENCRYPTION_KEY is the load-bearing one: services/secrets.js
  // derives its AES-256-GCM key from it, and platform_env_values.value_enc
  // is itself encrypted with it. A console-settable data key is therefore
  // circular — the store would need the key to read the key — and changing
  // the value silently orphans every BYOK key and app secret at rest
  // (decrypt() returns null; nothing throws). It can only come from the
  // deploy.
  //
  // The other four are signing keys: rewriting one from a web form would
  // let an admin mint app identities, worker tokens or edge cookies at
  // will. JWT_SECRET no longer signs anything in the platform process, but
  // the deploy's own secret of that name still holds the same bytes as
  // DATA_ENCRYPTION_KEY, so it stays listed too. (The JWT_SECRET a child
  // container receives is a different thing entirely — the RSA public
  // PEM, injected by services/app-identity-env.js.)
  'DATA_ENCRYPTION_KEY',
  'IFRAME_JWT_PRIVATE_KEY',
  'IFRAME_JWT_PUBLIC_KEY',
  'WORKER_JWT_SECRET',
  'EDGE_JWT_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  // Database and GitHub App credentials.
  'USERNODE_DB_PASSWORD',
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_BOT_TOKEN',
  // Model access and the platform's own dapp keypair.
  'ANTHROPIC_API_KEY',
  'USERNODE_APP_PUBKEY',
  'USERNODE_APP_SECRET_KEY',
  // Ingress / TLS, owned by the Caddy half of the deploy.
  'USERNODE_DOMAIN',
  'ZEROSSL_API_KEY',
  'ZEROSSL_EAB_KID',
  'ZEROSSL_EAB_HMAC',
  'ACME_DNS_PROVIDER',
  'ACME_DNS_API_TOKEN',
]);

const MAX_PLATFORM_ENV = 200;
const MAX_PLATFORM_ENV_DESC_LEN = 400;
const MAX_PLATFORM_ENV_GROUP_LEN = 48;
const MAX_PLATFORM_ENV_DEFAULT_LEN = 2048;

// Normalize the optional top-level `platform_env` array. Follows the same
// lenient contract as every other reader here: never throws, drops what it
// can't understand with a log.warn, and resolves an absent/invalid block to
// [] so a platform repo without the block behaves exactly as it did before
// this feature existed.
//
// Entry shape: { key, description?, required?, private?, group?, default? }.
// `unwritable` is derived, not declared — a manifest cannot opt a key out of
// PLATFORM_ENV_UNWRITABLE, only into it by naming one of those keys.
function readPlatformEnv(parsed) {
  const raw = Array.isArray(parsed?.platform_env) ? parsed.platform_env : [];
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const e of raw) {
    if (!e || typeof e !== 'object') { dropped++; continue; }
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!KEY_RE.test(key)) {
      log.warn('app-manifest', 'Skipping invalid platform_env key', { key: e.key });
      dropped++;
      continue;
    }
    // Note: RESERVED_KEYS is NOT a rejection here the way it is for
    // `secrets`. Those keys are reserved against *dapps* shadowing the
    // platform; the platform declaring its own DATABASE_URL is legitimate
    // documentation. They land as unwritable instead.
    if (seen.has(key)) {
      log.warn('app-manifest', 'Skipping duplicate platform_env key', { key });
      dropped++;
      continue;
    }
    if (out.length >= MAX_PLATFORM_ENV) { dropped++; continue; }
    seen.add(key);
    const unwritable = PLATFORM_ENV_UNWRITABLE.has(key)
      || RESERVED_KEYS.has(key)
      || RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p));
    out.push({
      key,
      description: typeof e.description === 'string'
        ? e.description.slice(0, MAX_PLATFORM_ENV_DESC_LEN) : '',
      required: !!e.required,
      private: !!e.private || !!e.sensitive,
      group: typeof e.group === 'string' && e.group.trim()
        ? e.group.trim().slice(0, MAX_PLATFORM_ENV_GROUP_LEN) : 'General',
      // Documentation of the compiled-in fallback, shown in the admin UI
      // as "defaults to X". Never applied as a value — the deploy's own
      // `${{ vars.X || 'default' }}` expressions remain authoritative.
      default: typeof e.default === 'string'
        ? e.default.slice(0, MAX_PLATFORM_ENV_DEFAULT_LEN) : null,
      unwritable,
    });
  }
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-cap platform_env entries', {
      dropped, kept: out.length, cap: MAX_PLATFORM_ENV,
    });
  }
  return out;
}

// Bounds for the optional top-level `name` field (see readName). Matches
// the rename flow's MAX_APP_NAME_LENGTH so a hand-written manifest name
// can't outrun the apps.name column or the rename UI's validation.
const MAX_APP_NAME_LENGTH = 64;
const MIN_APP_NAME_LENGTH = 1;

// Normalize a raw top-level `name` into a trimmed string or null. Anything
// that isn't a string, is empty after trimming, or busts the length bound
// resolves to null — i.e. "no manifest name", so the platform name (the
// apps.name column) stays the effective display name. Never throws.
function readName(parsed) {
  const raw = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  if (raw.length < MIN_APP_NAME_LENGTH || raw.length > MAX_APP_NAME_LENGTH) return null;
  return raw;
}

// Allowed values for the optional top-level `visibility` block (issue
// #124). `build` maps to apps.collab_visibility, `view` to
// apps.view_visibility — same value set as the DB columns.
const VISIBILITY_VALUES = new Set(['public', 'private']);

// Normalize the optional top-level `visibility` block:
//   "visibility": { "build": "public"|"private", "view": "public"|"private" }
// Each axis resolves independently to 'public', 'private', or null
// (= leave the platform value untouched — the same absent-field
// semantics as the top-level `name`). Lenient like the rest of the
// reader: a non-object block, an absent key, or any other value drops
// to null with a warn. Returns null when the block is absent or
// carries nothing usable. Never throws.
function readVisibility(parsed) {
  const raw = parsed?.visibility;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object visibility block');
    return null;
  }
  const norm = (axis) => {
    const v = raw[axis];
    if (v == null) return null;
    if (typeof v === 'string' && VISIBILITY_VALUES.has(v)) return v;
    log.warn('app-manifest', 'Ignoring invalid visibility value', { axis, value: v });
    return null;
  };
  const build = norm('build');
  const view = norm('view');
  if (build == null && view == null) return null;
  return { build, view };
}

// Human description of a (collab, view) visibility pair — shared by the
// reconcile chat message and the visibility-PR title so every surface
// describes the same state with the same words. Matches the wording the
// old direct-PATCH route used.
function describeVisibility(collab, view) {
  if (collab === 'public') return 'public';
  return view === 'private'
    ? 'private (collaborators only)'
    : 'invite-only build, public to view';
}

// Allowed values for the optional top-level `governance` block (issue
// #646). `approvers` maps to apps.approver_policy; `approvals` maps to
// apps.approvals_required (NULL = the default time-&-majority
// strategy, N = "at least N" mode).
const APPROVER_POLICY_VALUES = new Set(['anyone', 'invited']);
const MAX_APPROVALS_REQUIRED = 50;

// Normalize the optional top-level `governance` block:
//   "governance": {
//     "approvers": "anyone" | "invited",
//     "approvals": "default" | { "atLeast": 1 }
//   }
// Each axis resolves independently:
//   - approvers → 'anyone' | 'invited' | null (leave untouched),
//   - approvals → 'default' | <int 1..50> | null (leave untouched),
// with the same absent-field semantics as the `visibility` block.
// Lenient like the rest of the reader: a non-object block, an absent
// key, or any invalid value drops to null with a warn. Returns null
// when the block is absent or carries nothing usable. Never throws.
function readGovernance(parsed) {
  const raw = parsed?.governance;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object governance block');
    return null;
  }
  let approvers = null;
  if (raw.approvers != null) {
    if (typeof raw.approvers === 'string' && APPROVER_POLICY_VALUES.has(raw.approvers)) {
      approvers = raw.approvers;
    } else {
      log.warn('app-manifest', 'Ignoring invalid governance.approvers value', { value: raw.approvers });
    }
  }
  let approvals = null;
  if (raw.approvals != null) {
    if (raw.approvals === 'default') {
      approvals = 'default';
    } else if (raw.approvals && typeof raw.approvals === 'object' && !Array.isArray(raw.approvals)
      && Number.isInteger(raw.approvals.atLeast)
      && raw.approvals.atLeast >= 1 && raw.approvals.atLeast <= MAX_APPROVALS_REQUIRED) {
      approvals = raw.approvals.atLeast;
    } else {
      log.warn('app-manifest', 'Ignoring invalid governance.approvals value', { value: raw.approvals });
    }
  }
  if (approvers == null && approvals == null) return null;
  return { approvers, approvals };
}

// Human description of a (policy, approvalsRequired) governance pair —
// shared by the reconcile chat message and the governance-PR title so
// every surface describes the same state with the same words. Sibling
// of describeVisibility above.
function describeGovernance(policy, approvalsRequired) {
  const who = policy === 'invited' ? 'invited approvers' : 'any user';
  const howMany = approvalsRequired != null
    ? `at least ${approvalsRequired} approval${approvalsRequired === 1 ? '' : 's'}`
    : 'the default time-&-majority vote';
  return `approvals by ${who}, requiring ${howMany}`;
}

// Bounds for the optional top-level `admins` block (issue #788). The
// cap keeps a hand-written (or generated) manifest from turning into an
// unbounded roster; 255 mirrors the users.username column width.
const MAX_APP_ADMINS = 20;
const MAX_ADMIN_USERNAME_LENGTH = 255;

// Normalize the optional top-level `admins` block:
//   "admins": ["alice", "bob"]
// A bare array of platform usernames. Semantics deliberately differ
// from `icon` (fully authoritative including absence) and match
// `name` / `visibility` on the ABSENCE side only:
//   - absent key / null / non-array  -> null, i.e. "leave the platform
//     roster untouched" (a clean no-op for every app that never
//     declares the block);
//   - a valid array, INCLUDING []    -> the declared list, which the
//     reconcile treats as fully authoritative set semantics. `[]` is
//     therefore how a roster is cleared — without that, revocation
//     would be inexpressible.
// Entries are trimmed, dropped when empty / over-long / not a string,
// and deduped case-insensitively (first occurrence wins the display
// casing, since usernames are matched case-insensitively at reconcile
// time). Over-cap entries are dropped with a warn rather than silently
// truncated, per readTests. Lenient like the rest of the reader; never
// throws.
function readAdmins(parsed) {
  const raw = parsed?.admins;
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-array admins block', { value: typeof raw });
    return null;
  }
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!name || name.length > MAX_ADMIN_USERNAME_LENGTH) { dropped++; continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= MAX_APP_ADMINS) { dropped++; continue; }
    seen.add(key);
    out.push(name);
  }
  if (dropped > 0) {
    log.warn('app-manifest', 'Dropped invalid/over-cap admin entries', {
      dropped, kept: out.length, cap: MAX_APP_ADMINS,
    });
  }
  return out;
}

// Human description of a declared admin roster — shared by the
// reconcile chat message and any future admins-PR title so every
// surface describes the same state with the same words. Sibling of
// describeVisibility / describeGovernance.
function describeAdmins(usernames) {
  const list = Array.isArray(usernames) ? usernames.filter((u) => typeof u === 'string' && u.trim()) : [];
  if (!list.length) return 'no per-app admins (only the creator and platform admins)';
  return list.map((u) => `@${u}`).join(', ');
}

// Bound on the consent dialog's purpose line — one short sentence, not
// a marketing paragraph.
const MAX_LLM_PURPOSE_LENGTH = 140;

// Normalize the optional top-level `llm` block (issue #34) — consent
// metadata for the platform's app-LLM proxy:
//   "llm": {
//     "purpose": "Summarizes long threads for you",
//     "suggested_daily_cap_cents": 300
//   }
// `purpose` is shown in the platform's consent dialog; the suggested
// cap pre-fills the dialog's editable cap field (instead of the $1.00
// default). Both presentation-only — the dialog's server-side grant
// validation is the authority on what cap actually gets stored, and
// the user can always edit the pre-fill. Lenient like everything else
// here: garbage values (non-string purpose, non-positive or
// non-integer cap) are dropped, an absent/empty block resolves to
// null and the dialog falls back to generic copy. Never throws.
function readLlm(parsed) {
  const raw = parsed?.llm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const purpose = typeof raw.purpose === 'string' && raw.purpose.trim()
    ? raw.purpose.trim().slice(0, MAX_LLM_PURPOSE_LENGTH)
    : null;
  const cap = raw.suggested_daily_cap_cents;
  const suggestedCap = Number.isInteger(cap) && cap > 0 ? cap : null;
  if (purpose == null && suggestedCap == null) return null;
  const out = {};
  if (purpose != null) out.purpose = purpose;
  if (suggestedCap != null) out.suggested_daily_cap_cents = suggestedCap;
  return out;
}

// Allowed device-scale values for the optional top-level `screenshot`
// block (issue #360). The platform's before/after preview screenshots
// default to 2× (HiDPI/retina); an app declares `1` to opt its previews
// back to standard density (pixel art, deliberately low-res canvases).
const SCREENSHOT_SCALE_VALUES = new Set([1, 2]);
const DEFAULT_SCREENSHOT_SCALE = 2;

// Normalize the optional top-level `screenshot` block:
//   "screenshot": { "deviceScaleFactor": 1 }
// Resolves to a `{ deviceScaleFactor: 1 | 2 }` object. Default is 2×
// (HiDPI) for everything that says nothing — a non-object block, an
// absent/garbage `deviceScaleFactor`, or any value other than 1/2 drops
// to 2 (with a warn for an explicitly-invalid value). Always returns an
// object so the deploy-time reconcile always has a concrete scale to
// write. Lenient like the rest of the reader; never throws.
function readScreenshot(parsed) {
  const raw = parsed?.screenshot;
  if (raw == null) return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object screenshot block');
    return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  }
  const v = raw.deviceScaleFactor;
  if (v == null) return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
  if (typeof v === 'number' && SCREENSHOT_SCALE_VALUES.has(v)) {
    return { deviceScaleFactor: v };
  }
  log.warn('app-manifest', 'Ignoring invalid screenshot.deviceScaleFactor', { value: v });
  return { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE };
}

// Bounds for the optional top-level `icon` block. The emoji cap of 16
// UTF-16 code units covers ZWJ sequences (👨‍👩‍👧‍👦 is 11) without letting a
// paragraph through; ASCII is deliberately NOT banned — keycap emoji
// like 1️⃣ contain a digit, and a silly non-emoji string is harmless
// (it's the app's own tile and changes arrive via voted PRs). The
// image byte cap is generous for a tile rendered at 56 CSS px (112 px
// at 2×) while keeping the app_icons rows small.
const MAX_ICON_EMOJI_LENGTH = 16;
const MAX_ICON_IMAGE_PATH_LENGTH = 256;
const MAX_ICON_IMAGE_BYTES = 256 * 1024;

// Magic-byte sniffing for the icon image — the committed file's bytes,
// not its extension, decide the served Content-Type. SVG is deliberately
// absent: served inline it can execute script when navigated directly.
function sniffIconContentType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Validate the icon block's `image` value: a repo-relative file path.
// Anything absolute, traversing, scheme-ish, or containing whitespace /
// backslashes resolves to null (the realpath containment check in
// loadIconImage is the authoritative escape guard; this just rejects
// the obviously-wrong shapes early with a warn).
function normalizeIconImagePath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p || p.length > MAX_ICON_IMAGE_PATH_LENGTH) return null;
  if (p.startsWith('/') || p.includes('\\') || /\s/.test(p)) return null;
  if (p.includes('://') || p.startsWith('data:')) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return p;
}

// Normalize the optional top-level `icon` block:
//   "icon": { "emoji": "🎮" }  or  "icon": { "image": "public/icon.png" }
// Returns `{ emoji, image }` (each string-or-null) or null when the
// block is absent / carries nothing usable. Both keys are retained when
// both are valid — the image takes precedence at reconcile time, with
// the emoji as the fallback should the committed file fail validation.
// Lenient like the rest of the reader; never throws.
function readIcon(parsed) {
  const raw = parsed?.icon;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('app-manifest', 'Ignoring non-object icon block');
    return null;
  }
  let emoji = null;
  if (raw.emoji != null) {
    const e = typeof raw.emoji === 'string' ? raw.emoji.trim() : '';
    if (e.length >= 1 && e.length <= MAX_ICON_EMOJI_LENGTH && !/\s/.test(e)) {
      emoji = e;
    } else {
      log.warn('app-manifest', 'Ignoring invalid icon.emoji', { value: raw.emoji });
    }
  }
  let image = null;
  if (raw.image != null) {
    image = normalizeIconImagePath(raw.image);
    if (!image) log.warn('app-manifest', 'Ignoring invalid icon.image path', { value: raw.image });
  }
  if (emoji != null && image != null) {
    log.warn('app-manifest', 'icon declares both emoji and image; image takes precedence');
  }
  if (emoji == null && image == null) return null;
  return { emoji, image };
}

function read(cloneDir) {
  const filePath = path.join(cloneDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { name: null, secrets: [], llm: null, visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [] };
    log.warn('app-manifest', 'Read failed (treating as empty)', { filePath, err: err.message });
    return { name: null, secrets: [], llm: null, visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('app-manifest', 'Parse failed (treating as empty)', { filePath, err: err.message });
    return { name: null, secrets: [], llm: null, visibility: null, governance: null, screenshot: { deviceScaleFactor: DEFAULT_SCREENSHOT_SCALE }, tests: [], icon: null, admins: null, platform_env: [] };
  }

  const platformEnv = readPlatformEnv(parsed);
  const platformEnvKeys = new Set(platformEnv.map((e) => e.key));

  const secretsIn = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
  const seen = new Set();
  const secrets = [];

  for (const s of secretsIn) {
    if (!s || typeof s !== 'object') continue;
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    if (!KEY_RE.test(key)) {
      log.warn('app-manifest', 'Skipping invalid key', { filePath, key: s.key });
      continue;
    }
    if (RESERVED_KEYS.has(key) || RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      log.warn('app-manifest', 'Skipping reserved key', { filePath, key });
      continue;
    }
    // A key declared in BOTH blocks is a mistake with a dangerous failure
    // mode: `secrets` values are handed to a dapp container, platform_env
    // values are not. Rather than guess, platform_env wins and the
    // `secrets` entry is dropped — the containment guarantee (a
    // platform variable never leaks into a dapp's env) holds by
    // construction rather than by review.
    if (platformEnvKeys.has(key)) {
      log.warn('app-manifest', 'Skipping secrets key also declared in platform_env', { filePath, key });
      continue;
    }
    if (seen.has(key)) {
      log.warn('app-manifest', 'Skipping duplicate key', { filePath, key });
      continue;
    }
    seen.add(key);
    secrets.push({
      key,
      description: typeof s.description === 'string' ? s.description : '',
      required: !!s.required,
      // `private` is the canonical field; `sensitive` is accepted as
      // a backward-compatible alias. Either present (and truthy) flips
      // the entry to private. Internally we expose only `.private`.
      private: !!s.private || !!s.sensitive,
      default: typeof s.default === 'string' ? s.default : null,
      staging_default: typeof s.staging_default === 'string' ? s.staging_default : null,
    });
  }

  return {
    name: readName(parsed),
    secrets,
    llm: readLlm(parsed),
    visibility: readVisibility(parsed),
    governance: readGovernance(parsed),
    screenshot: readScreenshot(parsed),
    tests: readTests(parsed),
    icon: readIcon(parsed),
    admins: readAdmins(parsed),
    platform_env: platformEnv,
  };
}

/**
 * Write-through name resolution. Given a freshly-read manifest and the
 * app row it was read for, reconcile `apps.name` to the manifest's
 * top-level `name` when one is present and differs (case-sensitively)
 * from the stored name. This is how a `dapp.json` name takes precedence
 * over the platform name: it's resolved once, at deploy time, so the
 * large surface of display sites that read `apps.name` directly keeps
 * working unchanged.
 *
 * No-op (returns false) when the manifest carries no name — existing
 * apps with no `name` in `dapp.json` keep their platform name exactly.
 * Broadcasts the existing `app_update` `renamed` event on a real change
 * so connected clients update live (public/js/app.js handleAppUpdate).
 *
 * Best-effort and self-contained: a DB or WS hiccup here must never
 * fail the deploy that called it, so callers fire-and-log.
 */
async function reconcileAppName(pool, app, manifest) {
  const manifestName = manifest && typeof manifest.name === 'string' ? manifest.name : null;
  if (!manifestName) return false;
  const oldName = app.name || '';
  if (manifestName === oldName) return false;

  await pool.query('UPDATE apps SET name = $1 WHERE id = $2', [manifestName, app.id]);
  log.info('app-manifest', 'Reconciled app name from dapp.json', {
    appId: app.id, slug: app.slug, oldName, newName: manifestName,
  });

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'renamed',
      appId: app.id,
      slug: app.slug,
      oldName,
      newName: manifestName,
    });
  } catch (err) {
    log.warn('app-manifest', 'Rename broadcast failed', { appId: app.id, err: err.message });
  }
  return true;
}

/**
 * Apply a visibility change to an app row with the full transition
 * semantics the old direct-PATCH route had (issue #124 moved the
 * authority into dapp.json, so this now lives here, shared by the
 * deploy-time reconcile below and any future caller):
 *   - UPDATE both columns;
 *   - collab private→public: pending invites become meaningless —
 *     delete them, mark their drawer notifications read, ping clients;
 *   - flush the WS-broadcast / edge-gate visibility caches;
 *   - group-chat system message + `visibility_changed` app update;
 *   - VISIBILITY_CHANGED analytics event.
 * `app` must carry id, slug, collab_visibility, view_visibility (the
 * CURRENT values — used for the transition checks and the event's
 * `from`). All side effects beyond the column UPDATE are best-effort.
 */
async function applyVisibilityChange(pool, app, { collab, view }, { actorLabel = 'dapp.json', userId = null } = {}) {
  await pool.query(
    `UPDATE apps SET collab_visibility = $1, view_visibility = $2 WHERE id = $3`,
    [collab, view, app.id]
  );

  // collab private → public: pending invites become meaningless.
  // Delete them and resolve their drawer notifications.
  if (app.collab_visibility === 'private' && collab === 'public') {
    try {
      const { rows: pending } = await pool.query(
        `DELETE FROM app_collaborators WHERE app_id = $1 AND status = 'invited'
         RETURNING user_id`,
        [app.id]
      );
      const notifications = require('./notifications');
      const { pushNotificationToUser } = require('./ws');
      for (const p of pending) {
        await notifications.markInviteNotificationsRead(pool, p.user_id, app.id)
          .catch(() => {});
        try { pushNotificationToUser(p.user_id, { type: 'notifications_changed' }); } catch {}
      }
    } catch (err) {
      log.warn('app-manifest', 'Pending-invite cleanup failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./app-access').invalidateVisibility(app.id, app.slug);
  } catch (err) {
    log.warn('app-manifest', 'Visibility cache invalidation failed', { appId: app.id, err: err.message });
  }

  try {
    const { sendSystemMessage, pushAppUpdate } = require('./ws');
    await sendSystemMessage(pool, app.id,
      `This app's visibility changed to ${describeVisibility(collab, view)} (set by ${actorLabel})`,
      'system'
    ).catch((err) => log.warn('app-manifest', 'Visibility chat msg failed', { err: err.message }));
    pushAppUpdate({
      action: 'visibility_changed',
      appSlug: app.slug,
      appId: app.id,
      collabVisibility: collab,
      viewVisibility: view,
    });
  } catch (err) {
    log.warn('app-manifest', 'Visibility broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.VISIBILITY_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: { collab: app.collab_visibility, view: app.view_visibility },
        to: { collab, view },
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Visibility event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied visibility change', {
    appId: app.id, slug: app.slug, collab, view, actorLabel,
  });
}

/**
 * Deploy-time visibility reconcile — sibling of reconcileAppName. The
 * manifest's optional top-level `visibility` block is the source of
 * truth for apps.collab_visibility ("build") / apps.view_visibility
 * ("view"); an absent block / axis leaves the platform value untouched.
 *
 * Re-reads the app row fresh (callers pass rows of varying width and
 * the columns here must be current), resolves the target pair, and:
 *   - no-ops when nothing changes, when the manifest carries no
 *     visibility, or for self_hosted apps (the platform's own row stays
 *     out of repo control, matching the old PATCH route's refusal);
 *   - skips with a warn when the resolved pair violates the invariant
 *     (build=public AND view=private — the DB CHECK would reject it);
 *   - otherwise applies via applyVisibilityChange above.
 *
 * Best-effort like reconcileAppName: callers fire-and-log; a failure
 * here must never fail the deploy.
 */
async function reconcileAppVisibility(pool, app, manifest) {
  const vis = manifest?.visibility;
  if (!vis || (vis.build == null && vis.view == null)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, self_hosted, collab_visibility, view_visibility FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  if (cur.self_hosted) {
    log.warn('app-manifest', 'Skipping visibility reconcile for self-hosted app', { appId: cur.id });
    return false;
  }

  const collab = vis.build || cur.collab_visibility;
  const view = vis.view || cur.view_visibility;
  if (collab === cur.collab_visibility && view === cur.view_visibility) return false;

  if (collab === 'public' && view === 'private') {
    log.warn('app-manifest', 'Skipping invalid visibility combo from dapp.json', {
      appId: cur.id, slug: cur.slug, collab, view,
    });
    return false;
  }

  await applyVisibilityChange(pool, cur, { collab, view }, { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Apply a proposal-approval governance change to an app row (issue
 * #646) — sibling of applyVisibilityChange, shared by the deploy-time
 * reconcile below and any future caller:
 *   - UPDATE both columns;
 *   - policy invited→anyone: pending approver invites become
 *     meaningless — delete them, mark their drawer notifications read,
 *     ping clients (accepted 'member' rows are kept dormant so a later
 *     flip back to 'invited' restores the roster);
 *   - policy →invited with an EMPTY roster: auto-seed the app creator
 *     as an approver member so a child app can never lock itself out
 *     (the self-app has no created_by; the governed gate's full-admin
 *     fallback covers it);
 *   - flush the governance cache (services/governance.js);
 *   - group-chat system message + `governance_changed` app update;
 *   - GOVERNANCE_CHANGED analytics event.
 * `app` must carry id, slug, approver_policy, approvals_required (the
 * CURRENT values — used for transition checks and the event's `from`).
 * All side effects beyond the column UPDATE are best-effort.
 */
async function applyGovernanceChange(pool, app, { approverPolicy, approvalsRequired }, { actorLabel = 'dapp.json', userId = null } = {}) {
  await pool.query(
    `UPDATE apps SET approver_policy = $1, approvals_required = $2 WHERE id = $3`,
    [approverPolicy, approvalsRequired, app.id]
  );

  // invited → anyone: pending approver invites become meaningless.
  if (app.approver_policy === 'invited' && approverPolicy === 'anyone') {
    try {
      const { rows: pending } = await pool.query(
        `DELETE FROM app_approvers WHERE app_id = $1 AND status = 'invited'
         RETURNING user_id`,
        [app.id]
      );
      const notifications = require('./notifications');
      const { pushNotificationToUser } = require('./ws');
      for (const p of pending) {
        await notifications.markApproverInviteNotificationsRead(pool, p.user_id, app.id)
          .catch(() => {});
        try { pushNotificationToUser(p.user_id, { type: 'notifications_changed' }); } catch {}
      }
    } catch (err) {
      log.warn('app-manifest', 'Pending approver-invite cleanup failed', { appId: app.id, err: err.message });
    }
  }

  // anyone → invited with an empty roster: seed the creator so the
  // approval gate is never unreachable on a child app.
  if (approverPolicy === 'invited') {
    try {
      const { rows: members } = await pool.query(
        `SELECT 1 FROM app_approvers WHERE app_id = $1 AND status = 'member' LIMIT 1`,
        [app.id]
      );
      if (!members.length) {
        const { rows: creatorRows } = await pool.query(
          'SELECT created_by FROM apps WHERE id = $1', [app.id]
        );
        const creatorId = creatorRows[0]?.created_by || null;
        if (creatorId) {
          await pool.query(
            `INSERT INTO app_approvers (app_id, user_id, status, accepted_at)
             VALUES ($1, $2, 'member', NOW())
             ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member', accepted_at = COALESCE(app_approvers.accepted_at, NOW())`,
            [app.id, creatorId]
          );
          log.info('app-manifest', 'Auto-seeded app creator as approver', { appId: app.id, creatorId });
        }
      }
    } catch (err) {
      log.warn('app-manifest', 'Approver creator auto-seed failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./governance').invalidateGovernance(app.id);
  } catch (err) {
    log.warn('app-manifest', 'Governance cache invalidation failed', { appId: app.id, err: err.message });
  }

  try {
    const { sendSystemMessage, pushAppUpdate } = require('./ws');
    await sendSystemMessage(pool, app.id,
      `This app's proposal-approval settings changed to ${describeGovernance(approverPolicy, approvalsRequired)} (set by ${actorLabel})`,
      'system'
    ).catch((err) => log.warn('app-manifest', 'Governance chat msg failed', { err: err.message }));
    pushAppUpdate({
      action: 'governance_changed',
      appSlug: app.slug,
      appId: app.id,
      approverPolicy,
      approvalsRequired,
    });
  } catch (err) {
    log.warn('app-manifest', 'Governance broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.GOVERNANCE_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: { approverPolicy: app.approver_policy, approvalsRequired: app.approvals_required },
        to: { approverPolicy, approvalsRequired },
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Governance event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied governance change', {
    appId: app.id, slug: app.slug, approverPolicy, approvalsRequired, actorLabel,
  });
}

/**
 * Deploy-time governance reconcile (issue #646) — sibling of
 * reconcileAppVisibility. The manifest's optional top-level
 * `governance` block is the source of truth for apps.approver_policy
 * ("approvers") / apps.approvals_required ("approvals"); an absent
 * block / axis leaves the platform value untouched.
 *
 * Unlike the visibility reconcile, self_hosted apps are NOT skipped —
 * the platform's own app is the primary consumer (its apply point is
 * boot: db/migrate.js seedSelfApp calls this next to the name/icon
 * reconciles, since the self-app deploys via GitHub Actions and never
 * runs rebuildProduction).
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppGovernance(pool, app, manifest) {
  const gov = manifest?.governance;
  if (!gov || (gov.approvers == null && gov.approvals == null)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, approver_policy, approvals_required FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  const approverPolicy = gov.approvers || cur.approver_policy;
  // 'default' is the explicit spelling of the NULL column state.
  const approvalsRequired = gov.approvals == null
    ? cur.approvals_required
    : (gov.approvals === 'default' ? null : gov.approvals);

  if (approverPolicy === cur.approver_policy
    && (approvalsRequired ?? null) === (cur.approvals_required ?? null)) return false;

  await applyGovernanceChange(pool, cur, { approverPolicy, approvalsRequired }, { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Apply a per-app admin roster change (issue #788) — sibling of
 * applyVisibilityChange / applyGovernanceChange, shared by the
 * deploy-time reconcile below and any future caller:
 *   - replace the app_admins rows so they match `userIds` exactly;
 *   - persist the DECLARED name list (incl. names that resolved to no
 *     user) into apps.admin_usernames for the settings panel;
 *   - upsert an app_collaborators 'member' row for every resolved
 *     admin, so an admin of a build-private app can actually reach it
 *     (mirrors the creator auto-seed in applyGovernanceChange).
 *     Demotion deliberately does NOT remove collaborator rows —
 *     revoking collaboration stays a separate, explicit action;
 *   - flush the app-admin + visibility caches;
 *   - group-chat system message + `admins_changed` app update;
 *   - APP_ADMINS_CHANGED analytics event.
 * `app` must carry id, slug, admin_usernames (the CURRENT declared
 * list — used for the event's `from`). All side effects beyond the
 * roster writes are best-effort.
 */
async function applyAdminsChange(pool, app, { usernames, userIds }, { actorLabel = 'dapp.json', userId = null } = {}) {
  const ids = Array.isArray(userIds) ? userIds : [];
  const declared = Array.isArray(usernames) ? usernames : [];

  // Set semantics: the declared list is authoritative, so anything not
  // in it goes. `= ANY('{}')` is never true, so an empty list clears.
  await pool.query(
    `DELETE FROM app_admins WHERE app_id = $1 AND NOT (user_id = ANY($2::int[]))`,
    [app.id, ids]
  );
  if (ids.length) {
    await pool.query(
      `INSERT INTO app_admins (app_id, user_id)
         SELECT $1, uid FROM UNNEST($2::int[]) AS uid
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [app.id, ids]
    );
  }
  await pool.query(
    'UPDATE apps SET admin_usernames = $1::text[] WHERE id = $2',
    [declared, app.id]
  );

  // An admin who can't see the app is a broken grant — seed membership.
  if (ids.length) {
    try {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT $1, uid, 'member', NOW() FROM UNNEST($2::int[]) AS uid
         ON CONFLICT (app_id, user_id) DO UPDATE
           SET status = 'member',
               accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
        [app.id, ids]
      );
    } catch (err) {
      log.warn('app-manifest', 'App-admin collaborator seed failed', { appId: app.id, err: err.message });
    }
  }

  try {
    require('./app-admins').invalidateAppAdmins(app.id);
  } catch (err) {
    log.warn('app-manifest', 'App-admin cache invalidation failed', { appId: app.id, err: err.message });
  }
  try {
    require('./app-access').invalidateVisibility(app.id, app.slug);
  } catch (err) {
    log.warn('app-manifest', 'Visibility cache invalidation failed (admins)', { appId: app.id, err: err.message });
  }

  try {
    const { sendSystemMessage, pushAppUpdate } = require('./ws');
    await sendSystemMessage(pool, app.id,
      `This app's admins changed to ${describeAdmins(declared)} (set by ${actorLabel})`,
      'system'
    ).catch((err) => log.warn('app-manifest', 'Admins chat msg failed', { err: err.message }));
    pushAppUpdate({
      action: 'admins_changed',
      appSlug: app.slug,
      appId: app.id,
      admins: declared,
    });
  } catch (err) {
    log.warn('app-manifest', 'Admins broadcast failed', { appId: app.id, err: err.message });
  }

  try {
    const events = require('./events');
    events.record(pool, {
      type: events.EVENT_TYPES.APP_ADMINS_CHANGED,
      userId,
      appId: app.id,
      metadata: {
        from: Array.isArray(app.admin_usernames) ? app.admin_usernames : [],
        to: declared,
        source: 'manifest',
      },
    });
  } catch (err) {
    log.warn('app-manifest', 'Admins event record failed', { appId: app.id, err: err.message });
  }

  log.info('app-manifest', 'Applied app-admins change', {
    appId: app.id, slug: app.slug, declared, resolved: ids.length, actorLabel,
  });
}

/**
 * Deploy-time per-app admins reconcile (issue #788) — sibling of
 * reconcileAppVisibility / reconcileAppGovernance. The manifest's
 * optional top-level `admins` array is the source of truth for the
 * app_admins roster:
 *   - an ABSENT (or non-array) block leaves the roster untouched — a
 *     no-op for every app that never declares it;
 *   - a PRESENT array is fully authoritative, so `[]` clears the
 *     roster. That asymmetry is deliberate: without it, revocation
 *     would be inexpressible.
 *
 * Usernames are resolved case-insensitively (same precedent as the
 * collaborator invite route). A name matching no registered user is
 * NOT an error — it is kept in apps.admin_usernames so the settings
 * panel can show "declared, not a registered user", and it starts
 * granting the moment that person signs up and the app next deploys.
 *
 * Self-hosted apps are skipped with a warn, like the visibility
 * reconcile: the platform's own repo must never be able to mint app
 * admins (they'd inherit force-merge on platform proposals).
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppAdmins(pool, app, manifest) {
  const declared = manifest?.admins;
  if (!Array.isArray(declared)) return false;

  const { rows } = await pool.query(
    `SELECT id, slug, self_hosted, created_by, admin_usernames FROM apps WHERE id = $1`,
    [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  if (cur.self_hosted) {
    log.warn('app-manifest', 'Skipping admins reconcile for self-hosted app', { appId: cur.id });
    return false;
  }

  // Resolved through src/services/usernames.js, NOT with a plain
  // `LOWER(username) = ANY(...)` on `users` (#1336). A dapp.json lives in
  // somebody else's repository and the platform cannot rewrite it, so a
  // contributor who renames would otherwise silently lose admin on every
  // app that declares their old handle — the manifest keeps saying `alice`
  // long after alice became `ada`. resolveHandles reads the retired-handle
  // ledger alongside `users`, so an old declared name keeps resolving to
  // the same person; `declared` comes back as the name that MATCHED (old or
  // new), which is what keeps the unresolved diff below honest.
  let resolved = [];
  if (declared.length) {
    resolved = await usernames.resolveHandles(pool, declared);
  }
  const resolvedIds = resolved.map((r) => r.id).sort((a, b) => a - b);
  const resolvedNames = new Set(resolved.map((r) => r.declared));
  const unresolved = declared.filter((u) => !resolvedNames.has(u.toLowerCase()));
  if (unresolved.length) {
    log.warn('app-manifest', 'dapp.json admins name(s) match no registered user', {
      appId: cur.id, slug: cur.slug, unresolved,
    });
  }

  const { rows: existing } = await pool.query(
    'SELECT user_id FROM app_admins WHERE app_id = $1', [cur.id]
  );
  const existingIds = existing.map((r) => r.user_id).sort((a, b) => a - b);
  const curDeclared = Array.isArray(cur.admin_usernames) ? cur.admin_usernames : [];
  const sameIds = existingIds.length === resolvedIds.length
    && existingIds.every((id, i) => id === resolvedIds[i]);
  const sameDeclared = curDeclared.length === declared.length
    && curDeclared.every((n, i) => n === declared[i]);
  if (sameIds && sameDeclared) return false;

  await applyAdminsChange(pool, cur, { usernames: declared, userIds: resolvedIds },
    { actorLabel: 'dapp.json', userId: null });
  return true;
}

/**
 * Deploy-time screenshot-scale reconcile (issue #360) — sibling of
 * reconcileAppName / reconcileAppVisibility. The manifest's optional
 * top-level `screenshot.deviceScaleFactor` is the source of truth for
 * the density the platform captures this app's before/after preview
 * shots at; it persists into apps.screenshot_device_scale so the
 * capture orchestrator (visuals.captureForSession) can read it without
 * re-cloning. readScreenshot always returns a concrete scale (default
 * 2), so this writes on every deploy and no-ops only when the stored
 * value already matches.
 *
 * Best-effort like its siblings: callers fire-and-log; a failure here
 * must never fail the deploy.
 */
async function reconcileAppScreenshot(pool, app, manifest) {
  const scale = manifest?.screenshot?.deviceScaleFactor;
  if (scale !== 1 && scale !== 2) return false;

  const { rows } = await pool.query(
    'SELECT screenshot_device_scale FROM apps WHERE id = $1', [app.id]
  );
  if (!rows.length) return false;
  if (rows[0].screenshot_device_scale === scale) return false;

  await pool.query(
    'UPDATE apps SET screenshot_device_scale = $1 WHERE id = $2', [scale, app.id]
  );
  log.info('app-manifest', 'Reconciled screenshot scale from dapp.json', {
    appId: app.id, slug: app.slug, deviceScaleFactor: scale,
  });
  return true;
}

/**
 * Load + validate the icon image file the manifest points at, from the
 * freshly-cloned working tree. Returns `{ data, contentType, sha256 }`
 * or null on any validation failure (missing file, symlink escaping the
 * clone, oversized, unrecognized format) — always with a warn, never a
 * throw. The realpath containment check is the authoritative guard
 * against a committed symlink pointing outside the clone.
 */
async function loadIconImage(cloneDir, relPath, appSlug) {
  try {
    const rootReal = await fs.promises.realpath(cloneDir);
    let real;
    try {
      real = await fs.promises.realpath(path.resolve(rootReal, relPath));
    } catch {
      log.warn('app-manifest', 'Icon image file missing', { slug: appSlug, image: relPath });
      return null;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      log.warn('app-manifest', 'Icon image path escapes the repo', { slug: appSlug, image: relPath });
      return null;
    }
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || stat.size > MAX_ICON_IMAGE_BYTES) {
      log.warn('app-manifest', 'Icon image not a regular file or over size cap', {
        slug: appSlug, image: relPath, size: stat.size, cap: MAX_ICON_IMAGE_BYTES,
      });
      return null;
    }
    const data = await fs.promises.readFile(real);
    const contentType = sniffIconContentType(data);
    if (!contentType) {
      log.warn('app-manifest', 'Icon image is not PNG/JPEG/WebP/GIF', { slug: appSlug, image: relPath });
      return null;
    }
    return { data, contentType, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  } catch (err) {
    log.warn('app-manifest', 'Icon image load failed', { slug: appSlug, image: relPath, err: err.message });
    return null;
  }
}

/**
 * Deploy-time icon reconcile — sibling of reconcileAppName /
 * reconcileAppVisibility / reconcileAppScreenshot. The manifest's
 * optional top-level `icon` block is the source of truth for the
 * homescreen tile: an image file committed in the repo (stored into
 * app_icons, served at /app-icons/:id) or an emoji (apps.icon_emoji).
 *
 * Unlike `name`/`visibility` and like `screenshot`, the manifest is
 * FULLY authoritative: an absent block clears both columns and deletes
 * the app_icons row, restoring the letter-tile fallback. There is no
 * platform-side icon setter to clobber, so "what's in dapp.json is
 * what you get" holds unconditionally.
 *
 * Precedence: a valid, loadable image wins; the emoji applies when no
 * image is declared or the declared file fails validation; neither →
 * clear. A re-deploy with unchanged image bytes keeps the existing
 * app_icons id (the /app-icons/:id cache header is immutable, so the
 * id only rotates when the bytes change — rotation doubles as the
 * cache-buster).
 *
 * Broadcasts an `icon_changed` app update on a real change so open
 * home screens patch the tile in place (public/js/app.js
 * handleAppUpdate). Best-effort like its siblings: callers
 * fire-and-log; a failure here must never fail the deploy.
 */
async function reconcileAppIcon(pool, app, manifest, cloneDir) {
  const icon = manifest?.icon || null;

  let image = null;
  if (icon?.image && cloneDir) {
    image = await loadIconImage(cloneDir, icon.image, app.slug);
  }
  const emoji = !image && icon?.emoji ? icon.emoji : null;

  const { rows } = await pool.query(
    'SELECT icon_emoji, icon_image_id FROM apps WHERE id = $1', [app.id]
  );
  if (!rows.length) return false;
  const cur = rows[0];

  let imageId = null;
  if (image) {
    const { rows: iconRows } = await pool.query(
      'SELECT id, sha256 FROM app_icons WHERE app_id = $1', [app.id]
    );
    if (iconRows.length && iconRows[0].sha256 === image.sha256
      && cur.icon_image_id === iconRows[0].id) {
      // Unchanged bytes: keep the stored id so immutable caches stay valid.
      imageId = iconRows[0].id;
    } else {
      imageId = crypto.randomBytes(16).toString('hex');
      await pool.query('DELETE FROM app_icons WHERE app_id = $1', [app.id]);
      await pool.query(
        `INSERT INTO app_icons (id, app_id, content_type, data, sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [imageId, app.id, image.contentType, image.data, image.sha256]
      );
    }
  } else if (cur.icon_image_id) {
    await pool.query('DELETE FROM app_icons WHERE app_id = $1', [app.id]);
  }

  if ((cur.icon_emoji || null) === emoji && (cur.icon_image_id || null) === imageId) {
    return false;
  }

  await pool.query(
    'UPDATE apps SET icon_emoji = $1, icon_image_id = $2 WHERE id = $3',
    [emoji, imageId, app.id]
  );
  log.info('app-manifest', 'Reconciled app icon from dapp.json', {
    appId: app.id, slug: app.slug, emoji, imageId,
  });

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'icon_changed',
      appId: app.id,
      slug: app.slug,
      iconEmoji: emoji,
      iconUrl: imageId ? `/app-icons/${imageId}` : null,
    });
  } catch (err) {
    log.warn('app-manifest', 'Icon broadcast failed', { appId: app.id, err: err.message });
  }
  return true;
}

/**
 * Write-through reconciliation of the platform's own `platform_env`
 * declarations into `platform_env_declarations`.
 *
 * Mirrors the other reconcile* helpers: called once at boot from
 * seedSelfApp() with the manifest freshly read off the checked-out repo,
 * best-effort, and never allowed to break the caller. The DB table is a
 * *cache* of what the committed manifest says — it exists so the admin
 * console and the pre-merge check can query declarations by SQL without
 * re-reading the working tree, and so a stored value that no longer has a
 * declaration ("orphan") is detectable.
 *
 * Declarations are upserted; declarations that disappeared from the
 * manifest are deleted. Stored *values* are never touched here — losing a
 * declaration must not destroy the value, because the merge that removes
 * a variable and the deploy that stops using it are two different events,
 * and a rollback needs the value to still be there. The orphaned value
 * simply surfaces in the admin UI as "no longer declared".
 *
 * Returns { declared, added, removed } for logging. Throws only on a DB
 * error, which the caller is expected to swallow.
 */
async function reconcilePlatformEnv(pool, appId, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const keys = list.map((e) => e.key);

  const before = await pool.query(
    'SELECT key FROM platform_env_declarations WHERE app_id = $1',
    [appId]
  );
  const beforeKeys = new Set(before.rows.map((r) => r.key));

  for (const e of list) {
    await pool.query(
      `INSERT INTO platform_env_declarations
         (app_id, key, description, required, private, grouping, default_value, unwritable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (app_id, key) DO UPDATE SET
         description = EXCLUDED.description,
         required = EXCLUDED.required,
         private = EXCLUDED.private,
         grouping = EXCLUDED.grouping,
         default_value = EXCLUDED.default_value,
         unwritable = EXCLUDED.unwritable,
         updated_at = NOW()`,
      [appId, e.key, e.description || '', !!e.required, !!e.private,
        e.group || 'General', e.default ?? null, !!e.unwritable]
    );
  }

  // Delete declarations no longer in the manifest. `= ANY($2)` with an
  // empty array is valid SQL and removes everything, which is the correct
  // behaviour when the block was deleted wholesale.
  const removed = await pool.query(
    'DELETE FROM platform_env_declarations WHERE app_id = $1 AND NOT (key = ANY($2::text[])) RETURNING key',
    [appId, keys]
  );

  const added = keys.filter((k) => !beforeKeys.has(k));
  if (added.length || removed.rowCount) {
    log.info('app-manifest', 'Reconciled platform_env declarations', {
      appId, declared: keys.length, added, removed: removed.rows.map((r) => r.key),
    });
  }
  return { declared: keys.length, added, removed: removed.rows.map((r) => r.key) };
}

module.exports = {
  read,
  readName,
  readLlm,
  readVisibility,
  readGovernance,
  readScreenshot,
  readTests,
  readTestsWithMeta,
  checkKey,
  readIcon,
  readAdmins,
  readPlatformEnv,
  reconcilePlatformEnv,
  PLATFORM_ENV_UNWRITABLE,
  MAX_PLATFORM_ENV,
  MAX_TESTS,
  MAX_DECLARED_TESTS,
  LEGACY_GATING_HEAD,
  MAX_APP_ADMINS,
  MAX_ADMIN_USERNAME_LENGTH,
  MAX_ICON_EMOJI_LENGTH,
  MAX_ICON_IMAGE_BYTES,
  MAX_APPROVALS_REQUIRED,
  describeVisibility,
  describeGovernance,
  describeAdmins,
  reconcileAppName,
  reconcileAppVisibility,
  reconcileAppGovernance,
  reconcileAppScreenshot,
  reconcileAppIcon,
  reconcileAppAdmins,
  applyVisibilityChange,
  applyGovernanceChange,
  applyAdminsChange,
  RESERVED_KEYS,
  RESERVED_KEY_PREFIXES,
  KEY_RE,
  MANIFEST_FILENAME,
  MAX_APP_NAME_LENGTH,
  MIN_APP_NAME_LENGTH,
};
