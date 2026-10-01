import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";
import { CHAT_ATTACHMENT_MAX_BYTES } from "@/lib/chat-attachments";

// Mounting a chat costs seconds under a full parallel run — the same ceilings
// every suite that mounts ChatPopup declares (test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-1276 on the surface a customer uses: files AND folders dragged onto the
 * chat attach to the composer. A folder is staged file by file into one batch
 * (its structure kept), shows a chip with its progress while it travels, and
 * becomes ONE attachment — the folder as staged, which the turn names. The
 * staging route's per-file limit is enforced before a byte is sent.
 */

type Frame = Record<string, unknown>;
const sentFrames: Frame[] = [];

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as Frame;
    if (frame.type !== "req") return;
    sentFrames.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") return this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
    if (frame.method === "chat.history") return this.respond(id, { messages: [] });
    this.respond(id, { runId: `run-${sentFrames.length}`, status: "started" });
  }
  close() { this.readyState = FakeGatewayWs.CLOSED; }
  addEventListener() {}
  removeEventListener() {}
  private respond(id: string, payload: unknown) { setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0); }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

const STAGING = "/home/clawbox/.openclaw/media/chat-attachments";
/** Every staging request, as the fields it carried. */
let staged: Array<{ batch: string | null; relativePath: string | null; name: string }>;
/** Held open to observe a folder mid-upload. */
let gate: Promise<void> | null;
/** Opens the gate — called by the test, and again after it so nothing is left waiting. */
let openGate: () => void = () => {};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) return { ok: true, status: 200, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    if (url.includes("/setup-api/harness/active")) return { ok: true, status: 200, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    if (url.includes("/setup-api/chat/model")) return { ok: true, status: 200, json: async () => ({ options: [], activeOptionId: "" }) };
    if (url.includes("/setup-api/chat/attachments")) {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const batch = form.get("batch") as string | null;
      const relativePath = form.get("relativePath") as string | null;
      staged.push({ batch, relativePath, name: file.name });
      if (gate) await gate;
      const body = relativePath && batch
        ? { ok: true, name: file.name, path: `${STAGING}/${batch}/${relativePath}`, root: `${STAGING}/${batch}/${relativePath.split("/")[0]}` }
        : { ok: true, name: file.name, path: `${STAGING}/uuid-${file.name}` };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
}

// ── A drop as Chromium hands it over: entries, a directory reader in batches ──
type FakeEntry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void) => void } };
const fileEntry = (f: File): FakeEntry => ({ isFile: true, isDirectory: false, name: f.name, file: (ok) => ok(f) });
const dirEntry = (name: string, children: FakeEntry[]): FakeEntry => ({
  isFile: false, isDirectory: true, name,
  createReader: () => { let done = false; return { readEntries: (ok) => { const out = done ? [] : children; done = true; setTimeout(() => ok(out), 0); } }; },
});
function drop(entries: Array<{ entry: FakeEntry; file?: File }>) {
  const items = entries.map(({ entry, file }) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => file ?? null }));
  return { types: ["Files"], items: Object.assign(items, { length: items.length }), files: entries.map((e) => e.file).filter(Boolean), dropEffect: "" };
}
const text = (name: string, size = 4) => new File([new Uint8Array(size)], name, { type: "text/plain" });

/**
 * Connected, AND taking drops. The chat.history frame goes out in the same
 * tick as the handshake's `setStatus("connected")`, ahead of the render that
 * applies it — and the drop is taken only once that render (and the harness's
 * attachment capabilities) has landed. On a loaded runner a drop fired in that
 * gap was ignored outright, and no wait after it could bring the chip back.
 * The drop target itself says when it is ready: its dragover answers "copy"
 * exactly when a drop would be taken, and changes nothing.
 */
