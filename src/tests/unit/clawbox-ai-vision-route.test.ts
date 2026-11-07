import { describe, expect, it } from "vitest";
import { openclawCannotSeePictures } from "@/lib/clawbox-ai-vision-route";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";

// An OpenClaw box whose ClawBox AI chat has nothing that can look at a picture
// refuses one in words instead of accepting it (TASK-2261).

function box(input: string[], imageModel?: unknown, primary = "deepseek/deepseek-v4-flash") {
  return {
    agents: { defaults: { model: { primary }, ...(imageModel === undefined ? {} : { imageModel }) } },
    models: { providers: { deepseek: { models: [{ id: "deepseek-v4-flash", input }] } } },
  };
}

describe("openclawCannotSeePictures", () => {
  it("is true only when the ClawBox AI chat model is text-only and no picture model is set", () => {
    expect(openclawCannotSeePictures(box(["text"]))).toBe(true);
    expect(openclawCannotSeePictures(box(["text"], { primary: "  " }))).toBe(true);
  });

  it("is false when Flash sees, or any picture model is set", () => {
    expect(openclawCannotSeePictures(box(["text", "image"]))).toBe(false);
    expect(openclawCannotSeePictures(box(["text"], { primary: "deepseek/gpt-5.6-luna" }))).toBe(false);
    expect(openclawCannotSeePictures(box(["text"], "google/gemini-2.5-flash"))).toBe(false);
    expect(openclawCannotSeePictures(box(["text"], { fallbacks: ["google/gemini-2.5-flash"] }))).toBe(false);
  });

  it("is false for another provider's chat, and on any doubt", () => {
    expect(openclawCannotSeePictures(box(["text"], undefined, "anthropic/claude-opus-5"))).toBe(false);
    expect(openclawCannotSeePictures({})).toBe(false);
    expect(openclawCannotSeePictures(null)).toBe(false);
    expect(openclawCannotSeePictures(box([] as string[]).agents)).toBe(false);
  });
});

describe("the OpenClaw attach button", () => {
  it("stays unless the box positively cannot see", () => {
    expect(capabilitiesFor("openclaw", UNKNOWN_FACTS).canAttachImages).toBe(true);
    expect(capabilitiesFor("openclaw", { ...UNKNOWN_FACTS, openclawCannotSeePictures: true }).canAttachImages).toBe(false);
    expect(capabilitiesFor("openclaw", { ...UNKNOWN_FACTS, openclawCannotSeePictures: true }).canAttachDocuments).toBe(true);
  });
});
