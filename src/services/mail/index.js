// Platform outbound mail — the one door every send goes through.
//
// THE CONTRACT, which predates this module and must not change: a send
// never throws and never returns a value the caller must check.
// POST /api/auth/otp/request is always-200 by contract (SPEC
// 1667) precisely so it can't be used to enumerate accounts, and the
// waitlist join has the same shape. So a provider outage, a missing
// credential, a throttled recipient and a successful delivery must all
// look identical from outside. The compensating visibility is the
// `mail_deliveries` table and the Admin → Topochain → Settings card: the
// operator can see what happened even though the user can't.
//
// What this module owns, in order:
//   1. rendering is delegated to ./templates
//   2. the throttle decision (./rate-limit, fed from mail_deliveries)
//   3. picking the transport (./select, resolved once at boot in config.js)
//   4. recording the outcome in mail_deliveries
//   5. swallowing absolutely everything
//
// The three named senders at the bottom (sendOtpMail /
// sendWaitlistJoinMail / sendWaitlistReleaseMail) are the caller-facing
// API and keep the signatures they had when they lived in
// src/services/topochain/mailer.js, which is now a re-export shim.
'use strict';

const log = require('../logger');
const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const { buildMessage, KINDS } = require('./templates');
const rateLimit = require('./rate-limit');
const select = require('./select');

// How long a delivery record is kept. Long enough to answer "did that
// user ever get their code last week", short enough that the table is not
// a growing archive of who signed up when.
const RETENTION_DAYS = 30;
// Bound on one opportunistic prune, so the cleanup can never turn into a
// long lock on the request that happens to trigger it.
const PRUNE_LIMIT = 2000;

// Resolve a pool WITHOUT assuming there is one. Several suites construct
// a config with only a mail transport in it (no databaseUrl), and asking
// src/db/pool.js for a pool in that case would build a Pool pointed at
// nothing. No pool simply means no throttling and no delivery record —
// the send itself still happens.
function poolFor(config) {
  if (!config || !config.databaseUrl) return null;
  try {
    return require('../../db/pool').getPool(config);
  } catch (err) {
    log.error('platform-mail', 'Could not resolve a database pool for mail bookkeeping',
      { message: err.message });
    return null;
  }
}

function stagingLogOnly(config) {
  if (config && typeof config.mailStagingLogOnly === 'boolean') {
    return config.mailStagingLogOnly;
  }
  return process.env.USERNODE_ENV === 'staging';
}

function maxPerHour(config) {
  const fromConfig = Number(config && config.mailMaxPerHour);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromEnv = Number(process.env.PLATFORM_MAIL_MAX_PER_HOUR);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return rateLimit.DEFAULT_MAX_PER_HOUR;
}

// ─── mail_deliveries bookkeeping ────────────────────────────────────────

// Returns the new row's id, or null when there was no pool or the insert
// failed. send() ignores the return value entirely — the id exists so
// sendTest() can point the admin console at the exact ledger row its
// attempt produced.
async function record(pool, { kind, to, provider, status, error }) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mail_deliveries (kind, recipient, provider, status, error)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [String(kind || '').slice(0, 64), String(to || '').slice(0, 255),
        provider ? String(provider).slice(0, 32) : null,
        String(status).slice(0, 24),
        error ? String(error).slice(0, 500) : null]
    );
    return (rows[0] && rows[0].id) || null;
  } catch (err) {
    // Bookkeeping must never be able to fail a send.
    log.error('platform-mail', 'Could not record a mail delivery', { message: err.message });
    return null;
  }
}

