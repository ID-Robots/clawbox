/**
 * The shared browser's clean start (scripts/lib/browser-clean-start.sh) — the
 * one rule every launcher of it follows — and scripts/launch-browser.sh, the
 * launcher the keeper and "Open" start, following it.
 *
 * The window on the remote desktop used to collect tabs: Chromium restored the
 * last session on every start (and offered to after a crash), and every start
 * added the start page on top of it. So:
 *
 *  1. Before a start, the profile's preferences say "new tab page, no start
 *     URLs, clean exit" — those four keys and nothing else, written whole and
 *     atomically, and never while a browser is running on the profile.
 *  2. Every start carries --hide-crash-restore-bubble.
 *  3. A browser that is already running is reused: its page comes to the
 *     front, and a page opens only when one was asked for (in place of a blank
 *     tab when there is one) or when it has no page at all.
 *
 * Everything runs on stand-ins in a temp dir: profiles, a DevTools server that
 * records what it was asked, and a "Chromium" that writes down its arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { focusRunningBrowser } from "@/lib/browser-clean-start";

// Runs bash and python3: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const HELPER = path.join(ROOT, "scripts/lib/browser-clean-start.sh");
const LAUNCHER = path.join(ROOT, "scripts/launch-browser.sh");
const usable =
  process.platform === "linux" &&
  fs.existsSync("/proc/self/cmdline") &&
  spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let tmp = "";
const children: ChildProcess[] = [];

/** Run bash without blocking the event loop (the fake DevTools server answers on it). */
function sh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("bash", args, { env, timeout: 25_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(tmp, "home"), LANG: "C.UTF-8", ...extra }) as unknown as NodeJS.ProcessEnv;

/** A process that stands in for a browser running on `profile`: the argument is its own. */
function browserOn(profile: string): ChildProcess {
  const child = spawn("bash", ["-c", "sleep 60; exit 0", "fake-chromium", `--user-data-dir=${profile}`], { stdio: "ignore", detached: true });
  children.push(child);
  return child;
}

