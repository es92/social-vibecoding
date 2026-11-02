'use strict';

// #3692: the activity tray in a person's DM with the Homeroom bot.
//
// The DM already carries the bot's news one message at a time (homeroom-
// bot-dm.js): a question, "I'm building this now", the proposal, live. What
// it could not show is the state in between: what the bot is doing for this
// person right now, and what it has done for them before. The tray in the
// DM (frontend/src/features/messages/bot-work.tsx: a status line in the
// chat header that opens a panel of tiles) is that, read from the
// platform's own records of the bot's work and nothing else. ONE ENTRY PER
// REQUEST, in the first group that fits:
//
//   - NOW: what the bot has in hand for this person, exactly as its own
//     answer to "how far along are you?" reads it (homeroom-bot-progress.js,
//     its entries that are inFlight): a project of theirs being set up, a
//     request it is reading, planning, building or opening a proposal for,
//     a follow-up on its proposal running or waiting its turn, a request
//     waiting in its queue, a proposal being merged. #3734: the tray used to
//     read claimed queue rows alone, and a request leaves the queue once it
//     has been read, before its plan and build, so for a whole build, and for
//     a follow-up waiting its turn, the tray said "not working on anything"
//     while the bot said it was. Each carries its step of the request's
//     steps, as the activity cards in the transcript do.
//   - NEEDS YOU: what waits on this person. What the bot's progress says is
//     waiting on them (a question of the bot's still open in the DM, a new
//     project waiting for its secrets), and any other request whose newest
//     run ended in a way the activity cards call "Needs you": a question
//     asked, a request it cannot build as written, nothing to build in it.
//   - HISTORY: everything else the bot ran on their requests
//     (homeroom_bot_runs), the request's newest news first, each with what
//     came of it and where to open it: the proposal once there is one people
//     can open, else the request.
//
// Every entry carries the request's other runs as `earlier`, so a request
// the bot came back to five times is one entry with four earlier runs, not
// five rows that look alike. A first version's plan that a newer plan
// replaced before Build it (Change something, a new look) is not one of
// them (planOnly): to its creator it was the plan being updated, and the
// tray used to show a newcomer's two plans as "2 earlier runs" beside the
// build (first session, 4 October).
//
// ONE VOCABULARY. What a run came to is said in the activity cards' words
// (homeroom-bot-activity.js OUTCOMES): a build held back by a cap is
// `held`, not the verdict it would have sent; a build that could not go
// ahead as the request is written is `blocked`, not a failed build.
//
// ONE PERSON'S, ALWAYS. Every query here is keyed by the signed-in user's id
// and nothing else: the route takes no user parameter, so there is no way to
// ask for somebody else's work. A request is theirs the way the bot decides
// it everywhere else: recorded for them in homeroom_bot_requesters, or, for
// one the loop has not recorded yet, an issue they filed on Homeroom (the
// same rule as homeroom-bot.js workingNow). An app they can no longer view is
// left out, whatever the records say.
//
// NOW is drawn from the same records as the bot's own answer to "how far
// along are you?" (progressFor), so the two cannot disagree; only the shape
// differs: that one is words for a model to read, this one tiles for a
// screen to draw.
//
// LIVE: the client reads it again when the bot's news lands in the DM (the
// conversation's own realtime event) and when the live loop starts or ends a
// piece of work for this person, which `noteWorkChanged` announces on their
// event sockets as `homeroom_bot_work_changed` (no payload: the client re-reads
// this endpoint under its own session, as Messages does for every event).

const log = require('./logger');
const appAccess = require('./app-access');
const progressSvc = require('./homeroom-bot-progress');
const activitySvc = require('./homeroom-bot-activity');
const { changeHref } = require('./change-destination');
const { firstVersionSql } = require('./first-version-rule');

// The most requests History lists.
const HISTORY_LIMIT = 30;
// The most jobs "now" can show (the bot works on a few at once for anybody).
const NOW_LIMIT = 10;
// The most of the bot's runs one read looks through, newest first, and the
// most earlier runs one entry carries.
const RUN_LIMIT = 150;
const EARLIER_LIMIT = 5;

// The step an in-flight progress stage is drawn as (bot-work.tsx words each).
// Every stage in progress.IN_FLIGHT_STAGES has one.
const PHASE_OF_STAGE = Object.freeze({
  setting_up: 'setting_up',
  queued: 'queued',
  build_queued: 'queued',
  reading: 'looking',
  starting: 'building',
  planning: 'building',
  building: 'building',
  reviewing: 'building',
  proposing: 'building',
  followup_queued: 'follow_up_queued',
  fix_queued: 'follow_up_queued',
  revising: 'following_up',
  fixing: 'following_up',
  merging: 'merging',
});
const PHASES = Object.freeze([...new Set(Object.values(PHASE_OF_STAGE))]);
// The phases that are about the bot's proposal, which is where they open.
const PROPOSAL_PHASES = new Set(['follow_up_queued', 'following_up', 'merging']);

