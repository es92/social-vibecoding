'use strict';

// #4239: moving a request about Homeroom itself to Homeroom's own board.
//
// People file problems with the platform (its header, its suggestion form, a
// project's description or invite message) on a project's board, where no
// change to the project can fix them. The triage says so (its `platform`
// flag on a person verdict, stored on the run as about_platform) and the
// DM's chat model can say so too (offer_move_request). Either way the
// requester is offered a move, decided by a tap like any offer:
//
//   Move it to Homeroom  files the request on Homeroom's board with its
//                        original title and words and a footer naming where
//                        it came from and who first asked, credited to its
//                        author; leaves a link on the original; and closes
//                        the original. Closed at once ONLY when the person
//                        tapping filed it and nobody else has taken part in
//                        it (no comments, votes, claims, kudos or
//                        proposals); otherwise the original's group votes on
//                        closing it (a close_issue proposal), so nothing
//                        somebody else is involved in closes without a vote.
//   Keep it here         leaves everything as it is.

const log = require('./logger');

const MAX_TITLE_CHARS = 200;
// GitHub's own limit on an issue's body, less room for the footer.
const MAX_BODY_CHARS = 60000;
// What a close proposal's reason may hold (routes/issues.js).
const MAX_CLOSE_REASON_CHARS = 2000;

