import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import { desktopTranslations } from "@/lib/desktop-translations";
import type { Protection } from "@/lib/clawkeep-protection";

// The shipped English strings, not a hand-copied set: a mock that drifts from
// production turns "the shield announces X" into "the mock returns X".
vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    // Placeholders are filled as the real `t` fills them, so a sentence that
    // carries a figure is asserted with the figure in it.
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let text = desktopTranslations.en[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      },
    }),
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

  it("says why a backup was REFUSED, with sizes, instead of a bare \"failed\"", () => {
    // The daemon would not upload: the account cannot hold the backup, or its
    // usage could not be counted. "Last backup failed — open to see why" told
    // the owner of a full account nothing they could act on from the shelf.
    const say = (protection: Protection, refusal: unknown) => {
      const { unmount } = render(
        <ChromeShelf
          {...baseProps}
          onClawKeepShieldClick={vi.fn()}
          clawAiAuthenticated
          clawkeepStatus={{
            protection, unconfigured: false, busy: false, restoring: false,
            refusal: refusal as never,
          }}
        />,
      );
      const shield = screen.getByTestId("shelf-clawkeep-shield-button");
      const title = shield.getAttribute("title");
      expect(shield).toHaveAttribute("aria-label", title as string);
      unmount();
      return title;
    };
    const failed: Protection = { state: "lapsed", reason: "error" };
    // 1.2 GB needed, 307 MB free — the figures the ClawKeep card prints.
    const noRoom = { kind: "quota_full", neededBytes: 1_288_490_189, freeBytes: 322_122_547 };

    expect(say(failed, noRoom)).toBe(
      "Last ClawKeep backup needs 1.2 GB but only 307 MB is free — open to see your options",
    );
    // Nothing free at all is "0 B", not a missing figure.
    expect(say(failed, { ...noRoom, freeBytes: 0 })).toBe(
      "Last ClawKeep backup needs 1.2 GB but only 0 B is free — open to see your options",
    );
    expect(say(failed, { kind: "usage_unverified", neededBytes: 5, freeBytes: 0 })).toBe(
      EN["shelf.clawkeepUsageUnverified"],
    );
    // A near miss — 1.24 GB against 1.21 GB — is not "needs 1.2 GB but only
    // 1.2 GB is free".
    expect(say(failed, { kind: "quota_full", neededBytes: 1_331_439_862, freeBytes: 1_299_227_607 })).toBe(
      "Last ClawKeep backup needs 1.24 GB but only 1.21 GB is free — open to see your options",
    );
    // No raw byte count, and no unfilled placeholder, ever reaches the shelf.
    for (const title of [say(failed, noRoom), say(failed, { ...noRoom, freeBytes: 0 })]) {
      expect(title).not.toMatch(/\d{7,}|[{}]/);
    }

    // A failure that recorded no refusal keeps the sentence it had …
    expect(say(failed, null)).toBe(EN["shelf.clawkeepFailed"]);
    expect(say(failed, undefined)).toBe(EN["shelf.clawkeepFailed"]);
    // … and a refusal is the reason behind an "error", never a verdict of its
    // own: a box that has moved on, or lapsed for another reason, says that.
    expect(say({ state: "protected", reason: "ok" }, noRoom)).toBe(EN["shelf.openClawKeep"]);
    expect(say({ state: "lapsed", reason: "stale" }, noRoom)).toBe(EN["shelf.clawkeepStale"]);
    expect(say({ state: "lapsed", reason: "blocked" }, noRoom)).toBe(EN["shelf.clawkeepBlocked"]);
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

  it("draws its bar as a flat tint and its menus with no blur under their opaque fill", () => {
    // A backdrop blur on the bar was redone over the WHOLE bar whenever
    // anything changed under any part of it — the mascot standing on it, the
    // shield's pulse, a window beneath. The menus are opaque, so a blur under
    // them could never be seen at all.
    const { container } = render(<ChromeShelf {...baseProps} onShelfSettings={vi.fn()} />);
    const bar = container.querySelector("[data-mascot-ground]") as HTMLElement;
    expect(bar.style.background).toBe("rgba(17, 24, 39, 0.8)");
    expect(bar.getAttribute("style")).not.toMatch(/backdrop/);

    fireEvent.contextMenu(screen.getByTestId("shelf-app-settings"));
    const appMenu = screen.getByText(EN["shelf.unpinFromShelf"]).closest("div.fixed") as HTMLElement;
    expect(appMenu.className).toContain("bg-[#2d2d2d]");
    expect(appMenu.className).not.toMatch(/backdrop-blur/);
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.contextMenu(bar);
    const shelfMenu = screen.getByText(EN["shelf.shelfSettings"]).closest("div.fixed") as HTMLElement;
    expect(shelfMenu.className).toContain("bg-[#2d2d2d]");
    expect(shelfMenu.className).not.toMatch(/backdrop-blur/);
  });
});

