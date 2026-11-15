import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";

// The tray's screenshot button draws only while the desktop's capture overlay
// is mounted; here it always is, so the whole tray is on the page.
vi.mock("@/lib/screenshot/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/screenshot/session")>()),
  desktopOverlayMounted: () => true,
}));

vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    useT: () => ({ t: (key: string) => desktopTranslations.en[key] ?? key }),
  };
});

/**
 * TASK-2565 — the bottom shelf's tray took no part in layout.
 *
 * On the desktop bar the tray (chat crab, shield, screenshot, clock,
 * fullscreen, user, power) was `absolute right-2` over an app row centred on
 * the WHOLE bar. Nothing reserved the tray's width, so between ~768 and ~1100px
 * a row of several apps slid under it and the crab and the clock were drawn on
 * top of app icons.
 *
 * jsdom has no layout engine, so these pin the STRUCTURE that makes the bar
 * right by construction — a tray that is in flow beside an app row that is
 * allowed to shrink and scroll — at a spread of widths. The pixels are proved in
 * a real browser by e2e/shelf-layout.spec.ts.
 */

const WIDTHS = [280, 320, 375, 400, 412, 600, 667, 767, 768, 820, 880, 1024, 1280, 1440, 1920];

function makeApp(id: string, extra: { isOpen?: boolean; isPinned?: boolean } = {}) {
  return {
    id,
    name: id,
    icon: <span>{id}</span> as ReactNode,
    isOpen: false,
    isActive: false,
    isPinned: true,
    ...extra,
  };
}

const FEW = [makeApp("settings"), makeApp("files"), makeApp("store")];
const MANY = [
  ...["settings", "files", "store", "terminal", "browser", "coding", "clawkeep", "memory-shard", "prime-radiant"].map((id) => makeApp(id, { isOpen: true })),
  ...["vnc", "screenshot", "chrome"].map((id) => makeApp(id, { isOpen: true, isPinned: false })),
];

function renderAt(width: number, apps = MANY, height = 900) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  return render(
    <ChromeShelf
      apps={apps}
      onAppClick={vi.fn()}
      onLauncherClick={vi.fn()}
      onTrayClick={vi.fn()}
      onPowerClick={vi.fn()}
      onChatClick={vi.fn()}
      onClawKeepShieldClick={vi.fn()}
      showChatButton
      clawAiAuthenticated
      sessionUser={{ username: "ivan", isOwner: true }}
    />,
  );
}

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
});

