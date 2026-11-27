/**
 * Where a file dropped on a Messages thread goes (#6254): the pane owns the
 * drop, the composer that draws the thread's box owns the upload.
 *
 * A conversation and the reply thread beside it are siblings, each with its
 * own composer and its own scope (./store scopeKey), so a pane cannot hold
 * its composer as a child. This is the one link between them, keyed by that
 * scope: the composer registers the way it attaches files, the pane asks
 * whether one is drawn (so an awaiting or cannot-send thread shows no
 * outline) and hands a drop to it.
 *
 * Registration happens in an effect, so a pane that mounts first hears about
 * the composer once it is there. The last registration for a scope wins, and
 * its unregister removes only that one.
 */

import { useSyncExternalStore } from 'react';

import { useFileDrag } from '../attachments/file-drag';
import type { ComposerScope } from './store';

type DropFiles = (files: File[]) => void;

const registered = new Map<string, DropFiles>();
const listeners = new Set<() => void>();

function keyOf(scope: ComposerScope): string {
  return String(scope);
}

function publish() {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Let a composer take files dropped on the pane for `scope`; returns its removal. */
export function registerComposerDrop(scope: ComposerScope, drop: DropFiles): () => void {
  const key = keyOf(scope);
  registered.set(key, drop);
  publish();
  return () => {
    // A newer composer for the same scope may have registered since.
    if (registered.get(key) !== drop) return;
    registered.delete(key);
    publish();
  };
}

/** Hand dropped files to the composer drawn for `scope`; false when there is none. */
export function dropOnComposer(scope: ComposerScope, files: File[]): boolean {
  const drop = registered.get(keyOf(scope));
  if (!drop) return false;
  drop(files);
  return true;
}

/** Whether a composer that can take a drop is drawn for `scope`. */
export function composerDropReady(scope: ComposerScope): boolean {
  return registered.has(keyOf(scope));
}

/** `composerDropReady`, subscribed: the pane redraws when its box comes and goes. */
export function useComposerDropReady(scope: ComposerScope): boolean {
  return useSyncExternalStore(
    subscribe,
    () => composerDropReady(scope),
    () => false,
  );
}

/**
 * #6254: the whole thread pane takes a dropped file, not only the box at its
 * foot. The composer for this pane's scope owns the upload, so the pane asks
 * whether one is drawn — an awaiting or cannot-send thread shows no outline
 * and drops nothing — and hands the files over. Messages' panes and a
 * project chat's (group-chat/general-chat.tsx, thread-shell.tsx) alike.
 */
export function usePaneDrop(scope: ComposerScope) {
  const ready = useComposerDropReady(scope);
  return useFileDrag({ disabled: !ready, onFiles: (files) => { dropOnComposer(scope, files); } });
}
