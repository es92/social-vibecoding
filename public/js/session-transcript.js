// Read-only renderer for a SHARED dev-chat transcript.
//
// Where this appears: the shared-session topic page (and a proposal's page
// when its owner published the chat), inside the "Dev chat" section
// AppView._loadSessionTranscript paints. The payload comes from
// GET /api/sessions/:id/transcript, already sanitised server-side by
// services/transcript-share.js — this module renders it and nothing more.
//
// Why it is NOT DevChat.renderMessages: that renderer is bound to owner
// state — DevChat.currentSession, the live progress ticker, Q/A answer
// chips, platform-issue Report/Dismiss buttons, per-session <details>
// persistence. A reader has none of those, and several of them post to
// owner-scoped endpoints. So this is a separate, deliberately small
// renderer with three rules:
//
//   1. PURE STRING BUILDER. No DOM reads, no DevChat.currentSession, no
//      fetches — so tests/session-transcript-render.test.js can vm-load it
//      and assert on the HTML directly.
//   2. NOTHING INTERACTIVE THAT WRITES. No composer, no form, no send
//      button, no owner action buttons, no attachment links. Reading
//      someone's chat can never post into it, and the server enforces the
//      same thing (POST /chat is owner-scoped) — the missing UI is the
//      second layer, not the only one.
//   3. AGENT ACTIVITY COLLAPSED BY DEFAULT. The owner's own view opens
//      these (they're watching a live run); a reader is skimming a
//      finished conversation, so progress logs and raw agent summaries
//      start closed.
//
// It reuses the dev chat's dc-* classes so a shared transcript reads like
// the real thing rather than a second visual language.

