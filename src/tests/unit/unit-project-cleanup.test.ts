// @vitest-environment jsdom
/**
 * The guard for `src/tests/setup-unit.ts`: this project must unmount what a
 * test rendered.
 *
 * Without it nothing does. Testing Library registers its own cleanup only when
 * `afterEach` is a global, and this repo runs vitest without `globals`; the
 * components project gets one from `src/tests/setup.ts`, which the unit project
 * did not load. So a hook rendered here stayed mounted for the rest of the
 * file — and a hook that re-arms a timer kept polling. `useClawboxLogin` does
 * exactly that (`src/lib/use-clawbox-login.ts`: the poll is re-armed from the
 * `finally` of every tick, and only the effect's cleanup stops it), and when
 * the file's jsdom was torn down the next tick reached a `window` that was no
 * longer there. `--project unit` exited 1 with two unhandled
 * `ReferenceError: window is not defined` over a run in which every one of its
 * 630 files passed, and `test:coverage:ci` fails a PR on that exit code.
 *
 * Two tests, in order, because that is the shape of the failure: the leak is
 * only visible to whatever runs AFTER the test that rendered.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";

let ticks = 0;

/** A hook that keeps working until it is unmounted — the shape of every
 *  polling hook in this project, with nothing else in it. */
function usePoller(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      ticks += 1;
      setN((v) => v + 1);
      if (!cancelled) timer = setTimeout(tick, 5);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return n;
}

describe("the unit project unmounts what a test rendered", () => {
  it("mounts a hook that keeps a timer of its own", async () => {
    renderHook(() => usePoller());
    await vi.waitFor(() => { expect(ticks).toBeGreaterThan(1); });
    expect(document.body.childElementCount).toBeGreaterThan(0);
  });

  it("and the next test finds it stopped, not still polling", async () => {
    // Nothing in this test rendered anything, so a container in the body — or
    // a counter that is still moving — is the previous test's, left running.
    expect(document.body.childElementCount).toBe(0);
    const before = ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(before);
  });
});
