import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-tunnel-tests-${process.pid}-${Date.now()}`);
const STATE_FILE = path.join(TEST_ROOT, "tunnel-state.json");
const PID_FILE = path.join(TEST_ROOT, "tunnel.pid");
const URL_FILE = path.join(TEST_ROOT, "tunnel-url.txt");

// child_process is mocked so isCloudflaredInstalled and startTunnel don't shell out.
const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    const result = execMock(cmd);
    if (result?.error) cb(result.error, { stdout: "", stderr: "" });
    else cb(null, { stdout: result?.stdout ?? "", stderr: "" });
  },
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

let tunnel: typeof import("@/lib/tunnel");

beforeAll(async () => {
  process.env.CLAWBOX_DATA_DIR = TEST_ROOT;
  await fs.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  tunnel = await import("@/lib/tunnel");
});

afterAll(async () => {
  delete process.env.CLAWBOX_DATA_DIR;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(STATE_FILE, { force: true });
  await fs.rm(PID_FILE, { force: true });
  await fs.rm(URL_FILE, { force: true });
  execMock.mockReset();
  spawnMock.mockReset();
});

describe("tunnel — state persistence", () => {
  it("readState returns disabled defaults when no state file exists", async () => {
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });

  it("writeState persists JSON round-trip via readState", async () => {
    const startedAt = new Date().toISOString();
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://abc.trycloudflare.com",
      startedAt,
    });
    const state = await tunnel.readState();
    expect(state.enabled).toBe(true);
    expect(state.tunnelUrl).toBe("https://abc.trycloudflare.com");
    expect(state.startedAt).toBe(startedAt);
  });

  it("readState falls back to defaults on malformed JSON", async () => {
    await fs.writeFile(STATE_FILE, "not valid json", "utf-8");
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });
});

describe("tunnel — pid tracking", () => {
  it("getTunnelPid returns null when no pid file exists", async () => {
    const pid = await tunnel.getTunnelPid();
    expect(pid).toBeNull();
  });

  it("getTunnelPid parses and returns numeric pid", async () => {
    await fs.writeFile(PID_FILE, "42\n", "utf-8");
    const pid = await tunnel.getTunnelPid();
    expect(pid).toBe(42);
  });

  it("isTunnelRunning returns false when no pid file", async () => {
    expect(await tunnel.isTunnelRunning()).toBe(false);
  });

  it("isTunnelRunning returns true for the current process pid", async () => {
    await fs.writeFile(PID_FILE, String(process.pid), "utf-8");
    expect(await tunnel.isTunnelRunning()).toBe(true);
  });

  it("isTunnelRunning cleans up stale pid file when process is gone", async () => {
    // 0x7FFFFFFF is far above any real pid; process.kill(pid, 0) throws.
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    expect(await tunnel.isTunnelRunning()).toBe(false);
    await expect(fs.access(PID_FILE)).rejects.toThrow();
  });
});

describe("tunnel — url tracking", () => {
  it("getTunnelUrl returns null when no url file", async () => {
    expect(await tunnel.getTunnelUrl()).toBeNull();
  });

  it("getTunnelUrl trims trailing whitespace", async () => {
    await fs.writeFile(URL_FILE, "https://abc.trycloudflare.com\n", "utf-8");
    expect(await tunnel.getTunnelUrl()).toBe("https://abc.trycloudflare.com");
  });

  it("getTunnelUrl returns null for empty file", async () => {
    await fs.writeFile(URL_FILE, "   \n", "utf-8");
    expect(await tunnel.getTunnelUrl()).toBeNull();
  });
});

describe("tunnel — isCloudflaredInstalled", () => {
  it("returns true when `which cloudflared` succeeds", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    expect(await tunnel.isCloudflaredInstalled()).toBe(true);
  });

  it("returns false when `which cloudflared` errors", async () => {
    execMock.mockReturnValue({ error: new Error("not found") });
    expect(await tunnel.isCloudflaredInstalled()).toBe(false);
  });
});

describe("tunnel — getTunnelStatus", () => {
  it("reports disabled+not-running when nothing is set up", async () => {
    const status = await tunnel.getTunnelStatus();
    expect(status).toEqual({ enabled: false, running: false, tunnelUrl: null, error: null });
  });

  it("reports running+url when pid + url + state are present", async () => {
    await fs.writeFile(PID_FILE, String(process.pid), "utf-8");
    await fs.writeFile(URL_FILE, "https://xyz.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://xyz.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const status = await tunnel.getTunnelStatus();
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.tunnelUrl).toBe("https://xyz.trycloudflare.com");
  });

  it("hides tunnelUrl when process is gone (stale pid)", async () => {
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    await fs.writeFile(URL_FILE, "https://xyz.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://xyz.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const status = await tunnel.getTunnelStatus();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.tunnelUrl).toBeNull();
  });
});

describe("tunnel — stopTunnel", () => {
  it("succeeds when nothing is running and clears state file", async () => {
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://old.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const result = await tunnel.stopTunnel();
    expect(result.success).toBe(true);
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });

  it("removes stale pid and url files", async () => {
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    await fs.writeFile(URL_FILE, "https://x.trycloudflare.com", "utf-8");
    const result = await tunnel.stopTunnel();
    expect(result.success).toBe(true);
    await expect(fs.access(PID_FILE)).rejects.toThrow();
    await expect(fs.access(URL_FILE)).rejects.toThrow();
  });
});

describe("tunnel — startTunnel", () => {
  it("rejects when cloudflared is not installed", async () => {
    execMock.mockReturnValue({ error: new Error("not found") });
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed/i);
  });

  it("returns existing url when tunnel is already running", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    await fs.writeFile(PID_FILE, String(process.pid), "utf-8");
    await fs.writeFile(URL_FILE, "https://existing.trycloudflare.com", "utf-8");
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://existing.trycloudflare.com");
  });

  it("captures URL from cloudflared stdout and persists state", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeFakeProc("Visit it at: https://fresh-tunnel-abc.trycloudflare.com"));
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://fresh-tunnel-abc.trycloudflare.com");
    const state = await tunnel.readState();
    expect(state.enabled).toBe(true);
    expect(state.tunnelUrl).toBe("https://fresh-tunnel-abc.trycloudflare.com");
    const url = await fs.readFile(URL_FILE, "utf-8");
    expect(url).toBe("https://fresh-tunnel-abc.trycloudflare.com");
  });

  it("captures URL even when cloudflared writes to stderr", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() =>
      makeFakeProc("", "INF Tunnel ready https://stderr-route.trycloudflare.com"),
    );
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://stderr-route.trycloudflare.com");
  });

  it("reports spawn errors", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeErroringProc(new Error("ENOENT")));
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });
});

// ── helpers ───────────────────────────────────────────────────────────

type Listener = (data: Buffer) => void;
type EventName = "data" | "error" | "exit";

function makeFakeProc(stdoutLine: string, stderrLine = "") {
  const listeners: Record<string, Listener[]> = {};
  const emit = (stream: "stdout" | "stderr", text: string) => {
    if (!text) return;
    queueMicrotask(() => {
      (listeners[`${stream}:data`] ?? []).forEach((cb) => cb(Buffer.from(text)));
    });
  };
  const handler = (stream: "stdout" | "stderr") => ({
    on: (event: EventName, cb: Listener) => {
      listeners[`${stream}:${event}`] = listeners[`${stream}:${event}`] ?? [];
      listeners[`${stream}:${event}`].push(cb);
    },
  });
  emit("stdout", stdoutLine);
  emit("stderr", stderrLine);
  return {
    pid: 999999,
    stdout: handler("stdout"),
    stderr: handler("stderr"),
    on: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  };
}

function makeErroringProc(err: Error) {
  return {
    pid: 999999,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: EventName, cb: (e: Error) => void) => {
      if (event === "error") queueMicrotask(() => cb(err));
    }),
    unref: vi.fn(),
    kill: vi.fn(),
  };
}