function clip(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function mayorModule() { return require('./homeroom-bot-mayor'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function dmModule(deps) { return deps.dmSvc || require('./homeroom-bot-dm'); }

function repoOf(app) {
  const m = String(app?.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function domainOf(deps) {
  return deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
}

/** Pure: a request's page on Homeroom. */
function requestLink(domain, appSlug, issueNumber) {
  return `https://${domain}/#app/${encodeURIComponent(appSlug)}/dev/issues/${Number(issueNumber)}`;
}

/** Homeroom's own project, where a request about the platform belongs, or null. */
async function platformApp(pool, deps = {}) {
  return mayorModule().findApp(pool, botModule(deps).PLATFORM_SELF_APP_SLUG);
}

/** Whether `app` is Homeroom's own project (or another on its repository). */
async function isPlatformApp(pool, app, deps = {}) {
  const slugs = await botModule(deps).platformAppSlugs(pool);
  return slugs.includes(app.slug);
}

/** A project by id, with the columns the access checks read. */
async function appById(pool, appId) {
  const { rows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [appId]);
  return rows[0] ? mayorModule().findApp(pool, rows[0].slug) : null;
}

/**
 * Pure: the footer of the request a move files, naming where it came from
 * and who first asked. A private project is not named on Homeroom's public
 * board, nor linked.
 */
function movedFooter({ app, issueNumber, link, author }) {
  const who = author ? `, first asked by @${author}` : '';
  if (app.view_visibility && app.view_visibility !== 'public') return `Moved from a private project's request #${issueNumber}${who}.`;
  return `Moved from ${app.name || app.slug} #${issueNumber} (${link})${who}.`;
}

/**
 * The request a move is about, read fresh: an open issue (not a pull
 * request) on a project that is not Homeroom's own, which this person asked
 * for (homeroom_bot_requesters) or filed, or whose project they run (its
 * creator or an admin: app-admins.js canManageApp). Resolves { ok: true, app, repo,
 * issue: { title, body, login }, author: { userId, username } | null } or
 * { ok: false, code, error }.
 */
async function moveGate(pool, { app, issueNumber, user, deps = {} }) {
  const github = deps.github || require('./github');
  const n = Number(issueNumber);
  if (!app || !Number.isInteger(n) || n <= 0) return { ok: false, code: 'not_found', error: 'There is no such request.' };
  if (await isPlatformApp(pool, app, deps)) {
    return { ok: false, code: 'already_there', error: 'It is already on Homeroom\'s own board.' };
  }
  const repo = repoOf(app);
  if (!repo || !github.isEnabled()) return { ok: false, code: 'unreadable', error: 'Its request cannot be read right now.' };
  let raw;
  try {
    raw = await github.getIssue(repo.owner, repo.repo, n);
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not read a request to move', { app: app.slug, issueNumber: n, err: err.message });
    return { ok: false, code: 'unreadable', error: 'Its request cannot be read right now.' };
  }
  if (!raw || raw.pull_request) return { ok: false, code: 'not_found', error: 'There is no such request.' };
  if (raw.state !== 'open') return { ok: false, code: 'closed', error: 'That request is already closed.' };
  const issue = { title: String(raw.title || '').trim(), body: String(raw.body || ''), login: raw.user?.login || null };
  const poster = await require('./homeroom-bot-live').issuePoster(pool, { app, repo, issueNumber: n, issue: { body: issue.body, user: issue.login } })
    .catch(() => null);
  let author = null;
  if (poster) {
    const { rows } = await pool.query('SELECT id, username FROM users WHERE username = $1', [poster]);
    if (rows[0]) author = { userId: Number(rows[0].id), username: rows[0].username };
  }
  const { rows: asked } = await pool.query(
    'SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2 AND user_id = $3',
    [app.id, n, user.id],
  );
  // The project's creator and admins may move it too: HOMESTEAD #33 and #35
  // stayed on its board because only their requester could, and never did.
  if (!asked.length && author?.userId !== Number(user.id) && !(await require('./app-admins').canManageApp(pool, app, user))) {
    return { ok: false, code: 'not_theirs', error: 'Only the person who filed it or asked for it, or the project\'s creator or admins, can move it.' };
  }
  return { ok: true, app, repo, issueNumber: n, issue, author };
}

/**
 * Who besides its author has taken part in a request, as short plain
 * reasons: empty when nobody has. Anything that cannot be read counts as
 * somebody, so a doubt always goes to a vote rather than a close.
 */
async function othersInvolved(pool, { app, repo, issueNumber, authorId, authorLogin = null, bot = null, deps = {} }) {
  const github = deps.github || require('./github');
  const n = Number(issueNumber);
  const author = authorId == null ? null : Number(authorId);
  const reasons = [];
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM chat_messages
         WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2 AND msg_type = 'message'
           AND deleted_at IS NULL AND user_id IS NOT NULL AND user_id IS DISTINCT FROM $3::int
           AND user_id IS DISTINCT FROM $4::int) AS comments,
       (SELECT COUNT(*)::int FROM issue_votes v JOIN issues i ON i.id = v.issue_id
         WHERE i.app_id = $1 AND i.github_issue_number = $2 AND v.user_id IS DISTINCT FROM $3::int)
       + (SELECT COUNT(*)::int FROM topic_attribute_votes
           WHERE app_id = $1 AND target_type = 'issue' AND target_ref = $2 AND user_id IS DISTINCT FROM $3::int) AS votes,
       (SELECT COUNT(*)::int FROM issue_claims
         WHERE app_id = $1 AND github_issue_number = $2 AND user_id IS DISTINCT FROM $3::int) AS claims,
       (SELECT COUNT(*)::int FROM issue_bounties
         WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'
           AND giver_user_id IS DISTINCT FROM $3::int) AS kudos,
       (SELECT COUNT(*)::int FROM chat_sessions WHERE app_id = $1 AND $2 = ANY(linked_issues)) AS proposals,
       (SELECT COUNT(*)::int FROM issues
         WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
           AND (payload->>'issueNumber')::int = $2 AND created_by IS DISTINCT FROM $3::int) AS closing`,
    [app.id, n, author, bot?.id == null ? null : Number(bot.id)],
  );
  if (counts.comments) reasons.push('others wrote in its discussion');
  if (counts.votes) reasons.push('others voted on it');
  if (counts.claims) reasons.push('somebody else claimed it');
  if (counts.kudos) reasons.push('somebody put kudos on it');
  if (counts.proposals) reasons.push('a proposal is linked to it');
  if (counts.closing) reasons.push('somebody already proposed closing it');
  // Its comments on GitHub, less the bot's own posts and the platform's
  // accounts (homeroom-bot-live.js isOtherBotLogin's rule).
  let read;
  try {
    read = await github.fetchIssueComments(repo.owner, repo.repo, n);
  } catch {
    read = { comments: [], note: 'fetch failed' };
  }
  if (read?.note) {
    reasons.push('its comments could not be read');
  } else {
    const { rows: own } = await pool.query(
      'SELECT github_comment_id FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = $2 AND github_comment_id IS NOT NULL',
      [app.id, n],
    );
    const ownIds = new Set(own.map((r) => String(r.github_comment_id)));
    const logins = new Set([authorLogin].filter(Boolean).map((l) => String(l).toLowerCase()));
    if (author != null) {
      const { rows: linked } = await pool.query('SELECT github_login FROM users WHERE id = $1', [author]);
      if (linked[0]?.github_login) logins.add(String(linked[0].github_login).toLowerCase());
    }
    const others = (read.comments || []).filter((c) => {
      if (c.id != null && ownIds.has(String(c.id))) return false;
      const login = String(c.author || '').toLowerCase();
      if (!login || login.endsWith('[bot]') || login === 'usernode-bot') return false;
      return !logins.has(login);
    });
    if (others.length) reasons.push('others commented on it');
  }
  return reasons;
}

/**
 * Open a vote on closing request `issueNumber` of `app`, proposed by
 * `user`, as the request page's "Propose to close" does (routes/issues.js
 * POST /api/apps/:slug/issues, kind close_issue). Resolves { ok, id } or
 * { ok: false, code } (already_proposed, join_required).
 */
async function proposeClose(pool, { app, user, issueNumber, issueTitle, reason, deps = {} }) {
  const ws = deps.ws || require('./ws');
  const n = Number(issueNumber);
  const { rows: open } = await pool.query(
    `SELECT id FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open' AND (payload->>'issueNumber')::int = $2`,
    [app.id, n],
  );
  if (open.length) return { ok: false, code: 'already_proposed', id: Number(open[0].id) };
  if (!(await mayorModule().canFile(pool, app, user))) return { ok: false, code: 'join_required' };
  const title = clip(String(issueTitle || ''), 300);
  const payload = { issueNumber: n, issueTitle: title, reason: clip(reason, MAX_CLOSE_REASON_CHARS) || null };
  const { rows: [row] } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, NULL, $2, $3, 'close_issue', $4, $5) RETURNING id`,
    [app.id, `Close issue #${n}: "${title}"`.slice(0, 512), payload.reason, JSON.stringify(payload), user.id],
  );
  const id = Number(row.id);
  const said = `${user.username} proposed closing issue #${n}: "${title}"`;
  await ws.sendSystemMessage(pool, app.id, said, 'system', null, { type: 'governance', ref: id }).catch(() => {});
  await ws.sendSystemMessage(pool, app.id, said, 'system', null, { type: 'issue', ref: n }).catch(() => {});
  try {
    const workflow = deps.workflow || require('../workflow/platform.ts');
    if (workflow.governsKind('close_issue')) await workflow.fileProposal(id, app.id);
  } catch (err) {
    // The next vote, or the boot backfill, files it (routes/issues.js).
    log.warn('homeroom-bot-move', 'Filing the close proposal failed', { issueId: id, err: err.message });
  }
  ws.pushIssueUpdate?.({ action: 'created', appSlug: app.slug, appId: app.id, issueId: id, kind: 'close_issue' });
  return { ok: true, id };
}

/**
 * Close request `issueNumber` of `app` at once, for its author, when nobody
 * else is involved. Resolves { ok }.
 */
async function closeNow(pool, { app, repo, issueNumber, user, newNumber, deps = {} }) {
  const github = deps.github || require('./github');
  const ws = deps.ws || require('./ws');
  const n = Number(issueNumber);
  try {
    await github.closeIssue(repo.owner, repo.repo, n);
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not close a moved request', { app: app.slug, issueNumber: n, err: err.message });
    return { ok: false };
  }
  await pool.query(
    `UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
    [app.id, n],
  ).catch(() => {});
  await ws.sendSystemMessage(pool, app.id, `${user.username} moved this request to Homeroom as #${newNumber} and closed it here`,
    'system', null, { type: 'issue', ref: n }).catch(() => {});
  try {
    github.noteIssuesClosed?.(repo.owner, repo.repo, [n]);
    github.invalidateIssuesCache?.(repo.owner, repo.repo);
    ws.pushIssueUpdate?.({ action: 'github_synced', appSlug: app.slug, appId: app.id, source: 'moved' });
  } catch {}
  return { ok: true };
}

/** Pure: what the person hears about the original, once the move is filed. */
function closedWords({ how, appName, reasons = [], author }) {
  switch (how) {
    case 'closed': return `I closed the original on ${appName}, since nobody else had joined in on it.`;
    case 'vote': {
      const why = !author ? 'you didn\'t file it' : reasons.length ? reasons[0] : 'others are involved in it';
      return `The original on ${appName} stays open until its group votes on closing it, because ${why}.`;
    }
    case 'already_proposed': return `A vote on closing the original on ${appName} is already open.`;
    default: return `The original on ${appName} is still open: I couldn't close it or start a vote on closing it.`;
  }
}

/**
 * A tap under a move offer (homeroom-bot-mayor.js settleOffer). Move it to
 * Homeroom files it there, links it from the original and closes the
 * original, directly or by a vote. `ack` sends the answer. Resolves what
 * was sent.
 */
async function decideMove(pool, config, { bot = null, user, settings, action, yes, ack, deps = {} }) {
  if (!yes) return ack('OK, I\'ll leave it where it is.');
  const github = deps.github || require('./github');
  const mayor = mayorModule();
  const failed = async (error, text) => {
    await pool.query('UPDATE homeroom_bot_dm_actions SET status = \'failed\', error = $2 WHERE id = $1', [action.id, clip(error, 300)]);
    return ack(text);
  };
  const app = await appById(pool, action.app_id);
  const gate = await moveGate(pool, { app, issueNumber: action.source_issue_number, user, deps });
  if (!gate.ok) return failed(gate.code, `I couldn't move it: ${gate.error}`);
  const target = await platformApp(pool, deps);
  if (!target) return failed('no_platform', 'I couldn\'t move it: Homeroom\'s own board isn\'t available right now.');
  if (!(await mayor.canFile(pool, target, user))) {
    return failed('not_allowed', 'I couldn\'t move it: you need to join Homeroom\'s own community first. You can join it from its page.');
  }
  const appName = app.name || app.slug;
  const n = gate.issueNumber;
  const domain = domainOf(deps);
  // Its GitHub author when nobody on Homeroom filed it: never the
  // platform's own account, which files for everybody.
  const login = /\[bot\]$|^usernode-bot$/i.test(String(gate.issue.login || '')) ? null : gate.issue.login;
  const author = gate.author?.username || login || null;
  // Credited to whoever first asked, when they are on Homeroom.
  const credited = gate.author ? { id: gate.author.userId, username: gate.author.username } : user;
  let filed;
  try {
    filed = await mayor.fileRequest(pool, config, {
      user: credited, app: target, settings, deps,
      title: clip(gate.issue.title || action.title, MAX_TITLE_CHARS),
      details: clip(gate.issue.body, MAX_BODY_CHARS),
      askedText: gate.issue.title || action.title,
      footer: movedFooter({ app, issueNumber: n, link: requestLink(domain, app.slug, n), author }),
      reason: 'moved_request',
    });
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not file a moved request', { app: app.slug, issueNumber: n, err: err.message });
    return failed(err.message, 'I couldn\'t move it just now. Try again in a minute.');
  }
  await pool.query('UPDATE homeroom_bot_dm_actions SET issue_number = $2 WHERE id = $1', [action.id, filed.issueNumber]);
  const newLink = requestLink(domain, target.slug, filed.issueNumber);
  try {
    await github.createIssueComment(gate.repo.owner, gate.repo.repo, n,
      `Moved to Homeroom's own board as request #${filed.issueNumber}: ${newLink}\n\n`
      + `It is about the Homeroom platform itself rather than ${appName}, so it is followed up there.`);
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not link a moved request from the original', { app: app.slug, issueNumber: n, err: err.message });
  }
  // Closed at once only for its author when nobody else is in it; otherwise
  // its group decides.
  const mine = gate.author?.userId === Number(user.id);
  const reasons = mine
    ? await othersInvolved(pool, {
      app, repo: gate.repo, issueNumber: n, authorId: gate.author.userId, authorLogin: gate.issue.login, bot, deps,
    })
    : [];
  let how;
  if (mine && !reasons.length) {
    how = (await closeNow(pool, { app, repo: gate.repo, issueNumber: n, user, newNumber: filed.issueNumber, deps })).ok ? 'closed' : 'failed';
  }
  if (!how || how === 'failed') {
    const proposed = await proposeClose(pool, {
      app, user, issueNumber: n, issueTitle: gate.issue.title,
      reason: `Moved to Homeroom's own board as request #${filed.issueNumber} (${newLink}): it is about the Homeroom platform itself, not ${appName}.`,
      deps,
    }).catch((err) => {
      log.warn('homeroom-bot-move', 'Could not propose closing a moved request', { app: app.slug, issueNumber: n, err: err.message });
      return { ok: false, code: 'error' };
    });
    how = proposed.ok ? 'vote' : proposed.code === 'already_proposed' ? 'already_proposed' : 'failed';
  }
  log.info('homeroom-bot-move', 'Moved a request to Homeroom', {
    app: app.slug, issueNumber: n, movedTo: filed.issueNumber, original: how, userId: user.id,
  });
  const line = dmModule(deps).requestLine({ appName: target.name || target.slug, issueNumber: filed.issueNumber, issueTitle: gate.issue.title });
  return ack(
    `${line}\n\nMoved. It's on Homeroom's own board now, with a link to it left on the original. `
      + closedWords({ how, appName, reasons, author: mine }),
    {
      objects: [{ type: 'issue', appId: Number(target.id), issueNumber: filed.issueNumber }],
      metadata: {
        kind: 'filed', appSlug: target.slug, appName: target.name || target.slug,
        issueNumber: filed.issueNumber, issueTitle: gate.issue.title,
      },
    },
  );
}

/**
 * #4239: after the bot told a requester it left their request because it is
 * about Homeroom itself (homeroom-bot-dm.js relayIssuePost), the offer to
 * move it, under its own buttons. Offered once per request and person.
 * Never throws; resolves what was sent, or null.
 */
async function offerMove(pool, { bot, userId, app, issueNumber, title, reason = null, key = null, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!bot?.id || !userId || !app?.id || !Number.isInteger(n)) return null;
    if (await isPlatformApp(pool, app, deps) || !(await platformApp(pool, deps))) return null;
    const { rows: before } = await pool.query(
      `SELECT 1 FROM homeroom_bot_dm_actions
        WHERE user_id = $1 AND app_id = $2 AND kind = 'move_request' AND source_issue_number = $3
          AND status IN ('open', 'done')`,
      [userId, app.id, n],
    );
    if (before.length) return null;
    const name = app.name || app.slug;
    const { rows: [action] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title, details, source_issue_number)
       VALUES ($1, $2, 'move_request', $3, $4, $5) RETURNING id`,
      [userId, app.id, clip(title || `Request #${n}`, MAX_TITLE_CHARS), reason ? clip(reason, 600) : null, n],
    );
    const sent = await dmModule(deps).sendDm(pool, {
      bot, userId,
      content: moveOfferText({ name, issueNumber: n }),
      idempotencyKey: key ? `hrbot-move-${key}` : `hrbot-move-${action.id}`,
      metadata: moveOfferMeta({ app, actionId: action.id }),
    });
    if (!sent?.messageId || sent.duplicate) {
      await pool.query('DELETE FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
      return sent || null;
    }
    await pool.query(
      'UPDATE homeroom_bot_dm_actions SET message_id = $2, conversation_id = $3 WHERE id = $1',
      [action.id, sent.messageId, sent.conversationId],
    );
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not offer to move a request', { app: app?.slug, issueNumber, err: err.message });
    return null;
  }
}

