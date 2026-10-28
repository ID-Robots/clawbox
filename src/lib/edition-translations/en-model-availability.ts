/**
 * What the chat says when a model cannot run on the owner's own account: a
 * provider answered with a rate limit of ZERO (no API credit or quota for that
 * model yet — xAI's "Requests per Minute (actual/limit): 0/0"), or no longer
 * offers the model. Read by src/lib/chat-error-text.ts (the failed turn's
 * sentence) and src/lib/model-fallback-chat.ts (the line that says which model
 * the chat moved to).
 *
 * {model} and {fallback} are model names as the picker shows them, {provider}
 * the company ("xAI"), {console} where that provider takes API credit
 * ("console.x.ai").
 */
export const modelAvailabilityEn: Record<string, string> = {
  "chat.modelUnavailableNoQuota":
    "That message did not go through — {model} is not available on this {provider} account: its rate limit is 0, so there is no API credit or quota for it yet. Pick another model in the header, or add credit at {console}, then send it again.",
  "chat.modelUnavailableZeroQuota":
    "{model} is not available on this {provider} account — its rate limit is 0 (no API credit or quota for it yet).",
  "chat.modelUnavailableNotFound": "{provider} no longer offers {model} to this account.",
  "chat.modelUnavailableResent": "Switched the chat to {fallback} and sent your message again.",
  "chat.modelUnavailableSwitched": "Switched the chat to {fallback} — send your message again.",
  "chat.modelUnavailableSwitching": "Moving the chat to {fallback} and sending your message again.",
  "chat.modelUnavailablePick": "Pick {fallback} in the chat header and send your message again.",
  "chat.modelUnavailableNone": "No other {provider} model is available on this account — pick another provider in the chat header.",
  "chat.modelUnavailableAddCredit": "To use {model}, add credit at {console}.",
};
