/**
 * TASK-549 — the coding family's edition gate says what it means.
 *
 * `mcp/tools/coding.ts` computed its edition list into a local called `both`,
 * and twelve registrations then read `{ editions: both }` — so the code said
 * "both editions" at every site while the value is OpenClaw-only on every
 * shipped device. The rename is cosmetic; what was NOT pinned anywhere in the
 * unit suite is the behaviour behind it, which is why a rename could have
 * changed it silently.
 *
 * `mcp/check-tools.ts` does cover it — `OPENCLAW_ONLY` there lists all twelve
 * and asserts both directions — but no CI workflow runs `check:mcp-tools`
 * (TASK-708) and the checker needs a real device to probe. The twelve names
 * below are therefore a deliberate second copy: keep them in step with
 * `mcp/check-tools.ts` when a coding tool is added.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveEnv } from "../helpers/env";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingTools } from "../../../mcp/tools/coding";

const CODING_TOOLS = [
  "bash",
  "job_status",
  "job_stop",
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "glob",
  "grep",
  "notebook_edit",
  "web_fetch",
  "web_search",
];

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

describe("the coding family is OpenClaw-only", () => {
  // The `full` profile throughout: none of the twelve declares a profile, so
  // `CLAWBOX_MCP_PROFILE=core` drops them on OpenClaw too. captureRegistrar
  // models the edition axis only, which is the axis this card is about.
  it("registers every tool on OpenClaw", () => {
    expect(namesOn("openclaw").sort()).toEqual([...CODING_TOOLS].sort());
  });

  it("registers none of them on Hermes", () => {
    expect(namesOn("hermes")).toEqual([]);
  });

  it("widens to Hermes only under the debugging override", () => {
    process.env.CLAWBOX_MCP_CODING_TOOLS = "1";
    expect(namesOn("hermes").sort()).toEqual([...CODING_TOOLS].sort());
  });

  it("treats any other value of the override as off", () => {
    for (const value of ["", "0", "true", "yes"]) {
      process.env.CLAWBOX_MCP_CODING_TOOLS = value;
      expect(namesOn("hermes"), `CLAWBOX_MCP_CODING_TOOLS=${JSON.stringify(value)}`).toEqual([]);
    }
  });
});
