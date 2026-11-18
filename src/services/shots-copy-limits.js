'use strict';

// What the before & after copies cannot show, said wherever an author is
// asked to declare visible changes: the Homeroom bot's build lines
// (homeroom-bot-live.js buildVisibleChangesLines), a connector work order
// (external-agent-tasks.js) and the connector charter (mcp-charter.js). The
// conventions ("Who the before & after shots see") and
// docs/proposal-visuals/before-after-shots.md say the same in prose.
//
// In the week to 18 Nov 2026, 31% of Homeroom's own settled shots runs
// failed (10 to 17% for other apps), most as shots_capture_incomplete: a
// change declared for a state these copies cannot reach. The bot's own
// replies and cards (PRs 6785, 6784, 6690, 6682, 6676, 6662: the bot is
// switched off on the copies), a new project's setup (6725, 6716), a failed
// POST (6724), the phone app's bridge (6773) and two requests racing
// (6727). The shots agent found that out after the author had finished; the
// author knows it while building, so it is said then, with the two ways out:
// seed the state in the same change, or declare impact none and say why.

// Each limit, as a clause that follows "The copies cannot show everything:".
const COPY_LIMITS = Object.freeze([
  'Homeroom bot is switched off there and says only that, so none of its replies, working cards, plans or builds'
    + ' appear unless a seed writes them, and an app\'s own AI features get no answer',
  'a new project never finishes setting up there, so nothing after making, remixing or importing one (from an app'
    + ' template too) can be shown',
  'a controlled failure covers one API GET, never a POST, PUT or DELETE',
  'there is no native phone app, so anything only its bridge shows cannot be shown',
  'two requests cannot be made to race, so a state only a race reaches cannot be staged',
]);

// Where the seed goes, for any app the author may be building.
const SEED_PLACE = 'the app\'s staging seed (its IS_STAGING block; for Homeroom itself, the staging seeds in'
  + ' src/db/migrate.js)';

// What to do about it.
const COPY_LIMITS_RULE = 'Before you declare a change, check that the copies can reach its state. When they cannot,'
  + ` either seed it in this same change (stored rows or a stored message, in ${SEED_PLACE}) or declare impact "none"`
  + ' with a reason that names what the copies cannot do. Never declare a state the copies cannot reach.';

/**
 * The limits and, unless `rule` is false, the rule, as one paragraph. A
 * connector work order keeps its own rule for a state that can be neither
 * reached nor seeded (AGENTS.md), so it takes the limits alone. Pure.
 */
function copyLimitsText({ rule = true } = {}) {
  const limits = `The copies cannot show everything: ${COPY_LIMITS.join('; ')}.`;
  return rule ? `${limits} ${COPY_LIMITS_RULE}` : limits;
}

/**
 * The same paragraph as lines of at most `width` characters, each with
 * `indent` before it, for a prompt written as an array of lines. Pure.
 */
function copyLimitsLines({ width = 115, indent = '', rule = true } = {}) {
  const lines = [];
  let line = '';
  for (const word of copyLimitsText({ rule }).split(' ')) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(`${indent}${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(`${indent}${line}`);
  return lines;
}

module.exports = { COPY_LIMITS, COPY_LIMITS_RULE, SEED_PLACE, copyLimitsText, copyLimitsLines };
