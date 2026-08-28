import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fourth boot-time snapshot, and the rule for when refreshing it is worth
 * paying for.
 *
 * `mcp/lib/context.ts` computes `ctx.providers` as "every row Hermes does NOT
 * report as credential-less, plus the provider the device is actually on". This
 * module has to compute the same set from the same payload, because the moment
 * the two disagree the guard either fires when nothing moved (a prompt-cache
 * invalidation the owner did not earn) or stays quiet when it did (the bug).
 */

const rpcMock = vi.hoisted(() => vi.fn());
const optionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: optionsMock,
}));

import {
  readUsableProviderIds,
  refreshProviderToolsIfSetChanged,
} from "@/lib/provider-mcp-refresh";

interface Row {
  id: string;
  authenticated: boolean | null;
}

function payload(rows: Row[], current = "openrouter") {
  return {
    providers: rows.map((row) => ({
      ...row,
      name: row.id,
      verified: null,
      isUserDefined: false,
      source: "dashboard",
      total: 1,
      models: [],
    })),
    current: { provider: current, model: "m" },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard" as const,
    stale: false,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ status: "ok" });
  optionsMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("readUsableProviderIds", () => {
  it("reads the same set the MCP server registered its enum from", async () => {
    optionsMock.mockResolvedValue(
      payload(
        [
          { id: "openrouter", authenticated: true },
          // `null` means the SOURCE could not tell (the on-disk catalogue and
          // the cold-start floor carry no auth state). The MCP server keeps
          // those, so this must too.
          { id: "nous", authenticated: null },
          { id: "kimi-coding", authenticated: false },
        ],
        "openrouter",
      ),
    );
    expect(await readUsableProviderIds()).toEqual(["openrouter", "nous"]);
  });

  it("keeps the provider the device is actually on, credentialed or not", async () => {
    // The Hermes CLI has meta-providers ("auto") the credentialed catalogue
    // never lists. `mcp/lib/context.ts` seeds the current one for exactly that
    // reason — without it `ai_set_provider` was a one-way door — so leaving it
    // out here would make every switch onto one look like a set change.
    optionsMock.mockResolvedValue(
      payload([{ id: "openrouter", authenticated: true }], "auto"),
    );
    expect(await readUsableProviderIds()).toEqual(["openrouter", "auto"]);
  });

  it("answers null rather than a wrong set when the catalogue cannot be read", async () => {
    // Null is "I could not tell", and the guard below refuses to act on it. An
    // empty array here would read as "this box has no providers" and ask for a
    // reload on the next successful read of a box nothing had happened to.
    optionsMock.mockRejectedValue(new Error("dashboard down"));
    expect(await readUsableProviderIds()).toBeNull();
  });
});

describe("refreshProviderToolsIfSetChanged", () => {
  it("does nothing when the set is the same, whatever the order", async () => {
    expect(
      await refreshProviderToolsIfSetChanged(["a", "b"], ["b", "a"]),
    ).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reloads when a provider becomes offerable, and names it", async () => {
    expect(await refreshProviderToolsIfSetChanged(["openrouter"], ["openrouter", "anthropic"])).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
    // The line has to be actionable. "the agent cannot switch to anthropic" is
    // something an operator can go and check; "2 providers rather than 1" is not.
    expect(String(logSpy.mock.calls[0][0])).toContain("gained anthropic");
  });

  it("reloads when a provider stops being offerable, and names that too", async () => {
    // A stale enum that still offers a provider the device no longer has is the
    // same bug pointing the other way: `ai_set_provider` accepts it and
    // `/setup-api/hermes/models` answers "Unknown provider".
    expect(await refreshProviderToolsIfSetChanged(["openrouter", "clawlocal"], ["openrouter"])).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
    expect(String(logSpy.mock.calls[0][0])).toContain("lost clawlocal");
  });

  it("refuses to act on a snapshot it does not have", async () => {
    expect(await refreshProviderToolsIfSetChanged(null, ["a"])).toBe(false);
    expect(await refreshProviderToolsIfSetChanged(["a"], null)).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("does not ask twice when something already respawned the MCP children", async () => {
    expect(
      await refreshProviderToolsIfSetChanged(["a"], ["a", "b"], { alreadyReloaded: true }),
    ).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("does not claim success when the dashboard refused", async () => {
    rpcMock.mockResolvedValue(null);
    expect(await refreshProviderToolsIfSetChanged(["a"], ["a", "b"])).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not claim success when the dashboard only asked for confirmation", async () => {
    // The reply `reload.mcp` gives when `approvals.mcp_reload_confirm` wants a
    // human: a perfectly ordinary, non-error frame over a box whose tool list
    // never moved.
    rpcMock.mockResolvedValue({ status: "confirm_required" });
    expect(await refreshProviderToolsIfSetChanged(["a"], ["a", "b"])).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("never throws, whatever the RPC does", async () => {
    rpcMock.mockRejectedValue(new Error("socket exploded"));
    await expect(
      refreshProviderToolsIfSetChanged(["a"], ["a", "b"]),
    ).resolves.toBe(false);
  });
});
