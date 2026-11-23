// Sign lab personas in: one row in `sessions` each, and a Playwright storage state in $LAB/state/<username>.json.
// Usage: LAB=/path/to/lab-dir node audit-handoff/tools/lab-signin.js <repo-dir> [username ...]
// Run it after the server has booted once (the boot seeds the staging demo accounts).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LAB = process.env.LAB;
const [repo, ...asked] = process.argv.slice(2);
if (!LAB || !repo) { console.error('usage: LAB=<dir> node lab-signin.js <repo-dir> [username ...]'); process.exit(1); }
const names = asked.length ? asked : ['usernode-capture', 'usernode-capture-admin', 'staging-demo-user', 'staging-demo-collab', 'localadmin'];
const { Pool } = require(path.join(path.resolve(repo), 'node_modules/pg'));
(async () => {
  const env = JSON.parse(fs.readFileSync(path.join(LAB, 'env.json'), 'utf8'));
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  fs.mkdirSync(path.join(LAB, 'state'), { recursive: true });
  const { rows } = await pool.query('SELECT id, username FROM users WHERE username = ANY($1::text[])', [names]);
  for (const row of rows) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [token, row.id]);
    const state = { cookies: [{ name: 'session', value: token, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
    fs.writeFileSync(path.join(LAB, 'state', `${row.username}.json`), JSON.stringify(state));
    console.log('signed in', row.username);
  }
  const missing = names.filter((n) => !rows.some((r) => r.username === n));
  if (missing.length) console.log('not in this database:', missing.join(', '));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
