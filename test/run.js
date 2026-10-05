// Import every suite into one process. This keeps Windows environments that
// deny child-process spawning reliable while remaining compatible with the
// minimum supported Node 22.19 runtime.
//
// `client-bundle.test.js` reads the BUILT artifact, so run `node build.mjs`
// first (or use `npm test`, which does).
await import('./dag-core.test.js')
await import('./provenance-core.test.js')
await import('./client-layout.test.js')
await import('./client-bundle.test.js')
await import('./membership-closure.test.js')
await import('./fork-lineage.test.js')
await import('./provenance-integration.test.js')
await import('./host-integration.test.js')
// Drives the peer-workflow plane's SUCCESS path against a real git repository.
await import('./workflow-plane.test.js')