/** A pid that was a process a moment ago and is not one now: a browser killed hard. */
async function deadPid(): Promise<number> {
  const child = spawn("true", [], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  return child.pid!;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

// ── 1. The preferences ──────────────────────────────────────────────────────

/** What Chromium leaves behind when it crashed while set to restore its last session. */
const CRASHED = {
  profile: { exit_type: "Crashed", exited_cleanly: false, name: "Person 1", avatar_index: 26 },
  session: { restore_on_startup: 1, startup_urls: ["https://example.com/a", "https://example.com/b"], other: true },
  browser: { window_placement: { bottom: 1040, left: 10, maximized: true, right: 1910, top: 10 } },
  partition: { per_host_zoom_levels: { x: { localhost: { last_modified: "13370000000000000", zoom_level: 1.2239010857415449 } } } },
  intl: { accept_languages: "bg,en-US,en", selected_languages: "Ünïcödé ✓ — 日本語" },
  extensions: { settings: {} },
};

describe.skipIf(!usable)("reset-prefs: the profile starts clean", () => {
  let profile = "";
  let prefs = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-clean-start-"));
    profile = path.join(tmp, "profile");
    prefs = path.join(profile, "Default", "Preferences");
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    fs.mkdirSync(path.join(tmp, "home"));
  });
  const write = (value: unknown) => fs.writeFileSync(prefs, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const reset = () => sh([HELPER, "reset-prefs", profile], baseEnv());

  it("turns a crashed exit into a clean one and stops the last session coming back", async () => {
    write(CRASHED);
    const r = await reset();
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const after = JSON.parse(fs.readFileSync(prefs, "utf-8"));
    expect(after.profile.exit_type).toBe("Normal");
    expect(after.profile.exited_cleanly).toBe(true);
    expect(after.session.restore_on_startup).toBe(5);
    expect(after.session.startup_urls).toEqual([]);
    expect(r.stdout).toContain("set session.restore_on_startup, session.startup_urls, profile.exit_type, profile.exited_cleanly");
  });

  it("changes those four keys and nothing else", async () => {
    write(CRASHED);
    expect((await reset()).code).toBe(0);
    const after = JSON.parse(fs.readFileSync(prefs, "utf-8"));
    const expected = structuredClone(CRASHED) as Record<string, Record<string, unknown>>;
    Object.assign(expected.profile, { exit_type: "Normal", exited_cleanly: true });
    Object.assign(expected.session, { restore_on_startup: 5, startup_urls: [] });
    // Every unrelated key — the window, the zoom, the non-ASCII text, the
    // session key it does not own — reads back exactly as it was.
    expect(after).toEqual(expected);
    // Written the way Chromium writes it: compact, UTF-8, the owner's mode kept.
    const text = fs.readFileSync(prefs, "utf-8");
    expect(text).not.toMatch(/\n|": /);
    expect(text).toContain("Ünïcödé ✓ — 日本語");
    expect(fs.statSync(prefs).mode & 0o777).toBe(0o600);
    // No temp file left beside it.
    expect(fs.readdirSync(path.dirname(prefs))).toEqual(["Preferences"]);
  });

  it("never touches the profile's sign-ins and cookies", async () => {
    write(CRASHED);
    const others = { Cookies: Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0, 1, 2]), "Login Data": Buffer.from("login"), "Secure Preferences": Buffer.from('{"protection":{}}') };
    for (const [name, bytes] of Object.entries(others)) fs.writeFileSync(path.join(profile, "Default", name), bytes);
    const before = Object.fromEntries(Object.keys(others).map((n) => [n, fs.statSync(path.join(profile, "Default", n)).mtimeMs]));
    expect((await reset()).code).toBe(0);
    for (const [name, bytes] of Object.entries(others)) {
      expect(fs.readFileSync(path.join(profile, "Default", name)), name).toEqual(bytes);
      expect(fs.statSync(path.join(profile, "Default", name)).mtimeMs, name).toBe(before[name]);
    }
  });

  it("adds the keys a profile does not have yet", async () => {
    write({ browser: { has_seen_welcome_page: true } });
    expect((await reset()).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(prefs, "utf-8"))).toEqual({
      browser: { has_seen_welcome_page: true },
      session: { restore_on_startup: 5, startup_urls: [] },
      profile: { exit_type: "Normal", exited_cleanly: true },
    });
  });

  it("does not rewrite a file that already starts clean", async () => {
    write({ profile: { exit_type: "Normal", exited_cleanly: true }, session: { restore_on_startup: 5, startup_urls: [] } });
    const before = fs.statSync(prefs);
    const r = await reset();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already starts clean");
    const after = fs.statSync(prefs);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("reads 1 as 1, not as true: a restore setting of the wrong type is still corrected", async () => {
    write({ profile: { exit_type: "Normal", exited_cleanly: 1 }, session: { restore_on_startup: 5.0, startup_urls: [] } });
    expect((await reset()).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(prefs, "utf-8")).profile.exited_cleanly).toBe(true);
  });

  it("leaves the preferences of a running browser alone — it would write its own copy back over them", async () => {
    write(CRASHED);
    const bytes = fs.readFileSync(prefs);
    browserOn(profile);
    // The process is there before the script looks.
    await new Promise((r) => setTimeout(r, 100));
    const r = await reset();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("a browser is running on");
    expect(fs.readFileSync(prefs)).toEqual(bytes);
  });

  it("leaves them alone while the browser that holds the profile's lock is alive", async () => {
    write(CRASHED);
    const bytes = fs.readFileSync(prefs);
    const browser = browserOn(path.join(profile, "/"));
    fs.symlinkSync(`${os.hostname()}-${browser.pid}`, path.join(profile, "SingletonLock"));
    await new Promise((r) => setTimeout(r, 100));
    expect((await reset()).code).toBe(1);
    expect(fs.readFileSync(prefs)).toEqual(bytes);
  });

  it("starts clean after the browser was killed hard: a lock naming a dead process holds nothing", async () => {
    write(CRASHED);
    fs.symlinkSync(`${os.hostname()}-${await deadPid()}`, path.join(profile, "SingletonLock"));
    expect((await reset()).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(prefs, "utf-8")).profile.exit_type).toBe("Normal");
  });

  it("is not fooled by a lock whose pid now belongs to something else (after a reboot)", async () => {
    write(CRASHED);
    // This test's own process: alive, but no browser and not on the profile.
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profile, "SingletonLock"));
    expect((await reset()).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(prefs, "utf-8")).session.restore_on_startup).toBe(5);
  });

  it("leaves a file it cannot read as JSON exactly as it is", async () => {
    for (const body of ['{"profile":{"exit_type":"Crashed"', "[1,2]", '{"profile":"x"}', '{"profile":{"exit_type":NaN}}']) {
      write(body);
      const r = await reset();
      expect(r.code, body).toBe(2);
      expect(r.stdout, body).toContain("left as it is");
      expect(fs.readFileSync(prefs, "utf-8"), body).toBe(body);
    }
  });

  it("creates nothing for a fresh profile, which has no session to restore", async () => {
    const r = await reset();
    expect(r.code).toBe(0);
    expect(fs.existsSync(prefs)).toBe(false);
  });

  it("does not follow a symlinked Preferences file", async () => {
    const elsewhere = path.join(tmp, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify(CRASHED));
    fs.symlinkSync(elsewhere, prefs);
    expect((await reset()).code).toBe(2);
    expect(fs.lstatSync(prefs).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(elsewhere, "utf-8"))).toEqual(CRASHED);
  });

  it("in-use answers what reset-prefs decides on", async () => {
    expect((await sh([HELPER, "in-use", profile], baseEnv())).code).toBe(1);
    browserOn(profile);
    await new Promise((r) => setTimeout(r, 100));
    expect((await sh([HELPER, "in-use", profile], baseEnv())).code).toBe(0);
    expect((await sh([HELPER, "in-use"], baseEnv())).code).toBe(64);
  });
});

