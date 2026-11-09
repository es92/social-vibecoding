'use strict';

// The Workshop screen's two numbers per app, and the rows behind them.
//
//   GET /api/workshop/counts
//        → { counts: { '<slug>': { working, needs, owed, unchosen? }, … } }
//   GET /api/workshop/items   (#3051, see ITEMS_SQL below)
//        → { items: { '<slug>': { working: Item[], needs: Item[] }, … } }
//
// The top-level Workshop screen (frontend/src/features/workshop/) lists the
// viewer's apps and, on each row, says how much of the app's own Workshop
// page is addressed to them: how many items its "What you are working on"
// strip holds, and how many its "Needs you" queue does. Both numbers are
// per-viewer, both come from Postgres, and one query answers for every app at
// once — the alternative is the board's own eight-request load per app, which
// at forty apps is not a page load.
//
// ── The two definitions, and where they come from ──────────────────────
//
// They are not invented here. They are the same populations the per-app
// lander builds in `AppView._workshopView()` (public/js/app-view.js), read
// back out of the tables the board's endpoints read:
//
//   WORKING — the viewer's own work in flight.
//     · their dev sessions, `active` or `paused`, non-headless: the rows
//       GET /api/me/active-sessions returns and the board keeps as
//       `_mySessions` (its `my-session` entries in the Underway lane).
//     · their proposals in review, `promoted` or `merging`: the
//       GET /api/apps/:slug/promoted rows whose `user_id` is theirs — plus,
//       since #4538, the ones Homeroom bot built from a request made for
//       them (botRequestedBySql, MY_PROPOSALS_WHERE below). They still owe
//       their vote on such a change, so NEEDS counts it too.
//     · their open governance proposals: the GET /api/apps/:slug/issues
//       rows whose `created_by` is theirs.
//     The three statuses are disjoint, so nothing is counted twice.
//
//   NEEDS — the votes they owe. `promoted` proposals that are not theirs and
//     that they have not voted on under the proposal's current approval epoch
//     (services/pr-vote-revision.js owns that predicate), plus open
//     governance proposals that are not theirs and carry no vote of theirs.
//     Exactly the deck's `owed` half.
//
// What NEEDS deliberately leaves out is the tail of that deck: the unclaimed
// open GitHub issues it offers after the votes. Those are not in Postgres —
// they come from services/github.js's five-minute per-repo cache — so
// counting them here would mean a GitHub round trip per app on a cold cache,
// for every app the viewer has. The screen's column header says "votes" for
// that reason rather than claiming the whole deck.
//
// And "governance proposals" in both definitions means the five kinds in
// services/governance-kinds.js, never every open row in `issues`. The table
// also holds a `general` TWIN row per request filed through the platform:
// the request board's own rows, which the deck excludes and which the
// paragraph above says this endpoint excludes too. Counting them is what
// made this screen report forty-six votes waiting on an app whose board had
// three open requests — a twin was only ever closed by a passed close-issue
// vote, so it outlived its GitHub issue by however long that issue had been
// closed (merges close it now; a close by hand on GitHub still does not).
// Both `issues` CTEs below carry governanceKindsSql for that reason,
// and tests/workshop-screen.test.js pins it there.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// Every app the viewer may SEE, under the same visibility filter as
// GET /api/apps: self-hosted rows are admin-only, and a view-private app is
// absent unless they are a member. Which of those are the viewer's
// communities is not decided here — that is `Home.isJoined` over the
// `is_member` flag GET /api/apps serves (services/communities.js), one answer
// the platform already has, and the screen composes these counts onto the
// rows it gets from /api/apps rather than this endpoint growing a second
// copy of it. Apps with nothing on either number are omitted; the client
// reads a missing slug as two zeroes.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { currentVotePredicateSql, countedVotePredicateSql, visualHeadForSession } = require('../services/pr-vote-revision');
const diagramContract = require('../services/diagram');
const proposalTouches = require('../services/proposal-touches');
const visualsService = require('../services/visuals');
const shotsView = require('../services/shots-view');
const { botRequestedBySql } = require('../services/bot-requested-by');
const { firstVersionSql } = require('../services/first-version-rule');
const { governanceKindsSql } = require('../services/governance-kinds');
const { threadsInSql } = require('../services/ai-work');
const { updateComingSql } = require('../services/homeroom-bot-progress');
const { voteReadySql, awaitingYesSql } = require('../services/vote-ready');
const communities = require('../services/communities');
const governance = require('../services/governance');
const codeMissing = require('../services/code-missing');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Staging-only mock counts for ?demo=1, the sibling of stagingMockIssues /
// stagingMockProposals in the board's own endpoints.
//
// `chat_sessions` is `staging:private`, so a prod-cloned staging database
// holds no sessions and no proposals at all: every row of this screen would
// read 0 / 0, and the one thing the screen exists to show would be
// unreviewable — in the preview AND in the before/after screenshots the group
// votes on.
//
// Keyed to the demo APP rows GET /api/apps injects under the same flag
// (`demoIconApps` in src/routes/apps.js), so the numbers are deterministic and
// a declared check can assert them. Three of them are the viewer's
// communities under ?demo=1 — `staging-demo-your-app` (a Community),
// `staging-demo-long-name` (a Group) and `staging-demo-emoji-icon` (Just
// you), one per Workshop section — and the fourth is named anyway, so a
// preview where it has been joined shows numbers rather than two zeroes.
// Display-only: nothing in the platform reads these back, and strictly a
// no-op in production.
const DEMO_COUNTS = {
  // `owed` names DEMO_NEEDS_FEED's cards, below, so a vote swiped past in
  // the demo feed takes its count off the row, as a real one does (#3526).
  'staging-demo-your-app': {
    working: 2, needs: 3, owed: ['proposal:-103@0', 'proposal:-104@0', 'governance:-105'],
  },
  // #4313: its one demo card, the Just-you change that asks for approval.
  'staging-demo-emoji-icon': { working: 0, needs: 5, owed: ['proposal:-106@0'] },
  'staging-demo-image-icon': { working: 1, needs: 0 },
  'staging-demo-long-name': { working: 4, needs: 1 },
};

// ── The five populations, spelled ONCE ────────────────────────────────
//
// Each is the WHERE body of a query over its own table, and both queries in
// this file read them: COUNTS_SQL counts them per app, ITEMS_SQL (#3051)
// lists the rows behind those counts for the all-apps Workshop's two tabs. A
// second copy of any of these predicates would be a number on a row that
// stopped agreeing with the list under the tab beside it.
//
// `$1` is the viewer. Every predicate names it explicitly, so an anonymous
// caller (NULL) would make `IS DISTINCT FROM` true for every row and count
// the whole platform's promoted proposals as owed, which is why both routes
// below refuse one outright rather than relying on the SQL to degrade.
const MY_SESSIONS_WHERE = `cs.user_id = $1
       AND cs.status IN ('active', 'paused')
       AND cs.is_headless = FALSE`;

// #4538: a change Homeroom bot built from a request made for the viewer is
// that viewer's work in flight too, even though `cs.user_id` is the bot's —
// they asked for it and they are waiting on it. The bot-request predicate is
// the shared fragment (services/bot-requested-by.js), the same one the
// /promoted payload reads, so the strip and the counts cannot disagree.
// OWED_PROPOSALS_WHERE is unchanged: the bot's change still counts as a vote
// owed (the bot is not the viewer, and the viewer may still vote on it).
const MY_PROPOSALS_WHERE = `(cs.user_id = $1
       OR ${botRequestedBySql('cs', '$1')})
       AND cs.status IN ('promoted', 'merging')`;

const MY_GOVERNANCE_WHERE = `i.status = 'open'
       AND ${governanceKindsSql('i')}
       AND i.created_by = $1`;

// 13 Oct 2026, D1: a project's first version is owed by nobody. It goes
// live without a vote once it passes its checks (services/first-version-
// rule.js), so it is no decision of anyone's to count or to list.
// #6019: a BALLOT is changes up for a vote that would close the same request
// (their linked_issues overlap: being in one thread is not enough, and a
// change that closes nothing is never a rival, services/threads.js
// closeRivals), and an open vote to close filed on a request one of them
// closes. One vote between them on the request's page
// (frontend/src/features/dev-board/topic/thread-changes.tsx), so ONE thing
// owed, not one per change. It is owed by a member who has not voted on any
// of it and proposed none of it (proposing is a pick), and it is carried by
// its oldest change's row; the close vote in it is not owed on its own.
// Every count and list below reads these same predicates, so they agree on
// what a ballot is.
const RIVAL_SQL = (a, b) => `${b}.thread_id = ${a}.thread_id AND ${b}.app_id = ${a}.app_id
         AND ${b}.status = 'promoted' AND ${b}.is_headless = FALSE AND ${b}.id <> ${a}.id
         AND ${b}.linked_issues && ${a}.linked_issues`;
