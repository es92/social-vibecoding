'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import {
  TONES, TONE_CLASS, UPLOADED_SLUG, builtInIllustrations, resolveIllustration,
} from '../../../lib/challenge-illustrations.ts';
import type { ResolvedIllustration, Tone } from '../../../lib/challenge-illustrations.ts';
import { prepareIllustration } from '../../../lib/prepare-illustration.ts';
import { SVG_ATTRIBUTES, SVG_ELEMENTS } from '../../../lib/svg-allowlist.ts';
import { fetchJson, send } from './api.ts';
import { BTN } from './tokens.ts';
import { Badge, ErrorState, Field, FormError, Input } from './ui.tsx';

// The Illustration field on the challenge TEMPLATE form: a gallery of tiles
// the admin clicks to pick, where the form used to have a <select>.
//
// ── What a tile can be ───────────────────────────────────────────────
//
// "(none)", the nine built-ins, then the art admins have uploaded, newest
// first. Every image path comes from resolveIllustration and from nothing
// else, so a tile only ever draws a same-origin path DERIVED from a slug the
// registry accepts. The list endpoint's own `src` is deliberately ignored.
//
// The stored slug is always a tile, even when it is not in the gallery: art
// that was archived (marked "Archived") or a slug this build cannot draw
// (marked "Not available"). Dropping it would select "(none)", and the next
// unrelated edit would save null over it. It is remembered from the first
// render, so arrowing past it and back does not lose it either.
//
// ── Adding and archiving ─────────────────────────────────────────────
//
// Both are write-gated, in the render (the controls do not exist for a
// view-only admin) and in the handlers. A raster goes through the same
// decode and re-encode the featured illustration editor uses. An SVG is
// cleaned with the vendored DOMPurify against lib/svg-allowlist.ts, the mirror
// of the server's allowlist, and the server still rejects rather than rewrites
// anything outside it, so its refusal is shown word for word. Archiving hides
// art from this gallery only: templates already using it keep drawing it.
//
// Keyboard: the tiles are one radio group with a roving tabindex, so Tab
// lands on the selected tile and the arrow keys move the selection, the way a
// native radio group behaves. The tone swatches in the add panel are a second,
// smaller one.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

const NONE_LABEL = '(none)';
const RASTER_MAX_BYTES = 20 * 1024 * 1024;
const SVG_READ_MAX_BYTES = 1024 * 1024;
const SVG_MAX_BYTES = 256 * 1024;
const LABEL_MAX = 80;
const SVG_NS = 'http://www.w3.org/2000/svg';

export type UploadedIllustration = {
  slug: string;
  label: string;
  tone: string;
  archived: boolean;
};

export type GalleryTile = {
  value: string;
  label: string;
  art: ResolvedIllustration | null;
  marker: 'Archived' | 'Not available' | null;
  /** Set on uploaded art, which is what the Archive action needs. */
  item: UploadedIllustration | null;
};

// One list row as the API returns it, or null for anything that is not an
// uploaded slug: the gallery lists nothing the registry would not draw.
function toItem(raw: any): UploadedIllustration | null {
  if (!raw || typeof raw.slug !== 'string' || !UPLOADED_SLUG.test(raw.slug)) return null;
  return {
    slug: raw.slug,
    label: typeof raw.label === 'string' ? raw.label : '',
    tone: typeof raw.tone === 'string' ? raw.tone : '',
    archived: !!raw.archived,
  };
}

