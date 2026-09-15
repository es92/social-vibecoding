// Topochain v4 admin API — D4 challenge-templates, D5 onchain-accounts,
// D6 challenges (nested under season-events), D7 app-version-configs, D9
// settings (plan Task 12; SPEC 2534-2589 D4, 2591-2642 D5, 2644-2745 D6,
// 2747-2787 D7, 2793-2850 D9, 883-895 §4.8 fix list).
//
// Same "fake Postgres" idiom as tests/topochain-admin-api.test.js (Task
// 11): tables as plain arrays, one regex/startsWith-dispatching
// `handleQuery`, BEGIN/COMMIT/ROLLBACK as a deep-clone snapshot/restore.
// Not re-derived here per file: this harness targets the auth gates (a
// spot check — the bulk of auth coverage lives in Task 11's own file),
// the v4 bug fixes the brief calls out by name, and one smoke pass
// (index/show/create/update/delete) per D-group.
//
// Run with: node --test tests/topochain-admin-api2.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Same require.cache indirection pitfall as Task 11's file — install the
// wrapper BEFORE requiring any admin module below.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { challengeTemplatesAdminRoutes } = require('../src/routes/topochain/admin/challenge-templates');
const { onchainAccountsAdminRoutes } = require('../src/routes/topochain/admin/onchain-accounts');
const { challengesAdminRoutes } = require('../src/routes/topochain/admin/challenges');
const { appVersionConfigsAdminRoutes } = require('../src/routes/topochain/admin/app-version-configs');
const { settingsAdminRoutes } = require('../src/routes/topochain/admin/settings');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

// ─── Fake Postgres ───────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

let db;
let snapshot;