const CLOSE_TARGET_SQL = (i) => `(CASE WHEN (${i}.payload->>'issueNumber') ~ '^[0-9]{1,9}$'
         THEN (${i}.payload->>'issueNumber')::int END)`;
const RIVAL_CLOSE_SQL = (cs, i) => `${i}.thread_id = ${cs}.thread_id AND ${i}.app_id = ${cs}.app_id
         AND ${i}.kind = 'close_issue' AND ${i}.status = 'open'
         AND ${CLOSE_TARGET_SQL(i)} = ANY(${cs}.linked_issues)`;
const BALLOT_THREAD_SQL = (cs) => `${cs}.thread_id IS NOT NULL AND cardinality(${cs}.linked_issues) > 0 AND (
         EXISTS (SELECT 1 FROM chat_sessions rb WHERE ${RIVAL_SQL(cs, 'rb')})
      OR EXISTS (SELECT 1 FROM issues cb WHERE ${RIVAL_CLOSE_SQL(cs, 'cb')}))`;

// A change is owed by everyone but its author, and by its author too when a
// coding agent submitted it for them (`external_agent`): proposing that way
// is not their yes, and their tap is (governance-rules.ts). Nor is it their
// pick on a ballot.
const OWED_PROPOSALS_WHERE = `cs.status = 'promoted'
       AND (cs.user_id IS DISTINCT FROM $1 OR cs.external_agent IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM pr_votes pv
          WHERE pv.session_id = cs.id
            AND pv.user_id = $1
            AND ${currentVotePredicateSql('pv', 'cs')}
       )
       AND NOT ${firstVersionSql('cs')}
       -- #6282 (4 Nov 2026): a change with an update on its way asks for no
       -- vote. A yes cast now is cleared when the update lands and Homeroom
       -- asks again, so it waits under Updating / Update queued instead
       -- (services/homeroom-bot-progress.js updateComingSql, which the AI tab
       -- and the change's own Votes card read too). A ballot goes with it
       -- while any of its changes has an update coming, so nobody picks a
       -- change that is about to change.
       AND ${updateComingSql('cs')} IS NULL
       -- #6402 (6 Nov 2026): a vote is asked only once the change is ready:
       -- its checks passed (or it had nothing to test) and it merges cleanly
       -- with main. Until then it waits under Waiting & in progress, worded
       -- by services/work-state.js. Voting early stays possible on the
       -- change's own page.
       AND ${voteReadySql('cs')}
       AND NOT (${BALLOT_THREAD_SQL('cs')} AND EXISTS (
             SELECT 1 FROM chat_sessions ru
              WHERE ${RIVAL_SQL('cs', 'ru')}
                AND ${updateComingSql('ru')} IS NOT NULL))
       -- A ballot waits too while any of its changes is not ready, so nobody
       -- picks between changes that are still being checked.
       AND NOT (${BALLOT_THREAD_SQL('cs')} AND EXISTS (
             SELECT 1 FROM chat_sessions rr
              WHERE ${RIVAL_SQL('cs', 'rr')}
                AND NOT ${voteReadySql('rr')}))
       AND NOT (${BALLOT_THREAD_SQL('cs')} AND (
             EXISTS (SELECT 1 FROM chat_sessions rv
                      WHERE ${RIVAL_SQL('cs', 'rv')}
                        AND (rv.id < cs.id OR (rv.user_id = $1 AND rv.external_agent IS NULL)
                             OR EXISTS (SELECT 1 FROM pr_votes pb
                                         WHERE pb.session_id = rv.id AND pb.user_id = $1
                                           AND ${currentVotePredicateSql('pb', 'rv')})))
          OR EXISTS (SELECT 1 FROM issues cv
                      WHERE ${RIVAL_CLOSE_SQL('cs', 'cv')}
                        AND (cv.created_by = $1
                             OR EXISTS (SELECT 1 FROM issue_votes ib WHERE ib.issue_id = cv.id AND ib.user_id = $1)))))`;

const OWED_GOVERNANCE_WHERE = `i.status = 'open'
       AND ${governanceKindsSql('i')}
       AND i.created_by IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM issue_votes iv
          WHERE iv.issue_id = i.id AND iv.user_id = $1
       )
       AND NOT (i.kind = 'close_issue' AND i.thread_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM chat_sessions rc
          WHERE rc.thread_id = i.thread_id AND rc.app_id = i.app_id
            AND rc.status = 'promoted' AND rc.is_headless = FALSE
            AND ${CLOSE_TARGET_SQL('i')} = ANY(rc.linked_issues)))`;

// #6019: the questions Homeroom bot asked the viewer about their requests,
// still open: something owed like a vote, in the same counts and the same
// feed. A question is answered on its request's page, where the bot asked it.
// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): one the bot asked as its
// post on the request, where the request's stored work state waits for its
// requester's answer (services/work-state.js), by that post's message; and
// one asked in their chat with the bot before then, still open there
// (homeroom_bot_dm_messages), by its message. `$1` is the viewer.
const OWED_QUESTIONS_FROM = `(
      SELECT dq.app_id, dq.message_id AS id, dq.issue_number, dq.created_at,
             COALESCE(dqm.metadata->'homeroomBot'->>'question', '') AS question, dqm.sender_id
        FROM homeroom_bot_dm_messages dq
        JOIN conversation_messages dqm ON dqm.id = dq.message_id AND dqm.deleted_at IS NULL
       WHERE dq.user_id = $1 AND dq.question_status = 'open'
      UNION ALL
      SELECT ws.app_id, qp.thread_message_id AS id, ws.item_ref AS issue_number, COALESCE(ws.since, qp.created_at) AS created_at,
             COALESCE(qpm.content, '') AS question, qpm.user_id AS sender_id
        FROM work_states ws
        JOIN LATERAL (
          SELECT p.thread_message_id, p.created_at FROM homeroom_bot_posts p
           WHERE p.app_id = ws.app_id AND p.issue_number = ws.item_ref AND p.kind = 'question'
             AND p.thread_message_id IS NOT NULL
           ORDER BY p.id DESC LIMIT 1
        ) qp ON TRUE
        JOIN chat_messages qpm ON qpm.id = qp.thread_message_id AND qpm.deleted_at IS NULL
       WHERE ws.requester_id = $1 AND ws.item_kind = 'request'
         AND ws.stage = 'waiting_for_you' AND ws.why = 'question'
         AND NOT EXISTS (SELECT 1 FROM homeroom_bot_dm_messages odq
                          WHERE odq.user_id = $1 AND odq.app_id = ws.app_id AND odq.issue_number = ws.item_ref
                            AND odq.question_status = 'open')
    ) q`;
const OWED_QUESTIONS_WHERE = `TRUE`;

