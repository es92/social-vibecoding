const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const { sendSystemMessage, pushIssueUpdate } = require('../services/ws');
const { getActiveUserStats } = require('../services/active-users');
const notifications = require('../services/notifications');
const appManifest = require('../services/app-manifest');
const appSecrets = require('../services/app-secrets');
const platformEnv = require('../services/platform-env');
const { encrypt } = require('../services/secrets');
const { issueKindLimiter, governanceVoteLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const { weekStartUtc, countWeeklyBountiesUsed, WEEKLY_BOUNTY_LIMIT } = require('./kudos');
const { parseScreenshotIds, buildScreenshotsEmbed, parseVideoId, buildVideoEmbed } = require('./feedback');
const { placeBounty } = require('../services/bounties');
const { kudosParked, refuseParked } = require('../services/kudos-parked');
const { claimIssueForUser } = require('../services/issue-claims');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const appAdmins = require('../services/app-admins');
const explicitApprovalCopy = require('../services/explicit-approval');
const topicAttrs = require('../services/topic-attributes');
const repoRef = require('../services/repo-ref');
// #1112: the same in-process "a turn is running" predicate /api/sessions
// reports as `busy`, so an issue's work-state chip and the session card it
// points at can never disagree about whether an agent is actually running.
const { isSessionBusy } = require('../services/active-workers');
const { planRecordSql } = require('../services/request-specs');
const { workedOnSql } = require('../workflow/session-work.ts');
const { FEEDBACK_FALLBACK_TITLE } = require('../services/llm');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const challengeScorer = require('../services/topochain/challenge-scorer');
// The governance machine decides every governance proposal (vote, admin
// apply, withdraw, a target closed elsewhere). Resolved per call: the module
// is ESM loaded through type stripping, and server.js starts it.
const workflow = () => require('../workflow/platform.ts');
const { isGovernanceKind } = require('../services/governance-kinds');

// #2089: the board search's server half. Shorter queries are not asked
// (the browser applies the same floor); the hit list is capped because the
// browser only ever intersects it with the cards it already holds.
const BOARD_SEARCH_MIN_CHARS = 2;
const BOARD_SEARCH_MAX_HITS = 200;

// #6440: where a governance vote belongs, when it is about one request or
// thread rather than the project. `reopen_issue` is about the request it
// would bring back; `thread_move` is about the thread it would merge or
// split. Both are drawn on that page, and `dev/governance/<id>` forwards
// there. Every other kind (and a row whose target cannot be resolved) is
// `null`: the vote has a page of its own.
async function governanceHome(pool, proposal) {
  const payload = (proposal && proposal.payload) || {};
  if (proposal.kind === 'reopen_issue') {
    const n = Number(payload.issueNumber);
    return Number.isInteger(n) && n > 0 ? { kind: 'request', number: n } : null;
  }
  if (proposal.kind === 'thread_move') {
    // The thread the move is about, through any merges, and its number: a
    // request's and a change's numbers are one sequence (app-numbers), so
    // the client opens the page that number names.
    let thread = null;
    if (payload.moveId != null && pool) {
      try {
        const { rows } = await pool.query('SELECT thread_id FROM thread_moves WHERE id = $1', [Number(payload.moveId)]);
        const threadId = rows[0] && rows[0].thread_id;
        if (threadId != null) thread = await require('../services/threads').threadById(pool, threadId);
      } catch (err) {
        log.warn('issues', 'Could not resolve a thread move\'s thread', { message: err.message });
      }
    }
    const n = Number(thread && thread.number != null ? thread.number : payload.threadNumber);
    return Number.isInteger(n) && n > 0 ? { kind: 'request', number: n } : null;
  }
  return null;
}

// #6440: how a governance vote stands or ended, in one word the decision
// page reads: `open`, `applying` (passed, being carried out), `applied`,
// `refused`, `withdrawn` or `superseded`. The same facts `_govApplyState`
// reads on the client, so the page never says "waiting for votes" once the
// vote has ended.
function governanceOutcome(proposal) {
  if (!proposal) return 'open';
  const p = proposal.payload || {};
  if (p.appliedAt) {
    return String(p.appliedBy || '').startsWith('refused:') ? 'refused' : 'applied';
  }
  if (p.withdrawnAt || proposal.status === 'withdrawn') return 'withdrawn';
  if (p.supersededAt) return 'superseded';
  if (proposal.status && proposal.status !== 'open') return 'applied';
  const yes = Number(proposal.qualified_yes_count != null ? proposal.qualified_yes_count : proposal.up_count) || 0;
  const need = Number(proposal.approvals_required != null ? proposal.approvals_required : proposal.votes_required) || 0;
  const ends = proposal.merge_window_ends_at ? Date.parse(proposal.merge_window_ends_at) : NaN;
  if (need > 0 && yes >= need && !proposal.contested && Number.isFinite(ends) && ends <= Date.now()) {
    return 'applying';
  }
  return 'open';
}

// An issue id from the path, or null when it is not a positive integer that
// fits `issues.id` (SERIAL). Answered as 404 rather than handed to Postgres
// as a bad cast, which would surface as a 500.
function positiveIssueId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) && Number(raw) <= 2147483647 ? Number(raw) : null;
}

// Pull owner/repo out of a stored repo_url. Same shape used across the
// codebase (e.g. the rename-apply path below, routes/votes.js).
function parseOwnerRepo(repoUrl) {
  return repoRef.ownerRepo(repoUrl);
}

// #136: platform-filed GitHub issues are authored by the bot account, but
// the real creator is recorded in the body's first "**Source:**" line
// (written by routes/feedback.js): "usernode user (name)" for regular
// users, "usernode admin (name)" for admins (#140; older issues used a
// bare "usernode admin" with no name). Returns the creator's display name
// or null when no Source line can be parsed. #3132: new issues say
// "Homeroom user (name)" / "Homeroom admin (name)"; the older "usernode"
// spelling is still accepted for issues filed before the rename.
function creatorFromSourceLine(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/\*\*Source:\*\*\s*([^\n]+)/);
  if (!m) return null;
  const source = m[1].trim();
  const named = source.match(/^(?:usernode|Homeroom) (?:user|admin) \(([^)]+)\)/);
  if (named) return named[1];
  if (/^(?:usernode|Homeroom) admin\b/.test(source)) return 'admin';
  return null;
}

// Durable authorship for issue edits. Platform-created issue rows are the
// strongest record; feedback reports are the equivalent record for issues
// filed directly into GitHub by routes/feedback.js. The Source line remains
// the compatibility fallback for older reports. Keeping the feedback row in
// the check means an author who deliberately clears the whole body can still
// add a new description later.
async function isIssueAuthor(pool, appId, parsed, issueNumber, user, currentBody) {
  const { rows } = await pool.query(
    `SELECT 1 FROM issues
      WHERE app_id = $1 AND github_issue_number = $2 AND created_by = $3
     UNION ALL
     SELECT 1 FROM feedback_reports
      WHERE issue_owner = $4 AND issue_repo = $5 AND issue_number = $2 AND user_id = $3
     LIMIT 1`,
    [appId, issueNumber, user.id, parsed.owner, parsed.repo]
  );
  return rows.length > 0 || creatorFromSourceLine(currentBody) === user.username;
}

// Renames are no longer an issue kind — they open a dapp.json `name` PR
// via POST /api/apps/:slug/rename (see src/routes/apps.js). The governance
// machine still decides a rename issue opened before that.
// maintenance_campaign (#853's generalization) is self-app-only,
// admin-proposed fleet maintenance — see the create branch below and
// services/fleet-maintenance.js for the engine the apply path starts.
const VALID_KINDS = ['general', 'secret_change', 'close_issue', 'reopen_issue', 'maintenance_campaign'];
const MAX_SECRET_VALUE_LENGTH = 4096;
// Campaign instructions are an LLM prompt, not an essay — but audits
// with embedded code snippets are legitimate, so the cap is generous.
const MAX_CAMPAIGN_INSTRUCTIONS_LENGTH = 20000;
const MAX_CAMPAIGN_TITLE_LENGTH = 200;
// "In progress" status windows, and what keeps a claim live.
//
// #1903: both constants and the claim-liveness predicates now live in
// services/issue-progress.js, because the Workshop's lane assignment needs
// exactly the same rules and a second copy of them is a second copy to
// drift. The bulk read below stays here: it needs per-issue DETAIL for the
// chip and already holds the thread timestamps, so calling the Set helper
// would be a redundant query on a hot path.
const {
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
  claimExpiresAt,
  claimIsLive,
} = require('../services/issue-progress');
// #2431: which proposal closed an issue, or is working on it. One query for
// the whole list, so the board pays for it once and not per card.
const { resolveIssueProposalRefs } = require('../services/issue-proposal-ref');
const threadsService = require('../services/threads');
const { botWorkByIssue } = require('../services/homeroom-bot-progress');
const MAX_CLOSE_REASON_LENGTH = 2000;
// #556: cap for author-edited issue titles (rename route below). Matches
// the feedback form's optional title input; far below GitHub's own limit.
const MAX_ISSUE_TITLE_LENGTH = 200;
// GitHub's own issue-body limit (services/issue-body-limit.js): the most a
// request filed with screenshots may come to once their embed lines are
// appended, and the most its author may edit its body to (#4194: this was
// 10,000, so a request written at length on GitHub could not be edited
// here). Empty is valid: GitHub issues may deliberately have no description.
const { GITHUB_ISSUE_BODY_MAX: MAX_GITHUB_ISSUE_BODY_CHARS } = require('../services/issue-body-limit');
const MAX_ISSUE_BODY_LENGTH = MAX_GITHUB_ISSUE_BODY_CHARS;

// A request body with its screenshots embedded exactly as the feedback
// dialog embeds them, so every reader of `/issue-images/<id>` lines (the
// topic view, the coding agents, get_request) sees one format. With no
// description the body is the embed alone, without the blank lines that
// would separate it from text above.
function issueBodyWithScreenshots(description, screenshotIds, domain) {
  const embed = buildScreenshotsEmbed(screenshotIds, domain);
  return description ? `${description}${embed}` : embed.replace(/^\n+/, '');
}

// What the Homeroom bot is reading or building among an app's requests, by
// issue number, for each row's `bot` field ({ what, since }, or null). The
// bot's own sessions never count as `in_progress` (synthetic authors are
// left out below), so this is the only way a request it is building says
// so. Best effort: a list is not worth failing over it.
async function botWorkFor(pool, appId) {
  try {
    return await botWorkByIssue(pool, appId);
  } catch (err) {
    log.warn('issues', 'Failed to read the Homeroom bot\'s work', { message: err.message });
    return new Map();
  }
}

// #132: should this issue kind get a GitHub twin on the app's repo?
// Env-var change proposals (kind='secret_change') are in-app governance —
// they're proposed, voted, applied, and audited entirely on the platform,
// so opening a "Set secret …" issue on GitHub just pollutes the repo's
// issue list (GitHub issues are reserved for real issues). Close-issue
// proposals (kind='close_issue') target an EXISTING GitHub issue — a twin
// would be pure noise, and the target's number deliberately lives in the
// payload, not github_issue_number (see the create route). Everything
// downstream already tolerates a null github_issue_number: the apply path
// guards its close/comment on it, and the UI omits the kudos button when
// no twin exists.
// Maintenance campaigns are likewise platform governance: the per-app
// PRs the engine opens are the repo-visible artifact; a twin issue on
// the PLATFORM repo would be noise.
function shouldCreateGithubTwin(kind) {
  return kind !== 'secret_change' && kind !== 'close_issue' && kind !== 'reopen_issue'
    && kind !== 'maintenance_campaign' && kind !== 'featured_illustration';
}

// Staging-only mock issues for GET /api/apps/:slug/github-issues. A
// staging preview whose repo has no open issues (or can't reach GitHub
// from the preview container) would render an empty Topics feed in the
// Dev card list, making the UI impossible to review. When the live
// fetch comes back empty in staging, these are served instead — clearly
// "[Mock]"-prefixed so testers know they're synthetic. High numbers
// keep them clear of any real bounty / thread rows in the cloned DB;
// updatedAt is computed per request so the feed's activity sort places
// them naturally. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Whether requests can be read and written here. Requests are Homeroom's
// own rows (services/requests.js) since GitHub suspended the account that
// filed them, so always, except on a staging copy without GitHub, which keeps
// serving its fixtures (stagingMockIssues and friends) as before: declared
// checks read them.
function requestsOn() {
  return !IS_STAGING || github.isEnabled();
}

function stagingMockIssues(repoUrl) {
  const base = (repoUrl || 'https://github.com/example/app')
    .replace(/\.git$/, '').replace(/\/$/, '');
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const mk = (number, title, body, hours) => ({
    number,
    title,
    body,
    labels: ['usernode'],
    // #4453: a request's page says when it was asked; a day before its
    // last activity, as a filed request is.
    createdAt: hoursAgo(hours + 24),
    updatedAt: hoursAgo(hours),
    htmlUrl: `${base}/issues/${number}`,
    user: 'staging-tester',
  });
  return [
    mk(900001, '[Mock] Dark mode toggle resets after refresh',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Steps to reproduce:\n1. Enable dark mode in the header\n'
      + '2. Refresh the page\n3. The app is back in light mode\n\n'
      + 'Expected: the preference persists across reloads.', 2),
    mk(900002, '[Mock] Add a keyboard shortcut for voting',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Power users vote on a lot of proposals — pressing Y/N while a '
      + 'proposal card is focused should cast the vote without reaching '
      + 'for the mouse.\n\n'
      // #3952: a person named with @, as GitHub stores a request filed on
      // Homeroom (safeMention's zero-width space after the `@`), so its page
      // shows the mention as a link to their page.
      + '@​staging_tester lmk wyt', 9),
    // #4453: filed on Homeroom, so its body opens with the Source line
    // GitHub keeps and the request's page leaves out.
    mk(900003, '[Mock] Topic cards overflow on narrow phones',
      '**Source:** Homeroom user (staging-tester)\n\n'
      + 'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'On a 360px-wide viewport the action buttons on issue cards can '
      + 'push past the card edge. They should wrap onto their own row '
      + 'instead.', 30),
    // Long-title variants (~90 and ~120 chars) for verifying the dev
    // card list's progressive title wrapping on narrow screens: the 💬
    // badge should drop to the next line first, then the bounty pill,
    // and only then should the title wrap — never an ellipsis.
    mk(900004, '[Mock] Long-title test: the settings panel re-expands '
      + 'every advanced section after navigating back to it',
      'Staging-only mock issue with a deliberately long title for '
      + 'checking that dev-card titles wrap instead of truncating on '
      + 'narrow phone screens.', 5),
    mk(900005, '[Mock] Long-title test: scrolling the leaderboard on a '
      + 'narrow phone while the keyboard is open jumps back to the top '
      + 'whenever a new kudos event arrives',
      'Staging-only mock issue with a deliberately long title (~120 '
      + 'chars) for checking that dev-card titles wrap instead of '
      + 'truncating on narrow phone screens.', 14),
    // #361: row for the headless `code` outcome — an auto-run that produced
    // a reviewable commit. Its viewer-owned clones (seeded in migrate.js)
    // demonstrate both "Changes ready" card variants (preview-OK and
    // preview-failed).
    mk(900006, '[Mock] Voting buttons need a clearer disabled state',
      'Staging-only mock issue for previewing the headless "code" outcome.\n\n'
      + 'When a proposal is closed, the Yes/No buttons stay full-colour but '
      + 'do nothing on click. They should render visibly disabled (greyed '
      + 'out, no hover) so it is obvious voting is over.', 11),
    // #287: dedicated row for reviewing the has-session button state. The
    // synthetic-myPrSessionId block below targets this number so the
    // "Create new proposal" variant of the start-work button is reviewable
    // in a staging preview.
    mk(900007, '[Mock] issue with an in-progress proposal',
      'Staging-only mock issue for previewing the "Create new proposal" '
      + 'button state. A synthetic per-viewer session is attached to this '
      + "row so the start-work button reads \"Create new proposal\" "
      + 'instead of "Create proposal" — exactly what a viewer who already '
      + 'started a dev chat on this issue would see.', 7),
    // #556: dedicated row for reviewing the author-only "edit title"
    // pencil in the topic head. The staging enrichment block in
    // GET /github-issues marks it as authored by whoever is viewing, so
    // the affordance renders for every staging tester.
    mk(900008, '[Mock] issue you authored — title is editable',
      'Staging-only mock issue for previewing the author-only title edit '
      + 'affordance (#556). Open this topic and a pencil appears next to '
      + 'the title because the row is marked as authored by you. Saving '
      + 'a new title will fail — there is no real GitHub issue behind '
      + 'this mock row — so this is purely for visual review.', 3),
    // #617: the NEWEST mock row, deliberately absent from the demo drag
    // order (stagingMockOrder in board-order.js ranks only 900002/900001).
    // With the fix, an issue filed after the last drag surfaces at the TOP
    // of the kanban Issues column, so this card must render first there.
    mk(900009, '[Mock] Newly filed issue — should render on top',
      'Staging-only mock issue for previewing the #617 fix: this row is '
      + 'the most recent and is NOT part of the saved drag order, so it '
      + 'must appear at the top of the Issues column, above the manually '
      + 'ordered cards.', 1),
    // Card-as-pointer revision: a deliberately BARE issue — no attributes,
    // no bounty, no claim, no headless run — so the "a card with no metadata
    // carries no grey Set-priority / Set-category / Unassigned chips" rule is
    // visible in a preview. Every other mock row is enriched by the
    // staging-attributes block in GET /github-issues; this number is
    // deliberately absent from that map (as is 900002, which keeps its own
    // unset-dropdown demo).
    mk(900013, '[Mock] Bare issue — no priority, no category, nobody assigned',
      'Staging-only mock issue with NO community-voted attributes, so the '
      + 'card renders with just its icon, title, meta line and one primary '
      + 'action. Compare it against #900001, which has all three chips set.', 6),
    // #683: dedicated row for reviewing the inline screenshot embed in
    // the topic view. Real filed issues embed the public
    // /issue-images/:id URL; the mock points at an existing same-origin
    // static asset so the image renders in a staging preview without an
    // issue_screenshots row (staging:private → always empty).
    mk(900010, '[Mock] issue with an attached screenshot',
      'Staging-only mock issue for previewing the #683 screenshot embed: '
      + 'the image below should render inline in the topic view, the '
      + 'same way a reporter-captured screenshot attached from the '
      + 'feedback modal does.\n\n'
      + '**Screenshot:**\n![Screenshot](/icons/v3/icon-192.png)', 4),
    // #1010: the two targets of the applying / retry-pending mock close
    // proposals below (stagingMockGovernance 9100074 / 9100075), so the
    // ?demo=1 preview shows the governance card's spinner state AND the
    // matching "Closing…" state on the target issue's own row.
    mk(900011, '[Mock] Close vote passed — issue is being closed',
      'Staging-only mock issue for previewing the #1010 in-progress close '
      + 'indicator. A mock close proposal for this issue has passed its '
      + 'vote and its window has just elapsed, so both the governance card '
      + 'and this row render the "Closing…" spinner state.', 6),
    mk(900012, '[Mock] Close vote passed a while ago — retry pending',
      'Staging-only mock issue for previewing the #1010 stalled-apply '
      + 'state. Its mock close proposal passed long enough ago that the '
      + 'spinner has timed out, so the card reads "Close pending — will '
      + 'retry automatically" instead of spinning forever.', 8),
    // #1112: the two work-states that no other mock row can show, because
    // both need a session in a state the other rows never sit in. The
    // in-progress enrichment below attaches a 5-day-old PAUSED session to
    // this one, so the chip reads "Paused · maya-builder" in the grey tone
    // and the topic head prints the self-clear date.
    mk(900014, '[Mock] Someone started this and paused',
      'Staging-only mock issue for previewing the #1112 "Paused" work '
      + 'state. A dev session on this row was last touched five days ago '
      + 'and is paused, so the card carries the grey "Paused" chip rather '
      + 'than the old catch-all "In progress" one, and the topic head '
      + 'explains in a sentence when the mark clears itself.', 26),
    // #1112: the amber "Needs an answer" state — a headless auto-solve run
    // that finished with the `question` outcome and is waiting on a human.
    mk(900015, '[Mock] Auto-solve run asked a question',
      'Staging-only mock issue for previewing the #1112 "Needs an answer" '
      + 'work state: the synthetic headless run below reports the '
      + '`question` outcome, so the card asks for a reply instead of '
      + 'claiming that work is happening right now.', 19),
    // #1112: keep the finished-draft state on its own row. Reusing 900005
    // made the check depend on older staging fixtures that already use that
    // number for the failed-run demo, so the synthetic state could be
    // shadowed by seed history instead of rendering `draft_ready`.
    mk(900016, '[Mock] Auto-solve draft ready to review',
      'Staging-only mock issue for previewing the #1112 "Draft ready to '
      + 'review" work state. Its synthetic headless run finished with a '
      + 'draft, and no other staging fixture shares this issue number.', 17),
    // #1251: the row that makes the fix reviewable. Mock proposal 9000013
    // declares this number in linked_issues and NOTHING else touches it —
    // no session, no claim, no synthetic headless state — so before the fix
    // it appeared in the list feed and in no kanban column at all, and
    // after it sits in In progress alongside its proposal in In review.
    // Every other mock issue is already in-progress for some other reason,
    // which is why this needs a number of its own.
    mk(900017, '[Mock] Issue with an open proposal against it',
      'Staging-only mock issue for previewing #1251: an issue whose work '
      + 'is already up for a vote. It must appear on the kanban board (In '
      + 'progress) as well as in the list view — the proposal card in In '
      + 'review is not the only place it exists.', 8),
    // The request the Homeroom bot is building. The bot does not run in a
    // preview, so the list route gives this row a synthetic `bot` state and
    // nothing else: its page says the bot is building it, its main button is
    // the disabled "Homeroom bot is building…", and (#4190) it still offers
    // Claim, for working on it alongside the bot, but not Start work.
    mk(900018, '[Mock] The Homeroom bot is building this request',
      'Staging-only mock issue for previewing a request the Homeroom bot is '
      + 'building. Nobody has claimed it yet. The page says the bot is on it, '
      + 'and still offers Claim for anyone who wants to work on it alongside '
      + 'the bot, but not Start work.', 2),
    // 3 Nov 2026 (#6213): the request Homeroom bot handed back to a person.
    // Its discussion carries the note with the suggested replies the person
    // it names taps (the seeded thread, seedStagingBotWaitingRows in
    // src/db/migrate.js). A staging copy has no GitHub to read the request
    // from, so its page's own fetch finds it here, and only the after copy
    // has it. Nothing else reads this row; the note is the stored message.
    mk(9103, 'Staging demo: a request handed back to a person',
      'Staging demo: obviously fake. The bot handed this back because a '
      + 'person must decide which of the two columns to keep.\n\n'
      + '**Source:** Homeroom user (usernode-capture)', 26),
    // 4 Nov 2026 (#6264): the request whose discussion shows the bot
    // keeping its word, "I'll tell you here when it's in." then the line it
    // posted when the update was in (seedStagingBotFollowUp in
    // src/db/migrate.js stores those messages). A staging copy has no
    // GitHub to read the request from, so its page's own fetch finds it
    // here, and only the after copy has it.
    mk(9107, 'Staging demo: a request where the bot kept its word',
      'Staging demo: obviously fake. An update to this request was asked '
      + 'for, and the bot said it would tell the person when it was in.\n\n'
      + '**Source:** Homeroom user (usernode-capture)', 46),
    // #6399: the request whose hand-back reason a later release lifted. Its
    // track (seedStagingBotOutdatedReason in src/db/migrate.js) is
    // waiting_for_you/decide with a reason given before 6 Nov 2026 13:05 UTC,
    // so its status card says the reason may be out of date and offers
    // "Ask Homeroom bot to read this again". A staging copy has no GitHub to
    // read the request from, so its page's own fetch finds it here.
    mk(9112, 'Staging demo: a request handed back over a plan the bot could not read',
      'Staging demo: obviously fake. The bot handed this back because it '
      + 'could not read a plan a person posted, and Homeroom can read one now.\n\n'
      + '**Source:** Homeroom user (usernode-capture)', 26),
    // #6211: the pair whose discussions show an overlap note. 9115 is the
    // smaller request the bot read as part of 9114: its thread carries the
    // note and the three choices (seedStagingBotOverlap in src/db/migrate.js
    // stores them), and 9114's thread carries the line saying what was
    // chosen. A staging copy has no GitHub to read either request from, so
    // each page's own fetch finds it here.
    mk(9114, 'Staging demo: Main Chat keeps only what you said there',
      'Staging demo: obviously fake. A request a smaller one was found to '
      + 'be part of.\n\n**Source:** Homeroom user (usernode-capture)', 30),
    mk(9115, 'Staging demo: a plan row opens Main Chat',
      'Staging demo: obviously fake. One piece of the larger request.\n\n'
      + '**Source:** Homeroom user (usernode-capture)', 30),
    // #6581: the request whose build failed twice, with a reply under its
    // first failure note (seedStagingBotFailureNotes in src/db/migrate.js
    // stores the thread). A staging copy has no GitHub to read the request
    // from, so its page's own fetch finds it here, and only the after copy
    // has it: the change keeps the first note and posts the second below.
    mk(9116, 'Staging demo: a request whose build failed twice',
      'Staging demo: obviously fake. Its build failed, so the bot said so, '
      + 'and it failed again after somebody replied.\n\n'
      + '**Source:** Homeroom user (usernode-capture)', 3),
  ];
}

