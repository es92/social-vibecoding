/**
 * When a merged change of the platform's own app goes live, in words.
 *
 * The platform releases at most once every ten minutes (#4309), and each
 * release also takes its image build and its rollout, so a change merged
 * into Homeroom itself waits ten to twenty minutes for the release that
 * carries it. A bare "Going live" for that long read as stuck. So every
 * surface that shows such a change says why, and when, in one sentence built
 * here from the server's `release` block (services/release-watch.js
 * releasesFor, `{ state, etaAt }`):
 *
 *   Merged; goes live in the next release (about 8 minutes)
 *   Merged; goes live in the next release (in about a minute)
 *   Merged; going live now          the rollout is under way, or the
 *                                   estimate has passed
 *   Merged; waiting for a release   nothing is promised: the release is
 *                                   stuck, and the board's banner says why
 *
 * A compact surface (a list row's second line, the bot's status line) says
 * the same thing without the "Merged" it already shows: "Goes live in about
 * 8 minutes".
 *
 * `etaAt` is a moment, not a count, so the minutes are worked out again
 * whenever a surface draws, and a read a few minutes old still says the
 * right thing. Only the platform's own app ever has a `release` block: a
 * child app goes live a minute or two after its merge, and a change still
 * being merged has not merged yet, so each keeps its "Going live".
 *
 * Classic scripts under public/js cannot import from this bundle, so the
 * module also publishes itself as `window.ReleaseEta`, which they read at
 * call time. The words read the viewer's clock, which the prerender does not
 * have: they are only ever drawn for data loaded after the first render.
 */

export type ReleaseState = 'next' | 'rolling' | 'waiting';

export interface ReleaseOutlook {
  /** next: in the next release, at etaAt; rolling: its release is rolling out; waiting: no promise. */
  state: ReleaseState;
  /** When the next release is expected to serve (ISO), for `next`. */
  etaAt: string | null;
}

const STATES: ReadonlySet<string> = new Set(['next', 'rolling', 'waiting']);

/** A server `release` block, or null for anything that is not one. */
export function releaseOf(value: unknown): ReleaseOutlook | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { state?: unknown; etaAt?: unknown };
  if (typeof v.state !== 'string' || !STATES.has(v.state)) return null;
  const etaAt = typeof v.etaAt === 'string' && Number.isFinite(Date.parse(v.etaAt)) ? v.etaAt : null;
  return { state: v.state as ReleaseState, etaAt };
}

/** Whether it goes live right now: its release is rolling out, or the estimate has passed. */
function isNow(r: ReleaseOutlook, now: number): boolean {
  if (r.state === 'rolling') return true;
  if (r.state !== 'next' || !r.etaAt) return false;
  return Date.parse(r.etaAt) <= now;
}

/**
 * Whole minutes until it goes live, at least 1: null when nothing is
 * counting down (rolling out now, past the estimate, waiting, or no time).
 */
export function releaseMinutes(release: unknown, now: number = Date.now()): number | null {
  const r = releaseOf(release);
  if (!r || r.state !== 'next' || !r.etaAt || isNow(r, now)) return null;
  return Math.max(1, Math.round((Date.parse(r.etaAt) - now) / 60000));
}

/** "about 8 minutes" or "in about a minute": the estimate's own words, or null. */
function when(minutes: number): string {
  return minutes <= 1 ? 'in about a minute' : `about ${minutes} minutes`;
}

/**
 * The sentence (see above): "Merged; goes live in the next release (about 8
 * minutes)". Null for anything that is not a release block, so a caller
 * falls back to its own words.
 */
export function releaseSentence(release: unknown, now: number = Date.now()): string | null {
  const r = releaseOf(release);
  if (!r) return null;
  if (r.state === 'waiting') return 'Merged; waiting for a release';
  if (isNow(r, now)) return 'Merged; going live now';
  const minutes = releaseMinutes(r, now);
  return minutes == null ? 'Merged; goes live in the next release' : `Merged; goes live in the next release (${when(minutes)})`;
}

/**
 * The same, for a line that already says the change merged (a row's second
 * line, the bot's status line): "Goes live in about 8 minutes". Null for
 * anything that is not a release block.
 */
export function releaseShort(release: unknown, now: number = Date.now()): string | null {
  const r = releaseOf(release);
  if (!r) return null;
  if (r.state === 'waiting') return 'Waiting for a release';
  if (isNow(r, now)) return 'Going live now';
  const minutes = releaseMinutes(r, now);
  if (minutes == null) return 'Goes live in the next release';
  return minutes <= 1 ? 'Goes live in about a minute' : `Goes live in about ${minutes} minutes`;
}

/**
 * The same for several at once, as the Done column counts them: "2 merged
 * changes go live in the next release (about 8 minutes)". They all go in the
 * same release, so one estimate is theirs. Null for anything that is not a
 * release block.
 */
export function releaseCountLine(release: unknown, count: number, now: number = Date.now()): string | null {
  const r = releaseOf(release);
  if (!r) return null;
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  const what = `${n} merged ${n === 1 ? 'change' : 'changes'}`;
  if (r.state === 'waiting') return `${what} waiting for a release`;
  if (isNow(r, now)) return `${what} going live now`;
  const minutes = releaseMinutes(r, now);
  return `${what} ${n === 1 ? 'goes' : 'go'} live in the next release${minutes == null ? '' : ` (${when(minutes)})`}`;
}

/** Whether a surface showing it has anything to count down, and so redraws now and then. */
export function releaseTicking(release: unknown, now: number = Date.now()): boolean {
  return releaseMinutes(release, now) != null;
}

const ReleaseEta = { releaseOf, releaseMinutes, releaseSentence, releaseShort, releaseCountLine, releaseTicking };

if (typeof window !== 'undefined') {
  (window as unknown as { ReleaseEta?: typeof ReleaseEta }).ReleaseEta = ReleaseEta;
}

export default ReleaseEta;