// GET /api/apps's visibility filter, over `a` (apps) and `me` (the viewer's
// membership row). `$2` is "may see self-hosted rows", `$3` "is an admin".
// A suspended app is left out for everyone, admins included: it refuses to
// open (checkAppAccess), so a row for it would lead nowhere.
const VISIBLE_APP_WHERE = `a.moderation_suspended_at IS NULL
     AND (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// Counts for every app the viewer can see that has a non-zero one.
//
// Four aggregates rather than one scan with four FILTERs: `issues` and
// `chat_sessions` are different tables, and the two owed counts each need
// their own NOT EXISTS. Each CTE groups by app_id, so the join at the bottom
// is over at most one row per app per source.
//
// `owed` (#3526) names the votes `needs` counts, in the keys the client's
// Needs you record uses (frontend/src/features/workshop/needs-seen.ts): a
// change as `proposal:<id>@<approval epoch>`, a group decision as
// `governance:<id>`. A vote swiped past in a Needs you feed is remembered on
// the viewer's device, and every badge leaves it out; with only a number
// the badges could not tell a vote seen from a new one that took its place,
// and would have taken the new one off. The epoch is in the key because it
// is what moves when a change is rewritten, which is when a vote seen
// before counts again (as a vote cast before stops counting).
const COUNTS_SQL = `
  WITH my_sessions AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE ${MY_SESSIONS_WHERE}
     GROUP BY cs.app_id
  ),
  my_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE ${MY_PROPOSALS_WHERE}
     GROUP BY cs.app_id
  ),
  my_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n
      FROM issues i
     WHERE ${MY_GOVERNANCE_WHERE}
     GROUP BY i.app_id
  ),
  owed_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n,
           array_agg('proposal:' || cs.id || '@' || cs.approval_epoch) AS keys
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
     GROUP BY cs.app_id
  ),
  owed_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n,
           array_agg('governance:' || i.id) AS keys
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
     GROUP BY i.app_id
  ),
  owed_questions AS (
    SELECT q.app_id, COUNT(*)::int AS n,
           array_agg('question:' || q.id) AS keys
      FROM ${OWED_QUESTIONS_FROM}
     WHERE ${OWED_QUESTIONS_WHERE}
     GROUP BY q.app_id
  )
  SELECT a.slug,
         (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)) AS working,
         (COALESCE(op.n, 0) + COALESCE(og.n, 0) + COALESCE(oq.n, 0)) AS needs,
         (COALESCE(op.keys, '{}'::text[]) || COALESCE(og.keys, '{}'::text[]) || COALESCE(oq.keys, '{}'::text[])) AS owed
    FROM apps a
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
    LEFT JOIN my_sessions     ms ON ms.app_id = a.id
    LEFT JOIN my_proposals    mp ON mp.app_id = a.id
    LEFT JOIN my_governance   mg ON mg.app_id = a.id
    LEFT JOIN owed_proposals  op ON op.app_id = a.id
    LEFT JOIN owed_governance og ON og.app_id = a.id
    LEFT JOIN owed_questions  oq ON oq.app_id = a.id
   WHERE ${VISIBLE_APP_WHERE}
     AND (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)
          + COALESCE(op.n, 0) + COALESCE(og.n, 0) + COALESCE(oq.n, 0)) > 0
`;

// ── The rows behind the counts (#3051) ─────────────────────────────────
//
//   GET /api/workshop/items
//        → { items: { '<slug>': { working: Item[], needs: Item[] } } }
//   Item = { kind: 'session'|'proposal'|'governance', id, title, status, at }
//
// The all-apps Workshop's two tabs, Current status and Needs you, list these
// grouped by app. The SAME five populations as COUNTS_SQL, read through the
// same predicates above, so a row's two numbers and the list under the tab
// beside it cannot disagree about what is counted.
//
// BOUNDED twice. At most ITEMS_PER_APP rows per app per section (newest
// first), because the tab is a digest that sends you into the app's own
// Workshop for the rest, and at most ITEMS_TOTAL rows in all, so an account
// on a hundred busy apps is still one small response. The client knows each
// app's full count from /api/workshop/counts and says how many were left out.
const ITEMS_PER_APP = 5;
const ITEMS_TOTAL = 300;

const ITEMS_SQL = `
  WITH items AS (
    SELECT 'working'::text AS section, 'session'::text AS kind, cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''),
                    NULLIF(cs.session_title, ''))::text AS title,
           cs.status::text AS status, cs.last_activity_at AS at
      FROM chat_sessions cs
     WHERE ${MY_SESSIONS_WHERE}
    UNION ALL
    SELECT 'working', 'proposal', cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''), NULLIF(cs.session_title, ''))::text,
           cs.status::text, cs.last_activity_at
      FROM chat_sessions cs
     WHERE ${MY_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'working', 'governance', i.app_id, i.id, i.title::text, i.kind::text, i.created_at
      FROM issues i
     WHERE ${MY_GOVERNANCE_WHERE}
    UNION ALL
    SELECT 'needs', 'proposal', cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''), NULLIF(cs.session_title, ''))::text,
           cs.status::text, cs.last_activity_at
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'needs', 'governance', i.app_id, i.id, i.title::text, i.kind::text, i.created_at
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
    UNION ALL
    SELECT 'needs', 'question', q.app_id, q.id,
           q.question::text, 'open'::text, q.created_at
      FROM ${OWED_QUESTIONS_FROM}
     WHERE ${OWED_QUESTIONS_WHERE}
  ),
  ranked AS (
    SELECT it.*,
           ROW_NUMBER() OVER (
             PARTITION BY it.app_id, it.section
             ORDER BY it.at DESC NULLS LAST, it.id DESC
           ) AS rn
      FROM items it
  )
  SELECT a.slug, r.section, r.kind, r.id, r.title, r.status, r.at
    FROM ranked r
    JOIN apps a ON a.id = r.app_id
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE r.rn <= $4
     AND ${VISIBLE_APP_WHERE}
   ORDER BY r.rn, a.slug, r.section
   LIMIT $5
`;

// GET /api/workshop/bot-questions (#6019): the bot's open questions to the
// viewer (OWED_QUESTIONS_FROM), on projects that are not suspended.
const BOT_QUESTIONS_MAX = 20;
const BOT_QUESTIONS_SQL = `
  SELECT q.id AS message_id, q.issue_number, q.created_at, a.slug, a.name, q.question
    FROM ${OWED_QUESTIONS_FROM}
    JOIN apps a ON a.id = q.app_id AND a.moderation_suspended_at IS NULL
   ORDER BY q.created_at DESC
   LIMIT $2
`;

// GET /api/workshop/needs-feed (#3270)
//      → { items: FeedItem[] }
//   FeedItem = { kind: 'proposal'|'governance', id, title, summary, author,
//                number, epoch, at, yes, no, approve?, advisory?, uncounted?,
//                request? (a proposal's request: { number, title }; requestOf),
//                staging_url (a proposal's live preview or null; feedStagingUrl),
//                app: { slug, name, icon_url, icon_emoji } }
//
// The Communities screen's Needs you tab as ONE FEED: every decision owed by
// the viewer, across all the projects they are a member of, newest first and
// mixed together rather than grouped under each project, so the tab reads
// like a project's own Needs you page (one decision per screen) instead of a
// list of lists. The SAME owed predicates as the counts and ITEMS_SQL above,
// so the number on a row and the feed agree; narrowed to MEMBER projects,
// because a vote is a member's (communities.requireSessionMembership) and a
// feed of cards the viewer could not answer would be a feed of Join prompts.
//
// What a card needs to be decided from its own screen: the words (the
// proposal's summary, or a group decision's description), who asked, the
// tally so far, and the approval epoch a vote must carry (#2038). Bounded to
// NEEDS_FEED_MAX; the tab says so when it stops there.
//
// And whether it is approved rather than voted on (#4270, B7): `approve` on a
// change on a project that is just the viewer's whose Yes is the one it
// needs, so the feed says Approve / Don't approve where its card does. The
// query says which rows are on such a project (`solo`: the audience is
// 'solo' and the viewer's vote counts there); withVotesRequired works out
// how many Yes votes those need; approvedAlone decides.
//
// And whether the viewer's vote can affect the outcome at all (#5365). A
// change on a project whose deciders do not include the viewer — a
// non-approver on an approver project, someone outside every group a
// project's rules name (governance.viewerDecides, the same rule /promoted
// marks its cards with) — rides as `advisory: true`; a vote recorded but
// not counted (a test account's, counts_toward_outcome) as `uncounted:
// true`. withViewerDecides marks the rows and decidingFirst puts the rows
// whose vote decides first, so a viewer who only wants to vote where it
// matters can stop when the marked cards begin.
//
// The words are the Description sheet's as well since #3488 (the feed is a
// project's own NeedsFeed now, which renders them in full there), so they
// are cut at NEEDS_FEED_SUMMARY_MAX rather than at a card's length. A
// summary is a few paragraphs; the cap is for the one that is not.
//
// `?in=threads` is the Homeroom bot tab's Needs you (29 Oct 2026,
// NEEDS_FEED_IN_THREADS_SQL): only the decisions in threads the viewer is in
// (services/ai-work.js threadsInSql: they asked for it, built a change in
// it, voted in it, wrote in it, or chose Notify me) and has not muted, and
// the bot's questions to them, which are theirs wherever they are. Without
// it, every decision owed, as Communities › Needs you lists them.
const NEEDS_FEED_MAX = 60;
const NEEDS_FEED_SUMMARY_MAX = 2000;

