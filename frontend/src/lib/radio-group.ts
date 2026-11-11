import type { KeyboardEvent } from 'react';

import { arrowStep } from './i18n/direction';

/**
 * Keyboard behaviour for a radio group drawn with buttons (#6510).
 *
 * A `role="radiogroup"` of `role="radio"` buttons promises the keyboard and
 * screen readers a native radio group, and a button only clicks. This is the
 * WAI-ARIA radio group pattern, once:
 *
 *   - the group is one tab stop: the checked radio, else the first;
 *   - Down and Up, and Left and Right as they read on screen (./i18n/
 *     direction.ts `arrowStep`), pick the next or previous option and wrap;
 *     Home and End pick the first and the last;
 *   - moving picks, through the same `choose` a click calls, and focus
 *     follows to the radio picked.
 *
 * The radios are found in the group's own subtree, in document order, so the
 * `options` must be in the order they are drawn. It holds no state and reads
 * nothing during render, so a server render and the first client render
 * agree.
 */
export function radioGroupKeys<T extends string>(
  options: readonly T[],
  value: T | null | undefined,
  choose: (next: T) => void,
) {
  const focusable = value != null && options.includes(value) ? value : options[0];
  return {
    /** 0 on the one radio Tab reaches, -1 on the rest. */
    tabIndex: (option: T): 0 | -1 => (option === focusable ? 0 : -1),
    /** Put on the radiogroup element. */
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      const next = nextRadioIndex(event.key, value != null ? options.indexOf(value) : -1, options.length);
      if (next === null) return;
      event.preventDefault();
      choose(options[next]);
      const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
      radios[next]?.focus();
    },
  };
}

/**
 * Where a key moves the pick in a group of `count` options whose checked one
 * is at `at` (-1 when none is): the index to pick, or null for a key the
 * group does not answer. With nothing checked, forward picks the first and
 * back the last.
 */
export function nextRadioIndex(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = arrowStep(key);
  if (!step) return null;
  if (at < 0) return step > 0 ? 0 : count - 1;
  return (at + step + count) % count;
}
