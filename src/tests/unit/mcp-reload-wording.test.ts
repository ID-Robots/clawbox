import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the journal is allowed to say when an MCP reload was asked for.
 *
 * Five families ask for the same reload through the same helper, and each one
 * writes its own line about it. Two of them said "asked the agent to reload its
 * MCP servers" while the mechanism is HERMES' dashboard JSON-RPC and nothing
 * else: on the dual SKU that is the harness that answers even after the box has
 * moved to OpenClaw, so "the agent" — read as "whichever harness now serves the
 * owner" — names the wrong process, and an operator reading the journal for
 * "the agent still thinks it is on Hermes" is told the OpenClaw child was
 * reloaded when it was never asked. `harness/select` already says Hermes, with
 * a comment explaining exactly that; this pins it for the closed set.
 *
 * The SET is pinned too, not just the wording: a sixth family added without a
 * line here is the way one of these drifts back.
 */

const reloadMock = vi.hoisted(() => vi.fn());
const refusedMock = vi.hoisted(() => vi.fn(async () => {}));
const harnessMock = vi.hoisted(() => vi.fn(async () => "hermes"));

vi.mock("@/lib/harness", () => ({ getActiveHarness: harnessMock }));
vi.mock("@/lib/hermes-mcp-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-mcp-reload")>()),
  reloadMcpServers: reloadMock,
  reportMcpReloadRefused: refusedMock,
}));

import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { refreshEmailToolsIfReadabilityChanged } from "@/lib/email-mcp-refresh";
import { refreshHarnessToolsIfSwitched } from "@/lib/harness-mcp-refresh";
import { refreshProviderToolsIfSetChanged } from "@/lib/provider-mcp-refresh";

/**
 * The words, spelled here rather than imported: this file is what decides them,
 * and a test that read the constant the code writes would pass whatever it said.
 */
const ASKED = "asked Hermes to reload its MCP servers";
const ALREADY = "the MCP servers were already reloaded for this change";
const REFUSED = "but Hermes would not reload its MCP servers";

/** Every family that asks for a reload and writes its own line about it. */
const FAMILIES = [
  {
    tag: "harness/select",
    ask: () => refreshHarnessToolsIfSwitched("openclaw", "hermes"),
    askAlreadyReloaded: null,
  },
  {
    tag: "email/mcp-refresh",
    ask: () => refreshEmailToolsIfReadabilityChanged(false, true),
    askAlreadyReloaded: null,
  },
  {
    tag: "hermes/provider-refresh",
    ask: () => refreshProviderToolsIfSetChanged([], ["anthropic"]),
    askAlreadyReloaded: () => refreshProviderToolsIfSetChanged([], ["anthropic"], { alreadyReloaded: true }),
  },
  {
    tag: "coding-agent/mcp-refresh",
    ask: () => refreshCodingAgentToolsIfReadinessChanged(false, true),
    askAlreadyReloaded: () => refreshCodingAgentToolsIfReadinessChanged(false, true, { alreadyReloaded: true }),
  },
] as const;

const logged: string[] = [];

beforeEach(() => {
  reloadMock.mockReset();
  reloadMock.mockResolvedValue(true);
  refusedMock.mockClear();
  harnessMock.mockResolvedValue("hermes");
  logged.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(String(args[0]));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lineFor(tag: string): string {
  const line = logged.find((entry) => entry.startsWith(`[${tag}]`));
  expect(line, `${tag} wrote no line`).toBeDefined();
  return line as string;
}

describe("every family names the mechanism it actually used", () => {
  for (const family of FAMILIES) {
    it(`${family.tag}: says Hermes was asked, not "the agent"`, async () => {
      await family.ask();
      const line = lineFor(family.tag);
      expect(line).toContain(ASKED);
      // The wrong sentence, spelled out rather than left to the constant: the
      // point of the case is that these two must not be the same words.
      expect(line).not.toContain("asked the agent to reload");
    });

    if (family.askAlreadyReloaded) {
      it(`${family.tag}: says the same thing when another family already paid`, async () => {
        await family.askAlreadyReloaded();
        expect(lineFor(family.tag)).toContain(ALREADY);
        expect(reloadMock).not.toHaveBeenCalled();
      });
    }
  }

  it("the refusal names the same mechanism the success line does", async () => {
    // The other half of the one flow: what was ASKED is Hermes' dashboard,
    // whatever this box calls its agent, so the line an operator is meant to
    // act on says so too.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    const { reportMcpReloadRefused } = await vi.importActual<typeof import("@/lib/hermes-mcp-reload")>(
      "@/lib/hermes-mcp-reload",
    );
    await reportMcpReloadRefused("harness/select", "the active harness moved");
    expect(errors.at(-1)).toContain(REFUSED);
  });
});