const IN_THREADS_WHERE = `
     AND (o.kind = 'question'
          OR (o.thread_id IN (SELECT mine.thread_id FROM (${threadsInSql('$1')}) mine)
              AND NOT EXISTS (SELECT 1 FROM thread_followers f
                               WHERE f.thread_id = o.thread_id AND f.user_id = $1 AND f.muted_at IS NOT NULL)))`;

const needsFeedSql = ({ inThreads = false } = {}) => `
  WITH owed AS (
    SELECT 'proposal'::text AS kind, cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.proposed_pr_title, ''), NULLIF(cs.session_title, ''))::text AS title,
           LEFT(COALESCE(cs.pr_summary_md, ''), ${NEEDS_FEED_SUMMARY_MAX})::text AS summary,
           u.username::text AS author,
           cs.pr_number AS number,
           cs.approval_epoch AS epoch,
           -- #6245: when its vote opened, never the latest activity (a page
           -- read or a preview waking touched that), so a row keeps its
           -- place in Needs you while it waits. Old rows with no
           -- promoted_at fall back to when the change was made.
           COALESCE(cs.promoted_at, cs.created_at) AS at,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${countedVotePredicateSql('pv', 'cs')})::int AS yes,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${countedVotePredicateSql('pv', 'cs')})::int AS no,
           -- #6389: the facts a row the viewer made through a coding agent
           -- needs to say what it waits on instead of Vote: who its author
           -- is, which tool made it, and whether its checks fail or it
           -- conflicts with main. other_yes is the Yes votes from anyone
           -- but its author, which an explicit approval needs one of.
           cs.user_id AS author_id,
           cs.external_agent::text AS external_agent,
           cs.check_state::text AS check_state,
           cs.mergeability::text AS mergeability,
           cs.integration_merges_clean,
           -- #6531: a conflicting change only a yes can move says so on its
           -- Vote row ("Conflicts with main: Homeroom resolves it once you
           -- approve"), exactly as the bot tab does.
           ${awaitingYesSql('cs')} AS conflict_on_yes,
           cs.merge_conflict_state::text AS merge_conflict_state,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${countedVotePredicateSql('pv', 'cs')}
               AND pv.user_id IS DISTINCT FROM cs.user_id)::int AS other_yes,
           -- #4490: the card's picture, as a project's Needs you draws it:
           -- the shots run and the heads its serializer checks, the legacy
           -- capture pair, the author's diagram and "What it touches".
           cs.shots_run_id::text AS shots_run_id, cs.shots_detail, cs.status::text AS status,
           cs.source::text AS source, cs.imported_pr_head_sha::text AS imported_pr_head_sha,
           cs.reviewed_head_sha::text AS reviewed_head_sha, cs.checks_commit_sha::text AS checks_commit_sha,
           cs.handoff_head_sha::text AS handoff_head_sha,
           cs.pr_diagram, cs.pr_diagram_source, cs.pr_touches, cs.pr_touches_sha,
           (SELECT jsonb_object_agg(
                     sv.kind || '_' || sv.capture_index || '_' || sv.media,
                     jsonb_build_object(
                       'id', sv.id, 'path', sv.captured_path, 'viewport', sv.captured_viewport,
                       'commit', sv.commit_hash, 'scenarioId', sv.scenario_id,
                       'scenarioFingerprint', sv.scenario_fingerprint, 'fellBack', sv.before_fell_back))
              FROM session_visuals sv WHERE sv.session_id = cs.id) AS visuals_agg,
           NULL::text AS decision_kind, NULL::jsonb AS decision_payload,
           -- #5365: whether the change waits on an explicit approval (who
           -- decides), which withViewerDecides reads through viewerDecides
           -- exactly as /promoted marks its rows.
           cs.requires_explicit_approval, cs.explicit_approval_reason::text,
           -- The change's live preview, for "Try it" across projects: the
           -- column /promoted hands a project's own card.
           cs.staging_url::text AS staging_url,
           -- #6019: its thread and the requests it closes, for a ballot's
           -- choices below.
           cs.thread_id, cs.linked_issues
      FROM chat_sessions cs
      LEFT JOIN users u ON u.id = cs.user_id
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'governance', i.app_id, i.id, i.title::text,
           LEFT(COALESCE(i.description, ''), ${NEEDS_FEED_SUMMARY_MAX})::text,
           u.username::text, NULL::int, NULL::int, i.created_at,
           NULL::int, NULL::int,
           NULL::int, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::text, NULL::int,
           NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::text, NULL::jsonb, NULL::text, NULL::jsonb,
           i.kind::text, i.payload,
           NULL::boolean AS requires_explicit_approval, NULL::text AS explicit_approval_reason,
           NULL::text AS staging_url, i.thread_id, NULL::int[] AS linked_issues
      FROM issues i
      LEFT JOIN users u ON u.id = i.created_by
     WHERE ${OWED_GOVERNANCE_WHERE}
    UNION ALL
    -- #6019: the bot's open questions to the viewer, by their request.
    SELECT 'question', q.app_id, q.id,
           q.question::text, NULL::text,
           qu.username::text, q.issue_number, NULL::int, q.created_at,
           NULL::int, NULL::int,
           NULL::int, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::text, NULL::int,
           NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::text, NULL::jsonb, NULL::text, NULL::jsonb,
           NULL::text, NULL::jsonb,
           NULL::boolean, NULL::text, NULL::text,
           -- #6262: the bot's question belongs to its request's thread, so
           -- the Homeroom bot page can count what is new there.
           (SELECT r.thread_id FROM requests r
             WHERE r.app_id = q.app_id AND r.number = q.issue_number),
           NULL::int[]
      FROM ${OWED_QUESTIONS_FROM}
      LEFT JOIN users qu ON qu.id = q.sender_id
     WHERE ${OWED_QUESTIONS_WHERE}
  )
  SELECT a.id AS app_id, a.slug, a.name, a.icon_image_id, a.icon_emoji,
         o.kind, o.id, o.title, o.summary, o.author, o.number, o.epoch,
         o.at, o.yes, o.no, a.repo_url,
         o.author_id, o.external_agent, o.check_state, o.mergeability,
         o.integration_merges_clean, o.conflict_on_yes, o.merge_conflict_state, o.other_yes,
         o.shots_run_id, o.shots_detail, o.status, o.source, o.imported_pr_head_sha,
         o.reviewed_head_sha, o.checks_commit_sha, o.handoff_head_sha,
         o.pr_diagram, o.pr_diagram_source, o.pr_touches, o.pr_touches_sha, o.visuals_agg,
         o.decision_kind, o.decision_payload,
         o.requires_explicit_approval, o.explicit_approval_reason, o.staging_url,
         -- #6019: a ballot's choices, on the row of its oldest change (the
         -- one OWED_PROPOSALS_WHERE keeps): it and every change up for a vote
         -- that closes a request it closes, the open vote to close filed on
         -- one of those, and the first such request, which it is for.
         CASE WHEN o.kind = 'proposal' AND o.thread_id IS NOT NULL AND cardinality(o.linked_issues) > 0 THEN (
           SELECT jsonb_agg(jsonb_build_object(
                    'id', rb.id, 'number', rb.pr_number,
                    'title', COALESCE(NULLIF(rb.pr_title, ''), NULLIF(rb.proposed_pr_title, ''), NULLIF(rb.session_title, '')),
                    'author', ru.username, 'epoch', rb.approval_epoch, 'staging_url', rb.staging_url)
                  ORDER BY rb.id)
             FROM chat_sessions rb LEFT JOIN users ru ON ru.id = rb.user_id
            WHERE rb.thread_id = o.thread_id AND rb.app_id = o.app_id
              AND rb.status = 'promoted' AND rb.is_headless = FALSE
              AND (rb.id = o.id OR rb.linked_issues && o.linked_issues)) END AS ballot_options,
         CASE WHEN o.kind = 'proposal' AND o.thread_id IS NOT NULL AND cardinality(o.linked_issues) > 0 THEN (
           SELECT jsonb_build_object('id', cb.id, 'title', cb.title,
                    'reason', NULLIF(cb.payload->>'reason', ''), 'author', cu.username)
             FROM issues cb LEFT JOIN users cu ON cu.id = cb.created_by
            WHERE cb.thread_id = o.thread_id AND cb.app_id = o.app_id
              AND cb.kind = 'close_issue' AND cb.status = 'open'
              AND ${CLOSE_TARGET_SQL('cb')} = ANY(o.linked_issues)
            ORDER BY cb.id LIMIT 1) END AS ballot_close,
         CASE WHEN o.kind = 'proposal' AND cardinality(o.linked_issues) > 0 THEN (
           SELECT jsonb_build_object('number', r.number, 'title', r.title)
             FROM requests r
            WHERE r.app_id = o.app_id AND r.number = ANY(o.linked_issues)
            ORDER BY r.number LIMIT 1) END AS ballot_for,
         -- #5365: whether this viewer's vote is counted at all (a test
         -- account's is not) — the identity/app-access half of the question;
         -- viewerDecides below covers the approver-and-rules half.
         counts_toward_outcome($1, a.id) AS counts,
         (o.kind = 'proposal'
           AND (${communities.audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}) = 'solo'
           AND counts_toward_outcome($1, a.id)) AS solo
    FROM owed o
    JOIN apps a ON a.id = o.app_id
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE ${VISIBLE_APP_WHERE}
     AND EXISTS (SELECT 1 FROM community_members cm
                  WHERE cm.community_id = a.community_id AND cm.user_id = $1)
     ${inThreads ? IN_THREADS_WHERE : ''}
   ORDER BY o.at DESC NULLS LAST, o.id DESC
   LIMIT $4
`;
const NEEDS_FEED_SQL = needsFeedSql();
const NEEDS_FEED_IN_THREADS_SQL = needsFeedSql({ inThreads: true });

