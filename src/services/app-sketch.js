'use strict';

/**
 * The sketch: a featured card of the idea, a few seconds after "Make it".
 *
 * Somebody who makes a project in their first session (first-session
 * make.tsx, POST /api/apps with `from: 'first-session'`) is shown a card of
 * it while the real app is built (first-session sketch-card.tsx). It is the
 * card an app store would feature the idea with, not a picture of the app:
 *
 *   emoji    the project's icon from now on (saved to it, below);
 *   tagline  one line, what it is for;
 *   points   two to four things it will let the group do.
 *
 * 5 October 2026, on a phone: the sketch it replaces was a model-written
 * mock of the app's main screen, framed and scrolling inside the made screen,
 * about twenty seconds after Make it, and the build was then told to make
 * that screen. A mock read as the app itself, not as something being made,
 * and the first version rarely looked like it. The card is structured output
 * that our own component draws in the platform's look, so it is quicker (a
 * short reply), safe (text only, rendered by React) and never scrolls.
 *
 * ALWAYS A CARD. The model gets MODEL_WAIT_MS; a refusal, an error, a reply
 * that is not usable or no model at all gives the card fallbackCard() makes
 * from the name and the description alone, so the made screen, the
 * repository's first commit and the icon never wait on it.
 *
 * ITS ICON IS THE PROJECT'S. The emoji is the model's when it is one emoji
 * that is fit to be an icon, else the first keyword of KEYWORD_EMOJI the name
 * or the description has, else DEFAULT_EMOJI. It is saved to apps.icon_emoji
 * only when the project has no icon yet (an icon somebody set is never
 * replaced), and written into the new repository's dapp.json `icon` block,
 * which every deploy reconciles from (app-manifest.js reconcileAppIcon): a
 * dapp.json without it would clear the icon on the first deploy.
 *
 * ITS WORDS ARE THE DESCRIPTION'S. Points say only what the description asks
 * for. Nobody is invented: the creator is "you", anyone else is "everyone",
 * "the group" or a word from the subject. Any date is held to the real
 * calendar where the creator is (services/sketch-dates.js), as the screen
 * mock's were.
 *
 * WHAT THE BUILD DOES WITH IT. Nothing to the screen: the card shows none.
 * The repository gets design/sketch.json (the card, with a note saying what
 * it is), and the first version's request quotes the tagline and points as a
 * summary of the description (homeroom-bot-dm.js firstVersionIssue), never
 * as a design.
 *
 * Never a reason creation fails.
 */

const log = require('./logger');
const sketchDates = require('./sketch-dates');

// GLM 5.3 Flash, and Haiku 4.5 when it does not answer in time (llm.js
// helperMessage); the card row keeps the model that answered.
const SKETCH_MODEL = 'z-ai/glm-5.3-flash';
// How long app creation waits for the card before seeding the repository
// without it (app-creator.js). A late card is committed on its own.
const SKETCH_WAIT_MS = 30 * 1000;
// How long the card waits on the model before it is made from the
// description instead: well inside SKETCH_WAIT_MS, so the first commit has it.
const MODEL_WAIT_MS = 15 * 1000;
const LATE_COMMIT_WAIT_MS = 3 * 60 * 1000;
// A reply is three short lines of JSON.
const CARD_MAX_TOKENS = 400;
// The card's shape, for a model that answers through a schema (GLM); the
// prompt asks Haiku for the same object. parseCardReply checks it either way.
const CARD_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    emoji: { type: 'string' },
    tagline: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['emoji', 'tagline', 'points'],
});

// What the card holds, in characters: a tagline and a point are each at most
// two lines of the card at 390px (it shows the points that fit four lines,
// first-session sketch-card.tsx fitPoints). The model is asked for less.
const TAGLINE_MAX = 80;
const POINT_MAX = 72;
const POINTS_MAX = 4;
// Said on a fallback card with fewer than two points of its own: true of
// every project made for a group. Not of one made for Just me (the New
// project dialog's More options, behind the Create button's make screen),
// which goes without it (`solo`).
const SHARED_POINT = 'Shared with the people you invite';

// ── The emoji ────────────────────────────────────────────────────────────

