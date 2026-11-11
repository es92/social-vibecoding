/**
 * The frame's kit: the components every page of the one frame is drawn with.
 *
 * These are the 2026-11-06 screen tour's own components (its kit.mjs:
 * page(), s(), list(), r(), tiles(), pill(), btn() …) as React, emitting
 * the same markup under the same class names with an `fr-` prefix. Their
 * styles are the tour's own stylesheets, compiled into app.css between the
 * `looks:begin` and `looks:end` marks (scripts/build-looks-css.js, from
 * frontend/looks/): the kit's rules for any look, then one block per look.
 * So a screen drawn here is the screen the tour drew, under each of the
 * nine looks, and a look is changed in its file there, never here.
 *
 * NO TAILWIND AND NO VALUES HERE. A kit element carries kit classes only;
 * a utility class would sit beside a look's rule and one of the nine would
 * stop matching the tour. The one inline style is a size or a colour the
 * data gives (a tile's size, a community's own colour), passed as the
 * custom property the kit reads.
 *
 * Kit markup exists only under a look (lib/skin.ts isFrameSkin) and only
 * inside an element with class `fr`, the frame root, where the kit's reset
 * and type apply (`Frame` below). Rules of the frame the components keep
 * for their callers (docs/superpowers/specs/2026-11-08-one-frame-glass-
 * spec.md): one row for everything listed (picture, name, one line, one
 * status), at most one pill on it, a zero says nothing.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import { KIT_ICONS } from './kit-icons';

/** `k('row sm on')` → `fr-row fr-sm fr-on`. Falsy parts are dropped. */
export function k(...names: Array<string | false | null | undefined>): string {
  return names
    .flatMap((n) => (n ? n.split(/\s+/) : []))
    .filter(Boolean)
    .map((n) => `fr-${n}`)
    .join(' ');
}

type Custom = React.CSSProperties & Record<`--fr-${string}`, string | number>;

/** The frame root: where the kit's reset, ink and type begin. */
export function Frame({ as: Tag = 'div', className, children, ...props }: {
  as?: 'div' | 'section' | 'main';
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return <Tag className={`fr${className ? ` ${className}` : ''}`} {...props}>{children}</Tag>;
}

/** One of the kit's 24px stroked glyphs (./kit-icons.ts), decorative. */
export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={k('ic', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Our own static path strings, never a person's text.
      dangerouslySetInnerHTML={{ __html: KIT_ICONS[name] || KIT_ICONS.info }}
    />
  );
}

/**
 * A project's picture: the one tile on the product. Its own image when it
 * has one, else its emoji or first letter on its colour.
 */
export function Tile({ size = 40, src, emoji, color, name = '' }: {
  size?: number;
  src?: string | null;
  emoji?: string | null;
  color?: string | null;
  name?: string;
}) {
  const style: Custom = { '--fr-ts': `${size}px` };
  // A picture or an emoji with no colour of its own sits on white, as the
  // launcher's tiles do: many icons are drawn on transparency.
  style['--fr-tc'] = color || '#fff';
  return (
    <span className={k('tile')} style={style} aria-hidden="true">
      {src
        ? <img src={src} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : (emoji || name.slice(0, 1).toUpperCase())}
    </span>
  );
}

/** A person: their picture, else their first letter on their colour. */
export function Av({ size = 32, name, src, color }: { size?: number; name: string; src?: string | null; color?: string | null }) {
  const style: Custom = { '--fr-as': `${size}px` };
  if (color) style['--fr-ac'] = color;
  return (
    <span className={k('av')} style={style} aria-hidden="true">
      {src
        ? <img src={src} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
        : name.replace('@', '').slice(0, 1)}
    </span>
  );
}

/** A glyph or a number in the picture's place. */
export function Lead({ icon, tone, size, children }: { icon?: string; tone?: 'acc' | 'ok' | 'wait' | 'bad'; size?: number; children?: React.ReactNode }) {
  // A lead in a grid of tiles is the tiles' size, with their corner.
  const style = size ? { width: size, height: size, borderRadius: Math.round(size * 0.29) } : undefined;
  return <span className={k('lead', tone)} style={style} aria-hidden={icon ? 'true' : undefined}>{icon ? <Icon name={icon} size={size ? Math.round(size * 0.42) : 20} /> : children}</span>;
}

export type PillKind = 'act' | 'wait' | 'ok' | 'bad' | '';

function saysNothing(children: React.ReactNode): boolean {
  return children === null || children === undefined || children === false
    || children === 0 || children === '' || (typeof children === 'string' && children.trim() === '');
}

/**
 * One word of status, coloured by what it means: `act` blue (this waits
 * for you), `wait` amber (on others), `ok` green (done), `bad` red, none
 * grey. Zero or empty renders nothing.
 */
export function Pill({ kind = '', children }: { kind?: PillKind; children?: React.ReactNode }) {
  if (saysNothing(children)) return null;
  return <span className={k('pill', kind)} data-kind={kind || 'none'}>{children}</span>;
}

/** A count that asks for you. Zero renders nothing. */
export function Count({ children, label }: { children?: React.ReactNode; label?: string }) {
  if (saysNothing(children)) return null;
  return <span className={k('n')} aria-label={label}>{children}</span>;
}

type BtnOwn = {
  /** '' the page's one primary · quiet · line · ok · bad */
  kind?: '' | 'quiet' | 'line' | 'ok' | 'bad';
  icon?: string;
  small?: boolean;
  block?: boolean;
};

export function Btn({ kind = '', icon, small, block, className, type = 'button', children, ...props }:
  BtnOwn & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={k('btn', kind, small && 'sm', block && 'block', props.disabled && 'off', className)} {...props}>
      {icon ? <Icon name={icon} size={17} /> : null}
      {children}
    </button>
  );
}

