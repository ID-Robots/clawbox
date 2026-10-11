/**
 * The battery in the shelf's tray (src/components/BatteryIndicator.tsx).
 *
 * It is drawn only on an x64 laptop: every other box — a Jetson, a desktop
 * with no battery — answers `available: false`, and a page that is signed out
 * or not the owner's is refused (401/403). Each of those, and a failed request,
 * must cost exactly ONE request and draw nothing: no glyph, no console line,
 * no poll left asking every minute for the life of the page. A desktop the box
 * has said is another ClawBox user's costs none: the route is the owner's.
 *
 * The owner gate (`useMayUseOwnerApis`) is a store the case sets, so the
 * fetch mock sees only the battery route and "not known yet" can turn into
 * "the owner" mid-case. The component is rendered with a `t` that answers
 * the KEY with its parameters, so the title is checked for what it says
 * rather than for the English wording, and the poll is installed through a
 * recorder around the real `setVisibleInterval` so its cadence and its stop
 * can both be seen.
 */
import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import BatteryIndicator from "@/components/BatteryIndicator";

const h = vi.hoisted(() => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}${JSON.stringify(params)}` : key;
  return {
    t,
    // Every poll the component installs, with the stop it was handed.
    installs: [] as { tick: () => void; ms: number; options: unknown; stop: () => void }[],
    // Off: the recorder only records, and a test drives `tick` itself.
    // On: the real interval runs underneath, on fake timers.
    real: false,
    // What `useMayUseOwnerApis()` answers: `null` until /users/me has.
    owner: { value: true as boolean | null, listeners: new Set<() => void>() },
  };
});

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: h.t }),
}));

vi.mock("@/lib/use-session-user", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    h.owner.listeners.add(listener);
    return () => { h.owner.listeners.delete(listener); };
  };
  return { useMayUseOwnerApis: () => useSyncExternalStore(subscribe, () => h.owner.value) };
});

function setOwnerApis(value: boolean | null) {
  h.owner.value = value;
  for (const listener of h.owner.listeners) listener();
}

vi.mock("@/lib/visible-interval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/visible-interval")>();
  return {
    ...actual,
    setVisibleInterval: (tick: () => void, ms: number, options?: unknown) => {
      const stopReal = h.real ? actual.setVisibleInterval(tick, ms, options as never) : () => {};
      const stop = vi.fn(stopReal);
      h.installs.push({ tick, ms, options, stop });
      return stop;
    },
  };
});

const URL_PATH = "/setup-api/system/battery";

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };

function reply(body: unknown, status = 200): Reply {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function reading(percent: number, state: string, minutesLeft: number | null = null) {
  return { available: true, percent, state, acOnline: state === "discharging" ? false : true, minutesLeft };
}

function stubFetch(...replies: Reply[]) {
  const fetchMock = vi.fn();
  for (const r of replies) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderReading(body: unknown) {
  const fetchMock = stubFetch(reply(body));
  const view = render(<BatteryIndicator />);
  const indicator = await screen.findByTestId("shelf-battery");
  return { ...view, fetchMock, indicator };
}

function glyph() {
  return screen.getByTestId("shelf-battery-glyph");
}

beforeEach(() => {
  h.installs.length = 0;
  h.real = false;
  h.owner.value = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BatteryIndicator — only the owner's desktop asks", () => {
  it("asks nothing and draws nothing on another ClawBox user's desktop", async () => {
    setOwnerApis(false);
    const fetchMock = stubFetch(reply(reading(50, "discharging")));
    const { container } = render(<BatteryIndicator />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.installs).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });

  it("waits until the box has said who is signed in, then asks once and polls", async () => {
    setOwnerApis(null);
    const fetchMock = stubFetch(reply(reading(50, "discharging")));
    render(<BatteryIndicator />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.installs).toHaveLength(0);

    await act(async () => { setOwnerApis(true); });
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { cache: "no-store" });
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0].ms).toBe(60_000);
  });
});

describe("BatteryIndicator — no battery to show", () => {
  async function expectGaveUp(fetchMock: ReturnType<typeof vi.fn>, container: HTMLElement) {
    await waitFor(() => expect(h.installs[0]?.stop).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { cache: "no-store" });
    // A tick that was already queued when the poll stopped asks nothing.
    await act(async () => { h.installs[0].tick(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  }

  it("draws nothing and never asks again on a box with no battery", async () => {
    const fetchMock = stubFetch(reply({ available: false }), reply(reading(50, "discharging")));
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it.each([401, 403, 404, 500])("draws nothing and never asks again on a %i", async (status) => {
    const fetchMock = stubFetch(reply({ error: "nope" }, status), reply(reading(50, "discharging")));
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it("draws nothing and never asks again when the request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(reply(reading(50, "discharging")));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it("draws nothing and never asks again when fetch throws before it is under way", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => { throw new TypeError("blocked"); })
      .mockResolvedValue(reply(reading(50, "discharging")));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it("draws nothing and never asks again on a body that is not JSON", async () => {
    const fetchMock = stubFetch(
      { ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) },
      reply(reading(50, "discharging")),
    );
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it.each([
    ["no percent", { available: true, state: "discharging" }],
    ["a percent that is not a number", { available: true, percent: "50", state: "discharging" }],
    ["null", null],
    ["an empty object", {}],
  ])("draws nothing and never asks again on a reply with %s", async (_label, body) => {
    const fetchMock = stubFetch(reply(body), reply(reading(50, "discharging")));
    const { container } = render(<BatteryIndicator />);
    await expectGaveUp(fetchMock, container);
  });

  it("writes nothing to the console on the way out", async () => {
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const first = render(<BatteryIndicator />);
    await waitFor(() => expect(h.installs[0]?.stop).toHaveBeenCalled());
    first.unmount();
    stubFetch(reply({}, 403));
    render(<BatteryIndicator />);
    await waitFor(() => expect(h.installs[1]?.stop).toHaveBeenCalled());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("hides a reading it was showing once the box stops answering for it", async () => {
    const fetchMock = stubFetch(reply(reading(64, "discharging")), reply({}, 401), reply(reading(63, "discharging")));
    const { container } = render(<BatteryIndicator />);
    expect(await screen.findByText("64%")).toBeInTheDocument();
    await act(async () => { h.installs[0].tick(); });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(h.installs[0].stop).toHaveBeenCalled();
    await act(async () => { h.installs[0].tick(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BatteryIndicator — the glyph and the percentage", () => {
  it.each([
    ["charging", 42, "battery_charging_full"],
    ["charging", 100, "battery_charging_full"],
    ["full", 100, "battery_full"],
    ["full", 97, "battery_full"],
    ["discharging", 0, "battery_0_bar"],
    ["discharging", 14, "battery_0_bar"],
    ["discharging", 15, "battery_1_bar"],
    ["discharging", 50, "battery_3_bar"],
    ["discharging", 85, "battery_5_bar"],
    ["discharging", 86, "battery_6_bar"],
    ["discharging", 100, "battery_6_bar"],
    ["not_charging", 80, "battery_5_bar"],
    ["unknown", 30, "battery_2_bar"],
  ])("%s at %i%% draws %s", async (state, percent, name) => {
    await renderReading(reading(percent, state));
    expect(glyph()).toHaveTextContent(name);
    expect(glyph()).toHaveClass("material-symbols-rounded");
    expect(glyph()).toHaveStyle({ fontSize: "18px" });
    expect(screen.getByText(`${percent}%`)).toBeInTheDocument();
  });

  it("never draws a level below 'full' as full, and fills as the level rises", async () => {
    let last = -1;
    for (let percent = 0; percent <= 100; percent++) {
      const { unmount } = await renderReading(reading(percent, "discharging"));
      const match = /^battery_(\d)_bar$/.exec(glyph().textContent ?? "");
      expect(match, `${percent}%`).not.toBeNull();
      const bars = Number(match![1]);
      expect(bars).toBeGreaterThanOrEqual(last);
      last = bars;
      unmount();
    }
    expect(last).toBe(6);
  });

  it("reads an unrecognised state as unknown and keeps the percentage in range", async () => {
    await renderReading(reading(104.6, "exploding"));
    expect(glyph()).toHaveTextContent("battery_6_bar");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByTestId("shelf-battery")).toHaveAttribute(
      "title",
      h.t("tray.batteryTitle", { percent: 100, state: h.t("tray.batteryUnknown") }),
    );
  });

  it("rounds a fractional percentage", async () => {
    await renderReading(reading(57.5, "discharging"));
    expect(screen.getByText("58%")).toBeInTheDocument();
  });

  it("names only glyphs the bundled Material Symbols subset carries", () => {
    // `grep -c -a -w <name> public/fonts/material-symbols-rounded.ttf` must
    // print 1: a name the subset lacks renders as its literal text.
    const font = readFileSync(path.join(process.cwd(), "public/fonts/material-symbols-rounded.ttf"), "latin1");
    const lines = font.split("\n");
    const names = ["battery_charging_full", "battery_full", ...Array.from({ length: 7 }, (_, i) => `battery_${i}_bar`)];
    for (const name of names) {
      const word = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
      expect(lines.filter((line) => word.test(line)).length, name).toBe(1);
    }
  });
});

describe("BatteryIndicator — low battery", () => {
  it("turns amber at 20% while discharging, and says it is low", async () => {
    const { indicator } = await renderReading(reading(20, "discharging"));
    expect(indicator).toHaveClass("text-amber-400");
    expect(indicator).not.toHaveClass("text-red-400");
    expect(indicator).toHaveAttribute("data-low", "low");
    expect(glyph()).not.toHaveClass("text-white/60");
    expect(indicator.getAttribute("title")).toContain("tray.batteryLow");
    expect(indicator.getAttribute("aria-label")).toContain("tray.batteryLow");
  });

  it("turns red at 10% while discharging", async () => {
    const { indicator } = await renderReading(reading(10, "discharging"));
    expect(indicator).toHaveClass("text-red-400");
    expect(indicator).not.toHaveClass("text-amber-400");
    expect(indicator).toHaveAttribute("data-low", "critical");
    expect(indicator.getAttribute("title")).toContain("tray.batteryLow");
  });

  it("stays plain at 21% while discharging", async () => {
    const { indicator } = await renderReading(reading(21, "discharging"));
    expect(indicator).toHaveClass("text-white/80");
    expect(indicator).not.toHaveClass("text-amber-400");
    expect(indicator).not.toHaveAttribute("data-low");
    expect(indicator.getAttribute("title")).not.toContain("tray.batteryLow");
  });

  it.each(["charging", "not_charging", "unknown"])("does not warn at 5%% while %s", async (state) => {
    const { indicator } = await renderReading(reading(5, state));
    expect(indicator).not.toHaveClass("text-amber-400");
    expect(indicator).not.toHaveClass("text-red-400");
    expect(indicator.getAttribute("title")).not.toContain("tray.batteryLow");
  });
});

describe("BatteryIndicator — the title", () => {
  it("gives the percentage, the state and the time left while discharging", async () => {
    const { indicator } = await renderReading(reading(45, "discharging", 95));
    const label = [
      h.t("tray.batteryTitle", { percent: 45, state: h.t("tray.batteryDischarging") }),
      h.t("tray.batteryTimeLeft", { time: h.t("tray.batteryHoursMinutes", { hours: 1, minutes: 35 }) }),
    ].join(" · ");
    expect(indicator).toHaveAttribute("title", label);
    expect(screen.getByRole("img", { name: label })).toBe(indicator);
  });

  it("gives the time to full while charging, in minutes under an hour", async () => {
    const { indicator } = await renderReading(reading(70, "charging", 40));
    expect(indicator).toHaveAttribute("title", [
      h.t("tray.batteryTitle", { percent: 70, state: h.t("tray.batteryCharging") }),
      h.t("tray.batteryTimeToFull", { time: h.t("tray.batteryMinutes", { minutes: 40 }) }),
    ].join(" · "));
  });

  it("says a whole number of hours with zero minutes", async () => {
    const { indicator } = await renderReading(reading(60, "discharging", 120));
    expect(indicator.getAttribute("title")).toContain(
      h.t("tray.batteryTimeLeft", { time: h.t("tray.batteryHoursMinutes", { hours: 2, minutes: 0 }) }),
    );
  });

  it.each([
    ["full", "tray.batteryFull"],
    ["not_charging", "tray.batteryNotCharging"],
    ["unknown", "tray.batteryUnknown"],
  ])("names the %s state, with no time when none is known", async (state, key) => {
    const { indicator } = await renderReading(reading(100, state, null));
    const label = h.t("tray.batteryTitle", { percent: 100, state: h.t(key) });
    expect(indicator).toHaveAttribute("title", label);
    expect(indicator).toHaveAttribute("aria-label", label);
  });

  it("puts the low warning after the time left", async () => {
    const { indicator } = await renderReading(reading(8, "discharging", 12.4));
    expect(indicator).toHaveAttribute("title", [
      h.t("tray.batteryTitle", { percent: 8, state: h.t("tray.batteryDischarging") }),
      h.t("tray.batteryTimeLeft", { time: h.t("tray.batteryMinutes", { minutes: 12 }) }),
      h.t("tray.batteryLow"),
    ].join(" · "));
  });

  it.each([0, 0.4, -5, Number.NaN])("leaves out a time of %s minutes", async (minutesLeft) => {
    const { indicator } = await renderReading(reading(50, "discharging", minutesLeft));
    expect(indicator.getAttribute("title")).not.toContain("tray.batteryTimeLeft");
  });

  it("writes the percentage without a translation key", async () => {
    const { indicator } = await renderReading(reading(33, "discharging"));
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(indicator.textContent).not.toContain("tray.");
  });
});

describe("BatteryIndicator — the poll", () => {
  let visibility: DocumentVisibilityState = "visible";

  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("asks once a minute through setVisibleInterval, with no hidden cadence", async () => {
    const fetchMock = stubFetch(reply(reading(50, "discharging")), reply(reading(49, "discharging")));
    render(<BatteryIndicator />);
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0].ms).toBe(60_000);
    expect(h.installs[0].options).toBeUndefined();
    await act(async () => { h.installs[0].tick(); });
    expect(await screen.findByText("49%")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(URL_PATH, { cache: "no-store" });
  });

  it("clears the interval on unmount", async () => {
    const fetchMock = stubFetch(reply(reading(50, "discharging")));
    const { unmount } = render(<BatteryIndicator />);
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(h.installs[0].stop).not.toHaveBeenCalled();
    unmount();
    expect(h.installs[0].stop).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not draw a reading that lands after unmount", async () => {
    let resolve!: (r: Reply) => void;
    const fetchMock = vi.fn(() => new Promise<Reply>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    const spy = vi.spyOn(console, "error");
    const { unmount, container } = render(<BatteryIndicator />);
    unmount();
    await act(async () => { resolve(reply(reading(50, "discharging"))); });
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });

  describe("on the real interval", () => {
    beforeEach(() => {
      h.real = true;
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (document as unknown as Record<string, unknown>).visibilityState;
    });

    it("asks every 60 s, waits while hidden, and stops on unmount", async () => {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(reply(reading(50, "discharging"))));
      vi.stubGlobal("fetch", fetchMock);
      const { unmount } = render(<BatteryIndicator />);
      expect(await screen.findByText("50%")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(59_999); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Hidden: nothing, however long.
      setVisibility("hidden");
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Back on screen: the missed reading, once, at once.
      await act(async () => { setVisibility("visible"); });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      unmount();
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      setVisibility("hidden");
      setVisibility("visible");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("never asks again after a box with no battery said so", async () => {
      const fetchMock = vi.fn().mockResolvedValue(reply({ available: false }));
      vi.stubGlobal("fetch", fetchMock);
      const { container } = render(<BatteryIndicator />);
      // vi.waitFor keeps the real timers: testing-library's polls on the
      // faked setInterval, and giving up changes nothing in the DOM to wake it.
      await vi.waitFor(() => expect(h.installs[0]?.stop).toHaveBeenCalled());
      await act(async () => { vi.advanceTimersByTime(30 * 60_000); });
      setVisibility("hidden");
      setVisibility("visible");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
