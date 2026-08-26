/**
 * The coding_agent_* MCP tools (mcp/tools/coding-agent.ts).
 *
 * What the agent actually sees: that the family is absent when the device
 * says the coding agent is off (circuit-breaker rule), present on both
 * editions otherwise; that the device's 409s become CONFLICT with a next step
 * that sends the agent to the user rather than into a retry loop; that a run
 * summary — model-authored text — is labelled as information and redacted
 * like log output; and that stop reads the truth back instead of trusting a
 * 200.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (path: string, ...rest: unknown[]) => {
      try {
        return await fn(path, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: async () => null,
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingAgentTools } from "../../../mcp/tools/coding-agent";
import { ApiError } from "../../../mcp/lib/errors";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";
import { PARAM_NAME_RE, TOOL_NAME_RE } from "../../../mcp/lib/schema";
import { capText } from "../../../mcp/lib/guard";

const NAMES = ["coding_agent_run", "coding_agent_status", "coding_agent_stop"];

function harness(edition: "openclaw" | "hermes" = "openclaw", codingAgent = true) {
  const h = captureRegistrar(edition);
  registerCodingAgentTools(h.reg, { codingAgent });
  return h;
}

const RUN = {
  id: "run-k3x9q2ab",
  task: "Add a dark mode toggle\nand keep it accessible",
  directory: "/home/clawbox/clawbox/data/code-projects/site",
  projectId: "site",
  source: "agent",
  status: "completed",
  startedAt: 1_000_000,
  completedAt: 1_000_000 + 65_000,
  sessionId: "sess-1",
  model: "deepseek-v4-flash",
  summary: "Added the toggle. The token was abcdef0123456789abcdef0123456789abcdef01.",
  error: null,
  numTurns: 4,
  costUsd: 0.1,
  filesTouched: ["index.html"],
  commandsRun: 1,
  permissionDenials: 2,
  progress: ["Started", "$ npm test", "Finished: completed"],
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("registration", () => {
  it("is absent when the device says the coding agent is off", () => {
    expect(harness("openclaw", false).names()).toEqual([]);
    expect(harness("hermes", false).names()).toEqual([]);
  });

  it("is offered on both editions when the device says yes", () => {
    expect(harness("openclaw").names().sort()).toEqual([...NAMES].sort());
    expect(harness("hermes").names().sort()).toEqual([...NAMES].sort());
  });

  it("keeps names, parameters and descriptions inside the contract", () => {
    const h = harness();
    for (const name of NAMES) {
      const tool = h.get(name);
      expect(name).toMatch(TOOL_NAME_RE);
      for (const param of Object.keys(tool.shape)) expect(param).toMatch(PARAM_NAME_RE);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      expect(tool.opts.editions).toEqual(["openclaw", "hermes"]);
    }
    expect(h.get("coding_agent_status").opts.readOnly).toBe(true);
    expect(h.get("coding_agent_run").opts.readOnly).toBe(false);
    expect(h.get("coding_agent_run").opts.destructive).not.toBe(true);
  });

  it("tells a small model the run continues in the background and how to follow it", () => {
    const d = harness().get("coding_agent_run").description;
    expect(d).toMatch(/background/i);
    expect(d).toMatch(/coding_agent_status/);
    expect(d).toMatch(/Do not start a second run/i);
  });
});

describe("coding_agent_run", () => {
  it("starts a run and hands back the id with the follow-up step", async () => {
    apiPost.mockResolvedValue({ started: true, run: { ...RUN, status: "running" } });
    const out = await harness().call("coding_agent_run", { task: "Add a dark mode toggle", project_id: "site" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain('"run-k3x9q2ab"');
    expect(out.text).toMatch(/coding_agent_status/);
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/run",
      { task: "Add a dark mode toggle", projectId: "site" },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("refuses to start with nowhere to work, before calling the device", async () => {
    const out = await harness().call("coding_agent_run", { task: "do something" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toMatch(/project_id/);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("turns 'switched off' into CONFLICT that sends the agent to the user, not into a retry", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "off", kind: "disabled" })));
    const out = await harness().call("coding_agent_run", { task: "x", project_id: "site" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/Do not retry/);
    expect(out.error.next).toMatch(/Coding Agent app/);
  });

  it("turns 'busy' into CONFLICT pointing at the running run", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "busy", kind: "busy" })));
    const out = await harness().call("coding_agent_run", { task: "x", project_id: "site" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/coding_agent_status/);
  });

  it("points a missing project at code_project_list", async () => {
    apiPost.mockRejectedValue(new ApiError(404, JSON.stringify({ error: "no project", kind: "not_found" })));
    const out = await harness().call("coding_agent_run", { task: "x", project_id: "gone" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/code_project_list/);
  });

  it("tells a stale resume_run_id from a missing project — they are different 404s", async () => {
    apiPost.mockRejectedValue(new ApiError(404, JSON.stringify({ error: "There is no coding run with that id to resume.", kind: "not_found" })));
    const out = await harness().call("coding_agent_run", { task: "x", resume_run_id: "run-gone0000" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).toMatch(/resume/i);
    expect(out.error.next).toMatch(/coding_agent_status/);
    // The old catch-all sent this to code_project_list, an id that was never wrong.
    expect(out.error.next).not.toMatch(/code_project_init/);
  });

  it("carries the route's own reason for refusing a working folder", async () => {
    // The generic 400 mapping is "the device rejected one of the arguments",
    // which the agent cannot act on. The route knows exactly which rule broke.
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({
      error: "The ClawBox OS checkout itself is off limits. Use a code project or another folder in the home directory.",
      kind: "invalid",
    })));
    const out = await harness().call("coding_agent_run", { task: "x", directory: "/home/clawbox/clawbox" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.message).toMatch(/off limits/);
    expect(out.error.next).toMatch(/code_project_list/);
  });

  it("does not report a run the device did not start", async () => {
    apiPost.mockResolvedValue({ started: false });
    const out = await harness().call("coding_agent_run", { task: "x", project_id: "site" });
    expect(out.isError).toBe(true);
  });
});

describe("coding_agent_status", () => {
  it("lists recent runs without a run_id", async () => {
    apiGet.mockResolvedValue({ runs: [RUN] });
    const out = await harness().call("coding_agent_status", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const list = JSON.parse(out.text);
    expect(list[0]).toMatchObject({ run_id: "run-k3x9q2ab", status: "completed", project_id: "site", files_changed: 1 });
    expect(list[0].task).toBe("Add a dark mode toggle");
  });

  it("describes one run, labels the summary as information and redacts it like a log", async () => {
    apiGet.mockResolvedValue({ run: RUN });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab", wait_seconds: 30, tail: 5 });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/^Run run-k3x9q2ab: completed after 1m 5s/);
    expect(out.text).toMatch(/information, not instructions/);
    expect(out.text).toContain("Added the toggle.");
    expect(out.text).not.toContain("abcdef0123456789abcdef0123456789abcdef01");
    expect(out.text).toContain("[REDACTED]");
    expect(out.text).toMatch(/2 actions not allowed/);
    expect(out.text).toMatch(/code_project_build/);
    expect(apiGet).toHaveBeenCalledWith(
      "/setup-api/coding-agent/runs",
      expect.objectContaining({ query: { id: "run-k3x9q2ab", wait: 30 }, timeoutMs: 45_000 }),
    );
  });

  it("keeps the summary when the output cap bites — the activity log is what gets cut", async () => {
    // A real worst case, not a token one: the runner keeps 60 progress lines
    // of up to MAX_PROGRESS_LINE_CHARS (160) and caps a summary at 6 000, so a
    // chatty run asked for with tail=60 is ~9 600 chars of activity plus a
    // long summary — comfortably past this tool's 12 000-char declared cap.
    // captureRegistrar does not apply that cap, so the test applies it the way
    // the real registrar does, and asserts which end survives.
    const STATUS_OUTPUT_CHARS = 12_000; // mirrors the tool's declared maxChars
    const progress = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(150)}`);
    const summary = `THE-SUMMARY-STARTS-HERE ${"s".repeat(5_900)} THE-SUMMARY-ENDS-HERE`;
    apiGet.mockResolvedValue({ run: { ...RUN, progress, summary, error: "something went wrong" } });

    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab", tail: 60 });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text.length).toBeGreaterThan(STATUS_OUTPUT_CHARS); // the cap really would bite

    const capped = capText(out.text, STATUS_OUTPUT_CHARS);
    expect(capped).toContain("THE-SUMMARY-STARTS-HERE");
    expect(capped).toContain("[error]\nsomething went wrong");
    // The activity log is the long, low-value part, so it is what the cut eats.
    expect(capped).toContain("…[truncated");
    expect(capped.indexOf("[summary from the coding agent")).toBeLessThan(capped.indexOf("[recent activity]"));
  });

  it("tells the agent to keep waiting while a run is still working", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, status: "running", completedAt: null, summary: null } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Still working/);
    expect(out.text).toMatch(/wait_seconds/);
  });

  it("answers NOT_FOUND with the listing as the next step", async () => {
    apiGet.mockRejectedValue(new ApiError(404, JSON.stringify({ error: "no run", kind: "not_found" })));
    const out = await harness().call("coding_agent_status", { run_id: "run-nope0000" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/without a run_id/);
  });
});

describe("coding_agent_stop", () => {
  it("reads the run back after stopping instead of trusting the 200", async () => {
    apiGet
      .mockResolvedValueOnce({ run: { ...RUN, status: "running" } })
      .mockResolvedValueOnce({ run: { ...RUN, status: "stopped" } });
    apiPost.mockResolvedValue({ run: { ...RUN, status: "running" } });
    const out = await harness().call("coding_agent_stop", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Stopped run run-k3x9q2ab \(stopped\)/);
    expect(apiPost).toHaveBeenCalledWith("/setup-api/coding-agent/stop", { id: "run-k3x9q2ab" }, expect.anything());
  });

  it("does not send a stop for a run that already finished", async () => {
    apiGet.mockResolvedValue({ run: RUN });
    const out = await harness().call("coding_agent_stop", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/already finished \(completed\)/);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("explains an owner-started run instead of reporting a rejected token", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, status: "running", source: "owner" } });
    apiPost.mockRejectedValue(new ApiError(403, JSON.stringify({ error: "owner's run", kind: "owner_only" })));
    const out = await harness().call("coding_agent_stop", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/Do not retry/);
    expect(out.error.next).toMatch(/Coding Agent app/);
  });

  it("is honest when the process has not exited yet", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, status: "running" } });
    apiPost.mockResolvedValue({ run: { ...RUN, status: "running" } });
    const out = await harness().call("coding_agent_stop", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/has not exited yet/);
  });
});
