'use strict';

// What a proposal still needs before it merges — the whole ordered list, not
// just the thing currently wrong with it.
//
// The card's tags are a NEGATIVE surface: they name what is broken and say
// nothing about what is required. So an absent tag is ambiguous between three
// very different facts — the gate passed, the gate does not apply here, or the
// gate has no UI at all. The third case was real for two of the seven: a
// locked app's admin-yes requirement surfaced only as a toast to whoever voted
// next, and the GitHub-side refusals surfaced nowhere.
//
// A developer can infer the rest. The question a voter actually has is not
// "what state is this in" but "is it my turn?", and no arrangement of tags
// answers that.
//
// ── Why this is a spec plus a stop point, and not a second evaluator ──
//
// routes/votes.js's checkAndMerge IS the gate. Re-deriving its conditions here
// would mean two implementations of "can this merge", drifting apart, with the
// describing one eventually lying about the deciding one.
//
// It does not need re-deriving. The gate is a fixed, ordered list, and
// evaluation only ever has to reach the FIRST refusal: everything before it
// passed, the refusal is where the proposal is now, and everything after it is
// simply not reached yet. So checkAndMerge records what it actually did, from
// the same call sites that already narrate it into merge_debug_runs, and this
// module holds the static order and turns the two into a list.
//
// That is also why `evaluated` is stored as an ORDERED ARRAY rather than a map
// keyed by gate: it is a recording of a real run, and its order is the gate's
// order, not this file's idea of it.
//
// Named REQUIREMENTS, not "merge gate", on purpose: services/active-users.js
// already exports a mergeGate(), and it is only the first of the seven steps
// below — the vote threshold. Two things called the same would be read as one.

// The gates, in the order checkAndMerge evaluates them. `key` matches the
// phase its dstep() already reports.
//
// `actor` is the half that makes the list worth showing. Most steps are
// 'auto' — nobody has to do anything — and saying so is the reassurance the
// tags structurally cannot give. The other three name a person, and that is
// what the card's opening rule keys on.
const GATES = [
  {
    key: 'approvals',
    label: 'Enough approvals',
    actor: 'group',
  },
  {
    key: 'explicit',
    label: 'Explicit approval from the group',
    actor: 'group',
    // Only for a change to dapp.json's admins block, which loses the
    // time-based merge paths entirely.
    applies: (c) => !!c.explicitApproval,
  },
  {
    key: 'admin_yes',
    label: 'An admin approves it',
    actor: 'admin',
    applies: (c) => !!c.locked,
  },
  {
    // Under direct-merge lanes (services/merge-queue.js) this asks one thing:
    // does the head merge cleanly with main? Being behind is not a step —
    // a clean head merges as it stands — so the step is DONE for any clean
    // head, however far behind, and the drift is a note on it. A conflict
    // is the platform's to resolve (actor 'auto') until the conflict lane
    // says otherwise: a head it will not resolve until the vote is the
    // group's, one it cannot push to or could not resolve is the author's.
    // The evaluated entry carries that override (see describe()).
    key: 'integration',
    label: 'Merges cleanly with main',
    actor: 'auto',
  },
  {
    key: 'checks',
    label: 'Checks pass',
    actor: 'author',
  },
  {
    key: 'platform_env',
    label: 'Platform variables have values',
    actor: 'admin',
    // The platform's own app only: a proposal that declares a required
    // variable with no value would deploy the platform into a crash loop.
    applies: (c) => !!c.selfHosted,
  },
  {
    // The app's state, not the proposal's: services/main-watch.js runs the
    // repo's unit suite on every merge commit, and a red main pauses every
    // merge on the app until a fix lands or an admin resumes them. Nothing
    // the author does clears it, which is why the actor is the admin.
    key: 'main_healthy',
    label: 'Main is healthy',
    actor: 'admin',
  },
  {
    key: 'github',
    label: 'GitHub accepts the merge',
    actor: 'auto',
  },
];

