'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Invite links (#admin/codes) — activation codes, sent as links to Homeroom
// itself. One per person: whoever signs up from /welcome/<code> is let in at
// once, with no waitlist and no project attached (src/services/access-links.js).
//
// A code is either available or spent; a spent one keeps its row so the
// account it let in is traceable, struck through with who used it and when.
// The admin's note says who a link is for; nobody else sees it. Two copy
// affordances on an available code: the link (the way to send it), and the
// raw code, which the older #register/<code> form still takes by hand.
//
// PERMISSIONS: visible to any admin. Generate and delete are gated on
// AdminConsole.canWrite() (canAdminWrite); the server enforces the same on
// /api/admin/codes independently.
//
// ── Second section out of the chassis (#1120 slice 17) ────────────────
//
// Same move as admin-overview.tsx: the section leaves admin-console.js for a
// module behind SECTION_MODULES, and the chassis's `switch` loses another
// arm. See the header there for why the sections go first and the chassis
// last.
//
// The three per-button `querySelectorAll(...).forEach(addEventListener)`
// passes are gone — they ran after every repaint, over nodes the same repaint
// had just created — and so is the "Copied!" label that was written straight
// onto `btn.textContent` with a `setTimeout` to put it back. That timer now
// belongs to the row that owns the button, so it is cleared when the row goes
// away instead of firing into a detached node.

interface Code {
  id: number;
  code: string;
  note?: string | null;
  created_by_username?: string | null;
  used_by_username?: string;
  used_at?: string;
}

/** The address an admin sends (src/routes/access-links.js). */
function welcomeLink(code: string): string {
  return `${location.origin}/welcome/${encodeURIComponent(code)}`;
}

const ROW = 'flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800';
const LINK_BTN = 'text-xs text-zinc-500 dark:text-zinc-400 transition-colors';

/**
 * A copy button that says so for a moment. The timer lives with the button,
 * so unmounting the row cancels it — the old shape reset `btn.textContent`
 * from a `setTimeout` that outlived the repaint.
 */
function CopyButton({ className, label, done, value }: {
  className: string; label: string; done: string; value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button type="button" className={className} data-code={value}
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}>
      {copied ? done : label}
    </button>
  );
}

function CodeRow({ code, canWrite, onDelete }: {
  code: Code; canWrite: boolean; onDelete: () => void;
}) {
  // Spent once it has a time: an account removed later clears `used_by`
  // (ON DELETE SET NULL) but not the time, and the link stays spent.
  const used = !!code.used_by_username || !!code.used_at;
  return (
    <div className={ROW}>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`text-sm font-medium ${code.note ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {code.note || 'No note'}
          </span>
          {used ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {code.used_by_username ? <>{'Used by '}<strong className="text-zinc-500 dark:text-zinc-400">{code.used_by_username}</strong></> : 'Used'}
              {code.used_at ? ` on ${new Date(code.used_at).toLocaleDateString()}` : ''}
            </span>
          ) : <span className={AdminUI.badge.success}>Available</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <code className={`font-mono ${used ? 'line-through' : 'text-violet-700 dark:text-violet-400'}`}>{code.code}</code>
          {code.created_by_username ? <span>{`made by ${code.created_by_username}`}</span> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!used ? (
          // The way to send it: /welcome/<code>, the sign-up sheet that
          // skips the waitlist (src/routes/access-links.js).
          <CopyButton className={`admin-share-code-btn ${LINK_BTN} hover:text-violet-800 dark:hover:text-violet-300`}
            label="Copy link" done="Link copied!"
            value={welcomeLink(code.code)} />
        ) : null}
        {!used ? (
          // The raw code, for the older #register/<code> form.
          <CopyButton className={`admin-copy-code-btn ${LINK_BTN} hover:text-violet-800 dark:hover:text-violet-300`}
            label="Copy code" done="Copied!" value={code.code} />
        ) : null}
        {!used && canWrite ? (
          <button type="button" className={`admin-delete-code-btn ${LINK_BTN} hover:text-red-400`}
            data-id={code.id} aria-label="Delete code"
            onClick={async () => {
              await fetch(`/api/admin/codes/${code.id}`, { method: 'DELETE' });
              onDelete();
            }}>×</button>
        ) : null}
      </div>
    </div>
  );
}

function CodesSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [making, setMaking] = useState(false);
  const note = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await (window as any).AdminConsole.fetchJson('/api/admin/codes');
    if (!alive.current || !Array.isArray(data)) return;
    setCodes(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const make = useCallback(async () => {
    setMaking(true);
    try {
      await fetch('/api/admin/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.current?.value || '' }),
      });
      if (note.current) note.current.value = '';
      await load();
    } finally {
      if (alive.current) setMaking(false);
    }
  }, [load]);

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="mb-3">
        <h2 className={AdminUI.cardTitle}>Invite links</h2>
        <p className={AdminUI.cardDescription}>
          One link per person. Whoever signs up from it gets in right away: no waitlist, and no project needed.
        </p>
      </div>
      {canWrite ? (
        <form className="flex flex-wrap items-end gap-2 mb-4"
          onSubmit={(e) => { e.preventDefault(); if (!making) make(); }}>
          <label className="flex-1 min-w-[12rem] flex flex-col gap-1">
            <span className={AdminUI.label}>Who is it for?</span>
            <input ref={note} id="admin-code-note" type="text" maxLength={200} autoComplete="off"
              className={AdminUI.input} placeholder="Name, and why (only admins see this)" />
          </label>
          <button id="admin-generate-code-btn" type="submit" className={AdminUI.btn.primary} disabled={making}>
            Make link
          </button>
        </form>
      ) : null}
      <div id="admin-code-list" className="space-y-2">
        {(codes || []).map((c) => <CodeRow key={c.id} code={c} canWrite={canWrite} onDelete={load} />)}
      </div>
      <p id="admin-code-empty"
        className={`text-sm text-zinc-500 dark:text-zinc-400${codes && !codes.length ? '' : ' hidden'}`}>
        No invite links yet.
      </p>
    </div>
  );
}

let host: Element | null = null;

const AdminCodes = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <CodesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminCodes = AdminCodes;

export { AdminCodes };
