/**
 * Slash-command autocomplete on the HERMES edition, on both surfaces.
 *
 * The point of these cases is that the feature is not an OpenClaw feature with
 * a Hermes fallback: a Hermes box offers HERMES' commands, read from its own
 * `commands.catalog` through `/setup-api/hermes/commands`, and never the
 * gateway's — the two registries genuinely differ (`/undo`, `/btw` and
 * `/journey` are Hermes'; `/think`, `/compact` and `/elevated` are OpenClaw's),
 * so a surface that showed one list on both editions would be lying on one of
 * them.
 *
 * And the sent text has to be exactly the command, because the Hermes chat
 * route is what routes it to `slash.exec` — anything wrapped around it arrives
 * as a message ABOUT a command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Rows as the route builds them from Hermes' catalogue. */
const HERMES_ROWS = [
  { id: "/new", usage: "/new", description: "Start a new session (fresh session ID + history)", acceptsArgs: false, source: "harness" as const },
  { id: "/status", usage: "/status", description: "Show session, model, token, and context info", acceptsArgs: false, source: "harness" as const },
  { id: "/undo", usage: "/undo [n]", description: "Back up N user turns and re-prompt", acceptsArgs: true, source: "harness" as const },
  { id: "/btw", usage: "/btw", description: "Ask a side question without interrupting", acceptsArgs: true, source: "harness" as const },
];

let box: HermesBox;

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox();
  box.commandRows = HERMES_ROWS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

const menu = () => screen.queryByTestId("chat-slash-menu");
const rowTexts = () =>
  Array.from(menu()?.querySelectorAll('[role="option"]') ?? []).map(
    (row) => row.querySelector(".slash-command-usage")?.textContent ?? "",
  );

function type(el: HTMLElement, text: string) {
  const area = el as HTMLTextAreaElement;
  fireEvent.change(area, { target: { value: text } });
  area.setSelectionRange(text.length, text.length);
}

/** The full-page chat, mounted on this box with its composer usable. */
async function mountChatApp(): Promise<HTMLTextAreaElement> {
  render(<ChatApp />);
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea as HTMLTextAreaElement;
}

describe("the Hermes edition's own command list", () => {
  it("reads it from the box's Hermes route, not from the gateway", async () => {
    const composer = await mountHermesChat(box);
    type(composer, "/");
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/hermes/commands"))).toBe(true);
    // A Hermes box runs no gateway at all; the helper's socket stub fails a
    // test that opens one.
    expect(box.socketsOpened).toBe(0);
  });

  it("shows HERMES' commands, in Hermes' own words", async () => {
    const composer = await mountHermesChat(box);
    type(composer, "/");
    await waitFor(() => expect(rowTexts()).toEqual(["/new", "/status", "/undo [n]", "/btw"]));
    expect(screen.getByText("Ask a side question without interrupting")).toBeTruthy();
    // Not OpenClaw's: `/think` and `/compact` are the gateway's registry and
    // have no Hermes equivalent under those names.
    expect(rowTexts()).not.toContain("/think");
    expect(rowTexts()).not.toContain("/compact");
  });

  it("filters Hermes' list as the owner types, prefix matches first", async () => {
    const composer = await mountHermesChat(box);
    // `/undo` CONTAINS an "n" and stays, below the one that starts with it —
    // a command found by its middle is still the command the owner meant.
    type(composer, "/n");
    await waitFor(() => expect(rowTexts()).toEqual(["/new", "/undo [n]"]));
    type(composer, "/ne");
    await waitFor(() => expect(rowTexts()).toEqual(["/new"]));
  });

  it("sends the accepted command as exactly the command, for the route to execute", async () => {
    const composer = await mountHermesChat(box);
    type(composer, "/st");
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("/status"));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(box.chatPosts.length).toBeGreaterThan(0));
    expect(box.chatPosts[0].message).toBe("/status");
  });

  it("renders the command's output as the reply", async () => {
    box.chatResponse = (body) =>
      body.message === "/status"
        ? { ok: true, json: async () => ({ text: "Session 20260917 · gemma · 1.2k tokens", sessionId: "s1" }) }
        : null;
    const composer = await mountHermesChat(box);
    type(composer, "/status");
    fireEvent.keyDown(composer, { key: "Escape" });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText(/Session 20260917/)).toBeTruthy();
  });

  it("offers no popover on a box whose dashboard cannot answer", async () => {
    // The route reports `available: false` with an empty list for a box whose
    // dashboard is down; the composer's honest response is no menu at all.
    box.commandsAvailable = false;
    const composer = await mountHermesChat(box);
    type(composer, "/");
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();
    // …and Enter therefore still SENDS, rather than being eaten by a menu that
    // is not there.
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(box.chatPosts.length).toBeGreaterThan(0));
  });

  it("asks AGAIN once the dashboard is back, instead of believing one failed read", async () => {
    // THE probe-once case on this edition. `HermesAdapter.connect()` emits
    // `connected` once and there is no socket to cycle, so the read that
    // happens at mount is the only one a reconnect would ever produce: a box
    // whose dashboard was restarting when the chat opened had no slash menu for
    // the rest of the page's life, and nothing on screen said why. The surface
    // coming back into view is the trigger that replaces the reconnect.
    box.commandsAvailable = false;
    const composer = await mountHermesChat(box);
    type(composer, "/");
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();

    box.commandsAvailable = true;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(rowTexts()).toEqual(["/new", "/status", "/undo [n]", "/btw"]));
  });
});

