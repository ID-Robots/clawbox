/**
 * The session's span watcher (scripts/x64-migration/kiosk/clawbox-desktop-span.mjs):
 * which window it spreads over the row, and that nothing a page fails to
 * answer can stop it.
 *
 * The CDP half is driven over a stubbed `fetch` and `WebSocket`, the way
 * monitors-server.test.ts drives the web server's own copy of it. The last
 * case runs the real script with `--watch` against a loopback DevTools stand-in
 * on an ephemeral port whose page accepts the socket and never answers — what a
 * page behind a JS dialog does — and a fake `wlr-randr` on PATH. Nothing here
 * dials the kiosk's real DevTools port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logicalSize, parseWlrRandr } from "@/lib/monitors-layout";
import { createWatcher, isShellPage, layoutBox, shellSignature, spanWindow } from "../../../scripts/x64-migration/kiosk/clawbox-desktop-span.mjs";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SPAN = path.resolve(__dirname, "../../../scripts/x64-migration/kiosk/clawbox-desktop-span.mjs");
const DESKTOP = "http://desk.invalid:8080/";
const BOX = { width: 5120, height: 1440 };

// ── Chrome, stubbed ─────────────────────────────────────────────────────────

let targets: unknown = [];
/** What Chrome's /json/version answers (null: no browser endpoint to dial). */
let version: unknown = null;
let fetched: string[] = [];
let liveViolations: string[] = [];

type Reply = (method: string, socket: FakeSocket) => Record<string, unknown> | null;

class FakeSocket {
  static instances: FakeSocket[] = [];
  /** `null` = the page never answers that call. */
  static reply: Reply = () => ({});
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  constructor(public url: string) {
    if (/:(18800|18801|3005)\b/.test(url)) liveViolations.push(url);
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(raw: string) {
    const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
    this.sent.push({ method: msg.method, params: msg.params });
    const result = FakeSocket.reply(msg.method, this);
    if (result === null) return;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }));
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
}

/** A window in display mode `mode` at `bounds`. */
function windowReplies(mode: string, bounds: { width: number; height: number; windowState: string }): Reply {
  return (method) => {
    if (method === "Runtime.evaluate") return { result: { type: "string", value: mode } };
    if (method === "Browser.getWindowForTarget") return { windowId: 3, bounds };
    return {};
  };
}

