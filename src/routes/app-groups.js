'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { appGroupAuth } = require('../middleware/app-group-auth');
const governance = require('../services/governance');
const governanceRules = require('../services/governance-rules');
const log = require('../services/logger');

// Dapp → platform app-groups API (#6669). An app creates a group and keeps
// its member list up to date; a project's approval rules may then name that
// group. Mounted in server.js BEFORE authMiddleware because callers are app
// containers, not browser sessions; the middleware's private-IP gate keeps
// it off the public internet.
//
//   GET  /api/app-groups                    the app's groups
//   PUT  /api/app-groups/:name              create it if missing
//   PUT  /api/app-groups/:name/members      replace its whole member list
//
// The list is the app's own statement about who uses it, so there is no
// user token (see middleware/app-group-auth.js). Nobody is made a project
// member by being in the group: to vote they still have to join.
const MAX_MEMBERS = 5000;

// The same name rules governance.groups apply in dapp.json.
function cleanName(raw) {
  return String(raw || '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

function nameProblem(name) {
  if (!name) return 'A group needs a name';
  if (name.length > governanceRules.GROUP_NAME_MAX) {
    return `A group's name is at most ${governanceRules.GROUP_NAME_MAX} characters`;
  }
  if (governanceRules.BUILT_IN_GROUPS.includes(governanceRules.groupKey(name))) {
    return `"${name}" is a built-in group; name yours something else`;
  }
  return null;
}

async function readNamedKeys(pool, appId) {
  const { rows } = await pool.query('SELECT governance_rules FROM apps WHERE id = $1', [appId]);
  const stored = rows[0]?.governance_rules;
  const rules = stored && Array.isArray(stored.rules) ? stored.rules : [];
  return new Set(rules.map((r) => r.group));
}

function appGroupRoutes(config, deps = {}) {
  const router = Router();
  const pool = deps.pool || getPool(config);
  const auth = appGroupAuth(pool, config);
  const json = express.json({ limit: '1mb' });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app-group:${req.appGroup?.appId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-groups', 'Rate-limited', { appId: req.appGroup?.appId });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.use('/api/app-groups', auth, limiter);

  async function findGroup(appId, key) {
    const { rows } = await pool.query(
      'SELECT id, name, reported_at FROM app_groups WHERE app_id = $1 AND key = $2',
      [appId, key]
    );
    return rows[0] || null;
  }

  async function createGroup(appId, name, key) {
    const { rows } = await pool.query(
      `INSERT INTO app_groups (app_id, key, name) VALUES ($1, $2, $3)
       ON CONFLICT (app_id, key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, reported_at`,
      [appId, key, name]
    );
    return rows[0];
  }

  router.get('/api/app-groups', async (req, res) => {
    try {
      // #6811: the query lives once, in governance.listAppGroups; this route
      // adds whether a rule already names each group.
      const groups = await governance.listAppGroups(pool, req.appGroup.appId);
      const named = await readNamedKeys(pool, req.appGroup.appId);
      res.json({
        ok: true,
        groups: groups.map((g) => ({ ...g, named: named.has(g.key) })),
      });
    } catch (err) {
      log.error('app-groups', 'List failed', { err: err.message });
      res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
  });

  router.put('/api/app-groups/:name', json, async (req, res) => {
    const name = cleanName(req.params.name);
    const problem = nameProblem(name);
    if (problem) return res.status(400).json({ ok: false, code: 'bad_name', message: problem });
    try {
      const group = await createGroup(req.appGroup.appId, name, governanceRules.groupKey(name));
      res.json({ ok: true, name: group.name, key: governanceRules.groupKey(name) });
    } catch (err) {
      log.error('app-groups', 'Create failed', { err: err.message });
      res.status(500).json({ ok: false, code: 'write_failed' });
    }
  });

  router.put('/api/app-groups/:name/members', json, async (req, res) => {
    const name = cleanName(req.params.name);
    const problem = nameProblem(name);
    if (problem) return res.status(400).json({ ok: false, code: 'bad_name', message: problem });
    const raw = req.body && req.body.userIds;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ ok: false, code: 'bad_body', message: 'userIds must be a list of account ids' });
    }
    if (raw.length > MAX_MEMBERS) {
      return res.status(413).json({ ok: false, code: 'too_many', message: `A list holds at most ${MAX_MEMBERS} people` });
    }
    const ids = [...new Set(raw.filter((n) => Number.isInteger(n) && n > 0))];
    const key = governanceRules.groupKey(name);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [group] } = await client.query(
        `INSERT INTO app_groups (app_id, key, name) VALUES ($1, $2, $3)
         ON CONFLICT (app_id, key) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [req.appGroup.appId, key, name]
      );
      // Replace the whole list: an id no longer in it no longer counts, and
      // the row it had is not remembered (the spec's two open questions).
      await client.query('DELETE FROM app_group_members WHERE group_id = $1', [group.id]);
      // Only ids that are Homeroom accounts; the rest are ignored.
      const { rows: kept } = await client.query(
        'SELECT id FROM users WHERE id = ANY($1::int[])',
        [ids]
      );
      if (kept.length) {
        await client.query(
          `INSERT INTO app_group_members (group_id, user_id)
           SELECT $1, x FROM unnest($2::int[]) AS x`,
          [group.id, kept.map((r) => r.id)]
        );
      }
      await client.query('UPDATE app_groups SET reported_at = NOW() WHERE id = $1', [group.id]);
      await client.query('COMMIT');
      governance.invalidateGovernance(req.appGroup.appId);
      res.json({ ok: true, size: kept.length, ignored: ids.length - kept.length });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already gone */ }
      log.error('app-groups', 'Member list write failed', { err: err.message });
      res.status(500).json({ ok: false, code: 'write_failed' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = appGroupRoutes;
// Also named, for a reader that wants the cap beside the factory.
module.exports.appGroupRoutes = appGroupRoutes;
module.exports.MAX_MEMBERS = MAX_MEMBERS;
