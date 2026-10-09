/**
 * "What do you want to make?": the first thing an account made from the
 * signed-out story is asked (../auth/story.tsx sets the session's
 * `usernode:first-session:make` flag in its sheet; ./index.tsx opens this
 * once the shell has signed them in).
 *
 * Two questions, the New project dialog's own (create-app.tsx), cut down:
 * what it should do, then what to call it — the name is the group's and
 * the project's, since a community and its one project share a name. The
 * starting points (./examples.ts) fill both in. "Make it" creates a
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
 * screen and counts in the admin Journey (routes/apps.js). It is the only
 * door: the New project dialog it once had behind "More options" is gone,
 * and with it choosing Just me, a public community or who approves at
 * creation. Those are a project's own levers afterwards (Invite, "Make it
 * public", Members & approvals).
 *
 * From Create, a small "Import from a GitHub repo" under Make it swaps the
 * two questions for ./import-repo.tsx's (`mode` 'import'; #create/import
 * opens it so, `startImport`): the repo and Check, then the name. It is
 * the same private community through the same POST /api/apps, and it lands
 * on the same made screen, Share invite and all (`imported`).
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
 * STARTING POINTS (Evan, 8 Oct 2026): four tiles, two by two. A tier list,
 * a game and an organizer are sentences with a blank (./examples.ts); the
 * fourth, Your own idea, is the plain description box, which is also what
 * the screen opens on. A tap on the tier list or the organizer picks its
 * first choice, so one tap is a whole description; the chips under the
 * sentence change the blank, and Your own… puts a field for their words in
 * it. The game is always finished in their own words, in a box under the
 * sentence: the fun of a game is in what you build, so it starts on Your
 * own and each starter ("a board game where") still waits for the rest.
 * The name follows the choice ("Hiking Tier List") until they type one.
 *
 * A template is a starting point, not a choice that sticks: "Write it
 * yourself" turns the sentence into the plain box, and words of their own
 * there let go of the template (Your own idea is marked instead, and Make
 * it no longer sends the template's description). The name stays theirs to
 * keep or change.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { PencilSquareIcon, XIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { mayFocusByCodeNow } from '../auth/sign-in-sheet';
import { AppAllowance, useAppAllowance } from '../dialogs/app-allowance';
import { deviceTimeZone, postCreateApp } from '../dialogs/post-create-app';
import { descriptionOf, firstChoice, OWN, readyMadeOf, sentence, starterOf, suggestedName, TEMPLATES, type Template } from './examples';
import { ImportForm, type RepoManifest } from './import-repo';
import { TierChart } from './tier-chart';

export { deviceTimeZone };

/**
 * Under the sentence when its choice is one of the ready-made apps
 * (examples.ts `readyMadeOf`): Make it makes that app, with nothing to build.
 */
export const READY_LINE = 'Ready-made: nothing to build, so it is ready as soon as it is set up.';

/**
 * Under the sentence when its choice is a game preset with a starter
 * (examples.ts `starterOf`): the project starts as that working game, and
 * Homeroom bot builds their idea on it.
 */
export function starterLine(starts: string): string {
  return `Starts from a game that already works, ${starts}, and Homeroom bot builds your idea on it.`;
}

/** The server's floor and ceiling for a description (services/homeroom-bot-dm.js MIN_/MAX_BRIEF_CHARS). */
export const BRIEF_MIN = 10;
export const BRIEF_MAX = 4000;

/**
 * Which door it was opened through: the first session, or the Create
 * button. Sent as the create's `from`, which is the same two words.
 */
export type MakeEntry = 'first-session' | 'create';

