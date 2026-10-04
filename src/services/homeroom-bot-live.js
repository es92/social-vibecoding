'use strict';

// #3146: the Homeroom bot, live — on the apps named in the
// `homeroom_bot_live_apps` setting, and nowhere else.
//
// Slice 1 (homeroom-bot.js) triages every open request and records a verdict
// that nobody sees. On a live app the verdict is ACTED on:
//
//   the first look  one "looking at this" post per issue, ever
//   question        the question, with the default the bot would assume
//   person          a short note saying a person needs to decide, and why
//   empty           a short note saying there is nothing to build, and why;
//                   the issue is never closed by the bot
//   held            a verdict a live cap held back: one line saying why,
//                   posted once while the issue stays held (#3152)
//   follow-up       a reply after it proposed, on the issue or in the
//                   proposal's own discussion: answered, asked about, or
//                   made on the proposal's branch (#3264, see
//                   homeroom-bot-followup.js)
//   blocked         the spec found a ready request impossible as written:
//                   nothing is built, and the post says why
//   ready           a spec, then one GLM build turn in a dev session of the
//                   bot's own, then the SAME /promote handler a person's
//                   Propose button runs — pull request, staging, checks,
//                   vote — and a post on the issue that links the proposal.
//                   The spec is posted on the issue as soon as it is written
//                   and on the proposal once it is up, for reference: the
//                   build does not wait for anybody to approve it
//
// Every post goes to two places: a GitHub comment on the issue, and a
// message from the bot's own user in the issue's Homeroom discussion thread
// (an ordinary message since #3288, drawn as its bubble; it used to be a
// system line). Every post is recorded in homeroom_bot_posts. The request
// page draws both threads, so it shows each post once: the GitHub copy of a
// post whose thread copy landed is left out there (#3693,
// threadCopiedCommentIds).
//
// ── The loop this must never start ───────────────────────────────────────
//
// A post is issue activity, and issue activity re-queues the issue. Two
// halves keep the bot from answering itself:
//   - its Homeroom posts come from a synthetic user, and every "did a person
//     reply?" check leaves synthetic authors out: the queue's thread-activity
//     queries by is_synthetic, advanceSeen and the follow-up by BOT_USERNAME.
//     They are written by ws.sendBotMessage, which, unlike a person's post,
//     never fires the bot's own wake hooks;
//   - its GitHub comment moves the issue's updated_at, so the run records
//     the comment's own created_at as what it has seen (advanceSeen). It
//     does that only when nobody else posted while it worked: a person's
//     reply mid-turn must still re-queue the issue, even at the price of
//     one more look.
//
// ── Why /promote runs in-process ─────────────────────────────────────────
//
// The bot is a synthetic user, and the auth middleware never gives a
// synthetic user a session, so it cannot call /promote over HTTP the way
// the connector does. It builds its own instance of the votes router, which
// constructs nothing but routes, and dispatches the request into it. There
// stays exactly one implementation of "put a change up for a vote".

const log = require('./logger');
const { stripSpecWrapperFence } = require('./spec-format');
const { agentApiFailure } = require('./agent-result-text');
const proposalDescription = require('./proposal-description');
const { SPEC_DESIGN_BRIEF, FIRST_VERSION_SPEC_DESIGN_BRIEF, getDesignGuidance } = require('./prompts');
const { IN_LOOP_BROWSER_GUIDANCE } = require('./in-loop-browser');
const buildContract = require('./build-contract');

// A staging copy of the platform starts from production's settings, live
// list included. Posting on real GitHub issues and pushing real branches
// from it would be an irreversible side effect of a preview, so on staging a
// live app is triaged exactly as a shadow one.
// The bot's platform username. Its Homeroom thread posts are ordinary
// messages from this user (#3288), so every "did a person reply?" check
// leaves this author out. The GitHub login it comments as is a different
// name (github.getBotUsername()).
const BOT_USERNAME = 'homeroom_bot';

function isOwnMessage(m) {
  return String(m?.author || '').toLowerCase() === BOT_USERNAME;
}

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

/**
 * The apps the bot acts on for real, in this process, as one value every
 * caller (and every query) reads the same way:
 *
 *   - `{ all: false, slugs }`: today's list audience: the apps in the live
 *     list, and (#3624) the projects it is building for somebody it talks
 *     to in a DM (settings.firstVersionApps, homeroom-bot-dm.js);
 *   - `{ all: true, except }`: the `everyone` audience (homeroom-bot.js
 *     KEY_AUDIENCE): every app but a paused one and the platform's own,
 *     which has a switch of its own (settings.livePlatform). Named by what
 *     it leaves out, so no query is handed a list of every app's slug.
 *
 * Off, or on a staging copy, it is nothing at all.
 */
function liveScope(settings) {
  if (!settings || settings.mode === 'off' || isStaging()) return { all: false, slugs: [], except: [] };
  return appsScope(settings);
}

/**
 * The same apps whether or not the bot is on, or this is a staging copy:
 * what a person's own requests are measured against when the answer says
 * apart whether the bot is working (homeroom-bot-progress.js botIsOn).
 */
function appsScope(settings) {
  if (!settings) return { all: false, slugs: [], except: [] };
  if (settings.audience === 'everyone') {
    const paused = Array.isArray(settings.pausedApps) ? settings.pausedApps : [];
    const platform = settings.livePlatform ? [] : (Array.isArray(settings.platformSlugs) ? settings.platformSlugs : []);
    return { all: true, slugs: [], except: [...new Set([...paused, ...platform])] };
  }
  const live = Array.isArray(settings.liveApps) ? settings.liveApps : [];
  const built = Array.isArray(settings.firstVersionApps) ? settings.firstVersionApps : [];
  return { all: false, slugs: [...new Set([...live, ...built])], except: [] };
}

/** Pure: whether a scope from liveScope takes in any app at all. */
function scopeIsEmpty(scope) {
  return !scope || (!scope.all && !(scope.slugs || []).length);
}

/** Pure: whether `slug` is inside a scope from liveScope. */
function inScope(scope, slug) {
  if (!scope || !slug) return false;
  return scope.all ? !(scope.except || []).includes(slug) : (scope.slugs || []).includes(slug);
}

/** Whether the bot acts for real on this app, in this process (liveScope). */
function isLiveFor(settings, app) {
  return !!app && inScope(liveScope(settings), app.slug);
}

// A query reads a scope as three parameters: the slug list where a query
// read the live list before, then whether it is every app and the slugs it
// leaves out, appended after the query's own:
//   (CASE WHEN $all::boolean THEN NOT (a.slug = ANY($except::text[]))
//         ELSE a.slug = ANY($slugs::text[]) END)
// written out in each query, so the query stays one static string the SQL
// check can read.

const MAX_QUOTED_CHARS = 1500;

function clipText(value, max = MAX_QUOTED_CHARS) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── What it says ─────────────────────────────────────────────────────────

const REPLY_HINT = 'Reply here (or on the GitHub issue) and it will look again.';

function lookingText() {
  return 'Homeroom bot is looking at this request. It will reply here with a question if '
    + 'something is unclear, a note if a person needs to decide, or a proposal if it can build it.';
}

// B6 (E5): no line saying what it would go with when nobody answers:
// nothing applies a default to an unanswered question. B6: a read can ask
// two at once.
function questionText({ question, plan = null }) {
  const two = Array.isArray(plan?.questions) && plan.questions.length > 1 ? plan.questions : null;
  const lines = two
    ? [
      'Homeroom bot has two questions before it can build this:',
      '',
      ...two.map((q, i) => `${i + 1}. ${clipText(q.question, 500)}`),
    ]
    : [
      'Homeroom bot has a question before it can build this:',
      '',
      clipText(question) || '(no question text)',
    ];
  lines.push('', REPLY_HINT);
  return lines.join('\n');
}

function personText({ reason }) {
  return `Homeroom bot thinks a person needs to decide this one: ${clipText(reason) || 'no reason given.'}`;
}

function emptyText({ reason }) {
  return [
    `Homeroom bot couldn't find anything to build in this request: ${clipText(reason) || 'no reason given.'}`,
    '',
    'If there is more to it, add the details here (or on the GitHub issue) and it will look again.',
  ].join('\n');
}

function proposalText({ link, prNumber }) {
  const pr = prNumber ? ` (PR #${prNumber})` : '';
  return `Homeroom bot built this and opened a proposal for the group to vote on${pr}: ${link}`;
}

function buildFailedText(reason) {
  return `Homeroom bot tried to build this but couldn't finish: ${clipText(reason, 400) || 'unknown reason'}. `
    + 'A person could pick it up from here.';
}

// #3152: a verdict a live cap held. One line, so the person who filed the
// issue is not left with silence, and a promise the refresh keeps: a held
// issue is queued again as soon as the cap that held it has room.
function heldText({ cap, verdict, limit }) {
  if (cap === 'proposals_per_app') {
    return `Homeroom bot would build this, but it already has ${limit} proposals open on this app. `
      + 'It will come back to this issue when one of them is merged or closed.';
  }
  if (cap === 'proposals_total') {
    return `Homeroom bot would build this, but it already has ${limit} proposals open across Homeroom. `
      + 'It will come back to this issue when one of them is merged or closed.';
  }
  const what = verdict === 'question' ? 'a question about' : 'a note on';
  return `Homeroom bot has ${what} this request, but it has already posted ${limit} questions and notes `
    + 'on this app in the last day. It will come back to this issue once some of those are a day old.';
}

function heldKind(cap) {
  return `held_${cap}`;
}

/** The kind of the bot's newest post on this issue, or null. */
async function lastPostKind(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT kind FROM homeroom_bot_posts
      WHERE app_id = $1 AND issue_number = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [appId, issueNumber],
  );
  return rows[0]?.kind || null;
}

function proposalLink(domain, appSlug, sessionId) {
  return `https://${domain}/#app/${encodeURIComponent(appSlug)}/dev/proposals/${Number(sessionId)}`;
}

