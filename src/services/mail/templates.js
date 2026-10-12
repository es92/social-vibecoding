// Message bodies for every kind of platform mail, in one place.
//
// `kind` is the discriminator every caller passes (see index.js). A
// template returns { subject, text, html } — text is the authoritative
// copy (it is what the tests assert on, and what a text-only client
// shows); html is a minimal, style-light rendering of the same words so
// the mail doesn't look broken in a modern client. Nothing here knows
// about a provider: transports/ takes these three fields and encodes
// them however their API wants.
//
// An unknown kind is a programming error, so it throws rather than
// sending a blank email. index.js swallows that (it must never make an
// always-200 endpoint fail) and logs it.
'use strict';

const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const tracking = require('./tracking');

// Minimal HTML escaping — these bodies interpolate an email address, a
// six-digit code and platform-built URLs, never free user text, but
// escaping is cheap and keeps that true if a payload field ever grows.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The ONE branded frame every send goes through (#1555, restyled for #2673).
 *
 * The report was that the mails do not look like one another. They did not:
 * the shell was a bare `<body>` with a font stack, three templates wrapped
 * themselves in it, one was wrapped by `buildMessage`, and the result had no
 * sender identity anywhere except inside the sentences.
 *
 * ── Why a logo image now, reversing the #1555 call ─────────────────────
 *
 * #1555 argued for a text wordmark instead of an `<img>`: Gmail/Outlook block
 * remote images until the reader asks, Apple Mail proxies them, and a data:
 * URI is stripped by some clients and counted against others' clipping
 * threshold. All of that is still true. #2673 asks for the logo anyway, so
 * the tradeoff is accepted deliberately rather than papered over: the `alt`
 * text below IS the wordmark fallback for a client that blocks the image, so
 * the identity still renders as type when the picture does not. The asset is
 * hosted on the platform's OWN origin (public/brand/, the same public,
 * unauthenticated tier /icons/ and /illustrations/ already use — see
 * src/middleware/auth.js), not a third party, so there is nothing here for a
 * mail client's remote-content warning to be right to warn about.
 *
 * ── Table-free, and deliberately ───────────────────────────────────────
 *
 * The layout is one centred block with a max width. There is no grid to hold
 * together, so the usual `<table>` scaffolding buys nothing here and costs
 * every future editor a nested-markup puzzle. Inline styles only: `<style>`
 * blocks and classes are stripped by Gmail's clipper and by Outlook.
 *
 * ── Colors are the platform's own tokens, not generic defaults ─────────
 *
 * Every hex below is read off tailwind.config.js's `violet`/`zinc` scales and
 * public/css/app.css's `--accent*` custom properties — the same accent and
 * neutral ramp the app UI itself renders with, not a default blue or a
 * mail-template grey invented for this file.
 *
 * ── The footer says what this IS and why it arrived ────────────────────
 *
 * Claiming anything more would be a promise the platform does not keep: there
 * is no preference centre and no unsubscribe route for transactional mail, so
 * the footer does not offer one. It names the product, and it says these are
 * account mails rather than marketing — which is the honest answer to "why am
 * I getting this".
 */
const BRAND_NAME = 'Homeroom';
// tailwind.config.js `violet` ramp / public/css/app.css `--accent*`.
const BRAND_ACCENT = '#0a6ee0'; // violet-600, --accent — the CTA fill and link color.
// tailwind.config.js `zinc` ramp — the app's neutral ink and surfaces.
const NEUTRAL_PAGE_BG = '#f5f5f7'; // zinc-50
const NEUTRAL_HAIRLINE = '#e3e3e6'; // zinc-200
const NEUTRAL_INK = '#1c1c1e'; // zinc-900
const NEUTRAL_SECONDARY_INK = '#68686c'; // zinc-500
// #2908: the product's own script logotype (frontend/@/components/ui/
// wordmark.tsx), rasterized, replacing #2673's pixel-font "HOMEROOM". A NEW
// file name rather than new bytes under the old one: mail clients and image
// proxies cache by URL, and the old file stays in place for mail already sent.
const LOGO_URL = `${PRODUCTION_ORIGIN}/brand/homeroom-logotype-black.png`;
const LOGO_ALT = 'Homeroom';
const BODY_STYLE =
  `margin:0;padding:24px 12px;background:${NEUTRAL_PAGE_BG};font-family:-apple-system,`
  + 'Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;'
  + `line-height:1.55;color:${NEUTRAL_INK}`;
