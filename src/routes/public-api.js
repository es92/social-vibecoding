// Public (unauthenticated) read-only API: the platform's publicly-viewable
// apps and, for each, the people who have contributed to it.
//
// Made public via the `/api/public/` prefix in PUBLIC_PATHS
// (src/middleware/auth.js) — same mechanism the kudos leaderboard uses.
// NOTHING here reads req.user; treat every request as fully anonymous.
//
// Privacy model (mirrors the rest of the platform):
//   - Only view-public, non-self-hosted apps are ever listed. A view-
//     private app (or the self-app) is omitted entirely from the list and
//     404s on the per-app route, so its existence is never disclosed —
//     the same non-enumeration stance as services/app-access.js.
//   - usernode_pubkey (the on-chain `ut1…` wallet) is exposed by default,
//     consistent with GET /api/leaderboard/users which already publishes
//     it. `?include_wallets=0` opts the address field out.
//
// Contributors for an app = the DISTINCT union of:
//   1. the creator (apps.created_by),
//   2. accepted members (app_collaborators status='member'),
//   3. authors of merged proposals (chat_sessions status='merged').
//
// That definition (and the query implementing it) now lives in
// src/services/contributors.js, shared with the AUTHED per-app read
// GET /api/apps/:slug/contributors that backs the app-details page's
// Contributors section (#919) — so "who counts as a contributor" cannot
// drift between the two surfaces. `loadContributors` / `shapeContributor`
// are imported and re-exported below unchanged; nothing about this file's
// behaviour or payloads moved with them.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const firstSession = require('../services/first-session');
const signInProviders = require('../services/sign-in-providers');
const phoneAuth = require('../services/firebase-phone-auth');
const { clientIp } = require('../services/client-ip');
const {
  waitlistJoinLimiter,
  waitlistTokenLimiter,
  waitlistTokenScanLimiter,
  waitlistCodeConfirmLimiter,
  waitlistResendLimiter,
  waitlistResendIpLimiter,
  waitlistStatusLimiter,
  waitlistStatusIpLimiter,
  publicProjectReadLimiter,
} = require('../middleware/rate-limits');
const { waitlistIntegratorAuth } = require('../services/waitlist-integrator');
const waitlist = require('../services/waitlist');
const releaseLinks = require('../services/release-links');
const questions = require('../services/waitlist-questions');
const { sendWaitlistJoinMail, sendWaitlistCodeMail } = require('../services/topochain/mailer');
const { inviteUrl, privacyNoticeUrl, siteUrl, waitlistUrl } = require('../services/marketing-links');
const { loadContributors, shapeContributor } = require('../services/contributors');
const { listPublicApps, isPublicDirectoryApp, HIDDEN_APP_STATUSES } = require('../services/public-app-directory');
const { loadProjectOverview } = require('../services/public-project');

// The guest project page's overview, kept for a short while per project: it
// is the same for everyone who asks, and a shared link can bring a crowd.
const OVERVIEW_TTL_MS = 30 * 1000;
const OVERVIEW_CACHE_MAX = 500;
const { loadMobileAppUrls } = require('../services/mobile-store-links');

// The ONE body POST /api/public/waitlist/resend ever returns. Frozen and
// module-scoped rather than built per request, so the four branches cannot
// drift apart by accident — a field that differed by branch, even a
// timestamp, would turn the endpoint into a membership oracle. This
// freeze SURVIVED #2201: the join endpoint now discloses by decision,
// this one still does not.
//
// `cooldown_seconds` is a constant the client counts down locally. It
// matches the minute gap in services/mail/rate-limit.js's waitlist_code
// rule, which is what actually enforces it; the real per-address decision
// is never reported here. The message is conditional in its wording for
// the same reason the body is not: it has to be true whichever branch ran.
// It no longer says "still needs confirming" (#1538): a confirmed address
// now gets a status code too, so that clause would be false for the very
// branch the check-my-status flow runs.
const RESEND_RESPONSE = Object.freeze({
  ok: true,
  cooldown_seconds: 60,
  message: 'If that address is on our waitlist, a six-digit code is on its '
    + 'way. It works for 15 minutes.',
});

// `?include_wallets=0` (exactly the string '0') opts addresses out;
// anything else (unset, '1', …) keeps them — addresses-on is the default.
function wantsWallets(req) {
  return req.query.include_wallets !== '0';
}

