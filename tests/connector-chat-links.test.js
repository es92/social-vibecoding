// The "set it up in Claude / ChatGPT" links in Settings → Connectors (#1607).
//
// The two product walkthroughs under the connector URL are six and seven
// steps, and the reported cost was reading them: "instructions ... are too
// long, maybe some link could be provided ... so that they imported the
// instructions to the chat". These links open a NEW chat pre-loaded with the
// server URL and the job.
//
// What they are NOT is a replacement for the steps, and that is deliberate:
// an assistant in a chat cannot click through Claude's or ChatGPT's own
// settings UI. The steps stay; this is a shortcut past the reading.
//
// Run with: node --test tests/connector-chat-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const TSX = 'frontend/src/features/settings/sections/connectors.tsx';
const SETTINGS = 'frontend/src/features/settings/settings.js';

test('#1607: both links exist and open in a new tab without handing over the opener', () => {
  const tsx = read(TSX);
  for (const id of ['connector-open-claude', 'connector-open-chatgpt']) {
    const block = tsx.slice(tsx.indexOf(`id="${id}"`));
    assert.ok(tsx.includes(`id="${id}"`), `${id} exists`);
    const head = block.slice(0, 400);
    assert.match(head, /target="_blank"/, `${id} opens in a new tab`);
    // Without rel, the opened page gets a live window.opener back into the
    // platform. Same rule #1532 applied to the waitlist connect links.
    assert.match(head, /rel="noopener noreferrer"/, `${id} hands over no opener`);
  }
});

test('#1607: the href is built from the LIVE connector URL, never hardcoded', () => {
  const settings = read(SETTINGS);
  // The written steps deliberately point back at #connector-url rather than
  // naming a host, so a fork or a config change cannot stale them. These
  // links follow the same rule: the origin comes from the same derived value
  // the field is filled with.
  assert.match(settings, /const connectorUrl = `\$\{window\.location\.origin\}\/mcp`;/);
  assert.match(settings, /urlField\.value = connectorUrl/);
  assert.match(settings, /\$\{connectorUrl\}/, 'the prompt embeds the derived URL');
  assert.match(settings, /connector-open-claude', 'https:\/\/claude\.ai\/new\?q='/);
  assert.match(settings, /connector-open-chatgpt', 'https:\/\/chatgpt\.com\/\?q='/);
  assert.match(settings, /encodeURIComponent\(chatPrompt\)/, 'the prompt is encoded');
});

test('#1607: the prompt carries the two facts people get wrong, and nothing secret', () => {
  const settings = read(SETTINGS);
  const start = settings.indexOf('const chatPrompt =');
  assert.ok(start > 0, 'the prompt is built in one place');
  const prompt = settings.slice(start, settings.indexOf('const chatLinks', start));

  // Dynamic client registration: without this, people go hunting for a client
  // ID and secret that do not exist. It is step 4 of the Claude walkthrough.
  assert.match(prompt, /dynamic client registration/);
  // The exact name. Claude Code builds its permission rules from what the
  // human types, and one account typed `Uesrnode`, silently missing every
  // rule the platform ships (#1218).
  assert.match(prompt, /"homeroom"/);

  // Nothing sensitive may travel in a query string. Rather than scanning for
  // sensitive-sounding WORDS — the prompt legitimately says "no client ID or
  // secret to enter", so that scan flags itself — pin the property that
  // actually matters: the only value interpolated into the prompt is the
  // derived connector URL. Nothing else from the page can reach the link.
  const interpolations = [...prompt.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(interpolations)], ['connectorUrl'],
    'only the derived connector URL is interpolated into the prompt');
});

test('#1607: the written walkthroughs stay, because a chat cannot click a settings UI', () => {
  const tsx = read(TSX);
  // The request hoped the link would replace the copy-paste. It cannot: an
  // assistant cannot operate the product's own settings screens. Removing the
  // reference on that hope would leave nothing authoritative behind, so both
  // walkthroughs are still here and still complete.
  assert.match(tsx, /Set up in Claude \(claude\.ai on the web\)/);
  assert.match(tsx, /Set up in ChatGPT \(on the web\)/);
  assert.match(tsx, /Turn on Developer mode\./);
  assert.match(tsx, /Paste your MCP server URL\./);
});
