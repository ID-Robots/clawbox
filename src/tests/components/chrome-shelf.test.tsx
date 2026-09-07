import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import { desktopTranslations } from "@/lib/desktop-translations";
import type { Protection } from "@/lib/clawkeep-protection";

// The shipped English strings, not a hand-copied set: a mock that drifts from
// production turns "the shield announces X" into "the mock returns X".
vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    useT: () => ({ t: (key: string) => desktopTranslations.en[key] ?? key }),
  };
});

const EN = desktopTranslations.en;

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
        clawkeepStatus={{ protection: null, unconfigured: true, busy: false, restoring: false }}
      />,
    );

    const shield = screen.getByTestId("shelf-clawkeep-shield-button");
    expect(shield).toHaveAttribute("title", EN["shelf.clawkeepNotSetUp"]);
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

  it("goes amber, not red, once a box that WAS protected has drifted", () => {
    // ClawKeep's own card paints a lapsed box amber and a never-protected one
    // red. The shelf has to agree, or the distinction only exists on the
    // screen the owner has not opened.
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ protection: { state: "lapsed", reason: "stale" }, unconfigured: false, busy: false, restoring: false }}
      />,
    );

    const shield = screen.getByTestId("shelf-clawkeep-shield-button");
    expect(shield).toHaveAttribute("title", EN["shelf.clawkeepStale"]);
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
        clawkeepStatus={{ protection: { state: "unprotected", reason: "never" }, unconfigured: false, busy: false, restoring: false }}
      />,
    );

    const icon = screen.getByTestId("shelf-clawkeep-shield-button")
      .querySelector(".material-symbols-rounded");
    expect(icon?.className).toContain("clawkeep-shelf-glow-red");
    expect(icon?.className).not.toContain("text-amber-400");
  });

  it("says which kind of unprotected it is, instead of leaving it to the colour", () => {
    // Amber-vs-red is the whole point of the two states above, and hue is not
    // an announcement: a screen reader got "ClawKeep backup overdue" for both
    // (WCAG 2.2 SC 1.4.1). "Overdue" was wrong for the other two reasons too —
    // a run that ran and failed is not late, and neither is one refusing to
    // start.
    const say = (protection: Protection) => {
      const { unmount } = render(
        <ChromeShelf
          {...baseProps}
          onClawKeepShieldClick={vi.fn()}
          clawAiAuthenticated
          clawkeepStatus={{ protection, unconfigured: false, busy: false, restoring: false }}
        />,
      );
      const shield = screen.getByTestId("shelf-clawkeep-shield-button");
      const title = shield.getAttribute("title");
      // The tooltip and the accessible name are the same sentence, so nobody
      // gets the vaguer of the two.
      expect(shield).toHaveAttribute("aria-label", title as string);
      unmount();
      return title;
    };

    const said = [
      say({ state: "lapsed", reason: "stale" }),
      say({ state: "lapsed", reason: "error" }),
      say({ state: "lapsed", reason: "blocked" }),
      say({ state: "unprotected", reason: "never" }),
    ];
    expect(said).toEqual([
      EN["shelf.clawkeepStale"],
      EN["shelf.clawkeepFailed"],
      EN["shelf.clawkeepBlocked"],
      EN["shelf.clawkeepNeverBackedUp"],
    ]);
    expect(new Set(said).size).toBe(said.length);
    expect(say({ state: "protected", reason: "ok" })).toBe(EN["shelf.openClawKeep"]);
  });

  it("lets a live verdict win over unconfigured if both ever arrive together", () => {
    render(
      <ChromeShelf
        {...baseProps}
        onClawKeepShieldClick={vi.fn()}
        clawAiAuthenticated
        clawkeepStatus={{ protection: { state: "lapsed", reason: "stale" }, unconfigured: true, busy: false, restoring: false }}
      />,
    );

    expect(screen.getByTestId("shelf-clawkeep-shield-button"))
      .toHaveAttribute("title", EN["shelf.clawkeepStale"]);
  });

  it("has exactly one App Launcher button", () => {
    // The desktop branch carried a second, `sm:hidden` copy that could never be
    // seen (anything under 768px renders the mobile bar instead) but was always
    // in the DOM: two elements answered the test id — a strict-locator failure —
    // and assistive tech was offered the same control twice.
    render(<ChromeShelf {...baseProps} />);

    expect(screen.getAllByTestId("shelf-launcher-button")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: EN["shelf.appLauncher"] })).toHaveLength(1);
  });

  it("closes a shelf context menu on Escape", () => {
    // Neither menu takes focus, so nothing on the page was listening for the
    // key: a click somewhere harmless was the only way out.
    render(<ChromeShelf {...baseProps} onShelfSettings={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId("shelf-app-settings"));
    expect(screen.getByText(EN["shelf.unpinFromShelf"])).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(EN["shelf.unpinFromShelf"])).not.toBeInTheDocument();
  });
});

