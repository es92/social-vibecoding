'use strict';

// The AI tab's main view (#6019 follow-up, plan v3: "what needs you comes
// first, then your private threads, with a lock on the tile, then Up next:
// what's moving without you, soonest first"). frontend/src/features/ai/ draws
// it; this reads what it lists, for one person, across every project they
// can see:
//
//   private  their private threads in the chat with Homeroom bot: the threads
//            they started (services/private-threads.js), the drafts the bot
//            opened for them and (14 Nov 2026: Main Chat is gone, and every
//            conversation there is a thread) the bot's hello, a project's
//            first version and Earlier chat, each with the project it is
//            for, if it has one, and how many of its messages are new to
//            them (`unread`);
//   threads  the public threads they are in, by the rule a thread's
//            followers are worked out by (threads.js FOLLOWERS_SQL, read the
//            other way round; threadsInSql): they asked for it, built a
//            change in it, voted in it, wrote in it, or chose Notify me, and
//            did not choose Mute. Each says which list it is in:
//              needs    Needs you, beside the Needs you feed: a plan Homeroom
//                       bot wrote for their request, waiting for their Build
//                       it, or a request of theirs it handed back, for a
//                       person to decide or with a build that stopped
//                       (the feed carries no such card);
//              next     In progress: one of THEIRS (they asked for it, built
//                       it, or chose Notify me) being worked on: Homeroom bot
//                       reading it, a change being made or fixed, somebody
//                       who pressed Claim on it, merging, or merged and
//                       going live;
//              waiting  Waiting: one of theirs waiting on someone else: up
//                       for a vote they have voted on (or that is theirs), a
//                       change's or a group decision's (which has nothing to
//                       build),
//                       waiting for a free builder or held back (as the bot
//                       says in Main), or a request nobody has picked up;
//              live     a change of it went live in the last week.
//            One they only voted or wrote in is listed only once it is live
//            or while nobody has picked it up: once they have voted there is
//            nothing left for them to do. A change up for a vote that still
//            owes their vote is the Needs you feed's (GET /api/workshop/
//            needs-feed?in=threads, the same threads), which the view puts
//            first, so it is not listed here twice.
//
// ONE STORY WITH MAIN (29 Oct 2026). Where Homeroom bot works on a request
// for them, the list it is in is the bot's own word on it: the stage its
// answer to "how far along are you?" reads (homeroom-bot-progress.js
// requestStates). Read off the request and its change alone, a plan waiting
// for Build it and a request held back for a build said "Not picked up
// yet", or nothing at all, while the bot said otherwise in Main.
//
// The projects are the ones the Workshop's own reads show the viewer
// (routes/workshop-overview.js VISIBLE_APP_WHERE): not suspended, a
// self-hosted one only for an admin or where public voting is on, and a
// private one only to its members.

const log = require('./logger');
const repoRef = require('./repo-ref');
const workState = require('./work-state');
const { updateComingSql, updateAskSql, updateFailedSql } = require('./homeroom-bot-progress');
const { planRecordSql } = require('./request-specs');

const THREADS_MAX = 80;
const PRIVATE_MAX = 30;
const LIVE_DAYS = 7;
// How long a claim holds, as the bot reads one (homeroom-bot.js CLAIM_TTL_DAYS).
const CLAIM_DAYS = 7;

