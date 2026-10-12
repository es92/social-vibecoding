'use strict';

const crypto = require('crypto');
const { ALLOWED_KINDS } = require('./mobile-push-preferences');
const notifyCopy = require('./homeroom-bot-notify-copy');

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
// #1688: a voter's one-line reason, quoted as the vote push's body. Two
// characters short of BODY_MAX for the quotation marks around it.
const VOTE_REASON_EMBED_MAX = 138;
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

// B4: a chat message's markdown, read as the words it shows. A push is
// plain text, and "**Plant Pal** · request #4" spent half its body on
// asterisks. Links keep their words, code its text, a heading or a quote its
// line. Returns '' for anything that is not a string.
function plainMarkdown(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '');
}

// B4 / "one story": the Homeroom bot's moments, and its answer to what
// somebody just wrote to it, as notifications.detail carries them
// (homeroom-bot-dm.js notificationDetail). The words are
// homeroom-bot-notify-copy.js's: the request and its project over what
// happened, instead of "@homeroom_bot replied to you" over the start of its
// message. The bell words the same detail
// (frontend/src/features/notifications/notifications.js), and
// tests/homeroom-bot-notify.test.js holds the two together.
function botMomentCopy(detail, message) {
  const copy = notifyCopy.botMomentCopy(detail, message);
  if (!copy || !copy.body) return null;
  return { title: copy.title, body: copy.body };
}

// WP-E: the bot's build moments as their own kinds ("Your builds"). Worded
// by the moment the detail names, like its messages above; these are what a
// row without one says.
const BUILD_FALLBACK = Object.freeze({
  build_ready: 'Ready to try. Try it, and approve it if you\'re happy.',
  build_needs_you: 'I need your answer before I go on.',
  build_stopped: 'Stopped. I said why in our chat.',
  build_live: 'It\'s live.',
});