describe("the phone bar", () => {
  const baseProps = {
    apps: [makeApp("settings", "Settings")],
    onAppClick: vi.fn(),
    onLauncherClick: vi.fn(),
    onTrayClick: vi.fn(),
    time: "12:34",
  };

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  it("draws Settings and the apps that are open, so an app switched away from can be reached again", () => {
    // `pinnedApps`/`unpinnedApps` were filtered for the phone and never drawn:
    // the bar was launcher, fullscreen and power, nothing said which apps were
    // open, and an app minimized with "Switch app" vanished without a trace.
    const onAppClick = vi.fn();
    const files = { ...makeApp("files", "Files"), isOpen: true, isPinned: false };
    // Pinned on the desktop shelf but closed: the phone's home grid already has it.
    const terminal = makeApp("terminal", "Terminal");
    render(
      <ChromeShelf {...baseProps} apps={[makeApp("settings", "Settings"), files, terminal]} onAppClick={onAppClick} />,
    );

    const row = screen.getByTestId("shelf-mobile-apps");
    expect(row).toContainElement(screen.getByTestId("shelf-app-settings"));
    expect(row).toContainElement(screen.getByTestId("shelf-app-files"));
    expect(screen.queryByTestId("shelf-app-terminal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("shelf-app-files"));
    expect(onAppClick).toHaveBeenCalledWith("files");
  });

  it("still draws an open Settings the owner unpinned", () => {
    const settings = { ...makeApp("settings", "Settings"), isOpen: true, isPinned: false };
    render(<ChromeShelf {...baseProps} apps={[settings]} />);

    expect(screen.getByTestId("shelf-app-settings")).toBeInTheDocument();
  });

  it("keeps the chat button in the tray, out of the scrolling app row, in the desktop bar's order", () => {
    // A phone in landscape (or a small tablet): narrower than 768 and wider
    // than it is tall — the one phone bar that draws the crab at all. It sat
    // in the app row for a moment, after every open app: with a handful open
    // the row overflows, and the one button that opens the assistant scrolled
    // out of sight with them.
    Object.defineProperty(window, "innerWidth", { value: 667, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 375, configurable: true });
    const onChatClick = vi.fn();
    const files = { ...makeApp("files", "Files"), isOpen: true, isPinned: false };
    render(
      <ChromeShelf {...baseProps} apps={[makeApp("settings", "Settings"), files]} showChatButton onChatClick={onChatClick} />,
    );

    const chat = screen.getByTestId("shelf-chat-button");
    expect(screen.getByTestId("shelf-mobile-apps")).not.toContainElement(chat);
    // Ahead of the clock, where the desktop bar keeps it.
    const tray = screen.getByTestId("shelf-tray-button");
    expect(chat.compareDocumentPosition(tray) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(chat);
    expect(onChatClick).toHaveBeenCalledTimes(1);
  });
});
