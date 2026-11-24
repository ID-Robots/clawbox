/**
 * Monitor mode's Chrome LAUNCHER (scripts/x64-migration/kiosk/
 * clawbox-desktop-browser) as it runs inside a session: the crash loop, the
 * desktop-window watchdog, and the compositor it belongs to.
 *
 *  1. It belongs to ONE labwc. labwc runs it in a session of its own and does
 *     not stop it when it exits, while the next session's labwc takes the same
 *     socket name — so a launcher that went on starting Chrome put it on the
 *     NEXT session's screen, holding the profile, and the next launcher counted
 *     its own hand-offs as five quick crashes and ended its own new session
 *     (twice on the test machine). It now leaves as soon as its labwc is gone,
 *     and never sends `labwc --exit` to a compositor that is not its own.
 *  2. A Chrome it did not start that holds the profile is not a crash: one
 *     from an earlier session is ended, one from this session is watched.
 *  3. The watchdog does not ask for a second desktop window while the first
 *     is still coming up; it does once a window that was up is gone.
 *  4. A labwc template it cannot read is never a reason to reconfigure.
 *  5. Every Chrome it starts gets ONE --disable-features list (Chrome reads
 *     only the last), and that list keeps a hidden desktop's timers off
 *     Chrome's once-a-minute wake-up for pages hidden five minutes.
 *  6. Every Chrome it starts starts clean (scripts/lib/browser-clean-start.sh):
 *     a crashed profile's preferences say "new tab page" and a clean exit, and
 *     no "Restore pages?" bubble — but never while another Chrome holds them.
 *
 * Everything runs on stand-ins in a temp dir: a `sleep` as the compositor
 * (LABWC_PID), a bash Chrome that takes the profile's SingletonLock or hands
 * off to its live owner the way the real one does, and `labwc`, `wlrctl`,
 * `curl` and `sleep` on PATH that record or speed things up. The launcher is
 * a COPY whose one `source` line names the test's own kiosk.env (as in
 * desktop-session-scripts.test.ts). Nothing here starts Chrome, labwc, or
 * touches /etc, /usr/local or the live session's runtime dir.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every case runs the launcher as a real bash process (test-timeout-hygiene).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const BROWSER = path.join(ROOT, "scripts/x64-migration/kiosk/clawbox-desktop-browser");
const TEMPLATE = path.join(ROOT, "kiosk/labwc/rc.xml.in");
const CLEAN_START = path.join(ROOT, "scripts/lib/browser-clean-start.sh");
const SOURCE_LINE = ". /etc/clawbox/kiosk.env";
const URL = "http://localhost:3005/";

/** The program on PATH, never a shell builtin of the same name (`true` is one). */
const which = (cmd: string): string =>
  spawnSync("bash", ["-c", `type -P ${cmd}`], { encoding: "utf-8" }).stdout?.trim() ?? "";
const REAL_SLEEP = which("sleep");
const TRUE = which("true");
const usable =
  process.platform === "linux" &&
  fs.existsSync("/proc/self/stat") &&
  spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0 &&
  REAL_SLEEP.startsWith("/") &&
  TRUE.startsWith("/");

/** A stand-in Chrome: the real one's profile lock, and a scripted life. */
const FAKE_CHROME = `#!/usr/bin/env bash
# Like the real Chrome it hands its request to a live owner of the profile and
# exits 0; otherwise it takes the profile and does what $FAKE_MODE, or the next
# line of $FAKE/modes, says. None left: its compositor goes, and so does it.
echo "$$ $*" >> "$FAKE/chrome.txt"
for a; do case "$a" in --user-data-dir=*) prof="\${a#*=}" ;; esac; done
t="$(readlink "$prof/SingletonLock" 2>/dev/null)"; p="\${t##*-}"
if [ -n "$p" ] && [ "$p" != "$$" ] && kill -0 "$p" 2>/dev/null; then
  echo "Opening in existing browser session."
  exit 0
fi
ln -sfn "$HOSTNAME-$$" "$prof/SingletonLock"
mode="\${FAKE_MODE:-}"
if [ -z "$mode" ]; then
  mode="$(head -n1 "$FAKE/modes" 2>/dev/null)"
  sed -i '1d' "$FAKE/modes" 2>/dev/null
fi
case "$mode" in
  crash) exit 1 ;;
  hold) while :; do "$FAKE_SLEEP" 0.05; done ;;
  *) kill "$LABWC_PID" 2>/dev/null; exit 1 ;;
esac
`;

