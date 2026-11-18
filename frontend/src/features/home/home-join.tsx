/**
 * Communities to join on the signed-in Home (One Home, #6361): the shared
 * section (./communities-to-join.tsx) over the public directory, less the
 * communities already on this Home, joined or pinned. A card opens the
 * project's page, where Join lives; joining there fires
 * sv:membership-changed, the store reads the pins back, and the card leaves
 * the list.
 */
import { useEffect, useMemo, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import type { GuestApp } from '../guest/guest-data';
import { CommunitiesToJoin, readDirectory } from './communities-to-join';
import { homePinsStore } from './home-pins-store';
import { useSettledHomeQuery } from './use-home-query';

export function HomeJoin() {
  const pins = useStoreState(homePinsStore);
  const query = useSettledHomeQuery();
  const [apps, setApps] = useState<GuestApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Read the directory as soon as Home mounts, not after the pins arrive
  // (#6604 review). The two reads are independent, and waiting for the pins
  // meant that when the directory had already failed, the section still drew
  // its four loading placeholders until the pins settled, so a failed read
  // looked like one still in flight. The section itself still draws only once
  // the pins are in, because they decide which communities are left out.
  //
  // Only while Home is the screen on show (#6591). Home stays mounted behind
  // every other screen, so reading at mount meant every page load, wherever
  // it landed, asked for the whole public directory: the slowest request the
  // shell makes. The read waits for the first time Home is shown; coming
  // back to Home asks `readDirectory` again, which answers from the read
  // already made.
  const shown = useVisibility('home-screen', true);
  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    setFailed(false);
    void readDirectory(attempt > 0).then((list) => {
      if (!live) return;
      // #6354 review: null is a directory that could not be read, which is
      // not the same as one with nothing in it: say so, and let them retry.
      if (list) setApps(list);
      else { setApps(null); setFailed(true); }
    });
    return () => { live = false; };
  }, [attempt, shown]);

  const exclude = useMemo(() => new Set([
    ...pins.joined.map((c) => c.slug),
    ...pins.pins.map((p) => p.slug),
  ]), [pins.joined, pins.pins]);

  if (!pins.ready) return <section id="home-join-section" className="px-3 pb-6" hidden />;
  return (
    <CommunitiesToJoin
      apps={apps}
      failed={failed}
      exclude={exclude}
      signedIn
      query={query}
      onRetry={() => { setApps(null); setAttempt((n) => n + 1); }}
    />
  );
}
