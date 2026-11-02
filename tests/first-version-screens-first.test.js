'use strict';

// The first look, drawn first (newcomer run four, 12-13 October 2026).
//
// Club Votes' spec turn ran five and a half minutes and wrote 40,159
// characters, two drawn phone screens among them, and the first look was
// drawn from the spec only once all of it was in. Now a first version's spec
// draws its main screen before anything else and saves it with
// `usernode-screen 1` (worker/usernode-screen); the platform sees the command
// in the turn's own stream, reads the saved screen off the worker and draws
// the first look from it while the spec goes on
// (services/first-version-screens.js); the spec then writes an empty
// placeholder where the screen goes, and the saved screen is put there once
// the spec is in (homeroom-bot-live.js fillSavedScreens), so it is written
// once. A screen the command did not save is drawn in full, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fvs = require('../src/services/first-version-screens');
const live = require('../src/services/homeroom-bot-live');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = '<template data-screen data-size="phone" data-height="1400"><style>:root{--accent:37 99 235}</style>'
  + '<div data-side="after" data-change="1"><h2>Open polls</h2><button class="btn-primary">New poll</button></div></template>';
const SPEC = '<article data-spec><h1>Polls for the club</h1><section data-spec-tab="user"><h2>User-facing changes</h2>'
  + '<figure data-screens><template data-screen data-from="1"></template><ol data-changes><li>The open polls</li></ol></figure>'
  + '<h3>Assumptions</h3><p>Votes are anonymous.</p></section>'
  + '<section data-spec-tab="tech"><h2>Technical implementation</h2><p>public/app.js draws the list.</p></section></article>';

test('the stream shows a screen saved: the command, in either harness, or its answer', () => {
  assert.equal(fvs.savedScreenOf('$ usernode-screen 1 <<\'SCREEN\''), 1);
  assert.equal(fvs.savedScreenOf('$ /bin/bash -lc \'usernode-screen 2 <<SCREEN'), 2);
  assert.equal(fvs.savedScreenOf('  ⎿ Bash: Saved screen 1 (2048 characters). In the spec\'s screens figure, …'), 1);
  for (const line of ['$ usernode-screens 1', '$ usernode-screen 3', 'Reading usernode-screen 1', '… thinking about usernode-screen 1',
    'Saved screen 1', '$ usernode-screen', '$ usernode-screen 1.html']) {
    assert.equal(fvs.savedScreenOf(line), null, line);
  }
});

test('a saved screen is one whole <template data-screen>, and goes where the figure holds its placeholder', () => {
  assert.equal(fvs.savedTemplateOf(`noise\n${SCREEN}\ntail`), SCREEN);
  assert.equal(fvs.savedTemplateOf('<template data-screen data-from="1"></template>'), null, 'a placeholder is no screen');
  assert.equal(fvs.savedTemplateOf('<template data-screen>   </template>'), null, 'an empty one either');
  assert.equal(fvs.savedTemplateOf('<div>no template</div>'), null);
  assert.equal(fvs.savedTemplateOf('<template data-screen><div>never closed'), null);
  const filled = fvs.spliceSavedScreens(SPEC, new Map([[1, SCREEN]]));
  assert.ok(filled.includes(`<figure data-screens>${SCREEN}<ol data-changes>`));
  assert.doesNotMatch(filled, /data-from/);
  assert.equal(fvs.spliceSavedScreens(SPEC, new Map([[2, SCREEN]])), SPEC, 'a screen not saved leaves its placeholder');
  assert.equal(fvs.spliceSavedScreens(SPEC, new Map()), SPEC);
  // The first look is drawn from it as from a spec.
  assert.deepEqual(fvs.mainScreenOf(fvs.screenDocument(SCREEN)), {
    markup: '<style>:root{--accent:37 99 235}</style><div data-side="after" data-change="1"><h2>Open polls</h2><button class="btn-primary">New poll</button></div>',
    width: 390, height: 844,
  });
});

test('read off the worker: the saved file, never anything else', async () => {
  const asked = [];
  const worker = { async runLiveScript(container, script, opts) { asked.push({ container, script, opts }); return SCREEN; } };
  assert.equal(await fvs.readSavedScreen(worker, 'w-1', 1), SCREEN);
  assert.deepEqual(asked[0].opts.args, ['/tmp/usernode-screens/1.html']);
  assert.equal(asked[0].script, 'cat "$1" 2>/dev/null || true');
  assert.equal(await fvs.readSavedScreen(worker, 'w-1', 3), null);
  assert.equal(await fvs.readSavedScreen({ async runLiveScript() { throw new Error('gone'); } }, 'w-1', 1), null, 'never throws');
  assert.equal(await fvs.readSavedScreen({ async runLiveScript() { return 'cat: no such file'; } }, 'w-1', 1), null);
  assert.equal(await fvs.readSavedScreen({}, 'w-1', 1), null);
});