async function readHistory(pool, { kind, to }) {
  if (!pool) return { recipientHistory: [], globalCount: 0 };
  try {
    const [recipient, global] = await Promise.all([
      pool.query(
        `SELECT status, created_at FROM mail_deliveries
          WHERE recipient = $1 AND kind = $2
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 50`,
        [to, kind]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM mail_deliveries
          WHERE status IN ('sent', 'skipped_staging')
            AND created_at > NOW() - INTERVAL '1 hour'`
      ),
    ]);
    return {
      recipientHistory: recipient.rows,
      globalCount: (global.rows[0] && global.rows[0].n) || 0,
    };
  } catch (err) {
    // A read failure must not block mail. Fail OPEN on the throttle: a
    // missed rate-limit is a smaller problem than login codes stopping
    // because a query broke.
    log.error('platform-mail', 'Could not read mail history — throttle skipped',
      { message: err.message });
    return { recipientHistory: [], globalCount: 0 };
  }
}

// Retention sweep, called opportunistically (never on a timer of its
// own). Bounded by PRUNE_LIMIT so it stays a small, predictable delete.
async function pruneDeliveries(pool) {
  if (!pool) return 0;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM mail_deliveries
        WHERE id IN (
          SELECT id FROM mail_deliveries
           WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
           LIMIT ${PRUNE_LIMIT}
        )`
    );
    return rowCount || 0;
  } catch (err) {
    log.error('platform-mail', 'mail_deliveries prune failed', { message: err.message });
    return 0;
  }
}

// ─── the send door ──────────────────────────────────────────────────────

// send(config, { kind, to, ...payload }) → always resolves undefined.
async function send(config, { kind, to, ...payload } = {}) {
  try {
    if (!to || !kind) {
      log.error('platform-mail', 'Refusing a mail with no recipient or kind', { kind });
      return;
    }
    // Render first: an unknown kind is a programming error and there is
    // no point consulting a throttle or a provider for it.
    buildMessage(kind, payload);

    // `mailTransport` is what config.js resolves today;
    // `topochainMailTransport` is the original hook name, still honoured
    // so an injected test transport and any older caller keep working.
    const transport = (config && (config.mailTransport || config.topochainMailTransport)) || null;
    const provider = (transport && transport.provider)
      || (config && config.mailProvider)
      || (transport ? 'injected' : null);
    const pool = poolFor(config);

    if (!transport) {
      await record(pool, { kind, to, provider: null, status: 'no_transport' });
      if (config && (config.env === 'production' || process.env.USERNODE_ENV === 'production')) {
        // Global Constraints #6: NEVER log the raw code in production. An
        // unconfigured transport in prod is an operational failure — log it
        // loudly as an error so it gets noticed — but the caller still gets
        // its normal success response (no enumeration, no user-visible
        // difference between "sent" and "mailer is unconfigured").
        log.error('platform-mail',
          'No mail transport configured — mail NOT delivered', { kind, to });
        return;
      }
      // Dev convenience only, and only outside production: print the
      // payload so a developer can complete the flow by hand.
      log.info('platform-mail', 'Mail not delivered (no transport configured)',
        { kind, to, ...payload });
      return;
    }

    const { recipientHistory, globalCount } = await readHistory(pool, { kind, to });
    const decision = rateLimit.decide({
      kind,
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: maxPerHour(config),
    });
    if (!decision.allowed) {
      await record(pool, {
        kind, to, provider, status: 'suppressed_rate_limit', error: decision.reason,
      });
      // Not an error: the throttle firing is the system working. The
      // caller's response is unchanged either way.
      log.warn('platform-mail', 'Mail suppressed by the outbound throttle',
        { kind, to, reason: decision.reason });
      return;
    }

    try {
      await transport.send({ to, kind, ...payload });
      await record(pool, {
        kind, to, provider,
        status: stagingLogOnly(config) ? 'skipped_staging' : 'sent',
      });
    } catch (err) {
      await record(pool, { kind, to, provider, status: 'failed', error: err.message });
      log.error('platform-mail', 'Mail transport failed to send',
        { kind, to, provider, message: err.message });
    }
  } catch (err) {
    // The outermost net. Nothing below here may reach a caller.
    log.error('platform-mail', 'Mail send failed before reaching a provider',
      { kind, message: err.message });
  }
}

// ─── the diagnostic send (admin console only) ───────────────────────────

// sendTest(config, { to }) → a structured outcome, always.
//
// This is a SIBLING of send(), never a flag on it. send()'s always-200,
// never-throw, tells-you-nothing contract is load-bearing for the
// unauthenticated flows (SPEC 1667) and must stay exactly as it is. But
// an admin who just pasted a Gmail refresh token needs the opposite: they
// need to be told precisely what happened. The two audiences are
// irreconcilable in one function, so they are two functions that share
// every part underneath — same templates, same throttle, same transport,
// same ledger row.
//
// It still never throws. A caller gets an outcome object with a `status`
// drawn from the same vocabulary mail_deliveries uses:
//   sent | skipped_staging | failed | no_transport | suppressed_rate_limit
// plus `invalid_recipient` for a request that never reached a provider.
async function sendTest(config, { to } = {}) {
  const startedAt = Date.now();
  const outcome = {
    status: 'failed',
    provider: null,
    from: null,
    requestedProvider: null,
    stagingLogOnly: stagingLogOnly(config),
    error: null,
    providerMessageId: null,
    deliveryId: null,
    reference: null,
    durationMs: 0,
    message: null,
    missing: [],
  };

  try {
    // Presence summary for the panel: which provider was ASKED for and
    // which keys are absent. describe() reads env only — it never returns
    // a value, so nothing here can carry a credential.
    try {
      const described = select.describe(process.env);
      outcome.requestedProvider = described.requestedProvider || null;
      outcome.missing = Array.isArray(described.missing) ? described.missing : [];
      outcome.from = described.from || null;
    } catch (err) {
      log.warn('platform-mail', 'Could not describe the mail configuration for a test send',
        { message: err.message });
    }

    if (!to) {
      outcome.status = 'invalid_recipient';
      outcome.error = 'No recipient address was given';
      return outcome;
    }

    const transport = (config && (config.mailTransport || config.topochainMailTransport)) || null;
    const provider = (transport && transport.provider)
      || (config && config.mailProvider)
      || (transport ? 'injected' : null);
    outcome.provider = provider;
    if (transport && transport.from) outcome.from = transport.from;

    const pool = poolFor(config);

    // A short, non-secret handle that appears in the email body, in the
    // log line and in the outcome, so an operator can tie the message
    // that landed in their inbox to the attempt that produced it.
    const reference = require('crypto').randomBytes(4).toString('hex');
    outcome.reference = reference;
    const payload = {
      provider: provider || 'none',
      from: outcome.from || '(unset)',
      sentAt: new Date().toISOString(),
      reference,
    };

    // Render before anything else, so the console can show the exact copy
    // that was (or would have been) delivered even on the failure paths.
    const message = buildMessage('admin_test', payload);
    outcome.message = { subject: message.subject, text: message.text };

    if (!transport) {
      outcome.status = 'no_transport';
      outcome.error = outcome.missing.length
        ? `No mail transport is configured (missing: ${outcome.missing.join(', ')})`
        : 'No mail transport is configured';
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, provider: null, status: 'no_transport',
      });
      return outcome;
    }

    const { recipientHistory, globalCount } = await readHistory(pool, { kind: 'admin_test', to });
    const decision = rateLimit.decide({
      kind: 'admin_test',
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: maxPerHour(config),
    });
    if (!decision.allowed) {
      outcome.status = 'suppressed_rate_limit';
      outcome.error = decision.reason;
      outcome.retryAfterMs = decision.retryAfterMs;
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, provider, status: 'suppressed_rate_limit', error: decision.reason,
      });
      return outcome;
    }

    try {
      const detail = await transport.send({ to, kind: 'admin_test', ...payload });
      if (detail && detail.providerMessageId) {
        outcome.providerMessageId = String(detail.providerMessageId).slice(0, 128);
      }
      outcome.status = stagingLogOnly(config) ? 'skipped_staging' : 'sent';
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, provider, status: outcome.status,
      });
    } catch (err) {
      outcome.status = 'failed';
      // The provider's own bounded complaint. Transports already slice
      // their error bodies; slice again so a surprising one can't fill a
      // response.
      outcome.error = String(err.message || err).slice(0, 500);
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, provider, status: 'failed', error: outcome.error,
      });
      log.error('platform-mail', 'Admin test mail failed to send',
        { provider, reference, message: outcome.error });
    }
    return outcome;
  } catch (err) {
    // Same outermost net as send(): a diagnostic that crashes is worse
    // than one that reports its own crash.
    outcome.status = 'failed';
    outcome.error = String(err.message || err).slice(0, 500);
    log.error('platform-mail', 'Admin test mail failed before reaching a provider',
      { message: outcome.error });
    return outcome;
  } finally {
    outcome.durationMs = Date.now() - startedAt;
  }
}

