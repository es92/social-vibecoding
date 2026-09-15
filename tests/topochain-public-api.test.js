// Topochain v4 public reads (plan Task 5; SPEC §4.2/§4.9/§4.10).
//
// HTTP-level tests against a throwaway express app + a regex-dispatching
// mock pool (same idiom as tests/board-order.test.js and
// tests/topochain-foundation.test.js's mobileTokenAuth suite) — no live
// DB. The mock pool re-implements each distinct SQL shape public.js and
// standings.js issue as a small JS computation over an in-memory fixture
// set, matched by a distinctive (whitespace-collapsed) substring per
// query — see the comment above `dispatch()` for the full list.
//
// Run with: node --test tests/topochain-public-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

// ─── Fixture data ─────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

const USERS = [
  { id: 1, email: 'alice@example.com', telegram: null, discord: null, display_name: null, exclude_podium: true },
  { id: 2, email: 'bob@example.com', telegram: null, discord: 'bobdiscord', display_name: null, exclude_podium: false },
  { id: 3, email: null, telegram: 'carolTG', discord: null, display_name: 'Carol Display', exclude_podium: false },
  { id: 4, email: 'dave@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
  { id: 5, email: 'erin@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
  // frank: enrolled (event 101) but has no snapshots/activities — a
  // participant who never scored, used by the "valid identifier, empty
  // result" tests.
  { id: 6, email: 'frank@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
  // grace: an ordinary PLATFORM web account sharing the users table — no
  // enrollment, no snapshot, no onchain account. The participant-scoping
  // fix must make her unresolvable through the public endpoints exactly
  // like an unknown identifier/id (enumeration-oracle regression).
  { id: 7, email: 'platform-only@example.com', telegram: 'graceTG', discord: 'gracediscord', display_name: 'Grace', exclude_podium: false },
];

const SEASON_EVENTS = [
  {
    id: 100, name: 'Sprint One', description: 'Regular fixture event', starts_at: T(-10), ends_at: T(10),
    is_active: true, internal: false, display_leaderboard: true, disclaimer: 'Please read the rules.',
    season_id: 10, type: 'regular', chain_id: 'chain-1', start_epoch: 1, end_epoch: 3,
  },
  {
    // starts_at/ends_at both in the past (already ended) so this event is
    // never picked as the "current" default fallback for GET /leaderboard
    // (SPEC 910) — it's only reached in these tests via an explicit
    // season_event_id=101, which doesn't apply the temporal filter.
    id: 101, name: 'Hidden Leaderboard Event', description: 'display_leaderboard=false', starts_at: T(-20), ends_at: T(-10),
    is_active: true, internal: false, display_leaderboard: false, disclaimer: null,
    season_id: 10, type: 'regular', chain_id: 'chain-2', start_epoch: null, end_epoch: null,
  },
  {
    id: 102, name: 'Internal Event', description: 'internal, never public', starts_at: T(-2), ends_at: T(2),
    is_active: true, internal: true, display_leaderboard: true, disclaimer: null,
    season_id: 10, type: 'regular', chain_id: null, start_epoch: null, end_epoch: null,
  },
  {
    id: 103, name: 'Season Wrap-up', description: "type='season' pseudo-event", starts_at: T(20), ends_at: T(30),
    is_active: true, internal: false, display_leaderboard: true, disclaimer: null,
    season_id: 10, type: 'season', chain_id: null, start_epoch: null, end_epoch: null,
  },
  {
    id: 104, name: 'Inactive Past Event', description: 'is_active=false', starts_at: T(-60), ends_at: T(-50),
    is_active: false, internal: false, display_leaderboard: true, disclaimer: null,
    season_id: 10, type: 'regular', chain_id: null, start_epoch: null, end_epoch: null,
  },
];

const ONCHAIN_ACCOUNTS = [
  { id: 1, user_id: 2, season_event_id: 100, season_id: 10, public_key: 'pk-bob-100', address: 'addr-bob-100' },
  { id: 2, user_id: 5, season_event_id: null, season_id: 10, public_key: 'pk-erin-season', address: 'addr-erin-season' },
  { id: 3, user_id: 4, season_event_id: 100, season_id: 10, public_key: 'pk-dave-100', address: 'addr-dave-100' },
];

// One snapshot per user for event 100 only (event 101/102/103/104 have
// none) — rank reflects a shared-rank result already applied upstream
// (user 1 is podium-excluded and shares rank 3 with user 3, per SPEC 959).
const LEADERBOARD_SNAPSHOTS = [
  {
    id: 1, season_event_id: 100, user_id: 4, rank: 1, total_points: '500.00', extra_points: '10.00',
    snapshot_at: T(-1), event_total_produced_blocks: 40, event_success_rate: '66.67', epoch_success_rate: '60.00',
    bug_report_points: 0, inviting_new_participant_points: 0, community_contribution_points: 0,
    last_epoch_total_produced_blocks: 5, vrf_total_won_slots: 12, canonical_total_won_slots: 10,
    canonical_total_produced_blocks: 9, canonical_won_slots_up_to_current: 10,
    canonical_produced_blocks_up_to_current: 9, max_bp_success_rate_up_to_current: '80.00',
    first_block_points: 25, produced_half_blocks_points: 0, top_3_points: 50, success_50_percent_points: 25,
    challenge_details: { note: 'dave' },
  },
  {
    id: 2, season_event_id: 100, user_id: 2, rank: 2, total_points: '300.00', extra_points: '0.00',
    snapshot_at: T(-1), event_total_produced_blocks: 20, event_success_rate: '50.00', epoch_success_rate: null,
    bug_report_points: 0, inviting_new_participant_points: 0, community_contribution_points: 0,
    last_epoch_total_produced_blocks: 2, vrf_total_won_slots: 8, canonical_total_won_slots: 6,
    canonical_total_produced_blocks: 5, canonical_won_slots_up_to_current: 6,
    canonical_produced_blocks_up_to_current: 5, max_bp_success_rate_up_to_current: '70.00',
    first_block_points: 0, produced_half_blocks_points: 0, top_3_points: 0, success_50_percent_points: 0,
    challenge_details: null,
  },
  {
    id: 3, season_event_id: 100, user_id: 1, rank: 3, total_points: '100.00', extra_points: '0.00',
    snapshot_at: T(-1), event_total_produced_blocks: 5, event_success_rate: '0.00', epoch_success_rate: '0.00',
    bug_report_points: 0, inviting_new_participant_points: 0, community_contribution_points: 0,
    last_epoch_total_produced_blocks: 0, vrf_total_won_slots: 0, canonical_total_won_slots: 0,
    canonical_total_produced_blocks: 0, canonical_won_slots_up_to_current: 0,
    canonical_produced_blocks_up_to_current: 0, max_bp_success_rate_up_to_current: '0.00',
    first_block_points: 0, produced_half_blocks_points: 0, top_3_points: 0, success_50_percent_points: 0,
    challenge_details: null,
  },
  {
    id: 4, season_event_id: 100, user_id: 3, rank: 3, total_points: '50.00', extra_points: '0.00',
    snapshot_at: T(-1), event_total_produced_blocks: 1, event_success_rate: null, epoch_success_rate: null,
    bug_report_points: 0, inviting_new_participant_points: 0, community_contribution_points: 0,
    last_epoch_total_produced_blocks: 0, vrf_total_won_slots: 0, canonical_total_won_slots: 0,
    canonical_total_produced_blocks: 0, canonical_won_slots_up_to_current: 0,
    canonical_produced_blocks_up_to_current: 0, max_bp_success_rate_up_to_current: '0.00',
    first_block_points: 0, produced_half_blocks_points: 0, top_3_points: 0, success_50_percent_points: 0,
    challenge_details: null,
  },
];

const CHALLENGE_TEMPLATES = [
  {
    id: 1, category: 'bug', goal: 'Report a bug', task: 'File a report', reward: '100 points',
    description: 'Template description', requirements: 'Template requirements', schedule_start: null, schedule_end: null,
    reward_logic: 'flat', cta_button: 'Report', cta_label: 'Report a bug', cta_link: 'https://example.com/report',
    created_at: T(-100), updated_at: T(-90), kind: 'REPORT_BUG_CHALLENGE', cta_type: 'link',
    mobile_cta_type: 'deeplink', mobile_cta_label: 'Report', mobile_cta_link: 'app://report',
    metric_type: null, metric_target: null, metric_label: null,
    illustration: null,
  },
  {
    id: 2, category: 'onchain', goal: 'Produce a block', task: 'Produce at least one block', reward: '250 points',
    description: 'Block production template', requirements: 'Testnet account', schedule_start: null, schedule_end: null,
    reward_logic: 'flat', cta_button: 'Produce', cta_label: 'Produce a block', cta_link: 'https://example.com/produce',
    created_at: T(-100), updated_at: T(-90), kind: 'SEND_TRANSACTION_CHALLENGE', cta_type: 'link',
    mobile_cta_type: 'deeplink', mobile_cta_label: 'Produce', mobile_cta_link: 'app://produce',
    metric_type: 'blocks_produced', metric_target: '1.0000', metric_label: 'blocks',
    illustration: 'block-production',
  },
];

const CHALLENGES = [
  {
    id: 10, season_event_id: 100, challenge_template_id: 1, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, enabled: true, display_order: 1, kind: null,
    // A metric set on the CHALLENGE row over a template with none: the list
    // item's `metric` must be this effective one, while `activity_type`
    // stays the template's by contract.
    metric_type: 'count', metric_target: '3.0000', metric_label: 'bugs filed',
  },
  {
    // Organiser-FINISHED (#981): the one fixture carrying `completed`, so the
    // list-item mapper's flag is pinned in both directions — ids 10/12 leave
    // the key off entirely, which is the "row doesn't carry the column" case
    // the mapper's `=== true` coercion exists for.
    id: 11, season_event_id: 100, challenge_template_id: 2, goal: 'Produce your first block (overridden)',
    task: null, reward: null, description: null, requirements: null, schedule_start: null, schedule_end: null,
    reward_logic: null, cta_button: null, cta_label: null, cta_link: null, enabled: true, completed: true,
    display_order: 2, kind: null,
  },
  {
    id: 12, season_event_id: 100, challenge_template_id: 1, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, enabled: false, display_order: 3, kind: null,
  },
];

const USER_ACTIVITIES = [
  { id: 1, user_id: 2, season_event_id: 100, activity_type: 'block_produced', points: '100.00', description: 'Produced a block', activity_at: T(-3), metadata: {}, challenge_id: 11 },
  { id: 2, user_id: 4, season_event_id: 100, activity_type: 'block_produced', points: '150.00', description: 'Produced a block', activity_at: T(-2), metadata: {}, challenge_id: 11 },
  { id: 3, user_id: 2, season_event_id: 100, activity_type: 'bug_report', points: '50.00', description: 'Filed a bug', activity_at: T(-4), metadata: {}, challenge_id: 10 },
  { id: 4, user_id: 5, season_event_id: 100, activity_type: 'bug_report', points: '75.50', description: 'Erin filed a bug', activity_at: T(-1), metadata: { note: 'x' }, challenge_id: 10 },
];

// Keyed by the CANONICAL `address` (bech32m) form only — real epoch_stats
// never carries the public_key form — so a request that passes the
// public_key form must be resolved to this address before querying (the
// review-fix regression this fixture exists to catch).
const EPOCH_STATS = [
  { chain_id: 'chain-1', wallet_address: 'addr-dave-100', epoch: 1, epoch_won_slots: 2, epoch_produced_blocks: 1 },
  { chain_id: 'chain-1', wallet_address: 'addr-dave-100', epoch: 2, epoch_won_slots: 3, epoch_produced_blocks: 2 },
  { chain_id: 'chain-1', wallet_address: 'addr-dave-100', epoch: 3, epoch_won_slots: 0, epoch_produced_blocks: 0 },
];

const APP_VERSION_CONFIGS = [
  {
    os: 'ios', min_build_number: 100, recommended_build_number: 110, is_active: true,
    must_update_message: null, should_update_message: 'Update recommended.', update_url: 'https://example.com/ios',
  },
];

const USER_ENROLLMENTS = [
  { season_event_id: 100, user_id: 2 },
  { season_event_id: 100, user_id: 4 },
  { season_event_id: 100, user_id: 5 },
  // frank is enrolled in event 101 (not 100) so /season-events/100's
  // users_count stays 3 while frank still counts as a participant for
  // the enrollment-or-snapshot scoping predicate below.
  { season_event_id: 101, user_id: 6 },
];

// Mirrors the participant predicate the routes now apply (security fix):
// EXISTS(user_enrollments) OR EXISTS(leaderboard_snapshots) — any user
// matching neither is a plain platform account and must be unresolvable.
function isParticipant(userId) {
  return USER_ENROLLMENTS.some((e) => e.user_id === userId)
    || LEADERBOARD_SNAPSHOTS.some((s) => s.user_id === userId);
}

// ─── Mock pool: SQL shape -> in-memory computation ──────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function latestPerUserForEvent(eventId) {
  const byUser = new Map();
  for (const s of LEADERBOARD_SNAPSHOTS) {
    if (s.season_event_id !== eventId) continue;
    const cur = byUser.get(s.user_id);
    if (!cur || s.snapshot_at > cur.snapshot_at || (s.snapshot_at.getTime() === cur.snapshot_at.getTime() && s.id > cur.id)) {
      byUser.set(s.user_id, s);
    }
  }
  return [...byUser.values()];
}

function computeStandingsRows(seasonId) {
  const events = SEASON_EVENTS.filter((e) => !e.internal && (seasonId == null || e.season_id === seasonId));
  const byUser = new Map();
  for (const e of events) {
    for (const s of latestPerUserForEvent(e.id)) {
      const acc = byUser.get(s.user_id) || {
        user_id: s.user_id, total_points: 0, extra_points: 0, events: new Set(),
        total_produced_blocks: 0, lastStartsAt: null, lastProduced: 0,
      };
      acc.total_points += Number(s.total_points);
      acc.extra_points += Number(s.extra_points);
      acc.events.add(s.season_event_id);
      acc.total_produced_blocks += Number(s.event_total_produced_blocks) || 0;
      if (!acc.lastStartsAt || e.starts_at > acc.lastStartsAt) {
        acc.lastStartsAt = e.starts_at;
        acc.lastProduced = Number(s.event_total_produced_blocks) || 0;
      }
      byUser.set(s.user_id, acc);
    }
  }
  const rows = [...byUser.values()].map((acc) => {
    const user = USERS.find((u) => u.id === acc.user_id);
    return {
      user_id: acc.user_id,
      total_points: acc.total_points.toFixed(2),
      extra_points: acc.extra_points.toFixed(2),
      events_participated: acc.events.size,
      total_produced_blocks: acc.total_produced_blocks,
      total_produced_blocks_last_event: acc.lastProduced,
      is_non_podium: user.exclude_podium,
      email: user.email, telegram: user.telegram, discord: user.discord, display_name: user.display_name,
    };
  });
  rows.sort((a, b) => Number(b.total_points) - Number(a.total_points) || a.user_id - b.user_id);
  return rows;
}

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);
    if (sql.startsWith('/* challenge onboarding */')) return { rows: [] };

    // standings.js shared aggregate (used by /leaderboard/global, the
    // 'season'/'all_time' branch of fetchEventLeaderboardRows, and the
    // profile all-time mode).
    if (sql.includes('last_event AS')) {
      return { rows: computeStandingsRows(params[0] ?? null) };
    }

    // GET /leaderboard: regular-event rows (EVENT_LEADERBOARD_SQL).
    if (sql.includes('accounts AS (')) {
      const eventId = params[0];
      const event = SEASON_EVENTS.find((e) => e.id === eventId);
      const rows = latestPerUserForEvent(eventId)
        .slice()
        .sort((a, b) => a.rank - b.rank || Number(b.total_points) - Number(a.total_points))
        .map((s) => {
          const user = USERS.find((u) => u.id === s.user_id);
          const acct = ONCHAIN_ACCOUNTS.find((a) => a.user_id === s.user_id
            && (a.season_event_id === eventId || (a.season_event_id == null && a.season_id === event.season_id)));
          return {
            ...s,
            email: user.email, telegram: user.telegram, discord: user.discord,
            display_name: user.display_name, exclude_podium: user.exclude_podium,
            wallet_address: acct ? acct.public_key : null, bech32m: acct ? acct.address : null,
          };
        });
      return { rows };
    }

    // GET /leaderboard: default event lookup. Since #999 this is the SHARED
    // rule (resolveDefaultPublicEvent / DEFAULT_PUBLIC_EVENT_SQL in
    // src/services/topochain/event-standings.js), not a strict "temporally
    // ongoing" query of this route's own — so the API's default matches the
    // home widget's and the screen's, and stops 404ing between events.
    // Four ordered steps, mirroring that SQL's ORDER BY keys:
    //   1. a `type = 'season'` event that has STARTED;
    //   2. the event running right now (is_active + in window);
    //   3. the most recently STARTED event;
    //   4. the soonest upcoming one.
    if (sql.includes('season_id, type, starts_at, ends_at')
        && sql.includes('display_leaderboard = TRUE') && sql.includes('LIMIT 1')) {
      const now = new Date();
      const started = (e) => e.starts_at <= now;
      const rows = SEASON_EVENTS
        .filter((e) => !e.internal && e.display_leaderboard)
        .sort((a, b) => (Number(b.type === 'season' && started(b)) - Number(a.type === 'season' && started(a)))
          || (Number(b.is_active && started(b) && b.ends_at >= now)
            - Number(a.is_active && started(a) && a.ends_at >= now))
          || (Number(started(b)) - Number(started(a)))
          || (started(a) ? b.starts_at - a.starts_at : a.starts_at - b.starts_at)
          || b.id - a.id);
      return { rows: rows.slice(0, 1) };
    }
    // GET /leaderboard: requested season_event_id lookup.
    if (sql.includes('disclaimer, display_leaderboard') && sql.includes('WHERE id = $1')) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [event] : [] };
    }

    // GET /leaderboard/epoch-breakdown: season_events lookup (has chain_id).
    if (sql.includes('chain_id, internal, season_id')) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [event] : [] };
    }
    // GET /leaderboard/epoch-breakdown: onchain account lookup (returns the
    // canonical `address`, matched by either public_key or address form).
    if (sql.includes('SELECT address FROM onchain_accounts')) {
      const [wallet, eventId, seasonId] = params;
      const acct = ONCHAIN_ACCOUNTS.find((a) => (a.public_key === wallet || a.address === wallet)
        && (a.season_event_id === eventId || (a.season_event_id == null && a.season_id === seasonId)));
      return { rows: acct ? [{ address: acct.address }] : [] };
    }
    // GET /leaderboard/epoch-breakdown: epoch_stats rows.
    if (sql.includes('FROM epoch_stats')) {
      const [chainId, wallet, startEpoch, endEpoch] = params;
      const rows = EPOCH_STATS
        .filter((r) => r.chain_id === chainId && r.wallet_address === wallet
          && (startEpoch == null || (r.epoch >= startEpoch && r.epoch <= endEpoch)))
        .sort((a, b) => a.epoch - b.epoch)
        .map((r) => ({
          epoch: r.epoch, total_won_slots: r.epoch_won_slots, chain_total_produced_blocks: r.epoch_produced_blocks,
        }));
      return { rows };
    }

    // GET /leaderboard/user-activities: bare season_events existence check.
    if (/^SELECT id FROM season_events WHERE id = \$1$/.test(sql)) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [{ id: event.id }] : [] };
    }
    // GET /leaderboard/user-activities: identifier resolution (UNION),
    // participant-scoped on the email/telegram/discord branch (the
    // onchain-account branch is inherently topochain-scoped — see the
    // route's own comment).
    if (sql.includes('UNION') && sql.includes('oa.address = $1')) {
      const identifier = params[0];
      const byField = USERS.find((u) => (u.email === identifier || u.telegram === identifier || u.discord === identifier)
        && isParticipant(u.id));
      if (byField) return { rows: [{ id: byField.id }] };
      const acct = ONCHAIN_ACCOUNTS.find((a) => a.address === identifier && a.user_id != null);
      return { rows: acct ? [{ id: acct.user_id }] : [] };
    }
    // GET /leaderboard/user-activities: activities list (has `metadata`).
    if (sql.includes('metadata') && sql.includes('FROM user_activities')) {
      const [userId, eventId] = params;
      const rows = USER_ACTIVITIES
        .filter((a) => a.user_id === userId && a.season_event_id === eventId)
        .sort((a, b) => b.activity_at - a.activity_at);
      return { rows };
    }

    // GET /season-events/{id}/challenges: bare season_events check.
    if (sql.includes('id, internal FROM season_events')) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [{ id: event.id, internal: event.internal }] : [] };
    }
    // GET /users/{id}/profile (event mode): season_events check.
    if (sql.includes('id, internal, season_id FROM season_events')) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [{ id: event.id, internal: event.internal, season_id: event.season_id }] : [] };
    }

    // GET /season-events (list, no placeholders at all). The select also
    // carries display_leaderboard, so a client can default to an event
    // whose standings actually render (public/js/topochain-events.js).
    if (sql.includes('display_activities, display_leaderboard')) {
      const includePast = sql.includes('WHERE internal = FALSE ORDER');
      const rows = SEASON_EVENTS
        .filter((e) => !e.internal && (includePast || e.is_active))
        .sort((a, b) => b.starts_at - a.starts_at);
      return { rows };
    }
    // GET /season-events/{id} (single): select includes ", internal".
    if (sql.includes('display_activities, internal')) {
      const event = SEASON_EVENTS.find((e) => e.id === params[0]);
      return { rows: event ? [event] : [] };
    }
    // GET /season-events/{id}: enrollment count. (Matcher is deliberately
    // narrow — the participant-scoped profile lookup below ALSO mentions
    // user_enrollments in its EXISTS subquery and must not match here.)
    if (sql.includes('COUNT(*)::int AS c FROM user_enrollments')) {
      const count = USER_ENROLLMENTS.filter((r) => r.season_event_id === params[0]).length;
      return { rows: [{ c: count }] };
    }

    // GET /season-events/{id}/challenges: challenges+templates list.
    if (sql.includes('FROM challenges c') && sql.includes('c.enabled = TRUE')) {
      const eventId = params[0];
      const rows = CHALLENGES
        .filter((c) => c.season_event_id === eventId && c.enabled)
        .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
        .map((c) => {
          const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
          return joinChallengeTemplate(c, t);
        });
      return { rows };
    }
    // Challenge breakdown: single challenge + template lookup.
    if (sql.includes('c.id = $1 AND c.season_event_id = $2')) {
      const [challengeId, eventId] = params;
      const c = CHALLENGES.find((cc) => cc.id === challengeId && cc.season_event_id === eventId);
      if (!c) return { rows: [] };
      const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
      return {
        rows: [{
          id: c.id, season_event_id: c.season_event_id, c_goal: c.goal, c_kind: c.kind,
          t_category: t.category, t_goal: t.goal, t_kind: t.kind, t_metric_type: t.metric_type,
        }],
      };
    }
    // Challenge breakdown: totals.
    if (sql.includes('COUNT(DISTINCT user_id)::int AS participants')) {
      const challengeId = params[0];
      const matches = USER_ACTIVITIES.filter((a) => a.challenge_id === challengeId);
      const participants = new Set(matches.map((a) => a.user_id)).size;
      const totalPoints = matches.reduce((sum, a) => sum + Number(a.points), 0);
      return { rows: [{ participants, total_points: totalPoints.toFixed(2) }] };
    }
    // Challenge breakdown: entries (LATERAL join to latest snapshot).
    if (sql.includes('LEFT JOIN LATERAL')) {
      const [challengeId, eventId, limitPlusOne, offset] = params;
      const byUser = new Map();
      for (const a of USER_ACTIVITIES) {
        if (a.challenge_id !== challengeId) continue;
        const acc = byUser.get(a.user_id) || 0;
        byUser.set(a.user_id, acc + Number(a.points));
      }
      const rows = [...byUser.entries()]
        .map(([userId, points]) => {
          const user = USERS.find((u) => u.id === userId);
          const snap = latestPerUserForEvent(eventId).find((s) => s.user_id === userId);
          return {
            user_id: userId, points: points.toFixed(2), discord: user.discord, display_name: user.display_name,
            email: user.email, telegram: user.telegram, exclude_podium: user.exclude_podium,
            event_success_rate: snap ? snap.event_success_rate : null,
          };
        })
        .sort((a, b) => Number(b.points) - Number(a.points))
        .slice(offset, offset + limitPlusOne);
      return { rows };
    }

    // GET /users/{id}/profile: base user lookup (participant-scoped).
    if (sql.includes('u.email, u.telegram, u.discord, u.display_name FROM users u')) {
      const user = USERS.find((u) => u.id === params[0] && isParticipant(u.id));
      return { rows: user ? [user] : [] };
    }
    // GET /users/{id}/profile (event mode): single latest snapshot.
    if (sql.includes('FROM leaderboard_snapshots') && sql.includes('user_id = $2')) {
      const [eventId, userId] = params;
      const snap = latestPerUserForEvent(eventId).find((s) => s.user_id === userId) || null;
      return { rows: snap ? [snap] : [] };
    }
    // GET /users/{id}/profile (event mode): onchain account pick.
    if (sql.startsWith('SELECT public_key FROM onchain_accounts') && sql.includes('season_event_id = $2')) {
      const [userId, eventId, seasonId] = params;
      const acct = ONCHAIN_ACCOUNTS.find((a) => a.user_id === userId
        && (a.season_event_id === eventId || (a.season_event_id == null && a.season_id === seasonId)));
      return { rows: acct ? [{ public_key: acct.public_key }] : [] };
    }
    // GET /users/{id}/profile (all-time mode): onchain account pick.
    if (sql.startsWith('SELECT public_key FROM onchain_accounts')) {
      const userId = params[0];
      const accts = ONCHAIN_ACCOUNTS.filter((a) => a.user_id === userId).sort((a, b) => b.id - a.id);
      return { rows: accts.length ? [{ public_key: accts[0].public_key }] : [] };
    }
    // GET /users/{id}/profile (all-time mode): extra per-user aggregation.
    if (sql.includes('DISTINCT ON (season_event_id)')) {
      const userId = params[0];
      const rows = SEASON_EVENTS
        .filter((e) => !e.internal)
        .flatMap((e) => latestPerUserForEvent(e.id).filter((s) => s.user_id === userId));
      return { rows };
    }
    // GET /users/{id}/profile (event mode): activities.
    if (sql.includes('challenge_id') && sql.includes('season_event_id = $2') && sql.includes('user_activities')) {
      const [userId, eventId] = params;
      const rows = USER_ACTIVITIES
        .filter((a) => a.user_id === userId && a.season_event_id === eventId)
        .sort((a, b) => b.activity_at - a.activity_at);
      return { rows };
    }
    // GET /users/{id}/profile (all-time mode): activities.
    if (sql.includes('challenge_id') && sql.includes('user_activities')) {
      const userId = params[0];
      const rows = USER_ACTIVITIES.filter((a) => a.user_id === userId).sort((a, b) => b.activity_at - a.activity_at);
      return { rows };
    }

    // POST /app-version/check.
    if (sql.includes('FROM app_version_configs')) {
      const os = params[0];
      const cfg = APP_VERSION_CONFIGS.find((c) => c.os === os && c.is_active);
      return { rows: cfg ? [cfg] : [] };
    }

    throw new Error(`unexpected SQL in mock: ${sql.slice(0, 120)}`);
  }

  return { query };
}

