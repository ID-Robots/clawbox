import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * That the Hermes chat-capability memos are WARMED at boot, and warmed safely.
 *
 * `/setup-api/chat/capabilities` asks three facts that each start a Python
 * interpreter on a cold cache, and the chat asks for them on every mount. The
 * warm-up pays that once after boot so the first chat open answers from the
 * memos. Like the transcript-sweep test next door, this reads the boot file
 * rather than calling `register()`, because that function `require()`s its
 * dependencies to keep Node APIs out of Next's Edge bundle. What can regress
 * silently is the WIRING — and the guards on it — so that is what is pinned:
 *
 *   - it is deferred, and past the boot rush: a probe that times out under
 *     load is held as a 60 s backoff, which would hide the attach button for
 *     exactly the chat open it is meant to speed up;
 *   - the timer is unref'd, so a server that is shutting down does not wait
 *     for it;
 *   - it is gated on the ACTIVE HARNESS, not on whether `hermes` is installed:
 *     an OpenClaw box can carry a Hermes checkout, and no OpenClaw capability
 *     reads these facts;
 *   - a failure is swallowed — the first chat open asks for itself.
 *
 * Which memos are warmed, and that warming never rejects, is the feature
 * module's own business and is covered in `hermes-features-probe.test.ts`.
 */

const BOOT_FILE = path.join(process.cwd(), "src", "instrumentation.ts");
const source = fs.readFileSync(BOOT_FILE, "utf8");

/**
 * The warm-up block: from its `require` of the features module to the end of
 * its own timer. Cut at that `.unref()` rather than at a fixed length, so the
 * memory scheduler armed right after it — with a `.catch` of its own — cannot
 * satisfy an assertion meant for this block.
 */
function warmupBlock(): string {
  const start = source.indexOf("harness/hermes-features");
  expect(start).toBeGreaterThan(-1);
  const unref = source.indexOf(".unref()", start);
  expect(unref).toBeGreaterThan(start);
  return source.slice(start, unref + ".unref()".length);
}

describe("boot warms the hermes chat capability memos", () => {
  it("calls the warm-up, rather than only importing it", () => {
    expect(warmupBlock()).toMatch(/warmHermesFeatureMemos\s*\(\)/);
  });

  it("keeps it behind the Node-runtime guard", () => {
    const guard = source.indexOf("NEXT_RUNTIME === 'edge'");
    expect(guard).toBeGreaterThan(-1);
    expect(source.indexOf("harness/hermes-features")).toBeGreaterThan(guard);
  });

  it("defers it past the boot rush on an unref'd timer", () => {
    expect(warmupBlock()).toMatch(/setTimeout\([\s\S]*?\},\s*45_000\)\.unref\(\)/);
  });

  it("asks only on a Hermes box, decided when the timer fires", () => {
    const block = warmupBlock();
    const timer = block.indexOf("setTimeout(");
    const gate = block.indexOf("=== 'hermes'");
    expect(timer).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(timer);
    expect(block).toMatch(/getActiveHarness\s*\(\)/);
  });

  it("does not let a failed warm-up stop the box booting", () => {
    expect(warmupBlock()).toMatch(/\.catch\(/);
  });
});
