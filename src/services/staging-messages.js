'use strict';

const crypto = require('crypto');
const conversations = require('./conversations');

function demoUser(id, username) {
  return { id, username, avatarUrl: null };
}

const DEMO_ADA = demoUser(902783, 'staging-demo-general-ada');
const DEMO_LIN = demoUser(902784, 'staging-demo-general-lin');
const CAPTURE_ADMIN_USERNAME = 'usernode-capture-admin';
const UNREAD_CHECK_KEY = 'staging-capture-unread-check';
const UNREAD_CHECK_TITLE = 'Preview check-in';

const DEMO_SCREENSHOT_NAME = 'Screenshot 2026-08-13 at 12.44.10\u202fPM.png';
const DEMO_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsPnECsq5cMDN0aQKmurhEAWCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEvTPAqsgmoaz8xeCAAAAAElFTkSuQmCC',
  'base64'
);

function demoConversations(user) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  const lin = DEMO_LIN;
  return [
    {
      id: 910001, kind: 'direct', title: 'ada', status: 'active', archived: false,
      members: [
        { ...self, role: 'member', status: 'member', joinedAt: '2026-08-11T12:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-11T12:01:00Z' },
      ],
      memberCount: 2, membershipStatus: 'member', myRole: 'member', requester: null, peer: ada,
      latestMessage: null, latestSummary: 'The proposal card is ready to review.',
      lastActivityAt: '2026-08-13T13:30:00Z', unreadCount: 2,
      canSend: true, canInvite: false, canManage: false,
    },
    {
      id: 910002, kind: 'group', title: 'Launch crew', status: 'active', archived: false,
      members: [
        { ...self, role: 'owner', status: 'member', joinedAt: '2026-08-10T10:00:00Z' },
        { ...ada, role: 'member', status: 'member', joinedAt: '2026-08-10T10:02:00Z' },
        { ...lin, role: 'member', status: 'member', joinedAt: '2026-08-10T10:03:00Z' },
      ],
      memberCount: 3, membershipStatus: 'member', myRole: 'owner', requester: null, peer: null,
      latestMessage: null, latestSummary: 'I attached the launch checklist.',
      lastActivityAt: '2026-08-13T12:45:00Z', unreadCount: 0,
      canSend: true, canInvite: true, canManage: true,
    },
    {
      id: 910003, kind: 'group', title: 'Design review', status: 'active', archived: false,
      members: [], memberCount: 4, membershipStatus: 'invited', myRole: 'member',
      requester: lin, peer: null, latestMessage: null, latestSummary: '',
      lastActivityAt: '2026-08-13T11:00:00Z', unreadCount: 0,
      canSend: false, canInvite: false, canManage: false,
    },
    {
      id: 910004, kind: 'channel', title: 'general', channelKey: 'general',
      status: 'active', archived: false,
      members: [], memberCount: 128, membershipStatus: 'member', myRole: 'member',
      requester: null, peer: null, latestMessage: null,
      latestSummary: 'Anyone else trying the new #general room?',
      lastActivityAt: '2026-08-13T13:10:00Z', unreadCount: 1,
      canSend: true, canInvite: false, canManage: false,
    },
  ];
}