// "One story": a change named the way every ping names it, "{change title}
// · {project}". '' without a title.
function changeTitle(label, app) {
  if (!label) return '';
  const title = truncate(label, TITLE_EMBED_MAX);
  return app ? `${title} · ${app}` : title;
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const AUTO_SOLVE_BODIES = Object.freeze({
  spec: 'Plan ready. Review it in the app',
  code: "Code ready. Review and promote when you're happy",
  spec_code: "Plan and code ready. Review and promote when you're happy",
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

// services/platform-limit-alerts.js detailToken(): "<limit>_<level>:<used>:<cap>".
// Parsed here rather than required from there: that module reaches the
// database helpers, and copy assembly stays dependency-free.
const PLATFORM_LIMIT_DETAIL_RE = /^(apps|sessions|github|github_app)_(warn|full):(\d{1,7}):(\d{1,7})$/;

// services/platform-incident-alerts.js tokens (#4296), parsed here for the
// same reason: "digest:<total>:<kind>=<n>,..." or "hour:<kind>:<n>".
const INCIDENT_DIGEST_RE = /^digest:(\d{1,5}):((?:[a-z][a-z0-9_]{0,23}=\d{1,5})(?:,[a-z][a-z0-9_]{0,23}=\d{1,5})*)?$/;
const INCIDENT_HOUR_RE = /^hour:([a-z][a-z0-9_]{0,23}):(\d{1,5})$/;

function incidentKindLabel(kind) {
  return String(kind).replace(/_/g, ' ');
}

function platformIncidentCopy(detail) {
  const hour = INCIDENT_HOUR_RE.exec(detail);
  if (hour) {
    const [, kind, n] = hour;
    return {
      title: 'Unexpected events piling up',
      body: `${n} ${incidentKindLabel(kind)} in the last hour. Admin \u2192 Unexpected events has each one`,
    };
  }
  const digest = INCIDENT_DIGEST_RE.exec(detail);
  if (!digest) {
    return { title: 'Unexpected events', body: 'Open Admin \u2192 Unexpected events to see what happened' };
  }
  const total = Number(digest[1]);
  const parts = digest[2] ? digest[2].split(',').map((p) => p.split('=')) : [];
  const listed = parts.reduce((sum, [, n]) => sum + Number(n), 0);
  const kinds = parts.map(([kind, n]) => `${incidentKindLabel(kind)} ${n}`);
  if (total > listed) kinds.push(`other ${total - listed}`);
  return {
    title: `${total} unexpected event${total === 1 ? '' : 's'} yesterday`,
    body: kinds.length ? kinds.join(', ') : 'Open Admin \u2192 Unexpected events to see what happened',
  };
}

function platformLimitCopy(detail) {
  const m = PLATFORM_LIMIT_DETAIL_RE.exec(detail);
  if (!m) {
    return {
      title: 'Platform limit',
      body: 'The server is nearing one of its limits. Open Homeroom to see which',
    };
  }
  const [, limit, level, used, cap] = m;
  // GitHub's hourly budget (services/github-budget.js): the bot token's,
  // which nearly every GitHub call spends, or the GitHub App's.
  if (limit === 'github') {
    return level === 'full'
      ? { title: 'GitHub requests used up',
        body: `All ${cap} of this hour's GitHub requests are used. Proposals and shots that need GitHub fail until the hour resets` }
      : { title: 'GitHub requests running low',
        body: `${used} of ${cap} GitHub requests used this hour. Background work waits so people's work keeps the rest` };
  }
  if (limit === 'github_app') {
    return level === 'full'
      ? { title: 'GitHub App requests used up',
        body: `All ${cap} of this hour's GitHub App requests are used. It resets within the hour` }
      : { title: 'GitHub App requests running low',
        body: `${used} of ${cap} GitHub App requests used this hour` };
  }
  if (limit === 'apps') {
    return level === 'full'
      ? { title: 'App limit reached',
        body: `${used} of ${cap} apps are in use. New apps are refused until the limit is raised in Admin \u2192 Limits` }
      : { title: 'Nearing the app limit',
        body: `${used} of ${cap} apps are in use. Raise the limit in Admin \u2192 Limits before new apps are refused` };
  }
  return level === 'full'
    ? { title: 'Session limit reached',
      body: `${used} of ${cap} coding sessions are running. New ones pause idle sessions or wait until MAX_GLOBAL_SESSIONS is raised` }
    : { title: 'Nearing the session limit',
      body: `${used} of ${cap} coding sessions are running. At the limit, idle sessions are paused to make room` };
}

// Kind-specific {title, body}, or null when the kind's essential context is
// missing (e.g. a mention without a sender) — null means the generic copy.
function buildCopy(kind, context, now) {
  const app = cleanText(context.appName);
  const conversation = cleanText(context.conversationTitle);
  const actor = cleanText(context.sourceUsername);
  const message = cleanText(plainMarkdown(context.messageContent));
  const detail = cleanText(context.detail);
  // B4: only the platform's own account (the Homeroom bot) words a message
  // by its moment; anybody else's message is theirs, as written.
  if (context.sourceIsSynthetic === true
    && (kind === 'conversation_message' || kind === 'conversation_reply' || kind === 'conversation_mention')) {
    const bot = botMomentCopy(detail, message);
    if (bot) return bot;
  }
  if (Object.prototype.hasOwnProperty.call(BUILD_FALLBACK, kind)) {
    return botMomentCopy(detail, message) || { title: 'Homeroom bot', body: BUILD_FALLBACK[kind] };
  }
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
    // #2387: the thread is the news, so the title says where it happened.
    case 'conversation_thread_reply':
      return actor && {
        title: withConversation(`@${actor} replied in a thread`),
        body: message,
      };
    case 'conversation_reaction':
      return actor && {
        title: withConversation(detail
          ? `@${actor} reacted ${detail} to your message`
          : `@${actor} reacted to your message`),
        body: message && `You said: ${message}`,
      };
    // #2386. No app, no conversation: the person IS the news. The body says
    // what to do about it, because the row it opens carries the buttons.
    case 'friend_request':
      return actor && {
        title: `@${actor} sent you a friend request`,
        body: 'Accept or decline in Notifications',
      };
    case 'friend_accept':
      return actor && {
        title: `@${actor} accepted your friend request`,
        body: 'You\'re friends now. They show up first when you start a message',
      };
    case 'mention':
      return actor && {
        title: withApp(quotedTitle
          ? `@${actor} mentioned you in ${quotedTitle}` : `@${actor} mentioned you`),
        body: message,
      };
    // #3952: named with @ in a request somebody filed. `detail` is its number.
    case 'issue_mention': {
      const issue = /^\d+$/.test(detail) ? ` #${detail}` : '';
      return actor && {
        title: withApp(`@${actor} mentioned you in request${issue}`),
        body: 'Open the request to see what they wrote',
      };
    }
    case 'reply':
      return actor && {
        title: withApp(quotedTitle
          ? `@${actor} replied in ${quotedTitle}` : `@${actor} replied to you`),
        body: message,
      };
    // #2387: somebody answered in an app-chat reply thread you are in. The
    // reply itself is the body, like a reply to you.
    case 'thread_reply':
      return actor && {
        title: withApp(`@${actor} replied in a thread`),
        body: message,
      };
    // #4535: somebody posted in a request's discussion you filed or posted
    // in. `detail` is the request's number, so the title says which one;
    // without it, "a request". The reply itself is the body.
    case 'issue_thread_reply': {
      const issue = /^\d+$/.test(detail) ? `request #${detail}` : 'a request';
      return actor && {
        title: withApp(`@${actor} replied on ${issue}`),
        body: message,
      };
    }
    // A person's message in a small private group's discussion
    // (services/group-channel-notify.js). Only a fresh row rings, so this is
    // nearly always the one message; `detail` counts the messages folded in
    // since, should the row have grown before the push went out.
    case 'channel_message': {
      const count = /^\d{1,6}$/.test(detail) ? Number(detail) : 1;
      const where = app ? truncate(app, TITLE_EMBED_MAX) : '';
      if (count > 1) {
        return {
          title: where ? `${count} new messages in ${where}` : `${count} new messages`,
          body: actor && message ? `@${actor}: ${message}` : message,
        };
      }
      return actor && {
        title: where ? `@${actor} in ${where}` : `@${actor} wrote in the discussion`,
        body: message,
      };
    }
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
    // WP-E: what an invite link brought back to its maker
    // (services/invite-activity.js). A push is only ever the day's first of
    // each; the bell counts the rest. An open is never anybody's name.
    case 'invite_opened':
      return {
        title: app ? `Someone opened your invite to ${app}` : 'Someone opened your invite',
        body: 'You hear when they join',
      };
    case 'member_joined':
      return actor && {
        title: app ? `@${actor} joined ${app}` : `@${actor} joined`,
        body: 'They came in through your invite. Say hello',
      };
    case 'first_message':
      return actor && {
        title: app ? `@${actor} said hi in ${app}` : `@${actor} said hi`,
        body: message,
      };
    // An invite into a private project is to join it (detail 'join',
    // services/collab-invites.js); the rest are to build one.
    case 'collab_invite':
      if (detail === 'join') {
        return {
          title: actor
            ? (app ? `@${actor} invited you to join ${app}` : `@${actor} invited you to join them`)
            : withApp('You have an invite to join'),
          body: 'Accept or decline in the app',
        };
      }
      return {
        title: actor
          ? (app ? `@${actor} wants to build ${app} with you` : `@${actor} wants to build with you`)
          : withApp('You have a collaboration invite'),
        body: 'Join them to build it. Accept or decline in the app',
      };
    case 'collab_invite_accepted':
      return actor && {
        title: withApp(`@${actor} is in!`),
        body: 'Your invite was accepted. You can start building together',
      };
    case 'approver_invite':
      return {
        title: withApp(actor ? `@${actor} asked you to help approve changes` : 'You were asked to help approve changes'),
        body: "You'd try changes and vote on them. Accept in the app",
      };
    case 'approver_invite_accepted':
      return actor && {
        title: withApp(`@${actor} can approve changes now`),
        body: 'They can try changes and vote on them from now on',
      };
    case 'spec_shared':
      return {
        title: withApp(actor
          ? (quotedTitle ? `@${actor} shared ${quotedTitle} with you` : `@${actor} shared a plan with you`)
          : 'A plan was shared with you'),
        body: detail ? `Plan v${detail}. Take a look and leave feedback` : 'Take a look and leave feedback',
      };
    case 'session_done':
      return {
        title: withApp('Your build is ready'),
        body: quoted && `${quoted} finished. Review it while it's fresh`,
      };
    // #3181: the turn ended on an error, a timeout or a lost worker, or the
    // platform paused the session mid-turn. The title says what happened and
    // where; the body is the one thing to do about it.
    case 'session_stalled':
      return {
        title: app
          ? `Your session on ${truncate(app, TITLE_EMBED_MAX)} stopped before finishing`
          : 'Your session stopped before finishing',
        body: quoted ? `Open ${quoted} to continue` : 'Open it to continue',
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
    // B7 / "one story": the change and its project over who asked for it
    // and what to do ("Water reminders · Plant Pal" over "@ben's change is
    // ready to try. Try it and vote.").
    case 'change_ready':
      return {
        title: changeTitle(label, app) || 'A change is ready to try',
        body: `${actor ? `@${actor}'s change` : 'This change'} is ready to try. Try it and vote.`,
      };
    case 'pr_proposed':
      return actor && {
        title: withApp(quotedTitle ? `@${actor} proposed ${quotedTitle}` : `@${actor} proposed a change`),
        body: `@${actor} would love your eyes on this`,
      };
    // #2273: these four kinds arrived with the per-app notification controls,
    // after the contextual push registry was written. They were push-eligible
    // but had no visible copy here, so every delivery collapsed to the generic
    // "You have new activity" fallback even though the worker had already
    // loaded the actor, app, proposal and detail needed to identify it.
    case 'proposal_vote': {
      if (!actor) return null;
      const direction = detail === 'no' ? 'no' : 'yes';
      // #1688: the voter's line IS the news. Quoted when they left one, so
      // the proposer reads what to fix from the banner itself.
      const voteReason = cleanText(context.voteReason);
      return {
        title: withApp(quotedTitle
          ? `@${actor} voted ${direction} on ${quotedTitle}`
          : `@${actor} voted ${direction} on your change`),
        body: voteReason
          ? `“${truncate(voteReason, VOTE_REASON_EMBED_MAX)}”`
          : 'Open the change to see their vote',
      };
    }
    case 'pr_merged': {
      // #1688: `detail` names the people on a merge the vote carried
      // ("Backed by alice and bob, shaped by carol."); an admin override
      // keeps its marker and its own line.
      // #2897: a child app's merge rebuilds production before this row is
      // written, so "live" is true when it arrives. The platform's own merge
      // is released afterwards, outside this process (GitHub Actions, then
      // Argo CD; services/release-watch.js), so at merge time it is only on
      // its way. Say so rather than claim a deploy that has not happened.
      const outcome = context.appSelfHosted === true
        ? 'Your change will be live in a few minutes'
        : 'Your change is live';
      return {
        // B10d: live, in the words every screen uses; the platform's own
        // change is approved now and live in a few minutes.
        title: withApp(context.appSelfHosted === true
          ? (quotedTitle ? `${quotedTitle} was approved` : 'Your change was approved')
          : (quotedTitle ? `${quotedTitle} is live` : 'Your change is live')),
        body: detail === 'forced'
          ? `${context.appSelfHosted === true ? 'An admin approved it.' : 'An admin made it live.'} ${outcome}`
          : detail
            ? `The vote carried. ${truncate(detail, 120)}`
            : `The vote carried. ${outcome}`,
      };
    }
    // #1688: the author pushed a new version of a change this person had
    // backed. Their yes no longer counts until they look again; the row in
    // the app carries the one tap that keeps it. "One story": it says who
    // the update was for (`detail` is "epoch:<n>[:<asker>]", the asker
    // "@name" or "you", notifications.createRevisionRecheckNotifications),
    // never "after your feedback" when it was somebody else's.
    case 'revision_recheck': {
      const subject = changeTitle(label, app);
      const asker = /^epoch:\d+:(you|@[A-Za-z0-9_.-]{1,40})$/.exec(detail || '');
      const who = actor ? `@${actor}` : 'Someone';
      const bot = context.sourceIsSynthetic === true;
      const after = asker
        ? ` after ${asker[1]} asked for a change`
        : (bot ? ' after a request for changes' : '');
      return {
        title: subject ? `Still good? ${subject}` : 'Still good? A change you backed was updated',
        body: `${who} updated it${after}. One tap keeps your yes.`,
      };
    }
    // #4787: the change this person voted on went live. #2897's split, as
    // pr_merged above: a child app's merge is live when the row arrives; the
    // platform's own is released a few minutes after. `detail` is 'yes' when
    // their vote was yes (createVotedChangeMergedNotifications).
    case 'voted_change_merged': {
      const voted = detail === 'yes' ? 'You voted yes.' : 'You voted on it.';
      return {
        title: changeTitle(label, app) || (context.appSelfHosted === true ? 'A change you voted on was approved' : 'A change you voted on is live'),
        body: context.appSelfHosted === true
          ? `Approved. It will be live in a few minutes. ${voted}`
          : `It's live. ${voted}`,
      };
    }
    // #1688: the Friday card. `detail` is "<merged>:<open>" — how many
    // changes went live this week and how many proposals are waiting.
    case 'weekly_digest': {
      const counts = /^(\d+):(\d+)$/.exec(detail || '');
      const merged = counts ? Number(counts[1]) : 0;
      const open = counts ? Number(counts[2]) : 0;
      const shipped = merged === 0
        ? 'Nothing landed this week.'
        : `${merged} ${merged === 1 ? 'change' : 'changes'} went live.`;
      const waiting = open === 0
        ? ''
        : ` ${open === 1 ? 'One change is' : `${open} changes are`} waiting for approval`;
      return {
        title: app ? `This week on ${app}` : 'This week',
        body: `${shipped}${waiting}`.trim(),
      };
    }
    case 'issue_opened': {
      const issue = /^\d+$/.test(detail) ? ` #${detail}` : '';
      return {
        title: withApp(actor ? `@${actor} filed request${issue}` : `New request${issue}`),
        body: 'Open the request to see what needs attention',
      };
    }
    case 'vote_digest': {
      const count = /^\d+$/.test(detail) ? Math.max(0, Number(detail)) : 0;
      // Where a tap goes (notifications.js): one change opens that change,
      // several the Communities screen's Needs you, which lists them.
      return {
        title: count
          ? `${count} ${count === 1 ? 'change is' : 'changes are'} waiting for your approval`
          : 'Changes are waiting for your approval',
        body: count === 1 ? 'Open it to try it and approve it' : 'See them under Needs you in Communities',
      };
    }
    case 'check_failed':
      return {
        title: withApp(quotedTitle ? `Testing found a problem with ${quotedTitle}` : 'Testing found a problem with your change'),
        body: 'It needs a fix before it can go live',
      };
    case 'stale_pr': {
      const days = daysSince(context.promotedAt, now);
      return {
        title: withApp(quotedTitle
          ? `${quotedTitle} is waiting for approval` : 'Your change needs attention'),
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
          : 'It is waiting for approval, and it is being tested',
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
    // #2253: the app storage cap speaks through app_health, and its two
    // tokens say what happened and what to do. #2273 gives the existing
    // deploy-failure token its own copy too. The full failure reason stays on
    // the app row; the push identifies the event and points to that detail.
    case 'app_health':
      if (detail === 'storage_warn') {
        return {
          title: withApp('Storage is nearly full'),
          body: `${app || 'Your app'} has used most of its storage. Clean up old data or ask an admin to raise the limit`,
        };
      }
      if (detail === 'storage_full') {
        return {
          title: withApp('Out of storage'),
          body: 'New data cannot be saved until an admin raises the limit or allows time to clean up',
        };
      }
      if (detail === 'deploy_failed') {
        return {
          title: withApp('Deploy failed'),
          body: 'The latest change did not go live. Open the app to see what failed',
        };
      }
      // The platform's own app: merged, but the release outside the platform
      // (the image workflow, Argo CD, the rollout) has not delivered it.
      if (detail === 'release_stalled') {
        return {
          title: withApp('Approved but not live yet'),
          body: 'An approved change is not live yet. Open the board to see where it stopped',
        };
      }
      return {
        title: withApp('App needs attention'),
        body: 'Open the app to see what needs attention',
      };
    // A server-wide cap nearing or at its ceiling, for full admins only
    // (services/platform-limit-alerts.js). The detail token carries which
    // cap, the level and the figures, so the push can say how close it is.
    case 'platform_limit':
      return platformLimitCopy(detail);
    // #4296: errors that should not happen, a daily digest or one kind past
    // its hourly line (services/platform-incident-alerts.js). Full admins.
    case 'platform_incident':
      return platformIncidentCopy(detail);
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

// #2904: a badge-only APNs push. iOS keeps the icon at whatever the LAST
// push's `aps.badge` said until something sets it again, and the app is
// the only other thing that can — so notifications read on another device
// (or while the WebView was suspended) left the icon on a stale count with
// nothing in-app to explain it. This carries the fresh total and nothing
// else: no `notification` block, no `data`, so iOS updates the icon without
// presenting a banner and the native shell has no social payload to route.
// `alert` is still the right push type — Apple files badge changes under it
// — and priority 5 keeps it off the immediate-delivery budget.
const BADGE_TTL_MS = 60 * 60 * 1000;

function buildBadgeMessage({ token, unreadCount, now = new Date() }) {
  if (typeof token !== 'string' || !token) throw new Error('mobile_push_registration_missing');
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new Error('mobile_push_badge_count_invalid');
  }
  return {
    token,
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor((new Date(now).getTime() + BADGE_TTL_MS) / 1000)),
      },
      payload: { aps: { badge: unreadCount } },
    },
  };
}

module.exports = {
  ALLOWED_KINDS,
  botMomentCopy,
  buildNotificationCopy,
  plainMarkdown,
  MAX_TTL_MS,
  RECIPIENT_CONTEXT,
  PUSH_ENV_RE,
  isPushEnvironment,
  recipientBinding,
  buildMessage,
  buildBadgeMessage,
  BADGE_TTL_MS,
};