// ── The spec ─────────────────────────────────────────────────────────────
//
// Before it builds a ready request, the bot writes a spec for it, the way a
// person's dev session does: a read-only scout turn in the build's own
// session, whose final message IS the spec, stored as that session's spec
// doc (spec_md and a numbered version). The build then works from it. On a
// live app it is posted on the issue as soon as it exists, and on the
// proposal once it is up. For reference only: nothing waits on it.

// The spec gets a clock of its own, shorter than a build's: the triage has
// already read the code, so this is writing down a plan, not discovering one.
const SPEC_TURN_MAX_MS = 10 * 60 * 1000;
// GitHub refuses a comment over 65,536 characters.
const MAX_SPEC_COMMENT_CHARS = 60_000;
// A timed-out build's last few progress lines, kept for its failure reason.
// Three short ones fit the run's error column (600 characters).
const PROGRESS_LINES_KEPT = 3;
const PROGRESS_LINE_CHARS = 160;

/**
 * What a turn was last doing, so one stopped on its clock says what it was
 * waiting on (#3385): the last few distinct progress lines, clipped.
 * `suffix()` is "" when there were none.
 */
function lastActivity() {
  const recent = [];
  return {
    note(line) {
      const text = clipText(String(line || '').replace(/\s+/g, ' '), PROGRESS_LINE_CHARS);
      if (!text || recent[recent.length - 1] === text) return;
      recent.push(text);
      if (recent.length > PROGRESS_LINES_KEPT) recent.shift();
    },
    suffix() { return recent.length ? `; last activity: ${recent.join(' | ')}` : ''; },
  };
}

// #3426: a reporter's screenshot (feedback's `/issue-images/<id>` line) is
// often the only description of what they mean, and the bot used to guess
// past it: recipebot #47 ("Can not comment", a phone screenshot) was built
// on an assumption. Said only when the thread has one, in each turn that
// reads the request: triage, spec and build.
const ISSUE_IMAGE_URL = /https?:\/\/[^\s)]+\/issue-images\/[A-Za-z0-9_-]+/;

function screenshotNote(seed) {
  if (!ISSUE_IMAGE_URL.test(String(seed || ''))) return [];
  return [
    'The request includes a screenshot (an `/issue-images/<id>` link above). Download each one, for example',
    '`curl -sS -o /tmp/issue-shot-1.png <url>`, and look at it with your image tool (view_image, or the Read',
    'tool) before you decide anything: it is often the clearest description of what the reporter means. If the',
    'tool says this model cannot take images, do not try to decode the file another way (by hand, as ASCII art',
    'or with OCR): treat what it shows as unknown, and say so.',
    '',
  ];
}

// #3737: `firstVersion` swaps the design brief for a first version's own
// (services/prompts.js FIRST_VERSION_SPEC_DESIGN_BRIEF); nothing else in the
// spec prompt changes.
function specPrompt({ seed, buildNote, firstVersion = false }) {
  return [
    seed,
    '',
    ...screenshotNote(seed),
    'You are the Homeroom bot. Your triage of this request concluded it is ready to build, with this plan:',
    '',
    clipText(buildNote, 4000) || '(no plan recorded: work from the request itself)',
    '',
    'Before it is built, write the SPEC for it: a markdown document the app\'s group can read, and that the build',
    'that follows will work from. You are running in PLAN MODE: read and search the repository with read-only',
    'shell commands (for example `rg`, `ls`, `sed -n`, `cat`), but do not edit, create, delete, commit, or push',
    'anything; anything this run changes in the repository is discarded when it ends.',
    '',
    'The spec must be:',
    '- Grounded in the real code: name actual files and describe current behaviour, not guesses.',
    '- Two halves under these exact H2 headings, in this order: "## User-facing changes" then',
    '  "## Technical implementation". Start with a "# " title line; keep everything else inside one of the',
    '  two halves, and use ### or deeper for any other heading. "User-facing changes" is for a non-developer:',
    '  what people will see and do differently, no file paths or code. "Technical implementation" holds the',
    '  files, data, edge cases and tests.',
    '- Titled with what the change DOES, because the proposal is named after it: the way a pull request title',
    '  reads ("Show the reason beside each challenge credit", not "Credits have no reason" or "Spec for issue',
    '  #12"), at most 72 characters, and no issue number: the proposal links the issue on its own.',
    '- As small as the request: the plan above, no refactoring or extra features.',
    `- ${firstVersion ? FIRST_VERSION_SPEC_DESIGN_BRIEF : SPEC_DESIGN_BRIEF}`,
    '',
    'Nobody is available to answer questions: this run is unattended, and the build starts as soon as you finish.',
    'Where something is open, make the sensible choice yourself. End the "User-facing changes" half with a',
    '"### Assumptions" subsection: every assumption listed in the plan above and every choice you made, one',
    'plain-language line each, so the group can see them and object in review. Do not write a "### Questions"',
    'section.',
    '',
    'Before you finish, read the two halves against each other. Every assumption, and everything "User-facing',
    'changes" says people will see, must be true of what "Technical implementation" builds, and the technical half',
    'must build nothing the user-facing half leaves out. Where they disagree, change one so they agree: the build',
    'follows the technical half, so a promise only the other half makes is a promise the build breaks.',
    '',
    'There is one exception. If reading the code shows the request is IMPOSSIBLE as written (it depends on',
    'something that does not exist and cannot be built here, or the code contradicts what it asks), do not write',
    'a spec: reply with a single line that starts with "BLOCKED:" and says why in one sentence. That is for',
    'impossible only. A choice, however unsure you are about it, is an assumption, never a BLOCKED.',
    'A reported bug counts as impossible when the code does not show it: if the request reports a bug and you',
    'cannot find where in the code it happens, reply "BLOCKED:" and say where you looked. A fix for a cause you',
    'could not find is a guess, and the build does not guess.',
    '',
    'Otherwise your final message must be ONLY the markdown spec, as raw markdown: no preamble, and not wrapped',
    'in a code fence. It is captured verbatim.',
  ].join('\n');
}

// The spec turn's one way out: a first line "BLOCKED: <why>".
const BLOCKED_RE = /^\s*BLOCKED:\s*(.+)/i;

/**
 * The spec from its "# " title line on. A model sometimes says what it is
 * about to do before the document ("All the code I need is verified.
 * Writing the spec now…": 7 of the first 32 shadow specs, #3385), and on a
 * live app that line would be posted on the issue with it. Only lines
 * before a title near the top are dropped; a spec with no title is kept.
 */
function specFromTitle(text) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex((l) => /^# \S/.test(l));
  if (at <= 0 || at > 40) return String(text || '');
  return lines.slice(at).join('\n').trim();
}

/** Why the spec turn found the request impossible, or null. */
function specBlocked(text) {
  const firstLine = String(text || '').trim().split('\n')[0] || '';
  const m = BLOCKED_RE.exec(firstLine);
  return m ? clipText(m[1], 500) : null;
}

function blockedText(reason) {
  return [
    'Homeroom bot started on this and found it cannot be built as asked:',
    '',
    clipText(reason, 500) || '(no reason given)',
    '',
    REPLY_HINT,
  ].join('\n');
}

// The longest spec title the card shows, and the longest the proposal is
// named with whole (see proposalTitle).
const SPEC_TITLE_MAX = 120;

/** The spec's whole "# " heading, unclipped, or null. */
function specHeading(spec) {
  const lines = String(spec || '').split('\n');
  for (let i = 0; i < Math.min(lines.length, 30); i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && line.slice(2).trim()) return line.slice(2).trim();
  }
  return null;
}

/** The spec's "# " title, as routes/sessions.js extractSpecTitle reads it. */
function specTitle(spec) {
  const heading = specHeading(spec);
  return heading ? heading.slice(0, SPEC_TITLE_MAX) : null;
}

// ── What the proposal is called, and what it says (#3518) ────────────────
//
// The promote route names a pull request from the session's first request
// and leads it with the coding agent's latest description (pr-metadata's
// deterministic path, which every OpenRouter session takes). The bot's build
// gave it neither: its only request was the "Build issue #N: …" seed, and
// its turn ran outside the dev chat, so no completion row recorded what it
// said. Every bot proposal came out titled with the issue number and a
// severed run of the plan, with no summary at all.
//
// The spec already holds both halves of a better answer, written for people:
// a title naming the change (the spec prompt asks for one shaped like a pull
// request title) and a "User-facing changes" half written for somebody who
// is not a developer. The build adds the most accurate half: a DESCRIPTION
// block written after the change exists, the one an OpenRouter dev chat turn
// ends with (proposal-description.js, #2820).

