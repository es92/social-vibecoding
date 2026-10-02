'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';

// The Homeroom bot console's Benchmark area (#admin/homeroom-bot/benchmark),
// #3654. Rendered by admin-homeroom-bot.tsx under its Benchmark tab, so it
// lives in that section's host and needs no host of its own.
//
// Four cards, top to bottom, in the order the work goes:
//
//   Suites   the versioned task sets (frozen core, rotating set), how full
//            each is against the first version's targets, freeze / new
//            version, the tasks of the one selected, the stratified
//            sampler, and importing a merged pull request as a build task.
//   Run      the launcher: suite, models (with what the catalog says of
//            each: context window, price, the stages it is entered for),
//            stages, repeats, the dollar cap ($50 unless changed).
//   Runs     progress, spend against the cap, cancel.
//   Results  per stage and model: accuracy, pass^k, cost per attempt and per
//            success, p50/p95 time, timeouts and platform faults apart,
//            the paired difference from the baseline with its 95% interval,
//            a cost-vs-quality chart with the Pareto frontier, slices by a
//            tag, judge agreement, the spot check, and the CSV.
//
// PERMISSIONS: any admin reads; every button that writes is gated on
// AdminConsole.canWrite() here and requireAdminWrite on the server
// (routes/homeroom-bench.js). Grading itself happens in an admin's own
// Claude session through the connector, not here; this screen only shows
// the judge's grades and lets a person override one.

const BASE = '/api/admin/homeroom-bot/bench';

type Stage = 'triage' | 'spec' | 'build' | 'followup' | 'checks_fix' | 'dm';
const STAGE_LABEL: Record<Stage, string> = {
  triage: 'Triage', spec: 'Spec', build: 'Build', followup: 'Follow-up', checks_fix: 'Checks fix', dm: 'DM',
};
const STAGES: Stage[] = ['triage', 'spec', 'build', 'followup', 'checks_fix', 'dm'];

interface Suite {
  id: number; name: string; version: number; kind: 'frozen' | 'rotating'; notes: string | null;
  frozen_at: string | null; counts: Record<string, number>; total: number; labelled: number; created_by: string | null;
}
interface Task {
  id: number; stage: Stage; issue_number: number | null; app_slug: string | null; tags: Record<string, unknown>;
  reference: Record<string, unknown>; reference_source: string | null; snapshot_source: string | null;
}
interface Model {
  id: string; label: string; role: string | null; stages: string[] | null; contextTokens: number | null;
  inputPerMillion: number | null; outputPerMillion: number | null; inCatalog: boolean;
}
interface Run {
  id: number; suite_name: string; suite_version: number; models: string[]; baseline_model: string; stages: string[];
  repeats: number; cap_usd: number; spent_usd: number; status: string; counts: Record<string, number>;
  created_at: string; started_by: string | null; note: string | null;
}
interface Row {
  stage: Stage; model: string; baseline: boolean; trials: number; graded: number; pass: number; pending: number;
  unlabelled: number; notApplicable: number; skippedCap: number; accuracy: number | null;
  passK: { k: number; tasks: number; value: number | null }; costUsd: number; costPerTask: number | null; costPerAttempt: number | null;
  costPerSuccess: number | null; p50Ms: number | null; p95Ms: number | null; timeoutRate: number | null; infraRate: number | null;
}
interface Paired { stage: Stage; model: string; baselineModel: string; n: number; apps: number; diff: number | null; low: number | null; high: number | null }
interface Point { key: string; stage: Stage; model: string; cost: number | null; accuracy: number | null; frontier: boolean }
interface Report {
  run: { id: number; status: string; capUsd: number; spentUsd: number; baseline: string; suiteName: string; suiteVersion: number; suiteFrozen: boolean; repeats: number; stages: Stage[] };
  rows: Row[]; paired: Paired[]; pareto: Point[];
  slice: { key: string; keys: string[]; groups: { stage: Stage; model: string; value: string; n: number; accuracy: number | null }[] };
  agreement: { n: number; agreement: number | null; tpr: number | null; tnr: number | null };
}
interface Review {
  trialId: number;
  item: { stage: Stage; task: { request: string; issueTitle: string | null }; candidate: Record<string, unknown>; reference: Record<string, unknown> };
  opus: { verdict: string; critique: string | null } | null;
  human: { verdict: string; critique: string | null } | null;
}
type Tone = 'ok' | 'err';