function joinChallengeTemplate(c, t) {
  return {
    // Mirrors the route's SELECT list, `c.completed` included (#981) — a row
    // that omits the column in the fixture arrives as `undefined` here, which
    // is exactly the case buildChallengeListItem's `=== true` coerces.
    id: c.id, season_event_id: c.season_event_id, challenge_template_id: c.challenge_template_id, enabled: c.enabled,
    completed: c.completed,
    goal: c.goal, task: c.task, reward: c.reward, description: c.description, requirements: c.requirements,
    schedule_start: c.schedule_start, schedule_end: c.schedule_end, reward_logic: c.reward_logic,
    cta_button: c.cta_button, cta_label: c.cta_label, cta_link: c.cta_link,
    metric_type: c.metric_type, metric_target: c.metric_target, metric_label: c.metric_label,
    t_id: t.id, t_category: t.category, t_goal: t.goal, t_task: t.task, t_reward: t.reward,
    t_description: t.description, t_requirements: t.requirements, t_schedule_start: t.schedule_start,
    t_schedule_end: t.schedule_end, t_reward_logic: t.reward_logic, t_cta_button: t.cta_button,
    t_cta_label: t.cta_label, t_cta_link: t.cta_link, t_created_at: t.created_at, t_updated_at: t.updated_at,
    t_kind: t.kind, t_cta_type: t.cta_type, t_mobile_cta_type: t.mobile_cta_type,
    t_mobile_cta_label: t.mobile_cta_label, t_mobile_cta_link: t.mobile_cta_link,
    t_metric_type: t.metric_type, t_metric_target: t.metric_target, t_metric_label: t.metric_label,
    t_illustration: t.illustration, t_illustration_tone: t.illustration_tone,
  };
}