async function connected(target = "chat-popup") {
  await waitFor(() => expect(sentFrames.some((f) => f.method === "chat.history")).toBe(true));
  await waitFor(() => {
    const dataTransfer = { types: ["Files"], dropEffect: "" };
    fireEvent.dragOver(screen.getByTestId(target), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
  });
}

beforeEach(() => {
  sentFrames.length = 0;
  staged = [];
  gate = null;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  installFetch();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
});
afterEach(() => {
  openGate();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("dropping files and folders on the chat", () => {
  it("shows the drop target while files are dragged over, and not for other drags", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();
    const popup = screen.getByTestId("chat-popup");
    fireEvent.dragEnter(popup, { dataTransfer: { types: ["text/plain"] } });
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    fireEvent.dragEnter(popup, { dataTransfer: { types: ["Files"] } });
    expect(await screen.findByTestId("chat-drop-overlay")).toHaveTextContent(translations.en["chat.attachment.dropHint"]);
    fireEvent.dragLeave(popup, { dataTransfer: { types: ["Files"] } });
    await waitFor(() => expect(screen.queryByTestId("chat-drop-overlay")).toBeNull());
  });

  it("stages a dropped folder with its structure and attaches it as one folder the turn names", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    gate = new Promise<void>((resolve) => { openGate = resolve; });
    const open = () => openGate();
    const tree = dirEntry("site", [fileEntry(text("index.html")), dirEntry("src", [fileEntry(text("app.js"))]), fileEntry(text(".env"))]);
    fireEvent.drop(screen.getByTestId("chat-popup"), { dataTransfer: drop([{ entry: tree }]) });

    // Reading the tree first, then in flight: one chip for the folder, with its count.
    const chip = await waitFor(() => {
      const found = screen.getAllByTestId("chat-upload").find((c) => c.getAttribute("data-kind") === "folder");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(within(chip).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "2");
    expect(screen.queryAllByTestId("chat-upload").some((c) => c.getAttribute("data-kind") === "reading")).toBe(false);
    await act(async () => { open(); });

    const strip = await screen.findByTestId("chat-attachments");
    await waitFor(() => expect(strip).toHaveTextContent("site"));
    expect(within(strip).getByTestId("chat-attachment-folder-count")).toHaveTextContent("2 files");
    expect(screen.queryByTestId("chat-upload")).toBeNull();

    // One batch, the structure as relative paths; the hidden .env never left.
    expect(staged.map((s) => s.relativePath).sort()).toEqual(["site/index.html", "site/src/app.js"]);
    expect(new Set(staged.map((s) => s.batch)).size).toBe(1);

    fireEvent.change(textarea, { target: { value: "look at this site" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(sentFrames.some((f) => f.method === "chat.send")).toBe(true));
    const send = sentFrames.find((f) => f.method === "chat.send")!;
    const message = String((send.params as { message?: unknown }).message);
    expect(message).toContain(`[Attached file: ${STAGING}/${staged[0].batch}/site]`);
    expect(message).toContain("look at this site");
  });

  it("stages dropped loose files the way a picked file is staged — and the desktop under the chat never sees the drag", async () => {
    // The desktop's own drop zone saves files to Downloads and draws an overlay
    // over everything; a drag over the chat is the chat's alone.
    const desktop = vi.fn();
    render(
      <div onDragEnter={desktop} onDragOver={desktop} onDragLeave={desktop} onDrop={desktop}>
        <I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>
      </div>,
    );
    await screen.findByRole("textbox");
    await connected();
    const a = text("notes.txt");
    const popup = screen.getByTestId("chat-popup");
    const dataTransfer = drop([{ entry: fileEntry(a), file: a }]);
    fireEvent.dragEnter(popup, { dataTransfer });
    fireEvent.dragOver(popup, { dataTransfer });
    fireEvent.drop(popup, { dataTransfer });
    expect(desktop).not.toHaveBeenCalled();
    const strip = await screen.findByTestId("chat-attachments");
    await waitFor(() => expect(strip).toHaveTextContent("notes.txt"));
    expect(staged).toEqual([{ batch: null, relativePath: null, name: "notes.txt" }]);
  });

  it("refuses a file over the per-file limit before sending it", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();
    const huge = { name: "huge.bin", size: CHAT_ATTACHMENT_MAX_BYTES + 1, type: "application/octet-stream" } as File;
    fireEvent.drop(screen.getByTestId("chat-popup"), { dataTransfer: drop([{ entry: fileEntry(huge), file: huge }]) });
    const err = await screen.findByTestId("chat-attachment-error");
    expect(err).toHaveTextContent(translations.en["chat.attachment.error.tooLarge"].replace("{name}", "huge.bin"));
    expect(staged).toEqual([]);
  });

  it("the full-page chat takes the same drop", async () => {
    render(<I18nProvider><ChatApp /></I18nProvider>);
    await connected("chatapp");
    const tree = dirEntry("docs", [fileEntry(text("a.md")), fileEntry(text("b.md"))]);
    fireEvent.drop(screen.getByTestId("chatapp"), { dataTransfer: drop([{ entry: tree }]) });
    await waitFor(() => expect(staged).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(translations.en["chat.attachment.folderFiles"].replace("{count}", "2"))).toBeInTheDocument());
  });
});
