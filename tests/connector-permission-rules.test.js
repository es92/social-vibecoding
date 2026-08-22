// #1218 — the connector's permission surface.
//
// Every hosted-connector call used to raise its own permission prompt,
// read-only ones included, and in a Claude Code WEB session the grant does
// not survive the container — so the same prompts came back next session,
// for every user, and `submit_work` (which starts a group vote) drowned in
// the noise.
//
// An MCP server cannot reduce its own prompting, and should not be able to.
// The fix is therefore client-side and three-part, and all three parts fail
// SILENTLY when they drift:
//
//   1. The server segment of a permission rule cannot be wildcarded, so
//      every rule hardcodes a name. If the scaffold's name and the server's
//      own serverInfo.name ever diverge, the shipped rules match nothing —
//      no error, the user just keeps being prompted.
//   2. The shipped allowlist covers reads and nothing else. It is committed
//      into every scaffolded repo, so it grants for everyone who opens that
//      repo — widening it to a whole-server wildcard would decide for them.
//      (The acting tools used to carry `anthropic/requiresUserInteraction`
//      as a second line of defence. That is gone: it overrode the user's own
//      allow-always setting, which is not this connector's call to make.)
//   3. Documentation has to name BOTH tool-name prefixes, because the
//      `claude_ai_` segment is present on some surfaces and absent on
//      others — guidance naming one is wrong for half of users.
//
// Run with: node --test tests/connector-permission-rules.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('../src/services/mcp-connect-constants');
const template = require('../src/services/template');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const REMOTE_SRC = read('src/routes/mcp-remote.js');
const CONNECTORS_TSX = read('frontend/src/features/settings/sections/connectors.tsx');
const CONNECTOR_DOC = read('MCP-CONNECTOR.md');
const SETTINGS_JS = read('frontend/src/features/settings/settings.js');

const scaffold = () => {
  const files = template.getTemplateFiles('Demo App', 'demo-app', 'postgres://x/y');
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  return byPath;
};

// ── 1. The name ────────────────────────────────────────────────────────

test('the canonical connector name is what the server actually reports', () => {
  assert.equal(constants.SERVER_NAME, 'usernode');
  // serverInfo.name in the initialize response is built from that one
  // constant, so a client that derives the name and a user who types it
  // land on the same string — which is the whole reason the rules below
  // can hardcode it.
  assert.match(REMOTE_SRC, /\{\s*name: SERVER_NAME, version: SERVER_VERSION\s*\}/);
});

test('the misspelling from the report is not ours', () => {
  // #1218 saw tools arrive as mcp__Uesrnode__whoami. If that string were
  // in the source it would be a platform bug and the shipped rules would
  // have to reproduce the typo to work. It is not: the name was typed into
  // Claude.ai's "Add custom connector" dialog, which is why the fix is to
  // recommend the canonical name at connect time.
  for (const rel of [
    'src/services/mcp-connect-constants.js',
    'src/services/mcp-tools.js',
    'src/routes/mcp-remote.js',
    'src/services/template.js',
  ]) {
    const src = read(rel);
    const typo = /Uesrnode/g;
    const hits = [...src.matchAll(typo)];
    // Prose explaining the report is fine; a value is not.
    for (const hit of hits) {
      const line = src.slice(0, hit.index).split('\n').pop() + src.slice(hit.index).split('\n')[0];
      assert.match(
        line.trim(), /^(\/\/|\*|\/\*)/,
        'Uesrnode may appear only in a comment, never as a value'
      );
    }
  }
});

test('the connect flow recommends the canonical name where it is typed', () => {
  // The Name field is the only place that string is decided, so this is
  // where it has to be said — not in a doc nobody opens mid-dialog.
  assert.match(CONNECTORS_TSX, /Add custom connector/);
  assert.match(CONNECTORS_TSX, /Name it exactly/);
  assert.match(CONNECTORS_TSX, new RegExp(`<code[^>]*>${constants.SERVER_NAME}</code>`));
});

