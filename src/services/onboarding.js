'use strict';

/**
 * Communities, stage 5: a new account's first run.
 *
 *   sign in → username → terms → "What communities do you want to join?"
 *           → Home, with a Getting started card on top, whose first row
 *             offers the tour (#3240).
 *
 * The first two steps were already there (frontend/src/features/auth/
 * username-first-run.js, frontend/src/features/settings/terms-first-run.js).
 * This module is the server half of the other two: which communities the
 * join screen offers and what answering it does, and the list the card on
 * Home ticks off.
 *
 * ── Who is asked ────────────────────────────────────────────────────────
 *
 * `users.needs_communities_choice`, set TRUE wherever an account is made by
 * a person signing up (email, an activation code, a wallet) and FALSE for
 * everyone else, including every account that existed before the column and
 * every account the boot seeds: the join screen is for newcomers,
 * and a member who has been here a year has already found their
 * communities. See the note beside the column in src/db/schema.sql.
 *
 * ── What the screen offers ─────────────────────────────────────────────
 *
 * Homeroom first: the platform's own project, where the platform itself is
 * built. A new account with platform access is already in it (the
 * users_join_platform_community trigger), so it arrives ticked; unticking it
 * is how a newcomer says "not this one", and answering leaves it. Then any
 * group the person has been invited into, which is the reason somebody
 * signs up more often than not. Then the communities an admin has featured
 * (featured_apps, in its order: the same curated set Discover leads with),
 * and after them the open communities with the most members. Solo projects
 * and view-private apps are never offered: nobody can join those from
 * outside.
 *
 * "Skip for now" is an answer too: it joins and leaves nothing, and the
 * screen does not come back. Discover is where to join later.
 *
 * ── The card IS the First challenges ───────────────────────────────────
 *
 * Home used to open on two first-run lists that did not know about each
 * other: this card (the tour, then say hi, vote and explore in one
 * community, paying nothing) and the Challenges block's First challenges (the
 * season's first ONBOARDING challenges, paying points and hiding the rest of
 * the season from everyone). They overlapped, and disagreed on "done". Since
 * evan's "one list" decision (2026-10-01) there is one:
 *
 *   1. Take the 1-minute tour   the welcome tour finished or skipped, on any
 *                               device (`users.tour_done_at`, #3237). Code,
 *                               not a challenge: it pays nothing.
 *   2.. the season's First challenges, in the admin's display order
 *       (services/topochain/challenge-onboarding.js): their titles, tasks and
 *       rewards are DATA, renamed, reordered and added to in the admin
 *       console, so nothing here names them. Each ticks the moment its credit
 *       is written (the instant scoring of #3593 and its successors), from
 *       the same progress the Challenges tab and Home's block read.
 *
 * Every step not done carries a button to where its action is (stepAction
 * below), chosen by the MEASURE of the scoring rule bound to its challenge;
 * the button never ticks it. Try, Vote and Suggest wait on the Join step's
 * tick (`needs_join`, gettingStarted below), are about ONE app, the person's
 * default app (defaultApp below), and Vote goes wherever something is
 * waiting for their vote (voteTarget below). The one step a visit ticks
 * is Vote, and only when nothing is up for a vote anywhere they are a
 * member: then its button is "Look", it opens that app's Workshop, and the
 * visit is the credit (markWorkshopVisit below; VOTE_CAST counts it).
 *
 * Who sees it: an account made since the list shipped
 * (`users.getting_started_gate`), however it signed up (#4601: the join
 * screen, "What do you want to make?" or an invite link), until it closes
 * the card, which it can do once the list is done. The same
 * accounts, and only they, find the rest of the season locked until then;
 * everyone who was already here sees the whole season and no card. An
 * account that signs up from an invite link, or is asked "What do you want to
 * make?" in place of the join screen, is a new account like any other: the
 * sign-up sets the flag, and the flag alone decides (#4601), so it gets the
 * card and the gate too.
 *
 * ── The tour ───────────────────────────────────────────────────────────
 *
 * Only whether it is done (`users.tour_done_at`), which ticks the card's
 * first row on every device. The tour itself is all client
 * (frontend/src/features/home/tour).
 */

