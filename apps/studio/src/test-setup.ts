// Runs before every spec file, after Angular's own TestBed initialisation (angular.json → test.options.setupFiles).
//
// Studio's specs share ONE jsdom. `@angular/build:unit-test` defaults `isolate: false` "to align
// with the Karma/Jasmine experience", so every spec file runs in the same environment — and the
// same `localStorage`. `EditorStore` persists the workspace there and restores it on construction,
// so a tab opened by one spec file is silently already open when the next file starts. Which files
// share a worker is scheduling: `media-panel.spec` passed on every PR and failed on `main` with
// `expected 1 to be 2` — a tab `dashboard.spec` had opened was restored, and `open()` focused it
// rather than adding one.
//
// A spec cannot guard against state some OTHER file left behind, so the boundary is here: every
// test starts with empty browser storage, which is what per-file isolation would have given.

import { beforeEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// jsdom implements no `ResizeObserver`, and Foblex Flow (the workflow designer's canvas, EP-23.4)
// constructs one for every node and connector — without it the designer's spec throws before its
// first assertion. Nothing here measures layout, so an observer that never fires is the honest
// stand-in; a browser has the real one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
