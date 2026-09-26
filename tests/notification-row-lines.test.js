// A notification row is THREE lines: what kind, which one, where from.
//
// ── What it was ────────────────────────────────────────────────────────
//
// Every kind used to write a sentence about itself ("@evan proposed a PR to
// vote on in Notes"), which put the app in the row AND in the meta line under
// it, led with a username so a list of them all started the same way, and left
// the SUBJECT — the PR's title, the session's name — in `body`, a field the
// renderer never drew. The one thing telling two proposal rows apart was not
// on screen.
//
// That became `<label>: <subject>` on one line. Better, but the row runs out
// of width on exactly that line: the subject is the part that varies and the
// part that truncates, and it was paying for a fixed-length label in front of
// it on every row.
//
// ── What it is ─────────────────────────────────────────────────────────
//
//     New proposal                       ← `label`     the KIND
//     Tighten the header spacing         ← `segments`  WHICH one
//     Notes · by @ada · 4m ago           ← the meta    WHERE from
//
// Three facts, three lines, in falling order of how much of the row's width
// they deserve. The label is the same words on every row of a kind, so it
// scans as a column; the subject gets the full width to truncate in.
//
// ── The one exception, and why it is not a fourth shape ────────────────
//
// A kind with nothing to name — a collaborator invite is entirely its own
// label — leaves `segments` EMPTY, and the renderer draws the label on the
// SUBJECT's line with no kind line above it. A category heading over nothing
// would read as a rendering fault. So: three lines when there are three
// things to say, two when there are two, and never a blank one.
//
// This runs the real `rowView` over every kind rather than grepping its
// source: the mapping from a row's fields to its two lines is the whole of
// what this change is, and a regex over the call sites would pass on a label
// that says the wrong thing.
//
// Run with: node --test tests/notification-row-lines.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const SHEET = fs.readFileSync(path.join(
  __dirname, '..', 'frontend/src/features/notifications/notifications-sheet.tsx'), 'utf8');

// notifications.js publishes its controller on `window`, so a bare global is
// most of the harness. It is BUNDLED rather than imported directly because
// #1808 gave it one import — `lib/timestamp.ts`, the shared stamp helper —
// and Node's ESM resolver cannot follow an extensionless specifier to a
// TypeScript file. esbuild can, and ./lib/render-tsx.js already runs it for
// exactly this reason; the module body still evaluates once, against the same
// `window` shim.
let rowView = null;
async function load() {
  if (rowView) return rowView;
  if (!globalThis.window) globalThis.window = globalThis;
  loadTsx('frontend/src/features/notifications/notifications.js');
  rowView = globalThis.window.Notifications._rowView;
  assert.equal(typeof rowView, 'function', 'the controller publishes _rowView');
  return rowView;
}

const AT = new Date(Date.now() - 4 * 60 * 1000).toISOString();
const ROW = {
  id: 1, createdAt: AT, readAt: null,
  appName: 'Notes', appSlug: 'notes', sourceUsername: 'ada',
};

test('allowance notifications explain the change, request or review outcome', async () => {
  const changed = await lines({ kind: 'app_quota_changed', detail: '2:4', appName: null });
  assert.equal(changed.label, 'App allowance changed');
  assert.equal(changed.subject, '2 → 4 app slots');
  assert.match(changed.meta, /^Account/);
  const requested = await lines({ kind: 'app_quota_requested', appName: null });
  assert.equal(requested.subject, '@ada');
  assert.match(requested.meta, /^Admin/);
  const declined = await lines({ kind: 'app_quota_request_declined', appName: null });
  assert.equal(declined.subject, 'Your app allowance is unchanged.');
});

/** The row's two copy lines, as plain strings. */
async function lines(n) {
  const view = (await load())({ ...ROW, ...n });
  return {
    label: view.label,
    subject: view.segments
      .map((s) => (s.t === 'who' ? `@${s.v}` : s.v)).join(' '),
    meta: [view.appLine, view.by ? `by @${view.by}` : null, view.time]
      .filter(Boolean).join(' · '),
  };
}

// ─── 1. Kind, then subject ──────────────────────────────────────────────

test('the kind is its own line, and the subject is the whole of the next', async () => {
  const l = await lines({ kind: 'pr_proposed', prTitle: 'Tighten the header spacing', prNumber: 42 });
  assert.equal(l.label, 'New proposal');
  assert.equal(l.subject, 'Tighten the header spacing');
  // Nothing punctuates a line that no longer runs into another one.
  assert.ok(!l.label.endsWith(':'), 'the label lost the colon that joined them');
  // And the app and the actor stay where they were: under both.
  assert.equal(l.meta, 'Notes · by @ada · 4m ago');
});

