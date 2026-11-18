'use strict';

// The I/O of a proposal's before/after shots: building the exact before
// (base) and after (head) copies with fixture data and signed-in fixture
// users, the shots agent's turn (it follows each declared change on both and
// saves what it sees through the run's control plane, services/shots-control),
// comparing the two sides, and removing the copies. The shots machine
// (src/workflow/shots/) runs each as a work item and decides everything
// between them; a shots eval's trial runs the same steps as the shots-eval
// machine's work (src/workflow/shots-eval/), on the trial's attempt id.

const appManifest = require('./app-manifest');
const fs = require('node:fs/promises');
const os = require('node:os');
const github = require('./github');
const log = require('./logger');
const shotsDiff = require('./shots-diff-worker');
const shotsFiles = require('./shots-files');
const shotsDensity = require('./shots-density');
const logRedaction = require('./log-redaction');
const shotsAgent = require('./shots-agent');
const shotsControl = require('./shots-control');
const shotsHomeTile = require('./shots-home-tile');
const shotsStarter = require('./shots-starter');
const environment = require('./shots-environment');
const identities = require('./shots-identities');
const planContract = require('./visible-changes');
const previewClock = require('./preview-clock');
const state = require('./shots-state');
const turnLifecycle = require('./turn-lifecycle');
const { isFrontendFile, isUiAffecting: uiFileHeuristic } = require('./visual-file-classifier');
const worker = require('./worker');
const { SAMPLE_FILES } = require('../../worker/shots-samples');


// How the worker saw the shots agent's process end when the agent never
// reported it (shots-agent.js EXIT_CAUSES), for the causes that say nothing
// about the proposal: memory ran out, or the container or the turn's
// processes vanished. `probe_unobservable` is left out: the turn may still
// be running. The run dispatches the agent once more for these, when at
// least MIN_AGENT_RETRY_MS of its budget is left.
const RETRYABLE_AGENT_EXITS = new Set(['oom_killed', 'container_gone', 'turn_process_gone']);
const MIN_AGENT_RETRY_MS = 60_000;

function agentDiedRetryable(error) {
  return !!error && error.code === 'shots_agent_failed'
    && RETRYABLE_AGENT_EXITS.has(error.shotsExitCause);
}

// #4575: the dispatch never started because another turn (the Homeroom
// bot's, a person's) took the proposal's agent while the copies were
// building: the worker refused a second turn, or the session's one-turn
// record was already held. Nothing ran, so the run waits for the agent to
// be free and dispatches again, at most MAX_AGENT_BUSY_RETRIES times.
const MAX_AGENT_BUSY_RETRIES = 2;

function agentBusyRetryable(error) {
  if (!error) return false;
  if (error.sessionBusy === true || error.persistCode === 'session_busy') return true;
  return state.agentBusyCode(error.code);
}

// A run that failed on a platform step that says nothing about the proposal,
// by its kind, so the recovery sweep takes the same head again once
// (shots-state PLATFORM_RETRY_TRIGGER). Read off the error, never off its
// wording: a database or clone step the platform runs for the copies tags
// its own error (shots-environment), GitHub's hourly limit and the shots
// agent's exit have their own codes, and the worker's bootstrap names its
// transient failures. Anything else, a revision that does not build
// included, is the proposal's and is not taken again.
const GITHUB_RESET_GRACE_MS = 60_000;
const GITHUB_UNKNOWN_RESET_WAIT_MS = 15 * 60_000;
const MAX_PLATFORM_RETRY_WAIT_MS = 65 * 60_000;

function platformFault(error, { now = Date.now() } = {}) {
  if (!error || typeof error !== 'object') return null;
  if (error.code === 'github_rate_limited') {
    // Taken again once the hour's budget has reset, not into the same wall.
    const resetMs = Number(error.retryAfterMs);
    const waitMs = Number.isFinite(resetMs) && resetMs > 0
      ? resetMs + GITHUB_RESET_GRACE_MS : GITHUB_UNKNOWN_RESET_WAIT_MS;
    return { kind: 'github_rate_limited', retryAt: now + Math.min(MAX_PLATFORM_RETRY_WAIT_MS, waitMs) };
  }
  if (error.code === 'shots_agent_failed') return { kind: 'agent_exit' };
  // #6598: GitHub did not answer when the worker tried to start. Taken again
  // once, a few minutes on, by the recovery sweep.
  if (error.code === 'github_unavailable') return { kind: 'github_unavailable', retryAt: now + 5 * 60_000 };
  if (state.PLATFORM_FAULT_KINDS.has(error.shotsPlatformFault)) return { kind: error.shotsPlatformFault };
  // The change's worker could not start (its volume, its image, no room on
  // any node, a setup that never finished): the platform's, never the
  // change's, so the run is taken again once.
  if (worker.isRetryableBootstrapError(error) || worker.isWorkerStartFailure(error)) return { kind: 'worker_bootstrap' };
  return null;
}

// How long the shots wait for the change's worker to start before they say
// it did not. Off the agent's own clock (its turn starts once the worker is
// up), and short enough that the agent's whole budget still fits inside the
// machine's deadline for the step (machine.ts AGENT_OVERDUE_MS, 15 minutes).
const WORKER_PREPARE_MAX_MS = 6 * 60_000;

const DIFF_CONTEXT_CHARS = 8_000;
const MAX_AGENT_EVENTS = 128;

function progressPhase(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.stage === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(event.stage)) {
    return event.stage;
  }
  // kpack reports container names and log lines. Persist only the phase name;
  // never put build output, fixture values, or internal origins in the view.
  if (typeof event.phase === 'string') {
    const phase = event.phase.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 57);
    return phase ? `build_${phase}` : null;
  }
  return null;
}

class ShotsOrchestrationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ShotsOrchestrationError';
    this.code = code;
    this.detail = detail;
  }
}

function exactSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function headForSession(session, explicit = null) {
  return exactSha(explicit)
    || exactSha(session.imported_pr_head_sha)
    // Once a proposal is promoted, reviewed_head_sha is the authoritative
    // revision reviewers and votes describe. A native handoff pin can lag it
    // after a same-proposal update, so it must not win merely because it was
    // written earlier in the lifecycle.
    || exactSha(session.reviewed_head_sha)
    || exactSha(session.checks_commit_sha)
    || exactSha(session.handoff_head_sha)
    || exactSha(session.staging_commit_sha)
    || null;
}

function intentForSession(session) {
  const detail = session?.shots_detail;
  return detail && typeof detail === 'object' && detail.intent
    ? planContract.parseIntent(detail.intent)
    : null;
}

function publicSessionAndApp(row) {
  return {
    session: row,
    app: {
      id: row.app_id,
      slug: row.app_slug,
      name: row.app_name,
      repo_url: row.repo_url,
      manifest_snapshot: row.manifest_snapshot,
    },
  };
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.manifest_snapshot
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows[0]) throw new ShotsOrchestrationError('session_not_found', 'Proposal session not found.');
  return rows[0];
}

// A platform pair boots both revisions from empty databases their own code
// fills, and code from before that cannot (platform-preview-data-policy.js
// startsEmpty). A change's recorded base never moves, even once the change is
// updated with main, so a base from before then is replaced by where its head
// meets main, as for a change with no recorded base. A head that still
// predates it meets main before it too, and the pair is refused as it was.
async function recordedBaseCannotBoot(session, { owner, repo, sha }, githubService) {
  const previewPolicy = require('./platform-preview-data-policy');
  if (!session.app_slug || !previewPolicy.sourceIdentity(require('./db-manager').appDbName(session.app_slug))) return false;
  return !previewPolicy.bootFileStartsEmpty(await githubService.getFileContent(owner, repo, previewPolicy.BOOT_FILE, sha));
}

// `baseSha` pins the before revision instead of resolving it: a shots eval's
// trial (the shots-eval machine) shoots the revisions its proposal's own run
// shot.
async function resolveRevisionContext(session, explicitHead = null, githubService = github, { baseSha: explicitBase = null } = {}) {
  const headSha = headForSession(session, explicitHead);
  if (!headSha) {
    throw new ShotsOrchestrationError(
      'missing_shots_head',
      'The before/after shots cannot start until the proposal has an exact submitted commit.'
    );
  }
  const { owner, repo } = environment.repoParts(session.repo_url);
  let baseSha = exactSha(explicitBase) || exactSha(session.handoff_base_sha);
  if (!exactSha(explicitBase) && baseSha && await recordedBaseCannotBoot(session, { owner, repo, sha: baseSha }, githubService)) {
    baseSha = null;
  }
  let comparison = null;
  if (!baseSha) {
    const repository = await githubService.getRepoHead(owner, repo);
    comparison = await githubService.compareRefs(owner, repo, `${repository.defaultBranch}...${headSha}`);
    baseSha = exactSha(comparison.mergeBaseSha);
  }
  if (!baseSha) {
    throw new ShotsOrchestrationError(
      'missing_shots_base',
      'GitHub did not return an exact merge base for this proposal revision.'
    );
  }
  if (!comparison) {
    comparison = await githubService.compareRefs(owner, repo, `${baseSha}...${headSha}`);
  }
  let diffSummary = null;
  if (typeof githubService.getProposalDiff === 'function') {
    try {
      const summary = await githubService.getProposalDiff(
        owner, repo, `${baseSha}...${headSha}`, DIFF_CONTEXT_CHARS
      );
      diffSummary = {
        text: String(summary?.diff || '').slice(0, DIFF_CONTEXT_CHARS),
        fileCount: Math.max(0, Number(summary?.fileCount) || 0),
        truncated: summary?.truncated === true,
      };
    } catch (error) {
      log.warn('shots', 'Could not load the bounded proposal diff for shots context', {
        owner, repo, headSha, error: error.message,
      });
    }
  }
  return {
    owner,
    repo,
    baseSha,
    headSha,
    files: comparison.files || [],
    filesComplete: comparison.filesComplete !== false,
    diffSummary,
  };
}