const CARD_STYLE =
  'max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;'
  + 'padding:28px 24px';
const LOGO_STYLE = 'display:block;margin:0 0 20px;border:0;outline:none;text-decoration:none';
const FOOTER_STYLE =
  `margin:24px 0 0;padding-top:16px;border-top:1px solid ${NEUTRAL_HAIRLINE};`
  + `font-size:12px;line-height:1.5;color:${NEUTRAL_SECONDARY_INK}`;

// Why a mail arrived, for every kind but one: the recipient's own account
// or waitlist place. A project invite goes to an address somebody ELSE
// typed, so it says that instead (its template returns `why`); claiming the
// recipient asked for it would be the one untrue sentence in the frame.
const WHY_DEFAULT = 'You are receiving this because of activity on your account or your '
  + 'place on the waitlist. We only send mail you asked for.';

// The inbox preview line a template may set. Hidden in the body, and FIRST in
// it: clients take the preview from the first text they find, which would
// otherwise be the logo's alt text.
const PREHEADER_STYLE =
  'display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent';

const HTML_SHELL = (body, why = WHY_DEFAULT, preheader = null) =>
  '<!doctype html><html><body style="' + BODY_STYLE + '">'
  + (preheader ? `<div style="${PREHEADER_STYLE}">${esc(preheader)}</div>` : '')
  + '<div style="' + CARD_STYLE + '">'
  + `<img src="${LOGO_URL}" width="140" height="37" alt="${esc(LOGO_ALT)}" `
  + `style="${LOGO_STYLE}">`
  + body
  + '<div style="' + FOOTER_STYLE + '">'
  + BRAND_NAME
  + '<br>' + esc(why)
  + '</div>'
  + '</div>'
  + '</body></html>';

const p = (s) => `<p>${s}</p>`;
const link = (url) => `<a href="${esc(url)}" style="color:${BRAND_ACCENT}">${esc(url)}</a>`;

/**
 * The mail's ONE action, as a button (#1540).
 *
 * The confirm step used to be a sentence followed by the raw URL printed as
 * its own link text — sixty-odd characters of `https://…/api/public/waitlist/
 * confirm/<48 hex>` wrapping across two lines. That is not a call to action,
 * it is a machine address a person is being asked to aim at, and next to a
 * large six-digit code it read as the lesser of two chores rather than the
 * one-tap path it actually is.
 *
 * Inline styles and a real `<a>`: `<button>` does nothing in a mail client,
 * `<style>` blocks are stripped by Gmail's clipper and Outlook, and a
 * `mso-` conditional table would be scaffolding for a single control. Padding
 * on the anchor is what every client renders consistently.
 *
 * The URL still appears in the TEXT part, which is where a reader who cannot
 * see HTML needs it.
 */
