import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

/**
 * A web server that exits while it holds OpenClaw's gateway stopped for an
 * offline memory index pass leaves the hold on disk; the next start puts the
 * gateway back (src/lib/openclaw-auth-ops.ts, called from instrumentation).
 */
const tmp = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("path") as typeof import("path");
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "offline-hold-"));
});
vi.mock("@/lib/config-store", () => ({ DATA_DIR: tmp }));
vi.mock("@/lib/openclaw-config", () => ({
  spawnOpenclawCli: vi.fn(),
  restartGateway: vi.fn(),
  gatewayIsAbsent: () => false,
  gatewayReadyWaitMs: () => 1000,
}));
vi.mock("@/lib/openclaw-auth-store", () => ({ readGatewayProviderAuth: vi.fn() }));
vi.mock("@/lib/gateway-unit-job", () => ({
  runUnitJob: vi.fn(),
  readUnitState: vi.fn(),
  unitIsStopped: (state: { activeState: string }) => state.activeState === "inactive" || state.activeState === "failed",
}));

import {
  _setAuthOpsDepsForTests,
  OpenclawGatewayHeldOfflineError,
  openclawGatewayHeldOffline,
  openclawGatewayRuns,
  restoreOpenclawGatewayAfterCrash,
  startOpenclawGatewayAfterOffline,
  stopOpenclawGatewayForOffline,
  withOpenclawGatewayStopped,
} from "@/lib/openclaw-auth-ops";

const HOLD = path.join(tmp, ".openclaw-offline-hold.json");

function deps() {
  const stopGateway = vi.fn(async () => undefined);
  const startGateway = vi.fn(async () => undefined);
  const unitUp = { value: false };
  _setAuthOpsDepsForTests({
    stopGateway,
    startGateway,
    gatewayUnitUp: async () => unitUp.value,
    gatewayUnitRunning: async () => unitUp.value,
    gatewayUnitDown: async () => !unitUp.value,
  });
  return { stopGateway, startGateway, unitUp };
}

afterEach(() => {
  _setAuthOpsDepsForTests(null);
  fs.rmSync(HOLD, { force: true });
});

