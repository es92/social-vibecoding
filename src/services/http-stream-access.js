'use strict';
const { nativeWebSessionIsLive } = require('./web-session-auth');
const SESSION = Symbol('authenticated-stream-session');
const WRITES = Symbol('stream-frame-writes');
const positiveId = value => {
    try {
        value = decodeURIComponent(value);
    }
    catch {
        return null;
    }
    return /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
};
// Staging may replace the cookie during this request. Bind the session that
// actually authenticated it, rather than the old cookie sent by the browser.
function bindStreamSession(req, token) { req[SESSION] = token; }
// Call only after write() returns false. Also release a producer when the
// response is closed by a failed authority check, rather than leaving its
// durable-stream subscription waiting forever for a drain that cannot come.
function waitForStreamDrain(res, { timeoutMs = 5000, signal } = {}) {
    if (res.writableEnded || res.destroyed) return Promise.resolve(false);
    if (signal?.aborted) { res.destroy?.(); return Promise.resolve(false); }
    return new Promise(resolve => {
        let settled = false, timer;
        const done = (canWrite) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res.removeListener('drain', drained);
            signal?.removeEventListener('abort', aborted);
            for (const event of ['finish', 'close', 'error']) res.removeListener(event, closed);
            resolve(canWrite);
        };
        const drained = () => done(true);
        const closed = () => done(false);
        const aborted = () => { res.destroy?.(); done(false); };
        res.once('drain', drained);
        for (const event of ['finish', 'close', 'error']) res.once(event, closed);
        signal?.addEventListener('abort', aborted, { once: true });
        // A stalled reader must not hold a request's durable turn indefinitely.
        timer = setTimeout(() => { res.destroy?.(); done(false); }, timeoutMs);
        timer.unref?.();
    });
}
// One event may be larger than the pending queue (for example, a stored tool
// result). Split its bytes and wait for transport/authorization backpressure;
// SSE framing and UTF-8 are reconstructed by the receiving byte stream.
async function writeStreamBytes(res, chunk, { signal } = {}) {
    const pieceBytes = 64 * 1024;
    if (typeof chunk === 'string' && Buffer.byteLength(chunk) <= pieceBytes) {
        if (res.writableEnded || res.destroyed) return false;
        if (res.write(chunk) === false && !(await waitForStreamDrain(res, { signal }))) return false;
    } else {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < data.length; offset += pieceBytes) {
            if (res.writableEnded || res.destroyed) return false;
            if (res.write(data.subarray(offset, offset + pieceBytes)) === false && !(await waitForStreamDrain(res, { signal }))) return false;
        }
    }
    return !res.writableEnded && !res.destroyed;
}
// Await each frame at the producer. Serialize heartbeats too, so none can
// land inside a large frame while it is waiting for drain.
function writeStreamChunk(res, chunk, options) {
    const written = (res[WRITES] || Promise.resolve()).catch(() => {}).then(() => writeStreamBytes(res, chunk, options));
    res[WRITES] = written;
    const settled = () => { if (res[WRITES] === written) delete res[WRITES]; };
    written.then(settled, settled);
    return written;
}
// An in-progress frame is itself keep-alive traffic. Skip a heartbeat while
// it waits for drain instead of accumulating promises behind a slow reader.
function writeStreamHeartbeat(res, chunk, options) {
    return res[WRITES] ? Promise.resolve(false) : writeStreamChunk(res, chunk, options);
}
function streamResource(method, path) {
    path = path.replace(/\/$/, '');
    let m;
    if ((m = /^\/api\/sessions\/([^/]+)\/(events|chat)$/i.exec(path))
        && ((method === 'GET' && m[2].toLowerCase() === 'events') || (method === 'POST' && m[2].toLowerCase() === 'chat'))) {
        return positiveId(m[1]) ? { kind: 'classic', id: positiveId(m[1]), collab: method === 'POST' } : null;
    }
    if ((m = /^\/api\/agent-sessions\/([^/]+)\/(events|turns)$/i.exec(path))
        && ((method === 'GET' && m[2].toLowerCase() === 'events') || (method === 'POST' && m[2].toLowerCase() === 'turns'))) {
        return positiveId(m[1]) ? { kind: 'agent', id: positiveId(m[1]) } : null;
    }
    if (method === 'POST' && (m = /^\/api\/apps\/([^/]+)\/workshop\/ask$/i.exec(path))) {
        try {
            const slug = decodeURIComponent(m[1]);
            return slug && !slug.includes('/') ? { kind: 'app', slug } : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
// The credential and target share one snapshot. No handshake admin flag or
// cached collaborator roster is authority to send another response chunk.
const AUTHORIZE_SQL = `
 SELECT EXISTS (
  SELECT 1 FROM users u
  LEFT JOIN chat_sessions cs ON $5::text = 'classic' AND cs.id = $6::int
  LEFT JOIN agent_sessions ag ON $5::text = 'agent' AND ag.id = $6::int
  LEFT JOIN apps a ON ($5::text = 'classic' AND a.id = cs.app_id) OR ($5::text = 'app' AND a.slug = $7::text)
  WHERE u.id = $1 AND u.anonymised_at IS NULL
   AND (
    ($2::text = 'cookie' AND NOT u.is_synthetic
     AND (u.has_platform_access OR u.is_admin OR u.private_member_since IS NOT NULL) AND EXISTS (
      SELECT 1 FROM sessions s WHERE s.token = $3::text AND s.user_id = u.id
       AND s.expires_at > clock_timestamp() AND ${nativeWebSessionIsLive('s')}))
    OR ($2::text = 'cli' AND EXISTS (
      SELECT 1 FROM cli_access_tokens t WHERE t.id = $4::bigint AND t.user_id = u.id
       AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp() AND 'api:access' = ANY(t.scopes)))
   )
   AND CASE $5::text
    WHEN 'classic' THEN cs.id IS NOT NULL AND (cs.user_id = u.id OR u.is_admin)
    WHEN 'agent' THEN ag.user_id = u.id
    WHEN 'app' THEN a.id IS NOT NULL
    ELSE FALSE END
   AND ($5::text NOT IN ('classic', 'app') OR ($5::text = 'classic' AND cs.app_id IS NULL) OR (
    a.id IS NOT NULL AND a.moderation_suspended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.app_id = a.id AND b.user_id = u.id)
    AND (u.is_admin OR (CASE WHEN $8::boolean THEN a.collab_visibility ELSE a.view_visibility END) = 'public'
     OR EXISTS (SELECT 1 FROM app_collaborators m WHERE m.app_id = a.id AND m.user_id = u.id AND m.status = 'member'))
   ))
 ) AS allowed`;
function captureStreamAuthority(req, pool) {
    const id = req.user?.id;
    const resource = streamResource(req.method, req.path);
    // Hosted connector/delegated allowlists expose none of these SSE routes.
    // Keep them closed here until streaming has an explicit credential policy.
    const cli = req.cliAuthenticated && req.cliToken ? String(req.cliToken.id) : null;
    const unsupportedBearer = req.cliAuthenticated && !cli;
    const cookie = req[SESSION] || req.cookies?.session;
    const source = cli ? 'cli' : 'cookie';
    const params = [id, source, cookie || null, cli, resource?.kind || null, resource?.id || null,
        resource?.slug || null, !!resource?.collab];
    const check = async (db) => (await db.query(AUTHORIZE_SQL, params)).rows[0]?.allowed === true;
    return async () => {
        if (!id || !resource || unsupportedBearer || (!cli && !cookie))
            return false;
        return check(pool);
    };
}
module.exports = { bindStreamSession, captureStreamAuthority, streamResource, waitForStreamDrain, writeStreamChunk, writeStreamHeartbeat };
