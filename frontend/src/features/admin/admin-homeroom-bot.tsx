'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { BenchmarkArea, loadBenchSummary } from './admin-homeroom-bench';
import type { Best, BenchModel } from './admin-homeroom-bench';
import { RolloutHealth } from './admin-homeroom-bot-health';
import type { ChatFailure, Incidents, RolloutHealthData } from './admin-homeroom-bot-health';

// Homeroom bot (#admin/homeroom-bot) — #2684, and laid out again in #3710.
//
// The bot reads each open request with the app's repository open and decides
// what it would do: ask one question, build it, hand it to a person, or say
// there is nothing to build, and it acts on that on every app but a PAUSED
// one: it posts, asks, specs and builds proposals for the group to vote on.
// An admin rates its verdicts here. Older runs were made in shadow (recorded,
// never acted on) while it was tried out, and keep that label. services/homeroom-bot.js has the full reasoning; routes/admin.js
// the endpoints.
//
// Three tabs, each with an address of its own (#admin/homeroom-bot,
// /settings, /benchmark), replaced rather than pushed so they never re-route
// the console:
//
//   Overview   is it on, is it healthy, what is it doing (running now, the
//              queue, spend, agreement), and the verdicts to rate.
//   Settings   ONE form, grouped by decision: on or off and the budgets,
//              where it works (one row per app: Live or Paused), the model
//              per stage (picked from the benchmark's catalog, with each
//              model's latest result there), its DMs, side builds, and the
//              tuning knobs folded away. Nothing
//              saves until "Save changes", one request for the whole form
//              (the route validates the whole patch before it writes any of
//              it). It used to save three ways: on change, on blur and on a
//              Save button per field, and nothing said which.
//   Benchmark  admin-homeroom-bench.tsx, with places of its own below this
//              tab's address (/benchmark/runs, /benchmark/runs/<id>,
//              /benchmark/suites[/<id>], /benchmark/studio), which it writes while it is the tab
//              on screen. Its "Use for <stage>" fills in the model here and
//              switches to Settings; Save is still pressed by a person. It
//              reads the model each stage runs on now from this section's
//              own data rather than asking for it again.
//
// The Overview and Settings panels are both rendered and the one not shown
// is `hidden`, so an edit survives a look at the Overview; the Benchmark is
// rendered from its first visit, since it reads its own data.
//
// PERMISSIONS: visible to any admin; the form, the "run now" box, the
// ratings and the CSV export are gated on AdminConsole.canWrite(), and the
// server enforces the same with requireAdminWrite on everything that is not
// the page read. The export is a write-gated READ — routes/admin.js says why
// a bulk download sits with the mutations rather than the screen.

interface Settings {
  mode: 'off' | 'shadow' | 'live';
  batchSize: number;
  // The apps it leaves alone. It acts for real on every other one.
  pausedApps: string[];
  turnSeconds: number;
  turnInputTokens: number;
  // How many shadow builds run at once (the build lane), and whether side
  // builds are made on the platform's own repository (laterSideSkipReason).
  // Both are named for the shadow builds. The benchmark's trials and side
  // builds wait for `liveAtOnce` instead (isLiveLaneSaturated): this one
  // held them back until 9 Oct 2026, behind any two live builds.
  buildConcurrency: number;
  shadowBuildPlatform: boolean;
  // #3624: what each person's requests may cost the platform in a week
  // (cents; 0 for no limit).
  userWeeklyCents: number;
  // #3654: the model each stage runs on; blank is the platform default.
  models?: Record<ModelStage, string>;
  // #3624 stage 2: live work at once across the platform and per person,
  // and whether a DM to the bot is read by its model.
  liveAtOnce: number;
  perPerson: number;
  dmChat: boolean;
  // Whether reading a request again continues the conversation that read it
  // last, rather than starting from the repository again.
  continueReads?: boolean;
  // #4449: whether a first version's members can watch it take shape (Live).
  liveBuildStream?: boolean;
  // When it went on for everyone: older requests nobody has touched since
  // are left alone.
  everyoneSince?: string | null;
  // The most proposals the bot keeps up for a vote at once; 0 is automatic.
  proposalCeiling?: number;
}

// #3624 stage 2: one piece of work running now.
interface Working {
  appSlug: string;
  appName: string;
  issueNumber: number;
  since: string;
  lane: 'live' | 'background';
  // A request being read (a claimed queue row) or a change being built
  // (a live run with its build session; homeroom-bot.js buildsNow).
  kind?: 'read' | 'build';
  person: string | null;
}

// #3624 stage 2: the bot's answers in DMs this week.
interface DmChat {
  turns: number;
  failed: number;
  people: number;
  costUsd: number;
  recentFailures?: ChatFailure[];
}

// #3654: the stages that each run on a model of their own. `followup` is
// both kinds of follow-up turn: replies, and the proposal's failing checks.
type ModelStage = 'triage' | 'spec' | 'build' | 'followup';
const MODEL_STAGES: { key: ModelStage; label: string }[] = [
  { key: 'triage', label: 'Triage' },
  { key: 'spec', label: 'Plan' },
  { key: 'build', label: 'Build' },
  { key: 'followup', label: 'Follow-ups and check fixes' },
];
// The server's own rule (MODEL_ID_RE in services/homeroom-bot.js).
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/i;

interface Bot {
  id: number;
  username: string;
  weeklyLimitCents: number;
  weeklySpentCents: number;
  hasIncludedKey: boolean;
  model: string | null;
  // #3654: what each stage runs on now, the default filled in.
  models?: Record<ModelStage, string | null>;
}

interface Totals {
  days: number;
  runs: number;
  questions: number;
  ready: number;
  person: number;
  failed: number;
  budgetStopped: number;
  rated: number;
  agreed: number;
  suppressed: number;
  costUsd: number;
}

interface QueueItem {
  id: number;
  issue_number: number;
  priority: number;
  reason: string;
  enqueued_at: string;
  started_at: string | null;
  app_slug: string;
  app_name: string;
}

interface Run {
  id: number;
  issue_number: number;
  mode: string;
  // #3264: 'answer' and 'revise' are follow-ups on the bot's own proposal.
  verdict: 'question' | 'ready' | 'person' | 'empty' | 'failed' | 'answer' | 'revise';
  determined: boolean | null;
  missing_fact: string | null;
  question: string | null;
  question_default: string | null;
  build_note: string | null;
  reason: string | null;
  cap_suppressed: string | null;
  budget_stop: string | null;
  rating: 'yes' | 'no' | null;
  rating_note: string | null;
  rated_at: string | null;
  rated_by: string | null;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  // #3146: the proposal a live `ready` run opened.
  proposal_session_id: number | null;
  build_ok: boolean | null;
  build_branch: string | null;
  build_sha: string | null;
  build_commits: number | null;
  build_error: string | null;
  build_cost_usd: number | null;
  build_at: string | null;
  build_queued_at: string | null;
  // The spec the bot wrote before building, live or shadow.
  build_spec_md: string | null;
  // A build turn that changed nothing, and its nudge (NoChangeNote).
  build_no_change?: NoChange | null;
  // #3654: the verdict a labeller says was right, the build's model, and the
  // stages this run can be replayed at by the benchmark.
  label_verdict?: LabelVerdict | null;
  dm_answered_at?: string | null;
  build_model?: string | null;
  replayStages?: string[];
  buildUrl: string | null;
  app_slug: string;
  app_name: string;
  issueUrl: string | null;
}

/** One build turn of a build that changed nothing (homeroom-bot-live.js turnFacts), and what it said last. */
interface NoChangeTurn {
  turn: 'build' | 'nudge';
  ended?: string | null;
  said?: string | null;
  provider?: string | null;
  providers?: string[] | null;
  model?: string | null;
  requests?: number | null;
  toolCalls?: number | null;
  fileEdits?: number | null;
  outputTokens?: number | null;
  seconds?: number | null;
}

interface NoChange {
  turns?: NoChangeTurn[];
  nudged?: boolean;
  notNudged?: string | null;
  committed?: boolean | null;
  recovered?: boolean;
}

type LabelVerdict = 'question' | 'ready' | 'person' | 'empty' | 'answer' | 'revise';
const LABEL_VERDICTS: LabelVerdict[] = ['question', 'ready', 'person', 'empty', 'answer', 'revise'];

interface Refusal {
  app: string;
  error: string;
  retryInMs?: number;
}

interface LastPass {
  at: string;
  mode: string | null;
  busy: boolean;
  refreshed: boolean;
  processed?: number;
  // #3624 stage 2: a pass starts work and does not wait for it.
  dispatched?: number;
  inFlight?: number;
  paused: string | null;
  detail?: string | null;
  // How long the bot waits before trying again after a platform fault (#3122).
  retryInMs?: number | null;
  refusals?: Refusal[];
}

/** When a paused pass will try again, from the pass time and its backoff. */
function retryAt(loop: LastPass): string {
  if (!loop.retryInMs) return '';
  const at = Date.parse(loop.at);
  if (Number.isNaN(at)) return '';
  return when(new Date(at + loop.retryInMs).toISOString());
}

interface Payload {
  settings: Settings;
  modes: string[];
  defaultModel?: string | null;
  bot: Bot | null;
  loop: LastPass | null;
  totals: Totals;
  // `buildsWaiting`: live builds waiting their turn, which wait on their
  // runs rather than in the queue.
  queue: { depth: number; items: QueueItem[]; buildsWaiting?: number };
  runs: Run[];
  apps: { slug: string; name: string }[];
  caps: { proposalsPerApp: number; proposalsTotal: number; questionsPerAppPerDay: number };
  mentionOptOuts: { total: number; items: MentionOptOut[] };
  workingNow?: Working[];
  dmChat?: DmChat;
  health?: RolloutHealthData;
  incidents?: Incidents | null;
  // The configurations' pairs waiting for a pick, per scope (bot-configs.js
  // pairsWaitingByScope); null when they could not be counted.
  pairsWaiting?: PairsWaiting | null;
}

interface PairsWaiting { first_version?: number; later?: number }

// Somebody who asked the bot to stop tagging them on one issue.
interface MentionOptOut {
  app_slug: string;
  app_name: string;
  issue_number: number;
  username: string;
  created_at: string;
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

function money(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(Number(usd))) return '–';
  return `$${Number(usd).toFixed(2)}`;
}

function dollarsFromCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(Number(cents))) return '–';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const VERDICT_LABEL: Record<Run['verdict'], string> = {
  question: 'Needs a question',
  ready: 'Ready to build',
  person: 'Needs a person',
  empty: 'Nothing to build',
  failed: 'Failed',
  answer: 'Answered',
  revise: 'Revised its proposal',
};

