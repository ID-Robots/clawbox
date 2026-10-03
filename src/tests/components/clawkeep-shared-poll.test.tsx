import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { useClawkeepShieldStatus } from "@/hooks/useClawkeepShieldStatus";
import { I18nProvider } from "@/lib/i18n";

/**
 * The ClawKeep window and the shelf's shield ask the same route. With the
 * window open they used to run a poll each — every 10 s and every 5 s, so the
 * box answered both. The requests are now the page's: the shield takes every
 * answer the window asked for and asks for itself only once 5 s go by without
 * one. The window keeps its own clock — it draws only the answers it asked
 * for, so what it shows changes exactly when it did — and asks nothing while
 * the page is hidden.
 */

const STATUS = {
  paired: false,
  configured: false,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  setupComplete: true,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 },
  nextRunAtMs: 0,
};

const T0 = new Date("2026-10-02T12:00:00Z").getTime();

let statusCalls = 0;
/** What GET /setup-api/clawkeep answers right now. */
let answer: () => { ok: boolean; status: number; json: () => Promise<unknown> } =
  () => ({ ok: true, status: 200, json: async () => ({ ...STATUS }) });

function Shelf() {
  useClawkeepShieldStatus();
  return null;
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  statusCalls = 0;
  answer = () => ({ ok: true, status: 200, json: async () => ({ ...STATUS }) });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/setup-api/clawkeep") {
      statusCalls++;
      return answer();
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("ClawKeep's window and the shelf's shield", () => {
  it("are answered by one look every 5 s between them, not one each", async () => {
    await act(async () => {
      render(<I18nProvider><Shelf /><ClawKeepApp /></I18nProvider>);
    });
    await advance(0);
    const opened = statusCalls;
    // The window's first look and the shield's: one request, or two when the
    // shield's happened to be out before the window's own (which never joins).
    expect(opened).toBeLessThanOrEqual(2);

    await advance(60_000);
    // Each on its own clock this was 6 (window) + 12 (shield) more.
    expect(statusCalls - opened).toBeLessThanOrEqual(12);
    expect(statusCalls - opened).toBeGreaterThanOrEqual(11);
  });

  it("the window draws only the answers it asked for: a failure it shows is cleared by its own next look, as before", async () => {
    // The box refuses until the shield's first look of its own.
    answer = () => (Date.now() < T0 + 1_000
      ? { ok: false, status: 500, json: async () => ({ error: "ClawKeep is busy" }) }
      : { ok: true, status: 200, json: async () => ({ ...STATUS }) });
    await act(async () => {
      render(<I18nProvider><Shelf /><ClawKeepApp /></I18nProvider>);
    });
    await advance(0);
    // The failure card, with the box's own sentence under it.
    expect(screen.getByText("ClawKeep is busy")).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-state")).toBeNull();

    // The shield's look at 5 s is answered — and is the shield's.
    await advance(6_000);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("ClawKeep is busy")).toBeTruthy();

    // The window's own look, 10 s after its first, draws the box.
    await advance(4_000);
    expect(screen.queryByText("ClawKeep is busy")).toBeNull();
    expect(screen.getByTestId("clawkeep-state")).toBeTruthy();
  });

  it("the window asks nothing while the page is hidden, and looks at once on the visible edge", async () => {
    await act(async () => {
      render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    });
    await advance(0);
    expect(statusCalls).toBe(1);
    await advance(10_000);
    expect(statusCalls).toBe(2);

    setVisibility("hidden");
    await advance(60_000);
    expect(statusCalls).toBe(2);

    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    expect(statusCalls).toBe(3);
    await advance(10_000);
    expect(statusCalls).toBe(4);
  });
});
