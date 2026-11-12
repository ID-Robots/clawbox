import { describe, expect, it } from "vitest";
import { cliDiagnosticFromModelsList, cliJsonFromModelsList } from "@/lib/openclaw-models-list";
import {
  CLI_STDERR,
  CLI_STDERR_OUTCOMES_REVERSED,
  CLI_STDOUT,
  GATEWAY_ANSWER,
} from "../fixtures/openclaw-models-list-2026.10.9";

/**
 * The gateway's `models.list` answer, projected to exactly what the pinned
 * `openclaw models list --json` prints for it — the CLI sends that same request
 * to a running gateway and maps the rows with `toCliModelRow` and `modelKey`.
 * The catalogue reads the projection with the parser it already uses for the
 * CLI's stdout, so every rule here is the CLI's, not one of ClawBox's.
 */

const row = (extra: Record<string, unknown> = {}) => ({ provider: "anthropic", id: "claude-x", name: "Claude X", ...extra });
const only = (payload: Record<string, unknown>) => cliJsonFromModelsList(payload).models[0];

describe("cliJsonFromModelsList", () => {
  it("joins input modalities with '+', and prints '-' for none", () => {
    expect(only({ models: [row({ input: ["text", "image"] })] }).input).toBe("text+image");
    expect(only({ models: [row({ input: [] })] }).input).toBe("-");
    expect(only({ models: [row()] }).input).toBe("-");
  });

  it("adds the alias as a tag, once", () => {
    expect(only({ models: [row({ tags: ["default"], alias: "x" })] }).tags).toEqual(["default", "alias:x"]);
    expect(only({ models: [row({ tags: ["alias:x"], alias: "x" })] }).tags).toEqual(["alias:x"]);
    expect(only({ models: [row()] }).tags).toEqual([]);
  });

  it("builds the key the way the core's modelKey does", () => {
    expect(only({ models: [row()] }).key).toBe("anthropic/claude-x");
    // An id that already carries its provider keeps one prefix (compared lowercase, trimmed).
    expect(only({ models: [{ provider: " OpenAI ", id: "openai/gpt-x" }] }).key).toBe("openai/gpt-x");
    expect(only({ models: [{ provider: "", id: "gpt-x" }] }).key).toBe("gpt-x");
    expect(only({ models: [{ provider: "openai", id: " " }] }).key).toBe("openai");
  });

  it("prints null for what the gateway did not say, and contextTokens only when it did", () => {
    const bare = only({ models: [row()] });
    expect(bare.contextWindow).toBeNull();
    expect(bare.local).toBeNull();
    expect(bare.available).toBeNull();
    expect("contextTokens" in bare).toBe(false);

    const full = only({ models: [row({ contextWindow: 200_000, contextTokens: 100_000, local: false, available: true })] });
    expect(full).toEqual({
      key: "anthropic/claude-x",
      name: "Claude X",
      input: "-",
      contextWindow: 200_000,
      contextTokens: 100_000,
      local: false,
      available: true,
      tags: [],
    });
  });

  it("counts the rows it prints", () => {
    const out = cliJsonFromModelsList({ models: [row(), row({ id: "claude-y" })] });
    expect(out.count).toBe(2);
    expect(out.models).toHaveLength(2);
    expect(cliJsonFromModelsList({ models: [] })).toEqual({ count: 0, models: [] });
  });

  it("carries provider outcomes as { provider, profileId?, status }, and omits an empty list", () => {
    const out = cliJsonFromModelsList({
      models: [],
      providerOutcomes: [
        { provider: "anthropic", profileId: "anthropic:work", status: "auth-rejected", detail: "not printed" },
        { provider: "openai", status: "ready" },
      ],
    });
    expect(out.providerOutcomes).toEqual([
      { provider: "anthropic", profileId: "anthropic:work", status: "auth-rejected" },
      { provider: "openai", status: "ready" },
    ]);
    expect("providerOutcomes" in cliJsonFromModelsList({ models: [], providerOutcomes: [] })).toBe(false);
  });

  it("throws on a payload the CLI could not have printed", () => {
    expect(() => cliJsonFromModelsList({})).toThrow();
    expect(() => cliJsonFromModelsList({ models: { a: 1 } })).toThrow();
    expect(() => cliJsonFromModelsList({ models: [{ id: "claude-x" }] })).toThrow();
    expect(() => cliJsonFromModelsList({ models: [{ provider: "anthropic", id: 7 }] })).toThrow();
  });
});

// The fixture's gateway answer is the pinned schema's shape and its CLI side is
// what the pinned CLI's own code printed for it (see the fixture's header), so
// neither half is built from the other or from this module.
describe("one pinned gateway answer, against what the pinned CLI printed for it", () => {
  it("projects to the CLI's --json stdout", () => {
    expect(cliJsonFromModelsList(GATEWAY_ANSWER)).toEqual(CLI_STDOUT);
  });

  it("says what the CLI wrote to stderr, outcome by outcome in the order the gateway sent them", () => {
    expect(cliDiagnosticFromModelsList(GATEWAY_ANSWER)).toBe(CLI_STDERR.join("\n"));
    const reversed = { ...GATEWAY_ANSWER, providerOutcomes: [...GATEWAY_ANSWER.providerOutcomes].reverse() };
    expect(cliDiagnosticFromModelsList(reversed)).toBe(CLI_STDERR_OUTCOMES_REVERSED.join("\n"));
  });
});

describe("cliDiagnosticFromModelsList", () => {
  it("says nothing when every provider is ready and the refresh did not fail", () => {
    expect(cliDiagnosticFromModelsList({ models: [] })).toBe("");
    expect(cliDiagnosticFromModelsList({ models: [], providerOutcomes: [{ provider: "openai", status: "ready" }] })).toBe("");
  });

  it("uses the CLI's own stderr sentences", () => {
    expect(cliDiagnosticFromModelsList({ models: [], refreshFailed: true }))
      .toBe("Model discovery could not refresh all providers. Showing the available published model list.");
    expect(cliDiagnosticFromModelsList({
      models: [],
      providerOutcomes: [
        { provider: "anthropic", profileId: "anthropic:work", status: "auth-rejected" },
        { provider: "xai", status: "unavailable" },
        { provider: "openai", status: "ready" },
      ],
    })).toBe([
      "Model discovery authentication was rejected for anthropic (profile anthropic:work). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
      "Model discovery is unavailable for xai. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.",
    ].join("\n"));
  });
});