const communities = require('./communities');
const { loadOnboarding } = require('./topochain/challenge-onboarding');
const { TRY_APPS_MIN_SECONDS } = require('./topochain/challenge-rules');
const { fetchCurrentSeason, gateUnlocks } = require('../routes/home-panels');
const { owedByCommunity } = require('../routes/workshop-overview');

// How many communities the join screen lists. Homeroom and the invites come
// first, so this is the room left for the open communities.
const SUGGESTION_LIMIT = 8;
// The most the screen can join in one answer. It lists eight; the cap is
// only there so the endpoint is not a bulk-join API.
const MAX_JOIN = 20;
// How many of the challenges the list unlocks its done state names.
const UNLOCK_NAMES = 4;

function iconUrl(row) {
  return row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null;
}

// The longest description the join screen shows under a name: two lines on
// a phone. dapp.json's own field has no limit of its own.
const DETAIL_MAX = 100;

// A few words for the communities people are most likely to be offered,
// until each says what it is itself. When this was written none of the live
// apps' dapp.json had a `description`, so the join screen would have been a
// column of bare names. Keyed by slug, which a rename leaves alone (Game
// Corner is still puzzlechain-6cf8ff). A community's own line always wins:
// once its dapp.json says something, its entry here is never read, and can
// be dropped.
const STARTER_DETAILS = Object.freeze({
  'puzzlechain-6cf8ff': 'Daily puzzles and games',
  'mypage-777ed2': 'Decorate your own page',
  'community-tier-lists-57ce6a': 'Rank anything together',
  'recipebot-33b169': 'AI recipe helper',
  'todo-list-b91765': 'Shared to-do lists',
  'supply-line-rts-6408b2': 'Slow-paced strategy game',
  'gym-tracker-9de81f': 'Log your workouts',
});

// What the join screen says under a community's name. Homeroom says what
// joining it means; an invite says who sent it; anything else says what it
// is, in its own words: dapp.json's top-level `description`, the line
// Homeroom's About pane already shows (routes/platform-about.js), which a
// community sets and changes by a voted change like any other line there.
// Without one, its starter line if it has one, else nothing at all.
// "Community · N members" was the same words on every row, and the count
// said little about what the thing is. The count is back since, as a figure
// of its own at the row's end (`member_count`, drawn by
// frontend/src/features/auth/communities-first-run.js): beside these words,
// never instead of them.
function suggestionDetail(row) {
  if (row.self_hosted) return 'Contribute to the Homeroom platform';
  if (row.invited_by) return `Invited by @${row.invited_by}`;
  const own = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim() : '';
  const text = own || STARTER_DETAILS[row.slug] || '';
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1).trimEnd()}…` : text;
}

/**
 * The communities the join screen lists, in its order. `showSelfHosted` is
 * the same rule every listing of the platform's own row applies (admins, or
 * the deployment's selfAppPublicVoting): where Homeroom is not listed
 * anywhere else, it is not offered here either.
 */
async function joinSuggestions(pool, userId, { showSelfHosted = false } = {}) {
  const members = '(SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = a.community_id)';
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.icon_emoji, a.icon_image_id, a.self_hosted,
            ${members}::int AS member_count,
            ${communities.audienceSql('a', members)} AS audience,
            EXISTS (SELECT 1 FROM community_members me
                     WHERE me.community_id = a.community_id AND me.user_id = $1) AS is_member,
            a.manifest_snapshot->>'description' AS description,
            inv.invited_by
       FROM apps a
       LEFT JOIN (
         SELECT c.app_id, u.username AS invited_by
           FROM app_collaborators c
           LEFT JOIN users u ON u.id = c.invited_by
          WHERE c.user_id = $1 AND c.status = 'invited'
       ) inv ON inv.app_id = a.id
       LEFT JOIN featured_apps fa ON fa.app_id = a.id
      WHERE a.community_id IS NOT NULL
        AND (
          (a.self_hosted AND $2::boolean)
          OR (NOT a.self_hosted AND inv.app_id IS NOT NULL)
          OR (NOT a.self_hosted AND a.status = 'running' AND a.view_visibility = 'public')
        )
      ORDER BY a.self_hosted DESC, (inv.app_id IS NOT NULL) DESC,
               (fa.app_id IS NOT NULL) DESC, fa.sort_order ASC NULLS LAST,
               member_count DESC, a.id ASC
      LIMIT $3`,
    [userId, !!showSelfHosted, SUGGESTION_LIMIT]
  );
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    icon_url: iconUrl(row),
    icon_emoji: row.icon_emoji || null,
    self_hosted: !!row.self_hosted,
    audience: row.audience,
    member_count: Number(row.member_count) || 0,
    invited_by: row.invited_by || null,
    is_member: !!row.is_member,
    detail: suggestionDetail(row),
    // Ticked on arrival: what the person is already in (Homeroom, for any
    // account with platform access) and what they were invited into.
    checked: !!row.is_member || !!row.invited_by,
  }));
}

