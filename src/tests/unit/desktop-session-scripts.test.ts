/**
 * Monitor mode's SESSION scripts (scripts/x64-migration/kiosk/): the labwc
 * session GDM starts, the Chrome launcher that renders the labwc config, the
 * span watcher's arithmetic, and the installer that puts them in place.
 *
 *  1. `layoutBox` (clawbox-desktop-span.mjs) — the size of the row of enabled
 *     monitors, read from wlr-randr's text — against the test machine's real
 *     output (`wlr-randr-two-external.txt`, shared with monitors-layout.test.ts)
 *     and hand-made outputs (rotation, scale, a disabled output, nothing on),
 *     and against the web server's own parser (src/lib/monitors-layout.ts),
 *     which sizes the same window after a layout change: the two must agree,
 *     or the watcher and the server resize the desktop back and forth.
 *  2. `clawbox-desktop-browser --render-config` — the labwc config the session
 *     starts with. The launcher sources the ROOT-OWNED /etc/clawbox/kiosk.env
 *     (hard-coded, under `set -u`), and the installer writes
 *     CLAWBOX_MONITORS_FILE into that file, where it outranks the environment.
 *     So the behaviour tests run a COPY of the launcher whose one `source` line
 *     names a kiosk.env of the test's own — the rest of the script byte for
 *     byte — which makes them hermetic everywhere (CI has no kiosk.env). The
 *     real file is exercised once, read-only, and only where it exists and
 *     cannot redirect the render outside the test's temp dir; elsewhere that
 *     one test skips. A template that cannot be read, or renders to nothing
 *     well-formed, never replaces the config in use; in mirror mode the shelf
 *     margin is on every monitor. The session writes monitor mode's marker —
 *     labwc's own PID — the moment before it becomes labwc.
 *  3. `bash -n` of the three shell scripts, `node --check` of the watcher.
 *  4. `--revert` changes the session alone; install.sh — the Jetson product's
 *     installer — knows none of it.
 *
 * The launcher's life inside a session (its compositor, the crash loop, the
 * watchdog) is desktop-session-launcher.test.ts.
 *
 * Every write goes to an OS temp dir: never /etc, /usr/local or the live
 * session's /run/user/<uid>/clawbox-labwc. Nothing here runs Chrome, labwc,
 * wlr-randr or dials a DevTools port.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logicalSize, parseWlrRandr } from "@/lib/monitors-layout";
import { layoutBox } from "../../../scripts/x64-migration/kiosk/clawbox-desktop-span.mjs";

// The scripts run as real bash/python processes (test-timeout-hygiene).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const KIOSK = path.join(ROOT, "scripts/x64-migration/kiosk");
const SESSION = path.join(KIOSK, "clawbox-desktop-session");
const BROWSER = path.join(KIOSK, "clawbox-desktop-browser");
const SPAN = path.join(KIOSK, "clawbox-desktop-span.mjs");
const INSTALLER = path.join(KIOSK, "install-desktop-session.sh");
const TEMPLATE = path.join(ROOT, "kiosk/labwc/rc.xml.in");
const REAL_KIOSK_ENV = "/etc/clawbox/kiosk.env";
const SOURCE_LINE = `. ${REAL_KIOSK_ENV}`;

const fixture = (name: string) =>
  fs.readFileSync(path.join(ROOT, "src/tests/fixtures/monitors", name), "utf-8");

// jsdom has no type package in this repo; the one constructor used is typed here.
const { JSDOM } = createRequire(__filename)("jsdom") as {
  JSDOM: new (markup: string, opts: { contentType: string }) => { window: { document: Document } };
};
/** Throws on anything that is not well-formed XML. */
const parseXml = (xml: string): Document => new JSDOM(xml, { contentType: "application/xml" }).window.document;
const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, "");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const isRoot = process.getuid?.() === 0;

// ── 1. layoutBox ────────────────────────────────────────────────────────────

interface FakeOutput {
  name: string;
  enabled?: boolean;
  /** "WxH" or "WxH@current"; the first is preferred. */
  modes: string[];
  position?: [number, number];
  transform?: string;
  scale?: number;
  /** Print Position/Transform/Scale even for a disabled output (a stale record). */
  forceGeometry?: boolean;
}

/** wlr-randr 0.3's plain text for a set of outputs, as the real tool prints it. */
function wlrRandrText(outputs: FakeOutput[]): string {
  const lines: string[] = [];
  for (const o of outputs) {
    const enabled = o.enabled ?? true;
    lines.push(`${o.name} "Make Model SER-${o.name} (${o.name})"`);
    lines.push("  Make: Make", "  Model: Model", `  Serial: SER-${o.name}`, "  Physical size: 600x340 mm");
    lines.push(`  Enabled: ${enabled ? "yes" : "no"}`, "  Modes:");
    o.modes.forEach((m, i) => {
      const [size, cur] = m.split("@");
      const flags = [i === 0 ? "preferred" : "", cur === "current" ? "current" : ""].filter(Boolean);
      lines.push(`    ${size} px, 60.000000 Hz${flags.length ? ` (${flags.join(", ")})` : ""}`);
    });
    if (enabled || o.forceGeometry) {
      const [x, y] = o.position ?? [0, 0];
      lines.push(`  Position: ${x},${y}`, `  Transform: ${o.transform ?? "normal"}`);
      lines.push(`  Scale: ${(o.scale ?? 1).toFixed(6)}`, "  Adaptive Sync: disabled");
    }
  }
  return lines.join("\n") + "\n";
}

