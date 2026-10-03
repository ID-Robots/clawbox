import fs from "fs";
import path from "path";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import MonitorsPanel, { recommendedScale } from "@/components/MonitorsPanel";
import { MONITORS_CHANGED_EVENT, MONITORS_IDENTIFY_EVENT, setDeskScreens, type DeskScreen } from "@/lib/desktop-screens";
import {
  distinctModes,
  logicalSize,
  parseWlrRandr,
  type MonitorLayout,
  type MonitorOutput,
} from "@/lib/monitors-layout";
import type { MonitorStatus, MonitorView } from "@/lib/monitors";
import { translations } from "@/lib/translations";

/**
 * Settings → Monitors (monitor mode). The panel is driven against a fake
 * `/setup-api/monitors` built from the REAL `wlr-randr` text of the test
 * machine (two AOC Q27B3MA side by side, the built-in panel off), and every
 * string is read from the REAL catalogue, so a key the panel uses and the
 * catalogue lacks shows up as a raw key and fails the assertion.
 */

// The desktop's language, switched per test (English unless a test says so).
const i18n = vi.hoisted(() => ({ locale: "en" }));

// A STABLE `t`: the panel's `load` is a useCallback on `t`, and its first
// effect runs on every change of `load` — a `t` rebuilt per render would make
// the panel fetch in a loop. The real provider's `t` is stable too; it reads
// the language at call time, like the provider's table swap.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { translations: table } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) => {
    let s = table[i18n.locale as "en"]?.[key] ?? table.en[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  return {
    ...actual,
    useT: () => ({ t, locale: i18n.locale, localeResolved: true, setLocale: () => {} }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const en = translations.en;
const tx = (key: string) => {
  const s = en[key];
  if (!s) throw new Error(`catalogue has no ${key}`);
  return s;
};

// ── The box, from the real compositor text ──────────────────────────────────

// jsdom gives `import.meta.url` an http: scheme, so the path is built from __dirname.
const SAMPLE = fs.readFileSync(path.resolve(__dirname, "../fixtures/monitors/wlr-randr-two-external.txt"), "utf8");

/** What the server's `toView` makes of an output (src/lib/monitors.ts). */
function view(o: MonitorOutput): MonitorView {
  const size = o.enabled && o.current ? logicalSize(o.current.width, o.current.height, o.scale, o.transform) : null;
  return {
    id: o.id,
    name: o.name,
    label: [o.make, o.model].filter((s) => s && s !== "Unknown").join(" ") || o.description || o.name,
    builtIn: o.builtIn,
    enabled: o.enabled,
    modes: distinctModes(o.modes),
    current: o.current,
    scale: o.scale,
    transform: o.transform,
    rect: size && o.position ? { x: o.position.x, y: o.position.y, ...size } : null,
    physicalSize: o.physicalSize,
    adaptiveSync: o.adaptiveSync ?? null,
  };
}

const OUTPUTS = parseWlrRandr(SAMPLE);
const byName = (name: string) => {
  const o = OUTPUTS.find((x) => x.name === name);
  if (!o) throw new Error(`fixture has no ${name}`);
  return o;
};
const LEFT = byName("HDMI-A-1"); // Position 0,0
const RIGHT = byName("DP-2"); // Position 2560,0
const BUILT_IN = byName("eDP-1"); // Enabled: no

/** Two monitors on, side by side, the built-in panel off; the left one is main. */
function deskStatus(over: Partial<MonitorStatus> = {}): MonitorStatus {
  return {
    available: true,
    monitors: [view(RIGHT), view(LEFT), view(BUILT_IN)],
    order: [LEFT.id, RIGHT.id, BUILT_IN.id],
    main: LEFT.id,
    box: { width: 5120, height: 1440 },
    pending: null,
    mirror: false,
    ...over,
  };
}

/** Only the two external monitors (no built-in panel at all). */
function twoStatus(over: Partial<MonitorStatus> = {}): MonitorStatus {
  return deskStatus({ monitors: [view(RIGHT), view(LEFT)], order: [LEFT.id, RIGHT.id], ...over });
}

const UNAVAILABLE: MonitorStatus = { available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false };

/** What the box shows after `layout` lands: its order, main and modes. */
function statusAfter(before: MonitorStatus, layout: MonitorLayout, deadline: number | null): MonitorStatus {
  const monitors = before.monitors.map((m) => {
    const s = layout.monitors[m.id];
    if (!s) return m;
    return { ...m, enabled: s.enabled, current: s.enabled ? { width: s.width, height: s.height, refresh: s.refresh } : null, scale: s.scale, transform: s.transform };
  });
  return { ...before, monitors, order: [...layout.order], main: layout.main, mirror: layout.mirror === true, pending: deadline ? { deadline } : null };
}

// ── A fake /setup-api/monitors ──────────────────────────────────────────────

type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
type Call = { url: string; method: string; body: unknown };

interface FakeBox {
  status: MonitorStatus;
  /** Answers the GET; defaults to `status`. */
  get?: () => Answer;
  /** Answers a POST; defaults to the box's own behaviour (trial / keep / revert). */
  post?: (body: { action: string; layout?: MonitorLayout }) => Answer;
  brightness: Answer;
  brightnessPost?: (body: unknown) => Answer;
  calls: Call[];
  kept: MonitorStatus | null;
  /**
   * The box's clock minus this browser's (ms). Set, every answer carries the
   * box's time in a `Date` header, as Node's server does; unset, no header.
   */
  skew?: number;
}

let box: FakeBox;

/** The box's own clock. */
const boxNow = () => Date.now() + (box.skew ?? 0);

function respond(a: { status: number; body: unknown }) {
  const date = box.skew === undefined ? null : new Date(boxNow()).toUTCString();
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    headers: { get: (name: string) => (name.toLowerCase() === "date" ? date : null) },
    json: async () => a.body,
  };
}

function installBox(status: MonitorStatus) {
  box = {
    status,
    brightness: { status: 409, body: { error: "no DDC", code: "unsupported" } },
    calls: [],
    kept: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      box.calls.push({ url, method, body });
      if (url === "/setup-api/monitors/brightness") {
        if (method === "POST") return respond(await (box.brightnessPost?.(body) ?? { status: 200, body: { ok: true } }));
        return respond(await box.brightness);
      }
      if (url === "/setup-api/monitors" && method === "GET") {
        return respond(await (box.get?.() ?? { status: 200, body: box.status }));
      }
      if (url === "/setup-api/monitors" && method === "POST") {
        if (box.post) return respond(await box.post(body));
        if (body.action === "apply") {
          box.kept = box.kept ?? box.status;
          box.status = statusAfter(box.status, body.layout, boxNow() + 20_000);
          return respond({ status: 200, body: box.status });
        }
        if (body.action === "keep") {
          box.status = { ...box.status, pending: null };
          box.kept = null;
          return respond({ status: 200, body: box.status });
        }
        if (body.action === "revert") {
          box.status = { ...(box.kept ?? box.status), pending: null };
          box.kept = null;
          return respond({ status: 200, body: box.status });
        }
      }
      return respond({ status: 404, body: { error: "not found" } });
    }),
  );
}

