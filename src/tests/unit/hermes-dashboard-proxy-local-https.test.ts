import fs from "fs";
import http from "http";
import https from "https";
import { createRequire } from "module";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSessionCookie } from "@/lib/auth";
import { HOST, type TestCa, leafFor, testCa, writeStateFile, writeStubCa, writeTlsFile } from "@/tests/helpers/local-https";

/**
 * The Hermes dashboard proxy on a box with Local HTTPS (docs/design/local-https.md).
 * The desktop builds the dashboard's URL from its own scheme, so a desktop on
 * https://<id>.lan.clawbox.com opens https://<id>.lan.clawbox.com:8090 — and
 * its session cookie is Secure there. Pinned: :8090 answers TLS with the box's
 * certificate AND plain HTTP on the same port; the Local HTTPS name is one of
 * the box's own names only while the feature is on; the HTTPS desktop is a
 * trusted referrer; and a request without a session is sent to the login on
 * its own scheme.
 */

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(process.cwd(), "scripts/hermes-dashboard-proxy.js");
const SESSION_SECRET = "test-session-secret-for-proxy-local-https";
/** TEST-NET-1 (RFC 5737). */
const LAN_IP = "192.0.2.10";

const ENV_KEYS = ["SESSION_SECRET", "ALLOWED_HOSTS", "CLAWBOX_ROOT", "HERMES_DASH_HOST", "HERMES_PORT", "HTTPS_PORT"] as const;
const envBefore = new Map<string, string | undefined>();

let upstream: http.Server;
let upstreamPort: number;
let root: string;
let ca: TestCa;
let front: net.Server | undefined;
let port: number;

function cookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}; hermes_session_at=stub`;
}

interface Reply {
  status: number;
  body: string;
  location?: string;
}

function send(secure: boolean, host: string, headers: Record<string, string> = {}): Promise<Reply> {
  const mod = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { host, accept: "text/html", ...headers },
        ...(secure ? { servername: HOST, ca: ca.certPem } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("no answer")));
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) envBefore.set(key, process.env[key]);
  upstream = http.createServer((_req, res) => res.end("dashboard ok"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-proxy-https-"));
  ca = testCa();
  const leaf = leafFor(ca);
  writeStubCa(root, ca);
  writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
  writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
  Object.assign(process.env, {
    SESSION_SECRET,
    ALLOWED_HOSTS: "localhost",
    CLAWBOX_ROOT: root,
    HERMES_DASH_HOST: "127.0.0.1",
    HERMES_PORT: String(upstreamPort),
  });
  delete process.env.HTTPS_PORT;
  delete require_.cache[require_.resolve(SCRIPT)];
  const mod = require_(SCRIPT) as { createTlsAwareListener: () => net.Server };
  front = mod.createTlsAwareListener();
  await new Promise<void>((resolve) => front!.listen(0, "127.0.0.1", resolve));
  port = (front.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (front ? front.close(() => resolve()) : resolve()));
  front = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the Hermes dashboard proxy with Local HTTPS", () => {
  it("serves the dashboard over TLS on its port, for the HTTPS desktop", async () => {
    const reply = await send(true, `${HOST}:${port}`, { cookie: cookie(), referer: `https://${HOST}/` });
    expect(reply).toMatchObject({ status: 200, body: "dashboard ok" });
  });

  it("still serves plain HTTP on the same port", async () => {
    const reply = await send(false, `${LAN_IP}:${port}`, { cookie: cookie(), referer: `http://${LAN_IP}/` });
    expect(reply).toMatchObject({ status: 200, body: "dashboard ok" });
  });

  it("sends a request without a session to the login on its own scheme", async () => {
    expect((await send(true, `${HOST}:${port}`)).location).toBe(`https://${HOST}/login`);
    expect((await send(false, `${LAN_IP}:${port}`)).location).toBe(`http://${LAN_IP}/login`);
  });

  it("trusts the HTTPS desktop on 443, and no other port of it", async () => {
    expect((await send(true, `${HOST}:${port}`, { cookie: cookie(), referer: `https://${HOST}:443/x` })).status).toBe(200);
    const foreign = await send(true, `${HOST}:${port}`, { cookie: cookie(), referer: `https://${HOST}:9999/` });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toContain("cross-origin referer");
  });

  it("refuses the name once the owner switched Local HTTPS off", async () => {
    writeStateFile(root, { enabled: false, hostname: null });
    const reply = await send(false, `${HOST}:${port}`, { cookie: cookie() });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("bad Host header");
  });
});