// Scaffolding a title is not: a "Spec:" label, and the issue number, which
// the proposal shows as its own Addresses chip.
const TITLE_LABEL_RE = /^(?:spec(?:ification)?|plan)(?:\s+for\b)?\s*(?:[:\u2013\u2014-]\s*|(?=(?:(?:github\s+)?issue\s+)?#\d))/i;
const TITLE_ISSUE_LEAD_RE = /^(?:(?:build\s+)?(?:github\s+)?issue\s+#?\d+|#\d+)\s*[:\u00b7\u2013\u2014-]?\s*/i;
const TITLE_ISSUE_TAIL_RE = /\s*(?:[([]\s*(?:(?:github\s+)?issue\s+)?#\d+\s*[)\]]|[\u2013\u2014-]\s*(?:issue\s+)?#\d+)$/i;

/**
 * The name the bot proposes a change under: the spec's title, the way the
 * spec prompt asks for it (what the change does, in pull request form),
 * with a "Spec:" label or an issue number taken off, or null when there is
 * none worth using. Null sends the promote route to its own deterministic
 * name, which since #3518 is the issue's title with the seed peeled off
 * (session-title.js parseIssueSeed).
 *
 * Never cut. The prompt asks for 72 characters, as the platform's own
 * generated titles are asked for, and a model that runs over has still
 * written a whole name: a title up to the spec card's own bound is used as
 * it is, and one past it is not a title, so the fallback names the change
 * instead. Cutting a name short is the fault this replaces.
 */
function proposalTitle(spec) {
  const heading = specHeading(spec);
  if (!heading) return null;
  const title = heading
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TITLE_LABEL_RE, '')
    .replace(TITLE_ISSUE_LEAD_RE, '')
    .replace(TITLE_ISSUE_TAIL_RE, '')
    .replace(/\.+$/, '')
    .trim();
  // One word ("Spec", "Leaderboard") names a topic, not a change.
  if (!title || title.length > SPEC_TITLE_MAX || title.split(' ').length < 2) return null;
  return title;
}

/**
 * The spec's "User-facing changes" half, as far as its "### Assumptions"
 * subsection: what people will see and do differently, written for somebody
 * who is not a developer (specPrompt). The assumptions stay in the spec,
 * which is on the proposal as a card; they are choices, not changes. Null
 * when the spec has no such half.
 */
function specUserFacing(spec) {
  const lines = String(spec || '').split('\n');
  const start = lines.findIndex((l) => /^##\s+user[- ]facing changes\s*:?\s*$/i.test(l.trim()));
  if (start === -1) return null;
  const kept = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (/^##\s/.test(t) || /^###\s+assumptions\b/i.test(t)) break;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  if (!text) return null;
  const max = proposalDescription.DESCRIPTION_MAX;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * What the build said, as the completion row a dev chat turn writes stores
 * it: `ccOutput` is its message with the DESCRIPTION block taken out, and
 * `proposalDescription` the block, or the spec's user-facing half when the
 * build left the block out. A final message that is a wire failure (a run
 * can commit and then die on the API) says nothing about the change.
 */
function buildDescription({ text, spec = null }) {
  const raw = String(text || '').trim();
  const said = raw && !agentApiFailure(raw) ? proposalDescription.extract(raw) : { cleanedText: '', description: null };
  const description = said.description || specUserFacing(spec);
  return { ccOutput: String(said.cleanedText || '').trim() || description || '', description: description || null };
}

/**
 * Write the proposal's name and description onto the build's session, just
 * before the promote route reads them. Both go through the seams a person's
 * change uses, so nothing downstream learns about the bot:
 *   - the name is proposed_pr_title, the author's own title for a change not
 *     yet proposed, which the route names the pull request with verbatim.
 *     submit_work stores an external agent's title there, and the bot is
 *     this change's author the same way. (#2779 keeps a Mayor's start_change
 *     name out of it because that name is a guess made before any work; the
 *     spec's title is written from the code, and the proposal goes up as
 *     soon as the build ends.) Only written while the session has no pull
 *     request and no chosen title;
 *   - the description is the completion row every dev chat build leaves
 *     (a system row carrying ccOutput and proposalDescription), which
 *     pr-metadata's gatherSessionContext reads for the summary the group
 *     sees first, and the pull request body leads with.
 * Best-effort: a proposal that cannot be named or described still goes up,
 * under the fallback name. Resolves { title, description }; never throws.
 */
async function prepareProposal({ pool, bot, sessionId, spec = null, buildText = '', model = null }) {
  const title = proposalTitle(spec);
  if (title) {
    try {
      await pool.query(
        `UPDATE chat_sessions SET proposed_pr_title = $1
          WHERE id = $2 AND user_id = $3 AND pr_number IS NULL AND proposed_pr_title IS NULL`,
        [title, Number(sessionId), bot.id],
      );
    } catch (err) {
      log.warn('homeroom-bot', 'Could not name the proposal; the route names it', { sessionId, err: err.message });
    }
  }
  const built = buildDescription({ text: buildText, spec });
  const { ccOutput } = built;
  // B4: the person who asked for it is credited in its description, which
  // the summary the group reads first is built from (pr-metadata), and which
  // a later revision of the bot's leaves in place. The change's author stays
  // the bot.
  const askedBy = await askerOf(pool, sessionId);
  const description = built.description && askedBy ? creditedDescription(built.description, askedBy) : built.description;
  if (ccOutput) {
    try {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [Number(sessionId), 'Homeroom bot finished building', JSON.stringify({
          ccOutput,
          ...(description ? { proposalDescription: description } : {}),
          ccOutcome: 'success',
          agentBackend: 'codex_openrouter',
          agentModel: model || null,
        })],
      );
    } catch (err) {
      log.warn('homeroom-bot', 'Could not record what the build said; proposing without a summary', {
        sessionId, err: err.message,
      });
    }
  }
  return { title, description };
}

/**
 * B4: the Homeroom username of the person a build of the bot's was asked
 * for by: the requester of the request it is linked to. Null when there is
 * none or it cannot be read. Never throws.
 */
async function askerOf(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.username FROM chat_sessions cs
         JOIN homeroom_bot_requesters q ON q.app_id = cs.app_id AND q.issue_number = ANY(cs.linked_issues)
         JOIN users u ON u.id = q.user_id AND u.is_synthetic = FALSE
        WHERE cs.id = $1
        ORDER BY q.created_at
        LIMIT 1`,
      [Number(sessionId)],
    );
    return rows[0]?.username || null;
  } catch {
    return null;
  }
}

/** Pure (B4): a change's description, ending with who asked for it, once. */
function creditedDescription(description, username) {
  const text = String(description || '').trim();
  const line = `Asked for by @${username}`;
  if (!username || text.split('\n').some((l) => l.trim() === line)) return text;
  return `${text}\n\n${line}`;
}

/** The card's preview: the body after the title, as the share route cuts it. */
function specSnippet(spec, title) {
  const lines = String(spec || '').split('\n');
  let start = 0;
  if (title) {
    while (start < lines.length && !lines[start].trim()) start += 1;
    if (start < lines.length && lines[start].trim().startsWith('# ')) start += 1;
  }
  while (start < lines.length && !lines[start].trim()) start += 1;
  return lines.slice(start).join('\n').slice(0, 280);
}

/** The spec as a GitHub comment: said what it is for, then the document. */
function specCommentText(spec) {
  return [
    // B6: no approval talk while it builds. The change is linked once it can be tried.
    'Homeroom bot wrote a spec for this request and is building it now. The change will be linked here when it\'s '
      + 'ready to try.',
    '',
    '<details><summary>The spec</summary>',
    '',
    clipText(spec, MAX_SPEC_COMMENT_CHARS),
    '',
    '</details>',
  ].join('\n');
}

/**
 * The spec as a thread message: the same spec card a person's "Share"
 * posts (metadata.specShare), opening the version the build worked from.
 */
function specCard({ sessionId, version, spec, bot, proposed = false }) {
  const title = specTitle(spec);
  const content = proposed
    ? `📋 The spec this proposal was built from${title ? `: "${title}"` : ''}.`
    : `📋 Homeroom bot's spec for this request${title ? `: "${title}"` : ''}. It is building it now.`;
  return {
    content,
    msgType: 'spec_share',
    metadata: {
      specShare: {
        sessionId: Number(sessionId),
        version: Number(version),
        builtAt: null,
        commitSha: null,
        prNumber: null,
        title,
        snippet: specSnippet(spec, title),
        totalChars: String(spec || '').length,
        sharedBy: { id: bot.id, username: bot.username },
      },
    },
  };
}

/**
 * Make the spec version readable by everyone who can see the card: a
 * version is private to its session's owner until it is shared, exactly as
 * the share route marks it.
 */
async function shareSpecVersion(pool, sessionId, version) {
  await pool.query(
    `UPDATE chat_session_specs SET shared_to_group_at = NOW()
      WHERE session_id = $1 AND version = $2 AND shared_to_group_at IS NULL`,
    [Number(sessionId), Number(version)],
  );
}

/** The spec card in the proposal's own discussion, once it is up. */
async function postSpecOnProposal({ pool, ws, app, bot, sessionId, version, spec }) {
  if (!spec || !version || !sessionId) return null;
  await shareSpecVersion(pool, sessionId, version);
  const card = specCard({ sessionId, version, spec, bot, proposed: true });
  return ws.sendBotMessage(pool, app.id, {
    user: bot, content: card.content, metadata: card.metadata,
    thread: { type: 'session', ref: Number(sessionId) }, msgType: card.msgType,
  });
}

// ── Who filed the issue ──────────────────────────────────────────────────
//
// An issue filed from Homeroom is authored on GitHub by the platform's bot
// account, so GitHub notifies nobody when the Homeroom bot answers it, and a
// system message in the issue's thread notifies nobody either. The answers
// that ask something of the person who filed it name them in the thread and
// put a mention in their notifications (see post).
//
// Found the way the issues route names an issue's creator
// (routes/issues.js): the platform's own issue row, then the feedback
// report, then the body's "**Source:**" line; for an issue opened on
// GitHub, the Homeroom account linked to its author's GitHub login.

// The kinds of post that tag people: whoever filed the issue and whoever
// took part in its discussion (see mentionTargets). Every answer, the spec
// and the proposal, and every follow-up on the proposal. Not "looking" (a
// notice, before anything is known) and not a held note (nothing for them
// to do; the bot comes back on its own).
const TAGGING_KINDS = new Set([
  'question', 'person', 'empty', 'proposal', 'build_failed', 'blocked', 'spec',
  'followup_answer', 'followup_ask', 'followup_revise', 'followup_person', 'followup_failed',
]);

function tagsPoster(kind) {
  return TAGGING_KINDS.has(kind);
}

// At most this many people are tagged on one post: whoever filed it, then
// the earliest to join in. A crowded issue does not become a crowded inbox.
const MAX_MENTIONS = 6;

function isOtherBotLogin(login, botLogin) {
  const l = String(login || '').toLowerCase();
  return !l || l.endsWith('[bot]') || l === 'usernode-bot' || (botLogin && l === String(botLogin).toLowerCase());
}

/**
 * Who a post on this issue tags, as Homeroom usernames, in order: whoever
 * filed it, then everybody who wrote in its Homeroom thread (and the
 * proposal's, when there is one) or commented on GitHub from an account
 * linked to Homeroom, earliest first. Never the bot or another synthetic
 * account, never somebody who asked the bot to stop tagging them here
 * (homeroom_bot_mention_optouts), and at most MAX_MENTIONS.
 */
async function mentionTargets({
  pool, github, app, repo, issueNumber, issue, botLogin = null, bot = null, proposalSessionId = null,
}) {
  const names = [];
  const poster = await issuePoster(pool, { app, repo, issueNumber, issue, botLogin }).catch(() => null);
  if (poster) names.push(poster);
  const { rows: talked } = await pool.query(
    `SELECT u.username, MIN(m.id) AS first_id
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic = FALSE
        AND ((m.thread_type = 'issue' AND m.thread_ref = $2)
             OR ($3::int IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = $3::int))
      GROUP BY u.username
      ORDER BY first_id`,
    [app.id, issueNumber, proposalSessionId == null ? null : Number(proposalSessionId)],
  );
  names.push(...talked.map((r) => r.username));
  let comments = [];
  try {
    ({ comments = [] } = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber));
  } catch {
    comments = [];
  }
  const logins = [...new Set(comments.map((c) => String(c.author || '')).filter((l) => !isOtherBotLogin(l, botLogin))
    .map((l) => l.toLowerCase()))];
  if (logins.length) {
    const { rows: linked } = await pool.query(
      `SELECT username, LOWER(github_login) AS login FROM users
        WHERE LOWER(github_login) = ANY($1::text[]) AND is_synthetic = FALSE`,
      [logins],
    );
    const byLogin = new Map(linked.map((r) => [r.login, r.username]));
    for (const l of logins) if (byLogin.has(l)) names.push(byLogin.get(l));
  }
  const { rows: out } = await pool.query(
    `SELECT u.username FROM homeroom_bot_mention_optouts o JOIN users u ON u.id = o.user_id
      WHERE o.app_id = $1 AND o.issue_number = $2`,
    [app.id, issueNumber],
  );
  const optedOut = new Set(out.map((r) => r.username.toLowerCase()));
  const botName = String(bot?.username || BOT_USERNAME).toLowerCase();
  const seen = new Set();
  const targets = [];
  for (const name of names) {
    const key = String(name || '').toLowerCase();
    if (!key || key === botName || key === BOT_USERNAME || optedOut.has(key) || seen.has(key)) continue;
    seen.add(key);
    targets.push(name);
    if (targets.length >= MAX_MENTIONS) break;
  }
  return targets;
}

/** The names a triage or follow-up turn read asking the bot to stop tagging them. */
function parseStopMentioning(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((n) => (typeof n === 'string' ? n.replace(/^@/, '').trim() : ''))
    .filter((n) => /^[A-Za-z0-9_.-]{1,64}$/.test(n)))].slice(0, 20);
}

/**
 * Of the names a turn read, the people who actually wrote on this issue: a
 * Homeroom username from the issue's thread (or the proposal's, on a
 * follow-up), or a GitHub login linked to a Homeroom account that commented
 * on the issue. Only they can change whether the bot tags them here, and
 * only for themselves. Resolves Map(user id → username).
 */
async function issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId = null }) {
  const asked = [...new Set((names || []).map((n) => String(n || '').replace(/^@/, '').trim().toLowerCase()).filter(Boolean))];
  if (!asked.length) return new Map();
  const { rows: fromThread } = await pool.query(
    `SELECT DISTINCT u.id, u.username
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic = FALSE AND LOWER(u.username) = ANY($4::text[])
        AND ((m.thread_type = 'issue' AND m.thread_ref = $2)
             OR ($3::int IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = $3::int))`,
    [app.id, issueNumber, proposalSessionId == null ? null : Number(proposalSessionId), asked],
  );
  let fromGithub = [];
  try {
    const { comments = [] } = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber);
    const logins = [...new Set(comments.map((c) => String(c.author || '').toLowerCase()))].filter((l) => asked.includes(l));
    if (logins.length) {
      ({ rows: fromGithub } = await pool.query(
        `SELECT id, username FROM users WHERE LOWER(github_login) = ANY($1::text[]) AND is_synthetic = FALSE`,
        [logins],
      ));
    }
  } catch {
    fromGithub = [];
  }
  return new Map([...fromThread, ...fromGithub].map((u) => [u.id, u.username]));
}

/**
 * The people a triage or follow-up turn read asking the bot to stop tagging
 * them on this issue, recorded so no later post does. Resolves the
 * usernames recorded.
 */
async function recordMentionOptOuts({
  pool, github, app, repo, issueNumber, names, runId = null, proposalSessionId = null,
}) {
  const people = await issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId });
  if (!people.size) return [];
  await pool.query(
    `INSERT INTO homeroom_bot_mention_optouts (app_id, issue_number, user_id, run_id)
     SELECT $1, $2, u, $4 FROM UNNEST($3::int[]) AS u
     ON CONFLICT (app_id, issue_number, user_id) DO NOTHING`,
    [app.id, issueNumber, [...people.keys()], runId],
  );
  log.info('homeroom-bot', 'Stopped tagging people who asked', { app: app.slug, issueNumber, people: [...people.values()] });
  return [...people.values()];
}