function freshDb() {
  return {
    challengeKinds: [
      { id: 'REPORT_BUG_CHALLENGE', name: 'Report a bug' },
      { id: 'SEND_TX_CHALLENGE', name: 'Send a transaction' },
    ],
    challengeTemplates: [],
    challengeIllustrations: [],
    seasons: [],
    seasonEvents: [],
    challenges: [],
    userActivities: [],
    onchainAccounts: [],
    accountDelegationPeriods: [],
    users: [{ id: 1, username: 'alice', email: 'alice@example.com', display_name: 'Alice', discord: 'alice#1234' }],
    appVersionConfigs: [],
    // Task 2's schema.sql seed, verbatim, PLUS one non-topochain platform
    // key (`user_daily_limit_cents`) that must NEVER surface through this
    // D9 router — every settings test that lists/reads asserts it stays
    // invisible.
    platformSettings: [
      { key: 'topochain_first_block_points', value: '250', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_produced_half_blocks_points', value: '0', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_top_1_points', value: '1500', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_top_2_points', value: '1000', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_top_3_points', value: '500', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_success_50_percent_points', value: '1000', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'topochain_inviting_new_participant_points', value: '0', description: 'seed', updated_at: T(-10), updated_by: null },
      { key: 'user_daily_limit_cents', value: '2500', description: null, updated_at: T(-10), updated_by: null },
    ],
    nextId: {
      challengeTemplates: 500, seasonEvents: 1000, challenges: 2000, onchainAccounts: 4000, appVersionConfigs: 5000,
      userActivities: 6000,
    },
  };
}

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function like(str, pattern) {
  if (!pattern) return true;
  const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
  return String(str || '').toLowerCase().includes(needle);
}

// Regex-scans ONLY the SET...WHERE slice of an UPDATE statement (not the
// WHERE clause itself) for `col = $N` pairs — narrower than Task 11's
// whole-string version so a rename of the WHERE-clause's own identifying
// column (D9's `key`) can't be clobbered by a spurious match against
// "WHERE key = $1" after the real "SET key = $2" already applied.
function applyDynamicSet(row, sql, params) {
  const setStart = sql.indexOf(' SET ') + 5;
  const whereStart = sql.lastIndexOf(' WHERE ');
  const setPart = sql.slice(setStart, whereStart);
  const re = /(\w+)\s*=\s*\$(\d+)/g;
  let m;
  while ((m = re.exec(setPart))) {
    row[m[1]] = params[Number(m[2]) - 1];
  }
  if (/updated_at\s*=\s*NOW\(\)/.test(setPart)) row.updated_at = new Date();
}

function challengeJoinedRow(c) {
  const t = db.challengeTemplates.find((x) => x.id === c.challenge_template_id);
  const out = { ...c };
  if (t) {
    out.t_id = t.id; out.t_category = t.category; out.t_goal = t.goal; out.t_task = t.task;
    out.t_reward = t.reward; out.t_description = t.description; out.t_requirements = t.requirements;
    out.t_schedule_start = t.schedule_start; out.t_schedule_end = t.schedule_end; out.t_reward_logic = t.reward_logic;
    out.t_cta_button = t.cta_button; out.t_cta_label = t.cta_label; out.t_cta_link = t.cta_link;
    out.t_created_at = t.created_at; out.t_updated_at = t.updated_at; out.t_kind = t.kind;
    out.t_cta_type = t.cta_type; out.t_mobile_cta_type = t.mobile_cta_type; out.t_mobile_cta_label = t.mobile_cta_label;
    out.t_mobile_cta_link = t.mobile_cta_link; out.t_metric_type = t.metric_type; out.t_metric_target = t.metric_target;
    out.t_metric_label = t.metric_label; out.t_illustration = t.illustration;
  } else {
    out.t_id = null;
  }
  return out;
}

function accountJoinedRow(a) {
  const ev = a.season_event_id != null ? db.seasonEvents.find((e) => e.id === a.season_event_id) : null;
  const u = a.user_id != null ? db.users.find((x) => x.id === a.user_id) : null;
  return {
    id: a.id, season_event_id: a.season_event_id, season_id: a.season_id, amount: a.amount,
    identity_uid: a.identity_uid, address: a.address, public_key: a.public_key, tier: a.tier,
    description: a.description, registration_code: a.registration_code, user_id: a.user_id,
    is_used: a.is_used, used_at: a.used_at, created_at: a.created_at, updated_at: a.updated_at,
    secret_key: a.secret_key, // present on the RAW row (as it is in the real DB) — the regression
    // test is that formatAccount() never surfaces this, not that the mock hides it.
    event_id: ev ? ev.id : null, event_name: ev ? ev.name : null,
    user_id_full: u ? u.id : null, user_username: u ? u.username : null, user_email: u ? u.email : null,
    user_display_name: u ? u.display_name : null, user_discord: u ? (u.discord ?? null) : null,
    // The route's delegation subqueries: an OPEN period on this address.
    delegated: openDelegation(a.address) != null,
    delegated_since: openDelegation(a.address)?.started_at ?? null,
  };
}

function openDelegation(address) {
  return db.accountDelegationPeriods.find((p) => p.account === address && p.ended_at == null) || null;
}

// Param-less delegated filter off D5's index/count queries: EXISTS /
// NOT EXISTS over open periods. ('AND NOT EXISTS' is checked first —
// 'AND EXISTS' is a substring of neither.)
function delegatedFilterMatch(sql, a) {
  if (sql.includes('AND NOT EXISTS (SELECT 1 FROM account_delegation_periods')) return openDelegation(a.address) == null;
  if (sql.includes('AND EXISTS (SELECT 1 FROM account_delegation_periods')) return openDelegation(a.address) != null;
  return true;
}

// Extracts the optional-filter params off D5's index/count queries. Both
// queries build their WHERE clause (and therefore their param list) in
// the SAME order (season_event_id, season_id, is_used, search) — this
// mirrors that order via substring detection rather than re-parsing full
// SQL. ('oa.season_id = $' cannot false-match 'oa.season_event_id = $':
// neither string is a substring of the other.)
function accountFilters(sql) {
  let i = 0;
  const out = {};
  if (sql.includes('oa.season_event_id = $')) out.seasonEventIdIdx = i++;
  if (sql.includes('oa.season_id = $')) out.seasonIdIdx = i++;
  if (sql.includes('oa.is_used = $')) out.isUsedIdx = i++;
  if (sql.includes('oa.public_key ILIKE $')) out.likeIdx = i++;
  return out;
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(db)); return { rows: [] }; }
  if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
  if (sql === 'ROLLBACK') { if (snapshot) db = JSON.parse(JSON.stringify(snapshot)); snapshot = null; return { rows: [] }; }

  // D4's two GETs select an uploaded illustration's tone beside `*`. Answer
  // the query without that subselect, then add the tone the way the scalar
  // subquery would: the matching challenge_illustrations row's, else null.
  const toneSelect = ', (SELECT ci.tone FROM challenge_illustrations ci WHERE ci.slug = challenge_templates.illustration) AS illustration_tone';
  if (sql.includes(toneSelect)) {
    const { rows } = handleQuery(sql.replace(toneSelect, ''), params);
    return {
      rows: rows.map((r) => ({
        ...r,
        illustration_tone: db.challengeIllustrations.find((ci) => ci.slug === r.illustration)?.tone ?? null,
      })),
    };
  }

  // ── shared: challenge_kinds / season_events / challenge_templates by id ─
  if (sql === 'SELECT id FROM challenge_kinds WHERE id = $1') {
    const row = db.challengeKinds.find((k) => k.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id, season_id FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ id: row.id, season_id: row.season_id }] : [] };
  }
  if (sql === 'SELECT id FROM seasons WHERE id = $1') {
    const row = db.seasons.find((s) => s.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id FROM challenge_templates WHERE id = $1') {
    const row = db.challengeTemplates.find((t) => t.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }

  // ── D4 challenge_templates ────────────────────────────────────────────
  if (sql === 'SELECT DISTINCT category FROM challenge_templates ORDER BY category ASC') {
    const cats = [...new Set(db.challengeTemplates.map((t) => t.category))].sort();
    return { rows: cats.map((category) => ({ category })) };
  }
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM challenge_templates WHERE')) {
    const [likeParam, category] = params;
    const rows = db.challengeTemplates.filter((t) => (
      (!likeParam || like(t.goal, likeParam) || like(t.task, likeParam) || like(t.category, likeParam) || like(t.kind, likeParam))
      && (!category || t.category === category)
    ));
    return { rows: [{ c: rows.length }] };
  }
  if (sql.startsWith('SELECT * FROM challenge_templates WHERE ($1::text')) {
    const [likeParam, category, limit, offset] = params;
    const rows = db.challengeTemplates
      .filter((t) => (
        (!likeParam || like(t.goal, likeParam) || like(t.task, likeParam) || like(t.category, likeParam) || like(t.kind, likeParam))
        && (!category || t.category === category)
      ))
      .sort((a, b) => a.category.localeCompare(b.category) || a.goal.localeCompare(b.goal))
      .slice(offset, offset + limit);
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (sql.startsWith('INSERT INTO challenge_templates')) {
    const [category, goal, task, reward, description, requirements, scheduleStart, scheduleEnd, rewardLogic,
      ctaButton, ctaLabel, ctaLink, kind, ctaType, mobileCtaType, mobileCtaLabel, mobileCtaLink,
      metricType, metricTarget, metricLabel, illustration] = params;
    const row = {
      id: db.nextId.challengeTemplates++, category, goal, task, reward, description, requirements,
      schedule_start: scheduleStart, schedule_end: scheduleEnd, reward_logic: rewardLogic,
      cta_button: ctaButton, cta_label: ctaLabel, cta_link: ctaLink,
      created_at: new Date(), updated_at: new Date(), kind, cta_type: ctaType,
      mobile_cta_type: mobileCtaType, mobile_cta_label: mobileCtaLabel, mobile_cta_link: mobileCtaLink,
      metric_type: metricType, metric_target: metricTarget, metric_label: metricLabel, illustration,
    };
    db.challengeTemplates.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql === 'SELECT * FROM challenge_templates WHERE id = $1') {
    const row = db.challengeTemplates.find((t) => t.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('UPDATE challenge_templates SET')) {
    const row = db.challengeTemplates.find((t) => t.id === params[0]);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'SELECT COUNT(*)::int AS c FROM challenges WHERE challenge_template_id = $1') {
    const c = db.challenges.filter((ch) => ch.challenge_template_id === params[0]).length;
    return { rows: [{ c }] };
  }
  if (sql === 'DELETE FROM challenge_templates WHERE id = $1') {
    const idx = db.challengeTemplates.findIndex((t) => t.id === params[0]);
    if (idx !== -1) db.challengeTemplates.splice(idx, 1);
    return { rows: [] };
  }

  // ── D5 onchain_accounts ───────────────────────────────────────────────
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM onchain_accounts oa')) {
    const f = accountFilters(sql);
    const rows = db.onchainAccounts.filter((a) => (
      (f.seasonEventIdIdx === undefined || a.season_event_id === params[f.seasonEventIdIdx])
      && (f.seasonIdIdx === undefined || a.season_id === params[f.seasonIdIdx])
      && (f.isUsedIdx === undefined || a.is_used === params[f.isUsedIdx])
      && (f.likeIdx === undefined
        || like(a.public_key, params[f.likeIdx]) || like(a.identity_uid, params[f.likeIdx])
        || like(a.registration_code, params[f.likeIdx]) || like(a.tier, params[f.likeIdx]))
      && delegatedFilterMatch(sql, a)
    ));
    return { rows: [{ c: rows.length }] };
  }
  if (sql.includes('FROM onchain_accounts oa') && sql.includes('ORDER BY oa.amount DESC')) {
    const f = accountFilters(sql);
    const perPage = params[params.length - 2];
    const offset = params[params.length - 1];
    const rows = db.onchainAccounts
      .filter((a) => (
        (f.seasonEventIdIdx === undefined || a.season_event_id === params[f.seasonEventIdIdx])
        && (f.seasonIdIdx === undefined || a.season_id === params[f.seasonIdIdx])
        && (f.isUsedIdx === undefined || a.is_used === params[f.isUsedIdx])
        && (f.likeIdx === undefined
          || like(a.public_key, params[f.likeIdx]) || like(a.identity_uid, params[f.likeIdx])
          || like(a.registration_code, params[f.likeIdx]) || like(a.tier, params[f.likeIdx]))
        && delegatedFilterMatch(sql, a)
      ))
      .sort((a, b) => b.amount - a.amount || a.id - b.id)
      .slice(offset, offset + perPage);
    return { rows: rows.map(accountJoinedRow) };
  }
  if (sql === 'SELECT public_key FROM onchain_accounts WHERE season_id = $1 AND season_event_id IS NULL') {
    const rows = db.onchainAccounts.filter((a) => a.season_id === params[0] && a.season_event_id == null);
    return { rows: rows.map((a) => ({ public_key: a.public_key })) };
  }
  if (sql === 'SELECT 1 FROM onchain_accounts WHERE registration_code = $1') {
    const clash = db.onchainAccounts.some((a) => a.registration_code === params[0]);
    return { rows: clash ? [{ '?column?': 1 }] : [] };
  }
  if (sql.startsWith('INSERT INTO onchain_accounts')) {
    // Season-scoped insert: season_event_id is a literal NULL in the SQL,
    // so the params carry only the 8 row values plus season_id as $9.
    const [amount, identityUid, address, publicKey, secretKey, tier, description, registrationCode,
      seasonId] = params;
    db.onchainAccounts.push({
      id: db.nextId.onchainAccounts++, amount, identity_uid: identityUid, address, public_key: publicKey,
      secret_key: secretKey, tier, description, registration_code: registrationCode,
      season_event_id: null, season_id: seasonId, user_id: null, is_used: false,
      used_at: null, created_at: new Date(), updated_at: new Date(),
    });
    return { rows: [] };
  }
  if (sql.includes('FROM onchain_accounts oa') && sql.includes('WHERE oa.id = $1')) {
    const row = db.onchainAccounts.find((a) => a.id === params[0]);
    return { rows: row ? [accountJoinedRow(row)] : [] };
  }
  if (sql === 'SELECT id FROM onchain_accounts WHERE id = $1') {
    const row = db.onchainAccounts.find((a) => a.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('UPDATE onchain_accounts SET user_id = NULL')) {
    const row = db.onchainAccounts.find((a) => a.id === params[0]);
    if (row) { row.user_id = null; row.is_used = false; row.used_at = null; row.updated_at = new Date(); }
    return { rows: [] };
  }

  // ── D6 challenges ─────────────────────────────────────────────────────
  if (sql.startsWith('SELECT c.*') && sql.includes('WHERE c.id = $1')) {
    const row = db.challenges.find((c) => c.id === params[0]);
    return { rows: row ? [challengeJoinedRow(row)] : [] };
  }
  if (sql.startsWith('SELECT c.*') && sql.includes('WHERE c.season_event_id = $1 ORDER BY c.display_order')) {
    const rows = db.challenges
      .filter((c) => c.season_event_id === params[0])
      .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
      .map(challengeJoinedRow);
    return { rows };
  }
  if (sql.startsWith('SELECT * FROM challenge_templates WHERE id NOT IN')) {
    const seasonEventId = params[0];
    const attached = new Set(db.challenges.filter((c) => c.season_event_id === seasonEventId).map((c) => c.challenge_template_id));
    const rows = db.challengeTemplates
      .filter((t) => !attached.has(t.id))
      .sort((a, b) => a.category.localeCompare(b.category) || a.goal.localeCompare(b.goal));
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (sql.startsWith('INSERT INTO challenges')) {
    const [seasonEventId, templateId, goal, task, reward, description, requirements, scheduleStart, scheduleEnd,
      rewardLogic, ctaButton, ctaLabel, ctaLink, enabled, displayOrder, completed, kind, ctaType, mobileCtaType,
      mobileCtaLabel, mobileCtaLink, metricType, metricTarget, metricLabel, featured, featuredOrder] = params;
    const row = {
      id: db.nextId.challenges++, season_event_id: seasonEventId, challenge_template_id: templateId,
      goal, task, reward, description, requirements, schedule_start: scheduleStart, schedule_end: scheduleEnd,
      reward_logic: rewardLogic, cta_button: ctaButton, cta_label: ctaLabel, cta_link: ctaLink,
      created_at: new Date(), updated_at: new Date(), enabled, display_order: displayOrder, completed,
      kind, cta_type: ctaType, mobile_cta_type: mobileCtaType, mobile_cta_label: mobileCtaLabel,
      mobile_cta_link: mobileCtaLink, metric_type: metricType, metric_target: metricTarget,
      metric_label: metricLabel, featured, featured_order: featuredOrder,
    };
    db.challenges.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql === 'SELECT id FROM challenges WHERE id = ANY($1) AND season_event_id = $2') {
    const [ids, seasonEventId] = params;
    const rows = db.challenges.filter((c) => ids.includes(c.id) && c.season_event_id === seasonEventId);
    return { rows: rows.map((c) => ({ id: c.id })) };
  }
  if (sql.startsWith('UPDATE challenges SET display_order = $1')) {
    const [order, id, seasonEventId] = params;
    const row = db.challenges.find((c) => c.id === id && c.season_event_id === seasonEventId);
    if (row) { row.display_order = order; row.updated_at = new Date(); }
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE challenges SET enabled = $1')) {
    const [enabled, id] = params;
    const row = db.challenges.find((c) => c.id === id);
    if (row) { row.enabled = enabled; row.updated_at = new Date(); }
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE challenges SET completed = $1')) {
    const [completed, id] = params;
    const row = db.challenges.find((c) => c.id === id);
    if (row) { row.completed = completed; row.updated_at = new Date(); }
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE challenges SET season_event_id = $1')) {
    const [targetId, id] = params;
    const row = db.challenges.find((c) => c.id === id);
    if (row) { row.season_event_id = targetId; row.updated_at = new Date(); }
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE challenges SET')) {
    const row = db.challenges.find((c) => c.id === params[0]);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: [] };
  }
  if (sql === 'DELETE FROM challenges WHERE id = $1') {
    const idx = db.challenges.findIndex((c) => c.id === params[0]);
    if (idx !== -1) db.challenges.splice(idx, 1);
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE user_activities SET season_event_id = $1')) {
    const [targetId, challengeId] = params;
    const affected = db.userActivities.filter((a) => a.challenge_id === challengeId);
    for (const a of affected) { a.season_event_id = targetId; a.updated_at = new Date(); }
    return { rows: affected.map((a) => ({ id: a.id })) };
  }

  // ── D7 app_version_configs ────────────────────────────────────────────
  if (sql === 'SELECT * FROM app_version_configs ORDER BY os ASC') {
    const rows = db.appVersionConfigs.slice().sort((a, b) => a.os.localeCompare(b.os));
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (sql === 'SELECT id FROM app_version_configs WHERE os = $1') {
    const row = db.appVersionConfigs.find((c) => c.os === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('INSERT INTO app_version_configs')) {
    const [os, minBuild, recBuild, currentVersion, mustMsg, shouldMsg, updateUrl, isActive] = params;
    const row = {
      id: db.nextId.appVersionConfigs++, os, min_build_number: minBuild, recommended_build_number: recBuild,
      current_version: currentVersion, must_update_message: mustMsg, should_update_message: shouldMsg,
      update_url: updateUrl, is_active: isActive, created_at: new Date(), updated_at: new Date(),
    };
    db.appVersionConfigs.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql === 'SELECT * FROM app_version_configs WHERE id = $1') {
    const row = db.appVersionConfigs.find((c) => c.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('UPDATE app_version_configs SET')) {
    const row = db.appVersionConfigs.find((c) => c.id === params[0]);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'DELETE FROM app_version_configs WHERE id = $1 RETURNING id') {
    const idx = db.appVersionConfigs.findIndex((c) => c.id === params[0]);
    if (idx === -1) return { rows: [] };
    const [removed] = db.appVersionConfigs.splice(idx, 1);
    return { rows: [{ id: removed.id }] };
  }

  // ── D9 platform_settings ──────────────────────────────────────────────
  if (sql.startsWith('SELECT * FROM platform_settings WHERE key LIKE $1')) {
    const rows = db.platformSettings.filter((s) => s.key.startsWith('topochain_')).sort((a, b) => a.key.localeCompare(b.key));
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (sql.startsWith('INSERT INTO platform_settings') && sql.includes('ON CONFLICT (key) DO UPDATE')) {
    const [key, value, description, updatedBy] = params;
    const existing = db.platformSettings.find((s) => s.key === key);
    if (existing) {
      existing.value = value; existing.description = description; existing.updated_at = new Date(); existing.updated_by = updatedBy;
    } else {
      db.platformSettings.push({ key, value, description, updated_at: new Date(), updated_by: updatedBy });
    }
    return { rows: [] };
  }
  if (sql === 'SELECT * FROM platform_settings WHERE key = ANY($1) ORDER BY key ASC') {
    const keys = params[0];
    const rows = db.platformSettings.filter((s) => keys.includes(s.key)).sort((a, b) => a.key.localeCompare(b.key));
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (sql.startsWith('SELECT key FROM platform_settings WHERE key = ANY($1) AND key LIKE $2')) {
    const keys = params[0];
    const rows = db.platformSettings.filter((s) => keys.includes(s.key) && s.key.startsWith('topochain_'));
    return { rows: rows.map((s) => ({ key: s.key })) };
  }
  if (sql === 'UPDATE platform_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3') {
    const [value, updatedBy, key] = params;
    const row = db.platformSettings.find((s) => s.key === key);
    if (row) { row.value = String(value); row.updated_at = new Date(); row.updated_by = updatedBy; }
    return { rows: [] };
  }
  if (sql === 'SELECT key FROM platform_settings WHERE key = $1') {
    const row = db.platformSettings.find((s) => s.key === params[0]);
    return { rows: row ? [{ key: row.key }] : [] };
  }
  if (sql.startsWith('INSERT INTO platform_settings') && sql.includes('RETURNING *')) {
    const [key, value, description, updatedBy] = params;
    const row = { key, value, description, updated_at: new Date(), updated_by: updatedBy };
    db.platformSettings.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql === 'SELECT * FROM platform_settings WHERE key = $1') {
    const row = db.platformSettings.find((s) => s.key === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('UPDATE platform_settings SET')) {
    const row = db.platformSettings.find((s) => s.key === params[0]);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'DELETE FROM platform_settings WHERE key = $1 RETURNING key') {
    const idx = db.platformSettings.findIndex((s) => s.key === params[0]);
    if (idx === -1) return { rows: [] };
    const [removed] = db.platformSettings.splice(idx, 1);
    return { rows: [{ key: removed.key }] };
  }

  throw new Error(`Unhandled SQL in mock: ${sql}`);
}

function makeMockPool() {
  return {
    async query(sql, params) { return handleQuery(sql, params); },
    async connect() {
      return { async query(sql, params) { return handleQuery(sql, params); }, release() {} };
    },
  };
}

// ─── App builders ───────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildFullApp(role) {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

function buildSubApp(factory, role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(factory({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  db = freshDb();
  snapshot = null;
  currentMockPool = makeMockPool();
});

// ─── 1. Auth gates (spot check — full coverage lives in Task 11's file) ──

test('admin auth: non-admin gets the SPEC 403 body on a Task 12 route', async () => {
  const { server, base } = await listen(buildFullApp('user'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-templates`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { server.close(); }
});

test('admin auth: view-only admin can read D9 settings but gets 403 on POST /reset (write gate)', async () => {
  const { server, base } = await listen(buildFullApp('readonly'));
  try {
    const readRes = await fetch(`${base}/api/v4/admin/settings`);
    assert.equal(readRes.status, 200);
    const writeRes = await fetch(`${base}/api/v4/admin/settings/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(writeRes.status, 403);
    assert.deepEqual(await writeRes.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

// ─── 2. D4 challenge-templates ──────────────────────────────────────────

test('D4: GET /categories is reachable despite /:id being registered too (route-shadowing fix)', async () => {
  db.challengeTemplates.push(
    { id: 1, category: 'development', goal: 'g', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
    { id: 2, category: 'community', goal: 'g2', task: 't2', reward: 'r2', created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-templates/categories`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // If /:id shadowed this route, `category` would never be interpreted
    // as a string id and the handler would instead 404 with "not found",
    // or worse, misparse "categories" as an id. A clean 200 + real array
    // proves this route, not /:id, handled the request.
    assert.deepEqual(body, { success: true, data: ['community', 'development'] });
  } finally { server.close(); }
});

test('D4: index — search + category filter + category ASC, goal ASC ordering + pagination meta', async () => {
  db.challengeTemplates.push(
    { id: 1, category: 'dev', goal: 'Ship a PR', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
    { id: 2, category: 'dev', goal: 'Report bug', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
    { id: 3, category: 'social', goal: 'Invite a friend', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-templates?category=dev`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.map((r) => r.goal), ['Report bug', 'Ship a PR']); // goal ASC within category
    assert.equal(body.meta.total, 2);

    const searchRes = await fetch(`${base}/api/v4/admin/challenge-templates?search=invite`);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.data.length, 1);
    assert.equal(searchBody.data[0].category, 'social');
  } finally { server.close(); }
});

test('D4: create accepts v4-only cta_type/mobile_cta_*/metric_* fields, and rejects an unknown kind', async () => {
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    const badKind = await fetch(`${base}/api/v4/admin/challenge-templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'dev', goal: 'g', task: 't', reward: 'r', kind: 'NOT_A_KIND' }),
    });
    assert.equal(badKind.status, 422);
    assert.ok((await badKind.json()).details.kind);

    const res = await fetch(`${base}/api/v4/admin/challenge-templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'dev', goal: 'g', task: 't', reward: 'r', kind: 'REPORT_BUG_CHALLENGE',
        cta_type: 'app', mobile_cta_type: 'url', mobile_cta_label: 'Open', mobile_cta_link: 'https://x',
        metric_type: 'count', metric_target: 5, metric_label: 'bugs',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.cta_type, 'app');
    assert.equal(body.data.mobile_cta_type, 'url');
    assert.equal(body.data.metric_target, 5);
  } finally { server.close(); }
});

// The server checks the slug's SHAPE only. Membership in the artwork set is
// the client registry's call (it draws a known slug and falls back otherwise),
// so a well-shaped slug no build draws yet is stored, not refused.
// An uploaded illustration (slug `u-<id>`) has its tone in challenge_illustrations,
// and both D4 GETs select it beside the row, so the admin screen reads the same
// value the public card payload carries. A built-in slug, or none, reads null.
test('D4: GET list and GET :id carry an uploaded illustration\'s tone, null for a built-in or none', async () => {
  const uploaded = `u-${'e'.repeat(32)}`;
  db.challengeIllustrations.push({ id: 'e'.repeat(32), slug: uploaded, label: 'Kite', tone: 'teal', archived: true });
  db.challengeTemplates.push(
    { id: 1, category: 'a', goal: 'g1', task: 't', reward: 'r', illustration: uploaded, created_at: T(0), updated_at: T(0) },
    { id: 2, category: 'b', goal: 'g2', task: 't', reward: 'r', illustration: 'block-production', created_at: T(0), updated_at: T(0) },
    { id: 3, category: 'c', goal: 'g3', task: 't', reward: 'r', illustration: null, created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    const list = await (await fetch(`${base}/api/v4/admin/challenge-templates`)).json();
    assert.deepEqual(list.data.map((t) => [t.illustration, t.illustration_tone]),
      [[uploaded, 'teal'], ['block-production', null], [null, null]], 'archived art still reports its tone');
    const one = await (await fetch(`${base}/api/v4/admin/challenge-templates/1`)).json();
    assert.equal(one.data.illustration_tone, 'teal');
    assert.equal((await (await fetch(`${base}/api/v4/admin/challenge-templates/3`)).json()).data.illustration_tone, null);
  } finally { server.close(); }
});

test('D4: illustration — create/update echo the slug, a malformed one 422s, omitted keeps it, null clears it', async () => {
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  const send = (method, url, body) => fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const fields = { category: 'dev', goal: 'g', task: 't', reward: 'r' };
  try {
    const plain = await send('POST', '/api/v4/admin/challenge-templates', fields);
    assert.equal(plain.status, 201);
    assert.equal((await plain.json()).data.illustration, null, 'no artwork unless one is picked');

    const badCreate = await send('POST', '/api/v4/admin/challenge-templates', { ...fields, illustration: 'Bad Slug' });
    assert.equal(badCreate.status, 422);
    assert.ok((await badCreate.json()).details.illustration);

    const created = await send('POST', '/api/v4/admin/challenge-templates', { ...fields, illustration: 'block-production' });
    assert.equal(created.status, 201);
    const { data } = await created.json();
    assert.equal(data.illustration, 'block-production');
    const url = `/api/v4/admin/challenge-templates/${data.id}`;

    // Anything that could become a path or a URL is refused, whatever it names.
    for (const illustration of ['Bad Slug', '../icons/icon-192', '-leading-hyphen', 'a'.repeat(65), 'x.svg', 42]) {
      const bad = await send('PATCH', url, { illustration });
      assert.equal(bad.status, 422, `${JSON.stringify(illustration)} is refused`);
      assert.match((await bad.json()).details.illustration[0], /slug/);
    }
    assert.equal((await (await fetch(`${base}${url}`)).json()).data.illustration, 'block-production',
      'a refused write leaves the stored slug alone');

    const untouched = await send('PATCH', url, { goal: 'g2' });
    assert.equal((await untouched.json()).data.illustration, 'block-production', 'omitted means unchanged');

    const renamed = await send('PATCH', url, { illustration: 'drawn-in-a-later-build' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).data.illustration, 'drawn-in-a-later-build');

    const cleared = await send('PATCH', url, { illustration: null });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).data.illustration, null);
  } finally { server.close(); }
});

test('D4: update — schedule_end alone validates after:schedule_start against the PERSISTED value', async () => {
  db.challengeTemplates.push({
    id: 10, category: 'dev', goal: 'g', task: 't', reward: 'r',
    schedule_start: T(5), schedule_end: null, created_at: T(0), updated_at: T(0),
  });
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    // schedule_end BEFORE the persisted schedule_start (T(5)) -> 422, even
    // though schedule_start isn't in THIS request's body at all.
    const bad = await fetch(`${base}/api/v4/admin/challenge-templates/10`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_end: T(1).toISOString() }),
    });
    assert.equal(bad.status, 422);
    assert.ok((await bad.json()).details.schedule_end);

    const good = await fetch(`${base}/api/v4/admin/challenge-templates/10`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_end: T(9).toISOString() }),
    });
    assert.equal(good.status, 200);
  } finally { server.close(); }
});

test('D4: delete REFUSES with 409 while a challenge references the template; succeeds once unreferenced', async () => {
  db.challengeTemplates.push(
    { id: 20, category: 'dev', goal: 'g', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
    { id: 21, category: 'dev', goal: 'g2', task: 't', reward: 'r', created_at: T(0), updated_at: T(0) },
  );
  db.seasonEvents.push({ id: 100, season_id: null, name: 'Event A' });
  db.challenges.push({
    id: 200, season_event_id: 100, challenge_template_id: 20, enabled: true, completed: false,
    display_order: 0, featured: false, created_at: T(0), updated_at: T(0),
  });
  const { server, base } = await listen(buildSubApp(challengeTemplatesAdminRoutes));
  try {
    const refused = await fetch(`${base}/api/v4/admin/challenge-templates/20`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.success, false);
    assert.match(refusedBody.error, /still reference it/);

    const ok = await fetch(`${base}/api/v4/admin/challenge-templates/21`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.equal(db.challengeTemplates.some((t) => t.id === 21), false);
  } finally { server.close(); }
});

// ─── 3. D5 onchain-accounts ─────────────────────────────────────────────

test('D5: index orders by amount DESC, applies filters, and NEVER exposes secret_key', async () => {
  db.seasonEvents.push({ id: 300, season_id: 1, name: 'Event B' });
  db.onchainAccounts.push(
    { id: 400, season_event_id: 300, season_id: 1, amount: 50, identity_uid: 'u1', address: 'ut1a', public_key: 'pk1',
      secret_key: 'SUPER-SECRET-1', tier: 'gold', description: null, registration_code: 'code1', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
    { id: 401, season_event_id: 300, season_id: 1, amount: 200, identity_uid: 'u2', address: 'ut1b', public_key: 'pk2',
      secret_key: 'SUPER-SECRET-2', tier: 'silver', description: null, registration_code: 'code2', user_id: 1,
      is_used: true, used_at: T(0), created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts?season_event_id=300`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.map((r) => r.id), [401, 400]); // amount DESC
    for (const row of body.data) assert.equal('secret_key' in row, false);
    assert.deepEqual(body.data[0].user, {
      id: 1, username: 'alice', email: 'alice@example.com', display_name: 'Alice', discord: 'alice#1234',
    });
    assert.equal(body.data[1].user, null);

    const usedOnly = await fetch(`${base}/api/v4/admin/onchain-accounts?is_used=true`);
    const usedBody = await usedOnly.json();
    assert.deepEqual(usedBody.data.map((r) => r.id), [401]);

    const searchRes = await fetch(`${base}/api/v4/admin/onchain-accounts?search=gold`);
    const searchBody = await searchRes.json();
    assert.deepEqual(searchBody.data.map((r) => r.id), [400]);
  } finally { server.close(); }
});

test('D5: rows carry the live delegation flag, ?delegated filters on it, and an unparseable value 422s', async () => {
  db.seasonEvents.push({ id: 300, season_id: 1, name: 'Event B' });
  db.onchainAccounts.push(
    { id: 400, season_event_id: 300, season_id: 1, amount: 50, identity_uid: 'u1', address: 'ut1delegated', public_key: 'pk1',
      secret_key: 's1', tier: 'gold', description: null, registration_code: 'code1', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
    { id: 401, season_event_id: 300, season_id: 1, amount: 20, identity_uid: 'u2', address: 'ut1plain', public_key: 'pk2',
      secret_key: 's2', tier: 'silver', description: null, registration_code: 'code2', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
  );
  db.accountDelegationPeriods.push(
    // A closed period must NOT count as delegated — only an open one does.
    { id: 1, account: 'ut1plain', started_at: T(-30), ended_at: T(-20) },
    { id: 2, account: 'ut1delegated', started_at: T(-5), ended_at: null },
  );
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const body = await (await fetch(`${base}/api/v4/admin/onchain-accounts`)).json();
    const delegated = body.data.find((a) => a.id === 400);
    assert.equal(delegated.delegated, true);
    assert.match(delegated.delegated_since, /\+00:00$/);
    const plain = body.data.find((a) => a.id === 401);
    assert.equal(plain.delegated, false);
    assert.equal(plain.delegated_since, null);

    const onlyDelegated = await (await fetch(`${base}/api/v4/admin/onchain-accounts?delegated=true`)).json();
    assert.deepEqual(onlyDelegated.data.map((a) => a.id), [400]);
    assert.equal(onlyDelegated.meta.total, 1);
    const notDelegated = await (await fetch(`${base}/api/v4/admin/onchain-accounts?delegated=false`)).json();
    assert.deepEqual(notDelegated.data.map((a) => a.id), [401]);

    // Same discipline as is_used: present-but-unparseable rejects, never
    // silently ignores the filter.
    const bad = await fetch(`${base}/api/v4/admin/onchain-accounts?delegated=on`);
    assert.equal(bad.status, 422);
    assert.ok((await bad.json()).details.delegated);

    // The show route carries the same two fields (the detail dialog's
    // Delegation row reads them).
    const show = await (await fetch(`${base}/api/v4/admin/onchain-accounts/400`)).json();
    assert.equal(show.data.delegated, true);
    assert.match(show.data.delegated_since, /\+00:00$/);
  } finally { server.close(); }
});

test('D5: index — a present-but-malformed season_event_id 404s (not a silent empty page), and an unparseable is_used 422s (not "filter ignored")', async () => {
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const badEvent = await fetch(`${base}/api/v4/admin/onchain-accounts?season_event_id=not-a-number`);
    assert.equal(badEvent.status, 404);

    const badIsUsed = await fetch(`${base}/api/v4/admin/onchain-accounts?is_used=on`);
    assert.equal(badIsUsed.status, 422);
  } finally { server.close(); }
});

test('D5: index — season_id filter mirrors season_event_id (filters rows, combines with the event filter, malformed 404s)', async () => {
  db.seasonEvents.push({ id: 310, season_id: 1, name: 'Event S1' }, { id: 311, season_id: 2, name: 'Event S2' });
  db.onchainAccounts.push(
    { id: 410, season_event_id: 310, season_id: 1, amount: 10, identity_uid: 's1', address: 'ut1c', public_key: 'pk-s1',
      secret_key: 'sk', tier: 't', description: null, registration_code: 'c10', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
    // A season-wide grant (season_event_id NULL) — the season filter must
    // still find it, which the event filter alone never could.
    { id: 411, season_event_id: null, season_id: 1, amount: 20, identity_uid: 's1w', address: 'ut1d', public_key: 'pk-s1w',
      secret_key: 'sk', tier: 't', description: null, registration_code: 'c11', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
    { id: 412, season_event_id: 311, season_id: 2, amount: 30, identity_uid: 's2', address: 'ut1e', public_key: 'pk-s2',
      secret_key: 'sk', tier: 't', description: null, registration_code: 'c12', user_id: null,
      is_used: false, used_at: null, created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const bySeason = await fetch(`${base}/api/v4/admin/onchain-accounts?season_id=1`);
    assert.equal(bySeason.status, 200);
    assert.deepEqual((await bySeason.json()).data.map((r) => r.id), [411, 410]); // amount DESC

    const combined = await fetch(`${base}/api/v4/admin/onchain-accounts?season_id=1&season_event_id=310`);
    assert.deepEqual((await combined.json()).data.map((r) => r.id), [410]);

    const badSeason = await fetch(`${base}/api/v4/admin/onchain-accounts?season_id=not-a-number`);
    assert.equal(badSeason.status, 404);
  } finally { server.close(); }
});

test('D5: show — secret_key is served to a FULL admin only; a view-only admin gets the account without it', async () => {
  db.seasonEvents.push({ id: 320, season_id: 1, name: 'Event G' });
  db.onchainAccounts.push({
    id: 420, season_event_id: 320, season_id: 1, amount: 7, identity_uid: 'u', address: 'ut1f', public_key: 'pk-show',
    secret_key: 'SHOW-ME-ONLY-TO-FULL-ADMINS', tier: 't', description: null, registration_code: 'c20', user_id: 1,
    is_used: true, used_at: T(0), created_at: T(0), updated_at: T(0),
  });
  const full = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${full.base}/api/v4/admin/onchain-accounts/420`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.secret_key, 'SHOW-ME-ONLY-TO-FULL-ADMINS');
    // The show route's user projection carries discord for the dialog.
    assert.equal(body.data.user.discord, 'alice#1234');
  } finally { full.server.close(); }

  const ro = await listen(buildSubApp(onchainAccountsAdminRoutes, 'readonly'));
  try {
    const res = await fetch(`${ro.base}/api/v4/admin/onchain-accounts/420`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // The decision is made on canAdminWrite, not on row shape — the mock's
    // raw row DOES carry secret_key, so this proves the route never
    // forwards it for a view-only admin.
    assert.equal('secret_key' in body.data, false);
  } finally { ro.server.close(); }
});

test('D5: index cap tension — omitted per_page silently uses the SPEC default 200 (over the shared 100 cap); an explicit 200 still 422s', async () => {
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const implicitRes = await fetch(`${base}/api/v4/admin/onchain-accounts`);
    assert.equal(implicitRes.status, 200);
    assert.equal((await implicitRes.json()).meta.per_page, 200);

    const explicitRes = await fetch(`${base}/api/v4/admin/onchain-accounts?per_page=200`);
    assert.equal(explicitRes.status, 422);
  } finally { server.close(); }
});

test('D5: import — atomic (any row error rolls back ALL rows, none committed), dupes detected on (season_id, public_key)', async () => {
  db.seasons.push({ id: 9, name: 'Season Nine' });
  db.onchainAccounts.push({
    id: 600, season_event_id: null, season_id: 9, amount: 10, identity_uid: 'existing', address: 'ut1x',
    public_key: 'DUPLICATE-KEY', secret_key: 's', tier: 'bronze', description: null, registration_code: 'ex-code',
    user_id: null, is_used: false, used_at: null, created_at: T(0), updated_at: T(0),
  });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_id: 9,
        accounts: [
          { amount: 100, identity_uid: 'new1', address: 'ut1y', public_key: 'FRESH-KEY', secret_key: 's2', tier: 'gold' },
          { amount: 200, identity_uid: 'new2', address: 'ut1z', public_key: 'DUPLICATE-KEY', secret_key: 's3', tier: 'gold' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.imported_count, 0);
    assert.equal(body.data.skipped_count, 2);
    assert.equal(body.data.errors.length, 1);
    assert.match(body.data.errors[0], /Row 2.*already exists/);
    // THE ATOMICITY ASSERTION: row 1 was perfectly valid, but because row 2
    // failed, row 1 must NOT have been committed either.
    assert.equal(db.onchainAccounts.length, 1);
    assert.equal(db.onchainAccounts.some((a) => a.public_key === 'FRESH-KEY'), false);
  } finally { server.close(); }
});

test('D5: import — happy path creates SEASON-scoped rows (season_event_id NULL) with a server-side registration_code per row', async () => {
  db.seasons.push({ id: 42, name: 'Season Forty-Two' });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_id: 42,
        accounts: [{ amount: 1, identity_uid: 'i', address: 'a', public_key: 'PK-1', secret_key: 'sk', tier: 't' }],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.imported_count, 1);
    assert.equal(db.onchainAccounts.length, 1);
    const created = db.onchainAccounts[0];
    assert.equal(created.season_id, 42);
    assert.equal(created.season_event_id, null);
    assert.ok(created.registration_code && created.registration_code.length > 0);
  } finally { server.close(); }
});

test('D5: import — a legacy event-scoped row with the same key does NOT block a season import (carry-over re-imports keys), a season-scoped one does', async () => {
  db.seasons.push({ id: 7, name: 'Season Seven' });
  db.seasonEvents.push({ id: 510, season_id: 7, name: 'Legacy event' });
  // Legacy event-scoped row in the SAME season holding the key being imported.
  db.onchainAccounts.push({
    id: 610, season_event_id: 510, season_id: 7, amount: 10, identity_uid: 'legacy', address: 'ut1l',
    public_key: 'CARRIED-KEY', secret_key: 's', tier: 'bronze', description: null, registration_code: 'legacy-code',
    user_id: 1, is_used: true, used_at: T(0), created_at: T(0), updated_at: T(0),
  });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const first = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_id: 7,
        accounts: [{ amount: 5, identity_uid: 'i', address: 'ut1l', public_key: 'CARRIED-KEY', secret_key: 'sk', tier: 't' }],
      }),
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).data.imported_count, 1);

    // Re-importing the same key now collides with the season-scoped row.
    const second = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_id: 7,
        accounts: [{ amount: 5, identity_uid: 'i2', address: 'ut1l', public_key: 'CARRIED-KEY', secret_key: 'sk', tier: 't' }],
      }),
    });
    assert.equal(second.status, 201);
    const body = await second.json();
    assert.equal(body.data.imported_count, 0);
    assert.match(body.data.errors[0], /already exists for this season/);
  } finally { server.close(); }
});

