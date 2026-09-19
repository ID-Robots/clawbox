import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import TerminalTabs from "@/components/TerminalTabs";
import { WindowChromeContext, type WindowChrome } from "@/lib/window-chrome";
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTINGS_KEY,
  getTerminalSettings,
  resetTerminalSettingsStoreForTests,
} from "@/lib/terminal-settings";

/**
 * The Terminal's settings sheet (src/components/TerminalSettingsSheet.tsx),
 * opened from the gear in the window's title bar.
 *
 * Pinned: the gear sits in the title bar when there is one and in the strip
 * when there is not; a change reaches every open terminal at once and the
 * window's chrome takes a light theme's face; the change is written to the
 * owner's preferences; the shell list comes from the box; Escape closes it.
 */

interface FakeTerm {
  cols: number; rows: number;
  options: Record<string, unknown>;
  loadAddon: () => void; open: () => void; focus: () => void; write: () => void; writeln: () => void; dispose: () => void;
  clear: () => void; getSelection: () => string;
  onData: () => { dispose: () => void };
  attachCustomKeyEventHandler: () => void;
}
const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      const term: FakeTerm = {
        cols: 80, rows: 24, options: { ...options },
        loadAddon: () => {}, open: () => {}, focus: () => {}, write: () => {}, writeln: () => {}, dispose: () => {},
        clear: () => {}, getSelection: () => "",
        onData: () => ({ dispose: () => {} }),
        attachCustomKeyEventHandler: () => {},
      };
      terms.push(term);
      return term as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const posts: Array<Record<string, unknown>> = [];
const sockets: string[] = [];

beforeEach(() => {
  terms.length = 0;
  posts.length = 0;
  sockets.length = 0;
  resetTerminalSettingsStoreForTests();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/setup-api/terminal/shells")) {
      return new Response(JSON.stringify({ shells: ["/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"], defaultShell: "/bin/bash" }));
    }
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }
    return new Response("{}");
  }));
  const WebSocketStub = function (url: string) {
    sockets.push(url);
    return { readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  resetTerminalSettingsStoreForTests();
  vi.unstubAllGlobals();
});

function renderInWindow() {
  const actions = document.createElement("div");
  actions.setAttribute("data-window-titlebar-actions", "true");
  document.body.appendChild(actions);
  const setTone = vi.fn();
  const chrome: WindowChrome = { actions, active: true, tone: "dark", setTone };
  const utils = render(
    <WindowChromeContext.Provider value={chrome}>
      <TerminalTabs />
    </WindowChromeContext.Provider>,
  );
  return { ...utils, actions, setTone };
}

describe("the settings gear", () => {
  it("sits in the window's title bar, beside its controls", async () => {
    const { actions } = renderInWindow();
    await waitFor(() => expect(terms.length).toBe(1));
    const gear = within(actions).getByTestId("terminal-settings-button");
    expect(gear).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(gear);
    expect(screen.getByRole("dialog", { name: "Terminal settings" })).toBeInTheDocument();
    expect(gear).toHaveAttribute("aria-expanded", "true");
    actions.remove();
  });

  it("sits at the strip's end on the standalone page, which has no title bar", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    const gear = screen.getByTestId("terminal-settings-button");
    expect(screen.getByTestId("terminal-tabs").contains(gear)).toBe(true);
  });

  it("is also in the terminal's right-click menu", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.contextMenu(screen.getByTestId("terminal-surface"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("terminal-menu-settings"));
    expect(screen.getByTestId("terminal-settings-sheet")).toBeInTheDocument();
  });
});

