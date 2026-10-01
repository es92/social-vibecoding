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
 * Pressing a row goes to where its action is, chosen by the MEASURE of the
 * scoring rule bound to its challenge (stepAction below), and never ticks it.
 *
 * Who sees it: an account made since the list shipped
 * (`users.getting_started_gate`) that has come through the join screen, until
 * it closes the card, which it can do once the list is done. The same
 * accounts, and only they, find the rest of the season locked until then;
 * everyone who was already here sees the whole season and no card. An
 * account that signs up from an invite link is a new account like any other:
 * the email sign-up sets both flags, the invite joins it to its community,
 * and the join screen still asks, with that community already ticked, so it
 * gets the card too.
 *
 * ── The tour ───────────────────────────────────────────────────────────
 *
 * Only whether it is done (`users.tour_done_at`), which ticks the card's
 * first row on every device. The tour itself is all client
 * (frontend/src/features/home/tour).
 */

const communities = require('./communities');
const { loadOnboarding } = require('./topochain/challenge-onboarding');
const { fetchCurrentSeason, gateUnlocks } = require('../routes/home-panels');

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
  // Getting started card is about (focusCommunity reads joined_at).
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

  await pool.query(
    `UPDATE users
        SET needs_communities_choice = FALSE, communities_onboarded_at = NOW()
      WHERE id = $1 AND needs_communities_choice = TRUE`,
    [user.id]
  );
  return { ok: true, joined, left };
}

/**
 * The community a first step goes to when it needs one ("Try an app" opens
 * its app): the first the person joined on the join screen, else the first
 * they joined at all, else Homeroom. Their own projects are not it: trying
 * an app you started alone is not what the step asks, and the measure behind
 * it does not count one.
 */
async function focusCommunity(pool, userId, { showSelfHosted = false } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.self_hosted
       FROM community_members m
       JOIN apps a ON a.community_id = m.community_id
      WHERE m.user_id = $1
        AND (a.created_by IS NULL OR a.created_by <> $1)
        AND (NOT a.self_hosted OR $2::boolean)
      ORDER BY a.self_hosted ASC,
               (m.source IN ('joined', 'collaborator')) DESC,
               m.joined_at ASC, a.id ASC
      LIMIT 1`,
    [userId, !!showSelfHosted]
  );
  return rows[0] || null;
}

// The words the tour's row carries. Code, not a challenge: the tour pays
// nothing, and there is nothing for an admin to rename.
const TOUR_STEP = Object.freeze({
  title: 'Take the 1-minute tour',
  detail: 'See how Homeroom works.',
});

/**
 * Where pressing a First challenge's row goes: to where its action is, never
 * to a tick (a row is done when its credit is written, not when it is
 * pressed). Chosen by the MEASURE of the scoring rule bound to the challenge,
 * which is the one thing about a step that says what it asks for: the title,
 * the task and the order are the admin's prose, and change.
 *
 *   COMMUNITY_JOINED          Discover, where communities are joined
 *   TRY_APPS                  the app of the community the person joined
 *                             first, else Discover (Homeroom has no app of
 *                             its own to open, and the measure does not count
 *                             your own)
 *   VOTE_CAST                 the Communities tab, whose page opens on Needs
 *                             you: what is waiting for a vote
 *   FEEDBACK_SENT             the "Ask for a change" dialog itself
 *   USEFUL_FEEDBACK           (`action: 'feedback'`; the measure "Suggest an
 *                             improvement" is scored by until an admin
 *                             rebinds it to FEEDBACK_SENT)
 *
 * Anything else (no rule, or a measure added later) goes where the challenge
 * itself says: its call-to-action when that is a place in the shell (a `#`
 * route), else its own page on the Challenges tab, which carries the CTA
 * whatever it is. An admin-typed URL is never followed from here.
 */
function stepAction(step, focus) {
  switch (String(step.measure || '').trim().toUpperCase()) {
    case 'COMMUNITY_JOINED': return { href: '#apps' };
    case 'TRY_APPS':
      return focus && !focus.self_hosted ? { href: null, slug: focus.slug } : { href: '#apps' };
    case 'VOTE_CAST': return { href: '#communities' };
    case 'FEEDBACK_SENT':
    case 'USEFUL_FEEDBACK':
      return { href: null, action: 'feedback' };
    default: break;
  }
  const cta = typeof step.cta_link === 'string' ? step.cta_link.trim() : '';
  if (/^#[a-z]/i.test(cta)) return { href: cta };
  return { href: `#leaderboard/challenges/${Number(step.season_event_id)}/${Number(step.id)}` };
}

// The answer for an account the card is not showing for: the same shape,
// nothing in it.
function noCard() {
  return {
    show: false, complete: false, steps: [], done: 0, total: 0, earned_points: 0,
    unlocks: { count: 0, names: [] },
  };
}

/**
 * The card: `{ show, complete, steps, done, total, earned_points, unlocks }`.
 *
 * `show` is false for an account the card is not for (one made before the
 * list shipped, or one that has not answered the join screen yet) and once it
 * is closed; the client draws nothing then, and nothing else is read.
 *
 * `steps` is the tour, then the season's First challenges in the admin's
 * order, each `{ id, kind, title, detail, done, href, slug?, action?,
 * reward, earned_points, challenge_id?, event_id? }`. `kind` is 'tour' or
 * 'challenge'; `reward` is the challenge's own words ("500 pts", or prose),
 * null for the tour; `earned_points` is what the person has been paid on it,
 * this season or an earlier one, the same credits its "done" reads.
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
async function gettingStarted(pool, userId, { showSelfHosted = false } = {}) {
  const { rows: userRows } = await pool.query(
    `SELECT communities_onboarded_at, getting_started_closed_at, getting_started_gate,
            tour_done_at
       FROM users WHERE id = $1`,
    [userId]
  );
  const u = userRows[0];
  const show = !!(u && u.getting_started_gate && u.communities_onboarded_at && !u.getting_started_closed_at);
  if (!show) return noCard();
  const tourDone = !!u.tour_done_at;

  const season = await fetchCurrentSeason(pool);
  const onboarding = season ? await loadOnboarding(pool, userId, { seasonId: season.id }) : null;
  // The community only a TRY_APPS step goes to, so only read for one.
  const focus = onboarding && onboarding.steps.some((s) => String(s.measure || '').trim().toUpperCase() === 'TRY_APPS')
    ? await focusCommunity(pool, userId, { showSelfHosted }) : null;

  const steps = [{
    // The client draws this row with a Start button and asks for the tour
    // itself; there is nowhere to navigate, so no href.
    id: 'tour',
    kind: 'tour',
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
      ...stepAction(s, focus),
    });
  }
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
  };
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
 * card, and the season it gates, follow the join screen whatever the account
 * was made before. That is how an admin tries the first run on an existing
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
async function markTourDone(pool, userId) {
  await pool.query(
    `UPDATE users SET tour_done_at = NOW()
      WHERE id = $1 AND tour_done_at IS NULL`,
    [userId]
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
  focusCommunity,
  stepAction,
  gettingStarted,
  closeCard,
  markTourDone,
  resetFirstRun,
};