const BUTTON_STYLE =
  `display:inline-block;padding:11px 20px;border-radius:8px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:15px;font-weight:600;text-decoration:none';
const button = (url, label) =>
  `<p><a href="${esc(url)}" style="${BUTTON_STYLE}">${esc(label)}</a></p>`;

// A one-time code, set big enough to read at arm's length and to copy by
// eye off a phone. Three mails carry one and all three render it this way;
// #1516 asked for the join mail to stop being the odd one out.
const codeBlock = (code) =>
  `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${esc(code)}</p>`;

function otp(payload) {
  const code = payload.code;
  return {
    subject: 'Your Homeroom login code',
    text: `Your Homeroom login code is ${code}.\n\n`
      + 'It expires in 10 minutes. If you did not request it, you can ignore this email.',
    html: (
      p('Your Homeroom login code is:')
      + codeBlock(code)
      + p('It expires in 10 minutes. If you did not request it, you can ignore this email.')
    ),
  };
}

// Waitlist join confirmation. One optional link:
//   - payload.confirmUrl — the one-click "confirm this address" link.
//     Following it stamps waitlist_signups.confirmed_at and lands on the
//     stage-2 survey, so confirming and answering are one motion.
// It may be absent (an idempotent re-join carries none), and the copy must
// not grow an empty paragraph or the string "undefined" when that happens.
//
// #2908 removed the closing "Want to increase your chances of getting into
// an earlier group?" paragraph and its #more/<token> survey link. Callers
// still pass payload.url; this template no longer prints it.
//
// The shape follows Andrea's copy (doc comment, 27 Aug 2026): thank, set
// the expectation, confirm, and only then offer the optional questions.
//
// Two deliberate departures from that draft. It opens "The first early
// access group opens [September 9]" — the date is a placeholder and no
// wave has been committed to, so the sentence keeps the rolling-groups
// promise and drops the date rather than shipping one that slips. And it
// addresses the reader as [BRAND NAME], which is BRAND_NAME above — the
// rename to Homeroom moved every surface at once, and this line moved
// with the rest.
function waitlistJoined(payload) {
  const confirmUrl = payload.confirmUrl || null;

  let text = '';
  let html = '';

  // #1516: the code LEADS the mail. Somebody opening this on a phone is
  // here to type six digits, and the welcome above them was three
  // paragraphs to scroll past first — so the ask comes first, in the same
  // large type `otp` and `waitlistCode` already use, and the thank-you
  // follows it. On a phone, leaving for the mail app and coming back loses
  // the WebView's place, so typing the code beats following a link; on
  // desktop the one-click link below is still one click. Either confirms
  // the same row.
  //
  // Confirming is now what puts somebody ON the list rather than a tidy-up
  // afterwards, so the copy asks for it plainly instead of mentioning it in
  // passing.
  if (payload.code) {
    text += 'Confirm your email\n'
      + `Your verification code is ${payload.code}. It works for 15 minutes.\n\n`;
    html += p('<strong>Confirm your email</strong>')
      + codeBlock(payload.code)
      + p('It works for 15 minutes.');
  }

  text += 'Thanks for joining the Homeroom waitlist.\n\n'
    + "We'll email you at this address as soon as your access is ready.\n\n"
    + 'Early access opens in small groups, with more groups opening on a '
    + 'rolling basis after that.';
  html += p('Thanks for joining the Homeroom waitlist.')
    + p("We'll email you at this address as soon as your access is ready.")
    + p('Early access opens in small groups, with more groups opening on a '
      + 'rolling basis after that.');

  if (confirmUrl) {
    text += '\n\nOr confirm in one tap:\n' + confirmUrl;
    html += button(confirmUrl, 'Confirm my email');
  }

  return { subject: "You're on the Homeroom waitlist 🎉", text, html };
}

// A REQUESTED confirmation code (POST /api/public/waitlist/resend, and the
// re-join branch of POST /api/public/waitlist). Separate from
// waitlist_joined because the join mail is a welcome that happens to carry
// a code, is capped at one per address per day, and re-sending it would
// tell somebody they had "joined" a list they joined weeks ago.
//
// Three shapes, and the branch is the ONLY place the platform ever
// discloses whether an address is already confirmed. The endpoint answers
// the same words to everyone; the inbox belongs to the address itself, so
// it is the one channel where saying "you are already confirmed" leaks
// nothing.
//
// `payload.confirmed` picks between the two code shapes. A confirmed
// address asking for a code is check-my-status (#1538), so the mail is a
// status code and its one button carries NO capability token — a code you
// type is the thing that survives a mail scanner rewriting links (#1545),
// and moving away from mailed magic links is the direction #1531 wants.
function waitlistCode(payload) {
  // Minting failed for an already-confirmed address: there is no code to
  // type, so the useful answer is where to look at where they stand.
  if (!payload.code) {
    const statusUrl = payload.statusUrl || null;
    let text = 'You asked for a new confirmation code for the Homeroom waitlist.\n\n'
      + 'This address is already confirmed, so there is nothing left to do. '
      + "You're on the list and we'll email you when your spot opens.";
    let html = p('You asked for a new confirmation code for the Homeroom waitlist.')
      + p('This address is already confirmed, so there is nothing left to do. '
        + "You're on the list and we'll email you when your spot opens.");
    if (statusUrl) {
      text += `\n\nCheck where you stand: ${statusUrl}`;
      html += p(`Check where you stand: ${link(statusUrl)}`);
    }
    return { subject: 'Your Homeroom waitlist address is already confirmed', text, html };
  }

  // The status-code shape: same six digits, different errand.
  if (payload.confirmed) {
    const statusUrl = payload.statusUrl || null;
    let text = `Your Homeroom waitlist status code is ${payload.code}. `
      + 'It works for 15 minutes.\n\n'
      + 'Any earlier code has stopped working, so use this one.';
    let html = p('Your Homeroom waitlist status code is:')
      + codeBlock(payload.code)
      + p('It works for 15 minutes. Any earlier code has stopped working, so use this one.');
    if (statusUrl) {
      text += '\n\nEnter it here:\n' + statusUrl;
      html += button(statusUrl, 'Check my status');
    }
    text += '\n\nIf you did not ask for this, you can ignore this email.';
    html += p('If you did not ask for this, you can ignore this email.');
    return { subject: 'Your Homeroom waitlist status code', text, html };
  }

  const confirmUrl = payload.confirmUrl || null;
  let text = `Your Homeroom waitlist confirmation code is ${payload.code}. `
    + 'It works for 15 minutes.\n\n'
    + 'Any earlier code has stopped working, so use this one.';
  let html = p('Your Homeroom waitlist confirmation code is:')
    + codeBlock(payload.code)
    + p('It works for 15 minutes. Any earlier code has stopped working, so use this one.');
  if (confirmUrl) {
    text += '\n\nOr confirm in one tap:\n' + confirmUrl;
    html += button(confirmUrl, 'Confirm my email');
  }
  text += '\n\nIf you did not ask for this, you can ignore this email.';
  html += p('If you did not ask for this, you can ignore this email.');

  return { subject: 'Your Homeroom waitlist confirmation code', text, html };
}

// Waitlist release, the "you're in" welcome. #4570 restyled it after the
// signed-out landing page (frontend/src/features/auth/landing.tsx) and cut it
// to its one job: get the person in now that their spot is open. A
// no-account link without a one-time sign-in carries only the released
// address, and opening it asks for a sign-in code straight away, so say so:
// the recipient should be expecting a second email rather than hunting for a
// button. The 10-minute figure must match OTP_TTL_MS in
// src/services/email-signup.js.
//
// A link WITH the one-time sign-in (#4594, services/release-links.js) gets no
// note: the button signs them in, and the screen its fallback opens says
// itself that a code was sent. The link is bound to the released address and
// the fallback fills it in, so the mail does not ask them to remember which
// address they joined with either.
const RELEASE_CODE_NOTE = 'Opening it emails you a 6-digit code to sign in with. '
  + 'The code expires in 10 minutes.';

const RELEASE_HEADLINE = 'Make and share apps with groups and friends.';

// The landing page's people illustration, the same file that screen draws at
// /brand/people.png. An absolute URL for the same reason the logo's is: a
// mail client has no page context to resolve a relative one against. Empty
// `alt` because it is decorative — the headline under it carries the meaning,
// and a client that blocks images shows a blank gap, not a broken layout.
const ILLUSTRATION_URL = `${PRODUCTION_ORIGIN}/brand/people.png`;

// The three "once you're inside" points as landing-page chips. The colours are
// the MID stops of frontend/src/features/auth/landing.tsx's `CHIPS`
// gradients — one solid fill per chip rather than the gradient itself,
// because mail clients do not draw `radial-gradient` reliably.
const RELEASE_CAN_DO = [
  { line: 'Make an app for your group', color: '#3484fc' },
  { line: 'Use and improve apps together', color: '#8bd669' },
  { line: 'Suggest, preview and vote on changes', color: '#fc5750' },
];

// Install notes per platform, one line each with the one step that is a
// link. The links are the published store listings
// (services/mobile-store-links.js), so a platform whose listing is cleared
// drops out instead of pointing nowhere.
const RELEASE_MOBILE = [
  {
    os: 'ios',
    name: 'iPhone',
    line: (a) => `Install TestFlight, then ${a('open the Homeroom invite')}.`,
  },
  {
    os: 'android',
    name: 'Android',
    line: (a) =>
      `${a('Open the Homeroom testing link')} while signed into Google Play with your waitlist email.`,
  },
];

const inlineLink = (url, label) =>
  `<a href="${esc(url)}" style="color:${BRAND_ACCENT}">${esc(label)}</a>`;

// The landing page's primary pill, flattened to what a mail client renders:
// inline styles on a real `<a>`, the full-round radius instead of the shared
// BUTTON_STYLE's 8px. #1540's rule still holds — this is the mail's one
// action, and nothing else here is styled as a button.
const RELEASE_PILL_STYLE =
  `display:inline-block;padding:12px 28px;border-radius:999px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:16px;font-weight:650;text-decoration:none';