export type Made = {
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  /** The template it was made from, while its sentence was still the template's. */
  example: Template | null;
  conversationId: number | null;
  /** Imported from a GitHub repo (./import-repo.tsx): nothing is built from a description. */
  imported?: boolean;
  /** One of Homeroom's ready-made apps (examples.ts `readyMadeOf`): nothing is built, it is ready once it runs. */
  readyMade?: boolean;
};

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
// Where the bar and the form start, and where they settle (see the header).
const ARRIVING = 'translate-y-6 opacity-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const ARRIVED = 'translate-y-0 opacity-100 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const HINT = 'pb-1 text-xs text-zinc-500 dark:text-zinc-400';
const NEEDED = 'pb-1 text-xs text-red-700 dark:text-red-400';
// What stands in a template's blank, and the field for their own words there.
const BLANK = 'rounded-md bg-violet-50 px-1 py-px font-semibold text-violet-700 [box-decoration-break:clone] dark:bg-violet-950 dark:text-violet-300';
const BLANK_FIELD = 'mx-0.5 inline-block w-[9.5em] max-w-full rounded-md border-0 bg-violet-50 px-1.5 align-baseline text-[17px] font-semibold leading-[26px] text-violet-700 placeholder-zinc-500 shadow-[inset_0_-2px_0_var(--accent)] focus:outline-none dark:bg-violet-950 dark:text-violet-300';
// The game's box for the rest of the sentence: a field, plainly, ringed in
// the accent while it is empty so it is the next thing to do.
const WORDS_BOX = 'mt-1.5 block w-full resize-none rounded-xl border-0 bg-white px-3 py-2.5 text-[17px] leading-[22px] text-zinc-900 placeholder-zinc-500 focus:shadow-[inset_0_0_0_2px_var(--accent),0_0_0_4px_rgba(10,110,224,0.15)] focus:outline-none dark:bg-zinc-900 dark:text-zinc-100';
const WORDS_EMPTY = 'shadow-[inset_0_0_0_2px_var(--accent),0_0_0_4px_rgba(10,110,224,0.15)]';
const WORDS_FILLED = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
const TILE = 'relative flex items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5 text-left dark:bg-zinc-900';
const TILE_ON = 'shadow-[inset_0_0_0_2px_var(--accent)]';
const TILE_OFF = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/** The tile that is the plain description box. */
export const OWN_IDEA = 'idea';

export type Missing = 'blank' | 'brief' | 'name' | null;

/** The first answer "Make it" still needs, in the screen's order; null when both are there. */
export function missingAnswer(brief: string, name: string): Missing {
  if (brief.trim().length < BRIEF_MIN) return 'brief';
  if (!name.trim()) return 'name';
  return null;
}

/**
 * What a field says when "Make it" found it missing. `blank` is a
 * template's: their own words in its blank, or, for the game, the rest of
 * its sentence (`finishing`).
 */
export function neededLine(missing: Missing, brief: string, finishing = false): string | null {
  if (missing === 'blank') return finishing ? 'Finish the sentence first.' : 'Fill in the blank first.';
  if (missing === 'brief') return brief.trim() ? 'Say a little more about what it should do.' : 'Say what it should do first.';
  if (missing === 'name') return 'Give it a name to make it. You can change it later.';
  return null;
}

/** Over the question: hello on the first session, what this is from Create. */
export function makeEyebrow(entry: MakeEntry, who: string): string {
  if (entry === 'create') return 'New project';
  return who ? `Hi ${who}!` : 'You\'re in!';
}

/**
 * Under the description box, quietly, while it still holds the answer the
 * person gave on the waitlist (#4040): it opens on Your own idea with that
 * answer in the box. Gone once they change a word of it.
 */
export const WAITLIST_IDEA_LINE = 'Filled in from your waitlist answer.';

/** The import form's heading and line (./import-repo.tsx). */
export const IMPORT_TITLE = 'Import a GitHub repo';
export const IMPORT_LINE = 'Bring an app that already exists. Your group builds on it from here.';

/**
 * The screen's root. On the first session it is the whole screen: it
 * arrives on the wallpaper after sign-in, over everything. From Create
 * (#4195) it is a screen like the others, below the platform header
 * (`.platform-under-header`, app.css), so the header's back, bell and menus
 * stay where they are; using one leaves this screen (./index.tsx). The tab
 * bar stays covered either way: this is one thing to do, not a tab.
 */
export const MAKE_ROOT = 'platform-kb-surface fixed inset-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100';
export const MAKE_ROOT_UNDER_HEADER = 'platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100';

