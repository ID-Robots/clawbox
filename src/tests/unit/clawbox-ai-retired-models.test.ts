import { describe, it, expect } from "vitest";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
  flashRefFor,
  hermesSlotFlashTarget,
  isRetiredClawboxAiChatModel,
  isRetiredClawboxAiModel,
  isRetiredClawboxAiVisionModel,
  migrateRetiredClawboxAiOpenclawAgents,
  migrateRetiredClawboxAiPick,
} from "@/lib/clawbox-ai-retired-models";

// ClawBox AI is ONE model (TASK-2261). These are the TypeScript halves of the
// migration that moves a box off the ids it replaced; the boot script's Python
// half is pinned by gateway-pre-start-clawai-one-model.test.ts.

const PRO_ID = RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0];
const [VISION_EXP] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;
/** The vision fallback: a LIVE id, never retired (src/lib/clawbox-ai-vision.ts). */
const FALLBACK = "gpt-5.6-luna";
const FLASH = "deepseek/deepseek-v4-flash";

describe("recognising a retired ClawBox AI id", () => {
  it("knows the former Max-plan id and the separate vision model's id — not the live fallback", () => {
    expect(PRO_ID).toBe("deepseek-v4-pro");
    expect(RETIRED_CLAWBOX_AI_VISION_MODEL_IDS).toEqual(["deepseek-v4-flash-vision-exp"]);
    expect(isRetiredClawboxAiModel(`deepseek/${FALLBACK}`)).toBe(false);
  });

  it("reads refs under ClawBox AI's provider, in either spelling", () => {
    expect(isRetiredClawboxAiChatModel(`deepseek/${PRO_ID}`)).toBe(true);
    expect(isRetiredClawboxAiChatModel(`clawai/${PRO_ID}`)).toBe(true);
    expect(isRetiredClawboxAiChatModel(`ClawAI/${PRO_ID}`)).toBe(true);
    expect(isRetiredClawboxAiVisionModel(`deepseek/${VISION_EXP}`)).toBe(true);
    expect(isRetiredClawboxAiVisionModel(`clawai/${VISION_EXP}`)).toBe(true);
  });

  it("needs a bare id to be asked for one", () => {
    expect(isRetiredClawboxAiChatModel(PRO_ID)).toBe(false);
    expect(isRetiredClawboxAiChatModel(PRO_ID, { bare: true })).toBe(true);
    expect(isRetiredClawboxAiVisionModel(VISION_EXP, { bare: true })).toBe(true);
  });

  it("never claims another provider's model of the same name", () => {
    expect(isRetiredClawboxAiModel(`openai/${FALLBACK}`)).toBe(false);
    expect(isRetiredClawboxAiModel(`openrouter/deepseek/${PRO_ID}`)).toBe(false);
    expect(isRetiredClawboxAiModel(`deepseek/${PRO_ID}`, { deepseekIsClawboxAi: false })).toBe(false);
    expect(isRetiredClawboxAiModel(`clawai/${PRO_ID}`, { deepseekIsClawboxAi: false })).toBe(true);
  });

  it("keeps the chat model's context suffix, and a vision id never carries one", () => {
    expect(isRetiredClawboxAiChatModel(`${PRO_ID}[1m]`, { bare: true })).toBe(true);
    expect(flashRefFor(`${PRO_ID}[1m]`)).toBe("deepseek-v4-flash[1m]");
    expect(isRetiredClawboxAiVisionModel(`${VISION_EXP}[1m]`, { bare: true })).toBe(false);
  });

  it("is not fooled by Flash itself or by junk", () => {
    for (const value of [FLASH, "deepseek-v4-flash", "", "  ", null, undefined, 7, {}]) {
      expect(isRetiredClawboxAiModel(value, { bare: true })).toBe(false);
    }
  });

  it("writes Flash back in the shape the ref came in", () => {
    expect(flashRefFor(`deepseek/${PRO_ID}`)).toBe(FLASH);
    expect(flashRefFor(`clawai/${VISION_EXP}`)).toBe("clawai/deepseek-v4-flash");
    expect(flashRefFor(VISION_EXP)).toBe("deepseek-v4-flash");
  });
});

