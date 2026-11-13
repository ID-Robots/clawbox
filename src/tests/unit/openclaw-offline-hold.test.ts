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
vi.mock("@/lib/gateway-unit-job", () => ({ runUnitJob: vi.fn(), readUnitState: vi.fn() }));

import {
  _setAuthOpsDepsForTests,
  restoreOpenclawGatewayAfterCrash,
  startOpenclawGatewayAfterOffline,
  stopOpenclawGatewayForOffline,
} from "@/lib/openclaw-auth-ops";

const HOLD = path.join(tmp, ".openclaw-offline-hold.json");

function deps() {
  const stopGateway = vi.fn(async () => undefined);
  const startGateway = vi.fn(async () => undefined);
  _setAuthOpsDepsForTests({ stopGateway, startGateway });
  return { stopGateway, startGateway };
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

  it("leaves a hold of a live server alone, and does nothing without one", async () => {
    const d = deps();
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
    fs.writeFileSync(HOLD, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await restoreOpenclawGatewayAfterCrash()).toBe(false);
    expect(d.startGateway).not.toHaveBeenCalled();
  });
});
