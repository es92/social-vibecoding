import { useEffect, useState } from 'react';

import { releaseTicking } from './release-eta';

/** How often a release estimate on screen is worded again. */
export const RELEASE_TICK_MS = 30 * 1000;

/**
 * The moment a release estimate is worded at (./release-eta.ts): the time of
 * this render, and a render again every RELEASE_TICK_MS while one of
 * `releases` still counts down, so "about 8 minutes" becomes "about 7
 * minutes" without reading anything again. Nothing ticks once none does
 * (rolling out, waiting, past its estimate, or none shown). The live flip
 * itself still comes from the read that finds the change live.
 */
export function useReleaseNow(...releases: unknown[]): number {
  const [, setTick] = useState(0);
  const now = Date.now();
  const ticking = releases.some((release) => releaseTicking(release, now));
  useEffect(() => {
    if (!ticking) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), RELEASE_TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}
