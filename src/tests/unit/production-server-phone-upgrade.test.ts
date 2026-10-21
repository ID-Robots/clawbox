import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A phone reaches the box's OpenClaw gateway through the clawbox.tech tunnel:
 * cloudflared connects to production-server.js from 127.0.0.1, and the upgrade
 * proxy pipes the socket on to the gateway, also on 127.0.0.1. The proxy drops
 * every forwarded-client header on the way (the gateway refuses attribution
 * from a proxy it does not trust), so a phone on the other side of the world
 * arrived looking EXACTLY like a process on the box. The core treats a clean
 * loopback client as local and silently approves its first pairing and its
 * scope upgrades (OpenClaw 2026.10.3, `resolvePairingLocality` →
 * `direct_local`, `shouldAllowSilentLocalPairing`).
 *
 * The phone link (`/phone-ws`, the address every phone pairing code names)
 * must therefore reach the gateway carrying the phone's real address, as an
 * overwrite of whatever the client claimed, so the core sees a remote client
 * behind a trusted loopback proxy. It must not open at all while the owner has
 * phone pairing switched off, or when the proxy cannot say who the client is.
 * Every other gateway upgrade — the box's own pages, over the LAN or the
 * tunnel — must keep looking local exactly as before.
 *
 * production-server.js cannot be imported (it patches http.Server and requires
 * Next), so these cases run the SHIPPED upgrade proxy, lifted out of the file
 * by name as production-server-parked-build.test.ts and
 * novnc-close-frame.test.ts do, against a fake gateway socket.
 */

const REPO = process.cwd();
const SRC = readFileSync(path.join(REPO, "production-server.js"), "utf-8");
const requireCjs = createRequire(path.join(REPO, "package.json"));
const sessionCookie = requireCjs("./scripts/session-cookie.js");
const hostAllowlist = requireCjs("./scripts/host-allowlist.js");

/** The phone-link helpers production-server.js requires, when this tree has them. */
function phoneModule(): Record<string, unknown> {
  try {
    return requireCjs("./scripts/phone-upgrade.js");
  } catch {
    return {};
  }
}

/** One top-level `function NAME(…) { … }` from the file, by balanced braces. */
function shippedFunction(name: string): string {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`production-server.js no longer defines ${name}()`);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start + 1, i + 1);
  }
  throw new Error(`${name}() in production-server.js is not brace-balanced`);
}

/** One top-level `const NAME = …;` statement, brackets balanced, strings skipped. */
function shippedConst(name: string): string {
  const start = SRC.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`production-server.js no longer defines const ${name}`);
  let depth = 0;
  for (let i = start + 1; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < SRC.length && SRC[i] !== c; i++) if (SRC[i] === "\\") i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return SRC.slice(start + 1, i + 1);
  }
  throw new Error(`const ${name} in production-server.js has no end`);
}

interface UpstreamHead {
  requestLine: string;
  headers: Record<string, string[]>;
}

/** A stand-in gateway: records each upgrade's request head and answers 101. */
function fakeGateway(): Promise<{ port: number; heads: UpstreamHead[]; close: () => Promise<void> }> {
  const heads: UpstreamHead[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [requestLine, ...lines] = buf.slice(0, end).split("\r\n");
      const headers: Record<string, string[]> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon).trim().toLowerCase();
        (headers[key] ??= []).push(line.slice(colon + 1).trim());
      }
      heads.push({ requestLine, headers });
      sock.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, heads, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** The shipped proxy, wired to the fake gateway and a temp data/config.json. */
