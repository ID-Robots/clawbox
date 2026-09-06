import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeLauncher from "@/components/ChromeLauncher";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return { useT: () => ({ t: (key: string) => desktopTranslations.en[key] ?? key }) };
});

/**
 * The launcher is a MODAL — a full-screen backdrop with a grid on top — and it
 * has to behave like one: above everything else on the desktop, dismissed by
 * Escape wherever the focus went, and out of the way once its action is done.
 */

function apps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `app-${i}`,
    name: `App ${i}`,
    color: "#f97316",
    icon: <span>{`A${i}`}</span>,
  }));
}

function launcher(overrides: Partial<React.ComponentProps<typeof ChromeLauncher>> = {}) {
  const props = {
    apps: apps(9),
    isOpen: true,
    onClose: vi.fn(),
    onAppClick: vi.fn(),
    ...overrides,
  };
  return { ...render(<ChromeLauncher {...props} />), props };
}

describe("ChromeLauncher", () => {
  it("opens above the chat instead of behind it", () => {
    // At 9998/9999 against the chat's 10010 the chat painted over the grid:
    // nine of twelve tiles were unclickable and a click on one landed in the
    // chat's composer.
    launcher();
    const panel = Number(screen.getByTestId("app-launcher").style.zIndex);
    const backdrop = Number(screen.getByTestId("app-launcher-backdrop").style.zIndex);
    expect(backdrop).toBeGreaterThan(DESKTOP_LAYERS.chat);
    expect(panel).toBeGreaterThan(backdrop);
  });

  it("closes on Escape when the focus has left the panel", async () => {
    // The key handler used to ride on the panel div, so as soon as a tile's
    // context menu or an action took the focus away, Escape did nothing and the
    // only way out was to find the backdrop and click it.
    const { props } = launcher();
    document.body.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("closes itself after Add to desktop, which happens behind it", async () => {
    const onAddToDesktop = vi.fn();
    const { props } = launcher({ onAddToDesktop });
    fireEvent.contextMenu(screen.getByText("App 0"));
    fireEvent.click(screen.getByText("Add to desktop"));
    expect(onAddToDesktop).toHaveBeenCalledWith("app-0");
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("names its page dots, which have no text of their own", () => {
    launcher();
    const dots = screen.getAllByRole("button", { name: /^Page \d$/ });
    expect(dots.length).toBeGreaterThan(1);
    expect(dots[0]).toHaveAttribute("aria-current", "true");
    expect(dots[1]).not.toHaveAttribute("aria-current");
  });
});