function parseJoin(raw) {
  if (!Array.isArray(raw)) return { error: 'join must be a list of project slugs' };
  const slugs = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) return { error: 'join must be a list of project slugs' };
    if (!slugs.includes(entry.trim())) slugs.push(entry.trim());
  }
  if (slugs.length > MAX_JOIN) return { error: `Pick at most ${MAX_JOIN}.` };
  return { slugs };
}

/**
 * Answer the join screen: join what was ticked, leave Homeroom if it was
 * unticked, and record the answer. Only what the screen could have offered
 * is honoured — an open community, an invite (accepted through the same
 * function the notification's Accept uses), Homeroom — and anything else in
 * the list is skipped rather than refused, because a community that closed
 * between the screen loading and the answer is not the person's mistake.
 *
 * `acceptInvite(appId)` is injected: the invite path lives with the
 * collaborator routes (services/collab-invites.js) and needs the caller.
 *
 * Every community joined here ends up pinned to Home, whichever branch
 * joins it: communities.join pins Homeroom and an open community, and the
 * accepted invite pins its project inside acceptInvite, as an invite link
 * does. The pin is how the vote digest and a proposal's notification find
 * a member, so an invite accepted here must not be the one join without it.
 *
 * `{ skip: true }` is "Skip for now": the answer is recorded and nothing is
 * joined or left.
 *
 * Returns `{ ok, joined: [slug], left: [slug] }`, or `{ ok: false, status,
 * error }`. A second answer is a 409 with `alreadyDone`, like the username
 * step's.
 */
async function answerJoin(pool, user, body, { showSelfHosted = false, acceptInvite } = {}) {
  const skip = !!(body && body.skip === true);
  const parsed = skip ? { slugs: [] } : parseJoin(body && body.join);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };

  const { rows: flag } = await pool.query(
    'SELECT needs_communities_choice FROM users WHERE id = $1', [user.id]);
  if (!flag[0] || flag[0].needs_communities_choice !== true) {
    return { ok: false, status: 409, error: 'You have already picked your communities.', alreadyDone: true };
  }

  const offered = await joinSuggestions(pool, user.id, { showSelfHosted });
  const bySlug = new Map(offered.map((c) => [c.slug, c]));
  // A community can be answered for that fell off the first eight (it was
  // listed when the screen loaded, and a new one has since overtaken it),
  // so an open community is re-checked on its own rather than only by
  // membership of the list.
  const { rows: found } = parsed.slugs.length ? await pool.query(
    `SELECT id, slug, name, community_id, created_by, self_hosted, status, view_visibility, collab_visibility
       FROM apps WHERE slug = ANY($1::text[])`,
    [parsed.slugs]
  ) : { rows: [] };

  // In the order the screen listed them: the first one joined is the one the
  // Getting started card is about (defaultApp reads joined_at).
  found.sort((a, b) => parsed.slugs.indexOf(a.slug) - parsed.slugs.indexOf(b.slug));
  const joined = [];
  const left = [];
  for (const app of found) {
    if (app.community_id == null) continue;
    const listed = bySlug.get(app.slug);
    if (app.self_hosted) {
      if (!showSelfHosted) continue;
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    } else if (listed && listed.invited_by && typeof acceptInvite === 'function') {
      // The same accept as the notification's, Home pin included.
      const result = await acceptInvite(app);
      if (result && result.ok) joined.push(app.slug);
    } else if (app.status === 'running' && app.view_visibility === 'public') {
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    }
  }

  // Homeroom unticked: the person is in it by default, and this screen is
  // where they said no.
  // Not on a skip: "not now" leaves everything as it was, Homeroom included.
  const self = offered.find((c) => c.self_hosted);
  if (!skip && self && self.is_member && !parsed.slugs.includes(self.slug)) {
    const { rows: selfRows } = await pool.query(
      'SELECT id, slug, created_by FROM apps WHERE slug = $1', [self.slug]);
    if (selfRows[0]) {
      const result = await communities.leave(pool, selfRows[0], user.id);
      if (result.ok) left.push(self.slug);
    }
  }

  // Joined or skipped is kept for the admin Journey page (#3369): the
  // memberships alone cannot tell "Skip for now" from a Join that kept only
  // what was already ticked.
  await pool.query(
    `UPDATE users
        SET needs_communities_choice = FALSE, communities_onboarded_at = NOW(),
            getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object('join_answer', $2::text)
      WHERE id = $1 AND needs_communities_choice = TRUE`,
    [user.id, skip ? 'skipped' : 'joined']
  );
  return { ok: true, joined, left };
}