/**
 * The people a turn read asking to be tagged again on this issue, after
 * they had asked it to stop. The same rule: only somebody who wrote there,
 * only for themselves. Resolves the usernames tagged again.
 */
async function clearMentionOptOuts({
  pool, github, app, repo, issueNumber, names, proposalSessionId = null,
}) {
  const people = await issueAuthorsNamed({ pool, github, app, repo, issueNumber, names, proposalSessionId });
  if (!people.size) return [];
  const { rows } = await pool.query(
    `DELETE FROM homeroom_bot_mention_optouts
      WHERE app_id = $1 AND issue_number = $2 AND user_id = ANY($3::int[])
      RETURNING user_id`,
    [app.id, issueNumber, [...people.keys()]],
  );
  const back = rows.map((r) => people.get(r.user_id));
  if (back.length) log.info('homeroom-bot', 'Tagging people again who asked', { app: app.slug, issueNumber, people: back });
  return back;
}

/**
 * What a turn read about tagging, applied before anything from that run is
 * posted. A name in both lists is left as it was: the turn could not tell
 * which ask came last, and the prompt forbids listing anybody twice.
 */
async function applyMentionAsks({
  pool, github, app, repo, issueNumber, stop = [], resume = [], runId = null, proposalSessionId = null,
}) {
  const lower = (list) => new Set((list || []).map((n) => String(n).toLowerCase()));
  const both = [...lower(stop)].filter((n) => lower(resume).has(n));
  const keep = (list) => (list || []).filter((n) => !both.includes(String(n).toLowerCase()));
  const stopped = keep(stop).length
    ? await recordMentionOptOuts({ pool, github, app, repo, issueNumber, names: keep(stop), runId, proposalSessionId })
    : [];
  const resumed = keep(resume).length
    ? await clearMentionOptOuts({ pool, github, app, repo, issueNumber, names: keep(resume), proposalSessionId })
    : [];
  return { stopped, resumed };
}

/** The Homeroom username of whoever filed the issue, or null. */
async function issuePoster(pool, { app, repo, issueNumber, issue, botLogin = null }) {
  const { rows } = await pool.query(
    `SELECT username FROM (
       SELECT u.username, 0 AS source_rank
         FROM issues i JOIN users u ON u.id = i.created_by
        WHERE i.app_id = $1 AND i.github_issue_number = $2
       UNION ALL
       SELECT u.username, 1 AS source_rank
         FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
        WHERE fr.issue_owner = $3 AND fr.issue_repo = $4 AND fr.issue_number = $2
     ) creators
     ORDER BY source_rank
     LIMIT 1`,
    [app.id, issueNumber, repo.owner, repo.repo],
  );
  if (rows[0]?.username) return rows[0].username;
  // Required lazily: the route module loads the route layer, and it
  // requires the bot lazily in turn.
  const fromSource = require('../routes/issues').creatorFromSourceLine(issue?.body);
  // The legacy bare "usernode admin" line names nobody.
  if (fromSource && fromSource !== 'admin') return fromSource;
  const login = issue?.user || null;
  if (!login || login.endsWith('[bot]') || login === 'usernode-bot'
      || (botLogin && login.toLowerCase() === String(botLogin).toLowerCase())) {
    return null;
  }
  const { rows: linked } = await pool.query(
    'SELECT username FROM users WHERE LOWER(github_login) = LOWER($1) LIMIT 1',
    [login],
  );
  return linked[0]?.username || null;
}

// ── Posting ──────────────────────────────────────────────────────────────

/**
 * Post one message to both places, and record it.
 *
 * The row is written FIRST: for `looking` the partial unique index makes the
 * insert the claim, so two passes cannot both announce the same issue, and
 * a post that fails half-way still leaves a record of what was attempted.
 * Both sends are best-effort, like "Generate proposal"'s: a failed post
 * never changes the verdict or the build. Returns null when `looking` was
 * already claimed, else what landed.
 */
