// The Workshop's three model stages (services/llm.js) each carry a prompt
// version, WORKSHOP_*_VERSION, that services/workshop-themes.js records on
// the row and re-runs the stage for when it moves. The version only helps if
// it is bumped when the prompt changes, and nothing about a template string
// reminds you. So this test pins a hash of each builder's SOURCE to its
// version: edit the prompt without touching the constant and it fails here,
// naming the constant to raise.
//
// Two ways to make it pass, and both are decisions this test exists to force:
//   * the prompt's meaning changed → bump the constant in llm.js and record
//     the new version with its hash below (keep the old pair: it is the
//     changelog). Know the cost — a discovery bump re-drafts every recently
//     viewed app's categories under its members, a placement bump re-places
//     every card in batches, a digest bump is one short call per app;
//   * the edit was cosmetic (a comment, a typo, a rename) → re-pin the hash
//     on the current version and bump nothing.
//
// The hash covers the whole builder, its call parameters included: a
// max_tokens or effort change alters the output too, and deserves the same
// decision. A comment inside the builder trips it as well; that is a small
// price for never shipping a prompt the rows do not know about.
//
// Run with: node --test tests/workshop-prompt-versions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const llm = require('../src/services/llm');

const STAGES = {
  discovery: {
    constant: 'WORKSHOP_DISCOVERY_VERSION',
    builder: llm.generateWorkshopThemeDefinitions,
    // version → hash of the builder's source at that version.
    // 2 puts the call on 'medium' effort: at the default ('high') it spent
    // its 16000 token budget thinking and hit the output limit before its
    // JSON finished, which froze one board's categories for 17 hours.
    // 3 merges the Workshop's grouping with the voted categories onto one
    // mechanism: "previousThemes" now carry `pinned`, and a pinned theme —
    // one the group has voted cards into — must come back unchanged.
    // 4 is the ONE-LIST merge: the grouping is the app's CATEGORIES again,
    // `previousThemes` became `previousCategories`, and the draft is handed
    // `builtInCategories` so it works around the six the platform ships.
    pinned: { 1: '9561f5061d176cc6', 2: '27d59d0a5d9aa59e', 3: '5539cd0961999c6a', 4: 'd6ca79b69d490122' },
  },
  placement: {
    constant: 'WORKSHOP_PLACEMENT_VERSION',
    builder: llm.placeWorkshopItems,
    // 2: the placer sorts into CATEGORIES, and the card's own category is no
    // longer fed to it — that is the thing being decided, so offering it back
    // would anchor the answer to the value already there.
    pinned: { 1: 'd82abd8a00088937', 2: 'fdff738ca4ac4873' },
  },
  digest: {
    constant: 'WORKSHOP_DIGEST_VERSION',
    builder: llm.generateWorkshopDigest,
    // 1 was the two-sentence prompt the columns grandfather; 2 is the
    // rewrite around what a user notices (#1820), and the first bump; 3
    // splits the paragraph into the three windowed lines the lander draws as
    // cards and adds the breadth rule, after a week of 268 commits across
    // eight areas was summarised as "mostly reshaped the Workshop and Dev
    // board" (#1921).
    // 4 halves the length and swaps "name the breadth" for two rules that
    // survive twelve words: two clauses rather than a list, and lead by the
    // COUNT of items in an area rather than by how visible it is.
    // 5 is vocabulary only, but it is not cosmetic: the prompt told the model
    // to call the grouping "CATEGORIES", which is the name of the OTHER axis
    // (the voted feature/bug/docs field). The line it writes is user-facing,
    // so the rows have to re-ask for it under the right noun.
    // 6 breaks the shape every week was coming back in. Four of these lines
    // are read one under another in the walk, and they all arrived as
    // "Mostly X, alongside Y" — which is what the prompt's single worked
    // example was, so the example had become a mould. It is gone, both of
    // its words are banned outright, and the count the old prompt only
    // ASKED for ("count before you lead") is now a required schema field
    // ordered ahead of the lines, so the tally has to exist before there is
    // a sentence to lead with. Every app's digest is re-drafted; that is one
    // short call per app, and the lines are what the pane shows.
    pinned: {
      2: '14c1ca1864a4fb96',
      3: '98f17a8ffee59b3b',
      4: '5ae848d3fe65b9d1',
      5: 'fa7bbe7465b5aea4',
      6: '84cedc3ec42f85d4',
      // 7 is the merge: #2361's rewrite above landed as 6 on the same day the
      // grouping went back to being called a CATEGORY, which was also 6. This
      // text is neither — it carries both — so it takes its own number rather
      // than letting a row written under either read as current.
      7: '95951e15d7808fa2',
    },
  },
};

function hashOf(fn) {
  return crypto.createHash('sha256').update(fn.toString()).digest('hex').slice(0, 16);
}

for (const [stage, spec] of Object.entries(STAGES)) {
  test(`the ${stage} prompt's version matches its source`, () => {
    const version = llm[spec.constant];
    assert.ok(Number.isInteger(version) && version >= 1, `${spec.constant} must be a positive integer`);
    const actual = hashOf(spec.builder);
    const expected = spec.pinned[version];
    assert.ok(expected,
      `${spec.constant} is ${version} but no hash is pinned for it in tests/workshop-prompt-versions.test.js: `
      + `add \`${version}: '${actual}'\` to the ${stage} entry.`);
    assert.equal(actual, expected,
      `The ${stage} builder in src/services/llm.js changed but ${spec.constant} is still ${version}. `
      + `If the prompt's meaning changed, bump ${spec.constant} to ${version + 1} and pin \`${version + 1}: '${actual}'\` `
      + `for ${stage} (every app re-runs that stage on its next pass). If the edit was cosmetic, re-pin `
      + `\`${version}: '${actual}'\` and leave the constant alone.`);
  });
}

test('the versions the row is compared against are the ones the builders export', () => {
  // services/workshop-themes.js reads llm.WORKSHOP_*_VERSION; a rename in one
  // place and not the other would make every row read as current forever.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/workshop-themes.js'), 'utf8');
  for (const spec of Object.values(STAGES)) {
    assert.match(src, new RegExp(`llm\\.${spec.constant}\\b`), `${spec.constant} is read by the service`);
  }
  // And each is stamped by the row write, so the version on the row can only
  // ever be one the code has had.
  assert.match(src, /discovery_version = CASE WHEN \$7::boolean THEN \$15::integer/);
  assert.match(src, /placement_version = CASE WHEN \$16::boolean THEN \$17::integer/);
  assert.match(src, /digest_version = CASE WHEN \$13::boolean THEN \$18::integer/);
  const schema = require('node:fs').readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  for (const col of ['discovery_version', 'placement_version', 'digest_version']) {
    assert.match(schema, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} INTEGER NOT NULL DEFAULT 1;`),
      `${col} defaults to 1 so the rows from before it existed are grandfathered`);
  }
});
