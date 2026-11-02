// Bundle the nav bridge, the strips and every store a remembered name is read
// from together, for the reason ./parked-strip-api.ts gives: tests/lib/
// render-tsx.js bundles each entry on its own, so a store imported separately
// is a SECOND copy and setting it changes nothing the bridge or a strip can
// see. The bridge is installed only where a `window` exists at load time.
import '../../frontend/src/features/nav/mount';

export { ParkedStrip } from '../../frontend/src/features/nav/parked-strip';
export { SideApps } from '../../frontend/src/features/nav/side-apps';
export { hasOwnName, knownFace, withKnownName } from '../../frontend/src/features/nav/app-names';
export { parkedStore, runningAppStore, PARKED_KEY } from '../../frontend/src/features/nav/parked-store.js';
export { recentAppsStore, RECENT_APPS_KEY } from '../../frontend/src/features/nav/recent-apps-store.js';
export { pinnedAppsStore } from '../../frontend/src/features/nav/pinned-apps-store.js';
export { communityScopeStore } from '../../frontend/src/features/workshop/community-scope';
