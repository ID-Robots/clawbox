/**
 * WHICH ACCOUNT PAYS for a coding run, and the isolation between them.
 *
 * `claude-ds` used to have exactly one answer: Claude Code pointed at the
 * box's own ClawBox AI plan. The second is the owner's own Anthropic access,
 * and the third the owner's own OpenAI access — which runs on the Codex CLI,
 * not on Claude Code (coding-codex.test.ts pins its argv and its stream).
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

// The OpenAI side is a secret-store row, a file in the coding agent's Codex
// home and the Codex binary in ~/.local/bin — mocked for the same reason.
const getOpenAIConnection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-openai")>()),
  getOpenAIConnection,
}));

import {
  ANTHROPIC_MODELS,
  CODING_AGENT_PROVIDER_CONFIG_KEY,
  CODING_PROVIDER_NAME_KEY,
  CODING_PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CODING_PROVIDER,
  DEFAULT_OPENAI_MODEL,
  ECONOMY_MODELS,
  OPENAI_MODELS,
  codingProviderFrom,
  defaultModelForProvider,
  isRecordableModel,
  modelsForProvider,
  resolveRunProvider,
  runsOnCodex,
} from "@/lib/coding-provider";
import { codexHome } from "@/lib/coding-openai";
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
const OPENAI_OFF = { connected: false, hasKey: false, hasLogin: false, source: null, status: "disconnected", limitedUntil: null, codexInstalled: true };
const OPENAI_VIA_CHATGPT = { connected: true, hasKey: false, hasLogin: true, source: "chatgpt" as const, status: "connected", limitedUntil: null, codexInstalled: true };

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
  getAnthropicConnection.mockReset().mockResolvedValue(DISCONNECTED);
  hasAnthropicLogin.mockReset().mockReturnValue(false);
  getOpenAIConnection.mockReset().mockResolvedValue(OPENAI_OFF);
});

describe("the vocabulary", () => {
  it("offers exactly the three accounts a run can be paid from, ClawBox AI first", () => {
    // Appended, never inserted: the order is the readiness fallback's and the
    // pickers', and a box whose stored list predates OpenAI reads the same.
    expect([...CODING_PROVIDERS]).toEqual(["clawbox-ai", "anthropic", "openai"]);
    // The whole installed base is on this one, and a default that moved would
    // put every existing box on its owner's personal bill.
    expect(DEFAULT_CODING_PROVIDER).toBe("clawbox-ai");
  });

  it("reads anything unrecognised as the default rather than refusing", () => {
    expect(codingProviderFrom(undefined)).toBe("clawbox-ai");
    expect(codingProviderFrom("mistral")).toBe("clawbox-ai");
    expect(codingProviderFrom(7)).toBe("clawbox-ai");
    expect(codingProviderFrom("anthropic")).toBe("anthropic");
    expect(codingProviderFrom("openai")).toBe("openai");
  });

  it("has a catalogue key per provider, and none of them is built by interpolation", () => {
    // `codingAgent.provider.${id}` put a HYPHEN in a translation key —
    // `clawbox-ai` — which the catalogue convention forbids
    // (translations.test.ts) and which nothing but the whole-catalogue test
    // caught, well after the UI rendered fine. The table is checked against
    // the same rule here, at the source, so the next provider cannot repeat it.
    const DOTTED_CAMEL = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9][a-zA-Z0-9]*)*$/;
    for (const id of CODING_PROVIDERS) {
      const key = CODING_PROVIDER_NAME_KEY[id];
      expect(key, `${id} has no name key`).toBeTruthy();
      expect(key, `${key} breaks the catalogue's key convention`).toMatch(DOTTED_CAMEL);
    }
    // Distinct keys: one label for both providers would name the wrong account.
    expect(new Set(Object.values(CODING_PROVIDER_NAME_KEY)).size).toBe(CODING_PROVIDERS.length);
  });

  it("names models for Anthropic and OpenAI — the ClawBox AI plan chooses its own", () => {
    expect([...modelsForProvider("anthropic")]).toEqual([...ANTHROPIC_MODELS]);
    expect([...modelsForProvider("openai")]).toEqual([...OPENAI_MODELS]);
    expect(modelsForProvider("clawbox-ai")).toEqual([]);
    expect(ANTHROPIC_MODELS).toContain(DEFAULT_ANTHROPIC_MODEL);
    expect(OPENAI_MODELS).toContain(DEFAULT_OPENAI_MODEL);
  });

  it("offers the Codex CLI's own listed models for OpenAI, its default first", () => {
    // The literal, for the reason the Anthropic one is spelled out: these reach
    // `codex exec -m` as strings. Read off `codex debug models` (the entries
    // marked `visibility: list`), highest priority first.
    expect([...OPENAI_MODELS]).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"]);
    // What `codex exec` reports as its model with nothing configured.
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6-astra");
    expect(defaultModelForProvider("openai")).toBe("gpt-6-astra");
    // The cheaper model a team's planner and reviewers run on — one the
    // provider offers, so a role's record can carry it.
    expect(ECONOMY_MODELS.openai).toBe("gpt-5.6-luna");
    expect(isRecordableModel("openai", ECONOMY_MODELS.openai)).toBe(true);
    expect(isRecordableModel("openai", "claude-opus-5-5")).toBe(false);
  });

  it("runs OpenAI, and only OpenAI, on the Codex CLI", () => {
    expect(CODING_PROVIDERS.filter(runsOnCodex)).toEqual(["openai"]);
  });

  it("offers Opus 5.5 first and defaults to it, with the plain id spelled out", () => {
    // The literal is the point. An unnamed run's model reaches Claude Code as
    // a string, so a typo here ("claude-opus-5.5", an alias) is not a type
    // error — it is a run that fails several minutes in, on the owner's bill.
    expect([...ANTHROPIC_MODELS]).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-opus-5-5");
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-5-5");
    expect(defaultModelForProvider("clawbox-ai")).toBeNull();
  });

  it("keeps claude-opus-5 selectable behind the new default", () => {
    // What the list fences is what a caller NAMES — the MCP tool's enum, the
    // run route, a follow-up that re-states the model of the run it
    // continues. A resume that names nothing carries the previous
    // requestedModel past this list entirely, so the entry below is what
    // keeps the old id askable, not what keeps an existing run alive.
    expect(ANTHROPIC_MODELS).toContain("claude-opus-5");
    expect(resolveRunProvider("anthropic", "claude-opus-5", "clawbox-ai")).toEqual({
      ok: true, provider: "anthropic", model: "claude-opus-5",
    });
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

  it("refuses a provider that is not one of the three, naming them", () => {
    const out = resolveRunProvider("mistral", undefined, "clawbox-ai");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/clawbox-ai, anthropic, openai/);
  });

  it("gives an unnamed OpenAI run the CLI's default model", () => {
    expect(resolveRunProvider("openai", undefined, "clawbox-ai")).toEqual({ ok: true, provider: "openai", model: "gpt-6-astra" });
    expect(resolveRunProvider(undefined, undefined, "openai")).toEqual({ ok: true, provider: "openai", model: "gpt-6-astra" });
  });

  it("accepts each offered OpenAI model, and refuses one provider's model on the other", () => {
    for (const model of OPENAI_MODELS) {
      expect(resolveRunProvider("openai", model, "clawbox-ai")).toEqual({ ok: true, provider: "openai", model });
    }
    const crossed = resolveRunProvider("openai", "claude-opus-5-5", "clawbox-ai");
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.error).toMatch(/gpt-6-astra/);
    expect(resolveRunProvider("anthropic", "gpt-6-astra", "clawbox-ai").ok).toBe(false);
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
    configGet.mockResolvedValue("mistral");
    expect(await getCodingProvider()).toBe("clawbox-ai");
  });

  it("stores a provider the device knows", async () => {
    expect(await setCodingProvider("anthropic")).toBe("anthropic");
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_PROVIDER_CONFIG_KEY, "anthropic");
  });

  it("refuses one it does not, and writes nothing", async () => {
    await expect(setCodingProvider("mistral")).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("stores OpenAI as the default too", async () => {
    expect(await setCodingProvider("openai")).toBe("openai");
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_PROVIDER_CONFIG_KEY, "openai");
  });

  it("can be set to a provider that is not connected yet", async () => {
    // Deliberate: the owner picks the account and THEN pastes the key. A
    // picker that refused the first half of that would be unusable. Starting
    // a run is what is gated.
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    await expect(setCodingProvider("anthropic")).resolves.toBe("anthropic");
  });
});

describe("the spawn gate judges the account the run will actually use", () => {
  /**
   * The box's OWN half of readiness — Claude Code, the wrapper, setpriv —
   * depends on the machine running these tests, so what is asserted here is
   * the SENTENCE, not whether the run started. That is the defect anyway: a
   * run that named the working account was refused with a message about an
   * account it had never asked for, because the gate read `readiness.problems`
   * and those are the DEFAULT provider's.
   */
  async function refusalFor(input: { provider?: string }): Promise<string> {
    configGet.mockImplementation(async (key: string) => {
      if (key === "coding_agent_enabled") return true;
      if (key === "clawai_token") return "claw_token";
      if (key === CODING_AGENT_PROVIDER_CONFIG_KEY) return "anthropic";
      return undefined;
    });
    configGetAll.mockResolvedValue({
      coding_agent_enabled: true,
      clawai_token: "claw_token",
      [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic",
    });
    const lib = await import("@/lib/coding-agent");
    try {
      await lib.startRun({ task: "Do the thing", directory: "/nonexistent-for-this-test", source: "owner", ...input });
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it("refuses at all, so the assertions below are about a real message", async () => {
    // These cases assert what a refusal does NOT say, which would pass
    // vacuously if nothing were refused. On a machine with no Claude Code the
    // box's own half refuses; on one with it, the working folder does. Either
    // way there IS a sentence.
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    expect(await refusalFor({ provider: "clawbox-ai" })).not.toBe("");
  });

  it("never refuses a clawbox-ai run with the Anthropic account's sentence", async () => {
    // The owner's default is `anthropic` and unconnected — which
    // setCodingProvider deliberately allows, so they can pick the account
    // before pasting the key. A run that explicitly named `clawbox-ai` must
    // not be told about Anthropic at all.
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    const message = await refusalFor({ provider: "clawbox-ai" });
    expect(message).not.toMatch(/Anthropic account is not connected/);
  });

  it("still names Anthropic when the run is the one that wanted it", async () => {
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    const message = await refusalFor({ provider: "anthropic" });
    expect(message).toMatch(/Anthropic account is not connected/);
  });

  it("names neither once both accounts are connected", async () => {
    getAnthropicConnection.mockResolvedValue(VIA_KEY);
    const message = await refusalFor({ provider: "anthropic" });
    expect(message).not.toMatch(/is not connected/);
  });

  it("names OpenAI when the run wanted it, and never Anthropic", async () => {
    getAnthropicConnection.mockResolvedValue(DISCONNECTED);
    getOpenAIConnection.mockResolvedValue(OPENAI_OFF);
    const message = await refusalFor({ provider: "openai" });
    expect(message).toMatch(/OpenAI account is not connected/);
    expect(message).not.toMatch(/Anthropic account is not connected/);
  });

  it("names the missing Codex CLI before the account, for an OpenAI run", async () => {
    getOpenAIConnection.mockResolvedValue({ ...OPENAI_VIA_CHATGPT, codexInstalled: false });
    const message = await refusalFor({ provider: "openai" });
    expect(message).toMatch(/Codex CLI/);
    expect(message).not.toMatch(/OpenAI account is not connected/);
  });

  it("holds an OpenAI run while OpenAI's usage limit is still ahead", async () => {
    // finishRun remembers the limit; the gate turns it into the same queued
    // wait an Anthropic pool at its limit gets, rather than a doomed spawn.
    getOpenAIConnection.mockResolvedValue(OPENAI_VIA_CHATGPT);
    const until = Date.now() + 30 * 60_000;
    configGet.mockImplementation(async (key: string) => {
      if (key === "coding_agent_enabled") return true;
      if (key === "coding_agent_openai_limited_until") return until;
      return undefined;
    });
    configGetAll.mockResolvedValue({ coding_agent_enabled: true, [CODING_AGENT_PROVIDER_CONFIG_KEY]: "openai" });
    const lib = await import("@/lib/coding-agent");
    const err = await lib.startRun({ task: "Do the thing", directory: "/nonexistent-for-this-test", source: "owner", provider: "openai" }).then(() => null, (e: unknown) => e);
    // On a machine without Claude Code or setpriv the box's own half refuses
    // first; only where it does not is the limit the answer.
    if (err instanceof CodingAgentError && err.kind === "limited") {
      expect(err.message).toMatch(/OpenAI is at its usage limit/);
      expect(err.message).toContain(new Date(until).toISOString());
    } else {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("what a reset does and does not take away", () => {
  it("puts the account back to the box's own plan", async () => {
    // Left behind, an `anthropic` default made the wizard a reset reopened
    // report the agent as not ready — with an Anthropic sentence, over a
    // perfectly connected ClawBox AI plan.
    const lib = await import("@/lib/coding-agent");
    expect([...lib.CODING_AGENT_RESET_KEYS]).toContain(CODING_AGENT_PROVIDER_CONFIG_KEY);
  });

  it("keeps the saved Anthropic key", async () => {
    // A reset of the coding agent's SETTINGS is not a reason to throw away a
    // credential the owner pasted.
    const lib = await import("@/lib/coding-agent");
    const { ANTHROPIC_API_KEY_CONFIG_KEY } = await import("@/lib/coding-provider");
    expect([...lib.CODING_AGENT_RESET_KEYS]).not.toContain(ANTHROPIC_API_KEY_CONFIG_KEY);
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

  it("gives an OpenAI run the coding agent's own Codex home and none of the wrapper's knobs", () => {
    const saved = Object.fromEntries(["CLAUDE_DS_MODEL", "CLAUDE_DS_CONFIG_DIR", "CLAWBOX_AI_PROXY_URL"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, { CLAUDE_DS_MODEL: "deepseek-v4-pro[1m]", CLAUDE_DS_CONFIG_DIR: "/srv/elsewhere", CLAWBOX_AI_PROXY_URL: "https://proxy.example.invalid" });
    try {
      const env = buildRunEnv({ effort: "max", provider: "openai", model: "gpt-5.6-sol" });
      // Never ~/.codex: that is the gateway's ChatGPT sign-in.
      expect(env.CODEX_HOME).toBe(codexHome());
      expect(env.CODEX_HOME).not.toMatch(/\/\.codex$/);
      expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE_"))).toEqual([]);
      expect(env.CLAWBOX_AI_PROXY_URL).toBeUndefined();
      // The run's own folders are still named, as for every run.
      expect(env.CLAWBOX_PREVIEW).toBeTruthy();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("never lets an owner secret name the variable Codex authenticates with, or its home", () => {
    const env = buildRunEnv({ provider: "openai", model: "gpt-6-astra", secrets: { CODEX_API_KEY: "sk-proj-owner-secret-0000", CODEX_HOME: "/tmp/other-home", DEPLOY_TOKEN: "kept" } });
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe(codexHome());
    // Every other secret the owner ticked still reaches the run, as on Claude.
    expect(env.DEPLOY_TOKEN).toBe("kept");
  });

  it("gives each run of a mixed team its own provider's wiring, and nothing of the other's", () => {
    // A team whose planner the owner put on Anthropic and whose workers stay
    // on ClawBox AI: two runs side by side, built one after the other from
    // their own records, in a web server whose own environment carries both
    // sides' variables.
    const saved = Object.fromEntries(["CLAUDE_DS_PROVIDER", "CLAUDE_DS_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      CLAUDE_DS_PROVIDER: "anthropic",
      CLAUDE_DS_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_API_KEY: "server-env-anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "server-env-proxy-token",
      ANTHROPIC_BASE_URL: "https://proxy.example.invalid",
    });
    try {
      const planner = buildRunEnv({ effort: "xhigh", provider: "anthropic", model: "claude-fable-5-1" });
      const worker = buildRunEnv({ effort: "ultracode", provider: "clawbox-ai", model: null });
      const economyWorker = buildRunEnv({ effort: "ultracode", provider: "clawbox-ai", model: "deepseek-v4-flash" });
      expect(planner).toMatchObject({ CLAUDE_DS_PROVIDER: "anthropic", CLAUDE_DS_MODEL: "claude-fable-5-1", CLAUDE_DS_EFFORT: "xhigh" });
      expect(worker).toMatchObject({ CLAUDE_DS_PROVIDER: "clawbox-ai", CLAUDE_DS_MODEL: "deepseek-v4-pro[1m]", CLAUDE_DS_EFFORT: "ultracode" });
      expect(economyWorker).toMatchObject({ CLAUDE_DS_PROVIDER: "clawbox-ai", CLAUDE_DS_MODEL: "deepseek-v4-flash" });
      for (const env of [planner, worker, economyWorker]) {
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(Object.values(env).some((v) => v.startsWith("server-env-"))).toBe(false);
      }
      // Built in the other order, each is the same: no run's environment
      // depends on which run of the team was built before it.
      expect(buildRunEnv({ effort: "ultracode", provider: "clawbox-ai", model: null })).toEqual(worker);
      expect(buildRunEnv({ effort: "xhigh", provider: "anthropic", model: "claude-fable-5-1" })).toEqual(planner);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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
    // Codex takes no --agents; the table's entry is the economy model.
    expect(HELPER_MODEL.openai).toBe("gpt-5.6-luna");
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

  it("answers two different questions with two fields, not one", async () => {
    // `ready` is what a PANEL shows the owner: "a run started with nothing
    // named would work", so it follows the DEFAULT provider. `anyProviderReady`
    // is "can this box run at all", so it follows the OR — and that is the one
    // the MCP probe reads, because a box whose default is an account nobody
    // connected still runs perfectly on the other, and gating tool
    // registration on `ready` took the tools away from a caller that would
    // have named it.
    //
    // Asserted as a DERIVATION rather than as two booleans: whether the box's
    // own half (Claude Code, the wrapper, setpriv) is in place depends on the
    // machine running this, and a test that assumed it would pass here and
    // fail on a runner with no `claude` installed.
    const out = await readiness({ clawai_token: "tok", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic" });
    const byId = Object.fromEntries(out.providers.map((p) => [p.id, p]));
    expect(out.ready).toBe(byId.anthropic.ready);
    expect(out.anyProviderReady).toBe(out.providers.some((p) => p.ready));
    // The credential half is the part this test controls, and the two
    // providers genuinely disagree about it here.
    expect(byId.anthropic.problems.length).toBeGreaterThan(0);
    expect(byId["clawbox-ai"].problems).toEqual([]);
    // So `ready` can never be the more generous of the two.
    expect(out.ready && !out.anyProviderReady).toBe(false);
  });

  it("puts the DEFAULT provider's own missing credential in the flat problem list", async () => {
    // Or a box whose default cannot run would show "not ready" with an empty
    // checklist and nothing for the owner to act on.
    const out = await readiness({ clawai_token: "tok", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic" });
    expect(out.problems.join(" ")).toMatch(/Anthropic account is not connected/);
    // And not the other provider's, which is connected and irrelevant here.
    expect(out.problems.join(" ")).not.toMatch(/ClawBox AI is not connected/);
  });

  it("judges OpenAI on its own credential and its own CLI", async () => {
    getOpenAIConnection.mockResolvedValue(OPENAI_VIA_CHATGPT);
    const on = await readiness({ clawai_token: "tok" });
    const openai = on.providers.find((p) => p.id === "openai")!;
    expect(openai.problems).toEqual([]);
    expect(openai.models).toEqual([...OPENAI_MODELS]);
    expect(openai.defaultModel).toBe("gpt-6-astra");
    expect(on.openaiConnected).toBe(true);
    expect(on.openaiSource).toBe("chatgpt");
    expect(on.codexInstalled).toBe(true);

    getOpenAIConnection.mockResolvedValue(OPENAI_OFF);
    const off = await readiness({ clawai_token: "tok" });
    expect(off.providers.find((p) => p.id === "openai")!.problems.join(" ")).toMatch(/OpenAI account is not connected/);
    // Not judged on the ClawBox AI token, which is here and irrelevant to it.
    expect(off.providers.find((p) => p.id === "openai")!.problems.join(" ")).not.toMatch(/ClawBox AI/);

    getOpenAIConnection.mockResolvedValue({ ...OPENAI_VIA_CHATGPT, codexInstalled: false });
    const noCli = await readiness({ clawai_token: "tok" });
    expect(noCli.providers.find((p) => p.id === "openai")!.problems.join(" ")).toMatch(/install\.sh --step codex_cli/);
    expect(noCli.codexInstalled).toBe(false);
  });

  it("never holds an OpenAI run back for Claude Code's own missing pieces", async () => {
    // Whether Claude Code is on this machine is the machine's business; what
    // is pinned is that NO Claude Code sentence is ever an OpenAI problem, and
    // that a ready OpenAI default is ready whatever Claude Code's state.
    getOpenAIConnection.mockResolvedValue(OPENAI_VIA_CHATGPT);
    const out = await readiness({ clawai_token: "tok", [CODING_AGENT_PROVIDER_CONFIG_KEY]: "openai" });
    const openai = out.providers.find((p) => p.id === "openai")!;
    expect(openai.problems.join(" ")).not.toMatch(/Claude Code|claude-ds/);
    if (out.capabilityDropAvailable && out.harnessHealthy) expect(openai.ready).toBe(true);
    expect(out.ready).toBe(openai.ready);
  });
});