/** Grey words at the end of a row: a time, an amount. */
export function Meta({ children }: { children?: React.ReactNode }) {
  if (saysNothing(children)) return null;
  return <span className={k('meta')}>{children}</span>;
}

export interface RowProps {
  /** The picture: a <Tile/>, an <Av/> or a <Lead/>. */
  lead?: React.ReactNode;
  title: React.ReactNode;
  /** The one line under the name. Without it the row is the single-line kind unless `sm` says otherwise. */
  line?: React.ReactNode;
  /** The one status: a <Pill/>, a <Meta/>, a small <Btn/>. */
  right?: React.ReactNode;
  /** A chevron: the row opens something. */
  go?: boolean;
  /** You are here. */
  on?: boolean;
  /** 48px, for a single line. Defaults to "no line". */
  sm?: boolean;
  /** The name and line may wrap to two lines. */
  wrap?: boolean;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Said to a screen reader where the visible row would be ambiguous. */
  label?: string;
  /** A row that is a choice: picked or not, said as a toggle. The lit row (`on`) shows it. */
  pressed?: boolean;
}

/**
 * THE row. Anything listed is this: picture, name, one line, one status,
 * in that order. A row with an `href` is a link (a door: cmd-click keeps
 * the address); with only `onClick` a button; else plain.
 */
