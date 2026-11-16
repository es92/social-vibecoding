'use strict';

// The Messages list's search is remembered per device (#5459).
//
// A daily voter narrowed the list to the changes waiting on them (while
// Messages listed changes), left to vote, and came back: the search was
// gone and every row was back. The query is kept in localStorage
// (`usernode:messages-query`) and read after mount — the filter chips #4783
// remembered were removed with the section split (16 Oct 2026), and the
// search is the only filter left.
//
// The same three things are pinned, each a way the remembering quietly comes
// undone:
//
//   1. AN UNUSABLE SAVED VALUE RESTORES NOTHING. Storage is user-writable,
//      and a value no one could have typed (not a string, empty, past the
//      cap) narrows the list to nothing.
//   2. THE WRITE IS GUARDED, INSIDE A TRY, AND THE FIELD UPDATES AFTER IT.
//      Storage may be unavailable (private mode, blocked); a crash in the
//      write must not stop the list from narrowing, and the setQuery runs
//      whether the write worked or not.
//   3. THE INITIAL STATE IS EMPTY. `useState('')` stays, so the first render
//      and the prerendered shell show an empty field; the saved value
//      arrives one commit after mount, so the first paint matches.
//
// Run with: node --test tests/messages-query-remembered.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VIEW = read('frontend/src/features/messages/index.tsx');

const { savedInboxQuery, INBOX_QUERY_MAX } = loadTsx('frontend/src/features/messages/inbox.ts');

test('a saved value restores', () => {
  assert.equal(savedInboxQuery('Workshop'), 'Workshop');
  assert.equal(savedInboxQuery('a'.repeat(100)), 'a'.repeat(100),
    'a search of exactly the cap is a real search, not an overlong one');
});

test('an unknown or overlong saved value restores nothing', () => {
  for (const raw of [null, undefined, '', 'a'.repeat(101), 42, {}]) {
    assert.equal(savedInboxQuery(raw), '', String(raw));
  }
  assert.equal(INBOX_QUERY_MAX, 100, 'the cap is a hundred characters');
});

test('the write is guarded and the field updates whether it worked or not', () => {
  const start = VIEW.indexOf('const changeQuery = useCallback(');
  assert.ok(start >= 0, 'changeQuery exists');
  const body = VIEW.slice(start, VIEW.indexOf('  // The list filters on the DEFERRED query', start));
  assert.match(body,
    /try \{\s*if \(value && value\.length <= INBOX_QUERY_MAX\) localStorage\.setItem\('usernode:messages-query', value\);\s*else localStorage\.removeItem\('usernode:messages-query'\);\s*\} catch \{ \/\* storage unavailable \*\/ \}/,
    'the save sits inside a try, so private mode cannot break the screen; clearing removes the key and a search past the cap is not kept');
  const tryEnd = body.indexOf('} catch { /* storage unavailable */ }');
  const setQuery = body.indexOf('setQuery(value)');
  assert.ok(tryEnd >= 0 && setQuery > tryEnd,
    'setQuery comes after the try, outside it, so a failed write still updates the list');
});

test('the saved value is read after mount, and the field still starts empty', () => {
  const start = VIEW.indexOf('const [query, setQuery] = useState(\'\');');
  assert.ok(start >= 0, 'the query state exists');
  const block = VIEW.slice(start, VIEW.indexOf('const changeQuery = useCallback('));
  assert.match(block,
    /useEffect\(\(\) => \{\s*try \{\s*const saved = savedInboxQuery\(localStorage\.getItem\('usernode:messages-query'\)\);\s*if \(saved\) setQuery\(saved\);\s*\} catch \{ \/\* storage unavailable \*\/ \}\s*\}, \[\]\)/,
    'the restore runs once after mount, through savedInboxQuery, guarded');
  assert.match(VIEW, /const \[query, setQuery\] = useState\(''\);/,
    'useState(\'\') stays, so the first render and the prerender show an empty field');
  assert.doesNotMatch(VIEW, /useState\(savedInboxQuery/,
    'the saved value is never the initial state');
});