// #4244: two CLOSED staging-only requests, so a closed request's page (its
// status band) can be previewed. Served by the single-issue route alone:
// the board lists open requests, and these are not. 900031 was closed by a
// merged change (its `addressed_by`, which the resolver would otherwise
// answer from chat_sessions), 900032 by a close vote (`closed_via`). Each is
// used only when the real lookups answer nothing. A no-op in production.
function stagingMockClosedIssues(repoUrl) {
  const base = (repoUrl || 'https://github.com/example/app')
    .replace(/\.git$/, '').replace(/\/$/, '');
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  const mk = (number, title, body, days, extra) => ({
    number,
    title,
    body,
    labels: ['usernode'],
    state: 'closed',
    createdAt: daysAgo(days + 6),
    updatedAt: daysAgo(days),
    closedAt: daysAgo(days),
    htmlUrl: `${base}/issues/${number}`,
    user: 'staging-tester',
    ...extra,
  });
  return [
    mk(900031, '[Mock] Empty board shows no tier bands',
      'Staging-only closed mock request. A merged change closed it, so its '
      + 'page says so in a green band at the top of the card.', 9, {
        mockAddressedBy: {
          sessionId: 900031, state: 'merged', prNumber: 10, prUrl: null,
          title: 'Show the four empty tier bands when the board has no restaurants',
        },
      }),
    mk(900032, '[Mock] Retire the old tips banner',
      'Staging-only closed mock request. A close vote closed it, so its page '
      + 'says so in a grey band at the top of the card.', 9, { mockClosedVia: 'vote' }),
    // #6000: the request #6000 was filed about, closed by vote with no linked
    // change, so its page offers "Propose reopening" in the status card and
    // the ⋯ menu. A closed mock like the two above; no-op in production.
    mk(5841, 'Add tier list features: per-person picks, item comments with @mentions, and help tooltip',
      'Staging-only closed mock request for #6000. A close vote closed it, so '
      + 'its page offers asking the group to reopen it.', 1, { mockClosedVia: 'vote' }),
  ];
}

// Mock 900018's synthetic `bot` state: building for the last twenty minutes.
// Shared by the list and the single-issue route, so its page reads the same
// opened from the board or by its address.
function stagingMockBotWork() {
  return { what: 'building', since: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
}

// Staging-only mock GOVERNANCE proposals (DB-issue shaped) for the
// Proposals-tab vote panel, so the dynamic threshold + visibility-window
// countdown is exercisable on a prod-cloned staging DB via ?demo=1. Distinct
// from stagingMockIssues above (which mocks external GitHub issues). Each row
// carries precomputed gate fields because mocks bypass the live computation.
// Ids are 9100070-9100077, a block of their own: they once shared
// 9100001-9100008 with the merged mocks (votes.js), so one number named two
// different rows (tests/staging-demo-id-ranges.test.js keeps them apart).
function stagingMockGovernance() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const secsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
  const mk = (id, kind, title, payload, hours, up, down, gate = {}) => ({
    id,
    app_id: 0,
    kind,
    title,
    description: 'Staging demo governance proposal (?demo=1).',
    status: 'open',
    payload,
    created_by: 0,
    created_by_username: 'staging-tester',
    created_at: hoursAgo(hours),
    up_count: up,
    down_count: down,
    my_vote: null,
    chat_count: 0,
    last_message_at: null,
    votes_required: gate.required ?? Math.max(up, 1),
    merge_window_ends_at: gate.windowEndsAt ?? null,
    contested: gate.contested ?? false,
    // Request-time staging fixture marker. The client uses this only to
    // keep the synthetic apply-state examples visible even when the cloned
    // self-app is locked; real governance rows never carry it.
    demo: true,
  });
  return [
    // Unopposed rename, threshold met, window still running → countdown.
    mk(9100070, 'rename', '[Mock] Rename app to "Staging Demo App"',
      { newName: 'Staging Demo App' }, 6, 2, 0,
      { required: 2, windowEndsAt: hoursAhead(36) }),
    // #2086: an open featured-illustration proposal, so the card's preview
    // (proposed image beside the current one) is reviewable via ?demo=1 on
    // an empty staging DB. The image is a shipped static asset rather than
    // an app-illustrations id, which the empty DB could not serve.
    mk(9100077, 'featured_illustration', '[Mock] Change the featured illustration',
      {
        proposed: { url: '/icons/v3/icon-512.png', darkUrl: null, zoom: 1.2, x: 10, y: -5, tint: 'teal' },
        current: { url: '/icons/v3/icon-192.png', darkUrl: null, zoom: 1, x: 0, y: 0 },
        remove: false,
      }, 5, 1, 0,
      { required: 2, windowEndsAt: hoursAhead(30) }),
    // Contested secret change (down >= 1/3) → no countdown, full count gate.
    mk(9100071, 'secret_change', '[Mock] Set FEATURE_FLAG to "on"',
      { key: 'FEATURE_FLAG', action: 'set', hasValue: true }, 8, 4, 3,
      { required: 6, windowEndsAt: null, contested: true }),
    // Close-issue proposal targeting mock issue 900001 (served by
    // stagingMockIssues above), so the ?demo=1 preview shows the new
    // governance card AND the target issue row's disabled "Close
    // proposed" button state.
    mk(9100072, 'close_issue',
      '[Mock] Close issue #900001: "Dark mode toggle resets after refresh"',
      {
        issueNumber: 900001,
        issueTitle: 'Dark mode toggle resets after refresh',
        reason: 'Obsolete since the theme rework.',
      }, 4, 1, 0,
      { required: 2, windowEndsAt: hoursAhead(40) }),
    // #695: an invited-approver governance row with a non-approver
    // surplus — the approver-only pill + "+2 advisory" chip and the
    // "Yes (0✓ +2)" button labels are reviewable via ?demo=1.
    {
      ...mk(9100073, 'secret_change',
        '[Mock] Approver-mode test: set DEMO_FLAG (non-approver votes are advisory)',
        { key: 'DEMO_FLAG', action: 'set', hasValue: true }, 3, 2, 0,
        { required: 1 }),
      approval_policy: 'invited',
      approvals_required: 1,
      qualified_yes_count: 0,
      qualified_no_count: 0,
    },
    // #1010: the two DERIVED "being applied" states. Both have passed their
    // gate (up_count >= required, uncontested) with the visibility window
    // already elapsed — the shape a proposal has in the seconds between the
    // deciding vote and the apply landing. They differ only in HOW LONG ago
    // the window ended, which is what selects the state:
    //   9100074 — 30s ago  → inside the 120s grace → spinner, "Closing issue #900011…"
    //   9100075 — 10m ago  → past the grace        → "Close pending — will retry automatically"
    mk(9100074, 'close_issue',
      '[Mock] Close issue #900011: "Close vote passed — issue is being closed"',
      {
        issueNumber: 900011,
        issueTitle: 'Close vote passed — issue is being closed',
        reason: 'Fixed by the theme rework — closing.',
      }, 5, 2, 0,
      { required: 2, windowEndsAt: secsAgo(30) }),
    mk(9100075, 'close_issue',
      '[Mock] Close issue #900012: "Close vote passed a while ago — retry pending"',
      {
        issueNumber: 900012,
        issueTitle: 'Close vote passed a while ago — retry pending',
        reason: 'Duplicate of an older report.',
      }, 7, 2, 0,
      { required: 2, windowEndsAt: secsAgo(600) }),
    // Card-as-pointer revision: a SETTLED governance row. The vote is
    // history, so it renders the frozen pill and — with nothing left to
    // demote — no ⋯ trigger at all. Every other mock here is 'open', so
    // without this row the "no dead ⋯ button" rule is invisible in a
    // preview. (The Done column's own applied close-issue cards come from
    // stagingMockCompletedCloseIssues in votes.js; this one exercises the
    // gov card renderer's settled branch in the In-review column's shape.)
    {
      ...mk(9100076, 'close_issue',
        '[Mock] Settled: closed issue #900003 by vote — pill only, no ⋯',
        {
          issueNumber: 900003,
          issueTitle: '[Mock] Topic cards overflow on narrow phones',
          reason: 'Fixed by the responsive rework.',
          appliedAt: hoursAgo(2),
          appliedBy: 'group-vote',
          required: 2,
        }, 20, 2, 0, { required: 2 }),
      status: 'closed',
    },
  ];
}

// #396: staging-only mock comment threads for the topic view's GitHub
// comment section, served by GET /api/apps/:slug/github-issues/:number/
// comments when the live fetch is empty/unavailable. Obviously-fake
// "[Mock]" bodies, oldest-first (the same order fetchIssueComments
// returns), and at least one BOT-authored comment (`usernode-bot`) so the
// bot-labelling renders. Strictly a no-op in production.
//
// EVERY issue number gets a thread, not just the three mock ones. It used
// to be a lookup table keyed by stagingMockIssues' own 900001-900003, and
// `[]` for anything else — which meant the fallback both callers describe
// as "so the section is reviewable" did nothing for a REAL issue. That is
// the common case on a prod-cloned staging preview: the board's freshly
// triaged requests carry no replies yet, their live thread comes back
// empty, and the substitution had no row to make. Every feed slot rendered
// blank, and the declared check that asserts a rendered relative age
// (#1585) had nothing to find — it failed on every proposal, against code
// none of them had touched.
//
// The generic thread is deterministic in the issue number, so a preview and
// a declared check see the same two rows on every run; only the ages are
// clock-relative, which is the thing those rows exist to exercise.

// #2603: the voters behind a mock governance row's tally, so a ?demo=1 deep
// link into a close proposal shows the same roster — names and lines — a real
// one does. Obviously synthetic names; the counts are the row's own, so the
// roster can never disagree with the tally the card drew.
function stagingMockGovernanceVotes(id) {
  const row = stagingMockGovernance().find((m) => m.id === id);
  if (!row) return [];
  const LINES = {
    up: ['Checked it myself, nothing left to fix.', 'Happy for this one to go.'],
    down: ['It still happens on my phone.', 'I would rather leave this one open a while.'],
  };
  const out = [];
  const add = (vote, n) => {
    for (let i = 0; i < n; i += 1) {
      out.push({
        vote,
        username: `staging-voter-${vote}-${i + 1}`,
        // A No always carries its line; a Yes may go without one, and the
        // later mock voters do, so both readings are reviewable.
        reason: (vote === 'down' || i === 0) ? LINES[vote][i % LINES[vote].length] : null,
      });
    }
  };
  add('up', parseInt(row.up_count, 10) || 0);
  add('down', parseInt(row.down_count, 10) || 0);
  return out;
}

// Is `number` one of stagingMockIssues' own rows? The repo URL only shapes
// each row's htmlUrl, so any base answers the membership question.
function isStagingMockIssueNumber(number) {
  const n = Number(number);
  return stagingMockIssues('https://github.com/example/app').some((i) => i.number === n);
}

// #3490: the spec comment the Homeroom bot posts when it starts building a
// request, word for word as specCommentText writes it. #3693: around a spec
// as long as a real one, so this route clips it (clipIssueComments, 2,000
// characters) and cuts its closing `</details>` off, as it does a real one;
// a short spec here is how the request page could pass every check and
// still show the raw markers on every real request.
const MOCK_BOT_SPEC_COMMENT = [
  '[Mock] Homeroom bot wrote a plan for this request and is building it now.',
  '',
  '<details><summary>The plan</summary>',
  '',
  '# Keep the Vote and Preview buttons on screen on small phones',
  '',
  '## User-facing changes',
  '',
  'On a phone as narrow as an iPhone SE, the Vote and Preview buttons on a proposal card move onto a second '
    + 'line instead of running off the right edge.',
  '',
  '- Both buttons stay whole and tappable in portrait.',
  '- Nothing changes on wider screens.',
  '',
  '## Design',
  '',
  'The card\'s action row wraps rather than scrolls, and each button keeps its 44px tap target.',
  '',
  '### Assumptions',
  '',
  '- "Small phones" means anything 375 pixels wide or narrower, in portrait.',
  '- The order of the buttons stays the same when they wrap: Vote first, then Preview.',
  '- Landscape already has room for both buttons on one line, so it is left as it is.',
  '',
  '## Technical approach',
  '',
  'The proposal card\'s action row is a flex row with `flex-wrap: nowrap` and a fixed gap. It becomes '
    + '`flex-wrap: wrap`, with the gap applied on both axes so the second line sits as far below the first '
    + 'as the buttons sit apart. Each button keeps `min-height: 44px` and stops shrinking below its label, so '
    + 'a long translated label wraps the row instead of squeezing the text.',
  '',
  'The vote count beside the buttons moves with the first line. It is not allowed to wrap on its own, so it '
    + 'never ends up alone on a line under the buttons it counts.',
  '',
  '## Files',
  '',
  '- The proposal card\'s action row component, for the wrap and the gap.',
  '- The card\'s stylesheet, for the minimum button height on narrow screens.',
  '- The card\'s unit test, for a row that wraps at 320 pixels and stays on one line at 768.',
  '',
  '## Testing',
  '',
  '1. Open the Workshop on a phone in portrait, or a desktop window 320 pixels wide.',
  '2. Find a proposal card with both a Vote and a Preview button.',
  '3. Both buttons are whole, on screen, and at least 44 pixels tall; tapping each one works.',
  '4. Widen the window past 768 pixels: the buttons are back on one line, exactly as before.',
  '',
  '## Out of scope',
  '',
  '- The card\'s title and summary, which already wrap.',
  '- The Board\'s columns view, whose cards carry no Preview button.',
  '- Any change to what Vote or Preview do when they are tapped.',
  '',
  '</details>',
].join('\n');

