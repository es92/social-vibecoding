/**
 * "What do you want to make?": the first thing an account made from the
 * signed-out story is asked (../auth/story.tsx sets the session's
 * `usernode:first-session:make` flag in its sheet; ./index.tsx opens this
 * once the shell has signed them in).
 *
 * Two questions, the New project dialog's own (create-app.tsx), cut down:
 * what it should do, then what to call it — the name is the group's and
 * the project's, since a community and its one project share a name. The
 * three examples (./examples.ts) fill both fields. "Make it" creates a
 * private community through the same POST /api/apps the dialog uses
 * (../dialogs/post-create-app.ts; audience 'invited', no invitees yet:
 * inviting comes next), and Homeroom bot builds the first version from the
 * description.
 *
 * ONE FRONT DOOR. It is also what the Create button opens, for everyone and
 * every time (App.showCreateModal, `entry` 'create'), so a second project
 * starts the way the first one did and lands on the same made screen
 * (./made.tsx). `from` is the entry ('first-session' or 'create'): the
 * server sketches the idea for both, and only the first answers the join
 * screen and counts in the admin Journey (routes/apps.js). Everything the
 * two questions leave out — Just me or a public community, a template, a
 * GitHub import, who approves — is the New project dialog, which "More
 * options" opens with what has been typed so far (`onMoreOptions`).
 *
 * "Look around first" is the first session's quiet way out: Home, with
 * nothing asked. It is an answer, like Make it: until one of the two, the
 * question is still the account's to answer, and every boot of the shell
 * asks it again (a reload, the app reopened, another device; ./index.tsx,
 * services/first-session.js). Opened from Create, there is nothing to
 * answer: ✕ (or Escape) closes it, and More options takes its place.
 *
 * It ARRIVES rather than appears: the screen's ground is the wallpaper
 * from its first frame, the same one the signed-out story and the sign-in
 * sheet's leaving cover paint over the same box (../auth/sign-in-sheet.tsx),
 * and what stands on it rises into place a frame later. Transform and
 * opacity only, no delay, so a busy main thread cannot hold it back on iOS;
 * with reduced motion it is simply there.
 *
 * WITH THE KEYBOARD UP (production run, iOS app, 5 Oct 2026):
 *   - The screen was one scroller from the top of the glass, so revealing
 *     the description above the keys scrolled "Start from an example" up
 *     behind the clock. The wordmark bar now stays put and only what is
 *     under it scrolls, so nothing passes under the status bar. The bar
 *     holds the whole mark below the inset (on a notched phone the mark
 *     used to hang 12px out of its box, and the page would have scrolled
 *     past it). The kit's keyboard avoidance is attached to the scroller
 *     with the bar as its top (lib/composer-keyboard.ts), as every chat
 *     column has it: a tap on a field is focused without the browser's pan,
 *     and the field is revealed once, between the bar and the keys.
 *   - The two answers are one sequence: the description's Return says
 *     "next" and goes on to the name (Shift+Return is a new line), and the
 *     name's Return makes it. In the app the keyboard's own next chevron
 *     did not move from one to the other; Return is a way on that does not
 *     depend on it.
 *   - "Make it" only looks pale while it is making. It used to stay pale
 *     until a name was typed, beside a placeholder that read like a name
 *     already given. A press with an answer missing now puts the caret in
 *     that field and says what it needs, and the placeholder reads as an
 *     example.
 *
 * AND IN SAFARI (iPhone 17 simulator, iOS 26, 5 Oct 2026): with the keyboard
 * up, iOS panned the page to the tapped description, wordmark bar and all,
 * and "Make it" sat under the keyboard's floating bar once a press had
 * scrolled the form. The screen is a `.platform-kb-surface` now: while the
 * keyboard is open it is padded into the band of the page that is actually
 * visible (lib/keyboard-open.ts, app.css), so the bar is at the top of what
 * is seen and the scroller ends where the keys begin. Its fields are
 * lib/keyboard-surface.ts's: a tap focuses without the pan (the first tap on
 * the description, which this screen focuses from code, included), and the
 * focused field is revealed inside the scroller with "Make it" under it when
 * the two fit. Every focus here is `preventScroll`, so that reveal is the
 * only movement. In the app, whose web view ends at the keys, the band is the
 * whole screen and only the reveal does anything.
 *
 * An example is a starting point, not a choice that sticks: typing words of
 * their own into "What should it do?" lets go of the example (its chip is no
 * longer marked, and Make it no longer sends its description), and the name
 * it filled in stays theirs to keep or change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { AppAllowance } from '../dialogs/app-allowance';
import { deviceTimeZone, postCreateApp } from '../dialogs/post-create-app';
import { EXAMPLES, type Example } from './examples';

export { deviceTimeZone };

/** create-app.tsx's BRIEF_MIN: the server's floor for a description. */
export const BRIEF_MIN = 10;