const DEFAULT_EMOJI = '\u{1F4A1}'; // light bulb: an idea, before it is anything

// Emoji that would make a poor icon for a group's project, even when asked
// for: crude, violent or morbid.
const BLOCKED_EMOJI = new Set(['🖕', '🍆', '🍑', '💦', '💩', '🔫', '💣', '🔪', '🗡️', '🩸', '☠️', '💀', '⚰️', '🪦', '🤬']);

/** One emoji fit to be an icon, normalised to its emoji form; null when `value` is not one. */
function iconEmoji(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 16) return null;
  // At most 16 UTF-16 units, as dapp.json's icon.emoji allows (app-manifest.js
  // readIcon); a longer one would be dropped by the first deploy.
  for (const candidate of [s, `${s}\u{FE0F}`]) {
    if (candidate.length <= 16 && /^\p{RGI_Emoji}$/v.test(candidate)) return BLOCKED_EMOJI.has(candidate) ? null : candidate;
  }
  return null;
}

// The first rule a project's name matches, else the first its description
// matches. Specific subjects first, the general ones (plans, lists, homes)
// last, so "a planner for our lake house" is a tent, not a calendar.
const KEYWORD_EMOJI = Object.freeze([
  [/\b(?:run|runs|running|runners?|jog|jogs|jogging|marathons?|parkrun|5k|10k|miles)\b/, '🏃'],
  [/\b(?:cycling|cyclists?|bikes?|biking|bicycles?)\b/, '🚴'],
  [/\b(?:swim|swims|swimming|swimmers?)\b/, '🏊'],
  [/\b(?:hikes?|hiking|trails?|rambl\w*)\b/, '🥾'],
  [/\b(?:yoga|meditat\w*)\b/, '🧘'],
  [/\b(?:climb\w*|boulder\w*)\b/, '🧗'],
  [/\b(?:gym|workouts?|fitness|exercis\w*|weightlifting)\b/, '💪'],
  [/\b(?:football|soccer)\b/, '⚽'],
  [/\b(?:basketball)\b/, '🏀'],
  [/\b(?:tennis|padel|squash|badminton)\b/, '🎾'],
  [/\b(?:golf)\b/, '⛳'],
  [/\b(?:books?|reading|novels?|library)\b/, '📚'],
  [/\b(?:movies?|films?|cinema)\b/, '🎬'],
  [/\b(?:music|songs?|playlists?|gigs?|concerts?|karaoke|choir)\b/, '🎵'],
  [/\b(?:board games?|games?|gaming|poker|chess|quiz\w*|trivia)\b/, '🎲'],
  [/\b(?:polls?|votes?|voting)\b/, '🗳️'],
  [/\b(?:camp|camping|campsite|tents?|cabins?|lake)\b/, '🏕️'],
  [/\b(?:ski|skiing|snowboard\w*)\b/, '⛷️'],
  [/\b(?:beach)\b/, '🏖️'],
  [/\b(?:trips?|travel\w*|holidays?|vacations?|flights?|getaway)\b/, '✈️'],
  [/\b(?:pizza)\b/, '🍕'],
  [/\b(?:coffee|caf[eé])\b/, '☕'],
  [/\b(?:wine)\b/, '🍷'],
  [/\b(?:beers?|pubs?)\b/, '🍺'],
  [/\b(?:recipes?|cook\w*|meals?|dinners?|potluck|bak(?:e|es|ing)|kitchen|food)\b/, '🍳'],
  [/\b(?:grocer\w*|shopping)\b/, '🛒'],
  [/\b(?:chores?|cleaning|rota|bins|dishes|hoover\w*|laundry)\b/, '🧹'],
  [/\b(?:plants?|garden\w*|watering|flowers?|seeds?)\b/, '🪴'],
  [/\b(?:dogs?|pupp(?:y|ies))\b/, '🐶'],
  [/\b(?:cats?|kittens?)\b/, '🐱'],
  [/\b(?:pets?)\b/, '🐾'],
  [/\b(?:birds?|birding|birdwatching)\b/, '🐦'],
  [/\b(?:fishing)\b/, '🎣'],
  [/\b(?:budgets?|expenses?|money|bills?|rent|owes?|owed|splits?|splitting|savings)\b/, '💰'],
  [/\b(?:birthdays?|party|parties)\b/, '🎉'],
  [/\b(?:gifts?|presents?|secret santa|wish ?lists?)\b/, '🎁'],
  [/\b(?:weddings?)\b/, '💍'],
  [/\b(?:homework|study|studying|exams?|revision|lessons?)\b/, '📝'],
  [/\b(?:photos?|photography|albums?)\b/, '📷'],
  [/\b(?:carpool\w*|car share|lift share)\b/, '🚗'],
  [/\b(?:volunteer\w*|charity|fundrais\w*)\b/, '🤝'],
  [/\b(?:calendar|schedul\w*|meetups?|events?|rsvps?|planner|availability)\b/, '📅'],
  [/\b(?:to-?dos?|tasks?|checklists?)\b/, '✅'],
  [/\b(?:house|household|flat|flatmates?|neighbou?rs?|neighbou?rhood)\b/, '🏡'],
]);