/**
 * After the bot told a requester that what they asked for is already there
 * (a triage `done` verdict, homeroom-bot-dm.js relayIssuePost), the offer to
 * open a vote on closing it: the same Propose to close / Keep it open offer
 * the DM chat makes (homeroom-bot-mayor.js offerCloseRequest), so a tap opens
 * the request's own close vote with them as its proposer. Offered once per
 * request and person, and not while a close vote is already open. Never
 * throws; resolves what was sent, or null.
 */
async function offerClose(pool, { bot, userId, app, issueNumber, title, reason = null, key = null, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!bot?.id || !userId || !app?.id || !Number.isInteger(n)) return null;
    const { rows: before } = await pool.query(
      `SELECT 1 FROM homeroom_bot_dm_actions
        WHERE user_id = $1 AND app_id = $2 AND kind = 'close_request' AND source_issue_number = $3
          AND status IN ('open', 'done')
       UNION ALL
       SELECT 1 FROM issues
        WHERE app_id = $2 AND kind = 'close_issue' AND status = 'open' AND (payload->>'issueNumber')::int = $3`,
      [userId, app.id, n],
    );
    if (before.length) return null;
    const name = app.name || app.slug;
    const { rows: [action] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title, details, source_issue_number)
       VALUES ($1, $2, 'close_request', $3, $4, $5) RETURNING id`,
      [userId, app.id, clip(title || `Request #${n}`, MAX_TITLE_CHARS), reason ? clip(reason, 600) : null, n],
    );
    const mayor = mayorModule();
    const sent = await dmModule(deps).sendDm(pool, {
      bot, userId,
      content: mayor.closeOfferText({ name, issueNumber: n, title: title || `Request #${n}` }),
      idempotencyKey: key ? `hrbot-close-${key}` : `hrbot-close-${action.id}`,
      metadata: mayor.closeOfferMeta({ app, name, actionId: action.id, issueNumber: n }),
    });
    if (!sent?.messageId || sent.duplicate) {
      await pool.query('DELETE FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
      return sent || null;
    }
    await pool.query(
      'UPDATE homeroom_bot_dm_actions SET message_id = $2, conversation_id = $3 WHERE id = $1',
      [action.id, sent.messageId, sent.conversationId],
    );
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-move', 'Could not offer to close a request', { app: app?.slug, issueNumber, err: err.message });
    return null;
  }
}

