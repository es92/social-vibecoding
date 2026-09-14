/**
 * The Homeroom-app section's vocabulary: the five shapes `settings.js` built
 * with `_unEl`, `_unSection`, `_unStatusRow`, `_unButton` and `_unToggle`.
 *
 * ── The async wrapper was written three times ─────────────────────────
 *
 * Each of the row, the button and the toggle carried the same
 * disable → await → catch → toast → re-enable dance, hand-copied, with the
 * toggle's variant also reverting its own checkbox. It is written ONCE here,
 * in `useAction`, and the three controls share it — which is the same
 * consolidation `_unStatusRow`'s own comment asks for when it says the row
 * "IS the control".
 *
 * ── Handlers are named, not passed ────────────────────────────────────
 *
 * The model carries an `action` STRING and this file dispatches it into
 * `window.Settings` by name. settings.js is 5,000 lines that a dozen tests
 * load in a `vm`; keeping functions out of the view model is what lets the
 * model stay plain serialisable data — the same rule the dev chat's stores
 * follow.
 */

import { useCallback, useState, type ReactNode } from 'react';

import type { UnAction, UnNote, UnStatusRow, UnToggle } from './usernode-store';

function settings(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * Run a named module action with the busy/​toast handling all three controls
 * used to repeat. `revert` is the toggle's: a failed setter has to put the
 * checkbox back, because the browser already moved it.
 */
function useAction(fallback: string) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: string, arg?: unknown) => {
    setBusy(true);
    try {
      await settings()?.[action]?.(arg);
      return true;
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn('[settings] usernode action failed:', err);
      ui()?.toast?.(settings()?._nativeActionMessage?.(err, fallback) || fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }, [fallback]);
  return { busy, run };
}

export function UnSection(
  { title, description, id, children }: {
    title: string; description?: string; id?: string; children?: ReactNode;
  },
): ReactNode {
  return (
    <div id={id} className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700">
      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">{title}</h3>
      {description ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

const NOTE_CLASS = {
  muted: 'text-xs text-zinc-500 dark:text-zinc-400',
  mono: 'text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-2 break-words',
  demo: 'text-xs font-medium text-amber-800 dark:text-amber-400 mb-2',
  warn: 'text-xs text-amber-800 dark:text-amber-400 mt-2',
} as const;

export function UnP({ note }: { note: UnNote }): ReactNode {
  return <p className={NOTE_CLASS[note.tone || 'muted']}>{note.text}</p>;
}

const ROW_BASE = 'flex items-center gap-2 mt-1 text-sm w-full text-left';
const ROW_TAP = ' rounded-md -mx-1 px-1 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800';

export function UnRow({ row }: { row: UnStatusRow }): ReactNode {
  const { busy, run } = useAction('Action failed');
  const dot = `w-2 h-2 rounded-full shrink-0 ${row.ok ? 'bg-emerald-500' : 'bg-amber-500'}`;
  const ink = row.ok
    ? 'ml-auto text-xs text-emerald-700 dark:text-emerald-400'
    : 'ml-auto text-xs text-amber-800 dark:text-amber-400';
  const inner = (
    <>
      <span className={dot}></span>
      <span className="text-zinc-800 dark:text-zinc-200">{row.label}</span>
      <span className={ink}>{row.text}</span>
      {row.action ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-500 shrink-0">›</span>
      ) : null}
    </>
  );
  // The row IS the control when it carries one — a plain div otherwise, which
  // is what makes an inert row inert by construction rather than by omission.
  if (!row.action) {
    return <div id={row.id} className={ROW_BASE}>{inner}</div>;
  }
  return (
    <button
      id={row.id} type="button" className={ROW_BASE + ROW_TAP} disabled={busy}
      aria-label={row.hint ? `${row.label}: ${row.hint}` : undefined}
      onClick={() => run(row.action as string)}
    >{inner}</button>
  );
}

const BTN_BASE = 'mt-3 mr-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ';
const BTN_TONE = {
  danger: 'border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950',
  plain: 'border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
} as const;

export function UnBtn({ btn }: { btn: UnAction }): ReactNode {
  const { busy, run } = useAction('Action failed');
  return (
    <button
      id={btn.id} type="button"
      className={BTN_BASE + BTN_TONE[btn.danger ? 'danger' : 'plain']}
      disabled={busy || btn.disabled === true}
      onClick={() => run(btn.action)}
    >{btn.label}</button>
  );
}

export function UnSwitch({ toggle }: { toggle: UnToggle }): ReactNode {
  // `checked` follows the MODEL, and a failed setter simply never publishes a
  // new one — so the revert the old handler did by hand (`input.checked =
  // !e.target.checked`) is what not-publishing already means.
  const { busy, run } = useAction('Could not save the setting');
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none mt-2">
      <input
        type="checkbox" className="un-switch" checked={toggle.checked} disabled={busy}
        onChange={(e) => run(toggle.action, e.target.checked)}
      />
      <span className="text-sm text-zinc-800 dark:text-zinc-200">{toggle.label}</span>
    </label>
  );
}
