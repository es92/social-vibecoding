// #2439: one red for a dialog's inline error text.
//
// Eight slots in six dialogs sat at bare `text-red-400` — #f87171, about
// 2.6:1 on the white card, a leftover from the dark-only shell — beside ten
// places already spelling it `text-red-700 dark:text-red-400`. Two more said
// `text-red-500` (app-allowance, the illustration editor) and two
// `text-red-600 dark:text-red-400` (app-settings, wallet-recovery).
//
// Scoped to the slots, not to every red in the product: a red GLYPH is a mark
// rather than body text, and an alert's own ground (dev-chat's banners, the
// llm-consent modal) pairs deeper values against a tint on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Each entry: the file, and the error slots in it, by the id or the
// surrounding attribute that identifies the slot.
const SLOTS = [
  ['frontend/src/features/dialogs/rename-app.tsx', ['id="rename-error"']],
  ['frontend/src/features/dialogs/members.tsx', ['id="members-load-error"', 'id="members-governance-error"']],
  ['frontend/src/features/dialogs/import-pr.tsx', ['const ERROR_CLASS', 'id="import-pr-error"']],
  ['frontend/src/features/dialogs/fork-app.tsx', ['id="fork-error"']],
  ['frontend/src/features/dialogs/close-issue.tsx', ['id="close-issue-error"']],
  // The retired create dialog's #create-error is the make screen's and its
  // import form's lines now (the alert, and what a field still needs).
  ['frontend/src/features/first-session/make.tsx', ["const NEEDED = '", '<p role="alert" className="mt-3']],
  ['frontend/src/features/first-session/import-repo.tsx', ["const NEEDED = '", '<p role="alert" className="mt-3']],
  ['frontend/src/features/dialogs/app-allowance.tsx', ['role="alert"']],
  ['frontend/src/features/dialogs/app-settings.tsx', ['role="alert"', "accessMessageIsError ? 'text-red"]],
  ['frontend/src/features/dialogs/wallet-recovery.tsx', ['role="alert"']],
  ['frontend/src/features/apps/featured-illustration-editor.tsx', ['role="alert"']],
];

test('every inline error slot reads text-red-700 dark:text-red-400', () => {
  const wrong = [];
  for (const [rel, anchors] of SLOTS) {
    const src = read(rel);
    for (const anchor of anchors) {
      const at = src.indexOf(anchor);
      assert.notEqual(at, -1, `${rel}: ${anchor} — anchor moved, update this test`);
      // The class string sits within the same element as its anchor.
      const around = src.slice(Math.max(0, at - 220), at + 220);
      const reds = around.match(/text-red-\d00/g) || [];
      if (!reds.includes('text-red-700') || !around.includes('text-red-700 dark:text-red-400')) {
        wrong.push(`${rel} (${anchor}): ${reds.join(' ') || 'no red'}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `error text is one red:\n${wrong.join('\n')}`);
});

test('the dialogs keep no bare light-only red on their error text', () => {
  const bare = [];
  for (const [rel] of SLOTS) {
    read(rel).split('\n').forEach((line, i) => {
      if (/Icon\b|aria-hidden/.test(line)) return; // a glyph carries its own colour
      if (/text-red-(400|500|600)/.test(line) && !line.includes('text-red-700 dark:text-red-400')) {
        bare.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bare, [], `light-only red left behind:\n${bare.join('\n')}`);
});