test('D5: import — a stale caller still sending season_event_id gets a 422 naming the new field, never a silent event-scoped import', async () => {
  db.seasons.push({ id: 7, name: 'Season Seven' });
  db.seasonEvents.push({ id: 511, season_id: 7, name: 'Some event' });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_event_id: 511,
        accounts: [{ amount: 1, identity_uid: 'i', address: 'a', public_key: 'PK-9', secret_key: 'sk', tier: 't' }],
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.details.season_event_id[0], /season_id/);
    assert.equal(db.onchainAccounts.length, 0);
  } finally { server.close(); }
});

test('D5: import — a blank-string amount is a row error, not a silently-coerced 0 (code-review finding: bare Number() coercion)', async () => {
  db.seasons.push({ id: 1, name: 'Season One' });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_id: 1,
        accounts: [{ amount: '', identity_uid: 'i', address: 'a', public_key: 'PK-2', secret_key: 'sk', tier: 't' }],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.imported_count, 0);
    assert.match(body.data.errors[0], /amount is required/);
    assert.equal(db.onchainAccounts.length, 0);
  } finally { server.close(); }
});

test('D5: reset clears user_id/is_used/used_at, KEEPS registration_code, and returns the account object', async () => {
  db.seasonEvents.push({ id: 700, season_id: 1, name: 'Event E' });
  db.onchainAccounts.push({
    id: 800, season_event_id: 700, season_id: 1, amount: 5, identity_uid: 'u', address: 'a', public_key: 'pk',
    secret_key: 'sk', tier: 't', description: null, registration_code: 'KEEP-ME', user_id: 1, is_used: true,
    used_at: T(0), created_at: T(0), updated_at: T(0),
  });
  const { server, base } = await listen(buildSubApp(onchainAccountsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/onchain-accounts/800/reset`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'Registration code reset successfully.');
    assert.equal(body.data.registration_code, 'KEEP-ME');
    assert.equal(body.data.user_id, null);
    assert.equal(body.data.is_used, false);
    assert.equal(body.data.used_at, null);
  } finally { server.close(); }
});

// ─── 4. D6 challenges ───────────────────────────────────────────────────

function seedChallengeFixture() {
  db.seasonEvents.push({ id: 900, season_id: 1, name: 'Event Alpha' }, { id: 901, season_id: 1, name: 'Event Beta' });
  db.challengeTemplates.push({
    id: 950, category: 'dev', goal: 'Template goal', task: 'Template task', reward: 'Template reward',
    description: 'd', requirements: 'r', schedule_start: null, schedule_end: null, reward_logic: 'rl',
    cta_button: 'Go', cta_label: 'Go label', cta_link: 'https://x', created_at: T(0), updated_at: T(0),
    kind: 'REPORT_BUG_CHALLENGE', cta_type: 'url', mobile_cta_type: 'app', mobile_cta_label: 'Open app',
    mobile_cta_link: 'app://x', metric_type: 'count', metric_target: 3, metric_label: 'bugs',
  });
}

test('D6: ownership 404 uses event vocabulary ("Challenge does not belong to this event.")', async () => {
  seedChallengeFixture();
  db.challenges.push({
    id: 1000, season_event_id: 900, challenge_template_id: 950, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0), enabled: true,
    display_order: 0, completed: false, kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null,
    mobile_cta_link: null, metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    // challenge 1000 belongs to event 900, not 901.
    const res = await fetch(`${base}/api/v4/admin/season-events/901/challenges/1000`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Challenge does not belong to this event.' });
  } finally { server.close(); }
});

test('D6: index returns the public-shaped mapping (overrides/effective/card_preview/detail_modal/activity_type)', async () => {
  seedChallengeFixture();
  db.challenges.push({
    id: 1001, season_event_id: 900, challenge_template_id: 950, goal: 'Override goal', task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0), enabled: true,
    display_order: 0, completed: false, kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null,
    mobile_cta_link: null, metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/season-events/900/challenges`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    const item = body.data[0];
    assert.equal(item.overrides.goal, 'Override goal');
    assert.equal(item.effective.goal, 'Override goal'); // overridden
    assert.equal(item.effective.task, 'Template task'); // falls back to template
    assert.equal(item.card_preview.goal, 'Override goal');
    assert.equal(item.activity_type.id, 950);
    // #981 added `completed` to the shared mapper, so this payload carries it
    // too — additively, from the `SELECT c.*` this route already does.
    assert.equal(item.completed, false);
  } finally { server.close(); }
});

test('D6: create requires an existing challenge_template_id and accepts the v4 metric_*/featured fields', async () => {
  seedChallengeFixture();
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const missingTemplate = await fetch(`${base}/api/v4/admin/season-events/900/challenges`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(missingTemplate.status, 422);

    const res = await fetch(`${base}/api/v4/admin/season-events/900/challenges`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_template_id: 950, metric_type: 'count', metric_target: 7, metric_label: 'things',
        featured: true, featured_order: 1,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.metric_target, 7);
    assert.equal(body.data.featured, true);
    assert.equal(body.data.activity_type.id, 950); // raw row + template relation, SPEC 2680
  } finally { server.close(); }
});

test('D6: PUT update response INCLUDES activity_type (fresh()-bug fix)', async () => {
  seedChallengeFixture();
  db.challenges.push({
    id: 1002, season_event_id: 900, challenge_template_id: 950, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0), enabled: true,
    display_order: 0, completed: false, kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null,
    mobile_cta_link: null, metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/season-events/900/challenges/1002`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 'New goal' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.goal, 'New goal');
    assert.ok(body.data.activity_type, 'activity_type must be present on update, unlike the source fresh()-drop bug');
    assert.equal(body.data.activity_type.id, 950);
    // challenge_template_id is immutable — silently ignored even if sent.
  } finally { server.close(); }
});

test('D6: toggle-enabled and toggle-completed flip state and report the transitioned message', async () => {
  seedChallengeFixture();
  db.challenges.push({
    id: 1003, season_event_id: 900, challenge_template_id: 950, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0), enabled: true,
    display_order: 0, completed: false, kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null,
    mobile_cta_link: null, metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const enableRes = await fetch(`${base}/api/v4/admin/season-events/900/challenges/1003/toggle-enabled`, { method: 'PATCH' });
    const enableBody = await enableRes.json();
    assert.equal(enableBody.data.enabled, false);
    assert.equal(enableBody.message, 'Challenge disabled successfully.');

    const completeRes = await fetch(`${base}/api/v4/admin/season-events/900/challenges/1003/toggle-completed`, { method: 'PATCH' });
    const completeBody = await completeRes.json();
    assert.equal(completeBody.data.completed, true);
    assert.equal(completeBody.message, 'Challenge marked as completed.');
  } finally { server.close(); }
});

test('D6: move re-points the challenge AND its user_activities, reports the count in meta, and 422s on same-event move', async () => {
  seedChallengeFixture();
  db.challenges.push({
    id: 1004, season_event_id: 900, challenge_template_id: 950, goal: null, task: null, reward: null,
    description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
    cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0), enabled: true,
    display_order: 0, completed: false, kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null,
    mobile_cta_link: null, metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  db.userActivities.push(
    { id: 6001, user_id: 1, season_event_id: 900, activity_type: 'challenge_completion', points: 10, challenge_id: 1004, created_at: T(0), updated_at: T(0) },
    { id: 6002, user_id: 2, season_event_id: 900, activity_type: 'challenge_completion', points: 5, challenge_id: 1004, created_at: T(0), updated_at: T(0) },
  );
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const sameEvent = await fetch(`${base}/api/v4/admin/season-events/900/challenges/1004/move`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_season_event_id: 900 }),
    });
    assert.equal(sameEvent.status, 422);
    assert.equal((await sameEvent.json()).error, 'Target event is the same as the current event.');

    const res = await fetch(`${base}/api/v4/admin/season-events/900/challenges/1004/move`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_season_event_id: 901 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.season_event_id, 901);
    assert.deepEqual(body.meta, { from_season_event_id: 900, to_season_event_id: 901, user_activities_repointed: 2 });
    assert.ok(db.userActivities.every((a) => a.season_event_id === 901));
  } finally { server.close(); }
});

test('D6: update-display-orders validates ownership (422 listing offenders) and applies atomically otherwise', async () => {
  seedChallengeFixture();
  db.challenges.push(
    { id: 1005, season_event_id: 900, challenge_template_id: 950, display_order: 0, enabled: true, completed: false,
      goal: null, task: null, reward: null, description: null, requirements: null, schedule_start: null, schedule_end: null,
      reward_logic: null, cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0),
      kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
      metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null },
    { id: 1006, season_event_id: 900, challenge_template_id: 950, display_order: 1, enabled: true, completed: false,
      goal: null, task: null, reward: null, description: null, requirements: null, schedule_start: null, schedule_end: null,
      reward_logic: null, cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0),
      kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
      metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null },
    // Belongs to event 901, not 900 — an offender when submitted under /900/.
    { id: 1007, season_event_id: 901, challenge_template_id: 950, display_order: 0, enabled: true, completed: false,
      goal: null, task: null, reward: null, description: null, requirements: null, schedule_start: null, schedule_end: null,
      reward_logic: null, cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0),
      kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
      metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null },
  );
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const offenderRes = await fetch(`${base}/api/v4/admin/season-events/900/challenges/update-display-orders`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenges: [{ id: 1005, display_order: 5 }, { id: 1007, display_order: 0 }] }),
    });
    assert.equal(offenderRes.status, 422);
    const offenderBody = await offenderRes.json();
    assert.match(offenderBody.details.challenges[0], /1007/);
    // Atomicity: the valid id (1005) must NOT have been reordered either.
    assert.equal(db.challenges.find((c) => c.id === 1005).display_order, 0);

    const okRes = await fetch(`${base}/api/v4/admin/season-events/900/challenges/update-display-orders`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenges: [{ id: 1005, display_order: 9 }, { id: 1006, display_order: 8 }] }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.deepEqual(okBody.data.map((r) => r.id), [1006, 1005]); // re-sorted by the NEW display_order
    assert.ok(okBody.data[0].activity_type); // template relation loaded
  } finally { server.close(); }
});

test('D6: available-activity-types excludes templates already attached, ordered category then goal', async () => {
  seedChallengeFixture();
  db.challengeTemplates.push({
    id: 951, category: 'community', goal: 'Another goal', task: 't', reward: 'r', created_at: T(0), updated_at: T(0),
  });
  db.challenges.push({
    id: 1008, season_event_id: 900, challenge_template_id: 950, display_order: 0, enabled: true, completed: false,
    goal: null, task: null, reward: null, description: null, requirements: null, schedule_start: null, schedule_end: null,
    reward_logic: null, cta_button: null, cta_label: null, cta_link: null, created_at: T(0), updated_at: T(0),
    kind: null, cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
    metric_type: null, metric_target: null, metric_label: null, featured: false, featured_order: null,
  });
  const { server, base } = await listen(buildSubApp(challengesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/season-events/900/challenges/available-activity-types`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // template 950 is already attached to event 900 -> excluded; only 951 remains.
    assert.deepEqual(body.data.map((t) => t.id), [951]);
  } finally { server.close(); }
});

// ─── 5. D7 app-version-configs ──────────────────────────────────────────

test('D7: create/show/update/delete + os uniqueness + os immutability + recommended>=min exact message', async () => {
  const { server, base } = await listen(buildSubApp(appVersionConfigsAdminRoutes));
  try {
    const badRecommended = await fetch(`${base}/api/v4/admin/app-version-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ os: 'ios', min_build_number: 10, recommended_build_number: 5 }),
    });
    assert.equal(badRecommended.status, 422);
    assert.deepEqual((await badRecommended.json()).details.recommended_build_number, [
      'Recommended build number must be greater than or equal to minimum build number.',
    ]);

    const created = await fetch(`${base}/api/v4/admin/app-version-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ os: 'ios', min_build_number: 10, recommended_build_number: 12 }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const id = createdBody.data.id;

    const dupe = await fetch(`${base}/api/v4/admin/app-version-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ os: 'ios', min_build_number: 1 }),
    });
    assert.equal(dupe.status, 422);

    // Persisted-value discipline (the same discipline as the
    // `after:schedule_start` fix elsewhere in this task): the persisted
    // recommended_build_number (12) is now below a NEW min_build_number
    // (20) sent WITHOUT a sibling recommended_build_number in this same
    // request — must 422 against the PERSISTED recommended, not silently
    // pass for lack of a sibling value.
    const persistedClash = await fetch(`${base}/api/v4/admin/app-version-configs/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_build_number: 20 }),
    });
    assert.equal(persistedClash.status, 422);

    // os immutable: sending a different os on update is silently ignored;
    // raising recommended_build_number alongside min clears the clash.
    const updateRes = await fetch(`${base}/api/v4/admin/app-version-configs/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ os: 'android', min_build_number: 20, recommended_build_number: 25 }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.data.os, 'ios'); // unchanged
    assert.equal(updateBody.data.min_build_number, 20);

    const del = await fetch(`${base}/api/v4/admin/app-version-configs/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { success: true, message: 'App version configuration deleted successfully.' });
  } finally { server.close(); }
});

