import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import {
  HERMES_SESSION,
  installHermesBox,
  mountHermesChat,
  type HermesBox,
} from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { HERMES_CHAT_PREFS_KEY } from "@/lib/hermes-chat-prefs";
import { translations } from "@/lib/translations";
import type { ReactNode } from "react";

// The sentence asserted below comes from the real table; the provider loads it
// through a dynamic import that never settles under jsdom, so `useT` reads the
// English table directly, as chat-hermes-tabs.test.tsx does.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let str = translations.en[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
        return str;
      },
    }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * Hermes v0.22.4: a conversation keeps the model it started on. The model pill
 * changed mid-conversation applies to the next new chat, and the conversation
 * on screen goes on answering with its own — the product keeps that. What the
 * chat adds is one line over the composer, so the owner is not left with a
 * pill naming one model while another one answers:
 *
 *   "This chat keeps its model; start a new chat to use the new model."
 *
 * The box below answers as the route does: a turn that OPENS a session records
 * the model it ran with; a RESUMED turn sends no `-m` and records no model.
 */

const NOTICE = "This chat keeps its model; start a new chat to use the new model.";
const TAB_SESSION = "20260901_120000_abc123";

let box: HermesBox;

function installTwoModelBox(): HermesBox {
  const hermes = installHermesBox();
  hermes.sessionIdFor = (sessionKey) => (sessionKey === "desktop" ? HERMES_SESSION : TAB_SESSION);
  hermes.chatResponse = (body) => {
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "desktop";
    const opening = typeof body.sessionId !== "string";
    return {
      ok: true,
      json: async () => ({
        text: "hello back",
        sessionId: hermes.sessionIdFor(sessionKey),
        ...(opening ? { model: body.model, provider: body.provider } : {}),
      }),
    };
  };
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/hermes/models")) {
      hermes.fetchedUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
          provider: "anthropic",
          authenticated: true,
          models: [{ id: "claude-fable-5" }, { id: "claude-sonnet-5" }],
          current: "claude-fable-5",
          defaultModel: "claude-fable-5",
          savedElsewhere: null,
          reasoning: "off",
          source: "dashboard",
          stale: false,
        }),
      };
    }
    return inner(input as RequestInfo, init);
  }));
  return hermes;
}

const modelPill = () => screen.getByLabelText(/^Hermes model:/);

async function pickModel(id: string) {
  fireEvent.click(modelPill());
  const options = await screen.findAllByRole("option");
  const option = options.find((o) => (o.textContent ?? "").startsWith(id));
  expect(option).toBeTruthy();
  fireEvent.click(option as HTMLElement);
  await waitFor(() => expect(modelPill()).toHaveAccessibleName(pillName(id)));
}

/** The pill drops whatever the provider pill already says, so match the tail. */
const pillName = (id: string) => new RegExp(`^Hermes model: (claude-)?${id.replace(/^claude-/, "")}$`);

