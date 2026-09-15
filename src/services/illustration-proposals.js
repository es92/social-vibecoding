'use strict';

// Featured-illustration governance (#2086).
//
// Saving or removing an app's featured illustration used to write
// `apps.featured_illustration` on the spot, so one manager could restyle the
// app's Discover card unilaterally. It opens a governance proposal now, an
// `issues` row of kind `featured_illustration`, modelled on the rename card:
// the board shows the proposed image beside the current one, the change
// applies when the vote passes under the app's usual gate, and an admin can
// force-apply it like any other governance card.
//
// The payload is the whole story the card needs and the whole instruction
// the apply needs:
//
//   { proposed: illustration | null,   // null = remove the illustration
//     current:  illustration | null,   // what the app wore when proposed
//     remove:   boolean }
//
// where an illustration is the same record `apps.featured_illustration`
// holds ({ url, darkUrl, zoom, x, y, tint }). `proposed` is COMPLETE, not a
// diff: a framing-only change carries the current image URLs, a light-only
// upload carries the current darkUrl, so the apply is one write of the
// record as proposed. The bytes behind a NEW url wait in
// app_illustration_proposals until then; the apply moves them into
// app_illustrations under the same ids, which is what keeps the preview URL
// the card rendered valid after the change lands.
//
// The route (src/routes/app-illustrations.js) builds the record and calls
// createProposal; the apply helper in src/routes/issues.js
// (maybeApplyFeaturedIllustrationProposal) locks the issue row and calls
// applyProposal inside its transaction.

const crypto = require('crypto');
const log = require('./logger');
const { sendSystemMessage, pushIssueUpdate } = require('./ws');

const KIND = 'featured_illustration';
const IMAGE_PATH = '/app-illustrations/';

function newImageId() {
  return crypto.randomBytes(16).toString('hex');
}

function imageUrl(id) {
  return `${IMAGE_PATH}${id}`;
}

