'use strict';

// Where a person came from (#6540): only a hostname and a short tag ever
// leave the arrival source helper. A full URL, a path, a query or a port is
// never stored; a forged tag is dropped rather than kept.

const test = require('node:test');
const assert = require('node:assert/strict');

const { hostOf, cleanTag, cleanVia } = require('../src/services/arrival-source');

test('hostOf keeps the hostname only: no scheme, path, query or port', () => {
  assert.equal(hostOf('https://discord.com/channels/12/34?secret=1'), 'discord.com');
  assert.equal(hostOf('http://t.co/abc'), 't.co');
  assert.equal(hostOf('https://web.whatsapp.com/send?text=hi'), 'web.whatsapp.com');
  assert.equal(hostOf('https://www.example.com:8443/a/b?c=d'), 'example.com');
  assert.equal(hostOf('discord.com'), 'discord.com', 'a bare host is accepted');
  assert.equal(hostOf('discord.com/path'), 'discord.com');
  assert.equal(hostOf('Web.WhatsApp.COM'), 'web.whatsapp.com', 'lowercased');
  for (const bad of ['', '   ', null, 'not a host', 'https://', 'javascript:alert(1)']) {
    assert.equal(hostOf(bad), null, String(bad));
  }
});

test('cleanVia keeps a short lower-case tag, and nothing else', () => {
  assert.equal(cleanVia('copied'), 'copied');
  assert.equal(cleanVia('shared'), 'shared');
  assert.equal(cleanVia(' Shared '), 'shared');
  for (const bad of ['', 'with space', 'tag<script>', 'x'.repeat(25), null, 42]) {
    assert.equal(cleanVia(bad), null, String(bad));
  }
});

test('cleanTag keeps a utm value or ref within its pattern and length', () => {
  assert.equal(cleanTag('x'), 'x');
  assert.equal(cleanTag('launch_2026.final-1'), 'launch_2026.final-1');
  assert.equal(cleanTag('x'.repeat(64)), 'x'.repeat(64));
  for (const bad of ['', 'x'.repeat(65), 'two words', 'a/b', 'a?b', null, 7]) {
    assert.equal(cleanTag(bad), null, String(bad));
  }
});
