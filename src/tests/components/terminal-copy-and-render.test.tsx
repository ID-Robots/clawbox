import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp, { cellSnapSpacing, terminalBufferText } from "@/components/TerminalApp";
import { resetTerminalSettingsStoreForTests, updateTerminalSettings } from "@/lib/terminal-settings";

/**
 * The Terminal's own keys and clipboard, and how it is drawn.
 *
 * Pinned: Ctrl+Shift+C copies the selection and never reaches the shell, Ctrl+Shift+V is left
 * to the browser's paste event (the only clipboard read plain HTTP allows), plain Ctrl+C is the
 * shell's; copy-on-select copies when the mouse lets go; the visual bell flashes only when it
 * is on; "Copy all" joins wrapped rows back into the lines the program printed; and a WebGL cell
 * is as wide as the face rather than a pixel short of it.
 */

interface Frame { type: string; data?: string }
const sent: Frame[] = [];
let selection = "";
let bell: (() => void) | null = null;

interface FakeTerm {
  cols: number; rows: number; options: Record<string, unknown>;
  loadAddon: () => void; open: () => void; focus: () => void; write: () => void; writeln: () => void; dispose: () => void;
  clear: () => void; getSelection: () => string; paste: ReturnType<typeof vi.fn>;
  onData: () => { dispose: () => void };
  onBell: (fn: () => void) => { dispose: () => void };
  attachCustomKeyEventHandler: (fn: (ev: KeyboardEvent) => boolean) => void;
  press: (ev: Partial<KeyboardEvent>) => boolean | undefined;
  prevented: number;
}
const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      let handler: ((ev: KeyboardEvent) => boolean) | null = null;
      const term: FakeTerm = {
        cols: 80, rows: 24, options: { ...options }, prevented: 0,
        loadAddon: () => {}, open: () => {}, focus: () => {}, write: () => {}, writeln: () => {}, dispose: () => {},
        clear: () => {}, getSelection: () => selection, paste: vi.fn(),
        onData: () => ({ dispose: () => {} }),
        onBell: (fn) => { bell = fn; return { dispose: () => { bell = null; } }; },
        attachCustomKeyEventHandler: (fn) => { handler = fn; },
        press: (ev) => handler?.({ type: "keydown", preventDefault: () => { term.prevented++; }, ...ev } as KeyboardEvent),
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

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

beforeEach(() => {
  sent.length = 0;
  terms.length = 0;
  selection = "";
  bell = null;
  writeText.mockClear();
  resetTerminalSettingsStoreForTests();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const WebSocketStub = function () {
    return { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as Frame), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  resetTerminalSettingsStoreForTests();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("the clipboard keys", () => {
  it("copies the selection on Ctrl+Shift+C and keeps the key from the shell", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    selection = "make build";
    expect(terms[0].press({ ctrlKey: true, shiftKey: true, key: "C" })).toBe(false);
    expect(writeText).toHaveBeenCalledWith("make build");
    expect(await screen.findByTestId("terminal-notice")).toHaveTextContent("Copied to clipboard");
  });

  it("copies nothing, and still sends nothing, with nothing selected", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    expect(terms[0].press({ ctrlKey: true, shiftKey: true, key: "C" })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+Shift+V to the browser's own paste event, and plain Ctrl+C to the shell", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    // `false`: not typed into the shell; no preventDefault, so the browser
    // still fires the paste event xterm turns into a bracketed paste.
    expect(terms[0].press({ ctrlKey: true, shiftKey: true, key: "V" })).toBe(false);
    expect(terms[0].prevented).toBe(0);
    selection = "something";
    expect(terms[0].press({ ctrlKey: true, key: "c" })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("says so when the browser refuses the clipboard, naming the keys that still work", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const exec = document.execCommand;
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    try {
      render(<TerminalApp />);
      await waitFor(() => expect(terms.length).toBe(1));
      selection = "x";
      terms[0].press({ ctrlKey: true, shiftKey: true, key: "C" });
      expect(await screen.findByTestId("terminal-notice")).toHaveTextContent(/refused the clipboard.*Ctrl\+Shift\+C/);
    } finally {
      document.execCommand = exec;
    }
  });
});

describe("copy on select", () => {
  it("copies when the mouse lets go, quietly, only when it is on", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const frame = screen.getByTestId("terminal-surface").parentElement!;
    selection = "selected words";
    fireEvent.mouseUp(frame, { button: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(writeText).not.toHaveBeenCalled();

    act(() => { updateTerminalSettings({ copyOnSelect: true }); });
    fireEvent.mouseUp(frame, { button: 0 });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected words"));
    // No "Copied" notice for every selection.
    expect(screen.queryByTestId("terminal-notice")).toBeNull();
    // A right-button release is not a selection.
    writeText.mockClear();
    fireEvent.mouseUp(frame, { button: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("the bell", () => {
  it("flashes the terminal when the visual bell is on, and not when it is off", async () => {
    const onBell = vi.fn();
    render(<TerminalApp onBell={onBell} />);
    await waitFor(() => expect(bell).not.toBeNull());
    act(() => { bell!(); });
    expect(screen.getByTestId("terminal-bell-flash")).toBeInTheDocument();
    expect(onBell).toHaveBeenCalledTimes(1);

    act(() => { updateTerminalSettings({ bell: "off" }); });
    act(() => { bell!(); });
    expect(onBell).toHaveBeenCalledTimes(1);
  });
});

describe("the terminal it builds", () => {
  it("measures widths by Unicode 11, draws box drawing itself and keeps bold as weight", async () => {
    render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    const options = terms[0].options;
    expect(options.allowProposedApi).toBe(true);
    expect(options.customGlyphs).toBe(true);
    expect(options.rescaleOverlappingGlyphs).toBe(true);
    expect(options.drawBoldTextInBrightColors).toBe(false);
    expect(options.fontWeightBold).toBe("bold");
    expect(String(options.fontFamily)).toMatch(/^"JetBrains Mono"/);
    expect(options.lineHeight).toBe(1);
    expect(options.letterSpacing).toBe(0);
  });
});

describe("cellSnapSpacing", () => {
  it("rounds a WebGL cell to the nearest device pixel instead of flooring it", () => {
    // 13 px JetBrains Mono: a 7.8 px advance, 7 px cells without the pixel.
    expect(cellSnapSpacing(7.8, 1)).toBe(1);
    expect(cellSnapSpacing(7.8, 2)).toBe(1); // 15.6 device px
    expect(cellSnapSpacing(9, 1)).toBe(0); // 15 px: already whole
    expect(cellSnapSpacing(8.4, 1)).toBe(0); // loses less than half a pixel
    expect(cellSnapSpacing(7.8, 1.25)).toBe(1); // 9.75 device px
    expect(cellSnapSpacing(8.2, 1.5)).toBe(0); // 12.3 device px
  });

  it("asks for nothing it cannot measure", () => {
    expect(cellSnapSpacing(0, 1)).toBe(0);
    expect(cellSnapSpacing(Number.NaN, 1)).toBe(0);
    expect(cellSnapSpacing(7.8, 0)).toBe(1);
  });
});

describe("terminalBufferText", () => {
  function fakeBuffer(rows: Array<{ text: string; wrapped?: boolean }>) {
    return {
      buffer: {
        active: {
          length: rows.length,
          getLine: (y: number) => (rows[y]
            ? { isWrapped: Boolean(rows[y].wrapped), translateToString: (trim?: boolean) => (trim ? rows[y].text.replace(/\s+$/, "") : rows[y].text) }
            : undefined),
        },
      },
    } as unknown as Parameters<typeof terminalBufferText>[0];
  }

  it("joins wrapped rows back into the line the program printed, keeping spaces at the seam", () => {
    const text = terminalBufferText(fakeBuffer([
      { text: "$ echo a long line that " },
      { text: "wraps here   ", wrapped: true },
      { text: "next line   " },
      { text: "" },
      { text: "" },
    ]));
    expect(text).toBe("$ echo a long line that wraps here\nnext line");
  });
});
