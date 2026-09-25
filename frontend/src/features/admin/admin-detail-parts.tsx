'use strict';

import type { ReactNode } from 'react';

import { AdminUI } from './admin-console.js';

// The pieces a per-user details screen is built from, shared by Users
// (#admin/users/<id>) and Support (#admin/support/<id>) so the two views of
// the same account keep one card, one label column and one date format.

export function DetailCard({ title, children, id, action }: {
  title: string; children: ReactNode; id?: string; action?: ReactNode;
}) {
  return (
    <section id={id} className={`${AdminUI.card} p-5`} aria-label={title}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        {action || null}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <div className="py-2 border-t first:border-t-0 border-zinc-100 dark:border-zinc-800 flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
      <div className="sm:w-40 shrink-0 text-sm text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="min-w-0 flex-1 text-sm text-zinc-900 dark:text-zinc-100 break-words">
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        {help ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{help}</p> : null}
      </div>
    </div>
  );
}

export function fmtDate(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const orDash = (v?: string | null) => (v ? v : 'Not set');