function demoMessagesRaw(user, conversationId) {
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  if (conversationId === 910001) return [
    {
      // #1808: the thread's oldest row, fixed in an earlier YEAR so the
      // transcript's third stamp branch is on screen in every preview. The
      // rows below it are this year's, so one scroll of this pane shows all
      // three spellings the transcript uses. It used to print "08:40 AM"
      // here and "01:20 PM" below, with nothing to say the two were two
      // years apart.
      id: 9100100, conversationId, sender: ada,
      content: 'This is where the thread started, back in 2024.',
      createdAt: '2024-11-02T08:40:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [],
    },
    {
      // `saved: true` on exactly one demo row, so the staging preview and the
      // declared checks show BOTH states of the save button on one screen —
      // filled here, empty on every other row. The real flag is hydrated per
      // viewer in services/conversations.js; this is the ?demo=1 stand-in,
      // because `conversation_message_bookmarks` is staging:private and a
      // staging clone therefore has the table and none of the rows.
      id: 9100101, conversationId, sender: ada, saved: true,
      content: 'Can you look at the latest proposal?', createdAt: '2026-08-13T13:20:00Z', editedAt: null,
      reply: null, reactions: [{ emoji: '👍', count: 2, reacted: false, users: ['ada', self.username] }],
      attachments: [], objects: [{
        type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
        sessionId: 3327, title: 'Platform Messages', subtitle: 'Homeroom', state: 'active',
        author: 'ada', href: '#app/usernode/dev/proposals/3327',
      }],
    },
    {
      id: 9100102, conversationId, sender: self,
      content: 'Yes — the consent and privacy boundary looks right.', createdAt: '2026-08-13T13:25:00Z', editedAt: '2026-08-13T13:26:00Z',
      reply: { id: 9100101, sender: ada, content: 'Can you look at the latest proposal?' },
      reactions: [], attachments: [], objects: [{
        type: 'app', appId: 1, appSlug: 'usernode', available: true,
        title: 'Homeroom', subtitle: 'Platform app', state: 'active', author: 'ada',
        href: '#app/usernode',
      }, {
        type: 'issue', appId: 1, appSlug: 'usernode', issueNumber: 488, available: true,
        title: 'Platform-wide private messaging', subtitle: 'Homeroom · Issue #488',
        state: 'open', author: 'ada', href: '#app/usernode/dev/issues/488',
      }],
    },
    {
      id: 9100103, conversationId, sender: ada,
      content: 'The proposal card is ready to review.', createdAt: '2026-08-13T13:30:00Z', editedAt: null,
      reply: null, reactions: [], attachments: [], objects: [{
        type: 'spec', appId: 1, appSlug: 'usernode', sessionId: 3327, version: 1,
        available: true, title: 'Platform Messages spec v1', subtitle: 'Homeroom',
        state: 'v1', author: 'ada', href: '#app/usernode/dev/sessions/3327',
      }, {
        type: 'governance', appId: 1, appSlug: 'usernode', proposalId: 701,
        available: true, title: 'Enable Messages rollout', subtitle: 'Homeroom governance',
        state: 'open', author: 'ada', href: '#app/usernode/dev/governance/701',
      }, { type: 'spec', available: false }],
    },
  ];
  if (conversationId === 910002) return [{
    id: 9100201, conversationId, sender: ada,
    content: 'I attached the launch checklist.', createdAt: '2026-08-13T12:45:00Z', editedAt: null,
    reply: null, reactions: [], attachments: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'launch-checklist.md', size: 842,
      contentType: 'text/markdown', kind: 'markdown',
      url: `/api/conversations/${conversationId}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1`,
      viewUrl: null,
    }, {
      // #2113: a screenshot named the way macOS names them, with a narrow
      // no-break space before "PM". Serving it used to 500 because that
      // character cannot travel in a Content-Disposition header, so the
      // preview shows the fix: the image renders instead of breaking.
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: DEMO_SCREENSHOT_NAME,
      size: DEMO_SCREENSHOT_PNG.length, contentType: 'image/png', kind: 'image',
      url: `/api/conversations/${conversationId}/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?demo=1`,
      viewUrl: null,
    }], objects: [],
  }, {
    // #2387: a message its author deleted — the placeholder the transcript
    // draws in its place. Sender and time stay; nothing it said does. It is
    // the newest row, and the list's latestSummary above still reads the
    // checklist because a deleted message is never the latest.
    id: 9100202, conversationId, sender: ada,
    content: '', createdAt: '2026-08-13T12:50:00Z', editedAt: null, deleted: true,
    reply: null, reactions: [], attachments: [], objects: [], saved: false,
  }];
  if (conversationId === 910004) {
    const lin = DEMO_LIN;
    // Three from ada in a row, then lin: the transcript draws ada's name and
    // face ONCE and her next two as continuation lines (#2783), which is the
    // grouping the declared checks look for.
    return [
      {
        id: 9100401, conversationId, sender: ada,
        content: 'Morning all! The Messages list is sectioned now.', createdAt: '2026-08-13T13:00:00Z', editedAt: null,
        reply: null, reactions: [{ emoji: '🎉', count: 3, reacted: false, users: ['lin'] }], attachments: [], objects: [],
      },
      {
        id: 9100402, conversationId, sender: ada,
        content: 'Direct messages and agents on top, channels underneath.', createdAt: '2026-08-13T13:01:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        id: 9100403, conversationId, sender: ada,
        content: 'Issue #488 has the background.', createdAt: '2026-08-13T13:02:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      {
        // #2387: the demo THREAD's root. Its three replies are in
        // demoThreadReplies below; the main stream draws each as a line where
        // it landed (demoMainStream), and this summary is the card under the
        // message that opens them.
        id: 9100404, conversationId, sender: lin,
        content: 'Anyone else trying the new #general room?', createdAt: '2026-08-13T13:10:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
        thread: {
          replyCount: 3, lastReplyAt: '2026-08-13T13:30:00Z',
          participants: [ada, lin],
          lastReply: {
            id: 9100413, sender: ada, content: 'And the room stays quiet while we talk.',
            createdAt: '2026-08-13T13:30:00Z',
          },
        },
      },
      {
        id: 9100405, conversationId, sender: self,
        content: 'Yes, from here.', createdAt: '2026-08-13T13:12:00Z', editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [],
      },
      // #2884: four cards in a row and nothing said between them — the run
      // the transcript draws as its first card and "… 3 more".
      ...[
        [9100406, 3327, 'Platform Messages'],
        [9100407, 3328, 'Collapse runs of cards in a channel'],
        [9100408, 3329, 'One outline on the message box'],
        [9100409, 3330, 'Messages at the list’s reading size'],
      ].map(([id, sessionId, title], index) => ({
        id, conversationId, sender: lin, content: '',
        createdAt: `2026-08-13T13:${String(14 + index).padStart(2, '0')}:00Z`, editedAt: null,
        reply: null, reactions: [], attachments: [], objects: [{
          type: 'proposal', appId: 1, appSlug: 'usernode', available: true,
          sessionId, title, subtitle: 'Homeroom', state: 'active',
          author: 'lin', href: `#app/usernode/dev/proposals/${sessionId}`,
        }],
      })),
    ];
  }
  return [];
}

