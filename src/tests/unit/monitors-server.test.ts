/**
 * Monitor mode, the server half: src/lib/monitors.ts and
 * src/app/setup-api/monitors/route.ts, driven end to end over a FAKE
 * `wlr-randr` — a shell script in a temp dir (CLAWBOX_WLR_RANDR) that prints a
 * fixture for a read and records the argv of every apply — and a real unix
 * socket standing in for the compositor's `wayland-N` (findWaylandDisplays asks
 * `isSocket()`).
 *
 * The monitor-mode session is told apart from the cage kiosk by the marker
 * clawbox-desktop-session leaves in the runtime dir (its pid, which is
 * labwc's): here it names THIS process, and CLAWBOX_MONITORS_COMPOSITOR names
 * this process's own `comm` in place of "labwc".
 *
 * Nothing here reaches the box: the kiosk file, the runtime dir, the lid dir
 * and the data dir are all temp paths, `fetch` and `WebSocket` are stubbed so
 * the desktop-window resize never dials a Chrome (the kiosk's real DevTools
 * port is live on the machine these were written on), and the CDP port is
 * pointed at 1, where nothing listens, should a stub ever be bypassed.
 *
 * Auth is the REAL stack (route-auth, owner-session, same-origin) over a
 * config.json and session secret in the temp root, so the owner gate is tested
 * as it runs rather than mocked out of existence.
 */
import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every case spawns the fake wlr-randr (a real /bin/sh) at least once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { ROOT, SECRET, MCP_TOKEN, savedEnv } = await vi.hoisted(async () => {
  const [nodeFs, nodeOs, nodePath] = await Promise.all([import("fs"), import("os"), import("path")]);
  const keys = [
    "CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAWBOX_USER", "CLAWBOX_TEST_MODE",
    "CLAWBOX_KIOSK_URL", "CLAWBOX_KIOSK_ENV_FILE", "CLAWBOX_KIOSK_CDP_PORT", "CLAWBOX_WLR_RANDR",
    "CLAWBOX_MONITORS_RUNTIME_DIR", "CLAWBOX_MONITORS_LID_DIR", "CLAWBOX_MONITORS_COMPOSITOR",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-monitors-root-"));
  const secret = "monitors-test-session-secret-0123456789abcdef";
  const token = "monitors-test-mcp-bearer-0123456789abcdef";
  // config-store and mcp-token capture these at import time.
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = secret;
  process.env.CLAWBOX_MCP_TOKEN = token;
  process.env.CLAWBOX_USER = "clawbox";
  delete process.env.CLAWBOX_TEST_MODE;
  return { ROOT: root, SECRET: secret, MCP_TOKEN: token, savedEnv: saved };
});

import { GET, POST } from "@/app/setup-api/monitors/route";
import {
  MONITORS_FILE,
  MONITOR_MODE_MARKER,
  RECONCILE_INTERVAL_MS,
  REVERT_AFTER_MS,
  REVERT_RETRY_MS,
  MAX_REVERT_ATTEMPTS,
  _resetMonitorsForTests,
  applyMonitorLayout,
  findWaylandDisplays,
  getMonitorStatus,
  keepMonitorLayout,
  lidClosed,
  monitorModeSession,
  reconcileMonitors,
  revertMonitorLayout,
  spanDesktopWindow,
  startMonitorReconciler,
  type MonitorStatus,
} from "@/lib/monitors";
import type { MonitorLayout } from "@/lib/monitors-layout";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = path.resolve(__dirname, "../fixtures/monitors");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
/** The test machine's own session: two AOC monitors in a row, the built-in panel off. */
const SAMPLE = fixture("server-session-sample.txt");
const BUILTIN_EXTERNAL = fixture("server-builtin-external.txt");
const BUILTIN_ONLY = fixture("server-builtin-only.txt");

const DP2 = "AOC|Q27B3MA|17ZP6HA000002";
const HDMI = "AOC|Q27B3MA|17ZP6HA000001";
const EDP = "BOE|0x06DF|@eDP-1";

const DATA = path.join(ROOT, "data");
const OWNER_URL = "http://clawbox.local/setup-api/monitors";
const KIOSK_URL = "http://desk.invalid:8080/";

/** The fixture's state on screen, as wlr-randr args: what a Revert puts back. */
const SAMPLE_ON_SCREEN = [
  "--output", "eDP-1", "--off",
  "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "0,0",
  "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
  "--output", "DP-2", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "2560,0",
  "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
];

/** DP-2 down to 1080p, moved to the left of HDMI-A-1, and made the main monitor. */
const DP2_1080_LEFT: MonitorLayout = {
  order: [DP2, HDMI],
  main: DP2,
  monitors: { [DP2]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" } },
};
const DP2_1080_LEFT_ARGS = [
  "--output", "eDP-1", "--off",
  "--output", "DP-2", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "0,0",
  "--transform", "normal", "--scale", "1",
  "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "1920,0",
  "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
];

// ── The fake compositor ─────────────────────────────────────────────────────

let work = "";
let runtimeDir = "";
let lidDir = "";
let kioskEnv = "";
const sockets: net.Server[] = [];

function writeFakeWlrRandr(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "wlr-randr");
  // The child gets ONLY NODE_ENV, PATH, XDG_RUNTIME_DIR and WAYLAND_DISPLAY,
  // so the work dir is baked in rather than passed through the environment.
  fs.writeFileSync(
    file,
    `#!/bin/sh
D='${dir}'
if [ "$#" -eq 0 ]; then
  echo "$WAYLAND_DISPLAY" >> "$D/reads.log"
  if [ -e "$D/slow-read" ]; then sleep 0.4; fi
  if [ -e "$D/refuse-$WAYLAND_DISPLAY" ]; then
    echo "compositor doesn't support wlr-output-management-unstable-v1" >&2
    exit 1
  fi
  cat "$D/outputs.txt"
  exit 0
fi
{
  echo "@@call runtime=$XDG_RUNTIME_DIR display=$WAYLAND_DISPLAY secret=\${SESSION_SECRET:-none} token=\${CLAWBOX_MCP_TOKEN:-none} root=\${CLAWBOX_ROOT:-none}"
  for a in "$@"; do printf '%s\\n' "$a"; done
} >> "$D/calls.log"
if [ -e "$D/slow-apply" ]; then sleep 1.2; fi
if [ -e "$D/fail-apply" ]; then
  echo "failed to apply output configuration" >&2
  exit 1
fi
if [ -e "$D/die-apply" ]; then
  kill -TERM $$
fi
case " $* " in
  *" --adaptive-sync "*)
    if [ -e "$D/refuse-adaptive" ]; then
      echo "adaptive sync is not supported" >&2
      exit 1
    fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return file;
}

interface WlrCall { header: string; args: string[] }

/** Every apply the fake was asked for, in order (a failed one included). */
function applyCalls(): WlrCall[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(work, "calls.log"), "utf8");
  } catch {
    return [];
  }
  const calls: WlrCall[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("@@call ")) calls.push({ header: line, args: [] });
    else if (line && calls.length) calls[calls.length - 1].args.push(line);
  }
  return calls;
}

/** The displays the fake was asked to READ, in order. */
function reads(): string[] {
  try {
    return fs.readFileSync(path.join(work, "reads.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function setOutputs(text: string) {
  fs.writeFileSync(path.join(work, "outputs.txt"), text);
}

function marker(name: string, on = true) {
  const p = path.join(work, name);
  if (on) fs.writeFileSync(p, "");
  else fs.rmSync(p, { force: true });
}

/** A real unix socket (the compositor's `wayland-N`), with an explicit mtime. */
async function addWaylandSocket(name: string, mtimeSeconds?: number): Promise<string> {
  const p = path.join(runtimeDir, name);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, () => resolve());
  });
  sockets.push(server);
  if (mtimeSeconds !== undefined) fs.utimesSync(p, mtimeSeconds, mtimeSeconds);
  return p;
}

/** This process's own name, standing in for "labwc". */
const OWN_COMM = fs.readFileSync("/proc/self/comm", "utf8").trim();

/** The marker clawbox-desktop-session leaves: the pid of the session's compositor. */
function setSession(pid: number | string | null) {
  const p = path.join(runtimeDir, MONITOR_MODE_MARKER);
  if (pid === null) fs.rmSync(p, { force: true });
  else fs.writeFileSync(p, `${pid}\n`);
}

/** Live processes standing in for a compositor (`sleep`), ended after each case. */
const standIns: ChildProcess[] = [];
function standIn(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  standIns.push(child);
  return child.pid!;
}

/** A pid no process has (above any pid_max). */
const GONE_PID = 2147483646;

function setLid(state: "open" | "closed", entry = "LID0") {
  fs.mkdirSync(path.join(lidDir, entry), { recursive: true });
  fs.writeFileSync(path.join(lidDir, entry, "state"), `state:      ${state}\n`);
}

function readSavedFile(): { version: number; layout: MonitorLayout | null; applied: { main: string | null; mainOutput: string | null; box: { width: number; height: number } | null } | null } {
  return JSON.parse(fs.readFileSync(MONITORS_FILE, "utf8"));
}

// ── The desktop window's Chrome, stubbed ────────────────────────────────────

let cdpTargets: unknown[] = [];
let cdpFetches: string[] = [];
let liveViolations: string[] = [];

async function fakeFetch(input: unknown): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  cdpFetches.push(url);
  if (/:(18800|18801|3005)\b/.test(url)) {
    liveViolations.push(url);
    throw new Error(`test reached a live port: ${url}`);
  }
  return new Response(JSON.stringify(cdpTargets), { status: 200, headers: { "content-type": "application/json" } });
}

type CdpReply = (method: string, params: Record<string, unknown>) => Record<string, unknown> | null;

class FakeCdpSocket {
  static instances: FakeCdpSocket[] = [];
  /** `null` = the page never answers that call. */
  static reply: CdpReply = () => ({});
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  constructor(public url: string) {
    if (/:(18800|18801|3005)\b/.test(url)) liveViolations.push(url);
    FakeCdpSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(raw: string) {
    const msg = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
    this.sent.push({ method: msg.method, params: msg.params });
    const result = FakeCdpSocket.reply(msg.method, msg.params);
    if (result === null) return;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }));
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
}

/** A window at `bounds` in display mode `mode`: "standalone" is the desktop's `--app` window. */
function appWindowReplies(bounds: { width: number; height: number; windowState: string }, mode: string | boolean = "standalone"): CdpReply {
  const value = mode === true ? "browser" : mode === false ? "standalone" : mode;
  return (method) => {
    if (method === "Runtime.evaluate") return { result: { type: "string", value } };
    if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds };
    return {};
  };
}

const desktopTarget = (id = "A", url = KIOSK_URL) => ({
  type: "page",
  id,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/page/${id}`,
});

async function flushImmediates(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ── Requests ────────────────────────────────────────────────────────────────

function mintCookie(claims: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen: 0, ...claims })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `clawbox_session=${payload}.${sig}`;
}
const OWNER = mintCookie();
/** A registered ClawBox user who is not the owner (TASK-1256). */
const GUEST = mintCookie({ u: "guest", sv: "0123abcd" });

