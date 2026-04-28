import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = (typeof _opts === "function" ? (_opts as typeof cb) : cb)!;
    const result = execFileMock(cmd, args);
    if (result?.error) {
      callback(result.error, { stdout: "", stderr: "" });
    } else {
      callback(null, { stdout: result?.stdout ?? "", stderr: "" });
    }
  },
}));

beforeEach(() => {
  execFileMock.mockReset();
  // Each test gets a fresh module so the in-memory cache resets.
  vi.resetModules();
});
afterEach(() => execFileMock.mockReset());

describe("/setup-api/network/internet", () => {
  it("reports online + a latency reading when ping succeeds", async () => {
    execFileMock.mockReturnValue({ stdout: "1 packet transmitted" });
    const mod = await import("@/app/setup-api/network/internet/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.online).toBe(true);
    expect(typeof body.latencyMs).toBe("number");
  });

  it("reports offline + null latency when ping fails", async () => {
    execFileMock.mockReturnValue({ error: new Error("Network unreachable") });
    const mod = await import("@/app/setup-api/network/internet/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.online).toBe(false);
    expect(body.latencyMs).toBeNull();
  });

  it("caches the result for the TTL window (5s)", async () => {
    execFileMock.mockReturnValue({ stdout: "ok" });
    const mod = await import("@/app/setup-api/network/internet/route");
    await mod.GET();
    await mod.GET();
    // Two requests within TTL → ping should only run once.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