/** The emoji a project's name, else its description, suggests; DEFAULT_EMOJI when neither does. */
function keywordEmoji(name, brief) {
  for (const text of [name, brief]) {
    const lower = String(text || '').toLowerCase();
    if (!lower) continue;
    for (const [re, emoji] of KEYWORD_EMOJI) if (re.test(lower)) return emoji;
  }
  return DEFAULT_EMOJI;
}

/** The card's emoji: the model's when it is fit to be an icon, else the keyword map's. */
function chooseEmoji(fromModel, { name, brief } = {}) {
  return iconEmoji(fromModel) || keywordEmoji(name, brief);
}

// ── The words ────────────────────────────────────────────────────────────

// Emoji drawn as pictures, and the joiners that held them: kept out of the
// card's words (the icon is the card's one emoji).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{FE0F}\u{200D}]/gu;

// The lower-case words a line may rightly start with (units under a number).
const LOWER_STARTS = new Set(['km', 'kg', 'mg', 'ml', 'cm', 'mm', 'mi', 'min', 'mins', 'hr', 'hrs', 'sec', 'secs',
  'am', 'pm', 'lb', 'lbs', 'oz', 'kcal', 'ft', 'vs', 'etc']);

/** Sentence case: a line's first word capitalised when it is all lower case ("iPhone" and "km" stay). */
function sentenceCase(text) {
  return String(text || '').replace(/^([a-z])([a-z'’]*)(?![\p{L}\p{N}])/u, (whole, first, rest) => {
    const word = first + rest;
    if (LOWER_STARTS.has(word) || (word.length === 1 && word !== 'a')) return whole;
    return first.toUpperCase() + rest;
  });
}

/** `text` cut to `max` characters at a word, with an ellipsis when it was cut. */
function clipWords(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.\-]+$/, '')}…`;
}

/**
 * One line of the card: plain text in sentence case, with no emoji, no
 * markdown, no em dash, no wrapping quotes and no full stop, at most `max`
 * characters. '' when nothing is left.
 */
function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  let s = value
    .replace(EMOJI_RE, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•·>#,;:]+\s*)+/, '')
    .replace(/[\s,;:]+$/, '')
    .replace(/^["“”‘]+|["“”]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  s = sentenceCase(s);
  return s ? clipWords(s, max) : '';
}

// The words a thing in a list starts with when it could stand as a point of
// its own ("who's hosting the next meetup", "a countdown to it"), and not
// ("dishes and hoovering", the rest of one thing).
const POINT_STARTS = /^(?:who|whose|what|when|where|which|how|a|an|the|our|your|their|everyone|everybody|each|every|all|plus|see|add|log|track|vote|pick|share|keep|get|show|shows|plan|find|chat|post|send|remind|reminders)\b/i;

/**
 * The description in pieces, for a card made without the model: its
 * sentences, the asides in brackets, what comes after a colon, and the joins
 * (", so we can see ...") a sentence is made of. A list after a colon ("the
 * dates, who sleeps where, and who brings what") is one piece per thing, and
 * so is a long piece whose every thing after the first could stand alone.
 */
function clausesOf(brief) {
  const text = String(brief || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
  const out = [];
  const listOf = (piece) => {
    const items = piece.split(/\s*,\s*(?:and\s+|or\s+)?/).map((s) => s.trim()).filter(Boolean);
    const last = items[items.length - 1] || '';
    const and = last.lastIndexOf(' and ');
    if (items.length > 1 && and > 0 && !/,\s*and\s/.test(piece)) items.splice(-1, 1, last.slice(0, and), last.slice(and + 5));
    return items;
  };
  const push = (raw, isList) => {
    const clause = raw.replace(/^[\s,;:\-–—]+|[\s,;:.!?\-–—]+$/g, '');
    if (!clause) return;
    for (const piece of clause.split(/,\s*(?=(?:so|so that|and so|because|which|where|from|with)\b)/i)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const items = trimmed.includes(',') ? listOf(trimmed) : [trimmed];
      const standsAlone = items.length > 1 && items.slice(1).every((item) => POINT_STARTS.test(item));
      if (isList || (trimmed.length > 40 && standsAlone)) out.push(...items);
      else out.push(trimmed);
    }
  };
  for (const part of text.split(/\s*[()]\s*/)) {
    for (const sentence of part.split(/(?<=[.!?])\s+|\s*;\s*|\s+[-–—]\s+/)) {
      const colon = sentence.indexOf(': ');
      if (colon > 0) {
        push(sentence.slice(0, colon), false);
        push(sentence.slice(colon + 2), true);
      } else {
        push(sentence, false);
      }
    }
  }
  return out;
}

/** Held to the real calendar where the creator is (services/sketch-dates.js). */
function checkedDates(text, { today = null, brief = '' } = {}) {
  return sketchDates.checkSketchDates(text, { today, brief });
}

/** Points without repeats, or the tagline again. */
function distinctPoints(points, tagline) {
  const seen = new Set([String(tagline || '').toLowerCase()]);
  const out = [];
  for (const point of points) {
    const key = point.toLowerCase();
    if (!point || seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

/**
 * The card made from the name and the description alone: the description's
 * first piece as the tagline, the pieces after it as points (with one true
 * of every project when it has fewer than two), and the keyword map's emoji.
 * Deterministic, and never null.
 */
function fallbackCard({ name = '', brief = '', today = null, solo = false } = {}) {
  const clauses = clausesOf(checkedDates(brief, { today, brief })).map((c) => cleanLine(c, 400)).filter(Boolean);
  const tagline = clauses.length ? clipWords(clauses[0], TAGLINE_MAX) : cleanLine(`Made for ${name || 'your group'}`, TAGLINE_MAX);
  let points = distinctPoints(clauses.slice(1).map((c) => clipWords(c, POINT_MAX)), tagline).slice(0, POINTS_MAX);
  if (points.length < 2 && !solo) points = distinctPoints([...points, SHARED_POINT], tagline);
  return { kind: 'card', emoji: keywordEmoji(name, brief), tagline, points, source: 'fallback' };
}

// ── The prompt ───────────────────────────────────────────────────────────

const SKETCH_SYSTEM = `You write the featured card a new app gets while it is being built, like the card an app store features an app with: it sells the IDEA at a glance. It is not a screen of the app and says nothing about its layout or its look, only what it is for and what it will let its group do. A small group of people (friends, a club, a household) will use the app together; its creator described it in their own words.

