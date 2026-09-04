import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup, { CHAT_PANEL_GAP } from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { DESKTOP_GAP } from "@/lib/window-snap";

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * The docked chat's own margins, which nothing pinned before: it and a
 * maximized window are meant to be one gap from the screen edges and one gap
 * from each other, and the two were free to drift apart because only the
 * window side was under test.
 */

// ChromeShelf's height, the strip the docked panel sits above.
const SHELF_HEIGHT_PX = 56;
// What the panel opens at, and what it must report to the desktop unchanged.
const DEFAULT_PANEL_WIDTH = 420;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return { ok: true, json: async () => ({ provider: "openrouter", current: "", reasoning: "medium", providers: [], models: [] }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom ships no layout engine, so the message list's auto-scroll has nothing
  // to call. Unrelated to the geometry under test here.
  Element.prototype.scrollIntoView = vi.fn();
  // Hermes mode opens no socket, but the component still references the global.
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the docked chat's margins", () => {
  it("keeps the desktop's one gap on every side", () => {
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={DEFAULT_PANEL_WIDTH} />);
    const el = screen.getByTestId("chat-popup");
    expect(el.style.right).toBe(`${DESKTOP_GAP}px`);
    expect(el.style.top).toBe(`${DESKTOP_GAP}px`);
    // The safe-area inset is in the margin because a maximized window subtracts
    // it from its height too — otherwise the two bottom edges disagree on a
    // device that has one. Asserted in pieces because jsdom's CSS serializer
    // reorders the arguments of an `env()` nested in a `calc()`.
    expect(el.style.bottom).toContain(`${SHELF_HEIGHT_PX + DESKTOP_GAP}px`);
    expect(el.style.bottom).toContain("safe-area-inset-bottom");
    expect(el.style.width).toBe(`${DEFAULT_PANEL_WIDTH}px`);
  });

  it("is the same gap the maximized window keeps", () => {
    // page.tsx still imports the old name from this component; it has to be
    // the shared number, or the reserved strip and the window's margin drift.
    expect(CHAT_PANEL_GAP).toBe(DESKTOP_GAP);
  });

  it("reports its width alone, leaving the gap for the desktop to add", async () => {
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} onPanelModeChange={onPanelModeChange} />);
    fireEvent.click(await screen.findByTitle("Dock to right"));
    // Folding the gap in here would widen the panel by one gap on every reload,
    // because page.tsx persists what it is told and hands it back as the width.
    expect(onPanelModeChange).toHaveBeenCalledWith(DEFAULT_PANEL_WIDTH);
    expect(screen.getByTestId("chat-popup").style.right).toBe(`${DESKTOP_GAP}px`);
  });
});
