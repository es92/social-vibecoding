// Which transport actually sends, and what the admin console is told
// about it.
//
// Order of decisions, most binding first:
//
//  1. USERNODE_ENV=staging → ALWAYS the log transport. A staging preview
//     is a clone of production data (see the staging-privacy convention in
//     src/db/schema.sql), so it may hold real email addresses. Letting a
//     preview reach a real provider would mail real people from a branch
//     nobody voted on yet. This is the single-outbound-boundary use of the
//     staging gate — no feature is disabled, only delivery.
//  2. An explicit PLATFORM_MAIL_PROVIDER (gmail | http | log) → that one,
//     or null if it isn't configured. An operator who names a provider
//     wants to know it's broken, not to be silently downgraded.
//  3. auto (the default) → gmail, then http. If neither is configured:
//     null in production (so mailer's loud "NOT delivered" error fires and
//     Global Constraints #6 keeps the code out of the production log), and
//     the log transport outside production, so a developer can read codes
//     out of the console.
//
// A partially-configured provider is never a candidate: each transport's
// create() logs the missing keys and returns null, and selection falls
// through.
'use strict';

const log = require('../logger');
const gmail = require('./transports/gmail');
const httpApi = require('./transports/http-api');
const logTransport = require('./transports/log');

// The single sender address for all platform mail. Committed as the
// default so a fresh deploy has a correct From without an operator
// setting anything — but the mailbox behind it still has to be
// authorised with the provider before a send succeeds.
const DEFAULT_FROM = 'Homeroom <no-reply@onhomeroom.com>';

const PROVIDERS = ['gmail', 'http', 'log'];

function isStaging(env) {
  return (env && env.USERNODE_ENV) === 'staging';
}

function isProduction(env) {
  const e = env || {};
  return e.USERNODE_ENV === 'production' || e.NODE_ENV === 'production';
}

// PLATFORM_MAIL_FROM is the modern key; TOPOCHAIN_MAIL_FROM is honoured
// as a fallback so a deploy that configured mail before this refactor
// keeps its sender without an edit.
function resolveFrom(env) {
  const e = env || {};
  return (e.PLATFORM_MAIL_FROM || '').trim()
    || (e.TOPOCHAIN_MAIL_FROM || '').trim()
    || DEFAULT_FROM;
}

function requestedProvider(env) {
  const raw = ((env && env.PLATFORM_MAIL_PROVIDER) || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (PROVIDERS.includes(raw)) return raw;
  log.error('platform-mail',
    'PLATFORM_MAIL_PROVIDER is not a known provider — falling back to auto',
    { allowed: [...PROVIDERS, 'auto'] });
  return 'auto';
}

// Returns { transport, provider, from, stagingLogOnly, requested }.
// `transport` is null when nothing can send; every caller treats that as
// "log it, don't deliver it", never as an error.
function chooseTransport(env) {
  const e = env || {};
  const from = resolveFrom(e);
  const requested = requestedProvider(e);
  const opts = { sender: from };

  if (isStaging(e)) {
    return {
      transport: logTransport.create(),
      provider: logTransport.PROVIDER,
      from,
      stagingLogOnly: true,
      requested,
    };
  }

  const build = {
    gmail: () => gmail.create(e, opts),
    http: () => httpApi.create(e, opts),
    log: () => logTransport.create(),
  };

  if (requested !== 'auto') {
    const transport = build[requested]();
    if (!transport) {
      log.error('platform-mail',
        `PLATFORM_MAIL_PROVIDER=${requested} is not configured — email will NOT be delivered`,
        { missing: missingFor(requested, e) });
      return { transport: null, provider: null, from, stagingLogOnly: false, requested };
    }
    return { transport, provider: requested, from, stagingLogOnly: false, requested };
  }

  for (const name of ['gmail', 'http']) {
    const transport = build[name]();
    if (transport) {
      return { transport, provider: name, from, stagingLogOnly: false, requested };
    }
  }

  if (isProduction(e)) {
    // Production must NOT fall back to logging: that would print login
    // codes into the production log (Global Constraints #6). Null instead,
    // which is what makes the mailer's loud error fire.
    return { transport: null, provider: null, from, stagingLogOnly: false, requested };
  }

  return {
    transport: logTransport.create(),
    provider: logTransport.PROVIDER,
    from,
    stagingLogOnly: false,
    requested,
  };
}

function missingFor(provider, env) {
  if (provider === 'gmail') return gmail.missingKeys(env);
  if (provider === 'http') return httpApi.missingKeys(env);
  return [];
}

// What Admin → Topochain → Settings renders. Presence only: never a key,
// never an endpoint. `from` IS returned — the sender address is public
// (it's in every mail we send) and an admin needs to see which address a
// deploy will send as.
function describe(env) {
  const e = env || {};
  const chosen = chooseTransport(e);
  const gmailMissing = gmail.missingKeys(e);
  const httpMissing = httpApi.missingKeys(e);

  return {
    // "configured" means mail leaves the building. Staging is honestly
    // reported as NOT configured for delivery, with stagingLogOnly
    // explaining why, so nobody reads a green card and expects an inbox.
    configured: Boolean(chosen.transport) && chosen.provider !== 'log',
    provider: chosen.provider,
    requestedProvider: chosen.requested,
    stagingLogOnly: chosen.stagingLogOnly,
    from: chosen.from,
    usingDefaultFrom: chosen.from === DEFAULT_FROM,
    // Per-provider readiness, so the card can say "Gmail needs these two
    // keys" instead of "mail is broken".
    providers: [
      { name: 'gmail', label: 'Gmail API (OAuth2)', configured: gmailMissing.length === 0, missing: gmailMissing },
      { name: 'http', label: 'Generic HTTP mail API', configured: httpMissing.length === 0, missing: httpMissing },
    ],
    // The union the admin has to fix to get the DEFAULT (gmail) path
    // working — this is what the amber card lists.
    missing: gmailMissing,
    affectedFlows: [
      'Mobile email login (one-time codes)',
      'Onboarding waitlist confirmations',
      'Waitlist release notifications',
    ],
  };
}

module.exports = { chooseTransport, describe, resolveFrom, DEFAULT_FROM, PROVIDERS };