async function post({
  pool, github, ws, app, repo, issueNumber, kind, runId = null, text,
  msgType = 'system', metadata = null, mention = null, mentions = null, senderId = null, notifications = null,
  proposalSessionId = null, sender = null, threadMessage = null, dm = null,
}) {
  // Everybody this post tags (mentionTargets); `mention` is the one-person
  // form the older callers pass.
  let tagged = [...new Set([...(mentions || []), ...(mention ? [mention] : [])].filter(Boolean))];
  // #3288: with a sender (the bot's own user), the thread posts are ordinary
  // messages from it, drawn as its bubbles. `msgType` then no longer picks
  // the row's kind: the proposal link is a message whose `metadata.vote`
  // the chat hangs the vote card on. Without one, the old system line.
  const inThread = (content, thread, meta = metadata, kindOfRow = msgType) => (sender
    ? ws.sendBotMessage(pool, app.id, { user: sender, content, metadata: meta, thread })
    : ws.sendSystemMessage(pool, app.id, content, kindOfRow, meta, thread));
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id, issue_number) WHERE kind = 'looking' DO NOTHING
     RETURNING id`,
    [app.id, issueNumber, runId, kind],
  );
  if (!rows.length) return null;
  const postId = rows[0].id;
  let comment = null;
  let message = null;
  try {
    comment = await github.createIssueComment(repo.owner, repo.repo, issueNumber, text);
  } catch (err) {
    log.warn('homeroom-bot', 'GitHub comment failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  // #3624: the same news, in the requester's DM with the bot, when they
  // are somebody it talks to there. A post that carries `dm` is one worth
  // telling them about; the issue stays the record either way.
  // #3698: told BEFORE the thread post, so what the DM actually did decides
  // whether the post tags them (homeroom-bot-dm.js untaggedRequester). It
  // does not when the DM reached them (it rang there; a tag would ring
  // twice) or they blocked the bot. It does when the DM came to nothing
  // (they left the bot's DM, it was refused, the relay failed), so the news
  // still reaches them, once.
  if (dm && sender) {
    const dmSvc = require('./homeroom-bot-dm');
    let told = null;
    try {
      told = await dmSvc.relayIssuePost({ pool, ws, app, issueNumber, kind, runId, postId, bot: sender, dm });
    } catch (err) {
      log.warn('homeroom-bot', 'DM relay failed (post kept)', { app: app.slug, issueNumber, kind, err: err.message });
    }
    if (tagged.length) {
      try {
        const quiet = await dmSvc.untaggedRequester(pool, { appId: app.id, issueNumber, bot: sender, told });
        if (quiet) tagged = tagged.filter((n) => String(n).toLowerCase() !== quiet.toLowerCase());
      } catch (err) {
        log.warn('homeroom-bot', 'Could not check the DM recipient (tagging as before)', { app: app.slug, issueNumber, err: err.message });
      }
    }
  }
  const handles = tagged.map((n) => `@${n}`).join(' ');
  // The person who filed the issue is named in the thread only. On GitHub a
  // platform username is never written as an @mention (#723: it would
  // notify whoever owns that handle there), and GitHub already notifies the
  // author of an issue opened there about comments on it.
  const threadText = handles ? `${handles} ${text}` : text;
  try {
    // A spec is a card in the thread (its full text is on GitHub, and one
    // click away from the card), not a wall of markdown in a chat bubble.
    message = threadMessage && sender
      ? await ws.sendBotMessage(pool, app.id, {
        user: sender, content: handles ? `${handles} ${threadMessage.content}` : threadMessage.content,
        metadata: threadMessage.metadata,
        thread: { type: 'issue', ref: issueNumber }, msgType: threadMessage.msgType,
      })
      : await inThread(threadText, { type: 'issue', ref: issueNumber });
  } catch (err) {
    log.warn('homeroom-bot', 'Thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  // A system message fires no mention notifications of its own, so the
  // mention row is written here, as the "needs a conversation" prompt does
  // (conversation-prompt.js). Only for the people it tags: the content
  // handed over is their handles alone, never the message, whose
  // model-written text could name anybody.
  let notified = 0;
  if (handles && message?.id) {
    try {
      const notify = notifications || require('./notifications');
      const rows = await notify.createMentionNotifications(pool, {
        appId: app.id, chatMessageId: message.id, senderId: senderId ?? sender?.id ?? null, content: handles,
      });
      await Promise.all(rows.map((row) => notify.hydrateAndPush(pool, row)));
      notified = rows.length;
    } catch (err) {
      log.warn('homeroom-bot', 'Poster mention failed (post kept)', { app: app.slug, issueNumber, kind, err: err.message });
    }
  }
  // #3264: a follow-up answers where it was asked. When somebody wrote in
  // the proposal's own discussion, the reply goes there too, as a message
  // from the bot (#3288).
  let proposalMessage = null;
  if (proposalSessionId) {
    try {
      proposalMessage = await inThread(text, { type: 'session', ref: Number(proposalSessionId) }, null, 'system');
    } catch (err) {
      log.warn('homeroom-bot', 'Proposal thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
    }
  }
  await pool.query(
    `UPDATE homeroom_bot_posts SET github_comment_id = $2, thread_message_id = $3
      WHERE id = $1`,
    [postId, comment?.id ?? null, message?.id ?? null],
  ).catch(() => {});
  log.info('homeroom-bot', 'Posted on issue', {
    app: app.slug, issueNumber, kind, github: !!comment, thread: !!message,
    ...(tagged.length ? { mentioned: tagged, notified } : {}),
    ...(proposalSessionId ? { proposalThread: !!proposalMessage } : {}),
  });
  return { postId, githubCreatedAt: comment?.created_at || null, github: !!comment, thread: !!message };
}

/**
 * One message from the bot in a proposal's own discussion, recorded like
 * every post (homeroom_bot_posts) but said nowhere else: no GitHub comment
 * and nothing in the issue's thread. For news that is the proposal's alone,
 * such as a revision that fixed its failing checks. Never throws on the
 * send; resolves { postId, thread }.
 */
async function postOnProposal({ pool, ws, app, issueNumber, runId = null, kind, text, bot, sessionId }) {
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [app.id, issueNumber, runId, kind],
  );
  const postId = rows[0]?.id ?? null;
  let message = null;
  try {
    message = await ws.sendBotMessage(pool, app.id, {
      user: bot, content: text, thread: { type: 'session', ref: Number(sessionId) },
    });
  } catch (err) {
    log.warn('homeroom-bot', 'Proposal thread post failed (continuing)', { app: app.slug, issueNumber, kind, err: err.message });
  }
  if (postId && message?.id) {
    await pool.query('UPDATE homeroom_bot_posts SET thread_message_id = $2 WHERE id = $1', [postId, message.id])
      .catch(() => {});
  }
  log.info('homeroom-bot', 'Posted on its proposal', { app: app.slug, issueNumber, kind, sessionId, thread: !!message });
  return { postId, thread: !!message };
}

/**
 * #3693: the bot's GitHub comments on this issue that its Homeroom thread
 * already carries, as GitHub comment ids (strings: the column is a BIGINT,
 * which pg hands back as text). `post` says everything in both places, and
 * the request page, which draws both threads, leaves these out of its
 * GitHub half (routes/issues.js withoutBotThreadCopies). Only a post whose
 * copy in THIS issue's thread landed and still stands: when the thread send
 * failed, or the message was deleted, the GitHub comment is the one place
 * it was said, and it stays. GitHub itself keeps every comment.
 */
async function threadCopiedCommentIds(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT p.github_comment_id
       FROM homeroom_bot_posts p
       JOIN chat_messages m
         ON m.id = p.thread_message_id AND m.app_id = p.app_id
        AND m.thread_type = 'issue' AND m.thread_ref = p.issue_number
        AND m.deleted_at IS NULL
      WHERE p.app_id = $1 AND p.issue_number = $2 AND p.github_comment_id IS NOT NULL`,
    [appId, issueNumber],
  );
  return new Set(rows.map((r) => String(r.github_comment_id)));
}

/**
 * The GitHub account the bot comments as, or null when it cannot be read.
 * `github.getBotUsername()` is async. Used unawaited, the Promise reached
 * the triage seed, where tagging a GitHub comment called .toLowerCase() on
 * it and threw; live mode posts its "looking" comment before triaging, so
 * every live run failed there (rss-reader #24, 2026-09-25). Here it also
 * read as "[object promise]", which no comment author matches.
 */
async function botUsernameOf(github) {
  try {
    const login = await github.getBotUsername?.();
    return typeof login === 'string' && login ? login : null;
  } catch {
    return null;
  }
}

/**
 * Record what the bot has now seen of this issue, so its own GitHub comment
 * does not read as a change on the next refresh — unless somebody else
 * posted while it worked, in which case the issue is left to be looked at
 * again. `since` is when the run read the thread.
 */
async function advanceSeen({
  pool, github, threadContext, app, repo, issueNumber, runId, since, postedAt, proposalSessionId = null,
}) {
  const times = (postedAt || []).filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!runId || !times.length) return { advanced: false, reason: 'nothing_posted' };
  const sinceMs = Date.parse(since);
  const [{ comments = [] } = {}, thread, login, proposalThread] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    botUsernameOf(github),
    // #3264: on a follow-up, the proposal's own discussion is a third place
    // a person can have replied while the bot worked.
    proposalSessionId
      ? threadContext.loadProposalThread(pool, app.id, proposalSessionId)
      : Promise.resolve({ messages: [] }),
  ]);
  const botLogin = String(login || '').toLowerCase();
  const newer = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) > sinceMs;
  // A comment this run posted is the bot's own whatever the login lookup
  // said: when it failed, the bot's own note read as a person's reply, and
  // the issue was triaged again minutes later (todo #78, #3509).
  const ours = new Set(times);
  const bots = (c) => ours.has(Date.parse(c.createdAt))
    || (!!botLogin && String(c.author || '').toLowerCase() === botLogin);
  const someoneElse = comments.some((c) => !bots(c) && newer(c.createdAt))
    || (thread?.messages || []).some((m) => !isOwnMessage(m) && newer(m.createdAt))
    || (proposalThread?.messages || []).some((m) => !isOwnMessage(m) && newer(m.createdAt));
  if (someoneElse) {
    log.info('homeroom-bot', 'Someone replied while the bot worked; leaving the issue to be read again', {
      app: app.slug, issueNumber,
    });
    return { advanced: false, reason: 'someone_replied' };
  }
  const seen = new Date(Math.max(...times)).toISOString();
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET thread_seen_at = GREATEST(COALESCE(thread_seen_at, $2::timestamptz), $2::timestamptz),
            posted_at = NOW()
      WHERE id = $1`,
    [runId, seen],
  );
  return { advanced: true, seen };
}

/** The bot's open proposal for this issue, if it already has one. */
async function openBotProposal(pool, botId, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT id, status, pr_number FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 AND $3 = ANY(linked_issues)
        AND status IN ('promoted', 'merging') AND is_headless = FALSE
      ORDER BY id DESC LIMIT 1`,
    [appId, botId, issueNumber],
  );
  return rows[0] || null;
}