// ── 2. A browser that is already running ────────────────────────────────────

interface FakeDevtools {
  port: number;
  calls: string[];
  close: () => Promise<void>;
}

/** A DevTools HTTP endpoint with these targets, recording every request. */
function fakeDevtools(targets: unknown[], opts: { failActivate?: boolean; newTabWithoutId?: boolean } = {}): Promise<FakeDevtools> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/list" || req.url === "/json/version") {
      res.end(JSON.stringify(req.url === "/json/list" ? targets : { Browser: "Chrome/140.0.0.0" }));
    } else if (req.url?.startsWith("/json/new?") && req.method === "PUT") {
      const url = decodeURIComponent(req.url.slice("/json/new?".length));
      res.end(JSON.stringify(opts.newTabWithoutId ? { type: "page", url } : { id: "NEW1", type: "page", url }));
    } else if (req.url?.startsWith("/json/activate/") && !opts.failActivate) {
      res.end('"Target activated"');
    } else if (req.url?.startsWith("/json/close/")) {
      res.end('"Target is closing"');
    } else {
      res.statusCode = req.url?.startsWith("/json/new?") ? 405 : 500;
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as { port: number }).port,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A port nothing answers on. */
async function closedPort(): Promise<number> {
  const devtools = await fakeDevtools([]);
  await devtools.close();
  return devtools.port;
}

const page = (id: string, url: string) => ({ id, type: "page", url, title: url, webSocketDebuggerUrl: `ws://x/${id}` });
const OWNER_TABS = [
  page("AAAA", "https://mail.example.com/"),
  page("BBBB", "about:blank"),
  { id: "CCCC", type: "service_worker", url: "https://example.com/sw.js" },
];

