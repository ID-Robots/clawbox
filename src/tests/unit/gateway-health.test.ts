import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import {
  GATEWAY_SHOW_PROPERTIES,
  gatewayJournalArgs,
  getGatewayServiceHealth,
  lastUsefulJournalLine,
  parseGatewaySystemctlProperties,
} from "@/lib/gateway-health";

describe("gateway service health", () => {
  it("keeps the final startup error instead of a repeated restart notice", () => {
    const journal = [
      "Config validation failed: exec SecretRef command must resolve to a real path",
      "clawbox-gateway.service: Main process exited, code=exited, status=1/FAILURE",
      "clawbox-gateway.service: Scheduled restart job, restart counter is at 3.",
    ].join("\n");

    expect(lastUsefulJournalLine(journal)).toBe(
      "Config validation failed: exec SecretRef command must resolve to a real path",
    );
  });

  it("returns null for an empty journal", () => {
    expect(lastUsefulJournalLine("\n")).toBeNull();
  });

  it("scopes journal diagnostics to the failed activation", () => {
    const invocationId = "0123456789abcdef0123456789abcdef";
    const args = gatewayJournalArgs(`ActiveState=failed\nInvocationID=${invocationId}\n`);

    expect(args).toContain(`_SYSTEMD_INVOCATION_ID=${invocationId}`);
    // Scoped by invocation id alone — no `-u UNIT`, which would OR-expand and
    // break the AND with the invocation filter (surfacing stale lines).
    expect(args).not.toContain("-u");
  });

  it("does not fall back to stale journal history without an activation ID", () => {
    expect(gatewayJournalArgs("ActiveState=failed\nInvocationID=\n")).toBeNull();
  });

  it("recognizes systemd 249's documented start-limit-hit result", () => {
    expect(parseGatewaySystemctlProperties([
      "ActiveState=failed",
      "SubState=failed",
      "Result=start-limit-hit",
      "NRestarts=5",
    ].join("\n"))).toEqual({
      active: false,
      breakerActive: true,
      activeState: "failed",
      subState: "failed",
      result: "start-limit-hit",
      restartCount: 5,
      loadState: null,
      unitLoaded: null,
    });
  });

  it("separates a unit systemd cannot load from one that is merely down", () => {
    // The Hermes SKU masks clawbox-gateway.service to /dev/null (install.sh
    // step_edition_gateway_state) and an update holds the same mask on any SKU.
    // systemctl refuses both `reset-failed` and `restart` on such a unit, so
    // "offline, retry" is the wrong story to tell about it.
    const masked = parseGatewaySystemctlProperties([
      "LoadState=masked",
      "ActiveState=inactive",
      "SubState=dead",
      "Result=success",
      "NRestarts=0",
    ].join("\n"));
    expect(masked.loadState).toBe("masked");
    expect(masked.unitLoaded).toBe(false);

    const missing = parseGatewaySystemctlProperties("LoadState=not-found\nActiveState=inactive\n");
    expect(missing.unitLoaded).toBe(false);

    const loaded = parseGatewaySystemctlProperties("LoadState=loaded\nActiveState=failed\n");
    expect(loaded.unitLoaded).toBe(true);

    // Not asked is not answered: a systemctl that printed nothing about the
    // load state must not be read as "the unit is fine".
    expect(parseGatewaySystemctlProperties("ActiveState=failed\n").unitLoaded).toBeNull();
  });

  it("asks systemd for every property it parses", () => {
    // A parser reading a property the query omits answers undefined forever,
    // the branch that depends on it silently never runs, and no test that feeds
    // the parser its own hand-written stdout can see it. So the stdout here is
    // built FROM the query list: every field the parser returns must be settled
    // by it, and a field added to the parser without being added to the query
    // comes back null.
    const stdout = GATEWAY_SHOW_PROPERTIES
      .map((property) => `${property}=${property === "NRestarts" ? "0" : "loaded"}`)
      .join("\n");
    const parsed = parseGatewaySystemctlProperties(stdout) as Record<string, unknown>;

    for (const [field, value] of Object.entries(parsed)) {
      expect(value, `${field} is not settled by --property=${GATEWAY_SHOW_PROPERTIES.join(",")}`)
        .not.toBeNull();
      expect(value, `${field} is not settled by --property=${GATEWAY_SHOW_PROPERTIES.join(",")}`)
        .not.toBeUndefined();
    }
    // The journal scope reads InvocationID off the SAME stdout, so it is part of
    // the same contract.
    expect(gatewayJournalArgs(`InvocationID=${"a".repeat(32)}\n`)).not.toBeNull();
    expect(GATEWAY_SHOW_PROPERTIES).toContain("InvocationID");
  });

  describe("getGatewayServiceHealth", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function answerSystemctl(stdout: string) {
      vi.mocked(childProcess.execFile).mockImplementation(((
        _cmd: string,
        _args: string[],
        optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
        maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
        callback?.(null, { stdout, stderr: "" });
        return {} as unknown as ReturnType<typeof childProcess.execFile>;
      }) as unknown as typeof childProcess.execFile);
    }

    it("requests LoadState and reports a masked unit as unloadable", async () => {
      answerSystemctl("LoadState=masked\nActiveState=inactive\nSubState=dead\nResult=success\nNRestarts=0\n");

      const health = await getGatewayServiceHealth();

      const args = vi.mocked(childProcess.execFile).mock.calls[0][1] as string[];
      expect(args.some((arg) => arg.includes("LoadState"))).toBe(true);
      expect(health.loadState).toBe("masked");
      expect(health.unitLoaded).toBe(false);
    });

    it("answers 'unknown' rather than 'missing' when systemctl fails", async () => {
      vi.mocked(childProcess.execFile).mockImplementation(((
        _cmd: string,
        _args: string[],
        optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
        maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
        callback?.(new Error("systemctl: command not found"), { stdout: "", stderr: "" });
        return {} as unknown as ReturnType<typeof childProcess.execFile>;
      }) as unknown as typeof childProcess.execFile);

      const health = await getGatewayServiceHealth();

      expect(health.unitLoaded).toBeNull();
      expect(health.loadState).toBeNull();
    });
  });

  it("normalizes control characters and caps journal output", () => {
    const unsafe = `\u001b[31mConfig\u0000 failure ${"x".repeat(2_000)}`;
    const result = lastUsefulJournalLine(unsafe);

    expect(result).toMatch(/^Config failure x+$/);
    expect(result).toHaveLength(1_000);
    expect(result).not.toContain("\u001b");
  });

  it("redacts credentials from the authenticated error summary", () => {
    const line = 'Config failed token="super-secret-value" bot=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345 password=Hunter2Long key sk-proj-BAREKEY1234567890abcdefXY';
    const result = lastUsefulJournalLine(line);

    expect(result).toContain('token="[redacted]');
    expect(result).toContain("[redacted-telegram-token]");
    expect(result).toContain("password=[redacted]");
    expect(result).toContain("[redacted-key]");
    expect(result).not.toContain("super-secret-value");
    expect(result).not.toContain("ABCdefGHI");
    expect(result).not.toContain("Hunter2Long");
    expect(result).not.toContain("BAREKEY");
  });
});