describe("the settings sheet", () => {
  it("offers the six themes with ClawBox dark chosen, and the bundled faces with the system one", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    for (const id of ["clawbox-dark", "clawbox-light", "solarized-dark", "solarized-light", "dracula", "nord"]) {
      expect(screen.getByTestId(`terminal-theme-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("terminal-theme-clawbox-dark")).toHaveAttribute("aria-checked", "true");
    for (const id of ["jetbrains-mono", "fira-code", "ibm-plex-mono", "system"]) {
      expect(screen.getByTestId(`terminal-font-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("terminal-font-system")).toHaveTextContent("System monospace");
  });

  it("applies a theme and a font size to the open terminal at once, and turns the window's chrome light", async () => {
    const { actions, setTone } = renderInWindow();
    await waitFor(() => expect(terms.length).toBe(1));
    await waitFor(() => expect(setTone).toHaveBeenCalledWith("dark"));
    fireEvent.click(within(actions).getByTestId("terminal-settings-button"));

    fireEvent.click(screen.getByTestId("terminal-theme-clawbox-light"));
    expect(getTerminalSettings().theme).toBe("clawbox-light");
    expect(screen.getByTestId("terminal-tabs")).toHaveAttribute("data-terminal-tone", "light");
    expect(setTone).toHaveBeenLastCalledWith("light");
    expect((terms[0].options.theme as { background: string }).background).toBe("#fafbfc");
    // A light ground nudges colours an app chose for a dark one.
    expect(terms[0].options.minimumContrastRatio).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: "Larger" }));
    fireEvent.click(screen.getByRole("button", { name: "Larger" }));
    expect(getTerminalSettings().fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize + 2);
    expect(terms[0].options.fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize + 2);

    fireEvent.click(screen.getByTestId("terminal-cursor-bar"));
    expect(terms[0].options.cursorStyle).toBe("bar");
    fireEvent.click(screen.getByTestId("terminal-cursor-blink"));
    expect(terms[0].options.cursorBlink).toBe(false);
    fireEvent.change(screen.getByTestId("terminal-scrollback"), { target: { value: "25000" } });
    expect(terms[0].options.scrollback).toBe(25000);
    fireEvent.change(screen.getByTestId("terminal-line-height"), { target: { value: "1.2" } });
    expect(terms[0].options.lineHeight).toBe(1.2);
    actions.remove();
  });

  it("saves the change to the owner's preferences", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    fireEvent.click(screen.getByTestId("terminal-theme-nord"));
    fireEvent.click(screen.getByTestId("terminal-copy-on-select"));
    fireEvent.click(screen.getByTestId("terminal-bell-off"));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0][TERMINAL_SETTINGS_KEY]).toMatchObject({ theme: "nord", copyOnSelect: true, bell: "off" });
    expect(screen.getByTestId("terminal-copy-on-select")).toHaveAttribute("aria-checked", "true");
  });

  it("lists the box's shells and asks a new tab for the chosen shell and folder", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    const shell = screen.getByTestId("terminal-shell") as HTMLSelectElement;
    await waitFor(() => expect(within(shell).getByRole("option", { name: "/usr/bin/zsh" })).toBeInTheDocument());
    expect(within(shell).getByRole("option", { name: "Box default (/bin/bash)" })).toBeInTheDocument();
    fireEvent.change(shell, { target: { value: "/usr/bin/zsh" } });
    const cwd = screen.getByTestId("terminal-cwd");
    fireEvent.change(cwd, { target: { value: "~/projects" } });
    fireEvent.keyDown(cwd, { key: "Enter" });
    expect(getTerminalSettings()).toMatchObject({ shell: "/usr/bin/zsh", cwd: "~/projects" });

    // The shell already running is left alone; the next tab gets them.
    fireEvent.keyDown(screen.getByTestId("terminal-settings-sheet"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(sockets.length).toBe(2));
    const query = new URL(sockets[1].replace(/^ws:/, "http:")).searchParams;
    expect(query.get("shell")).toBe("/usr/bin/zsh");
    expect(query.get("cwd")).toBe("~/projects");
    expect(sockets[0]).not.toContain("shell=");
  });

  it("closes on Escape and from its close button, and resets to the defaults", async () => {
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    const reset = screen.getByTestId("terminal-settings-reset");
    expect(reset).toBeDisabled();
    fireEvent.click(screen.getByTestId("terminal-theme-dracula"));
    expect(reset).not.toBeDisabled();
    fireEvent.click(reset);
    expect(getTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS);

    fireEvent.keyDown(screen.getByTestId("terminal-settings-sheet"), { key: "Escape" });
    expect(screen.queryByTestId("terminal-settings-sheet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    fireEvent.click(screen.getByTestId("terminal-settings-close"));
    expect(screen.queryByTestId("terminal-settings-sheet")).not.toBeInTheDocument();
  });

  it("says so when the preferences refused the save", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => new Response("{}", { status: init?.method === "POST" ? 500 : 200 })));
    render(<TerminalTabs />);
    await waitFor(() => expect(terms.length).toBe(1));
    fireEvent.click(screen.getByTestId("terminal-settings-button"));
    await act(async () => { fireEvent.click(screen.getByTestId("terminal-theme-nord")); });
    expect(await screen.findByText(/Not saved to this box/)).toBeInTheDocument();
  });
});
