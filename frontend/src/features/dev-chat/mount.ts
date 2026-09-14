/**
 * The legacy → React seam for the dev chat.
 *
 * ── Why a bridge, when dev-chat.js is in this very bundle ─────────────
 *
 * It could import directly — it is an ES module a few files away — and the
 * first attempt did. It cost 194 tests: a dozen test files load
 * `features/dev-chat/dev-chat.js` into a `vm` context as a SCRIPT, with
 * `vm.runInContext(SRC)`, so they can drive `DevChat` against a DOM stub, and
 * a top-level `import` is a syntax error there.
 *
 * So the module stays import-free and reaches React by name, exactly as the
 * classic scripts in public/js/** do. That is a real constraint on this file's
 * neighbour rather than a stylistic choice, and it will hold for every further
 * piece of the dev chat's conversion.
 *
 * Published at module-evaluation time, like ../dev-board/mount.ts, so the API
 * exists before hydration and therefore long before anything can reach the
 * chat. The `typeof window` guard is not decoration: the SSG prerender pass
 * evaluates this module graph in Node.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { mountLegacyPortal } from '../../lib/legacy-portals';
import './launchpad.js';
import { attachStripStore, type AttachStripState } from './attach-strip-store';
import { budgetPillStore, type BudgetPillState } from './budget-pill-store';
import { composerStore, type ComposerState } from './composer-store';
import {
  quickRepliesStore,
  runnerStore,
  type QuickRepliesState,
  type RunnerState,
} from './composer-chrome-store';
import { bannersStore, type BannersState } from './banners-store';
import { sessionHeaderStore, type SessionHeaderState } from './session-header-store';
import { sessionListStore, type SessionListState } from './session-list-store';
import { specViewerStore, type SpecViewerState } from './spec-viewer-store';
import { DevChatView } from './view';
import { devViewStore, type DevViewState } from './view-store';
import {
  nowStore,
  streamStore,
  transcriptStore,
  type StreamState,
  type TranscriptState,
} from './transcript-store';

export interface DevChatBridge {
  // Four strips that used to mount into hosts `renderChatView` wrote. The
  // whole composer is one island now, so it renders their elements too and
  // only their STATE crosses the seam.
  publishAttachStrip(state: AttachStripState): void;
  publishBudgetPill(state: BudgetPillState): void;
  publishQuickReplies(state: QuickRepliesState): void;
  publishRunner(state: RunnerState): void;
  publishComposer(state: ComposerState): void;
  // `#dc-view`'s children. Everything below is INSIDE it, so only its state
  // crosses the seam — the five hosts that used to be portalled into are
  // ordinary children of this one component now.
  mountDevView(host: Element | null, state: DevViewState): void;
  publishDevView(state: DevViewState): void;
  publishSessionList(state: SessionListState): void;
  publishSessionHeader(state: SessionHeaderState): void;
  publishBanners(state: BannersState): void;
  publishTranscript(state: TranscriptState): void;
  publishStream(state: StreamState): void;
  publishSpecViewer(state: SpecViewerState): void;
  publishNow(now: number): void;
}

// Both of `renderChatView`'s converted STRIPS flush synchronously, and for the
// same reason the dev board's stores do: the line that used to publish them
// was an `innerHTML` or an `outerHTML` assignment, so every caller was written
// against a DOM that had already changed by the next statement.
// `_maybeOpenShotVenueSheet` resolves `#dc-venue-select` on the line after the
// header mounts, and every `_apply*Banner` inherited a caller that could do the
// same. Restoring the contract costs a synchronous render of one small strip.
sessionHeaderStore.setFlush(flushSync);
bannersStore.setFlush(flushSync);

// `#dc-view`'s own store flushes for the sharpest version of the same
// reason: `renderChatView`'s next dozen lines resolve controls by id —
// `initScrollTracking`, `_setupAttachments`, `_restoreDraft`, the form's
// submit listener, `attachScreenFx`, both resizers — exactly as they did
// when the line above was an `innerHTML` assignment.
devViewStore.setFlush(flushSync);

// The composer flushes for the same reason and one more of its own:
// `_syncSaveDraftBtn` reads the textarea's live `value` to decide whether the
// save icon is pressable, so the field has to exist by the time the line
// after the mount runs. `_setupAttachments`, `_restoreDraft` and the form's
// submit listener resolve their controls by id on the same lines.
composerStore.setFlush(flushSync);

// The transcript and its live bubble flush for the same reason, and it is the
// sharpest case on the screen: `DevChat.scrollToBottom()` runs on the line
// after `renderMessages()` in nineteen places, and again after every streamed
// frame. It measures `#dc-messages`' `scrollHeight` — the height of the
// content the publish above it just changed. Batched, it would measure the
// PREVIOUS paint and the view would sit one row short of the bottom for the
// whole of a turn.
//
// `nowStore` is deliberately NOT flushed: the 1s heartbeat publishes it, no
// caller measures afterwards, and letting React batch that tick with whatever
// else the same frame touched is the cheaper of the two behaviours.
transcriptStore.setFlush(flushSync);
streamStore.setFlush(flushSync);

// The spec reader flushes because `_initSpecResizer` runs on the line after
// `renderChatView`'s publish and measures `#dc-spec-viewer`'s rect, and
// because `_publishSpecViewer` kicks the lazy fetch for a frozen version
// immediately after publishing — the same "the DOM has already changed by the
// next statement" contract every caller of the old `innerHTML` write had.
specViewerStore.setFlush(flushSync);

export const devChatBridge: DevChatBridge = {
  // `#dc-view`'s children — the whole screen. The ELEMENT is
  // public/js/app-view.js's `renderDevChatTab` template; everything inside it
  // is this one component, which is why the five hosts that used to be
  // portalled into it are ordinary children now.
  //
  // The state rides in WITH the mount, and every caller below depends on it:
  // `initScrollTracking`, `_setupAttachments`, `_restoreDraft`, the form's
  // submit listener and `attachScreenFx` all resolve controls by id on the
  // lines after `renderChatView`'s one call.
  mountDevView(host, state) {
    if (!host) return;
    devViewStore.set(state);
    mountLegacyPortal(host, createElement(DevChatView));
  },

  // `_repaintDevFlow` and #194's proposal hint land here. Both used to be a
  // whole `renderChatView` or an `insertAdjacentHTML` in front of it.
  publishDevView(state) {
    devViewStore.set(state);
  },

  // Six writers land here: `_setStreamingUI`, `_syncSaveDraftBtn`,
  // `_syncShortcutHint`, `_renderSavedDrafts`, `_setAttachError` and
  // `_refreshModelSelect`. Every one of them was reading the same two
  // questions — is a turn running, and where is this session built.
  publishComposer(state) {
    composerStore.set(state);
  },

  // The four strips INSIDE it. Their elements are the composer's markup now,
  // so what is left of each seam is its state.
  publishAttachStrip(state) {
    attachStripStore.set(state);
  },

  publishBudgetPill(state) {
    budgetPillStore.set(state);
  },

  publishQuickReplies(state) {
    quickRepliesStore.set(state);
  },

  publishRunner(state) {
    runnerStore.set(state);
  },

  publishSessionList(state) {
    sessionListStore.set(state);
  },

  // `_patchHeaderStatusPill` — the mid-turn lifecycle repaint. It wrote
  // `#dc-status-pill.innerHTML` in place precisely so a live stream was not
  // disturbed by a full `renderChatView`; a publish here re-renders the
  // header alone and leaves the transcript's portal untouched.
  publishSessionHeader(state) {
    sessionHeaderStore.set(state);
  },

  // Every `_apply*Banner` lands here. They were three copies of an
  // outerHTML-swap / remove / insertAdjacentHTML dance whose whole purpose was
  // to change a strip WITHOUT re-rendering the transcript under an in-flight
  // stream; a publish does that by construction.
  publishBanners(state) {
    bannersStore.set(state);
  },

  publishTranscript(state) {
    transcriptStore.set(state);
  },

  // The live bubble, per animation frame. It is its own store so that a
  // streaming turn re-renders ONE row instead of the entire list sixty times a
  // second — see ./transcript-store.ts. `key` names the row the html belongs
  // to, so a frame left over from the previous turn cannot paint into the
  // next one's bubble.
  publishStream(state) {
    streamStore.set(state);
  },

  // The shared-spec reader. Six writers landed on the pane — the loader's
  // start and finish, a version switch, a frozen-version fetch, a group share
  // and a tab click — and every one of them was a full `innerHTML` rebuild
  // that also threw away the panel's own transient state. See
  // ./spec-viewer-store.ts.
  publishSpecViewer(state) {
    specViewerStore.set(state);
  },

  // The 1s heartbeat. Three `textContent` passes over `#dc-messages` — the
  // elapsed suffixes, the AI guess's count-down and the long-run cohort hint —
  // are one publish now; each span re-derives its own text from this clock.
  publishNow(now) {
    nowStore.set({ now });
  },
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devChat = devChatBridge;
}