// Actors an evaluated entry may name instead of its gate's default. Only the
// integration gate uses this: who resolves a conflict depends on what the
// conflict lane decided about it, which the gate learns at run time.
const ACTORS = new Set(['auto', 'author', 'admin', 'group']);

const GATE_KEYS = new Set(GATES.map((g) => g.key));

// The one rule for which commit a proposal's approvals and checks are about.
const { reviewedHeadForSession } = require('./pr-vote-revision');

function intOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// done    — passed
// active  — in flight, nobody has to act (a sync, a check run, the merge)
// waiting — a person has to do something
// blocked — something failed and needs fixing
// pending — not reached yet
const STATES = new Set(['done', 'active', 'waiting', 'blocked', 'pending']);

/**
 * Collects what a single checkAndMerge run actually did.
 *
 * The gate calls pass() as it clears each condition and stop() at the one that
 * refuses, beside the dstep() already there. Nothing here decides anything —
 * it only records, which is the property that keeps it honest.
 */
function trace() {
  const evaluated = [];
  const context = {};
  let stopped = false;
  return {
    /** Record which optional gates apply to this proposal at all. */
    context(patch) {
      Object.assign(context, patch || {});
      return this;
    },
    pass(key, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (stopped) return this;
      evaluated.push({ key, state: 'done', detail: detail || null });
      return this;
    },
    /** The gate that refused. Everything after it is 'pending' by definition. */
    stop(key, state, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (!STATES.has(state)) throw new Error(`Unknown gate state: ${state}`);
      if (stopped) return this;
      evaluated.push({ key, state, detail: detail || null });
      stopped = true;
      return this;
    },
    /**
     * Correct the recorded stop once its real outcome is known.
     *
     * Gate 7 is the only caller. It is marked 'active' before the merge is
     * attempted — which is genuinely what is happening while it runs — and the
     * attempt then either succeeds or fails in one of three ways that used to
     * be visible nowhere. Revising is how one gate reports both, without
     * letting a later gate's mark reopen an earlier gate's refusal.
     */
    revise(key, state, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (!STATES.has(state)) throw new Error(`Unknown gate state: ${state}`);
      const last = evaluated[evaluated.length - 1];
      if (!last || last.key !== key) return this;
      last.state = state;
      last.detail = detail || null;
      return this;
    },
    get stopped() { return stopped; },
    toRecord() {
      return { evaluated: evaluated.slice(), context: { ...context } };
    },
  };
}

/**
 * spec + what the run did → the full ordered list the card renders.
 *
 * A gate that does not apply is OMITTED rather than greyed: a locked-app row
 * on an unlocked app is noise, and the count should read 4 of 4 rather than
 * 4 of 7.
 */
function describe(record) {
  const r = record || {};
  const evaluated = Array.isArray(r.evaluated) ? r.evaluated : [];
  const context = r.context || {};
  const seen = new Map();
  for (const e of evaluated) {
    if (e && GATE_KEYS.has(e.key) && !seen.has(e.key)) seen.set(e.key, e);
  }
  const out = [];
  for (const gate of GATES) {
    if (gate.applies && !gate.applies(context)) continue;
    const hit = seen.get(gate.key);
    const override = hit && hit.detail && ACTORS.has(hit.detail.actor) ? hit.detail.actor : null;
    out.push({
      key: gate.key,
      label: gate.label,
      actor: override || gate.actor,
      state: hit && STATES.has(hit.state) ? hit.state : 'pending',
      detail: (hit && hit.detail) || null,
    });
  }
  return out;
}

/**
 * The integration step, read off the columns: what the head measures against
 * main and, for a conflict, what the conflict lane has decided about it.
 * Shared by the provisional list and by the gate's own stop() so the two
 * surfaces say the same thing about the same row.
 *
 * @returns {{ state: string, actor: string, note: string|null }}
 */
