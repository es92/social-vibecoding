// The create dialog's progress view —
// frontend/src/features/dialogs/create-progress.tsx.
//
// After a successful POST /api/apps the dialog stops being a form and
// becomes a report on what the server is doing. The component is
// deliberately PURE — it takes the store state and four callbacks, and
// the parent owns the subscription and the poll — so the four outcomes
// and their copy can be rendered and asserted here without a browser.
//
// Effects do NOT run under renderToStaticMarkup (see tests/lib/render-tsx.js),
// which is exactly why the branching lives in props rather than in a
// hook inside this component.
//
// Run with: node --test tests/create-progress-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

let cached = null;
const mod = () => (cached || (cached = loadTsx('frontend/src/features/dialogs/create-progress.tsx')));

const PROGRESS = {
  slug: 'my-app', status: 'creating', phase: null,
  url: null, errorReason: null, missingSecrets: null,
};

function html(over, props) {
  const m = mod();
  return renderToHtml(createElement(m.CreateProgress, {
    appName: 'My App',
    mode: 'new',
    progress: { ...PROGRESS, ...over },
    onOpenApp: () => {},
    onRetry: () => {},
    onSetSecrets: () => {},
    onClose: () => {},
    ...props,
  }));
}

const text = (over, props) => html(over, props).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// ── The step list ─────────────────────────────────────────────────

test('all four steps are always listed, so the user sees the whole shape', () => {
  const t = text({ phase: 'database' });
  for (const label of ['database', 'repository', 'Building', 'live']) {
    assert.ok(t.includes(label), `missing step copy: ${label}`);
  }
});

test('the running step is marked active and the finished ones done', () => {
  const out = html({ phase: 'build' });
  assert.match(out, /data-step="database"[^>]*data-state="done"/);
  assert.match(out, /data-step="repository"[^>]*data-state="done"/);
  assert.match(out, /data-step="build"[^>]*data-state="active"/);
  assert.match(out, /data-step="deploy"[^>]*data-state="idle"/);
});

test('a failure marks the step it died in', () => {
  const out = html({ phase: 'build', status: 'error', errorReason: 'Build failed: no Dockerfile' });
  assert.match(out, /data-step="build"[^>]*data-state="failed"/);
});

// ── The four outcomes ─────────────────────────────────────────────

test('pending says it is still working and that leaving is safe', () => {
  const t = text({ phase: 'repository' });
  assert.match(t, /Creating .?My App/, 'headline names the app being created');
  assert.match(t, /close this|keep going|background/i,
    'the user must be told they are not required to wait here');
});

test('an import says importing, not creating', () => {
  assert.match(text({ phase: 'repository' }, { mode: 'import' }), /Importing .?My App/);
});

test('a fork says it is remixing the named app', () => {
  assert.match(text({ phase: 'repository' }, { mode: 'fork' }), /Remixing .?My App/);
  assert.doesNotMatch(text({ phase: 'repository' }, { mode: 'fork' }), /Fork/, 'people see Remix, never Fork');
});

test('live shows the app is up and offers to open it', () => {
  const out = html({ status: 'running', url: 'https://my-app.example.test' });
  assert.match(out.replace(/<[^>]*>/g, ' '), /live/i);
  assert.match(out, /id="create-progress-primary"/);
  assert.match(out.replace(/<[^>]*>/g, ' '), /Open app/);
});

test('needs-secrets names the keys and offers the secrets panel, not a retry', () => {
  const out = html({ status: 'awaiting_secrets', phase: 'repository', missingSecrets: ['API_KEY', 'DB_TOKEN'] });
  const t = out.replace(/<[^>]*>/g, ' ');
  assert.ok(t.includes('API_KEY') && t.includes('DB_TOKEN'), 'the user needs to know WHICH keys');
  assert.match(t, /secret/i);
  assert.doesNotMatch(t, /Retry/, 'nothing failed — there is nothing to retry');
});

test('a failure shows the reason and offers a retry', () => {
  const t = text({ status: 'error', phase: 'build', errorReason: 'Build failed: no Dockerfile' });
  assert.ok(t.includes('Build failed: no Dockerfile'), 'the concise reason is the whole point');
  assert.match(t, /Retry/);
});

