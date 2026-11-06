// The profile screen (#profile) as a React island — #1083 chunk F step 2,
// converted end to end by #1191 slice 6.
//
// #profile-root used to be an unmanaged host: React owned the container and
// ./profile.js built everything below it with createElement and textContent.
// Slice 6 finished the job. The subtree is React's now — ./profile-view.tsx
// renders it from the view ./profile-store.js derives, and ./profile.js kept
// only the fetches, the load-token discipline and the writes. That is what the
// island rule asks for before a region may hold state: no public/js/** module,
// and no module in this bundle either, writes a node inside #profile-root.
//
// #profile-edit-sheet (#982) is part of this tree now, and that is deliberate
// rather than incidental. It is NOT one of the nine dialogs that go through
// frontend/src/lib/static-modal.ts — there is no static root whose card gets
// lifted — so it is rendered here, inside #profile-root, and handed to the
// native kit by lib/kit-surface.ts. Its no-kit fallback was already "leave the
// panel at the top of #profile-root", which is exactly where React puts it.
//
// Visibility comes from the store; `false` is the shipped state. It has to be
// useVisibilityHiddenClass and not useVisibility: App._showOnlyScreen runs
// inside PlatformUI.transition(fn), and the kit snapshots the DOM before fn
// returns, so the class is written synchronously inside the publish
// (lib/visibility-store.ts).

import { useRef } from 'react';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { ProfileRoot } from './profile-view';
import './mount';

export function ProfileScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'profile-screen', false);

  return (
    <main
      ref={screenRef}
      id="profile-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
      data-page-bounce=""
    >
      {/*
          THE COLUMN IS THE WORKSHOP TAB'S (#2832). Me is a tab like Workshop,
          built from the same shapes (a SectionHeader over a GroupedList card),
          so it takes the same frame rather than one of its own:

          - `max-w-2xl`, Workshop's column (and Discover's app page). It was
            `max-w-3xl`, so on a desktop the cards jumped 96px wider moving
            from Workshop to Me.
          - `pt-5`: the platform bar is `rounded-b-2xl -mb-2`, so every screen
            root starts 8px UNDER it; `pt-5` is those 8 plus the 12px of air
            Workshop and Messages leave above their first element. `p-4` left
            the identity card 8px from the bar.
          - `px-4` is the 16px gutter GroupedList's own `mx-4` gives Workshop;
            the cards here are hand-drawn as well as grouped, so the gutter is
            the column's and the lists pass `mx-0`.
          - `pb-8`, Workshop's foot.
          - `lg:max-w-5xl`: the base column is still Workshop's, and it
            widens at `lg` for the own profile's two columns
            (profile-view.tsx's grid); everything else on the screen stays
            in the base width.
      */}
      <div id="profile-root" className="max-w-2xl lg:max-w-5xl mx-auto px-4 pt-5 pb-8">
        <ProfileRoot />
      </div>
    </main>
  );
}
