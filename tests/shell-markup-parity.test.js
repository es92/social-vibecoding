// The React chassis migration's centrepiece test.
//
// Step 1 of the React + shadcn migration is a SCAFFOLDING-ONLY chassis swap:
// public/index.html stopped being hand-written and became a build artifact
// generated from frontend/src/Shell.tsx, with the explicit contract that the
// markup is carried over AS-IS and there is ZERO visual change.
//
// "Carried over as-is" is worth nothing as prose, so this test makes it a
// machine-checked claim: the generated document is compared, element by
// element, against tests/fixtures/pre-migration-index.html — a byte copy of
// the last hand-written public/index.html (commit 1d169130).
//
// What is compared: the ordered sequence of elements, their tag names, and
// every attribute and its value, plus the non-whitespace text between them.
// What is deliberately ignored: HTML comments (JSX drops them), indentation
// and whitespace-only text nodes (JSX re-indents everything), the order of
// tokens inside `class`/`rel` (a set, not a sequence, to the browser), and
// the spacing inside a `style` declaration block. None of those can change a
// pixel; all of them change when markup moves through JSX.
//
// LIFETIME: this test is maximally valuable for exactly one commit and turns
// into an obstacle the moment step 2 starts converting real screens. Delete
// it — and the fixture — in the first step-2 slice. tests/shell-id-inventory
// and tests/shell-script-order stay useful much longer and should outlive it.
//
// Run with: node --test tests/shell-markup-parity.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { structure, describe } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'pre-migration-index.html');

const before = fs.readFileSync(FIXTURE, 'utf8');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// The one deliberate ADDITION: the React entry, last in <head>. Everything
// else in the document must match the fixture, so it is removed here rather
// than special-cased inside the walk — and asserted separately below, so
// dropping it can't pass by accident.
const ENTRY_TAG = '<script type="module" src="/shell/assets/shell.js"></script>';

// Script tags for modules added AFTER the fixture was frozen. Same treatment
// as the React entry, and for the same reason: the frozen document cannot
// know about them, and leaving one in would shift every later token and bury
// the real diff. Each is asserted to be present separately below, and its
// LOAD ORDER is pinned by tests/shell-script-order.js — so removing one
// cannot pass here by accident.
const POST_MIGRATION_TAGS = [
  '<script src="/js/nav-link.js"></script>', // #1036 — real-anchor / new-tab seam
  '<script src="/js/dev-flow-select.js"></script>', // #1049 — dev-flow picker + walkthrough
];

const afterWithoutEntry = POST_MIGRATION_TAGS.reduce(
  (html, tag) => html.replace(tag, ''),
  after.replace(ENTRY_TAG, ''),
);

// ── Deliberate, reviewed markup differences ────────────────────────────
//
// EMPTY, and that is the goal: the generated document reproduces the
// hand-written one exactly, with no exceptions at all.
//
// It briefly held one. #platform-updating-reload carried
// `onclick="location.reload()"`, the document's only inline handler, and
// React rejects those (it warns, a warning is a console.error, and a
// console.error on any route fails the platform's proposal checks) — so the
// binding moved into the module that already owned the button. Main then
// removed the whole platform-updating banner (#1015/#1018), which retired the
// element, the workaround and this exception together.
//
// Keep it empty. An entry here is a claim that the shell's markup and its
// React source have diverged on purpose, and step 1's contract is that they
// haven't.
const ALLOWED_ATTR_REMOVALS = [];

function isAllowedRemoval(token, attr) {
  return ALLOWED_ATTR_REMOVALS.some((a) => a.id === token.attrs.id && a.attr === attr);
}

// ── Deliberate POST-migration element changes ──────────────────────────
//
// Distinct from ALLOWED_ATTR_REMOVALS above, which is about the chassis swap
// itself and must stay empty. This list is for markup the shell has changed
// ON PURPOSE since the fixture was frozen — a real product change, not a
// conversion artifact. Each entry names the element, the tag swap, and the
// classes it gained; everything else about that element (its id, its other
// attributes, its children) is still compared exactly, and the guard test
// below refuses an entry that no longer describes a real fixture element.
const ALLOWED_ELEMENT_CHANGES = [
  {
    id: 'back-btn',
    from: 'button',
    to: 'a',
    // #1036: the header home/back control became a real link so cmd-click,
    // middle-click and "Open in new tab" work on it. `inline-flex
    // items-center` comes with the swap — an <a> is `inline` where a
    // <button> was `inline-block`, and the header's 28px content-row floor
    // (tests/header-height-parity.test.js) must not drift.
    addedClasses: ['inline-flex', 'items-center'],
  },
];

