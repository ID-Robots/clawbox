/**
 * install-kiosk-tabs.sh (scripts/x64-migration/kiosk/) as it edits the cage
 * kiosk's Chrome launcher, RUN against stand-in launchers in a temp dir.
 *
 * The flag it adds here: IntensiveWakeUpThrottling, switched off. The desktop
 * is one kiosk tab, hidden whenever the owner is on another, and Chrome wakes
 * a chain of timers in a page hidden for more than five minutes only once a
 * minute — so the desktop's 2 s poll of the agent's notice ring ran about as
 * rarely as a ring entry lives (60 s), and an "open this app" or the move to
 * /updating could be dropped rather than late. --disable-features is ONE
 * switch (Chrome reads only the last on its command line), so the feature is
 * merged into the launcher's own list — a second list beside it would turn
 * back on whatever the launcher's list turned off — and a launcher list the
 * script cannot edit without guessing is refused before anything is touched.
 * What is asserted is the argv the edited launcher would hand Chrome: its
 * FLAGS array, evaluated by bash.
 *
 * The script hard-codes the launcher's path (/usr/local/bin) and refuses to
 * run as anyone but root, so the suite runs a COPY in which exactly those two
 * lines differ — the launcher path names the temp dir's stand-in and the root
 * check is gone — the rest byte for byte (the pattern of the desktop-session
 * suites). It is always run with --no-restart, and `systemctl`, `reboot` and
 * `pgrep` on its PATH are recorders that fail, so no case could reboot or
 * look at the machine running the suite. Nothing here touches /usr, /etc or
 * a DevTools port.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every case runs the script as a real bash process (test-timeout-hygiene).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/x64-migration/kiosk/install-kiosk-tabs.sh");
const LAUNCHER_LINE = "LAUNCHER=/usr/local/bin/clawbox-kiosk-browser";
const ROOT_CHECK_LINE = '[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }';
const WAKE = "IntensiveWakeUpThrottling";

const usable =
  process.platform === "linux" &&
  spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0 &&
  ["sha256sum", "cmp", "mktemp"].every((cmd) => spawnSync("bash", ["-c", `type -P ${cmd}`], { stdio: "ignore" }).status === 0);

let tmp = "";
let launcher = "";
let ext = "";
let scriptCopy = "";
let recorded = "";

/** A kiosk launcher in the shape the script expects: one flag a line in FLAGS. */
function launcherText(flags: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "# stand-in for the kiosk's Chrome launcher",
    'URL="http://localhost:3005/"',
    "FLAGS=(",
    ...flags.map((f) => `  ${f}`),
    ")",
    'while :; do chrome "${FLAGS[@]}" "$URL"; sleep 2; done',
    "",
  ].join("\n");
}

function writeLauncher(flags: string[]): string {
  const text = launcherText(flags);
  fs.writeFileSync(launcher, text, { mode: 0o755 });
  return text;
}