function get(headers: Record<string, string> = { cookie: OWNER }) {
  return GET(new Request(OWNER_URL, { headers }));
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request(OWNER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: OWNER, origin: "http://clawbox.local", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** A request layout built from the fixture's current state, then edited. */
function layoutBody(edit: (l: { order: string[]; main: string | null; monitors: Record<string, Record<string, unknown>>; mirror?: boolean }) => void) {
  const l = {
    order: [HDMI, DP2, EDP],
    main: HDMI as string | null,
    monitors: {
      [HDMI]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal" },
      [DP2]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal" },
    } as Record<string, Record<string, unknown>>,
  };
  edit(l);
  return { action: "apply", layout: l };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  _resetMonitorsForTests();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-monitors-"));
  runtimeDir = path.join(work, "run");
  lidDir = path.join(work, "lid");
  kioskEnv = path.join(work, "kiosk.env");
  fs.mkdirSync(runtimeDir);
  setSession(process.pid);
  fs.writeFileSync(kioskEnv, `CLAWBOX_KIOSK_URL=${KIOSK_URL}\n`);
  setLid("open");
  setOutputs(SAMPLE);
  await addWaylandSocket("wayland-0");

  process.env.CLAWBOX_WLR_RANDR = writeFakeWlrRandr(work);
  process.env.CLAWBOX_MONITORS_RUNTIME_DIR = runtimeDir;
  process.env.CLAWBOX_KIOSK_ENV_FILE = kioskEnv;
  process.env.CLAWBOX_MONITORS_LID_DIR = lidDir;
  process.env.CLAWBOX_MONITORS_COMPOSITOR = OWN_COMM;
  process.env.CLAWBOX_KIOSK_CDP_PORT = "1";
  delete process.env.CLAWBOX_KIOSK_URL;
  delete process.env.CLAWBOX_TEST_MODE;

  fs.mkdirSync(DATA, { recursive: true });
  fs.rmSync(MONITORS_FILE, { force: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({
    password_configured: true,
    setup_complete: true,
    session_generation: 0,
    clawbox_users: [{ username: "guest", createdAt: "2026-10-01T00:00:00Z", sv: "0123abcd" }],
  }));

  cdpTargets = [];
  cdpFetches = [];
  liveViolations = [];
  FakeCdpSocket.instances = [];
  FakeCdpSocket.reply = () => ({});
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("WebSocket", FakeCdpSocket);
});

afterEach(async () => {
  _resetMonitorsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(sockets.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const child of standIns.splice(0)) child.kill("SIGKILL");
  fs.rmSync(work, { recursive: true, force: true });
  expect(liveViolations, "a test reached a live port").toEqual([]);
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("monitors: availability", () => {
  const UNAVAILABLE: MonitorStatus = { available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false };

  it("is unavailable on a box with no kiosk, and never runs wlr-randr there", async () => {
    process.env.CLAWBOX_KIOSK_ENV_FILE = path.join(work, "missing-kiosk.env");
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
    expect(await reconcileMonitors()).toBe(false);
    await expect(applyMonitorLayout(DP2_1080_LEFT)).rejects.toMatchObject({ code: "unavailable" });
    expect(reads()).toEqual([]);
    expect(applyCalls()).toEqual([]);
    expect(fs.existsSync(MONITORS_FILE)).toBe(false);
  });

  it("is unavailable with a kiosk but no Wayland session", async () => {
    await Promise.all(sockets.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    expect(fs.readdirSync(runtimeDir)).toEqual([MONITOR_MODE_MARKER]);
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
    expect(reads()).toEqual([]);
  });

  it("ignores a `wayland-N` that is not a socket, and lock files beside it", async () => {
    await Promise.all(sockets.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    fs.writeFileSync(path.join(runtimeDir, "wayland-0"), "");
    fs.writeFileSync(path.join(runtimeDir, "wayland-1.lock"), "");
    expect(findWaylandDisplays()).toEqual([]);
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
    expect(reads()).toEqual([]);
  });

  it("is unavailable when the compositor does not speak wlr-output-management", async () => {
    marker("refuse-wayland-0");
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
    expect(reads()).toEqual(["wayland-0"]);
  });

  it("is unavailable when the compositor lists no outputs", async () => {
    setOutputs("");
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
  });

  it("lists the newest socket first and falls back past a compositor that is not ours", async () => {
    const now = Math.floor(Date.now() / 1000);
    fs.utimesSync(path.join(runtimeDir, "wayland-0"), now - 600, now - 600);
    await addWaylandSocket("wayland-1", now);
    expect(findWaylandDisplays().map((d) => d.display)).toEqual(["wayland-1", "wayland-0"]);
    expect(findWaylandDisplays()[0].runtimeDir).toBe(runtimeDir);

    marker("refuse-wayland-1");
    const status = await getMonitorStatus();
    expect(status.available).toBe(true);
    expect(reads()).toEqual(["wayland-1", "wayland-0"]);
  });
});

describe("monitors: only the ClawBox Desktop session", () => {
  const UNAVAILABLE: MonitorStatus = { available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false };

  /** Nothing ran: no read, no apply, no window resize, nothing recorded. */
  async function expectInert() {
    expect(await getMonitorStatus()).toEqual(UNAVAILABLE);
    expect(await reconcileMonitors()).toBe(false);
    await expect(applyMonitorLayout(DP2_1080_LEFT)).rejects.toMatchObject({ code: "unavailable" });
    expect(reads()).toEqual([]);
    expect(applyCalls()).toEqual([]);
    expect(cdpFetches).toEqual([]);
    expect(fs.existsSync(MONITORS_FILE)).toBe(false);
  }

  it("does nothing in the cage kiosk session, which answers wlr-randr too but leaves no marker", async () => {
    setSession(null);
    await expectInert();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  it("does nothing when the marker names a process that is gone (a session that ended)", async () => {
    setSession(GONE_PID);
    await expectInert();
  });

  it("does nothing when the marker names a live process that is not the session's compositor (a reused pid)", async () => {
    delete process.env.CLAWBOX_MONITORS_COMPOSITOR;
    expect(OWN_COMM).not.toBe("labwc");
    await expectInert();
  });

  it.each([["empty", ""], ["not a number", "labwc"], ["pid 0", "0"], ["negative", "-1"], ["two pids", `${process.pid} 1`]])(
    "does nothing for a marker that is %s",
    async (_label, text) => {
      fs.writeFileSync(path.join(runtimeDir, MONITOR_MODE_MARKER), text);
      await expectInert();
    },
  );

  it("names the session's compositor by its pid", () => {
    expect(monitorModeSession(runtimeDir)).toBe(process.pid);
    const pid = standIn();
    process.env.CLAWBOX_MONITORS_COMPOSITOR = "sleep";
    setSession(pid);
    expect(monitorModeSession(runtimeDir)).toBe(pid);
    expect(monitorModeSession(path.join(work, "elsewhere"))).toBeNull();
  });

  it("the boot hook's ticks apply nothing outside the session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    setSession(null);
    startMonitorReconciler();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
    await reconcileMonitors();
    expect(reads()).toEqual([]);
    expect(applyCalls()).toEqual([]);
  });
});

describe("monitors: status", () => {
  it("describes the session's monitors, left to right, with the main one and the row's size", async () => {
    const s = await getMonitorStatus();
    expect(s.available).toBe(true);
    expect(s.order).toEqual([HDMI, DP2, EDP]);
    // No saved choice: the first monitor that is on and is not the built-in panel.
    expect(s.main).toBe(HDMI);
    expect(s.box).toEqual({ width: 5120, height: 1440 });
    expect(s.pending).toBeNull();
    expect(s.mirror).toBe(false);

    const byId = Object.fromEntries(s.monitors.map((m) => [m.id, m]));
    expect(s.monitors.map((m) => m.name)).toEqual(["DP-2", "HDMI-A-1", "eDP-1"]);
    expect(byId[DP2]).toMatchObject({
      name: "DP-2", label: "AOC Q27B3MA", builtIn: false, enabled: true,
      current: { width: 2560, height: 1440, refresh: 59.951 }, scale: 1, transform: "normal",
      rect: { x: 2560, y: 0, width: 2560, height: 1440 }, physicalSize: { width: 600, height: 340 }, adaptiveSync: false,
    });
    expect(byId[HDMI].rect).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
    expect(byId[EDP]).toMatchObject({
      name: "eDP-1", label: "BOE 0x06DF", builtIn: true, enabled: false, current: null,
      rect: null, physicalSize: { width: 310, height: 170 }, adaptiveSync: null,
    });
    // Duplicated modes (same size and refresh) are folded, biggest first.
    expect(byId[DP2].modes).toHaveLength(32);
    expect(byId[DP2].modes[0]).toEqual({ width: 2560, height: 1440, refresh: 74.968002, preferred: false });
    expect(byId[DP2].modes[1]).toEqual({ width: 2560, height: 1440, refresh: 59.951, preferred: true });
    expect(byId[EDP].modes).toHaveLength(2);
  });

  it("names the main monitor the last applied layout chose, while it is on", async () => {
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({ version: 1, layout: null, applied: { main: DP2, mainOutput: "DP-2", box: null } }));
    expect((await getMonitorStatus()).main).toBe(DP2);
    // A main monitor that is off now is not the main one.
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({ version: 1, layout: null, applied: { main: EDP, mainOutput: "eDP-1", box: null } }));
    expect((await getMonitorStatus()).main).toBe(HDMI);
  });

  it("reads a damaged monitors.json as nothing saved", async () => {
    fs.writeFileSync(MONITORS_FILE, "{ not json");
    const s = await getMonitorStatus();
    expect(s.available).toBe(true);
    expect(s.main).toBe(HDMI);
  });

  it("reports a mirrored session", async () => {
    setOutputs(SAMPLE.replace("Position: 2560,0", "Position: 0,0"));
    const s = await getMonitorStatus();
    expect(s.mirror).toBe(true);
    expect(s.box).toEqual({ width: 2560, height: 1440 });
  });
});

describe("monitors: apply, keep, revert", () => {
  it("puts a layout on screen ON TRIAL with one wlr-randr call over the session's socket", async () => {
    const before = Date.now();
    const s = await applyMonitorLayout(DP2_1080_LEFT);
    const after = Date.now();

    expect(s.pending).not.toBeNull();
    expect(s.pending!.deadline).toBeGreaterThanOrEqual(before + REVERT_AFTER_MS);
    expect(s.pending!.deadline).toBeLessThanOrEqual(after + REVERT_AFTER_MS);
    expect(s.main).toBe(DP2);

    const calls = applyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(DP2_1080_LEFT_ARGS);
    expect(calls[0].header).toContain(`runtime=${runtimeDir} display=wayland-0`);

    // What is on screen is recorded for the session; nothing is SAVED yet.
    expect(readSavedFile()).toEqual({
      version: 1,
      layout: null,
      applied: { main: DP2, mainOutput: "DP-2", box: { width: 4480, height: 1440 } },
    });
    expect(fs.statSync(MONITORS_FILE).mode & 0o777).toBe(0o600);

    // The desktop window was asked to span the new row, on the kiosk's CDP port.
    expect(cdpFetches).toEqual(["http://127.0.0.1:1/json/list"]);
  });

  it("hands wlr-randr none of the web server's secrets", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    const [call] = applyCalls();
    expect(call.header).toContain("secret=none");
    expect(call.header).toContain("token=none");
    expect(call.header).toContain("root=none");
  });

  it("Keep saves the layout on trial, and its timer no longer reverts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await applyMonitorLayout(DP2_1080_LEFT);
    const kept = await keepMonitorLayout();
    expect(kept.pending).toBeNull();

    const saved = readSavedFile();
    expect(saved.layout).toEqual({
      order: [DP2, HDMI, EDP],
      main: DP2,
      monitors: {
        [DP2]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" },
        [HDMI]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", adaptiveSync: false },
        [EDP]: { enabled: false, width: 1920, height: 1080, refresh: 60.012001, scale: 1, transform: "normal" },
      },
    });
    expect(saved.applied).toEqual({ main: DP2, mainOutput: "DP-2", box: { width: 4480, height: 1440 } });

    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS * 2);
    await expect(revertMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls()).toHaveLength(1);
  });

  it("Revert puts back what was on screen before, and saves nothing", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    const s = await revertMonitorLayout();
    expect(s.pending).toBeNull();
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(SAMPLE_ON_SCREEN);
    expect(readSavedFile().layout).toBeNull();
    expect(readSavedFile().applied).toEqual({ main: HDMI, mainOutput: "HDMI-A-1", box: { width: 5120, height: 1440 } });
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
  });

  it("two Applies in a row still revert to the layout before the first", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    await applyMonitorLayout({
      order: [HDMI, DP2],
      main: HDMI,
      monitors: { [DP2]: { enabled: true, width: 1280, height: 720, refresh: 60, scale: 1, transform: "normal" } },
    });
    await revertMonitorLayout();
    const calls = applyCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toContain("1280x720@60.000000Hz");
    expect(calls[2].args).toEqual(SAMPLE_ON_SCREEN);
  });

  it("a second Apply restarts the trial's clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await applyMonitorLayout(DP2_1080_LEFT);
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS - 1_000);
    await applyMonitorLayout({ ...DP2_1080_LEFT, main: HDMI });
    // The first trial's deadline passes: no revert, the second trial stands.
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await getMonitorStatus()).pending).not.toBeNull();
    expect(applyCalls()).toHaveLength(2);
  });

  it("the trial reverts on its own when Keep never comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await applyMonitorLayout(DP2_1080_LEFT);

    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS - 1);
    expect((await getMonitorStatus()).pending).not.toBeNull();
    expect(applyCalls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    // Keep queues behind the timer's revert (one change at a time), so by the
    // time it answers the revert has run — and there is nothing left to keep.
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(SAMPLE_ON_SCREEN);
    expect(readSavedFile().layout).toBeNull();
  });

  it("an Apply over a kept layout keeps the saved settings of the monitors it does not name", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    await keepMonitorLayout();
    await applyMonitorLayout({
      order: [DP2, HDMI],
      main: DP2,
      monitors: { [HDMI]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" } },
    });
    expect(applyCalls()[1].args).toEqual([
      "--output", "eDP-1", "--off",
      "--output", "DP-2", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1",
      "--output", "HDMI-A-1", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "1920,0", "--transform", "normal", "--scale", "1",
    ]);
    // Reverting this trial goes back to the screen, not to the kept file.
    await revertMonitorLayout();
    expect(applyCalls()[2].args).toEqual(SAMPLE_ON_SCREEN);
    expect(readSavedFile().layout?.monitors[DP2].width).toBe(1920);
  });

  it("mirrors every monitor that is on at the origin", async () => {
    const s = await applyMonitorLayout({ order: [HDMI, DP2], main: HDMI, monitors: {}, mirror: true });
    expect(s.pending).not.toBeNull();
    expect(applyCalls()[0].args).toEqual([
      "--output", "eDP-1", "--off",
      "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
      "--output", "DP-2", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
    ]);
    expect(readSavedFile().applied?.box).toEqual({ width: 2560, height: 1440 });
    // The session puts the shelf margin on every output while mirrored.
    expect((readSavedFile().applied as { mirror?: boolean } | null)?.mirror).toBe(true);
  });

  it("records no mirror for a row", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    expect((readSavedFile().applied as { mirror?: boolean } | null)?.mirror).toBeUndefined();
  });

  it("gives the owner the whole 20 s from when the layout is on screen, however slow the compositor", async () => {
    marker("slow-apply");
    await applyMonitorLayout(DP2_1080_LEFT);
    const onScreen = Date.now();
    marker("slow-apply", false);
    const pending = (await getMonitorStatus()).pending;
    // Counted from after wlr-randr returned (the read that follows is quick),
    // not from before it ran.
    expect(pending!.deadline).toBeGreaterThanOrEqual(onScreen + REVERT_AFTER_MS - 500);
  });

  it("retries once without variable refresh when the compositor refuses it", async () => {
    marker("refuse-adaptive");
    const s = await applyMonitorLayout(DP2_1080_LEFT);
    expect(s.pending).not.toBeNull();
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(DP2_1080_LEFT_ARGS);
    expect(calls[1].args).toEqual(DP2_1080_LEFT_ARGS.slice(0, -2));
    expect(calls[1].args).not.toContain("--adaptive-sync");
  });

  it("a layout the compositor refuses is apply_failed, leaves no trial and records nothing", async () => {
    marker("fail-apply");
    await expect(applyMonitorLayout(DP2_1080_LEFT)).rejects.toMatchObject({
      code: "apply_failed",
      message: expect.stringContaining("failed to apply output configuration"),
    });
    expect((await getMonitorStatus()).pending).toBeNull();
    expect(fs.existsSync(MONITORS_FILE)).toBe(false);
    expect(cdpFetches).toEqual([]);
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
  });

  it("Keep and Revert with nothing on trial are nothing_pending", async () => {
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    await expect(revertMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls()).toEqual([]);
  });

  // The trial is armed BEFORE wlr-randr runs, and the record of what is on
  // screen (data/monitors.json, for the session's shelf margin) is written
  // after it. A write that fails there (a full disk, a read-only data/) once
  // left the new layout up with `apply_failed`, nothing pending and no timer
  // to undo it — the black-screen safety net gone exactly when the owner was
  // told nothing happened. The record is best-effort now; the trial is not.
  (process.getuid?.() === 0 ? it.skip : it)(
    "a layout that reached the screen is on trial even when recording it fails",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fs.chmodSync(DATA, 0o500);
      let s: MonitorStatus;
      try {
        s = await applyMonitorLayout(DP2_1080_LEFT);
      } finally {
        fs.chmodSync(DATA, 0o700);
      }
      expect(applyCalls()[0].args).toEqual(DP2_1080_LEFT_ARGS);
      expect(s.pending).not.toBeNull();
      expect(warn).toHaveBeenCalledWith("[monitors] Could not record the layout on screen:", expect.any(String));
      // ...and it comes undone on its own.
      await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS);
      await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
      expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
    },
  );

  it("a refused second Apply leaves the first trial running to its own deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await applyMonitorLayout(DP2_1080_LEFT);
    marker("fail-apply");
    await expect(applyMonitorLayout({ ...DP2_1080_LEFT, main: HDMI })).rejects.toMatchObject({ code: "apply_failed" });
    marker("fail-apply", false);
    expect((await getMonitorStatus()).pending).toEqual({ deadline: first.pending!.deadline });
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS);
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
  });

  it("a wlr-randr killed mid-call leaves the layout on trial (the compositor may have taken it), undone on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    marker("die-apply");
    // Not "failed": the layout may well be on screen, and the panel is told so
    // (it reads the box again and shows Keep).
    await expect(applyMonitorLayout(DP2_1080_LEFT)).rejects.toMatchObject({ code: "apply_uncertain" });
    marker("die-apply", false);
    expect((await getMonitorStatus()).pending).not.toBeNull();
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS);
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
  });

  it("an old trial's timer that fires during the next Apply does not undo the new layout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await applyMonitorLayout(DP2_1080_LEFT);
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS - 500);
    // The second Apply is still reading the compositor when the first
    // trial's deadline passes; that timer's undo queues behind it.
    marker("slow-read");
    const second = applyMonitorLayout({ ...DP2_1080_LEFT, main: HDMI });
    await vi.advanceTimersByTimeAsync(1_000);
    const s = await second;
    marker("slow-read", false);
    expect(s.pending).not.toBeNull();
    await reconcileMonitors();
    expect(applyCalls()).toHaveLength(2);
    expect((await getMonitorStatus()).pending).toEqual(s.pending);
    // ...and Keep keeps it.
    await keepMonitorLayout();
    expect(readSavedFile().layout?.main).toBe(HDMI);
  });

  it("an undo the compositor refuses stays on trial and is tried again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyMonitorLayout(DP2_1080_LEFT);
    marker("fail-apply");
    await expect(revertMonitorLayout()).rejects.toMatchObject({ code: "revert_failed" });
    const after = Date.now();
    const pending = (await getMonitorStatus()).pending;
    expect(pending).not.toBeNull();
    expect(pending!.deadline).toBeLessThanOrEqual(after + REVERT_RETRY_MS);
    // Its own retry fails as well, and is armed again.
    await vi.advanceTimersByTimeAsync(REVERT_RETRY_MS);
    expect(await reconcileMonitors()).toBe(false);
    expect(warn).toHaveBeenCalledWith("[monitors] Could not undo the layout on trial:", expect.stringContaining("failed to apply"));
    expect((await getMonitorStatus()).pending).not.toBeNull();
    // The compositor takes it at last.
    marker("fail-apply", false);
    await vi.advanceTimersByTimeAsync(REVERT_RETRY_MS);
    await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
  });

  it("gives up an undo the compositor keeps refusing, and the saved layout comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyMonitorLayout(DP2_1080_LEFT);
    marker("fail-apply");
    await expect(revertMonitorLayout()).rejects.toMatchObject({ code: "revert_failed" });
    for (let i = 1; i < MAX_REVERT_ATTEMPTS; i++) {
      expect((await getMonitorStatus()).pending).not.toBeNull();
      await vi.advanceTimersByTimeAsync(REVERT_RETRY_MS);
      // The retry runs a real wlr-randr: wait for the monitor queue to drain.
      await reconcileMonitors();
    }
    // Given up: nothing pending, and no retry is armed any more...
    expect((await getMonitorStatus()).pending).toBeNull();
    // ...so the reconciler can act again, once the compositor takes a layout.
    marker("fail-apply", false);
    expect(await reconcileMonitors()).toBe(true);
    const calls = applyCalls().length;
    await vi.advanceTimersByTimeAsync(REVERT_RETRY_MS * 3);
    await reconcileMonitors();
    expect(applyCalls()).toHaveLength(calls);
  });

  it("the trial's own undo, refused, is retried too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyMonitorLayout(DP2_1080_LEFT);
    marker("fail-apply");
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS);
    expect(await reconcileMonitors()).toBe(false);
    expect((await getMonitorStatus()).pending).not.toBeNull();
    marker("fail-apply", false);
    await vi.advanceTimersByTimeAsync(REVERT_RETRY_MS);
    await expect(revertMonitorLayout()).rejects.toMatchObject({ code: "nothing_pending" });
    expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
  });

  (process.getuid?.() === 0 ? it.skip : it)("a Keep that cannot be saved leaves the layout on trial, and a later Keep saves it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyMonitorLayout(DP2_1080_LEFT);
    fs.chmodSync(DATA, 0o500);
    try {
      await expect(keepMonitorLayout()).rejects.toMatchObject({ code: "save_failed", message: "The monitor settings could not be saved" });
    } finally {
      fs.chmodSync(DATA, 0o700);
    }
    expect(warn).toHaveBeenCalledWith("[monitors] Could not save the monitor layout:", expect.stringContaining("EACCES"));
    expect((await getMonitorStatus()).pending).not.toBeNull();
    expect(readSavedFile().layout).toBeNull();
    await keepMonitorLayout();
    expect(readSavedFile().layout?.main).toBe(DP2);
    await vi.advanceTimersByTimeAsync(REVERT_AFTER_MS * 2);
    expect(applyCalls()).toHaveLength(1);
  });

  it("a kept layout the screen already shows is not put on screen a second time", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    // The compositor now shows the trial: DP-2 at 1080p on the left.
    setOutputs(
      SAMPLE.replace("2560x1440 px, 59.951000 Hz (preferred, current)", "2560x1440 px, 59.951000 Hz (preferred)")
        .replace("1920x1080 px, 60.000000 Hz", "1920x1080 px, 60.000000 Hz (current)")
        .replace("Position: 0,0", "Position: 1920,0")
        .replace("Position: 2560,0", "Position: 0,0"),
    );
    const kept = await keepMonitorLayout();
    expect(kept.box).toEqual({ width: 4480, height: 1440 });
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls()).toHaveLength(1);
  });

  it("a kept layout the screen does not show is put back by the reconciler", async () => {
    await applyMonitorLayout(DP2_1080_LEFT);
    await keepMonitorLayout();
    // The fake compositor still shows the old row.
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls().at(-1)!.args).toEqual(DP2_1080_LEFT_ARGS);
    expect(await reconcileMonitors()).toBe(false);
  });
});