// The tiles for a value, in render order. Pure, so the static renderer's
// tests can check the archived case without running the list effect.
// `kept` is the slug the form opened with; `items` is null until the list
// has loaded.
export function galleryTiles(
  value: string,
  items: UploadedIllustration[] | null,
  kept?: string,
): GalleryTile[] {
  const tiles: GalleryTile[] = [
    { value: '', label: NONE_LABEL, art: null, marker: null, item: null },
    ...builtInIllustrations().map((art) => ({
      value: art.slug, label: art.label, art, marker: null, item: null,
    })),
    ...(items || []).filter((i) => !i.archived).map((i) => ({
      value: i.slug, label: i.label, art: resolveIllustration(i.slug, i.tone), marker: null, item: i,
    })),
  ];
  for (const slug of [kept, value]) {
    if (!slug || tiles.some((t) => t.value === slug)) continue;
    const stored = (items || []).find((i) => i.slug === slug);
    if (stored) {
      tiles.push({
        value: slug, label: stored.label, art: resolveIllustration(slug, stored.tone),
        marker: 'Archived', item: stored,
      });
    } else if (items === null && UPLOADED_SLUG.test(slug)) {
      // Not known yet rather than not available: the list may still bring it.
      tiles.push({ value: slug, label: 'Uploaded illustration', art: null, marker: null, item: null });
    } else {
      tiles.push({ value: slug, label: slug, art: null, marker: 'Not available', item: null });
    }
  }
  return tiles;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

// Where an arrow, Home or End key moves the selection in a group of `length`,
// wrapping at both ends; -1 for any other key.
function arrowTarget(key: string, index: number, length: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const step = STEP[key];
  return step ? (index + step + length) % length : -1;
}

const toneLabel = (tone: string) => tone.charAt(0).toUpperCase() + tone.slice(1);

const nameFromFile = (name: string) => name
  .replace(/\.[a-z0-9]+$/i, '')
  .replace(/[-_]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, LABEL_MAX);

const isSvgFile = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);