// ── 2. The shipped allow rules ─────────────────────────────────────────

test('the read-only allow rules are two globs and one literal, per spelling of the name', () => {
  // Six, not three: the same three rules under each spelling of the server
  // name Usernode can guess. A permission rule names the server LITERALLY —
  // there is no `mcp__*__` — so a user whose client registered the connector
  // as `Usernode` matched none of the three this shipped with, saw a prompt
  // on every read, and got no error to explain it. Shipping both spellings
  // costs two lines of JSON and covers the one variation the platform can
  // predict; anything else is what the Settings field rewrites.
  assert.deepEqual([...constants.ALLOW_RULE_SERVER_NAMES], ['usernode', 'Usernode']);
  assert.deepEqual([...constants.READ_ONLY_ALLOW_RULES], [
    'mcp__usernode__get_*',
    'mcp__usernode__list_*',
    'mcp__usernode__whoami',
    'mcp__Usernode__get_*',
    'mcp__Usernode__list_*',
    'mcp__Usernode__whoami',
  ]);
  // Grouped by spelling, not by tool, so the block reads as "these three, and
  // the same three again" rather than as six unrelated rules.
  assert.deepEqual(
    constants.READ_ONLY_ALLOW_RULES.map((r) => r.split('__')[1]),
    ['usernode', 'usernode', 'usernode', 'Usernode', 'Usernode', 'Usernode']
  );
  // And the canonical spelling is the configured one — the second is the
  // variant, and the order matters because the hint names them in it.
  assert.equal(constants.ALLOW_RULE_SERVER_NAMES[0], constants.SERVER_NAME);
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    assert.ok(
      constants.ALLOW_RULE_SERVER_NAMES.some((n) => rule.startsWith(`mcp__${n}__`)),
      `${rule} names one of the shipped server spellings literally`
    );
    // The server segment must be glob-free — a rule with a wildcard there
    // is not a looser rule, it is a rule that matches nothing.
    const [, , server] = rule.split('__');
    assert.ok(server !== undefined);
    assert.doesNotMatch(
      rule.slice(0, rule.indexOf('__', 5)), /\*/,
      'the server segment must be glob-free'
    );
  }
});

test('never a whole-server allow — the scaffold grants for everyone', () => {
  // A blanket mcp__usernode__* in a COMMITTED file would allow every acting
  // call for anyone who opens the repo, decided by the scaffold rather than
  // by them. A user who wants that grants it on their own account instead.
  const wildcard = `mcp__${constants.SERVER_NAME}__*`;
  assert.ok(!constants.READ_ONLY_ALLOW_RULES.includes(wildcard));
  const settings = scaffold().get('.claude/settings.json');
  assert.ok(!settings.includes(`"${wildcard}"`), 'the scaffold ships no whole-server rule');

  // And every shipped rule can only match a read: a glob's prefix is one of
  // the read-only prefixes, or it is a literal read tool.
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    const tool = rule.slice(rule.lastIndexOf('__') + 2);
    const ok = constants.READ_ONLY_TOOL_PREFIXES.some((p) => tool === `${p}*`)
      || constants.READ_ONLY_TOOL_EXCEPTIONS.includes(tool);
    assert.ok(ok, `${rule} can only ever match a read-only tool`);
  }
});

// ── 3. The scaffold ────────────────────────────────────────────────────

test('every scaffolded app repo ships .claude/settings.json', () => {
  const files = scaffold();
  const settings = files.get('.claude/settings.json');
  assert.ok(settings, 'the scaffold writes .claude/settings.json');

  const parsed = JSON.parse(settings);
  assert.deepEqual(parsed, {
    permissions: { allow: [...constants.READ_ONLY_ALLOW_RULES] },
  });
  // Only permissions.allow — a scaffolded repo grants capability and
  // nothing more; it does not set a permission mode or add hooks.
  assert.deepEqual(Object.keys(parsed), ['permissions']);
  assert.deepEqual(Object.keys(parsed.permissions), ['allow']);
  assert.ok(settings.endsWith('\n'), 'settings.json ends with a newline');
});