// ISO-8601 or null. Postgres timestamps arrive as Date objects; a row that
// was never stamped arrives as null and must stay null rather than becoming
// the epoch.
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The stage-2 screen's one-line answer to "where am I in this queue?".
// Derived, never stored: released_at is what admission means, confirmed_at
// is what a verified address means, and everything else is still pending.
// Ordered most-advanced first so a released row reads as admitted even
// though it also carries a confirmed_at.
function signupStatus(row) {
  const admitted = !!row.released_at;
  const confirmed = !!row.confirmed_at;
  return {
    state: admitted ? 'admitted' : (confirmed ? 'confirmed' : 'pending'),
    admitted,
    confirmed,
    // Whether the invite has actually been redeemed into an account, which
    // is a different question from having been admitted.
    has_account: row.linked_user_id !== null && row.linked_user_id !== undefined,
    joined_at: isoOrNull(row.submitted_at),
    confirmed_at: isoOrNull(row.confirmed_at),
    admitted_at: isoOrNull(row.released_at),
  };
}

function publicApiRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // GET /api/public/apps — every view-public, non-self-hosted app with its
  // contributors embedded.
  router.get('/api/public/apps', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      res.json({ apps: await listPublicApps(pool, { includeWallets }) });
    } catch (err) {
      log.error('public-api', 'apps list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/apps/:slug/contributors — one app's contributor list.
  // Answers only for an app the public directory lists (isPublicDirectoryApp:
  // not self-hosted, not suspended by moderators, view-public, and not in a
  // hidden status). Anything else is 404 (never 403), so a hidden app's
  // existence isn't disclosed.
  router.get('/api/public/apps/:slug/contributors', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, self_hosted, view_visibility, status,
                moderation_suspended_at
           FROM apps WHERE slug = $1`,
        [String(req.params.slug)]
      );
      const app = rows[0];
      if (!isPublicDirectoryApp(app)) {
        return res.status(404).json({ error: 'App not found' });
      }

      const byApp = await loadContributors(pool, [app.id]);
      res.json({
        slug: app.slug,
        contributors: (byApp.get(app.id) || []).map((r) =>
          shapeContributor(r, includeWallets)
        ),
      });
    } catch (err) {
      log.error('public-api', 'contributors failed', {
        slug: req.params.slug, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/apps/:slug/overview — the read-only project page a
  // visitor with no account sees (services/public-project.js): the card,
  // the changes up for a vote with their tallies, the last changes voted in
  // and the titles of the open requests. 404 for anything the directory
  // does not list, the same body as an unknown slug.
  const overviewCache = new Map();
  router.get('/api/public/apps/:slug/overview', publicProjectReadLimiter, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return res.status(404).json({ error: 'App not found' });
    try {
      const hit = overviewCache.get(slug);
      if (hit && hit.expiresAt > Date.now()) return res.json(hit.body);
      const body = await loadProjectOverview(pool, slug);
      if (!body) return res.status(404).json({ error: 'App not found' });
      if (overviewCache.size >= OVERVIEW_CACHE_MAX) overviewCache.clear();
      overviewCache.set(slug, { body, expiresAt: Date.now() + OVERVIEW_TTL_MS });
      res.json(body);
    } catch (err) {
      log.error('public-api', 'project overview failed', { slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/app-host?host= — which app a LIVE custom domain serves
  // (#4405): the slug and the name, nothing else. The hosted bridge asks
  // from the app's own page to draw its Homeroom button there, which is why
  // this is anonymous and under the CORS-open prefix. 404 for anything that
  // is not a live custom host, a Homeroom host included (the bridge already
  // knows those from platform.json).
  router.get('/api/public/app-host', async (req, res) => {
    const host = String(req.query.host || '').trim().toLowerCase().replace(/:\d+$/, '');
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const found = await require('../services/app-domains').lookupLiveHost(pool, host);
      if (!found) return res.status(404).json({ error: 'Not found' });
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ slug: found.slug, name: found.name });
    } catch (err) {
      log.error('public-api', 'app-host lookup failed', { host, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/waitlist/options — the survey question definitions
  // (option keys + labels, countries, limits). The SPA renders both
  // waitlist forms from this so client and server validation can't
  // drift; the payload is static per process.
  //
  // It also carries two MARKETING-site links, so no client hardcodes the
  // host: `marketing_url`, the site's front door, which the landing's
  // "Learn more" line points at for somebody deciding whether to join; and
  // `waitlist_url`: the MARKETING site's /waitlist page,
  // so no client has to hardcode the host. The logged-out landing's
  // primary pill is that URL with target="_blank", which the native
  // shell hands to the bridge's openExternal (public/js/nav-link.js) —
  // and the host is configurable per deployment (MARKETING_BASE_URL), so
  // the frontend cannot know it. Same origin and path the shared invite
  // link uses (src/services/marketing-links.js), decided in one place.
  //
  // Composed HERE rather than inside publicOptions(), because `config`
  // lives in this closure and that service deliberately takes none. The
  // spread makes a fresh object: publicOptions() returns REFERENCES to
  // the module's option constants, which must never be mutated.
  //
  // `story_landing` is the first session's switch (services/first-session.js):
  // true, the landing tells the story and asks people to get started rather
  // than pointing at the waitlist. On unless an admin switched it off, and on
  // when it cannot be read.
  //
  // `sign_in_providers` is which of Apple and Google the sign-in sheet
  // offers beside the email code (services/sign-in-providers.js): only those
  // an admin has set up and switched on, Apple first; none when unreadable.
  //
  // `terms_link` is the current published terms' own address, for the
  // sign-in screens' "By continuing, you agree to Homeroom's terms"
  // (frontend/src/features/auth/sign-in-sheet.tsx and login.tsx). "Current"
  // is the terms gate's rule (routes/topochain/mobile.js): the latest
  // published version. null when none is published, it has no link, or the
  // read fails; the notice then names the terms without a link.
  //
  // `privacy_link` is Homeroom's privacy notice on the marketing site
  // (services/marketing-links.js), which the same notice names beside the
  // terms and Settings › About links to (#5094, #5106). Never null.
  async function currentTermsLink() {
    try {
      const { rows } = await pool.query(
        `SELECT terms_link FROM terms_versions
          WHERE published_at IS NOT NULL
          ORDER BY published_at DESC, id DESC LIMIT 1`
      );
      return (rows[0] && rows[0].terms_link) || null;
    } catch (err) {
      log.warn('public-api', 'Current terms link read failed', { err: err.message });
      return null;
    }
  }
  router.get('/api/public/waitlist/options', async (_req, res) => {
    res.json({
      ...questions.publicOptions(),
      waitlist_url: waitlistUrl(config),
      marketing_url: siteUrl(config),
      story_landing: await firstSession.storyLandingEnabled(pool),
      sign_in_providers: await signInProviders.offeredProviders(pool, config),
      // Phone-number sign-in (services/firebase-phone-auth.js): offered
      // only when its four Firebase values are set and the flag is on.
      // Sync on purpose — the gate reads config, not the database.
      phone_sign_in: phoneAuth.offered(config),
      terms_link: await currentTermsLink(),
      privacy_link: privacyNoticeUrl(config),
      // The same, from the Homeroom app's own sheets (the bridge's
      // signInWithProvider), once the app's client IDs are saved.
      native_sign_in_providers: await signInProviders.offeredNativeProviders(pool, config),
    });
  });

  // POST /api/public/waitlist — platform waitlist join (onboarding flow
  // alignment), now carrying the stage-1 survey (mirrors the original
  // topochain waitlist: made_url + discovery required, location
  // optional). No account required.
  //
  // THREE CASES, THREE ANSWERS (#2201). This endpoint used to be
  // non-enumerating: every join, fresh or repeat, got one frozen 200 that
  // the client could not branch on. The cost was a returning reader being
  // told "we sent a six-digit code to you@..." and then sitting in front
  // of a code field with nothing coming, because their address was
  // already confirmed and there was nothing left to send.
  //
  //   1. New address       -> joined, code mailed, on to step 2.
  //   2. On the list, not  -> "already on the waitlist", fresh code
  //      confirmed            mailed, on to step 2.
  //   3. On the list, and  -> "already on the waitlist, and confirmed":
  //      confirmed            the settled panel. NOTHING is minted,
  //                           deleted or mailed.
  //
  // That makes this endpoint an oracle for "is this address on the
  // waitlist, and is it confirmed". THE APP OWNER DECIDED THAT TRADE,
  // deliberately and with the alternative in front of them: the silence
  // was costing every returning person their way back in. So do not
  // "fix" the branch below back into one frozen body — that is the
  // reverted change, not a bug. What still holds:
  //
  //   - only the FIRST join gets a stage-2 `more` link back. That token
  //     dereferences to an address, its survey answers and its invite
  //     list, so a re-join handing one over would be a capability leak,
  //     which is a different thing from the membership disclosure above
  //     and is NOT part of the decision.
  //   - an INTEGRATOR-keyed request gets the old frozen body with no
  //     status block at all. An integrator proxies other people's
  //     addresses through a 200-per-window bucket; first-party joins come
  //     from a browser through a 5-per-15-minutes-per-IP one, which is
  //     what bounds the oracle to a rate a person can reach and a
  //     harvester cannot.
  //   - the malformed-address 422 is unchanged, and discloses nothing.
  //   - POST /resend is untouched: it still answers all four of its
  //     branches with one frozen body (see RESEND_RESPONSE).
  //
  // Confirmation mail is best-effort (the mailer degrades silently when
  // no transport is configured).
  router.post('/api/public/waitlist', waitlistIntegratorAuth(config), waitlistJoinLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(422).json({ error: 'A valid email address is required.' });
    }
    const stage1 = questions.validateStage1(req.body || {});
    if (!stage1.ok) {
      return res.status(422).json({ error: stage1.error });
    }
    // An integrator-keyed request never learns which branch ran (see the
    // doc comment above): it gets the pre-#2201 body, byte for byte.
    const disclose = !req.waitlistIntegrator;
    try {
      const { created, moreToken, submittedAt } = await waitlist.joinWaitlist(pool, {
        email,
        // A trusted integrator proxies real people, so its own server
        // address is not the signup's address. Recording the proxy for
        // every agency-sourced row is what this prefers away from; an
        // unkeyed request has no forwarded address and is unchanged.
        ip: req.waitlistEndUserIp || clientIp(req),
        answers: stage1.value,
        // From an invite link's ?ref=<code> — the marketing site's
        // /waitlist page forwards it here, and the in-app /#waitlist route
        // still reads it from the hash for links minted before the move.
        // An unresolvable code is ignored rather than refused: a stale
        // link must never block a join.
        inviteCode: typeof req.body?.invite_code === 'string' ? req.body.invite_code : null,
      });
      // CASE 1 — a brand new address. Joined, code mailed, step 2 next.
      if (created) {
        log.info('public-api', 'Waitlist join', {});
        // Best-effort like the mail itself: a code that cannot be minted
        // must not fail the join, and the one-click link still confirms.
        const code = await waitlist.issueVerificationCode(pool, email).catch(() => null);
        sendWaitlistJoinMail(config, email, { moreToken, code }); // fire-and-forget, never throws
        return res.json({
          ok: true,
          message: "You're on the waitlist. We'll email you when access opens up.",
          // Stage-2 capability — present only on the first join.
          more_token: moreToken,
          ...(disclose
            ? {
              status: signupStatus({
                submitted_at: submittedAt,
                confirmed_at: null,
                released_at: null,
                linked_user_id: null,
              }),
            }
            : {}),
        });
      }

      // A RE-JOIN, and which of the two depends on the row. Read it
      // FIRST: case 3 must not touch the code table at all, and the old
      // code here called into resendConfirmation unconditionally, which
      // deleted a confirmed reader's live code to mint one it then mailed
      // as a status code nobody was waiting for.
      const row = await waitlist.getSignupByEmail(pool, email);
      // A row that vanished between the INSERT and this read (an admin
      // deletion mid-request) is the only way this is null. Treat it as
      // case 2's shape: it is the answer that asks for the least and
      // discloses nothing that is not already true.
      const confirmedRow = !!(row && row.confirmed_at);

      // CASE 3 — already on the list AND confirmed. There is nothing left
      // for this person to do, so there is nothing to mint, nothing to
      // delete and nothing to mail. The status block is what lands the
      // client on the settled panel instead of a code field.
      if (confirmedRow) {
        // No address in the log line: which addresses came back is not
        // something worth writing down to answer a support question.
        log.info('public-api', 'Waitlist re-join, already confirmed', {});
        return res.json({
          ok: true,
          message: "You're already on the waitlist, and this address is confirmed.",
          more_token: null,
          ...(disclose ? { status: signupStatus(row) } : {}),
        });
      }

      // CASE 2 — on the list, not confirmed. Mail a fresh code, on the
      // resend kind rather than the join kind: the words a returning
      // person needs are "here is your code", not a second welcome, and
      // waitlist_joined's one-per-day rule would drop this send anyway.
      // Fire-and-forget, and the mail throttle plus the reuse window in
      // resendConfirmation are what bound how often it actually sends.
      await resendConfirmation(email).catch(() => {});
      return res.json({
        ok: true,
        message: "You're already on the waitlist. We've sent a fresh six-digit "
          + 'code to that address.',
        more_token: null,
        ...(disclose && row ? { status: signupStatus(row) } : {}),
      });
    } catch (err) {
      log.error('public-api', 'waitlist join failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Mint a fresh code for an address and mail it. Shared by POST /resend
  // and by case 2 of the re-join branch above so the two cannot drift.
  // Case 3 deliberately does NOT come through here: a confirmed address
  // re-joining has nothing to be sent, and routing it here is what used
  // to delete its live code.
  //
  // A CONFIRMED row gets a code too (#1538). It used to get the
  // "nothing left to do" mail carrying its more_token LINK, which is
  // exactly backwards for check-my-status: the person who wants to read
  // their status is by definition already confirmed, so the one
  // population the flow exists for was the one that never got a code.
  // The mail differs (a status code, not a confirmation code) but the
  // minting does not, so there is one code lifecycle and one throttle.
  //
  // Returns nothing and tells the caller nothing: every branch is silent,
  // including "not on the list", because the only way a caller could learn
  // which branch ran is if a response differed. Failures are swallowed the
  // same way the mail itself is best-effort.
  async function resendConfirmation(email) {
    const row = await waitlist.getSignupByEmail(pool, email);
    // Not on the list. No row to confirm, so no code and no mail — sending
    // one would tell a stranger's inbox that somebody typed it here.
    if (!row) return;
    const confirmed = !!row.confirmed_at;
    // A code minted seconds ago is still in the inbox, so LEAVE IT THERE.
    //
    // Minting is unconditional below and the mail throttle only decides
    // afterwards, so without this check two asks a few seconds apart
    // destroyed a working code and delivered nothing to replace it
    // (waitlist_code allows one send per address per minute, and the
    // second send is recorded suppressed_rate_limit). Production carried
    // 59 suppressions against 32 sends over thirty days, which is the
    // same number of readers left typing a code that no longer existed.
    //
    // Returning early is the whole fix: only the bcrypt hash is stored,
    // so the live code cannot be re-mailed, and the mail that carried it
    // is already out. See CODE_REUSE_WINDOW_SECONDS, which mirrors
    // OTP_REUSE_WINDOW_SECONDS in services/email-signup.js.
    if (await waitlist.hasReusableCode(pool, email).catch(() => false)) return;
    // Issuing deletes every unconsumed code for the address first, so the
    // previous one dies here: exactly one code is live at a time and a
    // forwarded older mail is already dead. That is what makes "use the
    // newest email" true rather than advice.
    const code = await waitlist.issueVerificationCode(pool, email).catch(() => null);
    if (!code) {
      // Minting failed. For a confirmed row the old link mail is still a
      // true thing to say — there is nothing to type — so it stays as the
      // degradation rather than leaving the address with silence.
      if (confirmed) {
        sendWaitlistCodeMail(config, email, { code: null, moreToken: row.more_token || null });
      }
      return;
    }
    sendWaitlistCodeMail(config, email, {
      code,
      moreToken: row.more_token || null,
      // Picks the mail shape: a status code leads to "check my status"
      // and carries no capability token, a confirmation code leads to
      // "confirm my email".
      confirmed,
    });
  }

  // POST /api/public/waitlist/resend — a new six-digit code for an address
  // that has joined but not confirmed.
  //
  // The code expires after 15 minutes, and until this existed that was a
  // dead end: somebody coming back on a new device an hour later had no way
  // to get another one, and their only route in was the one-click link in
  // an email they may no longer have.
  //
  // NON-ENUMERATION IS THE WHOLE DESIGN of the response. Four branches run
  // here — invalid address, not on the list, on the list and unconfirmed,
  // already confirmed — and three of them answer with the SAME 200 and the
  // same body. Anything else makes this an oracle for "is this person on
  // the waitlist".
  //
  // POST /confirm beside it keeps the same contract (one 422 for a wrong
  // code and for an address that was never on the list). POST
  // /api/public/waitlist no longer does, on purpose: #2201 has it report
  // membership and confirmed state so a returning reader lands on their
  // status instead of an empty code field. That is a decision about THAT
  // endpoint, made with its rate limiter in front of it, and it is not a
  // licence to relax this one — this route takes a bare address with no
  // survey behind it and no browser bucket, which is the cheapest
  // possible oracle to drive.
  //
  // That includes the cooldown. A per-address "wait 47 more seconds" would
  // be a membership test in itself, so `cooldown_seconds` is a CONSTANT the
  // client counts down locally; the real per-address gap is the mail
  // throttle's, and its decision is never reported. The mail call is
  // fire-and-forget for the same reason: awaiting a provider would make the
  // response TIME differ by branch.
  router.post('/api/public/waitlist/resend', waitlistResendIpLimiter, waitlistResendLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    // The one refusal, and it discloses nothing: a syntactically invalid
    // address is not a fact about the waitlist.
    if (!email) {
      return res.status(422).json({ error: 'A valid email address is required.' });
    }
    try {
      await resendConfirmation(email);
    } catch (err) {
      // Deliberately NOT a 500. A failure here is ours, and letting it
      // change the status code would separate "something went wrong for
      // this address" from "nothing went wrong for that one" — which is the
      // oracle again, by another route. Log it and answer normally.
      log.error('public-api', 'waitlist resend failed', { message: err.message });
    }
    return res.json(RESEND_RESPONSE);
  });

  // POST /api/public/waitlist/status — where one address stands, by address.
  //
  // The read half of check-my-status, and the one route in this family that
  // answers the membership question OUT LOUD: not on the list, on it and
  // unconfirmed, or on it and confirmed. Everything else here refuses to,
  // and the difference is deliberate rather than an oversight to tidy up.
  //
  // The decision it rests on is not this endpoint's. #2201 accepted
  // membership + confirmed-state disclosure on the JOIN endpoint, with the
  // silent alternative in front of the owner, because the silence was
  // costing every returning person their way back in. This route discloses
  // the same three cases for strictly less: it writes nothing, mails
  // nothing, and mints nothing, where a join creates a row and sends a code.
  // So it introduces no new disclosure class. If that decision is ever
  // reversed and the join endpoint goes back to one frozen body, THIS route
  // has to be revisited in the same motion — the two cannot fall out of step.
  //
  // What it never says, whatever the branch: more_token (the stage-2
  // capability, first join only), invite_code, invited_by, answers, ip, the
  // linked account, or an echo of the submitted address. Confirming an
  // address still means holding the code that was mailed to it, so nothing
  // here helps anyone claim a mailbox they do not have.
  //
  // Not mounted with waitlistIntegratorAuth, unlike the join route above. A
  // key re-keys a WRITE budget for genuinely proxied signups; a read has no
  // proxied end user to re-key for, and a key must not buy a bigger oracle
  // budget. A key-bearing caller is simply an anonymous caller here: one
  // behaviour, one bucket, no second response shape to keep in sync.
  //
  // Both branches run the SAME single indexed lookup on the unique email
  // column and nothing else, so the clock does not separate them either. Do
  // not add a query, a cache, or an await to only one of them.
  router.post('/api/public/waitlist/status', waitlistStatusIpLimiter, waitlistStatusLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    // The same words /resend refuses with: a syntactically invalid address
    // is not a fact about the waitlist, so the two surfaces answer it alike.
    if (!email) {
      return res.status(422).json({ error: 'A valid email address is required.' });
    }
    try {
      const row = await waitlist.getSignupByEmail(pool, email);
      if (!row) {
        return res.json({ ok: true, on_list: false, admitted: false, status: null });
      }
      // signupStatus is the ONE derivation of where a row stands, shared with
      // POST /confirm and GET /more/:token. Deriving it a second time here is
      // how one row starts being described three ways; `admitted` is mirrored
      // at the top level exactly as /more/:token does it.
      const status = signupStatus(row);
      return res.json({
        ok: true,
        on_list: true,
        admitted: status.admitted,
        status,
      });
    } catch (err) {
      // No address in the payload: this line is about our failure, not about
      // whose lookup it was.
      log.error('public-api', 'waitlist status read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/waitlist/confirm/:token — the one-click confirm link
  // carried in the join mail. It stamps waitlist_signups.confirmed_at
  // (idempotent) and then REDIRECTS to the stage-2 survey, so confirming
  // the address and answering the optional questions are one motion
  // rather than two emails.
  //
  // A GET that changes state is deliberate here: a mail client can only
  // offer a link, and the token is an unguessable capability that was
  // delivered to the address being confirmed — following it is the proof.
  // Registered BEFORE the /more/:token routes for clarity; Express matches
  // on the literal segment either way.
  router.get('/api/public/waitlist/confirm/:token', waitlistTokenScanLimiter, waitlistTokenLimiter, async (req, res) => {
    const token = req.params.token;
    try {
      const row = await waitlist.confirmSignupByMoreToken(pool, token);
      // Unknown token: 404 rather than a redirect. A stale link that
      // silently landed on a blank survey would look like the survey was
      // broken.
      if (!row) return res.status(404).json({ error: 'Unknown or expired link.' });
      log.info('public-api', 'Waitlist email confirmed', {});
      // Belt-and-braces before the token reaches a header: reaching this
      // line already means it matched /^[a-f0-9]{48}$/ inside
      // getSignupByMoreToken, but a Location built from a request value is
      // exactly where a CRLF would matter.
      if (!/^[a-f0-9]{48}$/.test(token)) {
        return res.status(404).json({ error: 'Unknown or expired link.' });
      }
      return res.redirect(302, `/#more/${token}`);
    } catch (err) {
      log.error('public-api', 'waitlist confirm failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/public/waitlist/confirm — the same confirmation as the
  // one-click link above, by the six-digit code carried in the same mail.
  // It exists for the phone, where leaving the app for the mail client
  // loses the WebView's place; on desktop the link is still one click.
  // Both stamp the same confirmed_at and the first one wins.
  //
  // A wrong code and an address that was never on the list get the SAME
  // 422, so this cannot be used to test whether an email is on the
  // waitlist — the same non-enumeration contract the join endpoint keeps.
  //
  // It is also the read half of check-my-status (#1538): an
  // already-confirmed row is a normal caller, its confirmed_at is left
  // alone by the COALESCE, and the response carries where that row
  // actually stands.
  router.post('/api/public/waitlist/confirm', waitlistTokenScanLimiter, waitlistCodeConfirmLimiter, waitlistTokenLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!email || !/^[0-9]{6}$/.test(code)) {
      return res.status(422).json({ error: 'Enter the six-digit code from your email.' });
    }
    try {
      const row = await waitlist.confirmSignupByCode(pool, email, code);
      if (!row) {
        return res.status(422).json({ error: 'That code is wrong or has expired. Ask for a new one.' });
      }
      log.info('public-api', 'Waitlist email confirmed by code', {});
      // The status block rides along (#1538) so "check my status" is one
      // round trip, not two, and so this surface and /more/:token cannot
      // describe the same row differently — both derive from signupStatus.
      const status = signupStatus(row);
      return res.json({
        ok: true,
        more_token: row.more_token || null,
        admitted: status.admitted,
        status,
      });
    } catch (err) {
      log.error('public-api', 'waitlist code confirm failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/waitlist/more/:token — stage-2 state for the "Want
  // in sooner?" form: previously saved answers (so the form is
  // re-openable and prefills) plus which OAuth connects are available /
  // already verified. The token is an unguessable capability from the
  // join response / email; an invalid token 404s.
  router.get('/api/public/waitlist/more/:token', waitlistTokenScanLimiter, waitlistTokenLimiter, async (req, res) => {
    try {
      const row = await waitlist.getSignupByMoreToken(pool, req.params.token);
      if (!row) return res.status(404).json({ error: 'Unknown or expired link.' });
      const answers = row.answers && typeof row.answers === 'object' ? row.answers : {};
      const status = signupStatus(row);
      // ?view=status answers the poll alone: the screen re-reads this route
      // while it waits for a confirmation to land, and the full payload
      // costs two extra queries plus a conditional invite-code INSERT every
      // time. Any other value of `view` is ignored rather than refused —
      // an unknown one must never turn a working screen into an error.
      if (req.query.view === 'status') {
        return res.json({ ok: true, admitted: status.admitted, status });
      }
      // The invite link is minted on this read, not at join: most signups
      // never open the stage-2 form, and a code nobody will share is a
      // row nobody needs.
      const inviteCode = await waitlist.inviteCodeFor(pool, row.id);
      const invited = await waitlist.invitedBySignup(pool, row.id);
      res.json({
        ok: true,
        // Also at the top level, not only inside `status`: "am I in yet" is
        // the one question this route exists to answer, and a caller that
        // reads nothing else should not have to know the block's shape.
        admitted: status.admitted,
        status,
        // Which address this signup was made with (#1537). Not a disclosure:
        // the 48-hex token in the path is only obtainable by joining with this
        // address or by receiving the join mail at it, so a caller holding it
        // already knows the answer — and an unknown token still 404s above
        // without echoing anything back. Deliberately NOT on the ?view=status
        // short-circuit: that branch is the confirmation poll, it repeats on a
        // timer, and it has no reader for this.
        email: row.email,
        // Whether a "You're in" mail's link for this row may be spent as the
        // page opens (features/auth/landing.tsx): released, and the account
        // the address would prove is still new (none yet, or no username and
        // no password). A boolean and nothing else. Read only: it spends no
        // link and makes no session (services/release-links.js isNewAccount).
        new_account: await releaseLinks.isNewAccount(pool, row),
        answers,
        oauth: {
          github: !!(config.waitlistGithubClientId && config.waitlistGithubClientSecret),
          x: !!(config.waitlistXClientId && config.waitlistXClientSecret),
          linkedin: !!(config.waitlistLinkedinClientId && config.waitlistLinkedinClientSecret),
        },
        // Where "Follow along" points. Every network is always present;
        // one with no URL configured is null and renders no link, the same
        // degradation the `oauth` flags above get. Nothing here claims
        // verification: none of the three will tell us whether a follow
        // happened.
        follow: {
          x: config.waitlistFollowXUrl || null,
          linkedin: config.waitlistFollowLinkedinUrl || null,
          instagram: config.waitlistFollowInstagramUrl || null,
        },
        // The link points at the marketing site's /waitlist page, not at
        // this app's #waitlist route: it is shared with people who have
        // never seen the product, and the shell has nothing to tell them.
        // The `ref` code is unchanged and still comes back here as
        // `invite_code` on the join (see the note above), so links minted
        // before this change keep attributing correctly.
        invite: {
          url: inviteUrl(config, inviteCode),
          count: invited.count,
          emails: invited.emails,
        },
      });
    } catch (err) {
      log.error('public-api', 'waitlist more fetch failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/public/waitlist/more/:token — merge stage-2 answers.
  // Everything optional; sections merge (a later visit can fill in what
  // an earlier one skipped). Mirrors topochain's storeMore.
  router.post('/api/public/waitlist/more/:token', waitlistTokenScanLimiter, waitlistTokenLimiter, async (req, res) => {
    const stage2 = questions.validateStage2(req.body || {});
    if (!stage2.ok) {
      return res.status(422).json({ error: stage2.error });
    }
    try {
      const merged = await waitlist.mergeMoreAnswers(pool, req.params.token, stage2.value);
      if (!merged) return res.status(404).json({ error: 'Unknown or expired link.' });
      res.json({ ok: true, message: 'Saved, thanks. You can come back and add to this any time.' });
    } catch (err) {
      log.error('public-api', 'waitlist more save failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/mobile-app — where a phone browser can install the native
  // app, per OS. Backs the install banner (#1372); anonymous, because the
  // banner shows on the landing screen too. The URLs come from
  // services/mobile-store-links.js, which says why they are the store listings.
  //
  // NOT a reuse of POST /api/v4/app-version/check: that route records a
  // version check for analytics, so answering this from it would file a check
  // for a build that does not exist on every mobile pageview.
  router.get('/api/public/mobile-app', async (_req, res) => {
    let urls = { ios: null, android: null };
    try {
      urls = await loadMobileAppUrls(pool);
    } catch (err) {
      // Degrade to "no offer" rather than 500. This is an upsell strip on an
      // otherwise-working page, and a failed request here would put a console
      // error on every mobile route — which fails proposal checks.
      log.error('public-api', 'mobile app install urls failed', { message: err.message });
    }
    res.json(urls);
  });

  return router;
}

module.exports = {
  publicApiRoutes,
  // Exported for tests.
  loadContributors,
  shapeContributor,
  HIDDEN_APP_STATUSES,
};