// ── Proposing ────────────────────────────────────────────────────────────

let votesRouter = null;

/**
 * Run POST /api/sessions/:id/promote as the bot, in-process. Resolves the
 * status and JSON the route answered with; never throws.
 */
function promoteAsBot({ config, bot, sessionId, router = null, ceiling = null }) {
  const target = router || (votesRouter ||= require('../routes/votes').voteRoutes(config));
  const url = `/api/sessions/${Number(sessionId)}/promote`;
  return new Promise((resolve) => {
    let statusCode = 200;
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = {
      method: 'POST', url, originalUrl: url, baseUrl: '', path: url,
      headers: {}, query: {}, params: {}, body: {}, cookies: {},
      // The marker app-access and the membership gate honour for the bot's
      // own session only: it proposes on apps in its live list whether or
      // not it is a collaborator or member there. Never an admin.
      user: {
        id: bot.id, username: bot.username, is_admin: false, is_synthetic: true,
        [require('./app-access').HOMEROOM_BOT_PROPOSAL]: true,
        // Its own ceiling on proposals up for a vote, in place of the
        // per-user cap (#3576). Symbol-keyed for the same reason.
        ...(Number.isInteger(ceiling) && ceiling > 0
          ? { [require('./session-caps').BOT_PROMOTED_CEILING]: ceiling } : {}),
      },
      get() { return undefined; },
      header() { return undefined; },
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code) { statusCode = code; this.statusCode = code; return this; },
      json(body) { this.headersSent = true; done({ status: statusCode, body }); return this; },
      send(body) { this.headersSent = true; done({ status: statusCode, body }); return this; },
      end() { this.headersSent = true; done({ status: statusCode, body: null }); return this; },
      set() { return this; },
      setHeader() {},
      getHeader() { return undefined; },
    };
    try {
      target.handle(req, res, (err) => done({
        status: err ? 500 : 404,
        body: { error: err ? err.message : 'promote route not found' },
      }));
    } catch (err) {
      done({ status: 500, body: { error: err.message } });
    }
  });
}

// #3518: the proposal's summary, the text the group reads before it votes.
// The same block an OpenRouter dev chat turn ends with (#2820), parsed by
// proposal-description.js; prepareProposal files it where the promote route
// reads it.
const BUILD_DESCRIPTION_LINES = Object.freeze([
  '',
  'After the summary the rules above ask for, end your final message with a description of the change for the',
  'people who will vote on it, between these two marker lines:',
  '',
  '==== DESCRIPTION ====',
  'One or two short paragraphs, in plain language: what is different for someone using the app, what they can',
  'now do, or what stops going wrong.',
  '==== END DESCRIPTION ====',
  '',
  'Write it from what that person would notice, not from what you edited. No file names, code, commit hashes or',
  'test results: those belong in the summary above it. Skip the block only if you changed nothing.',
]);

// A build of the platform's own repository runs its tests the way that
// repository's AGENTS.md asks every agent to: the suites that pin what it
// changed, never the whole suite, which the platform runs on every proposal
// anyway. Half the platform's shadow builds ran out of time (2026-10-02),
// several in a mapped run of thousands of tests chasing failures that were
// not theirs. Said in the build prompt as well as in AGENTS.md because a
// build that reads past it loses its whole clock.
const PLATFORM_TEST_NOTE = Object.freeze([
  '',
  'This is the platform\'s own repository, which is large, and the platform runs its whole test suite on the',
  'proposal by itself. Do not run `npm test` or the whole suite. Run only the suites for the files you changed:',
  '`npm run test:changed -- --files <the files you changed, comma-separated>` (add `--list` first to see what it',
  'would run), or `node --test <test file>` for the test files that name them. If that maps to more than a few',
  'hundred tests because you changed shared code, run only the test files that name your changed files. A',
  'failure in a suite that does not read anything you changed is not yours: name it in your summary and move on.',
]);

// #3737: the bot's build writes every first version, and it was the one
// build on the platform given neither the UI design guidance (#2817) nor the
// in-loop browser's instructions: its worker had the browser, and it was
// never told how to boot the app in it. It gets the block the dev chat gives
// an OpenRouter turn, as written, with what differs for it said first, and
// one rule of its own: a change a person will see is looked at before the
// turn ends. How it looks follows the design self-check, by whether the
// model reads images.
function browserLines({ readsImages = false } = {}) {
  const look = readsImages
    ? 'take screenshots (`browser_take_screenshot`) of each changed screen'
    : 'walk each changed screen through its accessibility snapshot (`browser_snapshot`; you read text, not images)';
  return [
    '',
    'The in-loop browser, as the platform\'s dev chat describes it. For you, "commit" in it means finishing your turn,',
    'since your working tree is committed for you, and its TESTING block\'s `path:` lines are the routes your change',
    'shows on:',
    IN_LOOP_BROWSER_GUIDANCE,
    '- For you, the Homeroom bot, that visual check is EXPECTED, not optional, when the change is one a person will',
    '  see. Boot the app, then',
    `  ${look}`,
    '  at 390x844 and at a desktop width, in both looks (`?un-theme=light` and `?un-theme=dark`, unless the app keeps',
    '  one fixed look), and in its empty and error states. Fix what is wrong, and only then finish. Skip it only when',
    '  the app cannot boot promptly, and then say why in your summary. Stay within the time budget above.',
  ];
}

/**
 * #3767: what a revision of the bot's own proposal is told about design, as
 * its build was (#3748): the UI design guidance and the browser check. A
 * revision changes what people see as often as a build does, and was given
 * neither. Pure apart from the guidance file.
 */
function revisionDesignText({ readsImages = false } = {}) {
  return [
    'IF YOUR CHANGE TOUCHES WHAT PEOPLE SEE, build it with the UI design guidance every coding agent here uses,',
    'and look at it before you finish:',
    '',
    getDesignGuidance({ readsImages }),
    ...browserLines({ readsImages }),
  ].join('\n');
}

// #3737: an app's look, decided once and written down. A first version's
// spec decides it; its build records it where every later build reads the
// app's own instructions, the "## Design" section of its CLAUDE.md
// (services/template.js), and the design guidance tells every later build to
// follow that record. Before this, a look lived only in code (RSS Reader's
// palette) and each later change re-derived it, or drifted. Said before the
// build contract, so recording it is part of "that change" rather than an
// extra file the contract forbids.
//
// #3737 Rec2: the build no longer invents the palette's plumbing. Every new
// app's stylesheet carries the starter's design kit (semantic colour tokens
// for both looks, a few components, the loading, empty and error states), so
// the build re-points the tokens and builds with the kit. A starter other
// than Empty has the kit but no "## Design" section yet, hence "add it".
const FIRST_VERSION_DESIGN_LINES = Object.freeze([
  '',
  'This is the app\'s FIRST VERSION, so its look is not set yet: the spec\'s "### Design" subsection (or, without a',
  'spec, the plan) sets it, and the starter\'s screen and default colours are placeholder, not a look to copy. Build',
  'it with the starter\'s design kit (`styles/tailwind-input.css`): set its colour tokens to this app\'s accent and',
  'neutrals (a light and a dark value each, unless the app keeps one fixed look; every text pair at 4.5:1 or more),',
  'and use only those tokens and the kit\'s components, its loading, empty and error states included: the design',
  'guidance\'s "no new colours" means none beyond them. Then fill in the "## Design" section of the app\'s',
  '`CLAUDE.md` (add it if it is missing): the palette by name, the signature element, the type scale, and the one',
  'fixed look if the app keeps one. Every later change follows it.',
]);

function buildPrompt({
  seed, buildNote, spec = null, platformRepo = false, readsImages = false, firstVersion = false,
}) {
  const specBlock = spec
    ? [
      '',
      '==== SPEC (written for this request just before this build; authoritative for what to build) ====',
      '',
      String(spec),
      '',
      '==== END SPEC ====',
      '',
      'Build what the SPEC describes. The plan above is the triage\'s short version of it: where they differ,',
      'the spec wins. The repository\'s own agent instructions still come first.',
    ]
    : [];
  return [
    seed,
    '',
    ...screenshotNote(seed),
    'You are the Homeroom bot, building this request so the app\'s group can review it as a proposal.',
    'Your triage of the request concluded it is ready to build, with this plan:',
    '',
    clipText(buildNote, 4000) || '(no plan recorded: work from the request itself)',
    ...specBlock,
    ...(firstVersion ? FIRST_VERSION_DESIGN_LINES : []),
    '',
    // The rules every on-platform build works under (services/build-contract.js):
    // this bot's own list, which the dev chat now shares.
    buildContract.buildContractBlock({
      heading: 'Make exactly that change, and nothing else:',
      commits: 'harness',
    }),
    ...(platformRepo ? PLATFORM_TEST_NOTE : []),
    ...browserLines({ readsImages }),
    '',
    // #3737: the same design guidance the dev chat builds with (#2817).
    getDesignGuidance({ readsImages }),
    ...BUILD_DESCRIPTION_LINES,
  ].join('\n');
}

/**
 * #3737: whether the build's model can look at pictures, by OpenRouter's
 * catalog, decided as the Mayor decides it (homeroom-bot-mayor.js
 * modelSeesImages) with the key the turn itself runs on: the bot's, or a
 * benchmark trial's own user's. The design self-check then asks for
 * screenshots, and otherwise for the page's text snapshot. Anything unknown
 * is no. Never throws.
 */