/**
 * Which door it was opened through: the first session, or the Create
 * button. Sent as the create's `from`, which is the same two words.
 */
export type MakeEntry = 'first-session' | 'create';

/** What the New project dialog is opened with from More options: what has been typed so far. */
export type MakeDraft = { name: string; brief: string };

export type Made = {
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  example: Example | null;
  conversationId: number | null;
  /**
   * Who it is for (services/communities.js), when it is not this screen's
   * private community: More options can make it Just me (no one to invite)
   * or a public community.
   */
  audience?: 'solo' | 'invited' | 'open';
};

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
// Where the bar and the form start, and where they settle (see the header).
const ARRIVING = 'translate-y-6 opacity-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const ARRIVED = 'translate-y-0 opacity-100 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const HINT = 'pb-1 text-xs text-zinc-500 dark:text-zinc-400';
const NEEDED = 'pb-1 text-xs text-red-600 dark:text-red-400';

export type Missing = 'brief' | 'name' | null;

/** The first answer "Make it" still needs, in the screen's order; null when both are there. */
export function missingAnswer(brief: string, name: string): Missing {
  if (brief.trim().length < BRIEF_MIN) return 'brief';
  if (!name.trim()) return 'name';
  return null;
}

/** What a field says when "Make it" found it missing. */
export function neededLine(missing: Missing, brief: string): string | null {
  if (missing === 'brief') return brief.trim() ? 'Say a little more about what it should do.' : 'Say what it should do first.';
  if (missing === 'name') return 'Give it a name to make it. You can change it later.';
  return null;
}

/**
 * The line under the question: who builds the first version. Homeroom bot
 * for somebody it builds for (GET /api/auth/me `homeroomBotDm`, the New
 * project dialog's own test); for anybody else the description is the
 * project's first request, and saying the bot builds it would not be true.
 */
export function makeLine(botBuilds: boolean): string {
  return botBuilds
    ? 'Describe it for your group. Homeroom bot builds the first version while you invite your people.'
    : 'Describe it for your group. It becomes the project’s first request while you invite your people.';
}

/** Over the question: hello on the first session, what this is from Create. */
export function makeEyebrow(entry: MakeEntry, who: string): string {
  if (entry === 'create') return 'New project';
  return who ? `Hi ${who}!` : 'You\'re in!';
}

/** Before More options, from Create: what the two questions leave out. */
export const MORE_OPTIONS_LINE = 'Just for you, public, a template or a GitHub repo? ';

