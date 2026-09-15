'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, send } from './api.ts';
import { IllustrationGallery } from './illustration-gallery.tsx';
import { BTN } from './tokens.ts';
import {
  EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, FormSection, Input, List,
  Options, Pager, Panel, ScreenHeader, Select, Skeleton, Textarea, isoToLocalInput, localInputToIso,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Challenge templates — full CRUD over the reusable library that event
// challenges are stamped out of, plus the /categories list the filter reads.
//
// ── React-owned (#1120 slice 32) ──────────────────────────────────────
//
// Ninth screen through the portal seam, and the longest FORM in the console:
// twenty-one fields across five labelled groups. The innerHTML version wrote all
// twenty as `_inputHtml(id, …)` strings and read all twenty back at save time
// through `val('admin-topo-tpl-f-<name>')` — the id was the only thing tying
// a control to the payload key it filled, in two places, 300 lines apart. The
// FIELDS table below is that mapping stated once; the form renders from it
// and the payload is built from it.
//
// One documented API gap survives verbatim in the help text: no admin (or
// public) endpoint lists `challenge_kinds`, so Kind is a free-text input that
// must match an existing id. Do not invent an endpoint for it.
//
// Ids are like-for-like — `admin-topo-tpl-*` and every `-f-` field id.
//
// The Illustration field is the one whose options are not typed here: it is
// a gallery (./illustration-gallery.tsx) of the built-ins in
// frontend/src/lib/challenge-illustrations.ts plus the art admins have
// uploaded, resolved through the same table the challenge cards use, so an
// admin can only pick art this build can draw. Its value is still the slug
// string, so the round trip below does not know it is a gallery. It is
// template-level by owner decision — a challenge inherits it and has no
// override, which is why challenge-fields.ts does not list it and the
// Add-challenge form never copies it.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type Template = {
  id: number;
  category: string;
  goal: string;
  task: string;
  reward: string;
  kind?: string | null;
  [key: string]: unknown;
};

// Every field on the form, in render order: the payload key, its label, how
// it is edited, and any help text. `req` marks the four the API requires,
// which is also what the client-side guard checks before POSTing.
type FieldSpec = {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'datetime' | 'cta' | 'textarea' | 'illustration';
  help?: string;
  req?: boolean;
};

const CORE: FieldSpec[] = [
  { key: 'category', label: 'Category *', kind: 'text', req: true },
  { key: 'goal', label: 'Goal *', kind: 'text', req: true },
  { key: 'reward', label: 'Reward *', kind: 'text', req: true },
  {
    key: 'kind',
    label: 'Kind',
    kind: 'text',
    help: 'No admin listing endpoint exists for Kinds (documented gap). Must match an existing challenge_kinds id.',
  },
  { key: 'schedule_start', label: 'Schedule start', kind: 'datetime' },
  { key: 'schedule_end', label: 'Schedule end', kind: 'datetime' },
];

// How the challenge is drawn, for every challenge stamped out of the template.
const CARD: FieldSpec[] = [
  {
    key: 'illustration',
    label: 'Illustration',
    kind: 'illustration',
    help: 'Drawn on the challenge card and detail page. (none) keeps the plain tile. '
      + 'Archiving uploaded art hides it here; templates that use it keep drawing it.',
  },
];

const CTA: FieldSpec[] = [
  { key: 'cta_button', label: 'CTA button label', kind: 'text' },
  { key: 'cta_label', label: 'CTA label', kind: 'text' },
  { key: 'cta_type', label: 'CTA type', kind: 'cta' },
  { key: 'cta_link', label: 'CTA link', kind: 'text' },
  { key: 'mobile_cta_label', label: 'Mobile CTA label', kind: 'text' },
  { key: 'mobile_cta_type', label: 'Mobile CTA type', kind: 'cta' },
  { key: 'mobile_cta_link', label: 'Mobile CTA link', kind: 'text' },
];

const METRIC: FieldSpec[] = [
  { key: 'metric_type', label: 'Metric type', kind: 'text' },
  { key: 'metric_label', label: 'Metric label', kind: 'text' },
  { key: 'metric_target', label: 'Metric target', kind: 'number' },
];