describe("the full-page chat gets the same feature from the same hook", () => {
  it("offers the harness's commands and inserts the one picked", async () => {
    const composer = await mountChatApp();
    type(composer, "/");
    await waitFor(() => expect(rowTexts()).toEqual(["/new", "/status", "/undo [n]", "/btw"]));
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(composer.value).toBe("/status"));
    // Inserted, not sent — the same rule as the mascot chat's.
    expect(box.chatPosts).toHaveLength(0);
  });

  it("names the active row on its composer too, and keeps the focus there", async () => {
    const composer = await mountChatApp();
    type(composer, "/");
    await waitFor(() => expect(menu()).not.toBeNull());
    await waitFor(() => expect(composer.getAttribute("aria-activedescendant")).toBeTruthy());
    expect(composer.getAttribute("aria-controls")).toBe(menu()!.id);
    expect(menu()!.getAttribute("role")).toBe("listbox");
  });

  it("completes the whole token from a caret parked inside it", async () => {
    const composer = await mountChatApp();
    type(composer, "/status");
    await waitFor(() => expect(menu()).not.toBeNull());
    composer.setSelectionRange(4, 4);
    fireEvent.select(composer);
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.keyDown(composer, { key: "Enter" });
    // `/statustus` was the defect; `/status` publishes no arguments here, so it
    // goes in bare.
    await waitFor(() => expect(composer.value).toBe("/status"));
  });

  it("closes when the pointer lands outside it, instead of hanging over the page", async () => {
    // The full-screen chat never unmounts, and the popover is portaled to
    // `<body>`, `position: fixed`, `z-index: 10050`. With `open` derived from
    // the draft and the caret alone, clicking into the transcript left the menu
    // on screen over whatever the owner was now reading, still taking pointer
    // events. The mascot chat only hid it because ChatPopup unmounts wholesale.
    const composer = await mountChatApp();
    type(composer, "/st");
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(menu()).toBeNull());
    // The draft is untouched — this dismissed the menu, not the message.
    expect(composer.value).toBe("/st");
    // And it is a dismissal, not a mute: typing on brings the menu back.
    type(composer, "/sta");
    await waitFor(() => expect(menu()).not.toBeNull());
  });

  it("stays open when the pointer lands on one of its own rows", async () => {
    const composer = await mountChatApp();
    type(composer, "/");
    await waitFor(() => expect(menu()).not.toBeNull());
    const rows = menu()!.querySelectorAll('[role="option"]');
    fireEvent.pointerDown(rows[1]);
    // The row was ACCEPTED rather than treated as a click away from the menu.
    await waitFor(() => expect(composer.value).toBe("/status"));
  });

  it("closes on Escape and leaves Enter to the composer again", async () => {
    const composer = await mountChatApp();
    type(composer, "/st");
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.keyDown(composer, { key: "Escape" });
    await waitFor(() => expect(menu()).toBeNull());
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(box.chatPosts.length).toBeGreaterThan(0));
    expect(box.chatPosts[0].message).toBe("/st");
  });
});
