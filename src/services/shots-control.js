'use strict';

// A before/after run gets one purpose-bound JWT and this run-scoped control
// plane. The shots agent can read its brief, save shots and clips, note what
// a change's shots leave out, skip a change with a reason, note a few
// problems it saw on the after build, and record what it did to both builds
// to reach a change (a request held or failed, a sample file uploaded). It
// cannot address another run, obtain app auth material, or invoke generic
// platform APIs.
//
// The control plane lives in Postgres (shot_run_control, shot_run_files), so
// any web process serves the agent's calls and a restart loses nothing the
// agent saved. Each call loads the run's workspace under a row lock, applies
// the call with RunControl's rules, and writes back what it changed: the
// agent's calls on one run are applied one at a time. The shots machine
// (src/workflow/shots/) reads the workspace once the agent's turn has ended
// (summaryFor), and publishes the saved files by copying them in SQL.

const planContract = require('./visible-changes');
const shots = require('./shots-files');
const shotsDiff = require('./shots-diff');
const closeups = require('./shots-closeups');
const homeTile = require('./shots-home-tile');

class ShotsControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ShotsControlError';
    this.code = code;
    this.status = status;
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// The run's phone sign-in code (the brief's phoneSignIn.code, on Homeroom's
// own copies), masked wherever the agent wrote it: six digits on their own,
// or with a space or a dash between them ("482 913"). Below the length the
// log redaction masks literals at, so it gets its own pattern.
function maskPhoneTestCode(text, code) {
  if (typeof text !== 'string' || !/^[0-9]{6}$/.test(String(code || ''))) return text;
  const digits = new RegExp(`(?<![0-9])${[...String(code)].join('[ -]?')}(?![0-9])`, 'g');
  return text.replace(digits, '****');
}

class RunControl {
  constructor({ runId, sessionId, intent, context, expiresAt, homeTiles = null, afterOnly = false }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
    // A project's first version: the before address is still the starter
    // template's placeholder (shots-starter.js), so this run takes and
    // publishes the after side only, and a before shot is refused.
    this.afterOnly = afterOnly === true;
    // The brief hands the agent this code; what the agent writes for people
    // (a skip reason, a note) is shown on the proposal, so it never keeps it.
    this.phoneTestCode = this.context?.phoneSignIn?.code || null;
    // Each side's tile on Homeroom's home screen, served on that side's
    // address (services/shots-home-tile.js). Kept out of the brief, which
    // only describes them: an icon image is up to 256 KB.
    this.homeTiles = homeTiles ? cloneJson(homeTiles) : null;
    this.expiresAt = Number(expiresAt || Date.now() + 8 * 60_000);
    this.saved = new Map();
    this.skipped = new Map();
    // The skipped changes the agent said the after build broke on: it did
    // the steps and the app errored. Shown and handled as the change not
    // working, not as a state these copies could not reach.
    this.failed = new Set();
    // What a change's shots leave out, shown beside them once it is ready.
    this.notes = new Map();
    // Problems the agent noticed on the after build besides the declared
    // changes, in the order it noted them (at most shots.MAX_NOTICES).
    // Advisory: nothing here changes a change's status or the run's.
    this.notices = [];
    // What the agent did to both builds to reach each change's state (an API
    // GET held or failed, a sample file uploaded), recorded before it does
    // it and shown beside that change's shots.
    this.conditions = new Map();
    // Set when the agent says nothing at all can be shot (for example every
    // screen shows a sign-in page); it explains every change that is not
    // ready and has no reason of its own.
    this.skippedAll = null;
    this.skippedAllFailed = false;
    // The last refused tool call survives a normal model exit, for the
    // owner's diagnostics.
    this.lastToolFailure = null;
    // The slots saved by the call being applied, written back after it.
    this.dirty = new Set();
  }

  assertLive() {
    if (Date.now() > this.expiresAt) {
      throw new ShotsControlError('shots_control_expired', 'This preview run has expired.', 410);
    }
  }

  assertOpen() {
    this.assertLive();
    if (this.skippedAll) throw new ShotsControlError('shots_turn_finished', 'This preview run was already skipped.');
  }

