import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import type { KioskTabView } from "@/lib/kiosk-tabs-client";

/**
 * The kiosk Chrome's tabs on the shelf (x64 laptop, `--kiosk`, no tab strip
 * of its own — src/lib/kiosk-tabs.ts). The shelf is handed the list; this
 * pins what it draws from it and which callback each gesture is.
 */

// The shipped English strings WITH interpolation, since these labels name the tab.
vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let s = desktopTranslations.en[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v));
        return s;
      },
    }),
  };
});

function app(id: string, name: string): { id: string; name: string; icon: ReactNode; isOpen: boolean; isActive: boolean; isPinned: boolean } {
  return { id, name, icon: <span>{name}</span>, isOpen: false, isActive: false, isPinned: true };
}

const DESKTOP: KioskTabView = { id: "D1", title: "ClawBox", url: "http://localhost:3005/", favicon: "", isDesktop: true };
const SIGNIN: KioskTabView = {
  id: "S1",
  title: "Sign in — Anthropic",
  url: "https://claude.ai/oauth",
  favicon: "https://claude.ai/favicon.ico",
  isDesktop: false,
};
const BLANK: KioskTabView = { id: "B1", title: "", url: "https://clawbox.com/store?q=x", favicon: "", isDesktop: false };

const base = {
  apps: [app("settings", "Settings")],
  onAppClick: vi.fn(),
  onLauncherClick: vi.fn(),
  onTrayClick: vi.fn(),
  time: "12:34",
};

describe("ChromeShelf kiosk tabs", () => {
  it("draws nothing when there are no kiosk tabs, or only the desktop's own", () => {
    const { rerender } = render(<ChromeShelf {...base} />);
    expect(screen.queryByTestId("shelf-kiosk-tabs")).not.toBeInTheDocument();
    rerender(<ChromeShelf {...base} kioskTabs={[DESKTOP]} />);
    expect(screen.queryByTestId("shelf-kiosk-tabs")).not.toBeInTheDocument();
  });

  it("lists every page the kiosk opened, never the desktop tab itself", () => {
    render(<ChromeShelf {...base} kioskTabs={[DESKTOP, SIGNIN, BLANK]} />);
    const group = screen.getByTestId("shelf-kiosk-tabs");
    expect(group).toHaveAttribute("aria-label", "Browser tabs");
    expect(screen.getByTestId("shelf-kiosk-tab-S1")).toBeInTheDocument();
    expect(screen.getByTestId("shelf-kiosk-tab-B1")).toBeInTheDocument();
    expect(screen.queryByTestId("shelf-kiosk-tab-D1")).not.toBeInTheDocument();
  });

  it("shows the favicon and title, and falls back to the host for an untitled page", () => {
    render(<ChromeShelf {...base} kioskTabs={[SIGNIN, BLANK]} />);
    const signin = screen.getByTestId("shelf-kiosk-tab-S1");
    expect(signin.querySelector("img")).toHaveAttribute("src", SIGNIN.favicon);
    expect(signin).toHaveTextContent("Sign in — Anthropic");
    expect(screen.getByRole("button", { name: "Switch to “Sign in — Anthropic”" })).toBeInTheDocument();

    const blank = screen.getByTestId("shelf-kiosk-tab-B1");
    expect(blank.querySelector("img")).toBeNull();
    expect(blank).toHaveTextContent("clawbox.com");
    expect(screen.getByRole("button", { name: "Switch to “clawbox.com”" })).toBeInTheDocument();
  });

  it("a click activates the tab and the x closes it — and only it", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(<ChromeShelf {...base} kioskTabs={[SIGNIN]} onKioskTabClick={onClick} onKioskTabClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch to “Sign in — Anthropic”" }));
    expect(onClick).toHaveBeenCalledWith("S1");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("shelf-kiosk-tab-close-S1"));
    expect(onClose).toHaveBeenCalledWith("S1");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("shelf-kiosk-tab-close-S1")).toHaveAttribute("aria-label", "Close “Sign in — Anthropic”");
  });
});
