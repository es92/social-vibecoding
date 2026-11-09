'use strict';

// list_source and read_source: a project's code on main, read by Homeroom bot
// (homeroom-bot-mayor.js listSource / readSource, which check the reader may
// build on it and never read a file of secrets). Declared four times before
// (Main, the voice, the design bot, the already-done check), now once, with
// what each scope knows: in Main the project is always named, on a project's
// own thread it is the thread's, and a design thread reads its own project's
// unless it names another.

const { define } = require('./registry');

// Kept in step with homeroom-bot-mayor.js, which pages what it reads by them.
const SOURCE_MAX_PATHS = 200;
const SOURCE_CHUNK_CHARS = 8000;

const DIR = { type: 'string', description: 'Only files under this folder.' };
const MATCH = { type: 'string', description: 'Only paths containing all of these words (case does not matter).' };
const PATH = { type: 'string', description: 'The file\'s path, from list_source.' };
const FROM_LINE = { type: 'integer', description: 'The first line to read (1 by default).' };
const PROJECT_MAIN = { type: 'string', description: 'The project\'s name or short name.' };
const PROJECT_DESIGN = { type: 'string', description: 'Another project they can build on, by name; leave it out for this design\'s.' };
// #6533: a change's code, at the point it started from or as it is now.
const AT = {
  type: 'string',
  enum: ['main', 'today', 'with_change'],
  description: 'Which version: main (the project today), today (the change\'s starting point), or with_change (the change\'s newest version). main unless asked; today and with_change need a change here.',
};

const NEW_PROJECT_ERROR = 'This design is for a new project, which has no code yet. Name a project they can build on to read its code.';

const mayor = (ctx) => ctx.deps?.mayor || require('../homeroom-bot-mayor');

/** The commit `at` names for this call, or an error: today and with_change need a change here. */
async function refFor(args, ctx) {
  const at = ['today', 'with_change'].includes(args.at) ? args.at : 'main';
  if (at === 'main') return { sha: null, at };
  if (ctx.scope !== 'thread' || !ctx.change?.id) return { error: 'This thread is not about a change.' };
  const refs = await mayor(ctx).changeRefs(ctx.pool, ctx.change.id, ctx.app?.id);
  if (refs.error) return { error: refs.error };
  const sha = at === 'today' ? refs.base : refs.head;
  if (!sha) return { error: at === 'today' ? 'That change has no starting point to read.' : 'That change\'s newest version cannot be read yet.' };
  return { sha, at };
}

/** The project a call reads, by scope, or an error for a design with none. */
function projectOf(args, ctx) {
  if (ctx.scope === 'thread') return { project: ctx.app?.slug || null };
  if (ctx.scope === 'design') {
    const named = typeof args.project === 'string' && args.project.trim() ? args.project : ctx.app?.slug;
    return named ? { project: named } : { error: NEW_PROJECT_ERROR };
  }
  return { project: args.project };
}

// A thread's schema always lists `required` (the voice's shape, homeroom-
// bot-voice.js fn); Main's and a design's list it when there is one.
const object = (properties, required, { always = false } = {}) => ({
  type: 'object', properties, ...(required.length || always ? { required } : {}), additionalProperties: false,
});

define({
  name: 'list_source',
  scopes: ['main', 'design', 'thread'],
  schemaFor(scope) {
    if (scope === 'main') {
      return {
        description: 'The files in a project\'s code on main, for a project they can build on: paths and sizes, at most '
          + `${SOURCE_MAX_PATHS}. Narrow it with dir (a folder, like "src/services") and match (words in the path, like "mail"). `
          + '`more` says how many matching paths were left out.',
        parameters: object({ project: PROJECT_MAIN, dir: DIR, match: MATCH }, ['project']),
      };
    }
    if (scope === 'design') {
      return {
        description: 'The files in the project\'s code on main: paths and sizes. Narrow it with dir (a folder, like "public") '
          + 'and match (words in the path, like "css"). For how its screens are built, their classes and their words.',
        parameters: object({ project: PROJECT_DESIGN, dir: DIR, match: MATCH }, []),
      };
    }
    return {
      description: 'Files in the project\'s code, by folder or name. `at` reads it on main (default), at the change\'s starting point (today), or at its newest version (with_change).',
      parameters: object({ dir: { type: 'string' }, match: { type: 'string' }, at: AT }, [], { always: true }),
    };
  },
  async run(args, ctx) {
    const where = projectOf(args, ctx);
    if (where.error) return { ok: false, error: where.error };
    const ref = await refFor(args, ctx);
    if (ref.error) return { ok: false, error: ref.error };
    return mayor(ctx).listSource(ctx.pool, {
      user: ctx.user, project: where.project, dir: args.dir, match: args.match,
      ref: ref.sha, at: ref.at, deps: ctx.deps || {},
    });
  },
});

define({
  name: 'read_source',
  scopes: ['main', 'design', 'thread'],
  schemaFor(scope) {
    if (scope === 'main') {
      return {
        description: 'One file of a project\'s code on main, for a project they can build on, with line numbers, '
          + `about ${SOURCE_CHUNK_CHARS} characters at a time. For a long file, nextLine says where to go on: call again with fromLine.`,
        parameters: object({ project: PROJECT_MAIN, path: PATH, fromLine: FROM_LINE }, ['project', 'path']),
      };
    }
    if (scope === 'design') {
      return {
        description: 'One file of the project\'s code on main, with line numbers, a few thousand characters at a time. '
          + 'For a long file, nextLine says where to go on: call again with fromLine.',
        parameters: object({ project: PROJECT_DESIGN, path: PATH, fromLine: FROM_LINE }, ['path']),
      };
    }
    return {
      description: 'Read one file of the project\'s code, on main or at the change\'s two versions (see `at`).',
      parameters: object({ path: { type: 'string' }, fromLine: { type: 'integer' }, at: AT }, ['path']),
    };
  },
  async run(args, ctx) {
    const where = projectOf(args, ctx);
    if (where.error) return { ok: false, error: where.error };
    const ref = await refFor(args, ctx);
    if (ref.error) return { ok: false, error: ref.error };
    return mayor(ctx).readSource(ctx.pool, {
      user: ctx.user, project: where.project, path: args.path, fromLine: args.fromLine,
      ref: ref.sha, at: ref.at, deps: ctx.deps || {},
    });
  },
});

// #6533: the paths a change alters, so a reader can find the file to read.
define({
  name: 'list_change_files',
  scopes: ['thread'],
  schemaFor() {
    return {
      description: 'The files this change adds, changes or removes, between its starting point and its newest version.',
      parameters: object({}, [], { always: true }),
    };
  },
  async run(args, ctx) {
    if (!ctx.change?.id) return { ok: false, error: 'This thread is not about a change.' };
    return mayor(ctx).listChangeFiles(ctx.pool, {
      user: ctx.user, project: ctx.app?.slug, change: ctx.change, deps: ctx.deps || {},
    });
  },
});

module.exports = { SOURCE_MAX_PATHS, SOURCE_CHUNK_CHARS, NEW_PROJECT_ERROR };