async function sendTurn(text: string) {
  const textarea = screen.getByRole("textbox");
  const before = box.chatPosts.length;
  const repliesBefore = screen.queryAllByText("hello back").length;
  await waitFor(() => expect(textarea).not.toBeDisabled());
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(box.chatPosts.length).toBe(before + 1));
  await waitFor(() => expect(screen.queryAllByText("hello back").length).toBe(repliesBefore + 1));
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installTwoModelBox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("the Hermes chat after the model pill changes mid-conversation", () => {
  it("says the chat keeps its model, while the old model goes on answering", async () => {
    await mountHermesChat(box);
    await waitFor(() => expect(modelPill()).toBeTruthy());
    await sendTurn("which model are you?");
    expect(box.chatPosts[0]).toMatchObject({ model: "claude-fable-5", provider: "anthropic" });
    expect(box.chatPosts[0]).not.toHaveProperty("sessionId");
    // Header and conversation agree: nothing to say.
    expect(screen.queryByTestId("chat-model-kept")).toBeNull();

    await pickModel("claude-sonnet-5");
    const notice = await screen.findByTestId("chat-model-kept");
    expect(notice).toHaveTextContent(NOTICE);
    // Polite and in the way of nothing: the composer still sends.
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");

    // The behaviour kept: the turn resumes the SAME session, which answers on
    // its own model and records none, so the line stays.
    await sendTurn("and now?");
    expect(box.chatPosts[1]).toMatchObject({ sessionId: HERMES_SESSION, model: "claude-sonnet-5" });
    expect(screen.getByTestId("chat-model-kept")).toHaveTextContent(NOTICE);

    // Back on the conversation's own model: nothing left to say.
    await pickModel("claude-fable-5");
    await waitFor(() => expect(screen.queryByTestId("chat-model-kept")).toBeNull());
  });

  it("goes away on a new chat, which opens its session on the picked model", async () => {
    await mountHermesChat(box);
    await waitFor(() => expect(modelPill()).toBeTruthy());
    await sendTurn("hi");
    await pickModel("claude-sonnet-5");
    await screen.findByTestId("chat-model-kept");

    fireEvent.click(screen.getByTestId("chat-tab-restart"));
    await waitFor(() => expect(screen.queryByTestId("chat-model-kept")).toBeNull());
    await sendTurn("hello again");
    expect(box.chatPosts[1]).toMatchObject({ model: "claude-sonnet-5" });
    expect(box.chatPosts[1]).not.toHaveProperty("sessionId");
    expect(screen.queryByTestId("chat-model-kept")).toBeNull();
  });

  it("is kept per conversation: a new tab is fresh, the first one still says it", async () => {
    await mountHermesChat(box);
    await waitFor(() => expect(modelPill()).toBeTruthy());
    await sendTurn("hi");
    await pickModel("claude-sonnet-5");
    await screen.findByTestId("chat-model-kept");

    fireEvent.click(screen.getByTestId("chat-new-tab"));
    await waitFor(() => expect(screen.getAllByTestId("chat-tab")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("chat-model-kept")).toBeNull());

    fireEvent.click(screen.getAllByTestId("chat-tab")[0]);
    await screen.findByTestId("chat-model-kept");
  });

  it("clears the conversation that was reset, even when the owner changes tab while it resets", async () => {
    // The reset's transcript DELETE is held open, and the owner moves to
    // another tab before it lands. The record to clear is main's — the one
    // that was reset — not the tab on screen by the time the reset finishes.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE" && url.includes("/setup-api/chat/history")) await held;
      return inner(input as RequestInfo, init);
    }));

    await mountHermesChat(box);
    await waitFor(() => expect(modelPill()).toBeTruthy());
    await sendTurn("hi");
    await pickModel("claude-sonnet-5");
    await screen.findByTestId("chat-model-kept");

    fireEvent.click(screen.getByTestId("chat-new-tab"));
    await waitFor(() => expect(screen.getAllByTestId("chat-tab")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("chat-tab")[0]);
    await screen.findByTestId("chat-model-kept");

    fireEvent.click(screen.getByTestId("chat-tab-restart"));
    fireEvent.click(screen.getAllByTestId("chat-tab")[1]);
    await waitFor(() => expect(screen.getAllByTestId("chat-tab")[1]).toHaveAttribute("aria-selected", "true"));
    release();
    await waitFor(() => expect(box.transcriptDeletes).toBe(1));

    // Main's session is gone: its next turn opens a fresh one on the picked
    // model, so going back must not claim the old one is kept.
    fireEvent.click(screen.getAllByTestId("chat-tab")[0]);
    await waitFor(() => expect(screen.getAllByTestId("chat-tab")[0]).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(screen.queryByTestId("chat-model-kept")).toBeNull());
  });

  it("claims nothing about a conversation this page has not threaded", async () => {
    // A reloaded page: the transcript names the model that answered, but the
    // session id was never handed back to this page, so the next turn opens a
    // fresh session — on the picked model.
    window.localStorage.setItem(HERMES_CHAT_PREFS_KEY, JSON.stringify({
      provider: "anthropic",
      models: { anthropic: "claude-sonnet-5" },
    }));
    box.storedTranscript = [
      { role: "user", text: "which model are you?", timestamp: 1 },
      { role: "assistant", text: "Earlier in this chat.", timestamp: 2, model: "claude-fable-5", provider: "anthropic" },
    ];
    await mountHermesChat(box);
    await screen.findByText("Earlier in this chat.");
    await waitFor(() => expect(modelPill()).toHaveAccessibleName(pillName("claude-sonnet-5")));
    expect(screen.queryByTestId("chat-model-kept")).toBeNull();

    await sendTurn("still there?");
    expect(box.chatPosts[0]).not.toHaveProperty("sessionId");
    expect(screen.queryByTestId("chat-model-kept")).toBeNull();
  });
});