// The same feed, counted per project and in the order the viewer joined
// them (services/places.js reads it; so did the Getting started card's Vote
// step, until #4635 retired the card), so a count and the Needs you tab it
// sends people to agree on what is waiting and where. The SAME owed
// predicates, the same visibility filter and the same membership rule as
// NEEDS_FEED_SQL; only the shape differs. `$1` is the viewer, `$2` "may see self-hosted rows", `$3`
// "is an admin", as above.
//
// `paying` is how many of a project's `waiting` the scorer's VOTE_CAST pays
// (services/topochain/challenge-scorer.js VOTE_CAST_SQL, the same two
// tests). Not a proposal the Homeroom bot built from a request the viewer
// made, and nothing in a project only the viewer is in ("Just you"): a
// change the bot made for them on their own solo app waits in their Needs
// you like any other proposal, but voting on it is not judging somebody
// else's change. The feed itself still lists them; `paying` skips them. (A
// first version is owed by nobody: OWED_PROPOSALS_WHERE.)
const OWED_BY_COMMUNITY_SQL = `
  WITH owed AS (
    SELECT cs.app_id,
           NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r
                        WHERE r.app_id = cs.app_id
                          AND r.issue_number = cs.created_from_issue_number
                          AND r.user_id = $1) AS pays
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT i.app_id, TRUE AS pays
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
    UNION ALL
    -- A question answered is not a vote cast: it pays nothing.
    SELECT q.app_id, FALSE AS pays
      FROM ${OWED_QUESTIONS_FROM}
     WHERE ${OWED_QUESTIONS_WHERE}
  )
  SELECT a.id, a.slug, a.name, COUNT(*)::int AS waiting,
         (CASE WHEN a.view_visibility = 'public'
                 OR (SELECT COUNT(*) FROM community_members om WHERE om.community_id = a.community_id) > 1
                 OR EXISTS (SELECT 1 FROM app_collaborators ic
                             WHERE ic.app_id = a.id AND ic.status = 'invited')
               THEN COUNT(*) FILTER (WHERE o.pays) ELSE 0 END)::int AS paying,
         MIN(cm.joined_at) AS joined_at
    FROM owed o
    JOIN apps a ON a.id = o.app_id
    JOIN community_members cm ON cm.community_id = a.community_id AND cm.user_id = $1
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE ${VISIBLE_APP_WHERE}
   GROUP BY a.id, a.slug, a.name
   ORDER BY MIN(cm.joined_at) ASC, a.id ASC
`;

/**
 * The votes waiting for a viewer, per project they are a member of, in the
 * order they joined them: `[{ slug, name, waiting, paying }]`, projects with
 * nothing waiting left out. The Needs you feed's population (NEEDS_FEED_SQL),
 * counted rather than listed; `paying` is how many of them a vote on would
 * count for the Vote on an app challenge (OWED_BY_COMMUNITY_SQL).
 */
async function owedByCommunity(pool, userId, { showSelfHosted = false, isAdmin = false } = {}) {
  const { rows } = await pool.query(OWED_BY_COMMUNITY_SQL, [userId, !!showSelfHosted, !!isAdmin]);
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name || row.slug,
    waiting: Number(row.waiting) || 0,
    paying: Number(row.paying) || 0,
  }));
}

/**
 * #4270: how many Yes votes each of NEEDS_FEED_SQL's `solo` rows needs, as
 * `votes_required` on the row, worked out as GET /api/apps/:slug/promoted
 * works it out for the change's card: the project's governance and
 * electorate, then the merge gate over the counted votes. One read per
 * project, and only for those rows; a project whose read fails is left
 * without one. Resolves the rows. Exported for tests.
 */
async function withVotesRequired(pool, rows, viewerId = null) {
  const byApp = new Map();
  for (const row of rows) {
    // #6389: a row the viewer made through a coding agent needs the same
    // count, so a met vote can be told from one still owed.
    const authorsAgent = viewerId != null && row.external_agent
      && Number(row.author_id) === Number(viewerId);
    if (row.solo !== true && !authorsAgent) continue;
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, []);
    byApp.get(row.app_id).push(row);
  }
  await Promise.all([...byApp].map(async ([appId, list]) => {
    try {
      const gov = await governance.getGovernance(pool, appId);
      const electorate = await governance.getElectorate(pool, appId, gov);
      for (const row of list) {
        row.votes_required = governance.computeGate(gov, electorate.active, row.yes, row.no, row.at, null).required;
      }
    } catch (err) {
      log.warn('workshop-overview', 'Could not work out the votes a solo project needs', { appId, message: err.message });
    }
  }));
  return rows;
}

/**
 * #6389: whether a change the viewer made through a coding agent has the
 * votes it needs, so the row is waiting on their fix rather than on a Vote.
 * The same facts the change's Votes card reads: the gate's Yes count, and,
 * where an explicit approval is flagged, a Yes from another member.
 */
function authorAgentGateMet(row, viewerId) {
  if (row.kind !== 'proposal' || !row.external_agent) return false;
  if (viewerId == null || Number(row.author_id) !== Number(viewerId)) return false;
  const needed = parseInt(row.votes_required, 10);
  if (!Number.isFinite(needed)) return false;
  if ((Number(row.yes) || 0) < needed) return false;
  if (row.requires_explicit_approval && (Number(row.other_yes) || 0) < 1) return false;
  return true;
}

/**
 * #6389: what a change the viewer made through a coding agent waits on once
 * its vote is in, in the order the page says it: `'checks'`, then
 * `'conflict'`. Null while the gate is not met (the row stays a Vote) and
 * when nothing is left for them to fix.
 */
function waitingOnFix(row, viewerId) {
  if (!authorAgentGateMet(row, viewerId)) return null;
  const reasons = [];
  if (row.check_state === 'failing') reasons.push('checks');
  if (row.mergeability === 'conflict'
      || row.integration_merges_clean === false
      || row.merge_conflict_state === 'failed'
      || row.merge_conflict_state === 'conflict') reasons.push('conflict');
  return reasons.length ? reasons : null;
}

/**
 * B7 for one of the feed's rows, the rule AppView._approveSolo applies to a
 * card: a change on a project that is just the viewer's, whose vote counts,
 * and whose Yes is the one it needs. A row with no count worked out needs
 * one, as a card without votes_required does.
 */
function approvedAlone(row) {
  if (row.solo !== true) return false;
  const needed = parseInt(row.votes_required, 10);
  return !Number.isFinite(needed) || needed <= 1;
}

/**
 * #5365: mark each proposal row with whether the viewer's vote can affect
 * the outcome. `uncounted` is counts_toward_outcome's answer (a test
 * account's vote is recorded but not counted); `advisory` is
 * governance.viewerDecides' (a non-approver on an approver project, or
 * someone outside every group a rules project's rules name) — the same
 * facts /promoted marks its cards with (#4747), so a card and its feed row
 * cannot disagree. Group decisions are never marked: their own page
 * explains who decides. One governance read per project; a project whose
 * read fails is left unmarked, so a deciding vote is never hidden at the
 * back. Resolves the rows. Exported for tests.
 */
