import { SectionHeading, StatusLine } from '@/components/ui/field';

import { GrantsList } from '../grants-list';

/**
 * App AI permissions (issue #34). Lists every app the user has granted access
 * to their daily AI budget: today's spend vs the per-app cap, a cap editor,
 * the BYOK spillover toggle, and Revoke — and, on a revoked row, Re-enable
 * (#1957), so the way back does not depend on the app asking again.
 *
 * `#llm-grants-list` is React-owned end to end now (../grants-list.tsx).
 * Settings._renderLlmGrants() still does the fetching, on section open, from
 * GET /api/me/llm-grants (?demo=1 passthrough in staging) — it publishes a
 * view model rather than building rows. The host stays an EMPTY div at first
 * render, which is what the prerender emits and what hydration has to match.
 */
export function AppAiSection() {
  return (
    <div data-settings-section="app-ai" className="hidden">
      <div id="llm-grants-section">
        <SectionHeading title="App AI permissions">
          Apps you've allowed to use AI on your behalf. Their spend counts against your normal daily budget, plus the per-app cap you set. Revoking takes effect immediately, and a revoked app can be re-enabled here with its previous cap.
        </SectionHeading>
        <div id="llm-grants-list" className="space-y-2">
          <GrantsList />
        </div>
        <StatusLine id="llm-grants-status" />
      </div>
    </div>
  );
}
