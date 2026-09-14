// The platform's OWN app row — the `apps` record whose `self_hosted` flag is
// set, i.e. Homeroom as an app on Homeroom.
//
// ── Why this needs a service at all ───────────────────────────────────
//
// The UI overhaul put an "Improve" button on the home screen, and on that
// screen it is about the PLATFORM rather than about any app the viewer has
// open. To link into that app's dev screen the client needs its slug, and the
// client has never had a way to learn it: `GET /api/apps` hides self-hosted
// rows from non-admins (routes/apps.js — the SELF-HOSTING.md sub-step 2j
// filter), so for everybody but an admin the platform's own row simply is not
// in any payload the shell already fetches.
//
// Widening that filter would be the wrong fix — it exists so a deployment's
// own row is not enumerable alongside ordinary apps. What the client actually
// needs is four public facts about one known row, which is what this returns.
//
// ── What is deliberately NOT here ─────────────────────────────────────
//
// No status, no URL, no failure detail, no collaborator or visibility columns.
// Everything below is already visible to any signed-in viewer who opens the
// platform's dev screen (which is public — the self-app's board is where
// feedback lands), so this discloses nothing new. Adding a field here means
// deciding it is public for every signed-in user, so add one only with that in
// mind.
//
// ── Caching ───────────────────────────────────────────────────────────
//
// `/api/auth/me` is on the boot path of every tab, and this row changes only
// when the platform deploys. A short TTL keeps `main_sha` honest — the Improve
// panel renders it as the version — without adding a query to the hottest
// authenticated endpoint on the deployment.

const CACHE_TTL_MS = 30_000;

let cached = null;
let cachedAt = 0;

/** Drop the memo — deploys and tests both want a way to force a re-read. */
function invalidate() {
  cached = null;
  cachedAt = 0;
}

/**
 * The platform's own app, or null when this deployment has no self-hosted row
 * (a fresh install, and every staging clone before its apps table is seeded).
 *
 * Never throws: a database hiccup here would otherwise fail the boot payload
 * for every signed-in user, and the only thing lost by returning null is one
 * button on the home screen.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{slug: string, name: string, repoUrl: string|null,
 *                    version: string|null} | null>}
 */
async function getPlatformApp(pool) {
  const now = Date.now();
  if (cached !== null && now - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const { rows } = await pool.query(
      `SELECT slug, name, repo_url, main_sha
         FROM apps
        WHERE self_hosted = TRUE
        ORDER BY id ASC
        LIMIT 1`
    );
    const row = rows[0];
    cached = row
      ? {
          slug: row.slug,
          name: row.name || row.slug,
          repoUrl: row.repo_url || null,
          // Short sha, matching what the drawer's version rows render and what
          // the Improve panel expects — the full hash is not useful at a
          // glance and the commit URL is reachable from the repo link.
          version: row.main_sha ? String(row.main_sha).slice(0, 7) : null,
        }
      : null;
    cachedAt = now;
    return cached;
  } catch {
    // Leave whatever was cached in place rather than poisoning it with null:
    // a transient failure should not blank the home screen's Improve button
    // for the next 30 seconds.
    return cached;
  }
}

module.exports = { getPlatformApp, invalidate, CACHE_TTL_MS };
