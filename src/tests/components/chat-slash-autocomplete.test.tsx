/**
 * Slash-command autocomplete in the mascot chat, end to end over the fake
 * gateway socket.
 *
 * What it is for: the list on screen must be the HARNESS'S, accepting a row
 * must put the command in the composer, and sending it must put that exact
 * text on the wire — because on OpenClaw the gateway is what executes a text
 * slash command (`chat-send-user-turn.ts`: a message whose trimmed body starts
 * with `/` becomes a `text-slash` command turn). A popover that offered a list
 * of its own, or that sent something other than what it showed, would be a menu
 * of promises the box never made.
 *
 * The `commands.list` payload below is the real wire shape, trimmed from a live
 * capture on the owner's box (core 2026.9.4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEED_TEXT = "Ready when you are.";
const SESSION = "agent:main:main";

const GATEWAY_COMMANDS = [
  {
    name: "help",
    textAliases: ["/help"],
    description: "Show available commands.",
    category: "status",
    source: "native",
    scope: "both",
    acceptsArgs: false,
  },
  {
    name: "status",
    textAliases: ["/status"],
    description: "Show current status.",
    category: "status",
    source: "native",
    scope: "both",
    // The real shape: acceptsArgs with NO `args` metadata. 36 of the owner's
    // 73 commands look like this.
    acceptsArgs: true,
  },
  {
    name: "model",
    textAliases: ["/model"],
    description: "Show or set the model; use -s, -a, or -g to choose scope.",
    category: "options",
    source: "native",
    scope: "both",
    acceptsArgs: true,
    args: [{ name: "model", description: "Model id", type: "string", required: true }],
  },
  {
    name: "models",
    textAliases: ["/models"],
    description: "List model providers/models.",
    category: "options",
    source: "native",
    scope: "both",
    acceptsArgs: true,
  },
];

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;
/** Set by a case that wants the gateway to refuse `commands.list`. */
let commandsListFails = false;
/** Rows a case adds to the catalogue mid-test — a skill installed, say. */
let extraCommands: Record<string, unknown>[] = [];

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    sent.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [assistantMessage(SEED_TEXT, 500)] });
      return;
    }
    if (frame.method === "commands.list") {
      if (commandsListFails) {
        setTimeout(() => this.emit({
          type: "res", id, ok: false, error: { message: "commands.list unavailable" },
        }), 0);
        return;
      }
      this.respond(id, { commands: [...GATEWAY_COMMANDS, ...extraCommands] });
      return;
    }
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/capabilities")) {
      return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true } }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const framesFor = (method: string) => sent.filter((f) => f.method === method);
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const menu = () => screen.queryByTestId("chat-slash-menu");
const rowTexts = () =>
  Array.from(menu()?.querySelectorAll('[role="option"]') ?? []).map(
    (row) => row.querySelector(".slash-command-usage")?.textContent ?? "",
  );

/** Type into the composer, keeping the caret where a real one would be. */
function type(text: string) {
  const el = composer();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.keyUp(el, { key: "x" });
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
  // The catalogue is asked for once the transport is up.
  await waitFor(() => expect(framesFor("commands.list").length).toBeGreaterThan(0));
}

async function openMenu(text = "/") {
  type(text);
  await waitFor(() => expect(menu()).not.toBeNull());
}