function shippedUpgradeProxy(configPath: string, gatewayPort: number): (server: http.Server) => void {
  const deps: Record<string, unknown> = {
    ...phoneModule(),
    net,
    fs,
    GATEWAY_PORT: gatewayPort,
    TERMINAL_WS_PORT: 1,
    NOVNC_WS_PORT: 1,
    CONFIG_JSON_PATH: configPath,
    USERS_CONFIG_KEY: sessionCookie.USERS_CONFIG_KEY,
    parseUserRegistry: sessionCookie.parseUserRegistry,
    ownerUsername: sessionCookie.ownerUsername,
    isAllowedUpgrade: hostAllowlist.isAllowedUpgrade,
    resolveAppPort: () => null,
    upgradeSessionIdentity: () => null,
    relayedChatUser: () => null,
    relayUserChatUpgrade: () => {
      throw new Error("no user relay in these cases");
    },
    terminalHeadersFor: () => ({}),
    closeFrameSanitizer: () => {
      throw new Error("no close-frame sanitizer in these cases");
    },
  };
  const body = [
    shippedConst("TERMINAL_TOKEN_HEADER"),
    shippedConst("TERMINAL_USER_HEADER"),
    shippedConst("UPGRADE_ROUTES"),
    shippedConst("FORWARDED_CLIENT_HEADERS"),
    "let sessionConfigCache = null;",
    ...[
      "isTerminalControlHeader",
      "originFormTarget",
      "resolveUpgradeTarget",
      "readSessionConfig",
      "authorizeUpgrade",
      "rejectForeignHostUpgrade",
      "rejectUpgrade",
      "attachUpgradeProxy",
    ].map(shippedFunction),
    "return attachUpgradeProxy;",
  ].join("\n");
  const names = Object.keys(deps);
  return new Function(...names, body)(...names.map((n) => deps[n])) as (server: http.Server) => void;
}

let dir: string;
let configPath: string;
let gateway: Awaited<ReturnType<typeof fakeGateway>>;
let proxy: http.Server;
let proxyPort: number;

/** Each case gets a fresh proxy (and so an empty mtime cache) before its first upgrade. */
function writeConfig(config: Record<string, unknown>) {
  writeFileSync(configPath, JSON.stringify(config));
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-phone-upgrade-"));
  configPath = path.join(dir, "config.json");
  writeConfig({ phone_pairing_enabled: true });
  gateway = await fakeGateway();
  proxy = http.createServer();
  shippedUpgradeProxy(configPath, gateway.port)(proxy);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  proxyPort = (proxy.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One upgrade from 127.0.0.1 — where cloudflared connects from — with these headers. */
function upgrade(
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: string; upstream: UpstreamHead | null }> {
  const before = gateway.heads.length;
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ status: buf.split("\r\n")[0] ?? "", upstream: gateway.heads[before] ?? null });
    };
    const timer = setTimeout(() => {
      done = true;
      sock.destroy();
      reject(new Error(`no answer to ${target}`));
    }, 4_000);
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.includes("\r\n")) finish();
    });
    sock.on("close", finish);
    sock.on("error", () => {});
    const lines = [
      `GET ${target} HTTP/1.1`,
      "Host: box-handle.clawbox.tech",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    sock.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

const FORWARDED_NAMES = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
];

