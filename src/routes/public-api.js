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
const { clientIp } = require('../services/client-ip');
const {
  waitlistJoinLimiter,
  waitlistTokenLimiter,
  waitlistTokenScanLimiter,
  waitlistCodeConfirmLimiter,
  waitlistResendLimiter,
  waitlistResendIpLimiter,
} = require('../middleware/rate-limits');
const { waitlistIntegratorAuth } = require('../services/waitlist-integrator');
const waitlist = require('../services/waitlist');
const questions = require('../services/waitlist-questions');
const { sendWaitlistJoinMail, sendWaitlistCodeMail } = require('../services/topochain/mailer');
const { inviteUrl } = require('../services/marketing-links');
const { productionHostname } = require('../services/caddy');
const { loadContributors, shapeContributor } = require('../services/contributors');

// Apps surfaced publicly: not the self-app, view-public, and in a status
// that means the app actually exists/runs (creating / awaiting_secrets /
// error rows aren't usable, so they're hidden — `status` is still returned
// for the rows that do appear).
const HIDDEN_APP_STATUSES = ['error', 'creating', 'awaiting_secrets'];

// The ONE body POST /api/public/waitlist/resend ever returns. Frozen and
// module-scoped rather than built per request, so the four branches cannot
// drift apart by accident — a field that differed by branch, even a
// timestamp, would turn the endpoint into a membership oracle.
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
      // The active-users join mirrors the authed home list's sticky
      // 10-day rule (routes/apps.js): a user counts iff they ever spent
      // >= 60s on the app on a single day AND visited within 10 days.
      // Batched to one row per app — same shape, no per-app round trips.
      const { rows: apps } = await pool.query(
        `SELECT a.id, a.name, a.slug, a.status, a.collab_visibility,
                a.view_visibility, a.created_at, a.last_deploy_at,
                a.icon_emoji, a.icon_image_id, a.anon_shell,
                COALESCE(au.cnt, 0) AS active_users
           FROM apps a
           LEFT JOIN (
             SELECT a1.app_id, COUNT(DISTINCT a1.user_id) AS cnt
             FROM app_activity a1
             WHERE a1.date >= CURRENT_DATE - 10
               AND EXISTS (
                 SELECT 1 FROM app_activity a2
                 WHERE a2.app_id = a1.app_id
                   AND a2.user_id = a1.user_id
                   AND a2.seconds_spent >= 60
               )
             GROUP BY a1.app_id
           ) au ON au.app_id = a.id
          WHERE NOT a.self_hosted
            AND a.view_visibility = 'public'
            AND a.status <> ALL($1::text[])
          ORDER BY COALESCE(au.cnt, 0) DESC,
                   a.last_deploy_at DESC NULLS LAST, a.created_at DESC`,
        [HIDDEN_APP_STATUSES]
      );

      const byApp = await loadContributors(pool, apps.map((a) => a.id));

      res.json({
        apps: apps.map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          status: a.status,
          collab_visibility: a.collab_visibility,
          view_visibility: a.view_visibility,
          created_at: a.created_at,
          last_deploy_at: a.last_deploy_at,
          // Home-card presentation fields (landing-page app directory).
          // icon_url is server-built like the authed list so clients never
          // assemble ids into paths; /app-icons/:id is a public route.
          icon_emoji: a.icon_emoji || null,
          icon_url: a.icon_image_id ? `/app-icons/${a.icon_image_id}` : null,
          active_users: parseInt(a.active_users, 10) || 0,
          // From the anonymous shell + API-gate probe (services/shell-probe.js):
          // anything not positively classified 'public' is presented as
          // account-required — 'unknown' fails safe to gated, matching
          // the scaffold's default behavior.
          requires_login: a.anon_shell !== 'public',
          // Direct subdomain URL — what the public landing page links to.
          // View-public apps pass the Caddy edge gate without a session;
          // apps that JWT-gate their own HTML shell will show their
          // "Open in Homeroom" page to anonymous visitors.
          url: `https://${productionHostname(a.slug)}`,
          contributors: (byApp.get(a.id) || []).map((r) =>
            shapeContributor(r, includeWallets)
          ),
        })),
      });
    } catch (err) {
      log.error('public-api', 'apps list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/apps/:slug/contributors — one app's contributor list.
  // 404 (never 403) for a missing, self-hosted, or view-private slug so a
  // hidden app's existence isn't disclosed.
  router.get('/api/public/apps/:slug/contributors', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, self_hosted, view_visibility
           FROM apps WHERE slug = $1`,
        [String(req.params.slug)]
      );
      const app = rows[0];
      if (!app || app.self_hosted || app.view_visibility !== 'public') {
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

  // GET /api/public/waitlist/options — the survey question definitions
  // (option keys + labels, countries, limits). The SPA renders both
  // waitlist forms from this so client and server validation can't
  // drift; the payload is static per process.
  router.get('/api/public/waitlist/options', (_req, res) => {
    res.json(questions.publicOptions());
  });

  // POST /api/public/waitlist — platform waitlist join (onboarding flow
  // alignment), now carrying the stage-1 survey (mirrors the original
  // topochain waitlist: made_url + discovery required, location
  // optional). No account required. Idempotent and non-enumerating: an
  // email that's already on the list gets the same 200 as a fresh one —
  // but only the FIRST join gets a stage-2 `more` link back (re-joins
  // must not hand a stranger the capability to edit someone's answers).
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
    try {
      const { created, moreToken } = await waitlist.joinWaitlist(pool, {
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
      if (created) {
        log.info('public-api', 'Waitlist join', {});
        // Best-effort like the mail itself: a code that cannot be minted
        // must not fail the join, and the one-click link still confirms.
        const code = await waitlist.issueVerificationCode(pool, email).catch(() => null);
        sendWaitlistJoinMail(config, email, { moreToken, code }); // fire-and-forget, never throws
      } else {
        // A RE-JOIN. The row already existed, so nothing above ran — and
        // the screen still says "we sent a six-digit code to you@…",
        // because the client only ever sees this endpoint's 200. That was
        // the lie: somebody who joined last week, typed their address in
        // again and sat waiting for a code that was never minted.
        //
        // So mint one, on the resend kind rather than the join kind: the
        // words a returning person needs are "here is your code", not a
        // second welcome, and waitlist_joined's one-per-day rule would
        // drop this send anyway. An already-confirmed address gets the
        // mail's other shape, which says there is nothing left to do.
        //
        // Both are fire-and-forget, and the response body below is
        // untouched — byte for byte the same object every re-join has
        // always received, whatever branch ran here. The mail throttle is
        // what bounds how often this can actually send.
        await resendConfirmation(email).catch(() => {});
      }
      res.json({
        ok: true,
        message: "You're on the waitlist. We'll email you when access opens up.",
        // Stage-2 capability — present only on the first join.
        more_token: moreToken || null,
      });
    } catch (err) {
      log.error('public-api', 'waitlist join failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Mint a fresh code for an address and mail it. Shared by POST /resend
  // and by the re-join branch above so the two cannot drift.
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
  // the waitlist", which is the contract the join and confirm endpoints
  // beside it already keep.
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
  // banner shows on the landing screen too.
  //
  // The URL is `app_version_configs.update_url`, which already exists, is
  // already editable in the admin console (App version), and is already the
  // place the native update gate sends a user to. A store listing is the same
  // destination whether you are updating or arriving, so this needs no new
  // setting and no second thing for an operator to keep in sync — the day a
  // listing goes live, one field turns the banner on.
  //
  // NOT a reuse of POST /api/v4/app-version/check: that route records a
  // version check for analytics, so answering this from it would file a check
  // for a build that does not exist on every mobile pageview.
  router.get('/api/public/mobile-app', async (_req, res) => {
    // Both keys are always present, so the client has one shape to read.
    const urls = { ios: null, android: null };
    try {
      const { rows } = await pool.query(
        `SELECT os, update_url FROM app_version_configs
          WHERE is_active = TRUE AND os IN ('ios', 'android')`
      );
      for (const row of rows) {
        const url = String(row.update_url || '').trim();
        if (url && Object.prototype.hasOwnProperty.call(urls, row.os)) urls[row.os] = url;
      }
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