/** The same box, the web server's way: its parser, its logical size. */
function serverBox(text: string): { width: number; height: number } | null {
  const rects = parseWlrRandr(text)
    .filter((o) => o.enabled && o.current && o.current.width > 0 && o.current.height > 0)
    .map((o) => {
      const size = logicalSize(o.current!.width, o.current!.height, o.scale, o.transform);
      const pos = o.position ?? { x: 0, y: 0 };
      return { x: pos.x, y: pos.y, w: size.width, h: size.height };
    });
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  return {
    width: Math.max(...rects.map((r) => r.x + r.w)) - left,
    height: Math.max(...rects.map((r) => r.y + r.h)) - top,
  };
}

const one = (o: Omit<FakeOutput, "name">) => wlrRandrText([{ name: "DP-1", ...o }]);

describe("layoutBox (clawbox-desktop-span.mjs)", () => {
  it("sizes the test machine's real row: two 2560x1440 monitors side by side, the panel off", () => {
    expect(layoutBox(fixture("wlr-randr-two-external.txt"))).toEqual({ width: 5120, height: 1440 });
  });

  it("sizes the hand-made fractional-scale, rotated fixture", () => {
    // eDP-1 1920x1080 @1.25 → 1536x864 at 0,0; DP-1 1920x1080 rotated 90 @1.5
    // → 720x1280 at 1536,0. The current mode is not the preferred one there.
    expect(layoutBox(fixture("wlr-randr-builtin-rotated.txt"))).toEqual({ width: 2256, height: 1280 });
  });

  it.each([
    ["normal", { width: 1920, height: 1080 }],
    ["90", { width: 1080, height: 1920 }],
    ["180", { width: 1920, height: 1080 }],
    ["270", { width: 1080, height: 1920 }],
    ["flipped", { width: 1920, height: 1080 }],
    ["flipped-90", { width: 1080, height: 1920 }],
    ["flipped-180", { width: 1920, height: 1080 }],
    ["flipped-270", { width: 1080, height: 1920 }],
  ])("swaps width and height for a quarter turn only (transform %s)", (transform, box) => {
    expect(layoutBox(one({ modes: ["1920x1080@current"], transform }))).toEqual(box);
  });

  it.each([
    [2, "3840x2160", { width: 1920, height: 1080 }],
    [1.5, "1920x1080", { width: 1280, height: 720 }],
    [1.25, "2560x1440", { width: 2048, height: 1152 }],
    // 1092.8 x 614.4 — truncated, as wlroots' logical size is (an int cast).
    [1.25, "1366x768", { width: 1092, height: 614 }],
  ])("divides by the scale (%s, %s)", (scale, size, box) => {
    expect(layoutBox(one({ modes: [`${size}@current`], scale }))).toEqual(box);
  });

  it("rotates before it scales", () => {
    expect(layoutBox(one({ modes: ["3840x2160@current"], transform: "90", scale: 1.5 }))).toEqual({ width: 1440, height: 2560 });
  });

  it("reads a scale of 0 as 1, like the server's parser", () => {
    expect(layoutBox(one({ modes: ["1920x1080@current"], scale: 0 }))).toEqual({ width: 1920, height: 1080 });
  });

  it("uses the CURRENT mode, not the preferred one", () => {
    expect(layoutBox(one({ modes: ["3840x2160", "1920x1080@current"] }))).toEqual({ width: 1920, height: 1080 });
  });

  it("leaves a disabled output out, even one that still carries a mode and a position", () => {
    const text = wlrRandrText([
      { name: "HDMI-A-1", modes: ["1920x1080@current"], position: [0, 0] },
      { name: "DP-2", enabled: false, modes: ["3840x2160@current"], position: [1920, 0], forceGeometry: true },
    ]);
    expect(layoutBox(text)).toEqual({ width: 1920, height: 1080 });
  });

  it("spans a row of mixed heights from its left and top edges", () => {
    const text = wlrRandrText([
      { name: "HDMI-A-1", modes: ["2560x1440@current"], position: [0, 0] },
      { name: "DP-1", modes: ["1920x1080@current"], position: [2560, 0] },
      { name: "DP-2", modes: ["1920x1200@current"], position: [4480, 0], transform: "90" },
    ]);
    expect(layoutBox(text)).toEqual({ width: 4480 + 1200, height: 1920 });
  });

  it("measures from the leftmost and topmost monitor, wherever the layout starts", () => {
    const text = wlrRandrText([
      { name: "HDMI-A-1", modes: ["1920x1080@current"], position: [-1920, 0] },
      { name: "DP-1", modes: ["1920x1080@current"], position: [0, 200] },
    ]);
    expect(layoutBox(text)).toEqual({ width: 3840, height: 1280 });
  });

  it("answers null when no monitor is on", () => {
    expect(layoutBox("")).toBeNull();
    expect(layoutBox("not wlr-randr output\n")).toBeNull();
    expect(layoutBox(wlrRandrText([{ name: "eDP-1", enabled: false, modes: ["1920x1080"] }]))).toBeNull();
    expect(
      layoutBox(wlrRandrText([
        { name: "eDP-1", enabled: false, modes: ["1920x1080"] },
        { name: "HDMI-A-1", enabled: false, modes: ["2560x1440@current"], forceGeometry: true },
      ])),
    ).toBeNull();
  });

  it("answers null for an output that is on but has no current mode", () => {
    expect(layoutBox(one({ modes: ["1920x1080"] }))).toBeNull();
  });

  it("agrees with the web server's parser on every case above", () => {
    const cases = [
      fixture("wlr-randr-two-external.txt"),
      fixture("wlr-randr-builtin-rotated.txt"),
      ...["normal", "90", "180", "270", "flipped", "flipped-90", "flipped-180", "flipped-270"].map((transform) =>
        one({ modes: ["1920x1080@current"], transform, scale: 1.25 }),
      ),
      one({ modes: ["1366x768@current"], scale: 1.25 }),
      one({ modes: ["3840x2160@current"], transform: "270", scale: 1.75 }),
      wlrRandrText([
        { name: "HDMI-A-1", modes: ["1920x1080@current"], position: [-1920, 0] },
        { name: "DP-1", modes: ["1920x1080@current"], position: [0, 200] },
        { name: "DP-2", enabled: false, modes: ["3840x2160@current"], position: [1920, 0], forceGeometry: true },
      ]),
      wlrRandrText([{ name: "eDP-1", enabled: false, modes: ["1920x1080"] }]),
    ];
    for (const text of cases) expect(layoutBox(text), text.split("\n")[0]).toEqual(serverBox(text));
  });
});