function run(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [scriptCopy, "--no-restart"], {
    encoding: "utf-8",
    env: {
      PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: path.join(tmp, "home"),
      LANG: "C.UTF-8",
      CLAWBOX_KIOSK_EXTENSION: ext,
      RECORDED: recorded,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** What Chrome would be handed: the launcher's FLAGS, evaluated by bash. */
function chromeFlags(): string[] {
  const text = fs.readFileSync(launcher, "utf-8");
  const start = text.indexOf("FLAGS=(");
  const block = text.slice(start, text.indexOf("\n)\n", start) + 3);
  const r = spawnSync("bash", ["-c", `${block}\nprintf '%s\\n' "\${FLAGS[@]}"`], { encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
}

/** Every --disable-features Chrome would see — the last is the one it reads. */
const disableLists = () =>
  chromeFlags()
    .filter((f) => f.startsWith("--disable-features="))
    .map((f) => f.slice("--disable-features=".length).split(",").filter(Boolean));

describe.skipIf(!usable)("install-kiosk-tabs.sh on the kiosk's Chrome launcher", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-kiosk-tabs-install-"));
    launcher = path.join(tmp, "clawbox-kiosk-browser");
    ext = path.join(tmp, "extension");
    recorded = path.join(tmp, "recorded.txt");
    for (const d of [ext, path.join(tmp, "bin"), path.join(tmp, "home")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(ext, "manifest.json"), "{}\n");

    const lines = fs.readFileSync(SCRIPT, "utf-8").split("\n");
    expect(lines.filter((l) => l === LAUNCHER_LINE)).toHaveLength(1);
    expect(lines.filter((l) => l === ROOT_CHECK_LINE)).toHaveLength(1);
    scriptCopy = path.join(tmp, "install-kiosk-tabs.sh");
    fs.writeFileSync(
      scriptCopy,
      lines
        .map((l) => (l === LAUNCHER_LINE ? `LAUNCHER="${launcher}"` : l === ROOT_CHECK_LINE ? ": # (root check, not in the suite)" : l))
        .join("\n"),
      { mode: 0o755 },
    );
    for (const cmd of ["systemctl", "reboot", "pgrep"]) {
      fs.writeFileSync(path.join(tmp, "bin", cmd), `#!/bin/sh\necho "${cmd} $*" >> "$RECORDED"\nexit 1\n`, { mode: 0o755 });
    }
  });

  afterEach(() => {
    // Not one case may reach for a reboot, or ask what is running.
    expect(fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf-8") : "").toBe("");
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("merges the feature into the launcher's own list, in place, keeping the features it turned off", () => {
    const before = writeLauncher(["--ozone-platform=wayland", "--disable-features=Translate,MediaRouter", "--start-maximized"]);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`added ${WAKE} to the launcher's --disable-features`);
    // ONE list — the launcher's own, where it was — so Chrome reads all three.
    expect(disableLists()).toEqual([["Translate", "MediaRouter", WAKE]]);
    const after = fs.readFileSync(launcher, "utf-8").split("\n");
    expect(after.indexOf(`  --disable-features=Translate,MediaRouter,${WAKE}`)).toBe(before.split("\n").indexOf("  --disable-features=Translate,MediaRouter"));
    // Not the broad switch: hidden pages keep their one-wake-up-a-second throttling.
    expect(chromeFlags()).not.toContain("--disable-background-timer-throttling");
    // The backup is the launcher as it was before any edit.
    expect(fs.readFileSync(`${launcher}.bak`, "utf-8")).toBe(before);
  });

  it("gives a launcher with no list a line of its own, after the flags it adds before it", () => {
    writeLauncher(["--ozone-platform=wayland", "--start-maximized"]);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(disableLists()).toEqual([[WAKE]]);
    const after = fs.readFileSync(launcher, "utf-8").split("\n");
    const allow = after.findIndex((l) => l.startsWith("  --remote-allow-origins=chrome-extension://"));
    expect(allow).toBeGreaterThan(-1);
    expect(after[allow + 1]).toBe(`  --disable-features=${WAKE}`);
  });

  it("is idempotent: a second run adds nothing, to the list or beside it", () => {
    writeLauncher(["--disable-features=Translate", "--start-maximized"]);
    expect(run().status).toBe(0);
    const once = fs.readFileSync(launcher, "utf-8");
    const bak = fs.readFileSync(`${launcher}.bak`, "utf-8");
    const again = run();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(`already installed:`);
    expect(again.stdout).toContain(`${WAKE} off`);
    expect(fs.readFileSync(launcher, "utf-8")).toBe(once);
    expect(fs.readFileSync(`${launcher}.bak`, "utf-8")).toBe(bak);
    expect(disableLists()).toEqual([["Translate", WAKE]]);
  });

  it("leaves a list that already names the feature as it is", () => {
    writeLauncher(["--start-maximized", `--disable-features=${WAKE},Translate`]);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(`added ${WAKE}`);
    expect(disableLists()).toEqual([[WAKE, "Translate"]]);
  });

  it("takes a commented-out --disable-features for the comment it is", () => {
    const text = launcherText(["--start-maximized"]).replace("FLAGS=(\n", "FLAGS=(\n  # --disable-features=Old\n");
    fs.writeFileSync(launcher, text, { mode: 0o755 });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(disableLists()).toEqual([[WAKE]]);
    expect(fs.readFileSync(launcher, "utf-8")).toContain("  # --disable-features=Old\n");
  });

  it.each([
    ["two lists (Chrome reads only the last)", ["--disable-features=Translate", "--start-maximized", "--disable-features=MediaRouter"]],
    ["a quoted list", ['--disable-features="Translate"', "--start-maximized"]],
    ["a list beside another flag", ["--no-first-run --disable-features=Translate", "--start-maximized"]],
  ])("refuses, touching nothing, a launcher with %s", (_what, flags) => {
    const before = writeLauncher(flags);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--disable-features is not one '  --disable-features=<list>' line; not touching it");
    expect(r.stderr).toContain(WAKE);
    expect(fs.readFileSync(launcher, "utf-8")).toBe(before);
    expect(fs.existsSync(`${launcher}.bak`)).toBe(false);
  });
});