// The results table is the console's densest: seven columns of two-line
// cells at 1280px. The recipes' 1.5rem side padding leaves room for five, so
// this one table draws tighter cells (the recipe's colours, less padding).
const DENSE_TH = 'px-3 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400';
const DENSE_TD = 'px-3 py-3 align-top';

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'not yet' : `${Math.round(v * 100)}%`;
}
function usd(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(Number(v)) ? 'not yet' : `$${Number(v).toFixed(digits)}`;
}
function secs(ms: number | null | undefined): string {
  return ms == null || !Number.isFinite(ms) ? 'not yet' : `${Math.round(ms / 1000)}s`;
}
function shortModel(id: string, models: Model[]): string {
  return models.find((m) => m.id === id)?.label || id;
}
function done(r: Run): number {
  const c = r.counts || {};
  return ['ok', 'model_fail', 'infra_fail', 'timeout', 'not_applicable', 'skipped_cap', 'cancelled'].reduce((s, k) => s + (c[k] || 0), 0);
}
function total(r: Run): number {
  return Object.values(r.counts || {}).reduce((s, n) => s + n, 0);
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * Cost per attempt against accuracy, one point per model, for one stage. Model
 * identity is the direct label beside each point, not a colour; the Pareto
 * frontier is the filled points and the line through them. A native title
 * on each point is its tooltip; the results table above is its table view.
 */
export function ParetoChart({ points, models }: { points: Point[]; models: Model[] }) {
  const usable = points.filter((p) => p.cost != null && p.accuracy != null) as (Point & { cost: number; accuracy: number })[];
  if (!usable.length) return <p className={AdminUI.muted} id="admin-homeroom-bench-pareto-empty">No graded results at this stage yet.</p>;
  const W = 560; const H = 260; const L = 48; const R = 150; const T = 14; const B = 36;
  const maxCost = Math.max(...usable.map((p) => p.cost)) * 1.1 || 1;
  const x = (c: number) => L + (c / maxCost) * (W - L - R);
  const y = (a: number) => T + (1 - a) * (H - T - B);
  const frontier = usable.filter((p) => p.frontier).sort((a, b) => a.cost - b.cost);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl h-auto text-zinc-500 dark:text-zinc-400" role="img"
      aria-labelledby="admin-homeroom-bench-pareto-title" id="admin-homeroom-bench-pareto">
      <title id="admin-homeroom-bench-pareto-title">Cost per attempt against accuracy; filled points are the Pareto frontier</title>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor">{`${t * 100}%`}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={x(maxCost * f)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="currentColor">{`$${(maxCost * f).toFixed(maxCost * f < 1 ? 2 : 1)}`}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="currentColor">Cost per attempt</text>
      {frontier.length > 1 ? (
        <polyline points={frontier.map((p) => `${x(p.cost)},${y(p.accuracy)}`).join(' ')}
          fill="none" stroke="#2a78d6" strokeWidth="2" strokeOpacity="0.6" />
      ) : null}
      {usable.map((p) => (
        <g key={p.key} data-pareto-point={p.model} data-frontier={p.frontier ? 'true' : 'false'}>
          <title>{`${shortModel(p.model, models)}: ${pct(p.accuracy)} at ${usd(p.cost, 3)} an attempt${p.frontier ? ', on the frontier' : ''}`}</title>
          <circle cx={x(p.cost)} cy={y(p.accuracy)} r="9" fill="transparent" />
          <circle cx={x(p.cost)} cy={y(p.accuracy)} r="5" strokeWidth="2"
            stroke={p.frontier ? '#2a78d6' : 'currentColor'} fill={p.frontier ? '#2a78d6' : 'none'} />
          <text x={x(p.cost) + 9} y={y(p.accuracy) + 4} fontSize="11" className="fill-zinc-700 dark:fill-zinc-300">{shortModel(p.model, models)}</text>
        </g>
      ))}
    </svg>
  );
}

