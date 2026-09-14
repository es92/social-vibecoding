/**
 * The Dev board's locked-app banner, as a view model.
 *
 * `#dev-locked-notice` sits at the top of the card list on a locked app. It
 * used to say only "App is locked", which reads as "you can't build here";
 * since #1896 it says who CAN build on the app (everyone, or invited
 * collaborators — the app's "Who can build it" setting) and that an admin
 * approves each change on top of the group's vote. It used to be a leaf host — ./board-frame.tsx rendered the empty
 * div with a constant `className`, and `AppView._renderLockedNotice` toggled
 * `hidden` on it and wrote the banner in. That is two owners of one node's
 * class attribute, tolerated only because the React side never changed it.
 *
 * One boolean removes the arrangement entirely: the module publishes whether
 * the app is locked (from `_proposalsCtx`, which is server truth loaded with
 * the feed) and the frame draws the banner or does not.
 */

import { createStore } from '../../lib/plain-store.js';

export interface LockedNoticeState {
  locked: boolean;
  /** The app's collab visibility is 'private': only invited collaborators build. */
  inviteOnly: boolean;
}

export const lockedNoticeStore = createStore<LockedNoticeState>({ locked: false, inviteOnly: false });

/** The banner's sentence — one spelling, for the frame and its tests. */
export function lockedNoticeText(inviteOnly: boolean): string {
  return `${inviteOnly ? 'Only invited collaborators' : 'Anyone'} can build on this app. `
    + 'A change goes live once the group votes it in and an admin approves it.';
}