function stagingMockIssueComments(number) {
  const n = Number(number);
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const daysAgo = (d) => hoursAgo(d * 24);
  // #1808: every thread opens with three rows whose stamps land in the three
  // branches the comment thread formats. An earlier year (fixed, so that
  // branch is reachable for as long as this fixture lives), earlier this
  // year, and inside the last few days. Before the fix all three read as a
  // bare time of day, so the ladder is what makes the change reviewable:
  // read down a thread and the stamps have to answer "when".
  const stampLadder = () => ([
    {
      author: 'staging-tester',
      body: '[Mock] Filing this from an earlier year, so the stamp on it has to carry one.',
      createdAt: '2024-03-05T09:15:00Z',
    },
    {
      author: 'usernode-bot',
      body: '[Mock] Picked this up about six weeks ago, far enough back that the day matters more than the hour.',
      createdAt: daysAgo(40),
    },
    {
      author: 'another-tester',
      body: '[Mock] And a reply from a few days ago, for the middle of the range.',
      createdAt: daysAgo(3),
    },
  ]);
  // #2556: one deliberately LONG reply per thread, so the "Show more" a
  // comment grows past four lines actually has something to hide in a
  // preview. Staging only, like every row in this function, and marked
  // "[Mock]" like every row in this function. It is last in each thread on
  // purpose: the Workshop's inline slot renders only the last two comments,
  // so a long row further up would be invisible on the surface that most
  // needed the clamp.
  const longReply = () => ({
    author: 'staging-tester',
    body: '[Mock] Writing this one out at length on purpose, because a short '
      + 'reply cannot show what a long one does to a card. Steps to reproduce: '
      + 'open the board on a narrow window, scroll to any row that has a '
      + 'conversation under it, and watch the row below it get pushed off the '
      + 'bottom of the screen by a single pasted stack trace. It happens on '
      + 'the topic page too, where three replies of this size turn the '
      + 'discussion into a page of scrolling before you reach the box to '
      + 'answer in. What I expected was the first few lines and a way to ask '
      + 'for the rest, the way the app list already offers one. What I got '
      + 'was the whole thing, every time, on every surface that renders a '
      + 'comment. Adding a few more sentences here so this stays longer than '
      + 'four lines at a desktop width as well as on a phone, since that is '
      + 'the case the control has to be measured against.',
    createdAt: hoursAgo(1),
  });
  const threads = {
    900001: [
      ...stampLadder(),
      { author: 'staging-tester', body: '[Mock] I can reproduce this every time on Firefox — the toggle flips back to light as soon as I reload.', createdAt: hoursAgo(40) },
      { author: 'usernode-bot', body: '[Mock] Thanks for the report. Is the preference meant to persist per-device or per-account? Defaulting to per-device unless you say otherwise.', createdAt: hoursAgo(36) },
      { author: 'staging-tester', body: '[Mock] Per-device is fine — just make it survive a refresh.', createdAt: hoursAgo(30) },
      longReply(),
    ],
    900002: [
      ...stampLadder(),
      { author: 'another-tester', body: '[Mock] +1, Y/N shortcuts would be a huge time-saver during a voting spree.', createdAt: hoursAgo(20) },
      { author: 'usernode-bot', body: '[Mock] Should the shortcut act on the focused card only, or the top card in the list? Going with the focused card.', createdAt: hoursAgo(18) },
      longReply(),
    ],
    900003: [
      ...stampLadder(),
      { author: 'staging-tester', body: '[Mock] Happens on my iPhone SE in portrait — the Vote and Preview buttons spill off the right edge.', createdAt: hoursAgo(28) },
      // #3490: Homeroom bot's spec, in the shape it writes one on a request
      // (services/homeroom-bot-live.js specCommentText), so the request page
      // draws it as a spec in a preview.
      { author: 'usernode-bot', body: MOCK_BOT_SPEC_COMMENT, createdAt: hoursAgo(20) },
      longReply(),
    ],
    // #3908: the screenshot issue's thread carries a picture too, so a
    // preview can open a comment's screenshot in the app's viewer as well
    // as the one in the request's body. Same same-origin asset as the body.
    900010: [
      ...stampLadder(),
      {
        author: 'another-tester',
        body: '[Mock] Same thing on my phone:\n\n![Screenshot from a phone](/icons/v3/icon-192.png)',
        createdAt: hoursAgo(12),
      },
      longReply(),
    ],
  };
  if (threads[n]) return threads[n];
  // A number that is not an issue at all (an unparseable :number reaches
  // the first caller before Number.isFinite is consulted) gets nothing.
  if (!Number.isFinite(n) || n <= 0) return [];
  return [
    ...stampLadder(),
    {
      author: 'staging-tester',
      body: `[Mock] Staging stand-in for issue #${n}: the live thread came back `
        + 'empty or unreachable from this preview container, so this is what the '
        + 'comment section renders instead.',
      createdAt: hoursAgo(26),
    },
    {
      author: 'usernode-bot',
      body: '[Mock] Replies you see here are fixtures, not the real thread. '
        + 'Staging only, and never served in production.',
      createdAt: hoursAgo(5),
    },
    longReply(),
  ];
}

// #3693: an issue's GitHub comments as its request page shows them, without
// the Homeroom bot's comments that the issue's own thread already carries.
// The bot posts everything twice, as a GitHub comment and as its message in
// the thread (services/homeroom-bot-live.js post), and the page draws the
// two threads one above the other, so each post read twice: "Homeroom bot
// is looking at this request" over the same line from homeroom_bot, and the
// spec's comment over its spec card. The thread copy is the one kept: it
// tags people and carries the card. Matched by the comment ids the bot
// recorded (threadCopiedCommentIds), never by text or author, so a person's
// comment and a bot comment with no thread copy always stay. Best-effort:
// when the lookup fails the thread is shown whole, as before; a line said
// twice is better than one lost.
async function withoutBotThreadCopies(pool, appId, issueNumber, comments) {
  const list = Array.isArray(comments) ? comments : [];
  if (!list.some((c) => c && c.id != null)) return list;
  let copied;
  try {
    copied = await require('../services/homeroom-bot-live').threadCopiedCommentIds(pool, appId, issueNumber);
  } catch (err) {
    log.warn('issues', 'Could not read the Homeroom bot posts (showing the whole thread)', {
      appId, issueNumber, err: err.message,
    });
    return list;
  }
  if (!copied || !copied.size) return list;
  return list.filter((c) => !(c && c.id != null && copied.has(String(c.id))));
}

// #6497: one read of a request's GitHub comments, for a page that draws them
// in its own discussion (src/routes/chat.js) as well as for the comments
// route below. `max` is how many of the newest are kept (the route's own
// default, clipIssueComments' 30, when it is null); a request's first page
// asks for every comment the reader fetched (github.ISSUE_COMMENTS_MAX).
// Never throws: a failure is an empty thread with a note, so the page still
// opens with what was said here.
async function readRequestComments(pool, app, number, { demo = false, max = null } = {}) {
  const clip = (list, wasTruncated = false) => (max == null
    ? github.clipIssueComments(list, { wasTruncated })
    : github.clipIssueComments(list, { wasTruncated, max }));
  try {
    const parsed = parseOwnerRepo(app && app.repo_url);
    const n = Number(number);

    if (!requestsOn() || !parsed || !Number.isFinite(n)) {
      if (!IS_STAGING) return { comments: [], truncated: false, note: 'unavailable' };
      const mocks = stagingMockIssueComments(n);
      const clipped = clip(mocks);
      return { comments: clipped.comments, truncated: clipped.truncated };
    }

    // Staging demo mode (?demo=1) on one of the MOCK rows: the page is on
    // fixtures by choice — the list route appends these rows for it — so
    // the thread is the fixture too, served without the live round trip.
    // No real issue has these numbers, so the live fetch can only come back
    // empty and fall through to the same mocks; what it costs is time. From
    // a preview container whose outbound fetch hangs, that is the whole
    // ISSUES_FETCH_TIMEOUT_MS, and the check runner polls a presence
    // assertion for five seconds after the page settles
    // (capture/capture.js ASSERT_MAX_MS) — exactly how the declared
    // issue-page check found no comment bubbles on staging while passing
    // locally, where GitHub is off and the mocks are immediate.
    if (IS_STAGING && demo && isStagingMockIssueNumber(n)) {
      const clipped = clip(stagingMockIssueComments(n));
      return { comments: clipped.comments, truncated: clipped.truncated };
    }

    const raw = await github.fetchIssueComments(parsed.owner, parsed.repo, n);
    // #3693: the bot's posts the issue's thread already shows are left out
    // before the clip, so they never take one of its places.
    const shown = await withoutBotThreadCopies(pool, app.id, n, raw.comments);
    const clipped = clip(shown, raw.truncated);

    // Staging-only fallback: an empty (or degraded) live thread would render
    // nothing in the preview, so mock comments stand in. Strictly a no-op in
    // production. Empty as GitHub sent it: a thread emptied only by leaving
    // out the bot's thread copies is what a preview should show.
    if (IS_STAGING && (raw.comments || []).length === 0) {
      const mocks = clip(stagingMockIssueComments(n));
      return { comments: mocks.comments, truncated: mocks.truncated };
    }

    return {
      comments: clipped.comments,
      truncated: clipped.truncated,
      ...(raw.note ? { note: raw.note } : {}),
    };
  } catch (err) {
    log.error('issues', 'Failed to fetch GitHub issue comments', { message: err.message });
    return { comments: [], truncated: false, note: 'unavailable' };
  }
}

// Pick the "In progress" chip's link destination from an issue's live
// linked sessions, per viewer. Priority: a promoted/merging session (the
// proposal — group-visible to everyone) > the viewer's own session (their
// dev chat) > a shared session (its public discussion). Other users'
// PRIVATE sessions yield no target — by current semantics they appear on
// no group surface, so the chip stays informational for those viewers.
// Ties within a class break to the most recently active session.
function pickInProgressTarget(sessions, viewerId) {
  const ts = (s) => {
    const t = Date.parse(s.last_activity_at || s.created_at || '');
    return Number.isFinite(t) ? t : 0;
  };
  const newest = (pred) => {
    let best = null;
    for (const s of sessions) {
      if (!pred(s)) continue;
      if (!best || ts(s) > ts(best)) best = s;
    }
    return best;
  };
  const proposal = newest((s) => s.status === 'promoted' || s.status === 'merging');
  if (proposal) return { kind: 'proposal', sessionId: proposal.id };
  const own = newest((s) => viewerId != null && s.user_id === viewerId);
  if (own) return { kind: 'session-own', sessionId: own.id };
  const shared = newest((s) => !!s.shared_at);
  if (shared) return { kind: 'session-shared', sessionId: shared.id };
  return null;
}

// Compose one issue's `in_progress` field from its live linked sessions
// and live claims (already expiry-filtered). Returns null when neither
// exists — the FE treats null as "no chip" (headless runs contribute via
// the separate issue.headless enrichment, ORed client-side).
function composeInProgress(sessions, claims, viewerId) {
  const sess = sessions || [];
  const live = claims || [];
  if (!sess.length && !live.length) return null;
  // Distinct session owners, in the order the query returned them. The
  // loop visits every session (#1112 — it used to `break` at 3, which is
  // how a five-person issue read "In progress · 3"); only the DISPLAY
  // list is capped, and the true headcount rides on peopleTotal below.
  const allUsers = [];
  for (const s of sess) {
    if (s.username && !allUsers.includes(s.username)) allUsers.push(s.username);
  }
  const users = allUsers.slice(0, 5);
  // #1112: the true distinct headcount over every session owner AND every
  // claimer, computed before any cap. The FE's "+N" suffix reads this, so
  // the chip can no longer understate a crowded issue.
  const everyone = new Set(allUsers);
  for (const c of live) if (c.username) everyone.add(c.username);
  // #1112: per-session detail so the FE can name WHICH work state an issue
  // is in (a proposal up for vote / a live chat / a paused chat) instead of
  // collapsing all of them into one "In progress" label. Most-recent
  // activity first, capped at 5 — the label names at most a couple, and the
  // tooltip enumerates roles rather than every row.
  const activityTs = (s) => {
    const t = Date.parse(s.last_activity_at || s.created_at || '');
    return Number.isFinite(t) ? t : 0;
  };
  const detail = [...sess]
    .sort((a, b) => activityTs(b) - activityTs(a))
    .slice(0, 5)
    .map((s) => ({
      sessionId: s.id,
      username: s.username || null,
      mine: s.user_id === viewerId,
      status: s.status || null,
      // Worked on by any process (read with the row: session-work.ts
      // workedOnSql), or by this one.
      busy: s.worked_on === true || isSessionBusy(s.id),
      lastActivityAt: s.last_activity_at || null,
    }));
  return {
    count: sess.length,
    users,
    peopleTotal: everyone.size,
    sessions: detail,
    mine: sess.some((s) => s.user_id === viewerId) || live.some((c) => c.user_id === viewerId),
    // Oldest-first, capped at 10 — beyond that only the names matter less
    // than the count, which the FE derives from the list it gets.
    claims: live.slice(0, 10).map((c) => ({
      username: c.username,
      // userId rides along solely for the admin per-claim clear control
      // (DELETE /claim with a userId body) — not sensitive, ids are used
      // in URLs/payloads platform-wide.
      userId: c.user_id,
      mine: c.user_id === viewerId,
      claimedAt: c.claimed_at,
      expiresAt: c.expires_at,
    })),
    target: pickInProgressTarget(sess, viewerId),
  };
}

// `?kinds=governance` on GET /api/apps/:slug/issues: only the governance
// kinds (services/governance-kinds.js), or null for every kind. The only
// named set; anything else is the whole list, as before.
function listedKinds(raw) {
  return raw === 'governance' ? [...require('../services/governance-kinds').GOVERNANCE_KINDS] : null;
}

function issueRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  // #5249: while kudos is parked a new bounty answers 410 Gone. Bounties
  // pledged before are kept and still paid on merge.
  const bountiesParked = kudosParked(config);

  // Per-app visibility gate for issue-id-addressed routes (/vote,
  // /close): collab-level access via the issue's app, 404 on deny.
  router.use('/api/issues/:id', appAccess.issueCollabGuard(pool));

  // List issues for an app. View-level (#621): read-only viewers see
  // the issue board; creating/voting stays collab-gated.
  router.get('/api/apps/:slug/issues', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const appId = gatedApp.id;

      const { rows } = await pool.query(
        `SELECT i.*, u.username as created_by_username,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up' AND counts_toward_outcome(user_id, i.app_id)) as up_count,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'down' AND counts_toward_outcome(user_id, i.app_id)) as down_count,
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $2) as my_vote,
           -- The member floor: a secret-change request carries a value, so
           -- it needs an up vote from someone other than its author.
           CASE WHEN i.kind = 'secret_change' THEN
             (SELECT COUNT(*)::int FROM issue_votes
               WHERE issue_id = i.id AND vote = 'up'
                 AND user_id IS DISTINCT FROM i.created_by
                 AND counts_toward_outcome(user_id, i.app_id))
           END as other_up_count,
           -- #194: governance-thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. chat_count counts human messages only
           -- (msg_type='message') so vote/lifecycle system rows don't
           -- inflate the 💬 badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) as last_message_at
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
         WHERE i.app_id = $1 AND i.status = 'open'
           AND ($3::text[] IS NULL OR i.kind = ANY($3::text[]))
         ORDER BY (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up' AND counts_toward_outcome(user_id, i.app_id)) DESC, i.created_at DESC`,
        // `?kinds=governance`: only the governance kinds. The Workshop draws
        // no others and discarded them on arrival — on the platform app that
        // was all 325 open rows (request twins), ~540 KB, and the five
        // subqueries each of them costs. Without it, every open row, as
        // before.
        [appId, req.user.id, listedKinds(req.query.kinds)]
      );

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appId);

      // #646: governance-aware per-row gate (mirrors /promoted). Under
      // the default settings this is the old mergeGate over the raw
      // tallies; under 'invited' only approver votes qualify (batched in
      // one query); under at-least-N the gate is the clock-free count.
      const governanceSvc = require('../services/governance');
      const gov = await governanceSvc.getGovernance(pool, appId);
      const electorate = await governanceSvc.getElectorate(pool, appId, gov);
      const qualifiedByRow = electorate.approverIds
        ? await governanceSvc.qualifiedCountsBatch(
          pool, 'issue', rows.map((r) => r.id), electorate.approverIds
        )
        : null;
      // A secret-change request is flagged (no timer, and a Yes from another
      // member; services/governance.js). One community read for the list,
      // only when one is open.
      const memberCount = rows.some((r) => r.kind === 'secret_change')
        ? await governanceSvc.communityMemberCount(pool, appId)
        : undefined;
      const secretReason = explicitApprovalCopy.secretChangeReason(!!gatedApp.self_hosted);
      // #4666: who voted, on a project with rules of its own.
      const rulesCtx = gov.rules
        ? await governanceSvc.rulesContext(pool, appId, gov, 'issue', rows.map((r) => r.id)) : null;

      // Strip ciphertext from secret_change rows before serializing —
      // the value should never be readable from this endpoint, even
      // by other admins. The committed value lands in app_secrets when the
      // governance machine applies the proposal.
      // Also attach the per-row dynamic merge gate (eased threshold +
      // visibility window) anchored on the issue's created_at, mirroring
      // the PR /promoted endpoint so governance pills get the same
      // countdown/Contested treatment.
      const sanitized = rows.map((row) => {
        const { other_up_count: otherUp, ...r } = row;
        const q = qualifiedByRow
          ? (qualifiedByRow.get(r.id) || { yes: 0, no: 0, otherYes: 0 })
          : { yes: r.up_count, no: r.down_count, otherYes: otherUp };
        const flagged = r.kind === 'secret_change';
        const gate = governanceSvc.computeGate(
          gov, electorate.active, q.yes, q.no, r.created_at, null,
          {
            ...(flagged ? { explicitApproval: true, otherYes: q.otherYes, memberCount } : {}),
            ...(rulesCtx ? governanceSvc.rulesGateOpts(rulesCtx, r.id, r.created_by ?? null, flagged ? 'secrets' : null) : {}),
          }
        );
        const withGate = {
          ...r,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          ...(gate.mode === 'rules' ? governanceSvc.ruleRowFields(gate) : {}),
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
          ...(flagged ? governanceSvc.explicitApprovalRowFields({
            requires_explicit_approval: true, explicit_approval_reason: secretReason,
          }, gate) : {}),
        };
        if (withGate.kind !== 'secret_change' || !withGate.payload) return withGate;
        const { valueEnc, ...rest } = withGate.payload;
        return { ...withGate, payload: { ...rest, hasValue: !!valueEnc } };
      });

      // Staging-only demo mode (?demo=1): append mock governance proposals
      // spanning the gate regimes (countdown + contested). No-op in prod.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(sanitized.map((r) => r.id));
        sanitized.push(...stagingMockGovernance().filter((m) => !have.has(m.id)));
      }

      res.json({ issues: sanitized, activeUsers, majority });
    } catch (err) {
      log.error('issues', 'Failed to list issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // (#1115) Single-governance-proposal-by-id fetch — the recovery path for
  // opening a governance proposal whose row isn't in the client's cached
  // lists, and the exact twin of GET /api/apps/:slug/proposals/:id in
  // votes.js. The list endpoint above returns OPEN rows only, and APPLIED
  // close-issue proposals live in the keyset-paginated Completed stream
  // (/merged), of which the client caches just the first page — so clicking
  // or deep-linking a settled close proposal beyond that page resolved to
  // nothing and bounced back to the dev board. The FE
  // (_fetchGovProposalById) calls this when _findTopicItem() comes up empty.
  //
  // Serves rows of ANY status (a status transition between list-render and
  // click still resolves), restricted to the four governance kinds the
  // client's gov topic view can actually render — anything else 404s, so
  // this never becomes a read path for other issue kinds' payloads.
  router.get('/api/apps/:slug/governance/:id', async (req, res) => {
    try {
      // View-level (#621): read-only viewers can open a governance
      // proposal's topic view (my_vote resolves to null for them).
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const appId = gatedApp.id;
      const userId = req.user?.id || null;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      // Same row shape the list endpoints return (the open-issues subqueries
      // above and the close-row select in /merged), so the topic header/card
      // renders identically whether the row came from a list or from here.
      const { rows } = await pool.query(
        `SELECT i.*, u.username as created_by_username,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up' AND counts_toward_outcome(user_id, i.app_id)) as up_count,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'down' AND counts_toward_outcome(user_id, i.app_id)) as down_count,
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $3) as my_vote,
           -- The member floor, as the list reads it.
           CASE WHEN i.kind = 'secret_change' THEN
             (SELECT COUNT(*)::int FROM issue_votes
               WHERE issue_id = i.id AND vote = 'up'
                 AND user_id IS DISTINCT FROM i.created_by
                 AND counts_toward_outcome(user_id, i.app_id))
           END as other_up_count,
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) as last_message_at
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
         WHERE i.app_id = $1 AND i.id = $2
           AND i.kind IN ('secret_change', 'rename', 'close_issue', 'reopen_issue', 'maintenance_campaign',
                          'featured_illustration', 'thread_move')
         LIMIT 1`,
        [appId, id, userId]
      );

      let proposal = rows[0] || null;
      if (proposal) {
        // Same per-row dynamic gate the list attaches, so an OPEN row's pill
        // gets its threshold / countdown / Contested treatment here too.
        // Settled rows carry it harmlessly (the card reads the frozen pill).
        const governanceSvc = require('../services/governance');
        const gov = await governanceSvc.getGovernance(pool, appId);
        const electorate = await governanceSvc.getElectorate(pool, appId, gov);
        const { other_up_count: otherUp, ...row } = proposal;
        const q = electorate.approverIds
          ? ((await governanceSvc.qualifiedCountsBatch(
            pool, 'issue', [row.id], electorate.approverIds
          )).get(row.id) || { yes: 0, no: 0, otherYes: 0 })
          : { yes: row.up_count, no: row.down_count, otherYes: otherUp };
        // Same flag as the list: a secret-change request needs a Yes from
        // another member and never applies on a timer.
        const flagged = row.kind === 'secret_change';
        const gate = governanceSvc.computeGate(
          gov, electorate.active, q.yes, q.no, row.created_at, null,
          {
            ...(flagged
              ? {
                explicitApproval: true,
                otherYes: q.otherYes,
                memberCount: await governanceSvc.communityMemberCount(pool, appId),
              }
              : {}),
            // #4666: who voted, on a project with rules of its own.
            ...(gov.rules ? governanceSvc.rulesGateOpts(
              await governanceSvc.rulesContext(pool, appId, gov, 'issue', [row.id]),
              row.id, row.created_by ?? null, flagged ? 'secrets' : null
            ) : {}),
          }
        );
        proposal = {
          ...row,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          ...(gate.mode === 'rules' ? governanceSvc.ruleRowFields(gate) : {}),
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
          ...(flagged ? governanceSvc.explicitApprovalRowFields({
            requires_explicit_approval: true,
            explicit_approval_reason: explicitApprovalCopy.secretChangeReason(!!gatedApp.self_hosted),
          }, gate) : {}),
        };
        // Never leak a secret_change's ciphertext, exactly as the list does.
        if (proposal.kind === 'secret_change' && proposal.payload) {
          const { valueEnc, ...rest } = proposal.payload;
          proposal.payload = { ...rest, hasValue: !!valueEnc };
        }
        // An applied close proposal is a Completed-stream row; stamp the
        // discriminator so it's interchangeable with the /merged shape for
        // any consumer that branches on row_type (e.g. _showExplorePill).
        if (proposal.kind === 'close_issue' && proposal.status === 'closed'
            && proposal.payload && proposal.payload.appliedAt) {
          proposal.row_type = 'close_issue';
          // /merged also attaches the closed issue's priority/assignee/
          // category tally to these rows (a task moved to Done keeps its
          // chips); mirror it here so the by-id recovery path stays
          // shape-interchangeable with the stream.
          const closedRef = parseInt(proposal.payload.issueNumber, 10);
          if (Number.isInteger(closedRef) && closedRef > 0) {
            const closedAttrs = await topicAttrs.summarizeForTargets(
              pool, appId, 'issue', [closedRef], userId
            );
            const s = closedAttrs.get(closedRef) || topicAttrs.emptySummary();
            proposal.priority = s.priority;
            proposal.assignee = s.assignee;
            proposal.category = s.category;
          }
        }
      }

      // Staging demo mode (?demo=1): the mock governance rows aren't in the
      // DB, so resolve a mock id straight from the generators. This is what
      // lets a staging tester deep-link mock close proposal 9100062, which is
      // deliberately too old to ever reach the demo Completed stream's first
      // page and is therefore reachable ONLY through this endpoint. The
      // applied-close mocks live in votes.js (they belong to that stream);
      // lazy-required here to keep the issues <-> votes load order safe.
      if (!proposal && IS_STAGING && req.query.demo === '1') {
        proposal = stagingMockGovernance().find((m) => m.id === id)
          || require('./votes').stagingMockCompletedCloseIssues()
            .find((m) => m.id === id)
          || null;
      }

      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      // #6440: where this vote belongs. A vote about one request or thread is
      // drawn on that page, not on a page of its own: the client forwards
      // `dev/governance/<id>` there. Every other kind stays here (`null`).
      proposal.home = await governanceHome(pool, proposal);
      // #6440: how it ended, in one word the page's Votes card reads, so it
      // never says "waiting for votes" after the vote ended.
      proposal.outcome = governanceOutcome(proposal);
      res.json({ proposal });
    } catch (err) {
      log.error('issues', 'Failed to get governance proposal by id', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2603: who voted which way on a governance proposal, and the line each
  // vote carries — the issue-side mirror of GET /api/sessions/:id/votes, and
  // the source the close-issue card's roster reads. View-level like the by-id
  // handler above it, and keyed by slug for the same reason: a ?demo=1 mock
  // id is not a row, so it never reaches the id-addressed collab guard.
  router.get('/api/apps/:slug/governance/:id/votes', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(404).json({ error: 'Proposal not found' });

      const { rows } = await pool.query(
        `SELECT iv.vote, iv.reason, u.username
           FROM issue_votes iv
           JOIN users u ON u.id = iv.user_id
           JOIN issues i ON i.id = iv.issue_id
          WHERE iv.issue_id = $1 AND i.app_id = $2
          ORDER BY iv.created_at ASC, iv.id ASC`,
        [id, gatedApp.id]
      );

      // The mock governance rows aren't in the DB, so a ?demo=1 deep link
      // reads its roster from the same generators the card came from.
      const votes = (!rows.length && IS_STAGING && req.query.demo === '1')
        ? stagingMockGovernanceVotes(id)
        : rows;

      // 'up'/'down' is the issue vocabulary; 'yes'/'no' is what a roster
      // says, and what the shared roster component renders.
      res.json({
        yes: votes.filter((r) => r.vote === 'up').map((r) => r.username),
        no: votes.filter((r) => r.vote === 'down').map((r) => r.username),
        reasons: votes.filter((r) => r.reason).map((r) => ({
          username: r.username,
          vote: r.vote === 'down' ? 'no' : 'yes',
          reason: r.reason,
        })),
      });
    } catch (err) {
      log.error('issues', 'Failed to list governance votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create an issue / proposal — kinds per VALID_KINDS above (general is
  // the default). Rate-limited per kind: close_issue proposals draw from
  // their own bucket, everything else from issue-create.
  // B8: "Ask Homeroom bot to build this" on a request's page. It goes first
  // in the bot's queue, paid from the asker's building time; the request
  // stays whoever's it is (services/homeroom-bot-dm.js askBotToBuild). A
  // member's own tap only: same-origin, and on no connector's list. #4530:
  // 409 `awaiting_reply` while the bot is waiting on an answer there (the
  // repository, to read the issue's comments for one).
  //
  //   POST /api/apps/:slug/issues/:number/homeroom-bot → { ok, typicalMinutes, mine }
  router.post('/api/apps/:slug/issues/:number/homeroom-bot', issueKindLimiter, sameOriginBrowserOnly,
    communities.requireAppMembership(pool), async (req, res) => {
      try {
        const n = Number(req.params.number);
        if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Invalid request number' });
        // The demo's door decides nothing.
        if (IS_STAGING && req.query.demo === '1') return res.json({ ok: true, demo: true, typicalMinutes: 8, mine: true });
        const app = await appAccess.getAppForUser(
          pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`,
        );
        if (!app) return res.status(404).json({ error: 'App not found' });
        const out = await require('../services/homeroom-bot-dm').askBotToBuild(pool, {
          app, user: req.user, issueNumber: n, readAgain: req.body?.readAgain === true,
        });
        if (!out.ok) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
        return res.json(out);
      } catch (err) {
        log.error('issues', 'Asking Homeroom bot to build failed', { message: err.message, slug: req.params.slug });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

  // 1 Nov 2026 (threads, one loop: phase B): "Let the bot build it now"
  // under "Homeroom bot is waiting for your plan." on a request's page: the
  // viewer's own private thread about their request no longer holds the
  // bot (services/private-threads.js liftHold, by 'go'), and the lane looks
  // again. Their own tap only: same-origin, on no connector's list.
  //
  //   POST /api/apps/:slug/issues/:number/bot-go → { ok, lifted }
  router.post('/api/apps/:slug/issues/:number/bot-go', issueKindLimiter, sameOriginBrowserOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const n = Number(req.params.number);
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Invalid request number' });
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const out = await require('../services/private-threads').liftHold(pool, {
        appId: app.id, issueNumber: n, by: 'go', userId: req.user.id,
      });
      return res.json({ ok: true, lifted: out.lifted });
    } catch (err) {
      log.error('issues', 'Letting Homeroom bot build failed', { message: err.message, slug: req.params.slug });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6420: a change's `linked_issues` is a claim, not a merge. The request's
  // requester can answer "This doesn't close it": the claim is marked (the
  // change's vote card reads the same row) and one line is posted in the
  // change's discussion so voters see it. The request stays linked: only its
  // builder can remove it, and merging still closes it.
  //
  //   POST /api/apps/:slug/issues/:number/changes/:sessionId/not-closing
  router.post('/api/apps/:slug/issues/:number/changes/:sessionId/not-closing', issueKindLimiter, sameOriginBrowserOnly,
    communities.requireAppMembership(pool), async (req, res) => {
      try {
        const n = Number(req.params.number);
        const sessionId = Number(req.params.sessionId);
        if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
          return res.status(400).json({ error: 'Invalid request or change' });
        }
        const app = await appAccess.getAppForUser(
          pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS,
        );
        if (!app) return res.status(404).json({ error: 'App not found' });
        const out = await require('../services/change-claims').dispute(pool, {
          appId: app.id, requestNumber: n, sessionId, userId: req.user.id, username: req.user.username,
        });
        if (!out.ok) return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
        return res.json({ ok: true, disputed: true });
      } catch (err) {
        log.error('issues', 'Answering a change\'s claim failed', { message: err.message, slug: req.params.slug });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

  router.post('/api/apps/:slug/issues', issueKindLimiter, communities.requireAppMembership(pool), async (req, res) => {
    let { title, description, kind = 'general', payload = {} } = req.body || {};

    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Invalid kind; must be one of ${VALID_KINDS.join(', ')}` });
    }

    // api:access is intentionally not a credential-management capability.
    // This route multiplexes ordinary issues and secret-change proposals, so
    // the path policy alone cannot distinguish them. Enforce the boundary at
    // the kind dispatch before reading, validating, or encrypting a value.
    if (req.cliAuthenticated && kind === 'secret_change') {
      return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Screenshots on an ordinary request (the connector's create_request):
      // ids the caller already uploaded through POST /api/feedback/screenshot,
      // checked by the same rules the feedback dialog's are (routes/feedback.js)
      // and embedded the same way. Only `screenshotIds`: the legacy single
      // `screenshotId` belongs to the feedback outbox, not to this route. A
      // governance proposal's body is the platform's own text, so it takes none.
      const parsedShots = parseScreenshotIds({ screenshotIds: req.body?.screenshotIds });
      if (!parsedShots.ok) return res.status(400).json({ error: parsedShots.error });
      const screenshotIds = parsedShots.ids;
      if (screenshotIds.length && kind !== 'general') {
        return res.status(400).json({ error: 'Screenshots can only be attached to an ordinary request' });
      }
      // A clip, the same way: one id of a video the caller already uploaded
      // (the feedback dialog's POST /api/feedback/video, or the connector's
      // upload), checked as /api/feedback checks it and embedded as its link,
      // which the request page plays inline.
      const parsedVideo = parseVideoId(req.body);
      if (!parsedVideo.ok) return res.status(400).json({ error: parsedVideo.error });
      const videoId = parsedVideo.id;
      if (videoId && kind !== 'general') {
        return res.status(400).json({ error: 'A video can only be attached to an ordinary request' });
      }

      // Kind-specific validation + auto-filled title/description.
      if (kind === 'secret_change') {
        const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
        const action = typeof payload?.action === 'string' ? payload.action : 'set';
        // Trimmed HERE, at proposal creation, not at apply. The apply path
        // for a child app writes app_secrets with raw SQL (the governance
        // machine's applySecret, src/workflow/governance-proposal/) and never reaches
        // appSecrets.setValue, so creation is the only boundary that covers
        // both stores — and normalizing before encrypt/valueLast4 keeps the
        // proposal card's preview identical to what will actually be stored.
        // Both DAOs implement the identical rule, so either normalizeValue
        // serves both scopes.
        const value = platformEnv.normalizeValue(
          typeof payload?.value === 'string' ? payload.value : ''
        );
        if (!appManifest.KEY_RE.test(key)) {
          return res.status(400).json({ error: 'payload.key must be UPPER_SNAKE_CASE' });
        }
        if (appManifest.RESERVED_KEYS.has(key)) {
          return res.status(400).json({ error: `${key} is reserved by the platform` });
        }
        // The self-hosted app's proposals write platform_env_values, so the
        // key has to clear the same bar a direct admin write does: no
        // credential and no deploy-owned key, ever. Refusing at CREATION
        // (rather than at apply) matters \u2014 a vote that can only ever be
        // refused is worse than no vote, and "let's rotate JWT_SECRET by
        // majority" must never appear on the proposals list at all.
        if (app.self_hosted && !platformEnv.isWritableKey(key)) {
          return res.status(400).json({
            error: 'This variable is set by the deploy from a GitHub secret and cannot be edited here.',
          });
        }
        if (!['set', 'delete'].includes(action)) {
          return res.status(400).json({ error: 'payload.action must be "set" or "delete"' });
        }
        if (action === 'set' && (!value.length || value.length > MAX_SECRET_VALUE_LENGTH)) {
          return res.status(400).json({
            error: `payload.value is required and must be \u2264 ${MAX_SECRET_VALUE_LENGTH} chars`,
          });
        }
        // Representability, same rule and same message the panel's direct
        // write uses: a value carrying a single quote or a bare CR cannot
        // survive being written into the platform's .env, so it is rejected
        // now rather than accepted and silently dropped by a deploy days
        // later. (MAX_SECRET_VALUE_LENGTH above is the tighter of the two
        // length caps, so the DAO's 8192 never binds on this path.)
        if (app.self_hosted && action === 'set') {
          const unrepresentable = platformEnv.validateValue(value);
          if (unrepresentable) return res.status(400).json({ error: unrepresentable });
        }

        const manifest = (app.manifest_snapshot && typeof app.manifest_snapshot === 'object')
          ? app.manifest_snapshot : { secrets: [] };
        // Which block declares this key depends on which store the apply
        // will write. For the platform that's `platform_env`; reading
        // `secrets` there would classify a private tunable as public and
        // capture its last-4 into the proposal payload.
        const declared = app.self_hosted
          ? (manifest.platform_env || []).find((s) => s.key === key)
          : (manifest.secrets || []).find((s) => s.key === key);
        // `private` is canonical; manifest.read() also accepts the
        // legacy `sensitive` alias and normalizes to `.private`.
        //
        // An UNDECLARED key on the platform defaults to private, matching
        // platform-env.setValue(): the safe default for a variable nothing
        // has declared yet is "don't display it".
        const isPrivate = app.self_hosted
          ? (declared ? !!declared.private : true)
          : !!declared?.private;

        // Encrypt the proposed value before it ever lands in the DB.
        // Even other admins reading the issues table see only ciphertext;
        // the GET /api/apps/:slug/issues route strips it from the
        // payload before serializing (see further below).
        const valueEnc = action === 'set' ? encrypt(value, config.dataEncryptionKey) : null;
        const valueLast4 = action === 'set' && !isPrivate
          ? value.slice(-4) : null;

        // Persist BOTH `private` (canonical) and `sensitive` (BC) on the
        // issue payload so any in-flight issue serialized by an older
        // build keeps deserializing cleanly when the votes complete.
        payload = { key, action, valueEnc, valueLast4, private: isPrivate, sensitive: isPrivate };
        title = action === 'delete'
          ? `Remove secret "${key}"`
          : `Set secret "${key}"`;
        // The platform's own variables reach the process through the next
        // DEPLOY, not through a rebuild of a container — so don't promise a
        // redeploy the apply path deliberately never performs.
        description = description?.trim() ||
          `${req.user.username} (via Homeroom) proposed ${
            action === 'delete' ? 'removing' : 'setting'
          } the env var "${key}". ${app.self_hosted
            ? 'Auto-applies when a majority of active users vote up; the value reaches the platform on its next deploy.'
            : 'Auto-applies + redeploys when a majority of active users vote up.'}`;
      } else if (kind === 'close_issue') {
        const issueNumber = Number(payload?.issueNumber);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          return res.status(400).json({ error: 'payload.issueNumber must be a positive integer' });
        }
        const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
        if (reason.length > MAX_CLOSE_REASON_LENGTH) {
          return res.status(400).json({
            error: `payload.reason must be ≤ ${MAX_CLOSE_REASON_LENGTH} chars`,
          });
        }

        // Verify the target is a CURRENTLY OPEN GitHub issue on this repo
        // before creating the proposal — same policy as the bounty route:
        // fetchPublicIssues never throws; a degraded fetch (note) means no
        // positive confirmation, so refuse and change nothing.
        const parsed = parseOwnerRepo(app.repo_url);
        if (!requestsOn() || !parsed) {
          return res.status(422).json({
            error: 'Cannot verify the request right now: requests are unavailable for this app.',
          });
        }
        const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
        if (ghResult.note) {
          return res.status(422).json({
            error: "Couldn't confirm this issue is open right now. Try again in a moment.",
          });
        }
        const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
        if (!target) {
          return res.status(404).json({
            error: `Issue #${issueNumber} isn't an open issue on this repo.`,
          });
        }

        // Dedupe: one open close proposal per issue per app. The UI also
        // disables the button, but two clients can race — refuse here.
        const { rows: dupRows } = await pool.query(
          `SELECT id FROM issues
            WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
              AND (payload->>'issueNumber')::int = $2`,
          [app.id, issueNumber]
        );
        if (dupRows.length) {
          return res.status(409).json({
            error: `A close proposal for issue #${issueNumber} is already open`,
          });
        }

        // The target's number lives ONLY in the payload — never in
        // github_issue_number, which means "this proposal's GitHub twin"
        // and would make the withdraw route close the target issue.
        const issueTitle = String(target.title || '').slice(0, 300);
        payload = { issueNumber, issueTitle, reason: reason || null };
        title = `Close issue #${issueNumber}: "${issueTitle}"`.slice(0, 512);
        description = reason || null;
      } else if (kind === 'reopen_issue') {
        // #6000: a closed request the group is asked to bring back. The
        // target's current state is read from GitHub, raw, so a closed issue
        // that is not on the public list (or a pull request number) is
        // refused rather than turned into a vote with no effect.
        const issueNumber = Number(payload?.issueNumber);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          return res.status(400).json({ error: 'payload.issueNumber must be a positive integer' });
        }
        const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
        if (reason.length > MAX_CLOSE_REASON_LENGTH) {
          return res.status(400).json({
            error: `payload.reason must be ≤ ${MAX_CLOSE_REASON_LENGTH} chars`,
          });
        }

        const parsed = parseOwnerRepo(app.repo_url);
        if (!requestsOn() || !parsed) {
          return res.status(422).json({
            error: 'Cannot verify the request right now: requests are unavailable for this app.',
          });
        }
        let target;
        try {
          target = await github.getIssue(parsed.owner, parsed.repo, issueNumber);
        } catch (err) {
          if (err?.status === 404) {
            return res.status(404).json({
              error: `Issue #${issueNumber} isn't an issue on this repo.`,
            });
          }
          return res.status(422).json({
            error: "Couldn't confirm this issue is closed right now. Try again in a moment.",
          });
        }
        if (!target || target.pull_request) {
          return res.status(404).json({
            error: `Issue #${issueNumber} isn't an issue on this repo.`,
          });
        }
        if (target.state !== 'closed') {
          return res.status(409).json({
            error: `Issue #${issueNumber} is already open`,
          });
        }

        // Dedupe: one open reopen proposal per issue per app, as close is.
        const { rows: dupRows } = await pool.query(
          `SELECT id FROM issues
            WHERE app_id = $1 AND kind = 'reopen_issue' AND status = 'open'
              AND (payload->>'issueNumber')::int = $2`,
          [app.id, issueNumber]
        );
        if (dupRows.length) {
          return res.status(409).json({
            error: `A reopen proposal for issue #${issueNumber} is already open`,
          });
        }

        const issueTitle = String(target.title || '').slice(0, 300);
        payload = { issueNumber, issueTitle, reason: reason || null };
        title = `Reopen issue #${issueNumber}: "${issueTitle}"`.slice(0, 512);
        description = reason || null;
      } else if (kind === 'maintenance_campaign') {
        // Fleet maintenance (#853): only proposable on the self-hosted
        // platform app (the campaign's blast radius is EVERY child app,
        // so the vote belongs to the platform's own governance surface),
        // and only by users who could force the result anyway — the
        // campaign instructions are executed by an AI with write access
        // to every app repo, so authorship is admin-gated even though
        // approval still goes through the community vote.
        if (!app.self_hosted) {
          return res.status(400).json({
            error: 'Maintenance campaigns can only be proposed on the platform app',
          });
        }
        if (!req.user?.canAdminWrite) {
          return res.status(403).json({ error: 'Full admin access required' });
        }
        if (!requestsOn()) {
          return res.status(422).json({ error: 'Changes cannot be made here, so campaigns cannot run' });
        }
        const campaignTitle = typeof title === 'string' ? title.trim() : '';
        const instructions = typeof payload?.instructions === 'string' ? payload.instructions.trim() : '';
        if (!campaignTitle || campaignTitle.length > MAX_CAMPAIGN_TITLE_LENGTH) {
          return res.status(400).json({
            error: `Title is required and must be ≤ ${MAX_CAMPAIGN_TITLE_LENGTH} chars`,
          });
        }
        if (!instructions || instructions.length > MAX_CAMPAIGN_INSTRUCTIONS_LENGTH) {
          return res.status(400).json({
            error: `payload.instructions is required and must be ≤ ${MAX_CAMPAIGN_INSTRUCTIONS_LENGTH} chars`,
          });
        }
        // Optional slug allowlist; anything else in the payload is dropped.
        const targetFilter = Array.isArray(payload?.targetFilter)
          ? payload.targetFilter.map((s) => String(s).trim()).filter(Boolean).slice(0, 500)
          : null;
        // payload.title is the RAW campaign title (it becomes the per-app
        // PR title); issues.title carries the display prefix.
        payload = {
          title: campaignTitle,
          instructions,
          ...(targetFilter && targetFilter.length ? { targetFilter } : {}),
        };
        title = `Maintenance campaign: ${campaignTitle}`.slice(0, 512);
        description = description?.trim()
          || `${req.user.username} proposed a platform-wide maintenance campaign. If approved, `
          + 'an AI will apply the campaign instructions to '
          + (targetFilter && targetFilter.length ? `${targetFilter.length} selected app(s)` : 'every app')
          + ', opening one PR per app for its community to review and merge.';
      } else {
        if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
        title = title.trim();
        description = description || null;
        payload = typeof payload === 'object' && payload ? payload : {};
        if (screenshotIds.length) {
          // Every id, before GitHub is called: one foreign or already-linked
          // id files nothing.
          const { rows: owned } = await pool.query(
            `SELECT id FROM issue_screenshots
              WHERE id = ANY($1::varchar[]) AND user_id = $2 AND issue_number IS NULL`,
            [screenshotIds, req.user.id]
          );
          if (owned.length !== screenshotIds.length) {
            return res.status(400).json({ error: 'Unknown or already-used screenshot' });
          }
          description = issueBodyWithScreenshots(
            description, screenshotIds, require('../services/caddy').USERNODE_DOMAIN
          );
        }
        if (videoId) {
          const { rows: ownedVideo } = await pool.query(
            `SELECT id FROM issue_videos
              WHERE id = $1::varchar AND user_id = $2 AND issue_number IS NULL`,
            [videoId, req.user.id]
          );
          if (!ownedVideo.length) return res.status(400).json({ error: 'Unknown or already-used video' });
          // After the stills, as the feedback route orders them.
          const videoEmbed = buildVideoEmbed(videoId, require('../services/caddy').USERNODE_DOMAIN);
          description = description ? `${description}${videoEmbed}` : videoEmbed.replace(/^\n+/, '');
        }
        // The embed lines are the platform's, appended after the caller
        // measured its description, so this is where the body can first
        // outgrow GitHub's limit. Refused with the numbers, never trimmed.
        if ((screenshotIds.length || videoId) && description.length > MAX_GITHUB_ISSUE_BODY_CHARS) {
          const lines = [
            screenshotIds.length ? `${screenshotIds.length} image line(s)` : null,
            videoId ? 'video line' : null,
          ].filter(Boolean).join(' and ');
          return res.status(400).json({
            error: 'description_too_long',
            message: `The description and its ${lines} come to `
              + `${description.length} characters, over GitHub's ${MAX_GITHUB_ISSUE_BODY_CHARS}-character `
              + `issue-body limit. Nothing was filed. Shorten the description by at least `
              + `${description.length - MAX_GITHUB_ISSUE_BODY_CHARS} characters.`,
          });
        }
      }

      // GitHub twin — skipped only for platform-governance kinds. A general
      // issue is represented by its GitHub issue throughout the board, so
      // never claim success by inserting a local-only row the UI cannot
      // render. Configuration and upstream failures return before any local
      // issue/chat state is written.
      let githubIssueNumber = null;
      let twinRepo = null;
      if (shouldCreateGithubTwin(kind)) {
        const parsed = parseOwnerRepo(app.repo_url);
        twinRepo = parsed;
        if (!requestsOn() || !parsed) {
          return res.status(422).json({
            error: 'Requests are unavailable for this app; nothing was filed.',
          });
        }
        try {
          const ghIssue = await github.createIssue(parsed.owner, parsed.repo, {
            title,
            body: description || '',
          });
          if (!Number.isInteger(ghIssue?.number) || ghIssue.number <= 0) {
            throw new Error('GitHub returned an invalid issue number');
          }
          githubIssueNumber = ghIssue.number;
        } catch (err) {
          log.warn('issues', 'GitHub issue creation failed', { err: err.message });
          return res.status(503).json({
            error: 'GitHub issue creation failed; no local issue was created.',
          });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [app.id, githubIssueNumber, title, description, kind, JSON.stringify(payload), req.user.id]
      );

      // Stamp the screenshots with the filed issue so the orphan sweep keeps
      // them. Best-effort, like the feedback route's: the issue already
      // exists, so a failure risks only the images 404ing after 24 hours.
      if (screenshotIds.length && githubIssueNumber && twinRepo) {
        try {
          await pool.query(
            `UPDATE issue_screenshots
                SET issue_owner = $2, issue_repo = $3, issue_number = $4
              WHERE id = ANY($1::varchar[]) AND user_id = $5 AND issue_number IS NULL`,
            [screenshotIds, twinRepo.owner, twinRepo.repo, githubIssueNumber, req.user.id]
          );
        } catch (err) {
          log.warn('issues', 'Screenshot link failed', { screenshotIds, message: err.message });
        }
      }
      if (videoId && githubIssueNumber && twinRepo) {
        try {
          await pool.query(
            `UPDATE issue_videos
                SET issue_owner = $2, issue_repo = $3, issue_number = $4
              WHERE id = $1::varchar AND user_id = $5 AND issue_number IS NULL`,
            [videoId, twinRepo.owner, twinRepo.repo, githubIssueNumber, req.user.id]
          );
        } catch (err) {
          log.warn('issues', 'Video link failed', { videoId, message: err.message });
        }
      }

      let chatPrefix;
      if (kind === 'secret_change') {
        chatPrefix = payload.action === 'delete'
          ? `${req.user.username} proposed removing secret ${payload.key}`
          : `${req.user.username} proposed setting secret ${payload.key}`;
      } else if (kind === 'close_issue') {
        chatPrefix = `${req.user.username} proposed closing issue #${payload.issueNumber}: "${payload.issueTitle}"`;
      } else if (kind === 'reopen_issue') {
        chatPrefix = `${req.user.username} proposed reopening issue #${payload.issueNumber}: "${payload.issueTitle}"`;
      } else if (kind === 'maintenance_campaign') {
        chatPrefix = `${req.user.username} proposed a maintenance campaign: "${payload.title}"`;
      } else {
        chatPrefix = `${req.user.username} created issue: "${title}"`;
      }
      const createdMsg = `${chatPrefix}${githubIssueNumber ? ` (#${githubIssueNumber})` : ''}`;

      // #1374: a new issue notified nobody before this. Fanned out to the
      // app's stakeholders and gated on the `new_issues` category, which
      // DEFAULTS OFF — so on a platform with no stored preferences this
      // sends nothing at all, and it is opt-in per app from the tile menu.
      // #3952: the people its text names with @ are told too; #4271: once
      // each, the mention standing in for the new-request row
      // (notifyIssueFiled). Only a request with its GitHub twin is read for
      // names: a governance proposal's local id is not a request's number.
      //
      // Best-effort and never awaited into the response: filing an issue
      // must not fail because a notification insert did. The issue is on
      // the board either way, which is the whole reason suppressing a
      // notification here is not destructive. notifyIssueFiled never rejects.
      notifications.notifyIssueFiled?.(pool, {
        appId: app.id,
        issueNumber: githubIssueNumber || rows[0].id,
        authorId: req.user.id,
        text: githubIssueNumber ? `${title}\n\n${description || ''}` : '',
      });
      // Post the creation into the topic's own thread so the
      // discussion opens with its origin in context: governance proposals
      // (secret_change / rename / close_issue) thread on the local issue
      // id; general issues thread on the GitHub twin number (no twin → no
      // thread yet). A close_issue proposal ALSO posts into its target
      // issue's thread so followers of the issue see the vote start.
      if (kind === 'secret_change' || kind === 'rename' || kind === 'close_issue'
          || kind === 'reopen_issue' || kind === 'maintenance_campaign' || kind === 'featured_illustration') {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'governance', ref: rows[0].id }).catch(() => {});
        if ((kind === 'close_issue' || kind === 'reopen_issue') && payload.issueNumber) {
          await sendSystemMessage(pool, app.id, createdMsg, 'system',
            null, { type: 'issue', ref: payload.issueNumber }).catch(() => {});
        }
      } else if (githubIssueNumber) {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'issue', ref: githubIssueNumber }).catch(() => {});
      }

      // Enrolled now; a failure here is caught by the next vote or boot backfill.
      if (isGovernanceKind(kind)) {
        await workflow().fileProposal(rows[0].id, app.id).catch((err) =>
          log.warn('issues', 'Filing the governance proposal failed', { issueId: rows[0].id, err: err.message }));
      }
      pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: rows[0].id, kind });
      // The Homeroom bot triages a new request as soon as it exists — the
      // create carries the local row's id, so the twin's number goes here.
      if (githubIssueNumber) {
        try {
          require('../services/homeroom-bot').noteIssueActivity({ appId: app.id, issueNumber: githubIssueNumber, reason: 'created' });
        } catch (botErr) {
          log.warn('issues', 'Homeroom bot wake failed', { err: botErr.message });
        }
      }

      log.info('issues', 'Issue created', { issueId: rows[0].id, kind, title });
      res.status(201).json({ issue: rows[0] });
    } catch (err) {
      log.error('issues', 'Failed to create issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Vote on an issue. A governance proposal's vote goes to the governance
  // machine, which records it and applies the proposal when the vote decides
  // it; a request's vote is recorded here.
  // #2525: same bucket as proposal votes — a changed issue vote posts a
  // system line into the issue's thread, so flipping is the spam shape.
  //
  // #2603: a governance vote carries the same one line a proposal vote does.
  // The rules are votes.js's, reused rather than restated: the same
  // normaliser, the same 280-character cap, required on a No and optional on
  // a Yes. Lazily required, matching the direction this module already uses
  // for './votes' (see the demo close rows in the by-id handler above).
  router.post('/api/issues/:id/vote', governanceVoteLimiter, communities.requireIssueMembership(pool), async (req, res) => {
    const { vote } = req.body;
    if (!['up', 'down'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "up" or "down"' });
    }
    const votesModule = require('./votes');
    const normalized = votesModule.normalizeVoteReason(req.body?.reason);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const reason = normalized.reason;

    const issueId = positiveIssueId(req.params.id);
    if (!issueId) return res.status(404).json({ error: 'Issue not found' });

    try {
      // Join to apps so we have the slug for the WS broadcast below;
      // without it, other users' vote panels wouldn't refresh until they
      // reload the page.
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [issueId]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];
      // A private member does not vote on a public app (communities.js).
      const privateRefusal = await communities.privateVoteRefusal(pool, issue.app_id, req.user?.id);
      if (privateRefusal) return res.status(403).json(privateRefusal);
      // A public app's vote counts from a verified account (communities.js).
      const identityRefusal = await communities.identityVoteRefusal(pool, issue.app_id, req.user?.id);
      if (identityRefusal) return res.status(403).json(identityRefusal);

      // A vote can be the transition that decrypts and applies a proposed
      // secret value. api:access deliberately excludes credential management,
      // so enforce the issue kind after lookup and before touching votes.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      // The governance machine records the vote, decides the toggle and the
      // No's line under its lock, and applies when the vote decides it.
      if (isGovernanceKind(issue.kind)) {
        const reply = await workflow().voteOnProposal(issue, req.user,
          { vote, reason, requestKey: req.get('Idempotency-Key') || undefined });
        // "Vote on a change" counts it now, as a vote on a request or a
        // change does below (challengeScorer.scoreOnVote, idempotent: a
        // replayed vote credits nothing twice). Not a retraction, not one
        // still pending. A lost one is credited at the rule's next pass.
        if (reply.status === 200 && reply.body?.ok && !reply.body.toggled) await challengeScorer.scoreOnVote(pool, config);
        return res.status(reply.status).json(reply.body);
      }

      if (issue.status !== 'open') {
        return res.status(409).json({ error: 'Issue is not open' });
      }

      // Toggle off when re-voting the same direction.
      const { rows: existing } = await pool.query(
        'SELECT vote FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
        [issue.id, req.user.id]
      );

      if (existing.length && existing[0].vote === vote) {
        await pool.query(
          'DELETE FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
          [issue.id, req.user.id]
        );
        pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, toggled: true });
        return res.json({ ok: true, toggled: true });
      }

      // A flip REPLACES the line rather than keeping it: the old sentence
      // argued for the side this vote just left. (votes.js keeps an earlier
      // line on a same-side re-cast; here that click is the toggle above.)
      const { rows: recordedVotes = [] } = await pool.query(
        `INSERT INTO issue_votes (issue_id, user_id, vote, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (issue_id, user_id) DO UPDATE
           SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, created_at = NOW()
         RETURNING id`,
        [issue.id, req.user.id, vote, reason]
      );

      // issue_votes is a current-state row: a flip moves its timestamp and a
      // same-side click deletes it. Also send each real cast to the best-effort
      // append-only action log, so a successfully captured day survives that.
      events.record(pool, {
        type: events.EVENT_TYPES.ISSUE_VOTE_CAST,
        userId: req.user.id,
        appId: issue.app_id,
        metadata: { vote, issueId: issue.id, issueVoteId: recordedVotes[0]?.id || null },
      });

      const voteSubject = `issue: "${issue.title}"`;
      // #2603: with a line, the row is the person's sentence as well as their
      // tally — the same shape votes.js gives a proposal vote's thread line.
      await sendSystemMessage(pool, issue.app_id,
        reason
          ? `${req.user.username} voted ${vote} on ${voteSubject}: “${reason}”`
          : `${req.user.username} voted ${vote} on ${voteSubject}`,
        'vote',
        null,
        // #194: per-vote activity lands in the proposal's own thread
        // (the governance card on the Proposals tab), not general chat.
        { type: 'governance', ref: issue.id }
      );

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, vote });

      // "Vote on a change" counts a vote on a request too, now rather than
      // on the rule's next pass (#3569; challengeScorer.scoreOnVote). After
      // the broadcast, so other people's tallies are not held behind it. The
      // retraction above is not a vote cast and returned before this. Never
      // throws.
      await challengeScorer.scoreOnVote(pool, config);

      res.json({ ok: true });
    } catch (err) {
      log.error('issues', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues
  //
  // Lists the repo's OPEN GitHub issues (via github.fetchPublicIssues —
  // anonymous, cached, never-throws) for the "Open Issues" activity-panel
  // section. Augments each issue with this app's OPEN-bounty count and a
  // per-viewer `my_bounty` flag, the issue's creating user
  // (`created_by_username`, #133), the latest live headless auto session
  // (`headless`, #155 — including the viewer's own derived session as
  // `headless.mySessionId`, #172), plus the viewer's remaining weekly kudos
  // allowance so the FE can disable the "Give kudos" button when the shared
  // budget is spent. Distinct from the platform-internal `issues` table
  // (governance proposals) listed by GET /api/apps/:slug/issues above.
  //
  // #192: `?refresh=1` forces a refetch past the server-side cache TTL
  // (throttled per repo inside github.refreshPublicIssues — within the
  // cooldown it serves the cache). Refresh responses additionally carry
  // `refreshed` and `refreshRetryMs` so the FE can disable its button for
  // the cooldown window; the normal payload shape is unchanged.
  // ----------------------------------------------------------------
  // #2089: the board search reads past the title. Titles, authors, numbers
  // and the bodies the board payload already carries filter in the browser;
  // the discussion under a card does not travel with it (a thread loads when
  // its card opens), so this answers "which threads on this app mention the
  // query" and the browser folds the keys in. One thread type per card
  // family, mirroring the thread_type / thread_ref pairs chat.js writes:
  //   issue      -> GitHub issue number   (issue cards)
  //   session    -> chat_sessions.id      (proposal, merged and session cards)
  //   governance -> issues.id             (governance cards)
  // Human messages only (msg_type = 'message'), so a vote or lifecycle row
  // quoting the query does not surface a card. View-gated like the board.
  router.get('/api/apps/:slug/board-search', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const q = String(req.query.q || '').trim().slice(0, 200);
      const out = { q, issues: [], sessions: [], gov: [] };
      if (q.length < BOARD_SEARCH_MIN_CHARS) return res.json(out);
      // A substring match: the query is data, so its LIKE metacharacters
      // are escaped rather than interpreted.
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const { rows } = await pool.query(
        `SELECT thread_type, thread_ref
           FROM chat_messages
          WHERE app_id = $1
            AND msg_type = 'message'
            AND thread_type IN ('issue', 'session', 'governance')
            AND thread_ref IS NOT NULL
            AND content ILIKE $2 ESCAPE '\\'
          GROUP BY thread_type, thread_ref
          ORDER BY MAX(created_at) DESC
          LIMIT $3`,
        [app.id, pattern, BOARD_SEARCH_MAX_HITS]
      );
      for (const r of rows) {
        const ref = r.thread_ref == null ? NaN : Number(r.thread_ref);
        if (!Number.isInteger(ref) || ref <= 0) continue;
        if (r.thread_type === 'issue') out.issues.push(ref);
        else if (r.thread_type === 'session') out.sessions.push(ref);
        else out.gov.push(ref);
      }
      return res.json(out);
    } catch (err) {
      log.error('issues', 'Failed to search the board', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/github-issues', async (req, res) => {
    try {
      // View-level (#621): the GitHub issue list is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      const wantRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      let result;
      if (!requestsOn() || !parsed) {
        if (!IS_STAGING) {
          return res.json({ issues: [], truncatedList: false, note: 'unavailable' });
        }
        // Staging: serve mocks so the Dev card list is reviewable even
        // when GitHub isn't reachable from the preview container.
        result = { issues: stagingMockIssues(app.repo_url), truncatedList: false };
      } else {
        // Neither fetcher ever throws or returns null; on any failure mode
        // they return { issues:[], truncatedList:false, note }.
        result = wantRefresh
          ? await github.refreshPublicIssues(parsed.owner, parsed.repo)
          : await github.fetchPublicIssues(parsed.owner, parsed.repo);
        // Staging-only fallback: an empty (or degraded) live list would
        // render an empty Topics feed in the preview — substitute mocks.
        if (IS_STAGING && (!Array.isArray(result.issues) || result.issues.length === 0)) {
          result = {
            ...result,
            issues: stagingMockIssues(app.repo_url),
            truncatedList: false,
            note: undefined,
          };
        }
      }

      // Staging-only demo mode: with ?demo=1 the mocks are appended even
      // when the live list has rows, so layout work (e.g. long-title
      // wrapping) is verifiable against a prod-cloned DB. The FE forwards
      // the page's own ?demo=1 here (see _demoQS in app-view.js). The
      // number check keeps this idempotent against the empty-list
      // fallback above having already served the same mocks. Strictly a
      // no-op in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set((result.issues || []).map((i) => i.number));
        result = {
          ...result,
          issues: [
            ...(result.issues || []),
            ...stagingMockIssues(app.repo_url).filter((m) => !have.has(m.number)),
          ],
        };
      }

      // Open-bounty tallies for this app, keyed by issue number, in one
      // round-trip. BOOL_OR gives the viewer's own-open-bounty flag.
      const { rows: bountyRows } = await pool.query(
        `SELECT github_issue_number AS n,
                COUNT(*)::int AS cnt,
                BOOL_OR(giver_user_id = $2) AS mine
           FROM issue_bounties
          WHERE app_id = $1 AND status = 'open'
          GROUP BY github_issue_number`,
        [app.id, req.user.id]
      );
      const byNumber = new Map(bountyRows.map((r) => [r.n, r]));

      // #133/#136/#2427: resolve each issue's creating user so the panel can show
      // it next to the title the way PR rows show their author. Platform-
      // filed issues record created_by in the local issues table; feedback-
      // filed ones use feedback_reports, with the body's "**Source:**" line
      // as the compatibility fallback for older rows (the "usernode user
      // (name)" / "usernode admin (name)" forms, plus the legacy bare
      // "usernode admin" written before #140);
      // issues opened directly on GitHub fall back to the GitHub login —
      // but never the platform bot account itself, which would just name
      // "usernode-bot" on every platform-filed row.
      const { rows: creatorRows } = await pool.query(
        `SELECT DISTINCT ON (n) n, username
           FROM (
             SELECT i.github_issue_number AS n, u.username, 0 AS source_rank
               FROM issues i JOIN users u ON u.id = i.created_by
              WHERE i.app_id = $1 AND i.github_issue_number IS NOT NULL
             UNION ALL
             SELECT fr.issue_number AS n, u.username, 1 AS source_rank
               FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
              WHERE fr.issue_owner = $2 AND fr.issue_repo = $3
                AND fr.issue_number IS NOT NULL
           ) creators
          ORDER BY n, source_rank`,
        [app.id, parsed?.owner || null, parsed?.repo || null]
      );
      const creatorByNumber = new Map(creatorRows.map((r) => [r.n, r.username]));

      // #194: per-issue thread message counts (and the latest message
      // timestamp, for the forum feed's activity sort) in one grouped
      // query. Keyed by GitHub issue number (thread_ref for
      // thread_type='issue'). The badge count covers human messages only
      // (msg_type='message') so dual-posted lifecycle system rows don't
      // inflate it; last_at stays over all rows so system activity still
      // freshens the feed sort. 1 Nov 2026 (one page per thread): a
      // request that leads its thread counts its changes' replies too,
      // since its page is where they are read now.
      const { rows: chatRows } = await pool.query(
        `SELECT thread_ref AS n, (COUNT(*) FILTER (WHERE msg_type = 'message'))::int AS cnt,
                MAX(created_at) AS last_at
           FROM (SELECT thread_ref, msg_type, created_at
                   FROM chat_messages
                  WHERE app_id = $1 AND thread_type = 'issue'
                 UNION ALL
                 SELECT t.number, m.msg_type, m.created_at
                   FROM chat_messages m
                   JOIN chat_sessions s ON s.id = m.thread_ref AND s.thread_id = m.thread_id
                   JOIN threads t ON t.id = m.thread_id AND t.number IS NOT NULL
                  WHERE m.app_id = $1 AND m.thread_type = 'session' AND s.is_headless = FALSE
                    AND ${threadsService.visibleChangeSql('s', '$2')}
                    AND EXISTS (SELECT 1 FROM requests r WHERE r.thread_id = t.id AND r.number = t.number)) said
          GROUP BY thread_ref`,
        [app.id, req.user.id]
      );
      const chatByNumber = new Map(chatRows.map((r) => [r.n, r]));

      // #155: latest live headless auto session per issue, so the panel can
      // render the right button state (Generate proposal / Generating… / the
      // outcome-specific "Review … & start session" clone button). 'failed'
      // rows are excluded — the button recovers to Generate proposal so the
      // run can be retried.
      // staging_url/pr_number ride along (#183) so the panel can render the
      // changes-ready label + Preview button for auto runs that pushed code
      // and built a preview. staging_url is nulled on teardown, so a GC'd
      // preview degrades the label back to the plain outcome wording.
      // #2684: a synthetic user's sessions (the Homeroom bot's shadow-mode
      // triage turns) are never work on an issue that a card should show,
      // here or in the in_progress derivation below.
      const { rows: headlessRows } = await pool.query(
        `SELECT DISTINCT ON (cs.headless_issue_number)
                cs.headless_issue_number AS n, cs.id, cs.headless_status,
                cs.headless_outcome, cs.staging_url, cs.pr_number, u.username,
                cs.user_id
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.is_headless = TRUE
            AND cs.headless_status IN ('generating', 'ready')
            AND u.is_synthetic IS NOT TRUE
          ORDER BY cs.headless_issue_number, cs.created_at DESC`,
        [app.id]
      );
      // #172: the viewer's own most recent non-archived clone of each
      // listed headless session, so the FE can swap the clone button for
      // "Go to session" once they've already started one. Strictly
      // per-viewer — sessions are owner-scoped, so another user's clone
      // isn't navigable and must not hide the clone button. 'archived'
      // clones are excluded (one-way abandoned state) so the user can
      // start over. No dedicated index: the lookup filters by user_id +
      // cloned_from_session_id over a handful of ids, fine at current
      // volumes.
      const headlessIds = headlessRows.map((r) => r.id);
      const myCloneByHeadlessId = new Map();
      if (headlessIds.length) {
        const { rows: cloneRows } = await pool.query(
          `SELECT DISTINCT ON (cloned_from_session_id)
                  cloned_from_session_id AS src, id
             FROM chat_sessions
            WHERE user_id = $1 AND cloned_from_session_id = ANY($2)
              AND status <> 'archived'
            ORDER BY cloned_from_session_id, created_at DESC`,
          [req.user.id, headlessIds]
        );
        for (const r of cloneRows) myCloneByHeadlessId.set(r.src, r.id);
      }

      const headlessByNumber = new Map(headlessRows.map((r) => [r.n, {
        sessionId: r.id,
        status: r.headless_status,
        outcome: r.headless_outcome,
        username: r.username,
        // #1372: whether the VIEWER started this run. `username` cannot
        // stand in for it — comparing display names client-side is not an
        // authorization answer, and the client needs a real one here: the
        // question-outcome button navigates into the run's own session,
        // which /api/sessions/:id serves only to its owner.
        mine: r.user_id === req.user.id,
        mySessionId: myCloneByHeadlessId.get(r.id) || null,
        stagingUrl: r.staging_url || null,
        prNumber: r.pr_number || null,
      }]));

      // #287: the viewer's own most recent non-archived dev chat started
      // from each issue's start-work button (created_from_issue_number),
      // so the row can swap "Create proposal" → "Create new proposal".
      // Strictly per-viewer (sessions are owner-scoped — another user's
      // session must not flip the label) and 'archived' rows are excluded
      // so the button reverts to "Create proposal" after the viewer
      // abandons their session. Independent of the headless lookup above.
      // A person's posted plan (request-specs.js) is not work: it has no
      // branch, so it never counts as the viewer's own session here — the
      // same rule as issue-proposal-ref.js (1 Nov 2026, #6385).
      const { rows: prSessionRows } = await pool.query(
        `SELECT DISTINCT ON (created_from_issue_number)
                created_from_issue_number AS n, id
           FROM chat_sessions
          WHERE app_id = $1 AND user_id = $2
            AND created_from_issue_number IS NOT NULL
            AND status <> 'archived'
            AND NOT ${planRecordSql('')}
          ORDER BY created_from_issue_number, created_at DESC`,
        [app.id, req.user.id]
      );
      const myPrSessionByNumber = new Map(prSessionRows.map((r) => [r.n, r.id]));

      // "In progress" derivation — the dispatch-driven half. Every LIVE
      // non-headless session that declared linked_issues (via the Mayor's
      // addresses_issues at dispatch time) marks its issues in progress.
      // Live = active/promoted/merging always; paused only within the
      // IN_PROGRESS_PAUSED_WINDOW_DAYS activity window (rejection,
      // withdrawal, and stale-PR takedown all land in 'archived' and merge
      // in 'merged', so those exclude themselves). Headless runs are
      // deliberately NOT part of this field — they already ship as
      // issue.headless above, and the FE ORs the two (keeps the 8s
      // headless poller's field-scoped merge correct). A person's posted
      // plan (request-specs.js) is not work: a planning record with no
      // branch never counts, the same rule as issue-proposal-ref.js
      // (1 Nov 2026, #6385).
      const { rows: inProgressRows } = await pool.query(
        `SELECT UNNEST(cs.linked_issues) AS n,
                cs.id, cs.user_id, cs.status, cs.shared_at,
                cs.last_activity_at, cs.created_at, u.username,
                ${workedOnSql()} AS worked_on
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.is_headless = FALSE
            AND cardinality(cs.linked_issues) > 0
            AND u.is_synthetic IS NOT TRUE
            AND NOT ${planRecordSql('cs')}
            AND (cs.status IN ('active','promoted','merging')
                 OR (cs.status = 'paused'
                     AND cs.last_activity_at > NOW() - make_interval(days => $2)))`,
        [app.id, IN_PROGRESS_PAUSED_WINDOW_DAYS]
      );
      const inProgressByNumber = new Map();
      for (const r of inProgressRows) {
        const list = inProgressByNumber.get(r.n) || [];
        list.push(r);
        inProgressByNumber.set(r.n, list);
      }

      // Manual claims — the hand-set half. Expiry is a read-time filter:
      // a claim is live while GREATEST(claimed_at, the issue thread's
      // last activity) is within ISSUE_CLAIM_TTL_DAYS. Thread activity is
      // already in chatByNumber (last_at over ALL rows), so liveness and
      // expiresAt are computed here at zero extra query cost.
      const { rows: claimRows } = await pool.query(
        `SELECT ic.github_issue_number AS n, ic.user_id, ic.claimed_at, u.username
           FROM issue_claims ic JOIN users u ON u.id = ic.user_id
          WHERE ic.app_id = $1
          ORDER BY ic.claimed_at ASC`,
        [app.id]
      );
      const claimsByNumber = new Map();
      const claimNow = Date.now();
      for (const c of claimRows) {
        const lastAt = chatByNumber.get(c.n)?.last_at;
        if (!claimIsLive(c.claimed_at, lastAt, claimNow)) continue; // expired — inert row
        const list = claimsByNumber.get(c.n) || [];
        list.push({ ...c, expires_at: claimExpiresAt(c.claimed_at, lastAt).toISOString() });
        claimsByNumber.set(c.n, list);
      }

      // #2431: the proposal addressing each issue, resolved for every listed
      // number in ONE query — the topic page of an OPEN issue renders from
      // this payload, so the reference has to travel with the list.
      const addressedBy = await resolveIssueProposalRefs(
        pool, app.id, (result.issues || []).map((i) => i.number), req.user.id
      );
      const botByNumber = await botWorkFor(pool, app.id);
      // 16 Oct 2026: where the bot's work on each request is
      // (homeroom-bot-track.js): an open request's page draws from this
      // list, so its track card travels with it, as `bot` does.
      const trackSvc = require('../services/homeroom-bot-track');
      const tracks = await trackSvc.tracksForRequests(pool, { appId: app.id, numbers: (result.issues || []).map((i) => i.number) });
      // B8: who each request the bot is on is being built for, and whether
      // the bot builds here for this viewer (the page's "Ask Homeroom bot to
      // build this").
      const botDm = require('../services/homeroom-bot-dm');
      // Papote #3: and of each track waiting on its requester, which names
      // them to everybody else (homeroom-bot-track.js forViewer).
      const waitingTracks = [...tracks].filter(([, track]) => track?.waitingOn === 'you').map(([n]) => n);
      const askers = await botDm.askersOf(pool, app.id, [...botByNumber.keys(), ...waitingTracks]);
      const botAsked = (n) => {
        const work = botByNumber.get(n);
        if (!work) return null;
        const asker = askers.get(n);
        return asker ? { ...work, askedBy: asker.username, mine: asker.userId === req.user.id } : work;
      };
      let botDoor = await botDm.botDoorFor(pool, app, req.user);
      // The staging demo never runs the bot; its door is drawn to be seen
      // when the page asks for it (?demo=1&bot=1).
      if (!botDoor && IS_STAGING && req.query.demo === '1' && req.query.bot === '1') {
        botDoor = { typicalMinutes: botDm.TYPICAL_BUILD_MINUTES, demo: true };
      }
      // #4530: the requests the bot is waiting on people about, for a viewer
      // it builds for: their card answers the bot instead of asking it again.
      const botWaiting = botDoor && !botDoor.demo
        ? await botDm.botWaitingByIssue(pool, app.id, (result.issues || []).filter((i) => !botByNumber.has(i.number)))
        : new Map();
      // 1 Nov 2026: the open requests the viewer's own private thread holds
      // the bot on (services/private-threads.js holdsFor): "Homeroom bot is
      // waiting for your plan." with Let the bot build it now.
      const planHolds = await require('../services/private-threads').holdsFor(pool, {
        appId: app.id, userId: req.user.id,
        numbers: (result.issues || []).filter((i) => i.state !== 'closed').map((i) => i.number),
      }).catch(() => new Map());

      const issues = (result.issues || []).map((issue) => {
        const b = byNumber.get(issue.number);
        const ghLogin = issue.user && !issue.user.endsWith('[bot]') && issue.user !== 'usernode-bot'
          ? issue.user
          : null;
        return {
          ...issue,
          bounty_count: b ? b.cnt : 0,
          my_bounty: b ? !!b.mine : false,
          created_by_username: creatorByNumber.get(issue.number)
            || creatorFromSourceLine(issue.body)
            || ghLogin,
          headless: headlessByNumber.get(issue.number) || null,
          // Dispatch/claim-derived "In progress" status (sessions + manual
          // claims; headless rides separately on `headless` above). The
          // `target` inside is per-viewer — see pickInProgressTarget.
          in_progress: composeInProgress(
            inProgressByNumber.get(issue.number),
            claimsByNumber.get(issue.number),
            req.user.id
          ),
          // The Homeroom bot reading or building this request right now
          // ({ what, since }), or null. Its own field, like `headless`: the
          // bot is never `in_progress`.
          bot: botAsked(issue.number),
          track: trackSvc.forViewer(tracks.get(issue.number) || null, askers.get(issue.number), req.user.id),
          // #4530: the bot's note there that nobody has answered yet
          // ({ kind: 'question' | 'person' | 'empty', messageId }), or null.
          botAwaits: botWaiting.get(issue.number) || null,
          botHold: planHolds.get(issue.number) || null,
          // #287: per-viewer proposal session id, or null. Drives the
          // "Create proposal" → "Create new proposal" swap on the issue row.
          myPrSessionId: myPrSessionByNumber.get(issue.number) || null,
          // #2431: the change addressing this issue, or null.
          addressed_by: addressedBy.get(issue.number) || null,
          chatCount: chatByNumber.get(issue.number)?.cnt || 0,
          lastMessageAt: chatByNumber.get(issue.number)?.last_at || null,
          // The Haiku title call failed when this feedback issue was
          // filed, so it carries the placeholder template. Drives the
          // "Auto-title pending" chip on the issue row; the title-heal
          // sweeper regenerates it (services/title-heal.js), after which
          // the refreshed title no longer matches and the chip drops.
          title_fallback: issue.title === FEEDBACK_FALLBACK_TITLE,
        };
      });

      // #227: the staging mocks have no chat_sessions rows, so the feed's
      // auto-solve-first ordering would be unreviewable in a preview.
      // Attach synthetic headless state to two [Mock] rows — 900003
      // 'generating' (30h old, naturally last by recency, so the re-rank
      // is unmistakable) and 900005 'ready'/spec — only where no real
      // headless row already claimed the number, so prod-cloned data is
      // never overridden. Request-time and read-only; strictly a no-op
      // in production.
      if (IS_STAGING) {
        const mockHeadless = new Map([
          [900003, { status: 'generating', outcome: null }],
          [900005, { status: 'ready', outcome: 'spec' }],
          // #1112: the `question` outcome — a finished run that is waiting on
          // a human answer, which the work-state chip reports as amber
          // "Needs an answer" rather than as work in flight.
          [900015, { status: 'ready', outcome: 'question' }],
          // #1112: dedicated row for the finished-draft state. Unlike the
          // older 900005 ranking fixture, this number is not also used by a
          // persisted staging headless seed.
          [900016, { status: 'ready', outcome: 'spec' }],
        ]);
        for (const issue of issues) {
          const m = mockHeadless.get(issue.number);
          if (m && !issue.headless) {
            issue.headless = {
              sessionId: issue.number,
              status: m.status,
              outcome: m.outcome,
              username: 'staging-tester',
              // No chat_sessions row backs these numbers, so the run-session
              // navigation has nothing to open — the mock exercises the
              // not-my-run path on purpose.
              mine: false,
              mySessionId: null,
              stagingUrl: null,
              prNumber: null,
            };
          }
        }
        // #287: the staging mocks have no chat_sessions rows, so the
        // "Create new proposal" variant of the start-work button would
        // never render in a preview. Attach a synthetic myPrSessionId to
        // the dedicated [Mock] row (900007, "issue with an in-progress
        // proposal") so the has-session button is reviewable — only where
        // no real session already claimed it. The id is synthetic (the
        // mock issue number); clicking "Create new proposal" still just
        // spawns a fresh dev chat, so this is purely for visual review of
        // the button label. Request-time, read-only, no-op in production.
        for (const issue of issues) {
          if (issue.number === 900007 && !issue.myPrSessionId) {
            issue.myPrSessionId = issue.number;
          }
        }
        // #556: the [Mock] rows resolve no platform creator, so the
        // author-only "edit title" pencil in the topic head would never
        // render in a preview. Mark the dedicated row (900008) as authored
        // by the viewer — only where no real creator resolved — so the
        // affordance is reviewable. Saving still fails (no real GitHub
        // issue behind the mock); purely visual. No-op in production.
        //
        // "No real creator resolved" has to include the mock's OWN author
        // sentinel: stagingMockIssues stamps every row `user:
        // 'staging-tester'`, and the enrichment above promotes that to
        // created_by_username as a GitHub login — so the `!created_by_username`
        // guard never fired and the pencil never rendered. Only the sentinel
        // is treated as unresolved; a genuinely prod-cloned row that happens
        // to be numbered 900008 keeps its real author.
        for (const issue of issues) {
          if (issue.number === 900008
            && (!issue.created_by_username || issue.created_by_username === 'staging-tester')) {
            issue.created_by_username = req.user.username;
          }
        }
        // #964: `issue_bounties` is staging:private, so it arrives
        // schema-only and EVERY row in a preview shows a bounty count of 0 —
        // the ★ pill and the "★ Bountied" button state would be unreviewable,
        // and the Send Feedback dialog's new create-with-bounty checkbox
        // couldn't be seen to have done anything (staging also has no
        // GitHub credential, so no issue is really filed there). Attach
        // synthetic bounty state to two dedicated [Mock] rows — only where no
        // real row already claimed the number, so prod-cloned data is never
        // overridden. Request-time, read-only, no-op in production.
        const mockBounties = new Map([
          [900002, { bounty_count: 2, my_bounty: false }],
          [900004, { bounty_count: 1, my_bounty: true }],
        ]);
        for (const issue of issues) {
          const b = mockBounties.get(issue.number);
          if (b && !issue.bounty_count) {
            issue.bounty_count = b.bounty_count;
            issue.my_bounty = b.my_bounty;
          }
        }
        // "In progress" chip states on dedicated [Mock] rows, so every
        // variant is reviewable in a preview — only where no real data
        // claimed the number. 900001/900002/900009 are deliberately left
        // untouched: they anchor the kanban drag-order (#613) and
        // newest-on-top (#617) demos, and an in-progress mark would move
        // them out of the Issues column. Request-time, read-only, no-op
        // in production.
        const hoursAgoIso = (hrs) => new Date(Date.now() - hrs * 3600 * 1000).toISOString();
        const hoursAheadIso = (hrs) => new Date(Date.now() + hrs * 3600 * 1000).toISOString();
        const mkMockClaim = (username, mine, hrs) => ({
          username, userId: mine ? req.user.id : 0, mine,
          claimedAt: hoursAgoIso(hrs), expiresAt: hoursAheadIso(7 * 24 - hrs),
        });
        const mkMockSession = (sessionId, username, status, hrs, busy) => ({
          sessionId, username, mine: false, status, busy: !!busy,
          lastActivityAt: hoursAgoIso(hrs),
        });
        const mockInProgress = new Map([
          // #1112 `in_review`: the session was promoted, so the work is
          // waiting on reviewers rather than on an agent. CLICKABLE styling
          // (synthetic proposal target — clicking lands on the topic view's
          // not-found fallback, same visual-review-only caveat as the
          // synthetic myPrSessionId above).
          [900007, {
            count: 1, users: ['staging-tester'], peopleTotal: 1, mine: false, claims: [],
            sessions: [mkMockSession(900007, 'staging-tester', 'promoted', 4, false)],
            target: { kind: 'proposal', sessionId: 900007 },
          }],
          // #1112 `working` with a live turn: two active sessions, the
          // most-recent one busy, so the chip renders emerald with its
          // spinner and a "+1" for the second person. NON-clickable
          // (private-work) styling.
          [900006, {
            count: 2, users: ['maya-builder', 'staging-tester'], peopleTotal: 2, mine: false,
            claims: [],
            sessions: [
              mkMockSession(900106, 'maya-builder', 'active', 0.2, true),
              mkMockSession(900206, 'staging-tester', 'active', 3, false),
            ],
            target: null,
          }],
          // #1112 `claimed`, with the VIEWER among the claimers — reviews
          // the multi-claimer "+1" plus the "Release my claim" button state.
          [900004, {
            count: 0, users: [], peopleTotal: 2, mine: true, sessions: [],
            claims: [mkMockClaim(req.user.username, true, 2), mkMockClaim('maya-builder', false, 5)],
            target: null,
          }],
          // #1112 `claimed` by someone else — the viewer's button stays
          // "Claim this issue" and the admin per-claim clear is reviewable
          // in the topic view.
          [900008, {
            count: 0, users: [], peopleTotal: 1, mine: false, sessions: [],
            claims: [mkMockClaim('maya-builder', false, 8)],
            target: null,
          }],
          // #1112 `paused`: one session, paused, last touched 5 days ago —
          // two days short of the 7-day self-clear, which is exactly the
          // case the topic head's dated sentence exists to explain.
          [900014, {
            count: 1, users: ['maya-builder'], peopleTotal: 1, mine: false, claims: [],
            sessions: [mkMockSession(900114, 'maya-builder', 'paused', 5 * 24, false)],
            target: null,
          }],
        ]);
        for (const issue of issues) {
          const m = mockInProgress.get(issue.number);
          if (m && !issue.in_progress) issue.in_progress = m;
        }
        // The Homeroom bot building a request: 900018, which nothing else
        // marks, and only where no real bot work claimed the number.
        for (const issue of issues) {
          if (issue.number === 900018 && !issue.bot) issue.bot = stagingMockBotWork();
          // And its track, as its own page shows it (homeroom-bot-track.js).
          if (issue.number === 900018 && !issue.track) issue.track = trackSvc.demoRequestTrack(app, 900018, issue.title);
        }
        // #4530: and one it asked a question on that nobody has answered:
        // 900001, where its door is drawn (?demo=1&bot=1). Its card offers
        // to answer the bot instead of asking it again.
        if (botDoor && botDoor.demo) {
          for (const issue of issues) {
            if (issue.number === 900001 && !issue.bot && !issue.botAwaits) {
              issue.botAwaits = { kind: 'question', messageId: null };
            }
          }
        }
      }

      // Community-voted priority + assigned-person summary per issue (the
      // chip top value + count + the viewer's pick), keyed by GitHub issue
      // number — mirroring the bounty enrichment above. The dropdown's full
      // tally lazy-loads from /api/apps/:slug/topics/issue/:n/attributes.
      const attrByNumber = await topicAttrs.summarizeForTargets(
        pool, app.id, 'issue', issues.map((i) => i.number), req.user.id
      );
      for (const issue of issues) {
        const s = attrByNumber.get(issue.number) || topicAttrs.emptySummary();
        issue.priority = s.priority;
        issue.assignee = s.assignee;
        issue.category = s.category;
      }
      // Staging: the [Mock] rows have no topic_attribute_votes, so seed a
      // synthetic summary onto a few so the chips' states are reviewable in
      // a preview — a clear leader, a tie, and an untouched (placeholder)
      // row. Only where the real query found nothing. No-op in production.
      if (IS_STAGING) {
        // #600: so both assignee-dropdown states are reviewable, 900001's
        // assignee is seeded to the VIEWING user (myValue = their own
        // username) — opening its dropdown shows the viewer's name already
        // checked and the name box empty (no pre-fill, since they've voted).
        // 900002 stays untouched (Unassigned) so opening ITS dropdown shows
        // the name box PRE-FILLED with the viewer's username.
        const viewer = (req.user && req.user.username) || 'staging-tester';
        const mockAttrs = new Map([
          // Clear leader on all fields; the viewer is their own assignee.
          [900001, {
            priority: { top: 'high', count: 3, myValue: null },
            assignee: { top: viewer, count: 2, myValue: viewer },
            // #504: a clear category leader (count 3) so the chip + colour
            // and the category filter dropdown are reviewable.
            category: { top: 'bug', count: 3, myValue: null },
          }],
          // A tie (count 1 vs 1) — the earlier-suggested value wins the chip.
          [900003, {
            priority: { top: 'low', count: 1, myValue: null },
            assignee: { top: 'staging-demo-user', count: 1, myValue: null },
            category: { top: 'docs', count: 1, myValue: null },
          }],
          // #489: a third assignee whose first letter (M) differs from the
          // others (S), so the deterministic initial-avatar colouring is
          // reviewable across several visibly-distinct avatars on the board.
          [900006, {
            priority: { top: 'medium', count: 2, myValue: null },
            assignee: { top: 'maya-builder', count: 3, myValue: null },
            // A second, distinct category leader so the filter has choices.
            category: { top: 'feature', count: 2, myValue: null },
          }],
          // #780: a CUSTOM category leader, matching one of the two demo
          // entries listCategories() appends in staging — so the custom chip
          // colour, and narrowing the board by a custom category in the
          // filter bar, are both reviewable in a preview.
          [900007, {
            priority: { top: 'high', count: 1, myValue: null },
            assignee: { top: 'staging-demo-user', count: 1, myValue: null },
            category: { top: 'staging-demo-perf', count: 2, myValue: null },
          }],
          // 900002 deliberately left untouched → muted "Set priority" /
          // "Unassigned" / "Set category"; opening its assignee dropdown
          // pre-fills the viewer's own username.
        ]);
        for (const issue of issues) {
          const m = mockAttrs.get(issue.number);
          if (m && (!issue.priority || !issue.priority.top) && (!issue.assignee || !issue.assignee.top)) {
            issue.priority = m.priority;
            issue.assignee = m.assignee;
            issue.category = m.category;
          }
        }
      }

      // #1688: what the board shows beside the bounty button is the BOUNTY
      // allowance, which has its own count now (services/bounties.js).
      const used = await countWeeklyBountiesUsed(pool, req.user.id, weekStartUtc());
      const myRemaining = Math.max(0, WEEKLY_BOUNTY_LIMIT - used);

      res.json({
        issues,
        truncatedList: !!result.truncatedList,
        ...(result.note ? { note: result.note } : {}),
        // #2261: the list is the last one GitHub gave, not a fresh read —
        // the board keeps what it has rather than repainting on it.
        ...(result.stale ? { stale: true } : {}),
        ...(wantRefresh
          ? { refreshed: !!result.refreshed, refreshRetryMs: result.retryInMs || 0 }
          : {}),
        myRemaining,
        limit: WEEKLY_BOUNTY_LIMIT,
        ...(botDoor ? { homeroomBot: botDoor } : {}),
      });
    } catch (err) {
      log.error('issues', 'Failed to list GitHub issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues/:number
  //
  // #2365: ONE GitHub issue, open or CLOSED, for the topic view. The list
  // route above carries open issues only, so a proposal's link to the issue
  // it closed opened a page that could not find it and silently bounced to
  // the board. github.fetchPublicIssue is cache-first, never throws, resolves
  // closed issues through the single-issue endpoint and refuses pull
  // requests — anything it cannot return is a 404 here. View-gated like the
  // list. Returns `{ issue }` in the list's row shape: creator, bounty tally,
  // discussion count and attributes are resolved the same way; the
  // per-viewer work fields (headless run, in-progress, own session) are left
  // empty, because a closed issue's page offers no work on it. `addressed_by`
  // (#2431) is the exception the closed page needs most: the change that
  // closed it is a record, not an offer of work. `bot` is the other: on an
  // open issue it says the Homeroom bot is building it, which is what keeps
  // the page from offering a claim the bot would then step back for.
  // ----------------------------------------------------------------
  // 16 Oct 2026: the Homeroom bot's slots on a project, for the page under
  // its Workshop (homeroom-bot-track.js slotsView): what holds each slot,
  // the requests waiting for one in order, the ones on hold, and the
  // viewer's own building time. Reading it is read-only, so view-level.
  router.get('/api/apps/:slug/homeroom-bot/slots', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, name, repo_url`);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const trackSvc = require('../services/homeroom-bot-track');
      // The demo's rows are staging's own mock requests, so a tap opens one.
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ slots: trackSvc.demoSlots(app, Date.now(), stagingMockIssues(app.repo_url)) });
      }
      return res.json({ slots: await trackSvc.slotsView(pool, { app, user: req.user }) });
    } catch (err) {
      log.error('issues', 'Failed to read the bot\'s slots', { message: err.message, slug: req.params.slug });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/github-issues/:number', async (req, res) => {
    try {
      // View-level (#621): reading an issue is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const number = /^\d+$/.test(req.params.number) ? Number(req.params.number) : NaN;
      if (!Number.isSafeInteger(number) || number <= 0) {
        return res.status(400).json({ error: 'Invalid issue number' });
      }
      const parsed = parseOwnerRepo(app.repo_url);

      // Staging: the list route's mock rows resolve here too, so a mock
      // issue's page opened by URL behaves like one opened from the board.
      // With ?demo=1 the mock is served without the live round trip, for the
      // reason the comments route below gives; without it the live fetch
      // goes first and the mock is only the fallback. No-op in production.
      const mock = IS_STAGING
        ? stagingMockIssues(app.repo_url).find((i) => i.number === number)
          || stagingMockClosedIssues(app.repo_url).find((i) => i.number === number) || null
        : null;
      let issue = null;
      if (mock && req.query.demo === '1') {
        issue = mock;
      } else if (requestsOn() && parsed) {
        ({ issue } = await github.fetchPublicIssue(parsed.owner, parsed.repo, number));
      }
      if (!issue) issue = mock;
      if (!issue) return res.status(404).json({ error: 'Issue not found' });

      const { rows: bountyRows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt, BOOL_OR(giver_user_id = $3) AS mine
           FROM issue_bounties
          WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
        [app.id, number, req.user.id]
      );
      const { rows: creatorRows } = await pool.query(
        `SELECT username
           FROM (
             SELECT u.username, 0 AS source_rank, i.id AS source_id
               FROM issues i JOIN users u ON u.id = i.created_by
              WHERE i.app_id = $1 AND i.github_issue_number = $2
             UNION ALL
             SELECT u.username, 1 AS source_rank, fr.id AS source_id
               FROM feedback_reports fr JOIN users u ON u.id = fr.user_id
              WHERE fr.issue_owner = $3 AND fr.issue_repo = $4 AND fr.issue_number = $2
           ) creators
          ORDER BY source_rank, source_id DESC
          LIMIT 1`,
        [app.id, number, parsed?.owner || null, parsed?.repo || null]
      );
      // 1 Nov 2026: with its changes' replies, as the board's count (above).
      const { rows: chatRows } = await pool.query(
        `SELECT (COUNT(*) FILTER (WHERE msg_type = 'message'))::int AS cnt,
                MAX(created_at) AS last_at
           FROM (SELECT msg_type, created_at FROM chat_messages
                  WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2
                 UNION ALL
                 SELECT m.msg_type, m.created_at
                   FROM chat_messages m
                   JOIN chat_sessions s ON s.id = m.thread_ref AND s.thread_id = m.thread_id
                   JOIN threads t ON t.id = m.thread_id AND t.number = $2
                  WHERE m.app_id = $1 AND m.thread_type = 'session' AND s.is_headless = FALSE
                    AND ${threadsService.visibleChangeSql('s', '$3')}
                    AND EXISTS (SELECT 1 FROM requests r WHERE r.thread_id = t.id AND r.number = t.number)) said`,
        [app.id, number, req.user.id]
      );
      const b = bountyRows[0];
      const chat = chatRows[0];
      const ghLogin = issue.user && !issue.user.endsWith('[bot]') && issue.user !== 'usernode-bot'
        ? issue.user
        : null;
      const attrs = (await topicAttrs.summarizeForTargets(
        pool, app.id, 'issue', [number], req.user.id
      )).get(number) || topicAttrs.emptySummary();
      // #2431: for a CLOSED issue this is the whole answer to "what closed
      // this?" — the merged change that linked it. Same resolver the list
      // uses, so both pages name the same proposal.
      const addressedBy = await resolveIssueProposalRefs(
        pool, app.id, [number], req.user.id
      );
      // The Homeroom bot's work, as the list carries it, for an OPEN issue:
      // a request it is building is not one to claim, opened from wherever.
      // A closed issue has nothing being built on it.
      let bot = null;
      if (issue.state !== 'closed') {
        bot = (await botWorkFor(pool, app.id)).get(number) || null;
        // B8: and who it is being built for, as the list says.
        if (bot) {
          const asker = (await require('../services/homeroom-bot-dm').askersOf(pool, app.id, [number])).get(number);
          if (asker) bot = { ...bot, askedBy: asker.username, mine: asker.userId === req.user.id };
        }
        if (!bot && mock && number === 900018) bot = stagingMockBotWork();
      }
      // 16 Oct 2026: where the bot's work on it is, as every surface draws
      // it (homeroom-bot-track.js): the request page's track card. Open or
      // closed, since a closed request's track says who shipped it.
      const trackSvc = require('../services/homeroom-bot-track');
      let track = (await trackSvc.tracksForRequests(pool, { appId: app.id, numbers: [number] })).get(number) || null;
      if (!track && mock && number === 900018) track = trackSvc.demoRequestTrack(app, number, issue.title);
      // Papote #3: a track waiting on its requester names them to anybody else.
      if (track?.waitingOn === 'you') {
        const asker = (await require('../services/homeroom-bot-dm').askersOf(pool, app.id, [number])).get(number);
        track = trackSvc.forViewer(track, asker, req.user.id);
      }
      // #4530: and its unanswered note there, as the list says it.
      const botAwaits = issue.state !== 'closed' && !bot && issue !== mock
        ? (await require('../services/homeroom-bot-dm').botWaitingByIssue(pool, app.id, [issue])).get(number) || null
        : null;
      // 1 Nov 2026: and whether the viewer's own private thread about it
      // holds the bot, as the list says it.
      const botHold = issue.state !== 'closed' && req.user?.id
        ? (await require('../services/private-threads').holdsFor(pool, { appId: app.id, userId: req.user.id, numbers: [number] })
          .catch(() => new Map())).get(number) || null
        : null;
      // #4244: a closed issue no merged change closed was closed by a
      // close_issue vote, or an admin forcing one through. The applied row's
      // audit payload says which, so the page's status band can too.
      let closedVia = null;
      if (issue.state === 'closed') {
        const { rows: closeRows } = await pool.query(
          `SELECT payload->>'appliedBy' AS applied_by
             FROM issues
            WHERE app_id = $1 AND kind = 'close_issue' AND status = 'closed'
              AND payload->>'issueNumber' = $2::text
              AND payload ? 'appliedAt'
            ORDER BY id DESC
            LIMIT 1`,
          [app.id, number]
        );
        const by = closeRows[0] && String(closeRows[0].applied_by || '');
        if (by && !by.startsWith('refused')) closedVia = by.startsWith('admin') ? 'admin' : 'vote';
        if (!closedVia && issue === mock && mock.mockClosedVia) closedVia = mock.mockClosedVia;
      }
      const addressed = addressedBy.get(number)
        || (issue === mock && mock.mockAddressedBy) || null;
      const issueFields = { ...issue };
      delete issueFields.mockAddressedBy;
      delete issueFields.mockClosedVia;

      return res.json({
        issue: {
          state: 'open',
          closedAt: null,
          ...issueFields,
          bounty_count: b ? b.cnt : 0,
          my_bounty: b ? !!b.mine : false,
          created_by_username: (creatorRows[0] && creatorRows[0].username)
            || creatorFromSourceLine(issue.body)
            || ghLogin,
          headless: null,
          in_progress: null,
          bot,
          botAwaits,
          botHold,
          track,
          myPrSessionId: null,
          addressed_by: addressed,
          closed_via: closedVia,
          chatCount: (chat && chat.cnt) || 0,
          lastMessageAt: (chat && chat.last_at) || null,
          title_fallback: issue.title === FEEDBACK_FALLBACK_TITLE,
          priority: attrs.priority,
          assignee: attrs.assignee,
          category: attrs.category,
        },
      });
    } catch (err) {
      log.error('issues', 'Failed to fetch GitHub issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues/:number/comments
  //
  // #396: the GitHub comment thread for ONE issue, for the Dev topic
  // view's comment section. Lazy — fetched only when a viewer opens an
  // issue topic, never as part of the list payload, so the panel's
  // rate-limit cost is unchanged. Collab-gated like the list route above.
  // Returns `{ comments: [{ author, body, createdAt }], truncated, note? }`,
  // without the Homeroom bot's comments its thread already carries (#3693);
  // github.fetchIssueComments never throws (failures degrade to an empty
  // list with a note). In staging the thread is backed by mock comments
  // when the live fetch is empty/unavailable, so the section is reviewable.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues/:number/comments', async (req, res) => {
    try {
      // View-level (#621): comment history is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // The route keeps the newest 30 (`clipIssueComments`' default). A
      // request's first page, which draws them as its discussion, asks
      // readRequestComments for more (#6497).
      res.json(await readRequestComments(pool, app, parseInt(req.params.number, 10), {
        demo: req.query.demo === '1',
      }));
    } catch (err) {
      log.error('issues', 'Failed to fetch GitHub issue comments', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // PATCH /api/apps/:slug/github-issues/:number/title
  //
  // #556: author-only rename of an open GitHub issue from inside the app.
  // The GitHub issue is retitled FIRST (nothing local changes if that
  // fails), then best-effort follow-ups: the local `issues` mirror row
  // (platform-filed issues only), removal of any pending title_heal_queue
  // row (so the sweeper can't clobber the author's choice), a system
  // message in the issue's own discussion thread recording old → new, and
  // the cache-bust + issue_update broadcast that live-refreshes open
  // panels (same pair title-heal uses).
  //
  // Authorship: platform-filed issues record created_by in the local issues
  // table; feedback-filed ones record user_id in feedback_reports, with the
  // body's "**Source:**" line as a compatibility fallback. GitHub-native
  // issues match neither and stay read-only — author-only by design, no admin
  // override.
  // ----------------------------------------------------------------
  router.patch('/api/apps/:slug/github-issues/:number/title', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    const rawTitle = req.body?.title;
    const newTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!newTitle) return res.status(400).json({ error: 'Title required' });
    if (newTitle.length > MAX_ISSUE_TITLE_LENGTH) {
      return res.status(400).json({
        error: `Title too long (max ${MAX_ISSUE_TITLE_LENGTH} chars)`,
      });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo —
      // same policy as the bounty route: fetchPublicIssues never throws;
      // a degraded fetch (note) means no positive confirmation, so refuse
      // and change nothing. The snapshot also yields the old title + body.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!requestsOn() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the request right now: requests are unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
      if (!target) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const isAuthor = await isIssueAuthor(
        pool, app.id, parsed, issueNumber, req.user, target.body
      );
      if (!isAuthor) {
        return res.status(403).json({ error: "Only the issue's author can edit its title" });
      }

      const oldTitle = String(target.title || '');
      if (newTitle === oldTitle) {
        return res.json({ ok: true, unchanged: true, title: oldTitle });
      }

      // GitHub first — a failed PATCH must leave everything untouched.
      try {
        await github.patchIssueTitle(parsed.owner, parsed.repo, issueNumber, newTitle);
      } catch (err) {
        log.warn('issues', 'GitHub issue title PATCH failed', { issueNumber, message: err.message });
        return res.status(502).json({
          error: "Couldn't update the title on GitHub. Try again in a moment.",
        });
      }

      // Local mirror row (platform-filed issues only; no-op otherwise).
      await pool.query(
        `UPDATE issues SET title = $3 WHERE app_id = $1 AND github_issue_number = $2`,
        [app.id, issueNumber, newTitle]
      ).catch((err) => log.warn('issues', 'Local issue title update failed', { issueNumber, err: err.message }));

      // A pending auto-title heal must not overwrite the author's choice.
      await pool.query(
        `DELETE FROM title_heal_queue WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
        [parsed.owner, parsed.repo, issueNumber]
      ).catch((err) => log.warn('issues', 'title_heal_queue cleanup failed', { issueNumber, err: err.message }));

      // On-the-record rename note in the issue's own thread. Thread-only —
      // renames are issue-local housekeeping, unlike creation's dual-post.
      await sendSystemMessage(pool, app.id,
        `${req.user.username} changed the title from "${oldTitle}" to "${newTitle}"`,
        'system', null, { type: 'issue', ref: issueNumber }
      ).catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));

      pushIssueUpdate({
        action: 'updated', source: 'github',
        appSlug: app.slug, appId: app.id, issueNumber,
      });

      log.info('issues', 'Issue title edited', { appId: app.id, issueNumber, by: req.user.username });
      res.json({ ok: true, title: newTitle });
    } catch (err) {
      log.error('issues', 'Issue title edit failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // PATCH /api/apps/:slug/github-issues/:number/body
  //
  // #2427: author-only editing of an open GitHub issue's Markdown body from
  // its Homeroom topic. This deliberately mirrors the title route's access,
  // open-issue verification and authorship rules. GitHub remains the source
  // of truth: it is written first, then the optional local mirror, thread
  // audit note, cache and live viewers are updated best-effort.
  // ----------------------------------------------------------------
  router.patch('/api/apps/:slug/github-issues/:number/body', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    const rawBody = req.body?.body;
    if (typeof rawBody !== 'string') {
      return res.status(400).json({ error: 'Body must be a string' });
    }
    if (rawBody.length > MAX_ISSUE_BODY_LENGTH) {
      return res.status(400).json({
        error: `Body too long (max ${MAX_ISSUE_BODY_LENGTH} chars)`,
      });
    }
    const newBody = github.safeMention(rawBody);

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      if (!requestsOn() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the request right now: requests are unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
      if (!target) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const isAuthor = await isIssueAuthor(
        pool, app.id, parsed, issueNumber, req.user, target.body
      );
      if (!isAuthor) {
        return res.status(403).json({ error: "Only the issue's author can edit its body" });
      }

      const oldBody = String(target.body || '');
      if (newBody === oldBody) {
        return res.json({ ok: true, unchanged: true, body: oldBody });
      }

      try {
        await github.patchIssueBody(parsed.owner, parsed.repo, issueNumber, newBody);
      } catch (err) {
        log.warn('issues', 'GitHub issue body PATCH failed', { issueNumber, message: err.message });
        return res.status(502).json({
          error: "Couldn't update the body on GitHub. Try again in a moment.",
        });
      }

      await pool.query(
        `UPDATE issues SET description = $3 WHERE app_id = $1 AND github_issue_number = $2`,
        [app.id, issueNumber, newBody]
      ).catch((err) => log.warn('issues', 'Local issue body update failed', { issueNumber, err: err.message }));

      await sendSystemMessage(pool, app.id,
        `${req.user.username} edited the issue description`,
        'system', null, { type: 'issue', ref: issueNumber }
      ).catch((err) => log.warn('issues', 'Issue body chat message failed', { err: err.message }));

      pushIssueUpdate({
        action: 'updated', source: 'github',
        appSlug: app.slug, appId: app.id, issueNumber,
      });

      log.info('issues', 'Issue body edited', { appId: app.id, issueNumber, by: req.user.username });
      res.json({ ok: true, body: newBody });
    } catch (err) {
      log.error('issues', 'Issue body edit failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // POST /api/apps/:slug/issues/:number/bounty
  //
  // Place a "Give kudos" bounty on a GitHub issue. A bounty is a symbolic
  // off-chain pledge (no tokens) that debits the giver's SHARED weekly kudos
  // allowance (the same WEEKLY_KUDOS_LIMIT cap PR kudos uses, counted across
  // both ledgers). When a merged PR closes this issue, the open bounty is
  // awarded to that PR's author (src/workflow/rules/bounties.ts, in the
  // merge-followups machine's transaction).
  //
  // The same pledge can also be made at issue-CREATION time, from the Send
  // Feedback dialog's "Put a kudos bounty on this" checkbox — both surfaces
  // run services/bounties.js placeBounty, so the ledger row, the chat posts
  // and the WS broadcast are identical whichever one was used.
  //
  // Status codes:
  //   200 ok        — bounty recorded; body carries { remaining, limit }
  //   400 bad input — non-positive issue number
  //   404 not_found — app doesn't exist
  //   409 conflict  — viewer already has an open bounty on this issue
  //   429 too_many  — shared weekly kudos allowance exhausted
  //   410 gone      — kudos is parked (#5249)
  // ----------------------------------------------------------------
  router.post('/api/apps/:slug/issues/:number/bounty', sameOriginBrowserOnly, async (req, res) => {
    if (bountiesParked) return refuseParked(res);
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo BEFORE
      // spending quota, inserting a row, or posting chat noise. Otherwise a
      // user could bounty a closed/nonexistent issue and a later PR carrying
      // `Closes #N` would award that fake/stale bounty. fetchPublicIssues
      // never throws and surfaces degraded fetches via a `note`; if we can't
      // positively confirm the issue is open (closed, nonexistent, or GitHub
      // unavailable) we refuse and change nothing.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!requestsOn() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the request right now: requests are unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        // 'rate limited' / 'issues unavailable' / 'fetch failed' — no
        // positive confirmation the issue is open.
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const isOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!isOpen) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      // Ledger + side effects live in services/bounties.js, shared with the
      // Send Feedback dialog's create-with-bounty path (POST /api/feedback).
      // This route keeps what is ITS OWN: the collab gate and the
      // open-issue verification above, plus the status-code mapping below.
      const result = await placeBounty(pool, {
        app, user: req.user, issueNumber,
      });
      if (!result.ok) {
        const status = result.code === 'quota' ? 429 : 409;
        const body = { error: result.error };
        // The quota response has always carried the budget figures; the
        // duplicate one never did. Keep both shapes exactly as they were.
        if (result.code === 'quota') {
          body.remaining = result.remaining;
          body.limit = result.limit;
        }
        return res.status(status).json(body);
      }

      res.json({
        ok: true,
        bountyId: result.bountyId,
        bountyCount: result.bountyCount,
        remaining: result.remaining,
        limit: result.limit,
      });
    } catch (err) {
      log.error('issues', 'Bounty create failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // POST /api/apps/:slug/github-issues/:number/claim
  //
  // Manually mark a GitHub issue "In progress" for the calling user. An
  // issue can hold many concurrent claims — at most one per user — so
  // this is a plain upsert of the CALLER's own claim: first click
  // creates it, any later click renews it (fresh TTL clock), other
  // users' claims are untouched and irrelevant (no 409, ever). The
  // target must be a currently-open GitHub issue — same positive-
  // confirmation policy as the bounty route above. A successful claim also
  // moves the caller's assignee vote to their own username, so taking the
  // work and assigning it are one gesture. Both writes are platform-local:
  // no GitHub write. Expiry is a read-time filter in the /github-issues
  // enrichment (ISSUE_CLAIM_TTL_DAYS).
  // ----------------------------------------------------------------
  router.post('/api/apps/:slug/github-issues/:number/claim', sameOriginBrowserOnly, async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo —
      // fetchPublicIssues never throws; a degraded fetch (note) means no
      // positive confirmation, so refuse and change nothing.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!requestsOn() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the request right now: requests are unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const isOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!isOpen) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      // #2364: the upsert, the #1648 assignee vote, the thread note and the
      // push live in services/issue-claims.js, shared with the two routes
      // that start work on an issue.
      const { created, claimedAt } = await claimIssueForUser(pool, {
        app, issueNumber, user: req.user,
      });

      log.info('issues', created ? 'Issue claimed' : 'Issue claim renewed', {
        appId: app.id, issueNumber, by: req.user.username,
      });
      res.json({ ok: true, created, claimedAt });
    } catch (err) {
      log.error('issues', 'Issue claim failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // DELETE /api/apps/:slug/github-issues/:number/claim
  //
  // Clear an in-progress claim. With no body: the CALLER's own claim. A
  // write-capable admin may pass { userId } to clear another user's
  // stuck claim; anyone else passing a foreign userId gets 403 — each
  // claim belongs to its claimer, so the status can't be kicked back
  // and forth between users. Idempotent: clearing a nonexistent (or
  // already-expired-and-replaced) claim is a soft 200.
  // ----------------------------------------------------------------
  router.delete('/api/apps/:slug/github-issues/:number/claim', sameOriginBrowserOnly, async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const rawTarget = req.body && req.body.userId;
      const targetUserId = rawTarget != null ? parseInt(rawTarget, 10) : req.user.id;
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      if (targetUserId !== req.user.id && !req.user.canAdminWrite) {
        return res.status(403).json({ error: 'Only the claimer or an admin can clear this' });
      }

      const { rows } = await pool.query(
        `DELETE FROM issue_claims
          WHERE app_id = $1 AND github_issue_number = $2 AND user_id = $3
          RETURNING user_id`,
        [app.id, issueNumber, targetUserId]
      );
      const cleared = rows.length > 0;
      if (cleared) await require('../services/work-state').touched(pool, [{ appId: app.id, issueNumber }]);

      if (cleared) {
        const content = targetUserId === req.user.id
          // #1112: "released their claim" — the DELETE only ever removes one
          // person's claim, never the derived state the board used to call
          // "In progress".
          ? `${req.user.username} released their claim on this issue`
          : `${req.user.username} released someone else's claim on this issue`;
        await sendSystemMessage(pool, app.id, content,
          'system', null, { type: 'issue', ref: issueNumber }
        ).catch((err) => log.warn('issues', 'Claim-clear chat message failed', { err: err.message }));
        pushIssueUpdate({
          action: 'unclaimed', appSlug: app.slug, appId: app.id, issueNumber,
        });
        log.info('issues', 'Issue claim cleared', {
          appId: app.id, issueNumber, by: req.user.username, targetUserId,
        });
      }

      res.json({ ok: true, cleared });
    } catch (err) {
      log.error('issues', 'Issue claim clear failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin force-apply for secret_change proposals — the issue-side
  // counterpart of POST /api/sessions/:id/admin-merge. Lets an admin
  // apply an environment-variable proposal right now, bypassing the
  // active-user majority (and the locked-app admin-up gate, which is
  // trivially satisfied by the admin acting). Same visibility rules:
  // the chat message + GitHub comment name the admin so the override
  // is never silent.
  router.post('/api/issues/:id/admin-apply', sameOriginBrowserOnly, async (req, res) => {
    const issueId = positiveIssueId(req.params.id);
    if (!issueId) return res.status(404).json({ error: 'Issue not found' });
    try {
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.created_by AS app_created_by,
                a.self_hosted AS app_self_hosted
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [issueId]
      );
      if (!issueRows.length) {
        if (!req.user?.canAdminWrite) {
          return res.status(403).json({ error: 'Full admin access required' });
        }
        return res.status(404).json({ error: 'Issue not found' });
      }
      const issue = issueRows[0];

      // This multiplexed route force-applies several governance kinds. Keep
      // the non-secret kinds available to the CLI, but never let api:access
      // become authority to apply a stored credential value.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      // #788: the issue-side counterpart of the force-merge widening —
      // an app's own declared admins may force-apply that app's
      // governance proposals. The exception is the one issue kind that is
      // flagged for explicit approval, a secret change: it carries a value,
      // and applying it on an app admin's say-so would skip the other
      // member's Yes it waits for, so only a platform admin may.
      const appForGate = { id: issue.app_id, created_by: issue.app_created_by };
      const explicitApproval = issue.kind === 'secret_change';
      if (!(await appAdmins.canForceMerge(pool, appForGate, req.user, { explicitApproval }))) {
        if (explicitApproval && await appAdmins.isAppAdmin(pool, issue.app_id, req.user?.id)) {
          return res.status(403).json({
            error: `${explicitApprovalCopy.reasonSentence(
              explicitApprovalCopy.secretChangeReason(!!issue.app_self_hosted)
            )} Only a platform admin can apply it without that vote.`,
          });
        }
        return res.status(403).json({ error: 'Full admin access required' });
      }

      // The machine answers a closed proposal itself (a retry of an apply
      // that succeeded replays its result).
      if (issue.kind !== 'secret_change' && issue.kind !== 'close_issue'
          && issue.kind !== 'reopen_issue'
          && issue.kind !== 'maintenance_campaign' && issue.kind !== 'featured_illustration') {
        return res.status(400).json({ error: 'Only secret-change, close-issue, reopen-issue, maintenance-campaign, and featured-illustration proposals can be admin-applied' });
      }
      // Campaigns are self-app governance with fleet-wide blast radius:
      // only a FULL platform admin may force one, never an app admin.
      if (issue.kind === 'maintenance_campaign' && !req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }

      log.info('issues', 'Admin force-apply requested', {
        issueId: issue.id, kind: issue.kind, by: req.user.username,
      });

      const reply = await workflow().adminApplyProposal(issue, req.user, req.get('Idempotency-Key') || undefined);
      res.status(reply.status).json(reply.body);
    } catch (err) {
      log.error('issues', 'Admin force-apply failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Withdraw a governance proposal: the creator-gated self-service withdraw
  // (the PR-proposal equivalent is POST /api/sessions/:id/archive). Only the
  // proposal's creator may withdraw; the governance machine decides it under
  // the row lock, so a stale double-tap or a race against a passing vote
  // answers 404 "Proposal not open".
  router.post('/api/issues/:id/close', sameOriginBrowserOnly, async (req, res) => {
    const issueId = positiveIssueId(req.params.id);
    if (!issueId) return res.status(404).json({ error: 'Issue not found' });
    try {
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url AS repo_url
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [issueId]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];

      // Withdrawing a secret proposal changes credential state just as voting
      // or force-applying it does. Keep this multiplexed close route usable for
      // ordinary governance proposals, but not through a CLI bearer grant.
      if (req.cliAuthenticated && issue.kind === 'secret_change') {
        return res.status(403).json({ error: 'credential_management_not_available_via_cli' });
      }

      // Creator-only. (Admins already have other paths — admin merge / direct
      // GitHub close — so the gate stays creator-scoped per the spec.)
      if (!issue.created_by || issue.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only the proposer can withdraw this proposal' });
      }

      if (!isGovernanceKind(issue.kind)) {
        return res.status(400).json({ error: 'Only a governance proposal can be withdrawn here' });
      }
      const reply = await workflow().withdrawProposal(issue, req.user);
      res.status(reply.status).json(reply.body);
    } catch (err) {
      log.error('issues', 'Withdraw failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  issueRoutes,
  creatorFromSourceLine,
  shouldCreateGithubTwin,
  issueBodyWithScreenshots,
  MAX_GITHUB_ISSUE_BODY_CHARS,
  // #6497: a request's GitHub comments, read beside its thread.
  readRequestComments,
  // "In progress" derivation pieces, exported for unit tests.
  pickInProgressTarget,
  composeInProgress,
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
  // #3752: a conversation opened on a staging mock request is named from it
  // (agent-sessions.js lookupRequestTitle), as this file's issue page reads it.
  stagingMockIssues,
};
