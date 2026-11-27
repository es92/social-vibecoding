// #2438 (from the #2383 audit): one row language on the Settings screen.
//
// Four list islands draw rows on that screen. They shared a hand-built
// `ROW_CLASS` (a white card a row) until the Settings rows moved onto the
// shared row: each now draws its rows with ListRow inside a GroupedList
// (@/components/ui/grouped-list), the row the rest of the shell draws, so
// there is no Settings row string left to keep in step. The CLI credentials
// list once drew the pre-reskin row, a zinc-100 fill held together by a
// border; its row action was also a bordered control there, where the
// language fills its controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, 'frontend/src/features/settings', rel), 'utf8');

const LISTS = [
  'grants-list.tsx',
  'notification-prefs-list.tsx',
  'app-permissions-list.tsx',
  'cli-tokens-list.tsx',
];

test('every Settings list row is the shared row', () => {
  for (const file of LISTS) {
    const src = read(file);
    assert.match(src, /import \{ GroupedList, ListRow \} from '@\/components\/ui\/grouped-list';/,
      `${file} draws with the shared grouped list and row`);
    assert.match(src, /<GroupedList\b/, `${file} groups its rows`);
    assert.match(src, /<ListRow\b/, `${file} draws its rows with ListRow`);
    assert.doesNotMatch(src, /ROW_CLASS|ui-mini/, `${file} keeps no hand-built row string`);
    // The fill it replaced is the page's own colour, so a row drawn in it is
    // a row drawn by its border alone.
    assert.doesNotMatch(src, /bg-zinc-100 dark:bg-zinc-800 border/, `${file} keeps no bordered zinc row`);
  }
});

test('its row action is filled, not outlined', () => {
  // The language draws no outlined control (@/components/ui/button.tsx), and
  // Revoke keeps its red because it IS destructive — only the box changed.
  const cli = read('cli-tokens-list.tsx');
  assert.match(cli, /rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900/);
  assert.doesNotMatch(cli, /border border-red-400/);
});

test('no Settings source keeps the retired hand-built row names', () => {
  // `ui-row`, `ui-row-t`, `ui-row-s`, `ui-row-tx`, `ui-row-sm`, `ui-row-meta`
  // were names only (no rule drew them) on rows the shared row draws now.
  // The one place left is the Privacy radio group, which is its own control.
  const dir = path.join(root, 'frontend/src/features/settings');
  const files = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  const left = files
    .filter((file) => /\bui-row(?:-[a-z]+)?\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(dir, file));
  // A subset, not an equality: the radio group is changed on its own, and
  // whichever of the two changes merges second must still pass.
  assert.deepEqual(left.filter((file) => file !== 'sections/privacy.tsx'), [],
    'only the radio group may still carry the names');
});
