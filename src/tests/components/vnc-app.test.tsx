import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import VNCApp from "@/components/VNCApp";
import { getTrackedVncKey } from "@/lib/vnc-keys";
import { SETUP_AUTH_EXPIRED_MESSAGE } from "@/lib/fetch-setup-json";

type RfbListener = (event?: Event | CustomEvent) => void;

class MockRFB {
  target: HTMLElement;
  canvas: HTMLCanvasElement;
  listeners = new Map<string, RfbListener[]>();
  disconnect = vi.fn();
  sendKey = vi.fn();
  focus = vi.fn(() => {
    this.canvas.focus();
  });
  blur = vi.fn(() => {
    this.canvas.blur();
  });
  addEventListener = vi.fn((type: string, listener: RfbListener) => {
    const next = this.listeners.get(type) ?? [];
    next.push(listener);
    this.listeners.set(type, next);
  });
  removeEventListener = vi.fn((type: string, listener: RfbListener) => {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((entry) => entry !== listener));
  });
  scaleViewport = false;
  resizeSession = false;
  clipViewport = false;
  showDotCursor = false;
  focusOnClick = true;
  qualityLevel = 0;
  compressionLevel = 0;

  constructor(target: HTMLElement) {
    this.target = target;
    const screen = document.createElement("div");
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = -1;
    screen.appendChild(this.canvas);
    target.appendChild(screen);
    mockRfbInstances.push(this);
  }

  emit(type: string, detail?: unknown) {
    const event = new CustomEvent(type, { detail });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const mockRfbInstances: MockRFB[] = [];

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => key,
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@novnc/novnc", () => ({
  default: MockRFB,
}));