/**
 * THE DEFAULT APP: the one the card's Try, Vote and Suggest steps are about.
 * The app of the first community the person joined (the earliest membership;
 * the join screen joins in the order it listed them, so a newcomer's is the
 * first one they ticked), leaving out three kinds:
 *
 *   * Homeroom, the platform's own project: it has no app to open, so there
 *     is nothing to try in it, and every account is in it by default;
 *   * a project they made themselves: the Vote step is about somebody
 *     else's change and VOTE_CAST does not count a vote in your own "Just
 *     you" project, so the app the three steps share is somebody else's
 *     where there is one. (Time in, and feedback on, an app they made does
 *     count for the First challenges' Try and Suggest since #4602 and
 *     #4603, so a newcomer who opens their own app first is not wasted.);
 *   * anything they could not open: an app that is not running, one
 *     moderation has suspended, a view-private one they are not a member of.
 *
 * `{ slug, name }` (the buttons open it, the rows name it), or null when
 * they are in none of those. It is not what locks the three steps: that is
 * the Join step's own tick (gettingStarted's `needs_join`), and once Join is
 * ticked with no default app the card falls back to fallbackApp below.
 */
async function defaultApp(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.slug, a.name
       FROM community_members m
       JOIN apps a ON a.community_id = m.community_id
      WHERE m.user_id = $1
        AND a.self_hosted = FALSE
        AND a.created_by IS DISTINCT FROM $1
        AND a.status = 'running'
        AND a.moderation_suspended_at IS NULL
        AND (a.view_visibility = 'public'
             OR EXISTS (SELECT 1 FROM app_collaborators c
                         WHERE c.app_id = a.id AND c.user_id = $1 AND c.status = 'member'))
      ORDER BY m.joined_at ASC, a.id ASC
      LIMIT 1`,
    [userId]
  );
  return rows[0] ? appView(rows[0]) : null;
}

function appView(row) {
  return { slug: row.slug, name: row.name || row.slug };
}

/**
 * THE APP AFTER JOIN WHEN THERE IS NO DEFAULT ONE. Join can be ticked with no
 * default app: somebody who started a public community of their own, or took
 * an invite into a project that is not running yet, is in a community, and
 * every one of its apps is passed over by defaultApp. The three steps are not
 * locked then (a lock under a ticked Join was the inconsistency the
 * first-session test found), so they are about the first app Discover leads
 * with that the person did not make: the admin's featured apps in their
 * order, then the open communities with the most members, the order the
 * join screen offers them in. Anyone can open, look at and send feedback on
 * a public app without joining it.
 *
 * `{ slug, name }`, or null when there is no such app at all, when the
 * client's buttons go to Discover instead.
 */
async function fallbackApp(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.slug, a.name
       FROM apps a
       LEFT JOIN featured_apps fa ON fa.app_id = a.id
      WHERE a.self_hosted = FALSE
        AND a.created_by IS DISTINCT FROM $1
        AND a.status = 'running'
        AND a.moderation_suspended_at IS NULL
        AND a.view_visibility = 'public'
      ORDER BY (fa.app_id IS NOT NULL) DESC, fa.sort_order ASC NULLS LAST,
               (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = a.community_id) DESC,
               a.id ASC
      LIMIT 1`,
    [userId]
  );
  return rows[0] ? appView(rows[0]) : null;
}