// Every demo message wears the full #2387 shape, so a client never has to
// guess at a missing `deleted` or `thread`.
function demoShape(message) {
  return { deleted: false, threadRootId: null, thread: null, ...message };
}

function demoMessages(user, conversationId) {
  return demoMessagesRaw(user, conversationId).map(demoShape);
}

// Persisted thread recipe under #general's "Anyone else trying the new
// #general room?" (9100404) — three replies from two people, the viewer's own
// in the middle so the thread shows both sides of a conversation. They land
// after the run of cards, so ids and times agree and the main stream draws
// them as ONE card of consecutive replies (the follow-up's merged line).
function demoThreadReplies(user, conversationId) {
  if (conversationId !== 910004) return [];
  const self = demoUser(user.id, user.username || 'you');
  const ada = DEMO_ADA;
  const lin = DEMO_LIN;
  const threadRoot = { id: 9100404, senderUsername: lin.username, content: 'Anyone else trying the new #general room?', deleted: false };
  const reply = (id, sender, content, createdAt) => demoShape({
    id, conversationId, sender, content, createdAt, editedAt: null,
    reply: null, reactions: [], attachments: [], objects: [], threadRootId: 9100404, threadRoot,
  });
  return [
    reply(9100411, ada, 'Yes! Threads keep the room readable.', '2026-08-13T13:21:00Z'),
    reply(9100412, lin, 'Replying here instead of in the room.', '2026-08-13T13:23:00Z'),
    reply(9100413, ada, 'And the room stays quiet while we talk.', '2026-08-13T13:30:00Z'),
  ];
}