function SuitesCard({ canWrite, suites, onChanged, say }: {
  canWrite: boolean; suites: Suite[]; onChanged: () => void; say: (text: string, tone?: Tone) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'frozen' | 'rotating'>('frozen');
  const [sampleStage, setSampleStage] = useState<Stage>('triage');
  const [sampleN, setSampleN] = useState('10');
  const [candidates, setCandidates] = useState<{ id: number; appSlug: string; issueNumber: number; tags: Record<string, string> }[] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [imp, setImp] = useState({ appSlug: '', issueNumber: '', prNumber: '' });
  const suite = suites.find((s) => s.id === selected) || null;

  const loadTasks = useCallback(async (id: number) => {
    try {
      const data = await send(`${BASE}/suites/${id}/tasks`, 'GET');
      setTasks(data.tasks || []);
    } catch (err: any) { say(`Could not read the tasks: ${err.message}`, 'err'); }
  }, [say]);
  useEffect(() => { if (selected) loadTasks(selected); else setTasks(null); }, [selected, loadTasks]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); say(ok); onChanged(); if (selected) loadTasks(selected); } catch (err: any) { say(err.message, 'err'); }
  };
  const target = (s: Suite, stage: string, want: number) => `${STAGE_LABEL[stage as Stage] || stage} ${s.counts?.[stage] || 0} of ${want}`;

  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-suites">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Suites</h3>
        <span className={AdminUI.cardDescription}>Tasks drawn from real runs; a frozen suite never changes</span>
      </div>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-homeroom-bench-suite-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Suite</th>
              <th className={AdminUI.th}>Tasks</th>
              <th className={AdminUI.th}>Labelled</th>
              <th className={AdminUI.th}>State</th>
            </tr>
          </thead>
          <tbody>
            {suites.map((s) => (
              <tr className={AdminUI.trHover} key={s.id} data-bench-suite={s.id}>
                <td className={AdminUI.td}>
                  <button type="button" className={AdminUI.btn.link} onClick={() => setSelected(selected === s.id ? null : s.id)}>
                    {`${s.name} v${s.version}`}
                  </button>
                  <div className={AdminUI.muted}>{s.kind === 'rotating' ? 'Rotating set' : 'Core'}</div>
                </td>
                <td className={`${AdminUI.td} text-sm`}>
                  {s.kind === 'rotating'
                    ? `${s.total} of 20`
                    : [target(s, 'triage', 40), target(s, 'build', 20), `Follow-ups ${(s.counts?.followup || 0) + (s.counts?.checks_fix || 0)} of 5`, target(s, 'dm', 5)].join(' · ')}
                </td>
                <td className={AdminUI.td}>{`${s.labelled} of ${s.total}`}</td>
                <td className={AdminUI.td}>
                  {s.frozen_at ? <span className={AdminUI.badge.outline}>Frozen</span> : <span className={AdminUI.badge.secondary}>Open</span>}
                  {canWrite ? (
                    <span className="ml-2 inline-flex gap-1">
                      {!s.frozen_at ? (
                        <button type="button" className={AdminUI.btn.outlineSm}
                          onClick={() => act(() => send(`${BASE}/suites/${s.id}/freeze`, 'POST', {}), `${s.name} v${s.version} is frozen.`)}>Freeze</button>
                      ) : null}
                      <button type="button" className={AdminUI.btn.outlineSm}
                        onClick={() => act(() => send(`${BASE}/suites/${s.id}/version`, 'POST', {}), `A new version of ${s.name}, open for edits.`)}>New version</button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {!suites.length ? (
              <tr><td className={AdminUI.td} colSpan={4} id="admin-homeroom-bench-suites-empty">No suites yet. Make one below, then add runs to it from the verdicts table or the sampler.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2 mt-4">
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-suite-name">New suite</label>
            <input id="admin-homeroom-bench-suite-name" className={`${AdminUI.input} mt-1`} value={name} maxLength={80}
              placeholder="core" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-suite-kind">Kind</label>
            <select id="admin-homeroom-bench-suite-kind" className={`${AdminUI.select} mt-1`} value={kind}
              onChange={(e) => setKind(e.target.value as 'frozen' | 'rotating')}>
              <option value="frozen">Core (versioned)</option>
              <option value="rotating">Rotating set</option>
            </select>
          </div>
          <button type="button" className={AdminUI.btn.primarySm} disabled={!name.trim()}
            onClick={() => act(() => send(`${BASE}/suites`, 'POST', { name, kind }), 'Suite made.').then(() => setName(''))}>Make suite</button>
        </div>
      ) : null}

      {suite ? (
        <div className="mt-4 space-y-3" id="admin-homeroom-bench-tasks">
          <div className={AdminUI.separator} />
          <p className={AdminUI.label}>{`Tasks in ${suite.name} v${suite.version}`}</p>
          {tasks == null ? <p className={AdminUI.loading}>Loading…</p> : (
            <div className={AdminUI.tableWrap}>
              <table className={AdminUI.table}>
                <thead className={AdminUI.thead}>
                  <tr>
                    <th className={AdminUI.th}>Stage</th><th className={AdminUI.th}>Request</th>
                    <th className={AdminUI.th}>Tags</th><th className={AdminUI.th}>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr className={AdminUI.trHover} key={t.id} data-bench-task={t.id}>
                      <td className={AdminUI.td}>{STAGE_LABEL[t.stage]}</td>
                      <td className={AdminUI.td}>{`${t.app_slug || 'an app no longer here'} #${t.issue_number ?? ''}`}{t.snapshot_source === 'import' ? <span className={`${AdminUI.badge.outline} ml-1`}>from a PR</span> : null}</td>
                      <td className={`${AdminUI.td} text-sm`}>{['verdict', 'repo_size', 'request_type', 'difficulty'].map((k) => t.tags?.[k]).filter(Boolean).join(' · ')}</td>
                      <td className={`${AdminUI.td} text-sm`}>
                        {t.reference_source ? `${String(t.reference?.verdict || t.reference?.action || (t.reference?.reference_pr ? `PR #${t.reference.reference_pr}` : 'set'))} (by ${t.reference_source === 'opus' ? 'the judge' : t.reference_source === 'merged_pr' ? 'a merged PR' : 'a person'})` : 'Waiting for its label'}
                        {canWrite && !suite.frozen_at ? (
                          <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`}
                            onClick={() => act(() => send(`${BASE}/tasks/${t.id}`, 'DELETE'), 'Task removed.')}>remove</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!tasks.length ? <tr><td className={AdminUI.td} colSpan={4}>No tasks yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && !suite.frozen_at ? (
            <>
              <div className="flex flex-wrap items-end gap-2" id="admin-homeroom-bench-sampler">
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-sample-stage">Propose tasks at</label>
                  <select id="admin-homeroom-bench-sample-stage" className={`${AdminUI.select} mt-1`} value={sampleStage}
                    onChange={(e) => setSampleStage(e.target.value as Stage)}>
                    {STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
                  </select>
                </div>
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-sample-n">How many</label>
                  <input id="admin-homeroom-bench-sample-n" type="number" min="1" max="100" className={`${AdminUI.input} mt-1 w-24`}
                    value={sampleN} onChange={(e) => setSampleN(e.target.value)} />
                </div>
                <button type="button" className={AdminUI.btn.outlineSm} onClick={async () => {
                  try {
                    const data = await send(`${BASE}/sample?suiteId=${suite.id}&stage=${sampleStage}&n=${Number(sampleN) || 10}`, 'GET');
                    setCandidates(data.picked || []);
                    setPicked(Object.fromEntries((data.picked || []).map((c: { id: number }) => [c.id, true])));
                    say(`${(data.picked || []).length} proposed from ${data.available} runs that can be replayed, balanced across verdicts, apps and repository sizes.`);
                  } catch (err: any) { say(err.message, 'err'); }
                }}>Propose</button>
              </div>
              {candidates ? (
                <div className="space-y-1">
                  {candidates.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!picked[c.id]} onChange={(e) => setPicked({ ...picked, [c.id]: e.target.checked })} />
                      <span>{`${c.appSlug} #${c.issueNumber}`}</span>
                      <span className={AdminUI.muted}>{[c.tags.verdict, c.tags.repo_size, c.tags.known_outcome].filter(Boolean).join(' · ')}</span>
                    </label>
                  ))}
                  {candidates.length ? (
                    <button type="button" className={AdminUI.btn.primarySm} onClick={() => act(async () => {
                      const ids = candidates.filter((c) => picked[c.id]).map((c) => c.id);
                      await send(`${BASE}/suites/${suite.id}/tasks`, 'POST', { runIds: ids, stage: sampleStage });
                      setCandidates(null);
                    }, 'Added to the suite.')}>Add the ticked ones</button>
                  ) : <p className={AdminUI.muted}>Nothing to propose: no recorded run at that stage can be replayed yet.</p>}
                </div>
              ) : null}
              <div className="flex flex-wrap items-end gap-2" id="admin-homeroom-bench-import">
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-app">Build task from a merged PR: app</label>
                  <input id="admin-homeroom-bench-import-app" className={`${AdminUI.input} mt-1`} value={imp.appSlug} placeholder="app slug"
                    onChange={(e) => setImp({ ...imp, appSlug: e.target.value })} />
                </div>
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-issue">Request #</label>
                  <input id="admin-homeroom-bench-import-issue" className={`${AdminUI.input} mt-1 w-28`} value={imp.issueNumber}
                    onChange={(e) => setImp({ ...imp, issueNumber: e.target.value })} />
                </div>
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-pr">PR #</label>
                  <input id="admin-homeroom-bench-import-pr" className={`${AdminUI.input} mt-1 w-28`} value={imp.prNumber}
                    onChange={(e) => setImp({ ...imp, prNumber: e.target.value })} />
                </div>
                <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(async () => {
                  const data = await send(`${BASE}/suites/${suite.id}/import-pr`, 'POST', {
                    appSlug: imp.appSlug.trim(), issueNumber: Number(imp.issueNumber), prNumber: Number(imp.prNumber),
                  });
                  setImp({ appSlug: imp.appSlug, issueNumber: '', prNumber: '' });
                  return data;
                }, 'Imported: the request as it stood when the PR opened, its base commit, and the checks it added as hidden checks.')}>Import</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Launcher({ suites, models, defaults, hiddenChecks, onLaunched, say }: {
  suites: Suite[]; models: Model[]; defaults: { capUsd: number; repeats: number; maxConcurrency: number };
  hiddenChecks: string; onLaunched: () => void; say: (text: string, tone?: Tone) => void;
}) {
  const [suiteId, setSuiteId] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState('');
  const [stages, setStages] = useState<Record<string, boolean>>({ triage: true });
  const [repeats, setRepeats] = useState(String(defaults.repeats));
  const [cap, setCap] = useState(String(defaults.capUsd));
  const [concurrency, setConcurrency] = useState('1');
  useEffect(() => {
    if (!suiteId && suites.length) setSuiteId(String((suites.find((s) => s.frozen_at) || suites[0]).id));
  }, [suites, suiteId]);
  const suite = suites.find((s) => String(s.id) === suiteId);
  const launch = async () => {
    const ids = [...Object.keys(chosen).filter((k) => chosen[k]), ...extra.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)];
    try {
      const data = await send(`${BASE}/runs`, 'POST', {
        suiteId: Number(suiteId), models: ids, stages: Object.keys(stages).filter((k) => stages[k]),
        repeats: Number(repeats), capUsd: Number(cap), concurrency: Number(concurrency),
      });
      say(`Run ${data.run.id} launched: ${data.trials} trials (${data.notApplicable} not applicable), estimated $${data.estimateUsd} against a $${Number(data.run.cap_usd).toFixed(2)} cap.${data.suiteFrozen ? '' : ' The suite is not frozen, so these results describe a set that can still change.'}`);
      onLaunched();
    } catch (err: any) { say(`Not launched: ${err.message}`, 'err'); }
  };
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-launch">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Run a benchmark</h3>
        <span className={AdminUI.cardDescription}>Same prompts, worker and clocks as the bot; nothing is posted</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-suite">Suite</label>
          <select id="admin-homeroom-bench-launch-suite" className={`${AdminUI.select} mt-1`} value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
            {suites.map((s) => <option key={s.id} value={s.id}>{`${s.name} v${s.version}${s.frozen_at ? '' : ' (not frozen)'}`}</option>)}
          </select>
          <p className={`${AdminUI.label} mt-3`}>Stages</p>
          <div className="flex flex-wrap gap-3 mt-1">
            {STAGES.map((st) => (
              <label key={st} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={!!stages[st]} onChange={(e) => setStages({ ...stages, [st]: e.target.checked })} />
                <span>{`${STAGE_LABEL[st]}${suite ? ` (${suite.counts?.[st] || 0})` : ''}`}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-repeats">Repeats</label>
              <input id="admin-homeroom-bench-launch-repeats" type="number" min="1" max="5" className={`${AdminUI.input} mt-1`}
                value={repeats} onChange={(e) => setRepeats(e.target.value)} />
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-cap">Cap, dollars</label>
              <input id="admin-homeroom-bench-launch-cap" type="number" min="0.5" max="1000" step="1" className={`${AdminUI.input} mt-1`}
                value={cap} onChange={(e) => setCap(e.target.value)} />
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-concurrency">At once</label>
              <select id="admin-homeroom-bench-launch-concurrency" className={`${AdminUI.select} mt-1`} value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}>
                {Array.from({ length: defaults.maxConcurrency }, (_, i) => String(i + 1)).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <p className={`${AdminUI.muted} mt-2`}>
            Repeats apply to triage, DM and follow-ups (pass^k is read from them); builds and specs run once per model.
            Scheduling stops before a trial that would cross the cap, and the rest are skipped. The bench waits while the bot is using every build slot.
          </p>
          <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bench-hidden-checks">{`Build trials: ${hiddenChecks}.`}</p>
        </div>
        <div>
          <p className={AdminUI.label}>Models</p>
          <div className="mt-1 space-y-1" id="admin-homeroom-bench-models">
            {models.map((m) => (
              <label key={m.id} className="flex items-start gap-2 text-sm" data-bench-model={m.id}>
                <input type="checkbox" className="mt-1" checked={!!chosen[m.id]} onChange={(e) => setChosen({ ...chosen, [m.id]: e.target.checked })} />
                <span>
                  <span className="font-medium">{m.label}</span>
                  {m.role ? <span className={`${AdminUI.badge.outline} ml-1`}>{m.role}</span> : null}
                  <span className={`${AdminUI.muted} block`}>
                    {[
                      m.id,
                      m.contextTokens ? `${Math.round(m.contextTokens / 1000)}K context` : 'context unknown',
                      m.inputPerMillion != null && m.outputPerMillion != null ? `$${m.inputPerMillion.toFixed(2)} in, $${m.outputPerMillion.toFixed(2)} out per million` : 'price unknown until a trial runs',
                      m.stages ? `${m.stages.join(' and ')} only` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <label className={`${AdminUI.label} block mt-3`} htmlFor="admin-homeroom-bench-launch-extra">Other OpenRouter models</label>
          <input id="admin-homeroom-bench-launch-extra" className={`${AdminUI.input} mt-1`} value={extra} placeholder="vendor/model, vendor/model"
            onChange={(e) => setExtra(e.target.value)} />
          <button type="button" className={`${AdminUI.btn.primary} mt-4`} id="admin-homeroom-bench-launch-go" disabled={!suiteId} onClick={launch}>Launch</button>
        </div>
      </div>
    </div>
  );
}

function Results({ runId, models, canWrite, say }: { runId: number; models: Model[]; canWrite: boolean; say: (text: string, tone?: Tone) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [slice, setSlice] = useState('verdict');
  const [stage, setStage] = useState<Stage | ''>('');
  const [review, setReview] = useState<Review[] | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await send(`${BASE}/runs/${runId}/report?slice=${slice}`, 'GET');
      setReport(data);
      setStage((s) => s || (data.run.stages?.[0] ?? ''));
    } catch (err: any) { say(`Could not read the results: ${err.message}`, 'err'); }
  }, [runId, slice, say]);
  useEffect(() => { load(); }, [load]);
  const loadReview = async () => {
    try { setReview((await send(`${BASE}/runs/${runId}/review?limit=10`, 'GET')).items || []); } catch (err: any) { say(err.message, 'err'); }
  };
  const override = async (trialId: number, verdict: 'pass' | 'fail') => {
    try {
      await send(`${BASE}/trials/${trialId}/grade`, 'POST', { verdict, critique: 'Spot check in the console.' });
      say(`Graded ${verdict} by a person: it overrides the judge.`);
      loadReview(); load();
    } catch (err: any) { say(err.message, 'err'); }
  };
  if (!report) return <p className={AdminUI.loading} id="admin-homeroom-bench-results-loading">Loading…</p>;
  const name = (id: string) => shortModel(id, models);
  const a = report.agreement;
  return (
    <div className="space-y-4" id="admin-homeroom-bench-report">
      <p className={AdminUI.muted}>
        {`${report.run.suiteName} v${report.run.suiteVersion}${report.run.suiteFrozen ? '' : ' (not frozen)'}, baseline ${name(report.run.baseline)}. `}
        {`${usd(report.run.spentUsd)} of a ${usd(report.run.capUsd)} cap. Platform faults are kept out of accuracy; a timeout counts as a fail.`}
      </p>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-homeroom-bench-results-table">
          <thead className={AdminUI.thead}>
            <tr>
              {['Stage and model', 'Accuracy', 'pass^k', 'Cost', 'Time', 'Faults', 'Not graded'].map((h) => (
                <th className={DENSE_TH} key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => {
              const notApplicable = r.trials > 0 && r.notApplicable === r.trials;
              return (
                <tr className={AdminUI.trHover} key={`${r.stage}-${r.model}`} data-bench-row={`${r.stage}:${r.model}`}>
                  <td className={DENSE_TD}>
                    <span className="font-medium">{name(r.model)}</span>
                    {r.baseline ? <span className={`${AdminUI.badge.outline} ml-1`}>baseline</span> : null}
                    <span className={`${AdminUI.muted} block`}>{STAGE_LABEL[r.stage]}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? 'not applicable' : pct(r.accuracy)}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${r.pass} of ${r.graded} graded`}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : r.passK.k > 1 ? pct(r.passK.value) : 'once each'}
                    <span className={`${AdminUI.muted} block`}>{!notApplicable && r.passK.k > 1 ? `all ${r.passK.k} right, of ${r.passK.tasks} tasks` : ''}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : `${usd(r.costPerAttempt, 3)} an attempt`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : r.costPerSuccess == null ? 'no success yet' : `${usd(r.costPerSuccess, 3)} a success`}</span>
                  </td>
                  <td className={`${DENSE_TD} whitespace-nowrap`}>
                    {notApplicable ? '' : `${secs(r.p50Ms)} median`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${secs(r.p95Ms)} p95`}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : `${pct(r.timeoutRate)} timed out`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${pct(r.infraRate)} platform`}</span>
                  </td>
                  <td className={`${DENSE_TD} text-sm`}>
                    {[r.pending ? `${r.pending} for the judge` : null, r.unlabelled ? `${r.unlabelled} unlabelled` : null,
                      r.notApplicable ? `${r.notApplicable} not applicable` : null, r.skippedCap ? `${r.skippedCap} skipped at the cap` : null]
                      .filter(Boolean).join(', ')}
                  </td>
                </tr>
              );
            })}
            {!report.rows.length ? <tr><td className={DENSE_TD} colSpan={7}>No trials yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div>
        <p className={AdminUI.label}>Against the baseline</p>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bench-paired">
            <thead className={AdminUI.thead}>
              <tr>{['Stage', 'Model', 'Difference', '95% interval', 'Tasks (apps)'].map((h) => <th className={AdminUI.th} key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {report.paired.filter((p) => p.n > 0).map((p) => (
                <tr className={AdminUI.trHover} key={`${p.stage}-${p.model}`}>
                  <td className={AdminUI.td}>{STAGE_LABEL[p.stage]}</td>
                  <td className={AdminUI.td}>{name(p.model)}</td>
                  <td className={AdminUI.td}>{p.diff == null ? 'not yet' : `${p.diff >= 0 ? '+' : ''}${Math.round(p.diff * 100)} points`}</td>
                  <td className={AdminUI.td}>{p.low == null || p.high == null ? 'not yet' : `${Math.round(p.low * 100)} to ${Math.round(p.high * 100)}`}</td>
                  <td className={AdminUI.td}>{`${p.n} (${p.apps})`}</td>
                </tr>
              ))}
              {!report.paired.length ? <tr><td className={AdminUI.td} colSpan={5}>Only the baseline ran.</td></tr> : null}
              {report.paired.length && !report.paired.some((p) => p.n > 0) ? <tr><td className={AdminUI.td} colSpan={5}>No task is graded on both a model and the baseline yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className={`${AdminUI.muted} mt-1`}>Each task scored on both models (the mean of its attempts); the interval resamples apps, not tasks, so one busy app cannot make it look surer than it is.</p>
      </div>

      <div>
        <div className="flex flex-wrap items-end gap-2">
          <p className={AdminUI.label}>Cost against quality</p>
          <div className="w-48">
            <select aria-label="Stage for the chart" className={AdminUI.select} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {report.run.stages.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
            </select>
          </div>
        </div>
        <ParetoChart points={report.pareto.filter((p) => p.stage === stage)} models={models} />
      </div>

      <div>
        <div className="flex flex-wrap items-end gap-2">
          <p className={AdminUI.label}>Slices by</p>
          <div className="w-48">
            <select aria-label="Tag to slice by" className={AdminUI.select} value={slice} onChange={(e) => setSlice(e.target.value)} id="admin-homeroom-bench-slice">
              {report.slice.keys.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
            </select>
          </div>
        </div>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bench-slices">
            <thead className={AdminUI.thead}><tr>{['Stage', report.slice.key.replace('_', ' '), 'Model', 'Accuracy'].map((h) => <th className={AdminUI.th} key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {report.slice.groups.filter((g) => g.n > 0).map((g) => (
                <tr className={AdminUI.trHover} key={`${g.stage}-${g.value}-${g.model}`}>
                  <td className={AdminUI.td}>{STAGE_LABEL[g.stage]}</td>
                  <td className={AdminUI.td}>{g.value}</td>
                  <td className={AdminUI.td}>{name(g.model)}</td>
                  <td className={AdminUI.td}>{`${pct(g.accuracy)} of ${g.n}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div id="admin-homeroom-bench-judge">
        <p className={AdminUI.label}>The judge</p>
        <p className={AdminUI.muted} id="admin-homeroom-bench-agreement">
          {a.n
            ? `Agrees with people on ${pct(a.agreement)} of the ${a.n} trials a person also graded. Of those a person passed, it passed ${pct(a.tpr)}; of those a person failed, it failed ${pct(a.tnr)}.`
            : 'No person has spot-checked the judge on this run yet.'}
          {' Grades come from an admin\'s Claude session through the Homeroom connector: ask it to "grade the pending benchmark items".'}
        </p>
        <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={loadReview} id="admin-homeroom-bench-spot-check">Spot-check judged trials</button>
        {review ? (
          <div className="mt-2 space-y-3">
            {review.map((r) => (
              <div key={r.trialId} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 text-sm" data-bench-review={r.trialId}>
                <p className="font-medium">{`${STAGE_LABEL[r.item.stage]}: ${r.item.task.issueTitle || 'a request'}`}</p>
                <details className="mt-1">
                  <summary className={`${AdminUI.muted} cursor-pointer`}>What the candidate said (model hidden)</summary>
                  <pre className="whitespace-pre-wrap break-words text-xs mt-1">{JSON.stringify(r.item.candidate, null, 1)}</pre>
                  <p className={`${AdminUI.muted} mt-1`}>{`Reference: ${JSON.stringify(r.item.reference)}`}</p>
                </details>
                <p className="mt-1">{`Judge: ${r.opus?.verdict || 'not graded'}. ${r.opus?.critique || ''}`}</p>
                {r.human ? <p className={AdminUI.muted}>{`A person said ${r.human.verdict}.`}</p> : null}
                {canWrite ? (
                  <span className="inline-flex gap-1 mt-1">
                    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(r.trialId, 'pass')}>Pass</button>
                    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(r.trialId, 'fail')}>Fail</button>
                  </span>
                ) : null}
              </div>
            ))}
            {!review.length ? <p className={AdminUI.muted}>Nothing judged on this run yet.</p> : null}
          </div>
        ) : null}
      </div>
      {canWrite ? (
        <a className={AdminUI.btn.outlineSm} href={`${BASE}/runs/${runId}/trials.csv`} download id="admin-homeroom-bench-csv">Download trials as CSV</a>
      ) : null}
    </div>
  );
}

export function BenchmarkArea({ canWrite }: { canWrite: boolean }) {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [defaults, setDefaults] = useState({ capUsd: 50, repeats: 3, maxConcurrency: 2 });
  const [hiddenChecks, setHiddenChecks] = useState('');
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const say = useCallback((text: string, tone: Tone = 'ok') => { if (alive.current) setStatus({ text, tone }); }, []);

  const load = useCallback(async () => {
    try {
      const [s, r, m] = await Promise.all([send(`${BASE}/suites`, 'GET'), send(`${BASE}/runs`, 'GET'), send(`${BASE}/models`, 'GET')]);
      if (!alive.current) return;
      setSuites(s.suites || []);
      setRuns(r.runs || []);
      setDefaults(r.defaults || defaults);
      setHiddenChecks(r.hiddenChecks || '');
      setModels(m.models || []);
      setSelectedRun((cur) => cur ?? (r.runs?.[0]?.id ?? null));
    } catch (err: any) { say(`Could not read the benchmark: ${err.message}`, 'err'); }
  }, [say]);
  useEffect(() => { load(); }, [load]);
  // A run in progress moves; a slow poll keeps its row honest.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if ((runs || []).some((r) => r.status === 'queued' || r.status === 'running')) load();
    }, 20_000);
    return () => window.clearInterval(handle);
  }, [runs, load]);

  return (
    <div className="space-y-4" id="admin-homeroom-bench">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Benchmark</h2>
          <span className={AdminUI.cardDescription}>Which model each stage of the bot should run on</span>
        </div>
        <p className={AdminUI.muted} id="admin-homeroom-bench-intro">
          Real requests the bot has seen, replayed on other models with the bot's own prompts, worker and clocks. Nothing is
          posted, messaged or proposed, and every run stops at its dollar cap. Results are graded by rules where a rule can
          tell, and otherwise by Claude Opus on an admin's own plan through the Homeroom connector, blind to the model.
        </p>
        {status ? <p className={`mt-2 text-sm ${status.tone === 'err' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`} role="status">{status.text}</p> : null}
      </div>

      <SuitesCard canWrite={canWrite} suites={suites} onChanged={load} say={say} />
      {canWrite && suites.length ? (
        <Launcher suites={suites} models={models} defaults={defaults} hiddenChecks={hiddenChecks} onLaunched={load} say={say} />
      ) : null}

      <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-runs">
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Runs</h3>
        </div>
        {runs == null ? <p className={AdminUI.loading}>Loading…</p> : (
          <div className={AdminUI.tableWrap}>
            <table className={AdminUI.table} id="admin-homeroom-bench-run-table">
              <thead className={AdminUI.thead}>
                <tr>{['Run', 'Suite', 'Models', 'Progress', 'Spent', 'State'].map((h) => <th className={AdminUI.th} key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr className={AdminUI.trHover} key={r.id} data-bench-run={r.id}>
                    <td className={AdminUI.td}>
                      <button type="button" className={AdminUI.btn.link} aria-pressed={selectedRun === r.id} onClick={() => setSelectedRun(r.id)}>{`Run ${r.id}`}</button>
                      {r.note ? <span className={`${AdminUI.muted} block`}>{r.note}</span> : null}
                    </td>
                    <td className={AdminUI.td}>{`${r.suite_name} v${r.suite_version}`}</td>
                    <td className={`${AdminUI.td} text-sm`}>{r.models.map((m) => shortModel(m, models)).join(', ')}</td>
                    <td className={AdminUI.td}>{`${done(r)} of ${total(r)} trials`}</td>
                    <td className={AdminUI.td}>{`${usd(r.spent_usd)} of ${usd(r.cap_usd)}`}</td>
                    <td className={AdminUI.td}>
                      <span className={r.status === 'running' ? AdminUI.badge.secondary : AdminUI.badge.outline}>{r.status}</span>
                      {canWrite && (r.status === 'queued' || r.status === 'running') ? (
                        <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`} onClick={async () => {
                          try { await send(`${BASE}/runs/${r.id}/cancel`, 'POST', {}); say(`Run ${r.id} cancelled.`); load(); } catch (err: any) { say(err.message, 'err'); }
                        }}>cancel</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!runs.length ? <tr><td className={AdminUI.td} colSpan={6} id="admin-homeroom-bench-runs-empty">No runs yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedRun ? (
        <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-results">
          <div className={AdminUI.cardHeader}>
            <h3 className={AdminUI.cardTitle}>{`Results of run ${selectedRun}`}</h3>
          </div>
          <Results key={selectedRun} runId={selectedRun} models={models} canWrite={canWrite} say={say} />
        </div>
      ) : null}
    </div>
  );
}
