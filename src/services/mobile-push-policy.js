'use strict';

const crypto = require('crypto');
const { ALLOWED_KINDS } = require('./mobile-push-preferences');

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_CONTEXT = 'usernode-social-push-recipient-v1';
const PUSH_ENV_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isPushEnvironment(value) {
  return typeof value === 'string' && PUSH_ENV_RE.test(value);
}

function recipientBinding({ installationId, userId, environment }) {
  const installation = String(installationId || '').toLowerCase();
  const user = String(userId || '');
  if (!installation || !/^[1-9]\d*$/.test(user) || !environment) {
    throw new Error('mobile_push_recipient_binding_invalid');
  }
  return crypto.createHash('sha256')
    .update([RECIPIENT_CONTEXT, installation, user, environment].join('\n'))
    .digest('hex');
}

// ── Contextual notification copy (#3289) ───────────────────────────────
// The visible title/body are built per kind from send-time context loaded
// by the worker (same joins as the in-app dropdown). The `data` payload
// stays opaque — context feeds ONLY the display strings. Anything missing
// or malformed degrades to the generic copy; copy assembly never throws,
// so a context problem can never kill a delivery.

const TITLE_MAX = 80;
const BODY_MAX = 140;
const EMBED_TITLE_MAX = 60;
// Labels embedded in a TITLE get a tighter cap than body embeds, so the
// actor and the ` · App` suffix survive the final 80-char truncation.
const TITLE_EMBED_MAX = 40;
const GENERIC_COPY = Object.freeze({ title: 'Homeroom', body: 'You have new activity' });

// dev/evan-1786562509265 and friends: a trailing run of digits marks a
// machine-generated branch name, which reads as noise in a push. Such a
// branch never becomes a label; the kind's no-label wording renders instead.
const GENERATED_BRANCH_RE = /\d{6,}$/;

// Push text is plain and single-line: drop control chars, collapse runs of
// whitespace. Returns '' for anything that is not a usable string.
function cleanText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const AUTO_SOLVE_BODIES = Object.freeze({
  spec: 'Spec ready. Review it in the app',
  code: "Code ready. Review and promote when you're happy",
  spec_code: "Spec and code ready. Review and promote when you're happy",
});

function daysSince(value, now) {
  const elapsed = new Date(now).getTime() - new Date(value || NaN).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / (24 * 60 * 60 * 1000));
}

// #1405. Same shape as daysSince, at the grain path B's copy needs: this is a
// nudge measured in minutes, not a proposal going stale over days.
function minutesSince(value, now) {
  const elapsed = new Date(now).getTime() - new Date(value || NaN).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / (60 * 1000));
}