function integrationStep(session) {
  const s = session || {};
  const behind = intOrNull(s.integration_behind_by);
  const clean = s.integration_merges_clean == null ? null : !!s.integration_merges_clean;
  const reasons = Array.isArray(s.integration_block_reasons) ? s.integration_block_reasons : [];
  const has = (r) => reasons.includes(r);
  const paths = Array.isArray(s.integration_conflict_paths) ? s.integration_conflict_paths.length : 0;
  const files = paths ? ` in ${paths} file${paths === 1 ? '' : 's'}` : '';

  if (clean === true) {
    return {
      state: 'done', actor: 'auto',
      note: behind ? `${behind} commit${behind === 1 ? '' : 's'} behind main; merges as it stands`
        : 'level with main',
    };
  }
  if (clean === false) {
    if (has('integrating')) {
      return { state: 'active', actor: 'auto', note: `resolving a conflict with main${files}` };
    }
    if (has('unresolvable')) {
      return {
        state: 'blocked', actor: 'author',
        note: `conflicts with main${files} and the platform could not resolve it; the author has to`,
      };
    }
    if (has('fork_head')) {
      return {
        state: 'waiting', actor: 'author',
        note: `conflicts with main${files}; its head is on the author's fork, so only the author can update it`,
      };
    }
    if (has('awaiting_approval')) {
      return {
        state: 'waiting', actor: 'group',
        note: `conflicts with main${files}; the platform resolves it once the group approves`,
      };
    }
    if (has('budget')) {
      return {
        state: 'waiting', actor: 'admin',
        note: `conflicts with main${files}; the platform's token budget is exhausted`,
      };
    }
    return { state: 'active', actor: 'auto', note: `conflicts with main${files}; the platform will resolve it` };
  }
  return { state: 'pending', actor: 'auto', note: null };
}

// Who each actor means, in the words the card uses.
const ACTOR_WORD = { auto: 'automatic', author: 'the author', admin: 'an admin', group: 'the group' };

/**
 * The collapsed line — the whole answer for most people.
 *
 * `viewer` is { isAuthor, isAdmin, hasVoted }; all three are already known on
 * the client, so this costs no new field. It decides two things: whether the
 * headline says "you" instead of a role, and `opensFor` — the one viewer this
 * card should expand itself for.
 */
function summarize(list, viewer) {
  const gates = Array.isArray(list) ? list : [];
  const v = viewer || {};
  const total = gates.length;
  const done = gates.filter((g) => g.state === 'done').length;
  // The step the proposal is actually sitting on: the first that is neither
  // finished nor unreached.
  const current = gates.find((g) => g.state !== 'done' && g.state !== 'pending') || null;

  if (!current) {
    // Nothing in flight and nothing waiting. Either every step really is done,
    // or the ones left have never been measured — and those are opposite
    // facts. Saying "nothing left to check" for the second is the exact
    // mistake this feature exists to stop: a card that reads as finished when
    // it has simply never been looked at.
    if (total && done === total) {
      return {
        headline: 'Merging now', detail: `all ${total} steps done`,
        done, total, current: null, opensFor: null, needsViewer: false,
      };
    }
    return {
      headline: 'Nothing needs you',
      detail: 'still working out what this needs',
      done, total, current: null, opensFor: null, needsViewer: false,
    };
  }

  // 'auto' and anything in flight need nobody, whoever is looking.
  if (current.actor === 'auto' || current.state === 'active') {
    return {
      headline: 'Nothing needs you',
      detail: current.detail && current.detail.note ? current.detail.note : current.label.toLowerCase(),
      done, total, current: current.key, opensFor: null, needsViewer: false,
    };
  }

  const byActor = {
    author: { headline: 'Waiting on the author', mine: 'Waiting on you', opensFor: 'author', is: !!v.isAuthor },
    admin: { headline: 'Waiting on an admin', mine: 'Waiting on you', opensFor: 'admin', is: !!v.isAdmin },
    group: { headline: 'Waiting on the group', mine: 'Waiting on your vote', opensFor: 'voter', is: !v.hasVoted },
  }[current.actor] || null;

  if (!byActor) {
    return {
      headline: 'Waiting', detail: current.label.toLowerCase(),
      done, total, current: current.key, opensFor: null, needsViewer: false,
    };
  }

  return {
    headline: byActor.is ? byActor.mine : byActor.headline,
    detail: (current.detail && current.detail.note) || null,
    done,
    total,
    current: current.key,
    // A card opens itself only for the person who can clear the step it is
    // stuck on. An admin-approval row put in front of somebody who is not an
    // admin is a chore they cannot do.
    opensFor: byActor.opensFor,
    needsViewer: byActor.is,
  };
}