Respond with ONLY a JSON object, no prose before or after:
{"emoji": "one emoji", "tagline": "one line", "points": ["a point", "another point"]}

- emoji: ONE emoji for the app's subject, which becomes its icon. An object, animal, food, place or activity from the subject (a running shoe, a book, a film clapper, a tent), not a face, a hand, a flag or a heart.
- tagline: one line of at most 60 characters saying what the app is for, in plain words. Not its name. No full stop, no quotes.
- points: 2 to 4 things it will let the group do or see, each at most 40 characters, the most important first. Only what the description asks for or plainly implies, never a feature it does not mention. No full stops.
- Sentence case: capitalise the first word of the tagline and of each point, and every weekday and month name. No all-caps, no emoji outside "emoji", no markdown, no em dashes.
- People: the creator (THE CREATOR, given with the description) is "you". Anyone else is "everyone", "the group" or a word from the app's subject (flatmates, players), never an invented personal name. Only a person the description names may appear by that name.
- Dates: only ones the description gives, said the way it gives them (Every Sunday, The last Thursday of the month). TODAY and a CALENDAR are given: read any date's weekday off the CALENDAR rather than working it out.`;

/**
 * Today, as the card is told it: the weekday, the date in words, the ISO
 * date and the time zone it is the date in. That is the creator's own zone
 * when their device sent one with Make it, and UTC when not.
 */