// ─── Test app wiring (require.cache pool swap, mirrors topochain-foundation.test.js) ─

function withMockPool(fn) {
  return withInjectedPool(makeMockPool(), fn);
}

// Same require.cache swap, but with a caller-supplied pool — used by the
// optionalSessionAuth-scoping test, which needs a query-COUNTING pool
// rather than the shared fixture-backed mock.
function withInjectedPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const publicModulePath = require.resolve('../src/routes/topochain/public');
  const authModulePath = require.resolve('../src/middleware/topochain-auth');
  const standingsModulePath = require.resolve('../src/services/topochain/standings');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  delete require.cache[publicModulePath];
  delete require.cache[authModulePath];
  delete require.cache[standingsModulePath];
  try {
    return fn(require('../src/routes/topochain/public'));
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[publicModulePath];
    delete require.cache[authModulePath];
    delete require.cache[standingsModulePath];
  }
}

let server;
let base;

test.before(async () => {
  // NOTE: withMockPool's callback is synchronous (it only sets up the
  // express app and calls `.listen(0)`), so it is called WITHOUT `await`
  // here deliberately — awaiting a synchronous callback's (non-promise)
  // return value reproducibly made the http server's 'listening' event
  // never fire under this repo's `node --test` runner during development
  // of this suite. Same pattern as tests/board-order.test.js's `test.before`.
  withMockPool(({ topochainPublicRoutes }) => {
    const app = express();
    app.use(express.json());
    // Anon by default; `x-test-admin: 1` injects an admin req.user (mirrors
    // board-order.test.js's pre-router req.user injection). optionalSessionAuth
    // only ever ADDS req.user from a session cookie — never present here —
    // so it never overwrites this test-injected value.
    app.use((req, _res, next) => {
      if (req.headers['x-test-admin'] === '1') req.user = { id: 999, username: 'admin', isAdmin: true };
      next();
    });
    app.use(topochainPublicRoutes({ databaseUrl: 'postgres://fake/fake' }));
    server = app.listen(0);
  });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

async function get(path, opts) { return fetch(`${base}${path}`, opts); }
async function postJson(path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// ─── optionalSessionAuth prefix scoping (integration-review fix) ────────

test('optionalSessionAuth is scoped to /api/v4/: a non-API request with a session cookie runs ZERO queries through the public router', async () => {
  // This router is mounted UNSCOPED at the app root (server.js:443),
  // before authMiddleware — an unscoped `router.use(optionalSessionAuth)`
  // therefore ran a duplicate `sessions JOIN users` query for EVERY
  // authenticated request platform-wide (v1 APIs, static assets, SPA
  // loads), which authMiddleware then repeated. The counting pool proves
  // the session lookup now happens only on the /api/v4 surface.
  let queries = 0;
  const countingPool = { query: async () => { queries += 1; return { rows: [] }; } };
  let srv;
  withInjectedPool(countingPool, ({ topochainPublicRoutes }) => {
    const app = express();
    app.use(cookieParser());
    app.use(topochainPublicRoutes({ databaseUrl: 'postgres://fake/fake' }));
    // Stand-ins for the platform routes mounted after this router.
    app.get('/dashboard', (_req, res) => res.status(200).send('DASHBOARD'));
    srv = app.listen(0);
  });
  await new Promise((r) => srv.once('listening', r));
  const localBase = `http://127.0.0.1:${srv.address().port}`;
  try {
    const dash = await fetch(`${localBase}/dashboard`, { headers: { cookie: 'session=some-token' } });
    assert.equal(dash.status, 200);
    assert.equal(await dash.text(), 'DASHBOARD');
    assert.equal(queries, 0, 'a non-/api/v4 path must never trigger the session lookup');

    // Sanity companion: the SAME cookie on an /api/v4 path DOES run
    // exactly the one session lookup (__ping itself issues no queries),
    // proving the guard scopes the middleware rather than disabling it.
    const ping = await fetch(`${localBase}/api/v4/public/__ping`, { headers: { cookie: 'session=some-token' } });
    assert.equal(ping.status, 200);
    assert.equal(queries, 1, 'the /api/v4 surface still gets optional session resolution');
  } finally { srv.close(); }
});

// ─── __ping (kept from Task 3) ──────────────────────────────────────────

test('__ping still responds 200 unauthenticated', async () => {
  const res = await get('/api/v4/public/__ping');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
});

// ─── GET /leaderboard ────────────────────────────────────────────────

test('GET /leaderboard: happy path envelope keys + masking + shared identity fallbacks', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), ['event', 'leaderboard']);
  assert.deepEqual(body.data.event, {
    id: 100, name: 'Sprint One', disclaimer: 'Please read the rules.', display_leaderboard: true,
    starts_at: body.data.event.starts_at, ends_at: body.data.event.ends_at,
    has_started: true, has_ended: false, status: 'active',
    // Additive (#999): tells the standings pane whether these rows are one
    // event's stored snapshots or the whole season's aggregate, which is
    // what lets it drop the per-event-only columns.
    type: 'regular',
  });
  assert.match(body.data.event.starts_at, /\+00:00$/);
  // SPEC 912: default per_page is 50 for this endpoint (not the shared
  // 25 default other v4 endpoints use).
  assert.deepEqual(body.meta, { page: 1, per_page: 50, total: 4, total_pages: 1 });

  const rows = body.data.leaderboard;
  assert.equal(rows.length, 4);
  // rank 1: dave — masked identifier (no discord/display_name), real numbers.
  const dave = rows.find((r) => r.wallet_address === 'pk-dave-100');
  assert.equal(dave.rank, 1);
  assert.equal(dave.identifier, 'dav***@***.com');
  assert.equal(dave.display_name, 'dav***@***.com');
  assert.equal(dave.total_points, 500);
  assert.equal(dave.extra_points, 10);
  assert.equal(dave.bech32m, 'addr-dave-100');
  assert.equal(dave.event_success_rate, 66.67);

  // rank 2: bob — discord fallback for display_name, discord field raw.
  const bob = rows.find((r) => r.wallet_address === 'pk-bob-100');
  assert.equal(bob.display_name, 'bobdiscord');
  assert.equal(bob.discord, 'bobdiscord');
  assert.equal(bob.identifier, 'bob***@***.com');
  // epoch_success_rate stored NULL -> v4 real zero, not null.
  assert.equal(bob.epoch_success_rate, 0);

  // rank 3 (shared): alice (podium-excluded) and carol.
  const alice = rows.find((r) => r.identifier === 'ali***@***.com');
  assert.equal(alice.is_non_podium, true);
  assert.equal(alice.rank, 3);
  const carol = rows.find((r) => r.display_name === 'Carol Display');
  assert.equal(carol.rank, 3);
  assert.equal(carol.is_non_podium, false);
  // carol has no email (telegram identifier instead) — masked generic form.
  assert.equal(carol.identifier, 'car***');
});

