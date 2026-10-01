import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createSessionCookie } from "@/lib/auth";

// TASK-1256: the Hermes dashboard is the owner's assistant. Its proxy verifies
// the ClawBox session itself (it is its own process), so it has to apply the
// owner rule itself too: a second ClawBox user's valid session must not open it.

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");
const SESSION_SECRET = "test-session-secret-for-proxy-owner-only";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function close(server?: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function get(port: number, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: { Host: "localhost", Cookie: `${cookie}; hermes_session_at=stub` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error("proxy never responded"));
    });
    req.on("error", reject);
    req.end();
  });
}

let upstream: http.Server;
let upstreamPort: number;
let proxy: http.Server | undefined;
const ENV_KEYS = ["SESSION_SECRET", "ALLOWED_HOSTS", "CLAWBOX_ROOT", "HERMES_DASH_HOST", "HERMES_PORT", "CLAWBOX_USER"] as const;
const envBefore = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("dashboard ok");
  });
  upstreamPort = await listen(upstream);
  Object.assign(process.env, {
    SESSION_SECRET,
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: path.join(process.cwd(), "nonexistent-proxy-owner-only-root"),
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_PORT: String(upstreamPort),
    CLAWBOX_USER: "clawbox",
  });
  delete require_.cache[require_.resolve(SCRIPT)];
  const mod = require_(SCRIPT) as { createProxyServer: () => http.Server };
  proxy = mod.createProxyServer();
});

afterAll(async () => {
  await close(proxy);
  await close(upstream);
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("hermes-dashboard-proxy — owner only", () => {
  it("opens the dashboard for the owner, with a cookie from before multi-user", async () => {
    const port = await listen(proxy!);
    const res = await get(port, `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("dashboard ok");
    await new Promise<void>((r) => proxy!.close(() => r()));
  });

  it("refuses a second ClawBox user's valid session", async () => {
    const port = await listen(proxy!);
    const cookie = createSessionCookie(3600, SESSION_SECRET, 0, { u: "alice", sv: "a1b2c3d4e5f60718" });
    const res = await get(port, `clawbox_session=${cookie}`);
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain("dashboard ok");
  });
});
