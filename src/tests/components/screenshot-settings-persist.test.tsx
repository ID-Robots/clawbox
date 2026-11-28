/**
 * The Screenshot app remembers "Capture with" and "Hide this window while
 * capturing" across closing and reopening it, and a page reload. Both used to
 * be plain component state, back to Built-in and ticked on every open.
 *
 * They persist through the desktop's preferences route, the store the Terminal
 * keeps its settings in. The route is stubbed here with an in-memory map, and
 * the second mount runs on freshly imported modules, so only what reached the
 * store can bring the choice back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { CAPTURE_REQUEST_EVENT } from "@/lib/screenshot/session";

// A capture that never finishes: these cases are about what is asked for.
vi.mock("@/components/screenshot/capture", () => ({
  captureScreen: vi.fn(() => new Promise(() => {})),
  currentCaptureScale: () => 1,
}));
// Neither the editor (no picture is opened here) nor the capture overlay is
// under test, and both are heavy to import twice per case.
vi.mock("@/components/ScreenshotEditor", () => ({ default: () => null }));
vi.mock("@/components/ScreenshotOverlay", () => ({ default: () => null }));

// The browser's own capture is offered on this page.
vi.mock("@/components/screenshot/display-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/screenshot/display-capture")>()),
  displayCaptureSupported: () => supported.value,
  prepareDisplayCapture: () => {},
}));

// The shipped English catalogue, so the controls are found by what the owner reads.
vi.mock("@/lib/i18n", async () => {
  const { screenshotEn } = await import("@/lib/screenshot-translations");
  return {
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let text = screenshotEn[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
        return text;
      },
      locale: "en",
    }),
  };
});

const supported = vi.hoisted(() => ({ value: true }));
const KEY = "ui_screenshot_settings";

/** The preferences store, as the route keeps it: one JSON value per name. */
let store: Map<string, unknown>;
let writes: Array<Record<string, unknown>>;
let failWrites: boolean;

function json(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith("/setup-api/screenshots")) return json({ files: [] });
  if (url.startsWith("/setup-api/preferences")) {
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      if (failWrites) return json({ error: "nope" }, false);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      for (const [name, value] of Object.entries(body)) store.set(name, value);
      return json({ ok: true });
    }
    const names = new URL(url, "http://box").searchParams.get("keys")?.split(",") ?? [];
    return json(Object.fromEntries(names.filter((name) => store.has(name)).map((name) => [name, store.get(name)])));
  }
  return json({}, false);
});

async function mountApp() {
  const { default: ScreenshotApp } = await import("@/components/ScreenshotApp");
  return render(<ScreenshotApp />);
}

const browserButton = () => screen.getByRole("button", { name: "Browser" });
const builtInButton = () => screen.getByRole("button", { name: "Built-in" });
const hideBox = () => screen.getByRole("checkbox", { name: "Hide this window while capturing" }) as HTMLInputElement;
const preferenceReads = () => fetchStub.mock.calls.filter(([url, init]) =>
  String(url).startsWith("/setup-api/preferences") && (init?.method ?? "GET") === "GET").length;

beforeEach(() => {
  store = new Map();
  writes = [];
  failWrites = false;
  supported.value = true;
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Screenshot app's capture options", () => {
  it("keeps Browser and an unticked hide box across closing and reopening the app", async () => {
    const first = await mountApp();
    // Defaults until a saved value arrives: Built-in, hide on.
    expect(builtInButton().getAttribute("aria-pressed")).toBe("true");
    expect(hideBox().checked).toBe(true);
    await waitFor(() => expect(preferenceReads()).toBeGreaterThan(0));

    fireEvent.click(browserButton());
    fireEvent.click(hideBox());
    expect(browserButton().getAttribute("aria-pressed")).toBe("true");
    expect(hideBox().checked).toBe(false);

    // The choice reached the store, under a name the route accepts.
    await waitFor(() => expect(store.get(KEY)).toEqual({ engine: "display", hideWindow: false }));
    expect(writes.length).toBeGreaterThan(0);
    first.unmount();

    // Reopened on fresh modules, as after a reload: nothing in memory carries it.
    vi.resetModules();
    await mountApp();
    await waitFor(() => expect(browserButton().getAttribute("aria-pressed")).toBe("true"));
    expect(builtInButton().getAttribute("aria-pressed")).toBe("false");
    expect(hideBox().checked).toBe(false);
  });

  it("ignores a saved value it does not recognise and keeps the defaults", async () => {
    store.set(KEY, { engine: "webcam", hideWindow: "no" });
    await mountApp();
    await waitFor(() => expect(preferenceReads()).toBeGreaterThan(0));
    await act(async () => { await Promise.resolve(); });
    expect(builtInButton().getAttribute("aria-pressed")).toBe("true");
    expect(hideBox().checked).toBe(true);
  });

  it("captures with Built-in where the browser's capture is missing, and keeps the saved Browser choice", async () => {
    supported.value = false;
    store.set(KEY, { engine: "display", hideWindow: false });
    await mountApp();
    await waitFor(() => expect(hideBox().checked).toBe(false));
    // No engine switch is offered, and the delay that only Built-in has is.
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    expect(screen.getByRole("group", { name: "Delay" })).toBeTruthy();
    expect(writes).toHaveLength(0);
    expect(store.get(KEY)).toEqual({ engine: "display", hideWindow: false });

    // Ticking the box saves it, and the Browser choice stays saved beside it.
    fireEvent.click(hideBox());
    await waitFor(() => expect(store.get(KEY)).toEqual({ engine: "display", hideWindow: true }));
  });

  it("never lets a failed save take the choice back or block a capture", async () => {
    failWrites = true;
    await mountApp();
    await waitFor(() => expect(preferenceReads()).toBeGreaterThan(0));
    fireEvent.click(browserButton());
    await waitFor(() => expect(fetchStub.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(browserButton().getAttribute("aria-pressed")).toBe("true");
    expect(store.has(KEY)).toBe(false);

    const requests: Array<Record<string, unknown>> = [];
    const onRequest = (event: Event) => requests.push((event as CustomEvent<Record<string, unknown>>).detail);
    window.addEventListener(CAPTURE_REQUEST_EVENT, onRequest);
    try {
      fireEvent.click(screen.getByTestId("screenshot-capture-full"));
    } finally {
      window.removeEventListener(CAPTURE_REQUEST_EVENT, onRequest);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "full", engine: "display" });
  });
});
