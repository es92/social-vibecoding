/**
 * The one diagram renderer (#4490), shared with #4098's explanations: a
 * Needs-you card, a change's page and an explanation all draw a diagram
 * record (./types.ts) through this component.
 *
 * Four fixed kinds drawn with the shell's own tokens (app.css
 * `.dev-ws-diagram*`): the card's type scale, small caps for the one label,
 * and the one accent, where the new word or new step is in the accent blue
 * and the old one muted and struck through. Nothing is filled green or red.
 * The Mermaid kind is drawn by the vendored library on demand (./mermaid.ts);
 * until it is drawn the space stays empty, and when it cannot be drawn
 * `onFail` is called so the caller can fall back ("What it touches" on a
 * card, a muted line and the source on a page).
 *
 * Every word here is text React escapes. The only markup inserted as HTML is
 * Mermaid's SVG after DOMPurify has cleaned it.
 */

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

import { DIAGRAM_LABELS, diagramText, figure, type DiagramRecord, type DiagramSource } from './types';
import { renderMermaid } from './mermaid';

export { readDiagram, DIAGRAM_LABELS, diagramText } from './types';
export type { DiagramRecord, DiagramSource } from './types';
export { decisionDiagram, type DecisionFacts } from './decision';

/** The foot under a picture: where it came from. */
export function sourceWords(source: DiagramSource, mermaid = false): string {
  if (source === 'decision') return 'From the group decision';
  if (source === 'files') return 'Drawn from the change’s files';
  return `Diagram by the change’s author${mermaid ? ' · Mermaid' : ''}`;
}

function Arrow(): ReactNode {
  return <span className="dev-ws-diagram-arrow" aria-hidden="true">→</span>;
}

function Rename({ d }: { d: Extract<DiagramRecord, { kind: 'rename' }> }): ReactNode {
  return (
    <>
      <div className="dev-ws-diagram-rename">
        <span className="dev-ws-diagram-word dev-ws-diagram-old">{d.from}</span>
        <Arrow />
        <span className="dev-ws-diagram-word dev-ws-diagram-new">{d.to}</span>
      </div>
      {d.places && d.places.length ? (
        <div className="dev-ws-diagram-places">
          {d.places.map((p, i) => <span key={`${i}-${p}`} className="dev-ws-diagram-place">{p}</span>)}
        </div>
      ) : null}
      {d.note ? <p className="dev-ws-diagram-note">{d.note}</p> : null}
    </>
  );
}

function FlowRow({ label, steps, other, side }: { label: string; steps: string[]; other: string[]; side: 'before' | 'after' }): ReactNode {
  const others = new Set(other.map((s) => s.toLowerCase()));
  return (
    <div className="dev-ws-diagram-flow-row" data-flow-side={side}>
      <span className="dev-ws-diagram-flow-label">{label}</span>
      <span className="dev-ws-diagram-flow-steps">
        {steps.map((s, i) => {
          const differs = !others.has(s.toLowerCase());
          const cls = differs ? (side === 'after' ? 'dev-ws-diagram-step dev-ws-diagram-new' : 'dev-ws-diagram-step dev-ws-diagram-old') : 'dev-ws-diagram-step';
          return (
            <span key={`${i}-${s}`} className="dev-ws-diagram-flow-item">
              {i > 0 ? <Arrow /> : null}
              <span className={cls} data-differs={differs ? '' : undefined}>{s}</span>
            </span>
          );
        })}
      </span>
    </div>
  );
}

function Flow({ d }: { d: Extract<DiagramRecord, { kind: 'flow' }> }): ReactNode {
  return (
    <>
      <div className="dev-ws-diagram-flow">
        <FlowRow label="Before" steps={d.before} other={d.after} side="before" />
        <FlowRow label="After" steps={d.after} other={d.before} side="after" />
      </div>
      {d.note ? <p className="dev-ws-diagram-note">{d.note}</p> : null}
    </>
  );
}

const OP_WORDS = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

