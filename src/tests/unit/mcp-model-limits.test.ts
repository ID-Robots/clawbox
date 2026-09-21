import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { readConfiguredModelLimits } from "../../../mcp/tools/orientation";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-model-limits-"));

function configFile(name: string, config: unknown): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("managed model-limit guidance", () => {
  it("requires a live check without supplying a memorized answer", () => {
    const instructions = fs.readFileSync(
      path.join(process.cwd(), "mcp", "clawbox-mcp.ts"),
      "utf8",
    );
    expect(instructions).toContain("call `device_status`");
    expect(instructions).toContain("use `ai.limits`");
    expect(instructions).toMatch(/never infer/i);
    expect(instructions).not.toMatch(/128(?:,?000|K)|1(?:,?000,?000|M)|393(?:,?216|K)/i);
  });
});

describe("readConfiguredModelLimits", () => {
  it("reads the active model rather than guessing from its id", () => {
    const file = configFile("valid.json", {
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
      models: {
        providers: {
          deepseek: {
            models: [
              { id: "deepseek-v4-flash", contextWindow: 111, maxTokens: 222 },
              { id: "deepseek-v4-pro", contextWindow: 1_000_000, maxTokens: 393_216 },
            ],
          },
        },
      },
    });

    expect(readConfiguredModelLimits(file)).toEqual({
      model: "deepseek/deepseek-v4-pro",
      context_window_tokens: 1_000_000,
      max_output_tokens: 393_216,
      source: "openclaw_config",
    });
  });

  it("reports unknown instead of inventing unavailable limits", () => {
    expect(readConfiguredModelLimits("/does/not/exist")).toBe("unknown");
    const file = configFile("invalid-limits.json", {
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
      models: {
        providers: {
          deepseek: { models: [{ id: "deepseek-v4-pro", contextWindow: -1 }] },
        },
      },
    });

    expect(readConfiguredModelLimits(file)).toEqual({
      model: "deepseek/deepseek-v4-pro",
      context_window_tokens: "unknown",
      max_output_tokens: "unknown",
      source: "openclaw_config",
    });
  });
});
