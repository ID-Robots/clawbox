import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * applyPathGuardSwitch on the Hermes edition (TASK-1661): register-mcp.sh
 * rewrites the deny globs, then a running messaging gateway is restarted. A
 * restart that fails leaves the gateway on its old approvals, so it must be
 * reported (applied: false + error, which the route turns into a 502), not
 * reported as applied.
 */

const h = vi.hoisted(() => ({
  restartHermes: vi.fn(async (): Promise<boolean | null> => true),
}));

vi.mock("@/lib/clawbox-mcp-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-mcp-registration")>()),
  harnessesHere: () => ({ openclaw: false, hermes: true }),
  restartHermesGatewayIfRunning: h.restartHermes,
}));

let root: string;
let restoreEnv: () => void;
let applyPathGuardSwitch: typeof import("@/lib/path-guard-switch").applyPathGuardSwitch;

const writeRegisterScript = (exitCode: number) => {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "register-mcp.sh"), `exit ${exitCode}\n`);
};

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-path-guard-switch-"));
  process.env.CLAWBOX_ROOT = root;
  ({ applyPathGuardSwitch } = await import("@/lib/path-guard-switch"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  writeRegisterScript(0);
  h.restartHermes.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("applyPathGuardSwitch on Hermes", () => {
  it("is applied when the running messaging gateway restarted", async () => {
    h.restartHermes.mockResolvedValue(true);
    expect(await applyPathGuardSwitch(false)).toEqual({ openclaw: null, hermes: { applied: true }, error: null });
    expect(h.restartHermes).toHaveBeenCalledTimes(1);
  });

  it("is applied when no messaging gateway was running: its next start reads the new config", async () => {
    h.restartHermes.mockResolvedValue(null);
    expect(await applyPathGuardSwitch(false)).toEqual({ openclaw: null, hermes: { applied: true }, error: null });
  });

  it("reports a gateway that did not restart instead of calling it applied", async () => {
    h.restartHermes.mockResolvedValue(false);
    const result = await applyPathGuardSwitch(false);
    expect(result.hermes).toEqual({ applied: false });
    expect(result.error).toMatch(/messaging gateway did not restart/);
  });

  it("reports a failed register-mcp.sh and does not restart the gateway", async () => {
    writeRegisterScript(3);
    const result = await applyPathGuardSwitch(true);
    expect(result.hermes).toEqual({ applied: false });
    expect(result.error).toMatch(/Hermes' config could not be updated/);
    expect(h.restartHermes).not.toHaveBeenCalled();
  });
});