function shotsWords(value) {
  return new Set(String(value || '').toLowerCase().replace(/\+/g, ' plus ')
    .match(/[a-z0-9]{4,}/g) || []);
}

function testingPathsForSession(session) {
  const candidates = [session?.testing_path,
    ...(Array.isArray(session?.testing_paths) ? session.testing_paths.map((entry) =>
      typeof entry === 'string' ? entry : entry?.path) : [])];
  return [...new Set(candidates.filter((value) =>
    planContract.validRelativePath(value) && !planContract.credentialLike(value)))].slice(0, 8);
}

function declaredCheckSummary(checkout, intent = null, testingPaths = []) {
  try {
    const checks = appManifest.readTests(appManifest.read(checkout));
    // A large manifest's first 80 checks can omit the changed screen
    // entirely. Put checks whose names, paths, or readiness selectors match
    // the accepted story first; retain declaration order for equal scores.
    const storyText = (intent?.stories || []).map((story) => [
      story.claim, story.intent?.startPath, story.intent?.checkpoint,
      story.intent?.focus, ...(story.intent?.steps || []),
    ].join(' ')).join(' ');
    const words = shotsWords(storyText);
    const navigationWords = shotsWords((intent?.stories || []).map((story) => [
      story.intent?.startPath, ...(story.intent?.steps || []),
    ].join(' ')).join(' '));
    const intentPaths = new Set((intent?.stories || []).map((story) => story.intent?.startPath)
      .filter((value) => value && value !== '/'));
    const knownTestingPaths = new Set(testingPaths);
    const frequencies = new Map();
    const indexed = checks.map((test, index) => {
      const nameWords = shotsWords(test.name);
      const pathWords = shotsWords(test.path);
      const selectorWords = shotsWords(test.expectSelector);
      for (const word of new Set([...nameWords, ...pathWords, ...selectorWords])) {
        if (words.has(word)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
      }
      return { test, index, nameWords, pathWords, selectorWords };
    });
    const ranked = indexed.map(({ test, index, nameWords, pathWords, selectorWords }) => {
      // The proposal's recorded manual test route is already a concrete
      // navigation clue. Prefer its exact declared check over a word match
      // to a generic screen, while leaving the browser agent to verify it.
      let score = intentPaths.has(test.path) ? 1_000_000
        : knownTestingPaths.has(test.path) ? 500_000 : 0;
      for (const word of words) {
        const weight = Math.log2(1 + checks.length / (frequencies.get(word) || 1))
          * (navigationWords.has(word) ? 3 : 1);
        if (nameWords.has(word)) score += 3 * weight;
        if (pathWords.has(word)) score += 2 * weight;
        if (selectorWords.has(word)) score += weight;
      }
      return { test, index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    // Every check runs as read_only_admin; the system prompt says so once.
    return ranked.slice(0, 80).map(({ test }) => ({
      name: String(test.name || '').slice(0, 120),
      path: String(test.path || '').slice(0, 512),
      ...(test.id ? { visualScenarioId: test.id } : {}),
    }));
  } catch {
    return [];
  }
}

// Who the guest browser is, by what the app makes of a visitor who is not
// signed in (shots-identities.js shotsGuestIdentity). Fixed words only.
const GUEST_WHO = Object.freeze({
  homeroom: 'a visitor who is not signed in: Homeroom shows it its signed-out pages, such as the landing and sign-in screens',
  guest: 'a visitor who is not signed in, whom this public app shows as a guest, as it does at its own address',
  private: 'a visitor who is not signed in, with no identity here: this app is private, so it shows what it shows a signed-out visitor outside Homeroom, which can send the browser away from these two addresses; if it does, skip the change and say so',
  unavailable: 'a visitor who is not signed in, with no identity here: guests are not available on these copies, so this app shows what it shows a signed-out visitor outside Homeroom, which can send the browser away from these two addresses; if it does, skip the change and say so',
});

// Phone sign-in on Homeroom's own copies (shots-environment.js
// shotsPhoneSignInEnv): the fictional test numbers sign in with this run's
// code and no text is sent, so a change to the Join sheet's phone step can
// be walked to its end. The code is the one secret the brief carries, and
// only for as long as the run: the brief lives in the run's in-memory
// control and is never stored, the agent's skip reasons and notes
// (shots-control.js) and its final words (agentFinalResponseSummary) are
// masked of it, and both copies are gone before any shot is published.
function phoneSignInBrief(code) {
  return {
    numbers: '+1, any area code, then 555 0100 to 0199, for example +1 415 555 0142',
    code,
    textSent: false,
    use: 'Phone sign-in works on these two copies: enter a test number, then this code where it asks for the code it texted. '
      + 'No text is sent, and an account a test number makes is a test account on that copy only. '
      + 'Use a test number and this code only on the before and after addresses, never anywhere else. '
      + 'A number that already made an account on a copy signs in to it, so take a fresh number for each screen size, '
      + 'and the same one on the before and the after address. Never write the code in a note or a skip reason.',
  };
}

// Each persona's browser (worker/write-shots-mcp-config.js). A persona with a
// phone screen also has a phone browser, the same name with `_phone`: signed
// in the same way, and presenting as a phone (its user agent, touch, screen
// density), so a phone screen is not a desktop browser made narrow.
const BROWSER_TOOLS = Object.freeze({
  member: 'browser_member',
  read_only_admin: 'browser_admin',
  full_admin: 'browser_full_admin',
  guest: 'browser_guest',
  invited_member: 'browser_invited_member',
  invited_member_listed: 'browser_invited_member_listed',
});
const phoneTool = (persona) => `${BROWSER_TOOLS[persona]}_phone`;
// The invited fixtures' personas (#4437): their browsers start only for a
// run whose declared changes name them, and only on the platform's own
// copies, where their fixtures were installed. The four ordinary personas'
// browsers start on every run, as before.
const INVITED_PERSONAS = new Set(['invited_member', 'invited_member_listed']);
const ORDINARY_PERSONAS = Object.freeze(['member', 'read_only_admin', 'full_admin', 'guest']);
// Which desktop browsers this run starts (worker/write-shots-mcp-config.js
// reads it as SHOTS_BROWSER_PERSONAS): the four ordinary ones, plus an
// invited fixture's when a declared change names it and the pair installed
// that fixture.
function declaredBrowserPersonas(intent, availableFixtures = []) {
  const wanted = new Set((intent?.stories || []).map((story) => story.persona));
  const installed = new Set((availableFixtures || []).map((fixture) => fixture.persona));
  return [
    ...ORDINARY_PERSONAS,
    ...[...INVITED_PERSONAS].filter((persona) => wanted.has(persona) && installed.has(persona)),
  ];
}

// Which browser shoots each declared change's screens, by change id and
// screen name. The shots bridge reads it too, to find a screen's clip.
function screenBrowsers(intent) {
  return Object.fromEntries((intent?.stories || []).map((story) => [story.id,
    Object.fromEntries((story.viewports || []).map((viewport) => [viewport.name,
      planContract.phoneScreen(viewport) ? phoneTool(story.persona) : BROWSER_TOOLS[story.persona]]))]));
}

// Homeroom's install strip shows only in a phone browser, and every shots page
// opens with it dismissed (worker/shots-page-init.js); a page opened with this
// on its query shows it, for a change to the strip itself. Fixed words only.
const INSTALL_STRIP = Object.freeze({
  param: 'shots-install-strip=show',
  note: 'Homeroom\'s "Add it to your home screen" strip is dismissed on every page these browsers open. For a change to the strip itself, add param to the start path\'s query (before any #) on both addresses, in the phone browser.',
});

// What making a project does on Homeroom's own copies. Make it is accepted
// there (the copies lift the server-wide cap, shots-environment.js
// shotsCapacityEnv, and the personas get free app slots, shots-demo-states.js
// shots-demo-room-to-make-v1), but no copy can set a project up: it runs
// unreviewed code, so it gets no rights to create a database (its role owns
// only its own clone), no image builder or container runtime, and no
// GitHub. The setup stops at its first step, the database, and the screen
// after Make it says so; a remix stops the same way and an import is
// refused. Said up front so a change that needs a made project running is
// skipped at once with the copies' reason, rather than tried in every
// browser or reported as the change failing (PR 4777's ready-made Study
// timer, 2026-10-12). Fixed words only.
const MAKE_PROJECT = Object.freeze({
  setupFinishes: false,
  note: 'Make it on "What do you want to make?" (/#create) works on these copies for whoever has free app slots '
    + '(availableFixtures says who), and the screen after it shows the new project\'s card. But these copies cannot '
    + 'set a project up: they have no rights to create its database, no image builder and no GitHub. So within '
    + 'seconds the screen says "Setting it up didn’t finish" and "Setup stopped before it was running" with Try '
    + 'again, on both addresses alike, and Try again stops the same way. A remix stops the same way too, and '
    + 'importing a GitHub repository is refused. That is '
    + 'these copies, not the change failing: never use outcome "failed" for it. A change to the make screen, or '
    + 'to the screen after Make it, can be shot once the setup has stopped on both addresses; say in note_change '
    + 'what that leaves out. A change that needs a made project to run (its app open, its first version built, '
    + 'its repository) cannot be shown here: call skip_change for it at once, saying these copies cannot set up '
    + 'a new project, and do not try the other browsers. Each persona can make five projects an hour on each '
    + 'address, its phone browser included, so make one only where a change needs it, the same one on both '
    + 'addresses.',
});

// Who the signed-in browsers are to an app built on Homeroom. Its identity
// token says who is signed in ({ id, username, usernode_pubkey, locale }),
// never a role in the app: there is no creator or admin claim, and no
// platform call answers "is this the owner?". The two administrator
// personas are Homeroom's, which the app is never told, and none of the
// browsers is any of the app's own people. So a screen the app keeps for
// particular accounts refuses every browser on the copies. Three runs on
// one app's Creator Studio (QuestVerse's PRs 7 to 9) tried all three
// browsers before giving up; appRoles says so up front, so the agent skips
// such a change at once. Fixed words only.
const CHILD_APP_WHO = Object.freeze({
  member: 'an ordinary signed-in person with no role in this app',
  read_only_admin: 'a Homeroom administrator with read-only rights; this app is not told that, so it sees an ordinary signed-in person with no role in it',
  full_admin: 'a Homeroom administrator that exists only in these two throwaway copies; this app is not told that, so it sees an ordinary signed-in person with no role in it',
});
const CHILD_APP_ROLES = Object.freeze({
  heldByAnyBrowser: false,
  note: 'No browser here is this app\'s creator, owner or one of its admins: Homeroom tells an app who is '
    + 'signed in, never their role in it, and these copies sign in only fixture accounts, never the app\'s own '
    + 'people. So a screen the app keeps for particular accounts (its creator, an allowlist of '
    + 'usernames or ids, a page private to one account) refuses every browser here. When the after address '
    + 'refuses a browser that way, call skip_change for that change at once, saying the app keeps that screen '
    + 'for particular accounts, and do not try the other browsers. A role a signed-in person gets through the '
    + 'app itself is different: when hints.setup says how to get it, do that first.',
});

// The signed-in browsers are three different accounts, so a step somebody
// other than a change's persona takes (a reply to the member's message, a
// vote on their change) can be taken in another persona's browser. The
// shots of PR 4626's notification for a reply in a topic's thread were
// skipped because "producing one needs a second account to reply to my
// message, and I can't sign in as another account" (2026-10-09). On
// Homeroom's own copies the full admin is a member of Homeroom's own project
// (shots-fixtures.js installFullAdminFixture). Fixed words only.
function secondAccountBrief(selfApp) {
  return {
    personas: ['member', 'read_only_admin', 'full_admin'],
    note: 'The member, read_only_admin and full_admin browsers are three different signed-in accounts. When a '
      + 'change needs somebody other than its persona to act first (a reply to the member\'s message, a vote on '
      + 'their change, a friend request back), take that step in another of these browsers, the same way on the '
      + 'before and the after address, then shoot in the browser screenBrowsers names. '
      + (selfApp ? 'Here, use full_admin when you can: it is a member of Homeroom\'s own project on these copies. ' : '')
      + 'The guest browser is not signed in, so it cannot be that account.',
  };
}

// A project's first version (shots-starter.js): the before address is still
// the starter template's placeholder, which shows none of the declared
// changes. Before this, every before shot of such a proposal was that
// placeholder and the agent spent half its turn taking it (proposals 7608,
// 7871 and 7610, each with a note saying so). Fixed words only.
const AFTER_ONLY = Object.freeze({
  beforeIsStarter: true,
  note: 'This proposal builds the app\'s first real screens. The before address still shows only the starter '
    + 'template\'s placeholder screen, which has none of the declared changes, so there is no before to take: do not '
    + 'open the before address, and save only after shots (side "after"), plus an after clip for a motion change. '
    + 'save_shot refuses a before shot in this run. Do not call note_change to say the before side is a placeholder: '
    + 'the proposal already says the app is new.',
});

// What the shots agent reads first: the declared changes, the two
// addresses to shoot, which browser to use for whom, and background it may
// use to find the screens. Everything from the proposal is marked untrusted.
// `childApp` is an app built on Homeroom rather than Homeroom itself.
// `afterOnly` is a project's first version: only the after side is taken.
// How long the brief may be, in characters of JSON (20 Oct 2026). Claude
// Code saves an MCP result over about 50,000 characters to a file and shows
// the model its first 2,000, and a shots turn has no tool that reads files:
// proposal 10613's 55 KB brief left its agent with the preview and no shots.
// Everything the agent acts on goes in whole; the reference lists (the
// declared checks, the diff, the changed files) fill the room left, best
// first, each saying when some of it was left out.
const BRIEF_BUDGET = 30_000;
// Each list's first share of that room. What one does not need goes to the
// others, in this order.
const REFERENCE_SHARES = Object.freeze({ declaredChecks: 0.45, diff: 0.3, changedFiles: 0.25 });
// Room kept for the fields that say what was left out.
const LEFT_OUT_FIELDS = 64;

const jsonLength = (value) => JSON.stringify(value).length;

// How many of `items`, from the first, fit in `room` characters of JSON.
function itemsThatFit(items, room) {
  let size = 2;
  let count = 0;
  for (const item of items) {
    const next = size + jsonLength(item) + (count ? 1 : 0);
    if (next > room) break;
    size = next;
    count += 1;
  }
  return count;
}

// The longest start of `text` that fits in `room` characters of JSON.
function textThatFits(text, room) {
  if (jsonLength(text) <= room) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonLength(text.slice(0, middle)) <= room) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

// The brief within BRIEF_BUDGET. Declared changes that alone fill it first
// shorten the author's testing steps and then the specification, so even
// three changes of 40 steps each stay well under the save-to-file limit.
function fitBrief(brief, budget = BRIEF_BUDGET) {
  const checks = brief.declaredChecks;
  const files = brief.changedFiles.items;
  const diff = brief.changeContext.diff;
  const text = diff?.text || '';
  const skeleton = {
    ...brief,
    declaredChecks: [],
    changedFiles: { ...brief.changedFiles, items: [] },
    changeContext: { ...brief.changeContext, ...(diff ? { diff: { ...diff, text: '' } } : {}) },
  };
  for (const field of ['testingSteps', 'specification']) {
    const over = jsonLength(skeleton) + LEFT_OUT_FIELDS - budget;
    const value = skeleton.changeContext[field];
    if (over > 0 && value) {
      skeleton.changeContext[field] = textThatFits(value, Math.max(0, jsonLength(value) - over)) || null;
    }
  }
  const room = Math.max(0, budget - jsonLength(skeleton) - LEFT_OUT_FIELDS);
  const want = { declaredChecks: jsonLength(checks), diff: jsonLength(text), changedFiles: jsonLength(files) };
  const give = {};
  for (const [key, share] of Object.entries(REFERENCE_SHARES)) give[key] = Math.min(want[key], Math.floor(room * share));
  let spare = room - Object.values(give).reduce((sum, value) => sum + value, 0);
  for (const key of Object.keys(REFERENCE_SHARES)) {
    const more = Math.min(spare, want[key] - give[key]);
    give[key] += more;
    spare -= more;
  }
  const shownChecks = itemsThatFit(checks, give.declaredChecks);
  const shownFiles = itemsThatFit(files, give.changedFiles);
  const shownText = textThatFits(text, give.diff);
  return {
    ...skeleton,
    declaredChecks: checks.slice(0, shownChecks),
    ...(shownChecks < checks.length ? { declaredChecksLeftOut: checks.length - shownChecks } : {}),
    changedFiles: {
      ...brief.changedFiles,
      items: files.slice(0, shownFiles),
      complete: brief.changedFiles.complete && shownFiles === files.length,
    },
    changeContext: {
      ...skeleton.changeContext,
      ...(diff ? { diff: { ...diff, text: shownText, truncated: diff.truncated || shownText.length < text.length } } : {}),
    },
  };
}

function shotsBrief({
  run, session, revision, pair, deployment, intent, guestKind = null, homeTile = null, selfApp = false,
  childApp = false, afterOnly = false, declaredChecks = null,
}) {
  const testingPaths = testingPathsForSession(session);
  const phones = new Set(planContract.phonePersonas(intent));
  const invitedInstalled = new Set((deployment.availableFixtures || [])
    .map((fixture) => (INVITED_PERSONAS.has(fixture?.persona) ? fixture.persona : null))
    .filter(Boolean));
  const browser = (persona, who) => ({
    tool: BROWSER_TOOLS[persona],
    ...(phones.has(persona) ? { phoneTool: phoneTool(persona) } : {}),
    who,
  });
  // A change that only shows at certain times declares the moment to see it
  // at (services/preview-clock.js). Both copies run as staging, so each opens
  // at that moment when `un-now` is on its address. Parsed to a fixed shape
  // here, so nothing the author wrote reaches the agent as free text.
  const moment = previewClock.forSession(session);
  // The screens' own files first: they say most about where a change shows.
  const files = [...revision.files.filter(isFrontendFile), ...revision.files.filter((file) => !isFrontendFile(file))];
  return fitBrief({
    version: 2,
    runId: run.id,
    declaredChanges: intent.stories,
    addresses: { before: deployment.origins.base, after: deployment.origins.head },
    // Kept for the bridge's hosted-app catalog check, which keys on base/head.
    origins: deployment.origins,
    revisions: {
      before: revision.baseSha.slice(0, 12),
      after: revision.headSha.slice(0, 12),
    },
    browsers: {
      member: browser('member', childApp ? CHILD_APP_WHO.member : 'an ordinary member'),
      read_only_admin: browser('read_only_admin',
        childApp ? CHILD_APP_WHO.read_only_admin : 'an administrator with read-only rights'),
      full_admin: browser('full_admin', childApp ? CHILD_APP_WHO.full_admin
        : 'a full administrator that exists only in these two throwaway copies'),
      guest: browser('guest', GUEST_WHO[guestKind] || 'a visitor who is not signed in'),
      // The invited fixtures' browsers, only when this pair installed them
      // (#4437). They are Homeroom's own fixture people, so a child app's
      // brief never carries them.
      ...(invitedInstalled.has('invited_member') ? {
        invited_member: browser('invited_member',
          'a private member without platform access whom an invite let in, who has not been Home yet; '
          + 'the fixture exists only in these two throwaway copies'),
      } : {}),
      ...(invitedInstalled.has('invited_member_listed') ? {
        invited_member_listed: browser('invited_member_listed',
          'the same kind of private member, but one who has been Home and is on the platform waitlist; '
          + 'the fixture exists only in these two throwaway copies'),
      } : {}),
    },
    screenBrowsers: screenBrowsers(intent),
    secondAccount: secondAccountBrief(selfApp),
    ...(childApp ? { appRoles: { ...CHILD_APP_ROLES } } : {}),
    ...(afterOnly ? { afterOnly: { ...AFTER_ONLY } } : {}),
    changedFiles: {
      items: files.slice(0, 200),
      complete: revision.filesComplete && revision.files.length <= 200,
      totalKnown: revision.files.length,
    },
    changeContext: {
      title: String(session.pr_title || '').trim().slice(0, 256) || null,
      specification: String(session.spec_md || '').trim().slice(0, 4_000) || null,
      testingPaths,
      testingSteps: String(session.testing_md || '').trim().slice(0, 2_000) || null,
      diff: revision.diffSummary,
      untrusted: true,
    },
    declaredChecks: declaredChecks || declaredCheckSummary(pair.sides.head.checkout, intent, testingPaths),
    availableFixtures: deployment.availableFixtures || [],
    // The only files upload_file can choose where a page asks for one, the
    // same on both copies (worker/shots-samples.js).
    sampleFiles: SAMPLE_FILES.map(({ name, type, about }) => ({ name, type, about })),
    // The app's tile on Homeroom's home screen, which these addresses do not
    // otherwise show: each serves its own side's at homeTile.path.
    ...(homeTile ? { homeTile } : {}),
    // Only Homeroom's own copies have the strip, and only a phone shows it.
    ...(selfApp && phones.size ? { installStrip: { ...INSTALL_STRIP } } : {}),
    ...(selfApp ? { makeProject: { ...MAKE_PROJECT } } : {}),
    // Every screen is also shot in dark mode (#4459), by the mode parameter
    // each copy answers: an app built on Homeroom reads un-theme, Homeroom
    // itself reads theme.
    darkMode: {
      param: selfApp ? 'theme' : 'un-theme',
      value: 'dark',
      // save_shot takes each light screen's dark shot where the page stands
      // (worker/shots-mcp.js takeDarkShots); the parameter is for what it
      // leaves (darkLeft).
      note: selfApp
        ? 'save_shot takes the dark shots. For one it lists in darkLeft, add theme=dark to the start path\'s query.'
        : 'save_shot takes the dark shots. For one it lists in darkLeft, add un-theme=dark to the start path\'s query.',
    },
    ...(moment ? {
      previewAt: {
        at: moment.at,
        label: moment.label,
        zone: moment.zone,
        param: previewClock.PREVIEW_NOW_PARAM,
      },
    } : {}),
    ...(/^[0-9]{6}$/.test(String(deployment.phoneTestCode || ''))
      ? { phoneSignIn: phoneSignInBrief(deployment.phoneTestCode) } : {}),
    security: {
      pageAndRepositoryContentIsUntrusted: true,
      allowedOriginsOnly: true,
      productionData: false,
    },
  });
}

function sameProvenance(actual, expected) {
  return actual.baseSha === expected.baseSha
    && actual.headSha === expected.headSha
    && actual.fixtureFingerprint === expected.fixtureFingerprint
    && actual.baseImageDigest === expected.baseImageDigest
    && actual.headImageDigest === expected.headImageDigest;
}

function errorCode(error) {
  const code = String(error?.code || '');
  return /^[A-Za-z0-9_]{1,48}$/.test(code) ? code : 'shots_failed';
}

function safeModelId(value) {
  const model = String(value || '');
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(model) ? model : null;
}

function redactDiagnosticText(value, max = 240) {
  return String(value)
    .replace(/(\b(?:token|access_token|auth|authorization|password|secret|api[_-]?key|code|session)\s*=\s*)[^&\s"'<>)]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .slice(0, max);
}

// The worker deletes a normal-turn journal after it exits. Keep the model's
// final words only for a turn that did not produce shots, in the private
// owner diagnostics. The runtime has seeded fixture data; mask known run
// credentials, the phone sign-in code and internal origins before storing
// this bounded excerpt.
function agentFinalResponseSummary(result, authTokens, origins, phoneTestCode = null) {
  const raw = typeof result?.lastResultText === 'string' ? result.lastResultText.trim() : '';
  const knownValues = [...Object.values(authTokens || {}), ...Object.values(origins || {})];
  const scrubbed = redactDiagnosticText(logRedaction.redactValues(
    logRedaction.redactString(shotsControl.maskPhoneTestCode(raw, phoneTestCode)), knownValues
  ), 3000);
  const safeEnum = (value) => /^[a-z0-9_:-]{1,80}$/i.test(String(value || '')) ? String(value) : null;
  return {
    workerResultPresent: !!result && typeof result === 'object',
    characters: raw.length,
    excerpt: scrubbed || null,
    truncated: raw.length > 3000,
    resultSubtype: safeEnum(result?.resultSubtype),
    stopReason: safeEnum(result?.providerStopReason),
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    permissionDenialCount: Number.isInteger(result?.permissionDenialCount)
      ? result.permissionDenialCount : null,
    toolErrorCount: Number.isInteger(result?.toolErrorCount) ? result.toolErrorCount : null,
    responseTextBlockCount: Number.isInteger(result?.responseTextBlockCount)
      ? result.responseTextBlockCount : null,
    providerTurnCount: Number.isInteger(result?.providerTurnCount)
      ? result.providerTurnCount : null,
  };
}

function visibleError(error) {
  if (state.agentBusyCode(error?.code)) return state.AGENT_BUSY_REASON;
  const message = String(error?.message || 'The before/after shots could not be taken.').trim();
  return redactDiagnosticText(message, 2000) || 'The before/after shots could not be taken.';
}

function safeDiagnosticValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (depth >= 7) return '[nested detail omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => safeDiagnosticValue(item, depth + 1));
  }
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 24)
    .filter(([key]) => !/^(?:token|authorization|cookie|password|secret|payload|data)$/i.test(key))
    .map(([key, item]) => [key, safeDiagnosticValue(item, depth + 1)]));
}

// An error's own structured detail (a reset or sign-in step, validation
// issues), redacted and bounded for the owner-only diagnostics.
function boundedErrorDetail(error) {
  try {
    const value = error?.detail || (error?.issues ? { issues: error.issues } : null);
    if (value == null) return null;
    const serialized = JSON.stringify(safeDiagnosticValue(value));
    return serialized.length <= 16000
      ? JSON.parse(serialized)
      : { truncated: true, excerpt: serialized.slice(0, 8000) };
  } catch { return null; }
}

const AGENT_DIAGNOSTIC_KINDS = new Set([
  'worker_prepare_start', 'worker_prepare_end', 'backend_selected',
  'turn_start', 'turn_end', 'provider_dispatched', 'provider_init',
  'first_stream', 'first_output', 'provider_result', 'provider_notice', 'provider_usage',
  'context_result',
  'runner_phase', 'runner_result', 'runner_exit', 'resume_retry',
  'tool_start', 'tool_end', 'agent_deadline',
  'browser_call_start', 'browser_call_pending', 'browser_call_end', 'browser_server_exit',
  'auth_bootstrap', 'hosted_app_catalog', 'hosted_app_allowlist', 'demo_data',
  'document_request', 'document_response', 'controlled_failure_set', 'controlled_failure_hit',
  'sample_upload', 'closeup',
  'platform_asset', 'home_tile', 'legacy_tailwind_cdn', 'egress_blocked', 'worker_memory',
  'provider_request_start', 'provider_request_pending', 'provider_response_headers',
  'provider_response_first_byte', 'provider_request_end',
  'worker_stop_requested', 'worker_stop_returned',
]);
const AGENT_DIAGNOSTIC_PHASES = new Set([
  'refresh', 'shots_proxy', 'shots_browser_bootstrap',
  'shots_mcp_ready', 'claude', 'agent', 'done',
]);
const AGENT_DIAGNOSTIC_TOOLS = new Set([
  'get_brief', 'save_shot', 'save_clip', 'skip_change', 'note_change', 'note_problem', 'fail_request',
  'control_request', 'upload_file',
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close', 'other',
]);

// When the agent's startup reached each step, first time only, from the run's
// start. The event list keeps the last MAX_AGENT_EVENTS, so on a long run the
// startup (worker, provider, sign-ins, the first tool) would otherwise be gone
// from the trace by the time anyone reads it.
const AGENT_STARTUP_KINDS = new Set([
  'worker_prepare_start', 'worker_prepare_end', 'auth_bootstrap', 'provider_init',
  'provider_dispatched', 'first_stream', 'first_output', 'tool_start', 'browser_call_start',
]);

function recordAgentDiagnostic(metrics, raw) {
  const kind = String(raw?.kind || '');
  if (!AGENT_DIAGNOSTIC_KINDS.has(kind)) return;
  // A sample every few seconds would push the agent's own events out of the
  // ring, so samples are kept as a summary instead.
  if (kind === 'worker_memory') { recordWorkerMemory(metrics, raw); return; }
  const activity = metrics.agentActivity;
  const event = { atMs: Math.max(0, Date.now() - metrics.startedAtMs), kind };
  if (AGENT_STARTUP_KINDS.has(kind) && activity.firstAtMs[kind] == null) {
    activity.firstAtMs[kind] = event.atMs;
  }
  if (raw.backend === 'claude_code' || raw.backend === 'codex_openrouter') {
    event.backend = raw.backend;
  }
  if (raw.requestMode === 'agent_new' || raw.requestMode === 'agent_resume') {
    event.requestMode = raw.requestMode;
  }
  if (AGENT_DIAGNOSTIC_PHASES.has(raw.phase)) event.phase = raw.phase;
  if (['ok', 'error', 'tool_error', 'rpc_error', 'unparsed', 'server_exit',
    'loaded', 'invalid', 'request_error', 'invalid_catalog',
    'http_error', 'network_error', 'stream_error', 'cancelled', 'timeout', 'browser_gone'].includes(raw.outcome)) {
    event.outcome = raw.outcome;
  }
  for (const key of ['mcpServerCount', 'toolDefinitionCount', 'browserMemberToolCount',
    'browserAdminToolCount', 'browserFullAdminToolCount', 'browserGuestToolCount',
    'browserPhoneToolCount', 'storyCount', 'callOrdinal', 'headingCount',
    'buttonCount', 'linkCount', 'imageBlocks', 'exitCode', 'checkRank',
    'documentOrdinal', 'httpStatus', 'requestOrdinal', 'chunkCount', 'hitOrdinal',
    'count', 'catalogCount']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 1000) {
      event[key] = raw[key];
    }
  }
  if (Number.isSafeInteger(raw.responseCharacters) && raw.responseCharacters >= 0
      && raw.responseCharacters <= 1_000_000) {
    event.responseCharacters = raw.responseCharacters;
  }
  for (const key of ['durationMs', 'responseBytes', 'textChars', 'bodyBytes']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 10_000_000) {
      event[key] = raw[key];
    }
  }
  if (typeof raw.truncated === 'boolean') event.truncated = raw.truncated;
  // Whether the shots proxy attached the persona's identity to a hosted
  // app's page load (worker/shots-origin-proxy.js).
  if (kind === 'document_request' && typeof raw.identityAttached === 'boolean') {
    event.identityAttached = raw.identityAttached;
  }
  // And whether the proxy sent that page load on to the same address with
  // the persona's display token, as Homeroom's frame opens an app.
  if (kind === 'document_request' && raw.identityRedirect === true) event.identityRedirect = true;
  // Why the shots proxy refused a destination outside the pair, by reason
  // only (worker/shots-boundary.js): never which destination.
  if (kind === 'egress_blocked' && ['port', 'dns', 'private_address'].includes(raw.blockReason)) {
    event.blockReason = raw.blockReason;
    // And what kind of host it was, from fixed words: never the host.
    if (EGRESS_HOST_KINDS.has(raw.hostKind)) event.hostKind = raw.hostKind;
    const key = `${event.blockReason}:${event.hostKind || 'unknown'}`;
    activity.egressBlocked[key] = (activity.egressBlocked[key] || 0) + 1;
  }
  if (kind === 'controlled_failure_set' && typeof raw.enabled === 'boolean') {
    event.enabled = raw.enabled;
  }
  // Whether the shots proxy failed or held a controlled request.
  if ((kind === 'controlled_failure_set' || kind === 'controlled_failure_hit')
      && ['fail', 'hold', 'off'].includes(raw.mode)) {
    event.mode = raw.mode;
  }
  if (['timeout', 'network', 'browser_closed', 'locator_ambiguous', 'other'].includes(raw.errorClass)) {
    event.errorClass = raw.errorClass;
  }
  if (raw.signal === 'SIGTERM' || raw.signal === 'SIGINT') event.signal = raw.signal;
  if (['base', 'head', 'hosted', 'outside'].includes(raw.side)) event.side = raw.side;
  if (['member', 'admin', 'full_admin', 'guest', 'invited_member', 'invited_member_listed'].includes(raw.persona)) event.persona = raw.persona;
  // A call in the persona's phone browser rather than its desktop one.
  if (raw.phone === true) event.phone = true;
  if (['intent_start', 'declared_check', 'other'].includes(raw.routeHint)) {
    event.routeHint = raw.routeHint;
  }
  if (['await_headers', 'await_first_byte', 'streaming'].includes(raw.stage)) {
    event.stage = raw.stage;
  }
  for (const key of ['briefToolAvailable', 'saveShotToolAvailable', 'skipChangeToolAvailable']) {
    if (typeof raw[key] === 'boolean') event[key] = raw[key];
  }
  for (const key of ['jsonValid', 'declaredChangesPresent', 'addressesPresent', 'revisionsPresent']) {
    if (typeof raw[key] === 'boolean') event[key] = raw[key];
  }
  if (kind === 'auth_bootstrap') {
    for (const key of ['attempted', 'cookieAlreadyPresent', 'sessionCookieInstalled', 'sessionCookiePresent']) {
      if (typeof raw[key] === 'boolean') event[key] = raw[key];
    }
    if (Number.isInteger(raw.responseStatus) && raw.responseStatus >= 100 && raw.responseStatus <= 599) {
      event.responseStatus = raw.responseStatus;
    }
    // A failed sign-in says where it stopped and why, from fixed values
    // (worker/shots-browser-bootstrap.js failureEvent).
    if (['configure', 'launch', 'exchange', 'navigate', 'cookie', 'hosted_catalog',
      'storage_state', 'allowlist'].includes(raw.failureStage)) {
      event.failureStage = raw.failureStage;
    }
    if (/^[a-z_]{1,40}$/.test(String(raw.failureCode || ''))) event.failureCode = raw.failureCode;
  }
  for (const key of ['resultSubtype', 'providerStopReason']) {
    if (/^[a-z0-9_:-]{1,80}$/i.test(String(raw[key] || ''))) event[key] = raw[key];
  }
  if (kind === 'tool_start' || kind === 'tool_end'
      || kind === 'browser_call_start' || kind === 'browser_call_pending'
      || kind === 'browser_call_end') {
    event.tool = AGENT_DIAGNOSTIC_TOOLS.has(raw.tool) ? raw.tool : 'other';
    if (['member', 'admin', 'full_admin', 'guest', 'invited_member', 'invited_member_listed'].includes(raw.persona)) event.persona = raw.persona;
    if (['base', 'head', 'outside'].includes(raw.side)) event.side = raw.side;
    if (Number.isSafeInteger(raw.routeOrdinal) && raw.routeOrdinal > 0
        && raw.routeOrdinal <= 1000) event.routeOrdinal = raw.routeOrdinal;
    if (Number.isSafeInteger(raw.sequence) && raw.sequence > 0 && raw.sequence <= 100000) {
      event.sequence = raw.sequence;
    }
    if (kind === 'tool_start') {
      activity.toolCounts[event.tool] = (activity.toolCounts[event.tool] || 0) + 1;
    }
    if (kind === 'browser_call_start') {
      activity.browserCallCounts[event.tool] = (activity.browserCallCounts[event.tool] || 0) + 1;
    }
    if (event.sequence) {
      if (kind === 'tool_start') activity.pending.set(event.sequence, event);
      else activity.pending.delete(event.sequence);
    }
    if (event.callOrdinal && event.persona) {
      const key = `${event.persona}:${event.callOrdinal}`;
      if (kind === 'browser_call_start' || kind === 'browser_call_pending') {
        activity.browserPending.set(key, { ...activity.browserPending.get(key), ...event });
      } else if (kind === 'browser_call_end') {
        activity.browserPending.delete(key);
      }
    }
  }
  if (event.documentOrdinal && event.side) {
    const key = `${event.side}:${event.documentOrdinal}`;
    if (kind === 'document_request') activity.documentPending.set(key, event);
    else if (kind === 'document_response') activity.documentPending.delete(key);
  }
  if (event.requestOrdinal) {
    if (kind === 'provider_request_end') activity.providerPending.delete(event.requestOrdinal);
    else if (kind.startsWith('provider_request_') || kind.startsWith('provider_response_')) {
      activity.providerPending.set(event.requestOrdinal,
        { ...activity.providerPending.get(event.requestOrdinal), ...event });
    }
  }
  activity.counts[kind] = (activity.counts[kind] || 0) + 1;
  activity.events.push(event);
  if (activity.events.length > MAX_AGENT_EVENTS) activity.events.shift();
}