// ─── 6. D9 settings ─────────────────────────────────────────────────────

test('D9: index only ever returns topochain_* keys', async () => {
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/settings`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.length, 7);
    assert.ok(body.data.every((s) => s.key.startsWith('topochain_')));
    assert.equal(body.data.some((s) => s.key === 'user_daily_limit_cents'), false);
  } finally { server.close(); }
});

test('D9: create enforces the topochain_ prefix and key uniqueness', async () => {
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const badPrefix = await fetch(`${base}/api/v4/admin/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'not_prefixed', value: 5 }),
    });
    assert.equal(badPrefix.status, 422);

    const created = await fetch(`${base}/api/v4/admin/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'topochain_custom_points', value: 42 }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.data.value, 42);
    assert.match(createdBody.data.description, /topochain_custom_points/);

    const dupe = await fetch(`${base}/api/v4/admin/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'topochain_custom_points', value: 1 }),
    });
    assert.equal(dupe.status, 422);
  } finally { server.close(); }
});

test('D9: update accepts an explicit null description as "clear it" (not a 500) and never writes raw unvalidated input', async () => {
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/settings/topochain_top_1_points`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: null, value: 1600 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.description, null);
    assert.equal(body.data.value, 1600);

    const badValue = await fetch(`${base}/api/v4/admin/settings/topochain_top_1_points`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'not-a-number' }),
    });
    assert.equal(badValue.status, 422);
  } finally { server.close(); }
});

test('D9: delete removes a topochain_* key; a non-topochain key is invisible (404) to this router', async () => {
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const hidden = await fetch(`${base}/api/v4/admin/settings/user_daily_limit_cents`, { method: 'DELETE' });
    assert.equal(hidden.status, 404);
    assert.ok(db.platformSettings.some((s) => s.key === 'user_daily_limit_cents'));

    const del = await fetch(`${base}/api/v4/admin/settings/topochain_produced_half_blocks_points`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(db.platformSettings.some((s) => s.key === 'topochain_produced_half_blocks_points'), false);
  } finally { server.close(); }
});

test('D9: reset requires {"confirm": true}, upserts ONLY the six defaults, and never touches other keys (no TRUNCATE)', async () => {
  db.platformSettings.push({ key: 'topochain_custom_admin_key', value: '99', description: 'custom', updated_at: T(0), updated_by: null });
  const before = db.platformSettings.find((s) => s.key === 'topochain_top_1_points');
  before.value = '1'; // simulate an operator override that a TRUNCATE-based reset would also destroy
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const noConfirm = await fetch(`${base}/api/v4/admin/settings/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(noConfirm.status, 422);
    assert.equal(db.platformSettings.find((s) => s.key === 'topochain_top_1_points').value, '1'); // untouched

    const res = await fetch(`${base}/api/v4/admin/settings/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 6);
    assert.equal(db.platformSettings.find((s) => s.key === 'topochain_top_1_points').value, '1500'); // restored

    // The 7th seeded key, a custom admin key, and the non-topochain key
    // all survive — proving this is an upsert of six rows, not a TRUNCATE.
    assert.ok(db.platformSettings.some((s) => s.key === 'topochain_inviting_new_participant_points'));
    assert.ok(db.platformSettings.some((s) => s.key === 'topochain_custom_admin_key'));
    assert.ok(db.platformSettings.some((s) => s.key === 'user_daily_limit_cents'));
    assert.equal(db.platformSettings.length, 9);
  } finally { server.close(); }
});

test('D9: batch-update applies inside one transaction and validates every key up front (offenders block the whole batch)', async () => {
  const { server, base } = await listen(buildSubApp(settingsAdminRoutes));
  try {
    const offenderRes = await fetch(`${base}/api/v4/admin/settings/batch-update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: [
          { key: 'topochain_top_2_points', value: 2000 },
          { key: 'topochain_does_not_exist', value: 1 },
        ],
      }),
    });
    assert.equal(offenderRes.status, 422);
    // Atomic: the valid key must NOT have been updated either.
    assert.equal(db.platformSettings.find((s) => s.key === 'topochain_top_2_points').value, '1000');

    const res = await fetch(`${base}/api/v4/admin/settings/batch-update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: [
          { key: 'topochain_top_2_points', value: 2000 },
          { key: 'topochain_top_3_points', value: 600 },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(db.platformSettings.find((s) => s.key === 'topochain_top_2_points').value, '2000');
    assert.equal(db.platformSettings.find((s) => s.key === 'topochain_top_3_points').value, '600');
  } finally { server.close(); }
});
