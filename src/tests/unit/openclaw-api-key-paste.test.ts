import { describe, expect, it, vi } from "vitest";
import { apiKeyPasteChangesNothing } from "@/lib/openclaw-api-key-paste";
import type { OpenClawConfig } from "@/lib/openclaw-config";

/**
 * When the configure route may leave out `openclaw models auth paste-api-key`
 * (TASK-1535). A Settings save re-sends the credential the box already holds,
 * and the ClawBox AI pass pasted the same token twice in one request — two CLI
 * starts of 5-14 s on a Jetson for nothing. Skipping is only right when the
 * paste would change nothing anywhere it writes: the store, `auth.profiles`,
 * and `auth.order` (`saveModelProviderApiKey` → `applyAuthProfileConfig` in the
 * pinned core). Every doubt answers false — a paste that did not need to run
 * costs seconds; a skipped one that did leaves the box on a stale credential.
 */

const ID = "deepseek:default";
const KEY = "claw_FAKE-token";

function config(patch: Record<string, unknown> = {}, auth: Record<string, unknown> = {}): OpenClawConfig {
  return {
    auth: { profiles: { [ID]: { provider: "deepseek", mode: "api_key" } }, ...auth },
    models: { providers: { deepseek: { apiKey: KEY } } },
    ...patch,
  } as OpenClawConfig;
}

function ask(cfg: OpenClawConfig, storeHolds = true, overrides: Partial<{ provider: string; profileId: string; key: string }> = {}) {
  const storeHoldsKey = vi.fn(() => storeHolds);
  const answer = apiKeyPasteChangesNothing({ config: cfg, provider: "deepseek", profileId: ID, key: KEY, storeHoldsKey, ...overrides });
  return { answer, storeHoldsKey };
}

describe("apiKeyPasteChangesNothing", () => {
  it("is true for the re-save: the store holds the key, the profile entry is the paste's, nothing to reorder", () => {
    const { answer, storeHoldsKey } = ask(config());
    expect(answer).toBe(true);
    expect(storeHoldsKey).toHaveBeenCalledWith(ID, "deepseek", KEY);
  });

  it("keeps the two fields the paste keeps", () => {
    expect(ask(config({}, { profiles: { [ID]: { provider: "deepseek", mode: "api_key", email: "a@b.example", displayName: "Box" } } })).answer).toBe(true);
  });

  it("is false when the store does not hold this key — a new or rotated token", () => {
    expect(ask(config(), false).answer).toBe(false);
  });

  it("is false when the profile entry is not the one the paste writes", () => {
    for (const entry of [
      undefined,
      { provider: "deepseek", mode: "oauth" },
      { provider: "openai", mode: "api_key" },
      { provider: "deepseek", mode: "api_key", label: "kept by nobody" },
      { provider: "deepseek", mode: "api_key", email: "" },
    ]) {
      const cfg = config({}, { profiles: entry ? { [ID]: entry } : {} });
      const { answer, storeHoldsKey } = ask(cfg);
      expect(answer).toBe(false);
      expect(storeHoldsKey).not.toHaveBeenCalled();
    }
  });

  it("is false when the provider has a peer profile the paste could reorder against", () => {
    const peers = { [ID]: { provider: "deepseek", mode: "api_key" }, "deepseek:backup": { provider: "deepseek", mode: "oauth" } };
    expect(ask(config({}, { profiles: peers })).answer).toBe(false);
    // An alias-looking peer counts too: the core resolves provider aliases.
    const aliased = { [ID]: { provider: "deepseek", mode: "api_key" }, "deepseek-legacy:x": { mode: "oauth" } };
    expect(ask(config({}, { profiles: aliased })).answer).toBe(false);
    // Another provider's profile does not.
    const unrelated = { [ID]: { provider: "deepseek", mode: "api_key" }, "openai:default": { provider: "openai", mode: "oauth" } };
    expect(ask(config({}, { profiles: unrelated })).answer).toBe(true);
  });

  it("is true for an order this profile already leads, false for one it would move in", () => {
    expect(ask(config({}, { order: { deepseek: [ID] } })).answer).toBe(true);
    expect(ask(config({}, { order: { deepseek: ["deepseek:other", ID] } })).answer).toBe(false);
    expect(ask(config({}, { order: { deepseek: [ID, ID] } })).answer).toBe(false);
    expect(ask(config({}, { order: { DeepSeek: [ID] } })).answer).toBe(false);
    expect(ask(config({}, { order: { openai: ["openai:default"] } })).answer).toBe(true);
  });

  it("is false on a box with an agent roster: the paste's store may be one this never read", () => {
    expect(ask(config({ agents: { entries: { "pro-agent": {} } } })).answer).toBe(false);
    expect(ask(config({ agents: { list: [{ id: "pro-agent" }] } })).answer).toBe(false);
    expect(ask(config({ agents: { entries: { main: {} } } })).answer).toBe(true);
  });

  it("is false for what it cannot read", () => {
    expect(ask({} as OpenClawConfig).answer).toBe(false);
    expect(ask(config(), true, { key: "" }).answer).toBe(false);
    expect(ask(config(), true, { provider: "DeepSeek" }).answer).toBe(false);
    expect(ask(config({}, { order: [] })).answer).toBe(false);
  });
});
