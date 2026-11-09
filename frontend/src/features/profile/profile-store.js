/**
 * The Profile screen's state, and the pure shaping that turns it into what
 * ./profile-view.tsx renders (#1191 slice 6, conversion 1).
 *
 * ── Me is the prototype's Me now ───────────────────────────────────────
 *
 * The screen the Me tab lands on was the older long Profile: identity,
 * public-profile controls, a points figure, rank, the token card, a points
 * breakdown, the completed challenges, then Platform and Account groups. The
 * navigation prototype's Me (`scrMe`) is a compact profile card, three stat
 * cards (merged, kudos, challenges), and lists of rows that say what is
 * behind them: "Your work" (Your changes, Your requests, Your votes) and
 * "More", since the UI overhaul, which also retired "Your contributions"
 * under them (Your changes lists every merged change) — and that is what
 * this file shapes now. Nothing that was here was dropped; each piece moved to the
 * place the prototype gives it:
 *
 *   points, rank, breakdown, token  → the Challenges tab's standing card
 *                                     (features/leaderboard/your-standing.tsx),
 *                                     behind "Challenges & standings"
 *   completed challenges            → the "challenges" stat card's count, and
 *                                     the Challenges tab, where each one is a
 *                                     card with its own page
 *   public-profile publishing       → the Edit profile sheet ("Public page")
 *   Settings                        → a "More" row, as before
 *   Admin & moderation, the node,
 *   wallet and staking rows, Log out → Settings (the spec's retired-chip table:
 *                                     "Me, with Admin and Validator inside
 *                                     Settings"), features/settings/account-rows.tsx
 *   the builder-profile chip        → the Kudos tab's builders, behind
 *                                     "Kudos" (it was "See all" on Your
 *                                     contributions until the UI overhaul)
 *
 * Plain JS, no React import, for the reason lib/plain-store.js documents: the
 * root test suite is `node --test` with no JSX transform, and
 * tests/topochain-profile-web.test.js and
 * tests/profile-completed-challenges.test.js read the real shipped source. Every
 * decision this screen makes about WHAT to show — which of the six load states
 * it is in, whether the token figure is gated or merely blurred, how a
 * completion row's meta line reads — is therefore in this file, where those
 * suites can still reach it. The .tsx beside it only turns the result into
 * elements.
 *
 * The initial state is `open: false`, which `buildProfileView` maps to a view of
 * kind `empty` and the component renders as no children at all. That is exactly
 * the empty `#profile-root` the hand-written shell shipped, which is what the
 * prerender pass emits and what hydration then has to match. Nothing here reads
 * `window`, `localStorage` or the clock at module scope for the same reason.
 */

import { createStore } from '../../lib/plain-store.js';
import { changeHref } from '../../lib/change-href';
import { getDateLocale, t } from '../../lib/i18n/runtime';
import { KUDOS_PARKED } from '../leaderboard/kudos-parked';

/** Short facts on one small line, each a whole message, joined the way the
 *  language on screen separates them (`profile:line.factPair`). */
function factLine(parts) {
  const said = parts.filter(Boolean);
  return said.length ? said.reduce((first, second) => t('profile:line.factPair', { first, second })) : null;
}

/**
 * @typedef {Object} ProfileState
 * @property {boolean} open      — the #profile route is active
 * @property {any} data          — { ranking, summary, ownerPublicProfile, season }
 * @property {any} user          — a snapshot of App.user, taken by the controller
 * @property {string|null} pendingAvatarUrl — object URL of a staged photo
 * @property {boolean} pendingRemove        — the staged change is a deletion
 * @property {{url: string, width: number, height: number}|null} cropSource
 *   — the chosen photo while "Position your photo" is up (#3525): its object
 *   URL and decoded size. The File itself stays on Profile, as the staged
 *   Blob does.
 * @property {boolean} sheetOpen
 * @property {string} publicStatus
 * @property {boolean} publishing
 * @property {boolean} previewOpen
 * @property {number|null} friendsPending — the incoming request being answered (#2386)
 * @property {string} friendsStatus         — why the last answer failed, if it did
 * @property {boolean} feedbackOpen         — the "Your feedback" list is up (#3186)
 * @property {boolean} friendsOpen          — the Friends card is up (UI overhaul)
 * @property {boolean} appSlotsOpen         — the App allowance card is up (#6446)
 * @property {boolean} weekShareOpen        — the "Share your week" card is up (#6464)
 */