test('the watcher reads a saved screen as soon as the stream shows it, tries again a moment later, and hands each change on once', async () => {
  let calls = 0;
  const seen = [];
  const watch = fvs.screenWatcher({
    delayMs: 1,
    read: async (n) => { calls += 1; return calls < 2 ? null : (n === 1 ? SCREEN : null); },
    onScreen: (s) => seen.push(s),
  });
  watch('$ usernode-screen 1 <<\'SCREEN\'');
  watch('$ usernode-screen 1 <<\'SCREEN\''); // already being read
  await watch.idle();
  assert.deepEqual(seen, [{ n: 1, markup: SCREEN }]);
  assert.equal(calls, 2, 'not there yet, then there');
  watch('  ⎿ Bash: Saved screen 1 (300 characters).');
  await watch.idle();
  assert.equal(seen.length, 1, 'the same screen again is no change');
  assert.deepEqual([...watch.saved().keys()], [1]);
});

test('drawn as the first look while the spec goes on, from the saved screen', async () => {
  const sent = [];
  const worker = {
    async runBenchCapture(container, opts) {
      sent.push({ container, ...opts });
      return `${fvs.MARKER} ${JSON.stringify({ ok: true, png: PNG.toString('base64') })}\n`;
    },
  };
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  assert.equal(await fvs.renderSavedFirstLook({ pool, worker, containerName: 'w-1', runId: 9, markup: SCREEN }), true);
  assert.match(sent[0].source, /Open polls/);
  assert.ok(calls.some((c) => /INSERT INTO first_version_screens/.test(c.sql) && c.params[2] === 'first_look'));
  assert.equal(await fvs.renderSavedFirstLook({ pool, worker, containerName: 'w-1', runId: 9, markup: '<div/>' }), false);
});

test('the spec turn: the saved screen drawn while it runs, and put into the spec once it is in', async () => {
  const screens = [];
  const persisted = [];
  const deps = {
    worker: {
      async execInWorker(_id, { onProgress }) {
        onProgress('Reading public/index.html');
        onProgress('$ usernode-screen 1 <<\'SCREEN\'');
        onProgress('  ⎿ Bash: Saved screen 1 (300 characters).');
        await new Promise((r) => setTimeout(r, 1700));
        return { lastResultText: SPEC };
      },
      async runLiveScript(_c, _s, { args }) { return args[0].endsWith('/1.html') ? SCREEN : ''; },
      async stopTurn() {},
    },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
      async persistScoutPublication(args) { persisted.push(args); return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
  };
  const spec = await live.draftSpec({
    pool: {}, config: {}, bot: { id: 1 }, session: { id: 5, app_slug: 'club-votes', branch_name: 'b' }, containerName: 'w-5',
    seed: 'seed', buildNote: 'note', turnBudgetMs: 60000, model: 'm', deps, firstVersion: true,
    onScreen: (s) => screens.push(s),
  });
  assert.equal(spec.ok, true, spec.error);
  assert.deepEqual(screens, [{ n: 1, markup: SCREEN, containerName: 'w-5' }], 'handed on while the spec ran');
  assert.ok(spec.specHtml.includes('<h2>Open polls</h2>'), 'the saved screen is in the spec');
  assert.doesNotMatch(spec.specHtml, /data-from/);
  assert.ok(persisted[0].contentHtml.includes('<h2>Open polls</h2>'), 'and in the spec the group reads');

  // A later change's spec is not watched, and its figure is its own.
  const later = await live.fillSavedScreens({
    fvScreens: fvs, screens: null, worker: { async runLiveScript() { return SCREEN; } }, containerName: 'w', result: { lastResultText: '# Plain spec' },
  });
  assert.equal(later.lastResultText, '# Plain spec');
});

test('the spec is told to draw the main screen first and save it; the command only writes the screen', () => {
  const prompt = live.specPrompt({ seed: 'S', buildNote: 'p', firstVersion: true, html: true });
  assert.ok(prompt.includes(live.FIRST_VERSION_SCREENS_FIRST));
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /BEFORE you write anything else of the\nspec, draw the main screen and save it/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /usernode-screen 1 <<'SCREEN'/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /<template data-screen data-from="N"><\/template>/);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /If the command is missing or\ndoes not answer "Saved screen N", draw that screen in the figure in full instead\./);
  assert.ok(!live.specPrompt({ seed: 'S', buildNote: 'p', html: true }).includes('usernode-screen'), 'a later change is not asked');
  assert.doesNotMatch(live.FIRST_VERSION_SCREENS_FIRST, /—/);
  const script = read('worker/usernode-screen');
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /dir=\/tmp\/usernode-screens/);
  assert.match(script, /head -c 200000 > "\$part"/);
  assert.match(script, /mv -f "\$part" "\$dir\/\$n\.html"/, 'written aside, then moved: never read half written');
  assert.match(script, /echo "Saved screen \$n/);
  assert.doesNotMatch(script, /curl|wget|git /, 'nothing is sent from it');
  assert.equal(fs.statSync(path.join(ROOT, 'worker/usernode-screen')).mode & 0o111, 0o111, 'executable');
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /COPY usernode-screen \/usr\/local\/bin\/usernode-screen/);
  assert.match(dockerfile, /\/usr\/local\/bin\/usernode-screen \\/);
});