describe.skipIf(!usable)("reuse: a running browser gets no second start and no blank tab", () => {
  let devtools: FakeDevtools | null = null;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-clean-start-"));
    fs.mkdirSync(path.join(tmp, "home"));
  });
  afterEach(async () => {
    await devtools?.close();
    devtools = null;
  });
  const reuse = (...args: string[]) => sh([HELPER, "reuse", String(devtools!.port), ...args], baseEnv());

  it("only brings the most recent page to the front when no URL is asked for", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    const r = await reuse("", "https://start.example.org/");
    expect(r.code).toBe(0);
    expect(devtools.calls).toEqual(["GET /json/list", "GET /json/activate/AAAA"]);
  });

  it("opens a URL that was asked for in place of the blank tab, not beside it", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    const r = await reuse("https://news.example.org/?a=1&b=2");
    expect(r.code, r.stdout).toBe(0);
    expect(devtools.calls).toEqual([
      "GET /json/list",
      `PUT /json/new?${encodeURIComponent("https://news.example.org/?a=1&b=2")}`,
      "GET /json/close/BBBB",
      "GET /json/activate/NEW1",
    ]);
    expect(r.stdout).toContain("in place of a blank tab");
  });

  it("opens it in a new tab of the running browser when every tab shows something", async () => {
    devtools = await fakeDevtools([page("AAAA", "https://mail.example.com/")]);
    expect((await reuse("https://news.example.org/")).code).toBe(0);
    expect(devtools.calls).toEqual(["GET /json/list", `PUT /json/new?${encodeURIComponent("https://news.example.org/")}`, "GET /json/activate/NEW1"]);
  });

  it("brings forward a tab already showing the URL instead of opening it twice", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    expect((await reuse("https://mail.example.com/")).code).toBe(0);
    expect(devtools.calls).toEqual(["GET /json/list", "GET /json/activate/AAAA"]);
  });

  it("gives a browser with no page the start page, so there is a window to look at", async () => {
    devtools = await fakeDevtools([]);
    expect((await reuse("", "https://start.example.org/")).code).toBe(0);
    expect(devtools.calls).toEqual(["GET /json/list", `PUT /json/new?${encodeURIComponent("https://start.example.org/")}`]);
  });

  it("falls back to a blank page for a start page that is not an address", async () => {
    devtools = await fakeDevtools([]);
    expect((await reuse("", "javascript:alert(1)")).code).toBe(0);
    expect(devtools.calls).toEqual(["GET /json/list", "PUT /json/new?about%3Ablank"]);
  });

  it("refuses a URL that is not an http(s) address, and opens nothing", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    for (const url of ["file:///etc/passwd", "--disable-web-security", "https://a b"]) {
      const r = await reuse(url);
      expect(r.code, url).toBe(2);
    }
    expect(devtools.calls.every((c) => c === "GET /json/list")).toBe(true);
  });

  it("never puts a target id it does not trust into a path", async () => {
    devtools = await fakeDevtools([page("../../json/close/X", "about:blank")]);
    expect((await reuse("")).code).toBe(0);
    expect(devtools.calls.some((c) => c.includes(".."))).toBe(false);
  });

  it("says 1 when nothing answers, so the launcher starts a browser", async () => {
    const r = await sh([HELPER, "reuse", String(await closedPort())], baseEnv());
    expect(r.code).toBe(1);
  });

  it("says 2 when the browser answers but does not take the request", async () => {
    devtools = await fakeDevtools(OWNER_TABS, { failActivate: true });
    expect((await reuse("")).code).toBe(2);
  });

  it("keeps the blank tab when the new one cannot be confirmed — it may be the window's only tab", async () => {
    devtools = await fakeDevtools(OWNER_TABS, { newTabWithoutId: true });
    const r = await reuse("https://news.example.org/");
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("in place of a blank tab");
    expect(devtools.calls).toEqual(["GET /json/list", `PUT /json/new?${encodeURIComponent("https://news.example.org/")}`]);
  });

  it("does not claim a page for a browser with none when the new one cannot be confirmed", async () => {
    devtools = await fakeDevtools([], { newTabWithoutId: true });
    const r = await reuse("", "https://start.example.org/");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("did not confirm");
  });

  it("is what the Open route asks, through src/lib/browser-clean-start.ts", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    expect(await focusRunningBrowser(devtools.port, "https://start.example.org/", { script: HELPER })).toBe("focused");
    // Open is a request for the browser, not for a page: no second start page.
    expect(devtools.calls).toEqual(["GET /json/list", "GET /json/activate/AAAA"]);
    expect(await focusRunningBrowser(await closedPort(), "about:blank", { script: HELPER })).toBe("unreachable");
    await devtools.close();
    devtools = await fakeDevtools(OWNER_TABS, { failActivate: true });
    expect(await focusRunningBrowser(devtools.port, "about:blank", { script: HELPER })).toBe("failed");
  });
});

// ── 3. scripts/launch-browser.sh following the rule ─────────────────────────