/**
 * The list before the gate has ever run against this proposal.
 *
 * The recording only happens when checkAndMerge runs, and checkAndMerge runs
 * on a vote or on the sweep for proposals ALREADY at threshold. So a proposal
 * below threshold — the case the checklist is most useful for, where the
 * honest answer is "your vote is the only thing missing" — would have shown
 * nothing at all, and a freshly cloned staging database would have shown
 * nothing anywhere. A feature that appears only after somebody votes is not a
 * feature.
 *
 * This is NOT the second evaluator the module header refuses. It re-states
 * what the card's own tags already say, off the same columns they read, in
 * list form. What it cannot know it does not guess: whether the app is locked
 * and whether a platform variable is unset are answers only the gate has, so
 * those gates are ABSENT here rather than assumed satisfied — and a record,
 * once written, supersedes this wholesale.
 */
function provisional(session) {
  const s = session || {};
  const out = [];

  const required = intOrNull(s.votes_required);
  const yes = intOrNull(s.qualified_yes_count) != null
    ? intOrNull(s.qualified_yes_count) : intOrNull(s.yes_count);
  out.push({
    key: 'approvals',
    label: 'Enough approvals',
    actor: 'group',
    state: (required != null && yes != null && yes >= required) ? 'done' : 'waiting',
    detail: (required != null && yes != null) ? { note: `${yes} of ${required}` } : null,
  });

  const step = integrationStep(s);
  out.push({
    key: 'integration',
    label: 'Merges cleanly with main',
    actor: step.actor,
    state: step.state,
    detail: step.note ? { note: step.note } : null,
  });

  const check = s.check_state || null;
  // A deferred verdict (services/check-admission.js) is a run the platform
  // chose not to start yet: the head conflicts with main, and the verdict
  // runs once it merges cleanly. Nobody has to act, and nothing is running.
  const deferred = check === 'pending' && s.check_phase === 'deferred';
  const checkState = (check === 'passing' || check === 'skipped') ? 'done'
    : (check === 'failing' || check === 'error') ? 'blocked'
      : check === 'pending' ? 'active' : 'pending';
  out.push({
    key: 'checks',
    label: 'Checks pass',
    actor: 'author',
    state: checkState,
    detail: check === 'failing' ? { note: 'some checks are failing' }
      : check === 'error' ? { note: 'the staging preview could not start, so the tests could not run' }
        : deferred ? { note: 'waiting for the head to merge cleanly; the preview is built, the tests run then' }
          : check === 'pending' ? { note: 'still running' } : null,
  });

  // The app's main, when the serializer has joined it on (app_main_check_*).
  // Absent, the step is absent too, like the lock and the platform
  // variables: an answer only the gate has is not guessed here.
  if (s.app_main_check_state !== undefined) {
    const mainState = s.app_main_check_state || null;
    const resumed = mainState === 'failing' && s.app_main_check_resumed_sha
      && s.app_main_check_sha
      && String(s.app_main_check_resumed_sha).toLowerCase() === String(s.app_main_check_sha).toLowerCase();
    const paused = mainState === 'failing' && !resumed;
    const short = s.app_main_check_sha ? String(s.app_main_check_sha).slice(0, 7) : null;
    out.push({
      key: 'main_healthy',
      label: 'Main is healthy',
      actor: 'admin',
      state: paused ? 'blocked' : (mainState === 'running' ? 'active' : 'done'),
      detail: paused
        ? { note: `main's unit suite is failing${short ? ` since ${short}` : ''}; merges are paused until a fix lands or an admin resumes them` }
        : mainState === 'running' ? { note: 'checking the last merge' }
          : resumed ? { note: 'main is red, but an admin resumed merges' }
            : null,
    });
  }

  // Left 'pending' unconditionally this would be the only never-done step in
  // a provisional list, so a proposal with every knowable requirement met
  // would read as unresolved forever. When the ones the columns DO cover are
  // all satisfied, the honest statement is that the platform is about to try.
  const allKnownDone = out.every((g) => g.state === 'done');
  out.push({
    key: 'github',
    label: 'GitHub accepts the merge',
    actor: 'auto',
    state: allKnownDone ? 'active' : 'pending',
    detail: allKnownDone ? { note: 'merging shortly' } : null,
  });
  return out;
}

