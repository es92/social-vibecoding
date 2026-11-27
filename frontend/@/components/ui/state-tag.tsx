import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The tag for where something stands: one part, three states.
 *
 * How far along a change or a request is used to be written by about seven
 * tags of their own (a change's and a request's page, the board's and the
 * Workshop's rows, the hub, Home, the Homeroom bot tab's list and the
 * Workshop's This week), each in its own tones, so the same change could look
 * three ways on three screens. They all draw this one now:
 *
 *   - `plain`   says where it stands: an outline in the quiet ink ("Live",
 *               "0 of 1 approval", "Merge conflict", "3 new"). It is the
 *               outlined pill a request's page always carried.
 *   - `working` is plain with the turning mark, while something is under way:
 *               checking, being built, going live. The same pill's spinner form.
 *   - `needs`   is the strong pill, for what asks for you ("3 to vote",
 *               "Vote", "Read", "Review plan"): the dark count pill the
 *               project's hub drew.
 *
 * Nothing else: no green for done, no red for blocked, no blue for a verb.
 * The words carry what differs, and a row's tooltip carries the detail.
 *
 * ── Drawn once, in app.css ────────────────────────────────────────────
 *
 * The look is the shared part `.one-tag` in app.css's ONE LOOK · SHARED PARTS
 * block, which draws each shared part once at a specificity the per-screen
 * rules before it do not reach. So the variants below name that part's
 * classes, complete literals as every cva table here is, rather than
 * utilities: a utility on this span would lose to the part's own rule. A
 * caller adds its hooks (an id, a `data-*` the declared checks select on, a
 * class an area's rule PLACES the tag with) and never a colour.
 *
 * A tag is not a control. The row it sits on is what you press, so it is a
 * span, flat, with no edge and no hover. The yellow Vote button is a button
 * and is not this.
 */

export type TagState = 'plain' | 'working' | 'needs';

const stateTag = cva('one-tag', {
  variants: {
    state: {
      plain: 'one-tag-plain',
      working: 'one-tag-plain one-tag-working',
      needs: 'one-tag-strong',
    },
  },
  defaultVariants: { state: 'plain' },
});

export interface StateTagProps extends React.HTMLAttributes<HTMLSpanElement> {
  state?: TagState;
}

export function StateTag({ state = 'plain', className, children, ...props }: StateTagProps) {
  return (
    <span data-state-tag={state} className={cn(stateTag({ state }), className)} {...props}>
      {state === 'working' ? <span className="dc-status-spinner-arc" aria-hidden="true"></span> : null}
      {children}
    </span>
  );
}
