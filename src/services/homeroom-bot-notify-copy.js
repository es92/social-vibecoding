'use strict';

// "One request, one story": what the Homeroom bot's notifications say.
//
// Four moments in a request's life ring (needs you, ready to try, stopped,
// live), plus "on hold until Monday", which rings as a stop; the bot's answer
// to what somebody just wrote to it rings as a message. Each ringing DM
// message carries `metadata.homeroomBot` (moment, said, appName, appSlug,
// issueNumber, requestTitle, firstVersion, waiting, count, threadRootId:
// homeroom-bot-dm.js); `botNotificationDetail` folds what the words need into
// the notification's `detail`, and `botMomentCopy` words that detail for the
// push (title, body), the bell (label, subject, meta) and the ready email.
//
// Both are pure, and both live here so the push (mobile-push-policy.js), the
// bell (frontend/src/features/notifications/notifications.js, which reads
// the same detail) and the email (activity-mail.js) say one thing.
//
// The detail is `hrbot2:` and a small JSON object. Rows written before it
// carry `hrbot:<said>:<app name>`, and keep reading (LEGACY_SAID).

const DETAIL_PREFIX = 'hrbot2:';
const LEGACY_RE = /^hrbot:([a-z_]{1,20}):(.*)$/s;

// The moments, in the words the bell heads a row with.
const BELL_LABELS = Object.freeze({
  needs_you: 'Needs you',
  ready: 'Ready to try',
  stopped: 'Stopped',
  on_hold: 'On hold',
  live: 'Live',
});

// Older moment names (rows and senders from before), as the moment they are.
const MOMENT_ALIASES = Object.freeze({
  question: 'needs_you',
  held: 'on_hold',
});

// Every variant (`said`) each moment has.
const SAID_BY_MOMENT = Object.freeze({
  needs_you: Object.freeze(['question', 'questions', 'followup_ask', 'plan', 'plan_first', 'decide', 'decide_others',
    'blocked', 'empty', 'done', 'platform']),
  ready: Object.freeze(['ready', 'ready_group', 'ready_first', 'ready_broken']),
  stopped: Object.freeze(['build_time', 'build_restart', 'build_no_change', 'build_not_proposed', 'build_no_start',
    'build_other', 'update_failed', 'needs_look', 'checks', 'first_failed']),
  on_hold: Object.freeze(['allowance', 'paused']),
  live: Object.freeze(['live', 'live_soon', 'live_first', 'live_first_soon']),
});

// The notification kind each moment rings as, in the "Your builds" push
// category (mobile-push-preferences.js). The bot's answer stays a message.
const MOMENT_KINDS = Object.freeze({
  needs_you: 'build_needs_you',
  ready: 'build_ready',
  stopped: 'build_stopped',
  on_hold: 'build_stopped',
  live: 'build_live',
});

// `hrbot:<said>:<app>` rows from before "one story": the moment and variant
// each one is now.
const LEGACY_SAID = Object.freeze({
  question: ['needs_you', 'question'],
  ready: ['ready', 'ready'],
  ready_group: ['ready', 'ready_group'],
  ready_broken: ['ready', 'ready_broken'],
  // The only bare stop was an update that did not happen (followup_failed).
  stopped: ['stopped', 'update_failed'],
  stopped_build: ['stopped', 'build_other'],
  stopped_blocked: ['needs_you', 'blocked'],
  stopped_person: ['needs_you', 'decide'],
  stopped_empty: ['needs_you', 'empty'],
  stopped_first: ['stopped', 'first_failed'],
  stopped_preview: ['stopped', 'needs_look'],
  stopped_look: ['stopped', 'needs_look'],
  held: ['on_hold', 'allowance'],
  live: ['live', 'live'],
  live_soon: ['live', 'live_soon'],
  live_first: ['live', 'live_first'],
  live_first_soon: ['live', 'live_first_soon'],
  reply: ['reply', 'reply'],
});

// A sender that names its message's kind but not its variant (and the rows
// the bot sent before variants): the variant its kind is.
const SAID_OF_KIND = Object.freeze({
  question: 'question',
  followup_ask: 'followup_ask',
  person: 'decide',
  blocked: 'blocked',
  empty: 'empty',
  done: 'done',
  platform: 'platform',
  build_failed: 'build_other',
  first_version_failed: 'first_failed',
  preview_failed: 'needs_look',
  needs_look: 'needs_look',
  followup_failed: 'update_failed',
  followup_person: 'checks',
  allowance: 'allowance',
  paused: 'paused',
});

// Kinds that ask the person for something, whatever moment an older sender
// rang them at.
const NEEDS_YOU_KINDS = new Set(['blocked', 'person', 'empty', 'done', 'platform']);