// ── 2. clawbox-desktop-browser --render-config ──────────────────────────────

interface RenderResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The rendered rc.xml, or null when none was written. */
  rc: string | null;
  confFiles: string[];
}

let tmp = "";
let conf = "";
let local = "";
let monitorsFile = "";
let kioskEnv = "";
let browserCopy = "";

/**
 * A copy of `script` in the temp dir whose one `. /etc/clawbox/kiosk.env`
 * line sources the test's own kiosk.env instead — nothing else changes.
 */
function hermeticCopy(script: string, name: string): string {
  const text = fs.readFileSync(script, "utf-8");
  const lines = text.split("\n");
  expect(lines.filter((l) => l === SOURCE_LINE), `${name} sources ${REAL_KIOSK_ENV} exactly once`).toHaveLength(1);
  const out = path.join(tmp, name);
  fs.writeFileSync(out, lines.map((l) => (l === SOURCE_LINE ? `. "${kioskEnv}"` : l)).join("\n"), { mode: 0o755 });
  return out;
}

/** The environment a render gets: built from nothing, every path in the temp dir. */
function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(tmp, "home"),
    XDG_RUNTIME_DIR: path.join(tmp, "run"),
    LANG: "C.UTF-8",
    CLAWBOX_LABWC_CONF: conf,
    CLAWBOX_LABWC_TEMPLATE: TEMPLATE,
    CLAWBOX_DESKTOP_LOCAL: local,
    CLAWBOX_MONITORS_FILE: monitorsFile,
    CLAWBOX_KIOSK_PROFILE: path.join(tmp, "profile"),
    CLAWBOX_KIOSK_LOG: path.join(tmp, "kiosk.log"),
    CLAWBOX_DESKTOP_SHELF_PX: "56",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env as unknown as NodeJS.ProcessEnv;
}

function render(extra: Record<string, string | undefined> = {}, script = browserCopy): RenderResult {
  const r = spawnSync("bash", [script, "--render-config"], { encoding: "utf-8", env: baseEnv(extra), timeout: 30_000 });
  const rcPath = path.join(conf, "rc.xml");
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    rc: fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf-8") : null,
    confFiles: fs.existsSync(conf) ? fs.readdirSync(conf).sort() : [],
  };
}

const writeMonitors = (value: unknown) =>
  fs.writeFileSync(monitorsFile, typeof value === "string" ? value : JSON.stringify(value, null, 2));
const writeKeybinds = (xml: string) => {
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "keybinds.xml"), xml);
};
const OWNER_KEYBIND = '<keybind key="W-t">\n  <action name="Execute" command="foot" />\n</keybind>\n';

