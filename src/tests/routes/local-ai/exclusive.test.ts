import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Turning Local-only mode OFF restores the cloud primary it saved when it was
 * turned on — the third writer of `agents.defaults.model.primary`, beside
 * chat/model and ai-models/configure. That saved primary can be Anthropic's,
 * and a provider save made while Local-only was on gates the anthropic plugin
 * off; OpenClaw 2 then refuses the reference ("Unknown model") and the toggle
 * fails with the CLI's sentence in a red banner, Local-only stuck on. The
 * enable has to ride in the same batch as the restore write here just as it
 * does at the other two sites — and here it covers the fallbacks too, which
 * are validated exactly like the primary.
 *
 * The session half of this route (the gateway `sessions.patchMany` round trip
 * and its backup) is covered by local-ai-exclusive-sessions.test.ts; no agent
 * has a store here, so these cases are only about the config writes.
 */

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(async () => {}),
  setMany: vi.fn(async () => {}),
}));

vi.mock("@/lib/openclaw-session-store", () => ({
  listAgentIds: vi.fn(() => []),
  sessionStorePath: vi.fn(() => null),
  readSessionEntries: vi.fn(() => []),
}));

vi.mock("@/lib/openclaw-config", () => ({
  callGatewayRpc: vi.fn(),
  gatewayIsAbsent: vi.fn(() => false),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(async () => {}),
  runOpenclawConfigSet: vi.fn(async () => {}),
  runOpenclawConfigSetBatch: vi.fn(async () => {}),
}));

import { get, setMany } from "@/lib/config-store";
import { restartGateway, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";

const UNKNOWN_MODEL =
  'Cannot set model reference "anthropic/claude-sonnet-5" at agents.defaults.model.primary: '
  + "Unknown model: anthropic/claude-sonnet-5. Run openclaw models list to list available models.";

const ENABLE_OP = ["plugins.entries.anthropic.enabled", "true", "--json"];

/** Where in vitest's global call sequence the first call `pick` accepts sits. */
function orderOf(mock: Mock, pick: (args: unknown[]) => boolean = () => true): number {
  const index = mock.mock.calls.findIndex((args) => pick(args));
  expect(index).toBeGreaterThanOrEqual(0);
  return mock.mock.invocationCallOrder[index];
}

const namesAnthropic = (op: string[]) =>
  /^agents\.defaults\.model\.(primary|fallbacks)$/.test(op[0]) && op[1].includes("anthropic/");

/**
 * The CLI as a 2026.8.1 box answers it: the plugin was gated off while
 * Local-only was on, and a batch touching an `anthropic/*` reference — the
 * primary or a fallback — is refused unless the same batch switches the
 * plugin on ahead of it.
 */
function refuseAnthropicRefsUnlessEnabledFirst() {
  vi.mocked(runOpenclawConfigSetBatch).mockImplementation(async (ops) => {
    const enableIdx = ops.findIndex((op) => op[0] === ENABLE_OP[0] && op[1] === "true");
    const refIdx = ops.findIndex(namesAnthropic);
    if (refIdx >= 0 && !(enableIdx >= 0 && enableIdx < refIdx)) throw new Error(UNKNOWN_MODEL);
  });
}

describe("POST /setup-api/local-ai/exclusive — restoring the saved primary and fallbacks", () => {
  let POST: (request: Request) => Promise<Response>;
  let store: Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Local-only is ON and was entered from an Anthropic primary.
    store = {
      local_only_mode: true,
      local_only_saved_primary: "anthropic/claude-sonnet-5",
    };
    vi.mocked(get).mockImplementation(async (key: string) => store[key]);
    vi.mocked(restartGateway).mockResolvedValue(undefined);
    refuseAnthropicRefsUnlessEnabledFirst();

    POST = (await import("@/app/setup-api/local-ai/exclusive/route")).POST;
  });

  const turnOff = () => POST(new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  }));

  it("restores the saved Anthropic primary in ONE batch that switches its plugin on first, then restarts", async () => {
    const response = await turnOff();
    const body = await response.json();

    expect(body.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOpenclawConfigSetBatch).mock.calls[0][0]).toEqual([
      ENABLE_OP,
      ["agents.defaults.model.primary", JSON.stringify("anthropic/claude-sonnet-5"), "--json"],
    ]);
    expect(orderOf(vi.mocked(runOpenclawConfigSetBatch))).toBeLessThan(orderOf(vi.mocked(restartGateway)));
  });

  it("switches the plugin on for a FALLBACK that names Anthropic, in the same batch as both lists", async () => {
    // `agents.defaults.model.fallbacks.N` is validated exactly like the
    // primary. Local-only entered from an OpenAI primary with an Anthropic
    // fallback used to restore the primary, then have the fallbacks refused —
    // a 500 with the cloud primary already back and Local-only still on.
    store.local_only_saved_primary = "openai/gpt-5.5";
    store.local_only_saved_fallbacks = ["anthropic/claude-sonnet-5"];

    const response = await turnOff();

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOpenclawConfigSetBatch).mock.calls[0][0]).toEqual([
      ENABLE_OP,
      ["agents.defaults.model.primary", JSON.stringify("openai/gpt-5.5"), "--json"],
      ["agents.defaults.model.fallbacks", JSON.stringify(["anthropic/claude-sonnet-5"]), "--json"],
    ]);
  });

  it("leaves Local-only on, the plugin untouched and the gateway alone when the batch is refused", async () => {
    // Atomic: a refused batch changed nothing — no primary back, no flag
    // flipped — so there is nothing to restore and nothing to restart.
    vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(new Error("ConfigMutationConflictError: config changed"));

    const response = await turnOff();

    expect(response.status).toBe(500);
    expect(setMany).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });
});
