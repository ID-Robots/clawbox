/**
 * TASK-549 / TASK-1079 — the coding family's gates say what they mean.
 *
 * TASK-549: `mcp/tools/coding.ts` computed its edition list into a local called
 * `both`, and twelve registrations then read `{ editions: both }` — so the code
 * said "both editions" at every site while the value was OpenClaw-only on every
 * shipped device. The rename was cosmetic; what was NOT pinned anywhere in the
 * unit suite was the behaviour behind it, which is why a rename could have
 * changed it silently.
 *
 * TASK-1079 split that one gate in two. Nine shell/file/web tools now register
 * on NO edition unless `CLAWBOX_MCP_CODING_TOOLS=1` is set — they were ≈ 12.5 KB
 * of a 43.9 KB tools/list and the model chose the OpenClaw harness's own
 * exec/read/edit/web_fetch in six of six prompts — while the guarded read-only
 * trio keeps exactly the old rule, because its descendant filtering is the one
 * thing no harness's own search does. Nothing was deleted: registration is the
 * only lever, so the gate is the whole of what there is to pin.
 *
 * `mcp/check-tools.ts` does cover this — it builds the override posture and
 * asserts both gates as equalities — but no CI workflow runs `check:mcp-tools`
 * (TASK-708) and the checker needs a real device to probe. The names below are
 * therefore a deliberate second copy: keep them in step with
 * `CODING_GATED` / `CODING_ALWAYS_OPENCLAW` in `mcp/check-tools.ts` when a
 * coding tool is added.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveEnv } from "../helpers/env";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingTools } from "../../../mcp/tools/coding";

/** Behind `CLAWBOX_MCP_CODING_TOOLS=1` on every edition. */
const GATED_TOOLS = [
  "bash",
  "job_status",
  "job_stop",
  "read_file",
  "write_file",
  "edit_file",
  "notebook_edit",
  "web_fetch",
  "web_search",
];

/** The guarded read-only trio: OpenClaw always, Hermes under the override. */
const ALWAYS_ON_OPENCLAW = ["list_directory", "glob", "grep"];

const ALL_CODING_TOOLS = [...GATED_TOOLS, ...ALWAYS_ON_OPENCLAW];

function namesOn(edition: "openclaw" | "hermes"): string[] {
  const h = captureRegistrar(edition);
  registerCodingTools(h.reg);
  return h.names();
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_MCP_CODING_TOOLS");
  delete process.env.CLAWBOX_MCP_CODING_TOOLS;
});

afterEach(() => restoreEnv());

describe("by default only the guarded read-only trio registers, and only on OpenClaw", () => {
  // The `full` profile throughout: none of the twelve declares a profile, so
  // `CLAWBOX_MCP_PROFILE=core` drops them on OpenClaw too. captureRegistrar
  // models the edition axis only, which is the axis this card is about.
  it("gives OpenClaw list_directory, glob and grep — and nothing else from this file", () => {
    expect(namesOn("openclaw").sort()).toEqual([...ALWAYS_ON_OPENCLAW].sort());
  });

  it("registers none of them on Hermes", () => {
    expect(namesOn("hermes")).toEqual([]);
  });

  it("registers the shell, file and web tools on no edition at all", () => {
    // The point of the card: `editions: []`, not "OpenClaw minus something".
    // A box of either edition offers none of these nine until an owner asks.
    for (const edition of ["openclaw", "hermes"] as const) {
      const offered = namesOn(edition);
      const leaked = GATED_TOOLS.filter((t) => offered.includes(t));
      expect(leaked, `edition=${edition}`).toEqual([]);
    }
  });
});

describe("CLAWBOX_MCP_CODING_TOOLS=1 puts the whole family back, on both editions", () => {
  it("registers all twelve on OpenClaw", () => {
    process.env.CLAWBOX_MCP_CODING_TOOLS = "1";
    expect(namesOn("openclaw").sort()).toEqual([...ALL_CODING_TOOLS].sort());
  });

  it("registers all twelve on Hermes — the debugging override it always was", () => {
    process.env.CLAWBOX_MCP_CODING_TOOLS = "1";
    expect(namesOn("hermes").sort()).toEqual([...ALL_CODING_TOOLS].sort());
  });

  it("only ever widens: nothing OpenClaw had without it goes away", () => {
    const before = namesOn("openclaw");
    process.env.CLAWBOX_MCP_CODING_TOOLS = "1";
    const after = namesOn("openclaw");
    expect(before.filter((n) => !after.includes(n))).toEqual([]);
  });

  it("treats any other value of the override as off", () => {
    for (const value of ["", "0", "true", "yes"]) {
      process.env.CLAWBOX_MCP_CODING_TOOLS = value;
      const why = `CLAWBOX_MCP_CODING_TOOLS=${JSON.stringify(value)}`;
      expect(namesOn("hermes"), why).toEqual([]);
      expect(namesOn("openclaw").sort(), why).toEqual([...ALWAYS_ON_OPENCLAW].sort());
    }
  });
});
