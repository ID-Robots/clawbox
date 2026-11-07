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

describe("a picture a text-only ClawBox AI chat model can only look at through a tool", () => {
  it("is read off openclaw.json as the tool route", async () => {
    const { openclawPictureRoute } = await import("@/lib/clawbox-ai-vision-route");
    expect(openclawPictureRoute(box(["text"], { primary: "deepseek/gpt-5.6-luna" }))).toBe("tool");
    expect(openclawPictureRoute(box(["text", "image"], { primary: "deepseek/deepseek-v4-flash" }))).toBe("direct");
    expect(openclawPictureRoute(box(["text"]))).toBe("none");
    expect(openclawPictureRoute(box(["text"], undefined, "anthropic/claude-opus-5"))).toBe("other");
  });

  it("becomes a capability only OpenClaw carries", () => {
    expect(capabilitiesFor("openclaw", { ...UNKNOWN_FACTS, openclawPicturesViaTool: true }).picturesViaTool).toBe(true);
    expect(capabilitiesFor("openclaw", UNKNOWN_FACTS).picturesViaTool).toBe(false);
  });

  it("names the picture with the way to look at it, and reads back as the same picture", async () => {
    const { attachmentLine } = await import("@/lib/harness/openclaw-gateway-adapter");
    const { splitUserAttachments } = await import("@/lib/chat-media");
    const picture = { path: "/home/clawbox/.openclaw/media/chat-attachments/abc-shot.png", type: "image/png" };
    const doc = { path: "/home/clawbox/.openclaw/media/chat-attachments/abc-notes.pdf", type: "application/pdf" };

    expect(attachmentLine(picture, false)).toBe(`[Attached file: ${picture.path}]`);
    const line = attachmentLine(picture, true);
    expect(line).toMatch(/^\[Attached image: \/home\/clawbox\/.*shot\.png — .*view_image tool.*\]$/);
    expect(attachmentLine(doc, true)).toBe(`[Attached file: ${doc.path}]`);

    const plain = splitUserAttachments(`[Attached file: ${picture.path}]\nwhat is this?`);
    const hinted = splitUserAttachments(`${line}\nwhat is this?`);
    expect(hinted).toEqual(plain);
    expect(hinted.text).toBe("what is this?");
    expect(hinted.images).toHaveLength(1);
  });
});
