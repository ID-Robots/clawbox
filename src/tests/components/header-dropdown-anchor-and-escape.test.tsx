// Three defects the UI sweep found on the chat's composer pills, all of them
// invisible to the existing suites because jsdom has no layout engine and no
// second Escape listener on the page.
//
//   1. Escape closed the whole CHAT, not just the open menu: the popup's own
//      window-level handler was registered first and neither listener stopped
//      the key.
//   2. A menu that flipped above its pill floated 180-240px over it, in the
//      middle of the transcript, because the flip anchored the list's TOP at
//      `trigger.top - gap - maxHeight` — a cap, not the list's real height.
//   3. The FIRST keyboard open never moved focus into the list: the popover
//      renders one commit after the one that opens it (the position is
//      measured in between), and the focus effect had no reason to run again.
import { describe, expect, it, vi, afterEach } from "vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { HeaderDropdown, type HeaderDropdownOption } from "@/components/HeaderDropdown";

const LEVELS: HeaderDropdownOption[] = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** What `compute()` reserves around the trigger. Mirrored from the component. */
const GAP_PX = 6;

function rectAt(top: number, height = 20): DOMRect {
  return {
    x: 300, y: top, left: 300, top, right: 380, bottom: top + height,
    width: 80, height, toJSON: () => ({}),
  } as DOMRect;
}

/**
 * The chat popup's shape, reduced to the part that matters here: a surface
 * that closes itself on a window-level Escape, with a pill inside it. The
 * listener is registered on mount, i.e. before the menu's own — which is the
 * ordering the real popup has, and the reason it used to win.
 */
function ChatLikeHost({ onOuterEscape }: { onOuterEscape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onOuterEscape(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOuterEscape]);
  return (
    <HeaderDropdown
      ariaLabel="Reasoning effort"
      value="medium"
      options={LEVELS}
      onChange={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Escape on an open pill menu", () => {
  it("closes the menu and stops there, leaving the chat around it open", () => {
    const onOuterEscape = vi.fn();
    render(<ChatLikeHost onOuterEscape={onOuterEscape} />);
    const trigger = screen.getByRole("button", { name: /^Reasoning effort:/ });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Reasoning effort" });

    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    // The whole point: the surface the pill lives in never heard the key.
    expect(onOuterEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("lets the surface have the key once no menu is open", () => {
    const onOuterEscape = vi.fn();
    render(<ChatLikeHost onOuterEscape={onOuterEscape} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOuterEscape).toHaveBeenCalledTimes(1);
  });
});

describe("a menu with no room below its pill", () => {
  it("hangs from the pill's top edge instead of floating over the transcript", () => {
    window.innerWidth = 1440;
    window.innerHeight = 900;
    render(
      <HeaderDropdown
        ariaLabel="Reasoning effort"
        value="medium"
        options={LEVELS}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Reasoning effort:/ });
    // A composer pill sits at the bottom of the chat: 88px of screen under it,
    // which is less than the 160px the list would like, so it flips.
    const triggerTop = 792;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rectAt(triggerTop));

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Reasoning effort" });

    // Anchored by its BOTTOM edge, so the four rows sit against the pill
    // whatever they measure. The old code set `top` to 792 - 6 - 320 = 466 and
    // left a 180px hole between the list and the control it belongs to.
    expect(listbox.style.bottom).toBe(`${900 - triggerTop + GAP_PX}px`);
    expect(listbox.style.top).toBe("");
  });

  it("still anchors by the top when it opens downward", () => {
    window.innerWidth = 1440;
    window.innerHeight = 900;
    render(
      <HeaderDropdown
        ariaLabel="Reasoning effort"
        value="medium"
        options={LEVELS}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Reasoning effort:/ });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rectAt(120));
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Reasoning effort" });
    expect(listbox.style.top).toBe(`${120 + 20 + GAP_PX}px`);
    expect(listbox.style.bottom).toBe("");
  });
});

describe("the first keyboard open of a pill", () => {
  it("moves focus into the list even though the popover mounts a commit later", () => {
    render(
      <HeaderDropdown
        ariaLabel="Reasoning effort"
        value="medium"
        options={LEVELS}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Reasoning effort:/ });
    // On the box the list is portaled only once its position has been
    // measured, so the commit that opens it renders no rows at all. jsdom
    // hides that (its layout effect and the re-render it schedules land in the
    // same act flush), so the sequence is forced here: the first measurement
    // finds no rect, and the popover appears on the next one.
    let measured = 0;
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => {
      measured += 1;
      return (measured === 1 ? undefined : rectAt(200)) as unknown as DOMRect;
    });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent(window, new Event("resize"));

    const listbox = screen.getByRole("listbox", { name: "Reasoning effort" });
    expect(listbox).toBeTruthy();
    // Without this the pill kept focus: arrows did nothing and Tab left the
    // menu hanging open behind the next control.
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    expect(document.activeElement?.textContent).toContain("Medium");
  });
});
