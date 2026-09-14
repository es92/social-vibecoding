// A system-browser trip must retain the app account as an expectation, never
// move its session cookie or OAuth state into the browser's independent realm.
export async function openNativeSocialConnect({ bridge, provider, accountId, origin }) {
  if (!['github', 'x'].includes(provider) || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('Your account could not be identified. Reopen Settings and try again.');
  }
  if (typeof bridge?.openExternal !== 'function') {
    throw new Error('Update the Homeroom app to open account connections in your browser.');
  }
  const url = new URL(`/api/me/social-identities/${provider}/connect`, origin);
  url.searchParams.set('account', String(accountId));
  try {
    const opened = await bridge.openExternal(url.href);
    if (opened !== true) throw new Error('browser_not_opened');
  } catch {
    throw new Error('Could not open your browser. Tap Connect to try again.');
  }
}

// Native foreground events refresh the original app session's proof. Keep
// listening after a cancellation too, so a later browser retry can complete.
export function watchSocialConnectReturn({ win, doc, refresh }) {
  let refreshing = false;
  let active = true;
  const onReturn = async () => {
    if (!active || doc.hidden || refreshing) return;
    refreshing = true;
    try { await refresh(); } finally { refreshing = false; }
  };
  win.addEventListener('focus', onReturn);
  doc.addEventListener('visibilitychange', onReturn);
  return () => {
    active = false;
    win.removeEventListener('focus', onReturn);
    doc.removeEventListener('visibilitychange', onReturn);
  };
}