const VISIBLE_APP_WHERE = `a.moderation_suspended_at IS NULL
     AND (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// The threads a person is in (`viewer` is the SQL parameter that names
// them, e.g. '$1'), one row each: `own` when the thread is theirs (they
// asked for it, built a change in it, or chose Notify me) rather than one
// they only voted or wrote in. Muting is the reader's to apply. The Homeroom
// bot tab's Needs you (routes/workshop-overview.js, ?in=threads) reads the
// same threads, so its two lists agree on what is yours.
function threadsInSql(viewer) {
  return `SELECT thread_id, bool_or(own) AS own FROM (
    SELECT thread_id, TRUE AS own FROM requests WHERE created_by = ${viewer} AND thread_id IS NOT NULL
    UNION ALL SELECT thread_id, TRUE FROM issues WHERE created_by = ${viewer} AND thread_id IS NOT NULL
    UNION ALL SELECT t.id, TRUE FROM homeroom_bot_requesters b
                JOIN threads t ON t.app_id = b.app_id AND t.number = b.issue_number
               WHERE b.user_id = ${viewer}
    UNION ALL SELECT thread_id, TRUE FROM chat_sessions
               WHERE user_id = ${viewer} AND thread_id IS NOT NULL AND is_headless = FALSE
    -- A request they pressed Claim on this week is theirs to build, as the
    -- Workshop counted it (AppView._issueIsMine), even with no change yet.
    UNION ALL SELECT t.id, TRUE FROM issue_claims ic
                JOIN threads t ON t.app_id = ic.app_id AND t.number = ic.github_issue_number
               WHERE ic.user_id = ${viewer} AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
    UNION ALL SELECT s.thread_id, FALSE FROM pr_votes v JOIN chat_sessions s ON s.id = v.session_id
               WHERE v.user_id = ${viewer} AND s.thread_id IS NOT NULL
    UNION ALL SELECT i.thread_id, FALSE FROM issue_votes v JOIN issues i ON i.id = v.issue_id
               WHERE v.user_id = ${viewer} AND i.thread_id IS NOT NULL
    UNION ALL SELECT thread_id, FALSE FROM chat_messages
               WHERE user_id = ${viewer} AND thread_id IS NOT NULL AND msg_type = 'message' AND deleted_at IS NULL
    UNION ALL SELECT thread_id, TRUE FROM thread_followers WHERE user_id = ${viewer} AND muted_at IS NULL
  ) why GROUP BY thread_id`;
}

// $1 viewer, $2 show self-hosted, $3 admin, $4 the most rows of each kind,
// $5 days a closed thread stays listed (Live this week).
//
// THE MOST ROWS (30 Oct 2026). Up to $4 threads with a merged change (Live
// this week, Going live) and, apart, up to $4 of the rest, their own before
// those they only voted or wrote in. With one budget for both, newest first,
// a week of changes going live filled it and every request of the viewer's
// older than about a day was never read: a plan waiting for their Build it
// and requests nobody was building were on neither list while Main named
// them. Nor are threads read that standing() can never list: closed with
// nothing merged, live more than $5 days ago, or merged and not live yet in
// a thread that is not theirs.
const THREADS_SQL = `
WITH mine AS (${threadsInSql('$1')})
SELECT * FROM (
SELECT t.id, t.app_id, mine.own, t.number, t.kind, t.title AS thread_title, t.state, t.created_at, t.closed_at,
       -- #6421: a merged thread holds several requests; its row says how many.
       (SELECT COUNT(*) FROM requests r WHERE r.thread_id = t.id)::int AS request_count,
       a.slug, a.name, a.icon_emoji, a.icon_image_id, a.repo_url,
       req.id AS request_id, req.title AS request_title, req.state AS request_state, req.updated_at AS request_at,
       ch.id AS change_id, ch.pr_number, ch.status AS change_status, ch.user_id AS change_user,
       ch.title AS change_title, ch.promoted_at, ch.merged_at, ch.live_at, ch.last_activity_at,
       ch.voted, ch.my_vote, ch.check_state, ch.needs_fix,
       -- #6282: an update on its way holds the vote the change would ask for.
       -- #6600: and why a takeover's last attempt failed, when it did.
       ch.update_coming, ch.update_ask, ch.update_failed,
       dec.id AS decision_id, dec.status AS decision_status, dec.mine AS decision_mine, dec.my_vote AS decision_vote,
       cl.username AS claimed_by, cl.mine AS claimed_mine,
       COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, req.updated_at, t.created_at) AS sort_at,
       -- 1 Nov 2026: their own private thread about its request holds the
       -- bot: it waits for their plan (rules/bot-loop.ts planHoldActiveSql).
       (t.number IS NOT NULL AND EXISTS (
          SELECT 1 FROM private_threads p
           WHERE p.app_id = t.app_id AND p.about_number = t.number AND p.user_id = $1
             AND ${require('../workflow/rules/bot-loop.ts').planHoldActiveSql('p')})) AS awaiting_plan,
       ROW_NUMBER() OVER (
         PARTITION BY COALESCE(ch.status = 'merged', FALSE)
         ORDER BY mine.own DESC,
                  COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, req.updated_at, t.created_at) DESC
       ) AS place
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN LATERAL (
    SELECT r.id, r.title, r.state, r.updated_at FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, cs.status, cs.user_id, cs.promoted_at, cs.merged_at, cs.live_at,
           cs.last_activity_at, cs.check_state,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
           EXISTS (SELECT 1 FROM pr_votes v
                    WHERE v.session_id = cs.id AND v.user_id = $1
                      AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch) AS voted,
           (SELECT v.vote FROM pr_votes v
             WHERE v.session_id = cs.id AND v.user_id = $1
               AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch
             LIMIT 1) AS my_vote,
           -- Waits on its author for a fix, as the Workshop's Waiting on you
           -- read it (AppView._workshopNeedsFix): its checks failed, its
           -- preview did not build, or a merge attempt hit a conflict that
           -- a person has to resolve. Not a checks run the platform could
           -- not finish: that is nobody's to fix.
           (cs.check_state = 'failing'
            OR (cs.staging_url IS NULL AND cs.check_state = 'error' AND cs.check_error_detail IS NOT NULL)
            OR cs.merge_conflict_state = 'failed'
            -- #6531: a conflict only its author (or the bot) can now move,
            -- after the conflict lane's free resolution was spent.
            OR cs.integration_block_reasons ?| array['unresolvable','fork_head','checks_failing','checks_error']
            -- #6546: GitHub's required checks failed again after Homeroom ran
            -- them on today's main.
            OR cs.integration_block_reasons ? 'github_checks_failing') AS needs_fix,
           -- #6282: 'running' while a turn updates it, 'queued' while an
           -- ask waits its turn, and what was asked, for the row's words.
           ${updateComingSql('cs')} AS update_coming,
           ${updateAskSql('cs')} AS update_ask,
           ${updateFailedSql('cs')} AS update_failed
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       -- A posted plan is no change (threads.js ITEMS_SQL says the same).
       AND NOT ${planRecordSql('cs')}
       AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       AND (cs.status NOT IN ('active', 'paused') OR cs.shared_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY CASE cs.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
              cs.id DESC
     LIMIT 1
  ) ch ON TRUE
  -- A decision's group vote (a rename, a card picture, ...): whether it is
  -- still open, and whether the viewer filed it or has voted on it, so the
  -- row says it waits for votes, or leaves it to the Needs you feed when the
  -- viewer's own vote is owed (OWED_GOVERNANCE_WHERE). Its id is the
  -- address of its page (hrefOf).
  LEFT JOIN LATERAL (
    SELECT i.id, i.status, (i.created_by = $1) AS mine,
           (SELECT v.vote FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = $1 LIMIT 1) AS my_vote
      FROM issues i
     WHERE t.kind = 'decision' AND i.thread_id = t.id
     ORDER BY i.id DESC
     LIMIT 1
  ) dec ON TRUE
  -- Somebody pressed Claim on its request (issue_claims) this week, the
  -- bot's own reading of a live claim (homeroom-bot.js CLAIM_TTL_DAYS): who,
  -- so a request being built with no change up yet says who has it rather
  -- than "Nobody is building it yet".
  LEFT JOIN LATERAL (
    SELECT u.username, (ic.user_id = $1) AS mine
      FROM issue_claims ic JOIN users u ON u.id = ic.user_id
     WHERE t.number IS NOT NULL AND ic.app_id = t.app_id AND ic.github_issue_number = t.number
       AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
       AND u.is_synthetic IS NOT TRUE
     ORDER BY ic.claimed_at DESC
     LIMIT 1
  ) cl ON TRUE
 WHERE t.merged_into IS NULL
   AND (t.state = 'open' OR (t.closed_at > NOW() - make_interval(days => $5) AND ch.status = 'merged'))
   AND (ch.status IS DISTINCT FROM 'merged'
        OR ch.live_at > NOW() - make_interval(days => $5)
        OR (ch.live_at IS NULL AND (mine.own OR ch.user_id = $1)))
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
   -- A change in flight in a thread they only voted or wrote in is never
   -- listed (standing), so it is not read either: somebody who votes on
   -- everything filled the most rows with those, and their own requests
   -- further down were cut off before they could be listed.
   AND (mine.own OR ch.status IS NULL OR ch.status = 'merged' OR ch.user_id = $1)
   AND ${VISIBLE_APP_WHERE}
) listed
 WHERE place <= $4
 ORDER BY sort_at DESC`;

// How the change a private thread is about ended, as one row (at, outcome),
// or none while the thread is still Needs you's. Written for the two reads
// that list private threads (PRIVATE_SQL here, HISTORY_PRIVATE_SQL in
// ai-history.js): `p` is their private_threads row and $1 their viewer. A
// constant, not a builder, so both reads stay ones `npm run lint:sql` checks.
//
// 13 Nov 2026: a thread about a request is finished with it (finishForRequest
// in private-threads.js), but one about a change had no such rule, so a
// change that went live was listed twice: its thread under Needs you and the
// change under Live this week. The thread is finished with its change: merged
// and live ('live', at the moment it went live), or closed ('closed'). The
// change is the one the thread opens (aboutTarget: the newest session with
// that pull request number), so a closed change that is reopened brings its
// thread back. Read, never stored, so the threads of changes already live
// leave too, and the change's page still opens the same thread (startAbout
// reuses an open one).
//
// A thread they opened after the change ended, or wrote in since, is theirs
// again: it stays listed, the way writing in a done thread reopens it
// (reopenOnReply). Mark done then closes it like any other.
const ABOUT_CHANGE_END_SQL = `SELECT ended.at, ended.outcome FROM (
      SELECT CASE cs.status WHEN 'merged' THEN cs.live_at
                            WHEN 'archived' THEN COALESCE(cs.archived_at, cs.last_activity_at) END AS at,
             CASE cs.status WHEN 'merged' THEN 'live' ELSE 'closed' END AS outcome
        FROM chat_sessions cs
       WHERE p.about_kind = 'change' AND p.state = 'open'
         AND cs.app_id = p.app_id AND cs.pr_number = p.about_number AND cs.is_headless = FALSE
       ORDER BY cs.id DESC
       LIMIT 1
    ) ended
    WHERE ended.at IS NOT NULL AND ended.at >= p.created_at
      AND NOT EXISTS (SELECT 1 FROM conversation_messages w
                       WHERE w.thread_root_id = p.root_message_id AND w.sender_id = $1
                         AND w.deleted_at IS NULL AND w.created_at > ended.at)`;

// $1 viewer, $2 the bot, $3 the most rows, $4 days a done thread stays
// listed. A thread they started is one of their own messages in the chat
// with the bot that has replies; a draft the bot opened is a row of
// private_threads. Every private thread is listed except a done one (#6250,
// 4 Nov 2026: a filed, posted or dropped thread stays, so the way in is
// always the list, never Main Chat). #6153: with where it went (its state and
// the request's number), so the tab draws a filed or posted thread as that
// request's row rather than a second one when a row names it (model.ts
// needsYou). #6271: a done thread stays listed for $4 days after it was
// closed, where Live this week shows it.
const PRIVATE_SQL = `
SELECT m.id AS root_id, m.content, m.created_at, p.kind, p.state, p.result_ref, p.done_at, a.slug, a.name,
       a.icon_emoji, a.icon_image_id, a.repo_url,
       -- #6764 (17 Nov 2026): a short summary written after the bot's first
       -- answer, or the name the person set. It is the thread's name ahead of
       -- anything below; title_source says which (auto or person).
       p.title, p.title_source,
       -- A thread started from the bot's "+" is named by their first words in it.
       (SELECT f.content FROM conversation_messages f
         WHERE f.thread_root_id = m.id AND f.sender_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.id LIMIT 1) AS first_own,
       -- 1 Nov 2026 (C1): a thread about a request or a change is named by
       -- it ("#18 Dark mode"), and one holding a design by its screen.
       p.about_kind, p.about_number,
       COALESCE((SELECT rq.title FROM requests rq
                  WHERE p.about_kind = 'request' AND rq.app_id = p.app_id AND rq.number = p.about_number),
                m.metadata->'homeroomBot'->>'aboutTitle') AS about_title,
       (SELECT d.title FROM design_threads d WHERE d.private_thread_id = p.id) AS design_title,
       -- B08, B19 (audit 2 Nov 2026): a new project's thread is named by its
       -- idea, never by the person's latest words in it, and a draft's by
       -- what it drafts, never by the bot's line that opened it.
       m.metadata->'homeroomBot'->>'projectIdea' AS project_idea,
       m.metadata->'homeroomBot'->>'draftTitle' AS draft_title,
       -- 15 Nov 2026: a thread a retired agent chat or dev chat was moved
       -- under is named as that conversation was (services/old-chat-move.js).
       m.metadata->'movedChat'->>'title' AS moved_title,
       -- 14 Nov 2026: a first version's thread is named by its project, the
       -- one its first message names when the project itself is gone.
       m.metadata->'homeroomBot'->>'appName' AS root_app_name,
       (SELECT MAX(r.created_at) FROM conversation_messages r
         WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS last_at,
       -- Filed (or posted) as a request that has finished: live for longer
       -- than Live this week keeps it, or closed with nothing merged. It is
       -- History's then (services/ai-history.js reads it by the same rule),
       -- not a Needs you row with nothing left to do. Or about a change
       -- that is live or closed (ABOUT_CHANGE_END_SQL), which is History's too.
       (EXISTS (${ABOUT_CHANGE_END_SQL})
        OR (p.state IN ('filed', 'posted') AND p.result_ref > 0 AND (
          EXISTS (SELECT 1 FROM chat_sessions cs
                   WHERE cs.app_id = p.app_id AND p.result_ref = ANY(cs.linked_issues) AND cs.status = 'merged'
                     AND cs.live_at <= NOW() - make_interval(days => $4))
          OR EXISTS (SELECT 1 FROM requests r
                      WHERE r.app_id = p.app_id AND r.number = p.result_ref AND r.state = 'closed'
                        AND NOT EXISTS (SELECT 1 FROM chat_sessions m
                                         WHERE m.app_id = r.app_id AND r.number = ANY(m.linked_issues) AND m.status = 'merged'))))) AS result_done
  FROM conversations c
  JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
  JOIN conversation_members bot ON bot.conversation_id = c.id AND bot.user_id = $2
  JOIN conversation_messages m ON m.conversation_id = c.id AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
  LEFT JOIN private_threads p ON p.root_message_id = m.id AND p.user_id = $1
  LEFT JOIN apps a ON a.id = p.app_id AND a.moderation_suspended_at IS NULL
 WHERE c.kind = 'direct'
   AND (p.id IS NOT NULL
        OR (m.sender_id = $1 AND EXISTS (SELECT 1 FROM conversation_messages r
                                          WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL)))
   -- #6250: filed, posted and dropped threads stay listed. #6271: a done
   -- thread is finished, but stays findable for $4 days under Live this week
   -- (unless reopened).
   AND (COALESCE(p.state, 'open') <> 'done'
        OR p.done_at >= NOW() - make_interval(days => $4))
 ORDER BY COALESCE((SELECT MAX(r.created_at) FROM conversation_messages r
                     WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL), m.created_at) DESC
 LIMIT $3`;

// The project as the Needs you feed names it (routes/workshop-overview.js),
// so one tile draws both (features/apps/app-card-view.tsx AppIconContent).
function appOf(row) {
  if (!row.slug) return null;
  return {
    slug: row.slug,
    name: row.name || row.slug,
    icon_url: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    icon_emoji: row.icon_emoji || null,
    // Where a change's number comes from: GitHub's own counter there, so a
    // change reads "PR 12"; Homeroom's git host shares one counter, so "#12".
    // The address itself does not ride along.
    changesOnGithub: repoRef.isGithub(row.repo_url),
  };
}

// The page a thread opens on: its request's, else its change's, else a
// decision's own page (1 Nov 2026: a Waiting row for a decision went to the
// project's Workshop, where the person had to find it), else the Workshop.
function hrefOf(row) {
  const slug = encodeURIComponent(row.slug);
  if (row.number != null && row.request_title != null) return `#app/${slug}/dev/issues/${Number(row.number)}`;
  if (row.pr_number != null) return `#app/${slug}/dev/changes/${Number(row.pr_number)}`;
  if (row.kind === 'decision' && row.decision_id != null) return `#app/${slug}/dev/governance/${Number(row.decision_id)}`;
  return `#app/${slug}/workshop`;
}

