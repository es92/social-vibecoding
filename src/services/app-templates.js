'use strict';

/**
 * The starter templates a new project can begin from (#3521).
 *
 * `POST /api/apps` takes `template`, one of TEMPLATE_IDS; absent, the
 * project starts from `empty`: the scaffold every project got before this
 * existed, byte for byte (services/template.js). Strict, like the rest of
 * create-options.js: an id not on the list is refused, not swapped.
 *
 * READY-MADE APPS (Evan, 8 October 2026). The four general starters of the
 * old create dialog (social productivity, multimedia social, a 2D game, a 3D
 * game) were deleted with it. What came back are apps finished enough that
 * a project made from one needs nothing built: the eight choices on "What
 * do you want to make?" that need no typing
 * (frontend/src/features/first-session/examples.ts, each choice's
 * `template`). A tier list of restaurants, hikes, cities or games is one
 * app with its category filled in at creation; a grocery list, a chore
 * list, a lending library and a potluck planner are one app each. They are
 * `ready`: POST /api/apps starts no Homeroom bot build for them
 * (routes/apps.js), so the project is usable as soon as it is running.
 * Words of the maker's own, and every game, still go to Homeroom bot.
 *
 * A starter is files and an entry:
 *
 *   app-templates/<dir>/ at the repository root, outside src/ because
 *                        scripts/check-sql.js validates every query under
 *                        src/ against the platform's own catalog, and a
 *                        starter's queries are against the app's database.
 *                        `dir` is the entry's id unless it names another,
 *                        so several entries can share one app:
 *     api.js             the app's own routes and tables (server.js mounts
 *                        it after the sign-in check and awaits its migrate);
 *     public/index.html  the screen, with `{{APP_NAME}}`,
 *                        `{{DEV_CONSOLE_FORWARDER}}` and the entry's own
 *                        `fill` values filled in at creation;
 *     public/app.js      the screen's script, which holds no placeholder:
 *                        what an entry fills is in the page, so one script
 *                        serves every entry that shares the directory.
 *   an entry below       its title, summary, icon, features, tables and the
 *                        declared `tests` the new repository ships with.
 *
 * Rules every starter keeps: the platform conventions, like any app (the
 * bridge by relative path and never vendored, no CDN, the viewer's theme,
 * staging seeds gated on USERNODE_ENV and owned by fake identities, "now"
 * read through `req.now` and `usernode.now()`, "everyone in the group" from
 * the platform's member list), and the new app's design kit
 * (styles/tailwind-input.css, written by template.js): colour only from its
 * tokens, its type scale and components, so a ready-made app looks like the
 * apps Homeroom bot builds.
 *
 * A project made from one of the deleted starters keeps its `apps.template`
 * value; app-creator reads anything that is not on the list as `empty`, so
 * a Retry after a failed create scaffolds the empty starter.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = 'empty';
const STARTERS_DIR = path.join(__dirname, '..', '..', 'app-templates');

// Files every starter directory carries, relative to it. A starter may add
// more; these are the ones server.js and index.html depend on.
const REQUIRED_FILES = ['api.js', 'public/index.html', 'public/app.js'];

// Every starter's checks look at the screen and its script; one of them is
// the visual flow its first proposals are compared on.
const IMPACT = Object.freeze(['public/**', 'api.js']);

/**
 * One tier list per category: the same app (app-templates/tier-list), with
 * what it ranks filled in. `example` is the add field's placeholder.
 */