/**
 * WHERE THE VOTE STEP GOES. Read from the Needs you feed's own population
 * (routes/workshop-overview.js owedByCommunity: the open proposals and group
 * decisions in projects the person is a member of, not their own, that they
 * have not voted on), so the step and the tab it opens agree:
 *
 *   1. something waiting in the default app: that app's Needs you;
 *   2. else the first project they joined that has something waiting: its
 *      Needs you (Homeroom included where it is listed at all, as the feed
 *      includes it);
 *   3. else nothing anywhere: the default app's Workshop, the page the hub's
 *      "since" card opens, and the visit ticks the step (markWorkshopVisit).
 *
 * "Something waiting" is something a vote on would COUNT (`paying`): never
 * the Homeroom bot's build of the person's own request, nor anything in a
 * project only they are in, which the scorer's VOTE_CAST does not pay for.
 * Otherwise the step would send a newcomer to vote on the first version of
 * their own solo app, and the vote would tick nothing.
 *
 * `{ kind: 'needs' | 'workshop', app, count }`; `count` is what is waiting
 * in `app` (0 for the Workshop), the number its Needs you tab lists.
 */
async function voteTarget(pool, userId, app, opts = {}) {
  const waiting = (await owedByCommunity(pool, userId, opts)).filter((w) => w.paying > 0);
  const here = waiting.find((w) => w.slug === app.slug);
  const there = here || waiting[0];
  if (there) return { kind: 'needs', app: appView(there), count: there.waiting };
  return { kind: 'workshop', app, count: 0 };
}

// The words the tour's row carries. Code, not a challenge: the tour pays
// nothing, and there is nothing for an admin to rename.
const TOUR_STEP = Object.freeze({
  title: 'Take the 1-minute tour',
  detail: 'See how Homeroom works.',
});

/**
 * What a First challenge's button does, chosen by the MEASURE of the scoring
 * rule bound to it, which is the one thing about a step that says what it
 * asks for: the title, the task and the order are the admin's prose, and
 * change. The button goes to where the action is; it never ticks the step (a
 * row is done when its credit is written).
 *
 *   COMMUNITY_JOINED   `join`     Discover, where communities are joined
 *   TRY_APPS           `try`      the default app, opened
 *   VOTE_CAST          `vote`     voteTarget: a Needs you, or the Workshop
 *   FEEDBACK_SENT      `suggest`  the "Suggest an improvement" dialog, for the
 *   USEFUL_FEEDBACK               default app (the measure "Suggest an
 *                                 improvement" is scored by until an admin
 *                                 rebinds it to FEEDBACK_SENT)
 *
 * Anything else (no rule, or a measure added later) is `other`: a plain
 * button with the challenge's own call-to-action label, to its CTA when that
 * is a place in the shell (a `#` route), else its own page on the Challenges
 * tab, which carries the CTA whatever it is. An admin-typed URL is never
 * followed from here.
 */
function stepAction(step) {
  switch (String(step.measure || '').trim().toUpperCase()) {
    case 'COMMUNITY_JOINED': return { action: 'join', href: '#apps' };
    case 'TRY_APPS': return { action: 'try', href: null };
    case 'VOTE_CAST': return { action: 'vote', href: null };
    case 'FEEDBACK_SENT':
    case 'USEFUL_FEEDBACK':
      return { action: 'suggest', href: null };
    default: break;
  }
  const cta = typeof step.cta_link === 'string' ? step.cta_link.trim() : '';
  const label = typeof step.cta_label === 'string' ? step.cta_label.trim() : '';
  return {
    action: 'other',
    href: /^#[a-z]/i.test(cta) ? cta
      : `#leaderboard/challenges/${Number(step.season_event_id)}/${Number(step.id)}`,
    cta: label || null,
  };
}