describe("monitors: the reconciler", () => {
  const BOTH_ON_ARGS = [
    "--output", "eDP-1", "--on", "--mode", "1920x1080@60.012001Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1",
    "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "1920,0", "--transform", "normal", "--scale", "1",
  ];
  const LID_SHUT_ARGS = [
    "--output", "eDP-1", "--off",
    "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1",
  ];

  beforeEach(() => setOutputs(BUILTIN_EXTERNAL));

  it("applies the layout once per set of monitors, and again when the lid changes", async () => {
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls().map((c) => c.args)).toEqual([BOTH_ON_ARGS]);
    expect(readSavedFile().applied).toEqual({ main: HDMI, mainOutput: "HDMI-A-1", box: { width: 4480, height: 1440 } });

    // Nothing changed: nothing is applied.
    expect(await reconcileMonitors()).toBe(false);
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls()).toHaveLength(1);

    // The lid shuts: the built-in panel goes off while another monitor is there.
    setLid("closed");
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[1].args).toEqual(LID_SHUT_ARGS);
    expect(readSavedFile().applied?.box).toEqual({ width: 2560, height: 1440 });
    expect(await reconcileMonitors()).toBe(false);

    // ...and comes back when it opens.
    setLid("open");
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[2].args).toEqual(BOTH_ON_ARGS);
    expect(applyCalls()).toHaveLength(3);
  });

  it("puts the SAVED layout back, not the compositor's own idea", async () => {
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({
      version: 1,
      layout: {
        order: [HDMI, EDP],
        main: HDMI,
        monitors: {
          [HDMI]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" },
          [EDP]: { enabled: true, width: 1920, height: 1080, refresh: 60.012001, scale: 1.25, transform: "normal" },
        },
      },
      applied: null,
    }));
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[0].args).toEqual([
      "--output", "HDMI-A-1", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1",
      "--output", "eDP-1", "--on", "--mode", "1920x1080@60.012001Hz", "--pos", "1920,0", "--transform", "normal", "--scale", "1.25",
    ]);
  });

  it("re-applies when a monitor is unplugged, and a shut lid never leaves the box without a screen", async () => {
    setLid("closed");
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[0].args).toEqual(LID_SHUT_ARGS);

    setOutputs(BUILTIN_ONLY);
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[1].args).toEqual([
      "--output", "eDP-1", "--on", "--mode", "1920x1080@60.012001Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1",
    ]);
  });

  it("re-applies after the session restarts on a new socket", async () => {
    const now = Math.floor(Date.now() / 1000);
    fs.utimesSync(path.join(runtimeDir, "wayland-0"), now - 600, now - 600);
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[0].header).toContain("display=wayland-0");

    await addWaylandSocket("wayland-1", now);
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()).toHaveLength(2);
    expect(applyCalls()[1].header).toContain("display=wayland-1");
    expect(applyCalls()[1].args).toEqual(BOTH_ON_ARGS);
  });

  it("re-applies when a monitor dropped out and came back between two looks", async () => {
    // The owner's row: the panel on the left.
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({ version: 1, layout: { order: [EDP, HDMI], main: HDMI, monitors: {} }, applied: null }));
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[0].args).toEqual(BOTH_ON_ARGS);
    expect(await reconcileMonitors()).toBe(false);
    // The panel came back between two ticks, and the compositor put it where
    // it puts a new output: at the right end of the row. Same monitors, same
    // ids — a different screen.
    setOutputs(BUILTIN_EXTERNAL.replace("Position: 0,0", "Position: 2560,0").replace("Position: 1920,0", "Position: 0,0"));
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[1].args).toEqual(BOTH_ON_ARGS);
    // Judged by what the screen shows after: the next look finds the same.
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls()).toHaveLength(2);
  });

  it("does not re-apply when only variable refresh changed (a compositor may switch it for a full-screen window)", async () => {
    expect(await reconcileMonitors()).toBe(true);
    setOutputs(BUILTIN_EXTERNAL.replaceAll("Adaptive Sync: disabled", "Adaptive Sync: enabled"));
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls()).toHaveLength(1);
  });

  it("re-applies when the session's compositor restarted on the same socket name", async () => {
    process.env.CLAWBOX_MONITORS_COMPOSITOR = "sleep";
    setSession(standIn());
    expect(await reconcileMonitors()).toBe(true);
    expect(await reconcileMonitors()).toBe(false);
    setSession(standIn());
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()).toHaveLength(2);
    expect(applyCalls()[1].header).toContain("display=wayland-0");
  });

  it("a panel the owner sends as off while the lid is shut keeps the choice saved for it", async () => {
    // Saved with the lid open: the panel ON at 1.25x.
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({
      version: 1,
      layout: {
        order: [HDMI, EDP],
        main: HDMI,
        monitors: { [EDP]: { enabled: true, width: 1920, height: 1080, refresh: 60.012001, scale: 1.25, transform: "normal" } },
      },
      applied: null,
    }));
    setLid("closed");
    expect(await reconcileMonitors()).toBe(true);
    // The Settings tab sends every monitor as the status shows it: the panel off.
    await applyMonitorLayout({
      order: [HDMI, EDP],
      main: HDMI,
      monitors: {
        [HDMI]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" },
        [EDP]: { enabled: false, width: 1920, height: 1080, refresh: 60.012001, scale: 1.25, transform: "normal" },
      },
    });
    // Behind the shut lid it stays dark on screen...
    const trial = applyCalls().at(-1)!.args;
    expect(trial.slice(0, 3)).toEqual(["--output", "eDP-1", "--off"]);
    await keepMonitorLayout();
    // ...and is saved as the owner left it.
    expect(readSavedFile().layout?.monitors[EDP]).toMatchObject({ enabled: true, scale: 1.25 });
    expect(readSavedFile().layout?.monitors[HDMI]).toMatchObject({ width: 1920 });
  });

  it("a panel saved OFF stays off once the lid opens", async () => {
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({
      version: 1,
      layout: {
        order: [HDMI, EDP],
        main: HDMI,
        monitors: { [EDP]: { enabled: false, width: 1920, height: 1080, refresh: 60.012001, scale: 1, transform: "normal" } },
      },
      applied: null,
    }));
    setLid("closed");
    await reconcileMonitors();
    await applyMonitorLayout({ order: [HDMI, EDP], main: HDMI, monitors: {} });
    await keepMonitorLayout();
    expect(readSavedFile().layout?.monitors[EDP].enabled).toBe(false);
  });

  it("leaves a layout on trial alone", async () => {
    await applyMonitorLayout({ order: [HDMI, EDP], main: HDMI, monitors: {} });
    expect(await reconcileMonitors()).toBe(false);
    setLid("closed");
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls()).toHaveLength(1);
  });

  it("tries again on the next tick when the compositor refused the layout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    marker("fail-apply");
    expect(await reconcileMonitors()).toBe(false);
    expect(warn).toHaveBeenCalledWith("[monitors] Could not apply the saved layout:", expect.stringContaining("failed to apply"));
    marker("fail-apply", false);
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()).toHaveLength(2);
  });

  it("forgets the session when it goes away, and re-applies when one comes back", async () => {
    expect(await reconcileMonitors()).toBe(true);
    marker("refuse-wayland-0");
    expect(await reconcileMonitors()).toBe(false);
    marker("refuse-wayland-0", false);
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()).toHaveLength(2);
  });

  it("the boot hook starts nothing on a box with no kiosk", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    process.env.CLAWBOX_KIOSK_ENV_FILE = path.join(work, "missing-kiosk.env");
    startMonitorReconciler();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
    expect(reads()).toEqual([]);
    expect(applyCalls()).toEqual([]);
  });

  it("the boot hook reconciles on its interval, and starting it twice runs one loop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    startMonitorReconciler();
    startMonitorReconciler();
    expect(reads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    // A serialized call waits for the tick's reconcile to finish.
    expect(await reconcileMonitors()).toBe(false);
    expect(applyCalls().map((c) => c.args)).toEqual([BOTH_ON_ARGS]);
    // One tick (its look, and the look after it applied) plus this call's own
    // read: one loop, not two.
    expect(reads()).toHaveLength(3);
  });

  // Every tick used to APPEND a whole reconcile to the one serialized chain
  // whether or not the previous tick's was still running: while the
  // compositor answered slowly — wlr-randr runs into its 5 s timeout on a hung
  // compositor, against a 3 s interval — the queue grew without bound, and an
  // owner's Apply/Keep/Revert (and a trial's own timed revert) waited behind
  // every queued tick. A tick is skipped while one is in flight.
  it("a slow compositor does not pile up reconciles behind each other", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    marker("slow-read");
    startMonitorReconciler();
    // Five ticks arrive while the first tick's read is still running.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    await reconcileMonitors();
    // The first tick (its look, and the look after it applied) and this
    // call's own read: the four ticks in between were skipped.
    expect(reads().length).toBeLessThanOrEqual(3);
  });

  // The reconciler turns the built-in panel OFF behind a shut lid — a
  // transient state, not the owner's choice — but an Apply took "what is on
  // screen now" as the base for every monitor the request does not name (and
  // the Settings tab sends every monitor as the status shows it, which has no
  // lid fact either). Keep then SAVED the panel as switched off, so when the
  // lid opened the reconciler re-applied that and the panel stayed dark.
  it("a Keep made while the lid is shut does not save the built-in panel as switched off", async () => {
    setLid("closed");
    expect(await reconcileMonitors()).toBe(true);
    expect(applyCalls()[0].args).toEqual(LID_SHUT_ARGS);
    // ...which is what the compositor shows from now on.
    setOutputs(
      BUILTIN_EXTERNAL
        .replace("  Enabled: yes\n  Modes:\n    1920x1080 px, 60.012001 Hz (preferred, current)", "  Enabled: no\n  Modes:\n    1920x1080 px, 60.012001 Hz (preferred)")
        .replace("  Position: 0,0\n  Transform: normal\n  Scale: 1.000000\n  Adaptive Sync: disabled\nHDMI-A-1", "HDMI-A-1")
        .replace("Position: 1920,0", "Position: 0,0"),
    );
    const shown = await getMonitorStatus();
    expect(shown.monitors.find((m) => m.id === EDP)?.enabled).toBe(false);

    // The owner changes the external monitor only, and keeps it.
    await applyMonitorLayout({
      order: [HDMI],
      main: HDMI,
      monitors: { [HDMI]: { enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal" } },
    });
    await keepMonitorLayout();

    // The lid opens: the panel the lid switched off should come back.
    setLid("open");
    expect(await reconcileMonitors()).toBe(true);
    const last = applyCalls().at(-1)!.args;
    expect(last[last.indexOf("eDP-1") + 1]).toBe("--on");
  });
});