const VERDICT_BADGE: Record<Run['verdict'], string> = {
  question: AdminUI.badge.warn,
  ready: AdminUI.badge.success,
  person: AdminUI.badge.secondary,
  empty: AdminUI.badge.outline,
  failed: AdminUI.badge.destructive,
  answer: AdminUI.badge.secondary,
  revise: AdminUI.badge.success,
};

/** #3264: a run that followed up on a proposal the bot had already opened. */
function isFollowUp(run: Run): boolean {
  return !!run.proposal_session_id && run.verdict !== 'ready';
}

function ProposalLink({ run, children }: { run: Run; children: string }) {
  return (
    <a className={AdminUI.btn.link} href={`#app/${encodeURIComponent(run.app_slug)}/dev/proposals/${Number(run.proposal_session_id)}`}>
      {children}
    </a>
  );
}

const CAP_LABEL: Record<string, string> = {
  proposals_per_app: 'would be held: 5 bot proposals already open on this app',
  proposals_total: 'would be held: the bot is at its ceiling of proposals open across Homeroom',
  question_tripwire: 'would be held: question tripwire for this app tripped today',
};

/**
 * A shadow build of a ready verdict: the branch it left on the app's
 * repository, for a spot check, or why there is none. The compare address
 * is text to copy, not a link: it is built from the app's repo_url, and the
 * console never renders an API-supplied URL as an anchor.
 */
function ShadowBuild({ run }: { run: Run }) {
  if (run.build_ok == null) {
    if (run.build_at) {
      return <p className={AdminUI.muted} data-shadow-build="building">{`Shadow build under way since ${when(run.build_at)}.`}</p>;
    }
    if (run.build_queued_at) {
      return <p className={AdminUI.muted} data-shadow-build="queued">{`Shadow build queued ${when(run.build_queued_at)}.`}</p>;
    }
    // Skipped (the issue closed, the app went live) or replaced by a later
    // verdict: the reason is kept, and there is no branch.
    if (run.build_error) {
      return <p className={`${AdminUI.muted} break-words`} data-shadow-build="skipped">{`Not shadow built: ${run.build_error.replace(/^(skipped|superseded): /, '')}.`}</p>;
    }
    return null;
  }
  if (!run.build_ok) {
    return (
      <p className={`${AdminUI.muted} break-words`} data-shadow-build="failed">
        {`Shadow build did not produce a change: ${run.build_error || 'no reason recorded'}.`}
      </p>
    );
  }
  const parts = [
    `Shadow build on ${run.build_branch}`,
    run.build_commits != null ? `${run.build_commits} commit${run.build_commits === 1 ? '' : 's'}` : null,
    run.build_sha ? `at ${String(run.build_sha).slice(0, 7)}` : null,
    run.build_cost_usd != null ? money(run.build_cost_usd) : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5" data-shadow-build="built">
      <p className={AdminUI.muted}>{`${parts.join(', ')}. Not proposed, not posted.`}</p>
      {run.buildUrl ? <p className={`${AdminUI.muted} break-all select-all`}>{run.buildUrl}</p> : null}
    </div>
  );
}

/**
 * What a live build came to (#3509), recorded on the run in the columns a
 * shadow build fills. A build that became a proposal is said by the
 * proposal link below; this says what else is worth knowing: what it pushed,
 * why it did not become a proposal, or why it worked without a spec.
 */
function LiveBuild({ run }: { run: Run }) {
  if (run.build_ok == null) return null;
  if (!run.build_ok) {
    const why = run.build_error || 'no reason recorded';
    // WP1: a build that was not needed (its request already had a proposal,
    // or was closed) stopped; it did not fail.
    if (why.startsWith('skipped: ')) {
      return (
        <p className={`${AdminUI.muted} break-words`} data-live-build="skipped">
          {`Live build stopped, not needed: ${why.slice('skipped: '.length)}.`}
        </p>
      );
    }
    return (
      <p className={`${AdminUI.muted} break-words`} data-live-build={why.startsWith('blocked: ') ? 'blocked' : 'failed'}>
        {why.startsWith('blocked: ')
          ? `Building showed it cannot be done as asked: ${why.slice('blocked: '.length)}.`
          : `Live build did not become a proposal: ${why}.`}
      </p>
    );
  }
  const parts = [
    run.build_branch ? `Built on ${run.build_branch}` : 'Built',
    run.build_commits != null ? `${run.build_commits} commit${run.build_commits === 1 ? '' : 's'}` : null,
    run.build_sha ? `at ${String(run.build_sha).slice(0, 7)}` : null,
    run.build_cost_usd != null ? money(run.build_cost_usd) : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5" data-live-build="built">
      <p className={AdminUI.muted}>{`${parts.join(', ')}.`}</p>
      {run.build_error ? <p className={`${AdminUI.muted} break-words`}>{run.build_error}</p> : null}
    </div>
  );
}

// How each build turn ended, in words (homeroom-bot-live.js turnFacts).
const TURN_ENDED: Record<string, string> = {
  changed: 'built the change',
  no_change: 'changed nothing',
  not_pushed: 'pushed nothing',
  stopped: 'was stopped on its clock',
  failed: 'failed',
};

/** One build turn's facts as a line: how it ended, who served it, what it did. */
function noChangeTurnLine(t: NoChangeTurn): string {
  const count = (n: number | null | undefined, one: string, many: string) => (
    n == null ? null : `${n} ${n === 1 ? one : many}`
  );
  const providers = Array.isArray(t.providers) && t.providers.length ? t.providers : (t.provider ? [t.provider] : []);
  const parts = [
    providers.length ? `served by ${providers.join(', ')}` : 'provider unknown',
    count(t.requests, 'request', 'requests'),
    count(t.toolCalls, 'tool call', 'tool calls'),
    count(t.fileEdits, 'file edit', 'file edits'),
    count(t.outputTokens, 'output token', 'output tokens'),
    t.seconds == null ? null : `${t.seconds}s`,
  ].filter(Boolean);
  const ended = t.ended && TURN_ENDED[t.ended] ? ` ${TURN_ENDED[t.ended]}` : '';
  return `${t.turn === 'nudge' ? 'The nudge' : 'The build turn'}${ended}: ${parts.join(', ')}.`;
}

/**
 * A build turn that ended without failing and changed nothing
 * (homeroom-bot-live.js buildNudgePrompt): whether it was nudged and what
 * came of it, what each turn did and which provider served it, and what the
 * agent said last. The agent's words are untrusted: shown as plain text,
 * never as a link or markup.
 */
function NoChangeNote({ run }: { run: Run }) {
  const nc = run.build_no_change;
  if (!nc || !Array.isArray(nc.turns) || !nc.turns.length) return null;
  const head = !nc.nudged
    ? `Its build turn changed nothing, and it was not nudged${nc.notNudged ? ` (${nc.notNudged})` : ''}.`
    : nc.committed
      ? 'Its build turn changed nothing, so it was nudged once, and the nudge built the change.'
      : 'Its build turn changed nothing, so it was nudged once, and the nudge did not build it either.';
  return (
    <div className="space-y-0.5" data-build-no-change={nc.nudged ? (nc.committed ? 'nudged-built' : 'nudged-failed') : 'not-nudged'}>
      <p className={AdminUI.muted}>{head}</p>
      {nc.turns.map((t, i) => (
        <div key={i}>
          <p className={AdminUI.muted}>{noChangeTurnLine(t)}</p>
          {t.said ? <p className={`${AdminUI.muted} whitespace-pre-line break-words`}>{`It said: ${t.said}`}</p> : null}
        </div>
      ))}
    </div>
  );
}

/** A question's "user_facing: why" as words. */
function blockerLabel(reason: string): string {
  const [kind, ...rest] = reason.split(': ');
  const why = rest.join(': ');
  if (kind === 'user_facing') return `it changes what people see, and the default could be the wrong build. ${why}`;
  if (kind === 'impossible') return `it may not be buildable as asked. ${why}`;
  return reason;
}

/**
 * The spec the bot wrote just before it built, folded away: on a live app it
 * was also posted on the issue and the proposal, on a shadow one it was
 * shown to nobody. Plain text, as the rest of this table is.
 */
function BuildSpec({ run }: { run: Run }) {
  if (!run.build_spec_md) return null;
  return (
    <details className="text-sm" data-build-spec>
      <summary className={`${AdminUI.muted} cursor-pointer`}>The plan it built from</summary>
      <p className="mt-1 whitespace-pre-wrap break-words">{run.build_spec_md}</p>
    </details>
  );
}

/** What the bot would have posted, as one block of plain text per verdict. */
function VerdictBody({ run }: { run: Run }) {
  if (run.verdict === 'question') {
    return (
      <div className="space-y-1">
        <p className="text-sm">{run.question || '(no question text)'}</p>
        {run.question_default ? (
          <p className={AdminUI.muted}>Suggested default: {run.question_default}</p>
        ) : null}
        {run.reason ? (
          <p className={AdminUI.muted} data-question-blocker>{`Why it is a blocker: ${blockerLabel(run.reason)}`}</p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'ready') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.build_note || '(no build note)'}</p>
        {run.reason ? <p className={AdminUI.muted} data-demoted-question>{run.reason}</p> : null}
        {run.mode === 'live' ? <LiveBuild run={run} /> : <ShadowBuild run={run} />}
        <NoChangeNote run={run} />
        <BuildSpec run={run} />
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Built and '}
            <a className={AdminUI.btn.link} href={`#app/${encodeURIComponent(run.app_slug)}/dev/proposals/${Number(run.proposal_session_id)}`}>
              opened as a proposal
            </a>
            .
          </p>
        ) : null}
      </div>
    );
  }
  // #3264: what it answered on its own proposal, and what it changed there.
  if (run.verdict === 'answer') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.reason || '(no reply recorded)'}</p>
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Replied about '}
            <ProposalLink run={run}>its proposal</ProposalLink>
            .
          </p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'revise') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.build_note || run.reason || '(no summary recorded)'}</p>
        {run.build_note && run.reason ? <p className={`${AdminUI.muted} whitespace-pre-line`}>{run.reason}</p> : null}
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Pushed to '}
            <ProposalLink run={run}>its proposal</ProposalLink>
            {', which cleared its votes and re-ran its checks.'}
          </p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'person') {
    return <p className="text-sm">{run.reason || '(no reason given)'}</p>;
  }
  // A verdict, not a failure (#3144): the bot found nothing to build and says
  // why. Without its own branch it fell through to the red failure line below.
  if (run.verdict === 'empty') {
    return <p className="text-sm">{run.reason || '(no reason given)'}</p>;
  }
  if (run.budget_stop) {
    return (
      <div className="space-y-1">
        <p className="text-sm">
          {`The bot stopped this turn itself: it ran past the ${run.budget_stop} limit before reaching a verdict.`}
        </p>
        <p className={AdminUI.muted}>
          It goes back to the end of the queue once. A second stop lets the issue go, rather than retrying it forever.
        </p>
        <p className={AdminUI.muted}>
          Its cost counts the model requests that finished before the stop. The one still running when it was
          stopped never reports what it used, so the real cost is a little higher.
        </p>
      </div>
    );
  }
  return <p className="text-sm text-red-400 break-words">{run.error || 'The run failed before it produced a verdict.'}</p>;
}

