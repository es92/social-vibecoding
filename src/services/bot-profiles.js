'use strict';

// Homeroom bot's thread kinds, each with its profile (docs/plans/bot-one-model.md,
// step 5). A thread is the unit the bot answers in: a person's chat with it
// (Main, a private thread in it, a design thread), or a project's thread (a
// request's, a change's, its chat or a topic, a reply thread). Each kind's
// profile is data: the surface that runs its turn on the turn engine, the
// scope of the tools it offers (src/services/bot-tools/), the tools it may
// offer, its limits, the prompt section it speaks from, and, on a project's
// thread, when it speaks (`speaks`, the rules src/services/homeroom-bot-
// voice.js gate runs in this order). The surfaces read their limits from
// here; tests/bot-profiles.test.js holds each surface to its profile.
//
// When the bot speaks is unchanged (decision 9): today's rules, written down.

const KINDS = Object.freeze(['main', 'private', 'design', 'request', 'change', 'channel', 'reply']);

// A project's thread kind, by the place type the chat stores it under.
const PLACE_KIND = Object.freeze({ issue: 'request', session: 'change', chat: 'channel', category: 'channel', message: 'reply' });

// A person's chat with the bot: Main, and a private thread in it.
const CHAT_LIMITS = Object.freeze({
  rounds: 16,
  readsPerTurn: 8,
  // Task 2020: a long answer's reply carries its words and the same answer
  // laid out as HTML (homeroom-bot-html.js), so a round has twice the room
  // it had (4000, retried at 8000). Every provider of the bot's model takes
  // far more (OpenRouter's endpoints list 131,072 and up, 6 Nov 2026), and
  // room that is not written is not paid for.
  outputTokens: 8000,
  retryOutputTokens: 16000,
  requestTimeoutMs: 90_000,
  turnsPerHour: 120,
  history: 24,
  // Offers under one reply (bot-cards.js MAX_PER_REPLY).
  offers: 3,
  // Cards a reply names (requests, changes, projects).
  cards: 3,
});

// A project's thread: one reply, short and quick, by the place's rules.
const THREAD_LIMITS = Object.freeze({
  rounds: 8,
  readsPerTurn: 4,
  // Task 2020 follow-up: a reply longer than two short lines carries its
  // laid-out copy beside its words (homeroom-bot-html.js), so a round has
  // room for both (it was 900). Room that is not written is not paid for.
  outputTokens: 4000,
  requestTimeoutMs: 45_000,
  turnsPerHour: 30,
  replyChars: 2000,
  offers: 1,
  answerWindowMinutes: 60,
  continueMinutes: 30,
});

const DESIGN_LIMITS = Object.freeze({
  rounds: 12,
  drawByRound: 8,
  readUntilRound: 7,
  // #6358: a long screen (a recipe home) is drawn to the end. A step gets
  // four times the room it had (4096), a draw cut off at its limit is asked
  // again with twice that, and a step may take three minutes instead of a
  // minute and a half. Room that is not written is not paid for.
  outputTokens: 16000,
  retryOutputTokens: 32000,
  requestTimeoutMs: 180_000,
  history: 16,
  replyChars: 1500,
  editsPerCall: 16,
});

const CHAT_TOOLS = Object.freeze([
  'progress', 'my_work', 'request_detail', 'my_projects', 'list_source', 'read_source', 'get_spec', 'answer_question',
  'revise_proposal', 'comment_on_request', 'start_request', 'offer_request', 'offer_move_request',
  'offer_copy_request', 'offer_close_request', 'withdraw_proposal', 'draw_screen', 'close_thread',
  'report_problem', 'start_project_thread', 'offer_new_project', 'reply',
]);
const DESIGN_TOOLS = Object.freeze([
  'write_screen', 'edit_design', 'list_source', 'read_source', 'reply', 'read_plan', 'compare_versions',
  'make_pictures', 'close_thread', 'offer_plan', 'offer_project', 'list_requests', 'get_request', 'capture_page',
]);
// Every project thread offers these; each kind adds its own.
const THREAD_TOOLS = Object.freeze([
  'reply', 'stay_quiet', 'request_detail', 'read_message', 'list_source', 'read_source', 'update_change',
  'update_change_description', 'let_try_again', 'tell_me_when', 'get_change', 'get_discussion', 'list_requests',
]);