// What a stopped build's cause is said as (homeroom-bot-dm.js build stops).
const BUILD_CAUSES = Object.freeze({
  timeout: 'build_time', time: 'build_time', timed_out: 'build_time',
  restart: 'build_restart', restarted: 'build_restart',
  no_change: 'build_no_change', no_changes: 'build_no_change', empty_diff: 'build_no_change',
  not_proposed: 'build_not_proposed', promote_failed: 'build_not_proposed',
  no_start: 'build_no_start', not_started: 'build_no_start',
});

function oneLine(value, max) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pure: a moment's name as one of the five, 'reply', or null. */
function normalizeMoment(moment) {
  const name = MOMENT_ALIASES[moment] || moment;
  if (name === 'reply' || Object.prototype.hasOwnProperty.call(BELL_LABELS, name)) return name;
  return null;
}

/** Pure: "you and @ada" from ['you', 'ada'], "@ada, @ben and @cy" from three. */
function joinNames(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || '').trim()).filter(Boolean)
    .map((n) => (n === 'you' || n.startsWith('@') ? n : `@${n}`));
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function brokenCount(metadata) {
  if (positiveInt(metadata?.brokenCount)) return positiveInt(metadata.brokenCount);
  const broken = Array.isArray(metadata?.broken) ? metadata.broken : metadata?.ready?.broken;
  return Array.isArray(broken) && broken.length ? broken.length : null;
}

/**
 * Pure: the variant a message is, when its sender did not say (its kind, and
 * what its metadata shows), so a message without `said` still says what
 * happened.
 */
function saidFor(moment, metadata = {}) {
  const given = metadata?.said;
  if (typeof given === 'string' && SAID_BY_MOMENT[moment]?.includes(given)) return given;
  const first = !!metadata?.firstVersion;
  const kind = metadata?.kind;
  if (moment === 'live') {
    const soon = metadata?.live === false;
    if (first) return soon ? 'live_first_soon' : 'live_first';
    return soon ? 'live_soon' : 'live';
  }
  if (moment === 'ready') {
    if (brokenCount(metadata)) return 'ready_broken';
    if (first) return 'ready_first';
    return metadata?.group || metadata?.ready?.group ? 'ready_group' : 'ready';
  }
  if (moment === 'on_hold') return kind === 'paused' ? 'paused' : 'allowance';
  if (moment === 'needs_you') {
    if (kind === 'plan') return first ? 'plan_first' : 'plan';
    if (kind === 'question' && Array.isArray(metadata?.questions) && metadata.questions.length > 1) return 'questions';
    if (kind === 'person' && (metadata?.deciders || (Array.isArray(metadata?.personDeciders) && metadata.personDeciders.length))) {
      return 'decide_others';
    }
    const said = SAID_OF_KIND[kind];
    return SAID_BY_MOMENT.needs_you.includes(said) ? said : 'question';
  }
  if (moment === 'stopped') {
    if (kind === 'build_failed' && BUILD_CAUSES[metadata?.cause]) return BUILD_CAUSES[metadata.cause];
    const said = SAID_OF_KIND[kind];
    if (SAID_BY_MOMENT.stopped.includes(said)) return first && said === 'build_other' ? 'first_failed' : said;
    return first ? 'first_failed' : 'build_other';
  }
  return null;
}

/**
 * Pure: what a ringing message's notification carries (notifications.detail)
 * for the push, the bell and the email to word it by: `hrbot2:{…}`, from the
 * message's `metadata.homeroomBot` alone. `metadata.moment` names the moment
 * (needs_you, ready, stopped, on_hold, live, or reply; the older question
 * and held are read as the moments they are). The bot's answer to what
 * somebody wrote keeps its old token, `hrbot:reply:`. Null for a message
 * that does not ring.
 */
function botNotificationDetail(metadata) {
  let moment = normalizeMoment(metadata?.moment);
  if (!moment) return null;
  // A sender from before "one story" rang a request it cannot build as
  // written as a stop; it needs the person's answer.
  if (moment === 'stopped' && !metadata.said && NEEDS_YOU_KINDS.has(metadata.kind)) moment = 'needs_you';
  if (moment === 'reply') return 'hrbot:reply:';
  const said = saidFor(moment, metadata || {});
  const first = !!metadata.firstVersion || said === 'plan_first' || said === 'ready_first' || said === 'first_failed'
    || said === 'live_first' || said === 'live_first_soon';
  const out = { m: moment, s: said };
  const app = oneLine(metadata.appName, 80);
  if (app) out.a = app;
  const title = first ? '' : oneLine(metadata.requestTitle, 120);
  if (title) out.t = title;
  if (first) out.f = 1;
  const waiting = oneLine(metadata.waiting || joinNames(metadata.ready?.waitingOn), 120);
  if (waiting) out.w = waiting;
  const deciders = oneLine(
    typeof metadata.deciders === 'string' ? metadata.deciders : joinNames(metadata.deciders || metadata.personDeciders),
    120,
  );
  if (deciders) out.d = deciders;
  if (metadata.oneMore === true) out.o = 1;
  const count = positiveInt(metadata.count);
  if (count) out.c = Math.min(count, 999);
  const broken = brokenCount(metadata);
  if (said === 'ready_broken' && broken) out.b = Math.min(broken, 99);
  const issue = positiveInt(metadata.issueNumber);
  if (issue) out.i = issue;
  const root = positiveInt(metadata.threadRootId);
  if (root) out.r = root;
  return `${DETAIL_PREFIX}${JSON.stringify(out)}`;
}