function firstLine(text, max = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// #6282: one ask, as the row's one line of words: 80 characters at most,
// ending in "…" when cut (the way the bot's own lines are shortened,
// homeroom-bot-voice.js clip). Whitespace folds, so a tooltip stays one line.
function clip(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const iso = (at) => (at ? new Date(at).toISOString() : null);
const DAY_MS = 24 * 60 * 60 * 1000;

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): where a thread's request
// or change stands is its stored work state (services/work-state.js), the
// same one every other screen draws. This page adds only what is the
// viewer's own: whether they decide on it, their vote, who is building it,
// and which list that puts it in.

/**
 * Pure: where one thread stands for the viewer, or null when it is not
 * theirs to see in these lists (a vote they owe is Needs you's, and so is
 * the bot's question; a change live more than a week ago is history; one in
 * flight that they only voted or wrote in asks nothing more of them). `work`
 * is the stored work state of its request (or of its change, when it has no
 * request); `viewer` is whether they decide on it (they asked for it, or
 * they run its project). `botId` is Homeroom bot's account, so a change it
 * is making says so.
 */
function standing(row, viewerId, now = new Date(), botId = null, work = null, viewer = null) {
  const status = row.change_status || null;
  const theirs = row.change_user != null && Number(row.change_user) === Number(viewerId);
  // #6667: the change Homeroom bot made, which waits on the person who asked
  // for its request once the bot hands the fix back (workFor marks it).
  const byBot = botId != null && row.change_user != null && Number(row.change_user) === Number(botId);
  // In progress is their own work: asked for, built, or followed.
  const own = row.own === true || theirs;
  // A decision up for the group's vote (a rename, a card picture, ...) has
  // nothing to build: it is up for a vote, as a change up for one is.
  if (!work && row.kind === 'decision' && row.decision_status != null) {
    if (row.decision_status !== 'open' || !own) return null;
    const myVote = row.decision_vote === 'yes' || row.decision_vote === 'no' ? row.decision_vote : null;
    // Their vote still owed: the Needs you feed's, as a change's is.
    if (!myVote && row.decision_mine !== true) return null;
    const vote = { stage: 'up_for_vote', why: null, reason: null, line: null, since: iso(row.created_at) };
    return { group: 'waiting', work: { ...vote, words: workState.phrasesOf(vote) }, at: iso(row.created_at), myVote };
  }
  // 11 Nov 2026: the stored row is the one source (statesFor makes it first
  // when it is missing); a thread with none to read is not listed.
  const state = work;
  if (!state) return null;
  const at = iso(state.since) || iso(row.request_at || row.created_at);
  // Its words travel with it (work-state.js phrasesOf): the tab draws them.
  const stored = {
    stage: state.stage, why: state.why || null, reason: state.reason || null, line: state.line || null, since: at,
    words: state.words || workState.phrasesOf(state),
  };
  if (state.stage === 'live') {
    const liveAt = row.live_at || state.since;
    if (!liveAt || now - new Date(liveAt) > LIVE_DAYS * DAY_MS) return null;
    // #6233: merged_at and the change's id let the tab compare the change
    // with the build it loaded (the "reload to get it" wording).
    return { group: 'live', work: stored, at: iso(liveAt),
      mergedAt: iso(row.merged_at), changeId: Number(row.change_id) || null };
  }
  // A merge closes its request before the release carrying it is live.
  if ((row.state !== 'open' && state.stage !== 'going_live') || state.stage === 'closed') return null;
  const decides = viewer?.decides === true
    || (state.requesterId != null && Number(state.requesterId) === Number(viewerId));
  // The bot's question is the Needs you feed's Answer.
  if (decides && state.stage === 'waiting_for_you' && state.why === 'question') return null;
  // Owed by everyone, its author included: proposing is never their yes,
  // and their tap is (governance-rules.ts).
  const wouldVote = !row.voted;
  // #6282: an update on its way holds the vote. It is listed for its own
  // people and for the ones who would have been asked to vote; somebody who
  // already voted and only wrote in it gets no row.
  const code = state.line?.code;
  // #6600: a takeover the bot is running on the change is an update under
  // way, whether it is fixing its failing checks or revising it. #6807: and
  // a change waiting on the bot's fix for a check that is not its own.
  const updating = status === 'promoted' && (code === 'revising' || code === 'update_queued' || code === 'fixing' || code === 'fixing_check');
  // #6600: its last takeover attempt failed, and nothing has checked it since.
  const botFixFailed = row.update_failed != null || code === 'bot_fix_failed';
  // Owed only while its change is open for votes (work_states.vote_open).
  const voteOwed = (state.voteOpen ?? state.stage === 'up_for_vote') && !updating && status === 'promoted' && wouldVote;
  // Their own change that waits on them: checks that failed, a preview that
  // did not build, a conflict to resolve (THREADS_SQL needs_fix). Needs you,
  // with Fix it, not Waiting under "Checks failing", which it would wait in
  // forever. The stage stays the change's own; that it is theirs to fix is
  // the viewer's. #6600: after Homeroom bot's own attempt failed it says
  // that instead. A change Homeroom bot made is not theirs to fix while the
  // bot is still working; once it hands the fix back, the request's asker
  // gets it (below).
  if (status === 'promoted' && theirs && row.needs_fix === true && !updating && state.stage !== 'building') {
    return { group: 'needs', work: stored, at: iso(row.last_activity_at || row.promoted_at) || at, fixYours: true, ...(botFixFailed ? { botFixFailed: true } : {}) };
  }
  // #6667: Homeroom bot built the change and gave up fixing it, and the
  // viewer asked for its request. Waiting under "Checking" looked like
  // nothing was needed of them, but nothing moves until a person steps in.
  // Only once the bot is not fixing it: a running or queued fix, or one it
  // has not looked at yet, stays where it is.
  const asked = state.requesterId != null && Number(state.requesterId) === Number(viewerId);
  if (status === 'promoted' && byBot && asked && row.needs_fix === true && row.bot_handed_off === true
      && !updating && row.update_coming == null && state.stage !== 'building') {
    return { group: 'needs', work: stored, at: iso(row.last_activity_at || row.promoted_at) || at, botFixFailed: true };
  }
  // #6402: a change still being checked asks nobody for a vote yet. Someone
  // who would have been asked, but is not its author or a follower, sees it
  // under Waiting while it checks rather than losing it from every list.
  if (state.stage === 'checking' && status === 'promoted' && wouldVote && !own && !updating) {
    return { group: 'waiting', work: stored, at };
  }
  // One they only voted or wrote in is listed while no change of it is in
  // flight, as Waiting: it asks nothing of them, and nobody is building it.
  const place = updating
    ? ((own || wouldVote) ? ((code === 'revising' || code === 'fixing' || code === 'fixing_check') ? 'next' : 'waiting') : null)
    : workState.placeFor(state, { requester: decides, own, voteOwed }) || (!own && !inFlight(state) ? 'waiting' : null);
  if (!place) return null;
  const out = { group: place, work: stored, at };
  if (state.stage === 'building' && !state.line) {
    out.by = status ? (byBot ? 'bot' : theirs ? 'you' : 'someone') : 'bot';
  }
  // Somebody pressed Claim, or is building a change of their own for it: you, or someone.
  if (state.line?.code === 'claimed') out.by = row.claimed_mine === true || theirs ? 'you' : 'someone';
  if (state.stage === 'up_for_vote' && (row.my_vote === 'yes' || row.my_vote === 'no')) out.myVote = row.my_vote;
  // #6282: what was asked for, on an update on its way.
  if ((state.line?.code === 'revising' || state.line?.code === 'update_queued') && row.update_ask) out.ask = clip(row.update_ask);
  // A request nobody has started on for a week says how long.
  if (state.stage === 'reading' && state.line?.code === 'waiting' && row.request_at) {
    const quiet = Math.floor((now - new Date(row.request_at)) / DAY_MS);
    if (quiet >= 7) out.quietDays = quiet;
  }
  return out;
}

// A change of it is being made, checked, voted on or put live.
const READY_LINES = new Set(['queued', 'held_builds', 'held_waiting']);
function inFlight(state) {
  if (state.stage === 'building') return !READY_LINES.has(state.line?.code);
  return state.stage === 'checking' || state.stage === 'up_for_vote' || state.stage === 'going_live';
}

// In progress is soonest first: going live, then a change being fixed or
// updated, then made, then planned, then a request being read.
const NEXT_ORDER = { going_live: 0, checking: 1, building: 2, planning: 3, reading: 4 };
const nextRank = (t) => (t.work.stage === 'building' && t.work.line && ['fixing', 'revising'].includes(t.work.line.code)
  ? 1.5 : NEXT_ORDER[t.work.stage] ?? 5);
// Waiting is the nearest to live first: a vote or a change still waiting for
// its checks (the oldest has waited longest), an update waiting its turn, a
// build waiting its turn or held back, a request waiting to be read, then one
// nobody has started on, and what waits on somebody else's move.
function waitingRank(t) {
  const { stage, line } = t.work;
  const code = line && line.code;
  if (stage === 'up_for_vote') return 0;
  if (stage === 'building' && code === 'update_queued') return 1;
  if (stage === 'checking' || (stage === 'planning' && code !== 'retry_plan')) return 0;
  if (stage === 'planning') return 4;
  if (stage === 'building') return code === 'queued' ? 2 : 3;
  if (stage === 'reading') return code === 'queued' ? 4 : code === 'on_hold' || code === 'cooldown' ? 5 : 6;
  return 6;
}

// #6158: the Waiting rows nobody is moving, which the tab folds under one
// "Not moving" head. They sort last, newest first.
const stillOf = (t) => (t.work.stage === 'reading' && t.work.line?.code === 'waiting')
  || t.work.stage === 'waiting_for_you' || t.work.stage === 'stopped';

/** The key a thread's request is matched to its stored state by. */
const botKey = (slug, number) => `${slug}#${Number(number)}`;

function shapeThread(row, viewerId, now, botId, states, viewers) {
  const key = row.slug && row.number != null && row.request_id != null ? botKey(row.slug, row.number) : null;
  const work = (key && states?.get(key)) || (row.change_id && states?.get(`change:${Number(row.change_id)}`)) || null;
  const viewer = key ? viewers?.get(key) || null : null;
  const stand = standing(row, viewerId, now, botId, work, viewer);
  if (!stand) return null;
  // A change's own thread with no number (its PR number is a request's) is
  // named by its change.
  const number = row.number != null ? Number(row.number) : row.pr_number != null ? Number(row.pr_number) : null;
  const requests = Number(row.request_count) || 0;
  // #6421: a merged thread is called by its change's title while a change
  // lives there; otherwise its first request's title (the lateral read).
  const title = (requests > 1 && row.change_id && row.change_status !== 'merged' && row.change_title)
    ? row.change_title
    : row.request_title || row.change_title || row.thread_title || null;
  return {
    threadId: Number(row.id),
    number,
    // #6421: how many requests it holds, for "· 10 requests" on its row.
    requests,
    // A thread with a change and no request of its own is led by the change:
    // its number is the PR's, which on GitHub reads "PR 12", never "#12"
    // (frontend/src/features/ai/model.ts changeOnGithub). A change built for
    // a request joins the request's thread and keeps its number.
    kind: row.change_id && row.request_id == null ? 'change' : row.kind,
    title,
    app: appOf(row),
    change: row.change_id ? { id: Number(row.change_id), number: row.pr_number == null ? null : Number(row.pr_number) } : null,
    href: hrefOf(row),
    ...stand,
  };
}

/**
 * Pure: the lists, in the order the view draws them. `states` maps a request
 * (botKey) or a change (`change:<id>`) to its stored work state
 * (statesFor); `viewers` maps a request to whether the viewer decides on it
 * (viewerFacts).
 */
function arrange(rows, viewerId, now = new Date(), botId = null, states = null, viewers = null) {
  const shaped = rows.map((row) => shapeThread(row, viewerId, now, botId, states, viewers)).filter(Boolean);
  const byAt = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const oldest = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
  const next = shaped.filter((s) => s.group === 'next').sort((a, b) => (nextRank(a) - nextRank(b)) || oldest(a, b));
  const waiting = shaped.filter((s) => s.group === 'waiting')
    .sort((a, b) => (waitingRank(a) - waitingRank(b)) || (stillOf(a) ? byAt(a, b) : oldest(a, b)));
  return {
    needs: shaped.filter((s) => s.group === 'needs').sort(byAt),
    next,
    waiting,
    live: shaped.filter((s) => s.group === 'live').sort(byAt),
  };
}

/**
 * The stored work state of each thread's request (by botKey) and of each
 * change with no request (`change:<id>`), with a row made first for any
 * request that has none yet (work-state.js ensure). Empty on a read error:
 * a thread with no row read is then not listed.
 */
async function statesFor(pool, rows) {
  const states = new Map();
  const requests = (rows || []).filter((r) => r.app_id != null && r.number != null && r.request_id != null && r.slug);
  const changes = (rows || []).filter((r) => r.change_id && r.request_id == null).map((r) => Number(r.change_id));
  try {
    await workState.ensure(pool, requests.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.number) })));
    await workState.ensureChanges(pool, changes);
    const { rows: found } = await pool.query(
      `SELECT ws.*, a.slug FROM work_states ws JOIN apps a ON a.id = ws.app_id
        WHERE (ws.item_kind = 'request' AND (ws.app_id, ws.item_ref) IN (SELECT * FROM unnest($1::int[], $2::int[])))
           OR (ws.item_kind = 'change' AND ws.item_ref = ANY($3::int[]))`,
      [requests.map((r) => Number(r.app_id)), requests.map((r) => Number(r.number)), changes],
    );
    for (const r of found) {
      const state = workState.fromRow(r);
      states.set(r.item_kind === 'request' ? botKey(r.slug, r.item_ref) : `change:${Number(r.item_ref)}`, state);
    }
  } catch (err) {
    log.warn('ai-work', 'Could not read the work states', { message: err.message });
    return new Map();
  }
  return states;
}

