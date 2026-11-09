// Homeroom bot parity, P8: the "gallery" card (see ./index.tsx): the pictures
// Homeroom bot made on an outside picture model (services/bot-pictures.js),
// under its reply.
//
//   ┌──────────┐ ┌──────────┐
//   │    A     │ │    B     │      a tap opens the picture in the viewer
//   └──────────┘ └──────────┘
//   A · light     B · light
//   [A] [B]                          which picture the buttons are for
//   [Propose A as the featured picture] [Use A in the app] [More like A]
//   Paid from your weekly building time.
//
// The card holds ids and addresses only; each picture is read from its
// address (members of the chat only). Propose, Use and Add to the design
// are decided on the server (homeroom-bot-cards/gallery.js); Use, Add to the
// design and More like are then said as the person's own words, which the
// bot reads like anything they type.

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { ImageViewer, openInViewer } from '../../image-viewer/image-viewer';
import { decideCard, sayAsMe, type BotCardProps } from './index';

const PICTURE_PATH = '/api/conversations/homeroom-bot/pictures/';
const ID_RE = /^[0-9a-f]{32}$/;
const LETTERS = ['A', 'B', 'C', 'D'];

export interface GalleryImage {
  id: string;
  url: string;
  letter: string;
  variant: 'light' | 'dark' | null;
  label: string;
  width: number | null;
  height: number | null;
}

export interface GalleryState {
  images: GalleryImage[];
  letters: string[];
  project: { slug: string; name: string } | null;
  canFeature: boolean;
  designRootId: number | null;
  featured: { letter: string; href: string } | null;
  used: string[];
  designed: string[];
}

function size(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 8192 ? n : null;
}

/**
 * Pure: the card as the server stored it, read defensively. A picture's
 * address is always built from its id, never taken from the card.
 */
export function galleryOf(card: Record<string, unknown>): GalleryState {
  const raw = Array.isArray(card.images) ? card.images : [];
  const images: GalleryImage[] = [];
  for (const entry of raw.slice(0, 8)) {
    const im = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = String(im.id || '');
    const letter = String(im.letter || '');
    if (!ID_RE.test(id) || !LETTERS.includes(letter)) continue;
    images.push({
      id,
      url: `${PICTURE_PATH}${id}`,
      letter,
      variant: im.variant === 'light' || im.variant === 'dark' ? im.variant : null,
      label: typeof im.label === 'string' ? im.label.slice(0, 20) : letter,
      width: size(im.width),
      height: size(im.height),
    });
  }
  const letters = LETTERS.filter((l) => images.some((im) => im.letter === l));
  const projectRow = card.project && typeof card.project === 'object' ? card.project as Record<string, unknown> : null;
  const project = projectRow && typeof projectRow.slug === 'string' && projectRow.slug
    ? { slug: projectRow.slug, name: typeof projectRow.name === 'string' && projectRow.name ? projectRow.name : projectRow.slug }
    : null;
  const featuredRow = card.featured && typeof card.featured === 'object' ? card.featured as Record<string, unknown> : null;
  const href = featuredRow && typeof featuredRow.href === 'string' && featuredRow.href.startsWith('#') ? featuredRow.href : '';
  const rootId = Number(card.designRootId);
  return {
    images,
    letters,
    project,
    canFeature: card.canFeature === true && !!project,
    designRootId: Number.isSafeInteger(rootId) && rootId > 0 ? rootId : null,
    featured: href && LETTERS.includes(String(featuredRow?.letter)) ? { letter: String(featuredRow?.letter), href } : null,
    used: Array.isArray(card.used)
      ? card.used.map((u) => String((u as { id?: unknown })?.id || '')).filter((id) => ID_RE.test(id)) : [],
    designed: Array.isArray(card.designed) ? card.designed.map(String).filter((id) => ID_RE.test(id)) : [],
  };
}

/** Pure: the picture a letter's buttons act on: its light (or only) one. */
export function pictureFor(images: readonly GalleryImage[], letter: string): GalleryImage | null {
  return images.find((im) => im.letter === letter && im.variant !== 'dark') || images.find((im) => im.letter === letter) || null;
}