describe("VNCApp", () => {
  beforeEach(() => {
    mockRfbInstances.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: true, wsPort: 6080 }),
    })));
  });

  it("shows a sign-in prompt instead of parsing a 401 response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return {
        ok: false,
        status: 401,
        redirected: false,
        url: "https://example.test/setup-api/vnc",
        json: vi.fn(),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByRole, queryByText } = render(<VNCApp />);

    await waitFor(() => {
      expect(getByRole("button", { name: "vnc.refreshSignIn" })).toBeInTheDocument();
    });
    expect(queryByText(SETUP_AUTH_EXPIRED_MESSAGE)).toBeInTheDocument();
    expect(queryByText("vnc.repairButton")).not.toBeInTheDocument();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Accept")).toBe("application/json");
  });

  it("stops the repair flow when authentication expires", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://example.test/setup-api/vnc",
        json: async () => ({ available: false, error: "No VNC server detected" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        redirected: false,
        url: "https://example.test/setup-api/install/run-step",
        json: vi.fn(),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { findByRole, getByRole } = render(<VNCApp />);
    fireEvent.click(await findByRole("button", { name: /vnc\.repairButton/ }));

    await waitFor(() => {
      expect(getByRole("button", { name: "vnc.refreshSignIn" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/setup-api/install/run-step");
  });

  it("forwards keyboard events to the RFB connection when focus drifts off the noVNC canvas", async () => {
    const { queryByText } = render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    await waitFor(() => {
      expect(rfb.focus).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(queryByText("vnc.connectingDesktop")).not.toBeInTheDocument();
    });

    fireEvent.pointerDown(rfb.target);
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    fireEvent.keyUp(document.body, { key: "a", code: "KeyA" });

    await waitFor(() => {
      expect(rfb.sendKey).toHaveBeenCalledWith(97, "KeyA");
    });
  });

  it("forwards canvas key events that bubble out unhandled by noVNC", async () => {
    const { queryByText } = render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    await waitFor(() => {
      expect(rfb.focus).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(queryByText("vnc.connectingDesktop")).not.toBeInTheDocument();
    });

    fireEvent.pointerDown(rfb.target);
    fireEvent.keyDown(rfb.canvas, { key: "a", code: "KeyA" });
    fireEvent.keyUp(rfb.canvas, { key: "a", code: "KeyA" });

    await waitFor(() => {
      expect(rfb.sendKey).toHaveBeenCalledWith(97, "KeyA");
    });
  });

  it("does not leave printable keys stuck when keyup never reaches the fallback handler", async () => {
    const { queryByText } = render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    await waitFor(() => {
      expect(rfb.focus).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(queryByText("vnc.connectingDesktop")).not.toBeInTheDocument();
    });

    fireEvent.pointerDown(rfb.target);
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB" });

    await waitFor(() => {
      expect(rfb.sendKey).toHaveBeenCalledWith(97, "KeyA");
      expect(rfb.sendKey).toHaveBeenCalledWith(98, "KeyB");
    });
  });

  it("does not duplicate key events that noVNC already consumed on the canvas", async () => {
    render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    await waitFor(() => {
      expect(rfb.focus).toHaveBeenCalled();
    });

    fireEvent.pointerDown(rfb.target);

    const consumed = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      bubbles: true,
      cancelable: true,
    });
    rfb.canvas.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { once: true });

    rfb.canvas.dispatchEvent(consumed);

    await waitFor(() => {
      expect(rfb.sendKey).not.toHaveBeenCalledWith(97, "KeyA", true);
    });
  });

  it("maps non-Latin printable keys to standard Unicode X11 keysyms", () => {
    expect(getTrackedVncKey({ key: "\u044f", code: "KeyZ" })).toEqual({
      code: "KeyZ",
      keysym: 0x0100044f,
    });
  });

  it("maps one astral Unicode code point instead of rejecting its surrogate pair", () => {
    expect(getTrackedVncKey({ key: "😀", code: "Unidentified" })).toEqual({
      code: null,
      keysym: 0x0101f600,
    });
  });

  it("re-focuses the VNC canvas after the window content stops suppressing pointer events", async () => {
    render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    const interactionHost = rfb.target.closest("[data-chrome-window-content]") as HTMLDivElement | null;
    expect(interactionHost).not.toBeNull();

    fireEvent.pointerDown(rfb.target);
    const focusCallsBeforeToggle = rfb.focus.mock.calls.length;

    interactionHost!.style.pointerEvents = "none";
    interactionHost!.style.pointerEvents = "";

    await waitFor(() => {
      expect(rfb.focus.mock.calls.length).toBeGreaterThan(focusCallsBeforeToggle);
    });
  });

  it("re-focuses the VNC surface after blur when the user left-clicks back into it", async () => {
    render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");
    const focusCallsBeforeBlur = rfb.focus.mock.calls.length;

    fireEvent(window, new Event("blur"));
    fireEvent.mouseDown(rfb.target);

    await waitFor(() => {
      expect(rfb.focus.mock.calls.length).toBeGreaterThan(focusCallsBeforeBlur);
    });
  });

  it("releases stale modifier keys when VNC focus is restored", async () => {
    render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    fireEvent.pointerDown(rfb.target);
    fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
    fireEvent(window, new Event("blur"));

    const sendKeyCallsBeforeRestore = rfb.sendKey.mock.calls.length;

    fireEvent.mouseDown(rfb.target);

    await waitFor(() => {
      expect(rfb.sendKey.mock.calls.length).toBeGreaterThan(sendKeyCallsBeforeRestore);
    });

    expect(rfb.sendKey).toHaveBeenCalledWith(0xffe3, "ControlLeft", false);
  });

  it("prevents local wheel default so VNC scrolling is not hijacked by page zoom", async () => {
    const { queryByText } = render(
      <div data-chrome-window-content="true">
        <VNCApp />
      </div>,
    );

    await waitFor(() => {
      expect(mockRfbInstances).toHaveLength(1);
    });

    const rfb = mockRfbInstances[0];
    rfb.emit("connect");

    await waitFor(() => {
      expect(rfb.focus).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(queryByText("vnc.connectingDesktop")).not.toBeInTheDocument();
    });

    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    rfb.canvas.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
