import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  state: "inactive",
  fail: new Set<string>(),
}));

vi.mock("child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    cb: (err: (Error & { stdout?: string }) | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push([file, ...args]);
    if (args[0] === "is-active") {
      if (h.state === "active") return cb(null, { stdout: "active\n", stderr: "" });
      return cb(Object.assign(new Error("inactive"), { stdout: `${h.state}\n` }));
    }
    const verb = args[2];
    if (h.fail.has(verb)) return cb(new Error(`${verb} denied`));
    cb(null, { stdout: "", stderr: "" });
  },
}));

import { reenableTunnelAfterRestore } from "@/lib/cloudflared";

const sudo = (verb: string) => ["sudo", "-n", "/usr/bin/systemctl", verb, "clawbox-tunnel.service"];

beforeEach(() => {
  h.calls.length = 0;
  h.state = "inactive";
  h.fail.clear();
});

describe("reenableTunnelAfterRestore (TASK-1754)", () => {
  it("enables but does not start when remote access was never configured", async () => {
    const r = await reenableTunnelAfterRestore({ wasActive: false, hasNamedCredential: false });
    expect(r).toEqual({ enabled: true, started: false, warnings: [] });
    expect(h.calls).toEqual([sudo("enable")]);
  });

  it("enables and starts (via restart grant) when a named tunnel is configured", async () => {
    const r = await reenableTunnelAfterRestore({ wasActive: false, hasNamedCredential: true });
    expect(r).toEqual({ enabled: true, started: true, warnings: [] });
    expect(h.calls).toEqual([sudo("enable"), ["systemctl", "is-active", "clawbox-tunnel.service"], sudo("restart")]);
  });

  it("is idempotent: does not bounce a tunnel that is already running", async () => {
    h.state = "active";
    const r = await reenableTunnelAfterRestore({ wasActive: true, hasNamedCredential: true });
    expect(r.started).toBe(false);
    expect(h.calls.some((c) => c.includes("restart"))).toBe(false);
  });

  it("reports failures instead of throwing", async () => {
    h.fail.add("enable");
    h.fail.add("restart");
    const r = await reenableTunnelAfterRestore({ wasActive: true, hasNamedCredential: false });
    expect(r.enabled).toBe(false);
    expect(r.started).toBe(false);
    expect(r.warnings).toHaveLength(2);
  });
});