describe("the shelf's tray and app row, at every width", () => {
  for (const [name, apps] of [["a few apps", FEW], ["many apps", MANY]] as const) {
    describe(name, () => {
      for (const width of WIDTHS) {
        it(`is in flow beside an app row that can shrink and scroll, at ${width}px`, () => {
          renderAt(width, apps);

          const row = screen.getByTestId(width < 768 ? "shelf-mobile-apps" : "shelf-desktop-apps");
          const tray = screen.getByTestId("shelf-tray");
          const launcher = screen.getByTestId("shelf-launcher-button");

          // The tray is a flex item, not a box lifted out of the row...
          expect(classesOf(tray)).not.toContain("absolute");
          expect(classesOf(tray)).not.toContain("fixed");
          // ...in the same row as the launcher and the apps, so what it takes is
          // what the apps do not get.
          const barRow = tray.parentElement!;
          expect(barRow).toContainElement(row);
          expect(barRow).toContainElement(launcher);
          expect(row.parentElement).toBe(barRow);
          expect(barRow.className).toContain("flex");
          // Wide enough for its buttons: never squeezed below them.
          expect(classesOf(tray).some((c) => c === "flex-none" || c === "min-w-max")).toBe(true);

          // The apps are what give way: they shrink below their icons, scroll,
          // and keep their first icon reachable once they overflow.
          const rowClasses = classesOf(row);
          expect(rowClasses).toContain("min-w-0");
          expect(rowClasses).toContain("overflow-x-auto");
          expect(rowClasses).toContain("justify-center-safe");
          expect(rowClasses).not.toContain("absolute");

          // Nothing in the bar's own row is positioned out of the flow.
          for (const child of Array.from(barRow.children)) {
            expect(classesOf(child)).not.toContain("absolute");
          }
        });
      }
    });
  }

  it("draws the phone bar below 768px and the desktop bar from it", () => {
    renderAt(767);
    expect(screen.getByTestId("shelf-mobile-apps")).toBeInTheDocument();
    expect(screen.queryByTestId("shelf-desktop-apps")).not.toBeInTheDocument();
  });

  it("draws the desktop bar from 768px", () => {
    renderAt(768);
    expect(screen.getByTestId("shelf-desktop-apps")).toBeInTheDocument();
    expect(screen.queryByTestId("shelf-mobile-apps")).not.toBeInTheDocument();
  });

  it("keeps the launcher out of the scrolling row, so a long row never carries it away", () => {
    renderAt(880);
    expect(screen.getByTestId("shelf-desktop-apps")).not.toContainElement(screen.getByTestId("shelf-launcher-button"));
    expect(screen.getByTestId("shelf-desktop-apps")).toContainElement(screen.getByTestId("shelf-app-settings"));
  });

  it("keeps the same apps and the same tray buttons on the desktop bar whatever the width", () => {
    // Every one of them stays in the DOM and is shed, if at all, by the bar's
    // own width (below): the bar no longer drops a button for a phone.
    for (const width of [768, 1024, 1920]) {
      const { unmount } = renderAt(width);
      for (const id of ["shelf-chat-button", "shelf-clawkeep-shield-button", "shelf-tray-button", "shelf-user-badge", "shelf-power-button"]) {
        expect(screen.getByTestId(id), `${id} at ${width}px`).toBeInTheDocument();
      }
      expect(screen.getAllByTestId(/^shelf-app-/)).toHaveLength(MANY.length);
      unmount();
    }
  });
});

describe("the tray sheds by the room the bar has, not by the device", () => {
  /** The rem thresholds of every `@max-[…]:hidden` an element or its ancestors up to the tray carry. */
  function shedAt(el: Element, tray: Element): number[] {
    const found: number[] = [];
    for (let node: Element | null = el; node && node !== tray; node = node.parentElement) {
      for (const c of classesOf(node)) {
        const m = /^@max-\[([\d.]+)rem\]:hidden$/.exec(c);
        if (m) found.push(Number(m[1]));
      }
    }
    return found;
  }

  it("never sheds the chat crab, the signed-in user or power", () => {
    renderAt(320);
    const tray = screen.getByTestId("shelf-tray");
    for (const id of ["shelf-chat-button", "shelf-user-badge", "shelf-power-button"]) {
      expect(shedAt(screen.getByTestId(id), tray), id).toEqual([]);
    }
  });

  it("sheds the shield last, the clock before it and the screenshot and battery first", () => {
    const { container } = renderAt(1024);
    const tray = screen.getByTestId("shelf-tray");
    const [shield] = shedAt(screen.getByTestId("shelf-clawkeep-shield-button"), tray);
    const [clock] = shedAt(screen.getByTestId("shelf-tray-button"), tray);
    const [screenshot] = shedAt(screen.getByTestId("shelf-screenshot-button"), tray);

    expect(shield).toBeDefined();
    expect(clock).toBeDefined();
    expect(screenshot).toBeDefined();
    // A button that leaves while the bar is still WIDER leaves sooner.
    expect(screenshot).toBeGreaterThan(clock);
    expect(clock).toBeGreaterThan(shield);
    // The container the queries read is the bar's row itself.
    expect(container.querySelector(".\\@container")).toBe(tray.parentElement);
  });

  it("keeps every button a direct child of the tray, in the desktop bar's order", () => {
    renderAt(1024);
    const order = Array.from(screen.getByTestId("shelf-tray").children).map((child) => child.getAttribute("data-testid") ?? "fullscreen");
    expect(order.filter((id) => id !== "fullscreen")).toEqual([
      "shelf-chat-button",
      "shelf-clawkeep-shield-button",
      "shelf-screenshot-button",
      "shelf-tray-button",
      "shelf-user-badge",
      "shelf-power-button",
    ]);
  });

  it("does not look at the orientation: a nearly square window and a portrait one of the same width have the same tray", () => {
    // The old rule hid the shield, screenshot, battery and clock only on a
    // portrait phone (narrower than 500 and taller than wide), so a 400x390
    // window kept the whole tray and the bar overflowed it.
    const square = renderAt(400, MANY, 390);
    const squareTray = screen.getByTestId("shelf-tray").innerHTML;
    square.unmount();
    const portrait = renderAt(400, MANY, 900);
    expect(screen.getByTestId("shelf-tray").innerHTML).toBe(squareTray);
    portrait.unmount();
  });
});