describe("the phone bar", () => {
  const baseProps = {
    apps: [makeApp("settings", "Settings")],
    onAppClick: vi.fn(),
    onLauncherClick: vi.fn(),
    onTrayClick: vi.fn(),
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

  it("fills the phone bar more opaquely than the desktop shelf, so the icons scrolling under it do not read through", () => {
    // The phone's icon grid scrolls UNDER the bar. At the shelf's 0.8 the
    // tiles and their white labels showed through sharp — readable ghost
    // text, where the old blur left only a glow — so the phone bar is 0.93.
    const { container } = render(<ChromeShelf {...baseProps} />);
    const bar = container.querySelector("[data-mascot-ground]") as HTMLElement;
    expect(screen.getByTestId("shelf-mobile-apps")).toBeInTheDocument();
    expect(bar.style.background).toBe("rgba(17, 24, 39, 0.93)");
    expect(bar.getAttribute("style")).not.toMatch(/backdrop/);
    // The same hairline as the desktop shelf.
    expect(bar.style.borderTop).toBe("1px solid rgba(255, 255, 255, 0.1)");

    // A phone in landscape is the phone bar too.
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 667, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 375, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(bar.style.background).toBe("rgba(17, 24, 39, 0.93)");

    // Widened past the phone layout, it is the desktop shelf again, at the
    // shelf's own fill (the one kiosk/extension/bar.js copies).
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByTestId("shelf-mobile-apps")).not.toBeInTheDocument();
    expect(bar.style.background).toBe("rgba(17, 24, 39, 0.8)");
  });

  it("still draws an open Settings the owner unpinned", () => {
    const settings = { ...makeApp("settings", "Settings"), isOpen: true, isPinned: false };
    render(<ChromeShelf {...baseProps} apps={[settings]} />);

    expect(screen.getByTestId("shelf-app-settings")).toBeInTheDocument();
  });

  it("draws the chat button on a portrait phone too — the way back to the chat from the desktop", () => {
    // A phone lands in the chat (src/lib/mobile-chat-first.ts); once the owner
    // has gone to the desktop, this crab is how they get back to it.
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    const onChatClick = vi.fn();
    render(<ChromeShelf {...baseProps} apps={[makeApp("settings", "Settings")]} showChatButton onChatClick={onChatClick} />);

    const chat = screen.getByTestId("shelf-chat-button");
    expect(screen.getByTestId("shelf-mobile-apps")).not.toContainElement(chat);
    fireEvent.click(chat);
    expect(onChatClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the chat button in the tray, out of the scrolling app row, in the desktop bar's order", () => {
    // A phone in landscape (or a small tablet): narrower than 768 and wider
    // than it is tall — the phone bar that also draws the clock. It sat
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

describe("the fullscreen button", () => {
  // The shelf offers fullscreen only while there is one to enter. It used to
  // turn into an "exit fullscreen" button and stay on the bar — a control
  // nobody needs on a screen the desktop already fills (the browser's own
  // gesture leaves), and on the box's own screen the one button that could
  // take the desktop OUT of the mode it is meant to be in.
  const baseProps = {
    apps: [makeApp("settings", "Settings")],
    onAppClick: vi.fn(),
    onLauncherClick: vi.fn(),
    onTrayClick: vi.fn(),
  };
  const realMatchMedia = window.matchMedia;

  function setWindowSize(key: "innerWidth" | "innerHeight" | "outerWidth" | "outerHeight", value: number) {
    Object.defineProperty(window, key, { value, configurable: true });
  }

  /** The page's own fullscreen: `document.fullscreenElement`, and its event. */
  function setFullscreenElement(el: Element | null) {
    Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  }

  /** The browser's fullscreen (F11, `--kiosk`): only the media query says so. */
  function mockDisplayModeFullscreen(initial: boolean) {
    const listeners = new Set<() => void>();
    const list = {
      matches: initial,
      media: "(display-mode: fullscreen)",
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.mocked(window.matchMedia).mockImplementation((query: string) =>
      (query === list.media ? list : { matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
    );
    return {
      set(matches: boolean) {
        list.matches = matches;
        act(() => listeners.forEach((fn) => fn()));
      },
      listeners,
    };
  }

  beforeEach(() => {
    // A page that is the whole window, as under F11: no browser chrome.
    setWindowSize("innerWidth", 1024);
    setWindowSize("innerHeight", 768);
    setWindowSize("outerWidth", 1024);
    setWindowSize("outerHeight", 768);
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { value: realMatchMedia, configurable: true, writable: true });
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  });

  it("is offered, named, while the page is not fullscreen — and asks for it", () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: requestFullscreen, configurable: true });
    render(<ChromeShelf {...baseProps} />);

    const button = screen.getByTestId("shelf-fullscreen-button");
    expect(button).toHaveAttribute("title", EN["shelf.fullscreen"]);
    expect(button).toHaveAttribute("aria-label", EN["shelf.fullscreen"]);
    fireEvent.click(button);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("does nothing, rather than throw, where the browser has no element fullscreen", () => {
    // An iPhone's Safari: `requestFullscreen` is not there to call.
    expect("requestFullscreen" in document.documentElement).toBe(false);
    render(<ChromeShelf {...baseProps} />);

    expect(() => fireEvent.click(screen.getByTestId("shelf-fullscreen-button"))).not.toThrow();
  });

  it("leaves the bar once the page is fullscreen, and comes back when it is not", () => {
    render(<ChromeShelf {...baseProps} />);
    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();

    setFullscreenElement(document.documentElement);
    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
    // Nothing takes its place: no exit button, under any name.
    expect(document.body.textContent).not.toContain("fullscreen_exit");
    // The buttons either side of it are untouched.
    expect(screen.getByTestId("shelf-tray-button")).toBeInTheDocument();
    expect(screen.getByTestId("shelf-power-button")).toBeInTheDocument();

    setFullscreenElement(null);
    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();
  });

  it("is not drawn at all on a page that mounts already fullscreen", () => {
    Object.defineProperty(document, "fullscreenElement", { value: document.documentElement, configurable: true });
    render(<ChromeShelf {...baseProps} />);

    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
  });

  it("is hidden while the BROWSER is fullscreen (F11, a kiosk window), where no element is", () => {
    // `document.fullscreenElement` is null under F11 and `--kiosk`; the button
    // there offered a fullscreen the screen already had.
    const displayMode = mockDisplayModeFullscreen(true);
    render(<ChromeShelf {...baseProps} />);
    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();

    displayMode.set(false);
    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();

    displayMode.set(true);
    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
  });

  it("counts a zoomed page as the whole window: zoom scales both axes alike", () => {
    // Measured on the box's own screen at 110%: 1920×1080 outside, 1745×982 in.
    setWindowSize("outerWidth", 1920);
    setWindowSize("outerHeight", 1080);
    setWindowSize("innerWidth", 1745);
    setWindowSize("innerHeight", 982);
    mockDisplayModeFullscreen(true);
    render(<ChromeShelf {...baseProps} />);

    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
  });

  it("stays while a fullscreen browser WINDOW still shows its toolbar, and goes when the toolbar does", () => {
    // A Mac's green-button fullscreen keeps the tab strip and address bar and
    // still answers `display-mode: fullscreen`. The button is the only thing
    // on the page that makes the desktop fill that screen.
    setWindowSize("outerWidth", 1440);
    setWindowSize("outerHeight", 900);
    setWindowSize("innerWidth", 1440);
    setWindowSize("innerHeight", 813);
    mockDisplayModeFullscreen(true);
    render(<ChromeShelf {...baseProps} />);
    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();

    // "Always Show Toolbar in Full Screen" switched off: no query changes,
    // only the page's size.
    setWindowSize("innerHeight", 900);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
  });

  it("stops listening when the shelf goes away", () => {
    const displayMode = mockDisplayModeFullscreen(false);
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<ChromeShelf {...baseProps} />);
    expect(displayMode.listeners.size).toBe(1);
    const onFullscreenChange = added.mock.calls.filter(([type]) => type === "fullscreenchange").map(([, fn]) => fn);
    expect(onFullscreenChange).toHaveLength(1);

    unmount();
    expect(displayMode.listeners.size).toBe(0);
    expect(removed.mock.calls.some(([type, fn]) => type === "fullscreenchange" && fn === onFullscreenChange[0])).toBe(true);
    added.mockRestore();
    removed.mockRestore();
  });

  it("follows the same rule on the phone bar", () => {
    setWindowSize("innerWidth", 390);
    setWindowSize("innerHeight", 844);
    render(<ChromeShelf {...baseProps} />);
    expect(screen.getByTestId("shelf-mobile-apps")).toBeInTheDocument();
    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();

    setFullscreenElement(document.documentElement);
    expect(screen.queryByTestId("shelf-fullscreen-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("shelf-power-button")).toBeInTheDocument();
  });

  it("stays on the bar where the browser has no matchMedia at all", () => {
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true, writable: true });
    render(<ChromeShelf {...baseProps} />);

    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();
  });

  it("stays on the bar where matchMedia throws", () => {
    vi.mocked(window.matchMedia).mockImplementation(() => {
      throw new Error("no media queries here");
    });
    render(<ChromeShelf {...baseProps} />);

    expect(screen.getByTestId("shelf-fullscreen-button")).toBeInTheDocument();
  });
});