// What a run came to: the activity cards' words, every one of them.
const OUTCOMES = activitySvc.OUTCOMES;
// The endings that wait on the person: the cards' "Needs you".
const NEEDS_YOU = new Set(['question', 'blocked', 'empty']);
// #5009: the endings that wait on the person whatever they were waiting
// for, so that a closed request can leave Needs you under all of them.
const WAITS_ON_PERSON = new Set([...NEEDS_YOU, 'person', 'build_failed', 'failed']);
// #8 (WP3): what a History entry says when none of its runs has come to
// anything yet (the bot is switched off, or a build has gone quiet), in
// place of an ending it has not had.
const NOT_FINISHED = 'not finished yet';

// A proposal people can open: the same states shared-objects.js lets anybody
// who can view the app open the bot's proposal in.
const OPENABLE_PROPOSAL = new Set(['promoted', 'merging', 'merged']);
// A proposal that ended without merging: closed, or withdrawn (archived:
// set aside by the vote, withdrawn from the DM, or replaced by another
// proposal for the same request).
const CLOSED_PROPOSAL = new Set(['closed', 'archived']);

function settingsModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }
// One track per request (16 Oct 2026), worked out from what this module reads.
function trackSvc() { return require('./homeroom-bot-track'); }

function issueHref(slug, issueNumber) {
  return `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}`;
}

// #4367: by its pull request's number once it has one.
function proposalHref(slug, sessionId, prNumber = null) {
  return changeHref(slug, sessionId, prNumber);
}

function projectHref(slug) {
  return `#app/${encodeURIComponent(slug)}/app`;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Pure: the one key a request goes by here, whichever record it came from. */
function keyOf(slug, issueNumber) {
  return `${slug}#${Number(issueNumber) || 'first'}`;
}

/** Pure: where an entry's links go: its request, its proposal, or (with no request) its project. */
function linksFor(slug, issueNumber, proposalId, prNumber = null) {
  const request = Number(issueNumber) ? issueHref(slug, issueNumber) : null;
  return {
    request,
    proposal: proposalId ? proposalHref(slug, proposalId, prNumber) : null,
    project: request ? null : projectHref(slug),
  };
}

/** Pure: who an entry is about, from one of progressFor's entries. */
function jobOfEntry(item) {
  const firstVersion = !!item.firstVersion;
  const issueNumber = Number(item.number) || null;
  return {
    key: keyOf(item.project, issueNumber),
    appSlug: item.project,
    appName: item.projectName || item.project,
    issueNumber,
    title: firstVersion ? null : (item.title || null),
    firstVersion,
  };
}

/**
 * Pure: one of progressFor's in-flight entries as an entry of Now, or null
 * for an entry that is not in flight. It opens its proposal while the step
 * is about the proposal, its request otherwise, and a project being set up
 * its project; its step of the request's steps is the one the activity
 * cards draw.
 */
function jobOfProgress(item) {
  const phase = progressSvc.inFlight(item) ? PHASE_OF_STAGE[item.stage] : null;
  if (!phase || !item.project) return null;
  const job = jobOfEntry(item);
  const proposalId = PROPOSAL_PHASES.has(phase) ? Number(item.proposal?.proposal) || null : null;
  const links = linksFor(item.project, job.issueNumber, proposalId);
  const stepped = Number.isInteger(item.step) && Number.isInteger(item.of) && item.step > 0 && item.step <= item.of;
  return {
    ...job,
    phase,
    stage: item.stage,
    step: stepped ? item.step : null,
    of: stepped ? item.of : null,
    stepName: stepped ? item.stepName || null : null,
    doing: item.doing || null,
    since: iso(item.since),
    href: links.proposal || links.request || links.project,
    links,
    earlier: [],
  };
}

/**
 * Pure: what one live run came to, in the activity cards' words, or null
 * for a build nothing has finished yet. A ready verdict is told by its
 * build: the proposal it opened (and where that went), or a build that did
 * not go ahead. A verdict a cap held back was never sent.
 */
function outcomeOf(row) {
  if (row.cap_suppressed) return 'held';
  switch (row.verdict) {
    case 'ready':
      if (row.proposal_session_id) {
        if (row.proposal_status === 'merged') return 'live';
        // #4227: merged, not running in production yet (pastRuns).
        if (row.proposal_status === 'merging') return 'going_live';
        if (CLOSED_PROPOSAL.has(row.proposal_status)) return 'closed';
        // D1: a project's first version goes live without a vote once its
        // checks pass: it is being tested until it merges, never waiting
        // for anyone's approval.
        return row.first_version_change === true ? 'checking' : 'proposed';
      }
      if (row.build_ok === true) return 'proposed';
      if (row.build_ok === false) {
        // Its request was closed before its build started: it stopped.
        if (/^skipped:/.test(String(row.build_error || ''))) return 'stopped';
        return /^blocked:/.test(String(row.build_error || '')) ? 'blocked' : 'build_failed';
      }
      return null;
    case 'question': case 'person': case 'empty': case 'failed': case 'answer': case 'revise':
      return row.verdict;
    default:
      return 'failed';
  }
}

/** Pure: when what a run came to happened: a proposal's own moments, else the run. */
function atOf(row, outcome) {
  if (outcome === 'live') return iso(row.merged_at) || iso(row.proposal_at) || iso(row.created_at);
  if (outcome === 'proposed' || outcome === 'checking' || outcome === 'going_live' || outcome === 'closed') return iso(row.proposal_at) || iso(row.created_at);
  return iso(row.created_at);
}

/** Pure: where a run opens. Its proposal once people can open it, else its request. */
function hrefOf(row) {
  if (row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)) {
    return proposalHref(row.slug, row.proposal_session_id, row.proposal_pr_number);
  }
  return row.issue_number ? issueHref(row.slug, row.issue_number) : projectHref(row.slug);
}

