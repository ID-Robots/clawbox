/**
 * Who is on the CDP port. The bug this pins: a foreign Chromium answers
 * /json/version like ours does and only reveals itself on the upgrade, with
 * a 403 for our Origin — the readiness check has to do the upgrade.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { findPlaywrightChromium, parsePortOwner, probeCdp, upgradeStatus } from "@/lib/cdp-probe";

let server: http.Server | null = null;

/** A fake Chromium that answers /json/version and treats the upgrade as told. */
function fakeChromium(onUpgrade: "accept" | "forbid"): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        const port = (server!.address() as { port: number }).port;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (req, socket) => {
      if (onUpgrade === "forbid") {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

describe("probing the CDP port", () => {
  it("calls a Chromium that accepts our Origin ours", async () => {
    const endpoint = await fakeChromium("accept");
    expect(await probeCdp(endpoint, endpoint)).toBe("ours");
  });

  it("calls a Chromium that answers /json/version but forbids our Origin foreign — the bug seen live", async () => {
    const endpoint = await fakeChromium("forbid");
    expect(await probeCdp(endpoint, endpoint)).toBe("foreign");
  });

  it("calls a silent port down, quickly", async () => {
    expect(await probeCdp("http://127.0.0.1:1", "http://127.0.0.1:1")).toBe("down");
    expect(await upgradeStatus("not a url", "x")).toBeNull();
  });
});

describe("naming the port's owner", () => {
  it("reads pid and process name off ss -tlnp", () => {
    const ss = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      511          0.0.0.0:80         0.0.0.0:*     users:(("node",pid=19000,fd=20))',
      'LISTEN 0      10         127.0.0.1:188001     0.0.0.0:*    users:(("python3",pid=41,fd=3))',
      'LISTEN 0      10         127.0.0.1:18800      0.0.0.0:*    users:(("chrome",pid=67257,fd=68))',
    ].join("\n");
    expect(parsePortOwner(ss, 18800)).toEqual({ comm: "chrome", pid: 67257 });
    expect(parsePortOwner(ss, 18801)).toBeNull();
    // The port ends the address column, whatever follows it — but an owner
    // still needs a process field.
    expect(parsePortOwner('LISTEN 0 10 [::1]:18800  \t', 18800)).toBeNull();
    expect(parsePortOwner('LISTEN 0 10 [::1]:18800 users:(("chrome",pid=9,fd=1))  ', 18800)).toEqual({ comm: "chrome", pid: 9 });
  });
});

describe("finding Playwright's Chromium on the box", () => {
  it("prefers the headless shell of any revision, and answers null for an empty cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-playwright-"));
    try {
      expect(findPlaywrightChromium(root)).toBeNull();
      // A full chrome of a newer revision and a headless shell of an older one —
      // the same shape as this box (1234 expected, 1208 installed).
      const chrome = path.join(root, "chromium-1234", "chrome-linux", "chrome");
      const shell = path.join(root, "chromium_headless_shell-1208", "chrome-linux", "headless_shell");
      for (const f of [chrome, shell]) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
      }
      expect(findPlaywrightChromium(root)).toBe(shell);
      // The manage route reports on the browser the owner will SEE, and a
      // headless shell cannot open that window: full chrome only there.
      expect(findPlaywrightChromium(root, { preferHeadless: false })).toBe(chrome);
      fs.rmSync(path.dirname(shell), { recursive: true });
      expect(findPlaywrightChromium(root)).toBe(chrome);
      fs.rmSync(path.dirname(chrome), { recursive: true });
      expect(findPlaywrightChromium(root, { preferHeadless: false })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the newest revision by number, not by spelling", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-playwright-"));
    try {
      const older = path.join(root, "chromium-999", "chrome-linux64", "chrome");
      const newer = path.join(root, "chromium-1234", "chrome-linux-arm64", "chrome");
      for (const f of [older, newer]) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
      }
      expect(findPlaywrightChromium(root)).toBe(newer);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
