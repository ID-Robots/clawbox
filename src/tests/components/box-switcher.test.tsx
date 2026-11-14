import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import BoxSwitcherIndicator from "@/components/BoxSwitcherIndicator";
import { useBoxSwitcher } from "@/lib/use-box-switcher";
import {
  ARRIVAL_STORAGE_KEY,
  CARRIED_STORAGE_KEY,
  CARRY_PREFIX,
  KIOSK_SWITCHER_ATTR,
  LINKED_BOXES_CHANGED_EVENT,
  LINKED_BOXES_URL,
  encodeCarried,
  readCarriedHash,
} from "@/lib/box-switcher";

/**
 * The desktop's linked-box switcher (TASK-2519), driven through real key
 * events on `window`: Ctrl+Shift+<n> navigates this tab to box <n> carrying
 * the numbering, Ctrl+Shift+1 is this box, the indicator says what happened,
 * and a tab that arrives carrying another box's numbering keeps it only for
 * boxes this box lists too. Every string is read from the real catalogue.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { translations: table } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) => {
    let s = table.en[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  return {
    ...actual,
    useT: () => ({ t, locale: "en", localeResolved: true, setLocale: () => {} }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const HOME = "https://main.example.com";
const LAPTOP = "https://laptop.example.com";

function Harness({ enabled = true }: { enabled?: boolean }) {
  const { indicator, dismiss } = useBoxSwitcher(enabled);
  return <BoxSwitcherIndicator indicator={indicator} top={0} onDone={dismiss} />;
}

let assign: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.spyOn>;
let savedLocation: PropertyDescriptor | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

function at(origin: string, hash = "") {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin, href: `${origin}/${hash}`, pathname: "/", search: "", hash, assign, replace: vi.fn(), reload: vi.fn() },
  });
}

function serve(list: { selfName: string; boxes: { name: string; url: string }[] }) {
  fetchMock = vi.fn(async (url: string) => {
    if (url === LINKED_BOXES_URL) {
      return new Response(JSON.stringify({ self: { name: list.selfName }, boxes: list.boxes, max: 8 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function press(n: number, target: Element | Window = window, extra: Partial<KeyboardEventInit> = {}) {
  return fireEvent.keyDown(target, { code: `Digit${n}`, key: "!", ctrlKey: true, shiftKey: true, ...extra });
}

const loaded = () => waitFor(() => expect(fetchMock).toHaveBeenCalledWith(LINKED_BOXES_URL, expect.anything()));
const indicator = () => screen.queryByTestId("box-switcher-indicator");

beforeEach(() => {
  savedLocation = Object.getOwnPropertyDescriptor(window, "location");
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => undefined);
  sessionStorage.clear();
  document.documentElement.removeAttribute(KIOSK_SWITCHER_ATTR);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(KIOSK_SWITCHER_ATTR);
});

describe("on the box the owner started from", () => {
  beforeEach(() => {
    at(HOME);
    serve({ selfName: "main", boxes: [{ name: "Laptop", url: `${LAPTOP}/` }] });
  });

  it("Ctrl+Shift+2 opens the laptop's desktop in this tab, carrying the numbering, and says so", async () => {
    render(<Harness />);
    await loaded();
    await waitFor(() => {
      expect(press(2)).toBe(false); // the browser's own use of the key is stopped
      expect(assign).toHaveBeenCalled();
    });
    const url = String(assign.mock.calls[0][0]);
    expect(url.startsWith(`${LAPTOP}/${CARRY_PREFIX}`)).toBe(true);
    expect(readCarriedHash(url.slice(url.indexOf("#"))).carried).toEqual({
      to: 2,
      boxes: [{ name: "main", url: `${HOME}/` }, { name: "Laptop", url: `${LAPTOP}/` }],
    });
    expect(indicator()).toHaveAttribute("data-kind", "go");
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("Opening Laptop…");
    expect(screen.getByTestId("box-switcher-dot-2")).toHaveAttribute("data-lit", "true");
    expect(screen.getByTestId("box-switcher-dot-1")).not.toHaveAttribute("data-lit");
  });

  it("Ctrl+Shift+1 is this box: no navigation, the indicator names it, and goes on its own", async () => {
    render(<Harness />);
    await loaded();
    await waitFor(() => {
      press(1);
      expect(indicator()).toHaveAttribute("data-kind", "stay");
    });
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("1 · main");
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(indicator()).toBeNull(), { timeout: 3000 });
  });

  it("an empty slot says where to add a box, and goes nowhere", async () => {
    render(<Harness />);
    await loaded();
    await waitFor(() => {
      press(5);
      expect(indicator()).toHaveAttribute("data-kind", "empty");
    });
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("Nothing on Ctrl+Shift+5 yet");
    expect(screen.getAllByTestId(/^box-switcher-dot-/)).toHaveLength(5);
    expect(assign).not.toHaveBeenCalled();
  });

  it("works from inside an app that stops the key from bubbling (the Terminal's xterm does)", async () => {
    render(<><Harness /><textarea data-testid="term" onKeyDown={(e) => e.stopPropagation()} /></>);
    const term = screen.getByTestId("term");
    term.addEventListener("keydown", (e) => e.stopPropagation());
    await loaded();
    await waitFor(() => {
      press(2, term);
      expect(assign).toHaveBeenCalled();
    });
  });

  it("leaves other keys, a held key's repeats and the keypad alone", async () => {
    render(<Harness />);
    await loaded();
    await waitFor(() => {
      press(1);
      expect(indicator()).not.toBeNull();
    });
    expect(fireEvent.keyDown(window, { code: "Digit2", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { code: "Numpad2", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { code: "Digit2", ctrlKey: true, shiftKey: true, altKey: true })).toBe(true);
    expect(press(2, window, { repeat: true })).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("reads the list again when Settings saves it", async () => {
    render(<Harness />);
    await loaded();
    serve({ selfName: "main", boxes: [{ name: "NAS", url: "http://nas.example.net/" }] });
    act(() => { window.dispatchEvent(new Event(LINKED_BOXES_CHANGED_EVENT)); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // A press before the new answer lands still goes to the old box 2.
    await waitFor(() => {
      press(2);
      expect(String(assign.mock.calls.at(-1)?.[0])).toMatch(/^http:\/\/nas\.example\.net\/#/);
    });
  });

  it("a list the box did not give is asked for again on the key, which is not swallowed meanwhile", async () => {
    let answers = 0;
    fetchMock = vi.fn(async () => {
      answers += 1;
      if (answers === 1) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ self: { name: "main" }, boxes: [{ name: "Laptop", url: `${LAPTOP}/` }] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<Harness />);
    await waitFor(() => expect(answers).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(press(2)).toBe(true); // left to the browser
    await waitFor(() => expect(answers).toBe(2));
    await waitFor(() => {
      press(2);
      expect(assign).toHaveBeenCalled();
    });
  });

  it("an older answer still on its way never puts the old list back over the saved one", async () => {
    const answers: Array<(r: Response) => void> = [];
    fetchMock = vi.fn(() => new Promise<Response>((r) => { answers.push(r); }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<Harness />);
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => { window.dispatchEvent(new Event(LINKED_BOXES_CHANGED_EVENT)); });
    await waitFor(() => expect(answers).toHaveLength(2));
    const list = (url: string) => new Response(JSON.stringify({ self: { name: "main" }, boxes: [{ name: "B", url }] }), { status: 200 });
    // The newer answer lands first, the older one after it.
    await act(async () => { answers[1](list("http://new.example.net/")); });
    await act(async () => { answers[0](list("http://old.example.net/")); });
    await waitFor(() => {
      press(2);
      expect(assign).toHaveBeenCalled();
    });
    expect(String(assign.mock.calls.at(-1)?.[0])).toMatch(/^http:\/\/new\.example\.net\/#/);
  });

  it("reads the list again when the desktop is shown again", async () => {
    render(<Harness />);
    await loaded();
    const before = fetchMock.mock.calls.length;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
  });

  it("stands down in the kiosk Chrome, whose extension switches tabs itself", async () => {
    document.documentElement.setAttribute(KIOSK_SWITCHER_ATTR, "kiosk");
    render(<Harness />);
    await loaded();
    await new Promise((r) => setTimeout(r, 20));
    expect(press(2)).toBe(true);
    expect(assign).not.toHaveBeenCalled();
    expect(indicator()).toBeNull();
  });

  it("does nothing for anyone but the owner", async () => {
    render(<Harness enabled={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(press(2)).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("on the box a switch arrived at", () => {
  const fromHome = encodeCarried({ to: 2, boxes: [{ name: "main", url: `${HOME}/` }, { name: "Laptop", url: `${LAPTOP}/` }] });

  it("takes the numbering out of the address, says where it is, and Ctrl+Shift+1 goes home", async () => {
    at(LAPTOP, `${CARRY_PREFIX}${fromHome}`);
    serve({ selfName: "laptop", boxes: [{ name: "Main", url: `${HOME}/` }] });
    render(<Harness />);
    // The fragment is gone from the address at once, kept for the tab.
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", "/");
    expect(sessionStorage.getItem(CARRIED_STORAGE_KEY)).toBe(fromHome);
    await waitFor(() => expect(indicator()).toHaveAttribute("data-kind", "stay"));
    // Slot 2 by the home box's numbering, named as this box names itself.
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("2 · laptop");
    expect(sessionStorage.getItem(ARRIVAL_STORAGE_KEY)).toBeNull();

    press(1);
    expect(assign).toHaveBeenCalledTimes(1);
    const url = String(assign.mock.calls[0][0]);
    expect(url.startsWith(`${HOME}/${CARRY_PREFIX}`)).toBe(true);
    expect(readCarriedHash(url.slice(url.indexOf("#"))).carried?.to).toBe(1);
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("Opening Main…");
  });

  it("keeps the numbering after a sign-in (it waited in the tab's storage)", async () => {
    at(LAPTOP);
    sessionStorage.setItem(CARRIED_STORAGE_KEY, fromHome);
    sessionStorage.setItem(ARRIVAL_STORAGE_KEY, "2");
    serve({ selfName: "laptop", boxes: [{ name: "Main", url: `${HOME}/` }] });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("2 · laptop"));
    press(1);
    expect(String(assign.mock.calls[0][0]).startsWith(`${HOME}/#`)).toBe(true);
  });

  it("ignores a numbering whose home this box does not list: Ctrl+Shift+1 stays here", async () => {
    const crafted = encodeCarried({ to: 2, boxes: [{ name: "Main", url: "https://evil.example/" }, { name: "Laptop", url: `${LAPTOP}/` }] });
    at(LAPTOP, `${CARRY_PREFIX}${crafted}`);
    serve({ selfName: "laptop", boxes: [{ name: "Main", url: `${HOME}/` }] });
    render(<Harness />);
    await loaded();
    await waitFor(() => {
      press(1);
      expect(indicator()).toHaveAttribute("data-kind", "stay");
    });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("1 · laptop");
    expect(sessionStorage.getItem(CARRIED_STORAGE_KEY)).toBeNull();
  });

  it("back home, the box's own list is the numbering again", async () => {
    const back = encodeCarried({ to: 1, boxes: [{ name: "main", url: `${HOME}/` }, { name: "Laptop", url: `${LAPTOP}/` }] });
    at(HOME, `${CARRY_PREFIX}${back}`);
    serve({ selfName: "main", boxes: [{ name: "Laptop", url: `${LAPTOP}/` }] });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("box-switcher-text")).toHaveTextContent("1 · main"));
    expect(sessionStorage.getItem(CARRIED_STORAGE_KEY)).toBeNull();
  });

  it("drops a fragment of ours that is not a numbering, and keeps any other fragment", async () => {
    at(LAPTOP, `${CARRY_PREFIX}garbage!!`);
    serve({ selfName: "laptop", boxes: [] });
    render(<Harness />);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CARRIED_STORAGE_KEY)).toBeNull();
    cleanup();
    replaceState.mockClear();
    at(LAPTOP, "#section");
    render(<Harness />);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