// QA 2026-09-24 Q32b: the reason is the server's own line, e.g. "Build failed:
// ERROR: failed to connect to the docker API at unix:///var/run/docker.sock…".
// The status line says what happened in plain words; the reason is kept, one
// press away, in a Details disclosure.
test('a failure leads with a plain summary and keeps the raw reason under Details', () => {
  const reason = 'Build failed: ERROR: failed to connect to the docker API at unix:///var/run/docker.sock';
  const out = html({ status: 'error', phase: 'build', errorReason: reason });
  const status = out.match(/<p id="create-progress-status"[^>]*>([\s\S]*?)<\/p>/)[1].replace(/<[^>]*>/g, '');
  assert.equal(status, 'The build didn’t finish. Try again, or ask an admin.');
  assert.doesNotMatch(status, /docker|ERROR/);
  const details = out.match(/<details id="create-progress-details"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(details, 'the reason sits in a disclosure');
  assert.match(details[1], /<summary[^>]*>Details<\/summary>/);
  assert.ok(details[1].includes(reason));
  assert.doesNotMatch(out, /<details[^>]* open/, 'closed until asked for');
  // A step other than the build says setup rather than build.
  const db = html({ status: 'error', phase: 'database', errorReason: 'role "x" does not exist' });
  assert.match(db, /Setup didn’t finish\. Try again, or ask an admin\./);
  // No reason, no disclosure: there is nothing to put in it.
  assert.doesNotMatch(html({ status: 'error', phase: null }), /create-progress-details/);
  assert.doesNotMatch(html({ phase: 'build' }), /create-progress-details/);
});

test('a failure with no reason still says something useful', () => {
  const t = text({ status: 'error', phase: null });
  assert.match(t, /Retry/);
  assert.ok(t.trim().length > 40, 'an empty error screen is worse than a vague one');
});

// ── Next steps ────────────────────────────────────────────────────

test('next steps are shown while pending and once live, but not on a failure', () => {
  assert.match(html({ phase: 'build' }), /id="create-progress-next"/);
  assert.match(html({ status: 'running' }), /id="create-progress-next"/);
  assert.doesNotMatch(
    html({ status: 'error', errorReason: 'boom' }), /id="create-progress-next"/,
    'telling someone to "describe your first change" under a failure is noise'
  );
});

// ── Who builds it, and who approves it (#13, #14) ─────────────────
//
// The Plant Pal test: the bot's DM said it was building the first version
// and would send it to try, while this view said "Open it to see what it
// shipped with", listed "Open your app" as the first thing to do, and told
// somebody making a project for just themselves that collaborators vote.

const statusOf = (out) => out.match(/<p id="create-progress-status"[^>]*>([\s\S]*?)<\/p>/)[1].replace(/<[^>]*>/g, '');
const nextOf = (out) => [...out.matchAll(/<li class="flex gap-2[^"]*">[\s\S]*?<span>([^<]*)<\/span><\/li>/g)].map((m) => m[1]);

test('the live line says what is running and who builds the first version', () => {
  const live = { status: 'running' };
  const bot = statusOf(html(live, { appName: 'Plant Pal', builder: 'bot', audience: 'solo' }));
  assert.equal(bot, 'Plant Pal is set up. Homeroom bot is building its first version from your description and will message you when it’s ready to try.');
  assert.doesNotMatch(bot, /Open it/, 'the starter is not what the bot is building');
  assert.equal(statusOf(html(live, { builder: 'request', audience: 'open' })),
    'Your project is ready. Its first request is waiting on its page.');
  // An import and a fork keep today's line.
  assert.equal(statusOf(html(live, { mode: 'import', builder: null, audience: 'solo' })),
    'Your app is running. Open it to see what it shipped with.');
  assert.equal(statusOf(html(live, { mode: 'fork' })), 'Your app is running. Open it to see what it shipped with.');
  // While pending, everybody gets the same "keep going" line.
  assert.match(statusOf(html({ phase: 'build' }, { builder: 'bot', audience: 'solo' })), /You can close this and keep going/);
});

test('what happens next follows who builds it and who it is for: a builder by audience matrix', () => {
  const { nextSteps } = mod();
  const approve = { solo: 'You approve it, and it goes live.', invited: 'Members vote it in, and it goes live.', open: 'Members vote it in, and it goes live.' };
  for (const audience of ['solo', 'invited', 'open']) {
    assert.deepEqual([...nextSteps({ builder: 'bot', audience, mode: 'new' })], [
      'Homeroom bot builds the first version from your description.',
      'It messages you in your chat when it’s ready, and asks there if anything is unclear.',
      approve[audience],
    ], `bot, ${audience}`);
    assert.deepEqual([...nextSteps({ builder: 'request', audience, mode: 'new' })], [
      'Your description is the project’s first request.',
      'Start a change from it, and a coding agent writes it.',
      approve[audience],
    ], `request, ${audience}`);
    // An import builds nothing from a description, but who approves is still
    // who it is for.
    assert.equal(nextSteps({ builder: null, audience, mode: 'import' })[2], approve[audience], `import, ${audience}`);
    for (const builder of ['bot', 'request', null]) {
      const lines = nextSteps({ builder, audience, mode: builder ? 'new' : 'import' }).join(' ');
      if (audience === 'solo') assert.doesNotMatch(lines, /[Cc]ollaborators|Members/, `no group on a Just me project (${builder})`);
      if (builder === 'bot') assert.doesNotMatch(lines, /Open (it|your app)/, 'the bot builds it; nothing to open and try yet');
    }
  }
  // A fork (a remix) always starts as Just you, so the vote is yours.
  assert.deepEqual([...nextSteps({ mode: 'fork' })], [
    'Open your app and try what it shipped with.',
    'Describe a change in chat, and a coding agent writes it.',
    'You approve it, and it goes live.',
  ]);
  // And the view draws what nextSteps says.
  assert.deepEqual(nextOf(html({ status: 'running' }, { builder: 'bot', audience: 'solo' })),
    [...nextSteps({ builder: 'bot', audience: 'solo', mode: 'new' })]);
  assert.deepEqual(nextOf(html({ phase: 'build' }, { mode: 'fork' })), [...nextSteps({ mode: 'fork' })]);
});

test('#13: the bot case also offers the app itself, under the bot\'s DM; nobody else gets a second button', () => {
  const live = { status: 'running' };
  const bot = html(live, {
    builder: 'bot', audience: 'solo', openLabel: 'Open my chat with Homeroom bot', onViewApp: () => {},
  });
  assert.match(bot, /<button type="button" id="create-progress-view-app" class="w-full[^"]*">Open app<\/button>/);
  assert.ok(bot.indexOf('id="create-progress-view-app"') < bot.indexOf('id="create-progress-close"'), 'above the footer');
  assert.match(bot, /id="create-progress-primary"[^>]*>Open my chat with Homeroom bot</, 'the DM stays the primary act');
  for (const props of [
    { builder: 'request', audience: 'open', onViewApp: () => {} },
    { mode: 'fork', onViewApp: () => {} },
    { builder: 'bot', audience: 'solo' },
  ]) {
    assert.doesNotMatch(html(live, props), /create-progress-view-app/, JSON.stringify(Object.keys(props)));
  }
  assert.doesNotMatch(html({ phase: 'build' }, { builder: 'bot', audience: 'solo', onViewApp: () => {} }), /create-progress-view-app/,
    'not before there is an app to open');
});

// ── Always available ──────────────────────────────────────────────

test('every outcome offers a way out of the dialog', () => {
  for (const over of [
    { phase: 'build' },
    { status: 'running' },
    { status: 'awaiting_secrets', missingSecrets: ['K'] },
    { status: 'error', errorReason: 'boom' },
  ]) {
    assert.match(html(over), /id="create-progress-close"/,
      `no close button for ${JSON.stringify(over)}`);
  }
});

test('the status line is a live region, so it is announced as it changes', () => {
  const out = html({ phase: 'build' });
  assert.match(out, /id="create-progress-status"/);
  assert.match(out, /aria-live="polite"/);
});

test('the app name is escaped, never interpolated as markup', () => {
  const out = html({ phase: 'build' }, { appName: '<img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('<img'), 'React escapes text children — keep it a text child');
  assert.ok(out.includes('&lt;img'), 'and the name is still shown');
});

// ── Surface ───────────────────────────────────────────────────────

test('the inset panel does not paint itself the dialog card\'s own background', () => {
  // DialogCard is `bg-white dark:bg-zinc-900` (@/components/ui/dialog.tsx).
  // An inset block that reaches for dark:bg-zinc-900 disappears in dark
  // mode — it is the same colour as the card behind it, and only the
  // border survives. The dialog already has an idiom for this: its
  // segmented pills sit on `bg-zinc-100 dark:bg-zinc-800`.
  const out = html({ phase: 'build' });
  const panel = out.match(/<div id="create-progress-next"[^>]*class="([^"]*)"/);
  assert.ok(panel, 'the next-steps panel renders');
  assert.doesNotMatch(panel[1], /dark:bg-zinc-900/,
    'invisible against the card in dark mode');
  assert.match(panel[1], /dark:bg-zinc-800/, 'use the dialog\'s existing inset tone');
});
