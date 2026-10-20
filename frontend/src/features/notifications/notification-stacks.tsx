/**
 * #5580: the Unread tab's project stacks, the way the lock screen stacks an
 * app's notifications.
 *
 * ── A project is a stack ──────────────────────────────────────────────
 *
 * Each project's unread notifications are one stack under its name. While
 * it is closed only its newest card shows, with "N more notifications" on
 * it and the edges of the next two peeking out below; tapping it opens the
 * stack, the cards slide out from behind the top one, and "Show less" in the
 * heading folds them back. A project with one card has nothing to stack.
 *
 * The cards under the top one are the real cards, kept where they are in the
 * document: a closed stack positions them under the top card (app.css,
 * `.notifications-stack`), `inert` and hidden from assistive technology, so
 * opening it moves the same nodes rather than drawing new ones. That is what
 * lets the open play as one motion (FLIP: measure, let React lay the stack
 * out, then run each card from where it was), and what keeps a card's kit
 * swipe attached across it.
 *
 * ── A request or a proposal is a story ────────────────────────────────
 *
 * Inside a project, everything about one request (and the proposals made
 * from it) or one proposal is one card: the bot saying it is ready to try,
 * someone's comment on it, and it going live read as one thing that
 * happened, not four. The card is drawn as its newest notification, says
 * "#5580 · 3 notifications", opens the newest and reads them all (the
 * controller's openGroupRow), and clears them all. The story is the row's
 * `storyKey` (rowView in ./notifications.js, from the server's story
 * columns). Rows that are about no request or proposal still fold by kind
 * (foldRepeats).
 *
 * ── Every story has its history ───────────────────────────────────────
 *
 * A card about a request or a proposal opens, from the chevron at its foot
 * (or a press and hold on a phone), to what happened there: the platform's
 * own lines from its discussions (votes, an update, going live, a plan) and
 * what people said, newest first (GET /api/notifications/:id/history), with
 * the story's other notifications in their place, each with its dot and
 * each opening on its own.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { agoStamp } from '../../lib/timestamp';

/** The row descriptor fields this file reads (ScreenRowView in ./notifications-sheet.tsx). */
export type StoryRowView = {
  id: number;
  unread: boolean;
  label: string;
  segments: { t: string; v: string }[];
  kind?: string;
  conversation?: boolean;
  bot?: boolean;
  actions?: unknown[];
  by?: string | null;
  who?: string;
  createdAtMs: number;
  groupIds?: number[];
  count?: number;
  groupLabelled?: boolean;
  storyKey?: string | null;
  storyRef?: { number: number; title: string | null } | null;
  /** Set on a card that stands for one story's notifications, newest first. */
  story?: { members: StoryRowView[] } | null;
};

export type StoryEntry<V extends StoryRowView = StoryRowView> = { type: 'notif'; key: string; at: number; view: V };

/** Where a card sits in its stack, for ScreenRow's card form. */
export type CardPlace = {
  /** The project's own name: the heading the card sits under. */
  groupName: string;
  /** The top card of a stack of several: how many sit under it, and the way in. */
  top?: { more: number; closed: boolean; open: () => void } | null;
  /** Under the top card of a closed stack: 1 and 2 peek out, 3 stands for the rest. */
  behind?: number;
};

/** How many notifications one entry stands for. */
export function notificationsIn(view: StoryRowView): number {
  if (view.groupIds && view.groupIds.length > 1) return view.groupIds.length;
  return view.count && view.count > 1 ? view.count : 1;
}

/**
 * One project's entries, with each story's notifications folded into one
 * card where its newest stood. A person speaking stays out of a story (each
 * message is its own thing to answer, as foldRepeats has it), except the
 * Homeroom bot, whose news about a request is exactly what a story is made
 * of. A row with buttons of its own stays out too. A story of one is not a
 * story card: it stays the row it was and may still fold by kind.
 */
