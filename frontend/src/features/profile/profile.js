// Profile screen — the mobile app's native Profile screen absorbed into SV
// (profile-and-settings-to-web migration, NATIVE-BRIDGE.md), extended into
// an EDITABLE profile by issue #982, and reshaped into the navigation
// prototype's Me page: the identity card (picture / display name / bio /
// verified links), three stat cards (merged, kudos, challenges), a "More"
// list and "Your contributions". The rank, points, token allocation and
// per-event breakdown it used to lead with are the Challenges tab's standing
// card now (features/leaderboard/my-standing.js); see ./profile-store.js's
// header for where every other piece went.
//
// ── The three numbers are ONE read ────────────────────────────────────
//
// GET /api/me/summary (src/routes/profile.js) adds up the three subsystems
// the stat cards come from — merged proposals, kudos received, challenges
// done — and returns the newest merged proposals with them. The completed
// COUNT it returns uses the same per-user done rule as
// GET /api/me/challenges/completed, whose history is below.
//
// It deliberately does NOT list completed challenges (#981). It used to,
// from /challenges-api/challenges?season_id=…, and that section was wrong
// on two counts: `challenges.completed` is an ORGANISER flag about the
// challenge ("this one is over"), not "you finished it", so every user saw
// the same list — and season-scoped it ran to ~32 cards, burying the rank,
// token and breakdown blocks this screen actually exists for. That list now
// lives on the Leaderboard screen's Challenges tab, grouped and counted
// per event (features/leaderboard/topochain-challenges.js), which is where the
// rest of the challenge UI already was.
//
// Identity comes from the platform session: since the topochain merge,
// leaderboard participants ARE platform users, so the /me/* routes scope
// to the signed-in session server-side. Native publishes no profile identity.
//
// THE COMPLETED LIST IS THE VIEWER'S OWN. It used to filter the season's
// challenge grid on `c.completed`, which is an ORGANISER flag about the
// challenge ("this one is over") — so every signed-in person saw 28 of
// production's 34 live challenges listed as their own completions, whether
// or not they had ever earned a point. The list now comes from
// GET /api/me/challenges/completed (src/routes/profile.js), which applies
// the same per-user done rule the home Challenges widget uses.
//
// The USERNAME is deliberately not editable here (or anywhere): it is the
// sign-in identifier, the address of the public builder page, and is
// denormalized into apps.admin_usernames from repo dapp.json files. The
// display name is the supported way to change how your name appears.
//
// ── What this file is, after #1191 slice 6 ─────────────────────────────
//
// This module used to BUILD the screen, with createElement and textContent,
// into an unmanaged #profile-root. It no longer touches the DOM at all.
// Conversion 1 of slice 6 made #profile-root React-owned end to end, which the
// island rule requires before the region may hold state: the markup is now
// ./profile-view.tsx, the shaping that decides what that markup says is
// ./profile-store.js, and what is left here is the part that was never about
// the DOM — the fetches, the load-token discipline, the avatar downscale, the
// save order, and the `window.Profile` publication every legacy caller reaches
// this screen through.
//
// `_render()` kept its name and its callers; it is now a store push. Anything
// that called it to repaint after a write still works, and now repaints through
// React instead of rebuilding the subtree.

import {
  profileStore,
  relativeDate,
  safeHref,
  displayNameOf,
  initialOf,
} from './profile-store.js';
import { pushDismissible } from '../../lib/back-stack';
import {
  act as actOnFriend,
  announceFriendsChanged,
  errorMessage as friendErrorMessage,
  FRIENDS_CHANGED_EVENT,
  listFriends,
} from '../friends/api';