// Whether the viewer decides on each thread's request: they filed it, asked
// Homeroom bot for it, or run its project (homeroom-bot.js whoDecides).
// $1 viewer, $2/$3 the requests' app ids and numbers.
const VIEWER_SQL = `
SELECT w.app_id, w.number, a.slug,
       (rq.created_by = $1
        OR EXISTS (SELECT 1 FROM homeroom_bot_requesters br
                    WHERE br.app_id = w.app_id AND br.issue_number = w.number AND br.user_id = $1)
        OR (a.self_hosted IS NOT TRUE
            AND (a.created_by = $1 OR EXISTS (
              SELECT 1 FROM app_admins aa WHERE aa.app_id = a.id AND aa.user_id = $1)))) AS viewer_decides
  FROM (SELECT DISTINCT * FROM UNNEST($2::int[], $3::int[]) AS w(app_id, number)) w
  JOIN apps a ON a.id = w.app_id
  LEFT JOIN requests rq ON rq.app_id = w.app_id AND rq.number = w.number`;

/** Whether the viewer decides on each thread's request, by botKey. Empty on a read error. */
async function viewerFacts(pool, rows, viewerId) {
  const out = new Map();
  const wanted = (rows || []).filter((r) => r.app_id != null && r.number != null && r.slug);
  if (!wanted.length) return out;
  try {
    const { rows: found } = await pool.query(VIEWER_SQL, [
      viewerId, wanted.map((r) => Number(r.app_id)), wanted.map((r) => Number(r.number))]);
    for (const f of found) out.set(botKey(f.slug, f.number), { decides: f.viewer_decides === true });
  } catch (err) {
    log.warn('ai-work', 'Could not read who decides', { message: err.message });
  }
  return out;
}

