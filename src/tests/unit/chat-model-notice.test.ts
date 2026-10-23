import { describe, expect, it } from "vitest";
import {
  chatKeepsEarlierModel,
  conversationModelFor,
  withConversationModel,
  type ConversationModels,
} from "@/lib/chat-model-notice";
import { translations } from "@/lib/translations";

/**
 * When the Hermes chat says "This chat keeps its model; start a new chat to use
 * the new model." — the header names one model, and the conversation's session
 * is held to another (a resumed session keeps its frozen launch from Hermes
 * v0.22.4). A claim about the NEXT turn, so it is made only when both halves
 * are known.
 */
describe("chatKeepsEarlierModel", () => {
  it("is said when the header names another model than the conversation's", () => {
    expect(chatKeepsEarlierModel(
      { provider: "anthropic", model: "claude-sonnet-5" },
      { model: "claude-fable-5", provider: "anthropic" },
    )).toBe(true);
  });

  it("is not said while they agree", () => {
    expect(chatKeepsEarlierModel(
      { provider: "anthropic", model: "claude-fable-5" },
      { model: "claude-fable-5", provider: "anthropic" },
    )).toBe(false);
  });

  it("is said for another provider, even one that serves the same id", () => {
    expect(chatKeepsEarlierModel(
      { provider: "openrouter", model: "deepseek-v4-flash" },
      { model: "deepseek-v4-flash", provider: "clawai" },
    )).toBe(true);
  });

  it("compares the model alone when the record left its provider blank", () => {
    expect(chatKeepsEarlierModel({ provider: "anthropic", model: "claude-fable-5" }, { model: "claude-fable-5" })).toBe(false);
    expect(chatKeepsEarlierModel({ provider: "anthropic", model: "claude-sonnet-5" }, { model: "claude-fable-5" })).toBe(true);
  });

  it("reads provider slugs without regard to case or stray spaces", () => {
    expect(chatKeepsEarlierModel(
      { provider: "Anthropic ", model: "claude-fable-5" },
      { model: " claude-fable-5", provider: "anthropic" },
    )).toBe(false);
  });

  it("never says it on ClawBox AI, whose one chat model is not a choice", () => {
    expect(chatKeepsEarlierModel(
      { provider: "clawai", model: "deepseek-v4-flash" },
      { model: "deepseek-v4-pro", provider: "clawai" },
    )).toBe(false);
  });

  it("does say it when the conversation moved ONTO or OFF ClawBox AI", () => {
    expect(chatKeepsEarlierModel(
      { provider: "clawai", model: "deepseek-v4-flash" },
      { model: "claude-fable-5", provider: "anthropic" },
    )).toBe(true);
    expect(chatKeepsEarlierModel(
      { provider: "anthropic", model: "claude-fable-5" },
      { model: "deepseek-v4-flash", provider: "clawai" },
    )).toBe(true);
  });

  it("claims nothing when either half is unknown", () => {
    // No conversation held to a model: a new chat, a reloaded page, nothing recorded.
    expect(chatKeepsEarlierModel({ provider: "anthropic", model: "claude-sonnet-5" }, null)).toBe(false);
    expect(chatKeepsEarlierModel({ provider: "anthropic", model: "claude-sonnet-5" }, { model: "  " })).toBe(false);
    // The header sends no model: Hermes falls back to its own default.
    expect(chatKeepsEarlierModel({ provider: "anthropic", model: "" }, { model: "claude-fable-5" })).toBe(false);
    expect(chatKeepsEarlierModel(null, { model: "claude-fable-5" })).toBe(false);
  });
});

describe("the words", () => {
  it("are the decided English and Bulgarian sentences, and every locale has the line", () => {
    expect(translations.en["chat.keepsItsModel"]).toBe("This chat keeps its model; start a new chat to use the new model.");
    expect(translations.bg["chat.keepsItsModel"]).toBe("Този чат пази своя модел; за новия модел започни нов чат.");
    for (const [locale, table] of Object.entries(translations)) {
      expect(table["chat.keepsItsModel"], locale).toBeTruthy();
    }
  });
});

describe("the per-conversation record the chat keeps", () => {
  const adapter = { id: "hermes" };
  const other = { id: "openclaw" };
  const empty: ConversationModels<typeof adapter> = { adapter: null, byKey: {} };

  it("keeps a model per key and reads it back for the same adapter only", () => {
    const one = withConversationModel(empty, adapter, "desktop", { model: "claude-fable-5", provider: "anthropic" });
    const two = withConversationModel(one, adapter, "desktop-tab1", { model: "gpt-5.6-sol" });
    expect(conversationModelFor(two, adapter, "desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
    expect(conversationModelFor(two, adapter, "desktop-tab1")).toEqual({ model: "gpt-5.6-sol" });
    expect(conversationModelFor(two, adapter, "desktop-tab2")).toBeNull();
    expect(conversationModelFor(two, other, "desktop")).toBeNull();
    expect(conversationModelFor(two, adapter, "")).toBeNull();
  });

  it("removes a key on null and leaves the others", () => {
    const one = withConversationModel(empty, adapter, "desktop", { model: "claude-fable-5" });
    const two = withConversationModel(one, adapter, "desktop-tab1", { model: "gpt-5.6-sol" });
    const three = withConversationModel(two, adapter, "desktop-tab1", null);
    expect(conversationModelFor(three, adapter, "desktop-tab1")).toBeNull();
    expect(conversationModelFor(three, adapter, "desktop")).toEqual({ model: "claude-fable-5" });
  });

  it("hands back the same object when nothing changed, so the chat does not render again", () => {
    const one = withConversationModel(empty, adapter, "desktop", { model: "claude-fable-5", provider: "anthropic" });
    expect(withConversationModel(one, adapter, "desktop", { model: "claude-fable-5", provider: "anthropic" })).toBe(one);
    expect(withConversationModel(one, adapter, "desktop-tab1", null)).toBe(one);
    expect(withConversationModel(one, adapter, "desktop", { model: "claude-fable-5" })).not.toBe(one);
  });

  it("starts over for another adapter: its sessions are not this one's", () => {
    const one = withConversationModel(empty, adapter, "desktop", { model: "claude-fable-5" });
    const swapped = withConversationModel(one, other, "desktop-tab1", { model: "gpt-5.6-sol" });
    expect(conversationModelFor(swapped, other, "desktop")).toBeNull();
    expect(conversationModelFor(swapped, other, "desktop-tab1")).toEqual({ model: "gpt-5.6-sol" });
  });
});
