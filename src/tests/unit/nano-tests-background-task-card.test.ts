import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { dispatchOpenSettingsSection, OPEN_APP_EVENT, OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";

// The put-back cases start a real bash: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-2379. Nano tests 66 and 99 (scripts/nano-tests/board/background-task-
// card.*) open Settings -> Local AI in a browser of their own and follow the
// memory model's download from its row. On one board they failed every time
// with "no memory-search row was drawn" while the box's inventory carried the
// row: the owner's saved desktop held a Settings window, the desktop brought it
// back on load (TASK-1306), and the driver opened the section with the
// cold-open handoff alone — which a Settings window that is already up never
// reads. It stayed on Appearance. The driver now opens the section the way the
// box's own links do, and the board script puts the saved desktop back after.

const ROOT = process.cwd();
const DRIVER = fs.readFileSync(path.join(ROOT, "scripts/nano-tests/board/background-task-card.mjs"), "utf8");
const BOARD_SCRIPT = fs.readFileSync(path.join(ROOT, "scripts/nano-tests/board/background-task-card.sh"), "utf8");

type Pending = { __clawboxPendingSettingsSection?: unknown; __clawboxPendingSettingsFocus?: unknown };
interface Seen { type: string; detail: unknown; pending: unknown; focus: unknown }

/** A window that records every event dispatched on it, with the handoff slots as they were then. */
function recordingWindow(): { win: EventTarget & Pending; seen: Seen[] } {
  const seen: Seen[] = [];
  const win = new EventTarget() as EventTarget & Pending;
  const dispatch = win.dispatchEvent.bind(win);
  win.dispatchEvent = (event: Event) => {
    seen.push({
      type: event.type,
      detail: (event as CustomEvent).detail,
      pending: win.__clawboxPendingSettingsSection,
      focus: win.__clawboxPendingSettingsFocus,
    });
    return dispatch(event);
  };
  return { win, seen };
}

/** The page-side expression the driver evaluates to open Settings on Local AI. */
function driverOpenExpression(): string {
  const match = /page\.evaluate\(`(window\.__clawboxPendingSettingsSection = "localAi";[\s\S]*?)`\)/.exec(DRIVER);
  if (!match) throw new Error("the driver no longer opens Settings -> Local AI through a page.evaluate this test can find");
  return match[1];
}

const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("nano tests 66/99: opening Settings -> Local AI (TASK-2379)", () => {
  it("opens the section exactly the way the box's own links do: the handoff, the section event, then the app", () => {
    const driver = recordingWindow();
    // A focus a previous link left on the page must not ride along.
    driver.win.__clawboxPendingSettingsFocus = "jobAlerts";
    vm.runInNewContext(driverOpenExpression(), { window: driver.win, CustomEvent });

    const product = recordingWindow();
    product.win.__clawboxPendingSettingsFocus = "jobAlerts";
    (globalThis as { window?: unknown }).window = product.win;
    dispatchOpenSettingsSection("localAi");

    expect(product.seen.map((e) => e.type)).toEqual([OPEN_SETTINGS_SECTION_EVENT, OPEN_APP_EVENT]);
    expect(driver.seen).toEqual(product.seen);
    expect(driver.seen[0]).toMatchObject({ detail: { section: "localAi" }, pending: "localAi", focus: undefined });
    expect(driver.seen[1]).toMatchObject({ detail: { appId: "settings" } });
  });

  it("reaches a Settings window that is already up, which the cold-open handoff alone never did", () => {
    // What an open SettingsApp listens for (src/components/SettingsApp.tsx);
    // the desktop's open-app on a window already up only focuses it.
    const { win } = recordingWindow();
    const sections: unknown[] = [];
    win.addEventListener(OPEN_SETTINGS_SECTION_EVENT, (event) => sections.push((event as CustomEvent).detail?.section));
    vm.runInNewContext(driverOpenExpression(), { window: win, CustomEvent });
    expect(sections).toEqual(["localAi"]);
  });

  it("waits for the Local AI page before the row, so a Settings that opened elsewhere says where", () => {
    const opened = DRIVER.indexOf(driverOpenExpression());
    const page = DRIVER.indexOf('waitFor("Settings -> Local AI"');
    const row = DRIVER.indexOf("waitFor(\"Settings -> Local AI's memory-model download\"");
    expect(opened).toBeGreaterThan(0);
    expect(page).toBeGreaterThan(opened);
    expect(row).toBeGreaterThan(page);
    expect(DRIVER).toContain("Settings -> Local AI did not open within 30 s");
  });

  it("puts the owner's saved desktop back after the browser has re-saved it, also when the run is cut short", () => {
    const read = BOARD_SCRIPT.indexOf("DESKTOP_BEFORE=$(call GET /setup-api/desktop/state)");
    const trap = BOARD_SCRIPT.indexOf(`trap 'put_desktop_back "at exit"; hand_memory_back; switch_back' EXIT`);
    const driverRun = BOARD_SCRIPT.indexOf('node "$DRIVER"');
    const inline = BOARD_SCRIPT.indexOf("\nput_desktop_back\n", driverRun);
    expect(read).toBeGreaterThan(0);
    // Armed before the browser runs, and the last trap set before it: one set
    // later would replace it.
    expect(trap).toBeGreaterThan(read);
    expect(driverRun).toBeGreaterThan(trap);
    expect(BOARD_SCRIPT.slice(trap + 1, driverRun)).not.toMatch(/^\s*trap /m);
    expect(BOARD_SCRIPT.slice(driverRun)).not.toMatch(/^\s*trap /m);
    // And at the end of a run that was not cut short, so its line comes in order.
    expect(inline).toBeGreaterThan(0);
  });
});

// The put-back itself, run in bash against a stand-in for the box: the
// function as the board script defines it, with `call` answering the PUT from
// a script of status codes and `sleep` made instant.
const canRunBash = process.platform === "linux" && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/** The board script's own `put_desktop_back` definition, cut out verbatim so the test runs the real function. */
function putBackFunction(): string {
  const match = /\nput_desktop_back\(\) \{\n[\s\S]*?\n\}\n/.exec(BOARD_SCRIPT);
  if (!match) throw new Error("the board script no longer defines put_desktop_back");
  return match[0];
}

/** Runs the end-of-run put-back, then the EXIT trap's, with the box answering `answers` in turn. */
function runPutBack(answers: number[]): { lines: string[]; puts: string[]; armed: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-put-back-"));
  try {
    const script = [
      "set -uo pipefail",
      `ANSWERS=(${answers.join(" ")})`,
      `COUNT=${JSON.stringify(path.join(dir, "count"))}; echo 0 > "$COUNT"`,
      `PUTS=${JSON.stringify(path.join(dir, "puts"))}; : > "$PUTS"`,
      `say() { printf 'RESULT %s\\n' "$*"; }`,
      `status_of() { printf '%s\\n' "$1" | head -n1; }`,
      `body_of() { printf '%s\\n' "$1" | tail -n +2; }`,
      "sleep() { :; }",
      // Runs in the $(...) of its caller, so the count lives in a file.
      `call() { local n; n=$(cat "$COUNT"); echo $((n + 1)) > "$COUNT"; printf '%s %s %s\\n' "$1" "$2" "$3" >> "$PUTS"; printf '%s\\n{"code":"stub"}\\n' "\${ANSWERS[$n]:-500}"; }`,
      `DESKTOP_SAVED='{"state":{"v":1,"savedAt":1,"windows":[],"focusedId":null}}'`,
      putBackFunction(),
      "put_desktop_back",
      `echo "ARMED \${DESKTOP_SAVED:+yes}"`,
      `put_desktop_back "at exit"`,
      `echo "ARMED \${DESKTOP_SAVED:+yes}"`,
    ].join("\n");
    const run = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    if (run.status !== 0) throw new Error(`bash exited ${run.status}: ${run.stderr}`);
    const out = run.stdout.split("\n").filter(Boolean);
    return {
      lines: out.filter((l) => l.startsWith("RESULT ")),
      puts: fs.readFileSync(path.join(dir, "puts"), "utf8").split("\n").filter(Boolean),
      armed: out.filter((l) => l.startsWith("ARMED")).map((l) => l.slice("ARMED".length).trim()),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRunBash)("nano tests 66/99: putting the owner's desktop back (TASK-2379)", () => {
  it("puts it back once and disarms when the box takes it", () => {
    const run = runPutBack([200]);
    expect(run.puts).toEqual([`PUT /setup-api/desktop/state {"state":{"v":1,"savedAt":1,"windows":[],"focusedId":null}}`]);
    expect(run.lines).toEqual(["RESULT ok - the owner's saved desktop is put back as it was found"]);
    // The EXIT trap's call finds nothing left to do.
    expect(run.armed).toEqual(["", ""]);
  });

  it("tries again, at most three times, before it says anything", () => {
    const run = runPutBack([503, 500, 200]);
    expect(run.puts).toHaveLength(3);
    expect(run.lines).toEqual(["RESULT ok - the owner's saved desktop is put back as it was found"]);
    expect(run.armed).toEqual(["", ""]);
  });

  it("stays armed after three refusals, so the EXIT trap tries once more", () => {
    const run = runPutBack([500, 500, 500, 500, 200]);
    expect(run.puts).toHaveLength(5);
    expect(run.lines).toEqual([
      `RESULT not ok - putting the owner's saved desktop back answered 500 three times: {"code":"stub"}`,
      "RESULT ok - the owner's saved desktop is put back as it was found (at exit)",
    ]);
    expect(run.armed).toEqual(["yes", ""]);
  });

  it("says so at exit too when the box never takes it", () => {
    const run = runPutBack([]);
    expect(run.puts).toHaveLength(6);
    expect(run.lines).toEqual([
      `RESULT not ok - putting the owner's saved desktop back answered 500 three times: {"code":"stub"}`,
      `RESULT not ok - putting the owner's saved desktop back (at exit) answered 500 three times: {"code":"stub"}`,
    ]);
    expect(run.armed).toEqual(["yes", "yes"]);
  });
});
