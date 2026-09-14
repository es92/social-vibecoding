// Regression coverage for screenshots in the GitHub half of an issue
// discussion. GitHub writes resized uploads as raw <img ...> HTML. The shared
// Markdown renderer escapes arbitrary HTML, so the image-enabled path must
// recognize that one shape and rebuild controlled image markup.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { marked } = require('marked');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);

function loadRenderer() {
  let sanitizeOptions = null;
  const sandbox = {
    marked,
    DOMPurify: {
      addHook() {},
      sanitize(html, options) {
        sanitizeOptions = options;
        return html;
      },
    },
    localStorage: { getItem: () => null },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    URL,
    URLSearchParams,
    AbortController,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    render: (text, options) => sandbox.__DevChat.renderMarkdown(text, options),
    sanitizeOptions: () => sanitizeOptions,
  };
}

test('image-enabled issue Markdown renders GitHub raw screenshot HTML safely', () => {
  const renderer = loadRenderer();
  const body = 'See below.\n\n'
    + '<img width="367" height="212" alt="Image" '
    + 'src="https://github.com/user-attachments/assets/example" onerror="alert(1)" />';

  const html = renderer.render(body, { images: true });
  assert.match(html, /<img class="dc-inline-img" src="https:\/\/github\.com\/user-attachments\/assets\/example" alt="Image" loading="lazy">/);
  assert.doesNotMatch(html, /onerror|width=|height=/, 'untrusted raw attributes are discarded');
  assert.ok(renderer.sanitizeOptions().ALLOWED_TAGS.includes('img'));
  assert.ok(renderer.sanitizeOptions().ALLOWED_ATTR.includes('src'));
});

test('raw image HTML stays escaped without opt-in and unsafe sources never render', () => {
  const renderer = loadRenderer();
  const safeTag = '<img alt="Image" src="https://github.com/user-attachments/assets/example">';
  const unsafeTag = '<img alt="Image" src="javascript:alert(1)">';

  assert.match(renderer.render(safeTag), /&lt;img/);
  assert.doesNotMatch(renderer.render(safeTag), /<img class="dc-inline-img"/);
  assert.match(renderer.render(unsafeTag, { images: true }), /&lt;img/);
  assert.doesNotMatch(renderer.render(unsafeTag, { images: true }), /<img class="dc-inline-img"/);
});
