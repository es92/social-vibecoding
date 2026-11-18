// What the bell says about a change once it is decided: the author's "your
// change is live" (pr_merged) and its voters' (voted_change_merged), and the
// asks it settles. The went-live rows leave the bell's list on the merge too
// (MERGED_HIDDEN_KINDS, #5487); the merge-followups machine writes them
// inside its transaction; services/notifications.js re-exports them for
// [main]'s merge, its included changes and every close.

import type { Queryable } from './db.ts';
import { filterUsersByCategory, kindAllowed } from './notification-preferences.ts';

// 5 October (Page Turners): what a "Waiting for your approval" digest
// (services/vote-digest.js) counted that still waits on its reader: changes
// still up for approval, put up before it was sent, in a project they have a
// stake in (the digest's own PENDING_SQL), not theirs, not voted on by them
// since, and not in a project they blocked. A digest that named its one
// change counts only that one. Never more than the digest said: a project
// pinned since it was sent is not what it counted. Reads `n` (the
// notification) and is evaluated only for a digest's row.
//
// The settle below counts with one more condition, `waiting.id IS DISTINCT
// FROM $4` (the change being decided, or NULL): in the merge-followups
// machine's transaction the change still reads 'promoted' when it settles,
// because its projection writes 'merged' after the domain writes.
const DIGEST_WAITING_HEAD = `LEAST((
  SELECT COUNT(DISTINCT waiting.id)::int FROM chat_sessions waiting
   WHERE waiting.status = 'promoted'
`;
const DIGEST_WAITING_TAIL = `     AND COALESCE(waiting.promoted_at, waiting.created_at) <= n.created_at
     AND (n.session_id IS NULL OR waiting.id = n.session_id)
     AND waiting.user_id IS DISTINCT FROM n.user_id
     AND (EXISTS (SELECT 1 FROM app_stakes stake WHERE stake.app_id = waiting.app_id AND stake.user_id = n.user_id)
          OR EXISTS (SELECT 1 FROM apps made WHERE made.id = waiting.app_id AND made.created_by = n.user_id))
     AND NOT EXISTS (SELECT 1 FROM user_app_blocks waiting_block
                      WHERE waiting_block.user_id = n.user_id AND waiting_block.app_id = waiting.app_id)
     AND NOT EXISTS (SELECT 1 FROM pr_votes waiting_vote
                      WHERE waiting_vote.session_id = waiting.id AND waiting_vote.user_id = n.user_id)
     -- "One story": as vote-digest.js counts, not a change Homeroom bot
     -- built for a request this reader asked for.
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs waiting_run
                       JOIN homeroom_bot_requesters waiting_asker
                         ON waiting_asker.app_id = waiting_run.app_id AND waiting_asker.issue_number = waiting_run.issue_number
                      WHERE waiting_run.proposal_session_id = waiting.id AND waiting_asker.user_id = n.user_id)
), CASE WHEN n.detail ~ '^[0-9]{1,6}$' THEN n.detail::int ELSE 99 END)`;
export const DIGEST_WAITING_SQL = `${DIGEST_WAITING_HEAD}${DIGEST_WAITING_TAIL}`;
const DIGEST_WAITING_BUT_DECIDED_SQL = `${DIGEST_WAITING_HEAD}     AND waiting.id IS DISTINCT FROM $4::int
${DIGEST_WAITING_TAIL}`;

// #1688: `credits` is the "Backed by alice and bob, shaped by carol." sentence
// for a merge the vote carried; it rides in `detail`, which a force merge
// uses for its own marker, so the two never meet.
//
// #4787: `alsoVoters` writes the voters' rows (createVotedChangeMergedNotifications)
// in the same call. The author's mute of pr_merged says nothing about the
// voters: each side asks its own preference. Here a failure on the voters'
// side throws, as it would abort the caller's transaction anyway;
// services/notifications.js isolates it for a caller outside one.
export async function createPrMergedNotification(
  pool: Queryable,
  { userId, appId, sessionId, forced = false, credits = null, alsoVoters = false }:
    { userId: number | null; appId: number; sessionId: number; forced?: boolean; credits?: string | null; alsoVoters?: boolean },
  allows: (db: Queryable, q: { userId: number | null; appId?: number | null; kind: string }) => Promise<boolean> = kindAllowed,
): Promise<any[]> {
  const created: any[] = [];
  if (userId && sessionId && await allows(pool, { userId, appId, kind: 'pr_merged' })) {
    const detail = forced
      ? 'forced'
      : (typeof credits === 'string' && credits.trim() ? credits.trim().slice(0, 255) : null);
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
       SELECT $1, $2, $3, NULL, 'pr_merged', $4
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = $1 AND n.session_id = $3 AND n.kind = 'pr_merged'
        )
       RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
      [userId, appId, sessionId, detail]
    );
    created.push(...rows);
  }
  if (alsoVoters && sessionId) {
    created.push(...await createVotedChangeMergedNotifications(pool, { appId, sessionId, authorId: userId ?? null }));
  }
  return created;
}