let tmp = "";
let fake = "";
let profile = "";
let conf = "";
let log = "";
let launcherCopy = "";
let chromePath = "";
const children: ChildProcess[] = [];

function writeExec(file: string, text: string) {
  fs.writeFileSync(file, text, { mode: 0o755 });
}

/** A long-lived process standing in for labwc, or for a Chrome that holds the profile. */
function spawnTracked(cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, args, { env, stdio: "ignore", detached: true });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));

/** The start time (clock ticks since boot) of a process, as the launcher reads it. */
function procStart(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
  return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]);
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, pred: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n--- log ---\n${readText(log)}`);
    await sleepMs(25);
  }
}

const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "");
const lines = (file: string) => readText(file).split("\n").filter(Boolean);
const chromeLaunches = () => lines(path.join(fake, "chrome.txt"));
const labwcCalls = () => lines(path.join(fake, "labwc.txt"));
const wlrctlCalls = () => lines(path.join(fake, "wlrctl.txt")).length;
const setWindow = (state: "up" | "down") => fs.writeFileSync(path.join(fake, "window"), state);
const setModes = (modes: string[]) => fs.writeFileSync(path.join(fake, "modes"), modes.map((m) => `${m}\n`).join(""));

function env(compositorPid: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: path.join(tmp, "home"),
    XDG_RUNTIME_DIR: path.join(tmp, "run"),
    LANG: "C.UTF-8",
    LABWC_PID: String(compositorPid),
    FAKE: fake,
    FAKE_SLEEP: REAL_SLEEP,
    CLAWBOX_KIOSK_CHROME: chromePath,
    CLAWBOX_KIOSK_NODE: TRUE,
    CLAWBOX_KIOSK_PROFILE: profile,
    CLAWBOX_KIOSK_LOG: log,
    CLAWBOX_LABWC_CONF: conf,
    CLAWBOX_LABWC_TEMPLATE: TEMPLATE,
    CLAWBOX_DESKTOP_LOCAL: path.join(tmp, "local"),
    CLAWBOX_DESKTOP_SHELF_PX: "56",
    // The installed copy lives in /usr/local/lib/clawbox; the tree's is the same file.
    CLAWBOX_BROWSER_CLEAN_START: CLEAN_START,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

/** The launcher, as labwc's `-s` would start it. Resolves with its exit code. */
function startLauncher(e: NodeJS.ProcessEnv): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawnTracked("bash", [launcherCopy], e);
  const done = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, done };
}

async function finished(done: Promise<number | null>, ms = 20_000): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the launcher did not exit\n--- log ---\n${readText(log)}`)), ms);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Preferences as Chrome leaves them after a crash, restoring its last session. */
const CRASHED_PREFS = {
  profile: { exit_type: "Crashed", exited_cleanly: false, name: "Person 1" },
  session: { restore_on_startup: 1, startup_urls: ["https://example.com/"] },
  partition: { per_host_zoom_levels: { x: { localhost: { zoom_level: 1.5 } } } },
};
const prefsFile = () => path.join(profile, "Default", "Preferences");
function writeCrashedPrefs() {
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify(CRASHED_PREFS));
}
const readPrefs = () => JSON.parse(fs.readFileSync(prefsFile(), "utf-8"));

/** A stand-in compositor, alive until killed. */
const compositor = () => spawnTracked(REAL_SLEEP, ["600"]);