const releasePill = (url, label) =>
  `<p style="margin:20px 0 0"><a href="${esc(url)}" style="${RELEASE_PILL_STYLE}">${esc(label)}</a></p>`;

// The hero (illustration, eyebrow, headline, line, pill, code note) is one
// centred cell, like the landing page's pitch block. Table scaffolding here
// is not the frame's "table-free" rule broken: a cell's text-align:center is
// the one centreing a plain block cannot carry in clients that ignore
// margins on paragraphs, and this is the one template that needs it.
const releaseCentered = (inner) =>
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
  + ' style="border-collapse:collapse"><tr><td style="text-align:center">'
  + inner
  + '</td></tr></table>';

// One chip, as the landing rail draws it: a square card, no radius (the
// corners are the chip's whole character on a page of round pills), a 1px
// near-black hairline, the board's hard 2px/2px offset shadow, and a 34px
// solid colour block flush into its left edge. Its own table because a
// floating row needs one, and `border-collapse:separate` so the hairline
// draws around the card rather than collapsing away.
const releaseChip = ({ line, color }, top = 0) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
  + ` style="border-collapse:separate;margin:${top}px 0 8px;border:1px solid #0b0b0c;`
  + 'box-shadow:2px 2px 4px rgba(161,152,152,0.25)">'
  + '<tr>'
  + `<td width="34" height="34" bgcolor="${color}" style="width:34px;height:34px;background:${color}">&nbsp;</td>`
  + `<td style="font-size:15px;line-height:1.4;padding:0 12px 0 8px;color:${NEUTRAL_INK}">${esc(line)}</td>`
  + '</tr></table>';