export const profileStore = createStore(/** @type {ProfileState} */ ({
  open: false,
  data: null,
  user: null,
  pendingAvatarUrl: null,
  pendingRemove: false,
  cropSource: null,
  sheetOpen: false,
  publicStatus: '',
  publishing: false,
  previewOpen: false,
  friendsPending: null,
  friendsStatus: '',
  feedbackOpen: false,
  friendsOpen: false,
  appSlotsOpen: false,
  weekShareOpen: false,
}));

/** Only ever render an http(s) URL as a real anchor. Escaping alone would not
 *  stop a `javascript:` href, which executes on click with no markup injection
 *  at all — the same discipline TopochainChallenges.safeHref applies. */
export function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** The name shown large on the card: the display name when set, else the
 *  @username. Never blank — a signed-in profile always has a username. */
export function displayNameOf(user) {
  const u = user || {};
  const name = u.displayName ? String(u.displayName).trim() : '';
  return name || (u.username ? `@${u.username}` : t('profile:identity.fallbackName'));
}

/**
 * The letter in the fallback circle. Takes the first LETTER OR DIGIT, not
 * simply the first character: a display name is free text, so it can easily
 * start with punctuation or an emoji ("[Staging demo] admin", "…hello") and a
 * circle reading "[" tells the viewer nothing. Falls back to the username,
 * then to '?'.
 */
export function initialOf(user) {
  const u = user || {};
  for (const src of [u.displayName, u.username]) {
    const match = String(src || '').match(/[\p{L}\p{N}]/u);
    if (match) return match[0].toUpperCase();
  }
  return '?';
}

/** A staged pick wins over the saved photo so the edit preview is live. */
export function avatarUrlOf(state) {
  const u = state.user || {};
  if (state.pendingAvatarUrl) return state.pendingAvatarUrl;
  if (state.pendingRemove) return null;
  return u.avatarUrl || null;
}

/** "today" / "3 days ago" / a plain date past a fortnight. Returns null for
 *  anything unparseable, so the caller just omits the segment. */
export function relativeDate(iso, now = Date.now()) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((now - at) / 86400000);
  if (days < 0) return null;
  if (days === 0) return t('profile:date.today');
  if (days === 1) return t('profile:date.yesterday');
  if (days < 14) return t('profile:date.daysAgo', { count: days });
  try {
    return new Date(at).toLocaleDateString();
  } catch (_) {
    return null;
  }
}

/**
 * Flattens the /me/breakdown response (event | season | global scope) into
 * label/points rows: one per event, plus offchain points when present.
 */
export function breakdownRows(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return [];
  const rows = [];
  const pushEvent = (ev) => {
    if (!ev) return;
    const name = (ev.event && ev.event.name) || ev.event_name || t('profile:breakdown.event');
    rows.push({ label: name, points: ev.total_points });
  };
  if (breakdown.scope === 'event') {
    pushEvent(breakdown);
  } else if (Array.isArray(breakdown.events)) {
    breakdown.events.forEach(pushEvent);
  } else if (Array.isArray(breakdown.seasons)) {
    for (const season of breakdown.seasons) {
      (season.events || []).forEach(pushEvent);
    }
  }
  if (Number(breakdown.offchain_points || 0) > 0) {
    rows.push({ label: t('profile:breakdown.bonus'), points: breakdown.offchain_points });
  }
  return rows;
}

const CHIP_ZINC =
  'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ' +
  'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 ' +
  'hover:bg-zinc-200 dark:hover:bg-zinc-700';

/** Provider links in both the owner's card and the public card. The server
 * supplies this `links` object exclusively from OAuth-backed identity rows;
 * keeping the word Verified in the label makes that boundary visible rather
 * than asking a reader to infer it from where the link appeared. */