export function foldStories<V extends StoryRowView>(entries: StoryEntry<V>[]): StoryEntry<V>[] {
  const members = new Map<string, V[]>();
  const keyOf = (view: V): string | null => {
    if (!view.storyKey) return null;
    if (view.actions && view.actions.length) return null;
    if (view.conversation && !view.bot) return null;
    return view.storyKey;
  };
  for (const entry of entries) {
    const key = keyOf(entry.view);
    if (!key) continue;
    const list = members.get(key);
    if (list) list.push(entry.view);
    else members.set(key, [entry.view]);
  }
  const out: StoryEntry<V>[] = [];
  for (const entry of entries) {
    const key = keyOf(entry.view);
    const list = key ? members.get(key) : undefined;
    if (!key || !list || list.length < 2) { out.push(entry); continue; }
    if (list[0] !== entry.view) continue;
    const ids = list.flatMap((view) => view.groupIds && view.groupIds.length ? view.groupIds : [view.id]);
    out.push({
      ...entry,
      view: {
        ...entry.view,
        // The story says the count in its meta line, so no pill says it again.
        groupIds: ids,
        count: ids.length,
        groupLabelled: true,
        storyRef: entry.view.storyRef || list.map((view) => view.storyRef).find(Boolean) || null,
        story: { members: list },
      },
    });
  }
  return out;
}

const EASE = 'cubic-bezier(.32,.72,0,1)';

function stillMotion(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Snapshot = Map<Element, DOMRect>;

function slotsOf(stack: HTMLElement): HTMLElement[] {
  return Array.from(stack.children).filter((el): el is HTMLElement => el.classList.contains('notifications-row-slot'));
}

/** This stack's cards, and everything after it in the list, before a change. */
function snapshot(stack: HTMLElement): Snapshot {
  const rects: Snapshot = new Map();
  for (const el of slotsOf(stack)) rects.set(el, el.getBoundingClientRect());
  let next = stack.nextElementSibling;
  while (next) {
    rects.set(next, next.getBoundingClientRect());
    next = next.nextElementSibling;
  }
  return rects;
}

/**
 * Play a stack's change from `from`. The top card only glides (it is the
 * same card either way); each card under it runs from where it was, its
 * bottom edge and width to its bottom edge and width, so opening slides it
 * out from the edge it peeked as and closing tucks it back in. What follows
 * the stack slides by however far it moved. The colours and the fade are
 * CSS transitions on the same attribute change (app.css).
 */
function play(stack: HTMLElement, from: Snapshot, opening: boolean): void {
  const dur = opening ? 520 : 420;
  slotsOf(stack).forEach((el, i) => {
    const prev = from.get(el);
    if (!prev) return;
    const now = el.getBoundingClientRect();
    if (!now.width || !now.height) return;
    const step = Math.min(i, 9);
    const keyframes = i === 0
      ? [{ transform: `translateY(${prev.top - now.top}px)` }, { transform: 'none' }]
      : [
        { transform: `translateY(${prev.bottom - now.bottom}px) scale(${prev.width / now.width}, ${prev.height / now.height})` },
        { transform: 'none' },
      ];
    el.style.zIndex = String(i === 0 ? 60 : 50 - step);
    el.style.transformOrigin = '50% 100%';
    const run = el.animate(keyframes, {
      duration: dur + step * 12,
      delay: opening && i > 0 ? step * 14 : 0,
      easing: EASE,
      fill: 'backwards',
    });
    const done = () => { el.style.zIndex = ''; el.style.transformOrigin = ''; };
    run.finished.then(done, done);
  });
  let next = stack.nextElementSibling;
  while (next) {
    const prev = from.get(next);
    const now = next.getBoundingClientRect();
    if (prev && Math.abs(prev.top - now.top) > 0.5) {
      (next as HTMLElement).animate(
        [{ transform: `translateY(${prev.top - now.top}px)` }, { transform: 'none' }],
        { duration: dur, easing: EASE },
      );
    }
    next = next.nextElementSibling;
  }
}

/**
 * One project's stack. `head` draws its heading, given the way to fold an
 * open stack back (null while there is nothing to fold); `renderCard` draws
 * one card in its place. Closed is where every stack starts, and where it
 * goes back to when the sheet closes.
 */
export function ProjectStack<V extends StoryRowView>({ groupKey, name, entries, sheetOpen, head, renderCard }: {
  groupKey: string;
  name: string;
  entries: StoryEntry<V>[];
  sheetOpen: boolean;
  head: (showLess: (() => void) | null) => ReactNode;
  renderCard: (entry: StoryEntry<V>, place: CardPlace) => ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const flipFrom = useRef<Snapshot | null>(null);
  const many = entries.length > 1;
  const closed = many && !open;

  useEffect(() => {
    if (!sheetOpen) setOpen(false);
  }, [sheetOpen]);

  const toggle = (next: boolean) => {
    const stack = stackRef.current;
    flipFrom.current = stack && !stillMotion() ? snapshot(stack) : null;
    setOpen(next);
  };

  // The cards under a closed stack's top card take its place and its height
  // (its words decide it), so only their edges show below it.
  useIsomorphicLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || !closed) return undefined;
    const fit = () => {
      const top = slotsOf(stack)[0];
      if (!top) return;
      stack.style.setProperty('--stack-top', `${top.offsetTop}px`);
      stack.style.setProperty('--stack-h', `${top.offsetHeight}px`);
    };
    fit();
    if (typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(fit);
    const top = slotsOf(stack)[0];
    if (top) watch.observe(top);
    return () => watch.disconnect();
  }, [closed, entries.map((entry) => entry.key).join(',')]);

  useIsomorphicLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    const stack = stackRef.current;
    if (from && stack) play(stack, from, open);
  }, [open]);

  let more = 0;
  entries.forEach((entry, i) => { if (i > 0) more += notificationsIn(entry.view); });

  return (
    <div
      ref={stackRef}
      className="notifications-stack"
      data-notif-stack={groupKey}
      data-stack-closed={closed ? '' : undefined}
      data-stack-depth={closed ? Math.min(entries.length - 1, 2) : undefined}
    >
      {head(many && open ? () => toggle(false) : null)}
      {entries.map((entry, i) => renderCard(entry, {
        groupName: name,
        top: many && i === 0 ? { more, closed, open: () => toggle(true) } : null,
        behind: closed && i > 0 ? Math.min(i, 3) : 0,
      }))}
    </div>
  );
}

