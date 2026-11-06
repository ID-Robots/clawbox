import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, ECONOMY_MODELS, OPENAI_MODELS } from "@/lib/coding-provider";
import { codingModelName, memberModelFields, modelsLabel, runModelId, runModelLabel, teamMemberModels, teamModelsLabel } from "@/lib/coding-model-names";

describe("codingModelName", () => {
  it("names every OpenAI model a run can carry in the owner's style", () => {
    expect(codingModelName("gpt-6-astra")).toBe("GPT 6 Astra");
    expect(codingModelName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(codingModelName("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(codingModelName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(codingModelName("gpt-5.5")).toBe("GPT 5.5");
    expect(codingModelName("gpt-5.2")).toBe("GPT 5.2");
  });

  it("has a short name for every model the providers offer, and their economy models", () => {
    for (const id of [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...Object.values(ECONOMY_MODELS)]) {
      expect(codingModelName(id), id).not.toBe(id);
    }
  });

  it("keeps the Anthropic and ClawBox AI names", () => {
    expect(codingModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(codingModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(codingModelName("deepseek-v4-flash")).toBe("DeepSeek Flash");
    expect(codingModelName("deepseek-v4-pro[1m]")).toBe("DeepSeek Flash");
  });

  it("prettifies an unknown gpt id and an unknown claude-<family>-<major>-<minor> id", () => {
    expect(codingModelName("gpt-5.7-sol")).toBe("GPT 5.7 Sol");
    expect(codingModelName("gpt-7")).toBe("GPT 7");
    expect(codingModelName("gpt-5.3-codex-spark")).toBe("GPT 5.3 Codex Spark");
    expect(codingModelName("claude-haiku-5-2")).toBe("Haiku 5.2");
    expect(codingModelName("claude-opus-6-1[1m]")).toBe("Opus 6.1");
  });

  it("returns an id of any other shape as it is", () => {
    expect(codingModelName("mistral-large-3")).toBe("mistral-large-3");
    expect(codingModelName("claude-opus-4-20250514")).toBe("claude-opus-4-20250514");
    expect(codingModelName("gpt")).toBe("gpt");
    // A family and a major alone is not the shape the fallback reads.
    expect(codingModelName("claude-next-9")).toBe("claude-next-9");
    expect(codingModelName("")).toBe("");
  });
});

describe("runModelId / runModelLabel", () => {
  it("prefers what answered, then what was billed, then what was asked for", () => {
    expect(runModelId({ model: "claude-opus-5-5", modelsUsed: ["claude-sonnet-5"], requestedModel: "claude-sonnet-5" })).toBe("claude-opus-5-5");
    // modelsUsed is sorted by id: the one asked for wins when it is among them…
    expect(runModelId({ modelsUsed: ["claude-haiku-5", "claude-opus-5-5"], requestedModel: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    // …else the first of them.
    expect(runModelId({ modelsUsed: ["gpt-5.6-sol"], requestedModel: "gpt-6-astra" })).toBe("gpt-5.6-sol");
    expect(runModelId({ requestedModel: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
    expect(runModelLabel({ requestedModel: "gpt-5.6-sol" })).toBe("GPT 5.6 Sol");
  });

  it("invents nothing when nothing is known", () => {
    expect(runModelId(null)).toBeNull();
    expect(runModelId({})).toBeNull();
    expect(runModelId({ model: "", modelsUsed: [], requestedModel: null })).toBeNull();
    expect(runModelLabel({ model: "  " })).toBeNull();
  });
});

describe("modelsLabel / teamModelsLabel", () => {
  it("joins distinct short names, at most two, then +N", () => {
    expect(modelsLabel([{ model: "claude-opus-5-5" }, { model: "claude-opus-5-5" }])).toEqual({ label: "Opus 5.5", ids: ["claude-opus-5-5"] });
    expect(modelsLabel([{ model: "claude-opus-5-5" }, { requestedModel: "gpt-5.6-sol" }])?.label).toBe("Opus 5.5 · GPT 5.6 Sol");
    expect(modelsLabel([{ model: "claude-opus-5-5" }, { model: "gpt-5.6-sol" }, { model: "deepseek-v4-flash" }, { model: "claude-sonnet-5" }])?.label).toBe("Opus 5.5 · GPT 5.6 Sol +2");
    // Two ids, one name: counted once.
    expect(modelsLabel([{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }])).toEqual({ label: "DeepSeek Flash", ids: ["deepseek-v4-flash", "deepseek-v4-pro"] });
    expect(modelsLabel([{}, null])).toBeNull();
  });

  it("names a team's workers first", () => {
    const members = [
      { role: "planner", model: "claude-opus-5-5" },
      { role: "worker", model: "claude-sonnet-5" },
      { role: "reviewer", model: "gpt-5.6-sol" },
    ];
    expect(teamModelsLabel(members)?.label).toBe("Sonnet 5 · Opus 5.5 +1");
  });

  it("lays a run record's answer over the cast list", () => {
    const team = { runs: [{ id: "a", role: "worker", model: "claude-sonnet-5" }, { id: "b", role: "planner", model: null }] };
    const runs: Record<string, { model?: string | null; requestedModel?: string | null }> = { a: { model: "claude-opus-5-5" }, b: { requestedModel: "gpt-6-astra" } };
    expect(teamMemberModels(team, (id) => runs[id]).map(runModelId)).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
    expect(runModelId(memberModelFields({ model: "claude-sonnet-5" }, undefined))).toBe("claude-sonnet-5");
    expect(teamMemberModels({})).toEqual([]);
  });
});
