'use strict';

// Which before & after stills a visitor who is not signed in may see: the
// pictures on a public project's changes up for a vote (the guest project
// page, services/public-project.js) and an invite link's picture
// (services/community-invites.js pictureFor).
//
// The copies the shots are taken on start from the app's own data, so a
// still can show real people's names, what they wrote, email addresses or
// other projects; two of the shots agent's three accounts are admins, who
// see private projects too. So a still is public only when ALL of these
// hold:
//
//   * its project is public and listed (the public directory's own rule,
//     public-app-directory.js), never the platform's own app, whose shots
//     are taken as admins;
//   * its run is the change's current, verified one;
//   * its declared change was shot as the ordinary member account
//     (usernode-capture), on a phone-sized screen (narrower than 768px,
//     visible-changes.js phoneScreen);
//   * it is a light still, the element shot or the whole screen;
//   * the shots agent said, as it saved it, that it shows no real person's
//     name, words or email address and no other project
//     (shot_artifacts.public_safe, set from save_shot's showsPrivate).
//
// A change whose stills do not all pass shows without pictures.

const PHONE_WIDTH_BELOW = 768;

// The rows a change's public stills come from. `scope` narrows it to a set
// of changes up for a vote (at their current head) or to one project's
// merged changes.
function stillsSql(scope) {
  return `
    SELECT s.id AS session_id, a.slug, f.id, f.story_id, f.viewport, f.side, f.variant
      FROM chat_sessions s
      JOIN apps a ON a.id = s.app_id
      JOIN shot_runs r ON r.id = s.shots_run_id AND r.state = 'verified'
      JOIN shot_artifacts f ON f.run_id = r.id
     WHERE ${scope}
       AND s.shots_state = 'verified'
       AND NOT a.self_hosted AND a.moderation_suspended_at IS NULL AND a.view_visibility = 'public'
       AND f.media = 'png' AND f.theme = 'light' AND f.variant IN ('focus', 'context')
       AND f.public_safe IS TRUE
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.intent->'stories') = 'array'
                                          THEN r.intent->'stories' ELSE '[]'::jsonb END) st,
                jsonb_array_elements(CASE WHEN jsonb_typeof(st->'viewports') = 'array'
                                          THEN st->'viewports' ELSE '[]'::jsonb END) vp
          WHERE st->>'id' = f.story_id
            AND st->>'persona' = 'member'
            AND vp->>'name' = f.viewport
            AND CASE WHEN (vp->>'width') ~ '^[0-9]+$' THEN (vp->>'width')::int ELSE ${PHONE_WIDTH_BELOW} END
                < ${PHONE_WIDTH_BELOW})
     ORDER BY s.id, f.story_id, f.viewport`;
}

// A change up for a vote, at the head its shots were taken of (the change
// page's own rule, routes/shots.js).
const OPEN_SCOPE = `s.id = ANY($1::bigint[]) AND s.status IN ('promoted', 'merging')
       AND r.head_sha = COALESCE(
             CASE WHEN s.source = 'imported' THEN s.imported_pr_head_sha ELSE s.reviewed_head_sha END,
             s.checks_commit_sha,
             s.handoff_head_sha)`;

// A change voted in and live, at the head its shots were taken of: what a
// visitor's page shows of what went live lately (services/public-project.js,
// What it's like and Recently live). The same rules as one up for a vote,
// less its status: the run is still the change's current, verified one.
const MERGED_SCOPE = `s.id = ANY($1::bigint[]) AND s.status = 'merged' AND s.live_at IS NOT NULL
       AND r.head_sha = COALESCE(
             CASE WHEN s.source = 'imported' THEN s.imported_pr_head_sha ELSE s.reviewed_head_sha END,
             s.checks_commit_sha,
             s.handoff_head_sha)`;

/**
 * One change's pair from its passing rows: the first screen (by change and
 * screen name) with an after still, its element shots when both sides have
 * one, else its whole-screen shots. `before` is null when the run took
 * after shots only (a new app).
 */