export function Row({ lead, title, line, right, go, on, sm, wrap, href, onClick, label, pressed }: RowProps) {
  const cls = k('row', (sm ?? !line) && 'sm', on && 'on', wrap && 'wrap');
  const body = (
    <>
      {lead}
      <span className={k('tx')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s')}>{line}</span> : null}
      </span>
      {right}
      {go ? <Icon name="cr" size={18} className="go" /> : null}
    </>
  );
  if (href) return <a className={cls} href={href} onClick={onClick} aria-label={label} aria-current={on ? 'page' : undefined}>{body}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label} aria-pressed={pressed}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/** A group's surface: rows, or any one block. */
export function Card({ pad, className, children }: { pad?: boolean; className?: string; children?: React.ReactNode }) {
  return <div className={k('card', pad && 'pad', className)}>{children}</div>;
}

/** A group's link, at the end of its label: "All 18", "Edit". */
export function GroupLink({ href, onClick, children }: { href?: string; onClick?: (event: React.MouseEvent<HTMLElement>) => void; children: React.ReactNode }) {
  if (href) return <a className={k('link')} href={href} onClick={onClick}>{children}</a>;
  return <button type="button" className={k('link')} onClick={onClick}>{children}</button>;
}

/** A labelled group: the label, at most one link, then one block. */
export function Sec({ label, action, id, children, ...props }: { label?: React.ReactNode; action?: React.ReactNode; id?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={k('sec')} id={id} {...props}>
      {label ? (
        <div className={k('sechead')}>
          <h2 className={k('cap')}>{label}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Things you open, as a grid of tiles: apps, and only apps. */
export function Tiles({ children }: { children?: React.ReactNode }) {
  return <Card><div className={k('tiles')}>{children}</div></Card>;
}

/** One tile of the grid, with its name under it and a count if it asks for you. */
export function TileItem({ tile, name, count, href, onClick }: {
  tile: React.ReactNode;
  name: React.ReactNode;
  count?: number;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const body = (<>{tile}<Count>{count}</Count><span className={k('nm')}>{name}</span></>);
  if (href) return <a className={k('at')} href={href} onClick={onClick}>{body}</a>;
  return <button type="button" className={k('at')} onClick={onClick}>{body}</button>;
}

/** Up to five numbers said in words. */
export function Facts({ items }: { items: Array<{ value: React.ReactNode; label: React.ReactNode; tone?: 'acc' | 'ok' | 'wait' }> }) {
  return (
    <Card>
      <div className={k('facts', `f${items.length}`)}>
        {items.map((f, i) => (
          <div className={k('fact')} key={i}>
            <div className={k('v', f.tone)}>{f.value}</div>
            <div className={k('l')}>{f.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * A vote, as the tour's ballot: what is asked, the tally as one bar with
 * the line it must reach, the count in words, then how to cast it. The
 * caller says the words (it knows the language and the rule).
 */
export function Ballot({ pill, id, title, line, yes, no, of, need, words, voters, actions, note }: {
  /** The one status over the title, such as a "Your vote" pill. */
  pill?: React.ReactNode;
  id?: string | null;
  title?: React.ReactNode;
  line?: React.ReactNode;
  yes: number;
  no: number;
  /** How many may vote, and how many yeses pass it. */
  of: number;
  need: number;
  words: { yes: string; rest: string; needed: string };
  voters?: React.ReactNode;
  actions?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / Math.max(of, 1)) * 100))}%`;
  return (
    <Card>
      <div className={k('ballot')}>
        {title ? (
          <div>
            <div className={k('btnrow')}>{pill}{id ? <span className={k('mono')}>{id}</span> : null}</div>
            <div className={k('sub17')} style={{ marginTop: 8 }}>{title}</div>
            {line ? <div className={k('s')} style={{ fontSize: 13, color: 'var(--fr-mut)', marginTop: 4 }}>{line}</div> : null}
          </div>
        ) : null}
        <div className={k('bar2')} role="img" aria-label={`${words.yes} · ${words.rest}`}>
          <i className={k('y')} style={{ width: pct(yes) }} />
          <i className={k('no')} style={{ width: pct(no) }} />
          <span className={k('need')} data-l={words.needed} style={{ insetInlineStart: pct(need) }} />
        </div>
        <div className={k('line1')}><b>{words.yes}</b><span>{words.rest}</span><span style={{ flex: 1 }} />{voters}</div>
        {actions || note ? (
          <div className={k('btnrow')}>
            {actions}
            {note ? <span className={k('meta')} style={{ fontSize: 13, color: 'var(--fr-mut)' }}>{note}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** One sentence the page wants read: plain (navy), or toned. */
export function Note({ tone = '', icon = 'info', children }: { tone?: '' | 'wait' | 'ok' | 'bad'; icon?: string; children: React.ReactNode }) {
  return <div className={k('note', tone)}><Icon name={icon} size={17} /><div>{children}</div></div>;
}

/** The page's head: its title, one sentence saying what it is for, at most one primary action. */
export function Head({ title, purpose, acts }: { title: React.ReactNode; purpose?: React.ReactNode; acts?: React.ReactNode }) {
  return (
    <div className={k('head')}>
      <div className={k('tx')}>
        <h1 className={k('title')}>{title}</h1>
        {purpose ? <p className={k('purpose')}>{purpose}</p> : null}
      </div>
      {acts ? <div className={k('acts')}>{acts}</div> : null}
    </div>
  );
}

/** The page's views, as tabs. */
export function Tabs({ tabs, current, onPick }: {
  tabs: Array<{ key: string; label: React.ReactNode; count?: number; href?: string }>;
  current: string;
  onPick?: (key: string, event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <nav className={k('tabs')}>
      {tabs.map((tab) => {
        const cls = k('tab', tab.key === current && 'on');
        const body = (<>{tab.label}<Count>{tab.count}</Count></>);
        return tab.href
          ? <a key={tab.key} className={cls} href={tab.href} aria-current={tab.key === current ? 'page' : undefined} onClick={(e) => onPick?.(tab.key, e)}>{body}</a>
          : <button key={tab.key} type="button" className={cls} aria-pressed={tab.key === current} onClick={(e) => onPick?.(tab.key, e)}>{body}</button>;
      })}
    </nav>
  );
}

/**
 * The page's body: work in the 720px column, context in the 320px column
 * beside it, which goes below on a phone (above with `sideFirst`).
 */
export function Cols({ side, sideFirst, wide, children }: { side?: React.ReactNode; sideFirst?: boolean; wide?: boolean; children?: React.ReactNode }) {
  return (
    <div className={k('cols', !side && 'one', wide && 'wide')}>
      <div className={k('stack')}>{children}</div>
      {side ? <div className={k('stack', sideFirst && 'first')}>{side}</div> : null}
    </div>
  );
}

/**
 * A page of the frame, inside the page area: the head, its tabs, then the
 * columns. The sidebar, bar and tab bar around it are the shell's
 * (features/frame/frame-app.tsx).
 */
export function PageBody({ title, purpose, acts, tabs, side, sideFirst, wide, below, children, ...props }: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  acts?: React.ReactNode;
  tabs?: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  /** The main column takes the width and the side column is 400px (Home), instead of the tour's 720 and 320. */
  wide?: boolean;
  /** Groups under both columns, the whole width: a sideways row of cards. */
  below?: React.ReactNode;
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Frame {...props}>
      <div className={k('inner')}>
        <Head title={title} purpose={purpose} acts={acts} />
        {tabs}
        <Cols side={side} sideFirst={sideFirst} wide={wide}>{children}</Cols>
        {below ? <div className={k('stack', 'wide')}>{below}</div> : null}
      </div>
    </Frame>
  );
}

/** Cards side by side in one row that scrolls sideways: challenges, featured communities. */
export function HRow({ children }: { children?: React.ReactNode }) {
  return <div className={k('hrow')}>{children}</div>;
}

/**
 * A challenge, as the Challenges tab's card: its art on its tone (or its
 * icon), the goal, the rail with its words and how far along, the reward.
 */
export function ChallengeCard({ href, onClick, art, icon, title, line, state, label, fill, reward }: {
  href: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** The illustration and the fill it sits on; `icon` is drawn when there is none. */
  art?: { src: string; fill: string } | null;
  icon?: string | null;
  title: React.ReactNode;
  line?: React.ReactNode;
  state: 'new' | 'progress' | 'done';
  /** The rail's words: "2 of 5", "Started", "Done". */
  label: React.ReactNode;
  /** 0..1, how much of the rail is filled; null draws no bar. */
  fill?: number | null;
  reward?: React.ReactNode;
}) {
  const pct = state === 'done' ? 100 : fill == null ? null : Math.max(0, Math.min(100, Math.round(fill * 100)));
  return (
    <a className={k('card', 'ccard')} href={href} onClick={onClick}>
      {art
        ? <span className={k('cart')} style={{ background: art.fill }} aria-hidden="true"><img src={art.src} alt="" loading="lazy" /></span>
        : <span className={k('cart')} aria-hidden="true">{icon}</span>}
      <span className={k('cbody')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s')}>{line}</span> : null}
        <span className={k('rail', state)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          {state !== 'done' && pct != null ? <i style={{ width: `${Math.max(pct, 6)}%` }} /> : null}
          <span>{label}</span>
        </span>
        {reward ? <span className={k('bp')}>{reward}</span> : null}
      </span>
    </a>
  );
}

/**
 * A community as a picture card (Featured on Home): its illustration, or
 * its tile large on the cover; its name, one sentence, who is there, and
 * the row's one word.
 */
export function PicCard({ href, onClick, cover, darkCover, tile, title, line, meta, word }: {
  href: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  cover?: string | null;
  darkCover?: string | null;
  tile?: React.ReactNode;
  title: React.ReactNode;
  line?: React.ReactNode;
  meta?: React.ReactNode;
  word?: React.ReactNode;
}) {
  return (
    <a className={k('card', 'fcard')} href={href} onClick={onClick}>
      <span className={k('fcover')}>
        {cover ? <img src={cover} alt="" loading="lazy" className={k('sun')} /> : tile}
        {cover && darkCover ? <img src={darkCover} alt="" loading="lazy" className={k('moon')} /> : null}
      </span>
      <span className={k('fbody')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s')}>{line}</span> : null}
        {meta || word ? <span className={k('fm')}>{meta}{word ? <span className={k('btn', 'quiet', 'sm')}>{word}</span> : null}</span> : null}
      </span>
    </a>
  );
}

/**
 * The one line for progress: Plan, Build, Checks, Vote, Live, drawn the
 * same wherever a request or a change appears. `at` is the stop reached (5:
 * live, every stop green); `state` is how the current one stands: under
 * way, or waiting on others. `mini` is the wordless strip on a row.
 */
export function Track({ at, state = 'now', mini, words }: { at: number; state?: 'now' | 'wait'; mini?: boolean; words: readonly [string, string, string, string, string] }) {
  return (
    <span className={k('track', mini && 'mini')} role="img" aria-label={words[Math.min(Math.max(at, 0), 4)]}>
      {words.map((word, i) => (
        <span key={word} className={k('st', at >= 5 ? 'live' : i < at ? 'done' : i === at ? state : '')} aria-hidden="true">{word}</span>
      ))}
    </span>
  );
}

/** The page's search field, under its tabs: one real input in the kit's field. */
export function Search({ value, onChange, placeholder, label }: { value: string; onChange: (next: string) => void; placeholder: string; label?: string }) {
  return (
    <div className={k('search')}>
      <label className={k('inp', value && 'val')}>
        <Icon name="search" size={18} />
        <input
          type="search"
          className={k('v')}
          value={value}
          placeholder={placeholder}
          aria-label={label || placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

/** Fields in a card, each a label over its box (the tour's fields()). */
export function Fields({ children }: { children?: React.ReactNode }) {
  return <div className={k('card')}><div className={k('fields')}>{children}</div></div>;
}

/**
 * One field: its label, its box, at most one line under it. `before` is
 * drawn inside the box ahead of what is typed (the people already picked).
 * The box is lit while its input has the focus (app.css), red with `bad`.
 */
export function Field({ label, icon, before, hint, tone, bad, ...input }: {
  label?: React.ReactNode;
  icon?: string;
  before?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'bad' | 'ok';
  bad?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = React.useId();
  return (
    <div className={k('field')}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className={k('inp', (input.value || before) && 'val', bad && 'err')}>
        {icon ? <Icon name={icon} size={18} /> : null}
        {before}
        <input id={id} className={k('v')} {...input} />
      </div>
      {hint ? <span className={k('hint', tone)}>{hint}</span> : null}
    </div>
  );
}

/** An on or off setting on a row: the kit's switch, as a real one. */
export function Tog({ on, onChange, label, disabled, ...props }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={k('tog', on && 'on')}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onChange(!on); }}
      {...props}
    />
  );
}

/**
 * THE sheet. Every short task is one: the same title, sentence and button
 * order as a page (frame rule 7). `kind` '' is centred (from the bottom on
 * a phone), 'right' the side sheet on a desktop, 'pop' the small one
 * anchored to the corner.
 *
 * It is a dialog: it takes the focus, Escape or a press on the dimmed page
 * closes it, and the focus goes back to where it was. Drawn in <body>, over
 * the chrome and the screens (app.css gives its host the layer); where
 * there is no document (the render tests) it renders in place.
 */
export function Sheet({ kind = '', title, purpose, onClose, closeLabel, primary, secondary, foot, children }: {
  kind?: '' | 'right' | 'pop';
  title: React.ReactNode;
  purpose?: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  foot?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      try { before?.focus?.({ preventScroll: true }); } catch { /* it has gone */ }
    };
  }, [onClose]);
  const sheet = (
    <div className="fr fr-ovhost">
      <div className={k('ov', kind)} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className={k('sheet')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
          <button type="button" className={k('ib x')} aria-label={closeLabel} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
          <div className={k('head')}>
            <div className={k('tx')}>
              <h2 className={k('title')} id={titleId}>{title}</h2>
              {purpose ? <p className={k('purpose')}>{purpose}</p> : null}
            </div>
          </div>
          {children ? <div className={k('stack')}>{children}</div> : null}
          {primary || secondary ? (
            <div className={k('btnrow')} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {primary}
              {secondary}
            </div>
          ) : null}
          {foot ? <div className={k('foot')}>{foot}</div> : null}
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}