function tierList(id, { plural, one, example, title }) {
  return Object.freeze({
    id,
    dir: 'tier-list',
    ready: true,
    title,
    summary: `A tier list of the group's favorite ${plural}: anyone adds one, everyone drags them into tiers, and the group's ranking shows where each lands.`,
    icon: '📊',
    fill: Object.freeze({ ITEM_PLURAL: plural, ITEM_ONE: one, ITEM_EXAMPLE: example }),
    features: Object.freeze([
      `**Add ${plural}**: anyone in the project adds one; a name already on the list is not added twice.`,
      '**Your ranking**: drag each one into S, A, B, C, D or F, or tap it and then tap a tier. Change your mind any time.',
      '**The group\'s ranking**: the same board, with every item in the tier its average lands in (a tie goes up). One tap switches between the two.',
    ]),
    tables: '`tier_items` and `tier_votes`',
    tests: Object.freeze([
      {
        // It opens on your own board, so a newcomer's items wait in the
        // tray below the tiers as chips to drag.
        id: 'tiers.board',
        name: 'Your tier list opens with items ready to drag into tiers',
        path: '/',
        expectSelector: '#board[data-view="yours"] ~ #tray button[data-item]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'The board switches to the group\'s ranking', path: '/', expectSelector: '#view-toggle button[data-view="group"]' },
      { name: 'A new item can be added', path: '/', expectSelector: '#add-form input[name="name"]' },
    ]),
  });
}

// A game starter's checks look at its screen, its rules and the room.
const GAME_IMPACT = Object.freeze(['public/**', 'api.js', 'game/**']);

/**
 * A game starter (Evan, 8 October 2026): a working multiplayer game a
 * project made from one of the make screen's game presets starts from, so
 * Homeroom bot's first version builds the creator's idea as changes to a
 * game that already plays, instead of from an empty page. Not `ready`: the
 * bot still builds the first version (routes/apps.js), told which starter
 * it is (`bot`, homeroom-bot.js firstVersionNote).
 *
 * Every game starter plays in the same game room (app-templates/_game-room,
 * its `shared` files: who is playing, the lobby, turns, a live tick, saved
 * results and a leaderboard, over one WebSocket), with its own
 * game/rules.js and screen. The room's live connection needs `ws`, the one
 * package a game adds (src/templates/node-app/extra-packages.json).
 */
function gameStarter(entry) {
  return Object.freeze({
    kind: 'game',
    shared: '_game-room',
    dependencies: Object.freeze(['ws']),
    ...entry,
    features: Object.freeze(entry.features),
    tests: Object.freeze(entry.tests),
    bot: Object.freeze(entry.bot),
  });
}