// ── The history ────────────────────────────────────────────────────────

/** One thing that happened, as GET /api/notifications/:id/history gives it. */
export type HistoryStep = {
  at: string;
  kind: string;
  actor?: string | null;
  vote?: 'yes' | 'no';
  words?: string;
};

type Translate = (id: string, values?: Record<string, unknown>) => string;

/** What the history draws: a step's words, or one of the story's notifications. */
type HistoryLine = {
  key: string;
  at: number;
  what: string;
  words?: string;
  /** One of the story's own notifications: it opens on its own, with its dot. */
  notification?: { id: number; unread: boolean };
};

const BOT_USERNAME = 'homeroom_bot';

function plain(segments: StoryRowView['segments']): string {
  return segments.map((segment) => segment.v).join(' ').trim();
}

/**
 * A step in words. `who` is "@name", or the bot's own name; the viewer's
 * own steps have sentences of their own ("You voted yes"), because the verb
 * agrees with them in most languages.
 */
function stepWhat(step: HistoryStep, t: Translate, viewer: string | null): string | null {
  const actor = step.actor || null;
  const you = !!actor && !!viewer && actor.toLowerCase() === viewer.toLowerCase();
  const who = actor && actor.toLowerCase() === BOT_USERNAME ? t('notifications:row.bot.name') : actor ? `@${actor}` : '';
  const said = (id: string, youId: string, unnamedId?: string): string | null => {
    if (you) return t(youId);
    if (who) return t(id, { who });
    return unnamedId ? t(unnamedId) : null;
  };
  switch (step.kind) {
    case 'live': return t('notifications:history.step.live');
    case 'updated': return t('notifications:history.step.updated');
    case 'closed': return t('notifications:history.step.closed');
    case 'withdrawn': return t('notifications:history.step.withdrawn');
    case 'vote':
      return step.vote === 'no'
        ? said('notifications:history.step.voteNo', 'notifications:history.step.voteNoYou')
        : said('notifications:history.step.voteYes', 'notifications:history.step.voteYesYou');
    case 'vote_taken_back':
      return said('notifications:history.step.voteTakenBack', 'notifications:history.step.voteTakenBackYou',
        'notifications:history.step.voteTakenBackUnnamed');
    case 'proposed': return said('notifications:history.step.proposed', 'notifications:history.step.proposedYou');
    case 'plan':
      return said('notifications:history.step.plan', 'notifications:history.step.planYou', 'notifications:history.step.planUnnamed');
    case 'asked': return said('notifications:history.step.asked', 'notifications:history.step.askedYou');
    case 'close_proposed':
      return said('notifications:history.step.closeProposed', 'notifications:history.step.closeProposedYou');
    case 'comment': return said('notifications:history.step.comment', 'notifications:history.step.commentYou');
    case 'note': return step.words || null;
    default: return null;
  }
}

