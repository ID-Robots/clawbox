import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { snapshotDesktop, type DesktopState } from "@/lib/desktop-state";

/**
 * What the desktop re-renders, and what it does not (the performance sweep of
 * 2026-10-02).
 *
 * The desktop root is one component holding every window and the app in it,
 * the chat with its transcript, the mascot and the shelf, on screen 24/7 — on
 * one box as a 5120x1440 page over two monitors. It re-rendered all of it for
 * things none of them showed: the pairing poll answering what it answered last
 * time, a click on bare wallpaper, every pointer move of an icon drag or a
 * rubber-band selection; and its children's memo never held, because every
 * window, the chat and the mascot were handed fresh closures on every render.
 *
 * Counted here through stand-ins: the launcher's stand-in (not memoized, so it
 * renders whenever the desktop does) counts DESKTOP renders, and counts apart
 * the renders whose props were not what they were the time before — which is
 * exactly what the real, memoized launcher re-renders for; the chat and the
 * mascot are memoized like the real ones; Files and Settings count their own
 * renders. The toast host, the power prompt, the tier celebration and the
 * power menu are the REAL components, their memo boundary kept and their
 * renders counted inside it (`countedInside`). Each case also checks that what
 * the owner sees is still what it was.
 */

const count = vi.hoisted(() => ({
  desktop: 0, chat: 0, mascot: 0, files: 0, settings: 0,
  launcherProps: 0, toast: 0, power: 0, tier: 0, tray: 0,
}));
const seen = vi.hoisted(() => ({ settingsUi: [] as unknown[], launcherProps: null as Record<string, unknown> | null }));

/**
 * The real component with a counter INSIDE its memo boundary: a memo object
 * keeps its `$$typeof` and `compare` and gets a `type` that counts and then
 * renders the real one — so React decides, by the component's own memo, which
 * desktop renders reach it, and every one that does is counted. A component
 * that is not memoized is counted on every render of its parent, which is what
 * a case below then fails on.
 */
const countedInside = vi.hoisted(() => (bump: () => void, Real: unknown): unknown => {
  const real = Real as ((props: object) => unknown) & { $$typeof?: symbol; type?: (props: object) => unknown };
  if (real.$$typeof === Symbol.for("react.memo") && typeof real.type === "function") {
    const inner = real.type;
    return { ...real, type: (props: object) => { bump(); return inner(props); } };
  }
  return (props: object) => { bump(); return real(props); };
});

