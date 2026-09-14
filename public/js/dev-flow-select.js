/* The guided walkthrough for the two web hand-off venues (#1049).
 *
 * Homeroom has always had two ways to build a proposal: here on the
 * platform with the Homeroom agent and your daily AI credits, or by handing
 * a work order to the coding agent you already pay for — Claude Code
 * (claude.ai/code) or Codex (chatgpt.com/codex) — which pushes a branch to
 * your own fork that Homeroom turns into an ordinary proposal. The second
 * route existed only behind the MCP connector, so essentially nobody found
 * it.
 *
 * This module used to be BOTH doors: a picker card at the top of every
 * untouched session asking "how do you want to build this change?", plus
 * the walkthrough behind it. The picker is gone. It was one of three
 * prompts asking the venue question before a word had been typed, and it
 * could only offer three of the six venues that exist. The question is
 * asked once now, by public/js/build-venues.js, from the venue selector in
 * the session header. What is left here is the part that has no other
 * home: once
 * a hand-off is chosen, five steps run in place in the transcript and
 * watch the user's progress through them.
 *
 * Pure render + wire, no fetching. The caller (public/js/dev-chat.js) owns
 * the state, calls GET /api/apps/:slug/dev-flow/status, and re-renders; the
 * same split as public/js/credit-options.js, and the reason
 * tests/dev-flow-select.test.js can exercise every branch in node with no
 * DOM and no server.
 *
 * The step model is deliberately derived from the SERVER's status payload
 * rather than from anything the client remembers: closing the tab
 * mid-walkthrough and coming back must resume at the same step, and the
 * only thing that survives that is what the server can see (is GitHub
 * linked, is there a fork, is there an open task, has the branch been
 * pushed).
 */