describe("slash-command autocomplete (OpenClaw, mascot chat)", () => {
  beforeEach(() => {
    sent.length = 0;
    sockets.length = 0;
    commandsListFails = false;
    extraCommands = [];
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("asks the GATEWAY for the list, as commands.list{scope:'text',includeArgs:true}", async () => {
    await mountReady();
    // The wire contract, pinned: `scope:'text'` because a ClawBox turn goes out
    // as text, and `includeArgs` is what makes a row able to say `/model
    // <model>`. Never bound to a session key — the catalogue is the agent's.
    expect(framesFor("commands.list")[0].params).toEqual({ scope: "text", includeArgs: true });
  });

  it("shows the harness's own commands and descriptions when `/` is typed", async () => {
    await mountReady();
    await openMenu();
    expect(rowTexts()).toEqual(["/help", "/status", "/model <model>", "/models"]);
    // The harness's wording, not ours.
    expect(screen.getByText("Show available commands.")).toBeTruthy();
    expect(screen.getByText("Show or set the model; use -s, -a, or -g to choose scope.")).toBeTruthy();
  });

  it("filters as the owner types", async () => {
    await mountReady();
    await openMenu();
    type("/mo");
    await waitFor(() => expect(rowTexts()).toEqual(["/model <model>", "/models"]));
  });

  it("says so when nothing matches, instead of silently showing the whole list", async () => {
    await mountReady();
    await openMenu();
    type("/frobnicate");
    await waitFor(() => expect(screen.queryByTestId("chat-slash-empty")).not.toBeNull());
    expect(rowTexts()).toEqual([]);
  });

  it("walks the list with ArrowDown and inserts the highlighted row on Enter", async () => {
    await mountReady();
    await openMenu();
    const el = composer();
    fireEvent.keyDown(el, { key: "ArrowDown" });
    await waitFor(() =>
      expect(menu()?.querySelectorAll('[aria-selected="true"] .slash-command-usage')[0]?.textContent)
        .toBe("/status"),
    );
    fireEvent.keyDown(el, { key: "Enter" });
    // Inserted, NOT sent: this Enter belonged to the menu. The trailing space
    // is the HARNESS's answer — `/status` publishes `acceptsArgs: true`.
    await waitFor(() => expect(composer().value).toBe("/status "));
    expect(framesFor("chat.send")).toHaveLength(0);
  });

  it("puts the caret after a space for a command that takes arguments", async () => {
    await mountReady();
    await openMenu("/mo");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(composer().value).toBe("/model "));
  });

  it("accepts on Tab as well as Enter", async () => {
    await mountReady();
    await openMenu("/st");
    fireEvent.keyDown(composer(), { key: "Tab" });
    await waitFor(() => expect(composer().value).toBe("/status "));
  });

  it("accepts a row clicked with the mouse", async () => {
    await mountReady();
    await openMenu();
    const rows = menu()!.querySelectorAll('[role="option"]');
    fireEvent.pointerDown(rows[1]);
    await waitFor(() => expect(composer().value).toBe("/status "));
  });

  it("sends the accepted command as EXACTLY the command text — the gateway executes it", async () => {
    await mountReady();
    await openMenu("/st");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(composer().value).toBe("/status "));
    // The menu is closed now (the draft has a space in it), so this Enter is
    // the composer's and the turn goes out.
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    const params = framesFor("chat.send")[0].params as Record<string, unknown>;
    // Byte-for-byte after the route's own trim: the gateway reads `/status` as
    // a command turn and anything wrapped around it would arrive as a message
    // about a command instead.
    expect(String(params.message).trim()).toBe("/status");
    expect(params.sessionKey).toBe(SESSION);
    expect(params.deliver).toBe(false);
  });

  it("renders the harness's answer to a command like any other reply", async () => {
    await mountReady();
    await openMenu("/st");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(composer().value).toBe("/status "));
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    socket()?.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: SESSION,
        state: "final",
        message: assistantMessage("Session: main · model: gemma-4", Date.now()),
      },
    });
    expect(await screen.findByText(/Session: main/)).toBeTruthy();
  });

  it("shows a refused command in the harness's OWN words, not a raw dump", async () => {
    await mountReady();
    type("/frobnicate");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    socket()?.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: SESSION,
        state: "error",
        errorMessage: "Unknown command: /frobnicate. Try /help.",
      },
    });
    expect(await screen.findByText(/Unknown command: \/frobnicate/)).toBeTruthy();
  });

  it("closes on Escape without closing the chat, and reopens as typing continues", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SEED_TEXT);
    await waitFor(() => expect(framesFor("commands.list").length).toBeGreaterThan(0));
    await openMenu();
    fireEvent.keyDown(composer(), { key: "Escape" });
    await waitFor(() => expect(menu()).toBeNull());
    // The chat itself is still open — the mascot chat's window-level Escape
    // must not also fire while the menu is the thing on screen.
    expect(onClose).not.toHaveBeenCalled();
    // A dismissal belongs to the token it was aimed at, so the next character
    // brings the menu back rather than silencing it for the rest of the draft.
    type("/st");
    await waitFor(() => expect(menu()).not.toBeNull());
  });

  it("stays shut once the command is over and arguments have begun", async () => {
    await mountReady();
    await openMenu("/mo");
    type("/model gemma");
    await waitFor(() => expect(menu()).toBeNull());
    // …and Enter therefore SENDS, rather than being eaten by the menu.
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    expect((framesFor("chat.send")[0].params as Record<string, unknown>).message).toBe("/model gemma");
  });

  it("completes the WHOLE token when the caret is parked inside it", async () => {
    // The helper below always leaves the caret at the end, which is exactly why
    // this case moves it by hand: accepting used to keep everything after the
    // caret, so `/help` with the caret at 3 became `/helplp`.
    await mountReady();
    await openMenu("/help");
    const el = composer();
    el.setSelectionRange(3, 3);
    fireEvent.select(el);
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(composer().value).toBe("/help"));
  });

  it("stays shut when the caret is clicked back to the front of a finished draft", async () => {
    // …and Enter therefore still SENDS the line the owner finished typing,
    // rather than accepting the top row over it.
    await mountReady();
    type("/model gemma");
    const el = composer();
    el.setSelectionRange(1, 1);
    fireEvent.select(el);
    await new Promise((r) => setTimeout(r, 30));
    expect(menu()).toBeNull();
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    expect((framesFor("chat.send")[0].params as Record<string, unknown>).message).toBe("/model gemma");
  });

  it("never opens on an ordinary message", async () => {
    await mountReady();
    type("what does /help do");
    await new Promise((r) => setTimeout(r, 30));
    expect(menu()).toBeNull();
  });

  it("does not open at all when the gateway could not be asked", async () => {
    // "we could not ask" must not become "here is a list we remember": a menu
    // built from nothing is worse than no menu.
    commandsListFails = true;
    await mountReady();
    type("/");
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();
  });

  it("asks the gateway AGAIN on a reconnect, so a skill installed since is offered", async () => {
    // The invariant three comments in this feature assert in prose and no test
    // pinned: the catalogue is not read once and believed for the life of the
    // tab. A gateway that restarted is a different process and a box that
    // installed a skill gained a command — both land on a reconnect.
    await mountReady();
    expect(framesFor("commands.list")).toHaveLength(1);
    extraCommands = [{
      name: "diagram_maker",
      textAliases: ["/diagram_maker"],
      description: "Create diagrams.",
      category: "tools",
      source: "skill",
      scope: "both",
      acceptsArgs: true,
    }];
    // The gateway bounces under the chat; the component reconnects on its own.
    socket()?.onclose?.();
    await waitFor(() => expect(sockets.length).toBeGreaterThan(1), { timeout: 20_000 });
    await waitFor(() => expect(framesFor("commands.list").length).toBeGreaterThan(1), { timeout: 20_000 });
    await openMenu("/dia");
    await waitFor(() => expect(rowTexts()).toEqual(["/diagram_maker"]));
  });

  it("forgets a dismissal once the message it belonged to has been sent", async () => {
    // Accepting a row dismisses the exact token, which is what stops the menu
    // eating the Enter meant to send it. The send path then clears the draft
    // DIRECTLY — never through the composer's onChange — so the dismissal used
    // to outlive its message: typing the same command again by hand opened no
    // menu, over a dismissal the owner had made for the previous turn.
    await mountReady();
    await openMenu("/he");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(composer().value).toBe("/help"));
    await waitFor(() => expect(menu()).toBeNull());
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(framesFor("chat.send").length).toBeGreaterThan(0));
    await waitFor(() => expect(composer().value).toBe(""));
    type("/help");
    await waitFor(() => expect(menu()).not.toBeNull());
  });

  it("names the active row on the composer, which keeps the focus", async () => {
    await mountReady();
    await openMenu();
    const el = composer();
    await waitFor(() => expect(el.getAttribute("aria-activedescendant")).toBeTruthy());
    const activeId = el.getAttribute("aria-activedescendant")!;
    expect(el.getAttribute("aria-controls")).toBe(menu()!.id);
    // `aria-haspopup` + `aria-autocomplete` + `aria-activedescendant`, and
    // deliberately NOT `aria-expanded`, which the textbox role does not
    // support — the textarea keeps that role rather than becoming a combobox
    // under a screen reader mid-interaction.
    expect(el.getAttribute("aria-haspopup")).toBe("listbox");
    expect(el.getAttribute("aria-autocomplete")).toBe("list");
    expect(el.getAttribute("aria-expanded")).toBeNull();
    expect(menu()!.getAttribute("role")).toBe("listbox");
    expect(document.getElementById(activeId)?.getAttribute("aria-selected")).toBe("true");
  });
});