// The answer for an account the card is not showing for: the same shape,
// nothing in it.
function noCard() {
  return {
    show: false, complete: false, steps: [], done: 0, total: 0, earned_points: 0,
    unlocks: { count: 0, names: [] }, needs_join: false, app: null, vote: null,
    try_seconds: TRY_APPS_MIN_SECONDS,
  };
}

// Whether the card is showing for this account: a new account
// (`getting_started_gate`), however it signed up (#4601: the join screen,
// "What do you want to make?" or an invite link), that has not closed the
// card. The one rule GET /api/auth/me's `showGettingStarted` spells too.
const CARD_SQL = `
  SELECT getting_started_closed_at, getting_started_gate,
         tour_done_at
    FROM users WHERE id = $1`;

function cardShows(u) {
  return !!(u && u.getting_started_gate && !u.getting_started_closed_at);
}

/**
 * The card: `{ show, complete, steps, done, total, earned_points, unlocks,
 * needs_join, app, vote, try_seconds }`.
 *
 * `show` is false for an account the card is not for (one made before the
 * list shipped) and once it is closed; the client draws nothing then, and nothing else is read.
 *
 * `steps` is the tour, then the season's First challenges in the admin's
 * order, each `{ id, kind, action, title, detail, done, href, cta?, reward,
 * earned_points, challenge_id?, event_id? }`. `kind` is 'tour' or
 * 'challenge'; `action` is what its button does (stepAction: 'tour', 'join',
 * 'try', 'vote', 'suggest' or 'other'); `detail` is the challenge's own task,
 * which the client shows once the step is done and, for the steps about an
 * app, replaces with words about that app until then; `reward` is the
 * challenge's own words ("500 pts", or prose), null for the tour;
 * `earned_points` is what the person has been paid on it, this season or an
 * earlier one, the same credits its "done" reads.
 *
 * `needs_join` is THE ONE GATE on Try, Vote and Suggest (first-session
 * test, 2026-10-03): true while the season's Join step (the one whose action
 * is `join`) is not done, false when it is or when the season has none. The
 * client locks the three on it and on nothing else, so the lock and the
 * Join row's tick always agree. It used to lock on "no default app", which
 * disagreed both ways: keeping Homeroom ticked showed no lock and no tick,
 * and a person in a community of their own making saw a ticked Join over
 * three locked rows. Neither Homeroom nor a project only you are in counts
 * as joining (COMMUNITY_JOINED), and so neither unlocks them.
 *
 * `app` is the default app (defaultApp), the one Try, Vote and Suggest are
 * about; once Join is ticked and there is no default app, the first app
 * Discover leads with that they did not make (fallbackApp); else null, and
 * the client sends the three to Discover. `vote` is where the Vote step goes
 * (voteTarget), or null without an app. Both are read only while a step that
 * needs them is not done (and while `needs_join`, though the client draws
 * neither then). `try_seconds` is the floor Try an app counts from, so the
 * row says the number the scorer uses.
 *
 * `complete` is the gate's own answer (challenge-onboarding.js `finished`):
 * the tour and every challenge done, or let through on an earlier read. It is
 * the card's "You’re all set" state, and only then does the client offer the
 * close button.
 *
 * `unlocks` is what finishing lets the person see: how many of the season's
 * open challenges are not First challenges, and the first few of their names
 * (home-panels.js gateUnlocks, the set the gate hides while it is closed).
 * Zero where nothing is gated: a season with no First challenges, or none at
 * all.
 */