const page = (id: string, url = DESKTOP) => ({ type: "page", id, url, webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/page/${id}` });

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  targets = [];
  version = null;
  fetched = [];
  liveViolations = [];
  FakeSocket.instances = [];
  FakeSocket.reply = () => ({});
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (/:(18800|18801|3005)\b/.test(url)) liveViolations.push(url);
    fetched.push(url);
    if (url.endsWith("/json/version")) return new Response(JSON.stringify(version), { status: 200 });
    return new Response(JSON.stringify(targets), { status: 200 });
  });
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(liveViolations).toEqual([]);
});

// ── layoutBox ───────────────────────────────────────────────────────────────

function output(name: string, x: number, scale: number, mode = "2560x1440") {
  return [
    `${name} "Acme X (${name})"`, "  Enabled: yes", "  Modes:", `    ${mode} px, 60.000000 Hz (preferred, current)`,
    `  Position: ${x},0`, "  Transform: normal", `  Scale: ${scale.toFixed(6)}`,
  ].join("\n");
}

describe("layoutBox", () => {
  it("truncates each monitor's logical size the way wlroots does", () => {
    // 2560 px at 1.5x is 1706 px in the compositor's layout (1706.67 cut, not rounded).
    const text = [output("HDMI-A-1", 0, 1.5), output("DP-1", 1706, 1.5)].join("\n");
    expect(layoutBox(text)).toEqual({ width: 3412, height: 960 });
    expect(layoutBox(output("DP-1", 0, 1.75))).toEqual({ width: 1462, height: 822 });
    expect(layoutBox(output("DP-1", 0, 1.25, "1366x768"))).toEqual({ width: 1092, height: 614 });
  });

  it("agrees with the web server's logicalSize at every offered scale", () => {
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 1.234375]) {
      for (const mode of ["2560x1440", "1920x1080", "1366x768", "3840x2160"]) {
        const text = output("DP-1", 0, scale, mode);
        const [o] = parseWlrRandr(text);
        expect(layoutBox(text), `${mode}@${scale}`).toEqual(logicalSize(o.current!.width, o.current!.height, o.scale, o.transform));
      }
    }
  });
});

// ── Which window ────────────────────────────────────────────────────────────

describe("isShellPage", () => {
  it("is the desktop shell's own pages on the desktop's origin, and nothing else", () => {
    for (const p of ["", "login", "setup", "setup/wifi", "updating", "portal", "?x=1", "#a"]) {
      expect(isShellPage(`${DESKTOP}${p}`, DESKTOP), p).toBe(true);
    }
    for (const u of [`${DESKTOP}app/clawbox`, `${DESKTOP}apps/game/`, `${DESKTOP}setup-api/webapps?app=x`, "https://example.com/", "http://desk.invalid:9090/", "not a url"]) {
      expect(isShellPage(u, DESKTOP), u).toBe(false);
    }
  });
});

describe("spanWindow", () => {
  it("spreads the app window (`standalone`) over the row", async () => {
    targets = [page("A")];
    FakeSocket.reply = windowReplies("standalone", { width: 1280, height: 800, windowState: "maximized" });
    expect(await spanWindow(1, DESKTOP, BOX)).toBe(true);
    expect(FakeSocket.instances[0].sent.slice(2).map((s) => s.params)).toEqual([
      { windowId: 3, bounds: { windowState: "normal" } },
      { windowId: 3, bounds: { left: 0, top: 0, width: 5120, height: 1440 } },
    ]);
    expect(FakeSocket.instances[0].closed).toBe(true);
  });

  it("leaves alone an ordinary window in full screen, and a normal tab of the desktop", async () => {
    targets = [page("F"), page("T")];
    FakeSocket.reply = (method, socket) =>
      windowReplies(socket.url.endsWith("/F") ? "fullscreen" : "browser", { width: 2560, height: 1440, windowState: "fullscreen" })(method, socket);
    expect(await spanWindow(1, DESKTOP, BOX)).toBe(false);
    for (const ws of FakeSocket.instances) expect(ws.sent.map((s) => s.method)).toEqual(["Runtime.evaluate"]);
  });

  it("takes the app window out of full screen once a pass has seen it as the app window", async () => {
    const known: string[] = [];
    targets = [page("A")];
    FakeSocket.reply = windowReplies("standalone", { width: 5120, height: 1440, windowState: "normal" });
    expect(await spanWindow(1, DESKTOP, BOX, known)).toBe(true);
    expect(known).toEqual(["A"]);
    FakeSocket.instances = [];
    FakeSocket.reply = windowReplies("fullscreen", { width: 2560, height: 1440, windowState: "fullscreen" });
    expect(await spanWindow(1, DESKTOP, BOX, known)).toBe(true);
    expect(FakeSocket.instances[0].sent.map((s) => s.method)).toEqual([
      "Runtime.evaluate", "Browser.getWindowForTarget", "Browser.setWindowBounds", "Browser.setWindowBounds",
    ]);
    // A watcher that never saw it (a fresh one) leaves it be.
    FakeSocket.instances = [];
    expect(await spanWindow(1, DESKTOP, BOX, [])).toBe(false);
  });

  it("never asks a page the desktop opened, and answers false for a list that is not a list", async () => {
    targets = [page("P", `${DESKTOP}app/clawbox`), { type: "service_worker", url: DESKTOP, webSocketDebuggerUrl: "ws://127.0.0.1:1/sw" }];
    expect(await spanWindow(1, DESKTOP, BOX)).toBe(false);
    expect(FakeSocket.instances).toEqual([]);
    targets = { nope: true };
    expect(await spanWindow(1, DESKTOP, BOX)).toBe(false);
  });

  it("gives up on a page that never answers, and goes on to the next", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    targets = [page("H"), page("A")];
    FakeSocket.reply = (method, socket) =>
      socket.url.endsWith("/H") ? null : windowReplies("standalone", { width: 1, height: 1, windowState: "normal" })(method, socket);
    let result: boolean | null = null;
    void spanWindow(1, DESKTOP, BOX).then((r) => { result = r; });
    await flush();
    expect(FakeSocket.instances.map((w) => w.sent.map((s) => s.method))).toEqual([["Runtime.evaluate"]]);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(result).toBe(true);
    expect(FakeSocket.instances.map((w) => w.closed)).toEqual([true, true]);
  });

  it("settles every call still waiting when the page's socket closes under it", async () => {
    targets = [page("C")];
    FakeSocket.reply = (_method, socket) => {
      socket.close();
      return null;
    };
    expect(await spanWindow(1, DESKTOP, BOX)).toBe(false);
  });
});

// ── The watcher's look ──────────────────────────────────────────────────────

/**
 * Every 2 s the watcher reads the row; it used to attach to every desktop page
 * and run a script in it on every one of those looks too. A look whose row,
 * pages and window are what the last full pass left asks the BROWSER alone —
 * and anything else, at once, gets the full pass it always got.
 */
describe("createWatcher", () => {
  const BROWSER_WS = "ws://127.0.0.1:1/devtools/browser/B";
  const pageSockets = () => FakeSocket.instances.filter((s) => s.url.includes("/devtools/page/"));
  const browserSockets = () => FakeSocket.instances.filter((s) => s.url === BROWSER_WS);

  /** The app window `A`, wherever Chrome has it: a set moves it, as labwc honours one. */
  let win = { width: 5120, height: 1440, windowState: "normal" };
  let row: { width: number; height: number } | null = { ...BOX };
  let clock = 0;
  /** Browser.getWindowBounds: `null` never answers; "close" drops the socket under the call. */
  let boundsReply: "answer" | "close" = "answer";

  beforeEach(() => {
    version = { webSocketDebuggerUrl: BROWSER_WS };
    targets = [page("A")];
    win = { width: 5120, height: 1440, windowState: "normal" };
    row = { ...BOX };
    clock = 0;
    boundsReply = "answer";
    FakeSocket.reply = (method, socket) => {
      if (method === "Runtime.evaluate") return { result: { type: "string", value: "standalone" } };
      if (method === "Browser.getWindowForTarget") return { windowId: 3, bounds: { ...win } };
      if (method === "Browser.setWindowBounds") {
        win = { ...win, ...(socket.sent.at(-1)!.params.bounds as object) };
        return {};
      }
      if (method === "Browser.getWindowBounds") {
        if (boundsReply === "close") {
          socket.close();
          return null;
        }
        return { bounds: { left: 0, top: 0, ...win } };
      }
      return {};
    };
  });

  const watcher = () => createWatcher(1, DESKTOP, { readBox: async () => (row ? { ...row } : null), now: () => clock });
  /** One look, `ms` after the last. */
  const look = async (w: ReturnType<typeof createWatcher>, ms = 2_000) => {
    clock += ms;
    return w.tick();
  };

  it("a row that stands still is confirmed by the browser alone: no page is attached after the first look", async () => {
    const w = watcher();
    expect(await w.tick()).toBe(true);
    expect(pageSockets()).toHaveLength(1);
    for (let i = 0; i < 10; i++) expect(await look(w)).toBe(true);

    expect(pageSockets()).toHaveLength(1);
    // One socket to the browser, kept open, one question per look.
    expect(browserSockets()).toHaveLength(1);
    expect(browserSockets()[0].closed).toBe(false);
    expect(browserSockets()[0].sent).toEqual(Array.from({ length: 10 }, () => ({ method: "Browser.getWindowBounds", params: { windowId: 3 } })));
    expect(fetched.filter((u) => u.endsWith("/json/version"))).toHaveLength(1);
    expect(fetched.filter((u) => u.endsWith("/json/list"))).toHaveLength(11);
  });

  it("a row that changed is spread at the very next look", async () => {
    const w = watcher();
    await w.tick();
    await look(w);
    row = { width: 2560, height: 1440 };
    expect(await look(w)).toBe(true);
    expect(pageSockets()).toHaveLength(2);
    expect(pageSockets()[1].sent.at(-1)).toEqual({
      method: "Browser.setWindowBounds",
      params: { windowId: 3, bounds: { left: 0, top: 0, width: 2560, height: 1440 } },
    });
    // ...and from there that row is the steady one.
    await look(w);
    expect(pageSockets()).toHaveLength(2);
  });

  it("a window Chrome put back maximized, or at another size, is spread again at the very next look", async () => {
    const w = watcher();
    await w.tick();
    win = { width: 2560, height: 1440, windowState: "maximized" };
    expect(await look(w)).toBe(true);
    expect(pageSockets()).toHaveLength(2);
    expect(pageSockets()[1].sent.slice(2).map((s) => s.params)).toEqual([
      { windowId: 3, bounds: { windowState: "normal" } },
      { windowId: 3, bounds: { left: 0, top: 0, width: 5120, height: 1440 } },
    ]);
    win = { ...win, width: 5000 };
    await look(w);
    expect(pageSockets()).toHaveLength(3);
    expect(win).toMatchObject({ width: 5120, height: 1440, windowState: "normal" });
    await look(w);
    expect(pageSockets()).toHaveLength(3);
  });

  it("desktop pages other than the ones the last pass asked — another address, another window — get the full pass", async () => {
    const w = watcher();
    await w.tick();
    targets = [page("A", `${DESKTOP}login`)];
    await look(w);
    expect(pageSockets()).toHaveLength(2);
    targets = [page("B"), page("A", `${DESKTOP}login`)];
    await look(w);
    expect(pageSockets()).toHaveLength(3);
    // A page the desktop opened is not one the full pass would ask: no pass for it.
    targets = [page("B"), page("A", `${DESKTOP}login`), page("P", `${DESKTOP}app/clawbox`)];
    await look(w);
    expect(pageSockets()).toHaveLength(3);
  });

  it("a browser socket that closes under the question gets the full pass, and the next look dials a fresh one", async () => {
    const w = watcher();
    await w.tick();
    await look(w);
    boundsReply = "close";
    expect(await look(w)).toBe(true);
    expect(pageSockets()).toHaveLength(2);
    boundsReply = "answer";
    expect(await look(w)).toBe(true);
    expect(pageSockets()).toHaveLength(2);
    expect(browserSockets()).toHaveLength(2);
  });

  it("still makes the full pass every 30 s", async () => {
    const w = watcher();
    await w.tick();
    for (let i = 0; i < 14; i++) await look(w);
    expect(pageSockets()).toHaveLength(1);
    await look(w);
    expect(pageSockets()).toHaveLength(2);
  });

  // The session's clock is stepped by NTP (no RTC). Timed on Date, a step back
  // held off the 30 s full pass for as long as the step; the watcher's own
  // clock, left at its default, is the monotonic one.
  it("a wall clock stepped back does not hold off the 30 s full pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let mono = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    const w = createWatcher(1, DESKTOP, { readBox: async () => (row ? { ...row } : null) });
    await w.tick();
    vi.setSystemTime(Date.now() - 60 * 60_000);
    for (let i = 0; i < 14; i++) {
      mono += 2_000;
      await w.tick();
    }
    expect(pageSockets()).toHaveLength(1);
    mono += 2_000;
    await w.tick();
    expect(pageSockets()).toHaveLength(2);
  });

  it("a wall clock stepped forward does not cut the 30 s short", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let mono = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    const w = createWatcher(1, DESKTOP, { readBox: async () => (row ? { ...row } : null) });
    await w.tick();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    mono += 2_000;
    await w.tick();
    expect(pageSockets()).toHaveLength(1);
  });

  it("a Chrome with no browser endpoint is looked at in full every time, as before", async () => {
    version = { Browser: "Chrome" };
    const w = watcher();
    for (let i = 0; i < 4; i++) expect(await look(w)).toBe(true);
    expect(pageSockets()).toHaveLength(4);
    expect(browserSockets()).toHaveLength(0);
  });

  it("no row, or no app window, keeps nothing to shortcut with", async () => {
    const w = watcher();
    await w.tick();
    row = null;
    expect(await look(w)).toBe(false);
    row = { ...BOX };
    await look(w);
    expect(pageSockets()).toHaveLength(2);
    targets = [];
    expect(await look(w)).toBe(false);
    targets = [page("A")];
    await look(w);
    expect(pageSockets()).toHaveLength(3);
  });
});

describe("shellSignature / spanWindow's `found`", () => {
  it("is the desktop pages in the list's order, and what a pass that found the window leaves", async () => {
    const list = [page("B", `${DESKTOP}login`), page("P", `${DESKTOP}app/x`), page("A")];
    expect(shellSignature(list, DESKTOP)).toBe(JSON.stringify([["B", `${DESKTOP}login`], ["A", DESKTOP]]));
    expect(shellSignature([page("A"), page("B", `${DESKTOP}login`)], DESKTOP)).not.toBe(shellSignature(list, DESKTOP));
    expect(shellSignature({ nope: true }, DESKTOP)).toBeNull();

    targets = [page("A")];
    FakeSocket.reply = windowReplies("standalone", { width: 5120, height: 1440, windowState: "normal" });
    const found: Record<string, unknown> = {};
    expect(await spanWindow(1, DESKTOP, BOX, [], found)).toBe(true);
    expect(found).toEqual({ windowId: 3, shells: shellSignature(targets, DESKTOP) });
  });
});

// ── The watcher, as the session runs it ─────────────────────────────────────

describe("clawbox-desktop-span.mjs --watch", () => {
  let work = "";
  let server: http.Server | null = null;
  let child: ChildProcess | null = null;
  const open = new Set<import("node:net").Socket>();

  afterEach(async () => {
    child?.kill("SIGKILL");
    child = null;
    for (const socket of open) socket.destroy();
    open.clear();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it("keeps watching after a page that never answers (it used to exit with an unsettled await)", async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-span-"));
    const bin = path.join(work, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "wlr-randr"), `#!/bin/sh\ncat <<'EOF'\n${output("HDMI-A-1", 0, 1)}\nEOF\n`, { mode: 0o755 });

    // A DevTools stand-in: one desktop page whose socket opens and never answers.
    let lists = 0;
    let frames = 0;
    server = http.createServer((req, res) => {
      if (req.url === "/json/list") {
        lists++;
        const port = (server!.address() as AddressInfo).port;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ type: "page", id: "D", url: "http://127.0.0.1:9/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/D` }]));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on("connection", (socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    });
    server.on("upgrade", (req, socket) => {
      const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", () => { frames++; });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const watcher = spawn(process.execPath, [SPAN, String(port), "http://127.0.0.1:9/", "--watch"], {
      env: { NODE_ENV: "test", PATH: `${bin}:/usr/bin:/bin`, HOME: work },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = watcher;
    let stderr = "";
    watcher.stderr!.on("data", (d) => { stderr += String(d); });

    // The first pass's call goes unanswered for its 4 s ceiling; the watcher
    // must then sleep and look again rather than exit.
    const until = Date.now() + 15_000;
    while (lists < 2 && watcher.exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(stderr).not.toContain("unsettled top-level await");
    expect(watcher.exitCode).toBeNull();
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(frames).toBeGreaterThanOrEqual(1);
  });
});
