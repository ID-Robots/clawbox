import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  // Successive `is-active` answers; the last one repeats.
  states: ["inactive"] as string[],
  fail: new Set<string>(),
  installed: true,
  mode: null as string | null,
}));

vi.mock("child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    cb: (err: (Error & { stdout?: string }) | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push([file, ...args]);
    if (args[0] === "is-active") {
      const st = h.states.length > 1 ? h.states.shift()! : h.states[0];
      if (st === "active") return cb(null, { stdout: "active\n", stderr: "" });
      return cb(Object.assign(new Error(st), { stdout: `${st}\n` }));
    }
    const verb = args[2];
    if (h.fail.has(verb)) return cb(new Error(`${verb} denied`));
    if (verb === "restart" && h.states[0] === "inactive" && !h.fail.has("stay-down")) h.states = ["active"];
    cb(null, { stdout: "", stderr: "" });
  },
}));

vi.mock("fs/promises", () => {
  const api = {
    constants: { X_OK: 1 },
    access: async () => {
      if (!h.installed) throw new Error("ENOENT");
    },
    readFile: async (p: string) => {
      if (String(p).endsWith("tunnel.mode") && h.mode !== null) return `${h.mode}\n`;
      throw new Error("ENOENT");
    },
  };
  return { default: api, ...api };
});

import { reenableTunnelAfterRestore } from "@/lib/cloudflared";

const sudo = (verb: string) => ["sudo", "-n", "/usr/bin/systemctl", verb, "clawbox-tunnel.service"];
const fast = { settleMs: 50, pollMs: 1 };

beforeEach(() => {
  h.calls.length = 0;
  h.states = ["inactive"];
  h.fail.clear();
  h.installed = true;
  h.mode = null;
});

describe("reenableTunnelAfterRestore (TASK-1754): the tunnel ALWAYS runs after a restore", () => {
  it("enables and starts a quick tunnel even with no credential and nothing running before", async () => {
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: false, ...fast });
    expect(r).toEqual({ enabled: true, started: true, running: true, warnings: [] });
    expect(h.calls).toContainEqual(sudo("enable"));
    expect(h.calls).toContainEqual(sudo("restart"));
  });

  it("enables and starts when a named tunnel is configured", async () => {
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: true, ...fast });
    expect(r).toMatchObject({ enabled: true, started: true, running: true });
  });

  it("restarts a failed unit", async () => {
    h.states = ["failed"];
    h.fail.add("stay-down");
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: false, ...fast });
    expect(r.started).toBe(true);
    expect(r.running).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/not running after restart/);
  });

  it("does not bounce a running tunnel already in the right mode", async () => {
    h.states = ["active"];
    h.mode = "named";
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: true, ...fast });
    expect(r).toEqual({ enabled: true, started: false, running: true, warnings: [] });
    expect(h.calls.some((c) => c.includes("restart"))).toBe(false);
  });

  it("does not bounce a running quick tunnel when there is no named credential", async () => {
    h.states = ["active"];
    h.mode = "quick";
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: false, ...fast });
    expect(r.started).toBe(false);
    expect(r.running).toBe(true);
  });

  it("switches a running quick tunnel to the restored named credential", async () => {
    h.states = ["active"];
    h.mode = "quick";
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: true, ...fast });
    expect(r).toMatchObject({ started: true, running: true });
    expect(h.calls).toContainEqual(sudo("restart"));
  });

  it("waits for an activating unit to settle", async () => {
    h.states = ["inactive", "activating", "activating", "active"];
    h.fail.add("stay-down");
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: false, ...fast });
    expect(r.running).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("reports a missing cloudflared instead of calling systemctl", async () => {
    h.installed = false;
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: true, ...fast });
    expect(r).toMatchObject({ enabled: false, started: false, running: false });
    expect(r.warnings).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });

  it("reports failures instead of throwing", async () => {
    h.fail.add("enable");
    h.fail.add("restart");
    const r = await reenableTunnelAfterRestore({ hasNamedCredential: false, ...fast });
    expect(r).toMatchObject({ enabled: false, started: false, running: false });
    expect(r.warnings).toHaveLength(2);
  });
});
