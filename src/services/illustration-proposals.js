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
// createProposal; the governance machine applies a passed proposal
// (src/workflow/governance-proposal/, with src/workflow/rules/illustrations.ts
// applyProposal inside its transaction).

const crypto = require('crypto');
const log = require('./logger');
const { sendSystemMessage, pushIssueUpdate } = require('./ws');

const illustrations = require('../workflow/rules/illustrations.ts');

const KIND = 'featured_illustration';
const { IMAGE_PATH, imageIdFromUrl } = illustrations;

function newImageId() {
  return crypto.randomBytes(16).toString('hex');
}

function imageUrl(id) {
  return `${IMAGE_PATH}${id}`;
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

  // Announce it the way the other governance kinds are announced: in the
  // proposal's own thread, so the discussion opens with its origin in
  // context. Best-effort, outside the transaction.
  const createdMsg = `${user.username} proposed ${remove ? 'removing' : 'changing'} the featured illustration`;
  await sendSystemMessage(pool, app.id, createdMsg, 'system',
    null, { type: 'governance', ref: issue.id }).catch(() => {});
  // Enroll it with the governance machine; a failure is caught by the next
  // vote or the boot backfill.
  const workflow = require('../workflow/platform.ts');
  await workflow.fileProposal(issue.id, app.id).catch((err) =>
    log.warn('illustrations', 'Filing the governance proposal failed', { issueId: issue.id, err: err.message }));
  pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: issue.id, kind: KIND });

  log.info('illustrations', 'Featured illustration proposal created', {
    issueId: issue.id, appId: app.id, remove,
  });
  return issue;
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
};