test('the scaffold explains itself next to the file, since JSON has no comments', () => {
  const readme = scaffold().get('.claude/README.md');
  assert.ok(readme, 'the scaffold writes .claude/README.md');
  assert.match(readme, /workspace trust dialog/i);
  // Why the file stops at reads, and where to go for more — a reader who
  // wants the acting calls allowed should not conclude it cannot be done.
  assert.match(readme, /committed/i);
  assert.match(readme, /~\/\.claude\/settings\.json/);
  // Both prefix forms, because it differs by surface.
  assert.match(readme, /mcp__<server>__whoami/);
  assert.match(readme, /mcp__claude_ai_<server>__whoami/);
  assert.match(readme, /read the name off your own tool list/i);
});

test('the scaffolded CLAUDE.md points at it', () => {
  const claudeMd = scaffold().get('CLAUDE.md');
  assert.match(claudeMd, /\.claude\/settings\.json/);
  assert.match(claudeMd, /workspace trust dialog/i);
});

test('.claude is kept out of the app image', () => {
  // The scaffold's Dockerfile does COPY . . — editor settings have no
  // business in a runtime image.
  assert.match(scaffold().get('.dockerignore'), /^\.claude$/m);
});

// ── 4. The documentation ───────────────────────────────────────────────

test('the connector doc names both tool-name prefixes', () => {
  // Guidance naming only one form is wrong for half of users, silently.
  assert.match(CONNECTOR_DOC, /mcp__usernode__whoami/);
  assert.match(CONNECTOR_DOC, /mcp__claude_ai_usernode__whoami/);
  assert.match(CONNECTOR_DOC, /read the name off your own tool list/i);
});

test('the connector doc covers the trust dialog and allow-always', () => {
  assert.match(CONNECTOR_DOC, /workspace trust dialog/i);
  // The doc keeps explaining the retired marking, because users who hit the
  // old behaviour need to find out it changed rather than assume it is still
  // there — and because the reasoning is why the shipped rules stop at reads.
  assert.match(CONNECTOR_DOC, /anthropic\/requiresUserInteraction/);
  assert.match(CONNECTOR_DOC, /allow always/i);
});

// ── 5. Every creation path scaffolds it ────────────────────────────────
//
// The scaffold used to ship only from the fresh-create path, which is the one
// that writes the whole template. Import and fork both make an app repo and
// neither called it, so neither produced the file — and a user of one of those
// apps kept getting a prompt per read, forever, with nothing in the product
// telling them why.

const CREATOR_SRC = read('src/services/app-creator.js');
const FORKER_SRC = read('src/services/app-forker.js');
const TEMPLATE_SRC = read('src/services/template.js');

test('the connector scaffold has ONE source, which the full template spreads', () => {
  // Anti-drift: if getTemplateFiles() carried its own copy, a rule added to
  // the constant would reach a created app and not an imported one, and the
  // difference would be invisible until someone compared two repos.
  const scaffoldFiles = template.getConnectorScaffoldFiles();
  assert.deepEqual(scaffoldFiles.map((f) => f.path), [
    '.claude/settings.json',
    '.claude/README.md',
  ]);

  const fromTemplate = template.getTemplateFiles('Demo App', 'demo-app', 'postgres://x/y')
    .filter((f) => f.path.startsWith('.claude/'));
  assert.deepEqual(fromTemplate, scaffoldFiles,
    'getTemplateFiles must spread the helper, not repeat it');

  assert.match(TEMPLATE_SRC, /\.\.\.getConnectorScaffoldFiles\(\)/,
    'the full template spreads the shared helper');
  assert.equal(
    (TEMPLATE_SRC.match(/path: '\.claude\/settings\.json'/g) || []).length, 1,
    "the scaffold's settings.json is written in exactly one place"
  );
  assert.equal(
    (TEMPLATE_SRC.match(/path: '\.claude\/README\.md'/g) || []).length, 1,
    "the scaffold's README is written in exactly one place"
  );
});

