/**
 * The Map's layout port when neither a worker nor the in-page engine can
 * load (a missing chunk after an update): the caller hears it once, so the
 * Map can stand the page list in instead of "Arranging" forever.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/prime-radiant-map/layout-engine", () => {
  throw new Error("chunk failed to load");
});

import { openLayoutPort } from "@/components/prime-radiant-map/layout-port";

describe("openLayoutPort", () => {
  it("reports an engine that cannot load, and drops what was queued", async () => {
    expect(typeof Worker).toBe("undefined");
    const onMessage = vi.fn();
    const failed = new Promise<unknown>((resolve) => {
      const port = openLayoutPort(onMessage, resolve);
      port.post({ type: "buffer", positions: new Float32Array(3) });
    });
    await expect(failed).resolves.toBeDefined();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("stays quiet once closed", async () => {
    const onFail = vi.fn();
    openLayoutPort(vi.fn(), onFail).close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onFail).not.toHaveBeenCalled();
  });
});
