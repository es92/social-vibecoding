// Where an agent session's work gets built (#2779 follow-up, #3078): here,
// by the Mayor on Homeroom credits, or handed to Claude Code or Codex on the
// web, which build on the person's own plan and push to their fork.
//
// THE PICKER is the composer's model pill, which opens "Build with"
// (./composer-parts.tsx BuildSheetBody): Homeroom | Claude Code | Codex. It
// used to be a "Build: Homeroom" pill in the session bar whose rows opened a
// walkthrough dialog; the session bar no longer carries it, and the two web
// tabs ARE the hand-off (HandoffPanel below). The conversation itself keeps
// building here (the Mayor's dispatch has no venue); what a hand-off builds
// comes back as an update to the change's proposal, or as a new proposal
// when there is no change yet.
//
// THE CHECKS are the dev chat's own walkthrough (#1049): its steps come from
// public/js/dev-flow-select.js `steps()` over GET
// /api/apps/:slug/dev-flow/status, so the two cannot describe a hand-off
// differently. Only the drawing is React's, and compact: GitHub linked, fork
// ready, Homeroom connected in the Claude or ChatGPT account the agent runs
// as, each with the walkthrough's own action. Every check reads the server's
// status, so leaving mid-way and coming back resumes where it was. The
// instructions the one button copies carry this chat's spec (#3078), which
// the server reads only for the viewer's own change.
//
// THE CREDITS CARD replaces the raw error line when the platform credits
// refuse a message (429 `budget_exceeded`). Its copy and its rows are
// public/js/credit-options.js's, the one source for the dev chat's card and
// banner: the two web hand-offs first, then your own API key and the rest a
// non-developer can follow. Its hand-off rows open the same "Build with" tab.

import { useEffect, useState, type ReactNode } from 'react';

import { CheckIcon } from '@/components/ui/icons';

import { ChatgptSetupSteps, ClaudeSetupSteps } from '../settings/connector-setup-steps';
import * as api from './api';
import type { AgentChange, AgentSession, HandoffStatus } from './api';
import {
  dismissCredits,
  openHandoff,
  useAgentSessionPick,
  type CreditsRefusal,
  type HandoffAgent,
} from './store';

export const AGENT_LABELS: Record<HandoffAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** The chat product whose account the agent signs in as, where the connector lives. */
export const AGENT_PRODUCT: Record<HandoffAgent, 'Claude' | 'ChatGPT'> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
};

const AGENT_URL: Record<HandoffAgent, string> = {
  'claude-code': 'https://claude.ai/code',
  codex: 'https://chatgpt.com/codex',
};

export interface HandoffTarget {
  slug: string;
  appName: string | null;
  /** The change the hand-off continues, or null for new work on the app. */
  change: { id: number; kind: 'session' | 'proposal'; prNumber: number | null } | null;
}

/**
 * What a hand-off from this conversation works on: its active change while
 * that can still be revised (in progress, or up for a vote), else new work on
 * the change's app or the conversation's app. Null with no app at all, which
 * is the one case there is nothing to hand over yet.
 */
export function handoffTarget(about: {
  activeChange?: AgentChange | null;
  focusApp?: AgentSession['focusApp'] | null;
} | null): HandoffTarget | null {
  const change = about?.activeChange || null;
  if (change && change.appSlug) {
    const kind = change.status === 'active' || change.status === 'paused' ? 'session'
      : change.status === 'promoted' ? 'proposal' : null;
    return {
      slug: change.appSlug,
      appName: change.appName || null,
      change: kind ? { id: change.id, kind, prNumber: change.prNumber || null } : null,
    };
  }
  const focus = about?.focusApp || null;
  if (focus && focus.slug) return { slug: focus.slug, appName: focus.name || null, change: null };
  return null;
}

// ── The walkthrough ────────────────────────────────────────────────────

interface FlowAction { action: string; label: string; primary?: boolean; href?: string }
interface FlowStep { key: string; title: string; state: 'done' | 'current' | 'todo'; detail: string; actions: FlowAction[] }

interface DevFlowSelectApi {
  steps(status: HandoffStatus, agent: HandoffAgent): FlowStep[];
  unavailableNote(reason: string | null | undefined): string;
}

function devFlowSelect(): DevFlowSelectApi | null {
  const api = typeof window === 'undefined' ? null : (window as unknown as { DevFlowSelect?: DevFlowSelectApi }).DevFlowSelect;
  return api && typeof api.steps === 'function' ? api : null;
}

/** The walkthrough's steps for this status, or [] where the module is absent. */
export function handoffSteps(status: HandoffStatus | null, agent: HandoffAgent): FlowStep[] {
  const flow = devFlowSelect();
  if (!flow || !status || status.available === false) return [];
  try { return flow.steps(status, agent) || []; } catch { return []; }
}