  getContext() {
    this.assertLive();
    return cloneJson({ ...this.context, progress: this.progress() });
  }

  // The page the proxy serves at the home tile path on one side's address.
  homeTilePage(side) {
    this.assertLive();
    const tile = homeTile.SIDES.includes(side) ? this.homeTiles?.[side] : null;
    if (!tile) throw new ShotsControlError('home_tile_unavailable', 'This run has no home tile for that side.', 404);
    return homeTile.renderPage(tile, { side });
  }

  // A close-up the shots bridge took (shots-closeups.js): kept only in a run
  // taken at device density, for a change and screen whose close-ups are
  // wanted (`asked`, shots-closeups.wanted), at the size asked for, within
  // the limits, and only when it is the after still (`afterStill`, its 1x
  // copy) at that place. Saving the same one again replaces it.
  saveCloseup(raw, buffer, { asked = [], afterStill = null, beforeStill = null } = {}) {
    try {
      this.assertOpen();
      if (this.agent?.deviceDensity !== true) {
        throw new ShotsControlError('closeup_not_needed', 'This run takes no close-ups.', 400);
      }
      const ask = asked.find((entry) => entry.change === String(raw?.change || '') && entry.screen === String(raw?.screen || '')
        && entry.part === Number(raw?.part));
      if (!ask) throw new ShotsControlError('closeup_not_wanted', 'No close-up of that change and screen is wanted.', 400);
      const info = shots.inspectImage(buffer, { maxBytes: shots.MAX_DENSE_IMAGE_BYTES });
      const close = (have, want) => Math.abs(have - want) <= 2;
      if (!close(info.width, Math.round(ask.rect.w * ask.scale)) || !close(info.height, Math.round(ask.rect.h * ask.scale))
          || info.width * info.height > closeups.MAX_PIXELS * 1.01) {
        throw new ShotsControlError('closeup_wrong_size', 'The close-up is not the size asked for.', 400);
      }
      if (!afterStill || !closeups.matches(afterStill, buffer, ask.rect, { beforeStill })) {
        throw new ShotsControlError('closeup_not_the_after_screen',
          'The close-up does not show the after screen as it was shot: the page has probably moved on. '
          + 'Open the after state again, take its screen shot again and save it; the close-up is taken again with it.', 409);
      }
      const entry = shots.storedCloseup({ storyId: ask.change, viewport: ask.screen, part: ask.part, rect: ask.rect, scale: ask.scale },
        buffer, info);
      const slot = shots.slotKey(entry);
      this.saved.set(slot, entry);
      this.dirty.add(slot);
      return { saved: true, change: ask.change, screen: ask.screen, part: ask.part, scale: ask.scale };
    } catch (error) {
      this.lastToolFailure = { operation: 'save-closeup', error };
      throw error;
    }
  }

  // The close-ups saved so far, by change, screen and number.
  savedCloseups() {
    return [...this.saved.values()].filter((file) => file.variant === 'closeup')
      .map((file) => ({ change: file.storyId, screen: file.viewport, part: file.part }));
  }

  // Device pixels per CSS pixel in a still, as the worker reported it: only
  // in a run taken at device density, only from a worker whose screenshot
  // tool saves at device scale (the bridge that reports it ships with that
  // tool, so an older worker reports nothing and its stills stay 1x), and,
  // for a whole screen, only when its width says the same.
  stillDensity(target, info, reported, deviceDensity) {
    const said = Number(reported);
    if (!deviceDensity || ![2, 3, 4].includes(said)) return 1;
    if (target.variant !== 'context') return said;
    const viewport = this.declaredChange(target.storyId).viewports.find((v) => v.name === target.viewport);
    return viewport && shots.densityFor(info.width, viewport.width) === said ? said : 1;
  }

