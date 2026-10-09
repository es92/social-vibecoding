/**
 * "What it touches" (#4490): the picture a Needs-you card shows when a change
 * has no before & after shots and its author drew no diagram. Made from the
 * change's files by fixed path rules (src/services/proposal-touches.js), so it
 * costs nothing and never fails: which parts of the project the change
 * touches, and how much, plus "Nothing on screen changes" when its author
 * declared so.
 *
 * Drawn like a diagram (the same sheet, label and foot as lib/diagram), one
 * row an area: its name, a bar for the lines changed there, and the files in
 * words. Screens, Server, Database and Tests are always listed, dimmed at
 * "none", because "this changes nothing on screen" is half of what the
 * picture is for; Docs and Other only when something is in them.
 */

import type { KeyboardEvent, ReactNode } from 'react';

import { sourceWords } from '../../../lib/diagram/diagram';

export type Touches = {
  version: 1;
  files: number;
  areas: { key: string; label: string; files: number; lines: number }[];
};

const ALWAYS = new Set(['screens', 'server', 'database', 'tests']);

/** A value as a picture this version draws, or null. */
export function readTouches(v: unknown): Touches | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (t.version !== 1 || !Array.isArray(t.areas)) return null;
  const areas = t.areas
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).key === 'string')
    .map((a) => ({
      key: String(a.key),
      label: typeof a.label === 'string' ? a.label : String(a.key),
      files: Math.max(0, Math.floor(Number(a.files) || 0)),
      lines: Math.max(0, Math.floor(Number(a.lines) || 0)),
    }));
  const files = areas.reduce((n, a) => n + a.files, 0);
  return files ? { version: 1, files, areas } : null;
}

function filesWords(n: number): string {
  if (!n) return 'none';
  return n === 1 ? '1 file' : `${n} files`;
}

export function TouchesPicture({ t, nothingVisible, onOpen }: {
  t: Touches;
  /** The author declared that nothing on screen changes. */
  nothingVisible?: boolean;
  onOpen?: () => void;
}): ReactNode {
  const shown = t.areas.filter((a) => ALWAYS.has(a.key) || a.files > 0);
  const max = Math.max(1, ...shown.map((a) => a.lines || a.files));
  const touched = shown.filter((a) => a.files > 0).map((a) => `${a.label}, ${filesWords(a.files)}`);
  const door = onOpen ? {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
    },
  } : {};
  const foot = sourceWords('files');
  return (
    <div
      className="dev-ws-diagram dev-ws-touches"
      data-ws-touches=""
      data-diagram-source="files"
      aria-label={`What it touches. ${touched.join('; ')}.${nothingVisible ? ' Nothing on screen changes.' : ''}`}
      {...door}
    >
      <span className="dev-ws-diagram-kicker" aria-hidden="true">What it touches</span>
      <ul className="dev-ws-diagram-rows" aria-hidden="true">
        {shown.map((a) => (
          <li key={a.key} className="dev-ws-touches-row" data-touched={a.files > 0 ? '' : undefined}>
            <span className="dev-ws-diagram-what">{a.label}</span>
            <span className="dev-ws-diagram-bar"><i style={{ width: a.files ? `${Math.max(4, Math.round(((a.lines || a.files) / max) * 100))}%` : '0%' }} /></span>
            <span className="dev-ws-touches-n">{filesWords(a.files)}</span>
          </li>
        ))}
      </ul>
      <p className="dev-ws-diagram-src">
        {nothingVisible ? `Nothing on screen changes · ${foot.charAt(0).toLowerCase()}${foot.slice(1)}` : foot}
      </p>
    </div>
  );
}
