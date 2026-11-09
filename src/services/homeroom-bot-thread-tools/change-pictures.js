'use strict';

// #6533: show what a change looks like, in the person's chat with the bot.
// The same pictures a change's thread draws (services/change-pictures.js),
// under the reply as one gallery card. Nothing is offered here: a plan goes
// on the change's own thread, where its request is.

const mayor = (deps) => deps.mayor || require('../homeroom-bot-mayor');

const TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'show_change',
    description: 'Show what a change looks like: each email it adds or rewords, Today and With this change, and its '
      + 'verified before/after screens, as pictures under your reply. Showing edits nothing, whoever built it.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project the change is on, by name.' },
        change: { type: 'integer', description: 'The change, by its change number.' },
        what: { type: 'string', enum: ['emails', 'screens', 'all'], description: 'What to show. all unless they named one.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
});

function tools() { return [TOOL]; }

function promptLines() {
  return [
    '- Show what a change looks like when somebody asks (show_change): its emails, Today and With this change, and its',
    '  verified before/after screens, as pictures under your reply. Showing or reading a change edits nothing: never give',
    '  who built a change as a reason not to show it. A plan can only be posted from the change\'s own thread, so say so.',
  ];
}

async function show(pool, ctx, args = {}) {
  const m = mayor(ctx.deps);
  const app = await m.findApp(pool, args.project);
  if (!app || !(await m.canView(pool, app, ctx.user).catch(() => false))) {
    return { ok: false, error: 'There is no project by that name that they can see.' };
  }
  const wanted = Number(args.change);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.user_id, cs.pr_number, cs.linked_issues
       FROM chat_sessions cs WHERE cs.app_id = $1 AND cs.status <> 'archived'
        AND ($2::int IS NULL OR cs.pr_number = $2::int)
       ORDER BY cs.id DESC LIMIT 1`,
    [Number(app.id), Number.isInteger(wanted) && wanted > 0 ? wanted : null],
  );
  const change = rows[0];
  if (!change) return { ok: false, error: 'There is no change by that number on that project.' };
  const made = { ...ctx, app, change, place: { type: 'session', ref: Number(change.id) }, user: ctx.user };
  const out = await require('../change-pictures').showChange(pool, ctx.config || {}, made, args);
  if (!out.ok) return out;
  if (made.gallery) ctx.card = made.gallery;
  return {
    ...out,
    ...(out.images ? {
      // #6541: the reply names the version the pictures were drawn from.
      shown: 'As a gallery under your reply. Say in one sentence what it shows; you cannot see the pictures.'
        + (out.drawnFrom
          ? (out.headSource === 'newest'
            ? ` Say they are drawn from ${out.drawnFrom}, the change's newest version.`
            : ` Say they are drawn from ${out.drawnFrom}, the last version checked; a newer push may not be drawn.`)
          : ''),
    } : {}),
    note: 'A plan is posted from the change\'s own thread, where its request is; the pictures stay here.',
  };
}

async function run(pool, ctx, name, args) {
  if (name !== 'show_change') return undefined;
  try {
    return await show(pool, ctx, args || {});
  } catch (err) {
    return { ok: false, error: 'The pictures could not be made just now. Try again in a minute.' };
  }
}

module.exports = { TOOL, tools, run, promptLines, show };
