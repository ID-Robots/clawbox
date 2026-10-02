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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every case runs the launcher as a real bash process (test-timeout-hygiene).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const BROWSER = path.join(ROOT, "scripts/x64-migration/kiosk/clawbox-desktop-browser");
const TEMPLATE = path.join(ROOT, "kiosk/labwc/rc.xml.in");
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