// The main stream as the real one reads it since the #2387 follow-up: the
// conversation's messages and its threads' replies, in the order they landed.
function demoMainStream(user, conversationId) {
  return [...demoMessages(user, conversationId), ...demoThreadReplies(user, conversationId)]
    .sort((a, b) => a.id - b.id);
}

async function seedMessages(db, user, recipe, conversationId) {
  const existing = await db.query(
    "SELECT id, idempotency_key FROM conversation_messages WHERE conversation_id = $1 AND idempotency_key LIKE 'staging-inbox-%'",
    [conversationId]);
  const messageIds = new Map(existing.rows.map(row => [Number(row.idempotency_key.slice('staging-inbox-'.length)), row.id]));
  for (const message of demoMainStream(user, recipe.id)) {
    if (recipe.kind === 'channel' && message.sender.id === user.id) continue;
    const result = await db.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, idempotency_key, created_at, edited_at, reply_to_id, thread_root_id, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (conversation_id, sender_id, idempotency_key)
         WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [conversationId, message.sender.id, message.content, `staging-inbox-${message.id}`,
        message.createdAt, message.editedAt, messageIds.get(message.reply?.id) || null,
        messageIds.get(message.threadRootId) || null, message.deleted ? message.createdAt : null]);
    if (!result.rows[0]) continue;
    const messageId = result.rows[0].id;
    messageIds.set(message.id, messageId);
    for (const attachment of message.attachments) {
      const data = attachment.kind === 'image' ? DEMO_SCREENSHOT_PNG
        : Buffer.from('# Launch checklist\n\n- Verify consent states\n- Verify private cards\n');
      await db.query(
        `INSERT INTO conversation_message_attachments
           (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [crypto.randomBytes(16).toString('hex'), conversationId, messageId, message.sender.id,
          attachment.kind, attachment.name, attachment.contentType, data.length, data]);
    }
    if (message.saved) await db.query(
      'INSERT INTO conversation_message_bookmarks (user_id, message_id) VALUES ($1, $2)', [user.id, messageId]);
    for (const reaction of message.reactions) {
      // Every displayed reaction belongs to an actual member.
      for (const actor of [DEMO_ADA, DEMO_LIN]) {
        await db.query(
          'INSERT INTO conversation_message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
          [messageId, actor.id, reaction.emoji]);
        if (recipe.kind === 'direct') break;
      }
    }
    // Old cards claimed nonexistent proposals/specs/issues were available.
    // Share only the real platform app; retained examples of missing
    // objects go through the ordinary unavailable-card serializer.
    for (const [position, object] of message.objects.entries()) {
      const app = object.type === 'app' || (recipe.kind === 'channel' && message.id >= 9100406 && message.id <= 9100409)
        ? (await db.query('SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1')).rows[0] : null;
      const type = app ? 'app' : { proposal: 'code_proposal', governance: 'governance_proposal', issue: 'github_issue' }[object.type] || object.type;
      await db.query(
        `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref, object_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, position, type, app?.id || null, app?.id || 1, type === 'spec' ? 1 : null]);
    }
  }
}

