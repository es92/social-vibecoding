/**
 * #4666: propose who can see a project and how its changes are approved, as
 * one change (POST /api/apps/:slug/who-decides-pr, src/services/who-decides-pr.js).
 * The Who can see & change it sheet's; the Make it step's presets propose
 * nothing (the project does not exist yet).
 */

import { t as translate } from '../../lib/i18n/runtime';
import { askToVerifyForPublic } from '../auth/verify-identity';
import { blockFor, type RulesValue } from './model';

export type ProposeResult =
  | { state: 'opened'; sessionId: number | null; prNumber: number | null }
  | { state: 'waiting'; sessionId: number | null; prNumber: number | null }
  | { state: 'notVerified' };

/**
 * Open the proposal. Making a project public needs a verified owner (#4378):
 * the verify sheet asks, and once a phone is linked the proposal goes again;
 * Not now answers `notVerified`. A change already up for a vote answers
 * `waiting` with its number. Anything else that fails throws, with the
 * server's words when it said any.
 */
export async function proposeWhoDecides(
  slug: string,
  change: { visibility?: 'private' | 'public' | null; governance?: RulesValue | null },
): Promise<ProposeResult> {
  const body: Record<string, unknown> = {};
  if (change.visibility) body.visibility = change.visibility;
  if (change.governance) body.governance = blockFor(change.governance);
  const send = () => fetch(`/api/apps/${encodeURIComponent(slug)}/who-decides-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let res = await send();
  let data = await res.json().catch(() => ({}));
  if (data && data.code === 'identity_required') {
    if (!(await askToVerifyForPublic())) return { state: 'notVerified' };
    res = await send();
    data = await res.json().catch(() => ({}));
  }
  if (res.status === 409) {
    return { state: 'waiting', sessionId: data.sessionId ?? null, prNumber: data.prNumber ?? null };
  }
  if (!res.ok) throw new Error((data && data.error) || translate('dialogs:whoDecides.error'));
  return { state: 'opened', sessionId: data.sessionId ?? null, prNumber: data.prNumber ?? null };
}