describe("the app names", () => {
  it("shows a hovered app's name outside the app row, which scrolls and would clip it", () => {
    renderAt(880);
    const row = screen.getByTestId("shelf-desktop-apps");
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    const tip = screen.getByTestId("shelf-tooltip");
    expect(tip).toHaveTextContent("files");
    expect(row).not.toContainElement(tip);
    expect(classesOf(tip)).toContain("fixed");

    fireEvent.mouseLeave(screen.getByTestId("shelf-app-files"));
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });

  it("drops the name on a click, as a tap would leave it showing for good", () => {
    renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    expect(screen.getByTestId("shelf-tooltip")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("shelf-app-files"));
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });

  it("drops the name when the row scrolls, and while a menu is open", () => {
    renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    fireEvent.scroll(screen.getByTestId("shelf-desktop-apps"));
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    fireEvent.contextMenu(screen.getByTestId("shelf-app-files"));
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });
});

describe("the app names, once the bar changes under a resting pointer", () => {
  // No mouseleave fires for a button that unmounts or moves while the pointer
  // rests on it: the name would be left floating where its icon no longer is.
  it("drops the name of an app that has left the bar", () => {
    const view = renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-vnc"));
    expect(screen.getByTestId("shelf-tooltip")).toHaveTextContent("vnc");

    view.rerender(
      <ChromeShelf
        apps={MANY.filter((a) => a.id !== "vnc")}
        onAppClick={vi.fn()}
        onLauncherClick={vi.fn()}
        onTrayClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("shelf-app-vnc")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });

  it("drops the name when the window is resized, as the icons are not where they were", () => {
    renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    expect(screen.getByTestId("shelf-tooltip")).toBeInTheDocument();

    fireEvent(window, new Event("resize"));
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });

  it("drops the name when the shelf's own menu opens", () => {
    const { container } = renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    expect(screen.getByTestId("shelf-tooltip")).toBeInTheDocument();

    fireEvent.contextMenu(container.querySelector("[data-mascot-ground]")!);
    expect(screen.queryByTestId("shelf-tooltip")).not.toBeInTheDocument();
  });

  it("is hidden from assistive tech, which already has the button's own name", () => {
    renderAt(880);
    fireEvent.mouseEnter(screen.getByTestId("shelf-app-files"));
    expect(screen.getByTestId("shelf-tooltip")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("the app row's wheel", () => {
  it("turns a vertical wheel into a sideways scroll, so a mouse can reach what the row scrolled away", () => {
    renderAt(880);
    const row = screen.getByTestId("shelf-desktop-apps");
    row.scrollLeft = 0;

    fireEvent.wheel(row, { deltaY: 120 });
    expect(row.scrollLeft).toBe(120);
  });

  it("counts a notch in lines (Firefox) as lines, not as pixels", () => {
    renderAt(880);
    const row = screen.getByTestId("shelf-desktop-apps");
    row.scrollLeft = 0;

    fireEvent.wheel(row, { deltaY: 3, deltaMode: 1 });
    expect(row.scrollLeft).toBe(48);
  });

  it("leaves a trackpad's own sideways swipe alone", () => {
    renderAt(880);
    const row = screen.getByTestId("shelf-desktop-apps");
    row.scrollLeft = 0;

    fireEvent.wheel(row, { deltaX: 40, deltaY: 10 });
    expect(row.scrollLeft).toBe(0);
  });
});