// Proposal checks share one persistent capture-admin account. The routed demo
// threads below are supposed to become read when opened, so none can also be
// the durable unread fixture for list/badge checks. Give that test identity a
// real group and a real incoming message whose dynamic id is never published
// as a check route. The ordinary serializer then computes unreadCount from the
// untouched membership cursor. The per-user advisory lock held by the caller,
// plus the idempotency key, keeps this bounded to one conversation/message.
// An existing membership is recognized in any status, so leaving/removal does
// not make reconciliation create a replacement room.
async function ensureUnreadCheckFixture(db, user) {
  if (user?.username !== CAPTURE_ADMIN_USERNAME) return null;
  const existing = await db.query(
    `SELECT m.conversation_id
       FROM conversation_messages m
       JOIN conversation_members viewer
         ON viewer.conversation_id = m.conversation_id
        AND viewer.user_id = $3
      WHERE m.sender_id = $1
        AND m.idempotency_key = $2
      LIMIT 1`,
    [DEMO_ADA.id, UNREAD_CHECK_KEY, user.id]
  );
  if (existing.rows[0]) return existing.rows[0].conversation_id;

  const conversationId = (await db.query(
    `INSERT INTO conversations (kind, title, created_by, created_at, updated_at)
     VALUES ('group', $1, $2, '2026-08-13T13:35:00Z', '2026-08-13T13:35:00Z')
     RETURNING id`,
    [UNREAD_CHECK_TITLE, DEMO_ADA.id]
  )).rows[0].id;
  await db.query(
    `INSERT INTO conversation_members
       (conversation_id, user_id, role, status, invited_by, joined_at, responded_at)
     VALUES ($1, $2, 'owner', 'member', NULL, NOW(), NOW()),
            ($1, $3, 'member', 'member', $2, NOW(), NOW())`,
    [conversationId, DEMO_ADA.id, user.id]
  );
  await db.query(
    `INSERT INTO conversation_messages
       (conversation_id, sender_id, content, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, '2026-08-13T13:35:00Z')`,
    [conversationId, DEMO_ADA.id,
      'The inbox checks can use this unread preview message.', UNREAD_CHECK_KEY]
  );
  return conversationId;
}