// ─── the named senders (the caller-facing API) ──────────────────────────

async function sendOtpMail(config, email, code) {
  await send(config, { kind: 'otp', to: email, code });
}

// `moreToken` (two-stage waitlist survey) turns into two links: the
// one-click confirm link, which stamps confirmed_at and lands on the
// survey, and the bare survey link, which stays the durable "Want in
// sooner?" home for anyone who stopped at the join. An idempotent re-join
// mints no token and so carries neither.
async function sendWaitlistJoinMail(config, email, { moreToken = null, code = null } = {}) {
  await send(config, {
    kind: 'waitlist_joined',
    to: email,
    code,
    url: moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null,
    confirmUrl: moreToken
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
  });
}

// A confirmation code the recipient asked for again: the resend endpoint,
// and the re-join branch of the join endpoint. Its own kind, so the join
// mail's one-per-day rule cannot swallow it and so the words are the ones
// somebody chasing a code needs rather than a second welcome.
//
// `confirmed: true` is the check-my-status shape (#1538): the address
// already has a confirmed_at, so the code proves the mailbox rather than
// confirming it, and the mail's one button goes to the code-entry screen
// carrying NO token. `code: null` is the degradation for that same
// address when minting failed — the template's "nothing left to do"
// shape, which is still true. The mail is the ONLY channel that discloses
// confirmation state: the HTTP response is identical either way.
//
// The status URL is a QUERY, not a fragment. Link rewriters drop
// fragments (#1545), and AuthScreens.enter() turns `?status=1` back into
// the code-entry route on arrival.
async function sendWaitlistCodeMail(
  config,
  email,
  { code = null, moreToken = null, confirmed = false } = {}
) {
  await send(config, {
    kind: 'waitlist_code',
    to: email,
    code,
    confirmed,
    confirmUrl: code && moreToken && !confirmed
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
    statusUrl: confirmed
      ? `${PRODUCTION_ORIGIN}/?status=1`
      : (!code && moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null),
  });
}

