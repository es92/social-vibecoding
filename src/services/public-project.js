'use strict';

// What a visitor with no account can read about a public project: the guest
// project page (frontend/src/features/guest/guest-project.tsx), served by
// GET /api/public/apps/:slug/overview (routes/public-api.js).
//
// It answers for exactly the apps the public directory lists
// (public-app-directory.js), and carries only what anybody signed in can
// already read on that project's own pages:
//
//   * its directory card (name, icon, colour, description, counts);
//   * the changes up for a vote, each with its plain-words summary and its
//     counted tally (the tallies every vote card shows), never who voted,
//     and its before & after pictures where they may be shown to anybody
//     (services/shots-public.js);
//   * the last few changes voted in and live, each with its after picture
//     where it may be shown to anybody (the same rules, services/
//     shots-public.js);
//   * how many people took part this week and how many changes went live in
//     the last thirty days, as numbers (communities.js activityCounts);
//   * the titles of its open requests, read from its repository's public
//     issues, never a body or who filed it.
//
// No member names, no chat, no transcripts: those stay with members (the
// project page says "The chat is for members"). A change still called by
// its placeholder title, its author's handle and "'s changes", shows as
// "A change" (publicChangeTitle).

const github = require('./github');
const log = require('./logger');
const { listPublicApps, publicChangeTitle } = require('./public-app-directory');
const { countedVotePredicateSql } = require('./pr-vote-revision');
const { publicStillsFor, publicStillUrl } = require('./shots-public');
const { activityCounts } = require('./communities');
const repoRef = require('./repo-ref');

// The page shows two of each and folds the rest behind "See all", which
// opens the rest of these in place.
const VOTES_MAX = 20;
const MERGED_MAX = 12;
const REQUESTS_MAX = 8;
const SUMMARY_MAX = 240;

// The summary a proposal carries for the people voting on it is Markdown,
// sometimes several paragraphs. The card shows its first paragraph as plain
// words. A preview too long for the card ends after the last whole word that
// fits, with trailing punctuation dropped, then "…", so it never stops partway
// through a word. A single word longer than the limit has no break to end on
// and is cut at the limit instead.
function plainSummary(md) {
  if (typeof md !== 'string') return null;
  const first = md.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).find(Boolean);
  if (!first) return null;
  const text = first
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  // Look at the next character too: a word that ends exactly at the limit is
  // whole, even though the last space the slice holds is the one before it.
  const space = text[SUMMARY_MAX - 1] === ' ' ? cut.length : cut.lastIndexOf(' ');
  const whole = space > 0
    ? cut.slice(0, space).replace(/[\s,;:.\-–(]+$/u, '')
    : '';
  // A slice with no space (one long word) keeps the hard cut, so the preview
  // is never longer than the limit either way.
  return `${whole || cut.trimEnd()}…`;
}

function parseOwnerRepo(repoUrl) {
  return repoRef.ownerRepo(repoUrl);
}

// The open requests: their titles and how many there are, or null when the
// list cannot be read right now (the page then says nothing about them
// rather than "none").
async function openRequests(repoUrl, gh = github) {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed || !gh.isEnabled()) return null;
  try {
    const result = await gh.fetchPublicIssues(parsed.owner, parsed.repo);
    const issues = Array.isArray(result && result.issues) ? result.issues : null;
    if (!issues || (result.stale && !issues.length) || (result.note && !issues.length)) return null;
    const open = issues.filter((i) => i && !i.pull_request && typeof i.title === 'string');
    return {
      total: open.length,
      more: Boolean(result.truncatedList),
      items: open.slice(0, REQUESTS_MAX).map((i) => ({ number: i.number, title: i.title.trim().slice(0, 200) })),
    };
  } catch (err) {
    log.warn('public-project', 'Open requests could not be read', { repo: `${parsed.owner}/${parsed.repo}`, err: err.message });
    return null;
  }
}

async function loadProjectOverview(pool, slug, { gh = github } = {}) {
  const [app] = await listPublicApps(pool, { includeWallets: false, slug: String(slug) });
  if (!app) return null;

  const [votes, merged, repo] = await Promise.all([
    pool.query(
      `SELECT cs.id, cs.pr_number, COALESCE(cs.pr_title, cs.session_title) AS title, cs.pr_summary_md,
              cs.promoted_at,
              (SELECT COUNT(*) FROM pr_votes pv
                WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                  AND ${countedVotePredicateSql('pv', 'cs')}) AS yes_count,
              (SELECT COUNT(*) FROM pr_votes pv
                WHERE pv.session_id = cs.id AND pv.vote = 'no'
                  AND ${countedVotePredicateSql('pv', 'cs')}) AS no_count
         FROM chat_sessions cs
        WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
        ORDER BY cs.promoted_at DESC NULLS LAST, cs.id DESC
        LIMIT $2`,
      [app.id, VOTES_MAX]
    ),
    pool.query(
      `SELECT cs.id, cs.pr_number, COALESCE(cs.pr_title, cs.session_title) AS title, cs.pr_summary_md,
              COALESCE(cs.merged_at, cs.created_at) AS merged_at
         FROM chat_sessions cs
        WHERE cs.app_id = $1 AND cs.status = 'merged' AND cs.live_at IS NOT NULL
        ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
        LIMIT $2`,
      [app.id, MERGED_MAX]
    ),
    pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]),
  ]);
  const [requests, stills, liveStills, counts] = await Promise.all([
    openRequests(repo.rows[0] && repo.rows[0].repo_url, gh),
    publicStillsFor(pool, votes.rows.map((r) => r.id)),
    publicStillsFor(pool, merged.rows.map((r) => r.id), { live: true }),
    // Numbers only, never who; a read that fails says nothing rather than zero.
    activityCounts(pool, app.id).catch((err) => {
      log.warn('public-project', 'Activity counts could not be read', { slug: app.slug, err: err.message });
      return null;
    }),
  ]);
  const pictures = (id) => {
    const pair = stills.get(Number(id));
    if (!pair) return null;
    return {
      before: pair.before ? publicStillUrl(app.slug, id, pair.before) : null,
      after: publicStillUrl(app.slug, id, pair.after),
    };
  };

  const livePicture = (id) => {
    const pair = liveStills.get(Number(id));
    return pair ? publicStillUrl(app.slug, id, pair.after) : null;
  };

  const { contributors, ...card } = app;
  return {
    app: { ...card, builders: (contributors || []).length },
    // How many took part this week, how many changes went live this month.
    activity: counts ? { active_week: counts.active_week, merged_month: counts.shipped_month } : null,
    votes: votes.rows.map((r) => ({
      id: r.id,
      pr_number: r.pr_number,
      title: publicChangeTitle(r.title),
      summary: plainSummary(r.pr_summary_md),
      yes: parseInt(r.yes_count, 10) || 0,
      no: parseInt(r.no_count, 10) || 0,
      promoted_at: r.promoted_at || null,
      pictures: pictures(r.id),
    })),
    merged: merged.rows.map((r) => ({
      id: r.id,
      pr_number: r.pr_number,
      title: publicChangeTitle(r.title),
      summary: plainSummary(r.pr_summary_md),
      merged_at: r.merged_at || null,
      picture: livePicture(r.id),
    })),
    requests,
  };
}

module.exports = { loadProjectOverview, plainSummary, openRequests };
