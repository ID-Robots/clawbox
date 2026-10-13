import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConfigGateway, runFakeOpenclawCli } from "@/tests/helpers/fake-config-gateway";

/**
 * `openclaw config set` / `--batch-json` / `config unset` through the running
 * gateway (TASK-1535): one exact `config.patch`, or the CLI exactly as before.
 *
 * EXACT is the claim under test. The CLI REPLACES the value at a path; the
 * gateway MERGES (RFC 7396, `null` deletes, id-keyed arrays merged BY ID unless
 * named in `replacePaths`), so the patch ClawBox sends is computed from the
 * file. The gateway here is `FakeConfigGateway` — the core's own merge, array
 * guard and conflict check, ported from 2026.10.2 over a real openclaw.json in
 * a temp home — so every case below asserts what lands in the FILE, not just
 * what was asked for. The CLI is `runFakeOpenclawCli` behind a spawn mock, and
 * a case that ends on the CLI says so by the argv it recorded.
 *
 * `openclaw-gateway-ws.test.ts` pins the wire (one `config.patch` with the
 * caller's base hash and `replacePaths`); that the running gateway accepts it
 * is the box's to show.
 */

const state = vi.hoisted(() => ({
  gateway: null as import("@/tests/helpers/fake-config-gateway").FakeConfigGateway | null,
  unavailable: false,
  cliRefuse: null as ((argv: readonly string[]) => string | null) | null,
  spawned: [] as string[][],
  file: "",
}));

vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return {
    ...actual,
    gatewayWsCall: async (method: string, params: Record<string, unknown>) => {
      if (state.unavailable || !state.gateway) throw new actual.GatewayWsUnavailableError("connect ECONNREFUSED");
      return state.gateway.call(method, params);
    },
    gatewayWsPatchConfig: async (patch: Record<string, unknown>, options: { baseHash: string; replacePaths?: string[] }) => {
      if (state.unavailable || !state.gateway) throw new actual.GatewayWsUnavailableError("connect ECONNREFUSED");
      return state.gateway.patch(patch, options);
    },
  };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: (_bin: string, argv: string[]) => {
    state.spawned.push(argv);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = stderr;
    child.stdin = { end: () => {}, write: () => {}, on: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      const out = runFakeOpenclawCli(state.file, argv, state.cliRefuse ?? undefined);
      if (out.stderr) stderr.emit("data", Buffer.from(out.stderr));
      child.emit("close", out.code);
    }, 1);
    return child;
  },
}));

let lib: typeof import("@/lib/openclaw-config");
let home: string;

function writeFile(config: unknown): void {
  fs.writeFileSync(state.file, JSON.stringify(config, null, 2));
}

function readFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(state.file, "utf-8")) as Record<string, unknown>;
}