test('every kind names itself the same way for every row of that kind', async () => {
  const cases = [
    [{ kind: 'connector_submitted', sourceUsername: null, sessionTitle: 'Messages layout', detail: null },
      'Submitted by your agent', 'Messages layout'],
    [{ kind: 'connector_submitted', sourceUsername: null, sessionTitle: 'Messages layout', detail: 'shared' },
      'Shared by your agent', 'Messages layout'],
    [{ kind: 'session_done', sourceUsername: null, sessionTitle: 'Kanban filters' },
      'Session finished', 'Kanban filters'],
    // #3181: the other way a turn ends.
    [{ kind: 'session_stalled', sourceUsername: null, sessionTitle: 'Kanban filters' },
      'Session stopped before finishing', 'Kanban filters'],
    [{ kind: 'stale_pr', sourceUsername: null, prTitle: 'Add a dark mode toggle' },
      'Needs votes', 'Add a dark mode toggle'],
    [{ kind: 'check_failed', sourceUsername: null, prTitle: 'Rework the board' },
      'Checks blocked', 'Rework the board'],
    [{ kind: 'kudos', prTitle: 'Fix the bell badge' }, 'Kudos', 'Fix the bell badge'],
    [{ kind: 'auto_solve_done', sourceUsername: null, headlessIssueNumber: 91, detail: 'question' },
      'Proposal has a question', 'issue #91'],
    [{ kind: 'spec_shared', sessionTitle: 'Notifications overhaul' }, 'Spec shared', 'Notifications overhaul'],
    [{ kind: 'mention', messageContent: 'can you take a look at the board?' },
      'Mentioned you', 'can you take a look at the board?'],
    // #2161: the app_deleted row has no app row left, so the name it names
    // is the one the creator stored in `detail`.
    [{ kind: 'app_deleted', appName: null, appSlug: null, detail: 'Notes' },
      'Deleted a shared app you contributed to', 'Notes'],
  ];
  for (const [n, label, subject] of cases) {
    const l = await lines(n);
    assert.equal(l.label, label, `${n.kind} names its kind`);
    assert.equal(l.subject, subject, `${n.kind} names which one`);
  }
});

// #3181: the row the bell shows when a dev-session turn stopped before
// finishing. The app is on the meta line, never in the label; the subject
// falls back the way session_done's does; and an agent session's change says
// who stopped, as its finished row says who finished.
test('a session that stopped before finishing says so, and where', async () => {
  const stalled = await lines({ kind: 'session_stalled', sourceUsername: null, sessionTitle: 'Kanban filters' });
  assert.equal(stalled.label, 'Session stopped before finishing');
  assert.equal(stalled.subject, 'Kanban filters');
  assert.equal(stalled.meta, 'Notes · 4m ago', 'the app, and no actor: nobody did this');

  const untitled = await lines({
    kind: 'session_stalled', sourceUsername: null, sessionTitle: null, branchName: 'dev/ada-1',
  });
  assert.equal(untitled.subject, 'dev/ada-1', 'the same fallback ladder as session_done');

  const agent = await lines({
    kind: 'session_stalled', sourceUsername: null, sessionTitle: 'Kanban filters', agentSessionId: 9,
  });
  assert.equal(agent.label, 'The coding agent stopped before finishing');

  const view = (await load())({ ...ROW, kind: 'session_stalled', sourceUsername: null });
  assert.notEqual(view.icon, (await load())({ ...ROW, kind: 'session_done' }).icon,
    'it does not wear the finished row\'s check mark');
});

test('a conversation row is named by its thread, not by the surface', async () => {
  // The only label that is not a fixed category: a message's kind IS its
  // thread. "Message" over the snippet would name the surface, and the meta
  // line already says Messages.
  const msg = await lines({
    kind: 'conversation_message', appName: null, conversationId: 7,
    conversationTitle: 'Design chat', messageContent: 'are you around?',
  });
  assert.equal(msg.label, 'Design chat');
  assert.equal(msg.subject, 'are you around?');
  assert.equal(msg.meta, 'Messages · by @ada · 4m ago');
  assert.ok(!msg.meta.includes('Design chat'),
    'and the thread is not repeated under itself');
});

test('a direct message is headed by who sent it, not by "Messages" (QA 2026-09-24 Q33a)', async () => {
  // A direct conversation has no title of its own (the column is NULL), so a
  // DM's row read "Messages" over the snippet — the surface, which the meta
  // line already names — and a request's "Invite" row named nobody.
  const msg = await lines({
    kind: 'conversation_message', appName: null, conversationId: 7, conversationKind: 'direct',
    conversationTitle: null, messageContent: 'are you around?',
  });
  assert.equal(msg.label, '@ada');
  assert.equal(msg.subject, 'are you around?');
  const invite = await lines({
    kind: 'conversation_invite', appName: null, conversationId: 7, conversationKind: 'direct',
    conversationTitle: null,
  });
  assert.equal(invite.label, 'Invite');
  assert.equal(invite.subject, '@ada');
  // With no sender to name, the row still has a heading.
  const anonymous = await lines({
    kind: 'conversation_message', appName: null, conversationId: 7, conversationKind: 'direct',
    conversationTitle: null, sourceUsername: null, messageContent: 'hi',
  });
  assert.equal(anonymous.label, 'Messages');
});