(function () {
  // Standalone-safe helpers: the module is vm-loaded in tests without the
  // app shell, and app-view.js's escapeHtml is a separate global.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Markdown via the dev chat's own renderer when it's loaded (it is, in
  // the real app — dev-chat.js ships before app-view.js). It's a pure
  // helper with module-local state only, so calling it cross-module is
  // safe. Fallback: escaped text in a <pre>-ish wrapper, never raw HTML.
  function md(text) {
    if (typeof DevChat !== 'undefined' && DevChat && typeof DevChat.renderMarkdown === 'function') {
      try { return DevChat.renderMarkdown(text); } catch { /* fall through */ }
    }
    return '<p class="dc-p">' + esc(text).replace(/\n/g, '<br>') + '</p>';
  }

  function humanSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // #1808: the age AND the unelided stamp behind it. `relStamp` is a global
  // function declaration in app-view.js, which is a sibling classic script —
  // the `typeof` probe is because this file also renders on pages that load
  // it without app-view.js, where a missing stamp beats a ReferenceError.
  function relStampSafe(ts) {
    if (!ts) return { text: '', title: '' };
    if (typeof relStamp === 'function') {
      try { return relStamp(ts); } catch { /* fall through */ }
    }
    return { text: '', title: '' };
  }

  // Attachment chips: NAME ONLY, and deliberately a <span>, not an <a>.
  // The sanitiser strips attachment ids precisely so no URL can be built
  // here; rendering a link shape would promise a download that 404s (and
  // would be the first thing to accidentally re-point at the owner-scoped
  // bytes route later).
  function attachmentsHtml(msg) {
    const atts = msg && msg.metadata && msg.metadata.attachments;
    if (!Array.isArray(atts) || !atts.length) return '';
    const items = atts.map((a) => {
      const name = esc((a && a.filename) || 'file');
      const size = humanSize(a && a.sizeBytes);
      const icon = a && a.kind === 'image' ? '🖼' : '📎';
      return '<span class="dc-msg-att-chip st-att-chip" title="' + name
        + ' (attachments aren\'t shared, only their names)"><span aria-hidden="true">' + icon + '</span>'
        + '<span class="dc-attach-name">' + name + '</span>'
        + (size ? '<span class="dc-attach-size">' + esc(size) + '</span>' : '')
        + '</span>';
    }).join('');
    return '<div class="dc-msg-attachments">' + items + '</div>';
  }

  // One <details> holding the agent's activity for a status row: the
  // progress log lines and/or the agent's own summary text. No `open`
  // attribute — see rule 3 above; the test pins this.
  function agentActivityHtml(msg) {
    const meta = (msg && msg.metadata) || {};
    const lines = Array.isArray(meta.progressLog) ? meta.progressLog.filter(Boolean) : [];
    const summary = typeof meta.ccOutput === 'string' ? meta.ccOutput.trim() : '';
    if (!lines.length && !summary) return '';

    const label = lines.length && summary
      ? 'Agent activity (' + lines.length + ' steps) and summary'
      : (lines.length ? 'Agent activity (' + lines.length + ' steps)' : 'Agent summary');

    let body = '';
    if (lines.length) {
      body += lines.map((l) => '<div class="dc-cc-progress">' + esc(l) + '</div>').join('');
    }
    if (summary) {
      body += '<div class="st-cc-summary">' + md(summary) + '</div>';
    }
    return '<details class="dc-cc-attached st-agent-details">'
      + '<summary class="dc-cc-attached-summary dc-status-line">'
      + '<span class="dc-status-icon" aria-hidden="true">&#9881;</span>'
      + '<span>' + esc(label) + '</span>'
      + '<span class="dc-cc-attached-chevron" aria-hidden="true"></span>'
      + '</summary>'
      + '<div class="st-agent-body">' + body + '</div>'
      + '</details>';
  }

  // Spec snippets render as STATIC text, with no "View full spec" link: a
  // reader isn't authorised on GET /specs/:version unless that version was
  // separately shared to the group, so a link would mostly 404. The
  // snippet the sanitiser passed through is what they get.
  function specPreviewHtml(msg) {
    const meta = (msg && msg.metadata) || {};
    if (typeof meta.specPreview !== 'string' || !meta.specPreview.trim()) return '';
    const version = meta.specVersion != null ? 'Spec v' + meta.specVersion : 'Spec drafted';
    const lines = meta.specLines != null ? ' · ' + meta.specLines + ' lines' : '';
    return '<div class="st-spec-card">'
      + '<div class="st-spec-head">' + esc(version + lines) + '</div>'
      + '<div class="st-spec-snippet">' + md(meta.specPreview) + '</div>'
      + '</div>';
  }

  // #2597: the running row says the EVENT, and the venue underneath.
  //
  // The owner's dev chat rewrites "<venue> is running" into one heading with
  // the venue as a muted caption (`_runningRowLabel` in
  // frontend/src/features/dev-chat/dev-chat.js). These are the same rows read
  // by somebody who was not in the session, so they have to say the same
  // thing. The rule is duplicated rather than borrowed on purpose: this
  // renderer's whole point is that it works without dev-chat.js loaded, and
  // the markdown fallback path is tested with DevChat absent.
  //
  // The venue comes from the row's metadata, with the sentence's own wording
  // as the fallback the older rows — written before a backend was recorded —
  // depend on.
  var RUNNING_VENUE_RE = /^(?:Claude Code|Codex|OpenRouter) is running\b/i;

  function runningRowLabel(msg, text) {
    const m = RUNNING_VENUE_RE.exec(text);
    if (!m) return null;
    const meta = (msg && msg.metadata) || {};
    const openrouter = meta.agentBackend === 'codex_openrouter'
      || /^(?:Codex|OpenRouter)\b/i.test(text);
    return {
      text: 'Coding agent is running' + text.slice(m[0].length),
      caption: openrouter ? 'Homeroom \u00b7 OpenRouter' : 'Homeroom \u00b7 Claude',
    };
  }

  function systemRowHtml(msg) {
    const activity = agentActivityHtml(msg);
    const spec = specPreviewHtml(msg);
    // A row whose only content was withheld by the sanitiser (a ccLog row
    // becomes content + empty metadata) still has its status line, which
    // is fine — it's the same one-line "Claude Code log" the owner sees.
    // Rows with no content at all render nothing.
    const text = String((msg && msg.content) || '').trim();
    const running = text ? runningRowLabel(msg, text) : null;
    const line = text
      ? '<div class="dc-status-line' + (running ? ' dc-status-line-captioned' : '') + '">'
        + '<span class="dc-status-icon dc-status-check" aria-hidden="true">&#10003;</span>'
        + '<span>' + esc(running ? running.text : text) + '</span>'
        + (running ? '<span class="dc-status-venue">' + esc(running.caption) + '</span>' : '')
        + '</div>'
      : '';
    return line + activity + spec;
  }

  function convoRowHtml(msg, ownerName) {
    const isUser = msg.role === 'user';
    const who = isUser ? (ownerName || 'them') : 'AI';
    const cls = isUser ? 'dc-msg-user' : 'dc-msg-assistant';
    const when = relStampSafe(msg.created_at);
    return '<div class="dc-msg ' + cls + ' st-msg">'
      + '<div class="dc-msg-header">'
      + '<span class="st-msg-who">' + esc(who) + '</span>'
      + (when.text
        ? '<span class="st-msg-when" title="' + esc(when.title) + '">' + esc(when.text) + '</span>'
        : '')
      + '</div>'
      + '<div class="dc-msg-content">' + md(msg.content || '') + '</div>'
      + attachmentsHtml(msg)
      + '</div>';
  }

  // The whole section body. `payload` is the /transcript response verbatim:
  // { session: { username, message_count, ... }, messages: [...], truncated }.
  function renderHtml(payload) {
    const data = payload || {};
    const session = data.session || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const ownerName = session.username || 'them';

    if (!messages.length) {
      return '<div class="st-empty">This chat has no messages yet.</div>';
    }

    let html = '';
    if (data.truncated) {
      html += '<div class="st-truncated">Showing the most recent part of a long chat.'
        + ' earlier messages aren\'t included.</div>';
    }
    html += '<div class="st-timeline">';
    for (const msg of messages) {
      if (!msg || !msg.role) continue;
      html += msg.role === 'system' ? systemRowHtml(msg) : convoRowHtml(msg, ownerName);
    }
    html += '</div>';
    return html;
  }

  // The collapsed header line the topic page shows before the reader opens
  // the transcript ("Read the dev chat (24 messages)"), plus the expanded
  // header. Kept here so the copy lives beside the renderer.
  //
  // The expanded line does NOT say "read-only". It used to, and the toggle it
  // sits in renders a `.st-readonly-tag` chip saying exactly that right after
  // it — so an opened transcript read "Dev chat by alice · 24 messages ·
  // read-only read-only". The chip is the one that stays: it is the styled
  // affordance, it is there in both states, and it is what the tag class was
  // added for.
  function headerText(session, opts) {
    const s = session || {};
    const count = Number(s.message_count);
    const n = Number.isFinite(count) && count > 0 ? count : null;
    if (opts && opts.expanded) {
      return 'Agent session by ' + (s.username || 'them')
        + (n ? ' · ' + n + ' message' + (n === 1 ? '' : 's') : '');
    }
    return n ? 'Read the agent session (' + n + ' messages)' : 'Read the agent session';
  }

  window.SessionTranscript = { renderHtml, headerText, _esc: esc };
})();
