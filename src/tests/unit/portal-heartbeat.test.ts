import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-portal-heartbeat-tests-${process.pid}-${Date.now()}`);

let heartbeat: typeof import("@/lib/portal-heartbeat");
let configStore: typeof import("@/lib/config-store");
const fetchMock = vi.fn();

async function flushHeartbeat() {
  // pushHeartbeatIfChanged is fire-and-forget. Yield until microtasks settle
  // and the inFlight promise resolves.
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.CLOUDFLARED_BIN = path.join(TEST_ROOT, "fake-cf");
  process.env.PORTAL_HEARTBEAT_URL = "https://test.invalid/api/heartbeat";
  await fs.mkdir(path.join(TEST_ROOT, "data"), { recursive: true });
  vi.resetModules();
  // @ts-expect-error overriding global fetch
  globalThis.fetch = fetchMock;
  configStore = await import("@/lib/config-store");
  heartbeat = await import("@/lib/portal-heartbeat");
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLOUDFLARED_BIN;
  delete process.env.PORTAL_HEARTBEAT_URL;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(async () => {
  await flushHeartbeat();
});

describe("portal-heartbeat — pushHeartbeatIfChanged", () => {
  it("does nothing when tunnelUrl is null", async () => {
    heartbeat.pushHeartbeatIfChanged(null);
    await flushHeartbeat();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when no clawai_token is configured", async () => {
    await configStore.set("clawai_token", undefined);
    heartbeat.pushHeartbeatIfChanged("https://abc.trycloudflare.com");
    await flushHeartbeat();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when clawai_token is malformed (missing claw_ prefix)", async () => {
    await configStore.set("clawai_token", "garbage-token");
    heartbeat.pushHeartbeatIfChanged("https://def.trycloudflare.com");
    await flushHeartbeat();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts deviceId+tunnelUrl+name with bearer token to portal heartbeat URL", async () => {
    await configStore.set("clawai_token", "claw_0123456789abcdef0123456789abcdef");
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    heartbeat.pushHeartbeatIfChanged("https://newurl.trycloudflare.com");
    await flushHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test.invalid/api/heartbeat");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer claw_/,
    );
    const body = JSON.parse(init.body as string) as {
      deviceId: string;
      tunnelUrl: string;
      name: string;
    };
    expect(body.tunnelUrl).toBe("https://newurl.trycloudflare.com");
    expect(body.deviceId).toMatch(/^dev_[a-f0-9]{16}$/);
    expect(body.name).toMatch(/^ClawBox-[A-F0-9]{4}$/);
  });

  it("does not re-post the same URL twice in a row", async () => {
    await configStore.set("clawai_token", "claw_0123456789abcdef0123456789abcdef");
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    heartbeat.pushHeartbeatIfChanged("https://stable.trycloudflare.com");
    await flushHeartbeat();
    heartbeat.pushHeartbeatIfChanged("https://stable.trycloudflare.com");
    await flushHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the portal returns 401 (auth rejected)", async () => {
    await configStore.set("clawai_token", "claw_0123456789abcdef0123456789abcdef");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    heartbeat.pushHeartbeatIfChanged("https://rejected.trycloudflare.com");
    await flushHeartbeat();
    // Same URL after a 401 must not retry.
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    heartbeat.pushHeartbeatIfChanged("https://rejected.trycloudflare.com");
    await flushHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