async function buildSeesImages({ pool, config, userId, model }) {
  try {
    const credentialStore = require('./credential-store');
    const key = { provider: 'openrouter', purpose: 'coding_agent' };
    const meta = await credentialStore.readMetadata({ pool, userId, ...key });
    if (!meta || meta.status !== 'valid') return false;
    const apiKey = await credentialStore.readSecret({
      pool, userId, ...key, dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
    });
    if (!apiKey) return false;
    return await require('./homeroom-bot-mayor').modelSeesImages(pool, config, apiKey, model);
  } catch {
    return false;
  }
}

/**
 * Why a coding turn Claude Code ran failed, or null when it did not (or ran
 * in Codex). An OpenRouter model the platform maps to Claude Code (#3296)
 * runs in run-cc.sh, which commits and pushes whatever a turn leaves, even
 * when the agent failed partway: what a person's dev chat wants, and never
 * what the bot may propose. The Codex runner refuses to commit or push a
 * failed turn at all (run-codex-agent.sh), which is why a Codex turn needs
 * no check here and its outcome is exactly what it was. The bot's turns ask
 * run-cc.sh to do the same (`discardFailedTurn`); this is the host's half,
 * which also names the reason. Failed means the agent exited non-zero
 * (cc_exit, or the wrapper's exit code), its final result said is_error, or
 * its final message is the runtime's own "API Error" notice, which Claude
 * Code can end on with exit 0 (an OpenRouter 429 once its retries are
 * spent). run-cc.sh reads that notice with the same definition
 * (worker/agent-api-failure.js), so the worker and the host agree on which
 * turns failed.
 */
function failedClaudeTurn(result) {
  if (!result || result.agentHarness !== 'claude') return null;
  const exited = (code) => Number.isInteger(code) && code > 0;
  if (exited(result.ccExit)) return `the agent exited with code ${result.ccExit}`;
  if (result.ccIsError === true) return 'the agent reported an error';
  if (exited(result.exitCode)) return `the agent exited with code ${result.exitCode}`;
  if (agentApiFailure(result.lastResultText)) return 'it ended on an API error';
  return null;
}

/**
 * #3654: make a session run `model`. A turn runs whatever model its session
 * carries (agent-turn resolveCodexRuntimeContext reads session.agent_model),
 * and the bot's sessions were stamped once, when they were created: the
 * triage session per app kept the model it was born with however the setting
 * changed, while the run ledger recorded the new one. Writes the row and the
 * object the runtime is resolved from. Best-effort; a no-op when they agree
 * or there is no model to stamp.
 */
async function stampSessionModel(pool, session, model) {
  if (!session || !model || session.agent_model === model) return false;
  try {
    await pool.query('UPDATE chat_sessions SET agent_model = $2 WHERE id = $1', [session.id, model]);
    session.agent_model = model;
    return true;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not set the session\'s model', { sessionId: session.id, err: err.message });
    return false;
  }
}

/**
 * Build the change in a dev session of the bot's own and put it up for a
 * vote. Resolves { ok, sessionId, prNumber, costUsd, error }; never throws.
 */
/**
 * The spec turn: read-only, in the build's own session and worker, its
 * final message stored as the session's spec doc. Resolves
 * { ok, specMd, version, costUsd, error, stopped }; never throws. A spec
 * that fails is not a failed build: the build goes ahead from the plan.
 */
/**
 * A spec turn's final message, as the build will use it: unwrapped, started
 * at its title, and checked for the one way out and for a wire failure.
 * { ok, specMd } or { ok: false, error, blocked? }. Shared with the restart
 * recovery of a spec turn (#3401), which reads the same message back from
 * the turn's journal.
 */
function readSpec(text) {
  const specMd = specFromTitle(stripSpecWrapperFence(String(text || '').trim()));
  if (!specMd) return { ok: false, error: 'the spec turn returned nothing' };
  const blocked = specBlocked(specMd);
  if (blocked) return { ok: false, blocked, error: `blocked: ${blocked}` };
  // A run that died on the wire can report the failure as its final message,
  // which would otherwise be stored as the spec.
  if (agentApiFailure(specMd)) return { ok: false, error: 'the spec turn ended on an API error' };
  return { ok: true, specMd };
}

async function draftSpec({
  pool, config, bot, session, containerName, seed, buildNote, turnBudgetMs, model, deps,
  specBudgetMs = SPEC_TURN_MAX_MS, telemetryComponent = 'homeroom_bot_spec', firstVersion = false,
}) {
  const { worker, sessions, agentTurn, activeWorkers } = deps;
  const budgetMs = Math.min(turnBudgetMs, specBudgetMs);
  const progress = lastActivity();
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, budgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  activeWorkers.add(session.id);
  const prompt = specPrompt({ seed, buildNote, firstVersion });
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'scout',
      telemetryComponent,
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
        // The platform's per-model choice of CLI, as the dev chat's scout
        // makes it (#3296): GLM runs in Claude Code.
        harness: 'auto',
      }),
      dispatchOnce: (ctx) => worker.execInWorker(session.id, {
        mode: 'scout',
        prompt,
        model,
        commitMsg: '',
        resumeSessionId: null,
        branchName: session.branch_name,
        ...(ctx || {}),
        telemetryComponent,
        onProgress: progress.note,
      }),
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
  }
  const costUsd = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  if (stopped) return { ok: false, stopped: true, costUsd, error: `the spec ran past its time limit${progress.suffix()}` };
  if (!routed) return { ok: false, costUsd, error: 'the spec turn did not run' };
  if (routed.error) return { ok: false, costUsd, error: `the spec turn failed (${routed.error})` };
  const read = readSpec(routed.result?.lastResultText);
  if (!read.ok) return { ...read, costUsd };
  const { specMd } = read;
  const version = await publishSpec({ pool, sessions, session, specMd, model });
  return { ok: true, specMd, version, costUsd };
}

/**
 * Store a spec on its build's session with the same three effects a
 * person's scout has: spec_md, a numbered version, and the spec card in the
 * session's own transcript. Resolves the version, or null when it could not
 * be stored (the build goes on from the spec either way).
 */
async function publishSpec({ pool, sessions, session, specMd, model }) {
  try {
    const published = await sessions.persistScoutPublication({
      pool, sessionId: session.id, content: specMd, hadSpec: false,
      agentBackend: 'codex_openrouter', agentModel: model,
    });
    return published?.specVersion ?? null;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not store the spec; building from it anyway', { sessionId: session.id, err: err.message });
    return null;
  }
}

