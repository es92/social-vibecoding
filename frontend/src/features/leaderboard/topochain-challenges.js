// Challenges pane of the Leaderboard screen — the challenge grid.
//
// This file was public/js/topochain-seasons.js (Task 14, the public
// seasons/events screen at #topochain/seasons). The leaderboard merge folded
// it, and the separate #challenges screen (the deleted public/js/challenges.js),
// into the Leaderboard screen's third tab:
//   - the event picker + hero it used to render itself moved UP into the
//     shared bar owned by ./topochain-event-context.js, so this pane
//     and the standings pane always describe the same event;
//   - the old #challenges screen's one unique contribution — YOUR OWN points
//     on each challenge — became a decoration on these (richer) cards, see
//     "personalization" below;
//   - its season-scope leaderboard block is gone: it was a thinner copy of the
//     standings tab, one tab over (#1917 retired the link that pointed there).
//
// Hosted in #challenges-root inside #leaderboard-screen (public/index.html);
// mounted/unmounted by the Leaderboard module (./leaderboard.js) when
// its section flips, not by a navigate* pair in app.js. The legacy
// #topochain/seasons and #challenges hashes both still land here — the router
// aliases them to #leaderboard/challenges.
//
// Two levels, served by /api/v4:
//   - challenge grid: GET /season-events/:id/challenges (card_preview fields).
//   - challenge detail page: the SAME challenge's detail_modal fields, already
//     in hand from the grid fetch.
// The Semi design (2026-10-16) retired the detail page's participant list
// (the challenge breakdown read) and the profile overlay it opened, with
// every word about seasons and time: no deadlines, no group clocks, no "next
// count". The tab is the challenges running now, in three groups — First
// challenges, Next challenges, Done — under one summary line.
//
// PERSONALIZATION: on top of the public grid, a second fetch to
// GET /challenges-api/challenges?season_event_id=<id> (session-cookie authed,
// src/routes/topochain/mobile.js) supplies the viewer's own per-challenge
// points plus `featured`, keyed by the same challenges.id the public endpoint
// returns. It is strictly DECORATIVE: a 401/422/network failure leaves the
// public grid exactly as it rendered, with no error banner.
// The public response itself now applies onboarding before first paint and
// carries its progress, so a failed decoration request cannot reveal locked
// challenges or mistake an organiser's archive flag for personal completion.
//
// COMPLETION (#981): `completed` is a column on the challenges row — an
// organiser flag about the CHALLENGE ("this one is over"), not a per-user
// completion. The per-user signal is activities_total. This pane is now the
// HOME for that flag: the profile screen used to list the season's finished
// challenges and no longer does (see the header of
// frontend/src/features/profile/profile.js), so the grid puts them under
// Done, counts them in the summary line and marks them on the card's rail.
//
// That is why `completed` is read from the PUBLIC row rather than from the
// personalization map it used to come from: the chip, the grouping and the
// count are all correct on FIRST PAINT and for an ANONYMOUS visitor, neither
// of which held while the flag arrived only with the session-authed pass.
// (`featured` still comes from that pass, so the featured lift can still
// re-sort once it lands — pre-existing behaviour, deliberately unchanged.)
//
// ── #1191 slice 6, conversion 7: this file builds DESCRIPTORS ────────────
//
// `#challenges-root` was the Leaderboard screen's last innerHTML host. It is
// React-owned now: ./challenges-pane.tsx is the only writer below it, and the
// four render methods below push view descriptors into
// ./topochain-challenges-store.js instead of assembling markup. That is a
// change of OUTPUT TYPE, not of behaviour — the ordering, the completed
// split, the deep-link resolution and every id are the ones this file already
// shipped, and each is still decided here.
//
// Three consequences worth stating, because each replaced something visible
// in the diff:
//
//   * `esc()` is gone, replaced by `str()`. There is no markup left to escape
//     — React escapes the text when it renders it, and an esc() surviving
//     into a descriptor would double-encode. What outlived it is the
//     null→'' coercion, which is still load-bearing: React prints
//     String(null) as the four-character word "null". `safeHref()` did NOT
//     retire with it, because it guards a real `href` attribute and React
//     does not validate schemes.
//   * The `addEventListener` sweeps that were re-bound after every render
//     are named methods now — `_openIdx` for a card — and the component
//     calls them. The behaviour stayed here; only the wiring moved.
//   * The detail page's `hidden` class retired into its descriptor: `detail`
//     is null when closed. Only the PANE ROOT's visibility is
//     still `Leaderboard._applySection()`'s `classList.toggle`, which is why
//     #challenges-root keeps a constant `className` in ./index.tsx.
'use strict';