async function gettingStarted(pool, userId, { showSelfHosted = false, isAdmin = false } = {}) {
  const { rows: userRows } = await pool.query(CARD_SQL, [userId]);
  const u = userRows[0];
  const show = cardShows(u);
  if (!show) return noCard();
  const tourDone = !!u.tour_done_at;

  const season = await fetchCurrentSeason(pool);
  const onboarding = season ? await loadOnboarding(pool, userId, { seasonId: season.id }) : null;

  const steps = [{
    // The client draws this row with a Start button and asks for the tour
    // itself; there is nowhere to navigate, so no href.
    id: 'tour',
    kind: 'tour',
    action: 'tour',
    title: TOUR_STEP.title,
    detail: TOUR_STEP.detail,
    done: tourDone,
    href: null,
    reward: null,
    earned_points: 0,
  }];
  for (const s of (onboarding ? onboarding.steps : [])) {
    const progress = onboarding.progress.get(Number(s.id));
    steps.push({
      id: `challenge-${Number(s.id)}`,
      kind: 'challenge',
      challenge_id: Number(s.id),
      event_id: Number(s.season_event_id),
      title: String(s.goal || '').trim(),
      detail: String(s.task || '').trim(),
      done: !!(progress && progress.done),
      reward: s.reward == null ? null : String(s.reward).trim() || null,
      earned_points: Number(s.earned_points) || 0,
      ...stepAction(s),
    });
  }
  // The one gate on Try, Vote and Suggest: the Join step's own tick, or
  // nothing to wait on when the season has no Join step.
  const joinStep = steps.find((s) => s.action === 'join');
  const joined = joinStep ? joinStep.done : true;
  // The app, and where Vote goes, only while a step that needs them is
  // still to do: a finished list reads neither.
  const pending = (action) => steps.some((s) => s.action === action && !s.done);
  const needsApp = pending('try') || pending('vote') || pending('suggest');
  let app = needsApp ? await defaultApp(pool, userId) : null;
  if (needsApp && !app && joined) app = await fallbackApp(pool, userId);
  const vote = app && pending('vote') ? await voteTarget(pool, userId, app, { showSelfHosted, isAdmin }) : null;
  const unlocks = onboarding && season
    ? await gateUnlocks(pool, season.id, onboarding.ids, { limit: UNLOCK_NAMES })
    : { count: 0, names: [] };
  return {
    show,
    complete: onboarding ? onboarding.finished : tourDone,
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
    earned_points: steps.reduce((sum, s) => sum + (Number(s.earned_points) || 0), 0),
    unlocks,
    needs_join: !joined,
    app,
    vote,
    try_seconds: TRY_APPS_MIN_SECONDS,
  };
}

/**
 * THE VOTE STEP'S WORKSHOP VISIT (evan, 2026-10-01). When nothing is up for
 * a vote in any project the person is a member of, the Vote step cannot be
 * done by voting, so its button reads "Look" and opens the default app's
 * Workshop, and looking is the step. The card sends this when that page has
 * opened from its button; the scorer's VOTE_CAST counts the recorded visit
 * like a vote (challenge-scorer.js VOTE_CAST_SQL), one credit either way.
 *
 * The server decides, not the button. A visit is recorded only for an
 * account the card is showing for, and only when nothing is waiting for its
 * vote right now that a vote would count for, by the Needs you feed's own
 * count (owedByCommunity's `paying`, the same count voteTarget reads): a
 * visit while such a vote IS waiting is refused (409, `waiting`), because
 * then the step is to vote. The Homeroom bot's first version of the person's
 * own solo app waiting for them does not hold it: voting on that pays
 * nothing, so it is not the step. Stored as
 * `users.getting_started_seen.vote_workshop`, the last such visit (a later
 * one inside a new challenge window counts there); not the column's old
 * `workshop` key, which the retired card wrote on any Workshop visit,
 * whether or not a vote was waiting.
 */
async function markWorkshopVisit(pool, userId, { showSelfHosted = false, isAdmin = false } = {}) {
  const { rows } = await pool.query(CARD_SQL, [userId]);
  if (!cardShows(rows[0])) {
    return { ok: false, status: 409, error: 'There is no Getting started card to tick.' };
  }
  const waiting = (await owedByCommunity(pool, userId, { showSelfHosted, isAdmin }))
    .reduce((sum, w) => sum + w.paying, 0);
  if (waiting > 0) {
    return { ok: false, status: 409, error: 'Something is waiting for your vote.', waiting };
  }
  await pool.query(
    `UPDATE users
        SET getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object('vote_workshop', NOW())
      WHERE id = $1`,
    [userId]
  );
  return { ok: true };
}