function pairOf(rows) {
  const screens = [];
  for (const row of rows) {
    const key = `${row.story_id}\u0000${row.viewport}`;
    if (!screens.includes(key)) screens.push(key);
  }
  for (const key of screens) {
    const on = rows.filter((row) => `${row.story_id}\u0000${row.viewport}` === key);
    const find = (side, variant) => on.find((row) => row.side === side && row.variant === variant) || null;
    const focus = { before: find('base', 'focus'), after: find('head', 'focus') };
    const context = { before: find('base', 'context'), after: find('head', 'context') };
    const pick = focus.before && focus.after ? focus : context.after ? context : null;
    if (pick) return { before: pick.before ? pick.before.id : null, after: pick.after.id };
  }
  return null;
}

function byChange(rows) {
  const out = new Map();
  for (const row of rows) {
    const id = Number(row.session_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(row);
  }
  return out;
}

/**
 * The public pair of each of these changes up for a vote that has one:
 * Map(changeId → { slug, before: artifactId|null, after: artifactId }).
 * `{ live: true }` asks the same of changes voted in and live instead
 * (MERGED_SCOPE).
 */
async function publicStillsFor(db, changeIds, { live = false } = {}) {
  const ids = (changeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const { rows } = await db.query(stillsSql(live ? MERGED_SCOPE : OPEN_SCOPE), [ids]);
  const out = new Map();
  for (const [id, changeRows] of byChange(rows)) {
    const pair = pairOf(changeRows);
    if (pair) out.set(id, { slug: changeRows[0].slug, ...pair });
  }
  return out;
}

/**
 * The after still of a project's latest merged change that passes, as an
 * artifact id, or null: the picture an invite link shows. Its whole screen
 * when it has one, since the link's page draws it in a phone's frame.
 */
async function publicMergedStill(db, appId) {
  const { rows } = await db.query(
    `SELECT pick.* FROM (${stillsSql('s.app_id = $1 AND s.merged_at IS NOT NULL')}) pick
       JOIN chat_sessions s ON s.id = pick.session_id
      ORDER BY s.merged_at DESC, pick.session_id DESC`,
    [appId]
  );
  for (const [, changeRows] of byChange(rows)) {
    const after = changeRows.find((row) => row.side === 'head' && row.variant === 'context')
      || changeRows.find((row) => row.side === 'head');
    if (after) return after.id;
  }
  return null;
}

/**
 * A public still's key (or legacy bytes), type and hash, or null unless
 * it is one of this project's change's public pair right now: a change up
 * for a vote, or the after still of one that is live.
 */
async function publicStillBytes(db, { slug, changeId, artifactId }) {
  const open = (await publicStillsFor(db, [changeId])).get(Number(changeId));
  const ok = open && open.slug === slug && (open.before === artifactId || open.after === artifactId);
  if (!ok) {
    const live = (await publicStillsFor(db, [changeId], { live: true })).get(Number(changeId));
    if (!live || live.slug !== slug || live.after !== artifactId) return null;
  }
  const { rows } = await db.query('SELECT object_key, bytes, content_type, sha256 FROM shot_artifacts WHERE id = $1', [artifactId]);
  if (!rows[0]) return null;
  return { objectKey: rows[0].object_key, sizeBytes: rows[0].bytes,
    contentType: rows[0].content_type, sha256: rows[0].sha256 };
}

/** Where a visitor's page reads one of those stills (routes/public-api.js). */
function publicStillUrl(slug, changeId, artifactId) {
  return `/api/public/apps/${encodeURIComponent(slug)}/changes/${Number(changeId)}/stills/${encodeURIComponent(artifactId)}`;
}

module.exports = {
  publicStillsFor,
  publicMergedStill,
  publicStillBytes,
  publicStillUrl,
  pairOf,
  stillsSql,
  PHONE_WIDTH_BELOW,
};
