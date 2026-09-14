// Launchpad decisions and session context, moved from public/js/launchpad.js
// for #1891. The own-tools guide is React-owned; web hand-offs still consume
// the escaped resume banner. No DOM writes or delegated Copy handlers here.
(function () {
  'use strict';

  // The venues with no Homeroom chat. Kept as a list rather than derived
  // from `chat: false` in build-venues.js so this module still answers
  // correctly when it is loaded without that one (the test harness does
  // exactly that), and asserted against it in tests/launchpad.test.js so
  // the two cannot drift.
  var LAUNCHPAD_VENUES = ['web-claude-code', 'web-codex', 'own-tools-pr'];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isLaunchpad(venueId) {
    return LAUNCHPAD_VENUES.indexOf(String(venueId || '')) !== -1;
  }

  // Shared session context for the React own-tools guide and web hand-offs.
  // A continuation needs both a real session and a branch; a branchless
  // session starts fresh work instead of sending the agent to a missing ref.
  function resumeTarget(state) {
    var s = state || {};
    var kind = String(s.targetKind || '');
    if (kind !== 'session' && kind !== 'proposal') return null;
    var branch = String(s.branchName || '').trim();
    var id = Number(s.targetId);
    if (!branch || !Number.isFinite(id) || id <= 0) return null;
    return { kind: kind, branch: branch, id: id };
  }

  function prefillText(state) {
    var s = state || {};
    var slug = String(s.slug || '').trim() || '<app slug>';
    var issue = Number(s.issueNumber);
    var hasIssue = Number.isSafeInteger(issue) && issue > 0;
    var title = String(s.sessionTitle || '').trim();
    var resume = resumeTarget(s);
    var lines = [resume
      ? 'Continue work already started on the Homeroom app `' + slug + '`.'
      : 'Create a proposal for the Homeroom app `' + slug + '`.'];
    lines.push('');
    lines.push('What to build: ' + (hasIssue ? 'issue #' + issue + (title ? ': ' + title : '')
      : title || '<describe the change here>'));
    if (hasIssue) lines.push('Read the issue and its discussion before starting, and link the proposal to issue #' + issue + '.');
    if (resume) {
      lines.push('');
      lines.push('Continue ' + resume.kind + ' #' + resume.id + ' on branch `' + resume.branch + '`.');
      lines.push('Read its saved spec and conversation, and start from the current head of that branch.');
      lines.push('Preserve the existing work. Do not start over or open a second proposal.');
      if (resume.kind === 'proposal') lines.push('Updating the existing proposal clears its votes and asks reviewers to re-review.');
    }
    return lines.join('\n');
  }

  // ── The resume banner ───────────────────────────────────────────────
  //
  // One line above the steps saying which of the two situations this
  // session is in, because the difference is invisible otherwise and the
  // consequence of missing it is lost work.
  //
  // Rendered for BOTH launchpad shapes: `own-tools-pr` puts it above its
  // own steps, and dev-chat.js prepends it to the web-venue wizard, which
  // has no idea a session can be branchless. That is why the markup lives
  // here rather than in either of them.
  //
  // Returns '' when there is nothing worth saying, so a caller can
  // concatenate it unconditionally.
  function resumeBannerHtml(state) {
    var s = state || {};
    var resume = resumeTarget(s);
    if (resume) {
      return ''
        + '<div class="dc-launchpad-resume" data-launchpad-resume="continue">'
        + '<div class="dc-launchpad-resume-title">Continuing this session’s branch</div>'
        + '<div class="dc-launchpad-resume-detail">There is work on <code>'
        + escapeHtml(resume.branch) + '</code> already. The instructions below tell your '
        + 'agent to start from its current commit, so nothing done here is lost. Copy them '
        + 'as they are: an agent that starts from the app’s default branch instead would '
        + 'rebuild this from scratch.</div>'
        + '</div>';
    }
    // A session with no branch yet is the normal case for a hand-off made
    // straight from the start screen (#1350). Say so plainly: there is
    // nothing to resume until the local agent implements the change.
    if (String(s.targetKind || '') === 'new') {
      return ''
        + '<div class="dc-launchpad-resume" data-launchpad-resume="new">'
        + '<div class="dc-launchpad-resume-title">Starting new work</div>'
        + '<div class="dc-launchpad-resume-detail">Nothing has been built in this session '
        + 'yet, so there is nothing to resume. Your agent starts from the app’s current '
        + 'code, implements and tests the change locally, then submits the result to Homeroom.</div>'
        + '</div>';
    }
    return '';
  }

  var Launchpad = {
    LAUNCHPAD_VENUES: LAUNCHPAD_VENUES,
    isLaunchpad: isLaunchpad,
    prefillText: prefillText,
    resumeBannerHtml: resumeBannerHtml,
    escapeHtml: escapeHtml,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Launchpad;
  }
  if (typeof window !== 'undefined') {
    window.Launchpad = Launchpad;
  }
}());