export function verifiedSocialLinksView(profile) {
  const links = (profile && profile.links) || {};
  const rows = [];
  const add = (key, label, href) => {
    const safe = safeHref(href);
    if (safe) {
      rows.push({
        key, label, href: safe, external: true, className: CHIP_ZINC,
      });
    }
  };
  if (typeof links.github === 'string' && links.github) {
    add('github', t('profile:social.github', { handle: links.github }),
      `https://github.com/${encodeURIComponent(links.github)}`);
  }
  if (typeof links.x === 'string' && links.x) {
    add('x', t('profile:social.x', { handle: links.x }),
      `https://x.com/${encodeURIComponent(links.x)}`);
  }
  return rows;
}

/** "Building since March 2026" — the prototype card's second line. */
export function memberSinceLabel(iso) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  try {
    return t('profile:identity.buildingSince', {
      date: new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    });
  } catch (_) {
    return null;
  }
}

/**
 * The identity card (#982) — who this profile belongs to. Compact now, as
 * the prototype draws it: the name, then ONE muted line of facts (the @handle
 * when a display name is the headline, how long they have been building, how
 * many apps they have shipped to), the bio, and the verified links.
 *
 * The "Your builder profile" chip left: it pointed at the viewer's proposed
 * PRs, which Your changes lists now.
 */
export function identityView(state) {
  const u = state.user || {};
  const summary = (state.data && state.data.summary) || null;
  const handle = (u.displayName && String(u.displayName).trim() && u.username)
    ? `@${u.username}` : null;
  const facts = [];
  if (handle) facts.push(handle);
  const since = summary ? memberSinceLabel(summary.memberSince) : null;
  if (since) facts.push(since);
  const apps = summary ? Number(summary.apps) || 0 : 0;
  if (apps > 0) facts.push(t('profile:identity.apps', { count: apps }));
  return {
    avatarUrl: avatarUrlOf(state),
    initial: initialOf(u),
    name: displayNameOf(u),
    handle,
    sub: factLine(facts),
    bio: u.bio || null,
    chips: verifiedSocialLinksView(u),
  };
}

/**
 * The three stat cards (the prototype's `.stat`): merged, kudos, challenges.
 * From GET /api/me/summary. A read that failed or has not answered shows a
 * dash rather than a zero — a 0 would be a claim.
 *
 * Y03 (audit, 2 Nov 2026): a zero says nothing. A card whose number is a
 * read zero is marked `zero`, and the screen hides it (kept in the DOM,
 * where a declared check selects on it): a new member's profile opened on
 * two large tiles reading "0 live" and "0 challenges".
 */
export function statsView(summary, { kudosParked = KUDOS_PARKED } = {}) {
  const has = !!summary;
  const value = (n) => (has ? Number(n || 0).toLocaleString() : '–');
  const zero = (n) => has && !(Number(n) > 0);
  // #5249: while kudos is parked (../leaderboard/kudos-parked.ts) there is no
  // kudos card, and merged and challenges share the row.
  return [
    { key: 'merged', value: value(summary && summary.merged), zero: zero(summary && summary.merged), label: t('profile:stats.live') },
    { key: 'kudos', value: value(summary && summary.kudos), zero: zero(summary && summary.kudos), label: t('profile:stats.kudos') },
    {
      key: 'challenges',
      value: value(summary && summary.challenges && summary.challenges.done),
      zero: zero(summary && summary.challenges && summary.challenges.done),
      label: t('profile:stats.challenges'),
    },
  ].filter((stat) => !(kudosParked && stat.key === 'kudos'));
}