export function MakeScreen({
  who, onMade, onLookAround, entry = 'first-session', botBuilds = true, onClose, onMoreOptions,
}: {
  who: string;
  onMade: (made: Made) => void;
  /** The first session's "Look around first". */
  onLookAround?: () => void;
  entry?: MakeEntry;
  /** Whether Homeroom bot builds the first version (makeLine). */
  botBuilds?: boolean;
  /** From Create: ✕, or Escape. */
  onClose?: () => void;
  /** From Create: the New project dialog, with what has been typed. */
  onMoreOptions?: (draft: MakeDraft) => void;
}) {
  const fromCreate = entry === 'create';
  const [brief, setBrief] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Example | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The answer a press of "Make it" found missing, said under its field
  // until it changes.
  const [missing, setMissing] = useState<Missing>(null);
  // One request at a time: a second press can land before React has drawn
  // the button busy (the New project dialog's QA 2026-09-24 Q5, which made
  // two projects from one double-click), and Return in the name never goes
  // through the button at all.
  const makingRef = useRef(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The caret for a hardware keyboard; on a phone the first tap raises the
  // keys (without iOS's pan: lib/keyboard-surface.ts takes that tap).
  useEffect(() => { briefRef.current?.focus({ preventScroll: true }); }, []);
  // Taps on the fields without the pan, and the focused field (with Make it
  // when they fit) revealed inside the scroller once the keys are up.
  useKeyboardSurface(scrollerRef);
  // One frame on the wallpaper alone, so the rise has a start.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const motion = arrived ? ARRIVED : ARRIVING;
  // From Create, Escape closes it, as it closes a dialog.
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = useCallback((e: Example) => {
    setPicked(e);
    setBrief(e.brief);
    setName(e.name);
    setError(null);
    setMissing(null);
  }, []);

  const make = useCallback(async () => {
    if (busy || makingRef.current) return;
    const gap = missingAnswer(brief, name);
    if (gap) {
      setMissing(gap);
      (gap === 'brief' ? briefRef.current : nameRef.current)?.focus({ preventScroll: true });
      return;
    }
    makingRef.current = true;
    setBusy(true);
    setError(null);
    // The example's one-line description only while the brief is still the
    // example's own; a brief they rewrote is theirs to describe later.
    const example = picked && brief.trim() === picked.brief ? picked : null;
    const timeZone = deviceTimeZone();
    try {
      const reply = await postCreateApp({
        name: name.trim(),
        audience: 'invited',
        brief: brief.trim(),
        ...(example ? { description: example.description } : {}),
        from: entry,
        // So the sketch's "today" is the maker's (services/app-sketch.js).
        ...(timeZone ? { timeZone } : {}),
      });
      const data = (reply.ok ? reply.data : {}) as {
        app?: { slug?: string; name?: string }; homeroomBot?: { conversationId?: unknown };
      };
      if (!reply.ok || !data.app?.slug) {
        setError(reply.ok ? 'Could not make it. Try again.' : reply.error);
        return;
      }
      onMade({
        slug: data.app.slug,
        name: data.app.name || name.trim(),
        emoji: example ? example.emoji : null,
        description: example ? example.description : null,
        example,
        conversationId: Number(data.homeroomBot?.conversationId) || null,
      });
    } finally {
      makingRef.current = false;
      setBusy(false);
    }
  }, [busy, picked, brief, name, entry, onMade]);
  const needed = neededLine(missing, brief);

  return (
    <div
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      data-make-entry={entry}
      className="platform-kb-surface fixed inset-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      {/* Stays put over the scroller, so nothing scrolls under the status bar.
          At least 32px tall under the status bar's inset, so the whole mark
          is inside it and what scrolls stops below the mark, not beside it.
          From Create, ✕ at its leading edge closes the screen. */}
      <div className={`relative flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)] ${motion}`}>
        {onClose ? (
          <button
            type="button"
            data-make-close=""
            onClick={onClose}
            aria-label="Close"
            className="absolute bottom-1 left-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-500 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-400"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      {/* The scroller the keyboard surface reveals fields in. Its className
          stays constant: nothing here varies it. */}
      <div ref={scrollerRef} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">
        <form
          className={`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] ${motion}`}
          onSubmit={(e) => { e.preventDefault(); void make(); }}
        >
          <div className="text-center">
            <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
              {makeEyebrow(entry, who)}
            </p>
            <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">What do you want to make?</h1>
            <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">
              {makeLine(botBuilds)}
            </p>
          </div>
          <p className="mt-6 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">Start from an example</p>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Examples">
            {EXAMPLES.map((e) => {
              const on = picked?.key === e.key;
              return (
                <button
                  key={e.key}
                  type="button"
                  aria-pressed={on}
                  data-first-session-example={e.key}
                  onClick={() => pick(e)}
                  className={`relative flex flex-col items-center gap-1.5 rounded-2xl bg-white px-1 pb-2.5 pt-3 text-center dark:bg-zinc-900 ${on ? 'shadow-[inset_0_0_0_2px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]'}`}
                >
                  <span className="app-icon-tile flex h-11 w-11 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{e.emoji}</span>
                  <span className="text-[13px] font-semibold leading-tight">{e.short}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <div className={FIELD}>
              <label htmlFor="first-session-brief" className={LABEL}>What should it do?</label>
              <textarea
                ref={briefRef}
                id="first-session-brief"
                rows={3}
                value={brief}
                enterKeyHint="next"
                aria-describedby={missing === 'brief' ? 'first-session-brief-needed' : undefined}
                onChange={(e) => {
                  const next = e.target.value;
                  setBrief(next);
                  // Their own words let go of the example.
                  if (picked && next !== picked.brief) setPicked(null);
                  setError(null);
                  setMissing(null);
                }}
                onKeyDown={(e) => {
                  // Return goes on to the name, as the key says; Shift+Return is a new line.
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  nameRef.current?.focus({ preventScroll: true });
                }}
                placeholder="A tracker for our weekly miles…"
                className={`${INPUT} resize-none leading-[22px]`}
              />
              {missing === 'brief' ? <p id="first-session-brief-needed" role="alert" className={NEEDED}>{needed}</p> : null}
            </div>
            <div className={FIELD}>
              <label htmlFor="first-session-name" className={LABEL}>What should we call it?</label>
              <input
                ref={nameRef}
                id="first-session-name"
                type="text"
                autoComplete="off"
                enterKeyHint="go"
                value={name}
                aria-describedby="first-session-name-hint"
                onChange={(e) => { setName(e.target.value); setError(null); setMissing(null); }}
                placeholder="For example, Sunday Run Club"
                className={INPUT}
              />
              {missing === 'name'
                ? <p id="first-session-name-hint" role="alert" className={NEEDED}>{needed}</p>
                : <p id="first-session-name-hint" className={HINT}>It's your group's name too. You can change it later.</p>}
            </div>
          </div>
          {/* From Create, the allowance when it bears on Make it (the New
              project dialog's quiet row, #23): a returning maker can be at
              their limit, a new account never is. The wrapper goes with it
              when there is nothing to say. */}
          {fromCreate ? <div className="mt-4 empty:hidden"><AppAllowance id="make-app-quota" surface="pane" quiet /></div> : null}
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
          <div className="grow" />
          <Button
            type="submit"
            disabled={busy}
            layout="full"
            variant="pillAccent"
            size="pillLg"
            ink="solidLate"
            className="mt-6 flex items-center justify-center disabled:opacity-50"
          >
            {busy ? 'Making it…' : 'Make it'}
          </Button>
          {fromCreate ? (
            <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              {MORE_OPTIONS_LINE}
              <button
                type="button"
                data-make-more-options=""
                onClick={() => onMoreOptions?.({ name: name.trim(), brief: brief.trim() })}
                className="font-medium text-violet-700 hover:underline dark:text-violet-400"
              >
                More options
              </button>
            </p>
          ) : (
            <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              {'Not sure yet? '}
              <button type="button" onClick={onLookAround} className="font-medium text-violet-700 hover:underline dark:text-violet-400">Look around first</button>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