const EGRESS_HOST_KINDS = new Set(['pair_host', 'catalog_host', 'loopback', 'other']);
const MEMORY_CLASSES = Object.freeze(['browser', 'agent', 'mcp', 'proxy', 'other']);
const memoryMb = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 1_048_576 ? value : null);

// The worker's memory through the turn (worker/shots-memory.js): the limit,
// the highest use seen, the last sample (the one nearest a sudden death),
// the out-of-memory kills since the first sample, and the most each class of
// process held. Numbers only.
function recordWorkerMemory(metrics, raw) {
  const memory = metrics.workerMemory || (metrics.workerMemory = {
    samples: 0, limitMb: null, peakUsedMb: null, lastUsedMb: null, containerPeakMb: null,
    oomKillsAtStart: null, oomKills: null, peakRssMb: {}, peakBrowserProcesses: null, lastAtMs: null,
  });
  memory.samples += 1;
  memory.lastAtMs = Math.max(0, Date.now() - metrics.startedAtMs);
  const used = memoryMb(raw.usedMb);
  memory.lastUsedMb = used;
  if (used != null) memory.peakUsedMb = Math.max(memory.peakUsedMb ?? 0, used);
  if (memoryMb(raw.limitMb) != null) memory.limitMb = raw.limitMb;
  if (memoryMb(raw.peakMb) != null) memory.containerPeakMb = Math.max(memory.containerPeakMb ?? 0, raw.peakMb);
  if (Number.isSafeInteger(raw.oomKills) && raw.oomKills >= 0 && raw.oomKills <= 1_000_000) {
    if (memory.oomKillsAtStart == null) memory.oomKillsAtStart = raw.oomKills;
    memory.oomKills = raw.oomKills;
  }
  const rss = raw.rssMb && typeof raw.rssMb === 'object' ? raw.rssMb : {};
  for (const name of MEMORY_CLASSES) {
    if (memoryMb(rss[name]) != null) memory.peakRssMb[name] = Math.max(memory.peakRssMb[name] ?? 0, rss[name]);
  }
  if (Number.isSafeInteger(raw.browserProcesses) && raw.browserProcesses >= 0 && raw.browserProcesses <= 10_000) {
    memory.peakBrowserProcesses = Math.max(memory.peakBrowserProcesses ?? 0, raw.browserProcesses);
  }
}