const COPY: FieldSpec[] = [
  { key: 'task', label: 'Task *', kind: 'textarea', req: true },
  { key: 'description', label: 'Description', kind: 'textarea' },
  { key: 'requirements', label: 'Requirements', kind: 'textarea' },
  { key: 'reward_logic', label: 'Reward logic', kind: 'textarea' },
];

const ALL_FIELDS = [...CORE, ...CARD, ...CTA, ...METRIC, ...COPY];

const CTA_OPTIONS = [
  { value: 'url', label: 'url' },
  { value: 'app', label: 'app' },
];

const fieldId = (key: string) => `admin-topo-tpl-f-${key}`;

// The form's values for one stored template, and the POST/PUT body for a
// filled form: the two halves of the round trip, stated as pure functions so
// tests/challenge-template-prefill.test.js can check them directly — effects
// do not run under the static renderer the root suite has.
function templateFormValues(t: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const f of ALL_FIELDS) {
    const raw = t[f.key];
    next[f.key] = f.kind === 'datetime'
      ? isoToLocalInput(raw as string | null)
      : (raw == null ? '' : String(raw));
  }
  return next;
}

// Every key is sent on POST and PUT alike, so an optional field left empty
// goes out as null — which is also how "(none)" clears a stored illustration.
function buildTemplateBody(values: Record<string, string>): Record<string, unknown> {
  const val = (key: string) => (values[key] || '').trim();
  const body: Record<string, unknown> = {};
  for (const f of ALL_FIELDS) {
    const v = val(f.key);
    if (f.kind === 'datetime') body[f.key] = localInputToIso(v);
    else if (f.kind === 'number') body[f.key] = v === '' ? null : Number(v);
    else if (f.req) body[f.key] = v;
    else body[f.key] = v || null;
  }
  return body;
}