function elementChangeFor(token) {
  return ALLOWED_ELEMENT_CHANGES.find((c) => c.id === token.attrs.id);
}

// True when `generated` is `fixture` plus exactly the declared extra classes.
function classesMatchWithAdditions(fixtureValue, generatedValue, added) {
  const split = (v) => String(v || '').split(/\s+/).filter(Boolean);
  const want = new Set([...split(fixtureValue), ...added]);
  const got = new Set(split(generatedValue));
  return want.size === got.size && [...want].every((c) => got.has(c));
}

test('the generated shell matches the pre-migration markup element for element', () => {
  const a = structure(before);
  const b = structure(afterWithoutEntry);

  // Open elements, innermost last, so a declared tag swap also relaxes its
  // MATCHING close token and nothing else. structure() drops void-element
  // closes and marks self-closing opens, so every entry pushed here really
  // does get a close.
  const openStack = [];

  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    const x = a[i];
    const y = b[i];

    // Fail on the FIRST divergence with both sides quoted plus a little
    // context. A structural diff of a 2,600-line document is unreadable
    // otherwise, and the first divergence is nearly always the real cause.
    const context = () => {
      const from = Math.max(0, i - 4);
      return a.slice(from, i).map((t, n) => `      ${from + n}: ${describe(t)}`).join('\n');
    };

    assert.ok(
      x && y,
      `public/index.html has ${b.length} structural tokens, the pre-migration fixture has ${a.length}.\n`
      + `  First extra/missing at index ${i}:\n`
      + `    fixture:   ${describe(x)}\n`
      + `    generated: ${describe(y)}\n`
      + `  preceding context:\n${context()}`,
    );

    assert.equal(
      y.kind, x.kind,
      `token ${i}: expected ${x.kind} ${describe(x)}, got ${y.kind} ${describe(y)}\n`
      + `  preceding context:\n${context()}`,
    );

    if (x.kind === 'text') {
      assert.equal(
        y.text, x.text,
        `token ${i}: text differs\n  fixture:   ${JSON.stringify(x.text)}\n`
        + `  generated: ${JSON.stringify(y.text)}\n  preceding context:\n${context()}`,
      );
      continue;
    }
    if (x.kind === 'close') {
      const opened = openStack.pop();
      const wantTag = opened && opened.tag === x.tag ? opened.closesAs : x.tag;
      assert.equal(y.tag, wantTag, `token ${i}: expected </${wantTag}>, got </${y.tag}>`);
      continue;
    }
    if (x.kind !== 'open') continue;

    const changed = elementChangeFor(x);

    if (!x.selfClosing) {
      openStack.push({
        tag: x.tag,
        closesAs: changed && x.tag === changed.from ? changed.to : x.tag,
      });
    }

    if (changed && x.tag === changed.from) {
      assert.equal(
        y.tag, changed.to,
        `token ${i}: #${changed.id} is a declared element change — expected <${changed.to}>, `
        + `got <${y.tag}>\n  preceding context:\n${context()}`,
      );
    } else {
      assert.equal(
        y.tag, x.tag,
        `token ${i}: expected <${x.tag}>, got <${y.tag}>\n  preceding context:\n${context()}`,
      );
    }

    const where = `${describe(x)} (token ${i})`;

    for (const [name, value] of Object.entries(x.attrs)) {
      if (isAllowedRemoval(x, name)) continue;
      assert.ok(
        name in y.attrs,
        `${where}: attribute \`${name}\` was dropped by the JSX conversion (was ${JSON.stringify(value)}).`,
      );
      if (changed && name === 'class' && changed.addedClasses) {
        assert.ok(
          classesMatchWithAdditions(value, y.attrs[name], changed.addedClasses),
          `${where}: #${changed.id} may add exactly [${changed.addedClasses.join(', ')}] to its `
          + `class list and nothing else.\n    fixture:   ${JSON.stringify(value)}\n`
          + `    generated: ${JSON.stringify(y.attrs[name])}`,
        );
        continue;
      }
      assert.equal(
        y.attrs[name], value,
        `${where}: attribute \`${name}\` changed.\n`
        + `    fixture:   ${JSON.stringify(value)}\n    generated: ${JSON.stringify(y.attrs[name])}`,
      );
    }

    for (const name of Object.keys(y.attrs)) {
      assert.ok(
        name in x.attrs,
        `${where}: the generated markup added attribute \`${name}\`=${JSON.stringify(y.attrs[name])}, `
        + 'which the pre-migration markup did not have.',
      );
    }
  }
});

