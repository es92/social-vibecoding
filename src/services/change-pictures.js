'use strict';

// Show what a change looks like (#6533). Two kinds of picture, both read from
// what the change itself says and never from running its code:
//
//   emails   each email the change adds or rewords, drawn at its base and at
//            its head with the platform's own renderer, as Admin > Email
//            templates' preview draws one. A new email is drawn once.
//   screens  the change's own verified before/after shots, when it has them.
//
// The card carries media-store ids only (homeroom-bot-cards/gallery.js,
// frontend features/messages/bot-cards/gallery.tsx); the route answers the
// drawn email as JSON, so it is only ever shown through a sandboxed frame.

const crypto = require('node:crypto');
const log = require('./logger');
const { readSeeds } = require('./mail/seed-reader');
const { renderMessage } = require('./mail/render');
const { actionFor } = require('./mail/actions');
const { render } = require('./mail/template-language');

const SEEDS_PATH = 'src/db/email-template-seeds.js';
const ACTIONS_PATH = 'src/services/mail/actions.js';
const MAX_PICTURES = 12;
const ID_RE = /^[0-9a-f]{32}$/;

function mayorOf(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function githubOf(deps) { return deps.github || require('./github'); }
function viewOf(deps) { return deps.shotsView || require('./shots-view'); }
function stateOf(deps) { return deps.shotsState || require('./shots-state'); }
function mediaOf(deps) { return deps.mediaStore || require('./media-store'); }

function sideText(value) { return typeof value === 'string' ? value : ''; }

/** The 7 characters a caption and the reply name a commit by. */
function short(sha) { return String(sha || '').slice(0, 7); }

/** Pure: a drawn email at one side, or null when it cannot be drawn. */
function drawSide(kind, template, layout, sample, running) {
  try {
    if (running) {
      return renderMessage(kind, { template, layout }, sample || running.sample || {});
    }
    // A kind the running platform does not know yet: its template is drawn
    // over the sample its change gives it, with the same escaping renderMessage
    // gives: a value escaped in html, the layout's parts raw.
    const values = {};
    for (const [key, value] of Object.entries(sample || {})) {
      if (value === null || value === undefined) { values[key] = ''; continue; }
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      values[key] = String(value);
    }
    // `render` escapes a value in html and never parses it again; the layout's
    // own parts go in raw because they have already been through it.
    const htmlBody = render(template.html, values);
    const preheader = render(template.preheader, values);
    const why = render(template.why, values);
    const textBody = render(template.text, values, { mode: 'text' });
    return {
      subject: render(template.subject, values, { mode: 'text' }),
      preheader,
      why,
      html: layout ? render(layout.html, { content: htmlBody, why, preheader }, { raw: ['content', 'why', 'preheader'] }) : htmlBody,
      text: layout ? render(layout.text, {
        content: textBody, why: render(template.why, values, { mode: 'text' }), preheader: render(template.preheader, values, { mode: 'text' }),
      }, { mode: 'text' }) : textBody,
    };
  } catch (err) {
    log.warn('change-pictures', 'An email could not be drawn', { kind, err: err.message });
    return null;
  }
}

/** Pure: whether two drawn sides differ in what a reader sees. */
function changed(before, after) {
  return !before || !after || before.subject !== after.subject
    || before.preheader !== after.preheader || before.html !== after.html;
}

/** The two files a change's emails live in, at one ref, read as text. */
async function sideAt(pool, { app, repo, sha, deps = {} }) {
  const github = githubOf(deps);
  const [seedsText, actionsText] = await Promise.all([
    github.getFileContent(repo.owner, repo.repo, SEEDS_PATH, sha),
    github.getFileContent(repo.owner, repo.repo, ACTIONS_PATH, sha),
  ]);
  if (seedsText == null || actionsText == null) return null;
  return readSeeds(seedsText, actionsText);
}

function pictureId() { return crypto.randomBytes(16).toString('hex'); }

/**
 * The emails a change adds or rewords, drawn and stored. Resolves
 * `{ images, subjects, unreadable, unnamed, capped, none }`; `images` carry
 * media-store ids only.
 */
async function emailPictures(pool, config, { app, change, deps = {} }) {
  const mayor = mayorOf(deps);
  const refs = await mayor.changeRefs(pool, change?.id, app?.id, { deps });
  if (refs.error) return { error: refs.error };
  const parsed = require('./homeroom-bot').parseRepo(app.repo_url);
  if (!parsed) return { error: 'That project has no code yet.' };
  const [before, after] = await Promise.all([
    sideAt(pool, { app, repo: parsed, sha: refs.base, deps }),
    sideAt(pool, { app, repo: parsed, sha: refs.head, deps }),
  ]);
  if (!after) {
    // #6541: never quietly fall back to a version that is not the newest.
    return {
      error: refs.headSource === 'newest'
        ? `The newest version of this change (${short(refs.head)}) could not be read just now, so its emails are not drawn.`
        : `The version of this change (${short(refs.head)}) could not be read just now, so its emails are not drawn.`,
    };
  }
  if (!before) return { error: 'That change\'s code could not be read just now.' };

  const kinds = [...new Set([
    ...Object.keys(before.templates), ...Object.keys(after.templates),
    // A kind the change adds to the actions with no seed wording yet.
    ...Object.keys(after.samples), ...Object.keys(before.samples),
  ])];
  const images = [];
  const subjects = [];
  const unreadable = [...new Set([...before.unreadable, ...after.unreadable])];
  const unnamed = [];
  let capped = 0;
  for (const kind of kinds) {
    const running = actionFor(kind);
    const head = after.templates[kind] || null;
    const base = before.templates[kind] || null;
    const isNew = !!head && !base;
    const sides = [];
    if (base) {
      const drawn = drawSide(kind, base, before.layouts[base.layout] || null, before.samples[kind], running);
      if (drawn) sides.push({ side: 'before', drawn });
    }
    if (head) {
      const drawn = drawSide(kind, head, after.layouts[head.layout] || null, after.samples[kind], running);
      if (drawn) sides.push({ side: 'after', drawn });
    }
    if (!sides.length) {
      if (head && !isNew && !base) unnamed.push(kind);
      continue;
    }
    if (!isNew && !changed(sides.find((s) => s.side === 'before')?.drawn, sides.find((s) => s.side === 'after')?.drawn)) continue;
    if (images.length + sides.length > MAX_PICTURES) { capped += sides.length; continue; }
    for (const { side, drawn } of sides) {
      const sideSha = side === 'before' ? refs.base : refs.head;
      const stored = await storePicture(pool, config, {
        app, change, kind, side, isNew, sha: sideSha, drawn, deps,
      });
      if (!stored) continue;
      // The caption names the version it was drawn from, after its subject.
      images.push({ ...stored, subject: drawn.subject, caption: `${String(drawn.subject).slice(0, 190)} · ${short(sideSha)}` });
      subjects.push(drawn.subject);
    }
  }
  return {
    images,
    subjects: [...new Set(subjects)].slice(0, MAX_PICTURES),
    drawnFrom: short(refs.head),
    headSource: refs.headSource,
    base: short(refs.base),
    unreadable: unreadable.filter((kind) => !images.some((i) => i.kind === kind)),
    unnamed,
    capped,
    ...(images.length ? {} : { none: true }),
  };
}

function jsonBytes(payload) { return Buffer.from(JSON.stringify(payload), 'utf8'); }

/** One drawn email, stored once per (session, kind, side, sha). */
async function storePicture(pool, config, { app, change, kind, side, isNew, sha, drawn, deps }) {
  const media = mediaOf(deps);
  const payload = {
    kind, side, subject: drawn.subject, preheader: drawn.preheader, html: drawn.html, text: drawn.text,
  };
  let client = null;
  try {
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM change_pictures
        WHERE session_id = $1 AND mail_kind = $2 AND side = $3 AND sha = $4`,
      [Number(change.id), String(kind).slice(0, 64), side, String(sha).slice(0, 40)],
    );
    if (existing?.id) return { id: existing.id, kind, side, isNew, caption: drawn.subject.slice(0, 200) };
    const store = media.getStore(config);
    if (!store) return null;
    const id = pictureId();
    client = await pool.connect();
    await client.query('BEGIN');
    const key = await media.put(client, store, jsonBytes(payload), 'application/json');
    await client.query(
      `INSERT INTO change_pictures (id, app_id, session_id, mail_kind, side, is_new, subject, preheader, sha, object_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id, mail_kind, side, sha) DO NOTHING`,
      [id, Number(app.id), Number(change.id), String(kind).slice(0, 64), side, !!isNew,
        sideText(drawn.subject).slice(0, 300), sideText(drawn.preheader).slice(0, 300), String(sha).slice(0, 40), key],
    );
    await client.query('COMMIT');
    return { id, kind, side, isNew, caption: drawn.subject.slice(0, 200) };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.warn('change-pictures', 'An email picture could not be stored', { kind, err: err.message });
    return null;
  } finally {
    if (client) client.release();
  }
}

/** The row a picture is served from, for a viewer allowed to see the change. */
async function pictureForSession(pool, { sessionId, appId, pictureId: id }) {
  if (!ID_RE.test(String(id || ''))) return null;
  const { rows: [row] } = await pool.query(
    `SELECT id, object_key, subject, preheader
       FROM change_pictures WHERE id = $1 AND session_id = $2 AND app_id = $3`,
    [String(id), Number(sessionId), Number(appId)],
  );
  return row || null;
}

async function pictureBody(pool, config, row, deps = {}) {
  if (!row) return null;
  const media = mediaOf(deps);
  const store = media.getStore(config);
  if (!store) return null;
  const bytes = await media.bytes(store, row);
  return JSON.parse(bytes.toString('utf8'));
}

/** Who may take a change's missing shots: its author, or an admin of the app. */
async function canRunShots(pool, { app, change, viewer, deps = {} }) {
  if (!viewer?.id || !change) return false;
  if (Number(change.user_id) === Number(viewer.id)) return true;
  const admins = deps.appAdmins || require('./app-admins');
  return admins.canManageApp(pool, app, viewer).catch(() => false);
}

/**
 * The change's verified before/after shots, when it has them; otherwise
 * `{ none: true, canRun }`. `canRun` follows the rules POST .../shots/rerun
 * applies: its author or an app admin, and a declaration to reach.
 */
async function screenPictures(pool, { app, change, viewer, deps = {} }) {
  const view = viewOf(deps);
  const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1 AND app_id = $2', [Number(change.id), Number(app.id)]);
  if (!session) return { none: true, canRun: false };
  let shots = null;
  try {
    shots = await view.getForSession(pool, { ...session, app_slug: app.slug }, app.slug, { viewer });
  } catch (err) {
    log.warn('change-pictures', 'A change\'s shots could not be read', { sessionId: change.id, err: err.message });
  }
  const canRun = !!session.shots_detail?.intent && await canRunShots(pool, { app, change, viewer, deps });
  const artifacts = Array.isArray(shots?.artifacts) ? shots.artifacts : [];
  const captions = new Map((shots?.claims || []).map((claim) => [claim.id, claim.claim]));
  const order = ['desktop', 'mobile', 'tablet'];
  const focus = artifacts
    .filter((a) => ['base', 'head'].includes(a.side) && a.variant === 'focus' && a.media === 'png')
    .sort((a, b) => order.indexOf(a.viewport) - order.indexOf(b.viewport) || String(a.storyId).localeCompare(String(b.storyId)));
  if (shots?.state !== 'verified' || !focus.length) return { none: true, canRun, slides: [] };
  const images = focus.slice(0, MAX_PICTURES).map((a) => ({
    id: a.id,
    source: 'shot',
    side: a.side === 'base' ? 'before' : 'after',
    isNew: false,
    caption: String(captions.get(a.storyId) || a.storyId || '').slice(0, 200),
    url: a.url,
    width: a.width || null,
    height: a.height || null,
  }));
  return { images };
}

/**
 * The `show_change` tool's act in a change's thread (#6533): draws the emails
 * and takes the change's verified shots, puts them under the reply as one
 * gallery card, and offers one thing: post them as a plan on its request, or
 * take its missing shots. Never writes to the change.
 */
async function showChange(pool, config, ctx, args = {}) {
  const app = ctx.app;
  const user = ctx.user;
  const deps = ctx.deps || {};
  let change = ctx.change || null;
  if (!change?.id && ctx.place?.type === 'issue') {
    const wanted = Number(args.change);
    const { rows } = await pool.query(
      `SELECT cs.id, cs.user_id, cs.pr_number, cs.linked_issues
         FROM chat_sessions cs
        WHERE cs.app_id = $1 AND $2::int = ANY(cs.linked_issues) AND cs.status <> 'archived'
          AND ($3::int IS NULL OR cs.pr_number = $3::int)
        ORDER BY cs.id DESC LIMIT 1`,
      [Number(app.id), Number(ctx.place.ref), Number.isInteger(wanted) && wanted > 0 ? wanted : null],
    );
    change = rows[0] || null;
  }
  if (!change?.id) return { ok: false, error: 'This thread is not about a change, so there is nothing to show.' };

  const what = ['emails', 'screens', 'all'].includes(args.what) ? args.what : 'all';
  const emails = what === 'screens' ? { images: [], none: true } : await emailPictures(pool, config, { app, change, deps });
  if (emails.error) return { ok: false, error: emails.error };
  const screens = what === 'emails' ? { images: [], none: true } : await screenPictures(pool, { app, change, viewer: user, deps });

  const images = [
    ...(emails.images || []).map((im) => ({
      id: im.id, source: 'email', side: im.side, isNew: !!im.isNew,
      caption: String(im.caption || '').slice(0, 200),
    })),
    ...(screens.images || []).map((im) => ({
      id: im.id, source: 'shot', side: im.side, isNew: false,
      caption: String(im.caption || '').slice(0, 200),
      ...(im.url ? { url: im.url } : {}),
      ...(im.width ? { width: im.width } : {}),
      ...(im.height ? { height: im.height } : {}),
    })),
  ].slice(0, MAX_PICTURES);

  if (!images.length && !(emails.images || []).length && !(screens.images || []).length) {
    const nothing = what === 'screens'
      ? 'It has no before/after shots yet.'
      : 'This change touches no emails.';
    return {
      ok: true, shown: 0, emails: [], screens: screens.none ? { none: true, canRun: !!screens.canRun } : { none: true },
      said: nothing,
    };
  }

  ctx.gallery = {
    type: 'gallery', v: 1, purpose: 'change',
    project: { slug: app.slug, name: app.name || app.slug },
    change: { sessionId: Number(change.id), number: change.pr_number || null },
    images,
  };

  const request = Array.isArray(change.linked_issues) && change.linked_issues.length ? Number(change.linked_issues[0]) : null;
  if (request) {
    ctx.offer = {
      kind: 'post_pictures_plan', forUserId: user.id,
      args: {
        sessionId: Number(change.id), issueNumber: request, what, changeNumber: change.pr_number || null,
        pictures: images.map((im) => im.id),
      },
    };
  } else if (what !== 'emails' && screens.none && screens.canRun) {
    ctx.offer = { kind: 'run_shots', forUserId: user.id, args: { sessionId: Number(change.id), issueNumber: null } };
  }

  return {
    ok: true,
    images: images.length,
    subjects: (emails.subjects || []).slice(0, MAX_PICTURES),
    newEmails: (emails.images || []).filter((im) => im.isNew).map((im) => im.subject),
    unreadable: emails.unreadable || [],
    unnamed: emails.unnamed || [],
    ...(emails.capped ? { notShown: `${emails.capped} more email picture${emails.capped === 1 ? '' : 's'} did not fit.` } : {}),
    screens: screens.none ? { none: true, canRun: !!screens.canRun } : { images: (screens.images || []).length },
    request,
    ...((emails.images || []).length ? { drawnFrom: emails.drawnFrom, headSource: emails.headSource } : {}),
    shown: 'Under your reply they see the pictures, each labelled Today or With this change, captioned with its subject or screen. Say what they show in one sentence; do not describe a screen the pictures do not carry.'
      + ((emails.images || []).length
        ? (emails.headSource === 'newest'
          ? ` Say they are drawn from ${emails.drawnFrom}, the change's newest version.`
          : ` Say they are drawn from ${emails.drawnFrom}, the last version checked; a newer push may not be drawn.`)
        : ''),
    ...(request ? { note: `The offer under your reply posts these as a plan on request #${request}.` }
      : { note: 'This change answers no request, so a plan cannot go on it: the pictures stay in this thread. Say a plan goes on a request.' }),
    ...(screens.none ? { screensNote: screens.canRun ? 'It has no before/after shots yet; the offer under your reply takes them.' : 'It has no before/after shots yet, and you may not take them.' } : {}),
  };
}

module.exports = {
  MAX_PICTURES,
  emailPictures,
  screenPictures,
  showChange,
  pictureForSession,
  pictureBody,
  canRunShots,
  drawSide,
  changed,
  storePicture,
};