async function withViewerDecides(pool, rows, userId) {
  const byApp = new Map();
  for (const row of rows) {
    if (row.kind !== 'proposal') continue;
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, []);
    byApp.get(row.app_id).push(row);
  }
  await Promise.all([...byApp].map(async ([appId, list]) => {
    try {
      const gov = await governance.getGovernance(pool, appId);
      const facts = gov.rules ? await governance.rulesFacts(pool, appId, gov) : null;
      const approverIds = !gov.rules && gov.approverPolicy === 'invited'
        ? (await governance.getElectorate(pool, appId, gov)).approverIds
        : null;
      for (const row of list) {
        row.uncounted = row.counts === false;
        row.advisory = !row.uncounted && !governance.viewerDecides(gov, {
          approverIds,
          facts,
          explicitApproval: !!row.requires_explicit_approval,
          explicitReason: row.explicit_approval_reason || null,
        }, userId);
      }
    } catch (err) {
      log.warn('workshop-overview', 'Could not read whether the viewer decides these changes; the cards stay unmarked', { appId, message: err.message });
    }
  }));
  return rows;
}

/**
 * #5365: the feed's order as a stable partition — the rows whose vote
 * decides first, the marked ones (advisory or uncounted) after, each group
 * keeping its own newest-first order from the query. The spec's
 * "votes that can actually effect change" first, the advisory ones after:
 * a viewer who wants to vote only where it matters can stop when the
 * marked cards begin. Exported for tests.
 */
function decidingFirst(items) {
  const deciding = [];
  const advisory = [];
  for (const it of items) {
    (it.advisory || it.uncounted ? advisory : deciding).push(it);
  }
  return [...deciding, ...advisory];
}

/**
 * A group decision's own facts, the few fields its diagram is drawn from
 * (frontend/src/lib/diagram/decision.ts), named one by one so nothing else
 * in a payload reaches the feed. A secret change carries its key and action,
 * never a value.
 */
function decisionFacts(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  if (kind === 'rename') return str(p.newName) ? { kind, newName: str(p.newName) } : null;
  if (kind === 'close_issue') {
    const n = Number(p.issueNumber);
    return { kind, issueNumber: Number.isInteger(n) && n > 0 ? n : null, issueTitle: str(p.issueTitle), reason: str(p.reason) };
  }
  if (kind === 'secret_change') {
    return str(p.key) ? { kind, key: str(p.key), action: p.action === 'delete' ? 'delete' : 'set' } : null;
  }
  return null;
}

/**
 * #4490: what a feed row needs to draw its picture: the shots run (attached
 * by withPictures), the legacy capture pair, the author's diagram, "What it
 * touches" for the head it was read at, and a group decision's facts.
 */
function pictureFields(row) {
  if (row.kind === 'question') return {};
  if (row.kind === 'governance') {
    const decision = decisionFacts(row.decision_kind, row.decision_payload);
    if (decision && decision.kind === 'rename') decision.fromName = row.name || null;
    return decision ? { decision } : {};
  }
  const head = visualHeadForSession(row);
  const diagram = diagramContract.storedDiagram(row.pr_diagram);
  const out = {};
  if (row.shots && typeof row.shots === 'object') out.shots = row.shots;
  if (row.visuals_agg) {
    const shaped = visualsService.shapeAgg(row.visuals_agg, head);
    if (shaped) out.visuals = shaped;
  }
  if (diagram) {
    out.diagram = diagram;
    out.diagram_source = row.pr_diagram_source || 'author';
  }
  if (head && row.pr_touches_sha === head) {
    const touches = proposalTouches.storedTouches(row.pr_touches);
    if (touches) out.touches = touches;
  }
  const impact = row.shots_detail && row.shots_detail.intent && row.shots_detail.intent.impact;
  if (impact === 'none') out.nothing_visible = true;
  return out;
}

/**
 * Attach each proposal row's shots (the same serializer a project's list
 * uses) and start "What it touches" for a head not yet read. Resolves the
 * rows. Best-effort: a failed read leaves the row without a picture.
 */
async function withPictures(pool, rows, { shotsPresent = false, viewer = null } = {}) {
  const proposals = rows.filter((r) => r.kind === 'proposal');
  if (!proposals.length) return rows;
  if (shotsPresent) {
    try {
      for (const r of proposals) r.app_slug = r.slug;
      const bySession = await shotsView.getForSessions(pool, proposals, null, { viewer });
      for (const r of proposals) r.shots = bySession.get(Number(r.id)) || null;
    } catch (err) {
      log.warn('workshop-overview', 'Could not read the feed\'s shots', { message: err.message });
    }
  }
  // A head whose code is missing (withCodeMissing) has nothing on the git
  // host to read, so it starts no read.
  proposalTouches.scheduleRefresh(pool, proposals.map((r) => ({
    id: r.id, repo_url: r.repo_url, pr_touches_sha: r.pr_touches_sha,
    head: r.code_missing ? null : visualHeadForSession(r),
  })));
  return rows;
}

/**
 * Mark each change whose code did not come across when Homeroom moved off
 * GitHub (services/code-missing.js): its pull request's branch is not on the
 * git host. One query and one cached branch list per project, as a project's
 * own list reads it, so the card says "Code missing" in both feeds.
 * Resolves the rows; never throws.
 */
async function withCodeMissing(pool, rows) {
  const proposals = rows.filter((r) => r.kind === 'proposal');
  if (!proposals.length) return rows;
  const missing = await codeMissing.missingIds(pool, proposals.map((r) => ({
    id: r.id, app_id: r.app_id, pr_number: r.number, status: r.status, repo_url: r.repo_url,
  })));
  for (const r of proposals) r.code_missing = missing.has(Number(r.id));
  return rows;
}

/**
 * A feed row's live preview URL, or null: exactly when the change's own card
 * on its project offers "Try it" as a live preview. /promoted hands that card
 * `staging_url` and services/staging.js previewDisplayState calls a row with
 * one 'ready' (building and failed are both states of a row without one), and
 * the card's preview (AppView._cardPreviewSpec) is live on a URL. The feed is
 * proposals up for a vote ('promoted'), the one state a card is drawn from
 * here. The URL is the column as stored: a local one names `localhost`,
 * which the client rewrites (public/js/dev-host.js), as it does on the card.
 * Opening it goes through AppView.swapToStagingForSession, which rebuilds a
 * preview the idle collector took down since.
 */
function feedStagingUrl(row) {
  if (row.kind !== 'proposal' || (row.status && row.status !== 'promoted')) return null;
  const url = typeof row.staging_url === 'string' ? row.staging_url.trim() : '';
  return url || null;
}

/** Shape NEEDS_FEED_SQL's rows for the client. Exported for tests. */
/**
 * #6019: a ballot's choices, from a change's row (NEEDS_FEED_SQL's
 * ballot_options, ballot_close, ballot_for): null unless it is one, two or
 * more changes up for a vote in its thread, or one and an open vote to
 * close it. The card names the request it is for and lists the choices; the
 * vote itself is cast on the request's page, where the ballot is.
 */
function ballotOf(row) {
  const options = Array.isArray(row.ballot_options) ? row.ballot_options : [];
  const close = row.ballot_close && typeof row.ballot_close === 'object' ? row.ballot_close : null;
  if (options.length < (close ? 1 : 2)) return null;
  const forRow = row.ballot_for && typeof row.ballot_for === 'object' ? row.ballot_for : {};
  return {
    number: forRow.number == null ? null : Number(forRow.number),
    title: forRow.title || null,
    options: options.map((o) => ({
      id: Number(o.id),
      number: o.number == null ? null : Number(o.number),
      title: o.title || '',
      author: o.author || null,
      epoch: o.epoch == null ? null : Number(o.epoch),
    })),
    close: close ? { id: Number(close.id), title: close.title || '', reason: close.reason || null, author: close.author || null } : null,
  };
}

/**
 * 30 Oct 2026: the request a change closes (NEEDS_FEED_SQL's ballot_for, the
 * first request it links), which the Homeroom bot tab names it by, as the
 * bot does in Main. `{ request }` when it has one, else nothing.
 */
function requestOf(row) {
  const forRow = row.ballot_for && typeof row.ballot_for === 'object' ? row.ballot_for : null;
  if (!forRow || forRow.number == null) return {};
  return { request: { number: Number(forRow.number), title: forRow.title || null } };
}