// #6100: the author's "your change was closed". Why is not stored here: the
// row reads the reason the close recorded (chat_sessions.close_reason) and
// the bell words it from its catalog. System-generated like pr_merged, so
// source_user_id stays null. Nobody is told about a close they made
// themselves (`byOwner`), and a synthetic account (Homeroom bot's own
// changes) gets nothing.
// A retried event is stopped by the NOT EXISTS on (user, session, kind,
// detail), its detail naming the event; a change reopened and closed again
// is a new event, and a new row.
export async function createChangeClosedNotification(
  pool: Queryable,
  { userId, appId, sessionId, eventId, byOwner = false }:
    { userId: number | null; appId: number; sessionId: number; eventId: number | string; byOwner?: boolean },
  allows: (db: Queryable, q: { userId: number | null; appId?: number | null; kind: string }) => Promise<boolean> = kindAllowed,
): Promise<any[]> {
  if (!userId || byOwner || !sessionId) return [];
  if (!await allows(pool, { userId, appId, kind: 'change_closed' })) return [];
  const detail = `event:${eventId}`;
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1::int, $2::int, $3::int, NULL, 'change_closed', $4::varchar
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = $1::int AND u.is_synthetic = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = $1::int AND n.session_id = $3::int AND n.kind = 'change_closed' AND n.detail = $4::varchar
        )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, detail]
  );
  return rows;
}

// #4787: the change a person voted on went live. Until this, only its author
// heard a merge; everybody who had a say had to stumble on the news.
//
// System-generated like pr_merged (source_user_id stays null: the group's
// decision arriving, not a person doing something to you), one row per voter
// per session, the author never double-told: their pr_merged row stays the
// only one they get. A retried or repeated merge is stopped by the NOT
// EXISTS on (voter, session, kind), as for its neighbours. `filter` is how
// the voters' preference is read: services/notifications.js passes
// services/notification-preferences.js's export, so a test that stubs that
// module still reaches the read it stubbed.
export async function createVotedChangeMergedNotifications(
  pool: Queryable,
  { appId, sessionId, authorId }: { appId: number; sessionId: number | null; authorId: number | null },
  filter: typeof filterUsersByCategory = filterUsersByCategory,
): Promise<any[]> {
  if (!sessionId) return [];
  // The voters are rows in pr_votes, and none of the three merge paths has
  // their ids, so the producer reads them itself: every row, whatever its
  // revision, yes or no; a no voter had a say too. "One story": not whoever
  // asked Homeroom bot for the change, whom the bot's own message tells it
  // is live (homeroom-bot-dm.js); one ping per person.
  const { rows: voted } = await pool.query(
    `SELECT v.user_id, v.vote FROM pr_votes v
      WHERE v.session_id = $1 AND v.user_id IS NOT NULL
        AND v.user_id NOT IN (${BOT_REQUESTERS_SQL})`,
    [Number(sessionId)]
  );
  const yes = new Set(voted.filter((row: { vote: unknown }) => row.vote === 'yes').map((row: { user_id: unknown }) => Number(row.user_id)));
  const ids = [...new Set<number>(voted
    .map((row: { user_id: unknown }) => Number(row.user_id))
    .filter((id: number) => Number.isFinite(id) && id !== Number(authorId)))];
  if (!ids.length) return [];
  const allowed = await filter(pool, {
    userIds: ids, appId, categoryKey: 'voted_changes_live',
  });
  if (!allowed.length) return [];
  const values: string[] = [];
  const params: unknown[] = [appId, sessionId];
  allowed.forEach((userId) => {
    params.push(userId);
    // Cast the columns: the VALUES row's parameters are otherwise typed
    // text, and `n.user_id = v.user_id` in the NOT EXISTS is then an
    // integer = text comparison Postgres refuses. `detail` is 'yes' when
    // their vote was ("It's live. You voted yes.").
    const detail = yes.has(Number(userId)) ? "'yes'::text" : 'NULL::text';
    values.push(`($${params.length}::int, $1::int, $2::int, NULL::int, 'voted_change_merged'::text, ${detail})`);
  });
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT v.user_id, v.app_id, v.session_id, v.source_user_id, v.kind, v.detail
       FROM (VALUES ${values.join(', ')}) AS v (user_id, app_id, session_id, source_user_id, kind, detail)
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = v.user_id AND n.session_id = v.session_id
           AND n.kind = 'voted_change_merged'
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    params
  );
  return rows;
}

