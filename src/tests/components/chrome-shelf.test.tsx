import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "shelf.openClawKeep": "Open ClawKeep",
        "shelf.clawkeepStale": "ClawKeep backup overdue",
        "shelf.clawkeepNotSetUp": "ClawKeep is not set up yet",
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

  it("blinks orange on a never-paired box, without calling the backup overdue", () => {
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ stale: false, unconfigured: true, busy: false, restoring: false }}
      />,
    );

    const shield = screen.getByTestId("shelf-clawkeep-shield-button");
    expect(shield).toHaveAttribute("title", "ClawKeep is not set up yet");
    const icon = shield.querySelector(".material-symbols-rounded");
    // Orange and blinking, so the invitation is noticed on a shelf nobody is
    // looking at. It used to sit there static and sky-blue.
    expect(icon?.className).toContain("text-orange-300");
    expect(icon?.className).toContain("clawkeep-shelf-glow-orange");
    expect(shield.querySelector(".clawkeep-shelf-pulse")).not.toBeNull();
    // Still not the RED overdue alert: nothing is late on a box that has never
    // been paired.
    expect(icon?.className).not.toContain("clawkeep-shelf-glow-red");
  });

  it("keeps the red overdue alert for a paired box whose backup is genuinely stale", () => {
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ stale: true, unconfigured: false, busy: false, restoring: false }}
      />,
    );

    const shield = screen.getByTestId("shelf-clawkeep-shield-button");
    expect(shield).toHaveAttribute("title", "ClawKeep backup overdue");
    const icon = shield.querySelector(".material-symbols-rounded");
    expect(icon?.className).toContain("clawkeep-shelf-glow-red");
  });

  it("goes amber, not red, once a box that WAS protected has drifted", () => {
    // ClawKeep's own card paints a lapsed box amber and a never-protected one
    // red. The shelf has to agree, or the distinction only exists on the
    // screen the owner has not opened.
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ stale: true, lapsed: true, unconfigured: false, busy: false, restoring: false }}
      />,
    );

    const shield = screen.getByTestId("shelf-clawkeep-shield-button");
    expect(shield).toHaveAttribute("title", "ClawKeep backup overdue");
    const icon = shield.querySelector(".material-symbols-rounded");
    expect(icon?.className).toContain("text-amber-400");
    expect(icon?.className).not.toContain("clawkeep-shelf-glow-red");
  });

  it("keeps the red alert on a PAIRED box that has never backed up", () => {
    // Distinct from the never-paired case above: pairing is the opt-in, so a
    // paired box with nothing in the cloud is genuinely unprotected and keeps
    // the red alert it has always had. Only `paired: false` earns the calm
    // setup shield (TASK-510).
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ stale: true, lapsed: false, unconfigured: false, busy: false, restoring: false }}
      />,
    );

    const icon = screen.getByTestId("shelf-clawkeep-shield-button")
      .querySelector(".material-symbols-rounded");
    expect(icon?.className).toContain("clawkeep-shelf-glow-red");
    expect(icon?.className).not.toContain("text-amber-400");
  });

  it("lets a stale flag win over unconfigured if both ever arrive together", () => {
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ stale: true, unconfigured: true, busy: false, restoring: false }}
      />,
    );

    expect(screen.getByTestId("shelf-clawkeep-shield-button"))
      .toHaveAttribute("title", "ClawKeep backup overdue");
  });
});