// Kind-specific {title, body}, or null when the kind's essential context is
// missing (e.g. a mention without a sender) — null means the generic copy.
function buildCopy(kind, context, now) {
  const app = cleanText(context.appName);
  const conversation = cleanText(context.conversationTitle);
  const actor = cleanText(context.sourceUsername);
  const message = cleanText(context.messageContent);
  const detail = cleanText(context.detail);
  // #971 preference order, same as the in-app dropdown renderers — except
  // that a machine-generated branch name is worse than no label at all.
  const branch = cleanText(context.branchName);
  const label = cleanText(context.sessionTitle) || cleanText(context.prTitle)
    || (GENERATED_BRANCH_RE.test(branch) ? '' : branch);
  const withApp = (text) => (app ? `${text} · ${app}` : text);
  const withConversation = (text) => (conversation ? `${text} · ${conversation}` : text);
  const quoted = label ? `"${truncate(label, EMBED_TITLE_MAX)}"` : '';
  const quotedTitle = label ? `"${truncate(label, TITLE_EMBED_MAX)}"` : '';
  switch (kind) {
    case 'test_alert':
      return { title: 'Homeroom test alert', body: 'Your phone can receive push notifications from Homeroom.' };
    case 'conversation_invite':
      return {
        title: withConversation(actor ? `@${actor} invited you to a conversation`
          : 'You have a conversation invitation'),
        body: 'Open Messages to accept or decline',
      };
    case 'conversation_message':
      return {
        title: withConversation(actor ? `@${actor} sent you a message` : 'New message'),
        body: message,
      };
    case 'conversation_mention':
      return actor && {
        title: withConversation(`@${actor} mentioned you`),
        body: message,
      };
    case 'conversation_reply':
      return actor && {
        title: withConversation(`@${actor} replied to you`),
        body: message,
      };
    case 'conversation_reaction':
      return actor && {
        title: withConversation(detail
          ? `@${actor} reacted ${detail} to your message`
          : `@${actor} reacted to your message`),
        body: message && `You said: ${message}`,
      };
    case 'mention':
      return actor && {
        title: withApp(quotedTitle
          ? `@${actor} mentioned you in ${quotedTitle}` : `@${actor} mentioned you`),
        body: message,
      };
    case 'reply':
      return actor && {
        title: withApp(quotedTitle
          ? `@${actor} replied in ${quotedTitle}` : `@${actor} replied to you`),
        body: message,
      };
    case 'reaction':
      return actor && {
        title: withApp(detail
          ? `@${actor} reacted ${detail} to your message`
          : `@${actor} reacted to your message`),
        body: message && `You said: ${message}`,
      };
    case 'kudos':
      return actor && {
        title: withApp(quotedTitle
          ? `@${actor} gave you kudos for ${quotedTitle}` : `@${actor} gave you kudos`),
        body: 'Your work is getting noticed',
      };
    case 'collab_invite':
      return {
        title: actor
          ? (app ? `@${actor} wants to build ${app} with you` : `@${actor} wants to build with you`)
          : withApp('You have a collaboration invite'),
        body: 'Join as a collaborator. Accept or decline in the app',
      };
    case 'collab_invite_accepted':
      return actor && {
        title: withApp(`@${actor} is in!`),
        body: 'Your invite was accepted. You can start building together',
      };
    case 'approver_invite':
      return {
        title: withApp(actor ? `@${actor} asked you to be an approver` : 'You have an approver invite'),
        body: "You'd review and vote on proposals. Accept in the app",
      };
    case 'approver_invite_accepted':
      return actor && {
        title: withApp(`@${actor} is now an approver`),
        body: 'They can review and vote on proposals from now on',
      };
    case 'spec_shared':
      return {
        title: withApp(actor
          ? (quotedTitle ? `@${actor} shared ${quotedTitle} with you` : `@${actor} shared a spec with you`)
          : 'A spec was shared with you'),
        body: detail ? `Spec v${detail}. Take a look and leave feedback` : 'Take a look and leave feedback',
      };
    case 'session_done':
      return {
        title: withApp('Your build is ready'),
        body: quoted && `${quoted} finished. Review it while it's fresh`,
      };
    case 'auto_solve_done': {
      if (detail === 'question') {
        return {
          title: withApp('Auto-solve is waiting on you'),
          body: quoted ? `${quoted} needs an answer before it can continue`
            : 'Your run needs an answer before it can continue',
        };
      }
      if (detail === 'failed') {
        return {
          title: withApp('Auto-solve hit a wall'),
          body: quoted ? `${quoted} failed. Open the log to see what happened`
            : 'The run failed. Open the log to see what happened',
        };
      }
      return {
        title: withApp(quotedTitle ? `Auto-solve finished ${quotedTitle}` : 'Auto-solve finished'),
        body: AUTO_SOLVE_BODIES[detail] || '',
      };
    }
    case 'pr_proposed':
      return actor && {
        title: withApp(quotedTitle ? `@${actor} proposed ${quotedTitle}` : `@${actor} proposed a change`),
        body: `@${actor} would love your eyes on this`,
      };
    case 'check_failed':
      return {
        title: withApp(quotedTitle ? `Checks failed on ${quotedTitle}` : 'Proposal checks failed'),
        body: 'Needs a fix before it can merge',
      };
    case 'stale_pr': {
      const days = daysSince(context.promotedAt, now);
      return {
        title: withApp(quotedTitle
          ? `${quotedTitle} is waiting for eyes` : 'Your proposal needs attention'),
        body: days >= 1
          ? `Nobody has weighed in for ${days} ${days === 1 ? 'day' : 'days'}. Share the preview or ask a friend to try it`
          : 'Share the preview or ask a friend to try it',
      };
    }
    // #1405 path A. The agent, not you, put this somewhere — so the copy leads
    // with the destination, which is the fact you cannot infer from being away.
    case 'connector_submitted':
      return {
        title: withApp(quotedTitle
          ? `Your agent submitted ${quotedTitle}`
          : 'Your agent submitted work'),
        body: context.detail === 'shared'
          ? 'It is visible in the in-progress area (no vote yet)'
          : 'It is up for the group\'s vote, and its checks are running',
      };
    // #1405 path B, and the copy is load-bearing.
    //
    // It says WHEN the question was asked, never "Claude is waiting on you".
    // The difference matters because the clear depends on the agent calling
    // back, which it may forget: "is waiting on you" is FALSE once you have
    // answered, and a notification making a false claim reads as broken. "asked
    // you something N minutes ago" stays true either way, which turns the
    // failure this design cannot prevent into a mild redundancy instead.
    case 'agent_awaiting_input': {
      const mins = minutesSince(context.armedAt || context.createdAt, now);
      return {
        title: withApp('Claude asked you something'),
        body: mins >= 1
          ? `Asked ${mins} ${mins === 1 ? 'minute' : 'minutes'} ago. It is holding for your answer`
          : 'It is holding for your answer',
      };
    }
    default:
      return null;
  }
}

