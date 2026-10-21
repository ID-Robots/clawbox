import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

// Starts a real bash process: vitest's 5 s default is not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * applyComputerUseSwitch re-runs register-mcp.sh — the boot's own apply — and
 * the script exits 0 when Hermes refuses (a boot must never abort over it). So
 * the exit status is NOT the answer: only the line the script prints after
 * `hermes tools <verb> computer_use` answered 0 is. Pinned against a stand-in
 * script so each answer can be staged, including the false success the exit
 * status alone would report.
 */

const h = vi.hoisted(() => ({ restart: vi.fn(async (): Promise<boolean | null> => null) }));
vi.mock("@/lib/clawbox-mcp-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-mcp-registration")>()),
  restartHermesGatewayIfRunning: h.restart,
}));

let root: string;
let restoreEnv: () => void;
let apply: typeof import("@/lib/computer-use-apply").applyComputerUseSwitch;

/** The stand-in register-mcp.sh: prints `out` and exits `rc`. */
function stageScript(out: string, rc = 0) {
  const p = path.join(root, "scripts", "register-mcp.sh");
  fs.writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(out)}\nexit ${rc}\n`);
}

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cu-apply-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  ({ applyComputerUseSwitch: apply } = await import("@/lib/computer-use-apply"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.restart.mockReset();
  h.restart.mockResolvedValue(null);
});

describe("applyComputerUseSwitch", () => {
  it("is applied only when the script confirms the state asked for", async () => {
    stageScript("[register-mcp] computer_use toolset off (Settings switch)");
    expect(await apply(false)).toEqual({ applied: true, gatewayRestarted: null, error: null });
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("a refusal the script survived with exit 0 is NOT a success", async () => {
    stageScript("[register-mcp] could not switch the computer_use toolset off (exit 3) — continuing");
    const r = await apply(false);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/saved, but Hermes did not take it/);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("the opposite state's line does not count", async () => {
    stageScript("[register-mcp] computer_use toolset off (Settings switch)");
    expect((await apply(true)).applied).toBe(false);
  });

  it("a script that failed outright is reported, never thrown", async () => {
    stageScript("[register-mcp] ERROR: bun not found", 1);
    expect((await apply(true)).applied).toBe(false);
  });

  it("names a messaging gateway that did not restart", async () => {
    stageScript("[register-mcp] computer_use toolset on (Settings switch)");
    h.restart.mockResolvedValue(false);
    const r = await apply(true);
    expect(r).toMatchObject({ applied: true, gatewayRestarted: false });
    expect(r.error).toMatch(/messaging gateway did not restart/);
  });
});
