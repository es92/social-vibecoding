// merge-status.js — single source of truth for a proposal's merge
// lifecycle state (#405). A proposal (dev session) moves through several
// distinct stages — draft, in vote, checks running, behind main, resolving
// conflicts, queued/ready, merging, merged — and before this module each
// surface (the proposal feed card, the home "Your proposals" strip, the dev
// session view) derived and labelled those states with its own ad-hoc code,
// so the same proposal could read differently depending on where you looked.
//
// `MergeStatus.lifecycle(p, opts)` maps the raw fields the API already
// returns (status, check_state, merge_conflict_state, behind_main, and —
// when available — the vote tally) onto ONE canonical state, with a fixed
// precedence so the highest-signal stage always wins. `badgeHtml` / `pillHtml`
// render that state consistently everywhere.
//
// Loaded as a plain <script> before dev-chat.js / app-view.js / home.js
// (window.MergeStatus); also exported via module.exports so the derivation
// can be unit-tested under Node.
(function (root) {
  'use strict';

  // The words come from the language catalog (session.json), read when a
  // state is derived, never when this file is evaluated: the runtime that
  // defines PlatformI18n loads after it.
  function t(id, values) { return PlatformI18n.t(id, values); }

  function localReset(text) {
    var RT = typeof window !== 'undefined' && window.ResetTime;
    return RT ? RT.localizeResetText(text) : text;
  }

  function num(v) {
    var n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }

  // #1442 — the freshness measurement, read out of whichever shape the
  // caller's row carries: the flat columns /promoted sends, or the nested
  // camelCase block the API clients get. Kept local rather than borrowing
  // AppView._freshnessOf because this module loads BEFORE app-view.js and is
  // unit-tested on its own under Node.
  function freshOf(p) {
    var f = (p && p.freshness && typeof p.freshness === 'object') ? p.freshness : {};
    var mergeability = (p && p.mergeability) || f.mergeability || null;
    // The measured count beats the column frozen at submission. That column
    // reading 0 while a proposal was eight commits behind is the failure
    // #1442 reported.
    var behind = null;
    var cands = [p && p.freshness_behind_by, f.behindBy, p && p.behind_main];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (v === null || v === undefined || v === '') continue;
      var n = parseInt(v, 10);
      if (Number.isFinite(n)) { behind = n; break; }
    }
    return {
      mergeability: mergeability,
      behind: behind || 0,
      files: Array.isArray(f.mergeabilityFiles) ? f.mergeabilityFiles
        : (Array.isArray(p && p.mergeability_files) ? p.mergeability_files : []),
    };
  }

  // #2038 — the server's own answer, when it has one.
  //
  // Everything below this point is a PRECEDENCE TABLE: thirteen states the
  // browser derives by guessing which of six cached columns matters most.
  // The merge gate has always known exactly which rung refused a merge and
  // then thrown that away, so the guess was the only thing anybody saw — and
  // it guessed wrong in both directions (a stale 'conflict' snapshot with no
  // re-measuring writer outranked every checks and vote state indefinitely;
  // a proposal blocked on checks read "In vote").
  //
  // `integration.blockReason` is that answer. The table below stays as the
  // fallback for rows that carry no record: merged rows, drafts, and anything
  // written before this shipped.
  function integrationOf(p) {
    var i = (p && p.integration && typeof p.integration === 'object') ? p.integration : null;
    return i;
  }

  // The app's main-health step off the row's requirements ledger
  // (services/merge-requirements.js mainStep): non-null only while the
  // app's merges are paused by a red main. App state riding on every row,
  // so a card that passed its vote and its checks can say WHY it is not
  // merging instead of promising "shortly" — which is what the row read for
  // an afternoon while main was paused (#2247's neighbour).
  function mainPauseOf(p) {
    var mr = (p && p.mergeRequirements && typeof p.mergeRequirements === 'object') ? p.mergeRequirements : null;
    var gates = mr && Array.isArray(mr.gates) ? mr.gates : [];
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      if (!g || g.key !== 'main_healthy') continue;
      // Blocked, or 'active' while a first red is re-run to confirm: the
      // pause holds either way (merge-requirements.js mainStep).
      if ((g.state === 'blocked' || g.state === 'active') && g.detail && g.detail.paused) return g.detail;
      return null;
    }
    return null;
  }

  // A checks error the merge gate still counts as in progress: the run
  // overlapped a platform update and goes again on its own. Nothing records
  // that any more (#3828); rows stored before still read this way. Every
  // other error blocks on the author.
  function checksWillRetry(p) {
    if (!p || p.check_state !== 'error') return false;
    var mr = (p.mergeRequirements && typeof p.mergeRequirements === 'object') ? p.mergeRequirements : null;
    var gates = mr && Array.isArray(mr.gates) ? mr.gates : [];
    for (var i = 0; i < gates.length; i++) {
      if (gates[i] && gates[i].key === 'checks') return gates[i].state === 'active';
    }
    return false;
  }

  // "measured 30 seconds ago" — the honest half of a cached number. A card
  // that states a figure without its age is making a claim about the present
  // that it cannot support, which is what every "the UI is out of sync"
  // report was actually about.
  function ageOf(iso) {
    if (!iso) return null;
    var at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    var secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 45) return t('session:merge.measured.justNow');
    if (secs < 90) return t('session:merge.measured.minuteAgo');
    if (secs < 3600) return t('session:merge.measured.minutesAgo', { count: Math.round(secs / 60) });
    if (secs < 7200) return t('session:merge.measured.hourAgo');
    return t('session:merge.measured.hoursAgo', { count: Math.round(secs / 3600) });
  }

  // A tooltip's sentence followed by how old its measurement is.
  function withAge(title, age) {
    return age ? t('session:merge.measured.joined', { statement: title, measured: age }) : title;
  }

  // #3232 — how long the checks run in flight has been going, in whole
  // minutes, for the pill's own words ("12 min"). checks_checked_at is stamped when a run starts
  // (the proposal page reads it as "Started 12 minutes ago"), so a pending
  // row's stamp is the run's start. Under a minute, missing, unparseable or
  // in the future (clock skew) says nothing: zero is not worth a word.
  function runningForOf(p) {
    var startedAt = p && p.checks_checked_at ? Date.parse(p.checks_checked_at) : NaN;
    if (!Number.isFinite(startedAt)) return 0;
    var mins = Math.floor((Date.now() - startedAt) / 60000);
    return mins >= 1 ? mins : 0;
  }

  // #788 / the member floor: why a flagged proposal needs a Yes from a member
  // other than its author, in the words every surface uses. The server's copy
  // is src/services/explicit-approval.js; this file loads before app-view.js
  // in the browser and cannot require it, so the phrases are repeated here
  // and tests/explicit-approval-vote-panel.test.js holds the two together.
  var EXPLICIT_PHRASES = {
    admins: 'who runs this app',
    governance: 'how changes are approved',
    visibility: 'who can see this app',
    platform_env: 'this app\u2019s platform settings',
    secrets: 'this app\u2019s keys',
  };

  // The whole sentence and the whole line for each reason, as message ids:
  // a translator gets each one entire, never a phrase to fit into a frame.
  // `phrase` stays the English the server also holds; nothing on screen is
  // built from it (tests/explicit-approval-vote-panel.test.js holds the two
  // tables equal).
  var EXPLICIT_SENTENCES = {
    admins: 'session:explicitApproval.sentence.admins',
    governance: 'session:explicitApproval.sentence.governance',
    visibility: 'session:explicitApproval.sentence.visibility',
    platform_env: 'session:explicitApproval.sentence.platformEnv',
    secrets: 'session:explicitApproval.sentence.secrets',
  };
  var EXPLICIT_LINES = {
    admins: 'session:explicitApproval.line.admins',
    governance: 'session:explicitApproval.line.governance',
    visibility: 'session:explicitApproval.line.visibility',
    platform_env: 'session:explicitApproval.line.platformEnv',
    secrets: 'session:explicitApproval.line.secrets',
  };

  // { phrase, sentence, line } for a reason; an unknown or missing reason
  // still reads as a sentence.
  function explicitApprovalCopy(reason) {
    var known = Object.prototype.hasOwnProperty.call(EXPLICIT_PHRASES, reason);
    return {
      // Which protected setting, for a caller that picks a whole message by it.
      reason: known ? reason : null,
      phrase: known ? EXPLICIT_PHRASES[reason] : null,
      sentence: t(known ? EXPLICIT_SENTENCES[reason] : 'session:explicitApproval.sentence.other'),
      line: t(known ? EXPLICIT_LINES[reason] : 'session:explicitApproval.line.other'),
    };
  }

  // Whether a flagged row is still waiting on the member floor: its
  // community has more than one member and nobody but the author has said
  // Yes. Only a row the server described says so (needs_other_member_yes).
  function awaitingOtherMember(p) {
    if (!p || !p.requires_explicit_approval || !p.needs_other_member_yes) return false;
    return num(p.other_member_yes_count) < 1;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Build a lifecycle descriptor. `tone` ∈ {neutral, violet, amber, green, red}
  // maps to the .ms-badge-* / .ms-pill-* colour classes in app.css. `spinner`
  // requests the rotating arc glyph for in-flight stages. `extra` carries
  // optional `glyph`, `title` (tooltip) and `votes` ({yes, majority, reached}).
  function descriptor(key, label, tone, spinner, extra) {
    var d = { key: key, label: label, tone: tone, spinner: !!spinner };
    if (extra) {
      if (extra.glyph) d.glyph = extra.glyph;
      if (extra.title) d.title = extra.title;
      if (extra.votes) d.votes = extra.votes;
      // #788: not a state of its own — a modifier on the state, so
      // callers can render the "Explicit approval" chip alongside.
      if (extra.explicitApproval) d.explicitApproval = true;
    }
    return d;
  }

  // Canonical lifecycle derivation. Precedence is highest-signal-first: an
  // active merge/conflict outranks a checks verdict, which outranks the
  // vote/eligibility states. States 8–10 ("Awaiting admin", "Passed —
  // merging shortly", "In vote") need the vote tally; 1–7 + 11 need only the
  // columns every session payload carries. `opts.majority` / `opts.locked`
  // override per-row values (the feed passes the app-level majority + lock).
  function lifecycle(p, opts) {
    p = p || {};
    opts = opts || {};

    var status = p.status;
    var mcs = p.merge_conflict_state;
    var fresh = freshOf(p);
    var behind = fresh.behind;
    var check = p.check_state;

    // #695: the per-row votes_required — the governed gate's
    // electorate-based requirement on live rows, the merge-time snapshot
    // (#58) on merged rows — beats any app-level majority, matching
    // voteCountPill's precedence. On invited-approver apps the app-level
    // majority counts the wrong electorate entirely, so it's the last
    // resort. An "at least N" target comes next (#646); equal to
    // votes_required whenever both are serialized.
    var snap = parseInt(p.votes_required, 10);
    var majority = (Number.isFinite(snap) && snap > 0) ? snap
      : num(
        p.approvals_required != null ? p.approvals_required
          : opts.majority != null ? opts.majority
            : p.majority
      ) || 1;
    var hasVotes = p.yes_count !== null && p.yes_count !== undefined;
    var yes = num(p.qualified_yes_count != null ? p.qualified_yes_count : p.yes_count);
    var reached = hasVotes && yes >= majority;
    var locked = opts.locked != null ? opts.locked : p.locked;
    var votes = hasVotes ? { yes: yes, majority: majority, reached: reached } : null;
    // #695: on invited-approver apps the non-approver surplus is advisory —
    // shown beside the tally, never inside it.
    if (votes && p.approval_policy === 'invited' && p.qualified_yes_count != null) {
      votes.advisory = Math.max(0, num(p.yes_count) - num(p.qualified_yes_count));
    }

    var integ = integrationOf(p);

    // 0 — #2038: the two states only the SERVER can report.
    //
    // The board card derives every other reason itself, as a TAG, from the
    // columns it already reads (AppView.blockReasons). This function feeds a
    // different surface — the dev-chat header pill and the home strip, which
    // have one slot and no tag line — so here the two server-known states do
    // take the slot, because on those surfaces there is nowhere else for them
    // to go. Both are in-flight or waiting: neither asks the reader to act.
    var served = (integ && Array.isArray(integ.blockReasons)) ? integ.blockReasons : [];
    // GitHub held this change's merge back: it was still finishing an earlier
    // merge, or refused it for a reason nobody has to act on. The queue tries
    // it again on its own, and the tooltip says when. Amber, no spinner:
    // waiting, not working, and the reader has nothing to do.
    var held = served.indexOf('github_busy') !== -1 ? 'github_busy'
      : served.indexOf('github_refused') !== -1 ? 'github_refused'
        // #6546: its required GitHub checks are still running, or are being
        // run again on today's main.
        : served.indexOf('github_checks') !== -1 ? 'github_checks' : null;
    if (status === 'promoted' && held) {
      var until = integ && integ.heldUntil ? Date.parse(integ.heldUntil) : NaN;
      var soon = !Number.isFinite(until) || until <= Date.now();
      var time = soon ? null : new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var title = held === 'github_busy'
        ? t(soon ? 'session:merge.title.githubBusySoon' : 'session:merge.title.githubBusy', { time: time })
        : held === 'github_checks'
          ? t(soon ? 'session:merge.title.githubChecksSoon' : 'session:merge.title.githubChecks', { time: time })
          : t(soon ? 'session:merge.title.githubRefusedSoon' : 'session:merge.title.githubRefused', { time: time });
      return descriptor('merge_held', t('session:merge.status.waitingOnGithub'), 'amber', false, {
        votes: votes, title: title,
      });
    }
    if (status === 'promoted' && served.indexOf('integrating') !== -1) {
      return descriptor('integrating', t('session:merge.status.integrating'), 'amber', true, {
        votes: votes,
        // Only a CONFLICT is ever brought up to date now: a head that merges
        // cleanly merges as it stands, however far behind. So this is the
        // conflict lane at work, and the sentence says what that lane does.
        title: withAge(t('session:merge.title.integrating'), ageOf(integ.measuredAt)),
      });
    }
    if (status === 'promoted' && served.indexOf('budget') !== -1) {
      return descriptor('integrating', t('session:merge.status.waitingOnBudget'), 'amber', false, {
        votes: votes,
        // #3230: the reset in the viewer's own clock where ResetTime is loaded.
        title: localReset(t('session:merge.title.waitingOnBudget')),
      });
    }

    // 1a — merged, its deploy still to come: live_at is null until production
    // runs it (the merge-followups workflow machine). A row without the
    // field (undefined) reads as it always did.
    if (status === 'merged' && p.live_at === null) {
      return descriptor('going_live', t('session:merge.status.goingLive'), 'amber', true, {
        votes: votes,
        title: t('session:merge.title.goingLive'),
      });
    }
    // 1 — terminal: merged.
    if (status === 'merged') {
      return descriptor('merged', t('session:merge.status.merged'), 'violet', false, { glyph: '✓', votes: votes });
    }
    // 2 — actively merging (GitHub merge + prod rebuild in flight).
    if (status === 'merging') {
      return descriptor('merging', t('session:merge.status.merging'), 'amber', true, {
        votes: votes,
        title: t('session:merge.title.merging'),
      });
    }
    // 3 — auto-resolver reconciling conflicts (persisted snapshot, or the
    // feed's process-local `resolving` flag) then retrying the merge.
    if (mcs === 'resolving' || p.resolving === true) {
      return descriptor('resolving', t('session:merge.status.resolving'), 'amber', true, {
        votes: votes,
        title: t('session:merge.title.resolving'),
      });
    }
    // 4 — auto-resolve gave up; a human must sync/resolve.
    if (mcs === 'failed') {
      return descriptor('conflict_failed', t('session:merge.status.conflictFailed'), 'red', false, {
        glyph: '⚠', votes: votes,
        title: t('session:merge.title.conflictFailed'),
      });
    }
    // 4b — a real merge attempt hit a GitHub conflict ('conflict' is written
    // ONLY by the merge-time 405 path in routes/votes.js). The auto-resolver
    // may pick it up (state 3 takes over while it runs), but it only touches
    // vote-eligible proposals — so without this state a failed merge could
    // sit silently behind a reassuring "Behind main · syncing automatically"
    // badge forever. Red: the reliable way out is the proposal's creator
    // finishing the merge from their session.
    if (mcs === 'conflict') {
      return descriptor('merge_conflict', t('session:merge.status.mergeConflict'), 'red', false, {
        glyph: '⚠', votes: votes,
        title: t('session:merge.title.mergeConflict'),
      });
    }
    // 4c (#1442) — GitHub predicts the NEXT merge will conflict. States 4/4b
    // above are both records of an attempt that already happened, and a
    // proposal collecting votes has had no attempt yet: proposal 3590 sat
    // here for its whole life reading "In vote · checks passing" while it
    // conflicted with main in seven files. Ranked under the attempted states
    // (an attempt is a fact, this is a prediction) and over the checks
    // states, because green checks on a proposal that cannot merge are
    // exactly the reassurance the issue was about.
    if (fresh.mergeability === 'conflict' || (integ && integ.mergesClean === false)) {
      var nf = fresh.files.length || (integ && Array.isArray(integ.conflictPaths) ? integ.conflictPaths.length : 0);
      // Who resolves it is the conflict lane's call, and the lane records
      // its decision in the served reasons. Absent a record the default
      // holds: the platform resolves a conflict once the vote passes (and
      // once beforehand, unasked), so the creator is never the ONLY way out
      // unless the lane has said so.
      var conflictTitle = served.indexOf('unresolvable') !== -1
        ? t('session:merge.title.conflictUnresolvable')
        : served.indexOf('fork_head') !== -1
          ? t('session:merge.title.conflictForkHead')
          : served.indexOf('awaiting_approval') !== -1
            ? t('session:merge.title.conflictAwaitingApproval')
            : served.indexOf('checks_failing') !== -1
              ? t('session:merge.title.conflictChecksFailing')
              : served.indexOf('checks_error') !== -1
                ? t('session:merge.title.conflictChecksError')
                : t('session:merge.title.conflictAutomatic');
      return descriptor('mergeability_conflict',
        nf ? t('session:merge.status.conflictsWithMainFiles', { count: nf }) : t('session:merge.status.conflictsWithMain'), 'red', false, {
          glyph: '⚠', votes: votes,
          title: conflictTitle,
        });
    }
    // 5a — preview boot failure and checks-run infrastructure failure are
    // separate states (#2328). The former has an explicit derived preview
    // error; check_state='error' by itself only says the runner did not
    // produce a verdict and must not accuse the app of failing to boot.
    if (p.preview_state === 'failed' || p.staging_error) {
      return descriptor('preview_failed', t('session:merge.status.previewFailed'), 'red', false, {
        glyph: '⚠', votes: votes,
        title: p.staging_error
          ? t('session:merge.title.previewFailedReason', { reason: p.staging_error })
          : t('session:merge.title.previewFailed'),
      });
    }
    if (check === 'error' && checksWillRetry(p)) {
      // In flight and nobody need act: the same treatment as a running check.
      return descriptor('checks_running', t('session:merge.status.checksWillRetry'), 'neutral', true, {
        votes: votes,
        title: p.check_error_detail
          ? t('session:merge.title.checksWillRetryDetail', { detail: p.check_error_detail })
          : t('session:merge.title.checksWillRetry'),
      });
    }
    if (check === 'error') {
      return descriptor('checks_error', t('session:merge.status.checksError'), 'red', false, {
        glyph: '⚠', votes: votes,
        title: p.check_error_detail
          ? t('session:merge.title.checksErrorReason', { reason: p.check_error_detail })
          : t('session:merge.title.checksError'),
      });
    }
    // 5b — checks blocked the merge (a test broke).
    if (check === 'failing') {
      // BLOCKING failures only. Advisory rows are checks that have not yet
      // passed on a change that merged — they report but do not block,
      // so counting them here would tell a reviewer the merge is held up by
      // failures that are not holding it up. Rows written before advisory
      // existed carry no flag and count, which is the old behaviour.
      var n = Array.isArray(p.test_results)
        ? p.test_results.filter(function (r) { return r && r.status !== 'pass' && !r.advisory; }).length
        : 0;
      var label = n ? t('session:merge.status.checksFailingCount', { count: n }) : t('session:merge.status.checksFailing');
      return descriptor('checks_failing', label, 'amber', false, {
        glyph: '⚠', votes: votes,
        title: t('session:merge.title.checksFailing'),
      });
    }
    // 6 — checks still running (not yet a verdict). Grey, not amber: it's
    // "not started" rather than "broken".
    if (check === 'pending' && p.check_phase === 'deferred') {
      // The preview was built for reviewers; the tests were not run, because
      // the head conflicts with main and a verdict on a tree that cannot
      // merge is not worth the minutes. They run once it merges cleanly.
      // Not a spinner: nothing is running, and nobody has to act on it.
      return descriptor('checks_deferred', t('session:merge.status.checksDeferred'), 'neutral', false, {
        votes: votes,
        title: t('session:merge.title.checksDeferred'),
      });
    }
    if (check === 'pending' && p.check_phase === 'queued') {
      // Built, and waiting its turn: the platform runs a few proposals'
      // checks at a time (services/checks-queue.js). In progress, nobody has
      // to act, so it keeps the running treatment, and says its place.
      var q = p.checks_progress && p.checks_progress.queue;
      var ahead = q && typeof q.ahead === 'number' && q.ahead >= 0 && Math.floor(q.ahead) === q.ahead ? q.ahead : null;
      return descriptor('checks_queued',
        ahead === null ? t('session:merge.status.checksQueued')
          : (ahead === 0 ? t('session:merge.status.checksQueuedNext') : t('session:merge.status.checksQueuedAhead', { count: ahead })),
        'neutral', true, {
          votes: votes,
          title: t('session:merge.title.checksQueued'),
        });
    }
    if (check === 'pending') {
      // A run that has been going a while says for how long, so "pending for
      // twenty minutes" reads as a number rather than as a hang (#3232).
      var runningFor = runningForOf(p);
      return descriptor('checks_running',
        runningFor ? t('session:merge.status.checksRunningFor', { count: runningFor }) : t('session:merge.status.checksRunning'), 'neutral', true, {
        votes: votes,
        title: t('session:merge.title.checksRunning'),
      });
    }
    // 6a (#607) — a promoted proposal with NO verdict recorded at all: the
    // first run hasn't stamped 'pending' yet (e.g. the promote-time staging
    // build is still going). Same in-progress treatment as 'pending'.
    // Rows carrying a console snapshot are genuine pre-#47 legacy and keep
    // falling through to the vote states.
    if (!check && status === 'promoted' && !p.console_check_state) {
      return descriptor('checks_running', t('session:merge.status.checksStarting'), 'neutral', true, {
        votes: votes,
        title: t('session:merge.title.checksStarting'),
      });
    }
    // 6b — checks explicitly skipped (#461): there was genuinely nothing to
    // test (branch level with main, or no GitHub wired up). Terminal and
    // NON-blocking — the gate treats it like 'passing' — so grey, no
    // spinner, with the recorded reason in the tooltip.
    if (check === 'skipped') {
      return descriptor('checks_skipped', t('session:merge.status.checksSkipped'), 'neutral', false, {
        votes: votes,
        title: p.check_error_detail
          ? t('session:merge.title.checksSkippedReason', { reason: p.check_error_detail })
          : t('session:merge.title.checksSkipped'),
      });
    }
    // 7 — behind main. ('conflict' no longer falls through here — it has its
    // own red state 4b above, since "syncing automatically" was a false
    // promise for proposals the gate-filtered auto-resolver never picks up.)
    if (behind > 0 || mcs === 'behind') {
      // Informational, not a promise of work. A head that merges cleanly is
      // never synced — not before the vote, not after it. It merges as it
      // stands, and GitHub's own merge is the last word on whether it still
      // can. (The conflicting case never reaches here: 4c above takes it.)
      var behindAge = integ ? ageOf(integ.measuredAt) : null;
      return descriptor('behind', behind ? t('session:merge.status.behindCount', { count: behind }) : t('session:merge.status.behind'), 'amber', false, {
        votes: votes,
        title: withAge(t('session:merge.title.behind'), behindAge),
      });
    }
    // 8 — locked app: majority reached but still needs an admin yes. (Only
    // fires where the caller supplies `locked`; the admin-yes is verified
    // server-side, so this is the "still needs admin" hint, not a guarantee.)
    if (status === 'promoted' && reached && locked) {
      return descriptor('awaiting_admin', t('session:merge.status.awaitingAdmin'), 'amber', false, {
        votes: votes,
        title: t('session:merge.title.awaitingAdmin'),
      });
    }
    // 8a — the member floor: the votes are in, but none of them is from a
    // member other than the author. "Merging shortly" would be untrue.
    if (status === 'promoted' && reached && awaitingOtherMember(p)) {
      return descriptor('awaiting_member', t('session:merge.status.awaitingMember'), 'amber', false, {
        votes: votes,
        title: explicitApprovalCopy(p.explicit_approval_reason).sentence,
        explicitApproval: true,
      });
    }
    // 8b — passed the vote, checks green, and the APP's merges are paused by
    // a red main (services/main-watch.js). Nothing about this proposal is
    // wrong, and "merging shortly" would be a promise nobody is keeping: the
    // row says so, and the tooltip names the test and the way out.
    var mainPause = mainPauseOf(p);
    if (status === 'promoted' && reached && check === 'passing' && mainPause) {
      return descriptor('main_paused', t('session:merge.status.mainPaused'), 'amber', false, {
        votes: votes,
        title: mainPause.note
          ? t('session:merge.title.mainPausedNote', { reason: mainPause.note })
          : t('session:merge.title.mainPaused'),
      });
    }
    // 9 — passed the vote, checks green, not behind: eligible and queued to
    // merge (one proposal per app merges at a time). The new explicit state.
    if (status === 'promoted' && reached && check === 'passing') {
      return descriptor('ready', t('session:merge.status.ready'), 'green', false, {
        votes: votes,
        title: t('session:merge.title.ready'),
      });
    }
    // 10 — proposed, still collecting votes. #788: a flagged proposal
    // keeps this ordinary state — its threshold is unchanged — but carries
    // an explanatory tooltip and the `explicitApproval` flag so callers can
    // render the lock.
    if (status === 'promoted') {
      // B10a: one word for a change that waits on the group, and the
      // creator's own words on a project that is just them, whose one Yes is
      // the Yes it needs.
      var solo = (opts.audience || p.app_audience) === 'solo' && majority <= 1;
      return descriptor('in_vote', solo ? t('session:merge.status.waitingForYourApproval') : t('session:merge.status.waitingForApproval'), 'violet', false, {
        votes: votes,
        title: p.requires_explicit_approval
          ? t('session:merge.title.explicitApprovalNoTimer', { requirement: explicitApprovalCopy(p.explicit_approval_reason).sentence })
          : undefined,
        explicitApproval: !!p.requires_explicit_approval,
      });
    }
    // 10b — an active draft whose pre-promotion checks finished cleanly.
    // Active sessions used to fall all the way through to the generic
    // "Draft" state here, hiding the successful checks run that made the
    // draft ready to propose. The merge-conflict / behind-main states above
    // retain precedence, and promoted rows already resolved through their
    // vote state.
    if (status === 'active' && check === 'passing') {
      return descriptor('checks_passed', t('session:merge.status.checksPassed'), 'green', false, {
        glyph: '✓',
        title: t('session:merge.title.checksPassed'),
      });
    }
    // 11 — building; not yet proposed.
    if (status === 'active') {
      return descriptor('draft', t('session:merge.status.draft'), 'neutral', false, {});
    }
    // Unknown / non-merge lifecycle (paused, archived, …): no badge.
    return descriptor('none', '', 'neutral', false, {});
  }

  function spinnerHtml() {
    return '<span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>';
  }

  function inner(life, includeVotes) {
    var label = life.label;
    var advisory = '';
    if (includeVotes && life.key === 'in_vote' && life.votes) {
      label = t('session:merge.pill.statusWithTally', { status: life.label, yes: life.votes.yes, required: life.votes.majority });
      // #695: muted "+N" for advisory (non-approver) votes on
      // invited-approver apps — recorded, but not in the headline tally.
      if (life.votes.advisory > 0) {
        advisory = ' <span class="ms-advisory" title="'
          + PlatformI18n.htmlText('session:merge.pill.advisoryVotes', { count: life.votes.advisory })
          + '">+'
          + life.votes.advisory + '</span>';
      }
    }
    return (life.spinner ? spinnerHtml() : '')
      + (life.glyph ? esc(life.glyph) + ' ' : '')
      + esc(label) + advisory;
  }

  // Text-style badge (colour only) — for the proposal feed card's state slot
  // and the home strip, where a separate vote pill already shows the tally.
  function badgeHtml(life) {
    if (!life || !life.label) return '';
    var title = life.title ? ' title="' + esc(life.title) + '"' : '';
    return '<span class="ms-badge ms-badge-' + (life.tone || 'neutral') + '"' + title + '>'
      + inner(life, false) + '</span>';
  }

  // Filled pill — for the dev session header, which has no vote pill of its
  // own, so the in-vote tally rides along in the label.
  function pillHtml(life) {
    if (!life || !life.label) return '';
    var title = life.title ? ' title="' + esc(life.title) + '"' : '';
    return '<span class="ms-pill ms-pill-' + (life.tone || 'neutral') + '"' + title + '>'
      + inner(life, true) + '</span>';
  }

  // STATE_BADGE_KEYS used to live here — "keys whose canonical badge belongs
  // in the feed card's state slot". No renderer ever read it; only two test
  // files did. #2026 moved that decision into AppView.statusTagSpecs anyway,
  // so it is deleted rather than kept in step with a card it does not drive.
  var MergeStatus = {
    lifecycle: lifecycle,
    badgeHtml: badgeHtml,
    pillHtml: pillHtml,
    explicitApprovalCopy: explicitApprovalCopy,
    awaitingOtherMember: awaitingOtherMember,
    checksWillRetry: checksWillRetry,
    // Keys whose canonical badge belongs in the feed card's "state" slot.
    // In-vote / draft are conveyed by the vote pill; checks states keep their
    // own detailed badge (with per-test counts), so they're excluded here.
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MergeStatus;
  if (typeof window !== 'undefined') window.MergeStatus = MergeStatus;
  if (root && typeof root === 'object') root.MergeStatus = MergeStatus;
})(typeof globalThis !== 'undefined' ? globalThis : this);
