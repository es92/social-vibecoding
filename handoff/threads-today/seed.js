// Seeds five threads into the local staging copy of Homeroom (app 1), the
// way the platform's own writers would leave them, for rendering them as
// they show today. Requests go through services/requests.js (which hands
// out the shared #N), plans through services/request-specs.js (the
// connector's post_spec), and the rest as the rows the staging seeds write.
// Everything is "Staging demo" and fake. Run once against a fresh database
// (see README.md: start the server first, then set app 1's next number).
'use strict';

const path = require('node:path');
// The checkout whose code and modules it uses: this repository, unless MAIN_WT names another.
const W = process.env.MAIN_WT || path.resolve(__dirname, '../..');
const { Pool } = require(path.join(W, 'node_modules/pg'));
const bcrypt = require(path.join(W, 'node_modules/bcrypt'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const requests = require(path.join(W, 'src/services/requests.js'));
const specs = require(path.join(W, 'src/services/request-specs.js'));
const appNumbers = require(path.join(W, 'src/services/app-numbers.js'));

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const ago = (hours) => new Date(Date.now() - hours * 3600000);

async function user(username) {
  const found = await one('SELECT id, username FROM users WHERE username = $1', [username]);
  if (found) return found;
  return one(`INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username]);
}

async function say(app, who, number, content, hours) {
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5)`,
    [app.id, who.id, content, number, ago(hours)]);
}

async function request(app, who, title, body, hours) {
  const r = await requests.create('Usernode-Labs', 'social-vibecoding', { title, body, createdBy: who.id });
  await pool.query('UPDATE requests SET created_at = $3, updated_at = $3 WHERE app_id = $1 AND number = $2', [app.id, r.number, ago(hours)]);
  // Its twin, as POST /api/apps/:slug/issues writes it beside the request: who asked.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'general', '{}', $5, $6)`, [app.id, r.number, title, body, who.id, ago(hours)]);
  return r.number;
}

// A change up for a vote: a session with a PR, linked to the request.
async function change(app, who, number, { title, summary, branch, hours, sessionId = null }) {
  const pr = await appNumbers.next(app.id, { db: pool });
  const values = [app.id, who.id, branch, pr, title, summary, number, ago(hours), ago(hours - 0.5)];
  if (sessionId) {
    await pool.query(
      `UPDATE chat_sessions SET branch_name = $3, pr_number = $4, pr_title = $5, pr_summary_md = $6,
              status = 'promoted', shared_at = $8, promoted_at = $9, last_activity_at = $9,
              check_state = 'passing', checks_checked_at = $9
        WHERE id = $10 AND app_id = $1 AND user_id = $2 AND $7::int = ANY(linked_issues)`,
      [...values, sessionId]);
    return { id: sessionId, pr };
  }
  const row = await one(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status, linked_issues,
        created_from_issue_number, issue_link_seeded, shared_at, promoted_at, created_at, last_activity_at,
        check_state, checks_checked_at, is_headless)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', ARRAY[$7::int], $7, TRUE, $8, $9, $8, $9, 'passing', $9, FALSE)
     RETURNING id`, values);
  return { id: row.id, pr };
}

async function vote(sessionId, who, v, hours) {
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at) VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT DO NOTHING`, [sessionId, who.id, v, ago(hours)]);
}

async function plan(app, who, number, title, text, hours) {
  const posted = await specs.postRequestSpec(pool, {
    app: { id: app.id, slug: app.slug, name: app.name }, repo: null, issueNumber: number, issueTitle: title,
    user: who, text,
  }, {
    github: { isEnabled: () => false },
    // ws.sendBotMessage's own insert, without a socket server to tell.
    ws: {
      sendBotMessage: async (p, appId, { user: u, content, metadata, thread, msgType }) => one(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [appId, u.id, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref, ago(hours)]),
    },
  });
  await pool.query('UPDATE chat_session_specs SET created_at = $2, shared_to_group_at = $2 WHERE session_id = $1', [posted.sessionId, ago(hours)]);
  await pool.query('UPDATE chat_sessions SET created_at = $2 WHERE id = $1', [posted.sessionId, ago(hours)]);
  return posted.sessionId;
}

(async () => {
  requests.setPool(pool);
  const app = await one('SELECT id, slug, name FROM apps WHERE id = 1');
  const me = await one(`SELECT id, username FROM users WHERE username = 'usernode-capture'`);
  await pool.query('UPDATE users SET password = $2 WHERE id = $1', [me.id, bcrypt.hashSync('capture-pass-123', 10)]);
  const ana = await user('staging-demo-ana');
  const dewi = await user('staging-demo-dewi');
  const milo = await user('staging-demo-milo');
  const bot = await one(`SELECT id, username FROM users WHERE username = 'homeroom_bot'`);
  for (const u of [ana, dewi, milo]) {
    await pool.query(`INSERT INTO community_members (community_id, user_id) VALUES (1, $1) ON CONFLICT DO NOTHING`, [u.id]);
  }
  const out = {};

  // 1 · A private thread from scratch: an idea in no project, in Main Chat.
  let convo = await one(
    `SELECT c.id FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      WHERE c.kind = 'direct' LIMIT 1`, [me.id, bot.id]);
  if (!convo) {
    convo = await one(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [me.id]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'member', NOW()), ($1, $3, 'member', 'member', NOW())`, [convo.id, me.id, bot.id]);
  }
  const dm = async (who, content, hours, root = null) => one(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [convo.id, who.id, content, root, ago(hours)]);
  await dm(bot, 'Hi! I\'m Homeroom bot. Ask me anything about your communities, or tell me an idea and I\'ll help you shape it.', 30);
  const root = await dm(me, 'Staging demo idea: a weekly email of what went live in the communities I\'m in', 3);
  await dm(bot, 'Nice. Who is it for: you, or everyone in a community? And which day should it come?', 2.9, root.id);
  await dm(me, 'Everyone who opts in. Monday morning, so the week starts with it.', 2.8, root.id);
  await dm(bot, 'Here is how I would write it up:\n\n**A weekly digest email**\nEvery Monday at 8am, people who opt in get one email listing the changes that went live last week in each community they\'re in, newest first, with a link to each.\n\n**Done when**\n- Settings has a "Weekly digest" switch, off by default\n- The email skips a week with nothing new\n\nIt isn\'t in a project yet. Pick one when you file it, or keep shaping it here.', 2.7, root.id);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, 'idea', 'open', $4, $5)`, [me.id, convo.id, root.id, ago(3), ago(2.7)]);
  out.private = { conversationId: convo.id, rootId: root.id };

  // 2 · One request, no change.
  const n2 = await request(app, me, 'Staging demo: show unread counts on the Communities tab',
    'When someone replies in a community I\'m in, the Communities tab gives no sign of it. I only find out when I happen to open it.\n\nA small number on the tab, like Messages has, would do.', 50);
  await say(app, dewi, n2, '+1, I miss replies all the time.', 48);
  await say(app, milo, n2, 'Should it count every new message, or only replies to things I wrote?', 30);
  await say(app, me, n2, 'Only replies to me, and votes waiting on me. Every message would be noise.', 29);
  out.request = n2;

  // 3 · One request, one change.
  const n3 = await request(app, me, 'Staging demo: let me pin a message in a channel',
    'Our #general has the rules and the meeting link buried after a week. Pinning one message to the top of a channel would keep them findable.', 72);
  await say(app, milo, n3, 'Only admins should be able to pin, I think.', 70);
  const c3 = await change(app, dewi, n3, {
    title: 'Pin a message to the top of a channel',
    summary: 'Admins can pin one message per channel. It stays above the newest messages until someone unpins it.',
    branch: 'staging-demo/pin-message', hours: 20,
  });
  await say(app, dewi, n3, 'Put up a change for this. Admins only, one pin per channel. Try the preview.', 19.5);
  await vote(c3.id, dewi, 'yes', 19.5);
  await vote(c3.id, milo, 'yes', 10);
  out.change = { request: n3, pr: c3.pr };

  // 4 · One request, one plan, one change built from it.
  const n4 = await request(app, me, 'Staging demo: sort Discover by most active',
    'Discover lists projects newest first, so busy projects sink. I\'d like to see the ones people are actually using.', 96);
  const s4 = await plan(app, ana, n4, 'Staging demo: sort Discover by most active',
    '# Sort Discover by most active\n\n## What changes\nDiscover gets a sort menu: **Most active** (the default) and **Newest**.\n\n## Most active means\nMembers who posted, voted or opened the app in the last 14 days, counted once each.\n\n## Done when\n- The menu remembers the choice on this device\n- A project with no activity sorts by when it was made', 60);
  await say(app, ana, n4, 'Plan is up. Shout if 14 days is the wrong window.', 59.8);
  await say(app, me, n4, '14 days sounds right. Go ahead.', 50);
  const c4 = await change(app, ana, n4, {
    title: 'Sort Discover by most active', sessionId: s4,
    summary: 'Discover sorts by how many members were active in the last 14 days, with Newest one tap away.',
    branch: 'staging-demo/discover-most-active', hours: 26,
  });
  await vote(c4.id, ana, 'yes', 25.5);
  out.plan = { request: n4, pr: c4.pr, session: s4 };

  // 5 · One request, two plans, two changes: one for each plan.
  const n5 = await request(app, me, 'Staging demo: a dark theme',
    'Homeroom is very bright at night. A dark theme, please.', 120);
  const s5a = await plan(app, ana, n5, 'Staging demo: a dark theme',
    '# Follow the system setting\n\nHomeroom goes dark when the phone or computer is in dark mode, and light when it is not. Nothing to set.\n\n## Done when\n- Every screen reads well in both\n- Switching the system setting switches Homeroom at once', 90);
  const s5b = await plan(app, dewi, n5, 'Staging demo: a dark theme',
    '# A switch in Settings\n\nSettings › Appearance gets Light, Dark and Match system, Match system first.\n\n## Done when\n- The choice follows the account to every device\n- Every screen reads well in both', 80);
  await say(app, milo, n5, 'Two plans now: system setting only, or a switch in Settings. I prefer having the switch.', 70);
  const c5a = await change(app, ana, n5, {
    title: 'Dark theme that follows the system setting', sessionId: s5a,
    summary: 'Homeroom follows the device: dark in dark mode, light otherwise.',
    branch: 'staging-demo/dark-follow-system', hours: 40,
  });
  const c5b = await change(app, dewi, n5, {
    title: 'Dark theme with a switch in Settings', sessionId: s5b,
    summary: 'Settings › Appearance offers Light, Dark and Match system. The choice follows your account.',
    branch: 'staging-demo/dark-settings-switch', hours: 30,
  });
  await say(app, dewi, n5, 'Both are up now, so it is a pick between them.', 29);
  await vote(c5a.id, ana, 'yes', 39.5);
  await vote(c5b.id, dewi, 'yes', 29.5);
  await vote(c5b.id, milo, 'yes', 20);
  out.ballot = { request: n5, prs: [c5a.pr, c5b.pr], sessions: [s5a, s5b] };

  // A promoted change records the head its summary was written for. Without
  // one, the first read pins a head and marks the summary stale ("Written
  // for an earlier version of this change"). The column is the proposal
  // workflow's, so it is written as that workflow writes it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.wf_writer', 'transition', true)`);
    await client.query(
      `UPDATE chat_sessions SET pr_summary_stale = FALSE, reviewed_head_sha = 'c0ffee' || lpad(id::text, 34, '0')
        WHERE app_id = $1 AND pr_number = ANY($2::int[])`,
      [app.id, [c3.pr, c4.pr, c5a.pr, c5b.pr]]);
    await client.query('COMMIT');
  } finally { client.release(); }

  console.log(JSON.stringify(out));
  await pool.end();
})().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
