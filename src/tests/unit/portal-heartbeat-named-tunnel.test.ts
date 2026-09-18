import fs from "fs/promises";
import { statSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The heartbeat is the one authenticated channel between the box and the
 * portal, so it is where the named tunnel's credential arrives, rotates and is
 * taken away. The portal's contract (clawbox-website, heartbeat route):
 *
 *   request   `requestBoxTunnelToken: true` asks for the run token.
 *   response  `boxTunnel: { hostname, token? }` once the box is provisioned —
 *             `token` only when asked for; the field is absent altogether when
 *             the box has no named tunnel.
 *
 * The token is a credential for the box's public hostname: it lands in one
 * 0600 file, and never in a log line.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-named-hb-${process.pid}-${Date.now()}`);
const CF_DIR = path.join(TEST_ROOT, "data", "cloudflared");
const CRED = path.join(CF_DIR, "named-tunnel");
const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const TOKEN_2 = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoicm90YXRlZCJ9";

const cloudflaredState = {
  getTunnelServiceState: vi.fn(),
  startTunnelService: vi.fn(),
};
vi.mock("@/lib/cloudflared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cloudflared")>();
  return { ...real, ...cloudflaredState };
});

let heartbeat: typeof import("@/lib/portal-heartbeat");
let configStore: typeof import("@/lib/config-store");
const fetchMock = vi.fn();
const logged: string[] = [];

async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 5));
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function lastRequestBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(call[1].body as string);
}

async function beat(url = "https://abc.trycloudflare.com") {
  heartbeat.pushHeartbeatTick(url);
  await flush();
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.PORTAL_HEARTBEAT_URL = "https://test.invalid/api/heartbeat";
  await fs.mkdir(CF_DIR, { recursive: true });
  vi.resetModules();
  // @ts-expect-error overriding global fetch
  globalThis.fetch = fetchMock;
  configStore = await import("@/lib/config-store");
  heartbeat = await import("@/lib/portal-heartbeat");
  await configStore.set("clawai_token", "claw_0123456789abcdef0123456789abcdef");
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.PORTAL_HEARTBEAT_URL;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  fetchMock.mockReset();
  cloudflaredState.getTunnelServiceState.mockReset().mockResolvedValue("active");
  cloudflaredState.startTunnelService.mockReset().mockResolvedValue({ bootPersisted: true, bootPersistWarning: null });
  await fs.rm(CRED, { force: true });
  await fs.rm(path.join(CF_DIR, "named-refused"), { force: true });
  logged.length = 0;
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  await flush();
  vi.restoreAllMocks();
  // A second answer inside one test must not leak "ask again" into the next.
  fetchMock.mockResolvedValue(ok({ success: true }));
  await beat("https://reset.trycloudflare.com");
});

async function storeCredential(host = HOST, token = TOKEN) {
  await fs.writeFile(CRED, `hostname=${host}\ntoken=${token}\n`, { mode: 0o600 });
}

describe("heartbeat asks for the named-tunnel token only when it needs one", () => {
  it("asks when no credential is on file", async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await beat();
    expect(lastRequestBody().requestBoxTunnelToken).toBe(true);
  });

  it("does not ask when a credential is on file", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST } }));
    await beat();
    expect(lastRequestBody()).not.toHaveProperty("requestBoxTunnelToken");
    expect(lastRequestBody()).toMatchObject({ tunnelUrl: "https://abc.trycloudflare.com" });
  });

  it("asks again after the portal reports a different hostname without a token", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: "other-name-abcdefghjkmn.clawbox.tech" } }));
    await beat();
    expect(lastRequestBody()).not.toHaveProperty("requestBoxTunnelToken");
    await beat();
    expect(lastRequestBody().requestBoxTunnelToken).toBe(true);
  });
});

describe("heartbeat stores the credential the portal hands out", () => {
  it("writes hostname + token owner-only, and never logs the token", async () => {
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST, token: TOKEN } }));
    await beat();

    expect(await fs.readFile(CRED, "utf-8")).toBe(`hostname=${HOST}\ntoken=${TOKEN}\n`);
    expect(statSync(CRED).mode & 0o777).toBe(0o600);
    // No temp file left behind.
    expect((await fs.readdir(CF_DIR)).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).toContain("named tunnel credential stored");
    // The running tunnel is restarted onto the named credential.
    expect(cloudflaredState.startTunnelService).toHaveBeenCalledTimes(1);
  });

  it("does not switch Remote Access on for an owner who switched it off", async () => {
    cloudflaredState.getTunnelServiceState.mockResolvedValue("inactive");
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST, token: TOKEN } }));
    await beat();
    expect(await fs.readFile(CRED, "utf-8")).toContain(HOST);
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();
  });

  it("replaces a rotated token and restarts, but leaves an unchanged one alone", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST, token: TOKEN } }));
    await beat();
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST, token: TOKEN_2 } }));
    await beat();
    expect(await fs.readFile(CRED, "utf-8")).toContain(`token=${TOKEN_2}`);
    expect(cloudflaredState.startTunnelService).toHaveBeenCalledTimes(1);
  });

  it("refuses a hostname outside the box zone and a malformed token", async () => {
    for (const boxTunnel of [
      { hostname: "evil.example.com", token: TOKEN },
      { hostname: "a.b.clawbox.tech", token: TOKEN },
      { hostname: HOST, token: "short" },
      { hostname: HOST, token: `${TOKEN}\nhostname=evil.example.com` },
    ]) {
      fetchMock.mockResolvedValue(ok({ success: true, boxTunnel }));
      await beat();
      await expect(fs.stat(CRED)).rejects.toThrow();
    }
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();
  });

  it("does not store a token cloudflared already refused", async () => {
    await fs.writeFile(
      path.join(CF_DIR, "named-refused"),
      `${createHash("sha256").update(TOKEN).digest("hex")}\n`,
    );
    fetchMock.mockResolvedValue(ok({ success: true, boxTunnel: { hostname: HOST, token: TOKEN } }));
    await beat();
    await expect(fs.stat(CRED)).rejects.toThrow();
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();
  });
});

describe("revocation", () => {
  it("clears the credential and restarts into the quick tunnel when the portal stops reporting boxTunnel", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(ok({ success: true, device: { id: "dev_x" } }));
    await beat(`https://${HOST}`);
    await expect(fs.stat(CRED)).rejects.toThrow();
    expect(cloudflaredState.startTunnelService).toHaveBeenCalledTimes(1);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("clears the credential when the portal no longer accepts the box (unpaired)", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    await beat(`https://${HOST}`);
    await expect(fs.stat(CRED)).rejects.toThrow();
    expect(cloudflaredState.startTunnelService).toHaveBeenCalledTimes(1);
  });

  it("keeps the credential through a failed or unreadable heartbeat", async () => {
    await storeCredential();
    fetchMock.mockResolvedValue(new Response("upstream down", { status: 502 }));
    await beat(`https://${HOST}`);
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    await beat(`https://${HOST}`);
    fetchMock.mockRejectedValue(new Error("ENETUNREACH"));
    await beat(`https://${HOST}`);
    expect(await fs.readFile(CRED, "utf-8")).toContain(TOKEN);
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();
  });

  it("a box with nothing on file and no boxTunnel changes nothing", async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await beat();
    await expect(fs.stat(CRED)).rejects.toThrow();
    expect(cloudflaredState.startTunnelService).not.toHaveBeenCalled();
  });
});
