// Bundle the Communities page with the two stores it reads, for the reason
// ./parked-strip-api.ts gives: tests/lib/render-tsx.js bundles each entry on
// its own, so a store imported separately is a SECOND copy and setting it
// changes nothing the component can see.
export { CommunitiesScreen } from '../../frontend/src/features/communities';
export { homePinsStore } from '../../frontend/src/features/home/home-pins-store';
export { communityScopeStore } from '../../frontend/src/features/workshop/community-scope';
export { HomeCommunityMatches } from '../../frontend/src/features/home/pinned-communities';
