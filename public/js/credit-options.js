/* Daily-AI-credit copy — the single source of truth for "here is where you
 * stand on today's allowance", and for "it ran out; here is how to keep
 * building".
 *
 * Three surfaces render the same three options and must never drift:
 *   1. the in-chat card DevChat pushes when POST /chat answers
 *      429 { code: 'budget_exceeded' }  (public/js/dev-chat.js),
 *   2. the red credits banner above the dev-chat body (same file), and
 *   3. the Generate-proposal modal when the headless route 429s the same
 *      way (public/js/app-view.js).
 *
 * So the copy, the destinations and the markup all live here. Adding a
 * fourth route later (a paid tier, say) is one edit in this file and the
 * three call sites pick it up for free — which is the whole reason this
 * module exists instead of three inlined strings.
 *
 * #1281 added the one thing that is NOT shared: how the card DISCLOSES the
 * list. `options()` still returns every route to every surface, but the two
 * that need a terminal — the CLI lease and importing your own pull request
 * — render inside an "Are you a developer?" expander rather than in the
 * flat list, so the routes anyone can follow are the ones a normal user
 * meets first. `partition()` is that split, and it is derived from the
 * venue's mechanism rather than from a list of ids kept in step by hand.
 * The compact banner is deliberately left flat: it is a one-line strip of
 * affordances next to the refusal, not the screen where the choice is made,
 * and a disclosure widget inside it would hide routes behind two clicks in
 * the surface with the least room to explain itself.
 *
 * Every destination is a real Settings hash route (Settings.SECTIONS in
 * public/js/settings.js declares the same keys), so clicking one is an
 * ordinary hash navigation and the device back gesture returns to the
 * chat. tests/credit-options.test.js asserts the hashes correspond to
 * declared sections, so a renamed section can't silently produce a dead
 * link.
 *
 * #593 widened it from "you ran out" to the whole allowance story, because
 * the states are one story and were told in different words in each place:
 * the composer meter said `$13.60/$20.00` and hid the remainder and the
 * reset in a tooltip, the drawer row said the same thing in its own
 * formatting, and nothing at all was said as the allowance ran low. So
 * `creditState()` (normalise either budget payload → one state), plus the
 * money/reset formatting and the low-balance copy, live here too. The
 * threshold is NOT defined here: it arrives on the payload from
 * limits.LOW_BALANCE_PCT, and LOW_PCT below is only the fallback for a
 * payload that predates it.
 */