const monitorCalls = (method?: string) =>
  box.calls.filter((c) => c.url === "/setup-api/monitors" && (!method || c.method === method));
const lastPost = () => monitorCalls("POST").at(-1)?.body as { action: string; layout?: MonitorLayout } | undefined;

// ── Reading the panel ───────────────────────────────────────────────────────

/** Let the fake fetch's promises and React's effects settle (real or fake timers). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function mountPanel() {
  render(<MonitorsPanel />);
  return screen.findByTestId("monitors-panel");
}

/** The ids of the blocks in the row, left to right. */
function rowIds(): string[] {
  const canvas = screen.getByTestId("monitors-canvas");
  return [...canvas.querySelectorAll<HTMLElement>("[data-monitor-id]")]
    .sort((a, b) => a.dataset.testid!.localeCompare(b.dataset.testid!))
    .map((b) => b.dataset.monitorId!);
}

const block = (n: number) => screen.getByTestId(`monitors-block-${n}`);
const detail = () => within(screen.getByTestId("monitors-detail"));
const applyButton = () => screen.getByTestId("monitors-apply") as HTMLButtonElement;
const select = (id: string) => screen.getByTestId(id) as HTMLSelectElement;
const optionValues = (id: string) => [...select(id).options].map((o) => o.value);
const port = (name: string) => tx("settings.monitors.port").replace("{port}", name);
/** The exact rate (as wlr-randr printed it, e.g. 74.968002) of `o` at w×h nearest `approx`. */
function hz(o: MonitorOutput, w: number, h: number, approx: number): number {
  const rates = distinctModes(o.modes).filter((m) => m.width === w && m.height === h).map((m) => m.refresh);
  const best = rates.reduce((a, b) => (Math.abs(b - approx) < Math.abs(a - approx) ? b : a), rates[0]);
  if (best === undefined || Math.abs(best - approx) > 0.01) throw new Error(`${o.name} has no ${w}x${h} @ ${approx}`);
  return best;
}

beforeEach(() => {
  installBox(deskStatus());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setDeskScreens(null);
  i18n.locale = "en";
});

/** The route's refusal codes and the catalogue keys that word them. */
const ERROR_KEY: Record<string, string> = {
  none_enabled: "settings.monitors.error.noneEnabled",
  main_disabled: "settings.monitors.error.mainDisabled",
  unknown_mode: "settings.monitors.error.unknownMode",
  unknown_monitor: "settings.monitors.error.unknownMonitor",
  unavailable: "settings.monitors.error.unavailable",
  apply_failed: "settings.monitors.error.applyFailed",
  save_failed: "settings.monitors.error.saveFailed",
  write_failed: "settings.monitors.error.writeFailed",
  unsupported: "settings.monitors.error.unsupported",
  invalid_value: "settings.monitors.error.invalidValue",
};

/** The desktop spread over the two external monitors, as `useMonitorLayoutSync` would set it. */
const SPREAD: DeskScreen[] = [
  { id: LEFT.id, label: "AOC Q27B3MA", x: 0, y: 0, width: 2560, height: 1440, main: true },
  { id: RIGHT.id, label: "AOC Q27B3MA", x: 2560, y: 0, width: 2560, height: 1440, main: false },
];

// ── The tests ───────────────────────────────────────────────────────────────

describe("MonitorsPanel — loading and a box without monitors", () => {
  it("says it is reading the monitors, then that there are none to arrange", async () => {
    let answer!: (a: { status: number; body: unknown }) => void;
    box.get = () => new Promise((resolve) => { answer = resolve; });
    render(<MonitorsPanel />);

    expect(screen.getByTestId("monitors-loading")).toHaveTextContent(tx("settings.monitors.loading"));
    expect(screen.queryByTestId("monitors-panel")).toBeNull();

    await act(async () => answer({ status: 200, body: UNAVAILABLE }));

    expect(await screen.findByTestId("monitors-unavailable")).toHaveTextContent(tx("settings.monitors.unavailable"));
    expect(screen.queryByTestId("monitors-loading")).toBeNull();
    expect(screen.queryByTestId("monitors-panel")).toBeNull();
    // A box without a monitor session never asks a monitor for its brightness.
    expect(box.calls.some((c) => c.url.includes("brightness"))).toBe(false);
  });

  // A read that FAILED is not a box without monitors: saying "there are no
  // monitors" to the owner of a box that has them, with no way to ask again,
  // was the old answer.
  it("a request that fails outright says the monitors cannot be reached, and Try again asks again", async () => {
    let down = true;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      if (down) throw new TypeError("Failed to fetch");
      return (real as typeof fetch)(input as RequestInfo, init);
    }));
    render(<MonitorsPanel />);

    const failed = await screen.findByTestId("monitors-load-error");
    expect(within(failed).getByRole("alert")).toHaveTextContent(tx("settings.monitors.error.unavailable"));
    expect(screen.queryByTestId("monitors-unavailable")).toBeNull();

    down = false;
    expect(screen.getByTestId("monitors-retry")).toHaveTextContent(tx("settings.monitors.retry"));
    fireEvent.click(screen.getByTestId("monitors-retry"));
    expect(await screen.findByTestId("monitors-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("monitors-load-error")).toBeNull();
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });

  it.each([
    ["a session that ran out (401)", { status: 401, body: { error: "Authentication required" } }],
    ["a refusal (403)", { status: 403, body: { error: "Owner only", code: "owner_only" } }],
    ["a server error that is not JSON (500)", { status: 500, body: "<html>" }],
    ["a 200 that is not a status", { status: 200, body: { error: "x" } }],
  ])("%s is a failed read with Try again, never 'no monitors' and never a crash", async (_what, answer) => {
    box.get = () => answer;
    render(<MonitorsPanel />);
    expect(await screen.findByTestId("monitors-load-error")).toHaveTextContent(tx("settings.monitors.error.unavailable"));
    expect(screen.queryByTestId("monitors-unavailable")).toBeNull();
    expect(screen.queryByTestId("monitors-canvas")).toBeNull();
  });

  it("a look that fails once the monitors are drawn keeps them, and says nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    render(<MonitorsPanel />);
    await flush();
    expect(screen.getByTestId("monitors-panel")).toBeInTheDocument();
    box.get = () => ({ status: 503, body: "gateway" });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(monitorCalls("GET").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("monitors-panel")).toBeInTheDocument();
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(screen.queryByTestId("monitors-error")).toBeNull();
  });
});

