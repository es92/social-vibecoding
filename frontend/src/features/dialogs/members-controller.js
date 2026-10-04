/**
 * Members & approvals dialog — the behaviour half (#members-modal).
 *
 * MOVED, NOT REWRITTEN, out of public/js/app-view.js:14006-15232 by #1078
 * chunk I, following the repo's rule for relocating a public/js/** module
 * into the bundle: the code is the code that shipped, its publication onto
 * `window.AppView` is preserved for the callers that were not converted, and
 * the DOMContentLoaded-era bootstrap is replaced by an `init()` the island
 * calls from its layout effect.
 *
 * ── Why this one is a controller and not JSX ──────────────────────────
 *
 * The other eight dialogs became real components. This one cannot, yet, and
 * the reason is specific rather than a matter of size: `_wireMembersModal`
 * rebinds its pills and inputs with the cloneNode-swap idiom
 * (`parentNode.replaceChild(pill.cloneNode(true), pill)`), and five more
 * functions here paint their rosters with `innerHTML`. Both REPLACE nodes
 * React would otherwise own. Converting them is a rewrite of ~1,200 lines of
 * governance, approver and app-admin logic, which is a chunk of its own — and
 * #1078 is explicit that a conversion is like-for-like.
 *
 * So members.tsx renders a CONSTANT tree: every node inside the card is
 * markup the component emits once and never re-renders, which is the same
 * arrangement #admin-section-content and the app-secrets island use. React
 * owns the modal root's lifecycle — reveal, kit lift, dismiss — and this
 * module owns everything inside the card. One owner per node, which is the
 * invariant the seam exists to protect.
 *
 * ── What changed in the move ──────────────────────────────────────────
 *
 *   * The two `AppView.revealModal(modal)` calls are gone: the island reveals
 *     the dialog and `useStaticModal` stamps the ghost-click guard.
 *   * `openMembersModal` / `hideMembersModal` are split into an entry point
 *     that forwards to the island's controller and a `_load` / `_reset` half
 *     the island calls back into — the same split app-secrets-controller.js
 *     uses.
 *   * `escapeHtml` / `escapeAttr` were file-locals in app-view.js and are
 *     file-locals here, byte-identical (ai-credit.js carries its own pair for
 *     the same reason).
 *
 * Everything else is the code that was there, line for line.
 */

// The shell globals this block reaches for. They are resolved in `init()`
// rather than at module scope because the SSG prerender pass evaluates this
// module in Node, where there is no `window` — and because a classic script
// assigns them, which has not happened yet when a bundle module is imported.
let AppView;
let App;
let PlatformUI;
let Home;

// The island's open/close controller, or null before hydration. Registered by
// `useDialog('members')` — see use-dialog.ts. Looked up on every call rather
// than captured, because the island unregisters on unmount.
function dialogController() {
  if (typeof window === 'undefined') return null;
  const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
  return (dialogs && dialogs.members) || null;
}

// Verbatim from app-view.js, where both were file-local helpers.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }

const MembersDialog = {
  // ── Members & approvals modal ──────────────────────────────────────
  //
  // One modal, two concerns:
  //   - member list + invite typeahead (collab-private apps) →
  //     /collaborators, /invites, /api/users/search
  // State is re-fetched on every open so a stale modal can't show a
  // removed member or an already-accepted invite.

  _inviteDebounce: null,

  async _load() {
    const appData = AppView.appData;
    const modal = document.getElementById('members-modal');
    if (!modal) return;
    // No app loaded: don't fail silently (that's the "button does nothing"
    // symptom). Surface a one-line message. The island has already revealed
    // the dialog, so the tap visibly does something. The row only renders
    // when appData is set, so this is a defensive/diagnostic path.
    if (!appData) {
      console.warn('[members] openMembersModal called with no app loaded');
      const loadError = document.getElementById('members-load-error');
      if (loadError) {
        loadError.textContent = 'This app is still loading. Open Members & approvals again in a moment.';
        loadError.className = 'text-sm text-red-400 mb-4';
      }
      return;
    }
    // Self-app: the only sections that apply are the approval ones, so
    // the heading matches the "+" menu item's "Proposal approvals" label.
    const modalTitle = document.getElementById('members-modal-title');
    if (modalTitle) {
      modalTitle.textContent = appData.self_hosted ? 'Proposal approvals' : 'Members & approvals';
    }
    const loadError = document.getElementById('members-load-error');
    if (loadError) {
      loadError.textContent = '';
      loadError.className = 'hidden text-sm text-red-400 mb-4';
    }

    // Proposal-approvals section (issue #646): creator/admin only. Changes
    // open a dapp.json governance PR, so a repo is required.
    AppView._membersGov = {
      policy: appData.approver_policy === 'invited' ? 'invited' : 'anyone',
      atLeast: appData.approvals_required != null ? Number(appData.approvals_required) : null,
    };
    const govSection = document.getElementById('members-governance-section');
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus) { govStatus.textContent = ''; govStatus.className = 'text-red-400 text-sm hidden'; }
    if (govSection) {
      govSection.classList.toggle('hidden', !appData.can_manage);
      if (appData.can_manage) {
        AppView._renderMembersGovPills();
        // Set (rather than only add) disabled state on every open so a
        // repo-less app cannot leave stale controls behind for the next app.
        govSection.querySelectorAll('[data-m-approver-policy], [data-m-approvals-mode], #members-approvals-n, #members-approvals-propose')
          .forEach((p) => { p.disabled = !appData.repo_url; });
        if (!appData.repo_url) {
          if (govStatus) {
            govStatus.textContent = 'Approval-settings changes are proposed as a dapp.json pull request, and this app has no GitHub repository, so they\'re unavailable.';
            govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
            govStatus.classList.remove('hidden');
          }
        }
      }
    }

    // Approvers roster: managers can always fetch it; everyone else only
    // when the policy is 'invited' (read-only). The section itself stays
    // hidden until the roster fetch decides (_renderApprovers): under the
    // default 'anyone' policy an EMPTY roster keeps it hidden — the "No
    // approvers yet" empty state only misled there, since approvers don't
    // apply until the policy flips — while leftover rows (a dormant
    // roster) still show, with an explanatory note.
    const approversSection = document.getElementById('members-approvers-section');
    const showApprovers = appData.can_manage
      || (appData.approver_policy === 'invited' && appData.can_collaborate);
    if (approversSection) approversSection.classList.add('hidden');
    AppView._approversData = null;
    const approverInviteBox = document.getElementById('members-approver-invite');
    if (approverInviteBox) approverInviteBox.classList.toggle('hidden', !appData.can_manage);
    const apStatus = document.getElementById('members-approver-status');
    if (apStatus) { apStatus.textContent = ''; apStatus.className = 'text-sm mt-2'; }
    const apInput = document.getElementById('members-approver-invite-input');
    if (apInput) apInput.value = '';
    AppView._hideApproverSuggestions();
    // A previous open's abandoned initial-approvers draft must not leak
    // into this one.
    AppView._hideInitialApproversDraft();

    AppView._wireMembersModal();

    // Member list + invite input: collab-private apps only.
    const isPrivate = appData.collab_visibility === 'private';
    const inviteSection = document.getElementById('members-invite-section');
    const listSection = document.getElementById('members-list-section');
    if (inviteSection) inviteSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    if (listSection) listSection.classList.toggle('hidden', !isPrivate || !appData.can_collaborate);
    const status = document.getElementById('members-invite-status');
    if (status) { status.textContent = ''; status.className = 'text-sm mt-2'; }
    const input = document.getElementById('members-invite-input');
    if (input) input.value = '';
    AppView._hideInviteSuggestions();
    if (isPrivate && appData.can_collaborate) await AppView.loadCollaborators();
    if (showApprovers) await AppView.loadApprovers();
    // #788: collab-level — everyone who can see the modal can see who
    // administers the app; managers get the propose-a-PR editor (see
    // _renderAppAdmins). Reset the previous open's draft/status first so
    // one app's roster can't leak into another's.
    const appAdminsSection = document.getElementById('members-appadmins-section');
    if (appAdminsSection) appAdminsSection.classList.add('hidden');
    AppView._appAdminsData = null;
    AppView._appAdminsDraft = null;
    AppView._appAdminsKnown = null;
    AppView._hideAppAdminSuggestions();
    AppView._setAppAdminsStatus('', false);
    await AppView.loadAppAdmins();
  },

  // The entry point every legacy caller uses (the Dev "+" menu item, and
  // the invite-accepted path inside this file). Forwards to the island so
  // React state stays the source of truth; the fallback keeps the dialog
  // usable if something calls it before hydration.
  hideMembersModal() {
    const island = dialogController();
    if (island) { island.close(); return; }
    MembersDialog._reset();
  },

  // The state half, called by the island's onClose.
  _reset() {
    AppView._hideInviteSuggestions();
  },

  // Idempotent wiring: the cloneNode swap clears stale listeners, because this
  // modal's roster is re-rendered by innerHTML on every open. (It mirrored
  // Home.wireCreateButtons, which is gone — the block it wired is React's now
  // and keeps its element, so it needed neither the swap nor the helper.)
  _wireMembersModal() {
    const input = document.getElementById('members-invite-input');
    if (input) {
      const fresh = input.cloneNode(true);
      input.parentNode.replaceChild(fresh, input);
      fresh.addEventListener('input', () => {
        clearTimeout(AppView._inviteDebounce);
        AppView._inviteDebounce = setTimeout(() => AppView._searchInviteUsers(fresh.value.trim()), 200);
      });
      fresh.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = fresh.value.trim();
          if (name) AppView.sendInvite(name);
        }
        if (e.key === 'Escape') AppView._hideInviteSuggestions();
      });
    }

    // Proposal-approvals pills + at-least count (issue #646).
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          // Switching TO invited-approvers goes through the inline
          // "Initial approvers" step instead of an immediate confirm —
          // its Propose button is the explicit consent, and it lets the
          // user line up the roster in the same gesture.
          if (fresh.dataset.mApproverPolicy === 'invited'
              && AppView._membersGov.policy !== 'invited') {
            AppView._showInitialApproversDraft();
            return;
          }
          AppView._proposeGovernance({
            policy: fresh.dataset.mApproverPolicy,
            atLeast: AppView._membersGov.atLeast,
          });
        });
      });
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]')
      .forEach((pill) => {
        const fresh = pill.cloneNode(true);
        pill.parentNode.replaceChild(fresh, pill);
        fresh.addEventListener('click', () => {
          // Switch the segmented control right away — the tap must visibly
          // respond (the old handler left "Time & majority" highlighted, so
          // tapping "At least" read as a dead click). The highlight is a
          // display-only draft: _membersGov (the app's real settings) only
          // changes when the governance proposal merges, and _proposeGovernance
          // repaints from it if the user cancels or the proposal fails.
          AppView._showMembersGovModeDraft(fresh.dataset.mApprovalsMode);
          if (fresh.dataset.mApprovalsMode === 'default') {
            AppView._proposeGovernance({ policy: AppView._membersGov.policy, atLeast: null });
          }
        });
      });
    // At-least count: Enter or the Propose button opens the proposal. No
    // change-listener auto-propose — a number input fires `change` on every
    // spinner click, which popped a confirm dialog mid-adjustment.
    const nInput = document.getElementById('members-approvals-n');
    const proposeFromN = () => {
      const el = document.getElementById('members-approvals-n');
      const n = Math.max(1, Math.min(50, parseInt(el && el.value, 10) || 1));
      AppView._proposeGovernance({ policy: AppView._membersGov.policy, atLeast: n });
    };
    if (nInput) {
      const freshN = nInput.cloneNode(true);
      nInput.parentNode.replaceChild(freshN, nInput);
      freshN.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); proposeFromN(); }
      });
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) {
      const freshP = proposeBtn.cloneNode(true);
      proposeBtn.parentNode.replaceChild(freshP, proposeBtn);
      freshP.addEventListener('click', proposeFromN);
    }

    // Approver invite typeahead.
    const apInput = document.getElementById('members-approver-invite-input');
    if (apInput) {
      const freshAp = apInput.cloneNode(true);
      apInput.parentNode.replaceChild(freshAp, apInput);
      freshAp.addEventListener('input', () => {
        clearTimeout(AppView._approverInviteDebounce);
        AppView._approverInviteDebounce = setTimeout(
          () => AppView._searchApproverUsers(freshAp.value.trim()), 200
        );
      });
      freshAp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshAp.value.trim();
          if (name) AppView.sendApproverInvite(name);
        }
        if (e.key === 'Escape') AppView._hideApproverSuggestions();
      });
    }

    // Initial-approvers draft step (switching to invited-approvers).
    const iaInput = document.getElementById('members-initial-approver-input');
    if (iaInput) {
      const freshIa = iaInput.cloneNode(true);
      iaInput.parentNode.replaceChild(freshIa, iaInput);
      freshIa.addEventListener('input', () => {
        clearTimeout(AppView._initialApproverDebounce);
        AppView._initialApproverDebounce = setTimeout(
          () => AppView._searchInitialApprovers(freshIa.value.trim()), 200
        );
      });
      freshIa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshIa.value.trim();
          if (name) AppView._addDraftApprover(name);
        }
        if (e.key === 'Escape') AppView._hideInitialApproverSuggestions();
      });
    }
    const iaPropose = document.getElementById('members-initial-approvers-propose');
    if (iaPropose) {
      const freshIaP = iaPropose.cloneNode(true);
      iaPropose.parentNode.replaceChild(freshIaP, iaPropose);
      freshIaP.addEventListener('click', () => {
        AppView._proposeGovernance({
          policy: 'invited',
          atLeast: AppView._membersGov.atLeast,
          initialApprovers: [...AppView._govDraftApprovers],
          skipConfirm: true,
        });
      });
    }
    const iaCancel = document.getElementById('members-initial-approvers-cancel');
    if (iaCancel) {
      const freshIaC = iaCancel.cloneNode(true);
      iaCancel.parentNode.replaceChild(freshIaC, iaCancel);
      // Abandon the draft: repaint from the app's real settings (which
      // also collapses the block — see _renderMembersGovPills).
      freshIaC.addEventListener('click', () => AppView._renderMembersGovPills());
    }

    // App-admins editor (issue #788): typeahead + propose/cancel.
    const aaInput = document.getElementById('members-appadmins-input');
    if (aaInput) {
      const freshAa = aaInput.cloneNode(true);
      aaInput.parentNode.replaceChild(freshAa, aaInput);
      freshAa.addEventListener('input', () => {
        clearTimeout(AppView._appAdminsDebounce);
        AppView._appAdminsDebounce = setTimeout(
          () => AppView._searchAppAdminUsers(freshAa.value.trim()), 200
        );
      });
      freshAa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = freshAa.value.trim();
          if (name) AppView._addAppAdmin(name);
        }
        if (e.key === 'Escape') AppView._hideAppAdminSuggestions();
      });
    }
    const aaPropose = document.getElementById('members-appadmins-propose');
    if (aaPropose) {
      const freshAaP = aaPropose.cloneNode(true);
      aaPropose.parentNode.replaceChild(freshAaP, aaPropose);
      freshAaP.addEventListener('click', () => AppView._proposeAppAdmins());
    }
    const aaCancel = document.getElementById('members-appadmins-cancel');
    if (aaCancel) {
      const freshAaC = aaCancel.cloneNode(true);
      aaCancel.parentNode.replaceChild(freshAaC, aaCancel);
      // Abandon the draft: repaint from the app's real declared list.
      freshAaC.addEventListener('click', () => {
        const declared = AppView._appAdminsData && Array.isArray(AppView._appAdminsData.declared)
          ? AppView._appAdminsData.declared : [];
        AppView._appAdminsDraft = [...declared];
        AppView._hideAppAdminSuggestions();
        AppView._renderAppAdmins(AppView._appAdminsData);
      });
    }
  },

  async loadCollaborators() {
    const list = document.getElementById('members-list');
    if (!list || !AppView.appData) return;
    list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/collaborators`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._renderCollaborators(data.collaborators || []);
    } catch (err) {
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load members: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderCollaborators(rows) {
    const list = document.getElementById('members-list');
    if (!list) return;
    const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
    const canManage = !!AppView.appData?.can_manage;
    if (!rows.length) {
      list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No collaborators yet.</div>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const pending = r.status === 'invited';
      const tag = r.isCreator
        ? '<span class="text-[0.65rem] text-violet-700 font-medium ml-1 dark:text-violet-400">creator</span>'
        : (pending ? '<span class="text-[0.65rem] text-amber-800 font-medium ml-1 dark:text-amber-300">invited</span>' : '');
      // Remove/revoke: creator/admin for anyone but the creator; users
      // may remove themselves (leave). Mirrors the server rules.
      const canRemove = !r.isCreator && (canManage || r.userId === me.id);
      const removeBtn = canRemove
        ? `<button data-remove-user="${r.userId}" class="text-xs text-zinc-500 hover:text-red-500 px-2 py-1 dark:text-zinc-400" title="${pending ? 'Revoke invite' : (r.userId === me.id ? 'Leave app' : 'Remove')}">${pending ? 'Revoke' : (r.userId === me.id ? 'Leave' : 'Remove')}</button>`
        : '';
      return `<div class="flex items-center justify-between px-3 py-2 ${pending ? 'opacity-70' : ''}">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(r.username)}${tag}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/apps/${AppView.appData.slug}/collaborators/${btn.dataset.removeUser}`,
            { method: 'DELETE' }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // Leaving an app yourself: you may have just lost access —
          // bounce home rather than leave a dead view up. Home's address is
          // written BEFORE the dialog closes: a close first queues a
          // history.back() that lands after it and puts the viewer back on
          // the app they just left (#3683).
          if (Number(btn.dataset.removeUser) === me.id && !me.isAdmin) {
            App.navigateHome();
            AppView.hideMembersModal();
            return;
          }
          AppView.loadCollaborators();
        } catch (err) {
          PlatformUI.toast(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  },

  async _searchInviteUsers(q) {
    const box = document.getElementById('members-invite-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideInviteSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q, excludeApp: AppView.appData.slug });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideInviteSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button data-invite-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-invite-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView.sendInvite(btn.dataset.inviteUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideInviteSuggestions() {
    const box = document.getElementById('members-invite-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  async sendInvite(username) {
    const status = document.getElementById('members-invite-status');
    const input = document.getElementById('members-invite-input');
    AppView._hideInviteSuggestions();
    if (status) { status.textContent = 'Inviting…'; status.className = 'text-sm mt-2'; }
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (status) {
        status.textContent = `✓ Invited @${data.username || username}`;
        status.className = 'text-sm mt-2 import-status--ok';
      }
      if (input) input.value = '';
      AppView.loadCollaborators();
    } catch (err) {
      if (status) {
        status.textContent = err.message;
        status.className = 'text-sm mt-2 import-status--err';
      }
    }
  },

  // ── Proposal-approval governance (issue #646) ───────────────────────

  _membersGov: { policy: 'anyone', atLeast: null },
  _approverInviteDebounce: null,

  _renderMembersGovPills() {
    const { policy, atLeast } = AppView._membersGov;
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApproverPolicy === policy);
    });
    const mode = atLeast != null ? 'at_least' : 'default';
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApprovalsMode === mode);
    });
    const n = document.getElementById('members-approvals-n');
    if (n) {
      n.classList.toggle('hidden', atLeast == null);
      if (atLeast != null) n.value = String(atLeast);
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) proposeBtn.classList.toggle('hidden', atLeast == null);
    // Repainting from the real settings always collapses the
    // initial-approvers draft (cancel, failure, fresh open).
    AppView._hideInitialApproversDraft();
  },

  // Paint a locally-selected approvals mode without touching _membersGov:
  // the tapped pill highlights and the at-least count input + Propose
  // button reveal (or hide, back on "Time & majority"). Display-only —
  // the app's real settings still come from the merged governance PR;
  // every openMembersModal()/_renderMembersGovPills() repaints from
  // _membersGov, so an abandoned draft resets on the next open.
  _showMembersGovModeDraft(mode) {
    document.querySelectorAll('#members-governance-section [data-m-approvals-mode]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApprovalsMode === mode);
    });
    const showN = mode === 'at_least';
    const n = document.getElementById('members-approvals-n');
    if (n) {
      n.classList.toggle('hidden', !showN);
      if (showN) {
        n.value = String(AppView._membersGov.atLeast || 1);
        n.focus();
      }
    }
    const proposeBtn = document.getElementById('members-approvals-propose');
    if (proposeBtn) proposeBtn.classList.toggle('hidden', !showN);
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus && showN) {
      govStatus.textContent = 'Set the number of approvals, then tap Propose.';
      govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
    }
  },

  // ── Initial-approvers draft (switching to invited-approvers) ────────
  //
  // Tapping the "Invited approvers" pill on an 'anyone' app reveals this
  // inline step instead of an immediate confirm. It names who will be
  // able to approve once the change lands — the creator is auto-seeded
  // as the first approver by the merge-time reconcile when the roster is
  // empty (services/app-manifest.js applyGovernanceChange); the self-app
  // has no creator and falls back to full admins — and lets the user
  // pick extra approvers to invite in the same gesture. Display-only
  // like _showMembersGovModeDraft: _membersGov is untouched until the
  // proposal merges, and _renderMembersGovPills() collapses the draft.
  _govDraftApprovers: [],
  _initialApproverDebounce: null,

  _showInitialApproversDraft() {
    document.querySelectorAll('#members-governance-section [data-m-approver-policy]').forEach((p) => {
      p.classList.toggle('active', p.dataset.mApproverPolicy === 'invited');
    });
    AppView._govDraftApprovers = [];
    const block = document.getElementById('members-initial-approvers');
    if (block) block.classList.remove('hidden');
    const statusLine = document.getElementById('members-initial-approvers-status');
    if (statusLine) {
      const appData = AppView.appData || {};
      const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
      const roster = ((AppView._approversData && AppView._approversData.approvers) || [])
        .filter((r) => r.status === 'member');
      if (roster.length) {
        statusLine.textContent = `Current approvers stay in place: ${roster.map((r) => `@${r.username}`).join(', ')}. Add more people to invite below (optional).`;
      } else if (appData.self_hosted) {
        statusLine.textContent = 'Platform admins can approve proposals until invited approvers are added. Pick some below.';
      } else if (AppView._approversData && AppView._approversData.creatorId != null
                 && AppView._approversData.creatorId !== me.id) {
        statusLine.textContent = 'The app\'s creator will automatically become the first approver. Add more people to invite below (optional).';
      } else {
        statusLine.textContent = 'You\'ll automatically become this app\'s first approver. Add more people to invite below (optional).';
      }
    }
    const input = document.getElementById('members-initial-approver-input');
    if (input) { input.value = ''; input.focus(); }
    AppView._renderDraftApprovers();
    AppView._hideInitialApproverSuggestions();
    const govStatus = document.getElementById('members-governance-error');
    if (govStatus) {
      govStatus.textContent = 'Review the initial approvers, then tap Propose.';
      govStatus.className = 'text-sm text-zinc-500 dark:text-zinc-400';
    }
  },

  _hideInitialApproversDraft() {
    const block = document.getElementById('members-initial-approvers');
    if (block) block.classList.add('hidden');
    AppView._govDraftApprovers = [];
    AppView._hideInitialApproverSuggestions();
  },

  _renderDraftApprovers() {
    const list = document.getElementById('members-initial-approvers-list');
    if (!list) return;
    list.innerHTML = AppView._govDraftApprovers.map((u) =>
      `<div class="flex items-center justify-between px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(u)}<span class="text-[0.65rem] text-amber-800 font-medium ml-1 dark:text-amber-300">will be invited</span></span>
        <button type="button" data-remove-draft-approver="${escapeAttr(u)}" class="text-xs text-zinc-500 hover:text-red-500 px-2 py-1 dark:text-zinc-400">Remove</button>
      </div>`
    ).join('');
    list.querySelectorAll('[data-remove-draft-approver]').forEach((btn) => {
      btn.addEventListener('click', () => {
        AppView._govDraftApprovers = AppView._govDraftApprovers
          .filter((u) => u !== btn.dataset.removeDraftApprover);
        AppView._renderDraftApprovers();
      });
    });
  },

  _addDraftApprover(username) {
    const name = String(username || '').replace(/^@/, '').trim();
    if (!name) return;
    const lower = name.toLowerCase();
    if (!AppView._govDraftApprovers.some((u) => u.toLowerCase() === lower)) {
      AppView._govDraftApprovers.push(name);
    }
    const input = document.getElementById('members-initial-approver-input');
    if (input) input.value = '';
    AppView._hideInitialApproverSuggestions();
    AppView._renderDraftApprovers();
  },

  async _searchInitialApprovers(q) {
    const box = document.getElementById('members-initial-approver-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideInitialApproverSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideInitialApproverSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button type="button" data-draft-approver-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-draft-approver-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView._addDraftApprover(btn.dataset.draftApproverUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideInitialApproverSuggestions() {
    const box = document.getElementById('members-initial-approver-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  // Pill click → confirm → open a governance-change proposal (a PR that
  // edits dapp.json's `governance` block). NOT optimistic, like the
  // visibility pills: the controls keep showing the current settings
  // until the proposal passes, merges, and the redeploy's reconcile
  // fires the `governance_changed` WS event (handled in app.js).
  async _proposeGovernance({ policy, atLeast, initialApprovers, skipConfirm }) {
    const cur = AppView._membersGov;
    const targetPolicy = policy === 'invited' ? 'invited' : 'anyone';
    const targetN = atLeast != null ? Math.max(1, Math.min(50, Number(atLeast) || 1)) : null;
    if (targetPolicy === cur.policy && (targetN ?? null) === (cur.atLeast ?? null)) return;

    const statusEl = document.getElementById('members-governance-error');
    const setStatus = (msg, isError) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = `text-sm ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
      statusEl.classList.toggle('hidden', !msg);
    };
    setStatus('', false);

    // The initial-approvers step's Propose button IS the explicit
    // consent (skipConfirm) — every other path keeps the dialog.
    if (!skipConfirm && !await PlatformUI.confirm({
      title: 'Open an approval-settings proposal?',
      message: 'Changing the approval settings opens a proposal that is voted on under the current rules. The change applies after the vote passes and the app redeploys.',
      confirmLabel: 'Open proposal',
    })) {
      // The pill click already painted the tapped mode (see
      // _showMembersGovModeDraft) — snap back to the app's real settings.
      AppView._renderMembersGovPills();
      return;
    }

    const picked = Array.isArray(initialApprovers) ? initialApprovers.filter(Boolean) : [];
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/governance-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approverPolicy: targetPolicy,
          approvalsRequired: targetN,
          ...(picked.length ? { initialApprovers: picked } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        AppView._renderMembersGovPills();
        setStatus('A change to who runs this app is already waiting for approval. See it in the Workshop.', false);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      AppView._hideInitialApproversDraft();
      let msg = `Proposal opened (PR #${data.prNumber}). It needs the group's vote in the Dev tab's vote panel before the new settings apply.`;
      if (Array.isArray(data.inviteWarnings) && data.inviteWarnings.length) {
        msg += ` Some approver invites could not be sent: ${data.inviteWarnings.join('; ')}.`;
      }
      setStatus(msg, false);
      // Freshly-sent approver invites should appear in the roster right
      // away (the section reveals now that rows exist).
      if (picked.length) AppView.loadApprovers();
    } catch (err) {
      // No proposal opened — the draft highlight would misreport the
      // app's settings, so repaint from the real ones.
      AppView._renderMembersGovPills();
      setStatus(`Could not open the governance proposal: ${err.message}`, true);
    }
  },

  // Last-fetched /approvers payload (approvers + creatorId +
  // approverPolicy) — feeds the initial-approvers draft's status line
  // and the section-visibility rule in _renderApprovers. Reset on every
  // modal open so one app's roster can't leak into another's.
  _approversData: null,

  // #788: per-app admins. The roster's only writer is the deploy-time
  // reconcile of dapp.json's `admins` block, so the editor here never
  // mutates the roster directly: managers stage a draft (add / remove
  // rows locally) and Propose opens a PR editing that block
  // (POST .../admins-pr) — an explicit-approval proposal that won't
  // merge on a timer. Non-managers keep the read-only roster, hidden
  // when the app declares no admins (the normal state for almost every
  // app, not something to nag about).

  // Last-fetched /admins payload (admins + declared + unresolved +
  // canManage + openProposal). Reset on every modal open.
  _appAdminsData: null,
  // Working list of declared usernames being edited (display casing).
  // null = not initialized; re-seeded from `declared` on each load.
  _appAdminsDraft: null,
  // Lowercased usernames the typeahead has confirmed exist — added
  // names outside this set (and outside the resolved roster) get the
  // "no account with this username yet" note.
  _appAdminsKnown: null,

  async loadAppAdmins() {
    const section = document.getElementById('members-appadmins-section');
    const list = document.getElementById('members-appadmins-list');
    if (!section || !list || !AppView.appData) return;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/admins${AppView._demoQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._appAdminsDraft = [...(Array.isArray(data.declared) ? data.declared : [])];
      AppView._renderAppAdmins(data);
    } catch (err) {
      section.classList.remove('hidden');
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load app admins: ${escapeHtml(err.message)}</div>`;
    }
  },

  // Staging demo passthrough: the members modal has no URL of its own,
  // so forward the page's ?demo=1 to the admins fetch. In production the
  // server ignores it entirely.
  _demoQuery() {
    try {
      return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
    } catch { return ''; }
  },

  _setAppAdminsStatus(msg, isError) {
    const el = document.getElementById('members-appadmins-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `text-sm mt-2 ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
    el.classList.toggle('hidden', !msg);
  },

  // Canonical form for the dirty check, mirroring the server's
  // normalizeAdmins (services/app-admins.js): trimmed, lowercased,
  // deduped, sorted — so re-ordering or re-casing the same names never
  // reads as a change.
  _normAppAdmins(list) {
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim().toLowerCase();
      if (name) seen.add(name);
    }
    return [...seen].sort();
  },

  _appAdminsDirty() {
    const d = AppView._appAdminsData || {};
    const a = AppView._normAppAdmins(d.declared);
    const b = AppView._normAppAdmins(AppView._appAdminsDraft);
    return a.length !== b.length || a.some((v, i) => v !== b[i]);
  },

  _renderAppAdmins(data) {
    const section = document.getElementById('members-appadmins-section');
    const list = document.getElementById('members-appadmins-list');
    if (!section || !list) return;
    if (data) AppView._appAdminsData = data;
    const d = AppView._appAdminsData || {};
    const admins = Array.isArray(d.admins) ? d.admins : [];
    const unresolved = Array.isArray(d.unresolved) ? d.unresolved : [];
    const declared = Array.isArray(d.declared) ? d.declared : [];
    const appData = AppView.appData || {};
    // Managers get the editor — except on the self-app, where per-app
    // admins are deliberately not grantable (the deploy reconcile skips
    // self_hosted apps), so it keeps the read-only view.
    const editable = !!d.canManage && !appData.self_hosted;
    // With a proposal already up for vote the rows go read-only too —
    // one admins proposal in flight per app.
    const canEdit = editable && !d.openProposal;
    if (!Array.isArray(AppView._appAdminsDraft)) AppView._appAdminsDraft = [...declared];
    const draft = AppView._appAdminsDraft;

    // Section visibility: managers (outside the self-app) always see it
    // — an empty roster is the entry point for adding the first admin —
    // everyone else keeps the hide-when-empty rule.
    if (!editable && !admins.length && !unresolved.length) {
      section.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    section.classList.remove('hidden');

    const resolvedLower = new Set(admins.map((a) => a.username.toLowerCase()));
    const draftLower = new Set(draft.map((u) => u.toLowerCase()));
    const declaredLower = new Set(declared.map((u) => u.toLowerCase()));
    const rowCls = 'flex items-center justify-between gap-2 px-3 py-2 text-sm';
    const removeBtn = (u) => (canEdit
      ? `<button type="button" data-remove-appadmin="${escapeAttr(u)}" class="text-xs text-zinc-500 hover:text-red-500 px-2 py-1 shrink-0 dark:text-zinc-400">Remove</button>`
      : '');
    const undoBtn = (u) =>
      `<button type="button" data-restore-appadmin="${escapeAttr(u)}" class="text-xs text-zinc-500 hover:text-violet-500 px-2 py-1 shrink-0 dark:text-zinc-400">Undo</button>`;

    const rows = [];
    for (const name of declared) {
      const lower = name.toLowerCase();
      // A declared name matching no account is shown rather than
      // silently dropped — it's almost always a typo or someone who
      // hasn't signed up yet, and it starts working on the next deploy
      // once they do.
      const tag = resolvedLower.has(lower)
        ? '<span class="text-[0.65rem] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-400">Admin</span>'
        : '<span class="text-[0.65rem] text-zinc-500 dark:text-zinc-400" title="Declared in dapp.json but no account with this username exists yet">not a registered user</span>';
      if (draftLower.has(lower)) {
        rows.push(
          `<div class="${rowCls}${resolvedLower.has(lower) ? '' : ' opacity-60'}"><span class="truncate">@${escapeHtml(name)}</span>`
          + `<span class="flex items-center gap-1 shrink-0">${tag}${removeBtn(name)}</span></div>`
        );
      } else {
        // Staged removal: struck through, nothing has happened yet.
        rows.push(
          `<div class="${rowCls} opacity-60"><span class="truncate line-through">@${escapeHtml(name)}</span>`
          + '<span class="flex items-center gap-1 shrink-0"><span class="text-[0.65rem] text-red-700 font-medium dark:text-red-400">will be removed</span>'
          + `${canEdit ? undoBtn(name) : ''}</span></div>`
        );
      }
    }
    for (const name of draft) {
      const lower = name.toLowerCase();
      if (declaredLower.has(lower)) continue;
      // Staged addition. Unregistered names are allowed by design — the
      // roster starts granting once that person signs up and the app
      // next deploys — but flag them so a typo is visible before the
      // proposal opens.
      const known = resolvedLower.has(lower)
        || (AppView._appAdminsKnown && AppView._appAdminsKnown.has(lower));
      const note = known ? ''
        : '<span class="text-[0.65rem] text-zinc-500 dark:text-zinc-400" title="No account with this username yet. They\'ll become an admin once they sign up and the app next deploys">no account yet</span>';
      rows.push(
        `<div class="${rowCls}"><span class="truncate">@${escapeHtml(name)}</span>`
        + `<span class="flex items-center gap-1 shrink-0"><span class="text-[0.65rem] text-amber-800 font-medium dark:text-amber-300">will be added</span>${note}${removeBtn(name)}</span></div>`
      );
    }
    if (!rows.length) {
      rows.push('<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No app admins yet. App admins can manage this app\'s settings and force-merge its proposals.</div>');
    }
    list.innerHTML = rows.join('');
    list.querySelectorAll('[data-remove-appadmin]').forEach((btn) => {
      btn.addEventListener('click', () => AppView._removeAppAdmin(btn.dataset.removeAppadmin));
    });
    list.querySelectorAll('[data-restore-appadmin]').forEach((btn) => {
      btn.addEventListener('click', () => AppView._addAppAdmin(btn.dataset.restoreAppadmin));
    });

    // Editor controls. Set (not conditionally add) the disabled state:
    // the input/buttons are cloned on every wire, so a `disabled` left
    // over from a repo-less app's modal would survive into this one.
    const editEl = document.getElementById('members-appadmins-edit');
    if (editEl) editEl.classList.toggle('hidden', !canEdit);
    const noRepo = !appData.repo_url;
    const input = document.getElementById('members-appadmins-input');
    if (input) input.disabled = noRepo;
    const proposeBtn = document.getElementById('members-appadmins-propose');
    if (proposeBtn) proposeBtn.disabled = noRepo;
    const actions = document.getElementById('members-appadmins-actions');
    if (actions) actions.classList.toggle('hidden', !canEdit || !AppView._appAdminsDirty());

    // Managers get the shorter action-oriented explainer; read-only
    // viewers (incl. the self-app) keep the original static note.
    const note = document.getElementById('members-appadmins-note');
    if (note) {
      note.innerHTML = editable
        ? 'Changes are proposed as a pull request editing <code>dapp.json</code>&rsquo;s <code>admins</code> list. It needs real Yes votes and won&rsquo;t merge on a timer.'
        : 'Set in <code>dapp.json</code>. To change them, open a pull request that edits the <code>admins</code> list. That proposal needs real Yes votes and won&rsquo;t merge on a timer.';
    }

    // Default status: the open-proposal pointer or the no-repo hint.
    // Callers wanting a custom message (Propose result) overwrite after
    // rendering.
    if (editable && d.openProposal) {
      AppView._setAppAdminsStatus('A change to the app\'s admins is already waiting for approval. See it in the Workshop.', false);
    } else if (editable && noRepo) {
      AppView._setAppAdminsStatus('Admin changes are proposed as a dapp.json pull request, and this app has no GitHub repository, so they\'re unavailable.', false);
    } else {
      AppView._setAppAdminsStatus('', false);
    }
  },

  _addAppAdmin(username, { known = false } = {}) {
    const name = String(username || '').replace(/^@/, '').trim();
    if (!name) return;
    if (!Array.isArray(AppView._appAdminsDraft)) AppView._appAdminsDraft = [];
    const draft = AppView._appAdminsDraft;
    const lower = name.toLowerCase();
    if (!draft.some((u) => u.toLowerCase() === lower)) {
      // Mirrors the server-side MAX_APP_ADMINS cap (app-manifest.js).
      if (draft.length >= 20) {
        AppView._renderAppAdmins();
        AppView._setAppAdminsStatus('An app can declare at most 20 admins.', true);
        return;
      }
      draft.push(name);
    }
    if (known) {
      if (!AppView._appAdminsKnown) AppView._appAdminsKnown = new Set();
      AppView._appAdminsKnown.add(lower);
    }
    const input = document.getElementById('members-appadmins-input');
    if (input) input.value = '';
    AppView._hideAppAdminSuggestions();
    AppView._renderAppAdmins();
  },

  _removeAppAdmin(username) {
    const lower = String(username || '').toLowerCase();
    AppView._appAdminsDraft = (AppView._appAdminsDraft || [])
      .filter((u) => u.toLowerCase() !== lower);
    AppView._renderAppAdmins();
  },

  async _searchAppAdminUsers(q) {
    const box = document.getElementById('members-appadmins-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideAppAdminSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideAppAdminSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button type="button" data-appadmin-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-appadmin-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView._addAppAdmin(btn.dataset.appadminUser, { known: true }));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideAppAdminSuggestions() {
    const box = document.getElementById('members-appadmins-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  // Draft → confirm → open an admins-change proposal (a PR editing
  // dapp.json's `admins` array). NOT optimistic: the roster only
  // changes when the merged PR's redeploy runs reconcileAppAdmins, so
  // on success the list repaints from the CURRENT declared names with
  // the open-proposal pointer.
  async _proposeAppAdmins() {
    if (!AppView.appData) return;
    const d = AppView._appAdminsData || {};
    const declared = Array.isArray(d.declared) ? d.declared : [];
    const draft = Array.isArray(AppView._appAdminsDraft) ? [...AppView._appAdminsDraft] : [];
    if (!AppView._appAdminsDirty()) return;

    const emptying = !draft.length && declared.length > 0;
    const message = emptying
      ? 'This removes every app admin. Only the creator and platform admins will be able to manage the app. The change opens a proposal that needs real Yes votes and won\'t merge on a timer.'
      : 'Changing who administers this app opens a proposal. Because it grants app-level power, it will not merge on a timer: it needs real Yes votes to reach the app\'s normal threshold, and only a platform admin can force-merge it.';
    if (!await PlatformUI.confirm({
      title: 'Open an app-admins proposal?',
      message,
      confirmLabel: 'Open proposal',
    })) return;

    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/admins-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admins: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        if (AppView._appAdminsData) {
          AppView._appAdminsData.openProposal = {
            sessionId: data.sessionId, prNumber: data.prNumber, prUrl: data.prUrl,
          };
        }
        AppView._appAdminsDraft = [...declared];
        AppView._renderAppAdmins();
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (AppView._appAdminsData) {
        AppView._appAdminsData.openProposal = {
          sessionId: data.sessionId, prNumber: data.prNumber, prUrl: data.prUrl,
        };
      }
      AppView._appAdminsDraft = [...declared];
      AppView._renderAppAdmins();
      AppView._setAppAdminsStatus(`Proposal opened (PR #${data.prNumber}). It needs the group's vote in the Dev tab before the new admins apply.`, false);
    } catch (err) {
      // No proposal opened — keep the draft so nothing typed is lost.
      AppView._setAppAdminsStatus(`Could not open the admins proposal: ${err.message}`, true);
    }
  },

  async loadApprovers() {
    const list = document.getElementById('members-approvers-list');
    if (!list || !AppView.appData) return;
    list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>';
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/approvers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AppView._approversData = data;
      AppView._renderApprovers(data.approvers || []);
    } catch (err) {
      // Reveal the section so the failure isn't silently hidden.
      const section = document.getElementById('members-approvers-section');
      if (section) section.classList.remove('hidden');
      list.innerHTML = `<div class="px-3 py-2 text-sm text-red-400">Failed to load approvers: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderApprovers(rows) {
    const list = document.getElementById('members-approvers-list');
    if (!list) return;
    const me = (typeof App !== 'undefined' && App.user) ? App.user : {};
    // Final section visibility (see openMembersModal): under the default
    // 'anyone' policy the section only appears when leftover rows exist —
    // an empty roster there is the normal state, not a problem to fix —
    // and those dormant rows get an explanatory note.
    const policy = (AppView._approversData && AppView._approversData.approverPolicy)
      || (AppView.appData && AppView.appData.approver_policy) || 'anyone';
    const invited = policy === 'invited';
    const section = document.getElementById('members-approvers-section');
    if (section) section.classList.toggle('hidden', !invited && !rows.length);
    const dormantNote = document.getElementById('members-approvers-dormant-note');
    if (dormantNote) dormantNote.classList.toggle('hidden', invited || !rows.length);
    if (!rows.length) {
      // Only visible when the policy is 'invited' — honest about the
      // merge gate's empty-roster fallback (services/governance.js:
      // full admins act as the approver set).
      list.innerHTML = '<div class="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No approvers yet. Platform admins can approve proposals until an approver is added.</div>';
      return;
    }
    const canManage = !!AppView.appData?.can_manage;
    list.innerHTML = rows.map((r) => {
      const pending = r.status === 'invited';
      const tag = pending
        ? '<span class="text-[0.65rem] text-amber-800 font-medium ml-1 dark:text-amber-300">invited</span>'
        : '<span class="text-[0.65rem] text-violet-700 font-medium ml-1 dark:text-violet-400">approver</span>';
      // Remove/revoke: creator/admin for anyone; approvers may remove
      // themselves (leave). Mirrors the server rules.
      const canRemove = canManage || r.userId === me.id;
      const removeBtn = canRemove
        ? `<button data-remove-approver="${r.userId}" class="text-xs text-zinc-500 hover:text-red-500 px-2 py-1 dark:text-zinc-400" title="${pending ? 'Revoke invite' : (r.userId === me.id ? 'Stop being an approver' : 'Remove')}">${pending ? 'Revoke' : (r.userId === me.id ? 'Leave' : 'Remove')}</button>`
        : '';
      return `<div class="flex items-center justify-between px-3 py-2 ${pending ? 'opacity-70' : ''}">
        <span class="text-sm text-zinc-700 dark:text-zinc-300 truncate">@${escapeHtml(r.username)}${tag}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-approver]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/apps/${AppView.appData.slug}/approvers/${btn.dataset.removeApprover}`,
            { method: 'DELETE' }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          AppView.loadApprovers();
        } catch (err) {
          PlatformUI.toast(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  },

  async _searchApproverUsers(q) {
    const box = document.getElementById('members-approver-suggestions');
    if (!box || !AppView.appData) return;
    if (!q) { AppView._hideApproverSuggestions(); return; }
    try {
      const params = new URLSearchParams({ q });
      const res = await fetch(`/api/users/search?${params.toString()}`);
      if (!res.ok) return;
      const { users } = await res.json();
      if (!users || !users.length) { AppView._hideApproverSuggestions(); return; }
      box.innerHTML = users.map((u) =>
        `<button data-approver-user="${escapeAttr(u.username)}" class="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">@${escapeHtml(u.username)}</button>`
      ).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('[data-approver-user]').forEach((btn) => {
        btn.addEventListener('click', () => AppView.sendApproverInvite(btn.dataset.approverUser));
      });
    } catch { /* typeahead is best-effort */ }
  },

  _hideApproverSuggestions() {
    const box = document.getElementById('members-approver-suggestions');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  },

  async sendApproverInvite(username) {
    const status = document.getElementById('members-approver-status');
    const input = document.getElementById('members-approver-invite-input');
    AppView._hideApproverSuggestions();
    if (status) { status.textContent = 'Inviting…'; status.className = 'text-sm mt-2'; }
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/approver-invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (status) {
        status.textContent = `✓ Invited @${data.username || username} as an approver`;
        status.className = 'text-sm mt-2 import-status--ok';
      }
      if (input) input.value = '';
      AppView.loadApprovers();
    } catch (err) {
      if (status) {
        status.textContent = err.message;
        status.className = 'text-sm mt-2 import-status--err';
      }
    }
  },
};

// Moved into the React bundle by #1078 chunk I. The publication is kept
// because `AppView.openMembersModal` / `.hideMembersModal` and every
// `AppView.<member>` reference inside this block are how the unconverted
// callers still reach it: `Object.assign` folds every method here back onto
// the live AppView object, so those names resolve exactly as they did when
// they were declared inline.
export function init() {
  if (typeof window === 'undefined') return;
  ({ AppView, App, PlatformUI, Home } = window);
  if (!AppView) return;
  Object.assign(AppView, MembersDialog);
  // The entry point is the one name that must NOT be the moved method: it
  // forwards to the island instead of loading in place.
  AppView.openMembersModal = () => {
    const island = dialogController();
    if (island) { island.open(); return; }
    return MembersDialog._load();
  };
}

export { MembersDialog };