/**
 * Pure: whether a run was only a first version's plan, replaced before Build
 * it was tapped (pastRuns' `plan_only`). Not an earlier run of its own.
 */
function planOnly(row) {
  return row.plan_only === true;
}

/** Pure: a run as one of an entry's earlier runs. A build still going reads as one that stopped. */
function runOf(row) {
  const outcome = outcomeOf(row) || 'stopped';
  return { id: Number(row.id), outcome, at: atOf(row, outcome) };
}

/**
 * Pure: the runs of `rows` (newest first) by request, each request's runs
 * newest first, in the order its newest run came.
 */
function groupRuns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row.slug, row.issue_number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function ms(value) {
  if (!value) return NaN;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Pure (#8, WP3): the run whose ending is a request's news, from its runs,
 * newest first. Once the request went live, that is: a second build of it
 * begun before then, withdrawn or stopped, read as its last news after it
 * was live (a run begun after it went live is new work, and is the news).
 * Otherwise the newest run, unless it has come to nothing yet (a build still
 * going, or waiting its turn, that Now does not show): History used to lead
 * with that as "stopped", and the header said "Last: stopped on Plant Pal
 * #3" while the bot was still building it. Then a proposal of the request's
 * still up for a vote is its news; an older ending it has moved past (a
 * question since answered) is not, and the unfinished run leads, saying so.
 */
function leadOf(runs) {
  const newest = runs[0];
  const settled = runs.filter((row) => outcomeOf(row));
  const live = settled.find((row) => outcomeOf(row) === 'live');
  if (live) {
    const wentLive = ms(live.merged_at);
    const since = Number.isFinite(wentLive) ? settled.find((row) => ms(row.created_at) > wentLive) : null;
    if (!since) return live;
  }
  if (outcomeOf(newest)) return newest;
  return settled.find((row) => ['proposed', 'going_live'].includes(outcomeOf(row))) || newest;
}

/**
 * Pure: one request's runs (newest first) as an entry of Needs you or
 * History: what came of it last, when, where it opens, and its other runs.
 * A follow-up's answer on a proposal that has since been merged or closed
 * is not the news: the proposal's end is. A request none of whose runs has
 * come to anything yet says so, never that it stopped.
 */
function entryOfRuns(runs) {
  const newest = runs[0];
  const withProposal = runs.find((row) => row.proposal_session_id);
  let lead = leadOf(runs);
  if (withProposal && withProposal !== lead && ['answer', 'revise'].includes(lead.verdict)
    && (withProposal.proposal_status === 'merged' || CLOSED_PROPOSAL.has(withProposal.proposal_status))) {
    lead = withProposal;
  }
  let outcome = outcomeOf(lead);
  // #4539, widened by #5009: the request itself was closed while its newest
  // run still waited on its person (a plan waiting for Build it, a question
  // still open, a look that found nothing to build, a build it cannot do as
  // written, a decision it asked for, one that failed): the work stopped,
  // which is History's news, not Needs you. Its earlier runs keep their own
  // words (runOf).
  const requestClosed = newest.request_closed === true;
  if (requestClosed
    && (WAITS_ON_PERSON.has(outcome) || (!outcome && lead.awaiting_go_at))) {
    outcome = 'stopped';
  }
  // The newest run, still going, is not one of its earlier runs either.
  const going = outcomeOf(newest) ? null : newest;
  const proposalRow = withProposal && OPENABLE_PROPOSAL.has(withProposal.proposal_status) ? withProposal : null;
  const firstVersion = !!newest.first_version;
  const issueNumber = Number(newest.issue_number) || null;
  const links = linksFor(newest.slug, issueNumber, proposalRow ? proposalRow.proposal_session_id : null,
    proposalRow ? proposalRow.proposal_pr_number : null);
  return {
    key: keyOf(newest.slug, issueNumber),
    id: Number(lead.id),
    appSlug: newest.slug,
    appName: newest.name || newest.slug,
    issueNumber,
    title: firstVersion ? null : (newest.issue_title || null),
    firstVersion,
    outcome,
    doing: outcome ? null : NOT_FINISHED,
    at: atOf(lead, outcome),
    // #5009: its request row is closed, so nothing here waits on the person
    // however its chat reads. The strip leaves Needs you on this alone, and
    // its old ask (still open in the DM) must not put it back.
    ...(requestClosed ? { requestClosed: true } : {}),
    ...(proposalRow ? { proposalId: Number(proposalRow.proposal_session_id) } : {}),
    href: links.proposal || links.request || links.project,
    links,
    earlier: runs.filter((row) => row !== lead && row !== going && !planOnly(row)).slice(0, EARLIER_LIMIT).map(runOf),
  };
}

/**
 * Pure: a request's runs as the earlier runs of an entry of Now: the ones
 * that came to something. A build that has not finished is the work Now is
 * showing, not an earlier run.
 */
function earlierOf(runs = []) {
  return runs.filter((row) => outcomeOf(row) && !planOnly(row)).slice(0, EARLIER_LIMIT).map(runOf);
}

/**
 * Pure: one of progressFor's entries that waits on the person as an entry
 * of Needs you: an open question of the bot's in the DM (its runs say the
 * rest), or a new project waiting for its secrets (its own words).
 */
function needsYouOfProgress(item, runs = []) {
  const job = jobOfEntry(item);
  const links = linksFor(item.project, job.issueNumber, Number(item.proposal?.proposal) || null);
  const question = item.stage === 'question';
  const asked = question ? runs.find((row) => row.verdict === 'question') : null;
  return {
    ...job,
    id: asked ? Number(asked.id) : 0,
    outcome: question ? 'question' : null,
    doing: question ? null : (item.doing || null),
    at: iso(item.since) || (asked ? iso(asked.created_at) : null),
    href: links.proposal || links.request || links.project,
    links,
    earlier: runs.filter((row) => row !== asked && !planOnly(row)).slice(0, EARLIER_LIMIT).map(runOf),
  };
}

const newestFirst = (a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0);

/**
 * Pure: the tray's three groups, from progressFor's entries (empty while
 * the bot is off) and the person's live runs, newest first. Each request
 * appears once: in Now while the bot has it in hand, else in Needs you
 * while it waits on them, else in History. Work the bot has taken back up
 * never reaches Needs you (#5009), even past Now's limit or on hold.
 */
function arrange(entries, rows) {
  const groups = groupRuns(rows);
  // #5009: every request the bot has taken back up — a newer run under way
  // or queued, or one held until later (on hold until Monday) — is its work,
  // not a question for the person, even when it falls past Now's limit.
  const inHand = new Set();
  for (const item of entries) {
    if (!item.project) continue;
    if (progressSvc.inFlight(item) || item.stage === 'on_hold') inHand.add(keyOf(item.project, item.number));
  }
  const items = entries.filter((item) => progressSvc.inFlight(item));
  const busy = items.filter((item) => item.busyNow);
  const now = [...busy, ...items.filter((item) => !item.busyNow)]
    .map(jobOfProgress)
    .filter(Boolean)
    .slice(0, NOW_LIMIT);
  const placed = new Set();
  for (const job of now) {
    job.earlier = earlierOf(groups.get(job.key));
    placed.add(job.key);
  }
  const needsYou = [];
  for (const item of entries) {
    if (item.waitingOn !== 'them' || !item.project) continue;
    const key = keyOf(item.project, item.number);
    if (placed.has(key) || inHand.has(key)) continue;
    needsYou.push(needsYouOfProgress(item, groups.get(key)));
    placed.add(key);
  }
  const history = [];
  for (const [key, runs] of groups) {
    if (placed.has(key)) continue;
    const entry = entryOfRuns(runs);
    if (inHand.has(key)) {
      // The bot is on it again; Needs you is not waiting on them, whatever
      // its last run asked.
      entry.inHand = true;
      history.push(entry);
    } else {
      (NEEDS_YOU.has(entry.outcome) ? needsYou : history).push(entry);
    }
  }
  return { now, needsYou: needsYou.sort(newestFirst), history: history.sort(newestFirst).slice(0, HISTORY_LIMIT) };
}

/**
 * Everything the bot's own progress answer says about this person's
 * requests (progressFor's rightNow): what it has in hand, and what waits on
 * them. Nothing while it is switched off, or on a staging copy, which never
 * acts.
 */
async function progressEntries(pool, { userId, settings, deps = {} }) {
  if (!settings || settings.mode === 'off' || liveModule(deps).isStaging()) return [];
  const progress = await progressSvc.progressFor(pool, {
    userId, settings, facts: false, deps: { botSvc: deps.botSvc, creationPhase: deps.creationPhase, domain: null },
  });
  return progress.rightNow || [];
}

/** What the bot has in hand for this person now: Now alone (see arrange). */
async function currentJobs(pool, { userId, settings, deps = {} }) {
  return arrange(await progressEntries(pool, { userId, settings, deps }), []).now;
}

/**
 * The bot's live runs on this person's requests, newest first. `plan_only`:
 * a first version's plan (awaitGo wrote it) that never went ahead (goAhead
 * records what was chosen) and stopped waiting unbuilt.
 */
async function pastRuns(pool, { userId, limit = RUN_LIMIT }) {
  const { rows } = await pool.query(
    `SELECT r.id, r.app_id, r.issue_number, r.verdict, r.build_ok, r.build_error, r.cap_suppressed,
            r.proposal_session_id, cs.pr_number AS proposal_pr_number, r.created_at,
            r.awaiting_go_at, r.error, r.build_session_id,
            -- A build that changed nothing: what its last turn said, which
            -- the track reads for why (homeroom-bot-track.js noChangeWhy)
            -- and never passes on.
            r.build_no_change->'turns'->-1->>'said' AS no_change_said,
            -- #4539: the request's own state, newest row by id (issues is not
            -- unique on (app_id, github_issue_number), so a join could
            -- duplicate rows). Or the bot's own record of its close, for a
            -- request with no row of ours (Suggest an improvement, a comment
            -- pin): homeroom-bot-closed-requests.js recordClosed.
            (COALESCE((SELECT ri.status = 'closed' FROM issues ri
                         WHERE ri.app_id = r.app_id AND ri.github_issue_number = r.issue_number
                         ORDER BY ri.id DESC LIMIT 1), FALSE)
                OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests cr
                            WHERE cr.app_id = r.app_id AND cr.issue_number = r.issue_number AND cr.closed_at IS NOT NULL)) AS request_closed,
            (r.plan IS NOT NULL AND r.plan->'chosen' IS NULL AND r.build_ok IS FALSE
              AND r.build_session_id IS NULL AND r.proposal_session_id IS NULL) AS plan_only,
            -- Merged but not live yet (live_at) reads as merging: going live.
            CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS proposal_status,
            COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.live_at AS merged_at,
            a.slug, a.name, q.issue_title, q.first_version,
            -- D1: the project's first version, which merges without a vote.
            CASE WHEN cs.id IS NOT NULL THEN ${firstVersionSql('cs')} ELSE FALSE END AS first_version_change
       FROM homeroom_bot_requesters q
       JOIN homeroom_bot_runs r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE q.user_id = $1 AND r.mode = 'live'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Pure: an app's icon as a tray entry carries it (#4201): its image, else its emoji. */
function iconOf(app) {
  return {
    iconUrl: app && app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
    iconEmoji: (app && app.icon_emoji) || null,
  };
}

/**
 * Pure: every entry of `work` with its app's icon (#4201), from `icons`
 * (slug to iconOf). An app with none, or none known, carries nulls.
 */
function withIcons(work, icons = new Map()) {
  const dress = (job) => ({ ...job, ...(icons.get(job.appSlug) || iconOf(null)) });
  return { now: work.now.map(dress), needsYou: work.needsYou.map(dress), history: work.history.map(dress) };
}

/**
 * The slugs among `items`' this person can still view, each with its app's
 * icon (iconOf), so the tray draws an app it shows by its own icon.
 */
async function viewableSlugs(pool, user, items) {
  const slugs = [...new Set(items.map((item) => item.appSlug).filter(Boolean))];
  if (!slugs.length) return new Map();
  // The columns checkAppAccess reads (app-access.js ACCESS_COLUMNS), and the
  // icon's, written out so the query stays static SQL.
  const { rows } = await pool.query(
    `SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility, moderation_suspended_at,
            icon_image_id, icon_emoji
       FROM apps WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const allowed = new Map();
  for (const app of rows) {
    if (await appAccess.checkAppAccess(pool, app, user, 'view')) allowed.set(app.slug, iconOf(app));
  }
  return allowed;
}

/**
 * Everything the tray shows for `user`, the signed-in person:
 * { now, needsYou, history }, every entry with its app's icon (withIcons).
 * Never anybody else's: see the note at the top.
 */
async function workFor(pool, { user, settings = null, deps = {} }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { now: [], needsYou: [], history: [] };
  const s = settings || await settingsModule(deps).readSettings(pool);
  const [entries, rows] = await Promise.all([
    progressEntries(pool, { userId, settings: s, deps }),
    pastRuns(pool, { userId }),
  ]);
  // An app they cannot view is left out before anything is arranged, so its
  // runs are not anybody's earlier runs either.
  const allowed = await viewableSlugs(pool, user, [
    ...entries.map((item) => ({ appSlug: item.project })),
    ...rows.map((row) => ({ appSlug: row.slug })),
  ]);
  const shown = entries.filter((item) => allowed.has(item.project));
  const work = withIcons(arrange(shown, rows.filter((row) => allowed.has(row.slug))), allowed);
  await withReleases(pool, work, shown);
  await withThreads(pool, userId, work);
  // 16 Oct 2026: one track per request, which every surface draws
  // (homeroom-bot-track.js). Last, from everything above.
  const settled = settleAnswered(work);
  return trackSvc().withTracks(pool, settled, { entries: shown, rows: rows.filter((row) => allowed.has(row.slug)), keyOf, deps });
}

/**
 * Pure (#4974): a needs-you entry whose ask the person has already answered —
 * a reply on the request's discussion settled it (its row says answered_at)
 * and no newer one is open — moves to history, newest first, until the bot's
 * next look says what it made of the reply. Entries that never asked for
 * them stay put.
 */
function settleAnswered(work) {
  const needsYou = [];
  const answered = [];
  for (const job of work.needsYou) {
    (NEEDS_YOU.has(job.outcome) && job.answered && !job.ask ? answered : needsYou).push(job);
  }
  if (!answered.length) return work;
  return {
    ...work,
    needsYou,
    history: [...answered, ...work.history].sort(newestFirst).slice(0, HISTORY_LIMIT),
  };
}

// The kinds of the bot's messages about a request that wait on the person
// while their buttons are open: what the strip's Needs you row acts on.
const ASK_KINDS = new Set([
  'question', 'followup_ask', 'plan', 'person', 'blocked', 'empty', 'build_failed', 'checks', 'needs_look', 'first_version_failed',
]);

/**
 * Pure (one story): what an entry's request has in its person's chat with
 * the bot, from that chat's records (newest first): `cardId`, the request's
 * card, the root of its thread; `ask`, its newest message still waiting on
 * them (a question, a plan, a stop with its button), with the question's
 * words; `ready`, its newest "ready to try" card, with what its buttons do.
 * The strip above the chat draws its rows from these (messages/bot-strip.tsx).
 */
function threadsOf(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.slug, row.issue_number);
    if (!byKey.has(key)) byKey.set(key, {});
    const found = byKey.get(key);
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const id = Number(row.message_id);
    if (row.kind === 'activity') {
      if (!found.cardId && !row.thread_root_id) found.cardId = id;
    } else if (row.kind === 'proposal') {
      if (!found.ready) {
        const actions = Array.isArray(meta.actions) ? meta.actions : [];
        found.ready = {
          messageId: id,
          sessionId: Number(meta.sessionId) || null,
          epoch: Number(meta.epoch) || 0,
          open: meta.status === 'open',
          approve: meta.status === 'open' && actions.some((a) => a && a.id === 'approve'),
          waiting: typeof meta.waiting === 'string' ? meta.waiting
            : (Array.isArray(meta.ready?.waitingOn) && meta.ready.waitingOn.length
              ? meta.ready.waitingOn.map((name) => `@${String(name).replace(/^@/, '')}`).join(', ') : null),
        };
      }
    } else if (ASK_KINDS.has(row.kind)) {
      // #4974: whether the newest thing that asked for them has been answered
      // already — a reply on the request's discussion settled it (its row
      // says answered_at), or an answer came from the DM itself.
      if (found.answered === undefined) found.answered = !!row.answered_at;
      if (!found.ask && (meta.status === 'open' || row.question_status === 'open')) {
        found.ask = {
          messageId: id,
          kind: row.kind,
          ...(meta.said ? { said: String(meta.said) } : {}),
          ...(typeof meta.question === 'string' && meta.question ? { question: meta.question.slice(0, 300) } : {}),
          // A plan said in the private thread its request started in: the
          // thread its doors open (homeroom-bot-track.js askThreadId).
          ...(row.in_own_thread === true && row.thread_root_id ? { threadRootId: Number(row.thread_root_id) } : {}),
        };
      }
    }
  }
  return byKey;
}

/**
 * One story: every entry of `work` with where its request is in this
 * person's chat with the bot (threadsOf). One read of their own records;
 * a read that fails leaves the entries as they were.
 */
async function withThreads(pool, userId, work) {
  try {
    const { rows } = await pool.query(
      `SELECT d.message_id, d.kind, d.issue_number, d.question_status, d.answered_at, a.slug,
              m.thread_root_id, m.metadata->'homeroomBot' AS meta,
              -- In a thread of the person's own, not under a request's card.
              (m.thread_root_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM homeroom_bot_dm_messages c WHERE c.message_id = m.thread_root_id AND c.kind = 'activity'
              )) AS in_own_thread
         FROM homeroom_bot_dm_messages d
         JOIN apps a ON a.id = d.app_id
         JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
        WHERE d.user_id = $1
        ORDER BY d.message_id DESC
        LIMIT 400`,
      [userId],
    );
    const found = threadsOf(rows);
    for (const job of [...work.now, ...work.needsYou, ...work.history]) {
      const mine = found.get(job.key);
      if (!mine) continue;
      if (job.requestClosed === true || job.inHand === true) {
        // #5009: its request row is closed, or the bot has taken the work
        // back up, so it is not waiting on the person — its old ask (still
        // open in the chat) must not put it back in Needs you. The rest of
        // its story (the card to open, whether it was answered) stays.
        const { ask, ...rest } = mine;
        Object.assign(job, rest);
      } else {
        Object.assign(job, mine);
      }
    }
  } catch (err) {
    log.warn('homeroom-bot-tray', 'Could not read the requests\' threads', { userId, err: err.message });
  }
}

/**
 * A change of the bot's merged into the platform's own app and not live yet
 * waits for the platform's next release (services/release-watch.js), and
 * its entry says when (`release`, which bot-work.tsx words): an entry of Now
 * going live (its progress entry names the proposal), and one of History or
 * Needs you whose news is that it is going live. Any other change is left
 * out of the answer, and its entry says "going live" as it did. One read,
 * only when an entry is going live.
 */
async function withReleases(pool, work, entries) {
  const going = new Map();
  const proposalOf = new Map(entries
    .filter((item) => item.stage === 'merging' && Number(item.proposal?.proposal))
    .map((item) => [keyOf(item.project, item.number), Number(item.proposal.proposal)]));
  for (const job of work.now) {
    if (job.phase === 'merging' && proposalOf.has(job.key)) going.set(job, proposalOf.get(job.key));
  }
  for (const job of [...work.needsYou, ...work.history]) {
    if (job.outcome === 'going_live' && job.proposalId) going.set(job, job.proposalId);
  }
  if (!going.size) return;
  const releases = await require('./release-watch').releasesFor(pool, [...going.values()]);
  for (const [job, sessionId] of going) {
    const release = releases.get(sessionId);
    if (release) job.release = release;
  }
}

/**
 * The live loop started or finished a piece of work for this person: their
 * open tray reads itself again. Best-effort and never throws: a missed nudge
 * is caught up by the next one, or the next time the DM opens.
 */
function noteWorkChanged(userId, deps = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  try {
    const ws = deps.ws || require('./ws');
    return ws.pushToUser(id, { type: 'homeroom_bot_work_changed' }) || 0;
  } catch (err) {
    log.warn('homeroom-bot-tray', 'Could not announce a work change', { userId: id, err: err.message });
    return 0;
  }
}

/**
 * The staging demo's tray (`?demo=1`, beside the bot DM fixture in
 * staging-messages.js), drawn as the strip above the chat: one request that
 * needs the viewer (#18, its question open in its thread), two ready to try
 * (one waiting for their yes, one for @ada's), two in progress (one being
 * built, one being planned, the second the card opening the DM gives it),
 * one done today (a first version gone live), and one on hold, waiting for
 * one of its project's slots. A staging copy never runs
 * the bot, so without it the strip could not be seen there. Times are
 * relative to `now` so it always reads fresh. No project stands behind it
 * (as behind the fixture's own messages), so it links nowhere: `href` and
 * every link are null. `ids` are the fixture's messages (demoWorkFor), so a
 * row opens its thread and its buttons act on its own message; without
 * them the rows still draw. Its app has an emoji for an icon.
 */
function demoWork(now = Date.now(), ids = {}) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const app = { appSlug: null, appName: 'Staging demo app', iconUrl: null, iconEmoji: '🧪' };
  const nowhere = { href: null, links: { request: null, proposal: null, project: null } };
  const request = (issueNumber, title) => ({ key: `demo#${issueNumber}`, ...app, issueNumber, title, firstVersion: false });
  const card = (id) => (id ? { cardId: id } : {});
  return {
    now: [{
      ...request(14, 'Staging demo, show a total under the list'),
      phase: 'building', stage: 'building', step: 3, of: 6, stepName: 'Building', doing: 'building it',
      since: ago(4), ...nowhere, earlier: [], ...card(ids.working),
    }, {
      // Begun before it had a card in the DM: opening the demo DM gives it
      // one (staging-messages.js ensureDemoUnderWayCard).
      ...request(15, 'Staging demo, add a search box'),
      phase: 'building', stage: 'planning', step: 2, of: 6, stepName: 'Planning', doing: 'writing the plan for the build',
      since: ago(7), ...nowhere, earlier: [], ...card(ids.underWay),
    }],
    needsYou: [{
      ...request(18, 'Staging demo, a weekly dinner rota'),
      id: 4, outcome: 'question', doing: null, at: ago(3), ...nowhere, earlier: [], ...card(ids.story),
      ask: {
        messageId: ids.storyQuestion || null, kind: 'question', said: 'question',
        question: 'Which night should the rota start on?',
      },
    }],
    history: [{
      ...request(11, 'Staging demo, grey out finished items'),
      id: 7, outcome: 'proposed', doing: null, at: ago(20), ...nowhere, earlier: [],
      ready: { messageId: ids.ready || null, sessionId: 990901, epoch: 0, open: true, approve: true, waiting: null },
    }, {
      key: 'demo#first', ...app, appName: 'Staging demo plants', issueNumber: 1, title: null, firstVersion: true,
      id: 1, outcome: 'live', doing: null, at: ago(50), ...nowhere, earlier: [],
    }, {
      ...request(9, 'Staging demo, show item counts'),
      id: 2, outcome: 'proposed', doing: null, at: ago(60 * 2), ...nowhere, ...card(ids.done),
      earlier: [{ id: 5, outcome: 'revise', at: ago(60 * 3) }],
      ready: { messageId: null, sessionId: null, epoch: 0, open: true, approve: false, waiting: '@ada' },
    }, {
      // 16 Oct 2026: one held for a slot, so the drawer's On hold group can
      // be seen (its place in line is set by demoWorkFor).
      ...request(16, 'Staging demo, a dark mode'),
      id: 8, outcome: 'held', doing: null, at: ago(60 * 3), ...nowhere, earlier: [],
    }],
  };
}

