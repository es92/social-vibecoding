// First-run "What communities do you want to join?" (communities, stage 5).
//
// The third first-run step, after "Choose your username"
// (./username-first-run.js) and the terms (../settings/terms-first-run.js),
// and before Home's Getting started card, whose first row offers the welcome
// tour (../home/tour, #3240). A new account picks the communities it wants to be part of
// before it sees Home, so the Home it lands on already has them on it: each
// one it joins is pinned there (services/communities.js `join`).
//
// ── What decides whether to ask ────────────────────────────────────────
//
// `App.user.needsCommunitiesChoice` from /api/auth/me, which every sign-up
// path sets (email, an activation code, a wallet) and answering clears
// (src/services/onboarding.js). Every account that existed before this step
// reads false, so nobody who already uses the platform is walked through it.
//
// ── What it shows ──────────────────────────────────────────────────────
//
// GET /api/me/join-suggestions: Homeroom first (the platform's own project,
// which a new account is already in, so it arrives ticked), then any group
// the person was invited into (ticked), then the open communities with the
// most members. Each row ends in how many members the community has, a
// people glyph and a figure just before the tick (`_members`), beside the
// line under the name rather than instead of it. One button, which says
// what it will do: "Join 3 communities". Unticking everything is allowed to
// be a dead end on purpose ("Pick at least one"): a newcomer in no community
// has nothing on Home and nothing in the Workshop, and the screen exists to
// prevent that.
//
// ── Blocking, like the username step ───────────────────────────────────
//
// A non-dismissible kit modal with one exit, the answer. It does NOT block
// on a failure of its own: a list that will not load, or a kit that is not
// there, skips the step for this page load and leaves the flag set, so the
// next load asks again. Every skip is silent (console.warn at most): a
// console.error on any route fails proposal checks.
//
// Classic IIFE like its two siblings, imported from ../../main.tsx so it
// ships in the shell bundle with no new public/js/** script.
(function () {
  'use strict';

  // The prerender pass imports the entry with no DOM to speak to.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // The one screenshot state for this step: a fixture list, no fetch, and an
  // answer that writes nothing. Every other `?shot=`, `?demo=` and `?token=`
  // route skips the step so the overlay cannot land on an unrelated check.
  const SHOT = 'join-communities';
  const SHOT_LIST = [
    { slug: 'homeroom', name: 'Homeroom', icon_emoji: '🏠', self_hosted: true, checked: true,
      detail: 'Contribute to the Homeroom platform', member_count: 1284 },
    { slug: 'book-club', name: 'Book club', icon_emoji: '📚', checked: true,
      detail: 'Invited by @grace', invited_by: 'grace', member_count: 6 },
    { slug: 'city-garden', name: 'City garden', icon_emoji: '🌱', checked: false,
      detail: 'Swap seeds and plan the shared plots.', member_count: 41 },
    // No description of its own: the row is just the name.
    { slug: 'pickup-soccer', name: 'Pickup soccer', icon_emoji: '⚽', checked: false, detail: '',
      member_count: 12 },
  ];

  const SETTLE_DELAY_MS = 450;

  // The accent, as complete literals (Tailwind extracts class names from
  // source text; a computed one is never compiled). `violet-*` is the blue
  // action colour in this palette (tailwind.config.js).
  const TICK_ON = 'join-community-tick flex items-center justify-center w-6 h-6 rounded-full shrink-0 bg-violet-600 text-white';
  const TICK_OFF = 'join-community-tick flex items-center justify-center w-6 h-6 rounded-full shrink-0 border-2 border-zinc-300 dark:border-zinc-600 text-transparent';

  // The people glyph in front of a row's member count: the shell's own
  // UserGroupIcon (frontend/@/components/ui/icons.tsx), path for path, the
  // mark an app's menu already draws beside "Go to community". This screen
  // builds its DOM by hand, so the path is copied rather than imported;
  // tests/communities-first-run.test.js keeps the two equal.
  const MEMBERS_GLYPH = 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9';

  const CommunitiesFirstRun = {
    _presented: false,
    _answered: false,
    _shownHere: false,
    _settle: null,
    _settled: null,

    // Does this document have a join step to show? Read by the tour, which
    // never copies this browser's "done" to an account whose join screen is
    // still to come (an account an admin has reset).
    applies() {
      if (CommunitiesFirstRun._presented) return true;
      if (CommunitiesFirstRun._answered) return false;
      return !!(window.App && window.App.user
        && window.App.user.needsCommunitiesChoice === true);
    },

    // Has THIS document shown the real join screen (never the ?shot=
    // fixture)? Read by the tour: a first run shown here, a new account's or
    // one an admin reset (Admin → Users → ⋯ → Reset first run), clears this
    // browser's "done" for the tour, as the reset cleared the account's, so
    // the Getting started card offers the tour again.
    shownHere() {
      return CommunitiesFirstRun._shownHere === true;
    },

    // Resolves when this document's step is done with: answered, skipped, or
    // never applicable. It awaits the terms gate first, which itself awaits
    // the username gate, so a caller that awaits this one has waited on all
    // three.
    settled() {
      if (!CommunitiesFirstRun._settled) {
        CommunitiesFirstRun._settled = new Promise((resolve) => {
          CommunitiesFirstRun._settle = resolve;
        });
      }
      return CommunitiesFirstRun._settled;
    },

    _resolve() {
      CommunitiesFirstRun.settled();
      if (CommunitiesFirstRun._settle) {
        const done = CommunitiesFirstRun._settle;
        CommunitiesFirstRun._settle = null;
        done();
      }
    },

    _params() {
      try { return new URLSearchParams(location.search); } catch (_) { return null; }
    },

    async _afterEarlierSteps() {
      const terms = window.TermsFirstRun;
      if (terms && typeof terms.settled === 'function') {
        try { await terms.settled(); } catch (_) { /* a broken gate must not block this one */ }
      }
      // After a snapshot boot, app.js's _reconcileSession re-offers the terms
      // ask and then this one, once the session is confirmed. settled() had
      // already resolved for the skipped boot check by then, so wait for
      // that second ask to finish as well: never two sheets at once. Capped,
      // so a terms sheet left open for ten minutes does not hold this for
      // good.
      for (let i = 0; terms && (terms._inFlight || terms._presented) && i < 2400; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },

    async maybePrompt() {
      if (CommunitiesFirstRun._presented || CommunitiesFirstRun._answered) return;
      const params = CommunitiesFirstRun._params();
      if (params && params.get('shot') === SHOT) {
        CommunitiesFirstRun._present(SHOT_LIST, { demo: true });
        return;
      }
      if (params && (params.get('shot') || params.get('demo') || params.get('token'))) {
        CommunitiesFirstRun._resolve();
        return;
      }
      // The side panel's document: the TOP window asks, once.
      if (document.documentElement?.classList?.contains('in-side-panel')) {
        CommunitiesFirstRun._resolve();
        return;
      }
      if (window.App && window.App._sessionFromSnapshot) {
        CommunitiesFirstRun._resolve();
        return;
      }
      if (!window.App || !window.App.user || window.App.user.needsCommunitiesChoice !== true) {
        CommunitiesFirstRun._answered = !!(window.App && window.App.user);
        CommunitiesFirstRun._resolve();
        return;
      }

      await CommunitiesFirstRun._afterEarlierSteps();
      // A ghost-click window after the sheet before it, the same one the
      // terms gate leaves after the username step.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

      let list = null;
      try {
        const res = await fetch('/api/me/join-suggestions', { credentials: 'same-origin' });
        const body = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(body.communities)) list = body.communities;
      } catch (err) {
        console.warn('[communities-first-run] suggestions skipped:', err);
      }
      if (!list || !list.length) {
        // Nothing to offer is not an answer: the flag stays, and a later
        // load with a list asks.
        CommunitiesFirstRun._resolve();
        return;
      }
      CommunitiesFirstRun._present(list, { demo: false });
    },

    _icon(c, el) {
      const tile = el('div', 'app-icon-tile w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center font-bold text-base shrink-0');
      if (c.icon_url) {
        tile.setAttribute('data-icon', 'image');
        const img = el('img', 'w-full h-full object-cover');
        img.src = c.icon_url;
        img.alt = '';
        img.loading = 'lazy';
        tile.appendChild(img);
      } else if (c.icon_emoji) {
        tile.setAttribute('data-icon', 'emoji');
        tile.appendChild(el('span', 'text-xl leading-none', c.icon_emoji));
      } else {
        tile.setAttribute('data-icon', 'letter');
        tile.textContent = String(c.name || '?').charAt(0).toUpperCase();
      }
      return tile;
    },

    // A member count as the row shows it: whole up to 999, then one decimal
    // to 9.9k and whole thousands after that (1.2k, 12k), then the same in
    // millions. Rounded down, so a figure never claims a member the
    // community does not have, and 999,999 reads 999k rather than 1000k.
    // Counted in whole tenths: 2300 / 1000 * 10 is 22.999... in floating
    // point, which would round 2,300 down to "2.2k".
    _count(n) {
      if (n < 1000) return String(n);
      const [unit, suffix] = n < 1e6 ? [1e3, 'k'] : [1e6, 'm'];
      const tenths = Math.floor((n * 10) / unit);
      return `${tenths < 100 ? tenths / 10 : Math.floor(tenths / 10)}${suffix}`;
    },

    // How many members a row's community has, at the row's end, before the
    // tick: the people glyph and the short figure, both hidden from a screen
    // reader, which hears the whole number instead ("1,284 members"). No
    // count, or none yet, and the row has no figure at all: a "0" on a
    // newcomer's first screen says nothing worth saying.
    _members(c, el) {
      const n = Math.floor(Number(c.member_count));
      if (!Number.isFinite(n) || n < 1) return null;
      const wrap = el('span',
        'flex items-center gap-1 shrink-0 text-[0.8125rem] leading-[1.125rem] tabular-nums text-zinc-500 dark:text-zinc-400');
      wrap.setAttribute('data-join-community-members', String(n));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'w-3.5 h-3.5');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', MEMBERS_GLYPH);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      wrap.appendChild(svg);
      const figure = el('span', null, CommunitiesFirstRun._count(n));
      figure.setAttribute('aria-hidden', 'true');
      wrap.appendChild(figure);
      wrap.appendChild(el('span', 'sr-only',
        `${n.toLocaleString('en-US')} ${n === 1 ? 'member' : 'members'}`));
      return wrap;
    },

    _tick(el) {
      const tick = el('span', TICK_OFF);
      tick.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'w-4 h-4');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '3');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      tick.appendChild(svg);
      return tick;
    },

    _present(list, opts) {
      if (CommunitiesFirstRun._presented) return;
      CommunitiesFirstRun._presented = true;
      if (!(opts && opts.demo)) CommunitiesFirstRun._shownHere = true;

      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };

      // THE ANSWER IS ALWAYS ON SCREEN (#3563). The screen is two parts: a
      // body that scrolls (the welcome, the question, the rows and the line
      // under them) and a foot that does not (Join and Skip). On a short
      // screen the body yields: it takes what the dialog has left once the
      // foot is drawn, and scrolls inside that, so the two answers stay in
      // view however many communities there are to list.
      //
      // It used to be one column the kit's card scrolled as a whole, with
      // the rows a second scroller inside it, capped at half the viewport.
      // On a phone with the browser's bars showing (Safari leaves about
      // 660px of an 844px iPhone; a 667px or 568px phone has less with no
      // bars at all) the column ran past the card's bottom edge: Join was
      // cut in half and Skip was under it, or both were. The card did
      // scroll, but nothing said so (iOS draws no bar until you scroll), and
      // where a thumb lands is the rows, which scrolled themselves instead
      // of the card. Safari's `vh` is the screen with its bars hidden, so
      // "half the viewport" was more than half of what showed. One scroller
      // now, and the rows are not it: they are as tall as they are, and the
      // body scrolls them with everything else above the foot.
      //
      // The body keeps a floor, so a screen too short for even that (a
      // phone on its side) scrolls the card as a whole again, which the kit
      // does by itself: nothing is ever clipped out of reach.
      const panel = el('div', 'flex min-h-0 flex-col px-4 pb-5');
      panel.setAttribute('data-join-communities', '');
      const scroller = el('div', 'min-h-[7.5rem] overflow-y-auto overscroll-y-contain');
      scroller.setAttribute('data-join-communities-scroll', '');
      panel.appendChild(scroller);
      // A welcome first: this is a new account's first screen after its
      // name and the terms, so it says what the place is before it asks.
      scroller.appendChild(el('div', 'text-xl font-bold pt-3', 'Welcome to Homeroom!'));
      scroller.appendChild(el('p', 'text-sm text-zinc-600 dark:text-zinc-300 mt-1',
        'Homeroom is a place where communities build the apps they use together.'));
      scroller.appendChild(el('div',
        'text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100 mt-5 mb-2',
        'What communities do you want to join?'));

      // One card of rows, the platform's grouped-list shape: the plane
      // colour, a 20px radius and one inset hairline.
      const group = el('div', 'rounded-[20px] shadow-[inset_0_0_0_1px_var(--app-sheet-line)] divide-y divide-zinc-200/70 dark:divide-zinc-800');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Communities');
      scroller.appendChild(group);

      const picked = new Set(list.filter((c) => c.checked).map((c) => c.slug));
      const rows = [];
      for (const c of list) {
        const row = el('button', 'w-full flex items-center gap-3 px-4 py-3 text-left');
        row.type = 'button';
        row.setAttribute('role', 'checkbox');
        row.setAttribute('data-join-community', c.slug);
        const text = el('div', 'min-w-0 flex-1');
        text.appendChild(el('div', 'truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100', c.name));
        // The detail may wrap to two lines: a community's own description
        // and a long inviter's handle are both wider than a phone row. A
        // community with no description of its own is just its name.
        if (c.detail) {
          text.appendChild(el('div', 'mt-0.5 line-clamp-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400', c.detail));
        }
        const members = CommunitiesFirstRun._members(c, el);
        const tick = CommunitiesFirstRun._tick(el);
        row.appendChild(CommunitiesFirstRun._icon(c, el));
        row.appendChild(text);
        if (members) row.appendChild(members);
        row.appendChild(tick);
        const paint = () => {
          const on = picked.has(c.slug);
          row.setAttribute('aria-checked', String(on));
          row.setAttribute('data-checked', String(on));
          tick.className = on ? TICK_ON : TICK_OFF;
        };
        row.addEventListener('click', () => {
          if (picked.has(c.slug)) picked.delete(c.slug);
          else picked.add(c.slug);
          paint();
          paintButton();
        });
        rows.push(paint);
        group.appendChild(row);
      }

      scroller.appendChild(el('p', 'text-[0.8125rem] text-zinc-500 dark:text-zinc-400 mt-3',
        'You can join or leave any time from Discover, and start your own private or public community once you are in.'));

      // The foot: the error line and the two answers. Its top edge is a
      // hairline only while there is more of the body below it to scroll
      // to (`data-more`, set below), so a screen with room for everything
      // looks as it always did. The line is a transparent border the rest
      // of the time, which keeps the foot the same height either way.
      const foot = el('div',
        'shrink-0 border-t border-transparent data-[more]:border-[color:var(--app-sheet-line)]');
      foot.setAttribute('data-join-communities-foot', '');
      panel.appendChild(foot);

      const status = el('p', 'text-sm mt-2 min-h-5 text-red-600 dark:text-red-400');
      status.setAttribute('data-join-communities-error', '');
      foot.appendChild(status);

      const save = el('button',
        'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2.5 mt-1 ' +
        'text-sm font-semibold text-white disabled:opacity-50');
      save.type = 'button';
      save.setAttribute('data-join-communities-save', '');
      foot.appendChild(save);

      // "Skip for now": quiet, under the one filled button. It is an answer
      // too: the server records it, joins and leaves nothing, and the screen
      // does not come back. The subtitle already says where joining lives.
      const skip = el('button',
        'w-full mt-1 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-800 ' +
        'dark:text-zinc-400 dark:hover:text-zinc-100 disabled:opacity-50',
        'Skip for now');
      skip.type = 'button';
      skip.setAttribute('data-join-communities-skip', '');
      foot.appendChild(skip);

      let busy = false;
      function paintButton() {
        const n = picked.size;
        skip.disabled = busy;
        save.disabled = busy || n === 0;
        save.textContent = n === 0 ? 'Pick at least one'
          : `Join ${n} ${n === 1 ? 'community' : 'communities'}`;
        save.setAttribute('data-picked', String(n));
      }
      rows.forEach((paint) => paint());
      paintButton();

      let sheet = null;
      let watch = null;
      const dismiss = () => {
        CommunitiesFirstRun._answered = true;
        if (watch) watch.disconnect();
        if (sheet && sheet.dismiss) sheet.dismiss();
        CommunitiesFirstRun._presented = false;
        CommunitiesFirstRun._resolve();
      };

      // Both buttons answer through here: Join with what is ticked, Skip
      // with `{ skip: true }`.
      const answer = async (payload) => {
        if (busy) return;
        if (opts && opts.demo) { status.textContent = ''; return; }
        busy = true;
        paintButton();
        status.textContent = '';
        try {
          const res = await fetch('/api/me/communities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok && !body.alreadyDone) {
            status.textContent = body.error || 'Could not join those. Try again.';
            busy = false;
            paintButton();
            return;
          }
          if (window.App && window.App.user) {
            window.App.user.needsCommunitiesChoice = false;
            if (!body.alreadyDone) window.App.user.showGettingStarted = true;
            try { window.App.saveSessionSnapshot?.(window.App.user); } catch (_) {}
          }
          dismiss();
          // Home re-reads the pins the joins just made, and the Getting
          // started card appears (features/home/getting-started.tsx).
          document.dispatchEvent(new CustomEvent('sv:communities-joined', {
            detail: { joined: body.joined || [] },
          }));
          try { window.Home?.load?.(); } catch (_) {}
          const n = (body.joined || []).length;
          if (n && window.PlatformUI) {
            PlatformUI.toast(`You joined ${n} ${n === 1 ? 'community' : 'communities'}.`);
          }
        } catch (err) {
          console.warn('[communities-first-run] answer failed:', err);
          status.textContent = 'Network error. Try again.';
          busy = false;
          paintButton();
        }
      };

      save.addEventListener('click', () => {
        if (!picked.size) return;
        // In the listed order, so the first one ticked below Homeroom is the
        // one the Getting started card is about.
        void answer({ join: list.map((c) => c.slug).filter((s) => picked.has(s)) });
      });
      skip.addEventListener('click', () => { void answer({ skip: true }); });

      if (window.PlatformUI && typeof PlatformUI.modal === 'function') {
        sheet = PlatformUI.modal({ contentEl: panel, dismissible: false });
        // The kit's card is the box the body yields inside (#3563): a
        // column, so the panel, and the body in it, can be told how much
        // height is left instead of growing past the card's edge. The card
        // keeps its own size, centring and scroll; the caller sizing its
        // card is the same seam session-options.js uses for its width. Only
        // the modal: the sheet below is a different surface with a scroll
        // of its own, and the panel inside it just stacks.
        if (sheet && sheet.el) {
          sheet.el.style.display = 'flex';
          sheet.el.style.flexDirection = 'column';
        }
      }
      if (!sheet && window.PlatformUI && typeof PlatformUI.sheet === 'function') {
        sheet = PlatformUI.sheet({ contentEl: panel });
      }
      if (!sheet) {
        CommunitiesFirstRun._presented = false;
        CommunitiesFirstRun._resolve();
        return;
      }
      CommunitiesFirstRun._sheet = sheet;

      // The foot's hairline: on while there is more body below the foot,
      // read whenever the body scrolls or changes size (the browser's bars
      // coming and going, a phone turned, an error line growing the foot).
      // The observer also delivers the first reading once the card is laid
      // out. Without one (an old browser) the line just stays off.
      const edge = () => {
        foot.toggleAttribute('data-more',
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 1);
      };
      scroller.addEventListener('scroll', edge, { passive: true });
      if (typeof ResizeObserver === 'function') {
        watch = new ResizeObserver(edge);
        watch.observe(scroller);
      }
    },

    init() {
      if (window.App && window.App.user) CommunitiesFirstRun.maybePrompt();
      else {
        document.addEventListener('sv:authed',
          () => CommunitiesFirstRun.maybePrompt(), { once: true });
      }
    },
  };

  window.CommunitiesFirstRun = CommunitiesFirstRun;
  CommunitiesFirstRun.init();
})();
