import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `openclaw config set` through the running gateway: the same assignments as
 * one `config.patch`, built from the CLI's own path grammar (dots, and a
 * bracket-quoted segment as ONE key), falling back to the CLI when the
 * gateway is not there or refuses.
 *
 * `gatewayWsPatchConfig` is mocked, so the first block below proves the object
 * this module BUILDS. The second proves what it will and will not CLAIM from
 * the answer — the flags it cannot honour, `noop`, a `changedPaths` that does
 * not cover the write, and the conflict it re-tries — which is the half that
 * decides whether a caller is told a setting was saved. What the real gateway
 * does with that patch is the core's own suite; `openclaw-gateway-ws.test.ts`
 * pins the handshake this client sends (protocol 4, `client.id`/`mode` "cli",
 * the three operator scopes) against a fake socket, and that the running
 * gateway ACCEPTS them is the box measurement recorded above `CLIENT` — a
 * claim no unit test on this side can make.
 */

const patchMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsPatchConfig: patchMock,
  gatewayWsCall: callMock,
}));
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: spawnMock }));

/** A `spawn` that exits 0 straight away, so the CLI fallback completes. */
function spawnSucceeds() {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end: vi.fn(), write: vi.fn() };
    child.kill = vi.fn();
    setTimeout(() => child.emit("close", 0), 5);
    return child;
  });
}

let lib: typeof import("@/lib/openclaw-config");

beforeEach(async () => {
  vi.resetModules();
  patchMock.mockReset();
  callMock.mockReset();
  spawnMock.mockReset();
  lib = await import("@/lib/openclaw-config");
});
afterEach(() => vi.restoreAllMocks());

describe("runOpenclawConfigSetBatch via the gateway", () => {
  it("turns the batch into one nested merge, bracket segments kept as single keys", async () => {
    patchMock.mockResolvedValue({
      noop: false,
      changedPaths: [
        "plugins.entries.anthropic.enabled",
        "agents.defaults.model.primary",
        "agents.defaults.models.openai/gpt-5.5.agentRuntime.id",
      ],
    });
    await lib.runOpenclawConfigSetBatch([
      ["plugins.entries.anthropic.enabled", "true", "--json"],
      ["agents.defaults.model.primary", "anthropic/claude-opus-5"],
      ['agents.defaults.models["openai/gpt-5.5"].agentRuntime.id', "chatgpt-app-server"],
    ]);
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0][0]).toEqual({
      plugins: { entries: { anthropic: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "chatgpt-app-server" } } },
        },
      },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("asks the CLI instead when the gateway is not there — the path every caller had", async () => {
    const { GatewayWsUnavailableError } = await import("@/lib/openclaw-gateway-ws");
    patchMock.mockRejectedValue(new GatewayWsUnavailableError("refused"));
    spawnSucceeds();
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]).catch(() => {});
    expect(spawnMock).toHaveBeenCalled();
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.slice(0, 2)).toEqual(["config", "set"]);
  });
});

/**
 * What the gateway path refuses to CLAIM. The suite used to mock
 * `gatewayWsPatchConfig` wholesale, so every assertion was about the object
 * `configSetViaGateway` builds and nothing exercised the write's SEMANTICS.
 */
describe("what the gateway path refuses to claim", () => {
  it("leaves an argv carrying --replace on the CLI, where replace-vs-merge is honoured", async () => {
    patchMock.mockResolvedValue({ noop: false, changedPaths: ["models.providers.openai.models"] });
    spawnSucceeds();
    await lib.runOpenclawConfigSet(
      ["models.providers.openai.models", JSON.stringify([{ id: "gpt-5.5" }]), "--json", "--replace"],
    );
    expect(patchMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0][1]).toContain("--replace");
  });

  it("still takes the gateway for the two value-mode flags it does understand", async () => {
    patchMock.mockResolvedValue({ noop: false, changedPaths: ["agents.defaults.model.primary"] });
    await lib.runOpenclawConfigSet(
      ["agents.defaults.model.primary", JSON.stringify("anthropic/claude-opus-5"), "--strict-json"],
    );
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("asks the CLI when the gateway answers noop — a dropped merge answers it too", async () => {
    patchMock.mockResolvedValue({ noop: true, changedPaths: [] });
    spawnSucceeds();
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalled();
  });

  it("asks the CLI when the answer never names the path that was asked for", async () => {
    patchMock.mockResolvedValue({ noop: false, changedPaths: ["meta.lastTouchedAt"] });
    spawnSucceeds();
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(spawnMock).toHaveBeenCalled();
  });

  it("keeps an object value on the CLI — the CLI REPLACES it, the gateway would MERGE it", async () => {
    // `config.patch` is an RFC-7396 merge: a key the caller left out of the
    // object survives it (a stale `apiKey` under a provider entry, say),
    // which is a different config from the one asked for. The CLI's
    // `config set <path> <json>` replaces the value, so containers keep it.
    spawnSucceeds();
    await lib.runOpenclawConfigSet(
      ["tts.providers.tts-local-cli", JSON.stringify({ command: "clawbox-tts.sh", voice: "af_heart" }), "--json"],
    );
    expect(patchMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
  });

  it("keeps an array value on the CLI for the same reason", async () => {
    spawnSucceeds();
    await lib.runOpenclawConfigSet(
      ["agents.defaults.model.fallbacks", JSON.stringify(["llamacpp/gemma4-e2b-it-q4_0"]), "--json"],
    );
    expect(patchMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
  });

  it("retries the gateway on the config-mutation conflict instead of paying a CLI start", async () => {
    patchMock
      .mockRejectedValueOnce(new Error("config changed since last load; re-run config.get and retry"))
      .mockResolvedValueOnce({ noop: false, changedPaths: ["agents.defaults.model.primary"] });
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(patchMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("gives up to the CLI once the conflict outlasts the ladder", async () => {
    patchMock.mockRejectedValue(new Error("config changed since last load; re-run config.get and retry"));
    spawnSucceeds();
    await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"]);
    expect(patchMock).toHaveBeenCalledTimes(3);
    expect(spawnMock).toHaveBeenCalled();
  });
});