function workerMemorySummary(memory) {
  const { oomKillsAtStart, oomKills, ...rest } = memory;
  return {
    ...rest,
    peakRssMb: { ...memory.peakRssMb },
    oomKillsDuringTurn: oomKills == null || oomKillsAtStart == null ? null : Math.max(0, oomKills - oomKillsAtStart),
  };
}

function newRunMetrics() {
  return {
    startedAtMs: Date.now(),
    timingsMs: {
      idleWait: 0,
      provisioning: 0,
      agentExploration: 0,
      artifactPersist: 0,
      cleanup: 0,
    },
    agentAttempts: 0,
    agentBusyRetries: 0,
    agentDispatches: [],
    agentFinalResponses: [],
    agentActivity: { events: [], counts: {}, toolCounts: {}, firstAtMs: {}, pending: new Map(),
      browserCallCounts: {}, browserPending: new Map(), documentPending: new Map(),
      providerPending: new Map(), egressBlocked: {}, budgetMs: null },
    workerMemory: null,
    agentFinalResponse: null,
    artifactBytes: 0,
    idleWait: null,
    dispatchIdleWait: null,
    tokenUsage: {},
  };
}

function addTiming(metrics, key, startedAtMs) {
  const elapsed = Math.max(0, Date.now() - startedAtMs);
  metrics.timingsMs[key] = Math.max(0, Number(metrics.timingsMs[key]) || 0) + elapsed;
  return elapsed;
}