describe("the phone link over the tunnel (/phone-ws)", () => {
  it("reaches the gateway carrying the phone's real address, not looking like a local client", async () => {
    const { status, upstream } = await upgrade("/phone-ws", { "CF-Connecting-IP": "203.0.113.7", "CF-Ray": "8f0c" });

    expect(status).toMatch(/^HTTP\/1\.1 101/);
    expect(upstream).not.toBeNull();
    expect(upstream!.requestLine).toBe("GET / HTTP/1.1");
    expect(upstream!.headers["x-forwarded-for"]).toEqual(["203.0.113.7"]);
    expect(upstream!.headers["x-forwarded-proto"]).toEqual(["https"]);
    expect(upstream!.headers["cf-connecting-ip"]).toBeUndefined();
    expect(upstream!.headers["cf-ray"]).toBeUndefined();
    expect(upstream!.headers.host).toEqual([`127.0.0.1:${gateway.port}`]);
  });

  it("overwrites forwarded headers the client made up instead of passing them on", async () => {
    const { upstream } = await upgrade("/phone-ws?v=1", {
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "10.42.0.99",
      "X-Forwarded-Proto": "http",
      "X-Real-IP": "10.42.0.99",
      Forwarded: "for=10.42.0.99",
    });

    expect(upstream).not.toBeNull();
    expect(upstream!.requestLine).toBe("GET /?v=1 HTTP/1.1");
    expect(upstream!.headers["x-forwarded-for"]).toEqual(["203.0.113.7"]);
    expect(upstream!.headers["x-forwarded-proto"]).toEqual(["https"]);
    expect(upstream!.headers["x-real-ip"]).toBeUndefined();
    expect(upstream!.headers.forwarded).toBeUndefined();
  });

  it("does not open while the owner has phone pairing switched off", async () => {
    writeConfig({});
    const { status, upstream } = await upgrade("/phone-ws", { "CF-Connecting-IP": "203.0.113.7" });
    expect(status).toMatch(/^HTTP\/1\.1 404/);
    expect(upstream).toBeNull();
  });

  it("refuses a loopback caller that cannot be attributed, rather than letting it pass as local", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "CF-Connecting-IP": "not-an-address" },
      { "CF-Connecting-IP": "127.0.0.1" },
      { "CF-Connecting-IP": "0:0:0:0:0:0:0:1" },
      { "CF-Connecting-IP": "0:0:0:0:0:ffff:127.0.0.1" },
    ];
    for (const headers of cases) {
      const { status, upstream } = await upgrade("/phone-ws", headers);
      expect(status).toMatch(/^HTTP\/1\.1 403/);
      expect(upstream).toBeNull();
    }
  });

  it("is the same gate when the target is spelled in absolute form", async () => {
    const attributed = await upgrade("http://box-handle.clawbox.tech/phone-ws?v=1", {
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "10.42.0.99",
    });
    expect(attributed.status).toMatch(/^HTTP\/1\.1 101/);
    expect(attributed.upstream!.requestLine).toBe("GET /?v=1 HTTP/1.1");
    expect(attributed.upstream!.headers["x-forwarded-for"]).toEqual(["203.0.113.7"]);

    const unattributed = await upgrade("http://box-handle.clawbox.tech/phone-ws");
    expect(unattributed.status).toMatch(/^HTTP\/1\.1 403/);
    expect(unattributed.upstream).toBeNull();
  });

  it("stays closed in absolute form while phone pairing is switched off", async () => {
    writeConfig({});
    const { status, upstream } = await upgrade("http://box-handle.clawbox.tech/phone-ws", { "CF-Connecting-IP": "203.0.113.7" });
    expect(status).toMatch(/^HTTP\/1\.1 404/);
    expect(upstream).toBeNull();
  });
});

describe("every other gateway upgrade is unchanged", () => {
  it("the box's own pages over the tunnel still reach the gateway with no forwarded headers at all", async () => {
    const { status, upstream } = await upgrade("/", {
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "203.0.113.7",
      "X-Forwarded-Proto": "https",
    });

    expect(status).toMatch(/^HTTP\/1\.1 101/);
    expect(upstream!.requestLine).toBe("GET / HTTP/1.1");
    for (const name of FORWARDED_NAMES) expect(upstream!.headers[name]).toBeUndefined();
  });

  it("a path that only starts with the phone link's name is not the phone link", async () => {
    const { upstream } = await upgrade("/phone-wsx", { "CF-Connecting-IP": "203.0.113.7" });
    expect(upstream!.requestLine).toBe("GET /phone-wsx HTTP/1.1");
    for (const name of FORWARDED_NAMES) expect(upstream!.headers[name]).toBeUndefined();
  });
});

describe("the HTTPS listener", () => {
  it("routes upgrades through the same gate and sends the same rebuilt attribution", () => {
    const https = SRC.slice(SRC.indexOf('httpsServer.on("upgrade"'));
    const handler = https.slice(0, https.indexOf("\n    });\n"));
    expect(handler).toContain("authorizeUpgrade(gate, req)");
    expect(handler).toMatch(/\.\.\.\s*auth\.forwarded/);
  });
});