const ACTION = 'inline-flex items-center rounded-full border border-violet-300 px-3 py-1 text-sm font-semibold text-violet-700 '
  + 'hover:bg-violet-50 disabled:opacity-60 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/40';
const ACTION_PRIMARY = 'inline-flex items-center rounded-full bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60';

function lead(agent: HandoffAgent, target: HandoffTarget | null): string {
  const label = AGENT_LABELS[agent];
  const product = AGENT_PRODUCT[agent];
  const lands = target?.change
    ? 'its work comes back as an update to this change'
    : `its work comes back as a new change${target?.appName ? ` on ${target.appName}` : ''}`;
  return `${label} builds on your own ${product} plan and pushes to your fork of the app; ${lands}. No Homeroom credits.`;
}

/**
 * The three things a hand-off needs, as compact checks: each is a step of
 * the walkthrough's own `steps()`, so the two cannot disagree about what is
 * done. The last step never reports done (it is where the copying happens),
 * so "Homeroom connected" is read from the status the step itself reads.
 */
export interface HandoffCheck {
  key: 'github' | 'fork' | 'connector';
  label: string;
  done: boolean;
  current: boolean;
  detail: string;
  actions: FlowAction[];
}

export function handoffChecks(status: HandoffStatus | null, agent: HandoffAgent): HandoffCheck[] {
  const steps = handoffSteps(status, agent);
  if (!steps.length) return [];
  const byKey = (key: string) => steps.find((step) => step.key === key) || null;
  const connected = !!(status?.connectors && Number(status.connectors.count) > 0);
  const github = byKey('github');
  const fork = byKey('fork');
  const last = byKey('handoff');
  const checks: HandoffCheck[] = [
    { key: 'github', label: 'GitHub linked', done: github?.state === 'done', current: github?.state === 'current', detail: github?.detail || '', actions: github?.actions || [] },
    { key: 'fork', label: 'Fork ready', done: fork?.state === 'done', current: fork?.state === 'current', detail: fork?.detail || '', actions: fork?.actions || [] },
    {
      key: 'connector',
      label: `Homeroom connected in ${AGENT_PRODUCT[agent]}`,
      done: connected,
      current: !connected && last?.state === 'current',
      detail: connected ? '' : (last?.detail || ''),
      actions: connected ? [] : (last?.actions || []),
    },
  ];
  return checks;
}

/**
 * A Claude Code or Codex tab of the "Build with" sheet: the hand-off itself.
 * The lead says what happens; the checks are what is left to set up, each
 * with the walkthrough's own action; once all three are done, ONE button
 * copies the instructions (which carry this chat's spec, when it has one)
 * and opens the agent in a new tab. The credits card's hand-off rows open
 * this same tab, so there is one hand-off, not two.
 */