test('GET /leaderboard: no season_event_id falls back to the active public event', async () => {
  const res = await get('/api/v4/leaderboard');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.event.id, 100); // the only active, non-internal, is_active=true regular event with the latest starts_at among candidates
});

test('GET /leaderboard: unknown season_event_id -> 404 Event not found.', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=9999');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
});

test('GET /leaderboard: internal season_event_id -> 404 Event not found. (never reveals internal events)', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=102');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
});

test('GET /leaderboard: display_leaderboard=false -> leaderboard [] and meta.total 0, envelope otherwise identical', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=101');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.leaderboard, []);
  assert.equal(body.meta.total, 0);
  assert.equal(body.data.event.id, 101);
});

test('GET /leaderboard: per_page=0 -> 422, not the source per_page=0 500', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=100&per_page=0');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok('details' in body);
});

test('GET /leaderboard: per_page=101 -> 422', async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=100&per_page=101');
  assert.equal(res.status, 422);
});

test("GET /leaderboard: a 'season'-type event computes its rank live via the shared standings query", async () => {
  const res = await get('/api/v4/leaderboard?season_event_id=103');
  assert.equal(res.status, 200);
  const body = await res.json();
  const rows = body.data.leaderboard;
  assert.ok(rows.length > 0);
  // Same total_points as event 100 (the only event contributing to season
  // 10's standings in this fixture set), but per-event-only fields are 0.
  const dave = rows.find((r) => r.total_points === 500);
  assert.ok(dave);
  assert.equal(dave.rank, 1);
  assert.equal(dave.wallet_address, null);
  assert.equal(dave.bug_report_points, 0);
});

