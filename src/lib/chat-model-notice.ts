// "This chat keeps its model" — when the chat says it, and nothing else.
//
// From Hermes v0.22.4 a conversation keeps the model it was launched with: the
// gateway refuses a `-m` / `--provider` on a resumed session that differs from
// its frozen launch, so the chat route resumes without them and the session's
// own model answers (see `cliServedPair` in the Hermes chat route). Changing
// the header's model mid-conversation therefore changes the NEXT new chat, and
// the conversation on screen carries on as it was — which is the behaviour the
// product keeps. What it adds is the one line that says so, because the pill
// naming one model while another one answers was the whole complaint.
//
// The rule is narrow on purpose. The line is a claim about what the NEXT turn
// will do, so it is made only when both halves are known: the model the
// header would send, and the model the conversation's session is held to (the
// adapter's `conversationModel`, which answers null whenever the next turn
// would open a fresh session — a new chat, a reloaded page, nothing recorded).
// Unknown on either side says nothing: a false "this chat keeps its model" on
// a chat that is about to switch is worse than the silence it replaces.

import { isClawboxAiProvider } from "@/lib/clawbox-ai-models";
import type { ConversationModel } from "@/lib/harness/transport";

/** What the chat header would send with the next turn. */
export interface SelectedModel {
  readonly provider: string;
  readonly model: string;
}

function normalizedProvider(provider: string | undefined): string {
  return (provider ?? "").trim().toLowerCase();
}

/**
 * Whether the conversation on screen will go on answering with a model other
 * than the one the header now names.
 *
 * Providers are compared only when BOTH are known: a provider the record left
 * blank is not a different provider. ClawBox AI is the one provider whose
 * model is not a choice — it runs one chat model, and the header shows it no
 * model pill — so two ClawBox AI pairs are the same pair whatever ids they
 * carry, under either spelling `isClawboxAiProvider` accepts (`clawai`,
 * `deepseek`) — the same predicate that hides the pill; every other model id
 * is compared as Hermes wrote it.
 */
export function chatKeepsEarlierModel(
  selected: SelectedModel | null | undefined,
  held: ConversationModel | null | undefined,
): boolean {
  const heldModel = held?.model?.trim() ?? "";
  const selectedModel = selected?.model?.trim() ?? "";
  if (!heldModel || !selectedModel) return false;
  const heldProvider = normalizedProvider(held?.provider);
  const selectedProvider = normalizedProvider(selected?.provider);
  if (heldProvider && selectedProvider) {
    if (isClawboxAiProvider(heldProvider) && isClawboxAiProvider(selectedProvider)) return false;
    if (heldProvider !== selectedProvider) return true;
  }
  return heldModel !== selectedModel;
}

/**
 * The model each conversation is held to, by session key, together with the
 * adapter that holds it. A record kept for another adapter (the box swapped
 * harness under the open chat) describes sessions this one never opened.
 */
export interface ConversationModels<A> {
  readonly adapter: A | null;
  readonly byKey: Readonly<Record<string, ConversationModel>>;
}

/**
 * `models` with `key` set to `held` (null removes it). Hands back the SAME
 * object when nothing changed, so the chat is not rendered again for a turn
 * that left its conversation where it was.
 */
export function withConversationModel<A>(
  models: ConversationModels<A>,
  adapter: A,
  key: string,
  held: ConversationModel | null,
): ConversationModels<A> {
  const byKey = models.adapter === adapter ? models.byKey : {};
  const current = byKey[key];
  if (held) {
    if (
      models.adapter === adapter
      && current
      && current.model === held.model
      && (current.provider ?? "") === (held.provider ?? "")
    ) {
      return models;
    }
    return { adapter, byKey: { ...byKey, [key]: { ...held } } };
  }
  if (models.adapter === adapter && !current) return models;
  const rest = { ...byKey };
  delete rest[key];
  return { adapter, byKey: rest };
}

/** The model the conversation on `key` is held to, as recorded for `adapter`. */
export function conversationModelFor<A>(
  models: ConversationModels<A>,
  adapter: A,
  key: string,
): ConversationModel | null {
  if (!key || models.adapter !== adapter) return null;
  return models.byKey[key] ?? null;
}
