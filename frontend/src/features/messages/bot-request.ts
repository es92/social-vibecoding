/*
 * One request, one story: which request a piece of the bot's news or a tray
 * entry is about, and the colour its number wears. Shared by the activity
 * drawer (./bot-strip.tsx), the chat's news rows (./bot-news-line.tsx) and
 * the bot's own words (./format.tsx), with no imports of its own, so any of
 * them can read it.
 */

/**
 * The hue a request's number wears: eight picked to tell apart at a glance,
 * in an order where each is far from the next, so any eight requests in a row
 * all differ and neighbours contrast. Amber (the need colour) and blue
 * (actions) are not among them, so a tag never reads as either.
 */
const TAG_HUES = [350, 145, 265, 85, 322, 180, 20, 295];
export function requestHue(number: number): number {
  return TAG_HUES[((Math.trunc(number) % TAG_HUES.length) + TAG_HUES.length) % TAG_HUES.length];
}

/**
 * Which request something is about, as one key: its project, by the name the
 * person sees, and its number, or its first version. Null when it names no
 * request, and then nothing is folded or matched on it.
 */
export function requestKey(item: { appSlug?: string | null; appName?: string | null; issueNumber?: number | null; firstVersion?: boolean | null }): string | null {
  const project = String(item.appName || item.appSlug || '').trim().toLowerCase();
  if (!project) return null;
  if (item.firstVersion) return `${project}|first`;
  const n = Number(item.issueNumber);
  return Number.isInteger(n) && n > 0 ? `${project}|${n}` : null;
}
