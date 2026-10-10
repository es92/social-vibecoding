/**
 * The starting points on "What do you want to make?" (./make.tsx), and the
 * three things the signed-out story (../auth/story.tsx) says groups make.
 * They live here so the two screens say the same three things.
 *
 * Evan, 8 October 2026: the three examples (a running club's tracker, a
 * movie night's poll, a weekend's planner) became sentences to finish. Each
 * one is something a group needs more than once, and each is filled in with
 * a tap or two while leaving the part that makes it theirs to them: what the
 * tier list ranks, what the organizer keeps and, for a game, the idea
 * itself, because the fun of a game is in what you build. The make screen's
 * fourth tile, Your own idea, is the plain description box.
 *
 * A template is a sentence with one blank. Every choice's sentence is one
 * whole message (frontend/locales/en/onboarding.json), with `<0>…</0>`
 * around what stands in the blank: the choice's own words, or `{{words}}`,
 * the maker's. `sentence()` splits it there into what is drawn before the
 * blank, in it and after it, so the code never joins a sentence from parts.
 * A `finish` template (the game) always ends in the maker's own words
 * (`{{words}}`), typed in a box under the sentence, and its Your own comes
 * first.
 *
 * Everything a person reads here is a message id, read with `t` when it is
 * shown, so the words follow the language on screen.
 *
 * READY-MADE. Every choice that needs no typing (the tier list's four, the
 * organizer's four) names a `template`: one of Homeroom's ready-made apps
 * (services/app-templates.js), which Make it makes instead of asking
 * Homeroom bot to build a first version, so the project is usable as soon
 * as it runs. Its `emoji` is that app's icon. Your own words, and every
 * game, still go to Homeroom bot.
 *
 * GAME STARTERS. Each game preset (board game, space shooter, 3D blocks,
 * trivia) names a `starter` too: a working multiplayer game the project is
 * made from (services/app-templates.js, `kind: 'game'`), so Homeroom bot
 * builds the maker's own idea as changes to a game that already plays,
 * instead of from an empty page. Make it sends it as the create's
 * `template` beside their words, the brief.
 */

import { t as translate } from '../../lib/i18n/runtime';

/** The choice that puts the maker's own words in the blank. */
export const OWN = 'own';

export type Choice = {
  key: string;
  /** On its chip. A message id. */
  label: string;
  /**
   * Its whole sentence, a message id: `<0>…</0>` holds what it puts in the
   * blank ("hikes", or a finishing template's starter, "a board game
   * where"), and a finishing template's has `{{words}}` for the rest.
   */
  sentence: string;
  /** A finishing template's example of the rest, in its box. A message id. */
  example?: string;
  /** Suggested for "What should we call it?". A message id. */
  name: string;
  /** The project's one-line description (create-options DESCRIPTION_MAX, 90). A message id. */
  description: string;
  /** The ready-made app it makes (services/app-templates.js READY_IDS), with nothing to build. */
  template?: string;
  /** That app's icon (its entry's `icon`), where it is not the template's own emoji. */
  emoji?: string;
  /** A game starter (services/app-templates.js): the project starts from it, and the bot builds their idea on it. */
  starter?: string;
};

export type Template = {
  key: string;
  /** On the tile and the story, and the project's tile until its sketch has an emoji. */
  emoji: string;
  /** Drawn in place of the emoji: the tier list's mini tier chart (./tier-chart.tsx). */
  chart?: boolean;
  /** "A tier list", on the story. A message id. */
  title: string;
  /** What it is for, under the title on the story. A message id. */
  line: string;
  /** "Tier list", on the make screen's tile. A message id. */
  short: string;
  choices: readonly Choice[];
  /**
   * Your own, each a message id: its whole sentence (`{{words}}` is theirs),
   * the example in its blank, the name it suggests (`{{words}}` is theirs;
   * empty suggests none) and the project's description.
   */
  own: { sentence: string; example: string; name: string; description: string };
  /** Always finished in the maker's own words; Your own comes first and is picked first. */
  finish?: boolean;
  /**
   * Suggested for the invite's note. A message id. It is sent while the app
   * is still being made, so it says "I'm making", never "Made us", and it
   * has no "!" (#4042).
   */
  note: string;
};