function shapePrivate(row) {
  // 1 Nov 2026 (C1): a thread about a request or a change by its title (its
  // number rides in `about`, and the tab draws it as a request's row is
  // drawn); a "+" thread by their first words; a design by its screen.
  // 14 Nov 2026: Earlier chat and a project's first version by what they
  // are ("Earlier chat", "Plant Pal, first version": private-threads.js
  // kindTitle), never by their first words. 15 Nov 2026: a thread moved
  // from a retired agent chat or dev chat by that conversation's title.
  const about = row.about_kind && Number(row.about_number) > 0
    ? { kind: row.about_kind, number: Number(row.about_number) } : null;
  const byKind = require('./private-threads').kindTitle({ kind: row.kind, appName: row.name || row.root_app_name || null });
  // #6764 (17 Nov 2026): a stored title, the summary or the person's own
  // name, is what the thread is called, ahead of what it is.
  const named = row.title
    || byKind
    || (about && row.about_title)
    || row.moved_title
    || row.project_idea
    || row.draft_title
    || (row.kind === 'ask' && row.first_own)
    || row.design_title
    || row.content;
  return {
    rootId: Number(row.root_id),
    title: firstLine(named),
    // #6764: the row's name is a stored one (an automatic summary or the
    // person's), so the open thread's head takes it too (private-thread-bar.tsx).
    ...(row.title_source ? { titled: row.title_source } : {}),
    kind: row.kind || 'idea',
    app: appOf(row),
    at: iso(row.last_at || row.created_at),
    ...(about ? { about } : {}),
    // #6153: a design thread filed as a request, or posted on one as its
    // plan, and that request's number: its row is the request's.
    ...(row.state ? { state: row.state } : {}),
    ...(Number(row.result_ref) > 0 ? { resultRef: Number(row.result_ref) } : {}),
    // #6271: the day it was closed, for Live this week.
    ...(row.done_at ? { doneAt: iso(row.done_at) } : {}),
    // Filed as a request that has finished, or about a change that is live
    // or closed: History's, not Needs you's.
    ...(row.result_done === true ? { resultDone: true } : {}),
  };
}

