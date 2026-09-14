// Promise-based confirm dialog that works inside Homeroom webviews.
//
// Why this exists: native window.confirm() blocks the JS thread and is
// suppressed or no-op'd in several webview hosts the platform runs in
// (mobile in-app browsers, the Homeroom wallet shell, etc.). Anything
// destructive that wants a "really?" gate has to use this instead.
//
// Since the native-kit adoption this is a thin adapter over
// PlatformUI.confirm (unNative.alert underneath) — the hand-rolled
// modal DOM is gone, but the public API is unchanged so the 11
// existing callers keep working:
//
//   const ok = await ConfirmModal.show({
//     title: 'Archive "fix-foo"?',
//     message: 'This drops Claude\'s memory and closes the PR.',
//     confirmLabel: 'Archive',
//     danger: true,
//   });
//   if (!ok) return;

(function () {
  function show(opts) {
    const {
      title = 'Are you sure?',
      message = '',
      confirmLabel = 'OK',
      cancelLabel = 'Cancel',
      danger = false,
    } = opts || {};

    if (window.PlatformUI && typeof window.PlatformUI.confirm === 'function') {
      return window.PlatformUI.confirm({ title, message, confirmLabel, cancelLabel, danger });
    }
    // Last-ditch fallback (PlatformUI failed to load): native confirm.
    let ok = false;
    try { ok = window.confirm([title, message].filter(Boolean).join('\n\n')); } catch {}
    return Promise.resolve(ok);
  }

  window.ConfirmModal = { show };
})();
