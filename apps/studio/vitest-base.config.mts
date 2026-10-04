// Read by @angular/build:unit-test (`runnerConfig: true` in angular.json) — the builder's own
// settings stay in angular.json; this carries only what it has no option for.
//
// testTimeout: vitest's default is 5 s PER TEST. Alone, Studio's heaviest specs (an editor tab
// driven through a fake gateway, several saves, a reload) take one to two seconds; under the
// pre-push hook and `npm run verify`, Nx runs all 22 test projects at once and the same specs took
// 6.3 s — two of three full local runs failed on `recorders.spec.ts` / `profiles.spec.ts` with
// "Test timed out in 5000ms" and passed alone (#380). A timeout is a hang detector, not a
// performance budget: 20 s still catches a spec that waits forever, and stops CPU contention from
// refusing a push.
//
// maxWorkers: vitest forks one worker per core but one, and each builds its own jsdom + Angular
// environment. On an 8-core machine that is 7 environments: 93 s for the suite, 500 s of summed
// environment setup — and under the pre-push hook, beside 22 other projects and a kind cluster, one
// of those forks died ("Worker exited unexpectedly", which vitest re-throws as an unhandled 'error'
// and ends the run — #380). Two workers: 45 s for the same 274 tests. Fewer is faster here as well
// as lighter, because `isolate: false` already shares one environment per worker.
export default {
  test: {
    testTimeout: 20_000,
    maxWorkers: 2,
  },
};