/**
 * Pure (#6153): the request a private thread was filed as, or posted its
 * plan on, on a project, as `slug#number`; null for any other thread.
 */
function filedKey(p) {
  if ((p?.state !== 'filed' && p?.state !== 'posted') || !p.app?.slug || !(Number(p.resultRef) > 0)) return null;
  return `${p.app.slug}#${Number(p.resultRef)}`;
}

/**
 * Pure (#6153): the private threads Needs you still lists. A thread filed as
 * a request (or posted on one) whose request has a row of its own, in any
 * list, is that row now: the newest such thread for each request is left
 * out. One whose request is in no list stays, as it was. The tab does the
 * same (frontend/src/features/ai/model.ts needsYou).
 */
function unfiledPrivate(privates, listed) {
  const folded = new Set();
  return (privates || []).filter((p) => {
    // #6271: a done thread is closed; it is not Needs you's, but Live's.
    if (p.state === 'done') return false;
    // Filed as a request that has finished, or about a change that is live
    // or closed: History's.
    if (p.resultDone === true) return false;
    const key = filedKey(p);
    if (!key || folded.has(key)) return true;
    folded.add(key);
    return !listed.has(key);
  });
}

// $1 viewer, $2 the app. The threads of one project the viewer is in, by
// the same rule the lists above read them (threadsInSql), less the ones they
// muted: what All items' Yours filter keeps (public/js/app-view.js
// _devCardIsYours). Each with its request's number, its changes' ids and its
// decisions' ids, which is how the board's cards are named.
const YOURS_SQL = `
WITH mine AS (${threadsInSql('$1')})
SELECT t.number, t.kind,
       ARRAY(SELECT cs.id FROM chat_sessions cs WHERE cs.thread_id = t.id) AS sessions,
       ARRAY(SELECT i.id FROM issues i WHERE i.thread_id = t.id) AS issues
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
 WHERE t.app_id = $2 AND t.merged_into IS NULL
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)`;

/**
 * Pure: one project's threads of the viewer's, as the board names its cards:
 * request numbers, change (session) ids and decision (governance issue) ids.
 */
function yoursOf(rows) {
  const requests = new Set();
  const sessions = new Set();
  const decisions = new Set();
  for (const row of rows || []) {
    if (row.kind === 'decision') {
      for (const id of row.issues || []) if (Number(id) > 0) decisions.add(Number(id));
    } else if (row.number != null && Number(row.number) > 0) {
      requests.add(Number(row.number));
    }
    for (const id of row.sessions || []) if (Number(id) > 0) sessions.add(Number(id));
  }
  return { requests: [...requests], sessions: [...sessions], decisions: [...decisions] };
}

/** The viewer's threads on one project, for All items' Yours filter. */
async function yoursOn(pool, { user, appId }) {
  const { rows } = await pool.query(YOURS_SQL, [user.id, appId]);
  return yoursOf(rows);
}

/**
 * The viewer's own requests, one track each (services/homeroom-bot-track.js:
 * its stored work state with what its card draws), newest moved first: what
 * a request's thread, a private thread's bar and the chat with the bot draw
 * (GET /api/ai/tracks). A project they can no longer view is left out,
 * whatever the records say. Never anybody else's: it takes only `user`.
 */