// Serial IDs are allocated by PostgreSQL. Never assign the same private
// conversation to several viewers just to preserve a screenshot's address.
async function ensureFixtures(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return new Map();
  return conversations.transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(4781, $1)', [user.id]);
    // The four conversations of this recipe; #3624's bot DM (BOT_DM_LEGACY_ID)
    // is its own fixture, below.
    const existing = await db.query(
      'SELECT legacy_id, conversation_id FROM staging_conversation_fixtures WHERE user_id = $1 AND legacy_id <= 910004', [user.id]);
    const ids = new Map(existing.rows.map(row => [row.legacy_id, row.conversation_id]));
    let complete = false;
    if (ids.size === 4) {
      const probe = await db.query(
        `SELECT COUNT(*)::int AS count FROM conversation_messages
          WHERE (conversation_id = $1 AND idempotency_key = 'staging-inbox-9100202')
             OR (conversation_id = $2 AND idempotency_key = 'staging-inbox-9100413')`,
        [ids.get(910002), ids.get(910004)]);
      complete = probe.rows[0].count === 2;
    }
    if (complete && user.username !== CAPTURE_ADMIN_USERNAME) return ids;
    const actors = await db.query(
      `SELECT id, username FROM users WHERE id = ANY($1::int[])
        AND password = 'staging-demo-not-a-login'`, [[DEMO_ADA.id, DEMO_LIN.id]]);
    if (![DEMO_ADA, DEMO_LIN].every(actor => actors.rows.some(row => row.id === actor.id && row.username === actor.username))) {
      throw new Error('Staging message fixture accounts are missing or conflict with existing users');
    }
    await ensureUnreadCheckFixture(db, user);
    if (complete) return ids;
    for (const recipe of demoConversations(user)) {
      if (ids.has(recipe.id)) {
        await seedMessages(db, user, recipe, ids.get(recipe.id));
        continue;
      }
      let conversationId;
      let seed = true;
      if (recipe.kind === 'channel') {
        // One genuine public channel; no viewer-authored sample messages in it.
        await db.query('SELECT pg_advisory_xact_lock(4781, 0)');
        const room = await db.query("SELECT id FROM conversations WHERE channel_key = 'general' AND kind = 'channel'");
        if (!room.rows[0]) throw new Error('Staging general channel is missing');
        conversationId = room.rows[0].id;
      } else if (recipe.kind === 'direct') {
        const pair = await conversations.lockPair(db, user.id, DEMO_ADA.id);
        const prior = await db.query(
          'SELECT conversation_id FROM conversation_direct_pairs WHERE user_low_id = $1 AND user_high_id = $2', pair);
        conversationId = prior.rows[0]?.conversation_id;
        seed = !conversationId;
        if (!conversationId) {
          conversationId = (await db.query(
            "INSERT INTO conversations (kind, created_by, created_at, updated_at) VALUES ('direct', $1, $2, $3) RETURNING id",
            [DEMO_ADA.id, '2024-11-02T08:40:00Z', recipe.lastActivityAt])).rows[0].id;
          await db.query(
            'INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
            [conversationId, ...pair]);
        }
      } else {
        conversationId = (await db.query(
          "INSERT INTO conversations (kind, title, created_by, created_at, updated_at) VALUES ('group', $1, $2, $3, $3) RETURNING id",
          [recipe.title, recipe.membershipStatus === 'invited' ? DEMO_LIN.id : user.id, recipe.lastActivityAt])).rows[0].id;
      }
      if (seed) {
        const members = recipe.kind === 'channel'
          ? [DEMO_ADA, DEMO_LIN, user].map(actor => ({ ...actor, role: 'member', status: 'member' }))
          : recipe.membershipStatus === 'invited'
            ? [{ ...DEMO_LIN, role: 'owner', status: 'member' }, { ...DEMO_ADA, role: 'member', status: 'member' },
              { ...user, role: 'member', status: 'invited' }]
            : recipe.members;
        for (const member of members) {
          await db.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role, status, invited_by, joined_at, responded_at)
             VALUES ($1, $2, $3, $4::varchar, $5, CASE WHEN $4::varchar = 'member' THEN NOW() END, CASE WHEN $4::varchar = 'member' THEN NOW() END)
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, member.id, member.role, member.status, recipe.requester?.id || DEMO_ADA.id]);
        }
        await seedMessages(db, user, recipe, conversationId);
      }
      await db.query(
        'INSERT INTO staging_conversation_fixtures (user_id, legacy_id, conversation_id) VALUES ($1, $2, $3)',
        [user.id, recipe.id, conversationId]);
      ids.set(recipe.id, conversationId);
    }
    return ids;
  });
}

// #3624: the Homeroom bot's DM, with one question still open, so a staging
// preview shows the suggested answers and the line saying an answer is
// public. The bot never acts on staging (homeroom-bot-live.js isLiveFor), so
// nothing would put a question there otherwise. Obviously fake (a
// "Staging demo" project and request), never registered as a question the
// bot is waiting on: an answer tapped here gets the bot's short help, and
// nothing is posted on any request. The bot's account is the platform's own
// synthetic user, created here as a bare row when a fresh staging database
// has none.
const BOT_DM_LEGACY_ID = 910005;
const BOT_DM_QUESTION_KEY = 'staging-hrbot-question';
const BOT_DM_OFFER_KEY = 'staging-hrbot-offer';
// B3: the action id the demo offer's buttons name. No homeroom_bot_dm_actions
// row stands behind it: the action endpoint answers the demo without one.
const BOT_DM_DEMO_ACTION_ID = 990001;
const BOT_DM_ASK_KEY = 'staging-hrbot-ask';