// ─── GET /leaderboard/global ─────────────────────────────────────────

test('GET /leaderboard/global: anon caller never sees the discord key', async () => {
  const res = await get('/api/v4/leaderboard/global');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.leaderboard.length > 0);
  for (const row of body.data.leaderboard) assert.ok(!('discord' in row));
  // dave leads all-time too (only event 100 contributes in this fixture).
  assert.equal(body.data.leaderboard[0].total_points, 500);
  assert.equal(body.data.leaderboard[0].events_participated, 1);
  assert.equal(body.data.leaderboard[0].total_produced_blocks_last_event, 40);
});

test('GET /leaderboard/global: admin caller sees the discord key (present, possibly null)', async () => {
  const res = await get('/api/v4/leaderboard/global', { headers: { 'x-test-admin': '1' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const row of body.data.leaderboard) assert.ok('discord' in row);
  const bobRow = body.data.leaderboard.find((r) => r.display_name === 'bobdiscord');
  assert.equal(bobRow.discord, 'bobdiscord');
});

test('GET /leaderboard/global: anon display_name never falls back to the raw discord handle (SPEC 988 admin-only redaction)', async () => {
  // bob's only human-readable name is his discord handle. SPEC 988 makes
  // `discord` ADMIN ONLY on this endpoint, so the display-name fallback
  // chain must skip discord for non-admins (masked identifier instead) —
  // otherwise display_name re-leaks the very field the discord key
  // redaction hides. The admin test above pins the opposite: admins still
  // get the full SPEC 1246 chain (display_name === 'bobdiscord').
  const res = await get('/api/v4/leaderboard/global');
  assert.equal(res.status, 200);
  const body = await res.json();
  const bob = body.data.leaderboard.find((r) => r.identifier === 'bob***@***.com');
  assert.ok(bob, 'bob must appear in the global standings');
  assert.notEqual(bob.display_name, 'bobdiscord');
  assert.equal(bob.display_name, 'bob***@***.com');
});

test('GET /leaderboard/global: shared-rank rule — podium-excluded user shares the next rank, no slot consumed', async () => {
  const res = await get('/api/v4/leaderboard/global');
  const body = await res.json();
  const alice = body.data.leaderboard.find((r) => r.identifier === 'ali***@***.com');
  const carol = body.data.leaderboard.find((r) => r.display_name === 'Carol Display');
  assert.equal(alice.is_non_podium, true);
  assert.equal(alice.rank, carol.rank);
});

// ─── GET /leaderboard/epoch-breakdown ────────────────────────────────

test('GET /leaderboard/epoch-breakdown: public_key input form still resolves data (review fix — canonical address, not the raw param, feeds epoch_stats)', async () => {
  // wallet_address is the PUBLIC_KEY form here; epoch_stats is keyed by the
  // canonical `address` form only. Before the fix this returned 200 with
  // an empty breakdown (the raw public_key param never matches
  // epoch_stats.wallet_address); the handler must resolve the matched
  // onchain_accounts row's `address` first and query epoch_stats with that.
  const res = await get('/api/v4/leaderboard/epoch-breakdown?wallet_address=pk-dave-100&season_event_id=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.event.id, 100);
  assert.equal(body.data.breakdown.length, 3);
  assert.deepEqual(body.data.breakdown.map((r) => r.epoch), [1, 2, 3]);
  const epoch3 = body.data.breakdown.find((r) => r.epoch === 3);
  assert.equal(epoch3.total_won_slots, 0);
  assert.equal(epoch3.success_rate, 0); // won=0 -> real zero, not null
  const epoch2 = body.data.breakdown.find((r) => r.epoch === 2);
  assert.equal(epoch2.success_rate, Math.round((2 / 3) * 10000) / 100);
});

test('GET /leaderboard/epoch-breakdown: address (canonical) input form returns the identical breakdown', async () => {
  const res = await get('/api/v4/leaderboard/epoch-breakdown?wallet_address=addr-dave-100&season_event_id=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.breakdown.length, 3);
});

test('GET /leaderboard/epoch-breakdown: missing wallet_address -> 400', async () => {
  const res = await get('/api/v4/leaderboard/epoch-breakdown?season_event_id=100');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { success: false, error: 'wallet_address is required.' });
});

test('GET /leaderboard/epoch-breakdown: missing season_event_id -> 400', async () => {
  const res = await get('/api/v4/leaderboard/epoch-breakdown?wallet_address=pk-dave-100');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { success: false, error: 'season_event_id is required.' });
});

test('GET /leaderboard/epoch-breakdown: internal event -> 404 Event not found.', async () => {
  const res = await get('/api/v4/leaderboard/epoch-breakdown?wallet_address=pk-dave-100&season_event_id=102');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
});

test('GET /leaderboard/epoch-breakdown: unknown wallet -> 404 No onchain account found for this wallet in this event.', async () => {
  const res = await get('/api/v4/leaderboard/epoch-breakdown?wallet_address=nope&season_event_id=100');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'No onchain account found for this wallet in this event.' });
});