async function tracksFor(pool, { user, limit = 100, deps = {} }) {
  const rows = (await workState.forRequester(pool, user.id, { limit }))
    .filter((r) => r.kind === 'request' && r.issueNumber > 0);
  if (!rows.length) return { tracks: [] };
  const appIds = [...new Set(rows.map((r) => r.appId))];
  const { rows: apps } = await pool.query(
    `SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility, moderation_suspended_at,
            icon_image_id, icon_emoji
       FROM apps WHERE id = ANY($1::int[])`,
    [appIds],
  );
  const appAccess = deps.appAccess || require('./app-access');
  const track = deps.track || require('./homeroom-bot-track');
  const order = new Map(rows.map((r, i) => [`${r.appId}#${r.issueNumber}`, i]));
  const tracks = [];
  for (const app of apps) {
    if (!(await appAccess.checkAppAccess(pool, app, user, 'view'))) continue;
    const numbers = rows.filter((r) => r.appId === Number(app.id)).map((r) => r.issueNumber);
    const found = await track.tracksForRequests(pool, { appId: Number(app.id), numbers });
    for (const t of found.values()) {
      tracks.push({
        ...t,
        iconUrl: app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
        iconEmoji: app.icon_emoji || null,
      });
    }
  }
  tracks.sort((a, b) => (order.get(`${appIdOf(apps, a.appSlug)}#${a.issueNumber}`) ?? 0)
    - (order.get(`${appIdOf(apps, b.appSlug)}#${b.issueNumber}`) ?? 0));
  return { tracks };
}

const appIdOf = (apps, slug) => Number(apps.find((a) => a.slug === slug)?.id) || 0;

/**
 * The person's private threads with Homeroom bot, as the tab lists them,
 * each with how many of its messages are new to them (`unread`, by the
 * thread's own cursor: private-threads.js unreadFor). 14 Nov 2026: the tab's
 * badge is the sum over their threads that are not done (conversations.js
 * serializeConversation reads the same predicate), so opening a thread
 * clears its share of it.
 */