function waitlistReleased(payload) {
  const url = payload.url;
  const hasAccount = !!payload.hasAccount;
  const mobile = payload.mobile || {};
  const platforms = RELEASE_MOBILE.filter((m) => mobile[m.os]);

  const action = hasAccount ? 'Sign in' : 'Create my account';
  const how = hasAccount
    ? 'Your account now has access. Sign in with your waitlist email.'
    : null;
  // #1548: a no-account link with no one-time sign-in sends a code the
  // moment it is opened, so say so. Somebody who is not told to expect a
  // SECOND email goes hunting for a button that is not there.
  const note = !hasAccount && !payload.signInLink ? RELEASE_CODE_NOTE : null;

  // The text part has no button, so it names the action over the link.
  let text = `You're in.\n${RELEASE_HEADLINE}\n\n${how || `${action}:`}\n${url}`;
  if (note) text += `\n\n${note}`;
  text += '\n\n' + RELEASE_CAN_DO.map((c) => `- ${c.line}`).join('\n');

  let html = releaseCentered(
    `<img src="${ILLUSTRATION_URL}" width="272" height="204" alt=""`
      + ' style="display:block;margin:0 auto;border:0;max-width:100%;height:auto">'
    + `<p style="margin:20px 0 0;font-size:13px;font-weight:600;letter-spacing:0.8px;`
      + `text-transform:uppercase;color:${NEUTRAL_SECONDARY_INK}">You're in</p>`
    + `<p style="margin:10px 0 0;font-size:28px;line-height:32px;font-weight:800;`
      + `color:${NEUTRAL_INK}">${esc(RELEASE_HEADLINE)}</p>`
    + (how ? `<p style="margin:10px 0 0;font-size:16px;line-height:22px;`
      + `color:${NEUTRAL_SECONDARY_INK}">${esc(how)}</p>` : '')
    + releasePill(url, action)
    + (note ? `<p style="margin:10px 0 0;font-size:13px;`
      + `color:${NEUTRAL_SECONDARY_INK}">${esc(note)}</p>` : '')
  )
    + RELEASE_CAN_DO.map((c, i) => releaseChip(c, i === 0 ? 24 : 0)).join('');

  if (platforms.length) {
    text += '\n\nTry it on mobile';
    html += `<p style="margin:24px 0 8px;font-size:12px;font-weight:700;`
      + `letter-spacing:0.06em;text-transform:uppercase;`
      + `color:${NEUTRAL_SECONDARY_INK}">Try it on mobile</p>`;
    for (const m of platforms) {
      const link = mobile[m.os];
      text += `\n${m.name}: ${m.line((label) => `${label} (${link})`)}`;
      html += `<p style="margin:0 0 8px"><strong>${esc(m.name)}</strong>: `
        + m.line((label) => inlineLink(link, label))
        + '</p>';
    }
  }

  text += '\n\nSee you there,\nEvan from Homeroom';
  html += p('See you there,<br>Evan from Homeroom');

  return {
    subject: "You're in. Welcome to Homeroom",
    preheader: "Make and share apps with groups and friends. Here's how to get started.",
    text,
    html,
  };
}

