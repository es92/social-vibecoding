/* Out-of-credits routes — the single source of truth for "your daily AI
 * credits ran out; here is how to keep building".
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
 * Every destination is a real Settings hash route (Settings.SECTIONS in
 * public/js/settings.js declares the same keys), so clicking one is an
 * ordinary hash navigation and the device back gesture returns to the
 * chat. tests/credit-options.test.js asserts the hashes correspond to
 * declared sections, so a renamed section can't silently produce a dead
 * link.
 */
(function () {
  'use strict';

  var SETTINGS_HASHES = {
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
  function options(state) {
    var s = state || {};
    var hasApiKey = !!s.hasApiKey;
    var apiKey = {
      id: 'api-key',
      title: hasApiKey
        ? "Your saved key couldn't be used"
        : 'Use your own Anthropic API key',
      blurb: hasApiKey
        ? 'Usernode has a key on file but could not use it for this turn. Open Settings → API key, check it and re-save it — the daily allowance is bypassed entirely while a working key is on file.'
        : 'Paste a key in Settings → API key and Usernode keeps working exactly as it does now, billed to your Anthropic account instead of your daily allowance.',
      cta: hasApiKey ? 'Check API key' : 'Add API key',
      hash: SETTINGS_HASHES.apiKey,
    };
    var localTool = {
      id: 'local-tool',
      title: 'Use a coding tool on your computer',
      blurb: 'Claude Code, Codex, Cursor or the Usernode CLI, running on your machine and your plan. Usernode hands it the task and turns the result into a proposal.',
      cta: 'Set up a coding tool',
      hash: SETTINGS_HASHES.localTool,
    };
    if (!s.externalFlowsAvailable) {
      return [
        apiKey,
        localTool,
        {
          id: 'connector',
          title: 'Use your Claude.ai or ChatGPT subscription',
          blurb: 'Connect Usernode to Claude or ChatGPT and let Claude Code on the web or Codex do the work on the plan you already pay for.',
          cta: 'Connect Claude or ChatGPT',
          hash: SETTINGS_HASHES.connector,
        },
      ];
    }
    return [
      {
        id: 'claude-code',
        title: 'Carry on in Claude Code',
        blurb: 'Usernode writes the work order; Claude Code on the web builds it on your own Claude plan and pushes to your fork. Usernode opens the pull request and imports it as a proposal. No credits, no API key.',
        cta: 'Use Claude Code',
        flow: 'claude-code',
        hash: SETTINGS_HASHES.connector,
      },
      {
        id: 'codex',
        title: 'Carry on in Codex',
        blurb: 'The same hand-off for Codex on the web and the ChatGPT plan you already pay for. Usernode guides you through linking GitHub, forking and submitting.',
        cta: 'Use Codex',
        flow: 'codex',
        hash: SETTINGS_HASHES.connector,
      },
      apiKey,
      localTool,
    ];
  }

  // "Three ways to keep building right now:" — the count moves with the
  // deployment (#1049), so it is spelled from the list rather than frozen
  // into the string.
  var NUMERALS = ['no', 'one', 'two', 'three', 'four', 'five'];

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
    return s.globalOut
      ? "The platform's shared daily AI budget is used up."
      : "You're out of today's free AI credits.";
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
    var rows = list.map(function (opt) {
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
    }).join('');
    return ''
      + '<div class="dc-credits-card" data-credits-card="1">'
      + '<div class="dc-credits-card-lead">' + escapeHtml(lead(s)) + '</div>'
      + (s.error
        ? '<div class="dc-credits-card-detail">' + escapeHtml(s.error) + '</div>'
        : '')
      + '<div class="dc-credits-card-intro">' + escapeHtml(introFor(list)) + '</div>'
      + '<div class="dc-credits-options">' + rows + '</div>'
      + '</div>';
  }

  // Compact button row for the existing red banner. The first button keeps
  // the historical `dc-credits-add-key` id so anything already selecting it
  // (and the banner's own wiring) keeps resolving.
  function bannerActionsHtml(state) {
    var s = state || {};
    return '<div class="dc-credits-banner-actions">'
      + options(s).map(function (opt, index) {
        return '<button type="button"'
          + (index === 0 ? ' id="dc-credits-add-key"' : '')
          + ' class="dc-credits-banner-btn' + (index === 0 ? ' dc-credits-banner-btn-primary' : '')
          + '"' + (opt.flow ? ' data-credits-flow="' + escapeHtml(opt.flow) + '"' : '')
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
        ? event.target.closest('[data-credits-flow],[data-credits-hash]')
        : null;
      if (!target || !root.contains(target)) return;
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
    options: options,
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