vi.mock("@/components/ChromeLauncher", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ChromeLauncher")>();
  return {
    ...real,
    // The real one stays reachable as `__real` for the memo check below.
    __real: real.default,
    default: (props: Record<string, unknown>) => {
      count.desktop++;
      // What the real launcher's memo compares: every prop by identity.
      const prev = seen.launcherProps;
      const changed = !prev
        || Object.keys(props).length !== Object.keys(prev).length
        || Object.keys(props).some((k) => !Object.is(props[k], prev[k]));
      if (changed) count.launcherProps++;
      seen.launcherProps = props;
      return null;
    },
  };
});
vi.mock("@/components/ToastHost", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ToastHost")>();
  return { ...real, default: countedInside(() => { count.toast++; }, real.default) };
});
vi.mock("@/components/PowerApprovalPrompt", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/PowerApprovalPrompt")>();
  return { ...real, default: countedInside(() => { count.power++; }, real.default) };
});
vi.mock("@/components/TierUpgradeCelebration", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/TierUpgradeCelebration")>();
  return { ...real, default: countedInside(() => { count.tier++; }, real.default) };
});
vi.mock("@/components/SystemTray", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/SystemTray")>();
  return { ...real, default: countedInside(() => { count.tray++; }, real.default) };
});
vi.mock("@/components/Mascot", async () => {
  const { memo } = await import("react");
  return { default: memo(function MascotStub() { count.mascot++; return null; }) };
});
vi.mock("@/components/ChatPopup", async () => {
  const { memo } = await import("react");
  return {
    default: memo(function ChatStub() { count.chat++; return null; }),
    CHAT_PANEL_GAP: 12,
    noticeColumnInset: () => 0,
  };
});
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));
vi.mock("@/components/FilesApp", () => ({ default: () => { count.files++; return <div data-testid="files-app-stub" />; } }));
vi.mock("@/components/SettingsApp", () => ({
  default: ({ ui }: { ui: unknown }) => { count.settings++; seen.settingsUi.push(ui); return <div data-testid="settings-app-stub" />; },
}));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function answer(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

let saved: DesktopState | null = null;
/** The owner-notice ring as the box holds it (`ui:pending-actions`). */
let ring: unknown[] = [];
/** What the power-approval route answers is pending. */
let powerPending: unknown = null;
/** The box's saved preferences (`/setup-api/preferences?all=1`). */
let prefs: Record<string, unknown> = {};
/** The pairing poll's answer, released by the case when it chooses. */
let pairing: { promise: Promise<unknown>; release: (body: unknown) => void };

function holdPairing() {
  let release: (body: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => { release = resolve; });
  pairing = { promise, release };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/desktop/state")) {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") return answer({ ok: true });
      return answer({ user: "clawbox", state: saved });
    }
    if (url.includes("/setup-api/users/me")) return answer({ username: "clawbox", isOwner: true, multiUser: false });
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    if (url.includes("/setup-api/telegram/pairing")) return answer(await pairing.promise);
    if (url.includes("/setup-api/kv?key=ui:pending-actions")) return answer({ value: JSON.stringify(ring) });
    if (url.includes("/setup-api/system/power/approval")) return answer({ pending: powerPending });
    if (url.includes("/setup-api/preferences?all=1")) return answer(prefs);
    return answer({});
  }));
}

const pairingPolls = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/setup-api/telegram/pairing"));
const approvalAsks = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/setup-api/system/power/approval"));

// The translation catalogue reaches the desktop through a dynamic import in
// I18nProvider, which on a cold, loaded worker takes 1-3 s: a case that counted
// renders across that moment counted the catalogue landing (every label from
// `app.files` to `Files`) as a render it was asking about. Loaded once here so
// the provider's import is a cache hit, and waited for in mountDesktop.
beforeAll(async () => {
  await import("@/lib/translations");
});

/**
 * Mount and let the load settle: preferences, the harness probe, the restored
 * windows — and the translations, which re-render everything once they land.
 */
async function mountDesktop() {
  render(<ChromeDesktop />);
  await screen.findByTestId("desktop-root");
  await waitFor(() => expect(pairingPolls().length).toBeGreaterThan(0));
  await waitFor(() => expect(iconWrapper("desktop-files").textContent).toContain("Files"));
  await wait(400);
}