test('all three creation paths reach that one helper', () => {
  // Create goes through getTemplateFiles (which spreads it, asserted above);
  // import and fork call it directly.
  assert.match(CREATOR_SRC, /getConnectorScaffoldFiles/,
    'the import path adds the connector scaffold');
  assert.match(FORKER_SRC, /getConnectorScaffoldFiles/,
    'the fork path adds the connector scaffold');
});

test('adding the scaffold to an imported repo can never fail the import', () => {
  // A fresh create marks its push failure `repoFailed` and throws, because
  // there is no app without the push. An import already HAS its repo: the app
  // is complete and working, just noisier to drive, and a user-owned repo the
  // platform's GitHub App cannot write to is an ordinary import. Failing the
  // creation over a settings file would be a regression in what works.
  const start = CREATOR_SRC.indexOf('} else if (repoUrl) {');
  assert.ok(start > 0, 'the import branch is still shaped this way');
  const end = CREATOR_SRC.indexOf('// 3. Clone (or write)', start);
  const branch = CREATOR_SRC.slice(start, end > 0 ? end : start + 3000);

  assert.match(branch, /getConnectorScaffoldFiles\(\)/);
  assert.match(branch, /try \{/, 'the whole addition is guarded');
  assert.match(branch, /log\.warn\(/, 'a failure is logged, not raised');

  // Comments stripped: the branch EXPLAINS why it is not `repoFailed`, and
  // the prose saying so must not read as the code doing so.
  const code = branch.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /repoFailed/,
    'an import must not be failed over the connector scaffold');
  assert.doesNotMatch(code, /throw /,
    'nothing in the import branch rethrows');
});

test('an import does not overwrite a .claude/settings.json the repo already has', () => {
  const start = CREATOR_SRC.indexOf('} else if (repoUrl) {');
  const end = CREATOR_SRC.indexOf('// 3. Clone (or write)', start);
  const branch = CREATOR_SRC.slice(start, end);
  // Read first, push only on a definite absence — getFileContent returns null
  // for 404 and throws for anything else, so `=== null` is "not there" rather
  // than "we could not tell".
  assert.match(branch, /getFileContent\(\s*[\s\S]{0,80}'\.claude\/settings\.json'/);
  assert.match(branch, /existing === null/);
});

test('a fork adds the scaffold without clobbering what the source carried', () => {
  // A fork copies an app; it does not normalise it. Whatever `.claude/` the
  // source repo has is the app's own.
  const start = FORKER_SRC.indexOf('function writeConnectorScaffold(');
  assert.ok(start > 0, 'the fork writes the scaffold through a named helper');
  const end = FORKER_SRC.indexOf('\n}', start);
  const fn = FORKER_SRC.slice(start, end);
  assert.match(fn, /fs\.existsSync\(dest\)\) continue/,
    'an existing path is skipped, never overwritten');
  assert.match(fn, /mkdirSync/, '.claude/ is created if the tree has none');

  // Written into the working tree BEFORE the single squashed commit, so it
  // needs no second push.
  const writeAt = FORKER_SRC.indexOf('writeConnectorScaffold(tempDir)');
  const commitAt = FORKER_SRC.indexOf('git init -q -b main');
  assert.ok(writeAt > 0 && commitAt > writeAt,
    'the scaffold lands before the commit that captures the tree');
});

// ── 6. The everywhere-at-once fix, in the product ──────────────────────

test('Settings → Connectors offers the rules for a personal settings file', () => {
  // The scaffolded file fixes one repo. The user's own settings file is the
  // only thing that fixes every repo, including ones Usernode never made — so
  // the block has to be somewhere they can copy it from.
  assert.match(CONNECTORS_TSX, /Stop the permission prompts/);
  assert.match(CONNECTORS_TSX, /~\/\.claude\/settings\.json/);
  assert.match(CONNECTORS_TSX, /id="connector-allow-rules"/);
  assert.match(CONNECTORS_TSX, /id="connector-allow-rules-copy"/);
  // And it says what is NOT covered, so nobody reads it as "approve nothing".
  assert.match(CONNECTORS_TSX, /still asks every time/);
});

test('the panel splits into the three surfaces the answer differs between', () => {
  // One block headed "add this to ~/.claude/settings.json" was wrong for the
  // surface that needs it most: a Claude Code WEB container is built fresh, so
  // nothing from the user's machine is in it and only the repo travels. Naming
  // the wrong file is worse than naming none — the user follows it, is still
  // prompted, and concludes the feature does not work.
  for (const id of ['connector-case-cc-local', 'connector-case-cc-web', 'connector-case-chat']) {
    assert.match(CONNECTORS_TSX, new RegExp(`id="${id}"`), `${id} is one of the three cases`);
  }
  // The web case names the per-repo file and says why the personal one is not
  // in that container.
  const web = CONNECTORS_TSX.slice(
    CONNECTORS_TSX.indexOf('id="connector-case-cc-web"'),
    CONNECTORS_TSX.indexOf('id="connector-case-chat"')
  );
  assert.match(web, /fresh container/i);
  assert.match(web, /\.claude\/settings\.json/);
  assert.match(web, /id="connector-repo-allow-rules"/);
  // And the chat case says there is nothing to do, rather than leaving a
  // Claude.ai user to copy a file format that has no effect there.
  const chat = CONNECTORS_TSX.slice(CONNECTORS_TSX.indexOf('id="connector-case-chat"'));
  assert.match(chat, /Nothing to do/i);
});

test('the copied block is byte-for-byte the shipped allowlist, in BOTH places', () => {
  // The panel renders a literal rather than importing the server constants
  // into the browser bundle, so this is what stops the two drifting: add a
  // rule to READ_ONLY_ALLOW_RULES and this fails until the panel matches.
  const expected = JSON.stringify(
    { permissions: { allow: [...constants.READ_ONLY_ALLOW_RULES] } }, null, 2
  );
  const match = CONNECTORS_TSX.match(/const PERSONAL_ALLOW_RULES = `([\s\S]*?)`;/);
  assert.ok(match, 'the panel defines the block as one literal');
  assert.equal(match[1], expected);
  // Same content as the scaffolded file, modulo its trailing newline.
  assert.equal(`${match[1]}\n`, scaffold().get('.claude/settings.json'));

  // The two files take identical content and differ only in reach, so the
  // second block interpolates the SAME constant. A copy-pasted second literal
  // would drift from the first the day a rule is added — and would do it
  // silently, since only one of the two is under the assertion above.
  assert.equal(
    (CONNECTORS_TSX.match(/const PERSONAL_ALLOW_RULES = /g) || []).length, 1,
    'one constant feeds both blocks'
  );
  for (const id of ['connector-allow-rules', 'connector-repo-allow-rules']) {
    const pre = CONNECTORS_TSX.match(new RegExp(`<pre id="${id}"[^>]*>([^<]*)<`));
    assert.ok(pre, `#${id} is a <pre>`);
    assert.equal(pre[1].trim(), '{PERSONAL_ALLOW_RULES}', `#${id} renders the shared constant`);
  }
});

test('the panel says why Usernode cannot just do this for the user', () => {
  // The #1222 gap: the page explained the fix and offered a copy button, and
  // said nothing about why a platform that clearly knows the rules does not
  // apply them. Left unsaid, the copy button reads as busywork the product
  // could have spared them — and the honest answer is also reassuring, since
  // "a connector cannot write your permission files" is exactly what stops
  // the NEXT connector granting itself whatever it likes.
  assert.match(CONNECTORS_TSX, /Usernode cannot switch this on for you/);
  assert.match(CONNECTORS_TSX, /a connector has no way to write either/);
  assert.match(CONNECTORS_TSX, /one-time thing/);
});

test('a user whose connector has some other name has a field, not a paragraph', () => {
  // The hint tells the MODEL to substitute the server segment. This is the
  // same fix for the person reading the page, who has the one piece of
  // information the platform does not: what their tools are actually called.
  assert.match(CONNECTORS_TSX, /id="connector-name-spelling"/);
  assert.match(CONNECTORS_TSX, /Connector registered under a different name\?/);
  // It tells them where to look, and names both spellings that need no fix.
  const field = CONNECTORS_TSX.slice(CONNECTORS_TSX.indexOf('connector-name-spelling'));
  assert.match(field, /mcp__usernode__whoami/);
  assert.match(field, /both blocks above are rewritten/);

  // And it is wired: the field rewrites the two rendered blocks in place, so
  // the copy button they already have picks up the corrected rules.
  assert.match(SETTINGS_JS, /_wireConnectorNameSpelling\(\)/);
  const handler = SETTINGS_JS.slice(SETTINGS_JS.indexOf('_wireConnectorNameSpelling() {'));
  assert.match(handler, /connector-allow-rules/);
  assert.match(handler, /connector-repo-allow-rules/);
  // Derived from the rendered block rather than from a second copy of the
  // rule list — the same reason the panel interpolates one constant.
  assert.match(handler, /JSON\.parse\(canonical\)/);
  // A server segment is a bare name; anything that could break the JSON or
  // smuggle a glob into it is dropped rather than rendered.
  assert.match(handler, /replace\(\/\[\^A-Za-z0-9\.-\]\/g, ''\)/);
  // And typing the canonical name back puts the shipped block back, rather
  // than leaving a rewritten copy that happens to say the same thing.
  assert.match(handler, /toLowerCase\(\) !== 'usernode'/);
});

test('both copy buttons copy their own block', () => {
  // Wired as a loop over the two ids rather than two hand-written handlers:
  // the second block was added later, and a copy button that silently copies
  // the other block is indistinguishable from one that works.
  const settingsJs = read('frontend/src/features/settings/settings.js');
  assert.match(settingsJs, /\['connector-allow-rules', 'connector-repo-allow-rules'\]/);
  assert.match(settingsJs, /_wireCopyControl\(`\$\{id\}-copy`/);
  assert.match(settingsJs, /getElementById\(id\)/);
  // #1290 deliberately re-points this from `clipboard.writeText(...)` to the
  // shared helper. `PlatformUI.copyText` carries the off-screen-textarea
  // execCommand fallback every other copy on the platform gets, so an
  // insecure origin or a locked-down webview copies instead of failing
  // silently — and it resolves a boolean instead of throwing, which is what
  // lets the handler stop claiming success on a rejected write. Still read
  // from `block.textContent` at click time, because the name-spelling field
  // rewrites the block in place.
  assert.match(settingsJs, /PlatformUI\.copyText/);
  assert.match(settingsJs, /block\.textContent/);
});

test('each allow-rules block names the file it is for, above the block', () => {
  // #1290. Beside the block, the button was a flex sibling of a twelve-line
  // <pre> and `align-items: stretch` made it a ~210px violet slab that also
  // took ~80px of width off a block already scrolling sideways on a phone.
  // A `flex-1` <pre> is the tell that the button is back to being a sibling.
  for (const id of ['connector-allow-rules', 'connector-repo-allow-rules']) {
    const pre = CONNECTORS_TSX.match(new RegExp(`<pre id="${id}" className="([^"]*)"`));
    assert.ok(pre, `#${id} is a <pre> with a class string`);
    assert.ok(!/\bflex-1\b/.test(pre[1]),
      `#${id} spans the panel rather than sharing a row with its Copy button`);
  }
  // The two blocks are byte-identical, so the destination file is the only
  // thing that distinguishes them — it is rendered, not just described in the
  // paragraph above.
  assert.match(CONNECTORS_TSX,
    /<span className="font-mono[^"]*">~\/\.claude\/settings\.json<\/span>/);
  assert.match(CONNECTORS_TSX,
    /<span className="font-mono[^"]*">\.claude\/settings\.json<\/span>/);
  // And the copy buttons step down off the violet fill, which #connector-url-copy
  // (the section's real primary action) keeps.
  for (const id of ['connector-allow-rules-copy', 'connector-repo-allow-rules-copy']) {
    const btn = CONNECTORS_TSX.match(new RegExp(`id="${id}"[\\s\\S]{0,400}?</Button>`));
    assert.ok(btn, `#${id} is a Button`);
    assert.match(btn[0], /variant="outline"/, `#${id} is the neutral bordered control`);
    assert.match(btn[0], /min-h-\[44px\] sm:min-h-\[36px\]/,
      `#${id} keeps a 44px tap target on a phone`);
  }
});

test('the three copy buttons are distinguishable to a screen reader', () => {
  // All three said only "Copy", on a screen where two of them act on
  // byte-identical JSON (#1290).
  const labels = (CONNECTORS_TSX.match(/aria-label="Copy[^"]*"/g) || []);
  assert.equal(new Set(labels).size, 3,
    'the connector URL and both allow-rule blocks each have their own name');
});

test('copying reports the destination, and reports failure honestly', () => {
  const settingsJs = read('frontend/src/features/settings/settings.js');
  // The label swap alone cannot say WHICH file you copied for, and on a phone
  // the thumb is over it — so the toast names the destination.
  assert.match(settingsJs, /Copied — paste it into ~\/\.claude\/settings\.json/);
  assert.match(settingsJs, /Copied — commit it as \.claude\/settings\.json in your app repo/);
  assert.match(settingsJs, /Connector URL copied/);
  // The URL button used to write 'Copied' even when writeText had rejected.
  assert.match(settingsJs, /'Copy failed'/);
  assert.match(settingsJs, /\{ error: true \}/);
  // A second press must not cut the first press's confirmation short.
  assert.match(settingsJs, /clearTimeout\(resetTimer\)/);
});

test('the scaffolded README points at the personal settings file too', () => {
  // Someone who reads the repo file and wants it everywhere should not have
  // to find the Settings page by accident.
  const readme = scaffold().get('.claude/README.md');
  assert.match(readme, /~\/\.claude\/settings\.json/);
  assert.match(readme, /Settings → Connectors/);
});

// ── 7. The doc ─────────────────────────────────────────────────────────

test('the doc records which creation paths scaffold the file', () => {
  assert.match(CONNECTOR_DOC, /getConnectorScaffoldFiles\(\)/);
  assert.match(CONNECTOR_DOC, /Import an existing repo/);
  assert.match(CONNECTOR_DOC, /Fork another app/);
  assert.match(CONNECTOR_DOC, /write-if-absent, and never fatal/i);
});

test('the doc explains why there is no campaign over existing repos', () => {
  // The reasoning matters more than the decision: a future reader who only
  // sees "we did not do it" will propose it again.
  assert.match(CONNECTOR_DOC, /12 of 35/);
  assert.match(CONNECTOR_DOC, /everywhere-at-once fix is the user's own settings file/i);
});

test("the doc states the platform's own build workers are unaffected", () => {
  // A natural and wrong assumption, worth closing explicitly.
  assert.match(CONNECTOR_DOC, /--dangerously-skip-permissions/);
  assert.match(CONNECTOR_DOC, /--strict-mcp-config/);
});

test('the open question about ephemeral web containers is recorded as open', () => {
  // It cannot be answered from this repository — it needs a fresh Claude
  // Code web session — and it must not be quietly dropped, because the
  // answer changes what this can honestly be announced as.
  assert.match(CONNECTOR_DOC, /Open question/i);
  assert.match(CONNECTOR_DOC, /ephemeral web containers/i);
  assert.match(CONNECTOR_DOC, /has not been settled/i);
});
