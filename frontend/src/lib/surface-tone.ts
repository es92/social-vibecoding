/**
 * DIALOGS OVER A DARK APP ARE DARK (#2803).
 *
 * `data-app-tone` (features/app-frame/app-tone.js) repaints the strip above a
 * running app in that app's tone, and until now it stopped there: `.dark` on
 * <html> is the theme module's alone, so every sheet, dialog and menu opened
 * over a dark app was still drawn in the viewer's LIGHT mode — a cream Send
 * feedback card and a cream Homeroom menu over a night-black page. The
 * request is that they follow the app too.
 *
 * <html> still cannot take `.dark` for it — that would flip the whole shell,
 * the page under the frame included, and fight the theme module for the
 * class. So the class goes on the SURFACES instead. Everything that draws
 * them is already written against a `.dark` ANCESTOR, not against <html>:
 * the palette blocks in app.css and native.css are plain `.dark { … }` (the
 * kit documents "on :root, .dark, or any wrapper element"), and Tailwind's
 * `darkMode: 'class'` compiles `dark:` utilities to `.dark .dark\:…`. A kit
 * shell carrying `dark` is therefore drawn exactly as it is under the dark
 * shell, tokens, `dark:` utilities and all, and nothing outside it moves.
 *
 * Which surfaces:
 *   * the kit's own shells — modal, sheet, panel, action sheet, popover and
 *     alert. Every one is appended straight to <body>, so one childList
 *     observer on <body> sees each the moment it is presented, before it
 *     paints (a MutationObserver callback runs at the microtask checkpoint);
 *   * the two in-tree sheets that present themselves without the kit — the
 *     Homeroom menu (`#apps-switcher-sheet`, a popover on desktop) and the
 *     notifications sheet. Their `className` is a constant React renders
 *     once, and `lib/kit-surface.ts` already adds `platform-sheet-adopted` to
 *     the same two nodes the same way, so a class written here survives;
 *   * the desktop rail and its parked foot, which stay docked beside a
 *     running app (see IN_TREE_SURFACES).
 *
 * Only the tone the SHELL does not already have is added: under the dark
 * shell the surfaces are dark anyway. `MARK` records which `dark` classes
 * this module wrote, so it only ever removes its own.
 *
 * A light app under the dark shell is deliberately out of scope (#2803):
 * that direction would need `.dark` REMOVED below a `.dark` <html>, which a
 * class on the surface cannot express.
 */

import { APP_TONE_ATTR } from '../features/app-frame/app-tone.js';

export const MARK = 'platform-app-tone-dark';

/** The kit's presented shells, each a direct child of <body>. */
export const KIT_SURFACES = ['un-modal', 'un-sheet', 'un-panel', 'un-action-sheet', 'un-popover', 'un-alert'];

/**
 * Shell surfaces that present in place when the kit does not take them, and
 * the desktop rail with its parked foot. On a desktop the rail stays docked
 * beside a running app (App._railBesideApp), so it is part of the strip
 * around a dark app as the bar is, and drew a pale column beside it before.
 * Both render a constant `className` and toggle their own classes through
 * refs (lib/legacy-dom.ts), so a class written here survives, as on the two
 * sheets. A light app under the dark shell is carried by app.css instead
 * ("…AND THE SIDEBAR BESIDE THE APP").
 */
export const IN_TREE_SURFACES = ['apps-switcher-sheet', 'notifications-sheet', 'platform-tabs', 'platform-parked'];

type ClassListLike = Pick<DOMTokenList, 'contains' | 'add' | 'remove'>;
type ElementLike = { classList: ClassListLike; id?: string };
type RootLike = ElementLike & Pick<Element, 'getAttribute'>;

/** True when a dark app is on screen and the shell itself is light. */
export function appToneDark(root: RootLike | null | undefined): boolean {
  if (!root) return false;
  return root.getAttribute(APP_TONE_ATTR) === 'dark' && !root.classList.contains('dark');
}

export function isToneSurface(el: ElementLike | null | undefined): boolean {
  if (!el || !el.classList) return false;
  if (el.id && IN_TREE_SURFACES.includes(el.id)) return true;
  return KIT_SURFACES.some((c) => el.classList.contains(c));
}

/** Put one surface in (or take it out of) the dark tone. Idempotent. */
export function toneSurface(el: ElementLike, dark: boolean): void {
  const cl = el.classList;
  if (dark) {
    if (cl.contains(MARK)) return;
    // Already dark on its own account (an app-drawn `.dark` wrapper): leave
    // it, and leave no mark, so taking the tone away never strips it.
    if (cl.contains('dark')) return;
    cl.add('dark');
    cl.add(MARK);
  } else if (cl.contains(MARK)) {
    cl.remove(MARK);
    cl.remove('dark');
  }
}

type DocLike = {
  documentElement: RootLike;
  body: (Node & { children: ArrayLike<ElementLike> }) | null;
  getElementById(id: string): ElementLike | null;
};

/** Re-tone every surface currently in the document. */
export function syncSurfaceTone(doc: DocLike): boolean {
  const dark = appToneDark(doc.documentElement);
  const kids = doc.body ? Array.from(doc.body.children) : [];
  for (const el of kids) if (isToneSurface(el)) toneSurface(el, dark);
  for (const id of IN_TREE_SURFACES) {
    const el = doc.getElementById(id);
    if (el) toneSurface(el, dark);
  }
  return dark;
}

type ObserverCtor = new (cb: (records: MutationRecord[]) => void) => Pick<MutationObserver, 'observe' | 'disconnect'>;

/**
 * Follow the tone and the surfaces for the life of the page: <html>'s
 * `data-app-tone` and `class` (the theme can change under an open dialog),
 * and <body>'s children (a surface presented while the tone holds).
 * Returns a disconnect, for tests.
 */
export function initSurfaceTone(doc: DocLike, Observer: ObserverCtor): () => void {
  const root = new Observer(() => { syncSurfaceTone(doc); });
  root.observe(doc.documentElement as unknown as Node, { attributes: true, attributeFilter: [APP_TONE_ATTR, 'class'] });
  const body = new Observer((records) => {
    const dark = appToneDark(doc.documentElement);
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        const el = n as unknown as ElementLike;
        if (isToneSurface(el)) toneSurface(el, dark);
      });
    }
  });
  if (doc.body) body.observe(doc.body, { childList: true });
  syncSurfaceTone(doc);
  return () => { root.disconnect(); body.disconnect(); };
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const start = () => initSurfaceTone(document as unknown as DocLike, MutationObserver);
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