// Password-reset magic link (#login → "Forgot password"). Carries the
// tokenized link and nothing else the recipient could be phished with —
// no username, no code to read back to anyone. The 30-minute figure must
// match RESET_TOKEN_TTL_MS in src/routes/auth.js.
function passwordReset(payload) {
  const url = payload.url;
  return {
    subject: 'Reset your Homeroom password',
    text: 'Someone asked to reset the password for the Homeroom account with this '
      + 'email address.\n\n'
      + `Set a new password here: ${url}\n\n`
      + 'The link expires in 30 minutes and works once. If you did not request '
      + 'this, you can ignore it. Your password is unchanged.',
    html: (
      p('Someone asked to reset the password for the Homeroom account with this '
        + 'email address.')
      + p(`Set a new password here: ${link(url)}`)
      + p('The link expires in 30 minutes and works once. If you did not request '
        + 'this, you can ignore it. Your password is unchanged.')
    ),
  };
}

// The admin console's "send a test email" message.
//
// Deliberately carries NOTHING sensitive: no code, no token, no link a
// recipient could act on. Its whole job is to be identifiable in an
// inbox and traceable back to the attempt that produced it, so it names
// the provider, the sender, the timestamp and the short reference id
// that the console's activity table also shows.
function adminTest(payload) {
  const provider = payload.provider || 'unknown';
  const from = payload.from || '(unset)';
  const sentAt = payload.sentAt || '';
  const reference = payload.reference || '(none)';

  const text = 'This is a test email from the Homeroom platform admin console.\n\n'
    + `Provider: ${provider}\n`
    + `Sent as: ${from}\n`
    + `Sent at: ${sentAt}\n`
    + `Reference: ${reference}\n\n`
    + 'An administrator sent it to check that outbound email works. '
    + 'No action is needed.';

  return {
    subject: 'Homeroom test email',
    text,
    html: (
      p('This is a test email from the Homeroom platform admin console.')
      + `<p>Provider: <strong>${esc(provider)}</strong><br>`
      + `Sent as: ${esc(from)}<br>`
      + `Sent at: ${esc(sentAt)}<br>`
      + `Reference: <code>${esc(reference)}</code></p>`
      + p('An administrator sent it to check that outbound email works. '
        + 'No action is needed.')
    ),
  };
}

// A project invite, to an address that is not on Homeroom yet (the create
// dialog's "Will invite" rows; services/email-invites.js). One link: the
// waitlist, joined with this address. Nothing here grants access; the invite
// waits on the account and turns into an ordinary one once the address is
// confirmed on it. Every field is optional so the kind still renders empty.
function projectInvite(payload) {
  const inviter = payload.inviter ? `@${payload.inviter}` : 'Someone';
  const project = payload.project || 'a project';
  const url = payload.url || '';
  const lead = `${inviter} invited you to ${project}, a private community on Homeroom, where communities build the apps they use together.`;
  const how = 'Join the waitlist with this email address. Once you are in, the invite will be waiting for you.';
  return {
    why: 'You are receiving this because someone on Homeroom invited this address to a project. '
      + 'You will not hear from us again unless you join, or somebody invites you again.',
    subject: `${inviter} invited you to ${project} on Homeroom`,
    text: `${lead}\n\n${how}${url ? `\n\n${url}` : ''}\n\nIf you were not expecting this, you can ignore this email.`,
    html: (
      p(lead)
      + p(how)
      + (url ? button(url, 'Join the waitlist') : '')
      + p('If you were not expecting this, you can ignore this email.')
    ),
  };
}