describe("MonitorsPanel — the row", () => {
  it("draws the monitors that are on as numbered blocks, left to right, with the main chip on the main one", async () => {
    await mountPanel();

    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(screen.queryByTestId("monitors-block-3")).toBeNull();

    const one = block(1);
    const two = block(2);
    expect(within(one).getByText("1")).toBeInTheDocument();
    expect(within(two).getByText("2")).toBeInTheDocument();
    expect(one).toHaveTextContent("AOC Q27B3MA");
    expect(one).toHaveTextContent("HDMI-A-1 · 2560×1440");
    expect(two).toHaveTextContent("DP-2 · 2560×1440");

    const main = tx("settings.monitors.main");
    expect(within(one).getByText(main)).toBeInTheDocument();
    expect(within(two).queryByText(main)).toBeNull();
    expect(one.getAttribute("aria-label")).toBe(`1 · AOC Q27B3MA · HDMI-A-1 · ${main}`);
    expect(two.getAttribute("aria-label")).toBe("2 · AOC Q27B3MA · DP-2");

    // The built-in panel is off: it is listed under "Turned off", in the
    // owner's words rather than its model code.
    const off = screen.getByTestId("monitors-off");
    expect(off).toHaveTextContent(tx("settings.monitors.offList"));
    expect(off).toHaveTextContent(`${tx("settings.monitors.builtIn")} · eDP-1 · ${tx("settings.monitors.off")}`);

    // Nothing changed yet: Apply is not offered, Undo is not drawn.
    expect(applyButton()).toBeDisabled();
    expect(screen.queryByTestId("monitors-undo")).toBeNull();
  });

  it("opens with the main monitor selected and shows a selected block's own settings", async () => {
    await mountPanel();

    expect(block(1)).toHaveAttribute("aria-pressed", "true");
    expect(block(2)).toHaveAttribute("aria-pressed", "false");
    expect(detail().getByText(port("HDMI-A-1"))).toBeInTheDocument();
    expect(detail().getByText(tx("settings.monitors.isMain"))).toBeInTheDocument();
    expect(screen.queryByTestId("monitors-make-main")).toBeNull();

    fireEvent.click(block(2));

    expect(block(2)).toHaveAttribute("aria-pressed", "true");
    expect(block(1)).toHaveAttribute("aria-pressed", "false");
    expect(detail().getByText(port("DP-2"))).toBeInTheDocument();
    expect(select("monitors-resolution").value).toBe("2560x1440");
    expect(select("monitors-refresh").value).toBe("59.951");
    expect(select("monitors-scale").value).toBe("1");
    expect(select("monitors-rotation").value).toBe("normal");
    expect(screen.getByTestId("monitors-make-main")).toHaveTextContent(tx("settings.monitors.makeMain"));
    // wlr-randr said "Adaptive Sync: disabled", so the switch is there, off.
    expect(screen.getByTestId("monitors-adaptive-sync")).not.toBeChecked();
    // No DDC answer: no brightness slider.
    expect(screen.queryByTestId("monitors-brightness")).toBeNull();

    // A monitor in the "Turned off" list can be selected too.
    fireEvent.click(within(screen.getByTestId("monitors-off")).getByRole("button"));
    expect(detail().getByText(port("eDP-1"))).toBeInTheDocument();
    expect(detail().getByText(tx("settings.monitors.builtIn"))).toBeInTheDocument();
    expect(screen.getByTestId("monitors-enabled")).not.toBeChecked();
    expect(screen.queryByTestId("monitors-resolution")).toBeNull();
  });

  it("offers the 'recommended' resolution and scale for the selected monitor", async () => {
    await mountPanel();
    const resolution = select("monitors-resolution");
    const preferred = [...resolution.options].find((o) => o.value === "2560x1440");
    expect(preferred?.textContent).toBe(tx("settings.monitors.recommended").replace("{size}", "2560 × 1440"));
    // 2560 px over 600 mm is ~108 dpi: 100 % is the recommended scale.
    const hundred = [...select("monitors-scale").options].find((o) => o.value === "1");
    expect(hundred?.textContent).toBe(tx("settings.monitors.recommended").replace("{size}", "100%"));
  });

  it("Make main moves the chip and makes the layout dirty", async () => {
    await mountPanel();
    fireEvent.click(block(2));
    fireEvent.click(screen.getByTestId("monitors-make-main"));

    expect(within(block(2)).getByText(tx("settings.monitors.main"))).toBeInTheDocument();
    expect(within(block(1)).queryByText(tx("settings.monitors.main"))).toBeNull();
    expect(detail().getByText(tx("settings.monitors.isMain"))).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });
});

describe("MonitorsPanel — moving a monitor", () => {
  it("Move right / Move left reorder the row; Apply is offered and Undo puts it back", async () => {
    await mountPanel();
    expect(applyButton()).toBeDisabled();

    // The left monitor (selected: it is main) cannot go further left.
    expect(screen.getByTestId("monitors-move-left")).toBeDisabled();
    expect(screen.getByTestId("monitors-move-left")).toHaveAccessibleName(tx("settings.monitors.moveLeft"));
    fireEvent.click(screen.getByTestId("monitors-move-right"));

    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    // The moved monitor keeps its main chip; the numbers follow the position.
    expect(block(2)).toHaveAttribute("data-monitor-id", LEFT.id);
    expect(within(block(2)).getByText(tx("settings.monitors.main"))).toBeInTheDocument();
    expect(screen.getByTestId("monitors-move-right")).toBeDisabled();
    expect(applyButton()).toBeEnabled();

    fireEvent.click(screen.getByTestId("monitors-move-left"));
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    // Back where it started: nothing to apply.
    expect(applyButton()).toBeDisabled();

    fireEvent.click(screen.getByTestId("monitors-move-right"));
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    const undo = screen.getByTestId("monitors-undo");
    expect(undo).toHaveTextContent(tx("settings.monitors.undo"));
    fireEvent.click(undo);

    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(applyButton()).toBeDisabled();
    expect(screen.queryByTestId("monitors-undo")).toBeNull();
    // Nothing was written.
    expect(monitorCalls("POST")).toHaveLength(0);
  });

  it("the arrow keys on a block move it too", async () => {
    await mountPanel();
    fireEvent.keyDown(block(2), { key: "ArrowLeft" });
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    fireEvent.keyDown(block(1), { key: "ArrowLeft" }); // already leftmost
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    fireEvent.keyDown(block(1), { key: "ArrowRight" });
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });

  it("the monitors that are off stay after the row in the order Apply sends", async () => {
    await mountPanel();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await waitFor(() => expect(lastPost()?.action).toBe("apply"));
    expect(lastPost()?.layout?.order).toEqual([RIGHT.id, LEFT.id, BUILT_IN.id]);
  });
});