/**
 * A step the story's own notification already says: the same moment, and
 * the same thing. Going live is what a "Live" or "merged" notification
 * says; anything else someone did is said by a notification from them.
 */
function sameMoment(step: HistoryStep, at: number, view: StoryRowView): boolean {
  if (Math.abs(at - view.createdAtMs) > 120000) return false;
  if (step.kind === 'live') return /live|merged/.test(String(view.kind || ''));
  if (!step.actor) return false;
  const hand = String(view.by || view.who || '').replace(/^@/, '').toLowerCase();
  return hand === step.actor.toLowerCase();
}

/**
 * The lines a history draws, newest first: the steps in words, the story's
 * other notifications in their place (the card itself is the newest one, so
 * it is left out, and a step it already says is too), and other people's
 * votes one after another, one way, as one line that names them in the
 * order they voted.
 */
export function historyLines(view: StoryRowView, steps: HistoryStep[], t: Translate, viewer: string | null): HistoryLine[] {
  const members = view.story ? view.story.members : [view];
  const lines: (HistoryLine & { voters?: string[]; vote?: string })[] = [];
  let n = 0;
  const ordered: { at: number; step?: HistoryStep; member?: StoryRowView }[] = [];
  for (const step of steps) {
    const at = Date.parse(step.at) || 0;
    if (members.some((member) => sameMoment(step, at, member))) continue;
    ordered.push({ at, step });
  }
  for (const member of members.slice(1)) ordered.push({ at: member.createdAtMs, member });
  ordered.sort((a, b) => b.at - a.at);
  for (const { at, step, member } of ordered) {
    if (member) {
      lines.push({
        key: `n:${member.id}`,
        at,
        what: member.label,
        words: plain(member.segments) || undefined,
        notification: { id: member.id, unread: member.unread },
      });
      continue;
    }
    if (!step) continue;
    const actor = step.actor || '';
    const mine = !!viewer && actor.toLowerCase() === viewer.toLowerCase();
    const last = lines[lines.length - 1];
    if (step.kind === 'vote' && actor && !mine && last && last.voters && last.vote === step.vote) {
      last.voters.push(actor);
      continue;
    }
    const what = stepWhat(step, t, viewer);
    if (!what) continue;
    const line: HistoryLine & { voters?: string[]; vote?: string } = {
      key: `s:${n++}`,
      at,
      what,
      words: step.kind === 'note' ? undefined : step.words,
    };
    if (step.kind === 'vote' && actor && !mine) { line.voters = [actor]; line.vote = step.vote; }
    lines.push(line);
  }
  return lines.map(({ voters, vote, ...line }) => {
    if (!voters || voters.length < 2) return line;
    const count = voters.length;
    return {
      ...line,
      what: t(vote === 'no' ? 'notifications:history.step.votesNo' : 'notifications:history.step.votesYes', { count }),
      // Newest first in the list, so the earliest voter is the last one in.
      words: listText(voters.slice().reverse().map((name) => `@${name}`)),
    };
  });
}

