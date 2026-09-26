'use strict';

// One dev-chat turn (#2779): the stream to the browser, the Mayor's phase-1
// call and data-tool loop, the one dispatch (scout or build) and its phase-2
// wrap-up, with every row, pill, receipt and stop path along the way.
//
// Moved out of POST /api/sessions/:id/chat (routes/sessions.js) so the same
// loop can serve an agent session that is not one change (see
// docs/agent-sessions.md). This first step is a pure move: the route still
// does its checks, stores the user's message and opens the SSE response, then
// hands the turn here. tests/mayor-turn-golden.test.js pins the behaviour.
//
// `deps` carries the routes/sessions.js helpers the turn calls (the scout
// and build tools, recovery scheduling, spec and discussion loaders);
// requiring them from here would be a cycle.

const attachmentsSvc = require('../attachments');
const debugAccess = require('../debug-access');
const events = require('../events');
const github = require('../github');
const issueDraft = require('../issue-draft');
const limits = require('../limits');
const llm = require('../llm');
const log = require('../logger');
const modelFallback = require('../model-fallback');
const openRouterMayor = require('../openrouter-mayor');
const prMetadata = require('../pr-metadata');
const sessionBus = require('../session-bus');
const sessionTitles = require('../session-title');
const stopRegistry = require('../stop-registry');
const turnEffects = require('../turn-effects');
const userAgentFiles = require('../user-agent-files');
const worker = require('../worker');
const workerProgress = require('../worker-progress');
const {
  activeWorkers,
  beginSessionOperation,
  isSessionBusy,
} = require('../active-workers');
const {
  fallbackKindForTurn,
  turnFallbackQuickReplies,
} = require('../recovery-pills');
const {
  DATA_TOOL_THINKING_STATUS,
  DRAFT_TOOL_NAME,
  IN_PROCESS_TOOL_NAMES,
  MAYOR_DATA_TOOLS_MAX_ITERS,
  dataToolStatusLine,
  resolveDataToolResult,
} = require('./data-tools');
const {
  buildMayorMessages,
  stripFakeCompletionMarker,
} = require('./messages');
const {
  quickReplyMeta,
  resolveTurnPills,
} = require('./pills');
const {
  getMayorSystemPrompt,
} = require('./prompt');
const {
  DATA_SUMMARY_FALLBACK_TEXT,
  buildDataSummaryReprompt,
  needsEmptyReplyFallback,
  salvageAssistantText,
  shouldRepromptForDataSummary,
} = require('./replies');
const {
  DISPATCH_SCOUT_TOOL,
  DISPATCH_TOOL,
  DRAFT_ISSUE_REPORT_TOOL,
  GET_GITHUB_ISSUE_TOOL,
  GET_PROD_STATUS_TOOL,
  LIST_GITHUB_ISSUES_TOOL,
  SUGGEST_ANSWERS_TOOL,
  SUGGEST_REPLIES_TOOL,
  WEB_FETCH_TOOL,
  resolveQuickReplies,
  resolveSuggestedAnswers,
} = require('./tools');

// #3181: did this turn stop before finishing? Only when it persisted a
// failure row, and never when a person pressed stop: a stop is a deliberate
// end whatever failed on the way ('agent_error' is the stop flag a
// configuration refusal borrows in runClaudeCodeTool, not a person). Nor when
// the platform is recovering the turn, since that recovery reports its own
// ending.
function turnStalled({ failed, recovering, stopHandle }) {
  if (!failed || recovering) return false;
  const stoppedByPerson = !!(stopHandle && stopHandle.stopped
    && stopHandle.stoppedBy !== 'agent_error');
  return !stoppedByPerson;
}