/** The image id a stored illustration url names, or null for anything else. */
function imageIdFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(IMAGE_PATH)) return null;
  const id = url.slice(IMAGE_PATH.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

/** The card's route, the same one shared-objects.js builds for a governance row. */
function governanceHref(slug, issueId) {
  return `#app/${encodeURIComponent(slug)}/dev/governance/${issueId}`;
}

function proposalLink(app, issue) {
  return { id: issue.id, href: governanceHref(app.slug, issue.id) };
}

/** The open illustration proposal on an app, if there is one. */
async function findOpenProposal(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, title, created_at FROM issues
      WHERE app_id = $1 AND kind = $2 AND status = 'open'
      ORDER BY id LIMIT 1`,
    [appId, KIND]
  );
  return rows[0] || null;
}

class PendingProposalError extends Error {
  constructor(issue) {
    super('A featured illustration change is already waiting for the group to vote on it.');
    this.code = 'pending';
    this.issue = issue;
  }
}

/**
 * Open the proposal. `proposed` is the complete illustration record the app
 * would wear (null to remove it); `images` carries the bytes behind any NEW
 * url in it as { light: { id, contentType, data } | null, dark: ... }.
 *
 * Throws PendingProposalError when one is already open on the app. The
 * read below answers the common case with the open card to link to; the
 * partial unique index on issues answers the race, and its violation is
 * translated into the same error.
 */
async function createProposal(pool, { app, user, proposed, images = {} }) {
  const current = app.featured_illustration || null;
  const existing = await findOpenProposal(pool, app.id);
  if (existing) throw new PendingProposalError(existing);

  const remove = proposed === null;
  const title = remove
    ? 'Remove the featured illustration'
    : current ? 'Change the featured illustration' : 'Add a featured illustration';
  const description = `${user.username} proposed ${remove ? 'removing' : current ? 'changing' : 'adding'} `
    + `the featured illustration on ${app.name || app.slug}'s Discover card. `
    + 'It applies when the group votes it in.';
  const payload = { proposed, current, remove };

  const client = await pool.connect();
  let issue;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO issues (app_id, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [app.id, title, description, KIND, JSON.stringify(payload), user.id]
    );
    issue = rows[0];
    const light = images.light || null;
    const dark = images.dark || null;
    if (light || dark) {
      await client.query(
        `INSERT INTO app_illustration_proposals
           (issue_id, app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [issue.id, app.id,
          light ? light.id : null, light ? light.contentType : null, light ? light.data : null,
          dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && /open_featured_illustration/.test(err.constraint || '')) {
      throw new PendingProposalError(await findOpenProposal(pool, app.id));
    }
    throw err;
  } finally {
    client.release();
  }

  // Announce it the way the other governance kinds are announced: once in
  // group chat, once in the proposal's own thread so the discussion opens
  // with its origin in context. Best-effort, outside the transaction.
  const createdMsg = `${user.username} proposed ${remove ? 'removing' : 'changing'} the featured illustration`;
  await sendSystemMessage(pool, app.id, createdMsg, 'system')
    .catch((err) => log.warn('illustrations', 'Proposal chat message failed', { err: err.message }));
  await sendSystemMessage(pool, app.id, createdMsg, 'system',
    null, { type: 'governance', ref: issue.id }).catch(() => {});
  pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: issue.id, kind: KIND });

  log.info('illustrations', 'Featured illustration proposal created', {
    issueId: issue.id, appId: app.id, remove,
  });
  return issue;
}

/**
 * Write the proposed record onto the app. Runs on the caller's client, inside
 * the transaction that has the issue row locked, so a vote and the sweeper
 * cannot both apply it. Returns the illustration the app now wears (null
 * when it was removed).
 *
 * The bytes for each url in the record come from the proposal's own pending
 * row when the url is new, or from the app's current row when the proposal
 * kept an image (a reframe, a light-only upload). Anything else means the
 * image is gone, which is an error rather than a silent blank card.
 */
async function applyProposal(client, appId, payload, issueId) {
  const proposed = payload && payload.proposed ? payload.proposed : null;
  if (!proposed) {
    await client.query('DELETE FROM app_illustrations WHERE app_id = $1', [appId]);
    await client.query('UPDATE apps SET featured_illustration = NULL WHERE id = $1', [appId]);
    await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
    return null;
  }
  const lightId = imageIdFromUrl(proposed.url);
  const darkId = proposed.darkUrl ? imageIdFromUrl(proposed.darkUrl) : null;
  if (!lightId || (proposed.darkUrl && !darkId)) {
    throw new Error('The proposed illustration names no image');
  }
  const { rows: pendingRows } = await client.query(
    'SELECT * FROM app_illustration_proposals WHERE issue_id = $1', [issueId]
  );
  const { rows: currentRows } = await client.query(
    'SELECT * FROM app_illustrations WHERE app_id = $1', [appId]
  );
  const sources = [pendingRows[0], currentRows[0]].filter(Boolean);
  const pick = (id) => {
    if (!id) return null;
    for (const row of sources) {
      if (row.id === id) return { id, contentType: row.content_type, data: row.data };
      if (row.dark_id === id) return { id, contentType: row.dark_content_type, data: row.dark_data };
    }
    return null;
  };
  const light = pick(lightId);
  const dark = pick(darkId);
  if (!light || (darkId && !dark)) {
    throw new Error('The proposed image is no longer available');
  }
  // The pending row goes first: its ids are UNIQUE in that table only, but
  // reading it before the upsert keeps the bytes in hand either way.
  await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
  await client.query(
    `INSERT INTO app_illustrations (app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type,
       data = EXCLUDED.data, dark_id = EXCLUDED.dark_id, dark_content_type = EXCLUDED.dark_content_type,
       dark_data = EXCLUDED.dark_data`,
    [appId, light.id, light.contentType, light.data,
      dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null]
  );
  await client.query(
    'UPDATE apps SET featured_illustration = $2::jsonb WHERE id = $1',
    [appId, JSON.stringify(proposed)]
  );
  return proposed;
}

module.exports = {
  KIND,
  IMAGE_PATH,
  PendingProposalError,
  newImageId,
  imageUrl,
  imageIdFromUrl,
  governanceHref,
  proposalLink,
  findOpenProposal,
  createProposal,
  applyProposal,
};