/** The build lane in one line: what is waiting, running, done, and why it idles. */
/**
 * #3654: the labeller's half of a rating: the verdict that was right, and a
 * note. Saved together and only on Save, so a Yes/No tap in the table never
 * touches them (the server changes only the fields a request carries).
 */
function RunLabel({ run, canWrite, busy, onSave }: {
  run: Run;
  canWrite: boolean;
  busy: boolean;
  onSave: (labelVerdict: LabelVerdict | null, note: string | null) => void;
}) {
  const [verdict, setVerdict] = useState<string>(run.label_verdict || '');
  const [note, setNote] = useState<string>(run.rating_note || '');
  const dirty = verdict !== (run.label_verdict || '') || note !== (run.rating_note || '');
  if (!canWrite) {
    return run.label_verdict
      ? <p className={AdminUI.muted} data-label-verdict={run.label_verdict}>{`Right verdict, per its labeller: ${VERDICT_LABEL[run.label_verdict]}`}</p>
      : null;
  }
  return (
    <div className="flex flex-wrap items-end gap-2" data-run-label={run.id}>
      <div>
        <label className={AdminUI.label} htmlFor={`admin-homeroom-bot-label-${run.id}`}>Right verdict</label>
        <select
          id={`admin-homeroom-bot-label-${run.id}`}
          className={`${AdminUI.select} mt-1`}
          value={verdict}
          onChange={(e) => setVerdict(e.target.value)}
        >
          <option value="">Not labelled</option>
          {LABEL_VERDICTS.map((v) => <option key={v} value={v}>{VERDICT_LABEL[v]}</option>)}
        </select>
      </div>
      <div className="flex-1 min-w-[12rem]">
        <label className={AdminUI.label} htmlFor={`admin-homeroom-bot-note-${run.id}`}>Note</label>
        <input
          id={`admin-homeroom-bot-note-${run.id}`}
          className={`${AdminUI.input} mt-1`}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button
        type="button" className={AdminUI.btn.primarySm}
        disabled={busy || !dirty}
        onClick={() => onSave((verdict || null) as LabelVerdict | null, note.trim() ? note.trim() : null)}
      >Save label</button>
    </div>
  );
}

// #3654: the benchmark stages a run can become a task at, from the
// snapshots it recorded (services/bench/suites.js SNAPSHOT_STAGE).
function benchStagesFor(run: Run): string[] {
  const have = new Set(run.replayStages || []);
  const out: string[] = [];
  if (have.has('triage')) out.push('triage');
  if (have.has('triage') && run.verdict === 'question' && run.dm_answered_at) out.push('dm');
  if (have.has('build')) out.push('build', 'spec');
  if (have.has('followup')) out.push('followup');
  if (have.has('checks_fix')) out.push('checks_fix');
  return out;
}

interface SuiteOption { id: number; name: string; version: number; frozen_at: string | null }

/**
 * #3654: "Add to a benchmark suite" on a run row. Only a run that recorded
 * a snapshot can be replayed, so a run from before snapshots says so instead.
 * The suites are read when the row first asks for them.
 */
function AddToSuite({ run, busy }: { run: Run; busy: boolean }) {
  const stages = benchStagesFor(run);
  const [suitesList, setSuites] = useState<SuiteOption[] | null>(null);
  const [suiteId, setSuiteId] = useState('');
  const [stage, setStage] = useState(stages[0] || '');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!stages.length) return undefined;
    let alive = true;
    fetch('/api/admin/homeroom-bot/bench/suites')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const open = (d.suites || []).filter((x: SuiteOption) => !x.frozen_at);
        setSuites(open);
        if (open[0]) setSuiteId(String(open[0].id));
      })
      .catch(() => { if (alive) setSuites([]); });
    return () => { alive = false; };
  }, [run.id]);
  if (!stages.length) {
    return <p className={AdminUI.muted} data-bench-add="unavailable">Not replayable: this run recorded no snapshot, so it cannot become a benchmark task.</p>;
  }
  const add = async () => {
    setNote('');
    const res = await fetch(`/api/admin/homeroom-bot/bench/suites/${suiteId}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id, stage }),
    });
    const data = await res.json().catch(() => ({}));
    setNote(res.ok && data.added?.length ? 'Added to the suite.' : `Not added: ${data.error || data.refused?.[0]?.error || `HTTP ${res.status}`}`);
  };
  return (
    <div className="flex flex-wrap items-end gap-2" data-bench-add={run.id}>
      <div>
        <label className={AdminUI.label} htmlFor={`admin-homeroom-bot-bench-suite-${run.id}`}>Benchmark suite</label>
        <select
          id={`admin-homeroom-bot-bench-suite-${run.id}`} className={`${AdminUI.select} mt-1`}
          value={suiteId} onChange={(e) => setSuiteId(e.target.value)} disabled={!suitesList?.length}
        >
          {suitesList == null ? <option value="">{'Loading…'}</option> : null}
          {suitesList && !suitesList.length ? <option value="">No open suite: make one under Benchmark</option> : null}
          {(suitesList || []).map((x) => <option key={x.id} value={x.id}>{`${x.name} v${x.version}`}</option>)}
        </select>
      </div>
      <div>
        <label className={AdminUI.label} htmlFor={`admin-homeroom-bot-bench-stage-${run.id}`}>As a</label>
        <select
          id={`admin-homeroom-bot-bench-stage-${run.id}`} className={`${AdminUI.select} mt-1`}
          value={stage} onChange={(e) => setStage(e.target.value)}
        >
          {stages.map((st) => <option key={st} value={st}>{`${st.replace('_', ' ')} task`}</option>)}
        </select>
      </div>
      <button type="button" className={AdminUI.btn.outlineSm} disabled={busy || !suiteId} onClick={add}>Add to suite</button>
      {note ? <span className={AdminUI.muted}>{note}</span> : null}
    </div>
  );
}

/** Under Running now: who the work is for, or just that it is live. Pure. */
export function workingFor(items: Working[]): string {
  const builds = items.filter((w) => w.kind === 'build').length;
  return countsLine([[items.length - builds, 'reading'], [builds, 'building']]);
}

/** Under Waiting in the queue: requests to read and builds to start. Pure. */
export function waitingFor(depth: number, buildsWaiting: number): string {
  return countsLine([[depth, 'to read'], [buildsWaiting, 'to build']]);
}

/**
 * Under the totals: the configurations' pairs waiting for a pick, per scope,
 * and where they are picked, since nothing else says they wait. Empty when
 * none does. Pure.
 */
export function pairsWaitingLine(waiting: PairsWaiting | null | undefined): string {
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);
  const parts: [number, string][] = [[n(waiting?.first_version), 'first-version'], [n(waiting?.later), 'later-change']];
  const shown = parts.filter(([k]) => k > 0);
  if (!shown.length) return '';
  const total = shown.reduce((sum, [k]) => sum + k, 0);
  const list = shown.map(([k, what]) => `${k} ${what} pair${k === 1 ? '' : 's'}`).join(' and ');
  return `Bot configurations: ${list} ${total === 1 ? 'waits' : 'wait'} for a pick. Pairs are picked through the Homeroom connector: list_bot_configs, then get_bot_config_pair.`;
}

/** "2 reading, 3 building", leaving a zero out; empty when all are. Pure. */
function countsLine(parts: [number, string][]): string {
  return parts.filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`).join(', ');
}

/** One whole-number field of the Settings form. */
function NumberField({ id, label, value, min, max, canWrite, onChange, children }: {
  id: string; label: string; value: string; min: number; max: number; canWrite: boolean;
  onChange: (value: string) => void; children?: ReactNode;
}) {
  return (
    <div>
      <label className={AdminUI.label} htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number" min={min} max={max} step="1"
        className={`${AdminUI.input} mt-1`}
        value={value}
        disabled={!canWrite}
        onChange={(e) => onChange(e.target.value)}
      />
      {children}
    </div>
  );
}

/** What runs now, one line each: the app, the request, who it is for, since when. */
function WorkingNow({ items }: { items: Working[] }) {
  if (!items.length) {
    return <p className={AdminUI.muted} id="admin-homeroom-bot-working-none">Nothing is running right now.</p>;
  }
  return (
    <ul className="text-sm space-y-1" id="admin-homeroom-bot-working">
      {items.map((w) => (
        <li key={`${w.kind || 'read'}:${w.appSlug}#${w.issueNumber}`} className="flex flex-wrap items-center gap-2" data-working={`${w.appSlug}#${w.issueNumber}`}>
          <span className={w.lane === 'live' ? AdminUI.badge.success : AdminUI.badge.default}>
            {w.lane !== 'live' ? 'background' : w.kind === 'build' ? 'building' : 'reading'}
          </span>
          <span>{`${w.appName} #${w.issueNumber}`}</span>
          {w.person ? <span className={AdminUI.muted}>{`for @${w.person}`}</span> : null}
          <span className={AdminUI.muted}>{`since ${when(w.since)}`}</span>
        </li>
      ))}
    </ul>
  );
}

// #3710: what the bot does on one app, as a person decides it: it acts for
// real on every app but the paused ones (homeroom_bot_paused_apps).
type AppMode = 'live' | 'paused';
const APP_MODES: { key: AppMode; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'paused', label: 'Paused' },
];

/** An app's mode from the paused list. Pure. */
export function appMode(slug: string, paused: string[]): AppMode {
  return paused.includes(slug) ? 'paused' : 'live';
}

/** The paused list after one app is set to `mode`. Pure. */
export function withAppMode(slug: string, mode: AppMode, paused: string[]): string[] {
  const next = paused.filter((s) => s !== slug);
  if (mode === 'paused') next.push(slug);
  return next;
}