function buildNotificationCopy(kind, context, now = new Date()) {
  try {
    const copy = buildCopy(kind, context && typeof context === 'object' ? context : {}, now);
    const title = copy ? truncate(cleanText(copy.title), TITLE_MAX) : '';
    if (!title) return { ...GENERIC_COPY };
    const body = truncate(cleanText(copy.body), BODY_MAX);
    return body ? { title, body } : { title };
  } catch {
    return { ...GENERIC_COPY };
  }
}

function buildMessage({
  token, notificationId, kind, environment, installationId, userId,
  expiresAt, context, unreadCount, now = new Date(),
}) {
  if (typeof token !== 'string' || !token) throw new Error('mobile_push_registration_missing');
  if (!ALLOWED_KINDS.has(kind)) throw new Error('mobile_push_kind_not_allowed');
  const id = Number(notificationId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new Error('mobile_push_notification_id_invalid');
  }
  const remaining = new Date(expiresAt).getTime() - new Date(now).getTime();
  const ttl = Math.min(MAX_TTL_MS, remaining);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('mobile_push_delivery_expired');

  const collapseId = `usernode-social-${id}`;
  const message = {
    token,
    notification: buildNotificationCopy(kind, context, now),
    data: {
      source: 'usernode_social',
      schema: '1',
      environment: String(environment),
      notification_id: String(id),
      recipient_binding: recipientBinding({ installationId, userId, environment }),
    },
    android: {
      ttl,
      collapseKey: collapseId,
      notification: { channelId: 'social_activity', tag: collapseId },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor((new Date(now).getTime() + ttl) / 1000)),
        'apns-collapse-id': collapseId,
      },
      payload: { aps: { category: 'USERNODE_SOCIAL', threadId: 'usernode-social' } },
    },
  };
  // #1445: the homescreen icon badge. iOS only ever badges the icon when a
  // push carries `aps.badge`; Android launchers read the count from
  // `notificationCount`. Like the copy context above, this is display-only
  // and optional — anything but a usable count degrades to omitting the
  // field (the pre-badge payload) rather than failing the delivery.
  if (Number.isSafeInteger(unreadCount) && unreadCount >= 0) {
    message.android.notification.notificationCount = unreadCount;
    message.apns.payload.aps.badge = unreadCount;
  }
  return message;
}

module.exports = {
  ALLOWED_KINDS,
  MAX_TTL_MS,
  RECIPIENT_CONTEXT,
  PUSH_ENV_RE,
  isPushEnvironment,
  recipientBinding,
  buildMessage,
};
