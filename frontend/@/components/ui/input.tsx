import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn's Input, RESTYLED TO THE PLATFORM'S EXISTING TOKENS.
 *
 * Same rules as button.tsx: `cssVariables: false`, so stock shadcn's
 * `bg-background` / `ring-offset-background` / `file:` vocabulary does not
 * exist here, and every class below is transcribed from a text field that
 * already ships in the shell. Nothing stock is added — no `h-10`, no
 * `disabled:cursor-not-allowed`, no `placeholder:text-muted-foreground` — each
 * would be a visual change, and chunk D makes none.
 *
 * The variant table reproduces, exactly, the field box the settings screen has
 * used since it was a modal:
 *
 *   rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300
 *   dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100
 *
 * ── Why `width`, `mono` and `ring` are variants rather than className ──
 *
 * cva emits the base string, then each variant group IN DECLARATION ORDER,
 * then whatever `cn` appends from className. So the only way to reproduce a
 * hand-written class string byte for byte is to declare the groups in the
 * order those strings were written in. The three groups here exist for exactly
 * that reason:
 *
 *   width  `w-full` / `flex-1 min-w-0` lead every one of these strings.
 *   mono   #connector-url writes `font-mono` BEFORE the focus ring;
 *          #settings-api-key and #settings-openrouter-key write it after. The
 *          prop is the first spelling, `className="font-mono"` the second, so
 *          both render unchanged. (Two hand-authored strings, one accidental
 *          difference — normalising it is a byte change for no benefit, and a
 *          byte change is the one thing a like-for-like conversion cannot
 *          make.)
 *   ring   the shell's focus treatment, absent from the App AI permissions
 *          row's cap field, and carrying `focus:border-transparent` on the
 *          dialogs' fields.
 *   hint   the placeholder colour, which the dialogs and the auth screens
 *          spell differently.
 *
 * `box` grew the same way: `dialog`, `tight` and `auth` are three more real
 * field boxes, not three opinions about one. Where two of them differ only by
 * an accident of authoring they are still kept apart — reconciling them is a
 * visual change with its own evidence to gather, and a byte change is the one
 * thing a like-for-like conversion cannot make.
 *
 * Keep every class name a COMPLETE literal — Tailwind's extractor is a regex
 * over source text, and tests/tailwind-build.test.js fails the suite on a
 * class name assembled from fragments.
 */