export const TEMPLATES: readonly Template[] = [
  {
    key: 'tier',
    emoji: '📊',
    chart: true,
    title: 'onboarding:firstSession.template.tier.title',
    line: 'onboarding:firstSession.template.tier.line',
    short: 'onboarding:firstSession.template.tier.short',
    choices: [
      { key: 'restaurants', label: 'onboarding:firstSession.template.tier.restaurants.label', sentence: 'onboarding:firstSession.template.tier.restaurants.sentence', name: 'onboarding:firstSession.template.tier.restaurants.name', description: 'onboarding:firstSession.template.tier.restaurants.description', template: 'tier-list-restaurants' },
      { key: 'hikes', label: 'onboarding:firstSession.template.tier.hikes.label', sentence: 'onboarding:firstSession.template.tier.hikes.sentence', name: 'onboarding:firstSession.template.tier.hikes.name', description: 'onboarding:firstSession.template.tier.hikes.description', template: 'tier-list-hikes' },
      { key: 'cities', label: 'onboarding:firstSession.template.tier.cities.label', sentence: 'onboarding:firstSession.template.tier.cities.sentence', name: 'onboarding:firstSession.template.tier.cities.name', description: 'onboarding:firstSession.template.tier.cities.description', template: 'tier-list-cities' },
      { key: 'games', label: 'onboarding:firstSession.template.tier.games.label', sentence: 'onboarding:firstSession.template.tier.games.sentence', name: 'onboarding:firstSession.template.tier.games.name', description: 'onboarding:firstSession.template.tier.games.description', template: 'tier-list-games' },
    ],
    own: { sentence: 'onboarding:firstSession.template.tier.own.sentence', example: 'onboarding:firstSession.template.tier.own.example', name: 'onboarding:firstSession.template.tier.own.name', description: 'onboarding:firstSession.template.tier.own.description' },
    note: 'onboarding:firstSession.template.tier.note',
  },
  {
    key: 'game',
    emoji: '🎮',
    title: 'onboarding:firstSession.template.game.title',
    line: 'onboarding:firstSession.template.game.line',
    short: 'onboarding:firstSession.template.game.short',
    finish: true,
    choices: [
      { key: 'board', label: 'onboarding:firstSession.template.game.board.label', sentence: 'onboarding:firstSession.template.game.board.sentence', example: 'onboarding:firstSession.template.game.board.example', name: 'onboarding:firstSession.template.game.board.name', description: 'onboarding:firstSession.template.game.board.description', starter: 'game-board' },
      { key: 'shooter', label: 'onboarding:firstSession.template.game.shooter.label', sentence: 'onboarding:firstSession.template.game.shooter.sentence', example: 'onboarding:firstSession.template.game.shooter.example', name: 'onboarding:firstSession.template.game.shooter.name', description: 'onboarding:firstSession.template.game.shooter.description', starter: 'game-space' },
      { key: 'blocks', label: 'onboarding:firstSession.template.game.blocks.label', sentence: 'onboarding:firstSession.template.game.blocks.sentence', example: 'onboarding:firstSession.template.game.blocks.example', name: 'onboarding:firstSession.template.game.blocks.name', description: 'onboarding:firstSession.template.game.blocks.description', starter: 'game-blocks' },
      { key: 'trivia', label: 'onboarding:firstSession.template.game.trivia.label', sentence: 'onboarding:firstSession.template.game.trivia.sentence', example: 'onboarding:firstSession.template.game.trivia.example', name: 'onboarding:firstSession.template.game.trivia.name', description: 'onboarding:firstSession.template.game.trivia.description', starter: 'game-trivia' },
    ],
    own: { sentence: 'onboarding:firstSession.template.game.own.sentence', example: 'onboarding:firstSession.template.game.own.example', name: '', description: 'onboarding:firstSession.template.game.own.description' },
    note: 'onboarding:firstSession.template.game.note',
  },
  {
    key: 'organizer',
    emoji: '📋',
    title: 'onboarding:firstSession.template.organizer.title',
    line: 'onboarding:firstSession.template.organizer.line',
    short: 'onboarding:firstSession.template.organizer.short',
    choices: [
      { key: 'groceries', label: 'onboarding:firstSession.template.organizer.groceries.label', sentence: 'onboarding:firstSession.template.organizer.groceries.sentence', name: 'onboarding:firstSession.template.organizer.groceries.name', description: 'onboarding:firstSession.template.organizer.groceries.description', template: 'grocery-list', emoji: '🛒' },
      { key: 'chores', label: 'onboarding:firstSession.template.organizer.chores.label', sentence: 'onboarding:firstSession.template.organizer.chores.sentence', name: 'onboarding:firstSession.template.organizer.chores.name', description: 'onboarding:firstSession.template.organizer.chores.description', template: 'chore-list', emoji: '🧹' },
      { key: 'library', label: 'onboarding:firstSession.template.organizer.library.label', sentence: 'onboarding:firstSession.template.organizer.library.sentence', name: 'onboarding:firstSession.template.organizer.library.name', description: 'onboarding:firstSession.template.organizer.library.description', template: 'lending-library', emoji: '📚' },
      { key: 'potlucks', label: 'onboarding:firstSession.template.organizer.potlucks.label', sentence: 'onboarding:firstSession.template.organizer.potlucks.sentence', name: 'onboarding:firstSession.template.organizer.potlucks.name', description: 'onboarding:firstSession.template.organizer.potlucks.description', template: 'potluck-planner', emoji: '🍲' },
    ],
    own: { sentence: 'onboarding:firstSession.template.organizer.own.sentence', example: 'onboarding:firstSession.template.organizer.own.example', name: 'onboarding:firstSession.template.organizer.own.name', description: 'onboarding:firstSession.template.organizer.own.description' },
    note: 'onboarding:firstSession.template.organizer.note',
  },
];

