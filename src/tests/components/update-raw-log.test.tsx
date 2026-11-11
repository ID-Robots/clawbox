/**
 * The raw update log panel behind the update screen's terminal button
 * (TASK-2428): a read-only xterm fed by /setup-api/update/log.
 *
 * xterm is a fake that records what it is given (jsdom has no canvas), and
 * EventSource a fake the test drives: a `run` announcement, chunks with their
 * `<run>:<offset>` ids, `end`, `none`, a dropped connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";

interface FakeTerm {
  options: Record<string, unknown>;
  written: string[];
  resets: number;
  disposed: boolean;
  selection: string;
  buffer: { active: { viewportY: number; baseY: number; length: number; getLine: (y: number) => { isWrapped: boolean; translateToString: () => string } | undefined } };
  scrollToBottom: ReturnType<typeof vi.fn>;
  fireScroll: () => void;
  text: () => string;
}

const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      let onScroll: (() => void) | null = null;
      const term: FakeTerm & Record<string, unknown> = {
        options,
        written: [],
        resets: 0,
        disposed: false,
        selection: "",
        unicode: { activeVersion: "6" },
        buffer: {
          active: {
            viewportY: 0,
            baseY: 0,
            get length() { return term.text().split("\n").length; },
            getLine: (y: number) => {
              const line = term.text().split("\n")[y];
              return line === undefined ? undefined : { isWrapped: false, translateToString: () => line };
            },
          },
        },
        text: () => term.written.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
        loadAddon: () => {},
        open: () => {},
        attachCustomKeyEventHandler: () => {},
        getSelection: () => term.selection,
        onScroll: (fn: () => void) => { onScroll = fn; return { dispose: () => {} }; },
        fireScroll: () => onScroll?.(),
        write: (data: string, done?: () => void) => { term.written.push(data); done?.(); },
        reset: () => { term.resets += 1; term.written = []; },
        scrollToBottom: vi.fn(() => { term.buffer.active.viewportY = term.buffer.active.baseY; }),
        dispose: () => { term.disposed = true; },
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
vi.mock("@/lib/terminal-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/terminal-settings")>()),
  loadTerminalSettings: () => Promise.resolve(),
}));
const copied: string[] = [];
vi.mock("@/lib/terminal-clipboard", () => ({
  copyToClipboard: (text: string) => { copied.push(text); return Promise.resolve(true); },
}));

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.readyState = FakeEventSource.CLOSED; }
  emit(type: string, data: unknown, lastEventId = "") {
    act(() => {
      const ev = { data: JSON.stringify(data), lastEventId } as MessageEvent;
      if (type === "message") this.onmessage?.(ev);
      else for (const fn of this.listeners.get(type) ?? []) fn(ev);
    });
  }
  run(id: string, finished = false) { this.emit("run", { id, startedAt: "", finished }); }
  chunk(id: string, offset: number, text: string) { this.emit("message", text, `${id}:${offset}`); }
  drop(closed = false) {
    act(() => {
      this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
      this.onerror?.();
    });
  }
}

const RUN = "20261111T093015Z-a1b2";
const NEXT_RUN = "20261111T101500Z-c3d4";

import UpdateRawLog from "@/components/UpdateRawLog";

async function mount(live = true) {
  const view = render(<UpdateRawLog id="log" label="Full update log" live={live} />);
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  return { view, source: FakeEventSource.all[0], term: terms[terms.length - 1] };
}

beforeEach(() => {
  terms.length = 0;
  copied.length = 0;
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the raw update log panel", () => {
  it("is a read-only terminal drawn the Terminal app's way, fed from the log stream in order", async () => {
    const { source, term } = await mount();
    expect(source.url).toBe("/setup-api/update/log");
    expect(term.options).toMatchObject({ disableStdin: true, convertEol: true, allowTransparency: false, drawBoldTextInBrightColors: false });
    expect(term.options.theme).toBeTruthy();
    expect(term.options.scrollback).toBeGreaterThanOrEqual(50_000);
    expect(screen.getByTestId("update-raw-log")).toHaveAccessibleName("Full update log");

    source.run(RUN);
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("Live");
    source.chunk(RUN, 20, "\x1b[1;36m==> [1/9] Refreshing\x1b[0m\n");
    source.chunk(RUN, 41, "50%\r100%\n");
    expect(term.written.filter((w) => w !== "\x1b[?25l")).toEqual(["\x1b[1;36m==> [1/9] Refreshing\x1b[0m\n", "50%\r100%\n"]);
    expect(screen.getByTestId("update-raw-log-download")).toHaveAttribute("href", `/setup-api/update/log?download=1&run=${RUN}`);
  });

  it("closes the stream when the run has ended, and says so", async () => {
    const { source } = await mount(false);
    source.run(RUN, true);
    source.chunk(RUN, 10, "done\n");
    source.emit("end", { id: RUN, outcome: "completed" });
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(screen.getByTestId("update-raw-log")).toHaveAttribute("data-status", "ended");
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("Run ended");
  });

  it("keeps the screen through the browser's own reconnect to the same run, and starts clean for another run", async () => {
    const { source, term } = await mount();
    source.run(RUN);
    source.chunk(RUN, 10, "before the restart\n");
    source.drop();
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("Reconnecting…");
    // The server came back and resumed from Last-Event-ID: the same run again.
    source.run(RUN);
    source.chunk(RUN, 30, "after the restart\n");
    expect(term.resets).toBe(1);
    expect(term.text()).toBe("before the restart\nafter the restart\n");
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("Live");
    // A newer run: from its byte 0, on a clean screen.
    source.run(NEXT_RUN);
    source.chunk(NEXT_RUN, 12, "new run\n");
    expect(term.resets).toBe(2);
    expect(term.text()).toBe("new run\n");
  });

  it("stops following when scrolled up, and goes back on 'jump to latest'", async () => {
    const { source, term } = await mount();
    source.run(RUN);
    source.chunk(RUN, 5, "a\n");
    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(screen.queryByTestId("update-raw-log-follow")).toBeNull();

    term.buffer.active.baseY = 40;
    term.buffer.active.viewportY = 10;
    act(() => term.fireScroll());
    term.scrollToBottom.mockClear();
    source.chunk(RUN, 7, "b\n");
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    const follow = screen.getByTestId("update-raw-log-follow");
    expect(follow).toHaveTextContent("Paused · jump to latest");

    fireEvent.click(follow);
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-raw-log-follow")).toBeNull();
    source.chunk(RUN, 9, "c\n");
    expect(term.scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("copies the selection, or the whole log when nothing is selected", async () => {
    const { source, term } = await mount();
    source.run(RUN);
    source.chunk(RUN, 12, "line one\nline two\n");
    fireEvent.click(screen.getByTestId("update-raw-log-copy"));
    await waitFor(() => expect(copied).toEqual(["line one\nline two"]));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    term.selection = "line two";
    fireEvent.click(screen.getByTestId("update-raw-log-copy"));
    await waitFor(() => expect(copied).toEqual(["line one\nline two", "line two"]));
  });

  it("asks again, from the byte on screen, when a new run starts after the shown one ended", async () => {
    const { source, term } = await mount(true);
    source.run(RUN, true);
    source.chunk(RUN, 10, "old run\n");
    vi.useFakeTimers();
    source.emit("end", { id: RUN, outcome: "failed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(FakeEventSource.all).toHaveLength(2);
    const again = FakeEventSource.all[1];
    expect(again.url).toBe(`/setup-api/update/log?after=${encodeURIComponent(`${RUN}:10`)}`);
    // Still the old run (the new one has not written yet): nothing is redrawn.
    again.run(RUN, true);
    expect(term.text()).toBe("old run\n");
    again.run(NEXT_RUN);
    again.chunk(NEXT_RUN, 9, "new run\n");
    expect(term.text()).toBe("new run\n");
  });

  it("asks again, from the byte on screen, when the browser gave up on the stream during a run", async () => {
    const { source, term } = await mount(true);
    source.run(RUN);
    source.chunk(RUN, 14, "before restart\n");
    vi.useFakeTimers();
    // A web server half-way through its restart answered with an error page.
    source.drop(true);
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("The update log could not be opened.");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(FakeEventSource.all).toHaveLength(2);
    const again = FakeEventSource.all[1];
    expect(again.url).toBe(`/setup-api/update/log?after=${encodeURIComponent(`${RUN}:14`)}`);
    again.run(RUN);
    again.chunk(RUN, 30, "after restart\n");
    expect(term.text()).toBe("before restart\nafter restart\n");
  });

  it("does not ask again for a finished run that is not followed live", async () => {
    const { source } = await mount(false);
    source.run(RUN, true);
    vi.useFakeTimers();
    source.emit("end", { id: RUN, outcome: "completed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it("says when there is no log yet, and when the box refused the stream", async () => {
    const { source } = await mount(false);
    source.emit("none", {});
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("No update has written a log on this box yet.");
    expect(screen.queryByTestId("update-raw-log-download")).toBeNull();
    source.drop(true);
    expect(screen.getByTestId("update-raw-log-status")).toHaveTextContent("The update log could not be opened.");
  });

  it("lets go of the stream and the terminal when it is closed", async () => {
    const { view, source, term } = await mount();
    view.unmount();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(term.disposed).toBe(true);
  });
});