// The checks every project thread makes first, in this order
// (homeroom-bot-voice.js gate).
const THREAD_CHECKS = Object.freeze([
  'switched_on', 'not_paused', 'a_person', 'a_plain_message', 'connector_place', 'not_relayed', 'has_the_bot', 'connector_loop',
]);

const profile = (kind, fields) => Object.freeze({ kind, ...fields });

const PROFILES = Object.freeze({
  main: profile('main', {
    surface: 'chat', scope: 'main', prompt: 'main', limits: CHAT_LIMITS, tools: CHAT_TOOLS, threadTools: true, platformReads: true,
  }),
  // A private thread in their chat (an ask, a draft, an idea), and a
  // request card's thread from before (decision 10): the chat's turn, told
  // which thread it is in.
  private: profile('private', {
    surface: 'chat', scope: 'main', prompt: 'private', limits: CHAT_LIMITS, tools: CHAT_TOOLS, threadTools: true, platformReads: true,
  }),
  design: profile('design', {
    surface: 'design', scope: 'design', prompt: 'design', limits: DESIGN_LIMITS, tools: DESIGN_TOOLS,
  }),
  request: profile('request', {
    surface: 'thread', scope: 'thread', prompt: 'request', places: ['issue'], limits: THREAD_LIMITS,
    tools: Object.freeze([...THREAD_TOOLS, 'get_spec', 'start_request', 'offer_close_request', 'offer_copy_request', 'offer_withdraw', 'change_plan', 'make_pictures', 'attach_files', 'show_change', 'list_change_files']),
    // Words passed on as a change are the follow-up's; the bot's own change
    // up for a vote answers anyone; the requester or an admin straight after
    // a post of the bot's is answering it; else only a mention or a reply,
    // and never one that answers its question (the build reads that).
    speaks: Object.freeze([...THREAD_CHECKS, 'not_queued_as_ask', 'own_change_up', 'followed_a_post', 'go_ahead_reply', 'addressed_or_stop', 'not_an_answer', 'speak_addressed']),
  }),
  change: profile('change', {
    surface: 'thread', scope: 'thread', prompt: 'change', places: ['session'], limits: THREAD_LIMITS,
    // #6389: the change's author (or its request's requester, once it is
    // abandoned) may ask the bot to make its own version of a change made
    // outside Homeroom.
    tools: Object.freeze([...THREAD_TOOLS, 'get_spec', 'offer_withdraw', 'make_own_version', 'make_pictures', 'attach_files', 'show_change', 'list_change_files']),
    speaks: Object.freeze([...THREAD_CHECKS, 'not_queued_as_ask', 'own_change', 'followed_change_post', 'addressed']),
  }),
  channel: profile('channel', {
    surface: 'thread', scope: 'thread', prompt: 'channel', places: ['chat', 'category'], limits: THREAD_LIMITS,
    tools: Object.freeze([...THREAD_TOOLS, 'offer_request', 'offer_close_request']),
    speaks: Object.freeze([...THREAD_CHECKS, 'addressed']),
  }),
  reply: profile('reply', {
    surface: 'thread', scope: 'thread', prompt: 'reply', places: ['message'], limits: THREAD_LIMITS,
    tools: Object.freeze([...THREAD_TOOLS, 'offer_request', 'offer_close_request', 'make_pictures', 'attach_files']),
    speaks: Object.freeze([...THREAD_CHECKS, 'addressed', 'continued']),
  }),
});

/** A thread kind's profile; throws for a kind there is none of. */
function profileOf(kind) {
  const found = PROFILES[kind];
  if (!found) throw new Error(`bot-profiles: no thread kind ${kind}`);
  return found;
}

/** The kind of a project's thread, by its place ({ type, ref }), or null. */
function kindOfPlace(place) {
  return PLACE_KIND[place?.type] || null;
}

/** A project thread's profile, by its place. */
function profileOfPlace(place) {
  const kind = kindOfPlace(place);
  return kind ? PROFILES[kind] : null;
}

/**
 * The kind of a thread in a person's chat with the bot, by what the chat
 * found it to be: a design thread, a private thread (or a request card's
 * thread from before), else Main.
 */
function kindInChat({ design = null, threadRootId = null, threadRequest = null } = {}) {
  if (design) return 'design';
  if (threadRootId || threadRequest) return 'private';
  return 'main';
}

module.exports = {
  KINDS, PLACE_KIND, CHAT_LIMITS, THREAD_LIMITS, DESIGN_LIMITS, THREAD_CHECKS, PROFILES,
  profileOf, kindOfPlace, profileOfPlace, kindInChat,
};