// ─── GET /leaderboard/user-activities ────────────────────────────────

test('GET /leaderboard/user-activities: happy path, decimal points preserved (not truncated), ordered activity_at DESC', async () => {
  const res = await get('/api/v4/leaderboard/user-activities?season_event_id=100&participant_identifier=erin@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].points, 75.5);
  assert.equal(body.data[0].description, 'Erin filed a bug');
});

test('GET /leaderboard/user-activities: identifier resolves via onchain account address too', async () => {
  const res = await get('/api/v4/leaderboard/user-activities?season_event_id=100&participant_identifier=addr-bob-100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.length >= 2);
});

test('GET /leaderboard/user-activities: valid identifier with no activities in that event -> 200 empty array', async () => {
  const res = await get('/api/v4/leaderboard/user-activities?season_event_id=100&participant_identifier=frank@example.com');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, []);
});

test('GET /leaderboard/user-activities: unknown identifier -> 404 Participant not found (literal body, not the standard envelope)', async () => {
  const res = await get('/api/v4/leaderboard/user-activities?season_event_id=100&participant_identifier=nobody@example.com');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Participant not found', data: [] });
});

test('GET /leaderboard/user-activities: a platform account with no enrollment or snapshot gets the SAME 404 as an unknown identifier (enumeration-oracle guard)', async () => {
  // grace (user 7) is a real row in the shared platform users table, but
  // has never participated in topochain. All three of her identifiers
  // must be indistinguishable from identifiers that match nothing.
  for (const identifier of ['platform-only@example.com', 'graceTG', 'gracediscord']) {
    const res = await get(`/api/v4/leaderboard/user-activities?season_event_id=100&participant_identifier=${identifier}`);
    assert.equal(res.status, 404, `identifier=${identifier}`);
    assert.deepEqual(await res.json(), { success: false, error: 'Participant not found', data: [] });
  }
});

test('GET /leaderboard/user-activities: missing params -> 422', async () => {
  const res = await get('/api/v4/leaderboard/user-activities');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.season_event_id);
  assert.ok(body.details.participant_identifier);
});

