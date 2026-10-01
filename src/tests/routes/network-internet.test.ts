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

  // Every signed-in ClawBox user reads this route, not just the owner — the
  // tray's online dot (src/lib/non-owner-scope.ts). So it must stay a bare
  // connectivity reading: no interface, SSID, address or credential. A new
  // field here is a new thing every user on the box can read.
  it("answers connectivity and nothing of the network's configuration", async () => {
    for (const result of [{ stdout: "ok" }, { error: new Error("down") }]) {
      vi.resetModules();
      execFileMock.mockReset();
      execFileMock.mockReturnValue(result);
      const mod = await import("@/app/setup-api/network/internet/route");
      const body = await (await mod.GET()).json();
      expect(Object.keys(body).sort()).toEqual(["checkedAt", "latencyMs", "online"]);
    }
  });

  it("probes a fixed public address, never one taken from the request", async () => {
    execFileMock.mockReturnValue({ stdout: "ok" });
    const mod = await import("@/app/setup-api/network/internet/route");
    expect(mod.GET.length).toBe(0);
    await mod.GET();
    expect(execFileMock).toHaveBeenCalledWith("ping", expect.arrayContaining(["1.1.1.1"]));
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
