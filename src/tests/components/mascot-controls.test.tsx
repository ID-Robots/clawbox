// The mascot as a CONTROL, which is what it is on a desktop that hides the
// shelf's chat button while the crab is out.
//
// Defects this covers, from the UI sweep:
//   - the mascot was a bare <div>: no role, no tab stop, no accessible name,
//     so the primary way into the chat could not be reached from a keyboard or
//     named by a screen reader;
//   - its right-click menu ignored Escape (only an outside click closed it);
//   - and that menu was painted straight over the speech bubble it opened on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";

// `t` answers the key, as it does on a box whose dictionaries do not carry
// these strings yet — so what renders here is the component's English floor.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (k: string) => k, locale: "en", localeResolved: true }),
}));
vi.mock("@/lib/client-kv", () => ({
  get: () => null,
  getJSON: () => null,
  set: vi.fn(),
  setJSON: vi.fn(),
  remove: vi.fn(),
}));

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

async function mountMascot(onTap = vi.fn()) {
  const view = render(<Mascot onTap={onTap} />);
  const mascot = await waitFor(() => {
    const el = view.container.querySelector("[data-mascot]");
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  return { ...view, mascot, onTap };
}

beforeEach(() => {
  installMatchMedia();
  vi.stubGlobal("requestAnimationFrame", () => 1 as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("reaching the mascot from the keyboard", () => {
  it("is a named button in the tab order", async () => {
    const { mascot } = await mountMascot();
    expect(mascot.getAttribute("role")).toBe("button");
    expect(mascot.getAttribute("tabindex")).toBe("0");
    expect(mascot.getAttribute("aria-label")).toBe("Open chat");
    expect(screen.getByRole("button", { name: "Open chat" })).toBe(mascot);
  });

  it("opens the chat on Enter and on Space, like a tap", async () => {
    const { mascot, onTap } = await mountMascot();
    fireEvent.keyDown(mascot, { key: "Enter" });
    expect(onTap).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(mascot, { key: " " });
    expect(onTap).toHaveBeenCalledTimes(2);
    // Anything else is the desktop's business, not the mascot's.
    fireEvent.keyDown(mascot, { key: "a" });
    expect(onTap).toHaveBeenCalledTimes(2);
  });
});

describe("the mascot's right-click menu", () => {
  it("closes on Escape, not only on a click elsewhere", async () => {
    const { mascot } = await mountMascot();
    fireEvent.contextMenu(mascot, { clientX: 200, clientY: 400 });
    const hide = await screen.findByText("Hide mascot");

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("Hide mascot")).toBeNull());
    expect(hide.isConnected).toBe(false);
  });

  it("does not paint itself over the words the mascot is saying", async () => {
    const { container, mascot } = await mountMascot();
    // The frenzy easter egg is the deterministic way to make it speak.
    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    await waitFor(() => expect(container.querySelector('[data-speech="1"]')).toBeTruthy());

    fireEvent.contextMenu(mascot, { clientX: 200, clientY: 400 });

    expect(screen.getByText("Hide mascot")).toBeTruthy();
    // The menu is drawn upward from the cursor, exactly where the bubble hangs.
    expect(container.querySelector('[data-speech="1"]')).toBeNull();
  });
});