const TopochainChallenges = {
  // ./topochain-challenges-store.js, planted by ./mount.ts rather than
  // imported — see that store's header for why this file can take no import
  // at all. Null during the SSG prerender pass and until the bundle mounts,
  // so every write below goes through `?.set(...)`.
  _store: null,

  _open: false,

  _challenges: [],
  _challengesLoading: false,
  _challengesError: null,
  // challenge id -> the viewer's own row from /challenges-api/challenges.
  // Empty map = no personalization available (signed out, request failed);
  // the grid renders identically, just without the "you" decorations.
  _mine: new Map(),
  // The viewer's block-production queue state from GET /challenges-api/bp/
  // state, read when a block-production challenge's page opens (#2493).
  // `undefined` is loading, `null` could not be read (the page offers a
  // retry), otherwise { has_platform_access, bp_requested, bp_released }.
  // `_bpSeq` fences each read, so a slow answer from an earlier open of the
  // same page cannot overwrite a newer one.
  _bpState: undefined,
  _bpSeq: 0,
  _bpRequesting: false,
  // The viewer's per-invitee statuses from GET /challenges-api/me/invites,
  // read when an invite challenge's page opens (#3650). Same shape of
  // lifecycle as _bpState: `undefined` is loading, `null` could not be read
  // (the page offers a retry), otherwise { target, people: [...] }.
  // `_invitesSeq` fences each read the same way.
  _invites: undefined,
  _invitesSeq: 0,
  _onboarding: null,
  // Unsubscribe handle from TopochainEventContext.onChange.
  _unsub: null,
  // Unwatch handle from live reads (#3985), held while the pane is open.
  _unwatchLive: null,
  // Fences for the list and the viewer's own rows (#3985): a re-read can
  // overlap an earlier read, and only the newest answer may land.
  _listSeq: 0,
  _mineSeq: 0,
  // The event id `_challenges` was last loaded for. `undefined` until the
  // first load, which is deliberately distinct from the `null` a pane with
  // no resolvable event settles on.
  _loadedEventId: undefined,
  // True once the ?shot=challenge-detail deep link has fired, so a later
  // re-render (event switch, personalization landing) doesn't reopen it.
  _shotFired: false,
  // Pending #leaderboard/challenges/<eventId>/<challengeId> request (#982),
  // as { eventId, challengeId }, or null. Held rather than acted on
  // immediately because the router registers it before the pane has
  // mounted, let alone fetched the event's challenge list.
  _pendingDeepLink: null,
  // The address a card tap pushed for the detail page it opened
  // (#leaderboard/challenges/<eventId>/<challengeId>), or null. The detail is
  // a page, so it owns a history entry: the phone's back gesture pops it and
  // _onHashChange closes the page once the address stops naming it. Null for
  // a page opened without one (?shot, or a cold deep link whose hash the
  // section switch has already rewritten).
  _detailHash: null,
  // The hashchange listener open() installs, kept so close() can remove it.
  _hashListener: null,
  // The `sv:app-activity-recorded` listener open() installs (#5235), kept so
  // close() can remove it. The literal string is spelled in open() because
  // this module stays import-free (see _illustrationOf).
  _activityListener: null,
  // Set when an acknowledged app-visit upload arrives while a first load of
  // the grid is still out; the end of loadChallenges takes it as one _reread
  // once that read has settled, so the skeleton is never put back over a load
  // that already started. Reset by close().
  _rereadQueued: false,

  // The challenge detail page's challenge: the clicked challenge-grid item,
  // which already carries card_preview/detail_modal.
  _detailChallenge: null,

  isOpen() { return TopochainChallenges._open; },

  // What is left of esc() after conversion 7 took the markup away: the
  // null→empty coercion, with none of the escaping. React escapes every text
  // node and every attribute value it renders, so escaping here would
  // double-encode — a challenge goal reading `Ship & tell` would paint as
  // `Ship &amp; tell`. The coercion is NOT redundant: React renders
  // String(null) as the four-character word "null", so a nullable API field
  // still has to land as ''.
  str(s) {
    return String(s == null ? '' : s);
  },

  // Rewards are organiser prose, rendered verbatim, except that a bare number
  // gets " pts" — Home's HomePanels.formatReward rule, so the same challenge
  // reads the same reward on both surfaces. Null for an empty reward.
  formatReward(reward) {
    const s = String(reward == null ? '' : reward).trim();
    if (!s) return null;
    return /^[\d][\d.,]*$/.test(s)
      ? PlatformI18n.t('leaderboard:challenges.points', { count: Number(s.replace(/[.,]/g, '')) || 0, points: s }) : s;
  },

  // "2,000 pts": a points figure with thousands separators. A value that is
  // not a finite number comes back verbatim, so a surprise payload still
  // reads as what the server sent.
  _pts(v) {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n)
      ? PlatformI18n.t('leaderboard:challenges.points', { count: n, points: n.toLocaleString('en-US') })
      : TopochainChallenges.str(v);
  },

  // The summary's points (the Semi design): what the viewer has earned on the
  // challenges in view, from the same `_mine` rows the cards' green points
  // read. Null when there are no rows to read (signed out, or before the
  // personal read lands), so the summary says the count alone rather than a
  // "0 pts" it cannot know.
  _earnedPoints(challenges) {
    const mine = TopochainChallenges._mine;
    if (!mine || !mine.size) return null;
    let earned = 0;
    for (const c of Array.isArray(challenges) ? challenges : []) {
      const m = mine.get(Number(c && c.id)) || null;
      earned += Math.max(0, Number(m && m.activities_total) || 0);
    }
    return earned;
  },

  // href-safe URL: only http(s) links are ever rendered as a real anchor.
  // This is the ONE guard React does not make redundant. Rendering through a
  // component stops attribute breakout for free, but it does NOT stop a
  // `javascript:`-scheme href, which executes on click with no markup
  // injection needed at all. Every cta/mobile_cta link in this file must
  // go through this before it can reach an `href`; anything that isn't
  // http(s) renders as plain text instead of a clickable link.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  // The challenge template's illustration, as the card and the page are
  // handed it: a slug of the registry's SHAPE, else null. This file cannot
  // import frontend/src/lib/challenge-illustrations.ts — it stays an
  // import-free classic script (see tests/challenge-deep-link.test.js) — so it
  // checks only the shape the server already checks, and the components
  // resolve it (a built-in by MEMBERSHIP, an admin upload by its `u-` slug).
  // Nothing here builds a path from it.
  ILLUSTRATION_SLUG: /^[a-z0-9][a-z0-9-]{0,63}$/,
  _illustrationOf(cp) {
    const slug = cp && cp.illustration;
    return typeof slug === 'string' && TopochainChallenges.ILLUSTRATION_SLUG.test(slug) ? slug : null;
  },

  // An uploaded illustration's tone, which the server sends beside the slug
  // (null for a built-in, which carries its own). Again only its SHAPE: a
  // lowercase word of the length a tone name has. The registry decides
  // whether it is one of its TONES and draws an unknown one on gray, so a
  // tone added there needs no change here.
  ILLUSTRATION_TONE: /^[a-z]{3,10}$/,
  _illustrationToneOf(cp) {
    const tone = cp && cp.illustration_tone;
    return typeof tone === 'string' && TopochainChallenges.ILLUSTRATION_TONE.test(tone) ? tone : null;
  },

  // The fetch init a re-read uses, as lib/live-reads.ts's FRESH: the service
  // worker waits for the network instead of answering from its saved copy
  // (public/sw.js, wantsFreshAnswer). Spelled here because this file stays
  // import-free (see _illustrationOf).
  FRESH: Object.freeze({ cache: 'no-cache' }),

  async fetchJson(url, init) {
    try {
      const res = await (init ? fetch(url, init) : fetch(url));
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: res.ok, data: null };
      }
      try {
        return { status: res.status, ok: res.ok, data: await res.json() };
      } catch {
        return { status: res.status, ok: res.ok, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  open() {
    TopochainChallenges._open = true;
    TopochainChallenges._renderShell();
    // The event bar owns the selection; re-render whenever it CHANGES.
    // Not on every notification: the bar also notifies once at the end of
    // its own initial loadEvents(), and that one carries the same event
    // this pane already loaded. Treating it as a change tore down whatever
    // was on top of the grid a beat after it opened — which is how the
    // #982 deep link ended up rendering the right detail panel and then
    // closing it unprompted, and would do the same to an overlay the user
    // opened by hand.
    if (window.TopochainEventContext?.onChange) {
      TopochainChallenges._unsub = TopochainEventContext.onChange(() => {
        if (!TopochainChallenges._open) return;
        if (TopochainChallenges._eventId() === TopochainChallenges._loadedEventId) {
          // The same event — most often the bar's own notification once its
          // event list lands. Nothing to reload, nothing to close and, since
          // the cards no longer read the event's end, nothing to redraw.
          // Except a list that answered with no event at all: the skeleton
          // that waited for it becomes the empty state (polish N11).
          if (TopochainChallenges._loadedEventId == null && TopochainChallenges._challengesLoading) {
            TopochainChallenges.loadChallenges();
          }
          return;
        }
        TopochainChallenges.closeChallengeDetail();
        TopochainChallenges.loadChallenges();
      });
    }
    if (!TopochainChallenges._hashListener && window.addEventListener) {
      TopochainChallenges._hashListener = (e) => TopochainChallenges._onHashChange(e);
      window.addEventListener('hashchange', TopochainChallenges._hashListener);
    }
    TopochainChallenges._watchLiveReads();
    // An acknowledged app-visit upload (#5235): the visit that completes a
    // "Try apps" challenge is often sent as the person leaves the app, at the
    // same moment this read runs, so it can be answered before the credit
    // lands — and after that nothing re-read until a reload. The upload
    // announces itself on document once it is acknowledged, so the grid reads
    // again then and the bar moves on its own.
    if (!TopochainChallenges._activityListener
        && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      TopochainChallenges._activityListener = () => {
        if (!TopochainChallenges._open) return;
        if (TopochainChallenges._challengesLoading) {
          TopochainChallenges._rereadQueued = true;
          return;
        }
        TopochainChallenges.loadChallenges({ fresh: true });
      };
      document.addEventListener('sv:app-activity-recorded', TopochainChallenges._activityListener);
    }
    TopochainChallenges.loadChallenges();
  },

  // Live reads (#3985, lib/live-reads.ts): while the pane is open, coming
  // back to the tab after a while, the socket reconnecting or the browser
  // coming back online re-reads the challenges and the viewer's own rows, so
  // a challenge finished elsewhere shows its new count without a reload.
  // The service worker's corrections already reach loadChallenges through
  // App.refreshActiveScreen, so this watcher claims no reads of its own.
  _watchLiveReads() {
    if (TopochainChallenges._unwatchLive) return;
    const live = window.UsernodeReact && window.UsernodeReact.liveReads;
    if (!live || typeof live.watch !== 'function') return;
    TopochainChallenges._unwatchLive = live.watch(() => {
      if (!TopochainChallenges._open) return undefined;
      return TopochainChallenges.loadChallenges({ fresh: true });
    });
  },

  close() {
    TopochainChallenges._open = false;
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._detailHash = null;
    if (TopochainChallenges._hashListener && window.removeEventListener) {
      window.removeEventListener('hashchange', TopochainChallenges._hashListener);
    }
    TopochainChallenges._hashListener = null;
    if (TopochainChallenges._activityListener
        && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('sv:app-activity-recorded', TopochainChallenges._activityListener);
    }
    TopochainChallenges._activityListener = null;
    // An unresolved queued re-read dies with the screen, like _pendingDeepLink.
    TopochainChallenges._rereadQueued = false;
    // An unresolved deep link dies with the screen. Keeping it would make a
    // much later, unrelated visit to this pane pop an overlay the user
    // never asked for.
    TopochainChallenges._pendingDeepLink = null;
    if (TopochainChallenges._unsub) {
      TopochainChallenges._unsub();
      TopochainChallenges._unsub = null;
    }
    if (TopochainChallenges._unwatchLive) {
      TopochainChallenges._unwatchLive();
      TopochainChallenges._unwatchLive = null;
    }
  },

  _eventId() {
    return window.TopochainEventContext
      ? TopochainEventContext.eventId : null;
  },

  // ── Shell ────────────────────────────────────────────────────────────

  // No title and no event picker of its own: the Leaderboard screen shell
  // titles the page, the tab strip above says "Challenges", and the shared
  // event bar (TopochainEventContext) owns the picker + hero.
  //
  // The grid host and the detail page's root are ./challenges-pane.tsx's
  // markup now, so all this does is announce that the pane is open. It still
  // clears the page, exactly as re-writing the root's innerHTML did: close()
  // leaves `_detailChallenge` null but never took the `hidden` class off, and
  // it was this rebuild that re-hid it on the next open.
  _renderShell() {
    TopochainChallenges._store?.set({ mounted: true, detail: null });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  // `fresh` (a pull, a correction, a live re-read) asks the network for the
  // current answer rather than the service worker's saved copy, and when the
  // same event's grid is already up it re-reads in place (_reread) instead
  // of blanking the cards to a skeleton first.
  async loadChallenges({ fresh = false } = {}) {
    const eventId = TopochainChallenges._eventId();
    if (fresh && eventId != null && eventId === TopochainChallenges._loadedEventId
        && TopochainChallenges._challenges.length && !TopochainChallenges._challengesLoading
        && !TopochainChallenges._challengesError) {
      return TopochainChallenges._reread(eventId);
    }
    const init = fresh ? TopochainChallenges.FRESH : undefined;
    // The event `_challenges` reflects (or is being fetched for). The
    // onChange subscriber above compares against it to tell a real event
    // switch apart from a redundant re-notification.
    TopochainChallenges._loadedEventId = eventId;
    if (eventId == null) {
      TopochainChallenges._challenges = [];
      // Polish N11: before the events list's first answer there is no event
      // YET, which is a wait, not "No challenges right now." (it flashed
      // for a frame before the skeleton on a cold visit). Once the list has
      // answered, a null id is the real empty state.
      TopochainChallenges._challengesLoading = !!window.TopochainEventContext
        && TopochainEventContext._resolved !== true;
      TopochainChallenges._challengesError = null;
      TopochainChallenges._mine = new Map();
      TopochainChallenges._onboarding = null;
      // Nothing to re-read for an event-less pane: a queued acknowledgement
      // waits for a read that can actually answer.
      TopochainChallenges._rereadQueued = false;
      TopochainChallenges._renderGrid();
      return;
    }

    TopochainChallenges._challengesLoading = true;
    TopochainChallenges._challengesError = null;
    TopochainChallenges._mine = new Map();
    TopochainChallenges._onboarding = null;
    // Drop the previous event's cards while resolving this viewer's gate.
    TopochainChallenges._challenges = [];
    TopochainChallenges._renderGrid();

    const seq = ++TopochainChallenges._listSeq;
    const res = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`, init
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId
        || seq !== TopochainChallenges._listSeq) return;

    TopochainChallenges._challengesLoading = false;
    if (res.ok && res.data?.success && Array.isArray(res.data.data)) {
      TopochainChallenges._challenges = res.data.data;
      TopochainChallenges._onboarding = res.data.onboarding || null;
    } else {
      TopochainChallenges._challenges = [];
      TopochainChallenges._challengesError = (res.data && res.data.error)
        || PlatformI18n.t('leaderboard:challenges.loadFailed');
    }
    TopochainChallenges._renderGrid();
    // Decorations land in a second pass so the grid never waits on them.
    TopochainChallenges._loadMine(eventId, init);
    // An acknowledged app-visit upload arrived while this first load was out
    // (#5235): take its re-read now, once, in place — the cards stay up and a
    // failed read keeps them (_reread). A first load that FAILED keeps the
    // flag cleared without one: re-reading over an error state would leave
    // _challengesError disagreeing with a cards grid, and the next
    // acknowledgement or opening reads again anyway.
    if (TopochainChallenges._rereadQueued) {
      TopochainChallenges._rereadQueued = false;
      if (res.ok && res.data?.success && Array.isArray(res.data.data)) {
        void TopochainChallenges._reread(eventId);
      }
    }
  },

  // A re-read of the grid already on screen (#3985). The cards stay up while
  // it runs, and a failed read leaves them as they are rather than trading
  // real numbers for an error. An open detail page keeps its row object (the
  // block-production read is fenced on it) and takes the fresh fields onto
  // it, so its count moves with the card's.
  async _reread(eventId) {
    const seq = ++TopochainChallenges._listSeq;
    const res = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`, TopochainChallenges.FRESH
    );
    if (!TopochainChallenges._open || TopochainChallenges._eventId() !== eventId
        || TopochainChallenges._loadedEventId !== eventId
        || seq !== TopochainChallenges._listSeq) return;
    if (!(res.ok && res.data?.success && Array.isArray(res.data.data))) return;
    const open = TopochainChallenges._detailChallenge;
    TopochainChallenges._challenges = res.data.data.map((row) => (
      open && row && Number(row.id) === Number(open.id) ? Object.assign(open, row) : row
    ));
    TopochainChallenges._onboarding = res.data.onboarding || null;
    TopochainChallenges._store?.set({ grid: TopochainChallenges.gridView(TopochainChallenges._ordered()) });
    if (open) TopochainChallenges._renderDetailOverlay();
    await TopochainChallenges._loadMine(eventId, TopochainChallenges.FRESH);
  },

  // Your own points per challenge, from the session-authed web read. Purely
  // additive: any failure (401 signed out, 422, network) leaves the grid as
  // rendered above — no error banner, no retry.
  async _loadMine(eventId, init) {
    if (!TopochainChallenges._challenges.length) return;
    const seq = ++TopochainChallenges._mineSeq;
    const { ok, data } = await TopochainChallenges.fetchJson(
      `/challenges-api/challenges?season_event_id=${encodeURIComponent(eventId)}`, init
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId
        || seq !== TopochainChallenges._mineSeq) return;
    // The /challenges-api envelope is { success, data } like /api/v4.
    const rows = (ok && data && Array.isArray(data.data)) ? data.data : null;
    if (!rows) return;
    const mine = new Map();
    for (const r of rows) {
      if (r && r.id != null) mine.set(Number(r.id), r);
    }
    TopochainChallenges._mine = mine;
    TopochainChallenges._renderGrid();
    // The detail page reads the viewer's own row too.
    if (TopochainChallenges._detailChallenge) TopochainChallenges._renderDetailOverlay();
  },

  // ── Challenge grid ───────────────────────────────────────────────────

  // Is this challenge organiser-FINISHED? The public row is the source of
  // truth (see the file header's COMPLETION note); the personalization row
  // is only a fallback, so a stale/older public payload still gets the chip
  // for a signed-in viewer rather than silently losing it.
  _isDone(c) {
    // Onboarding is per-user progress. `completed` remains the organiser's
    // archive flag for older challenge lists that have no progress payload.
    if (c?.progress) return c.progress.done === true;
    if (c && c.completed === true) return true;
    const m = TopochainChallenges._mine.get(Number(c && c.id)) || null;
    return !!(m && m.completed === true);
  },

  // ── Groups (the Semi design, 2026-10-16) ────────────────────────────
  //
  // Three, in this order, each only when it holds a card:
  //   first  First challenges — the open ONBOARDING ones, what a newcomer
  //          does first.
  //   next   Next challenges — every other open one, whatever its category.
  //   done   Done — every finished one, at the end, so the grid leads with
  //          what is left to do.
  // A challenge's category is its card label (`card_preview.label`). The
  // keys are not the headings: ids (`tc-se-group-<key>`) and tests name the
  // keys, so a heading can change without them.
  GROUPS: {
    first: { key: 'first', heading: 'leaderboard:challenges.heading.first', order: 0 },
    next: { key: 'next', heading: 'leaderboard:challenges.heading.next', order: 1 },
    done: { key: 'done', heading: 'leaderboard:challenges.heading.done', order: 2 },
  },

  _categoryOf(c) {
    const label = c && c.card_preview ? c.card_preview.label : null;
    return String(label == null ? '' : label).trim().toUpperCase();
  },

  // A This week challenge: its count is this week's (the scorer counts per
  // week, Monday to Monday UTC), so its rail says so.
  _isWeekly(c) {
    return TopochainChallenges._categoryOf(c) === 'WEEKLY';
  },

  _groupOf(c) {
    const groups = TopochainChallenges.GROUPS;
    if (TopochainChallenges._isDone(c)) return groups.done;
    return TopochainChallenges._categoryOf(c) === 'ONBOARDING' ? groups.first : groups.next;
  },

  // The group first (First challenges, Next challenges, Done), then
  // organiser-featured, then the public payload's order (display_order, then
  // id) — the retired #challenges screen's ordering with the groups in front
  // of it. The group key comes from the PUBLIC row, so the split is final on
  // first paint; `featured` still arrives with the personalization pass, so
  // that lift alone can still re-sort later.
  _ordered() {
    const mine = TopochainChallenges._mine;
    return TopochainChallenges._challenges
      .map((c, i) => ({
        c, i, m: mine.get(Number(c.id)) || null, g: TopochainChallenges._groupOf(c).order,
      }))
      .sort((a, b) => {
        if (a.g !== b.g) return a.g - b.g;
        const af = a.m && a.m.featured === true ? 1 : 0;
        const bf = b.m && b.m.featured === true ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.i - b.i;
      })
      .map((x) => x.c);
  },

  _renderGrid() {
    const store = TopochainChallenges._store;

    if (TopochainChallenges._challengesLoading && !TopochainChallenges._challenges.length) {
      store?.set({ grid: { kind: 'loading' } });
      return;
    }
    // Both terminal empty states retire a pending deep link (#982) on the
    // way out, via the same guards the populated path uses — an empty
    // `ordered` simply matches nothing. Neither state can ever resolve one,
    // and leaving it armed would fire it against whatever event the viewer
    // picks next.
    if (TopochainChallenges._challengesError) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({
        grid: {
          kind: 'error',
          message: TopochainChallenges.str(TopochainChallenges._challengesError),
        },
      });
      return;
    }
    if (!TopochainChallenges._challenges.length && !TopochainChallenges._onboarding) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({ grid: { kind: 'empty' } });
      return;
    }

    const ordered = TopochainChallenges._ordered();
    store?.set({ grid: TopochainChallenges.gridView(ordered) });
    TopochainChallenges._maybeShot(ordered);
    TopochainChallenges._maybeDeepLink(ordered);
  },

  // The populated grid, as a descriptor. `ordered` stays ONE flat array
  // whatever the grouping does: both the cards' `idx` and _maybeShot index
  // into it, so splitting it in two would desynchronise every click from the
  // card it was made for. The groups below therefore carry SLICES of the same
  // numbering, not a re-numbering (_ordered sorts by group first, so each
  // group is contiguous).
  gridView(ordered) {
    const cards = ordered.map((c, i) => TopochainChallenges.cardView(c, i));
    const groups = [];
    ordered.forEach((c, i) => {
      const group = TopochainChallenges._groupOf(c);
      let last = groups[groups.length - 1];
      if (!last || last.key !== group.key) {
        last = { key: group.key, heading: PlatformI18n.t(group.heading), cards: [] };
        groups.push(last);
      }
      last.cards.push(cards[i]);
    });
    const view = {
      kind: 'cards',
      // Always present when the grid has rows (including "0 of 8" and "8 of
      // 8"), so the declared dapp.json check can anchor on
      // #tc-se-challenge-summary whatever the selected event's data is.
      progress: TopochainChallenges._summaryView(ordered),
      groups,
    };
    const onboarding = TopochainChallenges._onboarding;
    if (!onboarding) return view;
    return {
      ...view,
      onboardingEventId: !onboarding.unlocked && !groups.some((g) => g.key === 'first')
        ? onboarding.event_id : null,
      // While the gate is closed: the note, and how many of this event's
      // challenges it hides, the server's additive `hidden_count`, which the
      // pane draws as one locked placeholder after the groups, naming the
      // first few (`hidden_names`) as Home's does. The placeholder says what
      // opens them, so the pane draws the note only without one; a payload
      // without the field (an older server) is 0, which draws no placeholder.
      // Unlocked, nothing hides and there is nothing to say. Since #4635 no
      // server sends a gate summary, so none of this draws.
      ...(onboarding.unlocked ? {} : {
        notice: PlatformI18n.t('leaderboard:challenges.locked.notice'),
        lockedCount: Number(onboarding.hidden_count) || 0,
        lockedNames: Array.isArray(onboarding.hidden_names) ? onboarding.hidden_names : [],
      }),
    };
  },

  // The summary over the grid: "3,500 pts · 4 of 11 done" (./season-progress
  // .tsx draws it), over every challenge on the tab.
  _summaryView(ordered) {
    const list = Array.isArray(ordered) ? ordered : [];
    return {
      done: list.filter((c) => TopochainChallenges._isDone(c)).length,
      total: list.length,
      points: TopochainChallenges._earnedPoints(list),
    };
  },

  _toOnboarding(eventId) {
    if (eventId != null) window.TopochainEventContext?.select(Number(eventId));
  },

  // One card. `idx` is this challenge's position in the flat `ordered` array
  // — the component hands it straight back to _openIdx, which is what the
  // retired `data-idx` attribute did.
  cardView(c, i) {
    const str = TopochainChallenges.str;
    const cp = c.card_preview || {};
    const m = TopochainChallenges._mine.get(Number(c.id)) || null;
    return {
      key: `${c.id}|${i}`,
      idx: i,
      featured: !!(m && m.featured === true),
      // A finished challenge is MARKED, not hidden: it moves to Done and
      // stays fully clickable and at full strength. The done state lives on
      // the rail, which _stateOf decides.
      done: TopochainChallenges._isDone(c),
      label: str(cp.label || ''),
      goal: str(cp.goal || ''),
      // #1914: the challenge kind's icon, the same face Home's block draws
      // (HomePanels.challengeRowView). `ChallengeTile` renders an empty
      // neutral square when this is null, which is what every card on this
      // screen used to get — the payload simply never carried one.
      icon: str(cp.icon || '').trim().slice(0, 8) || null,
      reward: TopochainChallenges.formatReward(cp.reward),
      illustration: TopochainChallenges._illustrationOf(cp),
      illustrationTone: TopochainChallenges._illustrationToneOf(cp),
      ...TopochainChallenges._stateOf(c),
    };
  },

  // The page's line under the points about what counts, from the rule the
  // server says scores it (`counted_by`: { measure, target }), else null.
  //   #3253 A proposal challenge counts only once the change is put to the
  //         vote, which the organiser's task text never said.
  //   #3248 A counted measure stops crediting at its target (the scorer's
  //         `already >= target` cap), so once the viewer is there, say that
  //         more before the end add nothing — while the challenge is open.
  _countNoteOf(c) {
    const by = c && c.counted_by;
    if (!by || typeof by.measure !== 'string') return null;
    if (by.measure === 'PROPOSAL_SENT') {
      return PlatformI18n.t('leaderboard:challenges.countNote.onPropose');
    }
    const cap = Number(by.target);
    const current = c.progress ? Number(c.progress.current) : NaN;
    if (!Number.isInteger(cap) || cap < 1 || !(current >= cap)) return null;
    if (!TopochainChallenges._isOpen(c)) return null;
    const accepted = by.measure === 'PROPOSAL_ACCEPTED';
    const figures = { count: cap, cap: cap.toLocaleString('en-US') };
    // A This week challenge's cap is this week's (the scorer counts per week,
    // and `progress` is this week's credits), so the limit is the week, and
    // it starts again on Monday.
    if (TopochainChallenges._isWeekly(c)) {
      return accepted
        ? PlatformI18n.t('leaderboard:challenges.countNote.weekAccepted', figures)
        : PlatformI18n.t('leaderboard:challenges.countNote.week', figures);
    }
    return accepted
      ? PlatformI18n.t('leaderboard:challenges.countNote.accepted', figures)
      : PlatformI18n.t('leaderboard:challenges.countNote.other', figures);
  },

  // Open right now, by the rule Home's server applies (OPEN_ONLY_WHERE in
  // src/routes/home-panels.js): not marked over by the organiser, and inside
  // its effective schedule window. The public list carries every enabled
  // challenge, so a count note for one that has closed would be news nobody
  // can act on.
  _isOpen(c) {
    if (!c || c.completed === true) return false;
    const eff = c.effective || {};
    const now = Date.now();
    const start = eff.schedule_start ? Date.parse(eff.schedule_start) : NaN;
    const end = eff.schedule_end ? Date.parse(eff.schedule_end) : NaN;
    return !(start > now) && !(end < now);
  },

  // The card's rail: which of the three states a challenge is in, the one
  // line of copy it shows, and how much of the rail is filled.
  //
  //   done      _isDone — the viewer's own `progress.done` when the public row
  //             carries onboarding progress, otherwise the organiser's
  //             `completed` flag. The same meaning the summary tally and the
  //             grouping use, so the rail can never disagree with them.
  //   progress  something credited. For a COUNTED challenge (a target above
  //             one) that is any ledger row, because rows are the count on
  //             both surfaces. For an uncounted one it is POINTS
  //             (activities_total > 0): a zero-point row is not progress
  //             there, which is the Flutter app's hasEarnedPoints rule.
  //   new       everything else, including every card an anonymous visitor
  //             sees that is not done.
  //
  // The fill is a fraction only when the count can honestly be one: a metric
  // with a numeric target above one whose count this read carries. A target
  // of one is a yes/no, and so is a counted metric before personalization
  // lands — both read "Started" with no fill rather than a bar that means
  // nothing. The viewer's points stay on the detail page.
  //
  // BLOCK PRODUCTION IS NO LONGER AN EXCEPTION (#2492). Block scores live in
  // leaderboard snapshots and are never written to the points ledger
  // (src/services/topochain/snapshot-builder.js), so a viewer producing
  // blocks can have zero ledger points. This pane used to answer that by
  // drawing the bare ring with no label and no value — the rail saying
  // nothing it could not see — while Home, which reads the snapshot, showed
  // the real count beside the same challenge. The public row now carries that
  // count itself (src/routes/topochain/public.js resolves it through the same
  // helper Home's panel uses), so the `if (p)` block below answers a block
  // card the way it answers every other one, and the fallback under it says
  // "Not started" rather than nothing at all.
  //
  // Every label is SHORT on purpose, and the words are the board's ("Not
  // started", "Done"). The rail is alone on its row at the card body's full
  // width (~170px on a 320px phone) and truncates rather than wraps; the ring
  // carries the state, so the words never repeat it ("In progress · 3/8"
  // wrapped).
  // PER-VIEWER PROGRESS FIRST. The public row carries `progress`
  // ({ done, current, target }) for the season's onboarding steps, computed
  // server-side by services/topochain/challenge-onboarding.js — including
  // block production, which it reads from snapshots. When it is there, the
  // platform has actually counted, so "Not started" is a fact rather than a
  // guess, and the count and fill come from it. Everything below the
  // `if (p)` block is the fallback for rows without it.
  //
  // A COUNTED RAIL STARTS AT ZERO. Whenever the count is known — a target
  // above one — the card shows it from the first moment ("0/3 Apps tried",
  // with a stub of bar; `counted: true` is what draws it) instead of "Not
  // started", so a challenge with steps is told apart from a yes-or-no one
  // before anyone begins. "Not started" is the yes-or-no challenge's word.
  _stateOf(c) {
    const m = TopochainChallenges._mine.get(Number(c && c.id)) || null;
    const points = m && Number(m.activities_total) > 0 ? Number(m.activities_total) : 0;
    const p = (c && c.progress) || null;
    if (TopochainChallenges._isDone(c)) {
      // What the viewer earned, without the word: the card draws it in the
      // emerald of a finished challenge (the Semi design).
      const earned = points
        ? PlatformI18n.t('leaderboard:challenges.points', { count: points, points: points.toLocaleString('en-US') }) : null;
      return { state: 'done', stateLabel: PlatformI18n.t('leaderboard:challenges.state.done'), fill: 1, counted: false, earned };
    }
    if (p) {
      const target = Number(p.target);
      const current = p.current == null ? 0 : Math.max(0, Number(p.current) || 0);
      if (p.current != null && Number.isFinite(target) && target > 1) {
        const count = Math.min(current, target);
        // The count honours challenge-row overrides (the server COALESCEs
        // metric_type/metric_target), so the unit must too: the personalization
        // row's label is override-aware, the public row's `activity_type` is
        // the template's alone.
        const label = (m && m.metric && m.metric.label)
          || (c.metric && c.metric.label)
          || (c.activity_type && c.activity_type.metric_label);
        return {
          state: count > 0 || points > 0 ? 'progress' : 'new',
          stateLabel: TopochainChallenges._countLabel(c, count, target, label),
          fill: count / target,
          counted: true,
          earned: null,
        };
      }
      if (current > 0 || points > 0) {
        return { state: 'progress', stateLabel: PlatformI18n.t('leaderboard:challenges.state.started'), fill: null, counted: false, earned: null };
      }
      return { state: 'new', stateLabel: PlatformI18n.t('leaderboard:challenges.state.notStarted'), fill: 0, counted: false, earned: null };
    }
    const metric = (m && m.metric) || null;
    const at = (c && c.activity_type) || null;
    // The metric, override-aware from either row: the personalization row's
    // once it lands (never, signed out or on failure), else the public row's
    // `metric`, which is the effective one — so a counted challenge shows its
    // count on first paint and to a signed-out visitor, with the organiser's
    // target rather than the template's. The template's `activity_type` kind
    // is the last resort.
    const src = metric || (c && c.metric) || null;
    const kind = (src && src.kind) || (at && at.metric_type) || null;
    // BLOCK PRODUCTION FALLS THROUGH TO THE ORDINARY WORDS. Everything below
    // counts LEDGER ROWS, which a block challenge never has, so it is read as
    // uncounted here: "Started" once something has paid the viewer points for
    // it, "Not started" otherwise. That is the honest answer for the reads
    // this branch serves — a signed-out visitor and the moment before the
    // list's own `progress` arrives — and it is what Home says too. The real
    // count comes from `progress` above.
    const target = Number(src ? src.target : NaN);
    if (kind && kind !== 'blocks_produced' && Number.isFinite(target) && target > 1) {
      // ROWS are the count, the way Home's server count works (one ledger row
      // per unit), so both surfaces print the same number: a zero-point row is
      // still one of the eight. Points decide only an uncounted challenge.
      const count = Math.min(m && Array.isArray(m.activities) ? m.activities.length : 0, target);
      const label = (src && src.label) || (at && at.metric_label);
      return {
        state: count > 0 || points > 0 ? 'progress' : 'new',
        stateLabel: TopochainChallenges._countLabel(c, count, target, label),
        fill: count / target,
        counted: true,
        earned: null,
      };
    }
    if (points) return { state: 'progress', stateLabel: PlatformI18n.t('leaderboard:challenges.state.started'), fill: null, counted: false, earned: null };
    // Points, not rows: a zero-point ledger row is not a step taken.
    return { state: 'new', stateLabel: PlatformI18n.t('leaderboard:challenges.state.notStarted'), fill: 0, counted: false, earned: null };
  },

  // A counted rail's words: "1/3 Apps tried", or for a This week challenge
  // "0/2 accepted this week", since its count starts again each Monday. The
  // unit is the organiser's metric label, verbatim; without one the rail is
  // the figure alone. One whole message per shape, so a translator places
  // the figure, the unit and "this week" in their own order.
  _countLabel(c, current, target, unit) {
    const weekly = TopochainChallenges._isWeekly(c);
    const values = { current, target, unit: TopochainChallenges.str(unit).trim() };
    if (values.unit) {
      return weekly
        ? PlatformI18n.t('leaderboard:challenges.rail.countThisWeek', values)
        : PlatformI18n.t('leaderboard:challenges.rail.count', values);
    }
    return weekly
      ? PlatformI18n.t('leaderboard:challenges.rail.fractionThisWeek', values)
      : PlatformI18n.t('leaderboard:challenges.rail.fraction', values);
  },

  // A card click, by its index in the flat ordered array. Recomputed rather
  // than closed over: the only thing that can change `_ordered()` is a new
  // `_mine` or a new `_challenges`, and either of those has already pushed a
  // fresh grid descriptor, so the index the component is holding belongs to
  // the array this returns.
  _openIdx(idx) {
    const challenge = TopochainChallenges._ordered()[idx];
    TopochainChallenges.openChallengeDetail(challenge);
    TopochainChallenges._pushDetailHash(challenge);
  },

  // Screenshot-state deep link (`?shot=challenge-detail`): the detail page
  // is interaction-gated, so before/after captures and the declared dapp.json
  // check can't reach it by URL alone. Opens one card once, right after the
  // grid first paints: the first UNFINISHED card when the event has one
  // (#981), which is the better capture either way. Done sorts last, so the
  // first unfinished card is `ordered[0]` whenever there is one; it is still
  // looked up rather than assumed. Scoped to that one param value so a real
  // user's grid never auto-opens a page. Pure UI state — no writes, no env
  // gate.
  _maybeShot(ordered) {
    if (TopochainChallenges._shotFired) return;
    if (!ordered.length) return;
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    if (shot !== 'challenge-detail') return;
    TopochainChallenges._shotFired = true;
    TopochainChallenges.openChallengeDetail(
      ordered.find((c) => !TopochainChallenges._isDone(c)) || ordered[0]
    );
  },

  // ── Challenge deep link (#982) ───────────────────────────────────────

  // Entry point for #leaderboard/challenges/<eventId>[/<challengeId>], the
  // address the profile's completed-challenge rows link to. Called by
  // App._routeLeaderboard BEFORE the pane mounts, so it can only record the
  // intent and point the shared event bar at the right event; the detail
  // overlay opens later, from the render that first paints that event's
  // grid. A bare eventId (no challenge) is a valid, useful address too —
  // it just selects the event.
  openFromHash(eventId, challengeId) {
    const ev = Number.isInteger(eventId) ? eventId : null;
    const ch = Number.isInteger(challengeId) ? challengeId : null;
    if (ev == null && ch == null) return;
    if (ch != null) TopochainChallenges._pendingDeepLink = { eventId: ev, challengeId: ch };
    // select() is a no-op when the event is already the selected one, so
    // this neither reloads nor re-renders in the common "already looking at
    // this event" case — which is exactly why the grid below may already be
    // painted and needs resolving here rather than waiting for a render
    // that will never come.
    if (ev != null && window.TopochainEventContext?.select) {
      TopochainEventContext.select(ev);
    }
    if (TopochainChallenges._open) {
      TopochainChallenges._maybeDeepLink(TopochainChallenges._ordered());
    }
  },

  // Resolve a pending deep link against a freshly painted grid. Consumed
  // ONCE, whether or not the challenge is there: an id that doesn't exist
  // (deleted challenge, hand-edited hash, wrong event) leaves the viewer on
  // the grid with no overlay and no error, which is the honest answer —
  // the challenges they CAN open are all on screen.
  _maybeDeepLink(ordered) {
    const want = TopochainChallenges._pendingDeepLink;
    if (!want) return;
    // Mid-reload the grid still holds the PREVIOUS event's rows (see
    // loadChallenges), and matching against those could open the wrong
    // event's challenge — or, worse, silently burn the link on a list the
    // target was never in. Wait for the render that belongs to it.
    if (TopochainChallenges._challengesLoading) return;
    if (want.eventId != null
        && TopochainChallenges._eventId() !== want.eventId) return;
    TopochainChallenges._pendingDeepLink = null;
    const match = ordered.find((c) => c && Number(c.id) === want.challengeId);
    if (!match) return;
    TopochainChallenges.openChallengeDetail(match);
    // Reached by a history step while the Challenges tab is already showing
    // (a card tap's own push, or forward after back): the address still
    // names this page, so the page owns that entry exactly as a tap would.
    //
    // Not when another section is showing. The router resolves the link
    // BEFORE it switches sections, and that switch replaceStates the address
    // to #leaderboard/challenges — so a page that claimed the address here
    // would read the rewrite as navigating away and close itself in the same
    // event. Such a page owns no entry, like a cold arrival (whose hash the
    // section switch rewrote before the grid was even fetched): its back disc
    // just closes it.
    const section = window.Leaderboard?.section;
    if (section != null && section !== 'challenges') return;
    const hash = `#leaderboard/challenges/${TopochainChallenges._eventId()}/${Number(match.id)}`;
    try {
      if (location.hash === hash) TopochainChallenges._detailHash = hash;
    } catch (err) { /* ignore */ }
  },

  // ── Challenge detail page ───────────────────────────────────────────

  openChallengeDetail(challenge) {
    if (!challenge) return;
    // Already the open page. A card tap opens the page and then pushes its
    // address, and the router answers that push (twice: popstate and
    // hashchange) by resolving the same challenge again; without this each
    // answer would reset the page and re-read its block-production state.
    if (TopochainChallenges._detailChallenge === challenge) return;
    const fromGrid = !TopochainChallenges._detailChallenge;
    TopochainChallenges._detailChallenge = challenge;
    TopochainChallenges._bpState = undefined;
    TopochainChallenges._invites = undefined;
    // The page's visibility IS its descriptor — _renderDetailOverlay
    // publishing a non-null `detail` is what used to be the
    // classList.remove('hidden') on this line. It is a level of the screen,
    // so it opens the way one does: pushed, with the platform header as its
    // nav bar (the pane puts the screen's scroll at the page's top).
    TopochainChallenges._level(() => {
      TopochainChallenges._renderDetailOverlay();
      TopochainChallenges._syncChrome();
    }, fromGrid ? 'push' : 'none');
    if (TopochainChallenges._isBlockProduction(challenge)) TopochainChallenges._loadBpState();
    if (TopochainChallenges._isInvites(challenge)) TopochainChallenges._loadInvites();
  },

  closeChallengeDetail(type = 'none') {
    const wasOpen = !!TopochainChallenges._detailChallenge;
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._detailHash = null;
    if (!wasOpen) {
      TopochainChallenges._store?.set({ detail: null });
      return;
    }
    // Back up a level: the header returns to the screen's own chrome (and the
    // pane returns the grid to where it was scrolled).
    TopochainChallenges._level(() => {
      TopochainChallenges._store?.set({ detail: null });
      TopochainChallenges._syncChrome();
    }, type);
  },

  // A level change, animated the way Settings animates its own ('push' in,
  // 'pop' out); 'none' applies it at once.
  _level(fn, type) {
    if (type && type !== 'none' && window.PlatformUI?.transition) {
      window.PlatformUI.transition(fn, { type });
    } else {
      fn();
    }
  },

  // The platform header IS the page's nav bar, as it is for a Settings section
  // or an app's detail in Browse: while a page is open its chevron points up to
  // the grid and its title reads "Challenge"; back on the grid the screen's
  // own chrome returns ("Leaderboard", the house).
  //
  // Only while the Leaderboard is the screen on show. A page closed by a
  // navigation AWAY must never retitle the screen being entered, and restoring
  // the grid's chrome needs the Challenges tab to be the section showing.
  _syncChrome() {
    const app = window.App;
    if (!app || typeof app.setBackIcon !== 'function' || typeof app.setHeaderTitle !== 'function') return;
    const lb = window.Leaderboard;
    if (lb && typeof lb.isOpen === 'function' && !lb.isOpen()) return;
    const challenge = TopochainChallenges._detailChallenge;
    if (challenge) {
      // "Challenge", not the challenge's own name: the page's large title says
      // which one, and a generic word keeps the bar short and steady.
      app.setBackIcon('arrow', '#leaderboard/challenges');
      app.setHeaderTitle(PlatformI18n.t('leaderboard:challenges.detail.header'));
      return;
    }
    // Any section: the screen names the SECTION you are on, and a page left
    // for another tab must not keep the page's own chevron and word.
    //
    // AN ARROW TO ME, not the house (#2718 review): this screen's three
    // sections are reached from the Profile screen's rows, so there is a
    // level above and the chevron is honest about it. The section's own name
    // comes from App.LEADERBOARD_TITLES, which is the table both entries into
    // this screen read — restating the word here is how the two drift.
    app.setBackIcon('arrow', '#profile');
    app.setHeaderTitle(app._leaderboardTitle?.(lb?.section) || PlatformI18n.t('leaderboard:challenges.detail.headerFallback'));
  },

  // The platform header's back chevron (and Escape), claimed the way Settings
  // and Browse claim it (app.js's #back-btn chain). On the grid it declines, so
  // the chevron's usual destination takes over. On a page:
  //   * a page a card tap opened owns its entry: up to the grid, spending it;
  //   * a page reached from ANOTHER place in the app — a Home challenge card,
  //     another Leaderboard tab — goes back THERE, the rule Settings keeps for
  //     a link from elsewhere (#1565): replacing it with the grid would strand
  //     the viewer a level below where they started. The page closes as the
  //     address moves off it (_onHashChange, or the screen's own exit);
  //   * a cold arrival (a bookmark, ?shot) has nothing of ours below: up to
  //     the grid.
  handleBack() {
    if (!TopochainChallenges._detailChallenge) return false;
    const owned = !!TopochainChallenges._detailHash && location.hash === TopochainChallenges._detailHash;
    let cameFrom = null;
    try { cameFrom = window.App?.previousRoute?.() ?? null; } catch (err) { cameFrom = null; }
    if (!owned && cameFrom != null && window.history?.back) {
      window.history.back();
      return true;
    }
    TopochainChallenges._backFromDetail();
    return true;
  },

  // A card tap gives the page its own address and history entry, so the
  // phone's back gesture (or the browser's) returns to the grid. The page is
  // already open when the router sees the new hash. Without an event id or a
  // numeric challenge id there is no address the router could resolve, so no
  // entry — the page still opens, and its back disc still closes it.
  _pushDetailHash(challenge) {
    const eventId = TopochainChallenges._eventId();
    const ev = eventId == null ? NaN : Number(eventId);
    const id = Number(challenge && challenge.id);
    if (!Number.isSafeInteger(ev) || !Number.isSafeInteger(id)) return;
    const hash = `#leaderboard/challenges/${ev}/${id}`;
    try {
      if (location.hash === hash) return;
      TopochainChallenges._detailHash = hash;
      location.hash = hash;
    } catch (err) { /* no history to push: the page works without it */ }
  },

  // The address moved off the page — the back gesture, the header chevron, a
  // tab, or any other navigation. Close the page.
  //
  // Judged by the address the event ARRIVED at (`newURL`), not only by
  // location.hash: when a challenge link lands while another Leaderboard tab
  // is showing, the router opens the page and then its section switch
  // replaceStates the address to #leaderboard/challenges inside the same
  // dispatch, and that rewrite is not a navigation away.
  _onHashChange(e) {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return;
    let arrived = location.hash;
    if (e && typeof e.newURL === 'string') {
      const at = e.newURL.indexOf('#');
      arrived = at === -1 ? '' : e.newURL.slice(at);
    }
    const own = `#leaderboard/challenges/${TopochainChallenges._eventId()}/${Number(challenge.id)}`;
    if (arrived === own) return;
    if (TopochainChallenges._detailHash && location.hash === TopochainChallenges._detailHash) return;
    TopochainChallenges.closeChallengeDetail('pop');
  },

  // Up from the page — the header chevron (handleBack) and Escape. When the
  // page owns a history entry, going back spends it, so the browser's own back
  // does not land on the same grid a second time. The page closes here first
  // rather than waiting for the hashchange, so going up never depends on that
  // event arriving.
  _backFromDetail() {
    const hash = TopochainChallenges._detailHash;
    TopochainChallenges.closeChallengeDetail('pop');
    if (!hash || location.hash !== hash) return;
    try {
      window.history?.back?.();
    } catch (err) { /* the page is closed already */ }
  },

  // Describes a `detail_modal` CTA, scheme-guarded: only an http(s) link
  // (per safeHref) becomes a real, clickable anchor. Anything else
  // (missing, `javascript:`, a bare string, ...) renders the label as
  // plain text with no href at all — never an anchor whose href
  // an attacker-controlled scheme could turn into script execution. The
  // decision stays here, in the shaping module, precisely so that the
  // renderer has no branch to get wrong: it is handed either a href or not
  // one, and `kind: 'text'` has no href field at all to reach for.
  //
  // AN IN-APP DESTINATION IS A ROUTE, NOT A NEW TAB (#2893). A CTA that names
  // one of the shell's own screens — a bare `#settings/usernode`, or the
  // platform's own origin with that fragment — becomes `kind: 'route'`, whose
  // href is ONLY the fragment and which the pane renders without
  // target="_blank". As a new tab it cold-booted a second document, and in
  // the Homeroom app a target="_blank" tap is handed to the system browser,
  // where there is no native bridge and so no "Homeroom app" section: the
  // block-production challenge's "Open block production settings" landed on
  // the Settings root either way. A fragment cannot carry a scheme, so it
  // needs no safeHref; _inAppRoute admits only the route shape.
  //
  // `challenge` (optional) is the list row the page is for. On a
  // block-production challenge a CTA aimed at bare Settings is aimed at the
  // one section where block production lives: the root has nothing about
  // it, and the button's own label promises the section.
  ctaView(dm, challenge) {
    const label = TopochainChallenges.str(dm.cta_label || dm.cta_button || PlatformI18n.t('leaderboard:challenges.detail.go'));
    if (!dm.cta_link) return null;
    const route = TopochainChallenges._inAppRoute(dm.cta_link);
    if (route) {
      // #6080: the Connect X and GitHub challenge sent people to Connectors,
      // which is where AI tools are set up and has no X or GitHub row. The
      // accounts are linked on Settings › Linked accounts, so a challenge
      // scored by connected accounts that points at Connectors goes there.
      // Only that section is redirected: any other link the organiser wrote,
      // for this challenge or another one, is left as it is.
      if (route === TopochainChallenges.CONNECTORS_ROUTE && TopochainChallenges._isConnectAccounts(challenge)) {
        return {
          kind: 'route',
          href: TopochainChallenges.LINKED_ACCOUNTS_ROUTE,
          label: PlatformI18n.t('leaderboard:challenges.detail.openLinkedAccounts'),
        };
      }
      const href = route === '#settings' && TopochainChallenges._isBlockProduction(challenge)
        ? TopochainChallenges.BLOCK_PRODUCTION_ROUTE : route;
      return { kind: 'route', href, label };
    }
    const href = TopochainChallenges.safeHref(dm.cta_link);
    if (!href) return { kind: 'text', label };
    return { kind: 'link', href, label };
  },

  // Settings › Homeroom app, whose "Homeroom app: block production" group is
  // where block production is asked for (sections/usernode.tsx).
  BLOCK_PRODUCTION_ROUTE: '#settings/usernode',

  // #6080: Settings › Connectors is the MCP servers and AI tools page; the X
  // and GitHub accounts are linked on Settings › Linked accounts.
  CONNECTORS_ROUTE: '#settings/connectors',
  LINKED_ACCOUNTS_ROUTE: '#settings/linked-accounts',

  // A shell hash route: a screen word, optional path segments, an optional
  // query. Nothing that could leave the document or run anything.
  IN_APP_ROUTE: /^#[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._~-]+)*\/?(?:\?[A-Za-z0-9=&._~%-]*)?$/,

  // The platform shell's own hosts, besides whichever one this document is
  // on. Organiser CTA data is stored as ABSOLUTE URLs, and the rows written
  // before the domain move say `https://my.onhomeroom.com/#…` while the shell
  // now runs on app.onhomeroom.com (my. redirects there), so matching only
  // this document's origin would miss every real link. NOT the bare
  // onhomeroom.com: that is the marketing site, not the shell.
  SHELL_HOSTS: ['my.onhomeroom.com', 'app.onhomeroom.com'],

  // The fragment a CTA link names when it points INSIDE the shell, else null:
  // `#route`, `/#route`, or an absolute http(s) URL on this document's host or
  // one of SHELL_HOSTS whose path is the root and whose only address is its
  // fragment. A trailing slash is dropped so `#settings/` reads as `#settings`.
  _inAppRoute(url) {
    if (typeof url !== 'string') return null;
    const s = url.trim();
    let hash = null;
    if (s.startsWith('#')) hash = s;
    else if (s.startsWith('/#')) hash = s.slice(1);
    else if (/^https?:\/\//i.test(s)) {
      let u;
      try { u = new URL(s); } catch { return null; }
      const here = typeof location !== 'undefined' && location ? location.hostname : null;
      const host = u.hostname.toLowerCase();
      const ours = (!!here && host === String(here).toLowerCase() && u.origin === location.origin)
        || (u.protocol === 'https:' && !u.port && TopochainChallenges.SHELL_HOSTS.includes(host));
      if (!ours || u.pathname !== '/' || u.search || !u.hash) return null;
      hash = u.hash;
    }
    if (!hash || !TopochainChallenges.IN_APP_ROUTE.test(hash)) return null;
    return hash.replace(/\/(?=\?|$)/, '');
  },

  // Whether a list row is a block-production challenge: its metric (the
  // signal the server's breakdown route keys on, `blocks_produced`), else
  // its template's metric, else its artwork.
  _isBlockProduction(c) {
    if (!c) return false;
    const kind = (c.metric && c.metric.kind) || (c.activity_type && c.activity_type.metric_type) || null;
    if (kind === 'blocks_produced') return true;
    return !!(c.card_preview && c.card_preview.illustration === 'block-production');
  },

  // Whether a list row is the feedback challenge ("Send useful feedback"),
  // whose count is made of the viewer's own reports (#3186). No metric names
  // it, so the artwork does, the last clue _isBlockProduction takes too.
  _isFeedback(c) {
    return !!(c && c.card_preview && c.card_preview.illustration === 'useful-feedback');
  },

  // Whether a list row is scored by the invite measure ("Invite 3 people"):
  // the server's `counted_by` names the rule's measure, the same key the
  // breakdown route and the invites route key on.
  _isInvites(c) {
    const by = c && c.counted_by;
    return !!(by && by.measure === 'INVITES_JOINED');
  },

  // Whether a list row is scored by connected accounts ("Connect X and
  // GitHub"): the server's `counted_by` names the rule's measure, the same
  // key _isInvites keys on.
  _isConnectAccounts(c) {
    const by = c && c.counted_by;
    return !!(by && by.measure === 'CONNECT_ACCOUNTS');
  },

  // ── The block-production step (#2493) ───────────────────────────────
  //
  // The block-production challenge's CTA used to be one link to Settings ›
  // Homeroom app. A browser has no such section (it fell back to the Settings
  // root), and in the app it is a long page with block production near the
  // bottom — while what the viewer needs depends on where THEY are: without a
  // wallet the first step is to request one; with one, delegation is the
  // default, and producing on the phone itself exists only in the Android app
  // (off on iOS since v4, see NativeChrome.decideFirstRunSheet) and comes with
  // a background service and battery cost. So the page reads the same
  // session-authed queue state Settings' card reads and draws that step in
  // place of the generic link.
  //
  // The environment below is a PRESENTATION hint only. The request is the
  // existing POST /challenges-api/bp/request, keys are released by an admin,
  // and delegation is the native wallet's own screen: nothing here decides
  // what the viewer may do.

  // Where this page is drawn. `native` is the Homeroom app's bridge (exactly
  // `true`, as everywhere else); `android` needs it too, because the kit's
  // platform skin is a user-agent guess that says 'android' for Chrome on an
  // Android phone, which cannot produce blocks. `wallet` is the app's wallet
  // app's wallet sheet being able to manage delegation: the row is offered
  // (`_visible`, every native top frame) AND the bridge has `manageStaking`
  // (`_stakingSupported`, v4+), so the button never opens a sheet with no
  // delegation controls in it. The sheet itself handles a wallet whose setup
  // is still running (its Retry).
  _bpEnv() {
    const w = typeof window !== 'undefined' ? window : {};
    const native = !!(w.usernode && w.usernode.isNative === true);
    const android = native && !!(w.unNative && w.unNative.platform === 'android');
    const ws = w.WalletSheet;
    const wallet = native && !!(ws && ws._visible === true && ws._stakingSupported === true
      && typeof ws.openFromRow === 'function');
    return { native, android, wallet };
  },

  // The step for a queue state and environment. Pure, so the tests pin it.
  blockProductionStep(state, env, requesting = false) {
    const e = env || {};
    if (state === undefined) return { step: 'checking' };
    if (!state) {
      return {
        step: 'error',
        title: PlatformI18n.t('leaderboard:bp.error.title'),
        text: PlatformI18n.t('leaderboard:bp.error.text'),
        action: { label: PlatformI18n.t('leaderboard:bp.error.retry') },
      };
    }
    if (state.bp_released) {
      const onDevice = e.native && e.android ? {
        title: PlatformI18n.t('leaderboard:bp.account.onDevice.title'),
        text: PlatformI18n.t('leaderboard:bp.account.onDevice.text'),
        warning: PlatformI18n.t('leaderboard:bp.account.onDevice.warning'),
      } : null;
      return {
        step: 'account',
        title: PlatformI18n.t('leaderboard:bp.account.title'),
        delegation: {
          title: PlatformI18n.t('leaderboard:bp.account.delegate.title'),
          text: PlatformI18n.t('leaderboard:bp.account.delegate.text'),
        },
        onDevice,
        onDeviceNote: onDevice ? null
          : PlatformI18n.t('leaderboard:bp.account.onDeviceNote'),
        action: e.wallet ? { label: PlatformI18n.t('leaderboard:bp.account.manage') } : null,
        appNote: e.wallet ? null
          : (e.native
            ? PlatformI18n.t('leaderboard:bp.account.appNote')
            : PlatformI18n.t('leaderboard:bp.account.webNote')),
      };
    }
    if (state.bp_requested) {
      return {
        step: 'pending',
        title: PlatformI18n.t('leaderboard:bp.pending.title'),
        text: PlatformI18n.t('leaderboard:bp.pending.text'),
      };
    }
    if (!state.has_platform_access) {
      return {
        step: 'locked',
        title: PlatformI18n.t('leaderboard:bp.locked.title'),
        text: PlatformI18n.t('leaderboard:bp.locked.text'),
      };
    }
    return {
      step: 'request',
      title: PlatformI18n.t('leaderboard:bp.request.title'),
      text: PlatformI18n.t('leaderboard:bp.request.text'),
      action: {
        label: requesting ? PlatformI18n.t('leaderboard:bp.request.pending') : PlatformI18n.t('leaderboard:bp.request.action'),
        pending: !!requesting,
      },
    };
  },

  async _loadBpState() {
    const challenge = TopochainChallenges._detailChallenge;
    const seq = ++TopochainChallenges._bpSeq;
    let next = null;
    try {
      const res = await window.fetch('/challenges-api/bp/state', { credentials: 'same-origin' });
      const body = res && res.ok ? await res.json() : null;
      next = body && body.success !== false && body.data ? body.data : null;
    } catch { next = null; }
    // Page closed or changed, or a newer read (a reopen, a retry) is in flight.
    if (TopochainChallenges._detailChallenge !== challenge || seq !== TopochainChallenges._bpSeq) return;
    TopochainChallenges._bpState = next;
    TopochainChallenges._renderDetailOverlay();
  },

  // The request step's button. Same endpoint and follow-up as Settings'
  // "Ask to produce blocks" (settings.js _askForBlockProduction).
  async requestBlockProduction() {
    if (TopochainChallenges._bpRequesting) return;
    TopochainChallenges._bpRequesting = true;
    TopochainChallenges._renderDetailOverlay();
    const ui = window.PlatformUI;
    try {
      const res = await window.fetch('/challenges-api/bp/request', {
        method: 'POST', credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.success === false) {
        throw new Error((data && data.error) || PlatformI18n.t('leaderboard:bp.request.failed'));
      }
      TopochainChallenges._bpState = Object.assign({}, TopochainChallenges._bpState || {}, {
        bp_requested: true,
        bp_released: !!(data.data && data.data.bp_released),
      });
      if (ui && ui.toast) ui.toast(PlatformI18n.t('leaderboard:bp.request.sent'));
      // #2960: the Android "Set up your device" sheet waits for exactly this
      // moment; on iOS or an already-answered device it presents nothing.
      const nc = window.NativeChrome;
      if (nc && typeof nc.maybeShowFirstRunPermissions === 'function') {
        nc.maybeShowFirstRunPermissions({ force: true });
      }
    } catch (e) {
      if (ui && ui.toast) ui.toast((e && e.message) || PlatformI18n.t('leaderboard:bp.request.failed'), { error: true });
    } finally {
      TopochainChallenges._bpRequesting = false;
      TopochainChallenges._renderDetailOverlay();
    }
  },

  // The error step's button.
  retryBpState() {
    TopochainChallenges._bpState = undefined;
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadBpState();
  },

  // ── The invite list (#3650) ─────────────────────────────────────────
  //
  // The page's read of who the viewer invited and why each person does or
  // does not count yet. Same lifecycle as _loadBpState above: seq-fenced,
  // guarded against a closed or changed page, null on any failure so the
  // page offers a retry instead of a wrong list.
  async _loadInvites() {
    const challenge = TopochainChallenges._detailChallenge;
    const seq = ++TopochainChallenges._invitesSeq;
    let next = null;
    try {
      const res = await window.fetch(
        `/challenges-api/me/invites?challenge_id=${encodeURIComponent(challenge.id)}`,
        { credentials: 'same-origin' },
      );
      const body = res && res.ok ? await res.json() : null;
      next = body && body.success !== false && body.data ? body.data : null;
    } catch { next = null; }
    if (TopochainChallenges._detailChallenge !== challenge || seq !== TopochainChallenges._invitesSeq) return;
    TopochainChallenges._invites = next;
    TopochainChallenges._renderDetailOverlay();
  },

  // The list's retry link.
  retryInvites() {
    TopochainChallenges._invites = undefined;
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadInvites();
  },

  // The list's descriptor: per person, the status word and its reason.
  // The status WORD groups the server's statuses (Not counted covers two
  // reasons, Waiting two); the reason is the server status's own line.
  invitesView() {
    const data = TopochainChallenges._invites;
    if (data === undefined) return { state: 'loading' };
    if (data === null) return { state: 'error' };
    const people = (data && data.people) || [];
    if (!people.length) return { state: 'ready', people: [] };
    const target = data && Number(data.target);
    return {
      state: 'ready',
      people: people.map((p) => {
        const status = String(p.status || '');
        const word = status === 'counted' ? 'counted'
          : status === 'pending_count' ? 'soon'
            : status === 'over_target' ? 'over'
              : status === 'waiting_access' || status === 'not_accepted' ? 'waiting'
                : status === 'link_off' ? 'wontJoin'
                  : 'notCounted';
        const reason = status === 'over_target' && Number.isInteger(target) && target > 0
          ? PlatformI18n.t('leaderboard:challenges.invites.reason.over_target', { count: target })
          : PlatformI18n.t(`leaderboard:challenges.invites.reason.${status}`);
        return {
          key: String(p.user_id),
          name: p.name || PlatformI18n.t('leaderboard:challenges.invites.someone'),
          word,
          reason,
        };
      }),
    };
  },

  // The account step's button: the app's wallet sheet, whose block-production
  // card holds "Manage delegation" and, on Android, the background-service note.
  openWallet() {
    const ws = window.WalletSheet;
    if (ws && typeof ws.openFromRow === 'function') ws.openFromRow();
  },

  _renderDetailOverlay() {
    if (!TopochainChallenges._detailChallenge) return;
    TopochainChallenges._store?.set({ detail: TopochainChallenges.detailView() });
  },

  // A row an older server sent has no `counts`, and it counts. A change with no
  // usable address is a plain row under the credit's own words. A First
  // challenge's count also holds its credits from an earlier season.
  _creditsOf(mine) {
    const str = TopochainChallenges.str;
    const own = mine && Array.isArray(mine.activities) ? mine.activities : [];
    const earlier = mine && Array.isArray(mine.earlier_activities) ? mine.earlier_activities : [];
    const activities = earlier.length
      ? [...own, ...earlier].sort((a, b) => Date.parse(b.activity_at) - Date.parse(a.activity_at))
      : own;
    return activities.filter((a) => a.counts !== false).map((a) => {
      const c = a.change;
      const linked = c && typeof c.app_slug === 'string' && c.app_slug
        && Number.isInteger(c.session_id) && c.session_id > 0;
      return {
        text: str((linked && c.title) || a.description),
        points: Number(a.points) || 0,
        at: a.activity_at,
        precision: a.activity_time_precision,
        change: linked ? { slug: c.app_slug, sessionId: c.session_id, prNumber: c.pr_number } : null,
      };
    });
  },

  detailView() {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return null;
    const str = TopochainChallenges.str;
    const dm = challenge.detail_modal || {};
    const cp = challenge.card_preview || {};

    // Under the title, the card's points: what the viewer earned on a
    // finished challenge (emerald), their points so far on an open one they
    // have scored on, otherwise the reward on offer. The rail beneath holds
    // the state and nothing else, as on the card.
    const rail = TopochainChallenges._stateOf(challenge);
    const mine = TopochainChallenges._mine.get(Number(challenge.id)) || null;
    const points = mine && Number(mine.activities_total) > 0 ? Number(mine.activities_total) : 0;
    const reward = TopochainChallenges.formatReward(cp.reward);
    let amount = null;
    if (rail.earned) amount = { text: rail.earned, earned: true };
    else if (points) {
      amount = {
        text: PlatformI18n.t('leaderboard:challenges.soFar', { count: points, points: points.toLocaleString('en-US') }),
        earned: false,
      };
    }
    else if (reward) amount = { text: reward, earned: false };

    const bpStep = TopochainChallenges._isBlockProduction(challenge)
      ? TopochainChallenges.blockProductionStep(
        TopochainChallenges._bpState, TopochainChallenges._bpEnv(), TopochainChallenges._bpRequesting)
      : null;

    // The Semi design (2026-10-16): the title, the points, the artwork, the
    // rail, the action and "What counts" — no category eyebrow, deadline,
    // description, Scoring or participants. The organiser's task line is back
    // on the page (#6592): it is the one sentence saying what to do to start
    // and finish, which the page left people guessing at. Cards keep it out.
    return {
      key: str(challenge.id),
      goal: str(cp.goal || ''),
      // The organiser's own what-to-do line, as stored (an override already
      // resolved server-side into card_preview.task). Null when blank, so a
      // challenge without one draws no extra line.
      task: cp.task && str(cp.task).trim() ? str(cp.task).trim() : null,
      amount,
      // Under the points: what the rule counts, when the requirements cannot
      // say it (a proposal counts once it is put to the vote; nothing past a
      // counted measure's cap, a weekly one's this week).
      countNote: TopochainChallenges._countNoteOf(challenge),
      // The same artwork as the card's tile, for the page's well.
      illustration: TopochainChallenges._illustrationOf(cp),
      illustrationTone: TopochainChallenges._illustrationToneOf(cp),
      state: rail.state,
      stateLabel: rail.stateLabel,
      fill: rail.fill,
      counted: !!rail.counted,
      // #3186: on the feedback challenge, the way to what the viewer sent
      // and which of it counted, beside the count that says how many did.
      // A flag, not an href: the page's one computed href stays the guarded
      // CTA, and this link's address is a constant in the pane.
      feedbackLink: TopochainChallenges._isFeedback(challenge),
      // #4036: and, under the rail, what makes a report count. A report on
      // the viewer's own project is filed but never counted here (the
      // scorer's USEFUL_FEEDBACK_SQL), and the count lands on the scorer's
      // schedule after grading; without this line a filed report the rail
      // never moves for read as a counter that failed to sync.
      feedbackNote: TopochainChallenges._isFeedback(challenge)
        ? PlatformI18n.t('leaderboard:challenges.feedback.note')
        : null,
      // #3650: on an invite challenge, the plain-language line under the
      // rail (what makes an invite count) and the per-person list. On any
      // other challenge both are absent, so the page is exactly as it was.
      invitesNote: TopochainChallenges._isInvites(challenge)
        ? PlatformI18n.t('leaderboard:challenges.invites.note')
        : null,
      invites: TopochainChallenges._isInvites(challenge)
        ? TopochainChallenges.invitesView()
        : null,
      // A block-production challenge draws the viewer's step instead of the
      // organiser's link, which could only ever name one destination.
      blockProduction: bpStep,
      cta: bpStep ? null : TopochainChallenges.ctaView(dm, challenge),
      // #3247: the credits behind the count, newest first. Raw fields, never
      // an href: the pane builds the one address a change has.
      credits: TopochainChallenges._creditsOf(mine),
      creditsWeekly: TopochainChallenges._isWeekly(challenge),
      requirements: dm.requirements ? str(dm.requirements) : null,
    };
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount, app.js's
// pull-to-refresh and its #982 deep-link branch (openFromHash)
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainChallenges = TopochainChallenges;

// Every view here holds its words, so a new language builds them again from
// the challenges already loaded.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => {
    if (!TopochainChallenges._open) return;
    TopochainChallenges._renderGrid();
    TopochainChallenges._renderDetailOverlay();
  });
}