function iconWrapper(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-desktop-icon-id="${id}"]`);
  if (!el) throw new Error(`no icon ${id}`);
  return el;
}

beforeEach(() => {
  for (const k of Object.keys(count) as (keyof typeof count)[]) count[k] = 0;
  seen.settingsUi = [];
  saved = null;
  ring = [];
  powerPending = null;
  prefs = {};
  seen.launcherProps = null;
  holdPairing();
  resetHarnessCache();
  _resetSessionUserForTest();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
  installFetch();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  pairing.release({ configured: false, pending: [] });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Telegram pairing poll", () => {
  it("re-renders nothing for an answer that is what the desktop already shows", async () => {
    await mountDesktop();
    const before = count.desktop;
    // A box with no bot: this is every answer it ever gets.
    await act(async () => { pairing.release({ configured: false, pending: [] }); await wait(50); });
    expect(count.desktop).toBe(before);
  });

  it("still puts a new access request on screen", async () => {
    await mountDesktop();
    await act(async () => {
      pairing.release({ configured: true, pending: [{ code: "PAIR1", id: "42", name: "Ann" }] });
      await wait(50);
    });
    expect(await screen.findByText("Approve")).toBeInTheDocument();
  });
});

describe("the chat and the mascot", () => {
  it("are not re-rendered by a desktop render that hands them nothing new", async () => {
    await mountDesktop();
    const chat = count.chat;
    const mascot = count.mascot;
    expect(chat).toBeGreaterThan(0);
    expect(mascot).toBeGreaterThan(0);
    const desktop = count.desktop;
    // The launcher opening is a desktop render…
    fireEvent.click(screen.getByTestId("shelf-launcher-button"));
    await waitFor(() => expect(count.desktop).toBeGreaterThan(desktop));
    // …and so is opening a window, which used to give the chat a new
    // `onOpenSettingsSection` (it hung off openApp, rebuilt on every open).
    fireEvent.click(iconWrapper("desktop-files").querySelector("button")!);
    expect(await screen.findByTestId("chrome-window-files")).toBeInTheDocument();
    expect(count.chat).toBe(chat);
    expect(count.mascot).toBe(mascot);
  });
});

describe("the apps in the windows", () => {
  beforeEach(() => {
    saved = snapshotDesktop([
      { id: "settings-1", appId: "settings", zIndex: 100, minimized: false, x: 700, y: 80, width: 600, height: 420 },
      { id: "files-1", appId: "files", zIndex: 101, minimized: false, x: 40, y: 60, width: 640, height: 400 },
    ], { savedAt: 1 });
  });

  it("are left alone by a desktop render that does not concern them — a window's focus included", async () => {
    await mountDesktop();
    const files = await screen.findByTestId("chrome-window-files");
    const settingsWin = screen.getByTestId("chrome-window-settings");
    await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
    const filesRenders = count.files;
    const settingsRenders = count.settings;
    const ui = seen.settingsUi.at(-1);

    const desktop = count.desktop;
    fireEvent.click(screen.getByTestId("shelf-launcher-button"));
    await waitFor(() => expect(count.desktop).toBeGreaterThan(desktop));

    // Bring Settings to the front: the two windows trade places, and their
    // apps have nothing new to draw.
    fireEvent.mouseDown(settingsWin);
    await waitFor(() => expect(settingsWin).toHaveAttribute("data-active", "true"));
    expect(files).toHaveAttribute("data-active", "false");
    expect(Number(settingsWin.style.zIndex)).toBeGreaterThan(Number(files.style.zIndex));

    expect(count.files).toBe(filesRenders);
    expect(count.settings).toBe(settingsRenders);
    // Settings' view of the desktop's appearance is the same object while
    // nothing about it changed.
    expect(seen.settingsUi.at(-1)).toBe(ui);
  });

  it("spends no layer and no desktop render on grabbing the window that is already in front", async () => {
    await mountDesktop();
    const files = await screen.findByTestId("chrome-window-files");
    await waitFor(() => expect(files).toHaveAttribute("data-active", "true"));
    const z = files.style.zIndex;
    const desktop = count.desktop;
    const titleBar = files.firstElementChild as HTMLElement;
    fireEvent.mouseDown(titleBar, { clientX: 200, clientY: 75, button: 0 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 75 });
    await wait(50);
    expect(files.style.zIndex).toBe(z);
    expect(count.desktop).toBe(desktop);
  });
});

describe("dragging a desktop icon", () => {
  it("follows the pointer without re-rendering the desktop on every move, and is let go where it was seen", async () => {
    await mountDesktop();
    const wrapper = iconWrapper("desktop-files");
    const button = wrapper.querySelector("button")!;
    fireEvent.pointerDown(button, { clientX: 100, clientY: 100, button: 0 });
    // Past the threshold: the icon is lifted out of the grid at once.
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 100 })); });
    expect(wrapper.style.position).toBe("fixed");
    expect(wrapper.style.left).toBe("80px");
    expect(wrapper.style.top).toBe("60px");

    const desktop = count.desktop;
    act(() => {
      for (let i = 1; i <= 5; i++) window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120 + i * 10, clientY: 100 + i * 4 }));
    });
    await wait(30);
    // The icon follows…
    expect(wrapper.style.transform).toBe("translate(50px, 20px)");
    // …and the desktop was not rebuilt for it.
    expect(count.desktop).toBe(desktop);

    // Let go: the offset becomes React's position again, then the icon is
    // back in the grid (jsdom has no layout, so there is no cell to drop on).
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 170, clientY: 120 })); });
    expect(wrapper.style.transform).toBe("");
    await waitFor(() => expect(wrapper.style.position).toBe("absolute"));
  });

  // A pointer the browser or the OS CANCELLED (it took the touch for itself)
  // is not a drop. Handled only on release, a cancel left the icon lifted at
  // its last offset with the listeners armed, so the next touch anywhere
  // dragged it on and the next release dropped it there.
  it("goes home when the system cancels the drag — gliding from where it was seen, the desktop unchanged, the gesture over", async () => {
    await mountDesktop();
    const wrapper = iconWrapper("desktop-files");
    const home = { left: wrapper.style.left, top: wrapper.style.top };
    expect(wrapper.style.position).toBe("absolute");
    // A grid with room in it, so a stray release could land on a cell.
    vi.spyOn(wrapper.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900, toJSON: () => ({}),
    } as DOMRect);
    // Where the glide home starts: what React has the icon at when the
    // browser is made to compute its style.
    const glideFrom: Array<{ left: string; transform: string }> = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((node: Element, pseudo?: string | null) => {
      if (node === wrapper) glideFrom.push({ left: wrapper.style.left, transform: wrapper.style.transform });
      return real(node, pseudo);
    });

    fireEvent.pointerDown(wrapper.querySelector("button")!, { clientX: 100, clientY: 100, button: 0 });
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 100 })); });
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 470, clientY: 300 })); });
    expect(wrapper.style.transform).toBe("translate(350px, 200px)");

    act(() => { window.dispatchEvent(new PointerEvent("pointercancel")); });

    expect(wrapper.style.transform).toBe("");
    // From the point it was last seen at (the icon is drawn 40px up and left
    // of the pointer), not from where the drag began.
    expect(glideFrom.at(-1)).toEqual({ left: "430px", transform: "" });
    await waitFor(() => expect(wrapper.style.position).toBe("absolute"));
    expect({ left: wrapper.style.left, top: wrapper.style.top }).toEqual(home);

    // The gesture is over: a move lifts nothing and a release over another
    // cell drops nothing there.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 500 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 900, clientY: 500 }));
    });
    await wait(30);
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.transform).toBe("");
    expect({ left: wrapper.style.left, top: wrapper.style.top }).toEqual(home);
  });

  it("opens no long-press menu for a touch the system cancelled while it was held", async () => {
    await mountDesktop();
    fireEvent.pointerDown(iconWrapper("desktop-files").querySelector("button")!, { clientX: 100, clientY: 100, button: 0 });
    act(() => { window.dispatchEvent(new PointerEvent("pointercancel")); });
    // Past the 500 ms that makes a held touch a long press.
    await act(async () => { await wait(650); });
    expect(screen.queryByTestId("desktop-context-menu")).toBeNull();
  });
});

// iOS cannot run here, so what is pinned is what it is handed. A held touch on
// a desktop icon is the desktop's own long press (500 ms → the icon menu); on
// an iPhone or iPad the same hold over a picture is also iOS's image callout
// and its image drag, and iOS takes the touch for those with a pointercancel —
// which ends the gesture (the case above), so the menu never opened there.
describe("a touch held on a desktop icon", () => {
  const INVOICES = { name: "Invoices", color: "#335577", iconUrl: "" };

  it("gives iOS no callout and no image drag to take it — every icon's button, and every picture in it", async () => {
    prefs = { installed_apps: ["invoices"], installed_meta: { invoices: INVOICES } };
    await mountDesktop();
    await waitFor(() => iconWrapper("invoices"));
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("[data-desktop-icon-id] > button"));
    const pictures = Array.from(document.querySelectorAll<HTMLImageElement>("[data-desktop-icon-id] img"));
    // Not vacuous: an installed app's picture (InstalledAppIcon) and a
    // built-in's (the crab, AppIcon) are both on the grid.
    expect(buttons.length).toBeGreaterThan(2);
    expect(iconWrapper("invoices").querySelector("img")?.getAttribute("src")).toBe("/setup-api/apps/icon/invoices");
    expect(iconWrapper("desktop-clawbox").querySelector("img")?.getAttribute("src")).toBe("/clawbox-crab.png");
    // On the button, because the property is inherited: it reaches the
    // picture and the label alike.
    for (const button of buttons) expect(button.classList.contains("[-webkit-touch-callout:none]")).toBe(true);
    for (const picture of pictures) expect(picture.getAttribute("draggable")).toBe("false");
  });

  it("still opens the icon menu where it was held — on the picture as on the tile", async () => {
    prefs = { installed_apps: ["invoices"], installed_meta: { invoices: INVOICES } };
    await mountDesktop();
    await waitFor(() => iconWrapper("invoices"));
    const picture = iconWrapper("invoices").querySelector("img")!;
    fireEvent.pointerDown(picture, { clientX: 300, clientY: 200, button: 0, pointerType: "touch" });
    // Held, not moved, past the 500 ms that makes it a long press.
    await act(async () => { await wait(650); });
    const menu = screen.getByTestId("desktop-context-menu");
    // The ICON's menu (Open first), placed at the hold.
    expect(menu.textContent).toContain("open_in_new");
    expect(menu.style.left).toBe("300px");
    expect(menu.style.top).toBe("200px");
  });
});

describe("the rubber-band selection", () => {
  it("draws the band and selects without a desktop render per move — and measures the icons once", async () => {
    await mountDesktop();
    // Where the icons are: Files at 200..300, everything else far away.
    const original = HTMLElement.prototype.getBoundingClientRect;
    let iconMeasures = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute("data-desktop-icon-id");
      if (!id) return original.call(this);
      iconMeasures++;
      const at = id === "desktop-files" ? 200 : 5000;
      return { left: at, top: at, right: at + 100, bottom: at + 100, width: 100, height: 100, x: at, y: at, toJSON: () => ({}) } as DOMRect;
    });

    const surface = screen.getByTestId("desktop-surface");
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, button: 0 });
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, clientY: 150 })); });
    const band = await screen.findByTestId("desktop-marquee");
    expect(band.style.left).toBe("100px");
    expect(band.style.width).toBe("50px");
    const measured = iconMeasures;
    expect(measured).toBeGreaterThan(0);

    const desktop = count.desktop;
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, clientY: 160 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 170, clientY: 175 }));
    });
    await wait(30);
    expect(band.style.width).toBe("70px");
    expect(band.style.height).toBe("75px");
    expect(count.desktop).toBe(desktop);

    // Reaching an icon selects it: that IS something to draw.
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 250, clientY: 250 })); });
    await waitFor(() => expect(iconWrapper("desktop-files").querySelector("button")!.className).toContain("ring-2"));
    expect(iconMeasures).toBe(measured);

    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 250, clientY: 250 })); });
    await waitFor(() => expect(screen.queryByTestId("desktop-marquee")).toBeNull());
    expect(iconWrapper("desktop-files").querySelector("button")!.className).toContain("ring-2");
  });

  it("takes the band down when the system cancels the gesture, and stretches it to no later touch", async () => {
    await mountDesktop();
    const surface = screen.getByTestId("desktop-surface");
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, button: 0 });
    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, clientY: 150 })); });
    await screen.findByTestId("desktop-marquee");

    act(() => { window.dispatchEvent(new PointerEvent("pointercancel")); });
    await waitFor(() => expect(screen.queryByTestId("desktop-marquee")).toBeNull());

    act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, clientY: 300 })); });
    await wait(30);
    expect(screen.queryByTestId("desktop-marquee")).toBeNull();
  });

  it("re-renders nothing for a click on bare wallpaper with nothing selected", async () => {
    await mountDesktop();
    const desktop = count.desktop;
    const surface = screen.getByTestId("desktop-surface");
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, button: 0 });
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 100, clientY: 100 })); });
    await wait(30);
    expect(count.desktop).toBe(desktop);
  });
});

describe("the shell's own widgets", () => {
  it("include a memoized launcher", async () => {
    // Its stand-in counts desktop renders, so the real one's memo is checked
    // here, and what that memo compares — the props — is counted below. The
    // other four are the real components in every case.
    const mod = (await import("@/components/ChromeLauncher")) as unknown as { __real: { $$typeof?: symbol } };
    expect(mod.__real.$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("are left alone by desktop renders that hand them nothing new", async () => {
    await mountDesktop();
    // Each has rendered: the counters see the real components.
    expect(count.toast).toBeGreaterThan(0);
    expect(count.power).toBeGreaterThan(0);
    expect(count.tier).toBeGreaterThan(0);
    expect(count.tray).toBeGreaterThan(0);
    expect(count.launcherProps).toBeGreaterThan(0);
    const before = { ...count };

    // Desktop renders that concern none of them: a window opened and the
    // desktop's focus moved to it, then a new access request from the
    // pairing poll.
    fireEvent.click(iconWrapper("desktop-files").querySelector("button")!);
    expect(await screen.findByTestId("chrome-window-files")).toBeInTheDocument();
    await act(async () => {
      pairing.release({ configured: true, pending: [{ code: "PAIR1", id: "42", name: "Ann" }] });
      await wait(50);
    });
    expect(await screen.findByText("Approve")).toBeInTheDocument();
    expect(count.desktop).toBeGreaterThan(before.desktop);

    expect(count.toast).toBe(before.toast);
    expect(count.power).toBe(before.power);
    expect(count.tier).toBe(before.tier);
    expect(count.tray).toBe(before.tray);
    // The launcher's props are what they were, so its memo holds.
    expect(count.launcherProps).toBe(before.launcherProps);
  });

  it("still re-render for what they show — the launcher and the power menu opening", async () => {
    await mountDesktop();
    const launcher = count.launcherProps;
    fireEvent.click(screen.getByTestId("shelf-launcher-button"));
    await waitFor(() => expect(count.launcherProps).toBe(launcher + 1));
    expect(seen.launcherProps?.isOpen).toBe(true);

    const tray = count.tray;
    fireEvent.click(screen.getAllByTestId("shelf-power-button")[0]);
    expect(await screen.findByTestId("system-tray")).toBeInTheDocument();
    expect(count.tray).toBeGreaterThan(tray);
  });
});

describe("a power request", () => {
  it("reaches the confirmation prompt through the notice ring, not through a poll of its own", async () => {
    await mountDesktop();
    // The prompt asked once, on mount.
    const asked = approvalAsks().length;
    expect(asked).toBeGreaterThan(0);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // The agent asks for a restart: src/lib/power-approval.ts puts a
    // `power_approval` notice — and nothing of the request — on the ring.
    powerPending = { id: "a".repeat(32), action: "restart", reason: "a quoted reason", expiresAt: Date.now() + 120_000 };
    ring = [{ id: `power-approval:${"a".repeat(32)}:asked`, ts: Date.now(), type: "power_approval" }];
    // Within the ring's 2 s poll (the wait allows for a loaded worker).
    expect(await screen.findByText("a quoted reason", {}, { timeout: 6_000 })).toBeInTheDocument();
    expect(approvalAsks().length).toBe(asked + 1);

    // Answered on another desktop: the ring says so, and it goes.
    powerPending = null;
    ring = [...ring, { id: `power-approval:${"a".repeat(32)}:settled`, ts: Date.now(), type: "power_approval" }];
    await waitFor(() => expect(screen.queryByText("a quoted reason")).toBeNull(), { timeout: 6_000 });
    expect(approvalAsks().length).toBe(asked + 2);
  });
});