describe("the offline hold", () => {
  it("is on disk while the gateway is held stopped, and gone once it is started again", async () => {
    deps();
    await stopOpenclawGatewayForOffline();
    expect(JSON.parse(fs.readFileSync(HOLD, "utf8"))).toMatchObject({ pid: process.pid });
    await startOpenclawGatewayAfterOffline();
    expect(fs.existsSync(HOLD)).toBe(false);
  });

  it("waits a slow stop out for the pass, as long as the unit may take", async () => {
    // A gateway in use drains until its unit's stop timeout. The minute this
    // used to wait was over long before that: the pass gave up, the gateway
    // was started again behind the same stop, and nothing was indexed.
    const d = deps();
    await stopOpenclawGatewayForOffline();
    expect(d.stopGateway).toHaveBeenCalledWith(true);
  });

  it("stops nothing when the hold cannot be written", async () => {
    const d = deps();
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("EROFS: read-only file system"); });
    try {
      await expect(stopOpenclawGatewayForOffline()).rejects.toThrow(/EROFS/);
      expect(d.stopGateway).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("starts the gateway again at boot when the server that held it has exited", async () => {
    const d = deps();
    fs.writeFileSync(HOLD, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(true);
    expect(d.startGateway).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(HOLD)).toBe(false);
  });

  it("leaves a gateway that is still running alone, and only drops the orphaned hold", async () => {
    const d = deps();
    d.unitUp.value = true;
    fs.writeFileSync(HOLD, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
    expect(d.startGateway).not.toHaveBeenCalled();
    expect(fs.existsSync(HOLD)).toBe(false);
  });

  it("starts a gateway that was still stopping, or whose unit cannot be read, when the hold is orphaned", async () => {
    const { readUnitState } = await import("@/lib/gateway-unit-job");
    const { restartGateway } = await import("@/lib/openclaw-config");
    for (const state of [{ activeState: "deactivating" }, null]) {
      _setAuthOpsDepsForTests(null);
      vi.mocked(restartGateway).mockClear();
      vi.mocked(readUnitState).mockResolvedValueOnce(state as Awaited<ReturnType<typeof readUnitState>>);
      fs.writeFileSync(HOLD, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
      expect(await restoreOpenclawGatewayAfterCrash()).toBe(true);
      expect(vi.mocked(restartGateway)).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(HOLD)).toBe(false);
    }
  });

  it("leaves a running or starting unit alone through the default check", async () => {
    const { readUnitState } = await import("@/lib/gateway-unit-job");
    const { restartGateway } = await import("@/lib/openclaw-config");
    for (const activeState of ["active", "activating"]) {
      _setAuthOpsDepsForTests(null);
      vi.mocked(restartGateway).mockClear();
      vi.mocked(readUnitState).mockResolvedValueOnce({ activeState } as Awaited<ReturnType<typeof readUnitState>>);
      fs.writeFileSync(HOLD, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
      expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
      expect(vi.mocked(restartGateway)).not.toHaveBeenCalled();
      expect(fs.existsSync(HOLD)).toBe(false);
    }
  });

  it("leaves a hold of a live server alone, and does nothing without one", async () => {
    const d = deps();
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
    fs.writeFileSync(HOLD, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
    expect(d.startGateway).not.toHaveBeenCalled();
  });
});

describe("other offline work while a pass holds the gateway stopped", () => {
  it("is refused before anything is stopped or started", async () => {
    // The account pool's token window and a key save both end by starting the
    // gateway; under a running index pass that start brings it up over the
    // pass, and the CLI they run would be refused the state anyway.
    const d = deps();
    await stopOpenclawGatewayForOffline();
    d.stopGateway.mockClear();
    const work = vi.fn(async () => "done");
    await expect(withOpenclawGatewayStopped(work)).rejects.toBeInstanceOf(OpenclawGatewayHeldOfflineError);
    await expect(withOpenclawGatewayStopped(work, { waitOutStop: true })).rejects.toBeInstanceOf(OpenclawGatewayHeldOfflineError);
    expect(work).not.toHaveBeenCalled();
    expect(d.stopGateway).not.toHaveBeenCalled();
    expect(d.startGateway).not.toHaveBeenCalled();
  });

  it("runs again once the pass has started the gateway and dropped its hold", async () => {
    const d = deps();
    await stopOpenclawGatewayForOffline();
    await startOpenclawGatewayAfterOffline();
    d.stopGateway.mockClear();
    d.startGateway.mockClear();
    await expect(withOpenclawGatewayStopped(async () => "done")).resolves.toBe("done");
    expect(d.stopGateway).toHaveBeenCalledTimes(1);
    expect(d.startGateway).toHaveBeenCalledTimes(1);
  });

  it("does not take a hold record left beside a gateway that is up for a hold", async () => {
    // startOpenclawGatewayAfterOffline drops the record only once the gateway
    // has answered; a start that was issued but slow to answer leaves it
    // behind. Read as a hold, it would refuse every token paste from then on.
    const d = deps();
    fs.writeFileSync(HOLD, JSON.stringify({ pid: process.pid, at: Date.now() }));
    d.unitUp.value = true;
    expect(await openclawGatewayHeldOffline()).toBe(false);
    await expect(withOpenclawGatewayStopped(async () => "done")).resolves.toBe("done");
  });

  it("does not take the record of a server that has exited for a hold", async () => {
    deps();
    fs.writeFileSync(HOLD, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await openclawGatewayHeldOffline()).toBe(false);
  });

  it("is held by a live server's record beside a unit that is down or stopping, and by nothing without a record", async () => {
    const { readUnitState } = await import("@/lib/gateway-unit-job");
    expect(await openclawGatewayHeldOffline()).toBe(false);
    for (const [activeState, held] of [["inactive", true], ["failed", true], ["deactivating", true], ["active", false], ["activating", false]] as const) {
      _setAuthOpsDepsForTests(null);
      fs.writeFileSync(HOLD, JSON.stringify({ pid: process.pid, at: Date.now() }));
      vi.mocked(readUnitState).mockResolvedValueOnce({ activeState } as Awaited<ReturnType<typeof readUnitState>>);
      expect(await openclawGatewayHeldOffline()).toBe(held);
    }
    // A unit that cannot be read is not known to be down.
    _setAuthOpsDepsForTests(null);
    fs.writeFileSync(HOLD, JSON.stringify({ pid: process.pid, at: Date.now() }));
    vi.mocked(readUnitState).mockResolvedValueOnce(null as Awaited<ReturnType<typeof readUnitState>>);
    expect(await openclawGatewayHeldOffline()).toBe(false);
  });
});

describe("whether a gateway is running to keep the index current", () => {
  it("answers the unit's state", async () => {
    const d = deps();
    expect(await openclawGatewayRuns()).toBe(false);
    d.unitUp.value = true;
    expect(await openclawGatewayRuns()).toBe(true);
  });
});