/** The choice a tap on the template's tile picks: its first, or Your own for a game. */
export function firstChoice(t: Template): string {
  return t.finish ? OWN : t.choices[0].key;
}

function choiceOf(t: Template, key: string): Choice | null {
  return t.choices.find((c) => c.key === key) || null;
}

/** The maker's own words, one space apart. */
function tidy(words: string): string {
  return words.trim().replace(/\s+/g, ' ');
}

const WORDS = '{{words}}';

/**
 * A sentence's message as the catalog holds it, `{{words}}` still in place,
 * cut at its blank: what comes before `<0>`, what the tag holds, and what
 * follows `</0>`. A message with no tag is all `before`.
 */
function parts(id: string): { before: string; held: string; after: string } {
  // Leave {{words}} in place: the maker's words go in after the cut, so
  // nothing they type is read as a tag.
  const raw = translate(id, { interpolation: { prefix: '[[unused:', suffix: ']]' } });
  const cut = /^([\s\S]*?)<0>([\s\S]*?)<\/0>([\s\S]*)$/.exec(raw);
  return cut ? { before: cut[1], held: cut[2], after: cut[3] } : { before: raw, held: '', after: '' };
}

export type Sentence = {
  head: string;
  /** What stands in the blank: the choice's words, or theirs. */
  fill: string;
  tail: string;
  /** The whole description, as Make it sends it. */
  text: string;
  /** Their words are still missing where the template needs them. */
  blank: boolean;
};

/**
 * The description a template, a choice and the maker's own words make, in
 * the language on screen. A finishing template's is its sentence with their
 * words where `{{words}}` stands, closed by the catalog's own punctuation if
 * they left it off. Nothing the catalog writes around the blank is dropped.
 */
export function sentence(t: Template, key: string, words: string): Sentence {
  const c = key === OWN ? null : choiceOf(t, key);
  const own = tidy(words);
  const { before, held, after } = parts(c ? c.sentence : t.own.sentence);
  if (t.finish) {
    // Their words end the sentence. Where they left the punctuation off, the
    // catalog supplies it (a language closes a sentence its own way).
    // Which last characters count as "already ended" is the catalog's too:
    // in English `.`, `!` and `?`, exactly as before this text moved (so
    // words ending in an ellipsis still get their full stop).
    const enders = translate('onboarding:firstSession.make.sentenceEnders');
    const ended = !own || enders.includes(own.slice(-1))
      ? own : translate('onboarding:firstSession.make.wordsWithStop', { words: own });
    // What is drawn is the WHOLE message: everything the catalog puts before
    // and after `{{words}}` stays, and where their words will go stands the
    // catalog's own mark for it, beside a highlighted starter. The box under
    // the sentence holds what they type.
    const mark = held ? translate('onboarding:firstSession.make.wordsBlank') : '';
    return {
      head: before.replace(WORDS, mark),
      fill: held,
      tail: after.replace(WORDS, mark),
      text: `${before}${held}${after}`.replace(WORDS, ended),
      blank: !own,
    };
  }
  const fill = c ? held : own;
  return { head: before, fill, tail: after, text: `${before}${fill}${after}`, blank: !fill };
}

/** The name a choice suggests: "Hiking Tier List", or theirs in the template's pattern. */
export function suggestedName(t: Template, key: string, words: string): string {
  if (key !== OWN) {
    const c = choiceOf(t, key);
    return c ? translate(c.name) : '';
  }
  const own = tidy(words).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return own && t.own.name ? translate(t.own.name, { words: own }) : '';
}

/**
 * The ready-made app a choice makes, and its icon, or null: for Your own
 * words, a game, or a choice that has none.
 */
export function readyMadeOf(t: Template, key: string): { template: string; emoji: string } | null {
  const c = key === OWN ? null : choiceOf(t, key);
  return c && c.template ? { template: c.template, emoji: c.emoji || t.emoji } : null;
}

/**
 * The game starter a choice makes its project from, or null: for Your own
 * words, or a choice with none. Unlike a ready-made app, Homeroom bot still
 * builds the first version, on it.
 */
export function starterOf(t: Template, key: string): { template: string } | null {
  const c = key === OWN ? null : choiceOf(t, key);
  return c && c.starter ? { template: c.starter } : null;
}

/** The project's one-line description for a choice, in the language on screen. */
export function descriptionOf(t: Template, key: string): string {
  const c = key === OWN ? null : choiceOf(t, key);
  return translate(c ? c.description : t.own.description);
}