test('the three conversation verbs lost their trailing preposition', async () => {
  // They read "Mentioned you in <conversation>" across one line. Broken in
  // two, "Mentioned you in" sits alone above its object — a sentence cut in
  // half, when the line below it is plainly what it is in.
  for (const [kind, label] of [
    ['conversation_mention', 'Mentioned you'],
    ['conversation_reply', 'Replied'],
    ['conversation_reaction', 'Reacted'],
  ]) {
    const l = await lines({
      kind, appName: null, conversationId: 7, conversationTitle: 'Design chat',
    });
    assert.equal(l.label, label);
    assert.equal(l.subject, 'Design chat', 'the thread is the subject');
  }
});

// ─── 2. Nothing to name means two lines, not a blank one ────────────────

test('a deletion attempt names the app under the row and the person on the row (#2161)', async () => {
  const l = await lines({ kind: 'app_delete_attempted' });
  assert.equal(l.label, 'Tried to delete this shared app');
  assert.equal(l.subject, '', 'the app is the meta line\u2019s job');
  assert.equal(l.meta, 'Notes · by @ada · 4m ago');
  const gone = await lines({ kind: 'app_deleted', appName: null, appSlug: null, detail: 'Notes' });
  assert.equal(gone.meta, 'Account · by @ada · 4m ago', 'no app row is left to name');
});

test('a kind that is entirely its own label carries no subject', async () => {
  for (const kind of ['collab_invite', 'collab_invite_accepted',
    'approver_invite', 'approver_invite_accepted']) {
    const view = (await load())({ ...ROW, kind });
    assert.equal(view.segments.length, 0, `${kind} has nothing else to name`);
    assert.ok(view.label, `${kind} still says what it is`);
  }
  // Same for an agent question with no session title to point at.
  const asked = (await load())({ ...ROW, kind: 'agent_awaiting_input', sourceUsername: null });
  assert.equal(asked.segments.length, 0);
  assert.equal(asked.label, 'Claude asked you something');
});

test('no row can reach the renderer with an empty kind line', async () => {
  // `base.label` is '' and every branch overwrites it; a fall-through would
  // render a blank first line rather than fail, which is the kind of thing
  // that ships.
  const kinds = ['pr_proposed', 'stale_pr', 'check_failed', 'kudos', 'reaction',
    'session_done', 'session_stalled', 'auto_solve_done', 'spec_shared', 'connector_submitted',
    'agent_awaiting_input', 'collab_invite', 'approver_invite', 'mention',
    'reply', 'openrouter_key_created', 'openrouter_key_review',
    'conversation_message', 'conversation_invite', 'conversation_mention',
    'conversation_reply', 'conversation_reaction', 'app_delete_attempted', 'app_deleted',
    'platform_limit', 'something_unheard_of'];
  for (const kind of kinds) {
    const view = (await load())({ ...ROW, kind });
    assert.equal(typeof view.label, 'string', `${kind} has a label`);
    assert.ok(view.label.length > 0, `${kind} has a NON-EMPTY label`);
  }
});

test('OpenRouter key rows name the provider, owner, and no false actor', async () => {
  // `sourceUsername` there is WHOSE key it is, not who did something, so
  // "by @them" would be a false claim — it stays on the subject line.
  const review = await lines({ kind: 'openrouter_key_review', sourceUsername: 'grace' });
  assert.equal(review.label, 'OpenRouter key needs admin review');
  assert.equal(review.subject, '@grace');
  assert.equal(review.meta, 'Admin · 4m ago', 'no by-line');

  // Existing successful-issuance rows remain understandable even though
  // successful provisioning no longer creates new ones.
  const legacy = await lines({ kind: 'openrouter_key_created', sourceUsername: 'grace' });
  assert.equal(legacy.label, 'OpenRouter access enabled');
  assert.equal(legacy.subject, '@grace');
  assert.equal(legacy.meta, 'Admin · 4m ago', 'no by-line');
});