// What a turn spent, added to the run's: the `usage` its dispatch worked out
// (shots-agent.turnUsage, also on a turn that failed or ran out of time),
// else read off its result, which is all a turn a restart followed has.
// Usage used to be read only off the live dispatch's own result, by keys that
// result does not all carry (its cost is `costUsd`, in dollars), so no run
// recorded what it cost.
function addAgentUsage(metrics, turn) {
  const usage = turn?.usage && typeof turn.usage === 'object' ? turn.usage
    : shotsAgent.turnUsage(turn?.result) || (turn?.result && typeof turn.result === 'object' ? turn.result : null);
  if (!usage) return;
  for (const key of [
    'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
    'outputTokens', 'reasoningOutputTokens', 'costCents', 'streamed',
  ]) {
    if (usage[key] == null) continue;
    const value = Number(usage[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    metrics.tokenUsage[key] = (metrics.tokenUsage[key] || 0) + value;
  }
}

function agentActivitySummary(metrics) {
  return {
    version: 1,
    budgetMs: metrics.agentActivity.budgetMs,
    counts: { ...metrics.agentActivity.counts },
    toolCounts: { ...metrics.agentActivity.toolCounts },
    browserCallCounts: { ...metrics.agentActivity.browserCallCounts },
    egressBlocked: { ...metrics.agentActivity.egressBlocked },
    firstAtMs: { ...metrics.agentActivity.firstAtMs },
    events: metrics.agentActivity.events.slice(-MAX_AGENT_EVENTS),
    pendingTools: [...metrics.agentActivity.pending.values()].slice(-8),
    pendingBrowserCalls: [...metrics.agentActivity.browserPending.values()].slice(-8),
    pendingDocumentRequests: [...metrics.agentActivity.documentPending.values()].slice(-8),
    pendingProviderRequests: [...metrics.agentActivity.providerPending.values()].slice(-8),
  };
}

function traceSummary(metrics, extra = {}) {
  return {
    ...extra,
    timingsMs: {
      ...metrics.timingsMs,
      total: Math.max(0, Date.now() - metrics.startedAtMs),
    },
    idleWait: metrics.idleWait,
    ...(metrics.dispatchIdleWait ? { dispatchIdleWait: metrics.dispatchIdleWait } : {}),
    agentAttempts: metrics.agentAttempts,
    ...(metrics.agentBusyRetries ? { agentBusyRetries: metrics.agentBusyRetries } : {}),
    agentDispatches: metrics.agentDispatches.slice(0, 8),
    ...(metrics.agentFinalResponses.length
      ? { agentFinalResponses: metrics.agentFinalResponses.slice(0, 8) } : {}),
    agentActivity: agentActivitySummary(metrics),
    ...(metrics.workerMemory ? { workerMemory: workerMemorySummary(metrics.workerMemory) } : {}),
    artifactBytes: metrics.artifactBytes,
    planSource: metrics.planSource || null,
    ...(metrics.afterOnly ? { afterOnly: true } : {}),
    ...(Object.keys(metrics.tokenUsage).length ? { tokenUsage: { ...metrics.tokenUsage } } : {}),
  };
}

// ── The run's I/O, one step at a time ───────────────────────────────────
//
// Each is a work item of the shots machine (src/workflow/shots/services.ts):
// safe to run again after a crash, which is what a retried item does, and
// keeping nothing in this process between steps. Their results are JSON;
// the machine decides on them.

// How long the agent's control plane stays open past the agent's own clock:
// a call the agent made just before its turn was stopped still lands.
const CONTROL_SLACK_MS = 60_000;

// Whether run `runId` is still the proposal's run under way, in one of
// `states` (its row's): a step of a run that ended stops instead of going on.
async function runCurrent(pool, runId, states) {
  const { rows } = await pool.query(
    `SELECT 1 FROM shot_runs r JOIN chat_sessions cs ON cs.id = r.session_id AND cs.shots_run_id = r.id
      WHERE r.id = $1 AND r.state = ANY($2::text[])`, [runId, states]);
  return rows.length > 0;
}

// The exact before revision of a head (shots.revision).
async function resolveRevision(pool, { sessionId, headSha }, githubService = github) {
  const row = await loadSession(pool, sessionId);
  const revision = await resolveRevisionContext(row, headSha, githubService);
  return { baseSha: revision.baseSha, headSha: revision.headSha };
}

// Remove everything the copies of run `runId` may have left: both runtimes
// and databases, the hosted fixture, the clone source. By the run's own
// names, so it finds what a process that died left.
function removeCopies(config, { runId, appSlug }) {
  return require('./shots-gc').cleanupRunResources(config, { id: runId, app_slug: appSlug });
}

/**
 * The before and after copies of a run, serving and seeded, with the
 * agent's workspace written for them (shots.copies). `images`: both sides'
 * images an earlier attempt already built, reused; `onImages` hears them
 * once built (the machine's checkpoint). `fresh`: nothing of this run's
 * copies can exist yet; otherwise what an earlier attempt left is removed
 * first, so the copies are made from the start. The local checkouts go
 * before it returns; the copies stay for the agent. `current`: whether the
 * run is still under way, asked between phases; once it is not, the copies
 * stop there and it resolves `{ stale: true }` (what they made is the
 * run's cleanup's to remove).
 */
async function buildCopies(config, pool, {
  runId, sessionId, kind = 'run', intent: rawIntent, baseSha, headSha, budgetMs,
  images = null, onImages = null, onProgress = null, fresh = true, current = null,
}, injected = {}) {
  const deps = {
    environment: injected.environment || environment,
    identities: injected.identities || identities,
    shotsStarter: injected.shotsStarter || shotsStarter,
    shotsHomeTile: injected.shotsHomeTile || shotsHomeTile,
    github: injected.github || github,
    removeCopies: injected.removeCopies || removeCopies,
    shotsDensity: injected.shotsDensity || shotsDensity,
  };
  const row = await loadSession(pool, sessionId);
  const { session, app } = publicSessionAndApp(row);
  const intent = planContract.parseIntent(rawIntent);
  const revision = await resolveRevisionContext(session, headSha, deps.github, { baseSha });
  const run = { id: runId, base_sha: revision.baseSha, head_sha: revision.headSha, intent };
  const ended = async () => typeof current === 'function' && !(await current());
  if (await ended()) return { stale: true };
  if (!fresh) {
    const left = await deps.removeCopies(config, { runId, appSlug: app.slug });
    if (left.length) {
      throw Object.assign(new ShotsOrchestrationError('shots_copies_left',
        'What an earlier attempt left of these copies could not be removed.'), { shotsPlatformFault: 'database' });
    }
  }
  const pair = await deps.environment.preparePair(config, { pool, run, session, app, onProgress, images, onImages });
  try {
    if (await ended()) return { stale: true };
    const exploration = await deps.environment.resetPair(config, pair, { onProgress });
    const expectedProvenance = {
      baseSha: run.base_sha,
      headSha: run.head_sha,
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    };
    if (!sameProvenance(exploration, expectedProvenance)) {
      throw new ShotsOrchestrationError('shots_provenance_mismatch', 'The before and after builds did not match their fixture and images.');
    }
    const selfApp = app.slug === config.selfAppSlug;
    const guest = await deps.identities.shotsGuestIdentity(pool, app, { selfApp });
    // Each side's tile on Homeroom's home screen, from its own dapp.json. A
    // tile that cannot be drawn leaves the brief without one; it never stops
    // the run.
    let homeTiles = null;
    try { homeTiles = await deps.shotsHomeTile.tilesForPair(pair, app); }
    catch (error) {
      log.warn('shots', 'Could not draw the home tiles for a shots run', { sessionId, runId, error: error.message });
    }
    // A project's first version: its before build is still the starter
    // template's placeholder, read from the two checkouts' own sentinel
    // (shots-starter.js), so only the after side is taken and published.
    // Homeroom itself never ships the starter. A read that fails takes both
    // sides, as every run did before.
    let afterOnly = false;
    if (!selfApp) {
      try { afterOnly = await deps.shotsStarter.beforeIsStarter(pair); }
      catch (error) {
        log.warn('shots', 'Could not tell whether the before build is the starter', { sessionId, runId, error: error.message });
      }
    }
    // Ranked once: the brief shows as many as its budget has room for, and
    // the run's diagnostics rank a visit against all of them.
    const declaredChecks = declaredCheckSummary(pair.sides.head.checkout, intent, testingPathsForSession(session));
    const context = shotsBrief({
      run, session, revision, pair, deployment: exploration, intent,
      guestKind: guest.kind,
      homeTile: shotsHomeTile.briefEntry(homeTiles),
      selfApp,
      childApp: !selfApp,
      afterOnly,
      declaredChecks,
    });
    const agent = {
      origins: exploration.origins,
      phoneTestCode: exploration.phoneTestCode || null,
      navigationHints: {
        intentPaths: intent.stories.map((story) => story.intent.startPath),
        testingPaths: context.changeContext.testingPaths,
        declaredPaths: declaredChecks.map((check) => check.path),
      },
      recordClips: planContract.clipSize(intent) != null,
      // The desktop browsers record at the other motion screens' size and
      // the phone browsers at the phone motion screens' size, each its own.
      clipSize: planContract.clipSize(intent, { phone: false }),
      phoneClipSize: planContract.clipSize(intent, { phone: true }),
      phonePersonas: planContract.phonePersonas(intent),
      // The invited fixtures' desktop browsers start only when a declared
      // change names them and this pair installed their fixture
      // (declaredBrowserPersonas).
      browserPersonas: declaredBrowserPersonas(intent, exploration.availableFixtures),
      // A child app's pages load /usernode-bridge|native|tailwind/ from the
      // platform, which the edge routes in production; the shots browser's
      // proxy does the same. The platform serves its own.
      platformAssets: !selfApp,
      selfApp,
      // Experimental and off by default: stills at the screen's own density
      // (3x phone, 2x desktop) instead of 1x. Read once, so the whole run
      // takes one density (services/shots-density.js).
      deviceDensity: await deps.shotsDensity.enabledOrOff(pool),
    };
    if (await ended()) return { stale: true };
    await shotsControl.create(pool, {
      runId, sessionId, kind, intent, context, homeTiles, afterOnly, agent,
      expiresAt: Date.now() + (Number(budgetMs) || 480_000) + CONTROL_SLACK_MS,
    });
    return {
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
      afterOnly,
    };
  } finally {
    // The checkouts are this process's; the copies are the run's.
    if (pair.rootDir) await fs.rm(pair.rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

// What a dispatch error says, as the machine decides on it: another turn
// took the agent (`busy`), the agent's process died under it for a reason
// that says nothing about the proposal (`died`), it ran out of time, or it
// failed.
function agentErrorOf(error) {
  if (!error) return null;
  // A worker that never started says so, in words, not as the agent's
  // failure or its running out of time (18 Nov 2026: "The shots agent ran
  // out of time." for a worker whose disk volume could not be mounted).
  const workerStart = worker.workerStartReason(error);
  const code = workerStart ? 'shots_worker_failed' : errorCode(error);
  return {
    code,
    message: workerStart || visibleError(error),
    ...(workerStart ? { workerStart: true } : {}),
    busy: agentBusyRetryable(error),
    died: agentDiedRetryable(error),
    timedOut: code === 'shots_agent_timeout',
    ...(shotsAgent.EXIT_CAUSES.has(error?.shotsExitCause) ? { exitCause: error.shotsExitCause } : {}),
    ...(Number.isSafeInteger(error?.shotsExitCode) ? { exitCode: error.shotsExitCode } : {}),
    ...(platformFault(error) ? { platformFault: platformFault(error) } : {}),
  };
}

// The same for the worker's result of a turn a restart caught and the work
// followed to its end (durable-turn.js): it says how its process ended,
// never why in words.
function followedErrorOf(result) {
  if (!shotsAgent.failedResult(result)) return null;
  const exitCause = shotsAgent.EXIT_CAUSES.has(result?.markerlessCause) ? result.markerlessCause : null;
  const error = Object.assign(new ShotsOrchestrationError('shots_agent_failed',
    'The shots agent stopped with an error before it finished.'), { shotsExitCause: exitCause });
  return agentErrorOf(error);
}

// What a run adds up to once its agent's turn has ended: the summary of its
// workspace, without the bytes.
function verdictOf(summary) {
  const s = summary.summary;
  const reasons = [...new Set(s.stories.map((story) => story.reason).filter(Boolean))];
  return {
    passed: s.verdict.passed === true,
    readyCount: s.readyCount,
    failedCount: s.failedCount,
    verdict: s.verdict,
    manifestHash: s.manifestHash,
    slots: s.files.map((file) => shotsControl.dbSlot(file)),
    reasons,
    skippedAny: summary.skippedAny,
    counts: summary.counts,
    // A run that publishes nothing says why: each failed change's claim, or
    // what each skipped change lacked.
    failedReason: s.failedCount ? shotsFiles.failedReason(summary.intent, s.stories) : null,
    incompleteReason: reasons.join(' ').slice(0, 1800) || 'The shots agent did not save a before and after shot.',
    lastToolFailure: summary.lastToolFailure,
  };
}

/**
 * The shots agent's turn on run `runId`'s copies (shots.agent), as a
 * durable step on `steps` (services/durable-steps.js over the work item's
 * checkpoint): attached to the turn a restart caught, or started on what is
 * left of its clock (services/durable-turn.js). Resolves how the turn ended
 * and what the run's workspace adds up to, for the machine to decide on.
 */
async function dispatchAgent(config, pool, {
  runId, sessionId, budgetMs, steps = null, key = 'agent', onProgress = null, signal = null, current = null,
  // The shots machine's agent item (turn-lifecycle turnOwner): on the turn's
  // record, so the turn is that item's in every process.
  owner = null,
}, injected = {}) {
  const deps = {
    shotsAgent: injected.shotsAgent || shotsAgent,
    identities: injected.identities || identities,
    worker: injected.worker || worker,
    durableTurn: injected.durableTurn || require('./durable-turn'),
    durableSteps: injected.durableSteps || require('./durable-steps'),
  };
  const control = await shotsControl.read(pool, runId);
  if (!control?.agent) {
    throw new ShotsOrchestrationError('shots_control_not_found', 'The copies these shots were to be taken on are gone.');
  }
  const a = control.agent;
  const row = await loadSession(pool, sessionId);
  const { session, app } = publicSessionAndApp(row);
  const metrics = newRunMetrics();
  metrics.planSource = 'shots_agent';
  metrics.agentActivity.budgetMs = budgetMs;
  const guest = await deps.identities.shotsGuestIdentity(pool, app, { selfApp: a.selfApp === true });
  // The invited fixtures' tokens are minted only for a run that starts
  // their browsers: browserPersonas carries an invited persona only when
  // the pair installed its fixture, and only Homeroom's own copies can hold
  // a session for one.
  const invitedPersonas = Array.isArray(a.browserPersonas)
    ? a.browserPersonas.filter((persona) => INVITED_PERSONAS.has(persona)) : [];
  const authTokens = {
    ...await deps.identities.mintShotsAuthTokens(pool, app.id, { selfApp: a.selfApp === true }),
    ...(guest.token ? { guest: guest.token } : {}),
    ...(a.selfApp === true && invitedPersonas.length
      ? await deps.identities.mintInvitedTokens(app.id) : {}),
  };
  await shotsControl.extend(pool, runId, Date.now() + budgetMs + CONTROL_SLACK_MS);
  let progressAt = 0;
  const onShotsDiagnostic = (event) => {
    recordAgentDiagnostic(metrics, event);
    if (Date.now() - progressAt < 5000) return;
    progressAt = Date.now();
    shotsControl.noteProgress(pool, runId, { agentActivity: agentActivitySummary(metrics) }).catch(() => {});
  };
  const dispatchTrace = { requestedBackend: 'claude_code', requestedModel: safeModelId(shotsAgent.agentModel(config)), budgetMs };
  metrics.agentDispatches.push(dispatchTrace);
  metrics.agentAttempts += 1;
  // A run that ended (`signal`: its step was cancelled; `current`: its row
  // says so) starts no turn: a stop, so nothing is reported for it.
  const stopIfEnded = async () => {
    if (signal?.aborted || (typeof current === 'function' && !(await current()))) {
      throw new (require('./durable-steps').StepsStopped)('the shots run ended before its agent was dispatched');
    }
  };
  await stopIfEnded();
  // The change's worker is started before the agent's clock (durable-turn
  // `prepare`): a worker that takes long to start, or never does, is not
  // the agent running out of time. Bounded on its own (WORKER_PREPARE_MAX_MS);
  // what it failed with is the dispatch's answer.
  let prepared = null;
  const prepare = typeof deps.shotsAgent.prepareWorker !== 'function' ? null : async () => {
    await stopIfEnded();
    const startedMs = Date.now();
    let timer;
    try {
      await Promise.race([
        deps.shotsAgent.prepareWorker(session, { onProgress: onProgress ? (line) => onProgress(`Shots agent: ${line}`) : null, onShotsDiagnostic },
          injected.agentDependencies || {}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('The worker did not finish starting in time.'), { code: 'worker_start_timeout' })),
            injected.workerPrepareMaxMs ?? WORKER_PREPARE_MAX_MS);
        }),
      ]);
      prepared = { ok: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      prepared = { error };
    } finally {
      clearTimeout(timer);
      dispatchTrace.workerPrepareMs = Date.now() - startedMs;
    }
    // The agent's clock starts now, and so does the run's control plane's.
    if (prepared.ok) await shotsControl.extend(pool, runId, Date.now() + budgetMs + CONTROL_SLACK_MS);
  };
  const dispatch = async (extra = {}, { budgetMs: left = budgetMs } = {}) => {
    await stopIfEnded();
    dispatchTrace.timeoutMs = left;
    if (prepared?.error) {
      const agentError = agentErrorOf(prepared.error);
      dispatchTrace.outcome = 'failed';
      dispatchTrace.code = agentError.code;
      return { result: null, agentError };
    }
    try {
      const dispatched = await deps.shotsAgent.dispatch(config, {
        pool, session, runId,
        origins: a.origins,
        authTokens,
        navigationHints: a.navigationHints,
        recordClips: a.recordClips === true,
        clipSize: a.clipSize,
        phoneClipSize: a.phoneClipSize,
        phonePersonas: a.phonePersonas || [],
        browserPersonas: Array.isArray(a.browserPersonas) ? a.browserPersonas : [],
        platformAssets: a.platformAssets === true,
        deviceDensity: a.deviceDensity === true,
        onProgress: onProgress ? (line) => onProgress(`Shots agent: ${line}`) : null,
        onShotsDiagnostic,
        resumeThreadId: null,
        timeoutMs: left,
        ...(extra.owner ? { owner: extra.owner } : {}),
        ...(extra.holdTurnRecord ? { holdTurnRecord: true } : {}),
        ...(typeof extra.onTurnRecord === 'function' ? { onTurnRecord: extra.onTurnRecord } : {}),
      }, injected.agentDependencies || {});
      dispatchTrace.backend = String(dispatched.backend || 'claude_code').slice(0, 64);
      dispatchTrace.model = safeModelId(dispatched.model);
      dispatchTrace.outcome = 'completed';
      return { result: dispatched.result, ...(dispatched.usage ? { usage: dispatched.usage } : {}) };
    } catch (error) {
      dispatchTrace.outcome = 'failed';
      dispatchTrace.code = errorCode(error);
      return { result: null, agentError: agentErrorOf(error), ...(error?.shotsUsage ? { usage: error.shotsUsage } : {}) };
    }
  };
  const turn = await deps.durableTurn.runTurn(steps || deps.durableSteps.none(), key, {
    pool, session, mode: 'shots', budgetMs, dispatch, owner, prepare,
    // Its own clock ends only its own turn (by its record).
    stop: () => require('./durable-turn').clockStop(deps.worker, pool, sessionId, owner),
    onProgress,
  });
  const routed = turn.routed || {};
  // Whichever way the turn's end arrived: this dispatch, the turn a restart
  // followed, or the step's kept result.
  addAgentUsage(metrics, routed);
  let error = routed.agentError || null;
  if (!error && typeof routed.error === 'string') error = { code: 'shots_agent_failed', message: routed.error, busy: false, died: false };
  if (!error && turn.followed) error = followedErrorOf(routed.result);
  // A worker that never started never ran the agent: its clock is not why.
  if (turn.stopped && !error?.busy && !error?.workerStart) error = { ...(error || {}), code: 'shots_agent_timeout', message: 'The shots agent ran out of time.', timedOut: true };
  const finalResponse = agentFinalResponseSummary(routed.result || null, authTokens, a.origins, a.phoneTestCode);
  if (finalResponse) metrics.agentFinalResponses.push({ dispatch: 1, ...finalResponse });
  metrics.timingsMs.agentExploration = Math.max(0, Date.now() - metrics.startedAtMs);
  const summary = await shotsControl.summaryFor(pool, runId);
  if (!summary) throw new ShotsOrchestrationError('shots_control_not_found', 'The copies these shots were to be taken on are gone.');
  return {
    agent: error ? { outcome: error.busy ? 'busy' : error.died ? 'died' : error.timedOut ? 'timed_out' : 'failed', ...error }
      : { outcome: 'completed' },
    followed: !!turn.followed,
    ...verdictOf({ ...summary, intent: control.intent }),
    trace: { ...traceSummary(metrics), ...(finalResponse ? { agentFinalResponse: finalResponse } : {}) },
  };
}

/**
 * Where each ready change's before and after screens differ, so the card
 * can outline it, with the changes whose screens came out the same marked
 * so (shots.publish). Resolves the verdict to store. A screen that cannot be
 * compared is shown without outlines; it never holds the run back.
 */
async function compareScreens(pool, { runId, verdict, signal }, injected = {}) {
  const diff = injected.shotsDiff || shotsDiff;
  const control = await shotsControl.read(pool, runId);
  if (!control || verdict.afterOnly) return verdict;
  const ready = control.intent.stories.filter((story) => verdict.stories
    .some((result) => result.id === story.id && result.status === 'ready'));
  const slots = [];
  for (const story of ready) {
    for (const viewport of story.viewports) {
      for (const side of ['base', 'head']) {
        for (const variant of ['context', 'focus', 'animation']) {
          slots.push(shotsControl.dbSlot({ storyId: story.id, viewport: viewport.name, side, variant }));
        }
      }
    }
  }
  try {
    const files = await shotsControl.filesFor(pool, runId, slots);
    const screens = await diff.screensFor(ready, files, { signal });
    let stories = verdict.stories;
    if (typeof diff.unchangedStories === 'function') {
      stories = shotsFiles.markUnchanged(stories, diff.unchangedStories(screens));
    }
    // A change folded onto another one's screen kept its own after shot, but
    // the card draws the first change's: say so beside it. Injected comparers
    // may return screens without the field.
    if (typeof shotsFiles.markFolded === 'function') {
      const folded = new Set();
      for (const screen of screens) {
        if (screen && Array.isArray(screen.foldedAfter)) for (const id of screen.foldedAfter) folded.add(id);
      }
      if (folded.size) stories = shotsFiles.markFolded(stories, folded);
    }
    return { ...verdict, screens, stories };
  } catch (error) {
    if (signal?.aborted) throw error;
    log.warn('shots', 'Could not compare the before and after screens', {
      runId, code: error?.code, error: String(error?.message || error).slice(0, 300),
    });
    return verdict;
  }
}

// Another run on the proposal's worker is under way: its own (the shots
// machine's instance), or a shots eval's trial of it (its row active, or
// still being cleaned up). Whichever ends first leaves the worker to it.
async function newerRunUnderWay(pool, sessionId, runId) {
  const { SHOTS_LIVE_STATES } = require('../workflow/session-work.ts');
  const { rows } = await pool.query(
    `SELECT 1 FROM wf_instances WHERE machine = 'shots' AND key = 'session:' || $1::text
        AND state = ANY($2::text[]) AND data->'run'->>'id' IS DISTINCT FROM $3
     UNION ALL
     SELECT 1 FROM shots_eval_trials WHERE session_id = $1::int AND attempt_id IS DISTINCT FROM $3
        AND state IN ('provisioning', 'exploring', 'reviewing')
     UNION ALL
     SELECT 1 FROM wf_instances w, jsonb_each(w.data->'trials') t
      WHERE w.machine = 'shots-eval' AND (t.value->>'sessionId')::int = $1::int AND t.value->>'attempt' IS DISTINCT FROM $3`,
    [sessionId, SHOTS_LIVE_STATES, runId]);
  return rows.length > 0;
}

/**
 * Everything a run left (shots.cleanup): its agent's turn when it may still
 * be at it (`stopTurn`: the run ended while the agent worked), its copies,
 * its workspace, and, when `worker` says so, the temporary worker an
 * imported or merged proposal's agent ran in. Throws while anything is
 * left (its turn's record included), so the work is tried again.
 */
async function cleanupRun(config, pool, {
  runId, sessionId, appSlug, worker: dropWorker = false, stopTurn = false,
}, injected = {}) {
  const workerApi = injected.worker || worker;
  let turnHeld = false;
  if (stopTurn) {
    // Only this run's own turn: its record names the run (the dispatch's
    // telemetry id). Stopped, then its record released, as a turn whose
    // step ended would have it. A record that could not be released holds
    // the proposal's agent: the cleanup is tried again until it is, as it
    // is when the record cannot be read.
    const activeTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (activeTurn && activeTurn.mode === 'shots' && activeTurn.telemetryCorrelationId === runId) {
      // By its journal: a turn started after it is never the one killed.
      await (activeTurn.journal ? workerApi.stopTurnByJournal(sessionId, activeTurn.journal) : Promise.resolve()).catch((error) => {
        log.warn('shots', 'Could not stop the shots agent of a run that ended', { sessionId, runId, error: error.message });
      });
      const released = await workerApi.finishTurn(sessionId, {
        turnId: turnLifecycle.turnIdentity(activeTurn), journal: activeTurn.journal || null,
      });
      turnHeld = released === false;
    }
  }
  const left = await (injected.removeCopies || removeCopies)(config, { runId, appSlug });
  if (left.length) {
    throw new ShotsOrchestrationError('shots_cleanup_incomplete',
      `The copies could not all be removed: ${left.map((err) => err.message).slice(0, 3).join('; ')}`);
  }
  if (turnHeld) {
    throw new ShotsOrchestrationError('shots_cleanup_incomplete',
      'The shots agent\'s turn record could not be released.');
  }
  // The temporary worker goes unless a newer run of the proposal is under
  // way in it (this cleanup waited for its copies, or for a retry).
  if (dropWorker && !(await newerRunUnderWay(pool, sessionId, runId))) await workerApi.destroyCcVolume(sessionId);
  await shotsControl.remove(pool, runId);
  // The run's row says so (the retention prune reads it).
  return { cleaned: true, version: environment.RESOURCE_CLEANUP_VERSION };
}

module.exports = {
  ShotsOrchestrationError,
  exactSha,
  headForSession,
  intentForSession,
  uiFileHeuristic,
  loadSession,
  publicSessionAndApp,
  resolveRevisionContext,
  declaredCheckSummary,
  INSTALL_STRIP,
  MAKE_PROJECT,
  AFTER_ONLY,
  shotsBrief,
  BRIEF_BUDGET,
  sameProvenance,
  agentBusyRetryable,
  agentDiedRetryable,
  MAX_AGENT_BUSY_RETRIES,
  MIN_AGENT_RETRY_MS,
  platformFault,
  visibleError,
  redactDiagnosticText,
  newRunMetrics,
  recordAgentDiagnostic,
  addTiming,
  addAgentUsage,
  traceSummary,
  progressPhase,
  runCurrent,
  resolveRevision,
  buildCopies,
  agentErrorOf,
  dispatchAgent,
  compareScreens,
  cleanupRun,
};
