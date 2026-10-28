'use strict';
const { getPool } = require('../db/pool');
const { isRestricted } = require('../services/moderation');
// All social/build writes, including old sessions and CLI/MCP HTTP calls,
// share this gate. Personal settings, reads, report/block and account deletion
// remain usable. Socket writes check the same live account flag separately.
function participationWrite(path, method) {
  path = path.toLowerCase();
  if (['GET','HEAD','OPTIONS'].includes(method)) return false;
  if (/^\/api\/conversations\/\d+\/(read|leave|messages\/\d+\/(report|bookmark))$/.test(path)) return false;
  if (/^\/api\/apps\/[^/]+\/(?:messages\/\d+\/)?report$/.test(path)) return false;
  if (/^\/api\/profiles\/[^/]+\/report$/.test(path)) return false;
  return /^\/api\/(apps(?:\/|$)|sessions(?:\/|$)|conversations(?:\/|$)|issues(?:\/|$)|kudos(?:\/|$)|admin(?:\/|$)|invites(?:\/|$)|approver-invites(?:\/|$)|campaigns(?:\/|$)|feedback(?:\/|$)|workshop(?:\/|$))/.test(path);
}
function moderationGuard(config, { pool = getPool(config) } = {}) {
  return async (req,res,next) => {
    try {
      if (req.user && participationWrite(req.path, req.method) && await isRestricted(pool, req.user.id)) {
        return res.status(403).json({ error: 'Your participation is restricted by moderation. Account settings and existing data remain available.', code: 'participation_restricted' });
      }
      const appPath = req.path.match(/^\/api\/(?:public\/)?apps\/([^/]+)(?:\/|$)/i);
      if (appPath) {
        const result = await pool.query('SELECT id, moderation_suspended_at FROM apps WHERE slug = $1', [decodeURIComponent(appPath[1])]);
        if (await require('../services/app-blocks').isBlocked(pool, req.user?.id, result.rows[0]?.id)) {
          return res.status(403).json({ error: 'You blocked this app. Unblock it in Settings → Blocked apps.', code: 'app_blocked' });
        }
        if (result.rows[0]?.moderation_suspended_at) return res.status(403).json({ error: 'App suspended by moderation', code: 'app_suspended' });
      }
      next();
    } catch (err) { next(err); }
  };
}
module.exports = { moderationGuard, participationWrite };