function Thumb({ image, caption }: { image: GalleryImage; caption: string }): ReactNode {
  const t = useMessages('messages');
  const [viewing, setViewing] = useState(false);
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : '1 / 1';
  return (
    <li className="flex min-w-0 flex-col gap-1" data-bot-gallery-image={image.id}>
      <a
        href={image.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-xl bg-zinc-100 shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800"
        style={{ aspectRatio: ratio }}
        aria-label={t('messages:botCards.gallery.open', { label: caption })}
        onClick={(event) => openInViewer(event, () => setViewing(true))}
      >
        <img src={image.url} alt={caption} loading="lazy" className="h-full w-full object-cover" />
      </a>
      <span className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">{caption}</span>
      {viewing ? <ImageViewer src={image.url} alt={caption} onClose={() => setViewing(false)} /> : null}
    </li>
  );
}

export function GalleryCard({ message, card }: BotCardProps): ReactNode {
  const t = useMessages('messages');
  // #6533: a change's pictures are drawn by their own card.
  if (card.purpose === 'change') return <ChangePictures card={card} />;
  const g = galleryOf(card);
  const [letter, setLetter] = useState(g.letters[0] || 'A');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // What was done here before the card's own update arrives.
  const [done, setDone] = useState<{ featured?: { letter: string; href: string }; used: string[]; designed: string[] }>({ used: [], designed: [] });
  if (!g.images.length) return null;
  const picture = pictureFor(g.images, letter);
  const featured = g.featured || done.featured || null;
  const used = picture ? g.used.includes(picture.id) || done.used.includes(picture.id) : false;
  const designed = picture ? g.designed.includes(picture.id) || done.designed.includes(picture.id) : false;
  const caption = (im: GalleryImage) => (im.variant === 'light' && g.images.some((o) => o.letter === im.letter && o.variant === 'dark')
    ? t('messages:botCards.gallery.captionLight', { letter: im.letter })
    : im.variant === 'dark' && g.images.some((o) => o.letter === im.letter && o.variant === 'light')
      ? t('messages:botCards.gallery.captionDark', { letter: im.letter })
      : im.letter);

  const act = async (what: string, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError('');
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.gallery.failed'));
    } finally {
      setBusy(null);
    }
  };
  const feature = () => act('feature', async () => {
    if (!picture) return;
    const out = await decideCard(message, 'feature', picture.id);
    const href = String((out.proposal as { href?: unknown } | undefined)?.href || '');
    setDone((d) => ({ ...d, featured: { letter: picture.letter, href: href.startsWith('#') ? href : '' } }));
  });
  const use = () => act('use', async () => {
    if (!picture) return;
    const out = await decideCard(message, 'use', picture.id);
    const url = String(out.url || '');
    setDone((d) => ({ ...d, used: [...d.used, picture.id] }));
    await sayAsMe(message, g.project
      ? t('messages:botCards.gallery.useWords', { letter: picture.letter, project: g.project.name, url })
      : t('messages:botCards.gallery.useWordsNoProject', { letter: picture.letter, url }));
  });
  const design = () => act('design', async () => {
    if (!picture) return;
    await decideCard(message, 'design', picture.id);
    setDone((d) => ({ ...d, designed: [...d.designed, picture.id] }));
    await sayAsMe(message, t('messages:botCards.gallery.designWords', { letter: picture.letter }));
  });
  const more = () => act('more', () => sayAsMe(message, t('messages:botCards.gallery.moreWords', { letter })));

  return (
    <div className="mt-2 flex max-w-[420px] flex-col gap-2" data-bot-gallery="">
      <ul className="grid grid-cols-2 gap-2" aria-label={t('messages:botCards.gallery.groupLabel')}>
        {g.images.map((im) => <Thumb key={im.id} image={im} caption={caption(im)} />)}
      </ul>
      {g.letters.length > 1 ? (
        <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.gallery.pickGroup')}>
          {g.letters.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={l === letter}
              aria-label={t('messages:botCards.gallery.pick', { letter: l })}
              onClick={() => setLetter(l)}
              data-bot-gallery-letter={l}
            >
              <span>{l}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="messages-bot-answers" role="group" aria-label={t('messages:botCards.gallery.actions')}>
        {g.canFeature && !featured ? (
          <button type="button" className="messages-bot-secondary" disabled={!!busy} onClick={() => void feature()} data-bot-gallery-action="feature">
            <span>{t('messages:botCards.gallery.feature', { letter })}</span>
          </button>
        ) : null}
        {featured ? (
          <button type="button" className="messages-bot-done" disabled data-bot-gallery-featured={featured.letter}>
            <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('messages:botCards.gallery.featured', { letter: featured.letter })}</span>
          </button>
        ) : null}
        {g.designRootId ? (
          <button
            type="button"
            className={designed ? 'messages-bot-done' : 'messages-bot-secondary'}
            disabled={!!busy || designed}
            onClick={() => void design()}
            data-bot-gallery-action="design"
          >
            {designed ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            <span>{designed ? t('messages:botCards.gallery.designed', { letter }) : t('messages:botCards.gallery.design', { letter })}</span>
          </button>
        ) : (
          <button
            type="button"
            className={used ? 'messages-bot-done' : 'messages-bot-secondary'}
            disabled={!!busy || used}
            onClick={() => void use()}
            data-bot-gallery-action="use"
          >
            {used ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            <span>{used ? t('messages:botCards.gallery.used', { letter }) : t('messages:botCards.gallery.use', { letter })}</span>
          </button>
        )}
        <button type="button" className="messages-bot-secondary" disabled={!!busy} onClick={() => void more()} data-bot-gallery-action="more">
          <span>{t('messages:botCards.gallery.more', { letter })}</span>
        </button>
      </div>
      {featured?.href ? (
        <a className="text-[13px] font-semibold text-violet-700 dark:text-violet-300" href={featured.href} data-bot-gallery-vote="">
          {t('messages:botCards.gallery.seeVote')}
        </a>
      ) : null}
      {error ? <p className="messages-bot-note" role="alert">{error}</p> : null}
      <p className="messages-bot-note" data-bot-gallery-paid="">{t('messages:botCards.gallery.paid')}</p>
    </div>
  );
}

// ── A change's pictures (#6533) ─────────────────────────────────────────
//
// Under Homeroom bot's reply in a change's thread: what the change looks
// like, as pictures. An email is drawn through the sandboxed frame the admin
// console's preview uses (the route answers JSON, never text/html); a screen
// is the change's own verified shot. Nothing here runs the change's code.

export interface ChangePicture {
  id: string;
  source: 'email' | 'shot';
  side: 'before' | 'after';
  isNew: boolean;
  caption: string;
  url: string | null;
  width: number | null;
  height: number | null;
}

export interface ChangeGalleryState {
  slug: string;
  sessionId: number;
  number: number | null;
  images: ChangePicture[];
}

interface EmailBody {
  kind: string;
  side: 'before' | 'after';
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

/** Pure: the card as the server stored it, read defensively. Ids only. */
export function changeGalleryOf(card: Record<string, unknown>): ChangeGalleryState | null {
  if (card.purpose !== 'change') return null;
  const project = card.project && typeof card.project === 'object' ? card.project as Record<string, unknown> : null;
  const change = card.change && typeof card.change === 'object' ? card.change as Record<string, unknown> : null;
  const slug = project && typeof project.slug === 'string' ? project.slug : '';
  const sessionId = Number(change?.sessionId);
  if (!slug || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  const images: ChangePicture[] = [];
  for (const entry of Array.isArray(card.images) ? card.images.slice(0, 12) : []) {
    const im = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = String(im.id || '');
    if (!ID_RE.test(id)) continue;
    const source = im.source === 'shot' ? 'shot' : 'email';
    images.push({
      id,
      source,
      side: im.side === 'before' ? 'before' : 'after',
      isNew: im.isNew === true,
      caption: typeof im.caption === 'string' ? im.caption.slice(0, 200) : '',
      url: source === 'shot' && typeof im.url === 'string' && im.url.startsWith('/api/') ? im.url : null,
      width: size(im.width),
      height: size(im.height),
    });
  }
  const number = Number(change?.number);
  return { slug, sessionId, number: Number.isSafeInteger(number) && number > 0 ? number : null, images };
}

function emailUrl(slug: string, sessionId: number, id: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/proposals/${sessionId}/pictures/${id}`;
}

function EmailFrame({ html, title, className }: { html: string; title: string; className?: string }): ReactNode {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className={className || 'h-full w-full'}
      style={{ border: 0, pointerEvents: 'none', background: '#f5f5f7' }}
    />
  );
}

function labelOf(picture: ChangePicture, t: (id: string) => string): string {
  const base = picture.side === 'before' ? t('messages:botCards.gallery.today') : t('messages:botCards.gallery.withChange');
  return picture.isNew ? `${base} · ${t('messages:botCards.gallery.newMark')}` : base;
}

function EmailTile({ slug, sessionId, picture }: { slug: string; sessionId: number; picture: ChangePicture }): ReactNode {
  const t = useMessages('messages');
  const [body, setBody] = useState<EmailBody | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(emailUrl(slug, sessionId, picture.id), { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data && typeof data.html === 'string') setBody(data as EmailBody); })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, sessionId, picture.id]);
  const label = labelOf(picture, t);
  const title = picture.caption || t('messages:botCards.gallery.emailFrame', { subject: '' });
  return (
    <li className="flex min-w-0 flex-col gap-1" data-bot-change-picture={picture.id} data-bot-change-side={picture.side}>
      <button
        type="button"
        className="block overflow-hidden rounded-xl bg-white text-start shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
        style={{ aspectRatio: '4 / 5' }}
        aria-label={t('messages:botCards.gallery.openEmail', { subject: picture.caption })}
        onClick={() => setOpen(true)}
      >
        {body ? <EmailFrame html={body.html} title={t('messages:botCards.gallery.emailFrame', { subject: picture.caption })} /> : <span className="block h-full w-full" aria-hidden="true" />}
      </button>
      <span className="text-[12px] font-bold text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="truncate text-[13px]">{picture.caption}</span>
      {open && body ? (
        <EmailViewer body={body} caption={picture.caption} onClose={() => setOpen(false)} />
      ) : null}
      <span className="sr-only">{title}</span>
    </li>
  );
}

function EmailViewer({ body, caption, onClose }: { body: EmailBody; caption: string; onClose: () => void }): ReactNode {
  const t = useMessages('messages');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-[720px] rounded-2xl bg-white p-4 dark:bg-zinc-900" onClick={(event) => event.stopPropagation()}>
        <p className="mb-1 text-[13px] font-semibold">{t('messages:botCards.gallery.subjectLine', { subject: body.subject || caption })}</p>
        {body.preheader ? <p className="mb-2 text-[13px] text-zinc-500 dark:text-zinc-400">{body.preheader}</p> : null}
        <div className="h-[70vh] overflow-hidden rounded-xl">
          <EmailFrame html={body.html} title={t('messages:botCards.gallery.emailFrame', { subject: body.subject || caption })} />
        </div>
        <button type="button" className="messages-bot-secondary mt-3" onClick={onClose}>Close</button>
      </div>
    </div>,
    document.body,
  );
}

function ScreenTile({ picture }: { picture: ChangePicture }): ReactNode {
  const t = useMessages('messages');
  const [viewing, setViewing] = useState(false);
  const label = labelOf(picture, t);
  const src = picture.url || '';
  if (!src) return null;
  const ratio = picture.width && picture.height ? `${picture.width} / ${picture.height}` : '4 / 5';
  return (
    <li className="flex min-w-0 flex-col gap-1" data-bot-change-picture={picture.id} data-bot-change-side={picture.side}>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-xl bg-zinc-100 shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800"
        style={{ aspectRatio: ratio }}
        aria-label={t('messages:botCards.gallery.openScreen', { caption: picture.caption })}
        onClick={(event) => openInViewer(event, () => setViewing(true))}
      >
        <img src={src} alt={picture.caption} loading="lazy" className="h-full w-full object-cover" />
      </a>
      <span className="text-[12px] font-bold text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="truncate text-[13px]">{picture.caption}</span>
      {viewing ? <ImageViewer src={src} alt={picture.caption} onClose={() => setViewing(false)} /> : null}
    </li>
  );
}

/** The pictures under Homeroom bot's reply in a change's thread. */
export function ChangePictures({ card }: { card: Record<string, unknown> | null | undefined }): ReactNode {
  const t = useMessages('messages');
  const g = card ? changeGalleryOf(card as Record<string, unknown>) : null;
  if (!g || !g.images.length) return null;
  return (
    <div className="mt-2 flex max-w-[520px] flex-col gap-2" data-bot-change-gallery="" data-bot-change={g.sessionId}>
      <ul className="grid grid-cols-2 gap-2" aria-label={t('messages:botCards.gallery.changeGroup')}>
        {g.images.map((im) => (im.source === 'shot'
          ? <ScreenTile key={im.id} picture={im} />
          : <EmailTile key={im.id} slug={g.slug} sessionId={g.sessionId} picture={im} />))}
      </ul>
    </div>
  );
}