  // One file the agent saved: a screen or element shot, or a clip. Saving the
  // same slot again replaces it, so the agent can retake a poor shot, and
  // saving for a change it skipped takes that skip back.
  saveShot(rawTarget, buffer) {
    try {
      this.assertOpen();
      const target = shots.shotTarget(this.intent, rawTarget);
      if (this.afterOnly && target.side === 'base') {
        throw new ShotsControlError('before_not_needed',
          'This app is new: the before address shows only the starter template\'s placeholder, so this run '
          + 'takes after shots only. Save the after side of each change and leave the before address alone.', 400);
      }
      // A run taken at the screen's own density (services/shots-density.js)
      // saves larger stills, and its element shots may be that much larger.
      const deviceDensity = this.agent?.deviceDensity === true;
      const info = target.media === 'webm' ? shots.inspectClip(buffer)
        : shots.inspectImage(buffer, deviceDensity ? { maxBytes: shots.MAX_DENSE_IMAGE_BYTES } : {});
      // Such a run's still is kept twice: its original, and the same still
      // averaged down to 1x, which is all anyone outside the experiment is
      // shown and what every comparison below and later reads.
      const density = target.media === 'png' ? this.stillDensity(target, info, rawTarget?.density, deviceDensity) : 1;
      const flatBuffer = density > 1 ? shotsDiff.flatten(buffer, density) : null;
      const flat = flatBuffer ? shots.inspectImage(flatBuffer) : null;
      const sha256 = flat ? flat.sha256 : info.sha256;
      // A dark shot identical to its light one is not kept (#4459): there
      // would be nothing to switch to, and the answer tells the agent this
      // app does not change with the mode, so it can stop taking dark shots.
      if (target.theme === 'dark') {
        const light = this.saved.get(shots.slotKey({ ...target, theme: 'light' }));
        if (light && light.sha256 === sha256) {
          return {
            saved: false,
            change: target.storyId,
            screen: target.viewport,
            side: target.side === 'base' ? 'before' : 'after',
            kind: 'screen',
            sameAsLight: true,
            hint: 'This screen looks the same in dark mode as in light, so the dark shot was not kept. '
              + 'This app does not change with the mode: leave out the rest of the dark shots.',
          };
        }
      }
      shots.checkElementSize(
        this.declaredChange(target.storyId), target, info,
        this.saved.get(shots.slotKey({ ...target, variant: 'context' })),
        { deviceDensity, density },
      );
      const slot = shots.slotKey(target);
      const entry = flat
        ? shots.stored(target, flatBuffer, flat, { density, data: buffer, ...info })
        : shots.stored(target, buffer, info);
      entry.publicSafe = publicSafeOf(rawTarget?.showsPrivate);
      this.saved.set(slot, entry);
      this.dirty.add(slot);
      this.skipped.delete(target.storyId);
      this.failed.delete(target.storyId);
      // The same image on the other side says the two sides were not shot
      // in the states the claim compares. Said while the agent can still
      // retake them, not only on the card afterwards.
      const otherSide = target.media === 'png'
        ? this.saved.get(shots.slotKey({ ...target, side: target.side === 'base' ? 'head' : 'base' }))
        : null;
      const sameAsOtherSide = !!otherSide && otherSide.sha256 === sha256;
      return {
        saved: true,
        change: target.storyId,
        screen: target.viewport,
        side: target.side === 'base' ? 'before' : 'after',
        kind: target.variant === 'animation' ? 'clip' : target.variant === 'focus' ? 'element' : 'screen',
        bytes: info.bytes,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        ...(sameAsOtherSide ? {
          sameAsOtherSide: true,
          warning: 'This before and after are the same image, so they cannot show the change. Check that each '
            + 'side followed the steps to the state the claim describes, at the same scroll position, and shoot '
            + 'again. If these copies cannot show the change, call note_change to say what the shots leave out, '
            + 'or skip_change.',
        } : {}),
        progress: this.progress(),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'save-shot', error };
      throw error;
    }
  }