/** Pure: a detail, read back into its fields, or null when it is not the bot's. */
function parseBotDetail(detail) {
  if (typeof detail !== 'string') return null;
  if (detail.startsWith(DETAIL_PREFIX)) {
    let raw;
    try { raw = JSON.parse(detail.slice(DETAIL_PREFIX.length)); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const moment = normalizeMoment(raw.m);
    if (!moment || moment === 'reply') return moment === 'reply' ? { moment, said: 'reply' } : null;
    const said = SAID_BY_MOMENT[moment].includes(raw.s) ? raw.s : saidFor(moment, {});
    return {
      moment,
      said,
      appName: oneLine(raw.a, 80),
      requestTitle: oneLine(raw.t, 120),
      firstVersion: raw.f === 1 || raw.f === true,
      waiting: oneLine(raw.w, 120),
      deciders: oneLine(raw.d, 120),
      oneMore: raw.o === 1 || raw.o === true,
      count: positiveInt(raw.c),
      broken: positiveInt(raw.b),
      issueNumber: positiveInt(raw.i),
      threadRootId: positiveInt(raw.r),
    };
  }
  const m = LEGACY_RE.exec(detail);
  if (!m || !LEGACY_SAID[m[1]]) return null;
  const [moment, said] = LEGACY_SAID[m[1]];
  if (moment === 'reply') return { moment, said };
  const appName = oneLine(m[2], 80);
  return {
    moment,
    // A hold without a project was the bot's own budget.
    said: m[1] === 'held' && !appName ? 'paused' : said,
    appName,
    requestTitle: '',
    firstVersion: said === 'live_first' || said === 'live_first_soon' || said === 'first_failed',
    waiting: '',
    deciders: '',
    oneMore: false,
    count: null,
    broken: null,
    issueNumber: null,
    threadRootId: null,
    legacy: true,
  };
}

/** Pure: the push body for one moment's variant (section 2.2's words). */
function bodyFor(d) {
  const app = d.appName || 'the project';
  switch (d.said) {
    case 'question': return 'I have a question before I build it.';
    case 'questions': return 'I have two questions before I build it.';
    case 'followup_ask': return 'I have a question before I update it.';
    case 'plan': return 'My plan is ready. Tap Build it if it looks right.';
    case 'plan_first': return 'My plan for your first version is ready. Tap Build it if it looks right.';
    case 'decide': return 'This needs your decision before I build it.';
    case 'decide_others': return `This needs a decision from ${d.deciders || d.waiting || 'someone else'} before I build it.`;
    case 'blocked': return 'I can\'t build it as written. Add detail and I\'ll look again.';
    case 'empty': return 'I couldn\'t find anything to build. Add detail and I\'ll look again.';
    case 'done': return 'This looks done already. Close it, or tell me what\'s missing.';
    case 'platform': return 'This is about Homeroom itself. Move it to Homeroom\'s own board?';
    case 'ready': return 'Ready to try. Try it, and approve it if you\'re happy.';
    case 'ready_group': {
      // "you and @ada": the reader's own yes is one of those it waits on.
      // Without them in it (their yes does not count, or is in already), it
      // needs one more, from whoever is named.
      if (!d.waiting) return 'Ready to try. It goes live once the group says yes.';
      if (!d.oneMore && /^you\b/i.test(d.waiting)) return `Ready to try. It goes live once ${d.waiting} say yes.`;
      return `Ready to try. It needs one more yes, from ${d.waiting}.`;
    }
    case 'ready_first': return 'Your first version is ready to try.';
    case 'ready_broken':
      if (d.broken > 1) return `Built, but ${d.broken} things aren't working yet. Try it to see.`;
      if (d.broken === 1) return 'Built, but one thing isn\'t working yet. Try it to see.';
      return 'Built, but something isn\'t working yet. Try it to see.';
    case 'build_time': return 'Stopped: it took longer than I\'m allowed. Tap Try again.';
    case 'build_restart': return 'Stopped: Homeroom restarted while I was building. Tap Try again.';
    case 'build_no_change': return 'Stopped: I ended up with no changes to show. Tap Try again.';
    case 'build_not_proposed': return 'Stopped: I built it but couldn\'t put it up for a vote. Tap Try again.';
    case 'build_no_start': return 'Stopped: I couldn\'t get started. Tap Try again.';
    case 'build_other': return 'Stopped: something went wrong while I was building. Tap Try again.';
    case 'update_failed': return 'Stopped: I couldn\'t update it. It\'s as it was.';
    case 'needs_look': return 'Stopped: it\'s built, but a person needs to look at it before you can try it.';
    case 'checks': return 'Stopped: its checks still fail. A person needs to look.';
    case 'first_failed': return 'Stopped: I couldn\'t start building your first version. You can still post a request on its page.';
    case 'allowance': return 'On hold until Monday: your building time for this week is used up.';
    case 'paused': return 'On hold until Monday: I\'ve used my budget for this week.';
    case 'live': return `It's live. Open ${app} to see it.`;
    case 'live_soon': return `It's going live now. Open ${app} in a few minutes to see it.`;
    case 'live_first': return `Your first version is live. Open ${app} to try it.`;
    case 'live_first_soon': return `Your first version is going live now. Open ${app} in a few minutes to try it.`;
    default: return null;
  }
}

/** Pure: the push title: "{request} · {project}", a first version's project, or a summary's count. */
function titleFor(d) {
  if (d.moment === 'on_hold' && d.count > 1) return `${d.count} requests on hold`;
  if (d.firstVersion) return d.appName || 'Homeroom bot';
  if (d.requestTitle && d.appName) return `${d.requestTitle} · ${d.appName}`;
  return d.requestTitle || d.appName || 'Homeroom bot';
}

/** Pure: a chat message's markdown as the words it shows, on one line. */
function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure: the words for one of the bot's notifications, from its detail:
 * `{ title, body, bellLabel, bellSubject, bellMeta, moment, said,
 * threadRootId }`. The push shows title over body; the bell heads the row
 * with bellLabel over bellSubject, with bellMeta (and the time) under it.
 * The bot's answer to what somebody wrote is `message`, its own words, from
 * "Homeroom bot". Null when the detail is not one of the bot's, or is a
 * variant this build cannot word.
 */
function botMomentCopy(detail, message = '') {
  const d = parseBotDetail(detail);
  if (!d) return null;
  if (d.moment === 'reply') {
    const words = plainText(message);
    return {
      title: 'Homeroom bot', body: words, bellLabel: 'Homeroom bot', bellSubject: words.slice(0, 140),
      bellMeta: 'Homeroom bot', moment: 'reply', said: 'reply', threadRootId: null,
    };
  }
  const body = bodyFor(d);
  if (!body) return null;
  const title = titleFor(d);
  const bellSubject = d.moment === 'on_hold' && d.count > 1
    ? title
    : (d.firstVersion ? (d.appName ? `${d.appName} first version` : 'Your first version') : (d.requestTitle || d.appName || 'Homeroom bot'));
  return {
    title,
    body,
    bellLabel: BELL_LABELS[d.moment],
    bellSubject,
    bellMeta: d.appName ? `${d.appName} · Homeroom bot` : 'Homeroom bot',
    moment: d.moment,
    said: d.said,
    threadRootId: d.threadRootId || null,
  };
}

/** Pure: a body's first sentence, without its full stop ("Ready to try"). */
function firstSentence(text) {
  const s = String(text || '').trim();
  const m = /^(.+?)[.:?!](?:\s|$)/.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * Pure: the "ready to try" email for a detail: `{ subject, lead }`, where the
 * subject is the push's title and its body's first sentence ("Dark mode ·
 * Plant Pal: Ready to try") and the lead is the push's body. Null when the
 * detail is not a moment.
 */
function botEmailCopy(detail) {
  const copy = botMomentCopy(detail);
  if (!copy || copy.moment === 'reply') return null;
  return { subject: `${copy.title}: ${firstSentence(copy.body)}`, lead: copy.body };
}

/** Pure: the notification kind a moment rings as, or null (a message). */
function momentKind(moment) {
  return MOMENT_KINDS[normalizeMoment(moment)] || null;
}

/** Pure: whether a detail is one of the bot's moments (not its answer). */
function isBotMomentDetail(detail) {
  const d = parseBotDetail(detail);
  return !!d && d.moment !== 'reply';
}

module.exports = {
  DETAIL_PREFIX,
  BELL_LABELS,
  SAID_BY_MOMENT,
  MOMENT_KINDS,
  LEGACY_SAID,
  normalizeMoment,
  saidFor,
  botNotificationDetail,
  parseBotDetail,
  botMomentCopy,
  botEmailCopy,
  firstSentence,
  momentKind,
  isBotMomentDetail,
};