export function HandoffPanel({ agent, onClose }: { agent: HandoffAgent; onClose: () => void }) {
  const snapshot = useAgentSessionPick((s) => ({ session: s.session, draft: s.draft }));
  const about = snapshot.session || snapshot.draft;
  const active = snapshot.session?.activeChange || null;
  const target = handoffTarget(about ? { activeChange: active, focusApp: about.focusApp || null } : null);
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(false);
  const [connector, setConnector] = useState(false);
  const [revision, setRevision] = useState(0);
  const targetKey = target ? `${target.slug}:${target.change ? `${target.change.kind}:${target.change.id}` : 'new'}` : null;

  useEffect(() => {
    if (!target) return undefined;
    let live = true;
    setError('');
    void api.handoffStatus(target.slug, target.change ? { id: target.change.id, kind: target.change.kind } : null)
      .then((next) => { if (live) setStatus(next); })
      .catch((failure) => { if (live) setError(failure instanceof Error ? failure.message : 'Could not check where the hand-off stands.'); });
    return () => { live = false; };
  }, [targetKey, revision]);

  // Back from GitHub or the connector settings in another tab: look again.
  useEffect(() => {
    const again = () => setRevision((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);

  useEffect(() => { setConnector(false); setNotice(''); setManual(false); }, [agent]);

  const label = AGENT_LABELS[agent];
  const product = AGENT_PRODUCT[agent];
  const checks = handoffChecks(status, agent);
  const ready = checks.length > 0 && checks.every((check) => check.done);
  const instructions = status && typeof status.instructions === 'string' ? status.instructions : '';
  const unavailable = status && status.available === false
    ? (devFlowSelect()?.unavailableNote(status.reason) || 'Handing work to Claude Code or Codex is unavailable right now.')
    : '';

  const act = (action: FlowAction) => {
    setNotice('');
    if (action.action === 'refresh') setRevision((n) => n + 1);
    else if (action.action === 'link-connector') setConnector(true);
  };

  // Copied inside the click, before the new tab takes focus: a clipboard
  // write needs the page focused and the click's user activation.
  const copyAndOpen = () => {
    setNotice('');
    const copying = instructions ? window.PlatformUI?.copyText?.(instructions) : undefined;
    void Promise.resolve(copying).then((ok) => {
      setManual(!ok);
      setNotice(ok ? `Copied. Paste it into the new ${label} session.` : 'Could not copy. Copy the instructions below by hand, then paste them into the new session.');
    });
  };

  return (
    <div className="flex flex-col gap-3 text-sm text-zinc-900 dark:text-zinc-100" data-agent-session-handoff={agent}>
      {target ? <p className="px-1 leading-snug text-zinc-600 dark:text-zinc-300">{lead(agent, target)}</p> : (
        <p className="px-1 leading-snug text-zinc-600 dark:text-zinc-300" data-agent-session-handoff-empty>
          There is nothing to hand over yet. Tell the Mayor which app to change first, then come back here.
        </p>
      )}
      {error ? <p role="alert" className="px-1 text-red-700 dark:text-red-300">{error}</p> : null}
      {target && !status && !error ? <p role="status" className="px-1 text-zinc-500 dark:text-zinc-400">Checking where you are…</p> : null}
      {unavailable ? <p className="px-1 text-zinc-600 dark:text-zinc-300" data-agent-session-handoff-unavailable>{unavailable}</p> : null}
      {checks.length ? (
        <ul className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800" data-agent-session-handoff-steps>
          {checks.map((check, index) => (
            <li
              key={check.key}
              className={`px-4 py-2.5 ${index ? 'border-t border-zinc-100 dark:border-zinc-700' : ''}`}
              data-agent-session-handoff-step={check.key}
              data-state={check.done ? 'done' : check.current ? 'current' : 'todo'}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${check.done
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'border border-zinc-300 dark:border-zinc-600'}`}
                >
                  {check.done ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                </span>
                <span className={`flex-1 font-medium ${check.done || check.current ? '' : 'text-zinc-500 dark:text-zinc-400'}`}>{check.label}</span>
                <span className="sr-only">{check.done ? 'Done' : 'Not done yet'}</span>
              </div>
              {check.current && !check.done ? (
                <div className="mt-1.5 pl-8">
                  {check.detail ? <p className="text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">{check.detail}</p> : null}
                  {check.actions.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {check.actions.map((action) => (action.href ? (
                        <a
                          key={action.action}
                          className={action.primary ? ACTION_PRIMARY : ACTION}
                          href={action.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-agent-session-handoff-action={action.action}
                        >
                          {action.label}
                        </a>
                      ) : (
                        <button
                          key={action.action}
                          type="button"
                          className={action.primary ? ACTION_PRIMARY : ACTION}
                          data-agent-session-handoff-action={action.action}
                          onClick={() => act(action)}
                        >
                          {action.label}
                        </button>
                      )))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {connector && !ready ? (
        <section className="space-y-3 rounded-2xl bg-white p-3 dark:bg-zinc-800" data-agent-session-handoff-connector={product}>
          <p className="font-semibold">{`Add the Homeroom connector in ${product}`}</p>
          <p className="text-zinc-600 dark:text-zinc-300">
            {'Your MCP server URL: '}
            <code className="break-all rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-900">{typeof window === 'undefined' ? '/mcp' : `${window.location.origin}/mcp`}</code>
          </p>
          {product === 'ChatGPT' ? <ChatgptSetupSteps /> : <ClaudeSetupSteps />}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {`Then start a new ${product} conversation: one you already had open will not see a connector added after it started.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={ACTION_PRIMARY} onClick={() => { setConnector(false); setRevision((n) => n + 1); }}>
              I&rsquo;ve added it. Check again
            </button>
            <a className={ACTION} href="#settings/connectors" onClick={onClose}>More connector settings</a>
          </div>
        </section>
      ) : null}
      {ready ? (
        <>
          <div className="rounded-2xl bg-white px-4 py-3 dark:bg-zinc-800" data-agent-session-handoff-ready>
            <p className="font-semibold">Handed over with the instructions</p>
            <p className="mt-0.5 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
              {status?.specCarried && active?.title
                ? `This chat's spec: "${active.title}"`
                : status?.specCarried ? 'This chat\'s spec' : `No spec yet, so ${label} will ask what to build.`}
            </p>
          </div>
          <a
            className="inline-flex w-full items-center justify-center rounded-full bg-violet-600 px-4 py-2.5 text-[15px] font-semibold text-white hover:bg-violet-500"
            href={AGENT_URL[agent]}
            target="_blank"
            rel="noopener noreferrer"
            data-agent-session-handoff-action="copy-open"
            onClick={copyAndOpen}
          >
            {`Copy instructions and open ${label}`}
          </a>
          <p className="px-1 text-center text-[13px] text-zinc-500 dark:text-zinc-400">Paste into the new session. It starts building straight away.</p>
        </>
      ) : null}
      {notice ? <p role="status" className={`px-1 ${manual ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{notice}</p> : null}
      {ready && instructions ? (
        <details className="rounded-2xl bg-white px-4 py-3 dark:bg-zinc-800" open={manual}>
          <summary className="cursor-pointer font-semibold">Instructions</summary>
          <pre className="mt-2 max-h-60 select-all overflow-y-auto whitespace-pre-wrap break-words text-xs text-zinc-700 dark:text-zinc-300" data-agent-session-handoff-instructions>{instructions}</pre>
        </details>
      ) : null}
    </div>
  );
}

// ── Out of credits ─────────────────────────────────────────────────────

interface CreditRow {
  id: string;
  title: string;
  blurb: string;
  cta: string;
  flow?: string | null;
  hash?: string | null;
  developer?: boolean;
}

interface CreditOptionsApi {
  creditState(snapshot: unknown): Record<string, unknown>;
  options(state: Record<string, unknown>): CreditRow[];
  lead(state: Record<string, unknown>): string;
  introFor(list: CreditRow[]): string;
}

function creditOptions(): CreditOptionsApi | null {
  const co = typeof window === 'undefined' ? null : (window as unknown as { CreditOptions?: CreditOptionsApi }).CreditOptions;
  return co && typeof co.options === 'function' ? co : null;
}

/**
 * The card's copy and rows: credit-options.js over the viewer's allowance,
 * this refusal and what this account can use. The developer routes (a CLI
 * lease, importing your own pull request) are the dev chat's, which build a
 * session rather than this conversation, so they are left out here.
 */
export function creditsView(refusal: CreditsRefusal, context: {
  budget?: unknown;
  hasApiKey?: boolean;
  externalFlowsAvailable?: boolean;
  co?: CreditOptionsApi | null;
} = {}): { lead: string; intro: string; rows: CreditRow[] } {
  const co = context.co === undefined ? creditOptions() : context.co;
  if (!co) return { lead: refusal.error || 'Your Homeroom credits are used up.', intro: '', rows: [] };
  const state = {
    ...co.creditState(context.budget || null),
    hasApiKey: !!context.hasApiKey,
    externalFlowsAvailable: !!context.externalFlowsAvailable,
    verificationRequired: refusal.verificationRequired,
    canCollaborate: true,
    error: refusal.error,
  };
  const rows = co.options(state).filter((row) => !row.developer);
  return { lead: co.lead(state), intro: rows.length ? co.introFor(rows) : '', rows };
}

function viewerContext() {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as {
    AiCredit?: { Budget?: { state?: unknown } };
    Settings?: { state?: { hasApiKey?: boolean } };
    App?: { user?: { externalFlowsAvailable?: boolean } | null };
  };
  return {
    budget: w.AiCredit?.Budget?.state || null,
    hasApiKey: !!w.Settings?.state?.hasApiKey,
    externalFlowsAvailable: w.App?.user?.externalFlowsAvailable === true,
  };
}

export function CreditsCardView({ refusal, view }: { refusal: CreditsRefusal; view: ReturnType<typeof creditsView> }): ReactNode {
  return (
    <section
      className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
      data-agent-session-credits
      role="alert"
    >
      <p className="font-semibold text-zinc-900 dark:text-zinc-100">{view.lead}</p>
      {refusal.error && refusal.error !== view.lead ? (
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{refusal.error}</p>
      ) : null}
      {view.intro ? <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">{view.intro}</p> : null}
      <ul className="mt-2 space-y-2">
        {view.rows.map((row) => (
          <li key={row.id} className="rounded-xl bg-white p-3 dark:bg-zinc-900" data-agent-session-credits-option={row.id}>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.title}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-600 dark:text-zinc-300">{row.blurb}</p>
            <div className="mt-2">
              {row.flow === 'claude-code' || row.flow === 'codex' ? (
                <button type="button" className={ACTION_PRIMARY} onClick={() => openHandoff(row.flow as HandoffAgent)}>
                  {row.cta}
                </button>
              ) : row.hash ? (
                <a className={ACTION} href={row.hash}>{row.cta}</a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-3 text-sm font-semibold text-zinc-600 hover:underline dark:text-zinc-300" onClick={() => dismissCredits()}>
        Dismiss
      </button>
    </section>
  );
}

export function CreditsCard({ refusal }: { refusal: CreditsRefusal }) {
  return <CreditsCardView refusal={refusal} view={creditsView(refusal, viewerContext())} />;
}