async function runMayorTurn(ctx, deps) {
  const {
    session,
    isOpenRouterSession,
    res,
    pool,
    config,
    req,
    messageText,
    selectedModel,
    turnAttachments,
    scheduleInteractiveRecovery,
    // #3177: the stored user message this turn answers, and the id its
    // client sent with it (null when none was sent).
    userMessageId = null,
    clientMessageId = null,
  } = ctx;
  // Reassigned when a later model call needs a fresh payer (#664).
  let { userApiKey } = ctx;
  const {
    TURN_WRAPUP_EFFECT_KEYS,
    buildOpenProposalsBlock,
    buildSessionDiscussionBlock,
    codingAgentRuntimeIdentity,
    describeTurnError,
    invocationTelemetry,
    loadSessionSpec,
    notifySessionDone,
    notifySessionStalled,
    runClaudeCodeTool,
    runScoutTool,
    safeAgentModelLabel,
    scheduleRetainedInteractiveTurn,
    sharedPoolCodexSpend,
    snapshotMayorResponse,
    staticWrapUpText,
  } = deps;

  const { broadcastGlobal } = require('../ws');
  const seqPrefix = Date.now().toString(36);
  let eventSeq = 0;
  // #3181: how this turn is ending, read by the done hook in send() below.
  // `failed` is set by any failure row the turn persists (sendStatus with
  // turnError: an agent run that errored, timed out or lost its worker, the
  // catch-all turn error); `recovering` by that catch-all when the platform
  // has taken the turn over and will report its own ending.
  const turnEnd = { failed: false, recovering: false };
  // Event types that are ONLY meaningful on the active SSE stream. They
  // must not also be broadcast on the global WebSocket because both
  // channels share a _seq-based dedup on the client: if such an event
  // arrived first on the WS (which has NO handler for it) it would be
  // silently swallowed, and the matching SSE delivery would then be
  // deduped-skipped — the mayor's response would be written to the DB
  // but never appear in the live UI until the user refreshes.
  //
  // 'token' stays SSE-only: it is high-frequency streaming and is fully
  // recovered by the single full-text 'mayor_reasoning' event, so
  // broadcasting every token on the WS buys nothing.
  //
  // 'mayor_reasoning' is NO LONGER SSE-only (#394). It is the authoritative
  // full-text wrap-up the Mayor posts after a scout/spec or build turn, and
  // it must survive a dropped POST SSE: a long scout run often kills the
  // POST stream before phase-2, leaving the summary only on the session bus
  // — and the global-WS 'done' (which IS broadcast) races ahead and tears
  // down streaming before the resumable EventSource can replay it, so the
  // summary lands in the DB but never live. Broadcasting it on the WS is
  // safe now because (a) App.handleSessionEvent has a dedicated
  // 'mayor_reasoning' case (no "swallowed then deduped" problem) and (b) it
  // carries the COMPLETE text and is applied idempotently / last-write-wins,
  // so overlap with the SSE/bus copy reconciles to the same result.
  //
  // 'suggestions'/'quick_replies' are NO LONGER SSE-only either: they ride
  // right behind mayor_reasoning (the phase-2 quick_replies carry the
  // "Build it" pill) and were hit by the exact same dropped-POST-SSE race —
  // persisted in the assistant row's metadata but only visible after a
  // refresh. Same safety argument as mayor_reasoning: App.handleSessionEvent
  // has dedicated cases for both, and each event carries the COMPLETE
  // chip/pill list, applied last-write-wins.
  //
  // 'accepted' (#3177) is SSE-only too: it answers the request that sent the
  // message, and the global WS has no handler for it, so a WS copy would be
  // swallowed and the SSE copy then deduped away. It still goes to the
  // session bus below, which is what makes `/events?since=<its _seq>` replay
  // the turn from its start.
  const SSE_ONLY = new Set(['token', 'usage', 'error', 'accepted']);
  const send = (type, data) => {
    const seq = `${seqPrefix}-${++eventSeq}`;
    const event = { type, _seq: seq, ...data };
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    if (!SSE_ONLY.has(type)) {
      // Spread the event FIRST, then pin the envelope fields — otherwise
      // `...event` (which carries the inner `type`, e.g. 'mayor_reasoning')
      // clobbers `type: 'session_event'`, and the client's
      // `switch (data.type)` never routes to handleSessionEvent. The
      // envelope must keep `type: 'session_event'` while `event` carries
      // the real event name and `_seq` + the data fields ride along.
      broadcastGlobal({ ...event, sessionId: session.id, event: type, type: 'session_event' });
    }
    // Also publish to the per-session event bus so a client whose POST
    // SSE connection drops can reconnect via GET /events and replay any
    // events it missed (EventSource auto-reconnect + Last-Event-Id).
    // Token/usage/error/mayor_reasoning are intentionally included here
    // — unlike the global WS they're scoped to this session only, so
    // there's no cross-session leakage and the client's existing seq
    // dedup handles any overlap with the primary stream.
    sessionBus.publish(session.id, event);
    // #161: every turn-completion path funnels through send('done')
    // — the main exit, the early returns, and the catch fallthrough —
    // so this is the one hook needed for the left-mid-turn completion
    // notification. Fire-and-forget; the helper swallows its errors.
    // #3181: a turn that ended on a failure says so ("stopped before
    // finishing") instead of "finished". The stop handle is read at call
    // time: a 'done' is only ever sent after it is registered below.
    if (type === 'done') {
      const notify = turnStalled({ ...turnEnd, stopHandle })
        ? notifySessionStalled
        : notifySessionDone;
      notify(pool, session.id);
    }
  };

  // Locals used across multiple branches of the CC flow. Previously these
  // were implicit globals which leaked across concurrent requests.
  let ccLog = null;
  let stagingUrl = null;
  let releaseDispatchOperation = null;

  // Register a stop handle for this turn so POST /stop can cancel the
  // in-flight Mayor stream and/or running Claude Code worker. We reuse
  // a single AbortController across both Mayor phases (phase-2 ignores
  // it anyway, see below). Any prior handle for this session is torn
  // down defensively — in theory the previous turn's finally already
  // cleared it, but an unclean shutdown could leave a stale entry.
  const stopHandle = {
    abort: new AbortController(),
    // Diagnostic only with long-lived workers — the warm container
    // is preserved across stop. During the CC phase the stop signal
    // is worker.stopTurn() (in-container pkill of run-cc.sh +
    // claude); the detached exec has no host-side child to SIGTERM.
    workerName: null,
    phase: 'mayor1',
    stopped: false,
    stoppedBy: null,
    // #937: epoch ms of the FIRST stop request for this turn (GET
    // /status serves it so a reloading client rebuilds its escalation
    // ladder), and whether a confirm-the-kill loop is already running
    // for it — repeat stops must not multiply the kill budget.
    stopRequestedAt: null,
    confirming: false,
    // #889: POST /stop lives in another request and has no access to
    // this turn's `send` closure, but it needs to announce the stop on
    // every channel the moment the click lands (rather than ~20s later
    // when the turn actually unwinds). Handing it the closure keeps the
    // _seq numbering consistent with the rest of the turn's events.
    send,
    // #3177: which stored message this turn answers, so a delivery lookup
    // (GET /status?client_message_id=) can say its turn is the one running.
    userMessageId,
  };
  const prior = stopRegistry.get(session.id);
  if (prior && prior !== stopHandle) {
    try { prior.abort.abort(); } catch {}
  }
  stopRegistry.set(session.id, stopHandle);
  // #937: this is the ONE true new-turn boundary, so it owns clearing
  // the worker registry's pending-stop record. The record deliberately
  // outlives the turn it stopped (execInWorker no longer resets it —
  // that reset was what let a stop clicked during spin-up be erased by
  // the very dispatch it was meant to prevent), so something has to
  // retire it, and "the user sent a new message" is the only moment
  // that unambiguously means the previous stop is spent.
  worker.clearPendingStop(session.id);

  // #3177: the turn's first event, and its first bytes on the wire. The
  // message is stored by now, so a client that reads this knows it was
  // delivered even if the stream breaks a moment later, and resumes from this
  // event's _seq through GET /api/sessions/:id/events?since=.
  send('accepted', { messageId: userMessageId, clientMessageId });

  const setPhase = (phase) => {
    stopHandle.phase = phase;
    send('phase', { phase });
  };

  // Each status event is its own immutable system message. Declared
  // OUTSIDE the try below so the catch can persist a turn-failure
  // status — a live 'error' SSE event dies with the stream, and
  // without a persisted row a mid-turn provider error looks like a
  // silent turn after refresh.
  const sendStatus = async (text, metadata) => {
    // #3181: the scout and build tools report their failures through this
    // same function, so it is the one place that sees every one of them.
    if (metadata && metadata.turnError) turnEnd.failed = true;
    send('status', { text, ...(metadata || {}) });
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
      [session.id, text, JSON.stringify(metadata || {})]
    ).catch(() => {});
  };

  // #894: guaranteed quick-reply pills. The Mayor's suggest_replies
  // tool is optional and it frequently skips it, and several turn-end
  // paths (worker-busy, stop-during-run, refusal, provider error) never
  // reach a model wrap-up at all — either way the pill bar goes empty
  // and stays empty until the user types something themselves. Every
  // such path now falls back to a deterministic, state-derived set.
  //
  // Declared out here (not beside currentSpec inside the try) so the
  // catch-block's turn-error status can use it too. `hasSpec` is
  // refreshed whenever the spec is (re)loaded; `session.pr_number` is
  // mutated in place by applyPrMetadata, so reading it at CALL time is
  // what makes a just-opened PR count.
  let turnHasSpec = false;
  const turnPills = (outcome) => turnFallbackQuickReplies({
    outcome,
    hasPr: session.pr_number != null,
    hasSpec: turnHasSpec,
  });

  // #1001: the pill-resolution ladder for this turn. Every pill-bearing
  // persist below routes through this so the Mayor authors its own set
  // (rung 1 or 2) rather than the fixed list filling the row.
  //
  // `history` is loaded further down (it's the same rows the Mayor
  // itself sees), so the tail reads it lazily at CALL time.
  let turnHistory = [];
  const turnState = (outcome) => [
    session.pr_number != null ? `PR #${session.pr_number} is open for this session` : 'no PR opened yet',
    turnHasSpec ? 'a spec doc exists in the spec viewer' : 'no spec doc yet',
    `this turn ended as: ${outcome}`,
  ].join('; ');
  const resolvePills = (outcome, opts = {}) => resolveTurnPills({
    pool,
    dataKey: config.dataEncryptionKey,
    session,
    userId: req.user.id,
    apiKey: userApiKey,
    outcome,
    hasPr: session.pr_number != null,
    hasSpec: turnHasSpec,
    transcriptTail: turnHistory,
    state: turnState(outcome),
    ...opts,
  });

  // #249: a brand-new session gets a readable display name from its
  // opening ask. The call is scheduled at turn end (below), after the
  // main turn has settled, so its fresh billing check sees the real
  // remaining allowance instead of racing the main model call.
  const titledThisTurn = !isOpenRouterSession && !session.session_title && !session.pr_number;
  // Pre-PR turn-end refresh re-titles from the full request history +
  // latest spec draft. Once a PR exists applyPrMetadata owns the name.
  // Both title modes are fire-and-forget, but only after a fresh payer
  // decision made after the main turn's spend has been recorded.
  //
  // #2500: OpenRouter sessions come here too. They are still named
  // without a model call the moment their first ask lands (#1949, at
  // the top of their branch below) so a refused turn still leaves a
  // readable name, but that is now a FIRST name: the helper model gets
  // the last word on every in-platform session, because a name that
  // says what the change does is the whole point. Their opening trim
  // already set session_title, so they always take the
  // refreshFromHistory arm — maybeTitleFirstMessage would bail on the
  // name its own eager call had just written.
  //
  // No payer, or a billing lookup that throws, no longer means no name:
  // sessionTitles.titleAtTurnEnd owns that decision and falls back to
  // the payer-free deterministic trim, which for an issue-started
  // session is the issue title.
  const refreshTitleAtTurnEnd = () => sessionTitles.titleAtTurnEnd({
    pool,
    session,
    message: messageText,
    userId: req.user.id,
    firstTurn: titledThisTurn,
    resolveBilling: () => limits.resolveBillingPath(
      pool, config.dataEncryptionKey, req.user.id,
    ),
    send,
  });

  try {
    // Parse repo info
    const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

    if (!repoOwner || !repoName) {
      // Structural, not transient: the app has no GitHub repo (repo
      // provisioning failed at creation — the app-heal sweep repairs
      // this within a tick or two). The old SSE-only 'error' event
      // died with the stream and left no server-side trace, so these
      // dead turns were invisible everywhere (session 2585). Persist
      // a status row that survives refresh and end the turn cleanly
      // so 'done' hooks (notifySessionDone) still fire.
      log.warn('sessions', 'Chat turn refused: app has no GitHub repo', {
        sessionId: session.id, appSlug: session.app_slug,
      });
      await sendStatus(
        'This turn can’t run: the app has no GitHub repository (repo provisioning failed when the app was created). The platform repairs this automatically, so try again in a few minutes.',
        { turnError: true }
      );
      send('done', {});
      res.end();
      stopRegistry.deleteIf(session.id, stopHandle);
      setTimeout(() => sessionBus.clearSession(session.id), 30000);
      return;
    }

    // OpenRouter is a complete, single-provider session path: no
    // Anthropic key is read and no Anthropic billing path is resolved
    // for it. Since #2809/#2810 its chat runs through the same Mayor
    // loop as a Claude session's, on the session's own OpenRouter model
    // and key (services/openrouter-mayor.js), so it gets the one-line
    // plan before a coding run, the scout-written spec, and the
    // wrap-up after.
    //
    // The DIRECT turn below is what these sessions had before, and it
    // stays as the fallback: the selected OpenRouter model receives the
    // user's message directly and can either answer it or edit the
    // repository, with no Mayor around it. It runs when the Mayor is
    // switched off (OPENROUTER_SESSION_MAYOR_ENABLED=false), when the
    // session's Mayor cannot be set up (no usable key, a model without
    // tool calling), and when the Mayor's first call fails before it has
    // said anything. Its first name is minted without a model call
    // (#1949, below); the turn-end refresh every in-platform session
    // shares then sharpens it (#2500).
    const runOpenRouterDirectTurn = async () => {
      // #1949: the Haiku titler used to be skipped for these sessions
      // entirely, so they kept their branch name ("dev/evan-1789…") for
      // life. It runs at their turn end now (#2500); this eager,
      // payer-free naming stays because it is the only one a refused or
      // stopped turn ever reaches. It names the session from its
      // opening ask — the same trim applyPrMetadata gives its PR title,
      // so the name holds when the PR lands. No payer to resolve, so it
      // fires before the busy gate: the message is already in the
      // transcript whatever happens next. Fire-and-forget; the helper
      // never rejects.
      sessionTitles.titleFromFirstMessage({ pool, session, message: messageText, send });
      const agentIdentity = codingAgentRuntimeIdentity(session, null, config);
      const directSpec = await loadSessionSpec(pool, session.id);
      turnHasSpec = !!String(directSpec || '').trim();

      if (isSessionBusy(session.id)) {
        const live = workerProgress.get(session.id);
        const busyIdentity = live?.backend
          ? {
              agentName: live.backend === 'codex_openrouter' ? 'OpenRouter' : 'Claude Code',
              metadata: {
                agentBackend: live.backend,
                agentModel: live.model || null,
              },
            }
          : agentIdentity;
        await sendStatus(
          `${busyIdentity.agentName} is already running for this session. Please wait for it to finish.`,
          { ...busyIdentity.metadata, quickReplies: turnPills('worker_busy') },
        );
        send('done', {});
        res.end();
        return;
      }

      releaseDispatchOperation = beginSessionOperation(session.id);
      send('assistant_message_end', {});

      let attachmentsBlock = '';
      if (turnAttachments.length) {
        try {
          attachmentsBlock = attachmentsSvc.buildDispatchBlock(
            await attachmentsSvc.loadByIds(pool, turnAttachments.map((a) => a.id)),
          );
        } catch (err) {
          log.warn('sessions', 'Failed to build OpenRouter attachment block', {
            sessionId: session.id, err: err.message,
          });
        }
      }
      const discussionBlock = await buildSessionDiscussionBlock(pool, session);

      setPhase('cc');
      const toolResult = await runClaudeCodeTool({
        pool, config, req, res, session, selectedModel,
        userMessage: messageText,
        toolPromptArg: messageText,
        attachmentsBlock,
        discussionBlock,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle,
        userApiKey: null,
        directSessionTurn: true,
        deferTurnCleanup: true,
      });

      // Configuration errors reuse the stop flag to prevent downstream
      // work, but are provider failures rather than a human stop. Real
      // stop requests keep the existing stopped event/cleanup contract.
      if (stopHandle.stopped && stopHandle.stoppedBy !== 'agent_error') {
        if (toolResult.turnId) {
          const cleared = await worker.finishTurn(session.id, { turnId: toolResult.turnId });
          if (!cleared) {
            await scheduleRetainedInteractiveTurn({
              pool, sessionId: session.id, scheduleInteractiveRecovery,
              assumeRetained: true,
            });
          }
        }
        // #2599: release the busy hold and the stop handle BEFORE the
        // terminal events, as the Claude path does (its `finally` runs
        // ahead of its send('done')). Both are idempotent, so the
        // route's own `finally` re-running them is harmless.
        if (releaseDispatchOperation) releaseDispatchOperation();
        stopRegistry.deleteIf(session.id, stopHandle);
        send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
        send('done', {});
        res.end();
        setTimeout(() => sessionBus.clearSession(session.id), 30000);
        return;
      }

      const directOutcome = toolResult.isError
        ? 'failed'
        : (toolResult.commitSha ? 'build_done' : 'chat');
      const directText = toolResult.toolResultText
        || (toolResult.isError
          ? '_The OpenRouter turn did not complete successfully. See the status messages above._'
          : '_Done._');
      const directPills = turnPills(directOutcome);
      const directKind = fallbackKindForTurn({
        outcome: directOutcome,
        hasPr: session.pr_number != null,
        hasSpec: turnHasSpec,
      });
      // #2118: what the turn cost, as the ledger estimated it from the
      // model's list price (agent_turns.estimated_cost_usd, summed over
      // the turn's attempts). It rides on the reply row so the row's
      // "reply ~$x" label survives a reload, flagged as an estimate.
      const directCostCents = Number.isFinite(toolResult.estimatedCostCents)
        && toolResult.estimatedCostCents > 0
        ? toolResult.estimatedCostCents
        : null;
      const directMeta = JSON.stringify({
        ...(directPills ? { quickReplies: directPills } : {}),
        quickRepliesSource: 'static',
        ...(directKind ? { quickRepliesKind: directKind } : {}),
        openRouterDirect: true,
        ...(directCostCents != null ? { costEstimated: true } : {}),
      });
      const directModel = agentIdentity.model
        ? `openrouter/${agentIdentity.model}`
        : null;
      const insertDirectReply = (client) => client.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, cost_cents, metadata)
             VALUES ($1, 'assistant', $2, $3, $4, $5)`,
        [session.id, directText, directModel, directCostCents, directMeta],
      );
      let replyApplied = true;
      if (toolResult.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: toolResult.turnId,
          effectKey: TURN_WRAPUP_EFFECT_KEYS.message,
          sessionId: session.id,
          run: async (client) => {
            await insertDirectReply(client);
            return { persisted: true };
          },
        });
        replyApplied = receipt.applied;
      } else {
        await insertDirectReply(pool);
      }
      if (replyApplied) {
        send('mayor_reasoning', { text: directText });
        // The usage receipt follows the reply on purpose: the client
        // attaches it to the assistant bubble on screen, and before
        // mayor_reasoning that bubble is one the next status line
        // discards. It is also what feeds the composer's "this turn"
        // figure for an OpenRouter session (#2118).
        if (directCostCents != null) {
          // #2571: an included-key turn is platform money and joins the
          // shared weekly pool, exactly as the build and scout receipts
          // below do. See sharedPoolCodexSpend.
          const directPooled = await sharedPoolCodexSpend(
            pool, req.user.id, directCostCents,
          );
          send('usage', { costCents: directCostCents, model: directModel, byok: !directPooled, estimated: true });
        }
        if (directPills) send('quick_replies', { replies: directPills });
      }

      if (toolResult.turnId) {
        await worker.noteTailMilestone(
          session.id,
          { wrapUpPosted: true },
          { turnId: toolResult.turnId },
        );
        const cleared = await worker.finishTurn(session.id, { turnId: toolResult.turnId });
        if (!cleared) {
          await scheduleRetainedInteractiveTurn({
            pool, sessionId: session.id, scheduleInteractiveRecovery,
            assumeRetained: true,
          });
        }
      }

      // #2599: `done` used to be emitted while this turn still held the
      // session's busy operation and its stop handle — the reverse of
      // the Claude path, whose `finally` runs before its send('done').
      // A GET /status (or the coalesced session_state broadcast) that
      // raced the event therefore still answered "running, stoppable"
      // for a turn the client had just been told was over. Release
      // first; the route's `finally` repeating both is a no-op.
      if (releaseDispatchOperation) releaseDispatchOperation();
      stopRegistry.deleteIf(session.id, stopHandle);
      // #2500: the opening trim gave this session a name before the
      // turn ran; now that the turn has produced something, re-title it
      // from everything known so far, exactly as the Claude paths do.
      refreshTitleAtTurnEnd();
      send('done', {});
      res.end();
      setTimeout(() => sessionBus.clearSession(session.id), 30000);
    };

    // The Mayor's model, key and payer for this turn. On a Claude
    // session they are the Anthropic Mayor's, exactly as before. On an
    // OpenRouter session they are the session's own OpenRouter model
    // and key, and spend follows #2571: the included key is platform
    // money and joins the shared weekly pool, a personal key is the
    // user's own and is neither blocked nor billed.
    let sessionMayor = null;
    if (isOpenRouterSession) {
      try {
        const resolved = await openRouterMayor.resolveForSession({
          pool, config, session, userId: req.user.id,
        });
        if (resolved.error) {
          log.info('sessions', 'OpenRouter Mayor unavailable; running the direct turn', {
            sessionId: session.id, reason: resolved.error,
          });
        } else {
          sessionMayor = resolved;
        }
      } catch (err) {
        log.warn('sessions', 'OpenRouter Mayor setup failed; running the direct turn', {
          sessionId: session.id, err: err.message,
        });
      }
      if (!sessionMayor) {
        await runOpenRouterDirectTurn();
        return;
      }
      // Same payer-free first name the direct turn mints (#1949).
      sessionTitles.titleFromFirstMessage({ pool, session, message: messageText, send });
    }
    const mayorLlm = sessionMayor ? sessionMayor.client : llm;
    const mayorModel = sessionMayor ? sessionMayor.modelLabel : selectedModel;
    // Whether the platform records the Mayor's spend at all. userApiKey
    // stays null on an OpenRouter session, so a recorded included-key
    // call lands in the shared pool, as sharedPoolCodexSpend does.
    const mayorSpendRecorded = !sessionMayor || sessionMayor.usesIncludedKey;
    const mayorByok = () => (sessionMayor ? !sessionMayor.usesIncludedKey : !!userApiKey);
    const recordMayorSpend = async (costCents) => {
      if (mayorSpendRecorded) {
        await limits.recordSpend(pool, req.user.id, costCents, { byok: !!userApiKey });
      }
    };
    const resolveMayorBilling = async () => {
      if (!sessionMayor) {
        return limits.resolveBillingPath(pool, config.dataEncryptionKey, req.user.id);
      }
      if (!sessionMayor.usesIncludedKey) return { apiKey: null };
      const budget = await limits.checkBudget(pool, req.user.id);
      return budget.error ? budget : { apiKey: null };
    };

    // Fable 5 classifier fallback: every fallback-served Mayor call
    // gets an admin record (log.warn + events row), but the in-chat
    // notice fires ONCE per turn — a multi-phase turn where both the
    // plan and the wrap-up fell back shouldn't nag twice.
    let fallbackNoticed = false;
    const noteModelFallback = async (result) => {
      if (!result || !result.fallbackServed) return;
      const requested = mayorModel;
      const served = result.servedModel || llm.FALLBACK_TARGET_MODEL;
      const category = (result.stopDetails && result.stopDetails.category) || null;
      await modelFallback.record(pool, {
        kind: events.EVENT_TYPES.MODEL_FALLBACK,
        userId: req.user.id, appId: session.app_id, sessionId: session.id,
        requested, served, category, source: 'mayor',
      });
      if (!fallbackNoticed) {
        fallbackNoticed = true;
        await sendStatus(modelFallback.noticeText(requested, served, category), {
          modelFallback: { requested, served, category },
        });
      }
    };

    await sendStatus('Thinking about your request...');

    // Pull user+mayor turns AND the coding-agent's final summaries
    // (stored as system messages with metadata.ccOutput). Without
    // those the Mayor has no visibility into what got built in
    // earlier turns, so questions like "what was the fix?" would
    // dispatch CC unnecessarily just to re-discover the answer.
    const { rows: history } = await pool.query(
      `SELECT id, role, content, metadata FROM chat_session_messages
           WHERE session_id = $1
             AND (role IN ('user', 'assistant')
                  OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL))
           ORDER BY id ASC`,
      [session.id]
    );
    // #1001: hand the same rows to the pill ladder, so an enforced or
    // generated set is grounded in the conversation the Mayor saw.
    turnHistory = history;

    // #450: bulk-load attachment bytes for user rows that carry
    // metadata.attachments so buildMayorMessages can emit vision
    // blocks + inlined text files. Best-effort — on failure the
    // Mayor just sees the plain text history.
    let historyAttachments = new Map();
    try {
      historyAttachments = await attachmentsSvc.loadForHistory(pool, history);
    } catch (err) {
      log.warn('sessions', 'Failed to load history attachments', { sessionId: session.id, err: err.message });
    }

    // Same "in-flight only — warm-idle ≠ busy" rationale as the
    // /status endpoint above. Pre-warm-CC, "container running"
    // meant "claude actively running"; now it just means "wrapper
    // alive". Treating warm-idle as busy here would falsely lock
    // the Mayor out of dispatch_scout / dispatch_claude_code for
    // the entire idle-eviction window of a previous turn.
    const isWorkerBusy = isSessionBusy(session.id);
    // Inject the live spec_md into the Mayor's system prompt every
    // turn so revisions anchor against real content instead of
    // regenerating from scratch. Re-read before phase-2 below in
    // case the tool we're about to run mutated it.
    let currentSpec = await loadSessionSpec(pool, session.id);
    turnHasSpec = !!(currentSpec || '').trim();
    const prContext = session.pr_number
      ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
      : null;
    // #199: on the FIRST turn of a fresh session — exactly one user row
    // in the just-loaded history (the message inserted above) and not a
    // headless clone (clones arrive with copied history AND a non-null
    // cloned_from_session_id; headless sessions themselves never reach
    // this route) — surface the app's open promoted/merging proposals so
    // the Mayor can flag a duplicate request before any dispatch.
    // Advisory only: any failure skips the block and the turn proceeds.
    let openProposalsBlock = '';
    const isFirstFreshTurn = !session.cloned_from_session_id
      && history.filter((m) => m.role === 'user').length === 1;
    if (isFirstFreshTurn) {
      try {
        const { rows: proposalRows } = await pool.query(
          `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.status,
                      cs.linked_issues, cs.spec_md, u.username
               FROM chat_sessions cs
               LEFT JOIN users u ON cs.user_id = u.id
               WHERE cs.app_id = $1 AND cs.id <> $2
                 AND cs.status IN ('promoted', 'merging')
               ORDER BY cs.last_activity_at DESC
               LIMIT 10`,
          [session.app_id, session.id]
        );
        openProposalsBlock = buildOpenProposalsBlock(proposalRows, req.user.username);
      } catch (err) {
        log.warn('sessions', 'Open-proposals lookup failed (continuing without block)', { sessionId: session.id, err: err.message });
      }
    }
    // #460: compact metadata block listing the session owner's
    // personal agent files (names + descriptions only — contents go
    // to Claude Code via the CC-volume sync, never to the Mayor) so
    // the Mayor can answer "what instructions are you using?".
    // Advisory: any failure just drops the block.
    let agentFilesBlock = '';
    try {
      if (session.user_id) {
        const afMeta = await userAgentFiles.listForUser(pool, session.user_id);
        agentFilesBlock = userAgentFiles.buildMayorAgentFilesBlock(afMeta);
      }
    } catch (err) {
      log.warn('sessions', 'Agent-files metadata load failed (continuing without block)', { sessionId: session.id, err: err.message });
    }
    // Prod-debug awareness for the Mayor (#616 follow-up): admin-owned
    // sessions on the self-edit app get an awareness block in the
    // system prompt plus the get_prod_status data tool. Checked fresh
    // per turn (admin revocation takes effect on the next message) and
    // reused for the phase-2 rebuild below. Failure means no awareness
    // — never a failed turn (mirrors the dispatch-site checks).
    let prodDebugEligible = false;
    try {
      prodDebugEligible = await debugAccess.isEligible(pool, session.id);
    } catch (err) {
      log.warn('sessions', 'Prod-debug eligibility check failed (Mayor turn continues without)', {
        sessionId: session.id, err: err.message,
      });
    }
    // #945: the issue / proposal Discussion threads. Rebuilt every
    // turn (not first-turn-only like openProposalsBlock) so a message
    // posted between turns lands in the next one; also handed to the
    // scout/build dispatch prompts below so a spec is grounded in what
    // people actually asked for. Empty string when there's nothing to
    // show, which keeps the prompt byte-identical.
    let discussionBlock = await buildSessionDiscussionBlock(pool, session);
    // #1037: can an issue actually be filed from this session? Gates
    // BOTH the draft_issue_report tool and the FILING ISSUES prompt
    // block, so the Mayor is never told to reach for a tool it can't
    // see (or handed one whose every result would be not_configured).
    const canDraftIssues = issueDraft.canDraft(config, session.repo_url);
    let mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext, openProposalsBlock, agentFilesBlock, prodDebugEligible, discussionBlock, canDraftIssues);
    const messages = buildMayorMessages(history, historyAttachments);

    if (!mayorLlm.isEnabled()) {
      send('error', { error: 'LLM not configured' });
      send('done', {});
      res.end();
      return;
    }

    // --- Phase 1: Mayor turn with dispatch_claude_code available ---
    //
    // The model decides — as a first-class tool call — whether to
    // hand off to the coding agent. No more [CHAT_ONLY] prefix
    // sentinel: if the user's message is a chat/clarification, the
    // model just responds in text and stops. If it's a concrete
    // code change, the model emits a short plan text block + a
    // tool_use block. We run the tool, feed the result back as a
    // `tool_result`, and re-enter the model for a short wrap-up
    // turn.
    // The Mayor sees two action tools when no worker is busy:
    // dispatch_scout (all spec drafting AND revision — the Mayor has
    // no in-process spec-edit tools anymore; Claude Code in plan
    // mode does a much better job at spec work, see #111) and
    // dispatch_claude_code (build). Their priority ordering is
    // enforced both by the system prompt AND by the resolution code
    // below — models sometimes ignore prose constraints, so we
    // belt-and-suspenders it server-side.
    // The data tools (list_github_issues / get_github_issue / web_fetch)
    // stay available even when a worker is busy: they're read-only and
    // cheap, and reading the tracker or a linked page while a build runs
    // is a legitimate chat action. The dispatch tools remain gated by
    // isWorkerBusy as before.
    // suggest_answers (#32) rides along in BOTH branches — it's not a
    // dispatch, so asking clarifying questions with tappable answers
    // is fine even while a worker is busy.
    // get_prod_status is offered ONLY on prod-debug-eligible sessions
    // (admin owner + self-edit app) — ineligible Mayors never see the
    // tool, matching the prompt-block gating. Like the other data
    // tools it stays available while a worker is busy: it's read-only
    // and cheap.
    // #1037: draft_issue_report rides along in BOTH branches. It is
    // human-gated (the card files nothing until a tap) and cheap, and
    // a draft landing mid-build is already a supported case — the
    // dedicated event type exists so it doesn't kill the running-agent
    // spinner. Offered only when a destination is actually filable, so
    // the Mayor never reaches for a tool whose every answer would be
    // `not_configured`; the same flag gates the prompt block above.
    const dataTools = [
      LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL, WEB_FETCH_TOOL,
      ...(prodDebugEligible ? [GET_PROD_STATUS_TOOL] : []),
      ...(canDraftIssues ? [DRAFT_ISSUE_REPORT_TOOL] : []),
    ];
    const tools = isWorkerBusy
      ? [SUGGEST_ANSWERS_TOOL, SUGGEST_REPLIES_TOOL, ...dataTools]
      : [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, SUGGEST_ANSWERS_TOOL, SUGGEST_REPLIES_TOOL, ...dataTools];

    setPhase('mayor1');
    let mayor1;
    // The conversation we feed the Mayor. list_github_issues,
    // get_github_issue, and web_fetch are read-only DATA tools: when the
    // Mayor calls one, we resolve it in-process, append the result as a
    // tool_result, and re-invoke so the Mayor reasons with it in the SAME
    // turn. This loop drains data-calls out BEFORE the terminal-tool
    // (dispatch/spec) selection below, so in the common case
    // mayor1.rawContent carries no dangling data tool_use into phase-2.
    let mayorConvo = messages;
    let dataIters = 0;
    // #1037: results of in-process calls already executed this turn,
    // keyed by tool_use id. Only draft_issue_report actually needs
    // this — it has a SIDE EFFECT, so phase-2 must answer its
    // tool_use with the result of the draft we already created
    // instead of running createDraft a second time.
    const inProcessResults = new Map();
    try {
      for (;;) {
        mayor1 = await mayorLlm.streamChat({
          messages: mayorConvo,
          systemPrompt: mayorPrompt,
          model: mayorModel,
          tools,
          signal: stopHandle.abort.signal,
          onToken: (text) => send('token', { text }),
          apiKey: userApiKey,
          telemetryContext: invocationTelemetry(
            pool,
            session,
            dataIters === 0 ? 'mayor_phase_1' : 'mayor_data_iteration',
          ),
        });
        await noteModelFallback(mayor1);

        const dataCalls = mayor1.toolUses.filter((t) => IN_PROCESS_TOOL_NAMES.has(t.name));
        // Parallel tool use is enabled, so the Mayor may emit
        // a data tool ALONGSIDE a terminal tool in one response.
        // If a terminal tool is present we must NOT re-invoke here: the
        // re-invocation only answers the data tool_use, leaving the
        // terminal tool_use dangling -> Anthropic 400. Break instead and
        // let the phase-2 wrap-up resolve every tool_use (it already
        // re-fetches any stray data call).
        // suggest_answers (#32) is terminal here too: the turn ends as
        // a question turn, so re-invoking would leave its tool_use
        // dangling in mayorConvo (Anthropic 400). End-of-turn dangling
        // is harmless — buildMayorMessages rebuilds from text rows.
        const hasTerminalTool = mayor1.toolUses.some((t) =>
          t.name === 'dispatch_claude_code'
          || t.name === 'dispatch_scout'
          || t.name === 'suggest_answers'
          || t.name === 'suggest_replies');
        if (!dataCalls.length || dataIters >= MAYOR_DATA_TOOLS_MAX_ITERS) break;
        if (hasTerminalTool) {
          // #1037: a data READ alongside a terminal tool can simply be
          // dropped (the phase-2 wrap-up re-fetches it). A
          // draft_issue_report cannot — it is the user's explicitly
          // requested SIDE EFFECT, and the most common shape for it is
          // exactly this one (draft + suggest_replies in a single
          // response). Run it here, before the break, so the card
          // always lands; only the re-invocation is skipped. The
          // result is memoized for phase-2 so a dispatch riding along
          // doesn't draft the same card twice.
          for (const tc of dataCalls) {
            if (tc.name !== DRAFT_TOOL_NAME || inProcessResults.has(tc.id)) continue;
            inProcessResults.set(tc.id, await resolveDataToolResult(
              tc, repoOwner, repoName,
              { pool, config, sessionId: session.id },
              { pool, appId: session.app_id }
            ));
          }
          break;
        }
        dataIters += 1;

        // Bill each intermediate data-tool turn — the Anthropic call
        // happened and is invoiced whether or not it produced text.
        // (The final iteration's spend is billed by the existing
        // phase-1 accounting just below the loop.)
        // Price + attribute with the SERVED model — a fallback-served
        // call bills at (and displays) the fallback model's identity.
        const servedModelIter = mayor1.servedModel || mayorModel;
        let dataCost = 0;
        if (mayor1.usage) {
          dataCost = mayorLlm.estimateCostCents(mayor1.usage, servedModelIter);
          await recordMayorSpend(dataCost);
          send('usage', { costCents: dataCost, model: servedModelIter, byok: mayorByok() });
        }

        // Persist any preamble text this iteration produced ("Let me
        // check the open issues…") as its own assistant row BEFORE the
        // status row — chat_session_messages id order is the
        // refresh-render order, and without this row the preamble
        // bubble would vanish on refresh. mayor_reasoning makes the
        // live bubble authoritative even if token events were lost.
        if (mayor1.text.trim()) {
          send('mayor_reasoning', { text: mayor1.text });
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
                 VALUES ($1, 'assistant', $2, $3, $4, $5)`,
            [session.id, mayor1.text, servedModelIter,
              mayor1.usage ? mayor1.usage.input_tokens + mayor1.usage.output_tokens : null,
              dataCost]
          );
        }
        // Seal the bubble so the next iteration's tokens land in a
        // fresh one BELOW the status line (#99) — without this the
        // follow-up text appends to the bubble above the status.
        send('assistant_message_end', {});

        await sendStatus(dataToolStatusLine(dataCalls));
        const dataResults = await Promise.all(
          // #1037: memoize side-effecting calls so a retry-shaped
          // conversation can never create the same draft card twice.
          dataCalls.map(async (tc) => {
            if (inProcessResults.has(tc.id)) return inProcessResults.get(tc.id);
            const out = await resolveDataToolResult(tc, repoOwner, repoName, { pool, config, sessionId: session.id }, { pool, appId: session.app_id });
            if (tc.name === DRAFT_TOOL_NAME) inProcessResults.set(tc.id, out);
            return out;
          })
        );
        // #990: close the fetch step and name the one that is actually
        // running now. Must land AFTER the batch resolves (so the
        // client's _deactivateLastStatus freezes a truthful duration on
        // the fetch row) and BEFORE the re-invocation below, which is
        // the silent window this row covers.
        await sendStatus(DATA_TOOL_THINKING_STATUS);
        mayorConvo = [
          ...mayorConvo,
          // Verbatim assistant content (incl. the tool_use blocks) so the
          // tool_result ids resolve, exactly like the phase-2 round-trip.
          { role: 'assistant', content: mayor1.rawContent },
          {
            role: 'user',
            content: dataCalls.map((tc, i) => ({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: dataResults[i],
            })),
          },
        ];

        // The next loop iteration is a separate paid model call. The
        // data lookup above may follow a call that consumed the final
        // platform-funded credit, so never reuse the turn-start payer.
        let continuationBilling = null;
        try {
          continuationBilling = await resolveMayorBilling();
        } catch (err) {
          log.warn('sessions', 'Data-tool continuation billing resolve failed', {
            sessionId: session.id, err: err.message,
          });
        }
        if (!continuationBilling || continuationBilling.error) {
          await sendStatus(
            continuationBilling?.error
              || 'Could not verify credit eligibility for another AI call.',
            { turnError: true },
          );
          // This response was already persisted and debited as the
          // intermediate call. Close on the normal no-dispatch path
          // without double-counting it or retaining a dangling tool.
          mayor1 = {
            ...mayor1,
            text: '',
            toolUses: [],
            rawContent: [],
            usage: { input_tokens: 0, output_tokens: 0 },
            stopReason: 'billing_unavailable',
          };
          break;
        }
        userApiKey = continuationBilling.apiKey;
      }
    } catch (err) {
      if (stopHandle.stopped) {
        // User hit stop during phase-1. Mayor never got to finish a
        // response; nothing useful was persisted (the optimistic user
        // row was already committed above — that's fine, they can
        // edit/resend). Emit a clean `stopped` event so the client
        // tears down the streaming UI, and persist a system message
        // so the timeline reflects the stop on refresh.
        const byStr = stopHandle.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
        // #894: a stop during the Mayor turn ends everything here —
        // this status row is the only place pills can live.
        await sendStatus(`Stopped${byStr}.`, { quickReplies: turnPills('stopped') });
        send('stopped', { phase: 'mayor1', by: stopHandle.stoppedBy });
        send('done', {});
        res.end();
        stopRegistry.deleteIf(session.id, stopHandle);
        setTimeout(() => sessionBus.clearSession(session.id), 30000);
        return;
      }
      // An OpenRouter Mayor that fails before it has said anything
      // (a provider refusing the request, a model whose tool calling
      // or context cannot carry the Mayor's prompt) must not cost the
      // user their turn: hand the message to the coding agent directly,
      // exactly as these sessions ran before they had a Mayor.
      if (sessionMayor && dataIters === 0) {
        log.warn('sessions', 'OpenRouter Mayor call failed; running the direct turn', {
          sessionId: session.id, code: err.code || null, status: err.status || null, err: err.message,
        });
        await sendStatus(`The Mayor could not reach ${safeAgentModelLabel(sessionMayor.model)}, so your message goes straight to the coding agent.`);
        await runOpenRouterDirectTurn();
        return;
      }
      throw err;
    }

    let mayorText1 = mayor1.text;
    log.info('sessions', 'Mayor phase-1 response', {
      sessionId: session.id,
      textLen: mayorText1.length,
      toolUses: mayor1.toolUses.length,
      stopReason: mayor1.stopReason,
      preview: mayorText1.substring(0, 200),
    });

    // Whole-chain refusal: Fable 5's classifiers declined AND the
    // fallback couldn't complete it (or declined too). Replace the
    // old silent empty reply with an explicit persisted status, and
    // end the turn cleanly — a refused turn must never dispatch
    // (any tool_use blocks are the declined model's).
    if (mayor1.stopReason === 'refusal') {
      const refusalCategory = (mayor1.stopDetails && mayor1.stopDetails.category) || null;
      await modelFallback.record(pool, {
        kind: events.EVENT_TYPES.MODEL_REFUSAL,
        userId: req.user.id, appId: session.app_id, sessionId: session.id,
        requested: mayorModel, served: mayor1.servedModel || mayorModel,
        category: refusalCategory, source: 'mayor',
      });
      await sendStatus(modelFallback.refusalText(mayorModel, refusalCategory), {
        modelRefusal: { requested: mayorModel, category: refusalCategory },
        // #894: a refused turn ends here with no assistant row, so this
        // status line is the only thing left to hang pills off.
        quickReplies: turnPills('failed'),
      });
      mayor1.toolUses = [];
    }
    // (The empty-reply fallback runs below, AFTER the suggestion
    // resolution — a tool-only suggest_answers/suggest_replies reply
    // is salvaged into visible text first, and only a turn that would
    // still end with nothing visible gets the generic fallback.)

    // Defense in depth: if the Mayor wrote a fake "[CODING AGENT
    // COMPLETED]" marker into its plain-text reply WITHOUT actually
    // calling the tool, that's hallucinated output pretending a CC
    // run happened. Strip the bogus block, log a warn, and replace
    // it with a short note. The system prompt forbids this, but
    // models occasionally regress; without this check the user sees
    // a totally fabricated "fix summary" with no underlying commit.
    // Strip unconditionally (#358): the marker is only ever produced by
    // the harness (buildMayorMessages); an assistant turn must never
    // carry it, whether or not a tool was also called. When the scrub
    // empties the text, substitute an honest note.
    {
      const stripped = stripFakeCompletionMarker(mayorText1, { sessionId: session.id });
      if (stripped !== mayorText1) {
        mayorText1 = stripped
          || '(I described what should change, but didn\'t actually run the coding agent. Try sending again.)';
      }
    }

    // Q/A mode (#32): suggested answers for clarifying questions.
    // Dropped when a dispatch tool co-occurred (clarity gate forbids
    // ask+dispatch — dispatch wins); skipped entirely when there is
    // no assistant text to attach them to.
    const { suggestions, droppedForDispatch } = resolveSuggestedAnswers(mayor1.toolUses);
    if (droppedForDispatch) {
      log.warn('sessions', 'Mayor emitted suggest_answers alongside a dispatch tool — dropping suggestions', {
        sessionId: session.id,
      });
    }
    // Quick-reply pills (#285): dropped when suggest_answers co-occurs
    // (inline chips win). #1001: a dispatch no longer discards them —
    // the preamble row keeps the Mayor's own pills and the newer
    // phase-2 row supersedes them by recency, so a turn that dies
    // mid-dispatch still leaves conversation-specific pills behind.
    const quickReplies = resolveQuickReplies(mayor1.toolUses, { allowWithDispatch: true });

    // Data-informed silent turn (session 2426): the model serviced one
    // or more data tools this turn (e.g. get_prod_status), then ended
    // tool-only — the findings it fetched would be silently discarded
    // (the salvage below can only anchor chips with a generic line, not
    // reconstruct the findings). Re-prompt ONCE — the tool results are
    // still in mayorConvo, so a short continuation with tool_choice
    // 'none' usually recovers the summary as plain text. When that
    // ALSO yields nothing, the salvage below substitutes an explicit
    // "fetched but failed to summarize" line instead of the generic
    // chip anchor, so the failure isn't masked.
    let dataSummaryFailed = false;
    if (!mayorText1.trim() && mayor1.stopReason !== 'refusal'
        && shouldRepromptForDataSummary(mayorText1, mayor1.toolUses, dataIters, mayor1.rawContent)) {
      dataSummaryFailed = true;
      // Bill the tool-only response now, like the intermediate
      // data-loop iterations — the phase-1 accounting below prices
      // mayor1.usage, which the retry's usage replaces on success.
      const servedModelBase = mayor1.servedModel || mayorModel;
      if (mayor1.usage) {
        const baseCost = mayorLlm.estimateCostCents(mayor1.usage, servedModelBase);
        await recordMayorSpend(baseCost);
        send('usage', { costCents: baseCost, model: servedModelBase, byok: mayorByok() });
        // The ordinary phase-1 settlement below must only see the
        // retry's usage. If the retry is skipped or fails, the base
        // call has already been fully settled here.
        mayor1.usage = { input_tokens: 0, output_tokens: 0 };
      }
      let summaryBilling = null;
      try {
        summaryBilling = await resolveMayorBilling();
      } catch (err) {
        log.warn('sessions', 'Data-summary billing resolve failed', {
          sessionId: session.id, err: err.message,
        });
      }
      if (!summaryBilling || summaryBilling.error) {
        await sendStatus(
          summaryBilling?.error
            || 'Could not verify credit eligibility for the data summary.',
          { turnError: true },
        );
      } else try {
        userApiKey = summaryBilling.apiKey;
        // Seal the (empty) bubble so the retry's tokens land in a fresh
        // one below the status line, mirroring the data-loop flow.
        send('assistant_message_end', {});
        await sendStatus('Writing up what the data showed...');
        const retry = await mayorLlm.streamChat({
          messages: [...mayorConvo, ...buildDataSummaryReprompt(mayor1.rawContent, mayor1.toolUses)],
          systemPrompt: mayorPrompt,
          model: mayorModel,
          // Same tool defs (the convo carries tool_use blocks) but
          // hard-disabled: this call must produce text, not chips.
          tools,
          toolChoice: { type: 'none' },
          signal: stopHandle.abort.signal,
          onToken: (text) => send('token', { text }),
          apiKey: userApiKey,
          telemetryContext: invocationTelemetry(pool, session, 'mayor_data_iteration'),
        });
        await noteModelFallback(retry);
        const retryText = retry.stopReason === 'refusal'
          ? ''
          : stripFakeCompletionMarker(retry.text, { sessionId: session.id });
        if (retryText.trim()) {
          // Adopt the retry's text + usage as the phase-1 reply.
          // toolUses/rawContent keep the ORIGINAL reply's blocks so
          // the already-resolved suggestions/quickReplies and the
          // terminal-tool selection below are unaffected.
          mayorText1 = retryText;
          mayor1.usage = retry.usage || mayor1.usage;
          mayor1.servedModel = retry.servedModel || mayor1.servedModel;
          dataSummaryFailed = false;
          log.info('sessions', 'Mayor data-summary re-prompt recovered text', {
            sessionId: session.id,
            textLen: retryText.length,
          });
        } else {
          log.warn('sessions', 'Mayor data-summary re-prompt still produced no text', {
            sessionId: session.id,
            stopReason: retry.stopReason,
          });
        }
      } catch (err) {
        if (stopHandle.stopped) {
          const byStr = stopHandle.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
          // #894: same as the phase-1 stop above.
          await sendStatus(`Stopped${byStr}.`, { quickReplies: turnPills('stopped') });
          send('stopped', { phase: 'mayor1', by: stopHandle.stoppedBy });
          send('done', {});
          res.end();
          stopRegistry.deleteIf(session.id, stopHandle);
          setTimeout(() => sessionBus.clearSession(session.id), 30000);
          return;
        }
        // Best-effort: a failed re-prompt falls through to the
        // explicit salvage fallback rather than failing the turn.
        log.warn('sessions', 'Mayor data-summary re-prompt failed', {
          sessionId: session.id,
          err: err.message,
        });
      }
    }

    // Silent-turn guard (session 2383): a reply whose ENTIRE content is
    // a suggest_answers/suggest_replies tool_use used to be dropped —
    // the persist block below is text-gated, so the model's questions
    // and chips vanished and the turn ended with nothing visible.
    // Salvage the tool content into assistant text; if nothing is
    // salvageable and no dispatch tool will produce output either
    // (covers the data-tool-cap break leaving a dangling data call),
    // substitute an explicit fallback so the turn never ends silently.
    // Refusal turns are excluded — they already persisted a status.
    if (!mayorText1.trim() && mayor1.stopReason !== 'refusal') {
      const salvaged = salvageAssistantText(mayorText1, suggestions, quickReplies);
      // Salvaged questions are the model's real content and still win;
      // the generic chip anchor / empty-reply fallback would mask an
      // unsummarized data fetch, so those get the explicit line.
      const salvagedRealContent = Array.isArray(suggestions) && suggestions.length > 0 && salvaged.trim();
      if (dataSummaryFailed && !salvagedRealContent) {
        mayorText1 = DATA_SUMMARY_FALLBACK_TEXT;
        send('token', { text: mayorText1 });
        log.warn('sessions', 'Mayor data-informed turn ended textless after re-prompt — substituting explicit fallback', {
          sessionId: session.id,
          toolNames: mayor1.toolUses.map((t) => t.name),
        });
      } else if (salvaged.trim()) {
        mayorText1 = salvaged;
        send('token', { text: mayorText1 });
        log.warn('sessions', 'Mayor reply was tool-only — salvaged suggest content into text', {
          sessionId: session.id,
          stopReason: mayor1.stopReason,
          toolNames: mayor1.toolUses.map((t) => t.name),
        });
      } else if (needsEmptyReplyFallback(mayorText1, mayor1.toolUses)) {
        mayorText1 = '_The assistant ended its turn without a reply. Please send your message again._';
        send('token', { text: mayorText1 });
        log.warn('sessions', 'Mayor turn produced no visible output — substituting fallback text', {
          sessionId: session.id,
          stopReason: mayor1.stopReason,
          toolNames: mayor1.toolUses.map((t) => t.name),
        });
      }
    }

    // Always debit the Mayor's phase-1 spend — even on tool-only
    // turns where mayorText1 is empty (the Anthropic call still
    // happened and was billed). chat_session_messages still gets
    // an assistant row only when there's actual reasoning text;
    // an empty assistant message would clutter the chat history.
    // Served-model attribution: a fallback-served turn is priced,
    // persisted, and displayed as the model that actually answered.
    const servedModel1 = mayor1.servedModel || mayorModel;
    const costCents1 = mayor1.usage ? mayorLlm.estimateCostCents(mayor1.usage, servedModel1) : 0;
    // Whether this reply will be followed by a dispatch — i.e. whether
    // the row about to be written is a PREAMBLE (phase 2 writes the
    // turn's final row) or the whole turn.
    const willDispatch = mayor1.toolUses.some((t) =>
      t && (t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'));

    // Settle the response before any post-hoc pill/title model call.
    // Those helpers independently re-check billing and must see the
    // main call's real spend, not the pre-call balance.
    if (mayor1.usage) {
      await recordMayorSpend(costCents1);
      send('usage', { costCents: costCents1, model: servedModel1, byok: mayorByok() });
    }

    if (mayorText1.trim()) {
      // Stream/reconcile the reply bubble FIRST. #1001's enforcement can
      // add ~1s before the pill row lands, and this ordering is what
      // keeps that off the critical path the user actually feels: the
      // text is already on screen before any pill work starts.
      send('mayor_reasoning', { text: mayorText1 });

      // #1001: the Mayor authors its own pills, or is asked again for
      // them. Two exclusions, both deliberate:
      //   - suggest_answers came back: the inline answer chips ARE this
      //     turn's affordance and the above-box row stays empty. No
      //     pills, no enforcement call. (Same precedence
      //     resolveQuickReplies and classifyMissingPills enforce.)
      //   - refusal / empty-reply substitution: the visible text is
      //     platform-authored and the model has already declined, so
      //     asking it again is throwing money at a "no". Static set.
      const chipsOwnTurn = Array.isArray(suggestions) && suggestions.length > 0;
      const modelDeclined = mayor1.stopReason === 'refusal' || dataSummaryFailed;
      let pills1 = null;
      if (!chipsOwnTurn) {
        // 'chat' either way: on a preamble the dispatch hasn't run yet,
        // so its outcome isn't knowable here — phase 2 writes the row
        // that reflects what actually landed.
        // The ladder's extra rungs are Anthropic calls, which an
        // OpenRouter session never makes: its Mayor's own pills or the
        // static set.
        pills1 = await resolvePills('chat', {
          modelPills: quickReplies,
          model: servedModel1,
          replyText: mayorText1,
          allowModelCalls: !modelDeclined && !sessionMayor,
          allowGenerate: !modelDeclined && !sessionMayor,
        });
        log.info('sessions', 'quick replies resolved', {
          sessionId: session.id, phase: willDispatch ? 'preamble' : 'reply',
          source: pills1.source, kind: pills1.kind || null,
        });
      }
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
             VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
        [session.id, mayorText1, servedModel1, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1,
         JSON.stringify({
           ...(suggestions ? { suggestions } : {}),
           ...quickReplyMeta(pills1, { preamble: willDispatch }),
         })]
      );
      if (suggestions) send('suggestions', { suggestions });
      if (pills1 && pills1.replies) send('quick_replies', { replies: pills1.replies });
    }
    // Pick which tool the Mayor invoked, with server-side priority
    // enforcement: dispatch_scout > dispatch_claude_code. If the
    // Mayor (mis)used both in one turn, we honor the planning tool
    // and quietly drop the dispatch — same rule the tool
    // descriptions state, but enforced here so a model regression
    // can't cause a surprise build mid-spec-discussion.
    const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
    const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');

    let activeToolCall = null;
    let toolKind = null; // 'scout' | 'build'
    if (scoutCall) { activeToolCall = scoutCall; toolKind = 'scout'; }
    else if (dispatchCall) { activeToolCall = dispatchCall; toolKind = 'build'; }

    if (!activeToolCall) {
      // Pure chat turn — no tool call needed.
      refreshTitleAtTurnEnd();
      send('done', {});
      res.end();
      setTimeout(() => sessionBus.clearSession(session.id), 30000);
      return;
    }

    // Race check: scout and build both share a per-session worker
    // container, so they share the same gate.
    //
    // Same warm-CC caveat as /status and isWorkerBusy above —
    // gating on container-status would reject every scout/build
    // for ~10 min after the first dispatch finishes (warm idle is
    // not busy).
    if (isSessionBusy(session.id)) {
      const live = workerProgress.get(session.id);
      const busyAgent = live?.backend
        ? {
            agentName: live.backend === 'codex_openrouter' ? 'OpenRouter' : 'Claude Code',
            metadata: {
              agentBackend: live.backend,
              agentModel: live.model || null,
            },
          }
        : codingAgentRuntimeIdentity(session, selectedModel, config);
      // #894: this status line IS the turn — no assistant row follows,
      // so it carries the pills (the run in flight is the only useful
      // thing to ask about next).
      await sendStatus(`${busyAgent.agentName} is already running for this session. Please wait for it to finish.`,
        { ...busyAgent.metadata, quickReplies: turnPills('worker_busy') });
      send('done', {});
      res.end();
      return;
    }
    // Claim the session before any async dispatch preparation. Local MCP
    // proposal submissions use the same registry, so neither surface can
    // pass a point-in-time busy check and then mutate the branch while the
    // other is awaiting DB/GitHub work.
    releaseDispatchOperation = beginSessionOperation(session.id);

    // Seal the phase-1 assistant bubble so the phase-2 wrap-up
    // lands in a fresh bubble below the CC status/progress events.
    send('assistant_message_end', {});

    // Persist any GitHub issues the Mayor declared this dispatch
    // addresses or drops (#75, #733). Additions union with the
    // session's existing linkage so the set grows across turns;
    // removals (`removes_issues`) subtract from it — winning over an
    // addition of the same number in the same call — so a mid-session
    // scope cut keeps the PR's `Closes #N` lines truthful.
    // pr-metadata.js turns each linked number into a `Closes #N` line
    // in the PR body. Best-effort: a failure here must not block the
    // build.
    {
      const declared = prMetadata.sanitizeIssueNumbers(activeToolCall.input?.addresses_issues);
      const dropped = prMetadata.sanitizeIssueNumbers(activeToolCall.input?.removes_issues);
      if (declared.length || dropped.length) {
        try {
          const { rows: liRows } = await pool.query(
            `SELECT linked_issues, pr_linked_issues_applied FROM chat_sessions WHERE id = $1`,
            [session.id]
          );
          const existing = prMetadata.sanitizeIssueNumbers(liRows[0] && liRows[0].linked_issues);
          const merged = prMetadata.applyIssueDeclarations(existing, declared, dropped);
          const changed = merged.length !== existing.length || merged.some((n, i) => n !== existing[i]);
          if (changed) {
            await pool.query(
              `UPDATE chat_sessions SET linked_issues = $1 WHERE id = $2`,
              [merged, session.id]
            );
            session.linked_issues = merged;
            // The issue list derives its "In progress" chip from
            // linked_issues, so tell every open Dev panel to refetch —
            // the chip appears while this dispatch is still running.
            try {
              const { pushIssueUpdate } = require('../ws');
              pushIssueUpdate({
                action: 'updated', source: 'linked_issues',
                appSlug: session.app_slug, appId: session.app_id,
              });
            } catch (err) {
              log.warn('sessions', 'linked_issues issue_update broadcast failed', { err: err.message, sessionId: session.id });
            }
          }

          // #733: when numbers were actually removed and a PR is
          // already open, patch its live body NOW. A scout turn never
          // reaches applyPrMetadata, so without this a stale
          // `Closes #N` line survives to merge and GitHub wrongly
          // auto-closes the issue. Build turns regenerate the whole
          // body at turn end anyway; running the strip here too covers
          // a build that fails or is stopped before that.
          const removedNow = existing.filter((n) => !merged.includes(n));
          if (removedNow.length && session.pr_number) {
            try {
              const pr = await github.getPR(repoOwner, repoName, session.pr_number);
              const patched = prMetadata.stripClosingLines(pr && pr.body, removedNow);
              if (pr && typeof pr.body === 'string' && patched !== pr.body) {
                await github.updatePR(repoOwner, repoName, session.pr_number, { body: patched });
              }
              // Subtract the removed numbers from the applied snapshot
              // so applyPrMetadata's drift gate keeps comparing against
              // what the live body actually carries.
              const applied = prMetadata.sanitizeIssueNumbers(liRows[0] && liRows[0].pr_linked_issues_applied);
              const appliedNew = applied.filter((n) => !removedNow.includes(n));
              if (appliedNew.length !== applied.length) {
                await pool.query(
                  `UPDATE chat_sessions SET pr_linked_issues_applied = $1 WHERE id = $2`,
                  [appliedNew, session.id]
                );
                session.pr_linked_issues_applied = appliedNew;
              }
              log.info('sessions', 'Stripped Closes lines from PR body after removes_issues', {
                sessionId: session.id, prNumber: session.pr_number, removed: removedNow,
              });
            } catch (err) {
              log.warn('sessions', 'PR-body Closes strip failed (non-fatal)', {
                err: err.message, sessionId: session.id, prNumber: session.pr_number,
              });
            }
          }
        } catch (err) {
          log.warn('sessions', 'Failed to persist linked issues', { err: err.message, sessionId: session.id });
        }
      }
    }

    // --- Run the chosen tool ---
    // #450: forward this turn's attachments to the dispatched agent —
    // text files inlined verbatim, images referenced by id with
    // usernode-attachments download instructions. Best-effort: a load
    // failure must not block the dispatch.
    let attachmentsBlock = '';
    if (turnAttachments.length) {
      try {
        attachmentsBlock = attachmentsSvc.buildDispatchBlock(
          await attachmentsSvc.loadByIds(pool, turnAttachments.map((a) => a.id))
        );
      } catch (err) {
        log.warn('sessions', 'Failed to build dispatch attachments block', { sessionId: session.id, err: err.message });
      }
    }
    let toolResult;
    if (toolKind === 'scout') {
      const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
        ? activeToolCall.input.prompt.trim()
        : messageText;

      setPhase('cc');
      toolResult = await runScoutTool({
        pool, config, req, res, session, selectedModel,
        userMessage: messageText,
        toolPromptArg,
        attachmentsBlock,
        discussionBlock,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle,
        userApiKey,
        deferTurnCleanup: true,
      });

      if (stopHandle.stopped) {
        // Same shape as the build stop path: skip the Mayor wrap-up
        // because there's nothing coherent to summarize.
        if (toolResult.turnId) {
          const cleared = await worker.finishTurn(session.id, { turnId: toolResult.turnId });
          if (!cleared) {
            log.warn('sessions', 'Stopped scout cleanup remains pending', {
              sessionId: session.id, turnId: toolResult.turnId,
            });
            await scheduleRetainedInteractiveTurn({
              pool, sessionId: session.id, scheduleInteractiveRecovery,
              assumeRetained: true,
            });
          }
        }
        send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
        send('done', {});
        res.end();
        stopRegistry.deleteIf(session.id, stopHandle);
        setTimeout(() => sessionBus.clearSession(session.id), 30000);
        return;
      }
    } else {
      const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
        ? activeToolCall.input.prompt.trim()
        : messageText;

      setPhase('cc');
      toolResult = await runClaudeCodeTool({
        pool, config, req, res, session, selectedModel,
        userMessage: messageText,
        toolPromptArg,
        attachmentsBlock,
        discussionBlock,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle,
        userApiKey,
        deferTurnCleanup: true,
      });

      if (stopHandle.stopped) {
        // User stopped during the CC run. We skip the Mayor wrap-up
        // entirely because the
        // Mayor has nothing coherent to summarize (no push, no PR, no
        // staging). The next dispatch resumes CC via --resume so its
        // own session memory is preserved.
        if (toolResult.turnId) {
          const cleared = await worker.finishTurn(session.id, { turnId: toolResult.turnId });
          if (!cleared) {
            log.warn('sessions', 'Stopped build cleanup remains pending', {
              sessionId: session.id, turnId: toolResult.turnId,
            });
            await scheduleRetainedInteractiveTurn({
              pool, sessionId: session.id, scheduleInteractiveRecovery,
              assumeRetained: true,
            });
          }
        }
        send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
        send('done', {});
        res.end();
        stopRegistry.deleteIf(session.id, stopHandle);
        setTimeout(() => sessionBus.clearSession(session.id), 30000);
        return;
      }

      ccLog = toolResult.ccLog;
      stagingUrl = toolResult.stagingUrl;
    }

    // The dispatch may have consumed the final platform-funded cent (or
    // the user may have removed their key while it ran). Resolve a fresh
    // payer for the separate wrap-up call. When none is available, the
    // completed work is preserved and closed with deterministic text;
    // no post-dispatch model request is allowed to bypass the tier.
    let wrapUpBillingAvailable = false;
    try {
      const rebill = await resolveMayorBilling();
      if (!rebill.error) {
        userApiKey = rebill.apiKey;
        wrapUpBillingAvailable = true;
      } else {
        log.info('sessions', 'Interactive wrap-up using deterministic fallback: no payer available', {
          sessionId: session.id, reason: rebill.reason || null,
        });
      }
    } catch (err) {
      log.warn('sessions', 'Post-dispatch billing re-resolve failed; using deterministic wrap-up', {
        sessionId: session.id, err: err.message,
      });
    }

    // --- Phase 2: Mayor wrap-up turn ---
    //
    // Feed the tool_use → tool_result round-trip back into the model
    // so it can summarize what actually happened. `tool_choice: none`
    // prevents it from calling another tool (which would also hit
    // the `activeWorkers` race check or accidentally re-dispatch).
    //
    // Base on mayorConvo (not the original `messages`) so any
    // data-tool round-trips resolved above stay in context for
    // the wrap-up. Answer EVERY tool_use in the final assistant turn —
    // not just the terminal one we ran: if the Mayor combined a
    // data call with a terminal tool (or hit the data-tool
    // loop cap), a leftover tool_use would otherwise dangle and Anthropic
    // would 400 the wrap-up. The terminal tool gets the real result; any
    // stray data call gets a fresh fetch (re-fetching is acceptable);
    // anything else gets a benign skip note.
    // #1037: a stray draft_issue_report is NOT skipped — the user
    // explicitly asked for that card, so dropping it would silently
    // lose the request. The loop above already created it when a
    // terminal tool rode along, so answer from the memo; resolving
    // here is the fallback for any path that reached phase-2 without
    // passing through it.
    const phase2ToolResults = [];
    for (const tu of mayor1.toolUses) {
      if (tu.id === activeToolCall.id) {
        phase2ToolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: toolResult.toolResultText,
          ...(toolResult.isError ? { is_error: true } : {}),
        });
      } else if (inProcessResults.has(tu.id)) {
        phase2ToolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: inProcessResults.get(tu.id),
        });
      } else if (IN_PROCESS_TOOL_NAMES.has(tu.name)) {
        phase2ToolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: await resolveDataToolResult(tu, repoOwner, repoName, { pool, config, sessionId: session.id }, { pool, appId: session.app_id }),
        });
      } else {
        phase2ToolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Skipped: only one action runs per turn.',
          is_error: true,
        });
      }
    }
    const followUpMessages = [
      ...mayorConvo,
      // Anthropic requires the assistant turn to be the VERBATIM
      // content blocks we got back, including the tool_use block —
      // otherwise the tool_result's tool_use_id doesn't resolve.
      { role: 'assistant', content: mayor1.rawContent },
      { role: 'user', content: phase2ToolResults },
    ];

    // Phase-2 is intentionally NOT abortable — CC has already
    // pushed a commit, opened the PR, and rebuilt staging. Stopping
    // the summary now would just leave the user without context for
    // real-world changes that already exist. The client hides the
    // stop button and shows a plain spinner during this phase.
    setPhase('mayor2');
    // Re-read spec_md and rebuild the system prompt: a scout may
    // have just mutated it, and the wrap-up turn should describe
    // the doc as it is now (not as it was at the start of phase-1).
    currentSpec = await loadSessionSpec(pool, session.id);
    turnHasSpec = !!(currentSpec || '').trim();
    // Recompute PR context: a dispatch this turn may have just opened
    // a PR (applyPrMetadata mutates session.pr_number in place).
    const prContext2 = session.pr_number
      ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
      : null;
    // Same open-proposals block as phase-1 so the wrap-up turn sees a
    // consistent prompt (the instruction is scoped to "before
    // dispatching", so it's inert after a tool has already run).
    // #945: the discussion block IS rebuilt here — the same reason
    // spec_md is re-read. A promote/vote row can't appear mid-turn,
    // but a collaborator posting in the thread while the coding agent
    // ran absolutely can, and the wrap-up should see it.
    discussionBlock = await buildSessionDiscussionBlock(pool, session);
    mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext2, openProposalsBlock, agentFilesBlock, prodDebugEligible, discussionBlock, canDraftIssues);
    const wrapUpOutcome = toolResult.isError
      ? 'failed'
      : (toolKind === 'scout' ? 'spec_done' : 'build_done');
    const fallbackMayor2 = {
      ...snapshotMayorResponse({
        text: staticWrapUpText(wrapUpOutcome, { toolKind }),
      }),
      recoveryFallback: true,
    };
    const invokeMayor2 = async () => wrapUpBillingAvailable
      ? snapshotMayorResponse(await mayorLlm.streamChat({
        messages: followUpMessages,
        systemPrompt: mayorPrompt,
        model: mayorModel,
        // Expose ONLY the quick-reply pills tool (#285) so the wrap-up can
        // suggest next steps but cannot dispatch again — the dispatch tools
        // are simply absent from the list, preserving the original
        // "wrap-up can't dispatch" invariant that toolChoice:none gave us.
        tools: [SUGGEST_REPLIES_TOOL],
        toolChoice: { type: 'auto' },
        onToken: (text) => send('token', { text }),
        apiKey: userApiKey,
        telemetryContext: invocationTelemetry(pool, session, 'mayor_phase_2'),
      }))
      : fallbackMayor2;
    let mayor2;
    let mayor2Disposition = 'executed';
    if (toolResult.turnId) {
      const effect = await turnEffects.runExternalEffectFailClosed({
        pool,
        turnId: toolResult.turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.llm,
        sessionId: session.id,
        run: invokeMayor2,
        fallback: fallbackMayor2,
      });
      mayor2 = effect.value || fallbackMayor2;
      mayor2Disposition = effect.disposition;
      if (effect.disposition === 'fallback') {
        log.warn('sessions', 'Interactive wrap-up provider call failed closed', {
          sessionId: session.id,
          turnId: toolResult.turnId,
          err: effect.error?.message || 'ambiguous pending provider call',
        });
      }
    } else {
      mayor2 = await invokeMayor2();
    }
    // A replay/fallback did not stream in this request. Paint its complete
    // text once; mayor_reasoning below reconciles the final bubble after
    // the durable message insert commits.
    if (mayor2Disposition !== 'executed' && mayor2.text) {
      send('token', { text: mayor2.text });
    }
    if (mayor2Disposition === 'executed') await noteModelFallback(mayor2);

    // Quick-reply pills (#285): the wrap-up reflects the final post-build
    // state, so this is where dispatch turns get their pills. The
    // tool_use is terminal (end of turn) — no tool_result round-trip.
    const quickReplies2 = resolveQuickReplies(mayor2.toolUses);

    let mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
    log.info('sessions', 'Mayor phase-2 response', {
      sessionId: session.id,
      textLen: mayorText2.length,
      stopReason: mayor2.stopReason,
      preview: mayorText2.substring(0, 200),
    });
    if (mayor2.stopReason === 'refusal') {
      // The wrap-up itself was refused end-to-end. The dispatched
      // work already happened — record it and substitute an honest
      // line rather than leaving the build unexplained.
      const refusalCategory2 = (mayor2.stopDetails && mayor2.stopDetails.category) || null;
      if (mayor2Disposition === 'executed') {
        await modelFallback.record(pool, {
          kind: events.EVENT_TYPES.MODEL_REFUSAL,
          userId: req.user.id, appId: session.app_id, sessionId: session.id,
          requested: mayorModel, served: mayor2.servedModel || mayorModel,
          category: refusalCategory2, source: 'mayor',
        });
      }
      if (!mayorText2.trim()) {
        mayorText2 = '_The wrap-up was declined by the model\'s safety classifiers. The dispatched work above still completed; see the status messages for the outcome._';
        send('token', { text: mayorText2 });
      }
    } else if (!mayorText2.trim()) {
      // Cheap guard: we still want to show *something* after the
      // tool runs, even if the Mayor produces no wrap-up text.
      if (toolResult.isError) {
        mayorText2 = toolKind === 'scout'
          ? "_The scout didn't finish successfully. See the status above._"
          : "_The coding agent didn't complete successfully. See the status messages above._";
      } else if (toolKind === 'scout') {
        // Spec/scout just planned something — make the build handoff
        // explicit so a finished spec doesn't read as a finished change.
        mayorText2 = "_Spec updated: it's in the spec viewer. Tell me to build it whenever you're ready and I'll dispatch the coding agent._";
      } else {
        mayorText2 = '_Done._';
      }
      send('token', { text: mayorText2 });
    }
    const servedModel2 = mayor2.servedModel || mayorModel;
    const costCents2 = mayor2.usage
      ? mayorLlm.estimateCostCents(mayor2.usage, servedModel2)
      : 0;
    const tokenCount2 = mayor2.usage
      ? (mayor2.usage.input_tokens || 0) + (mayor2.usage.output_tokens || 0)
      : null;
    // Record the wrap-up call before asking for separate quick-reply
    // generation. The pill ladder's fresh preflight must include this
    // call in the remaining-credit calculation.
    if (costCents2) {
      if (toolResult.turnId && mayorSpendRecorded) {
        await limits.settleTurnSpend(pool, req.user.id, costCents2, {
          turnByok: !!userApiKey,
          turnId: toolResult.turnId,
          sessionId: session.id,
          effectKey: TURN_WRAPUP_EFFECT_KEYS.spend,
        });
      } else {
        await recordMayorSpend(costCents2);
      }
      send('usage', { costCents: costCents2, model: servedModel2, byok: mayorByok() });
    }
    // #1001: the wrap-up is the row the user is left looking at after a
    // build or a spec, so this is where a generic pill set hurt most —
    // and where the tool was skipped most (a plain `end_turn`). Ask the
    // Mayor again for pills naming what actually shipped. A refused
    // wrap-up skips the extra ask: the text is platform-authored there.
    const staticWrapUpResolved = {
      replies: turnPills(wrapUpOutcome),
      source: 'static',
      kind: fallbackKindForTurn({
        outcome: wrapUpOutcome,
        hasPr: session.pr_number != null,
        hasSpec: turnHasSpec,
      }),
    };
    const resolveLiveWrapUpPills = () => resolvePills(wrapUpOutcome, {
        modelPills: quickReplies2,
        model: servedModel2,
        replyText: mayorText2,
        allowModelCalls: mayor2.stopReason !== 'refusal' && !sessionMayor,
        allowGenerate: mayor2.stopReason !== 'refusal' && !sessionMayor,
      });
    let wrapUpResolved;
    if (mayor2.recoveryFallback) {
      wrapUpResolved = staticWrapUpResolved;
    } else if (toolResult.turnId) {
      const pillEffect = await turnEffects.runExternalEffectFailClosed({
        pool,
        turnId: toolResult.turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.pills,
        sessionId: session.id,
        run: resolveLiveWrapUpPills,
        fallback: staticWrapUpResolved,
      });
      wrapUpResolved = pillEffect.value || staticWrapUpResolved;
    } else {
      wrapUpResolved = await resolveLiveWrapUpPills();
    }
    log.info('sessions', 'quick replies resolved', {
      sessionId: session.id, phase: 'wrapup',
      source: wrapUpResolved.source, kind: wrapUpResolved.kind || null,
    });
    const wrapUpPills = wrapUpResolved.replies;
    const wrapUpParams = [
      session.id,
      mayorText2,
      servedModel2,
      tokenCount2,
      costCents2 || null,
      JSON.stringify(quickReplyMeta(wrapUpResolved)),
    ];
    const insertWrapUp = (client) => client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
           VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
      wrapUpParams,
    );
    let messageApplied = true;
    if (toolResult.turnId) {
      const receipt = await turnEffects.runDbEffect({
        pool,
        turnId: toolResult.turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.message,
        sessionId: session.id,
        run: async (client) => {
          await insertWrapUp(client);
          return { persisted: true };
        },
      });
      messageApplied = receipt.applied;
    } else {
      await insertWrapUp(pool);
    }
    if (messageApplied) {
      send('mayor_reasoning', { text: mayorText2 });
      if (wrapUpPills) send('quick_replies', { replies: wrapUpPills });
    }

    if (toolResult.turnId) {
      // The wrap-up message and its spend receipt are both committed. Only
      // now may recovery skip this tail step and only now may the exact
      // owner release the durable turn.
      await worker.noteTailMilestone(
        session.id,
        { wrapUpPosted: true },
        { turnId: toolResult.turnId },
      );
      const cleared = await worker.finishTurn(session.id, { turnId: toolResult.turnId });
      if (!cleared) {
        log.warn('sessions', 'Interactive wrap-up committed; durable cleanup remains pending', {
          sessionId: session.id, turnId: toolResult.turnId,
        });
        await scheduleRetainedInteractiveTurn({
          pool, sessionId: session.id, scheduleInteractiveRecovery,
          assumeRetained: true,
        });
      }
    }
  } catch (err) {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    log.error('sessions', 'Chat error', { message: err.message, stack: err.stack });
    send('error', { error: err.message });
    const recoveringDurableTurn = await scheduleRetainedInteractiveTurn({
      pool, sessionId: session.id, scheduleInteractiveRecovery,
    });
    // #3181: a turn the platform is finishing on its own has not stalled;
    // the recovery sends its own notification when it ends.
    if (recoveringDurableTurn) turnEnd.recovering = true;
    // Persist the failure as a status row so it survives refresh —
    // the 'error' event above is SSE-only and dies with the stream,
    // which used to make a mid-turn provider error (429 rate limit,
    // 529 overload) indistinguishable from a silent turn afterwards.
    // A user-initiated stop is a deliberate end, not a failure — the
    // stop paths persist their own "Stopped" status.
    if (!stopHandle.stopped) {
      const friendly = describeTurnError(err);
      await sendStatus(
        recoveringDurableTurn
          ? `This turn's finalization was interrupted: ${friendly}${/[.!?]$/.test(friendly) ? '' : '.'} The platform is recovering it automatically.`
          : `This turn failed: ${friendly}${/[.!?]$/.test(friendly) ? '' : '.'} Send your message again to retry.`,
        // #894: a failed turn is exactly when the user most wants a
        // one-tap retry, and it never reaches a pill-bearing persist.
        { turnError: true, quickReplies: turnPills('failed') }
      );
    }
  } finally {
    if (releaseDispatchOperation) releaseDispatchOperation();
    // Clear the stop handle for this session only if it's still the
    // one we registered (another turn may have replaced it if the
    // client somehow fired a second POST before this one finished).
    stopRegistry.deleteIf(session.id, stopHandle);
  }

  // #249: covers every turn that reached the main exit without a PR
  // — no-changes turns, scout/spec turns, errored dispatches. PR
  // turns skip it (applyPrMetadata mirrored the title already).
  refreshTitleAtTurnEnd();
  send('done', {});
  res.end();
  // Drop the session-bus ring buffer shortly after completion.
  // Anything a reconnecting client might want to replay has either
  // already been delivered or is now persisted in the DB; keeping
  // the buffer longer just wastes memory on a dead run.
  setTimeout(() => sessionBus.clearSession(session.id), 30000);
}

module.exports = { runMayorTurn, turnStalled };
