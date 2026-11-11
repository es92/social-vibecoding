// A featured-illustration proposal's images, and applying a passed one:
// the governance machine's domain write, read and written inside its
// transaction (services/illustration-proposals.js re-exports both).

import type { Queryable } from './db.ts';

export const IMAGE_PATH = '/app-illustrations/';
// A card's animated preview (#card-previews): a short loop of the real app,
// part of the same record (`preview: { url, type }`) and of the same vote.
export const PREVIEW_PATH = '/app-previews/';

/** The image id a stored illustration url names, or null for anything else. */
export function imageIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(IMAGE_PATH)) return null;
  const id = url.slice(IMAGE_PATH.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

/** The loop id a stored preview url names, or null for anything else. */
export function previewIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(PREVIEW_PATH)) return null;
  const id = url.slice(PREVIEW_PATH.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

/** The loop a record names, as its id; null when it has none. Throws on a preview that names no loop. */
function recordPreviewId(proposed: Proposed): string | null {
  const preview = proposed.preview;
  if (preview == null) return null;
  const id = previewIdFromUrl(preview && typeof preview === 'object' ? (preview as { url?: unknown }).url : null);
  if (!id) throw new Error('The proposed preview names no loop');
  return id;
}

interface Proposed { url?: string; darkUrl?: string | null; preview?: { url?: string; type?: string } | null; [k: string]: unknown }
interface Payload { proposed?: Proposed | null }

// Why applyProposal would throw for this record, or null when it would not:
// the same checks, reading ids rather than bytes, so the workflow machine can
// refuse a proposal whose image is gone instead of failing its apply.
export async function missingProposalImage(client: Queryable, appId: number, payload: Payload | null, issueId: number): Promise<string | null> {
  const proposed = payload && payload.proposed ? payload.proposed : null;
  if (!proposed) return null;
  const lightId = imageIdFromUrl(proposed.url);
  const darkId = proposed.darkUrl ? imageIdFromUrl(proposed.darkUrl) : null;
  if (!lightId || (proposed.darkUrl && !darkId)) return 'no_image';
  let previewId: string | null;
  try { previewId = recordPreviewId(proposed); } catch { return 'no_image'; }
  const { rows } = await client.query(
    `SELECT id, dark_id, preview_id FROM app_illustration_proposals WHERE issue_id = $1
     UNION ALL
     SELECT id, dark_id, preview_id FROM app_illustrations WHERE app_id = $2`,
    [issueId, appId]
  );
  const known = new Set(rows.flatMap((r) => [r.id, r.dark_id]).filter(Boolean));
  const loops = new Set(rows.map((r) => r.preview_id).filter(Boolean));
  return known.has(lightId) && (!darkId || known.has(darkId)) && (!previewId || loops.has(previewId))
    ? null : 'image_unavailable';
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
export async function applyProposal(client: Queryable, appId: number, payload: Payload | null, issueId: number): Promise<Proposed | null> {
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
  const previewId = recordPreviewId(proposed);
  const { rows: pendingRows } = await client.query(
    'SELECT * FROM app_illustration_proposals WHERE issue_id = $1', [issueId]
  );
  const { rows: currentRows } = await client.query(
    'SELECT * FROM app_illustrations WHERE app_id = $1', [appId]
  );
  const sources = [pendingRows[0], currentRows[0]].filter(Boolean);
  const pick = (id: string | null) => {
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
  // The loop, by the same rule: the proposal's own when it is new, the
  // app's when the proposal kept it.
  let preview: { id: string; contentType: string; data: unknown } | null = null;
  if (previewId) {
    const row = sources.find((r) => r.preview_id === previewId);
    if (!row) throw new Error('The proposed preview is no longer available');
    preview = { id: previewId, contentType: row.preview_content_type, data: row.preview_data };
  }
  // The pending row goes first: its ids are UNIQUE in that table only, but
  // reading it before the upsert keeps the bytes in hand either way.
  await client.query('DELETE FROM app_illustration_proposals WHERE issue_id = $1', [issueId]);
  await client.query(
    `INSERT INTO app_illustrations (app_id, id, content_type, data, dark_id, dark_content_type, dark_data,
       preview_id, preview_content_type, preview_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type,
       data = EXCLUDED.data, dark_id = EXCLUDED.dark_id, dark_content_type = EXCLUDED.dark_content_type,
       dark_data = EXCLUDED.dark_data, preview_id = EXCLUDED.preview_id,
       preview_content_type = EXCLUDED.preview_content_type, preview_data = EXCLUDED.preview_data`,
    [appId, light.id, light.contentType, light.data,
      dark ? dark.id : null, dark ? dark.contentType : null, dark ? dark.data : null,
      preview ? preview.id : null, preview ? preview.contentType : null, preview ? preview.data : null]
  );
  await client.query(
    'UPDATE apps SET featured_illustration = $2::jsonb WHERE id = $1',
    [appId, JSON.stringify(proposed)]
  );
  return proposed;
}
