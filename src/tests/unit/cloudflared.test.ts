import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-cloudflared-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const FAKE_BIN = path.join(TEST_ROOT, "fake-cloudflared");

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const result = execFileMock(cmd, args);
    if (result?.error) {
      const err = result.error as Error & { stdout?: string };
      err.stdout = result.stdout ?? "";
      cb(err, { stdout: result.stdout ?? "", stderr: "" });
    } else {
      cb(null, { stdout: result?.stdout ?? "", stderr: "" });
    }
  },
}));

let cloudflared: typeof import("@/lib/cloudflared");
let TUNNEL_URL_FILE: string;

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.CLOUDFLARED_BIN = FAKE_BIN;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  cloudflared = await import("@/lib/cloudflared");
  await fs.mkdir(cloudflared.CLOUDFLARED_DIR, { recursive: true });
  TUNNEL_URL_FILE = cloudflared.TUNNEL_URL_FILE;
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLOUDFLARED_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  execFileMock.mockReset();
  await fs.rm(TUNNEL_URL_FILE, { force: true });
  await fs.rm(FAKE_BIN, { force: true });
});

describe("cloudflared — isInstalled", () => {
  it("returns false when binary is missing", async () => {
    expect(await cloudflared.isInstalled()).toBe(false);
  });

  it("returns true when binary is executable", async () => {
    await fs.writeFile(FAKE_BIN, "#!/bin/sh\necho fake", { mode: 0o755 });
    expect(await cloudflared.isInstalled()).toBe(true);
  });

  it("returns false when binary exists but is not executable", async () => {
    await fs.writeFile(FAKE_BIN, "not executable", { mode: 0o644 });
    expect(await cloudflared.isInstalled()).toBe(false);
  });
});

describe("cloudflared — readTunnelUrl", () => {
  it("returns null when no url file exists", async () => {
    expect(await cloudflared.readTunnelUrl()).toBeNull();
  });

  it("returns trimmed URL for a valid trycloudflare URL", async () => {
    await fs.writeFile(TUNNEL_URL_FILE, "https://abc-123.trycloudflare.com\n");
    expect(await cloudflared.readTunnelUrl()).toBe(
      "https://abc-123.trycloudflare.com",
    );
  });

  it("strips trailing slashes", async () => {
    await fs.writeFile(TUNNEL_URL_FILE, "https://abc.trycloudflare.com/\n");
    expect(await cloudflared.readTunnelUrl()).toBe(
      "https://abc.trycloudflare.com",
    );
  });

  it("rejects garbage that doesn't match the trycloudflare pattern", async () => {
    await fs.writeFile(TUNNEL_URL_FILE, "https://evil.example.com\n");
    expect(await cloudflared.readTunnelUrl()).toBeNull();
  });

  it("rejects empty file", async () => {
    await fs.writeFile(TUNNEL_URL_FILE, "   \n");
    expect(await cloudflared.readTunnelUrl()).toBeNull();
  });
});

describe("cloudflared — startTunnelService", () => {
  it("invokes systemctl restart + enable", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    await cloudflared.startTunnelService();
    const calls = execFileMock.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(" ")}`);
    expect(calls).toContain("sudo -n /usr/bin/systemctl restart clawbox-tunnel.service");
    expect(calls).toContain("sudo -n /usr/bin/systemctl enable clawbox-tunnel.service");
  });

  it("tolerates a failing enable call (non-fatal)", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("enable")) return { error: new Error("Failed to enable") };
      return { stdout: "" };
    });
    await expect(cloudflared.startTunnelService()).resolves.not.toThrow();
  });
});

describe("cloudflared — stopTunnelService", () => {
  it("invokes systemctl stop + disable", async () => {
    execFileMock.mockReturnValue({ stdout: "" });
    await cloudflared.stopTunnelService();
    const calls = execFileMock.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(" ")}`);
    expect(calls).toContain("sudo -n /usr/bin/systemctl stop clawbox-tunnel.service");
    expect(calls).toContain("sudo -n /usr/bin/systemctl disable clawbox-tunnel.service");
  });
});

describe("cloudflared — getTunnelServiceState", () => {
  it("maps `active` from systemctl is-active", async () => {
    execFileMock.mockReturnValue({ stdout: "active\n" });
    expect(await cloudflared.getTunnelServiceState()).toBe("active");
  });

  it("maps `inactive` from a successful is-active call", async () => {
    execFileMock.mockReturnValue({ stdout: "inactive\n" });
    expect(await cloudflared.getTunnelServiceState()).toBe("inactive");
  });

  it("maps `inactive` from a non-zero exit (systemctl convention)", async () => {
    execFileMock.mockReturnValue({
      error: new Error("non-zero exit"),
      stdout: "inactive\n",
    });
    expect(await cloudflared.getTunnelServiceState()).toBe("inactive");
  });

  it("returns `unknown` for unrecognized output", async () => {
    execFileMock.mockReturnValue({ stdout: "weird\n" });
    expect(await cloudflared.getTunnelServiceState()).toBe("unknown");
  });
});