/** The argvs the CLI was spawned with, minus anything that is not `config …`. */
function cliCalls(): string[][] {
  return state.spawned.filter((argv) => argv[0] === "config");
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gateway-write-"));
  state.file = path.join(home, "openclaw.json");
  state.gateway = new FakeConfigGateway(state.file);
  state.unavailable = false;
  state.cliRefuse = null;
  state.spawned = [];
  vi.stubEnv("CLAWBOX_OPENCLAW_HOME", home);
  vi.resetModules();
  lib = await import("@/lib/openclaw-config");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a write through the gateway", () => {
  it("turns a batch into one nested merge, bracket segments kept as single keys", async () => {
    writeFile({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } } });
    await lib.runOpenclawConfigSetBatch([
      ["plugins.entries.anthropic.enabled", "true", "--json"],
      ["agents.defaults.model.primary", "anthropic/claude-opus-5"],
      ['agents.defaults.models["openai/gpt-5.5"].agentRuntime.id', "chatgpt-app-server"],
    ]);
    expect(state.gateway!.patches).toHaveLength(1);
    expect(state.gateway!.patches[0].raw).toEqual({
      plugins: { entries: { anthropic: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "chatgpt-app-server" } } },
        },
      },
    });
    expect(readFile()).toMatchObject({
      plugins: { entries: { anthropic: { enabled: true } } },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
    });
    expect(cliCalls()).toEqual([]);
  });

  it("REPLACES an object value the way `config set` does: a key the caller left out is deleted, not merged past", async () => {
    writeFile({ tts: { providers: { "tts-local-cli": { command: "clawbox-tts.sh", voice: "af_bella", stale: true } } } });
    await lib.runOpenclawConfigSet(
      ["tts.providers.tts-local-cli", JSON.stringify({ command: "clawbox-tts.sh", voice: "af_heart" }), "--json"],
    );
    expect(state.gateway!.patches[0].raw).toEqual({ tts: { providers: { "tts-local-cli": { voice: "af_heart", stale: null } } } });
    expect(readFile()).toEqual({ tts: { providers: { "tts-local-cli": { command: "clawbox-tts.sh", voice: "af_heart" } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("replaces an array that shrinks, naming it in replacePaths — the Local-only switch's `fallbacks: []`", async () => {
    writeFile({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"] } } } });
    await lib.runOpenclawConfigSetBatch([
      ["agents.defaults.model.primary", JSON.stringify("llamacpp/gemma4-e2b-it-q4_0"), "--json"],
      ["agents.defaults.model.fallbacks", "[]", "--json"],
    ]);
    expect(state.gateway!.patches[0].replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
    expect(readFile()).toEqual({ agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0", fallbacks: [] } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("replaces an id-keyed list rather than merging it by id, nested `[]` arrays included", async () => {
    // The provider definition ClawBox AI re-writes on every save: the gateway
    // would MERGE `models` by id (keeping the retired row and its old `input`)
    // unless every array the patch sends is named.
    writeFile({
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://example.invalid/api/ai",
            apiKey: "claw_old",
            models: [
              { id: "deepseek-v4-flash", input: ["text", "image"] },
              { id: "deepseek-v3-retired", input: ["text"] },
            ],
          },
        },
      },
    });
    const next = {
      baseUrl: "https://example.invalid/api/ai",
      apiKey: "claw_new",
      models: [{ id: "deepseek-v4-flash", input: ["text"] }],
    };
    await lib.runOpenclawConfigSetBatch([
      ["models.providers.deepseek", JSON.stringify(next), "--json"],
      ["models.mode", "merge"],
    ]);
    // The provider entry keeps its keys, so the CLI's guard (which looks at the
    // assigned path's own entries) has nothing to say; the row list inside it
    // is replaced whole, as `config set` replaces the entry.
    expect(readFile()).toEqual({ models: { providers: { deepseek: next }, mode: "merge" } });
    expect(state.gateway!.patches[0].replacePaths).toEqual(
      expect.arrayContaining(["models.providers.deepseek.models", "models.providers.deepseek.models[].input"]),
    );
    expect(cliCalls()).toEqual([]);
  });

  it("takes a removal: `config unset` is a `null`, and the arrays inside the removed entry are named", async () => {
    writeFile({ models: { providers: { openai: { apiKey: "claw_x", models: [{ id: "gpt-image-2" }] }, deepseek: { apiKey: "k" } } } });
    await lib.runOpenclawConfigUnset("models.providers.openai");
    expect(state.gateway!.patches[0]).toEqual({
      raw: { models: { providers: { openai: null } } },
      replacePaths: ["models.providers.openai.models"],
    });
    expect(readFile()).toEqual({ models: { providers: { deepseek: { apiKey: "k" } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("names an array only the RUNTIME config has when the gateway's refusal asks for it — once, and only inside the patch", async () => {
    // The core checks its array guard against the config it runs, defaults
    // included: removing the entry removes a `models: []` the file never had.
    writeFile({ models: { providers: { openai: { apiKey: "claw_x" }, deepseek: { apiKey: "k" } } } });
    state.gateway!.runtimeDefaults = { models: { providers: { openai: { models: [] } } } };
    await lib.runOpenclawConfigUnset("models.providers.openai");
    expect(state.gateway!.patches.map((p) => p.replacePaths)).toEqual([[], ["models.providers.openai.models"]]);
    expect(readFile()).toEqual({ models: { providers: { deepseek: { apiKey: "k" } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("does not name an array the patch never touched, whatever the refusal says", async () => {
    writeFile({ agents: { defaults: { model: { primary: "a/b" } } } });
    const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    state.gateway!.refuseNext(new GatewayRpcError(
      "config.patch would remove entries from array path(s): channels.telegram.allowFrom. Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.",
      "INVALID_REQUEST",
    ));
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(state.gateway!.patches).toHaveLength(1);
    expect(cliCalls()).toHaveLength(1);
  });

  it("takes the uid and gid of THIS process, which is the spawn the configure route always made", async () => {
    writeFile({ models: {} });
    await lib.runOpenclawConfigSet(["models.mode", "merge"], { uid: process.getuid?.(), gid: process.getgid?.() });
    expect(readFile()).toEqual({ models: { mode: "merge" } });
    expect(cliCalls()).toEqual([]);
  });

  it("writes nothing at all when the file already says it — the CLI's own `No change`", async () => {
    writeFile({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: [] } } } });
    const before = fs.readFileSync(state.file, "utf-8");
    await lib.runOpenclawConfigSetBatch([
      ["agents.defaults.model.primary", "deepseek/deepseek-v4-flash"],
      ["agents.defaults.model.fallbacks", "[]", "--json"],
    ]);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()).toEqual([]);
    expect(fs.readFileSync(state.file, "utf-8")).toBe(before);
  });

  it("re-reads and re-tries on the config-mutation conflict instead of paying a CLI start", async () => {
    writeFile({ agents: { defaults: { model: { primary: "a/b" } } } });
    const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    state.gateway!.refuseNext(new GatewayRpcError("config changed since last load; re-run config.get and retry", "INVALID_REQUEST"));
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(state.gateway!.patches).toHaveLength(2);
    expect(readFile()).toEqual({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("counts a write the gateway timed out on as made when the file holds it", async () => {
    writeFile({ agents: { defaults: { model: { primary: "a/b" } } } });
    const gateway = state.gateway!;
    const realPatch = gateway.patch.bind(gateway);
    gateway.patch = async (patch, options) => {
      await realPatch(patch, options);
      throw new Error("config.patch timed out after 20000ms");
    };
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(readFile()).toEqual({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } });
    expect(cliCalls()).toEqual([]);
  });
});

/**
 * What the gateway path will not CLAIM. Each of these ends on the CLI, exactly
 * as every write did before the gateway was asked, and the file is the CLI's.
 */
describe("what is left for the CLI", () => {
  it("a replacement `config set` itself would refuse: a protected map losing a key without --replace", async () => {
    writeFile({ models: { providers: { openai: { apiKey: "k", baseUrl: "u", headers: { a: "b" } } } } });
    state.cliRefuse = (argv) => (argv[1] === "set" ? "Refusing to replace models.providers.openai; it would remove existing entries: headers." : null);
    await expect(
      lib.runOpenclawConfigSet(["models.providers.openai", JSON.stringify({ apiKey: "k2", baseUrl: "u" }), "--json"]),
    ).rejects.toThrow(/Refusing to replace/);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()).toHaveLength(1);
    expect(readFile()).toEqual({ models: { providers: { openai: { apiKey: "k", baseUrl: "u", headers: { a: "b" } } } } });
  });

  it("a provider model list losing an id without --replace — and the same list WITH it goes through the gateway", async () => {
    writeFile({ models: { providers: { openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-image-2" }] } } } });
    state.cliRefuse = () => "Refusing to replace models.providers.openai.models; it would remove existing entries: gpt-image-2.";
    await expect(
      lib.runOpenclawConfigSet(["models.providers.openai.models", JSON.stringify([{ id: "gpt-5.5" }]), "--json"]),
    ).rejects.toThrow(/Refusing to replace/);
    expect(state.gateway!.patches).toEqual([]);

    state.cliRefuse = null;
    state.spawned = [];
    await lib.runOpenclawConfigSet(["models.providers.openai.models", JSON.stringify([{ id: "gpt-5.5" }]), "--json", "--replace"]);
    expect(readFile()).toEqual({ models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } } });
    expect(cliCalls()).toEqual([]);
  });

  it("`--replace` inside a batch, where the CLI never saw it either", async () => {
    writeFile({ models: { providers: { openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-image-2" }] } } } });
    await lib.runOpenclawConfigSetBatch([
      ["models.providers.openai.models", JSON.stringify([{ id: "gpt-5.5" }]), "--json", "--replace"],
      ["models.mode", "merge"],
    ]);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()[0].slice(0, 3)).toEqual(["config", "set", "--batch-json"]);
  });

  it("a flag it does not apply exactly (--merge)", async () => {
    writeFile({});
    await lib.runOpenclawConfigSet(["agents.defaults.models", JSON.stringify({ "a/b": {} }), "--strict-json", "--merge"]);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()[0]).toContain("--merge");
  });

  it("an explicit null value, which a merge patch can only read as a deletion", async () => {
    writeFile({ tools: { media: { audio: { baseUrl: "u" } } } });
    await lib.runOpenclawConfigSet(["tools.media.audio.baseUrl", "null", "--json"]);
    expect(state.gateway!.patches).toEqual([]);
    expect(readFile()).toEqual({ tools: { media: { audio: { baseUrl: null } } } });
  });

  it("a parent the CLI reshapes: the model shorthand string under fallbacks", async () => {
    writeFile({ agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } });
    await lib.runOpenclawConfigSet(["agents.defaults.model.fallbacks", "[]", "--json"]);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()).toHaveLength(1);
  });

  it("the removal of a path that is not there — the CLI's own exit 1", async () => {
    writeFile({ models: {} });
    await expect(lib.runOpenclawConfigUnset("models.providers.openai")).rejects.toThrow(/Config path not found/);
    expect(state.gateway!.patches).toEqual([]);
  });

  it("a uid that is not this process's, a cwd or an env", async () => {
    writeFile({});
    await lib.runOpenclawConfigSet(["models.mode", "merge"], { uid: (process.getuid?.() ?? 0) + 1 });
    await lib.runOpenclawConfigSet(["models.mode", "merge"], { env: { HOME: "/elsewhere" } });
    expect(state.gateway!.calls).toEqual([]);
    expect(cliCalls()).toHaveLength(2);
  });

  it("a gateway that is not there", async () => {
    writeFile({});
    state.unavailable = true;
    await lib.runOpenclawConfigSet(["models.mode", "merge"]);
    expect(cliCalls()).toEqual([["config", "set", "models.mode", "merge"]]);
    expect(readFile()).toEqual({ models: { mode: "merge" } });
  });

  it("a refusal — re-asked of the CLI, whose sentence is what callers parse", async () => {
    writeFile({ agents: { defaults: { model: { primary: "a/b" } } } });
    const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    state.gateway!.refuseNext(new GatewayRpcError("invalid config: agents.defaults.model.primary", "INVALID_REQUEST"));
    state.cliRefuse = () => 'Cannot set model reference "nope/nope" at agents.defaults.model.primary: unknown model.';
    await expect(lib.runOpenclawConfigSet(["agents.defaults.model.primary", "nope/nope"])).rejects.toThrow(/Cannot set model reference/);
    expect(readFile()).toEqual({ agents: { defaults: { model: { primary: "a/b" } } } });
  });

  it("a conflict that outlasts the retries", async () => {
    writeFile({ agents: {} });
    const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
    for (let i = 0; i < 3; i++) {
      state.gateway!.refuseNext(new GatewayRpcError("config changed since last load; re-run config.get and retry", "INVALID_REQUEST"));
    }
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(state.gateway!.patches).toHaveLength(3);
    expect(cliCalls()).toHaveLength(1);
  });

  it("an answer the file does not bear out", async () => {
    writeFile({ agents: {} });
    state.gateway!.lie = true;
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(cliCalls()).toHaveLength(1);
    expect(readFile()).toEqual({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } });
  });

  it("a box with no config file yet: the first config is the CLI's to create", async () => {
    await lib.runOpenclawConfigSet(["models.mode", "merge"]);
    expect(state.gateway!.patches).toEqual([]);
    expect(cliCalls()).toHaveLength(1);
  });
});
