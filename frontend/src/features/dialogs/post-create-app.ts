/**
 * POST /api/apps, for every screen that makes a project: "What do you want
 * to make?" (../first-session/make.tsx), which both the first session and
 * the Create button open, and its More options, the New project dialog
 * (./create-app.tsx). One request, so the two say the same thing when it
 * fails.
 *
 * Three failures read differently: a fetch that throws never reached
 * Homeroom (a network error); a JSON reply carries the server's own `error`;
 * and a reply that is not JSON at all is an error page from in front of the
 * server (a deploy, a proxy), so it names the status rather than blaming the
 * network. Never throws.
 */
export async function postCreateApp(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'Network error. Try again.' };
  }
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: reported through the status below */
  }
  if (res.ok) return { ok: true, data: data || {} };
  if (data && typeof data.error === 'string' && data.error) return { ok: false, error: data.error };
  return { ok: false, error: `Homeroom couldn’t create the project (${res.status}). Try again in a moment.` };
}

/** The device's IANA time zone ("Europe/London"), or null where it cannot be read. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone ? zone : null;
  } catch {
    return null;
  }
}