type Loaded = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; steps: HistoryStep[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

/**
 * A card's history, under its words. Read the first time it opens and kept
 * while the card is; it grows open from nothing and folds back the same way,
 * and what follows the card moves with it.
 */
export function CardHistory({ view, open }: { view: StoryRowView; open: boolean }): ReactNode {
  const t = useMessages('notifications');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [shown, setShown] = useState(open);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Asked once per card; a failed read is asked again the next time it opens.
  const asked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    setLoaded({ state: 'loading' });
    Promise.resolve(controller()?.loadHistory(view.id))
      .catch(() => null)
      .then((data: { steps?: HistoryStep[] } | null) => {
        if (!mounted.current) return;
        const ok = !!data && Array.isArray(data.steps);
        if (!ok) asked.current = false;
        setLoaded(ok ? { state: 'ready', steps: data!.steps! } : { state: 'failed' });
      });
  }, [open, view.id]);

  // Opening shows it at once and grows it; closing folds it, then lets it go.
  useIsomorphicLayoutEffect(() => {
    const box = boxRef.current;
    if (open) {
      setShown(true);
      if (!box || stillMotion()) return;
      const h = box.scrollHeight;
      box.style.overflow = 'hidden';
      const run = box.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 360, easing: EASE });
      const done = () => { box.style.overflow = ''; };
      run.finished.then(done, done);
      return;
    }
    if (!box || stillMotion()) { setShown(false); return; }
    box.style.overflow = 'hidden';
    const run = box.animate([{ height: `${box.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: 300, easing: EASE, fill: 'forwards' });
    const done = () => setShown(false);
    run.finished.then(done, done);
  }, [open]);

  // The history lands after it opened on "Loading…": grow to it, not jump.
  const lastHeight = useRef(0);
  useIsomorphicLayoutEffect(() => {
    const box = boxRef.current;
    const was = lastHeight.current;
    lastHeight.current = box ? box.offsetHeight : 0;
    if (!box || !open || !was || stillMotion() || Math.abs(box.offsetHeight - was) < 1) return;
    box.style.overflow = 'hidden';
    const run = box.animate([{ height: `${was}px` }, { height: `${box.offsetHeight}px` }], { duration: 280, easing: EASE });
    const done = () => { box.style.overflow = ''; };
    run.finished.then(done, done);
  }, [loaded]);

  if (!open && !shown) return null;
  const viewer = controller()?.viewerUsername?.() || null;
  const lines = loaded && loaded.state === 'ready' ? historyLines(view, loaded.steps, t, viewer) : [];
  // What a card that is not a story is on: a comment's card says the words,
  // so the history starts with the request or proposal they were posted on
  // (its title only when the card's own subject is not already it).
  const on = !view.story && view.storyRef ? view.storyRef : null;
  const onTitle = on && on.title && on.title !== plain(view.segments) ? on.title : null;
  return (
    <div
      ref={boxRef}
      data-notif-history-list={view.id}
      className="col-start-1 row-start-2 pl-[4.75rem] pr-4 pb-2"
    >
      {on ? (
        <div className="py-1.5 border-t border-black/[.06] dark:border-white/[.08]">
          <span className="block text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {t('notifications:history.on', { number: on.number })}
          </span>
          {onTitle ? (
            <span className="block text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 break-words">{onTitle}</span>
          ) : null}
        </div>
      ) : null}
      {!loaded || loaded.state === 'loading' ? (
        <p className="py-1.5 border-t border-black/[.06] dark:border-white/[.08] text-xs text-zinc-500 dark:text-zinc-400">
          {t('notifications:history.loading')}
        </p>
      ) : loaded.state === 'failed' ? (
        <p className="py-1.5 border-t border-black/[.06] dark:border-white/[.08] text-xs text-zinc-500 dark:text-zinc-400">
          {t('notifications:history.failed')}
        </p>
      ) : !lines.length ? (
        <p className="py-1.5 border-t border-black/[.06] dark:border-white/[.08] text-xs text-zinc-500 dark:text-zinc-400">
          {t('notifications:history.empty')}
        </p>
      ) : lines.map((line) => {
        const stamp = line.at ? agoStamp(line.at) : null;
        const inner = (
          <>
            {line.notification && line.notification.unread ? (
              <span
                className="absolute -left-3 top-3 w-1.5 h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100"
                aria-label={t('notifications:row.unreadDot')}
              >
              </span>
            ) : null}
            <span className="flex items-baseline gap-2">
              <span className="flex-1 min-w-0 truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">{line.what}</span>
              {stamp && stamp.text ? (
                <time className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400" title={stamp.title}>{stamp.text}</time>
              ) : null}
            </span>
            {line.words ? (
              <span className="block text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 break-words">{line.words}</span>
            ) : null}
          </>
        );
        const cls = 'relative block w-full text-left py-1.5 border-t border-black/[.06] dark:border-white/[.08]';
        return line.notification ? (
          <button
            key={line.key}
            type="button"
            data-notif-history-row={line.notification.id}
            className={cls + ' hover:text-violet-700 dark:hover:text-violet-400'}
            onClick={(event) => {
              // Stopped like every click in this sheet: the list re-renders
              // under it, and an outside-click listener would close the sheet.
              event.stopPropagation();
              controller()?._onItemClick(line.notification!.id);
            }}
          >
            {inner}
          </button>
        ) : (
          <div key={line.key} className={cls}>{inner}</div>
        );
      })}
    </div>
  );
}