const COLUMNS: Column<Template>[] = [
  { label: 'Goal', primary: true, cell: (t) => t.goal },
  { label: 'Category', cell: (t) => t.category, tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
  { label: 'Reward', cell: (t) => t.reward, tdClass: 'text-zinc-500 dark:text-zinc-400' },
  { label: 'Kind', cell: (t) => t.kind || '—', tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
];

function FormFields({ specs, values, onChange }: {
  specs: FieldSpec[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {specs.map((f) => (
        // The gallery spans both columns, and its label names the radio group
        // through aria-label instead: a <label for> cannot point at a group.
        <Field
          key={f.key}
          label={f.label}
          htmlFor={f.kind === 'illustration' ? undefined : fieldId(f.key)}
          help={f.help}
          className={f.kind === 'illustration' ? 'md:col-span-2' : undefined}
        >
          {f.kind === 'illustration' ? (
            <IllustrationGallery
              id={fieldId(f.key)}
              value={values[f.key] || ''}
              onChange={(value) => onChange(f.key, value)}
            />
          ) : f.kind === 'cta' ? (
            <Select
              id={fieldId(f.key)}
              value={values[f.key] || ''}
              onChange={(e) => onChange(f.key, e.target.value)}
            >
              <Options options={CTA_OPTIONS} blank="(none)" />
            </Select>
          ) : (
            <Input
              id={fieldId(f.key)}
              type={f.kind === 'number' ? 'number' : (f.kind === 'datetime' ? 'datetime-local' : 'text')}
              step={f.kind === 'number' ? '0.01' : undefined}
              value={values[f.key] || ''}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          )}
        </Field>
      ))}
    </>
  );
}

function TemplateForm({ id, onClose, onSaved }: {
  id: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(id == null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Edit fetches the single row: the index payload carries four columns and
  // the form has twenty-one fields.
  useEffect(() => {
    if (id == null) return;
    (async () => {
      const { ok, data } = await fetchJson(
        `/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`);
      if (!alive.current) return;
      const t = ok && data?.success ? data.data : null;
      if (t) setValues(templateFormValues(t));
      setLoaded(true);
    })();
  }, [id]);

  const set = useCallback((key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const body = buildTemplateBody(values);
    if (ALL_FIELDS.some((f) => f.req && !body[f.key])) {
      setError('Category, goal, task and reward are required.');
      return;
    }
    const url = id == null
      ? '/api/v4/admin/challenge-templates'
      : `/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`;
    const { ok, data } = await send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [values, id, onSaved]);

  return (
    <Panel
      title={id == null ? 'New challenge template' : `Edit template #${id}`}
      subtitle="What the challenge asks for, what it rewards, and how it is presented."
      onClose={onClose}
      closeLabel="Close the template form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save template" />}
    >
      {!loaded ? <Skeleton rows={4} /> : (
        <>
          <FormGrid>
            <FormFields specs={CORE} values={values} onChange={set} />
          </FormGrid>
          <FormSection label="Card" />
          <FormGrid>
            <FormFields specs={CARD} values={values} onChange={set} />
          </FormGrid>
          <FormSection label="Call to action" />
          <FormGrid>
            <FormFields specs={CTA} values={values} onChange={set} />
          </FormGrid>
          <FormSection label="Metric" />
          <FormGrid cols={3}>
            <FormFields specs={METRIC} values={values} onChange={set} />
          </FormGrid>
          <FormSection label="Copy" />
          <div className="grid grid-cols-1 gap-4">
            {COPY.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={fieldId(f.key)}>
                <Textarea
                  id={fieldId(f.key)}
                  rows={3}
                  value={values[f.key] || ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Field>
            ))}
          </div>
          <FormError message={error} />
        </>
      )}
    </Panel>
  );
}

function ChallengeTemplatesScreen() {
  const write = canWrite();
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Template[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/challenge-templates/categories');
      if (!alive.current) return;
      setCategories(ok && data?.success ? data.data : []);
    })();
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '20' });
    if (search) params.set('search', search);
    if (category) params.set('category', category);
    const res = await fetchJson(`/api/v4/admin/challenge-templates?${params}`);
    if (!alive.current) return;
    if (res.ok && res.data?.success) {
      setItems(res.data.data);
      setMeta(res.data.meta || null);
      setError(null);
      return;
    }
    setItems([]);
    setMeta(null);
    setError({ status: res.status, message: (res.data && res.data.error) || null });
  }, [page, search, category]);

  useEffect(() => { load(); }, [load]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
    setPage(1);
  }, []);

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Delete this challenge template?',
      confirmLabel: 'Delete',
      danger: true,
      message: 'Fails if any challenge still references it.',
    });
    if (!ok) return;
    const res = await send('DELETE', `/api/v4/admin/challenge-templates/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  return (
    <>
      <ScreenHeader
        title="Challenge templates"
        subtitle="The reusable library that event challenges are stamped out of."
        actions={(
          <>
            {/* Commits on blur or Enter, not per keystroke — a paged server
                query, same rule as the other search boxes in this console. */}
            <Input
              id="admin-topo-tpl-search"
              type="text"
              placeholder="Search…"
              aria-label="Search challenge templates"
              className="sm:w-48"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
            <div className="w-full sm:w-48">
              <Select
                id="admin-topo-tpl-category"
                value={category}
                onChange={(e) => { setCategory(e.target.value); setPage(1); }}
              >
                <Options
                  options={categories.map((c) => ({ value: c, label: c }))}
                  blank="All categories"
                />
              </Select>
            </div>
            {write ? (
              <button
                id="admin-topo-tpl-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New template
              </button>
            ) : null}
          </>
        )}
      />
      <div id="admin-topo-tpl-form">
        {editing != null && write ? (
          <TemplateForm
            key={String(editing)}
            id={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-tpl-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load challenge templates"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title="No challenge templates yet"
            body="Templates are the reusable library challenges are stamped out of."
            action={write ? (
              <button
                id="admin-topo-tpl-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New template
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(t) => t.id}
              columns={COLUMNS}
              actions={write ? (t) => (
                <>
                  <button
                    data-edit-tpl={t.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => setEditing(t.id)}
                  >
                    Edit
                  </button>
                  <button
                    data-delete-tpl={t.id}
                    type="button"
                    className={BTN.rowDanger}
                    onClick={() => remove(t.id)}
                  >
                    Delete
                  </button>
                </>
              ) : undefined}
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
    </>
  );
}

export {
  ALL_FIELDS, ChallengeTemplatesScreen, buildTemplateBody, templateFormValues,
};
