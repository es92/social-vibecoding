'use strict';

// #1927: the "Replying to" banner's close button was 28px in Messages and
// roughly 24×20px in group chat — too small to hit on a phone. Both are now
// 44px, the platform's minimum tap target, and overhang the strip's padding
// with negative margins so the banner does not grow taller.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

/** A rule's body, by exact selector text (the selector list's last line). */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

function px(body, prop) {
  const m = body.match(new RegExp(`\\n\\s*${prop}:\\s*(-?\\d+)px;`));
  assert.ok(m, `expected a px \`${prop}\``);
  return Number(m[1]);
}

test('the Messages reply banner × is a 44px tap target', () => {
  const body = rule('.messages-pending-object button');
  assert.ok(CSS.includes('.messages-reply-draft button,\n.messages-pending-object button {'),
    'the rule still covers the reply banner button');
  assert.ok(px(body, 'width') >= 44, 'at least 44px wide');
  assert.ok(px(body, 'height') >= 44, 'at least 44px tall');
});

// One message box (27 Nov 2026): the group chat's box is Messages' own, so
// its reply banner is the Messages one above, × and all.
test('the group chat\'s reply banner is the Messages one', () => {
  assert.doesNotMatch(CSS, /\.gc-reply-preview-x/);
  const box = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/group-chat/composer.tsx'), 'utf8');
  assert.match(box, /<MessageBox place=\{place\}/);
});

test('it overhangs its strip padding instead of making the strip taller', () => {
  // Strip padding is 6px top/bottom (`padding: 6px 10px`), so a 44px
  // button pulls back 6px each way.
  assert.match(rule('.messages-pending-object button'), /\n\s*margin-block: -6px -6px; margin-inline: auto -8px;/);
});