/** Pure: the words of a move offer. */
function moveOfferText({ name, issueNumber, text = null, title = null, why = null }) {
  return [
    text || `Want me to move request #${issueNumber} to Homeroom's own board? The people who work on Homeroom look there.`,
    '',
    `**${name}** · request #${issueNumber}${title ? `: ${clip(title, 140)}` : ''}`,
    ...(why ? ['', `Why: ${clip(why, 600)}`] : []),
    '',
    'If you filed it and nobody else has joined in, I close it here. Otherwise its group votes on closing it.',
  ].join('\n');
}

/** Pure: a move offer's metadata: its question and buttons (homeroom-bot-mayor.js offerActions). */
function moveOfferMeta({ app, actionId }) {
  const name = app.name || app.slug;
  return {
    kind: 'confirm', appSlug: app.slug, appName: name, actionId: Number(actionId),
    question: `Move this request from ${name} to Homeroom's own board?`,
    // `answers` for a client that predates `actions`.
    answers: [...mayorModule().OFFER_ANSWERS.move_request], actions: mayorModule().offerActions('move_request'),
    status: 'open', mirrors: false,
  };
}

module.exports = {
  offerClose,
  requestLink,
  movedFooter,
  moveGate,
  othersInvolved,
  proposeClose,
  closeNow,
  closedWords,
  decideMove,
  offerMove,
  moveOfferText,
  moveOfferMeta,
};