test('platform limit rows say which cap, how full, and what happens next', async () => {
  // Full admins only and no app, so the meta line names Admin like the other
  // admin kinds, and nobody is credited with having done anything.
  const near = await lines({ kind: 'platform_limit', detail: 'apps_warn:40:50',
    appName: null, sourceUsername: null });
  assert.equal(near.label, 'Nearing the app limit');
  assert.match(near.subject, /^40 of 50 apps in use\. +Raise MAX_APPS before new apps are refused\.$/);
  assert.equal(near.meta, 'Admin · 4m ago');

  const full = await lines({ kind: 'platform_limit', detail: 'apps_full:50:50',
    appName: null, sourceUsername: null });
  assert.equal(full.label, 'App limit reached');
  assert.match(full.subject, /^50 of 50 apps in use\. +New apps are refused until MAX_APPS is raised/);

  const sessions = await lines({ kind: 'platform_limit', detail: 'sessions_warn:60:75',
    appName: null, sourceUsername: null });
  assert.equal(sessions.label, 'Nearing the session limit');
  assert.match(sessions.subject, /^60 of 75 coding sessions in use\./);

  const sessionsFull = await lines({ kind: 'platform_limit', detail: 'sessions_full:75:75',
    appName: null, sourceUsername: null });
  assert.equal(sessionsFull.label, 'Session limit reached');
  assert.match(sessionsFull.subject, /MAX_GLOBAL_SESSIONS/);

  // A token this build cannot read still says what kind of alert it is.
  const odd = await lines({ kind: 'platform_limit', detail: 'disk_warn:1:2',
    appName: null, sourceUsername: null });
  assert.equal(odd.label, 'Platform limit');
  assert.ok(odd.subject.length > 0);
});

// ─── 3. The renderer draws them in that order ───────────────────────────

test('ScreenRow renders kind, subject, meta — in that order', () => {
  const row = SHEET.slice(SHEET.indexOf('function ScreenRow('));
  const body = row.slice(0, row.indexOf('\n}'));
  const kindAt = body.indexOf('{view.label}');
  const subjectAt = body.indexOf('view.segments.length ? view.segments.map');
  const metaAt = body.indexOf('view.appLine');
  assert.ok(kindAt > -1 && subjectAt > -1 && metaAt > -1, 'all three lines are drawn');
  assert.ok(kindAt < subjectAt && subjectAt < metaAt,
    'kind over subject over meta');
  // The kind line is CONDITIONAL and the subject line falls back to it, which
  // is the two-line shape above.
  assert.match(body, /\{view\.segments\.length \? \(\s*<span[^>]*>\s*\{view\.label\}/,
    'the kind line only renders when there is a subject under it');
  assert.match(body, /\)\) : view\.label\}/,
    'and the label takes the subject line when there is not');
});

test('the three lines are visually ranked, not three of the same thing', () => {
  const row = SHEET.slice(SHEET.indexOf('function ScreenRow('));
  const body = row.slice(0, row.indexOf('\n}'));

  // The SIZES moved onto the Improve rail's scale (text-xs / text-sm) when the
  // sheet stopped running a bespoke 13-22px ramp beside a panel running
  // Tailwind's — see the type block in the sheet's header. The RANKING is what
  // this test is about and it is unchanged: the subject is the only line that
  // is both larger and heavier than the two around it.
  assert.match(body, /block text-xs text-zinc-500 dark:text-zinc-400 truncate/,
    'the kind line is subordinate, in the muted ink');
  assert.match(body, /block text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate/,
    'the subject carries the strong ink and the larger size');
  assert.match(body, /block text-xs text-zinc-500 truncate/,
    'the meta line stays small and regular');

  // Stated as a relationship too, so a future scale change has to keep the
  // RANK rather than merely keep three literals that happen to differ.
  //
  // Read off the three line spans specifically — `block text-…` — and nothing
  // else in the row. An earlier cut of this scanned the whole body and matched
  // the count badge, whose classes are a multi-line concatenation carrying
  // both `font-semibold` and a muted `text-zinc-500` in different branches of
  // a ternary. The badge is not one of the three lines and has no rank here.
  const lines = (body.match(/block text-\S+[^"']*/g) || [])
    .filter((c) => c.includes('truncate'));
  assert.equal(lines.length, 3, 'exactly three ranked lines');
  const strong = lines.filter((c) => /font-semibold/.test(c));
  assert.equal(strong.length, 1, 'exactly one line carries the strong weight');
  assert.match(strong[0], /text-zinc-900/, 'and it is the one in the strong ink');
  const size = (c) => /block (text-\S+)/.exec(c)[1];
  assert.ok(lines.filter((c) => size(c) === size(strong[0])).length === 1,
    'the subject must not share its size with the lines it outranks');

  // Each line truncates on its own, so a long subject cannot push the app
  // name or the time off the row.
  // Counted on the class strings themselves (`truncate"`), since the prose
  // beside them says the word too.
  assert.equal((body.match(/truncate"/g) || []).length, 3, 'all three truncate');
});

test('a push test has clear account-level copy without inventing a completed session', async () => {
  const row = (await load())({ ...ROW, kind: 'test_alert', appName: null, appSlug: null, sessionId: null });
  assert.equal(row.label, 'Homeroom test alert');
  assert.equal(row.appLine, '');
  assert.match(row.segments[0].v, /You requested a push notification test/);
});
