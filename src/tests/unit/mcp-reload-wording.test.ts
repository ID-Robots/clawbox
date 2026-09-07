import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

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

// Spread the original, like every other mock of this module: a family that
// starts importing a second value from it must not fail to import in a test.
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: harnessMock,
}));
vi.mock("@/lib/hermes-mcp-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-mcp-reload")>()),
  reloadMcpServers: reloadMock,
  reportMcpReloadRefused: refusedMock,
}));

import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { refreshEmailToolsIfReadabilityChanged } from "@/lib/email-mcp-refresh";
import { refreshHermesImageTools } from "@/lib/hermes-image-refresh";
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
  {
    // The fifth: `refreshHermesImageTools(true, false)` is its reload path — a
    // box that could draw and now cannot, where the only stale thing is the
    // MCP server's view. Its dashboard BOUNCE line is a different event and is
    // deliberately not this sentence.
    tag: "hermes/image-refresh",
    ask: () => refreshHermesImageTools(true, false),
    askAlreadyReloaded: null,
  },
] as const;

/** Where the modules live, for the case that derives the set from the source. */
const LIB_DIR = path.join(process.cwd(), "src", "lib");

const logged: string[] = [];
const errors: string[] = [];
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_EDITION");
  // Every family case is a box whose dashboard answers; the refusal cases below
  // set their own edition.
  process.env.CLAWBOX_EDITION = "hermes";
  errors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
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
  restoreEnv();
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
      // And it really ASKED: a family refactored to write the sentence without
      // calling the transport would otherwise pass this file — the exact false
      // success `hermes-mcp-reload-verdict.test.ts` exists for.
      expect(reloadMock).toHaveBeenCalledTimes(1);
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
    process.env.CLAWBOX_EDITION = "hermes";
    const { reportMcpReloadRefused } = await vi.importActual<typeof import("@/lib/hermes-mcp-reload")>(
      "@/lib/hermes-mcp-reload",
    );
    await reportMcpReloadRefused("harness/select", "the active harness moved");
    expect(errors.at(-1)).toContain(REFUSED);
  });

  it("reports a DUAL box's refusal as an error, not as 'this edition has no dashboard'", async () => {
    // The dashboard runs on hermes AND dual (install.sh enables the unit for
    // both), whichever harness is active — so on a licensed dual box sitting on
    // OpenClaw, a dashboard that answered `confirm_required` is a real refusal.
    // Gating on the ACTIVE HARNESS wrote the benign "no dashboard to ask" note
    // over it: a false success, on the line that exists to report one.
    process.env.CLAWBOX_EDITION = "dual";
    harnessMock.mockResolvedValue("openclaw");
    const { reportMcpReloadRefused } = await vi.importActual<typeof import("@/lib/hermes-mcp-reload")>(
      "@/lib/hermes-mcp-reload",
    );
    await reportMcpReloadRefused("email/mcp-refresh", "mailbox readability changed to true");
    expect(errors.at(-1)).toContain(REFUSED);
    expect(logged.some((line) => line.includes("no dashboard to ask"))).toBe(false);
  });

  it("stays a plain note on a box that has no dashboard by design", async () => {
    // The other side, and the one this branch exists for: an OpenClaw box has
    // no dashboard, its MCP server is spawned per session and reaped when idle,
    // so the tool list catches up on its own. An error line there is the
    // false-alarm shape that teaches an operator to skip these lines.
    process.env.CLAWBOX_EDITION = "openclaw";
    const { reportMcpReloadRefused } = await vi.importActual<typeof import("@/lib/hermes-mcp-reload")>(
      "@/lib/hermes-mcp-reload",
    );
    await reportMcpReloadRefused("email/mcp-refresh", "mailbox readability changed to true");
    expect(errors).toHaveLength(0);
    expect(logged.at(-1)).toContain("no dashboard to ask");
  });

  it("keeps the error when nothing on the device named an edition", async () => {
    // Unknown is not OpenClaw: a default is not an answer, and must not be the
    // thing that quiets a real Hermes failure.
    delete process.env.CLAWBOX_EDITION;
    const { reportMcpReloadRefused } = await vi.importActual<typeof import("@/lib/hermes-mcp-reload")>(
      "@/lib/hermes-mcp-reload",
    );
    await reportMcpReloadRefused("email/mcp-refresh", "mailbox readability changed to true");
    expect(errors.at(-1)).toContain(REFUSED);
  });

  it("is driven for EVERY module that asks for a reload", () => {
    // The set, derived rather than hand-kept: a sixth family added without a
    // line above is exactly how one of these drifts back, and a list written by
    // hand cannot notice it. Every module that imports `reloadMcpServers` must
    // also import the shared sentence and be driven by a case here.
    const asking = fs
      .readdirSync(LIB_DIR)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => {
        const source = fs.readFileSync(path.join(LIB_DIR, name), "utf-8");
        return source.includes('from "@/lib/hermes-mcp-reload"') && source.includes("reloadMcpServers");
      })
      .map((name) => name.replace(/\.ts$/, ""));

    expect(asking.length).toBeGreaterThan(0);
    for (const name of asking) {
      const source = fs.readFileSync(path.join(LIB_DIR, `${name}.ts`), "utf-8");
      expect(source, `${name} must use the shared sentence`).toContain("MCP_RELOAD_ASKED");
    }
    expect([...asking].sort()).toEqual(
      [
        "coding-agent-mcp-refresh",
        "email-mcp-refresh",
        "harness-mcp-refresh",
        "hermes-image-refresh",
        "provider-mcp-refresh",
      ].sort(),
    );
    expect(FAMILIES.length).toBe(asking.length);
  });
});