describe("monitors: lidClosed", () => {
  it("reads ACPI's lid state", () => {
    expect(lidClosed(lidDir)).toBe(false);
    setLid("closed");
    expect(lidClosed(lidDir)).toBe(true);
    // The default directory comes from CLAWBOX_MONITORS_LID_DIR.
    expect(lidClosed()).toBe(true);
  });

  it("answers false for a box with no lid, an empty lid dir, or a word that only contains `closed`", () => {
    expect(lidClosed(path.join(work, "no-such-dir"))).toBe(false);
    const empty = path.join(work, "empty-lid");
    fs.mkdirSync(empty);
    expect(lidClosed(empty)).toBe(false);
    fs.writeFileSync(path.join(lidDir, "LID0", "state"), "state:      unclosed\n");
    expect(lidClosed(lidDir)).toBe(false);
  });

  it("finds a shut lid among several", () => {
    setLid("open", "LID0");
    setLid("closed", "LID1");
    expect(lidClosed(lidDir)).toBe(true);
  });
});

describe("monitors: spreading the desktop window", () => {
  it("resizes the kiosk's app window over the row, after leaving a maximized state", async () => {
    cdpTargets = [desktopTarget()];
    FakeCdpSocket.reply = appWindowReplies({ width: 1280, height: 800, windowState: "maximized" });
    expect(await spanDesktopWindow({ width: 4480, height: 1440 })).toBe(true);
    const [ws] = FakeCdpSocket.instances;
    expect(ws.url).toBe("ws://127.0.0.1:1/devtools/page/A");
    expect(ws.sent.map((s) => s.method)).toEqual([
      "Runtime.evaluate", "Browser.getWindowForTarget", "Browser.setWindowBounds", "Browser.setWindowBounds",
    ]);
    expect(ws.sent[2].params).toEqual({ windowId: 7, bounds: { windowState: "normal" } });
    expect(ws.sent[3].params).toEqual({ windowId: 7, bounds: { left: 0, top: 0, width: 4480, height: 1440 } });
    expect(ws.closed).toBe(true);
  });

  it("does nothing to a window that already spans the row", async () => {
    cdpTargets = [desktopTarget()];
    FakeCdpSocket.reply = appWindowReplies({ width: 4480, height: 1440, windowState: "normal" });
    expect(await spanDesktopWindow({ width: 4480, height: 1440 })).toBe(true);
    expect(FakeCdpSocket.instances[0].sent.map((s) => s.method)).toEqual(["Runtime.evaluate", "Browser.getWindowForTarget"]);
  });

  it("leaves alone a desktop the owner opened as a normal tab, and pages of other origins", async () => {
    cdpTargets = [
      desktopTarget("B", "https://example.com/"),
      { type: "service_worker", url: KIOSK_URL, webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/sw" },
      desktopTarget("C"),
    ];
    FakeCdpSocket.reply = appWindowReplies({ width: 1, height: 1, windowState: "normal" }, true);
    expect(await spanDesktopWindow({ width: 4480, height: 1440 })).toBe(false);
    // Only the desktop page was opened, and it was only asked its display mode.
    expect(FakeCdpSocket.instances.map((w) => w.url)).toEqual(["ws://127.0.0.1:1/devtools/page/C"]);
    expect(FakeCdpSocket.instances[0].sent.map((s) => s.method)).toEqual(["Runtime.evaluate"]);
  });

  it("leaves alone an ORDINARY window the owner put in full screen (it reports `fullscreen` too)", async () => {
    // Chrome lists the most recently active first: the window just put in
    // full screen comes before the desktop.
    cdpTargets = [desktopTarget("N"), desktopTarget("A")];
    FakeCdpSocket.reply = appWindowReplies({ width: 2560, height: 1440, windowState: "fullscreen" }, "fullscreen");
    expect(await spanDesktopWindow({ width: 5120, height: 1440 })).toBe(false);
    for (const ws of FakeCdpSocket.instances) expect(ws.sent.map((s) => s.method)).toEqual(["Runtime.evaluate"]);
  });

  it("takes the desktop's app window out of full screen once it has been seen as the app window", async () => {
    cdpTargets = [desktopTarget("A")];
    FakeCdpSocket.reply = appWindowReplies({ width: 5120, height: 1440, windowState: "normal" });
    expect(await spanDesktopWindow({ width: 5120, height: 1440 })).toBe(true);
    // F11 on the desktop: now `fullscreen`, like any window in full screen.
    FakeCdpSocket.instances = [];
    FakeCdpSocket.reply = appWindowReplies({ width: 2560, height: 1440, windowState: "fullscreen" }, "fullscreen");
    expect(await spanDesktopWindow({ width: 5120, height: 1440 })).toBe(true);
    expect(FakeCdpSocket.instances[0].sent.slice(2).map((s) => s.params)).toEqual([
      { windowId: 7, bounds: { windowState: "normal" } },
      { windowId: 7, bounds: { left: 0, top: 0, width: 5120, height: 1440 } },
    ]);
    // Another target in full screen is still not it.
    cdpTargets = [desktopTarget("B")];
    FakeCdpSocket.instances = [];
    expect(await spanDesktopWindow({ width: 5120, height: 1440 })).toBe(false);
  });

  it("looks only at the desktop shell's own pages: a page the desktop opened is never asked", async () => {
    cdpTargets = [
      desktopTarget("P", `${KIOSK_URL}app/clawbox`),
      desktopTarget("W", `${KIOSK_URL}apps/game/`),
      desktopTarget("L", `${KIOSK_URL}login`),
    ];
    FakeCdpSocket.reply = appWindowReplies({ width: 1280, height: 800, windowState: "normal" });
    expect(await spanDesktopWindow({ width: 5120, height: 1440 })).toBe(true);
    // The app window signed out lands on /login, and is still spread.
    expect(FakeCdpSocket.instances.map((w) => w.url)).toEqual(["ws://127.0.0.1:1/devtools/page/L"]);
  });

  it("goes on to the desktop past a page that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cdpTargets = [desktopTarget("H"), desktopTarget("A")];
    FakeCdpSocket.reply = (method, params) => {
      const hung = FakeCdpSocket.instances.at(-1)!.url.endsWith("/H");
      return hung ? null : appWindowReplies({ width: 1280, height: 800, windowState: "normal" })(method, params);
    };
    let result: boolean | null = null;
    void spanDesktopWindow({ width: 5120, height: 1440 }).then((r) => { result = r; });
    await flushImmediates();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushImmediates();
    expect(result).toBe(true);
    expect(FakeCdpSocket.instances.map((w) => w.closed)).toEqual([true, true]);
    expect(FakeCdpSocket.instances[1].sent.at(-1)!.params).toEqual({ windowId: 7, bounds: { left: 0, top: 0, width: 5120, height: 1440 } });
  });

  it("answers false for a DevTools list that is not a list", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "nope" }), { status: 200 }));
    expect(await spanDesktopWindow({ width: 100, height: 100 })).toBe(false);
    expect(FakeCdpSocket.instances).toEqual([]);
  });

  it("answers false without dialling anything for an empty row, and when Chrome is not there", async () => {
    expect(await spanDesktopWindow({ width: 0, height: 1440 })).toBe(false);
    expect(cdpFetches).toEqual([]);
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    expect(await spanDesktopWindow({ width: 100, height: 100 })).toBe(false);
  });

  // A page that accepts the DevTools socket but never answers a call (one
  // behind a JS dialog — the desktop's own Forget-network confirm — or a
  // renderer busy on its main thread never answers Runtime.evaluate) used to
  // be waited on for ever: the 4 s timer only closed the socket, and nothing
  // settled the calls still waiting. Every call has a ceiling now, and a call
  // that runs past it ends the session and fails the rest.
  it("gives up on a desktop page that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cdpTargets = [desktopTarget()];
    FakeCdpSocket.reply = () => null;
    let settled = false;
    void spanDesktopWindow({ width: 100, height: 100 }).then(() => { settled = true; }, () => { settled = true; });
    await flushImmediates();
    expect(FakeCdpSocket.instances).toHaveLength(1);
    expect(FakeCdpSocket.instances[0].sent.map((s) => s.method)).toEqual(["Runtime.evaluate"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeCdpSocket.instances[0].closed).toBe(true);
    await flushImmediates();
    expect(settled).toBe(true);
  });

  // The same one level up: putOnScreen awaits spanDesktopWindow inside the
  // serialized chain. A desktop page that never answered left the new layout
  // on screen with no revert armed, and every later apply/keep/revert and
  // every reconcile tick queued behind it for ever.
  it("an Apply over a desktop page that never answers still arms the revert, and the chain moves on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cdpTargets = [desktopTarget()];
    FakeCdpSocket.reply = () => null;
    let settled = false;
    void applyMonitorLayout(DP2_1080_LEFT).then(() => { settled = true; }, () => { settled = true; });
    const until = Date.now() + 10_000;
    while (FakeCdpSocket.instances.length === 0 && Date.now() < until) await flushImmediates(1);
    expect(applyCalls()).toHaveLength(1);
    expect(FakeCdpSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const settleBy = Date.now() + 3_000;
    while (!settled && Date.now() < settleBy) await flushImmediates(1);
    expect(settled).toBe(true);
    expect((await getMonitorStatus()).pending).not.toBeNull();
    // ...and the next change is not stuck behind it.
    cdpTargets = [];
    await expect(revertMonitorLayout()).resolves.toMatchObject({ pending: null });
    expect(applyCalls().at(-1)!.args).toEqual(SAMPLE_ON_SCREEN);
  });
});