// WP-E: activity mail, the stand-in for a push somebody's phone cannot take
// (services/activity-mail.js). Unlike every kind above, the recipient did not
// ask for this one by doing something just now, so each says why it came,
// carries a one-click unsubscribe (RFC 8058: `List-Unsubscribe` with
// `List-Unsubscribe-Post`), and offers the same link in its words.
function activityFrame({ subject, lead, url, label, unsubscribeUrl }) {
  const off = unsubscribeUrl
    ? `To stop these emails: ${unsubscribeUrl}`
    : '';
  return {
    why: 'You are receiving this because there was news on Homeroom for you and no phone '
      + 'to send it to. Turn these emails off with the link above.',
    preheader: lead,
    subject,
    text: `${lead}\n\n${label}: ${url}${off ? `\n\n${off}` : ''}`,
    html: (
      p(esc(lead))
      + button(url, label)
      + (unsubscribeUrl ? p(`<a href="${esc(unsubscribeUrl)}" style="color:${NEUTRAL_SECONDARY_INK}">Stop these emails</a>`) : '')
    ),
    headers: unsubscribeUrl ? {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : null,
  };
}

// Something somebody asked Homeroom bot for is ready to try. "One story":
// worded as its push is (homeroom-bot-notify-copy.js botEmailCopy): the
// request and its project with the body's first sentence ("Dark mode · Plant
// Pal: Ready to try"), over the push's body. A sender that did not hand the
// words over gets the same shape from the project's name.
function buildReady(payload) {
  const app = String(payload.appName || 'Your project').slice(0, 80);
  const lead = typeof payload.lead === 'string' && payload.lead.trim()
    ? payload.lead.trim().slice(0, 300)
    : (payload.notWorking
      ? 'Built, but something isn\'t working yet. Try it to see.'
      : 'Ready to try. Try it, and approve it if you\'re happy.');
  const subject = typeof payload.subject === 'string' && payload.subject.trim()
    ? payload.subject.trim().slice(0, 200)
    : `${app}: ${payload.notWorking ? 'Built, but something isn\'t working yet' : 'Ready to try'}`;
  return activityFrame({
    subject,
    lead,
    url: payload.url || PRODUCTION_ORIGIN,
    label: 'Open it',
    unsubscribeUrl: payload.unsubscribeUrl || null,
  });
}

// The people an invite link brought: "@sam joined Run Club through your invite."
function inviteActivity(payload) {
  const app = String(payload.appName || 'your project').slice(0, 80);
  const line = String(payload.line || `Someone joined ${app} through your invite.`).slice(0, 200);
  return activityFrame({
    subject: line.replace(/\.$/, ''),
    lead: line,
    url: payload.url || PRODUCTION_ORIGIN,
    label: `Open ${app}`,
    unsubscribeUrl: payload.unsubscribeUrl || null,
  });
}

/**
 * Every template returns a FRAGMENT; the frame is applied here, once (#1555).
 *
 * It used to be applied by the templates themselves — six of them wrapped
 * their own html and `waitlist_joined` was wrapped in this switch instead,
 * which is exactly the arrangement where a seventh template ships unbranded
 * because its author copied the wrong neighbour. One wrap, at the one place
 * every kind passes through, makes that impossible rather than unlikely.
 */
const TEMPLATES = {
  otp,
  account_email: ({ code }) => ({
    subject: 'Verify your account email',
    text: `Your account email verification code is ${code}.\n\nEnter it in Settings → Email & recovery to link this address to your account. It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.`,
    html: p('Enter this code in Settings → Email & recovery to link this address to your account:')
      + codeBlock(code)
      + p('It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.'),
  }),
  waitlist_joined: waitlistJoined,
  waitlist_code: waitlistCode,
  waitlist_released: waitlistReleased,
  password_reset: passwordReset,
  admin_test: adminTest,
  project_invite: projectInvite,
  build_ready: buildReady,
  invite_activity: inviteActivity,
};

function buildMessage(kind, payload = {}) {
  const template = Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? TEMPLATES[kind]
    : null;
  if (!template) throw new Error(`unknown mail kind: ${kind}`);
  const { why, preheader, headers, ...message } = template(tracking.attributedPayload(kind, payload));
  return tracking.decorate(kind, {
    ...message,
    html: HTML_SHELL(message.html, why, preheader),
    // Extra mail headers a kind needs (activity mail's List-Unsubscribe);
    // a transport adds them as given.
    ...(headers ? { headers } : {}),
  }, payload);
}

// Every kind this module can render, for the admin console and for tests
// that want to assert the set didn't quietly shrink.
const KINDS = Object.keys(TEMPLATES);

module.exports = { buildMessage, KINDS };