describe("MonitorsPanel — turning a monitor off", () => {
  it("removes it from the row and moves main to a monitor that is still on", async () => {
    installBox(twoStatus());
    await mountPanel();
    expect(screen.getByTestId("monitors-mirror")).toBeInTheDocument();

    // The main monitor is selected; turn it off.
    fireEvent.click(screen.getByTestId("monitors-enabled"));

    expect(rowIds()).toEqual([RIGHT.id]);
    expect(screen.queryByTestId("monitors-block-2")).toBeNull();
    expect(within(block(1)).getByText(tx("settings.monitors.main"))).toBeInTheDocument();
    expect(block(1)).toHaveAttribute("data-monitor-id", RIGHT.id);

    const off = screen.getByTestId("monitors-off");
    expect(off).toHaveTextContent(`AOC Q27B3MA · HDMI-A-1 · ${tx("settings.monitors.off")}`);
    // Still selected, now in the off list, with only the on/off switch left.
    expect(within(off).getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("monitors-enabled")).not.toBeChecked();
    expect(screen.queryByTestId("monitors-resolution")).toBeNull();
    expect(screen.queryByTestId("monitors-move-left")).toBeNull();
    // One monitor left on: nothing to mirror.
    expect(screen.queryByTestId("monitors-mirror")).toBeNull();

    fireEvent.click(applyButton());
    await waitFor(() => expect(lastPost()?.action).toBe("apply"));
    const layout = lastPost()!.layout!;
    expect(layout.main).toBe(RIGHT.id);
    expect(layout.monitors[LEFT.id].enabled).toBe(false);
    expect(layout.monitors[RIGHT.id].enabled).toBe(true);
    // The monitor turned off may keep its slot in `order`; the row the box
    // builds is the monitors that are ON, in order.
    expect(layout.order.filter((id) => layout.monitors[id].enabled)).toEqual([RIGHT.id]);
    expect([...layout.order].sort()).toEqual([LEFT.id, RIGHT.id].sort());
  });

  it("turning a monitor that is NOT main off leaves main alone, and turning it on again puts it back in the row", async () => {
    installBox(twoStatus());
    await mountPanel();
    fireEvent.click(block(2));
    fireEvent.click(screen.getByTestId("monitors-enabled"));
    expect(rowIds()).toEqual([LEFT.id]);
    expect(within(block(1)).getByText(tx("settings.monitors.main"))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("monitors-enabled"));
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(applyButton()).toBeDisabled();
  });
});

describe("MonitorsPanel — resolution and refresh", () => {
  /** Every (size, refresh) the panel can send must be one the monitor offers. */
  const offered = (o: MonitorOutput, w: number, h: number, r: number) =>
    distinctModes(o.modes).some((m) => m.width === w && m.height === h && m.refresh === r);

  it("a new resolution brings a refresh rate that monitor offers at that size", async () => {
    await mountPanel();

    fireEvent.change(select("monitors-resolution"), { target: { value: "1920x1080" } });
    expect(select("monitors-resolution").value).toBe("1920x1080");
    const rate = Number(select("monitors-refresh").value);
    expect(offered(LEFT, 1920, 1080, rate)).toBe(true);
    expect(Math.abs(rate - 59.951)).toBeLessThan(0.5);
    // The refresh list is the new size's own rates, nothing else.
    expect(optionValues("monitors-refresh")).toEqual(
      distinctModes(LEFT.modes).filter((m) => m.width === 1920 && m.height === 1080).map((m) => String(m.refresh)),
    );
    expect(block(1)).toHaveTextContent("1920×1080");
  });

  it("keeps a high refresh rate where the new size has it, and falls back to one it has where it does not", async () => {
    await mountPanel();
    const high = String(hz(LEFT, 2560, 1440, 74.968));
    fireEvent.change(select("monitors-refresh"), { target: { value: high } });
    expect(select("monitors-refresh").value).toBe(high);

    fireEvent.change(select("monitors-resolution"), { target: { value: "1920x1080" } });
    expect(select("monitors-refresh").value).toBe(String(hz(LEFT, 1920, 1080, 74.973)));

    // 1440×900 has 59.901 Hz only.
    fireEvent.change(select("monitors-resolution"), { target: { value: "1440x900" } });
    const only = hz(LEFT, 1440, 900, 59.901);
    expect(select("monitors-refresh").value).toBe(String(only));
    expect(optionValues("monitors-refresh")).toEqual([String(only)]);

    fireEvent.click(applyButton());
    await waitFor(() => expect(lastPost()?.action).toBe("apply"));
    const s = lastPost()!.layout!.monitors[LEFT.id];
    expect({ width: s.width, height: s.height, refresh: s.refresh }).toEqual({ width: 1440, height: 900, refresh: only });
    expect(offered(LEFT, s.width, s.height, s.refresh)).toBe(true);
  });

  // `modeAt` used to take the FIRST rate within 0.5 Hz in the server's order
  // (refresh descending): 60.000 Hz (0.049 away) over 59.940 Hz (0.011 away).
  it("picks the CLOSEST rate the new size offers (59.94 Hz for 59.951 Hz)", async () => {
    await mountPanel();
    fireEvent.change(select("monitors-resolution"), { target: { value: "1920x1080" } });
    // Guard: the panel really did move to 1080p, so a failure below is the
    // rate choice and nothing else.
    expect(select("monitors-resolution").value).toBe("1920x1080");
    expect(optionValues("monitors-refresh")).toContain(String(hz(LEFT, 1920, 1080, 59.94)));
    expect(select("monitors-refresh").value).toBe(String(hz(LEFT, 1920, 1080, 59.94)));
  });
});

describe("MonitorsPanel — Apply, Keep, Revert", () => {
  it("Apply POSTs the whole layout and shows the keep/revert box; Keep POSTs and says it is saved", async () => {
    const changed = vi.fn();
    window.addEventListener(MONITORS_CHANGED_EVENT, changed);
    try {
      await mountPanel();
      fireEvent.click(screen.getByTestId("monitors-move-right"));
      expect(applyButton()).toHaveTextContent(tx("settings.monitors.apply"));
      fireEvent.click(applyButton());

      const pending = await screen.findByTestId("monitors-pending");
      expect(lastPost()).toEqual({
        action: "apply",
        layout: {
          order: [RIGHT.id, LEFT.id, BUILT_IN.id],
          main: LEFT.id,
          mirror: false,
          monitors: {
            [LEFT.id]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", adaptiveSync: false },
            [RIGHT.id]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", adaptiveSync: false },
            [BUILT_IN.id]: { enabled: false, width: 1920, height: 1080, refresh: hz(BUILT_IN, 1920, 1080, 60.012), scale: 1, transform: "normal" },
          },
        },
      });
      const post = monitorCalls("POST")[0];
      expect(post.method).toBe("POST");

      expect(pending).toHaveAttribute("role", "alertdialog");
      expect(pending).toHaveTextContent(tx("settings.monitors.keepTitle"));
      // The countdown reads the deadline the box sent (19 once a real second
      // has passed; the fake-clock tests below pin the first frame at 20).
      await waitFor(() =>
        expect(within(pending).getByText(/\d+ s/).textContent).toMatch(
          new RegExp(`^${tx("settings.monitors.keepBody").replace("{seconds}", "(19|20)").replace(/[.]/g, "\\.")}$`),
        ),
      );
      // The applied layout is what the box shows now: nothing left to apply.
      expect(applyButton()).toBeDisabled();
      expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
      expect(changed).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("monitors-keep"));
      await waitFor(() => expect(screen.queryByTestId("monitors-pending")).toBeNull());
      expect(lastPost()).toEqual({ action: "keep" });
      expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.kept"));
      expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(MONITORS_CHANGED_EVENT, changed);
    }
  });

  it("Revert POSTs and says the previous settings are back", async () => {
    await mountPanel();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await screen.findByTestId("monitors-pending");

    fireEvent.click(screen.getByTestId("monitors-revert"));
    await waitFor(() => expect(screen.queryByTestId("monitors-pending")).toBeNull());
    expect(lastPost()).toEqual({ action: "revert" });
    expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.reverted"));
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(screen.queryByTestId("monitors-error")).toBeNull();
  });

  // Apply sits at the foot of a panel taller than the Settings window, and
  // the Keep box appears at its head: unmoved, the owner was left looking at a
  // disabled Apply while the trial ran out out of sight.
  it("after Apply, the Keep box is scrolled into view and Keep has the focus", async () => {
    const scrolled = vi.fn();
    const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = function (this: Element) { scrolled(this); } as Element["scrollIntoView"];
    try {
      await mountPanel();
      fireEvent.click(screen.getByTestId("monitors-move-right"));
      applyButton().focus();
      fireEvent.click(applyButton());
      const pending = await screen.findByTestId("monitors-pending");

      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("monitors-keep")));
      expect(scrolled).toHaveBeenCalledWith(pending);
    } finally {
      if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("a layout already on trial when the panel opens does not take the focus", async () => {
    installBox(deskStatus({ pending: { deadline: Date.now() + 12_000 } }));
    await mountPanel();
    expect(document.activeElement).not.toBe(screen.getByTestId("monitors-keep"));
  });

  it("a layout already on trial when the panel opens shows the keep/revert box straight away", async () => {
    installBox(deskStatus({ pending: { deadline: Date.now() + 12_000 } }));
    await mountPanel();
    expect(screen.getByTestId("monitors-pending")).toBeInTheDocument();
    expect(screen.getByTestId("monitors-keep")).toBeEnabled();
  });
});