// ─── GET /season-events ─────────────────────────────────────────────

test('GET /season-events: default hides internal AND inactive events', async () => {
  const res = await get('/api/v4/season-events');
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.data.map((e) => e.id).sort();
  assert.deepEqual(ids, [100, 101, 103]);
  assert.ok(!('disclaimer' in body.data[0])); // deliberately not exposed (SPEC 1140)
});

test('GET /season-events: include_past=true still hides internal, shows inactive', async () => {
  const res = await get('/api/v4/season-events?include_past=true');
  const body = await res.json();
  const ids = body.data.map((e) => e.id).sort();
  assert.deepEqual(ids, [100, 101, 103, 104]);
});

// ─── GET /season-events/{id} ─────────────────────────────────────────

test('GET /season-events/:id: includes users_count (renamed from participants_count)', async () => {
  const res = await get('/api/v4/season-events/100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.users_count, 3);
});

test('GET /season-events/:id: internal event -> 404 Event not found.', async () => {
  const res = await get('/api/v4/season-events/102');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
});

test('GET /season-events/:id: unknown id -> 404', async () => {
  const res = await get('/api/v4/season-events/9999');
  assert.equal(res.status, 404);
});

// ─── GET /season-events/{id}/challenges ──────────────────────────────

test('GET /season-events/:id/challenges: only enabled challenges, override/effective merge, uppercased card_preview.label', async () => {
  const res = await get('/api/v4/season-events/100/challenges');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 2); // challenge 12 (disabled) excluded

  const plain = body.data.find((c) => c.id === 10);
  assert.equal(plain.overrides.goal, null); // no override
  assert.equal(plain.effective.goal, 'Report a bug'); // falls back to template
  assert.equal(plain.card_preview.label, 'BUG');
  assert.equal(plain.activity_type.id, 1);

  const overridden = body.data.find((c) => c.id === 11);
  assert.equal(overridden.overrides.goal, 'Produce your first block (overridden)');
  assert.equal(overridden.effective.goal, 'Produce your first block (overridden)');
  assert.equal(overridden.detail_modal.cta_type, 'link'); // always from the template, never overridden
});

test('GET /season-events/:id/challenges: card_preview carries the TEMPLATE\'s illustration slug, or null', async () => {
  const res = await get('/api/v4/season-events/100/challenges');
  assert.equal(res.status, 200);
  const body = await res.json();

  const drawn = body.data.find((c) => c.id === 11);
  assert.equal(drawn.card_preview.illustration, 'block-production');
  assert.equal(drawn.activity_type.illustration, 'block-production');
  // Template-level only: nothing a challenge row sets can override it.
  assert.equal('illustration' in drawn.overrides, false);
  assert.equal('illustration' in drawn.effective, false);

  const plain = body.data.find((c) => c.id === 10);
  assert.equal(plain.card_preview.illustration, null, 'a template without artwork');

  // A challenge whose template row is gone: every t_* column arrives NULL (or
  // absent) from the LEFT JOIN, and the card simply has no artwork.
  const { buildChallengeListItem } = require('../src/routes/topochain/challenge-view');
  const orphan = buildChallengeListItem({ id: 1, season_event_id: 100, challenge_template_id: 9, enabled: true, t_id: null });
  assert.equal(orphan.card_preview.illustration, null);
});

// An UPLOADED illustration's tone travels beside its slug, from the scalar
// subquery TEMPLATE_JOIN_COLUMNS_SQL adds. A built-in slug gets null: its tone
// lives in the client registry, which ignores the payload's for it anyway.
test('GET /season-events/:id/challenges: card_preview carries an uploaded illustration\'s tone, null otherwise', async () => {
  const res = await get('/api/v4/season-events/100/challenges');
  assert.equal(res.status, 200);
  const body = await res.json();
  const drawn = body.data.find((c) => c.id === 11);
  assert.equal(drawn.card_preview.illustration_tone, null, 'a built-in slug');
  assert.equal(drawn.activity_type.illustration_tone, null);
  assert.equal(body.data.find((c) => c.id === 10).card_preview.illustration_tone, null, 'no artwork at all');

  const { buildChallengeListItem, TEMPLATE_JOIN_COLUMNS_SQL } = require('../src/routes/topochain/challenge-view');
  const slug = `u-${'c'.repeat(32)}`;
  const uploaded = buildChallengeListItem({
    id: 1, season_event_id: 100, challenge_template_id: 9, enabled: true,
    t_id: 9, t_illustration: slug, t_illustration_tone: 'teal',
  });
  assert.equal(uploaded.card_preview.illustration, slug);
  assert.equal(uploaded.card_preview.illustration_tone, 'teal');
  assert.equal(uploaded.activity_type.illustration_tone, 'teal');
  assert.equal('illustration_tone' in uploaded.overrides, false, 'template-level, like the slug');

  const orphan = buildChallengeListItem({ id: 1, season_event_id: 100, challenge_template_id: 9, enabled: true, t_id: null });
  assert.equal(orphan.card_preview.illustration_tone, null);

  assert.match(TEMPLATE_JOIN_COLUMNS_SQL.replace(/\s+/g, ' '),
    /\(SELECT ci\.tone FROM challenge_illustrations ci WHERE ci\.slug = ct\.illustration\) AS t_illustration_tone/);
});

