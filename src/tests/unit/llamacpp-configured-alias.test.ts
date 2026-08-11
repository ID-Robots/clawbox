import { describe, expect, it } from "vitest";
import { getLocalAiConfigStoreAlias } from "@/lib/llamacpp-server";

/**
 * The edition-independent half of "which local model is this device set to
 * run". Reading only the OpenClaw agent config left this unanswerable on
 * editions that ship without OpenClaw, which is what made the on-device model
 * unstartable there.
 */
describe("getLocalAiConfigStoreAlias", () => {
  const DEFAULT = "gemma4-e2b-it-q4_0";

  it.each([
    ["strips the qualified prefix", { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" }, DEFAULT],
    ["keeps a non-default alias", { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/my-custom-gguf" }, "my-custom-gguf"],
    ["accepts an already-bare alias", { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "my-custom-gguf" }, "my-custom-gguf"],
    ["falls back to the default on a malformed id", { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/" }, DEFAULT],
    ["falls back to the default when no id is stored", { local_ai_configured: true, local_ai_provider: "llamacpp" }, DEFAULT],
    ["returns null when local AI was never configured", {}, null],
    ["returns null when local AI is explicitly off", { local_ai_configured: false, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/x" }, null],
    ["returns null when the local provider is ollama", { local_ai_configured: true, local_ai_provider: "ollama", local_ai_model: "ollama/llama3.2:3b" }, null],
  ])("%s", (_label, state, expected) => {
    expect(getLocalAiConfigStoreAlias(state as Record<string, unknown>)).toBe(expected);
  });
});