// "One story": who asked Homeroom bot for the change `$1` it built (its
// requester). The bot tells them about it itself, in their chat with it, so
// the platform does not ping them a second time.
export const BOT_REQUESTERS_SQL = `SELECT q.user_id
     FROM homeroom_bot_runs r
     JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
    WHERE r.proposal_session_id = $1`;

// 5 October (Page Turners): the asks about a change that its decision
// answers for everybody. Nobody is asked to vote on it, to say they still
// back it, or to revive it once it is live or closed, and a digest that
// named it alone has nothing left to count. "Ready to try" (change_ready) is
// settled apart, because a change that went live makes it news.
export const DECIDED_ASK_KINDS: readonly string[] = Object.freeze(['pr_proposed', 'stale_pr', 'revision_recheck', 'vote_digest', 'release_hold']);

/**
 * "Waiting for your approval" digests that no longer count anything
 * (DIGEST_WAITING_SQL is 0) are read: of `userIds`, or of the people with a
 * stake in `appId` (its favoriters and its creator, as the digest reads
 * them), sent since `since` when given. One of the two scopes is required,
 * so it never reads every digest on the platform. Resolves the ids of the
 * people whose bell changed.
 */
export async function settleVoteDigests(
  pool: Queryable,
  { userIds = null, appId = null, since = null, decided = null }:
    { userIds?: unknown[] | null; appId?: unknown; since?: unknown; decided?: number | null } = {},
): Promise<number[]> {
  const ids = Array.isArray(userIds)
    ? [...new Set(userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : null;
  const app = Number.isSafeInteger(Number(appId)) && Number(appId) > 0 ? Number(appId) : null;
  if (!(ids && ids.length) && !app) return [];
  const { rows } = await pool.query(
    `UPDATE notifications n SET read_at = NOW()
      WHERE n.kind = 'vote_digest' AND n.read_at IS NULL
        AND ($1::int[] IS NULL OR n.user_id = ANY($1::int[]))
        AND ($2::int IS NULL OR n.user_id IN (
              SELECT stake.user_id FROM app_stakes stake WHERE stake.app_id = $2
              UNION
              SELECT made.created_by FROM apps made WHERE made.id = $2 AND made.created_by IS NOT NULL))
        AND ($3::timestamptz IS NULL OR n.created_at >= $3::timestamptz)
        AND ${DIGEST_WAITING_BUT_DECIDED_SQL} = 0
      RETURNING n.user_id`,
    [ids && ids.length ? ids : null, app, since || null, decided]
  );
  return [...new Set(rows.map((row) => Number(row.user_id)))];
}

/**
 * 5 October (Page Turners): change `sessionId` was decided, live
 * ('merged') or closed ('archived'), so the bell stops asking about it:
 *
 *   - the asks it answered (DECIDED_ASK_KINDS) are read;
 *   - "ready to try" rows are read, whatever the decision. #4795: on a
 *     merge they leave the list altogether (services/notifications.js
 *     listForUser hides them for a merged change), so the rule that re-opened
 *     the newest one as the unread news that it is live is retired: the news
 *     now arrives as its own row (pr_merged to the author,
 *     voted_change_merged to the voters), which a person who was asked to
 *     try the change and never voted also does not get; those rows leave
 *     the list on the merge too, unread or read (#5487), with the rest of
 *     MERGED_HIDDEN_KINDS;
 *   - digests of several changes it was the last one waiting in are read.
 *
 * Everyone whose bell changed is returned, to hear `notifications_changed`
 * (which also re-badges their phone, mobile-push-badge.js): the merge-followups
 * machine pushes it with its transition, services/notifications.js after. A change still up for
 * approval (or gone) is left alone. Resolves the ids of the people told.
 * Callers run it after the change's status is written: the merge
 * (routes/votes.js), a change carried by another's merge
 * (merge-followups/facts.ts) and every close (session-lifecycle.js
 * finalizeArchivedSession).
 *
 * `status` stands for the row's when the caller decides it in the same
 * transaction and writes it afterwards (the merge-followups workflow
 * machine); the digests then count the change as decided too.
 */
export async function settleDecidedChange(pool: Queryable, sessionId: unknown, { status = null }: { status?: string | null } = {}): Promise<number[]> {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const { rows: [session] } = await pool.query(
    `SELECT id, app_id, status, COALESCE(promoted_at, created_at) AS asked_from
       FROM chat_sessions WHERE id = $1`,
    [id]
  );
  if (session && status) session.status = status;
  if (!session || (session.status !== 'merged' && session.status !== 'archived')) return [];
  const touched = new Set<number>();
  const note = (rows: { user_id: unknown }[]) => { for (const row of rows) touched.add(Number(row.user_id)); };

  note((await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE session_id = $1 AND read_at IS NULL AND kind = ANY($2::text[])
      RETURNING user_id`,
    [id, DECIDED_ASK_KINDS]
  )).rows);

  // #4795: both decisions read every "ready to try" about the change. On a
  // merge the rows leave the list (MERGED_HIDDEN_KINDS in
  // services/notifications.js listForUser); on a close they stay, where the
  // bell words them Closed.
  note((await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE session_id = $1 AND kind = 'change_ready' AND read_at IS NULL
      RETURNING user_id`,
    [id]
  )).rows);

  // "One story": the requester's own "ready to try" from Homeroom bot. It is
  // a row of their chat with the bot, which knows its change only through
  // the message it rang for (metadata.homeroomBot.sessionId), so it is
  // linked to the change here, and read: hidden on a merge
  // (MERGED_HIDDEN_KINDS), kept on a close. Found through the change's
  // requester, whose rows the per-user index holds.
  note((await pool.query(
    `UPDATE notifications n SET session_id = $1, read_at = COALESCE(n.read_at, NOW())
       FROM conversation_messages m
      WHERE n.user_id IN (${BOT_REQUESTERS_SQL})
        AND n.kind = 'build_ready'
        AND (n.session_id IS NULL OR (n.session_id = $1 AND n.read_at IS NULL))
        AND m.id = n.conversation_message_id
        AND m.metadata->'homeroomBot'->>'sessionId' = $1::text
      RETURNING n.user_id`,
    [id]
  )).rows);

  // 5 Nov 2026: a "ready to try" the request's stage rang (work-state.js
  // bellPushes) carries its change already, and no message: read, so a merge
  // hides it and a close words it Closed, as the message-rung one above.
  note((await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE session_id = $1 AND kind = 'build_ready' AND conversation_message_id IS NULL AND read_at IS NULL
      RETURNING user_id`,
    [id]
  )).rows);

  for (const userId of await settleVoteDigests(pool, { appId: session.app_id, since: session.asked_from, decided: id })) {
    touched.add(userId);
  }
  return [...touched];
}

// A proposal whose checks cannot run (its preview will not start): its
// author's 'check_failed', at most one unread per proposal. The preview
// machine writes it in the transition that records the failure, where a
// preference read that fails fails the event (`kindAllowed`);
// services/notifications.js passes `allowsKind`, which fails open.
export async function createCheckFailedNotification(
  db: Queryable, { userId, appId, sessionId }: { userId: number | null; appId: number | null; sessionId: number | null },
  allowed: typeof kindAllowed = kindAllowed,
): Promise<any[]> {
  if (!userId || !sessionId) return [];
  if (!await allowed(db, { userId, appId, kind: 'check_failed' })) return [];
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT $1, $2, $3, NULL, 'check_failed'
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'check_failed' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}