async function buildAndPropose({
  pool, config, bot, app, repo, issueNumber, issue, seed, buildNote,
  turnBudgetMs, model, deps, propose = true, onSpec = null, specBudgetMs = SPEC_TURN_MAX_MS,
  onSession = null, presetSpec = null, proposalCeiling = null, platformRepo = false,
  // #3654: the spec turn's own model, when it differs from the build's;
  // and, for a benchmark trial, its own session title and telemetry.
  specModel = null, sessionTitle = null, telemetry = null,
  // #3737: a project's first version, whose spec and build decide and
  // record its look.
  firstVersion = false,
  // WP1 (#2): resolves why this build should stop where it is, or null to
  // go on (homeroom-bot.js whyNotBuild). Asked once the plan is written,
  // before the build turn, and again once the build turn is over, just
  // before it is proposed. A reason ends the build there: its session put
  // away, nothing proposed, and `skipped` on the result.
  skipCheck = null,
}) {
  const { worker, sessions, agentTurn, sessionLifecycle, activeWorkers } = deps;
  const title = clipText(issue?.title || `Issue #${issueNumber}`, 120);
  // A shadow build (`propose: false`) is the same build, on a session of the
  // bot's own that links no issue, so no board reads it as work under way
  // on one, and that is archived the moment the build ends. Its branch is
  // the only thing it leaves, on the app's repository, for spot checks.
  let session;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, issue_link_seeded,
                                  session_title, agent_backend, agent_provider, agent_model,
                                  agent_reasoning_effort)
       VALUES ($1, $2, NULL, 'active', FALSE, $3,
               CASE WHEN $3::int IS NULL THEN '{}'::int[] ELSE ARRAY[$3::int] END, TRUE, $4,
               'codex_openrouter', 'openrouter', $5, $6)
       RETURNING *`,
      [app.id, bot.id, propose ? issueNumber : null,
        sessionTitle || `${propose ? 'Homeroom bot' : 'Homeroom bot shadow build'}: #${issueNumber} ${title}`,
        model, config.openrouterDefaultCodexReasoning || 'low'],
    );
    session = rows[0];
    session.app_slug = app.slug;
    session.app_name = app.name;
    session.repo_url = app.repo_url;
    session.app_self_hosted = app.self_hosted;
  } catch (err) {
    return { ok: false, error: `could not open a session: ${err.message}` };
  }
  // The caller's durable link to this session, written before any turn runs:
  // a restart mid-turn leaves the worker running, and restart recovery finds
  // the run it belongs to through this (#3401).
  if (onSession) {
    try {
      await onSession(session);
    } catch (err) {
      log.warn('homeroom-bot', 'Could not link the build session to its run', { sessionId: session.id, err: err.message });
    }
  }

  // What the spec turn wrote, carried on every outcome below so a run that
  // failed to build still shows what it meant to build. A spec that failed
  // (not one that found the request impossible) is carried as `specNote`,
  // so the run records why the build worked from the plan alone.
  let spec = null;
  const specOut = () => {
    if (spec?.ok) return { specMd: spec.specMd, specVersion: spec.version };
    if (spec && !spec.blocked && spec.error) return { specNote: `no spec (${spec.error}); the build worked from the plan` };
    return {};
  };
  const fail = async (error) => {
    // The bot's own failed attempt. Archived so it never reads as work
    // under way; its branch stays on GitHub for a person to look at.
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`,
      [session.id, bot.id],
    ).catch(() => {});
    return { ok: false, sessionId: session.id, branchName: session.branch_name || null, error, ...specOut() };
  };
  // A skip is put away as a failed attempt is, and says why it stopped.
  const skipNow = async () => {
    if (!skipCheck) return null;
    try {
      return (await skipCheck()) || null;
    } catch (err) {
      log.warn('homeroom-bot', 'Could not check whether the build is still wanted (going on)', { sessionId: session.id, err: err.message });
      return null;
    }
  };

  let branchName;
  try {
    ({ branchName } = await sessionLifecycle.ensureSessionBranch({
      pool, sessionId: session.id, username: bot.username,
    }));
    session.branch_name = branchName;
  } catch (err) {
    return fail(`could not create its branch: ${err.message}`);
  }

  // The request, as the proposal's pull request metadata reads it: the
  // promote route drafts the title and body from the session's last user
  // message. Its "Build issue #N:" line is scaffolding, peeled off wherever
  // a name is derived from it (session-title.js parseIssueSeed, #3518), and
  // the name the bot proposes under is the spec's (prepareProposal).
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [session.id, `Build issue #${issueNumber}: ${title}\n\n${clipText(buildNote, 4000)}`],
  ).catch(() => {});

  let containerName;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName,
      temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return fail(`the worker would not start: ${err.message}`);
  }

  // A spec already written, by a spec turn a restart interrupted and
  // recovery finished (#3401), is built from as it is, not written again.
  // A live build's (`propose`) was never said: the process that wrote it
  // went with the restart before it could post it. So it is stored on this
  // session and said below, once, as a spec just written would be.
  if (!presetSpec && specModel && specModel !== model) await stampSessionModel(pool, session, specModel);
  spec = presetSpec
    ? {
      ok: true, specMd: String(presetSpec), costUsd: null, preset: true,
      version: propose ? await publishSpec({ pool, sessions, session, specMd: String(presetSpec), model: specModel || model }) : null,
    }
    : await draftSpec({
      pool, config, bot, session, containerName, seed, buildNote, turnBudgetMs,
      model: specModel || model, deps, specBudgetMs, firstVersion,
      ...(telemetry ? { telemetryComponent: telemetry } : {}),
    });
  // The build turn runs the build's model again.
  await stampSessionModel(pool, session, model);
  if (spec.blocked) {
    // Impossible as written: nothing is built, and the caller says why.
    log.info('homeroom-bot', 'The spec found the request impossible; not building', {
      sessionId: session.id, why: spec.blocked,
    });
    return { ...(await fail(spec.error)), blocked: spec.blocked, costUsd: spec.costUsd };
  }
  // WP1 (#2): before its plan is posted and the build turn starts, which a
  // stopped spec turn (noteRequestMerged stops one) would otherwise go on to.
  const skippedEarly = await skipNow();
  if (skippedEarly) return { ...(await fail(skippedEarly)), skipped: skippedEarly, costUsd: spec.costUsd ?? null };
  if (spec.ok) {
    if (onSpec && (!spec.preset || propose)) {
      // Posted, not waited on: the build starts whatever happens to the post.
      try {
        await onSpec({ sessionId: session.id, version: spec.version, specMd: spec.specMd });
      } catch (err) {
        log.warn('homeroom-bot', 'Posting the spec failed (building anyway)', { sessionId: session.id, err: err.message });
      }
    }
  } else {
    log.warn('homeroom-bot', 'No spec; building from the plan', { sessionId: session.id, error: spec.error });
    if (spec.stopped) {
      // Stopping a turn takes its container down with it.
      try {
        containerName = await worker.ensureWorker(session.id, {
          repoOwner: repo.owner, repoName: repo.repo, branchName,
          temporary: true, onProgress: () => {},
        });
      } catch (err) {
        return { ...(await fail(`the worker would not start: ${err.message}`)), costUsd: spec.costUsd };
      }
    }
  }

  // A spec stopped on its clock leaves the session's stop pending, and the
  // worker skips every dispatch until a new turn clears it (#937). Without
  // this, the build after a spec time-out was skipped at once and recorded
  // as "no change to propose" (#3396). Cleared before the build's own clock
  // starts, so a stop aimed at the build is never the one erased.
  worker.clearPendingStop?.(session.id);

  // Read before the build's clock starts: a catalog read is not build time.
  const readsImages = typeof deps.seesImages === 'boolean'
    ? deps.seesImages
    : await buildSeesImages({ pool, config, userId: bot.id, model });

  // The same wall clock a triage turn has, ended the same way.
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, turnBudgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  activeWorkers.add(session.id);
  const prompt = buildPrompt({
    seed, buildNote, spec: spec.ok ? spec.specMd : null, platformRepo, readsImages, firstVersion,
  });
  // What the build was last doing, so a turn stopped on its clock says what
  // it was waiting on (#3385): 12 of the first 18 shadow failures were
  // time-outs, most of them cheap, with nothing recorded about why.
  const progress = lastActivity();
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'build',
      telemetryComponent: telemetry || 'homeroom_bot_build',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
        // The dev chat's build makes the same choice (#3296). The bot's
        // build works as it is under either CLI: the worker, not the agent,
        // commits and pushes what the turn leaves (buildPrompt's commits:
        // 'harness'; both runners use worker/session-branch.sh), and an
        // OpenRouter build needs no handbook as system context in either
        // (run-cc.sh).
        harness: 'auto',
      }),
      dispatchOnce: (ctx) => worker.execInWorker(session.id, {
        mode: 'build',
        prompt,
        model,
        commitMsg: `Homeroom bot: #${issueNumber} ${title}`.slice(0, 120),
        resumeSessionId: null,
        branchName,
        // A failed turn's work is neither committed nor pushed, under either
        // CLI (failedClaudeTurn).
        discardFailedTurn: true,
        ...(ctx || {}),
        telemetryComponent: telemetry || 'homeroom_bot_build',
        onProgress: progress.note,
      }),
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1 AND status = 'active'",
      [session.id],
    ).catch(() => {});
  }

  const result = (routed && routed.result) || {};
  const buildCostUsd = Number.isFinite(routed && routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  // Both turns, the spec's and the build's, are the build's cost.
  const costUsd = buildCostUsd == null && spec.costUsd == null
    ? null
    : (buildCostUsd || 0) + (spec.costUsd || 0);
  // WP1 (#2): and once the build turn is over, whatever it came to, just
  // before it is proposed. A build stopped for this (noteRequestMerged ends
  // its turn) is a skip, not a failure.
  const skipped = await skipNow();
  if (skipped) return { ...(await fail(skipped)), skipped, costUsd };
  if (stopped) {
    return { ...(await fail(`the build ran past its time limit${progress.suffix()}`)), costUsd };
  }
  if (routed?.error) return { ...(await fail(`the build turn failed (${routed.error})`)), costUsd };
  // A failed turn is a failed build, whatever it left behind (failedClaudeTurn).
  const turnFailed = failedClaudeTurn(result);
  if (turnFailed) return { ...(await fail(`the build turn failed (${turnFailed})`)), costUsd };
  if (!result.pushOk || !(Number(result.ahead) > 0)) {
    return { ...(await fail('the build produced no change to propose')), costUsd };
  }

  if (!propose) {
    // Built, pushed, and put away: the session is archived exactly as a
    // failed attempt is, and nothing is promoted, posted or shown.
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')`,
      [session.id, bot.id],
    ).catch(() => {});
    return {
      ok: true, sessionId: session.id, branchName: session.branch_name,
      sha: result.sha || null, commits: Number(result.ahead) || 0, costUsd, ...specOut(),
    };
  }

  // What the build pushed, recorded on a live run as a shadow build's is (#3509).
  const pushed = { branchName: session.branch_name, sha: result.sha || null, commits: Number(result.ahead) || 0 };
  // Named and described first: the route reads both as it opens the pull
  // request (#3518).
  await prepareProposal({
    pool, bot, sessionId: session.id, spec: spec.ok ? spec.specMd : null,
    buildText: result.lastResultText, model,
  });
  const promoted = await promoteAsBot({
    config, bot, sessionId: session.id, router: deps.votesRouter || null, ceiling: proposalCeiling,
  });
  if (promoted.status !== 200 || !promoted.body?.ok) {
    const why = promoted.body?.error || promoted.body?.message || `promotion answered ${promoted.status}`;
    // Built but not proposed: the branch holds the work. Left paused, not
    // archived, so a person can open the session and propose it.
    log.warn('homeroom-bot', 'Built but could not propose', { app: app.slug, issueNumber, sessionId: session.id, why });
    return {
      ok: false, sessionId: session.id, ...pushed, costUsd,
      error: `the change was built but could not be proposed: ${why}`, ...specOut(),
    };
  }
  return { ok: true, sessionId: session.id, prNumber: promoted.body.prNumber || null, ...pushed, costUsd, ...specOut() };
}

module.exports = {
  askerOf,
  creditedDescription,
  BOT_USERNAME,
  isOwnMessage,
  isLiveFor,
  liveScope,
  appsScope,
  scopeIsEmpty,
  inScope,
  isStaging,
  lookingText,
  questionText,
  personText,
  emptyText,
  proposalText,
  buildFailedText,
  heldText,
  heldKind,
  lastPostKind,
  proposalLink,
  tagsPoster,
  issuePoster,
  mentionTargets,
  recordMentionOptOuts,
  clearMentionOptOuts,
  applyMentionAsks,
  parseStopMentioning,
  MAX_MENTIONS,
  post,
  postOnProposal,
  threadCopiedCommentIds,
  advanceSeen,
  botUsernameOf,
  openBotProposal,
  promoteAsBot,
  prepareProposal,
  proposalTitle,
  specUserFacing,
  buildDescription,
  buildPrompt,
  buildSeesImages,
  revisionDesignText,
  FIRST_VERSION_DESIGN_LINES,
  PLATFORM_TEST_NOTE,
  screenshotNote,
  buildAndPropose,
  failedClaudeTurn,
  stampSessionModel,
  draftSpec,
  specPrompt,
  specTitle,
  specSnippet,
  specCommentText,
  specCard,
  specBlocked,
  specFromTitle,
  blockedText,
  shareSpecVersion,
  postSpecOnProposal,
  SPEC_TURN_MAX_MS,
  readSpec,
  MAX_SPEC_COMMENT_CHARS,
};