/** The <margin> element and the keybinds of a rendered config, parsed. */
function inspect(rc: string) {
  const doc = parseXml(rc);
  const margin = doc.querySelector("labwc_config > margin");
  const keys = [...doc.querySelectorAll("labwc_config > keyboard > keybind")].map((k) => k.getAttribute("key"));
  const rule = doc.querySelector("labwc_config > windowRules > windowRule");
  return { doc, margin, keys, rule };
}

function expectAllSubstituted(rc: string, opts: { outputInComments: boolean }) {
  // Everywhere, comments included: these three are replaced line-wide.
  for (const p of ["@DESKTOP_APP_ID@", "@SHELF_PX@", "@LOCAL_KEYBINDS@"]) expect(rc).not.toContain(p);
  // Outside the comments nothing is left at all.
  expect(stripComments(rc)).not.toMatch(/@[A-Z_]+@/);
  // With no main monitor only the ATTRIBUTE is dropped; the template's header
  // comment still names the placeholder, which labwc never reads.
  if (!opts.outputInComments) expect(rc).not.toContain("@SHELF_OUTPUT@");
}

describe.skipIf(!hasBash || !hasPython)("clawbox-desktop-browser --render-config", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-desktop-session-"));
    conf = path.join(tmp, "conf");
    local = path.join(tmp, "local");
    monitorsFile = path.join(tmp, "monitors.json");
    kioskEnv = path.join(tmp, "kiosk.env");
    fs.writeFileSync(kioskEnv, "CLAWBOX_KIOSK_URL=http://localhost:3005/\nCLAWBOX_KIOSK_XKB_LAYOUT=us\n");
    browserCopy = hermeticCopy(BROWSER, "clawbox-desktop-browser");
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("renders a well-formed config with every placeholder filled", () => {
    const r = render();
    expect(r.status, r.stderr).toBe(0);
    expect(r.rc).not.toBeNull();
    const { margin, rule } = inspect(r.rc!);
    expectAllSubstituted(r.rc!, { outputInComments: true });
    expect(rule?.getAttribute("identifier")).toBe("chrome-localhost__-Default");
    expect(margin?.getAttribute("bottom")).toBe("56");
    expect(r.confFiles).toEqual(["rc.xml"]);
  });

  it("names the app window the session tells it to", () => {
    const r = render({ CLAWBOX_DESKTOP_APP_ID: "chrome-clawbox.local__-Default" });
    expect(r.status).toBe(0);
    expect(inspect(r.rc!).rule?.getAttribute("identifier")).toBe("chrome-clawbox.local__-Default");
    expect(r.rc).not.toContain("chrome-localhost__-Default");
  });

  it("drops the margin's output attribute while no layout has been applied", () => {
    // No monitors file at all.
    let r = render();
    expect(inspect(r.rc!).margin?.hasAttribute("output")).toBe(false);
    // A file with no applied layout, and one whose applied main output is null.
    writeMonitors({ version: 1, layout: null, applied: null });
    r = render();
    expect(inspect(r.rc!).margin?.hasAttribute("output")).toBe(false);
    writeMonitors({ version: 1, layout: null, applied: { main: null, mainOutput: null, box: null } });
    r = render();
    expect(inspect(r.rc!).margin?.hasAttribute("output")).toBe(false);
    // CLAWBOX_MONITORS_FILE unset.
    writeMonitors({ version: 1, layout: null, applied: { main: "x", mainOutput: "HDMI-A-1", box: null } });
    r = render({ CLAWBOX_MONITORS_FILE: undefined });
    expect(inspect(r.rc!).margin?.hasAttribute("output")).toBe(false);
  });

  it("puts the margin on the main monitor monitors.json records", () => {
    writeMonitors({
      version: 1,
      layout: null,
      applied: { main: "AOC Q27B3MA 17ZP6HA000848", mainOutput: "HDMI-A-1", box: { width: 5120, height: 1440 } },
    });
    const r = render();
    expect(r.status).toBe(0);
    expectAllSubstituted(r.rc!, { outputInComments: false });
    const { margin } = inspect(r.rc!);
    expect(margin?.getAttribute("output")).toBe("HDMI-A-1");
    expect(margin?.getAttribute("bottom")).toBe("56");
  });

  it.each([
    ["an attribute injection", 'HDMI-A-1" bottom="0'],
    ["a sed delimiter", "HDMI|A-1"],
    ["a path", "../../etc"],
    ["a name past 32 characters", "A".repeat(33)],
    ["an empty name", ""],
  ])("refuses %s as the main output", (_label, mainOutput) => {
    writeMonitors({ version: 1, layout: null, applied: { main: "x", mainOutput, box: null } });
    const r = render();
    expect(r.status).toBe(0);
    const { margin } = inspect(r.rc!);
    expect(margin?.hasAttribute("output")).toBe(false);
    expect(margin?.getAttribute("bottom")).toBe("56");
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["a list", "[1, 2]"],
    ["a string as applied", JSON.stringify({ applied: "HDMI-A-1" })],
    ["a number as the output", JSON.stringify({ applied: { mainOutput: 7 } })],
  ])("renders without a main output from %s", (_label, raw) => {
    writeMonitors(raw);
    const r = render();
    expect(r.status).toBe(0);
    expect(inspect(r.rc!).margin?.hasAttribute("output")).toBe(false);
  });

  it("splices the owner's keybinds after the session's own", () => {
    writeKeybinds(OWNER_KEYBIND + '<keybind key="W-Return">\n  <action name="Execute" command="foot" />\n</keybind>\n');
    const r = render();
    expect(r.status).toBe(0);
    expectAllSubstituted(r.rc!, { outputInComments: true });
    const { keys, doc } = inspect(r.rc!);
    expect(keys).toEqual(["W-d", "C-A-BackSpace", "W-t", "W-Return"]);
    // Inside <keyboard>, not anywhere else.
    expect(doc.querySelector('labwc_config > keyboard > keybind[key="W-t"] > action')?.getAttribute("command")).toBe("foot");
    expect(r.stdout).not.toContain("not well-formed");
  });

  it("leaves a malformed keybinds.xml out, says so once, and keeps the rest of the config", () => {
    writeKeybinds('<keybind key="W-t">\n  <action name="Execute" command="foot" />\n');
    const r = render();
    expect(r.status).toBe(0);
    expectAllSubstituted(r.rc!, { outputInComments: true });
    const { keys } = inspect(r.rc!);
    expect(keys).toEqual(["W-d", "C-A-BackSpace"]);
    expect(r.rc).not.toContain("W-t");
    expect(r.stdout).toContain(`${path.join(local, "keybinds.xml")} is not well-formed XML; left out`);
  });

  it("leaves out a keybinds.xml that carries its own XML declaration (it would break rc.xml)", () => {
    writeKeybinds('<?xml version="1.0"?>\n' + OWNER_KEYBIND);
    const r = render();
    expect(r.status).toBe(0);
    expect(inspect(r.rc!).keys).toEqual(["W-d", "C-A-BackSpace"]);
  });

  it("reads the shelf's height from the desktop host's page zoom when it is not fixed", () => {
    const prefs = path.join(tmp, "profile", "Default", "Preferences");
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    const zoom = (partition: unknown) => fs.writeFileSync(prefs, JSON.stringify({ partition }));
    const px = () => inspect(render({ CLAWBOX_DESKTOP_SHELF_PX: undefined }).rc!).margin?.getAttribute("bottom");

    // Nothing to read → 56.
    expect(px()).toBe("56");
    // 120% for localhost (the kiosk URL's host, port left off) → 56 × 1.2.
    zoom({ per_host_zoom_levels: { x: { localhost: { zoom_level: 1, last_modified: "1" } } } });
    expect(px()).toBe("67");
    // 90% (Chrome's level for it) → 50.
    zoom({ per_host_zoom_levels: { x: { localhost: { zoom_level: Math.log(0.9) / Math.log(1.2) } } } });
    expect(px()).toBe("50");
    // Another host's zoom is not the desktop's; the profile default applies.
    zoom({ default_zoom_level: { x: Math.log(1.25) / Math.log(1.2) }, per_host_zoom_levels: { x: { "example.com": { zoom_level: 3 } } } });
    expect(px()).toBe("70");
    // The owner's fixed value outranks the zoom.
    expect(inspect(render({ CLAWBOX_DESKTOP_SHELF_PX: "80" }).rc!).margin?.getAttribute("bottom")).toBe("80");
  });

  it("leaves no temp file behind and keeps an unchanged config as it is", () => {
    writeMonitors({ applied: { mainOutput: "DP-2" } });
    const first = render();
    expect(first.status).toBe(0);
    const before = fs.statSync(path.join(conf, "rc.xml"));
    const second = render();
    expect(second.status).toBe(0);
    expect(second.rc).toBe(first.rc);
    expect(second.confFiles).toEqual(["rc.xml"]);
    expect(fs.statSync(path.join(conf, "rc.xml")).ino).toBe(before.ino);
    // A change (another main monitor) is written.
    writeMonitors({ applied: { mainOutput: "HDMI-A-1" } });
    const third = render();
    expect(inspect(third.rc!).margin?.getAttribute("output")).toBe("HDMI-A-1");
    expect(third.confFiles).toEqual(["rc.xml"]);
  });

  // A template that is missing or unreadable used to render an EMPTY file
  // (sed's status was never checked) that `mv -f` put over the working rc.xml,
  // answering "changed" — so the watchdog ran `labwc --reconfigure` on nothing:
  // no shelf margin, no rule pinning the desktop under everything.
  it("keeps the working config when the template cannot be read, and says so", () => {
    const good = render();
    expect(good.status).toBe(0);
    const missing = render({ CLAWBOX_LABWC_TEMPLATE: path.join(tmp, "no-such-template.xml.in") });
    expect(missing.rc).toBe(good.rc);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no-such-template.xml.in; the labwc config in use is kept");
    expect(missing.confFiles).toEqual(["rc.xml"]);
  });

  it("writes no config at all from a missing template (labwc then starts on its own defaults, not an empty file)", () => {
    const r = render({ CLAWBOX_LABWC_TEMPLATE: path.join(tmp, "no-such-template.xml.in") });
    expect(r.status).toBe(1);
    expect(r.rc).toBeNull();
    expect(r.confFiles).toEqual([]);
  });

  it.skipIf(isRoot)("keeps the working config when the template is there but unreadable", () => {
    const good = render();
    const locked = path.join(tmp, "locked.xml.in");
    fs.copyFileSync(TEMPLATE, locked);
    // What `install` leaves for a moment: the new file, still root-only 0600.
    fs.chmodSync(locked, 0o000);
    const r = render({ CLAWBOX_LABWC_TEMPLATE: locked });
    expect(r.status).toBe(1);
    expect(r.rc).toBe(good.rc);
    expect(r.confFiles).toEqual(["rc.xml"]);
  });

  it.each([
    ["empty", ""],
    ["half-written", fs.readFileSync(TEMPLATE, "utf-8").slice(0, Math.floor(fs.readFileSync(TEMPLATE, "utf-8").length / 2))],
    ["not XML", "labwc_config\n"],
  ])("keeps the working config over a template that renders to nothing well-formed (%s)", (_label, text) => {
    const good = render();
    const broken = path.join(tmp, "broken.xml.in");
    fs.writeFileSync(broken, text);
    const r = render({ CLAWBOX_LABWC_TEMPLATE: broken });
    expect(r.status).toBe(1);
    expect(r.rc).toBe(good.rc);
    expect(r.stderr).toContain("renders to no well-formed config; the labwc config in use is kept");
    expect(r.confFiles).toEqual(["rc.xml"]);
  });

  it("takes the template again once it can be read", () => {
    writeMonitors({ applied: { mainOutput: "DP-2" } });
    const good = render();
    fs.rmSync(conf, { recursive: true, force: true });
    expect(render({ CLAWBOX_LABWC_TEMPLATE: path.join(tmp, "gone.xml.in") }).rc).toBeNull();
    const back = render();
    expect(back.status).toBe(0);
    expect(back.rc).toBe(good.rc);
  });

  // In mirror mode every monitor sits at the layout's origin and shows the
  // shelf; labwc gives a window whichever of them comes first in its list, so
  // a margin on the one the server called main left a maximized window over
  // the shelf on every screen whenever the other came first.
  it("puts the margin on every monitor while the monitors mirror one another", () => {
    writeMonitors({ version: 1, layout: null, applied: { main: "x", mainOutput: "HDMI-A-1", mirror: true, box: null } });
    let r = render();
    expect(r.status).toBe(0);
    const { margin } = inspect(r.rc!);
    expect(margin?.hasAttribute("output")).toBe(false);
    expect(margin?.getAttribute("bottom")).toBe("56");
    // Mirroring stopped: the main monitor again.
    writeMonitors({ version: 1, layout: null, applied: { main: "x", mainOutput: "HDMI-A-1", mirror: false, box: null } });
    r = render();
    expect(inspect(r.rc!).margin?.getAttribute("output")).toBe("HDMI-A-1");
    // Anything but a plain true is no mirror flag.
    writeMonitors({ version: 1, layout: null, applied: { main: "x", mainOutput: "HDMI-A-1", mirror: "yes", box: null } });
    r = render();
    expect(inspect(r.rc!).margin?.getAttribute("output")).toBe("HDMI-A-1");
  });

  it("is what the session runs before labwc, with the app id it derives from the kiosk URL", () => {
    fs.writeFileSync(kioskEnv, "CLAWBOX_KIOSK_URL=http://clawbox.local:3005/\nCLAWBOX_KIOSK_XKB_LAYOUT=de\n");
    const session = hermeticCopy(SESSION, "clawbox-desktop-session");
    // A stand-in labwc that records how it was started, and exits.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const record = path.join(tmp, "labwc.txt");
    fs.writeFileSync(
      path.join(bin, "labwc"),
      `#!/usr/bin/env bash\n{ printf 'ARG=%s\\n' "$@"; env | grep -E '^(CLAWBOX_DESKTOP_APP_ID|CLAWBOX_LABWC_CONF|XDG_CURRENT_DESKTOP|XKB_DEFAULT_LAYOUT)='; printf 'PID=%s\\nMARKER=%s\\n' "$$" "$(cat "$XDG_RUNTIME_DIR/clawbox-monitor-mode" 2>/dev/null)"; } > "${record}"\n`,
      { mode: 0o755 },
    );
    const runDir = path.join(tmp, "run");
    // A marker an earlier session left behind.
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "clawbox-monitor-mode"), "4194300\n");
    const r = spawnSync("bash", [session], {
      encoding: "utf-8",
      timeout: 30_000,
      env: baseEnv({
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAWBOX_DESKTOP_BROWSER: browserCopy,
        // The session sets these itself.
        CLAWBOX_LABWC_CONF: undefined,
        CLAWBOX_DESKTOP_APP_ID: undefined,
      }),
    });
    expect(r.status, r.stderr).toBe(0);
    const got = fs.readFileSync(record, "utf-8").trim().split("\n");
    const sessionConf = path.join(runDir, "clawbox-labwc");
    expect(got.filter((l) => l.startsWith("ARG="))).toEqual(["ARG=-C", `ARG=${sessionConf}`, "ARG=-s", `ARG=${browserCopy}`]);
    expect(got).toContain("CLAWBOX_DESKTOP_APP_ID=chrome-clawbox.local__-Default");
    expect(got).toContain(`CLAWBOX_LABWC_CONF=${sessionConf}`);
    expect(got).toContain("XDG_CURRENT_DESKTOP=ClawBox");
    expect(got).toContain("XKB_DEFAULT_LAYOUT=de");
    // Monitor mode's marker names the compositor itself: `exec` kept the PID,
    // so what labwc runs as is what the session wrote, over the stale one.
    const pid = got.find((l) => l.startsWith("PID="))!.slice(4);
    expect(pid).toMatch(/^\d+$/);
    expect(got).toContain(`MARKER=${pid}`);
    expect(fs.readFileSync(path.join(runDir, "clawbox-monitor-mode"), "utf-8")).toBe(`${pid}\n`);
    expect(fs.readdirSync(runDir).filter((f) => f.startsWith("clawbox-monitor-mode"))).toEqual(["clawbox-monitor-mode"]);
    // The config labwc was pointed at exists, and names the window the session named.
    const rc = fs.readFileSync(path.join(sessionConf, "rc.xml"), "utf-8");
    expect(inspect(rc).rule?.getAttribute("identifier")).toBe("chrome-clawbox.local__-Default");
    expectAllSubstituted(rc, { outputInComments: true });
  });
});

