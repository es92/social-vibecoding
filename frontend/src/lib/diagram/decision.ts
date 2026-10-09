/**
 * A group decision's diagram (#4490), drawn from its own facts, never from a
 * model: a rename draws its old name → new name, a secret change what it
 * changes, closing a request the request and the reason. The facts are the
 * few fields the server names one by one (routes/workshop-overview.js
 * decisionFacts, app-view.js `_decisionFacts`); anything else draws nothing.
 */

import type { DiagramRecord } from './types';

export type DecisionFacts =
  | { kind: 'rename'; newName: string; fromName?: string | null }
  | { kind: 'close_issue'; issueNumber: number | null; issueTitle: string | null; reason: string | null }
  | { kind: 'secret_change'; key: string; action: 'set' | 'delete' };

/** Cut a phrase to the record's 60 characters, on a word where it can. */
function fit(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 30 ? cut.slice(0, at) : cut).trim()}…`;
}

export function decisionDiagram(facts: DecisionFacts | null | undefined, appName: string | null | undefined): DiagramRecord | null {
  if (!facts || typeof facts !== 'object') return null;
  if (facts.kind === 'rename') {
    const to = typeof facts.newName === 'string' ? fit(facts.newName) : '';
    const old = typeof facts.fromName === 'string' && facts.fromName.trim() ? facts.fromName : appName;
    const from = typeof old === 'string' ? fit(old) : '';
    if (!to || !from || from === to) return null;
    return { version: 1, kind: 'rename', from, to, places: ['Project name'] };
  }
  if (facts.kind === 'close_issue') {
    const title = facts.issueTitle ? fit(facts.issueTitle) : null;
    const what = facts.issueNumber ? fit(`#${facts.issueNumber}${title ? ` ${title}` : ''}`) : title;
    if (!what) return null;
    return {
      version: 1,
      kind: 'changes',
      rows: [{ op: 'removed', what, ...(facts.reason ? { detail: fit(facts.reason) } : {}) }],
    };
  }
  if (facts.kind === 'secret_change') {
    const key = typeof facts.key === 'string' ? fit(facts.key) : '';
    if (!key) return null;
    return {
      version: 1,
      kind: 'changes',
      rows: [facts.action === 'delete'
        ? { op: 'removed', what: key, detail: 'A secret setting' }
        : { op: 'changed', what: key, detail: 'A secret setting, value not shown' }],
    };
  }
  return null;
}
