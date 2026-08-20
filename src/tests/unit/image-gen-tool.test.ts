import { describe, expect, it } from "vitest";
import { isImageGenerationTool } from "@/lib/chat-tool-events";

describe("isImageGenerationTool", () => {
  it("matches the tool the harness actually calls", () => {
    expect(isImageGenerationTool("image_generate")).toBe(true);
  });

  it("matches the other spellings the same event can arrive under", () => {
    expect(isImageGenerationTool("generate_image")).toBe(true);
    expect(isImageGenerationTool("image_generation")).toBe(true);
    expect(isImageGenerationTool("imagegen")).toBe(true);
    expect(isImageGenerationTool("IMAGE_GENERATE")).toBe(true);
  });

  it("sees through an MCP server prefix", () => {
    expect(isImageGenerationTool("mcp__openai__image_generate")).toBe(true);
    expect(isImageGenerationTool("clawbox__generate_image")).toBe(true);
  });

  it("does not match unrelated tools", () => {
    for (const name of ["bash", "read_file", "web_search", "screen_capture"]) {
      expect(isImageGenerationTool(name)).toBe(false);
    }
  });

  it("does not match a tool that only mentions one half", () => {
    expect(isImageGenerationTool("image_read")).toBe(false);
    expect(isImageGenerationTool("code_generate")).toBe(false);
  });

  it("handles an empty name", () => {
    expect(isImageGenerationTool("")).toBe(false);
  });
});
