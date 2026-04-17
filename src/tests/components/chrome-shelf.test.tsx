import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "shelf.openClawKeep": "Open ClawKeep",
        "shelf.connectClawBoxAI": "Connect ClawBox AI",
        "shelf.appLauncher": "App Launcher",
        "shelf.systemSettings": "System Settings",
        "shelf.power": "Power",
        "shelf.chat": "Chat",
        "shelf.fullscreen": "Fullscreen",
        "shelf.exitFullscreen": "Exit Fullscreen",
      };
      return translations[key] ?? key;
    },
  }),
}));

function makeApp(id: string, name: string): { id: string; name: string; icon: ReactNode; isOpen: boolean; isActive: boolean; isPinned?: boolean } {
  return {
    id,
    name,
    icon: <span>{name}</span>,
    isOpen: false,
    isActive: false,
    isPinned: true,
  };
}

describe("ChromeShelf", () => {
  const baseProps = {
    apps: [makeApp("settings", "Settings")],
    onAppClick: vi.fn(),
    onLauncherClick: vi.fn(),
    onTrayClick: vi.fn(),
    time: "12:34",
  };

  it("hides the ClawKeep shield when no handler is provided", () => {
    render(<ChromeShelf {...baseProps} />);

    expect(screen.queryByTestId("shelf-clawkeep-shield-button")).not.toBeInTheDocument();
  });

  it("shows the ClawKeep shield when a handler is provided", () => {
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
      />,
    );

    expect(screen.getByTestId("shelf-clawkeep-shield-button")).toBeInTheDocument();
  });
});