describe("MonitorsPanel — the trial's countdown (fake clock)", () => {
  const T0 = new Date("2026-10-02T12:00:00Z").getTime();

  /** Let the fake fetch's promises and React's effects settle. */
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }
  const keepBody = (s: number) => tx("settings.monitors.keepBody").replace("{seconds}", String(s));

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  it("counts down from pending.deadline and, at zero, reads the box again and says the old settings are back", async () => {
    render(<MonitorsPanel />);
    await settle();
    expect(screen.getByTestId("monitors-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await settle();

    const pending = screen.getByTestId("monitors-pending");
    expect(pending).toHaveTextContent(keepBody(20));
    await advance(5_000);
    expect(pending).toHaveTextContent(keepBody(15));
    await advance(14_000);
    expect(pending).toHaveTextContent(keepBody(1));

    // The server undid the trial on its own at the deadline.
    box.status = { ...(box.kept ?? box.status), pending: null };
    const getsBefore = monitorCalls("GET").length;
    await advance(1_000);
    expect(screen.getByTestId("monitors-pending")).toHaveTextContent(keepBody(0));
    await advance(700);

    expect(monitorCalls("GET").length).toBe(getsBefore + 1);
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.reverted"));
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });

  it("an idle panel looks again every 5 s; one with unsaved changes does not", async () => {
    render(<MonitorsPanel />);
    await settle();
    expect(monitorCalls("GET")).toHaveLength(1);
    await advance(5_000);
    expect(monitorCalls("GET")).toHaveLength(2);
    await advance(5_000);
    expect(monitorCalls("GET")).toHaveLength(3);

    fireEvent.click(screen.getByTestId("monitors-move-right"));
    await advance(30_000);
    expect(monitorCalls("GET")).toHaveLength(3);
    // ...and the owner's change survived.
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
  });

  // The idle look every 5 s almost always brings back the monitors the panel
  // already shows. It used to replace the status, the draft and the baseline
  // with new objects all the same, and re-draw the whole panel for nothing.
  it("a look that brings back the same monitors draws nothing; one that brings back a change lands", async () => {
    // A fresh object per answer, as a JSON body is: only equal CONTENTS are the same.
    box.get = () => ({ status: 200, body: structuredClone(box.status) });
    const commits = vi.fn();
    render(<Profiler id="monitors" onRender={commits}><MonitorsPanel /></Profiler>);
    await settle();
    expect(screen.getByTestId("monitors-panel")).toBeInTheDocument();
    // React may call a component once more after an update before it bails
    // out of a same-state one (its documented caveat), so the count is taken
    // after the first look; from there an identical answer commits nothing.
    await advance(5_000);
    const drawn = commits.mock.calls.length;

    await advance(5_000);
    await advance(5_000);
    await advance(5_000);
    expect(monitorCalls("GET")).toHaveLength(5);
    expect(commits.mock.calls.length).toBe(drawn);
    expect(applyButton()).toBeDisabled();

    // Changed from another screen: the main monitor is now the right one.
    box.status = deskStatus({ main: RIGHT.id });
    await advance(5_000);
    expect(commits.mock.calls.length).toBeGreaterThan(drawn);
    expect(within(block(2)).getByText(tx("settings.monitors.main"))).toBeInTheDocument();
    expect(within(block(1)).queryByText(tx("settings.monitors.main"))).toBeNull();
    // It is what the box shows, not an edit: nothing to apply.
    expect(applyButton()).toBeDisabled();
  });

  it("a selection the owner made survives a look that brings back the same monitors", async () => {
    box.get = () => ({ status: 200, body: structuredClone(box.status) });
    render(<MonitorsPanel />);
    await settle();
    fireEvent.click(block(2));
    await advance(5_000);
    expect(monitorCalls("GET")).toHaveLength(2);
    expect(block(2)).toHaveAttribute("aria-pressed", "true");
    expect(detail().getByText(port("DP-2"))).toBeInTheDocument();
  });

  it("a box without monitors is asked once and never again", async () => {
    installBox(UNAVAILABLE);
    render(<MonitorsPanel />);
    await settle();
    expect(screen.getByTestId("monitors-unavailable")).toBeInTheDocument();
    await advance(60_000);
    expect(box.calls).toHaveLength(1);
  });

  // `now` used to be refreshed only by the countdown's own 250 ms interval, so
  // the first frame of the keep box counted from when the panel OPENED: open
  // for a minute, it flashed "come back in 80 s" before correcting to 20 s.
  it("the first frame of the keep box already counts from NOW, not from when the panel opened", async () => {
    render(<MonitorsPanel />);
    await settle();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    await advance(60_000);

    fireEvent.click(applyButton());
    await settle();
    expect(screen.getByTestId("monitors-pending")).toHaveTextContent(keepBody(20));
  });

  // The deadline is the BOX's time. A browser whose clock runs ahead of the
  // box's (a laptop on the LAN) used to read "0 s" at once, announce "The
  // previous settings are back" over the layout still on trial, and then sit
  // on that banner for good after the box really reverted.
  it("counts down on the box's clock when this browser's runs 30 s ahead, and says the revert only when it happened", async () => {
    box.skew = -30_000;
    render(<MonitorsPanel />);
    await settle();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await settle();

    const pending = screen.getByTestId("monitors-pending");
    expect(pending.textContent).toMatch(new RegExp(keepBody(20).replace("20", "(19|20)").replace(/[.]/g, "\\.")));
    await advance(5_000);
    expect(screen.getByTestId("monitors-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("monitors-notice")).toBeNull();

    box.status = { ...(box.kept ?? box.status), pending: null };
    await advance(16_000);
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.reverted"));
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });

  it("a box still on trial past this browser's deadline is asked again until it is not; nothing is claimed meanwhile", async () => {
    // A clock 1.5 s ahead: inside the tolerance, so not corrected — the
    // panel reaches zero before the box does.
    box.skew = -1_500;
    render(<MonitorsPanel />);
    await settle();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await settle();

    await advance(20_000);
    const gets = monitorCalls("GET").length;
    // The box has not undone it yet: still pending, still the Keep box.
    await advance(1_000);
    expect(monitorCalls("GET").length).toBeGreaterThan(gets);
    expect(screen.getByTestId("monitors-pending")).toBeInTheDocument();
    expect(screen.getByTestId("monitors-keep")).toBeEnabled();
    expect(screen.queryByTestId("monitors-notice")).toBeNull();

    box.status = { ...(box.kept ?? box.status), pending: null };
    await advance(1_000);
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.reverted"));

    // Over: no more looking every second.
    const after = monitorCalls("GET").length;
    await advance(3_000);
    expect(monitorCalls("GET").length).toBe(after);
  });

  it("a trial Kept in another window ends here as kept, not as reverted", async () => {
    render(<MonitorsPanel />);
    await settle();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await settle();

    // Another window pressed Keep: the trial layout stays.
    box.status = { ...box.status, pending: null };
    box.kept = null;
    await advance(21_000);
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(screen.getByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.kept"));
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
  });
});

describe("MonitorsPanel — refusals", () => {
  it("a refusal code is said in the owner's words from the catalogue; the change stays to try again", async () => {
    await mountPanel();
    box.post = () => ({ status: 400, body: { error: "That monitor layout cannot be applied", code: "main_disabled" } });
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());

    const error = await screen.findByTestId("monitors-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent(tx("settings.monitors.error.mainDisabled"));
    expect(error).not.toHaveTextContent("cannot be applied");
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    expect(applyButton()).toBeEnabled();
    // A refused Apply does not re-read the box: that would throw the draft away.
    expect(monitorCalls("GET")).toHaveLength(1);
  });

  // Every code the routes speak reaches its own sentence through a fixed
  // table (the codes are snake_case, the catalogue's keys camelCase).
  it.each([
    ["none_enabled", 400],
    ["unknown_mode", 400],
    ["unknown_monitor", 400],
    ["unavailable", 503],
    ["apply_failed", 502],
  ])("code %s has its own sentence", async (code, status) => {
    await mountPanel();
    box.post = () => ({ status, body: { error: "x", code } });
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    const sentence = tx(ERROR_KEY[code]);
    expect(sentence).not.toBe(tx("settings.monitors.error.generic"));
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(sentence);
  });

  it("every refusal code the panel words has a sentence in every language, under a camelCase key", () => {
    for (const key of Object.values(ERROR_KEY)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9][a-zA-Z0-9]*)*$/);
      for (const locale of Object.keys(translations) as (keyof typeof translations)[]) {
        expect(translations[locale][key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it("a code the catalogue does not word, no code at all, or a dropped connection fall back to the generic sentence", async () => {
    await mountPanel();
    fireEvent.click(screen.getByTestId("monitors-move-right"));

    box.post = () => ({ status: 400, body: { error: "x", code: "invalid_scale" } });
    fireEvent.click(applyButton());
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.generic"));

    // A code that names something on Object.prototype is still no sentence.
    box.post = () => ({ status: 400, body: { error: "x", code: "constructor" } });
    fireEvent.click(applyButton());
    await waitFor(() => expect(monitorCalls("POST")).toHaveLength(2));
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.generic"));

    box.post = () => ({ status: 500, body: "not json at all" });
    fireEvent.click(applyButton());
    await waitFor(() => expect(monitorCalls("POST")).toHaveLength(3));
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.generic"));

    box.post = () => Promise.reject(new TypeError("Failed to fetch"));
    fireEvent.click(applyButton());
    await waitFor(() => expect(monitorCalls("POST")).toHaveLength(4));
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.generic"));
  });

  async function onTrial() {
    await mountPanel();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await screen.findByTestId("monitors-pending");
  }
  const nothingPending = () => ({ status: 409, body: { error: "There is no change waiting", code: "nothing_pending" } });

  // A Keep that lands after the box's own timer undid the trial used to read
  // "The monitors could not be changed" over a stale banner.
  it("a Keep that came too late says so, and shows the previous settings the box put back", async () => {
    await onTrial();
    box.status = { ...(box.kept ?? box.status), pending: null };
    box.post = nothingPending;
    fireEvent.click(screen.getByTestId("monitors-keep"));

    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.nothingPending"));
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(applyButton()).toBeDisabled();
  });

  it("a Revert that came too late is no failure: the previous settings are back", async () => {
    await onTrial();
    box.status = { ...(box.kept ?? box.status), pending: null };
    box.post = nothingPending;
    fireEvent.click(screen.getByTestId("monitors-revert"));

    expect(await screen.findByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.reverted"));
    expect(screen.queryByTestId("monitors-error")).toBeNull();
    expect(screen.queryByTestId("monitors-pending")).toBeNull();
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });

  it("a Keep another window already made is no failure: the settings are kept", async () => {
    await onTrial();
    box.status = { ...box.status, pending: null };
    box.post = nothingPending;
    fireEvent.click(screen.getByTestId("monitors-keep"));

    expect(await screen.findByTestId("monitors-notice")).toHaveTextContent(tx("settings.monitors.kept"));
    expect(screen.queryByTestId("monitors-error")).toBeNull();
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
  });

  it("a Keep the box could not save is said, and the trial stays to keep again", async () => {
    await onTrial();
    box.post = () => ({ status: 500, body: { error: "The monitor settings could not be saved", code: "save_failed" } });
    fireEvent.click(screen.getByTestId("monitors-keep"));

    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.saveFailed"));
    expect(screen.getByTestId("monitors-pending")).toBeInTheDocument();
    expect(screen.getByTestId("monitors-keep")).toBeEnabled();
  });

  it("a Revert the box will try again follows the box's new deadline", async () => {
    await onTrial();
    const later = Date.now() + 60_000;
    box.post = () => {
      box.status = { ...box.status, pending: { deadline: later } };
      return { status: 502, body: { error: "wlr-randr failed", code: "revert_failed" } };
    };
    fireEvent.click(screen.getByTestId("monitors-revert"));

    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.revertFailed"));
    await waitFor(() => expect(screen.getByTestId("monitors-pending").textContent).toMatch(/\b(59|60) /));
  });
});

describe("MonitorsPanel — Identify, mirror, brightness", () => {
  it("Identify dispatches the clawbox:monitors-identify event and writes nothing", async () => {
    expect(MONITORS_IDENTIFY_EVENT).toBe("clawbox:monitors-identify");
    setDeskScreens(SPREAD);
    const seen = vi.fn();
    window.addEventListener("clawbox:monitors-identify", seen);
    try {
      await mountPanel();
      const button = screen.getByTestId("monitors-identify");
      expect(button).toHaveTextContent(tx("settings.monitors.identify"));
      fireEvent.click(button);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(monitorCalls("POST")).toHaveLength(0);
    } finally {
      window.removeEventListener("clawbox:monitors-identify", seen);
    }
  });

  // Identify only dispatches an event on THIS page, and only the desktop
  // window spread over the monitors listens: anywhere else (a tab on the LAN,
  // /app/settings, one monitor on, a mirror) the button did nothing at all.
  it("Identify is offered only where the desktop is spread over the monitors", async () => {
    await mountPanel();
    expect(screen.queryByTestId("monitors-identify")).toBeNull();

    act(() => setDeskScreens(SPREAD));
    expect(screen.getByTestId("monitors-identify")).toBeEnabled();

    act(() => setDeskScreens(null));
    expect(screen.queryByTestId("monitors-identify")).toBeNull();
  });

  // The overlay used to number the monitors as they stand while the blocks
  // follow the draft: after an unapplied drag the two disagreed exactly when
  // the owner was matching blocks to screens. The event now names the
  // panel's own numbering.
  it("Identify names the blocks' numbering, an unapplied drag and a monitor turned off included", async () => {
    installBox(twoStatus());
    setDeskScreens(SPREAD);
    const seen = vi.fn();
    window.addEventListener(MONITORS_IDENTIFY_EVENT, seen);
    const order = (call: number) => (seen.mock.calls[call][0] as CustomEvent<{ order?: string[] }>).detail?.order;
    try {
      await mountPanel();
      fireEvent.click(screen.getByTestId("monitors-identify"));
      expect(order(0)).toEqual([LEFT.id, RIGHT.id]);

      fireEvent.click(screen.getByTestId("monitors-move-right"));
      expect(block(1)).toHaveAttribute("data-monitor-id", RIGHT.id);
      fireEvent.click(screen.getByTestId("monitors-identify"));
      expect(order(1)).toEqual([RIGHT.id, LEFT.id]);

      // Turned off in the draft: no number (it is still on until Apply).
      fireEvent.click(screen.getByTestId("monitors-enabled"));
      fireEvent.click(screen.getByTestId("monitors-identify"));
      expect(order(2)).toEqual([RIGHT.id]);
      expect(monitorCalls("POST")).toHaveLength(0);
    } finally {
      window.removeEventListener(MONITORS_IDENTIFY_EVENT, seen);
    }
  });

  it("Mirror stacks the monitors, hides the arrows and sends one common resolution", async () => {
    installBox(twoStatus());
    await mountPanel();
    // Give the two monitors different resolutions first.
    fireEvent.change(select("monitors-resolution"), { target: { value: "1920x1080" } });
    fireEvent.click(screen.getByTestId("monitors-mirror"));

    expect(screen.getByTestId("monitors-canvas")).toHaveAttribute("data-mirror", "true");
    expect(screen.getByText(tx("settings.monitors.mirrorHint"))).toBeInTheDocument();
    expect(screen.queryByTestId("monitors-move-right")).toBeNull();
    // The biggest size both have.
    expect(select("monitors-resolution").value).toBe("2560x1440");

    fireEvent.click(applyButton());
    await waitFor(() => expect(lastPost()?.action).toBe("apply"));
    const layout = lastPost()!.layout!;
    expect(layout.mirror).toBe(true);
    expect(layout.monitors[LEFT.id]).toMatchObject({ width: 2560, height: 1440 });
    expect(layout.monitors[RIGHT.id]).toMatchObject({ width: 2560, height: 1440 });
  });

  it("a monitor that answers DDC/CI gets a brightness slider that writes at once", async () => {
    installBox(twoStatus());
    box.brightness = { status: 200, body: { monitors: { [LEFT.id]: { value: 40, max: 100 } } } };
    await mountPanel();

    const slider = await screen.findByTestId("monitors-brightness");
    expect(slider).toHaveAccessibleName(tx("settings.monitors.brightness"));
    expect(screen.getByTestId("monitors-brightness-row")).toHaveTextContent("40%");

    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    await waitFor(() =>
      expect(box.calls.filter((c) => c.url === "/setup-api/monitors/brightness" && c.method === "POST").at(-1)?.body)
        .toEqual({ monitor: LEFT.id, value: 70 }),
    );
    expect(screen.getByTestId("monitors-brightness-row")).toHaveTextContent("70%");
    // Brightness is not part of the layout: nothing to apply.
    expect(applyButton()).toBeDisabled();

    // The other monitor did not answer DDC: no slider for it.
    fireEvent.click(block(2));
    expect(screen.queryByTestId("monitors-brightness")).toBeNull();
  });

  it("a slider move still waiting on the throttle is sent when the panel closes, once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installBox(twoStatus());
    box.brightness = { status: 200, body: { monitors: { [LEFT.id]: { value: 40, max: 100 } } } };
    const { unmount } = render(<MonitorsPanel />);
    await flush();
    const slider = screen.getByTestId("monitors-brightness");
    const brightnessPosts = () =>
      box.calls.filter((c) => c.url === "/setup-api/monitors/brightness" && c.method === "POST");

    // A drag (no pointer-up yet) arms the throttle; nothing is written yet.
    fireEvent.change(slider, { target: { value: "70" } });
    expect(brightnessPosts()).toHaveLength(0);

    // Settings closed before the throttle fired: the owner's last value still reaches the monitor.
    unmount();
    expect(brightnessPosts().map((c) => c.body)).toEqual([{ monitor: LEFT.id, value: 70 }]);

    // ...and the throttle it replaced does not send it a second time.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(brightnessPosts()).toHaveLength(1);
  });

  it("a brightness write the monitor refuses is said from the catalogue", async () => {
    installBox(twoStatus());
    box.brightness = { status: 200, body: { monitors: { [LEFT.id]: { value: 40, max: 100 } } } };
    box.brightnessPost = () => ({ status: 502, body: { error: "ddcutil failed", code: "write_failed" } });
    await mountPanel();
    const slider = await screen.findByTestId("monitors-brightness");
    fireEvent.change(slider, { target: { value: "10" } });
    fireEvent.keyUp(slider, { key: "ArrowLeft" });
    expect(await screen.findByTestId("monitors-error")).toHaveTextContent(tx("settings.monitors.error.writeFailed"));
  });
});

describe("MonitorsPanel — while a write is under way", () => {
  // Apply can take seconds (a modeset, the window spread again); its answer
  // replaces the draft, so an edit made meanwhile vanished without a word.
  it("the editing controls are disabled until the answer lands, and a keyboard move does nothing", async () => {
    installBox(twoStatus());
    let answer!: () => void;
    await mountPanel();
    box.post = (body) =>
      new Promise((resolve) => {
        answer = () => {
          box.kept = box.status;
          box.status = statusAfter(box.status, body.layout!, Date.now() + 20_000);
          resolve({ status: 200, body: box.status });
        };
      });
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applyButton()).toHaveTextContent(tx("settings.monitors.applying")));

    expect(screen.getByTestId("monitors-editor")).toBeDisabled();
    expect(select("monitors-resolution")).toBeDisabled();
    expect(screen.getByTestId("monitors-enabled")).toBeDisabled();
    expect(screen.getByTestId("monitors-mirror")).toBeDisabled();
    expect(block(1)).toBeDisabled();
    // The keyboard's half: a block that still had the focus moves nothing.
    fireEvent.keyDown(block(2), { key: "ArrowLeft" });
    fireEvent.change(select("monitors-resolution"), { target: { value: "1920x1080" } });
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);

    await act(async () => answer());
    await screen.findByTestId("monitors-pending");
    expect(screen.getByTestId("monitors-editor")).toBeEnabled();
    expect(select("monitors-resolution")).toBeEnabled();
    expect(select("monitors-resolution").value).toBe("2560x1440");
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    expect(applyButton()).toBeDisabled();
  });
});

describe("MonitorsPanel — dragging a monitor", () => {
  beforeEach(() => {
    // jsdom has no pointer capture.
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).setPointerCapture;
  });

  const canvasNodes = () => [...screen.getByTestId("monitors-canvas").children];

  // A block re-inserted in the DOM loses its pointer capture: a drag past a
  // neighbour released off the blocks never ended, and hovering went on
  // moving the monitor with no button held.
  it("a reorder keeps every block where it is in the DOM; only its place on the canvas moves", async () => {
    await mountPanel();
    const before = canvasNodes();
    fireEvent.click(screen.getByTestId("monitors-move-right"));
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    expect(canvasNodes()).toEqual(before);
    fireEvent.keyDown(block(1), { key: "ArrowRight" });
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
    expect(canvasNodes()).toEqual(before);
  });

  it("dragged past its neighbour, the block keeps its node; a move with no button held ends the drag", async () => {
    await mountPanel();
    const left = block(1);
    const nodes = canvasNodes();
    fireEvent.pointerDown(left, { clientX: 100, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(left, { clientX: 420, pointerId: 1, buttons: 1 });
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    expect(canvasNodes()).toEqual(nodes);
    expect(block(2)).toBe(left);

    // The button came up off every block: the next hover is not a drag.
    fireEvent.pointerMove(left, { clientX: 40, pointerId: 1, buttons: 0 });
    fireEvent.pointerMove(left, { clientX: 20, pointerId: 1, buttons: 0 });
    expect(rowIds()).toEqual([RIGHT.id, LEFT.id]);
    // And the block is back in its slot, not offset by the old drag.
    expect(left.style.transition).not.toBe("none");
  });

  it("a lost pointer capture ends the drag", async () => {
    await mountPanel();
    const left = block(1);
    fireEvent.pointerDown(left, { clientX: 100, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(left, { clientX: 140, pointerId: 1, buttons: 1 });
    expect(left.style.transition).toBe("none");
    // It bubbles, as the Pointer Events spec says (testing-library's default does not).
    fireEvent.lostPointerCapture(left, { pointerId: 1, bubbles: true });
    expect(left.style.transition).not.toBe("none");
    fireEvent.pointerMove(left, { clientX: 420, pointerId: 1, buttons: 1 });
    expect(rowIds()).toEqual([LEFT.id, RIGHT.id]);
  });
});

describe("MonitorsPanel — in the desktop's language", () => {
  it("refresh rates, scales and the brightness are written the way the language writes figures", async () => {
    i18n.locale = "de";
    installBox(twoStatus());
    box.brightness = { status: 200, body: { monitors: { [LEFT.id]: { value: 40, max: 100 } } } };
    await mountPanel();

    const rates = [...select("monitors-refresh").options].map((o) => o.textContent);
    expect(rates).toContain("59,95 Hz");
    expect(rates.join(" ")).not.toMatch(/\d\.\d/);
    const scale = [...select("monitors-scale").options].find((o) => o.value === "1.25")?.textContent ?? "";
    expect(scale).toMatch(/^125\s%$/);
    expect(await screen.findByTestId("monitors-brightness-row")).toHaveTextContent(/40\s%/);
  });

  it("the 'Turned off' list's colon is the language's own", async () => {
    i18n.locale = "fr";
    await mountPanel();
    const off = screen.getByTestId("monitors-off");
    expect(off).toHaveTextContent(translations.fr["settings.monitors.offList"]);
    expect(translations.fr["settings.monitors.offList"]).toBe("Éteints :");
    expect(off.textContent).not.toContain("::");
    expect(off.textContent).not.toContain(" :" + ":");
  });

  // "Haupt", "Hoofd" and "Huvud" are a prefix and the word for "head".
  it("the main monitor's badge is a whole word in German, Dutch and Swedish", () => {
    expect(translations.de["settings.monitors.main"]).toBe("Primär");
    expect(translations.nl["settings.monitors.main"]).toBe("Hoofdscherm");
    expect(translations.sv["settings.monitors.main"]).toBe("Huvudskärm");
  });

  // The compositor can report a mirrored transform the panel never offers
  // (a hand-edited saved layout, wlr-randr from a terminal); it used to show
  // as the raw token "flipped-90" in every language.
  it.each([
    ["flipped", "settings.monitors.rotationMirrored"],
    ["flipped-90", "settings.monitors.rotation90Mirrored"],
    ["flipped-180", "settings.monitors.rotation180Mirrored"],
    ["flipped-270", "settings.monitors.rotation270Mirrored"],
  ] as const)("a %s monitor's rotation is named, not printed as a token", async (transform, key) => {
    i18n.locale = "de";
    const status = twoStatus();
    installBox({ ...status, monitors: status.monitors.map((m) => (m.id === LEFT.id ? { ...m, transform } : m)) });
    await mountPanel();
    const rotation = select("monitors-rotation");
    expect(rotation.value).toBe(transform);
    expect(rotation.selectedOptions[0].textContent).toBe(translations.de[key]);
    expect(rotation.selectedOptions[0].textContent).not.toContain(transform);
    // The four the panel offers are still the only others.
    expect(optionValues("monitors-rotation")).toEqual(["normal", "90", "180", "270", transform]);
  });
});

describe("recommendedScale", () => {
  it("is the scale nearest to 110 dpi, and null for a monitor that does not say its size", () => {
    expect(recommendedScale({ physicalSize: { width: 600, height: 340 } }, 2560)).toBe(1);
    // A 310 mm wide 1080p panel: ~157 dpi → 150 %.
    expect(recommendedScale({ physicalSize: { width: 310, height: 170 } }, 1920)).toBe(1.5);
    expect(recommendedScale({ physicalSize: null }, 1920)).toBeNull();
    expect(recommendedScale({ physicalSize: { width: 0, height: 0 } }, 1920)).toBeNull();
    expect(recommendedScale({ physicalSize: { width: 600, height: 340 } }, 0)).toBeNull();
  });
});