describe("/setup-api/monitors", () => {
  describe("auth", () => {
    it("GET needs a session", async () => {
      const res = await get({});
      expect(res.status).toBe(401);
      expect(reads()).toEqual([]);
    });

    it("GET answers the owner, uncached", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as MonitorStatus;
      expect(body.available).toBe(true);
      expect(body.order).toEqual([HDMI, DP2, EDP]);
      expect(body.main).toBe(HDMI);
      expect(body.box).toEqual({ width: 5120, height: 1440 });
    });

    it("GET answers the device's MCP bearer (a read)", async () => {
      const res = await get({ authorization: `Bearer ${MCP_TOKEN}` });
      expect(res.status).toBe(200);
    });

    it("GET answers another ClawBox user the monitors' geometry only, and a cookie for a user that is gone 401", async () => {
      // Signed in on the monitor-mode window, their desktop lays itself out
      // over the same row: where each monitor is, and which is the main one.
      const guest = await get({ cookie: GUEST });
      expect(guest.status).toBe(200);
      expect(guest.headers.get("cache-control")).toBe("no-store");
      const body = (await guest.json()) as MonitorStatus;
      expect(body).toMatchObject({ available: true, order: [HDMI, DP2, EDP], main: HDMI, box: { width: 5120, height: 1440 }, pending: null, mirror: false });
      const dp2 = body.monitors.find((m) => m.id === DP2)!;
      expect(dp2).toEqual({
        id: DP2, name: "DP-2", label: "AOC Q27B3MA", builtIn: false, enabled: true, modes: [], current: null,
        scale: 1, transform: "normal", rect: { x: 2560, y: 0, width: 2560, height: 1440 }, physicalSize: null, adaptiveSync: null,
      });
      expect(body.monitors.every((m) => m.modes.length === 0 && m.physicalSize === null && m.current === null)).toBe(true);

      const gone = await get({ cookie: mintCookie({ u: "nobody", sv: "0123abcd" }) });
      expect(gone.status).toBe(401);
    });

    it("GET hides a trial from another ClawBox user", async () => {
      await applyMonitorLayout(DP2_1080_LEFT);
      expect(((await (await get()).json()) as MonitorStatus).pending).not.toBeNull();
      expect(((await (await get({ cookie: GUEST })).json()) as MonitorStatus).pending).toBeNull();
    });

    it("GET on a box with no kiosk is a 200 `available: false`, not an error", async () => {
      process.env.CLAWBOX_KIOSK_ENV_FILE = path.join(work, "missing-kiosk.env");
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false });
    });

    it.each([
      ["no session", {}],
      ["the MCP bearer", { cookie: "", authorization: `Bearer ${MCP_TOKEN}` }],
      ["another ClawBox user", { cookie: GUEST }],
      ["an expired owner cookie", { cookie: mintCookie({ exp: Math.floor(Date.now() / 1000) - 10 }) }],
      ["a revoked owner cookie", { cookie: mintCookie({ gen: 7 }) }],
    ])("POST refuses %s as owner_only before reading the body", async (_label, headers) => {
      const h = { ...headers } as Record<string, string>;
      const res = await POST(new Request(OWNER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://clawbox.local", ...h },
        body: JSON.stringify(layoutBody(() => {})),
      }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "owner_only", error: expect.any(String) });
      expect(reads()).toEqual([]);
      expect(applyCalls()).toEqual([]);
    });

    it.each([
      ["another site's Origin", { origin: "http://evil.example" }],
      ["an opaque Origin", { origin: "null" }],
      ["Sec-Fetch-Site: cross-site", { origin: "", "sec-fetch-site": "cross-site" }],
    ])("POST refuses %s as cross_origin, even with the owner's cookie", async (_label, headers) => {
      const h: Record<string, string> = { "content-type": "application/json", cookie: OWNER, ...headers };
      if (h.origin === "") delete h.origin;
      const res = await POST(new Request(OWNER_URL, { method: "POST", headers: h, body: JSON.stringify(layoutBody(() => {})) }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "cross_origin" });
      expect(applyCalls()).toEqual([]);
    });
  });

  describe("request shape", () => {
    it.each([
      ["a body that is not JSON", "{ nope", "invalid_body"],
      ["a JSON null", "null", "invalid_body"],
      ["no action", { layout: {} }, "invalid_action"],
      ["an unknown action", { action: "delete" }, "invalid_action"],
      ["an action that is not a string", { action: ["apply"] }, "invalid_action"],
    ])("refuses %s with a stable code", async (_label, body, code) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code, error: expect.any(String) });
      expect(applyCalls()).toEqual([]);
    });

    it.each([
      ["no layout", { action: "apply" }, "invalid"],
      ["a layout without an order", { action: "apply", layout: { monitors: {} } }, "invalid"],
      ["an order naming a monitor that is not connected", layoutBody((l) => { l.order.push("Acme|X|1"); }), "unknown_monitor"],
      ["an order entry that is not a string", layoutBody((l) => { (l.order as unknown[]).push(42); }), "invalid"],
      ["settings for a monitor that is not connected", layoutBody((l) => { l.monitors["Acme|X|1"] = { ...l.monitors[HDMI] }; }), "unknown_monitor"],
      ["a mode the monitor does not offer", layoutBody((l) => { l.monitors[HDMI].width = 3840; l.monitors[HDMI].height = 2160; }), "unknown_mode"],
      ["a refresh it does not offer", layoutBody((l) => { l.monitors[HDMI].refresh = 144; }), "unknown_mode"],
      ["a scale out of range", layoutBody((l) => { l.monitors[HDMI].scale = 5; }), "invalid_scale"],
      ["a transform wlr-randr does not know", layoutBody((l) => { l.monitors[HDMI].transform = "sideways"; }), "invalid_transform"],
      ["an enabled flag that is not a boolean", layoutBody((l) => { l.monitors[HDMI].enabled = "yes"; }), "invalid"],
      ["adaptive sync that is not a boolean", layoutBody((l) => { l.monitors[HDMI].adaptiveSync = "on"; }), "invalid"],
      ["mirror that is not a boolean", layoutBody((l) => { (l as Record<string, unknown>).mirror = "yes"; }), "invalid"],
      ["every monitor off", layoutBody((l) => { l.monitors[HDMI].enabled = false; l.monitors[DP2].enabled = false; }), "none_enabled"],
      ["a main monitor that is off", layoutBody((l) => { l.main = EDP; }), "main_disabled"],
      ["a main monitor that is not connected", layoutBody((l) => { l.main = "Acme|X|1"; }), "unknown_monitor"],
    ])("refuses %s before anything reaches wlr-randr", async (_label, body, code) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code });
      expect(applyCalls()).toEqual([]);
      expect(fs.existsSync(MONITORS_FILE)).toBe(false);
    });

    it("never passes a value from the request through to the command line", async () => {
      const hostile = layoutBody((l) => {
        l.monitors[HDMI].refresh = "59.951; reboot";
        l.monitors[HDMI].transform = "normal --output eDP-1 --on";
      });
      const res = await post(hostile);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");

      const injectedId = layoutBody((l) => { l.order = ["$(touch /tmp/pwned)"]; });
      expect((await post(injectedId)).status).toBe(400);

      // A scale is rounded to what the protocol carries (1/256), and the mode
      // comes from the compositor's own list.
      const ok = await post(layoutBody((l) => {
        l.monitors[HDMI] = { enabled: true, width: "1920", height: "1080", refresh: 60.004, scale: 1.2345678, transform: "normal" };
      }));
      expect(ok.status).toBe(200);
      const args = applyCalls()[0].args;
      const hdmiAt = args.indexOf("HDMI-A-1");
      expect(args.slice(hdmiAt, hdmiAt + 11)).toEqual([
        "HDMI-A-1", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1.234375", "--output",
      ]);
    });
  });

  describe("actions", () => {
    it("apply → 200 on trial; keep → 200 saved; keep again → 409 nothing_pending", async () => {
      const applied = await post({ action: "apply", layout: DP2_1080_LEFT });
      expect(applied.status).toBe(200);
      expect(applied.headers.get("cache-control")).toBe("no-store");
      const a = (await applied.json()) as MonitorStatus;
      expect(a.pending?.deadline).toEqual(expect.any(Number));
      expect(a.main).toBe(DP2);
      expect(applyCalls()[0].args).toEqual(DP2_1080_LEFT_ARGS);

      const kept = await post({ action: "keep" });
      expect(kept.status).toBe(200);
      expect(((await kept.json()) as MonitorStatus).pending).toBeNull();
      expect(readSavedFile().layout?.main).toBe(DP2);

      const again = await post({ action: "keep" });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "nothing_pending" });
    });

    it("apply → revert → 200, the previous layout back on screen", async () => {
      expect((await post({ action: "apply", layout: DP2_1080_LEFT })).status).toBe(200);
      const reverted = await post({ action: "revert" });
      expect(reverted.status).toBe(200);
      expect(((await reverted.json()) as MonitorStatus).pending).toBeNull();
      expect(applyCalls()[1].args).toEqual(SAMPLE_ON_SCREEN);
      const again = await post({ action: "revert" });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "nothing_pending" });
    });

    it("apply on a box with no monitor session → 503 unavailable", async () => {
      process.env.CLAWBOX_KIOSK_ENV_FILE = path.join(work, "missing-kiosk.env");
      const res = await post({ action: "apply", layout: DP2_1080_LEFT });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "unavailable" });
    });

    it("keep that cannot be saved → 500 save_failed, without the disk's own words, and still on trial", async () => {
      if (process.getuid?.() === 0) return;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await post({ action: "apply", layout: DP2_1080_LEFT })).status).toBe(200);
      fs.chmodSync(DATA, 0o500);
      let res: Response;
      try {
        res = await post({ action: "keep" });
      } finally {
        fs.chmodSync(DATA, 0o700);
      }
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("save_failed");
      expect(body.error).not.toContain(DATA);
      expect(((await (await get()).json()) as MonitorStatus).pending).not.toBeNull();
    });

    it("revert the compositor refuses → 502 revert_failed, still on trial", async () => {
      expect((await post({ action: "apply", layout: DP2_1080_LEFT })).status).toBe(200);
      marker("fail-apply");
      const res = await post({ action: "revert" });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: "revert_failed" });
      expect(((await (await get()).json()) as MonitorStatus).pending).not.toBeNull();
    });

    it("apply the compositor refuses → 502 apply_failed with its reason, and no trial", async () => {
      marker("fail-apply");
      const res = await post({ action: "apply", layout: DP2_1080_LEFT });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe("apply_failed");
      expect(body.error).toContain("failed to apply output configuration");
      const status = await (await get()).json();
      expect(status.pending).toBeNull();
    });
  });
});