async function ensureBotDmFixture(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return null;
  await pool.query(
    `INSERT INTO users (username, password, is_synthetic)
     VALUES ('homeroom_bot', 'staging-demo-not-a-login', TRUE)
     ON CONFLICT DO NOTHING`
  );
  const bot = (await pool.query(
    `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE`
  )).rows[0];
  if (!bot || bot.id === user.id) return null;
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, user.id);
  if (!opened) return null;
  await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
    content: '**Staging demo app** · request #12: Staging demo, sort the list by date\n\n'
      + 'I have a question before I build this:\n\nShould the newest items show first, or the oldest?',
    idempotency_key: BOT_DM_QUESTION_KEY,
  }, {
    metadata: {
      homeroomBot: {
        kind: 'question', appName: 'Staging demo app', issueNumber: 12,
        issueTitle: 'Staging demo, sort the list by date', mirrors: true, status: 'open',
        question: 'Should the newest items show first, or the oldest?',
        answers: ['Newest first', 'Oldest first', 'Let me pick each time'],
      },
    },
  });
  // #3624 stage 2: and a request it offers to file, with File it / Not now.
  // A demo: no project stands behind it, so a tap files nothing here.
  // #3707: the offer answers the viewer's ask and quotes it, as the bot's
  // answers do. A fixture whose offer is already there is left as it was,
  // rather than given an ask after its answer.
  const offered = await pool.query(
    `SELECT 1 FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
    [opened.conversationId, bot.id, BOT_DM_OFFER_KEY]
  );
  if (!offered.rows.length) {
    const ask = await conversations.sendMessage(pool, user, opened.conversationId, {
      content: 'Staging demo: could you add a dark mode to the list?',
      idempotency_key: BOT_DM_ASK_KEY,
    });
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: 'Here is the request I\'d file for you.\n\n**Staging demo app** · new request: Staging demo, add a dark mode\n\n'
        + 'Staging demo: a dark mode for the list, switched on from the settings screen.',
      idempotency_key: BOT_DM_OFFER_KEY,
      ...(ask?.messageId ? { reply_to_id: ask.messageId } : {}),
    }, {
      metadata: {
        homeroomBot: {
          kind: 'confirm', appName: 'Staging demo app', status: 'open', mirrors: false,
          question: 'File this as a request on Staging demo app?',
          answers: ['File it', 'Not now'],
          // B3: its buttons, as a live offer carries them (homeroom-bot-mayor.js
          // offerActions). The demo's action endpoint decides nothing.
          actionId: BOT_DM_DEMO_ACTION_ID,
          actions: [
            { id: 'yes', label: 'File it', style: 'primary', type: 'server' },
            { id: 'no', label: 'Not now', style: 'secondary', type: 'server' },
          ],
        },
      },
    });
  }
  // #3736: and two activity cards, each the bot's work on a request followed
  // in place: one that ended in a proposal, and one being built now, the
  // newest. Their state is homeroom-bot-activity.js demoCards', found by
  // these keys; no project stands behind them, so they open nothing.
  const cardKeys = require('./homeroom-bot-activity').DEMO_CARD_KEYS;
  const sentCards = await pool.query(
    `SELECT idempotency_key FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = ANY($3::text[])`,
    [opened.conversationId, bot.id, [cardKeys.done, cardKeys.working]]
  );
  const sentKeys = new Set(sentCards.rows.map((row) => row.idempotency_key));
  for (const card of [
    { key: cardKeys.done, issueNumber: 9, issueTitle: 'Staging demo, show item counts' },
    { key: cardKeys.working, issueNumber: 14, issueTitle: 'Staging demo, show a total under the list' },
  ].filter((c) => !sentKeys.has(c.key))) {
    await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, {
      content: `**Staging demo app** · request #${card.issueNumber}: ${card.issueTitle}\n\n`
        + 'I\'m working on this now. This card updates as I go.',
      idempotency_key: card.key,
    }, {
      metadata: {
        homeroomBot: {
          kind: 'activity', appName: 'Staging demo app', issueNumber: card.issueNumber,
          issueTitle: card.issueTitle, mirrors: true,
        },
      },
    });
  }
  await pool.query(
    `INSERT INTO staging_conversation_fixtures (user_id, legacy_id, conversation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, legacy_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
    [user.id, BOT_DM_LEGACY_ID, opened.conversationId]
  );
  return opened.conversationId;
}

// The demo of a card joining work already under way: what opening the bot's
// DM does on a live copy (homeroom-bot-activity.js catchUpCards), which a
// staging copy cannot, since the bot never works there. Opening the demo DM
// gives the demo's request #15, whose plan was begun before it had a card,
// its card at the end of the transcript, once. Like the fixture's other
// cards it stands for no request: nothing is recorded or posted, and
// demoCards says how far along it is. Only in the viewer's own fixture, and
// only once the fixture is there. Resolves { added }.
async function ensureDemoUnderWayCard(pool, user) {
  if (process.env.USERNODE_ENV !== 'staging' || !user?.id) return { added: 0 };
  const { rows: [fixture] } = await pool.query(
    `SELECT f.conversation_id, b.id AS bot_id
       FROM staging_conversation_fixtures f
       JOIN users b ON b.username = 'homeroom_bot' AND b.is_synthetic = TRUE
       JOIN conversation_members cm ON cm.conversation_id = f.conversation_id AND cm.user_id = b.id
      WHERE f.user_id = $1 AND f.legacy_id = $2`,
    [user.id, BOT_DM_LEGACY_ID]
  );
  if (!fixture) return { added: 0 };
  const activity = require('./homeroom-bot-activity');
  const { issueNumber, issueTitle, startedMinutesAgo } = activity.DEMO_UNDER_WAY;
  const startedAt = new Date(Date.now() - startedMinutesAgo * 60 * 1000).toISOString();
  const sent = await conversations.sendMessage(pool, { id: fixture.bot_id }, fixture.conversation_id, {
    content: activity.cardText({ appName: 'Staging demo app', issueNumber, issueTitle, firstVersion: false },
      require('./homeroom-bot-dm'), { joined: true }),
    idempotency_key: activity.DEMO_CARD_KEYS.underWay,
  }, {
    metadata: {
      homeroomBot: {
        kind: 'activity', appName: 'Staging demo app', issueNumber, issueTitle, mirrors: true, startedAt,
      },
    },
  });
  return { added: sent?.messageId && !sent.duplicate ? 1 : 0 };
}

async function resolveLegacyLink(pool, user, id) {
  if (process.env.USERNODE_ENV !== 'staging' || id < 910001 || id > BOT_DM_LEGACY_ID) return id;
  // A real accessible ID always wins over a historical display-only address.
  if (await conversations.loadMembership(pool, id, user.id, { allowInvited: true })) return id;
  if (id === BOT_DM_LEGACY_ID) return (await ensureBotDmFixture(pool, user)) || id;
  const ids = await ensureFixtures(pool, user);
  return ids.get(id) || id;
}

async function resolveLegacyMessageLink(pool, user, conversationId, id) {
  if (process.env.USERNODE_ENV !== 'staging' || !Number.isInteger(id)
      || ![9100100, 9100101, 9100102, 9100103, 9100201, 9100202,
        9100401, 9100402, 9100403, 9100404, 9100405, 9100406, 9100407,
        9100408, 9100409, 9100411, 9100412, 9100413].includes(id)) return id;
  const actual = await pool.query(
    'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND id = $2', [conversationId, id]);
  if (actual.rows[0]) return id;
  const stored = await pool.query(
    `SELECT id FROM conversation_messages WHERE conversation_id = $1 AND idempotency_key = $2
      AND sender_id = ANY($3::int[])`,
    [conversationId, `staging-inbox-${id}`, [user.id, DEMO_ADA.id, DEMO_LIN.id]]);
  return stored.rows[0]?.id || id;
}

module.exports = {
  ensureFixtures, ensureBotDmFixture, ensureDemoUnderWayCard, resolveLegacyLink, resolveLegacyMessageLink,
  demoConversations, demoMessages, BOT_DM_LEGACY_ID,
};