async function privateFor(pool, { user, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot !== undefined ? deps.bot : await dm.botAccount(pool);
  if (!bot) return [];
  const { rows } = await pool.query(PRIVATE_SQL, [user.id, bot.id, PRIVATE_MAX, LIVE_DAYS]);
  const privates = rows.map(shapePrivate);
  const unread = await (deps.privateThreads || require('./private-threads'))
    .unreadFor(pool, user.id, privates.map((p) => p.rootId));
  for (const p of privates) p.unread = unread.get(p.rootId) || 0;
  return privates;
}

/**
 * #6667: marks the thread rows where Homeroom bot made the change, its fix
 * was handed back to a person, and the viewer asked for its request, so
 * `standing` moves them to Needs you. Only the viewer's own requests with a
 * failing bot change are read (`changeBotFix`), a handful of queries at most.
 */
async function markBotHandedOff(pool, rows, viewerId, bot, states, deps = {}) {
  if (!bot || bot.id == null) return;
  const changeBotFix = deps.changeBotFix || require('./homeroom-bot-progress').changeBotFix;
  const candidates = (rows || []).filter((row) => {
    if (row.change_user == null || Number(row.change_user) !== Number(bot.id)) return false;
    if (row.change_status !== 'promoted' || row.needs_fix !== true) return false;
    const key = row.slug && row.number != null && row.request_id != null ? botKey(row.slug, row.number) : null;
    const state = (key && states?.get(key)) || (row.change_id && states?.get(`change:${Number(row.change_id)}`)) || null;
    return state?.requesterId != null && Number(state.requesterId) === Number(viewerId);
  });
  if (!candidates.length) return;
  await Promise.all(candidates.map(async (row) => {
    const fix = await Promise.resolve()
      .then(() => changeBotFix(pool, row.change_id))
      .catch(() => null);
    if (fix?.state === 'handed_off') row.bot_handed_off = true;
  }));
}

/**
 * Everything the AI tab's main view lists for `user` beside the Needs you
 * feed: { private, needs, next, waiting, live }.
 */
async function workFor(pool, { user, showSelfHosted = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot || await dm.botAccount(pool);
  const [{ rows: threadRows }, privates] = await Promise.all([
    pool.query(THREADS_SQL, [user.id, !!showSelfHosted, !!user.isAdmin, THREADS_MAX, LIVE_DAYS]),
    privateFor(pool, { user, deps: { ...deps, bot: bot || null } }),
  ]);
  const [states, viewers] = await Promise.all([statesFor(pool, threadRows), viewerFacts(pool, threadRows, user.id)]);
  await markBotHandedOff(pool, threadRows, user.id, bot, states, deps);
  const lists = arrange(threadRows, user.id, new Date(), bot ? bot.id : null, states, viewers);
  // #6262: how many messages in each listed thread are new to the viewer.
  const listed = [...lists.needs, ...lists.next, ...lists.waiting, ...lists.live];
  const unread = await (deps.threadReads || require('./thread-reads'))
    .unreadFor(pool, user.id, listed.map((t) => t.threadId));
  for (const t of listed) t.unread = unread.get(t.threadId) || 0;
  return {
    private: privates,
    ...lists,
  };
}

// ── The tab's lists, for Homeroom bot's answer (30 Oct 2026) ─────────────
//
// "Where do things stand?" asked in Main is answered from what the tab
// draws, so the answer and the page name the same items in the same lists:
// Needs you (the Needs you feed's cards for the threads they are in, then
// the bot's plans and the requests it handed back, then their private
// threads), In progress, Waiting and Live this week, each less what Needs
// you already holds (frontend/src/features/ai/model.ts needsYou, inProgress,
// upNext). The bot's answer before read its own record of each request's
// stage, which named closed requests the page left out and missed the
// votes, decisions and requests nobody had picked up that the page shows.

/** What a Needs you feed card waits for, in the words my_work hands the bot. */
const NEED_SAYS = Object.freeze({
  proposal: 'waits for their vote',
  governance: 'waits for their vote',
  ballot: 'waits for them to pick one of its changes',
  question: 'waits for their answer',
  bot_question: 'waits for their answer',
});

/**
 * Pure: one row's words, in the stage words every screen uses
 * (work-state.js says), with what is the viewer's own: their vote, who is
 * building it. `slotVotes` counts the votes they owe that free a held one's
 * slot.
 */
function threadSays(t, slotVotes = 0) {
  if (t.fixYours) {
    return t.botFixFailed
      ? 'Homeroom bot could not fix their own change'
      : 'their own change waits for their fix: its checks failed, its preview did not build, or it conflicts';
  }
  if (t.botFixFailed) return 'Homeroom bot could not fix the change it made for their request';
  const work = t.work || { stage: 'reading' };
  const yours = t.group === 'needs';
  let says = workState.says(work, { yours });
  if (work.stage === 'building' && !work.line && t.by) {
    says = t.by === 'bot' ? 'Building · Homeroom bot is building it' : t.by === 'you' ? 'Building · they are building it' : 'Building';
  }
  if (work.stage === 'up_for_vote' && t.myVote) says = `${says}; they voted ${t.myVote === 'yes' ? 'Yes' : 'No'}`;
  if (work.line?.code === 'held_waiting' && slotVotes) {
    says = `${says}; ${slotVotes === 1 ? 'a vote they owe' : `${slotVotes} votes they owe`} on Homeroom bot's changes can free its slot`;
  }
  return says;
}

/**
 * Pure (#6250): what Homeroom bot's answer says of a private thread, by where
 * it went. A filed or posted one names the request; a put-away draft says so;
 * an open one is not posted yet.
 */
function privateSays(p) {
  const n = Number(p?.resultRef);
  if (p?.state === 'filed' && n > 0) return `their private thread with Homeroom bot, filed as #${n}`;
  if (p?.state === 'posted' && n > 0) return `their private thread with Homeroom bot, posted on #${n}`;
  if (p?.state === 'dropped') return 'their private thread with Homeroom bot, put away';
  return 'their private thread with Homeroom bot, not posted yet';
}

/**
 * Pure: the tab's four lists from the Needs you feed (`needs`, its items)
 * and workFor's lists (`work`), as my_work hands them to the bot: each row
 * `{ project, projectName, number?, title, says }`. `botUsername` is
 * Homeroom bot's: its changes up for a vote hold its build slots.
 */
function listsOf(needs, work, { botUsername = null } = {}) {
  const items = Array.isArray(needs) ? needs : [];
  // A feed card names a change by its request, as the tab does (model.ts shownNumber).
  const needNumber = (item) => (item.kind === 'ballot' ? item.ballot?.number || item.number : item.number) || null;
  const shownNumber = (item) => (item.kind === 'proposal' && item.request?.number) || needNumber(item);
  // A thread the feed already lists, by its request or its change, kept
  // apart as model.ts keeps them (18 Nov 2026: on GitHub, PR 6792 is not
  // request #6792, and a vote owed on #6792's change hid PR 6792).
  const requestKey = (slug, n) => `${slug}#${Number(n)}`;
  const changeKey = (slug, n) => `${slug}#change:${Number(n)}`;
  const owed = new Set();
  for (const item of items) {
    if (!item.app) continue;
    const request = item.kind === 'ballot' ? item.ballot?.number
      : item.kind === 'proposal' ? item.request?.number
        : item.kind === 'question' ? item.number : null;
    const change = item.kind === 'proposal' || item.kind === 'ballot' ? item.number : null;
    if (request) owed.add(requestKey(item.app.slug, request));
    if (change) owed.add(changeKey(item.app.slug, change));
  }
  // A change's own thread is numbered by its change, never by a request.
  const threadRequest = (t) => (t.kind === 'change' ? null : t.number || null);
  const isOwed = (t) => {
    if (!t.app) return false;
    const request = threadRequest(t);
    const change = t.change?.number || (t.kind === 'change' ? t.number : null);
    return (!!request && owed.has(requestKey(t.app.slug, request)))
      || (!!change && owed.has(changeKey(t.app.slug, change)));
  };
  const row = (app, number, title, says) => ({
    project: app?.slug || null,
    projectName: app?.name || app?.slug || null,
    ...(number ? { number: Number(number) } : {}),
    title: title || null,
    says,
  });
  const bot = String(botUsername || '').toLowerCase();
  const slotVotes = (t) => (t.work?.line?.code === 'held_waiting' && t.app && bot
    ? items.filter((item) => item.kind === 'proposal' && item.app?.slug === t.app.slug
      && String(item.author || '').toLowerCase() === bot).length
    : 0);
  // #6153: a private thread filed as a request whose request has a row is that row.
  const listed = new Set(owed);
  for (const t of [...(work?.needs || []), ...(work?.next || []), ...(work?.waiting || []), ...(work?.live || [])]) {
    const request = threadRequest(t);
    if (t.app && request) listed.add(requestKey(t.app.slug, request));
  }
  const privates = unfiledPrivate(work?.private, listed);
  // #6271: a private thread marked done this week is Live this week's, under
  // its project (Only you when it has none), unless its filed request
  // already has a row of its own: that row stays the one row.
  const closed = (work?.private || []).filter((p) => p.state === 'done'
    && !(p.app && Number(p.resultRef) > 0 && listed.has(`${p.app.slug}#${Number(p.resultRef)}`)));
  const lists = {
    needsYou: [
      ...items.map((item) => row(item.app, shownNumber(item), (item.kind === 'ballot' && item.ballot?.title) || item.title,
        NEED_SAYS[item.kind] || 'waits for them')),
      ...(work?.needs || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title, threadSays(t))),
      ...privates.map((p) => row(p.app, null, p.title, privateSays(p))),
    ],
    inProgress: (work?.next || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title, threadSays(t))),
    waiting: (work?.waiting || []).filter((t) => !isOwed(t)).map((t) => row(t.app, t.number, t.title, threadSays(t, slotVotes(t)))),
    liveThisWeek: [
      ...(work?.live || []).map((t) => row(t.app, t.number, t.title, 'Live')),
      ...closed.map((p) => row(p.app, null, p.title, 'closed: their private thread, marked done')),
    ],
  };
  // The tab's headings count Needs you's rows that ask something (a private
  // thread asks nothing), and every row of the others.
  return {
    ...lists,
    counts: {
      needsYou: lists.needsYou.length - privates.length,
      inProgress: lists.inProgress.length,
      waiting: lists.waiting.length,
      liveThisWeek: lists.liveThisWeek.length,
    },
  };
}

/**
 * The Homeroom bot tab's lists for `user`, as listsOf words them: what
 * Homeroom bot's my_work answers "where do things stand?" from. Reads the
 * Needs you feed for the threads they are in and workFor, as the tab does.
 */
async function pageLists(pool, { user, showSelfHosted = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot !== undefined ? deps.bot : await dm.botAccount(pool);
  const feed = deps.needsFeedFor || require('../routes/workshop-overview').needsFeedFor;
  const [needs, work] = await Promise.all([
    feed(pool, { user, showSelfHosted, inThreads: true }),
    workFor(pool, { user, showSelfHosted, deps: { ...deps, bot } }),
  ]);
  return listsOf(needs, work, { botUsername: bot?.username || null });
}

module.exports = {
  // Shared with services/ai-history.js, which reads the same threads once they are finished.
  appOf,
  hrefOf,
  firstLine,
  VISIBLE_APP_WHERE,
  CLAIM_DAYS,
  THREADS_SQL,
  YOURS_SQL,
  yoursOf,
  yoursOn,
  PRIVATE_SQL,
  // Spelled out, not shorthand: scripts/check-sql.js follows it into ai-history.js.
  ABOUT_CHANGE_END_SQL: ABOUT_CHANGE_END_SQL,
  VIEWER_SQL,
  threadsInSql,
  THREADS_MAX,
  PRIVATE_MAX,
  LIVE_DAYS,
  standing,
  arrange,
  shapePrivate,
  filedKey,
  unfiledPrivate,
  statesFor,
  viewerFacts,
  tracksFor,
  privateFor,
  workFor,
  threadSays,
  listsOf,
  pageLists,
};