describe("migrateRetiredClawboxAiOpenclawAgents", () => {
  it("moves every chat slot that names a retired id and reports the paths to write", () => {
    const agents = {
      defaults: {
        model: { primary: `deepseek/${PRO_ID}`, fallbacks: [FLASH] },
        imageGenerationModel: { primary: "litellm/gpt-image-1-mini" },
        compaction: { model: `deepseek/${PRO_ID}` },
        modelPolicy: { allow: [`clawai/${PRO_ID}`, "clawai/deepseek-v4-flash"] },
      },
      list: [{ id: "main", model: `deepseek/${PRO_ID}` }],
    };
    const before = structuredClone(agents);
    const result = migrateRetiredClawboxAiOpenclawAgents(agents);

    expect(agents).toEqual(before);
    expect(result.agents).toEqual({
      defaults: {
        model: { primary: FLASH, fallbacks: [FLASH] },
        imageGenerationModel: { primary: "litellm/gpt-image-1-mini" },
        compaction: { model: FLASH },
        modelPolicy: { allow: ["clawai/deepseek-v4-flash"] },
      },
      list: [{ id: "main", model: FLASH }],
    });
    expect(result.changedPaths).toEqual([
      "agents.defaults.compaction",
      "agents.defaults.model",
      "agents.defaults.modelPolicy",
      "agents.list",
    ]);
  });

  it("leaves the picture slot to the vision check", () => {
    const agents = { defaults: { imageModel: { primary: `deepseek/${VISION_EXP}`, fallbacks: [`deepseek/${PRO_ID}`] } } };
    expect(migrateRetiredClawboxAiOpenclawAgents(agents)).toEqual({ agents, changedPaths: [] });
  });

  it("drops a second Flash a move produced, whichever side it is on", () => {
    expect(migrateRetiredClawboxAiOpenclawAgents({ defaults: { model: { fallbacks: [`deepseek/${PRO_ID}`, FLASH] } } }).agents)
      .toEqual({ defaults: { model: { fallbacks: [FLASH] } } });
    expect(migrateRetiredClawboxAiOpenclawAgents({ defaults: { model: { fallbacks: [FLASH, `deepseek/${PRO_ID}`] } } }).agents)
      .toEqual({ defaults: { model: { fallbacks: [FLASH] } } });
  });

  it("renames a key of the models map, and yields to a Flash key already there", () => {
    expect(migrateRetiredClawboxAiOpenclawAgents({ defaults: { models: { [`deepseek/${PRO_ID}`]: { alias: "a" } } } }))
      .toEqual({ agents: { defaults: { models: { [FLASH]: { alias: "a" } } } }, changedPaths: ["agents.defaults.models"] });
    expect(migrateRetiredClawboxAiOpenclawAgents({
      defaults: { models: { [`deepseek/${PRO_ID}`]: { alias: "a" }, [FLASH]: { alias: "mine" } } },
    }).agents).toEqual({ defaults: { models: { [FLASH]: { alias: "mine" } } } });
  });

  it("changes nothing on a box that names no retired id, or an owner's own", () => {
    const agents = {
      defaults: {
        model: { primary: "anthropic/claude-opus-5", fallbacks: [FLASH] },
        imageModel: `openai/${FALLBACK}`,
      },
    };
    expect(migrateRetiredClawboxAiOpenclawAgents(agents)).toEqual({ agents, changedPaths: [] });
    expect(migrateRetiredClawboxAiOpenclawAgents(undefined)).toEqual({ agents: undefined, changedPaths: [] });
  });

  it("leaves `deepseek/…` alone when that provider is a raw DeepSeek account", () => {
    const agents = { defaults: { model: { primary: `deepseek/${PRO_ID}` } } };
    expect(migrateRetiredClawboxAiOpenclawAgents(agents, { deepseekIsClawboxAi: false }).changedPaths).toEqual([]);
  });
});

describe("hermesSlotFlashTarget", () => {
  it("moves the retired Max-plan id under provider clawai", () => {
    expect(hermesSlotFlashTarget("clawai", PRO_ID)).toBe("deepseek-v4-flash");
    expect(hermesSlotFlashTarget(" ClawAI ", PRO_ID)).toBe("deepseek-v4-flash");
  });

  it("leaves the owner's slot alone", () => {
    expect(hermesSlotFlashTarget("clawai", "deepseek-v4-flash")).toBeNull();
    expect(hermesSlotFlashTarget("openrouter", PRO_ID)).toBeNull();
    expect(hermesSlotFlashTarget("auto", PRO_ID)).toBeNull();
  });

  it("never moves a vision id into a chat slot", () => {
    expect(hermesSlotFlashTarget("clawai", VISION_EXP)).toBeNull();
    expect(hermesSlotFlashTarget("clawai", FALLBACK)).toBeNull();
  });
});

describe("migrateRetiredClawboxAiPick", () => {
  it("moves the ClawBox AI pick in the spelling it was stored in", () => {
    expect(migrateRetiredClawboxAiPick({ clawai: `deepseek/${PRO_ID}`, anthropic: "anthropic/claude-opus-5" }))
      .toEqual({ clawai: FLASH, anthropic: "anthropic/claude-opus-5" });
    expect(migrateRetiredClawboxAiPick({ clawai: PRO_ID })).toEqual({ clawai: "deepseek-v4-flash" });
  });

  it("answers null when there is nothing to move", () => {
    expect(migrateRetiredClawboxAiPick({ clawai: FLASH })).toBeNull();
    expect(migrateRetiredClawboxAiPick({ openrouter: `deepseek/${PRO_ID}` })).toBeNull();
    expect(migrateRetiredClawboxAiPick(null)).toBeNull();
    expect(migrateRetiredClawboxAiPick("clawai")).toBeNull();
  });
});
