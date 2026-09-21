/**
 * The `unit` project's setup: give its jsdom files the same one the components
 * project gets, and give the node files nothing.
 *
 * Most of this project is `node` — no DOM, nothing to set up. A handful of
 * files opt into jsdom with `// @vitest-environment jsdom` to render a hook,
 * and those got NOTHING: Testing Library registers its own cleanup only when
 * `afterEach` is a GLOBAL (this repo runs vitest without `globals`), and
 * `src/tests/setup.ts` — which does that, and installs the jest-dom matchers,
 * the matchMedia / ResizeObserver / IntersectionObserver stubs and the 5 s
 * Testing Library budget — is loaded for the components project only.
 *
 * A hook left mounted keeps working. `useClawboxLogin` re-arms its poll from
 * its own `finally`, so the ones rendered here with a short interval polled on
 * past the tests that made them; when the file's jsdom was torn down the next
 * tick reached a `window` that no longer existed and React threw inside
 * setState. `--project unit` then exited 1 over a run in which all 630 files
 * and 9934 tests passed — and `test:coverage:ci` fails a PR on exactly that.
 * `src/tests/unit/unit-project-cleanup.test.ts` is what fails if this goes.
 *
 * Vitest has no per-environment setup file, so the choice is this guard or a
 * third project. This is the smaller of the two, and it keeps ONE setup file
 * rather than a second that would drift from it.
 */
export {};

if (typeof document !== "undefined") {
  // Dynamic and guarded on purpose: a static import would pull Testing Library
  // and jsdom's stubs into all ~9900 node tests, which have no DOM to apply
  // them to.
  await import("./setup");
}
