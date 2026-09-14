// One branded frame around every platform email (#1555).
//
// The report was that the mails do not look like one another, and they did
// not: the shell was a bare `<body>` with a font stack, five templates wrapped
// themselves in it, `waitlist_joined` was wrapped by `buildMessage` instead,
// and no send carried the sender's identity anywhere except inside its own
// sentences.
//
// Two things are pinned here, and the second is the one that keeps this true
// next year:
//
//   1. Every kind is framed — wordmark, card, footer.
//   2. The frame is applied in ONE place. Templates return fragments and
//      `buildMessage` wraps them, so a seventh template cannot ship unbranded
//      by copying the wrong neighbour, and no mail can be wrapped twice.
//
// Run with: node --test tests/mail-branding.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const templates = require(path.join(ROOT, 'src/services/mail/templates.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/mail/templates.js'), 'utf8');

/** A payload rich enough that every kind renders its fullest branch. */
const PAYLOAD = {
  code: '123456',
  url: 'https://x.invalid/?signup=1',
  confirmUrl: 'https://x.invalid/confirm/abc',
  statusUrl: 'https://x.invalid/status',
  hasAccount: false,
  provider: 'gmail',
  from: 'Homeroom <no-reply@x.invalid>',
  sentAt: '2026-09-07T00:00:00Z',
  reference: 'ref-1',
};

test('every kind is framed, and framed exactly once', () => {
  assert.ok(templates.KINDS.length >= 6, 'the kind list is intact');
  for (const kind of templates.KINDS) {
    const { html } = templates.buildMessage(kind, PAYLOAD);
    assert.equal((html.match(/<!doctype html>/gi) || []).length, 1, `${kind}: one document`);
    assert.match(html, />Homeroom<\/div>/, `${kind}: carries the wordmark`);
    assert.match(html, /Homeroom<br>You are receiving this because/, `${kind}: carries the footer`);
    assert.match(html, /activity on your account or your place on the waitlist/,
      `${kind}: says why it arrived`);
  }
});

test('the frame is applied in one place, not by the templates', () => {
  // The arrangement this replaces is the bug: six wrappers plus one in the
  // switch is how a seventh template ships unbranded.
  assert.match(SRC, /const HTML_SHELL = \(body\) =>/, 'defined once');
  assert.equal((SRC.match(/HTML_SHELL\(/g) || []).length, 1,
    'and called from exactly one place');
  const build = SRC.slice(SRC.indexOf('function buildMessage'));
  assert.match(build, /return \{ \.\.\.message, html: HTML_SHELL\(message\.html\) \};/);
});

test('an unknown kind still throws rather than sending a blank frame', () => {
  // index.js swallows this and logs it; a mail with a wordmark and no words
  // would be worse than none.
  assert.throws(() => templates.buildMessage('no-such-kind', {}), /unknown mail kind/);
  // And the lookup cannot be fooled by inherited properties.
  assert.throws(() => templates.buildMessage('constructor', {}), /unknown mail kind/);
  assert.throws(() => templates.buildMessage('toString', {}), /unknown mail kind/);
});

test('KINDS is derived from the templates, so the two cannot drift', () => {
  assert.match(SRC, /const KINDS = Object\.keys\(TEMPLATES\);/);
  for (const kind of templates.KINDS) {
    assert.doesNotThrow(() => templates.buildMessage(kind, PAYLOAD), `${kind} renders`);
  }
});

test('no remote image, no <style> block, no class attributes', () => {
  // A remote <img> is a tracking pixel to every mail client and arrives
  // blocked; <style> and classes are stripped by Gmail's clipper and Outlook.
  // The identity has to be type and inline styles or it is not identity.
  for (const kind of templates.KINDS) {
    const { html } = templates.buildMessage(kind, PAYLOAD);
    assert.doesNotMatch(html, /<img\b/i, `${kind}: no image`);
    assert.doesNotMatch(html, /<style\b/i, `${kind}: no style block`);
    assert.doesNotMatch(html, /\sclass=/i, `${kind}: no classes`);
  }
});

test('the text part is untouched by the frame', () => {
  // text is the authoritative copy (the module header says so) and the frame
  // is a rendering concern. A wordmark in the plaintext would be noise.
  for (const kind of templates.KINDS) {
    const { text } = templates.buildMessage(kind, PAYLOAD);
    assert.doesNotMatch(text, /You are receiving this because/, `${kind}: no footer in the text part`);
    assert.ok(text.trim().length > 0, `${kind}: still has copy`);
  }
});

test('the footer promises nothing the platform does not do', () => {
  // No preference centre and no unsubscribe route exists for transactional
  // mail, so the footer must not offer one.
  const { html } = templates.buildMessage('otp', PAYLOAD);
  assert.doesNotMatch(html, /unsubscribe/i);
  assert.doesNotMatch(html, /preferences/i);
});