// The real, root-owned kiosk.env: read only, and only where it cannot send the
// render outside the temp dir (it is sourced AFTER the environment is set).
function realKioskEnvUsable(): boolean {
  if (!hasBash || !hasPython) return false;
  let text: string;
  try {
    text = fs.readFileSync(REAL_KIOSK_ENV, "utf-8");
  } catch {
    return false;
  }
  return !/^\s*(export\s+)?(CLAWBOX_LABWC_CONF|CLAWBOX_LABWC_TEMPLATE|CLAWBOX_DESKTOP_LOCAL|CLAWBOX_KIOSK_PROFILE|XDG_RUNTIME_DIR|HOME)=/m.test(text);
}

describe.skipIf(!realKioskEnvUsable())("clawbox-desktop-browser --render-config with this machine's kiosk.env", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-desktop-session-real-"));
    conf = path.join(tmp, "conf");
    local = path.join(tmp, "local");
    monitorsFile = path.join(tmp, "monitors.json");
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("renders a well-formed config into the given directory", () => {
    const r = render({}, BROWSER);
    expect(r.status, r.stderr).toBe(0);
    expect(r.rc).not.toBeNull();
    expect(r.confFiles).toEqual(["rc.xml"]);
    expect(stripComments(r.rc!)).not.toMatch(/@[A-Z_]+@/);
    const { margin, rule } = inspect(r.rc!);
    expect(rule?.getAttribute("identifier")).toMatch(/^chrome-.+__-Default$/);
    expect(margin?.getAttribute("bottom")).toBe("56");
    // kiosk.env may name the web server's real monitors.json (read only):
    // the output is either absent or a validated connector name.
    const output = margin?.getAttribute("output");
    if (output !== null && output !== undefined) expect(output).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});

// ── 3. Syntax ───────────────────────────────────────────────────────────────

describe.skipIf(!hasBash)("the shell scripts parse", () => {
  it.each([SESSION, BROWSER, INSTALLER].map((f) => [path.basename(f), f]))("bash -n %s", (_name, script) => {
    const r = spawnSync("bash", ["-n", script], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(script, "utf-8").split("\n")[0]).toBe("#!/usr/bin/env bash");
  });
});

describe("the watcher and the template parse", () => {
  it("node --check clawbox-desktop-span.mjs", () => {
    const r = spawnSync(process.execPath, ["--check", SPAN], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("the watcher refuses to run without a port and a URL (and importing it ran nothing)", () => {
    const r = spawnSync(process.execPath, [SPAN], { encoding: "utf-8", timeout: 10_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: clawbox-desktop-span.mjs <cdp port> <desktop url> [--watch]");
  });

  it("the labwc template itself is well-formed once its placeholders are filled", () => {
    const filled = fs
      .readFileSync(TEMPLATE, "utf-8")
      .replaceAll("@DESKTOP_APP_ID@", "chrome-localhost__-Default")
      .replaceAll("@SHELF_PX@", "56")
      .replaceAll("@SHELF_OUTPUT@", "HDMI-A-1");
    expect(() => parseXml(filled)).not.toThrow();
    expect(() => parseXml("<a><b></a>")).toThrow();
  });

  it.skipIf(!hasBash || isRoot)("the installer refuses an unknown option and a non-root caller before touching anything", () => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() } as unknown as NodeJS.ProcessEnv;
    const bad = spawnSync("bash", [INSTALLER, "--bogus"], { encoding: "utf-8", env, timeout: 10_000 });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown option: --bogus");
    const user = spawnSync("bash", [INSTALLER, "--no-restart"], { encoding: "utf-8", env, timeout: 10_000 });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain("run with sudo");
  });
});

// ── 4. The installer's paths, and install.sh ────────────────────────────────

describe("where the pieces meet", () => {
  const read = (f: string) => fs.readFileSync(f, "utf-8");

  it("the installer puts every file where the session and the launcher look for it", () => {
    const installer = read(INSTALLER);
    const session = read(SESSION);
    const browser = read(BROWSER);
    expect(installer).toContain('"$HERE/clawbox-desktop-session" /usr/local/bin/clawbox-desktop-session');
    expect(installer).toContain("Exec=/usr/local/bin/clawbox-desktop-session");
    expect(installer).toContain('"$HERE/clawbox-desktop-browser" /usr/local/bin/clawbox-desktop-browser');
    expect(session).toContain('BROWSER="${CLAWBOX_DESKTOP_BROWSER:-/usr/local/bin/clawbox-desktop-browser}"');
    expect(installer).toContain('"$HERE/clawbox-desktop-span.mjs" /usr/local/lib/clawbox/clawbox-desktop-span.mjs');
    expect(browser).toContain('SPAN="${CLAWBOX_DESKTOP_SPAN:-/usr/local/lib/clawbox/clawbox-desktop-span.mjs}"');
    expect(installer).toContain('"$REPO/kiosk/labwc/rc.xml.in" /etc/clawbox/labwc/rc.xml.in');
    expect(browser).toContain('TEMPLATE="${CLAWBOX_LABWC_TEMPLATE:-/etc/clawbox/labwc/rc.xml.in}"');
    // The file the web server writes (src/lib/monitors.ts: DATA_DIR/monitors.json).
    expect(installer).toContain('set_env CLAWBOX_MONITORS_FILE "$REPO/data/monitors.json"');
    expect(read(path.join(ROOT, "src/lib/monitors.ts"))).toContain('path.join(DATA_DIR, "monitors.json")');
    // The launcher's own default app id is the session's for the default URL.
    expect(browser).toContain('APP_ID="${CLAWBOX_DESKTOP_APP_ID:-chrome-localhost__-Default}"');
    expect(session).toContain('export CLAWBOX_DESKTOP_APP_ID="chrome-${host}__-Default"');
  });

  it("--revert changes the session alone: monitor mode ends with the labwc session, cage keeps its own layout", () => {
    const installer = read(INSTALLER);
    const start = installer.indexOf('if [ "$REVERT" -eq 1 ]; then');
    expect(start).toBeGreaterThan(-1);
    const block = installer.slice(start, installer.indexOf("\nfi\n", start));
    expect(block).toContain("set_session clawbox-kiosk");
    expect(block).toContain("the kiosk starts with every connected monitor on at its own default");
    expect(block).toContain("exit 0");
    // Nothing that would arrange a monitor, or take the saved arrangement away.
    for (const word of ["wlr-randr", "set_env", "monitors.json", "rm "]) expect(block, word).not.toContain(word);
    // The gate it relies on is the one the session writes.
    expect(installer).toContain("$XDG_RUNTIME_DIR/clawbox-monitor-mode");
    expect(read(SESSION)).toContain('marker="$XDG_RUNTIME_DIR/clawbox-monitor-mode"');
  });

  it("install.sh — the Jetson installer — mentions none of it", () => {
    const install = read(path.join(ROOT, "install.sh"));
    for (const name of [
      "clawbox-desktop-session",
      "clawbox-desktop-browser",
      "clawbox-desktop-span",
      "install-desktop-session",
      "rc.xml.in",
      "kiosk/labwc",
      "/etc/clawbox/labwc",
      "labwc",
      "wlr-randr",
      "wlrctl",
      "monitors.json",
      "CLAWBOX_MONITORS_FILE",
      "clawbox-monitor-mode",
      "x64-migration",
    ]) {
      expect(install, name).not.toContain(name);
    }
  });
});
