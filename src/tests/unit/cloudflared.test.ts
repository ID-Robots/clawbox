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
let TUNNEL_URL_LOG_FILE: string;

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.CLOUDFLARED_BIN = FAKE_BIN;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  cloudflared = await import("@/lib/cloudflared");
  await fs.mkdir(cloudflared.CLOUDFLARED_DIR, { recursive: true });
  TUNNEL_URL_FILE = cloudflared.TUNNEL_URL_FILE;
  TUNNEL_URL_LOG_FILE = cloudflared.TUNNEL_URL_LOG_FILE;
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLOUDFLARED_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  execFileMock.mockReset();
  await fs.rm(TUNNEL_URL_FILE, { force: true });
  await fs.rm(TUNNEL_URL_LOG_FILE, { force: true });
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

describe("cloudflared — readTunnelUrlHistory", () => {
  // `tunnel.url` is deleted by run-tunnel.sh on every stop, so it can only ever
  // answer "what is the URL right now". When a retired *.trycloudflare.com
  // hostname was found still serving the box, nobody could say which URLs it
  // had published — the journal was volatile and there was no access log. This
  // file is that record.
  it("returns [] when the history file does not exist", async () => {
    expect(await cloudflared.readTunnelUrlHistory()).toEqual([]);
  });

  it("returns records newest-first", async () => {
    await fs.writeFile(
      TUNNEL_URL_LOG_FILE,
      [
        "2026-08-20T10:00:00Z https://old-one.trycloudflare.com",
        "2026-08-21T11:30:00Z https://middle-one.trycloudflare.com",
        "2026-08-22T09:15:00Z https://newest-one.trycloudflare.com",
        "",
      ].join("\n"),
    );

    expect(await cloudflared.readTunnelUrlHistory()).toEqual([
      { at: "2026-08-22T09:15:00Z", url: "https://newest-one.trycloudflare.com" },
      { at: "2026-08-21T11:30:00Z", url: "https://middle-one.trycloudflare.com" },
      { at: "2026-08-20T10:00:00Z", url: "https://old-one.trycloudflare.com" },
    ]);
  });

  it("honours the limit", async () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `2026-08-22T00:00:${String(i).padStart(2, "0")}Z https://url-${i}.trycloudflare.com`,
    );
    await fs.writeFile(TUNNEL_URL_LOG_FILE, lines.join("\n"));

    expect(await cloudflared.readTunnelUrlHistory()).toHaveLength(10); // default
    expect(await cloudflared.readTunnelUrlHistory(3)).toEqual([
      { at: "2026-08-22T00:00:19Z", url: "https://url-19.trycloudflare.com" },
      { at: "2026-08-22T00:00:18Z", url: "https://url-18.trycloudflare.com" },
      { at: "2026-08-22T00:00:17Z", url: "https://url-17.trycloudflare.com" },
    ]);
    expect(await cloudflared.readTunnelUrlHistory(0)).toEqual([]);
    expect(await cloudflared.readTunnelUrlHistory(-1)).toEqual([]);
  });

  it("skips garbage instead of throwing — a half-written line must not 500 the status route", async () => {
    await fs.writeFile(
      TUNNEL_URL_LOG_FILE,
      [
        "not-a-timestamp https://ok.trycloudflare.com",
        "2026-08-22T09:00:00Z https://evil.example.com",
        "2026-08-22T09:00:01Z",
        "",
        "   ",
        "2026-08-22T09:00:02Z https://good.trycloudflare.com/",
      ].join("\n"),
    );

    expect(await cloudflared.readTunnelUrlHistory()).toEqual([
      { at: "2026-08-22T09:00:02Z", url: "https://good.trycloudflare.com" },
    ]);
  });
});