test('GET /season-events/:id/challenges: each item carries its EFFECTIVE metric beside the template', async () => {
  // The challenge card counts toward this target ("0/3 bugs filed") for every
  // viewer, signed out included, so it must be the organiser's override when
  // there is one — the same merge Home's panel and /challenges-api apply.
  const res = await get('/api/v4/season-events/100/challenges');
  assert.equal(res.status, 200);
  const body = await res.json();

  const overridden = body.data.find((c) => c.id === 10);
  assert.deepEqual(overridden.metric, { kind: 'count', target: 3, label: 'bugs filed' },
    'the challenge row\'s metric, with the target as a number');
  assert.equal(overridden.activity_type.metric_type, null, '`activity_type` stays the template, by contract');

  const fromTemplate = body.data.find((c) => c.id === 11);
  assert.deepEqual(fromTemplate.metric, { kind: 'blocks_produced', target: 1, label: 'blocks' },
    'no override: the template\'s metric');
});

test('GET /season-events/:id/challenges: publishes the organiser `completed` flag, coerced to a real boolean', async () => {
  // #981: the web challenge grid groups/counts finished challenges from THIS
  // field. Before it was published, the grid's "Completed" chip came only
  // from the session-authed /challenges-api personalization pass, so an
  // anonymous visitor saw no completion state and a signed-in one saw it
  // land a paint late.
  const res = await get('/api/v4/season-events/100/challenges');
  assert.equal(res.status, 200);
  const body = await res.json();

  const done = body.data.find((c) => c.id === 11);
  assert.equal(done.completed, true);

  // A row that doesn't carry the column at all must report `false`, NOT
  // `undefined` — an absent key in the payload would leave the client's
  // grouping ambiguous, which is what the mapper's `=== true` is for.
  const open = body.data.find((c) => c.id === 10);
  assert.equal(open.completed, false);
  assert.ok('completed' in open, 'the key is always present, never omitted');
});

test('GET /season-events/:id/challenges: internal event -> 404', async () => {
  const res = await get('/api/v4/season-events/102/challenges');
  assert.equal(res.status, 404);
});

// ─── GET /season-events/{id}/challenges/{id}/breakdown ───────────────

test('GET challenge breakdown: block-production challenge gets a non-null rate, sorted by points desc', async () => {
  const res = await get('/api/v4/season-events/100/challenges/11/breakdown');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.challenge.is_produce_blocks, true);
  assert.equal(body.data.totals.participants, 2);
  assert.equal(body.data.totals.total_points, 250);
  assert.equal(body.data.entries[0].points, 150); // dave first
  assert.equal(body.data.entries[0].rate, 66.67);
  assert.equal(body.data.next_offset, 50);
  assert.equal(body.data.has_more, false);
});

test('GET challenge breakdown: non-block-production challenge always reports rate: null', async () => {
  const res = await get('/api/v4/season-events/100/challenges/10/breakdown');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.challenge.is_produce_blocks, false);
  for (const entry of body.data.entries) assert.equal(entry.rate, null);
});

test('GET challenge breakdown: challenge not belonging to the event -> 404', async () => {
  const res = await get('/api/v4/season-events/999/challenges/10/breakdown');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Challenge not found.' });
});

// ─── GET /users/{id}/profile ──────────────────────────────────────────

test('GET /users/:id/profile (event scope): figures come from that event\'s latest snapshot', async () => {
  const res = await get('/api/v4/users/4/profile?season_event_id=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.identifier_type, 'email');
  assert.equal(body.data.total_points, 500);
  assert.equal(body.data.rank, 1);
  assert.equal(body.data.wallet_address, 'pk-dave-100');
  assert.ok(Array.isArray(body.data.activities));
  // dave's snapshot has non-zero vrf/canonical won-slot denominators.
  assert.equal(body.data.client_success_rate, Math.round((40 / 12) * 10000) / 100);
  assert.equal(body.data.canonical_success_rate, Math.round((9 / 10) * 10000) / 100);
});

test('GET /users/:id/profile (event scope): client_success_rate/canonical_success_rate are null (not 0) when the denominator is zero (SPEC 1286)', async () => {
  // alice (user 1) has vrf_total_won_slots=0 and canonical_total_won_slots=0
  // in her event-100 snapshot.
  const res = await get('/api/v4/users/1/profile?season_event_id=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.client_success_rate, null);
  assert.equal(body.data.canonical_success_rate, null);
  // event_success_rate-derived `success_rate` keeps the real-zero rule.
  assert.equal(body.data.success_rate, 0);
});

test('GET /users/:id/profile (all-time scope): aggregated via the shared standings query', async () => {
  const res = await get('/api/v4/users/4/profile');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.total_points, 500);
  assert.equal(body.data.rank, 1);
});

test('GET /users/:id/profile: unknown user -> 404 User not found.', async () => {
  const res = await get('/api/v4/users/9999/profile');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'User not found.' });
});

test('GET /users/:id/profile: a platform account with no enrollment or snapshot gets the SAME 404 as an unknown id (enumeration-oracle guard)', async () => {
  // grace (user 7) exists in the shared users table but never
  // participated — byte-identical body to the unknown-id case above.
  const res = await get('/api/v4/users/7/profile');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'User not found.' });
});

test('GET /users/:id/profile: an enrollment-only participant (no snapshots yet) still resolves', async () => {
  // frank (user 6) is enrolled in event 101 but has no snapshots or
  // activities — the scoping fix must not lock out participants who
  // simply haven\'t scored yet.
  const res = await get('/api/v4/users/6/profile');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.identifier_type, 'email');
  assert.equal(body.data.rank, null);
  assert.equal(body.data.total_points, 0);
});

test('GET /users/:id/profile: internal season_event_id -> 404 Event not found.', async () => {
  const res = await get('/api/v4/users/4/profile?season_event_id=102');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Event not found.' });
});

// ─── POST /app-version/check ─────────────────────────────────────────

test('POST /app-version/check: build below minimum -> upgrade 2, fallback details (config message null)', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'ios', app_version: '1.0.0', build_number: 50 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.data).sort(), ['details', 'update_url', 'upgrade']);
  assert.equal(body.data.upgrade, 2);
  assert.ok(body.data.details.length > 0);
  assert.equal(body.data.update_url, 'https://example.com/ios');
});

test('POST /app-version/check: build below recommended -> upgrade 1, configured details', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'ios', app_version: '1.0.0', build_number: 105 });
  const body = await res.json();
  assert.equal(body.data.upgrade, 1);
  assert.equal(body.data.details, 'Update recommended.');
});

test('POST /app-version/check: build at/above recommended -> upgrade 0, details+update_url null but keys present', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'ios', app_version: '1.0.0', build_number: 200 });
  const body = await res.json();
  assert.equal(body.data.upgrade, 0);
  assert.equal(body.data.details, null);
  assert.equal(body.data.update_url, null);
});

test('POST /app-version/check: no config row for the OS -> all three keys still present', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'android', app_version: '1.0.0', build_number: 1 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, { upgrade: 0, details: null, update_url: null });
});

test('POST /app-version/check: case-sensitive os -> 422', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'iOS', app_version: '1.0.0', build_number: 1 });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.os);
});

test('POST /app-version/check: missing build_number -> 422', async () => {
  const res = await postJson('/api/v4/app-version/check', { os: 'ios', app_version: '1.0.0' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.build_number);
});