/** A Chrome of the kiosk profile this launcher did not start, holding it. */
async function profileHolder(): Promise<ChildProcess> {
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  const holder = spawnTracked("bash", [chromePath, `--user-data-dir=${profile}`, `--app=${URL}`], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    FAKE: elsewhere,
    FAKE_MODE: "hold",
    FAKE_SLEEP: REAL_SLEEP,
  } as unknown as NodeJS.ProcessEnv);
  await waitFor("the holder to take the profile", () => {
    try {
      return fs.readlinkSync(path.join(profile, "SingletonLock")).endsWith(`-${holder.pid}`);
    } catch {
      return false;
    }
  });
  return holder;
}

// Each run takes well under a second; the budget covers a loaded CI machine.
describe.skipIf(!usable)("clawbox-desktop-browser in a session", { timeout: 30_000 }, () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-desktop-launcher-"));
    fake = path.join(tmp, "fake");
    profile = path.join(tmp, "profile");
    conf = path.join(tmp, "conf");
    log = path.join(tmp, "kiosk.log");
    const bin = path.join(tmp, "bin");
    for (const d of [fake, profile, bin, path.join(tmp, "home"), path.join(tmp, "run")]) fs.mkdirSync(d, { recursive: true });

    const kioskEnv = path.join(tmp, "kiosk.env");
    fs.writeFileSync(kioskEnv, `CLAWBOX_KIOSK_URL=${URL}\n`);
    const text = fs.readFileSync(BROWSER, "utf-8").split("\n");
    expect(text.filter((l) => l === SOURCE_LINE)).toHaveLength(1);
    launcherCopy = path.join(tmp, "clawbox-desktop-browser");
    writeExec(launcherCopy, text.map((l) => (l === SOURCE_LINE ? `. "${kioskEnv}"` : l)).join("\n"));
    chromePath = path.join(tmp, "chrome");
    writeExec(chromePath, FAKE_CHROME);

    // Every wait the launcher makes is 50 ms here; the web server answers at once.
    writeExec(path.join(bin, "sleep"), `#!/bin/sh\nexec ${REAL_SLEEP} 0.05\n`);
    writeExec(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n");
    writeExec(path.join(bin, "labwc"), '#!/bin/sh\necho "$*" >> "$FAKE/labwc.txt"\n');
    writeExec(
      path.join(bin, "wlrctl"),
      '#!/bin/sh\necho x >> "$FAKE/wlrctl.txt"\n[ "$(cat "$FAKE/window" 2>/dev/null)" = up ]\n',
    );
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.pid === undefined) continue;
      try {
        // Its whole group: the launcher's Chrome and watchdog went with it.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("leaves when its labwc is gone: no Chrome on the next session's screen, no --exit sent to it", async () => {
    const labwc = compositor();
    // Chrome's compositor goes away under it (default mode), as it does when the session ends.
    const { done } = startLauncher(env(labwc.pid!));
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(1);
    expect(labwcCalls().filter((c) => c.includes("--exit"))).toEqual([]);
    expect(readText(log)).toContain(`labwc (${labwc.pid}) is gone; this session is over`);
    expect(readText(log)).not.toContain("five quick exits");
  });

  it("starts nothing when its labwc is gone before the web server answered", async () => {
    const labwc = compositor();
    labwc.kill("SIGKILL");
    await exited(labwc);
    const { done } = startLauncher(env(labwc.pid!));
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toEqual([]);
    expect(labwcCalls()).toEqual([]);
  });

  it("still ends its own session after five quick crashes under a live labwc", async () => {
    const labwc = compositor();
    setModes(["crash", "crash", "crash", "crash", "crash"]);
    const { done } = startLauncher(env(labwc.pid!));
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(5);
    expect(labwcCalls().filter((c) => c === "--exit")).toHaveLength(1);
    expect(readText(log)).toContain("five quick exits in a row, ending the session");
  });

  it("ends a Chrome from an earlier session that holds the profile, and does not count the hand-off", async () => {
    const holder = await profileHolder();
    // The holder started before this session's labwc: it is the earlier session's.
    await sleepMs(60);
    const labwc = compositor();
    expect(procStart(holder.pid!)).toBeLessThan(procStart(labwc.pid!));
    const { done } = startLauncher(env(labwc.pid!));
    expect(await finished(done)).toBe(0);
    await exited(holder);
    expect(holder.signalCode).toBe("SIGTERM");
    // The hand-off, then our own Chrome — which then loses the compositor.
    expect(chromeLaunches()).toHaveLength(2);
    expect(labwcCalls().filter((c) => c.includes("--exit"))).toEqual([]);
    expect(readText(log)).toContain(`Chrome ${holder.pid} from an earlier session holds the profile; ending it`);
  });

  it("watches a Chrome of this session that holds the profile instead of launching over it", async () => {
    const labwc = compositor();
    await sleepMs(60);
    const holder = await profileHolder();
    setWindow("up");
    const { child, done } = startLauncher(env(labwc.pid!));
    await waitFor("the launcher to adopt the holder", () =>
      readText(log).includes(`Chrome ${holder.pid}, which this launcher did not start, holds the profile; watching it`),
    );
    const callsThen = wlrctlCalls();
    await waitFor("the watchdog to look a few more times", () => wlrctlCalls() >= callsThen + 4);
    // One hand-off and nothing since: no relaunch every two seconds, no extra desktop windows.
    expect(chromeLaunches()).toHaveLength(1);
    expect(child.exitCode).toBeNull();
    holder.kill("SIGTERM");
    // Then our own Chrome, which loses the compositor and ends the run.
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(2);
    expect(readText(log)).toContain(`Chrome ${holder.pid} exited`);
    expect(labwcCalls().filter((c) => c.includes("--exit"))).toEqual([]);
  });

  it("does not ask for a second desktop window while the first is still coming up", async () => {
    const labwc = compositor();
    setModes(["hold"]);
    // The window never maps in these first passes (a cold start at boot).
    const { done } = startLauncher(env(labwc.pid!));
    await waitFor("several passes of the watchdog", () => wlrctlCalls() >= 6);
    expect(chromeLaunches()).toHaveLength(1);
    expect(readText(log)).not.toContain("reopening");
    // The session ends: the watchdog takes Chrome down with it, and the launcher leaves.
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(1);
    expect(labwcCalls().filter((c) => c.includes("--exit"))).toEqual([]);
  });

  it("asks the running Chrome for the desktop window again once it was up and is gone", async () => {
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const { done } = startLauncher(env(labwc.pid!));
    await waitFor("the window to be seen", () => wlrctlCalls() >= 2);
    setWindow("down");
    await waitFor("the window to be asked for again", () => chromeLaunches().length >= 2);
    expect(chromeLaunches()[1]).toContain(`--app=${URL}`);
    expect(readText(log)).toContain("desktop window gone, reopening it");
    setWindow("up");
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
  });

  it("hands Chrome ONE --disable-features list that keeps a hidden desktop's timers off the once-a-minute wake-up, on every launch", async () => {
    // The desktop window can be hidden too, and Chrome wakes a chain of
    // timers in a page hidden for more than five minutes only once a minute —
    // about as rarely as an entry of the agent's notice ring lives. Chrome
    // reads only the LAST --disable-features, so the feature has to be in the
    // session's one list, not a second one beside it. The watchdog's request
    // for the window again goes out with the same flags as the first launch.
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const { done } = startLauncher(env(labwc.pid!));
    await waitFor("the window to be seen", () => wlrctlCalls() >= 2);
    setWindow("down");
    await waitFor("the window to be asked for again", () => chromeLaunches().length >= 2);
    setWindow("up");
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
    for (const launch of chromeLaunches()) {
      const args = launch.split(" ").slice(1);
      const lists = args.filter((a) => a.startsWith("--disable-features="));
      expect(lists, launch).toHaveLength(1);
      expect(lists[0].slice("--disable-features=".length).split(",").sort(), launch).toEqual([
        "IntensiveWakeUpThrottling",
        "MediaRouter",
        "Translate",
      ]);
      // Not the broad switch: hidden pages keep their one-wake-up-a-second throttling.
      expect(args, launch).not.toContain("--disable-background-timer-throttling");
    }
  });

  /**
   * Chrome's tile memory (`--force-gpu-mem-available-mb`): Chrome gives a page
   * the budget of ONE screen, and the desktop is one page over the whole row.
   * The row comes from clawbox-desktop-span.mjs `--device-row` (a stand-in
   * here), the GPU's memory from a fake /sys and /proc.
   */
  /**
   * The host's PATH as one folder of links, minus `nvidia-smi`: a host with an
   * NVIDIA card has a real one, and a tile-memory case must never read the
   * real GPU. A case that wants one puts a fake first on PATH (`nvidiaSmi`).
   */
  let hostPathNoSmi = "";
  function pathWithoutNvidiaSmi(): string {
    if (hostPathNoSmi) return hostPathNoSmi;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-launcher-path-"));
    const seen = new Set(["nvidia-smi"]);
    for (const d of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) {
        if (seen.has(n)) continue;
        seen.add(n);
        fs.symlinkSync(path.join(d, n), path.join(dir, n));
      }
    }
    hostPathNoSmi = dir;
    return dir;
  }
  afterAll(() => {
    if (hostPathNoSmi) fs.rmSync(hostPathNoSmi, { recursive: true, force: true });
  });

  function tileMemEnv(pid: number, row: string, gpu: { vramMb?: number; intel?: boolean; memTotalKb?: number; nvidiaSmi?: string } = {}) {
    const sys = path.join(tmp, "sysroot");
    const card = path.join(sys, "sys/class/drm/card0/device");
    fs.mkdirSync(card, { recursive: true });
    // A connector beside the card, as sysfs lists it: never read as a card.
    fs.mkdirSync(path.join(sys, "sys/class/drm/card0-DP-1/device"), { recursive: true });
    fs.writeFileSync(path.join(sys, "sys/class/drm/card0-DP-1/device/mem_info_vram_total"), String(64 * 2 ** 30));
    fs.writeFileSync(path.join(card, "vendor"), gpu.intel ? "0x8086\n" : "0x10de\n");
    if (gpu.vramMb) fs.writeFileSync(path.join(card, "mem_info_vram_total"), `${gpu.vramMb * 2 ** 20}\n`);
    fs.mkdirSync(path.join(sys, "proc"), { recursive: true });
    fs.writeFileSync(path.join(sys, "proc/meminfo"), `MemTotal:       ${gpu.memTotalKb ?? 32 * 2 ** 20} kB\nMemFree:         1000 kB\n`);
    const span = path.join(tmp, "span");
    writeExec(span, '#!/bin/sh\n[ "$1" = --device-row ] && [ -n "$FAKE_ROW" ] && echo "$FAKE_ROW"\nexit 0\n');
    if (gpu.nvidiaSmi) writeExec(path.join(tmp, "bin", "nvidia-smi"), gpu.nvidiaSmi);
    return env(pid, {
      CLAWBOX_KIOSK_NODE: which("sh"),
      CLAWBOX_DESKTOP_SPAN: span,
      CLAWBOX_DESKTOP_SYS_ROOT: sys,
      FAKE_ROW: row,
      PATH: `${path.join(tmp, "bin")}:${pathWithoutNvidiaSmi()}`,
    });
  }
  const tileFlags = (launch: string) => launch.split(" ").filter((a) => a.startsWith("--force-gpu-mem-available-mb"));

  it.each([
    ["one 4K monitor: Chrome's own budget", "3840 2160 1", {}, []],
    ["two 4K monitors, an Intel GPU on 32 GB", "7680 2160 2", { intel: true }, ["--force-gpu-mem-available-mb=4096"]],
    ["two 4K monitors, an Intel GPU on 8 GB: a quarter of it", "7680 2160 2", { intel: true, memTotalKb: 8 * 2 ** 20 }, ["--force-gpu-mem-available-mb=2048"]],
    ["two 4K monitors, a card with 4 GB of its own: half of it", "7680 2160 2", { vramMb: 4096 }, ["--force-gpu-mem-available-mb=2048"]],
    ["two 4K monitors, a GPU whose memory cannot be read", "7680 2160 2", {}, ["--force-gpu-mem-available-mb=2048"]],
    ["three 4K monitors on a 16 GB card", "11520 2160 3", { vramMb: 16384 }, ["--force-gpu-mem-available-mb=6144"]],
    ["one 5K monitor", "5120 2880 1", { intel: true }, ["--force-gpu-mem-available-mb=3840"]],
    ["a row just past a whole 256 MB: rounded up", "4097 2304 1", { intel: true }, ["--force-gpu-mem-available-mb=2560"]],
    ["two 1080p monitors: never under Chrome's own 1 GB", "3840 1080 2", {}, ["--force-gpu-mem-available-mb=1024"]],
    ["two 4K monitors on 1.5 GB of card memory: never more than the card can spare", "7680 2160 2", { vramMb: 1536 }, ["--force-gpu-mem-available-mb=768"]],
    ["two 4K monitors on 512 MB of card memory: no flag, which would only lower Chrome's own", "7680 2160 2", { vramMb: 512 }, []],
    ["no row to read", "", { intel: true }, []],
  ])("sizes Chrome's tile memory to the row as it starts: %s", async (what, row, gpu, flags) => {
    const labwc = compositor();
    const { done } = startLauncher(tileMemEnv(labwc.pid!, row, gpu));
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(1);
    expect(tileFlags(chromeLaunches()[0])).toEqual(flags);
    if (flags.length) expect(readText(log)).toContain(`tile memory: ${flags[0].split("=")[1]} MB for a ${row.split(" ").slice(0, 2).join("x")} device px row`);
    if (what.includes("512 MB")) expect(readText(log)).toContain("tile memory: Chrome's own for a 7680x2160 device px row (the GPU can spare 256 MB)");
  });

  it.each([
    ["3000", "3840 2160 1", ["--force-gpu-mem-available-mb=3000"]],
    ["0", "7680 2160 2", []],
    ["lots", "7680 2160 2", ["--force-gpu-mem-available-mb=2048"]],
  ])("takes CLAWBOX_DESKTOP_TILE_MEM_MB=%s from kiosk.env over the row (0: no flag; not a number: ignored)", async (value, row, flags) => {
    fs.appendFileSync(path.join(tmp, "kiosk.env"), `CLAWBOX_DESKTOP_TILE_MEM_MB=${value}\n`);
    const labwc = compositor();
    const { done } = startLauncher(tileMemEnv(labwc.pid!, row));
    expect(await finished(done)).toBe(0);
    expect(tileFlags(chromeLaunches()[0])).toEqual(flags);
    expect(readText(log).includes("is not a whole number of MB; ignored")).toBe(value === "lots");
  });

  // An NVIDIA card (vendor 0x10de, the fixture's default card): its memory
  // from `nvidia-smi` under a 2 s timeout, the cap half of it as for amdgpu.
  // The fake records how it was asked.
  const smi = (body: string) => `#!/bin/sh\necho "$*" >> "$FAKE/nvidia-smi.txt"\n${body}\n`;
  const QUERY = "--query-gpu=memory.total --format=csv,noheader,nounits";
  it.each([
    ["an 8 GB card: half of it", { nvidiaSmi: smi("echo 8192") }, "7680 2160 2", 4096, 1],
    ["two cards: the larger one", { nvidiaSmi: smi("printf '4096\\n16384\\n'") }, "11520 2160 3", 6144, 1],
    ["no nvidia-smi (the nouveau driver): the fallback", {}, "7680 2160 2", 2048, 0],
    ["nvidia-smi failing: the fallback, even with a number printed", { nvidiaSmi: smi("echo 8192; exit 9") }, "7680 2160 2", 2048, 1],
    ["nvidia-smi printing anything else: the fallback", { nvidiaSmi: smi("echo '[N/A]'; echo 'No devices were found'; echo '8192 MiB'") }, "7680 2160 2", 2048, 1],
    ["nvidia-smi hanging: the fallback once its 2 s are up", { nvidiaSmi: smi(`exec ${REAL_SLEEP} 30`) }, "7680 2160 2", 2048, 1],
    ["an Intel GPU beside an nvidia-smi: its own rule, nvidia-smi never asked", { intel: true, memTotalKb: 8 * 2 ** 20, nvidiaSmi: smi("echo 8192") }, "7680 2160 2", 2048, 0],
  ])("reads an NVIDIA card's memory through nvidia-smi: %s", async (_what, gpu, row, mb, asked) => {
    const labwc = compositor();
    const started = Date.now();
    const { done } = startLauncher(tileMemEnv(labwc.pid!, row, gpu));
    expect(await finished(done)).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(tileFlags(chromeLaunches()[0])).toEqual([`--force-gpu-mem-available-mb=${mb}`]);
    expect(lines(path.join(fake, "nvidia-smi.txt"))).toEqual(Array(asked).fill(QUERY));
  });

  it("starts no Chrome when its labwc goes while the tile memory is being sized", async () => {
    // nvidia-smi can take up to its 2 s timeout: labwc may end meanwhile, and
    // a Chrome started then lands on the NEXT session's screen.
    const labwc = compositor();
    const gone = smi(`kill "$LABWC_PID"; while kill -0 "$LABWC_PID" 2>/dev/null; do ${REAL_SLEEP} 0.02; done; echo 8192`);
    const { done } = startLauncher(tileMemEnv(labwc.pid!, "7680 2160 2", { nvidiaSmi: gone }));
    expect(await finished(done)).toBe(0);
    expect(lines(path.join(fake, "nvidia-smi.txt"))).toEqual([QUERY]);
    // The watchdog ends such a Chrome at once, often before it has done
    // anything; the launcher's own log still says it was started.
    expect(chromeLaunches()).toEqual([]);
    expect(readText(log)).not.toContain("chromium exited");
    expect(labwcCalls().filter((c) => c.includes("--exit"))).toEqual([]);
    expect(readText(log)).toContain(`labwc (${labwc.pid}) is gone; this session is over`);
  });

  it("asks the running Chrome for the desktop window again with the tile memory it started with", async () => {
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const { done } = startLauncher(tileMemEnv(labwc.pid!, "7680 2160 2", { intel: true }));
    await waitFor("the window to be seen", () => wlrctlCalls() >= 2);
    setWindow("down");
    await waitFor("the window to be asked for again", () => chromeLaunches().length >= 2);
    setWindow("up");
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
    for (const launch of chromeLaunches()) expect(tileFlags(launch), launch).toEqual(["--force-gpu-mem-available-mb=4096"]);
  });

  it("starts Chrome clean after a crash: no restored session, no restore bubble, the rest of the profile kept", async () => {
    writeCrashedPrefs();
    const labwc = compositor();
    const { done } = startLauncher(env(labwc.pid!));
    expect(await finished(done)).toBe(0);
    expect(chromeLaunches()).toHaveLength(1);
    expect(chromeLaunches()[0].split(" ")).toContain("--hide-crash-restore-bubble");
    const prefs = readPrefs();
    expect(prefs.profile).toEqual({ exit_type: "Normal", exited_cleanly: true, name: "Person 1" });
    expect(prefs.session).toEqual({ restore_on_startup: 5, startup_urls: [] });
    expect(prefs.partition).toEqual(CRASHED_PREFS.partition);
    expect(readText(log)).toContain("session: ");
    expect(readText(log)).not.toContain("not found; Chrome may restore");
  });

  it("leaves the preferences of a profile another Chrome holds to that Chrome, and starts clean once it is gone", async () => {
    writeCrashedPrefs();
    const labwc = compositor();
    await sleepMs(60);
    const holder = await profileHolder();
    setWindow("up");
    const { done } = startLauncher(env(labwc.pid!));
    await waitFor("the launcher to adopt the holder", () => readText(log).includes("which this launcher did not start, holds the profile; watching it"));
    expect(readText(log)).toContain("its preferences are left to it");
    expect(readPrefs()).toEqual(CRASHED_PREFS);
    holder.kill("SIGKILL");
    expect(await finished(done)).toBe(0);
    // Its own Chrome, after the holder: on preferences that now start clean.
    expect(chromeLaunches()).toHaveLength(2);
    expect(readPrefs().profile.exit_type).toBe("Normal");
    expect(readPrefs().session.restore_on_startup).toBe(5);
  });

  it("reconfigures labwc once for a config it rendered, not on every pass", async () => {
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const { done } = startLauncher(env(labwc.pid!));
    await waitFor("several passes of the watchdog", () => wlrctlCalls() >= 6);
    expect(labwcCalls()).toEqual(["--reconfigure"]);
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
  });

  it("never reconfigures labwc over a template it cannot read, and says so once", async () => {
    // The session rendered a good config before labwc started.
    const render = spawnSync("bash", [launcherCopy, "--render-config"], { encoding: "utf-8", env: env(0) });
    expect(render.status, render.stderr).toBe(0);
    const good = fs.readFileSync(path.join(conf, "rc.xml"), "utf-8");
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const missing = path.join(tmp, "no-such-template.xml.in");
    const { done } = startLauncher(env(labwc.pid!, { CLAWBOX_LABWC_TEMPLATE: missing }));
    await waitFor("several passes of the watchdog", () => wlrctlCalls() >= 6);
    expect(labwcCalls()).toEqual([]);
    expect(fs.readFileSync(path.join(conf, "rc.xml"), "utf-8")).toBe(good);
    expect(readText(log).split(`cannot read ${missing}; the labwc config in use is kept`)).toHaveLength(2);
    labwc.kill("SIGTERM");
    expect(await finished(done)).toBe(0);
    expect(fs.readdirSync(conf)).toEqual(["rc.xml"]);
  });

  it("leaves no half-rendered config behind when its watchdog is ended mid-render", async () => {
    const render = spawnSync("bash", [launcherCopy, "--render-config"], { encoding: "utf-8", env: env(0) });
    expect(render.status, render.stderr).toBe(0);
    // A python3 that is slow to say a new config is well-formed — the window a
    // watchdog ended at the wrong moment used to leave its temp file in.
    const slow = path.join(tmp, "slow-bin");
    fs.mkdirSync(slow);
    writeExec(
      path.join(slow, "python3"),
      `#!/bin/sh
case "$*" in *"${conf}/rc.xml."*) touch "$FAKE/validating"; ${REAL_SLEEP} 0.5 ;; esac
exec ${which("python3")} "$@"
`,
    );
    const labwc = compositor();
    setModes(["hold"]);
    setWindow("up");
    const e = env(labwc.pid!, { CLAWBOX_DESKTOP_SHELF_PX: "60" });
    const { done } = startLauncher({ ...e, PATH: `${slow}:${e.PATH}` });
    await waitFor("a render in progress", () => fs.existsSync(path.join(fake, "validating")));
    expect(fs.readdirSync(conf).some((f) => f.startsWith("rc.xml."))).toBe(true);
    // Chrome exits: the launcher ends that watchdog where it stands.
    process.kill(Number(chromeLaunches()[0].split(" ")[0]), "SIGKILL");
    expect(await finished(done)).toBe(0);
    await waitFor("the temp file to go", () => fs.readdirSync(conf).every((f) => f === "rc.xml"), 5_000);
  });
});