const inputVariants = cva('', {
  variants: {
    /**
     * A styling class from app.css that LEADS the string, ahead of everything
     * this table draws. It is a variant rather than a `className` for the one
     * reason every group here exists: className lands LAST, and this does not.
     *
     * None leads today: the group chat's composer that did
     * (`.gc-composer-input`) is Messages' message box now (one message box,
     * 27 Nov 2026).
     */
    lead: { none: '' },
    // Leads the string on the three waitlist-survey fields that follow a
    // sibling rather than a label: #more-made-note under #more-made-url,
    // #more-group-need under the tools chip row, and the bottom margin's
    // mirror on #waitlist-confirm-email (which writes its `mb-2` AFTER
    // `w-full`, so that one rides in through className).
    spacing: { mt2: 'mt-2', mt3: 'mt-3', none: '' },
    width: {
      full: 'w-full',
      flex: 'flex-1 min-w-0',
      // #share-url-input, which sits in a `flex gap-2` row with no long value
      // to shrink around.
      flex1: 'flex-1',
      // #members-approvals-n, the approvals-threshold number field.
      hiddenW16: 'hidden w-16',
      // #llm-consent-cap, the app-consent dialog's dollars-per-day field —
      // wide enough for "1000.00" and no wider, so it reads as an amount
      // rather than as a text field.
      w32: 'w-32',
      // The App AI permissions row's per-app cap (features/settings/
      // grants-list.tsx). The same "an amount, not a text field" decision at
      // the narrower size the row affords.
      w20: 'w-20',
      none: '',
    },
    box: {
      // The settings screen's standard field.
      default:
        'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      // The dialogs' field, inheriting its text size from the card rather
      // than setting `text-sm` itself. White on the white card, with its
      // edge (phone review #52, 23 Nov 2026): the settings screen's grey
      // fill, on a dialog, read as a field that was switched off.
      dialog:
        'rounded-lg bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100',
      // #members-approvals-n — the same box at number-field size.
      tight:
        'rounded-lg bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100',
      // The auth screens' field. A darker dark-mode fill than the settings
      // one (`zinc-900`, against the auth card's `zinc-800`), and no text
      // size of its own. Kept separate rather than normalised onto
      // `default`: they are two different rendered strings today.
      auth:
        'rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100',
      // The two WAITLIST SURVEY screens' field — `#waitlist-*` and `#more-*`
      // (features/auth/waitlist.tsx, features/auth/more.tsx, both through
      // `SURVEY_FIELD` in features/auth/waitlist-shared.tsx). The same box as
      // `auth` on a WHITE resting fill, at `text-sm`, and with no text colour
      // of its own — these fields inherit the screen's ink.
      //
      // ── Why the survey screens do not take `card` ──────────────────────
      //
      // Sign-in and register spell their fields `box: 'card'`: box-less, 17px,
      // a ROW of the white `AUTH_CARD` that is the real box. That works
      // because those forms are two or three credential fields stacked inside
      // one card, where the card's hairlines do the separating. These screens
      // are not that shape. They are long scrollable questionnaires — sixteen
      // fields interleaved with help lines, chip rows, a two-column select
      // grid and a conditional block — and there is no card row to be a row
      // of. Sixteen box-less fields down a page have nothing drawing their
      // edges, so the reader cannot see where an answer may be typed; and
      // wrapping each question in a card to get the edge back would be a
      // re-layout of both screens, not a consistency fix.
      //
      // So the surfaces differ, deliberately, by what they are drawn on — and
      // the win the audit asked for is still taken: this is ONE spelling owned
      // by the primitive instead of sixteen hand-written copies of it.
      authWhite:
        'rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm',
      // The App AI permissions row's field: a white fill on the row's card
      // and a small radius, with the tight padding that keeps a number field
      // on one line of a `text-xs` row (features/settings/grants-list.tsx).
      // It draws NO focus rule of its own — pair it with `ring={false}`, which
      // leaves the browser's own outline as the cue, exactly as the
      // hand-written string did.
      insetTight:
        'rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5',
      // A field inside a native-kit inset-grouped row (#1285): the ROW is the
      // box. `.un-group` draws the card fill and radius, `.un-group-row` the
      // hairline and the `px-4` that lines it up, so the field itself
      // contributes no fill, no border and no horizontal padding — anything it
      // did contribute would draw a second box inside the first. Pair it with
      // `ring={false}`: `.un-group` is `overflow: hidden`, which clips an
      // outward focus ring, so the focus cue is a `focus-within:` tint on the
      // row instead.
      //
      // Call sites: #profile-edit-name, #profile-edit-bio (through Textarea),
      // #profile-edit-github, #profile-edit-x and #profile-edit-username, all
      // in features/profile/profile-edit-sheet.tsx.
      groupRow:
        'bg-transparent border-0 px-0 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      // The group chat's and the Activity feed's message fields lived here
      // (`composer`, `composerCard`, `composerTight`, `activityReply`): every
      // message box is Messages' own now (one message box, 27 Nov 2026).
      // A field that is a ROW of a white card (settings, sign-in): the card
      // is the box, so the field draws none and reads at 17px.
      card:
        'border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100',
    },
    // The placeholder colour, written between the box and the focus ring in
    // every string that has it. Named `hint`, not `placeholder`, because
    // `placeholder` is a real attribute on this element and a variant group
    // of that name would shadow it at every call site.
    hint: {
      none: '',
      // The dialogs.
      muted: 'placeholder-zinc-400 dark:placeholder-zinc-500',
      // The auth screens.
      dim: 'placeholder-zinc-500',
    },
    mono: { true: 'font-mono', false: '' },
    ring: {
      true: 'focus:outline-none focus:ring-2 focus:ring-violet-500',
      // The ring PLUS a focused border colour — the waitlist surveys' focus
      // treatment, and the one thing about those fields that is not merely
      // cosmetic (#1529). iOS Safari does not paint a box-shadow on a
      // natively-styled control, so the ring alone leaves a phone with no
      // focus cue at all; colouring the resting border is what guarantees a
      // visible outline on every engine. It is a variant rather than a
      // className so the pair cannot be separated one call site at a time —
      // tests/waitlist-focus-outline.test.js is the rule, this is the spelling.
      bordered:
        'focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
      // NO RULE AT ALL — which means the browser's own focus ring still
      // draws. That is deliberate for `groupRow`, whose `.un-group` clips an
      // outward ring and whose row carries a `focus-within:` tint instead:
      // the UA outline is the only cue those fields have left.
      false: '',
      // Suppresses the UA outline WITHOUT drawing a ring of our own — which
      // `false` does not do, and the difference is a blue box nobody asked
      // for. For a field that contributes no box: the dev composer's, where
      // the card around it is the only edge and a ring inside that card would
      // be a second one.
      //
      // The focus cue is the CARET. That is sound for a text field — the
      // blinking cursor is exactly what tells you where typing goes — and it
      // is why this value must not spread to buttons or selects, which have
      // no caret and would be left with no focus indicator at all.
      bare: 'focus:outline-none',
      // The dialogs' fields also drop the border colour while focused, so the
      // ring reads as the only edge.
      seamless:
        'focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent',
    },
    // Only the `insetTight` box carries its text colour after the two groups
    // above; `default` has it inline, where the hand-written string put it.
    text: { true: 'text-zinc-900 dark:text-zinc-100', false: '' },
  },
  defaultVariants: {
    lead: 'none',
    spacing: 'none',
    width: 'full',
    box: 'default',
    hint: 'none',
    mono: false,
    ring: true,
    text: false,
  },
});

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width'>,
    VariantProps<typeof inputVariants> {}

// `{...props}` is spread BEFORE className, like Alert: React serializes
// attributes in prop order, and the hand-written markup writes `id` and `type`
// ahead of `class`. className is destructured out above, so the spread can
// never clobber it.
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, lead, spacing, width, box, hint, mono, ring, text, ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={cn(
        inputVariants({ lead, spacing, width, box, hint, mono, ring, text }),
        className,
      )}
    />
  ),
);
Input.displayName = 'Input';

export { Input, inputVariants };