describe.skipIf(!usable)("scripts/launch-browser.sh starts clean", () => {
  let home = "";
  let profile = "";
  let argvFile = "";
  let chrome = "";
  let devtools: FakeDevtools | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-clean-start-"));
    home = path.join(tmp, "home");
    // ClawBox's own profile, where the unit starts it.
    profile = path.join(home, ".config", "clawbox-browser");
    fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
    argvFile = path.join(tmp, "chromium-argv");
    chrome = path.join(tmp, "chromium");
    // Writes down how it was started, one argument a line, and exits.
    fs.writeFileSync(chrome, `#!/bin/sh\n[ "$1" = --version ] && { echo "Chromium 140.0.7339.0"; exit 0; }\nprintf '%s\\n' "$@" > '${argvFile}'\n`, { mode: 0o755 });
    // A display that is ready, and short waits.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "xset"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  });
  afterEach(async () => {
    await devtools?.close();
    devtools = null;
  });

  const launch = async (port: number, ...args: string[]) =>
    sh([LAUNCHER, ...args], {
      ...baseEnv({ CLAWBOX_BROWSER_EXECUTABLE: chrome, CLAWBOX_BROWSER_CDP_PORT: String(port), CLAWBOX_VNC_DISPLAY: ":99" }),
      PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
  const argv = () => (fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf-8").split("\n").filter(Boolean) : null);
  const writePrefs = () => fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify(CRASHED));
  const readPrefs = () => JSON.parse(fs.readFileSync(path.join(profile, "Default", "Preferences"), "utf-8"));

  it("after a hard kill: resets the crashed profile, hides the restore bubble, and opens exactly one page", async () => {
    writePrefs();
    // The killed browser's lock is still there.
    fs.symlinkSync(`${os.hostname()}-${await deadPid()}`, path.join(profile, "SingletonLock"));
    const r = await launch(await closedPort());
    expect(r.code, r.stderr).toBe(0);
    const args = argv()!;
    expect(args).toContain("--hide-crash-restore-bubble");
    expect(args).toContain(`--user-data-dir=${profile}`);
    // One page: the start page, and no restored session to join it.
    expect(args.filter((a) => !a.startsWith("--"))).toEqual(["about:blank"]);
    expect(readPrefs().profile).toMatchObject({ exit_type: "Normal", exited_cleanly: true });
    expect(readPrefs().session).toMatchObject({ restore_on_startup: 5, startup_urls: [] });
    expect(readPrefs().browser).toEqual(CRASHED.browser);
    expect(r.stdout).toContain("Session: ");
  });

  it("opens the URL asked for as the first page instead of the start page", async () => {
    const r = await launch(await closedPort(), "https://example.com/x?y=1");
    expect(r.code, r.stderr).toBe(0);
    expect(argv()!.filter((a) => !a.startsWith("--"))).toEqual(["https://example.com/x?y=1"]);
  });

  it("never hands Chromium an argument that is not an address", async () => {
    const r = await launch(await closedPort(), "--disable-web-security");
    expect(r.code, r.stderr).toBe(0);
    expect(argv()).not.toContain("--disable-web-security");
    expect(argv()!.filter((a) => !a.startsWith("--"))).toEqual(["about:blank"]);
    expect(r.stderr).toContain("Not an http(s) address, so not opened");
  });

  it("started again while running: no second browser and no blank tab — its page comes to the front", async () => {
    writePrefs();
    devtools = await fakeDevtools(OWNER_TABS);
    const r = await launch(devtools.port);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Browser already running on CDP port");
    expect(argv()).toBeNull();
    expect(devtools.calls).toEqual(["GET /json/list", "GET /json/activate/AAAA"]);
    // A running browser's preferences are its own.
    expect(readPrefs()).toEqual(CRASHED);
  });

  it("asked for a URL while running: opens it in the running browser, in place of its blank tab", async () => {
    devtools = await fakeDevtools(OWNER_TABS);
    const r = await launch(devtools.port, "https://example.com/");
    expect(r.code, r.stderr).toBe(0);
    expect(argv()).toBeNull();
    expect(devtools.calls).toEqual([
      "GET /json/list",
      `PUT /json/new?${encodeURIComponent("https://example.com/")}`,
      "GET /json/close/BBBB",
      "GET /json/activate/NEW1",
    ]);
  });

  it("does not join a browser on its profile that never answers on the port", async () => {
    writePrefs();
    browserOn(profile);
    await new Promise((r) => setTimeout(r, 100));
    const r = await launch(await closedPort());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not starting a second browser on it");
    expect(argv()).toBeNull();
    expect(readPrefs()).toEqual(CRASHED);
  });

  it("starts the browser once the one holding its profile goes away while it waits", async () => {
    // Real waits here: the holder has to outlive the first look and not the last.
    const realSleep = spawnSync("bash", ["-c", "type -P sleep"], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh\nexec ${realSleep} 0.1\n`, { mode: 0o755 });
    writePrefs();
    const holder = spawn("bash", ["-c", "sleep 0.5; exit 0", "fake-chromium", `--user-data-dir=${profile}`], { stdio: "ignore", detached: true });
    children.push(holder);
    await new Promise((r) => setTimeout(r, 100));
    const r = await launch(await closedPort());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("not starting a second browser on it");
    expect(argv()).toContain("--hide-crash-restore-bubble");
    expect(readPrefs().session.restore_on_startup).toBe(5);
  });
});