/**
 * Where the bot works: one row per app, Live or Paused, with the paused
 * apps (and any row changed but not saved) first and the rest folded behind
 * a toggle. A saved app that is not paused has "Triage again", which queues
 * every open issue on it (#3480): the route refuses a paused app anyway.
 */
export function AppModes({ apps, paused, savedPaused, canWrite, onChange, onRetriage }: {
  apps: { slug: string; name: string }[];
  paused: string[]; savedPaused: string[];
  canWrite: boolean;
  onChange: (paused: string[]) => void;
  onRetriage: (slug: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const names = new Map(apps.map((a) => [a.slug, a.name]));
  const slugs = [...new Set([...apps.map((a) => a.slug), ...paused, ...savedPaused])];
  const byName = (a: string, b: string) => (names.get(a) || a).localeCompare(names.get(b) || b);
  const notable = slugs.filter((s) => appMode(s, paused) !== 'live' || appMode(s, savedPaused) !== 'live').sort(byName);
  const rest = slugs.filter((s) => !notable.includes(s)).sort(byName);
  const shown = showAll ? [...notable, ...rest] : notable;
  return (
    <div id="admin-homeroom-bot-live-apps" role="group" aria-labelledby="admin-homeroom-bot-live-apps-label" className="space-y-1">
      {shown.map((slug) => {
        const m = appMode(slug, paused);
        const changed = m !== appMode(slug, savedPaused);
        return (
          <div key={slug} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-zinc-100 dark:border-zinc-800/60" data-app-mode={slug} data-mode={m}>
            <span className="text-sm font-medium w-full sm:w-64 shrink-0">
              {names.get(slug) || `${slug} (not running)`}
            </span>
            <span className="inline-flex gap-1" role="radiogroup" aria-label={`What the bot does on ${names.get(slug) || slug}`}>
              {APP_MODES.map((o) => (
                <button
                  key={o.key} type="button" role="radio" aria-checked={m === o.key}
                  data-app-mode-choice={`${slug}:${o.key}`}
                  className={m === o.key ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
                  disabled={!canWrite}
                  onClick={() => onChange(withAppMode(slug, o.key, paused))}
                >{o.label}</button>
              ))}
            </span>
            {changed ? <span className={AdminUI.badge.warn}>not saved</span> : null}
            {canWrite && !savedPaused.includes(slug) ? (
              <button
                type="button"
                className={AdminUI.btn.outlineSm}
                data-live-app-retriage={slug}
                title="Every open issue on this app, as if just posted: the bot takes them one at a time, oldest first."
                onClick={() => onRetriage(slug)}
              >
                Triage again
              </button>
            ) : null}
          </div>
        );
      })}
      {!notable.length && !showAll ? (
        <p className={AdminUI.muted} id="admin-homeroom-bot-live-apps-none">No app is paused: it is live on all of them.</p>
      ) : null}
      {rest.length ? (
        <button type="button" className={`${AdminUI.btn.link} text-sm mt-2`} id="admin-homeroom-bot-live-apps-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show only the paused apps' : `Show the ${rest.length} live app${rest.length === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}

// The benchmark stage whose result describes a bot stage's model. A bot
// follow-up is benchmarked as a follow-up and as a checks fix; the first one
// with a graded result is shown.
const BENCH_STAGES_FOR: Record<ModelStage, string[]> = {
  triage: ['triage'], spec: ['spec'], build: ['build'], followup: ['followup', 'checks_fix'],
};

/** The model's latest benchmark result at this stage, in words, or ''. */
export function benchHint(best: Best | null, stage: ModelStage, modelId: string | null): string {
  if (!best || !modelId) return '';
  for (const st of BENCH_STAGES_FOR[stage]) {
    const c = best.cells[`${st}|${modelId}`];
    if (!c || !c.graded) continue;
    const enough = c.graded >= Number((best.enough as Record<string, number>)[st] || 0);
    const parts = [`${Math.round((c.accuracy || 0) * 100)}% of ${c.graded} graded`];
    if (c.costPerSuccess != null) parts.push(`$${c.costPerSuccess.toFixed(3)} a success`);
    const isBest = (best.best as Record<string, string>)[st] === `${st}|${modelId}`;
    return `Benchmark${st !== stage ? ` (${st.replace('_', ' ')})` : ''}: ${parts.join(', ')}${enough ? '' : ', too few to compare'}${isBest ? ', the best value' : ''}.`;
  }
  return 'Not benchmarked at this stage yet.';
}

/**
 * One stage's model: the platform default, a model from the benchmark's
 * catalog (with its price), or any other OpenRouter id typed in.
 */
function ModelPicker({ stage, label, value, defaultModel, models, best, canWrite, onChange }: {
  stage: ModelStage; label: string; value: string; defaultModel: string | null;
  models: BenchModel[] | null; best: Best | null; canWrite: boolean; onChange: (id: string) => void;
}) {
  const listed = !value || (models || []).some((m) => m.id === value);
  const [typing, setTyping] = useState(!listed);
  const other = typing || !listed;
  const nameOf = (id: string) => (models || []).find((m) => m.id === id)?.label || id;
  const price = (m: BenchModel) => (m.inputPerMillion != null && m.outputPerMillion != null
    ? ` · $${m.inputPerMillion.toFixed(2)} / $${m.outputPerMillion.toFixed(2)}` : '');
  return (
    <div data-model-stage={stage}>
      <label className={AdminUI.label} htmlFor={`admin-homeroom-bot-model-${stage}`}>{label}</label>
      <select
        id={`admin-homeroom-bot-model-${stage}`}
        className={`${AdminUI.select} mt-1`}
        value={other ? '__other' : value}
        disabled={!canWrite}
        onChange={(e) => {
          if (e.target.value === '__other') { setTyping(true); return; }
          setTyping(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{`Platform default${defaultModel ? ` (${nameOf(defaultModel)})` : ''}`}</option>
        {(models || []).map((m) => <option key={m.id} value={m.id}>{`${m.label}${price(m)}`}</option>)}
        <option value="__other">Another OpenRouter model…</option>
      </select>
      {other ? (
        <input
          id={`admin-homeroom-bot-model-${stage}-other`}
          className={`${AdminUI.input} mt-1`}
          value={value}
          placeholder="vendor/model"
          spellCheck={false}
          disabled={!canWrite}
          aria-label={`${label}: OpenRouter model id`}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      ) : null}
      <p className={`${AdminUI.muted} mt-1`} data-model-hint={stage}>{benchHint(best, stage, value || defaultModel)}</p>
    </div>
  );
}

// ── The Settings form ────────────────────────────────────────────────────

/** Every setting as the form edits it: numbers as the text in their field, dollars as dollars. */
interface Form {
  mode: 'off' | 'shadow';
  pausedApps: string[];
  models: Record<ModelStage, string>;
  botCap: string;
  userCap: string;
  dmChat: boolean;
  continueReads: boolean;
  liveBuildStream: boolean;
  shadowBuildPlatform: boolean;
  buildConcurrency: string;
  liveAtOnce: string;
  perPerson: string;
  proposalCeiling: string;
  turnMinutes: string;
  turnTokens: string;
  batchSize: string;
}
type FormKey = keyof Form;

const FIELD_LABEL: Record<FormKey, string> = {
  mode: 'on or off',
  pausedApps: 'where it works',
  models: 'models',
  botCap: "the bot's weekly budget",
  userCap: 'the budget per person',
  dmChat: 'reading DMs',
  continueReads: 'continuing its last read',
  liveBuildStream: 'Live while a first version builds',
  shadowBuildPlatform: 'side builds of Homeroom',
  buildConcurrency: 'shadow builds at once',
  liveAtOnce: 'live requests at once',
  perPerson: 'per person at once',
  proposalCeiling: 'proposals at once',
  turnMinutes: 'minutes per issue',
  turnTokens: 'the token warning',
  batchSize: 'issues per app',
};

/** The form as the saved settings fill it. Pure. */
export function savedForm(p: Pick<Payload, 'settings' | 'bot'>): Form {
  const s = p.settings;
  return {
    mode: s.mode === 'off' ? 'off' : 'shadow',
    pausedApps: s.pausedApps || [],
    models: {
      triage: s.models?.triage || '', spec: s.models?.spec || '', build: s.models?.build || '', followup: s.models?.followup || '',
    },
    botCap: p.bot ? (p.bot.weeklyLimitCents / 100).toFixed(2) : '',
    userCap: ((s.userWeeklyCents ?? 5000) / 100).toFixed(2),
    dmChat: s.dmChat !== false,
    continueReads: s.continueReads !== false,
    liveBuildStream: s.liveBuildStream !== false,
    shadowBuildPlatform: !!s.shadowBuildPlatform,
    buildConcurrency: String(s.buildConcurrency ?? 2),
    liveAtOnce: String(s.liveAtOnce ?? 12),
    perPerson: String(s.perPerson ?? 3),
    proposalCeiling: String(s.proposalCeiling ?? 0),
    turnMinutes: String(Math.round((s.turnSeconds ?? 1200) / 60)),
    turnTokens: String(Math.round((s.turnInputTokens ?? 10_000_000) / 1_000_000)),
    batchSize: String(s.batchSize ?? 100),
  };
}

// The list is a set: the order a person ticked them in is not a change.
const SET_FIELDS: FormKey[] = ['pausedApps'];
function sameField(key: FormKey, a: unknown, b: unknown): boolean {
  if (SET_FIELDS.includes(key)) return JSON.stringify([...(a as string[])].sort()) === JSON.stringify([...(b as string[])].sort());
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields an edit actually changed. Pure. */
export function dirtyFields(edits: Partial<Form>, saved: Form): FormKey[] {
  return (Object.keys(edits) as FormKey[]).filter((k) => !sameField(k, edits[k], saved[k]));
}

/**
 * The one PUT the form's Save sends: every changed field in the route's own
 * shape, or the first thing wrong with what was typed. Pure; the route
 * re-checks every rule and writes nothing unless all of it is valid.
 */
export function buildPatch(form: Form, saved: Form, dirty: FormKey[]): { patch: Record<string, unknown>; error: string | null } {
  const patch: Record<string, unknown> = {};
  const errors: string[] = [];
  const whole = (key: FormKey, min: number, max: number, what: string): number | null => {
    const n = Number(form[key]);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    errors.push(`${what} must be a whole number from ${min} to ${max}.`);
    return null;
  };
  const dollars = (key: FormKey, what: string, zero: string): number | null => {
    const raw = String(form[key]).trim();
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n) && n >= 0) return Math.round(n * 100);
    errors.push(`${what}: enter a dollar amount${zero}.`);
    return null;
  };
  for (const key of dirty) {
    if (key === 'mode') patch.mode = form.mode;
    else if (key === 'pausedApps') patch.pausedApps = [...new Set(form.pausedApps.filter(Boolean))];
    else if (key === 'dmChat' || key === 'continueReads' || key === 'liveBuildStream' || key === 'shadowBuildPlatform') patch[key] = form[key];
    else if (key === 'models') {
      const changed: Record<string, string> = {};
      for (const m of MODEL_STAGES) {
        const id = String(form.models[m.key] || '').trim();
        if (id === (saved.models[m.key] || '')) continue;
        if (id && !MODEL_ID_RE.test(id)) errors.push(`${m.label}: a model is an OpenRouter id such as z-ai/glm-5.3-flash, or the platform default.`);
        changed[m.key] = id;
      }
      if (Object.keys(changed).length) patch.models = changed;
    } else if (key === 'botCap') patch.weeklyLimitCents = dollars('botCap', "The bot's weekly budget", '');
    else if (key === 'userCap') patch.userWeeklyCents = dollars('userCap', 'The budget per person', ' (0 for no limit)');
    else if (key === 'buildConcurrency') patch.buildConcurrency = whole(key, 1, 4, 'Shadow builds at once');
    else if (key === 'liveAtOnce') patch.liveAtOnce = whole(key, 1, 24, 'Live requests at once');
    else if (key === 'perPerson') patch.perPerson = whole(key, 1, 6, 'Per person at once');
    else if (key === 'proposalCeiling') patch.proposalCeiling = whole(key, 0, 1000, 'Proposals up for a vote at once');
    else if (key === 'turnMinutes') {
      const n = whole(key, 1, 180, 'Minutes per issue');
      if (n != null) patch.turnSeconds = n * 60;
    } else if (key === 'turnTokens') {
      const n = whole(key, 1, 5000, 'Millions of tokens');
      if (n != null) patch.turnInputTokens = n * 1_000_000;
    } else if (key === 'batchSize') patch.batchSize = whole(key, 1, 500, 'Issues per app');
    if (errors.length) return { patch: {}, error: errors[0] };
  }
  return { patch, error: null };
}

type Tab = 'overview' | 'settings' | 'benchmark';
const TAB_HASH: Record<Tab, string> = {
  overview: '#admin/homeroom-bot',
  settings: '#admin/homeroom-bot/settings',
  benchmark: '#admin/homeroom-bot/benchmark',
};
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', settings: 'Settings', benchmark: 'Benchmark' };

function tabFromHash(hash: string): Tab {
  if (/^#admin\/homeroom-bot\/benchmark\b/.test(hash)) return 'benchmark';
  if (/^#admin\/homeroom-bot\/settings\b/.test(hash)) return 'settings';
  return 'overview';
}

/** On or off, and where it is live, in one phrase. Pure. */
export function modeLabel(settings: Settings | undefined): string {
  if (!settings) return '';
  if (settings.mode === 'off') return 'Off';
  const paused = (settings.pausedApps || []).length;
  return paused
    ? `On: live on every app but ${paused} paused`
    : 'On: live on every app';
}

/** Whether the bot's loop is working, as a chip a fault cannot hide in. Pure. */
export function health(settings: Settings | undefined, loop: LastPass | null | undefined): { tone: 'ok' | 'warn' | 'bad' | 'off'; text: string } {
  if (!settings) return { tone: 'off', text: '' };
  if (settings.mode === 'off') return { tone: 'off', text: 'Not running' };
  if (!loop) return { tone: 'warn', text: 'No pass since the platform started' };
  if (loop.paused === 'budget') return { tone: 'warn', text: 'Paused: the weekly budget is spent' };
  if (loop.paused === 'infra') return { tone: 'bad', text: `Platform fault${retryAt(loop) ? `, trying again at ${retryAt(loop)}` : ''}` };
  if (loop.paused === 'github') return { tone: 'warn', text: `Waiting for GitHub's hourly limit${retryAt(loop) ? `, trying again at ${retryAt(loop)}` : ''}` };
  if (loop.refusals?.length) return { tone: 'warn', text: `${loop.refusals.length} app${loop.refusals.length === 1 ? '' : 's'} backing off` };
  return { tone: 'ok', text: `Working, last pass ${when(loop.at)}` };
}

const HEALTH_BADGE = {
  ok: AdminUI.badge.success, warn: AdminUI.badge.warn, bad: AdminUI.badge.destructive, off: AdminUI.badge.default,
};

function HomeroomBotSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [payload, setPayload] = useState<Payload | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [runSlug, setRunSlug] = useState('');
  const [runIssue, setRunIssue] = useState('');
  // #3710: the Settings form's edits, field by field, over what is saved.
  // Only the fields somebody touched are here, so the 30-second poll can
  // refresh the rest without throwing an edit away.
  const [edits, setEdits] = useState<Partial<Form>>({});
  // Bumped on a save or a discard, so the DM rows drop their own draft.
  const [formRound, setFormRound] = useState(0);
  const [bench, setBench] = useState<{ models: BenchModel[]; best: Best | null; defaultModel: string | null } | null>(null);
  // The address carries the tab (#admin/homeroom-bot/settings), read once on
  // mount; the tabs replace the address rather than push it, so they never
  // re-route the console.
  const [tab, setTab] = useState<Tab>(() => (typeof location !== 'undefined' ? tabFromHash(location.hash) : 'overview'));
  const [benchSeen, setBenchSeen] = useState(tab === 'benchmark');
  const showTab = (next: Tab) => {
    setTab(next);
    if (next === 'benchmark') setBenchSeen(true);
    try { history.replaceState(null, '', TAB_HASH[next]); } catch { /* non-fatal */ }
  };
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = useCallback((data: Payload) => {
    setPayload(data);
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (appFilter) params.set('app', appFilter);
    if (verdictFilter) params.set('verdict', verdictFilter);
    const qs = params.toString();
    const { data } = await console_().fetchJson(`/api/admin/homeroom-bot${qs ? `?${qs}` : ''}`);
    if (alive.current && data && typeof data === 'object') apply(data as Payload);
  }, [apply, appFilter, verdictFilter]);

  useEffect(() => { load(); }, [load]);

  // A pass takes a minute or two per issue; a slow poll keeps the queue and
  // the totals honest without hammering the endpoint. Cleared on destroy.
  useEffect(() => {
    const handle = window.setInterval(() => { load(); }, 30_000);
    return () => window.clearInterval(handle);
  }, [load]);

  // The model pickers' catalog and each model's latest benchmark result,
  // read the first time Settings is opened.
  useEffect(() => {
    if (tab !== 'settings' || bench) return;
    loadBenchSummary()
      .then((b) => { if (alive.current) setBench(b); })
      .catch(() => { if (alive.current) setBench({ models: [], best: null, defaultModel: null }); });
  }, [tab, bench]);

  const write = async (url: string, method: string, body: unknown, okText: string) => {
    setStatus(null);
    setBusy(url);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return null;
      setStatus({ text: okText, tone: 'ok' });
      return data;
    } catch (err: any) {
      if (alive.current) setStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
      return null;
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const rate = async (run: Run, rating: 'yes' | 'no' | null) => {
    const data = await write(`/api/admin/homeroom-bot/runs/${run.id}/rating`, 'POST', { rating },
      rating ? `#${run.issue_number} rated.` : `#${run.issue_number} rating cleared.`);
    if (data) load();
  };

  // #3654: the right verdict and a note, without touching the Yes/No.
  const label = async (run: Run, labelVerdict: LabelVerdict | null, note: string | null) => {
    const data = await write(`/api/admin/homeroom-bot/runs/${run.id}/rating`, 'POST', { labelVerdict, note },
      `#${run.issue_number} labelled.`);
    if (data) load();
  };

  // A plain link, not a fetch: the endpoint streams the file and the browser
  // is better at receiving one than a Blob assembled in page memory. It
  // carries whatever filters the table is showing, so "all verdicts" is the
  // export with both filters cleared.
  const exportParams = new URLSearchParams();
  if (appFilter) exportParams.set('app', appFilter);
  if (verdictFilter) exportParams.set('verdict', verdictFilter);
  const exportQs = exportParams.toString();
  const exportHref = `/api/admin/homeroom-bot/export.csv${exportQs ? `?${exportQs}` : ''}`;

  const runNow = async () => {
    const n = Number(runIssue);
    if (!runSlug || !Number.isInteger(n) || n <= 0) {
      setStatus({ text: 'Pick an app and type an issue number.', tone: 'err' });
      return;
    }
    const data = await write('/api/admin/homeroom-bot/run', 'POST', { slug: runSlug, issueNumber: n },
      `#${n} on ${runSlug} is at the head of the queue${payload?.settings.mode === 'off' ? ' (the bot is off, so it waits)' : ''}.`);
    // A request the bot is on right now is left to finish, not started twice.
    if (data?.running) setStatus({ text: `The bot is already working on #${n} on ${runSlug}; it looks again once that ends.`, tone: 'ok' });
    if (data) { setRunIssue(''); load(); }
  };

  // A live app's open issues, all of them, as if just posted (#3480): the
  // loop takes them one at a time, as it takes new ones.
  const retriageApp = async (slug: string) => {
    const data = await write('/api/admin/homeroom-bot/retriage-app', 'POST', { slug }, 'Queued.');
    if (!data || !alive.current) return;
    const busy = data.left?.busy || 0;
    setStatus({
      text: data.queued
        ? `${data.queued} open issue${data.queued === 1 ? '' : 's'} on ${appName(slug)} will be triaged again, one at a time, oldest first.${busy ? ` ${busy} somebody is working on left alone.` : ''}`
        : `No open issues on ${appName(slug)} to triage again.${busy ? ` ${busy} somebody is working on left alone.` : ''}`,
      tone: 'ok',
    });
    load();
  };

  // An ask the bot misread: tag this person on this issue again.
  const tagAgain = async (o: MentionOptOut) => {
    const data = await write('/api/admin/homeroom-bot/mention-optouts/remove', 'POST',
      { slug: o.app_slug, issueNumber: o.issue_number, username: o.username },
      `@${o.username} is tagged again on ${o.app_name} #${o.issue_number}.`);
    if (data && alive.current && payload) setPayload({ ...payload, mentionOptOuts: data.mentionOptOuts });
  };

  const settings = payload?.settings;
  const totals = payload?.totals;
  const bot = payload?.bot;
  const runs = payload?.runs || [];
  const appName = (slug: string) => payload?.apps.find((a) => a.slug === slug)?.name || slug;
  const agreement = totals && totals.rated > 0 ? Math.round((totals.agreed / totals.rated) * 100) : null;

  // ── The form ─────────────────────────────────────────────────────────
  const saved: Form | null = payload ? savedForm(payload) : null;
  const form: Form | null = saved ? { ...saved, ...edits } : null;
  const dirty = saved ? dirtyFields(edits, saved) : [];
  const setField = <K extends FormKey>(key: K, value: Form[K]) => setEdits((e) => ({ ...e, [key]: value }));
  const setModel = (stage: ModelStage, id: string) => {
    if (!saved) return;
    setEdits((e) => ({ ...e, models: { ...(e.models || saved.models), [stage]: id } }));
  };
  // What the save bar and the saved message call each change; a model
  // change names its stages ("the Build model").
  const changeLabels = () => [...new Set(dirty.map((k) => {
    if (k !== 'models' || !form || !saved) return FIELD_LABEL[k];
    const stages = MODEL_STAGES.filter((m) => (form.models[m.key] || '') !== (saved.models[m.key] || '')).map((m) => m.label);
    return stages.length ? `the ${stages.join(', ')} model${stages.length === 1 ? '' : 's'}` : FIELD_LABEL[k];
  }))];
  const discard = () => {
    setEdits({});
    setFormRound((n) => n + 1);
    setStatus(null);
  };
  const save = async () => {
    if (!form || !saved || !dirty.length) return;
    const { patch, error } = buildPatch(form, saved, dirty);
    if (error) { setStatus({ text: error, tone: 'err' }); return; }
    const data = await write('/api/admin/homeroom-bot/settings', 'PUT', patch, `Saved: ${changeLabels().join(', ')}.`);
    if (data) {
      setEdits({});
      setFormRound((n) => n + 1);
      apply(data as Payload);
    }
  };
  // #3710: the Benchmark's "Use for <stage>" fills the form in; Save is still a person's.
  const applyBenchModel = (stage: ModelStage, id: string) => {
    setModel(stage, id);
    showTab('settings');
    const name = MODEL_STAGES.find((m) => m.key === stage)?.label || stage;
    setStatus({ text: `${name} is set to ${id} in the form below. Nothing changes until you press Save changes.`, tone: 'ok' });
    try { window.requestAnimationFrame(() => document.getElementById('admin-homeroom-bot-models')?.scrollIntoView({ block: 'center' })); } catch { /* non-fatal */ }
  };

  const chip = health(settings, payload?.loop);
  const working = payload?.workingNow || [];
  const pairsLine = pairsWaitingLine(payload?.pairsWaiting);

  const tile = (label: string, value: string, id: string, sub?: string) => (
    <div className="rounded-xl bg-zinc-100 dark:bg-zinc-800 p-3" id={id}>
      <div className={AdminUI.muted}>{label}</div>
      <div className="text-2xl font-semibold mt-0.5 tabular-nums">{value}</div>
      {sub ? <div className={AdminUI.muted}>{sub}</div> : null}
    </div>
  );

  return (
    <div className="space-y-4" id="admin-homeroom-bot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Homeroom bot" id="admin-homeroom-bot-tabs">
          {(['overview', 'settings', 'benchmark'] as const).map((key) => (
            <button
              key={key} type="button" role="tab" id={`admin-homeroom-bot-tab-${key}`}
              aria-selected={tab === key} aria-controls={`admin-homeroom-bot-panel-${key}`}
              className={tab === key ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
              onClick={() => showTab(key)}
            >
              {TAB_LABEL[key]}
              {key === 'settings' && dirty.length ? <span className="ml-1">(not saved)</span> : null}
            </button>
          ))}
        </div>
        <span className={chip.text ? HEALTH_BADGE[chip.tone] : 'hidden'} id="admin-homeroom-bot-health">{chip.text}</span>
      </div>
      <p id="admin-homeroom-bot-status" role="status" className={status
        ? `text-sm ${status.tone === 'err' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`
        : 'text-sm hidden'}>
        {status ? status.text : ''}
      </p>

      {/* ── Overview ─────────────────────────────────────────────────── */}
      <div id="admin-homeroom-bot-panel-overview" role="tabpanel" aria-labelledby="admin-homeroom-bot-tab-overview" hidden={tab !== 'overview'} className="space-y-4">
        <div className={`${AdminUI.card} p-4`}>
          <div className={AdminUI.cardHeader}>
            <h2 className={AdminUI.cardTitle}>Homeroom bot</h2>
            <span className={AdminUI.cardDescription} id="admin-homeroom-bot-mode-label">
              {settings ? modeLabel(settings) : 'Loading…'}
            </span>
          </div>
          <p className={`${AdminUI.muted} mb-4`} id="admin-homeroom-bot-intro">
            The bot reads each open request, its discussion and the app&apos;s code, and decides what to do: ask one question,
            build it, or leave it to a person. It works for everyone with platform access and acts on every app but the
            paused ones, Homeroom&apos;s own included: it posts on the request, asks its questions there and builds the clear
            ones into proposals for the group to vote on. Rate its verdicts below. Settings has the paused apps, its models
            and its budget.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {tile('Running now', String(working.length), 'admin-homeroom-bot-tile-working',
              working.length ? workingFor(working) : 'nothing')}
            {tile('Waiting in the queue',
              payload ? String(payload.queue.depth + (payload.queue.buildsWaiting || 0)) : '–', 'admin-homeroom-bot-tile-queue',
              payload ? waitingFor(payload.queue.depth, payload.queue.buildsWaiting || 0) || undefined : undefined)}
            {tile('Spent this week', bot ? dollarsFromCents(bot.weeklySpentCents) : '–', 'admin-homeroom-bot-tile-spend',
              bot ? `of ${dollarsFromCents(bot.weeklyLimitCents)}` : undefined)}
            {tile('You agree with it', agreement == null ? '–' : `${agreement}%`, 'admin-homeroom-bot-tile-agreement',
              totals && totals.rated ? `of ${totals.rated} rated` : 'nothing rated yet')}
          </div>
          <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-totals">
            {totals
              ? <>
                <span id="admin-homeroom-bot-total-runs">{`${totals.runs} verdict${totals.runs === 1 ? '' : 's'} in the last ${totals.days || 7} days`}</span>
                {`: ${totals.questions} question${totals.questions === 1 ? '' : 's'}, ${totals.ready} ready to build, ${totals.person} for a person`}
                <span id="admin-homeroom-bot-total-budget">{totals?.budgetStopped ? `, ${totals.budgetStopped} stopped on budget` : ''}</span>
                .
              </>
              : ''}
          </p>
          <p className={pairsLine ? `${AdminUI.muted} mt-1` : 'hidden'} id="admin-homeroom-bot-pairs-waiting">{pairsLine}</p>

          <details className="mt-3" id="admin-homeroom-bot-health-details">
            <summary className={`${AdminUI.muted} cursor-pointer`}>How the loop is doing</summary>
            <p className={`${AdminUI.muted} mt-2`} id="admin-homeroom-bot-loop">
              {payload?.loop
                ? `Last pass ${when(payload.loop.at)}: ${payload.loop.dispatched ?? payload.loop.processed ?? 0} started, ${payload.loop.inFlight ?? 0} running${payload.loop.refreshed ? ', queue refreshed' : ''}${
                  payload.loop.paused === 'budget' ? '; paused on the weekly cap'
                    : payload.loop.paused === 'infra' ? `; paused on a platform fault (${payload.loop.detail || 'see the logs'})${
                      retryAt(payload.loop) ? `, trying again at ${retryAt(payload.loop)}` : ''}`
                      : payload.loop.paused === 'github' ? `; waiting for GitHub's hourly limit to reset${
                        retryAt(payload.loop) ? `, trying again at ${retryAt(payload.loop)}` : ''}`
                      : payload.loop.paused === 'mode_off' ? '; stopped because the mode was switched off'
                        : payload.loop.busy ? '; another instance held the loop' : ''}.`
                : 'No pass has run since the platform started.'}
            </p>
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-refusals">
              {payload?.loop?.refusals?.length
                ? `Backing off: ${payload.loop.refusals.map((r) => `${r.app} (${r.error}, retrying in ${Math.round((r.retryInMs || 0) / 60000)} min)`).join('; ')}.`
                : 'No app is backed off. A session that refuses a turn is retried after 2 minutes, then at doubling intervals up to an hour.'}
            </p>
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-identity">
              {`${bot
                ? `Runs as ${bot.username} on ${bot.model || 'the platform default model'}, ${bot.hasIncludedKey ? 'with its included OpenRouter key' : 'with no OpenRouter key yet (the first pass mints one)'}.`
                : 'The bot user is not set up yet; the dashboard creates it on load, so check the logs if this persists.'} Before posting anything the live rules would hold a verdict at ${payload?.caps.proposalsPerApp ?? 5} open bot proposals per app (${payload?.caps.proposalsTotal ?? 5} across all its live apps) and ${payload?.caps.questionsPerAppPerDay ?? 10} questions per app per day; rows below say when they would have.`}
            </p>
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-cadence">
              The loop wakes the moment a request is filed, edited or discussed here, drains the queue, then sleeps until the next one. A sweep of GitHub every five minutes catches what happens there directly.
            </p>
          </details>
        </div>

        <RolloutHealth health={payload?.health} failures={payload?.dmChat?.recentFailures} incidents={payload?.incidents} />

        <div className={`${AdminUI.card} p-4`}>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>Working on now</h3>
                <span className={AdminUI.cardDescription} id="admin-homeroom-bot-working-count">
                  {payload ? `${working.length} running` : ''}
                </span>
              </div>
              <WorkingNow items={payload?.workingNow || []} />
            </div>
            <div>
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>Queue</h3>
                <span className={AdminUI.cardDescription} id="admin-homeroom-bot-queue-depth">
                  {payload ? `${payload.queue.depth} waiting` : ''}
                </span>
              </div>
              {payload && payload.queue.items.length ? (
                <ul className="text-sm space-y-1" id="admin-homeroom-bot-queue">
                  {payload.queue.items.map((q) => (
                    <li key={q.id} className="flex flex-wrap items-center gap-2">
                      <span className={q.started_at ? AdminUI.badge.secondary : AdminUI.badge.default}>
                        {q.started_at ? 'running' : q.priority === 0 ? 'run now' : q.reason}
                      </span>
                      <span>{q.app_name}</span>
                      <span className={AdminUI.muted}>#{q.issue_number}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={AdminUI.muted}>Nothing queued. The queue refreshes from open requests every five minutes while the bot is on.</p>
              )}
            </div>
          </div>
          {canWrite ? (
            <div className="flex flex-wrap items-end gap-2 mt-4">
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-app">Run now on</label>
                <select
                  id="admin-homeroom-bot-run-app"
                  className={`${AdminUI.select} mt-1`}
                  value={runSlug}
                  onChange={(e) => setRunSlug(e.target.value)}
                >
                  <option value="">Pick an app…</option>
                  {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-issue">Issue #</label>
                <input
                  id="admin-homeroom-bot-run-issue"
                  type="number" min="1" step="1"
                  className={`${AdminUI.input} mt-1 w-28`}
                  value={runIssue}
                  onChange={(e) => setRunIssue(e.target.value)}
                />
              </div>
              <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={runNow}>
                Queue it first
              </button>
            </div>
          ) : null}
        </div>

        <div className={`${AdminUI.card} p-4`}>
          <div className={AdminUI.cardHeader}>
            <h3 className={AdminUI.cardTitle}>Verdicts</h3>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="w-44">
                <select
                  id="admin-homeroom-bot-filter-app"
                  className={AdminUI.select}
                  aria-label="Filter by app"
                  value={appFilter}
                  onChange={(e) => setAppFilter(e.target.value)}
                >
                  <option value="">All apps</option>
                  {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
                </select>
              </div>
              <div className="w-44">
                <select
                  id="admin-homeroom-bot-filter-verdict"
                  className={AdminUI.select}
                  aria-label="Filter by verdict"
                  value={verdictFilter}
                  onChange={(e) => setVerdictFilter(e.target.value)}
                >
                <option value="">All verdicts</option>
                <option value="question">Needs a question</option>
                <option value="ready">Ready to build</option>
                <option value="empty">Nothing to build</option>
                <option value="person">Needs a person</option>
                <option value="answer">Answered (follow-up)</option>
                <option value="revise">Revised its proposal</option>
                <option value="failed">Failed</option>
                <option value="budget">Stopped on budget</option>
                </select>
              </div>
              {canWrite ? (
                <a
                  id="admin-homeroom-bot-export"
                  className={AdminUI.btn.outlineSm}
                  href={exportHref}
                  download
                >Download CSV</a>
              ) : null}
            </div>
          </div>
          <div className={AdminUI.tableWrap}>
            <table className={AdminUI.table} id="admin-homeroom-bot-table">
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={AdminUI.th}>When</th>
                  <th className={AdminUI.th}>App</th>
                  <th className={AdminUI.th}>Issue</th>
                  <th className={AdminUI.th}>Verdict</th>
                  <th className={AdminUI.th}>Cost</th>
                  <th className={AdminUI.th}>Your rating</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const isOpen = !!open[run.id];
                  const ratingLabel = run.verdict === 'question' ? 'Right question?' : run.verdict === 'ready' ? 'Would you have built this?' : 'Agree?';
                  return [
                    <tr className={AdminUI.trHover} key={run.id} data-homeroom-bot-run={run.id} data-verdict={run.verdict}>
                      <td className={`${AdminUI.td} whitespace-nowrap`}>{when(run.created_at)}</td>
                      <td className={AdminUI.td}>{run.app_name}</td>
                      <td className={AdminUI.td}>
                        {run.issueUrl
                          ? <a className={AdminUI.btn.link} href={run.issueUrl}>#{run.issue_number}</a>
                          : <span>#{run.issue_number}</span>}
                      </td>
                      <td className={AdminUI.td}>
                        <button
                          type="button"
                          className="text-left"
                          aria-expanded={isOpen}
                          onClick={() => setOpen((o) => ({ ...o, [run.id]: !isOpen }))}
                        >
                          <span className={run.budget_stop ? AdminUI.badge.warn : VERDICT_BADGE[run.verdict]}>
                            {run.budget_stop ? `Stopped: ${run.budget_stop}` : VERDICT_LABEL[run.verdict]}
                          </span>
                          {run.cap_suppressed ? <span className={`${AdminUI.badge.outline} ml-1`}>held</span> : null}
                          {isFollowUp(run) ? <span className={`${AdminUI.badge.outline} ml-1`}>follow-up</span> : null}
                          <span className={`${AdminUI.muted} ml-2`}>{isOpen ? 'hide' : 'show'}</span>
                        </button>
                      </td>
                      <td className={`${AdminUI.td} whitespace-nowrap`}>{money(run.cost_usd)}</td>
                      <td className={AdminUI.td}>
                        {run.verdict === 'failed' ? (
                          <span className={AdminUI.muted}>–</span>
                        ) : canWrite ? (
                          <div>
                            <div className={`${AdminUI.muted} mb-1 min-w-[9rem]`}>{ratingLabel}</div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className={run.rating === 'yes' ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
                                disabled={busy !== ''}
                                aria-label={`${ratingLabel} Yes`}
                                onClick={() => rate(run, run.rating === 'yes' ? null : 'yes')}
                              >Yes</button>
                              <button
                                type="button"
                                className={run.rating === 'no' ? AdminUI.btn.destructiveSm : AdminUI.btn.outlineSm}
                                disabled={busy !== ''}
                                aria-label={`${ratingLabel} No`}
                                onClick={() => rate(run, run.rating === 'no' ? null : 'no')}
                              >No</button>
                            </div>
                          </div>
                        ) : (
                          <span className={AdminUI.muted}>{run.rating ? `${run.rating}${run.rated_by ? ` (${run.rated_by})` : ''}` : 'unrated'}</span>
                        )}
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${run.id}-detail`} data-homeroom-bot-detail={run.id}>
                        <td className={AdminUI.td} colSpan={6}>
                          <div className="space-y-2">
                            <VerdictBody run={run} />
                            <RunLabel
                              key={`label-${run.id}-${run.label_verdict || ''}-${run.rating_note || ''}`}
                              run={run} canWrite={canWrite} busy={busy !== ''}
                              onSave={(v, n) => label(run, v, n)}
                            />
                            {canWrite ? <AddToSuite run={run} busy={busy !== ''} /> : null}
                            <div className={`${AdminUI.muted} flex flex-wrap gap-x-4 gap-y-1`}>
                              {run.mode === 'live' ? <span>live: acted on the issue</span> : null}
                              <span>determined: {run.determined == null ? '–' : run.determined ? 'yes' : 'no'}</span>
                              {run.missing_fact ? <span>missing: {run.missing_fact}</span> : null}
                              {run.cap_suppressed ? <span>{CAP_LABEL[run.cap_suppressed] || run.cap_suppressed}</span> : null}
                              {run.model ? <span>{run.model}</span> : null}
                              {run.build_model && run.build_model !== run.model ? <span>{`built on ${run.build_model}`}</span> : null}
                              {run.duration_ms != null ? <span>{Math.round(run.duration_ms / 1000)}s</span> : null}
                              {run.rating_note ? <span>note: {run.rating_note}</span> : null}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
                {runs.length === 0 ? (
                  <tr>
                    <td className={AdminUI.td} colSpan={6} id="admin-homeroom-bot-empty">
                      {payload
                        ? (settings?.mode === 'off'
                          ? 'No verdicts yet. Turn the bot on in Settings and the first pass starts within two minutes.'
                          : 'No verdicts yet for this filter.')
                        : 'Loading…'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-optouts">
          <div className={AdminUI.cardHeader}>
            <h3 className={AdminUI.cardTitle}>Asked not to be tagged</h3>
            <span className={AdminUI.cardDescription} id="admin-homeroom-bot-optouts-count">
              {payload ? `${payload.mentionOptOuts.total} ${payload.mentionOptOuts.total === 1 ? 'person' : 'people'}` : ''}
            </span>
          </div>
          <p className={`${AdminUI.muted} mb-2`}>
            The bot tags whoever filed an issue and whoever took part in it, except these people, who asked
            it to stop on that issue. They are tagged again when they say so there. Tag again from here only
            when the bot misread what somebody said.
          </p>
          {payload && payload.mentionOptOuts.items.length ? (
            <ul className="text-sm space-y-1" id="admin-homeroom-bot-optouts-list">
              {payload.mentionOptOuts.items.map((o) => (
                <li key={`${o.app_slug}-${o.issue_number}-${o.username}`} className="flex flex-wrap items-center gap-2"
                  data-optout={`${o.app_slug}#${o.issue_number}@${o.username}`}>
                  <span>{`@${o.username} on ${o.app_name} #${o.issue_number}`}</span>
                  <span className={AdminUI.muted}>{`since ${when(o.created_at)}`}</span>
                  {canWrite ? (
                    <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={() => tagAgain(o)}>
                      Tag again
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={AdminUI.muted} id="admin-homeroom-bot-optouts-none">Nobody has asked.</p>
          )}
        </div>
      </div>

      {/* ── Settings ─────────────────────────────────────────────────── */}
      <div id="admin-homeroom-bot-panel-settings" role="tabpanel" aria-labelledby="admin-homeroom-bot-tab-settings" hidden={tab !== 'settings'} className="space-y-4">
        {!form || !saved ? <p className={AdminUI.loading}>Loading…</p> : (
          <>
            <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-settings-main">
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>The bot</h3>
                <span className={AdminUI.cardDescription}>{`Runs as ${bot?.username || 'homeroom_bot'}`}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bot-mode">The bot is</label>
                  <select
                    id="admin-homeroom-bot-mode"
                    className={`${AdminUI.select} mt-1`}
                    value={form.mode}
                    disabled={!canWrite}
                    onChange={(e) => setField('mode', e.target.value as Form['mode'])}
                  >
                    <option value="off">Off</option>
                    <option value="shadow">On</option>
                  </select>
                  <p className={`${AdminUI.muted} mt-1`}>
                    {form.mode === 'off'
                      ? 'Off: nothing runs, on any app.'
                      : 'On: live on every app but the paused ones, for everyone with platform access.'}
                  </p>
                </div>
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bot-cap">The bot&apos;s weekly budget, dollars</label>
                  <input
                    id="admin-homeroom-bot-cap"
                    type="number" min="0" step="1" inputMode="decimal"
                    className={`${AdminUI.input} mt-1`}
                    value={form.botCap}
                    disabled={!canWrite}
                    onChange={(e) => setField('botCap', e.target.value)}
                  />
                  <p className={`${AdminUI.muted} mt-1`}>
                    {bot ? `${dollarsFromCents(bot.weeklySpentCents)} spent this week. Triage, plans, builds and side builds all come out of it.` : ''}
                  </p>
                </div>
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bot-user-cap">Per person, per week</label>
                  <input
                    id="admin-homeroom-bot-user-cap"
                    type="number" min="0" step="1" inputMode="decimal"
                    className={`${AdminUI.input} mt-1`}
                    value={form.userCap}
                    disabled={!canWrite}
                    onChange={(e) => setField('userCap', e.target.value)}
                  />
                  <p className={`${AdminUI.muted} mt-1`}>What one person&apos;s requests may cost the platform, apart from their own agent allowance. 0 for no limit.</p>
                </div>
              </div>
            </div>

            <div className={`${AdminUI.card} p-4`}>
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle} id="admin-homeroom-bot-live-apps-label">Where it works</h3>
                <span className={AdminUI.cardDescription} id="admin-homeroom-bot-live-apps-state">
                  Live on every app
                  {form.pausedApps.length ? ` but ${form.pausedApps.map(appName).join(', ')}, paused` : ''}
                  {form.mode === 'off' ? ', once the bot is turned on' : ''}
                  {settings?.everyoneSince ? `, for everyone since ${when(settings.everyoneSince)}` : ''}
                  .
                </span>
              </div>
              <AppModes
                apps={payload?.apps || []}
                paused={form.pausedApps} savedPaused={saved.pausedApps}
                canWrite={canWrite}
                onChange={(paused) => setField('pausedApps', paused)}
                onRetriage={retriageApp}
              />
              <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-live-apps-note">
                Live: it posts on each request it looks at, asks its questions there, and builds the clear ones into
                proposals for the group to vote on, the platform&apos;s own project included. Paused: it leaves the app
                alone. The bot has to be on, and a staging copy never acts. A request older than the moment it went on
                for everyone, and the issues an imported project came with, wait until something new happens on them, or
                until Triage again.
              </p>
            </div>

            <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-models">
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>Models</h3>
                <button type="button" className={`${AdminUI.btn.link} text-sm`} onClick={() => showTab('benchmark')}>Compare them on the benchmark</button>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {MODEL_STAGES.map((m) => (
                  <ModelPicker
                    key={`${m.key}-${formRound}`}
                    stage={m.key} label={m.label}
                    value={form.models[m.key] || ''}
                    defaultModel={payload?.defaultModel || bench?.defaultModel || null}
                    models={bench ? bench.models : null}
                    best={bench?.best || null}
                    canWrite={canWrite}
                    onChange={(id) => setModel(m.key, id)}
                  />
                ))}
              </div>
              <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-models-note">
                {`The platform default${payload?.defaultModel ? ` is ${payload.defaultModel}` : ' is the deployment\'s OpenRouter default'}. A change applies from the next turn, and each run records the model it ran on.`}
              </p>
            </div>

            <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-dm">
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>People in DMs</h3>
                <span className={AdminUI.cardDescription}>Everyone with platform access.</span>
              </div>
              <label className="flex items-center gap-2 mt-3 text-sm" htmlFor="admin-homeroom-bot-dm-chat">
                <input
                  id="admin-homeroom-bot-dm-chat" type="checkbox"
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
                  checked={form.dmChat}
                  disabled={!canWrite}
                  onChange={(e) => setField('dmChat', e.target.checked)}
                />
                <span>Read and answer their messages</span>
              </label>
              <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-dm-chat-note">
                {payload?.dmChat
                  ? `This week: ${payload.dmChat.turns} answer${payload.dmChat.turns === 1 ? '' : 's'} to ${payload.dmChat.people} ${payload.dmChat.people === 1 ? 'person' : 'people'}, ${money(payload.dmChat.costUsd)}${payload.dmChat.failed ? `, ${payload.dmChat.failed} failed` : ''}. `
                  : ''}
                It brings each of their requests&apos; questions (with answers to tap) and its progress to their DM, can file a
                new request when they tap File it, and builds a project they create from a description.
              </p>
            </div>

            <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-side-builds">
              <div className={AdminUI.cardHeader}>
                <h3 className={AdminUI.cardTitle}>Side builds and the benchmark</h3>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <NumberField id="admin-homeroom-bot-build-concurrency" label="Shadow builds at once"
                  value={form.buildConcurrency} min={1} max={4} canWrite={canWrite}
                  onChange={(v) => setField('buildConcurrency', v)} />
                <label className="flex items-center gap-2 text-sm md:mt-6" htmlFor="admin-homeroom-bot-shadow-build-platform">
                  <input
                    id="admin-homeroom-bot-shadow-build-platform" type="checkbox"
                    className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
                    checked={form.shadowBuildPlatform}
                    disabled={!canWrite}
                    onChange={(e) => setField('shadowBuildPlatform', e.target.checked)}
                  />
                  <span>Make side builds on Homeroom&apos;s own repository too</span>
                </label>
              </div>
              <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-side-builds-note">
                A side build is another configuration of the bot building the same change quietly, beside the one that
                builds it for real, so the two can be compared (Benchmark). Side builds and the benchmark&apos;s own trials
                start only while the bot&apos;s live requests leave a slot free (Live requests at once, under Advanced), so
                they never take a worker somebody is waiting on, and a later change&apos;s side builds take one of those
                slots themselves. Shadow builds at once is for the bot&apos;s shadow builds alone. Each comes out of the
                bot&apos;s weekly budget.
              </p>
            </div>

            <details className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-advanced">
              <summary className={`${AdminUI.cardTitle} cursor-pointer`}>Advanced: how much at once, and time limits</summary>
              <div className="grid gap-4 md:grid-cols-3 mt-4" id="admin-homeroom-bot-at-once">
                <NumberField id="admin-homeroom-bot-live-at-once" label="Live requests at once"
                  value={form.liveAtOnce} min={1} max={24} canWrite={canWrite} onChange={(v) => setField('liveAtOnce', v)} />
                <NumberField id="admin-homeroom-bot-per-person" label="Per person at once"
                  value={form.perPerson} min={1} max={6} canWrite={canWrite} onChange={(v) => setField('perPerson', v)} />
                <NumberField id="admin-homeroom-bot-proposal-ceiling" label="Proposals up for a vote at once (0: automatic)"
                  value={form.proposalCeiling} min={0} max={1000} canWrite={canWrite} onChange={(v) => setField('proposalCeiling', v)} />
                <NumberField id="admin-homeroom-bot-turn-minutes" label="Minutes one issue may take"
                  value={form.turnMinutes} min={1} max={180} canWrite={canWrite} onChange={(v) => setField('turnMinutes', v)} />
                <NumberField id="admin-homeroom-bot-turn-tokens" label="Warn above, million tokens read"
                  value={form.turnTokens} min={1} max={5000} canWrite={canWrite} onChange={(v) => setField('turnTokens', v)}>
                  <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-turn-tokens-note">
                    A warning, not a stop. The bot only learns what a turn read once the
                    turn is over, so a turn past this keeps its verdict and the overrun is
                    logged. The minute limit is what actually ends a runaway turn.
                  </p>
                </NumberField>
                <NumberField id="admin-homeroom-bot-batch" label="Issues on one app before switching apps"
                  value={form.batchSize} min={1} max={500} canWrite={canWrite} onChange={(v) => setField('batchSize', v)} />
              </div>
              <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-at-once-note">
                Live requests are counted across the whole platform. It takes one request per app at a time and shares the
                slots between people in turns. Each slot uses a worker from the same pool as people&apos;s own coding
                sessions.
              </p>
              <label className="flex items-center gap-2 mt-4 text-sm" htmlFor="admin-homeroom-bot-continue-reads">
                <input
                  id="admin-homeroom-bot-continue-reads" type="checkbox"
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
                  checked={form.continueReads}
                  disabled={!canWrite}
                  onChange={(e) => setField('continueReads', e.target.checked)}
                />
                <span>Reading a request again continues its last read</span>
              </label>
              <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-continue-reads-note">
                When somebody adds to a request, the bot picks up the conversation it read the request in, with what changed,
                instead of reading the app&apos;s code from the start. It reads afresh when that conversation is gone (a new
                worker), after three continued reads in a row, or a day after the last one.
              </p>
              <label className="flex items-center gap-2 mt-4 text-sm" htmlFor="admin-homeroom-bot-live-build-stream">
                <input
                  id="admin-homeroom-bot-live-build-stream" type="checkbox"
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
                  checked={form.liveBuildStream}
                  disabled={!canWrite}
                  onChange={(e) => setField('liveBuildStream', e.target.checked)}
                />
                <span>Live while a first version builds</span>
              </label>
              <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-live-build-stream-note">
                While a project&apos;s first version is built, a watcher in its worker boots the app on every change and
                records it, and the project&apos;s members can switch its App tab from Preview to Live. Off: no watcher
                starts and nobody is offered Live. Build times with and without it are recorded
                (first_version_build_turn events).
              </p>
            </details>

            {canWrite && dirty.length ? (
              <div className={`${AdminUI.card} sticky bottom-3 z-10 p-3 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-700 flex flex-wrap items-center justify-between gap-3`} id="admin-homeroom-bot-savebar">
                <span className="text-sm">{`Not saved yet: ${changeLabels().join(', ')}.`}</span>
                <span className="flex gap-2">
                  <button type="button" className={AdminUI.btn.outlineSm} id="admin-homeroom-bot-discard" disabled={busy !== ''} onClick={discard}>Discard</button>
                  <button type="button" className={AdminUI.btn.primarySm} id="admin-homeroom-bot-save" disabled={busy !== ''} onClick={save}>Save changes</button>
                </span>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* ── Benchmark ────────────────────────────────────────────────── */}
      <div id="admin-homeroom-bot-panel-benchmark" role="tabpanel" aria-labelledby="admin-homeroom-bot-tab-benchmark" hidden={tab !== 'benchmark'}>
        {benchSeen ? (
          <BenchmarkArea canWrite={canWrite} active={tab === 'benchmark'} inUse={payload?.bot?.models || null}
            defaultModel={payload?.defaultModel || null} onUseModel={applyBenchModel} />
        ) : null}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminHomeroomBot = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <HomeroomBotSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminHomeroomBot = AdminHomeroomBot;

// Exported for tests/admin-homeroom-bot.test.js, which renders them.
export { AdminHomeroomBot, WorkingNow, HomeroomBotSection };
