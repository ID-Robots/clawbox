import { type ChildProcess, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import tls from "tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HOST, type TestCa, leafFor, testCa, writeStateFile, writeStubCa, writeTlsFile } from "@/tests/helpers/local-https";

/**
 * production-server.js's TLS listener with Local HTTPS (docs/design/local-https.md),
 * on a real process: a temp root holding the entry point, its CommonJS helpers
 * and a stand-in Next server (the upgrade-session-expiry harness). Pinned: no
 * listener while there is no valid certificate; it comes up by itself when one
 * lands, serving it for the box's name; a renewal is picked up without a
 * restart; switching the feature off takes it down.
 */

// A real node process, its boot and several 15 s waits for the listener.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const REPO = process.cwd();
const REFRESH_MS = 300;

let root: string;
let server: ChildProcess | undefined;
let serverLog = "";
let tlsPort = 0;
let ca: TestCa;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The leaf the listener presents for `servername`, or null when nothing listens / the handshake fails. */
function handshake(servername = HOST): Promise<{ fingerprint256: string; authorized: boolean } | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port: tlsPort, servername, ca: ca.certPem, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate();
      resolve({ fingerprint256: peer.fingerprint256, authorized: socket.authorized });
      socket.destroy();
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}

async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let last: T;
  do {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  throw new Error(`${what} never happened:\n${serverLog}`);
}

function fingerprintOf(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-local-https-server-"));
  fs.copyFileSync(path.join(REPO, "production-server.js"), path.join(root, "production-server.js"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of fs.readdirSync(path.join(REPO, "scripts"))) {
    if (name.endsWith(".js")) fs.copyFileSync(path.join(REPO, "scripts", name), path.join(root, "scripts", name));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".next", "standalone"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".next", "standalone", "server.js"),
    [
      'const http = require("http");',
      'const s = http.createServer((req, res) => { res.end("next"); });',
      's.on("upgrade", (req, socket) => socket.destroy());',
      's.listen(Number(process.env.PORT), "127.0.0.1");',
    ].join("\n"),
  );
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "local-https-test-secret");
  fs.writeFileSync(path.join(root, "data", "config.json"), "{}");
  ca = testCa();
  writeStubCa(root, ca);

  const port = await freePort();
  tlsPort = await freePort();
  server = spawn(process.execPath, [path.join(root, "production-server.js")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      NODE_ENV: "production",
      PORT: String(port),
      HTTPS_PORT: String(tlsPort),
      CLAWBOX_ROOT: root,
      CLAWBOX_OPENCLAW_HOME: path.join(root, ".openclaw"),
      CLOUDFLARED_BIN: "/nonexistent/cloudflared",
      CLAWBOX_HTTPS_REFRESH_MS: String(REFRESH_MS),
      SHUTDOWN_GRACE_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b) => (serverLog += b));
  server.stderr?.on("data", (b) => (serverLog += b));
  await eventually(
    () => new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    }),
    (up) => up,
    "the HTTP server listening",
  );
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("production-server.js with Local HTTPS", () => {
  it("has no TLS listener while there is no certificate", async () => {
    // Twice the refresh, so the first sync has certainly run.
    await new Promise((r) => setTimeout(r, REFRESH_MS * 2 + 600));
    expect(await handshake()).toBeNull();
  });

  it("comes up by itself when the certificate lands, serving it for the box's name", async () => {
    const leaf = leafFor(ca);
    writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
    writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    const got = await eventually(() => handshake(), (v) => v?.fingerprint256 === fingerprintOf(leaf.certPem), "the listener serving the certificate");
    expect(got?.authorized).toBe(true);
  });

  it("serves a renewal without a restart", async () => {
    const pid = server!.pid;
    const renewed = leafFor(ca);
    writeTlsFile(root, { hostname: HOST, key: renewed.keyPem, cert: renewed.chainPem });
    await eventually(() => handshake(), (v) => v?.fingerprint256 === fingerprintOf(renewed.certPem), "the renewed certificate served");
    expect(server!.pid).toBe(pid);
    expect(server!.exitCode).toBeNull();
  });

  it("goes down when the owner switches the feature off, and up again when it is back", async () => {
    writeStateFile(root, { enabled: false, hostname: null });
    await eventually(() => handshake(), (v) => v === null, "the listener closing");
    expect(serverLog).toContain("HTTPS stopped");
    const leaf = leafFor(ca);
    writeStateFile(root, { enabled: true, hostname: HOST, stubPortal: true });
    writeTlsFile(root, { hostname: HOST, key: leaf.keyPem, cert: leaf.chainPem });
    await eventually(() => handshake(), (v) => v?.fingerprint256 === fingerprintOf(leaf.certPem), "the listener back");
  });
});