// Clean an SVG's text against the server's allowlist and return the document
// to upload. Throws an Error whose message is shown as is.
function sanitizeSvg(text: string): string {
  const purify = (window as any).DOMPurify;
  if (!purify || typeof purify.sanitize !== 'function') {
    throw new Error('The SVG cleaner did not load, so SVG files cannot be added right now. '
      + 'Reload the page, or upload a PNG or WebP.');
  }
  const clean = purify.sanitize(text, {
    ALLOWED_TAGS: [...SVG_ELEMENTS],
    ALLOWED_ATTR: [...SVG_ATTRIBUTES],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  // DOMPurify parses as HTML, which is also what keeps the SVG namespace on
  // the element. XMLSerializer then writes it back out as a standalone
  // document, xmlns and all, which is the shape the server checks for.
  const body = new DOMParser().parseFromString(String(clean), 'text/html').body;
  const root = body.children.length === 1 ? body.children[0] : null;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    throw new Error('No SVG image was left after cleaning. Choose another file.');
  }
  if (!root.hasAttribute('viewBox')) {
    throw new Error('That SVG has no viewBox, so it cannot scale to the tile. Add one and try again.');
  }
  const out = new XMLSerializer().serializeToString(root);
  if (new Blob([out]).size > SVG_MAX_BYTES) {
    throw new Error('That SVG is larger than 256 KB. Choose a smaller file.');
  }
  return out;
}

type Draft = { blob: Blob; previewUrl: string; label: string; tone: Tone };

export function IllustrationGallery({ id, value, onChange }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const write = canWrite();
  const [kept] = useState(value);
  const [items, setItems] = useState<UploadedIllustration[] | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string | null } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const radios = useRef(new Map<string, HTMLButtonElement>());
  const swatches = useRef(new Map<string, HTMLButtonElement>());
  // A tile to focus once it has rendered: a just-uploaded one, or the
  // selected one after an archived tile has left the grid under the focus.
  const focusNext = useRef<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; generation.current += 1; }, []);

  const load = useCallback(async () => {
    const res = await fetchJson('/api/v4/admin/challenge-illustrations');
    if (!alive.current) return;
    if (res.ok && res.data?.success && Array.isArray(res.data.data)) {
      setItems(res.data.data.map(toItem).filter(Boolean) as UploadedIllustration[]);
      setLoadError(null);
      return;
    }
    setLoadError({ status: res.status, message: (res.data && res.data.error) || null });
  }, []);

  useEffect(() => { load(); }, [load]);

  const previewUrl = draft?.previewUrl;
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    const slug = focusNext.current;
    if (slug == null) return;
    focusNext.current = null;
    radios.current.get(slug)?.focus();
  });

  const tiles = galleryTiles(value, items, kept);
  const selectedIndex = Math.max(0, tiles.findIndex((t) => t.value === value));

  const onTileKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = arrowTarget(event.key, index, tiles.length);
    if (target < 0) return;
    event.preventDefault();
    const next = tiles[target];
    onChange(next.value);
    radios.current.get(next.value)?.focus();
  };

  const chooseFile = async (chosen?: File) => {
    if (!chosen || !canWrite()) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      let blob: Blob;
      if (isSvgFile(chosen)) {
        if (chosen.size > SVG_READ_MAX_BYTES) throw new Error('That SVG is larger than 256 KB. Choose a smaller file.');
        const text = await chosen.text().catch(() => {
          throw new Error('That file could not be read. Choose another file.');
        });
        blob = new Blob([sanitizeSvg(text)], { type: 'image/svg+xml' });
      } else if (/^image\/(png|webp)$/.test(chosen.type)) {
        if (chosen.size > RASTER_MAX_BYTES) throw new Error('Choose an image under 20 MB.');
        blob = await prepareIllustration(chosen);
      } else {
        throw new Error('Choose a PNG, WebP or SVG file.');
      }
      if (current !== generation.current) return;
      // Outside the updater, which React may call twice: a second
      // createObjectURL there would be a URL nothing ever revokes.
      const url = URL.createObjectURL(blob);
      setDraft((d) => ({ blob, previewUrl: url, label: nameFromFile(chosen.name), tone: d ? d.tone : 'gray' }));
    } catch (err) {
      if (current === generation.current) setError((err as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const cancel = () => {
    generation.current += 1;
    setDraft(null);
    setError(null);
    setBusy(false);
  };

  const upload = async () => {
    if (!draft || busy || !canWrite()) return;
    const label = draft.label.trim();
    if (!label) { setError('Give the illustration a name.'); return; }
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ label, tone: draft.tone });
    const res = await fetchJson(`/api/v4/admin/challenge-illustrations?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: draft.blob,
    });
    if (!alive.current) return;
    setBusy(false);
    const item = res.ok && res.data?.success ? toItem(res.data.data) : null;
    if (!item) {
      setError(res.status === 0
        ? "Couldn't reach the server. Try again."
        : ((res.data && res.data.error) || 'Upload failed.'));
      return;
    }
    setItems((prev) => [item, ...(prev || []).filter((i) => i.slug !== item.slug)]);
    setDraft(null);
    focusNext.current = item.slug;
    onChange(item.slug);
  };

  const archive = async (item: UploadedIllustration) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Archive this illustration?',
      confirmLabel: 'Archive',
      message: 'It leaves this gallery. Templates that already use it keep drawing it.',
    });
    if (!ok) return;
    const res = await send('PATCH',
      `/api/v4/admin/challenge-illustrations/${encodeURIComponent(item.slug)}`, { archived: true });
    if (!alive.current) return;
    if (!res.ok || !res.data?.success) {
      topo()._alert((res.data && res.data.error) || 'Archive failed.');
      return;
    }
    const next = toItem(res.data.data) || { ...item, archived: true };
    setItems((prev) => (prev || []).map((i) => (i.slug === item.slug ? next : i)));
    // The Archive button just pressed may have left with its tile; hand the
    // focus to the selected tile rather than dropping it on the page.
    focusNext.current = value;
  };

  const onSwatchKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = arrowTarget(event.key, index, TONES.length);
    if (target < 0 || !draft) return;
    event.preventDefault();
    const tone = TONES[target];
    setDraft({ ...draft, tone });
    swatches.current.get(tone)?.focus();
  };

  return (
    <div>
      <div
        id={id}
        role="radiogroup"
        aria-label="Illustration"
        className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2"
      >
        {tiles.map((t, index) => {
          const selected = t.value === value;
          return (
            <div key={t.value || '(none)'} className="flex min-w-0 flex-col gap-1">
              <button
                ref={(el) => { if (el) radios.current.set(t.value, el); else radios.current.delete(t.value); }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={index === selectedIndex ? 0 : -1}
                data-illustration={t.value}
                onClick={() => onChange(t.value)}
                onKeyDown={(e) => onTileKey(e, index)}
                className={`relative flex min-h-[44px] w-full min-w-0 flex-col items-center gap-1.5 rounded-xl border p-2 text-center touch-manipulation focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 ${selected
                  ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500 dark:border-violet-400 dark:bg-violet-950/40 dark:ring-violet-400'
                  : 'border-zinc-200 hover:border-violet-400 dark:border-zinc-700'}`}
              >
                {selected ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white"
                  >
                    ✓
                  </span>
                ) : null}
                {t.art ? (
                  <img
                    src={t.art.src}
                    alt=""
                    draggable={false}
                    className={`${t.art.toneClass} h-16 w-16 shrink-0 rounded-xl bg-[var(--tint-art)] object-contain`}
                  />
                ) : (
                  <span className="h-16 w-16 shrink-0 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600" />
                )}
                <span
                  className={`line-clamp-2 w-full break-words text-[11px] leading-snug ${selected
                    ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-600 dark:text-zinc-300'}`}
                >
                  {t.label}
                </span>
                {t.marker ? (
                  <Badge label={t.marker} tone={t.marker === 'Archived' ? 'amber' : 'zinc'} />
                ) : null}
              </button>
              {write && t.item && !t.item.archived ? (
                <button
                  type="button"
                  data-archive-illustration={t.value}
                  aria-label={`Archive ${t.label}`}
                  className={`${BTN.row} w-full`}
                  onClick={() => archive(t.item as UploadedIllustration)}
                >
                  Archive
                </button>
              ) : null}
            </div>
          );
        })}
        {write ? (
          <div className="flex min-w-0 flex-col">
            <button
              id={`${id}-add`}
              type="button"
              disabled={busy}
              onClick={() => file.current?.click()}
              className="flex min-h-[44px] w-full min-w-0 flex-col items-center gap-1.5 rounded-xl border border-dashed border-zinc-300 p-2 text-center text-violet-700 touch-manipulation hover:border-violet-400 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-40 dark:border-zinc-600 dark:text-violet-400"
            >
              <span aria-hidden="true" className="flex h-16 w-16 items-center justify-center text-3xl font-light">+</span>
              <span className="text-[11px] font-medium leading-snug">Add illustration</span>
            </button>
          </div>
        ) : null}
      </div>
      {write ? (
        <input
          ref={file}
          id={`${id}-file`}
          type="file"
          accept="image/png,image/webp,image/svg+xml"
          aria-label="Choose an illustration file"
          className="hidden"
          onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      ) : null}
      {write && draft ? (
        <div
          id={`${id}-draft`}
          className="mt-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700 sm:p-4"
        >
          <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">Add illustration</p>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
            <img
              src={draft.previewUrl}
              alt="Preview of the new illustration"
              draggable={false}
              className={`${TONE_CLASS[draft.tone]} h-24 w-24 shrink-0 rounded-xl bg-[var(--tint-art)] object-contain`}
            />
            <div className="min-w-0 flex-1 space-y-3">
              <Field label="Name" htmlFor={`${id}-name`} help="Shown under the tile in this gallery.">
                <Input
                  id={`${id}-name`}
                  type="text"
                  maxLength={LABEL_MAX}
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              </Field>
              <div className="text-xs">
                <p id={`${id}-tone-label`} className="font-medium text-zinc-600 dark:text-zinc-400">Tile colour</p>
                <div role="radiogroup" aria-labelledby={`${id}-tone-label`} className="mt-1 flex flex-wrap gap-2">
                  {TONES.map((tone, index) => {
                    const chosen = draft.tone === tone;
                    return (
                      <button
                        key={tone}
                        ref={(el) => { if (el) swatches.current.set(tone, el); else swatches.current.delete(tone); }}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        aria-label={toneLabel(tone)}
                        tabIndex={chosen ? 0 : -1}
                        data-tone={tone}
                        onClick={() => setDraft({ ...draft, tone })}
                        onKeyDown={(e) => onSwatchKey(e, index)}
                        className={`${TONE_CLASS[tone]} inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--tint-line)] bg-[var(--tint-art)] text-sm font-bold text-zinc-800 touch-manipulation focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 dark:text-zinc-100 ${chosen
                          ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900'
                          : ''}`}
                      >
                        {chosen ? <span aria-hidden="true">✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN.primarySm} disabled={busy} onClick={() => { void upload(); }}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" className={BTN.secondarySm} onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : null}
      <FormError message={error} />
      {loadError ? (
        <div className="mt-3">
          <ErrorState
            title="Couldn't load uploaded illustrations"
            status={loadError.status}
            message={loadError.message}
            onRetry={load}
          />
        </div>
      ) : null}
    </div>
  );
}
