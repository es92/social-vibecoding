'use strict';

// What the author of a visible change is told, when they declare it, about
// the data the before & after copies hold. The largest group of changes
// that ended with no shots (7 of 24 in about 125 merged proposals) were
// declared for a state the copies did not have: a request waiting for
// approval, standings players with activities, an answered plan, an invited
// account. The shots agent found that out on the copies, after the author
// had finished, so it is said here instead, while the author can still seed
// the data or say how to make it.
//
// Every visible declaration's answer lists the ready-made states (the demo
// states of shots-demo-states.js, which only Homeroom's own copies get) and
// where anything else must come from. A WARNING is added only for a declared
// change whose own words name a state from NEEDS that no ready-made state
// holds for its persona, and whose author gave no hints.setup: the steps the
// shots agent takes through the UI on both copies are the author saying how
// it is made.
// Advisory, like shots-identities.personaWarnings: a declaration is never
// refused for it.
//
// One need is not a state but an answer: a change whose steps ask the
// Homeroom bot (or an app's own AI feature) for something and wait for its
// reply. The copies have no model key, so the bot only says it cannot reach
// its model there; since the bot's own proposals got shots (#4487), its
// changes to its own replies ended that way (PR 4536's offer to close a
// request, 2026-10-09). No step through the UI and no ready-made state makes
// a model answer, so that warning is given whatever hints.setup says and
// whichever states are ready-made.
//
// Where a missing state comes from. The answer used to send every seed to a
// change merged before this one, because a seed this proposal adds reaches
// only the after copy. Most states the copies lacked were new in the
// proposal itself, and the after copy is the only side a new state needs:
// from 2026-10-09 to 10-12, 22 shot runs failed and 13 more changes were
// skipped for want of a state, PR 4825's new bell row for a change you voted
// on and PR 4765's "Did you mean" card from the bot among them. So the answer
// says to seed a new state in the same proposal, what a seed may hold (rows
// for the shots' fixture accounts and fake people, never a signal the code
// reads to decide something; a reply as the stored message), and that only
// a change to a state that already existed needs its seed merged first.
//
// Two needs the shots agent meets itself, on both copies alike: a step that
// chooses a file (it chooses one of the sample files, shots-samples.js) and
// a loading or error state behind one API GET (it holds or fails that
// request). The note names both, so an author says which in hints.setup.
//
// Pure: the declare route reads the app once and passes `selfApp`.

const { SAMPLE_NAMES } = require('../../worker/shots-samples');