test('the conversion needs no markup exceptions at all', () => {
  // Guards the allow-list itself. Each entry must still describe a real
  // attribute on a real element in the fixture, so an exception cannot outlive
  // the thing it excuses — and the list must stay empty, because a
  // scaffolding-only chassis swap has nothing to except.
  const a = structure(before);
  for (const allowed of ALLOWED_ATTR_REMOVALS) {
    const token = a.find((t) => t.kind === 'open' && t.attrs.id === allowed.id);
    assert.ok(token, `the fixture has no #${allowed.id} — remove its entry from ALLOWED_ATTR_REMOVALS`);
    assert.ok(
      allowed.attr in token.attrs,
      `#${allowed.id} in the fixture has no \`${allowed.attr}\` attribute — the exception is obsolete`,
    );
  }
  assert.deepEqual(
    ALLOWED_ATTR_REMOVALS, [],
    'step 1 permits NO markup differences. An entry here means the chassis swap stopped being '
    + 'scaffolding-only — justify it in review rather than extending this list.',
  );
});

test('every declared element change still describes a real element', () => {
  // Same discipline as the allow-list guard above: an exception must not
  // outlive what it excuses. Each entry has to still name an element that
  // exists in the fixture with the tag it claims to be changing FROM, and
  // to have actually been applied in the generated document.
  const a = structure(before);
  const b = structure(afterWithoutEntry);
  for (const c of ALLOWED_ELEMENT_CHANGES) {
    const fixtureEl = a.find((t) => t.kind === 'open' && t.attrs.id === c.id);
    assert.ok(fixtureEl, `the fixture has no #${c.id} — remove its ALLOWED_ELEMENT_CHANGES entry`);
    assert.equal(
      fixtureEl.tag, c.from,
      `#${c.id} is <${fixtureEl.tag}> in the fixture, not <${c.from}> — the exception is stale`,
    );
    const generatedEl = b.find((t) => t.kind === 'open' && t.attrs.id === c.id);
    assert.ok(generatedEl, `the generated shell has no #${c.id}`);
    assert.equal(
      generatedEl.tag, c.to,
      `#${c.id} is declared as changing to <${c.to}> but the shell renders <${generatedEl.tag}> — `
      + 'drop the entry if the change was reverted',
    );
  }
});

test('the shell markup carries no inline event handlers', () => {
  // React rejects them, and a React warning is a console.error, which fails
  // proposal checks on every route that renders the element. The document has
  // none today; this keeps it that way, and points at the fix if one returns.
  const offenders = [...after.matchAll(/\son(?:click|change|input|submit|load|error|focus|blur)="/g)];
  assert.deepEqual(
    offenders.map((m) => m[0].trim()), [],
    'public/index.html has an inline event handler. Bind it from the public/js/** module that '
    + 'owns the element instead — see frontend/scripts/apply-step1-edits.cjs.',
  );
});

test('the generated document keeps the shell boilerplate the head depends on', () => {
  assert.match(after, /^<!DOCTYPE html>\n<html lang="en" class="dark">\n/,
    'the doctype / <html lang="en" class="dark"> preamble must be preserved verbatim');
  assert.match(after, /<body class="[^"]*flex flex-col" style="height:100dvh">/,
    'the <body> element keeps its own class/style: it is the flex column every screen\'s height '
    + 'depends on, so React hydrates its CHILDREN rather than a wrapper div');
  assert.ok(after.includes(ENTRY_TAG),
    'the React entry must be referenced from the generated document');
  for (const tag of POST_MIGRATION_TAGS) {
    assert.ok(after.includes(tag),
      `${tag} is stripped before the parity walk, so it must actually be in the document — `
      + 'drop it from POST_MIGRATION_TAGS if the module was removed');
  }
});
