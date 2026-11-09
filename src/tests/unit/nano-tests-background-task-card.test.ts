import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { dispatchOpenSettingsSection, OPEN_APP_EVENT, OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";

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

  it("puts the owner's saved desktop back after the browser has re-saved it", () => {
    const read = BOARD_SCRIPT.indexOf("call GET /setup-api/desktop/state");
    const driverRun = BOARD_SCRIPT.indexOf('node "$DRIVER"');
    const putBack = BOARD_SCRIPT.lastIndexOf("put_desktop_back");
    expect(read).toBeGreaterThan(0);
    expect(driverRun).toBeGreaterThan(read);
    expect(putBack).toBeGreaterThan(driverRun);
    expect(BOARD_SCRIPT).toContain('call PUT /setup-api/desktop/state "$DESKTOP_SAVED"');
  });
});