/**
 * An admin's "Reset first run" (Admin → Users → ⋯): put an account back to a
 * new account's first run, so its next load shows the join screen, then the
 * tour, then the Getting started card. The tour's "done" is cleared here too
 * (`tour_done_at`), so it follows the join screen on every device, not just
 * in the browser that shows the screen (frontend/src/features/home/tour).
 *
 * It resets the first run and nothing the account owns: its communities,
 * Home tiles, username and terms answer stay as they are. The join screen
 * shows what it is already in, ticked. Returns `{ id, username }`, or null
 * when there is no such account.
 *
 * It also puts the account on the Getting started list as a NEW account
 * (`getting_started_gate`, and the gate closed again: `_unlocked_at`), so the
 * card, and the season it gates, come back whatever the account was made
 * before. That is how an admin tries the first run on an existing
 * account. Credits it already earned stay: a First challenge it has done is
 * still ticked.
 */
async function resetFirstRun(pool, userId) {
  const { rows } = await pool.query(
    `UPDATE users
        SET needs_communities_choice = TRUE,
            communities_onboarded_at = NULL,
            getting_started_closed_at = NULL,
            getting_started_seen = NULL,
            tour_done_at = NULL,
            getting_started_gate = TRUE,
            getting_started_unlocked_at = NULL
      WHERE id = $1
      RETURNING id, username`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * The card's close button, which the card offers only once its list is done
 * ("You’re all set"). Refused before that: the list is what the rest of the
 * season waits on, and a card closed half-way would leave the season locked
 * behind a list nobody can see any more.
 */
async function closeCard(pool, userId, opts = {}) {
  const card = await gettingStarted(pool, userId, opts);
  if (card.show && !card.complete) {
    return { ok: false, status: 409, error: 'Finish Getting started first.' };
  }
  await pool.query(
    `UPDATE users SET getting_started_closed_at = NOW()
      WHERE id = $1 AND getting_started_closed_at IS NULL`,
    [userId]
  );
  return { ok: true };
}

/**
 * The welcome tour's Finish and Skip, and a browser that finished it before
 * the account kept the answer copying its own flag here once. Idempotent: the
 * first finish is the one recorded, and a replay finished later changes
 * nothing.
 */
// How the tour ended, for the admin Journey page (#3369): Next on the last
// step, Skip, or a browser copying an older local "done" onto the account.
// Kept with the furthest step, the first time only, beside tour_done_at.
const TOUR_ENDS = Object.freeze(new Set(['finish', 'skip', 'backfill']));
const TOUR_MAX_STEP = 20;

function parseTourEnd(body) {
  const ended = body && TOUR_ENDS.has(body.ended) ? body.ended : null;
  const step = body && Number.isInteger(body.step) && body.step >= 0 && body.step <= TOUR_MAX_STEP
    ? body.step : null;
  return { ended, step };
}

async function markTourDone(pool, userId, body) {
  const { ended, step } = parseTourEnd(body);
  await pool.query(
    `UPDATE users
        SET tour_done_at = NOW(),
            getting_started_seen = CASE WHEN $2::text IS NULL THEN getting_started_seen
              ELSE COALESCE(getting_started_seen, '{}'::jsonb)
                   || jsonb_build_object('tour_ended', $2::text, 'tour_step', $3::int) END
      WHERE id = $1 AND tour_done_at IS NULL`,
    [userId, ended, step]
  );
  return { ok: true };
}

module.exports = {
  SUGGESTION_LIMIT,
  MAX_JOIN,
  STARTER_DETAILS,
  joinSuggestions,
  suggestionDetail,
  parseJoin,
  answerJoin,
  defaultApp,
  fallbackApp,
  voteTarget,
  stepAction,
  gettingStarted,
  markWorkshopVisit,
  closeCard,
  markTourDone,
  resetFirstRun,
};