const FEED_KINDS = new Set(['proposal', 'governance', 'question']);

function shapeNeedsFeed(rows, { inThreads = false } = {}) {
  return rows.map((row) => {
    const ballot = row.kind === 'proposal' ? ballotOf(row) : null;
    return {
    kind: ballot ? 'ballot' : (FEED_KINDS.has(row.kind) ? row.kind : 'proposal'),
    ...(ballot ? { ballot } : {}),
    id: Number(row.id),
    title: row.title || '',
    summary: (row.summary || '').trim() || null,
    author: row.author || null,
    number: row.number == null ? null : Number(row.number),
    ...(row.kind === 'proposal' && !ballot ? requestOf(row) : {}),
    epoch: row.epoch == null ? null : Number(row.epoch),
    at: row.at instanceof Date ? row.at.toISOString() : (row.at || null),
    yes: row.yes == null ? null : Number(row.yes),
    no: row.no == null ? null : Number(row.no),
    ...(approvedAlone(row) ? { approve: true } : {}),
    // #6389: the viewer's own change, made through a coding agent, whose
    // votes are in and which waits on their fix. The row says what it waits
    // on instead of Vote, and names the tool it was made in.
    ...(row.kind === 'proposal' && Array.isArray(row.waiting_on) && row.waiting_on.length
      ? { waitingOn: row.waiting_on, agent: row.external_agent || null } : {}),
    // #5365: only when set — an unmarked row carries no flag at all, so the
    // card keeps its usual place and wording.
    ...(row.uncounted ? { uncounted: true } : {}),
    ...(row.advisory ? { advisory: true } : {}),
    // Its code did not come across from GitHub (withCodeMissing): the card
    // says so. Only when set, as the two flags above.
    ...(row.kind === 'proposal' && row.code_missing === true ? { codeMissing: true } : {}),
    // #6531: a conflicting change only a yes can move names the conflict on
    // its Vote row, as the bot tab does.
    ...(row.kind === 'proposal' && row.conflict_on_yes === true ? { conflictOnYes: true } : {}),
    // "Try it" from the feed: a change's live preview, as its project's own
    // card has it (feedStagingUrl). Proposals only.
    ...(row.kind === 'proposal' ? { staging_url: feedStagingUrl(row) } : {}),
    // #4490: the card's picture, the same as a project's Needs you draws.
    ...pictureFields(row),
    // #6262: the thread its page is, for the Homeroom bot page's unread
    // count (needsFeedFor adds how many are new). Absent from the full feed,
    // which is not that page's.
    ...(inThreads && row.thread_id != null ? { threadId: Number(row.thread_id) } : {}),
    app: {
      slug: row.slug,
      name: row.name || row.slug,
      icon_url: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
      icon_emoji: row.icon_emoji || null,
    },
    };
  });
}

/**
 * The Needs you feed for `user`, as GET /api/workshop/needs-feed answers it:
 * every decision they owe, or (`inThreads`) only those in the threads they
 * are in, the Homeroom bot tab's. Homeroom bot's my_work reads the same
 * (services/ai-work.js pageLists), so its answer names what the tab does.
 */
async function needsFeedFor(pool, { user, showSelfHosted = false, inThreads = false, shotsPresent = false }) {
  const { rows } = await pool.query(inThreads ? NEEDS_FEED_IN_THREADS_SQL : NEEDS_FEED_SQL, [
    user.id, !!showSelfHosted, !!user.isAdmin, NEEDS_FEED_MAX,
  ]);
  await withCodeMissing(pool, rows);
  await withPictures(pool, rows, { shotsPresent, viewer: user });
  await withViewerDecides(pool, rows, user.id);
  const voted = await withVotesRequired(pool, rows, user.id);
  // #6389: a row that is the viewer's own change made through a coding
  // agent says what it waits on once its vote is in, and leaves Needs you
  // when nothing is left for them to fix (only testing is running).
  for (const row of voted) row.waiting_on = waitingOnFix(row, user.id);
  const kept = voted.filter((row) => !(authorAgentGateMet(row, user.id) && !row.waiting_on));
  const items = decidingFirst(shapeNeedsFeed(kept, { inThreads }));
  if (!inThreads) return items;
  // #6262: how many messages in each item's thread are new to the viewer.
  const unread = await require('../services/thread-reads')
    .unreadFor(pool, user.id, items.map((item) => item.threadId));
  return items.map((item) => ({ ...item, unread: unread.get(item.threadId) || 0 }));
}

/**
 * The demo overlay under the real counts.
 *
 * Exported and pure so tests can exercise it with no database. REAL COUNTS
 * WIN: `issues` survives the staging clone, so a preview may genuinely have
 * governance rows against one of these slugs, and a mock that overwrote them
 * would make the demo mode a worse test of the screen than no demo mode at
 * all. The demo slugs do not exist in Postgres, so in practice nothing
 * collides — this is the rule rather than the common case.
 */
function withDemoCounts(counts) {
  return { ...DEMO_COUNTS, ...counts };
}

// The rows behind DEMO_COUNTS, for ?demo=1 on staging (#3051): the same
// reason the counts have a mock, and the same slugs. `staging-demo-your-app`
// carries exactly its counts' 2 and 3, so the tab and the row beside it agree
// in the preview. Titles only; nothing reads these back. The ids are
// negative so a tap can never open a real proposal by accident.
const DEMO_ITEMS = {
  'staging-demo-your-app': {
    working: [
      { kind: 'session', id: -101, title: 'Add a dark theme toggle', status: 'active', at: '2026-09-24T09:00:00Z' },
      { kind: 'proposal', id: -102, title: 'Show the recipe count on the home card', status: 'promoted', at: '2026-09-23T15:00:00Z' },
    ],
    needs: [
      { kind: 'proposal', id: -103, title: 'Sort recipes by rating', status: 'promoted', at: '2026-09-24T12:00:00Z' },
      { kind: 'proposal', id: -104, title: 'Let members share a shopping list', status: 'promoted', at: '2026-09-22T10:00:00Z' },
      { kind: 'governance', id: -105, title: 'Rename the app to Recipe Box', status: 'rename', at: '2026-09-21T08:00:00Z' },
    ],
  },
};