(function () {
  'use strict';

  // The six build venues, loaded as a classic script ahead of this one in
  // the browser and required directly under node. Resolved lazily rather
  // than captured at definition time so load order inside a test harness
  // (which may seed window.BuildVenues after evaluating this file) cannot
  // freeze a null.
  function venues() {
    if (typeof window !== 'undefined' && window.BuildVenues) return window.BuildVenues;
    if (typeof require === 'function') {
      try { return require('./build-venues.js'); } catch (err) { /* browser */ }
    }
    return null;
  }

  var SETTINGS_HASHES = (venues() && venues().SETTINGS_HASHES) || {
    apiKey: '#settings/api-key',
    localTool: '#settings/cli',
    connector: '#settings/connectors',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Where the user stands (#593) ────────────────────────────────────
  //
  // Fallback only: the live value rides on both budget payloads as
  // `lowBalancePct` (src/services/limits.js LOW_BALANCE_PCT is the
  // definition). This keeps a cached page from rendering NaN.
  var LOW_PCT = 80;

  function money(cents) {
    var n = Number(cents);
    return '$' + (Number.isFinite(n) ? n / 100 : 0).toFixed(2);
  }

  // "3h 20m" / "45m" / "under a minute". null when there is nothing to
  // count down to, so callers can drop the clause instead of printing a
  // gap. `nowMs` is injectable for the tests.
  function resetIn(resetsAt, nowMs) {
    if (!resetsAt) return null;
    var at = Date.parse(resetsAt);
    if (!Number.isFinite(at)) return null;
    var ms = at - (nowMs == null ? Date.now() : nowMs);
    if (ms <= 0) return null;
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'under a minute';
    var hours = Math.floor(mins / 60);
    if (!hours) return mins + 'm';
    var rem = mins % 60;
    return hours + 'h' + (rem ? ' ' + rem + 'm' : '');
  }

  // The one sentence every surface uses to answer "when do I get them
  // back?". Names the boundary the server names (midnight UTC — the
  // llm_usage date rollover), then translates it, because almost nobody
  // reading it is on UTC and "tomorrow" was the old, wrong shorthand.
  function resetSentence(state, nowMs) {
    var s = state || {};
    if (s.level === 'locked') {
      return 'Connect GitHub or X to unlock $10.00/day of Homeroom credits.';
    }
    if (s.level === 'unavailable') {
      return 'Credit eligibility is temporarily unavailable.';
    }
    var resetLabel = s.resetLabel || 'midnight UTC';
    var parts = s.capWindow === 'weekly'
      ? 'Free credits reset ' + resetLabel
      : 'Free credits reset at ' + resetLabel;
    var at = s.resetsAt ? new Date(s.resetsAt) : null;
    if (at && Number.isFinite(at.getTime())) {
      var local = null;
      try {
        // Only worth translating for a reader who is not already on UTC —
        // otherwise it prints "midnight UTC — 12:00 AM your time", which
        // is the same fact twice.
        if (at.getTimezoneOffset() !== 0 && s.capWindow !== 'weekly') {
          local = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        }
      } catch (err) { /* no Intl — the UTC boundary still reads fine */ }
      if (local) parts += ' (' + local + ' your time)';
      var left = resetIn(s.resetsAt, nowMs);
      if (left) parts += ', about ' + left + ' from now';
    }
    return parts + '.';
  }

  // Normalises either budget payload into one state. The composer reads
  // GET /api/budget (spend + the shared cap + BYOK spillover), the drawer
  // row reads GET /api/me/ai-budget (no global figures — those are
  // admin-only, see redact() in services/status.js). Both describe the
  // same allowance, so both collapse to the same four levels:
  //
  //   unknown   — nothing fetched yet, or malformed figures: say nothing
  //   locked    — identity tiers are active and no provider is verified
  //   unavailable — tier eligibility could not be read (fail closed)
  //   ok        — headroom
  //   low       — at or past lowBalancePct of the cap; warn proactively
  //   exhausted — the personal allowance or the shared one is spent
  //
  // `level` describes the ALLOWANCE, not whether the user can keep going:
  // a BYOK key bypasses the cap entirely (#119), so `hasByokKey` stays a
  // separate field and the surface decides whether "exhausted" is even
  // worth mentioning.
  function creditState(snapshot) {
    var s = snapshot || null;
    var limitCents = s ? Number(s.limitCents) : NaN;
    var spentCents = s ? Number(s.spentCents) : NaN;
    if (!s || !Number.isFinite(limitCents) || !Number.isFinite(spentCents) || limitCents < 0) {
      return {
        level: 'unknown', limitCents: 0, spentCents: 0, remainingCents: 0,
        byokCents: 0, pctUsed: 0, hasByokKey: !!(s && s.hasByokKey),
        globalOut: false, resetsAt: (s && s.resetsAt) || null,
        lowPct: (s && Number(s.lowBalancePct)) || LOW_PCT,
        capWindow: (s && s.capWindow) || 'daily',
        windowLabel: (s && s.windowLabel) || 'Today',
        resetLabel: (s && s.resetLabel) || 'midnight UTC',
      };
    }
    var verificationRequired = !!s.verificationRequired;
    var entitlementAvailable = s.entitlementAvailable !== false;
    var remainingCents = Number.isFinite(Number(s.remainingCents))
      ? Math.max(0, Number(s.remainingCents))
      : Math.max(0, limitCents - spentCents);
    // Both spellings: /api/budget calls it byokSpentCents, the drawer
    // payload calls it byokCents.
    var byokCents = Number(s.byokCents);
    if (!Number.isFinite(byokCents)) byokCents = Number(s.byokSpentCents);
    if (!Number.isFinite(byokCents)) byokCents = 0;
    var globalLimit = Number(s.globalLimitCents);
    var globalSpent = Number(s.globalSpentCents);
    var globalOut = Number.isFinite(globalLimit) && globalLimit > 0
      && Number.isFinite(globalSpent) && globalSpent >= globalLimit;
    var lowPct = Number(s.lowBalancePct);
    if (!Number.isFinite(lowPct) || lowPct <= 0 || lowPct >= 100) lowPct = LOW_PCT;
    var pctUsed = limitCents > 0
      ? Math.min(100, (spentCents / limitCents) * 100)
      : 0;
    var level = limitCents === 0 ? 'exhausted' : 'ok';
    if (!entitlementAvailable) level = 'unavailable';
    else if (verificationRequired && limitCents === 0) level = 'locked';
    else if (globalOut || spentCents >= limitCents) level = 'exhausted';
    else if (pctUsed >= lowPct) level = 'low';
    return {
      level: level,
      limitCents: limitCents,
      spentCents: spentCents,
      remainingCents: remainingCents,
      byokCents: byokCents,
      pctUsed: pctUsed,
      hasByokKey: !!s.hasByokKey,
      globalOut: globalOut,
      resetsAt: s.resetsAt || null,
      // #1788: the allowance is two windows now, and the server reports
      // whichever one is BINDING in the legacy limit/spent/remaining
      // fields. These three say which window that was, so every sentence
      // below names the right boundary instead of assuming "daily".
      capWindow: s.capWindow || 'daily',
      windowLabel: s.windowLabel || 'Today',
      resetLabel: s.resetLabel || 'midnight UTC',
      lowPct: lowPct,
      verificationRequired: verificationRequired,
      entitlementAvailable: entitlementAvailable,
      creditPolicy: s.creditPolicy || null,
      tier: s.tier || null,
      tierLimitCents: Number.isFinite(Number(s.tierLimitCents))
        ? Number(s.tierLimitCents) : 1000,
    };
  }

  // The meter, as data. Both surfaces render `spent/limit` plus — new in
  // #593 — what is actually LEFT, which is the figure a builder deciding
  // whether to start another turn is looking for and the one that used to
  // be tooltip-only (invisible on touch, and absent from every review
  // screenshot). Returned as parts, not HTML, because the two surfaces
  // wrap them differently.
  function meterParts(state) {
    var s = state || {};
    if (s.level === 'locked') {
      return [{ key: 'locked', text: 'verify account · unlock $10/day' }];
    }
    if (s.level === 'unavailable') {
      return [{ key: 'unavailable', text: 'credits temporarily unavailable' }];
    }
    var spent = money(s.spentCents);
    var limit = money(s.limitCents);
    // `spent`/`limit` come out separately as well as joined: both surfaces
    // colour the spend figure and leave the cap grey, so both need the
    // halves, and neither should be re-deriving the formatting.
    var parts = [{ key: 'pair', text: spent + '/' + limit, spent: spent, limit: limit }];
    if (s.level === 'exhausted') {
      parts.push({ key: 'remaining', text: s.globalOut ? 'shared budget spent' : 'none left' });
    } else if (s.level === 'ok' || s.level === 'low') {
      parts.push({ key: 'remaining', text: money(s.remainingCents) + ' left' });
    }
    if (s.byokCents > 0) {
      parts.push({ key: 'byok', text: 'your key ' + money(s.byokCents) });
    }
    return parts;
  }

  // Tone for the meter. Same three colours the two surfaces already used,
  // now derived from the level so they cannot disagree about where amber
  // starts.
  function meterTone(state) {
    var level = (state || {}).level;
    if (level === 'exhausted') return 'red';
    if (level === 'low' || level === 'locked' || level === 'unavailable') return 'amber';
    return 'emerald';
  }

  // The proactive warning (#593). Deliberately not a scaled-down copy of
  // the exhausted lead: nothing has been refused yet, so it states the
  // headroom and the boundary and lets the same route buttons sit under
  // it, rather than announcing a failure that hasn't happened.
  function lowLead(state) {
    var s = state || {};
    var when = s.capWindow === 'weekly' ? 'this week' : 'today';
    return 'Running low on free AI credits: ' + money(s.remainingCents)
      + ' of ' + money(s.limitCents) + ' left ' + when + '.';
  }

  // ── Who each route is for (#1281) ──────────────────────────────────
  //
  // Running out of credits is the moment the venue question finally has to
  // be asked, and #1281's answer is to route by WHO YOU ARE rather than to
  // list every mechanism at once. Two of the ways out need a terminal: the
  // CLI lease (`local`) wants the Homeroom CLI installed, and importing a
  // pull request (`own-tools-pr`) wants a fork, a branch and git. Shown
  // flat next to "use your Claude plan", they read as the price of
  // continuing rather than as the specialist routes they are — which is
  // the discovery problem this card had.
  //
  // So the list stays whole (`options()` is unchanged, and every surface
  // still gets every route) and only the CARD's disclosure changes: the
  // routes anyone can follow render first, and these two sit behind an
  // "Are you a developer?" expander.
  //
  // Derived from the venue's mechanism, never a hand-kept id list — a
  // seventh venue in public/js/build-venues.js lands on the correct side
  // of the expander by declaring what it is, not by being remembered here.
  //
  //   lease  → session_agent_leases: the Homeroom CLI on your machine
  //   import → POST /api/apps/:slug/pr-import: your own tools, your own PR
  var DEVELOPER_MECHANISMS = { lease: true, import: true };

  // Split a route list into the two halves the card discloses separately.
  // Order within each half is preserved, so the primary group still leads
  // with whatever `options()` decided leads.
  function partition(list) {
    var all = list || [];
    return {
      primary: all.filter(function (opt) { return !opt.developer; }),
      developer: all.filter(function (opt) { return !!opt.developer; }),
    };
  }

  // The ways out. `hasApiKey` flips the API-key entry: limits.loadUserApiKey
  // treats a decrypt failure as "no key on file", so a user WITH a saved key
  // can still be refused — telling them to "add a key" they already added is
  // the wrong advice.
  //
  // #1049 changed the ORDER and added two entries. Running out of credits is
  // the moment someone is most willing to try another route, and the two
  // routes that need no new account and no card — hand the work to the Claude
  // or ChatGPT subscription they already pay for — used to be listed last as
  // "connect a connector", which reads like plumbing rather than an answer.
  // They lead now, and each one carries a `flow` so the surface can start the
  // guided walkthrough in place instead of bouncing the user to Settings.
  // `hash` stays on every entry as the fallback for a surface that wires no
  // flow handler (and so every destination remains a real Settings section).
  //
  // `state.externalFlowsAvailable` comes from GET /api/auth/me — a deployment
  // with no GitHub-link support cannot offer them, and then this is exactly
  // the pre-#1049 list.
  // The two remedies that are NOT build venues, factored out because the
  // banner (#1348) shows one of them and nothing else from this list.
  function apiKeyOption(state) {
    var hasApiKey = !!(state || {}).hasApiKey;
    return {
      id: 'api-key',
      title: hasApiKey
        ? "Your saved key couldn't be used"
        : 'Use your own Anthropic API key',
      blurb: hasApiKey
        ? 'Homeroom has a key on file but could not use it for this turn. Open Settings → API key, check it and re-save it. The daily allowance is bypassed entirely while a working key is on file.'
        : 'Paste a key in Settings → API key and Homeroom keeps working exactly as it does now, billed to your Anthropic account instead of your daily allowance.',
      cta: hasApiKey ? 'Check API key' : 'Add API key',
      hash: SETTINGS_HASHES.apiKey,
      developer: false,
    };
  }

  function socialOption() {
    return {
      id: 'social-identity',
      title: 'Unlock $10/day with a social account',
      blurb: 'Connect GitHub or X to prove control of that account. Either one unlocks the same $10/day tier; they do not stack, and Homeroom keeps no provider token.',
      cta: 'Connect GitHub or X',
      hash: SETTINGS_HASHES.connector,
      developer: false,
    };
  }

  function options(state) {
    var s = state || {};
    var apiKey = apiKeyOption(s);
    // Every route out of here except the API key IS a build venue, so the
    // list comes from public/js/build-venues.js in `blocked` mode rather
    // than being retyped here. That is what stopped "use a coding tool on
    // your computer" from covering two different products: the CLI lease
    // keeps THIS session (Homeroom drives, your machine executes, same
    // transcript and proposal), while your own tools mean you working
    // alone and bringing the result back as a pull request with no
    // Homeroom chat at all. They are two rows now because they are two
    // answers.
    //
    // `usernode-claude` comes back marked unavailable in this mode — it is
    // the venue that just refused the turn. It is not a way to keep
    // building, so it is not in this list and not in the count; the card's
    // own lead sentence is where the refusal is stated.
    var BV = venues();
    var venueRows = BV
      ? BV.venuesFor({
        mode: 'blocked',
        openrouterAvailable: s.openrouterAvailable,
        cliAuthEnabled: s.cliAuthEnabled !== false,
        // #1281: the bridge is opt-in, so it is absent from the developer
        // expander unless this user turned it on. Unlike the flags around
        // it this one does NOT default true — an opt-in that defaults to
        // on is not an opt-in.
        sessionBridgeEnabled: !!s.sessionBridgeEnabled,
        externalFlowsAvailable: s.externalFlowsAvailable,
        canCollaborate: s.canCollaborate !== false,
        blockedReason: s.error || null,
      }).filter(function (row) { return !row.unavailable; })
      : [];
    var asOption = function (row) {
      return {
        id: row.id,
        title: row.label,
        blurb: row.blurb + ' ' + row.consequence,
        cta: row.cta,
        flow: row.mechanism.flow || null,
        hash: row.mechanism.hash || SETTINGS_HASHES.localTool,
        developer: !!DEVELOPER_MECHANISMS[row.mechanism.kind],
      };
    };
    // Running out of credits is the moment someone is most willing to try
    // another route (#1049), so the two that need no new account and no
    // card — the Claude or ChatGPT plan they already pay for, reachable in
    // one guided walkthrough without leaving the chat — lead. Everything
    // else keeps the original order behind the API key. When the
    // deployment cannot offer the web hand-offs at all this is exactly the
    // pre-#1049 shape, with the local pair split in two.
    var handoffs = venueRows.filter(function (r) { return r.mechanism.kind === 'flow'; });
    var rest = venueRows.filter(function (r) { return r.mechanism.kind !== 'flow'; });

    var out = handoffs.map(asOption);
    out.push(apiKey);
    rest.forEach(function (row) { out.push(asOption(row)); });
    if (!s.externalFlowsAvailable) {
      out.push({
        id: 'connector',
        title: 'Use your Claude.ai or ChatGPT subscription',
        blurb: 'Connect Homeroom to Claude or ChatGPT and let Claude Code on the web or Codex do the work on the plan you already pay for.',
        cta: 'Connect Claude or ChatGPT',
        hash: SETTINGS_HASHES.connector,
        developer: false,
      });
    }
    if (s.verificationRequired) {
      out.unshift(socialOption());
    }
    return out;
  }

  // "Three ways to keep building right now:" — the count moves with the
  // deployment (#1049) and now with the venue gating too, so it is spelled
  // from the list rather than frozen into the string. The ceiling is the
  // six venues plus the API key and the connector row.
  var NUMERALS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

  function introFor(list) {
    var n = list.length;
    var word = NUMERALS[n] || String(n);
    return word.charAt(0).toUpperCase() + word.slice(1)
      + (n === 1 ? ' way' : ' ways') + ' to keep building right now:';
  }

  // Lead sentence. `globalOut` means the PLATFORM's shared daily budget is
  // spent rather than this user's own allowance — all three routes bypass
  // it either way, so only the explanation changes.
  function lead(state) {
    var s = state || {};
    if (s.verificationRequired) {
      return 'Connect GitHub or X to unlock $10/day of Homeroom credits.';
    }
    return s.globalOut
      ? "The platform's shared daily AI budget is used up."
      : "You're out of today's free AI credits.";
  }

  function optionRowHtml(opt) {
    return ''
      + '<div class="dc-credits-option">'
      + '<div class="dc-credits-option-text">'
      + '<div class="dc-credits-option-title">' + escapeHtml(opt.title) + '</div>'
      + '<div class="dc-credits-option-blurb">' + escapeHtml(opt.blurb) + '</div>'
      + '</div>'
      + '<button type="button" class="dc-pr-btn dc-credits-go"'
      + (opt.flow ? ' data-credits-flow="' + escapeHtml(opt.flow) + '"' : '')
      + ' data-credits-hash="' + escapeHtml(opt.hash) + '">'
      + escapeHtml(opt.cta) + '</button>'
      + '</div>';
  }

  function optionsHtml(list) {
    return '<div class="dc-credits-options">'
      + (list || []).map(optionRowHtml).join('')
      + '</div>';
  }

  // The "Are you a developer?" half (#1281). A plain <details>, so the
  // disclosure costs no JavaScript and needs nothing from wire(): a click
  // on the summary matches neither selector the delegated handler looks
  // for, so it falls through and the browser toggles the element itself.
  //
  // The routes inside are REAL entries of the same list, with the same
  // `data-credits-hash` / `data-credits-flow` attributes as the rows above
  // — expanding is the only difference. That is what keeps every surface
  // honest about offering the same ways out.
  function developerHtml(list) {
    if (!list || !list.length) return '';
    return ''
      + '<details class="dc-credits-dev" data-credits-dev="1">'
      + '<summary class="dc-credits-dev-summary">Are you a developer?</summary>'
      + '<div class="dc-credits-dev-hint">'
      + 'Build it with the tools on your own computer instead.'
      + '</div>'
      + optionsHtml(list)
      + '</details>';
  }

  // The in-chat card. Rendered INSTEAD of an assistant markdown bubble by
  // DevChat.renderMessages when a message carries `creditsCard`.
  //
  // `state.error` is the platform's own billing message (limits.checkBudget
  // → "Daily limit reached ($20.00). Resets at midnight UTC."). It is
  // escaped, never injected — it is server text, but the card must not be
  // an HTML sink regardless.
  function cardHtml(state) {
    var s = state || {};
    var list = options(s);
    // #1281: the count still spells the WHOLE list. Three rows and an
    // expander over "Five ways to keep building right now" is a promise the
    // card keeps; counting only the visible three would hide that the other
    // two exist, which is the discovery failure this card was written for.
    var split = partition(list);
    return ''
      + '<div class="dc-credits-card" data-credits-card="1">'
      + '<div class="dc-credits-card-lead">' + escapeHtml(lead(s)) + '</div>'
      + (s.error
        ? '<div class="dc-credits-card-detail">' + escapeHtml(s.error) + '</div>'
        : '')
      + '<div class="dc-credits-card-intro">' + escapeHtml(introFor(list)) + '</div>'
      + optionsHtml(split.primary)
      + developerHtml(split.developer)
      + '</div>';
  }

  // Compact button row for the existing red banner. The first button keeps
  // the historical `dc-credits-add-key` id so anything already selecting it
  // (and the banner's own wiring) keeps resolving.
  // #1348: the banner offers exactly TWO routes, not one button per venue.
  //
  // It used to render all of options() — five or six buttons wrapping
  // across a strip that is already carrying a sentence, where the venue
  // ones were long ("Continue this session with Claude Code on the web")
  // and the reader had to weigh a whole menu to get out of a refusal. The
  // two are the only genuinely different answers: pay for it yourself, or
  // build it somewhere else. Which somewhere is the venue sheet's
  // question, and it is better at asking it — grouped, ticked, with a
  // consequence per row, and it MARKS the venue that just refused the turn
  // rather than silently dropping it.
  //
  // The full list has not gone anywhere: cardHtml() still renders every
  // route with its blurb, and that card is posted into the transcript on
  // the refusal itself. This is the bar; that is the page.
  function bannerActionsHtml(state) {
    var s = state || {};
    var actions = [
      // Whichever remedy leads in this state: an unverified account cannot
      // spend credits at all, so connecting one comes before paying.
      s.verificationRequired ? socialOption() : apiKeyOption(s),
      {
        id: 'venue',
        cta: 'Change session type',
        // No hash: this one opens the sheet in place. The fallback exists
        // because wire() falls through to a hash for surfaces that handle
        // nothing, and Settings is where a venue is otherwise changed.
        hash: SETTINGS_HASHES.localTool,
        venue: true,
      },
    ];
    return '<div class="dc-credits-banner-actions">'
      + actions.map(function (opt, index) {
        return '<button type="button"'
          + (index === 0 ? ' id="dc-credits-add-key"' : '')
          + ' class="dc-credits-banner-btn' + (index === 0 ? ' dc-credits-banner-btn-primary' : '')
          + '"' + (opt.venue ? ' data-credits-venue="1"' : '')
          + (opt.flow ? ' data-credits-flow="' + escapeHtml(opt.flow) + '"' : '')
          + ' data-credits-hash="' + escapeHtml(opt.hash) + '">'
          + escapeHtml(opt.cta) + '</button>';
      }).join('')
      + '</div>';
  }

  // One delegated click handler per mounted node. A real hash navigation
  // (not history.pushState) so the browser / device back gesture returns
  // the user to the chat they were refused in.
  //
  // `handlers.onFlow(flow)` (#1049) lets a surface handle the Claude Code /
  // Codex entries IN PLACE — the dev chat starts its walkthrough right there
  // rather than sending the user to Settings and back. A surface that wires
  // no handler falls through to the hash, which is why every option still
  // carries one.
  function wire(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__creditOptionsWired) return;
    root.__creditOptionsWired = true;
    var h = handlers || {};
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-credits-venue],[data-credits-flow],[data-credits-hash]')
        : null;
      if (!target || !root.contains(target)) return;
      // #1348: "Change session type" opens the venue sheet on the surface
      // that mounted us, anchored to the button it was clicked on. Falls
      // through to the hash when a surface wires no handler, which is the
      // same contract onFlow has.
      if (target.getAttribute('data-credits-venue') && typeof h.onVenue === 'function') {
        event.preventDefault();
        h.onVenue(target);
        return;
      }
      var flow = target.getAttribute('data-credits-flow');
      if (flow && typeof h.onFlow === 'function') {
        event.preventDefault();
        h.onFlow(flow);
        return;
      }
      var hash = target.getAttribute('data-credits-hash');
      if (!hash) return;
      event.preventDefault();
      window.location.hash = hash;
    });
  }

  var CreditOptions = {
    SETTINGS_HASHES: SETTINGS_HASHES,
    LOW_PCT: LOW_PCT,
    money: money,
    resetIn: resetIn,
    resetSentence: resetSentence,
    creditState: creditState,
    meterParts: meterParts,
    meterTone: meterTone,
    lowLead: lowLead,
    apiKeyOption: apiKeyOption,
    socialOption: socialOption,
    options: options,
    partition: partition,
    introFor: introFor,
    lead: lead,
    cardHtml: cardHtml,
    bannerActionsHtml: bannerActionsHtml,
    wire: wire,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CreditOptions;
  }
  if (typeof window !== 'undefined') {
    window.CreditOptions = CreditOptions;
  }
})();