(function () {
  'use strict';

  // Where the two hosted agents live. Same URLs the work order names in
  // services/external-agent-tasks.js — a person cannot follow "open Claude
  // Code" without them.
  var AGENT_URLS = {
    'claude-code': 'https://claude.ai/code',
    codex: 'https://chatgpt.com/codex',
  };

  // Same allowlist as DEV_FLOWS in src/routes/auth.js and the CHECK on
  // users.dev_flow_preference. tests/dev-flow-preference.test.js pins the
  // three together so a fourth flow cannot land in one place only.
  //
  // Id and venue label only. The blurbs and CTAs that used to live here
  // belonged to the PICKER card, and the picker is gone — public/js/
  // build-venues.js is the one place a venue is described to the user now,
  // and it covers three more venues than this list ever could. What stays
  // here is the allowlist, because these three ids are a persisted column's
  // domain and this module is one of the three copies that must agree.
  var FLOWS = [
    { id: 'platform', title: 'Homeroom · Claude' },
    { id: 'claude-code', title: 'Claude Code on the web' },
    { id: 'codex', title: 'Codex on the web' },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function agentLabel(agent) {
    if (agent === 'claude-code') return 'Claude Code';
    if (agent === 'codex') return 'Codex';
    return 'your coding agent';
  }

  function agentUrl(agent) {
    return AGENT_URLS[agent] || '';
  }

  // The chat product a hand-off's connector lives in. Claude Code on the web
  // signs in as a Claude.ai account and Codex as a ChatGPT one, and the
  // Homeroom connector is added in THAT account's settings — not in Claude
  // Code or Codex themselves.
  function connectorProduct(agent) {
    return agent === 'codex' ? 'ChatGPT' : 'Claude';
  }
  // Why the external flows are not on offer, in the user's words. The
  // server sends the reason code; this is the only place it becomes copy.
  function unavailableNote(reason) {
    if (reason === 'no_repository') {
      return 'This app has no GitHub repository yet, so it can only be built here on Homeroom.';
    }
    if (reason === 'platform_unavailable' || reason === 'link_unavailable' || reason === 'unavailable') {
      return 'Handing work to Claude Code or Codex is unavailable on this deployment right now.';
    }
    return '';
  }

  // ── The walkthrough ──────────────────────────────────────────────────
  //
  // Five steps, each resolved to 'done' | 'current' | 'todo' from the
  // server's status payload. Exactly one step is 'current': the first one
  // that is not done. That single rule is what makes the walkthrough
  // resumable — nothing is remembered on this side.

  function steps(status, agent) {
    var st = status || {};
    var gh = st.github || {};
    var fork = st.fork || null;
    var label = agentLabel(agent);
    // #1054 + #1071. A CONTINUATION goes back onto work that already exists,
    // so the instructions name that proposal and the step says so. The server
    // decides which it is; this only renders the difference.
    var targetKind = st.targetKind || null;
    // The connector is a REQUIREMENT now, not the advisory note it used to be
    // below this step. Without it the agent cannot call prepare_work, so it
    // has no base commit and no task id — there is nothing useful to hand it.
    var connected = !!(st.connectors && st.connectors.count > 0);

    var list = [
      {
        key: 'github',
        title: 'Link your GitHub account',
        done: !!gh.linked,
        detail: gh.linked
          ? 'Linked as ' + (gh.login || 'your GitHub account') + '.'
          : 'Identity only. Homeroom asks for no access to your repositories and stores no token. It just needs to know which GitHub account is yours, so the work comes back under your name.',
        actions: gh.linked ? [] : [{ action: 'link-github', label: 'Link GitHub', primary: true }],
      },
      {
        key: 'fork',
        title: 'Fork the app repository',
        // 'unknown' means the read failed, not that there is no fork. Treat
        // it as not-done but say so honestly rather than asserting.
        done: !!(fork && fork.state === 'ready'),
        detail: forkDetail(fork),
        actions: forkActions(fork),
      },
      {
        key: 'handoff',
        title: connected ? 'Hand it to ' + label : 'Connect Homeroom',
        // Terminal. Homeroom used to track the rest — a work order minted
        // here, a branch to watch for, a Submit button to come back and press
        // — and that tracking is exactly what left a stale work order sitting
        // in a launchpad nobody could clear. The agent asks what to build,
        // mints its own work order through the connector and submits it, so
        // there is nothing further for this tab to know.
        done: false,
        detail: connected
          ? handoffDetail(label, targetKind)
          : 'Homeroom hands ' + label + ' a short set of instructions; '
            + label + ' asks what you want to build and takes it from there: '
            + 'writing the work order, reading this app\'s rules, pushing the '
            + 'branch and opening the proposal. It needs the connector in the '
            + connectorProduct(agent) + ' account it runs as to do any of that.',
        actions: connected
          ? handoffActions(agent)
          : [{ action: 'link-connector', label: 'Connect Homeroom', primary: true },
            { action: 'refresh', label: 'Check again' }],
      },
    ];

    var currentSeen = false;
    return list.map(function (step) {
      var state = 'todo';
      if (step.done) {
        state = 'done';
      } else if (!currentSeen) {
        state = 'current';
        currentSeen = true;
      }
      return {
        key: step.key,
        title: step.title,
        state: state,
        detail: step.detail + (step.detailExtra || ''),
        // Only the step you are on offers buttons: three live "Check again"
        // buttons down the card is noise, and acting on a later step out of
        // order just produces an error the user did not need to see.
        actions: state === 'current' ? step.actions : [],
      };
    });
  }

  function shortSha(sha) {
    return String(sha || '').slice(0, 7) || 'the base commit';
  }

  function forkDetail(fork) {
    if (!fork) return 'Your agent needs somewhere to push. Homeroom checks GitHub for your fork of this app.';
    if (fork.state === 'ready') return 'Found ' + fork.owner + '/' + fork.repo + '.';
    if (fork.state === 'name_conflict') {
      return 'You already own a repository called ' + fork.repo.replace(/-usernode$/, '')
        + ' that is not a fork of this app, so fork it as ' + fork.repo + ' instead.';
    }
    if (fork.state === 'unknown') return 'Homeroom could not read GitHub just now, so it cannot tell whether you have a fork. Carry on and check again in a moment.';
    return 'No fork yet. Fork the app on GitHub, then come back and check again.';
  }

  function forkActions(fork) {
    if (!fork || fork.state === 'ready') return [];
    var actions = [];
    if (fork.pageUrl) {
      actions.push({ action: 'open-fork', label: 'Fork on GitHub', href: fork.pageUrl, primary: true });
    }
    actions.push({ action: 'refresh', label: 'Check again' });
    return actions;
  }
  function handoffDetail(label, targetKind) {
    var base = 'Copy the instructions and paste them into ' + label + '. It will ask '
      + 'what you want to build, then write the work order, push the branch and open '
      + 'the proposal itself. You do not come back here to finish.';
    if (targetKind === 'session' || targetKind === 'proposal') {
      base += ' The instructions name the ' + (targetKind === 'session' ? 'session' : 'proposal')
        + ' this continues, so the work lands as an update to it rather than as a second copy.';
    }
    return base;
  }

  function handoffActions(agent) {
    var actions = [{ action: 'copy', label: 'Copy instructions', primary: true }];
    var url = agentUrl(agent);
    if (url) actions.push({ action: 'open-agent', label: 'Open ' + agentLabel(agent), href: url });
    return actions;
  }

  // An action with an href renders as a REAL ANCHOR, not a button that
  // window.open()s it. The two differ only off desktop, which is where it
  // matters (#1312): mobile popup heuristics eat a scripted window.open the
  // moment anything about the tap looks indirect, and inside the Homeroom
  // app the anchor is what nav-link.js's delegated listener routes through
  // the bridge's openExternal — the app's webview is bound to the
  // platform's own domains and cannot navigate to github.com itself, by
  // anchor or window.open alike. Every other GitHub trip in this
  // transcript ("View on GitHub", the PR link) is an anchor for the same
  // reason. `busy` keeps the existing disabled-button rendering: an anchor
  // cannot be disabled, and the trip out is supposed to be unavailable
  // mid-request anyway.
  function actionHtml(action, busy) {
    var cls = 'dc-pr-btn dc-flow-action' + (action.primary ? ' dc-flow-action-primary' : '');
    if (action.href && !busy) {
      return '<a class="' + cls + '" href="' + escapeHtml(action.href) + '"'
        + ' target="_blank" rel="noopener"'
        + ' data-flow-action="' + escapeHtml(action.action) + '">'
        + escapeHtml(action.label) + '</a>';
    }
    var attrs = ' data-flow-action="' + escapeHtml(action.action) + '"'
      + (action.href ? ' data-flow-href="' + escapeHtml(action.href) + '"' : '')
      + (busy ? ' disabled' : '');
    return '<button type="button" class="' + cls + '"' + attrs + '>'
      + escapeHtml(action.label) + '</button>';
  }

  // ── The vendor toggle (#1281) ───────────────────────────────────────
  //
  // The spec's type 2 wireframe puts Claude / ChatGPT at the TOP of the
  // launchpad, with every step below adapting: "pick Claude or ChatGPT up
  // top; every step below adapts". Until now the vendor was fixed the
  // moment the flow was entered, and changing it meant backing out to the
  // venue sheet and picking the other row — which discards nothing, but
  // reads as leaving rather than as switching.
  //
  // Rendered as two buttons rather than a <select> so the current one is
  // legible without opening anything, which is the whole point of a toggle
  // on a phone. The inactive one carries the action; the active one is a
  // statement and is inert.
  function vendorToggleHtml(agent, busy) {
    var vendors = [
      { id: 'claude-code', label: 'Claude' },
      { id: 'codex', label: 'ChatGPT' },
    ];
    return '<div class="dc-flow-vendors" role="group" aria-label="Which agent builds this">'
      + vendors.map(function (v) {
        var on = v.id === agent;
        return '<button type="button" class="dc-flow-vendor'
          + (on ? ' dc-flow-vendor-on' : '') + '"'
          + (on ? ' aria-current="true"' : '')
          + (on || busy ? ' disabled' : '')
          + ' data-flow-action="vendor-' + escapeHtml(v.id) + '">'
          + escapeHtml(v.label) + '</button>';
      }).join('')
      + '</div>';
  }

  // The walkthrough card.
  //
  // `state`:
  //   agent   – 'claude-code' | 'codex'
  //   status  – the GET /api/apps/:slug/dev-flow/status payload (null while
  //             the first request is in flight)
  //   busy    – a request is running: buttons disable, nothing re-orders
  //   error   – a failed action's message, shown in place, never a toast
  //             the user can miss
  //   notice  – transient success text ("Copied.")
  function wizardHtml(state) {
    var s = state || {};
    var agent = s.agent || (s.status && s.status.task && s.status.task.agent) || 'claude-code';
    var label = agentLabel(agent);

    if (!s.status) {
      return '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
        + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
        + vendorToggleHtml(agent, true)
        + '<div class="dc-flow-card-detail">Checking where you are&hellip;</div>'
        + '</div>';
    }

    if (s.status.available === false) {
      return '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
        + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
        + vendorToggleHtml(agent, true)
        + '<div class="dc-flow-card-detail">'
        + escapeHtml(unavailableNote(s.status.reason) || 'This flow is unavailable right now.')
        + '</div>'
        + '<div class="dc-flow-actions">'
        + actionHtml({ action: 'cancel', label: 'Build here instead', primary: true }, false)
        + '</div>'
        + '</div>';
    }

    var list = steps(s.status, agent);
    var rows = list.map(function (step, index) {
      var mark = step.state === 'done' ? '✓' : String(index + 1);
      var actions = step.actions.length
        ? '<div class="dc-flow-actions">'
          + step.actions.map(function (a) { return actionHtml(a, !!s.busy); }).join('')
          + '</div>'
        : '';
      // A plain anchor, on purpose: it carries no data-flow-action, so
      // wire() leaves it alone and the browser's own hash navigation opens
      // Settings → Connectors in this tab, where the walkthrough resumes
      // from the server's status when the person comes back.
      var note = step.note
        ? '<div class="dc-flow-step-note" data-flow-note="connector">'
          + escapeHtml(step.note.before)
          + '<a href="' + escapeHtml(step.note.href) + '">' + escapeHtml(step.note.linkLabel) + '</a>'
          + escapeHtml(step.note.after)
          + '</div>'
        : '';
      var brief = step.brief
        ? '<textarea class="dc-flow-brief" data-flow-brief="1" rows="3"'
          + (s.busy ? ' disabled' : '')
          + ' placeholder="What should it build?">' + escapeHtml(s.brief || '') + '</textarea>'
        : '';
      return ''
        + '<div class="dc-flow-step dc-flow-step-' + step.state + '" data-flow-step="'
        + escapeHtml(step.key) + '" data-flow-step-state="' + step.state + '">'
        + '<div class="dc-flow-step-mark" aria-hidden="true">' + escapeHtml(mark) + '</div>'
        + '<div class="dc-flow-step-body">'
        + '<div class="dc-flow-step-title">' + escapeHtml(step.title) + '</div>'
        + '<div class="dc-flow-step-detail">' + escapeHtml(step.detail) + '</div>'
        + note
        + brief
        + actions
        + '</div>'
        + '</div>';
    }).join('');

    // The instructions in full, but COLLAPSED (#2088). #2041 opened this by
    // default: the text seemed short enough to just read, and reading what
    // you are about to paste into an agent is the point. In use the open box
    // took over the card, on a phone the whole screen, and the button people
    // actually press is Copy, which reads the status payload (dev-chat.js's
    // 'copy' action) and never this node. So the summary is what shows and
    // the text stays one tap away, still on the card for a clipboard that
    // refuses. The declared check on it asserts on the summary of a
    // details:not([open]), as the other details-based checks in dapp.json
    // do, because a collapsed body is not there to be seen.
    var order = s.status.instructions
      ? '<details class="dc-flow-order"><summary>Instructions</summary>'
        + '<pre class="dc-flow-order-text" data-flow-order="1">' + escapeHtml(s.status.instructions) + '</pre>'
        + '</details>'
      : '';

    // The server counts the user's connectors across every Claude and
    // ChatGPT account, so a non-zero count says nothing about the ONE account
    // the paste is going to — hence the per-account caveat, with the same
    // link the zero-connector note on the hand-off step carries.
    var connectors = s.status.connectors && s.status.connectors.count
      ? '<div class="dc-flow-card-hint">You already have ' + escapeHtml(String(s.status.connectors.count))
        + ' Claude / ChatGPT connector' + (s.status.connectors.count === 1 ? '' : 's')
        + ' connected. You can also just ask it to pick this task up.'
        + ' A connector belongs to the ' + escapeHtml(connectorProduct(agent))
        + ' account it was added in, so pasting into a different account needs its own:'
        + ' <a href="#settings/connectors">Settings → Connectors</a> has the steps.</div>'
      : '';

    return ''
      + '<div class="dc-flow-card dc-flow-wizard" data-flow-wizard="1">'
      + '<div class="dc-flow-card-lead">Building with ' + escapeHtml(label) + '</div>'
      + vendorToggleHtml(agent, !!s.busy)
      + (s.error ? '<div class="dc-flow-error">' + escapeHtml(s.error) + '</div>' : '')
      + (s.notice ? '<div class="dc-flow-notice">' + escapeHtml(s.notice) + '</div>' : '')
      + '<div class="dc-flow-steps">' + rows + '</div>'
      + order
      + connectors
      + '<div class="dc-flow-actions dc-flow-actions-footer">'
      + actionHtml({ action: 'cancel', label: 'Build on Homeroom instead' }, !!s.busy)
      + '</div>'
      + '</div>';
  }

  // One delegated click handler per mounted node, idempotent so repeated
  // renders never stack handlers (the same guard CreditOptions uses).
  //
  // `handlers`:
  //   onAction(action, button)  – a walkthrough button; 'open-fork' and
  //                               'open-agent' are anchors whose navigation
  //                               the BROWSER owns (see actionHtml) and are
  //                               still reported, so the caller can re-poll
  //                               after the trip out.
  function wire(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__devFlowWired) return;
    root.__devFlowWired = true;
    var h = handlers || {};
    root.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-flow-action]')
        : null;
      if (!target || !root.contains(target)) return;

      var action = target.getAttribute('data-flow-action');
      if (!action) return;
      // A real anchor's activation stays with the browser: preventDefault
      // here would put the trip out back through script, which is exactly
      // the path mobile drops (#1312). Everything else is a button, where
      // preventDefault is inert and the data-flow-href fallback keeps any
      // straggler non-anchor markup working.
      var isLink = String(target.tagName || '').toUpperCase() === 'A'
        && !!target.getAttribute('href');
      if (!isLink) {
        event.preventDefault();
        var href = target.getAttribute('data-flow-href');
        if (href && typeof window !== 'undefined' && window.open) {
          window.open(href, '_blank', 'noopener');
        }
      }
      if (typeof h.onAction === 'function') h.onAction(action, target);
    });
  }

  var DevFlowSelect = {
    FLOWS: FLOWS,
    AGENT_URLS: AGENT_URLS,
    agentLabel: agentLabel,
    agentUrl: agentUrl,
    connectorProduct: connectorProduct,
    unavailableNote: unavailableNote,
    steps: steps,
    vendorToggleHtml: vendorToggleHtml,
    wizardHtml: wizardHtml,
    wire: wire,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DevFlowSelect;
  }
  if (typeof window !== 'undefined') {
    window.DevFlowSelect = DevFlowSelect;
  }
})();
