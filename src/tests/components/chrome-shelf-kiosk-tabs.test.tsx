import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import { KIOSK_PAGES_APP_ID, kioskPageTabs, type KioskTabView } from "@/lib/kiosk-tabs-client";

/**
 * The kiosk Chrome's pages on the shelf (x64 laptop, `--kiosk`, no tab strip
 * of its own — src/lib/kiosk-tabs.ts). They are ONE app on the shelf, Web,
 * drawn like any other open app; the pages themselves are named and switched
 * in the kiosk bar across the top (kiosk/extension/bar.js). page.tsx maps the
 * tabs onto that app; this pins the shelf's half and the helper it maps with.
 */

vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    useT: () => ({
      t: (key: string) => desktopTranslations.en[key] ?? key,
    }),
  };
});

type TestApp = {
  id: string;
  name: string;
  icon: ReactNode;
  isOpen: boolean;
  isActive: boolean;
  isPinned: boolean;
  windowCount?: number;
  external?: boolean;
};

function app(id: string, name: string, extra: Partial<TestApp> = {}): TestApp {
  return { id, name, icon: <span>{name}</span>, isOpen: false, isActive: false, isPinned: true, ...extra };
}

const DESKTOP: KioskTabView = { id: "D1", title: "ClawBox", url: "http://localhost:3005/", favicon: "", isDesktop: true };
const SIGNIN: KioskTabView = { id: "S1", title: "Sign in", url: "https://claude.ai/oauth", favicon: "", isDesktop: false };
const STORE: KioskTabView = { id: "B1", title: "", url: "https://clawbox.com/store", favicon: "", isDesktop: false };

const base = {
  onAppClick: vi.fn(),
  onLauncherClick: vi.fn(),
  onTrayClick: vi.fn(),
  time: "12:34",
};

describe("kioskPageTabs", () => {
  it("is every tab but the desktop's, in the order the server gave (most recently used first)", () => {
    expect(kioskPageTabs([STORE, DESKTOP, SIGNIN])).toEqual([STORE, SIGNIN]);
    expect(kioskPageTabs([DESKTOP])).toEqual([]);
    expect(kioskPageTabs([])).toEqual([]);
  });

  it("stands for the Web app", () => {
    expect(KIOSK_PAGES_APP_ID).toBe("web");
  });
});

describe("ChromeShelf and the kiosk's pages", () => {
  it("draws no tab pills of its own — only app icons", () => {
    render(<ChromeShelf {...base} apps={[app("settings", "Settings"), app("web", "Web", { isOpen: true, isPinned: false, windowCount: 2, external: true })]} />);
    expect(screen.queryByTestId("shelf-kiosk-tabs")).not.toBeInTheDocument();
    expect(screen.getByTestId("shelf-app-web")).toBeInTheDocument();
  });

  it("gives Web one dot per open page, like an app's windows", () => {
    render(<ChromeShelf {...base} apps={[app("web", "Web", { isOpen: true, isPinned: false, windowCount: 3, external: true })]} />);
    const dots = screen.getByTestId("shelf-app-web").querySelectorAll("div.rounded-full.h-1");
    expect(dots).toHaveLength(3);
  });

  it("clicking Web is an app click; page.tsx decides which page it brings back", () => {
    const onAppClick = vi.fn();
    render(<ChromeShelf {...base} onAppClick={onAppClick} apps={[app("web", "Web", { isOpen: true, isPinned: false, windowCount: 1, external: true })]} />);
    fireEvent.click(screen.getByTestId("shelf-app-web"));
    expect(onAppClick).toHaveBeenCalledWith("web");
  });

  it("offers a new tab in Web's menu, not a window or its own /app page", () => {
    const onNewWindow = vi.fn();
    render(<ChromeShelf {...base} onNewWindow={onNewWindow} apps={[app("web", "Web", { isOpen: false, isPinned: true, external: true })]} />);
    fireEvent.contextMenu(screen.getByTestId("shelf-app-web"));
    // Offered whether or not a page is open: a new tab is what "new" means here.
    fireEvent.click(screen.getByTestId("shelf-ctx-new-tab"));
    expect(onNewWindow).toHaveBeenCalledWith("web");
    fireEvent.contextMenu(screen.getByTestId("shelf-app-web"));
    expect(screen.queryByText("New Window")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Open in new tab/)).toHaveLength(1);
  });

  it("keeps the window entries for an ordinary app", () => {
    render(<ChromeShelf {...base} onNewWindow={vi.fn()} apps={[app("files", "Files", { isOpen: true })]} />);
    fireEvent.contextMenu(screen.getByTestId("shelf-app-files"));
    expect(screen.queryByTestId("shelf-ctx-new-tab")).not.toBeInTheDocument();
    expect(screen.getByText(/Open in new tab/)).toBeInTheDocument();
  });
});
