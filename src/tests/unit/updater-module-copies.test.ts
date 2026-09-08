import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const store = vi.hoisted(() => ({ get: vi.fn(), setMany: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/config-store", () => ({
  ...store,
  getKnown: async (key: string) => ({ known: true, value: await store.get(key) }),
  CONFIG_ROOT: "/nonexistent-clawbox-module-copy-test",
  resolveConfigRoot: () => "/nonexistent-clawbox-module-copy-test",
}));
vi.mock("child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));

let bootHook: typeof import("@/lib/updater");
let statusRoute: typeof import("@/lib/updater");
beforeEach(async () => {
  vi.resetModules();
  bootHook = await import("@/lib/updater");
  bootHook.resetUpdateState();
  store.get.mockReset();
  store.set.mockReset();
  store.setMany.mockReset();
  // Next's instrumentation and route bundles each evaluate updater.ts. Reload
  // only the module graph, NOT globalThis: it is still the same Node process.
  vi.resetModules();
  statusRoute = await import("@/lib/updater");
});
afterEach(() => bootHook.resetUpdateState());

describe("one update owner across independently bundled module copies", () => {
  it("shows a boot-hook run to the route and refuses a duplicate launch or dismiss", async () => {
    // Hold the real runner at its first disk write: no network, root command,
    // or artificial direct mutation of the updater state is involved.
    store.setMany.mockImplementation(() => new Promise(() => {}));
    expect(bootHook.startUpdate()).toEqual({ started: true });
    expect(statusRoute.getUpdateState().phase).toBe("running");
    expect(statusRoute.getUpdateState()).toEqual(bootHook.getUpdateState());
    expect(statusRoute.startUpdate()).toEqual({ started: false, error: "Update already in progress" });
    expect(await statusRoute.checkContinuation()).toBe(false);
    expect(await statusRoute.dismissSettledUpdate()).toMatchObject({ dismissed: false, reason: "in-progress" });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("single-flights a continuation read across the boot hook and status route", async () => {
    let finishRead!: (value: unknown) => void;
    store.get.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const fromBoot = bootHook.checkContinuation();
    const fromRoute = statusRoute.checkContinuation();
    try {
      expect(fromRoute).toBe(fromBoot);
      expect(store.get).toHaveBeenCalledTimes(1);
      expect(statusRoute.startUpdate()).toEqual({ started: false, error: "Update already in progress" });
    } finally {
      finishRead(undefined);
      await Promise.all([fromBoot, fromRoute]);
    }
  });
});
