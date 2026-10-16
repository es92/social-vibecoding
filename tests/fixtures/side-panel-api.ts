// Bundle the side panel's island, its store, its controller and the panel
// document's runtime together, for the reason ./parked-strip-api.ts gives:
// tests/lib/render-tsx.js bundles each entry on its own, so a store imported
// through a second entry would be a SECOND copy, and setting it would change
// nothing the component or the controller can see.
//
// ./mount.ts is deliberately NOT here: importing it installs listeners on the
// global window, and tests/side-panel.test.js installs what it drives by hand.
export { SidePanel as SidePanelIsland } from '../../frontend/src/features/side-panel/side-panel';
export {
  SidePanel,
  canTake,
  take,
  open,
  close,
  drop,
  back,
  expand,
  openFullWidth,
  pend,
  clearPending,
  appPresence,
  onClickCapture,
  onNavigate,
  embeddedApi,
  sideRouteFrom,
  DESKTOP_QUERY,
  _resetForTests,
} from '../../frontend/src/features/side-panel/controller';
export { installEmbeddedRuntime } from '../../frontend/src/features/side-panel/embedded';
export { sidePanelStore, sidePanelRefs, INITIAL } from '../../frontend/src/features/side-panel/store.js';
export { headerTitleStore } from '../../frontend/src/features/header/header-title-store.js';
export * as routes from '../../frontend/src/features/side-panel/routes';
export * as resize from '../../frontend/src/features/side-panel/resize';
