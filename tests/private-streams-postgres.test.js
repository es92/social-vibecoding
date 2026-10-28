'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
    const end = Date.now() + 3000;
    while (!(await fn())) {
        assert.ok(Date.now() < end, 'stream observation timed out');
        await wait(10);
    }
}
test('private platform SSE uses current authority', { timeout: 30000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
    try {
        await admin.query('SELECT 1');
    }
    catch (err) {
        await admin.end();
        if (process.env.TEST_DATABASE_URL)
            throw err;
        t.skip('PostgreSQL unavailable');
        return;
    }
    const name = 'private_reads_' + crypto.randomBytes(5).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 8 });
    const poolMod = require('../src/db/pool');
    const previous = poolMod.getPool;
    poolMod.getPool = () => pool;
    const bus = require('../src/services/session-bus');
    bus.init({ memory: true });
    let server;
    t.after(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(r => server.close(r));
        }
        await bus.settle();
        poolMod.getPool = previous;
        await pool.end();
        await admin.query(`DROP DATABASE ${name}`);
        await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    const config = { databaseUrl: String(url), dataEncryptionKey: 'synthetic-private-read-key', cliAuthEnabled: true };
    const app = express();
    app.use(require('../src/middleware/response-compression').responseCompression());
    app.use(express.json());
    app.use(cookieParser());
    app.use(require('../src/routes/cli-auth').cliApiBearerAuth(config));
    app.use(require('../src/middleware/auth').authMiddleware(config));
    app.use(require('../src/middleware/private-streams').privateStreamDelivery(config, { revalidateMs: 30 }));
    app.use(require('../src/services/account-deletion-runtime').trackResponse);
    app.use(require('../src/routes/auth').authRoutes(config));
    app.use(require('../src/routes/agent-sessions').agentSessionRoutes(config));
    app.use(require('../src/routes/sessions').sessionRoutes(config));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    let seq = 0;
    async function person(isAdmin = false) {
        const { rows: [u] } = await pool.query("INSERT INTO users (username,password,has_platform_access,is_admin) VALUES ($1,'synthetic',TRUE,$2) RETURNING id", ['reader_' + (++seq), isAdmin]);
        u.token = crypto.randomBytes(32).toString('hex');
        await pool.query("INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day')", [u.token, u.id]);
        return u;
    }
    async function fixture(kind) {
        const owner = await person(), stranger = await person(), staff = await person(true);
        const { rows: [a] } = await pool.query("INSERT INTO apps(name,slug,created_by,view_visibility,collab_visibility) VALUES($1,$1,$2,'private','private') RETURNING id", ['private-read-' + (++seq), stranger.id]);
        await pool.query("INSERT INTO app_collaborators(app_id,user_id,status) VALUES($1,$2,'member')", [a.id, owner.id]);
        const { rows: [s] } = kind === 'agent' ? await pool.query('INSERT INTO agent_sessions(user_id) VALUES($1) RETURNING id', [owner.id]) : await pool.query('INSERT INTO chat_sessions(app_id,user_id) VALUES($1,$2) RETURNING id', [a.id, owner.id]);
        return { owner, stranger, staff, a, s, key: kind === 'agent' ? 'agent:' + s.id : s.id, path: '/api/' + (kind === 'agent' ? 'agent-sessions' : 'sessions') + '/' + s.id + '/events?since=synthetic-start' };
    }
    async function stream(f, who, extraHeaders = {}) {
        const controller = new AbortController();
        const r = await fetch(base + f.path, { headers: { cookie: 'session=' + who.token, ...extraHeaders }, signal: controller.signal });
        assert.equal(r.status, 200);
        const state = { text: '', ended: false, controller };
        state.read = (async () => {
            try {
                for await (const b of r.body)
                    state.text += Buffer.from(b).toString();
            }
            catch (e) {
                if (e.name !== 'AbortError')
                    throw e;
            }
            finally {
                state.ended = true;
            }
        })();
        await until(() => state.text.includes(':ok'));
        await until(async () => await bus.subscriberCount(f.key) > 0);
        return state;
    }
    for (const kind of ['classic', 'agent']) {
        await t.test(kind + ': another account cannot read an owner stream', async () => {
            const f = await fixture(kind);
            const r = await fetch(base + f.path, { headers: { cookie: 'session=' + f.stranger.token } });
            assert.ok([403, 404].includes(r.status));
            assert.ok(!(await r.text()).includes('synthetic-private'));
        });
        await t.test(kind + ': logout stops private events on an already open stream', async () => {
            const f = await fixture(kind), s = await stream(f, f.owner);
            try {
                bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'permitted-' + kind });
                await bus.settle();
                await until(() => s.text.includes('permitted-' + kind));
                const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: 'session=' + f.owner.token, 'sec-fetch-site': 'same-origin' } });
                assert.equal(logout.status, 200);
                bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_AFTER_LOGOUT_' + kind });
                await bus.settle();
                await until(() => s.ended || s.text.includes('FORBIDDEN_AFTER_LOGOUT_'));
                assert.ok(!s.text.includes('FORBIDDEN_AFTER_LOGOUT_'), 'private data arrived after logout');
                assert.equal(s.ended, true);
            }
            finally {
                s.controller.abort();
                await s.read;
            }
        });
    }
    await t.test('classic: project access removal stops the owner stream', async () => {
        const f = await fixture('classic'), s = await stream(f, f.owner);
        try {
            await pool.query('DELETE FROM app_collaborators WHERE app_id=$1 AND user_id=$2', [f.a.id, f.owner.id]);
            bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_AFTER_REMOVAL' });
            await bus.settle();
            await until(() => s.ended || s.text.includes('FORBIDDEN_AFTER_REMOVAL'));
            assert.ok(!s.text.includes('FORBIDDEN_AFTER_REMOVAL'), 'private project events arrived after access removal');
            assert.equal(s.ended, true);
        }
        finally {
            s.controller.abort();
            await s.read;
        }
    });
    await t.test('classic: demotion stops an administrator watching somebody else\'s stream', async () => {
        const f = await fixture('classic'), s = await stream(f, f.staff);
        try {
            await pool.query('UPDATE users SET is_admin=FALSE WHERE id=$1', [f.staff.id]);
            bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_AFTER_DEMOTION' });
            await bus.settle();
            await until(() => s.ended || s.text.includes('FORBIDDEN_AFTER_DEMOTION'));
            assert.ok(!s.text.includes('FORBIDDEN_AFTER_DEMOTION'), 'private session events arrived after admin demotion');
            assert.equal(s.ended, true);
        }
        finally {
            s.controller.abort();
            await s.read;
        }
    });
    await t.test('classic: cookie expiry, anonymisation and platform-access removal stop delivery', async () => {
        for (const reason of ['expired', 'anonymised', 'platform-access']) {
            const f = await fixture('classic'), s = await stream(f, f.owner);
            try {
                if (reason === 'expired')
                    await pool.query("UPDATE sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token=$1", [f.owner.token]);
                else if (reason === 'anonymised')
                    await pool.query('UPDATE users SET anonymised_at=NOW() WHERE id=$1', [f.owner.id]);
                else
                    await pool.query('UPDATE users SET has_platform_access=FALSE WHERE id=$1', [f.owner.id]);
                bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_IDENTITY_' + reason });
                await bus.settle();
                await until(() => s.ended || s.text.includes('FORBIDDEN_IDENTITY_'));
                assert.ok(!s.text.includes('FORBIDDEN_IDENTITY_'));
                assert.equal(s.ended, true);
            }
            finally {
                s.controller.abort();
                await s.read;
            }
        }
    });
    await t.test('logout closes an idle stream without waiting for another private event', async () => {
        const f = await fixture('agent'), s = await stream(f, f.owner);
        try {
            await pool.query('DELETE FROM sessions WHERE token=$1', [f.owner.token]);
            await until(() => s.ended);
            assert.equal(s.text, ':ok\n\n');
        }
        finally {
            s.controller.abort();
            await s.read;
        }
    });
    await t.test('an authority query failure closes the existing stream without its next payload', async () => {
        const f = await fixture('classic'), s = await stream(f, f.owner);
        try {
            await pool.query('ALTER TABLE app_collaborators RENAME TO temporarily_unavailable_collaborators');
            bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_DURING_OUTAGE' });
            await bus.settle();
            await until(() => s.ended || s.text.includes('FORBIDDEN_DURING_OUTAGE'));
            assert.ok(!s.text.includes('FORBIDDEN_DURING_OUTAGE'));
            assert.equal(s.ended, true);
        }
        finally {
            await pool.query('ALTER TABLE temporarily_unavailable_collaborators RENAME TO app_collaborators');
            s.controller.abort();
            await s.read;
        }
    });
    await t.test('legacy CLI streams recheck token revocation and scopes without borrowing a cookie', async () => {
        for (const reason of ['revoked', 'scope']) {
            const f = await fixture('classic');
            const token = 'svcli_' + crypto.randomBytes(32).toString('base64url');
            const hash = crypto.createHash('sha256').update(token).digest('hex');
            const { rows: [credential] } = await pool.query("INSERT INTO cli_access_tokens(token_hash,token_hint,user_id,scopes,expires_at) VALUES($1,$2,$3,ARRAY['api:access','rpc:identity:read'],NOW()+INTERVAL '30 days') RETURNING id", [hash, 'svcli_…' + token.slice(-4), f.owner.id]);
            const s = await stream(f, f.owner, { authorization: 'Bearer ' + token });
            try {
                bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'permitted-cli-' + reason });
                await bus.settle();
                await until(() => s.text.includes('permitted-cli-'));
                if (reason === 'revoked')
                    await pool.query('UPDATE cli_access_tokens SET revoked_at=NOW() WHERE id=$1', [credential.id]);
                else
                    await pool.query("UPDATE cli_access_tokens SET scopes=ARRAY['rpc:identity:read'] WHERE id=$1", [credential.id]);
                bus.publish(f.key, { _seq: 'synthetic-' + (++seq), type: 'synthetic-private', text: 'FORBIDDEN_CLI_' + reason });
                await bus.settle();
                await until(() => s.ended || s.text.includes('FORBIDDEN_CLI_'));
                assert.ok(!s.text.includes('FORBIDDEN_CLI_'));
                assert.equal(s.ended, true);
            }
            finally {
                s.controller.abort();
                await s.read;
            }
        }
    });
    for (const kind of ['classic', 'agent', 'agent-snapshot']) {
        await t.test(kind + ': a large retained replay respects response backpressure', async () => {
            const f = await fixture(kind === 'classic' ? 'classic' : 'agent');
            const turnId = crypto.randomUUID();
            if (kind === 'agent-snapshot') {
                await pool.query('UPDATE agent_sessions SET active_turn=$1 WHERE id=$2', [{ id: turnId }, f.s.id]);
                f.path = '/api/agent-sessions/' + f.s.id + '/events';
            }
            for (let i = 0; i < 100; i++)
                bus.publish(f.key, {
                    _seq: turnId.slice(0, 8) + '-' + i, type: 'synthetic-private',
                    text: 'SYNTHETIC_LARGE_ROW_' + i + ':' + 'x'.repeat(16384),
                });
            await bus.flush();
            const s = await stream(f, f.owner);
            try {
                await until(() => s.text.includes('SYNTHETIC_LARGE_ROW_99:'));
                assert.equal(s.ended, false);
                const events = s.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
                assert.equal(events.length, 100);
                assert.deepEqual(events.map(e => e._seq), Array.from({ length: 100 }, (_, i) => turnId.slice(0, 8) + '-' + i));
                assert.ok(s.text.length > 1024 * 1024);
            }
            finally {
                s.controller.abort();
                await s.read;
            }
        });
    }
    await t.test('all declared stream scopes use real current credentials and preserve public reads', async () => {
        const access = require('../src/services/http-stream-access');
        const f = await fixture('classic'), outside = await person();
        const req = (who, method, path) => ({ user: { id: who.id, isAdmin: true }, cookies: { session: who.token }, method, path });
        const allowed = (r) => access.captureStreamAuthority(r, pool)();
        const path = '/api/sessions/' + f.s.id;
        assert.equal(await allowed(req(f.owner, 'GET', path + '/events')), true);
        assert.equal(await allowed(req(f.owner, 'POST', path + '/chat')), true);
        await pool.query('UPDATE users SET has_platform_access=FALSE,private_member_since=NOW() WHERE id=$1', [f.owner.id]);
        assert.equal(await allowed(req(f.owner, 'GET', path + '/events')), true, 'an admitted private-community member keeps their platform access');
        assert.equal(await allowed(req(outside, 'GET', path + '/events')), false, 'a cached admin flag grants no authority');
        const oldCookie = req(f.owner, 'GET', path + '/events');
        oldCookie.cookies.session = outside.token;
        assert.equal(await allowed(oldCookie), false);
        access.bindStreamSession(oldCookie, f.owner.token);
        assert.equal(await allowed(oldCookie), true, 'use the identity minted for this request, as a staging switch does');
        const { rows: [project] } = await pool.query('SELECT slug FROM apps WHERE id=$1', [f.a.id]);
        const ask = '/api/apps/' + project.slug + '/workshop/ask';
        assert.equal(await allowed(req(f.owner, 'POST', ask)), true);
        assert.equal(await allowed(req(outside, 'POST', ask)), false);
        await pool.query("UPDATE apps SET view_visibility='public' WHERE id=$1", [f.a.id]);
        assert.equal(await allowed(req(outside, 'POST', ask)), true, 'public workshop reads do not require joining');
        await pool.query('DELETE FROM app_collaborators WHERE app_id=$1 AND user_id=$2', [f.a.id, f.owner.id]);
        assert.equal(await allowed(req(f.owner, 'GET', path + '/events')), true, 'a public project permits its owner to read their session');
        assert.equal(await allowed(req(f.owner, 'POST', path + '/chat')), false, 'sending still needs collaboration access');
        const ag = await fixture('agent');
        assert.equal(await allowed(req(ag.owner, 'POST', '/api/agent-sessions/' + ag.s.id + '/turns')), true);
        assert.equal(await allowed(req(outside, 'POST', '/api/agent-sessions/' + ag.s.id + '/turns')), false);
    });
});
