import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import { desktopTranslations } from "@/lib/desktop-translations";

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
        clawkeepStatus={{ state: null, reason: null, unconfigured: true, busy: false, restoring: false }}
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
        clawkeepStatus={{ state: "lapsed", reason: "stale", unconfigured: false, busy: false, restoring: false }}
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
        clawkeepStatus={{ state: "unprotected", reason: "never", unconfigured: false, busy: false, restoring: false }}
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
    const say = (over: Record<string, unknown>) => {
      const { unmount } = render(
        <ChromeShelf
          {...baseProps}
          onClawKeepShieldClick={vi.fn()}
          clawAiAuthenticated
          clawkeepStatus={{ unconfigured: false, busy: false, restoring: false, ...over }}
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
        clawkeepStatus={{ state: "lapsed", reason: "stale", unconfigured: true, busy: false, restoring: false }}
      />,
    );

    expect(screen.getByTestId("shelf-clawkeep-shield-button"))
      .toHaveAttribute("title", EN["shelf.clawkeepStale"]);
  });
});