/** "under 1m", "45m" or "3h 40m". */
function activityDuration(seconds) {
  if (seconds < 60) return t('profile:activity.underMinute');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('profile:activity.minutes', { minutes });
  return t('profile:activity.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * The "This week" card (#5626), your own profile's alone: time in apps over
 * today and the six UTC days before it, from GET /api/me/summary. Null when
 * the read failed, so the card is left out: a 0 would be a claim, as in
 * statsView. `empty` when there is nothing to say. Time of zero with apps
 * opened keeps the apps figure and draws no chart, the zero saying nothing.
 * A bar's height is against the busiest day, with a floor so the shortest
 * non-zero day still reads as a bar.
 *
 * #6464 adds the week's accomplishments, from the same seven UTC days: the
 * changes that went live (`week.merged`) and the challenges completed
 * (`week.challengesDone`). An older cached summary with no `week` is zeros.
 * The card is also what the Share action shares, so `canShare` says whether
 * it has anything to share at all.
 */
export function activityView(summary) {
  const activity = summary && summary.activity;
  if (!activity || !Array.isArray(activity.days)) return null;
  const total = Number(activity.totalSeconds) || 0;
  const apps = Number(activity.appsOpened) || 0;
  const week = (summary && summary.week) || {};
  const merged = Number(week.merged) || 0;
  const challengesDone = Number(week.challengesDone) || 0;
  if (!total && !apps && !merged && !challengesDone) return { empty: true };
  const busiest = Math.max(...activity.days.map((day) => Number(day.seconds) || 0), 0);
  const peak = activity.days.findIndex((day) => busiest > 0 && Number(day.seconds) === busiest);
  return {
    empty: false,
    canShare: true,
    time: total ? activityDuration(total) : null,
    apps: apps ? apps.toLocaleString() : null,
    appsLabel: t('profile:activity.appsLabel', { count: apps }),
    merged: merged ? merged.toLocaleString() : null,
    mergedLabel: merged ? t('profile:activity.mergedLabel', { count: merged }) : null,
    challenges: challengesDone ? challengesDone.toLocaleString() : null,
    challengesLabel: challengesDone
      ? t('profile:activity.challengesLabel', { count: challengesDone })
      : null,
    days: !total ? [] : activity.days.map((day, i) => {
      const seconds = Number(day.seconds) || 0;
      const at = new Date(`${day.date}T00:00:00Z`);
      const time = seconds ? activityDuration(seconds) : t('profile:activity.noTime');
      return {
        key: day.date,
        label: at.toLocaleDateString(getDateLocale(), { weekday: 'short', timeZone: 'UTC' }),
        spoken: t('profile:activity.daySpoken', {
          day: at.toLocaleDateString(getDateLocale(), { weekday: 'long', timeZone: 'UTC' }),
          time,
        }),
        heightPct: seconds ? Math.max(6, Math.round((seconds / busiest) * 100)) : 0,
        zero: !seconds,
        today: i === activity.days.length - 1,
        // The one figure on the plot: it gives the bars their scale.
        peakLabel: i === peak ? time : null,
      };
    }),
  };
}

/**
 * The "Share your week" card's list (#6464): every figure the week has, each
 * one switchable, and the public profile's link when the viewer has published
 * it. Only non-zero figures are offered — a zero says nothing, as on the
 * card — and `built` names the apps the viewer's own live changes were in.
 *
 * `origin` is a parameter so the function stays pure and testable outside a
 * browser; on the screen it is the page's own origin.
 */
export function shareWeekView(
  summary,
  ownerPublicProfile = null,
  origin = typeof location !== 'undefined' ? location.origin : '',
) {
  const activity = activityView(summary);
  const week = (summary && summary.week) || {};
  const items = [];
  if (activity && !activity.empty) {
    const apps = Number(summary && summary.activity && summary.activity.appsOpened) || 0;
    const merged = Number(week.merged) || 0;
    const challenges = Number(week.challengesDone) || 0;
    if (activity.time) items.push({ key: 'time', label: t('profile:weekShare.item.time', { time: activity.time }) });
    if (apps) items.push({ key: 'apps', label: t('profile:weekShare.item.apps', { count: apps, number: apps.toLocaleString() }) });
    if (merged) items.push({ key: 'merged', label: t('profile:weekShare.item.merged', { count: merged, number: merged.toLocaleString() }) });
    const appList = (Array.isArray(week.apps) ? week.apps : [])
      .map((app) => (app && app.slug
        ? { slug: String(app.slug), name: String(app.name || app.slug) }
        : null))
      .filter(Boolean);
    if (appList.length) {
      items.push({
        key: 'built',
        label: t('profile:weekShare.item.built', { apps: appList.map((app) => app.name).join(', ') }),
        // Each app's own page, so the shared line can put the app's name
        // beside its own link (#6464, as @alfa asked).
        apps: origin
          ? appList.map((app) => ({ name: app.name, url: `${origin}/#app/${encodeURIComponent(app.slug)}` }))
          : null,
      });
    }
    if (challenges) items.push({ key: 'challenges', label: t('profile:weekShare.item.challenges', { count: challenges, number: challenges.toLocaleString() }) });
  }
  const owner = ownerPublicProfile || null;
  const profile = (owner && owner.profile) || {};
  const url = typeof profile.url === 'string' ? profile.url : '';
  // The address every shared figure carries (#6464, as @alfa asked): the
  // public profile's own page when it exists and moderation has not hidden
  // it, otherwise the app's own address, so no line goes out as a bare
  // number. Never a page that would not open for the reader.
  const link = origin
    ? (owner && owner.published && !owner.moderationDisabled && url ? `${origin}${url}` : origin)
    : null;
  return { items, link };
}

/**
 * The words the Share and Copy buttons send: one line per selected figure.
 * A figure that names apps carries each app's own name beside its own link,
 * so a reader can tell which link belongs to which app (#6464, as @alfa
 * asked); every other line carries the page's address, `shareWeekView`'s
 * `link`: the public profile's page, or the app's own when that page is not
 * public. Empty when nothing is selected.
 */
export function shareText(items, selectedKeys, link = null) {
  const chosen = (items || []).filter((item) => !selectedKeys
    || (selectedKeys instanceof Set ? selectedKeys.has(item.key) : selectedKeys.includes(item.key)));
  const lines = chosen
    .map((item) => {
      const apps = Array.isArray(item.apps) ? item.apps.filter((app) => app && app.url) : [];
      if (apps.length) {
        return t('profile:weekShare.item.built', {
          apps: apps
            .map((app) => t('profile:weekShare.appWithUrl', { name: app.name, url: app.url }))
            .join(', '),
        });
      }
      const label = (item.label || '').trim();
      if (!label) return '';
      return link ? t('profile:weekShare.itemWithUrl', { fact: label, url: link }) : label;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return t('profile:weekShare.intro', { facts: lines.join('\n') });
}

/**
 * The "More" rows' second lines — each says what is behind its row, as the
 * prototype's do ("Season 3 · rank #3 · 2 of 3 this week", "3 received").
 * Null when there is nothing true to say yet.
 */
export function moreRowsView(data) {
  const d = data || {};
  const r = d.ranking || {};
  const summary = d.summary || null;
  const challenges = [];
  const seasonName = r.season_name || (summary && summary.challenges && summary.challenges.season
    && summary.challenges.season.name) || null;
  if (seasonName) challenges.push(seasonName);
  if (r.rank) challenges.push(t('profile:more.challenges.rank', { rank: Number(r.rank) }));
  if (summary && summary.challenges && Number(summary.challenges.total) > 0) {
    challenges.push(t('profile:more.challenges.done', {
      done: Number(summary.challenges.done || 0), count: Number(summary.challenges.total),
    }));
  }
  const kudos = summary ? Number(summary.kudos) || 0 : null;
  return {
    challenges: factLine(challenges),
    kudos: kudos == null ? null : t('profile:more.kudos.received', { count: kudos, number: kudos.toLocaleString() }),
    changes: changesLine(summary),
    requests: requestsLine(d.requests),
    // The page draws before the requests' counts land (profile.js _load);
    // until then their row holds its line's place rather than saying what is
    // behind it.
    requestsPending: !!d.requestsPending,
    votes: votesLine(d.votes),
    friends: friendsLine(d.friends),
    feedback: feedbackLine(d.feedback),
  };
}

// ── Your work's lines (UI overhaul) ─────────────────────────────────────
//
// Each says what is there in words, and a zero says nothing: "12 merged ·
// 2 in progress" drops the half that is zero, and when both are, the row
// falls back to saying what is behind it. Null whenever the read failed or
// has not answered, for the same reason.

/** "12 live · 2 in progress", from GET /api/me/summary. */
function changesLine(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const parts = [];
  const merged = Number(summary.merged) || 0;
  const underway = Number(summary.inProgress) || 0;
  if (merged) parts.push(t('profile:work.changes.live', { count: merged, number: merged.toLocaleString() }));
  if (underway) parts.push(t('profile:work.changes.inProgress', { count: underway, number: underway.toLocaleString() }));
  return factLine(parts);
}

/** "2 open · 1 done", from GET /api/me/requests?counts=1 ({ open, done }). */
function requestsLine(requests) {
  if (!requests || typeof requests !== 'object') return null;
  const parts = [];
  const open = Number(requests.open) || 0;
  const done = Number(requests.done) || 0;
  if (open) parts.push(t('profile:work.requests.open', { count: open, number: open.toLocaleString() }));
  if (done) parts.push(t('profile:work.requests.done', { count: done, number: done.toLocaleString() }));
  return factLine(parts);
}

/** "Latest: <what you voted on>", from GET /api/me/history?type=votes&limit=1. */
function votesLine(votes) {
  const item = votes && Array.isArray(votes.items) ? votes.items[0] : null;
  if (!item) return null;
  const title = voteTitle(item);
  return title ? t('profile:work.votes.latest', { title }) : null;
}

/** "1 request waiting". Friends are never counted (#2386), only requests to answer. */
function friendsLine(friends) {
  const incoming = friends && Array.isArray(friends.incoming) ? friends.incoming.length : 0;
  if (!incoming) return null;
  return t('profile:more.friends.waiting', { count: incoming, number: incoming.toLocaleString() });
}

/** "4 sent · 1 counted", from GET /api/feedback/mine (#3186); "4 sent" while
 *  none has counted, since a zero says nothing. Null when the read failed or
 *  has not answered, so the row falls back to saying what is behind it rather
 *  than claiming none were sent. */
function feedbackLine(feedback) {
  if (!feedback || typeof feedback !== 'object' || !Number.isFinite(Number(feedback.sent))) return null;
  const sent = Number(feedback.sent) || 0;
  if (sent === 0) return t('profile:feedback.summary.none');
  const counted = Number(feedback.counted) || 0;
  return counted
    ? t('profile:feedback.summary.sentCounted', { count: sent, number: sent.toLocaleString(), counted: counted.toLocaleString() })
    : t('profile:feedback.summary.sent', { count: sent, number: sent.toLocaleString() });
}

/** A report's status as the list says it. Two, not three: see
 *  MY_FEEDBACK_SQL in src/routes/feedback.js for why there is no "reviewed". */
const FEEDBACK_STATUS = {
  received: {
    label: 'profile:feedback.status.received',
    className: 'shrink-0 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-zinc-700 dark:text-zinc-300',
  },
  counted: {
    label: 'profile:feedback.status.counted',
    className: 'shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-emerald-700 dark:text-emerald-400',
  },
};

/** A slug the shell routes to, the shape an app slug has. Anything else gets
 *  no link at all rather than an address built from it. */
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * "Your feedback" (#3186): the viewer's own reports, newest first, from
 * GET /api/feedback/mine. Each row says what was sent (its title and where
 * it went), its status, and links to the request it became, on that app's
 * board. `loaded: false` is a read that failed, told apart from "nothing
 * sent yet".
 */
export function feedbackListView(feedback, now = Date.now()) {
  const valid = feedback && typeof feedback === 'object' && Array.isArray(feedback.reports);
  if (!valid) return { loaded: false, summary: null, truncated: false, rows: [] };
  const rows = feedback.reports.filter((r) => r && r.id != null).map((r) => {
    const status = r.status === 'counted' ? 'counted' : 'received';
    const issue = Number(r.issueNumber);
    const slug = typeof r.appSlug === 'string' && APP_SLUG.test(r.appSlug) ? r.appSlug : null;
    const linked = !!slug && Number.isSafeInteger(issue) && issue > 0;
    const meta = [r.appName ? String(r.appName) : (r.target === 'platform' ? 'Homeroom' : t('profile:feedback.anApp'))];
    if (linked) meta.push(t('profile:feedback.request', { number: issue }));
    const when = mergedAgo(r.createdAt, now);
    if (when) meta.push(t('profile:feedback.sent', { when }));
    const points = Number(r.points);
    const secondsLeft = r.edit ? Math.max(0, Number(r.edit.secondsLeft)
      - Math.max(0, now - (feedback.receivedAt ?? now)) / 1000) : 0;
    return {
      key: String(r.id),
      title: r.title ? String(r.title) : t('profile:feedback.fallbackTitle'),
      meta: factLine(meta),
      status,
      statusLabel: status === 'counted' && points > 0
        ? t('profile:feedback.status.countedPoints', { count: points, points: points.toLocaleString() })
        : t(FEEDBACK_STATUS[status].label),
      statusClassName: FEEDBACK_STATUS[status].className,
      href: linked ? `#app/${encodeURIComponent(slug)}/dev/issues/${issue}` : null,
      edit: secondsLeft > 0 ? { ...r.edit, expiresAt: now + secondsLeft * 1000 } : null,
    };
  });
  return {
    loaded: true,
    summary: feedbackLine(feedback),
    truncated: !!feedback.truncated,
    rows,
  };
}

/** "3 days ago", or "Sep 3" (with the year once it is not this one) past a
 *  fortnight — a month and day reads in every locale, "9/3/2026" does not. */
export function mergedAgo(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((now - at) / 86400000);
  if (days >= 0 && days < 14) return relativeDate(iso, now);
  const date = new Date(at);
  const opts = date.getFullYear() === new Date(now).getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return date.toLocaleDateString(undefined, opts);
  } catch (_) {
    return null;
  }
}

/** What a vote was cast on, by its title: the Your votes row's latest one. */
function voteTitle(item) {
  if (item.type === 'pr_vote') {
    const pr = item.pr || {};
    return pr.title ? String(pr.title)
      : (pr.number ? t('profile:votes.title.change', { number: Number(pr.number) }) : t('profile:votes.title.aChange'));
  }
  const issue = item.issue || {};
  return issue.title ? String(issue.title) : t('profile:votes.title.decision');
}

/** The opt-in public profile's owner controls (#582). */
export function publicControlsView(state) {
  const owner = state.data && state.data.ownerPublicProfile;
  if (!owner) return null;
  const profile = owner.profile || {};
  return {
    profile,
    published: !!owner.published,
    moderationDisabled: !!owner.moderationDisabled,
    // #2787: the second line of the sheet's "Public profile" switch row, so it
    // says what the state MEANS rather than a bare "Published"/"Private".
    visibility: owner.moderationDisabled
      ? t('profile:edit.public.hidden')
      : owner.published
        ? t('profile:edit.public.on')
        : t('profile:edit.public.off'),
    visibilityClass: owner.moderationDisabled
      ? 'text-red-700 dark:text-red-400'
      : owner.published
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-zinc-500 dark:text-zinc-400',
    openHref: profile.url || `#profile/${encodeURIComponent(profile.username || '')}`,
  };
}

/** The avatar block on a PUBLIC profile card, which is a different shape: the
 *  initial sits behind an absolutely-positioned image so a failed load can drop
 *  the image and reveal the fallback without shifting layout. */
export function publicAvatarView(profile) {
  const source = String(profile.displayName || profile.username || '?');
  const match = source.match(/[\p{L}\p{N}]/u);
  const url = (typeof profile.avatarUrl === 'string'
    && /^\/avatars\/[a-f0-9]{32}$/.test(profile.avatarUrl))
    ? profile.avatarUrl : null;
  return { initial: match ? match[0].toUpperCase() : '?', url };
}

/** "March 2026" — how long two people have been friends. */
function monthYear(iso) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  try {
    return new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } catch (_) {
    return null;
  }
}

/**
 * The own profile's private Friends section (#2386): requests waiting on you,
 * then your friends, each a link to their page, then the requests you sent
 * and can still withdraw. From GET /api/friends, which only ever answers the
 * viewer's own lists — this is never drawn on anybody else's page, and it
 * counts nothing.
 *
 * The sent requests are here because the pending cap (20) tells you to cancel
 * one, and this is the one place they are all listed. A request that was
 * declined still reads "Requested": the sender is never told.
 *
 * `loaded: false` is a read that failed (or has not answered), told apart
 * from "no friends yet", as every list here tells a failure from an empty one.
 */
export function friendsView(lists, now = Date.now()) {
  const valid = lists && typeof lists === 'object'
    && Array.isArray(lists.friends) && Array.isArray(lists.incoming);
  if (!valid) return { loaded: false, incoming: [], friends: [], outgoing: [] };
  const row = (p, meta) => {
    const username = String(p.username || '');
    const match = username.match(/[\p{L}\p{N}]/u);
    return {
      key: String(p.id),
      id: Number(p.id),
      username,
      href: `#profile/${encodeURIComponent(username)}`,
      avatarUrl: typeof p.avatarUrl === 'string' && /^\/avatars\/[a-f0-9]{32}$/.test(p.avatarUrl)
        ? p.avatarUrl : null,
      initial: match ? match[0].toUpperCase() : '?',
      meta,
    };
  };
  const people = (items) => items.filter((p) => p && Number(p.id) > 0 && p.username);
  return {
    loaded: true,
    incoming: people(lists.incoming).map((p) => {
      // Short, because the row also carries Accept and Decline: on a phone
      // the name and this line share what the two buttons leave.
      const when = mergedAgo(p.requestedAt, now);
      return row(p, when ? t('profile:friends.asked', { when }) : t('profile:friends.askedUndated'));
    }),
    friends: people(lists.friends).map((p) => {
      const since = monthYear(p.since);
      return row(p, since ? t('profile:friends.since', { date: since }) : t('profile:friends.sinceUndated'));
    }),
    outgoing: people(Array.isArray(lists.outgoing) ? lists.outgoing : []).map((p) => {
      const when = mergedAgo(p.requestedAt, now);
      return row(p, when ? t('profile:friends.requested', { when }) : t('profile:friends.requestedUndated'));
    }),
  };
}

/**
 * The backend zeroes total_tokens until terms are accepted, so a gated
 * allocation must show the terms notice, never a fake 0 balance (mirrors the
 * native TokenAllocationGatedNotice).
 */
export function tokenView(ranking, revealed) {
  if (ranking.terms_accepted === false) return { gated: true };
  const amount = Number(ranking.total_tokens || 0);
  return {
    gated: false,
    // #1552: nothing allocated yet is its own state, not a zero to reveal.
    // `total_tokens` sums this user's `token_allocation.allocated_tokens`
    // across seasons, so it is 0 for everyone who has not been allocated
    // any — which is most people. Blurring that 0 behind a "Reveal" button
    // builds up to nothing and reads as either a bug or a snub; the card
    // says so in words instead.
    empty: amount === 0,
    amount: amount.toLocaleString(),
    revealed: !!revealed,
  };
}

/**
 * The whole screen, as one discriminated view. `empty` is the initial value and
 * the only one the prerender pass can produce.
 */
export function buildProfileView(state, now = Date.now()) {
  if (!state.open) return { kind: 'empty' };
  const d = state.data;
  if (!d) return { kind: 'loading' };
  if (d.signedOut) return { kind: 'signedOut' };
  if (d.error) return { kind: 'error' };
  if (d.publicNotFound) return { kind: 'publicNotFound' };
  if (d.publicProfile) {
    const viewer = state.user || {};
    // Someone else's page, seen by a signed-in viewer with platform access.
    // No self-report, no report from a signed-out or access-less visitor —
    // and the same for Message: Messages is a signed-in, admitted surface,
    // and you do not message yourself. The handle comparison ignores case,
    // as the username directory does.
    const other = !!viewer.username
      && viewer.hasPlatformAccess !== false
      && String(viewer.username).toLowerCase() !== String(d.publicProfile.username || '').toLowerCase();
    // #2386: the viewer's own relationship with this person, as the payload
    // carried it. Drawn only where Message is — someone else's page, seen by
    // a signed-in viewer with access — and only when the server sent one.
    const f = d.publicFriendship;
    const friendship = other && f && Number(f.userId) > 0
      && ['none', 'outgoing', 'incoming', 'friends'].includes(f.state)
      ? { userId: Number(f.userId), state: f.state }
      : null;
    return {
      kind: 'public',
      profile: d.publicProfile,
      allowReport: other,
      allowMessage: other,
      friendship,
    };
  }

  return {
    kind: 'own',
    identity: identityView(state),
    publicControls: publicControlsView(state),
    stats: statsView(d.summary || null),
    activity: activityView(d.summary || null),
    weekShare: shareWeekView(d.summary || null, d.ownerPublicProfile || null),
    rows: moreRowsView(d),
    friends: friendsView(d.friends || null, now),
    feedback: feedbackListView(d.feedback || null, now),
  };
}
