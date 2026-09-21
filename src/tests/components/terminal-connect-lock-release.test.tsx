import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";

/**
 * The connect lock comes back down for EVERY throw, not only the socket's.
 *
 * `connect()` raises `connectLockRef` on entry and only `onopen`/`onclose`
 * lower it again, and it does a lot before either can run: three dynamic
 * `import()`s, a font wait, `new Terminal(...)`, `term.open()`. A throw
 * anywhere in there — the realistic one being a ChunkLoadError when an in-app
 * update replaces the build under an already-open tab — left the lock raised
 * as an unhandled rejection, and from then on every attempt returned at the
 * guard: the window sat on "Connecting to terminal server…" with a Reconnect
 * button that did nothing.
 */

const h = vi.hoisted(() => ({ terminals: 0 }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      h.terminals += 1;
      throw new Error("ChunkLoadError: Loading chunk @xterm/xterm failed");
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

describe("a terminal that cannot even be constructed", () => {
  beforeEach(() => {
    h.terminals = 0;
    vi.stubGlobal("WebSocket", class { static readonly OPEN = 1; });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the failure and can be retried", async () => {
    render(<TerminalApp />);

    await screen.findByText("Error");
    await waitFor(() => expect(h.terminals).toBe(1));

    // The lock is down: Reconnect reaches the constructor again. It fails
    // again — the chunk is still gone — but on beta this second attempt never
    // happened, and the window stayed on "Connecting…" for good.
    fireEvent.click(screen.getByText("Reconnect"));
    await waitFor(() => expect(h.terminals).toBe(2));
  });
});