// The plaintext reset token exists only here (in the link) and in the
// requester's response path — the DB holds its sha256. The caller mints and
// hashes; this just carries it.
async function sendPasswordResetMail(config, email, token) {
  await send(config, {
    kind: 'password_reset',
    to: email,
    // Segment style (like #more/<token>): AuthScreens.routeFromHash splits
    // hash routes on '/', so a ?token= query would never parse.
    url: `${PRODUCTION_ORIGIN}/#reset-password/${token}`,
  });
}

/**
 * "Your Homeroom access is ready" — the one mail whose whole job is a link.
 *
 * #1545: the destination is a QUERY, not a fragment. It was
 * `/#signup`, and the report was that following it from a desktop mail client
 * landed on the home page while the same mail worked from a phone. That is
 * the signature of a link rewriter: a fragment is client-side only, so a
 * scanner or tracker that rebuilds the URL has nothing to lose by dropping
 * `#signup`, and what arrives is a bare `/`. Query strings survive that,
 * because a rewriter has to carry them to reconstruct the address at all.
 *
 * `AuthScreens.enter()` already honoured `?signup=1` as "a pre-SPA link
 * form"; it now honours `?login=1` the same way, and rewrites either to its
 * hash route on arrival, so the address bar ends up exactly where the old
 * link pointed. The fragment spelling still works for anything that already
 * has one.
 */
async function sendWaitlistReleaseMail(config, email, { hasAccount = false, moreToken = null } = {}) {
  await send(config, {
    kind: 'waitlist_released',
    to: email,
    // #1548: carry a TOKEN so the signup screen can prefill the address and
    // send the code without a second step.
    //
    // Not the address itself, and not a fragment, which were the two obvious
    // options and are both wrong here:
    //
    //   A FRAGMENT is client-side only, so a link rewriter reconstructing the
    //   URL drops it. That is exactly the bug #1545 fixed on this same mail:
    //   it landed on the home page from a desktop client and worked from a
    //   phone. A prefill carried in `#signup/<address>` would silently vanish
    //   for the very people that fix was for.
    //
    //   THE ADDRESS IN A QUERY survives rewriters but puts an email in a URL,
    //   which means server logs and referrers. For a waitlist, membership is
    //   the fact people would least want landing there.
    //
    // `more_token` is already an unguessable capability delivered to this
    // address, and GET /api/public/waitlist/more/:token already resolves it
    // (rate-limited, scan-limited) and already returns the email. So this
    // needs no new endpoint and no new secret: the query survives the
    // rewriter, and what travels is a token the recipient already holds.
    url: hasAccount
      ? `${PRODUCTION_ORIGIN}/?login=1`
      : `${PRODUCTION_ORIGIN}/?signup=1${moreToken ? `&t=${encodeURIComponent(moreToken)}` : ''}`,
    hasAccount,
  });
}

module.exports = {
  send,
  sendTest,
  sendOtpMail,
  sendPasswordResetMail,
  sendWaitlistJoinMail,
  sendWaitlistCodeMail,
  sendWaitlistReleaseMail,
  pruneDeliveries,
  buildMessage,
  KINDS,
  chooseTransport: select.chooseTransport,
  describe: select.describe,
  RETENTION_DAYS,
  PRUNE_LIMIT,
};
