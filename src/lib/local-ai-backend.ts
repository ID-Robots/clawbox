/**
 * Which runtime hosts the on-device model on THIS device.
 *
 * The reasoning switch's two ends differ between the two runtimes — llama.cpp's
 * "off" is `minimal`, Ollama's is `none`, and Ollama rejects the other's word
 * outright (see LOCAL_REASONING_LEVELS_BY_BACKEND) — so anything that clamps a
 * level server-side has to know which one is loaded.
 *
 * Kept in its own module, away from src/lib/local-ai-runtime.ts, because that
 * one pulls in the llama.cpp supervisor and the instrumentation hook: the chat
 * route needs one string from the config store, not a process manager.
 */

import { get } from "@/lib/config-store";
import { DEFAULT_HERMES_LOCAL_BACKEND, type HermesLocalBackend } from "@/lib/hermes-reasoning";

/**
 * The configured runtime, or the shipped default when the device has never
 * chosen one.
 *
 * Defaulting rather than throwing is deliberate: the caller is a chat turn, and
 * a device that cannot answer this question still has to answer the customer.
 * The default is the runtime the product ships with and the only one the
 * Settings picker offers (`providerIds={["llamacpp"]}`), so it is right on
 * every device that has not been reconfigured by hand.
 */
export async function getConfiguredLocalAiBackend(): Promise<HermesLocalBackend> {
  try {
    const stored = await get("local_ai_provider");
    return stored === "ollama" ? "ollama" : DEFAULT_HERMES_LOCAL_BACKEND;
  } catch {
    return DEFAULT_HERMES_LOCAL_BACKEND;
  }
}