const Profile = {
  _open: false,
  _loading: false,
  _targetUsername: null,
  _loadToken: 0,
  // What the screen is showing: { ranking, summary, ownerPublicProfile, … }
  // for the viewer's own profile, or one of the public/signed-out/error
  // shapes. Reset on every open() — see _ownCache for what survives.
  _data: null,

  // The viewer's OWN last loaded profile, kept across open/close so going
  // back to the Me tab paints it at once and refreshes underneath (#2777).
  // The comment on `_data` used to promise exactly this, but open() nulled
  // `_data` first, so every visit showed the skeleton until four requests
  // came back. Keyed by username: a cache for someone else — after a sign-out
  // and a different sign-in in the same page — is never shown. Only the own
  // screen is cached; a public #profile/<name> page always loads fresh, so it
  // can never flash one person's figures under another's name. Rank, points
  // and tokens may be stale for the length of one refresh; that is the trade.
  // { username, data } | null
  _ownCache: null,

  // The avatar change staged by the photo picker. `_pendingAvatar` is a Blob to
  // upload, the string 'remove' to delete, or null for "leave it alone" —
  // nothing reaches the server until Save. The Blob stays here rather than in
  // the store because nothing renders it; only its object URL does, and that is
  // what the store carries.
  _pendingAvatar: null,
  _pendingAvatarUrl: null,

  // THE EDITOR'S CLAIM ON THE BACK BUTTON, and what Back leaves behind
  // (QA 2026-09-24 Q16). Back used to walk past the open editor to the entry
  // under Profile, so it closed the card AND left the screen, and a half-typed
  // bio went with it. The editor claims the press the way the dialogs do
  // (lib/back-stack.ts), and Back closes the card and nothing else.
  //
  // What was typed survives that close: `_draft` holds the name and bio until
  // the editor opens again, which seeds its fields from it. Only Back and the
  // kit's own dismiss (the backdrop, Escape) keep it; Cancel, Save and leaving
  // the screen are decisions, and discard it. A staged photo is not kept: it
  // shows on the identity card as soon as it is staged, which would read as
  // saved. `_draftSource` is the open editor's own read of its fields.
  _releaseBack: null,
  _draft: null,
  _draftSource: null,

  // Field limits, kept in step with src/routes/profile.js. The server is
  // the authority; these exist so the sheet can show a counter and stop an
  // over-long value before a round trip.
  MAX_DISPLAY_NAME: 40,
  MAX_BIO: 280,
  // Client-side downscale budget. The server caps the upload at 1 MB and
  // does no image processing of its own (the platform ships no image
  // decoder), so the shrink has to happen here — the same canvas/toBlob
  // loop screenshot-select.js uses for issue screenshots.
  AVATAR_MAX_PX: 512,
  AVATAR_MAX_BYTES: 500 * 1024,

  // True once the ?shot=profile-edit deep link has opened the sheet, so a
  // later refresh landing doesn't reopen it.
  _shotFired: false,

  // ?shot=profile-long-bio — the reviewable state for issue #1612. A bio with
  // no space in it is the case that used to spill out of the identity card,
  // and no real account has one, so the screenshots and the declared test
  // could never reach it by navigating. Display only: it substitutes the bio
  // in the store snapshot the card renders from and writes nothing, so it is
  // deliberately NOT staging-gated (an env-gated link would starve the
  // production-side "before" shot forever) and deliberately not visible to
  // ./profile-edit-sheet.tsx, which reads `_user()` and could save it.
  LONG_BIO_SHOT:
    'Staging demo bio: https://example.com/app/'
    + 'a-very-long-unbroken-link-with-no-spaces-in-it-at-all/dev/proposals/1612'
    + ' and ThisIsOneUnbrokenWordThatIsFarWiderThanTheProfileCardCouldEverBe.',

  isOpen() { return Profile._open; },

  // Re-exported so the shaping has ONE home (./profile-store.js) while the
  // legacy `window.Profile` surface keeps every method it published.
  _safeHref: safeHref,
  _relativeDate: relativeDate,
  _displayName() { return displayNameOf(Profile._user()); },
  _initial() { return initialOf(Profile._user()); },

  _user() { return (typeof window !== 'undefined' && window.App && App.user) || {}; },

  // `?demo=1` rides the summary read, as it does every staging read with a
  // demo overlay: chat_sessions is staging:private, so without it a preview's
  // Me has nothing merged to show (GET /api/me/summary's withDemoSummary).
  _demoQuery() {
    try {
      return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    } catch (_) {
      return '';
    }
  },

  async open(targetUsername = null) {
    // #3186: `#profile?feedback` asks for the "Your feedback" list. Taken
    // before the early return below, so the second of a double entry cannot
    // find the address already rewritten and drop the request. Someone else's
    // page is not where the list belongs, so going there closes it rather
    // than leaving it to come back over the next visit to your own.
    if (targetUsername) {
      Profile._feedbackRequested = false;
      Profile._dismissFeedback();
    } else if (Profile._takeFeedbackRoute()) Profile._feedbackRequested = true;
    // One entry into #profile reaches here TWICE: popstate and hashchange both
    // run restoreFromHash, and the second run finds the screen mounted and
    // goes through App._routeMountedProfile, which opens it again. That used
    // to start a second full load while the first was still in flight —
    // every request of the screen twice per visit, the two all-user ranking
    // queries slowing each other down (#2777). Same target, load already
    // running: that load is the answer.
    if (Profile._open && Profile._loading
        && (targetUsername || null) === Profile._targetUsername) {
      return;
    }
    Profile._open = true;
    Profile._targetUsername = targetUsername || null;
    Profile._data = Profile._targetUsername ? null : Profile._cachedOwnData();
    Profile._render();
    // A cached profile is on screen already, so the list can open over it now
    // rather than after four requests; otherwise it waits for the load.
    Profile._maybeOpenFeedback();
    const token = ++Profile._loadToken;
    await Profile._load(token);
    if (Profile._open && token === Profile._loadToken && !Profile._targetUsername) {
      Profile._maybeOpenShot();
      Profile._maybeOpenFeedback();
    }
  },

  // The cached own profile, only if it belongs to whoever is signed in now.
  _cachedOwnData() {
    const cache = Profile._ownCache;
    const username = Profile._user().username;
    if (!cache || !username || cache.username !== username) return null;
    return cache.data;
  },

  close() {
    Profile._open = false;
    Profile._targetUsername = null;
    Profile._loadToken++;
    Profile._feedbackRequested = false;
    Profile._dismissSheet();
    Profile._dismissFeedback();
    Profile._render();
  },

  async _fetchJson(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) {
      // Carry the status on the Error so _load() can tell "you are not
      // signed in" (401 from requireSessionUser) apart from a genuine
      // failure. The /challenges-api/me/* routes are session-scoped
      // (src/routes/topochain/mobile.js), so an anonymous visitor hits
      // 401 on every one of them — that is a state to render, not an
      // error to apologise for.
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    // The leaderboard API wraps every response in { success, data }.
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success === false) throw new Error('API error');
      return body.data;
    }
    return body;
  },

  async _load(token = ++Profile._loadToken) {
    Profile._loading = true;
    try {
      if (Profile._targetUsername) {
        const target = Profile._targetUsername;
        try {
          // `?demo=1` rides this read too (#2386): the staging fixtures
          // for the friend button live behind it (routes/profiles.js).
          const payload = await Profile._fetchJson(
            `/api/public/profiles/${encodeURIComponent(target)}${Profile._demoQuery()}`
          );
          if (token !== Profile._loadToken || target !== Profile._targetUsername) return;
          // `friendship` is the SIGNED-IN viewer's own relationship with this
          // person (#2386) — absent for an anonymous read and on your own page.
          Profile._data = {
            publicProfile: payload.profile,
            publicFriendship: payload.friendship || null,
          };
        } catch (err) {
          if (token !== Profile._loadToken || target !== Profile._targetUsername) return;
          Profile._data = err && err.status === 404
            ? { publicNotFound: true }
            : { error: true };
        }
        if (Profile._open && token === Profile._loadToken) Profile._render();
        return;
      }
      // Cheap pre-check: the SPA boots anonymously now (auth-screens.js),
      // so skip the round-trip entirely when there is no session at all.
      // The 401 branch below still covers a session that expired while
      // the screen was open.
      if (window.App && !App.user) {
        Profile._ownCache = null;
        Profile._data = { signedOut: true };
        return;
      }
      // The username this load is FOR, captured before any await: the cache
      // entry is written under it, so a sign-in that changes mid-flight can
      // never file one person's figures under another's name.
      const username = Profile._user().username || null;
      // The ranking is only the "Challenges & standings" row's second line
      // now ("Season 3 · rank #3 · 2 of 7 done"), scoped to the active
      // season by the server (`season_id=active`, #2777). It still decides
      // signed-out-ness: the /challenges-api/me/* reads are session-scoped
      // and answer 401 to a lapsed session, which the catch below turns into
      // the sign-in prompt.
      //
      // The summary is the three stat cards and Your contributions, and the
      // public-profile state backs the Edit profile sheet's "Public page".
      // Both are non-fatal: a failure leaves the rest of the screen intact
      // (the cards read "–", the list says nothing arrived).
      //
      // The friends lists (#2386) back the private Friends section. Non-fatal
      // like the two above: a failure draws "could not be loaded" there and
      // leaves the rest of the screen alone.
      //
      // The viewer's own feedback (#3186) is the "Your feedback" row's line
      // and the list it opens, so opening the list costs no request of its
      // own. Non-fatal the same way: the row falls back to its plain line and
      // the list says it could not be loaded.
      const demo = Profile._demoQuery();
      const [ranking, summary, ownerPublicProfile, friends, feedback] = await Promise.all([
        Profile._fetchJson('/challenges-api/me/ranking?season_id=active'),
        Profile._fetchJson(`/api/me/summary${demo}`).catch(() => null),
        Profile._fetchJson('/api/me/public-profile').catch(() => null),
        // The friends client carries `?demo=1` itself.
        listFriends().catch(() => null),
        Profile._fetchJson(`/api/feedback/mine${demo}`).catch(() => null),
      ]);

      // Written before the staleness check: a load that finished after the
      // screen was left, or overtaken by a public profile, is still the
      // freshest copy of this user's own profile for the next visit.
      const data = {
        season: ranking && ranking.scope === 'season'
          ? { season_id: ranking.season_id, name: ranking.season_name }
          : null,
        ranking,
        summary,
        ownerPublicProfile,
        friends,
        feedback,
      };
      if (username) Profile._ownCache = { username, data };
      if (token !== Profile._loadToken || Profile._targetUsername) return;
      Profile._data = data;
    } catch (err) {
      // A 401 means the session is gone whichever load noticed it, so the
      // cached copy goes even when this load has been overtaken.
      if (err && err.status === 401) Profile._ownCache = null;
      if (token !== Profile._loadToken) return;
      if (err && err.status === 401) {
        // Not signed in (or the session lapsed) — a normal state, not a
        // fault. Replace any stale data so we never show one user's
        // profile after their session ends.
        Profile._data = { signedOut: true };
      } else {
        console.warn('[profile] load failed:', err);
        if (!Profile._data) Profile._data = { error: true };
      }
    } finally {
      if (token === Profile._loadToken) Profile._loading = false;
    }
    if (Profile._open && token === Profile._loadToken) Profile._render();
  },

  // ── rendering ─────────────────────────────────────────────────────────
  //
  // One store push. Every branch this used to build by hand — the loading
  // line, the signed-out prompt with its #login link, the connection-error
  // copy, the "This profile is unavailable" 404, the public card and the
  // owner's own screen — is now a `kind` on the view ./profile-store.js
  // derives, rendered by ./profile-view.tsx. The order of those checks is
  // load-bearing and lives in `buildProfileView`: signedOut is tested BEFORE
  // error, or a lapsed session reads as a network fault.

  _render() {
    profileStore.set({
      open: Profile._open,
      data: Profile._data,
      user: Profile._shotUser(),
      pendingAvatarUrl: Profile._pendingAvatarUrl,
      pendingRemove: Profile._pendingAvatar === 'remove',
    });
  },

  // The token figure's Reveal and the terms review moved with the figure:
  // features/leaderboard/my-standing.js (MyStanding.revealTokens /
  // reviewTerms), under the same storage key, so an allocation revealed here
  // stays revealed there.

  // ── friends (#2386) ─────────────────────────────────────────────────
  //
  // Accept / Decline on the own profile's Friends section. The answer goes
  // through the same client the person page's button uses. The row moves at
  // once, and the change announcement then re-reads the lists
  // (_refreshFriends, below): GET /api/friends is the one authority on who is
  // a friend, and an accept can race the other person's cancel.

  async answerFriendRequest(userId, accept) {
    const id = Number(userId);
    const state = profileStore.get();
    if (!Number.isSafeInteger(id) || id <= 0 || state.friendsPending) return;
    const lists = Profile._data && Profile._data.friends;
    const row = ((lists && lists.incoming) || []).find((p) => Number(p.id) === id);
    profileStore.set({ friendsPending: id, friendsStatus: '' });
    try {
      const next = await actOnFriend(id, accept ? 'accept' : 'decline');
      if (lists && Profile._data && Profile._data.friends === lists) {
        const incoming = lists.incoming.filter((p) => Number(p.id) !== id);
        const friends = next === 'friends' && row
          ? [...lists.friends, { ...row, since: new Date().toISOString() }]
            .sort((a, b) => String(a.username).toLowerCase().localeCompare(String(b.username).toLowerCase()))
          : lists.friends;
        Profile._data = { ...Profile._data, friends: { ...lists, incoming, friends } };
        Profile._render();
      }
      announceFriendsChanged();
    } catch (err) {
      profileStore.set({ friendsStatus: friendErrorMessage(err, row ? row.username : 'them') });
    } finally {
      profileStore.set({ friendsPending: null });
    }
  },

  // Cancel a request you sent, from the Sent requests group. Withdrawn at
  // once here; the person it went to loses it from their bell and their own
  // list, the way a request that was never sent would look.
  async cancelFriendRequest(userId) {
    const id = Number(userId);
    const state = profileStore.get();
    if (!Number.isSafeInteger(id) || id <= 0 || state.friendsPending) return;
    const lists = Profile._data && Profile._data.friends;
    const row = ((lists && lists.outgoing) || []).find((p) => Number(p.id) === id);
    profileStore.set({ friendsPending: id, friendsStatus: '' });
    try {
      await actOnFriend(id, 'cancel');
      if (lists && Profile._data && Profile._data.friends === lists) {
        const outgoing = (lists.outgoing || []).filter((p) => Number(p.id) !== id);
        Profile._data = { ...Profile._data, friends: { ...lists, outgoing } };
        Profile._render();
      }
      announceFriendsChanged();
    } catch (err) {
      profileStore.set({ friendsStatus: friendErrorMessage(err, row ? row.username : 'them') });
    } finally {
      profileStore.set({ friendsPending: null });
    }
  },

  // Re-read the lists while the viewer's OWN profile is on screen — after an
  // answer here, or any friend change elsewhere on the page (the person
  // page's button, a notification's Accept). Anywhere else it is a no-op.
  async _refreshFriends() {
    if (!Profile._open || Profile._targetUsername || !Profile._data
        || Profile._data.signedOut || Profile._data.error) return;
    const token = Profile._loadToken;
    const username = Profile._user().username || null;
    const friends = await listFriends().catch(() => null);
    if (!friends || token !== Profile._loadToken || Profile._targetUsername || !Profile._data) return;
    Profile._data = { ...Profile._data, friends };
    if (username && Profile._ownCache && Profile._ownCache.username === username) {
      Profile._ownCache = { username, data: Profile._data };
    }
    Profile._render();
  },

  // ── opt-in public profile (#582) ────────────────────────────────────

  togglePreview() {
    profileStore.set((state) => ({ ...state, previewOpen: !state.previewOpen }));
  },

  async copyPublicLink(href) {
    const absolute = new URL(href, location.origin).href;
    try {
      await navigator.clipboard.writeText(absolute);
      profileStore.set({ publicStatus: 'Public link copied.' });
    } catch (_) {
      profileStore.set({ publicStatus: `Copy this link: ${absolute}` });
    }
  },

  async _setPublished(published) {
    profileStore.set({
      publishing: true,
      publicStatus: published ? 'Publishing…' : 'Unpublishing…',
    });
    try {
      const res = await fetch('/api/me/public-profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ published }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Could not update publication.');
      if (Profile._data) Profile._data.ownerPublicProfile = payload;
      profileStore.set({ publishing: false, publicStatus: '' });
      Profile._render();
      if (window.PlatformUI) {
        PlatformUI.toast(published ? 'Public profile published' : 'Public profile unpublished');
      }
    } catch (err) {
      profileStore.set({
        publishing: false,
        publicStatus: (err && err.message) || 'Could not update publication.',
      });
    }
  },

  // The account report form on someone else's public card. Returns the status line
  // rather than writing it, so the component owns its own field state.
  async sendReport(username, reason, detail) {
    try {
      const res = await fetch(
        `/api/users/${encodeURIComponent(username)}/report`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason, detail: detail || null }),
        }
      );
      if (!res.ok) throw new Error('request failed');
      return { ok: true, status: 'Report received.' };
    } catch (_) {
      return { ok: false, status: 'Could not send the report. Try again.' };
    }
  },

  // ── "Your feedback" (#3186) ─────────────────────────────────────────
  //
  // The viewer's own feedback and its status, as a card over Me: the same
  // presentation as the edit sheet below (./feedback-sheet.tsx, lifted into
  // the kit's modal by lib/kit-surface.ts), and the same claim on the back
  // button. Its rows come from the load above, so opening it is a store push.
  //
  // It has an address, `#profile?feedback`, because two places outside Me
  // open it: the confirmation after sending feedback
  // (features/dialogs/feedback-controller.js) and the feedback challenge's
  // page (features/leaderboard/topochain-challenges.js). open() takes the
  // query, puts the address back to plain `#profile` so a reload or a later
  // Back does not reopen a list the viewer closed, and opens the list as
  // soon as the viewer's own profile is on screen.
  _feedbackRequested: false,
  _releaseFeedback: null,

  showFeedback() {
    if (profileStore.get().feedbackOpen) return;
    profileStore.set({ feedbackOpen: true });
    Profile._releaseFeedback = pushDismissible(() => {
      Profile._releaseFeedback = null;
      Profile._dismissFeedback();
      return true;
    });
  },

  _dismissFeedback() {
    // Navigating, as _dismissSheet is: a row of the list is a link to the
    // request it became, and leaving the screen closes it too.
    const release = Profile._releaseFeedback;
    Profile._releaseFeedback = null;
    if (release) release({ navigating: true });
    if (profileStore.get().feedbackOpen) profileStore.set({ feedbackOpen: false });
  },

  /** Whether the address asks for the list; takes the ask off it if so. */
  _takeFeedbackRoute() {
    let hash = '';
    try { hash = String(location.hash || ''); } catch (_) { return false; }
    const m = /^#profile\/?\?(.*)$/.exec(hash);
    if (!m) return false;
    let asked = false;
    try { asked = new URLSearchParams(m[1]).has('feedback'); } catch (_) { return false; }
    if (!asked) return false;
    try {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#profile`);
    } catch (_) { /* the list still opens; only the address keeps the ask */ }
    return true;
  },

  _maybeOpenFeedback() {
    if (!Profile._feedbackRequested || !Profile._open || Profile._targetUsername) return;
    const d = Profile._data;
    if (!d) return; // still loading: the post-load call opens it
    Profile._feedbackRequested = false;
    if (d.signedOut || d.error || d.publicProfile || d.publicNotFound) return;
    Profile.showFeedback();
  },

  // ── edit sheet ────────────────────────────────────────────────────────
  //
  // The panel is React's now (./profile-edit-sheet.tsx). It is rendered inside
  // #profile-root and lifted into the native kit's bottom sheet by
  // lib/kit-surface.ts — the same `PlatformUI.sheet` presentation it always
  // had, with the same `|| null` degradation: no kit means the panel simply
  // stays where React put it, at the top of the screen, so the editor is never
  // unreachable.

  showEditSheet() {
    // Re-entering replaces any open sheet rather than stacking two. A kept
    // draft is not thrown away by the re-entry: it is what this open shows.
    const draft = Profile._draft;
    Profile._dismissSheet();
    Profile._draft = draft;
    profileStore.set({ sheetOpen: true });
    Profile._releaseBack = pushDismissible(() => {
      Profile._releaseBack = null;
      Profile._dismissSheet({ keepDraft: true });
      return true;
    });
  },

  /**
   * Close the editor. `keepDraft` for a dismissal that is not a decision about
   * the draft (Back, the kit's backdrop); see `_draft`.
   */
  _dismissSheet({ keepDraft = false } = {}) {
    const source = Profile._draftSource;
    const user = Profile._user();
    Profile._draft = keepDraft && typeof source === 'function' && user.username
      ? { username: user.username, ...source() }
      : null;
    // Navigating, because several closes here are the first half of a link
    // (Email & recovery, Open public page, leaving the screen): the record is
    // spent a task later, and only if nothing moved (lib/back-stack.ts).
    const release = Profile._releaseBack;
    Profile._releaseBack = null;
    if (release) release({ navigating: true });
    profileStore.set({ sheetOpen: false });
    Profile._clearPendingAvatar();
  },

  /** The kept draft for the signed-in user, taken once by the opening editor. */
  takeDraft() {
    const draft = Profile._draft;
    Profile._draft = null;
    const username = Profile._user().username;
    return draft && username && draft.username === username ? draft : null;
  },

  _clearPendingAvatar() {
    if (Profile._pendingAvatarUrl) {
      try { URL.revokeObjectURL(Profile._pendingAvatarUrl); } catch (_) {}
    }
    Profile._pendingAvatar = null;
    Profile._pendingAvatarUrl = null;
    profileStore.set({ pendingAvatarUrl: null, pendingRemove: false });
  },

  /** Stage a chosen file. Throws a user-facing message when it cannot be used. */
  async stageAvatar(file) {
    const blob = await Profile._prepareAvatar(file);
    Profile._clearPendingAvatar();
    Profile._pendingAvatar = blob;
    Profile._pendingAvatarUrl = URL.createObjectURL(blob);
    profileStore.set({ pendingAvatarUrl: Profile._pendingAvatarUrl, pendingRemove: false });
  },

  /** Stage a deletion. Nothing reaches the server until Save. */
  stageAvatarRemoval() {
    Profile._clearPendingAvatar();
    Profile._pendingAvatar = 'remove';
    profileStore.set({ pendingAvatarUrl: null, pendingRemove: true });
  },

  hasPendingAvatar() { return Profile._pendingAvatar != null; },

  // The signed-in user as the identity card should render it: the real one,
  // unless ?shot=profile-long-bio asks for the overflow state above.
  _shotUser() {
    const user = Profile._user();
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    return shot === 'profile-long-bio'
      ? { ...user, bio: Profile.LONG_BIO_SHOT }
      : user;
  },

  // ?shot=profile-edit — a screenshot-state deep link, so the before/after
  // capture and the declared dapp.json test can reach a sheet that plain
  // navigation never opens. Pure UI state with no writes, so deliberately
  // NOT staging-gated: the "before" side is shot against production and an
  // env-gated link would starve it forever.
  _maybeOpenShot() {
    if (Profile._shotFired) return;
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    if (shot !== 'profile-edit') return;
    const d = Profile._data;
    if (!d || d.signedOut || d.error) return;
    Profile._shotFired = true;
    Profile.showEditSheet();
  },

  // Centre-crop to a square, downscale to AVATAR_MAX_PX, then re-encode
  // until it fits the byte budget — the same loop screenshot-select.js
  // uses. This is not an optimisation: the server ships no image decoder,
  // so an un-shrunk 12 MP phone photo would simply be refused.
  async _prepareAvatar(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) {
      throw new Error('Choose a PNG, JPEG or WebP image.');
    }
    const bitmap = await Profile._decodeImage(file);
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('That image could not be read.');
    const target = Math.min(side, Profile.AVATAR_MAX_PX);

    let canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('That image could not be processed here.');
    ctx.drawImage(
      bitmap,
      Math.floor((bitmap.width - side) / 2), Math.floor((bitmap.height - side) / 2),
      side, side, 0, 0, target, target
    );
    if (bitmap.close) bitmap.close();

    const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
    // PNG first (crisp for the flat-colour avatars people actually pick);
    // fall back to JPEG, then halve the square until it fits. The server
    // accepts PNG, JPEG and WebP.
    let blob = await toBlob(canvas, 'image/png');
    if (!blob || blob.size > Profile.AVATAR_MAX_BYTES) {
      blob = await toBlob(canvas, 'image/jpeg', 0.85);
    }
    while (blob && blob.size > Profile.AVATAR_MAX_BYTES && canvas.width > 64) {
      const next = document.createElement('canvas');
      next.width = Math.round(canvas.width / 2);
      next.height = Math.round(canvas.height / 2);
      next.getContext('2d').drawImage(canvas, 0, 0, next.width, next.height);
      canvas = next;
      blob = await toBlob(canvas, 'image/jpeg', 0.85);
    }
    if (!blob) throw new Error('That image could not be processed here.');
    return blob;
  },

  async _decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be read.'));
      };
      img.src = url;
    });
  },

  // Save order matters: the avatar write first (it is the one that can
  // fail on bytes), then the text PATCH, then one /api/auth/me refresh so
  // App.user — which every other surface reads — is the post-write truth
  // rather than a locally-patched guess.
  //
  // Returns `{ ok: true }`, `{ fieldErrors }` (server-side per-field messages,
  // which keep the sheet open with the user's other edits intact) or
  // `{ error }`. The sheet component owns the disabled state and the messages;
  // this owns the order and the truth-refresh.
  async _save({ displayName, bio }) {
    try {
      if (Profile._pendingAvatar === 'remove') {
        const res = await fetch('/api/me/avatar', {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!res.ok) {
          throw new Error((await Profile._errText(res)) || 'Could not remove the photo.');
        }
      } else if (Profile._pendingAvatar) {
        const res = await fetch('/api/me/avatar', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: Profile._pendingAvatar,
        });
        if (!res.ok) {
          throw new Error((await Profile._errText(res)) || 'Could not upload the photo.');
        }
      }

      const res = await fetch('/api/me/profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, bio }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const details = body && body.details;
        if (details && typeof details === 'object') {
          const fieldErrors = {};
          let pinned = false;
          for (const [key, msgs] of Object.entries(details)) {
            if (!['displayName', 'bio'].includes(key)) continue;
            fieldErrors[key] = Array.isArray(msgs) ? msgs[0] : String(msgs);
            pinned = true;
          }
          // Field-level messages are the whole feedback — keep the sheet
          // open with the user's other edits intact.
          if (pinned) return { fieldErrors };
        }
        throw new Error((body && body.error) || 'Could not save your profile.');
      }

      await Profile._refreshUser();
      Profile._dismissSheet();
      Profile._render();
      if (window.PlatformUI) PlatformUI.toast('Profile saved');
      return { ok: true };
    } catch (err) {
      return { error: (err && err.message) || 'Could not save your profile.' };
    }
  },

  async _errText(res) {
    try {
      const body = await res.json();
      return body && body.error;
    } catch (_) {
      return null;
    }
  },

  // Re-read the session user so App.user — and therefore the identity card
  // this screen draws from it — reflects what was actually stored.
  async _refreshUser() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.user && window.App) {
        App.user = body.user;
      }
    } catch (_) { /* keep the stale copy — the next load corrects it */ }
  },
};

// Still published as a global: app.js's #profile hash branch,
// App.navigateToProfile / _exitProfile and the header menu's Profile row all
// reach this through `window.Profile`, and app.js is a classic script.
// Guarded because the SSG prerender pass evaluates this module in Node (the
// island imports it).
if (typeof window !== 'undefined') window.Profile = Profile;

// #2386: a friend change anywhere on the page (the person page's button, a
// notification row's Accept) refreshes the own profile's Friends section if
// that is what is on screen. Same guard, same reason.
if (typeof window !== 'undefined') {
  window.addEventListener(FRIENDS_CHANGED_EVENT, () => { void Profile._refreshFriends(); });
}

export { Profile };