// The fixture's messages the demo strip's rows point at, by the keys
// staging-messages.js sends them with.
const DEMO_MESSAGE_KEYS = Object.freeze({
  story: 'staging-hrbot-activity-thread',
  storyQuestion: 'staging-hrbot-story-question',
  ready: 'staging-hrbot-ready',
  working: 'staging-hrbot-activity-working',
  underWay: 'staging-hrbot-activity-under-way',
  done: 'staging-hrbot-activity-done',
});

/** The demo strip for `user`'s own fixture (demoWork, with its message ids). Never throws. */
async function demoWorkFor(pool, user, now = Date.now()) {
  const ids = {};
  try {
    if (user?.id) {
      const { rows } = await pool.query(
        `SELECT m.id, m.idempotency_key FROM conversation_messages m
           JOIN users b ON b.id = m.sender_id AND b.username = 'homeroom_bot' AND b.is_synthetic = TRUE
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.status = 'member'
          WHERE m.idempotency_key = ANY($2::text[])`,
        [user.id, Object.values(DEMO_MESSAGE_KEYS)],
      );
      for (const [name, key] of Object.entries(DEMO_MESSAGE_KEYS)) {
        const row = rows.find((r) => r.idempotency_key === key);
        if (row) ids[name] = Number(row.id);
      }
    }
  } catch (err) {
    log.warn('homeroom-bot-tray', 'Could not read the demo strip\'s messages', { err: err.message });
  }
  // Its tracks too, read the same way as a real tray's (no runs behind them),
  // with the held one first in line for a slot.
  const work = await trackSvc().withTracks(pool, demoWork(now, ids), { keyOf });
  for (const track of work.tracks || []) {
    if (track.state === 'held' && track.held && !track.held.position) track.held.position = 1;
  }
  return work;
}

module.exports = {
  workFor, currentJobs, pastRuns, arrange, noteWorkChanged, demoWork, demoWorkFor, iconOf, withIcons, threadsOf, ASK_KINDS, linksFor,
  jobOfProgress, needsYouOfProgress, entryOfRuns, leadOf, outcomeOf, hrefOf, keyOf, planOnly,
  OUTCOMES, NEEDS_YOU, PHASES, PHASE_OF_STAGE, HISTORY_LIMIT, NOW_LIMIT, NOT_FINISHED,
  settleAnswered,
};