  // The agent could not reach a change, or found that the shots it saved do
  // not show it. Its reason is shown on the proposal for that change, and
  // nothing saved for it is published; the other changes still are. Without
  // a change id the reason covers every change that is not ready and has
  // none of its own. `outcome: 'failed'` says the agent did the steps and
  // the after build broke, so the change is failed rather than skipped.
  skipChange({ change = null, reason, outcome = null } = {}) {
    try {
      this.assertOpen();
      const text = maskPhoneTestCode(shots.reason(reason), this.phoneTestCode);
      const broke = shots.outcome(outcome) === 'failed';
      const said = broke ? { outcome: 'failed' } : {};
      if (change == null || change === '') {
        this.skippedAll = text;
        this.skippedAllFailed = broke;
        return { skipped: 'all', ...said, progress: this.progress() };
      }
      const story = this.declaredChange(change);
      this.skipped.set(story.id, text);
      if (broke) this.failed.add(story.id);
      else this.failed.delete(story.id);
      return { skipped: story.id, ...said, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'skip-change', error };
      throw error;
    }
  }

  // What a change's shots leave out (part of the claim these copies cannot
  // show). Shown beside the shots once the change is ready; a later note
  // replaces it.
  noteChange({ change = null, note } = {}) {
    try {
      this.assertOpen();
      const story = this.declaredChange(change);
      this.notes.set(story.id, maskPhoneTestCode(shots.note(note), this.phoneTestCode));
      return { noted: story.id, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-change', error };
      throw error;
    }
  }

  // A clear problem the agent saw on the after build while it took the
  // shots, such as content cut off or controls overlapping. Shown on the
  // proposal under "Also noticed". Noting the same problem at the same place
  // again updates it rather than adding another; past the cap it is refused,
  // so the agent keeps only what matters most.
  noteProblem(raw = {}) {
    try {
      this.assertOpen();
      const entry = shots.notice(this.intent, raw);
      const same = this.notices.findIndex((existing) => existing.change === entry.change
        && existing.screen === entry.screen && existing.text.toLowerCase() === entry.text.toLowerCase());
      if (same >= 0) this.notices[same] = entry;
      else if (this.notices.length >= shots.MAX_NOTICES) {
        throw new ShotsControlError('too_many_notices',
          `This run already has ${shots.MAX_NOTICES} problems noted, the most it keeps. Note only what a person would agree is broken.`);
      } else this.notices.push(entry);
      return {
        noticed: entry.change,
        screen: entry.screen,
        alsoBefore: entry.alsoBefore,
        notices: this.notices.length,
        remaining: shots.MAX_NOTICES - this.notices.length,
        // "unknown" says nothing to a person reading it, and the agent
        // shoots the before side of every screen it shoots the after side
        // of, so it is asked to look and say.
        ...(entry.alsoBefore === 'unknown' ? { hint: this.alsoBeforeHint(entry) } : {}),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-problem', error };
      throw error;
    }
  }

  // What a notice without alsoBefore asks of the agent: to look at the
  // before shot of that screen, now or once it has taken it.
  alsoBeforeHint({ change, screen }) {
    const lead = this.saved.has(shots.slotKey({ storyId: change, viewport: screen, side: 'base', variant: 'context' }))
      ? 'You saved the before shot of this screen: look at it'
      : 'Once you have shot the before side of this screen, look at it';
    return `${lead} and note this problem again with alsoBefore true or false, so people can tell whether this `
      + 'change brought it. Noting the same problem at the same place updates it.';
  }

  // The shots bridge records what it is about to do to both builds for a
  // change (control_request, upload_file) before it does it; the same thing
  // again is recorded once.
  noteCondition(raw = {}) {
    try {
      this.assertOpen();
      const { change, ...entry } = shots.condition(this.intent, raw);
      const list = this.conditions.get(change) || [];
      if (!list.some((existing) => shots.sameCondition(existing, entry))) {
        if (list.length >= shots.MAX_CONDITIONS) {
          throw new ShotsControlError('too_many_conditions',
            `${change} already has ${shots.MAX_CONDITIONS} controlled tests and sample files, the most a change shows.`);
        }
        list.push(entry);
        this.conditions.set(change, list);
      }
      return { recorded: change, conditions: list.length };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-condition', error };
      throw error;
    }
  }

  declaredChange(change) {
    const story = this.intent.stories.find((candidate) => candidate.id === String(change ?? ''));
    if (!story) {
      throw new ShotsControlError('unknown_change', `Change ${JSON.stringify(String(change ?? ''))} is not one the author declared.`, 400);
    }
    return story;
  }

  summary() {
    return shots.summarize(this.intent, this.saved, this.skipped, {
      fallbackReason: this.skippedAll, notes: this.notes,
      failed: this.failed, fallbackFailed: this.skippedAllFailed, notices: this.notices,
      conditions: this.conditions, afterOnly: this.afterOnly,
    });
  }

  progress() {
    return this.summary().stories.map((story) => ({
      change: story.id,
      status: story.status === 'ready' || story.status === 'failed' ? story.status
        : this.skipped.has(story.id) || this.skippedAll ? 'skipped' : 'missing',
      ...(story.status === 'ready' ? (story.note ? { note: story.note } : {}) : { detail: story.reason }),
    }));
  }
}

// ── Persistence ─────────────────────────────────────────────────────────

const RUN_ID = /^[0-9a-f]{32}$/;

// A saved file's slot as Postgres keeps it (shot_run_files.slot, and the
// slots a run publishes): its change, screen, side and kind. The in-memory
// key (shots-files.slotKey) separates them with NUL, which neither text nor
// jsonb holds.
function dbSlot({ storyId, viewport, side, variant, theme, part }) {
  // A dark file's slot extends the light one only when it is dark, and a
  // close-up's by its number, so every other slot stays exactly as it is now.
  return [storyId, viewport, side, variant, ...(theme === 'dark' ? ['dark'] : []),
    ...(variant === 'closeup' ? [String(Number(part) || 1)] : [])].join('/');
}
const mapOf = (value) => new Map(Object.entries(value && typeof value === 'object' ? value : {}));
const objectOf = (map) => Object.fromEntries(map);

// Whether a still may be shown to a visitor who is not signed in: only on
// the agent's clear "shows nothing private" (save_shot's showsPrivate
// false, "0" on the wire). Anything else, an unanswered save included, is
// null: never public.
function publicSafeOf(showsPrivate) {
  return showsPrivate === '0' || showsPrivate === false ? true : null;
}

// A saved file as RunControl keeps it: everything but its bytes, which stay
// in the database (a retake replaces the row; publication copies it).
function fileEntry(row) {
  return {
    storyId: row.story_id, viewport: row.viewport, side: row.side, variant: row.variant, media: row.media,
    // Rows written before the column existed read as light.
    theme: row.theme === 'dark' ? 'dark' : 'light',
    contentType: row.content_type, width: row.width, height: row.height, bytes: row.bytes, sha256: row.sha256,
    // A still kept at device density as well (services/shots-density.js):
    // its original's size, whose bytes also stay in the database.
    density: Number.isInteger(row.density) && row.density > 1 ? row.density : 1,
    dense: Number.isInteger(row.density) && row.density > 1 ? {
      width: row.dense_width, height: row.dense_height, bytes: row.dense_bytes, sha256: row.dense_sha256,
    } : null,
    // A close-up's number on its screen, region and density (shots-closeups.js).
    ...(row.variant === 'closeup' ? { part: Number(row.part) || 1, scale: Number(row.scale), focusRect: row.focus_rect || null }
      : { focusRect: null }),
    stageLabels: null,
    publicSafe: row.public_safe === true ? true : null,
  };
}

function toolFailureOf(value) {
  if (!value) return null;
  const error = value.error || {};
  return { operation: value.operation, error: { code: error.code || null, message: String(error.message || '').slice(0, 500) } };
}

function fromRow(row, files) {
  const control = new RunControl({
    runId: row.run_id, sessionId: row.session_id, intent: row.intent, context: row.context,
    expiresAt: new Date(row.expires_at).getTime(), homeTiles: row.home_tiles, afterOnly: row.after_only,
  });
  for (const file of files) {
    const entry = fileEntry(file);
    control.saved.set(shots.slotKey(entry), entry);
  }
  control.skipped = mapOf(row.skipped);
  control.failed = new Set(Array.isArray(row.failed) ? row.failed : []);
  control.notes = mapOf(row.notes);
  control.notices = Array.isArray(row.notices) ? row.notices : [];
  control.conditions = mapOf(row.conditions);
  control.skippedAll = row.skipped_all || null;
  control.skippedAllFailed = row.skipped_all_failed === true;
  control.lastToolFailure = row.last_tool_failure || null;
  control.kind = row.kind;
  control.agent = row.agent || null;
  return control;
}

async function inTransaction(pool, fn) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const db = client || pool;
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

async function load(db, runId, { lock = false } = {}) {
  const { rows: [row] } = await db.query(
    `SELECT * FROM shot_run_control WHERE run_id = $1${lock ? ' FOR UPDATE' : ''}`, [runId]);
  if (!row) return null;
  const { rows: files } = await db.query(
    `SELECT slot, story_id, viewport, side, variant, media, theme, content_type, width, height, bytes, sha256,
            density, dense_width, dense_height, dense_bytes, dense_sha256, part, scale, focus_rect, public_safe
       FROM shot_run_files WHERE run_id = $1`, [runId]);
  return { row, control: fromRow(row, files) };
}

async function persist(db, control) {
  await db.query(
    `UPDATE shot_run_control
        SET skipped = $2::jsonb, failed = $3::jsonb, notes = $4::jsonb, notices = $5::jsonb,
            conditions = $6::jsonb, skipped_all = $7, skipped_all_failed = $8,
            last_tool_failure = $9::jsonb, updated_at = NOW()
      WHERE run_id = $1`,
    [control.runId, JSON.stringify(objectOf(control.skipped)), JSON.stringify([...control.failed]),
      JSON.stringify(objectOf(control.notes)), JSON.stringify(control.notices),
      JSON.stringify(objectOf(control.conditions)), control.skippedAll, control.skippedAllFailed,
      JSON.stringify(toolFailureOf(control.lastToolFailure))]);
  for (const key of control.dirty) {
    const f = control.saved.get(key);
    const slot = dbSlot(f);
    await db.query(
      `INSERT INTO shot_run_files
         (run_id, slot, story_id, viewport, side, variant, media, theme, content_type, data, width, height, bytes, sha256,
          density, dense_data, dense_width, dense_height, dense_bytes, dense_sha256, part, scale, focus_rect, public_safe)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24)
       ON CONFLICT (run_id, slot) DO UPDATE
         SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, media = EXCLUDED.media,
             theme = EXCLUDED.theme, width = EXCLUDED.width, height = EXCLUDED.height, bytes = EXCLUDED.bytes,
             sha256 = EXCLUDED.sha256, density = EXCLUDED.density, dense_data = EXCLUDED.dense_data,
             dense_width = EXCLUDED.dense_width, dense_height = EXCLUDED.dense_height,
             dense_bytes = EXCLUDED.dense_bytes, dense_sha256 = EXCLUDED.dense_sha256,
             part = EXCLUDED.part, scale = EXCLUDED.scale, focus_rect = EXCLUDED.focus_rect,
             public_safe = EXCLUDED.public_safe, saved_at = NOW()`,
      [control.runId, slot, f.storyId, f.viewport, f.side, f.variant, f.media, f.theme || 'light', f.contentType, f.data,
        f.width, f.height, f.bytes, f.sha256, f.density > 1 ? f.density : 1, f.dense?.data || null,
        f.dense?.width || null, f.dense?.height || null, f.dense?.bytes ?? null, f.dense?.sha256 || null,
        f.variant === 'closeup' ? f.part : 0, f.variant === 'closeup' ? f.scale : null,
        f.variant === 'closeup' && f.focusRect ? JSON.stringify(f.focusRect) : null, f.publicSafe === true ? true : null]);
  }
  control.dirty.clear();
}

// A proposal's run is answered only while it is the proposal's current run
// and its agent is at work (the shots machine's `taking_shots`, which the
// slot shows as `exploring`): a call from a turn that outlived its run, or
// that arrives once the run has moved on, changes nothing.
async function assertCurrent(db, control) {
  if (control.kind !== 'run') return;
  const { rows: [s] } = await db.query(
    'SELECT shots_run_id, shots_state FROM chat_sessions WHERE id = $1', [control.sessionId]);
  if (!s || s.shots_run_id !== control.runId || s.shots_state !== 'exploring') {
    throw new ShotsControlError('shots_control_not_found', 'This preview run is no longer active.', 410);
  }
}

/**
 * Apply one of the agent's calls to run `runId`, for the worker of
 * `sessionId`: fn(control) runs RunControl's rule, and what it changed is
 * written back in the same transaction. A refused call still records itself
 * as the last refused call (the owner's diagnostics). Resolves fn's answer.
 * `readOnly`: the call only reads (the brief, a home tile), so it neither
 * waits for the agent's saves nor writes anything back but a refusal.
 */
async function withControl(pool, { runId, sessionId }, fn, { readOnly = false } = {}) {
  if (!RUN_ID.test(String(runId || ''))) throw new ShotsControlError('shots_control_not_found', 'This preview run is no longer active.', 410);
  let refused = null;
  const run = readOnly ? (body) => body(pool) : (body) => inTransaction(pool, body);
  const out = await run(async (db) => {
    const loaded = await load(db, runId, { lock: !readOnly });
    if (!loaded) throw new ShotsControlError('shots_control_not_found', 'This preview run is no longer active.', 410);
    const { control } = loaded;
    if (control.sessionId !== Number(sessionId)) {
      throw new ShotsControlError('shots_scope_mismatch', 'This token does not own this preview run.', 403);
    }
    control.assertLive();
    await assertCurrent(db, control);
    try {
      const answer = await fn(control, db);
      if (!readOnly) await persist(db, control);
      return { answer };
    } catch (error) {
      // Only the refusal is kept; whatever the call half did is not.
      if (control.lastToolFailure?.error === error) {
        await db.query('UPDATE shot_run_control SET last_tool_failure = $2::jsonb, updated_at = NOW() WHERE run_id = $1',
          [runId, JSON.stringify(toolFailureOf(control.lastToolFailure))]);
        refused = error;
        return null;
      }
      throw error;
    }
  });
  if (refused) throw refused;
  return out.answer;
}

/**
 * The run's workspace, made when its copies serve (a retry of the same
 * step writes it again): the brief, the home tiles, what the dispatch
 * needs. A workspace that exists keeps what the agent already saved.
 */
async function create(pool, {
  runId, sessionId, kind = 'run', intent, context, homeTiles = null, afterOnly = false, agent = null, expiresAt,
}) {
  if (!RUN_ID.test(String(runId || ''))) {
    throw new ShotsControlError('invalid_shots_run', 'A valid preview run id is required.', 400);
  }
  await pool.query(
    `INSERT INTO shot_run_control (run_id, kind, session_id, intent, context, home_tiles, after_only, agent, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)
     ON CONFLICT (run_id) DO UPDATE
       SET context = EXCLUDED.context, home_tiles = EXCLUDED.home_tiles, after_only = EXCLUDED.after_only,
           agent = EXCLUDED.agent, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
    [runId, kind, Number(sessionId), JSON.stringify(planContract.parseIntent(intent)), JSON.stringify(context ?? {}),
      homeTiles ? JSON.stringify(homeTiles) : null, afterOnly === true, agent ? JSON.stringify(agent) : null,
      new Date(expiresAt)]);
}

// When the agent may write until: its dispatch sets it from its clock.
async function extend(pool, runId, expiresAt) {
  await pool.query('UPDATE shot_run_control SET expires_at = $2, updated_at = NOW() WHERE run_id = $1',
    [runId, new Date(expiresAt)]);
}

// What the agent is doing now, for the owner's diagnostics (nothing decides
// on it).
async function noteProgress(pool, runId, progress) {
  const json = JSON.stringify(progress ?? null);
  if (json.length > 64_000) return;
  await pool.query('UPDATE shot_run_control SET progress = $2::jsonb WHERE run_id = $1', [runId, json]);
}

// The run's workspace as RunControl, read without a lock (its summary once
// the turn has ended, the dispatch's needs, diagnostics). Null when gone.
async function read(pool, runId) {
  const loaded = await load(pool, runId);
  return loaded ? loaded.control : null;
}

// Every saved file with its bytes, for the slots named (the screen diff).
async function filesFor(pool, runId, slots = null) {
  const { rows } = await pool.query(
    `SELECT slot, story_id, viewport, side, variant, media, theme, content_type, data, width, height, bytes, sha256,
            density, part, scale, focus_rect
       FROM shot_run_files WHERE run_id = $1 ${slots ? 'AND slot = ANY($2::text[])' : ''}`,
    slots ? [runId, slots] : [runId]);
  return rows.map((row) => ({ ...fileEntry(row), data: row.data }));
}

async function remove(pool, runId) {
  await pool.query('DELETE FROM shot_run_control WHERE run_id = $1', [runId]);
}

// What the run's workspace adds up to when the agent's turn has ended:
// shots-files.summarize over what it saved and said, without the bytes.
async function summaryFor(pool, runId) {
  const control = await read(pool, runId);
  if (!control) return null;
  const summary = control.summary();
  return {
    summary,
    counts: {
      savedFiles: control.saved.size,
      skippedChanges: control.skipped.size,
      ...(control.failed.size ? { failedChanges: control.failed.size } : {}),
      notedChanges: control.notes.size,
      ...(control.notices.length ? { notedProblems: control.notices.length } : {}),
      ...(control.conditions.size ? {
        notedConditions: [...control.conditions.values()].reduce((sum, list) => sum + list.length, 0),
      } : {}),
      skippedAll: !!control.skippedAll,
    },
    skippedAny: control.skipped.size > 0 || !!control.skippedAll,
    lastToolFailure: control.lastToolFailure,
    agent: control.agent,
  };
}

// The close-ups run `control`'s after screens want now (shots-closeups.js),
// each with whether it is saved: only in a run taken at device density,
// for the changes with both a before and an after screen shot saved, on
// the screens the card shows (shots-diff.screensFor, the same comparison the
// run's verdict makes). Read inside withControl (`db` its transaction).
async function wantedCloseups(db, control) {
  if (control.agent?.deviceDensity !== true || control.afterOnly) return [];
  const stories = control.intent.stories.filter((story) => story.viewports.some((viewport) => ['base', 'head']
    .every((side) => control.saved.has(shots.slotKey({ storyId: story.id, viewport: viewport.name, side, variant: 'context' })))));
  if (!stories.length) return [];
  const files = await filesFor(db, control.runId);
  const screens = await shotsDiff.screensFor(stories,
    files.filter((file) => file.variant !== 'closeup' && file.theme !== 'dark'));
  const stillDensity = (screen) => control.saved.get(shots.slotKey({
    storyId: screen.shot, viewport: screen.viewport, side: 'head', variant: 'context',
  }))?.density || 1;
  const saved = control.savedCloseups();
  return closeups.wanted(screens, stillDensity).map((ask) => ({
    ...ask,
    saved: saved.some((entry) => entry.change === ask.change && entry.screen === ask.screen && entry.part === ask.part),
  }));
}

// The 1x copies of a change's before and after screen shots on one screen,
// for a close-up's check.
async function stillsFor(db, control, { change, screen }) {
  const files = await filesFor(db, control.runId, ['base', 'head']
    .map((side) => dbSlot({ storyId: change, viewport: screen, side, variant: 'context' })));
  const of = (side) => files.find((file) => file.side === side)?.data || null;
  return { afterStill: of('head'), beforeStill: of('base') };
}

module.exports = {
  ShotsControlError,
  RunControl,
  dbSlot,
  maskPhoneTestCode,
  withControl,
  create,
  extend,
  noteProgress,
  read,
  filesFor,
  wantedCloseups,
  stillsFor,
  remove,
  summaryFor,
};