function Changes({ d }: { d: Extract<DiagramRecord, { kind: 'changes' }> }): ReactNode {
  return (
    <ul className="dev-ws-diagram-rows">
      {d.rows.map((r, i) => (
        <li key={`${i}-${r.what}`} className="dev-ws-diagram-change" data-op={r.op}>
          <span className="dev-ws-diagram-op">{OP_WORDS[r.op]}</span>
          <span className="dev-ws-diagram-what">
            <span className={r.op === 'removed' ? 'dev-ws-diagram-old' : r.op === 'added' ? 'dev-ws-diagram-new' : undefined}>{r.what}</span>
            {r.detail ? <span className="dev-ws-diagram-detail">{r.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Numbers({ d }: { d: Extract<DiagramRecord, { kind: 'numbers' }> }): ReactNode {
  const max = Math.max(...d.rows.flatMap((r) => [Math.abs(r.before), Math.abs(r.after)]), 0) || 1;
  const pct = (n: number) => `${Math.max(2, Math.round((Math.abs(n) / max) * 100))}%`;
  return (
    <ul className="dev-ws-diagram-rows">
      {d.rows.map((r, i) => (
        <li key={`${i}-${r.label}`} className="dev-ws-diagram-number">
          <span className="dev-ws-diagram-number-head">
            <span className="dev-ws-diagram-what">{r.label}</span>
            <span className="dev-ws-diagram-figures">
              <span className="dev-ws-diagram-old-figure">{figure(r.before, d.unit)}</span>
              <Arrow />
              <span className="dev-ws-diagram-new-figure">{figure(r.after, d.unit)}</span>
            </span>
          </span>
          <span className="dev-ws-diagram-bars" aria-hidden="true">
            <span className="dev-ws-diagram-bar dev-ws-diagram-bar-before"><i style={{ width: pct(r.before) }} /></span>
            <span className="dev-ws-diagram-bar dev-ws-diagram-bar-after"><i style={{ width: pct(r.after) }} /></span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/** The Mermaid kind: nothing until it is drawn, `onFail` if it cannot be. */
function Mermaid({ source, onFail, onDrawn }: { source: string; onFail?: () => void; onDrawn?: () => void }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSvg(null);
    renderMermaid(source, isDark()).then(
      (out) => { if (live) { setSvg(out); onDrawn?.(); } },
      () => { if (live) onFail?.(); },
    );
    return () => { live = false; };
  }, [source]);
  if (!svg) return <span className="dev-ws-diagram-wait" aria-hidden="true" />;
  // DOMPurify-cleaned SVG from the vendored library (./mermaid.ts).
  return <div className="dev-ws-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * One diagram, with its label over it and its source under it. `onOpen`
 * makes the picture a door (the card opens Description from it, as tapping
 * the shots does); `onFail` is the Mermaid kind's way out.
 */
export function Diagram({ d, source, onOpen, onFail, className, defer = false }: {
  d: DiagramRecord;
  source: DiagramSource;
  onOpen?: () => void;
  onFail?: () => void;
  className?: string;
  /**
   * Hold a Mermaid diagram back (an empty space) until the caller is near
   * it, so a feed of many cards loads the library only for the one in view.
   */
  defer?: boolean;
}): ReactNode {
  const mermaid = d.kind === 'mermaid';
  const body = d.kind === 'rename' ? <Rename d={d} />
    : d.kind === 'flow' ? <Flow d={d} />
      : d.kind === 'changes' ? <Changes d={d} />
        : d.kind === 'numbers' ? <Numbers d={d} />
          : defer ? <span className="dev-ws-diagram-wait" aria-hidden="true" /> : <Mermaid source={d.source} onFail={onFail} />;
  const door = onOpen ? {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
    },
  } : {};
  return (
    <div
      className={className ? `dev-ws-diagram ${className}` : 'dev-ws-diagram'}
      data-ws-diagram={d.kind}
      data-diagram-source={source}
      aria-label={`${DIAGRAM_LABELS[d.kind]}. ${diagramText(d)}`}
      {...door}
    >
      <span className="dev-ws-diagram-kicker" aria-hidden="true">{DIAGRAM_LABELS[d.kind]}</span>
      <div className="dev-ws-diagram-body" aria-hidden={mermaid ? undefined : 'true'}>{body}</div>
      <p className="dev-ws-diagram-src">{sourceWords(source, mermaid)}</p>
    </div>
  );
}
