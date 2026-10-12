'use strict';

// The Homeroom bot's fixed notes, said in its own voice in Homeroom.
//
// Each note the bot posts on a request is written once and sent to two
// places: a GitHub comment, which GitHub shows under the platform's app
// account, and a message in the request's (or change's) Homeroom thread,
// which Homeroom draws as the bot's own bubble. The notes were written for
// the first of the two ("Homeroom bot has a question before it can build
// this", "Homeroom bot updated this change: …"), and in Homeroom they read
// as somebody narrating the bot under the bot's own name and picture.
//
// `firstPerson` is the Homeroom copy of a note: the same words, said by the
// bot. GitHub keeps the note as written. It knows each fixed sentence the
// bot's notes are built from (homeroom-bot-live.js, homeroom-bot-followup.js,
// homeroom-bot-holds.js, homeroom-bot-dm.js FAILED_SAID.bot) and leaves
// everything else (the model's own words in a note, a reason, a question)
// alone. tests/homeroom-bot-words.test.js runs every one of those notes
// through it, so a new note that still speaks about the bot fails there.
//
// Pure.

const FIRST_PERSON = Object.freeze([
  // A follow-up's answer needs no header: the bubble already says who.
  [/^Homeroom bot, about this change:\s*\n+/, ''],
  [/Homeroom bot is looking at this request\. It will reply here with a question if something is unclear, a note if a person needs to decide, or a change to vote on if it can build it\./,
    'I\'m looking at this request. I\'ll reply here with a question if something is unclear, a note if a person needs to decide, or a change to vote on if I can build it.'],
  // "Issue" is GitHub's word: in Homeroom the request is where you reply.
  [/ \(or on the GitHub issue\)/g, ''],
  [/Homeroom bot has two questions before it can build this:/, 'I have two questions before I can build this:'],
  [/Homeroom bot has a question before it can build this:/, 'I have a question before I can build this:'],
  [/Homeroom bot has a question before it updates this change:/, 'I have a question before I update this change:'],
  [/Homeroom bot thinks a person needs to decide this one:/, 'I think a person needs to decide this one:'],
  [/Homeroom bot thinks a person should take this one from here:/, 'I think a person should take this one from here:'],
  [/Homeroom bot thinks this is about Homeroom itself, not /, 'I think this is about Homeroom itself, not '],
  [/can have Homeroom bot move it to Homeroom's own board\./, 'can have me move it to Homeroom\'s own board.'],
  [/can say Go ahead in a chat with Homeroom bot, or reply here\./, 'can say Go ahead in a chat with me, or reply here.'],
  [/Homeroom bot couldn't find anything to build in this request:/, 'I couldn\'t find anything to build in this request:'],
  [/Homeroom bot built this\. It's up for a vote:/, 'I built this. It\'s up for a vote:'],
  [/Homeroom bot's change for this is live:/, 'My change for this is live:'],
  [/Homeroom bot will build this when one of its (\d+|several|many) changes (on|across)/, 'I\'ll build this when one of my $1 changes $2'],
  [/Homeroom bot has (a question about|a plan for|a note on) this request, but it has already posted/, 'I have $1 this request, but I\'ve already posted'],
  [/It will come back to it once\b/g, 'I\'ll come back to it once'],
  [/Homeroom bot started on this and found it cannot be built as asked:/, 'I started on this and found it can\'t be built as asked:'],
  [/, so Homeroom bot is building the plan above now\./, ', so I\'m building the plan above now.'],
  [/Homeroom bot's first try at building this didn't finish, so it is trying once more from the same plan\./,
    'My first try at building this didn\'t finish, so I\'m trying once more from the same plan.'],
  [/Homeroom bot wrote a plan for this request and is building it now\./, 'I wrote a plan for this request and I\'m building it now.'],
  [/Homeroom bot wrote a plan for this request, with its before and after screens, and will build it once/,
    'I wrote a plan for this request, with its before and after screens, and will build it once'],
  [/or it goes with what it suggests:/g, 'or I\'ll go with what I suggest:'],
  [/Homeroom bot's plan for this request/g, 'My plan for this request'],
  [/It builds nothing until the person who asked says so:/, 'I\'ll build nothing until the person who asked says so:'],
  [/Homeroom bot is building the plan that was approved/, 'I\'m building the plan that was approved'],
  [/It is building it now\./, 'I\'m building it now.'],
  [/and it will plan it again\./g, 'and I\'ll plan it again.'],
  [/Homeroom bot updated the plan for this change to match/, 'I updated the plan for this change to match'],
  [/Homeroom bot updated this change:/, 'I updated this change:'],
  [/Homeroom bot couldn't update this change: it has already updated it as many times as it may on its own,/,
    'I couldn\'t update this change: I\'ve already updated it as many times as I may on my own,'],
  [/Homeroom bot is working on it…/, 'I\'m working on it…'],
  [/Homeroom bot saw your message, but another update to this change is running right now\. It will answer once that finishes\./,
    'I saw your message, but another update to this change is running right now. I\'ll answer once that finishes.'],
  [/Homeroom bot saw your message, but the building time for this request is used up for this week\. It will answer when the week resets\./,
    'I saw your message, but the building time for this request is used up for this week. I\'ll answer when the week resets.'],
  [/Homeroom bot saw your message, but it has used its own budget for now\. It will answer once it has room again\./,
    'I saw your message, but I\'ve used my own budget for now. I\'ll answer once I have room again.'],
  [/Homeroom bot saw your message, but it is paused on this project, so it will answer once an admin turns it back on\./,
    'I saw your message, but I\'m paused on this project, so I\'ll answer once an admin turns me back on.'],
  [/Homeroom bot couldn't answer this time( either)?: it ran out of time\./, 'I couldn\'t answer this time$1: I ran out of time.'],
  [/Homeroom bot couldn't answer this time( either)?: its answer came back unreadable\./, 'I couldn\'t answer this time$1: my answer came back unreadable.'],
  [/Homeroom bot couldn't answer this time( either)?: something went wrong while it worked on it\./,
    'I couldn\'t answer this time$1: something went wrong while I worked on it.'],
  [/Homeroom bot couldn't answer this time( either)?:/, 'I couldn\'t answer this time$1:'],
  [/It will try again soon\./, 'I\'ll try again soon.'],
  [/Homeroom bot ran out of time (fixing|adding)\b/, 'I ran out of time $1'],
  [/It is trying once more\./, 'I\'m trying once more.'],
  [/Homeroom bot can't get this change working on its own:/, 'I can\'t get this change working on my own:'],
  [/Homeroom bot can't get this change past its checks on its own:/, 'I can\'t get this change past its checks on my own:'],
  [/Homeroom bot (fixed (?:the failing checks|what didn't work) on this change|added what this change's before and after screens need):/, 'I $1:'],
  // Why a fix of its checks stopped (homeroom-bot-followup.js whySentence).
  [/Homeroom bot has already updated it (\d+) times, as many as it may on its own\./, 'I\'ve already updated it $1 times, as many as I may on my own.'],
  [/Homeroom bot's attempt to fix them\b/, 'My attempt to fix them'],
  // A build or an update that did not finish (homeroom-bot-dm.js FAILED_SAID.bot).
  [/the (\w+) took longer than it's allowed\./, 'the $1 took longer than I\'m allowed.'],
  [/Homeroom bot built (.+?), but couldn't put it up for approval\./, 'I built $1, but couldn\'t put it up for approval.'],
  [/: it ended up with no changes to show\./, ': I ended up with no changes to show.'],
  [/Homeroom bot couldn't\b/g, 'I couldn\'t'],
  // Leaving a request to the people holding it (homeroom-bot-holds.js).
  [/, so Homeroom bot is leaving it to the vote\./, ', so I\'m leaving it to the vote.'],
  [/, so Homeroom bot is leaving it to them\. If you still want Homeroom bot to build it, mention it here again and it will go ahead\./,
    ', so I\'m leaving it to them. If you still want me to build it, mention me here again and I\'ll go ahead.'],
  [/Homeroom bot is taking this up now, as asked\./, 'I\'m taking this up now, as asked.'],
  [/asked Homeroom bot to build this anyway, so it is taking it up now\./, 'asked me to build this anyway, so I\'m taking it up now.'],
  [/It will reply here with a question, a note or a change to vote on\./, 'I\'ll reply here with a question, a note or a change to vote on.'],
  // The ways to start it again, at the end of most notes.
  [/and it will (look again|try again)\./g, 'and I\'ll $1.'],
]);

/** Pure: a note's Homeroom copy, in the bot's own voice. Anything else passes through. */
function firstPerson(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, to] of FIRST_PERSON) out = out.replace(re, to);
  return out;
}

module.exports = { firstPerson, FIRST_PERSON };
