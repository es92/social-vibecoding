// #6510: the Settings segmented controls (Theme, Text size) are radio groups
// for the keyboard too. They declared role="radiogroup" / role="radio" and
// only answered a click, so Tab stopped on every segment and the arrow keys
// did nothing. frontend/src/lib/radio-group.ts is the WAI-ARIA radio group
// pattern once: one tab stop, the arrows (and Home/End) move the pick, and
// focus follows it.
//
// Run with: node --test tests/settings-radio-keys.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const LIB = 'frontend/src/lib/radio-group.ts';
const THEME = 'frontend/src/features/settings/sections/theme.tsx';
const ACCESSIBILITY = 'frontend/src/features/settings/sections/accessibility.tsx';

// A group of fake radios: querySelectorAll on the group returns them in
// order, and focus() records which one has it.
function fakeGroup(count) {
  const state = { focused: -1 };
  const radios = Array.from({ length: count }, (_, i) => ({ focus() { state.focused = i; } }));
  return { state, el: { querySelectorAll: () => radios } };
}

function press(keys, group, key) {
  let prevented = false;
  keys.onKeyDown({ key, currentTarget: group.el, preventDefault() { prevented = true; } });
  return prevented;
}

test('nextRadioIndex: arrows step and wrap, Home/End jump, other keys are ignored', () => {
  const { nextRadioIndex } = loadTsx(LIB);
  assert.equal(nextRadioIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextRadioIndex('ArrowRight', 1, 3), 2);
  assert.equal(nextRadioIndex('ArrowDown', 2, 3), 0, 'forward from the last wraps to the first');
  assert.equal(nextRadioIndex('ArrowUp', 0, 3), 2, 'back from the first wraps to the last');
  assert.equal(nextRadioIndex('ArrowLeft', 2, 3), 1);
  assert.equal(nextRadioIndex('Home', 2, 3), 0);
  assert.equal(nextRadioIndex('End', 0, 3), 2);
  assert.equal(nextRadioIndex('ArrowDown', -1, 3), 0, 'nothing checked: forward picks the first');
  assert.equal(nextRadioIndex('ArrowUp', -1, 3), 2, 'nothing checked: back picks the last');
  assert.equal(nextRadioIndex('Enter', 1, 3), null);
  assert.equal(nextRadioIndex('Tab', 1, 3), null);
});

test('radioGroupKeys: one tab stop, and a key picks through choose and moves focus', () => {
  const { radioGroupKeys } = loadTsx(LIB);
  const options = ['light', 'dark', 'system'];

  const none = radioGroupKeys(options, null, () => {});
  assert.deepEqual(options.map(none.tabIndex), [0, -1, -1], 'nothing checked: the first is the tab stop');

  const picked = [];
  const keys = radioGroupKeys(options, 'dark', (v) => picked.push(v));
  assert.deepEqual(options.map(keys.tabIndex), [-1, 0, -1], 'the checked radio is the only tab stop');

  const group = fakeGroup(3);
  assert.equal(press(keys, group, 'ArrowRight'), true, 'an arrow is handled, so the page does not scroll');
  assert.deepEqual(picked, ['system'], 'moving picks, through the same choose a click calls');
  assert.equal(group.state.focused, 2, 'focus follows the pick');

  picked.length = 0;
  press(keys, group, 'ArrowUp');
  assert.deepEqual(picked, ['light']);
  assert.equal(group.state.focused, 0);

  picked.length = 0;
  group.state.focused = -1;
  assert.equal(press(keys, group, 'Enter'), false, 'other keys fall through');
  assert.deepEqual(picked, []);
  assert.equal(group.state.focused, -1);
});

for (const [file, exportName, trackId, attr, options] of [
  [THEME, 'ThemeSection', 'drawer-theme-track', 'data-theme-mode', ['light', 'dark', 'system']],
  [ACCESSIBILITY, 'AccessibilitySection', 'settings-text-size-track', 'data-text-size-option', ['normal', 'large', 'larger']],
]) {
  test(`${trackId}: wired to the shared radio-group keys`, () => {
    const src = read(file);
    assert.match(src, /import \{ radioGroupKeys \} from '\.\.\/\.\.\/\.\.\/lib\/radio-group';/);
    assert.match(src, /onKeyDown=\{keys\.onKeyDown\}/, 'the group answers the arrow keys');
    assert.match(src, /tabIndex=\{keys\.tabIndex\(/, 'each radio gets its roving tabIndex');
  });

  test(`${trackId}: the prerender makes the first segment the one tab stop`, () => {
    // Nothing is checked until an effect reads storage, so the shipped markup
    // gives the first segment tabindex 0 and the others -1, and the client's
    // first render agrees with it.
    const html = renderComponent(file, exportName);
    assert.ok(html.includes(`id="${trackId}"`));
    options.forEach((option, i) => {
      const btn = html.match(new RegExp(`<button[^>]*${attr}="${option}"[^>]*>`));
      assert.ok(btn, `${option} segment missing`);
      assert.match(btn[0], new RegExp(`tabindex="${i === 0 ? 0 : -1}"`), `${option} tabindex`);
      assert.match(btn[0], /aria-checked="false"/);
    });
  });
}
