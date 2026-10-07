'use strict';

/**
 * The starter templates a new project can begin from (#3521).
 *
 * `POST /api/apps` takes `template`, one of TEMPLATE_IDS; absent, the
 * project starts from `empty`: the scaffold every project got before this
 * existed, byte for byte (services/template.js). Strict, like the rest of
 * create-options.js: an id not on the list is refused, not swapped.
 *
 * ONLY `empty` IS LEFT. The four starters (social productivity, multimedia
 * social, a 2D game, a 3D game) were offered by the create dialog's "Start
 * from a template", and were deleted with that dialog: Create opens "What do
 * you want to make?" (frontend/src/features/first-session/make.tsx), which
 * describes a project for Homeroom bot to build, or imports a GitHub repo.
 * The machinery stays, so a starter can come back as files and an entry:
 *
 *   app-templates/<id>/  at the repository root, outside src/ because
 *                        scripts/check-sql.js validates every query under
 *                        src/ against the platform's own catalog, and a
 *                        starter's queries are against the app's database:
 *     api.js             the app's own routes and tables (server.js mounts
 *                        it after the sign-in check and awaits its migrate);
 *     public/index.html  the screen, with `{{APP_NAME}}` and
 *                        `{{DEV_CONSOLE_FORWARDER}}` filled in at creation;
 *     public/app.js      the screen's script.
 *   an entry below       its title, summary, icon, features, tables and the
 *                        declared `tests` the new repository ships with.
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

const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'empty',
    title: 'Empty',
    summary: 'The starter screen with one example to replace.',
  }),
]);

const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function isTemplate(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The template's metadata, or null for an id that is not one. */
function get(id) {
  return BY_ID.get(id) || null;
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

/**
 * A starter's own files, as `{ path, content }` with the placeholders
 * filled in. `fill` maps a placeholder name (APP_NAME) to its text, already
 * escaped for where it lands. Empty for `empty`, which has none.
 */
function starterFiles(id, fill = {}) {
  if (!isTemplate(id) || id === DEFAULT_TEMPLATE) return [];
  const dir = path.join(STARTERS_DIR, id);
  return walk(dir).map((rel) => ({
    path: rel,
    content: fs.readFileSync(path.join(dir, rel), 'utf8')
      .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(fill, key) ? fill[key] : whole)),
  }));
}

module.exports = {
  DEFAULT_TEMPLATE,
  REQUIRED_FILES,
  STARTERS_DIR,
  TEMPLATES,
  TEMPLATE_IDS,
  get,
  isTemplate,
  parseTemplate,
  starterFiles,
};
