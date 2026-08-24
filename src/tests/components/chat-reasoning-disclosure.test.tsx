import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The monologue as an affordance instead of as the reply.
 *
 * The behaviour under test is the one the customer complained about: an
 * assistant bubble that opened with the model thinking out loud. It is now a
 * shut disclosure under the answer — and, crucially, it is shut the same way on
 * a REPLAYED turn, because a refresh that expanded every past monologue would
 * reintroduce the same wall of text by another route.
 */

const MONOLOGUE = 'The user just said "Hey". I should respond warmly and briefly.';
const ANSWER = "Hey! What can I help you with today?";

/** A stored turn that already carries its thinking and its steps. */
const REPLAYED = {
  role: "assistant",
  text: ANSWER,
  timestamp: 1,
  reasoning: MONOLOGUE,
  toolCalls: [{ name: "terminal", detail: "uname -sr", status: "ok" }],
};

function installFetch(history: unknown[], turn?: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        return { ok: true, json: async () => turn ?? { text: ANSWER, sessionId: "s1" } };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: history }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function send(text: string) {
  const box = await screen.findByRole("textbox");
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the reasoning disclosure in the chat bubble", () => {
  it("shows the answer and keeps the monologue out of it", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText(ANSWER)).toBeTruthy();
    // The bug in one line: the monologue must not be rendered as the reply.
    expect(screen.queryByText(MONOLOGUE)).toBeNull();
  });

  it("is COLLAPSED by default, and says so to a screen reader", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const toggle = await screen.findByTestId("chat-reasoning-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("chat-reasoning-body")).toBeNull();
  });

  it("reveals the monologue when it is asked for, and hides it again", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const toggle = await screen.findByTestId("chat-reasoning-toggle");
    fireEvent.click(toggle);

    const body = await screen.findByTestId("chat-reasoning-body");
    expect(body.textContent).toBe(MONOLOGUE);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId("chat-reasoning-body")).toBeNull());
  });

  it("carries the disclosure through a REPLAY, still collapsed", async () => {
    // Same assertion as the live case, reached the other way: this bubble came
    // back from the transcript, not from a turn this session ran.
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const toggle = await screen.findByTestId("chat-reasoning-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect((await screen.findByTestId("chat-reasoning-body")).textContent).toBe(MONOLOGUE);
  });

  it("offers no disclosure on a turn that did no thinking", async () => {
    installFetch([{ role: "assistant", text: "Hello.", timestamp: 1 }]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText("Hello.")).toBeTruthy();
    expect(screen.queryByTestId("chat-reasoning-toggle")).toBeNull();
  });

  it("shows the disclosure on a LIVE turn, not only a replayed one", async () => {
    installFetch(
      [{ role: "assistant", text: "Earlier in this chat.", timestamp: 1 }],
      { text: ANSWER, reasoning: MONOLOGUE, sessionId: "s1" },
    );
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText("Earlier in this chat.");
    await send("Hey");

    const toggle = await screen.findByTestId("chat-reasoning-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect((await screen.findByTestId("chat-reasoning-body")).textContent).toBe(MONOLOGUE);
  });
});

describe("the tool steps in the chat bubble", () => {
  it("shows what the agent did, replayed with the turn", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const chips = await screen.findByTestId("chat-tool-summary");
    // Prettified the same way the live OpenClaw pill does it.
    expect(chips.textContent).toContain("terminal");
    // The arguments ride on the tooltip, not in the chip.
    expect(chips.querySelector('[title="terminal: uname -sr"]')).toBeTruthy();
  });

  it("shows the steps of a LIVE turn too", async () => {
    installFetch(
      [{ role: "assistant", text: "Earlier in this chat.", timestamp: 1 }],
      {
        text: "It printed Linux.",
        toolCalls: [{ name: "clawbox__system_stats", detail: "{}", status: "ok" }],
        sessionId: "s1",
      },
    );
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText("Earlier in this chat.");
    await send("how is the box");

    const chips = await screen.findByTestId("chat-tool-summary");
    // The MCP server prefix is stripped, as it is for the live pills.
    expect(chips.textContent).toContain("system stats");
    expect(chips.textContent).not.toContain("clawbox__");
  });

  it("shows nothing when the turn used no tools", async () => {
    installFetch([{ role: "assistant", text: "Hello.", timestamp: 1 }]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText("Hello.")).toBeTruthy();
    expect(screen.queryByTestId("chat-tool-summary")).toBeNull();
  });
});