// The feed's ?demo=1 rows on staging, drawn from DEMO_ITEMS' needs so the
// tab and the counts beside it tell one story. Negative ids, as there: a
// vote on one is refused, never cast on a real proposal. They come AFTER
// the real rows (withDemoNeedsFeed), the same "real rows win" rule the
// counts and items overlays keep, and the demo slug is in no database.
const DEMO_NEEDS_FEED = [
  {
    kind: 'proposal', id: -103, title: 'Sort recipes by rating',
    summary: 'Adds a Rating option to the sort menu, highest first, and remembers the choice per person.',
    author: 'staging-demo-partner', number: null, epoch: 0, at: '2026-09-24T12:00:00Z', yes: 2, no: 0,
    // #6262: a demo item with something new, so ?demo=1 shows its dot.
    threadId: -103, unread: 1,
    // The request it closes, which the Homeroom bot tab names it by (requestOf).
    request: { number: 9213, title: 'Staging demo: sort by rating' },
    // No preview: the demo project has no container (stagingMockProposals
    // gives its cards none either), so "Try it" is not offered.
    staging_url: null,
    // #4490: its author's diagram, so the feed's picture can be seen on ?demo=1.
    diagram: {
      version: 1, kind: 'changes',
      rows: [
        { op: 'added', what: 'Sort by rating', detail: 'Highest rated first' },
        { op: 'changed', what: 'The sort menu', detail: 'Remembers your choice' },
      ],
    },
    diagram_source: 'author',
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
  {
    kind: 'proposal', id: -104, title: 'Let members share a shopping list',
    summary: 'A shared list on the app\'s home screen that any member can add to and tick off.',
    author: 'staging-demo-partner', number: null, epoch: 0, at: '2026-09-22T10:00:00Z', yes: 1, no: 1,
    staging_url: null,
    threadId: -104, unread: 1,
    // #5365: the demo card for an advisory vote, so the feed's label and the
    // deciding-first order can be seen on ?demo=1 without a governed project.
    advisory: true,
    // #4490: no diagram, so its picture is "What it touches".
    touches: {
      version: 1, files: 5,
      areas: [
        { key: 'screens', label: 'Screens', files: 3, lines: 140 },
        { key: 'server', label: 'Server', files: 1, lines: 46 },
        { key: 'database', label: 'Database', files: 1, lines: 12 },
        { key: 'tests', label: 'Tests', files: 0, lines: 0 },
        { key: 'docs', label: 'Docs', files: 0, lines: 0 },
        { key: 'other', label: 'Other', files: 0, lines: 0 },
      ],
    },
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
  {
    kind: 'governance', id: -105, title: 'Rename the app to Recipe Box',
    summary: 'A group decision: the new name shows everywhere once it passes.',
    author: 'staging-demo-partner', number: null, epoch: null, at: '2026-09-21T08:00:00Z', yes: null, no: null,
    // #4490: a group decision's diagram is drawn from its own facts.
    decision: { kind: 'rename', newName: 'Recipe Box', fromName: 'Staging demo app' },
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
  // #4313: a change on a Just-you project, which asks for your approval
  // rather than a vote (#4270's `approve`), so the reel's approval wording
  // can be seen in a preview. Nobody else is in it, so it has no author and
  // no tally; `?shot=needs-approve` opens on it with its vote sheet up.
  {
    kind: 'proposal', id: -106, title: '[Demo] Show a word count under each note',
    summary: 'A demo change on a project that is just yours: each note shows how many words it has.',
    author: null, number: null, epoch: 0, at: '2026-09-20T09:00:00Z', yes: 0, no: 0, approve: true,
    staging_url: null,
    app: { slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_url: null, icon_emoji: '🎮' },
  },
];

/**
 * Whether a proposal id is one of the demo feed's (#4313): the follow-up
 * requests the reel makes for a demo row (its vote, its Ask thread) are
 * answered by the demo path rather than refused, so a preview logs no
 * failed request. Negative ids name no real proposal anywhere.
 */
function isDemoNeedsProposal(id) {
  const n = Number(id);
  return IS_STAGING && Number.isInteger(n) && n < 0
    && DEMO_NEEDS_FEED.some((it) => it.kind === 'proposal' && it.id === n);
}

/** The feed's demo overlay: the real feed first, then the demo cards. */
function withDemoNeedsFeed(items) {
  const seen = new Set(items.map((it) => `${it.kind}:${it.id}`));
  return [...items, ...DEMO_NEEDS_FEED.filter((it) => !seen.has(`${it.kind}:${it.id}`))];
}

/**
 * The demo overlay under the real items. Same rule as withDemoCounts: an app
 * the database answered for keeps its real rows.
 */
function withDemoItems(items) {
  return { ...DEMO_ITEMS, ...items };
}

/** Group ITEMS_SQL's flat rows by slug and section. Exported for tests. */
function groupItems(rows) {
  const items = {};
  for (const row of rows) {
    const slot = items[row.slug] || (items[row.slug] = { working: [], needs: [] });
    const section = row.section === 'needs' ? 'needs' : 'working';
    slot[section].push({
      kind: row.kind,
      id: Number(row.id),
      title: row.title || '',
      status: row.status || '',
      at: row.at instanceof Date ? row.at.toISOString() : (row.at || null),
    });
  }
  return items;
}

/**
 * #4313: a vote on one of the ?demo=1 Needs-you feed's cards is answered
 * here, never cast: the preview's Approve and Vote land as they would, and
 * nothing logs a failed request. So is the card's page's read of who voted
 * (nobody: a demo card names no real people). Its own router, mounted ahead
 * of the session routers (server.js), whose access guard refuses a negative
 * id before those routes are reached. Every other id passes straight through.
 */
function demoNeedsVoteRoutes() {
  const router = Router();
  router.get('/api/sessions/:id/votes', (req, res, next) => {
    if (!isDemoNeedsProposal(req.params.id)) return next();
    return res.json({ yes: [], no: [], reasons: [], earlier: { yes: [], no: [] } });
  });
  router.post('/api/sessions/:id/vote', (req, res, next) => {
    if (!isDemoNeedsProposal(req.params.id)) return next();
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const vote = req.body?.vote;
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    return res.json({ ok: true, demo: true, vote });
  });
  // Its Undo, answered the same way: nothing was cast, so nothing is taken back.
  router.delete('/api/sessions/:id/vote', (req, res, next) => {
    if (!isDemoNeedsProposal(req.params.id)) return next();
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return res.json({ ok: true, demo: true, retracted: true });
  });
  return router;
}

function workshopOverviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/workshop/counts', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      // The same two flags GET /api/apps resolves, so the two lists cannot
      // disagree about which apps exist for this viewer.
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      // `unchosen` (5 Oct 2026): a community whose votes do not put a number
      // on the Communities tab, because the viewer is in it only as every
      // account is and has not taken part there yet
      // (communities.UNCHOSEN_COMMUNITIES_SQL). Only the tab's badge reads it;
      // `needs` itself is unchanged, so the list, the switcher and Needs you
      // still say what waits. A failed read is the old behaviour: every
      // vote on the badge.
      const [{ rows }, unchosen] = await Promise.all([
        pool.query(COUNTS_SQL, [req.user.id, showSelfHosted, !!req.user.isAdmin]),
        communities.unchosenCommunities(pool, req.user.id).catch((err) => {
          log.warn('workshop-overview', 'Unchosen communities read failed; badging every vote', { message: err.message });
          return new Set();
        }),
      ]);
      const counts = {};
      for (const row of rows) {
        counts[row.slug] = {
          working: Number(row.working) || 0,
          needs: Number(row.needs) || 0,
          owed: Array.isArray(row.owed) ? row.owed.map(String) : [],
          ...(unchosen.has(row.slug) ? { unchosen: true } : {}),
        };
      }
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ counts: withDemoCounts(counts) });
      }
      return res.json({ counts });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read workshop counts', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/workshop/items', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      const { rows } = await pool.query(ITEMS_SQL, [
        req.user.id, showSelfHosted, !!req.user.isAdmin, ITEMS_PER_APP, ITEMS_TOTAL,
      ]);
      const items = groupItems(rows);
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ items: withDemoItems(items) });
      }
      return res.json({ items });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read workshop items', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6019: the questions Homeroom bot asked the viewer about their requests
  // and that nobody answered yet, newest first. The bot asks in the
  // request's public discussion, so a row opens the request, where it is
  // answered; Needs you lists them above the votes. Its own read, so the
  // vote feed's cards and counts are unchanged.
  router.get('/api/workshop/bot-questions', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const { rows } = await pool.query(BOT_QUESTIONS_SQL, [req.user.id, BOT_QUESTIONS_MAX]);
      return res.json({
        questions: rows.map((r) => ({
          messageId: Number(r.message_id),
          appSlug: r.slug,
          appName: r.name || r.slug,
          issueNumber: Number(r.issue_number),
          question: String(r.question || '').trim().slice(0, 280) || null,
          at: r.created_at,
        })),
      });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read the bot\'s questions', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/workshop/needs-feed', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const items = await needsFeedFor(pool, {
        user: req.user,
        showSelfHosted: !!req.user.isAdmin || !!config.selfAppPublicVoting,
        inThreads: req.query.in === 'threads',
        shotsPresent: !!config.shots?.present,
      });
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ items: decidingFirst(withDemoNeedsFeed(items)), max: NEEDS_FEED_MAX });
      }
      return res.json({ items, max: NEEDS_FEED_MAX });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read the needs feed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  workshopOverviewRoutes, demoNeedsVoteRoutes, withDemoCounts, DEMO_COUNTS, COUNTS_SQL,
  withDemoItems, DEMO_ITEMS, ITEMS_SQL, ITEMS_PER_APP, ITEMS_TOTAL, groupItems,
  NEEDS_FEED_SQL, NEEDS_FEED_IN_THREADS_SQL, NEEDS_FEED_MAX, needsFeedFor, BOT_QUESTIONS_SQL, BOT_QUESTIONS_MAX, shapeNeedsFeed, withVotesRequired, waitingOnFix, authorAgentGateMet, withViewerDecides, decidingFirst,
  withPictures, withCodeMissing, pictureFields, decisionFacts, DEMO_NEEDS_FEED, withDemoNeedsFeed,
  isDemoNeedsProposal,
  OWED_BY_COMMUNITY_SQL, owedByCommunity,
  MY_SESSIONS_WHERE, MY_PROPOSALS_WHERE,
};