export function MakeScreen({
  who, onMade, onLookAround, entry = 'first-session', onClose, startImport = false, underHeader = false, idea = null,
}: {
  who: string;
  onMade: (made: Made) => void;
  /** The first session's "Look around first". */
  onLookAround?: () => void;
  entry?: MakeEntry;
  /** From Create: ✕, or Escape. */
  onClose?: () => void;
  /** From Create: open on the import form (#create/import). */
  startImport?: boolean;
  /** From Create, with the platform header showing: below it, not over it (MAKE_ROOT). */
  underHeader?: boolean;
  /**
   * The first session's: what the person answered on the waitlist, known at
   * mount (the signed-in user's, or a screenshot state's). When there is
   * one, the screen opens on Your own idea with it in the box.
   */
  idea?: string | null;
}) {
  const waitlistIdea = typeof idea === 'string' && idea.trim() ? idea : null;
  const fromCreate = entry === 'create';
  // At the allowance's limit (or a full server), Make it and Import it are
  // pale and the row above says why (the retired dialog's rule: never offer
  // a submit the server will refuse). Never pale for a missing answer.
  const { blocked: quotaBlocks } = useAppAllowance();
  // Make it, or (from Create only) Import it.
  const [mode, setMode] = useState<'make' | 'import'>(fromCreate && startImport ? 'import' : 'make');
  const [brief, setBrief] = useState(waitlistIdea ?? '');
  const [name, setName] = useState('');
  // The tile picked: a template, Your own idea, or nothing yet.
  const [picked, setPicked] = useState<Template | typeof OWN_IDEA | null>(waitlistIdea ? OWN_IDEA : null);
  // The template's choice, and their own words: in its blank, or the rest
  // of the game's sentence.
  const [choice, setChoice] = useState('');
  const [words, setWords] = useState('');
  // "Write it yourself": the sentence it put in the plain box. The template
  // stays picked until they change those words.
  const [written, setWritten] = useState<string | null>(null);
  // A name they typed: from then on a choice no longer suggests one.
  const [nameTyped, setNameTyped] = useState(false);
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
  // Their own words in a template: the field in its blank, or the game's box.
  const wordsFieldRef = useRef<HTMLInputElement>(null);
  const wordsBoxRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The caret for a hardware keyboard; on a phone the first tap raises the
  // keys (without iOS's pan: lib/keyboard-surface.ts takes that tap). A
  // touch screen gets no caret from code (#4597, the sign-in sheet's own
  // `mayFocusByCode`): in the Homeroom app's web view a field focused from
  // code raises the keyboard, and this screen opens whole, under no keys.
  useEffect(() => { if (mayFocusByCodeNow()) briefRef.current?.focus({ preventScroll: true }); }, []);
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

  const template = picked && picked !== OWN_IDEA ? picked : null;
  // The sentence is drawn until it is written out as plain text.
  const templated = !!template && written === null;
  const said = template ? sentence(template, choice, words) : null;
  // What Make it sends as the description: the sentence, or the plain box.
  const text = templated && said ? said.text : brief;
  // After the tap that drew it, the field for their words (or the plain box).
  const focusSoon = (field: () => HTMLElement | null) => {
    setTimeout(() => field()?.focus({ preventScroll: true }), 0);
  };
  const wordsField = () => wordsBoxRef.current || wordsFieldRef.current;

  const pickTemplate = useCallback((t: Template) => {
    if (picked === t && written === null) return;
    const first = firstChoice(t);
    setPicked(t);
    setChoice(first);
    setWords('');
    setWritten(null);
    if (!nameTyped) setName(suggestedName(t, first, ''));
    setError(null);
    setMissing(null);
    if (first === OWN) focusSoon(wordsField);
  }, [picked, written, nameTyped]);

  const pickIdea = useCallback(() => {
    if (picked === OWN_IDEA) return;
    setPicked(OWN_IDEA);
    setWritten(null);
    if (!nameTyped) setName('');
    setError(null);
    setMissing(null);
    focusSoon(() => briefRef.current);
  }, [picked, nameTyped]);

  const pickChoice = useCallback((key: string) => {
    if (!template) return;
    setChoice(key);
    if (!nameTyped) setName(suggestedName(template, key, words));
    setError(null);
    setMissing(null);
    if (key === OWN || template.finish) focusSoon(wordsField);
  }, [template, nameTyped, words]);

  const changeWords = (next: string) => {
    setWords(next);
    if (template && !nameTyped) setName(suggestedName(template, choice, next));
    setError(null);
    setMissing(null);
  };

  const writeOut = useCallback(() => {
    if (!said) return;
    setWritten(said.text);
    setBrief(said.text);
    setMissing(null);
    focusSoon(() => briefRef.current);
  }, [said]);

  const toName = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Return goes on to the name, as the key says; Shift+Return is a new line.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    nameRef.current?.focus({ preventScroll: true });
  };

  const make = useCallback(async () => {
    if (busy || makingRef.current) return;
    const gap: Missing = templated && said?.blank ? 'blank' : missingAnswer(text, name);
    if (gap) {
      setMissing(gap);
      (gap === 'name' ? nameRef.current : templated ? wordsField() : briefRef.current)?.focus({ preventScroll: true });
      return;
    }
    makingRef.current = true;
    setBusy(true);
    setError(null);
    // The template's description, emoji and invite note while its sentence
    // is still the template's: words of their own in the plain box let go
    // of it (`picked` is Your own idea then), and are theirs to describe later.
    const example = template;
    // A choice that needs no typing, its sentence as drawn, is one of the
    // ready-made apps: it is made from that, with nothing for Homeroom bot
    // to build, so no brief.
    const ready = templated && example ? readyMadeOf(example, choice) : null;
    // A game preset starts the project from its working game: the brief is
    // still built, on it.
    const starter = templated && example ? starterOf(example, choice) : null;
    const timeZone = deviceTimeZone();
    try {
      const reply = await postCreateApp({
        name: name.trim(),
        audience: 'invited',
        ...(ready ? { template: ready.template } : { brief: text.trim(), ...(starter ? { template: starter.template } : {}) }),
        ...(example ? { description: descriptionOf(example, choice) } : {}),
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
        emoji: ready ? ready.emoji : example ? example.emoji : null,
        description: example ? descriptionOf(example, choice) : null,
        example,
        conversationId: Number(data.homeroomBot?.conversationId) || null,
        ...(ready ? { readyMade: true } : {}),
      });
    } finally {
      makingRef.current = false;
      setBusy(false);
    }
  }, [busy, templated, said, text, name, template, choice, entry, onMade]);
  const needed = neededLine(missing, text, !!template?.finish);
  // The chips under the sentence: Your own… last, or first for the game.
  const ownChip = { key: OWN, label: 'Your own…' };
  const chips = !template ? [] : template.finish ? [ownChip, ...template.choices] : [...template.choices, ownChip];
  // The game's box shows an example of the rest: the starter's, or its own.
  const boxExample = template ? (choice !== OWN && template.choices.find((c) => c.key === choice)?.example) || template.own.example : '';

  // The import, through the same request: a private community, as Make it
  // makes, from the repo; what it says about itself is its description.
  const importRepo = useCallback(async ({ repoUrl, name: repoName, manifest }: { repoUrl: string; name: string; manifest: RepoManifest }) => {
    const reply = await postCreateApp({ name: repoName, audience: 'invited', repoUrl, from: entry });
    const data = (reply.ok ? reply.data : {}) as { app?: { slug?: string; name?: string } };
    if (!reply.ok || !data.app?.slug) return reply.ok ? 'Could not import it. Try again.' : reply.error;
    onMade({
      slug: data.app.slug,
      name: data.app.name || repoName,
      emoji: null,
      description: typeof manifest.description === 'string' && manifest.description ? manifest.description : null,
      example: null,
      conversationId: null,
      imported: true,
    });
    return null;
  }, [entry, onMade]);
  const formClass = `mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] ${motion}`;
  // From Create, the allowance when it bears on Make it (the New project
  // dialog's quiet row, #23): a returning maker can be at their limit, a new
  // account never is. The wrapper goes with it when there is nothing to say.
  const allowance = fromCreate ? <div className="mt-4 empty:hidden"><AppAllowance id="make-app-quota" surface="pane" quiet /></div> : null;

  return (
    <div
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      data-make-entry={entry}
      className={underHeader ? MAKE_ROOT_UNDER_HEADER : MAKE_ROOT}
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      {/* Stays put over the scroller, so nothing scrolls under the status bar.
          At least 32px tall under the status bar's inset, so the whole mark
          is inside it and what scrolls stops below the mark, not beside it.
          From Create, ✕ at its leading edge closes the screen. Under the
          platform header the header is the top of the screen: this bar is
          only the ✕, with no mark of its own and no inset to clear. */}
      <div className={underHeader ? `relative h-12 shrink-0 ${motion}` : `relative flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)] ${motion}`}>
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
        {underHeader ? null : <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />}
      </div>
      {/* The scroller the keyboard surface reveals fields in. Its className
          stays constant: nothing here varies it. */}
      <div ref={scrollerRef} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">
        {mode === 'import' ? (
          <ImportForm
            className={formClass}
            header={(
              <div className="text-center">
                <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">{makeEyebrow(entry, who)}</p>
                <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">{IMPORT_TITLE}</h1>
                <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">{IMPORT_LINE}</p>
              </div>
            )}
            submit={importRepo}
            blocked={quotaBlocks}
            onDescribe={() => { setMode('make'); setTimeout(() => briefRef.current?.focus({ preventScroll: true }), 0); }}
            allowance={allowance}
          />
        ) : (
        <form
          className={`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] ${motion}`}
          onSubmit={(e) => { e.preventDefault(); void make(); }}
        >
          <div className="text-center">
            <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
              {makeEyebrow(entry, who)}
            </p>
            <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">What do you want to make?</h1>
          </div>
          <p className="mt-6 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">Start from an idea</p>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Ideas">
            {TEMPLATES.map((t) => {
              const on = picked === t;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  data-first-session-example={t.key}
                  onClick={() => pickTemplate(t)}
                  className={`${TILE} ${on ? TILE_ON : TILE_OFF}`}
                >
                  <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{t.chart ? <TierChart /> : t.emoji}</span>
                  <span className="text-[15px] font-[650] leading-tight">{t.short}</span>
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={picked === OWN_IDEA}
              data-first-session-example={OWN_IDEA}
              onClick={pickIdea}
              className={`${TILE} ${picked === OWN_IDEA ? TILE_ON : TILE_OFF}`}
            >
              <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">💡</span>
              <span className="text-[15px] font-[650] leading-tight">Your own idea</span>
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <div className={FIELD}>
              {templated && template && said ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={LABEL}>What should it do?</span>
                    {template.finish ? null : (
                      <button
                        type="button"
                        data-make-write-out=""
                        onClick={writeOut}
                        className="shrink-0 text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400"
                      >
                        Write it yourself
                      </button>
                    )}
                  </div>
                  <p data-make-sentence={template.key} className="pt-1 text-[17px] leading-7 text-zinc-900 dark:text-zinc-100">
                    {said.head}
                    {template.finish
                      ? (said.fill ? <><span className={BLANK}>{said.fill}</span>{' …'}</> : null)
                      : choice === OWN
                        ? (
                          <input
                            ref={wordsFieldRef}
                            id="make-words"
                            type="text"
                            autoComplete="off"
                            enterKeyHint="next"
                            maxLength={60}
                            value={words}
                            aria-label="Your own words"
                            onChange={(e) => changeWords(e.target.value)}
                            onKeyDown={toName}
                            placeholder={template.own.example}
                            className={BLANK_FIELD}
                          />
                        )
                        : <span className={BLANK}>{said.fill}</span>}
                    {said.tail}
                  </p>
                  {template.finish ? (
                    <>
                      <label htmlFor="make-words" className="mt-3 flex items-center gap-1.5 text-[13px] font-semibold text-violet-700 dark:text-violet-400">
                        <PencilSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        Finish it in your own words
                      </label>
                      <textarea
                        ref={wordsBoxRef}
                        id="make-words"
                        rows={2}
                        // Room for the sentence around it, under the server's ceiling.
                        maxLength={BRIEF_MAX - 200}
                        value={words}
                        enterKeyHint="next"
                        aria-describedby={missing === 'blank' ? 'first-session-brief-needed' : undefined}
                        onChange={(e) => changeWords(e.target.value)}
                        onKeyDown={toName}
                        placeholder={`For example, ${boxExample}`}
                        className={`${WORDS_BOX} ${words.trim() ? WORDS_FILLED : WORDS_EMPTY}`}
                      />
                    </>
                  ) : null}
                  <div className="mb-1 mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Choices">
                    {chips.map((c) => (
                      <Chip
                        key={c.key}
                        size="bar"
                        selected={choice === c.key}
                        data-make-choice={c.key}
                        onClick={() => pickChoice(c.key)}
                        className={choice === c.key ? 'px-3' : `px-3 ${TILE_OFF}`}
                      >
                        {c.label}
                      </Chip>
                    ))}
                  </div>
                  {readyMadeOf(template, choice) ? <p data-make-ready="" className={HINT}>{READY_LINE}</p> : null}
                  {starterOf(template, choice) ? <p data-make-starter="" className={HINT}>{starterLine(starterOf(template, choice)!.starts)}</p> : null}
                </>
              ) : (
                <>
                  <label htmlFor="first-session-brief" className={LABEL}>What should it do?</label>
                  <textarea
                    ref={briefRef}
                    id="first-session-brief"
                    rows={3}
                    maxLength={BRIEF_MAX}
                    value={brief}
                    enterKeyHint="next"
                    aria-describedby={missing === 'brief' ? 'first-session-brief-needed' : undefined}
                    onChange={(e) => {
                      const next = e.target.value;
                      setBrief(next);
                      // Words of their own: the idea is theirs now. Your own
                      // idea is marked, and a template lets go.
                      if (picked !== OWN_IDEA && next !== written) {
                        setPicked(OWN_IDEA);
                        setWritten(null);
                      }
                      setError(null);
                      setMissing(null);
                    }}
                    onKeyDown={toName}
                    placeholder="A map of our favorite swimming spots…"
                    className={`${INPUT} resize-none leading-[22px]`}
                  />
                  {waitlistIdea && brief === waitlistIdea ? <p data-make-waitlist-idea="" className={HINT}>{WAITLIST_IDEA_LINE}</p> : null}
                </>
              )}
              {missing === 'brief' || missing === 'blank' ? <p id="first-session-brief-needed" role="alert" className={NEEDED}>{needed}</p> : null}
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
                onChange={(e) => {
                  setName(e.target.value);
                  // A name of their own stays; an emptied one follows the choice again.
                  setNameTyped(e.target.value.trim() !== '');
                  setError(null);
                  setMissing(null);
                }}
                placeholder="For example, Hiking Tier List"
                className={INPUT}
              />
              {missing === 'name'
                ? <p id="first-session-name-hint" role="alert" className={NEEDED}>{needed}</p>
                : <p id="first-session-name-hint" className={HINT}>It's your group's name too. You can change it later.</p>}
            </div>
          </div>
          {allowance}
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
          <div className="grow" />
          <Button
            type="submit"
            disabled={busy || quotaBlocks}
            layout="full"
            variant="pillAccent"
            size="pillLg"
            ink="solidLate"
            className="mt-6 flex items-center justify-center disabled:opacity-50"
          >
            {busy ? 'Making it…' : 'Make it'}
          </Button>
          {fromCreate ? (
            // Small, under Make it: the one other way to start a project.
            <p className="mt-3 text-center">
              <button
                type="button"
                data-make-import-link=""
                onClick={() => setMode('import')}
                className="text-[13px] font-medium text-violet-700 hover:underline dark:text-violet-400"
              >
                Import from a GitHub repo
              </button>
            </p>
          ) : (
            <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              {'Not sure yet? '}
              <button type="button" onClick={onLookAround} className="font-medium text-violet-700 hover:underline dark:text-violet-400">Look around first</button>
            </p>
          )}
        </form>
        )}
      </div>
    </div>
  );
}