// Each demo state in a few words, with who it is for (its persona and
// alsoFor), in shots-demo-states.js's order. tests/shots-ready-states.test.js
// keeps the two lists the same.
const READY_STATES = Object.freeze([
  ['shots-demo-proposal-vote-states-v1', 'a proposal voted on at an earlier version, its threshold moved', ['member']],
  ['shots-demo-member-visibility-proposal-v1', 'a proposal of yours to make the app private', ['member']],
  ['shots-demo-homeroom-bot-verdict-v1', 'a live Homeroom bot verdict with its build', ['read_only_admin', 'full_admin']],
  ['shots-demo-challenge-groups-v1', 'finished First challenges and an Always open challenge',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-challenge-standing-v1', 'your standing in the season and a challenge you finished', ['member']],
  ['shots-demo-member-friend-request-v1', 'a friend request waiting for you', ['member']],
  ['shots-demo-weekly-challenges-v1', 'a "This week" group of weekly challenges', ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-proposal-challenge-v1', 'a weekly challenge scored on sending a proposal, with its page',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-remix-v1', 'a remix of yours that offers Suggest this back', ['member']],
  ['shots-demo-member-request-awaiting-approval-v1', 'a request whose change (yours) waits for approval',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-standings-activities-v1', 'standings players with recorded point activities',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-standings-graded-v1', 'the grader\'s reason under a graded standings activity',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-first-version-thanks-v1', 'an answered first-version plan with Homeroom bot\'s thanks under it',
    ['member']],
  ['shots-demo-member-bot-close-offer-v1', 'your chat with Homeroom bot, ending in its offer to close a request',
    ['member']],
  ['shots-demo-member-bot-file-offer-v1', 'your chat with Homeroom bot, ending in its drafted request with File it and Not now',
    ['member']],
  ['shots-demo-member-app-access-v1', 'a project of yours with a GitHub repository, whose App settings can change its access',
    ['member']],
  ['shots-demo-room-to-make-v1', 'free app slots to make a project, which never finishes setting up on the copies',
    ['member', 'read_only_admin']],
  ['shots-demo-member-voted-change-live-v1', 'a change you voted on that went live, with its row in your bell',
    ['member']],
  ['shots-demo-member-bot-built-proposal-v1', 'a change Homeroom bot built from your request, up for a vote',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-checks-part-way-v1', 'a change of yours whose checks are part-way through',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-full-admin-allowance-low-v1', 'a weekly building allowance nearly spent (Settings says what is left, in red)',
    ['full_admin']],
  ['shots-demo-member-bot-rings-v1', 'Homeroom bot\'s needs-you rings in your bell', ['member']],
  ['shots-demo-member-request-queued-v1', 'a request of yours whose build waits its turn, on Homeroom bot\'s tab',
    ['member']],
  ['shots-demo-member-request-not-moving-v1', 'a request of yours nobody picked up, under Not moving on the bot\'s tab',
    ['member']],
  ['shots-demo-member-approved-checks-running-v1', 'a change of yours whose votes are in while its checks still run',
    ['member']],
  // 18 Nov 2026 (#6822): the work-status family. Each is a change of the
  // member's on a project they are in, whose rule is one yes.
  ['shots-demo-member-vote-update-running-v1', 'a change you can vote on while Homeroom bot is updating it',
    ['member']],
  ['shots-demo-member-approved-syncing-v1', 'an approved change catching up with main', ['member']],
  ['shots-demo-member-vote-after-update-v1', 'a change back up for a vote once its update has landed', ['member']],
].map(([id, name, personas]) => Object.freeze({ id, name, personas: Object.freeze(personas) })));

// The states a declared change can need that a copy holds only when
// something wrote them, in the words authors use for them, and the ready-
// made states that hold each on Homeroom's copies (none: no ready-made state
// does). Phrases, not single words: "plan" or "invite" alone name a screen
// far more often than a state.
const NEEDS = Object.freeze([
  {
    needs: 'a change waiting for approval',
    test: /\b(?:wait(?:s|ing)? (?:for|on) (?:\w+ )?approval|awaits? (?:\w+ )?approval|awaiting (?:\w+ )?approval|up for (?:a |the )?vote)\b/i,
    states: ['shots-demo-member-request-awaiting-approval-v1', 'shots-demo-proposal-vote-states-v1',
      'shots-demo-member-visibility-proposal-v1'],
  },
  {
    needs: 'standings rows with recorded activities',
    test: /\b(?:standings?|leaderboard)\b[\s\S]*\bactivit(?:y|ies)\b|\bactivit(?:y|ies)\b[\s\S]*\b(?:standings?|leaderboard)\b/i,
    states: ['shots-demo-standings-activities-v1'],
  },
  {
    needs: 'an answered first-version plan',
    test: /\b(?:answered (?:the |its |their |a )?plan|plan (?:was |is )?answered|thanks? (?:you )?for answering|first[- ]version'?s? plan)\b/i,
    states: ['shots-demo-member-first-version-thanks-v1'],
  },
  // The changes that ended with no shots from 9 to 12 October 2026, in their
  // own words: PR 4825, 4736 and 4622, 4763, 4733, 4829.
  {
    needs: 'a change you voted on that went live',
    test: /\b(?:change|proposal)s? (?:you|they|the member|people|someone) voted (?:on|for) (?:is|goes|went|has gone|going) live\b/i,
    states: ['shots-demo-member-voted-change-live-v1'],
  },
  {
    needs: 'a change Homeroom bot built from a request',
    test: /\b(?:homeroom[_ ]?)?bot (?:built|made) (?:it |a change |the change )?(?:from|for) (?:your|the member's|their|a member's|my|a) (?:own )?request\b|\b(?:change|proposal)s? (?:built|made) by (?:the )?homeroom[_ ]?bot\b/i,
    states: ['shots-demo-member-bot-built-proposal-v1'],
  },
  {
    needs: 'a Homeroom bot hand-off that needs a person to decide',
    test: /\bneeds? a (?:person|human|decision)\b|\bwho decides\b/i,
    // 18 Nov 2026: a request's hand-off is said on its page now, not in the
    // chat with the bot, and the state that drew it in the chat is retired.
    // Nothing ready-made holds it, so a change that needs it is told so.
    states: [],
  },
  {
    // 16 Oct 2026: how the bot's rings read in the bell.
    needs: 'Homeroom bot\'s rings in the bell',
    test: /\bhomeroom[_ ]?bot'?s? (?:rings?|notifications?)\b|\bbell\b[^.]{0,80}\bhomeroom[_ ]?bot\b|\bhomeroom[_ ]?bot\b[^.]{0,80}\bbell\b/i,
    states: ['shots-demo-member-bot-rings-v1'],
  },
  {
    needs: 'checks part-way through',
    test: /\bchecks? (?:are |is )?(?:still )?(?:mid[- ]?run|part[- ]?way|half[- ]?way|part done|half done)\b|\b(?:mid[- ]?run|part[- ]?way through)\b|\bwhile (?:a |the |its )?(?:change's |proposal's )?(?:checks|tests) (?:run|are running)\b/i,
    states: ['shots-demo-member-checks-part-way-v1'],
  },
  {
    needs: 'a weekly allowance nearly spent',
    test: /\b(?:allowance|credits?|budget)(?: \w+){0,2} (?:is |are )?(?:almost|nearly|mostly) (?:spent|used up|used|gone)\b|\bcredits? pill\b[^.]{0,30}\bred\b|\blow[- ](?:credits?|balance|allowance)\b/i,
    states: ['shots-demo-full-admin-allowance-low-v1'],
  },
  {
    // 18 Nov 2026: Main Chat is gone, and a request waiting its turn is a row
    // of Homeroom bot's tab (Waiting & in progress), never a card in a chat.
    needs: 'a request waiting its turn to be built',
    test: /\bwait(?:s|ing)? (?:its|their|for its|for their) turn\b|\bqueued (?:request|build)s?\b|\b(?:number|no\.) \d+ in line\b|\bin line to (?:be )?buil[dt]\b|\bready to build\b/i,
    states: ['shots-demo-member-request-queued-v1'],
  },
  {
    needs: 'a request nobody has picked up (Not moving)',
    test: /\bnot moving\b|\bnobody (?:has )?(?:picked|started) (?:it |them )?up\b|\bnot picked up\b/i,
    states: ['shots-demo-member-request-not-moving-v1'],
  },
  {
    needs: 'a change whose votes are in while its checks still run',
    test: /\b(?:votes? (?:are |is )?(?:all )?in|approved)\b[^.]{0,60}\b(?:checks?|tests?) (?:are |is )?(?:still )?run(?:s|ning)?\b|\bapproved,? (?:and )?(?:still )?checking\b/i,
    states: ['shots-demo-member-approved-checks-running-v1'],
  },
  {
    // 18 Nov 2026 (#6822): PR #6819's change, whose shots found no change
    // being updated on either copy.
    needs: 'a Homeroom bot update running on a change (Updating)',
    test: /\bupdat(?:e|es|ing)\b[^.]{0,60}\b(?:is |on its way|running|coming|in progress)\b|\bbeing updated\b|\bupdating\b/i,
    states: ['shots-demo-member-vote-update-running-v1'],
  },
  {
    // 18 Nov 2026 (#6822): an approved change catching up with main.
    needs: 'a change syncing with main',
    test: /\bsync(?:s|ed|ing)? (?:with|to) main\b|\bcatch(?:es|ing)? up with main\b|\bsyncing with main\b/i,
    states: ['shots-demo-member-approved-syncing-v1'],
  },
  { needs: 'a friend request', test: /\bfriend requests?\b/i, states: ['shots-demo-member-friend-request-v1'] },
  { needs: 'a remix', test: /\b(?:remix(?:ed|es)?|suggest (?:this|it) back)\b/i, states: ['shots-demo-member-remix-v1'] },
  {
    needs: 'a member in their first session (its tour)',
    test: /\b(?:first[- ]session|onboarding tour|the tour|tour(?:'s)? (?:last |first )?card)\b/i,
    states: [],
  },
  {
    // The invited fixtures (#4437) hold this on Homeroom's own copies: the
    // link itself for a signed-out visitor, the two invited members for the
    // personas they are shot as.
    needs: 'an account somebody invited',
    test: /\b(?:invited (?:\w+ )?(?:member|person|people|user|account|friend)s?|(?:member|person|user|account)s? (?:who|that) (?:was|were|has been|have been) invited|accept(?:ed|s|ing)? (?:an|the|their) invit(?:e|ation))\b/i,
    states: ['platform-guest-invite-link-v1', 'platform-invited-member-first-visit-v1',
      'platform-invited-member-listed-v1'],
  },
  // The listed invited member is on the platform waitlist, joined by email.
  { needs: 'an account on the waitlist', test: /\bwait[- ]?list(?:ed)?\b/i,
    states: ['platform-invited-member-listed-v1'] },
  {
    // Words that make the bot answer, not ones that describe what it already
    // said: "ask the Homeroom bot to close it" and "the bot replies", never
    // "the bot's offer" or "your chat with Homeroom bot".
    needs: 'a live reply from a model (the Homeroom bot, or an app\'s own AI feature)',
    test: /\b(?:ask(?:s|ed|ing)?|tell(?:s|ing)?|told|messag(?:ed|ing)|dm(?:s|ed)?|writ(?:es?|ing) to|wrote to|send(?:s|ing)?|sent|mention(?:s|ed|ing)?) (?:the |your )?(?:@?homeroom[_ ]?)?(?:bot|assistant|ai)(?![\w-])|\b(?:@?homeroom[_ ]?)?(?:bot|assistant|ai) (?:answers|replies|responds|triages)\b/i,
    states: [],
    live: true,
  },
  {
    needs: 'an empty state, or an account with nothing of its own yet',
    test: /\b(?:new (?:user|member|account|player)s?|brand[- ]new (?:user|member|account)s?|first[- ]time (?:user|member|visitor)s?|(?:has|have)(?:n't| not| never) (?:\w+ ){0,2}yet|no \w+ (?:\w+ )?yet|empty state)\b/i,
    states: [],
    // The guest browser IS a visitor with nothing yet; the invited members
    // are fixtures whose own fresh state is the fixture (#4437).
    skipPersonas: ['guest', 'invited_member', 'invited_member_listed'],
  },
]);

const SEEDS = Object.freeze({
  self: 'the staging seeds in src/db/migrate.js',
  child: 'the app\'s own staging seed (its IS_STAGING seed)',
});

// Fixture entries (shots-fixtures.js) a need can be held by, beside the
// ready-made states: people the platform's paired copies are seeded with,
// each with the personas it is shot as. Homeroom's own copies only — a child
// app's have none, and their needs stay warned about.
const FIXTURE_STATES = Object.freeze({
  'platform-guest-invite-link-v1': ['guest'],
  'platform-invited-member-first-visit-v1': ['invited_member'],
  'platform-invited-member-listed-v1': ['invited_member_listed'],
});

// What a seed may hold. The platform's seed rule ("seed fake identities
// only, never rows owned by whoever opened the preview, never a signal your
// own logic reads", app-conventions.md) still holds: a fixture account is one
// named account, not whoever opens the preview, and a seed that answers the
// question the change's own code asks hides that code from every check.
const SEED_RULE = 'A seed is idempotent and obviously fake: rows for the shots\' fixture accounts (usernode-capture '
  + 'is the member) and fake people, never a signal the code reads to decide something.';

// Which side a seed reaches, and so which proposal it belongs in.
const SEED_SIDES = 'A seed this proposal adds reaches only the after copy, which is the side a state new in this '
  + 'proposal needs: seed such a state in this proposal. A change to a state that already existed needs it on both '
  + 'copies, so its seed merges first, in its own proposal. '
  // 18 Nov 2026 (#6822): said outright, because the bot declared PR #6819's
  // change for a state the copies had no data for though this answer had
  // said where data comes from.
  + 'A claim about a screen that already exists (a story whose baseState is "present") therefore needs a '
  + 'ready-made state these copies already hold, from availableStates: declare it against one, and a seed in this '
  + 'proposal cannot stand in for it.';

/** Pure: a declared change's own words, as one line. */
function wordsOf(story) {
  const intent = story && typeof story.intent === 'object' ? story.intent : {};
  const steps = Array.isArray(intent.steps) ? intent.steps : [];
  return [story?.claim, intent.checkpoint, ...steps].filter((part) => typeof part === 'string').join(' ');
}

function hasSetup(story) {
  const setup = story?.intent?.hints?.setup;
  return typeof setup === 'string' && setup.trim().length > 0;
}

/**
 * What a declaration's answer says about the copies' data, or null for one
 * with nothing to shoot: `availableStates` (each ready-made state, by name,
 * with its personas: none for a child app), `dataNote` (where everything
 * else comes from) and `warnings` (see the top of this file).
 */
function declarationAdvice(intent, { selfApp = false } = {}) {
  const stories = Array.isArray(intent?.stories) ? intent.stories.filter((s) => s && typeof s === 'object') : [];
  if (intent?.impact === 'none' || !stories.length) return null;
  const available = selfApp ? READY_STATES : [];
  const personasOf = new Map(available.map((state) => [state.id, state.personas]));
  const seeds = selfApp ? SEEDS.self : SEEDS.child;
  const lacking = new Map();
  for (const story of stories) {
    const setup = hasSetup(story);
    const words = wordsOf(story);
    for (const need of NEEDS) {
      if ((need.skipPersonas || []).includes(story.persona)) continue;
      // A ready-made state helps only a change shot as somebody it is for:
      // the nearly spent allowance is the full admin's, not the member's.
      // The invited fixtures hold theirs the same way (#4437).
      const heldForThem = need.states.some((id) => personasOf.has(id)
        && (!story.persona || personasOf.get(id).includes(story.persona)))
        || (selfApp && need.states.some((id) => FIXTURE_STATES[id]
          && (!story.persona || FIXTURE_STATES[id].includes(story.persona))));
      if (!need.live && (setup || heldForThem)) continue;
      if (!need.test.test(words)) continue;
      if (!lacking.has(need)) lacking.set(need, []);
      lacking.get(need).push(String(story.id || 'A declared change'));
    }
  }
  const warnings = [...lacking].map(([need, ids]) => {
    const lead = `${ids.join(', ')} ${ids.length > 1 ? 'seem' : 'seems'} to need ${need.needs}, and `;
    if (need.live) {
      return `${lead}nothing on these copies answers with a model: they have no model key, so the Homeroom bot `
        + 'is switched off there and says only that. Never make a step wait for a reply: start from '
        + `${selfApp ? 'a ready-made state that already holds it (see availableStates)' : 'a reply the copies already hold'}, `
        + `or seed the reply in ${seeds} as the stored message. ${SEED_SIDES}`;
    }
    const holders = [...new Set(need.states.filter((id) => personasOf.has(id)).flatMap((id) => personasOf.get(id)))];
    if (holders.length) {
      const who = holders.join(' or ');
      return `${lead}the ready-made state that holds it on these copies is for ${who} (see availableStates). `
        + `Declare the change for ${holders.length > 1 ? 'one of them' : who}, or add hints.setup with the steps `
        + `that make it through the UI, which the shots agent takes on both copies, or seed it in ${seeds}. ${SEED_SIDES}`;
    }
    return `${lead}${selfApp ? 'no ready-made state on these copies holds it (see availableStates)'
      : 'this app\'s copies have no ready-made states'}. Add hints.setup with the steps that make it through `
      + `the UI, which the shots agent takes on both copies, or seed it in ${seeds}. ${SEED_SIDES}`;
  });
  return {
    availableStates: available.map(({ name, personas }) => ({ name, personas: [...personas] })),
    dataNote: `${selfApp ? 'Homeroom\'s before & after copies hold its staging seeds and the ready-made states in '
      + 'availableStates, on both sides' : `This app's before & after copies hold what ${seeds} writes, and no `
      + 'ready-made states'}. Anything else a change needs comes from hints.setup steps the shots agent takes `
      + `through the UI on both copies, or from ${seeds}. `
      + 'Each signed-in persona is its own account, so a step somebody else takes (a reply to the member\'s '
      + 'message, a vote on their change) can be one of those steps, in another persona\'s browser. '
      + `${SEED_RULE} ${SEED_SIDES} `
      + 'Where a step chooses a file, the shots agent chooses one of Homeroom\'s sample files '
      + `(${SAMPLE_NAMES.join(', ')}), and it can hold or fail one API GET on both copies to show a loading or `
      + 'error state: name the file or the request in hints.setup. '
      + `Nothing on them answers with a model${selfApp ? ', the Homeroom bot included' : ''}: they have no model key, `
      + 'so seed a reply as the stored message rather than asking for it.',
    warnings,
  };
}

module.exports = { READY_STATES, NEEDS, declarationAdvice };
