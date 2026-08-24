import { describe, expect, it } from "vitest";
import { stripAgentStatusFrames } from "@/lib/hermes-reasoning-panel";

/**
 * The agent's spinner text, kept out of the customer's Reasoning disclosure.
 *
 * WHERE IT COMES FROM. While an API call is in flight the agent paints an
 * animated status line built from a kaomoji face and a gerund:
 *
 *     face = random.choice(KawaiiSpinner.get_thinking_faces())
 *     verb = random.choice(KawaiiSpinner.get_thinking_verbs())
 *     agent.thinking_callback(f"{face} {verb}...")
 *
 * (agent/conversation_loop.py; the vocabularies are KAWAII_THINKING and
 * THINKING_VERBS in agent/display.py.) It is a spinner. It says nothing about
 * what the model was thinking, and it fires for every model — including ones
 * that return no monologue at all.
 *
 * The streaming transport keeps it out structurally: it arrives on
 * `thinking.delta`, a different channel from `reasoning.delta`, and is dropped
 * there. This is the floor UNDER that, for the two paths with no channel to
 * separate — the CLI capture, where the same text can reach stdout as a raw
 * spinner line, and anything a previous build already stored.
 */
describe("stripping the agent's status frames from reasoning", () => {
  it("removes a lone frame entirely, leaving nothing", () => {
    // The claude-fable-5 case: the model returned no monologue, the spinner
    // ticked anyway, and the disclosure showed only this. An empty string is
    // what lets the caller omit the field rather than render an empty panel.
    expect(stripAgentStatusFrames("(⌐■_■) computing...")).toBe("");
    expect(stripAgentStatusFrames("( ˘⌣˘)♡ cogitating...")).toBe("");
    expect(stripAgentStatusFrames("(°ロ°) formulating...")).toBe("");
  });

  it("removes several frames run together, which is how they arrived", () => {
    // Deltas are concatenated with no separator, so a customer saw exactly
    // this shape in the disclosure.
    expect(stripAgentStatusFrames("(⌐■_■) computing...(°ロ°) cogitating...")).toBe("");
    expect(
      stripAgentStatusFrames("(◔_◔) musing...(¬‿¬) pondering...(⊙_⊙) synthesizing..."),
    ).toBe("");
  });

  it("keeps real reasoning that happens to sit beside a frame", () => {
    const mixed = "(⊙_⊙) formulating...The user asked me to say banana and nothing else.";
    expect(stripAgentStatusFrames(mixed)).toBe("The user asked me to say banana and nothing else.");
  });

  it("leaves ordinary prose alone, even when it uses the same words", () => {
    // The verbs are ordinary English. What makes a status frame is the whole
    // shape — a face, the verb, an ellipsis — so a model that genuinely writes
    // about processing or analyzing keeps every word.
    const real =
      "I am processing the file the user attached, then analyzing the columns "
      + "before computing the totals.";
    expect(stripAgentStatusFrames(real)).toBe(real);
  });

  it("keeps a sentence that merely ends in an ellipsis", () => {
    const real = "Let me think about this...";
    expect(stripAgentStatusFrames(real)).toBe(real);
  });

  it("keeps multi-paragraph reasoning intact", () => {
    const real = "First I check the config.\n\nThen I read the log.";
    expect(stripAgentStatusFrames(real)).toBe(real);
  });

  it("answers empty for empty, and never throws on a non-string", () => {
    expect(stripAgentStatusFrames("")).toBe("");
    expect(stripAgentStatusFrames(undefined as unknown as string)).toBe("");
    expect(stripAgentStatusFrames(null as unknown as string)).toBe("");
  });
});