const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'empty',
    title: 'Empty',
    summary: 'The starter screen with one example to replace.',
  }),
  tierList('tier-list-restaurants', { plural: 'restaurants', one: 'restaurant', example: 'e.g. the taco place on Main St', title: 'Restaurant tier list' }),
  tierList('tier-list-hikes', { plural: 'hikes', one: 'hike', example: 'e.g. the lake loop', title: 'Hiking tier list' }),
  tierList('tier-list-cities', { plural: 'cities', one: 'city', example: 'e.g. Lisbon', title: 'City tier list' }),
  tierList('tier-list-games', { plural: 'games', one: 'game', example: 'e.g. chess', title: 'Game tier list' }),
  Object.freeze({
    id: 'grocery-list',
    ready: true,
    title: 'Grocery list',
    summary: 'One shared grocery list that works like Homeroom\'s Todo List app: categories, ticked items kept in place, undo, search and due dates.',
    icon: '🛒',
    features: Object.freeze([
      '**Categories**: items go in categories you make (aisles, shops, whatever suits), with a General part at the top for anything else. Drag items within and between categories, and the categories themselves; fold a category away by tapping its name (a finished one starts folded).',
      '**Ticked in place**: ticking keeps an item\'s place, below the open items in its category with who ticked it. "N done" hides or shows a category\'s ticked items, and the menu does it for the whole list.',
      '**Undo, search and more**: undo and redo (Cmd/Ctrl+Z) for adding, deleting, editing, ticking and due dates; search as you type; optional due dates that sort the list; markdown export and import in Todo List\'s format; and the latest thing somebody else did, at the top.',
    ]),
    tables: '`grocery_list`, `grocery_categories`, `grocery_items` and `grocery_events`',
    tests: Object.freeze([
      {
        id: 'groceries.list',
        name: 'The list shows its items, by category',
        path: '/',
        expectSelector: '#categories [data-category] [data-item] input[type="checkbox"]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'An item can be added', path: '/', expectSelector: '#quick-add input[name="text"]' },
    ]),
  }),
  Object.freeze({
    id: 'chore-list',
    ready: true,
    title: 'Chore list',
    summary: 'The group\'s chores, each always one person\'s or taking turns; turns move on every Monday.',
    icon: '🧹',
    features: Object.freeze([
      '**Yours or taking turns**: a chore can always be one person\'s, or go round the project\'s members (the platform\'s member list, never just whoever opened the app), moving on every Monday (UTC). Tap a chore to change which.',
      '**Your turn**: the chores that are yours this week come first, with who is next.',
      '**Done this week**: anyone can tick a chore off, and the list says who did.',
    ]),
    tables: '`chores` and `chore_done`',
    tests: Object.freeze([
      {
        id: 'chores.week',
        name: 'This week\'s chores are listed',
        path: '/',
        expectSelector: '#chores [data-chore]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'With the demo rota, each chore says whose turn it is', path: '/?demo=1', expectSelector: '#chores [data-chore] [data-turn]' },
    ]),
  }),
  Object.freeze({
    id: 'lending-library',
    ready: true,
    title: 'Lending library',
    summary: 'The things members can lend each other, who has each one now, and who has asked for it next.',
    icon: '📚',
    features: Object.freeze([
      '**Things to lend**: add something you can lend, with an optional note. It starts on your shelf.',
      '**Ask for it**: anyone can ask for a thing and joins the line; whoever has it hands it on to someone who asked.',
      '**Who has what**: each thing says who has had it since when. No due dates: its owner can always say it is back.',
    ]),
    tables: '`library_items` and `library_requests`',
    tests: Object.freeze([
      {
        id: 'library.shelf',
        name: 'The library lists things, borrowed and available',
        path: '/',
        expectSelector: '#shelf [data-thing][data-status="out"]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'Something can be added to lend', path: '/', expectSelector: '#add-form input[name="name"]' },
    ]),
  }),
  Object.freeze({
    id: 'potluck-planner',
    ready: true,
    title: 'Potluck planner',
    summary: 'Potlucks with a date and a place, who is bringing what by course (so the table is not six salads), and a chat for each one.',
    icon: '🍲',
    features: Object.freeze([
      '**Plan a potluck**: a name, a date, a time and a place.',
      '**Who\'s bringing what**: say what you will bring and which course it is. Each course lists what is coming, and the courses nobody has taken yet are named.',
      '**Talk about it**: react to a dish, comment on it ("is it vegetarian?"), and chat with everyone coming.',
    ]),
    tables: '`potlucks`, `potluck_dishes`, `potluck_reactions`, `potluck_comments` and `potluck_messages`',
    tests: Object.freeze([
      {
        id: 'potluck.next',
        name: 'The next potluck shows who is bringing what',
        path: '/',
        expectSelector: '#potlucks [data-potluck] [data-course] [data-dish]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'A potluck can be planned', path: '/', expectSelector: '#plan-form input[name="title"]' },
      { name: 'Each potluck has its chat', path: '/', expectSelector: '#potlucks [data-potluck] [data-chat] [data-message]' },
    ]),
  }),
  gameStarter({
    id: 'game-board',
    title: 'Board game starter',
    summary: 'A dice race for the whole project: everyone rolls in turn, a ladder takes you up, a slide takes you back, and the first to the finish wins.',
    icon: '🎲',
    features: [
      '**A title screen with the lobby**: the board lying on the table, the seats around it, and anyone in the project joins; anyone who joined starts the game.',
      '**The game fills the screen**: the board stretches to fit, everyone\'s piece hops square by square, and the dice tray shows whose turn it is. A six rolls again, and a player who is away has their roll made for them, so a game never waits on an empty seat.',
      '**A board of 30 squares** with ladders and slides, drawn from the game\'s state, the results over the table at the end, and a leaderboard of wins.',
      '**Live for everyone**: every roll shows on every screen at once, over one connection per player.',
    ],
    tables: null,
    notes: '- The board (its squares, ladders and slides) is set at the top of `game/rules.js`; the screen draws whatever the game\'s state says, as one SVG.\n- The scene\'s look (the table, the board, the pieces, the die) is `public/scene.css`, the same in both looks.',
    tests: [
      {
        id: 'board.board',
        name: 'The board shows, from start to finish',
        path: '/',
        expectSelector: '#board [data-square="30"]',
        visual: true,
        impact: GAME_IMPACT,
      },
      { name: 'The lobby lists who is playing', path: '/', expectSelector: '#title #players [data-player]' },
      { name: 'The leaderboard shows past winners', path: '/', expectSelector: '#leaders [data-leader]' },
    ],
    bot: {
      what: 'a working turn-based board game, a dice race on a board of 30 squares with ladders and slides, with a title screen holding the lobby and the game filling the screen',
      build: 'Build the creator\'s board game by changing the rules (`game/rules.js`: the board, the moves, how a turn goes, who wins) and the screen (`public/app.js`, `public/index.html`, its look in `public/scene.css`). Keep the game room and the two screens: the title screen with the lobby, and the game filling the screen; turns, playing for somebody who is away, results and the leaderboard already work, live.',
    },
  }),
  gameStarter({
    id: 'game-space',
    title: 'Space game starter',
    summary: 'A live arcade run in space, flown together: pulsars throw storms of sparks in rings, spirals and fans, comet showers sweep down, and every pilot weaves through them collecting stardust.',
    icon: '🚀',
    features: [
      '**A forward-scrolling dodging run**: the stars stream past, pulsars drift in and throw out patterns of sparks, and comet showers leave a gap to fly through. Every half minute is a new sector, with more storms and faster sparks. Nothing is shot: the game is dodging.',
      '**Flown together, live**: every pilot\'s ship moves on every screen 20 times a second, and your own ship flies on your screen as you steer, with the small hit box a dodging game has. A storm is a few numbers, and every screen works out each spark from them, so hundreds of sparks cost almost nothing to send.',
      '**A title screen with the hangar**, then the run filling the screen: arrow keys or WASD (Shift to slow down), or drag anywhere on a phone. Anyone can join a run that is on.',
      '**Scores and a leaderboard**: time flown and stardust collected; a spark costs a shield, and out of shields your ship is out.',
    ],
    tables: null,
    notes: '- The storms (their patterns, how often they come, how fast the sparks fly) are set at the top of `game/rules.js`; `public/app.js` works out where each spark is (`sparkAt`) and draws the field on a canvas.\n- The scene\'s look is `public/scene.css` and the colours at the top of `public/app.js`, night in both looks.',
    tests: [
      {
        id: 'space.field',
        name: 'The field and the hangar show',
        path: '/',
        expectSelector: '#field #field-canvas',
        visual: true,
        impact: GAME_IMPACT,
      },
      { name: 'Anyone can join the next run', path: '/', expectSelector: '#lobby-actions #join' },
      { name: 'The leaderboard shows the best runs', path: '/', expectSelector: '#leaders [data-leader]' },
    ],
    bot: {
      what: 'a working live multiplayer arcade game: a forward-scrolling run where ships fly together dodging storms of sparks (rings, spirals, fans, comet showers) and collecting stardust, with shields, sectors, a title screen with the hangar and a leaderboard of runs',
      build: 'Build the creator\'s arcade game by changing the rules (`game/rules.js`: the storms and their patterns, what scores, when a run ends; the server ticks 20 times a second) and the canvas drawing and controls in `public/app.js`. Keep the game room and its live connection, the title screen and the run filling the screen: the hangar, joining a run, frames to every screen, flying your own ship locally and the leaderboard already work. No weapons or attacking anyone: Homeroom\'s content rules forbid them, so a "shooter" dodges, collects, races or breaks rocks.',
    },
  }),
  gameStarter({
    id: 'game-blocks',
    title: '3D blocks starter',
    summary: 'One 3D block world everyone builds in together, in first person: fly around it, pick a block from the hotbar, build and take blocks away, and see everyone else flying and building as they go.',
    icon: '🧱',
    features: [
      '**First person, full screen**: drawn with three.js (included in the repository, never from a CDN). The mouse looks around, WASD walks, Space and Shift fly up and down, a click builds where the crosshair points and a right-click takes a block away. On a phone: drag to look, a stick to walk, and buttons to fly and build.',
      '**A hotbar of twelve blocks**: grass, stone, wood, brick, glass and more, chosen with 1 to 9, 0, - and = or the scroll wheel.',
      '**Live for everyone**: every block placed or removed shows on every screen at once, and so does everyone else, as a blocky figure with their name and the block in their hand.',
      '**A title screen over the world**, the camera circling it, with who is building now. No lobby: one world, always on, saved as it is built.',
    ],
    tables: null,
    notes: '- The world (its size and how many kinds of block) is set at the top of `game/rules.js`; the blocks\' names and colours, the controls, the camera and the drawing are in `public/app.js`.\n- The scene\'s look is `public/scene.css`, daylight in both looks.\n- `public/vendor/three.module.min.js` is three.js r186, vendored: never edit it (its README says how to update it).',
    tests: [
      {
        id: 'blocks.world',
        name: 'The block world and the way in show',
        path: '/',
        expectSelector: '#world #world-canvas',
        visual: true,
        impact: GAME_IMPACT,
      },
      { name: 'There are blocks to build with', path: '/', expectSelector: '#hotbar [data-block]' },
      { name: 'Anyone can enter the world', path: '/', expectSelector: '#title #enter' },
    ],
    bot: {
      what: 'a working live 3D building game in three.js, one shared block world seen in first person, where everyone flies around, picks blocks from a hotbar and places and removes them, with mouse-look, touch controls and everyone shown live',
      build: 'Build the creator\'s 3D game by changing the rules (`game/rules.js`: what the world holds and what a move does) and the scene in `public/app.js` (three.js, imported from `public/vendor`). Keep the game room and its live connection, the title screen and the first-person controls: saving the world, sending each change to everyone and showing who is where already work.',
    },
  }),
  gameStarter({
    id: 'game-trivia',
    title: 'Trivia starter',
    summary: 'A game show about each other: everyone writes questions about themselves, and the show asks them one by one, against the clock, to see who knows the group best.',
    icon: '❓',
    features: [
      '**A title screen with the contestants**: the show\'s name in lights, the lobby, and the leaderboard.',
      '**Writing questions is a screen of its own**: anyone writes questions about themselves, with the right answer and up to three wrong ones. Only their author sees the answers before the show asks them.',
      '**The show fills the screen**: up to eight questions, 20 seconds each, four answer tiles in a quiz show\'s colours and shapes. Quick right answers score more, and a question\'s author scores for everyone who knew. Then the answer shows, with who picked what.',
      '**Live scores and a leaderboard**: join, start, join a show already on, and see the scores move as answers come in, on every screen at once.',
    ],
    tables: '`trivia_questions` (the question bank)',
    notes: '- The question bank\'s routes are in `api.js`; `prepare` hands the bank to `rules.setup` when a game starts.\n- The scene\'s look (the stage, the marquee, the tiles) is `public/scene.css`, the same in both looks.',
    tests: [
      {
        id: 'trivia.lobby',
        name: 'The title screen shows who is playing',
        path: '/',
        expectSelector: '#players [data-player]',
        visual: true,
        impact: GAME_IMPACT,
      },
      { name: 'Anyone can write a question about themselves', path: '/', expectSelector: '#builder #question-form [name="text"]' },
      { name: 'The leaderboard shows past winners', path: '/', expectSelector: '#leaders [data-leader]' },
    ],
    bot: {
      what: 'a working live quiz game show, with a title screen and lobby, a separate screen for writing questions about yourself, and the show filling the screen: questions asked one by one against a clock, four answer tiles, live scores and a leaderboard',
      build: 'Build the creator\'s quiz or party game by changing the rules (`game/rules.js`: what is asked, how answers score, how a round goes) and the screens, and the question bank in `api.js` if the questions come from somewhere else. Keep the game room and the three screens (title and lobby, writing questions, the show): the clock, hidden answers, live scores and the leaderboard already work.',
    },
  }),
]);

const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
/** The ready-made apps: a project made from one needs nothing built. */
const READY_IDS = Object.freeze(TEMPLATES.filter((t) => t.ready).map((t) => t.id));

function isTemplate(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Whether a project made from this template is ready as it is (no Homeroom bot build). */
function isReadyMade(id) {
  return isTemplate(id) && !!BY_ID.get(id).ready;
}

/** The template's metadata, or null for an id that is not one. */
function get(id) {
  return BY_ID.get(id) || null;
}

/**
 * A game starter Homeroom bot's first version builds on (an entry with
 * `bot`: what it is, and what to keep while building the creator's game),
 * or null: the empty scaffold, a ready-made app, an unknown id.
 */
function botStarter(id) {
  const t = get(id);
  return t && t.bot ? t : null;
}

/** The directory a starter's files live in, under STARTERS_DIR. */
function dirOf(id) {
  const t = get(id);
  return t ? (t.dir || t.id) : null;
}

/**
 * `template` from a create body: absent is the default, anything else must
 * be on the list. Strict, like the rest of create-options.js: a creator who
 * sent a value meant it, and a silently substituted template would be a
 * project that is not what they picked.
 */
function parseTemplate(raw) {
  if (raw == null || raw === '') return { template: DEFAULT_TEMPLATE };
  if (!isTemplate(raw)) return { error: `template must be one of: ${TEMPLATE_IDS.join(', ')}` };
  return { template: raw };
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// Files copied exactly as they are: a vendored library (the 3D game
// starter's three.js) is nobody's placeholder.
const VERBATIM = /^public\/vendor\//;

/**
 * A starter's own files, as `{ path, content }` with the placeholders
 * filled in: its `shared` directory's (the game room every game starter
 * plays in), then its own, which win where both have a path. `fill` maps
 * a placeholder name (APP_NAME, or one of the entry's own `fill` names) to
 * its text, already escaped for where it lands. Empty for `empty`, which
 * has none.
 */
function starterFiles(id, fill = {}) {
  if (!isTemplate(id) || id === DEFAULT_TEMPLATE) return [];
  const t = get(id);
  const sources = new Map();
  for (const name of [...(t.shared ? [t.shared] : []), dirOf(id)]) {
    const dir = path.join(STARTERS_DIR, name);
    for (const rel of walk(dir)) sources.set(rel, path.join(dir, rel));
  }
  return [...sources.keys()].sort().map((rel) => {
    const raw = fs.readFileSync(sources.get(rel), 'utf8');
    return {
      path: rel,
      content: VERBATIM.test(rel) ? raw
        : raw.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(fill, key) ? fill[key] : whole)),
    };
  });
}

module.exports = {
  DEFAULT_TEMPLATE,
  READY_IDS,
  REQUIRED_FILES,
  STARTERS_DIR,
  TEMPLATES,
  TEMPLATE_IDS,
  botStarter,
  dirOf,
  get,
  isReadyMade,
  isTemplate,
  parseTemplate,
  starterFiles,
};