test('the live build draws the first look from the saved screen, and from the whole spec only when that did not happen', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /onScreen: \(\{ n, markup, containerName \}\) => \{\s+if \(Number\(n\) !== 1\) return;\s+void firstVersionScreens\(\)\.renderSavedFirstLook\(\{/);
  assert.match(src, /onFirstLook: \(\{ specHtml, containerName \}\) => \(drewEarly \? false : firstVersionScreens\(\)\.renderFirstLook\(\{/);
  assert.match(src, /onFirstLook: null, onScreen: null,/, 'the retry drew none');
  const liveSrc = read('src/services/homeroom-bot-live.js');
  assert.match(liveSrc, /locale, onScreen,/);
  // A spec a restart caught is followed by its durable turn, and its result
  // gets its saved screens back off its worker as a spec seen through does.
  const draft = liveSrc.slice(liveSrc.indexOf('async function draftSpec('), liveSrc.indexOf('\nasync function ', liveSrc.indexOf('async function draftSpec(') + 1));
  const turnAt = draft.indexOf("durableTurn.runTurn(steps, 'spec', {");
  const fillAt = draft.indexOf('await fillSavedScreens({ fvScreens, screens: savedScreens, worker, containerName, result: routed.result })');
  assert.ok(turnAt > 0 && fillAt > turnAt, 'the saved screens are filled into whatever the turn resolved, followed or not');
});

// Newcomer run five (13 October 2026): the spec saved nothing and drew both
// screens in its final answer, so the first look came 15 s after a spec of
// 4 min 18 s. The instruction sat after the long HTML contract and the
// screens brief, and an earlier PLAN MODE line told the spec to create
// nothing. Now it follows the plan and the PLAN MODE paragraph, which names
// `usernode-screen` as its one exception; and a spec that saves nothing is
// warned about and counted, with how soon its first screen was saved when
// it did, so the numbers say whether the prompt is enough.

test('the screens-first instruction comes straight after the plan, before the format, and PLAN MODE excepts it', () => {
  const prompt = live.specPrompt({ seed: 'S', buildNote: 'p', firstVersion: true, html: true });
  const at = (needle) => {
    const i = prompt.indexOf(needle);
    assert.ok(i >= 0, `the prompt holds ${needle}`);
    return i;
  };
  const first = at(live.FIRST_VERSION_SCREENS_FIRST);
  assert.equal(prompt.indexOf(live.FIRST_VERSION_SCREENS_FIRST, first + 1), -1, 'said once');
  assert.ok(at('You are running in PLAN MODE') < first, 'after the PLAN MODE paragraph');
  assert.ok(at('The one exception is `usernode-screen`, below') < first);
  assert.ok(first < at('The spec must be:'), 'before the spec\'s rules');
  assert.ok(first < at('HTML SPEC FORMAT:'), 'before the long HTML contract');
  assert.ok(first < at('FIRST VERSION SCREENS:'), 'before the screens brief');
  assert.match(prompt, /discarded when it ends\.\nThe one exception is `usernode-screen`, below: it saves a screen you drew outside the repository, and you\nmust run it\.\n\nDRAW THE MAIN SCREEN FIRST\./);
  assert.match(live.FIRST_VERSION_SCREENS_FIRST, /within your first few minutes, and before your final answer/);
  const later = live.specPrompt({ seed: 'S', buildNote: 'p', html: true });
  assert.doesNotMatch(later, /usernode-screen|exception is/, 'a later change is not told of it');
  assert.match(later, /do not edit,\ncreate, delete, commit, or push anything;/);
});

test('the first screen is drawn without the staging label the demo wears', () => {
  const { FIRST_VERSION_SCREENS_BRIEF } = require('../src/services/prompts');
  assert.match(FIRST_VERSION_SCREENS_BRIEF, /The first is normally the main screen, populated with the demo data your Design subsection describes but drawn WITHOUT its "Sample data" label/);
  assert.match(FIRST_VERSION_SCREENS_BRIEF, /the Design subsection still says where the label goes, and the build adds it there/);
  assert.doesNotMatch(FIRST_VERSION_SCREENS_BRIEF, /—/);
});

test('a missed first look is a warning, not info', () => {
  const src = read('src/services/first-version-screens.js');
  assert.match(src, /log\.warn\('first-version-screens', 'No first look from the spec\\'s screen'/);
  assert.match(src, /log\.warn\('first-version-screens', 'Could not read a saved screen'/);
  assert.doesNotMatch(src, /log\.info\(/);
});

function specDeps({ save }) {
  return {
    worker: {
      async execInWorker(_id, { onProgress }) {
        onProgress('Reading public/index.html');
        if (save) onProgress('$ usernode-screen 1 <<\'SCREEN\'');
        return { lastResultText: save ? SPEC : SPEC.replace('<template data-screen data-from="1"></template>', SCREEN) };
      },
      async runLiveScript(_c, _s, { args }) { return save && args[0].endsWith('/1.html') ? SCREEN : ''; },
      async stopTurn() {},
    },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
  };
}

async function runSpec({ save, firstVersion = true, html = true }) {
  const log = require('../src/services/logger');
  const realWarn = log.warn;
  const warned = [];
  const recorded = [];
  log.warn = (component, message, detail) => { warned.push({ component, message, detail }); };
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO events/.test(String(sql))) recorded.push({ type: params[3], appId: params[1], sessionId: params[2], metadata: JSON.parse(params[4]) });
      return { rows: [] };
    },
  };
  try {
    const spec = await live.draftSpec({
      pool, config: html ? { htmlSpecApps: ['*'] } : {}, bot: { id: 1 }, session: { id: 6, app_id: 41, app_slug: 'club-votes', branch_name: 'b' }, containerName: 'w-6',
      seed: 'seed', buildNote: 'note', turnBudgetMs: 60000, model: 'm', deps: specDeps({ save }), firstVersion,
    });
    return { spec, warned, recorded };
  } finally {
    log.warn = realWarn;
  }
}

test('a first version\'s spec that saved no screen is warned about and counted', async () => {
  const { spec, warned, recorded } = await runSpec({ save: false });
  assert.equal(spec.ok, true, spec.error);
  assert.ok(spec.specHtml.includes('<h2>Open polls</h2>'), 'drawn in full, as before');
  const warning = warned.find((w) => /saved no screen/.test(w.message));
  assert.ok(warning, 'warned');
  assert.equal(warning.component, 'homeroom-bot');
  assert.equal(warning.detail.sessionId, 6);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, 'bot_spec_screens');
  assert.equal(recorded[0].appId, 41);
  assert.equal(recorded[0].sessionId, 6);
  assert.equal(recorded[0].metadata.saved, 0);
  assert.equal(recorded[0].metadata.firstSavedMs, null);
  assert.equal(recorded[0].metadata.ok, true);
  assert.equal(recorded[0].metadata.stopped, false);
  assert.equal(typeof recorded[0].metadata.specMs, 'number');
});

test('a spec that saved its screen is counted with how soon, and not warned about; a later change or a markdown spec is not counted', async () => {
  const { spec, warned, recorded } = await runSpec({ save: true });
  assert.equal(spec.ok, true, spec.error);
  assert.ok(!warned.some((w) => /saved no screen/.test(w.message)));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].metadata.saved, 1);
  assert.equal(typeof recorded[0].metadata.firstSavedMs, 'number');
  assert.ok(recorded[0].metadata.firstSavedMs <= recorded[0].metadata.specMs);

  const later = await runSpec({ save: false, firstVersion: false });
  assert.ok(!later.warned.some((w) => /saved no screen/.test(w.message)));
  assert.deepEqual(later.recorded, []);
  const markdown = await runSpec({ save: false, html: false });
  assert.ok(!markdown.warned.some((w) => /saved no screen/.test(w.message)), 'a markdown spec is never asked to save one');
  assert.deepEqual(markdown.recorded, []);
  const events = require('../src/services/events');
  assert.equal(events.EVENT_TYPES.BOT_SPEC_SCREENS, 'bot_spec_screens');
});

test('the watcher says when the first screen was read', async () => {
  let t = 1000;
  const watch = fvs.screenWatcher({ delayMs: 1, read: async () => SCREEN, now: () => { t += 500; return t; } });
  assert.equal(watch.firstSavedAt(), null);
  watch('$ usernode-screen 1 <<\'SCREEN\'');
  await watch.idle();
  assert.equal(watch.firstSavedAt(), 1500);
  watch('$ usernode-screen 2 <<\'SCREEN\'');
  await watch.idle();
  assert.equal(watch.firstSavedAt(), 1500, 'the first one only');
});