/**
 * Does a stored recording still describe THIS proposal?
 *
 * A run is a statement about one (reviewed head, approval epoch) pair: the
 * approvals it counted are the epoch's, and the commit it measured, checked
 * and offered GitHub is the head's. checkAndMerge stamps both into the
 * record's context. When either has moved since, every line of the record is
 * about a proposal that no longer exists — "enough approvals" after the
 * epoch was bumped, "merging now" after the claim was released because the
 * head moved (#2100, #2095) — and the honest answer is the provisional one,
 * read off the live columns.
 *
 * A record with no stamps predates this rule and is trusted as before.
 */
function recordIsSuperseded(record, session) {
  const ctx = (record && record.context) || {};
  const s = session || {};
  if (ctx.approvalEpoch != null) {
    const then = intOrNull(ctx.approvalEpoch);
    const now = intOrNull(s.approval_epoch) ?? 0;
    if (then != null && then !== now) return true;
  }
  if (typeof ctx.headSha === 'string' && ctx.headSha) {
    const current = reviewedHeadForSession(s);
    if (current && current.toLowerCase() !== ctx.headSha.toLowerCase()) return true;
  }
  return false;
}

/** The nested block the serializer hangs on a proposal row, beside `integration`. */
function readRequirements(session) {
  const s = session || {};
  const raw = s.merge_requirements;
  const record = raw && typeof raw === 'object' ? raw : null;
  if (!record || recordIsSuperseded(record, s)) {
    // No recording yet, or one about a head or epoch this proposal has since
    // left behind. Say what the columns support rather than nothing — and say
    // that it IS provisional, so a surface can tone it accordingly.
    return {
      measuredAt: null,
      gates: provisional(s),
      evaluated: false,
      provisional: true,
      ...(record ? { superseded: true } : {}),
    };
  }
  return {
    measuredAt: s.merge_requirements_at ? new Date(s.merge_requirements_at).toISOString() : null,
    gates: describe(record),
    evaluated: true,
    provisional: false,
  };
}

/**
 * Store what a run did. Best-effort by construction: this is a DESCRIPTION,
 * and a proposal must never fail to merge because its description could not
 * be written down.
 */
async function store(pool, sessionId, t) {
  if (!pool || !sessionId || !t) return null;
  const record = typeof t.toRecord === 'function' ? t.toRecord() : t;
  if (!record || !Array.isArray(record.evaluated) || !record.evaluated.length) return null;
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET merge_requirements = $2::jsonb, merge_requirements_at = NOW()
        WHERE id = $1`,
      [sessionId, JSON.stringify(record)]
    );
  } catch {
    return null;
  }
  return record;
}

module.exports = {
  GATES,
  ACTOR_WORD,
  trace,
  describe,
  integrationStep,
  provisional,
  summarize,
  readRequirements,
  recordIsSuperseded,
  store,
};
