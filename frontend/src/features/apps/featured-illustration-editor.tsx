import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { DiscoverCard } from '../home/panels/discover';
import { TONES, cardTintClass, toneLabel } from '../home/panels/ui';
import type { DiscoverTileView } from '../home/panels-store';
import { prepareIllustration } from '../../lib/prepare-illustration';
import {
  DEFAULT_FRAME, centreOf, clampFrame, panFrame, spreadOf, wheelZoomFactor, zoomFrame,
} from '../../lib/illustration-framing';

type Art = NonNullable<DiscoverTileView['illustration']>;
/** The governance card a save opened, or the one already waiting (#2086). */
type ProposalLink = { id: number; href: string };
/**
 * The card colour rides INSIDE the framing state, not beside it, and that is
 * what makes every existing action behave the way it already did: a gesture
 * spreads the frame over it, Reset position replaces only the frame, Replace
 * image keeps the colour that was picked to sit with the artwork, Use app icon
 * drops the whole record, and Cancel writes nothing because nothing here is
 * written before Save.
 */
// Keyboard equivalents for the gestures, so framing is not mouse-only now
// that the sliders are gone.
const KEY_PAN = 3;
const KEY_ZOOM = 1.08;

export function FeaturedIllustrationEditor({ app, onClose }: { app: any; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const [art, setArt] = useState<Art | null>(null);
  const pendingBlob = useRef<Blob | null>(null);
  const pendingDark = useRef<Blob | null>(null);
  const uploadTheme = useRef<'light' | 'dark'>('light');
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // #2086: a save no longer changes the app. It opens a governance card the
  // group votes on, so the editor tells the user where it went (`sent`) and,
  // when one is already open, that this save has to wait for it (`pending`).
  const [pending, setPending] = useState<ProposalLink | null>(null);
  const [sent, setSent] = useState<ProposalLink | null>(null);
  // Live pointers, in insertion order: one is a drag, two or more a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [dragging, setDragging] = useState(false);
  const endpoint = `/api/apps/${encodeURIComponent(app.slug)}/featured-illustration`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the illustration. Reopen the editor to try again.');
      if (controller.signal.aborted) return;
      setArt(data.illustration ? { ...data.illustration, ...clampFrame(data.illustration) } : null);
      setPending(data.pending || null); setLoading(false);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => { controller.abort(); generation.current++; };
  }, [endpoint]);
  useEffect(() => {
    const url = art?.url;
    return () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [art?.url]);
  useEffect(() => {
    const url = art?.darkUrl;
    return () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [art?.darkUrl]);
  useIsomorphicLayoutEffect(() => {
    if (!root.current || !card.current) return;
    let adoption: KitAdoption | null = adoptKitSurface({ kind: 'modal', contentEl: card.current,
      adoptedOn: root.current, home: 'placeholder', gate: 'kit', onDismiss: () => { adoption = null; close.current(); } });
    return () => { if (adoption) { adoption.restore(); adoption.dismiss(); } };
  }, []);
  const interactive = !!art && !busy && !loading && !sent;
  // The art block, not the whole card: the name and blurb below it are not a
  // framing surface, and its box is what every gesture is measured against.
  const artRect = () => {
    const rect = surface.current?.querySelector('.home-discover-art')?.getBoundingClientRect();
    return rect && rect.width && rect.height ? rect : null;
  };
  // A native listener, because React's onWheel is passive at the root and so
  // cannot preventDefault — without which a zoom scrolls the dialog too.
  useEffect(() => {
    const el = surface.current;
    if (!el || !interactive) return undefined;
    const onWheel = (event: WheelEvent) => {
      const rect = artRect();
      if (!rect || event.clientY > rect.bottom) return;
      event.preventDefault();
      setArt(a => a ? { ...a, ...zoomFrame(a, wheelZoomFactor(event.deltaY, event.deltaMode),
        (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height) } : a);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [interactive]);
  useEffect(() => { if (!interactive) { pointers.current.clear(); setDragging(false); } }, [interactive]);
  const endPointer = (id: number) => {
    pointers.current.delete(id);
    if (!pointers.current.size) setDragging(false);
  };
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !art) return;
    const pan = { ArrowLeft: [-KEY_PAN, 0], ArrowRight: [KEY_PAN, 0], ArrowUp: [0, -KEY_PAN], ArrowDown: [0, KEY_PAN] }[event.key];
    const zoom = event.key === '+' || event.key === '=' ? KEY_ZOOM : event.key === '-' || event.key === '_' ? 1 / KEY_ZOOM : 0;
    if (!pan && !zoom) return;
    event.preventDefault();
    setArt(a => a ? { ...a, ...(pan ? panFrame(a, pan[0] / 100, pan[1] / 100) : zoomFrame(a, zoom)) } : a);
  };
  const chooseFile = async (chosen?: File) => {
    if (!chosen) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const prepared = await prepareIllustration(chosen);
      if (current !== generation.current) return;
      const url = URL.createObjectURL(prepared);
      if (uploadTheme.current === 'dark') {
        pendingDark.current = prepared;
        setArt(a => a ? { ...a, darkUrl: url } : null);
      } else {
        pendingBlob.current = prepared;
        setArt(a => a ? { ...a, url } : { url, ...DEFAULT_FRAME, tint: null });
      }
      setPreviewTheme(uploadTheme.current);
    } catch (err) { if (current === generation.current) setError((err as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const save = async () => {
    if (busy || loading) return;
    setBusy(true); setError('');
    try {
      const encode = async (blob: Blob | null) => {
        if (!blob) return undefined;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(binary);
      };
      const framing = art ? { ...clampFrame(art), ...(art.tint ? { tint: art.tint } : null) } : null;
      const res = await fetch(endpoint, { method: art ? 'PUT' : 'DELETE',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: art ? JSON.stringify({ ...framing, light: await encode(pendingBlob.current),
          dark: art.darkUrl ? await encode(pendingDark.current) : null }) : undefined });
      const data = await res.json();
      if (!res.ok) {
        // 409 carries the card already waiting; keep it on screen with the
        // message so the link is one tap away.
        if (data.pending) setPending(data.pending);
        throw new Error(data.error || 'Could not save. Try again.');
      }
      // Nothing changed on the app: the caches the editor used to patch here
      // are patched by the illustration_changed broadcast when the vote
      // applies it. Removing an illustration the app never had opens nothing.
      if (!data.proposal) { close.current(); return; }
      setSent(data.proposal);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const cachedApp = (window as any).Home?._apps?.find((a: any) => a.slug === app.slug);
  const fallback = app.icon_url || (app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null);
  const tile: DiscoverTileView = {
    slug: app.slug, name: app.name, status: app.status, demo: !!app.demo,
    added: !!(window as any).Home?.isYours?.(app),
    icon: fallback ? { kind: 'image', src: fallback } : app.icon_emoji
      ? { kind: 'emoji', emoji: app.icon_emoji } : { kind: 'letter', letter: String(app.name || '?')[0].toUpperCase() },
    blurb: (window as any).HomePanels?.appBlurb?.(app) || null,
    contributors: Number(app.contributor_count ?? cachedApp?.contributor_count) || 0, illustration: art,
  };
  return <div ref={root} className="rounded-2xl bg-white dark:bg-zinc-900 mb-5">
    <div ref={card} className="flex flex-col px-4 pb-5" aria-label="Featured illustration">
      <h2 className="text-lg font-bold pt-3 pb-4">Featured illustration</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">Preview on Discover</p>
      <div className="flex gap-2 mb-3" role="group" aria-label="Preview theme">
        {(['light', 'dark'] as const).map(theme => <Button key={theme} type="button" variant="neutral" ink="muted"
          aria-pressed={previewTheme === theme} className={previewTheme === theme ? 'ring-2 ring-violet-500' : undefined} onClick={() => setPreviewTheme(theme)}>
          {theme === 'light' ? 'Light' : 'Dark'}
        </Button>)}
      </div>
      <div className="flex justify-center mb-4">
        <div ref={surface} data-framing-surface={art ? 'true' : 'false'} role="group"
          aria-label="Illustration framing: drag to move, scroll or pinch to zoom, arrow keys to nudge"
          tabIndex={interactive ? 0 : -1}
          className="rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          // touchAction so a pan is a pan and not a page scroll; userSelect
          // because otherwise a drag across the card selects the name and
          // blurb under it, which on touch leaves them highlighted blue.
          style={{ touchAction: interactive ? 'none' : 'auto', userSelect: 'none', WebkitUserSelect: 'none',
            cursor: !interactive ? 'default' : dragging ? 'grabbing' : 'grab' }}
          onKeyDown={nudge}
          onPointerDown={event => {
            if (!interactive) return;
            const rect = artRect();
            if (!rect || event.clientY > rect.bottom) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            setDragging(true);
          }}
          onPointerMove={event => {
            const live = pointers.current;
            if (!live.has(event.pointerId)) return;
            const rect = artRect();
            if (!rect) return;
            // Incremental: one step per move event, clamped each time, so a
            // pinch that hits the zoom ceiling simply stops instead of
            // banking travel it later replays.
            const before = [...live.values()];
            live.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const after = [...live.values()];
            const from = centreOf(before), to = centreOf(after);
            const was = spreadOf(before), now = spreadOf(after);
            setArt(a => {
              if (!a) return a;
              let next: Art = a;
              if (was > 0 && now > 0) {
                next = { ...next, ...zoomFrame(next, now / was,
                  (to.x - rect.left) / rect.width, (to.y - rect.top) / rect.height) };
              }
              return { ...next, ...panFrame(next, (to.x - from.x) / rect.width, (to.y - from.y) / rect.height) };
            });
          }}
          onPointerUp={event => endPointer(event.pointerId)}
          onPointerCancel={event => endPointer(event.pointerId)}>
          <DiscoverCard tile={tile} preview previewTheme={previewTheme} />
        </div>
      </div>
      <input ref={file} name="featured-illustration" type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        aria-label="Upload featured illustration" onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
      <fieldset disabled={busy || loading || !!sent} className="flex flex-col gap-3">
        <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => { uploadTheme.current = 'light'; file.current?.click(); }}>{art ? 'Replace light image' : 'Upload light image'}</Button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">PNG, JPEG or WebP, up to 20 MB.</p>
        {art ? <>
          <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]"
            onClick={() => { uploadTheme.current = 'dark'; file.current?.click(); }}>
            {art.darkUrl ? 'Replace dark image' : 'Upload dark image'}
          </Button>
          {art.darkUrl ? <Button type="button" variant="neutral" ink="muted"
            onClick={() => { pendingDark.current = null; setArt({ ...art, darkUrl: null }); }}>Use light image in both themes</Button> : null}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Use images with the same dimensions. Framing and colour are shared across both themes.</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Drag the card to move the image. Scroll or pinch to zoom. Zoom <span data-zoom-readout>{Math.round(art.zoom * 100)}%</span>.
          </p>
          {/*
              The twelve tone-50 colours, and nothing else: no hex field and
              no colour input, because the point is a card that belongs to the
              app's own palette. A swatch wears its own tone class, so the two
              custom properties it paints from are exactly the ones the card
              will use — one palette, read from one place.

              An illustration saved before these existed carries one of the
              five hashed tints instead. It still renders (see cardTintClass),
              it simply matches no swatch, so the row shows nothing selected
              until a colour is picked — which is the honest reading of "the
              colour this card wears is not one of these".
          */}
          <div data-tint-picker role="radiogroup" aria-label="Card colour" className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500 dark:text-zinc-400 mr-1">Card colour</span>
            {TONES.map(tone => {
              const chosen = art.tint === tone;
              return <button key={tone} type="button" role="radio" aria-checked={chosen}
                aria-label={toneLabel(tone)} title={toneLabel(tone)}
                data-tint={tone} data-chosen={String(chosen)}
                onClick={() => setArt({ ...art, tint: tone })}
                className={`${cardTintClass(tone)} un-touch-target w-8 h-8 rounded-full border transition-shadow ${
                  chosen ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900' : ''}`}
                style={{ background: 'var(--tone-50)', borderColor: 'var(--tint-line)' }} />;
            })}
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => setArt({ ...art, ...DEFAULT_FRAME })}>Reset position</Button>
            <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => { setArt(null); pendingBlob.current = null; pendingDark.current = null; }}>Use app icon</Button>
          </div>
        </> : null}
      </fieldset>
      {loading && !error ? <p role="status" className="text-sm mt-3">Loading preview…</p> : null}
      {error ? <p role="alert" className="text-sm text-red-500 mt-3">{error}</p> : null}
      {sent ? <p role="status" data-illustration-sent className="text-sm mt-3 text-zinc-700 dark:text-zinc-300">
        {'Sent to the group for approval. The illustration changes when the vote passes. '}
        <a href={sent.href} className="text-violet-600 dark:text-violet-400 underline" onClick={onClose}>Open the proposal</a>
      </p> : pending ? <p role="status" data-illustration-pending className="text-sm mt-3 text-zinc-700 dark:text-zinc-300">
        {'A change to this illustration is already waiting for the group\'s vote. Another can be proposed once it settles. '}
        <a href={pending.href} className="text-violet-600 dark:text-violet-400 underline" onClick={onClose}>Open the proposal</a>
      </p> : <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">Proposing opens a governance card on the board. The change applies when the group votes it in.</p>}
      <div className="flex gap-3 mt-5">
        {sent
          ? <Button type="button" className="min-h-[44px] flex-1" onClick={onClose}>Done</Button>
          : <>
            <Button type="button" className="min-h-[44px] flex-1" disabled={loading || busy || !!pending} onClick={() => { void save(); }}>{busy ? 'Please wait…' : 'Propose change'}</Button>
            <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" disabled={busy} onClick={onClose}>Cancel</Button>
          </>}
      </div>
    </div>
  </div>;
}
