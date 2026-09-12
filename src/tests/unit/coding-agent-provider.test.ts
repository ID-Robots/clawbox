/**
 * WHICH ACCOUNT PAYS for a coding run, and the isolation between the two.
 *
 * `claude-ds` used to have exactly one answer: Claude Code pointed at the
 * box's own ClawBox AI plan. The second is the owner's own Anthropic access.
 * What matters here, in order of how much it would cost to get wrong:
 *
 *  1. The two credentials never meet. `buildRunEnv` names ONE provider and
 *     carries NEITHER secret — the wrapper reads what it needs out of the
 *     box's 0600 config — and a stale CLAUDE_DS_MODEL from the environment
 *     cannot follow a run onto the provider it does not belong to. (The
 *     shipped wrapper's own half of this is pinned against the real script in
 *     claude-ds-wrapper.test.ts, with the other provider's variables already
 *     exported.)
 *  2. A model named for the wrong provider is refused, in one place, so the
 *     HTTP route and the MCP tool cannot drift into disagreeing.
 *  3. Readiness is per provider. A box can be perfectly healthy on one and
 *     unconnected on the other, and `ready` — the field the MCP probe reads —
 *     has to mean "a run started right now would work", which is the box's
 *     half plus the DEFAULT provider's.
 *  4. The helper sub-agents run on a model the answering account HAS.
 *     `deepseek-v4-flash` is not a name Anthropic knows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

// The Anthropic side of readiness is two files in the owner's home; mocked so
// these cases are about the RULE and not about the developer's own ~/.claude.
const getAnthropicConnection = vi.hoisted(() => vi.fn());
const hasAnthropicLogin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-anthropic")>()),
  getAnthropicConnection,
  hasAnthropicLogin,
}));

import {
  ANTHROPIC_MODELS,
  CODING_AGENT_PROVIDER_CONFIG_KEY,
  CODING_PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CODING_PROVIDER,
  codingProviderFrom,
  modelsForProvider,
  resolveRunProvider,
} from "@/lib/coding-provider";
import {
  CodingAgentError,
  HELPER_MODEL,
  buildRunArgs,
  buildRunEnv,
  getCodingProvider,
  setCodingProvider,
  subagentDefinitionsFor,
} from "@/lib/coding-agent";

const DISCONNECTED = { connected: false, hasKey: false, hasLogin: false, source: null };
const VIA_KEY = { connected: true, hasKey: true, hasLogin: false, source: "key" as const };

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
  getAnthropicConnection.mockReset().mockResolvedValue(DISCONNECTED);
  hasAnthropicLogin.mockReset().mockReturnValue(false);
});

describe("the vocabulary", () => {
  it("offers exactly the two accounts a run can be paid from, ClawBox AI first", () => {
    expect([...CODING_PROVIDERS]).toEqual(["clawbox-ai", "anthropic"]);
    // The whole installed base is on this one, and a default that moved would
    // put every existing box on its owner's personal bill.
    expect(DEFAULT_CODING_PROVIDER).toBe("clawbox-ai");
  });

  it("reads anything unrecognised as the default rather than refusing", () => {
    expect(codingProviderFrom(undefined)).toBe("clawbox-ai");
    expect(codingProviderFrom("openai")).toBe("clawbox-ai");
    expect(codingProviderFrom(7)).toBe("clawbox-ai");
    expect(codingProviderFrom("anthropic")).toBe("anthropic");
  });

  it("names models for Anthropic only — the ClawBox AI plan chooses its own", () => {
    expect([...modelsForProvider("anthropic")]).toEqual([...ANTHROPIC_MODELS]);
    expect(modelsForProvider("clawbox-ai")).toEqual([]);
    expect(ANTHROPIC_MODELS).toContain(DEFAULT_ANTHROPIC_MODEL);
  });
});

describe("resolveRunProvider — the one validator both surfaces use", () => {
  it("falls back to the owner's default when the caller names nothing", () => {
    expect(resolveRunProvider(undefined, undefined, "anthropic")).toEqual({
      ok: true, provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL,
    });
    expect(resolveRunProvider(null, null, "clawbox-ai")).toEqual({
      ok: true, provider: "clawbox-ai", model: null,
    });
  });

  it("refuses a provider that is not one of the two, naming both", () => {
    const out = resolveRunProvider("openai", undefined, "clawbox-ai");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/clawbox-ai, anthropic/);
  });

  it("refuses a model named for ClawBox AI rather than ignoring it", () => {
    // Accepting and dropping it is the failure this selector exists to stop:
    // a run that quietly answered on a different model than the one asked for.
    const out = resolveRunProvider("clawbox-ai", "claude-opus-5", "clawbox-ai");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/cannot be named/);
  });

  it("refuses a model the Anthropic list does not carry", () => {
    const out = resolveRunProvider("anthropic", "claude-3-opus", "clawbox-ai");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/claude-opus-5/);
  });

  it("accepts each offered Anthropic model", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(resolveRunProvider("anthropic", model, "clawbox-ai")).toEqual({ ok: true, provider: "anthropic", model });
    }
  });

  it("refuses a model that is not a string at all", () => {
    expect(resolveRunProvider("anthropic", 5, "clawbox-ai").ok).toBe(false);
  });
});

describe("the owner's default", () => {
  it("is ClawBox AI until they choose, and survives a junk value", async () => {
    expect(await getCodingProvider()).toBe("clawbox-ai");
    configGet.mockResolvedValue("openai");
    expect(await getCodingProvider()).toBe("clawbox-ai");
  });

  it("stores a provider the device knows", async () => {
    expect(await setCodingProvider("anthropic")).toBe("anthropic");
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_PROVIDER_CONFIG_KEY, "anthropic");
  });

  it("refuses one it does not, and writes nothing", async () => {
    await expect(setCodingProvider("openai")).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("can be set to a provider that is not connected yet", async () => {
    // Deliberate: the owner picks the account and THEN pastes the key. A
    // picker that refused the first half of that would be unusable. Starting
    // a run is what is gated.
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    await expect(setCodingProvider("anthropic")).resolves.toBe("anthropic");
  });
});

describe("the run environment", () => {
  it("carries NEITHER credential — the wrapper reads what it needs itself", () => {
    const env = buildRunEnv({ provider: "anthropic", model: "claude-opus-5" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(Object.values(env).some((v) => v.startsWith("sk-ant-"))).toBe(false);
  });

  it("always names a provider, so an inherited one cannot decide who is billed", () => {
    const prev = process.env.CLAUDE_DS_PROVIDER;
    process.env.CLAUDE_DS_PROVIDER = "anthropic";
    try {
      expect(buildRunEnv({ provider: "clawbox-ai" }).CLAUDE_DS_PROVIDER).toBe("clawbox-ai");
      // And with no opts at all it is the default, not the inherited value.
      expect(buildRunEnv().CLAUDE_DS_PROVIDER).toBe("clawbox-ai");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_DS_PROVIDER;
      else process.env.CLAUDE_DS_PROVIDER = prev;
    }
  });

  it("passes the run's model, and drops an inherited one on a provider that would not honour it", () => {
    const prev = process.env.CLAUDE_DS_MODEL;
    process.env.CLAUDE_DS_MODEL = "deepseek-v4-pro[1m]";
    try {
      expect(buildRunEnv({ provider: "anthropic", model: "claude-sonnet-5" }).CLAUDE_DS_MODEL).toBe("claude-sonnet-5");
      // An Anthropic run with no model named must not inherit a DeepSeek one:
      // the model name would reach real Anthropic, which has never heard of it.
      expect(buildRunEnv({ provider: "anthropic" }).CLAUDE_DS_MODEL).toBeUndefined();
      // The ClawBox AI branch keeps the owner's own documented override.
      expect(buildRunEnv({ provider: "clawbox-ai" }).CLAUDE_DS_MODEL).toBe("deepseek-v4-pro[1m]");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_DS_MODEL;
      else process.env.CLAUDE_DS_MODEL = prev;
    }
  });
});

describe("the helper sub-agents", () => {
  it("run on a model the answering account actually has", () => {
    expect(HELPER_MODEL["clawbox-ai"]).toBe("deepseek-v4-flash");
    // Claude Code's own alias for the cheap tier of whatever it is signed
    // into — the split the definitions describe, on an account that has no
    // DeepSeek in it.
    expect(HELPER_MODEL.anthropic).toBe("haiku");
  });

  it("rewrites every definition's model for an anthropic run, and nothing else", () => {
    const clawbox = subagentDefinitionsFor("clawbox-ai");
    const anthropic = subagentDefinitionsFor("anthropic");
    expect(Object.keys(anthropic)).toEqual(Object.keys(clawbox));
    for (const name of Object.keys(anthropic)) {
      const before = clawbox[name] as { model: string; description: string; tools: string[] };
      const after = anthropic[name] as { model: string; description: string; tools: string[] };
      expect(after.model).toBe("haiku");
      expect(after.description).toBe(before.description);
      expect(after.tools).toEqual(before.tools);
    }
  });

  it("puts the right definitions on the command line", () => {
    const argsFor = (provider: "clawbox-ai" | "anthropic") => {
      const args = buildRunArgs({ provider, run: { id: "run-k3x9q2ab", directory: "/tmp/x" } });
      return args[args.indexOf("--agents") + 1];
    };
    expect(argsFor("anthropic")).toContain("haiku");
    expect(argsFor("anthropic")).not.toContain("deepseek");
    expect(argsFor("clawbox-ai")).toContain("deepseek-v4-flash");
  });
});

describe("readiness, per provider", () => {
  async function readiness(config: Record<string, unknown>) {
    configGetAll.mockResolvedValue(config);
    const lib = await import("@/lib/coding-agent");
    return lib.checkReadiness();
  }

  it("reports each provider on its own credential", async () => {
    getAnthropicConnection.mockResolvedValue(VIA_KEY);
    const out = await readiness({ clawai_token: "", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic" });
    const byId = Object.fromEntries(out.providers.map((p) => [p.id, p]));
    expect(byId["clawbox-ai"].problems.join(" ")).toMatch(/ClawBox AI is not connected/);
    expect(byId.anthropic.problems).toEqual([]);
    expect(out.anthropicConnected).toBe(true);
    expect(out.anthropicSource).toBe("key");
  });

  it("never answers with the credential itself, only with whether there is one", async () => {
    getAnthropicConnection.mockResolvedValue(VIA_KEY);
    const out = await readiness({ clawai_token: "claw_secret_token", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic" });
    expect(JSON.stringify(out)).not.toContain("claw_secret_token");
    expect(JSON.stringify(out)).not.toContain("sk-ant-");
  });

  it("puts the DEFAULT provider's own missing credential in the flat problem list", async () => {
    // Or a box whose default cannot run would show "not ready" with an empty
    // checklist and nothing for the owner to act on.
    const out = await readiness({ clawai_token: "tok", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic" });
    expect(out.problems.join(" ")).toMatch(/Anthropic account is not connected/);
    // And not the other provider's, which is connected and irrelevant here.
    expect(out.problems.join(" ")).not.toMatch(/ClawBox AI is not connected/);
  });
});
