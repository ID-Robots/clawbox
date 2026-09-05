/**
 * The `unit` project's setup: unmount what a test rendered.
 *
 * Most of this project is `node` — no DOM, nothing to clean up. A handful of
 * files opt into jsdom with `// @vitest-environment jsdom` to render a hook,
 * and those got no cleanup from anywhere: Testing Library only registers its
 * own when `afterEach` is a GLOBAL (this repo runs vitest without `globals`),
 * and `src/tests/setup.ts`, which does it for the components project, is not
 * loaded here.
 *
 * A hook left mounted keeps working. `useClawboxLogin` re-arms a poll timer
 * from its own `finally`, so the ones rendered with a short interval polled on
 * past the tests that made them; when the file's jsdom was torn down the next
 * tick reached a `window` that no longer existed and React threw inside
 * setState. `--project unit` on beta then exited 1 with two unhandled
 * rejections over a run in which all 630 files and 9934 tests passed — and
 * `test:coverage:ci` fails a PR on exactly that.
 *
 * Unmounting is what stops it: every one of these hooks already clears its
 * timer on unmount, and none of them was ever unmounted.
 */
import { afterEach } from "vitest";

afterEach(async () => {
  // Node files pay one typeof and nothing else — and must not: importing
  // Testing Library without a DOM is an error, not a no-op.
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
