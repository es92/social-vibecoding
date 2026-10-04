/**
 * `#gc-mention-menu`, `#gc-ref-menu` and `#gc-emoji-menu` — the composer's
 * autocomplete listboxes, as the only React writers below those hosts.
 *
 * ── The host is the module's, the children are React's ────────────────
 *
 * Both menus are `position: fixed` elements appended to `document.body` by
 * `public/js/group-chat.js`, which measures the composer's rect and writes
 * `left` / `top` / `width` on every render and every scroll. That stays: the
 * host is not in any React tree, its geometry is a live measurement, and its
 * `hidden` is the open/close state the keydown handler owns. This file renders
 * what is INSIDE it, through a portal established once per menu.
 *
 * ── `_move` stopped repainting ────────────────────────────────────────
 *
 * An arrow key used to walk every option element and toggle
 * `gc-mention-option-active` on it, then `scrollIntoView` the winner. It
 * publishes an index now; the class follows from the render, and the scroll is
 * an effect keyed on that index — which is the same moment it happened before,
 * just expressed as "after this paint" instead of "at the end of this loop".
 *
 * ── Accept is still a delegated `mousedown` on the host ───────────────
 *
 * Deliberately not an `onMouseDown` prop per row. The handler must
 * `preventDefault()` to keep the composer focused — a blur-then-click would
 * close the menu before the click landed — and it is bound ONCE by
 * `_ensureMenu`, on an element that outlives every render. Moving it into the
 * rows would rebind it on each keystroke for no gain, so the rows keep the
 * `data-username` / `data-kind` + `data-number` / `data-emoji` attributes that
 * handler reads.
 */

import { useEffect, useRef } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import {
  autocompleteStore,
  type AutocompleteSlot,
  type EmojiSlot,
  type MentionOption,
  type RefOption,
} from './autocomplete-store';

/**
 * Keep the highlighted row in view. `block: 'nearest'` so moving down one row
 * scrolls by one row rather than centring the list under the pointer.
 */
function useActiveScroll(active: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return ref;
}

export function MentionMenuView({ items, active }: AutocompleteSlot<MentionOption>) {
  const activeRef = useActiveScroll(active);
  return (
    <>
      {items.map((item, i) => (
        <div
          key={item.username}
          ref={i === active ? activeRef : undefined}
          className={`gc-mention-option${i === active ? ' gc-mention-option-active' : ''}`}
          role="option"
          data-username={item.username}
          data-index={i}
        >
          {item.bot ? (
            <>
              <img className="gc-mention-option-mark" src="/brand/homeroom-mark.png" alt="" aria-hidden="true" />
              {item.displayName || item.username}
              <span className="messages-bot-badge">AI</span>
            </>
          ) : (
            <>
              <span className="gc-mention-option-at">@</span>
              {item.username}
              {item.you ? <span className="gc-mention-option-you">you</span> : null}
            </>
          )}
        </div>
      ))}
    </>
  );
}

export function RefMenuView({ items, active }: AutocompleteSlot<RefOption>) {
  const activeRef = useActiveScroll(active);
  return (
    <>
      {items.map((item, i) => (
        <div
          key={`${item.kind}:${item.number}`}
          ref={i === active ? activeRef : undefined}
          className={`gc-mention-option gc-ref-option${i === active ? ' gc-mention-option-active' : ''}`}
          role="option"
          data-kind={item.kind}
          data-number={item.number}
          data-index={i}
        >
          {/*
              The badge reuses the message-chip classes so the dropdown teaches
              the rendering: violet PR#N, emerald #N.
          */}
          {item.kind === 'channel' ? (
            <span className="gc-channel-ref">{`#${item.number}`}</span>
          ) : item.kind === 'pr' ? (
            <span className="gc-ref gc-ref-pr">{`PR#${item.number}`}</span>
          ) : (
            <span className="gc-ref gc-ref-issue">{`#${item.number}`}</span>
          )}
          <span className="gc-ref-option-title">{item.title}</span>
        </div>
      ))}
    </>
  );
}

/**
 * `:th` — "Emoji matching :th" over up to eight `👍 :thumbsup:` rows.
 *
 * Unlike the other two, this host is not itself the listbox: the heading is
 * not an option, so it sits above a listbox of its own. Closed is empty, the
 * same as theirs.
 */
export function EmojiMenuView({ items, active, query }: EmojiSlot) {
  const activeRef = useActiveScroll(active);
  if (!items.length) return null;
  return (
    <>
      <div className="gc-emoji-menu-heading">
        Emoji matching <span className="gc-emoji-menu-query">{`:${query}`}</span>
      </div>
      <div role="listbox" aria-label="Emoji">
        {items.map((item, i) => (
          <div
            key={item.emoji}
            ref={i === active ? activeRef : undefined}
            className={`gc-mention-option gc-emoji-option${i === active ? ' gc-mention-option-active' : ''}`}
            role="option"
            aria-selected={i === active}
            data-emoji={item.emoji}
            data-shortcode={item.shortcode}
            data-index={i}
          >
            <span className="gc-emoji-option-glyph" aria-hidden="true">{item.emoji}</span>
            <span className="gc-emoji-option-code">{`:${item.shortcode}:`}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function MentionMenu() {
  return <MentionMenuView {...useStoreState(autocompleteStore).mention} />;
}

export function RefMenu() {
  return <RefMenuView {...useStoreState(autocompleteStore).ref} />;
}

export function EmojiMenu() {
  return <EmojiMenuView {...useStoreState(autocompleteStore).emoji} />;
}