function todayLine(now = new Date(), zone = null) {
  return sketchDates.todayLine(now, zone);
}

function oneLine(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The creator as the card is told them: "Display name (@username)", or
 * "@username" without a display name. Context only: the card calls them
 * "you", and the name lets the model tell them apart from anyone their
 * description names.
 */
function makerLine(maker) {
  const username = oneLine(maker?.username, 40);
  const display = oneLine(maker?.displayName, 60);
  if (!username) return display || '';
  return display && display.toLowerCase() !== username.toLowerCase() ? `${display} (@${username})` : `@${username}`;
}

function sketchUserPrompt({ name, brief, audience, today = null, zone = null, maker = null }) {
  const creator = makerLine(maker);
  const now = today || new Date();
  return [
    `APP NAME:\n${String(name || '').slice(0, 120)}`,
    audience ? `WHO IT IS FOR:\n${String(audience).slice(0, 120)}` : null,
    `TODAY:\n${todayLine(now, zone)}`,
    `CALENDAR (each weekday's dates, this month and the next two):\n${sketchDates.calendarLines(sketchDates.localToday(now, zone)).join('\n')}`,
    creator ? `THE CREATOR (called "you" on the card):\n${creator}` : null,
    `WHAT IT SHOULD DO (the creator's words):\n${String(brief || '').slice(0, 4000)}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The model's reply as a card, or null when it has neither a usable tagline
 * nor usable points. A piece that is missing or unusable comes from the
 * fallback card; every line is cleaned and its dates held to the calendar
 * where the creator is (`today`, sketch-dates.localToday; `brief`, their
 * description).
 */
function parseCardReply(text, { name = '', brief = '', today = null, solo = false } = {}) {
  const out = String(text || '');
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  let obj;
  try {
    obj = JSON.parse(out.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const line = (value, max) => cleanLine(checkedDates(cleanLine(value, max), { today, brief }), max);
  let tagline = line(obj.tagline, TAGLINE_MAX);
  if (tagline && name && tagline.toLowerCase() === String(name).trim().toLowerCase()) tagline = '';
  const points = distinctPoints((Array.isArray(obj.points) ? obj.points : []).map((p) => line(p, POINT_MAX)), tagline)
    .slice(0, POINTS_MAX);
  if (!tagline && points.length < 2) return null;
  const fallback = (!tagline || points.length < 2) ? fallbackCard({ name, brief, today, solo }) : null;
  return {
    kind: 'card',
    emoji: chooseEmoji(obj.emoji, { name, brief }),
    tagline: tagline || fallback.tagline,
    points: points.length >= 2 ? points : distinctPoints([...points, ...fallback.points], tagline || fallback.tagline).slice(0, POINTS_MAX),
    source: 'model',
  };
}

/**
 * The card a row holds, as the made screen and an invite draw it:
 * { emoji, tagline, points }, or null for a row without one (a screen
 * sketch from before the card, or nothing usable).
 */
function cardOf(design) {
  if (!design || typeof design !== 'object' || design.kind !== 'card') return null;
  const emoji = iconEmoji(design.emoji) || DEFAULT_EMOJI;
  const tagline = typeof design.tagline === 'string' ? design.tagline.slice(0, TAGLINE_MAX + 1) : '';
  const points = Array.isArray(design.points)
    ? design.points.filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, POINT_MAX + 1)).slice(0, POINTS_MAX)
    : [];
  if (!tagline) return null;
  return { emoji, tagline, points };
}

// ── Documents ────────────────────────────────────────────────────────────

const RECORD_NOTE = 'The featured card this app\'s creator was shown while it was being made: its emoji (also the app\'s icon, '
  + 'set in dapp.json), a tagline and a few points that sum up the description in a few words. It is a picture of the '
  + 'idea, not a design: it shows no screen and sets no layout, words or colours. Build from the description in the '
  + 'first version\'s request; where the two differ, the description wins.';

/** design/sketch.json: the card, with what it is. */
function sketchRecord({ design, model, createdAt }) {
  const card = cardOf(design);
  return `${JSON.stringify({
    note: RECORD_NOTE,
    kind: 'featured-card',
    ...card,
    source: design?.source === 'model' ? 'model' : 'fallback',
    model: model || null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
  }, null, 2)}\n`;
}

/**
 * A dapp.json (its text) with the card's emoji as its `icon`, or null when it
 * already has one, or cannot be read: an icon somebody set is never replaced.
 */
function manifestWithIcon(text, emoji) {
  let manifest;
  try {
    manifest = JSON.parse(String(text || ''));
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.icon || !iconEmoji(emoji)) return null;
  const { description, ...rest } = manifest;
  return JSON.stringify({ ...(description !== undefined ? { description } : {}), icon: { emoji }, ...rest }, null, 2);
}

// ── Generation ───────────────────────────────────────────────────────────

const pending = new Map();

// A pending row older than this was left by a process that stopped while
// making it; it reads as failed, and nothing waits on it.
const STALE_PENDING_MS = 3 * 60 * 1000;

function stillDrawing(row, now = Date.now()) {
  return !!row && row.status === 'pending' && now - new Date(row.created_at).getTime() < STALE_PENDING_MS;
}

/** What the made screen is told: 'pending', 'ready' or 'failed' (a stale pending row is failed). */
function sketchStatus(row, now = Date.now()) {
  if (!row) return 'none';
  if (row.status === 'pending') return stillDrawing(row, now) ? 'pending' : 'failed';
  return row.status;
}

async function readSketch(pool, appId) {
  const { rows } = await pool.query(
    `SELECT app_id, status, design, html, model, error, committed_at, created_at, ready_at
       FROM app_sketches WHERE app_id = $1`,
    [appId]
  );
  return rows[0] || null;
}

/**
 * The creator, for the prompt: { username, displayName }. Read here because
 * the session's user carries no display name. Best effort: the username the
 * caller handed over when the read fails.
 */
async function makerOf(pool, user) {
  try {
    const { rows } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [user.id]);
    if (rows[0]) return { username: rows[0].username, displayName: rows[0].display_name || null };
  } catch (err) {
    log.warn('app-sketch', 'Creator not read', { userId: user?.id, err: err.message });
  }
  return { username: user?.username || null, displayName: null };
}

/**
 * The card's emoji as the project's icon, when it has none yet: an icon
 * somebody set (an emoji or an image) is never replaced. Open home screens
 * patch the tile in place (public/js/app.js handleAppUpdate). Best effort.
 */
async function saveIcon(pool, app, emoji, deps = {}) {
  try {
    const { rows } = await pool.query(
      `UPDATE apps SET icon_emoji = $2
        WHERE id = $1 AND icon_emoji IS NULL AND icon_image_id IS NULL
        RETURNING slug, icon_color`,
      [app.id, emoji]
    );
    if (!rows.length) return false;
    try {
      (deps.ws || require('./ws')).pushAppUpdate({
        action: 'icon_changed', appId: app.id, slug: rows[0].slug,
        iconEmoji: emoji, iconUrl: null, iconColor: rows[0].icon_color || null,
      });
    } catch (err) {
      log.warn('app-sketch', 'Icon broadcast failed', { appId: app.id, err: err.message });
    }
    return true;
  } catch (err) {
    log.warn('app-sketch', 'Icon not saved', { appId: app.id, err: err.message });
    return false;
  }
}

const TIMED_OUT = Symbol('timed out');

/** `promise`'s answer, or TIMED_OUT after `ms`. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function saveCard(pool, { app, card, model, error, deps }) {
  await pool.query(
    `UPDATE app_sketches
        SET status = 'ready', design = $2::jsonb, html = NULL, model = $3, error = $4, ready_at = NOW()
      WHERE app_id = $1`,
    [app.id, JSON.stringify(card), model, error]
  );
  await saveIcon(pool, app, card.emoji, deps);
}

/**
 * The card itself, from a name and a description: the model's, within
 * MODEL_WAIT_MS, else fallbackCard's. What it cost is recorded against
 * `user`. Saves nothing: generate() below stores it on a project, and the
 * App bench studio (services/bench/scaffold.js) puts it in a benchmark
 * trial's first commit, from the same call. `maker` is who the card is for,
 * as makerOf reads it (null: nobody named). Resolves { card, model, error }.
 */
async function makeCard(pool, { name, brief, audience = null, solo = false, timeZone = null, user, maker = null, appId = null, deps = {} }) {
  const llm = deps.llm || require('./llm');
  const limits = deps.limits || require('./limits');
  const now = deps.now ? deps.now() : new Date();
  const today = sketchDates.localToday(now, timeZone);
  let card = null;
  let model = SKETCH_MODEL;
  let error = null;
  const recordSpend = async (reply) => {
    if (!reply || !reply.usage || !user) return;
    try {
      await limits.recordSpend(pool, user.id, llm.estimateCostCents(reply.usage, reply.model || SKETCH_MODEL), { byok: false });
    } catch (err) {
      log.warn('app-sketch', 'Spend not recorded', { appId, err: err.message });
    }
  };
  try {
    if (deps.noModel || (typeof llm.isEnabled === 'function' && !llm.isEnabled())) throw new Error('LLM not initialized');
    const call = llm.generateAppSketch({
      system: SKETCH_SYSTEM,
      user: sketchUserPrompt({ name, brief, audience, today: now, zone: timeZone, maker }),
      model: SKETCH_MODEL,
      schema: CARD_SCHEMA,
      maxTokens: CARD_MAX_TOKENS,
      telemetryContext: { pool, appId },
    });
    const reply = await within(call, deps.modelWaitMs ?? MODEL_WAIT_MS);
    if (reply === TIMED_OUT) {
      error = 'timeout';
      // Paid for all the same, whenever it answers.
      call.then(recordSpend, () => {});
    } else {
      await recordSpend(reply);
      model = reply.model || SKETCH_MODEL;
      card = parseCardReply(reply.text, { name, brief, today, solo });
      if (!card) error = 'unusable_reply';
    }
  } catch (err) {
    error = String(err && err.message || 'failed').slice(0, 200);
  }
  if (!card) {
    card = fallbackCard({ name, brief, today, solo });
    model = 'fallback';
    log.warn('app-sketch', 'Card made without the model', { appId, error });
  }
  return { card, model, error };
}

async function generate(pool, { app, user, brief, audience, solo, timeZone, deps }) {
  const maker = await makerOf(pool, user).catch(() => null);
  const { card, model, error } = await makeCard(pool, {
    name: app.name, brief, audience, solo, timeZone, user, maker, appId: app.id, deps,
  });
  await saveCard(pool, { app, card, model, error, deps });
  log.info('app-sketch', 'Card ready', { appId: app.id, source: card.source });
  return readSketch(pool, app.id);
}

/**
 * Start a project's card, once. Returns at once; the work runs on. A project
 * with a sketch row already (a retried create) is left alone. Without a model
 * (no key: a staging preview, a local stack) the card is made from the
 * description on the spot. `timeZone` is the creator's device's IANA zone, so
 * "today" is theirs; anything else reads as UTC. `solo`: made for Just me, so
 * a fallback card does not say it is shared with anyone (SHARED_POINT).
 */
async function startSketch(pool, { app, user, brief, audience = null, solo = false, timeZone = null }, deps = {}) {
  const llm = deps.llm || require('./llm');
  if (!llm.isEnabled()) {
    const card = fallbackCard({ name: app.name, brief, solo, today: sketchDates.localToday(deps.now ? deps.now() : new Date(), timeZone) });
    const { rows } = await pool.query(
      `INSERT INTO app_sketches (app_id, user_id, status, design, model, ready_at)
       VALUES ($1, $2, 'ready', $3::jsonb, 'fallback', NOW())
       ON CONFLICT (app_id) DO NOTHING
       RETURNING app_id`,
      [app.id, user.id, JSON.stringify(card)]
    );
    if (!rows.length) return false;
    await saveIcon(pool, app, card.emoji, deps);
    return true;
  }
  const { rows } = await pool.query(
    `INSERT INTO app_sketches (app_id, user_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (app_id) DO NOTHING
     RETURNING app_id`,
    [app.id, user.id]
  );
  if (!rows.length) return false;
  const work = generate(pool, { app, user, brief, audience, solo, timeZone, deps }).catch((err) => {
    log.warn('app-sketch', 'Card failed', { appId: app.id, err: err.message });
    return null;
  });
  pending.set(app.id, work);
  work.finally(() => setTimeout(() => pending.delete(app.id), LATE_COMMIT_WAIT_MS).unref?.());
  return true;
}

/**
 * The project's card once it is ready, waiting up to `ms` for one still
 * being made by this process; null when there is none (or not in time).
 */
async function whenReady(pool, appId, ms = SKETCH_WAIT_MS, { pollMs = 1000 } = {}) {
  const deadline = Date.now() + ms;
  const work = pending.get(appId);
  if (work) {
    let timer;
    await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }
  let row = await readSketch(pool, appId).catch(() => null);
  // Made by another process (a create retried on another Pod): watch the
  // row instead, until the same deadline.
  while (stillDrawing(row) && Date.now() + pollMs <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    row = await readSketch(pool, appId).catch(() => null);
  }
  return row && row.status === 'ready' ? row : null;
}

/** The repository's design file for a ready card: design/sketch.json, or nothing for a row without a card. */
function designFiles({ sketch }) {
  if (!sketch || !cardOf(sketch.design)) return [];
  return [
    { path: 'design/sketch.json', content: sketchRecord({ design: sketch.design, model: sketch.model, createdAt: sketch.ready_at }) },
  ];
}

async function markCommitted(pool, appId) {
  await pool.query('UPDATE app_sketches SET committed_at = NOW() WHERE app_id = $1 AND committed_at IS NULL', [appId]);
}

/**
 * A card that missed the repository's first commit: committed on its own
 * when it is ready, design/sketch.json and, when the repository's dapp.json
 * has no icon yet, the card's emoji as its `icon` (else the next deploy would
 * clear the icon saved to the project). Best effort, never throws.
 */
async function commitWhenReady(pool, { appId, name, owner, repo }, deps = {}) {
  try {
    const sketch = await whenReady(pool, appId, LATE_COMMIT_WAIT_MS);
    if (!sketch || sketch.committed_at) return false;
    const files = designFiles({ sketch });
    if (!files.length) return false;
    const github = deps.github || require('./github');
    const card = cardOf(sketch.design);
    const manifest = typeof github.getFileContent === 'function'
      ? await github.getFileContent(owner, repo, 'dapp.json', 'main').catch(() => null)
      : null;
    const withIcon = manifest ? manifestWithIcon(manifest, card.emoji) : null;
    if (withIcon) files.push({ path: 'dapp.json', content: withIcon });
    await github.pushFiles(owner, repo, files, {
      message: `Add the card ${name} was made with`,
    });
    await markCommitted(pool, appId);
    return true;
  } catch (err) {
    log.warn('app-sketch', 'Late card not committed', { appId, err: err.message });
    return false;
  }
}

module.exports = {
  SKETCH_MODEL,
  CARD_SCHEMA,
  SKETCH_WAIT_MS,
  MODEL_WAIT_MS,
  SKETCH_SYSTEM,
  DEFAULT_EMOJI,
  KEYWORD_EMOJI,
  TAGLINE_MAX,
  POINT_MAX,
  POINTS_MAX,
  SHARED_POINT,
  iconEmoji,
  keywordEmoji,
  chooseEmoji,
  cleanLine,
  clausesOf,
  fallbackCard,
  parseCardReply,
  cardOf,
  sketchUserPrompt,
  todayLine,
  makerLine,
  sketchRecord,
  manifestWithIcon,
  readSketch,
  sketchStatus,
  saveIcon,
  makeCard,
  startSketch,
  whenReady,
  designFiles,
  markCommitted,
  commitWhenReady,
};
